import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { openOpenAiBudgetLedger } from '../src/openai/budget-ledger.mjs';
import { renderReport } from '../src/report.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { buildEvergreen2027OffPeakEconomics } from '../src/raw-ingest.mjs';
import { estimateGate1A2027 } from '../src/fba-rates-2027.mjs';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const r59Profile = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'), 'utf8'));
const synthBatch = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic-batch.json'), 'utf8'));

function runCliMem(args, testHooks = undefined) {
  let stdout = '';
  let stderr = '';
  return runPhase2Cli(
    args,
    {
      stdout: { write: chunk => { stdout += String(chunk); } },
      stderr: { write: chunk => { stderr += String(chunk); } },
    },
    testHooks,
  ).then(code => ({ code, stdout, stderr }));
}

const VALID_UI_READBACK = Object.freeze({
  logged_in: true,
  viewport_width_px: 1440,
  selected_sku_row_visible: true,
  settlement_bar_visible: true,
  applied_quantity_confirmed: true,
});

function makeScoringCandidateMatchingForm(formId, priceUsd = 45.00, goodsCny = 50.00, freightCny = 1.50, fx = 7.20) {
  const c = structuredClone(synthBatch.candidates[0]);
  c.id = formId;
  c.label = `Synthetic ${formId}`;
  c.screening.reference_price_usd.value = priceUsd;
  const pkgObj = { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 };
  const estRef = estimateGate1A2027({
    price_usd: priceUsd,
    pkg: pkgObj,
    fx_cny_per_usd: fx,
    refund_fraction: 0,
    physical_return_fraction: 0,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, minimum_referral_usd: 0.30, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
    headhaul_usd: 1.80,
    collection_rate: 0.006,
    sales_window: { from: '2027-02-01', through: '2027-10-14' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    profile_revision: 59,
  });
  const sc = structuredClone(c.economics.scenarios[0]);
  const pkgRef = sc.cost_ledger.fee_context.package_ref;
  c.economics.packages = [{ id: pkgRef, ...pkgObj }];
  sc.id = sc.cost_ledger.id = 'sc-c1';
  sc.quote_id = `q-${formId}`;
  sc.cost_ledger.price_usd = priceUsd;
  sc.cost_ledger.fx_cny_per_usd = fx;
  sc.cost_ledger.refund_fraction = 0;
  sc.cost_ledger.physical_return_fraction = 0;
  sc.cost_ledger.source_inputs = {
    quote_id: `q-${formId}`,
    fx_cny_per_usd: fx,
    order_units: 100,
    goods_cny_total: Math.round(goodsCny * 100),
    domestic_freight_cny_total: Math.round(freightCny * 100),
  };
  sc.cost_ledger.fee_context = {
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  const procUsd = Number((goodsCny / fx).toFixed(6));
  const domUsd = Number((freightCny / fx).toFixed(6));
  const fbaUsd = estRef.components.fulfillment.total_usd;
  const placeUsd = estRef.components.placement.selected_usd;
  const storUsd = estRef.components.storage.per_unit_usd;
  const refNetUsd = estRef.components.referral.net_usd;
  const colUsd = estRef.components.collection.collection_usd;
  for (const line of sc.cost_ledger.lines) {
    if (line.id === 'procurement') { line.amount_usd = procUsd; line.order_units = 100; line.fx_cny_per_usd = fx; line.status = 'sourced'; }
    else if (line.id === 'domestic_freight') { line.amount_usd = domUsd; line.order_units = 100; line.fx_cny_per_usd = fx; line.status = 'sourced'; }
    else if (line.id === 'headhaul') { line.amount_usd = 1.80; }
    else if (line.id === 'referral') {
      line.amount_usd = refNetUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-12-31';
        line.fee_basis.referral_fraction = 0.15;
        line.fee_basis.minimum_referral_usd = 0.30;
        line.fee_basis.refund_admin_fraction = 0.20;
        line.fee_basis.refund_admin_cap_usd = 5.00;
      }
    } else if (line.id === 'fulfillment') {
      line.amount_usd = fbaUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-10-14';
      }
    } else if (line.id === 'placement' || line.id === 'inbound_placement') {
      line.amount_usd = placeUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-10-14';
      }
    } else if (line.id === 'storage') {
      line.amount_usd = storUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-09-30';
        line.fee_basis.cubic_feet_per_unit = estRef.components.storage.cubic_feet;
        line.fee_basis.rate_usd_per_cuft_month = estRef.components.storage.rate_usd_per_cuft_month;
        line.fee_basis.average_inventory_days = 45;
      }
    } else if (line.id === 'returns_processing') {
      line.amount_usd = 0;
      line.return_threshold = estRef.components.returns_processing.return_threshold;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-12-31';
        line.fee_basis.fee_category = 'Home and Kitchen';
        line.fee_basis.return_threshold = estRef.components.returns_processing.return_threshold;
      }
    } else if (line.id === 'collection') {
      line.amount_usd = colUsd;
      line.rate = 0.006;
    }
  }
  delete sc.margin;
  delete sc.contribution_usd;
  c.economics = {
    ...c.economics,
    ...buildEvergreen2027OffPeakEconomics({
      saleable_unit: c.economics.saleable_unit,
      off_peak_scenarios: [sc],
    }),
  };
  return c;
}

test('Step 3.1: profit-check & rate-lookup stateless CLI entrypoints verify 2027 off-peak profit, <=10mm rescue, and official rate lookup/persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-step3-stateless-'));
  try {
    // 1) profit-check on a borderline 8.20 in (+5.08mm over 8.00 in Small Bulky boundary) item
    const profitSpecPath = join(dir, 'profit-spec.json');
    const profitOutPath = join(dir, 'profit-out.json');
    writeFileSync(profitSpecPath, JSON.stringify({
      price_usd: 42.99,
      pkg: { length_in: 16.0, width_in: 12.0, height_in: 8.20, weight_lb: 3.5 },
      goods_cny_per_unit: 92.0,
      domestic_freight_cny_per_unit: 3.0,
      fx_cny_per_usd: 7.20,
      headhaul_usd: 3.10,
      fee_category: 'Home and Kitchen',
      refund_fraction: 0.04,
      collection_rate: 0.006,
    }, null, 2));
    const pRes = await runCliMem(['profit-check', '--input', profitSpecPath, '--output', profitOutPath]);
    assert.equal(pRes.code, 0, pRes.stderr);
    const parsedProfit = JSON.parse(pRes.stdout);
    assert.equal(parsedProfit.healthcheck.window.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');
    assert.equal(parsedProfit.healthcheck.window.q4_peak_margin, null);
    assert.equal(parsedProfit.healthcheck.advisory_gate1a_cap.advisory_only_never_pre_kills, true);
    assert.ok(Number.isFinite(parsedProfit.healthcheck.forward_breakeven_30pct.feasible_min_price_usd));
    assert.ok(Number.isFinite(parsedProfit.healthcheck.realized_2027_off_peak.margin));

    // 2) rate-lookup directive mode + verified official tiered referral registration mode
    const dirLookupPath = join(dir, 'lookup-req.json');
    writeFileSync(dirLookupPath, JSON.stringify({
      fee_category: 'Fine Art',
      asin: 'B0SYNART01',
      reason: 'Tiered referral schedule check',
    }, null, 2));
    const rDir = await runCliMem(['rate-lookup', '--input', dirLookupPath]);
    assert.equal(rDir.code, 0, rDir.stderr);
    assert.equal(JSON.parse(rDir.stdout).mode, 'lookup_directive');

    const regPath = join(dir, 'register-tiered.json');
    const persistRegPath = join(dir, 'supplemental-rates.json');
    writeFileSync(regPath, JSON.stringify({
      fee_category: 'Fine Art Synthetic Tiered',
      official_source_url: 'https://sellercentral.amazon.com/help/hub/reference/GTG4BAWSY39Z98Z3',
      effective_from: '2027-01-15',
      effective_through: '2027-12-31',
      sp_api_verified: true,
      comparable_asin: 'B0SYNART01',
      referral_schedule: {
        type: 'tiered',
        minimum_fee_usd: 0.30,
        tiers: [
          { up_to_usd: 100, rate: 0.20 },
          { up_to_usd: null, rate: 0.15 },
        ],
      },
      return_threshold_fraction: 0.05,
      test_price_usd: 150,
    }, null, 2));
    const rReg = await runCliMem(['rate-lookup', '--input', regPath, '--persist-file', persistRegPath]);
    assert.equal(rReg.code, 0, rReg.stderr);
    const parsedReg = JSON.parse(rReg.stdout);
    assert.equal(parsedReg.mode, 'verified_rule_registered');
    // $100 * 20% ($20) + $50 * 15% ($7.50) = $27.50
    assert.equal(parsedReg.sample_referral_calculation.referral_fee_usd, 27.50);
    const persistedDisk = JSON.parse(readFileSync(persistRegPath, 'utf8'));
    assert.ok(persistedDisk.rules.fine_art_synthetic_tiered);

    // Reject non-official URL
    const badUrlPath = join(dir, 'bad-url.json');
    writeFileSync(badUrlPath, JSON.stringify({
      fee_category: 'Fake Blog',
      official_source_url: 'https://random-blog.example.com/fba-rates',
      effective_from: '2027-01-15',
      sp_api_verified: true,
      referral_schedule: { type: 'flat', rate: 0.15 },
    }, null, 2));
    const rBad = await runCliMem(['rate-lookup', '--input', badUrlPath]);
    assert.equal(rBad.code, 2);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Step 3.2: daily-batch, single-dive, reverse-1688, calibration-track, Gate 1A pre-kill ban, M4 visible pending review state, and CAPTCHA_PAUSED resume skipping completed work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-step3-workflow-'));
  try {
    const dbPath = join(dir, 'workflow.sqlite');
    await runCliMem(['init', '--db', dbPath]);

    // 1) Gate 1A pre-1688 reverse-solved cap kill is strictly forbidden in r59
    const badKillPath = join(dir, 'bad-kill.json');
    writeFileSync(badKillPath, JSON.stringify({
      form_id: 'form-bad-kill',
      label: 'Bad Kill',
      buyer_task: 'Organize desk',
      disallow_pre1688_cost_guess_kill: false,
      gate1a_scenarios: [{ id: 'sc-1', price_usd: 45, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
    }, null, 2));
    const rBadKill = await runCliMem(['single-dive', '--db', dbPath, '--input', badKillPath]);
    assert.equal(rBadKill.code, 2);
    assert.match(rBadKill.stderr, /disallow_pre1688_cost_guess_kill/);

    // 2) daily-batch with 2 items: Item 1 has verified 1688 quote; Item 2 triggers CAPTCHA_PAUSED -> pauses cleanly
    const cand1 = makeScoringCandidateMatchingForm('form-daily-1', 45.00, 50.00, 1.50, 7.20);
    const cand2 = makeScoringCandidateMatchingForm('form-daily-2', 45.00, 48.00, 1.50, 7.20);
    const makeQuote = (fid, goodsTotal = 5000) => ({
      quote_id: `q-${fid}`,
      factory_id: `fac-${fid}`,
      sku_lines: [{
        component_id: 'main',
        offer_id: `off-${fid}`,
        sku_id: `sku-${fid}`,
        pack_multiple: 1,
        qty_per_saleable_set: 1,
        moq_qty: 10,
        ordered_qty: 100,
        unit_price_cny: goodsTotal / 100,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: goodsTotal,
      domestic_freight_cny_total: 150,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.20,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
      redacted_destination: '广东省深圳市',
      raw_readback_ref: `readback-${fid}`,
      observed_at: '2026-11-24',
      ui_readback: VALID_UI_READBACK,
    });
    const g1aScen = {
      id: 'sc-c1',
      price_usd: 45.00,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
      fx_cny_per_usd: 7.20,
      refund_fraction: 0,
      physical_return_fraction: 0,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
      headhaul_usd: 1.80,
      collection_rate: 0.006,
    };

    const dailyPausedPath = join(dir, 'daily-paused.json');
    writeFileSync(dailyPausedPath, JSON.stringify({
      as_of_date: '2026-11-24',
      items: [
        {
          form: { form_id: 'form-daily-1', label: 'Daily 1', buyer_task: 'Task 1', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          asin: 'B0SYNDAIL1',
          gate1a_scenarios: [g1aScen],
          quote: makeQuote('form-daily-1', 5000),
          scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand1] },
        },
        {
          form: { form_id: 'form-daily-2', label: 'Daily 2', buyer_task: 'Task 2', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          post_url: 'https://www.reddit.com/r/synth/comments/1/post/',
          source_channel: 'reddit',
          gate1a_scenarios: [g1aScen],
          simulate_1688_captcha: true,
        },
      ],
    }, null, 2));

    const rPause = await runCliMem(['daily-batch', '--db', dbPath, '--input', dailyPausedPath]);
    assert.equal(rPause.code, 0, rPause.stderr);
    const parsedPause = JSON.parse(rPause.stdout);
    assert.equal(parsedPause.batch_report.batch_paused, true);
    assert.equal(parsedPause.batch_report.pause_status, 'CAPTCHA_PAUSED');
    assert.equal(parsedPause.batch_report.paused_form_id, 'form-daily-2');
    assert.deepEqual(parsedPause.batch_report.completed_gate1b_form_ids, ['form-daily-1']);

    // Resume 1688 queue, supply Item 2's verified quote, and resume daily-batch
    const rRes1688 = await runCliMem([
      'resume-1688',
      '--db', dbPath,
      '--login-verified',
      '--form', 'form-daily-2',
      '--city', '广东省深圳市',
      '--quantity', '100',
      '--sku', 'main',
      '--validity', '2027-12-31',
      '--as-of', '2026-11-24',
    ]);
    assert.equal(rRes1688.code, 0, rRes1688.stderr);

    const dailyResumedPath = join(dir, 'daily-resumed.json');
    writeFileSync(dailyResumedPath, JSON.stringify({
      as_of_date: '2026-11-24',
      items: [
        {
          form: { form_id: 'form-daily-1', label: 'Daily 1', buyer_task: 'Task 1', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          asin: 'B0SYNDAIL1',
          gate1a_scenarios: [g1aScen],
          scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand1] },
        },
        {
          form: { form_id: 'form-daily-2', label: 'Daily 2', buyer_task: 'Task 2', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          post_url: 'https://www.reddit.com/r/synth/comments/1/post/',
          source_channel: 'reddit',
          gate1a_scenarios: [g1aScen],
          quote: makeQuote('form-daily-2', 4800),
          scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand2] },
        },
      ],
    }, null, 2));

    const rResumed = await runCliMem(['daily-batch', '--db', dbPath, '--input', dailyResumedPath]);
    assert.equal(rResumed.code, 0, rResumed.stderr);
    const parsedResumed = JSON.parse(rResumed.stdout);
    assert.equal(parsedResumed.batch_report.gate2_3.length, 2);
    assert.equal(parsedResumed.batch_report.gate2_3[0].review_visible_state, '业务入围、当前规格待复核', JSON.stringify(parsedResumed.batch_report.gate2_3[0]));
    assert.equal(parsedResumed.batch_report.gate2_3[0].current_spec_review_verified, false);

    // Re-running daily-batch again skips completed Stage-3 evaluations!
    const rSkip = await runCliMem(['daily-batch', '--db', dbPath, '--input', dailyResumedPath]);
    assert.equal(rSkip.code, 0, rSkip.stderr);
    const parsedSkip = JSON.parse(rSkip.stdout);
    assert.equal(parsedSkip.batch_report.gate2_3[0].reused_completed_evaluation, true);
    assert.ok(parsedSkip.batch_report.skipped_zero_incremental.some(s => s.stage === 'resume_completed_evaluation_reused'));

    // Verify rendered HTML shows "业务入围、当前规格待复核" on unreviewed qualifying r59 card!
    const batchForHtml = { schema_version: 1, profile_revision: 59, candidates: [cand1] };
    const html = renderReport(scoreBatch(batchForHtml, r59Profile), batchForHtml);
    assert.ok(html.includes('业务入围、当前规格待复核'));

    // 3) reverse-1688: 1688 source-factory quote -> exact 30%-margin minimum US retail price + band comparison
    const rev1688Path = join(dir, 'rev1688.json');
    writeFileSync(rev1688Path, JSON.stringify({
      form_id: 'form-rev-1688-1',
      label: '1688 Cold Start Rack',
      buyer_task: 'Store paint bottles',
      pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.8 },
      fx_cny_per_usd: 7.20,
      headhaul_usd: 2.10,
      mature_price_band: { p25_usd: 39.99, p50_usd: 45.99, p75_usd: 52.99 },
      quote: makeQuote('form-rev-1688-1', 4200),
    }, null, 2));
    const rRev = await runCliMem(['reverse-1688', '--db', dbPath, '--input', rev1688Path]);
    assert.equal(rRev.code, 0, rRev.stderr);
    const parsedRev = JSON.parse(rRev.stdout);
    assert.ok(Number.isFinite(parsedRev.reverse_1688.min_retail_price_for_30pct_usd));
    assert.ok(['below_band_strong_headroom', 'within_mature_band_viable'].includes(parsedRev.reverse_1688.mature_band_comparison));

    // 4) calibration-track: persist and query all 4 SQLite calibration items
    const calPath = join(dir, 'cal-track.json');
    writeFileSync(calPath, JSON.stringify({
      records: [
        {
          form_id: 'form-daily-1',
          batch_id: 'batch-step3-test',
          system_verdict: 'full_annual_qualifying',
          core_85_range: [85, 85],
          supported_range: [100, 100],
          pre_ad_margin_range: [0.49, 0.49],
          owner_decision: 'sample_check',
          owner_reason: '核心85分满分且毛利超45%，拿样实测外盒与木料细节。',
          sample_measured_pkg: { length_in: 10.2, width_in: 6.1, height_in: 2.0, weight_lb: 1.25 },
          recalculate_profit_spec: {
            price_usd: 45.00,
            goods_cny_per_unit: 50.00,
            domestic_freight_cny_per_unit: 1.50,
            fx_cny_per_usd: 7.20,
            headhaul_usd: 1.80,
          },
          calibration_note: 'CALIBRATION_NOTE: Batch-1 Terra vs Astra Keepa 1-year curve reading aligned on steady band.',
          near_miss_spot_check: {
            terra_vs_astra_keepa_audit: { aligned: true, delta_usd: 0 },
            near_miss_forms_checked: ['form-bad-kill'],
          },
        },
      ],
    }, null, 2));
    const rCalWrite = await runCliMem(['calibration-track', '--db', dbPath, '--input', calPath]);
    assert.equal(rCalWrite.code, 0, rCalWrite.stderr);
    const parsedCalWrite = JSON.parse(rCalWrite.stdout);
    assert.equal(parsedCalWrite.saved_count, 1);
    assert.equal(parsedCalWrite.saved[0].owner_decision, 'sample_check');
    assert.equal(parsedCalWrite.saved[0].recalculated_margin.meets_30pct_floor, true);

    const rCalList = await runCliMem(['calibration-track', '--db', dbPath, '--list', '--batch-id', 'batch-step3-test']);
    assert.equal(rCalList.code, 0, rCalList.stderr);
    assert.equal(JSON.parse(rCalList.stdout).count, 1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Step 3.3: openai-recover & openai-batch-poll CLI commands recover GET /v1/responses/{id} and poll Batch API without duplicate POST', async () => {
  const { OpenAiClient } = await import('../src/openai/client.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'r59-step3-openai-cli-'));
  try {
    const dbPath = join(dir, 'budget.sqlite');
    const credPath = join(dir, 'cred.json');
    const apiKey = 'sk-proj-Step3SyntheticTestKey0123456789ABCDEF';
    writeFileSync(credPath, JSON.stringify({ api_key: apiKey }));

    const ledgerOpts = { testMode: true, canonicalRegistryPath: join(dir, 'mock-registry.sqlite') };
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
    const dropClient = new OpenAiClient({
      ledger,
      credentialFile: credPath,
      testMode: true,
      baseUrl: 'https://api.openai.com',
      fetchImpl: async (url, init = {}) => {
        if (String(init.method || 'GET').toUpperCase() === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_step3_rec_001',
            object: 'response',
            status: 'in_progress',
            model: 'gpt-6.1-terra',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error('Simulated network drop during background poll');
      },
    });
    let droppedAttemptId = null;
    await assert.rejects(async () => {
      await dropClient.createResponse(
        { model: 'gpt-6.1-terra', input: 'test prompt' },
        { accountScope: 'openai-default', logicalRequestId: 'step3-rec-req-1', background: true, pollIntervalMs: 1 },
      );
    }, err => {
      droppedAttemptId = err?.attempt_id ?? ledger.getAttemptByLogicalId('step3-rec-req-1', { accountScope: 'openai-default' })?.attempt_id ?? null;
      return true;
    });
    assert.ok(droppedAttemptId);
    ledger.close();

    let postCount = 0;
    let getCount = 0;
    const mockFetch = async (url, init = {}) => {
      const m = String(init.method || 'GET').toUpperCase();
      if (m === 'POST') postCount++;
      if (m === 'GET') getCount++;
      const u = String(url);
      if (u.endsWith('/v1/responses/resp_step3_rec_001')) {
        return new Response(JSON.stringify({
          id: 'resp_step3_rec_001',
          object: 'response',
          status: 'completed',
          model: 'gpt-6.1-terra',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
          usage: { input_tokens: 1200, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/batches/batch_step3_001')) {
        return new Response(JSON.stringify({
          id: 'batch_step3_001',
          object: 'batch',
          endpoint: '/v1/responses',
          status: 'in_progress',
          request_counts: { total: 2, completed: 1, failed: 0 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const hooks = {
      testLedgerOptions: ledgerOpts,
      openAiClientOptions: { testMode: true, fetchImpl: mockFetch, baseUrl: 'https://api.openai.com' },
    };

    const recOut = await runCliMem([
      'openai-recover',
      '--db', dbPath,
      '--credential-file', credPath,
      '--attempt', droppedAttemptId,
    ], hooks);
    assert.equal(recOut.code, 0, recOut.stderr);
    assert.equal(postCount, 0, 'openai-recover must NEVER issue a POST');
    assert.equal(getCount, 1);
    const parsedRec = JSON.parse(recOut.stdout);
    assert.equal(parsedRec.recovered, true);
    assert.equal(parsedRec.receipt.status, 'completed');
    assert.ok(parsedRec.receipt.usage_cost_micros > 0);

    const pollOut = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--batch-id', 'batch_step3_001',
    ], hooks);
    assert.equal(pollOut.code, 0, pollOut.stderr);
    assert.equal(JSON.parse(pollOut.stdout).batch_status, 'in_progress');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});
