import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';
import {
  analyzeMainstreamPriceBand,
  evaluateGate0CategoryBoundary,
} from '../src/price-band.mjs';
import {
  buildKeepaPeerFactsForMarketJudge,
  parseSellerSpriteKeepaPayload,
} from '../src/adapters/keepa.mjs';
import { ingestTrialSpecification } from '../src/raw-ingest.mjs';
import {
  DISCOVERY_CHANNELS,
  auditDiscoveryCoverage,
  planDiscoveryBatch,
  resolveChannelMeta,
} from '../src/discovery-channels.mjs';
import { runGate1AForForm } from '../src/pipeline.mjs';
import { openSelectionStore } from '../src/store.mjs';
import {
  STAGE4_AS_OF_DATE,
  makeDatedKeepaReceipt,
  makeGate1AScenario,
  makeSteadyPeer,
  registerStage4Form,
} from './helpers/stage4-fixtures.mjs';

const STD_PKG = { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 };
const REFERRAL_15 = {
  referral_fraction: 0.15,
  refund_admin_fraction: 0.20,
  refund_admin_cap_usd: 5.00,
  minimum_referral_usd: 0.30,
};
const FEE_CTX_2027 = {
  marketplace: 'US',
  currency: 'USD',
  package_ref: 'syn-pkg',
  sales: { from: '2027-02-01', through: '2027-10-14' },
  storage: { from: '2027-02-01', through: '2027-09-30' },
  inbound: { from: '2027-01-15', through: '2027-10-14' },
};

function makeBareGoodsProbeInput(overrides = {}) {
  return {
    profile_revision: 59,
    id: 'syn-a1-bare-goods-probe',
    saleable_unit: '1 synthetic desktop tray set',
    price_usd: 45.00,
    specific_rights_conflict: false,
    strong_date_dependency: false,
    fx_cny_per_usd: 7.20,
    order_units: 100,
    goods_cny_per_unit: 125.00,
    domestic_freight_cny_total: 500,
    first_order_promotion: false,
    pkg: STD_PKG,
    headhaul: { usd_per_unit: 0.90, bond_included: true },
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    fee_category: 'Home and Kitchen',
    referral_terms: REFERRAL_15,
    fulfillment_usd: 4.50,
    placement_usd: 0.30,
    storage: {
      cubic_feet_per_unit: (12 * 8 * 3) / 1728,
      rate_usd_per_cuft_month: 0.78,
      average_inventory_days: 45,
    },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: FEE_CTX_2027,
    collection_rate: 0.006,
    other_applicable_usd: 0,
    ...overrides,
  };
}

test('Batch A1 Req 1: evaluateEarlyScreen defaults to 1688 bare-goods screening even with visible domestic CNY freight, while keeping explicit landed-cost checks intact', () => {
  // Default call with visible domestic_freight_cny_total: 500 and NO bare_goods_screening flag -> MUST PASS on bare-goods basis
  const defaultBare = evaluateEarlyScreen(makeBareGoodsProbeInput());
  assert.equal(defaultBare.cost_basis, 'bare_goods_1688');
  assert.equal(defaultBare.gate_status, 'pass', JSON.stringify(defaultBare.reasons));
  assert.equal(defaultBare.metrics.domestic_freight_usd, 0);
  assert.ok(defaultBare.metrics.margin >= 0.30, `Expected bare-goods margin >= 30%, got ${defaultBare.metrics.margin}`);
  assert.match(defaultBare.bare_goods_disclosure ?? '', /1688 裸货价/);
  assert.equal(defaultBare.domestic_freight_advisory_cny_total, 500);
  assert.equal(defaultBare.domestic_freight_advisory?.advisory_only, true);
  assert.equal(defaultBare.domestic_freight_advisory?.excluded_from_bare_goods_margin, true);
  assert.equal(defaultBare.domestic_freight_advisory?.cny_total, 500);
  assert.equal(defaultBare.domestic_freight_advisory?.cny_per_unit, 5);
  assert.ok(
    defaultBare.domestic_freight_advisory?.landed_margin_if_incurred < 0.30,
    `Expected advisory landed side-calc margin < 30%, got ${defaultBare.domestic_freight_advisory?.landed_margin_if_incurred}`,
  );

  // Freight-only first-order promo is ignored under default bare-goods screening when goods_first_order_promotion === false
  const freightPromoBare = evaluateEarlyScreen(makeBareGoodsProbeInput({
    first_order_promotion: true,
    goods_first_order_promotion: false,
  }));
  assert.equal(freightPromoBare.cost_basis, 'bare_goods_1688');
  assert.equal(freightPromoBare.gate_status, 'pass', JSON.stringify(freightPromoBare.reasons));

  // Explicit landed-cost requests (bare_goods_screening: false OR cost_basis: 'landed_domestic_explicit') MUST deduct domestic freight and FAIL (< 30%)
  const explicitLandedFlag = evaluateEarlyScreen(makeBareGoodsProbeInput({ bare_goods_screening: false }));
  assert.equal(explicitLandedFlag.cost_basis, 'landed_domestic_explicit');
  assert.equal(explicitLandedFlag.gate_status, 'fail');
  assert.ok(explicitLandedFlag.metrics.domestic_freight_usd > 0.69);
  assert.ok(explicitLandedFlag.metrics.margin < 0.30);

  const explicitLandedBasis = evaluateEarlyScreen(makeBareGoodsProbeInput({ cost_basis: 'landed_domestic_explicit' }));
  assert.equal(explicitLandedBasis.cost_basis, 'landed_domestic_explicit');
  assert.equal(explicitLandedBasis.gate_status, 'fail');
  assert.equal(explicitLandedBasis.metrics.margin, explicitLandedFlag.metrics.margin);

  // Contradictory explicit flags throw TypeError
  assert.throws(
    () => evaluateEarlyScreen(makeBareGoodsProbeInput({ bare_goods_screening: true, cost_basis: 'landed_domestic_explicit' })),
    TypeError,
  );
  assert.throws(
    () => evaluateEarlyScreen(makeBareGoodsProbeInput({ bare_goods_screening: false, cost_basis: 'bare_goods_1688' })),
    TypeError,
  );
});

test('Batch A1 Req 2a & 2b: dated 90d Keepa steadiness provenance, strict rejection of bare legacy booleans, and strict zero-tolerance delta visibility on $49.00 -> $48.99', () => {
  // 1) Direct exploratory call without Keepa dates MUST NOT claim veteran_ge_365d_keepa_steady or keepa_dated_90d_verified: true
  const noKeepaBand = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNOK01', parent_asin: 'P0SYNNOK01', title: 'Desk Tray A', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 400 },
    { asin: 'B0SYNNOK02', parent_asin: 'P0SYNNOK02', title: 'Desk Tray B', fulfillment: 'FBA', price_usd: 52.00, monthly_units: 110, age_days: 450 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(noKeepaBand.keepa_dated_90d_verified, false);
  assert.equal(noKeepaBand.keepa_steady_provenance, 'missing');
  assert.notEqual(noKeepaBand.mature_regular_band?.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(noKeepaBand.mature_regular_band?.keepa_dated_90d_verified, false);

  // 2) Bare legacy keepa_90d_steady: true without dated curve MUST NOT claim veteran_ge_365d_keepa_steady on default calls
  //    AND MUST be rejected in strict mode (require_keepa_steady_evidence: true)!
  const bareLegacyPeers = [
    { asin: 'B0SYNLEG01', parent_asin: 'P0SYNLEG01', title: 'Desk Tray A', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 400, keepa_90d_steady: true },
    { asin: 'B0SYNLEG02', parent_asin: 'P0SYNLEG02', title: 'Desk Tray B', fulfillment: 'FBA', price_usd: 51.00, monthly_units: 110, age_days: 420, keepa_price_steady: true },
  ];
  const exploratoryLegacy = analyzeMainstreamPriceBand(bareLegacyPeers, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(exploratoryLegacy.keepa_dated_90d_verified, false);
  assert.equal(exploratoryLegacy.keepa_steady_provenance, 'legacy_boolean_unverified');
  assert.notEqual(exploratoryLegacy.mature_regular_band?.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(exploratoryLegacy.mature_regular_band?.keepa_dated_90d_verified, false);

  const strictLegacy = analyzeMainstreamPriceBand(bareLegacyPeers, {
    as_of_date: STAGE4_AS_OF_DATE,
    require_keepa_steady_evidence: true,
  });
  assert.equal(strictLegacy.mature_regular_band, null, 'Strict mode must reject bare legacy steady booleans lacking dated 90d Keepa curves');
  assert.equal(strictLegacy.mainstream_count, 0);
  assert.equal(strictLegacy.keepa_dated_90d_verified, false);
  assert.ok(
    strictLegacy.spiral_watch.every(w => w.watch_reasons.includes('legacy_keepa_steady_boolean_without_dated_curve')),
    JSON.stringify(strictLegacy.spiral_watch),
  );

  // 3) Genuine dated 90d Keepa curve DOES certify veteran_ge_365d_keepa_steady + keepa_dated_90d_verified: true
  const dated1 = makeSteadyPeer({ asin: 'B0SYNDAT01', priceUsd: 49.00, ageDays: 420 });
  const dated2 = makeSteadyPeer({ asin: 'B0SYNDAT02', priceUsd: 53.00, ageDays: 480 });
  const verifiedBand = analyzeMainstreamPriceBand([dated1, dated2], {
    as_of_date: STAGE4_AS_OF_DATE,
    require_keepa_steady_evidence: true,
  });
  assert.equal(verifiedBand.keepa_dated_90d_verified, true);
  assert.equal(verifiedBand.keepa_steady_provenance, 'dated_90d_keepa');
  assert.equal(verifiedBand.mature_regular_band?.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(verifiedBand.mature_regular_band?.keepa_dated_90d_verified, true);

  // 4) Owner Decision 2 Option 1 (STRICT, ZERO auto-tolerance cutoff!):
  //    Continuous 90d Keepa curve shifting $49.00 (45d) -> $48.99 (45d) stays keepa_90d_steady: false in observation watch,
  //    surfacing exact observed_price_min_usd, observed_price_max_usd, observed_date_start, observed_date_end, delta_usd!
  const tinyShiftReceipt = makeDatedKeepaReceipt({
    asin: 'B0SYNTINY1',
    startDate: '2026-08-30',
    days: 90,
    prices: [...Array(45).fill(49.00), ...Array(45).fill(48.99)],
  });
  const parsedTinyShift = parseSellerSpriteKeepaPayload(tinyShiftReceipt, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(parsedTinyShift.keepa_90d_steady, false, 'Zero new auto-tolerance cutoff: $49.00 -> $48.99 stays unsteady');
  assert.equal(parsedTinyShift.window_90d.observed_price_min_usd, 48.99);
  assert.equal(parsedTinyShift.window_90d.observed_price_max_usd, 49.00);
  assert.equal(parsedTinyShift.window_90d.observed_date_start, '2026-08-30');
  assert.equal(parsedTinyShift.window_90d.observed_date_end, '2026-11-27');
  assert.equal(parsedTinyShift.window_90d.delta_usd, 0.01);

  const factsTiny = buildKeepaPeerFactsForMarketJudge(parsedTinyShift);
  assert.equal(factsTiny.window_90d?.delta_usd, 0.01);

  const tinyShiftBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNTINY1',
    parent_asin: 'P0SYNTINY1',
    title: 'Desk Tray Tiny Shift',
    fulfillment: 'FBA',
    price_usd: 48.99,
    monthly_units: 140,
    age_days: 420,
    keepa_trend: tinyShiftReceipt.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(tinyShiftBand.mature_regular_band, null, 'Tiny $0.01 shift stays in observation watch without auto-tolerance');
  const tinyWatch = tinyShiftBand.spiral_watch.find(w => w.asin === 'B0SYNTINY1');
  const tinyOob = tinyShiftBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNTINY1');
  for (const row of [tinyWatch, tinyOob]) {
    assert.ok(row, 'Tiny-shift peer must appear in spiral_watch and observed_out_of_band_peers');
    assert.equal(row.observed_price_min_usd, 48.99);
    assert.equal(row.observed_price_max_usd, 49.00);
    assert.equal(row.observed_date_start, '2026-08-30');
    assert.equal(row.observed_date_end, '2026-11-27');
    assert.equal(row.delta_usd, 0.01);
  }
});

test('Batch A1 Req 2c, 2d & 2e: honest zombie-filtered older peer banner, conditional post-coupon newcomer label, and non-blocking single-parent anchor warning', () => {
  // 2c) 30d newcomer + 600d $55 <10/mo zombie -> MUST NOT show "全员 90 天内新品蓝海"
  const zombieMixed = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNEW30', parent_asin: 'P0SYNNEW30', title: 'Desk Tray New', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 80, age_days: 30 },
    { asin: 'B0SYNZMB60', parent_asin: 'P0SYNZMB60', title: 'Desk Tray Zombie', fulfillment: 'FBA', price_usd: 55.00, monthly_units: 9, age_days: 600 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(zombieMixed.all_under_90d_blue_ocean, false);
  assert.equal(zombieMixed.mature_regular_band?.all_under_90d_blue_ocean, false);
  assert.doesNotMatch(zombieMixed.top_amber_banner_zh ?? '', /全员 90 天内新品蓝海/);
  assert.ok(
    Array.isArray(zombieMixed.excluded_older_peers) && zombieMixed.excluded_older_peers.length === 1,
    'Excluded >90d low-sales zombie must be surfaced in excluded_older_peers',
  );
  assert.equal(zombieMixed.excluded_older_peers[0].asin, 'B0SYNZMB60');
  assert.equal(zombieMixed.excluded_older_peers[0].reason_code, 'excluded_low_sales_zombie');
  assert.match(zombieMixed.top_amber_banner_zh ?? '', /B0SYNZMB60|僵尸|过滤/);

  // 2d) All-newcomer pool strictly with >=20% heavy coupon and no steady Keepa history -> MUST NOT claim ex_heavy_coupon!
  const heavyNewcomerOnly = analyzeMainstreamPriceBand([
    { asin: 'B0SYNHVC01', parent_asin: 'P0SYNHVC01', title: 'Desk Tray Heavy Coupon', fulfillment: 'FBA', price_usd: 50.00, coupon: '30%', monthly_units: 70, age_days: 65 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(heavyNewcomerOnly.mature_regular_band?.p50_usd, 35.00);
  assert.doesNotMatch(heavyNewcomerOnly.mature_regular_band?.basis ?? '', /ex_heavy_coupon/);
  assert.equal(heavyNewcomerOnly.mature_regular_band?.conditional_post_coupon_observation, true);
  assert.equal(heavyNewcomerOnly.mature_regular_band?.heavy_coupon_excluded, false);
  assert.match(heavyNewcomerOnly.mature_regular_band?.label_zh ?? '', /有条件券后观察|未剔除/);

  // 2e) Single-parent-ASIN anchor warning (non-blocking) for both single-parent band and single-parent high-price outlier
  const singleParentBand = analyzeMainstreamPriceBand([
    makeSteadyPeer({ asin: 'B0SYNSNG01', parent_asin: 'P0SYNSNG01', priceUsd: 49.99, ageDays: 420 }),
  ], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(singleParentBand.mature_regular_band?.single_parent_anchor_warning, true);
  assert.equal(singleParentBand.guardrail.single_parent_anchor_warning, true);
  assert.equal(singleParentBand.guardrail.advisory_only, true);
  assert.equal(singleParentBand.guardrail.never_triggers_elimination, true);
  assert.equal(singleParentBand.guardrail.low_peer_blocks_gate1a, false);
  assert.match(singleParentBand.mature_regular_band?.single_parent_anchor_note_zh ?? '', /单父体/);

  const highOutlierBand = analyzeMainstreamPriceBand([
    makeSteadyPeer({ asin: 'B0SYNMP001', parent_asin: 'P0SYNMP001', priceUsd: 38.00, ageDays: 420 }),
    makeSteadyPeer({ asin: 'B0SYNMP002', parent_asin: 'P0SYNMP002', priceUsd: 40.00, ageDays: 450 }),
    makeSteadyPeer({ asin: 'B0SYNMP003', parent_asin: 'P0SYNMP003', priceUsd: 59.99, ageDays: 500 }),
  ], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(highOutlierBand.mature_regular_band?.single_parent_anchor_warning, false);
  assert.equal(highOutlierBand.mature_regular_band?.high_price_single_parent_anchor_warning, true);
  assert.equal(highOutlierBand.mature_regular_band?.high_price_single_parent_anchor?.parent_asin, 'P0SYNMP003');
  assert.equal(highOutlierBand.mature_regular_band?.high_price_single_parent_anchor?.max_price_usd, 59.99);
  assert.equal(highOutlierBand.mature_regular_band?.high_price_single_parent_anchor?.remaining_max_price_usd, 40.00);
  assert.equal(highOutlierBand.guardrail.advisory_only, true);
});

test('Batch A1 Req 3: Gate-0 blocks/flags age_group: adult conflicting with explicit child-use or <=12y statutory text while preserving adult exemptions', () => {
  // Conflicting child-use items labeled age_group: 'adult' MUST NOT pass cleanly
  const learningTower = evaluateGate0CategoryBoundary({
    title: 'Toddler learning tower ages 2-4',
    age_group: 'adult',
  });
  assert.equal(learningTower.passed, false);
  assert.equal(learningTower.hard_exclusion, true);
  assert.equal(learningTower.verdict, 'excluded_childrens_product');
  assert.equal(learningTower.metadata_conflict, true);
  assert.equal(learningTower.statutory_review_required, true);

  const babyPlate = evaluateGate0CategoryBoundary({
    title: 'Silicone Baby Plate with Suction Base',
    age_group: 'adult',
  });
  assert.equal(babyPlate.passed, false);
  assert.equal(babyPlate.metadata_conflict, true);

  const numericAgeConflict = evaluateGate0CategoryBoundary({
    title: 'Wooden Kitchen Helper Stool',
    age_group: 'adult',
    max_target_age_years: 4,
  });
  assert.equal(numericAgeConflict.passed, false);
  assert.equal(numericAgeConflict.metadata_conflict, true);

  // Legitimate adult exemptions labeled age_group: 'adult' MUST still pass cleanly
  const adultExemptions = [
    { title: 'Baby Grand Piano Cover Waterproof Dust Protector', age_group: 'adult' },
    { title: 'Plastic Nursery Plant Pots 1 Gallon 50 Pack', age_group: 'adult' },
    { title: 'Floating Wood Nursery Shelf for Bedding Storage', age_group: 'adult' },
    { title: 'Waterproof Diaper Bag Backpack for Parents', age_group: 'adult' },
    { title: '5/8-inch Baby Plate Wall Mount for Studio Lighting Grip', age_group: 'adult' },
    { title: 'Baby Blue Braided Fishing Line - Keep away from children', age_group: 'adult' },
  ];
  for (const item of adultExemptions) {
    const res = evaluateGate0CategoryBoundary(item);
    assert.equal(res.passed, true, `Expected adult exemption to pass: ${item.title}`);
    assert.equal(res.hard_exclusion, false);
  }
});

test('Batch A1 Req 4: Keepa newcomer review jump (+N) and drop (-N) preserve exact provenance end-to-end through raw-ingest', () => {
  const ts = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
  const jumpDropPayload = {
    asin: 'B0SYNREV01',
    keepa_trend: {
      ts,
      series: {
        price: [45, 45, 45, 45, 45],
        reviews: [2, 3, 35, 32, 36],
      },
    },
  };
  const parsed = parseSellerSpriteKeepaPayload(jumpDropPayload, { age_days: 45, as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(parsed.review_trajectory.has_jump_event, true);
  assert.equal(parsed.review_trajectory.has_drop_event, true);
  assert.equal(parsed.review_trajectory.newcomer_review_anomaly_hint, true);
  const bigJump = parsed.review_trajectory.events.find(e => e.direction === 'jump' && e.delta === 32);
  assert.deepEqual(
    {
      direction: bigJump?.direction,
      delta: bigJump?.delta,
      from_count: bigJump?.from_count,
      to_count: bigJump?.to_count,
      date_from: bigJump?.date_from,
      date_to: bigJump?.date_to,
      asin: bigJump?.asin,
    },
    {
      direction: 'jump',
      delta: 32,
      from_count: 3,
      to_count: 35,
      date_from: '2026-10-02',
      date_to: '2026-10-03',
      asin: 'B0SYNREV01',
    },
  );
  const dropEv = parsed.review_trajectory.events.find(e => e.direction === 'drop' && e.delta === -3);
  assert.equal(dropEv?.from_count, 35);
  assert.equal(dropEv?.to_count, 32);
  assert.equal(dropEv?.date_from, '2026-10-03');
  assert.equal(dropEv?.date_to, '2026-10-04');
  assert.equal(dropEv?.asin, 'B0SYNREV01');

  // Undated curve must emit date_from: null, date_to: null (never invent dates)
  const undatedJump = parseSellerSpriteKeepaPayload({
    asin: 'B0SYNREV02',
    series: { price: [45, 45, 45], reviews: [2, 3, 35] },
  }, { age_days: 30 });
  assert.equal(undatedJump.review_trajectory.has_jump_event, true);
  assert.equal(undatedJump.review_trajectory.newcomer_review_anomaly_hint, true);
  assert.equal(undatedJump.review_trajectory.events[0].date_from, null);
  assert.equal(undatedJump.review_trajectory.events[0].date_to, null);

  // End-to-end raw-ingest propagation onto newcomer_cohort.members[] matching board #120 contract
  const r59Profile = JSON.parse(
    readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
  );
  const jumpOnlyPayload = {
    asin: 'B0SYNREV03',
    keepa_trend: {
      ts: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
      series: {
        price: [45, 45, 45, 45],
        reviews: [2, 3, 35, 36],
      },
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'batch-a1-rev-'));
  try {
    writeFileSync(join(tmpDir, 'keepa-jump-drop.json'), JSON.stringify(jumpDropPayload), 'utf8');
    writeFileSync(join(tmpDir, 'keepa-jump-only.json'), JSON.stringify(jumpOnlyPayload), 'utf8');
    const ingested = ingestTrialSpecification({
      profile_revision: 59,
      as_of_date: STAGE4_AS_OF_DATE,
      raw_receipt_files: ['keepa-jump-drop.json', 'keepa-jump-only.json'],
      candidates: [{
        id: 'cand-syn-rev-jump',
        label: 'Synthetic Review Jump Candidate',
        newcomer_cohort: {
          members: [
            {
              asin: 'B0SYNREV01',
              parent_asin: 'P0SYNREV01',
              age_days: 45,
              monthly_units: 95,
              rating: 4.5,
              reviews: 36,
            },
            {
              asin: 'B0SYNREV03',
              parent_asin: 'P0SYNREV03',
              age_days: 40,
              monthly_units: 80,
              rating: 4.6,
              reviews: 36,
            },
          ],
        },
        peer_listings: [
          { asin: 'B0SYNLEG99', title: 'Bare Legacy Peer', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 400, keepa_90d_steady: true },
        ],
      }],
    }, r59Profile, { baseDir: tmpDir });
    const member = ingested.batch.candidates[0].newcomer_cohort.members[0];
    assert.equal(member.keepa_review_jump_detected, true);
    assert.equal(member.keepa_review_drop_detected, true);
    assert.ok(Array.isArray(member.keepa_review_anomaly_events) && member.keepa_review_anomaly_events.length === 4);
    assert.equal(member.keepa_review_anomaly_summary?.asin, 'B0SYNREV01');
    assert.equal(member.keepa_review_anomaly_summary?.parent_asin, 'P0SYNREV01');
    assert.equal(member.keepa_review_anomaly_summary?.has_jump, true);
    assert.equal(member.keepa_review_anomaly_summary?.has_drop, true);
    assert.equal(member.keepa_review_anomaly_summary?.max_jump_delta, 32);
    assert.equal(member.keepa_review_anomaly_summary?.max_drop_delta, -3);
    assert.equal(member.keepa_review_anomaly_summary?.largest_jump?.delta, 32);
    assert.equal(member.keepa_review_anomaly_summary?.largest_drop?.delta, -3);
    assert.match(member.keepa_review_anomaly_summary?.note_zh ?? '', /\+32/);
    assert.match(member.keepa_review_anomaly_summary?.note_zh ?? '', /-3/);

    const jumpOnlyMember = ingested.batch.candidates[0].newcomer_cohort.members[1];
    assert.equal(jumpOnlyMember.keepa_review_jump_detected, true);
    assert.equal(jumpOnlyMember.keepa_review_drop_detected, undefined);
    assert.equal(jumpOnlyMember.keepa_review_anomaly_summary?.has_jump, true);
    assert.equal(jumpOnlyMember.keepa_review_anomaly_summary?.has_drop, false);
    assert.equal(jumpOnlyMember.keepa_review_anomaly_summary?.max_jump_delta, 32);
    assert.equal(jumpOnlyMember.keepa_review_anomaly_summary?.max_drop_delta, 0);
    assert.equal(jumpOnlyMember.keepa_review_anomaly_summary?.largest_drop, null);

    // raw-ingest must also enforce strict dated Keepa mode on entry.peer_listings!
    assert.equal(
      ingested.batch.candidates[0].price_band_analysis?.mature_regular_band,
      null,
      'raw-ingest strict mode must reject bare legacy keepa_90d_steady: true without dated curve',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Batch A1 Req 5: retires ss_vine_sustained_traction from planDiscoveryBatch while keeping read-only historical lookup intact', () => {
  assert.equal(DISCOVERY_CHANNELS.ss_vine_sustained_traction.active, false);
  assert.equal(DISCOVERY_CHANNELS.ss_vine_sustained_traction.retired, true);

  const metaDirect = resolveChannelMeta('ss_vine_sustained_traction');
  const metaAlias = resolveChannelMeta('vine_traction');
  assert.equal(metaDirect.channel_id, 'ss_vine_sustained_traction');
  assert.equal(metaDirect.known_channel, true);
  assert.equal(metaAlias.channel_id, 'ss_vine_sustained_traction');

  const store = openSelectionStore(':memory:');
  try {
    // Historical read-only Vine lead still audits cleanly
    store.upsertRawLead({
      lead_id: 'lead-hist-vine-1',
      source_channel: 'vine_traction',
      source_ref: 'https://example.com/hist-vine',
      phrase_or_title: 'Historical Vine Sample Lead',
      observed_at: STAGE4_AS_OF_DATE,
      disposition: 'product',
    });
    const cov = auditDiscoveryCoverage(store, { as_of_date: STAGE4_AS_OF_DATE });
    assert.equal(cov.channels.ss_vine_sustained_traction, 1);
    assert.equal(cov.available_untested_channels.includes('ss_vine_sustained_traction'), false);
    assert.equal(cov.retired_channels.includes('ss_vine_sustained_traction'), true);
    assert.equal(cov.deferred_channels.includes('ss_vine_sustained_traction'), false);

    // Active recommendations MUST NEVER include ss_vine_sustained_traction under any mode
    for (const opts of [
      { as_of_date: STAGE4_AS_OF_DATE, max_channels: 30 },
      { as_of_date: STAGE4_AS_OF_DATE, max_channels: 30, include_deferred: true },
      { as_of_date: STAGE4_AS_OF_DATE, task_slots: 30, enforce_80_20_mix: true },
      { as_of_date: STAGE4_AS_OF_DATE, task_slots: 30, enforce_80_20_mix: true, include_deferred: true },
    ]) {
      const plan = planDiscoveryBatch(store, opts);
      assert.equal(
        plan.recommended_channels.some(c => c.channel_id === 'ss_vine_sustained_traction'),
        false,
        `ss_vine_sustained_traction must never be recommended for opts=${JSON.stringify(opts)}`,
      );
      assert.equal(plan.retired_channels.includes('ss_vine_sustained_traction'), true);
    }
  } finally {
    store.close();
  }
});

test('Batch A1 Round-1 Astra Regressions (#1–#14): Gate-0 caregiver/0-2 range, strict Keepa summary/gap/promo/age/scalar guards, upper-band anchor noise, coupon denominator, multi-receipt review merge, missing-price older peer, and conflicting advisory freight', () => {
  // #1: Adult caregiver products with crib / 1-2y supplies pass, while 0-2 years old child toy is blocked
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Baby Monitor Crib Mount for Parents', age_group: 'adult' }).passed, true);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Diaper Bag for 1-2 years old supplies', age_group: 'adult' }).passed, true);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Diaper Bag for 0-2 years old supplies', age_group: 'adult' }).passed, true);
  const child02 = evaluateGate0CategoryBoundary({ title: 'Wooden Shape Sorter for Children 0-2 years old', age_group: 'adult' });
  assert.equal(child02.passed, false);
  assert.equal(child02.metadata_conflict, true);

  // #3: High-price peer with bare legacy boolean keeps veteran_missing_keepa_steady_evidence as reason_code -> Gate 1A holds for verification (not hard-rejected!)
  const store = openSelectionStore(':memory:');
  try {
    const formId = registerStage4Form(store, { formId: 'form-a1-r1-reason' });
    const lowSteady = makeSteadyPeer({ asin: 'B0SYNLOW25', priceUsd: 25.00, ageDays: 420 });
    const highLegacyBool = {
      asin: 'B0SYNHIG49',
      parent_asin: 'P0SYNHIG49',
      title: 'Desk Tray High Legacy',
      fulfillment: 'FBA',
      price_usd: 49.00,
      monthly_units: 120,
      age_days: 420,
      keepa_price_steady: true,
    };
    const g1aHold = runGate1AForForm(store, {
      form_id: formId,
      profile_revision: 59,
      price_band_analysis: { listings: [lowSteady, highLegacyBool], options: { as_of_date: STAGE4_AS_OF_DATE } },
      scenarios: [makeGate1AScenario({ asin: 'B0SYNLOW25', priceUsd: 25.00, ageDays: 420 })],
    });
    assert.equal(g1aHold.gate_status, 'gate1a_needs_verification');
    const directStrict = analyzeMainstreamPriceBand([lowSteady, highLegacyBool], {
      as_of_date: STAGE4_AS_OF_DATE,
      require_keepa_steady_evidence: true,
    });
    const oobHigh = directStrict.observed_out_of_band_peers.find(p => p.asin === 'B0SYNHIG49');
    assert.equal(oobHigh?.reason_code, 'veteran_missing_keepa_steady_evidence');
    assert.equal(
      directStrict.spiral_watch.find(w => w.asin === 'B0SYNHIG49')?.watch_reasons.includes('legacy_keepa_steady_boolean_without_dated_curve'),
      true,
    );
  } finally {
    store.close();
  }

  // #4: Undated, stale (ended 2026-03-31 vs 2026-11-27), and wrong-ASIN keepa_peer_facts MUST be rejected in strict mode
  const undatedFactsPeer = {
    asin: 'B0SYNUNDF1', title: 'Undated Facts', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420,
    keepa_peer_facts: { has_timestamps: true, keepa_90d_steady: true },
  };
  assert.equal(analyzeMainstreamPriceBand([undatedFactsPeer], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true }).mature_regular_band, null);

  const staleParsed = parseSellerSpriteKeepaPayload(
    makeDatedKeepaReceipt({ asin: 'B0SYNSTAL1', startDate: '2026-01-01', days: 90, priceUsd: 49.00 }),
    { as_of_date: '2026-03-31' },
  );
  const staleFactsPeer = {
    asin: 'B0SYNSTAL1', title: 'Stale Facts', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420,
    keepa_peer_facts: buildKeepaPeerFactsForMarketJudge(staleParsed),
  };
  assert.equal(analyzeMainstreamPriceBand([staleFactsPeer], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true }).mature_regular_band, null);

  const currentOtherParsed = parseSellerSpriteKeepaPayload(
    makeDatedKeepaReceipt({ asin: 'B0SYNOTHR1', startDate: '2026-08-30', days: 90, priceUsd: 49.00 }),
    { as_of_date: STAGE4_AS_OF_DATE },
  );
  const wrongAsinFactsPeer = {
    asin: 'B0SYNWRNG1', title: 'Wrong ASIN Facts', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420,
    keepa_peer_facts: buildKeepaPeerFactsForMarketJudge(currentOtherParsed),
  };
  assert.equal(analyzeMainstreamPriceBand([wrongAsinFactsPeer], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true }).mature_regular_band, null);

  // #5 & #12: temporary_event_promo: true MUST NOT bypass $49.00 -> $48.99 unsteady curve, and ai_reason_zh preserves factual delta detail
  const tinyShift = makeDatedKeepaReceipt({
    asin: 'B0SYNTMP01', startDate: '2026-08-30', days: 90,
    prices: [...Array(45).fill(49.00), ...Array(45).fill(48.99)],
  });
  const promoUnsteadyBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNTMP01', title: 'Promo Unsteady', fulfillment: 'FBA', price_usd: 48.99, monthly_units: 120, age_days: 420,
    temporary_event_promo: true,
    ai_reason_zh: '常规微调观察',
    keepa_trend: tinyShift.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(promoUnsteadyBand.mature_regular_band, null);
  const oobPromo = promoUnsteadyBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNTMP01');
  assert.match(oobPromo?.reason_zh ?? '', /常规微调观察/);
  assert.match(oobPromo?.reason_zh ?? '', /0\.01/);
  assert.match(oobPromo?.reason_zh ?? '', /2026-08-30/);

  // #6: Missing age_days + flat dated 90d Keepa MUST NOT claim veteran_ge_365d_keepa_steady
  const unagedFlatBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNUNAG1', title: 'Unaged Flat', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120,
    keepa_trend: makeDatedKeepaReceipt({ asin: 'B0SYNUNAG1', startDate: '2026-08-30', days: 90, priceUsd: 49.00 }).keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(unagedFlatBand.mature_regular_band?.basis, 'unaged_keepa_90d_steady_reference');

  // #7: Undated scalar keepa_90d_median_usd: 50 MUST NOT lift heavy-coupon newcomer $35 -> $50 or emit ex_heavy_coupon
  const heavyScalarBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNHVSC1', title: 'Heavy Coupon Scalar', fulfillment: 'FBA', price_usd: 50.00, coupon: '30%',
    monthly_units: 90, age_days: 65, keepa_90d_median_usd: 50.00,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(heavyScalarBand.mature_regular_band?.p50_usd, 35.00);
  assert.equal(heavyScalarBand.mature_regular_band?.conditional_post_coupon_observation, true);
  assert.equal(heavyScalarBand.mature_regular_band?.heavy_coupon_excluded, false);
  assert.doesNotMatch(heavyScalarBand.mature_regular_band?.basis ?? '', /ex_heavy_coupon/);

  // #8: Normal multi-parent pool ($38/$39/$40 with sales 180/180/10, P75=$39) MUST NOT fire high_price_single_parent_anchor_warning
  const normalPool = analyzeMainstreamPriceBand([
    makeSteadyPeer({ asin: 'B0SYNNRM01', parent_asin: 'P0SYNNRM01', priceUsd: 38.00, monthlyUnits: 180, ageDays: 420 }),
    makeSteadyPeer({ asin: 'B0SYNNRM02', parent_asin: 'P0SYNNRM02', priceUsd: 39.00, monthlyUnits: 180, ageDays: 450 }),
    makeSteadyPeer({ asin: 'B0SYNNRM03', parent_asin: 'P0SYNNRM03', priceUsd: 40.00, monthlyUnits: 10, ageDays: 480 }),
  ], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(normalPool.mature_regular_band?.p75_usd, 39.00);
  assert.equal(normalPool.mature_regular_band?.high_price_single_parent_anchor_warning, false);
  assert.equal(normalPool.guardrail.high_price_single_parent_anchor_warning, false);

  // #9: Coupon $5 fixed-fee denominator stays decoupled from procurement order_units (100 vs 500 identical when coupon_campaign_units omitted!)
  const couponOrder100 = evaluateEarlyScreen(makeBareGoodsProbeInput({
    list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99, order_units: 100,
  }));
  const couponOrder500 = evaluateEarlyScreen(makeBareGoodsProbeInput({
    list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99, order_units: 500,
  }));
  assert.equal(couponOrder100.metrics.margin, couponOrder500.metrics.margin);
  const otherLine500 = couponOrder500.ledger.lines.find(l => l.id === 'other_applicable');
  assert.equal(otherLine500?.coupon_campaign_units, 100);
  assert.equal(otherLine500?.include_coupon_campaign_flat, true);

  const couponNoFlat = evaluateEarlyScreen(makeBareGoodsProbeInput({
    list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99, order_units: 500, include_coupon_campaign_flat: false,
  }));
  assert.equal(couponNoFlat.ledger.lines.find(l => l.id === 'other_applicable')?.include_coupon_campaign_flat, false);
  assert.equal(couponNoFlat.ledger.include_coupon_campaign_flat, false);

  const calcCoupon500 = calculateEconomics({
    id: 'syn-calc-coupon', saleable_unit: '1 unit', assumptions: ['synthetic'],
    list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99,
    refund_fraction: 0.04, order_units: 500, bare_goods_screening: true,
    lines: [
      { id: 'procurement', amount_usd: 12, status: 'estimated', basis: 'goods' },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'sea' },
      { id: 'referral', amount_usd: 6.53, status: 'estimated', basis: 'ref' },
      { id: 'fulfillment', amount_usd: 5.5, status: 'estimated', basis: 'fba' },
      { id: 'placement', amount_usd: 0.3, status: 'estimated', basis: 'pl' },
      { id: 'storage', amount_usd: 0.1, status: 'estimated', basis: 'st' },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'ret' },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'def' },
      { id: 'collection', amount_usd: 0.18, status: 'estimated', basis: 'col' },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'none' },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'def' },
    ],
  }, { profileRevision: 59 });
  assert.equal(calcCoupon500.coupon_campaign_units, 100);
  assert.equal(calcCoupon500.lines.find(l => l.id === 'other_applicable')?.coupon_campaign_units, 100);

  // #10: 2-endpoint 88-day-gap Keepa curve MUST fail keepa_90d_steady just like 88-null curve
  const twoEndpointParsed = parseSellerSpriteKeepaPayload({
    asin: 'B0SYNGAP01',
    keepa_trend: {
      ts: ['2026-08-30', '2026-11-27'],
      series: { price: [49.00, 49.00] },
    },
  }, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(twoEndpointParsed.keepa_90d_steady, false);
  assert.equal(twoEndpointParsed.regular_median_usd, null);

  // #13: Missing-price >90d matched FBA peer suppresses false "全员 90 天内新品蓝海" banner
  const missingPriceOlder = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNW30A', parent_asin: 'P0SYNNW30A', title: 'Desk Tray New', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 80, age_days: 30 },
    { asin: 'B0SYNMP600', parent_asin: 'P0SYNMP600', title: 'Desk Tray Missing Price Older', fulfillment: 'FBA', price_usd: null, monthly_units: 40, age_days: 600 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(missingPriceOlder.all_under_90d_blue_ocean, false);
  assert.doesNotMatch(missingPriceOlder.top_amber_banner_zh ?? '', /全员 90 天内新品蓝海/);
  assert.equal(missingPriceOlder.excluded_older_peers?.some(p => p.asin === 'B0SYNMP600' && p.reason_code === 'excluded_invalid_price'), true);

  // #14: Conflicting domestic_freight_cny_total vs domestic_freight_cny_per_unit leaves advisory landed margin null + conflict flag; missing refund keeps advisory object
  const conflictingFreight = evaluateEarlyScreen(makeBareGoodsProbeInput({
    domestic_freight_cny_total: 500,
    domestic_freight_cny_per_unit: 0,
  }));
  assert.equal(conflictingFreight.gate_status, 'pass');
  assert.equal(conflictingFreight.domestic_freight_advisory?.conflict_detected, true);
  assert.equal(conflictingFreight.domestic_freight_advisory?.cny_per_unit, null);
  assert.equal(conflictingFreight.domestic_freight_advisory?.landed_margin_if_incurred, null);

  const missingRefundAdvisory = evaluateEarlyScreen(makeBareGoodsProbeInput({ refund_fraction: undefined }));
  assert.equal(missingRefundAdvisory.gate_status, 'pending');
  assert.equal(missingRefundAdvisory.domestic_freight_advisory?.cny_total, 500);
  assert.equal(missingRefundAdvisory.domestic_freight_advisory?.advisory_only, true);

  // #2 & #11: raw-ingest equal-ASIN multi-receipt review merge (order-invariant), empty []/{} backfill, custom-events summary consistency, and strict quantile check
  const r59Profile = JSON.parse(
    readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
  );
  const tmpDir = mkdtempSync(join(tmpdir(), 'batch-a1-r1-merge-'));
  try {
    const revOnly = {
      asin: 'B0SYNMRG01',
      keepa_trend: {
        ts: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
        series: { price: [45, 45, 45, 45], reviews: [0, null, 5, 1] },
      },
    };
    const priceOnly = makeDatedKeepaReceipt({ asin: 'B0SYNMRG01', startDate: '2026-08-30', days: 90, priceUsd: 45.00 });
    writeFileSync(join(tmpDir, 'rev-only.json'), JSON.stringify(revOnly), 'utf8');
    writeFileSync(join(tmpDir, 'price-only.json'), JSON.stringify(priceOnly), 'utf8');
    const makeSpec = files => ({
      profile_revision: 59,
      as_of_date: STAGE4_AS_OF_DATE,
      raw_receipt_files: files,
      candidates: [{
        id: 'cand-mrg',
        label: 'Multi Receipt Merge',
        newcomer_cohort: {
          members: [
            {
              asin: 'B0SYNMRG01',
              parent_asin: 'P0SYNMRG01',
              age_days: 45,
              monthly_units: 80,
              rating: 4.5,
              reviews: 1,
              keepa_review_drop_detected: false,
              keepa_review_jump_detected: false,
              keepa_review_anomaly_events: [],
              keepa_review_anomaly_summary: {},
            },
            {
              asin: 'B0SYNMRG01',
              parent_asin: 'P0SYNMRG01',
              age_days: 45,
              monthly_units: 80,
              rating: 4.5,
              reviews: 1,
              keepa_review_anomaly_events: [{ direction: 'jump', delta: 1, from_count: 0, to_count: 1, date_from: '2026-10-01', date_to: '2026-10-02', asin: 'B0SYNMRG01' }],
            },
          ],
        },
      }],
    });
    const orderAB = ingestTrialSpecification(makeSpec(['rev-only.json', 'price-only.json']), r59Profile, { baseDir: tmpDir });
    const orderBA = ingestTrialSpecification(makeSpec(['price-only.json', 'rev-only.json']), r59Profile, { baseDir: tmpDir });
    for (const run of [orderAB, orderBA]) {
      const m0 = run.batch.candidates[0].newcomer_cohort.members[0];
      assert.equal(m0.keepa_review_jump_detected, true);
      assert.equal(m0.keepa_review_drop_detected, true);
      assert.equal(m0.keepa_review_anomaly_events.length, 2);
      assert.equal(m0.keepa_review_anomaly_summary.max_jump_delta, 5);
      assert.equal(m0.keepa_review_anomaly_summary.max_drop_delta, -4);
      const m1 = run.batch.candidates[0].newcomer_cohort.members[1];
      assert.equal(m1.keepa_review_anomaly_summary.event_count, 1, 'Summary must stay consistent with existing non-empty events[]');
      assert.equal(m1.keepa_review_anomaly_summary.max_jump_delta, 1);
    }

    // #2: raw-ingest extractQuantileSupportedPricesFromPayloads enforces require_keepa_steady_evidence: true
    // so bare legacy Keepa booleans in raw search items cannot validate an unreferenced $59 scenario price
    const rawSearchLegacyPath = join(tmpDir, 'search-legacy-bool.json');
    writeFileSync(rawSearchLegacyPath, JSON.stringify({
      items: [
        { asin: 'B0SYNLQ001', title: 'Desk Tray A', fulfillment: 'FBA', price_usd: 49.00, monthlySales: 120, age_days: 400, keepa_90d_steady: true },
        { asin: 'B0SYNLQ002', title: 'Desk Tray B', fulfillment: 'FBA', price_usd: 59.00, monthlySales: 120, age_days: 400, keepa_90d_steady: true },
      ],
    }), 'utf8');
    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        as_of_date: STAGE4_AS_OF_DATE,
        raw_receipt_files: ['search-legacy-bool.json'],
        evidence: [{ id: 'ev-lq', source_type: 'sellersprite', observed_at: STAGE4_AS_OF_DATE, summary: 'Raw search' }],
        candidates: [{
          id: 'cand-lq-strict',
          label: 'Legacy Quantile Reject',
          screening: {
            reference_price_usd: { value: 59.00, supported_price_range: [49.00, 59.00], unit: 'USD', matched_spec: true, evidence: ['ev-lq'] },
          },
          economics: {
            saleable_unit: '1 unit',
            scenarios: [{
              id: 'sc-59',
              label: 'Unverified 59',
              price_anchor: { value: 59.00, unit: 'USD', matched_spec: true, fulfillment_channel: 'FBA', evidence: ['ev-lq'] },
              cost_ledger: {
                id: 'sc-59', saleable_unit: '1 unit', price_usd: 59.00, refund_fraction: 0.04,
                lines: [
                  { id: 'procurement', amount_usd: 15, status: 'estimated', basis: 'goods' },
                  { id: 'domestic_freight', amount_usd: 0, status: 'not_applicable', basis: 'bare' },
                ],
              },
            }],
          },
        }],
      }, r59Profile, { baseDir: tmpDir }),
      /not backed by any referenced comparable ASIN or denoised P25\/P50\/P75 quantile/i,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
