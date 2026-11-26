import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildKeepaPeerFactsForMarketJudge,
  extractSpApiFinalistCalibration,
  parseSellerSpriteKeepaPayload,
} from '../src/adapters/index.mjs';
import { validateSourcingVerifier1688Output } from '../src/contracts.mjs';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';
import {
  computeOrderPlan,
  estimateGate1A2027,
} from '../src/fba-calculator.mjs';
import {
  OpenAiBudgetError,
  inspectLegacyAutopilotBudget,
  reconcileLegacyBudgetIntoStore,
} from '../src/openai/budget-ledger.mjs';
import { runCodexExecMarkdown } from '../src/openai/codex-runner.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { runFastProfitHealthcheck2027, runGate1AForForm, runGate1BForForm, runPhase2Batch } from '../src/pipeline.mjs';
import { analyzeMainstreamPriceBand } from '../src/price-band.mjs';
import { ingestTrialSpecification, mergeKeepaPayloadsIntoPeerListings } from '../src/raw-ingest.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { openSelectionStore } from '../src/store.mjs';

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

const VALID_UI = Object.freeze({
  logged_in: true,
  viewport_width_px: 1440,
  selected_sku_row_visible: true,
  settlement_bar_visible: true,
  applied_quantity_confirmed: true,
});

test('Astra Sign-Off #1: 14-day newcomer ($40 list, $13.01 coupon -> $26.99 net) cannot smuggle $40 pre-coupon list price as selling price', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-reg1-'));
  try {
    const rawReceiptPath = join(dir, 'ss-newcomer-coupon.json');
    writeFileSync(rawReceiptPath, JSON.stringify({
      code: 'OK',
      items: [
        {
          asin: 'B0SYNNEW14',
          availableDate: '2026-11-10',
          price: 40.00,
          list_price_usd: 40.00,
          coupon: '$13.01',
          monthlySales: 85,
          fulfillment: 'FBA',
          categoryId: '1055398',
        },
      ],
    }, null, 2));

    const makeSpec = (claimedPrice, withHonestCoupon = false) => {
      const cand = structuredClone(synthBatch.candidates[0]);
      cand.id = 'form-synth-new14';
      cand.newcomer_cohort = {
        observation_date: '2026-11-24',
        relevant_bsr_node: 'Home & Kitchen (1055398)',
        members: [],
        market_reference: { families: [] },
      };
      cand.screening.reference_price_usd = {
        value: claimedPrice,
        matched_spec: true,
        target_variant_asin: 'B0SYNNEW14',
        evidence: [cand.evidence[0].id],
      };
      const sc = cand.economics.scenarios[0];
      sc.price_anchor = { value: claimedPrice, target_variant_asin: 'B0SYNNEW14' };
      sc.cost_ledger.price_usd = claimedPrice;
      if (withHonestCoupon) {
        sc.cost_ledger.list_price_usd = 40.00;
        sc.cost_ledger.net_effective_price_usd = 26.99;
        sc.cost_ledger.ongoing_coupon_usd = 13.01;
        sc.cost_ledger.promo_basis_already_net = true;
      }
      return {
        profile_revision: 59,
        as_of_date: '2026-11-24',
        raw_receipt_files: ['ss-newcomer-coupon.json'],
        candidates: [{
          raw_receipt_files: ['ss-newcomer-coupon.json'],
          verified_asins: extractExtraSyntheticAsins(cand),
          candidate: cand,
        }],
      };
    };

    // 1) Claiming $40 pre-coupon list price without independent regular-price evidence MUST fail provenance!
    assert.throws(
      () => ingestTrialSpecification(makeSpec(40.00, false), r59Profile, { baseDir: dir }),
      /pre-coupon list price.*\$26\.99/i,
    );

    // 2) Honestly declaring $26.99 net ($40.00 list - $13.01 coupon) ingests cleanly AND is excluded (< $29.99)!
    const honestOut = ingestTrialSpecification(makeSpec(26.99, true), r59Profile, { baseDir: dir });
    assert.equal(honestOut.scored.candidates[0].qualification.counts_toward_target, false);
    assert.equal(honestOut.scored.summary.qualifying, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function extractExtraSyntheticAsins(cand) {
  const s = JSON.stringify(cand);
  return [...new Set([...s.matchAll(/\bB0[A-Z0-9]{8}\b/g)].map(m => m[0]).filter(a => a !== 'B0SYNNEW14'))];
}

test('Astra Sign-Off #3: standalone Keepa receipts merge by ASIN; undated compact curve stays unsteady in Gate 1A while dated 90d flat $59 passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-reg3-'));
  try {
    const peer400d = {
      asin: 'B0SYNV400D',
      title: 'Synthetic Desktop Organizer',
      availableDate: '2025-09-01',
      price: 59.00,
      monthlySales: 120,
      fulfillment: 'FBA',
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 2.0 },
    };

    // Case A: Undated >=90-sample compact Keepa receipt -> keepa_90d_steady = false -> 400d veteran MUST NOT get steady pass!
    const undatedKeepaPath = join(dir, 'keepa-undated.json');
    writeFileSync(undatedKeepaPath, JSON.stringify({
      asin: 'B0SYNV400D',
      series: {
        price: [...Array(100).fill(59.00), ...Array(4).fill(49.00)],
      },
    }, null, 2));

    const pbUndatedIn = join(dir, 'pb-undated-in.json');
    writeFileSync(pbUndatedIn, JSON.stringify({
      options: { as_of_date: '2026-11-24' },
      raw_receipt_files: ['keepa-undated.json'],
      listings: [peer400d],
    }, null, 2));
    const pbUndatedRes = await runCliMem(['price-band', '--input', pbUndatedIn]);
    assert.equal(pbUndatedRes.code, 0, pbUndatedRes.stderr);
    const parsedPbUndated = JSON.parse(pbUndatedRes.stdout);
    assert.equal(parsedPbUndated.analysis.mature_regular_band, null, 'Undated unsteady Keepa curve must not anchor mature_regular_band');

    // Manual merge with keepa_90d_steady: false + keepa_90d_median_usd: 59 must ALSO stay unsteady!
    const manualBand = analyzeMainstreamPriceBand([
      { ...peer400d, keepa_90d_steady: false, keepa_90d_median_usd: 59.00 },
    ], { as_of_date: '2026-11-24' });
    assert.equal(manualBand.mature_regular_band, null);

    // Case B: Dated 360-day Keepa receipt (270d @ $39 + 90d @ $59) -> 90d median = $59, steady = true -> Gate 1A passes!
    const ts360 = Array.from({ length: 360 }, (_, i) => new Date(Date.UTC(2025, 11, 30 + i)).toISOString().slice(0, 10));
    const datedKeepaPath = join(dir, 'keepa-dated360.json');
    writeFileSync(datedKeepaPath, JSON.stringify({
      asin: 'B0SYNV400D',
      keepa_trend: {
        ts: ts360,
        series: {
          price: [...Array(270).fill(39.00), ...Array(90).fill(59.00)],
        },
      },
    }, null, 2));

    const dbPath = join(dir, 'g1a-keepa.sqlite');
    await runCliMem(['init', '--db', dbPath]);
    const g1aSpecPath = join(dir, 'g1a-keepa-spec.json');
    writeFileSync(g1aSpecPath, JSON.stringify({
      as_of_date: ts360[ts360.length - 1],
      form: {
        form_id: 'form-keepa-standalone',
        label: 'Keepa Standalone Peer Test',
        buyer_task: 'Organize desktop items',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      },
      peer_listings: [peer400d],
      raw_receipt_files: ['keepa-dated360.json'],
      scenarios: [{
        id: 'sc-59',
        target_variant_asin: 'B0SYNV400D',
        price_usd: 59.00,
        pkg: peer400d.pkg,
        fx_cny_per_usd: 7.20,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        headhaul_usd: 2.10,
        collection_rate: 0.006,
      }],
    }, null, 2));
    const g1aDatedRes = await runCliMem(['gate1a', '--db', dbPath, '--input', g1aSpecPath]);
    assert.equal(g1aDatedRes.code, 0, g1aDatedRes.stderr);
    const parsedG1aDated = JSON.parse(g1aDatedRes.stdout);
    assert.equal(parsedG1aDated.result.gate_status, 'gate1a_passed');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Astra Sign-Off #4 & #5: structured A4 headhaul in Gate 1A ($0.9166666667/set), no $2 guess on missing headhaul, and $0 placement override check', () => {
  const pkg = { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 };
  const base = {
    pkg,
    price_usd: 45.00,
    fx_cny_per_usd: 7.20,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
    collection_rate: 0.006,
  };
  // 100 units * 0.60 kg = 60 kg (>= 50 kg), rate 10 CNY/kg + bond 1 CNY/kg = 660 CNY / 100 / 7.20 = $0.9166666667/unit
  const estStruct = estimateGate1A2027({
    ...base,
    order_units: 100,
    headhaul: {
      rate_cny_per_kg: 10.0,
      bond_cny_per_kg: 1.0,
      chargeable_kg_per_unit: 0.60,
    },
  });
  const estScalar = estimateGate1A2027({
    ...base,
    headhaul_usd: 660 / 100 / 7.20,
  });
  assert.equal(estStruct.status, 'verified');
  assert.equal(estStruct.landed_domestic_cap_usd, estScalar.landed_domestic_cap_usd);
  assert.ok(Math.abs(estStruct.components.headhaul.amount_usd - 0.9166666667) < 1e-9);

  // Missing headhaul stays needs_calculator_verification (never guesses $2.00)
  const estMissingHh = estimateGate1A2027(base);
  assert.equal(estMissingHh.status, 'needs_calculator_verification');

  // Standard package calculator_verified_override with placement_usd = 0 WITHOUT 5-carton proof -> sensitivity_only!
  const baseOverride = {
    verified_by: 'sp_api_and_schedule',
    observed_at: '2026-11-24',
    evidence_ref: 'synth-override-ref',
    verified_price_band: '10_to_50',
    effective_from: '2027-02-01',
    effective_through: '2027-10-14',
    pkg,
    fulfillment_usd: 6.50,
    storage_per_unit_usd: 0.25,
    placement_usd: 0,
    returns_processing_usd: 0,
  };
  const estZeroOverrideUnproven = estimateGate1A2027({
    ...base,
    headhaul_usd: 1.50,
    calculator_verified_override: baseOverride,
  });
  assert.equal(estZeroOverrideUnproven.status, 'sensitivity_only');

  const estZeroOverrideProven = estimateGate1A2027({
    ...base,
    headhaul_usd: 1.50,
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    calculator_verified_override: baseOverride,
  });
  assert.equal(estZeroOverrideProven.status, 'verified');

  // Oversize package keeps official $0 placement exemption without requiring 5-carton split proof
  const oversizePkg = { length_in: 62, width_in: 10, height_in: 6, unit_weight_lb: 35 };
  const estOversizeZeroOverride = estimateGate1A2027({
    ...base,
    pkg: oversizePkg,
    price_usd: 199.99,
    headhaul_usd: 14.00,
    calculator_verified_override: {
      ...baseOverride,
      verified_price_band: 'over_50',
      size_tier: 'small_oversize',
      pkg: oversizePkg,
      fulfillment_usd: 45.00,
      storage_per_unit_usd: 4.00,
      placement_usd: 0,
    },
  });
  assert.equal(estOversizeZeroOverride.status, 'verified');
});

test('Astra Sign-Off #6 & #7: SP-API $36+$4 buyer shipping referral denominator (15%) and r59 17x13=221 order plan + ¥20.20 per-complete-set math', () => {
  // 1) SP-API ListingPrice $36 + Shipping $4 = $40, ReferralFee $6 -> 15% (not 16.6667%!)
  const spCal = extractSpApiFinalistCalibration({
    asin: 'B0SYNSHIP4',
    price_usd: 40.00,
    feesEstimateRaw: {
      FeesEstimateResult: {
        Status: 'Success',
        FeesEstimateIdentifier: {
          MarketplaceId: 'ATVPDKIKX0DER',
          IdType: 'ASIN',
          IdValue: 'B0SYNSHIP4',
          IsAmazonFulfilled: true,
          PriceToEstimateFees: {
            ListingPrice: { CurrencyCode: 'USD', Amount: 36.00 },
            Shipping: { CurrencyCode: 'USD', Amount: 4.00 },
          },
        },
        FeesEstimate: {
          TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 12.15 },
          FeeDetailList: [
            { FeeType: 'ReferralFee', FinalFee: { CurrencyCode: 'USD', Amount: 6.00 } },
            { FeeType: 'FBAFees', FinalFee: { CurrencyCode: 'USD', Amount: 6.15 } },
          ],
        },
      },
    },
  });
  assert.equal(spCal.fee_calibration_status, 'verified');
  assert.equal(spCal.fee_calibration.listing_price_usd, 36.00);
  assert.equal(spCal.fee_calibration.shipping_usd, 4.00);
  assert.equal(spCal.fee_calibration.total_price_usd, 40.00);
  assert.equal(spCal.fee_calibration.referral_fraction, 0.15);

  // 2) 1688 2-SKU kit with pack_multiple 17 & 13:
  //    - allow_remainder: false defaults to r59 -> 221/221 exact (rejecting 102/104!)
  //    - allow_remainder: true -> 102/104 (¥2,060 across 102 complete sets -> ¥20.1960784314/set, NEVER ¥2.02!)
  const baseTwoSkuLines = [
    { component_id: 'part-a', offer_id: 'off-1', sku_id: 's-17', pack_multiple: 17, qty_per_saleable_set: 1, moq_qty: 1, unit_price_cny: 10, regular_goods_promo_false: true },
    { component_id: 'part-b', offer_id: 'off-1', sku_id: 's-13', pack_multiple: 13, qty_per_saleable_set: 1, moq_qty: 1, unit_price_cny: 10, regular_goods_promo_false: true },
  ];
  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    status: 'verified',
    observed_at: '2026-11-24',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'synth-readback-102',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    allow_remainder: false,
    sku_lines: [
      { ...baseTwoSkuLines[0], ordered_qty: 102 },
      { ...baseTwoSkuLines[1], ordered_qty: 104 },
    ],
    goods_cny_total: 2060,
    domestic_freight_cny_total: 100,
  }), /221/);

  const verified221 = validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    status: 'verified',
    observed_at: '2026-11-24',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'synth-readback-221',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    allow_remainder: false,
    sku_lines: [
      { ...baseTwoSkuLines[0], ordered_qty: 221 },
      { ...baseTwoSkuLines[1], ordered_qty: 221 },
    ],
    goods_cny_total: 4420,
    domestic_freight_cny_total: 150,
  });
  assert.equal(verified221.order_plan.allocated_sets, 221);
  assert.equal(verified221.order_plan.per_complete_set_goods_cny, 20);

  const remPlan = computeOrderPlan({
    sku_lines: baseTwoSkuLines,
    allow_remainder: true,
  });
  assert.equal(remPlan.actual_complete_sets, 102);
  assert.equal(remPlan.total_goods_cny, 2060);
  assert.ok(Math.abs(remPlan.per_complete_set_goods_cny - (2060 / 102)) < 1e-9, `Expected ~20.20, got ${remPlan.per_complete_set_goods_cny}`);
});

test('Astra Sign-Off #8: unverified offer_ids never count as 3 factories, >3 quotes at once are rejected, and sequential executor stops once >=30% clears', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 };
    store.upsertCandidateForm({
      form_id: 'form-unverified-offers',
      label: 'Unverified Offer IDs Test',
      buyer_task: 'Hold cables',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1a = runGate1AForForm(store, {
      form_id: 'form-unverified-offers',
      scenarios: [{
        id: 'sc-40',
        price_usd: 40.00,
        pkg,
        fx_cny_per_usd: 7.20,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        headhaul_usd: 1.80,
        collection_rate: 0.006,
      }],
    });
    assert.equal(g1a.proceed_to_gate1b, true);

    const makeQuoteObj = (idx, unitCny, factoryId = undefined) => ({
      quote_id: `q-off-${idx}`,
      ...(factoryId ? { factory_id: factoryId } : {}),
      observed_at: '2026-11-24',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ref-${idx}`,
      fx_cny_per_usd: 7.20,
      pkg,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      ui_readback: VALID_UI,
      sku_lines: [{
        component_id: 'unit',
        offer_id: `distinct-offer-link-${idx}`,
        sku_id: `sku-${idx}`,
        pack_multiple: 1,
        qty_per_saleable_set: 1,
        moq_qty: 10,
        ordered_qty: 100,
        unit_price_cny: unitCny,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: unitCny * 100,
      domestic_freight_cny_total: 150,
    });

    const esBuilder = ({ form }) => {
      const d = JSON.parse(form.gate1a_result_json).declared_scenarios[0];
      return [{
        id: d.id,
        saleable_unit: '1 unit',
        price_usd: 40.00,
        fx_cny_per_usd: 7.20,
        pkg,
        headhaul: { usd_per_unit: 1.80, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        fulfillment_usd: d.fulfillment_usd,
        placement_usd: d.placement_range_usd[1],
        storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
        fee_context: {
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'p1',
          sales: { from: '2027-02-01', through: '2027-10-14' },
          storage: { from: '2027-02-01', through: '2027-09-30' },
          inbound: { from: '2027-01-15', through: '2027-10-14' },
        },
        collection_rate: 0.006,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }];
    };

    // 1) Dumping 4 quotes at once is rejected (> 3 cap) with 0 quotes written!
    const overCap = await runGate1BForForm(store, {
      form_id: 'form-unverified-offers',
      sourcing_executor: async () => ({
        status: 'quoted',
        quotes: [makeQuoteObj(1, 140, 'f1'), makeQuoteObj(2, 139, 'f2'), makeQuoteObj(3, 138, 'f3'), makeQuoteObj(4, 137, 'f4')],
      }),
      early_screen_builder: esBuilder,
    });
    assert.equal(overCap.status, 'gate1b_pending');
    assert.equal(store.getQuotesForForm('form-unverified-offers').length, 0);

    // 2) 3 losing quotes with different offer_ids but NO factory_id -> checked_factory_quotes_count = 0, second_factory_quote_needed = true!
    const unverifiedRes = await runGate1BForForm(store, {
      form_id: 'form-unverified-offers',
      sourcing_executor: async () => ({
        status: 'quoted',
        quotes: [makeQuoteObj(10, 145), makeQuoteObj(11, 142), makeQuoteObj(12, 140)],
      }),
      early_screen_builder: esBuilder,
    });
    assert.equal(unverifiedRes.status, 'gate1b_rejected');
    assert.equal(unverifiedRes.checked_factory_quotes_count, 0);
    assert.equal(unverifiedRes.second_factory_quote_needed, true);

    // 3) Iterative sourcing_executor (has_more_factories: true) stops immediately on Factory #1 when >= 30% clears!
    store.upsertCandidateForm({
      form_id: 'form-stop-at-1',
      label: 'Stop At First Passing Factory',
      buyer_task: 'Hold cables',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    runGate1AForForm(store, {
      form_id: 'form-stop-at-1',
      scenarios: [{
        id: 'sc-40',
        price_usd: 40.00,
        pkg,
        fx_cny_per_usd: 7.20,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        headhaul_usd: 1.80,
        collection_rate: 0.006,
      }],
    });
    let executorCalls = 0;
    const stopRes = await runGate1BForForm(store, {
      form_id: 'form-stop-at-1',
      sourcing_executor: async () => {
        executorCalls += 1;
        return {
          status: 'quoted',
          has_more_factories: true,
          quote: makeQuoteObj(executorCalls, 45, `fac-pass-${executorCalls}`),
        };
      },
      early_screen_builder: esBuilder,
    });
    assert.equal(stopRes.status, 'gate1b_passed');
    assert.equal(executorCalls, 1, 'Must stop immediately after 1st factory clears >= 30%');
    assert.equal(stopRes.second_factory_quote_needed, false);
  } finally {
    store.close();
  }
});

test('Astra Sign-Off #10, #11, #12: single-product CLI e2e, pre-write --profile-revision 58 rejection, and concurrent deferred guard across async Gate 4', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-reg10-'));
  try {
    const dbPath = join(dir, 'cli-e2e.sqlite');
    await runCliMem(['init', '--db', dbPath]);

    // 1) --profile-revision 58 on gate1a & gate1b MUST reject BEFORE writing forms or quotes!
    const g1a58Path = join(dir, 'g1a-58.json');
    writeFileSync(g1a58Path, JSON.stringify({
      form: { form_id: 'form-should-not-write', label: 'No Write', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'u', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 's1', price_usd: 45, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
    }, null, 2));
    const rG1a58 = await runCliMem(['gate1a', '--db', dbPath, '--input', g1a58Path, '--profile-revision', '58']);
    assert.equal(rG1a58.code, 2);

    const checkStore1 = openSelectionStore(dbPath, { readOnly: true });
    assert.equal(checkStore1.getCandidateForm('form-should-not-write'), null, 'gate1a --profile-revision 58 must write 0 forms');
    checkStore1.close();

    // Create a valid r59 Gate 1A form, then try gate1b --profile-revision 58 -> must write 0 quotes!
    const validFormSpecPath = join(dir, 'g1a-valid.json');
    writeFileSync(validFormSpecPath, JSON.stringify({
      form: { form_id: 'form-g1b-58-guard', label: 'Guard Test', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'u', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 's1', price_usd: 45, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
    }, null, 2));
    assert.equal((await runCliMem(['gate1a', '--db', dbPath, '--input', validFormSpecPath])).code, 0);

    const g1b58Path = join(dir, 'g1b-58.json');
    writeFileSync(g1b58Path, JSON.stringify({
      form_id: 'form-g1b-58-guard',
      quote: {
        quote_id: 'q-should-not-write',
        observed_at: '2026-11-24',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ref-no',
        fx_cny_per_usd: 7.2,
        pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        ui_readback: VALID_UI,
        sku_lines: [{ component_id: 'u', offer_id: 'o1', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
        goods_cny_total: 4000,
        domestic_freight_cny_total: 100,
      },
    }, null, 2));
    const rG1b58 = await runCliMem(['gate1b', '--db', dbPath, '--input', g1b58Path, '--profile-revision', '58']);
    assert.equal(rG1b58.code, 2);
    const checkStore2 = openSelectionStore(dbPath, { readOnly: true });
    assert.equal(checkStore2.getQuotesForForm('form-g1b-58-guard').length, 0, 'gate1b --profile-revision 58 must write 0 quotes');
    checkStore2.close();

    // 2) Public `single-product` CLI command runs end-to-end through evaluation & export-report!
    const cand = structuredClone(synthBatch.candidates[0]);
    cand.id = 'form-single-prod-1';
    const pkgObj = { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 };
    const est = estimateGate1A2027({
      price_usd: 45.00,
      pkg: pkgObj,
      fx_cny_per_usd: 7.20,
      refund_fraction: 0,
      physical_return_fraction: 0,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, minimum_referral_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
      headhaul_usd: 1.80,
      collection_rate: 0.006,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
      profile_revision: 59,
    });
    cand.screening.reference_price_usd.value = 45.00;
    const sc = cand.economics.scenarios[0];
    const pkgRef = sc.cost_ledger.fee_context.package_ref;
    cand.economics.packages = [{ id: pkgRef, ...pkgObj }];
    sc.id = sc.cost_ledger.id = 'sc-sp1';
    sc.quote_id = 'q-sp1';
    sc.cost_ledger.price_usd = 45.00;
    sc.cost_ledger.fx_cny_per_usd = 7.20;
    sc.cost_ledger.refund_fraction = 0;
    sc.cost_ledger.physical_return_fraction = 0;
    sc.cost_ledger.source_inputs = { quote_id: 'q-sp1', fx_cny_per_usd: 7.20, order_units: 100, goods_cny_total: 5000, domestic_freight_cny_total: 150 };
    sc.cost_ledger.fee_context = {
      marketplace: 'US',
      currency: 'USD',
      package_ref: pkgRef,
      sales: { from: '2027-02-01', through: '2027-10-14' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-15', through: '2027-10-14' },
    };
    for (const line of sc.cost_ledger.lines) {
      if (line.id === 'procurement') { line.amount_usd = Number((50 / 7.20).toFixed(6)); line.order_units = 100; line.fx_cny_per_usd = 7.20; line.status = 'sourced'; }
      else if (line.id === 'domestic_freight') { line.amount_usd = Number((1.5 / 7.20).toFixed(6)); line.order_units = 100; line.fx_cny_per_usd = 7.20; line.status = 'sourced'; }
      else if (line.id === 'headhaul') line.amount_usd = 1.80;
      else if (line.id === 'referral') { line.amount_usd = est.components.referral.net_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-01-15'; line.fee_basis.effective_through = '2027-12-31'; line.fee_basis.referral_fraction = 0.15; line.fee_basis.minimum_referral_usd = 0.30; line.fee_basis.refund_admin_fraction = 0.20; line.fee_basis.refund_admin_cap_usd = 5.00; } }
      else if (line.id === 'fulfillment') { line.amount_usd = est.components.fulfillment.total_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-01-15'; line.fee_basis.effective_through = '2027-10-14'; } }
      else if (line.id === 'placement') { line.amount_usd = est.components.placement.selected_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-01-15'; line.fee_basis.effective_through = '2027-10-14'; } }
      else if (line.id === 'storage') { line.amount_usd = est.components.storage.per_unit_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-02-01'; line.fee_basis.effective_through = '2027-09-30'; line.fee_basis.cubic_feet_per_unit = est.components.storage.cubic_feet; line.fee_basis.rate_usd_per_cuft_month = est.components.storage.rate_usd_per_cuft_month; line.fee_basis.average_inventory_days = 45; } }
      else if (line.id === 'returns_processing') { line.amount_usd = 0; line.return_threshold = 0.081; if (line.fee_basis) { line.fee_basis.effective_from = '2027-02-01'; line.fee_basis.effective_through = '2027-12-31'; line.fee_basis.fee_category = 'Home and Kitchen'; line.fee_basis.return_threshold = 0.081; } }
      else if (line.id === 'collection') { line.amount_usd = est.components.collection.collection_usd; line.rate = 0.006; }
    }
    delete sc.margin;
    delete sc.contribution_usd;

    const singleProdPath = join(dir, 'single-product-in.json');
    writeFileSync(singleProdPath, JSON.stringify({
      as_of_date: '2026-11-24',
      form: { form_id: 'form-single-prod-1', label: 'Single Product CLI Test', buyer_task: 'Organize desk', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
      asin: 'B0SYNSING1',
      gate1a_scenarios: [{
        id: 'sc-sp1',
        price_usd: 45.00,
        pkg: pkgObj,
        fx_cny_per_usd: 7.20,
        refund_fraction: 0,
        physical_return_fraction: 0,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        headhaul_usd: 1.80,
        collection_rate: 0.006,
      }],
      quote: {
        quote_id: 'q-sp1',
        factory_id: 'fac-sp1',
        observed_at: '2026-11-24',
        redacted_destination: '广东省深圳市',
        raw_readback_ref: 'ref-sp1',
        fx_cny_per_usd: 7.20,
        pkg: pkgObj,
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        ui_readback: VALID_UI,
        sku_lines: [{ component_id: 'main', offer_id: 'off-sp1', sku_id: 'sku-sp1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 50, regular_goods_promo_false: true }],
        goods_cny_total: 5000,
        domestic_freight_cny_total: 150,
      },
      scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand] },
    }, null, 2));

    const rSingle = await runCliMem(['single-product', '--db', dbPath, '--input', singleProdPath]);
    assert.equal(rSingle.code, 0, rSingle.stderr);
    const parsedSingle = JSON.parse(rSingle.stdout);
    assert.equal(parsedSingle.command, 'single-product');
    assert.equal(parsedSingle.batch_report.evaluations.length, 1);

    const batchJsonPath = join(dir, 'single-batch.json');
    writeFileSync(batchJsonPath, JSON.stringify({ schema_version: 1, profile_revision: 59, candidates: [cand] }, null, 2));
    const reportOutDir = join(dir, 'single-report');
    const rExport = await runCliMem([
      'export-report',
      '--db', dbPath,
      '--batch', batchJsonPath,
      '--profile', join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'),
      '--output', reportOutDir,
    ]);
    assert.equal(rExport.code, 0, rExport.stderr);
    const exportedScored = JSON.parse(readFileSync(join(reportOutDir, 'result.json'), 'utf8'));
    assert.equal(exportedScored.candidates[0].candidate_id ?? exportedScored.candidates[0].id, 'form-single-prod-1');
    assert.ok(readFileSync(join(reportOutDir, 'index.html'), 'utf8').length > 10_000);

    // 3) Concurrent owner `deferred` update from a 2nd DB connection during async Gate-4 MUST NOT be overwritten!
    const raceDbPath = join(dir, 'race-g4.sqlite');
    const storeA = openSelectionStore(raceDbPath);
    const storeB = openSelectionStore(raceDbPath);
    try {
      const candRace = structuredClone(cand);
      candRace.id = 'form-race-defer';
      candRace.economics.scenarios[0].quote_id = 'q-race-1';
      candRace.economics.scenarios[0].cost_ledger.source_inputs.quote_id = 'q-race-1';

      const raceRes = await runPhase2Batch(storeA, {
        profile: r59Profile,
        as_of_date: '2026-11-24',
        openai_hooks: {
          evidence_review: {
            enabled: true,
            testMode: true,
            receiptDir: join(dir, 'race-receipts'),
            reviewExecutor: async () => {
              // Concurrent owner deferral while Gate 4 is in flight!
              storeB.updateFormLifecycle('form-race-defer', 'deferred');
              return { status: 'unavailable', execution_status: 'not_submitted', reason: 'mock' };
            },
          },
        },
        items: [{
          form: { form_id: 'form-race-defer', label: 'Race Defer', buyer_task: 'Organize desk', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          leads: [{ lead_id: 'ld-race', source_channel: 'reddit', source_ref: 'https://example.com/race', phrase_or_title: 'desk rack', observed_at: '2026-11-24', disposition: 'product' }],
          gate1a_scenarios: [{
            id: 'sc-sp1',
            price_usd: 45.00,
            pkg: pkgObj,
            fx_cny_per_usd: 7.20,
            refund_fraction: 0,
            physical_return_fraction: 0,
            fee_category: 'Home and Kitchen',
            referral_terms: { referral_fraction: 0.15, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
            headhaul_usd: 1.80,
            collection_rate: 0.006,
          }],
          sourcing_executor: async () => ({
            status: 'quoted',
            quote: {
              quote_id: 'q-race-1',
              factory_id: 'fac-race-1',
              observed_at: '2026-11-24',
              redacted_destination: '广东省深圳市',
              raw_readback_ref: 'ref-race',
              fx_cny_per_usd: 7.20,
              pkg: pkgObj,
              goods_first_order_promotion: false,
              freight_first_order_promotion: false,
              ui_readback: VALID_UI,
              sku_lines: [{ component_id: 'main', offer_id: 'off-r1', sku_id: 'sku-r1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 50, regular_goods_promo_false: true }],
              goods_cny_total: 5000,
              domestic_freight_cny_total: 150,
            },
          }),
          early_screen_builder: () => ({
            profile_revision: 59,
            id: 'sc-sp1',
            saleable_unit: '1 unit',
            price_usd: 45.00,
            fx_cny_per_usd: 7.20,
            pkg: pkgObj,
            headhaul: { usd_per_unit: 1.80, bond_included: true },
            refund_fraction: 0,
            physical_return_fraction: 0,
            return_threshold: 0.081,
            returns_processing_usd: 0,
            is_apparel_or_shoes: false,
            referral_terms: { referral_fraction: 0.15, minimum_referral_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
            fulfillment_usd: est.components.fulfillment.total_usd,
            placement_usd: est.components.placement.selected_usd,
            storage: { cubic_feet_per_unit: est.components.storage.cubic_feet, rate_usd_per_cuft_month: est.components.storage.rate_usd_per_cuft_month, average_inventory_days: 45 },
            operating_period: 'off_peak',
            operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: pkgRef, sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
            collection_rate: 0.006,
            other_applicable_usd: 0,
            specific_rights_conflict: 'unknown',
            strong_date_dependency: false,
          }),
          deep_research_executor: async () => ({
            batch: { schema_version: 1, profile_revision: 59, candidates: [candRace] },
            evidence_review_packet: {
              schema_version: 'evidence-review-draft-v1',
              review_id: 'rev-race-defer',
              execution_policy_ref: 'local-policy-only',
              candidate: { subject_id: 'form-race-defer', intended_use: 'Organize desk', saleable_spec: { qty_per_saleable_set: 1 }, unknown_fields: [] },
              subjects: [{ subject_id: 'desk', spec: { qty: 1 } }],
              criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'fit', description: 'Fit', required: true }] },
              questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['desk'], criterion_ids: ['fit'] }],
              evidence: [{ evidence_id: 'e1', subject_ids: ['desk'], summary: 'Control.', kind: 'fact', source_ref: 'r1', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
            },
          }),
        }],
      });
      assert.equal(raceRes.gate2_3[0].status, 'deferred');
      assert.equal(storeA.getCandidateForm('form-race-defer').lifecycle_status, 'deferred', 'Concurrent deferred status must NOT be overwritten to evaluated');
      assert.equal(storeA.getEvaluationsForForm('form-race-defer').length, 0);
    } finally {
      storeA.close();
      storeB.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Astra Sign-Off #13 & #14: Codex startup banner ultrafast fallback, NTFS hardlink legacy SQLite guards, and repo-wide Markdown link integrity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-reg13-'));
  try {
    // 1) Codex startup banner with `session id:` before ultrafast entitlement rejection MUST fall back cleanly to standard/default!
    let attempts = 0;
    const tierSeen = [];
    const fallbackOut = await runCodexExecMarkdown({
      prompt: 'Synthetic fallback test.',
      serviceTier: 'ultrafast',
      testMode: true,
      cwd: dir,
      receiptDir: join(dir, 'codex-fb-receipts'),
      mockExecutor: async ({ args, outputFilePath }) => {
        attempts += 1;
        const tierArg = args.find(a => a.startsWith('service_tier='));
        tierSeen.push(tierArg ?? 'default');
        if (attempts === 1) {
          return {
            exitCode: 1,
            stderr: [
              'OpenAI Codex v0.62.0 (research preview)',
              '--------',
              'workdir: .',
              'model: gpt-6.2-astra',
              'session id: 019a0500-0502-7000-8000-000000000503',
              'ERROR: service_tier "ultrafast" is not supported on your current plan (requires Pro-500).',
            ].join('\n'),
          };
        }
        writeFileSync(outputFilePath, 'Fallback review succeeded.\n', 'utf8');
        return { exitCode: 0, stderr: '' };
      },
    });
    assert.equal(attempts, 2, 'Startup banner with session id must not block ultrafast -> default fallback');
    assert.equal(fallbackOut.tier_fallback_used, true);
    assert.deepEqual(tierSeen, ['service_tier="ultrafast"', 'service_tier="default"']);

    // And if real generation progress (`thinking` / `tokens used`) occurred, retry MUST remain blocked!
    let genAttempts = 0;
    await assert.rejects(async () => {
      await runCodexExecMarkdown({
        prompt: 'Synthetic post-generation error.',
        serviceTier: 'ultrafast',
        testMode: true,
        cwd: dir,
        receiptDir: join(dir, 'codex-noblock-receipts'),
        mockExecutor: async () => {
          genAttempts += 1;
          return {
            exitCode: 1,
            stderr: 'session id: 019a0000-0000-7000-8000-000000000002\nthinking\nERROR: service_tier "ultrafast" is not supported.',
          };
        },
      });
    });
    assert.equal(genAttempts, 1, 'Once thinking/generation starts, retry must remain blocked');

    // 2) Legacy SQLite hardlink collision & multi-hardlink WAL ambiguity guards
    const legacyPath = join(dir, 'legacy-budget.sqlite');
    const initDb = new DatabaseSync(legacyPath);
    initDb.exec(`
      CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL DEFAULT 0,
        actual_cents INTEGER
      );
      INSERT INTO requests (request_id, created_at, status, reserved_cents, actual_cents)
      VALUES ('r-1', '2026-11-10T00:00:00Z', 'completed', 100, 100);
    `);
    initDb.close();
    const origBytes = readFileSync(legacyPath);

    // Inspect while single-linked, then create NTFS hardlink alias and attempt reconcileLegacyBudgetIntoStore(hardlinkAlias, summary)
    const cleanSummary = inspectLegacyAutopilotBudget(legacyPath, { monthUtc: '2026-11' });
    const hardlinkAlias = join(dir, 'hardlink-alias.sqlite');
    linkSync(legacyPath, hardlinkAlias);

    assert.throws(
      () => reconcileLegacyBudgetIntoStore(hardlinkAlias, cleanSummary, { testMode: true }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );
    assert.equal(Buffer.compare(readFileSync(legacyPath), origBytes), 0, 'Legacy SQLite bytes must remain 100% untouched before hardlink collision error');

    // Direct inspection of a multi-hardlink legacy SQLite file (nlink > 1) MUST also be rejected due to WAL sidecar ambiguity!
    assert.throws(
      () => inspectLegacyAutopilotBudget(hardlinkAlias, { monthUtc: '2026-11' }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_HARDLINK_ALIAS_FORBIDDEN',
    );
    assert.equal(statSync(legacyPath, { bigint: true }).nlink > 1n, true);

    // 3) Zero broken relative Markdown links across ALL tracked docs (including docs/archive/**)
    const walkMd = d => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walkMd(join(d, e.name)) : (e.name.endsWith('.md') ? [join(d, e.name)] : []),
    );
    const mdFiles = [
      join(REPO_ROOT, 'README.md'),
      join(REPO_ROOT, 'AGENTS.md'),
      join(REPO_ROOT, 'GLOSSARY.md'),
      ...walkMd(join(REPO_ROOT, 'docs')),
    ];
    const brokenLinks = [];
    const linkRe = /\[([^\]]+)\]\((?!https?:\/\/|mailto:|#|file:\/\/)([^)#?\s]+)(?:[#?][^)\s]*)?\)/g;
    for (const file of mdFiles) {
      const content = readFileSync(file, 'utf8');
      let m;
      while ((m = linkRe.exec(content)) !== null) {
        const resolvedTarget = resolve(dirname(file), m[2]);
        try {
          statSync(resolvedTarget);
        } catch {
          brokenLinks.push(`${file} -> ${m[2]}`);
        }
      }
    }
    assert.deepEqual(brokenLinks, [], `Broken Markdown links detected: ${brokenLinks.join('; ')}`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Astra Round-2 Counterexamples A: undated Buy Box $40 cannot resurrect $26.99 newcomer coupon price, $29.98 never rounds across $29.99 floor, and Keepa as_of_date / package-only / 20% couponless / 50% continuous coupon', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-r2-a-'));
  try {
    // 1) 14-day newcomer ($40 list, $13.01 coupon -> $26.99 net) + undated Buy Box $40 snapshot -> $40 MUST still be rejected!
    writeFileSync(join(dir, 'ss-new14.json'), JSON.stringify({
      code: 'OK',
      items: [{
        asin: 'B0SYNNEW14',
        price: 40.00,
        coupon: '$13.01',
        availableDate: '2026-11-10',
        monthlySales: 180,
      }],
    }), 'utf8');
    writeFileSync(join(dir, 'undated-bb40.json'), JSON.stringify({
      code: 'OK',
      items: [{
        asin: 'B0SYNNEW14',
        buyboxPrice: 40.00,
        series: { buybox: [40.00] },
        Summary: { BuyBoxPrices: [{ ListingPrice: { Amount: 40.00 } }] },
      }],
    }), 'utf8');

    const candSmuggle40 = structuredClone(synthBatch.candidates[0]);
    candSmuggle40.id = 'cand-r2-new14-bb40';
    candSmuggle40.screening.reference_price_usd = {
      value: 40.00,
      matched_spec: true,
      target_variant_asin: 'B0SYNNEW14',
      observed_at: '2026-11-24',
    };
    candSmuggle40.economics.scenarios = [candSmuggle40.economics.scenarios[0]];
    candSmuggle40.economics.scenarios[0].price_anchor = { value: 40.00, target_variant_asin: 'B0SYNNEW14' };
    candSmuggle40.economics.scenarios[0].cost_ledger.price_usd = 40.00;
    candSmuggle40.economics.expected_primary_scenarios = [{ id: candSmuggle40.economics.scenarios[0].id, status: 'active' }];

    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: '2026-11-24',
        raw_receipt_files: ['ss-new14.json', 'undated-bb40.json'],
        candidates: [{ candidate: candSmuggle40, raw_receipt_files: ['ss-new14.json', 'undated-bb40.json'] }],
      }, r59Profile, { baseDir: dir }),
      /pre-coupon list price|price-binding violation/i,
    );

    // 2) Raw observed $29.98 (< $29.99 floor) MUST NOT match declared $29.99 via 5-cent tolerance!
    writeFileSync(join(dir, 'raw-2998.json'), JSON.stringify({
      code: 'OK',
      items: [{ asin: 'B0SYN2998A', price: 29.98, availableDate: '2024-06-01', monthlySales: 120 }],
    }), 'utf8');
    const cand2999 = structuredClone(candSmuggle40);
    cand2999.id = 'cand-r2-2998-to-2999';
    cand2999.screening.reference_price_usd = {
      value: 29.99,
      matched_spec: true,
      target_variant_asin: 'B0SYN2998A',
      observed_at: '2026-11-24',
    };
    cand2999.economics.scenarios[0].price_anchor = { value: 29.99, target_variant_asin: 'B0SYN2998A' };
    cand2999.economics.scenarios[0].cost_ledger.price_usd = 29.99;

    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: '2026-11-24',
        raw_receipt_files: ['raw-2998.json'],
        candidates: [{ candidate: cand2999, raw_receipt_files: ['raw-2998.json'] }],
      }, r59Profile, { baseDir: dir }),
      /do not match|price-binding violation/i,
    );

    // 3) Keepa historical as_of_date ('2026-03-31') MUST NOT read future April-June $59 prices!
    const tsJanJun = Array.from({ length: 180 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const pricesJanJun = tsJanJun.map(d => (d <= '2026-03-31' ? 39.00 : 59.00));
    const parsedCutoff = parseSellerSpriteKeepaPayload({
      asin: 'B0SYNCUT01',
      keepa_trend: { ts: tsJanJun, series: { price: pricesJanJun } },
    }, { as_of_date: '2026-03-31', age_days: 500 });
    assert.equal(parsedCutoff.keepa_90d_median_usd, 39.00, 'as_of_date 2026-03-31 must slice Jan-Mar ($39), never future Apr-Jun ($59)');
    assert.equal(parsedCutoff.window_90d.through, '2026-03-31');
    assert.equal(parsedCutoff.keepa_90d_steady, true);

    // 4) 400-day veteran with package-only Keepa snapshot MUST NOT be marked Keepa-steady veteran!
    const mergedPkgOnlyPeers = mergeKeepaPayloadsIntoPeerListings(
      [{ asin: 'B0SYNVETPK', price: 59.00, fulfillment: 'FBA', monthly_units: 100, available_date: '2025-09-01' }],
      [{ asin: 'B0SYNVETPK', pkgDimensionsSize: '12 x 8 x 4 in', pkgWeightGram: 680 }],
      { as_of_date: '2026-11-24' },
    );
    const bandPkgOnly = analyzeMainstreamPriceBand(mergedPkgOnlyPeers, { as_of_date: '2026-11-24' });
    assert.equal(bandPkgOnly.mainstream_pool.length, 0, 'Package-only Keepa snapshot must not certify a 400d veteran as Keepa-steady');
    assert.ok(bandPkgOnly.observed_out_of_band_peers.some(p => p.asin === 'B0SYNVETPK' && p.reason_code === 'veteran_missing_keepa_steady_evidence'));

    // 5) 89 days $50 + 1 day $40 with empty coupon history MUST NOT trigger clearance watch via 20% single-coupon threshold!
    const ts90 = Array.from({ length: 90 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 1 + i));
      return d.toISOString().slice(0, 10);
    });
    const parsed89_1 = parseSellerSpriteKeepaPayload({
      asin: 'B0SYNDIP40',
      keepa_trend: {
        ts: ts90,
        series: {
          price: [...Array(89).fill(50.00), 40.00],
          couponHistory: Array(90).fill(null),
        },
      },
    }, { age_days: 450 });
    assert.equal(parsed89_1.sustained_drop_or_clearance_watch, false);
    assert.equal(parsed89_1.keepa_90d_steady, false);

    // 6) Continuous 90d $59 list + daily 50% single coupon ($29.50 net) MUST NOT adopt $59 as primary regular band!
    const keepaHeavy50 = {
      asin: 'B0SYNHVY50',
      keepa_trend: {
        ts: ts90,
        series: {
          price: Array(90).fill(59.00),
          couponHistory: Array(90).fill('50%'),
        },
      },
    };
    const parsedHeavy50 = parseSellerSpriteKeepaPayload(keepaHeavy50, { age_days: 450 });
    assert.equal(parsedHeavy50.continuous_heavy_coupon_90d, true);
    assert.equal(parsedHeavy50.keepa_90d_steady, false);
    assert.equal(parsedHeavy50.keepa_90d_median_usd, null);
    assert.equal(parsedHeavy50.realized_net_90d_median_usd, 29.50);

    const mergedHeavy50Peers = mergeKeepaPayloadsIntoPeerListings(
      [{ asin: 'B0SYNHVY50', price: 59.00, fulfillment: 'FBA', monthly_units: 120, available_date: '2025-06-01' }],
      [keepaHeavy50],
      { as_of_date: '2026-10-29' },
    );
    const bandHeavy50 = analyzeMainstreamPriceBand(mergedHeavy50Peers, { as_of_date: '2026-10-29' });
    assert.equal(bandHeavy50.mainstream_pool.length, 0, 'Continuous 50% coupon ($29.50 net) must never enter mature_regular_band at $59');
    assert.equal(mergedHeavy50Peers[0].ongoing_coupon_pct, 0.5);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Astra Round-2 Counterexamples B: $0 placement proof in calculateEconomics/evaluateEarlyScreen, profit-check & reverse-1688 freight/A4/221-set math, 4-factory CLI rejection, mid-loop deferred abort, pre-open r58 DB guard, single-product seed/report, and 6.8KB Codex prompt-echo fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-r2-b-'));
  try {
    // 1) Standard package $0 placement with calculator_verified/sp_api_calibrated WITHOUT >=5 cartons + multi-dest headhaul -> pending!
    const stdPkg = { id: 'synthetic-pack', length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 };
    const baseCandZeroPlace = structuredClone(synthBatch.candidates[0]);
    const scZero = baseCandZeroPlace.economics.scenarios[0];
    scZero.cost_ledger.packages = [stdPkg];
    const placeComp = scZero.cost_ledger.lines.find(c => c.id === 'placement');
    assert.ok(placeComp);
    placeComp.amount_usd = 0;
    placeComp.fee_basis = { ...(placeComp.fee_basis ?? {}), calculator_verified: true, sp_api_calibrated: true };
    const econUnproven = calculateEconomics(scZero.cost_ledger, { profileRevision: 59, externalPackages: [stdPkg] });
    assert.equal(econUnproven.status, 'pending_costs', 'calculator_verified/sp_api_calibrated must NOT bypass 5-carton + multi-dest proof for $0 placement');

    const earlyUnproven = evaluateEarlyScreen({
      profile_revision: 59,
      id: 'es-zero-place',
      saleable_unit: '1 set',
      price_usd: 45.00,
      fx_cny_per_usd: 7.20,
      pkg: stdPkg,
      goods_cny_per_unit: 40,
      domestic_freight_cny_per_unit: 2,
      headhaul: { usd_per_unit: 1.50, bond_included: true },
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.08,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
      fulfillment_usd: 5.50,
      placement_usd: 0,
      placement_fee_basis: { calculator_verified: true, sp_api_calibrated: true },
      storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: {
        marketplace: 'US',
        currency: 'USD',
        package_ref: 'synthetic-pack',
        sales: { from: '2027-02-01', through: '2027-10-14' },
        storage: { from: '2027-02-01', through: '2027-09-30' },
        inbound: { from: '2027-01-15', through: '2027-10-14' },
      },
      collection_rate: 0.006,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    }, { profileRevision: 59 });
    assert.equal(earlyUnproven.gate_status, 'pending', 'Standard early screen with unproven $0 placement must stay pending');

    // 2) profit-check (`runFastProfitHealthcheck2027`): missing domestic freight NEVER assumed ¥0; structured A4 matches scalar!
    const hcMissingFreight = runFastProfitHealthcheck2027({
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      price_usd: 45.00,
      fx_cny_per_usd: 7.20,
      order_units: 100,
      goods_cny_total: 10480,
      headhaul_usd: 1.50,
    });
    assert.equal(hcMissingFreight.realized_2027_off_peak.status, 'pending_domestic_freight');
    assert.equal(hcMissingFreight.realized_2027_off_peak.margin, null);

    const hcScalarA4 = runFastProfitHealthcheck2027({
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      price_usd: 45.00,
      fx_cny_per_usd: 7.20,
      order_units: 100,
      goods_cny_total: 6000,
      domestic_freight_cny_total: 280,
      headhaul_usd: 660 / 100 / 7.20,
    });
    const hcStructA4 = runFastProfitHealthcheck2027({
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      price_usd: 45.00,
      fx_cny_per_usd: 7.20,
      order_units: 100,
      goods_cny_total: 6000,
      domestic_freight_cny_total: 280,
      headhaul: { rate_cny_per_kg: 10, bond_cny_per_kg: 1, chargeable_kg_per_unit: 0.60 },
    });
    assert.equal(hcStructA4.realized_2027_off_peak.status, 'verified');
    assert.equal(hcStructA4.realized_2027_off_peak.margin, hcScalarA4.realized_2027_off_peak.margin);

    // 3) Pre-open `--profile-revision 58` on nonexistent DB path MUST exit 2 WITHOUT creating any SQLite file!
    const nonExistentDb = join(dir, 'must-not-be-created.sqlite');
    const dummyG1aPath = join(dir, 'dummy-g1a.json');
    writeFileSync(dummyG1aPath, JSON.stringify({ form_id: 'f-r58', scenarios: [] }), 'utf8');
    const r58BeforeOpen = await runCliMem(['gate1a', '--db', nonExistentDb, '--input', dummyG1aPath, '--profile-revision', '58']);
    assert.equal(r58BeforeOpen.code, 2);
    assert.equal(existsSync(nonExistentDb), false, 'Rejected --profile-revision 58 must NOT create a SQLite database file');

    // 4) `reverse-1688` CLI derives 221 sets from 17 & 13 sku_lines ($45.39) and withholds missing freight/headhaul!
    const cliDb = join(dir, 'cli-r2.sqlite');
    await runCliMem(['init', '--db', cliDb]);
    const rev221SpecPath = join(dir, 'rev-221.json');
    writeFileSync(rev221SpecPath, JSON.stringify({
      fx_cny_per_usd: 7.20,
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      headhaul_usd: 2.20,
      saleable_set_composition: [
        { component_id: 'body', qty_per_saleable_set: 1 },
        { component_id: 'lid', qty_per_saleable_set: 1 },
      ],
      quote: {
        goods_cny_total: 22100,
        domestic_freight_cny_total: 150,
        sku_lines: [
          { component_id: 'body', offer_id: 'o17', sku_id: 's17', pack_multiple: 17, qty_per_saleable_set: 1, moq_qty: 17, ordered_qty: 221, unit_price_cny: 60 },
          { component_id: 'lid', offer_id: 'o13', sku_id: 's13', pack_multiple: 13, qty_per_saleable_set: 1, moq_qty: 13, ordered_qty: 221, unit_price_cny: 40 },
        ],
      },
    }), 'utf8');
    const revDerived = await runCliMem(['reverse-1688', '--db', cliDb, '--input', rev221SpecPath]);
    assert.equal(revDerived.code, 0);
    const revDerivedJson = JSON.parse(revDerived.stdout);
    assert.equal(revDerivedJson.reverse_1688.actual_complete_sets_used, 221);

    const revExplicit221Path = join(dir, 'rev-221-explicit.json');
    const explicit221Payload = JSON.parse(readFileSync(rev221SpecPath, 'utf8'));
    explicit221Payload.quote.actual_complete_sets = 221;
    writeFileSync(revExplicit221Path, JSON.stringify(explicit221Payload), 'utf8');
    const revExplicit221 = await runCliMem(['reverse-1688', '--db', cliDb, '--input', revExplicit221Path]);
    const revExplicit221Json = JSON.parse(revExplicit221.stdout);
    assert.equal(revDerivedJson.reverse_1688.min_retail_price_for_30pct_usd, revExplicit221Json.reverse_1688.min_retail_price_for_30pct_usd);
    assert.ok(revDerivedJson.reverse_1688.min_retail_price_for_30pct_usd < 50);

    const revMissingFreightPath = join(dir, 'rev-no-freight.json');
    writeFileSync(revMissingFreightPath, JSON.stringify({
      fx_cny_per_usd: 7.20,
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      quote: { goods_cny_total: 10000 },
    }), 'utf8');
    const revNoFreight = await runCliMem(['reverse-1688', '--db', cliDb, '--input', revMissingFreightPath]);
    assert.equal(revNoFreight.code, 0);
    assert.equal(JSON.parse(revNoFreight.stdout).reverse_1688.min_retail_price_for_30pct_usd, null);

    // 5) `gate1b` CLI with 4 distinct `factory_id` quotes MUST exit 2 and persist 0 quotes!
    const g1aSpec4Path = join(dir, 'g1a-4fac.json');
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    writeFileSync(g1aSpec4Path, JSON.stringify({
      form: {
        form_id: 'form-4fac-cli',
        product_family_key: 'form-4fac-cli',
        label: '4-factory CLI guard',
        buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      },
      scenarios: [{
        id: 'sc-4fac',
        price_usd: 45.00,
        available_date: '2025-01-01',
        pkg,
        fx_cny_per_usd: 7.20,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
        headhaul_usd: 1.50,
        collection_rate: 0.006,
        other_applicable_usd: 0,
      }],
    }), 'utf8');
    const g1a4Out = await runCliMem(['gate1a', '--db', cliDb, '--input', g1aSpec4Path]);
    assert.equal(g1a4Out.code, 0);
    const decl = JSON.parse(g1a4Out.stdout).result.declared_scenarios[0];
    const ui = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    const mkCliQ = (id, facId) => ({
      quote_id: id,
      factory_id: facId,
      observed_at: '2026-11-24T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ref-${id}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.20,
      pkg,
      ui_readback: ui,
      sku_lines: [{ component_id: 'unit', offer_id: `off-${id}`, sku_id: `sku-${id}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
      goods_cny_total: 4000,
      domestic_freight_cny_total: 200,
    });
    const g1b4Path = join(dir, 'g1b-4fac.json');
    writeFileSync(g1b4Path, JSON.stringify({
      form_id: 'form-4fac-cli',
      quotes: [mkCliQ('q4-1', 'fac-1'), mkCliQ('q4-2', 'fac-2'), mkCliQ('q4-3', 'fac-3'), mkCliQ('q4-4', 'fac-4')],
      early_screen_scenarios: [{
        profile_revision: 59,
        id: decl.id,
        saleable_unit: '1 unit',
        price_usd: decl.price_usd,
        fx_cny_per_usd: decl.fx_cny_per_usd,
        pkg,
        headhaul: { usd_per_unit: decl.headhaul_usd, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
        fulfillment_usd: decl.fulfillment_usd,
        placement_usd: decl.placement_range_usd[1],
        storage: { cubic_feet_per_unit: (12 * 8 * 4) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
        collection_rate: 0.006,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }],
    }), 'utf8');
    const g1b4Out = await runCliMem(['gate1b', '--db', cliDb, '--input', g1b4Path]);
    assert.equal(g1b4Out.code, 2, 'gate1b CLI must reject 4 distinct factory_id quotes');
    const checkSt = openSelectionStore(cliDb, { readOnly: true });
    try {
      assert.equal(checkSt.getQuotesForForm('form-4fac-cli').length, 0, 'Zero quotes may be persisted when >3 factories are submitted');
    } finally {
      checkSt.close();
    }

    // 6) Concurrent `deferred` during Factory #2 in iterative Gate 1B MUST abort before recording #2 or calling #3!
    const iterDb = join(dir, 'iter-defer.sqlite');
    const stMain = openSelectionStore(iterDb);
    const stPeer = openSelectionStore(iterDb);
    try {
      stMain.upsertCandidateForm({
        form_id: 'form-iter-defer',
        product_family_key: 'form-iter-defer',
        label: 'Iter defer guard',
        buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      const g1aIter = runGate1AForForm(stMain, {
        form_id: 'form-iter-defer',
        profile_revision: 59,
        scenarios: [{
          id: 'sc-iter',
          price_usd: 45.00,
          available_date: '2025-01-01',
          pkg,
          fx_cny_per_usd: 7.20,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
          headhaul_usd: 1.50,
          collection_rate: 0.006,
          other_applicable_usd: 0,
        }],
      });
      const dIter = g1aIter.declared_scenarios[0];
      let iterCalls = 0;
      const iterRes = await runGate1BForForm(stMain, {
        form_id: 'form-iter-defer',
        profile_revision: 59,
        as_of_date: '2026-11-24',
        sourcing_executor: async () => {
          iterCalls += 1;
          if (iterCalls === 1) {
            return {
              status: 'quoted',
              has_more_factories: true,
              quote: { ...mkCliQ('q-it-1', 'fac-it-1'), goods_cny_total: 14000, sku_lines: [{ ...mkCliQ('q-it-1', 'fac-it-1').sku_lines[0], unit_price_cny: 140 }] },
            };
          }
          if (iterCalls === 2) {
            stPeer.updateFormLifecycle('form-iter-defer', 'deferred', {});
            return {
              status: 'quoted',
              has_more_factories: true,
              quote: mkCliQ('q-it-2', 'fac-it-2'),
            };
          }
          return { status: 'quoted', quote: mkCliQ('q-it-3', 'fac-it-3') };
        },
        early_screen_builder: () => [{
          profile_revision: 59,
          id: dIter.id,
          saleable_unit: '1 unit',
          price_usd: dIter.price_usd,
          fx_cny_per_usd: dIter.fx_cny_per_usd,
          pkg,
          headhaul: { usd_per_unit: dIter.headhaul_usd, bond_included: true },
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          is_apparel_or_shoes: false,
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
          fulfillment_usd: dIter.fulfillment_usd,
          placement_usd: dIter.placement_range_usd[1],
          storage: { cubic_feet_per_unit: (12 * 8 * 4) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
          collection_rate: 0.006,
          other_applicable_usd: 0,
          specific_rights_conflict: 'unknown',
          strong_date_dependency: false,
        }],
      });
      assert.equal(iterRes.status, 'deferred');
      assert.equal(iterCalls, 2, 'Must NOT invoke sourcing_executor for Factory #3 after deferred on #2');
      assert.equal(stMain.getQuotesForForm('form-iter-defer').length, 1, 'Quote #2 must NOT be persisted after concurrent deferred');
    } finally {
      stMain.close();
      stPeer.close();
    }

    // 7) `single-product` CLI accepts bare `{"asin":"B0SYNV400D"}` seed AND supports `--report-dir` direct V4 HTML export!
    const bareAsinPath = join(dir, 'bare-asin.json');
    writeFileSync(bareAsinPath, JSON.stringify({ asin: 'B0SYNV400D' }), 'utf8');
    const bareRes = await runCliMem(['single-product', '--db', cliDb, '--input', bareAsinPath]);
    assert.equal(bareRes.code, 0);
    const bareJson = JSON.parse(bareRes.stdout);
    assert.equal(bareJson.mode, 'seed_registered_awaiting_gate1a');
    assert.equal(bareJson.form_id, 'form-b0synv400d');

    // 8) 6,800+ byte Codex v0.172.0 startup banner + multi-KB echoed user prompt (containing words like timeout/429/thinking) + ultrafast rejection MUST fall back!
    const longEchoPrompt = `# Audit Prompt\nCheck timeout handling, HTTP 429 guards, streaming recovery, thinking budgets, and tokens used accounting.\n${'Line of detailed file paths and pass criteria. '.repeat(140)}`;
    const realisticLongStderr = [
      'OpenAI Codex v0.172.0',
      '--------',
      'workdir: C:\\repo',
      'model: gpt-6.2-astra',
      'provider: openai',
      'approval: never',
      'sandbox: danger-full-access',
      'reasoning effort: max',
      'reasoning summaries: none',
      'session id: 00000000-0000-7000-8000-000000000099',
      '--------',
      'user',
      longEchoPrompt,
      'warning: Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.',
      '  user (C:\\config.toml): `computer_use.windows.always_allowed_app_ids` is ignored.',
      'hook: SessionStart',
      'hook: SessionStart Completed',
      'ERROR: service_tier "ultrafast" is not supported on your current plan (requires Pro-500).',
    ].join('\n');
    assert.ok(Buffer.byteLength(realisticLongStderr, 'utf8') > 6700);
    let longAttempts = 0;
    const longFallback = await runCodexExecMarkdown({
      prompt: 'Short caller prompt while mock uses full 6.8KB receipt prefix.',
      serviceTier: 'ultrafast',
      testMode: true,
      cwd: dir,
      receiptDir: join(dir, 'codex-long-fb'),
      mockExecutor: async ({ outputFilePath }) => {
        longAttempts += 1;
        if (longAttempts === 1) {
          return { exitCode: 1, stderr: realisticLongStderr };
        }
        writeFileSync(outputFilePath, 'Recovered on fallback tier.\n', 'utf8');
        return { exitCode: 0, stderr: '' };
      },
    });
    assert.equal(longAttempts, 2, '6.8KB startup banner + echoed user prompt must fall back cleanly');
    assert.equal(longFallback.tier_fallback_used, true);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Astra Round-3 Final Closure: coupon:null Buy Box snapshot, $50->$50.01 range cliff, as_of_date Keepa ingest cutoff, 2-day non-90d Keepa curve, continuous 50% Keepa + snapshot ingest, bare 50 USD coupon parity, pkg-less large_standard $0 placement, 102/104 remainder sets, missing bond, 4th sequential gate1b quote, single-product ingest --report-dir, and deferred report sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'step4-r3-final-'));
  try {
    // 1) `coupon: null` on undated Buy Box $40 snapshot MUST still be treated as coupon-blind and reject $40!
    writeFileSync(join(dir, 'r3-ss-new.json'), JSON.stringify({
      code: 'OK',
      items: [{ asin: 'B0SYNR3N14', price: 40.00, coupon: '$13.01', availableDate: '2026-11-10', monthlySales: 150 }],
    }), 'utf8');
    writeFileSync(join(dir, 'r3-bb-null-coupon.json'), JSON.stringify({
      code: 'OK',
      items: [{ asin: 'B0SYNR3N14', buyboxPrice: 40.00, coupon: null, ongoing_coupon_usd: null, ongoing_coupon_pct: null }],
    }), 'utf8');
    const candNullCpn = structuredClone(synthBatch.candidates[0]);
    candNullCpn.id = 'cand-r3-null-cpn';
    candNullCpn.screening.reference_price_usd = { value: 40.00, matched_spec: true, target_variant_asin: 'B0SYNR3N14', observed_at: '2026-11-24' };
    candNullCpn.economics.scenarios = [candNullCpn.economics.scenarios[0]];
    candNullCpn.economics.scenarios[0].price_anchor = { value: 40.00, target_variant_asin: 'B0SYNR3N14' };
    candNullCpn.economics.scenarios[0].cost_ledger.price_usd = 40.00;
    candNullCpn.economics.expected_primary_scenarios = [{ id: candNullCpn.economics.scenarios[0].id, status: 'active' }];

    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: '2026-11-24',
        raw_receipt_files: ['r3-ss-new.json', 'r3-bb-null-coupon.json'],
        candidates: [{ candidate: candNullCpn, raw_receipt_files: ['r3-ss-new.json', 'r3-bb-null-coupon.json'] }],
      }, r59Profile, { baseDir: dir }),
      /pre-coupon list price|price-binding violation/i,
    );

    // 2) `supported_price_range: [40, 50]` MUST reject scenario at `$50.01` (crosses $50.00 FBA cliff)!
    writeFileSync(join(dir, 'r3-5001.json'), JSON.stringify({
      code: 'OK',
      items: [
        { asin: 'B0SYNR3P40', price: 40.00, availableDate: '2024-01-01', monthlySales: 100 },
        { asin: 'B0SYNR3P51', price: 50.01, availableDate: '2024-01-01', monthlySales: 100 },
      ],
    }), 'utf8');
    const candRange50 = structuredClone(candNullCpn);
    candRange50.id = 'cand-r3-range50';
    candRange50.screening.reference_price_usd = {
      value: 40.00,
      supported_price_range: [40.00, 50.00],
      matched_spec: true,
      target_variant_asin: 'B0SYNR3P40',
      allow_unobserved_derived_price: true,
      observed_at: '2026-11-24',
    };
    candRange50.economics.scenarios[0].price_anchor = { value: 50.01, target_variant_asin: 'B0SYNR3P51' };
    candRange50.economics.scenarios[0].cost_ledger.price_usd = 50.01;
    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: '2026-11-24',
        raw_receipt_files: ['r3-5001.json'],
        candidates: [{ candidate: candRange50, raw_receipt_files: ['r3-5001.json'] }],
      }, r59Profile, { baseDir: dir }),
      /supported_price_range/,
    );

    // 3) Full-card ingest with `as_of_date: 2026-03-31` MUST reject April-June `$59` Keepa prices; and 2-day Keepa curve is NOT 90d steady!
    const tsJanJun = Array.from({ length: 180 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    writeFileSync(join(dir, 'r3-keepa-janjun.json'), JSON.stringify({
      code: 'OK',
      asin: 'B0SYNR3CUT',
      keepa_trend: {
        ts: tsJanJun,
        series: { price: tsJanJun.map(d => (d <= '2026-03-31' ? 39.00 : 59.00)) },
      },
    }), 'utf8');
    const candApr59 = structuredClone(candNullCpn);
    candApr59.id = 'cand-r3-apr59';
    candApr59.evidence = [{ id: 'synthetic-evidence', source: 'synth', observed_at: '2026-03-31' }];
    candApr59.newcomer_cohort.observation_date = '2026-03-31';
    candApr59.screening.reference_price_usd = { value: 59.00, matched_spec: true, target_variant_asin: 'B0SYNR3CUT', observed_at: '2026-03-31' };
    candApr59.economics.scenarios[0].price_anchor = { value: 59.00, target_variant_asin: 'B0SYNR3CUT' };
    candApr59.economics.scenarios[0].cost_ledger.price_usd = 59.00;
    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: '2026-03-31',
        raw_receipt_files: ['r3-keepa-janjun.json'],
        candidates: [{ candidate: candApr59, raw_receipt_files: ['r3-keepa-janjun.json'] }],
      }, r59Profile, { baseDir: dir }),
      /do not match|price-binding violation/i,
    );

    const parsed2Day = parseSellerSpriteKeepaPayload({
      asin: 'B0SYNR32DY',
      keepa_trend: { ts: ['2026-03-30', '2026-03-31'], series: { price: [59.00, 59.00] } },
    }, { age_days: 450 });
    assert.equal(parsed2Day.keepa_90d_steady, false, '2-day curve must NEVER certify a 90-day steady plateau');
    assert.equal(parsed2Day.keepa_90d_median_usd, null);

    // 4) Continuous 90d $59 list + 50% coupon + coupon-blind $59 snapshot MUST reject $59 on full-card ingest; bare 50 USD coupon yields $9 in both adapters!
    const ts90 = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10));
    writeFileSync(join(dir, 'r3-keepa-hvy50.json'), JSON.stringify({
      code: 'OK',
      asin: 'B0SYNR3H50',
      availableDate: '2025-01-01',
      keepa_trend: { ts: ts90, series: { price: Array(90).fill(59.00), couponHistory: Array(90).fill('50%') } },
    }), 'utf8');
    writeFileSync(join(dir, 'r3-snap59.json'), JSON.stringify({
      code: 'OK',
      items: [{ asin: 'B0SYNR3H50', price: 59.00, coupon: null }],
    }), 'utf8');
    const candHvy59 = structuredClone(candNullCpn);
    candHvy59.id = 'cand-r3-hvy59';
    candHvy59.screening.reference_price_usd = { value: 59.00, matched_spec: true, target_variant_asin: 'B0SYNR3H50', observed_at: '2026-10-29' };
    candHvy59.economics.scenarios[0].price_anchor = { value: 59.00, target_variant_asin: 'B0SYNR3H50' };
    candHvy59.economics.scenarios[0].cost_ledger.price_usd = 59.00;
    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: '2026-10-29',
        raw_receipt_files: ['r3-keepa-hvy50.json', 'r3-snap59.json'],
        candidates: [{ candidate: candHvy59, raw_receipt_files: ['r3-keepa-hvy50.json', 'r3-snap59.json'] }],
      }, r59Profile, { baseDir: dir }),
      /pre-coupon list price|price-binding violation/i,
    );

    const parsedBare50Usd = parseSellerSpriteKeepaPayload({
      asin: 'B0SYNBARE5',
      keepa_trend: { ts: ts90, series: { price: Array(90).fill(59.00), couponHistory: Array(90).fill(50) } },
    }, { age_days: 400 });
    assert.equal(parsedBare50Usd.realized_net_90d_median_usd, 9.00, 'Bare positive number 50 is $50 USD ($59 - $50 = $9), never 80-cutoff %');

    // 5) Package-less `size_tier: "large_standard"` with $0 placement MUST still require 5-carton + multi-dest proof!
    const pkgLessCand = structuredClone(synthBatch.candidates[0]);
    const pkgLessLedger = pkgLessCand.economics.scenarios[0].cost_ledger;
    delete pkgLessLedger.packages;
    const plLine = pkgLessLedger.lines.find(l => l.id === 'placement');
    plLine.amount_usd = 0;
    plLine.fee_basis = { size_tier: 'large_standard', calculator_verified: true };
    const econPkgLess = calculateEconomics(pkgLessLedger, { profileRevision: 59 });
    assert.equal(econPkgLess.status, 'pending_costs');

    const earlyPkgLess = evaluateEarlyScreen({
      profile_revision: 59,
      id: 'es-pkgless-std',
      saleable_unit: '1 set',
      price_usd: 45.00,
      fx_cny_per_usd: 7.20,
      goods_cny_per_unit: 40,
      domestic_freight_cny_per_unit: 2,
      headhaul: { usd_per_unit: 1.50, bond_included: true },
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.08,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
      fulfillment_usd: 5.50,
      placement_usd: 0,
      placement_fee_basis: { size_tier: 'large_standard', calculator_verified: true },
      storage: { cubic_feet_per_unit: 0.20, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
      collection_rate: 0.006,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    }, { profileRevision: 59 });
    assert.equal(earlyPkgLess.gate_status, 'pending');

    // 6) `allow_remainder: true` with `ordered_qty: [102, 104]` divides by 102 sets (NOT 221), and `bond_included: false` without `bond_usd_per_unit` stays pending!
    const hcNoBond = runFastProfitHealthcheck2027({
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      price_usd: 45.00,
      fx_cny_per_usd: 7.20,
      goods_cny_total: 6000,
      domestic_freight_cny_total: 200,
      headhaul: { usd_per_unit: 1.50, bond_included: false },
    });
    assert.equal(hcNoBond.realized_2027_off_peak.margin, null, 'Missing carrier bond when bond_included=false must not be treated as $0');

    const r3Db = join(dir, 'r3-cli.sqlite');
    await runCliMem(['init', '--db', r3Db]);
    const rev102Path = join(dir, 'rev-102.json');
    writeFileSync(rev102Path, JSON.stringify({
      fx_cny_per_usd: 7.20,
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      headhaul_usd: 2.20,
      quote: {
        allow_remainder: true,
        goods_cny_total: 10300,
        domestic_freight_cny_total: 150,
        sku_lines: [
          { component_id: 'body', offer_id: 'o17', sku_id: 's17', pack_multiple: 17, qty_per_saleable_set: 1, moq_qty: 17, ordered_qty: 102, unit_price_cny: 60 },
          { component_id: 'lid', offer_id: 'o13', sku_id: 's13', pack_multiple: 13, qty_per_saleable_set: 1, moq_qty: 13, ordered_qty: 104, unit_price_cny: 40 },
        ],
      },
    }), 'utf8');
    const rev102Out = await runCliMem(['reverse-1688', '--db', r3Db, '--input', rev102Path]);
    assert.equal(rev102Out.code, 0);
    assert.equal(JSON.parse(rev102Out.stdout).reverse_1688.actual_complete_sets_used, 102);

    // 7) 4th sequential single-quote `gate1b` call with a 4th distinct `factory_id` MUST exit 2 and NOT persist a 4th factory!
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const g1aSeqPath = join(dir, 'g1a-seq4.json');
    writeFileSync(g1aSeqPath, JSON.stringify({
      form: { form_id: 'form-seq-4', product_family_key: 'form-seq-4', label: 'Seq 4', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 'sc-s4', price_usd: 45, available_date: '2025-01-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 }, headhaul_usd: 1.5, collection_rate: 0.006, other_applicable_usd: 0 }],
    }), 'utf8');
    const g1aSeqRes = await runCliMem(['gate1a', '--db', r3Db, '--input', g1aSeqPath]);
    const declSeq = JSON.parse(g1aSeqRes.stdout).result.declared_scenarios[0];
    const ui = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    const esSeq = [{
      profile_revision: 59, id: declSeq.id, saleable_unit: '1 unit', price_usd: declSeq.price_usd, fx_cny_per_usd: declSeq.fx_cny_per_usd, pkg,
      headhaul: { usd_per_unit: declSeq.headhaul_usd, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      fulfillment_usd: declSeq.fulfillment_usd, placement_usd: declSeq.placement_range_usd[1],
      storage: { cubic_feet_per_unit: (12 * 8 * 4) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
      collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
    }];
    for (let k = 1; k <= 4; k++) {
      const qPath = join(dir, `seq-q${k}.json`);
      writeFileSync(qPath, JSON.stringify({
        form_id: 'form-seq-4',
        quote: {
          quote_id: `qs-${k}`, factory_id: `fac-seq-${k}`, observed_at: '2026-11-24T10:00:00Z', redacted_destination: '广东深圳', raw_readback_ref: `r-${k}`,
          goods_first_order_promotion: false, freight_first_order_promotion: false, fx_cny_per_usd: 7.2, pkg, ui_readback: ui,
          sku_lines: [{ component_id: 'unit', offer_id: `os-${k}`, sku_id: `ss-${k}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 140, regular_goods_promo_false: true }],
          goods_cny_total: 14000, domestic_freight_cny_total: 300,
        },
        early_screen_scenarios: esSeq,
      }), 'utf8');
      const qRes = await runCliMem(['gate1b', '--db', r3Db, '--input', qPath]);
      if (k <= 3) assert.equal(qRes.code, 0);
      else assert.equal(qRes.code, 2, '4th sequential factory_id via singular quote must exit 2');
    }

    // 8) `single-product` raw-receipt `ingest-trial` mode + `--report-dir` exports V4 HTML, AND `deferred` form in SQLite exports qualifying=0!
    writeFileSync(join(dir, 'sp-raw-r1.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B000000001', price: 40.00 }] }), 'utf8');
    const stLedger = openSelectionStore(r3Db);
    const att = stLedger.reserveRequestAttempt({ account_scope: 'r3-test', provider: 'sellersprite', tool_name: 'product_research', observation_cutoff_date: '2026-11-24', params: { asin: 'B000000001' }, estimated_ss_mcp_units: 1 });
    stLedger.markAttemptInFlight(att.attempt_id);
    stLedger.completeAttempt(att.attempt_id, { payload: { code: 'OK', items: [{ asin: 'B000000001', price: 40.00 }] }, ss_mcp_units: 1 });
    stLedger.close();

    const spRawCand = structuredClone(synthBatch.candidates[0]);
    spRawCand.id = 'form-sp-raw-1';
    spRawCand.screening.reference_price_usd.target_variant_asin = 'B000000001';
    const spRawSpecPath = join(dir, 'sp-raw-spec.json');
    writeFileSync(spRawSpecPath, JSON.stringify({
      profile_revision: 59,
      raw_receipt_files: ['sp-raw-r1.json'],
      candidates: [{ candidate: spRawCand, raw_receipt_files: ['sp-raw-r1.json'] }],
    }), 'utf8');
    const spRawRepDir = join(dir, 'sp-raw-report');
    const spRawRes = await runCliMem(['single-product', '--db', r3Db, '--input', spRawSpecPath, '--report-dir', spRawRepDir]);
    assert.equal(spRawRes.code, 0, spRawRes.stderr);
    const spRawJson = JSON.parse(spRawRes.stdout);
    assert.equal(spRawJson.summary.qualifying, 1);
    assert.equal(existsSync(join(spRawRepDir, 'index.html')), true);

    // Mark form-sp-raw-1 as `deferred` in SQLite -> re-exporting report MUST reflect `deferred: 1, qualifying: 0`!
    const stDefer = openSelectionStore(r3Db);
    stDefer.updateFormLifecycle('form-sp-raw-1', 'deferred', {});
    stDefer.close();
    const batchForDefPath = join(dir, 'batch-def.json');
    writeFileSync(batchForDefPath, JSON.stringify({ schema_version: 1, profile_revision: 59, candidates: [spRawCand] }), 'utf8');
    const defRepDir = join(dir, 'def-report');
    const defExpRes = await runCliMem(['export-report', '--db', r3Db, '--batch', batchForDefPath, '--profile', join(REPO_ROOT, 'docs/design/reference-profile.r59.draft.json'), '--output', defRepDir]);
    assert.equal(defExpRes.code, 0, defExpRes.stderr);
    const defExpJson = JSON.parse(defExpRes.stdout);
    assert.equal(defExpJson.summary.qualifying, 0, 'Deferred SQLite form must NOT export as qualifying');
    assert.equal(defExpJson.summary.deferred, 1);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
