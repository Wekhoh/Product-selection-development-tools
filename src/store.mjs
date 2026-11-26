/**
 * Phase 2 SQLite persistence store (Core 5 business objects + lead_form_links + queue_state).
 * Uses Node built-in node:sqlite (DatabaseSync) in WAL mode with short atomic transactions.
 *
 * Core 5 business objects:
 *  1. api_request_ledger   (logical request key + physical attempt lifecycle + 4-way quota + permanent locks)
 *  2. raw_leads            (+ lead_form_links many-to-many discovery vs corroboration links)
 *  3. candidate_forms      (stable form_id + versioned specification + Gate 1A/1B results & negotiation shortlist)
 *  4. sourcing_quotes_1688 (PII-redacted 1688 SKU lines, persisted order_plan_json, Shenzhen & readback proof)
 *  5. evaluations          (immutable per (form_id, period_id, profile_revision, evidence_bundle_sha256))
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { validEvidenceDate } from './observations.mjs';
import {
  ALLOWED_DISPOSITIONS,
  assertNoRawPii,
  containsSecretToken,
  sanitizeDiagnosticText,
  validateRedactedDestination,
  validateSocialBridgeOutput,
  validateSpecMatcherOutput,
  validateSourcingVerifier1688Output,
} from './contracts.mjs';
import {
  DISCOVERY_ROUTES,
  OPPORTUNITY_TYPES,
  PROMOTION_TRACKS,
  resolveChannelMeta,
} from './discovery-channels.mjs';
import { canonicalizeConnectorToolName, validateProviderCall } from './provider-guards.mjs';
import {
  bindSourcingQuotePricingInputs,
  evaluateSingleFactoryCompleteKit,
  INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH,
  resolveVerifiedFactoryKey,
} from './fba-calculator.mjs';
import { BUSINESS_THRESHOLDS } from './business-thresholds.mjs';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const ACCOUNT_SCOPE_ALLOWLIST_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
const TOKEN_PREFIX_RE = /^(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[bpas]-|AIza|AKIA|ASIA|eyJ|pk_live_|rk_live_)/i;
const SECRET_LIKE_RE = /(?:bearer\s+\S+|api[_-]?key\s*=|authorization\s*:|cookie\s*=|password\s*=|token\s*=\s*\S+)/i;

const LIFECYCLE_STATUSES = Object.freeze([
  'discovered',
  'gate1a_passed',
  'gate1a_rejected',
  'gate1a_needs_verification',
  'gate1b_queued',
  'gate1b_passed',
  'gate1b_rejected',
  'gate1b_pending',
  'private_mold_reserved',
  'gate2_3_in_progress',
  'evaluated',
  'deferred',
  'excluded',
]);

const PROVIDERS = Object.freeze(['sellersprite', 'sif', 'exa', 'sp_api', '1688_browser', 'other']);
const REQUEST_MODES = Object.freeze(['historical_replay', 'fresh_observation']);

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;

export function canonicalJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256Hex(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function assertIsoDateOnly(value, label) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value) || !validEvidenceDate(value)) {
    throw new TypeError(`${label} must be a valid calendar date (YYYY-MM-DD).`);
  }
  return value;
}

function assertAccountScope(scope) {
  if (!nonemptyStr(scope)) throw new TypeError('account_scope must be a nonempty non-sensitive scope label.');
  const trimmed = scope.trim();
  if (!ACCOUNT_SCOPE_ALLOWLIST_RE.test(trimmed) || TOKEN_PREFIX_RE.test(trimmed) || SECRET_LIKE_RE.test(trimmed)) {
    throw new TypeError('account_scope must be a short non-sensitive scope identifier, never a credential or token.');
  }
  if (trimmed.length >= 24 && /[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed) && /\d/.test(trimmed) && !trimmed.includes('-')) {
    throw new TypeError('account_scope appears to contain a raw token; use a non-sensitive scope label.');
  }
  assertNoRawPii(trimmed, 'account_scope');
  return trimmed;
}

export function normalizeProvider(provider, toolName = '') {
  const raw = String(provider || '').trim().toLowerCase();
  if (raw === 'sp-api' || raw === 'amazon_sp_api') return 'sp_api';
  if (PROVIDERS.includes(raw)) return raw;
  const tool = String(toolName || '').trim().toLowerCase();
  if (tool.includes('sp_api') || tool.includes('sp-api') || tool.startsWith('catalogitems_') ||
    tool.startsWith('productfees_') || tool.startsWith('listingsrestrictions_') ||
    tool.startsWith('listingsitems_') || tool.startsWith('definitionsproducttypes_') ||
    tool === 'getdefinitionsproducttype' || tool === 'putlistingsitem') {
    return 'sp_api';
  }
  if (tool.includes('sellersprite') || tool.startsWith('asin_') || tool.startsWith('category_') || tool.startsWith('keyword_') || tool.startsWith('keepa_') || tool.startsWith('bsr_') || tool.startsWith('ads_insights') || tool === 'product_research' || tool === 'keyword_research') {
    return 'sellersprite';
  }
  if (tool.includes('sif') || tool.startsWith('ops_') || tool.startsWith('market_') || tool.startsWith('ads_get_') || tool === 'query_quota' || tool === 'sif_catalog') {
    return 'sif';
  }
  if (tool.includes('exa') || tool.startsWith('web_search') || tool.startsWith('web_fetch')) {
    return 'exa';
  }
  if (tool.includes('1688')) return '1688_browser';
  return 'other';
}

export function normalizeCanonicalTool(toolName) {
  if (!nonemptyStr(toolName)) throw new TypeError('tool_name must be a nonempty string.');
  return canonicalizeConnectorToolName(toolName);
}

function normalizeStringToken(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function deepNormalizeParams(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return normalizeStringToken(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(deepNormalizeParams);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = deepNormalizeParams(value[key]);
    }
    return out;
  }
  return String(value);
}

/**
 * Normalize parameters and provider defaults so equivalent calls (e.g. omitting default
 * country="US", pageNum=1, pageSize=100, isListingSearch=true) map to the exact same key.
 */
function canonicalizeToolParams(normProvider, canonicalTool, params, { defaultMarketplace = 'US', stripNonSemantic = false } = {}) {
  const raw = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const unwrapped = raw.request && typeof raw.request === 'object' && !Array.isArray(raw.request) ? raw.request : raw;

  const NON_SEMANTIC_KEYS = new Set([
    'pagesize', 'size', 'limit', 'includefields', 'returnfields', 'requestid', 'request_id',
    'account_scope', 'account', 'trace_id', 'client_id',
  ]);

  const core = {};
  for (const [k, v] of Object.entries(unwrapped)) {
    if (v === undefined || v === null) continue;
    const kl = k.toLowerCase();
    if (stripNonSemantic && NON_SEMANTIC_KEYS.has(kl)) continue;
    if (kl === 'asin' && typeof v === 'string') {
      core.asin = v.trim().toUpperCase();
    } else if (kl === 'asins' && Array.isArray(v)) {
      core.asins = [...new Set(v.map(item => String(item).trim().toUpperCase()))].sort();
    } else if ((kl === 'country' || kl === 'marketplace') && typeof v === 'string') {
      core.marketplace = v.trim().toUpperCase();
    } else if (kl === 'pagenum' || kl === 'page') {
      if (typeof v === 'object' && v !== null) {
        const normPage = {};
        if (v.cursor !== undefined) normPage.cursor = String(v.cursor);
        if (!stripNonSemantic && v.size !== undefined) normPage.size = Number(v.size);
        core.page = normPage;
      } else {
        core.page_num = Number(v);
      }
    } else if (kl === 'pagesize') {
      core.page_size = Number(v);
    } else if (kl === 'islistingsearch' || kl === 'listingsearch') {
      core.listing_search = Boolean(v);
    } else if (kl === 'timepiecevalue' || kl === 'lastdays') {
      core.window_value = String(v).trim();
    } else if (kl === 'timepiecetype') {
      core.window_type = String(v).trim().toLowerCase();
    } else if (kl === 'showtype') {
      core.show_type = Number(v);
    } else if (kl === 'dimension') {
      core.dimension = String(v).trim().toLowerCase();
    } else if (kl === 'nodeidpath' || kl === 'nodeidpaths' || kl === 'categoryid') {
      const paths = Array.isArray(v) ? v.map(p => String(p).trim()) : [String(v).trim()];
      core.node_paths = [...new Set(paths)].sort();
    } else {
      core[kl] = deepNormalizeParams(v);
    }
  }

  if (core.marketplace === undefined && (normProvider === 'sif' || normProvider === 'sellersprite' || normProvider === 'sp_api')) {
    core.marketplace = String(defaultMarketplace || 'US').trim().toUpperCase();
  }

  if (normProvider === 'sif') {
    if (canonicalTool === 'ops_get_listing_keyword_distribution') {
      if (core.window_type === undefined) core.window_type = 'latelyday';
      if (core.window_value === undefined) core.window_value = '7';
      if (core.page_num === undefined) core.page_num = 1;
      if (!stripNonSemantic && core.page_size === undefined) core.page_size = 100;
      if (core.dimension === undefined) core.dimension = 'asin';
      if (core.show_type === undefined) core.show_type = 1;
    } else if (canonicalTool === 'ops_get_listing_traffic_overview') {
      if (core.window_type === undefined) core.window_type = 'latelyday';
      if (core.window_value === undefined) core.window_value = '7';
      if (core.listing_search === undefined) core.listing_search = true;
    } else if (canonicalTool === 'ops_get_listing_traffic_structure') {
      if (core.window_type === undefined) core.window_type = 'latelyday';
      if (core.window_value === undefined) core.window_value = '7';
      if (core.dimension === undefined) core.dimension = 'asin';
      if (core.page_num === undefined) core.page_num = 1;
      if (!stripNonSemantic && core.page_size === undefined) core.page_size = 20;
    } else if (canonicalTool.startsWith('ops_') || canonicalTool.startsWith('market_') || canonicalTool.startsWith('ads_')) {
      if (core.page_num === undefined) core.page_num = 1;
    }
  }

  return core;
}

export function computeSemanticLockKey({ provider, tool_name, marketplace = 'US', params = {} }) {
  const normProvider = normalizeProvider(provider, tool_name);
  const canonicalTool = normalizeCanonicalTool(tool_name);
  const core = canonicalizeToolParams(normProvider, canonicalTool, params, {
    defaultMarketplace: marketplace,
    stripNonSemantic: true,
  });
  return sha256Hex(canonicalJson({ provider: normProvider, canonical_tool: canonicalTool, core }));
}

export function computeLogicalRequestKey({
  account_scope,
  provider,
  tool_name,
  tool_version = 'v1',
  marketplace = 'US',
  mode = 'fresh_observation',
  observation_cutoff_date,
  page_or_cursor = '',
  params = {},
}) {
  const scope = assertAccountScope(account_scope);
  const normProvider = normalizeProvider(provider, tool_name);
  const canonicalTool = normalizeCanonicalTool(tool_name);
  const cutoff = assertIsoDateOnly(observation_cutoff_date, 'observation_cutoff_date');
  if (!REQUEST_MODES.includes(mode)) throw new TypeError(`mode must be one of ${REQUEST_MODES.join(', ')}.`);
  const normMarket = String(marketplace || 'US').trim().toUpperCase();
  const normalizedParams = canonicalizeToolParams(normProvider, canonicalTool, params ?? {}, {
    defaultMarketplace: normMarket,
    stripNonSemantic: false,
  });
  const normPageCursor = String(page_or_cursor ?? '').trim() || (
    normalizedParams.page_num !== undefined ? `page:${normalizedParams.page_num}` : ''
  );

  return {
    logical_request_key: sha256Hex(canonicalJson({
      account_scope: scope,
      provider: normProvider,
      canonical_tool: canonicalTool,
      tool_version: String(tool_version || 'v1').trim(),
      marketplace: normMarket,
      mode,
      observation_cutoff_date: cutoff,
      page_or_cursor: normPageCursor,
      normalized_params: normalizedParams,
    })),
    semantic_lock_key: computeSemanticLockKey({
      provider: normProvider,
      tool_name,
      marketplace: normMarket,
      params: params ?? {},
    }),
    account_scope: scope,
    provider: normProvider,
    canonical_tool: canonicalTool,
    normalized_params_json: canonicalJson(normalizedParams),
    observation_cutoff_date: cutoff,
    marketplace: normMarket,
    tool_version: String(tool_version || 'v1').trim(),
    page_or_cursor: normPageCursor,
  };
}

export function computeEvidenceBundleHash({
  form_spec_sha256,
  candidate_input,
  discovery_manifest = null,
  profile_snapshot,
  fee_table_snapshot = null,
}) {
  if (!nonemptyStr(form_spec_sha256)) throw new TypeError('form_spec_sha256 is required for evidence_bundle_sha256.');
  if (!profile_snapshot || typeof profile_snapshot !== 'object') {
    throw new TypeError('profile_snapshot is required for evidence_bundle_sha256.');
  }
  return sha256Hex(canonicalJson({
    form_spec_sha256,
    candidate_input: candidate_input ?? null,
    discovery_manifest: discovery_manifest ?? null,
    profile_snapshot,
    fee_table_snapshot: fee_table_snapshot ?? null,
  }));
}

export function canonicalizeSourceRef(sourceRef) {
  const trimmed = sourceRef.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) {
        if (/^(?:utm_|fbclid|gclid|ref|si|feature)/i.test(k)) u.searchParams.delete(k);
      }
      u.searchParams.sort();
      const pathname = u.pathname.replace(/\/+$/, '') || '/';
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${pathname}${u.search}`;
    } catch {
      return trimmed.toLowerCase();
    }
  }
  return trimmed.replace(/\\/g, '/').toLowerCase();
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_request_ledger (
  attempt_id TEXT PRIMARY KEY,
  logical_request_key TEXT NOT NULL,
  semantic_lock_key TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('sellersprite', 'sif', 'exa', 'sp_api', '1688_browser', 'other')),
  tool_name TEXT NOT NULL,
  canonical_tool TEXT NOT NULL,
  tool_version TEXT NOT NULL DEFAULT 'v1',
  marketplace TEXT NOT NULL DEFAULT 'US',
  mode TEXT NOT NULL CHECK(mode IN ('historical_replay', 'fresh_observation')),
  observation_cutoff_date TEXT NOT NULL,
  page_or_cursor TEXT NOT NULL DEFAULT '',
  normalized_params_json TEXT NOT NULL,
  form_id TEXT,
  stage TEXT NOT NULL DEFAULT 'general' CHECK(stage IN ('discovery', 'gate1a', 'gate1b', 'gate2_3', 'replay', 'general')),
  status TEXT NOT NULL CHECK(status IN ('reserved', 'in_flight', 'completed', 'failed', 'unknown_needs_reconciliation', 'permanently_locked')),
  repeat_submission_allowed INTEGER NOT NULL DEFAULT 1 CHECK(repeat_submission_allowed IN (0, 1)),
  billing_status TEXT NOT NULL DEFAULT 'known' CHECK(billing_status IN ('known', 'unknown_not_exposed')),
  ss_mcp_units REAL NOT NULL DEFAULT 0 CHECK(ss_mcp_units >= 0),
  ss_web_realtime_tasks REAL NOT NULL DEFAULT 0 CHECK(ss_web_realtime_tasks >= 0),
  sif_units REAL NOT NULL DEFAULT 0 CHECK(sif_units >= 0),
  exa_calls REAL NOT NULL DEFAULT 0 CHECK(exa_calls >= 0),
  estimated_ss_mcp_units REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_mcp_units >= 0),
  estimated_ss_web_realtime_tasks REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_web_realtime_tasks >= 0),
  estimated_sif_units REAL NOT NULL DEFAULT 0 CHECK(estimated_sif_units >= 0),
  estimated_exa_calls REAL NOT NULL DEFAULT 0 CHECK(estimated_exa_calls >= 0),
  unknown_reserved_ss_mcp_units REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_mcp_units >= 0),
  unknown_reserved_ss_web_realtime_tasks REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_web_realtime_tasks >= 0),
  unknown_reserved_sif_units REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_sif_units >= 0),
  unknown_reserved_exa_calls REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_exa_calls >= 0),
  payload_sha256 TEXT,
  response_payload_json TEXT,
  raw_artifact_path TEXT,
  pagination_complete INTEGER CHECK(pagination_complete IN (0, 1)),
  source_ledger_ref TEXT,
  reconciliation_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ledger_logical_key ON api_request_ledger(logical_request_key);
CREATE INDEX IF NOT EXISTS idx_ledger_semantic_lock ON api_request_ledger(semantic_lock_key, status);
CREATE INDEX IF NOT EXISTS idx_ledger_form_stage ON api_request_ledger(form_id, stage);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON api_request_ledger(status);

CREATE TABLE IF NOT EXISTS raw_leads (
  lead_id TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL,
  event_dedup_key TEXT NOT NULL,
  source_ref_hash TEXT NOT NULL,
  source_channel TEXT NOT NULL,
  route TEXT,
  entry_group TEXT NOT NULL DEFAULT 'in_site',
  opportunity_type TEXT NOT NULL DEFAULT 'unclassified',
  promotion_track TEXT,
  source_ref TEXT NOT NULL,
  phrase_or_title TEXT NOT NULL,
  raw_excerpt TEXT,
  observed_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  evidence_sha256 TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('product', 'context', 'brand_specific', 'promotion_only', 'delivery_only', 'seasonal_deferred', 'needs_context', 'unreviewed')),
  disposition_reason TEXT,
  source_attempt_id TEXT REFERENCES api_request_ledger(attempt_id),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_dedup ON raw_leads(event_dedup_key);
CREATE INDEX IF NOT EXISTS idx_leads_ref_hash ON raw_leads(source_ref_hash);
CREATE INDEX IF NOT EXISTS idx_leads_channel ON raw_leads(source_channel);

CREATE TABLE IF NOT EXISTS candidate_forms (
  form_id TEXT PRIMARY KEY,
  product_family_key TEXT NOT NULL,
  spec_version INTEGER NOT NULL DEFAULT 1 CHECK(spec_version >= 1),
  spec_sha256 TEXT NOT NULL,
  label TEXT NOT NULL,
  buyer_task TEXT NOT NULL,
  saleable_set_composition_json TEXT NOT NULL,
  grade_or_material TEXT,
  target_child_asin TEXT,
  leaf_node_path TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'discovered' CHECK(lifecycle_status IN (
    'discovered', 'gate1a_passed', 'gate1a_rejected', 'gate1a_needs_verification',
    'gate1b_queued', 'gate1b_passed', 'gate1b_rejected', 'gate1b_pending', 'private_mold_reserved',
    'gate2_3_in_progress', 'evaluated', 'deferred', 'excluded'
  )),
  sourcing_disposition TEXT,
  gate1a_result_json TEXT,
  gate1b_result_json TEXT,
  negotiation_shortlist_json TEXT,
  packaging_redesign_shortlist_json TEXT,
  landed_domestic_cap_cny REAL,
  cooldown_until TEXT,
  cooldown_reason TEXT,
  promotion_track TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forms_family ON candidate_forms(product_family_key);
CREATE INDEX IF NOT EXISTS idx_forms_status ON candidate_forms(lifecycle_status);

CREATE TABLE IF NOT EXISTS lead_form_links (
  lead_id TEXT NOT NULL REFERENCES raw_leads(lead_id),
  form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
  link_role TEXT NOT NULL CHECK(link_role IN ('primary_discovery', 'corroboration', 'station_verification')),
  verification_subrole TEXT,
  event_dedup_key TEXT NOT NULL,
  source_ref_hash TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (lead_id, form_id)
);

CREATE INDEX IF NOT EXISTS idx_links_form ON lead_form_links(form_id, link_role);

CREATE TABLE IF NOT EXISTS sourcing_quotes_1688 (
  quote_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
  spec_version INTEGER NOT NULL CHECK(spec_version >= 1),
  sku_lines_json TEXT NOT NULL,
  order_plan_json TEXT,
  pack_multiple INTEGER NOT NULL CHECK(pack_multiple >= 1),
  moq_sets INTEGER NOT NULL CHECK(moq_sets >= 1),
  actual_sets INTEGER NOT NULL CHECK(actual_sets >= 1),
  actual_complete_sets INTEGER NOT NULL CHECK(actual_complete_sets >= 1),
  goods_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (goods_cny_total IS NULL OR goods_cny_total > 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND goods_cny_total IS NOT NULL AND goods_cny_total > 0)),
  domestic_freight_cny_total REAL CHECK(domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0),
  pkg_json TEXT,
  fx_cny_per_usd REAL CHECK(fx_cny_per_usd > 0),
  factory_id TEXT,
  spec_variant_key TEXT,
  kit_note TEXT,
  goods_first_order_promotion INTEGER NOT NULL CHECK(goods_first_order_promotion IN (0, 1)),
  freight_first_order_promotion INTEGER NOT NULL CHECK(freight_first_order_promotion IN (0, 1)),
  lead_time_days INTEGER CHECK(lead_time_days IS NULL OR lead_time_days >= 0),
  sensitive_freebie_flags_json TEXT NOT NULL,
  redacted_destination TEXT NOT NULL,
  redacted_screenshot_path TEXT,
  redacted_webp_sha256 TEXT,
  raw_readback_ref TEXT,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  quote_status TEXT NOT NULL CHECK(quote_status IN ('verified', 'superseded_uncompetitive', 'incomplete_cross_factory_kit', 'rejected_promo', 'rejected_spec', 'expired', 'pending')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotes_form ON sourcing_quotes_1688(form_id, quote_status);

CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
  period_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK(profile_revision >= 50),
  evidence_bundle_sha256 TEXT NOT NULL,
  qualification_json TEXT NOT NULL,
  sort_keys_json TEXT NOT NULL,
  queue_bucket TEXT NOT NULL,
  covered_weight REAL NOT NULL,
  supported_range_json TEXT NOT NULL,
  total_range_json TEXT,
  result_sha256 TEXT NOT NULL,
  html_sha256 TEXT,
  receipt_json TEXT NOT NULL,
  source_attempt_ids_json TEXT NOT NULL DEFAULT '[]',
  review_notes_json TEXT,
  evidence_review_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(form_id, period_id, profile_revision, evidence_bundle_sha256)
);

CREATE INDEX IF NOT EXISTS idx_eval_form ON evaluations(form_id, profile_revision);

CREATE TABLE IF NOT EXISTS queue_state (
  queue_name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active', 'CAPTCHA_PAUSED')),
  pause_reason TEXT,
  paused_form_id TEXT,
  paused_sku_hint TEXT,
  paused_destination_hint TEXT,
  paused_min_qty INTEGER,
  paused_at TEXT,
  resumed_at TEXT,
  resume_verification_json TEXT,
  active_lease_owner TEXT,
  active_lease_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calibration_tracking (
  tracking_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  spec_version INTEGER NOT NULL DEFAULT 1,
  form_spec_sha256 TEXT,
  batch_id TEXT,
  system_verdict TEXT NOT NULL,
  core_85_range_json TEXT,
  supported_range_json TEXT,
  pre_ad_margin_range_json TEXT,
  owner_decision TEXT CHECK(owner_decision IS NULL OR owner_decision IN ('keep', 'drop', 'sample_check', 'hold', 'pending_owner_review')),
  owner_reason TEXT,
  sample_measured_pkg_json TEXT,
  recalculated_margin_json TEXT,
  calibration_note TEXT,
  near_miss_spot_check_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(form_id, spec_version)
);

CREATE INDEX IF NOT EXISTS idx_calibration_batch ON calibration_tracking(batch_id);
`;

export function classifyBillingLane(provider, toolName = '', row = null) {
  const norm = normalizeProvider(provider, toolName);
  if (norm === 'sif') return 'sif';
  if (norm === 'exa') return 'exa';
  if (norm === 'sellersprite') {
    const t = String(toolName || '');
    if (
      (row && (
        (Number(row.ss_web_realtime_tasks) > 0) ||
        (Number(row.estimated_ss_web_realtime_tasks) > 0) ||
        (Number(row.unknown_reserved_ss_web_realtime_tasks) > 0)
      )) ||
      /(?:web_realtime|realtime_task|cua_task|browser_realtime)/i.test(t)
    ) {
      return 'ss_web';
    }
    return 'ss_mcp';
  }
  return null;
}

const ALIGNMENT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have',
  'had', 'your', 'our', 'their', 'not', 'can', 'use', 'using', 'used', 'need', 'needs',
  'want', 'wants', 'product', 'products', 'item', 'items', 'thing', 'things', 'good', 'best',
  'very', 'just', 'like', 'into', 'onto', 'over', 'under', 'about', 'more', 'most', 'some',
  'any', 'all', 'one', 'two', 'set', 'pack', 'kit', 'form', 'task', 'buyer', 'social',
]);

export function extractDomainTokens(text) {
  const s = String(text || '').normalize('NFKC').toLowerCase();
  const latin = new Set();
  const cjk = new Set();
  for (const m of s.matchAll(/[a-z][a-z0-9]{2,}/g)) {
    const tok = m[0].endsWith('s') && m[0].length > 4 ? m[0].slice(0, -1) : m[0];
    if (!ALIGNMENT_STOPWORDS.has(tok) && !ALIGNMENT_STOPWORDS.has(m[0])) {
      latin.add(tok);
    }
  }
  const cjkSeqs = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const seq of cjkSeqs) {
    if (seq.length === 1) {
      cjk.add(seq);
    } else {
      for (let i = 0; i < seq.length - 1; i++) cjk.add(seq.slice(i, i + 2));
    }
  }
  return { latin, cjk };
}

export function isSocialBridgeAlignedWithForm(socialContract, form, { linkNote = null } = {}) {
  if (!socialContract || typeof socialContract !== 'object' || !form || typeof form !== 'object') {
    return { aligned: true, reason: null };
  }
  if (socialContract.status !== 'extracted') {
    return {
      aligned: false,
      reason: `SocialBridge status is "${socialContract.status}", not "extracted"; cannot serve as primary_discovery.`,
    };
  }
  const leadText = [
    socialContract.buyer_task,
    ...(Array.isArray(socialContract.candidate_phrases) ? socialContract.candidate_phrases : []),
  ].filter(Boolean).join(' ');
  const formText = [
    form.label,
    form.buyer_task,
    form.core_form,
  ].filter(Boolean).join(' ');
  const leadTok = extractDomainTokens(leadText);
  const formTok = extractDomainTokens(formText);

  const shareLatin = [...leadTok.latin].some(t => formTok.latin.has(t));
  const shareCjk = [...leadTok.cjk].some(t => formTok.cjk.has(t));
  if (shareLatin || shareCjk) return { aligned: true, reason: null };

  // Both sides have substantive same-script domain terms yet zero overlap -> unrelated buyer task!
  if (leadTok.latin.size >= 2 && formTok.latin.size >= 2) {
    return {
      aligned: false,
      reason: `SocialBridge buyer_task/phrases share zero domain terms with form "${form.form_id}" (${form.buyer_task || form.label}).`,
    };
  }
  if (leadTok.cjk.size >= 2 && formTok.cjk.size >= 2) {
    return {
      aligned: false,
      reason: `SocialBridge buyer_task/phrases share zero CJK domain terms with form "${form.form_id}".`,
    };
  }
  // Cross-script (one purely Latin, one purely CJK): require explicit bridge alignment note.
  const crossScript = (leadTok.latin.size >= 2 && formTok.cjk.size >= 2 && leadTok.cjk.size === 0 && formTok.latin.size === 0) ||
    (leadTok.cjk.size >= 2 && formTok.latin.size >= 2 && leadTok.latin.size === 0 && formTok.cjk.size === 0);
  if (crossScript && !nonemptyStr(linkNote)) {
    return {
      aligned: false,
      reason: `Cross-script SocialBridge lead requires an explicit link_note confirming buyer_task equivalence with form "${form.form_id}".`,
    };
  }
  return { aligned: true, reason: null };
}

function isTrustedNotDispatchedError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.not_dispatched === true || error.outcome === 'not_dispatched') return true;
  if (error.code === 'PREFLIGHT_NOT_DISPATCHED') return true;
  if (error.data && typeof error.data === 'object') {
    if (error.data.outcome === 'not_dispatched' || error.data.not_dispatched === true) return true;
  }
  return false;
}

function isTransientSqliteOpenContention(error) {
  const code = Number(error?.errcode);
  if (!Number.isFinite(code)) return false;
  const base = code & 0xff;
  if (base === 5 || base === 6) return true; // SQLITE_BUSY / SQLITE_LOCKED
  // Windows concurrent WAL/SHM creation contention on initial open (TRUNCATE/LOCK/SHM*)
  return code === 1546 || code === 3850 || code === 4874 || code === 5130 || code === 5386 || code === 5642;
}

function sleepSyncMs(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(1, Math.trunc(ms)));
}

function isVerifiedFiveFieldUiReadback(ui) {
  return Boolean(
    ui &&
    typeof ui === 'object' &&
    ui.logged_in === true &&
    Number(ui.viewport_width_px) >= 1440 &&
    ui.selected_sku_row_visible === true &&
    ui.settlement_bar_visible === true &&
    (ui.applied_quantity_confirmed === true || ui.applied_qty_confirmed === true),
  );
}

function sourcingQuoteFromRow(row) {
  const { pkg_json, fx_cny_per_usd, ...quote } = row;
  if (pkg_json != null) quote.pkg = JSON.parse(pkg_json);
  if (fx_cny_per_usd != null) quote.fx_cny_per_usd = fx_cny_per_usd;
  if (quote.order_plan_json) {
    try {
      const parsedPlan = JSON.parse(quote.order_plan_json);
      if (parsedPlan?.carton_pack_unverified_stage1 === true) {
        quote.carton_pack_unverified_stage1 = true;
        quote.carton_verification_tag = parsedPlan.carton_verification_tag ?? '整箱装箱率待向客服核实';
      }
      if (parsedPlan?.ui_readback && typeof parsedPlan.ui_readback === 'object') {
        quote.ui_readback = parsedPlan.ui_readback;
        quote.ui_readback_verified = isVerifiedFiveFieldUiReadback(parsedPlan.ui_readback);
      } else if (parsedPlan?.ui_readback_verified === false) {
        quote.ui_readback_verified = false;
      }
      if (parsedPlan?.pricing_basis === 'bare_goods_1688' || parsedPlan?.pricing_basis === 'landed_domestic_explicit') {
        quote.pricing_basis = parsedPlan.pricing_basis;
      }
      if (parsedPlan?.domestic_freight_advisory_cny_total !== undefined) {
        quote.domestic_freight_advisory_cny_total = parsedPlan.domestic_freight_advisory_cny_total;
      }
      if (parsedPlan?.manual_owner_entry === true) {
        quote.manual_owner_entry = true;
      }
    } catch { /* ignore */ }
  }
  if (!quote.pricing_basis) {
    quote.pricing_basis = quote.domestic_freight_cny_total == null ? 'bare_goods_1688' : 'landed_domestic_explicit';
  }
  if (quote.domestic_freight_advisory_cny_total === undefined) {
    quote.domestic_freight_advisory_cny_total = null;
  }
  return quote;
}

export class SelectionStore {
  /**
   * reconcileOnOpen defaults to false so secondary writable helpers cannot hijack active
   * in-flight requests. Only an authoritative controller taking ownership after a crash
   * should pass { reconcileOnOpen: true } or explicitly invoke reconcileInFlightOnStartup().
   */
  constructor(dbPath = ':memory:', { reconcileOnOpen = false, readOnly = false } = {}) {
    this.dbPath = dbPath;
    this.readOnly = Boolean(readOnly);
    if (this.readOnly) {
      this.db = new DatabaseSync(dbPath, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.startup_reconciled_attempts = [];
      return;
    }
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const maxAttempts = dbPath === ':memory:' ? 1 : 12;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.db = new DatabaseSync(dbPath);
      try {
        // Set busy_timeout BEFORE WAL transition and DDL so concurrent openers wait instead of failing immediately.
        this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
        if (dbPath !== ':memory:') {
          const curMode = String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase();
          if (curMode !== 'wal') {
            this.db.exec('PRAGMA journal_mode = WAL;');
          }
          this.db.exec('PRAGMA synchronous = FULL;');
        }
        this._migrateApiLedgerProviderCheckIfNeeded();
        this._migrateSourcingQuotesCheckIfNeeded();
        this._withImmediateTx(() => {
          this.db.exec(SCHEMA_SQL);
          this._migrateSchema();
          this._ensureDefaultQueues();
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        try { this.db.close(); } catch { /* ignore close error */ }
        if (attempt < maxAttempts && isTransientSqliteOpenContention(err)) {
          sleepSyncMs(20 + attempt * 15);
          continue;
        }
        throw err;
      }
    }
    if (lastError) throw lastError;
    this.startup_reconciled_attempts = reconcileOnOpen ? this.reconcileInFlightOnStartup() : [];
  }

  _tableColumns(tableName) {
    return new Set(this.db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name));
  }

  _migrateApiLedgerProviderCheckIfNeeded() {
    const master = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_request_ledger'",
    ).get();
    if (!master?.sql || master.sql.includes("'sp_api'")) return;
    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this._withImmediateTx(() => {
        const existing = this._tableColumns('api_request_ledger');
        for (const [colName, colDef] of [
          ['estimated_ss_mcp_units', 'REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_mcp_units >= 0)'],
          ['estimated_ss_web_realtime_tasks', 'REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_web_realtime_tasks >= 0)'],
          ['estimated_exa_calls', 'REAL NOT NULL DEFAULT 0 CHECK(estimated_exa_calls >= 0)'],
          ['unknown_reserved_ss_mcp_units', 'REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_mcp_units >= 0)'],
          ['unknown_reserved_ss_web_realtime_tasks', 'REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_web_realtime_tasks >= 0)'],
          ['unknown_reserved_exa_calls', 'REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_exa_calls >= 0)'],
        ]) {
          if (!existing.has(colName)) {
            this.db.exec(`ALTER TABLE api_request_ledger ADD COLUMN ${colName} ${colDef};`);
          }
        }
        const cols = [
          'attempt_id', 'logical_request_key', 'semantic_lock_key', 'account_scope', 'provider',
          'tool_name', 'canonical_tool', 'tool_version', 'marketplace', 'mode', 'observation_cutoff_date',
          'page_or_cursor', 'normalized_params_json', 'form_id', 'stage', 'status', 'repeat_submission_allowed',
          'billing_status', 'ss_mcp_units', 'ss_web_realtime_tasks', 'sif_units', 'exa_calls',
          'estimated_ss_mcp_units', 'estimated_ss_web_realtime_tasks', 'estimated_sif_units', 'estimated_exa_calls',
          'unknown_reserved_ss_mcp_units', 'unknown_reserved_ss_web_realtime_tasks',
          'unknown_reserved_sif_units', 'unknown_reserved_exa_calls',
          'payload_sha256', 'response_payload_json', 'raw_artifact_path', 'pagination_complete',
          'source_ledger_ref', 'reconciliation_note', 'created_at', 'updated_at', 'finished_at',
        ];
        const colList = cols.join(', ');
        this.db.exec(`
          CREATE TABLE api_request_ledger_v2 (
            attempt_id TEXT PRIMARY KEY,
            logical_request_key TEXT NOT NULL,
            semantic_lock_key TEXT NOT NULL,
            account_scope TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('sellersprite', 'sif', 'exa', 'sp_api', '1688_browser', 'other')),
            tool_name TEXT NOT NULL,
            canonical_tool TEXT NOT NULL,
            tool_version TEXT NOT NULL DEFAULT 'v1',
            marketplace TEXT NOT NULL DEFAULT 'US',
            mode TEXT NOT NULL CHECK(mode IN ('historical_replay', 'fresh_observation')),
            observation_cutoff_date TEXT NOT NULL,
            page_or_cursor TEXT NOT NULL DEFAULT '',
            normalized_params_json TEXT NOT NULL,
            form_id TEXT,
            stage TEXT NOT NULL DEFAULT 'general' CHECK(stage IN ('discovery', 'gate1a', 'gate1b', 'gate2_3', 'replay', 'general')),
            status TEXT NOT NULL CHECK(status IN ('reserved', 'in_flight', 'completed', 'failed', 'unknown_needs_reconciliation', 'permanently_locked')),
            repeat_submission_allowed INTEGER NOT NULL DEFAULT 1 CHECK(repeat_submission_allowed IN (0, 1)),
            billing_status TEXT NOT NULL DEFAULT 'known' CHECK(billing_status IN ('known', 'unknown_not_exposed')),
            ss_mcp_units REAL NOT NULL DEFAULT 0 CHECK(ss_mcp_units >= 0),
            ss_web_realtime_tasks REAL NOT NULL DEFAULT 0 CHECK(ss_web_realtime_tasks >= 0),
            sif_units REAL NOT NULL DEFAULT 0 CHECK(sif_units >= 0),
            exa_calls REAL NOT NULL DEFAULT 0 CHECK(exa_calls >= 0),
            estimated_ss_mcp_units REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_mcp_units >= 0),
            estimated_ss_web_realtime_tasks REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_web_realtime_tasks >= 0),
            estimated_sif_units REAL NOT NULL DEFAULT 0 CHECK(estimated_sif_units >= 0),
            estimated_exa_calls REAL NOT NULL DEFAULT 0 CHECK(estimated_exa_calls >= 0),
            unknown_reserved_ss_mcp_units REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_mcp_units >= 0),
            unknown_reserved_ss_web_realtime_tasks REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_web_realtime_tasks >= 0),
            unknown_reserved_sif_units REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_sif_units >= 0),
            unknown_reserved_exa_calls REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_exa_calls >= 0),
            payload_sha256 TEXT,
            response_payload_json TEXT,
            raw_artifact_path TEXT,
            pagination_complete INTEGER CHECK(pagination_complete IN (0, 1)),
            source_ledger_ref TEXT,
            reconciliation_note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            finished_at TEXT
          );
          INSERT INTO api_request_ledger_v2 (${colList}) SELECT ${colList} FROM api_request_ledger;
          DROP TABLE api_request_ledger;
          ALTER TABLE api_request_ledger_v2 RENAME TO api_request_ledger;
          CREATE INDEX IF NOT EXISTS idx_ledger_logical_key ON api_request_ledger(logical_request_key);
          CREATE INDEX IF NOT EXISTS idx_ledger_semantic_lock ON api_request_ledger(semantic_lock_key, status);
          CREATE INDEX IF NOT EXISTS idx_ledger_form_stage ON api_request_ledger(form_id, stage);
          CREATE INDEX IF NOT EXISTS idx_ledger_status ON api_request_ledger(status);
        `);
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  _migrateSourcingQuotesCheckIfNeeded() {
    const master = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_quotes_1688'",
    ).get();
    if (!master?.sql) return;
    const hadNotNullFreightConstraint = master.sql.includes('domestic_freight_cny_total IS NOT NULL');
    const needsRebuild = !master.sql.includes("'superseded_uncompetitive'") || hadNotNullFreightConstraint;
    if (!needsRebuild) return;
    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this._withImmediateTx(() => {
        const existing = this._tableColumns('sourcing_quotes_1688');
        for (const [colName, colDef] of [
          ['pkg_json', 'TEXT'],
          ['fx_cny_per_usd', 'REAL CHECK(fx_cny_per_usd > 0)'],
          ['factory_id', 'TEXT'],
          ['spec_variant_key', 'TEXT'],
          ['kit_note', 'TEXT'],
        ]) {
          if (!existing.has(colName)) {
            this.db.exec(`ALTER TABLE sourcing_quotes_1688 ADD COLUMN ${colName} ${colDef};`);
          }
        }
        const cols = [
          'quote_id', 'form_id', 'spec_version', 'sku_lines_json', 'order_plan_json',
          'pack_multiple', 'moq_sets', 'actual_sets', 'actual_complete_sets',
          'goods_cny_total', 'domestic_freight_cny_total', 'pkg_json', 'fx_cny_per_usd',
          'factory_id', 'spec_variant_key', 'kit_note',
          'goods_first_order_promotion', 'freight_first_order_promotion', 'lead_time_days',
          'sensitive_freebie_flags_json', 'redacted_destination', 'redacted_screenshot_path',
          'redacted_webp_sha256', 'raw_readback_ref', 'observed_at', 'expires_at', 'quote_status', 'created_at',
        ];
        const colList = cols.join(', ');
        this.db.exec(`
          CREATE TABLE sourcing_quotes_1688_v2 (
            quote_id TEXT PRIMARY KEY,
            form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
            spec_version INTEGER NOT NULL CHECK(spec_version >= 1),
            sku_lines_json TEXT NOT NULL,
            order_plan_json TEXT,
            pack_multiple INTEGER NOT NULL CHECK(pack_multiple >= 1),
            moq_sets INTEGER NOT NULL CHECK(moq_sets >= 1),
            actual_sets INTEGER NOT NULL CHECK(actual_sets >= 1),
            actual_complete_sets INTEGER NOT NULL CHECK(actual_complete_sets >= 1),
            goods_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (goods_cny_total IS NULL OR goods_cny_total > 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND goods_cny_total IS NOT NULL AND goods_cny_total > 0)),
            domestic_freight_cny_total REAL CHECK(domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0),
            pkg_json TEXT,
            fx_cny_per_usd REAL CHECK(fx_cny_per_usd > 0),
            factory_id TEXT,
            spec_variant_key TEXT,
            kit_note TEXT,
            goods_first_order_promotion INTEGER NOT NULL CHECK(goods_first_order_promotion IN (0, 1)),
            freight_first_order_promotion INTEGER NOT NULL CHECK(freight_first_order_promotion IN (0, 1)),
            lead_time_days INTEGER CHECK(lead_time_days IS NULL OR lead_time_days >= 0),
            sensitive_freebie_flags_json TEXT NOT NULL,
            redacted_destination TEXT NOT NULL,
            redacted_screenshot_path TEXT,
            redacted_webp_sha256 TEXT,
            raw_readback_ref TEXT,
            observed_at TEXT NOT NULL,
            expires_at TEXT,
            quote_status TEXT NOT NULL CHECK(quote_status IN ('verified', 'superseded_uncompetitive', 'incomplete_cross_factory_kit', 'rejected_promo', 'rejected_spec', 'expired', 'pending')),
            created_at TEXT NOT NULL
          );
          INSERT INTO sourcing_quotes_1688_v2 (${colList}) SELECT ${colList} FROM sourcing_quotes_1688;
          DROP TABLE sourcing_quotes_1688;
          ALTER TABLE sourcing_quotes_1688_v2 RENAME TO sourcing_quotes_1688;
          CREATE INDEX IF NOT EXISTS idx_quotes_form ON sourcing_quotes_1688(form_id, quote_status);
        `);
        if (hadNotNullFreightConstraint) {
          // ADR-0002 migration: re-rank existing non-promo same-spec ('verified', 'superseded_uncompetitive') groups
          // strictly by bare-goods unit price so legacy freight-distorted winners do not stay inverted.
          const legacyForms = this.db.prepare(
            "SELECT DISTINCT form_id FROM sourcing_quotes_1688 WHERE quote_status = 'superseded_uncompetitive'",
          ).all();
          for (const row of legacyForms) {
            this._rerankSameSpecBareGoodsLocked(row.form_id);
          }
        }
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  _rerankSameSpecBareGoodsLocked(formId, { spec_version = null, spec_variant_key = undefined, as_of_date = null } = {}) {
    const refDay = (typeof as_of_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(as_of_date))
      ? as_of_date.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const candidates = this.db.prepare(`
      SELECT * FROM sourcing_quotes_1688
      WHERE form_id = ? AND quote_status IN ('verified', 'superseded_uncompetitive') AND goods_first_order_promotion = 0 AND goods_cny_total > 0
      ORDER BY created_at ASC
    `).all(formId);
    const byGroup = new Map();
    for (const row of candidates) {
      if (row.expires_at && String(row.expires_at).slice(0, 10) < refDay) continue;
      if (spec_version !== null && row.spec_version !== spec_version) continue;
      if (spec_variant_key !== undefined && (row.spec_variant_key ?? null) !== (spec_variant_key ?? null)) continue;
      const key = `${row.spec_version}::${row.spec_variant_key ?? ''}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(row);
    }
    const supersededIds = [];
    for (const rows of byGroup.values()) {
      if (rows.length < 2) continue;
      let minUnit = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const u = (r.goods_cny_total ?? 0) / Math.max(1, r.actual_sets || 100);
        if (u < minUnit) minUnit = u;
      }
      for (const r of rows) {
        const u = (r.goods_cny_total ?? 0) / Math.max(1, r.actual_sets || 100);
        const desiredStatus = u > minUnit + 1e-6 ? 'superseded_uncompetitive' : 'verified';
        if (r.quote_status !== desiredStatus) {
          this.db.prepare('UPDATE sourcing_quotes_1688 SET quote_status = ? WHERE quote_id = ?').run(desiredStatus, r.quote_id);
        }
        if (desiredStatus === 'superseded_uncompetitive') supersededIds.push(r.quote_id);
      }
    }
    return supersededIds;
  }

  _migrateSchema() {
    const ensureColumns = (tableName, specs) => {
      const existing = this._tableColumns(tableName);
      for (const [colName, colDef] of specs) {
        if (!existing.has(colName)) {
          this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDef};`);
        }
      }
    };
    ensureColumns('api_request_ledger', [
      ['estimated_ss_mcp_units', 'REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_mcp_units >= 0)'],
      ['estimated_ss_web_realtime_tasks', 'REAL NOT NULL DEFAULT 0 CHECK(estimated_ss_web_realtime_tasks >= 0)'],
      ['estimated_exa_calls', 'REAL NOT NULL DEFAULT 0 CHECK(estimated_exa_calls >= 0)'],
      ['unknown_reserved_ss_mcp_units', 'REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_mcp_units >= 0)'],
      ['unknown_reserved_ss_web_realtime_tasks', 'REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_ss_web_realtime_tasks >= 0)'],
      ['unknown_reserved_exa_calls', 'REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_exa_calls >= 0)'],
    ]);
    ensureColumns('raw_leads', [
      ['route', 'TEXT'],
      ['opportunity_type', "TEXT NOT NULL DEFAULT 'unclassified'"],
      ['promotion_track', 'TEXT'],
    ]);
    ensureColumns('candidate_forms', [
      ['cooldown_until', 'TEXT'],
      ['cooldown_reason', 'TEXT'],
      ['promotion_track', 'TEXT'],
      ['sourcing_disposition', 'TEXT'],
      ['packaging_redesign_shortlist_json', 'TEXT'],
    ]);
    ensureColumns('lead_form_links', [
      ['verification_subrole', 'TEXT'],
    ]);
    ensureColumns('sourcing_quotes_1688', [
      ['pkg_json', 'TEXT'],
      ['fx_cny_per_usd', 'REAL CHECK(fx_cny_per_usd > 0)'],
      ['factory_id', 'TEXT'],
      ['spec_variant_key', 'TEXT'],
      ['kit_note', 'TEXT'],
    ]);
    ensureColumns('evaluations', [
      ['review_notes_json', 'TEXT'],
      ['evidence_review_json', 'TEXT'],
    ]);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calibration_tracking (
        tracking_id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL DEFAULT 1,
        form_spec_sha256 TEXT,
        batch_id TEXT,
        system_verdict TEXT NOT NULL,
        core_85_range_json TEXT,
        supported_range_json TEXT,
        pre_ad_margin_range_json TEXT,
        owner_decision TEXT CHECK(owner_decision IS NULL OR owner_decision IN ('keep', 'drop', 'sample_check', 'hold', 'pending_owner_review')),
        owner_reason TEXT,
        sample_measured_pkg_json TEXT,
        recalculated_margin_json TEXT,
        calibration_note TEXT,
        near_miss_spot_check_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(form_id, spec_version)
      );
      CREATE INDEX IF NOT EXISTS idx_calibration_batch ON calibration_tracking(batch_id);
    `);
    // Lane-accurate, idempotent backfill for unresolved unknown rows with zero billed AND zero reserved units.
    // Never adds an ss_mcp reserve to an ss_web row, and never changes totals when reopening the database.
    const unreservedUnknowns = this.db.prepare(`
      SELECT attempt_id, provider, tool_name, canonical_tool,
             ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls,
             estimated_ss_mcp_units, estimated_ss_web_realtime_tasks, estimated_sif_units, estimated_exa_calls,
             unknown_reserved_ss_mcp_units, unknown_reserved_ss_web_realtime_tasks, unknown_reserved_sif_units, unknown_reserved_exa_calls
      FROM api_request_ledger
      WHERE status = 'unknown_needs_reconciliation'
        AND ss_mcp_units = 0 AND ss_web_realtime_tasks = 0 AND sif_units = 0 AND exa_calls = 0
        AND unknown_reserved_ss_mcp_units = 0 AND unknown_reserved_ss_web_realtime_tasks = 0
        AND unknown_reserved_sif_units = 0 AND unknown_reserved_exa_calls = 0
    `).all();
    const updStmt = this.db.prepare(`
      UPDATE api_request_ledger
      SET unknown_reserved_ss_mcp_units = ?,
          unknown_reserved_ss_web_realtime_tasks = ?,
          unknown_reserved_sif_units = ?,
          unknown_reserved_exa_calls = ?
      WHERE attempt_id = ?
    `);
    for (const row of unreservedUnknowns) {
      const lane = classifyBillingLane(row.provider, row.canonical_tool || row.tool_name, row);
      if (lane === 'ss_mcp') {
        updStmt.run(Math.max(1, row.estimated_ss_mcp_units || 0), 0, 0, 0, row.attempt_id);
      } else if (lane === 'ss_web') {
        updStmt.run(0, Math.max(1, row.estimated_ss_web_realtime_tasks || 0), 0, 0, row.attempt_id);
      } else if (lane === 'exa') {
        updStmt.run(0, 0, 0, Math.max(1, row.estimated_exa_calls || 0), row.attempt_id);
      } else if (lane === 'sif' && row.estimated_sif_units > 0) {
        updStmt.run(0, 0, row.estimated_sif_units, 0, row.attempt_id);
      }
    }
  }

  _now() {
    return new Date().toISOString();
  }

  _assertWritable() {
    if (this.readOnly) throw new Error('SelectionStore is opened in read-only mode.');
  }

  _withImmediateTx(fn) {
    this._assertWritable();
    if (this._inOuterTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore rollback error */ }
      throw error;
    }
  }

  _ensureDefaultQueues() {
    const now = this._now();
    this.db.prepare(`
      INSERT OR IGNORE INTO queue_state (queue_name, status, updated_at)
      VALUES ('gate1b_1688_queue', 'active', ?)
    `).run(now);
  }

  close() {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // 1. api_request_ledger: idempotent reservation, crash recovery & permanent locks
  // ---------------------------------------------------------------------------

  /**
   * Authoritative controller startup crash recovery:
   *  - Transitions dangling 'reserved'/'in_flight' attempts to 'unknown_needs_reconciliation',
   *    preserving pre-reserved estimated_sif_units into unknown_reserved_sif_units.
   *  - Clears any stale crashed active_lease_owner in queue_state so a new controller is not deadlocked.
   */
  reconcileInFlightOnStartup() {
    this._assertWritable();
    const now = this._now();
    return this._withImmediateTx(() => {
      const dangling = this.db.prepare(`
        SELECT attempt_id, provider, tool_name, canonical_tool,
               estimated_ss_mcp_units, estimated_ss_web_realtime_tasks, estimated_sif_units, estimated_exa_calls,
               unknown_reserved_ss_mcp_units, unknown_reserved_ss_web_realtime_tasks, unknown_reserved_sif_units, unknown_reserved_exa_calls
        FROM api_request_ledger
        WHERE status IN ('reserved', 'in_flight')
      `).all();
      const stmt = this.db.prepare(`
        UPDATE api_request_ledger
        SET status = 'unknown_needs_reconciliation',
            repeat_submission_allowed = 0,
            unknown_reserved_ss_mcp_units = ?,
            unknown_reserved_ss_web_realtime_tasks = ?,
            unknown_reserved_sif_units = ?,
            unknown_reserved_exa_calls = ?,
            reconciliation_note = COALESCE(reconciliation_note || ' | ', '') || 'Crash recovery on startup: prior attempt interrupted before receipt; reconcile before retrying.',
            updated_at = ?
        WHERE attempt_id = ?
      `);
      for (const row of dangling) {
        const lane = classifyBillingLane(row.provider, row.canonical_tool || row.tool_name, row);
        const resSsMcp = Math.max(row.unknown_reserved_ss_mcp_units || 0, row.estimated_ss_mcp_units || 0, lane === 'ss_mcp' ? 1 : 0);
        const resSsWeb = Math.max(row.unknown_reserved_ss_web_realtime_tasks || 0, row.estimated_ss_web_realtime_tasks || 0, lane === 'ss_web' ? 1 : 0);
        const resSif = Math.max(row.unknown_reserved_sif_units || 0, row.estimated_sif_units || 0, lane === 'sif' ? 1 : 0);
        const resExa = Math.max(row.unknown_reserved_exa_calls || 0, row.estimated_exa_calls || 0, lane === 'exa' ? 1 : 0);
        stmt.run(resSsMcp, resSsWeb, resSif, resExa, now, row.attempt_id);
      }

      // Clear stale serial queue leases left behind by a crashed controller.
      this.db.prepare(`
        UPDATE queue_state
        SET active_lease_owner = NULL, active_lease_at = NULL, updated_at = ?
        WHERE active_lease_owner IS NOT NULL
      `).run(now);

      return dangling.map(r => r.attempt_id);
    });
  }

  /**
   * Synchronously reserve a fresh_observation attempt BEFORE network/browser dispatch.
   * Rejects historical_replay (use recordHistoricalAttempt for imports), enforces permanent locks,
   * respects no_retry (repeat_submission_allowed = 0) across all statuses including completed,
   * and returns cached payload on exact logical match.
   */
  reserveRequestAttempt(spec) {
    this._assertWritable();
    if (!spec || typeof spec !== 'object') throw new TypeError('Request reservation spec object is required.');
    if (spec.mode === 'historical_replay') {
      throw new TypeError('reserveRequestAttempt cannot reserve live dispatches under mode="historical_replay".');
    }
    const keys = computeLogicalRequestKey({ ...spec, mode: 'fresh_observation' });
    const attemptId = nonemptyStr(spec.attempt_id) ? spec.attempt_id.trim() : randomUUID();
    const stage = spec.stage ?? 'general';
    const formId = spec.form_id ?? null;
    const reuseCompleted = spec.reuse_completed !== false;
    const lane = classifyBillingLane(keys.provider, keys.canonical_tool, spec);
    const estimatedSifUnits = spec.estimated_sif_units ?? 0;
    const defaultSsEst = lane === 'ss_mcp' ? 1 : 0;
    const defaultSsWebEst = lane === 'ss_web' ? 1 : 0;
    const defaultExaEst = lane === 'exa' ? 1 : 0;
    const estimatedSsMcpUnits = spec.estimated_ss_mcp_units ?? defaultSsEst;
    const estimatedSsWebTasks = spec.estimated_ss_web_realtime_tasks ?? defaultSsWebEst;
    const estimatedExaCalls = spec.estimated_exa_calls ?? defaultExaEst;
    for (const [label, val] of Object.entries({
      estimated_sif_units: estimatedSifUnits,
      estimated_ss_mcp_units: estimatedSsMcpUnits,
      estimated_ss_web_realtime_tasks: estimatedSsWebTasks,
      estimated_exa_calls: estimatedExaCalls,
    })) {
      if (!finite(val) || val < 0) {
        throw new TypeError(`${label} must be a nonnegative finite number.`);
      }
    }
    const now = this._now();

    return this._withImmediateTx(() => {
      // Check 1: Permanent semantic or logical lock (survives restarts, aliases, wrappers, and dates).
      const locked = this.db.prepare(`
        SELECT attempt_id, provider, canonical_tool, reconciliation_note, source_ledger_ref
        FROM api_request_ledger
        WHERE status = 'permanently_locked'
          AND (semantic_lock_key = ? OR logical_request_key = ?)
        LIMIT 1
      `).get(keys.semantic_lock_key, keys.logical_request_key);
      if (locked) {
        return {
          allowed: false,
          reused: false,
          reason: 'permanently_locked',
          blocking_attempt_id: locked.attempt_id,
          detail: locked.reconciliation_note || `Request permanently locked by ${locked.attempt_id}.`,
          logical_request_key: keys.logical_request_key,
          semantic_lock_key: keys.semantic_lock_key,
        };
      }

      // Check 2: Active in-flight, unresolved unknown, or ANY explicit no_retry (repeat_submission_allowed = 0) row!
      const activeOrBlocked = this.db.prepare(`
        SELECT attempt_id, status, reconciliation_note, repeat_submission_allowed
        FROM api_request_ledger
        WHERE (
          status IN ('reserved', 'in_flight', 'unknown_needs_reconciliation')
          AND (
            logical_request_key = ?
            OR (semantic_lock_key = ? AND observation_cutoff_date = ?)
            OR (status = 'unknown_needs_reconciliation' AND repeat_submission_allowed = 0 AND semantic_lock_key = ?)
          )
        ) OR (
          repeat_submission_allowed = 0
          AND status IN ('failed', 'unknown_needs_reconciliation', 'completed')
          AND (logical_request_key = ? OR (semantic_lock_key = ? AND observation_cutoff_date = ?))
        )
        LIMIT 1
      `).get(
        keys.logical_request_key,
        keys.semantic_lock_key,
        keys.observation_cutoff_date,
        keys.semantic_lock_key,
        keys.logical_request_key,
        keys.semantic_lock_key,
        keys.observation_cutoff_date,
      );
      if (activeOrBlocked) {
        return {
          allowed: false,
          reused: false,
          reason: activeOrBlocked.status === 'completed'
            ? 'no_retry_locked_historical_attempt'
            : 'in_flight_or_unknown_reconciliation_required',
          blocking_attempt_id: activeOrBlocked.attempt_id,
          blocking_status: activeOrBlocked.status,
          detail: activeOrBlocked.reconciliation_note || `Existing ${activeOrBlocked.status} attempt (no_retry/unresolved) blocks re-submission.`,
          logical_request_key: keys.logical_request_key,
          semantic_lock_key: keys.semantic_lock_key,
        };
      }

      // Check 3: Reuse exact completed logical request (returns persisted response payload at 0 spend).
      if (reuseCompleted) {
        let completed = this.db.prepare(`
          SELECT * FROM api_request_ledger
          WHERE logical_request_key = ? AND status = 'completed'
          ORDER BY created_at DESC
          LIMIT 1
        `).get(keys.logical_request_key);
        if (!completed) {
          const rawToolTrimmed = String(spec.tool_name || '').trim();
          const legacyCandidateKeys = new Set();
          const parsedNormParams = JSON.parse(keys.normalized_params_json);
          const paramVariants = [parsedNormParams];
          if (parsedNormParams && typeof parsedNormParams === 'object' && parsedNormParams.marketplace === 'US' &&
              !(spec.params && ('marketplace' in spec.params || 'country' in spec.params))) {
            const { marketplace: _m, ...withoutMarket } = parsedNormParams;
            paramVariants.push(withoutMarket);
          }
          const toolVariants = [
            rawToolTrimmed,
            keys.canonical_tool,
            `amz_spapi_${keys.canonical_tool}`,
            `amazon_sp_api_${keys.canonical_tool}`,
          ];
          for (const legacyProv of ['other', keys.provider]) {
            for (const legacyTool of toolVariants) {
              if (!legacyTool) continue;
              for (const pVar of paramVariants) {
                const lk = sha256Hex(canonicalJson({
                  account_scope: keys.account_scope,
                  provider: legacyProv,
                  canonical_tool: legacyTool,
                  tool_version: keys.tool_version,
                  marketplace: keys.marketplace,
                  mode: spec.mode ?? 'fresh_observation',
                  observation_cutoff_date: keys.observation_cutoff_date,
                  page_or_cursor: keys.page_or_cursor,
                  normalized_params: pVar,
                }));
                if (lk !== keys.logical_request_key) legacyCandidateKeys.add(lk);
              }
            }
          }
          for (const lk of legacyCandidateKeys) {
            completed = this.db.prepare(`
              SELECT * FROM api_request_ledger
              WHERE logical_request_key = ? AND status = 'completed'
              ORDER BY created_at DESC
              LIMIT 1
            `).get(lk);
            if (completed) break;
          }
          if (!completed && keys.provider === 'sp_api') {
            completed = this.db.prepare(`
              SELECT * FROM api_request_ledger
              WHERE semantic_lock_key = ?
                AND account_scope = ?
                AND marketplace = ?
                AND mode = ?
                AND observation_cutoff_date = ?
                AND page_or_cursor = ?
                AND normalized_params_json = ?
                AND status = 'completed'
              ORDER BY created_at DESC
              LIMIT 1
            `).get(
              keys.semantic_lock_key,
              keys.account_scope,
              keys.marketplace,
              spec.mode ?? 'fresh_observation',
              keys.observation_cutoff_date,
              keys.page_or_cursor,
              keys.normalized_params_json,
            );
          }
        }
        if (completed) {
          return {
            allowed: false,
            reused: true,
            completed: true,
            reason: 'cached_completed_request',
            attempt_id: completed.attempt_id,
            payload: completed.response_payload_json !== null ? JSON.parse(completed.response_payload_json) : null,
            payload_sha256: completed.payload_sha256,
            raw_artifact_path: completed.raw_artifact_path,
            cached_attempt: { ...completed },
            logical_request_key: keys.logical_request_key,
            semantic_lock_key: keys.semantic_lock_key,
          };
        }
      }

      // Check 4: Reserve synchronously before dispatch (persisting 4-way estimated units for crash safety).
      this.db.prepare(`
        INSERT INTO api_request_ledger (
          attempt_id, logical_request_key, semantic_lock_key, account_scope,
          provider, tool_name, canonical_tool, tool_version, marketplace, mode,
          observation_cutoff_date, page_or_cursor, normalized_params_json,
          form_id, stage, status, repeat_submission_allowed,
          estimated_ss_mcp_units, estimated_ss_web_realtime_tasks, estimated_sif_units, estimated_exa_calls,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh_observation', ?, ?, ?, ?, ?, 'reserved', 0, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId,
        keys.logical_request_key,
        keys.semantic_lock_key,
        keys.account_scope,
        keys.provider,
        spec.tool_name,
        keys.canonical_tool,
        keys.tool_version,
        keys.marketplace,
        keys.observation_cutoff_date,
        keys.page_or_cursor,
        keys.normalized_params_json,
        formId,
        stage,
        estimatedSsMcpUnits,
        estimatedSsWebTasks,
        estimatedSifUnits,
        estimatedExaCalls,
        now,
        now,
      );

      return {
        allowed: true,
        reused: false,
        reason: 'reserved',
        attempt_id: attemptId,
        logical_request_key: keys.logical_request_key,
        semantic_lock_key: keys.semantic_lock_key,
      };
    });
  }

  markAttemptInFlight(attemptId) {
    this._assertWritable();
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE api_request_ledger
      SET status = 'in_flight', updated_at = ?
      WHERE attempt_id = ? AND status = 'reserved'
    `).run(now, attemptId);
    if (res.changes !== 1) throw new Error(`Cannot mark attempt ${attemptId} in_flight (not in reserved state).`);
  }

  completeAttempt(attemptId, {
    payload = undefined,
    payload_sha256 = null,
    raw_artifact_path = null,
    pagination_complete = null,
    ss_mcp_units = 0,
    ss_web_realtime_tasks = 0,
    sif_units = 0,
    exa_calls = 0,
    billing_status = 'known',
    reconciliation_note = null,
  } = {}) {
    this._assertWritable();
    if (payload_sha256 !== null && !HEX_SHA256_RE.test(payload_sha256)) {
      throw new TypeError('payload_sha256 must be a 64-char lowercase hex SHA-256 string when provided.');
    }
    for (const [k, v] of Object.entries({ ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls })) {
      if (!finite(v) || v < 0) throw new TypeError(`${k} must be a nonnegative finite number.`);
    }
    if (!['known', 'unknown_not_exposed'].includes(billing_status)) {
      throw new TypeError('billing_status must be known or unknown_not_exposed.');
    }

    // Never persist raw PII or credentials into cached response_payload_json, while preserving dispatch & spend facts.
    let serializedPayload = null;
    let payloadWithheldNote = null;
    if (payload !== undefined && payload !== null) {
      try {
        assertNoRawPii(payload, 'response_payload');
        if (containsSecretToken(payload)) {
          throw new TypeError('response_payload contains credential or token.');
        }
        serializedPayload = canonicalJson(payload);
      } catch {
        serializedPayload = null;
        payloadWithheldNote = 'Response payload withheld from cache due to unredacted PII or credentials.';
      }
    }
    const effectiveHash = payload_sha256 ?? (
      payload !== undefined && payload !== null ? sha256Hex(canonicalJson(payload)) : null
    );
    const mergedNote = [reconciliation_note ? sanitizeDiagnosticText(reconciliation_note) : null, payloadWithheldNote]
      .filter(Boolean).join(' | ') || null;
    const keepReserve = billing_status === 'unknown_not_exposed' ? 1 : 0;
    const now = this._now();
    const pagVal = pagination_complete === null || pagination_complete === undefined ? null : (pagination_complete ? 1 : 0);

    const res = this.db.prepare(`
      UPDATE api_request_ledger
      SET status = 'completed',
          repeat_submission_allowed = 1,
          billing_status = ?,
          ss_mcp_units = ?,
          ss_web_realtime_tasks = ?,
          sif_units = ?,
          exa_calls = ?,
          unknown_reserved_ss_mcp_units = CASE WHEN ? = 1 THEN MAX(unknown_reserved_ss_mcp_units, estimated_ss_mcp_units) ELSE 0 END,
          unknown_reserved_ss_web_realtime_tasks = CASE WHEN ? = 1 THEN MAX(unknown_reserved_ss_web_realtime_tasks, estimated_ss_web_realtime_tasks) ELSE 0 END,
          unknown_reserved_sif_units = CASE WHEN ? = 1 THEN MAX(unknown_reserved_sif_units, estimated_sif_units) ELSE 0 END,
          unknown_reserved_exa_calls = CASE WHEN ? = 1 THEN MAX(unknown_reserved_exa_calls, estimated_exa_calls) ELSE 0 END,
          payload_sha256 = ?,
          response_payload_json = COALESCE(?, response_payload_json),
          raw_artifact_path = ?,
          pagination_complete = ?,
          reconciliation_note = COALESCE(?, reconciliation_note),
          updated_at = ?,
          finished_at = ?
      WHERE attempt_id = ? AND status IN ('reserved', 'in_flight')
    `).run(
      billing_status,
      ss_mcp_units,
      ss_web_realtime_tasks,
      sif_units,
      exa_calls,
      keepReserve,
      keepReserve,
      keepReserve,
      keepReserve,
      effectiveHash,
      serializedPayload,
      raw_artifact_path,
      pagVal,
      mergedNote,
      now,
      now,
      attemptId,
    );
    if (res.changes !== 1) throw new Error(`Cannot complete attempt ${attemptId} (not in reserved/in_flight state).`);
  }

  failAttemptUnknownOutcome(attemptId, {
    note = 'Unknown execution/billing outcome; do not retry without reconciliation.',
    unknown_reserved_ss_mcp_units = null,
    unknown_reserved_ss_web_realtime_tasks = null,
    unknown_reserved_sif_units = null,
    unknown_reserved_exa_calls = null,
    ss_mcp_units = 0,
    ss_web_realtime_tasks = 0,
    sif_units = 0,
    exa_calls = 0,
    billing_status = 'unknown_not_exposed',
    payload_sha256 = null,
    raw_artifact_path = null,
  } = {}) {
    this._assertWritable();
    for (const [k, v] of Object.entries({
      unknown_reserved_ss_mcp_units,
      unknown_reserved_ss_web_realtime_tasks,
      unknown_reserved_sif_units,
      unknown_reserved_exa_calls,
    })) {
      if (v !== null && (!finite(v) || v < 0)) {
        throw new TypeError(`${k} must be a nonnegative finite number or null.`);
      }
    }
    const cleanNote = sanitizeDiagnosticText(note);
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE api_request_ledger
      SET status = 'unknown_needs_reconciliation',
          repeat_submission_allowed = 0,
          billing_status = ?,
          ss_mcp_units = ss_mcp_units + ?,
          ss_web_realtime_tasks = ss_web_realtime_tasks + ?,
          sif_units = sif_units + ?,
          exa_calls = exa_calls + ?,
          unknown_reserved_ss_mcp_units = MAX(unknown_reserved_ss_mcp_units, COALESCE(?, estimated_ss_mcp_units)),
          unknown_reserved_ss_web_realtime_tasks = MAX(unknown_reserved_ss_web_realtime_tasks, COALESCE(?, estimated_ss_web_realtime_tasks)),
          unknown_reserved_sif_units = MAX(unknown_reserved_sif_units, COALESCE(?, estimated_sif_units)),
          unknown_reserved_exa_calls = MAX(unknown_reserved_exa_calls, COALESCE(?, estimated_exa_calls)),
          payload_sha256 = COALESCE(?, payload_sha256),
          raw_artifact_path = COALESCE(?, raw_artifact_path),
          reconciliation_note = ?,
          updated_at = ?,
          finished_at = ?
      WHERE attempt_id = ? AND status IN ('reserved', 'in_flight')
    `).run(
      billing_status,
      ss_mcp_units,
      ss_web_realtime_tasks,
      sif_units,
      exa_calls,
      unknown_reserved_ss_mcp_units,
      unknown_reserved_ss_web_realtime_tasks,
      unknown_reserved_sif_units,
      unknown_reserved_exa_calls,
      payload_sha256,
      raw_artifact_path,
      cleanNote,
      now,
      now,
      attemptId,
    );
    if (res.changes !== 1) throw new Error(`Cannot mark attempt ${attemptId} unknown_needs_reconciliation.`);
  }

  failAttemptBeforeDispatch(attemptId, note = 'Failed locally before network dispatch.', { allowInFlightPreflight = false } = {}) {
    this._assertWritable();
    const now = this._now();
    const statusClause = allowInFlightPreflight ? "status IN ('reserved', 'in_flight')" : "status = 'reserved'";
    const res = this.db.prepare(`
      UPDATE api_request_ledger
      SET status = 'failed',
          repeat_submission_allowed = 1,
          billing_status = 'known',
          unknown_reserved_ss_mcp_units = 0,
          unknown_reserved_ss_web_realtime_tasks = 0,
          unknown_reserved_sif_units = 0,
          unknown_reserved_exa_calls = 0,
          reconciliation_note = ?,
          updated_at = ?,
          finished_at = ?
      WHERE attempt_id = ? AND ${statusClause}
    `).run(sanitizeDiagnosticText(note), now, now, attemptId);
    if (res.changes !== 1) throw new Error(`Cannot mark attempt ${attemptId} failed before dispatch (must be in ${allowInFlightPreflight ? 'reserved/in_flight' : 'reserved'} state).`);
  }

  reconcileUnknownAttempt(attemptId, {
    resolved_status,
    note,
    ss_mcp_units = 0,
    ss_web_realtime_tasks = 0,
    sif_units = 0,
    exa_calls = 0,
    payload_sha256 = null,
    raw_artifact_path = null,
  }) {
    this._assertWritable();
    if (!['completed', 'failed', 'permanently_locked'].includes(resolved_status)) {
      throw new TypeError('resolved_status must be completed, failed, or permanently_locked.');
    }
    if (!nonemptyStr(note)) throw new TypeError('A nonempty reconciliation note is required.');
    for (const [k, v] of Object.entries({ ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls })) {
      if (!finite(v) || v < 0) throw new TypeError(`${k} must be a nonnegative finite number.`);
    }
    const cleanNote = sanitizeDiagnosticText(note.trim());
    const now = this._now();
    return this._withImmediateTx(() => {
      const existing = this.db.prepare(`
        SELECT status, billing_status, repeat_submission_allowed, ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls
        FROM api_request_ledger
        WHERE attempt_id = ?
      `).get(attemptId);
      if (!existing) throw new Error(`Attempt ${attemptId} not found.`);
      if (existing.status === 'permanently_locked') {
        throw new Error(`Attempt ${attemptId} is permanently_locked and cannot be unlocked.`);
      }
      const canReconcile = existing.status === 'unknown_needs_reconciliation' ||
        (existing.status === 'completed' && existing.billing_status === 'unknown_not_exposed');
      if (!canReconcile) {
        throw new Error(`Attempt ${attemptId} is in state ${existing.status} (billing ${existing.billing_status}), not eligible for reconciliation.`);
      }
      const totalBilledUnits =
        (existing.ss_mcp_units + ss_mcp_units) +
        (existing.ss_web_realtime_tasks + ss_web_realtime_tasks) +
        (existing.sif_units + sif_units) +
        (existing.exa_calls + exa_calls);
      // Preserve no_retry lock on historical completed attempts AND on billed failures or permanent locks!
      const preserveHistoricalNoRetry = existing.status === 'completed' && existing.repeat_submission_allowed === 0;
      const repeatAllowed = (
        resolved_status === 'permanently_locked' ||
        preserveHistoricalNoRetry ||
        (resolved_status === 'failed' && totalBilledUnits > 0)
      ) ? 0 : 1;
      const keepUnknownReserve = resolved_status === 'permanently_locked';
      this.db.prepare(`
        UPDATE api_request_ledger
        SET status = ?,
            repeat_submission_allowed = ?,
            billing_status = CASE WHEN ? = 1 THEN billing_status ELSE 'known' END,
            ss_mcp_units = ss_mcp_units + ?,
            ss_web_realtime_tasks = ss_web_realtime_tasks + ?,
            sif_units = sif_units + ?,
            exa_calls = exa_calls + ?,
            unknown_reserved_ss_mcp_units = CASE WHEN ? = 1 THEN unknown_reserved_ss_mcp_units ELSE 0 END,
            unknown_reserved_ss_web_realtime_tasks = CASE WHEN ? = 1 THEN unknown_reserved_ss_web_realtime_tasks ELSE 0 END,
            unknown_reserved_sif_units = CASE WHEN ? = 1 THEN unknown_reserved_sif_units ELSE 0 END,
            unknown_reserved_exa_calls = CASE WHEN ? = 1 THEN unknown_reserved_exa_calls ELSE 0 END,
            payload_sha256 = COALESCE(?, payload_sha256),
            raw_artifact_path = COALESCE(?, raw_artifact_path),
            reconciliation_note = ?,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(
        resolved_status,
        repeatAllowed,
        keepUnknownReserve ? 1 : 0,
        ss_mcp_units,
        ss_web_realtime_tasks,
        sif_units,
        exa_calls,
        keepUnknownReserve ? 1 : 0,
        keepUnknownReserve ? 1 : 0,
        keepUnknownReserve ? 1 : 0,
        keepUnknownReserve ? 1 : 0,
        payload_sha256,
        raw_artifact_path,
        cleanNote,
        now,
        attemptId,
      );
      return this.getAttempt(attemptId);
    });
  }

  /**
   * Idempotently and order-independently import a historical request or permanent lock record.
   * When a recovery file locks an attempt previously imported under a prefixed ledger ID,
   * canonicalizes the row's attempt_id to the authoritative recovery attempt_id so both import
   * orders yield identical row count, physical attempt_id, lock status, source_ledger_ref, and reserve.
   */
  recordHistoricalAttempt(record) {
    this._assertWritable();
    const keys = computeLogicalRequestKey({
      account_scope: record.account_scope ?? 'historical-default',
      provider: record.provider,
      tool_name: record.tool_name,
      tool_version: record.tool_version ?? 'historical',
      marketplace: record.marketplace ?? 'US',
      mode: 'historical_replay',
      observation_cutoff_date: record.observation_cutoff_date,
      page_or_cursor: record.page_or_cursor ?? '',
      params: record.params ?? {},
    });
    const attemptId = nonemptyStr(record.attempt_id) ? record.attempt_id.trim() : randomUUID();
    const status = record.status ?? 'completed';
    const noRetry = record.no_retry === true;
    const repeatAllowed = (status === 'permanently_locked' || status === 'unknown_needs_reconciliation' || noRetry) ? 0 : 1;
    const billingStatus = record.billing_status ?? 'known';
    const lane = classifyBillingLane(keys.provider, keys.canonical_tool, record);
    const incomingReserve = Number(record.unknown_reserved_sif_units ?? 0) || 0;
    const incomingSsMcpReserve = Number(
      record.unknown_reserved_ss_mcp_units ??
      (status === 'unknown_needs_reconciliation' && lane === 'ss_mcp' && !(record.ss_mcp_units > 0) ? 1 : 0),
    ) || 0;
    const incomingSsWebReserve = Number(
      record.unknown_reserved_ss_web_realtime_tasks ??
      (status === 'unknown_needs_reconciliation' && lane === 'ss_web' && !(record.ss_web_realtime_tasks > 0) ? 1 : 0),
    ) || 0;
    const incomingExaReserve = Number(
      record.unknown_reserved_exa_calls ??
      (status === 'unknown_needs_reconciliation' && lane === 'exa' && !(record.exa_calls > 0) ? 1 : 0),
    ) || 0;
    const cleanNote = record.reconciliation_note ? sanitizeDiagnosticText(record.reconciliation_note) : null;
    const preferIncomingId = record.canonical_recovery_lock === true;
    const now = this._now();

    return this._withImmediateTx(() => {
      let existing = this.db.prepare('SELECT * FROM api_request_ledger WHERE attempt_id = ?').get(attemptId);
      if (!existing && status === 'permanently_locked') {
        existing = this.db.prepare(`
          SELECT * FROM api_request_ledger
          WHERE semantic_lock_key = ? AND mode = 'historical_replay'
          ORDER BY created_at ASC
          LIMIT 1
        `).get(keys.semantic_lock_key);
      }

      if (existing) {
        let targetId = existing.attempt_id;
        // Canonicalize prefixed ledger attempt_id to the authoritative bare recovery ID so order A === order B.
        if (preferIncomingId && existing.attempt_id !== attemptId) {
          const refCount = this.db.prepare('SELECT COUNT(*) AS c FROM raw_leads WHERE source_attempt_id = ?').get(existing.attempt_id).c;
          if (refCount === 0) {
            this.db.prepare('UPDATE api_request_ledger SET attempt_id = ? WHERE attempt_id = ?').run(attemptId, existing.attempt_id);
            targetId = attemptId;
          }
        }

        // Never let a stale unknown_needs_reconciliation or unknown_not_exposed re-import revert an operator-reconciled row!
        const alreadyOperatorSettled =
          (existing.status === 'completed' || existing.status === 'failed') &&
          existing.billing_status === 'known' &&
          (status === 'unknown_needs_reconciliation' || billingStatus === 'unknown_not_exposed');

        const nextStatus = existing.status === 'permanently_locked' || status === 'permanently_locked'
          ? 'permanently_locked'
          : (alreadyOperatorSettled
            ? existing.status
            : (status === 'unknown_needs_reconciliation' ? 'unknown_needs_reconciliation' : existing.status));
        const nextRepeat = alreadyOperatorSettled
          ? existing.repeat_submission_allowed
          : ((existing.repeat_submission_allowed === 0 || repeatAllowed === 0 || nextStatus === 'permanently_locked') ? 0 : 1);
        const nextBillingStatus = alreadyOperatorSettled
          ? existing.billing_status
          : (billingStatus === 'unknown_not_exposed' ? 'unknown_not_exposed' : existing.billing_status);
        const effSsMcpRes = alreadyOperatorSettled ? existing.unknown_reserved_ss_mcp_units : incomingSsMcpReserve;
        const effSsWebRes = alreadyOperatorSettled ? existing.unknown_reserved_ss_web_realtime_tasks : incomingSsWebReserve;
        const effSifRes = alreadyOperatorSettled ? existing.unknown_reserved_sif_units : incomingReserve;
        const effExaRes = alreadyOperatorSettled ? existing.unknown_reserved_exa_calls : incomingExaReserve;
        const nextNote = alreadyOperatorSettled ? existing.reconciliation_note : (cleanNote ?? existing.reconciliation_note);
        const nextSourceRef = preferIncomingId
          ? (record.source_ledger_ref ?? existing.source_ledger_ref)
          : (existing.source_ledger_ref ?? record.source_ledger_ref ?? null);
        this.db.prepare(`
          UPDATE api_request_ledger
          SET status = ?,
              repeat_submission_allowed = ?,
              billing_status = ?,
              ss_mcp_units = MAX(ss_mcp_units, ?),
              ss_web_realtime_tasks = MAX(ss_web_realtime_tasks, ?),
              sif_units = MAX(sif_units, ?),
              exa_calls = MAX(exa_calls, ?),
              unknown_reserved_ss_mcp_units = MAX(unknown_reserved_ss_mcp_units, ?),
              unknown_reserved_ss_web_realtime_tasks = MAX(unknown_reserved_ss_web_realtime_tasks, ?),
              unknown_reserved_sif_units = MAX(unknown_reserved_sif_units, ?),
              unknown_reserved_exa_calls = MAX(unknown_reserved_exa_calls, ?),
              payload_sha256 = COALESCE(payload_sha256, ?),
              raw_artifact_path = COALESCE(raw_artifact_path, ?),
              source_ledger_ref = ?,
              reconciliation_note = ?,
              updated_at = ?
          WHERE attempt_id = ?
        `).run(
          nextStatus,
          nextRepeat,
          nextBillingStatus,
          record.ss_mcp_units ?? 0,
          record.ss_web_realtime_tasks ?? 0,
          record.sif_units ?? 0,
          record.exa_calls ?? 0,
          effSsMcpRes,
          effSsWebRes,
          effSifRes,
          effExaRes,
          record.payload_sha256 ?? null,
          record.raw_artifact_path ?? null,
          nextSourceRef,
          nextNote,
          now,
          targetId,
        );
        return {
          inserted: false,
          upgraded_to_lock: nextStatus === 'permanently_locked' && existing.status !== 'permanently_locked',
          preserved_settlement: alreadyOperatorSettled,
          attempt_id: targetId,
        };
      }

      this.db.prepare(`
        INSERT INTO api_request_ledger (
          attempt_id, logical_request_key, semantic_lock_key, account_scope,
          provider, tool_name, canonical_tool, tool_version, marketplace, mode,
          observation_cutoff_date, page_or_cursor, normalized_params_json,
          form_id, stage, status, repeat_submission_allowed, billing_status,
          ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls,
          estimated_ss_mcp_units, estimated_ss_web_realtime_tasks, estimated_sif_units, estimated_exa_calls,
          unknown_reserved_ss_mcp_units, unknown_reserved_ss_web_realtime_tasks, unknown_reserved_sif_units, unknown_reserved_exa_calls,
          payload_sha256, raw_artifact_path, pagination_complete, source_ledger_ref, reconciliation_note,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical_replay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId,
        keys.logical_request_key,
        keys.semantic_lock_key,
        keys.account_scope,
        keys.provider,
        record.tool_name,
        keys.canonical_tool,
        keys.tool_version,
        keys.marketplace,
        keys.observation_cutoff_date,
        keys.page_or_cursor,
        keys.normalized_params_json,
        record.form_id ?? null,
        record.stage ?? 'replay',
        status,
        repeatAllowed,
        billingStatus,
        record.ss_mcp_units ?? 0,
        record.ss_web_realtime_tasks ?? 0,
        record.sif_units ?? 0,
        record.exa_calls ?? 0,
        incomingSsMcpReserve,
        incomingSsWebReserve,
        incomingReserve,
        incomingExaReserve,
        record.payload_sha256 ?? null,
        record.raw_artifact_path ?? null,
        record.pagination_complete === undefined || record.pagination_complete === null ? null : (record.pagination_complete ? 1 : 0),
        record.source_ledger_ref ?? null,
        cleanNote,
        record.created_at ?? now,
        now,
        record.finished_at ?? null,
      );
      return { inserted: true, upgraded_to_lock: false, attempt_id: attemptId };
    });
  }

  getAttempt(attemptId) {
    const row = this.db.prepare('SELECT * FROM api_request_ledger WHERE attempt_id = ?').get(attemptId);
    return row ? { ...row } : null;
  }

  /**
   * Guarded request execution wrapper:
   * - historical_replay NEVER invokes live executor (returns cached completed receipt or throws).
   * - Empty/null outcomes and error responses ({ isError: true }, etc.) become unknown_needs_reconciliation.
   * - Preserves spent quota when response payload contains PII (withholding raw PII from cache).
   */
  async executeGuardedRequest(spec, executor) {
    this._assertWritable();
    if (!spec || typeof spec !== 'object') throw new TypeError('Request spec object is required.');

    if (spec.mode === 'historical_replay') {
      const keys = computeLogicalRequestKey(spec);
      const completed = this.db.prepare(`
        SELECT * FROM api_request_ledger
        WHERE logical_request_key = ? AND status = 'completed'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(keys.logical_request_key);
      if (!completed) {
        throw new Error('historical_replay mode cannot dispatch a live executor when no saved completed receipt exists.');
      }
      return {
        allowed: false,
        reused: true,
        completed: true,
        reason: 'historical_replay_cached',
        attempt_id: completed.attempt_id,
        payload: completed.response_payload_json !== null ? JSON.parse(completed.response_payload_json) : null,
        payload_sha256: completed.payload_sha256,
        raw_artifact_path: completed.raw_artifact_path,
        cached_attempt: { ...completed },
      };
    }

    if (typeof executor !== 'function') throw new TypeError('executor function is required.');
    // Enforce SellerSprite/SIF/SP-API connector guards BEFORE reservation by default on every dispatch.
    if (spec.enforce_provider_guards !== false) {
      const rawProv = String(spec.provider || '').trim().toLowerCase();
      const isSpApi = rawProv === 'sp_api' || rawProv === 'sp-api' || rawProv === 'amazon_sp_api' ||
        /^(?:sp_api_|catalogitems_|productfees_|listingsrestrictions_|listingsitems_|definitionsproducttypes_)/i.test(String(spec.tool_name || '').trim());
      const prov = isSpApi ? 'sp_api' : normalizeProvider(spec.provider, spec.tool_name);
      if (prov === 'sellersprite' || prov === 'sif' || prov === 'sp_api') {
        validateProviderCall(prov, spec.tool_name, spec.params ?? {}, {
          ...(spec.provider_guard_context ?? {}),
          throwOnError: true,
        });
      }
    }
    const reservation = this.reserveRequestAttempt(spec);
    if (!reservation.allowed) return reservation;

    const attemptId = reservation.attempt_id;
    this.markAttemptInFlight(attemptId);
    try {
      const outcome = await executor({ attempt_id: attemptId, reservation });
      if (!outcome || typeof outcome !== 'object') {
        this.failAttemptUnknownOutcome(attemptId, {
          note: 'Executor returned empty/null outcome after dispatch; execution/billing outcome unknown.',
          unknown_reserved_sif_units: spec.estimated_sif_units ?? 0,
          billing_status: 'unknown_not_exposed',
        });
        return {
          allowed: true,
          reused: false,
          completed: false,
          status: 'unknown_needs_reconciliation',
          attempt_id: attemptId,
          payload: null,
          payload_sha256: null,
          raw_artifact_path: null,
        };
      }

      // Trusted proven pre-dispatch failure returned by adapter (0 upstream calls made): do NOT reserve quota or lock.
      if (
        (outcome.not_dispatched === true || outcome.outcome === 'not_dispatched') &&
        !(outcome.ss_mcp_units > 0) &&
        !(outcome.ss_web_realtime_tasks > 0) &&
        !(outcome.sif_units > 0) &&
        !(outcome.exa_calls > 0)
      ) {
        this.failAttemptBeforeDispatch(
          attemptId,
          outcome.error || outcome.reconciliation_note || 'Trusted pre-dispatch failure (not_dispatched); no upstream call was sent.',
          { allowInFlightPreflight: true },
        );
        return {
          allowed: true,
          reused: false,
          completed: false,
          not_dispatched: true,
          status: 'failed',
          attempt_id: attemptId,
          payload: null,
          payload_sha256: null,
          raw_artifact_path: null,
        };
      }

      const hasReceiptContent = (outcome.payload !== undefined && outcome.payload !== null) ||
        nonemptyStr(outcome.payload_sha256) ||
        nonemptyStr(outcome.raw_artifact_path);

      const isReturnedError = Boolean(
        outcome.isError === true ||
        outcome.is_error === true ||
        outcome.error ||
        outcome.status === 'error' ||
        outcome.status === 'returned_error' ||
        outcome.payload?.isError === true ||
        outcome.payload?.is_error === true,
      );

      // Auto-extract real provider charges from payload when executor omitted explicit unit counts.
      const extractPayloadCharge = payloadObj => {
        let sif = 0;
        let ss = 0;
        const visit = (v, d = 0) => {
          if (v === null || v === undefined || d > 5) return;
          if (typeof v === 'string') {
            const s = v.trim();
            if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
              try { visit(JSON.parse(s), d + 1); } catch { /* ignore */ }
            }
            return;
          }
          if (typeof v !== 'object') return;
          if (Array.isArray(v)) { for (const it of v) visit(it, d + 1); return; }
          if (typeof v._quota?.costThisCall === 'number' && Number.isFinite(v._quota.costThisCall)) sif = Math.max(sif, v._quota.costThisCall);
          if (typeof v.billing?.chargedUnits === 'number' && Number.isFinite(v.billing.chargedUnits)) ss = Math.max(ss, v.billing.chargedUnits);
          for (const k of ['structuredContent', 'content', 'response', 'result', 'data', 'text']) {
            if (v[k] !== undefined) visit(v[k], d + 1);
          }
        };
        visit(payloadObj, 0);
        return { sif, ss };
      };
      const inferredCharge = outcome.payload !== undefined && outcome.payload !== null
        ? extractPayloadCharge(outcome.payload)
        : { sif: 0, ss: 0 };
      const normProv = normalizeProvider(spec.provider, spec.tool_name);
      const effectiveSifUnits = Math.max(outcome.sif_units ?? 0, normProv === 'sif' ? inferredCharge.sif : 0);
      const effectiveSsUnits = Math.max(outcome.ss_mcp_units ?? 0, normProv === 'sellersprite' ? inferredCharge.ss : 0);
      const effectiveExaCalls = Math.max(outcome.exa_calls ?? 0, (normProv === 'exa' && !isReturnedError && hasReceiptContent) ? 1 : 0);

      if (isReturnedError || !hasReceiptContent) {
        const errDetail = isReturnedError
          ? (typeof outcome.error === 'string'
            ? outcome.error
            : (outcome.reconciliation_note || outcome.payload?.error || 'Provider returned error object; reconcile execution/billing.'))
          : 'Executor returned outcome without payload, payload_sha256, or raw_artifact_path; reconcile execution/billing.';
        const payloadHash = outcome.payload_sha256 ?? (
          outcome.payload !== undefined && outcome.payload !== null ? sha256Hex(canonicalJson(outcome.payload)) : null
        );
        this.failAttemptUnknownOutcome(attemptId, {
          note: errDetail,
          unknown_reserved_sif_units: spec.estimated_sif_units ?? 0,
          ss_mcp_units: effectiveSsUnits,
          ss_web_realtime_tasks: outcome.ss_web_realtime_tasks ?? 0,
          sif_units: effectiveSifUnits,
          exa_calls: outcome.exa_calls ?? 0,
          billing_status: outcome.billing_status ?? 'unknown_not_exposed',
          payload_sha256: payloadHash,
          raw_artifact_path: outcome.raw_artifact_path ?? null,
        });
        return {
          allowed: true,
          reused: false,
          completed: false,
          status: 'unknown_needs_reconciliation',
          attempt_id: attemptId,
          payload: outcome.payload ?? null,
          payload_sha256: payloadHash,
          raw_artifact_path: outcome.raw_artifact_path ?? null,
        };
      }

      const payloadHash = outcome.payload_sha256 ?? (
        outcome.payload !== undefined && outcome.payload !== null ? sha256Hex(canonicalJson(outcome.payload)) : null
      );
      this.completeAttempt(attemptId, {
        payload: outcome.payload,
        payload_sha256: payloadHash,
        raw_artifact_path: outcome.raw_artifact_path ?? null,
        pagination_complete: outcome.pagination_complete ?? null,
        ss_mcp_units: effectiveSsUnits,
        ss_web_realtime_tasks: outcome.ss_web_realtime_tasks ?? 0,
        sif_units: effectiveSifUnits,
        exa_calls: effectiveExaCalls,
        billing_status: outcome.billing_status ?? 'known',
        reconciliation_note: outcome.reconciliation_note ?? null,
      });
      return {
        allowed: true,
        reused: false,
        completed: true,
        attempt_id: attemptId,
        payload: outcome.payload ?? null,
        payload_sha256: payloadHash,
        raw_artifact_path: outcome.raw_artifact_path ?? null,
      };
    } catch (error) {
      if (isTrustedNotDispatchedError(error)) {
        this.failAttemptBeforeDispatch(
          attemptId,
          `Pre-dispatch failure (${sanitizeDiagnosticText(error?.message || 'not_dispatched')}); request was not sent.`,
          { allowInFlightPreflight: true },
        );
      } else {
        this.failAttemptUnknownOutcome(attemptId, {
          note: `Executor error after dispatch (${sanitizeDiagnosticText(error?.message || 'unknown_error')}); reconcile before retrying.`,
          unknown_reserved_sif_units: spec.estimated_sif_units ?? 0,
        });
      }
      throw error;
    }
  }

  getQuotaSummary() {
    const cols = this._tableColumns('api_request_ledger');
    const has4Way = cols.has('unknown_reserved_ss_mcp_units') &&
      cols.has('unknown_reserved_ss_web_realtime_tasks') &&
      cols.has('unknown_reserved_exa_calls');

    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(ss_mcp_units), 0) AS ss_mcp_units,
        COALESCE(SUM(ss_web_realtime_tasks), 0) AS ss_web_realtime_tasks,
        COALESCE(SUM(sif_units), 0) AS sif_units,
        COALESCE(SUM(exa_calls), 0) AS exa_calls,
        ${has4Way
          ? 'COALESCE(SUM(unknown_reserved_ss_mcp_units), 0)'
          : '0'
        } AS unknown_reserved_ss_mcp_units,
        ${has4Way
          ? 'COALESCE(SUM(unknown_reserved_ss_web_realtime_tasks), 0)'
          : '0'
        } AS unknown_reserved_ss_web_realtime_tasks,
        COALESCE(SUM(unknown_reserved_sif_units), 0) AS unknown_reserved_sif_units,
        ${has4Way
          ? 'COALESCE(SUM(unknown_reserved_exa_calls), 0)'
          : '0'
        } AS unknown_reserved_exa_calls,
        COUNT(*) AS total_attempts,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_attempts,
        COALESCE(SUM(CASE WHEN status = 'permanently_locked' THEN 1 ELSE 0 END), 0) AS permanently_locked_attempts,
        COALESCE(SUM(CASE WHEN status = 'unknown_needs_reconciliation' THEN 1 ELSE 0 END), 0) AS unknown_attempts,
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'in_flight') THEN 1 ELSE 0 END), 0) AS active_attempts,
        COALESCE(SUM(CASE WHEN billing_status = 'unknown_not_exposed' THEN 1 ELSE 0 END), 0) AS unknown_billing_attempts
      FROM api_request_ledger
    `).get();
    const unknownSelectCols = has4Way
      ? 'provider, tool_name, canonical_tool, ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls, estimated_ss_mcp_units, estimated_ss_web_realtime_tasks, estimated_sif_units, estimated_exa_calls, unknown_reserved_ss_mcp_units, unknown_reserved_ss_web_realtime_tasks, unknown_reserved_sif_units, unknown_reserved_exa_calls'
      : 'provider, tool_name, canonical_tool, ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls, unknown_reserved_sif_units';
    const unknownRows = this.db.prepare(`
      SELECT ${unknownSelectCols}
      FROM api_request_ledger
      WHERE status = 'unknown_needs_reconciliation'
    `).all();
    const unknownByProvider = {};
    const unknownByLane = { ss_mcp: 0, ss_web: 0, sif: 0, exa: 0 };
    let fallbackResSsMcp = 0;
    let fallbackResSsWeb = 0;
    let fallbackResExa = 0;
    for (const r of unknownRows) {
      unknownByProvider[r.provider] = (unknownByProvider[r.provider] ?? 0) + 1;
      const lane = classifyBillingLane(r.provider, r.canonical_tool || r.tool_name, r);
      if (lane && Object.hasOwn(unknownByLane, lane)) unknownByLane[lane]++;
      if (!has4Way) {
        if (lane === 'ss_mcp' && !(r.ss_mcp_units > 0)) fallbackResSsMcp += 1;
        else if (lane === 'ss_web' && !(r.ss_web_realtime_tasks > 0)) fallbackResSsWeb += 1;
        else if (lane === 'exa' && !(r.exa_calls > 0)) fallbackResExa += 1;
      }
    }
    const unkResSsMcp = has4Way ? totals.unknown_reserved_ss_mcp_units : fallbackResSsMcp;
    const unkResSsWeb = has4Way ? totals.unknown_reserved_ss_web_realtime_tasks : fallbackResSsWeb;
    const unkResExa = has4Way ? totals.unknown_reserved_exa_calls : fallbackResExa;
    return {
      ...totals,
      unknown_reserved_ss_mcp_units: unkResSsMcp,
      unknown_reserved_ss_web_realtime_tasks: unkResSsWeb,
      unknown_reserved_exa_calls: unkResExa,
      unknown_attempts_by_provider: unknownByProvider,
      by_lane: {
        ss_mcp: {
          spent: totals.ss_mcp_units,
          unknown_reserved: unkResSsMcp,
          unknown_attempts: unknownByLane.ss_mcp,
        },
        ss_web: {
          spent: totals.ss_web_realtime_tasks,
          unknown_reserved: unkResSsWeb,
          unknown_attempts: unknownByLane.ss_web,
        },
        sif: {
          spent: totals.sif_units,
          unknown_reserved: totals.unknown_reserved_sif_units,
          unknown_attempts: unknownByLane.sif,
        },
        exa: {
          spent: totals.exa_calls,
          unknown_reserved: unkResExa,
          unknown_attempts: unknownByLane.exa,
        },
      },
    };
  }

  /**
   * Count actual dispatched/reserved/completed incremental requests for a form,
   * excluding confirmed pre-dispatch local failures (status = 'failed').
   */
  countIncrementalRequestsForForm(formId, stages = ['gate1b', 'gate2_3']) {
    if (!Array.isArray(stages) || stages.length === 0) return 0;
    const placeholders = stages.map(() => '?').join(',');
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM api_request_ledger
      WHERE form_id = ?
        AND mode = 'fresh_observation'
        AND (status != 'failed' OR sif_units > 0 OR ss_mcp_units > 0 OR ss_web_realtime_tasks > 0 OR exa_calls > 0)
        AND stage IN (${placeholders})
    `).get(formId, ...stages);
    return row.cnt;
  }

  // ---------------------------------------------------------------------------
  // 2. raw_leads & lead_form_links
  // ---------------------------------------------------------------------------

  upsertRawLead(lead, { preserveExisting = false } = {}) {
    this._assertWritable();
    if (!lead || typeof lead !== 'object') throw new TypeError('Lead object is required.');
    const leadId = nonemptyStr(lead.lead_id) ? lead.lead_id.trim() : randomUUID();
    const phrase = nonemptyStr(lead.phrase_or_title) ? lead.phrase_or_title.trim() : null;
    if (!phrase) throw new TypeError('lead.phrase_or_title must be a nonempty string.');
    const normalizedKey = (lead.normalized_key || phrase).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    const sourceChannel = nonemptyStr(lead.source_channel) ? lead.source_channel.trim() : null;
    if (!sourceChannel) throw new TypeError('lead.source_channel must be a nonempty string.');
    const sourceRef = nonemptyStr(lead.source_ref) ? lead.source_ref.trim() : null;
    if (!sourceRef) throw new TypeError('lead.source_ref must be a nonempty string.');
    if (!validEvidenceDate(lead.observed_at)) {
      throw new TypeError('lead.observed_at must be a valid ISO date or timestamp with timezone.');
    }
    const firstSeenAt = lead.first_seen_at ?? lead.observed_at;
    if (!validEvidenceDate(firstSeenAt)) {
      throw new TypeError('lead.first_seen_at must be a valid ISO date or timestamp with timezone.');
    }
    const disposition = lead.disposition ?? 'unreviewed';
    if (!ALLOWED_DISPOSITIONS.includes(disposition)) {
      throw new TypeError(`lead.disposition must be one of ${ALLOWED_DISPOSITIONS.join(', ')}.`);
    }
    const channelMeta = resolveChannelMeta(sourceChannel, lead.route ?? null, lead.entry_group ?? null);
    const opportunityType = lead.opportunity_type ?? 'unclassified';
    if (!OPPORTUNITY_TYPES.includes(opportunityType)) {
      throw new TypeError(`lead.opportunity_type must be one of ${OPPORTUNITY_TYPES.join(', ')}.`);
    }
    const promotionTrack = lead.promotion_track ?? null;
    if (promotionTrack !== null && !PROMOTION_TRACKS.includes(promotionTrack)) {
      throw new TypeError(`lead.promotion_track must be one of ${PROMOTION_TRACKS.join(', ')} or null.`);
    }
    const sourceRefHash = sha256Hex(canonicalizeSourceRef(sourceRef));
    const eventDedupKey = nonemptyStr(lead.event_dedup_key)
      ? lead.event_dedup_key.trim().toLowerCase()
      : sourceRefHash;
    const evidenceSha = lead.evidence_sha256 ?? sha256Hex(canonicalJson({
      source_channel: sourceChannel,
      source_ref: sourceRef,
      phrase_or_title: phrase,
      raw_excerpt: lead.raw_excerpt ?? null,
      observed_at: lead.observed_at,
    }));
    if (!HEX_SHA256_RE.test(evidenceSha)) throw new TypeError('lead.evidence_sha256 must be a 64-char hex SHA-256.');

    assertNoRawPii({
      lead_id: leadId,
      phrase,
      raw_excerpt: lead.raw_excerpt ?? null,
      disposition_reason: lead.disposition_reason ?? null,
      metadata: lead.metadata ?? null,
    }, 'raw_lead');
    if (lead.metadata !== undefined && containsSecretToken(lead.metadata)) {
      throw new TypeError('raw_lead.metadata contains a credential or token; redact before persisting.');
    }

    const now = this._now();
    return this._withImmediateTx(() => {
      const existing = this.db.prepare('SELECT * FROM raw_leads WHERE lead_id = ?').get(leadId);
      if (existing) {
        if (preserveExisting) return { inserted: false, lead: { ...existing } };
        this.db.prepare(`
          UPDATE raw_leads
          SET disposition = ?,
              disposition_reason = COALESCE(?, disposition_reason),
              route = COALESCE(?, route),
              entry_group = COALESCE(?, entry_group),
              opportunity_type = COALESCE(?, opportunity_type),
              promotion_track = COALESCE(?, promotion_track),
              metadata_json = ?
          WHERE lead_id = ?
        `).run(
          disposition,
          lead.disposition_reason ?? null,
          lead.route !== undefined && lead.route !== null ? channelMeta.route : null,
          lead.entry_group !== undefined && lead.entry_group !== null ? channelMeta.entry_group : null,
          lead.opportunity_type ?? null,
          promotionTrack,
          canonicalJson(lead.metadata ?? JSON.parse(existing.metadata_json)),
          leadId,
        );
        return { inserted: false, lead: { ...this.db.prepare('SELECT * FROM raw_leads WHERE lead_id = ?').get(leadId) } };
      }
      this.db.prepare(`
        INSERT INTO raw_leads (
          lead_id, normalized_key, event_dedup_key, source_ref_hash, source_channel, route, entry_group,
          opportunity_type, promotion_track,
          source_ref, phrase_or_title, raw_excerpt, observed_at, first_seen_at,
          evidence_sha256, disposition, disposition_reason, source_attempt_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        leadId,
        normalizedKey,
        eventDedupKey,
        sourceRefHash,
        sourceChannel,
        channelMeta.route,
        channelMeta.entry_group,
        opportunityType,
        promotionTrack,
        sourceRef,
        phrase,
        lead.raw_excerpt ?? null,
        lead.observed_at,
        firstSeenAt,
        evidenceSha,
        disposition,
        lead.disposition_reason ?? null,
        lead.source_attempt_id ?? null,
        canonicalJson(lead.metadata ?? {}),
        now,
      );
      return { inserted: true, lead: { ...this.db.prepare('SELECT * FROM raw_leads WHERE lead_id = ?').get(leadId) } };
    });
  }

  /**
   * Validate a SocialBridgeExtractor structured output and persist it into raw_leads
   * with canonical social route, entry_group, and non-keyword provenance metadata.
   */
  ingestSocialBridgeLead(socialOutput, {
    lead_id = undefined,
    form_id = null,
    link_role = 'primary_discovery',
    link_note = null,
    disposition = null,
    disposition_reason = null,
    opportunity_type = 'unclassified',
    promotion_track = null,
    source_attempt_id = null,
    metadata = {},
    preserveExisting = false,
  } = {}) {
    const validated = validateSocialBridgeOutput(socialOutput);
    const meta = resolveChannelMeta(validated.platform, 'social_cross_platform', 'social');
    if (validated.status !== 'extracted' && disposition === 'product') {
      throw new TypeError(`SocialBridgeExtractor status "${validated.status}" cannot be promoted to disposition "product".`);
    }
    const resolvedDisposition = disposition ?? (
      validated.status === 'extracted'
        ? 'product'
        : validated.status === 'no_buyable_product'
          ? 'needs_context'
          : 'unreviewed'
    );
    const socialContract = {
      status: validated.status,
      platform: validated.platform,
      buyer_task: socialOutput.buyer_task ?? null,
      candidate_phrases: validated.candidate_phrases,
      form_id: nonemptyStr(socialOutput.form_id) ? socialOutput.form_id.trim() : null,
    };
    const trimmedFormId = nonemptyStr(form_id) ? form_id.trim() : null;
    if (trimmedFormId) {
      if (socialContract.form_id && socialContract.form_id !== trimmedFormId) {
        throw new TypeError(`SocialBridgeExtractor form_id (${socialContract.form_id}) conflicts with target form_id (${trimmedFormId}).`);
      }
      const targetForm = this.getCandidateForm(trimmedFormId);
      if (!targetForm) throw new TypeError(`Unknown form_id for SocialBridge lead: ${trimmedFormId}`);
      if (link_role === 'primary_discovery') {
        const alignment = isSocialBridgeAlignedWithForm(socialContract, targetForm, { linkNote: link_note });
        if (!alignment.aligned) {
          throw new TypeError(`SocialBridge primary_discovery alignment failed: ${alignment.reason}`);
        }
      }
    }
    const primaryPhrase = validated.candidate_phrases[0] ?? socialOutput.buyer_task ?? validated.event_dedup_key;
    const sourceRef = socialOutput.source_url ?? socialOutput.source_ref;
    const upserted = this.upsertRawLead({
      lead_id,
      source_channel: meta.channel_id,
      route: meta.route,
      entry_group: meta.entry_group,
      opportunity_type,
      promotion_track,
      event_dedup_key: validated.event_dedup_key,
      source_ref: sourceRef,
      phrase_or_title: primaryPhrase,
      raw_excerpt: socialOutput.verbatim_excerpt ?? null,
      observed_at: socialOutput.observed_at,
      disposition: resolvedDisposition,
      disposition_reason: disposition_reason ?? (socialOutput.buyer_task ? `SocialBridgeExtractor: ${socialOutput.buyer_task}` : null),
      source_attempt_id,
      metadata: {
        ...metadata,
        social_bridge_contract: socialContract,
      },
    }, { preserveExisting });
    if (trimmedFormId) {
      const linked = this.linkLeadToForm({
        lead_id: upserted.lead.lead_id,
        form_id: trimmedFormId,
        link_role,
        note: link_note,
      });
      return { ...upserted, link: linked.link };
    }
    return upserted;
  }

  /**
   * Link a raw lead to a candidate form, deduplicating primary_discovery by BOTH event_dedup_key
   * AND canonical source_ref_hash so two tools citing the same original post with distinct custom
   * event keys never double-count independent discovery.
   */
  linkLeadToForm({ lead_id, form_id, link_role = 'primary_discovery', note = null }) {
    this._assertWritable();
    if (!['primary_discovery', 'corroboration', 'station_verification'].includes(link_role)) {
      throw new TypeError('link_role must be primary_discovery, corroboration, or station_verification.');
    }
    const now = this._now();
    return this._withImmediateTx(() => {
      const lead = this.db.prepare('SELECT lead_id, event_dedup_key, source_ref_hash FROM raw_leads WHERE lead_id = ?').get(lead_id);
      if (!lead) throw new TypeError(`Unknown lead_id: ${lead_id}`);
      const form = this.db.prepare('SELECT form_id FROM candidate_forms WHERE form_id = ?').get(form_id);
      if (!form) throw new TypeError(`Unknown form_id: ${form_id}`);

      const existingLink = this.db.prepare('SELECT * FROM lead_form_links WHERE lead_id = ? AND form_id = ?').get(lead_id, form_id);
      if (existingLink) {
        return {
          inserted: false,
          link: { ...existingLink, link_role: existingLink.verification_subrole || existingLink.link_role },
        };
      }

      let effectiveRole = link_role;
      let effectiveNote = note;
      if (link_role === 'primary_discovery') {
        const dupPrimary = this.db.prepare(`
          SELECT lead_id FROM lead_form_links
          WHERE form_id = ?
            AND link_role = 'primary_discovery'
            AND (event_dedup_key = ? OR source_ref_hash = ?)
          LIMIT 1
        `).get(form_id, lead.event_dedup_key, lead.source_ref_hash);
        if (dupPrimary) {
          effectiveRole = 'corroboration';
          effectiveNote = [note, `Auto-downgraded from duplicate primary_discovery on same source event (first seen by ${dupPrimary.lead_id}).`]
            .filter(Boolean).join(' ');
        }
      }

      const linksSql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='lead_form_links'").get()?.sql || '');
      const supportsStationRoleInCheck = linksSql.includes('station_verification');
      const storedRole = effectiveRole === 'station_verification' && !supportsStationRoleInCheck
        ? 'corroboration'
        : effectiveRole;
      const subrole = effectiveRole === 'station_verification' ? 'station_verification' : null;

      this.db.prepare(`
        INSERT INTO lead_form_links (lead_id, form_id, link_role, verification_subrole, event_dedup_key, source_ref_hash, linked_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(lead_id, form_id, storedRole, subrole, lead.event_dedup_key, lead.source_ref_hash, now, effectiveNote);
      const saved = this.db.prepare('SELECT * FROM lead_form_links WHERE lead_id = ? AND form_id = ?').get(lead_id, form_id);
      return {
        inserted: true,
        link: { ...saved, link_role: saved.verification_subrole || saved.link_role },
      };
    });
  }

  getLeadsForForm(formId) {
    const linkCols = this._tableColumns('lead_form_links');
    const subCol = linkCols.has('verification_subrole') ? 'j.verification_subrole' : 'NULL';
    return this.db.prepare(`
      SELECT l.*, COALESCE(${subCol}, j.link_role) AS link_role, j.linked_at, j.note AS link_note
      FROM lead_form_links j
      JOIN raw_leads l ON l.lead_id = j.lead_id
      WHERE j.form_id = ?
      ORDER BY CASE j.link_role WHEN 'primary_discovery' THEN 0 ELSE 1 END, l.first_seen_at ASC
    `).all(formId).map(r => ({ ...r }));
  }

  // ---------------------------------------------------------------------------
  // 3. candidate_forms
  // ---------------------------------------------------------------------------

  upsertCandidateForm(form, { preserveExisting = false } = {}) {
    this._assertWritable();
    if (!form || typeof form !== 'object') throw new TypeError('Candidate form object is required.');
    const formId = nonemptyStr(form.form_id) ? form.form_id.trim() : null;
    if (!formId) throw new TypeError('form.form_id must be a nonempty string.');
    const familyKey = nonemptyStr(form.product_family_key) ? form.product_family_key.trim() : formId;
    const label = nonemptyStr(form.label) ? form.label.trim() : null;
    const buyerTask = nonemptyStr(form.buyer_task) ? form.buyer_task.trim() : null;
    if (!label || !buyerTask) throw new TypeError('form.label and form.buyer_task must be nonempty strings.');
    const composition = form.saleable_set_composition;
    if (!composition || typeof composition !== 'object') {
      throw new TypeError('form.saleable_set_composition must be an object or array describing the complete saleable set.');
    }
    const status = form.lifecycle_status ?? 'discovered';
    if (!LIFECYCLE_STATUSES.includes(status)) {
      throw new TypeError(`Invalid lifecycle_status: ${status}`);
    }
    if (form.spec_match !== undefined && form.spec_match !== null) {
      validateSpecMatcherOutput(form.spec_match);
    }
    if (Array.isArray(form.spec_matches)) {
      for (const sm of form.spec_matches) validateSpecMatcherOutput(sm);
    }
    const cooldownUntil = form.cooldown_until ?? null;
    if (cooldownUntil !== null) {
      assertIsoDateOnly(cooldownUntil, 'form.cooldown_until');
    }
    const cooldownReason = nonemptyStr(form.cooldown_reason) ? sanitizeDiagnosticText(form.cooldown_reason.trim()) : null;
    const promotionTrack = form.promotion_track ?? null;
    if (promotionTrack !== null && !PROMOTION_TRACKS.includes(promotionTrack)) {
      throw new TypeError(`form.promotion_track must be one of ${PROMOTION_TRACKS.join(', ')} or null.`);
    }

    const specPayload = {
      buyer_task: buyerTask,
      saleable_set_composition: composition,
      grade_or_material: form.grade_or_material ?? null,
      target_child_asin: form.target_child_asin ?? null,
      leaf_node_path: form.leaf_node_path ?? null,
    };
    const specSha = sha256Hex(canonicalJson(specPayload));
    const now = this._now();

    return this._withImmediateTx(() => {
      const existing = this.db.prepare('SELECT * FROM candidate_forms WHERE form_id = ?').get(formId);
      if (existing) {
        if (preserveExisting) {
          return { inserted: false, spec_changed: false, form: { ...existing } };
        }
        const nextVersion = existing.spec_sha256 === specSha ? existing.spec_version : existing.spec_version + 1;
        this.db.prepare(`
          UPDATE candidate_forms
          SET product_family_key = ?,
              spec_version = ?,
              spec_sha256 = ?,
              label = ?,
              buyer_task = ?,
              saleable_set_composition_json = ?,
              grade_or_material = ?,
              target_child_asin = ?,
              leaf_node_path = ?,
              lifecycle_status = COALESCE(?, lifecycle_status),
              cooldown_until = COALESCE(?, cooldown_until),
              cooldown_reason = COALESCE(?, cooldown_reason),
              promotion_track = COALESCE(?, promotion_track),
              updated_at = ?
          WHERE form_id = ?
        `).run(
          familyKey,
          nextVersion,
          specSha,
          label,
          buyerTask,
          canonicalJson(composition),
          form.grade_or_material ?? null,
          form.target_child_asin ?? null,
          form.leaf_node_path ?? null,
          form.lifecycle_status ?? null,
          cooldownUntil,
          cooldownReason,
          promotionTrack,
          now,
          formId,
        );
        return { inserted: false, spec_changed: nextVersion !== existing.spec_version, form: this.getCandidateForm(formId) };
      }

      this.db.prepare(`
        INSERT INTO candidate_forms (
          form_id, product_family_key, spec_version, spec_sha256, label, buyer_task,
          saleable_set_composition_json, grade_or_material, target_child_asin, leaf_node_path,
          lifecycle_status, gate1a_result_json, gate1b_result_json, negotiation_shortlist_json,
          landed_domestic_cap_cny, cooldown_until, cooldown_reason, promotion_track, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
      `).run(
        formId,
        familyKey,
        specSha,
        label,
        buyerTask,
        canonicalJson(composition),
        form.grade_or_material ?? null,
        form.target_child_asin ?? null,
        form.leaf_node_path ?? null,
        status,
        cooldownUntil,
        cooldownReason,
        promotionTrack,
        now,
        now,
      );
      return { inserted: true, spec_changed: false, form: this.getCandidateForm(formId) };
    });
  }

  setFormCooldown(formId, cooldownUntil, reason = null) {
    this._assertWritable();
    const until = cooldownUntil === null ? null : assertIsoDateOnly(cooldownUntil, 'cooldown_until');
    const cleanReason = nonemptyStr(reason) ? sanitizeDiagnosticText(reason.trim()) : null;
    const res = this.db.prepare(`
      UPDATE candidate_forms
      SET cooldown_until = ?, cooldown_reason = ?, updated_at = ?
      WHERE form_id = ?
    `).run(until, cleanReason, this._now(), formId);
    if (res.changes !== 1) throw new Error(`Form ${formId} not found.`);
    return this.getCandidateForm(formId);
  }

  updateFormLifecycle(formId, lifecycleStatus, {
    gate1a_result = undefined,
    gate1b_result = undefined,
    negotiation_shortlist = undefined,
    packaging_redesign_shortlist = undefined,
    landed_domestic_cap_cny = undefined,
    sourcing_disposition = undefined,
  } = {}) {
    this._assertWritable();
    if (!LIFECYCLE_STATUSES.includes(lifecycleStatus)) {
      throw new TypeError(`Invalid lifecycle_status: ${lifecycleStatus}`);
    }
    const formsSql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='candidate_forms'").get()?.sql || '');
    const supportsPrivateMoldInCheck = formsSql.includes('private_mold_reserved');
    const hasPkgShortlistCol = this._tableColumns('candidate_forms').has('packaging_redesign_shortlist_json');
    const storedStatus = lifecycleStatus === 'private_mold_reserved' && !supportsPrivateMoldInCheck
      ? 'deferred'
      : lifecycleStatus;
    const effectiveSourcingDisp = sourcing_disposition !== undefined
      ? sourcing_disposition
      : (lifecycleStatus === 'private_mold_reserved' ? 'private_mold_reserved' : undefined);
    const now = this._now();
    const res = hasPkgShortlistCol
      ? this.db.prepare(`
          UPDATE candidate_forms
          SET lifecycle_status = ?,
              sourcing_disposition = CASE WHEN ? = 1 THEN ? ELSE sourcing_disposition END,
              gate1a_result_json = CASE WHEN ? = 1 THEN ? ELSE gate1a_result_json END,
              gate1b_result_json = CASE WHEN ? = 1 THEN ? ELSE gate1b_result_json END,
              negotiation_shortlist_json = CASE WHEN ? = 1 THEN ? ELSE negotiation_shortlist_json END,
              packaging_redesign_shortlist_json = CASE WHEN ? = 1 THEN ? ELSE packaging_redesign_shortlist_json END,
              landed_domestic_cap_cny = CASE WHEN ? = 1 THEN ? ELSE landed_domestic_cap_cny END,
              updated_at = ?
          WHERE form_id = ?
        `).run(
          storedStatus,
          effectiveSourcingDisp !== undefined ? 1 : 0,
          effectiveSourcingDisp ?? null,
          gate1a_result !== undefined ? 1 : 0,
          gate1a_result !== undefined ? canonicalJson(gate1a_result) : null,
          gate1b_result !== undefined ? 1 : 0,
          gate1b_result !== undefined ? canonicalJson(gate1b_result) : null,
          negotiation_shortlist !== undefined ? 1 : 0,
          negotiation_shortlist !== undefined ? canonicalJson(negotiation_shortlist) : null,
          packaging_redesign_shortlist !== undefined ? 1 : 0,
          packaging_redesign_shortlist !== undefined ? canonicalJson(packaging_redesign_shortlist) : null,
          landed_domestic_cap_cny !== undefined ? 1 : 0,
          landed_domestic_cap_cny ?? null,
          now,
          formId,
        )
      : this.db.prepare(`
          UPDATE candidate_forms
          SET lifecycle_status = ?,
              sourcing_disposition = CASE WHEN ? = 1 THEN ? ELSE sourcing_disposition END,
              gate1a_result_json = CASE WHEN ? = 1 THEN ? ELSE gate1a_result_json END,
              gate1b_result_json = CASE WHEN ? = 1 THEN ? ELSE gate1b_result_json END,
              negotiation_shortlist_json = CASE WHEN ? = 1 THEN ? ELSE negotiation_shortlist_json END,
              landed_domestic_cap_cny = CASE WHEN ? = 1 THEN ? ELSE landed_domestic_cap_cny END,
              updated_at = ?
          WHERE form_id = ?
        `).run(
          storedStatus,
          effectiveSourcingDisp !== undefined ? 1 : 0,
          effectiveSourcingDisp ?? null,
          gate1a_result !== undefined ? 1 : 0,
          gate1a_result !== undefined ? canonicalJson(gate1a_result) : null,
          gate1b_result !== undefined ? 1 : 0,
          gate1b_result !== undefined ? canonicalJson(gate1b_result) : null,
          negotiation_shortlist !== undefined ? 1 : 0,
          negotiation_shortlist !== undefined ? canonicalJson(negotiation_shortlist) : null,
          landed_domestic_cap_cny !== undefined ? 1 : 0,
          landed_domestic_cap_cny ?? null,
          now,
          formId,
        );
    if (res.changes !== 1) throw new Error(`Form ${formId} not found.`);
    return this.getCandidateForm(formId);
  }

  getCandidateForm(formId) {
    const row = this.db.prepare('SELECT * FROM candidate_forms WHERE form_id = ?').get(formId);
    if (!row) return null;
    const effectiveStatus = row.sourcing_disposition === 'private_mold_reserved'
      ? 'private_mold_reserved'
      : row.lifecycle_status;
    return { ...row, effective_lifecycle_status: effectiveStatus };
  }

  // ---------------------------------------------------------------------------
  // 4. sourcing_quotes_1688 (PII-redacted + component, Shenzhen, readback & order_plan verified)
  // ---------------------------------------------------------------------------

  recordSourcingQuote1688(quote) {
    this._assertWritable();
    if (!quote || typeof quote !== 'object') throw new TypeError('1688 quote object is required.');
    assertNoRawPii(quote, 'sourcing_quote_1688');

    const form = this.getCandidateForm(quote.form_id);
    if (!form) throw new TypeError(`Unknown form_id for 1688 quote: ${quote.form_id}`);
    const composition = JSON.parse(form.saleable_set_composition_json || '{}');
    // Support array-form ([{ component_id, qty_per_saleable_set }]), { components: [...] }, and single-component object ({ component_id, qty_per_saleable_set }).
    const expectedComponents = Array.isArray(composition)
      ? composition
      : (Array.isArray(composition?.components)
        ? composition.components
        : (composition && typeof composition === 'object' && Number.isSafeInteger(composition.qty_per_saleable_set) && composition.qty_per_saleable_set >= 1 && (nonemptyStr(composition.component_id) || nonemptyStr(composition.id))
          ? [composition]
          : null));

    const kitCheck = evaluateSingleFactoryCompleteKit(quote);
    const isCrossFactoryOrBarePart = kitCheck.is_cross_factory_or_incomplete;

    const quoteStatus = quote.quote_status === 'rejected_spec'
      ? 'rejected_spec'
      : (isCrossFactoryOrBarePart ? 'incomplete_cross_factory_kit' : (quote.quote_status ?? 'verified'));
    const kitNote = nonemptyStr(quote.kit_note)
      ? sanitizeDiagnosticText(quote.kit_note.trim())
      : (quoteStatus === 'incomplete_cross_factory_kit'
        ? INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH
        : null);
    const specVariantKey = nonemptyStr(quote.spec_variant_key)
      ? quote.spec_variant_key.trim()
      : null;
    const resolvedFactoryId = kitCheck.resolved_factory_id;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const factoryCandidatesForEmailCheck = [
      resolvedFactoryId,
      quote.factory_id,
      quote.supplier_id,
      quote.seller_member_id,
      ...(Array.isArray(quote.sku_lines) ? quote.sku_lines.flatMap(l => [l?.factory_id, l?.supplier_id, l?.seller_member_id]) : []),
    ];
    if (factoryCandidatesForEmailCheck.some(v => typeof v === 'string' && emailRe.test(v.trim()))) {
      throw new TypeError('sourcing_quote_1688 factory/seller identifier must not contain a raw email address; redact or use a non-PII factory_id before persisting.');
    }
    const isManualOwnerEntry = quote.manual_owner_entry === true;

    const prospectiveIsBareGoods = quote.pricing_basis === 'bare_goods_1688' ||
      quote.bare_goods_screening === true ||
      quote.domestic_freight_cny_total == null;
    const normalizedFactoryKey = resolveVerifiedFactoryKey(quote);
    if (
      !isManualOwnerEntry &&
      quoteStatus === 'verified' &&
      quote.goods_first_order_promotion !== true &&
      (prospectiveIsBareGoods || quote.freight_first_order_promotion !== true) &&
      normalizedFactoryKey
    ) {
      const maxFactoriesCap = BUSINESS_THRESHOLDS.max_1688_factories_to_check;
      const prospectiveQuoteId = nonemptyStr(quote.quote_id) ? quote.quote_id.trim() : null;
      const prospectiveSpecVer = quote.spec_version ?? form.spec_version;
      const existingNonPromo = this.getQuotesForForm(form.form_id).filter(
        eq => eq.spec_version === prospectiveSpecVer &&
          eq.quote_id !== prospectiveQuoteId &&
          eq.goods_first_order_promotion === 0 &&
          (eq.pricing_basis === 'bare_goods_1688' || eq.domestic_freight_cny_total == null || eq.freight_first_order_promotion === 0) &&
          (eq.quote_status === 'verified' || eq.quote_status === 'superseded_uncompetitive'),
      );
      const existingFacs = new Set(existingNonPromo.map(resolveVerifiedFactoryKey).filter(Boolean));
      if (!existingFacs.has(normalizedFactoryKey) && existingFacs.size + 1 > maxFactoriesCap) {
        throw new TypeError(
          `Revision 59 1688 stop rule caps distinct verified factories at ${maxFactoriesCap} per form (would reach ${existingFacs.size + 1} on ${form.form_id}; pass manual_owner_entry: true for owner-entered 4th+ factories).`,
        );
      }
    }

    const contractStatus = quoteStatus === 'verified'
      ? 'verified'
      : (quoteStatus === 'pending' || quoteStatus === 'incomplete_cross_factory_kit' ? 'unknown' : 'rejected');
    // Keep expires_at null unless explicitly supplied (never auto-invent a 30-day expiry date).
    const explicitExpiresAt = quote.expires_at ?? null;
    const verified = validateSourcingVerifier1688Output({
      schema_version: 1,
      contract: 'SourcingVerifier1688',
      stage: quote.stage ?? null,
      allow_default_pack_multiple: quote.allow_default_pack_multiple ?? false,
      require_ui_readback: (isManualOwnerEntry && quoteStatus === 'verified')
        ? true
        : (quote.require_ui_readback ?? false),
      status: contractStatus,
      observed_at: quote.observed_at,
      expires_at: explicitExpiresAt,
      redacted_destination: quote.redacted_destination,
      redacted_screenshot_path: quote.redacted_screenshot_path ?? null,
      redacted_webp_sha256: quote.redacted_webp_sha256 ?? null,
      sensitive_freebie_flags: quote.sensitive_freebie_flags ?? {},
      lead_time_days: quote.lead_time_days ?? null,
      goods_first_order_promotion: quote.goods_first_order_promotion,
      freight_first_order_promotion: quote.freight_first_order_promotion ?? (prospectiveIsBareGoods ? false : quote.freight_first_order_promotion),
      pricing_basis: quote.pricing_basis ?? null,
      bare_goods_screening: quote.bare_goods_screening ?? false,
      domestic_freight_advisory_cny_total: quote.domestic_freight_advisory_cny_total ?? null,
      includes_platform_subsidy_in_freight: quote.includes_platform_subsidy_in_freight ?? false,
      ui_readback: quote.ui_readback ?? undefined,
      sku_lines: quote.sku_lines,
      allow_remainder: quote.allow_remainder ?? false,
      target_sets: quote.target_sets ?? 100,
      actual_sets: quote.actual_sets,
      actual_complete_sets: quote.actual_complete_sets,
      goods_cny_total: quote.goods_cny_total ?? null,
      domestic_freight_cny_total: quote.domestic_freight_cny_total ?? null,
      raw_readback_ref: quote.raw_readback_ref ?? null,
    }, { expected_components: expectedComponents });

    if (quoteStatus === 'verified' && !verified.order_plan) {
      throw new TypeError('Verified 1688 quote requires a valid computed order_plan.');
    }
    const pricingInputs = bindSourcingQuotePricingInputs(quote);
    if (pricingInputs.issue) throw new TypeError(pricingInputs.issue);
    const orderPlan = verified.order_plan ? { ...verified.order_plan } : null;
    if (orderPlan) {
      orderPlan.pricing_basis = verified.pricing_basis ?? (prospectiveIsBareGoods ? 'bare_goods_1688' : 'landed_domestic_explicit');
      if (verified.domestic_freight_advisory_cny_total !== null && verified.domestic_freight_advisory_cny_total !== undefined) {
        orderPlan.domestic_freight_advisory_cny_total = verified.domestic_freight_advisory_cny_total;
      }
      if (isManualOwnerEntry) {
        orderPlan.manual_owner_entry = true;
      }
    }
    const ui = quote.ui_readback;
    if (orderPlan && ui && typeof ui === 'object') {
      const normalizedUi = {
        logged_in: ui.logged_in === true,
        viewport_width_px: Number.isFinite(Number(ui.viewport_width_px)) ? Number(ui.viewport_width_px) : null,
        selected_sku_row_visible: ui.selected_sku_row_visible === true,
        settlement_bar_visible: ui.settlement_bar_visible === true,
        applied_quantity_confirmed: Boolean(ui.applied_quantity_confirmed === true || ui.applied_qty_confirmed === true),
      };
      orderPlan.ui_readback = normalizedUi;
      orderPlan.ui_readback_verified = isVerifiedFiveFieldUiReadback(normalizedUi);
    }
    const skuLines = Array.isArray(verified.normalized_sku_lines)
      ? verified.normalized_sku_lines
      : (Array.isArray(quote.sku_lines) ? quote.sku_lines : []);
    const packMultiple = quote.pack_multiple ?? (skuLines.length > 0 ? Math.max(...skuLines.map(l => l.pack_multiple ?? 1)) : 1);
    const moqSets = quote.moq_sets ?? (skuLines.length > 0
      ? Math.max(100, ...skuLines.map(l => Math.ceil((l.moq_qty ?? 1) / l.qty_per_saleable_set)))
      : 100);
    const actualSets = orderPlan ? orderPlan.allocated_sets : (quote.actual_sets ?? 100);
    const actualCompleteSets = orderPlan ? orderPlan.actual_complete_sets : (quote.actual_complete_sets ?? 100);
    const quoteId = nonemptyStr(quote.quote_id) ? quote.quote_id.trim() : randomUUID();
    const specVersion = quote.spec_version ?? form.spec_version;
    const now = this._now();

    this.db.prepare(`
      INSERT INTO sourcing_quotes_1688 (
        quote_id, form_id, spec_version, sku_lines_json, order_plan_json, pack_multiple, moq_sets,
        actual_sets, actual_complete_sets, goods_cny_total, domestic_freight_cny_total, pkg_json, fx_cny_per_usd,
        factory_id, spec_variant_key, kit_note,
        goods_first_order_promotion, freight_first_order_promotion, lead_time_days,
        sensitive_freebie_flags_json, redacted_destination, redacted_screenshot_path,
        redacted_webp_sha256, raw_readback_ref, observed_at, expires_at, quote_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      quoteId,
      form.form_id,
      specVersion,
      canonicalJson(skuLines),
      orderPlan ? canonicalJson(orderPlan) : null,
      packMultiple,
      moqSets,
      actualSets,
      actualCompleteSets,
      quote.goods_cny_total ?? null,
      quote.domestic_freight_cny_total ?? null,
      pricingInputs.pkg ? canonicalJson(pricingInputs.pkg) : null,
      pricingInputs.fx_cny_per_usd ?? null,
      resolvedFactoryId,
      specVariantKey,
      kitNote,
      verified.goods_first_order_promotion ? 1 : 0,
      verified.freight_first_order_promotion ? 1 : 0,
      quote.lead_time_days ?? null,
      canonicalJson(verified.sensitive_freebie_flags),
      verified.redacted_destination,
      quote.redacted_screenshot_path ?? null,
      quote.redacted_webp_sha256 ?? null,
      quote.raw_readback_ref ?? null,
      quote.observed_at,
      explicitExpiresAt,
      quoteStatus,
      now,
    );

    // 1688 "先贵后便宜" same-spec archival: when a cheaper verified complete-kit quote is found for the same
    // explicit spec_variant_key (or supersede_same_spec: true), archive earlier strictly more expensive same-spec quotes
    // as 'superseded_uncompetitive' so they remain auditable without locking Gate 1B into crosses_30pct.
    const shouldAutoSupersedeSameSpec = Boolean(
      quoteStatus === 'verified' &&
      quote.keep_parallel_spec !== true &&
      (specVariantKey !== null || quote.supersede_same_spec === true || quote.supersede_expensive_same_spec === true),
    );
    if (shouldAutoSupersedeSameSpec) {
      // ADR-0002: Rank same-spec quotes strictly by regular bare-goods unit price (`裸货价`), never domestic freight.
      const newUnitBareGoodsCny = (quote.goods_cny_total ?? 0) / actualSets;
      if (Number.isFinite(newUnitBareGoodsCny) && newUnitBareGoodsCny > 0) {
        const refDay = typeof quote.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(quote.observed_at)
          ? quote.observed_at.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
        const existingVerified = this.db.prepare(`
          SELECT quote_id, actual_sets, goods_cny_total, domestic_freight_cny_total, spec_variant_key, expires_at
          FROM sourcing_quotes_1688
          WHERE form_id = ? AND spec_version = ? AND quote_status = 'verified' AND quote_id != ?
        `).all(form.form_id, specVersion, quoteId);
        for (const prev of existingVerified) {
          if (prev.expires_at && String(prev.expires_at).slice(0, 10) < refDay) continue;
          const prevSpecKey = prev.spec_variant_key ?? null;
          if (specVariantKey !== null && prevSpecKey !== null && prevSpecKey !== specVariantKey) continue;
          if (specVariantKey !== null && prevSpecKey === null && quote.supersede_same_spec !== true) continue;
          const prevUnitBareGoods = (prev.goods_cny_total ?? 0) / Math.max(1, prev.actual_sets || 100);
          if (prevUnitBareGoods > newUnitBareGoodsCny + 1e-6) {
            this.db.prepare(`
              UPDATE sourcing_quotes_1688
              SET quote_status = 'superseded_uncompetitive'
              WHERE quote_id = ?
            `).run(prev.quote_id);
          } else if ((quote.supersede_same_spec === true || quote.supersede_expensive_same_spec === true || specVariantKey !== null) && newUnitBareGoodsCny > prevUnitBareGoods + 1e-6) {
            this.db.prepare(`
              UPDATE sourcing_quotes_1688
              SET quote_status = 'superseded_uncompetitive'
              WHERE quote_id = ?
            `).run(quoteId);
          }
        }
      }
    }

    return {
      quote: this.getQuoteById(quoteId),
      order_plan: orderPlan,
    };
  }

  supersedeUncompetitiveQuotesForForm(formId, { spec_version = null, spec_variant_key = undefined } = {}) {
    this._assertWritable();
    return this._rerankSameSpecBareGoodsLocked(formId, { spec_version, spec_variant_key });
  }

  recordSourcingQuotesBatch1688(quotes) {
    this._assertWritable();
    if (!Array.isArray(quotes) || quotes.length === 0) {
      throw new TypeError('quotes must be a nonempty array.');
    }
    const maxFactoriesCap = BUSINESS_THRESHOLDS.max_1688_factories_to_check;
    const isAiAutoCompleteKitQuote = qObj => {
      if (!qObj || typeof qObj !== 'object') return false;
      if (qObj.manual_owner_entry === true) return false;
      const kit = evaluateSingleFactoryCompleteKit(qObj);
      if (kit.is_cross_factory_or_incomplete) return false;
      const st = qObj.quote_status ?? 'verified';
      if (st !== 'verified') return false;
      const bare = qObj.pricing_basis === 'bare_goods_1688' || qObj.bare_goods_screening === true || qObj.domestic_freight_cny_total == null;
      return qObj.goods_first_order_promotion !== true && (bare || qObj.freight_first_order_promotion !== true);
    };
    const aiAutoQuotes = quotes.filter(isAiAutoCompleteKitQuote);
    return this._withImmediateTx(() => {
      const stateByFormSpec = new Map();
      for (const qObj of aiAutoQuotes) {
        if (!nonemptyStr(qObj.form_id)) continue;
        const fId = qObj.form_id.trim();
        const formRow = this.getCandidateForm(fId);
        const sVer = Number.isInteger(qObj.spec_version) ? qObj.spec_version : (formRow?.spec_version ?? 1);
        const mapKey = `${fId}::${sVer}`;
        let state = stateByFormSpec.get(mapKey);
        if (!state) {
          const existing = this.getQuotesForForm(fId).filter(
            eq => eq.spec_version === sVer &&
              eq.goods_first_order_promotion === 0 &&
              (eq.pricing_basis === 'bare_goods_1688' || eq.domestic_freight_cny_total == null || eq.freight_first_order_promotion === 0) &&
              (eq.quote_status === 'verified' || eq.quote_status === 'superseded_uncompetitive'),
          );
          state = {
            existingFacs: new Set(existing.map(resolveVerifiedFactoryKey).filter(Boolean)),
            addedFacs: new Set(),
            unattributedCount: 0,
          };
          stateByFormSpec.set(mapKey, state);
        }
        const fk = resolveVerifiedFactoryKey(qObj);
        if (fk) {
          if (!state.existingFacs.has(fk)) state.addedFacs.add(fk);
        } else {
          state.unattributedCount += 1;
        }
        if (state.unattributedCount > maxFactoriesCap) {
          throw new TypeError(
            `Revision 59 1688 stop rule caps unattributed automated quotes at ${maxFactoriesCap} per form batch (received ${state.unattributedCount} on ${fId}; supply factory_id or pass manual_owner_entry: true for owner-entered 4th+ factories).`,
          );
        }
        if (state.addedFacs.size > 0 && state.existingFacs.size + state.addedFacs.size > maxFactoriesCap) {
          throw new TypeError(
            `Revision 59 1688 stop rule caps distinct verified factories at ${maxFactoriesCap} per form (would reach ${state.existingFacs.size + state.addedFacs.size} on ${fId}; pass manual_owner_entry: true for owner-entered 4th+ factories).`,
          );
        }
      }
      const prevOuter = this._inOuterTx;
      this._inOuterTx = true;
      try {
        return quotes.map(q => this.recordSourcingQuote1688(q));
      } finally {
        this._inOuterTx = prevOuter;
      }
    });
  }

  getQuotesForForm(formId) {
    return this.db.prepare('SELECT * FROM sourcing_quotes_1688 WHERE form_id = ? ORDER BY created_at DESC').all(formId).map(sourcingQuoteFromRow);
  }

  getQuoteById(quoteId) {
    if (!nonemptyStr(quoteId)) return null;
    const row = this.db.prepare('SELECT * FROM sourcing_quotes_1688 WHERE quote_id = ?').get(quoteId.trim());
    return row ? sourcingQuoteFromRow(row) : null;
  }

  // ---------------------------------------------------------------------------
  // 5. evaluations (immutable per (form_id, period_id, profile_revision, evidence_bundle_sha256))
  // ---------------------------------------------------------------------------

  recordEvaluation(ev) {
    this._assertWritable();
    if (!ev || typeof ev !== 'object') throw new TypeError('Evaluation object is required.');
    const form = this.getCandidateForm(ev.form_id);
    if (!form) throw new TypeError(`Unknown form_id for evaluation: ${ev.form_id}`);
    const periodId = nonemptyStr(ev.period_id) ? ev.period_id.trim() : null;
    if (!periodId) throw new TypeError('evaluation.period_id must be a nonempty string.');
    if (!Number.isInteger(ev.profile_revision) || ev.profile_revision < 50) {
      throw new TypeError('evaluation.profile_revision must be an integer >= 50.');
    }
    if (!HEX_SHA256_RE.test(ev.evidence_bundle_sha256)) {
      throw new TypeError('evaluation.evidence_bundle_sha256 must be a 64-char lowercase hex SHA-256.');
    }
    if (!HEX_SHA256_RE.test(ev.result_sha256)) {
      throw new TypeError('evaluation.result_sha256 must be a 64-char lowercase hex SHA-256.');
    }
    if (ev.html_sha256 !== undefined && ev.html_sha256 !== null && !HEX_SHA256_RE.test(ev.html_sha256)) {
      throw new TypeError('evaluation.html_sha256 must be a 64-char lowercase hex SHA-256 when provided.');
    }
    if (!finite(ev.covered_weight) || ev.covered_weight < 0) {
      throw new TypeError('evaluation.covered_weight must be a nonnegative finite number.');
    }

    const evaluationId = nonemptyStr(ev.evaluation_id) ? ev.evaluation_id.trim() : randomUUID();
    const now = this._now();

    const performInsert = () => {
      const existing = this.db.prepare(`
        SELECT * FROM evaluations
        WHERE form_id = ? AND period_id = ? AND profile_revision = ? AND evidence_bundle_sha256 = ?
      `).get(form.form_id, periodId, ev.profile_revision, ev.evidence_bundle_sha256);

      const sanitizeReviewNotes = notes => {
        if (!Array.isArray(notes) || notes.length === 0) return null;
        return notes.map(n => {
          if (typeof n === 'string') return { kind: 'CALIBRATION_NOTE', note: sanitizeDiagnosticText(n) };
          if (n && typeof n === 'object') {
            assertNoRawPii(n, 'evaluation.review_note');
            return {
              kind: nonemptyStr(n.kind) ? n.kind.trim() : 'CALIBRATION_NOTE',
              reviewer: nonemptyStr(n.reviewer) ? n.reviewer.trim() : null,
              observed_at: nonemptyStr(n.observed_at) ? n.observed_at.trim() : null,
              note: sanitizeDiagnosticText(String(n.note ?? n.message ?? '')),
            };
          }
          return null;
        }).filter(Boolean);
      };
      const incomingNotes = sanitizeReviewNotes(ev.review_notes);
      let incomingEvidenceReviewJson = null;
      if (ev.evidence_review !== undefined && ev.evidence_review !== null) {
        if (typeof ev.evidence_review !== 'object' || Array.isArray(ev.evidence_review)) {
          throw new TypeError('evaluation.evidence_review must be a JSON object when provided.');
        }
        assertNoRawPii(ev.evidence_review, 'evaluation.evidence_review');
        if (containsSecretToken(ev.evidence_review)) {
          throw new TypeError('evaluation.evidence_review contains a credential or token; redact before persisting.');
        }
        incomingEvidenceReviewJson = canonicalJson(ev.evidence_review);
      }

      if (existing) {
        if (existing.result_sha256 !== ev.result_sha256) {
          throw new Error(
            `Evaluation immutability violation for (${form.form_id}, ${periodId}, r${ev.profile_revision}, ${ev.evidence_bundle_sha256.slice(0, 12)}): ` +
            'cannot overwrite existing evaluation with a different result hash; update fee/evidence bundle to create a new version.',
          );
        }
        // Append newly discovered source_attempt_ids, batch_receipts, review_notes, and advisory evidence_review without mutating the immutable evaluation score/result!
        const prevAttempts = JSON.parse(existing.source_attempt_ids_json || '[]');
        const mergedAttempts = [...new Set([...prevAttempts, ...(ev.source_attempt_ids ?? [])])].sort();
        const prevReceipt = JSON.parse(existing.receipt_json || '{}');
        const batchReceipts = Array.isArray(prevReceipt.batch_receipts) ? [...prevReceipt.batch_receipts] : [];
        if (prevReceipt.batch_result_sha256 && batchReceipts.length === 0) {
          batchReceipts.push({
            batch_result_sha256: prevReceipt.batch_result_sha256,
            batch_html_sha256: prevReceipt.batch_html_sha256 ?? existing.html_sha256 ?? null,
            evidence_review_json: existing.evidence_review_json ?? null,
          });
        }
        const incomingBatchSha = ev.receipt?.batch_result_sha256 ?? null;
        const incomingHtmlSha = ev.receipt?.batch_html_sha256 ?? ev.html_sha256 ?? null;
        let receiptChanged = false;
        if (
          incomingBatchSha &&
          !batchReceipts.some(
            b =>
              b.batch_result_sha256 === incomingBatchSha &&
              b.batch_html_sha256 === incomingHtmlSha &&
              (b.evidence_review_json ?? null) === (incomingEvidenceReviewJson ?? null),
          )
        ) {
          batchReceipts.push({
            batch_result_sha256: incomingBatchSha,
            batch_html_sha256: incomingHtmlSha,
            evidence_review_json: incomingEvidenceReviewJson ?? null,
          });
          receiptChanged = true;
        }
        const prevNotes = existing.review_notes_json ? JSON.parse(existing.review_notes_json) : [];
        const seenNoteKeys = new Set(prevNotes.map(n => canonicalJson(n)));
        const mergedNotes = [...prevNotes];
        let notesChanged = false;
        for (const n of incomingNotes ?? []) {
          const key = canonicalJson(n);
          if (!seenNoteKeys.has(key)) {
            seenNoteKeys.add(key);
            mergedNotes.push(n);
            notesChanged = true;
          }
        }
        // Pair evidence_review_json and html_sha256 atomically so an unreviewed rerun never overwrites
        // html_sha256 while leaving an older evidence_review_json active (or vice versa).
        let nextEvidenceReviewJson = existing.evidence_review_json ?? null;
        let nextHtmlSha = existing.html_sha256 ?? null;
        if (incomingEvidenceReviewJson !== null) {
          nextEvidenceReviewJson = incomingEvidenceReviewJson;
          nextHtmlSha = ev.html_sha256 ?? existing.html_sha256 ?? null;
        } else if (!existing.evidence_review_json) {
          nextEvidenceReviewJson = null;
          nextHtmlSha = ev.html_sha256 ?? existing.html_sha256 ?? null;
        }
        const evidenceReviewChanged = nextEvidenceReviewJson !== (existing.evidence_review_json ?? null);
        const htmlShaChanged = nextHtmlSha !== (existing.html_sha256 ?? null);
        const attemptsChanged = mergedAttempts.length !== prevAttempts.length;
        if (attemptsChanged || receiptChanged || notesChanged || evidenceReviewChanged || htmlShaChanged) {
          const nextReceipt = {
            ...prevReceipt,
            batch_html_sha256: nextHtmlSha ?? prevReceipt.batch_html_sha256 ?? null,
            batch_receipts: batchReceipts,
          };
          this.db.prepare(`
            UPDATE evaluations
            SET source_attempt_ids_json = ?, receipt_json = ?, review_notes_json = ?, evidence_review_json = ?, html_sha256 = ?
            WHERE evaluation_id = ?
          `).run(
            canonicalJson(mergedAttempts),
            canonicalJson(nextReceipt),
            mergedNotes.length ? canonicalJson(mergedNotes) : null,
            nextEvidenceReviewJson,
            nextHtmlSha,
            existing.evaluation_id,
          );
        }
        const updated = this.db.prepare('SELECT * FROM evaluations WHERE evaluation_id = ?').get(existing.evaluation_id);
        return { inserted: false, identical: true, evaluation: { ...updated } };
      }

      const initialReceipt = {
        form_spec_sha256: form.spec_sha256,
        spec_version: form.spec_version,
        ...(ev.receipt ?? {}),
      };
      if (initialReceipt.batch_result_sha256) {
        initialReceipt.batch_receipts = [{
          batch_result_sha256: initialReceipt.batch_result_sha256,
          batch_html_sha256: initialReceipt.batch_html_sha256 ?? ev.html_sha256 ?? null,
          evidence_review_json: incomingEvidenceReviewJson ?? null,
        }];
      }

      this.db.prepare(`
        INSERT INTO evaluations (
          evaluation_id, form_id, period_id, profile_revision, evidence_bundle_sha256,
          qualification_json, sort_keys_json, queue_bucket, covered_weight,
          supported_range_json, total_range_json, result_sha256, html_sha256,
          receipt_json, source_attempt_ids_json, review_notes_json, evidence_review_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evaluationId,
        form.form_id,
        periodId,
        ev.profile_revision,
        ev.evidence_bundle_sha256,
        canonicalJson(ev.qualification),
        canonicalJson(ev.sort_keys ?? {}),
        ev.queue_bucket,
        ev.covered_weight,
        canonicalJson(ev.supported_range),
        ev.total_range === undefined || ev.total_range === null ? null : canonicalJson(ev.total_range),
        ev.result_sha256,
        ev.html_sha256 ?? null,
        canonicalJson(initialReceipt),
        canonicalJson([...new Set(ev.source_attempt_ids ?? [])].sort()),
        incomingNotes ? canonicalJson(incomingNotes) : null,
        incomingEvidenceReviewJson,
        now,
      );

      return {
        inserted: true,
        identical: false,
        evaluation: { ...this.db.prepare('SELECT * FROM evaluations WHERE evaluation_id = ?').get(evaluationId) },
      };
    };

    if (this._inOuterTx) return performInsert();
    return this._withImmediateTx(performInsert);
  }

  runInTransaction(fn) {
    this._assertWritable();
    if (this._inOuterTx) return fn();
    return this._withImmediateTx(() => {
      this._inOuterTx = true;
      try { return fn(); }
      finally { this._inOuterTx = false; }
    });
  }

  getEvaluationsForForm(formId) {
    return this.db.prepare('SELECT * FROM evaluations WHERE form_id = ? ORDER BY created_at ASC').all(formId).map(r => ({ ...r }));
  }

  appendEvaluationReviewNotes(evaluationId, notes) {
    this._assertWritable();
    if (!Array.isArray(notes) || notes.length === 0) throw new TypeError('notes must be a nonempty array.');
    const existing = this.db.prepare('SELECT * FROM evaluations WHERE evaluation_id = ?').get(evaluationId);
    if (!existing) throw new Error(`Evaluation ${evaluationId} not found.`);
    const clean = notes.map(n => {
      if (typeof n === 'string') return { kind: 'CALIBRATION_NOTE', note: sanitizeDiagnosticText(n) };
      assertNoRawPii(n, 'evaluation.review_note');
      return {
        kind: nonemptyStr(n.kind) ? n.kind.trim() : 'CALIBRATION_NOTE',
        reviewer: nonemptyStr(n.reviewer) ? n.reviewer.trim() : null,
        observed_at: nonemptyStr(n.observed_at) ? n.observed_at.trim() : this._now().slice(0, 10),
        note: sanitizeDiagnosticText(String(n.note ?? n.message ?? '')),
      };
    });
    const prev = existing.review_notes_json ? JSON.parse(existing.review_notes_json) : [];
    const seen = new Set(prev.map(n => canonicalJson(n)));
    const merged = [...prev];
    for (const n of clean) {
      const key = canonicalJson(n);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(n);
      }
    }
    this.db.prepare('UPDATE evaluations SET review_notes_json = ? WHERE evaluation_id = ?')
      .run(canonicalJson(merged), evaluationId);
    return { ...this.db.prepare('SELECT * FROM evaluations WHERE evaluation_id = ?').get(evaluationId) };
  }

  // ---------------------------------------------------------------------------
  // Persistent queue state + strictly exclusive per-task serial 1688 lease + verified CAPTCHA resume
  // ---------------------------------------------------------------------------

  getQueueState(queueName = 'gate1b_1688_queue') {
    const row = this.db.prepare('SELECT * FROM queue_state WHERE queue_name = ?').get(queueName);
    return row ? { ...row } : null;
  }

  /**
   * Acquire a strictly exclusive per-task serial lease (rejects ANY active holder even with the
   * same caller label, preventing concurrent 1688 browsing under shared owner labels).
   */
  acquireQueueLease(queueName, ownerLabel = 'gate1b') {
    this._assertWritable();
    if (!nonemptyStr(ownerLabel)) throw new TypeError('ownerLabel must be a nonempty string.');
    const uniqueToken = `${ownerLabel.trim()}:${randomUUID()}`;
    const now = this._now();
    return this._withImmediateTx(() => {
      const q = this.db.prepare('SELECT * FROM queue_state WHERE queue_name = ?').get(queueName);
      if (!q) throw new Error(`Queue ${queueName} not found.`);
      if (q.status === 'CAPTCHA_PAUSED') {
        return { acquired: false, reason: 'CAPTCHA_PAUSED', queue_state: { ...q } };
      }
      if (q.active_lease_owner) {
        return { acquired: false, reason: 'busy_serial_lease_held', holder: q.active_lease_owner, queue_state: { ...q } };
      }
      this.db.prepare(`
        UPDATE queue_state
        SET active_lease_owner = ?, active_lease_at = ?, updated_at = ?
        WHERE queue_name = ?
      `).run(uniqueToken, now, now, queueName);
      return { acquired: true, owner: uniqueToken, lease_token: uniqueToken, queue_state: this.getQueueState(queueName) };
    });
  }

  releaseQueueLease(queueName, leaseToken) {
    this._assertWritable();
    const now = this._now();
    this.db.prepare(`
      UPDATE queue_state
      SET active_lease_owner = NULL, active_lease_at = NULL, updated_at = ?
      WHERE queue_name = ? AND active_lease_owner = ?
    `).run(now, queueName, leaseToken);
  }

  pauseQueue(queueName, reason, {
    paused_form_id = null,
    paused_sku_hint = null,
    paused_destination_hint = '深圳',
    paused_min_qty = 100,
  } = {}) {
    this._assertWritable();
    if (!nonemptyStr(reason)) throw new TypeError('A nonempty pause reason is required.');
    const now = this._now();
    this.db.prepare(`
      INSERT INTO queue_state (
        queue_name, status, pause_reason, paused_form_id, paused_sku_hint,
        paused_destination_hint, paused_min_qty,
        paused_at, resumed_at, resume_verification_json, active_lease_owner, active_lease_at, updated_at
      ) VALUES (?, 'CAPTCHA_PAUSED', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)
      ON CONFLICT(queue_name) DO UPDATE SET
        status = 'CAPTCHA_PAUSED',
        pause_reason = excluded.pause_reason,
        paused_form_id = excluded.paused_form_id,
        paused_sku_hint = excluded.paused_sku_hint,
        paused_destination_hint = excluded.paused_destination_hint,
        paused_min_qty = excluded.paused_min_qty,
        paused_at = excluded.paused_at,
        resumed_at = NULL,
        resume_verification_json = NULL,
        active_lease_owner = NULL,
        active_lease_at = NULL,
        updated_at = excluded.updated_at
    `).run(
      queueName,
      sanitizeDiagnosticText(reason.trim()),
      paused_form_id,
      paused_sku_hint ? sanitizeDiagnosticText(String(paused_sku_hint).trim()) : null,
      paused_destination_hint,
      Number.isInteger(paused_min_qty) && paused_min_qty >= 100 ? paused_min_qty : 100,
      now,
      now,
    );
    return this.getQueueState(queueName);
  }

  /**
   * Resume a CAPTCHA_PAUSED queue only after full post-CAPTCHA verification:
   *  - login_verified === true
   *  - Shenzhen province/city destination (zero PII)
   *  - integer quantity >= paused_min_qty (>= 100)
   *  - form_id matching paused_form_id (when recorded)
   *  - sku_id matching paused_sku_hint OR known component/SKU of the paused form (when known)
   *  - non-expired quote_validity >= as_of_date
   */
  resumeQueue(queueName, verification, { as_of_date = this._now().slice(0, 10) } = {}) {
    this._assertWritable();
    if (!verification || typeof verification !== 'object') {
      throw new TypeError('Resume verification object is required before resuming a CAPTCHA_PAUSED queue.');
    }
    if (verification.login_verified !== true) {
      throw new TypeError('verification.login_verified must be true before resuming 1688 queue.');
    }
    const destinationCity = validateRedactedDestination(verification.destination_city, 'verification.destination_city', {
      requireShenzhen: true,
    });
    const current = this.getQueueState(queueName);
    const minQty = current?.paused_min_qty && current.paused_min_qty >= 100 ? current.paused_min_qty : 100;
    if (!Number.isInteger(verification.quantity) || verification.quantity < minQty) {
      throw new TypeError(`verification.quantity must be an integer >= ${minQty}.`);
    }
    if (!nonemptyStr(verification.sku_id)) {
      throw new TypeError('verification.sku_id must be a nonempty string.');
    }
    if (verification.quote_validity !== null && verification.quote_validity !== undefined) {
      if (!validEvidenceDate(verification.quote_validity)) {
        throw new TypeError('verification.quote_validity must be a valid ISO date or timestamp when provided.');
      }
      const asOfDay = assertIsoDateOnly(as_of_date, 'as_of_date');
      if (verification.quote_validity.slice(0, 10) < asOfDay) {
        throw new TypeError(`verification.quote_validity (${verification.quote_validity}) is expired relative to ${asOfDay}.`);
      }
    }
    assertNoRawPii(verification, 'resume_verification');

    if (current?.paused_form_id) {
      if (!nonemptyStr(verification.form_id) || verification.form_id.trim() !== current.paused_form_id) {
        throw new TypeError(
          `Resume verification must confirm paused_form_id (${current.paused_form_id}); got ${verification.form_id ?? 'none'}.`,
        );
      }
      const skuTrim = verification.sku_id.trim();
      if (current.paused_sku_hint && skuTrim !== current.paused_sku_hint) {
        throw new TypeError(
          `Resume verification sku_id (${skuTrim}) does not match paused task SKU (${current.paused_sku_hint}).`,
        );
      }
      if (!current.paused_sku_hint) {
        // When no explicit sku_hint was attached at pause time, validate against known form SKUs/components if present.
        const form = this.getCandidateForm(current.paused_form_id);
        if (form) {
          const comp = JSON.parse(form.saleable_set_composition_json || '{}');
          const compList = Array.isArray(comp) ? comp : (Array.isArray(comp?.components) ? comp.components : []);
          const allowedSkus = new Set();
          if (comp && !Array.isArray(comp)) {
            if (nonemptyStr(comp.sku_id)) allowedSkus.add(comp.sku_id.trim());
            if (nonemptyStr(comp.component_id)) allowedSkus.add(comp.component_id.trim());
          }
          for (const c of compList) {
            if (nonemptyStr(c?.sku_id)) allowedSkus.add(c.sku_id.trim());
            if (nonemptyStr(c?.component_id)) allowedSkus.add(c.component_id.trim());
          }
          for (const q of this.getQuotesForForm(current.paused_form_id)) {
            if (q.spec_version !== form.spec_version) continue;
            for (const line of JSON.parse(q.sku_lines_json || '[]')) {
              if (nonemptyStr(line?.sku_id)) allowedSkus.add(line.sku_id.trim());
            }
          }
          if (allowedSkus.size > 0 && !allowedSkus.has(skuTrim)) {
            throw new TypeError(
              `Resume verification sku_id (${skuTrim}) does not match known SKUs/components for paused form ${current.paused_form_id}.`,
            );
          }
        }
      }
    }

    const cleanVerification = {
      login_verified: true,
      form_id: verification.form_id ? verification.form_id.trim() : (current?.paused_form_id ?? null),
      destination_city: destinationCity,
      quantity: verification.quantity,
      sku_id: verification.sku_id.trim(),
      quote_validity: verification.quote_validity ?? null,
    };
    const now = this._now();
    this.db.prepare(`
      INSERT INTO queue_state (
        queue_name, status, pause_reason, paused_form_id, paused_sku_hint,
        paused_destination_hint, paused_min_qty,
        paused_at, resumed_at, resume_verification_json, updated_at
      ) VALUES (?, 'active', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(queue_name) DO UPDATE SET
        status = 'active',
        pause_reason = NULL,
        paused_form_id = NULL,
        paused_sku_hint = NULL,
        paused_destination_hint = NULL,
        paused_min_qty = NULL,
        resumed_at = excluded.resumed_at,
        resume_verification_json = excluded.resume_verification_json,
        updated_at = excluded.updated_at
    `).run(queueName, now, canonicalJson(cleanVerification), now);
    return this.getQueueState(queueName);
  }

  // ---------------------------------------------------------------------------
  // End-to-end lineage & health summary
  // ---------------------------------------------------------------------------

  traceFormLineage(formId) {
    const form = this.getCandidateForm(formId);
    if (!form) return null;
    const leads = this.getLeadsForForm(formId);
    const quotes = this.getQuotesForForm(formId);
    const evaluations = this.getEvaluationsForForm(formId);
    const attemptIds = new Set(leads.map(l => l.source_attempt_id).filter(Boolean));
    const collectSharedAttemptRefs = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 4) return;
      if (Array.isArray(obj)) {
        for (const it of obj) collectSharedAttemptRefs(it, depth + 1);
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if ((k === 'attempt_id' || k === 'source_attempt_id') && nonemptyStr(v)) {
          attemptIds.add(v.trim());
        } else if ((k === 'source_attempt_ids' || k === 'shared_attempt_ids' || k === 'attempt_ids') && Array.isArray(v)) {
          for (const id of v) if (nonemptyStr(id)) attemptIds.add(id.trim());
        } else if (v && typeof v === 'object') {
          collectSharedAttemptRefs(v, depth + 1);
        }
      }
    };
    for (const l of leads) {
      try { collectSharedAttemptRefs(JSON.parse(l.metadata_json || '{}')); } catch { /* ignore */ }
    }
    const gate1aResult = form.gate1a_result_json ? JSON.parse(form.gate1a_result_json) : null;
    const gate1bResult = form.gate1b_result_json ? JSON.parse(form.gate1b_result_json) : null;
    collectSharedAttemptRefs(gate1aResult);
    collectSharedAttemptRefs(gate1bResult);
    for (const q of quotes) {
      if (nonemptyStr(q.raw_readback_ref)) attemptIds.add(q.raw_readback_ref.trim());
    }
    for (const ev of evaluations) {
      for (const id of JSON.parse(ev.source_attempt_ids_json || '[]')) attemptIds.add(id);
    }
    const formAttempts = this.db.prepare(`
      SELECT * FROM api_request_ledger
      WHERE form_id = ?
      ORDER BY created_at ASC
    `).all(formId).map(r => ({ ...r }));
    for (const a of formAttempts) attemptIds.add(a.attempt_id);

    const attempts = [];
    for (const id of attemptIds) {
      const a = this.getAttempt(id);
      if (a) attempts.push(a);
    }
    attempts.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.attempt_id.localeCompare(b.attempt_id));

    return {
      form,
      gate1a_result: gate1aResult,
      gate1b_result: gate1bResult,
      negotiation_shortlist: form.negotiation_shortlist_json ? JSON.parse(form.negotiation_shortlist_json) : null,
      primary_discovery_leads: leads.filter(l => l.link_role === 'primary_discovery'),
      corroboration_leads: leads.filter(l => l.link_role === 'corroboration'),
      station_verification_leads: leads.filter(l => l.link_role === 'station_verification'),
      sourcing_quotes_1688: quotes,
      evaluations,
      ledger_attempts: attempts,
    };
  }

  /**
   * Export full keyword and non-keyword provenance directly from SQLite raw_leads + lead_form_links
   * for attaching to card reports (Reddit/Pinterest/X/Etsy/YouTube/1688/supply-gap/Trends/keywords).
   */
  exportFormDiscoveryProvenance(formId) {
    const form = this.getCandidateForm(formId);
    if (!form) return null;
    const leads = this.getLeadsForForm(formId);
    const leadCols = this._tableColumns('raw_leads');
    return {
      form_id: form.form_id,
      label: form.label,
      description: form.buyer_task,
      promotion_track: form.promotion_track ?? null,
      cooldown_until: form.cooldown_until ?? null,
      store_leads: leads.map(l => {
        const meta = resolveChannelMeta(l.source_channel, leadCols.has('route') ? l.route : null, l.entry_group);
        return {
          lead_id: l.lead_id,
          phrase_or_title: l.phrase_or_title,
          source_channel: l.source_channel,
          channel_id: l.source_channel === 'sif_keyword_opportunity' ? 'sif_keyword_opportunity' : meta.channel_id,
          route: meta.route,
          entry_group: meta.entry_group,
          non_keyword_origin: meta.non_keyword_origin,
          opportunity_type: leadCols.has('opportunity_type') ? (l.opportunity_type ?? 'unclassified') : 'unclassified',
          promotion_track: leadCols.has('promotion_track') ? (l.promotion_track ?? null) : null,
          link_role: l.link_role,
          source_ref: l.source_ref,
          raw_excerpt: l.raw_excerpt ?? null,
          observed_at: l.observed_at,
          disposition: l.disposition,
          disposition_reason: l.disposition_reason ?? null,
          source_attempt_id: l.source_attempt_id ?? null,
        };
      }),
    };
  }

  _sanitizeDbPath(rawPath) {
    if (!rawPath || rawPath === ':memory:') return ':memory:';
    const cwd = resolve(process.cwd());
    if (isAbsolute(rawPath)) {
      const rel = relative(cwd, resolve(rawPath)).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
      return sanitizeDiagnosticText(rawPath);
    }
    return sanitizeDiagnosticText(rawPath.replace(/\\/g, '/'));
  }

  _hasTable(tableName) {
    return Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
    );
  }

  _deserializeCalibrationRow(row) {
    if (!row) return null;
    const parseOpt = s => {
      if (!s) return null;
      try { return JSON.parse(s); } catch { return null; }
    };
    return {
      tracking_id: row.tracking_id,
      form_id: row.form_id,
      spec_version: row.spec_version,
      form_spec_sha256: row.form_spec_sha256 ?? null,
      batch_id: row.batch_id ?? null,
      system_verdict: row.system_verdict,
      core_85_range: parseOpt(row.core_85_range_json),
      supported_range: parseOpt(row.supported_range_json),
      pre_ad_margin_range: parseOpt(row.pre_ad_margin_range_json),
      owner_decision: row.owner_decision ?? null,
      owner_reason: row.owner_reason ?? null,
      sample_measured_pkg: parseOpt(row.sample_measured_pkg_json),
      recalculated_margin: parseOpt(row.recalculated_margin_json),
      calibration_note: row.calibration_note ?? null,
      near_miss_spot_check: parseOpt(row.near_miss_spot_check_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Persist or update the 4 owner calibration tracking items per candidate form:
   *  1) system_verdict (+ core_85_range, supported_range, pre_ad_margin_range, form_spec_sha256)
   *  2) owner_decision ('keep' | 'drop' | 'sample_check' | 'hold' | 'pending_owner_review') + owner_reason
   *  3) sample_measured_pkg + recalculated_margin
   *  4) batch_id + calibration_note + near_miss_spot_check (soft-hold / near-miss & Terra-vs-Astra Keepa audit)
   */
  upsertCalibrationTracking(record) {
    this._assertWritable();
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError('Calibration tracking record object is required.');
    }
    if (containsSecretToken(record)) {
      throw new TypeError('Calibration tracking record contains a secret or token; redact before persisting.');
    }
    assertNoRawPii(record, 'calibration_tracking');

    const formId = nonemptyStr(record.form_id) ? record.form_id.trim() : null;
    if (!formId) throw new TypeError('calibration_tracking requires a nonempty form_id.');
    const existingForm = this.getCandidateForm(formId);
    const specVersion = Number.isInteger(record.spec_version) && record.spec_version >= 1
      ? record.spec_version
      : (existingForm?.spec_version ?? 1);
    const allowedDecisions = new Set(['keep', 'drop', 'sample_check', 'hold', 'pending_owner_review']);
    const rawDecision = record.owner_decision === undefined || record.owner_decision === null
      ? undefined
      : String(record.owner_decision).trim();
    if (rawDecision !== undefined && !allowedDecisions.has(rawDecision)) {
      throw new TypeError(
        `owner_decision must be one of [${[...allowedDecisions].join(', ')}] or null.`,
      );
    }
    const now = this._now();

    return this._withImmediateTx(() => {
      const prior = this.db.prepare(
        'SELECT * FROM calibration_tracking WHERE form_id = ? AND spec_version = ?',
      ).get(formId, specVersion);

      const trackingId = prior?.tracking_id ??
        (nonemptyStr(record.tracking_id) ? record.tracking_id.trim() : `cal-${formId}-v${specVersion}`);
      const systemVerdict = nonemptyStr(record.system_verdict)
        ? record.system_verdict.trim()
        : (prior?.system_verdict ?? null);
      if (!systemVerdict) {
        throw new TypeError('calibration_tracking requires a nonempty system_verdict on initial insert.');
      }

      const formSpecSha = nonemptyStr(record.form_spec_sha256)
        ? record.form_spec_sha256.trim()
        : (prior?.form_spec_sha256 ?? existingForm?.spec_sha256 ?? null);
      const batchId = record.batch_id !== undefined
        ? (nonemptyStr(record.batch_id) ? record.batch_id.trim() : null)
        : (prior?.batch_id ?? null);
      const core85Json = record.core_85_range !== undefined
        ? (record.core_85_range === null ? null : canonicalJson(record.core_85_range))
        : (prior?.core_85_range_json ?? null);
      const suppJson = record.supported_range !== undefined
        ? (record.supported_range === null ? null : canonicalJson(record.supported_range))
        : (prior?.supported_range_json ?? null);
      const marginJson = record.pre_ad_margin_range !== undefined
        ? (record.pre_ad_margin_range === null ? null : canonicalJson(record.pre_ad_margin_range))
        : (prior?.pre_ad_margin_range_json ?? null);
      const ownerDecision = record.owner_decision !== undefined
        ? (record.owner_decision === null ? null : rawDecision)
        : (prior?.owner_decision ?? null);
      const ownerReason = record.owner_reason !== undefined
        ? (nonemptyStr(record.owner_reason) ? record.owner_reason.trim() : null)
        : (prior?.owner_reason ?? null);
      const samplePkgJson = record.sample_measured_pkg !== undefined
        ? (record.sample_measured_pkg === null ? null : canonicalJson(record.sample_measured_pkg))
        : (prior?.sample_measured_pkg_json ?? null);
      const recalcMarginJson = record.recalculated_margin !== undefined
        ? (record.recalculated_margin === null ? null : canonicalJson(record.recalculated_margin))
        : (prior?.recalculated_margin_json ?? null);
      const calNote = record.calibration_note !== undefined
        ? (nonemptyStr(record.calibration_note) ? record.calibration_note.trim() : null)
        : (prior?.calibration_note ?? null);
      const spotCheckJson = record.near_miss_spot_check !== undefined
        ? (record.near_miss_spot_check === null ? null : canonicalJson(record.near_miss_spot_check))
        : (prior?.near_miss_spot_check_json ?? null);

      if (prior) {
        this.db.prepare(`
          UPDATE calibration_tracking
          SET form_spec_sha256 = ?,
              batch_id = ?,
              system_verdict = ?,
              core_85_range_json = ?,
              supported_range_json = ?,
              pre_ad_margin_range_json = ?,
              owner_decision = ?,
              owner_reason = ?,
              sample_measured_pkg_json = ?,
              recalculated_margin_json = ?,
              calibration_note = ?,
              near_miss_spot_check_json = ?,
              updated_at = ?
          WHERE tracking_id = ?
        `).run(
          formSpecSha, batchId, systemVerdict, core85Json, suppJson, marginJson,
          ownerDecision, ownerReason, samplePkgJson, recalcMarginJson, calNote, spotCheckJson,
          now, trackingId,
        );
      } else {
        this.db.prepare(`
          INSERT INTO calibration_tracking (
            tracking_id, form_id, spec_version, form_spec_sha256, batch_id,
            system_verdict, core_85_range_json, supported_range_json, pre_ad_margin_range_json,
            owner_decision, owner_reason, sample_measured_pkg_json, recalculated_margin_json,
            calibration_note, near_miss_spot_check_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          trackingId, formId, specVersion, formSpecSha, batchId,
          systemVerdict, core85Json, suppJson, marginJson,
          ownerDecision, ownerReason, samplePkgJson, recalcMarginJson,
          calNote, spotCheckJson, now, now,
        );
      }
      const saved = this.db.prepare('SELECT * FROM calibration_tracking WHERE tracking_id = ?').get(trackingId);
      return this._deserializeCalibrationRow(saved);
    });
  }

  getCalibrationTrackingForForm(formId, specVersion = null) {
    if (!this._hasTable('calibration_tracking') || !nonemptyStr(formId)) return null;
    const row = Number.isInteger(specVersion)
      ? this.db.prepare('SELECT * FROM calibration_tracking WHERE form_id = ? AND spec_version = ?').get(formId.trim(), specVersion)
      : this.db.prepare('SELECT * FROM calibration_tracking WHERE form_id = ? ORDER BY spec_version DESC LIMIT 1').get(formId.trim());
    return this._deserializeCalibrationRow(row);
  }

  listCalibrationTracking({ batch_id = null, form_id = null } = {}) {
    if (!this._hasTable('calibration_tracking')) return [];
    let rows;
    if (nonemptyStr(batch_id) && nonemptyStr(form_id)) {
      rows = this.db.prepare('SELECT * FROM calibration_tracking WHERE batch_id = ? AND form_id = ? ORDER BY updated_at DESC, form_id ASC').all(batch_id.trim(), form_id.trim());
    } else if (nonemptyStr(batch_id)) {
      rows = this.db.prepare('SELECT * FROM calibration_tracking WHERE batch_id = ? ORDER BY updated_at DESC, form_id ASC').all(batch_id.trim());
    } else if (nonemptyStr(form_id)) {
      rows = this.db.prepare('SELECT * FROM calibration_tracking WHERE form_id = ? ORDER BY spec_version DESC').all(form_id.trim());
    } else {
      rows = this.db.prepare('SELECT * FROM calibration_tracking ORDER BY updated_at DESC, form_id ASC').all();
    }
    return rows.map(r => this._deserializeCalibrationRow(r));
  }

  getSummary() {
    const counts = {
      api_request_ledger: this.db.prepare('SELECT COUNT(*) AS c FROM api_request_ledger').get().c,
      raw_leads: this.db.prepare('SELECT COUNT(*) AS c FROM raw_leads').get().c,
      lead_form_links: this.db.prepare('SELECT COUNT(*) AS c FROM lead_form_links').get().c,
      candidate_forms: this.db.prepare('SELECT COUNT(*) AS c FROM candidate_forms').get().c,
      sourcing_quotes_1688: this.db.prepare('SELECT COUNT(*) AS c FROM sourcing_quotes_1688').get().c,
      evaluations: this.db.prepare('SELECT COUNT(*) AS c FROM evaluations').get().c,
    };
    const calibrationTrackingCount = this._hasTable('calibration_tracking')
      ? this.db.prepare('SELECT COUNT(*) AS c FROM calibration_tracking').get().c
      : 0;
    const quota = this.getQuotaSummary();
    const leadCols = this._tableColumns('raw_leads');
    const allLeads = this.db.prepare('SELECT lead_id, source_channel, entry_group' + (leadCols.has('route') ? ', route' : '') + ' FROM raw_leads').all();
    const allLinks = this.db.prepare('SELECT lead_id, form_id, link_role FROM lead_form_links').all();
    const allForms = this.db.prepare('SELECT form_id, spec_sha256, lifecycle_status, gate1a_result_json, gate1b_result_json FROM candidate_forms').all();
    const evaluatedFormIds = new Set(
      this.db.prepare('SELECT DISTINCT form_id FROM evaluations').all().map(r => r.form_id),
    );
    const formMetaById = new Map();
    for (const f of allForms) {
      let g1aPassed = false;
      let g1bPassed = false;
      try {
        const g1a = f.gate1a_result_json ? JSON.parse(f.gate1a_result_json) : null;
        g1aPassed = Boolean(g1a && (!g1a.spec_sha256 || g1a.spec_sha256 === f.spec_sha256) && g1a.proceed_to_gate1b === true);
      } catch { /* ignore */ }
      try {
        const g1b = f.gate1b_result_json ? JSON.parse(f.gate1b_result_json) : null;
        g1bPassed = Boolean(g1b && (!g1b.spec_sha256 || g1b.spec_sha256 === f.spec_sha256) && (g1b.status === 'gate1b_passed' || g1b.owner_crossing_override === true));
      } catch { /* ignore */ }
      formMetaById.set(f.form_id, {
        lifecycle_status: f.lifecycle_status,
        gate1a_passed: g1aPassed,
        gate1b_passed: g1bPassed,
        evaluated: f.lifecycle_status === 'evaluated' || evaluatedFormIds.has(f.form_id),
      });
    }

    const funnel = Object.fromEntries(DISCOVERY_ROUTES.map(r => [r, {
      leads: 0, forms: new Set(), gate1a_passed_or_beyond: new Set(), gate1b_passed_or_beyond: new Set(), evaluated: new Set(),
    }]));
    const leadRouteById = new Map();
    for (const l of allLeads) {
      const meta = resolveChannelMeta(l.source_channel, leadCols.has('route') ? l.route : null, l.entry_group);
      leadRouteById.set(l.lead_id, meta.route);
      if (!funnel[meta.route]) {
        funnel[meta.route] = { leads: 0, forms: new Set(), gate1a_passed_or_beyond: new Set(), gate1b_passed_or_beyond: new Set(), evaluated: new Set() };
      }
      funnel[meta.route].leads++;
    }
    for (const lk of allLinks) {
      // Attribute form and gate funnel counts strictly to primary_discovery origin routes (not corroboration links).
      if (lk.link_role !== 'primary_discovery') continue;
      const route = leadRouteById.get(lk.lead_id);
      if (!route || !funnel[route]) continue;
      funnel[route].forms.add(lk.form_id);
      const fm = formMetaById.get(lk.form_id);
      if (!fm) continue;
      if (fm.gate1a_passed) funnel[route].gate1a_passed_or_beyond.add(lk.form_id);
      if (fm.gate1b_passed) funnel[route].gate1b_passed_or_beyond.add(lk.form_id);
      if (fm.evaluated) funnel[route].evaluated.add(lk.form_id);
    }
    const funnelByRoute = Object.fromEntries(
      Object.entries(funnel).map(([route, b]) => [route, {
        leads: b.leads,
        forms: b.forms.size,
        gate1a_passed_or_beyond: b.gate1a_passed_or_beyond.size,
        gate1b_passed_or_beyond: b.gate1b_passed_or_beyond.size,
        evaluated: b.evaluated.size,
      }]),
    );

    return {
      db_path: this._sanitizeDbPath(this.dbPath),
      read_only: this.readOnly,
      counts,
      calibration_tracking_count: calibrationTrackingCount,
      quota,
      quota_by_lane: quota.by_lane,
      funnel_by_route: funnelByRoute,
      queues: this.db.prepare('SELECT * FROM queue_state ORDER BY queue_name ASC').all().map(r => ({ ...r })),
      startup_reconciled_attempts: [...this.startup_reconciled_attempts],
    };
  }
}

export function openSelectionStore(dbPath = ':memory:', options = {}) {
  return new SelectionStore(dbPath, options);
}
