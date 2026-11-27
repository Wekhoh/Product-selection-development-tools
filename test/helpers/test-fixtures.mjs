/**
 * Shared synthetic fixture builders, CLI capture, temp-directory, and OpenAI test helpers.
 * Pure synthetic identifiers only (zero real ASINs, 1688 offers, or PII).
 */
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOpenAiBudgetLedger } from '../../src/openai/budget-ledger.mjs';
import { openSelectionStore as rawOpenSelectionStore } from '../../src/store.mjs';
import { runPhase2Cli } from '../../src/phase2-cli.mjs';

export {
  STAGE4_AS_OF_DATE,
  makeSteadyPeer,
  makeGate1AScenario,
  registerStage4Form,
  makeDatedKeepaReceipt,
  makeSpApiCatalogItem,
  makeSpApiFeesEstimate,
  makeStage4OrganizerTrayCandidate,
} from './stage4-fixtures.mjs';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const R59_PROFILE_RAW = JSON.parse(
  readFileSync(join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'), 'utf8'),
);
const SYNTHETIC_BATCH_RAW = JSON.parse(
  readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic-batch.json'), 'utf8'),
);

export function loadR59Profile() {
  return structuredClone(R59_PROFILE_RAW);
}

export function loadSyntheticBatch() {
  return structuredClone(SYNTHETIC_BATCH_RAW);
}

export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
export const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_B64}`;

export function removeTemporaryFixtureDirectory(dir) {
  try {
    const makeWritable = p => {
      try { chmodSync(p, 0o700); } catch { /* ignore */ }
      try {
        if (statSync(p).isDirectory()) {
          for (const f of readdirSync(p)) makeWritable(join(p, f));
        }
      } catch { /* ignore */ }
    };
    makeWritable(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
  } catch { /* ignore Windows AV file lock */ }
}

export function withTempDir(prefixOrFn, maybeFn) {
  const hasPrefix = typeof prefixOrFn === 'string';
  const prefix = hasPrefix ? prefixOrFn : 'test-tmp-';
  const fn = hasPrefix ? maybeFn : prefixOrFn;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let primaryErr = null;
  try {
    return fn(dir);
  } catch (err) {
    primaryErr = err;
    throw err;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
    } catch (rmErr) {
      if (!primaryErr) throw rmErr;
    }
  }
}

export async function withTempDirAsync(prefixOrFn, maybeFn) {
  const hasPrefix = typeof prefixOrFn === 'string';
  const prefix = hasPrefix ? prefixOrFn : 'test-tmp-';
  const fn = hasPrefix ? maybeFn : prefixOrFn;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let primaryErr = null;
  try {
    return await fn(dir);
  } catch (err) {
    primaryErr = err;
    throw err;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
    } catch (rmErr) {
      if (!primaryErr) throw rmErr;
    }
  }
}

export function makeCapturingStreams() {
  let out = '';
  let err = '';
  return {
    stdout: { write(chunk) { out += String(chunk); } },
    stderr: { write(chunk) { err += String(chunk); } },
    getOut: () => out,
    getErr: () => err,
  };
}

export async function runCliMem(args, testHooks = undefined) {
  let stdout = '';
  let stderr = '';
  const code = await runPhase2Cli(
    args,
    {
      stdout: { write(chunk) { stdout += String(chunk); } },
      stderr: { write(chunk) { stderr += String(chunk); } },
    },
    testHooks,
  );
  return { code, stdout, stderr };
}

export function makeActivatedTestBudgetDb(dir, optsOrName = {}) {
  const opts = typeof optsOrName === 'string' ? { name: optsOrName } : (optsOrName ?? {});
  const {
    name = 'budget.sqlite',
    apiKey = 'sk-proj-synthetic-test-key-0123456789ABCDEF',
    monthUtc = new Date().toISOString().slice(0, 7),
    monthlyLimitCents = 20_000,
  } = opts;
  const dbPath = join(dir, name);
  const credPath = join(dir, 'cred.json');
  writeFileSync(credPath, JSON.stringify({ api_key: apiKey }));
  const ledgerOpts = { testMode: true };
  const ledger = openOpenAiBudgetLedger(dbPath, ledgerOpts);
  ledger.reconcileLegacySummary(
    {
      recognized_schema: true,
      file_sha256: '0'.repeat(64),
      month_utc: monthUtc,
      total_rows: 0,
      status_counts: {},
      unresolved_count: 0,
      blocking_reasons: [],
      has_unresolved_holds: false,
      same_month_reserved_cents: 0,
    },
    {
      accountScope: 'openai-default',
      allowSyntheticSummaryForTests: true,
      enable: true,
      monthlyLimitCents,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    },
  );
  ledger.close();
  return { dbPath, credPath, ledgerOpts };
}

export function makeBatchOutputLine(customId, text, { inputTokens = 1000, outputTokens = 500, model = 'gpt-6.1-terra' } = {}) {
  return JSON.stringify({
    id: `br_${customId}`,
    custom_id: customId,
    response: {
      status_code: 200,
      body: {
        id: `resp_${customId}`,
        status: 'completed',
        model,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
    },
    error: null,
  });
}

export function makeBatchErrorLine(customId, message = 'Rate limit exceeded', statusCode = 429) {
  return JSON.stringify({
    id: `br_err_${customId}`,
    custom_id: customId,
    response: {
      status_code: statusCode,
      body: { error: { message } },
    },
    error: { code: 'rate_limit_exceeded', message },
  });
}

export function makeJsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': typeof body === 'string' ? 'application/jsonl' : 'application/json' },
  });
}

export const DEFAULT_R59_UI_READBACK = Object.freeze({
  logged_in: true,
  viewport_width_px: 1440,
  selected_sku_row_visible: true,
  settlement_bar_visible: true,
  applied_quantity_confirmed: true,
});

export function openSelectionStoreWithDefaultUiReadback(dbPath, opts) {
  const s = rawOpenSelectionStore(dbPath, opts);
  const orig = s.recordSourcingQuote1688.bind(s);
  s.recordSourcingQuote1688 = q =>
    orig(q && typeof q === 'object' && q.ui_readback === undefined ? { ...q, ui_readback: DEFAULT_R59_UI_READBACK } : q);
  return s;
}

export function makeOffPeakDeclaredScreenInputs(scenario) {
  return {
    profile_revision: 59,
    id: scenario.id,
    saleable_unit: '1 unit',
    price_usd: scenario.price_usd,
    fx_cny_per_usd: scenario.fx_cny_per_usd,
    headhaul: { usd_per_unit: scenario.headhaul_usd, bond_included: true },
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    fulfillment_usd: scenario.fulfillment_usd,
    placement_usd: scenario.placement_range_usd[1],
    operating_period: 'off_peak',
    other_applicable_usd: 0,
    specific_rights_conflict: 'unknown',
    strong_date_dependency: false,
  };
}

export function makeOversizeScreeningInputs(overrides = {}) {
  return {
    price_usd: 45,
    fx_cny_per_usd: 7.2,
    headhaul_usd: 4.0,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-25' },
    ...overrides,
  };
}

export function makeSeasonalCandidate(baseCandidateOrId, idOrOptions = {}, maybeOptions = {}) {
  const isIdFirst = typeof baseCandidateOrId === 'string';
  const baseCandidate = isIdFirst ? SYNTHETIC_BATCH_RAW.candidates[0] : baseCandidateOrId;
  const id = isIdFirst ? baseCandidateOrId : idOrOptions;
  const {
    offPeakFrom = '2027-02-01',
    offPeakThrough = '2027-09-30',
    includePeak = true,
    reversePeriods = false,
  } = (isIdFirst ? idOrOptions : maybeOptions) ?? {};
  const c = structuredClone(baseCandidate);
  c.id = id;
  c.label = `合成季节款 ${id}`;
  const off = structuredClone(c.economics.scenarios[0]);
  off.id = off.cost_ledger.id = 'sc-regular';
  off.cost_ledger.fee_context.sales = { from: offPeakFrom, through: offPeakThrough };
  off.cost_ledger.fee_context.storage = { from: offPeakFrom, through: offPeakThrough };
  off.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-01-15' };
  for (const l of off.cost_ledger.lines.filter(x => x.fee_basis)) {
    l.fee_basis.effective_from = '2027-01-15';
    l.fee_basis.effective_through = l.id === 'fulfillment' ? '2027-10-14' : '2027-12-31';
  }
  const peak = structuredClone(off);
  peak.id = peak.cost_ledger.id = 'sc-peak';
  peak.cost_ledger.fee_context.sales = peak.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
  Object.assign(peak.cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null,
    status: 'pending',
    fee_basis: { status: 'unavailable', version: 'Unpublished 2027 peak fulfillment' },
  });
  const offPeriod = { id: 'off_peak', label: '2027年2–9月淡季', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [off] };
  const peakPeriod = { id: 'peak', label: '2027年10–12月旺季', months: [10, 11, 12], scenarios: [peak] };
  c.economics = {
    saleable_unit: c.economics.saleable_unit,
    operating_periods: includePeak ? (reversePeriods ? [peakPeriod, offPeriod] : [offPeriod, peakPeriod]) : [offPeriod],
  };
  return c;
}
