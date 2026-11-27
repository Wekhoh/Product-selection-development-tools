import test from 'node:test';
import assert from 'node:assert/strict';
import { makeOversizeScreeningInputs } from './helpers/test-fixtures.mjs';
import {
  VERIFIED_2027_RETURN_THRESHOLDS,
  lookupVerified2027ReturnThreshold,
  resolveEffectivePricing,
} from '../src/fba-calculator.mjs';
import {
  classifyStandardSize2027,
  classifySizeTier2027,
  lookupFulfillmentFee2027,
  lookupBulkyFulfillmentFee2027,
  lookupBulkyStorageFee2027,
  lookupBulkyPlacementFee2027,
  lookupBulkyReturnsProcessing2027,
  lookupBulkyPackagingServiceFee2027,
  validateGuestRevcalReadback,
  computeMatchedPeerMedianPackage,
  checkMatureBandMarginFeasibility2027,
  estimateGate1A2027,
  solveMinPriceForMargin2027,
} from '../src/fba-calculator.mjs';
import {
  resolveCategoryReturnWithFallback,
  evaluateGoogleTrendsSeries,
  resolveTargetChildSalesObservation,
  deduplicateParentSalesRows,
  classifyKeepaReviewTrajectory,
} from '../src/observations.mjs';
import {
  analyzeMainstreamPriceBand,
  parseSingleUnitUsdCoupon,
  splitSearchPageSubForms,
} from '../src/price-band.mjs';
import {
  resolveChannelMeta,
  planDiscoveryBatch,
} from '../src/discovery-channels.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { runGate1AForForm, runGate1BForForm } from '../src/pipeline.mjs';
import {
  buildStage1DecisionsRequests,
  buildRightsPreScreenRequest,
  resolveRelevantRegulatoryFrameworks,
} from '../src/openai/workflow-tasks.mjs';
import { DEFAULT_SYNC_TIMEOUT_MS } from '../src/openai/client.mjs';

test('Seam 1: all 36 official US FBA return thresholds, 2027 Bulky 4 tiers, Guest revcalpublic anti-429 guard, peer median pkg, and $50.00 interior cliff check', () => {
  // 1) All 36 official US FBA return categories + common aliases
  const requiredOfficial = {
    '3D Printers': 0.06,
    'Amazon Device Accessories': 0.113,
    'Amazon Explore': 0.048,
    'Automotive and Powersports': 0.091,
    'Baby Products': 0.093,
    'Backpacks, Handbags, and Luggage': 0.128,
    'Base Equipment Power Tools': 0.071,
    'Beauty, Health, and Personal Care': 0.055,
    'Business, Industrial, and Scientific Supplies': 0.06,
    'Compact Appliances': 0.126,
    Computers: 0.114,
    'Consumer Electronics': 0.112,
    'Electronics Accessories': 0.088,
    'Everything Else': 0.048,
    Eyewear: 0.121,
    'Fine Art': 0.056,
    'Full-Size Appliances': 0.119,
    Furniture: 0.096,
    'Gift Cards': 0.048,
    'Grocery and Gourmet': 0.029,
    'Home and Kitchen': 0.081,
    Jewelry: 0.108,
    'Lawn and Garden': 0.077,
    'Lawn mowers and Snow Throwers': 0.095,
    Mattresses: 0.093,
    'Media - Books, DVD, Music, Software, Video': 0.051,
    'Musical Instruments and AV Production': 0.092,
    'Office Products': 0.044,
    'Pet Products': 0.102,
    'Sports and Outdoors': 0.087,
    Tires: 0.087,
    'Tools and Home Improvement': 0.087,
    'Toys and Games': 0.047,
    'Video Game Consoles': 0.107,
    'Video Games and Gaming Accessories': 0.065,
    Watches: 0.12,
  };
  assert.ok(Object.keys(VERIFIED_2027_RETURN_THRESHOLDS).length >= 36);
  for (const [cat, thr] of Object.entries(requiredOfficial)) {
    const match = lookupVerified2027ReturnThreshold(cat);
    assert.ok(match, `Missing official return threshold for "${cat}"`);
    assert.equal(match.threshold, thr, `Threshold mismatch for "${cat}"`);
  }
  assert.equal(lookupVerified2027ReturnThreshold('Toys & Games')?.threshold, 0.047);
  assert.equal(lookupVerified2027ReturnThreshold('Beauty, Health and Personal Care')?.threshold, 0.055);
  assert.equal(lookupVerified2027ReturnThreshold('Industrial & Scientific')?.threshold, 0.06);

  // 2) classifyStandardSize2027 remains strictly Standard-size while classifySizeTier2027 resolves 2027 Bulky 4 tiers
  const smallBulkyPkg = { length_in: 20.5, width_in: 4.5, height_in: 3.5, unit_weight_lb: 3.8 };
  assert.equal(classifyStandardSize2027(smallBulkyPkg).status, 'needs_calculator_verification');
  const sb = classifySizeTier2027(smallBulkyPkg);
  assert.equal(sb.status, 'verified');
  assert.equal(sb.size_tier, 'small_bulky');

  const medBulky = classifySizeTier2027({ length_in: 32, width_in: 16, height_in: 8, unit_weight_lb: 12 });
  assert.equal(medBulky.size_tier, 'medium_bulky');
  const lgBulky = classifySizeTier2027({ length_in: 45, width_in: 12, height_in: 8, unit_weight_lb: 18 });
  assert.equal(lgBulky.size_tier, 'large_bulky');
  const xlBulky = classifySizeTier2027({ length_in: 55, width_in: 12, height_in: 8, unit_weight_lb: 22 });
  assert.equal(xlBulky.size_tier, 'extra_large_bulky');
  const dimWeightOver50 = classifySizeTier2027({ length_in: 48, width_in: 22, height_in: 12, unit_weight_lb: 18 });
  assert.equal(dimWeightOver50.status, 'verified');
  assert.equal(dimWeightOver50.size_tier, 'large_oversize');
  const oversizeBeyond = classifySizeTier2027({ length_in: 65, width_in: 30, height_in: 12, unit_weight_lb: 25 });
  assert.equal(oversizeBeyond.status, 'verified');
  const exceedMaxHeavy = classifySizeTier2027({ length_in: 150, width_in: 30, height_in: 12, unit_weight_lb: 160 });
  assert.equal(exceedMaxHeavy.status, 'verified');
  assert.equal(exceedMaxHeavy.size_tier, 'special_oversize_heavy');

  // Small Bulky fulfillment ($7.51 + 3 * $0.39 = $8.68 base -> * 1.035 = $8.9838 + $1.51 non-SIPP packaging [2.32 lb dim wt <= 5 lb] = $10.4938 default; $8.9838 when is_sipp: true)
  const sbFul = lookupBulkyFulfillmentFee2027({
    pkg: smallBulkyPkg,
    price_usd: 59.99,
    sales_window: { from: '2027-02-01', through: '2027-10-14' },
  });
  assert.equal(sbFul.status, 'verified');
  assert.equal(sbFul.base_usd, 8.68);
  assert.equal(sbFul.packaging_service_fee_usd, 1.51);
  assert.equal(sbFul.total_usd, 10.4938);
  const sbFulSipp = lookupBulkyFulfillmentFee2027({
    pkg: smallBulkyPkg,
    price_usd: 59.99,
    is_sipp: true,
    sales_window: { from: '2027-02-01', through: '2027-10-14' },
  });
  assert.equal(sbFulSipp.total_usd, 8.9838);

  const sbStoreOff = lookupBulkyStorageFee2027({ pkg: smallBulkyPkg, months: [2, 3, 4, 5, 6, 7, 8, 9] });
  const sbStorePeak = lookupBulkyStorageFee2027({ pkg: smallBulkyPkg, months: [10, 11, 12] });
  assert.equal(sbStoreOff.rate_usd_per_cuft_month, 0.56);
  assert.equal(sbStorePeak.rate_usd_per_cuft_month, 1.40);

  // Small/Large Bulky 2027 Inbound Placement ($1.10-$1.60 <=5lb Small/Medium; $1.30-$1.80 <=5lb Large/XL) & Returns Processing ($6.74 + $0.32/lb over 1 lb)
  const sbPlaceWest = lookupBulkyPlacementFee2027({
    pkg: smallBulkyPkg,
    inbound_window: { from: '2027-01-15', through: '2027-01-25' },
    split_option: 'minimal_west_conservative',
  });
  assert.equal(sbPlaceWest.status, 'verified');
  assert.deepEqual(sbPlaceWest.range_usd, [1.10, 1.60]);
  assert.equal(sbPlaceWest.selected_usd, 1.60);

  const sbRetExcess = lookupBulkyReturnsProcessing2027({
    pkg: smallBulkyPkg, // 3.8 lb -> 3 extra lb steps -> $6.74 + 3 * $0.32 = $7.70 per excess return
    physical_return_fraction: 0.062,
    fee_category: 'Toys and Games', // threshold 0.047 -> excess = 0.015
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
  });
  assert.equal(sbRetExcess.status, 'verified');
  assert.equal(sbRetExcess.per_return_fee_usd, 7.70);
  assert.ok(Math.abs(sbRetExcess.expected_fee_per_shipped_unit_usd - 0.1155) < 1e-8);

  // 3) Guest revcalpublic anti-429 guard: rejects logged-in state, seller console URL, or empty right-hand FBA column
  const revcal429 = validateGuestRevcalReadback({
    url: 'https://sellercentral.amazon.com/revcalpublic',
    guest_logged_out: true,
    fba_panel_present: false,
    awd_panel_present: true,
    fulfillment_usd: null,
    storage_per_unit_usd: null,
    placement_usd: 0,
    observed_at: '2026-11-23',
    verified_price_usd: 59.99,
    effective_from: '2027-01-15',
    effective_through: '2027-10-14',
    pkg: smallBulkyPkg,
  });
  assert.equal(revcal429.valid, false);
  assert.equal(revcal429.error_code, 'revcal_429_empty_fba_column');

  const revcalLoggedIn = validateGuestRevcalReadback({
    url: 'https://sellercentral.amazon.com/fba/profitabilitycalculator/index',
    guest_logged_out: false,
    fba_panel_present: true,
    fulfillment_usd: 8.98,
    storage_per_unit_usd: 0.16,
    placement_usd: 1.12,
    returns_processing_usd: 0,
    observed_at: '2026-11-23',
    verified_price_usd: 59.99,
    effective_from: '2027-01-15',
    effective_through: '2027-10-14',
    pkg: smallBulkyPkg,
  });
  assert.equal(revcalLoggedIn.valid, false);

  const revcalOk = validateGuestRevcalReadback({
    url: 'https://sellercentral.amazon.com/revcalpublic',
    guest_logged_out: true,
    fba_panel_present: true,
    fulfillment_usd: 8.98,
    storage_per_unit_usd: 0.16,
    placement_usd: 1.12,
    returns_processing_usd: 0,
    observed_at: '2026-11-23',
    verified_price_usd: 59.99,
    effective_from: '2027-01-15',
    effective_through: '2027-10-14',
    pkg: smallBulkyPkg,
    evidence_ref: 'ev-guest-revcal-01',
  });
  assert.equal(revcalOk.valid, true);
  assert.equal(revcalOk.override.verified_by, 'guest_revcalpublic');

  // 4) Matched-peer median package never overwrites Amazon specs with 1688 box, but flags cliff-crossing 1688 box
  const peerMedian = computeMatchedPeerMedianPackage([
    { asin: 'B0SYNTH001', length_in: 17.2, width_in: 12.0, height_in: 2.5, unit_weight_lb: 4.2 },
    { asin: 'B0SYNTH002', length_in: 17.6, width_in: 11.7, height_in: 1.3, unit_weight_lb: 2.75 },
    { asin: 'B0SYNTH003', length_in: 17.5, width_in: 12.4, height_in: 2.6, unit_weight_lb: 4.54 },
  ], {
    supplier_nominal_pkg: { length_in: 18.3, width_in: 12.6, height_in: 3.0, unit_weight_lb: 4.6 },
  });
  assert.equal(peerMedian.peer_count, 3);
  assert.equal(peerMedian.median_pkg.length_in, 17.5);
  assert.equal(peerMedian.median_pkg.width_in, 12.0);
  assert.equal(peerMedian.median_pkg.height_in, 2.5);
  assert.equal(peerMedian.median_pkg.unit_weight_lb, 4.2);
  assert.equal(peerMedian.supplier_cliff_crossed, true);
  assert.equal(peerMedian.sample_warning_tag, '拿样必测彩盒压线预警');

  // 5) $50.00 FBA cliff interior feasibility: [$49.99, $50.01] where $49.99 and $50.01 both < 30% but $50.00 >= 30%
  const cliffBase = {
    pkg: { length_in: 14, width_in: 10, height_in: 4, unit_weight_lb: 2.0 },
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    headhaul_usd: 2.5,
    collection_rate: 0.005,
    other_applicable_usd: 0,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  };
  const capAt50 = estimateGate1A2027({ ...cliffBase, price_usd: 50.00 }).landed_domestic_cap_usd;
  const capAt4999 = estimateGate1A2027({ ...cliffBase, price_usd: 49.99 }).landed_domestic_cap_usd;
  const capAt5001 = estimateGate1A2027({ ...cliffBase, price_usd: 50.01 }).landed_domestic_cap_usd;
  // Pick landed cost strictly below $50.00 cap, but strictly above $49.99 and $50.01 caps!
  const midLandedUsd = (Math.max(capAt4999, capAt5001) + capAt50) / 2;
  assert.ok(capAt50 > capAt4999 && capAt50 > capAt5001);
  const check = checkMatureBandMarginFeasibility2027({
    ...cliffBase,
    min_mature_price_usd: 49.99,
    max_mature_price_usd: 50.01,
    landed_domestic_usd: midLandedUsd,
  });
  assert.equal(check.any_ge_floor, true);
  assert.equal(check.best_price_usd, 50.00);
});

test('Seam 2: 3-tier target_child_units, parent sales dedup, category return fallback, Google Trends weekly check, sub-form split, dual price bands, and 80/20 discovery', () => {
  // 1) 3-tier target_child_units
  const t1 = resolveTargetChildSalesObservation({
    asin: 'B0SINGLE01',
    variant_count: 1,
    parent_monthly_units: 27,
  });
  assert.equal(t1.tier, 'single_variant_exact');
  assert.equal(t1.value, 27);

  const t2 = resolveTargetChildSalesObservation({
    asin: 'B0MULTI100',
    variant_count: 4,
    bought_in_past_month: 100,
    parent_monthly_units: 950,
  });
  assert.equal(t2.tier, 'multi_variant_badge_bound');
  assert.deepEqual(t2.value_range, [100, 199]);

  const t3Starter = resolveTargetChildSalesObservation({
    asin: 'B0MULTISUB',
    variant_count: 5,
    bought_in_past_month: 0,
    child_review_delta_30d: 3,
    leaf_bsr_rank: 28,
  });
  assert.equal(t3Starter.tier, 'sub_50_active_starter');
  assert.deepEqual(t3Starter.value_range, [1, 49]);
  assert.match(t3Starter.label, /<50\/月/);

  const t3Missing = resolveTargetChildSalesObservation({
    asin: 'B0MISSING0',
    variant_count: 3,
    query_completed: false,
  });
  assert.equal(t3Missing.tier, 'missing_observation');
  assert.equal(t3Missing.value, null);

  // Color-variant median on same physical spec
  const tColor = resolveTargetChildSalesObservation({
    asin: 'B0COLORMED',
    variant_count: 3,
    same_spec_color_variants: [
      { asin: 'B0C1', color: 'Black', units_30d: 120 },
      { asin: 'B0C2', color: 'Walnut', units_30d: 60 },
      { asin: 'B0C3', color: 'White', units_30d: 40 },
    ],
  });
  assert.equal(tColor.value, 60);
  assert.equal(tColor.top_color_variant.asin, 'B0C1');

  // 2) Deduplicate parent monthlySales strictly once per parent family
  const dedupedSales = deduplicateParentSalesRows([
    { asin: 'B0CHILD001', parent: 'B0PARENT99', monthlySales: 180 },
    { asin: 'B0CHILD002', parent: 'B0PARENT99', monthlySales: 180 },
    { asin: 'B0CHILD003', parent: 'B0PARENT99', monthlySales: 180 },
    { asin: 'B0SOLO0001', parent: 'B0SOLO0001', monthlySales: 100 },
  ]);
  assert.equal(dedupedSales.deduplicated_parent_count, 2);
  assert.equal(dedupedSales.total_parent_units, 280);

  // 3) Revision 59 leaf-first category return priority: leaf returnRatio first, falling back strictly to department avgReturnRatio ONLY on missing/NO_DATA
  const retLeafPrimary = resolveCategoryReturnWithFallback(
    { avgReturnRatio: 3.10, returnRatio: 6.20 },
  );
  assert.equal(retLeafPrimary.value, 0.062);
  assert.equal(retLeafPrimary.source_field, 'ratioComparison.returnRatio');
  assert.equal(retLeafPrimary.department_average_value, 0.031);
  assert.equal(retLeafPrimary.fallback_used, false);
  assert.equal(retLeafPrimary.tag, null);

  const retSameReportFallback = resolveCategoryReturnWithFallback(
    { avgReturnRatio: 3.1, returnRatio: null },
  );
  assert.equal(retSameReportFallback.value, 0.031);
  assert.equal(retSameReportFallback.source_field, 'ratioComparison.avgReturnRatio');
  assert.equal(retSameReportFallback.fallback_used, true);
  assert.match(retSameReportFallback.tag, /小类退货率缺失/);

  // Micro-leaf NO_DATA falls back strictly to parent department avgReturnRatio (never adopting sibling or ancestor returnRatio)
  const retFallback = resolveCategoryReturnWithFallback(
    { avgReturnRatio: null, returnRatio: null },
    { avgReturnRatio: 4.2, returnRatio: 7.9, category_label: 'Home & Kitchen', is_ancestor_subcategory: true },
  );
  assert.equal(retFallback.value, 0.042);
  assert.equal(retFallback.source_field, 'parent_category.ratioComparison.avgReturnRatio');
  assert.equal(retFallback.fallback_used, true);
  assert.match(retFallback.tag, /NO_DATA/);

  // Legacy preferLeafReturnRatio=false preserves r50-r58 avgReturnRatio behavior
  const retLegacy = resolveCategoryReturnWithFallback(
    { avgReturnRatio: 3.10, returnRatio: 6.20 },
    null,
    { preferLeafReturnRatio: false },
  );
  assert.equal(retLegacy.value, 0.031);

  // 4) Google Trends weekly point series validation (260 weeks / 1825 days = 14.25% is complete 5yr weekly, NOT truncated!)
  const weeks260 = Array.from({ length: 260 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, 2 + i * 7)).toISOString().slice(0, 10),
    value: 40 + (i % 15),
  }));
  const gtFull = evaluateGoogleTrendsSeries({
    googleProp: 'WEB',
    coverageRate: 14.25,
    dataStatus: 'TRUNCATED',
    series: weeks260,
  });
  assert.equal(gtFull.normalized_prop, 'web');
  assert.equal(gtFull.unique_weeks, 260);
  assert.equal(gtFull.is_sufficient_multiyear_weekly, true);

  const gtShort = evaluateGoogleTrendsSeries({
    googleProp: 'WEB',
    coverageRate: 4.98,
    series: weeks260.slice(0, 20),
  });
  assert.equal(gtShort.is_sufficient_multiyear_weekly, false);

  // 5) Keepa review trajectory tagger
  const vineCurve = classifyKeepaReviewTrajectory([
    { date: '2026-10-01', reviews: 0 },
    { date: '2026-10-10', reviews: 8 },
    { date: '2026-10-20', reviews: 18 },
    { date: '2026-11-01', reviews: 26 },
  ], { vine_tier: 30 });
  assert.equal(vineCurve.classification, 'vine_gradual_ramp');
  const spikeCurve = classifyKeepaReviewTrajectory([
    { date: '2026-10-01', reviews: 5 },
    { date: '2026-10-03', reviews: 245 },
  ]);
  assert.equal(spikeCurve.classification, 'steady_organic_accumulation');
  assert.equal(spikeCurve.observed_facts.max_positive_step, 240);
  const aiFlaggedCurve = classifyKeepaReviewTrajectory([
    { date: '2026-10-01', reviews: 5 },
    { date: '2026-10-03', reviews: 245 },
  ], { ai_review_anomaly: true });
  assert.equal(aiFlaggedCurve.classification, 'qualitative_review_anomaly_watch');

  // 6) Full-page sub-form splitting without .slice(0,16) truncation + dual price bands + seed-merge guard
  const pageItems = Array.from({ length: 20 }, (_, i) => ({
    asin: `B0ITEM${String(i + 1).padStart(4, '0')}`,
    title: i >= 17 ? 'Heavy Cast Iron Desk Clamp Stand' : 'Mini Wire Holder',
    price: i >= 17 ? 75.00 : 15.00,
    coupon: i === 17 ? '10%' : null,
    fulfillment: 'FBA',
    monthlySales: i >= 17 ? 140 : 300,
    availableDate: '2025-05-01',
    pkgDimensions: i >= 17 ? '14.0 x 10.0 x 6.0 inches' : '8 x 6 x 2 inches',
    pkgWeight: i >= 17 ? '5.0 pounds' : '0.8 pounds',
  }));
  const split = splitSearchPageSubForms(pageItems, [
    { sub_form_id: 'cast-iron-stand', match: row => /cast iron/i.test(row.title) },
    { sub_form_id: 'wire-holder', match: row => /wire/i.test(row.title) },
  ]);
  const crankGroup = split.sub_forms.find(f => f.sub_form_id === 'cast-iron-stand');
  assert.equal(crankGroup.items.length, 3, 'Items #18-#20 must NOT be truncated at 16');
  assert.equal(crankGroup.items[0].ongoing_coupon_pct, 0.10, '10% coupon string must be preserved');

  // Dual price bands: mature >=120d ($39/$40) vs young newcomer ($58) vs seed-merged 72d w/ 250 old reviews ($62) vs unknown age ($55)
  const dualBand = analyzeMainstreamPriceBand([
    { asin: 'B0MATURE01', price_usd: 39.00, fulfillment: 'FBA', monthlySales: 120, availableDate: '2025-11-01', keepa_90d_median_usd: 39.00 },
    { asin: 'B0MATURE02', price_usd: 31.99, fulfillment: 'FBA', monthlySales: 150, availableDate: '2025-10-01', keepa_90d_median_usd: 40.00 },
    { asin: 'B0SEEDMRG1', price_usd: 62.00, fulfillment: 'FBA', monthlySales: 90, availableDate: '2026-09-10', reviews: 250, old_reviews_predate_launch: true },
    { asin: 'B0YOUNG001', price_usd: 58.00, fulfillment: 'FBA', monthlySales: 80, availableDate: '2026-10-05', reviews: 12 },
    { asin: 'B0UNKAGE01', price_usd: 55.00, fulfillment: 'FBA', monthlySales: 60 },
  ], { as_of_date: '2026-11-22', strict_mature_only: true });
  assert.ok(dualBand.mature_regular_band.p75_usd <= 40.00, `Mature regular band P75 must stay <= $40 (got ${dualBand.mature_regular_band.p75_usd})`);
  assert.equal(dualBand.newcomer_launch_band.peer_count, 1);
  assert.equal(dualBand.newcomer_launch_band.p50_usd, 58.00);

  // 7) sif_keyword_opportunity alias + 80/20 station-internal vs off-site task split
  assert.equal(resolveChannelMeta('sif_keyword_opportunity').provider, 'sif');
  assert.equal(resolveChannelMeta('sif_keyword_opportunity').known_channel, true);
  const store = openSelectionStore(':memory:');
  const plan10 = planDiscoveryBatch(store, { task_slots: 10, enforce_80_20_mix: true });
  assert.equal(plan10.recommended_channels.length, 10);
  const inSiteSlots = plan10.recommended_channels.filter(c => c.station_origin === 'in_site').length;
  const offSiteSlots = plan10.recommended_channels.filter(c => c.station_origin === 'off_site').length;
  assert.equal(inSiteSlots, 8);
  assert.equal(offSiteSlots, 2);
  store.close();
});

test('Seam 3: Luna triage preserves physical dimensions/weight/coupon, RightsPrescreen prunes unpowered frameworks, and sync timeout >= 480s', () => {
  const lunaReqs = buildStage1DecisionsRequests({
    candidates: [
      {
        candidate_id: 'B0MINI0001',
        title: 'Mini Desk Shelf',
        price_usd: 18.00,
        fulfillment: 'FBA',
        pkgDimensions: '9.0 x 5.0 x 2.0 inches',
        pkgWeight: '1.1 pounds',
        pieces_per_set: 1,
        coupon: '10%',
      },
    ],
    targetSpec: { label: 'Modular Wood Desk Shelf', pkg_summary: '16.0 x 11.0 x 3.0 in, 4.0 lb' },
  });
  const wireJsonBlock = lunaReqs[0].input[0].content.find(c => c.type === 'input_json');
  const serialized = JSON.stringify(lunaReqs[0]);
  assert.match(serialized, /9\.0 x 5\.0 x 2\.0 inches/);
  assert.match(serialized, /1\.1 pounds/);
  assert.equal(wireJsonBlock.data.candidates[0].pieces_per_set, 1);
  assert.equal(wireJsonBlock.data.candidates[0].coupon, '10%');

  const woodFrameworks = resolveRelevantRegulatoryFrameworks({
    label: 'Modular Wood Desk Shelf',
    buyer_task: 'Store office stationery on desk',
    materials: 'unfinished pine wood, no battery, unpowered',
    is_powered: false,
    has_battery: false,
    food_contact: false,
  });
  assert.ok(woodFrameworks.applicable.includes('Lacey_Act'));
  assert.ok(woodFrameworks.applicable.includes('EPA'));
  assert.ok(!woodFrameworks.applicable.includes('FCC'));
  assert.ok(!woodFrameworks.applicable.includes('DOT_UN38_3'));
  assert.ok(!woodFrameworks.applicable.includes('UL_ETL'));

  const rightsReq = buildRightsPreScreenRequest({
    form_id: 'form-wood-desk-shelf',
    label: 'Modular Wood Desk Shelf',
    buyer_task: 'Store office stationery on desk',
    materials: 'unfinished pine wood, no battery, unpowered',
    is_powered: false,
    has_battery: false,
    food_contact: false,
  });
  const devPrompt = rightsReq.input[0].content[0].text;
  assert.match(devPrompt, /Do NOT waste web searches on excluded irrelevant frameworks.*FCC.*UL_ETL.*DOT_UN38_3/i);

  assert.ok(DEFAULT_SYNC_TIMEOUT_MS >= 480_000);
});

test('Astra Round-1 Regressions (Foundations): Bulky 2-inch min dim weight + Gate 1A Bulky wiring + anti-429 override, coupon no-double-deduct, child sales bounds, Trends ISO weeks, powered no-battery FCC, and station_verification subrole', () => {
  // HIGH 1a: Official Amazon US Bulky 2-inch minimum width & height (26 x 20 x 1 in, 2 lb -> 26*20*2/139 = 7.482 lb -> ceil 8 lb = $9.62 + 2*$0.39 = $10.24 * 1.035 = $10.5984 + $1.68 non-SIPP packaging = $12.2784)
  const flatBulky = lookupBulkyFulfillmentFee2027({
    pkg: { length_in: 26, width_in: 20, height_in: 1, unit_weight_lb: 2 },
    price_usd: 45,
    sales_window: { from: '2027-02-01', through: '2027-10-14' },
  });
  assert.equal(flatBulky.status, 'verified');
  assert.ok(Math.abs(flatBulky.fulfillment_with_fuel_usd - 10.5984) < 1e-4, `Expected $10.5984 base+fuel with 2-in min height, got ${flatBulky.fulfillment_with_fuel_usd}`);
  assert.ok(Math.abs(flatBulky.total_usd - 12.2784) < 1e-4, `Expected $12.2784 merged non-SIPP total, got ${flatBulky.total_usd}`);

  // HIGH 1b: estimateGate1A2027 verifies ordinary Small Bulky when placement_usd is provided and r_physical <= threshold
  const g1aBulky = estimateGate1A2027({
    price_usd: 55.00,
    pkg: { length_in: 22.0, width_in: 8.0, height_in: 5.0, unit_weight_lb: 4.0 },
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.035,
    physical_return_fraction: 0.035,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    headhaul_usd: 4.5,
    placement_usd: 1.55,
    collection_rate: 0.005,
    other_applicable_usd: 0,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-02-01' },
  });
  assert.equal(g1aBulky.status, 'verified');
  assert.equal(g1aBulky.size_tier, 'small_bulky');

  // Round-2 HIGH 1: guest_readback HTTP 429 w/ positive fee fails, AND outer $1 vs nested guest_readback $10.5984 fails!
  assert.equal(validateGuestRevcalReadback({
    url: 'https://sellercentral.amazon.com/revcalpublic',
    guest_logged_out: true,
    fba_panel_present: true,
    http_status: 429,
    observed_at: '2026-11-22',
    effective_from: '2027-01-15',
    effective_through: '2027-10-14',
    verified_price_usd: 45,
    pkg: { length_in: 26, width_in: 20, height_in: 1, unit_weight_lb: 2 },
    fulfillment_usd: 10.5984,
    storage_per_unit_usd: 0.60,
    placement_usd: 1.20,
  }).valid, false);

  const mismatchedGuestOv = estimateGate1A2027({
    price_usd: 45.00,
    pkg: { length_in: 26, width_in: 20, height_in: 1, unit_weight_lb: 2 },
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    headhaul_usd: 3.0,
    collection_rate: 0.005,
    other_applicable_usd: 0,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-02-01' },
    calculator_verified_override: {
      verified_by: 'guest_revcalpublic',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-mismatch-ov',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: { length_in: 26, width_in: 20, height_in: 1, unit_weight_lb: 2 },
      fulfillment_usd: 1.00, // forged $1 outer fee while guest_readback says $10.5984!
      placement_usd: 1.20,
      storage_per_unit_usd: 0.60,
      returns_processing_usd: 0,
      guest_readback: {
        url: 'https://sellercentral.amazon.com/revcalpublic',
        guest_logged_out: true,
        fba_panel_present: true,
        observed_at: '2026-11-22',
        effective_from: '2027-01-15',
        effective_through: '2027-10-14',
        verified_price_usd: 45,
        pkg: { length_in: 26, width_in: 20, height_in: 1, unit_weight_lb: 2 },
        fulfillment_usd: 10.5984,
        storage_per_unit_usd: 0.60,
        placement_usd: 1.20,
      },
    },
  });
  assert.equal(mismatchedGuestOv.status, 'needs_calculator_verification');

  // HIGH 1c: calculator_verified_override rejects HTTP 429, empty right-hand column, non-revcalpublic URL, and pre-2027 rate schedules
  for (const badPatch of [
    { http_status: 429 },
    { fba_panel_present: false },
    { right_column_fba_non_empty: false },
    { url: 'https://sellercentral.amazon.com/fba/profitabilitycalculator/index' },
    { rate_schedule_year: 2026 },
    { storage_rate_usd_per_cuft_month: 0.48 },
  ]) {
    const badOv = estimateGate1A2027({
      price_usd: 59.99,
      pkg: { length_in: 24, width_in: 18, height_in: 10, unit_weight_lb: 22 },
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 5,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-09-30' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-02-01' },
      calculator_verified_override: {
        verified_by: 'amazon_fba_revenue_calculator',
        observed_at: '2026-11-22',
        evidence_ref: 'ev-revcal-test',
        verified_price_band: 'over_50',
        effective_from: '2027-01-15',
        effective_through: '2027-10-14',
        pkg: { length_in: 24, width_in: 18, height_in: 10, unit_weight_lb: 22 },
        fulfillment_usd: 15.5,
        placement_usd: 1.8,
        storage_per_unit_usd: 2.1,
        returns_processing_usd: 0,
        ...badPatch,
      },
    });
    assert.equal(badOv.status, 'needs_calculator_verification');
  }

  // HIGH 3a: Two mature $35 listings each with 8% coupon -> splitSearchPageSubForms then analyzeMainstreamPriceBand MUST keep P75 = $32.20 (never double-deduct to $29.40!)
  const twoCouponRows = [
    { asin: 'B0COUPON01', title: 'Walnut Stand A', price: 35, coupon: '8%', fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-05-01' },
    { asin: 'B0COUPON02', title: 'Walnut Stand B', price: 35, coupon: '8%', fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-05-01' },
  ];
  const directBand = analyzeMainstreamPriceBand(twoCouponRows, { as_of_date: '2026-11-22' });
  const splitOut = splitSearchPageSubForms(twoCouponRows, [{ sub_form_id: 'walnut', match: () => true }]);
  const splitBand = analyzeMainstreamPriceBand(splitOut.sub_forms[0].items, { as_of_date: '2026-11-22' });
  assert.equal(directBand.band.p75_usd, 32.20);
  assert.equal(splitBand.band.p75_usd, 32.20, 'Must NEVER double-deduct coupon after splitSearchPageSubForms');

  // HIGH 6a: Empty {} observation is missing_observation (value: null), and exact single-variant sets bounds (NOT value_range) so demand scoring accepts it!
  const emptyObs = resolveTargetChildSalesObservation({});
  assert.equal(emptyObs.tier, 'missing_observation');
  assert.equal(emptyObs.value, null);
  assert.equal(emptyObs.value_range, undefined);
  const exactObs = resolveTargetChildSalesObservation({ asin: 'B0EXACT025', variant_count: 1, parent_monthly_units: 25 });
  assert.equal(exactObs.value, 25);
  assert.equal(exactObs.value_range, undefined);
  assert.deepEqual(exactObs.bounds, [25, 25]);

  // MEDIUM 2a: Two 52-day daily blocks 2 years apart OR 2019 (52w) + 2024 (52w) w/ 4-year hole must NOT pass multi-year weekly check!
  const dailyTwoBlocks = [
    ...Array.from({ length: 52 }, (_, d) => ({ date: new Date(Date.UTC(2023, 0, 1 + d)).toISOString().slice(0, 10), value: 30 })),
    ...Array.from({ length: 52 }, (_, d) => ({ date: new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10), value: 35 })),
  ];
  const gtDailyBlocks = evaluateGoogleTrendsSeries({ googleProp: 'WEB', coverageRate: 14.2, series: dailyTwoBlocks });
  assert.ok(gtDailyBlocks.unique_weeks < 52);
  assert.equal(gtDailyBlocks.is_sufficient_multiyear_weekly, false);

  const holeFourYears = [
    ...Array.from({ length: 52 }, (_, w) => ({ date: new Date(Date.UTC(2019, 0, 6 + w * 7)).toISOString().slice(0, 10), value: 40 })),
    ...Array.from({ length: 52 }, (_, w) => ({ date: new Date(Date.UTC(2024, 0, 7 + w * 7)).toISOString().slice(0, 10), value: 45 })),
  ];
  const gtFourYearHole = evaluateGoogleTrendsSeries({ googleProp: 'WEB', coverageRate: 14.2, series: holeFourYears });
  assert.equal(gtFourYearHole.unique_weeks, 104);
  assert.equal(gtFourYearHole.is_sufficient_multiyear_weekly, false, '4-year gap between 2019 and 2024 blocks must fail continuity check');

  // MEDIUM 2b: Powered "USB WiFi adapter, no battery" AND Chinese "USB 无线网卡，无电池" retain FCC while pruning DOT_UN38_3
  const usbWifiFw = resolveRelevantRegulatoryFrameworks({
    label: 'USB WiFi adapter, no battery',
    buyer_task: 'Connect desktop PC to wireless network via USB',
    materials: 'ABS housing, USB-A plug, no battery',
  });
  assert.ok(usbWifiFw.applicable.includes('FCC'), 'Powered RF USB WiFi adapter must retain FCC');
  assert.ok(!usbWifiFw.applicable.includes('DOT_UN38_3'), 'No-battery device prunes lithium battery UN38.3');

  const usbWifiCjkFw = resolveRelevantRegulatoryFrameworks({
    label: 'USB 无线网卡，无电池',
    buyer_task: '台式电脑 USB 插电无线联网',
    materials: 'ABS 外壳，USB 接口，无电池',
    is_powered: true,
    has_battery: false,
  });
  assert.ok(usbWifiCjkFw.applicable.includes('FCC'), 'Chinese USB 无线网卡，无电池 must retain FCC');
  assert.ok(!usbWifiCjkFw.applicable.includes('DOT_UN38_3'));

  // MEDIUM 1: Pure station_verification lead is excluded, while a lead that is primary_discovery on Form A AND station_verification on Form B keeps count = 1!
  const st = openSelectionStore(':memory:');
  st.upsertRawLead({
    lead_id: 'lead-legacy-verif',
    phrase_or_title: 'legacy verification keyword',
    source_channel: 'keyword_research',
    source_ref: 'https://www.sellersprite.com/legacy-v',
    observed_at: '2026-11-22',
    disposition: 'context',
  });
  st.upsertCandidateForm({
    form_id: 'form-legacy-v',
    product_family_key: 'legacy-v',
    label: 'Legacy verified form',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  st.linkLeadToForm({ lead_id: 'lead-legacy-verif', form_id: 'form-legacy-v', link_role: 'corroboration' });
  st.db.prepare("UPDATE lead_form_links SET verification_subrole = 'station_verification' WHERE lead_id = 'lead-legacy-verif'").run();
  const planCheck = planDiscoveryBatch(st, { task_slots: 20, enforce_80_20_mix: true });
  const kwEntry = planCheck.recommended_channels.find(c => c.channel_id === 'keyword_library');
  assert.equal(kwEntry?.observed_leads ?? 0, 0, 'station_verification subrole must not count as primary discovery');

  // Dual-role lead: primary_discovery on Form A + station_verification on Form B MUST retain observed_leads = 1!
  st.upsertRawLead({
    lead_id: 'lead-dual-role',
    phrase_or_title: 'dual role keyword',
    source_channel: 'keyword_research',
    source_ref: 'https://www.sellersprite.com/dual-role',
    observed_at: '2026-11-22',
    disposition: 'product',
  });
  st.upsertCandidateForm({
    form_id: 'form-primary-a',
    product_family_key: 'primary-a',
    label: 'Primary Form A',
    buyer_task: 'Task A',
    saleable_set_composition: { qty: 1 },
  });
  st.linkLeadToForm({ lead_id: 'lead-dual-role', form_id: 'form-primary-a', link_role: 'primary_discovery' });
  st.linkLeadToForm({ lead_id: 'lead-dual-role', form_id: 'form-legacy-v', link_role: 'station_verification' });
  const planDual = planDiscoveryBatch(st, { task_slots: 20, enforce_80_20_mix: true });
  const kwDual = planDual.recommended_channels.find(c => c.channel_id === 'keyword_library');
  assert.equal(kwDual?.observed_leads, 1, 'Lead serving as primary_discovery on Form A must keep observed_leads = 1');
  assert.equal(planDual.primary_discovery_counts_by_channel.keyword_library, 1);
  st.close();

  // Round-3 HIGH 1: Legacy calculator_verified_override accepts Standard-size $5.9202 AND rejects Large Bulky $8.00 (< $9.1908)
  const stdPkg = { length_in: 12, width_in: 8, height_in: 2, weight_lb: 1.4 };
  const stdOfficial = lookupFulfillmentFee2027({
    pkg: stdPkg,
    price_usd: 35,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
  });
  assert.ok(stdOfficial.total_usd < 7.47, `Expected Standard fee < $7.47, got ${stdOfficial.total_usd}`);
  const stdLegacyOk = estimateGate1A2027({
    pkg: stdPkg,
    price_usd: 35,
    fx_cny_per_usd: 7.2,
    headhaul_usd: 1.5,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-25' },
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-std-legacy',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: stdPkg,
      fulfillment_usd: stdOfficial.total_usd,
      placement_usd: 0.50,
      storage_per_unit_usd: 0.20,
      returns_processing_usd: 0,
    },
  });
  assert.equal(stdLegacyOk.status, 'verified', `Standard-size legacy override must NOT hit $7.47 Bulky floor: ${stdLegacyOk.reason}`);

  const largeBulkyPkg = { length_in: 40, width_in: 12, height_in: 8, weight_lb: 10 }; // longest 40 > 37, dim 27.6 lb <= 50 lb => large_bulky ($9.88 * 1.035 = $10.2258 floor)
  const oversizeScreeningInputs = makeOversizeScreeningInputs();
  const largeBulkyUnder = estimateGate1A2027({
    pkg: largeBulkyPkg,
    ...oversizeScreeningInputs,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-lg-bulky-under',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: largeBulkyPkg,
      fulfillment_usd: 8.00, // < Large Bulky $9.88 * 1.035 = $10.2258 floor!
      placement_usd: 1.50,
      storage_per_unit_usd: 0.90,
      returns_processing_usd: 0,
    },
  });
  assert.equal(largeBulkyUnder.status, 'needs_calculator_verification');
  assert.match(largeBulkyUnder.reason, /Bulky fee floor/i);

  const oversizePkg = { length_in: 40, width_in: 20, height_in: 12, weight_lb: 10 }; // dim 69.06 lb > 50 lb => oversize_beyond_bulky ($10.09 * 1.035 = $10.4432 floor)
  const oversizeUnder = estimateGate1A2027({
    pkg: oversizePkg,
    ...oversizeScreeningInputs,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-oversize-under',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: oversizePkg,
      fulfillment_usd: 8.00,
      placement_usd: 1.50,
      storage_per_unit_usd: 0.90,
      returns_processing_usd: 0,
    },
  });
  assert.equal(oversizeUnder.status, 'needs_calculator_verification');
  assert.match(oversizeUnder.reason, /Extra-Large Bulky \/ Oversize fee floor/i);

  // Round-3 MEDIUM 2: CJK "不带电池" without explicit is_powered flag STILL retains FCC on USB/wireless gear!
  const fwNoDaiBattery = resolveRelevantRegulatoryFrameworks({
    label: 'USB 无线网卡，不带电池',
    buyer_task: '电脑直插 USB 接收无线信号，免电池',
  });
  assert.ok(fwNoDaiBattery.applicable.includes('FCC'), 'USB 无线网卡，不带电池 must retain FCC');
  assert.ok(!fwNoDaiBattery.applicable.includes('DOT_UN38_3'));

  // Round-3 observation_date replay lock: analyzeMainstreamPriceBand honors observation_date identically to as_of_date
  const sampleListings = [
    { asin: 'B0OBS00001', price_usd: 42, fulfillment: 'FBA', monthlySales: 100, availableDate: '2026-06-01' }, // >120d on 2026-11-22
    { asin: 'B0OBS00002', price_usd: 48, fulfillment: 'FBA', monthlySales: 90, availableDate: '2026-05-01' },
    { asin: 'B0OBS00003', price_usd: 45, fulfillment: 'FBA', monthlySales: 60, availableDate: '2026-09-01' }, // 82d (<120d) on 2026-11-22, >120d on 2027-06-01!
  ];
  const byObsDate = analyzeMainstreamPriceBand(sampleListings, { observation_date: '2026-11-22', strict_mature_only: true });
  const byAsOfDate = analyzeMainstreamPriceBand(sampleListings, { as_of_date: '2026-11-22', strict_mature_only: true });
  assert.deepEqual(byObsDate.mature_regular_band, byAsOfDate.mature_regular_band);
  assert.equal(byObsDate.mature_regular_band.peer_count, 2, 'observation_date must lock 2026-09-01 listing as <120d newcomer');

  // Foreign-currency / multi-unit coupons must NEVER be deducted as single-unit USD discounts, and $50.00 cliff settles in whole USD cents!
  const foreignAndMultiBand = analyzeMainstreamPriceBand([
    { asin: 'B0EUR00001', price: 32.00, coupon: '€5.00', fulfillment: 'FBA', monthlySales: 50, availableDate: '2025-01-01' },
    { asin: 'B0CAD00002', price: 32.00, coupon: 'CA$5.00', fulfillment: 'FBA', monthlySales: 50, availableDate: '2025-01-01' },
    { asin: 'B0BUY20003', price: 32.00, coupon: 'Buy 2, save $10', fulfillment: 'FBA', monthlySales: 50, availableDate: '2025-01-01' },
  ], { as_of_date: '2026-11-22' });
  assert.equal(foreignAndMultiBand.band.min_usd, 32.00);
  assert.equal(foreignAndMultiBand.band.max_usd, 32.00);

  const subSplitForeign = splitSearchPageSubForms(
    [{ asin: 'B0EUR00001', title: 'Wood Tray', price: 32.00, coupon: '€5.00' }],
    [{ sub_form_id: 'wood', match: () => true }],
  );
  assert.equal(subSplitForeign.sub_forms[0].items[0].ongoing_coupon_usd, undefined);

  const cliffCentBand = analyzeMainstreamPriceBand([
    { asin: 'B0CLF00001', list_price_usd: 55.56, ongoing_coupon_pct: 0.10, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-01-01' },
    { asin: 'B0CLF00002', list_price_usd: 55.56, ongoing_coupon_pct: 0.10, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-01-01' },
  ], { as_of_date: '2026-11-22' });
  const feeEff50 = resolveEffectivePricing({ list_price_usd: 55.56, ongoing_coupon_pct: 0.10 });
  assert.equal(cliffCentBand.band.p50_usd, 50.00);
  assert.equal(feeEff50.net_effective_price_usd, 50.00);

  // Round-4 HIGH 1: 6-tier 2027 Oversize weight-stepped + 3.5% fuel-surcharge floor rejects $11.00 and $28.15 on Medium Oversize (40x20x12 in, dim 69.06 lb -> floor $40.14765)
  const medOversizeReject11 = estimateGate1A2027({
    pkg: oversizePkg,
    ...oversizeScreeningInputs,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-med-oversize-11',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: oversizePkg,
      fulfillment_usd: 11.00,
      placement_usd: 1.50,
      storage_per_unit_usd: 0.90,
      returns_processing_usd: 0,
    },
  });
  assert.equal(medOversizeReject11.status, 'needs_calculator_verification');
  assert.match(medOversizeReject11.reason, /medium_oversize/i);

  const medOversizeAcceptFull = estimateGate1A2027({
    pkg: oversizePkg,
    ...oversizeScreeningInputs,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-med-oversize-ok',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: oversizePkg,
      fulfillment_usd: 40.15,
      placement_usd: 1.50,
      storage_per_unit_usd: 0.90,
      returns_processing_usd: 0,
    },
  });
  assert.equal(medOversizeAcceptFull.status, 'verified');

  // Dangerous-goods and Holiday-Peak non-SIPP overrides MUST ALSO enforce the 2027 non-peak Oversize/Bulky floor!
  const medOversizeDgReject = estimateGate1A2027({
    pkg: { ...oversizePkg, is_dangerous_goods: true },
    ...oversizeScreeningInputs,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-med-oversize-dg-under',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: { ...oversizePkg, is_dangerous_goods: true },
      is_dangerous_goods: true,
      fulfillment_usd: 11.00,
      placement_usd: 1.50,
      storage_per_unit_usd: 0.90,
      returns_processing_usd: 0,
    },
  });
  assert.equal(medOversizeDgReject.status, 'needs_calculator_verification');
  assert.match(medOversizeDgReject.reason, /medium_oversize/i);

  const medOversizePeakReject = estimateGate1A2027({
    pkg: oversizePkg,
    ...oversizeScreeningInputs,
    sales_window: { from: '2027-10-15', through: '2027-12-31' },
    storage_window: { from: '2027-10-15', through: '2027-12-31' },
    inbound_window: { from: '2027-10-01', through: '2027-10-10' },
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-22',
      evidence_ref: 'ev-med-oversize-peak-under',
      verified_price_band: '10_to_50',
      effective_from: '2027-10-15',
      effective_through: '2027-12-31',
      pkg: oversizePkg,
      fulfillment_usd: 11.00,
      placement_usd: 1.50,
      storage_per_unit_usd: 2.00,
      returns_processing_usd: 0,
    },
  });
  assert.equal(medOversizePeakReject.status, 'needs_calculator_verification');
  assert.match(medOversizePeakReject.reason, /medium_oversize/i);

  // Round-4 Coupon: "Save 10% on 2 or more items" ignored as multi-unit promo, "$ 5 off" parsed as $5.00 USD coupon
  assert.equal(parseSingleUnitUsdCoupon('Save 10% on 2 or more items').type, 'none');
  assert.equal(parseSingleUnitUsdCoupon('Save 10% when buying 2 items').type, 'none');
  assert.equal(parseSingleUnitUsdCoupon('Save 10% on six or more items').type, 'none');
  assert.equal(parseSingleUnitUsdCoupon('Save $5 on 2 select items').type, 'none');
  assert.deepEqual(parseSingleUnitUsdCoupon('$ 5 off'), { type: 'usd', pct: null, usd: 5 });
  const multiTierPeersBand = analyzeMainstreamPriceBand([
    { asin: 'B0MLT00001', price: 32.99, coupon: 'Save 10% on 2 or more items', fulfillment: 'FBA', monthlySales: 80, availableDate: '2025-01-01' },
    { asin: 'B0MLT00002', price: 32.99, coupon: 'Save 10% on 2 or more items', fulfillment: 'FBA', monthlySales: 75, availableDate: '2025-01-01' },
  ], { as_of_date: '2026-11-22', strict_mature_only: true });
  assert.equal(multiTierPeersBand.mature_regular_band.p50_usd, 32.99, 'Multi-unit promo must NOT push $32.99 peers below $29.99');

  // Synthetic Bulky 2027 checks: Medium Bulky flatness exemption, GFGVB6C7ZF38285W non-SIPP packaging service fee ($1.51–$4.04 by dim weight), and opt-in allow_bulky_2027
  const medBulkyFlat = classifySizeTier2027({ length_in: 30, width_in: 25, height_in: 3.9, unit_weight_lb: 10 });
  assert.equal(medBulkyFlat.status, 'verified', 'Medium Bulky (<=59x33x33) must not be blocked by Oversize-only flatness check');
  assert.equal(medBulkyFlat.size_tier, 'medium_bulky');

  const pkgFeeUnder5Dim = lookupBulkyPackagingServiceFee2027({
    pkg: { length_in: 20, width_in: 8, height_in: 4, unit_weight_lb: 3.8 }, // dim = 640/139 = 4.60 lb <= 5 lb -> $1.51
    requires_amazon_packaging: true,
  });
  assert.equal(pkgFeeUnder5Dim.status, 'verified');
  assert.equal(pkgFeeUnder5Dim.fee_usd, 1.51);

  const pkgFee8Dim = lookupBulkyPackagingServiceFee2027({
    pkg: { length_in: 24, width_in: 12, height_in: 4, unit_weight_lb: 3.0 }, // dim = 1152/139 = 8.29 lb -> 5-10 lb -> $1.68
    requires_amazon_packaging: true,
  });
  assert.equal(pkgFee8Dim.fee_usd, 1.68);

  // Official GFGVB6C7ZF38285W "40 to <45 lb = $3.80" vs "45 lb or more = $4.04" exact boundary check
  const pkgFeeBelow45 = lookupBulkyPackagingServiceFee2027({
    pkg: { length_in: 44, width_in: 14, height_in: 10, unit_weight_lb: 12 }, // dim = 6160/139 = 44.3165 lb < 45 lb -> $3.80
    requires_amazon_packaging: true,
  });
  assert.equal(pkgFeeBelow45.fee_usd, 3.80);
  const pkgFeeExact45 = lookupBulkyPackagingServiceFee2027({
    pkg: { length_in: 45, width_in: 13.9, height_in: 10, unit_weight_lb: 12 }, // dim = 6255/139 = exact 45.0000 lb -> $4.04!
    requires_amazon_packaging: true,
  });
  assert.equal(pkgFeeExact45.dim_weight_lb, 45);
  assert.equal(pkgFeeExact45.fee_usd, 4.04);

  const synthBulkySpec = {
    pkg: { length_in: 20.0, width_in: 8.0, height_in: 4.0, unit_weight_lb: 3.80 },
    price_usd: 64.00,
    fx_cny_per_usd: 7.00,
    refund_fraction: 0.065,
    fee_category: 'Home and Kitchen', // threshold 0.081 -> $0 excess return
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    headhaul_usd: 3.50,
    collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-25' },
  };
  // Bulky is verified by default in active r59+ runtime
  const synthBulkyDefaultMerged = estimateGate1A2027(synthBulkySpec);
  assert.equal(synthBulkyDefaultMerged.status, 'verified', 'Non-SIPP Bulky defaults to merged base*1.035 + $1.51 non-SIPP packaging fee');
  assert.equal(synthBulkyDefaultMerged.components.fulfillment.packaging_service_fee_usd, 1.51);
  const synthBulkyOwnBox = estimateGate1A2027({ ...synthBulkySpec, allow_bulky_2027: true, requires_amazon_packaging: false });
  const synthBulkyAmzBox = estimateGate1A2027({ ...synthBulkySpec, allow_bulky_2027: true, requires_amazon_packaging: true });
  assert.equal(synthBulkyOwnBox.status, 'verified');
  assert.equal(synthBulkyAmzBox.status, 'verified');
  assert.equal(synthBulkyDefaultMerged.landed_domestic_cap_usd, synthBulkyAmzBox.landed_domestic_cap_usd);
  assert.equal(synthBulkyAmzBox.components.fulfillment.packaging_service_fee_usd, 1.51);
  assert.ok(synthBulkyOwnBox.landed_domestic_cap_usd > synthBulkyAmzBox.landed_domestic_cap_usd);
  const synthBulkySolved = solveMinPriceForMargin2027({
    ...synthBulkySpec,
    allow_bulky_2027: true,
    requires_amazon_packaging: false,
    landed_domestic_cny: 140,
  });
  assert.equal(synthBulkySolved.status, 'verified');
  assert.ok(synthBulkySolved.feasible_min_price_usd >= 68 && synthBulkySolved.feasible_min_price_usd <= 72);
});

test('Astra Round-2 H2 Regression: runGate1BForForm interior $50.00 cliff probe preserves non-SIPP Bulky packaging fee ($1.51)', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const bulkyPkg = { length_in: 20.0, width_in: 8.0, height_in: 4.0, unit_weight_lb: 3.80 }; // Small Bulky, dim 4.60 lb -> $1.51 packaging fee
    store.upsertCandidateForm({
      form_id: 'synth-bulky-cliff-50',
      product_family_key: 'synth-bulky',
      label: 'Synthetic Bulky Shelf',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'shelf', qty_per_saleable_set: 1 }],
    });
    const baseCommon = {
      pkg: bulkyPkg,
      fx_cny_per_usd: 7.00,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      headhaul_usd: 3.50,
      collection_rate: 0.005,
      sales_window: { from: '2027-02-01', through: '2027-09-30' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-01-25' },
      allow_bulky_2027: true,
      requires_amazon_packaging: true,
    };
    const est48 = estimateGate1A2027({ ...baseCommon, price_usd: 48.00 });
    const est50 = estimateGate1A2027({ ...baseCommon, price_usd: 50.00 });
    const est50WithoutPkg = estimateGate1A2027({ ...baseCommon, price_usd: 50.00, requires_amazon_packaging: false });
    const est51 = estimateGate1A2027({ ...baseCommon, price_usd: 51.00 });
    assert.equal(est50.status, 'verified');
    assert.ok(est50WithoutPkg.landed_domestic_cap_cny > est50.landed_domestic_cap_cny + 5);

    // Choose a synthetic quote that FAILS at $48, $50, and $51 WITH $1.51 packaging fee (~28.85% at $50),
    // yet WOULD pass >30% at $50 (~31.98%) if $1.51 packaging fee were dropped!
    const targetCnyPerUnit = Number(((est50.landed_domestic_cap_cny + est50WithoutPkg.landed_domestic_cap_cny) / 2).toFixed(2));
    const g1a = runGate1AForForm(store, {
      form_id: 'synth-bulky-cliff-50',
      profile_revision: 59,
      specific_rights_conflict: false,
      strong_date_dependency: false,
      scenarios: [
        { ...baseCommon, id: 'sc-48', price_usd: 48.00, available_date: '2025-01-01' },
        { ...baseCommon, id: 'sc-51', price_usd: 51.00, available_date: '2025-01-01' },
      ],
    });
    assert.equal(g1a.proceed_to_gate1b, true);

    store.recordSourcingQuote1688({
      quote_id: 'q-synth-bulky-50',
      form_id: 'synth-bulky-cliff-50',
      observed_at: '2026-11-23T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'synth-ref-1',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.00,
      pkg: bulkyPkg,
      ui_readback: {
        logged_in: true,
        viewport_width_px: 1600,
        selected_sku_row_visible: true,
        settlement_bar_visible: true,
        applied_quantity_confirmed: true,
      },
      sku_lines: [{
        component_id: 'shelf',
        offer_id: '900000001',
        sku_id: '1',
        pack_multiple: 1,
        qty_per_saleable_set: 1,
        moq_qty: 10,
        ordered_qty: 100,
        unit_price_cny: targetCnyPerUnit,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: Math.round(targetCnyPerUnit * 100),
      domestic_freight_cny_total: 0,
    });

    const g1b = await runGate1BForForm(store, {
      form_id: 'synth-bulky-cliff-50',
      profile_revision: 59,
      existing_quote_id: 'q-synth-bulky-50',
      early_screen_builder: () => ([
        {
          id: 'sc-48',
          saleable_unit: '1 shelf',
          operating_period: 'off_peak',
          price_usd: 48.00,
          fx_cny_per_usd: 7.00,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          return_threshold: 0.081,
          referral_terms: baseCommon.referral_terms,
          headhaul: { usd_per_unit: 3.50, bond_included: true },
          fulfillment_usd: est48.components.fulfillment.total_usd,
          placement_usd: est48.components.placement.selected_usd,
          storage: {
            cubic_feet_per_unit: est48.components.storage.cubic_feet,
            rate_usd_per_cuft_month: 0.56,
            average_inventory_days: 45,
          },
          collection_rate: 0.005,
          other_applicable_usd: 0,
          specific_rights_conflict: false,
          strong_date_dependency: false,
          pkg: bulkyPkg,
          fee_context: {
            marketplace: 'US',
            currency: 'USD',
            package_ref: 'synth-bulky-pkg',
            sales: baseCommon.sales_window,
            storage: baseCommon.storage_window,
            inbound: baseCommon.inbound_window,
          },
        },
        {
          id: 'sc-51',
          saleable_unit: '1 shelf',
          operating_period: 'off_peak',
          price_usd: 51.00,
          fx_cny_per_usd: 7.00,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          return_threshold: 0.081,
          referral_terms: baseCommon.referral_terms,
          headhaul: { usd_per_unit: 3.50, bond_included: true },
          fulfillment_usd: est51.components.fulfillment.total_usd,
          placement_usd: est51.components.placement.selected_usd,
          storage: {
            cubic_feet_per_unit: est51.components.storage.cubic_feet,
            rate_usd_per_cuft_month: 0.56,
            average_inventory_days: 45,
          },
          collection_rate: 0.005,
          other_applicable_usd: 0,
          specific_rights_conflict: false,
          strong_date_dependency: false,
          pkg: bulkyPkg,
          fee_context: {
            marketplace: 'US',
            currency: 'USD',
            package_ref: 'synth-bulky-pkg',
            sales: baseCommon.sales_window,
            storage: baseCommon.storage_window,
            inbound: baseCommon.inbound_window,
          },
        },
      ]),
    });
    assert.equal(g1b.status, 'gate1b_rejected', 'Must NOT omit $1.51 Bulky packaging fee at interior $50.00 cliff probe');
    assert.equal(g1b.proceed_to_gate2_3, false);
  } finally {
    store.close();
  }
});
