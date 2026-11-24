/**
 * Historical request-ledger importer, permanent lock loader, retained-asset manifest importer,
 * and atomic frozen-batch SQLite replay helper.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDiscovery, attachDiscovery } from './discovery.mjs';
import { resolveChannelMeta } from './discovery-channels.mjs';
import { scoreBatch } from './scoring.mjs';
import { renderReport } from './report.mjs';
import { getFba2027RateTableSnapshot } from './fba-rates-2027.mjs';
import {
  canonicalJson,
  computeEvidenceBundleHash,
  normalizeProvider,
  sha256Hex,
} from './store.mjs';

const toPathStr = p => (p instanceof URL ? fileURLToPath(p) : String(p));

function readJsonSyncSafe(pathStr, label) {
  let bytes;
  try {
    bytes = readFileSync(pathStr);
  } catch (err) {
    const code = typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : 'IO_ERROR';
    throw new Error(`Unable to read ${label} (${code}, file: ${basename(pathStr)}).`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8 (file: ${basename(pathStr)}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON (file: ${basename(pathStr)}).`);
  }
}

const PRIMARY_OFF_PEAK_MONTHS = [2, 3, 4, 5, 6, 7, 8, 9];
const HOLIDAY_PEAK_MONTHS = [10, 11, 12];

function toDateOnly(isoOrDate, fallback = '2026-11-16') {
  if (typeof isoOrDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(isoOrDate)) {
    return isoOrDate.slice(0, 10);
  }
  return fallback;
}

function toSafeRelativePath(filePath, repoRoot = process.cwd()) {
  if (!filePath || (typeof filePath !== 'string' && !(filePath instanceof URL))) return null;
  const trimmed = toPathStr(filePath).trim();
  if (!trimmed) return null;
  const normRoot = resolve(repoRoot);
  if (isAbsolute(trimmed)) {
    const rel = relative(normRoot, resolve(trimmed)).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    return null;
  }
  return trimmed.replace(/\\/g, '/');
}

function inspectRawArtifactCharges(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return { sif: null, ss_mcp: null, is_error: false }; }
  let sif = null;
  let ssMcp = null;
  let isError = false;
  const seen = new Set();

  const visit = (v, depth = 0) => {
    if (v === null || v === undefined || depth > 5) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try { visit(JSON.parse(s), depth + 1); } catch { /* ignore non-json string */ }
      }
      return;
    }
    if (typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (v.isError === true || v.is_error === true) isError = true;
    if (v._quota && typeof v._quota.costThisCall === 'number' && Number.isFinite(v._quota.costThisCall) && sif === null) {
      sif = v._quota.costThisCall;
    }
    if (v.quota && typeof v.quota.costThisCall === 'number' && Number.isFinite(v.quota.costThisCall) && sif === null) {
      sif = v.quota.costThisCall;
    }
    if (typeof v.costThisCall === 'number' && Number.isFinite(v.costThisCall) && sif === null) {
      sif = v.costThisCall;
    }
    if (v.billing && typeof v.billing.chargedUnits === 'number' && Number.isFinite(v.billing.chargedUnits) && ssMcp === null) {
      ssMcp = v.billing.chargedUnits;
    }
    if (typeof v.chargedUnits === 'number' && Number.isFinite(v.chargedUnits) && ssMcp === null) {
      ssMcp = v.chargedUnits;
    }
    for (const k of ['structuredContent', 'content', 'response', 'result', 'data', 'billing', '_quota', 'quota', 'text']) {
      if (v[k] !== undefined) visit(v[k], depth + 1);
    }
  };
  visit(parsed, 0);
  return { sif, ss_mcp: ssMcp, is_error: isError };
}

function resolveExistingArtifact(candidates, ledgerDir, repoRoot) {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim();
    const tries = isAbsolute(trimmed)
      ? [trimmed]
      : [resolve(repoRoot, trimmed), resolve(ledgerDir, trimmed)];
    for (const full of tries) {
      if (existsSync(full)) {
        const bytes = readFileSync(full);
        const inspected = full.toLowerCase().endsWith('.json')
          ? inspectRawArtifactCharges(bytes.toString('utf8'))
          : { sif: null, ss_mcp: null, is_error: false };
        return {
          full_path: full,
          safe_rel_path: toSafeRelativePath(full, repoRoot),
          sha256: sha256Hex(bytes),
          inspected,
        };
      }
    }
  }
  return null;
}

function extractPageOrCursor(args) {
  if (!args || typeof args !== 'object') return '';
  const inner = args.request && typeof args.request === 'object' ? args.request : args;
  if (inner.page && typeof inner.page === 'object' && inner.page.cursor !== undefined) {
    return `cursor:${inner.page.cursor}`;
  }
  if (inner.page !== undefined) return `page:${inner.page}`;
  if (inner.pageNum !== undefined) return `page:${inner.pageNum}`;
  if (inner.cursor !== undefined) return `cursor:${inner.cursor}`;
  return '';
}

function extractMarketplace(args) {
  if (!args || typeof args !== 'object') return 'US';
  const inner = args.request && typeof args.request === 'object' ? args.request : args;
  return String(inner.marketplace || inner.country || 'US').trim().toUpperCase();
}

function extractWebRealtimeTasks(req) {
  let ssWeb = Number(req.ss_web_realtime_tasks ?? 0) || 0;
  if (ssWeb > 0) return ssWeb;
  if (req.billing && typeof req.billing === 'object') {
    const unit = String(req.billing.unit || '');
    const qty = Number(req.billing.quantity ?? 0);
    if (/website.*task|realtime.*task/i.test(unit) && Number.isFinite(qty) && qty > 0) {
      return qty;
    }
  }
  if (typeof req.quota_before === 'string' && typeof req.quota_after === 'string') {
    const mBefore = req.quota_before.match(/(\d+)\s+new\s+tasks/i);
    const mAfter = req.quota_after.match(/(\d+)\s+new\s+tasks/i);
    if (mBefore && mAfter) {
      const delta = Number(mBefore[1]) - Number(mAfter[1]);
      if (delta > 0) return delta;
    }
  }
  return 0;
}

function extractHistoricalCharges(req, provider, artifactInspected = null, isCompleted = false) {
  let ssMcp = Number(req.ss_mcp_units ?? 0) || 0;
  const ssWeb = extractWebRealtimeTasks(req);
  let sifUnits = Number(req.sif_units ?? 0) || 0;
  let exaCalls = Number(req.exa_calls ?? 0) || 0;

  // Prefer actual provider receipt billing inside the bound raw artifact, falling back to ledger metadata.
  if (provider === 'sif' && artifactInspected && typeof artifactInspected.sif === 'number' && artifactInspected.sif > 0) {
    sifUnits = Math.max(sifUnits, artifactInspected.sif);
  }
  if (provider === 'sellersprite' && artifactInspected && typeof artifactInspected.ss_mcp === 'number' && artifactInspected.ss_mcp > 0) {
    ssMcp = Math.max(ssMcp, artifactInspected.ss_mcp);
  }
  if (provider === 'exa' && isCompleted && exaCalls === 0) {
    exaCalls = 1;
  }

  const reported = typeof req.reported_charge_units === 'number' && Number.isFinite(req.reported_charge_units)
    ? req.reported_charge_units
    : (typeof req.quota?.costThisCall === 'number' && Number.isFinite(req.quota.costThisCall)
      ? req.quota.costThisCall
      : null);

  if (reported !== null && reported > 0) {
    if (provider === 'sif') sifUnits = Math.max(sifUnits, reported);
    else if (provider === 'sellersprite') ssMcp = Math.max(ssMcp, reported);
    else if (provider === 'exa') exaCalls = Math.max(exaCalls, reported);
  }

  const hasKnownCharge = sifUnits > 0 || ssMcp > 0 || ssWeb > 0 || exaCalls > 0 ||
    (artifactInspected && (artifactInspected.sif !== null || artifactInspected.ss_mcp !== null)) ||
    reported !== null;

  const billingUnknown = !hasKnownCharge && (
    req.billing_status === 'not_exposed_unknown' ||
    (req.billing && /unknown/i.test(JSON.stringify(req.billing)))
  );

  return {
    ss_mcp_units: ssMcp,
    ss_web_realtime_tasks: ssWeb,
    sif_units: sifUnits,
    exa_calls: exaCalls,
    billing_status: billingUnknown ? 'unknown_not_exposed' : 'known',
  };
}

/**
 * Import a request-recovery.json file and permanently lock any unresolved non-retryable
 * historical request across restarts, account aliases, wrapper renames, and import orders.
 */
export function importRecoveryLockFile(store, recoveryPath, { repoRoot = process.cwd(), accountScope = 'historical-default' } = {}) {
  const pathStr = toPathStr(recoveryPath);
  const data = readJsonSyncSafe(pathStr, 'recovery lock file');
  const orig = data?.original_request;
  if (!orig || typeof orig !== 'object' || !orig.id || !orig.tool) {
    throw new TypeError(`Invalid recovery lock file: missing original_request in ${basename(pathStr)}`);
  }
  const shouldLock = data.repeat_submission_allowed === false ||
    data.execution_outcome === 'unknown' ||
    data.billing_outcome === 'unknown';
  const unknownReserve = Number(data.distinct_batch_reconciliation_20261116?.extra_unknown_reservation_points ?? 0);
  const cutoff = toDateOnly(orig.started_at || data.checked_at, '2026-11-15');
  const artifact = resolveExistingArtifact([data.response_path], dirname(resolve(pathStr)), repoRoot);
  const safeRef = toSafeRelativePath(pathStr, repoRoot);

  const result = store.recordHistoricalAttempt({
    attempt_id: orig.id,
    canonical_recovery_lock: true,
    account_scope: accountScope,
    provider: normalizeProvider(data.provider, orig.tool),
    tool_name: orig.tool,
    tool_version: 'historical',
    marketplace: extractMarketplace(orig.args),
    observation_cutoff_date: cutoff,
    page_or_cursor: extractPageOrCursor(orig.args),
    params: orig.args ?? {},
    stage: 'replay',
    status: shouldLock ? 'permanently_locked' : 'unknown_needs_reconciliation',
    no_retry: true,
    billing_status: data.billing_outcome === 'unknown' ? 'unknown_not_exposed' : 'known',
    unknown_reserved_sif_units: Number.isFinite(unknownReserve) && unknownReserve >= 0 ? unknownReserve : 0,
    payload_sha256: artifact?.sha256 ?? null,
    raw_artifact_path: artifact?.safe_rel_path ?? toSafeRelativePath(data.response_path, repoRoot),
    source_ledger_ref: safeRef,
    reconciliation_note: data.distinct_batch_reconciliation_20261116?.request101_status ||
      data.source_limits ||
      'Imported unresolved historical request locked against resubmission.',
    created_at: orig.started_at ?? data.checked_at ?? new Date().toISOString(),
    finished_at: orig.finished_at ?? null,
  });

  return {
    attempt_id: result.attempt_id,
    status: shouldLock ? 'permanently_locked' : 'unknown_needs_reconciliation',
    unknown_reserved_sif_units: unknownReserve,
    ...result,
  };
}

/**
 * Import a historical request-ledger.json file idempotently into api_request_ledger.
 * Rejects unrecognized file formats (such as passing a recovery file to --ledger), extracts
 * real provider charges and isError flags directly from bound raw receipts, and preserves no_retry.
 */
export function importRequestLedgerFile(store, ledgerPath, { repoRoot = process.cwd(), accountScope = 'historical-default' } = {}) {
  const pathStr = toPathStr(ledgerPath);
  const data = readJsonSyncSafe(pathStr, 'request ledger file');
  let requests;
  if (Array.isArray(data)) {
    requests = data;
  } else if (data && typeof data === 'object' && Array.isArray(data.requests)) {
    requests = data.requests;
  } else {
    throw new TypeError(`Unrecognized request ledger format in ${basename(pathStr)}: expected an array or an object with a requests[] array.`);
  }

  const firstDate = requests[0]?.started_at || requests[0]?.created_at || (Array.isArray(data) ? null : data.started_at);
  const ledgerDate = toDateOnly(firstDate, '2026-11-16');
  const ledgerDir = dirname(resolve(pathStr));
  const safeRef = toSafeRelativePath(pathStr, repoRoot);

  let inserted = 0;
  let skipped = 0;
  let lockedOrUnknown = 0;
  let boundArtifacts = 0;

  const COMPLETED_STATUSES = new Set([
    'response_saved',
    'response_received',
    'raw_response_saved',
    'response_excerpt_saved',
    'returned_saved',
    'completed',
  ]);
  const FAILED_NOT_DISPATCHED = new Set([
    'delegated_not_submitted_by_root',
    'failed_before_dispatch',
    'skipped',
  ]);

  for (const req of requests) {
    const reqId = req && typeof req === 'object' ? (req.id ?? req.key) : null;
    if (!req || typeof req !== 'object' || !reqId || !req.tool) continue;

    const reqParams = req.args ?? req.request ?? {};
    const provider = normalizeProvider(req.provider, req.tool);
    const rawStatus = String(req.status || '').toLowerCase();
    const execStatus = String(req.execution_status || '').toLowerCase();

    const artifact = resolveExistingArtifact([
      req.path,
      req.response_path,
      req.receipt_path,
      req.raw_path,
      join(ledgerDir, 'raw', `${reqId}.json`),
      join(ledgerDir, 'raw', `${reqId}.response.json`),
    ], ledgerDir, repoRoot);
    if (artifact) boundArtifacts++;

    const rawArtifactIsError = artifact?.inspected?.is_error === true;
    const isCompletedStatus = !rawArtifactIsError && !FAILED_NOT_DISPATCHED.has(rawStatus) && COMPLETED_STATUSES.has(rawStatus);
    const charges = extractHistoricalCharges(req, provider, artifact?.inspected ?? null, isCompletedStatus);

    let mappedStatus = 'unknown_needs_reconciliation';
    let noRetry = req.no_retry === true;

    if (rawStatus === 'permanently_locked') {
      mappedStatus = 'permanently_locked';
      noRetry = true;
      lockedOrUnknown++;
    } else if (FAILED_NOT_DISPATCHED.has(rawStatus)) {
      mappedStatus = 'failed';
    } else if (
      rawArtifactIsError ||
      rawStatus === 'tool_error' ||
      rawStatus === 'returned_error' ||
      rawStatus === 'unknown' ||
      rawStatus === 'timeout' ||
      execStatus === 'returned_error' ||
      Boolean(req.provider_error)
    ) {
      mappedStatus = 'unknown_needs_reconciliation';
      noRetry = true;
      lockedOrUnknown++;
    } else if (COMPLETED_STATUSES.has(rawStatus)) {
      mappedStatus = 'completed';
    } else {
      mappedStatus = 'unknown_needs_reconciliation';
      noRetry = true;
      lockedOrUnknown++;
    }

    // Avoid duplicating a historical locked request already imported under its bare ID.
    const existingBare = store.getAttempt(reqId);
    if (existingBare && existingBare.status === 'permanently_locked') {
      store.recordHistoricalAttempt({
        attempt_id: reqId,
        account_scope: accountScope,
        provider,
        tool_name: req.tool,
        tool_version: 'historical',
        marketplace: extractMarketplace(reqParams),
        observation_cutoff_date: toDateOnly(req.started_at || req.created_at || req.finished_at, ledgerDate),
        page_or_cursor: extractPageOrCursor(reqParams),
        params: reqParams,
        stage: 'replay',
        status: 'permanently_locked',
        no_retry: true,
        ...charges,
        payload_sha256: artifact?.sha256 ?? null,
        raw_artifact_path: artifact?.safe_rel_path ?? null,
        source_ledger_ref: safeRef,
      });
      skipped++;
      continue;
    }

    // Namespace attempt_id by ledger directory ref + id so sub-ledgers with same-day numeric IDs never collide!
    const ledgerPrefix = safeRef ? sha256Hex(safeRef).slice(0, 8) : ledgerDate;
    const res = store.recordHistoricalAttempt({
      attempt_id: `${ledgerDate}:${ledgerPrefix}:${reqId}`,
      account_scope: accountScope,
      provider,
      tool_name: req.tool,
      tool_version: 'historical',
      marketplace: extractMarketplace(reqParams),
      observation_cutoff_date: toDateOnly(req.started_at || req.created_at || req.finished_at, ledgerDate),
      page_or_cursor: extractPageOrCursor(reqParams),
      params: reqParams,
      stage: 'replay',
      status: mappedStatus,
      no_retry: noRetry,
      ...charges,
      payload_sha256: artifact?.sha256 ?? null,
      raw_artifact_path: artifact?.safe_rel_path ?? toSafeRelativePath(req.path || req.response_path || req.receipt_path || req.raw_path, repoRoot),
      source_ledger_ref: safeRef,
      reconciliation_note: req.note || req.reason || (rawArtifactIsError ? 'Bound raw receipt reports isError:true; marked unknown_needs_reconciliation.' : (mappedStatus !== 'completed' ? `Imported historical ${rawStatus || execStatus}` : null)),
      created_at: req.started_at ?? req.created_at ?? (Array.isArray(data) ? null : data.started_at) ?? new Date().toISOString(),
      finished_at: req.finished_at ?? null,
    });
    if (res.inserted) inserted++;
    else skipped++;
  }

  return {
    ledger_ref: safeRef,
    total_entries: requests.length,
    inserted,
    skipped,
    locked_or_unknown: lockedOrUnknown,
    bound_artifacts: boundArtifacts,
  };
}

/**
 * Import renamed historical retained assets (forms + raw leads + links) from a JSON manifest.
 */
export function importRetainedAssetsManifest(store, manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('Retained assets manifest object is required.');
  const leads = Array.isArray(manifest.leads) ? manifest.leads : [];
  const forms = Array.isArray(manifest.forms) ? manifest.forms : [];
  const links = Array.isArray(manifest.links) ? manifest.links : [];

  return store.runInTransaction(() => {
    for (const lead of leads) store.upsertRawLead(lead);
    for (const form of forms) store.upsertCandidateForm(form);
    for (const link of links) store.linkLeadToForm(link);
    return {
      leads_processed: leads.length,
      forms_processed: forms.length,
      links_processed: links.length,
    };
  });
}

function reconstructVersionQualification(scored, profileRevision) {
  if (scored.qualification) return scored.qualification;
  if (scored.queue === 'comparable') {
    return {
      counts_toward_target: true,
      mode: 'comparable',
      primary_period_id: null,
      display_period_id: null,
      reasons: [`Reconstructed comparable qualification for historical revision ${profileRevision}.`],
    };
  }
  if (scored.queue === 'seasonal_review' && Array.isArray(scored.operating_periods)) {
    const hasPeak = scored.operating_periods.some(p =>
      Array.isArray(p.months) && HOLIDAY_PEAK_MONTHS.every(m => p.months.includes(m)),
    );
    const matchingOffPeak = scored.operating_periods.find(p => {
      if (p.queue !== 'comparable') return false;
      if (profileRevision < 57) return true;
      const monthsOk = Array.isArray(p.months) &&
        p.months.length === PRIMARY_OFF_PEAK_MONTHS.length &&
        PRIMARY_OFF_PEAK_MONTHS.every(m => p.months.includes(m));
      const scens = p.diagnostics?.economics?.scenarios;
      const datesOk = Array.isArray(scens) && scens.length > 0 && scens.every(sc => {
        const ctx = sc?.input?.cost_ledger?.fee_context ?? sc?.fee_context;
        const calc = sc?.input?.calculation;
        if (!ctx) return false;
        if (calc && (!calc.scoring_supported || calc.fee_validation?.status !== 'validated')) return false;
        return ctx.sales?.from === '2027-02-01' &&
          ctx.sales?.through === '2027-09-30' &&
          ctx.storage?.from === '2027-02-01' &&
          ctx.storage?.through === '2027-09-30' &&
          ctx.inbound?.from >= '2027-01-15' &&
          ctx.inbound?.through <= '2027-09-30';
      });
      const dateDepOk = p.screening?.conditions?.find(c => c.id === 'strong_date_dependency')?.status === 'pass';
      return monthsOk && datesOk && dateDepOk;
    });
    const isEligible = profileRevision >= 57 ? Boolean(hasPeak && matchingOffPeak) : Boolean(matchingOffPeak);
    if (isEligible) {
      return {
        counts_toward_target: true,
        mode: 'seasonal_eligible',
        primary_period_id: matchingOffPeak.id,
        display_period_id: matchingOffPeak.id,
        reasons: [`Reconstructed seasonal_eligible qualification under historical revision ${profileRevision}.`],
      };
    }
    const fallbackPeriod = scored.operating_periods[0]?.id ?? null;
    return {
      counts_toward_target: false,
      mode: 'none',
      primary_period_id: null,
      display_period_id: fallbackPeriod,
      reasons: [`Historical revision ${profileRevision} seasonal review did not satisfy eligibility criteria.`],
    };
  }
  return {
    counts_toward_target: false,
    mode: 'none',
    primary_period_id: null,
    display_period_id: null,
    reasons: [`Historical revision ${profileRevision} queue: ${scored.queue}.`],
  };
}

function findMatchingAttemptIdsForCandidate(store, inputCand, explicitAttemptIds, repoRoot) {
  const matched = new Set(explicitAttemptIds ?? []);
  const evidenceList = Array.isArray(inputCand?.evidence) ? inputCand.evidence : [];
  if (evidenceList.length === 0) return [...matched];

  const candidatePaths = new Set();
  for (const ev of evidenceList) {
    const rel = toSafeRelativePath(ev?.path, repoRoot);
    if (rel) candidatePaths.add(rel);
  }
  if (candidatePaths.size === 0) return [...matched];

  const rows = store.db.prepare(`
    SELECT attempt_id, raw_artifact_path
    FROM api_request_ledger
    WHERE raw_artifact_path IS NOT NULL
  `).all();
  for (const row of rows) {
    if (candidatePaths.has(row.raw_artifact_path)) matched.add(row.attempt_id);
  }
  return [...matched];
}

/**
 * Replay a batch (+ optional discovery bundle) atomically into SQLite:
 *  - Preserves existing live candidate_forms specs/lifecycle AND existing reviewed raw_leads dispositions!
 *  - Binds live FBA rate tables via getFba2027RateTableSnapshot() (single source of truth).
 *  - Merges newly imported historical source_attempt_ids and new batch_receipts on repeat replays.
 */
export function replayBatchIntoStore(store, {
  batch,
  profile,
  discovery = null,
  expected_result_sha256 = null,
  expected_html_sha256 = null,
  fee_table_snapshot = null,
  source_attempt_ids = [],
  repoRoot = process.cwd(),
} = {}) {
  if (!batch || typeof batch !== 'object') throw new TypeError('batch object is required.');
  if (!profile || typeof profile !== 'object') throw new TypeError('profile object is required.');

  const effectiveRev = Number(profile.revision ?? batch.profile_revision ?? 58);
  const effectiveFeeSnapshot = fee_table_snapshot ?? getFba2027RateTableSnapshot({ profileRevision: effectiveRev });
  const manifest = discovery ? prepareDiscovery(discovery.pool, discovery.decisions) : null;
  const boundBatch = manifest ? attachDiscovery(batch, manifest) : batch;
  const result = scoreBatch(boundBatch, profile);
  if (manifest) result.discovery = { ...manifest, summary: boundBatch.discovery_summary };

  const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const htmlBytes = Buffer.from(renderReport(result, boundBatch), 'utf8');
  const batchResultSha = sha256Hex(resultBytes);
  const batchHtmlSha = sha256Hex(htmlBytes);

  if (expected_result_sha256 && batchResultSha !== expected_result_sha256) {
    throw new Error(`Replay result.json SHA-256 mismatch: expected ${expected_result_sha256}, got ${batchResultSha}`);
  }
  if (expected_html_sha256 && batchHtmlSha !== expected_html_sha256) {
    throw new Error(`Replay index.html SHA-256 mismatch: expected ${expected_html_sha256}, got ${batchHtmlSha}`);
  }

  const storedEvaluations = store.runInTransaction(() => {
    const leadIdsByNormKey = new Map();
    if (manifest) {
      for (const lead of manifest.leads) {
        const provList = Array.isArray(lead.provenance) && lead.provenance.length > 0 ? lead.provenance : [];
        const idsForKey = [];
        for (const prov of provList) {
          const leadId = `disc:${sha256Hex(canonicalJson({ key: lead.normalized_key, prov })).slice(0, 16)}`;
          const chMeta = resolveChannelMeta(prov.source_id, prov.route ?? null, prov.entry_group ?? null);
          // Preserve any later human/review disposition update on an existing lead!
          store.upsertRawLead({
            lead_id: leadId,
            normalized_key: lead.normalized_key,
            event_dedup_key: `disc:${lead.normalized_key}:${prov.source_id}:${prov.row_index}`,
            source_channel: prov.source_id,
            route: chMeta.route,
            entry_group: chMeta.entry_group,
            opportunity_type: prov.opportunity_type ?? 'unclassified',
            source_ref: `${prov.source_path}#row=${prov.row_index}`,
            phrase_or_title: lead.keyword,
            observed_at: batch.evaluated_at || '2026-11-18',
            disposition: lead.disposition,
            disposition_reason: lead.reason,
            metadata: { phrases: lead.phrases, provenance_count: provList.length },
          }, { preserveExisting: true });
          idsForKey.push(leadId);
        }
        if (idsForKey.length > 0) leadIdsByNormKey.set(lead.normalized_key, idsForKey);
      }
    }

    const recorded = [];
    for (let i = 0; i < result.candidates.length; i++) {
      const scored = result.candidates[i];
      const candId = scored.candidate_id || scored.id || boundBatch.candidates[i]?.id;
      const inputCand = boundBatch.candidates.find(c => c.id === candId) ?? boundBatch.candidates[i];
      const formId = inputCand?.discovery?.form_id || candId;
      const label = inputCand?.discovery?.label || scored.label || scored.name || formId;
      const buyerTask = inputCand?.discovery?.description || inputCand?.saleable_unit || label;

      const { form } = store.upsertCandidateForm({
        form_id: formId,
        product_family_key: candId,
        label,
        buyer_task: buyerTask,
        saleable_set_composition: { saleable_unit: inputCand?.saleable_unit || label },
        lifecycle_status: 'evaluated',
      }, { preserveExisting: true });

      if (inputCand?.discovery?.lead_keywords) {
        inputCand.discovery.lead_keywords.forEach((normKey, idx) => {
          const lids = leadIdsByNormKey.get(normKey) ?? [];
          lids.forEach((lid, pIdx) => {
            store.linkLeadToForm({
              lead_id: lid,
              form_id: formId,
              link_role: idx === 0 && pIdx === 0 ? 'primary_discovery' : 'corroboration',
            });
          });
        });
      }

      // Hash the frozen batch's own spec snapshot so replaying an old batch never attaches stale scores to an upgraded live form spec.
      const replaySpecSha = sha256Hex(canonicalJson({
        buyer_task: buyerTask,
        saleable_set_composition: { saleable_unit: inputCand?.saleable_unit || label },
        grade_or_material: null,
        target_child_asin: null,
        leaf_node_path: null,
      }));
      const bundleHash = computeEvidenceBundleHash({
        form_spec_sha256: replaySpecSha,
        candidate_input: inputCand,
        discovery_manifest: manifest,
        profile_snapshot: profile,
        fee_table_snapshot: effectiveFeeSnapshot,
      });

      const perCandidateSha = sha256Hex(canonicalJson(scored));
      const qualification = reconstructVersionQualification(scored, profile.revision);
      const linkedAttempts = findMatchingAttemptIdsForCandidate(store, inputCand, source_attempt_ids, repoRoot);

      const periods = Array.isArray(scored.operating_periods) && scored.operating_periods.length > 0
        ? scored.operating_periods
        : [{
          id: 'annual',
          queue: scored.queue,
          covered_weight: scored.covered_weight,
          supported_range: scored.supported_range,
          total_range: scored.total_range,
        }];

      for (const p of periods) {
        const evRes = store.recordEvaluation({
          form_id: formId,
          period_id: p.id,
          profile_revision: profile.revision,
          evidence_bundle_sha256: bundleHash,
          qualification,
          sort_keys: {
            queue: p.queue ?? scored.queue,
            total_range: p.total_range ?? null,
            supported_range: p.supported_range ?? null,
            covered_weight: p.covered_weight ?? 0,
            candidate_id: candId,
          },
          queue_bucket: p.queue ?? scored.queue,
          covered_weight: p.covered_weight ?? 0,
          supported_range: p.supported_range ?? [0, 0],
          total_range: p.total_range ?? null,
          result_sha256: perCandidateSha,
          html_sha256: batchHtmlSha,
          receipt: {
            profile_revision: profile.revision,
            form_spec_sha256: replaySpecSha,
            batch_result_sha256: batchResultSha,
            batch_html_sha256: batchHtmlSha,
            summary: result.summary,
            batch_id: batch.batch_id ?? null,
          },
          source_attempt_ids: linkedAttempts,
        });
        recorded.push(evRes);
      }
    }
    return recorded;
  });

  return {
    result,
    result_bytes: resultBytes,
    html_bytes: htmlBytes,
    result_sha256: batchResultSha,
    html_sha256: batchHtmlSha,
    evaluations_recorded: storedEvaluations.length,
    summary: result.summary,
  };
}
