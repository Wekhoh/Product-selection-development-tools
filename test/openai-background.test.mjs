import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpenAiBudgetLedger,
  OpenAiClient,
  buildBatchJsonl,
  buildWorkflowTaskRequest,
  computeUsageCostMicros,
  estimateCostBreakdown,
  estimateReservationCents,
  parseBatchOutputJsonl,
  reconcileLegacyBudgetIntoStore,
} from '../src/openai/index.mjs';

const monthUtc = '2026-11';
const now = () => new Date(`${monthUtc}-20T15:10:00Z`);
const model = 'gpt-6.1-terra';
const defaultOptions = { pollIntervalMs: 0 };
const keyName = 'SYNTHETIC_OPENAI_CREDENTIAL';
const syntheticKey = ['synthetic', 'nonproduction', 'credential'].join('_');

function makeClient(t, fetchImpl, { ledger, ...options } = {}) {
  if (!ledger) {
    ledger = new OpenAiBudgetLedger(':memory:', { nowFn: now });
    t.after(() => ledger.close());
    reconcileLegacyBudgetIntoStore(ledger, {
      recognized_schema: true,
      file_sha256: '0'.repeat(64),
      month_utc: monthUtc,
      total_rows: 0,
      status_counts: {},
      unresolved_count: 0,
      blocking_reasons: [],
      has_unresolved_holds: false,
      same_month_reserved_cents: 0,
    }, {
      enable: true,
      monthlyLimitCents: 20_000,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    });
  }
  return new OpenAiClient({
    ledger,
    testMode: true,
    apiKeyEnvVar: keyName,
    allowEnvKey: true,
    env: { [keyName]: syntheticKey },
    nowFn: now,
    ...options,
    fetchImpl: (url, init) => {
      assert.equal(init.redirect, 'error');
      return fetchImpl(new URL(url).pathname, init);
    },
  });
}

function search(id, query, status = 'completed') {
  return { id, type: 'web_search_call', status, action: { type: 'search', query } };
}

function action(id, type) {
  return { id, type: 'web_search_call', status: 'completed', action: { type } };
}

const usage = { input_tokens: 100, output_tokens: 200 };

function payload(id, status, output = [], exactUsage = null) {
  return { id, status, model, service_tier: 'default', usage: exactUsage, output };
}

function terminal(id, searches = []) {
  return payload(id, 'completed', [
    ...searches,
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reviewed.' }] },
  ], usage);
}

test('uncapped Responses and Batch reserve configurable estimates while sending no cap', async t => {
  const request = { input: 'Check the public evidence.', tools: [{ type: 'web_search' }], service_tier: 'standard' };
  const wires = [];
  const client = makeClient(t, (path, init) => {
    assert.equal(path, '/v1/responses');
    wires.push(JSON.parse(init.body));
    return Response.json(terminal(`resp_synthetic_${wires.length}`));
  });
  const def = await client.createResponse(request);
  const custom = await client.createResponse({ ...request, max_tool_calls: null }, {
    uncappedWebSearchReservationCalls: 32,
  });
  const explicit = await client.createResponse({ ...request, tools: [{ type: 'web_search', max_tool_calls: 7 }] });
  assert.deepEqual(wires.map(wire => wire.max_tool_calls), [undefined, undefined, 7]);
  assert.deepEqual(wires.map(wire => wire.max_output_tokens), [65_536, 65_536, 65_536]);
  assert.ok(wires.every(wire => !Object.hasOwn(wire.tools[0], 'max_tool_calls')));
  assert.deepEqual([def, custom, explicit].map(result =>
    client.ledger.getAttemptById(result.attempt_id).max_web_search_calls), [25, 32, 7]);
  assert.ok(custom.reserved_cents > def.reserved_cents);
  for (const maxToolCalls of [0, '8', 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.createResponse({ ...request, max_tool_calls: maxToolCalls }), { code: 'INVALID_WEB_SEARCH_MAX_TOOL_CALLS' });
  }
  assert.equal(wires.length, 3);
  await assert.rejects(client.createResponse({
    ...request, max_tool_calls: null, tools: [{ type: 'web_search', max_tool_calls: 7 }],
  }), /Conflicting max_tool_calls/);

  const line = { custom_id: 'prescreen-fixture', body: { ...request, max_tool_calls: null } };
  const batch = buildBatchJsonl([line]);
  const larger = buildBatchJsonl([line], { uncappedWebSearchReservationCalls: 30 });
  assert.ok(larger.estimated_reservation_cents > batch.estimated_reservation_cents);
  assert.equal(Object.hasOwn(JSON.parse(batch.jsonl).body, 'max_tool_calls'), false);
  assert.equal(JSON.parse(buildBatchJsonl([{ ...line, body: { ...request, max_tool_calls: 8 } }]).jsonl).body.max_tool_calls, 8);
  assert.throws(() => buildBatchJsonl([{ ...line, body: { ...request, background: true } }]), /already run asynchronously/);

  const input = { form_id: 'form-fixture', label: 'Fixture bracket', buyer_task: 'Hold a sample vertically' };
  const rights = buildWorkflowTaskRequest('gate2_rights_prescreen', input);
  assert.equal(rights.max_output_tokens, 65_536);
  assert.equal(Object.hasOwn(rights, 'max_tool_calls'), false);
  assert.match(rights.input[0].content[0].text, /2–3 distinct search angles.*no_public_hit_observed.*needs_verification/s);
  assert.equal(buildWorkflowTaskRequest('rights-prescreen', input, { maxToolCalls: 9 }).max_tool_calls, 9);
});

test('direct pricing estimates resolve omitted, null, and explicit web search caps', () => {
  const estimate = { model, estimatedInputTokens: 100, maxOutputTokens: 200, serviceTier: 'default' };
  const withWeb = { ...estimate, tools: [{ type: 'web_search' }] };
  const baseline = estimateCostBreakdown(estimate);
  assert.equal(estimateCostBreakdown(withWeb).estimated_micros - baseline.estimated_micros, 250_000);
  assert.equal(estimateReservationCents({ ...withWeb, maxWebSearchCalls: null }), baseline.reservation_cents + 25);
  assert.equal(estimateReservationCents({ ...withWeb, max_tool_calls: null, uncappedWebSearchReservationCalls: 31 }),
    baseline.reservation_cents + 31);
  assert.equal(estimateReservationCents({ ...withWeb, max_tool_calls: 8, maxWebSearchCalls: 8 }),
    baseline.reservation_cents + 8);
  assert.equal(estimateReservationCents({ ...estimate, maxWebSearchCalls: 8 }), baseline.reservation_cents + 8);
  assert.throws(() => estimateReservationCents({ ...withWeb, max_tool_calls: 8, maxWebSearchCalls: null }), /Conflicting/);
  assert.throws(() => estimateReservationCents({ ...withWeb, max_tool_calls: 0 }), /positive safe integer/);
  assert.throws(() => estimateReservationCents({ ...withWeb, uncappedWebSearchReservationCalls: -1 }), /positive safe integer/);
});

test('background Responses bind the ID before polling and settle actual search calls after transient GET errors', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'openai-progress-test-'));
  const progressFile = join(temp, 'progress.json');
  t.after(() => {
    try { unlinkSync(progressFile); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    rmdirSync(temp);
  });
  const id = 'resp_background_fixture';
  const phone = ['138', '0013', '8000'].join('');
  const email = ['example', '@', 'example.invalid'].join('');
  const outputs = [
    search('ws_one', 'Fixture bracket patent'),
    search('ws_two', ' FIXTURE    bracket patent '),
    search('ws_three', 'fixture bracket patent'),
    search('ws_four', 'fixture bracket patent'),
    search('ws_private', `query ${syntheticKey} ${phone} ${email}`),
    action('ws_open', 'open_page'),
    action('ws_find', 'find_in_page'),
    action('ws_legacy', undefined),
  ];
  const methods = [];
  const events = [];
  const boundAtGet = [];
  let wire;
  let gets = 0;
  const client = makeClient(t, (path, init) => {
    methods.push(init.method);
    if (init.method === 'POST') {
      wire = JSON.parse(init.body);
      return Response.json(payload(id, 'queued', outputs.slice(0, 1)));
    }
    assert.equal(path, `/v1/responses/${id}`);
    boundAtGet.push(client.ledger.getAttemptByProviderResponseId(id)?.status);
    gets++;
    if (gets === 1 || gets === 3) return Response.json({ error: { message: 'Temporary' } }, { status: 503 });
    if (gets === 2) return Response.json(payload(id, 'in_progress', outputs.slice(0, 4)));
    return Response.json(terminal(id, outputs));
  });
  const result = await client.createResponse({
    input: 'Check the public evidence.',
    store: false,
    tools: [{ type: 'web_search' }],
  }, {
    ...defaultOptions,
    background: true,
    progressFile,
    onProgress: snapshot => events.push(snapshot),
    uncappedWebSearchReservationCalls: 2,
  });
  assert.deepEqual(methods, ['POST', 'GET', 'GET', 'GET', 'GET']);
  assert.deepEqual(boundAtGet, ['in_progress', 'in_progress', 'in_progress', 'in_progress']);
  assert.equal(wire.background, true);
  assert.equal(wire.store, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.usable, true);
  assert.equal(result.web_search_calls, 6);
  assert.equal(result.usage_cost_micros, computeUsageCostMicros({ model, usage, webSearchCalls: 6 }));
  assert.equal(client.ledger.getAttemptById(result.attempt_id).usage.web_search_calls, 6);
  assert.deepEqual(events.map(snapshot => snapshot.status), ['queued', 'queued', 'in_progress', 'in_progress', 'completed']);
  assert.deepEqual(events.map(snapshot => snapshot.poll_count), [0, 1, 2, 3, 4]);
  assert.ok(events.every(snapshot => snapshot.provider_response_id === id));
  assert.equal(events[2].repeated_query_loop_warning, true);
  const last = JSON.parse(readFileSync(progressFile, 'utf8'));
  assert.deepEqual(last, events.at(-1));
  assert.deepEqual(last.action_counts, { search: 5, open_page: 1, find_in_page: 1, unknown: 1 });
  assert.equal(last.observed_web_search_calls, 8);
  assert.equal(last.billable_web_search_calls_observed, 6);
  assert.equal(last.elapsed_ms, 0);
  assert.equal(last.started_at, now().toISOString());
  assert.deepEqual(readdirSync(temp), ['progress.json']);
  for (const sensitive of [phone, syntheticKey, email]) {
    assert.ok(!JSON.stringify(events).includes(sensitive));
  }
});

test('background polling stops after five consecutive GET errors and resumes from the same stored ID', async t => {
  const id = 'resp_resumable_fixture';
  let postCount = 0;
  let getCount = 0;
  const client = makeClient(t, (path, init) => {
    if (init.method === 'POST') {
      postCount++;
      return Response.json(payload(id, 'queued'));
    }
    getCount++;
    if (getCount === 1) throw new TypeError('Synthetic connection failure');
    return Response.json({ error: { message: 'Throttled' } }, { status: 429 });
  });
  const result = await client.createResponse({ background: true, input: 'Inspect fixture.' }, {
    ...defaultOptions,
    waitForCompletion: false,
  });
  assert.equal(result.response_status, 'queued');
  assert.equal(result.status, 'in_progress');
  assert.equal(getCount, 0);
  await assert.rejects(
    client.pollBackgroundResponse({ attemptId: result.attempt_id, ...defaultOptions }),
    error => error.code === 'BACKGROUND_POLL_INTERRUPTED' && error.provider_response_id === id,
  );
  assert.equal(getCount, 5);
  assert.equal(postCount, 1);
  assert.equal(client.ledger.getAttemptById(result.attempt_id).status, 'pending_recovery');
  assert.equal(client.ledger.getAttemptById(result.attempt_id).usage_cost_micros, null);

  let resumed = 0;
  const resumedClient = makeClient(t, (path, init) => {
    assert.equal(init.method, 'GET');
    resumed++;
    return Response.json(resumed === 1 ? payload(id, 'in_progress') : terminal(id));
  }, { ledger: client.ledger });
  assert.equal((await resumedClient.recoverPendingResponse(result.attempt_id)).fenced, true);
  const settled = await resumedClient.pollBackgroundResponse(result.attempt_id, defaultOptions);
  assert.equal(settled.status, 'completed');
  const repeated = await resumedClient.pollBackgroundResponse(result.attempt_id, defaultOptions);
  assert.equal(repeated.already_settled, true);
  assert.equal(repeated.output_text, settled.output_text);
  assert.equal(resumed, 2);
});

test('zero and finite local waits detach without cancelling or changing the durable hold', { timeout: 3_000 }, async t => {
  const id = 'resp_detached_fixture';
  const calls = [];
  const lateGet = Promise.withResolvers();
  let detachedSignal;
  let gets = 0;
  const client = makeClient(t, (path, init) => {
    calls.push([init.method, path]);
    if (init.method === 'POST') return Response.json(payload(id, 'queued'));
    assert.equal(init.method, 'GET');
    assert.equal(path, `/v1/responses/${id}`);
    if (++gets === 1) {
      detachedSignal = init.signal;
      return lateGet.promise;
    }
    return Response.json(terminal(id));
  });
  const request = { background: true, input: 'Inspect the detach fixture.' };
  for (const maxWaitMs of [-1, 1.5, '10', Infinity, 2_147_483_648]) {
    await assert.rejects(client.createResponse(request, { maxWaitMs }), /maxWaitMs/);
  }
  const submitted = await client.createResponse(request, { maxWaitMs: 0 });
  assert.equal(submitted.local_wait_timed_out, true);
  assert.equal(submitted.response_status, 'queued');
  assert.equal(submitted.provider_response_id, id);
  assert.deepEqual(calls, [['POST', '/v1/responses']]);

  const noPoll = await client.pollBackgroundResponse(submitted.attempt_id, { maxWaitMs: 0, ...defaultOptions });
  assert.equal(noPoll.local_wait_timed_out, true);
  const detachedInDelay = await client.pollBackgroundResponse(submitted.attempt_id, {
    maxWaitMs: 10, pollIntervalMs: 60_000,
  });
  assert.equal(detachedInDelay.local_wait_timed_out, true);
  assert.equal(gets, 0);

  const detachedInGet = await client.pollBackgroundResponse(submitted.attempt_id, {
    maxWaitMs: 100, ...defaultOptions,
  });
  assert.equal(detachedInGet.local_wait_timed_out, true);
  assert.equal(gets, 1);
  assert.equal(detachedSignal.aborted, true);
  // The first GET transport ignores abort and returns a stale, foreign receipt.
  lateGet.resolve(Response.json(terminal('resp_foreign_detach_fixture')));
  const beforeResume = client.ledger.getAttemptById(submitted.attempt_id);
  assert.equal(beforeResume.status, 'in_progress');
  assert.equal(beforeResume.diagnostic_reason, null);
  assert.equal(beforeResume.provider_response_id, id);
  assert.equal(beforeResume.background_cancel_dispatched_at, null);
  assert.equal(client.ledger.getMonthlySummary().effective_committed_cents, submitted.reserved_cents);

  const settled = await client.pollBackgroundResponse(submitted.attempt_id, { maxWaitMs: null, ...defaultOptions });
  assert.equal(settled.status, 'completed');
  assert.equal(settled.provider_response_id, id);
  assert.equal(settled.local_wait_timed_out, undefined);
  assert.deepEqual(calls.map(([method]) => method), ['POST', 'GET', 'GET']);
});

async function verifyActiveCostFence(t, partialCounters) {
  const id = 'resp_observed_usage_fixture';
  const searches = Array.from({ length: 80 }, (_, i) => search(`ws_observed_${i}`, 'Fixture search'));
  const largerUsage = partialCounters ? { input_tokens: 150_000, output_tokens: 1024 } : { ...usage, web_search_calls: 100 };
  const activeMicros = computeUsageCostMicros({ model, usage: largerUsage, webSearchCalls: partialCounters ? 80 : 100 });
  const snapshots = [];
  let posts = 0;
  let gets = 0;
  const client = makeClient(t, (_path, init) => {
    if (init.method === 'POST') {
      posts++;
      return Response.json(payload(id, 'queued', searches));
    }
    if (++gets === 1) return Response.json(payload(id, 'in_progress', [], largerUsage));
    if (gets === 2) return Response.json(payload(id, 'in_progress', searches.slice(0, 1)));
    if (gets <= 7) return Response.json({ error: { message: 'Synthetic temporary outage' } }, { status: 503 });
    return Response.json(terminal(id));
  });
  client.ledger.configurePolicy({ sameMonthPendingBufferCents: 90 });
  let attemptId;
  await assert.rejects(client.createResponse({
    input: 'Inspect the usage fixture.',
    tools: [{ type: 'web_search' }],
    max_output_tokens: 4_096,
  }, {
    ...defaultOptions,
    background: true,
    uncappedWebSearchReservationCalls: 1,
    onProgress: snapshot => {
      attemptId = snapshot.attempt_id;
      snapshots.push(client.ledger.getAttemptById(attemptId).background_usage_floor_micros);
    },
  }), { code: 'BACKGROUND_POLL_INTERRUPTED' });
  assert.equal(gets, 7);
  assert.equal(snapshots[0], 800_000);
  assert.ok(snapshots.slice(1).every(value => value === activeMicros));
  const attempt = client.ledger.getAttemptById(attemptId);
  assert.equal(attempt.status, 'pending_recovery');
  assert.equal(attempt.usage_cost_micros, null);
  assert.equal(attempt.background_usage_floor_micros, activeMicros);
  assert.ok(attempt.reserved_cents < 90);
  const heldCents = Math.ceil(activeMicros / 10_000);
  assert.equal(client.ledger.getMonthlySummary().same_month_pending_recovery_cents, heldCents);
  assert.equal(client.ledger.getMonthlySummary().effective_committed_cents, heldCents);
  await assert.rejects(client.createResponse({ input: 'Inspect a distinct fixture.' }), {
    code: 'ACCOUNT_FENCED_PENDING_RECOVERY',
    blocking_reserved_cents: heldCents,
  });
  assert.equal(posts, 1);
  const settled = await client.pollBackgroundResponse(attemptId, defaultOptions);
  assert.equal(settled.status, 'completed');
  const verifiedFinalMicros = computeUsageCostMicros({ model, usage });
  assert.equal(settled.usage_cost_micros, verifiedFinalMicros);
  assert.equal(client.ledger.getMonthlySummary().effective_committed_cents, Math.ceil(verifiedFinalMicros / 10_000));
}

test('active search and token costs keep failed polling above the buffer', t => verifyActiveCostFence(t, false));
test('search-only and token-only polls retain a combined hold after recovery fails', t => verifyActiveCostFence(t, true));

test('an unrepresentable active cost still binds the response ID and retains a conservative hold', async t => {
  const id = 'resp_active_cost_overflow';
  const client = makeClient(t, (_path, init) => {
    assert.equal(init.method, 'POST');
    return Response.json(payload(id, 'queued', [], { web_search_calls: Number.MAX_SAFE_INTEGER }));
  });
  const result = await client.createResponse({ input: 'Inspect the cost boundary.', background: true }, { maxWaitMs: 0 });
  assert.equal(result.provider_response_id, id);
  const held = client.ledger.getAttemptById(result.attempt_id);
  assert.equal(held.usage_cost_micros, null);
  assert.equal(held.background_usage_floor_micros, Number.MAX_SAFE_INTEGER);
  assert.ok(client.ledger.getMonthlySummary().effective_committed_cents > 20_000);
});

test('background cancellation is bound, single-dispatch, and preserves missing-usage and ambiguous holds', async t => {
  for (const scenario of ['verified-usage', 'null-usage', 'transport-failure', 'foreign-id']) {
    const id = `resp_cancel_${scenario}`;
    const calls = [];
    const client = makeClient(t, (path, init) => {
      calls.push(`${init.method} ${path}`);
      if (path === '/v1/responses') return Response.json(payload(id, 'in_progress'));
      if (init.method === 'GET') return Response.json(terminal(id));
      if (scenario === 'transport-failure') throw new TypeError('Synthetic transport failure');
      const resultId = scenario === 'foreign-id' ? 'resp_cancel_mismatched' : id;
      return Response.json(payload(resultId, 'cancelled', [], scenario === 'verified-usage' ? usage : null));
    });
    const attempt = await client.createResponse({ input: 'Fixture.', background: true }, {
      waitForCompletion: false,
    });
    await assert.rejects(client.cancelResponse('resp_unrelated_fixture'), { code: 'ATTEMPT_NOT_FOUND' });
    const wrongCredential = makeClient(t, () => assert.fail('No cross-credential request permitted'), {
      ledger: client.ledger,
      env: { [keyName]: 'different_synthetic_credential' },
    });
    await assert.rejects(wrongCredential.cancelResponse(id), { code: 'CREDENTIAL_MISMATCH_ON_RECOVERY' });
    const cancelling = client.cancelResponse(id);
    if (scenario === 'transport-failure' || scenario === 'foreign-id') {
      await assert.rejects(cancelling, { code: 'BACKGROUND_CANCEL_OUTCOME_UNKNOWN' });
    } else {
      const result = await cancelling;
      assert.equal(result.response_status, 'cancelled');
      assert.equal(result.status, scenario === 'null-usage' ? 'pending_recovery' : 'failed_known');
    }
    assert.deepEqual(calls, ['POST /v1/responses', `POST /v1/responses/${id}/cancel`]);
    const persisted = client.ledger.getAttemptById(attempt.attempt_id);
    assert.equal(persisted.background_cancel_dispatched_at, now().toISOString());
    assert.equal(persisted.provider_response_id, id);
    if (scenario === 'verified-usage') {
      assert.equal((await client.cancelResponse(attempt.attempt_id)).already_settled, true);
      assert.equal(persisted.usage_cost_micros, computeUsageCostMicros({ model, usage }));
      assert.equal(calls.length, 2);
    } else {
      assert.equal(persisted.usage_cost_micros, null);
      await assert.rejects(client.cancelResponse(attempt.attempt_id), { code: 'BACKGROUND_CANCEL_ALREADY_DISPATCHED' });
      assert.equal((await client.pollBackgroundResponse(attempt.attempt_id, defaultOptions)).status, 'completed');
      assert.equal(calls.at(-1), `GET /v1/responses/${id}`);
      assert.equal(calls.length, 3);
    }
  }
});

test('an in-flight poll reuses concurrent cancellation settlement', async t => {
  const id = 'resp_concurrent_fixture';
  const enteredGet = Promise.withResolvers();
  const releaseGet = Promise.withResolvers();
  let cancels = 0;
  const client = makeClient(t, async (path, init) => {
    if (path === '/v1/responses') return Response.json(payload(id, 'queued'));
    if (init.method === 'GET') {
      enteredGet.resolve();
      await releaseGet.promise;
      return Response.json(terminal(id, [search('ws_stale', 'older search fixture')]));
    }
    cancels++;
    return Response.json(payload(id, 'cancelled', [], usage));
  });
  const submitted = await client.createResponse({ input: 'Inspect fixture.', background: true }, {
    waitForCompletion: false,
  });
  const polling = client.pollBackgroundResponse(submitted.attempt_id, defaultOptions);
  await enteredGet.promise;
  let cancelled;
  try {
    cancelled = await client.cancelResponse(submitted.attempt_id);
  } finally {
    releaseGet.resolve();
  }
  const polled = await polling;
  assert.equal(cancels, 1);
  assert.equal(cancelled.status, 'failed_known');
  assert.equal(polled.status, 'failed_known');
  assert.equal(polled.already_settled, true);
  assert.equal(polled.usage_cost_micros, cancelled.usage_cost_micros);
  assert.equal(client.ledger.getAttemptById(submitted.attempt_id).usage.web_search_calls, 0);
});

test('background cleanup persists final original bytes before a single DELETE and 404 verification', async t => {
  const id = 'resp_cleanup_background';
  const methods = [];
  const client = makeClient(t, (path, init) => {
    methods.push(init.method);
    if (init.method === 'POST') return Response.json(payload(id, 'queued'));
    if (init.method === 'DELETE') return Response.json({ id, deleted: true });
    if (methods.length === 2) return Response.json(payload(id, 'in_progress'));
    if (methods.length === 3) return Response.json(terminal(id));
    return new Response('', { status: 404 });
  });
  const result = await client.createResponse({ input: 'Fixture.' }, {
    ...defaultOptions,
    background: true,
    deleteAfterPersist: true,
  });
  assert.deepEqual(methods, ['POST', 'GET', 'GET', 'DELETE', 'GET']);
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanup.verified_404, true);
});

test('background cleanup keeps concurrent terminal evidence and recovers a lost readback without another DELETE', { timeout: 3_000 }, async t => {
  const id = 'resp_cleanup_concurrent';
  const enteredPoll = Promise.withResolvers();
  const enteredDelete = Promise.withResolvers();
  const releasePoll = Promise.withResolvers();
  const releaseDelete = Promise.withResolvers();
  let cancels = 0;
  let deletes = 0;
  let gets = 0;
  const client = makeClient(t, async (path, init) => {
    if (init.method === 'DELETE') {
      deletes++;
      enteredDelete.resolve();
      await releaseDelete.promise;
      return Response.json({ id, deleted: true });
    }
    if (path === '/v1/responses') return Response.json(payload(id, 'queued'));
    if (init.method === 'POST') {
      cancels++;
      return Response.json(payload(id, 'cancelled', [], usage));
    }
    if (++gets === 1) {
      enteredPoll.resolve();
      await releasePoll.promise;
      return Response.json(terminal(id, [search('ws_stale', 'Older fixture search')]));
    }
    throw new TypeError('Synthetic readback failure after DELETE acknowledgment');
  });
  const started = await client.createResponse({ input: 'Inspect the concurrent fixture.' }, {
    background: true, waitForCompletion: false, deleteAfterPersist: true,
  });
  const polling = client.pollBackgroundResponse(started.attempt_id, defaultOptions);
  await enteredPoll.promise;
  const cancelling = client.cancelResponse(started.attempt_id);
  try {
    await enteredDelete.promise;
    const receiptBefore = client.ledger.getAttemptById(started.attempt_id);
    assert.equal(receiptBefore.raw_receipt.status, 'cancelled');
    assert.equal(receiptBefore.terminal_outcome_status, 'failed_known');
    assert.ok(receiptBefore.background_delete_dispatched_at);
    releasePoll.resolve();
    assert.equal((await polling).response_status, 'cancelled');
    assert.equal((await client.cancelResponse(started.attempt_id)).response_status, 'cancelled');
    const receiptAfter = client.ledger.getAttemptById(started.attempt_id);
    assert.equal(receiptAfter.raw_receipt_sha256, receiptBefore.raw_receipt_sha256);
    assert.equal(receiptAfter.usage_cost_micros, receiptBefore.usage_cost_micros);
  } finally {
    releasePoll.resolve();
    releaseDelete.resolve();
  }
  const cancelled = await cancelling;
  assert.equal(cancelled.status, 'pending_recovery');
  assert.equal(cancelled.cleanup.status, 'delete_failed');
  assert.equal(cancels, 1);
  assert.equal(deletes, 1);
  assert.equal(gets, 2);

  const resumed = makeClient(t, (path, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(path, `/v1/responses/${id}`);
    gets++;
    return new Response('', { status: 404 });
  }, { ledger: client.ledger });
  const recovered = await resumed.recoverPendingResponse(started.attempt_id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.status, 'failed_known');
  assert.equal(recovered.response.response_status, 'cancelled');
  assert.equal(recovered.response.cleanup.verified_404, true);
  assert.equal(gets, 3);
});

test('an ambiguous background DELETE remains claimed and preserves the terminal receipt', async t => {
  const id = 'resp_cleanup_ambiguous';
  const methods = [];
  const client = makeClient(t, (_path, init) => {
    methods.push(init.method);
    if (init.method === 'POST') return Response.json(payload(id, 'queued'));
    if (init.method === 'GET') return Response.json(terminal(id));
    throw new TypeError('Synthetic DELETE timeout after dispatch');
  });
  const result = await client.createResponse({ input: 'Inspect a fixture.' }, {
    ...defaultOptions, background: true, deleteAfterPersist: true,
  });
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.equal(result.status, 'pending_recovery');
  const attempt = client.ledger.getAttemptById(result.attempt_id);
  assert.equal(attempt.raw_receipt.status, 'completed');
  assert.ok(attempt.background_delete_dispatched_at);
  assert.equal(attempt.delete_ack_at, null);
  assert.equal((await client.pollBackgroundResponse(result.attempt_id, defaultOptions)).response_status, 'completed');
  assert.equal((await client.cancelResponse(result.attempt_id)).response_status, 'completed');
  assert.equal((await client.recoverPendingResponse(result.attempt_id)).fenced, true);
  await assert.rejects(client.deleteResponse(id, { attemptId: result.attempt_id }), { code: 'BACKGROUND_DELETE_OUTCOME_UNKNOWN' });
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
  assert.equal(client.ledger.getAttemptById(result.attempt_id).raw_receipt_sha256, attempt.raw_receipt_sha256);
});

test('background recovery dispatches cleanup once after a stop between terminal persistence and DELETE', async t => {
  const id = 'resp_cleanup_before_claim';
  const methods = [];
  const client = makeClient(t, (_path, init) => {
    methods.push(init.method);
    if (init.method === 'POST') return Response.json(payload(id, 'queued'));
    if (init.method === 'DELETE') return Response.json({ id, deleted: true });
    return methods.length === 2 ? Response.json(terminal(id)) : new Response('', { status: 404 });
  });
  const submitted = await client.createResponse({ input: 'Inspect a fixture.' }, {
    background: true, waitForCompletion: false, deleteAfterPersist: true,
  });
  const observed = await client.retrieveResponse(id, { attemptId: submitted.attempt_id });
  const stored = client.ledger.recordTerminalOutcome(submitted.attempt_id, {
    status: 'completed',
    contentStatus: 'usable',
    usageCostMicros: computeUsageCostMicros({ model, usage }),
    usage,
    providerResponseId: id,
    httpStatus: observed.http_status,
    originalBodySha256: observed.original_body_sha256,
    rawReceipt: observed.response,
    rawBodyText: observed.scrubbed_raw_text,
    rawBodySha256: observed.scrubbed_raw_sha256,
  });
  assert.equal(stored.cleanup_status, 'pending_cleanup');
  assert.equal(stored.background_delete_dispatched_at, null);
  assert.throws(() => client.ledger.markPendingRecovery(stored.attempt_id, {
    rawReceipt: payload(id, 'in_progress'),
  }), { code: 'INVALID_STATE_TRANSITION' });
  const recovered = await client.recoverPendingResponse(stored.attempt_id);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.response.cleanup.verified_404, true);
  assert.equal(recovered.attempt.raw_receipt_sha256, stored.raw_receipt_sha256);
  assert.deepEqual(methods, ['POST', 'GET', 'DELETE', 'GET']);
});

test('background progress protects credential contents and reports sidecar errors without interrupting settlement', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'openai-progress-test-'));
  const credentialFile = join(temp, 'mock-credential');
  const progressFile = join(temp, 'progress.json');
  t.after(() => {
    unlinkSync(credentialFile);
    unlinkSync(progressFile);
    rmdirSync(temp);
  });
  writeFileSync(credentialFile, syntheticKey);
  const id = 'resp_progress_fixture';
  const calls = [];
  const client = makeClient(t, (_path, init) => {
    calls.push(init.method);
    if (init.method === 'POST') {
      return Response.json(payload(id, 'queued'));
    }
    // Simulate another process claiming the unused destination after the initial snapshot.
    writeFileSync(progressFile, 'unrelated fixture');
    return Response.json(terminal(id, Array.from({ length: 30 }, (_value, i) =>
      action(`ws_open_${i}`, 'open_page'))));
  }, { credentialFile });
  const request = { input: 'Inspect fixture.', background: true };
  await assert.rejects(client.createResponse(request, { progressFile: credentialFile }), {
    code: 'BACKGROUND_PROGRESS_FILE_CONFLICT',
  });
  assert.deepEqual(calls, []);
  const events = [];
  const result = await client.createResponse(request, {
    ...defaultOptions, progressFile, onProgress: event => events.push(event),
  });
  assert.equal(readFileSync(credentialFile, 'utf8'), syntheticKey);
  assert.equal(readFileSync(progressFile, 'utf8'), 'unrelated fixture');
  assert.equal(result.status, 'completed');
  assert.equal(result.progress_error.code, 'BACKGROUND_PROGRESS_FILE_WRITE_FAILED');
  assert.deepEqual(events.at(-1).progress_error, result.progress_error);
  assert.equal(events.at(-1).observed_web_search_calls, 30);
  assert.equal(events.at(-1).billable_web_search_calls_observed, 0);
  assert.equal(events.at(-1).repeated_query_loop_warning, true);
});

test('unrecognized typed web actions hold exact settlement until the provider supplies a search count', async t => {
  const id = 'resp_unknown_action_fixture';
  const outputs = [
    search('ws_known_example', 'product patent query'),
    action('ws_future_fixture', 'future_action_fixture'),
  ];
  const initial = terminal(id, outputs);
  const verified = { ...initial, usage: { ...usage, web_search_calls: 2 } };
  const client = makeClient(t, (_path, init) => Response.json(init.method === 'GET' ? verified : initial));
  const response = await client.createResponse({ input: 'Inspect fixture.' });
  assert.equal(response.status, 'pending_recovery');
  assert.equal(response.usage_cost_micros, null);
  const recovered = await client.recoverPendingResponse(response.attempt_id);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.attempt.usage.web_search_calls, 2);
  assert.equal(recovered.response.usage_cost_micros, computeUsageCostMicros({ model, usage, webSearchCalls: 2 }));

  const batchLine = body => JSON.stringify({ custom_id: 'fixture', response: { status_code: 200, body } });
  assert.equal(parseBatchOutputJsonl(batchLine(initial)).has_unknown_usage, true);
  const batch = parseBatchOutputJsonl(batchLine(verified));
  assert.equal(batch.has_unknown_usage, false);
  assert.equal(batch.total_usage_cost_micros, computeUsageCostMicros({ model, usage, serviceTier: 'batch', webSearchCalls: 2 }));
});
