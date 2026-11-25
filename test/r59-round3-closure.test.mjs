import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  classifySizeTier2027,
  computeOrderPlan,
  estimateGate1A2027,
  lookupFulfillmentFee2027,
} from '../src/fba-calculator.mjs';
import { computeHeadhaulWithA4Rules } from '../src/fba-calculator.mjs';
import { calculateEconomics } from '../src/economics.mjs';
import { evaluateEarlyScreen } from '../src/economics.mjs';
import { containsSecretToken, sanitizeDiagnosticText } from '../src/contracts.mjs';
import { openSelectionStore, sha256Hex } from '../src/store.mjs';
import { replayBatchIntoStore } from '../src/history-import.mjs';
import { analyzeMainstreamPriceBand, evaluateGate0CategoryBoundary } from '../src/price-band.mjs';
import { resolveTargetChildSalesObservation } from '../src/observations.mjs';
import {
  buildPairedSeasonalOperatingPeriods,
  extractSpApiFinalistCalibration,
  ingestTrialSpecification,
  resolveStage1QualitativeJudgments,
} from '../src/raw-ingest.mjs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { attachCandidateEvidenceReview, doesReviewPacketMatchDbFormSpec, runGate1AForForm, runGate1BForForm, runOptionalGate4EvidenceReview, runPhase2Batch } from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import {
  OpenAiBudgetLedger,
  OpenAiClient,
  RIGHTS_PRESCREEN_JSON_SCHEMA,
  buildStage1DecisionsRequests,
  freezeEvidenceReviewPacket,
  parseMarketObservationResult,
  parseReviewJudgeResult,
  parseRightsPreScreenResult,
  parseStage1DecisionsResponses,
  runCodexEvidenceReview,
  runCodexExecMarkdown,
  verifySavedCodexReceipt,
} from '../src/openai/index.mjs';

const r58Profile = JSON.parse(readFileSync(new URL('../docs/archive/design/reference-profile.r58.archived.json', import.meta.url), 'utf8'));

const r59Profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
const synthBatch = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

test('Step 1.1: Fee provenance, coupon $50 list-price FBA tier, tied-price P75, >=5-carton amazon_optimized, A4 volumetric carton_count, and SP-API exact-cent/error guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-step1-fees-'));
  try {
    // 1) SP-API PriceToEstimateFees.ListingPrice.Amount echo MUST NEVER count as market price provenance!
    const candEcho = structuredClone(synthBatch.candidates[0]);
    candEcho.id = 'cand-sp-echo';
    candEcho.screening.reference_price_usd.value = 88.88;
    candEcho.economics.scenarios[0].cost_ledger.price_usd = 88.88;
    const spFeeOnly = [{
      Status: 'Success',
      FeesEstimateIdentifier: {
        MarketplaceId: 'ATVPDKIKX0DER',
        IdType: 'ASIN',
        IdValue: 'B0SYNECHO1',
        IsAmazonFulfilled: true,
        PriceToEstimateFees: { ListingPrice: { Amount: 88.88, CurrencyCode: 'USD' } },
      },
      FeesEstimate: {
        TotalFeesEstimate: { Amount: 18.33, CurrencyCode: 'USD' },
        FeeDetailList: [
          { FeeType: 'ReferralFee', FinalFee: { Amount: 13.33, CurrencyCode: 'USD' } },
          { FeeType: 'FBAFees', FinalFee: { Amount: 5.00, CurrencyCode: 'USD' } },
        ],
      },
    }];
    const echoFeePath = join(dir, 'sp-echo.json');
    const echoBytes = Buffer.from(JSON.stringify(spFeeOnly), 'utf8');
    writeFileSync(echoFeePath, echoBytes);
    assert.throws(
      () => ingestTrialSpecification(
        {
          profile_revision: 59,
          evidence: synthBatch.evidence,
          raw_receipt_files: ['sp-echo.json'],
          expected_raw_sha256s: { 'sp-echo.json': createHash('sha256').update(echoBytes).digest('hex') },
          candidates: [{ candidate: candEcho }],
        },
        r59Profile,
        { baseDir: dir },
      ),
      /price|provenance|88\.88/i,
      'SP-API fee-inquiry input price echo must never satisfy market selling-price provenance',
    );

    // 2) Ongoing coupon uses pre-coupon >=$50 list-price FBA tier across fba-rates-2027, economics, early-screen, scoring, and pipeline!
    const pkgStd = { length_in: 12, width_in: 9, height_in: 3, weight_lb: 1.8 };
    const fbaCouponCross = lookupFulfillmentFee2027({
      pkg: pkgStd,
      price_usd: 45.90,
      list_price_usd: 51.00,
      ongoing_coupon_pct: 0.10,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
    });
    const fbaOver50 = lookupFulfillmentFee2027({
      pkg: pkgStd,
      price_usd: 51.00,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
    });
    assert.equal(fbaCouponCross.total_usd, fbaOver50.total_usd, 'List price $51 w/ 10% coupon ($45.90 net) pays >$50 FBA fulfillment tier');

    // Scoring rejects under-billed <$50 FBA fee when list_price_usd >= $50 even if fulfillment.fee_basis.price_band is omitted!
    const candUnderFba = structuredClone(synthBatch.candidates[0]);
    const fbaUnder50 = lookupFulfillmentFee2027({
      pkg: pkgStd,
      price_usd: 45.90,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
    });
    const ledUnder = candUnderFba.economics.scenarios[0].cost_ledger;
    ledUnder.price_usd = 45.90;
    ledUnder.list_price_usd = 51.00;
    ledUnder.ongoing_coupon_pct = 0.10;
    ledUnder.fee_context = {
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'pkg-std',
      sales: { from: '2027-02-01', through: '2027-10-14' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-15', through: '2027-10-14' },
    };
    const fulLine = ledUnder.lines.find(l => l.id === 'fulfillment');
    fulLine.amount_usd = fbaUnder50.total_usd; // under-billed $10-$50 tier!
    fulLine.fee_basis = { pkg: pkgStd };
    const scoredUnderFba = scoreCandidate(candUnderFba, r59Profile);
    assert.equal(scoredUnderFba.qualification.counts_toward_target, false, 'Under-billed <$50 FBA tier on $51 list-price coupon must block qualification');

    // Combined external + Amazon coupon in other_applicable preserves exact Amazon payout portion across readback
    const combLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    combLedger.price_usd = 45.00;
    combLedger.list_price_usd = 50.00;
    combLedger.ongoing_coupon_pct = 0.10;
    combLedger.lines.find(l => l.id === 'fulfillment').amount_usd = fbaOver50.total_usd;
    const combOther = combLedger.lines.find(l => l.id === 'other_applicable');
    combOther.amount_usd = 2.00;
    combOther.payee = 'external';
    const econCombined = calculateEconomics(combLedger, { profileRevision: 59 });
    const otherAfter = econCombined.lines.find(l => l.id === 'other_applicable');
    assert.ok(otherAfter.amazon_portion_usd > 1.1 && otherAfter.amazon_portion_usd < 1.3, 'Amazon coupon fee portion (~$1.175) recorded separately from external $2.00 other_applicable');

    // 3) Tied-price weightedQuantile invariance: swapping sales across same-net-price ASINs never jumps P75!
    const tiedA = analyzeMainstreamPriceBand([
      { asin: 'B0TIE00001', price_usd: 30.00, fulfillment: 'FBA', monthlySales: 60, age_days: 400, keepa_price_steady: true },
      { asin: 'B0TIE00002', price_usd: 30.00, fulfillment: 'FBA', monthlySales: 20, age_days: 410, keepa_price_steady: true },
      { asin: 'B0TIE00003', price_usd: 60.30, fulfillment: 'FBA', monthlySales: 20, age_days: 420, keepa_price_steady: true },
    ], { as_of_date: '2026-11-24', strict_mature_only: true });
    const tiedB = analyzeMainstreamPriceBand([
      { asin: 'B0TIE00001', price_usd: 30.00, fulfillment: 'FBA', monthlySales: 20, age_days: 400, keepa_price_steady: true },
      { asin: 'B0TIE00002', price_usd: 30.00, fulfillment: 'FBA', monthlySales: 60, age_days: 410, keepa_price_steady: true },
      { asin: 'B0TIE00003', price_usd: 60.30, fulfillment: 'FBA', monthlySales: 20, age_days: 420, keepa_price_steady: true },
    ], { as_of_date: '2026-11-24', strict_mature_only: true });
    assert.equal(tiedA.band.p75_usd, 30);
    assert.equal(tiedB.band.p75_usd, 30, 'Swapping sales between two $30 ASINs keeps total $30 weight at 80% >= 75%, P75 = $30');

    // 4) Standard/Bulky amazon_optimized ($0 placement) requires >=5 identical cartons + multi_destination_headhaul_verified; Oversize stays $0 exempt!
    const g1aUnverifiedOpt = estimateGate1A2027({
      price_usd: 45,
      pkg: pkgStd,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      headhaul_usd: 2.5,
      collection_rate: 0.006,
      placement_split_option: 'amazon_optimized',
    });
    assert.equal(g1aUnverifiedOpt.status, 'sensitivity_only', 'Unverified amazon_optimized is sensitivity_only, never verified primary');
    const g1aVerifiedOpt = estimateGate1A2027({
      price_usd: 45,
      pkg: pkgStd,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      headhaul_usd: 2.5,
      collection_rate: 0.006,
      placement_split_option: 'amazon_optimized',
      identical_cartons_count: 5,
      multi_destination_headhaul_verified: true,
    });
    assert.equal(g1aVerifiedOpt.status, 'verified');
    assert.equal(g1aVerifiedOpt.components.placement.selected_usd, 0);

    const oversizeTier = classifySizeTier2027({ length_in: 62, width_in: 20, height_in: 12, weight_lb: 18 });
    assert.match(oversizeTier.size_tier, /oversize/i);

    // 5) Freight A4 volumetric headhaul with array carton_cm [60, 50, 40] and missing carton_count stays pending!
    const a4MissingCnt = computeHeadhaulWithA4Rules({
      actual_weight_kg_per_unit: 0.5,
      order_units: 100,
      carton_cm: [60, 50, 40],
      rate_cny_per_kg: 12,
      bond_cny_per_kg: 0,
    }, 7.2, 100, { isR59: true });
    assert.equal(a4MissingCnt.missing_surcharge_quote, true);
    assert.equal(a4MissingCnt.amount_usd, null);

    // 6) SP-API exact-cent matching ($90.01 vs $90.02), IdType=ASIN, Shipping input, and apparel/DG passthrough
    const spCalUnmatchedCent = extractSpApiFinalistCalibration({
      asin: 'B0SYNCENT1',
      price_usd: 90.01,
      feesEstimateRaw: [{
        Status: 'Success',
        FeesEstimateIdentifier: {
          MarketplaceId: 'ATVPDKIKX0DER',
          IdType: 'ASIN',
          IdValue: 'B0SYNCENT1',
          IsAmazonFulfilled: true,
          PriceToEstimateFees: { ListingPrice: { Amount: 90.02, CurrencyCode: 'USD' } },
        },
        FeesEstimate: {
          TotalFeesEstimate: { Amount: 18.5, CurrencyCode: 'USD' },
          FeeDetailList: [
            { FeeType: 'ReferralFee', FinalFee: { Amount: 13.5, CurrencyCode: 'USD' } },
            { FeeType: 'FBAFees', FinalFee: { Amount: 5.0, CurrencyCode: 'USD' } },
          ],
        },
      }],
    });
    assert.equal(spCalUnmatchedCent.fee_calibration_status, 'unmatched', '1-cent mismatch ($90.01 vs $90.02) must not cross-match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Step 1.2: Excluded/deferred priority over crossing_30pct, pre-score Terra hooks, Chinese registry failure guard, Keepa veteran steady evidence, Luna split, and distinct factory_id cap', async () => {
  // 1) Excluded / deferred priority strictly beats crossing_30pct_interval in both scoring and report!
  const candExclCross = structuredClone(synthBatch.candidates[0]);
  candExclCross.id = 'cand-excl-cross';
  candExclCross.judgments.specific_design_rights = {
    anchor: 0,
    proven_conflict: true,
    reason: 'Matched synthetic active design patent.',
    evidence: ['synthetic-evidence'],
  };
  const scPass = structuredClone(candExclCross.economics.scenarios[0]);
  const scFail = structuredClone(scPass);
  scFail.id = scFail.cost_ledger.id = 'sc-below-30';
  scFail.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd += 12;
  candExclCross.economics.scenarios = [scPass, scFail];
  const batchExcl = { ...structuredClone(synthBatch), profile_revision: 59, candidates: [candExclCross] };
  const scoredExcl = scoreBatch(batchExcl, r59Profile);
  assert.equal(scoredExcl.candidates[0].queue, 'excluded');
  assert.notEqual(scoredExcl.candidates[0].effective_disposition, 'crossing_30pct_interval');
  const htmlExcl = renderReport(scoredExcl, batchExcl);
  assert.equal(htmlExcl.includes('跨 30% 红线'), false, 'Excluded card must never display 跨 30% 红线');

  // 2) Pre-score Terra rights_prescreen hook executes BEFORE scoreBatch so proven patent conflict vetoes card!
  const candPreTerra = structuredClone(synthBatch.candidates[0]);
  const formIdPre = candPreTerra.id;
  const primScen = candPreTerra.economics.scenarios[0];
  const pricePre = primScen.cost_ledger.price_usd;
  const fxPre = 7.0;
  const procUsd = primScen.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd;
  const domUsd = primScen.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd;
  const hhUsd = primScen.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd;
  const unitGoodsPre = Math.round(procUsd * fxPre * 10000) / 10000;
  const totalDomPre = Math.round(domUsd * fxPre * 100 * 100) / 100;
  const salesWinPre = { from: '2027-02-01', through: '2027-10-14' };
  const storageWinPre = { from: '2027-02-01', through: '2027-09-30' };
  const inboundWinPre = { from: '2027-01-15', through: '2027-10-14' };
  const g1aSpecPre = {
    id: primScen.id,
    pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
    price_usd: pricePre,
    fx_cny_per_usd: fxPre,
    refund_fraction: 0.02,
    physical_return_fraction: 0.02,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
    headhaul_usd: hhUsd,
    collection_rate: 0.006,
    sales_window: salesWinPre,
    storage_window: storageWinPre,
    inbound_window: inboundWinPre,
    is_apparel: false,
    is_dangerous_goods: false,
    is_sipp: false,
  };
  const estPre = estimateGate1A2027(g1aSpecPre);
  const store = openSelectionStore(':memory:');
  try {
    const validRightsConflict = {
      schema_version: 1,
      contract: 'RightsAndCompliancePreScreener',
      specific_design_rights: {
        status: 'proven_conflict',
        summary: 'Matched active ornamental design patent on identical housing.',
        citations: [{ title: 'USPTO Design Patent', url: 'https://ppubs.uspto.gov/pubwebapp/', identifier: 'USD1000001S1', applies_to_target_spec: true, legal_status: 'active' }],
      },
      trademark_conflicts: { status: 'no_public_hit_observed', summary: 'Checked.', citations: [] },
      applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['CPSC'], summary: 'Checked.', citations: [] },
      trade_duty_alerts: { status: 'unknown', summary: 'Deferred.', citations: [] },
      disclaimer: 'Initial public pre-screen only; this is not final legal clearance or legal advice.',
    };
    const batchRes = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-24',
      openai_hooks: {
        rights_prescreen: {
          enabled: true,
          responseExecutor: async () => ({
            status: 'completed',
            usable: true,
            content_status: 'usable',
            attempt_id: 'att-pre-terra-1',
            output_text: JSON.stringify(validRightsConflict),
          }),
        },
      },
      items: [{
        form: {
          form_id: formIdPre,
          label: candPreTerra.label,
          buyer_task: 'Organize desktop items',
          saleable_set_composition: { components: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
        },
        leads: [{
          lead_id: 'lead-pre-terra-1',
          source_channel: 'reddit',
          source_ref: 'https://example.com/r/synth/1',
          phrase_or_title: 'desktop organizer',
          observed_at: '2026-11-24',
          disposition: 'product',
        }],
        gate1a_scenarios: [g1aSpecPre],
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-pre-terra-1',
            factory_id: 'fac-pre-1',
            observed_at: '2026-11-24',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ref-pre-1',
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
            sku_lines: [{ offer_id: 'off-1', sku_id: 'main', component_id: 'main', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: unitGoodsPre, regular_goods_promo_false: true }],
            goods_cny_total: Math.round(unitGoodsPre * 100 * 100) / 100,
            domestic_freight_cny_total: totalDomPre,
          },
        }),
        early_screen_builder: () => ([{
          profile_revision: 59,
          id: primScen.id,
          saleable_unit: '1 complete set',
          price_usd: pricePre,
          fx_cny_per_usd: fxPre,
          order_units: 100,
          goods_cny_per_unit: unitGoodsPre,
          domestic_freight_cny_per_unit: totalDomPre / 100,
          first_order_promotion: false,
          goods_first_order_promotion: false,
          headhaul: { usd_per_unit: hhUsd, bond_included: true },
          refund_fraction: 0.02,
          physical_return_fraction: 0.02,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          is_apparel_or_shoes: false,
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
          fulfillment_usd: estPre.components.fulfillment.total_usd,
          placement_usd: estPre.components.placement.selected_usd,
          storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWinPre, storage: storageWinPre, inbound: inboundWinPre },
          collection_rate: 0.006,
          other_applicable_usd: 0,
          specific_rights_conflict: 'unknown',
          strong_date_dependency: false,
        }]),
        rights_prescreen_input: {
          form_id: formIdPre,
          label: candPreTerra.label,
          buyer_task: 'Organize desktop items',
        },
        deep_research_executor: async () => {
          const aligned = structuredClone(candPreTerra);
          const led = aligned.economics.scenarios[0].cost_ledger;
          led.fee_context.sales = salesWinPre;
          led.fee_context.storage = storageWinPre;
          led.fee_context.inbound = inboundWinPre;
          for (const l of led.lines) {
            if (l.id === 'procurement' || l.id === 'domestic_freight') {
              l.fx_cny_per_usd = fxPre;
              l.order_units = 100;
            }
            if (l.id === 'fulfillment') l.amount_usd = estPre.components.fulfillment.total_usd;
            if (l.id === 'placement' || l.id === 'inbound_placement') l.amount_usd = estPre.components.placement.selected_usd;
            if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, estPre.components.storage.per_unit_usd);
          }
          return {
            batch: { ...structuredClone(synthBatch), profile_revision: 59, candidates: [aligned] },
          };
        },
      }],
    });
    assert.equal(batchRes.evaluations[0].queue_bucket, 'excluded', 'Terra rights_prescreen ran before scoreBatch and vetoed proven conflict');

    // 3) Distinct factory_id cap: 3 quote revisions from Factory A count as 1 factory, allowing Factory B!
    store.upsertCandidateForm({ form_id: 'form-fac-cap', label: 'Adult Storage Rack', buyer_task: 'Hold pantry jars', saleable_set_composition: { qty: 1 } });
    const pbMature = analyzeMainstreamPriceBand([
      { asin: 'B0FAC00001', price_usd: 42.99, fulfillment: 'FBA', monthlySales: 80, age_days: 400, keepa_price_steady: true },
      { asin: 'B0FAC00002', price_usd: 44.99, fulfillment: 'FBA', monthlySales: 90, age_days: 420, keepa_price_steady: true },
    ], { as_of_date: '2026-11-24', strict_mature_only: true });
    const g1aFac = runGate1AForForm(store, {
      form_id: 'form-fac-cap',
      price_band_analysis: pbMature,
      scenarios: [{
        id: 'sc-fac',
        price_usd: 42.99,
        pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 },
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.2,
        collection_rate: 0.006,
      }],
    });
    assert.equal(g1aFac.proceed_to_gate1b, true);
    const makeUi = () => ({
      logged_in: true,
      viewport_width_px: 1440,
      selected_sku_row_visible: true,
      settlement_bar_visible: true,
      applied_quantity_confirmed: true,
    });
    for (let revIdx = 1; revIdx <= 3; revIdx++) {
      const rSame = await runGate1BForForm(store, {
        form_id: 'form-fac-cap',
        profile_revision: 59,
        as_of_date: '2026-11-24',
        early_screen_builder: q => g1aFac.declared_scenarios.map(d => ({
          profile_revision: 59,
          id: d.id,
          saleable_unit: '1 unit',
          price_usd: d.price_usd,
          fx_cny_per_usd: d.fx_cny_per_usd,
          order_units: 100,
          goods_cny_per_unit: q.goods_cny_total / 100,
          domestic_freight_cny_per_unit: q.domestic_freight_cny_total / 100,
          first_order_promotion: false,
          goods_first_order_promotion: false,
          pkg: d.pkg,
          headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true },
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          is_apparel_or_shoes: false,
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          fulfillment_usd: d.fulfillment_usd,
          placement_usd: d.placement_range_usd[1],
          storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
          collection_rate: 0.006,
          other_applicable_usd: 0,
          specific_rights_conflict: 'unknown',
          strong_date_dependency: false,
        })),
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: `q-same-fac-${revIdx}`,
            factory_id: 'fac-alpha',
            sku_lines: [{ offer_id: 'off-a', sku_id: 'SKU-1', component_id: 'SKU-1', unit_price_cny: 130 - revIdx, qty_per_saleable_set: 1, moq_qty: 50, ordered_qty: 100, pack_multiple: 1, regular_goods_promo_false: true }],
            goods_cny_total: (130 - revIdx) * 100,
            domestic_freight_cny_total: 200,
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            lead_time_days: 10,
            redacted_destination: '广东深圳',
            raw_readback_ref: `ref-${revIdx}`,
            observed_at: '2026-11-24T00:00:00Z',
            ui_readback: makeUi(),
          },
        }),
      });
      assert.equal(rSame.checked_factory_quotes_count, 1);
      assert.equal(rSame.second_factory_quote_needed, true, '3 revisions from same factory_id still allow checking a 2nd factory');
    }
  } finally {
    store.close();
  }

  // 4) Veteran >=365d without Keepa steady evidence when Keepa context exists does NOT block 91-364d steady supplement!
  const pbVetNoKeepa = analyzeMainstreamPriceBand([
    { asin: 'B0VET00001', price_usd: 95, fulfillment: 'FBA', monthlySales: 50, age_days: 450 },
    { asin: 'B0VET00002', price_usd: 99, fulfillment: 'FBA', monthlySales: 50, age_days: 480 },
    { asin: 'B0GRW00001', price_usd: 43, fulfillment: 'FBA', monthlySales: 90, age_days: 180, keepa_price_steady: true },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });
  assert.equal(pbVetNoKeepa.band.p50_usd, 43);

  // 5) Stacked 10% coupon + 10% Prime is NOT treated as single >=20% heavy coupon; adult footwear in Luna goes to amber_manual_review!
  const pbStacked = analyzeMainstreamPriceBand([
    { asin: 'B0STK00001', price_usd: 49.99, ongoing_coupon_pct: 0.10, prime_discount_pct: 0.10, fulfillment: 'FBA', monthlySales: 100, age_days: 400, keepa_price_steady: true },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });
  assert.equal(pbStacked.mainstream_count, 1);
  assert.equal(pbStacked.observed_out_of_band_peers.length, 0, '10% coupon + 10% Prime stays in mainstream_pool rather than >=20% heavy-coupon isolation');

  const lunaReqs = buildStage1DecisionsRequests({
    candidates: [{ candidate_id: 'ADULT-SHOE-1', title: "Men's Leather Chelsea Boots Size 10", department: 'Clothing, Shoes & Jewelry', price_usd: 69.99 }],
  });
  assert.match(lunaReqs[0].questions[0].instructions, /hard-prohibited statutory <=12y/i);
  const lunaParsed = parseStage1DecisionsResponses(
    [{ candidate_id: 'ADULT-SHOE-1', title: "Men's Leather Chelsea Boots Size 10", department: 'Clothing, Shoes & Jewelry', price_usd: 69.99 }],
    [{ status: 'completed', usable: true, content_status: 'usable', decisions: [
      { id: 'gate0_prohibited_ADULT-SHOE-1', type: 'predicate', probability: 0.85 },
      { id: 'visual_peer_ADULT-SHOE-1', type: 'choice', value: 'exact_peer' },
    ] }],
  );
  assert.equal(lunaParsed.items[0].gate0_status, 'allowed');
  assert.equal(lunaParsed.items[0].triage_disposition, 'amber_manual_review', 'Adult footwear soft-avoid category is routed to amber_manual_review, never auto-excluded');

  // 6) Rights citations reject expired/non-target-spec proven_conflict claims; Chinese查询未完成 blocks prescreen_completed!
  assert.throws(
    () => parseRightsPreScreenResult({
      schema_version: 1,
      contract: 'RightsAndCompliancePreScreener',
      specific_design_rights: {
        status: 'proven_conflict',
        summary: 'Found an expired design patent.',
        citations: [{ title: 'Expired Patent', url: 'https://ppubs.uspto.gov/pubwebapp/', identifier: 'USD400000S', applies_to_target_spec: true, legal_status: 'expired' }],
      },
      trademark_conflicts: { status: 'no_public_hit_observed', summary: 'Checked.', citations: [] },
      applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['CPSC'], summary: 'Checked.', citations: [] },
      trade_duty_alerts: { status: 'unknown', summary: 'Deferred.', citations: [] },
      disclaimer: 'Initial public pre-screen only; this is not final legal clearance or legal advice.',
    }),
    /expired|proven_conflict/i,
  );
  const cnPublicFail = resolveStage1QualitativeJudgments({
    rights_prescreen: {
      specific_design_rights: { status: 'no_public_hit_observed', summary: 'Checked.' },
      applicable_public_requirements: { status: 'needs_verification', frameworks_checked: ['CPSC'], summary: 'CPSC 登记库查询未完成，暂时不可用。' },
    },
  });
  assert.equal(cnPublicFail.judgments.applicable_public_requirements.prescreen_completed, false);
});

test('Step 1.3: Q31 90d & review anomaly advisory, leafRank/LCM advisories, #17 curly-quote & variant_sku guard, M2 enriched GET usage, M4 stale spec guard, R2-2 stderr scrub, and omitted model config inheritance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-step1-q31-ledger-'));
  try {
    // 1) leafRank > 200 and LCM > 200 emit non-blocking advisories in r59 instead of silently failing
    const childAdv = resolveTargetChildSalesObservation({
      asin: 'B0CHDADV01',
      variant_count: 3,
      leaf_bsr_rank: 205,
    });
    assert.equal(childAdv.tier, 'sub_50_active_starter');
    assert.equal(childAdv.high_leaf_rank_advisory, true, 'leafRank 205 emits non-blocking advisory');

    const lcmAdv = computeOrderPlan({
      sku_lines: [
        { sku_id: 'A', unit_price_cny: 10, qty_per_saleable_set: 1, moq: 100, pack_multiple: 17, first_order_promotion: false },
        { sku_id: 'B', unit_price_cny: 10, qty_per_saleable_set: 1, moq: 100, pack_multiple: 13, first_order_promotion: false },
      ],
      min_order_sets: 100,
      profileRevision: 59,
    });
    assert.equal(lcmAdv.lcm_step_sets, 221);
    assert.ok(lcmAdv.high_lcm_advisory, 'LCM 221 > 200 emits non-blocking high_lcm_advisory in r59');

    // 2) #17 PainPointAndRubricJudge normalizes curly quotes & whitespace and preserves target_variant_sku!
    const parsedRev = parseReviewJudgeResult({
      schema_version: 1,
      contract: 'PainPointAndRubricJudge',
      item_id: 'feasible_light_differentiation',
      status: 'supported',
      support_level: 'strong',
      reason: 'Upgrade thin latch.',
      evidence_refs: ['rev-1'],
      counter_evidence: [],
      review_citations: [{
        review_id: 'rev-1',
        sku_verified: true,
        variant_sku: 'SKU-2PC-WALNUT',
        excerpt: "it doesn't latch cleanly after repeated use",
      }],
    }, {
      item_id: 'feasible_light_differentiation',
      target_variant_sku: 'SKU-2PC-WALNUT',
      reviews: [{
        review_id: 'rev-1',
        sku_verified: true,
        variant_sku: 'SKU-2PC-WALNUT',
        text: 'Buyer note: it doesn\u2019t   latch\ncleanly after repeated use!',
      }],
    });
    assert.equal(parsedRev.target_variant_sku, 'SKU-2PC-WALNUT');

    // 3) MarketObservationJudge blocks string coupon '5% OFF' -> '40% OFF', empty review_history: [], and title-only fabricated dims!
    assert.throws(
      () => parseMarketObservationResult({
        schema_version: 1,
        contract: 'MarketObservationJudge',
        form_id: 'tray',
        market_summary_zh: '测试券篡改拦截。',
        peer_observations: [{
          asin: 'B0MKTSTR01',
          mandatory_facts: {
            observed_price_usd: 39.99, keepa_high_usd: null, keepa_low_usd: null, review_count: null,
            keepa_90d_trend: null, coupon_status: '40% OFF', review_curve_change: null, key_appearance_and_dims: null,
          },
          qualitative_judgment: { bucket: 'temporary_promo', include_in_primary_band: false, keep_in_observation_bar: true, reason_zh: '短期促销。' },
        }],
      }, { form_id: 'tray', peers: [{ asin: 'B0MKTSTR01', price_usd: 39.99, coupon_text: '5% OFF' }] }),
      /distorted coupon_status percentage/i,
    );
    assert.throws(
      () => parseMarketObservationResult({
        schema_version: 1,
        contract: 'MarketObservationJudge',
        form_id: 'tray',
        market_summary_zh: '测试无尺寸编造拦截。',
        peer_observations: [{
          asin: 'B0MKTDIM01',
          mandatory_facts: {
            observed_price_usd: 39.99, keepa_high_usd: null, keepa_low_usd: null, review_count: null,
            keepa_90d_trend: null, coupon_status: null, review_curve_change: null, key_appearance_and_dims: '18x12x4 in',
          },
          qualitative_judgment: { bucket: 'primary_comparable', include_in_primary_band: true, keep_in_observation_bar: false, reason_zh: '同款。' },
        }],
      }, { form_id: 'tray', peers: [{ asin: 'B0MKTDIM01', price_usd: 39.99, title: 'Reversible modular desk tray' }] }),
      /fabricated numeric dimensions/i,
    );

    // 4) M2: Enriched GET usage on manually settled row updates usage_cost_micros & effective_committed_cents BEFORE DELETE!
    const clock = () => new Date('2026-11-25T02:00:00Z');
    const ledger = new OpenAiBudgetLedger(':memory:', { nowFn: clock, testMode: true });
    try {
      ledger.reconcileLegacySummary(
        { recognized_schema: true, month_utc: '2026-11', file_sha256: 'c'.repeat(64), total_rows: 0, unresolved_count: 0, same_month_reserved_cents: 0 },
        { allowSyntheticSummaryForTests: true, enable: true, hardMonthlyLimitConfirmed: true, autoRechargeOffConfirmed: true, monthlyLimitCents: 3 },
      );
      let deleted = false;
      const client = new OpenAiClient({
        ledger, testMode: true, nowFn: clock, allowEnvKey: true, apiKeyEnvVar: 'SYNTH_M2_KEY',
        env: { SYNTH_M2_KEY: ['synth', 'm2', 'cred'].join('_') },
        fetchImpl: async (_url, opts) => {
          if (opts.method === 'POST') {
            return Response.json({ id: 'resp_m2_1', status: 'completed', model: 'gpt-6.1-terra', usage: null, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }] });
          }
          if (opts.method === 'DELETE') {
            deleted = true;
            return Response.json({ id: 'resp_m2_1', deleted: true });
          }
          if (deleted) return Response.json({ error: { message: 'Not found' } }, { status: 404 });
          return Response.json({ id: 'resp_m2_1', status: 'completed', model: 'gpt-6.1-terra', usage: { input_tokens: 25000, output_tokens: 200 }, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }] });
        },
      });
      const first = await client.createResponse({ model: 'gpt-6.1-terra', input: 'Check A', max_output_tokens: 4096 }, { logicalRequestId: 'm2-job-1', deleteAfterPersist: true });
      ledger.reconcileAttempt(first.attempt_id, { status: 'completed', note: 'Posted 2c', postedBilledCents: 2 });
      await client.recoverPendingResponse(first.attempt_id);
      const after = ledger.getAttemptById(first.attempt_id);
      assert.equal(after.usage_cost_micros, 26000);
      assert.equal(after.cleanup_status, 'deleted_verified_404');
      assert.equal(ledger.getMonthlySummary().effective_committed_cents, 3, 'ceil(26000 micros) = 3c > 2c posted');
      await assert.rejects(
        () => client.createResponse({ model: 'gpt-6.1-terra', input: 'Check B', max_output_tokens: 4096 }, { logicalRequestId: 'm2-job-2' }),
        err => err.code === 'MONTHLY_BUDGET_EXCEEDED',
      );
    } finally {
      ledger.close();
    }

    // 5) R2-2 + omitted model/reasoningEffort config inheritance in runCodexExecMarkdown!
    const marker = 'fictional_refresh_secret_987654';
    const receiptPath = join(dir, 'codex-inherit-receipt.json');
    let observedArgs = null;
    const mdRes = await runCodexExecMarkdown({
      prompt: 'Inspect synthetic fixture.',
      testMode: true,
      cwd: dir,
      receiptPath,
      mockExecutor: async ({ args, outputFilePath }) => {
        observedArgs = args;
        writeFileSync(outputFilePath, 'Clean review output.\n', 'utf8');
        return { exitCode: 0, stderr: JSON.stringify({ refresh_token: marker }) };
      },
    });
    assert.equal(observedArgs.includes('-m'), false, 'Omitting model inherits ~/.codex/config.toml without -m');
    assert.equal(observedArgs.includes('model_reasoning_effort="max"'), true, 'Omitting reasoningEffort enforces approved default max');
    assert.equal(mdRes.model, null);

    let explicitNullEffortArgs = null;
    await runCodexExecMarkdown({
      prompt: 'Inspect synthetic fixture with explicit null effort.',
      reasoningEffort: null,
      testMode: true,
      cwd: dir,
      receiptPath: join(dir, 'markdown-null-effort-receipt.json'),
      mockExecutor: async ({ args, outputFilePath }) => {
        explicitNullEffortArgs = args;
        writeFileSync(outputFilePath, 'Clean review output.\n', 'utf8');
        return { exitCode: 0 };
      },
    });
    assert.equal(explicitNullEffortArgs.some(a => a.startsWith('model_reasoning_effort=')), false, 'Explicit reasoningEffort: null inherits ~/.codex/config.toml');
    const savedRec = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(String(savedRec.stderr_scrubbed).includes(marker), false, 'JSON refresh_token in stderr_scrubbed is scrubbed');
    assert.equal(containsSecretToken(JSON.stringify({ refresh_token: marker })), true);
    assert.equal(sanitizeDiagnosticText(JSON.stringify({ refresh_token: marker })).includes(marker), false);

    // 6) M4: Historical 1-piece replay does not stamp current 2-piece spec_sha256, and stale 1-piece packet is skipped by redteam-review!
    const dbPath = join(dir, 'm4.sqlite');
    const stM4 = openSelectionStore(dbPath);
    try {
      stM4.upsertCandidateForm({
        form_id: 'form-m4-box',
        label: 'Two-piece storage box',
        buyer_task: 'Store items',
        saleable_set_composition: [{ component_id: 'box', qty_per_saleable_set: 2 }],
      });
      stM4.updateFormLifecycle('form-m4-box', 'evaluated');
      const oldCand = structuredClone(synthBatch.candidates[0]);
      oldCand.id = 'form-m4-box';
      oldCand.economics.scenarios[0].saleable_unit = 'One-piece storage box';
      replayBatchIntoStore(stM4, {
        batch: { ...structuredClone(synthBatch), profile_revision: 59, candidates: [oldCand] },
        profile: r59Profile,
      });
      const evals = stM4.getEvaluationsForForm('form-m4-box');
      const currentDbForm = stM4.getCandidateForm('form-m4-box');
      const parsedRec = JSON.parse(evals[0].receipt_json);
      assert.notEqual(parsedRec.form_spec_sha256, currentDbForm.spec_sha256, 'Historical 1-piece replay must not stamp current 2-piece spec_sha256');
    } finally {
      stM4.close();
    }

    const stalePktPath = join(dir, 'stale-pkt.json');
    const staleOutPath = join(dir, 'stale-out.json');
    writeFileSync(stalePktPath, JSON.stringify({
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-m4-stale',
      execution_policy_ref: 'local-policy-only',
      candidate: { subject_id: 'form-m4-box', intended_use: 'Store items', saleable_spec: { pcs: 1 }, unknown_fields: [] },
      subjects: [{ subject_id: 'box', spec: { pcs: 1 } }],
      criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'fit', description: 'Fit', required: true }] },
      questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['box'], criterion_ids: ['fit'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['box'], summary: '1pc listing', kind: 'fact', source_ref: 'r1', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
    }), 'utf8');
    let mockCalls = 0;
    let cliStdout = '';
    const rcM4 = await runPhase2Cli(
      ['redteam-review', '--db', dbPath, '--packet', stalePktPath, '--output', staleOutPath],
      { stdout: { write: s => { cliStdout += s; } }, stderr: { write: () => {} } },
      { codexReceiptDir: join(dir, 'receipts'), codexMockExecutor: async () => { mockCalls++; return { exitCode: 0 }; } },
    );
    assert.equal(rcM4, 0);
    assert.equal(mockCalls, 0, 'Stale 1-piece packet against 2-piece DB form is skipped without stamping current spec_sha256');
    assert.equal(JSON.parse(cliStdout).skipped_non_qualifying, true);

    // 7) Top-10 review median = 500 renders amber (not red), 501 renders red, and flat sample_pending_qualifying appears in masthead!
    const cand500 = structuredClone(synthBatch.candidates[0]);
    cand500.market = { ...(cand500.market ?? {}), top10_median_reviews: 500, top10_review_sample_count: 4 };
    const b500 = { ...structuredClone(synthBatch), profile_revision: 59, candidates: [cand500] };
    const html500 = renderReport(scoreBatch(b500, r59Profile), b500);
    assert.match(html500, /500 条（黄 · 中等门槛 · 样本 4\/10 款）/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Step 1.4: second-order counterexamples (explicit $0 placement, early-screen & package-rescue coupon tier, unbound newcomer list price, 75/25 & r58 quantiles, 429/trademark/expired rights, nursery shelving, #17 SKU & Terra override, two-GET DELETE, M4 material/SHA, r58 replay idempotence, Gate-4 omitted inheritance, and escaped-JSON/HTML PII)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-step1-second-order-'));
  try {
    const baseWin = {
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    const refTerms = { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 };
    const stdPkg = { length_in: 10, width_in: 6, height_in: 2, unit_weight_lb: 1.2 };

    // 1) Explicit placement_usd: 0 or carton_count: 5 without identical_cartons_count >= 5 stays sensitivity_only on Standard/Bulky
    assert.equal(estimateGate1A2027({
      ...baseWin, pkg: stdPkg, profile_revision: 59, price_usd: 45, fx_cny_per_usd: 7.2,
      refund_fraction: 0.04, physical_return_fraction: 0.04, collection_rate: 0.006, headhaul_usd: 1.8,
      referral_terms: refTerms, fee_category: 'Home and Kitchen', placement_split_option: 'amazon_optimized', placement_usd: 0,
    }).status, 'sensitivity_only');
    assert.equal(estimateGate1A2027({
      ...baseWin, pkg: stdPkg, profile_revision: 59, price_usd: 45, fx_cny_per_usd: 7.2,
      refund_fraction: 0.04, physical_return_fraction: 0.04, collection_rate: 0.006, headhaul_usd: 1.8,
      referral_terms: refTerms, fee_category: 'Home and Kitchen', placement_split_option: 'amazon_optimized',
      carton_count: 5, multi_destination_headhaul_verified: true,
    }).status, 'sensitivity_only');
    const badFormalCand = structuredClone(synthBatch.candidates[0]);
    const badPlaceLine = badFormalCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'placement');
    badPlaceLine.amount_usd = 0;
    badPlaceLine.fee_basis.split_option = 'amazon_optimized';
    assert.equal(scoreCandidate(badFormalCand, r59Profile).qualification.counts_toward_target, false);

    // 2) Standalone evaluateEarlyScreen rejects net-tier fulfillment under $54.99->$44.99 coupon; coupon_fee_already_in_other is not double-counted
    const esNetUnderstated = evaluateEarlyScreen({
      ...baseWin, id: 'es-net-understated', profile_revision: 59, operating_period: 'off_peak', saleable_unit: '1 unit',
      fee_context: { package_ref: 'p1', sales: baseWin.sales_window, storage: baseWin.storage_window, inbound: baseWin.inbound_window },
      pkg: stdPkg, order_units: 100, goods_cny_per_unit: 100, domestic_freight_cny_total: 180, fx_cny_per_usd: 7.2,
      first_order_promotion: false, strong_date_dependency: false,
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99,
      headhaul: { usd_per_unit: 1.8, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04,
      return_threshold: 0.081, returns_processing_usd: 0, fee_category: 'Home and Kitchen', referral_terms: refTerms,
      fulfillment_usd: 5.37165, placement_usd: 0.50,
      storage: { cubic_feet_per_unit: 120 / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      collection_rate: 0.006, other_applicable_usd: 0,
    });
    assert.equal(esNetUnderstated.gate_status, 'pending');
    const capPlain = estimateGate1A2027({
      ...baseWin, pkg: { length_in: 18, width_in: 10, height_in: 2, weight_lb: 1.2 }, profile_revision: 59,
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, promo_basis_already_net: true,
      fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006, other_applicable_usd: 0,
    });
    const capPreInc = estimateGate1A2027({
      ...baseWin, pkg: { length_in: 18, width_in: 10, height_in: 2, weight_lb: 1.2 }, profile_revision: 59,
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, promo_basis_already_net: true,
      fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006,
      other_applicable_usd: 1.17475, other_payee: 'amazon', coupon_fee_already_in_other: true,
    });
    assert.equal(capPreInc.non_domestic_cost_a_usd, capPlain.non_domestic_cost_a_usd);

    // 3 & 6) Unbound $32 list price on couponed <=90d newcomers is held to verification; "Adjustable nursery shelving for storing linens" passes Gate 0
    const stMarket = openSelectionStore(':memory:');
    try {
      stMarket.upsertCandidateForm({ form_id: 'f-blue-list', label: 'Organizer', buyer_task: 'Store items', saleable_set_composition: { pcs: 1 } });
      const g1aBlue = runGate1AForForm(stMarket, {
        form_id: 'f-blue-list',
        profile_revision: 59,
        price_band_analysis: {
          listings: [
            { asin: 'B0SYNTHY01', age_days: 45, price_usd: 31, coupon_pct: 0.10, fulfillment: 'FBA', monthly_units: 55, title: 'Organizer', keepa_price_steady: true },
            { asin: 'B0SYNTHY02', age_days: 60, price_usd: 32, coupon_pct: 0.10, fulfillment: 'FBA', monthly_units: 55, title: 'Organizer', keepa_price_steady: true },
          ],
          options: { profile_revision: 59, as_of_date: '2026-11-24' },
        },
        scenarios: [{
          ...baseWin, id: 's1', pkg: stdPkg, price_usd: 32, fx_cny_per_usd: 7.2,
          refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
          referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006,
        }],
      });
      assert.equal(g1aBlue.gate_status, 'gate1a_needs_verification');
      assert.equal(g1aBlue.proceed_to_gate1b, false);
    } finally {
      stMarket.close();
    }
    assert.equal(evaluateGate0CategoryBoundary(
      { label: 'Adjustable nursery shelving for storing linens', buyer_task: 'Store bedding on a wall shelf' },
      { profile_revision: 59 },
    ).verdict, 'allowed');

    // 4) 75/25 weightedQuantile returns $30 in r59 while preserving $51 on 80/20 in r58
    const b75R59 = analyzeMainstreamPriceBand([
      { asin: 'B0Q75A0001', title: 'Bin', price_usd: 30, monthly_units: 75, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
      { asin: 'B0Q75A0002', title: 'Bin', price_usd: 60, monthly_units: 25, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
    ], { profile_revision: 59, as_of_date: '2026-11-24' });
    assert.equal(b75R59.band.p75_usd, 30);
    assert.throws(() => analyzeMainstreamPriceBand([], { profile_revision: 58 }), /retired/i);

    // 5) Wire schema exposes applies_to_target_spec & legal_status; 429 / trademark failure blocks prescreen_completed; expired prose conflict rejected
    assert.deepEqual(
      RIGHTS_PRESCREEN_JSON_SCHEMA.properties.specific_design_rights.properties.citations.items.required,
      ['title', 'url', 'identifier', 'applies_to_target_spec', 'legal_status'],
    );
    const j429 = resolveStage1QualitativeJudgments({
      rights_prescreen: {
        specific_design_rights: { status: 'needs_verification', summary: '公开登记库返回 429，请稍后重试。', citations: [] },
        applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['CPSC'], summary: 'Checked.' },
      },
    });
    assert.equal(j429.judgments.specific_design_rights.prescreen_completed, false);
    const jTmFail = resolveStage1QualitativeJudgments({
      rights_prescreen: {
        specific_design_rights: { status: 'no_public_hit_observed', summary: 'Checked.' },
        trademark_conflicts: { status: 'needs_verification', summary: '公开登记库连接失败，未能查验。', citations: [] },
        applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['CPSC'], summary: 'Checked.' },
      },
    });
    assert.equal(jTmFail.judgments.specific_design_rights.anchor, null);
    assert.equal(jTmFail.judgments.specific_design_rights.prescreen_completed, false);
    assert.throws(() => parseRightsPreScreenResult({
      schema_version: 1,
      contract: 'RightsAndCompliancePreScreener',
      specific_design_rights: {
        status: 'proven_conflict',
        summary: '唯一命中的专利登记页标记 expired。',
        citations: [{ title: 'USPTO Patent', url: 'https://ppubs.uspto.gov/pubwebapp/', identifier: 'USD400001S', applies_to_target_spec: null, legal_status: null }],
      },
      trademark_conflicts: { status: 'no_public_hit_observed', summary: 'Checked.', citations: [] },
      applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['CPSC'], summary: 'Checked.', citations: [] },
      trade_duty_alerts: { status: 'unknown', summary: 'Deferred.', citations: [] },
      disclaimer: 'Initial public pre-screen only; this is not final legal clearance or legal advice.',
    }), /expired|proven_conflict/i);

    // 7) #17 candidate target_variant_sku takes precedence over review_judge task SKU
    const parsedTwoPc = parseReviewJudgeResult({
      schema_version: 1,
      contract: 'PainPointAndRubricJudge',
      item_id: 'feasible_light_differentiation',
      status: 'supported',
      support_level: 'strong',
      reason: 'Locking washer fix.',
      evidence_refs: ['rev-2pc'],
      counter_evidence: [],
      review_citations: [{ review_id: 'rev-2pc', sku_verified: true, variant_sku: 'TRAY-2PC-RED', excerpt: 'fastener loosens' }],
    }, {
      item_id: 'feasible_light_differentiation',
      target_variant_sku: 'TRAY-2PC-RED',
      reviews: [{ review_id: 'rev-2pc', sku_verified: true, variant_sku: 'TRAY-2PC-RED', text: 'The fastener loosens after use.' }],
    });
    const crossSkuQual = resolveStage1QualitativeJudgments({
      default_target_variant_sku: 'TRAY-1PC-RED',
      review_judge: parsedTwoPc,
    });
    assert.equal(crossSkuQual.judgments.feasible_light_differentiation.anchor, null);

    // 8) M2: Two-GET recovery (first GET usage=null, manual reconcile, second GET enriched usage) persists fresh bytes & completes DELETE + 404
    const ledgerDb = join(dir, 'two-get.sqlite');
    const ledger = new OpenAiBudgetLedger(ledgerDb, { nowFn: () => new Date('2026-11-25T02:00:00Z'), testMode: true });
    try {
      ledger.reconcileLegacySummary({
        recognized_schema: true, month_utc: '2026-11', file_sha256: 'c'.repeat(64),
        total_rows: 0, unresolved_count: 0, same_month_reserved_cents: 0,
      }, { allowSyntheticSummaryForTests: true, enable: true, hardMonthlyLimitConfirmed: true, autoRechargeOffConfirmed: true, monthlyLimitCents: 3 });
      let getCount = 0;
      let deleted = false;
      const client = new OpenAiClient({
        ledger, testMode: true, allowEnvKey: true, apiKeyEnvVar: 'SYNTH_KEY', env: { SYNTH_KEY: 'nonsecret-test-key' },
        fetchImpl: async (_url, opts) => {
          if (opts.method === 'POST') {
            return Response.json({ id: 'resp_twoget', model: 'gpt-6.1-terra', status: 'completed', usage: null, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }] });
          }
          if (opts.method === 'DELETE') {
            deleted = true;
            return Response.json({ id: 'resp_twoget', deleted: true });
          }
          if (deleted) return Response.json({ error: { message: 'not found' } }, { status: 404 });
          getCount++;
          const usage = getCount === 1 ? null : { input_tokens: 25000, output_tokens: 200 };
          return Response.json({ id: 'resp_twoget', model: 'gpt-6.1-terra', status: 'completed', usage, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }] });
        },
      });
      const first = await client.createResponse({ model: 'gpt-6.1-terra', input: 'test', max_output_tokens: 4096 }, { logicalRequestId: 'req-twoget', deleteAfterPersist: true });
      const rec1 = await client.recoverPendingResponse(first.attempt_id);
      assert.equal(rec1.status, 'pending_recovery');
      ledger.reconcileAttempt(first.attempt_id, { status: 'completed', postedBilledCents: 2, note: 'manual settle' });
      const rec2 = await client.recoverPendingResponse(first.attempt_id);
      assert.equal(rec2.response?.cleanup?.verified_404, true);
      assert.equal(ledger.getAttemptById(first.attempt_id).cleanup_status, 'deleted_verified_404');
      assert.equal(ledger.getMonthlySummary({ monthUtc: '2026-11' }).effective_committed_cents, 3);
    } finally {
      ledger.close();
    }

    // 9, 10, 11, 12) r58 replay idempotence, M4 material check, Gate-4 omitted inheritance, escaped JSON stderr scrub, & shareable HTML PII
    const stReplay58 = openSelectionStore(':memory:');
    try {
      const b59 = { ...structuredClone(synthBatch), profile_revision: 59 };
      replayBatchIntoStore(stReplay58, { batch: b59, profile: r59Profile });
      const c1 = stReplay58.db.prepare('SELECT COUNT(*) AS n FROM evaluations').get().n;
      replayBatchIntoStore(stReplay58, { batch: b59, profile: r59Profile });
      const c2 = stReplay58.db.prepare('SELECT COUNT(*) AS n FROM evaluations').get().n;
      assert.equal(c1, c2);
    } finally {
      stReplay58.close();
    }

    let gate4Args = null;
    const pktInherit = {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-inherit-01',
      execution_policy_ref: 'local-policy-only',
      candidate: { subject_id: synthBatch.candidates[0].id, intended_use: 'Store tools', saleable_spec: { pcs: 2, material: 'steel' }, unknown_fields: [] },
      subjects: [{ subject_id: 'box', spec: { pcs: 2 } }],
      criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'fit', description: 'Fit', required: true }] },
      questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['box'], criterion_ids: ['fit'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['box'], summary: 'Catalog control.', kind: 'fact', source_ref: 'r1', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
    };
    const frozenInh = freezeEvidenceReviewPacket(pktInherit);
    const recDirInh = join(dir, 'inh-receipts');
    const g4Out = await runOptionalGate4EvidenceReview(pktInherit, {
      enabled: true,
      testMode: true,
      receiptDir: recDirInh,
      candidateId: synthBatch.candidates[0].id,
      candidateQualification: { counts_toward_target: true },
      mockExecutor: async ({ args, outputFilePath }) => {
        gate4Args = args;
        writeFileSync(outputFilePath, JSON.stringify({
          schema_version: frozenInh.schema_version,
          review_id: frozenInh.review_id,
          packet_sha256: frozenInh.packet_sha256,
          subjects: [{ subject_id: 'box', disposition: 'included', criterion_ids: ['fit'], evidence_ids: ['e1'], reason: 'Registrant Name: Lumen Quillfield; REGISTRANT Zinnia Testwood; Registrant Mossvale, Elowen.' }],
          answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'Ship via 84 FIXTURE-GLEN RD; phone 202.555.0148.' }],
          contradictions: [],
          gaps: [],
          conclusion: 'Verified https://example.org/catalog/facts.',
        }), 'utf8');
        return { exitCode: 0 };
      },
    });
    assert.equal(gate4Args.includes('-m'), false);
    assert.equal(gate4Args.includes('model_reasoning_effort="max"'), true);
    assert.equal(g4Out.model, null);
    assert.equal(verifySavedCodexReceipt(g4Out, { receiptStoreDir: recDirInh, allowTestDouble: true }).model, null);

    const candShare = structuredClone(synthBatch.candidates[0]);
    attachCandidateEvidenceReview(candShare, g4Out, pktInherit, { receiptStoreDir: recDirInh, allowTestDoubleReceipt: true });
    candShare.review_notes = [{ kind: 'CALIBRATION_NOTE', note: 'Contact: Taylor Carter; phone 415.555.0123.' }];
    const shareBatch = { ...structuredClone(synthBatch), profile_revision: 59, candidates: [candShare] };
    const shareHtml = renderReport(scoreBatch(shareBatch, r59Profile), shareBatch, { receiptStoreDir: recDirInh, allowTestDoubleReceipts: true });
    assert.match(shareHtml, /已复核/);
    assert.equal(shareHtml.includes('https://example.org/catalog/facts'), true);
    for (const leaked of ['Lumen Quillfield', 'Zinnia Testwood', 'Elowen', '84 FIXTURE-GLEN RD', '202.555.0148', 'Taylor Carter', '415.555.0123']) {
      assert.equal(shareHtml.includes(leaked), false, `Shareable HTML must redact "${leaked}"`);
    }

    const nestedErrLog = JSON.stringify({ level: 'warn', message: 'Upstream reply: ' + JSON.stringify({ refresh_token: 'fixture_opaque_nested_token_9911' }) });
    assert.equal(containsSecretToken(nestedErrLog), true);
    assert.equal(sanitizeDiagnosticText(nestedErrLog).includes('fixture_opaque_nested_token_9911'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Step 1.5: Round-2 closure regressions — shared line-level pkg resolution, mixed active+expired rights & unknown trademark, Gate 1A Keepa steady requirement, component swap & spec alias guard, r57 Nov-19 fee snapshot parity, and E.164 phone / Basic / Cookie scrubbing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-step15-'));
  try {
    // 1) Shared pkg across lines: $0 placement when pkg is only on fulfillment, and net-price FBA tier when pkg is only on placement!
    const pkgStd = { length_in: 10, width_in: 6, height_in: 2, unit_weight_lb: 1.2 };
    const makeCrossPkgCand = ({ pkgLoc, plAmt, fulAmt }) => {
      const c = structuredClone(synthBatch.candidates[0]);
      c.screening.reference_price_usd.value = 44.99;
      const sc = structuredClone(c.economics.scenarios[0]);
      delete sc.margin;
      delete sc.contribution_usd;
      const l = sc.cost_ledger;
      Object.assign(l, {
        list_price_usd: 54.99,
        ongoing_coupon_usd: 10,
        price_usd: 44.99,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fx_cny_per_usd: 7.2,
        fee_category: 'Home and Kitchen',
        fee_context: { ...l.fee_context, sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW, storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, inbound: FBA_2027_DEFAULT_INBOUND_WINDOW },
      });
      for (const ln of l.lines) {
        if (ln.fee_basis) {
          ln.fee_basis.effective_from = '2027-01-15';
          ln.fee_basis.effective_through = '2028-01-14';
        }
      }
      l.lines.find(x => x.id === 'procurement').amount_usd = 100 / 7.2;
      l.lines.find(x => x.id === 'headhaul').amount_usd = 1.8;
      l.lines.find(x => x.id === 'referral').amount_usd = 44.99 * 0.15;
      l.lines.find(x => x.id === 'fulfillment').amount_usd = fulAmt;
      l.lines.find(x => x.id === 'placement').amount_usd = plAmt;
      const stLn = l.lines.find(x => x.id === 'storage');
      stLn.amount_usd = Number((((120 / 1728) * 0.78 * 45) / 30).toFixed(6));
      Object.assign(stLn.fee_basis, { effective_from: '2027-02-01', effective_through: '2027-09-30', cubic_feet_per_unit: 120 / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 });
      const retLn = l.lines.find(x => x.id === 'returns_processing');
      retLn.amount_usd = 0;
      retLn.return_threshold = 0.081;
      retLn.fee_basis.effective_from = '2027-02-01';
      const othLn = l.lines.find(x => x.id === 'other_applicable');
      othLn.amount_usd = Number((0.05 + 44.99 * 0.025).toFixed(6));
      othLn.fee_basis = { status: 'published', version: 'SYNTHETIC-2027-annual', marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', effective_from: '2027-01-15', effective_through: '2028-01-14', evidence: ['synthetic-evidence'] };
      l.lines.find(x => x.id === 'lines_missing');
      const payout = 44.99 * 0.96 - (44.99 * 0.15 * 0.96 + 0.04 * Math.min(5, 44.99 * 0.15 * 0.2)) - (fulAmt + plAmt + stLn.amount_usd + othLn.amount_usd);
      l.lines.find(x => x.id === 'collection').amount_usd = Number((payout * 0.006).toFixed(6));
      l.lines.find(x => x.id === pkgLoc).fee_basis.pkg = { ...pkgStd };
      c.economics = buildPairedSeasonalOperatingPeriods({
        profile_revision: 59,
        saleable_unit: sc.saleable_unit,
        off_peak_scenarios: [sc],
        cubic_feet_per_unit: 120 / 1728,
        average_inventory_days: 45,
        size_tier: 'large_standard',
      });
      return scoreCandidate(c, r59Profile);
    };
    const resZeroPlace = makeCrossPkgCand({ pkgLoc: 'fulfillment', plAmt: 0, fulAmt: 5.95125 });
    assert.equal(resZeroPlace.qualification.counts_toward_target, false, 'Unverified $0 placement blocked even when pkg lives on fulfillment line');
    const resNetFul = makeCrossPkgCand({ pkgLoc: 'placement', plAmt: 0.5, fulAmt: 5.37165 });
    assert.equal(resNetFul.qualification.counts_toward_target, false, 'Post-coupon net FBA tier blocked even when pkg lives on placement line');

    // 2) Mixed active + expired trademark/patent citations & status:'unknown' trademark
    const baseCit = { title: 'Reg', url: 'https://example.org/reg', identifier: 'id-0', applies_to_target_spec: null, legal_status: null };
    const actCit = { ...baseCit, identifier: 'id-act', applies_to_target_spec: true, legal_status: 'active' };
    const expCit = { ...baseCit, identifier: 'id-exp', applies_to_target_spec: false, legal_status: 'expired' };
    const cleanSec = { status: 'no_public_hit_observed', summary: 'Searched.', citations: [baseCit] };
    const mixedSec = { status: 'proven_conflict', summary: 'An earlier entry expired. The other registration is active and matches target.', citations: [actCit, expCit] };
    const parsedMixedTm = parseRightsPreScreenResult({
      schema_version: 1, contract: 'RightsAndCompliancePreScreener',
      specific_design_rights: cleanSec, trademark_conflicts: mixedSec,
      applicable_public_requirements: { ...cleanSec, frameworks_checked: ['Other'] },
      trade_duty_alerts: { status: 'unknown', summary: 'N/A', citations: [] },
      disclaimer: 'Not legal advice.',
    });
    const jMixedTm = resolveStage1QualitativeJudgments({ evidence: ['ev-1'], rights_prescreen: parsedMixedTm });
    assert.equal(jMixedTm.judgments.specific_design_rights.anchor, 0);
    assert.equal(jMixedTm.judgments.specific_design_rights.proven_conflict, true);

    const parsedUnknownTm = parseRightsPreScreenResult({
      schema_version: 1, contract: 'RightsAndCompliancePreScreener',
      specific_design_rights: cleanSec,
      trademark_conflicts: { status: 'unknown', summary: '本次尚未检索商标登记记录，商标状态未知。', citations: [] },
      applicable_public_requirements: { ...cleanSec, frameworks_checked: ['Other'] },
      trade_duty_alerts: { status: 'unknown', summary: 'N/A', citations: [] },
      disclaimer: 'Not legal advice.',
    });
    const jUnknownTm = resolveStage1QualitativeJudgments({ evidence: ['ev-1'], rights_prescreen: parsedUnknownTm });
    assert.equal(jUnknownTm.judgments.specific_design_rights.anchor, null);
    assert.equal(jUnknownTm.judgments.specific_design_rights.prescreen_completed, false);

    // 3) H6: Gate 1A requires Keepa steady-price evidence on >=365d veterans and 91-364d growth supplements
    const stKeepa = openSelectionStore(':memory:');
    try {
      stKeepa.upsertCandidateForm({ form_id: 'f-keepa-req', label: 'Organizer', buyer_task: 'Hold items', saleable_set_composition: { qty: 1 } });
      const g1aMissingVet = runGate1AForForm(stKeepa, {
        form_id: 'f-keepa-req',
        profile_revision: 59,
        price_band_analysis: {
          options: { as_of_date: '2026-11-24' },
          listings: [
            { asin: 'B0SYNKV001', age_days: 415, price_usd: 45, fulfillment: 'FBA', monthly_units: 60, title: 'Household organizer' },
            { asin: 'B0SYNKV002', age_days: 455, price_usd: 46, fulfillment: 'FBA', monthly_units: 55, title: 'Household organizer' },
          ],
        },
        scenarios: [{ id: 's1', asin: 'B0SYNKV001', age_days: 415, price_usd: 45, pkg: pkgStd, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
      });
      assert.equal(g1aMissingVet.gate_status, 'gate1a_needs_verification');
      assert.equal(g1aMissingVet.proceed_to_gate1b, false);

      const g1aMissingGrowth = runGate1AForForm(stKeepa, {
        form_id: 'f-keepa-req',
        profile_revision: 59,
        price_band_analysis: {
          options: { as_of_date: '2026-11-24' },
          listings: [
            { asin: 'B0SYNKV001', age_days: 415, price_usd: 28, fulfillment: 'FBA', monthly_units: 60, title: 'Household organizer', keepa_price_steady: true },
            { asin: 'B0SYNKG002', age_days: 220, price_usd: 46, fulfillment: 'FBA', monthly_units: 55, title: 'Household organizer' },
          ],
        },
        scenarios: [{ id: 's2', asin: 'B0SYNKG002', age_days: 220, price_usd: 46, pkg: pkgStd, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
      });
      assert.equal(g1aMissingGrowth.gate_status, 'gate1a_needs_verification');
      assert.equal(g1aMissingGrowth.proceed_to_gate1b, false);
    } finally {
      stKeepa.close();
    }

    // 4) Component composition mismatch & saleable_specification / string spec mismatch in doesReviewPacketMatchDbFormSpec
    const stComp = openSelectionStore(':memory:');
    try {
      const currForm = stComp.upsertCandidateForm({
        form_id: 'f-comp-check',
        label: 'Two-piece organizer',
        buyer_task: 'Store tools',
        grade_or_material: 'steel',
        saleable_set_composition: { components: [{ component_id: 'box', qty_per_saleable_set: 1 }, { component_id: 'lid', qty_per_saleable_set: 1 }] },
      }).form;
      assert.equal(doesReviewPacketMatchDbFormSpec({
        candidate: { saleable_spec: { components: [{ component_id: 'box', qty_per_saleable_set: 1 }, { component_id: 'divider', qty_per_saleable_set: 1 }], material: 'steel' } },
      }, currForm).matches, false);
      assert.equal(doesReviewPacketMatchDbFormSpec({
        candidate: { saleable_specification: { pcs: 1, material: 'steel' } },
      }, currForm).matches, false);
      assert.equal(doesReviewPacketMatchDbFormSpec({
        candidate: { saleable_spec: 'One-piece steel organizer' },
      }, currForm).matches, false);

      // M5: Pre-upgrade legacy amz_spapi_sp_api_execute row in api_request_ledger is reused by sp_api_execute
      const legacyParams = { method: 'GET', path: '/catalog/2022-04-01/items/B0SYNTH001' };
      const legacyLk = sha256Hex(JSON.stringify({
        account_scope: 'acct-synth',
        canonical_tool: 'amz_spapi_sp_api_execute',
        marketplace: 'US',
        mode: 'fresh_observation',
        normalized_params: { method: 'GET', path: '/catalog/2022-04-01/items/B0SYNTH001' },
        observation_cutoff_date: '2026-11-24',
        page_or_cursor: '',
        provider: 'other',
        tool_version: 'v1',
      }));
      stComp.db.prepare(`
        INSERT INTO api_request_ledger (
          attempt_id, logical_request_key, semantic_lock_key, account_scope,
          provider, tool_name, canonical_tool, tool_version, marketplace, mode,
          observation_cutoff_date, page_or_cursor, normalized_params_json,
          status, repeat_submission_allowed, billing_status, response_payload_json,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, 'acct-synth', 'other', 'amz_spapi_sp_api_execute', 'amz_spapi_sp_api_execute', 'v1', 'US', 'fresh_observation', '2026-11-24', '', ?, 'completed', 1, 'known', ?, '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')
      `).run('att-legacy-sp', legacyLk, sha256Hex('sem-legacy'), JSON.stringify(legacyParams), JSON.stringify({ asin: 'B0SYNTH001' }));
      const newLookup = stComp.reserveRequestAttempt({
        account_scope: 'acct-synth',
        provider: 'sp_api',
        tool_name: 'sp_api_execute',
        observation_cutoff_date: '2026-11-24',
        params: legacyParams,
      });
      assert.equal(newLookup.reused, true);
    } finally {
      stComp.close();
    }

    // 5 & 6) E.164 phone + reviewer name in review_notes + Basic/Cookie diagnostic scrubbing
    const b64Basic = Buffer.from('synth-user:synth-pass-001').toString('base64');
    assert.equal(containsSecretToken(`Authorization: Basic ${b64Basic}`), true);
    assert.equal(sanitizeDiagnosticText(`Authorization: Basic ${b64Basic}`).includes(b64Basic), false);
    assert.equal(containsSecretToken('Cookie: theme=compact; session=synth_session_val_0099'), true);
    assert.equal(sanitizeDiagnosticText('Cookie: theme=compact; session=synth_session_val_0099').includes('synth_session_val_0099'), false);

    const candPii2 = structuredClone(synthBatch.candidates[0]);
    candPii2.review_notes = [{ kind: 'CALIBRATION_NOTE', reviewer: 'Ember Examplewood', observed_at: '2026-11-24', note: 'Phone: +12025550147.' }];
    const bPii2 = { ...structuredClone(synthBatch), profile_revision: 59, candidates: [candPii2] };
    const htmlPii2 = renderReport(scoreBatch(bPii2, r59Profile), bPii2);
    assert.equal(htmlPii2.includes('+12025550147'), false);
    assert.equal(htmlPii2.includes('Ember Examplewood'), false);

    // Step 1.6: Round-3 closure — shared economics.packages $0 placement, incomplete public scope vs null-citation conflict, saved price-band Keepa check, saleable_unit component stem & "Set of three", and "Claude Examplewood" / quoted Cookie
    const cSharedPkg = structuredClone(synthBatch.candidates[0]);
    cSharedPkg.screening.reference_price_usd.value = 44.99;
    const scSp = structuredClone(cSharedPkg.economics.scenarios[0]);
    delete scSp.margin;
    delete scSp.contribution_usd;
    const lSp = scSp.cost_ledger;
    Object.assign(lSp, {
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, refund_fraction: 0.04, physical_return_fraction: 0.04,
      fx_cny_per_usd: 7.2, fee_category: 'Home and Kitchen',
      fee_context: { ...lSp.fee_context, sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW, storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, inbound: FBA_2027_DEFAULT_INBOUND_WINDOW },
    });
    for (const ln of lSp.lines) if (ln.fee_basis) { ln.fee_basis.effective_from = '2027-01-15'; ln.fee_basis.effective_through = '2028-01-14'; }
    lSp.lines.find(x => x.id === 'procurement').amount_usd = 100 / 7.2;
    lSp.lines.find(x => x.id === 'headhaul').amount_usd = 1.8;
    lSp.lines.find(x => x.id === 'referral').amount_usd = 44.99 * 0.15;
    lSp.lines.find(x => x.id === 'fulfillment').amount_usd = 5.95125;
    lSp.lines.find(x => x.id === 'placement').amount_usd = 0;
    const stSp = lSp.lines.find(x => x.id === 'storage');
    stSp.amount_usd = Number((((120 / 1728) * 0.78 * 45) / 30).toFixed(6));
    Object.assign(stSp.fee_basis, { effective_from: '2027-02-01', effective_through: '2027-09-30', cubic_feet_per_unit: 120 / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 });
    const retSp = lSp.lines.find(x => x.id === 'returns_processing');
    retSp.amount_usd = 0; retSp.return_threshold = 0.081; retSp.fee_basis.effective_from = '2027-02-01';
    const othSp = lSp.lines.find(x => x.id === 'other_applicable');
    othSp.amount_usd = Number((0.05 + 44.99 * 0.025).toFixed(6));
    othSp.fee_basis = { status: 'published', version: 'SYNTHETIC-2027-annual', marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', effective_from: '2027-01-15', effective_through: '2028-01-14', evidence: ['synthetic-evidence'] };
    cSharedPkg.economics = {
      ...buildPairedSeasonalOperatingPeriods({ profile_revision: 59, saleable_unit: scSp.saleable_unit, off_peak_scenarios: [scSp], cubic_feet_per_unit: 120 / 1728, average_inventory_days: 45, size_tier: 'large_standard' }),
      packages: [{ id: 'synthetic-pack', ...pkgStd }],
    };
    assert.equal(scoreCandidate(cSharedPkg, r59Profile).qualification.counts_toward_target, false, 'Shared economics.packages registry blocks unverified $0 placement');

    assert.throws(
      () => parseRightsPreScreenResult({
        schema_version: 1, contract: 'RightsAndCompliancePreScreener',
        specific_design_rights: cleanSec,
        trademark_conflicts: { status: 'proven_conflict', summary: 'A similar mark appears in the registration index. Goods coverage and current legal status require a further register search.', citations: [baseCit] },
        applicable_public_requirements: { ...cleanSec, frameworks_checked: ['Other'] },
        trade_duty_alerts: { status: 'unknown', summary: 'N/A', citations: [] },
        disclaimer: 'Not legal advice.',
      }),
      /lack positive active target-spec confirmation/i,
    );
    const jScopeIncomplete = resolveStage1QualitativeJudgments({
      evidence: ['ev-1'],
      rights_prescreen: parseRightsPreScreenResult({
        schema_version: 1, contract: 'RightsAndCompliancePreScreener',
        specific_design_rights: cleanSec,
        trademark_conflicts: { status: 'needs_verification', summary: '只查到近似商标的登记索引。公开注册商品服务清单未返回，是否覆盖本款须补查官方登记页。', citations: [{ ...actCit, applies_to_target_spec: null }] },
        applicable_public_requirements: { ...cleanSec, frameworks_checked: ['Other'] },
        trade_duty_alerts: { status: 'unknown', summary: 'N/A', citations: [] },
        disclaimer: 'Not legal advice.',
      }),
    });
    assert.equal(jScopeIncomplete.judgments.specific_design_rights.prescreen_completed, false);

    const savedBandNoKeepa = analyzeMainstreamPriceBand([
      { asin: 'B0SYNKV011', age_days: 415, price_usd: 45, fulfillment: 'FBA', monthly_units: 60, title: 'Household organizer' },
      { asin: 'B0SYNKV012', age_days: 455, price_usd: 46, fulfillment: 'FBA', monthly_units: 55, title: 'Household organizer' },
    ], { profile_revision: 59, as_of_date: '2026-11-24' });
    const stSavedBand = openSelectionStore(':memory:');
    try {
      stSavedBand.upsertCandidateForm({ form_id: 'f-saved-band', label: 'Two-piece organizer', buyer_task: 'Hold items', grade_or_material: 'steel', saleable_set_composition: { components: [{ component_id: 'box', qty_per_saleable_set: 1 }, { component_id: 'lid', qty_per_saleable_set: 1 }] } });
      const g1aFromSaved = runGate1AForForm(stSavedBand, {
        form_id: 'f-saved-band', profile_revision: 59, price_band_analysis: savedBandNoKeepa,
        scenarios: [{ id: 's1', asin: 'B0SYNKV011', age_days: 415, price_usd: 45, pkg: pkgStd, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
      });
      assert.equal(g1aFromSaved.gate_status, 'gate1a_needs_verification');
      const formRowSaved = stSavedBand.getCandidateForm('f-saved-band');
      assert.equal(doesReviewPacketMatchDbFormSpec({ candidate: { saleable_spec: { pcs: 2, material: 'steel', saleable_unit: 'Two-piece steel set: one organizer box and one divider' } } }, formRowSaved).matches, false);
      assert.equal(doesReviewPacketMatchDbFormSpec({ candidate: { saleable_spec: { pcs: 2, material: 'steel', saleable_unit: 'Two-piece steel set: one organizer box and one lid' } } }, formRowSaved).matches, true);
      assert.equal(doesReviewPacketMatchDbFormSpec({ candidate: { saleable_specification: 'Set of three individual steel organizer boxes and lids' } }, formRowSaved).matches, false);
    } finally {
      stSavedBand.close();
    }

    candPii2.review_notes = [{ kind: 'CALIBRATION_NOTE', reviewer: 'Claude Examplewood', observed_at: '2026-11-24', note: 'Checked.' }];
    const htmlClaude = renderReport(scoreBatch(bPii2, r59Profile), bPii2);
    assert.equal(htmlClaude.includes('Claude Examplewood'), false);
    assert.equal(sanitizeDiagnosticText('Cookie: theme="compact"; __Host-app_session=synth_quoted_cookie_7788').includes('synth_quoted_cookie_7788'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
