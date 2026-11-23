import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { buildFunnelLedger, checkFormDuplicates } from '../src/funnel-ledger.mjs';

const SINCE = '2026-11-20T00:00:00Z';
const BEFORE = '2026-11-19T00:00:00Z';
const AFTER = '2026-11-21T00:00:00Z';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE candidate_forms (form_id TEXT, spec_version INTEGER, spec_sha256 TEXT, lifecycle_status TEXT,
      gate1a_result_json TEXT, gate1b_result_json TEXT, created_at TEXT, label TEXT, buyer_task TEXT);
    CREATE TABLE evaluations (form_id TEXT, receipt_json TEXT);
    CREATE TABLE raw_leads (lead_id TEXT, phrase_or_title TEXT, normalized_key TEXT, event_dedup_key TEXT, metadata_json TEXT);
  `);
  t.after(() => db.close());
  return db;
}

test('funnel uses legacy posted charges once and reports current measured cost, missing usage and holds separately', (t) => {
  const db = fixture(t);
  db.exec(`
    CREATE TABLE openai_request_ledger (endpoint TEXT, status TEXT, reserved_cents INTEGER, usage_cost_micros INTEGER,
      provisional_usage_cost_micros INTEGER, settled_cents INTEGER, usage_json TEXT, confirmed_zero_charge INTEGER,
      raw_receipt_json TEXT, cleanup_status TEXT, finished_at TEXT, updated_at TEXT);
  `);
  const insert = db.prepare(`INSERT INTO openai_request_ledger VALUES('/v1/responses',?,?,?,?,?,?,?,?,?,?,?)`);
  const receipt = JSON.stringify({
    output: [
      { type: 'web_search_call', action: { type: 'search' } },
      { type: 'web_search_call', action: { type: 'search' } },
      { type: 'web_search_call', action: { type: 'open_page' } },
    ],
    usage: { web_search_calls: 1 },
  });
  insert.run('completed', 1, 90_000, null, 7, '{"input_tokens":4,"output_tokens":3}', 0, receipt, null, AFTER, AFTER);
  insert.run('completed', 1, null, null, 5, null, 0, null, null, AFTER, AFTER);
  insert.run('completed', 1, 15_000, null, null, '{"input_tokens":6,"output_tokens_details":{"reasoning_tokens":2},"web_search_calls":0}', 0, null, null, AFTER, AFTER);
  insert.run('failed_known', 1, null, null, null, null, 0, null, null, AFTER, AFTER);
  insert.run('rejected', 1, 5_000, null, null, null, 0, '{"error":{"usage":{"web_search_calls":4}}}', null, AFTER, AFTER);
  insert.run('completed', 1, null, null, 99, null, 0, null, null, BEFORE, AFTER);
  insert.run('completed', 1, 80_000, null, null, null, 0, null, 'pending_cleanup', BEFORE, BEFORE);
  insert.run('pending_recovery', 2, null, 31_000, null, null, 0, null, null, null, BEFORE);
  const { openai, spend_window: window } = buildFunnelLedger(db, SINCE);
  assert.equal(window, 'attempt_finished_at_or_updated_at');
  assert.equal(openai.completed_attempts, 3);
  assert.equal(openai.completed_usage_cost_cents, 10.5);
  assert.equal(openai.completed_posted_billed_cents, 12);
  assert.equal(openai.completed_cost_cents, 13.5);
  assert.equal(openai.settled_attempts, 5);
  assert.equal(openai.settled_known_cost_cents, 14);
  assert.equal(openai.settled_cost_cents, null);
  assert.equal(openai.missing_cost_attempts, 1);
  assert.equal(openai.input_tokens, 10);
  assert.equal(openai.output_tokens, 3);
  assert.equal(openai.reasoning_tokens, 2);
  assert.equal(openai.missing_reasoning_token_attempts, 4);
  assert.equal(openai.web_search_calls, 5);
  assert.equal(openai.missing_search_attempts, 2);
  assert.deepEqual(openai.pending_recovery, { attempts: 2, reserved_cents: 3, effective_hold_cents: 12 });
  insert.run('in_progress', 7, null, null, null, null, 0, null, null, null, BEFORE);
  const observed = { id: 'search-fixture', type: 'web_search_call', action: { type: 'search' } };
  insert.run('completed', 2, 10_000, null, null, null, 0, JSON.stringify({
    output: [observed, { type: 'web_search_call', action: { type: 'open_page' } }],
    error: { output: [observed] },
  }), null, AFTER, AFTER);
  const current = buildFunnelLedger(db, SINCE).openai;
  assert.equal(current.web_search_calls, 6);
  assert.deepEqual(current.in_progress, { attempts: 1, reserved_cents: 7, effective_hold_cents: 7 });
});

test('funnel tracks an older outstanding quota separately from in-window measured units and unavailable historic lanes', (t) => {
  const db = fixture(t);
  db.exec(`
    CREATE TABLE api_request_ledger (provider TEXT, tool_name TEXT, status TEXT, billing_status TEXT,
      ss_mcp_units REAL, ss_web_realtime_tasks REAL, unknown_reserved_ss_web_realtime_tasks REAL,
      estimated_ss_web_realtime_tasks REAL, finished_at TEXT, updated_at TEXT);
  `);
  const insert = db.prepare('INSERT INTO api_request_ledger VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run('sellersprite', 'mcp', 'completed', 'known', 6, 0, 0, 0, BEFORE, AFTER);
  insert.run('sellersprite', 'mcp', 'completed', 'known', 2, 0, 0, 0, AFTER, AFTER);
  insert.run('sellersprite', 'browser_realtime', 'completed', 'unknown_not_exposed', 0, 1, 3, 0, BEFORE, BEFORE);
  insert.run('sellersprite', 'browser_realtime', 'in_flight', 'known', 0, 0, 0, 2, null, BEFORE);
  const { quota, openai } = buildFunnelLedger(db, SINCE);
  assert.equal(openai.available, false);
  assert.deepEqual(quota.ss_mcp, {
    attempts: 1, known_units: 2, active_reserved_units: null, unknown_reserved_units: null, unknown_billing_attempts: 0,
  });
  assert.deepEqual(quota.ss_web, {
    attempts: 0, known_units: 0, active_reserved_units: 2, unknown_reserved_units: 3, unknown_billing_attempts: 1,
  });
  assert.equal(quota.exa.known_units, null);
});

test('funnel conversions use current-spec gate and evaluation evidence and dedupe ignores blank event keys', (t) => {
  const db = fixture(t);
  const insert = db.prepare("INSERT INTO candidate_forms VALUES(?,?,?,?,?,?,?,'compass keychain','carry a compass')");
  const passedA = '{"proceed_to_gate1b":true,"spec_sha256":"spec-current"}';
  const passedB = '{"status":"gate1b_passed","spec_sha256":"spec-current"}';
  insert.run('current', 2, 'spec-current', 'evaluated', passedA, passedB, AFTER);
  insert.run('old-eval', 2, 'spec-current', 'evaluated', passedA, passedB, AFTER);
  insert.run('unbound', 2, 'spec-current', 'evaluated', '{"proceed_to_gate1b":true}', '{"status":"gate1b_passed"}', AFTER);
  insert.run('crossing', 1, 'first-spec', 'gate1b_pending', '{"proceed_to_gate1b":true}', '{"owner_crossing_override":true}', AFTER);
  insert.run('invalid', 1, 'first-spec', 'discovered', '{"proceed_to_gate1b":"false"}', null, AFTER);
  insert.run('older', 1, 'first-spec', 'discovered', null, null, BEFORE);
  const evaluation = db.prepare('INSERT INTO evaluations VALUES (?,?)');
  evaluation.run('current', '{"form_spec_sha256":"spec-current"}');
  evaluation.run('current', '{"form_spec_sha256":"spec-older"}');
  evaluation.run('old-eval', '{"form_spec_sha256":"spec-older"}');
  evaluation.run('unbound', '{}');

  const { candidates } = buildFunnelLedger(db, SINCE);
  assert.equal(candidates.discovered, 5);
  assert.equal(candidates.gate1a_passed, 3);
  assert.equal(candidates.gate1a_unverified, 1);
  assert.equal(candidates.gate1b_passed, 2);
  assert.equal(candidates.gate1b_admitted, 3);
  assert.equal(candidates.gate1b_unverified, 1);
  assert.equal(candidates.crossing_overrides, 1);
  assert.equal(candidates.evaluated, 1);
  assert.equal(candidates.evaluated_unverified, 1);
  assert.deepEqual(candidates.conversion_rates, {
    gate1a_passed_per_discovered: 3 / 5,
    gate1b_admitted_per_gate1a_passed: 1,
    evaluated_per_gate1b_admitted: 1 / 3,
  });
  assert.equal(buildFunnelLedger(db, '2026-12-01T00:00:00Z').candidates.conversion_rates.gate1a_passed_per_discovered, null);
  assert.throws(() => buildFunnelLedger(db, '2026-11-31T00:00:00Z'), /valid ISO timestamp/);
  db.exec("INSERT INTO raw_leads VALUES ('lead','flashlight','fixture','event-one','{}')");
  assert.deepEqual(checkFormDuplicates(db, [{ title: 'unrelated', event_dedup_key: '  ' }])[0].matches, []);
  assert.equal(checkFormDuplicates(db, [{ event_dedup_key: 'event-one' }])[0].matches[0].id, 'lead');
});
