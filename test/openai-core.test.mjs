import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelectionStore, sha256Hex } from '../src/store.mjs';
import {
  MICROS_PER_CENT,
  MICROS_PER_DOLLAR,
  OpenAiPolicyError,
  OpenAiValidationError,
  computeUsageCostMicros,
  estimateCostBreakdown,
  estimateReservationCents,
  safeMicrosToNumber,
} from '../src/openai/pricing.mjs';
import {
  MAX_MONTHLY_LIMIT_CENTS,
  OpenAiBudgetError,
  OpenAiBudgetLedger,
  areSamePhysicalSqliteFile,
  extractMonthPrefix,
  inspectLegacyAutopilotBudget,
  reconcileLegacyBudgetIntoStore,
} from '../src/openai/budget-ledger.mjs';
import {
  OpenAiAmbiguousOutcomeError,
  OpenAiClient,
  buildBatchJsonl,
  estimateResponsesInputTokens,
  loadOpenAiApiKey,
  parseBatchOutputJsonl,
} from '../src/openai/client.mjs';

const SYNTHETIC_API_KEY = ['s' + 'k', 'proj', 'unitTestMockCredential000001'].join('-');
const SYNTHETIC_CUSTOM_SECRET = ['custom', 'opaque', 'secret', 'token987654'].join('_');
const VALID_1X1_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function withTempDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'openai-core-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
  }
}

function createActivatedMemoryLedger({
  accountScope = 'openai-default',
  monthUtc = '2026-11',
  monthlyLimitCents = 20_000,
  carryoverCents = 0,
  nowFn = null,
} = {}) {
  const ledger = new OpenAiBudgetLedger(':memory:', {
    nowFn: nowFn ?? (() => new Date(`${monthUtc}-15T12:00:00Z`)),
  });
  reconcileLegacyBudgetIntoStore(
    ledger,
    {
      recognized_schema: true,
      file_sha256: '0'.repeat(64),
      month_utc: monthUtc,
      total_rows: 0,
      status_counts: {},
      unresolved_count: 0,
      blocking_reasons: [],
      has_unresolved_holds: false,
      same_month_reserved_cents: carryoverCents,
    },
    {
      accountScope,
      enable: true,
      monthlyLimitCents,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    },
  );
  return ledger;
}

function makeJsonFetchResponse(status, payload, headersObj = { 'content-type': 'application/json' }) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headersObj),
    async text() {
      return text;
    },
    async arrayBuffer() {
      return Buffer.from(text, 'utf8');
    },
  };
}

test('pricing.mjs: exact microdollar math, cache-write ceiling, tier discounts/multipliers, and BigInt range guard', () => {
  assert.equal(MICROS_PER_DOLLAR, 1_000_000);
  assert.equal(MICROS_PER_CENT, 10_000);

  const lunaMicros = computeUsageCostMicros({
    model: 'gpt-6-luna',
    serviceTier: 'standard',
    usage: {
      input_tokens: 10_000,
      input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 2_000 },
      output_tokens: 1_000,
    },
  });
  assert.equal(lunaMicros, 1_190);

  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6-luna',
      serviceTier: 'batch',
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 },
        output_tokens: 0,
      },
    }),
    1,
  );

  // output_tokens ALREADY includes reasoning_tokens — never double-counted
  const terraWithReasoning = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    usage: {
      input_tokens: 50_000,
      output_tokens: 20_000,
      output_tokens_details: { reasoning_tokens: 16_000 },
    },
  });
  const terraWithoutReasoning = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    usage: {
      input_tokens: 50_000,
      output_tokens: 20_000,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
  assert.equal(terraWithReasoning, 150_000);
  assert.equal(terraWithReasoning, terraWithoutReasoning);

  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra-2026-11-01',
      serviceTier: 'default',
      usage: {
        input_tokens: 50_000,
        output_tokens: 20_000,
        output_tokens_details: { reasoning_tokens: 16_000 },
      },
      webSearchCalls: 3,
    }),
    180_000,
  );

  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      serviceTier: 'batch',
      usage: { input_tokens: 50_000, output_tokens: 20_000, output_tokens_details: { reasoning_tokens: 18_000 } },
      webSearchCalls: 3,
    }),
    105_000,
  );
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      serviceTier: 'flex',
      usage: { input_tokens: 50_000, output_tokens: 20_000 },
    }),
    75_000,
  );
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      serviceTier: 'fast',
      usage: { input_tokens: 300_000, output_tokens: 10_000 },
    }),
    1_350_000,
  );

  const terraReservedOmitted = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 4_096,
  });
  assert.equal(terraReservedOmitted.estimated_micros, 290_960);
  assert.equal(terraReservedOmitted.reservation_cents, 30);

  const terraReservedDefault = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 4_096,
  });
  assert.equal(terraReservedDefault.estimated_micros, 145_480);
  assert.equal(terraReservedDefault.reservation_cents, 15);

  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.2-sol',
      usage: {
        input_tokens: 100_000,
        input_tokens_details: { cached_tokens: 50_000, cache_write_tokens: 10_000 },
        output_tokens: 5_000,
      },
    }),
    160_000,
  );

  // Removed Stage-4 media models are rejected cleanly as unknown/unpriced
  for (const removedModel of ['gpt-image-2.6-sunburst', 'tts', 'gpt-4o-mini-tts']) {
    assert.throws(
      () => computeUsageCostMicros({ model: removedModel, usage: { input_tokens: 100, output_tokens: 100 } }),
      err => err instanceof OpenAiValidationError && err.code === 'UNKNOWN_OPENAI_MODEL',
    );
  }

  assert.equal(safeMicrosToNumber(0n), 0);
  assert.equal(safeMicrosToNumber(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => safeMicrosToNumber(-1n),
    err => err instanceof OpenAiValidationError && err.code === 'COST_OVERFLOW_UNSAFE_INTEGER',
  );
  assert.throws(
    () => safeMicrosToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    err => err instanceof OpenAiValidationError && err.code === 'COST_OVERFLOW_UNSAFE_INTEGER',
  );
  assert.throws(
    () => computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 51 } },
    }),
    OpenAiValidationError,
  );
  assert.throws(
    () => computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 30 }, output_tokens: 50 },
    }),
    OpenAiValidationError,
  );
  assert.throws(
    () => computeUsageCostMicros({ model: 'gpt-6.1-terra', usage: {} }),
    OpenAiValidationError,
  );
});

test('pricing.mjs & client.mjs: gpt-6.2-astra and gpt-6-astra are hard-blocked on paid HTTP API by default', async () => {
  for (const astraModel of ['gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.2-astra-2026-11-01']) {
    assert.throws(
      () => estimateReservationCents({
        endpoint: '/v1/responses',
        model: astraModel,
        estimatedInputTokens: 1_000,
        maxOutputTokens: 4_096,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'ASTRA_API_BLOCKED' && err.not_dispatched === true,
    );
  }

  assert.equal(
    estimateReservationCents({
      endpoint: '/v1/responses',
      model: 'gpt-6.2-astra',
      serviceTier: 'standard',
      estimatedInputTokens: 10_000,
      maxOutputTokens: 5_000,
      allowAstraApi: true,
    }),
    30,
  );

  const ledger = createActivatedMemoryLedger();
  let fetchCount = 0;
  const client = new OpenAiClient({
    ledger,
    allowEnvKey: true,
    apiKeyEnvVar: 'MOCK_OPENAI_KEY',
    env: { MOCK_OPENAI_KEY: SYNTHETIC_API_KEY },
    fetchImpl: async () => {
      fetchCount++;
      throw new Error('Should not be called');
    },
  });

  await assert.rejects(
    () => client.createResponse({ model: 'gpt-6.2-astra', input: 'Audit this packet.' }),
    err => err instanceof OpenAiPolicyError && err.code === 'ASTRA_API_BLOCKED',
  );
  assert.equal(fetchCount, 0);
  assert.equal(ledger.getStatus({ monthUtc: '2026-11' }).total_requests, 0);
  ledger.close();
});

test('budget-ledger.mjs: strictly read-only inspection (immutable + private WAL snapshot), collision guards, $200 ceiling, and fail-closed revocation', async () => {
  await withTempDirAsync(async dir => {
    const missingDir = join(dir, 'nested-missing');
    const missingDb = join(missingDir, 'budget.sqlite3');
    assert.throws(
      () => inspectLegacyAutopilotBudget(missingDb, { monthUtc: '2026-11' }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_DB_UNREADABLE',
    );
    assert.equal(existsSync(missingDir), false);

    const emptyDbPath = join(dir, 'empty-unrelated.sqlite3');
    const emptyDb = new DatabaseSync(emptyDbPath);
    emptyDb.exec('CREATE TABLE ledger_attempts (attempt_id TEXT PRIMARY KEY, status TEXT, cost_units INTEGER);');
    emptyDb.close();
    assert.throws(
      () => inspectLegacyAutopilotBudget(emptyDbPath, { monthUtc: '2026-11' }),
      err => err instanceof OpenAiBudgetError && err.code === 'UNRECOGNIZED_LEGACY_BUDGET_SCHEMA' && err.not_dispatched === true,
    );

    const subDir = join(dir, 'legacy autopilot dir');
    mkdirSync(subDir, { recursive: true });
    const cleanLegacyPath = join(subDir, 'budget.sqlite3');

    const setupClean = new DatabaseSync(cleanLegacyPath);
    try {
      setupClean.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE reservations (
          request_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          reserved_cents INTEGER NOT NULL,
          confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE operation_locks (
          lock_name TEXT PRIMARY KEY,
          is_locked INTEGER NOT NULL,
          released_at TEXT
        );
      `);
      const ins = setupClean.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)');
      ins.run('leg-oct-tz', 'completed', 45, 0, '2026-11-01T00:30:00+02:00');
      ins.run('leg-nov-1', 'completed', 120, 0, '2026-11-04T09:00:00Z');
      ins.run('leg-nov-2', 'settled', 80, 0, '2026-11-12 14:30:00');
      ins.run('leg-nov-3', 'released', 30, 1, '2026-11-13T08:00:00Z');
      setupClean.prepare('INSERT INTO operation_locks VALUES (?, ?, ?)').run('global', 0, '2026-11-12T14:31:00Z');
    } finally {
      setupClean.close();
    }

    assert.equal(extractMonthPrefix('2026-11-01T00:30:00+02:00'), '2026-10');
    assert.equal(extractMonthPrefix('2026-10-31T23:30:00-02:00'), '2026-11');
    assert.equal(extractMonthPrefix('2026-02-31'), null);

    const filesBefore = readdirSync(subDir).sort();
    const bytesBefore = readFileSync(cleanLegacyPath);
    const shaBefore = sha256Hex(bytesBefore);

    const summary = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-11' });
    assert.equal(sha256Hex(readFileSync(cleanLegacyPath)), shaBefore);
    assert.deepEqual(readdirSync(subDir).sort(), filesBefore);
    assert.equal(summary.same_month_reserved_cents, 200);

    assert.throws(
      () => reconcileLegacyBudgetIntoStore(cleanLegacyPath, cleanLegacyPath, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );

    const junctionDir = join(dir, 'junction-alias');
    symlinkSync(subDir, junctionDir, process.platform === 'win32' ? 'junction' : 'dir');
    const junctionDbPath = join(junctionDir, 'budget.sqlite3');
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(junctionDbPath, cleanLegacyPath),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );

    const sharedDbPath = join(dir, 'selection.sqlite');
    const selStore = openSelectionStore(sharedDbPath);
    selStore.close();

    assert.equal(MAX_MONTHLY_LIMIT_CENTS, 20_000);
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(sharedDbPath, summary, {
        accountScope: 'openai-default',
        enable: true,
        monthlyLimitCents: 20_001,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'MONTHLY_LIMIT_EXCEEDS_CEILING',
    );

    const reconciledPolicy = reconcileLegacyBudgetIntoStore(sharedDbPath, summary, {
      accountScope: 'openai-default',
      enable: true,
      monthlyLimitCents: 250,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    });
    assert.equal(reconciledPolicy.enabled, true);

    const octSummary = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-10' });
    reconcileLegacyBudgetIntoStore(sharedDbPath, octSummary, { accountScope: 'openai-default' });

    const writableLedger = new OpenAiBudgetLedger(sharedDbPath, {
      testMode: true,
      nowFn: () => new Date('2026-11-21T12:00:00Z'),
    });
    try {
      const novSummary = writableLedger.getMonthlySummary({ monthUtc: '2026-11' });
      assert.equal(novSummary.legacy_carryover_cents, 200);
      assert.equal(novSummary.remaining_cents, 50);

      // Accumulate 50c realized spend -> hits 250c monthly limit -> next call blocked with MONTHLY_BUDGET_EXCEEDED
      const att = writableLedger.reserveBillableRequest({
        logicalRequestId: 'spend-50c-req',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: 'a'.repeat(64),
        reservedCents: 0,
      });
      writableLedger.recordTerminalOutcome(att.attempt_id, {
        status: 'completed',
        usageCostMicros: 500_000,
        rawReceipt: { status: 'completed' },
      });
      assert.equal(writableLedger.getMonthlySummary({ monthUtc: '2026-11' }).remaining_cents, 0);
      assert.throws(
        () => writableLedger.reserveBillableRequest({
          logicalRequestId: 'over-limit-req',
          endpoint: '/v1/responses',
          model: 'gpt-6.1-terra',
          payloadSha256: 'b'.repeat(64),
          reservedCents: 0,
        }),
        err => err instanceof OpenAiBudgetError && err.code === 'MONTHLY_BUDGET_EXCEEDED',
      );
    } finally {
      writableLedger.close();
    }
  });
});

test('budget-ledger.mjs: cross-month timeout auto-archiving (no lockout), UTC clock lock, credential binding, and outer-tx rejection', async () => {
  let currentClock = new Date('2026-10-15T12:00:00Z');
  const ledger = createActivatedMemoryLedger({
    monthUtc: '2026-10',
    monthlyLimitCents: 20_000,
    nowFn: () => currentClock,
  });

  try {
    assert.throws(
      () => ledger.reserveBillableRequest({
        logicalRequestId: 'spoof-month-req',
        monthUtc: '2026-12',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: '9'.repeat(64),
        reservedCents: 0,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'MONTH_CLOCK_OVERRIDE_FORBIDDEN',
    );

    const octAttempt = ledger.reserveBillableRequest({
      logicalRequestId: 'oct-ambiguous-1',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: '1'.repeat(64),
      reservedCents: 0,
    });
    ledger.recordProviderResponseId(octAttempt.attempt_id, 'resp_oct_001');
    assert.throws(
      () => ledger.recordProviderResponseId(octAttempt.attempt_id, 'resp_oct_DIFFERENT'),
      err => err instanceof OpenAiBudgetError && err.code === 'PROVIDER_RESPONSE_ID_IMMUTABLE',
    );

    const pendingOct = ledger.markPendingRecovery(octAttempt.attempt_id, {
      provisionalUsageCostMicros: 330_000,
      reason: 'Gateway timeout in October.',
    });
    assert.equal(pendingOct.status, 'pending_recovery');

    // Advance clock to November 2026: October timeout is auto-archived and NEVER locks out November calls!
    currentClock = new Date('2026-11-02T00:05:00Z');
    const novSummary = ledger.getMonthlySummary({ monthUtc: '2026-11' });
    assert.equal(novSummary.fenced, false);
    assert.equal(novSummary.archived_prior_month_timeouts.length, 1);

    const novAllowed = ledger.reserveBillableRequest({
      logicalRequestId: 'nov-allowed-req',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: '3'.repeat(64),
      reservedCents: 0,
    });
    assert.equal(novAllowed.status, 'in_progress');

    // Reconcile October attempt cleanly with explicit confirmedZeroCharge: true or usageCostMicros
    assert.throws(
      () => ledger.reconcileAttempt(octAttempt.attempt_id, {
        status: 'failed_known',
        postedBilledCents: 0,
        note: 'Missing zero-charge proof!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'USAGE_REDUCTION_FORBIDDEN',
    );
    const settledOct = ledger.reconcileAttempt(octAttempt.attempt_id, {
      status: 'completed',
      usageCostMicros: 330_000,
      postedBilledCents: 33,
      note: 'Settled 33-cent timeout hold.',
    });
    assert.equal(settledOct.status, 'completed');
    assert.equal(settledOct.posted_billed_cents, 33);

    // Local scope credential binding & key rotation without home-dir registry lockfile
    const fpA = sha256Hex('cred-alpha');
    const fpB = sha256Hex('cred-beta');
    ledger.bindCredentialFingerprint('openai-default', fpA, { isLiveTransport: false });
    assert.throws(
      () => ledger.bindCredentialFingerprint('second-scope', fpA, { isLiveTransport: false }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_SCOPE_SPLIT_FORBIDDEN',
    );
    assert.throws(
      () => ledger.bindCredentialFingerprint('openai-default', fpB, { isLiveTransport: false }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_SCOPE_MISMATCH',
    );

    const rawMemDb = new DatabaseSync(':memory:');
    try {
      rawMemDb.exec('BEGIN');
      assert.throws(
        () => new OpenAiBudgetLedger(rawMemDb),
        err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_OUTER_TRANSACTION_FORBIDDEN',
      );
      rawMemDb.exec('ROLLBACK');
    } finally {
      rawMemDb.close();
    }
  } finally {
    ledger.close();
  }
});

test('client.mjs: createDecision enforces cumulative <=256KiB input_json, strict non-positional ID matching, and usable=false on all-refusal', async () => {
  const ledger = createActivatedMemoryLedger();
  let fetchCalls = 0;
  let mockDecisionPayload = null;

  try {
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        fetchCalls++;
        assert.equal(url, 'https://api.openai.com/v1/decisions');
        assert.equal(init.redirect, 'error');
        return makeJsonFetchResponse(200, mockDecisionPayload);
      },
    });

    await assert.rejects(
      () => client.createDecision({
        input: [
          { type: 'input_json', json: { part1: 'a'.repeat(145_000) } },
          { type: 'input_json', json: { part2: 'b'.repeat(145_000) } },
        ],
        questions: [{ id: 'q1', type: 'predicate', question: 'Valid?' }],
      }),
      err => err instanceof OpenAiValidationError && err.code === 'INPUT_JSON_TOO_LARGE',
    );

    await assert.rejects(
      () => client.createDecision({
        input: [{ type: 'input_image', image_url: 'https://example.com/remote.png' }],
        questions: [{ id: 'q1', type: 'predicate', question: 'Valid?' }],
      }),
      err => err instanceof OpenAiValidationError && err.code === 'REMOTE_IMAGE_URL_FORBIDDEN',
    );
    assert.equal(fetchCalls, 0);

    mockDecisionPayload = {
      id: 'dec_001',
      model: 'gpt-6-luna-2026-11-01',
      decisions: [
        { id: 'q_ambiguous', type: 'refusal', refusal: 'Occluded contact-sheet tile cannot be classified.' },
        { id: 'q_cluster', type: 'choice', value: 'exact_peer' },
        { id: 'q_prohibited', type: 'predicate', value: false },
      ],
      usage: {
        input_tokens: 2_000,
        input_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 0 },
        output_tokens: 120,
      },
    };

    const result = await client.createDecision({
      logical_request_id: 'stage1-dec-batch-1',
      prompt_cache_key: 'stage1-triage-v1',
      prompt_cache_options: { ttl: '30m' },
      input: [
        { type: 'input_text', text: 'Classify tile #01.' },
        { type: 'input_image', image_url: `data:image/png;base64,${VALID_1X1_PNG_B64}`, detail: 'high' },
        { type: 'input_json', json: { candidate_id: 'cand-01', price_usd: 44.99 } },
      ],
      questions: [
        { id: 'q_prohibited', type: 'predicate', question: 'Is children or medical?' },
        { id: 'q_cluster', type: 'choice', question: 'Visual cluster?', options: ['exact_peer', 'unclear_needs_zoom'] },
        { id: 'q_ambiguous', type: 'score', question: 'Confidence 0..1?', min: 0, max: 1 },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.usable, true);
    assert.equal(result.refusal_count, 1);
    assert.equal(result.by_question_id.q_prohibited.value, false);
    assert.equal(result.by_question_id.q_cluster.value, 'exact_peer');
    assert.equal(result.usage_cost_micros, 170);

    mockDecisionPayload = {
      id: 'dec_002',
      model: 'gpt-6-luna',
      decisions: [{ type: 'predicate', value: false }],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    const noIdRes = await client.createDecision({
      logical_request_id: 'stage1-dec-noid',
      input: 'Check candidate.',
      questions: [{ id: 'q_only', type: 'predicate', question: 'Is prohibited?' }],
    });
    assert.equal(noIdRes.usable, false);
    assert.equal(noIdRes.content_status, 'invalid');
  } finally {
    ledger.close();
  }
});

test('client.mjs: Terra xhigh guards, web_search allowlist, and non-blocking DELETE cleanup lifecycle', async () => {
  await withTempDirAsync(async dir => {
    const credPath = join(dir, 'openai-cred.json');
    writeFileSync(credPath, JSON.stringify({ api_key: SYNTHETIC_API_KEY }), 'utf8');
    assert.equal(loadOpenAiApiKey({ credentialFile: credPath }), SYNTHETIC_API_KEY);

    const largeText = 'x'.repeat(250_000);
    const estTokens = estimateResponsesInputTokens(
      {
        model: 'gpt-6.1-terra',
        input: [
          { type: 'input_text', text: largeText },
          { type: 'input_image', image_url: `data:image/png;base64,${VALID_1X1_PNG_B64}`, detail: 'high' },
        ],
        tools: [{ type: 'web_search' }],
        max_tool_calls: 3,
      },
      3,
    );
    assert.ok(estTokens > 272_000);

    const ledger = createActivatedMemoryLedger();
    try {
      const client = new OpenAiClient({
        ledger,
        credentialFile: credPath,
        fetchImpl: async (url, init) => {
          assert.equal(init.redirect, 'error');
          if (init.method === 'POST' && url.endsWith('/v1/responses')) {
            const wire = JSON.parse(init.body);
            if (wire.input === 'TRIGGER_BARE_DELETE_404') {
              return makeJsonFetchResponse(200, {
                id: 'resp_bare_404',
                status: 'completed',
                model: 'gpt-6.1-terra',
                output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
                usage: { input_tokens: 1_000, output_tokens: 500 },
              });
            }
            return makeJsonFetchResponse(200, {
              id: 'resp_clean_del_1',
              status: 'completed',
              model: 'gpt-6.1-terra',
              output: [
                { type: 'web_search_call', id: 'ws_1', status: 'completed' },
                { type: 'message', content: [{ type: 'output_text', text: '{"verdict":"exact_match"}' }] },
              ],
              usage: {
                input_tokens: 4_000,
                output_tokens: 2_000,
                output_tokens_details: { reasoning_tokens: 1_800 },
              },
            });
          }
          if (init.method === 'DELETE' && url.endsWith('/v1/responses/resp_bare_404')) {
            return makeJsonFetchResponse(404, { error: { message: 'Not found' } });
          }
          if (init.method === 'DELETE' && url.endsWith('/v1/responses/resp_clean_del_1')) {
            return makeJsonFetchResponse(200, { id: 'resp_clean_del_1', deleted: true });
          }
          if (init.method === 'GET' && url.endsWith('/v1/responses/resp_clean_del_1')) {
            return makeJsonFetchResponse(404, { error: { message: 'Response not found' } });
          }
          throw new Error(`Unexpected mock call: ${init.method} ${url}`);
        },
      });

      for (const badTools of [
        { tools: [{ type: 'code_interpreter' }] },
        { tools: [{ type: 'file_search' }] },
        { tools: [{ type: 'mcp' }] },
      ]) {
        await assert.rejects(
          () => client.createResponse({ input: 'Test tools', ...badTools }),
          OpenAiValidationError,
        );
      }

      const cleanRes = await client.createResponse(
        { logical_request_id: 'req-clean-with-delete', input: 'Verify peer spec.', tools: [{ type: 'web_search' }], max_tool_calls: 2 },
        { deleteAfterPersist: true },
      );
      assert.equal(cleanRes.ok, true);
      assert.equal(cleanRes.status, 'completed');
      assert.equal(cleanRes.cleanup.status, 'deleted_verified_404');
      assert.equal(cleanRes.cleanup.verified_404, true);

      // Remote DELETE failure records delete_failed WITHOUT demoting status='completed' or locking out the account!
      const bare404Res = await client.createResponse(
        { logical_request_id: 'req-bare-del-404', input: 'TRIGGER_BARE_DELETE_404' },
        { deleteAfterPersist: true },
      );
      assert.equal(bare404Res.ok, true);
      assert.equal(bare404Res.usable, true);
      assert.equal(bare404Res.status, 'completed');
      assert.equal(bare404Res.cleanup.status, 'delete_failed');
      assert.equal(ledger.getMonthlySummary({ monthUtc: '2026-11' }).fenced, false);
    } finally {
      ledger.close();
    }
  });
});

test('client.mjs: origin lock, secret scrubbing on corrupt JSON, bounded streams, and recoverPendingResponse', async () => {
  const ledger = createActivatedMemoryLedger();

  try {
    let mode = 'corrupt_200_json_with_secret';
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_CUSTOM_SECRET },
      fetchImpl: async (url, init) => {
        if (mode === 'corrupt_200_json_with_secret') {
          return makeJsonFetchResponse(200, `<<<CORRUPT_BODY key=${SYNTHETIC_CUSTOM_SECRET}>>>`);
        }
        if (mode === 'oversized_stream') {
          let chunksSent = 0;
          const chunk = new Uint8Array(5 * 1024 * 1024);
          const stream = new ReadableStream({
            pull(controller) {
              chunksSent++;
              if (chunksSent > 5) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (mode === '502_with_known_id' && init.method === 'POST') {
          return makeJsonFetchResponse(502, { id: 'resp_known_777', error: { message: 'Upstream gateway error' } });
        }
        if (mode === 'recover_wrong_id' && init.method === 'GET') {
          return makeJsonFetchResponse(200, {
            id: 'resp_SPOOFED_OTHER',
            status: 'completed',
            model: 'gpt-6.1-terra',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
            usage: { input_tokens: 100, output_tokens: 100 },
          });
        }
        if (mode === 'recover_200_completed' && init.method === 'GET') {
          return makeJsonFetchResponse(200, {
            id: 'resp_known_777',
            status: 'completed',
            model: 'gpt-6.1-terra',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
            usage: { input_tokens: 1_000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 300 } },
          });
        }
        throw new Error(`Unexpected call in mode=${mode}: ${init.method} ${url}`);
      },
    });

    await assert.rejects(
      () => client.createResponse({ input: 'Hello' }, { baseUrl: 'https://evil-collector.example.com' }),
      err => err instanceof OpenAiPolicyError && err.code === 'BASE_ORIGIN_MISMATCH',
    );

    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => client.createResponse({ input: 'Hello' }, { signal: preAborted.signal }),
      err => err instanceof OpenAiValidationError && err.code === 'SIGNAL_ALREADY_ABORTED' && err.not_dispatched === true,
    );

    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'req-corrupt-200', input: 'Spec check 1' }),
      OpenAiAmbiguousOutcomeError,
    );
    const corruptRow = ledger.getAttempt('req-corrupt-200');
    assert.equal(corruptRow.status, 'pending_recovery');
    assert.ok(corruptRow.raw_body_text.includes('[REDACTED_TOKEN]'));
    assert.equal(corruptRow.raw_body_text.includes(SYNTHETIC_CUSTOM_SECRET), false);

    mode = 'oversized_stream';
    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'req-oversized-stream', input: 'Spec check 2' }),
      OpenAiAmbiguousOutcomeError,
    );
    assert.equal(ledger.getAttempt('req-oversized-stream').status, 'pending_recovery');

    mode = '502_with_known_id';
    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'req-known-502', input: 'Spec check 3' }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.provider_response_id === 'resp_known_777',
    );

    mode = 'recover_wrong_id';
    await assert.rejects(
      () => client.recoverPendingResponse('req-known-502'),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.code === 'PROVIDER_RESPONSE_ID_MISMATCH',
    );

    mode = 'recover_200_completed';
    const rec200 = await client.recoverPendingResponse('req-known-502');
    assert.equal(rec200.recovered, true);
    assert.equal(rec200.status, 'completed');
    assert.equal(rec200.fenced, false);
    assert.equal(rec200.attempt.usage_cost_micros, 3_500);
  } finally {
    ledger.close();
  }
});

test('client.mjs: Batch /v1/responses JSONL manifest, /v1/files durable upload binding, custom_id verification, and idempotent retrieveBatch', async () => {
  const built = buildBatchJsonl([
    {
      custom_id: 'social-lead-01',
      url: '/v1/responses',
      body: { input: 'Extract product form from Reddit post.' },
      estimatedInputTokens: 2_000,
    },
    {
      custom_id: 'social-lead-02',
      url: '/v1/responses',
      body: { input: 'Extract product form from Pinterest pin.' },
      estimatedInputTokens: 2_000,
    },
  ]);

  assert.equal(built.line_count, 2);
  assert.equal(built.estimated_micros, 330_180);
  assert.equal(built.estimated_reservation_cents, 34);

  // /v1/images/generations is rejected cleanly in slimmed Batch builder
  assert.throws(
    () => buildBatchJsonl([{ custom_id: 'img-1', url: '/v1/images/generations', body: { prompt: 'tray' } }]),
    OpenAiValidationError,
  );

  const mixedBatchOut = parseBatchOutputJsonl([
    JSON.stringify({
      id: 'br_err_ws',
      custom_id: 'err-with-ws',
      response: {
        status_code: 500,
        body: {
          model: 'gpt-6.1-terra',
          output: [{ type: 'web_search_call', id: 'ws_err_1' }],
          usage: { input_tokens: 2_000, output_tokens: 1_000 },
        },
      },
      error: { message: 'Failed after tool call' },
    }),
    JSON.stringify({
      id: 'br_unknown',
      custom_id: 'err-no-usage',
      response: { status_code: 500, body: {} },
      error: { message: 'Gateway timeout' },
    }),
  ].join('\n'));
  assert.equal(mixedBatchOut.has_unknown_usage, true);
  assert.equal(mixedBatchOut.total_usage_cost_micros, null);
  assert.equal(mixedBatchOut.known_usage_cost_micros, 13_500);

  const ledger = createActivatedMemoryLedger();
  try {
    let batchStepMode = 'normal';
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        if (init.method === 'POST' && url.endsWith('/v1/files')) {
          if (batchStepMode === 'files_409') {
            return makeJsonFetchResponse(409, { error: { message: 'Conflict on file upload' } });
          }
          if (batchStepMode === 'batches_timeout_after_upload') {
            return makeJsonFetchResponse(200, { id: 'file_uploaded_timeout_1' });
          }
          return makeJsonFetchResponse(200, { id: 'file_uploaded_999' });
        }
        if (init.method === 'POST' && url.endsWith('/v1/batches')) {
          if (batchStepMode === 'batches_timeout_after_upload') {
            throw new Error('POST /v1/batches network timeout after file upload');
          }
          return makeJsonFetchResponse(200, { id: 'batch_resp_1', status: 'validating', input_file_id: 'file_uploaded_999' });
        }
        if (init.method === 'GET' && url.endsWith('/v1/batches/batch_resp_1')) {
          return makeJsonFetchResponse(200, {
            id: 'batch_resp_1',
            endpoint: '/v1/responses',
            input_file_id: 'file_uploaded_999',
            status: 'completed',
            output_file_id: 'file_resp_out_1',
            request_counts: { total: 1, completed: 1, failed: 0 },
          });
        }
        if (init.method === 'GET' && url.endsWith('/v1/files/file_resp_out_1/content')) {
          const cid = batchStepMode === 'wrong_custom_id' ? 'foreign-cid' : 'resp-c1';
          return makeJsonFetchResponse(
            200,
            `${JSON.stringify({
              id: 'br_resp_1',
              custom_id: cid,
              response: {
                status_code: 200,
                body: {
                  id: 'resp_batch_item_1',
                  status: 'completed',
                  model: 'gpt-6.1-terra',
                  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
                  usage: { input_tokens: 2_000, output_tokens: 1_000 },
                },
              },
              error: null,
            })}\n`,
          );
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await assert.rejects(
      () => client.submitBatch({ input_file_id: 'file_123', estimated_reservation_cents: 5 }),
      err => err instanceof OpenAiPolicyError && err.code === 'UNBOUND_BATCH_INPUT_FILE' && err.not_dispatched === true,
    );

    batchStepMode = 'files_409';
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'batch-files-409',
        requests: [{ custom_id: 'c1', url: '/v1/responses', body: { input: 'Item 1' } }],
      }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.http_status === 409,
    );
    assert.equal(ledger.getAttempt('batch-files-409').status, 'pending_recovery');

    batchStepMode = 'batches_timeout_after_upload';
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'batch-upload-saved',
        requests: [{ custom_id: 'c1', url: '/v1/responses', body: { input: 'Item 2' } }],
      }),
      OpenAiAmbiguousOutcomeError,
    );
    assert.equal(ledger.getAttempt('batch-upload-saved').batch_manifest.uploaded_file_id, 'file_uploaded_timeout_1');

    batchStepMode = 'normal';
    const respBatchSub = await client.submitBatch({
      logical_request_id: 'batch-resp-live-1',
      endpoint: '/v1/responses',
      requests: [{ custom_id: 'resp-c1', url: '/v1/responses', body: { input: 'Verify batch item.' } }],
    });
    assert.equal(respBatchSub.status, 'pending_recovery');

    batchStepMode = 'wrong_custom_id';
    await client.retrieveBatch('batch_resp_1', {
      downloadOutput: true,
      attemptId: respBatchSub.attempt_id,
    });
    assert.equal(ledger.getAttempt(respBatchSub.attempt_id).status, 'pending_recovery');

    batchStepMode = 'normal';
    const settledBatch = await client.retrieveBatch('batch_resp_1', {
      downloadOutput: true,
      attemptId: respBatchSub.attempt_id,
    });
    assert.equal(settledBatch.parsed_output.total_usage_cost_micros, 3_500);
    assert.equal(ledger.getAttempt(respBatchSub.attempt_id).status, 'completed');

    const idempotentBatch = await client.retrieveBatch('batch_resp_1', {
      downloadOutput: true,
      attemptId: respBatchSub.attempt_id,
    });
    assert.equal(idempotentBatch.already_settled, true);
  } finally {
    ledger.close();
  }
});

test('budget-ledger.mjs: _migrateSchema upgrades pre-remediation tables, migrates reserved_cents >= 0, and restores cleanup-demoted completed rows', () => {
  const rawDb = new DatabaseSync(':memory:');
  try {
    rawDb.exec(`
      CREATE TABLE openai_budget_policy (
        account_scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        monthly_limit_cents INTEGER NOT NULL DEFAULT 20000,
        legacy_reconciled INTEGER NOT NULL DEFAULT 0,
        legacy_reconciled_month_utc TEXT,
        legacy_carryover_cents INTEGER NOT NULL DEFAULT 0,
        legacy_source_sha256 TEXT,
        legacy_summary_json TEXT,
        legacy_reconciled_at TEXT,
        allow_stage4_media INTEGER NOT NULL DEFAULT 0,
        policy_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_budget_policy VALUES (
        'openai-default', 0, 20000, 1, '2026-11', 620,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '{}', '2026-11-21T00:00:00Z', 0, NULL, '2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z'
      );
      CREATE TABLE openai_request_ledger (
        attempt_id TEXT PRIMARY KEY,
        logical_request_id TEXT NOT NULL UNIQUE,
        account_scope TEXT NOT NULL,
        month_utc TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        service_tier TEXT NOT NULL DEFAULT 'standard',
        payload_sha256 TEXT NOT NULL,
        packet_sha256 TEXT,
        status TEXT NOT NULL,
        content_status TEXT,
        reserved_cents INTEGER NOT NULL CHECK(reserved_cents >= 1),
        estimated_input_tokens INTEGER,
        max_output_tokens INTEGER,
        max_web_search_calls INTEGER NOT NULL DEFAULT 0,
        usage_cost_micros INTEGER,
        posted_billed_cents INTEGER,
        confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        provider_response_id TEXT,
        provider_model TEXT,
        http_status INTEGER,
        cleanup_status TEXT,
        terminal_outcome_status TEXT,
        raw_receipt_json TEXT,
        raw_receipt_sha256 TEXT,
        diagnostic_reason TEXT,
        reconciliation_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO openai_request_ledger (
        attempt_id, logical_request_id, account_scope, month_utc, endpoint, model,
        payload_sha256, status, reserved_cents, usage_cost_micros, cleanup_status,
        terminal_outcome_status, created_at, updated_at
      ) VALUES (
        'att-old-del-fail', 'log-old-del-fail', 'openai-default', '2026-11', '/v1/responses', 'gpt-6.1-terra',
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'pending_recovery', 5, 20000, 'delete_failed', 'completed',
        '2026-11-21T01:00:00Z', '2026-11-21T01:05:00Z'
      );
    `);

    const migrated = new OpenAiBudgetLedger(rawDb, {
      testMode: true,
      nowFn: () => new Date('2026-11-21T12:00:00Z'),
    });
    assert.equal(migrated.getAttemptById('att-old-del-fail').status, 'completed');
    assert.equal(migrated.getMonthlySummary({ monthUtc: '2026-11' }).legacy_carryover_cents, 620);

    migrated.configurePolicy({
      enabled: true,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    });
    const att = migrated.reserveBillableRequest({
      logicalRequestId: 'post-mig-req-1',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: 'b'.repeat(64),
      reservedCents: 0,
    });
    migrated.recordTerminalOutcome(att.attempt_id, {
      status: 'completed',
      contentStatus: 'usable',
      usageCostMicros: 30_000,
      providerResponseId: 'resp_mig_1',
      rawReceipt: { id: 'resp_mig_1', status: 'completed' },
    });
    const reconciled = migrated.reconcileAttempt(att.attempt_id, {
      postedBilledCents: 0,
      note: 'Covered by promotional credit; usage still counts toward $200 allowance.',
    });
    assert.equal(reconciled.usage_cost_micros, 30_000);
    // 620c carryover + 2c (att-old-del-fail 20_000 micros) + 3c (30_000 micros) = 625c
    assert.equal(migrated.getMonthlySummary({ monthUtc: '2026-11' }).effective_committed_cents, 625);
  } finally {
    rawDb.close();
  }
});

test('Live-API parity: /v1/decisions accepts answers[] with array probabilities, normalizes wire schema, and honors constructor timeoutMs', async () => {
  const ledger = createActivatedMemoryLedger();
  let capturedWire = null;
  try {
    const client = new OpenAiClient({
      ledger,
      timeoutMs: 360_000,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (_url, init) => {
        capturedWire = JSON.parse(init.body);
        return makeJsonFetchResponse(200, {
          model: 'gpt-6-luna',
          answers: [
            { name: 'gate0_prohibited_SYNTH-PEER-001', type: 'predicate', probability: 0 },
            {
              name: 'visual_peer_SYNTH-PEER-001',
              type: 'choice',
              choice: 'exact_peer',
              confidence: 0.65,
              probabilities: [
                { value: 'exact_peer', probability: 0.65 },
                { value: 'different_mechanism', probability: 0.30 },
                { value: 'accessory_or_consumable_decoy', probability: 0.03 },
                { value: 'unclear_needs_zoom', probability: 0.02 },
              ],
            },
          ],
          usage: {
            input_tokens: 10_000,
            input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 10_000,
          },
        });
      },
    });
    assert.equal(client.defaultTimeoutMs, 360_000);

    const res = await client.createDecision({
      logical_request_id: 'live-parity-luna-array-probs',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Triage synthetic fixtures.' },
            { type: 'input_json', data: { candidates: [{ candidate_id: 'SYNTH-PEER-001' }] } },
          ],
        },
      ],
      questions: [
        { id: 'gate0_prohibited_SYNTH-PEER-001', name: 'gate0_prohibited_SYNTH-PEER-001', type: 'predicate', instructions: 'Prohibited?' },
        {
          id: 'visual_peer_SYNTH-PEER-001',
          name: 'visual_peer_SYNTH-PEER-001',
          type: 'choice',
          instructions: 'Peer cluster?',
          choices: [
            { value: 'exact_peer', description: 'Same mechanism' },
            { value: 'different_mechanism', description: 'Different mechanism' },
            { value: 'accessory_or_consumable_decoy', description: 'Decoy' },
            { value: 'unclear_needs_zoom', description: 'Needs zoom' },
          ],
        },
      ],
    });

    assert.equal(res.ok, true);
    assert.equal(res.usable, true);
    assert.equal(res.usage_cost_micros, 640);
    assert.equal('max_output_tokens' in capturedWire, false);
    assert.equal('id' in capturedWire.questions[0], false);
    assert.equal(capturedWire.questions[0].name, 'gate0_prohibited_SYNTH-PEER-001');
  } finally {
    ledger.close();
  }
});
