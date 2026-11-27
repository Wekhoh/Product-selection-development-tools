import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { runPhase2Batch } from '../src/pipeline.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { estimateGate1A2027, getFba2027RateTableSnapshot } from '../src/fba-calculator.mjs';
import {
  OpenAiBudgetError,
  OpenAiClient,
  OpenAiPolicyError,
  inspectLegacyAutopilotBudget,
  openOpenAiBudgetLedger,
} from '../src/openai/index.mjs';
import { makeStage4OrganizerTrayCandidate } from './helpers/stage4-fixtures.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);
const syntheticFixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'),
);

const SYNTHETIC_API_KEY = 'sk-proj-BatchA3SyntheticTestKey0123456789ABCDEF';
const VALID_UI_READBACK = {
  logged_in: true,
  viewport_width_px: 1440,
  selected_sku_row_visible: true,
  settlement_bar_visible: true,
  applied_quantity_confirmed: true,
};

async function runCliMem(args, testHooks = null) {
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

function makeActivatedTestBudgetDb(dir, name = 'budget.sqlite') {
  const dbPath = join(dir, name);
  const credPath = join(dir, 'cred.json');
  writeFileSync(credPath, JSON.stringify({ api_key: SYNTHETIC_API_KEY }));
  const ledgerOpts = { testMode: true };
  const ledger = openOpenAiBudgetLedger(dbPath, ledgerOpts);
  ledger.reconcileLegacySummary(
    {
      recognized_schema: true,
      file_sha256: '0'.repeat(64),
      month_utc: new Date().toISOString().slice(0, 7),
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
      monthlyLimitCents: 20_000,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    },
  );
  ledger.close();
  return { dbPath, credPath, ledgerOpts };
}

function makeBatchOutputLine(customId, text, { inputTokens = 1000, outputTokens = 500, model = 'gpt-6.1-terra' } = {}) {
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

function makeBatchErrorLine(customId, message = 'Rate limit exceeded', statusCode = 429) {
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

function makeJsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': typeof body === 'string' ? 'application/jsonl' : 'application/json' },
  });
}

test('Batch A3.1: real CLI openai-batch-build -> openai-batch-poll submit -> GET recovery -> out-of-order custom_id alignment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-a3-cli-e2e-'));
  try {
    const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir);
    const itemsPath = join(dir, 'items.json');
    const jsonlPath = join(dir, 'batch.jsonl');
    const submitOutPath = join(dir, 'submit-out.json');

    writeFileSync(itemsPath, JSON.stringify({
      items: [
        {
          custom_id: 'lead-alpha',
          input: {
            platform: 'reddit',
            observed_at: '2026-11-27',
            event_dedup_key: 'reddit-syn-1',
            source_url: 'https://example.com/r/hobby/1',
            source_ref: 'reddit:syn-1',
            post_text: 'Looking for a solid wood desktop paint rack organizer for 1oz bottles.',
          },
        },
        {
          custom_id: 'lead-beta',
          input: {
            platform: 'pinterest',
            observed_at: '2026-11-27',
            event_dedup_key: 'pinterest-syn-2',
            source_url: 'https://example.com/pin/2',
            source_ref: 'pinterest:syn-2',
            post_text: 'Need a compact bamboo drawer tray with removable dividers for craft tools.',
          },
        },
      ],
    }, null, 2));

    const buildRes = await runCliMem([
      'openai-batch-build',
      '--task', 'social-bridge',
      '--input', itemsPath,
      '--output', jsonlPath,
    ]);
    assert.equal(buildRes.code, 0, buildRes.stderr);
    const builtMeta = JSON.parse(buildRes.stdout);
    assert.equal(builtMeta.line_count, 2);
    assert.deepEqual(builtMeta.custom_ids, ['lead-alpha', 'lead-beta']);

    let postFilesCount = 0;
    let postBatchesCount = 0;
    let getBatchCount = 0;
    let getFileContentCount = 0;
    let remoteBatchPhase = 'in_progress';

    const mockFetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'POST' && u.endsWith('/v1/files')) {
        postFilesCount += 1;
        return makeJsonResponse(200, { id: 'file_syn_up_01', object: 'file', purpose: 'batch' });
      }
      if (method === 'POST' && u.endsWith('/v1/batches')) {
        postBatchesCount += 1;
        const body = JSON.parse(String(init.body));
        assert.equal(body.input_file_id, 'file_syn_up_01');
        assert.equal(body.endpoint, '/v1/responses');
        return makeJsonResponse(200, {
          id: 'batch_syn_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_syn_up_01',
          status: 'validating',
        });
      }
      if (method === 'GET' && u.endsWith('/v1/batches/batch_syn_01')) {
        getBatchCount += 1;
        if (remoteBatchPhase === 'in_progress') {
          return makeJsonResponse(200, {
            id: 'batch_syn_01',
            object: 'batch',
            endpoint: '/v1/responses',
            input_file_id: 'file_syn_up_01',
            status: 'in_progress',
            request_counts: { total: 2, completed: 1, failed: 0 },
          });
        }
        return makeJsonResponse(200, {
          id: 'batch_syn_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_syn_up_01',
          output_file_id: 'file_syn_out_01',
          error_file_id: null,
          status: 'completed',
          request_counts: { total: 2, completed: 2, failed: 0 },
        });
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_syn_out_01/content')) {
        getFileContentCount += 1;
        // Intentionally out of order: lead-beta FIRST, lead-alpha SECOND!
        const alphaJson = JSON.stringify({
          schema_version: 1,
          contract: 'SocialBridgeExtractor',
          status: 'extracted',
          platform: 'reddit',
          source_url: 'https://example.com/r/hobby/1',
          source_ref: 'reddit:syn-1',
          observed_at: '2026-11-27',
          event_dedup_key: 'reddit-syn-1',
          verbatim_excerpt: 'solid wood desktop paint rack organizer for 1oz bottles',
          buyer_task: 'organize paint bottles',
          candidate_phrases: ['wood paint rack organizer'],
          notes: 'synthetic alpha',
        });
        const betaJson = JSON.stringify({
          schema_version: 1,
          contract: 'SocialBridgeExtractor',
          status: 'extracted',
          platform: 'pinterest',
          source_url: 'https://example.com/pin/2',
          source_ref: 'pinterest:syn-2',
          observed_at: '2026-11-27',
          event_dedup_key: 'pinterest-syn-2',
          verbatim_excerpt: 'compact bamboo drawer tray with removable dividers for craft tools',
          buyer_task: 'organize craft tools',
          candidate_phrases: ['bamboo drawer tray'],
          notes: 'synthetic beta',
        });
        return makeJsonResponse(200, `${makeBatchOutputLine('lead-beta', betaJson)}\n${makeBatchOutputLine('lead-alpha', alphaJson)}\n`);
      }
      throw new Error(`Unexpected mock fetch: ${method} ${u}`);
    };

    const hooks = {
      testLedgerOptions: ledgerOpts,
      openAiClientOptions: { testMode: true, fetchImpl: mockFetch, baseUrl: 'https://api.openai.com' },
    };

    // 1. Submit valid JSONL through real CLI -> Client path
    const submitRes = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--submit-jsonl', jsonlPath,
      '--output', submitOutPath,
    ], hooks);
    assert.equal(submitRes.code, 0, submitRes.stderr);
    assert.equal(postFilesCount, 1);
    assert.equal(postBatchesCount, 1);
    const submitPayload = JSON.parse(readFileSync(submitOutPath, 'utf8'));
    assert.equal(submitPayload.mode, 'submitted');
    assert.equal(submitPayload.input_file_id, 'file_syn_up_01');
    assert.equal(submitPayload.file_id, 'file_syn_up_01');
    assert.equal(submitPayload.batch_id, 'batch_syn_01');
    assert.equal(submitPayload.batch_status, 'validating');
    assert.equal(submitPayload.request_count, 2);
    assert.ok(submitPayload.attempt_id);
    assert.equal(submitPayload.receipt.provider_response_id, 'batch_syn_01');

    // 2. Second entry with same --submit-jsonl recovers via read-only GET (0 duplicate POSTs!)
    const retrySubmitRes = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--submit-jsonl', jsonlPath,
    ], hooks);
    assert.equal(postFilesCount, 1, 'Second entry must NEVER re-upload file');
    assert.equal(postBatchesCount, 1, 'Second entry must NEVER re-POST /v1/batches');
    assert.equal(getBatchCount, 1);
    const retrySubmitPayload = JSON.parse(retrySubmitRes.stdout);
    assert.equal(retrySubmitPayload.mode, 'recovered_existing_batch');
    assert.equal(retrySubmitPayload.batch_id, 'batch_syn_01');
    assert.equal(retrySubmitPayload.batch_status, 'in_progress');

    // 3. Poll completed batch WITHOUT passing --attempt (auto-binds attempt by batch_id!) & verify out-of-order custom_id alignment
    remoteBatchPhase = 'completed';
    const pollRes = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--batch-id', 'batch_syn_01',
      '--download-output',
    ], hooks);
    assert.equal(pollRes.code, 0, pollRes.stderr);
    assert.equal(postFilesCount, 1);
    assert.equal(postBatchesCount, 1);
    assert.equal(getFileContentCount, 1);
    const pollPayload = JSON.parse(pollRes.stdout);
    assert.equal(pollPayload.mode, 'polled');
    assert.equal(pollPayload.batch_id, 'batch_syn_01');
    assert.equal(pollPayload.batch_status, 'completed');
    assert.equal(pollPayload.parsed_output_count, 2);
    assert.equal(pollPayload.parsed_output.total_lines, 2);
    assert.deepEqual(
      pollPayload.reconciliation.items.map(i => i.custom_id),
      ['lead-alpha', 'lead-beta'],
      'Out-of-order Batch responses must align to submitted manifest custom_id order',
    );
    assert.match(pollPayload.reconciliation.by_custom_id['lead-alpha'].output_text, /wood paint rack/);
    assert.match(pollPayload.reconciliation.by_custom_id['lead-beta'].output_text, /bamboo drawer tray/);
    assert.equal(pollPayload.receipt.status, 'completed');
    assert.ok(pollPayload.receipt.usage_cost_micros > 0);

    // 4. Subsequent poll without --download-output is settled idempotently with zero extra fetches
    const settledPoll = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--batch-id', 'batch_syn_01',
    ], hooks);
    assert.equal(settledPoll.code, 0, settledPoll.stderr);
    assert.equal(JSON.parse(settledPoll.stdout).already_settled, true);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Batch A3.1b: partial success + error_file_id reconciliation, expired partial output, and unknown submission 0-duplicate-POST guard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-a3-partial-'));
  try {
    const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir);

    const writeRawBatchJsonl = (filename, customIds) => {
      const fp = join(dir, filename);
      const lines = customIds.map(cid => JSON.stringify({
        custom_id: cid,
        method: 'POST',
        url: '/v1/responses',
        body: { model: 'gpt-6.1-terra', input: `Synthetic task for ${cid}` },
      }));
      writeFileSync(fp, `${lines.join('\n')}\n`, 'utf8');
      return fp;
    };

    const partialJsonl = writeRawBatchJsonl('partial.jsonl', ['cid-1', 'cid-2', 'cid-3']);
    const expiredJsonl = writeRawBatchJsonl('expired.jsonl', ['exp-1', 'exp-2', 'exp-3']);
    const ambigJsonl = writeRawBatchJsonl('ambig.jsonl', ['amb-1']);

    let mode = 'partial';
    const postCounts = { files: 0, batches: 0 };

    const mockFetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'POST' && u.endsWith('/v1/files')) {
        postCounts.files += 1;
        return makeJsonResponse(200, { id: `file_up_${mode}`, object: 'file', purpose: 'batch' });
      }
      if (method === 'POST' && u.endsWith('/v1/batches')) {
        postCounts.batches += 1;
        if (mode === 'ambig') {
          throw new Error('Simulated network disconnect during POST /v1/batches');
        }
        return makeJsonResponse(200, {
          id: `batch_${mode}_01`,
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: `file_up_${mode}`,
          status: 'validating',
        });
      }
      if (method === 'GET' && u.endsWith('/v1/batches/batch_partial_01')) {
        return makeJsonResponse(200, {
          id: 'batch_partial_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_up_partial',
          output_file_id: 'file_out_partial',
          error_file_id: 'file_err_partial',
          status: 'completed',
          request_counts: { total: 3, completed: 2, failed: 1 },
        });
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_out_partial/content')) {
        // Out of order: cid-3 then cid-1
        return makeJsonResponse(200, `${makeBatchOutputLine('cid-3', 'ok-3')}\n${makeBatchOutputLine('cid-1', 'ok-1')}\n`);
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_err_partial/content')) {
        return makeJsonResponse(200, `${makeBatchErrorLine('cid-2', 'Upstream rate limit')}\n`);
      }
      if (method === 'GET' && u.endsWith('/v1/batches/batch_expired_01')) {
        return makeJsonResponse(200, {
          id: 'batch_expired_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_up_expired',
          output_file_id: 'file_out_expired',
          error_file_id: 'file_err_expired',
          status: 'expired',
          request_counts: { total: 3, completed: 1, failed: 1 },
        });
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_out_expired/content')) {
        return makeJsonResponse(200, `${makeBatchOutputLine('exp-1', 'ok-exp-1')}\n`);
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_err_expired/content')) {
        return makeJsonResponse(200, `${makeBatchErrorLine('exp-2', 'Item failed before expiry', 500)}\n`);
      }
      throw new Error(`Unexpected fetch: ${method} ${u}`);
    };

    const hooks = {
      testLedgerOptions: ledgerOpts,
      openAiClientOptions: { testMode: true, fetchImpl: mockFetch, baseUrl: 'https://api.openai.com' },
    };

    // Part A: Partial success (completed with both output_file_id and error_file_id)
    mode = 'partial';
    const subPartial = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', partialJsonl,
    ], hooks);
    assert.equal(subPartial.code, 0, subPartial.stderr);

    const pollPartial = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath,
      '--batch-id', 'batch_partial_01', '--download-output',
    ], hooks);
    assert.equal(pollPartial.code, 2, 'Partial batch with error_file_id stays fenced for reconciliation');
    const partialOut = JSON.parse(pollPartial.stdout);
    assert.equal(partialOut.parsed_output_count, 2);
    assert.equal(partialOut.parsed_error_count, 1);
    assert.deepEqual(partialOut.reconciliation.items.map(i => i.custom_id), ['cid-1', 'cid-2', 'cid-3']);
    assert.equal(partialOut.reconciliation.by_custom_id['cid-1'].output_text, 'ok-1');
    assert.equal(partialOut.reconciliation.by_custom_id['cid-1'].source_file, 'output_file');
    assert.equal(partialOut.reconciliation.by_custom_id['cid-2'].source_file, 'error_file');
    assert.match(partialOut.reconciliation.by_custom_id['cid-2'].error, /Upstream rate limit/);
    assert.equal(partialOut.reconciliation.by_custom_id['cid-3'].output_text, 'ok-3');
    assert.equal(partialOut.reconciliation.partial_success, true);
    assert.ok(partialOut.reconciliation.known_usage_cost_micros > 0);
    assert.equal(partialOut.reconciliation.has_unknown_usage, true);
    assert.equal(partialOut.fenced, true);
    assert.equal(partialOut.receipt.status, 'pending_recovery');

    // Part B: Expired batch preserves partial output + error line + marks unexecuted exp-3 as expired
    mode = 'expired';
    const subExpired = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', expiredJsonl,
    ], hooks);
    assert.equal(subExpired.code, 0, subExpired.stderr);

    const pollExpired = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath,
      '--batch-id', 'batch_expired_01', '--download-output',
    ], hooks);
    assert.equal(pollExpired.code, 2);
    const expiredOut = JSON.parse(pollExpired.stdout);
    assert.equal(expiredOut.batch_status, 'expired');
    assert.equal(expiredOut.parsed_output_count, 1);
    assert.equal(expiredOut.parsed_error_count, 1);
    assert.deepEqual(expiredOut.reconciliation.missing_custom_ids, ['exp-3']);
    assert.equal(expiredOut.reconciliation.by_custom_id['exp-1'].usable, true);
    assert.equal(expiredOut.reconciliation.by_custom_id['exp-2'].source_file, 'error_file');
    assert.equal(expiredOut.reconciliation.by_custom_id['exp-3'].status, 'expired');
    assert.ok(expiredOut.reconciliation.known_usage_cost_micros > 0);
    assert.equal(expiredOut.reconciliation.has_unknown_usage, true);

    // Part C: Unknown submission disconnect -> second entry performs ZERO duplicate POSTs
    mode = 'ambig';
    const beforeFiles = postCounts.files;
    const beforeBatches = postCounts.batches;
    const ambigFirst = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', ambigJsonl,
    ], hooks);
    assert.equal(ambigFirst.code, 2);
    assert.equal(postCounts.files, beforeFiles + 1);
    assert.equal(postCounts.batches, beforeBatches + 1);

    const ambigSecond = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', ambigJsonl,
    ], hooks);
    assert.equal(ambigSecond.code, 2);
    assert.equal(postCounts.files, beforeFiles + 1, 'Second entry on unknown submission MUST NOT re-POST /v1/files');
    assert.equal(postCounts.batches, beforeBatches + 1, 'Second entry on unknown submission MUST NOT re-POST /v1/batches');
    const ambigSecondPayload = JSON.parse(ambigSecond.stdout);
    assert.equal(ambigSecondPayload.mode, 'pending_recovery_blocked');
    assert.equal(ambigSecondPayload.duplicate_post_prevented, true);
    assert.equal(ambigSecondPayload.input_file_id, 'file_up_ambig');
    assert.equal(ambigSecondPayload.batch_id, null);
    assert.equal(ambigSecondPayload.receipt.status, 'pending_recovery');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Batch A3.2: resume_skip_completed recomputes on new quote, new #8 ruling, or fee-table change while skipping truly unchanged candidates', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const formDef = {
      form_id: 'form-a3-resume-test',
      label: '桌面收纳盒＋可拆托盘',
      buyer_task: 'Desktop organizer with removable tray',
      saleable_set_composition: { components: [{ component_id: 'kit', qty_per_saleable_set: 1 }], set_count: 1 },
    };
    const { form: f1 } = store.upsertCandidateForm(formDef);
    const fx = 7.0;
    const salesWin = { from: '2027-02-01', through: '2027-10-14' };
    const storageWin = { from: '2027-02-01', through: '2027-09-30' };
    const inboundWin = { from: '2027-01-20', through: '2027-02-01' };

    const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
      id: formDef.form_id,
      specSha256: f1.spec_sha256,
      specVersion: f1.spec_version,
    });
    const hhUsd = baseCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd;

    const g1aScens = baseCand.economics.scenarios.map(sc => ({
      id: sc.id,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
      price_usd: sc.cost_ledger.price_usd,
      fx_cny_per_usd: fx,
      refund_fraction: 0.02,
      physical_return_fraction: 0.02,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
      headhaul_usd: hhUsd,
      collection_rate: 0.006,
      sales_window: salesWin,
      storage_window: storageWin,
      inbound_window: inboundWin,
      is_apparel: false,
      is_dangerous_goods: false,
      is_sipp: false,
    }));
    const rawEst = estimateGate1A2027(g1aScens[0]);
    const cachedEst = {
      fulfillment_usd: rawEst.components.fulfillment.total_usd,
      placement_usd: rawEst.components.placement.selected_usd,
      storage_usd: rawEst.components.storage.per_unit_usd,
    };

    const makeQuoteRow = (quoteId, factoryId, unitGoodsCny) => ({
      quote_id: quoteId,
      factory_id: factoryId,
      spec_variant_key: 'kit-std',
      form_id: formDef.form_id,
      spec_version: f1.spec_version,
      observed_at: '2026-11-27',
      expires_at: null,
      redacted_destination: '广东深圳',
      raw_readback_ref: `rb-${quoteId}`,
      ui_readback: VALID_UI_READBACK,
      require_ui_readback: true,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{
        offer_id: `off-${quoteId}`,
        sku_id: 'kit',
        component_id: 'kit',
        qty_per_saleable_set: 1,
        pack_multiple: 1,
        moq_qty: 100,
        ordered_qty: 100,
        unit_price_cny: unitGoodsCny,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: Math.round(unitGoodsCny * 100 * 100) / 100,
      domestic_freight_cny_total: 100,
    });

    const buildAlignedCand = (quoteId, unitGoodsCny) => {
      const cand = structuredClone(baseCand);
      for (const s of cand.economics.scenarios) {
        s.quote_id = quoteId;
        s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
        s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: quoteId, fx_cny_per_usd: fx };
        for (const l of s.cost_ledger.lines) {
          if (l.id === 'procurement') {
            l.fx_cny_per_usd = fx;
            l.order_units = 100;
            l.amount_usd = Number((unitGoodsCny / fx).toFixed(6));
          }
          if (l.id === 'domestic_freight') {
            l.fx_cny_per_usd = fx;
            l.order_units = 100;
            l.amount_usd = Number((1 / fx).toFixed(6));
          }
          if (l.id === 'fulfillment') l.amount_usd = cachedEst.fulfillment_usd;
          if (l.id === 'placement') l.amount_usd = cachedEst.placement_usd;
          if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, cachedEst.storage_usd);
        }
        const r = s.cost_ledger.refund_fraction ?? 0.04;
        const nonCol = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
          .reduce((sum, lid) => sum + (s.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
        const colLine = s.cost_ledger.lines.find(l => l.id === 'collection');
        if (colLine) {
          colLine.amount_usd = Number((Math.max(0, s.cost_ledger.price_usd * (1 - r) - nonCol) * (s.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
        }
      }
      return cand;
    };

    store.recordSourcingQuotesBatch1688([makeQuoteRow('q-a3-1', 'fac-a3-1', 63)]);

    let deepResearchCalls = 0;
    const makeBatchItem = ({ quoteId, unitGoodsCny, peerRulings = null }) => {
      const cand = buildAlignedCand(quoteId, unitGoodsCny);
      return {
        form: formDef,
        leads: [{
          lead_id: 'lead-a3-1',
          source_channel: 'reddit',
          source_ref: 'https://example.com/r/a3',
          phrase_or_title: 'organizer tray',
          observed_at: '2026-11-27',
          disposition: 'product',
        }],
        gate1a_scenarios: g1aScens,
        ...(peerRulings ? { peer_comparability_rulings: peerRulings } : {}),
        early_screen_builder: ({ quote }) => {
          const unitCny = Number(quote.goods_cny_total) / Number(quote.actual_complete_sets);
          return g1aScens.map(g => ({
            profile_revision: 59,
            id: g.id,
            saleable_unit: '1 complete set',
            price_usd: g.price_usd,
            fx_cny_per_usd: fx,
            order_units: 100,
            goods_cny_per_unit: unitCny,
            domestic_freight_cny_per_unit: 1,
            first_order_promotion: false,
            goods_first_order_promotion: false,
            headhaul: { usd_per_unit: hhUsd, bond_included: true },
            refund_fraction: 0.02,
            physical_return_fraction: 0.02,
            return_threshold: 0.08,
            returns_processing_usd: 0,
            is_apparel_or_shoes: false,
            referral_terms: g.referral_terms,
            fulfillment_usd: cachedEst.fulfillment_usd,
            placement_usd: cachedEst.placement_usd,
            storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWin, storage: storageWin, inbound: inboundWin },
            collection_rate: 0.006,
            other_applicable_usd: 0,
            specific_rights_conflict: 'unknown',
            strong_date_dependency: false,
          }));
        },
        deep_research_executor: async () => {
          deepResearchCalls += 1;
          return {
            batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(cand)] },
          };
        },
      };
    };

    // 1. Initial evaluation with q-a3-1 (¥63/set)
    const run1 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-1', unitGoodsCny: 63 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 1);
    assert.equal(run1.gate2_3[0].status, 'evaluated');
    assert.equal(run1.gate2_3[0].qualification.counts_toward_target, true);
    const shaRun1 = run1.gate2_3[0].result_sha256;

    // 2. Truly unchanged inputs -> MUST skip cleanly with 0 extra deep_research calls!
    const run2 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-1', unitGoodsCny: 63 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 1, 'Truly unchanged candidate must reuse completed evaluation without extra calls');
    assert.equal(run2.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run2.gate2_3[0].result_sha256, shaRun1);

    // 3. Same form/spec + NEW cheaper 1688 quote q-a3-2 (¥42/set) -> MUST recompute!
    store.recordSourcingQuotesBatch1688([makeQuoteRow('q-a3-2', 'fac-a3-2', 42)]);
    const run3 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-2', unitGoodsCny: 42 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 2, 'New cheaper quote on same form/spec must invalidate stale reuse and recompute');
    assert.equal(run3.gate2_3[0].status, 'evaluated', JSON.stringify(run3.gate2_3[0]));
    assert.notEqual(run3.gate2_3[0].reused_completed_evaluation, true);
    assert.notEqual(run3.gate2_3[0].result_sha256, shaRun1);
    const shaRun3 = run3.gate2_3[0].result_sha256;

    // 4. Unchanged rerun after q-a3-2 -> skips cleanly and returns newer evaluation!
    const run4 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-2', unitGoodsCny: 42 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 2);
    assert.equal(run4.gate2_3[0].status, 'evaluated');
    assert.equal(run4.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run4.gate2_3[0].result_sha256, shaRun3);

    // 5. Same form/spec + NEW #8 peer_comparability_rulings -> MUST recompute & revoke qualification!
    const run5 = await runPhase2Batch(store, {
      items: [makeBatchItem({
        quoteId: 'q-a3-2',
        unitGoodsCny: 42,
        peerRulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '高价款同箱清单待核' },
        ],
      })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 3, 'New #8 comparability ruling must invalidate stale reuse and recompute');
    assert.equal(run5.gate2_3[0].status, 'evaluated', JSON.stringify(run5.gate2_3[0]));
    assert.notEqual(run5.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run5.gate2_3[0].qualification.counts_toward_target, false);

    // 6. Same form/spec + modified fee_table_snapshot -> MUST recompute!
    const modifiedFeeSnap = structuredClone(getFba2027RateTableSnapshot({ profileRevision: 59 }));
    modifiedFeeSnap.metadata = { ...(modifiedFeeSnap.metadata ?? {}), version: 'US-FBA-2027-mutated-test' };
    const run6 = await runPhase2Batch(store, {
      items: [makeBatchItem({
        quoteId: 'q-a3-2',
        unitGoodsCny: 42,
        peerRulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '高价款同箱清单待核' },
        ],
      })],
      profile: r59Profile,
      fee_table_snapshot: modifiedFeeSnap,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 4, 'Changed fee_table_snapshot must invalidate stale reuse and recompute');
    assert.equal(run6.gate2_3[0].status, 'evaluated', JSON.stringify(run6.gate2_3[0]));
    assert.notEqual(run6.gate2_3[0].reused_completed_evaluation, true);

    // 7. Static scored_batch path (as used by daily-batch): unchanged skips, while changing candidate-level #8 ruling recomputes!
    const staticItemUnchanged = {
      ...makeBatchItem({
        quoteId: 'q-a3-2',
        unitGoodsCny: 42,
        peerRulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '高价款同箱清单待核' },
        ],
      }),
      scored_batch: { schema_version: 1, profile_revision: 59, candidates: [buildAlignedCand('q-a3-2', 42)] },
    };
    const run7 = await runPhase2Batch(store, {
      items: [staticItemUnchanged],
      profile: r59Profile,
      fee_table_snapshot: modifiedFeeSnap,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 4, 'Unchanged static scored_batch must skip cleanly');
    assert.equal(run7.gate2_3[0].reused_completed_evaluation, true);

    const staticCandWithConfirmedHigh = buildAlignedCand('q-a3-2', 42);
    staticCandWithConfirmedHigh.peer_comparability_rulings = [
      { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘', spec_sha256: f1.spec_sha256, spec_version: f1.spec_version },
      { peer_asin: 'B0SYN8HIG2', status: 'confirmed_comparable', source: 'owner_audit', reason: '高价款已补齐清单确认可比', spec_sha256: f1.spec_sha256, spec_version: f1.spec_version },
    ];
    const staticItemUpdatedRuling = {
      ...makeBatchItem({ quoteId: 'q-a3-2', unitGoodsCny: 42 }),
      scored_batch: { schema_version: 1, profile_revision: 59, candidates: [staticCandWithConfirmedHigh] },
      deep_research_executor: async () => {
        deepResearchCalls += 1;
        return { batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(staticCandWithConfirmedHigh)] } };
      },
    };
    const run8 = await runPhase2Batch(store, {
      items: [staticItemUpdatedRuling],
      profile: r59Profile,
      fee_table_snapshot: modifiedFeeSnap,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 5, 'Candidate-level #8 ruling change in scored_batch must recompute');
    assert.equal(run8.gate2_3[0].status, 'evaluated');
    assert.notEqual(run8.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run8.gate2_3[0].qualification.counts_toward_target, true);
  } finally {
    store.close();
  }
});

test('Batch A3.3: budget-ledger unreachable devStr/inoStr dead branch is removed while preserving legacy pinning and core guardrails', async () => {
  const ledgerSrc = readFileSync(new URL('../src/openai/budget-ledger.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(ledgerSrc, /devStr:\s*null,\s*inoStr:\s*null/, 'Unreachable devStr/inoStr = null dead branch must be removed');
  assert.doesNotMatch(ledgerSrc, /changed physical device\/inode/, 'Unreachable sameInode dead branch must be removed');

  const dir = mkdtempSync(join(tmpdir(), 'batch-a3-ledger-'));
  try {
    // Build minimal authentic legacy SQLite file to verify canonical-path collision & switch guards stay intact
    const legacyPath = join(dir, 'legacy-budget.sqlite3');
    const legacyAltPath = join(dir, 'legacy-alt.sqlite3');
    for (const lp of [legacyPath, legacyAltPath]) {
      const db = new DatabaseSync(lp);
      db.exec(`
        CREATE TABLE reservations (
          request_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          reserved_cents INTEGER NOT NULL,
          confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);
      db.close();
    }

    const ledgerPath = join(dir, 'selection.sqlite');
    const ledger = openOpenAiBudgetLedger(ledgerPath, { testMode: true });
    try {
      const summary = inspectLegacyAutopilotBudget(legacyPath, { monthUtc: new Date().toISOString().slice(0, 7) });
      ledger.reconcileLegacySummary(summary, {
        accountScope: 'openai-default',
        enable: true,
        monthlyLimitCents: 20_000,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });

      // Switching legacy source without explicit allowLegacySourceSwitch + note must still fail!
      const altSummary = inspectLegacyAutopilotBudget(legacyAltPath, { monthUtc: new Date().toISOString().slice(0, 7) });
      assert.throws(
        () => ledger.reconcileLegacySummary(altSummary, { accountScope: 'openai-default' }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_MISMATCH',
      );

      // Core guardrails intact: Astra paid API blocked & $200 monthly limit enforced
      const client = new OpenAiClient({
        ledger,
        testMode: true,
        allowEnvKey: true,
        apiKeyEnvVar: 'BATCH_A3_KEY',
        env: { BATCH_A3_KEY: SYNTHETIC_API_KEY },
        fetchImpl: async () => makeJsonResponse(200, {}),
      });
      await assert.rejects(
        () => client.createResponse({ model: 'gpt-6.2-astra', input: 'blocked' }),
        err => err instanceof OpenAiPolicyError && err.code === 'ASTRA_API_BLOCKED',
      );
    } finally {
      ledger.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});
