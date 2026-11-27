import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertNoRawPii, detectRawPii, sanitizeDiagnosticText } from '../src/contracts.mjs';
import {
  EVIDENCE_REVIEW_JSON_SCHEMA,
  OpenAiClient,
  SCHEMA_VERSION,
  buildBatchJsonl,
  buildStage1DecisionsRequests,
  buildWorkflowTaskRequest,
  freezeEvidenceReviewPacket,
  inspectLegacyAutopilotBudget,
  openOpenAiBudgetLedger,
  parseBatchOutputJsonl,
  parseStage1DecisionsResponses,
  parseWorkflowTaskResult,
} from '../src/openai/index.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import {
  attachCandidateEvidenceReview,
  runOptional1688VisionPrecheck,
  runOptionalGate4EvidenceReview,
  runOptionalReviewJudge,
  runOptionalRightsPreScreen,
  runOptionalStage12LunaTriage,
  runPhase2Batch,
} from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { openSelectionStore, sha256Hex } from '../src/store.mjs';
import { makeCapturingStreams } from './helpers/test-fixtures.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SYNTHETIC_BATCH_PATH = join(REPO_ROOT, 'fixtures', 'synthetic-batch.json');
const PROFILE_PATH = join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json');

const ONE_PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function buildSyntheticPacket(overrides = {}) {
  return {
    schema_version: SCHEMA_VERSION,
    review_id: 'rev-phase4-synth-01',
    candidate: {
      subject_id: 'synthetic-complete',
      intended_use: 'Desktop dual-shelf cable and stationery organizer',
      saleable_spec: {
        material: 'Powder-coated carbon steel',
        set_count: 2,
      },
      unknown_fields: ['salt_spray_hours'],
    },
    subjects: [
      {
        subject_id: 'peer-synth-01',
        spec: { material: 'Powder-coated steel', set_count: 2 },
      },
      {
        subject_id: 'peer-synth-02',
        spec: { material: 'Acrylic tray', set_count: 1 },
      },
      {
        subject_id: 'peer-synth-03',
        spec: { material: 'Steel rack (unknown set count)' },
      },
    ],
    criteria: {
      criteria_version: 'r58-peer-v1',
      rules: [
        {
          criterion_id: 'crit-task-material',
          description: 'Must match dual-shelf desktop organizer task and rigid metal frame.',
          required: true,
        },
      ],
    },
    questions: [
      {
        question_id: 'q-peer-set-parity',
        question: 'Does peer-synth-03 confirm a 2-piece saleable set?',
        subject_ids: ['peer-synth-03'],
        criterion_ids: ['crit-task-material'],
      },
    ],
    evidence: [
      {
        evidence_id: 'ev-peer-01',
        subject_ids: ['peer-synth-01'],
        summary: 'Catalog specification confirms 2-piece powder-coated steel desktop organizer.',
        kind: 'fact',
        source_ref: 'local-catalog-snap-01',
        observed_at: '2026-11-20',
        window: '2026-10-22..2026-11-20',
        grain: 'child_sku',
        units: 'sets',
        limitations: null,
      },
      {
        evidence_id: 'ev-peer-02',
        subject_ids: ['peer-synth-02'],
        summary: 'Listing shows single molded acrylic pen tray without shelf tier.',
        kind: 'fact',
        source_ref: 'local-catalog-snap-02',
        observed_at: '2026-11-20',
        window: '2026-10-22..2026-11-20',
        grain: 'child_sku',
        units: 'piece',
        limitations: null,
      },
      {
        evidence_id: 'ev-peer-03-a',
        subject_ids: ['peer-synth-03'],
        summary: 'Bullet text mentions 2-pack while specification table lists package quantity = 1.',
        kind: 'fact',
        source_ref: 'local-catalog-snap-03',
        observed_at: '2026-11-20',
        window: null,
        grain: 'child_sku',
        units: 'sets',
        limitations: 'Static listing text snapshot without carton unpack photo.',
      },
    ],
    ...overrides,
  };
}

function buildValidReviewForPacket(frozenPacket) {
  return {
    schema_version: SCHEMA_VERSION,
    review_id: frozenPacket.review_id,
    packet_sha256: frozenPacket.packet_sha256,
    subjects: [
      {
        subject_id: 'peer-synth-01',
        disposition: 'included',
        criterion_ids: ['crit-task-material'],
        evidence_ids: ['ev-peer-01'],
        reason: 'Matches 2-piece powder-coated steel organizer task.',
      },
      {
        subject_id: 'peer-synth-02',
        disposition: 'excluded',
        criterion_ids: ['crit-task-material'],
        evidence_ids: ['ev-peer-02'],
        reason: 'Single-piece acrylic tray lacks dual-shelf metal structure.',
      },
      {
        subject_id: 'peer-synth-03',
        disposition: 'pending',
        criterion_ids: ['crit-task-material'],
        evidence_ids: ['ev-peer-03-a'],
        reason: 'Bullet text and specification table conflict on set count.',
      },
    ],
    answers: [
      {
        question_id: 'q-peer-set-parity',
        status: 'pending',
        basis: 'fact',
        evidence_ids: ['ev-peer-03-a'],
        explanation: 'Set count remains unresolved due to internal listing contradiction.',
      },
    ],
    contradictions: [
      {
        subject_ids: ['peer-synth-03'],
        criterion_ids: ['crit-task-material'],
        question_ids: ['q-peer-set-parity'],
        evidence_ids: ['ev-peer-03-a'],
        disagreement: 'Bullet claims 2-pack whereas technical table states package quantity 1.',
      },
    ],
    gaps: [
      {
        subject_ids: ['peer-synth-03'],
        criterion_ids: ['crit-task-material'],
        question_ids: ['q-peer-set-parity'],
        evidence_ids: [],
        missing_information: 'Verified buyer unpack photo or carton BOM for peer-synth-03.',
        why_it_matters: 'Miscounting 1-pack vs 2-pack distorts unit price and Q31 peer comparability.',
        resolution_evidence: 'Inspect verified-purchase review gallery or supplier pack specification.',
      },
    ],
    conclusion: 'Include peer-synth-01, exclude peer-synth-02, and hold peer-synth-03 pending pack-count verification.',
  };
}

describe('Phase 4 Integration: src/openai barrel, client<->task seams, CLI subcommands, pipeline hooks & r58 HTML', () => {
  it('re-exports unified barrel cleanly and bridges OpenAiClient envelopes with workflow-tasks parsers', async () => {
    assert.equal(SCHEMA_VERSION, 'evidence-review-draft-v1');
    assert.equal(EVIDENCE_REVIEW_JSON_SCHEMA.additionalProperties, false);

    const ledger = openOpenAiBudgetLedger(':memory:');
    ledger.reconcileLegacySummary({
      recognized_schema: true,
      month_utc: '2026-11',
      total_rows: 2,
      status_counts: { complete: 2 },
      unresolved_count: 0,
      has_unresolved_holds: false,
      same_month_reserved_cents: 620,
      file_sha256: 'a'.repeat(64),
    }, {
      enable: true,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
      allowSyntheticSummaryForTests: true,
    });

    const testKey = ['test', 'token', 'alpha99'].join('_');
    const candidates = [
      { candidate_id: 'SYNTH-PEER-1', title: 'Powder Coated Steel Desk Shelf 2-Pack', price_usd: 39.99 },
      { candidate_id: 'SYNTH-BABY-2', title: 'Infant Crib Toy Organizer', price_usd: 32.00 },
    ];
    const decReqs = buildStage1DecisionsRequests({ candidates });
    assert.equal(decReqs.length, 1);

    // P1-12: Provider returns `id` (without `name`) AND swaps candidate answer order — client + parser bridge must match by verified ID, never array index!
    const [q0Gate0, q0Vis, q1Gate0, q1Vis] = decReqs[0].questions;
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: testKey },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/v1/decisions')) {
          return new Response(JSON.stringify({
            id: 'dec_resp_01',
            model: 'gpt-6-luna',
            decisions: [
              { id: q1Gate0.id, type: 'refusal', refusal: 'Ambiguous safety scope' },
              { id: q1Vis.id, type: 'refusal', refusal: 'Ambiguous thumbnail' },
              { id: q0Gate0.id, type: 'predicate', value: false, probability: 0.02 },
              { id: q0Vis.id, type: 'choice', value: 'exact_peer' },
            ],
            usage: { input_tokens: 400, output_tokens: 60 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    const decEnvelope = await client.createDecision(decReqs[0], { monthUtc: '2026-11', allowTestClockOverride: true });
    const parsedTriage = parseStage1DecisionsResponses(candidates, [decEnvelope]);
    assert.equal(parsedTriage.items[0].visual_cluster, 'exact_peer');
    assert.equal(parsedTriage.items[0].gate0_status, 'allowed');
    // Deterministic Gate-0 hard-excludes Infant/Crib even when model refused predicate!
    assert.equal(parsedTriage.items[1].gate0_status, 'prohibited');
    assert.equal(parsedTriage.items[1].visual_cluster, 'unclear_needs_zoom');

    // Verify client.createResponse incomplete envelope (`status: 'completed'`, `response_status: 'incomplete'`, `usable: false`)
    // is rejected by `parseWorkflowTaskResult` rather than accepted!
    const incompleteClient = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: testKey },
      fetchImpl: async () => new Response(JSON.stringify({
        id: 'resp_inc_01',
        object: 'response',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'gpt-6.1-terra',
        output_text: JSON.stringify({
          schema_version: 1,
          contract: 'SocialBridgeExtractor',
          status: 'no_buyable_product',
          platform: 'reddit',
          source_url: 'https://example.com/post/1',
          source_ref: null,
          observed_at: '2026-11-20',
          event_dedup_key: 'dedup-1',
          verbatim_excerpt: 'incomplete test',
          buyer_task: null,
          candidate_phrases: [],
          notes: null,
        }),
        usage: { input_tokens: 500, output_tokens: 4096, output_tokens_details: { reasoning_tokens: 4000 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const sbReq = buildWorkflowTaskRequest('social-bridge', {
      platform: 'reddit',
      source_url: 'https://example.com/post/1',
      observed_at: '2026-11-20',
      event_dedup_key: 'dedup-1',
      post_text: 'Looking for a steel desktop organizer.',
    });
    const incEnv = await incompleteClient.createResponse(sbReq, { monthUtc: '2026-11', allowTestClockOverride: true });
    assert.equal(incEnv.status, 'completed');
    assert.equal(incEnv.usable, false);
    assert.equal(incEnv.content_status, 'incomplete');
    assert.throws(() => parseWorkflowTaskResult('social-bridge', incEnv), /incomplete|not usable/i);

    // Also verify Batch output JSONL incomplete item is rejected by parseWorkflowTaskResult
    const batchOut = parseBatchOutputJsonl(JSON.stringify({
      id: 'batch_req_1',
      custom_id: 'sb-1',
      response: {
        status_code: 200,
        body: {
          id: 'resp_batch_inc',
          object: 'response',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          model: 'gpt-6.1-terra',
          output_text: '{}',
          usage: { input_tokens: 200, output_tokens: 4096 },
        },
      },
    }));
    assert.equal(batchOut.results[0].usable, false);
    assert.throws(() => parseWorkflowTaskResult('social-bridge', batchOut.results[0]), /incomplete|not usable/i);

    ledger.close();
  });

  it('supports openai-status & openai-reconcile on canonical legacy requests(cents, status=complete) schema without touching legacy bytes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'p4-cli-budget-'));
    try {
      const legacyDbPath = join(tempDir, 'legacy-budget.sqlite3');
      const targetDbPath = join(tempDir, 'selection.sqlite');

      // Seed SelectionStore DB first (without openai_* tables yet)
      const selStore = openSelectionStore(targetDbPath);
      selStore.close();

      // Build canonical legacy requests(request_id, cents, status, started_at, ended_at, evidence) SQLite DB
      const legDb = new DatabaseSync(legacyDbPath);
      legDb.exec(`
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY,
          cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          evidence TEXT
        );
      `);
      const ins = legDb.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?)');
      ins.run('selection-oct-01', 310, 'complete', '2026-10-30T05:52:20+00:00', '2026-10-30T05:52:24+00:00', '{}');
      ins.run('selection-nov-01', 310, 'complete', '2026-11-05T10:08:38+00:00', '2026-11-05T10:08:40+00:00', '{}');
      ins.run('selection-nov-02', 310, 'complete', '2026-11-09T02:16:06+00:00', '2026-11-09T02:16:33+00:00', '{}');
      legDb.close();
      // Ensure no leftover -wal/-shm sidecars
      assert.equal(existsSync(`${legacyDbPath}-wal`), false);
      const legacyShaBefore = sha256Hex(readFileSync(legacyDbPath));
      const targetShaBefore = sha256Hex(readFileSync(targetDbPath));

      // 1) Read-only `openai-status` touches ZERO bytes on BOTH targetDbPath and legacyDbPath!
      const s1 = makeCapturingStreams();
      const code1 = await runPhase2Cli([
        'openai-status',
        '--db', targetDbPath,
        '--legacy-budget', legacyDbPath,
        '--month', '2026-11',
      ], s1);
      assert.equal(code1, 0, s1.getErr());
      assert.equal(sha256Hex(readFileSync(legacyDbPath)), legacyShaBefore);
      assert.equal(sha256Hex(readFileSync(targetDbPath)), targetShaBefore);
      assert.equal(existsSync(`${legacyDbPath}-wal`), false);
      assert.equal(existsSync(`${legacyDbPath}-shm`), false);

      const statusPayload = JSON.parse(s1.getOut());
      assert.equal(statusPayload.status.read_only, true);
      assert.equal(statusPayload.status.policy.enabled, false);
      assert.equal(statusPayload.legacy_budget.total_rows, 3);
      assert.equal(statusPayload.legacy_budget.unresolved_count, 0);
      assert.equal(statusPayload.legacy_budget.same_month_reserved_cents, 620);
      assert.equal(statusPayload.legacy_budget.total_reserved_cents_all_months, 930);
      assert.equal(s1.getOut().includes(legacyShaBefore), false, 'CLI stdout must not leak raw legacy DB fingerprint');
      assert.equal(detectRawPii(s1.getOut()), null);

      // P0-11: Reject hardlink & directory-junction aliases pointing `--db` at canonical `--legacy-budget` BEFORE writable open!
      const hardlinkAlias = join(tempDir, 'hardlink-alias.sqlite3');
      linkSync(legacyDbPath, hardlinkAlias);
      const junctionParent = join(tempDir, 'real-leg-dir');
      mkdirSync(junctionParent, { recursive: true });
      const realLegInDir = join(junctionParent, 'budget.sqlite3');
      writeFileSync(realLegInDir, readFileSync(legacyDbPath));
      const realLegSha = sha256Hex(readFileSync(realLegInDir));
      const junctionAliasDir = join(tempDir, 'junction-leg-dir');
      symlinkSync(junctionParent, junctionAliasDir, 'junction');

      const sHardlink = makeCapturingStreams();
      const codeHardlink = await runPhase2Cli([
        'openai-reconcile',
        '--db', hardlinkAlias,
        '--legacy-budget', legacyDbPath,
      ], sHardlink);
      assert.equal(codeHardlink, 2);
      assert.equal(sha256Hex(readFileSync(legacyDbPath)), legacyShaBefore);
      assert.equal(existsSync(`${legacyDbPath}-wal`), false);
      assert.equal(existsSync(`${legacyDbPath}-shm`), false);
      // Remove temporary hardlink alias after P0-11 check so legacyDbPath returns to nlink=1 for P0-12 strict inspection!
      rmSync(hardlinkAlias, { force: true });

      const sJunction = makeCapturingStreams();
      const codeJunction = await runPhase2Cli([
        'openai-reconcile',
        '--db', join(junctionAliasDir, 'budget.sqlite3'),
        '--legacy-budget', realLegInDir,
      ], sJunction);
      assert.equal(codeJunction, 2);
      assert.equal(sha256Hex(readFileSync(realLegInDir)), realLegSha);
      assert.equal(existsSync(`${realLegInDir}-wal`), false);
      assert.equal(existsSync(`${realLegInDir}-shm`), false);

      // 2) Enabling directly on a fresh blank DB succeeds once billing controls are confirmed (no legacy deadlock!)
      const blankEnableDbPath = join(tempDir, 'blank-enable.sqlite');
      const sDirectEnable = makeCapturingStreams();
      const codeDirectEnable = await runPhase2Cli([
        'openai-reconcile',
        '--db', blankEnableDbPath,
        '--enable',
        '--confirm-auto-recharge-off',
        '--confirm-hard-limit',
      ], sDirectEnable);
      assert.equal(codeDirectEnable, 0, sDirectEnable.getErr());
      assert.equal(JSON.parse(sDirectEnable.getOut()).status.policy.enabled, true);

      // P0-06: `--enable` without platform billing control confirmations or with limit > 20000 must fail!
      const sNoBillingConfirm = makeCapturingStreams();
      const codeNoBillingConfirm = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--legacy-budget', legacyDbPath,
        '--enable',
        '--month', '2026-11',
      ], sNoBillingConfirm);
      assert.equal(codeNoBillingConfirm, 2);

      const sOverLimit = makeCapturingStreams();
      const codeOverLimit = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--legacy-budget', legacyDbPath,
        '--monthly-limit-cents', '20001',
        '--month', '2026-11',
      ], sOverLimit);
      assert.equal(codeOverLimit, 2);

      // 3) Reconcile legacy baseline + enable + set monthly limit, then settle a pending_recovery fence
      const s2 = makeCapturingStreams();
      const code2 = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--legacy-budget', legacyDbPath,
        '--enable',
        '--confirm-auto-recharge-off',
        '--confirm-hard-limit',
        '--monthly-limit-cents', '20000',
        '--month', '2026-11',
        '--note', 'Reconciled clean historical baseline',
      ], s2);
      assert.equal(code2, 0, s2.getErr());
      assert.equal(sha256Hex(readFileSync(legacyDbPath)), legacyShaBefore);
      const recPayload = JSON.parse(s2.getOut());
      assert.equal(recPayload.status.policy.enabled, true);
      assert.equal(recPayload.status.policy.legacy_reconciled, true);
      assert.equal(recPayload.status.monthly.legacy_carryover_cents, 620);
      assert.equal(recPayload.status.monthly.remaining_cents, 19380);

      // Insert an ambiguous pending_recovery attempt and verify reconciliation guardrails via CLI
      const ledger = openOpenAiBudgetLedger(targetDbPath, {
        testMode: true,
        canonicalRegistryPath: join(tempDir, 'canonical-registry.sqlite'),
      });
      const attempt = ledger.reserveBillableRequest({
        logicalRequestId: 'cli-test-fence-01',
        monthUtc: '2026-11',
        allowTestClockOverride: true,
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: 'b'.repeat(64),
        reservedCents: 25,
      });
      ledger.markPendingRecovery(attempt.attempt_id, { reason: 'Simulated network timeout' });
      ledger.configurePolicy({ accountScope: 'openai-default', enabled: false });
      ledger.close();

      // P1-05: Valid `--enable` combined with invalid `--month` must fail BEFORE committing policy mutation!
      const sInvalidMonth = makeCapturingStreams();
      const codeInvalidMonth = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--enable',
        '--confirm-auto-recharge-off',
        '--confirm-hard-limit',
        '--month', '2026-13',
      ], sInvalidMonth);
      assert.equal(codeInvalidMonth, 2);
      const sAfterBadMonth = makeCapturingStreams();
      await runPhase2Cli(['openai-status', '--db', targetDbPath, '--month', '2026-11'], sAfterBadMonth);
      assert.equal(JSON.parse(sAfterBadMonth.getOut()).status.policy.enabled, false);

      // P1-05: Combined `--enable` + invalid `--attempt` settlement must roll back atomically (leaving enabled=false)!
      const sFailAtomic = makeCapturingStreams();
      const codeFailAtomic = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--month', '2026-11',
        '--enable',
        '--confirm-auto-recharge-off',
        '--confirm-hard-limit',
        '--attempt', attempt.attempt_id,
        '--status', 'failed_known',
        '--note', 'Attempted unlock without evidence',
      ], sFailAtomic);
      assert.equal(codeFailAtomic, 2);
      assert.match(sFailAtomic.getErr(), /confirmedZeroCharge|evidence/i);

      const sCheckStillDisabled = makeCapturingStreams();
      await runPhase2Cli(['openai-status', '--db', targetDbPath, '--month', '2026-11'], sCheckStillDisabled);
      assert.equal(JSON.parse(sCheckStillDisabled.getOut()).status.policy.enabled, false);

      // P1-05: Reconciling an attempt under the wrong `--account-scope` must fail!
      const sWrongScope = makeCapturingStreams();
      const codeWrongScope = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--account-scope', 'other-scope',
        '--attempt', attempt.attempt_id,
        '--status', 'failed_known',
        '--confirmed-zero-charge',
        '--note', 'Wrong scope attempt',
      ], sWrongScope);
      assert.equal(codeWrongScope, 2);

      // With --confirmed-zero-charge + --enable, combined atomic transaction succeeds cleanly!
      const sSettleOk = makeCapturingStreams();
      const codeSettleOk = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--month', '2026-11',
        '--enable',
        '--confirm-auto-recharge-off',
        '--confirm-hard-limit',
        '--attempt', attempt.attempt_id,
        '--status', 'failed_known',
        '--confirmed-zero-charge',
        '--note', 'Verified zero upstream dispatch in firewall log',
      ], sSettleOk);
      assert.equal(codeSettleOk, 0, sSettleOk.getErr());
      const settledJson = JSON.parse(sSettleOk.getOut());
      assert.equal(settledJson.status.policy.enabled, true);
      assert.equal(settledJson.status.monthly.fenced, false);
      // P1-20: Narrow projected CLI output omits source fingerprints, unrelated row arrays, and raw receipts across the ENTIRE response!
      assert.equal(Object.hasOwn(settledJson.reconciled_attempt, 'raw_receipt'), false);
      assert.equal(Object.hasOwn(settledJson.reconciled_attempt, 'raw_body_text'), false);
      assert.equal(Object.hasOwn(settledJson.status.policy, 'legacy_budget_sha256'), false);
      assert.equal(Object.hasOwn(settledJson.status.monthly, 'blocking_attempt_ids'), false);
      assert.equal(Object.hasOwn(settledJson.status, 'active_fences'), false);
      assert.equal(sSettleOk.getOut().includes(legacyShaBefore), false);
      assert.equal(typeof settledJson.private_receipt_ref, 'string');
      assert.equal(settledJson.reconciled_attempt.attempt_id, attempt.attempt_id);
      assert.equal(settledJson.status.monthly.effective_committed_cents, 620);

      // P0-09: Newly discovered legacy hold combined with nonexistent `--attempt` MUST revoke enabled policy BEFORE exiting!
      const holdLegPath = join(tempDir, 'legacy-with-hold.sqlite3');
      const holdLegDb = new DatabaseSync(holdLegPath);
      holdLegDb.exec(`
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY,
          cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          evidence TEXT
        );
      `);
      holdLegDb.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?)').run(
        'selection-nov-hold', 400, 'pending_recovery', '2026-11-12T01:00:00+00:00', null, '{}',
      );
      holdLegDb.close();

      const sHoldPlusMissingAttempt = makeCapturingStreams();
      const codeHoldPlusMissing = await runPhase2Cli([
        'openai-reconcile',
        '--db', targetDbPath,
        '--legacy-budget', holdLegPath,
        '--month', '2026-11',
        '--attempt', 'nonexistent-attempt-id',
        '--status', 'failed_known',
        '--confirmed-zero-charge',
        '--note', 'Unrelated missing attempt',
      ], sHoldPlusMissingAttempt);
      assert.equal(codeHoldPlusMissing, 2);
      const sCheckRevoked = makeCapturingStreams();
      await runPhase2Cli(['openai-status', '--db', targetDbPath, '--month', '2026-11'], sCheckRevoked);
      const revokedStatus = JSON.parse(sCheckRevoked.getOut());
      assert.equal(revokedStatus.status.policy.enabled, false, 'discovered legacy hold must durably revoke enabled policy before exiting');
      assert.equal(revokedStatus.status.policy.legacy_reconciled, false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds offline Terra xhigh Batch JSONL via openai-batch-build and enforces collision & cap rules', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'p4-cli-batch-'));
    try {
      const itemsPath = join(tempDir, 'rights-items.json');
      const outJsonlPath = join(tempDir, 'rights-batch.jsonl');
      writeFileSync(itemsPath, JSON.stringify([
        {
          custom_id: 'rights-card-01',
          form_id: 'form-synth-organizer',
          label: 'Powder-Coated Steel Desktop Organizer',
          buyer_task: 'Organize desktop cables and notebooks on two rigid tiers',
          materials: 'Carbon steel with silicone feet',
          search_terms: ['desktop shelf organizer', 'dual tier desk rack'],
        },
      ], null, 2), 'utf8');

      // Collision check: --output === --input must fail without corrupting input
      const sColl = makeCapturingStreams();
      const collCode = await runPhase2Cli([
        'openai-batch-build',
        '--task', 'rights-prescreen',
        '--input', itemsPath,
        '--output', itemsPath,
      ], sColl);
      assert.equal(collCode, 2);

      const sOk = makeCapturingStreams();
      const okCode = await runPhase2Cli([
        'openai-batch-build',
        '--task', 'rights-prescreen',
        '--input', itemsPath,
        '--output', outJsonlPath,
      ], sOk);
      assert.equal(okCode, 0, sOk.getErr());
      const summary = JSON.parse(sOk.getOut());
      assert.equal(summary.model, 'gpt-6.1-terra');
      assert.equal(summary.reasoning_effort, 'xhigh');
      assert.equal(summary.service_tier, 'batch');
      assert.equal(summary.line_count, 1);
      assert.ok(summary.estimated_reservation_cents >= 4); // includes 3x $0.01 web_search cap + batch tokens
      assert.equal(detectRawPii(sOk.getOut()), null);

      const lines = readFileSync(outJsonlPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].custom_id, 'rights-card-01');
      assert.equal(lines[0].url, '/v1/responses');
      assert.equal(lines[0].body.model, 'gpt-6.1-terra');
      assert.deepEqual(lines[0].body.reasoning, { effort: 'xhigh' });
      assert.ok(!Object.hasOwn(lines[0].body, 'max_tool_calls'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('executes redteam-review CLI in both --dry-run and mock codex exec modes, then renders r58 HTML cleanly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'p4-cli-redteam-'));
    try {
      const packetPath = join(tempDir, 'packet.json');
      const dryOutPath = join(tempDir, 'review-dry.json');
      const liveOutPath = join(tempDir, 'review-live.json');
      const imgPath = join(tempDir, 'sample.png');
      const mockCodexScript = join(tempDir, 'mock-codex.mjs');

      const packet = buildSyntheticPacket();
      writeFileSync(packetPath, JSON.stringify(packet, null, 2), 'utf8');
      writeFileSync(imgPath, Buffer.from(ONE_PIXEL_PNG_B64, 'base64'));

      // 1) --dry-run mode validates & freezes packet without spawning codex
      const sDry = makeCapturingStreams();
      const dryCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', dryOutPath,
        '--effort', 'max',
        '--image', imgPath,
        '--dry-run',
      ], sDry);
      assert.equal(dryCode, 0, sDry.getErr());
      const drySummary = JSON.parse(sDry.getOut());
      assert.equal(drySummary.dry_run, true);
      assert.equal(drySummary.status, 'unavailable');
      assert.equal(drySummary.execution_status, 'not_submitted');
      assert.equal(drySummary.reviewer_label, 'Codex CLI · max');
      assert.equal(detectRawPii(sDry.getOut()), null);

      const dryFile = JSON.parse(readFileSync(dryOutPath, 'utf8'));
      assert.equal(
        dryFile.cli_args_preview.includes('service_tier="default"'),
        true,
        'redteam-review without --service-tier must pass -c service_tier="default" (normal/default speed, overriding host ~/.codex/config.toml)',
      );

      const optInOutPath = join(tempDir, 'review-dry-ultrafast.json');
      const sOptIn = makeCapturingStreams();
      const optInCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', optInOutPath,
        '--effort', 'max',
        '--service-tier', 'ultrafast',
        '--dry-run',
      ], sOptIn);
      assert.equal(optInCode, 0, sOptIn.getErr());
      const optInFile = JSON.parse(readFileSync(optInOutPath, 'utf8'));
      assert.equal(optInFile.cli_args_preview.includes('service_tier="ultrafast"'), true);

      // 1b) P0-25 & P2-11: `--offline` and colliding `--output` must NEVER spawn codex!
      const sentinelPath = join(tempDir, 'must-not-spawn.txt');
      const sentinelCodexScript = join(tempDir, 'sentinel-codex.mjs');
      writeFileSync(sentinelCodexScript, [
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(sentinelPath)}, 'spawned', 'utf8');`,
        'process.exit(1);',
      ].join('\n'), 'utf8');

      const offlineOutPath = join(tempDir, 'review-offline.json');
      const sOffline = makeCapturingStreams();
      const offlineCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', offlineOutPath,
        '--offline',
        '--codex-bin', sentinelCodexScript,
      ], sOffline);
      assert.equal(offlineCode, 0, sOffline.getErr());
      assert.equal(existsSync(sentinelPath), false, '--offline must perform zero codex spawns');

      // P0-26: Public CLI MUST REJECT `--test-mode` flag (test doubles are in-process programmatic hooks only, never OS spawns!)
      const sCliTestModeRejected = makeCapturingStreams();
      const cliTestModeCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', join(tempDir, 'rejected-test-mode.json'),
        '--test-mode',
      ], sCliTestModeRejected);
      assert.equal(cliTestModeCode, 2);
      assert.equal(existsSync(sentinelPath), false);

      // P2-11: Directory `--output`, `--packet` collision, and `--codex-bin` collision must all fail BEFORE spawning codex!
      const existingDirOut = join(tempDir, 'existing-out-dir');
      mkdirSync(existingDirOut, { recursive: true });
      const sDirOut = makeCapturingStreams();
      const dirOutCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', existingDirOut,
        '--codex-bin', sentinelCodexScript,
      ], sDirOut);
      assert.equal(dirOutCode, 2);
      assert.equal(existsSync(sentinelPath), false, 'directory --output must fail preflight before spawning codex');

      const sCollideBin = makeCapturingStreams();
      const collideBinCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', sentinelCodexScript,
        '--codex-bin', sentinelCodexScript,
      ], sCollideBin);
      assert.equal(collideBinCode, 2);
      assert.equal(existsSync(sentinelPath), false, '--output colliding with --codex-bin must fail before spawning codex');

      const packetBytesBefore = readFileSync(packetPath);
      const sCollide = makeCapturingStreams();
      const collideCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', packetPath,
        '--codex-bin', sentinelCodexScript,
      ], sCollide);
      assert.equal(collideCode, 2);
      assert.equal(existsSync(sentinelPath), false, 'output collision must be caught BEFORE spawning codex');
      assert.deepEqual(readFileSync(packetPath), packetBytesBefore);

      // 2) In-process programmatic test double (`codexMockExecutor`) writes valid evidence-review-draft-v1 JSON + atomic receipt (zero OS spawns!)
      const testReceiptStore = join(tempDir, 'receipts');
      mkdirSync(testReceiptStore, { recursive: true });
      const frozen = freezeEvidenceReviewPacket(packet);
      const validReview = buildValidReviewForPacket(frozen);

      const sLive = makeCapturingStreams();
      const liveCode = await runPhase2Cli([
        'redteam-review',
        '--packet', packetPath,
        '--output', liveOutPath,
        '--effort', 'max',
        '--image', imgPath,
      ], sLive, {
        codexReceiptDir: testReceiptStore,
        codexMockExecutor: async ({ outputFilePath }) => {
          writeFileSync(outputFilePath, `${JSON.stringify(validReview)}\n`, 'utf8');
          return { exitCode: 0 };
        },
      });
      assert.equal(liveCode, 0, sLive.getErr());
      const liveSummary = JSON.parse(sLive.getOut());
      assert.equal(liveSummary.ok, true);
      assert.equal(liveSummary.status, 'ready');
      assert.equal(liveSummary.execution_provenance, 'synthetic_test_double');
      assert.deepEqual(liveSummary.disposition_counts, { included: 1, excluded: 1, pending: 1 });

      // 3) Attach liveOutPath review envelope + concept image to synthetic r58 batch -> score & render HTML
      const reviewEnvelope = JSON.parse(readFileSync(liveOutPath, 'utf8'));
      const rawBatch = JSON.parse(readFileSync(SYNTHETIC_BATCH_PATH, 'utf8'));
      const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));

      const baselineScored = scoreBatch(structuredClone(rawBatch), profile);
      const baselineSha = sha256Hex(Buffer.from(`${JSON.stringify(baselineScored, null, 2)}\n`, 'utf8'));

      // P1-07: Mutated OR explicitly empty `[]` attachment digest list marks an image-backed review stale!
      const staleByImg = attachCandidateEvidenceReview({ id: 'synthetic-complete' }, reviewEnvelope, frozen, {
        attachmentSha256s: ['f'.repeat(64)],
        receiptStoreDir: testReceiptStore,
        allowTestDoubleReceipt: true,
      });
      assert.equal(staleByImg.status, 'unavailable');
      assert.equal(staleByImg.execution_status, 'stale_packet_mismatch');

      const staleByEmptyList = attachCandidateEvidenceReview({ id: 'synthetic-complete' }, reviewEnvelope, frozen, {
        attachmentSha256s: [],
        receiptStoreDir: testReceiptStore,
        allowTestDoubleReceipt: true,
      });
      assert.equal(staleByEmptyList.status, 'unavailable');
      assert.equal(staleByEmptyList.execution_status, 'stale_packet_mismatch');

      const enrichedBatch = structuredClone(rawBatch);
      attachCandidateEvidenceReview(enrichedBatch.candidates[0], reviewEnvelope, frozen, {
        currentImagePaths: [imgPath],
        receiptStoreDir: testReceiptStore,
        allowTestDoubleReceipt: true,
      });
      enrichedBatch.candidates[0].concept_images = [
        {
          data_uri: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
          title: '加厚硅胶防滑底垫改款示意',
          caption: '针对桌面滑动痛点的轻改进概念图。',
        },
      ];

      const enrichedScored = scoreBatch(enrichedBatch, profile);
      const enrichedSha = sha256Hex(Buffer.from(`${JSON.stringify(enrichedScored, null, 2)}\n`, 'utf8'));
      // Product-P3 invariant: attaching advisory evidence_review & concept_images changes ZERO 21-item scores!
      assert.equal(enrichedSha, baselineSha);

      const html = renderReport(enrichedScored, enrichedBatch, {
        receiptStoreDir: testReceiptStore,
        allowTestDoubleReceipts: true,
      });
      assert.match(html, /独立红队复核 · Red-Team Audit/);
      assert.match(html, /已复核/);
      assert.match(html, /Synthetic Test Double · max/);
      assert.match(html, /ev-peer-03-a/);
      assert.match(html, /补证路径：Inspect verified-purchase review gallery or supplier pack specification\./);
      assert.match(html, /微创新改款概念 · Concept Plinth/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('degrades pipeline hooks gracefully when disabled/offline and attaches Gate-4 review in runPhase2Batch without altering scores', async () => {
    // 1) Standalone pipeline stage helpers degrade to `unavailable` when disabled (default)
    const lunaOff = await runOptionalStage12LunaTriage({
      candidates: [{ candidate_id: 'SYNTH-01', title: 'Steel Desktop Shelf', price_usd: 39.99 }],
    });
    assert.equal(lunaOff.status, 'unavailable');
    assert.equal(lunaOff.execution_status, 'not_submitted');
    assert.equal(lunaOff.deterministic_gate0[0].gate0.passed, true);

    const visionOff = await runOptional1688VisionPrecheck({
      target_spec: { material: '304 stainless steel' },
      images: [`data:image/png;base64,${ONE_PIXEL_PNG_B64}`],
    });
    assert.equal(visionOff.status, 'unavailable');
    assert.equal(visionOff.request.model, 'gpt-6.1-terra');

    const rightsOff = await runOptionalRightsPreScreen({
      form_id: 'form-synth-01',
      label: 'Steel Desktop Organizer',
      buyer_task: 'Desktop storage',
    });
    assert.equal(rightsOff.status, 'unavailable');
    assert.ok(!Object.hasOwn(rightsOff.request, 'max_tool_calls'));

    const judgeOff = await runOptionalReviewJudge({
      item_id: 'clear_pain_point',
      candidate_spec: { label: 'Steel Desktop Organizer' },
      reviews: [],
    });
    assert.equal(judgeOff.status, 'unavailable');

    const packet = buildSyntheticPacket();
    const gate4Off = await runOptionalGate4EvidenceReview(packet, { enabled: false });
    assert.equal(gate4Off.status, 'unavailable');

    // P0-25: Non-boolean string `"false"` must NEVER coerce to enabled=true or spawn codex!
    let bogusSpawns = 0;
    const gate4BogusBool = await runOptionalGate4EvidenceReview(packet, {
      enabled: 'false',
      spawnImpl: () => { bogusSpawns += 1; throw new Error('Must not spawn'); },
    });
    assert.equal(gate4BogusBool.status, 'unavailable');
    assert.equal(gate4BogusBool.execution_status, 'not_submitted');
    assert.equal(bogusSpawns, 0);

    // P2-01 & P2-02: Invalid Luna threshold fails BEFORE dispatch, and ACCOUNT_FENCED_PENDING_RECOVERY preserves completed chunks!
    let lunaBadThreshCalls = 0;
    const lunaBadThresh = await runOptionalStage12LunaTriage({
      candidates: [{ candidate_id: 'SYNTH-01', title: 'Steel Desktop Shelf', price_usd: 39.99 }],
      prohibitedThreshold: 1.2,
      enabled: true,
      decisionExecutor: async () => { lunaBadThreshCalls += 1; return {}; },
    });
    assert.equal(lunaBadThresh.status, 'unavailable');
    assert.equal(lunaBadThresh.execution_status, 'not_submitted');
    assert.equal(lunaBadThreshCalls, 0);

    const manyCands = Array.from({ length: 205 }, (_, idx) => ({
      candidate_id: `SYNTH-M-${idx + 1}`,
      title: `Steel Desktop Shelf ${idx + 1}`,
      price_usd: 39.99,
    }));
    const lunaFencedChunk2 = await runOptionalStage12LunaTriage({
      candidates: manyCands,
      enabled: true,
      decisionExecutor: async (req, chunkIdx) => {
        if (chunkIdx === 0) {
          return {
            status: 'completed',
            usable: true,
            content_status: 'usable',
            attempt_id: 'att-chunk-01',
            logical_request_id: 'log-chunk-01',
            provider_response_id: 'dec-resp-chunk-01',
            decisions: req.questions.map(q => ({
              id: q.id,
              type: q.type,
              value: q.type === 'predicate' ? false : 'exact_peer',
            })),
          };
        }
        const fencedErr = new Error('Account fenced by older attempt');
        fencedErr.code = 'ACCOUNT_FENCED_PENDING_RECOVERY';
        fencedErr.not_dispatched = true;
        fencedErr.blocking_attempt_id = 'att-older-unresolved';
        throw fencedErr;
      },
    });
    assert.equal(lunaFencedChunk2.status, 'unavailable');
    assert.equal(lunaFencedChunk2.execution_status, 'partial_completed');
    assert.equal(lunaFencedChunk2.blocking_attempt_id, 'att-older-unresolved');
    assert.equal(lunaFencedChunk2.completed_chunks.length, 1);
    assert.equal(lunaFencedChunk2.completed_chunks[0].attempt_id, 'att-chunk-01');
    assert.equal(lunaFencedChunk2.completed_chunks[0].provider_response_id, 'dec-resp-chunk-01');

    // P1-12: Invalid (`usable: false`) or all-refused (`content_status: 'refused'`) Decisions responses must NOT become `ready`!
    const lunaInvalidTrailing = await runOptionalStage12LunaTriage({
      candidates: [{ candidate_id: 'SYNTH-01', title: 'Steel Desktop Shelf', price_usd: 39.99 }],
      enabled: true,
      decisionExecutor: async (req) => ({
        status: 'completed',
        usable: false,
        content_status: 'invalid',
        attempt_id: 'att-invalid-dec',
        provider_response_id: 'dec-invalid-01',
        decisions: req.questions.map(q => ({
          id: q.id,
          type: q.type,
          value: q.type === 'predicate' ? false : 'exact_peer',
        })),
      }),
    });
    assert.equal(lunaInvalidTrailing.status, 'unavailable');
    assert.equal(lunaInvalidTrailing.content_status, 'invalid');

    const lunaAllRefused = await runOptionalStage12LunaTriage({
      candidates: [{ candidate_id: 'SYNTH-01', title: 'Steel Desktop Shelf', price_usd: 39.99 }],
      enabled: true,
      decisionExecutor: async (req) => ({
        status: 'completed',
        usable: false,
        content_status: 'refused',
        attempt_id: 'att-refused-dec',
        provider_response_id: 'dec-refused-01',
        decisions: req.questions.map(q => ({
          id: q.id,
          type: 'refusal',
          refusal: 'Insufficient information',
        })),
      }),
    });
    assert.equal(lunaAllRefused.status, 'unavailable');
    assert.equal(lunaAllRefused.content_status, 'refused');

    // Stale packet guard marks mismatched review `unavailable`
    const frozen1 = freezeEvidenceReviewPacket(packet);
    const validRev1 = buildValidReviewForPacket(frozen1);
    const readyEnv1 = await runOptionalGate4EvidenceReview(packet, {
      enabled: true,
      reasoningEffort: 'xhigh',
      reviewExecutor: async () => validRev1,
    });
    assert.equal(readyEnv1.status, 'ready');

    const changedPacket = buildSyntheticPacket({
      questions: [
        {
          question_id: 'q-peer-set-parity',
          question: 'Updated question text changing packet_sha256?',
          subject_ids: ['peer-synth-03'],
          criterion_ids: ['crit-task-material'],
        },
      ],
    });
    const dummyCand = { id: 'synthetic-complete' };
    const attachedStale = attachCandidateEvidenceReview(dummyCand, readyEnv1, changedPacket);
    assert.equal(attachedStale.status, 'unavailable');
    assert.equal(attachedStale.execution_status, 'stale_packet_mismatch');

    // 2) Full `runPhase2Batch` end-to-end with Gate-4 reviewExecutor preserves exact per-candidate score hash
    const rawBatch = JSON.parse(readFileSync(SYNTHETIC_BATCH_PATH, 'utf8'));
    const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    const synthCand = structuredClone(rawBatch.candidates[0]);
    const formId = synthCand.id;

    // Extract price & FX from synthetic-complete's primary scenario so Stage 3 binding passes 100%
    const primaryScen = synthCand.economics.scenarios[0];
    const priceUsd = primaryScen.cost_ledger.price_usd;
    const lines = primaryScen.cost_ledger.lines;
    const findAmt = id => lines.find(l => l.id === id)?.amount_usd;
    const procAmtUsd = findAmt('procurement');
    const domAmtUsd = findAmt('domestic_freight');
    const headhaulUsd = findAmt('headhaul');
    const fx = 7.0;
    const unitGoodsCny = Math.round(procAmtUsd * fx * 10000) / 10000;
    const totalDomCny = Math.round(domAmtUsd * fx * 100 * 100) / 100;
    const salesWin = { from: '2027-02-01', through: '2027-10-14' };
    const storageWin = { from: '2027-02-01', through: '2027-09-30' };
    const inboundWin = { from: '2027-01-20', through: '2027-02-01' };

    const { estimateGate1A2027 } = await import('../src/fba-calculator.mjs');
    const gate1aSpec = {
      id: primaryScen.id,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
      price_usd: priceUsd,
      fx_cny_per_usd: fx,
      refund_fraction: 0.02,
      physical_return_fraction: 0.02,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
      headhaul_usd: headhaulUsd,
      collection_rate: 0.006,
      sales_window: salesWin,
      storage_window: storageWin,
      inbound_window: inboundWin,
      is_apparel: false,
      is_dangerous_goods: false,
      is_sipp: false,
    };
    const rawEst = estimateGate1A2027(gate1aSpec);
    assert.equal(rawEst.status, 'verified', rawEst.reason);
    const cachedEst = {
      fulfillment_usd: rawEst.components.fulfillment.total_usd,
      placement_usd: rawEst.components.placement.selected_usd,
      storage_usd: rawEst.components.storage.per_unit_usd,
    };

    const matchedPacket = buildSyntheticPacket({ candidate: { ...packet.candidate, saleable_spec: { components: [{ component_id: 'shelf-main', qty_per_saleable_set: 1 }], material: 'Powder-coated carbon steel', set_count: 1 } } });
    const buildBatchItem = (withPacket) => ({
      form: {
        form_id: formId,
        label: synthCand.label,
        buyer_task: 'Desktop dual-shelf cable and stationery organizer',
        saleable_set_composition: {
          components: [{ component_id: 'shelf-main', qty_per_saleable_set: 1 }], material: 'Powder-coated carbon steel', set_count: 2,
        },
      },
      leads: [
        {
          lead_id: 'lead-synth-p4-01',
          source_channel: 'reddit',
          source_ref: 'https://example.com/r/desksetup/synth-01',
          phrase_or_title: 'steel desktop organizer shelf',
          observed_at: '2026-11-20',
          disposition: 'product',
        },
      ],
      gate1a_scenarios: [gate1aSpec],
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: {
          quote_id: 'q1688-synth-p4-01',
          observed_at: '2026-11-20',
          expires_at: '2026-12-31',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'synthetic-readback-01',
          ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [
            {
              offer_id: 'synth-offer-01',
              sku_id: 'shelf-main',
              component_id: 'shelf-main',
              qty_per_saleable_set: 1,
              pack_multiple: 1,
              moq_qty: 100,
              ordered_qty: 100,
              unit_price_cny: unitGoodsCny,
              regular_goods_promo_false: true,
            },
          ],
          goods_cny_total: Math.round(unitGoodsCny * 100 * 100) / 100,
          domestic_freight_cny_total: totalDomCny,
        },
      }),
      early_screen_builder: () => ([{
        profile_revision: 59,
        id: primaryScen.id,
        saleable_unit: '1 complete set',
        price_usd: priceUsd,
        fx_cny_per_usd: fx,
        order_units: 100,
        goods_cny_per_unit: unitGoodsCny,
        domestic_freight_cny_per_unit: totalDomCny / 100,
        first_order_promotion: false,
        goods_first_order_promotion: false,
        headhaul: { usd_per_unit: headhaulUsd, bond_included: true },
        refund_fraction: 0.02,
        physical_return_fraction: 0.02,
        return_threshold: 0.08,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
        fulfillment_usd: cachedEst.fulfillment_usd,
        placement_usd: cachedEst.placement_usd,
        storage: {
          cubic_feet_per_unit: (10 * 6 * 2) / 1728,
          rate_usd_per_cuft_month: 0.78,
          average_inventory_days: 45,
        },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        fee_context: {
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pack-1',
          sales: salesWin,
          storage: storageWin,
          inbound: inboundWin,
        },
        collection_rate: 0.006,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }]),
      deep_research_executor: async () => {
        const alignedCand = structuredClone(synthCand);
        const ledger = alignedCand.economics.scenarios[0].cost_ledger;
        ledger.fee_context.sales = salesWin;
        ledger.fee_context.storage = storageWin;
        ledger.fee_context.inbound = inboundWin;
        for (const l of ledger.lines) {
          if (l.id === 'procurement' || l.id === 'domestic_freight') {
            l.fx_cny_per_usd = fx;
            l.order_units = 100;
          }
          if (l.id === 'fulfillment') l.amount_usd = cachedEst.fulfillment_usd;
          if (l.id === 'placement') l.amount_usd = cachedEst.placement_usd;
          if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, cachedEst.storage_usd);
        }
        return {
          batch: {
            schema_version: 1,
            profile_revision: 59,
            presentation: rawBatch.presentation,
            candidates: [alignedCand],
          },
          ...(withPacket ? { evidence_review_packet: matchedPacket } : {}),
        };
      },
    });

    const tempExportDir = mkdtempSync(join(tmpdir(), 'p4-export-roundtrip-'));
    try {
      const roundtripDbPath = join(tempExportDir, 'selection-roundtrip.sqlite');
      const storeNoAi = openSelectionStore(':memory:');
      const outNoAi = await runPhase2Batch(storeNoAi, {
        items: [buildBatchItem(false)],
        profile,
        as_of_date: '2026-11-21',
      });
      assert.equal(outNoAi.gate2_3[0]?.status, 'evaluated', JSON.stringify(outNoAi.gate1b));

      // P1-17: Persist reviewed evaluation into file-backed SQLite, close, reopen via CLI `export-report`,
      // and verify exported `index.html` SHA-256 reproduces `outWithAi.gate2_3[0].html_sha256` byte-for-byte!
      // P1-16 & P1-17: Persist receipt-verified evaluation into file-backed SQLite, close, reopen via CLI `export-report`,
      // and verify exported `index.html` SHA-256 reproduces `outWithAi.gate2_3[0].html_sha256` byte-for-byte!
      const roundtripReceiptDir = join(tempExportDir, 'codex-receipts');
      mkdirSync(roundtripReceiptDir, { recursive: true });
      const exportTestHooks = {
        codexReceiptDir: roundtripReceiptDir,
        allowTestDoubleReceipts: true,
      };
      const storeWithAi = openSelectionStore(roundtripDbPath);
      const frozenBundle1Pkt = freezeEvidenceReviewPacket(matchedPacket);
      const outWithAi = await runPhase2Batch(storeWithAi, {
        items: [buildBatchItem(true)],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          evidence_review: {
            enabled: true,
            testMode: true,
            allowTestDoubleReceipt: true,
            reasoningEffort: 'max',
            receiptDir: roundtripReceiptDir,
            mockExecutor: async ({ outputFilePath }) => {
              writeFileSync(outputFilePath, `${JSON.stringify(buildValidReviewForPacket(frozenBundle1Pkt))}\n`, 'utf8');
              return { exitCode: 0 };
            },
          },
        },
      });
      assert.equal(outWithAi.gate2_3[0].status, 'evaluated');
      assert.equal(outWithAi.gate2_3[0].evidence_review.status, 'ready', JSON.stringify(outWithAi.gate2_3[0].evidence_review));
      assert.equal(outWithAi.gate2_3[0].evidence_review.execution_provenance, 'synthetic_test_double');
      assert.equal(outWithAi.gate2_3[0].result_sha256, outNoAi.gate2_3[0].result_sha256);
      assert.equal(outWithAi.gate2_3[0].batch_result_sha256, outNoAi.gate2_3[0].batch_result_sha256);
      assert.equal(
        outWithAi.evaluations[0].evidence_bundle_sha256,
        outNoAi.evaluations[0].evidence_bundle_sha256,
      );
      assert.notEqual(outWithAi.gate2_3[0].html_sha256, outNoAi.gate2_3[0].html_sha256);
      storeWithAi.close();

      // Write unadorned batch JSON matching Stage 3 input (WITHOUT evidence_review on JSON file!)
      const batchForExport = (await buildBatchItem(false).deep_research_executor()).batch;
      const batchFilePath = join(tempExportDir, 'batch-for-export.json');
      const exportOutDir = join(tempExportDir, 'exported-report');
      writeFileSync(batchFilePath, JSON.stringify(batchForExport, null, 2), 'utf8');

      const sExport = makeCapturingStreams();
      const exportCode = await runPhase2Cli([
        'export-report',
        '--db', roundtripDbPath,
        '--batch', batchFilePath,
        '--profile', PROFILE_PATH,
        '--output', exportOutDir,
      ], sExport, exportTestHooks);
      assert.equal(exportCode, 0, sExport.getErr());
      const exportedHtml = readFileSync(join(exportOutDir, 'index.html'), 'utf8');
      assert.match(exportedHtml, /已复核/);
      assert.match(exportedHtml, /lang="zh-CN"/);

      // P1-17 Case A: Two evaluations for the SAME form/spec with DIFFERENT evidence bundles (e.g. second run adds candidate review_note)
      // must each reproduce their OWN exact `html_sha256` on `export-report`!
      const secondBundleItem = buildBatchItem(true);
      const origSecondExec = secondBundleItem.deep_research_executor;
      const secondPacket = buildSyntheticPacket({ review_id: 'rev-phase4-synth-02', candidate: matchedPacket.candidate });
      const frozenBundle2Pkt = freezeEvidenceReviewPacket(secondPacket);
      secondBundleItem.deep_research_executor = async () => {
        const base = await origSecondExec();
        base.batch.candidates[0].review_notes = ['Second bundle distinct note for P1-17 multi-bundle test.'];
        return { batch: base.batch, evidence_review_packet: secondPacket };
      };
      const storeReopenedA = openSelectionStore(roundtripDbPath);
      const outBundle2 = await runPhase2Batch(storeReopenedA, {
        items: [secondBundleItem],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          evidence_review: {
            enabled: true,
            testMode: true,
            allowTestDoubleReceipt: true,
            reasoningEffort: 'xhigh',
            receiptDir: roundtripReceiptDir,
            mockExecutor: async ({ outputFilePath }) => {
              writeFileSync(outputFilePath, JSON.stringify({
                ...buildValidReviewForPacket(frozenBundle2Pkt),
                conclusion: 'Second bundle xhigh review conclusion.',
              }), 'utf8');
              return { exitCode: 0 };
            },
          },
        },
      });
      assert.equal(outBundle2.gate2_3[0].status, 'evaluated');
      assert.notEqual(outBundle2.evaluations[0].evidence_bundle_sha256, outWithAi.evaluations[0].evidence_bundle_sha256);
      assert.notEqual(outBundle2.gate2_3[0].html_sha256, outWithAi.gate2_3[0].html_sha256);
      storeReopenedA.close();

      // Re-exporting Bundle 1 still reproduces Bundle 1's exact max-reviewed HTML SHA-256, AND exporting Bundle 2 reproduces Bundle 2's exact xhigh HTML SHA-256!
      const exportOutDirB1Again = join(tempExportDir, 'exported-report-b1-again');
      const sExportB1Again = makeCapturingStreams();
      assert.equal(await runPhase2Cli([
        'export-report',
        '--db', roundtripDbPath,
        '--batch', batchFilePath,
        '--profile', PROFILE_PATH,
        '--output', exportOutDirB1Again,
      ], sExportB1Again, exportTestHooks), 0, sExportB1Again.getErr());
      const b1AgainHtml = readFileSync(join(exportOutDirB1Again, 'index.html'), 'utf8');
      assert.match(b1AgainHtml, /已复核/);
      assert.doesNotMatch(b1AgainHtml, /Second bundle xhigh review conclusion/);

      const batch2ForExport = (await secondBundleItem.deep_research_executor()).batch;
      const batch2FilePath = join(tempExportDir, 'batch2-for-export.json');
      const exportOutDirB2 = join(tempExportDir, 'exported-report-b2');
      writeFileSync(batch2FilePath, JSON.stringify(batch2ForExport, null, 2), 'utf8');
      const sExportB2 = makeCapturingStreams();
      assert.equal(await runPhase2Cli([
        'export-report',
        '--db', roundtripDbPath,
        '--batch', batch2FilePath,
        '--profile', PROFILE_PATH,
        '--output', exportOutDirB2,
      ], sExportB2, exportTestHooks), 0, sExportB2.getErr());
      const b2Html = readFileSync(join(exportOutDirB2, 'index.html'), 'utf8');
      assert.match(b2Html, /已复核/);
      assert.match(b2Html, /Second bundle xhigh review conclusion\./);

      // P1-17 Case B: Identical unreviewed rerun on Bundle 1 preserves `(evidence_review_json, html_sha256)` atomically,
      // while recording the unreviewed version in `receipt.batch_receipts[]` so BOTH default `export-report` AND `--verify-html <unreviewedSha>` reproduce exact bytes!
      const storeReopenedB = openSelectionStore(roundtripDbPath);
      const outUnreviewedRerun = await runPhase2Batch(storeReopenedB, {
        items: [buildBatchItem(false)],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          evidence_review: {
            receiptStoreDir: roundtripReceiptDir,
            allowTestDoubleReceipt: true,
          },
        },
      });
      assert.equal(outUnreviewedRerun.evaluations[0].html_sha256, outWithAi.gate2_3[0].html_sha256);
      assert.equal(outUnreviewedRerun.gate2_3[0].html_sha256, outWithAi.gate2_3[0].html_sha256);
      assert.equal(outUnreviewedRerun.gate2_3[0].this_run_html_sha256, outNoAi.gate2_3[0].html_sha256);
      storeReopenedB.close();

      const exportOutDirPreserved = join(tempExportDir, 'exported-report-preserved');
      const sExportPreserved = makeCapturingStreams();
      assert.equal(await runPhase2Cli([
        'export-report',
        '--db', roundtripDbPath,
        '--batch', batchFilePath,
        '--profile', PROFILE_PATH,
        '--output', exportOutDirPreserved,
      ], sExportPreserved, exportTestHooks), 0, sExportPreserved.getErr());
      const preservedHtml = readFileSync(join(exportOutDirPreserved, 'index.html'), 'utf8');
      assert.match(
        preservedHtml,
        /已复核/,
        'reopened export-report must preserve persisted reviewed state after unreviewed rerun',
      );
      assert.equal(
        outUnreviewedRerun.evaluations[0].html_sha256,
        outWithAi.gate2_3[0].html_sha256,
      );

      // Exporting explicitly by the unreviewed receipt's `batch_html_sha256` (`--verify-html`) reproduces the unreviewed HTML bytes too!
      const exportOutDirUnrevReceipt = join(tempExportDir, 'exported-report-unrev-receipt');
      const sExportUnrevReceipt = makeCapturingStreams();
      assert.equal(await runPhase2Cli([
        'export-report',
        '--db', roundtripDbPath,
        '--batch', batchFilePath,
        '--profile', PROFILE_PATH,
        '--verify-html', outNoAi.gate2_3[0].html_sha256,
        '--output', exportOutDirUnrevReceipt,
      ], sExportUnrevReceipt, exportTestHooks), 0, sExportUnrevReceipt.getErr());
      assert.equal(
        sha256Hex(readFileSync(join(exportOutDirUnrevReceipt, 'index.html'))),
        outNoAi.gate2_3[0].html_sha256,
      );

      // P1-15: An inline PII/secret-tainted unavailable marker on researchOut.evidence_review MUST be sanitized safely without aborting deterministic evaluation!
      const storeTaintedOpt = openSelectionStore(':memory:');
      const taintedItem = buildBatchItem(false);
      const origTaintedExec = taintedItem.deep_research_executor;
      taintedItem.deep_research_executor = async () => ({
        ...(await origTaintedExec()),
        evidence_review: {
          status: 'unavailable',
          reason: 'Unavailable note',
          leaked_extra_field: 'Call 13812345678 with Bearer rogueSecretToken99999',
        },
      });
      const outTaintedOpt = await runPhase2Batch(storeTaintedOpt, {
        items: [taintedItem],
        profile,
        as_of_date: '2026-11-21',
      });
      assert.equal(outTaintedOpt.gate2_3[0].status, 'evaluated', 'tainted optional unavailable marker must never abort deterministic evaluation');
      assert.equal(outTaintedOpt.gate2_3[0].result_sha256, outNoAi.gate2_3[0].result_sha256);
      storeTaintedOpt.close();

      // P0-29: Hook-supplied `beforeDispatchGuard` CANNOT override controller deferral guard between Luna chunks,
      // AND busy `gate1b_1688_queue` lease prevents `vision_1688_precheck` dispatch!
      let lunaChunkCalls = 0;
      const storeGuardOverride = openSelectionStore(':memory:');
      const guardOverrideItem = buildBatchItem(false);
      guardOverrideItem.luna_triage_candidates = manyCands;
      const outGuardOverride = await runPhase2Batch(storeGuardOverride, {
        items: [guardOverrideItem],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          luna_triage: {
            enabled: true,
            beforeDispatchGuard: () => { /* caller tries to override controller guard with no-op! */ },
            decisionExecutor: async (req, chunkIdx) => {
              lunaChunkCalls += 1;
              if (chunkIdx === 0) {
                storeGuardOverride.updateFormLifecycle(formId, 'deferred', {
                  cooldown_until: '2027-04-01',
                  cooldown_reason: 'Deferred mid-Luna chunks.',
                });
              }
              return {
                status: 'completed',
                usable: true,
                content_status: 'usable',
                attempt_id: `att-guard-${chunkIdx}`,
                provider_response_id: `resp-guard-${chunkIdx}`,
                decisions: req.questions.map(q => ({
                  id: q.id,
                  type: q.type,
                  value: q.type === 'predicate' ? false : 'exact_peer',
                })),
              };
            },
          },
        },
      });
      assert.equal(lunaChunkCalls, 1, 'controller beforeDispatchGuard must block chunk 2 despite caller hook beforeDispatchGuard');
      assert.equal(outGuardOverride.gate1a[0].luna_triage.status, 'unavailable');
      storeGuardOverride.close();

      let busyLeaseVisionCalls = 0;
      const storeBusyLease = openSelectionStore(':memory:');
      storeBusyLease.acquireQueueLease('gate1b_1688_queue', 'external-other-worker');
      const busyItem = buildBatchItem(false);
      busyItem.vision_1688_input = {
        target_spec: { material: 'Carbon steel' },
        images: [`data:image/png;base64,${ONE_PIXEL_PNG_B64}`],
      };
      const outBusyLease = await runPhase2Batch(storeBusyLease, {
        items: [busyItem],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          vision_1688: {
            enabled: true,
            responseExecutor: async () => { busyLeaseVisionCalls += 1; return {}; },
          },
        },
      });
      assert.equal(busyLeaseVisionCalls, 0, 'busy gate1b_1688_queue lease must prevent vision_1688_precheck dispatch');
      assert.equal(outBusyLease.gate1b[0].status, 'skipped_serial_busy');
      storeBusyLease.close();

      // P1-15: Disabled Gate-4 review with a MISSING image path must NOT prevent deterministic recordEvaluation!
      const storeMissingImg = openSelectionStore(':memory:');
      const outMissingImg = await runPhase2Batch(storeMissingImg, {
        items: [buildBatchItem(true)],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          evidence_review: {
            enabled: false,
            imagePaths: [join(tempExportDir, 'nonexistent-missing-attachment.png')],
          },
        },
      });
      assert.equal(outMissingImg.gate2_3[0].status, 'evaluated');
      assert.equal(outMissingImg.gate2_3[0].evidence_review.status, 'unavailable');
      storeMissingImg.close();

      // P0-29: Rejected Gate-1A form (< $29.99 floor) must trigger ZERO paid Luna calls!
      let rejectedLunaCalls = 0;
      const storeRej = openSelectionStore(':memory:');
      const rejItem = buildBatchItem(false);
      rejItem.form.form_id = 'form-synth-below-floor';
      rejItem.gate1a_scenarios = [{ ...gate1aSpec, price_usd: 19.99 }];
      rejItem.luna_triage_candidates = [{ candidate_id: 'SYNTH-REJ-1', title: 'Cheap Tray', price_usd: 19.99 }];
      const outRej = await runPhase2Batch(storeRej, {
        items: [rejItem],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          luna_triage: {
            enabled: true,
            decisionExecutor: async () => { rejectedLunaCalls += 1; return {}; },
          },
        },
      });
      assert.equal(rejectedLunaCalls, 0, 'Gate-1A rejected form must dispatch zero Luna calls');
      assert.equal(outRej.skipped_zero_incremental.some(x => x.form_id === 'form-synth-below-floor'), true);
      storeRej.close();

      // P0-29: Concurrent deferral during rights_prescreen must prevent subsequent review_judge & Gate-4 calls!
      let rightsCalls = 0;
      let judgeCallsAfterDeferral = 0;
      let gate4CallsAfterDeferral = 0;
      const storeDefer = openSelectionStore(':memory:');
      const deferItem = buildBatchItem(true);
      deferItem.rights_prescreen_input = {
        form_id: formId,
        label: synthCand.label,
        buyer_task: 'Desktop dual-shelf cable and stationery organizer',
      };
      deferItem.review_judge_input = {
        item_id: 'clear_pain_point',
        candidate_spec: { label: synthCand.label },
        reviews: [],
      };
      const outDefer = await runPhase2Batch(storeDefer, {
        items: [deferItem],
        profile,
        as_of_date: '2026-11-21',
        openai_hooks: {
          rights_prescreen: {
            enabled: true,
            responseExecutor: async () => {
              rightsCalls += 1;
              // Simulate concurrent operator deferral during rights_prescreen await!
              storeDefer.updateFormLifecycle(formId, 'deferred', {
                cooldown_until: '2027-03-01',
                cooldown_reason: 'Operator deferred form concurrently.',
              });
              return { status: 'completed', usable: false, content_status: 'incomplete' };
            },
          },
          review_judge: {
            enabled: true,
            responseExecutor: async () => { judgeCallsAfterDeferral += 1; return {}; },
          },
          evidence_review: {
            enabled: true,
            reviewExecutor: async () => { gate4CallsAfterDeferral += 1; return {}; },
          },
        },
      });
      assert.equal(rightsCalls, 1);
      assert.equal(judgeCallsAfterDeferral, 0, 'review_judge must not dispatch after concurrent deferral');
      assert.equal(gate4CallsAfterDeferral, 0, 'Gate-4 review must not dispatch after concurrent deferral');
      assert.equal(outDefer.gate2_3[0].status, 'deferred');
      storeDefer.close();

      // P1-15: Malformed optional vision_1688_input & malformed evidence_review_packet must NOT abort deterministic evaluation!
      const storeMalformedOpt = openSelectionStore(':memory:');
      const malformedOptItem = buildBatchItem(false);
      malformedOptItem.vision_1688_input = { target_spec: {}, images: ['not-a-valid-data-uri'] };
      const origExec = malformedOptItem.deep_research_executor;
      malformedOptItem.deep_research_executor = async () => ({
        ...(await origExec()),
        evidence_review_packet: { broken_unadmitted_packet: true },
      });
      const outMalformedOpt = await runPhase2Batch(storeMalformedOpt, {
        items: [malformedOptItem],
        profile,
        as_of_date: '2026-11-21',
      });
      assert.equal(outMalformedOpt.gate1b[0].vision_1688_precheck.status, 'unavailable');
      assert.equal(outMalformedOpt.gate2_3[0].status, 'evaluated');
      assert.equal(outMalformedOpt.gate2_3[0].evidence_review.status, 'unavailable');
      storeMalformedOpt.close();

      storeNoAi.close();
    } finally {
      try { rmSync(tempExportDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows temp cleanup best-effort */ }
    }
  });

  it('exempts canonical SHA-256 digests, UUIDs, and raster data URIs from phone-digit false positives while catching supplier vx/tel phone strings', () => {
    const collidingSha256 = 'a13812345678f0123456789abcdef0123456789abcdef0123456789abcdef012';
    const collidingUuid = '550e8400-e29b-41d4-0755-88888888a1b2';
    const collidingDataUri = 'data:image/png;base64,iVBORw0KGgoA13912345678B+/==';

    assert.equal(detectRawPii(collidingSha256), null);
    assert.equal(detectRawPii(collidingUuid), null);
    assert.equal(detectRawPii(collidingDataUri), null);
    assert.doesNotThrow(() => assertNoRawPii({
      receipt_sha256: collidingSha256,
      request_uuid: collidingUuid,
      image_data_uri: collidingDataUri,
    }, 'hash_collision_envelope'));

    assert.equal(detectRawPii('厂家联系 vx13812345678 拿样'), 'cn_mobile_number');
    assert.equal(detectRawPii(`附哈希 ${collidingSha256} 手机 13812345678`), 'cn_mobile_number');
    assert.equal(
      sanitizeDiagnosticText(`receipt=${collidingSha256} uuid=${collidingUuid} contact=vx13812345678 tel=0755-88888888`),
      `receipt=${collidingSha256} uuid=${collidingUuid} contact=vx[REDACTED_PHONE] tel=[REDACTED_PHONE]`,
    );
  });
});
