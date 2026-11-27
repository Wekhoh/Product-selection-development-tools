import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { runPhase2Batch, runGate1AForForm, runGate1BForForm } from '../src/pipeline.mjs';
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

test('Batch A3.3: budget-ledger preserves legacy path pinning, historical dev/ino DB compatibility, and core guardrails', async () => {
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
      const monthUtc = new Date().toISOString().slice(0, 7);
      const summary = inspectLegacyAutopilotBudget(legacyPath, { monthUtc });
      ledger.reconcileLegacySummary(summary, {
        accountScope: 'openai-default',
        enable: true,
        monthlyLimitCents: 20_000,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });

      // Historical DB rows carrying non-null legacy_source_dev / legacy_source_ino remain fully readable and pinned.
      ledger.db.prepare(
        "UPDATE openai_budget_policy SET legacy_source_dev = '12345', legacy_source_ino = '67890' WHERE account_scope = 'openai-default'",
      ).run();
      const reopened = openOpenAiBudgetLedger(ledgerPath, { testMode: true });
      try {
        await new Promise(r => setTimeout(r, 15));
        const freshSummary = inspectLegacyAutopilotBudget(legacyPath, { monthUtc });
        reopened.reconcileLegacySummary(freshSummary, { accountScope: 'openai-default' });
        const pol = reopened.getPolicy('openai-default');
        assert.equal(pol.monthly_limit_cents, 20_000);
        assert.equal(pol.legacy_reconciled, true);

        // Switching legacy source without explicit allowLegacySourceSwitch + note must still fail!
        const altSummary = inspectLegacyAutopilotBudget(legacyAltPath, { monthUtc });
        assert.throws(
          () => reopened.reconcileLegacySummary(altSummary, { accountScope: 'openai-default' }),
          err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_MISMATCH',
        );
      } finally {
        reopened.close();
      }

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

test('Batch A3.4: Round 1 Batch CLI/Client regressions (#1-#5, #10-#12)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-a3-r1-cli-'));
  try {
    // Helper to build a minimal valid JSONL line directly
    const mkLine = (cid, text) => JSON.stringify({
      custom_id: cid,
      method: 'POST',
      url: '/v1/responses',
      body: { model: 'gpt-6.1-terra', input: text, max_output_tokens: 4096 },
    });

    // --- #2: Outgoing raw email blocked BEFORE /v1/files, and polled response email redacted ---
    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'pii.sqlite');
      const emailJsonl = join(dir, 'email-in.jsonl');
      writeFileSync(emailJsonl, `${mkLine('pii-1', 'Contact vendor at alice.vendor@example-supplier.com for quote')}\n`);
      let netCalls = 0;
      const hooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async () => { netCalls += 1; return makeJsonResponse(200, {}); },
        },
      };
      const blockedRes = await runCliMem([
        'openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath,
        '--submit-jsonl', emailJsonl,
      ], hooks);
      assert.notEqual(blockedRes.code, 0, 'Outgoing raw email must be blocked');
      assert.equal(netCalls, 0, 'Outgoing raw email must fail before any network POST');

      // Polled output containing an email must be redacted to [REDACTED_EMAIL]
      const cleanJsonl = join(dir, 'pii-clean.jsonl');
      writeFileSync(cleanJsonl, `${mkLine('pii-out-1', 'Summarize wooden desktop rack specs')}\n`);
      const outLineWithEmail = makeBatchOutputLine('pii-out-1', 'Supplier contact: bob.factory@example-mail.org');
      const hooksOut = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_pii_1' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_pii_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_pii_1' });
            if (m === 'GET' && url.includes('/v1/batches/batch_pii_1')) {
              return makeJsonResponse(200, { id: 'batch_pii_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_pii_1', output_file_id: 'file_pii_out', request_counts: { total: 1, completed: 1, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_pii_out/content')) return makeJsonResponse(200, `${outLineWithEmail}\n`);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const subPii = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', cleanJsonl], hooksOut);
      assert.equal(subPii.code, 0, subPii.stderr);
      const pollPii = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_pii_1', '--download-output'], hooksOut);
      assert.equal(pollPii.code, 0, pollPii.stderr);
      assert.equal(pollPii.stdout.includes('bob.factory@example-mail.org'), false, 'Polled output must redact raw email');
      assert.match(pollPii.stdout, /\[REDACTED_EMAIL\]/);
    }

    // --- #10 + #4: Swapped JSONL line order keeps same logicalId (0 dup POST) + disconnect recovery binds --batch-id ---
    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'order-rec.sqlite');
      const jA = join(dir, 'order-a.jsonl');
      const jB = join(dir, 'order-b.jsonl');
      writeFileSync(jA, `${mkLine('cid-1', 'Item one')}\n${mkLine('cid-2', 'Item two')}\n`);
      writeFileSync(jB, `${mkLine('cid-2', 'Item two')}\n${mkLine('cid-1', 'Item one')}\n`);
      let batchPostCount = 0;
      const outBoth = `${makeBatchOutputLine('cid-1', '{"ok":1}')}\n${makeBatchOutputLine('cid-2', '{"ok":2}')}\n`;
      const hooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_rec_1' });
            if (m === 'POST' && url.endsWith('/v1/batches')) {
              batchPostCount += 1;
              throw new Error('ECONNRESET after batch creation');
            }
            if (m === 'GET' && url.includes('/v1/batches/batch_wrong_file')) {
              return makeJsonResponse(200, { id: 'batch_wrong_file', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_other_999', output_file_id: 'file_out_rec', request_counts: { total: 2, completed: 2, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/batches/batch_rec_1')) {
              return makeJsonResponse(200, { id: 'batch_rec_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_rec_1', output_file_id: 'file_out_rec', request_counts: { total: 2, completed: 2, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_out_rec/content')) return makeJsonResponse(200, outBoth);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const firstFail = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jA], hooks);
      assert.notEqual(firstFail.code, 0);
      assert.equal(batchPostCount, 1);

      // Re-submitting with SWAPPED line order MUST hit existing pending_recovery fence -> 0 duplicate POST!
      const secondSwapped = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jB], hooks);
      assert.notEqual(secondSwapped.code, 0);
      assert.equal(batchPostCount, 1, 'Swapping JSONL line order must not trigger duplicate POST /v1/batches');
      const swappedJson = JSON.parse(secondSwapped.stdout);
      const origAttemptId = swappedJson.attempt_id;
      assert.equal(swappedJson.duplicate_post_prevented, true);

      // Mismatched input_file_id with --attempt must be rejected (BATCH_MANIFEST_MISMATCH)
      const wrongBind = await runCliMem([
        'openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath,
        '--batch-id', 'batch_wrong_file', '--attempt', origAttemptId, '--download-output',
      ], hooks);
      assert.notEqual(wrongBind.code, 0, 'Mismatched input_file_id must refuse to bind onto pending_recovery attempt');

      // Polling with ONLY --batch-id (auto-matched by manifest endpoint + uploaded_file_id) binds & settles original attempt!
      const recPoll = await runCliMem([
        'openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath,
        '--batch-id', 'batch_rec_1', '--download-output',
      ], hooks);
      assert.equal(recPoll.code, 0, recPoll.stderr);
      const recJson = JSON.parse(recPoll.stdout);
      assert.equal(recJson.attempt_id, origAttemptId);
      assert.equal(recJson.receipt.status, 'completed');
      assert.ok(recJson.receipt.usage_cost_micros > 0);
      const ledgerCheck = openOpenAiBudgetLedger(dbPath, ledgerOpts);
      try {
        const row = ledgerCheck.getAttemptById(origAttemptId);
        assert.equal(row.provider_response_id, 'batch_rec_1');
        assert.equal(row.status, 'completed');
        assert.ok(row.usage_cost_micros > 0);
      } finally {
        ledgerCheck.close();
      }
    }

    // --- #11: Pre-batch 403 upload rejection allows fresh re-submit once 403 clears ---
    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'retry403.sqlite');
      const jPath = join(dir, 'retry403.jsonl');
      writeFileSync(jPath, `${mkLine('r403-1', 'Retry after 403 test')}\n`);
      let allowUpload = false;
      let batchPosts = 0;
      const hooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) {
              if (!allowUpload) return makeJsonResponse(403, { error: { message: 'Forbidden upload' } });
              return makeJsonResponse(200, { id: 'file_403_ok' });
            }
            if (m === 'POST' && url.endsWith('/v1/batches')) {
              batchPosts += 1;
              return makeJsonResponse(200, { id: 'batch_403_ok', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_403_ok' });
            }
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const rejectedRun = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jPath], hooks);
      assert.notEqual(rejectedRun.code, 0);
      assert.equal(batchPosts, 0);

      allowUpload = true;
      const retriedRun = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jPath], hooks);
      assert.equal(retriedRun.code, 0, retriedRun.stderr);
      assert.equal(batchPosts, 1);
      assert.equal(JSON.parse(retriedRun.stdout).batch_id, 'batch_403_ok');
    }

    // --- #1 + #3 + #5 + #12: duplicate_conflict spend, corrupt error_file partial delivery, known-cost error_file settle+redownload, refusals & batch_errors ---
    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'reconcile-edges.sqlite');

      // (#1) Duplicate custom_id across output_file + error_file must NOT double-count known_usage_cost_micros!
      const dupJsonl = join(dir, 'dup.jsonl');
      writeFileSync(dupJsonl, `${mkLine('dup-1', 'Single item duplicated')}\n`);
      const dupOutLine = makeBatchOutputLine('dup-1', '{"ok":true}', { inputTokens: 1000, outputTokens: 200 });
      const dupErrLine = JSON.stringify({
        id: 'br_dup_err',
        custom_id: 'dup-1',
        response: {
          status_code: 500,
          body: { status: 'failed', model: 'gpt-6.1-terra', error: { message: 'Internal error' }, usage: { input_tokens: 1000, output_tokens: 200 } },
        },
        error: null,
      });
      const dupHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_dup_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_dup_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_dup_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_dup_1')) {
              return makeJsonResponse(200, { id: 'batch_dup_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_dup_in', output_file_id: 'file_dup_out', error_file_id: 'file_dup_err', request_counts: { total: 1, completed: 1, failed: 1 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_dup_out/content')) return makeJsonResponse(200, `${dupOutLine}\n`);
            if (m === 'GET' && url.includes('/v1/files/file_dup_err/content')) return makeJsonResponse(200, `${dupErrLine}\n`);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const dupSub = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', dupJsonl], dupHooks);
      assert.equal(dupSub.code, 0, dupSub.stderr);
      const dupAttemptId = JSON.parse(dupSub.stdout).attempt_id;
      const dupPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_dup_1', '--download-output'], dupHooks);
      const dupPollJson = JSON.parse(dupPoll.stdout);
      assert.deepEqual(dupPollJson.reconciliation.duplicate_custom_ids, ['dup-1']);
      assert.equal(dupPollJson.known_usage_cost_micros, 0, 'Conflicted duplicate item must not inflate known_usage_cost_micros');
      assert.equal(dupPollJson.has_unknown_usage, true);
      // Reconciling at true single-response cost (1750 micros) succeeds without USAGE_REDUCTION_FORBIDDEN!
      const dupLedger = openOpenAiBudgetLedger(dbPath, ledgerOpts);
      try {
        const settled = dupLedger.reconcileAttempt(dupAttemptId, {
          accountScope: 'openai-default',
          status: 'completed',
          usageCostMicros: 1750,
          note: 'Verified single charge for duplicate custom_id',
        });
        assert.equal(settled.status, 'completed');
        assert.equal(settled.usage_cost_micros, 1750);
      } finally {
        dupLedger.close();
      }

      // (#3) Corrupt error_file_id still delivers valid output_file_id results + provisional_usage_cost_micros
      const corruptJsonl = join(dir, 'corrupt.jsonl');
      writeFileSync(corruptJsonl, `${mkLine('cor-ok', 'Item A')}\n${mkLine('cor-bad', 'Item B')}\n`);
      const corHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_cor_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_cor_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_cor_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_cor_1')) {
              return makeJsonResponse(200, { id: 'batch_cor_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_cor_in', output_file_id: 'file_cor_out', error_file_id: 'file_cor_err', request_counts: { total: 2, completed: 1, failed: 1 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_cor_out/content')) return makeJsonResponse(200, `${makeBatchOutputLine('cor-ok', '{"delivered":true}')}\n`);
            if (m === 'GET' && url.includes('/v1/files/file_cor_err/content')) return makeJsonResponse(200, 'NOT_VALID_JSON\n');
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const corSub = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', corruptJsonl], corHooks);
      assert.equal(corSub.code, 0, corSub.stderr);
      const corPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_cor_1', '--download-output'], corHooks);
      const corJson = JSON.parse(corPoll.stdout);
      assert.equal(corJson.parsed_output_count, 1, 'Valid output_file item must still be delivered');
      assert.ok(corJson.error_file_error, 'error_file_error must be surfaced');
      assert.equal(corJson.has_unknown_usage, true);
      assert.ok(corJson.known_usage_cost_micros > 0);
      assert.ok(corJson.receipt.provisional_usage_cost_micros > 0);

      // (#5) Completed batch with terminal-usage error_file settles completed AND allows re-download cleanly!
      const knownErrJsonl = join(dir, 'known-err.jsonl');
      writeFileSync(knownErrJsonl, `${mkLine('ke-ok', 'Good item')}\n${mkLine('ke-err', 'Known-usage error item')}\n`);
      const keErrLine = JSON.stringify({
        id: 'br_ke_err',
        custom_id: 'ke-err',
        response: {
          status_code: 500,
          body: { status: 'failed', model: 'gpt-6.1-terra', error: { message: 'Server fault' }, usage: { input_tokens: 100, output_tokens: 10 } },
        },
        error: null,
      });
      const keHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_ke_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_ke_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_ke_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_ke_1')) {
              return makeJsonResponse(200, { id: 'batch_ke_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_ke_in', output_file_id: 'file_ke_out', error_file_id: 'file_ke_err', request_counts: { total: 2, completed: 1, failed: 1 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_ke_out/content')) return makeJsonResponse(200, `${makeBatchOutputLine('ke-ok', '{"ok":1}')}\n`);
            if (m === 'GET' && url.includes('/v1/files/file_ke_err/content')) return makeJsonResponse(200, `${keErrLine}\n`);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const keSub = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', knownErrJsonl], keHooks);
      assert.equal(keSub.code, 0, keSub.stderr);
      const kePoll1 = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_ke_1', '--download-output'], keHooks);
      assert.equal(kePoll1.code, 0, kePoll1.stderr);
      const keJson1 = JSON.parse(kePoll1.stdout);
      assert.equal(keJson1.receipt.status, 'completed', 'Fully known-cost batch with terminal error_file must settle');
      assert.equal(keJson1.has_unknown_usage, false);
      const kePoll2 = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_ke_1', '--download-output'], keHooks);
      assert.equal(kePoll2.code, 0, 'Re-downloading settled batch with error_file_id must succeed without digest mismatch');
      assert.equal(JSON.parse(kePoll2.stdout).already_settled, true);

      // (#12) Refused item counted in failed_count + partial_success, and batch-level errors.data surfaced
      const refJsonl = join(dir, 'refusal.jsonl');
      writeFileSync(refJsonl, `${mkLine('ref-ok', 'Normal item')}\n${mkLine('ref-no', 'Refused item')}\n`);
      const refusalLine = JSON.stringify({
        id: 'br_ref_no',
        custom_id: 'ref-no',
        response: {
          status_code: 200,
          body: {
            id: 'resp_ref_no',
            status: 'completed',
            model: 'gpt-6.1-terra',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }],
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
        error: null,
      });
      const refHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_ref_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_ref_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_ref_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_ref_1')) {
              return makeJsonResponse(200, { id: 'batch_ref_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_ref_in', output_file_id: 'file_ref_out', request_counts: { total: 2, completed: 2, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_ref_out/content')) {
              return makeJsonResponse(200, `${makeBatchOutputLine('ref-ok', '{"ok":true}')}\n${refusalLine}\n`);
            }
            if (m === 'GET' && url.includes('/v1/batches/batch_errdata_1')) {
              return makeJsonResponse(200, {
                id: 'batch_errdata_1',
                status: 'failed',
                endpoint: '/v1/responses',
                input_file_id: 'file_errdata_in',
                errors: { data: [{ code: 'invalid_json_line', message: 'Line 1 invalid schema' }] },
              });
            }
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', refJsonl], refHooks);
      const refPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_ref_1', '--download-output'], refHooks);
      const refJson = JSON.parse(refPoll.stdout);
      assert.equal(refJson.reconciliation.succeeded_count, 1);
      assert.equal(refJson.reconciliation.failed_count, 1, 'Refusal must be counted in failed_count');
      assert.equal(refJson.reconciliation.partial_success, true, 'Refusal must set partial_success=true');

      const errDataPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_errdata_1', '--download-output'], refHooks);
      const errDataJson = JSON.parse(errDataPoll.stdout);
      assert.equal(errDataJson.batch_errors[0].code, 'invalid_json_line');
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Batch A3.5: Round 1 Pipeline/CLI resume, Keepa precomputed, single-product export, quote conflict & Gate 1B landed basis (#6-#9, #13-#15, #129)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-a3-r1-pipe-'));
  try {
    // --- #9: Precomputed Keepa rejects bare legacy boolean & preserves dated-verified $49.99 ---
    {
      const stKeepa = openSelectionStore(':memory:');
      try {
        const baseForm = {
          form_id: 'form-a3-keepa',
          label: 'Adult Desktop Tray',
          buyer_task: 'Hold studio tools',
          saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }],
        };
        stKeepa.upsertCandidateForm(baseForm);
        const scen52 = {
          id: 'sc-52',
          asin: 'B0LEGACY52',
          price_usd: 52.00,
          pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 },
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          headhaul_usd: 1.8,
          collection_rate: 0.006,
        };
        // Bare legacy keepa_steady_verified without dated facts/timestamps MUST be held for verification!
        const barePrecomputed = {
          options: { as_of_date: '2026-11-24', strict_mature_only: true },
          strict_mature_only: true,
          mainstream_count: 1,
          mainstream_pool: [{
            asin: 'B0LEGACY52',
            net_price_usd: 52.00,
            list_price_usd: 52.00,
            fulfillment: 'FBA',
            monthly_units: 80,
            age_days: 420,
            keepa_steady_verified: true,
          }],
          mature_regular_band: { min_usd: 52, max_usd: 52, peer_count: 1 },
          spiral_watch: [],
          observed_out_of_band_peers: [],
        };
        const g1aBare = runGate1AForForm(stKeepa, {
          form_id: baseForm.form_id,
          profile_revision: 59,
          price_band_analysis: barePrecomputed,
          scenarios: [scen52],
        });
        assert.equal(g1aBare.gate_status, 'gate1a_needs_verification', 'Bare legacy keepa_steady_verified without dates must not pass');

        // Dated-verified $49.99 row paired with an unverified peer MUST preserve $49.99 band (never null)!
        const datedPrecomputed = {
          options: { as_of_date: '2026-11-24', strict_mature_only: true },
          strict_mature_only: true,
          mainstream_count: 2,
          mainstream_pool: [
            {
              asin: 'B0DATED49',
              net_price_usd: 49.99,
              list_price_usd: 49.99,
              fulfillment: 'FBA',
              monthly_units: 95,
              age_days: 430,
              keepa_dated_90d_verified: true,
              keepa_steady_provenance: 'dated_90d_keepa',
              keepa_steady_reference: { price_usd: 49.99, source: 'keepa_90d_median_usd' },
            },
            {
              asin: 'B0UNVER55',
              net_price_usd: 55.00,
              list_price_usd: 55.00,
              fulfillment: 'FBA',
              monthly_units: 70,
              age_days: 410,
            },
          ],
          mature_regular_band: { min_usd: 49.99, max_usd: 55.00, peer_count: 2 },
          spiral_watch: [],
          observed_out_of_band_peers: [],
        };
        const g1aDated = runGate1AForForm(stKeepa, {
          form_id: baseForm.form_id,
          profile_revision: 59,
          price_band_analysis: datedPrecomputed,
          scenarios: [{ ...scen52, id: 'sc-49', asin: 'B0DATED49', price_usd: 49.99 }],
        });
        assert.equal(g1aDated.gate_status, 'gate1a_passed', 'Dated-verified $49.99 peer must survive filtering out unverified peer');
        assert.equal(g1aDated.regular_band_reference.min_usd, 49.99);
        assert.equal(g1aDated.regular_band_reference.max_usd, 49.99);
      } finally {
        stKeepa.close();
      }
    }

    // --- #129: Persisted landed-domestic quote explicitly passes bare_goods_screening:false + cost_basis:'landed_domestic_explicit' ---
    {
      const stLanded = openSelectionStore(':memory:');
      try {
        const fDef = {
          form_id: 'form-a3-landed',
          label: 'Steel Storage Rack',
          buyer_task: 'Hold pantry jars',
          saleable_set_composition: [{ component_id: 'rack', qty_per_saleable_set: 1 }],
        };
        const { form: fRow } = stLanded.upsertCandidateForm(fDef);
        const g1a = runGate1AForForm(stLanded, {
          form_id: fDef.form_id,
          profile_revision: 59,
          scenarios: [{
            id: 'sc-landed',
            price_usd: 45.00,
            pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 },
            fx_cny_per_usd: 7.2,
            refund_fraction: 0.04,
            fee_category: 'Home and Kitchen',
            referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            headhaul_usd: 1.8,
            collection_rate: 0.006,
          }],
        });
        stLanded.recordSourcingQuotesBatch1688([{
          quote_id: 'q-landed-explicit',
          factory_id: 'fac-landed-1',
          form_id: fDef.form_id,
          spec_version: fRow.spec_version,
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'rb-landed',
          ui_readback: VALID_UI_READBACK,
          require_ui_readback: true,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'o-l1', sku_id: 's1', component_id: 'rack', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
          goods_cny_total: 10000,
          domestic_freight_cny_total: 500,
        }]);
        const d = g1a.declared_scenarios[0];
        const g1b = await runGate1BForForm(stLanded, {
          form_id: fDef.form_id,
          profile_revision: 59,
          as_of_date: '2026-11-27',
          early_screen_builder: () => [{
            profile_revision: 59,
            id: d.id,
            saleable_unit: '1 rack',
            price_usd: d.price_usd,
            fx_cny_per_usd: d.fx_cny_per_usd,
            order_units: 100,
            goods_cny_per_unit: 100,
            domestic_freight_cny_per_unit: 5,
            headhaul: { usd_per_unit: 1.8, bond_included: true },
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            return_threshold: 0.08,
            returns_processing_usd: 0,
            is_apparel_or_shoes: false,
            referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            fulfillment_usd: d.fulfillment_usd,
            placement_usd: d.placement_range_usd[1],
            storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: { from: '2027-02-01', through: '2027-09-30' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-01-25' } },
            collection_rate: 0.006,
            other_applicable_usd: 0,
          }],
        });
        const es = Array.isArray(g1b.early_screen) ? g1b.early_screen[0] : g1b.early_screen;
        assert.equal(es.cost_basis, 'landed_domestic_explicit');
        assert.ok(es.metrics.domestic_freight_usd > 0, 'Persisted landed-domestic quote must include domestic freight in Gate 1B margin');
      } finally {
        stLanded.close();
      }
    }

    // --- #6, #7, #8, #14, #15 on runPhase2Batch + #8/#13 on single-product CLI ---
    {
      const store = openSelectionStore(':memory:');
      try {
        const salesWin = { from: '2027-02-01', through: '2027-10-14' };
        const storageWin = { from: '2027-02-01', through: '2027-09-30' };
        const inboundWin = { from: '2027-01-20', through: '2027-02-01' };
        const formDef = {
          form_id: 'form-a3-r1',
          label: 'Bamboo Organizer Tray R1',
          buyer_task: 'Organize desk items',
          saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
        };
        const { form: fRow } = store.upsertCandidateForm(formDef);
        const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
          id: formDef.form_id,
          specSha256: fRow.spec_sha256,
          specVersion: fRow.spec_version,
        });
        const fx = 7.0;
        const hhUsd = baseCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul')?.amount_usd ?? 2.0;
        const g1aScens = baseCand.economics.scenarios.map(s => ({
          id: s.id,
          price_usd: s.cost_ledger.price_usd,
          pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
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
        const mkQuote = (qid, fid, unitCny, targetFormId = formDef.form_id, specVer = fRow.spec_version) => ({
          quote_id: qid,
          factory_id: fid,
          spec_variant_key: 'kit-std',
          form_id: targetFormId,
          spec_version: specVer,
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: `rb-${qid}`,
          ui_readback: VALID_UI_READBACK,
          require_ui_readback: true,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: `o-${qid}`, sku_id: 'kit', component_id: 'kit', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: unitCny, regular_goods_promo_false: true }],
          goods_cny_total: Math.round(unitCny * 100 * 100) / 100,
          domestic_freight_cny_total: 100,
        });
        const mkCand = (qid, unitCny, candId = formDef.form_id, specSha = fRow.spec_sha256, specVer = fRow.spec_version) => {
          const c = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { id: candId, specSha256: specSha, specVersion: specVer });
          for (const s of c.economics.scenarios) {
            s.quote_id = qid;
            s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
            s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: qid, fx_cny_per_usd: fx };
            for (const l of s.cost_ledger.lines) {
              if (l.id === 'procurement') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((unitCny / fx).toFixed(6)); }
              if (l.id === 'domestic_freight') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((1 / fx).toFixed(6)); }
              if (l.id === 'fulfillment') l.amount_usd = cachedEst.fulfillment_usd;
              if (l.id === 'placement') l.amount_usd = cachedEst.placement_usd;
              if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, cachedEst.storage_usd);
            }
            const r = s.cost_ledger.refund_fraction ?? 0.04;
            const nonCol = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
              .reduce((sum, lid) => sum + (s.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
            const colLine = s.cost_ledger.lines.find(l => l.id === 'collection');
            if (colLine) colLine.amount_usd = Number((Math.max(0, s.cost_ledger.price_usd * (1 - r) - nonCol) * (s.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
          }
          return c;
        };
        store.recordSourcingQuotesBatch1688([mkQuote('q-r1-1', 'fac-r1-1', 63)]);

        let calls = 0;
        const mkItem = ({
          qid = 'q-r1-1',
          unitCny = 63,
          leadDisp = 'product',
          note = null,
          peerRulings = null,
          embeddedRulings = null,
          staticResearchOut = null,
          rightsInput = null,
          fDef = formDef,
          specSha = fRow.spec_sha256,
          specVer = fRow.spec_version,
        } = {}) => {
          const cand = mkCand(qid, unitCny, fDef.form_id, specSha, specVer);
          if (embeddedRulings) cand.peer_comparability_rulings = embeddedRulings;
          return {
            form: fDef,
            leads: [{
              lead_id: `lead-${fDef.form_id}`,
              source_channel: 'reddit',
              source_ref: `https://example.com/r/${fDef.form_id}`,
              phrase_or_title: 'organizer tray',
              observed_at: '2026-11-27',
              disposition: leadDisp,
            }],
            gate1a_scenarios: note ? g1aScens.map(g => ({ ...g, notes: note })) : g1aScens,
            ...(peerRulings ? { peer_comparability_rulings: peerRulings } : {}),
            ...(rightsInput ? { rights_prescreen_input: rightsInput } : {}),
            ...(staticResearchOut ? { research_out: staticResearchOut } : {}),
            early_screen_builder: ({ quote }) => {
              const uc = Number(quote.goods_cny_total) / Number(quote.actual_complete_sets);
              return g1aScens.map(g => ({
                profile_revision: 59, id: g.id, saleable_unit: '1 set', price_usd: g.price_usd, fx_cny_per_usd: fx, order_units: 100,
                goods_cny_per_unit: uc, domestic_freight_cny_per_unit: 1, first_order_promotion: false, goods_first_order_promotion: false,
                headhaul: { usd_per_unit: hhUsd, bond_included: true }, refund_fraction: 0.02, physical_return_fraction: 0.02,
                return_threshold: 0.08, returns_processing_usd: 0, is_apparel_or_shoes: false, referral_terms: g.referral_terms,
                fulfillment_usd: cachedEst.fulfillment_usd, placement_usd: cachedEst.placement_usd,
                storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
                operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
                fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWin, storage: storageWin, inbound: inboundWin },
                collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
              }));
            },
            deep_research_executor: async () => {
              calls += 1;
              return staticResearchOut ? structuredClone(staticResearchOut) : {
                batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(cand)] },
              };
            },
          };
        };

        // (#14) Cosmetic Gate 1A note change + dynamic embedded rulings must NOT cause infinite recompute!
        const embeddedR = [{ peer_asin: 'B0SYN8LOW1', status: 'confirmed_comparable', source: 'owner_audit', reason: 'Embedded comparable', spec_sha256: fRow.spec_sha256, spec_version: fRow.spec_version }];
        const r1 = await runPhase2Batch(store, { items: [mkItem({ embeddedRulings: embeddedR })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(calls, 1);
        assert.equal(r1.gate2_3[0].qualification.counts_toward_target, true);
        const r1Cosmetic = await runPhase2Batch(store, { items: [mkItem({ embeddedRulings: embeddedR, note: 'Cosmetic operator memo' })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(calls, 1, 'Cosmetic Gate 1A note & unchanged dynamic embedded rulings must reuse cleanly');
        assert.equal(r1Cosmetic.gate2_3[0].reused_completed_evaluation, true);

        // (#7a) Inadmissible primary lead must block instead of reusing qualifying evaluation!
        const rInad = await runPhase2Batch(store, { items: [mkItem({ leadDisp: 'promotion_only' })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(rInad.gate2_3[0].status, 'blocked_inadmissible_leads');
        assert.equal(calls, 1);

        // Restore admissible lead, then (#7b) static SpecMatcher mismatch must NOT hit cache!
        const mismatchOut = {
          batch: { schema_version: 1, profile_revision: 59, candidates: [mkCand('q-r1-1', 63)] },
          spec_matches: [{
            schema_version: 1,
            contract: 'SpecMatcher',
            form_id: formDef.form_id,
            verdict: 'mismatch',
            comparable_for_q31: false,
            scope: 'complete_kit',
            buyer_task: 'Organize desk items',
            reason: 'Missing tray lid',
            evidence_refs: ['ev-sm-1'],
          }],
        };
        const rMis = await runPhase2Batch(store, { items: [mkItem({ staticResearchOut: mismatchOut })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(rMis.gate2_3[0].status, 'blocked_spec_mismatch');
        assert.equal(calls, 2);

        // (#7c) Static research_out with invalid discovery must NEVER swallow into cache hit!
        const badDiscOut = {
          batch: { schema_version: 1, profile_revision: 59, candidates: [mkCand('q-r1-1', 63)] },
          discovery: { pool: null, decisions: null },
        };
        const rBadDisc = await runPhase2Batch(store, { items: [mkItem({ staticResearchOut: badDiscOut })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(rBadDisc.gate2_3[0].status, 'gate2_3_error', 'Invalid static discovery must not hit stale cache');
        assert.equal(calls, 3);

        // (#7d) Keeping same rights_prescreen_input while adding #8 rulings MUST recompute & revoke!
        const sameRightsInput = { candidate_id: formDef.form_id, target_spec: { label: 'Bamboo Organizer Tray' }, claim_texts: [] };
        const staticCleanOut = { batch: { schema_version: 1, profile_revision: 59, candidates: [mkCand('q-r1-1', 63)] } };
        const rRights1 = await runPhase2Batch(store, {
          items: [mkItem({ staticResearchOut: staticCleanOut, rightsInput: sameRightsInput })],
          profile: r59Profile,
          as_of_date: '2026-11-27',
          resume_skip_completed: true,
        });
        assert.equal(rRights1.gate2_3[0].qualification.counts_toward_target, true);
        assert.equal(calls, 4);
        const rRightsRuling = await runPhase2Batch(store, {
          items: [mkItem({
            staticResearchOut: staticCleanOut,
            rightsInput: sameRightsInput,
            peerRulings: [
              { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '缺托盘' },
              { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '待补清单' },
            ],
          })],
          profile: r59Profile,
          as_of_date: '2026-11-27',
          resume_skip_completed: true,
        });
        assert.notEqual(rRightsRuling.gate2_3[0].reused_completed_evaluation, true, 'Adding #8 rulings alongside unchanged rights_prescreen_input must recompute');
        assert.equal(rRightsRuling.gate2_3[0].qualification.counts_toward_target, false);
        assert.equal(calls, 5);

        // (#8) Revoke qualification via formal rulings -> then omit rulings -> MUST NOT resurrect older qualifying row!
        const rOmittedAfterRevoke = await runPhase2Batch(store, { items: [mkItem()], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.notEqual(rOmittedAfterRevoke.gate2_3[0].reused_completed_evaluation, true, 'Omitting rulings after revocation must never time-travel to an older qualifying row');
        assert.equal(calls, 6);

        // (#6) Legacy pre-fix evaluation receipt lacking detailed fingerprints MUST force recompute when newer quote supersedes!
        store.db.prepare(
          "UPDATE evaluations SET receipt_json = ? WHERE form_id = ?",
        ).run(JSON.stringify({ profile_revision: 59, form_spec_sha256: fRow.spec_sha256 }), formDef.form_id);
        store.recordSourcingQuotesBatch1688([mkQuote('q-r1-2', 'fac-r1-2', 42)]);
        const rLegacyUpgrade = await runPhase2Batch(store, { items: [mkItem({ qid: 'q-r1-2', unitCny: 42 })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.notEqual(rLegacyUpgrade.gate2_3[0].reused_completed_evaluation, true, 'Legacy receipt without detailed fingerprints must recompute');
        assert.equal(calls, 7);

        // (#15) Invalid peer_comparability_rulings on Candidate 1 isolates cleanly while Candidate 2 succeeds!
        const form2Def = {
          form_id: 'form-a3-r1-sibling',
          label: 'Sibling Tray R1',
          buyer_task: 'Hold craft supplies',
          saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
        };
        const { form: f2Row } = store.upsertCandidateForm(form2Def);
        store.recordSourcingQuotesBatch1688([mkQuote('q-r1-sib', 'fac-r1-sib', 42, form2Def.form_id, f2Row.spec_version)]);
        const rIso = await runPhase2Batch(store, {
          items: [
            mkItem({ qid: 'q-r1-2', unitCny: 42, peerRulings: [{ peer_asin: 'B0SYN8LOW1', status: 'bogus_status', source: 'owner_audit', reason: 'bad' }] }),
            mkItem({ qid: 'q-r1-sib', unitCny: 42, fDef: form2Def, specSha: f2Row.spec_sha256, specVer: f2Row.spec_version }),
          ],
          profile: r59Profile,
          as_of_date: '2026-11-27',
          resume_skip_completed: false,
        });
        assert.equal(rIso.gate2_3.find(x => x.form_id === formDef.form_id).status, 'gate2_3_error');
        assert.equal(rIso.gate2_3.find(x => x.form_id === form2Def.form_id).status, 'evaluated');
      } finally {
        store.close();
      }

      // (#8 CLI export + #13 same quote_id conflict on single-product)
      const cliDbPath = join(dir, 'single-prod.sqlite');
      const reportDir = join(dir, 'single-report');
      const specPath = join(dir, 'single-spec.json');
      const conflictSpecPath = join(dir, 'single-spec-conflict.json');
      const profilePath = join(dir, 'profile.json');
      writeFileSync(profilePath, JSON.stringify(r59Profile));
      await runCliMem(['init', '--db', cliDbPath]);

      const stPre = openSelectionStore(cliDbPath);
      const spFormDef = {
        form_id: 'form-sp-a3',
        label: 'Single Product Ruling Test',
        buyer_task: 'Organize desk items',
        saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
      };
      const { form: spForm } = stPre.upsertCandidateForm(spFormDef);
      stPre.close();

      const salesWin = { from: '2027-02-01', through: '2027-10-14' };
      const storageWin = { from: '2027-02-01', through: '2027-09-30' };
      const inboundWin = { from: '2027-01-20', through: '2027-02-01' };
      const spCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
        id: spFormDef.form_id,
        specSha256: spForm.spec_sha256,
        specVersion: spForm.spec_version,
      });
      const fx = 7.0;
      const hhUsd = spCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul')?.amount_usd ?? 2.0;
      const spG1a = spCand.economics.scenarios.map(s => ({
        id: s.id, price_usd: s.cost_ledger.price_usd, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
        fx_cny_per_usd: fx, refund_fraction: 0.02, physical_return_fraction: 0.02, fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
        headhaul_usd: hhUsd, collection_rate: 0.006, sales_window: salesWin, storage_window: storageWin, inbound_window: inboundWin,
        is_apparel: false, is_dangerous_goods: false, is_sipp: false,
      }));
      const spEst = estimateGate1A2027(spG1a[0]);
      for (const s of spCand.economics.scenarios) {
        s.quote_id = 'q-sp-1';
        s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
        s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: 'q-sp-1', fx_cny_per_usd: fx };
        for (const l of s.cost_ledger.lines) {
          if (l.id === 'procurement') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((63 / fx).toFixed(6)); }
          if (l.id === 'domestic_freight') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((1 / fx).toFixed(6)); }
          if (l.id === 'fulfillment') l.amount_usd = spEst.components.fulfillment.total_usd;
          if (l.id === 'placement') l.amount_usd = spEst.components.placement.selected_usd;
          if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, spEst.components.storage.per_unit_usd);
        }
        const r = s.cost_ledger.refund_fraction ?? 0.04;
        const nonCol = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
          .reduce((sum, lid) => sum + (s.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
        const colLine = s.cost_ledger.lines.find(l => l.id === 'collection');
        if (colLine) colLine.amount_usd = Number((Math.max(0, s.cost_ledger.price_usd * (1 - r) - nonCol) * (s.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
      }
      const spBaseSpec = {
        as_of_date: '2026-11-27',
        form: spFormDef,
        leads: [{ lead_id: 'lead-sp-1', source_channel: 'reddit', source_ref: 'https://example.com/r/sp', phrase_or_title: 'tray', observed_at: '2026-11-27', disposition: 'product' }],
        gate1a_scenarios: spG1a,
        quotes: [{
          quote_id: 'q-sp-1',
          factory_id: 'fac-sp-1',
          spec_variant_key: 'kit-std',
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'rb-sp-1',
          ui_readback: VALID_UI_READBACK,
          require_ui_readback: true,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'o-sp-1', sku_id: 'kit', component_id: 'kit', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 63, regular_goods_promo_false: true }],
          goods_cny_total: 6300,
          domestic_freight_cny_total: 100,
        }],
        peer_comparability_rulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '清单待核' },
        ],
        scored_batch: { schema_version: 1, profile_revision: 59, candidates: [spCand] },
      };
      writeFileSync(specPath, JSON.stringify(spBaseSpec, null, 2));
      const spRes = await runCliMem(['single-product', '--db', cliDbPath, '--input', specPath, '--profile', profilePath, '--report-dir', reportDir]);
      assert.equal(spRes.code, 0, spRes.stderr);
      const spOut = JSON.parse(spRes.stdout);
      assert.equal(spOut.batch_report.gate2_3[0].qualification.counts_toward_target, false);
      const exportedResult = JSON.parse(readFileSync(join(reportDir, 'result.json'), 'utf8'));
      assert.equal(
        exportedResult.candidates[0].qualification.counts_toward_target,
        false,
        'single-product --report-dir must apply peer_comparability_rulings consistently with batch_report',
      );

      // (#13) Same quote_id with conflicting goods_cny_total MUST fail cleanly!
      const conflictSpec = structuredClone(spBaseSpec);
      conflictSpec.quotes[0].goods_cny_total = 4200;
      conflictSpec.quotes[0].sku_lines[0].unit_price_cny = 42;
      writeFileSync(conflictSpecPath, JSON.stringify(conflictSpec, null, 2));
      const conflictRes = await runCliMem(['single-product', '--db', cliDbPath, '--input', conflictSpecPath, '--profile', profilePath]);
      assert.notEqual(conflictRes.code, 0, 'Conflicting price under same quote_id must fail instead of silently reusing old quote');
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});
