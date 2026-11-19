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
import { dirname } from 'node:path';
import { validEvidenceDate } from './observations.mjs';
import {
  ALLOWED_DISPOSITIONS,
  assertNoRawPii,
  containsSecretToken,
  sanitizeDiagnosticText,
  validateRedactedDestination,
  validateSourcingVerifier1688Output,
} from './contracts.mjs';

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
  'gate2_3_in_progress',
  'evaluated',
  'deferred',
  'excluded',
]);

const PROVIDERS = Object.freeze(['sellersprite', 'sif', 'exa', '1688_browser', 'other']);
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
  if (PROVIDERS.includes(raw)) return raw;
  const tool = String(toolName || '').trim().toLowerCase();
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
  let bare = toolName.trim();
  bare = bare.replace(/^mcp__codex_apps__[a-z0-9]+_mcp_/i, '');
  bare = bare.replace(/^mcp__codex_apps__(?:sellersprite|sif|exa)_/i, '');
  bare = bare.replace(/^mcp__codex_apps__/i, '');
  bare = bare.replace(/^mcp__[a-z0-9_-]+__/i, '');
  bare = bare.replace(/^(?:sellersprite|sif|exa)[:.]/i, '');
  bare = bare.replace(/_[0-9a-f]{8}$/i, '');
  return bare.trim().toLowerCase();
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

  if (core.marketplace === undefined && (normProvider === 'sif' || normProvider === 'sellersprite')) {
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
  provider TEXT NOT NULL CHECK(provider IN ('sellersprite', 'sif', 'exa', '1688_browser', 'other')),
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
  estimated_sif_units REAL NOT NULL DEFAULT 0 CHECK(estimated_sif_units >= 0),
  unknown_reserved_sif_units REAL NOT NULL DEFAULT 0 CHECK(unknown_reserved_sif_units >= 0),
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
  entry_group TEXT NOT NULL DEFAULT 'in_site',
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
    'gate1b_queued', 'gate1b_passed', 'gate1b_rejected', 'gate1b_pending',
    'gate2_3_in_progress', 'evaluated', 'deferred', 'excluded'
  )),
  gate1a_result_json TEXT,
  gate1b_result_json TEXT,
  negotiation_shortlist_json TEXT,
  landed_domestic_cap_cny REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forms_family ON candidate_forms(product_family_key);
CREATE INDEX IF NOT EXISTS idx_forms_status ON candidate_forms(lifecycle_status);

CREATE TABLE IF NOT EXISTS lead_form_links (
  lead_id TEXT NOT NULL REFERENCES raw_leads(lead_id),
  form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
  link_role TEXT NOT NULL CHECK(link_role IN ('primary_discovery', 'corroboration')),
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
  goods_cny_total REAL CHECK((quote_status = 'pending' AND (goods_cny_total IS NULL OR goods_cny_total > 0)) OR (quote_status != 'pending' AND goods_cny_total IS NOT NULL AND goods_cny_total > 0)),
  domestic_freight_cny_total REAL CHECK((quote_status = 'pending' AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status != 'pending' AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
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
  quote_status TEXT NOT NULL CHECK(quote_status IN ('verified', 'rejected_promo', 'rejected_spec', 'expired', 'pending')),
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
`;

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
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA_SQL);
    this._ensureDefaultQueues();
    this.startup_reconciled_attempts = reconcileOnOpen ? this.reconcileInFlightOnStartup() : [];
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
        SELECT attempt_id, estimated_sif_units, unknown_reserved_sif_units
        FROM api_request_ledger
        WHERE status IN ('reserved', 'in_flight')
      `).all();
      const stmt = this.db.prepare(`
        UPDATE api_request_ledger
        SET status = 'unknown_needs_reconciliation',
            repeat_submission_allowed = 0,
            unknown_reserved_sif_units = MAX(unknown_reserved_sif_units, estimated_sif_units),
            reconciliation_note = COALESCE(reconciliation_note || ' | ', '') || 'Crash recovery on startup: prior attempt interrupted before receipt; reconcile before retrying.',
            updated_at = ?
        WHERE attempt_id = ?
      `);
      for (const row of dangling) stmt.run(now, row.attempt_id);

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
    const estimatedSifUnits = spec.estimated_sif_units ?? 0;
    if (!finite(estimatedSifUnits) || estimatedSifUnits < 0) {
      throw new TypeError('estimated_sif_units must be a nonnegative finite number.');
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
        const completed = this.db.prepare(`
          SELECT * FROM api_request_ledger
          WHERE logical_request_key = ? AND status = 'completed'
          ORDER BY created_at DESC
          LIMIT 1
        `).get(keys.logical_request_key);
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

      // Check 4: Reserve synchronously before dispatch (persisting estimated_sif_units for crash safety).
      this.db.prepare(`
        INSERT INTO api_request_ledger (
          attempt_id, logical_request_key, semantic_lock_key, account_scope,
          provider, tool_name, canonical_tool, tool_version, marketplace, mode,
          observation_cutoff_date, page_or_cursor, normalized_params_json,
          form_id, stage, status, repeat_submission_allowed, estimated_sif_units,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fresh_observation', ?, ?, ?, ?, ?, 'reserved', 0, ?, ?, ?)
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
        estimatedSifUnits,
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
          unknown_reserved_sif_units = CASE WHEN ? = 1 THEN MAX(unknown_reserved_sif_units, estimated_sif_units) ELSE 0 END,
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
    unknown_reserved_sif_units = null,
    ss_mcp_units = 0,
    ss_web_realtime_tasks = 0,
    sif_units = 0,
    exa_calls = 0,
    billing_status = 'unknown_not_exposed',
    payload_sha256 = null,
    raw_artifact_path = null,
  } = {}) {
    this._assertWritable();
    if (unknown_reserved_sif_units !== null && (!finite(unknown_reserved_sif_units) || unknown_reserved_sif_units < 0)) {
      throw new TypeError('unknown_reserved_sif_units must be a nonnegative finite number or null.');
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
          unknown_reserved_sif_units = MAX(unknown_reserved_sif_units, COALESCE(?, estimated_sif_units)),
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
      unknown_reserved_sif_units,
      payload_sha256,
      raw_artifact_path,
      cleanNote,
      now,
      now,
      attemptId,
    );
    if (res.changes !== 1) throw new Error(`Cannot mark attempt ${attemptId} unknown_needs_reconciliation.`);
  }

  failAttemptBeforeDispatch(attemptId, note = 'Failed locally before network dispatch.') {
    this._assertWritable();
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE api_request_ledger
      SET status = 'failed',
          repeat_submission_allowed = 1,
          unknown_reserved_sif_units = 0,
          reconciliation_note = ?,
          updated_at = ?,
          finished_at = ?
      WHERE attempt_id = ? AND status = 'reserved'
    `).run(sanitizeDiagnosticText(note), now, now, attemptId);
    if (res.changes !== 1) throw new Error(`Cannot mark attempt ${attemptId} failed before dispatch (must be in reserved state).`);
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
    const cleanNote = sanitizeDiagnosticText(note.trim());
    const now = this._now();
    return this._withImmediateTx(() => {
      const existing = this.db.prepare('SELECT status, billing_status FROM api_request_ledger WHERE attempt_id = ?').get(attemptId);
      if (!existing) throw new Error(`Attempt ${attemptId} not found.`);
      if (existing.status === 'permanently_locked') {
        throw new Error(`Attempt ${attemptId} is permanently_locked and cannot be unlocked.`);
      }
      const canReconcile = existing.status === 'unknown_needs_reconciliation' ||
        (existing.status === 'completed' && existing.billing_status === 'unknown_not_exposed');
      if (!canReconcile) {
        throw new Error(`Attempt ${attemptId} is in state ${existing.status} (billing ${existing.billing_status}), not eligible for reconciliation.`);
      }
      const repeatAllowed = resolved_status === 'permanently_locked' ? 0 : 1;
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
            unknown_reserved_sif_units = CASE WHEN ? = 1 THEN unknown_reserved_sif_units ELSE 0 END,
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
    const incomingReserve = Number(record.unknown_reserved_sif_units ?? 0) || 0;
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

        const nextStatus = existing.status === 'permanently_locked' || status === 'permanently_locked'
          ? 'permanently_locked'
          : (status === 'unknown_needs_reconciliation' ? 'unknown_needs_reconciliation' : existing.status);
        const nextRepeat = (existing.repeat_submission_allowed === 0 || repeatAllowed === 0 || nextStatus === 'permanently_locked') ? 0 : 1;
        const nextSourceRef = preferIncomingId
          ? (record.source_ledger_ref ?? existing.source_ledger_ref)
          : (existing.source_ledger_ref ?? record.source_ledger_ref ?? null);
        this.db.prepare(`
          UPDATE api_request_ledger
          SET status = ?,
              repeat_submission_allowed = ?,
              billing_status = CASE WHEN ? = 'unknown_not_exposed' THEN 'unknown_not_exposed' ELSE billing_status END,
              ss_mcp_units = MAX(ss_mcp_units, ?),
              ss_web_realtime_tasks = MAX(ss_web_realtime_tasks, ?),
              sif_units = MAX(sif_units, ?),
              exa_calls = MAX(exa_calls, ?),
              unknown_reserved_sif_units = MAX(unknown_reserved_sif_units, ?),
              payload_sha256 = COALESCE(payload_sha256, ?),
              raw_artifact_path = COALESCE(raw_artifact_path, ?),
              source_ledger_ref = ?,
              reconciliation_note = COALESCE(?, reconciliation_note),
              updated_at = ?
          WHERE attempt_id = ?
        `).run(
          nextStatus,
          nextRepeat,
          billingStatus,
          record.ss_mcp_units ?? 0,
          record.ss_web_realtime_tasks ?? 0,
          record.sif_units ?? 0,
          record.exa_calls ?? 0,
          incomingReserve,
          record.payload_sha256 ?? null,
          record.raw_artifact_path ?? null,
          nextSourceRef,
          cleanNote,
          now,
          targetId,
        );
        return {
          inserted: false,
          upgraded_to_lock: nextStatus === 'permanently_locked' && existing.status !== 'permanently_locked',
          attempt_id: targetId,
        };
      }

      this.db.prepare(`
        INSERT INTO api_request_ledger (
          attempt_id, logical_request_key, semantic_lock_key, account_scope,
          provider, tool_name, canonical_tool, tool_version, marketplace, mode,
          observation_cutoff_date, page_or_cursor, normalized_params_json,
          form_id, stage, status, repeat_submission_allowed, billing_status,
          ss_mcp_units, ss_web_realtime_tasks, sif_units, exa_calls, estimated_sif_units, unknown_reserved_sif_units,
          payload_sha256, raw_artifact_path, pagination_complete, source_ledger_ref, reconciliation_note,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical_replay', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        incomingReserve,
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
      this.failAttemptUnknownOutcome(attemptId, {
        note: `Executor error after dispatch (${sanitizeDiagnosticText(error?.message || 'unknown_error')}); reconcile before retrying.`,
        unknown_reserved_sif_units: spec.estimated_sif_units ?? 0,
      });
      throw error;
    }
  }

  getQuotaSummary() {
    const totals = this.db.prepare(`
      SELECT
        COALESCE(SUM(ss_mcp_units), 0) AS ss_mcp_units,
        COALESCE(SUM(ss_web_realtime_tasks), 0) AS ss_web_realtime_tasks,
        COALESCE(SUM(sif_units), 0) AS sif_units,
        COALESCE(SUM(exa_calls), 0) AS exa_calls,
        COALESCE(SUM(unknown_reserved_sif_units), 0) AS unknown_reserved_sif_units,
        COUNT(*) AS total_attempts,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_attempts,
        COALESCE(SUM(CASE WHEN status = 'permanently_locked' THEN 1 ELSE 0 END), 0) AS permanently_locked_attempts,
        COALESCE(SUM(CASE WHEN status = 'unknown_needs_reconciliation' THEN 1 ELSE 0 END), 0) AS unknown_attempts,
        COALESCE(SUM(CASE WHEN status IN ('reserved', 'in_flight') THEN 1 ELSE 0 END), 0) AS active_attempts,
        COALESCE(SUM(CASE WHEN billing_status = 'unknown_not_exposed' THEN 1 ELSE 0 END), 0) AS unknown_billing_attempts
      FROM api_request_ledger
    `).get();
    return { ...totals };
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
          SET disposition = ?, disposition_reason = COALESCE(?, disposition_reason),
              metadata_json = ?
          WHERE lead_id = ?
        `).run(disposition, lead.disposition_reason ?? null, canonicalJson(lead.metadata ?? JSON.parse(existing.metadata_json)), leadId);
        return { inserted: false, lead: { ...this.db.prepare('SELECT * FROM raw_leads WHERE lead_id = ?').get(leadId) } };
      }
      this.db.prepare(`
        INSERT INTO raw_leads (
          lead_id, normalized_key, event_dedup_key, source_ref_hash, source_channel, entry_group,
          source_ref, phrase_or_title, raw_excerpt, observed_at, first_seen_at,
          evidence_sha256, disposition, disposition_reason, source_attempt_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        leadId,
        normalizedKey,
        eventDedupKey,
        sourceRefHash,
        sourceChannel,
        lead.entry_group ?? 'in_site',
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
   * Link a raw lead to a candidate form, deduplicating primary_discovery by BOTH event_dedup_key
   * AND canonical source_ref_hash so two tools citing the same original post with distinct custom
   * event keys never double-count independent discovery.
   */
  linkLeadToForm({ lead_id, form_id, link_role = 'primary_discovery', note = null }) {
    this._assertWritable();
    if (!['primary_discovery', 'corroboration'].includes(link_role)) {
      throw new TypeError('link_role must be primary_discovery or corroboration.');
    }
    const now = this._now();
    return this._withImmediateTx(() => {
      const lead = this.db.prepare('SELECT lead_id, event_dedup_key, source_ref_hash FROM raw_leads WHERE lead_id = ?').get(lead_id);
      if (!lead) throw new TypeError(`Unknown lead_id: ${lead_id}`);
      const form = this.db.prepare('SELECT form_id FROM candidate_forms WHERE form_id = ?').get(form_id);
      if (!form) throw new TypeError(`Unknown form_id: ${form_id}`);

      const existingLink = this.db.prepare('SELECT * FROM lead_form_links WHERE lead_id = ? AND form_id = ?').get(lead_id, form_id);
      if (existingLink) return { inserted: false, link: { ...existingLink } };

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

      this.db.prepare(`
        INSERT INTO lead_form_links (lead_id, form_id, link_role, event_dedup_key, source_ref_hash, linked_at, note)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(lead_id, form_id, effectiveRole, lead.event_dedup_key, lead.source_ref_hash, now, effectiveNote);
      return {
        inserted: true,
        link: { ...this.db.prepare('SELECT * FROM lead_form_links WHERE lead_id = ? AND form_id = ?').get(lead_id, form_id) },
      };
    });
  }

  getLeadsForForm(formId) {
    return this.db.prepare(`
      SELECT l.*, j.link_role, j.linked_at, j.note AS link_note
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
          landed_domestic_cap_cny, created_at, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
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
        now,
        now,
      );
      return { inserted: true, spec_changed: false, form: this.getCandidateForm(formId) };
    });
  }

  updateFormLifecycle(formId, lifecycleStatus, {
    gate1a_result = undefined,
    gate1b_result = undefined,
    negotiation_shortlist = undefined,
    landed_domestic_cap_cny = undefined,
  } = {}) {
    this._assertWritable();
    if (!LIFECYCLE_STATUSES.includes(lifecycleStatus)) {
      throw new TypeError(`Invalid lifecycle_status: ${lifecycleStatus}`);
    }
    const now = this._now();
    const res = this.db.prepare(`
      UPDATE candidate_forms
      SET lifecycle_status = ?,
          gate1a_result_json = CASE WHEN ? = 1 THEN ? ELSE gate1a_result_json END,
          gate1b_result_json = CASE WHEN ? = 1 THEN ? ELSE gate1b_result_json END,
          negotiation_shortlist_json = CASE WHEN ? = 1 THEN ? ELSE negotiation_shortlist_json END,
          landed_domestic_cap_cny = CASE WHEN ? = 1 THEN ? ELSE landed_domestic_cap_cny END,
          updated_at = ?
      WHERE form_id = ?
    `).run(
      lifecycleStatus,
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
    return row ? { ...row } : null;
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

    const quoteStatus = quote.quote_status ?? 'verified';
    const contractStatus = quoteStatus === 'verified' ? 'verified' : (quoteStatus === 'pending' ? 'unknown' : 'rejected');
    const verified = validateSourcingVerifier1688Output({
      schema_version: 1,
      contract: 'SourcingVerifier1688',
      status: contractStatus,
      observed_at: quote.observed_at,
      expires_at: quote.expires_at ?? null,
      redacted_destination: quote.redacted_destination,
      redacted_screenshot_path: quote.redacted_screenshot_path ?? null,
      redacted_webp_sha256: quote.redacted_webp_sha256 ?? null,
      sensitive_freebie_flags: quote.sensitive_freebie_flags ?? {},
      lead_time_days: quote.lead_time_days ?? null,
      goods_first_order_promotion: quote.goods_first_order_promotion,
      freight_first_order_promotion: quote.freight_first_order_promotion,
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
    const orderPlan = verified.order_plan;
    const skuLines = Array.isArray(quote.sku_lines) ? quote.sku_lines : [];
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
        actual_sets, actual_complete_sets, goods_cny_total, domestic_freight_cny_total,
        goods_first_order_promotion, freight_first_order_promotion, lead_time_days,
        sensitive_freebie_flags_json, redacted_destination, redacted_screenshot_path,
        redacted_webp_sha256, raw_readback_ref, observed_at, expires_at, quote_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      quote.goods_first_order_promotion ? 1 : 0,
      quote.freight_first_order_promotion ? 1 : 0,
      quote.lead_time_days ?? null,
      canonicalJson(verified.sensitive_freebie_flags),
      verified.redacted_destination,
      quote.redacted_screenshot_path ?? null,
      quote.redacted_webp_sha256 ?? null,
      quote.raw_readback_ref ?? null,
      quote.observed_at,
      quote.expires_at ?? null,
      quoteStatus,
      now,
    );

    return {
      quote: { ...this.db.prepare('SELECT * FROM sourcing_quotes_1688 WHERE quote_id = ?').get(quoteId) },
      order_plan: orderPlan,
    };
  }

  getQuotesForForm(formId) {
    return this.db.prepare('SELECT * FROM sourcing_quotes_1688 WHERE form_id = ? ORDER BY created_at DESC').all(formId).map(r => ({ ...r }));
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

      if (existing) {
        if (existing.result_sha256 !== ev.result_sha256) {
          throw new Error(
            `Evaluation immutability violation for (${form.form_id}, ${periodId}, r${ev.profile_revision}, ${ev.evidence_bundle_sha256.slice(0, 12)}): ` +
            'cannot overwrite existing evaluation with a different result hash; update fee/evidence bundle to create a new version.',
          );
        }
        // Append newly discovered source_attempt_ids and new batch_receipts without mutating the immutable evaluation score/result!
        const prevAttempts = JSON.parse(existing.source_attempt_ids_json || '[]');
        const mergedAttempts = [...new Set([...prevAttempts, ...(ev.source_attempt_ids ?? [])])].sort();
        const prevReceipt = JSON.parse(existing.receipt_json || '{}');
        const batchReceipts = Array.isArray(prevReceipt.batch_receipts) ? [...prevReceipt.batch_receipts] : [];
        if (prevReceipt.batch_result_sha256 && batchReceipts.length === 0) {
          batchReceipts.push({
            batch_result_sha256: prevReceipt.batch_result_sha256,
            batch_html_sha256: prevReceipt.batch_html_sha256 ?? existing.html_sha256 ?? null,
          });
        }
        const incomingBatchSha = ev.receipt?.batch_result_sha256 ?? null;
        const incomingHtmlSha = ev.receipt?.batch_html_sha256 ?? ev.html_sha256 ?? null;
        let receiptChanged = false;
        if (incomingBatchSha && !batchReceipts.some(b => b.batch_result_sha256 === incomingBatchSha && b.batch_html_sha256 === incomingHtmlSha)) {
          batchReceipts.push({
            batch_result_sha256: incomingBatchSha,
            batch_html_sha256: incomingHtmlSha,
          });
          receiptChanged = true;
        }
        const attemptsChanged = mergedAttempts.length !== prevAttempts.length;
        if (attemptsChanged || receiptChanged) {
          const nextReceipt = { ...prevReceipt, batch_receipts: batchReceipts };
          this.db.prepare(`
            UPDATE evaluations
            SET source_attempt_ids_json = ?, receipt_json = ?
            WHERE evaluation_id = ?
          `).run(canonicalJson(mergedAttempts), canonicalJson(nextReceipt), existing.evaluation_id);
        }
        const updated = this.db.prepare('SELECT * FROM evaluations WHERE evaluation_id = ?').get(existing.evaluation_id);
        return { inserted: false, identical: true, evaluation: { ...updated } };
      }

      const initialReceipt = { ...(ev.receipt ?? {}) };
      if (initialReceipt.batch_result_sha256) {
        initialReceipt.batch_receipts = [{
          batch_result_sha256: initialReceipt.batch_result_sha256,
          batch_html_sha256: initialReceipt.batch_html_sha256 ?? ev.html_sha256 ?? null,
        }];
      }

      this.db.prepare(`
        INSERT INTO evaluations (
          evaluation_id, form_id, period_id, profile_revision, evidence_bundle_sha256,
          qualification_json, sort_keys_json, queue_bucket, covered_weight,
          supported_range_json, total_range_json, result_sha256, html_sha256,
          receipt_json, source_attempt_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    if (!validEvidenceDate(verification.quote_validity)) {
      throw new TypeError('verification.quote_validity must be a valid ISO date or timestamp.');
    }
    const asOfDay = assertIsoDateOnly(as_of_date, 'as_of_date');
    if (verification.quote_validity.slice(0, 10) < asOfDay) {
      throw new TypeError(`verification.quote_validity (${verification.quote_validity}) is expired relative to ${asOfDay}.`);
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
      quote_validity: verification.quote_validity,
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
      gate1a_result: form.gate1a_result_json ? JSON.parse(form.gate1a_result_json) : null,
      gate1b_result: form.gate1b_result_json ? JSON.parse(form.gate1b_result_json) : null,
      negotiation_shortlist: form.negotiation_shortlist_json ? JSON.parse(form.negotiation_shortlist_json) : null,
      primary_discovery_leads: leads.filter(l => l.link_role === 'primary_discovery'),
      corroboration_leads: leads.filter(l => l.link_role === 'corroboration'),
      sourcing_quotes_1688: quotes,
      evaluations,
      ledger_attempts: attempts,
    };
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
    return {
      db_path: this.dbPath,
      read_only: this.readOnly,
      counts,
      quota: this.getQuotaSummary(),
      queues: this.db.prepare('SELECT * FROM queue_state ORDER BY queue_name ASC').all().map(r => ({ ...r })),
      startup_reconciled_attempts: [...this.startup_reconciled_attempts],
    };
  }
}

export function openSelectionStore(dbPath = ':memory:', options = {}) {
  return new SelectionStore(dbPath, options);
}
