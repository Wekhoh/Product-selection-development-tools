import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { OpenAiBudgetLedger, reconcileLegacyBudgetIntoStore } from '../src/openai/budget-ledger.mjs';
import { OpenAiClient } from '../src/openai/client.mjs';

const MONTH = '2026-11';
const DIGEST = 'a'.repeat(64);
const MODEL = 'gpt-6.1-terra';

function createFixture(t, { monthlyLimitCents = 20_000, carryoverCents = 0, ...policy } = {}) {
  const dir = mkdtempSync(join(process.cwd(), '.openai-policy-test-'));
  const dbPath = join(dir, 'fixture.sqlite');
  const canonicalRegistryPath = join(dir, 'registry.sqlite');
  const openLedgers = [];
  let now = new Date(`${MONTH}-15T00:00:00Z`);
  const openLedger = (path = ':memory:', options = {}) => {
    const ledger = new OpenAiBudgetLedger(path, {
      testMode: true,
      canonicalRegistryPath,
      nowFn: () => now,
      ...options,
    });
    openLedgers.push(ledger);
    return ledger;
  };
  const closeLedger = (ledger) => {
    ledger.close();
    openLedgers.splice(openLedgers.indexOf(ledger), 1);
  };
  const source = {
    recognized_schema: true,
    file_sha256: DIGEST,
    month_utc: MONTH,
    total_rows: 0,
    unresolved_count: 0,
    same_month_reserved_cents: carryoverCents,
  };
  const reconcile = (ledger, overrides = {}) => reconcileLegacyBudgetIntoStore(ledger, source, {
    testMode: true,
    canonicalRegistryPath,
    allowSyntheticSummaryForTests: true,
    enable: true,
    monthlyLimitCents,
    autoRechargeOffConfirmed: true,
    hardMonthlyLimitConfirmed: true,
    ...policy,
    ...overrides,
  });
  t.after(() => {
    for (const ledger of openLedgers.reverse()) ledger.close();
    for (const path of [dbPath, canonicalRegistryPath]) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        rmSync(path + suffix, { force: true });
      }
    }
    rmdirSync(dir);
  });
  return { dbPath, openLedger, closeLedger, reconcile, setNow: (date) => { now = new Date(date); } };
}

function reserve(ledger, logicalRequestId, reservedCents = 1, options = {}) {
  return ledger.reserveBillableRequest({
    endpoint: '/v1/responses',
    model: MODEL,
    logicalRequestId,
    reservedCents,
    payloadSha256: DIGEST,
    ...options,
  });
}

test('missing legacy buffer reads as zero and is migrated in place while retaining existing policy', (t) => {
  const { dbPath, openLedger, closeLedger } = createFixture(t);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE openai_budget_policy (
        account_scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        monthly_limit_cents INTEGER NOT NULL
      );
      INSERT INTO openai_budget_policy VALUES ('openai-default', 0, 173);
    `);
  } finally {
    db.close();
  }
  const readOnly = openLedger(dbPath, { readOnly: true });
  assert.equal(readOnly.getPolicy().same_month_pending_buffer_cents, 0);
  assert.equal(readOnly.getMonthlySummary().same_month_pending_recovery_cents, 0);
  assert.equal(readOnly.db.prepare("PRAGMA table_info('openai_budget_policy')").all()
    .some(column => column.name === 'same_month_pending_buffer_cents'), false);
  closeLedger(readOnly);

  const ledger = openLedger(dbPath);
  const column = ledger.db.prepare("PRAGMA table_info('openai_budget_policy')").all()
    .find(column => column.name === 'same_month_pending_buffer_cents');
  assert.equal(column.type, 'INTEGER');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
  assert.equal(ledger.getPolicy().monthly_limit_cents, 173);
  assert.equal(ledger.getPolicy().same_month_pending_buffer_cents, 0);
  assert.throws(() => ledger.db.exec('UPDATE openai_budget_policy SET same_month_pending_buffer_cents = 2001'));
});

test('policy configuration and legacy reconciliation validate both buffer options and preserve omitted settings', (t) => {
  const { openLedger, reconcile } = createFixture(t);
  const ledger = openLedger();
  assert.equal(reconcile(ledger, { maxSameMonthPendingRecoveryCents: 2_000 }).same_month_pending_buffer_cents, 2_000);
  assert.equal(ledger.configurePolicy({ monthlyLimitCents: 200 }).same_month_pending_buffer_cents, 2_000);
  assert.equal(reconcile(ledger).same_month_pending_buffer_cents, 2_000);
  assert.equal(ledger.configurePolicy({ sameMonthPendingBufferCents: 40 }).same_month_pending_buffer_cents, 40);
  for (const value of [-1, 2_001, 1.5, '50', null]) {
    assert.throws(() => ledger.configurePolicy({ sameMonthPendingBufferCents: value }));
    assert.throws(() => reconcile(ledger, { maxSameMonthPendingRecoveryCents: value }));
  }
  assert.throws(() => ledger.configurePolicy({
    sameMonthPendingBufferCents: 40,
    maxSameMonthPendingRecoveryCents: 45,
  }));
  assert.equal(ledger.getPolicy().same_month_pending_buffer_cents, 40);
  assert.equal(reconcile(ledger, { sameMonthPendingBufferCents: 0 }).same_month_pending_buffer_cents, 0);
});

test('same-month pending reservations sum at the buffer boundary and stay in monthly committed cents', (t) => {
  const { openLedger, reconcile } = createFixture(t, { monthlyLimitCents: 18, carryoverCents: 4 });
  const ledger = openLedger();
  reconcile(ledger);
  const first = reserve(ledger, 'first', 3);
  ledger.markPendingRecovery(first.attempt_id);
  assert.throws(() => reserve(ledger, 'second', 2), { code: 'ACCOUNT_FENCED_PENDING_RECOVERY' });

  ledger.configurePolicy({ sameMonthPendingBufferCents: 7 });
  assert.throws(() => reserve(ledger, 'same-payload'), {
    code: 'DUPLICATE_PENDING_PAYLOAD',
    blocking_attempt_id: first.attempt_id,
  });
  const second = reserve(ledger, 'second', 2, { payloadSha256: 'b'.repeat(64) });
  assert.throws(() => reserve(ledger, 'concurrent'), {
    code: 'ACCOUNT_FENCED_PENDING_RECOVERY',
    blocking_attempt_id: second.attempt_id,
  });
  ledger.markPendingRecovery(second.attempt_id, { provisionalUsageCostMicros: 31_000 });
  const atBoundary = ledger.getStatus();
  assert.equal(atBoundary.monthly.same_month_pending_recovery_cents, 7);
  assert.equal(atBoundary.monthly.effective_committed_cents, 11);
  assert.equal(atBoundary.monthly.fenced, false);
  assert.deepEqual(atBoundary.monthly.blocking_attempt_ids, []);
  assert.equal(atBoundary.active_fences.length, 2);

  assert.throws(() => reserve(ledger, 'second', 1, { payloadSha256: 'b'.repeat(64) }), { code: 'DUPLICATE_LOGICAL_REQUEST' });
  assert.throws(() => reserve(ledger, 'over-monthly', 8, { payloadSha256: 'c'.repeat(64) }), { code: 'MONTHLY_BUDGET_EXCEEDED' });
  const third = reserve(ledger, 'third', 7, { payloadSha256: 'c'.repeat(64) });
  assert.equal(ledger.getMonthlySummary().remaining_cents, 0);
  ledger.markPendingRecovery(third.attempt_id);
  assert.equal(ledger.getMonthlySummary().same_month_pending_recovery_cents, 14);
  assert.throws(() => reserve(ledger, 'over-buffer'), { code: 'ACCOUNT_FENCED_PENDING_RECOVERY' });
});

test('same-month buffer never repeats an ambiguous Responses POST with an autogenerated logical ID', async t => {
  const { openLedger, reconcile } = createFixture(t, { sameMonthPendingBufferCents: 2_000 });
  const ledger = openLedger();
  reconcile(ledger);
  const sent = [];
  const client = new OpenAiClient({
    ledger,
    testMode: true,
    allowEnvKey: true,
    apiKeyEnvVar: 'SYNTHETIC_OPENAI_CREDENTIAL',
    env: { SYNTHETIC_OPENAI_CREDENTIAL: 'synthetic_nonproduction_credential' },
    fetchImpl: (url, init) => {
      assert.equal(new URL(url).pathname, '/v1/responses');
      assert.equal(init.method, 'POST');
      sent.push(JSON.parse(init.body).input);
      if (sent.length === 1) throw new TypeError('Synthetic timeout after dispatch');
      return Response.json({
        id: 'resp_distinct_fixture',
        status: 'completed',
        model: MODEL,
        usage: { input_tokens: 12, output_tokens: 4 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Checked.' }] }],
      });
    },
  });
  const request = { input: 'Review the first fixture.' };
  let first;
  await assert.rejects(client.createResponse(request), error => {
    first = ledger.getAttemptById(error.attempt_id);
    return error.code === 'PENDING_RECOVERY';
  });
  assert.ok(first.logical_request_id.startsWith('resp-req-'));
  assert.equal(first.status, 'pending_recovery');
  assert.equal(ledger.getMonthlySummary().fenced, false);
  await assert.rejects(client.createResponse({ ...request }), {
    code: 'DUPLICATE_PENDING_PAYLOAD',
    not_dispatched: true,
    blocking_attempt_id: first.attempt_id,
  });
  assert.deepEqual(sent, [request.input]);
  assert.equal(ledger.getMonthlySummary().status_counts.pending_recovery, 1);
  const distinctInput = 'Review a different fixture.';
  const distinct = await client.createResponse({ input: distinctInput });
  assert.equal(distinct.status, 'completed');
  assert.deepEqual(sent, [request.input, distinctInput]);
});

test('cleanup and cross-month holds fence admission even when their cost is inside the buffer', (t) => {
  const { openLedger, reconcile, setNow } = createFixture(t, { sameMonthPendingBufferCents: 20 });
  const ledger = openLedger();
  reconcile(ledger);
  const cleanup = reserve(ledger, 'cleanup', 1, { cleanupRequired: true });
  ledger.recordTerminalOutcome(cleanup.attempt_id, {
    status: 'completed',
    usageCostMicros: 1_000,
    providerResponseId: 'resp_cleanup',
    rawReceipt: { status: 'completed' },
  });
  assert.equal(ledger.getAttemptById(cleanup.attempt_id).terminal_outcome_status, 'completed');
  assert.throws(() => reserve(ledger, 'blocked-cleanup'), { code: 'ACCOUNT_FENCED_PENDING_RECOVERY' });
  reconcile(ledger, { accountScope: 'separate-scope' });
  const other = reserve(ledger, 'cross-month', 2, { accountScope: 'separate-scope' });
  ledger.markPendingRecovery(other.attempt_id);
  assert.equal(ledger.getMonthlySummary({ accountScope: 'separate-scope' }).fenced, false);
  setNow('2026-12-01T00:00:00Z');
  const summary = ledger.getMonthlySummary({ accountScope: 'separate-scope' });
  assert.equal(summary.same_month_pending_recovery_cents, 0);
  assert.equal(summary.cross_month_fenced_cents, 2);
  assert.equal(summary.effective_committed_cents, 2);
  assert.throws(() => reserve(ledger, 'next-month', 1, { accountScope: 'separate-scope' }), {
    code: 'ACCOUNT_FENCED_PENDING_RECOVERY',
  });
});

test('batch creation rechecks the pending buffer after file upload', (t) => {
  const { openLedger, reconcile } = createFixture(t, { sameMonthPendingBufferCents: 5 });
  const ledger = openLedger();
  const claim = (attempt, uploadedFileId) => ledger.claimBatchCreationStage(attempt.attempt_id, {
    accountScope: attempt.account_scope,
    uploadedFileId,
    batchPostSha256: DIGEST,
  });
  for (const accountScope of ['buffer-unchanged', 'buffer-reduced']) {
    reconcile(ledger, { accountScope });
    const pending = reserve(ledger, `${accountScope}-hold`, 5, { accountScope });
    ledger.markPendingRecovery(pending.attempt_id);
    const batch = reserve(ledger, `${accountScope}-batch`, 5, { accountScope, endpoint: '/v1/batches' });
    if (accountScope === 'buffer-unchanged') {
      assert.equal(claim(batch, 'file_ok').batch_manifest.dispatch_stage, 'batch_post_claimed');
    } else {
      ledger.configurePolicy({ accountScope, sameMonthPendingBufferCents: 4 });
      assert.throws(() => claim(batch, 'file_blocked'), { code: 'ACCOUNT_FENCED_PENDING_RECOVERY' });
      assert.equal(ledger.getAttemptById(batch.attempt_id).confirmed_zero_charge, true);
      assert.equal(ledger.getAttemptById(batch.attempt_id).batch_manifest, null);
      assert.equal(ledger.getMonthlySummary({ accountScope }).effective_committed_cents, 5);
    }
  }
});

test('background response ID and single cancel dispatch survive independent opens and stay scoped', (t) => {
  const { dbPath, openLedger, reconcile } = createFixture(t, { sameMonthPendingBufferCents: 20 });
  const ledger = openLedger(dbPath);
  reconcile(ledger);
  assert.throws(() => reserve(ledger, 'unstored-background', 1, { storeMode: false, backgroundMode: true }));
  assert.throws(() => reserve(ledger, 'non-response-background', 1, { endpoint: '/v1/batches', backgroundMode: true }));
  const attempt = reserve(ledger, 'background', 2, { backgroundMode: true });
  const bind = (providerResponseId) => ledger.recordBackgroundResponseId({ attemptId: attempt.attempt_id, providerResponseId });
  assert.throws(() => bind('resp_invalid/path'));
  assert.throws(() => {
    ledger.db.exec('BEGIN');
    try { bind('resp_background'); } finally { ledger.db.exec('ROLLBACK'); }
  }, { code: 'LEDGER_OUTER_TRANSACTION_FORBIDDEN' });
  assert.equal(ledger.getAttemptById(attempt.attempt_id).provider_response_id, null);
  assert.equal(bind('resp_background').provider_response_id, 'resp_background');
  const secondConnection = openLedger(dbPath);
  assert.equal(bind('resp_background').status, 'in_progress');
  assert.throws(() => bind('resp_foreign'), { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' });
  assert.equal(secondConnection.getAttemptByProviderResponseId('resp_background').background_mode, true);
  assert.equal(secondConnection.getAttemptByProviderResponseId('resp_background', { accountScope: 'other' }), null);
  assert.equal(secondConnection.getAttemptByProviderResponseId('resp_background').usage_cost_micros, null);

  reconcile(ledger, { accountScope: 'other' });
  const other = reserve(ledger, 'background-other', 1, { backgroundMode: true, accountScope: 'other' });
  const bindOther = (providerResponseId) => secondConnection.recordBackgroundResponseId({
    attemptId: other.attempt_id,
    providerResponseId,
    accountScope: 'other',
  });
  assert.throws(() => bindOther('resp_background'), { code: 'DUPLICATE_PROVIDER_RESPONSE_ID' });
  secondConnection.markPendingRecovery(other.attempt_id);
  assert.throws(() => bindOther('resp_unknown'), { code: 'UNVERIFIED_FIRST_PROVIDER_ID_ASSIGNMENT' });
  assert.equal(secondConnection.getAttemptById(other.attempt_id).provider_response_id, null);

  const cancellation = { attemptId: attempt.attempt_id, providerResponseId: 'resp_background' };
  assert.throws(() => secondConnection.recordBackgroundCancellationDispatch({
    ...cancellation,
    providerResponseId: 'resp_foreign',
  }), { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' });
  assert.throws(() => secondConnection.recordBackgroundCancellationDispatch({
    ...cancellation,
    accountScope: 'other',
  }), { code: 'ATTEMPT_SCOPE_MISMATCH' });
  ledger.markInterruptedAsPendingRecovery();
  assert.equal(secondConnection.recordBackgroundCancellationDispatch(cancellation).status, 'pending_recovery');
  assert.throws(() => ledger.recordBackgroundCancellationDispatch(cancellation), { code: 'BACKGROUND_CANCEL_ALREADY_DISPATCHED' });
  assert.equal(ledger.getAttemptById(attempt.attempt_id).background_cancel_dispatched_at, `${MONTH}-15T00:00:00.000Z`);
  assert.equal(ledger.getMonthlySummary().effective_committed_cents, 2);
});
