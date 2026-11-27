import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUSINESS_THRESHOLDS } from '../src/business-thresholds.mjs';
import {
  analyzeMainstreamPriceBand,
  detectKeepaVeteranClearanceOrWar,
  evaluateGate0CategoryBoundary,
} from '../src/price-band.mjs';
import { parseSellerSpriteKeepaPayload, buildKeepaPeerFactsForMarketJudge } from '../src/adapters/keepa.mjs';
import {
  classifySpApiRestrictionReasons,
  extractSpApiFinalistCalibration,
  extractSpApiPeerPackagesFromRawPayloads,
} from '../src/adapters/sp-api.mjs';
import {
  extractNicheAverageStarReference,
  extractQ31DualSourceKeywordCounts,
  ingestTrialSpecification,
  mergeKeepaPayloadsIntoPeerListings,
} from '../src/raw-ingest.mjs';
import { canonicalizeConnectorToolName, validateProviderCall } from '../src/provider-guards.mjs';
import { parseMarketObservationResult } from '../src/openai/workflow-tasks.mjs';
import { scoreCandidate } from '../src/scoring.mjs';
import {
  DISCOVERY_CHANNELS,
  auditDiscoveryCoverage,
  planDiscoveryBatch,
  resolveChannelMeta,
} from '../src/discovery-channels.mjs';
import { runGate1AForForm, runGate1BForForm } from '../src/pipeline.mjs';
import { openSelectionStore } from '../src/store.mjs';
import {
  DEFAULT_R59_UI_READBACK,
  REPO_ROOT,
  STAGE4_AS_OF_DATE,
  loadR59Profile,
  loadSyntheticBatch,
  makeDatedKeepaReceipt,
  makeGate1AScenario,
  makeSpApiCatalogItem,
  makeSpApiFeesEstimate,
  makeSteadyPeer,
  registerStage4Form,
  runCliMem,
  withTempDir,
  withTempDirAsync,
} from './helpers/test-fixtures.mjs';

const r59Profile = loadR59Profile();
const syntheticFixture = loadSyntheticBatch();

test('Issue #11: approved registry value (2) supplements with 0/1 veterans, stops with 2 veterans, and keeps <59 replay on archive tag', () => {
  assert.equal(BUSINESS_THRESHOLDS.min_veterans_before_growth_supplement, 2);

  const vet1 = makeSteadyPeer({ asin: 'B0SYNVET01', priceUsd: 49.99, ageDays: 420 });
  const vet2 = makeSteadyPeer({ asin: 'B0SYNVET02', priceUsd: 54.99, ageDays: 510 });
  const growth1 = makeSteadyPeer({ asin: 'B0SYNGRW01', priceUsd: 39.99, ageDays: 180 });

  const zeroVetBand = analyzeMainstreamPriceBand([growth1], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(zeroVetBand.growth_supplement_used, true);
  assert.deepEqual(zeroVetBand.mainstream_pool.map(r => r.asin), ['B0SYNGRW01']);

  const oneVetBand = analyzeMainstreamPriceBand([vet1, growth1], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(oneVetBand.growth_supplement_used, true);
  assert.equal(oneVetBand.mature_regular_band.growth_supplement_used, true);
  assert.equal(oneVetBand.mature_regular_band.basis, 'veteran_ge_365d_plus_steady_growth_91_364d_supplement');
  assert.deepEqual(oneVetBand.mainstream_pool.map(r => r.asin).sort(), ['B0SYNGRW01', 'B0SYNVET01']);
  assert.equal(oneVetBand.mature_regular_band.min_usd, 39.99);
  assert.equal(oneVetBand.mature_regular_band.max_usd, 49.99);

  const twoVetBand = analyzeMainstreamPriceBand([vet1, vet2, growth1], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(twoVetBand.growth_supplement_used, false);
  assert.equal(twoVetBand.mature_regular_band.growth_supplement_used, false);
  assert.equal(twoVetBand.mature_regular_band.basis, 'veteran_ge_365d_keepa_steady');
  assert.deepEqual(twoVetBand.mainstream_pool.map(r => r.asin).sort(), ['B0SYNVET01', 'B0SYNVET02']);
  assert.equal(twoVetBand.mature_regular_band.min_usd, 49.99);
  assert.equal(twoVetBand.mature_regular_band.max_usd, 54.99);
  const heldGrowth = twoVetBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNGRW01');
  assert.ok(heldGrowth, 'Growth peer must remain visible in observed_out_of_band_peers when >=2 veterans anchor the band');
  assert.equal(heldGrowth.reason_code, 'growth_stage_held_veterans_sufficient');

  const strOptBand = analyzeMainstreamPriceBand([vet1, vet2, growth1], { as_of_date: STAGE4_AS_OF_DATE, spiral_max_age_days: '90' });
  assert.match(
    strOptBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNGRW01')?.reason_zh ?? '',
    /91–364 天/,
  );

  const store = openSelectionStore(':memory:');
  try {
    const formId = registerStage4Form(store, { formId: 'form-issue11-vet-threshold' });
    const growthScenario = makeGate1AScenario({ asin: 'B0SYNGRW01', priceUsd: 39.99, ageDays: 180 });
    const baseGate1A = { form_id: formId, profile_revision: 59, scenarios: [growthScenario] };
    const g1aZeroVet = runGate1AForForm(store, {
      ...baseGate1A,
      price_band_analysis: { listings: [growth1], options: { as_of_date: STAGE4_AS_OF_DATE } },
    });
    const g1aOneVet = runGate1AForForm(store, {
      ...baseGate1A,
      price_band_analysis: { listings: [vet1, growth1], options: { as_of_date: STAGE4_AS_OF_DATE } },
    });
    const g1aTwoVet = runGate1AForForm(store, {
      ...baseGate1A,
      price_band_analysis: { listings: [vet1, vet2, growth1], options: { as_of_date: STAGE4_AS_OF_DATE } },
    });
    assert.equal(g1aZeroVet.proceed_to_gate1b, true);
    assert.equal(g1aZeroVet.regular_band_reference?.growth_supplement_used, true);
    assert.equal(g1aOneVet.proceed_to_gate1b, true);
    assert.equal(g1aOneVet.regular_band_reference?.growth_supplement_used, true);
    assert.equal(g1aOneVet.regular_band_reference?.min_usd, 39.99);
    assert.equal(g1aTwoVet.proceed_to_gate1b, false);
    assert.equal(g1aTwoVet.regular_band_reference?.growth_supplement_used, false);
    assert.equal(g1aTwoVet.regular_band_reference?.min_usd, 49.99);
  } finally {
    store.close();
  }

  assert.throws(
    () => analyzeMainstreamPriceBand([vet1, growth1], { profile_revision: 58, as_of_date: STAGE4_AS_OF_DATE }),
    /profile_revision 58.*retired/i,
  );
});

test('Issue #11: isolated registry mutation of min_veterans_before_growth_supplement (2 -> 3) dynamically shifts price-band supplementation', async () => {
  await withTempDirAsync('issue11-veteran-threshold-', async dir => {
    const tmpSrc = join(dir, 'src');
    cpSync(join(REPO_ROOT, 'src', 'rates'), join(tmpSrc, 'rates'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'utils'), join(tmpSrc, 'utils'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'adapters'), join(tmpSrc, 'adapters'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'business-thresholds.mjs'), join(tmpSrc, 'business-thresholds.mjs'));
    cpSync(join(REPO_ROOT, 'src', 'fba-calculator.mjs'), join(tmpSrc, 'fba-calculator.mjs'));
    cpSync(join(REPO_ROOT, 'src', 'price-band.mjs'), join(tmpSrc, 'price-band.mjs'));

    const thresholdsPath = join(tmpSrc, 'business-thresholds.mjs');
    const orig = (await import('node:fs')).readFileSync(thresholdsPath, 'utf8');
    const mutated = orig.replace(
      /(min_veterans_before_growth_supplement:\s*\{\s*value:\s*)2(\s*,)/,
      '$13$2',
    );
    assert.notEqual(mutated, orig, 'Expected min_veterans_before_growth_supplement value: 2 in src/business-thresholds.mjs');
    writeFileSync(thresholdsPath, mutated, 'utf8');

    const isoThresholds = await import(pathToFileURL(thresholdsPath).href);
    const isoPriceBand = await import(pathToFileURL(join(tmpSrc, 'price-band.mjs')).href);
    assert.equal(isoThresholds.BUSINESS_THRESHOLDS.min_veterans_before_growth_supplement, 3);

    const vet1 = makeSteadyPeer({ asin: 'B0SYNVET01', priceUsd: 49.99, ageDays: 420 });
    const vet2 = makeSteadyPeer({ asin: 'B0SYNVET02', priceUsd: 54.99, ageDays: 510 });
    const vet3 = makeSteadyPeer({ asin: 'B0SYNVET03', priceUsd: 59.99, ageDays: 600 });
    const growth1 = makeSteadyPeer({ asin: 'B0SYNGRW01', priceUsd: 39.99, ageDays: 180 });

    const twoVetMutated = isoPriceBand.analyzeMainstreamPriceBand([vet1, vet2, growth1], { as_of_date: STAGE4_AS_OF_DATE });
    assert.equal(twoVetMutated.growth_supplement_used, true);
    assert.deepEqual(twoVetMutated.mainstream_pool.map(r => r.asin).sort(), ['B0SYNGRW01', 'B0SYNVET01', 'B0SYNVET02']);

    const threeVetMutated = isoPriceBand.analyzeMainstreamPriceBand([vet1, vet2, vet3, growth1], { as_of_date: STAGE4_AS_OF_DATE });
    assert.equal(threeVetMutated.growth_supplement_used, false);
    assert.deepEqual(threeVetMutated.mainstream_pool.map(r => r.asin).sort(), ['B0SYNVET01', 'B0SYNVET02', 'B0SYNVET03']);
  });
});

test('Issue #33 (4B Keepa): locks >=365d veteran floor, blocks undated/sparse/sub-90d/AI-only Keepa bypasses, and aligns inline vs raw merge', () => {
  const datedVet = makeSteadyPeer({ asin: 'B0SYN4BV01', priceUsd: 49.99, ageDays: 400 });

  assert.throws(
    () => analyzeMainstreamPriceBand([datedVet], { as_of_date: STAGE4_AS_OF_DATE, veteran_min_age_days: 90 }),
    /veteran_min_age_days.*365/i,
  );
  assert.throws(
    () => analyzeMainstreamPriceBand([datedVet], { as_of_date: STAGE4_AS_OF_DATE, veteran_min_age_days: 364 }),
    /veteran_min_age_days.*365/i,
  );

  const undatedTrailingPeer = {
    asin: 'B0SYN4BU01', parent_asin: 'P0SYN4BU01', title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA', price_usd: 41.20, monthly_units: 200, age_days: 500,
    keepa_90d_steady: true, keepa_90d_median_usd: 58.40, historical_regular_price_usd: 58.40,
    ai_qualitative_bucket: 'primary_comparable',
    keepa_trend: { series: { price: [...Array(96).fill(58.40), 41.20, 41.20, 41.20, 41.20, 41.20] } },
  };
  const undatedBand = analyzeMainstreamPriceBand([undatedTrailingPeer], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(undatedBand.mature_regular_band, null);
  assert.equal(undatedBand.mainstream_count, 0);
  const obsUndated = undatedBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYN4BU01');
  assert.equal(obsUndated?.reason_code, 'undated_keepa_cannot_enter_mature_band');
  assert.equal(obsUndated?.net_price_usd, 41.20);

  const topUndatedBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BU03', title: 'Solid Wood Desktop Paint Rack', fulfillment_channel: 'FBA',
    price_usd: 57.00, monthly_units: 140, age_days: 430, has_timestamps: false, historical_regular_price_usd: 57.00,
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(topUndatedBand.mature_regular_band, null);
  assert.notEqual(topUndatedBand.regular_band_reference?.basis, 'observed_historical_regular_prices');

  const aiOnlyBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BAI1', title: 'Solid Wood Desktop Paint Rack', fulfillment_channel: 'FBA',
    price_usd: 44.00, monthly_units: 120, age_days: 400, ai_qualitative_bucket: 'primary_comparable',
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(aiOnlyBand.mature_regular_band, null);

  const sparseReceipt = makeDatedKeepaReceipt({
    asin: 'B0SYN4BSP0', startDate: '2026-08-30', days: 90,
    prices: [...Array(88).fill(null), 44.00, 44.00],
  });
  const parsedSparse = parseSellerSpriteKeepaPayload(sparseReceipt, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(parsedSparse.keepa_90d_steady, false);
  assert.equal(parsedSparse.window_90d.calendar_span_days, 2);
  const sparseBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BSP0', title: 'Solid Wood Desktop Paint Rack', fulfillment_channel: 'FBA',
    price_usd: 44.00, monthly_units: 140, age_days: 440, keepa_trend: sparseReceipt.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(sparseBand.mature_regular_band, null);
  assert.equal(sparseBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYN4BSP0')?.reason_code, 'keepa_window_under_90d_cannot_enter_mature_band');

  const sub90dReceipt = makeDatedKeepaReceipt({ asin: 'B0SYN4BS60', startDate: '2026-09-28', days: 60, priceUsd: 46.50 });
  const sub90Band = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BS60', title: 'Solid Wood Desktop Paint Rack', fulfillment_channel: 'FBA',
    price_usd: 46.50, monthly_units: 180, age_days: 450, ai_qualitative_bucket: 'primary_comparable',
    keepa_90d_steady: true, keepa_trend: sub90dReceipt.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(sub90Band.mature_regular_band, null);
  assert.equal(sub90Band.observed_out_of_band_peers.find(p => p.asin === 'B0SYN4BS60')?.reason_code, 'keepa_window_under_90d_cannot_enter_mature_band');

  const mergedUndated = mergeKeepaPayloadsIntoPeerListings(
    [{ asin: 'B0SYN4BU02', price_usd: 44.10, age_days: 420, fulfillment_channel: 'FBA', monthly_units: 150, keepa_90d_steady: true, keepa_90d_median_usd: 62.50 }],
    [{ asin: 'B0SYN4BU02', series: { price: [...Array(92).fill(62.50), 44.10, 44.10, 44.10, 44.10] } }],
    { as_of_date: STAGE4_AS_OF_DATE },
  );
  assert.equal(mergedUndated[0].keepa_has_timestamps, false);
  assert.equal(mergedUndated[0].keepa_90d_steady, false);
  assert.equal(mergedUndated[0].keepa_90d_median_usd, undefined);
  assert.equal(mergedUndated[0].undated_sample_median_usd, 62.50);
  assert.equal(analyzeMainstreamPriceBand(mergedUndated, { as_of_date: STAGE4_AS_OF_DATE }).mature_regular_band, null);

  const fresh44Receipt = makeDatedKeepaReceipt({ asin: 'B0SYN4BOV1', startDate: '2026-08-30', days: 90, priceUsd: 44.00 });
  const mergedFresh = mergeKeepaPayloadsIntoPeerListings(
    [{ asin: 'B0SYN4BOV1', price_usd: 44.00, age_days: 420, fulfillment_channel: 'FBA', monthly_units: 160, keepa_package_only: true, keepa_90d_median_usd: 80.00 }],
    [fresh44Receipt],
    { as_of_date: STAGE4_AS_OF_DATE },
  );
  assert.equal(mergedFresh[0].keepa_package_only, undefined);
  assert.equal(mergedFresh[0].keepa_90d_median_usd, 44.00);
  assert.equal(analyzeMainstreamPriceBand(mergedFresh, { as_of_date: STAGE4_AS_OF_DATE }).mature_regular_band.p50_usd, 44.00);

  const valid90d = makeDatedKeepaReceipt({ asin: 'B0SYN4BV90', startDate: '2026-08-30', days: 90, priceUsd: 49.99 });
  const valid90dVet = {
    asin: 'B0SYN4BV90', parent_asin: 'P0SYN4BV90', title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA', price_usd: 49.99, monthly_units: 200, age_days: 365,
    ts: valid90d.keepa_trend.ts, series: valid90d.keepa_trend.series,
  };
  const peer364d = {
    asin: 'B0SYN4BG36', parent_asin: 'P0SYN4BG36', title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA', price_usd: 42.99, monthly_units: 200, age_days: 364,
    keepa_trend: makeDatedKeepaReceipt({ asin: 'B0SYN4BG36', startDate: '2026-08-30', days: 90, priceUsd: 42.99 }).keepa_trend,
  };
  const validBand = analyzeMainstreamPriceBand([valid90dVet, peer364d], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(validBand.age_tier_counts.veteran_ge_365d, 1);
  assert.equal(validBand.age_tier_counts.growth_91_364d_steady, 1);
  assert.equal(validBand.mature_regular_band.min_usd, 42.99);
  assert.equal(validBand.mature_regular_band.max_usd, 49.99);
});

test('Issue #33 (4B SP-API): CatalogItems shapes/units/marketplace/qty parity, fee completeness, archived summary receipt, recall scope, and PriceToEstimateFees isolation', () => {
  const caItem = makeSpApiCatalogItem({ asin: 'B0SYN4BSP1', marketplaceId: 'A2EUQ1WTGCTBG2', weight: 9.9 });
  const usItem = makeSpApiCatalogItem({
    asin: 'B0SYN4BSP1', length: 1450, width: 950, height: 325, weight: 275,
    dimUnit: 'hundredths-inches', weightUnit: 'hundredths-pounds', packageQuantity: 4,
  });
  const wrappedCatalog = { payload: { data: { items: [caItem, usItem] } } };
  const feesRaw = makeSpApiFeesEstimate({ asin: 'B0SYN4BSP1', priceUsd: 59.99, referralUsd: 9.00, fbaUsd: 8.15 });
  const brandGateRest = {
    asin: 'B0SYN4BSP1',
    restrictions: [{ marketplaceId: 'ATVPDKIKX0DER', conditionType: 'new_new', reasons: [{ message: 'You need approval to list in this brand.' }] }],
  };

  const fullCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1', price_usd: 59.99, expected_package_quantity: 4,
    catalogItemRaw: wrappedCatalog, feesEstimateRaw: feesRaw, restrictionsRaw: brandGateRest,
  });
  assert.equal(fullCal.package_calibration_status, 'verified');
  assert.equal(fullCal.finalist_calibration_complete, true);
  assert.deepEqual(fullCal.missing_components, []);
  assert.equal(fullCal.official_pkg.length_in, 14.5);
  assert.equal(fullCal.official_pkg.unit_weight_lb, 2.75);
  assert.equal(fullCal.official_pkg.package_quantity, 4);
  assert.equal(fullCal.restrictions.restriction_scope, 'competitor_brand_only');

  assert.equal(extractSpApiPeerPackagesFromRawPayloads([wrappedCatalog], { expected_package_quantity: 4 }).length, 1);
  assert.equal(extractSpApiPeerPackagesFromRawPayloads([wrappedCatalog], { expected_package_quantity: 1 }).length, 0);

  const noQtyCat = makeSpApiCatalogItem({ asin: 'B0SYN4BSP1' });
  delete noQtyCat.attributes;
  const unverifiedQtyCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1', price_usd: 59.99, expected_package_quantity: 4,
    catalogItemRaw: noQtyCat, feesEstimateRaw: feesRaw, restrictionsRaw: brandGateRest,
  });
  assert.equal(unverifiedQtyCal.package_calibration_status, 'unverified_package_quantity');
  assert.equal(unverifiedQtyCal.finalist_calibration_complete, false);

  const missListCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    catalogItemRaw: { items: [makeSpApiCatalogItem({ asin: 'B0SYNOTHER' })] },
  });
  assert.equal(missListCal.package_calibration_status, 'asin_not_found_in_catalog_items');

  const ukOnlyCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1', marketplace_id: 'ATVPDKIKX0DER',
    catalogItemRaw: makeSpApiCatalogItem({ asin: 'B0SYN4BSP1', marketplaceId: 'A1F83G8C2ARO7P' }),
  });
  assert.equal(ukOnlyCal.package_calibration_status, 'marketplace_mismatch');
  assert.equal(ukOnlyCal.official_pkg, null);

  const totalOnlyFeesCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1', price_usd: 59.99, catalogItemRaw: usItem,
    feesEstimateRaw: {
      FeesEstimateResult: {
        Status: 'Success',
        FeesEstimateIdentifier: {
          MarketplaceId: 'ATVPDKIKX0DER', IdType: 'ASIN', IdValue: 'B0SYN4BSP1', IsAmazonFulfilled: true,
          PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 59.99 } },
        },
        FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 17.15 }, FeeDetailList: [] },
      },
    },
    restrictionsRaw: brandGateRest,
  });
  assert.equal(totalOnlyFeesCal.fee_calibration_status, 'incomplete_fee_details');
  assert.equal(totalOnlyFeesCal.fee_calibration.total_fees_estimate_usd, 17.15);
  assert.equal(totalOnlyFeesCal.finalist_calibration_complete, false);
  assert.ok(totalOnlyFeesCal.missing_components.includes('product_fees_estimate'));

  const recallRest = classifySpApiRestrictionReasons([
    { reasonCode: 'NOT_ELIGIBLE', message: 'Safety recall: this item is not permitted for sale due to manufacturer recall.' },
  ]);
  assert.equal(recallRest.has_single_asin_recall_note, true);
  assert.equal(recallRest.restriction_scope, 'single_asin_recall_scope_check');
  assert.equal(recallRest.hard_category_ban, false);

  const genericNotEligible = classifySpApiRestrictionReasons([
    { reasonCode: 'NOT_ELIGIBLE', message: 'Seller account is not eligible to list this ASIN.' },
  ]);
  assert.equal(genericNotEligible.restriction_scope, 'category_or_product_approval');
  assert.equal(genericNotEligible.hard_category_ban, false);

  const unmatchedRestCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    restrictionsRaw: {
      listings_restrictions: [
        { asin: 'B0SYNOTHER', reasons: [{ reasonCode: 'NOT_ELIGIBLE', message: 'You need approval to list this product.' }] },
      ],
    },
  });
  assert.equal(unmatchedRestCal.restrictions, null);
  assert.equal(unmatchedRestCal.restrictions_status, 'asin_not_found_in_listings_restrictions');
  assert.ok(unmatchedRestCal.missing_components.includes('listings_restrictions'));
  assert.equal(unmatchedRestCal.finalist_calibration_complete, false);

  withTempDir('issue33-sp-api-', dir => {
    const baseCand = structuredClone(syntheticFixture.candidates[0]);
    baseCand.id = 'cand-issue33-sp';
    baseCand.screening.reference_price_usd.target_variant_asin = 'B0SYN4BSP1';
    baseCand.screening.reference_price_usd.value = 40;
    baseCand.economics.scenarios[0].price_anchor = {
      ...baseCand.economics.scenarios[0].price_anchor,
      target_variant_asin: 'B0SYN4BSP1', value: 40,
    };
    baseCand.economics.scenarios[0].cost_ledger.fee_context = {
      ...baseCand.economics.scenarios[0].cost_ledger.fee_context,
      sales: { from: '2027-02-01', through: '2027-10-14' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-15', through: '2027-10-14' },
    };

    const ssMarketFile = '01-ss-market.json';
    const spArchivedSummaryFile = '02-sp-archived-fees-restrictions.json';
    const spCatArrayFile = '03-sp-catalog-array.json';
    const spCatCaFile = '02b-sp-catalog-ca.json';
    writeFileSync(join(dir, ssMarketFile), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYN4BSP1', price: 40 }] }));
    writeFileSync(join(dir, spArchivedSummaryFile), JSON.stringify({
      marketplace_id: 'ATVPDKIKX0DER',
      fees_estimates: [{ reference_asin: 'B0SYN4BSP1', price_usd: 40, referral_fee_usd: 6.0, fba_pick_and_pack_usd: 6.5, total_fees_usd: 12.5 }],
      listings_restrictions: [{ asin: 'B0SYN4BSP1', reasons: [{ reasonCode: 'NOT_ELIGIBLE', message: 'You need approval to list in this brand.' }] }],
    }));
    writeFileSync(join(dir, spCatCaFile), JSON.stringify(caItem));
    writeFileSync(join(dir, spCatArrayFile), JSON.stringify({ payload: [usItem] }));

    const missingCatRes = ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: [ssMarketFile, spArchivedSummaryFile],
      candidates: [{ candidate: structuredClone(baseCand), raw_receipt_files: [ssMarketFile, spArchivedSummaryFile] }],
    }, r59Profile, { baseDir: dir });
    const missingCand = missingCatRes.batch.candidates[0];
    assert.equal(missingCand.sp_api_calibration.package_calibration_status, 'missing_catalog_items');
    assert.equal(missingCand.sp_api_calibration.fee_calibration_status, 'verified');
    assert.ok((missingCand.review_notes ?? []).some(n => /CatalogItems|官方包装尺寸/.test(String(n))));

    const fullIngestRes = ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: [ssMarketFile, spArchivedSummaryFile, spCatCaFile, spCatArrayFile],
      candidates: [{ candidate: structuredClone(baseCand), raw_receipt_files: [ssMarketFile, spArchivedSummaryFile, spCatCaFile, spCatArrayFile] }],
    }, r59Profile, { baseDir: dir });
    const fullCand = fullIngestRes.batch.candidates[0];
    assert.equal(fullCand.sp_api_calibration.package_calibration_status, 'verified');
    assert.equal(fullCand.sp_api_calibration.official_pkg.unit_weight_lb, 2.75);
    assert.equal(fullCand.economics.scenarios[0].cost_ledger.pkg.unit_weight_lb, 2.75);

    assert.throws(
      () => ingestTrialSpecification({
        profile_revision: 59,
        raw_receipt_files: [spArchivedSummaryFile, spCatArrayFile],
        candidates: [{ candidate: structuredClone(baseCand), raw_receipt_files: [spArchivedSummaryFile, spCatArrayFile] }],
      }, r59Profile, { baseDir: dir }),
      /price-binding|provenance/i,
    );
  });
});

test('Batch A1 Req 2a & 2b: dated 90d Keepa steadiness provenance, strict rejection of bare legacy booleans, and strict zero-tolerance delta visibility on $49.00 -> $48.99', () => {
  const noKeepaBand = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNOK01', parent_asin: 'P0SYNNOK01', title: 'Desk Tray A', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 400 },
    { asin: 'B0SYNNOK02', parent_asin: 'P0SYNNOK02', title: 'Desk Tray B', fulfillment: 'FBA', price_usd: 52.00, monthly_units: 110, age_days: 450 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(noKeepaBand.keepa_dated_90d_verified, false);
  assert.equal(noKeepaBand.keepa_steady_provenance, 'missing');
  assert.notEqual(noKeepaBand.mature_regular_band?.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(noKeepaBand.mature_regular_band?.keepa_dated_90d_verified, false);

  const bareLegacyPeers = [
    { asin: 'B0SYNLEG01', parent_asin: 'P0SYNLEG01', title: 'Desk Tray A', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 400, keepa_90d_steady: true },
    { asin: 'B0SYNLEG02', parent_asin: 'P0SYNLEG02', title: 'Desk Tray B', fulfillment: 'FBA', price_usd: 51.00, monthly_units: 110, age_days: 420, keepa_price_steady: true },
  ];
  const exploratoryLegacy = analyzeMainstreamPriceBand(bareLegacyPeers, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(exploratoryLegacy.keepa_dated_90d_verified, false);
  assert.equal(exploratoryLegacy.keepa_steady_provenance, 'legacy_boolean_unverified');
  assert.notEqual(exploratoryLegacy.mature_regular_band?.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(exploratoryLegacy.mature_regular_band?.keepa_dated_90d_verified, false);

  const strictLegacy = analyzeMainstreamPriceBand(bareLegacyPeers, { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(strictLegacy.mature_regular_band, null);
  assert.equal(strictLegacy.mainstream_count, 0);
  assert.equal(strictLegacy.keepa_dated_90d_verified, false);
  assert.ok(strictLegacy.spiral_watch.every(w => w.watch_reasons.includes('legacy_keepa_steady_boolean_without_dated_curve')));

  const dated1 = makeSteadyPeer({ asin: 'B0SYNDAT01', priceUsd: 49.00, ageDays: 420 });
  const dated2 = makeSteadyPeer({ asin: 'B0SYNDAT02', priceUsd: 53.00, ageDays: 480 });
  const verifiedBand = analyzeMainstreamPriceBand([dated1, dated2], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(verifiedBand.keepa_dated_90d_verified, true);
  assert.equal(verifiedBand.keepa_steady_provenance, 'dated_90d_keepa');
  assert.equal(verifiedBand.mature_regular_band?.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(verifiedBand.mature_regular_band?.keepa_dated_90d_verified, true);

  const tinyShiftReceipt = makeDatedKeepaReceipt({
    asin: 'B0SYNTINY1', startDate: '2026-08-30', days: 90,
    prices: [...Array(45).fill(49.00), ...Array(45).fill(48.99)],
  });
  const parsedTinyShift = parseSellerSpriteKeepaPayload(tinyShiftReceipt, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(parsedTinyShift.keepa_90d_steady, false);
  assert.equal(parsedTinyShift.window_90d.observed_price_min_usd, 48.99);
  assert.equal(parsedTinyShift.window_90d.observed_price_max_usd, 49.00);
  assert.equal(parsedTinyShift.window_90d.observed_date_start, '2026-08-30');
  assert.equal(parsedTinyShift.window_90d.observed_date_end, '2026-11-27');
  assert.equal(parsedTinyShift.window_90d.delta_usd, 0.01);

  const factsTiny = buildKeepaPeerFactsForMarketJudge(parsedTinyShift);
  assert.equal(factsTiny.window_90d?.delta_usd, 0.01);

  const tinyShiftBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNTINY1', parent_asin: 'P0SYNTINY1', title: 'Desk Tray Tiny Shift',
    fulfillment: 'FBA', price_usd: 48.99, monthly_units: 140, age_days: 420,
    keepa_trend: tinyShiftReceipt.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(tinyShiftBand.mature_regular_band, null);
  const tinyWatch = tinyShiftBand.spiral_watch.find(w => w.asin === 'B0SYNTINY1');
  const tinyOob = tinyShiftBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNTINY1');
  for (const row of [tinyWatch, tinyOob]) {
    assert.ok(row);
    assert.equal(row.observed_price_min_usd, 48.99);
    assert.equal(row.observed_price_max_usd, 49.00);
    assert.equal(row.observed_date_start, '2026-08-30');
    assert.equal(row.observed_date_end, '2026-11-27');
    assert.equal(row.delta_usd, 0.01);
  }
});

test('Batch A1 Req 2c, 2d & 2e: honest zombie-filtered older peer banner, conditional post-coupon newcomer label, and non-blocking single-parent anchor warning', () => {
  const zombieMixed = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNEW30', parent_asin: 'P0SYNNEW30', title: 'Desk Tray New', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 80, age_days: 30 },
    { asin: 'B0SYNZMB60', parent_asin: 'P0SYNZMB60', title: 'Desk Tray Zombie', fulfillment: 'FBA', price_usd: 55.00, monthly_units: 9, age_days: 600 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(zombieMixed.all_under_90d_blue_ocean, false);
  assert.equal(zombieMixed.mature_regular_band?.all_under_90d_blue_ocean, false);
  assert.doesNotMatch(zombieMixed.top_amber_banner_zh ?? '', /全员 90 天内新品蓝海/);
  assert.ok(Array.isArray(zombieMixed.excluded_older_peers) && zombieMixed.excluded_older_peers.length === 1);
  assert.equal(zombieMixed.excluded_older_peers[0].asin, 'B0SYNZMB60');
  assert.equal(zombieMixed.excluded_older_peers[0].reason_code, 'excluded_low_sales_zombie');
  assert.match(zombieMixed.top_amber_banner_zh ?? '', /B0SYNZMB60|僵尸|过滤/);

  const heavyNewcomerOnly = analyzeMainstreamPriceBand([
    { asin: 'B0SYNHVC01', parent_asin: 'P0SYNHVC01', title: 'Desk Tray Heavy Coupon', fulfillment: 'FBA', price_usd: 50.00, coupon: '30%', monthly_units: 70, age_days: 65 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(heavyNewcomerOnly.mature_regular_band?.p50_usd, 35.00);
  assert.doesNotMatch(heavyNewcomerOnly.mature_regular_band?.basis ?? '', /ex_heavy_coupon/);
  assert.equal(heavyNewcomerOnly.mature_regular_band?.conditional_post_coupon_observation, true);
  assert.equal(heavyNewcomerOnly.mature_regular_band?.heavy_coupon_excluded, false);
  assert.match(heavyNewcomerOnly.mature_regular_band?.label_zh ?? '', /有条件券后观察|未剔除/);

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
  const learningTower = evaluateGate0CategoryBoundary({ title: 'Toddler learning tower ages 2-4', age_group: 'adult' });
  assert.equal(learningTower.passed, false);
  assert.equal(learningTower.hard_exclusion, true);
  assert.equal(learningTower.verdict, 'excluded_childrens_product');
  assert.equal(learningTower.metadata_conflict, true);
  assert.equal(learningTower.statutory_review_required, true);

  const babyPlate = evaluateGate0CategoryBoundary({ title: 'Silicone Baby Plate with Suction Base', age_group: 'adult' });
  assert.equal(babyPlate.passed, false);
  assert.equal(babyPlate.metadata_conflict, true);

  const numericAgeConflict = evaluateGate0CategoryBoundary({ title: 'Wooden Kitchen Helper Stool', age_group: 'adult', max_target_age_years: 4 });
  assert.equal(numericAgeConflict.passed, false);
  assert.equal(numericAgeConflict.metadata_conflict, true);

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

    for (const opts of [
      { as_of_date: STAGE4_AS_OF_DATE, max_channels: 30 },
      { as_of_date: STAGE4_AS_OF_DATE, max_channels: 30, include_deferred: true },
      { as_of_date: STAGE4_AS_OF_DATE, task_slots: 30, enforce_80_20_mix: true },
      { as_of_date: STAGE4_AS_OF_DATE, task_slots: 30, enforce_80_20_mix: true, include_deferred: true },
    ]) {
      const plan = planDiscoveryBatch(store, opts);
      assert.equal(plan.recommended_channels.some(c => c.channel_id === 'ss_vine_sustained_traction'), false);
      assert.equal(plan.retired_channels.includes('ss_vine_sustained_traction'), true);
    }
  } finally {
    store.close();
  }
});

test('Batch A1 Round-1 Astra Regressions (Gate-0 & Keepa): caregiver/0-2 range, strict Keepa summary/gap/promo/age/scalar guards, upper-band anchor noise, and missing-price older peer', () => {
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Baby Monitor Crib Mount for Parents', age_group: 'adult' }).passed, true);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Diaper Bag for 1-2 years old supplies', age_group: 'adult' }).passed, true);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Diaper Bag for 0-2 years old supplies', age_group: 'adult' }).passed, true);
  const child02 = evaluateGate0CategoryBoundary({ title: 'Wooden Shape Sorter for Children 0-2 years old', age_group: 'adult' });
  assert.equal(child02.passed, false);
  assert.equal(child02.metadata_conflict, true);

  const store = openSelectionStore(':memory:');
  try {
    const formId = registerStage4Form(store, { formId: 'form-a1-r1-reason' });
    const lowSteady = makeSteadyPeer({ asin: 'B0SYNLOW25', priceUsd: 25.00, ageDays: 420 });
    const highLegacyBool = {
      asin: 'B0SYNHIG49', parent_asin: 'P0SYNHIG49', title: 'Desk Tray High Legacy',
      fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420, keepa_price_steady: true,
    };
    const g1aHold = runGate1AForForm(store, {
      form_id: formId, profile_revision: 59,
      price_band_analysis: { listings: [lowSteady, highLegacyBool], options: { as_of_date: STAGE4_AS_OF_DATE } },
      scenarios: [makeGate1AScenario({ asin: 'B0SYNLOW25', priceUsd: 25.00, ageDays: 420 })],
    });
    assert.equal(g1aHold.gate_status, 'gate1a_needs_verification');
    const directStrict = analyzeMainstreamPriceBand([lowSteady, highLegacyBool], {
      as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true,
    });
    assert.equal(directStrict.observed_out_of_band_peers.find(p => p.asin === 'B0SYNHIG49')?.reason_code, 'veteran_missing_keepa_steady_evidence');
    assert.equal(directStrict.spiral_watch.find(w => w.asin === 'B0SYNHIG49')?.watch_reasons.includes('legacy_keepa_steady_boolean_without_dated_curve'), true);
  } finally {
    store.close();
  }

  const undatedFactsPeer = {
    asin: 'B0SYNUNDF1', title: 'Undated Facts', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420,
    keepa_peer_facts: { has_timestamps: true, keepa_90d_steady: true },
  };
  assert.equal(analyzeMainstreamPriceBand([undatedFactsPeer], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true }).mature_regular_band, null);

  const staleParsed = parseSellerSpriteKeepaPayload(
    makeDatedKeepaReceipt({ asin: 'B0SYNSTAL1', startDate: '2026-01-01', days: 90, priceUsd: 49.00 }),
    { as_of_date: '2026-03-31' },
  );
  assert.equal(analyzeMainstreamPriceBand([{
    asin: 'B0SYNSTAL1', title: 'Stale Facts', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420,
    keepa_peer_facts: buildKeepaPeerFactsForMarketJudge(staleParsed),
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true }).mature_regular_band, null);

  const currentOtherParsed = parseSellerSpriteKeepaPayload(
    makeDatedKeepaReceipt({ asin: 'B0SYNOTHR1', startDate: '2026-08-30', days: 90, priceUsd: 49.00 }),
    { as_of_date: STAGE4_AS_OF_DATE },
  );
  assert.equal(analyzeMainstreamPriceBand([{
    asin: 'B0SYNWRNG1', title: 'Wrong ASIN Facts', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120, age_days: 420,
    keepa_peer_facts: buildKeepaPeerFactsForMarketJudge(currentOtherParsed),
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true }).mature_regular_band, null);

  const tinyShift = makeDatedKeepaReceipt({
    asin: 'B0SYNTMP01', startDate: '2026-08-30', days: 90,
    prices: [...Array(45).fill(49.00), ...Array(45).fill(48.99)],
  });
  const promoUnsteadyBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNTMP01', title: 'Promo Unsteady', fulfillment: 'FBA', price_usd: 48.99, monthly_units: 120, age_days: 420,
    temporary_event_promo: true, ai_reason_zh: '常规微调观察', keepa_trend: tinyShift.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(promoUnsteadyBand.mature_regular_band, null);
  const oobPromo = promoUnsteadyBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNTMP01');
  assert.match(oobPromo?.reason_zh ?? '', /常规微调观察/);
  assert.match(oobPromo?.reason_zh ?? '', /0\.01/);
  assert.match(oobPromo?.reason_zh ?? '', /2026-08-30/);

  const unagedFlatBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNUNAG1', title: 'Unaged Flat', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 120,
    keepa_trend: makeDatedKeepaReceipt({ asin: 'B0SYNUNAG1', startDate: '2026-08-30', days: 90, priceUsd: 49.00 }).keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(unagedFlatBand.mature_regular_band?.basis, 'unaged_keepa_90d_steady_reference');

  const heavyScalarBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYNHVSC1', title: 'Heavy Coupon Scalar', fulfillment: 'FBA', price_usd: 50.00, coupon: '30%',
    monthly_units: 90, age_days: 65, keepa_90d_median_usd: 50.00,
  }], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(heavyScalarBand.mature_regular_band?.p50_usd, 35.00);
  assert.equal(heavyScalarBand.mature_regular_band?.conditional_post_coupon_observation, true);
  assert.equal(heavyScalarBand.mature_regular_band?.heavy_coupon_excluded, false);
  assert.doesNotMatch(heavyScalarBand.mature_regular_band?.basis ?? '', /ex_heavy_coupon/);

  const normalPool = analyzeMainstreamPriceBand([
    makeSteadyPeer({ asin: 'B0SYNNRM01', parent_asin: 'P0SYNNRM01', priceUsd: 38.00, monthlyUnits: 180, ageDays: 420 }),
    makeSteadyPeer({ asin: 'B0SYNNRM02', parent_asin: 'P0SYNNRM02', priceUsd: 39.00, monthlyUnits: 180, ageDays: 450 }),
    makeSteadyPeer({ asin: 'B0SYNNRM03', parent_asin: 'P0SYNNRM03', priceUsd: 40.00, monthlyUnits: 10, ageDays: 480 }),
  ], { as_of_date: STAGE4_AS_OF_DATE, require_keepa_steady_evidence: true });
  assert.equal(normalPool.mature_regular_band?.p75_usd, 39.00);
  assert.equal(normalPool.mature_regular_band?.high_price_single_parent_anchor_warning, false);
  assert.equal(normalPool.guardrail.high_price_single_parent_anchor_warning, false);

  const twoEndpointParsed = parseSellerSpriteKeepaPayload({
    asin: 'B0SYNGAP01',
    keepa_trend: { ts: ['2026-08-30', '2026-11-27'], series: { price: [49.00, 49.00] } },
  }, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(twoEndpointParsed.keepa_90d_steady, false);
  assert.equal(twoEndpointParsed.regular_median_usd, null);

  const missingPriceOlder = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNW30A', parent_asin: 'P0SYNNW30A', title: 'Desk Tray New', fulfillment: 'FBA', price_usd: 49.00, monthly_units: 80, age_days: 30 },
    { asin: 'B0SYNMP600', parent_asin: 'P0SYNMP600', title: 'Desk Tray Missing Price Older', fulfillment: 'FBA', price_usd: null, monthly_units: 40, age_days: 600 },
  ], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(missingPriceOlder.all_under_90d_blue_ocean, false);
  assert.doesNotMatch(missingPriceOlder.top_amber_banner_zh ?? '', /全员 90 天内新品蓝海/);
  assert.equal(missingPriceOlder.excluded_older_peers?.some(p => p.asin === 'B0SYNMP600' && p.reason_code === 'excluded_invalid_price'), true);
});

test('Issue #28 (Gate-0 anti-false-kill & furniture default): adult/horticulture/musical/studio/pet/automotive phrases pass while real <=12y child items stay hard-excluded, and furniture is not default-blocked', () => {
  const adultFalseKillCases = [
    { title: 'Baby Grand Piano Cover Waterproof Velvet Dust Protector', root_category: 'Musical Instruments' },
    { title: 'Nursery Plant Pots 50 Pack 4 Inch Plastic Seedling Containers', root_category: 'Patio, Lawn & Garden' },
    { title: 'Plastic Plant Nursery Trays & Seedling Grow Bags with Drainage', root_category: 'Patio, Lawn & Garden' },
    { title: 'Tree Nursery Grafting Stakes & Plant Labels 200 Pack', root_category: 'Patio, Lawn & Garden' },
    { title: '5/8 Inch Baby Pin Studio Grip Wall Plate for Lighting Stand', root_category: 'Camera & Photo' },
    { title: 'Dog Booster Car Seat for Medium Pets with Safety Tether', root_category: 'Pet Supplies' },
    { title: 'Foldable Cat Stroller 4-Wheel Mesh Pet Carrier', root_category: 'Pet Supplies' },
    { title: 'Heavy Duty Puppy Playpen Outdoor Exercise Fence', root_category: 'Pet Supplies' },
    { title: "Baby's Breath Dried Flowers Bouquet for Vase Decor", root_category: 'Home & Kitchen' },
    { title: 'Leather Car Seat Cover Protector Set for Front Seats', root_category: 'Automotive' },
    { title: 'Car Seat Gap Filler Organizer with Cup Holder', root_category: 'Automotive' },
    { title: 'Waterproof Diaper Bag Backpack for Parents with Changing Pad', root_category: 'Baby Products' },
  ];
  for (const item of adultFalseKillCases) {
    const res = evaluateGate0CategoryBoundary(item);
    assert.equal(res.hard_exclusion, false);
    assert.equal(res.passed, true);
    assert.equal(res.adult_exemption_applied, true);
  }

  const realChildCases = [
    { title: 'Baby Grand Piano Toy for Toddlers Ages 1-3 with Lights' },
    { title: 'Nursery Plant Pot Kids Gardening Toy Set for Ages 3-6' },
    { title: 'Montessori Toddler Wooden Climbing Arch' },
    { title: 'Silicone Baby Teether Toy BPA Free' },
    { title: 'Baby Crib Mattress Dual Sided Waterproof' },
    { title: 'Infant Car Seat with Stay-in-Car Base' },
    { title: 'Toddler Booster Seat for Dining Table' },
    { title: 'Toddler Sippy Cup Spill Proof Straw' },
    { title: 'Baby Playpen for Infants and Toddlers' },
  ];
  for (const item of realChildCases) {
    const res = evaluateGate0CategoryBoundary(item);
    assert.equal(res.hard_exclusion, true);
    assert.equal(res.passed, false);
    assert.equal(res.verdict, 'excluded_childrens_product');
  }

  for (const furn of [
    { title: 'Solid Oak Standing Desk Frame', root_category: 'Office Furniture' },
    { title: '5-Tier Solid Wood Bookshelf', root_category: 'Furniture' },
    { title: 'Walnut Bedside Nightstand with Drawer', root_category: 'Home & Kitchen > Furniture' },
  ]) {
    const defRes = evaluateGate0CategoryBoundary(furn);
    assert.equal(defRes.passed, true);
    assert.equal(defRes.hard_exclusion, false);

    const optInRes = evaluateGate0CategoryBoundary(furn, { avoid_red_ocean: { red_ocean_furniture: true } });
    assert.equal(optInRes.passed, false);
    assert.equal(optInRes.hard_exclusion, false);
    assert.equal(optInRes.verdict, 'skipped_red_ocean_default');
  }

  const store = openSelectionStore(':memory:');
  try {
    const plan = planDiscoveryBatch(store, { as_of_date: '2026-11-26' });
    assert.equal(plan.gate0_defaults.avoid_red_ocean.red_ocean_furniture, false);
    assert.equal(plan.gate0_defaults.avoid_red_ocean.apparel, true);
    assert.equal(plan.gate0_defaults.avoid_red_ocean.consumer_electronics_3c, true);
  } finally {
    store.close();
  }

  const apparelRes = evaluateGate0CategoryBoundary({ title: 'Men Cotton T-Shirt Crew Neck', root_category: 'Clothing, Shoes & Jewelry' });
  assert.equal(apparelRes.passed, false);
  assert.equal(apparelRes.hard_exclusion, false);
  assert.equal(apparelRes.verdict, 'skipped_red_ocean_default');
  assert.equal(apparelRes.configurable_skip, true);

  const commodity3cRes = evaluateGate0CategoryBoundary({ title: 'MagSafe iPhone Case with USB-C Cable', root_category: 'Cell Phones & Accessories' });
  assert.equal(commodity3cRes.passed, false);
  assert.equal(commodity3cRes.hard_exclusion, false);
  assert.equal(commodity3cRes.verdict, 'skipped_red_ocean_default');
  assert.equal(commodity3cRes.configurable_skip, true);
});

test('Stage 3B Gate-0 audit hardening: bare-nursery & parent-marketing child traps, remaining adult exemptions, and counterexamples', () => {
  for (const childItem of [
    { title: 'Silicone Baby Plate with Suction Base' },
    { title: 'Baby Grand Piano Musical Toy, Ages 3 to 5' },
  ]) {
    const res = evaluateGate0CategoryBoundary(childItem);
    assert.equal(res.hard_exclusion, true);
    assert.equal(res.passed, false);
  }
  for (const adultItem of [
    { title: '5/8 Inch Baby Pins for Studio Lighting' },
    { title: 'Dog Car Booster Seat' },
  ]) {
    const res = evaluateGate0CategoryBoundary(adultItem);
    assert.equal(res.hard_exclusion, false);
    assert.equal(res.passed, true);
    assert.equal(res.adult_exemption_applied, true);
  }

  const childMustExclude = [
    'Nursery Mat Soft Foam Crawling Pad',
    'Nursery Supplies Starter Bundle',
    'Nursery Cups Set of 4',
    'Baby High Chair - Easy Clean Design for Parents',
    'Baby Walker with Wheels, Gift for New Parents',
    'Infant Bath Tub for Newborns, Designed for Moms',
    'Toddler Learning Tower Step Stool for Parents Kitchen Helper',
    'Newborn Swaddle Blanket Gift for Moms',
  ];
  for (const title of childMustExclude) {
    const res = evaluateGate0CategoryBoundary({ title });
    assert.equal(res.verdict, 'excluded_childrens_product', title);
    assert.equal(res.hard_exclusion, true);
    assert.equal(res.adult_exemption_applied, false);
  }

  const adultMustAllow = [
    '5/8-Inch Baby Pin Wall Plate for Studio Lighting',
    'Stainless Steel Baby Back Rib Rack for Smoker Grill',
    'Baby Lock Serger Dust Cover',
    'Nursery Grafting Tape 100ft',
    'Memory Foam Adult Car Booster Seat Cushion for Short Drivers',
    'Baby Monitor Floor Stand',
  ];
  for (const title of adultMustAllow) {
    const res = evaluateGate0CategoryBoundary({ title });
    assert.equal(res.passed, true, title);
    assert.equal(res.hard_exclusion, false);
    assert.equal(res.adult_exemption_applied, true);
  }
});

test('R3 closure (price-band & Gate 1A/factory cap): tied & 75/25 weightedQuantile, veteran Keepa supplement, stacked promos, unbound <=90d list price, nursery shelving Gate 0, and same-factory revision quota', async () => {
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

  const b75R59 = analyzeMainstreamPriceBand([
    { asin: 'B0Q75A0001', title: 'Bin', price_usd: 30, monthly_units: 75, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
    { asin: 'B0Q75A0002', title: 'Bin', price_usd: 60, monthly_units: 25, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
  ], { profile_revision: 59, as_of_date: '2026-11-24' });
  assert.equal(b75R59.band.p75_usd, 30);
  assert.throws(() => analyzeMainstreamPriceBand([], { profile_revision: 58 }), /retired/i);

  const pbVetNoKeepa = analyzeMainstreamPriceBand([
    { asin: 'B0VET00001', price_usd: 95, fulfillment: 'FBA', monthlySales: 50, age_days: 450 },
    { asin: 'B0VET00002', price_usd: 99, fulfillment: 'FBA', monthlySales: 50, age_days: 480 },
    { asin: 'B0GRW00001', price_usd: 43, fulfillment: 'FBA', monthlySales: 90, age_days: 180, keepa_price_steady: true },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });
  assert.equal(pbVetNoKeepa.band.p50_usd, 43);

  const pbStacked = analyzeMainstreamPriceBand([
    { asin: 'B0STK00001', price_usd: 49.99, ongoing_coupon_pct: 0.10, prime_discount_pct: 0.10, fulfillment: 'FBA', monthlySales: 100, age_days: 400, keepa_price_steady: true },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });
  assert.equal(pbStacked.mainstream_count, 1);
  assert.equal(pbStacked.observed_out_of_band_peers.length, 0, '10% coupon + 10% Prime stays in mainstream_pool rather than >=20% heavy-coupon isolation');

  assert.equal(evaluateGate0CategoryBoundary(
    { label: 'Adjustable nursery shelving for storing linens', buyer_task: 'Store bedding on a wall shelf' },
    { profile_revision: 59 },
  ).verdict, 'allowed');

  const store = openSelectionStore(':memory:');
  try {
    store.upsertCandidateForm({ form_id: 'form-fac-cap', label: 'Adult Storage Rack', buyer_task: 'Hold pantry jars', saleable_set_composition: { qty: 1 } });
    const pbMature = analyzeMainstreamPriceBand([
      { asin: 'B0FAC00001', price_usd: 42.99, fulfillment: 'FBA', monthlySales: 80, age_days: 400, keepa_trend: makeDatedKeepaReceipt({ asin: 'B0FAC00001', startDate: '2026-08-27', days: 90, priceUsd: 42.99 }).keepa_trend },
      { asin: 'B0FAC00002', price_usd: 44.99, fulfillment: 'FBA', monthlySales: 90, age_days: 420, keepa_trend: makeDatedKeepaReceipt({ asin: 'B0FAC00002', startDate: '2026-08-27', days: 90, priceUsd: 44.99 }).keepa_trend },
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
            ui_readback: DEFAULT_R59_UI_READBACK,
          },
        }),
      });
      assert.equal(rSame.checked_factory_quotes_count, 1);
      assert.equal(rSame.second_factory_quote_needed, true, '3 revisions from same factory_id still allow checking a 2nd factory');
    }

    const baseWin = {
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    const refTerms = { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 };
    const stdPkg = { length_in: 10, width_in: 6, height_in: 2, unit_weight_lb: 1.2 };
    store.upsertCandidateForm({ form_id: 'f-blue-list', label: 'Organizer', buyer_task: 'Store items', saleable_set_composition: { pcs: 1 } });
    const g1aBlue = runGate1AForForm(store, {
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

    store.upsertCandidateForm({ form_id: 'f-keepa-req', label: 'Organizer', buyer_task: 'Hold items', saleable_set_composition: { qty: 1 } });
    const g1aMissingVet = runGate1AForForm(store, {
      form_id: 'f-keepa-req',
      profile_revision: 59,
      price_band_analysis: {
        options: { as_of_date: '2026-11-24' },
        listings: [
          { asin: 'B0SYNKV001', age_days: 415, price_usd: 45, fulfillment: 'FBA', monthly_units: 60, title: 'Household organizer' },
          { asin: 'B0SYNKV002', age_days: 455, price_usd: 46, fulfillment: 'FBA', monthly_units: 55, title: 'Household organizer' },
        ],
      },
      scenarios: [{ id: 's1', asin: 'B0SYNKV001', age_days: 415, price_usd: 45, pkg: stdPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006 }],
    });
    assert.equal(g1aMissingVet.gate_status, 'gate1a_needs_verification');
    assert.equal(g1aMissingVet.proceed_to_gate1b, false);

    const g1aMissingGrowth = runGate1AForForm(store, {
      form_id: 'f-keepa-req',
      profile_revision: 59,
      price_band_analysis: {
        options: { as_of_date: '2026-11-24' },
        listings: [
          { asin: 'B0SYNKV001', age_days: 415, price_usd: 28, fulfillment: 'FBA', monthly_units: 60, title: 'Household organizer', keepa_price_steady: true },
          { asin: 'B0SYNKG002', age_days: 220, price_usd: 46, fulfillment: 'FBA', monthly_units: 55, title: 'Household organizer' },
        ],
      },
      scenarios: [{ id: 's2', asin: 'B0SYNKG002', age_days: 220, price_usd: 46, pkg: stdPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006 }],
    });
    assert.equal(g1aMissingGrowth.gate_status, 'gate1a_needs_verification');
    assert.equal(g1aMissingGrowth.proceed_to_gate1b, false);

    const savedBandNoKeepa = analyzeMainstreamPriceBand([
      { asin: 'B0SYNKV011', age_days: 415, price_usd: 45, fulfillment: 'FBA', monthly_units: 60, title: 'Household organizer' },
      { asin: 'B0SYNKV012', age_days: 455, price_usd: 46, fulfillment: 'FBA', monthly_units: 55, title: 'Household organizer' },
    ], { profile_revision: 59, as_of_date: '2026-11-24' });
    store.upsertCandidateForm({ form_id: 'f-saved-band', label: 'Two-piece organizer', buyer_task: 'Hold items', grade_or_material: 'steel', saleable_set_composition: { components: [{ component_id: 'box', qty_per_saleable_set: 1 }, { component_id: 'lid', qty_per_saleable_set: 1 }] } });
    const g1aFromSaved = runGate1AForForm(store, {
      form_id: 'f-saved-band', profile_revision: 59, price_band_analysis: savedBandNoKeepa,
      scenarios: [{ id: 's1', asin: 'B0SYNKV011', age_days: 415, price_usd: 45, pkg: stdPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006 }],
    });
    assert.equal(g1aFromSaved.gate_status, 'gate1a_needs_verification');
  } finally {
    store.close();
  }
});

test('Step 4 Sign-Off (#1, #3, #6, R2-A, R3 Keepa/Coupon): newcomer coupon smuggling block, standalone Keepa cutoff/steady/coupon, SP-API shipping denominator, and price range cliff', async () => {
  await withTempDirAsync('step4-pb-', async dir => {
    const extractExtraSyntheticAsins = cand => {
      const s = JSON.stringify(cand);
      return [...new Set([...s.matchAll(/\bB0[A-Z0-9]{8}\b/g)].map(m => m[0]).filter(a => a !== 'B0SYNNEW14'))];
    };

    // #1: 14-day newcomer ($40 list, $13.01 coupon -> $26.99 net) cannot smuggle $40 pre-coupon list price
    const rawReceiptPath = join(dir, 'ss-newcomer-coupon.json');
    writeFileSync(rawReceiptPath, JSON.stringify({
      code: 'OK',
      items: [{
        asin: 'B0SYNNEW14', availableDate: '2026-11-10', price: 40.00, list_price_usd: 40.00,
        coupon: '$13.01', monthlySales: 85, fulfillment: 'FBA', categoryId: '1055398',
      }],
    }, null, 2));
    const makeNew14Spec = (claimedPrice, withHonestCoupon = false) => {
      const cand = structuredClone(syntheticFixture.candidates[0]);
      cand.id = 'form-synth-new14';
      cand.newcomer_cohort = {
        observation_date: '2026-11-24', relevant_bsr_node: 'Home & Kitchen (1055398)',
        members: [], market_reference: { families: [] },
      };
      cand.screening.reference_price_usd = {
        value: claimedPrice, matched_spec: true, target_variant_asin: 'B0SYNNEW14', evidence: [cand.evidence[0].id],
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
        profile_revision: 59, as_of_date: '2026-11-24', raw_receipt_files: ['ss-newcomer-coupon.json'],
        candidates: [{ raw_receipt_files: ['ss-newcomer-coupon.json'], verified_asins: extractExtraSyntheticAsins(cand), candidate: cand }],
      };
    };
    assert.throws(() => ingestTrialSpecification(makeNew14Spec(40.00, false), r59Profile, { baseDir: dir }), /pre-coupon list price.*\$26\.99/i);
    const honestOut = ingestTrialSpecification(makeNew14Spec(26.99, true), r59Profile, { baseDir: dir });
    assert.equal(honestOut.scored.candidates[0].qualification.counts_toward_target, false);
    assert.equal(honestOut.scored.summary.qualifying, 0);

    // #3: standalone Keepa receipts merge by ASIN; undated stays unsteady while dated 90d flat passes
    const peer400d = {
      asin: 'B0SYNV400D', title: 'Synthetic Desktop Organizer', availableDate: '2025-09-01',
      price: 59.00, monthlySales: 120, fulfillment: 'FBA', pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 2.0 },
    };
    writeFileSync(join(dir, 'keepa-undated.json'), JSON.stringify({
      asin: 'B0SYNV400D', series: { price: [...Array(100).fill(59.00), ...Array(4).fill(49.00)] },
    }, null, 2));
    const pbUndatedIn = join(dir, 'pb-undated-in.json');
    writeFileSync(pbUndatedIn, JSON.stringify({ options: { as_of_date: '2026-11-24' }, raw_receipt_files: ['keepa-undated.json'], listings: [peer400d] }, null, 2));
    const pbUndatedRes = await runCliMem(['price-band', '--input', pbUndatedIn]);
    assert.equal(pbUndatedRes.code, 0, pbUndatedRes.stderr);
    assert.equal(JSON.parse(pbUndatedRes.stdout).analysis.mature_regular_band, null, 'Undated unsteady Keepa curve must not anchor mature_regular_band');

    const manualBand = analyzeMainstreamPriceBand([{ ...peer400d, keepa_90d_steady: false, keepa_90d_median_usd: 59.00 }], { as_of_date: '2026-11-24' });
    assert.equal(manualBand.mature_regular_band, null);

    const ts360 = Array.from({ length: 360 }, (_, i) => new Date(Date.UTC(2025, 11, 30 + i)).toISOString().slice(0, 10));
    writeFileSync(join(dir, 'keepa-dated360.json'), JSON.stringify({
      asin: 'B0SYNV400D', keepa_trend: { ts: ts360, series: { price: [...Array(270).fill(39.00), ...Array(90).fill(59.00)] } },
    }, null, 2));
    const dbPath = join(dir, 'g1a-keepa.sqlite');
    await runCliMem(['init', '--db', dbPath]);
    const g1aSpecPath = join(dir, 'g1a-keepa-spec.json');
    writeFileSync(g1aSpecPath, JSON.stringify({
      as_of_date: ts360[ts360.length - 1],
      form: { form_id: 'form-keepa-standalone', label: 'Keepa Standalone Peer Test', buyer_task: 'Organize desktop items', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] },
      peer_listings: [peer400d], raw_receipt_files: ['keepa-dated360.json'],
      scenarios: [{
        id: 'sc-59', target_variant_asin: 'B0SYNV400D', price_usd: 59.00, pkg: peer400d.pkg, fx_cny_per_usd: 7.20,
        refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        headhaul_usd: 2.10, collection_rate: 0.006,
      }],
    }, null, 2));
    const g1aDatedRes = await runCliMem(['gate1a', '--db', dbPath, '--input', g1aSpecPath]);
    assert.equal(g1aDatedRes.code, 0, g1aDatedRes.stderr);
    assert.equal(JSON.parse(g1aDatedRes.stdout).result.gate_status, 'gate1a_passed');

    // #6: SP-API ListingPrice $36 + Shipping $4 = $40, ReferralFee $6 -> 15%
    const spCal = extractSpApiFinalistCalibration({
      asin: 'B0SYNSHIP4', price_usd: 40.00,
      feesEstimateRaw: {
        FeesEstimateResult: {
          Status: 'Success',
          FeesEstimateIdentifier: { MarketplaceId: 'ATVPDKIKX0DER', IdType: 'ASIN', IdValue: 'B0SYNSHIP4', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 36.00 }, Shipping: { CurrencyCode: 'USD', Amount: 4.00 } } },
          FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 12.15 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { CurrencyCode: 'USD', Amount: 6.00 } }, { FeeType: 'FBAFees', FinalFee: { CurrencyCode: 'USD', Amount: 6.15 } }] },
        },
      },
    });
    assert.equal(spCal.fee_calibration_status, 'verified');
    assert.equal(spCal.fee_calibration.listing_price_usd, 36.00);
    assert.equal(spCal.fee_calibration.shipping_usd, 4.00);
    assert.equal(spCal.fee_calibration.total_price_usd, 40.00);
    assert.equal(spCal.fee_calibration.referral_fraction, 0.15);

    // R2-A: undated Buy Box $40 cannot resurrect $26.99 newcomer coupon price; $29.98 != $29.99; Keepa cutoff & continuous 50% coupon
    writeFileSync(join(dir, 'ss-new14.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYNNEW14', price: 40.00, coupon: '$13.01', availableDate: '2026-11-10', monthlySales: 180 }] }), 'utf8');
    writeFileSync(join(dir, 'undated-bb40.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYNNEW14', buyboxPrice: 40.00, series: { buybox: [40.00] }, Summary: { BuyBoxPrices: [{ ListingPrice: { Amount: 40.00 } }] } }] }), 'utf8');
    const candSmuggle40 = structuredClone(syntheticFixture.candidates[0]);
    candSmuggle40.id = 'cand-r2-new14-bb40';
    candSmuggle40.screening.reference_price_usd = { value: 40.00, matched_spec: true, target_variant_asin: 'B0SYNNEW14', observed_at: '2026-11-24' };
    candSmuggle40.economics.scenarios = [candSmuggle40.economics.scenarios[0]];
    candSmuggle40.economics.scenarios[0].price_anchor = { value: 40.00, target_variant_asin: 'B0SYNNEW14' };
    candSmuggle40.economics.scenarios[0].cost_ledger.price_usd = 40.00;
    candSmuggle40.economics.expected_primary_scenarios = [{ id: candSmuggle40.economics.scenarios[0].id, status: 'active' }];
    assert.throws(
      () => ingestTrialSpecification({ profile_revision: 59, as_of_date: '2026-11-24', raw_receipt_files: ['ss-new14.json', 'undated-bb40.json'], candidates: [{ candidate: candSmuggle40, raw_receipt_files: ['ss-new14.json', 'undated-bb40.json'] }] }, r59Profile, { baseDir: dir }),
      /pre-coupon list price|price-binding violation/i,
    );

    writeFileSync(join(dir, 'raw-2998.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYN2998A', price: 29.98, availableDate: '2024-06-01', monthlySales: 120 }] }), 'utf8');
    const cand2999 = structuredClone(candSmuggle40);
    cand2999.id = 'cand-r2-2998-to-2999';
    cand2999.screening.reference_price_usd = { value: 29.99, matched_spec: true, target_variant_asin: 'B0SYN2998A', observed_at: '2026-11-24' };
    cand2999.economics.scenarios[0].price_anchor = { value: 29.99, target_variant_asin: 'B0SYN2998A' };
    cand2999.economics.scenarios[0].cost_ledger.price_usd = 29.99;
    assert.throws(
      () => ingestTrialSpecification({ profile_revision: 59, as_of_date: '2026-11-24', raw_receipt_files: ['raw-2998.json'], candidates: [{ candidate: cand2999, raw_receipt_files: ['raw-2998.json'] }] }, r59Profile, { baseDir: dir }),
      /do not match|price-binding violation/i,
    );

    const tsJanJun = Array.from({ length: 180 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
    const parsedCutoff = parseSellerSpriteKeepaPayload({ asin: 'B0SYNCUT01', keepa_trend: { ts: tsJanJun, series: { price: tsJanJun.map(d => (d <= '2026-03-31' ? 39.00 : 59.00)) } } }, { as_of_date: '2026-03-31', age_days: 500 });
    assert.equal(parsedCutoff.keepa_90d_median_usd, 39.00);
    assert.equal(parsedCutoff.window_90d.through, '2026-03-31');
    assert.equal(parsedCutoff.keepa_90d_steady, true);

    const mergedPkgOnlyPeers = mergeKeepaPayloadsIntoPeerListings(
      [{ asin: 'B0SYNVETPK', price: 59.00, fulfillment: 'FBA', monthly_units: 100, available_date: '2025-09-01' }],
      [{ asin: 'B0SYNVETPK', pkgDimensionsSize: '12 x 8 x 4 in', pkgWeightGram: 680 }],
      { as_of_date: '2026-11-24' },
    );
    const bandPkgOnly = analyzeMainstreamPriceBand(mergedPkgOnlyPeers, { as_of_date: '2026-11-24' });
    assert.equal(bandPkgOnly.mainstream_pool.length, 0);
    assert.ok(bandPkgOnly.observed_out_of_band_peers.some(p => p.asin === 'B0SYNVETPK' && p.reason_code === 'veteran_missing_keepa_steady_evidence'));

    const ts90 = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10));
    const parsed89_1 = parseSellerSpriteKeepaPayload({ asin: 'B0SYNDIP40', keepa_trend: { ts: ts90, series: { price: [...Array(89).fill(50.00), 40.00], couponHistory: Array(90).fill(null) } } }, { age_days: 450 });
    assert.equal(parsed89_1.sustained_drop_or_clearance_watch, false);
    assert.equal(parsed89_1.keepa_90d_steady, false);

    const keepaHeavy50 = { asin: 'B0SYNHVY50', keepa_trend: { ts: ts90, series: { price: Array(90).fill(59.00), couponHistory: Array(90).fill('50%') } } };
    const parsedHeavy50 = parseSellerSpriteKeepaPayload(keepaHeavy50, { age_days: 450 });
    assert.equal(parsedHeavy50.continuous_heavy_coupon_90d, true);
    assert.equal(parsedHeavy50.keepa_90d_steady, false);
    assert.equal(parsedHeavy50.keepa_90d_median_usd, null);
    assert.equal(parsedHeavy50.realized_net_90d_median_usd, 29.50);
    const mergedHeavy50Peers = mergeKeepaPayloadsIntoPeerListings([{ asin: 'B0SYNHVY50', price: 59.00, fulfillment: 'FBA', monthly_units: 120, available_date: '2025-06-01' }], [keepaHeavy50], { as_of_date: '2026-10-29' });
    const bandHeavy50 = analyzeMainstreamPriceBand(mergedHeavy50Peers, { as_of_date: '2026-10-29' });
    assert.equal(bandHeavy50.mainstream_pool.length, 0);
    assert.equal(mergedHeavy50Peers[0].ongoing_coupon_pct, 0.5);

    // R3 Final Closure Keepa/coupon/range cliff
    writeFileSync(join(dir, 'r3-ss-new.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYNR3N14', price: 40.00, coupon: '$13.01', availableDate: '2026-11-10', monthlySales: 150 }] }), 'utf8');
    writeFileSync(join(dir, 'r3-bb-null-coupon.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYNR3N14', buyboxPrice: 40.00, coupon: null, ongoing_coupon_usd: null, ongoing_coupon_pct: null }] }), 'utf8');
    const candNullCpn = structuredClone(syntheticFixture.candidates[0]);
    candNullCpn.id = 'cand-r3-null-cpn';
    candNullCpn.screening.reference_price_usd = { value: 40.00, matched_spec: true, target_variant_asin: 'B0SYNR3N14', observed_at: '2026-11-24' };
    candNullCpn.economics.scenarios = [candNullCpn.economics.scenarios[0]];
    candNullCpn.economics.scenarios[0].price_anchor = { value: 40.00, target_variant_asin: 'B0SYNR3N14' };
    candNullCpn.economics.scenarios[0].cost_ledger.price_usd = 40.00;
    candNullCpn.economics.expected_primary_scenarios = [{ id: candNullCpn.economics.scenarios[0].id, status: 'active' }];
    assert.throws(
      () => ingestTrialSpecification({ profile_revision: 59, as_of_date: '2026-11-24', raw_receipt_files: ['r3-ss-new.json', 'r3-bb-null-coupon.json'], candidates: [{ candidate: candNullCpn, raw_receipt_files: ['r3-ss-new.json', 'r3-bb-null-coupon.json'] }] }, r59Profile, { baseDir: dir }),
      /pre-coupon list price|price-binding violation/i,
    );

    writeFileSync(join(dir, 'r3-5001.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYNR3P40', price: 40.00, availableDate: '2024-01-01', monthlySales: 100 }, { asin: 'B0SYNR3P51', price: 50.01, availableDate: '2024-01-01', monthlySales: 100 }] }), 'utf8');
    const candRange50 = structuredClone(candNullCpn);
    candRange50.id = 'cand-r3-range50';
    candRange50.screening.reference_price_usd = { value: 40.00, supported_price_range: [40.00, 50.00], matched_spec: true, target_variant_asin: 'B0SYNR3P40', allow_unobserved_derived_price: true, observed_at: '2026-11-24' };
    candRange50.economics.scenarios[0].price_anchor = { value: 50.01, target_variant_asin: 'B0SYNR3P51' };
    candRange50.economics.scenarios[0].cost_ledger.price_usd = 50.01;
    assert.throws(
      () => ingestTrialSpecification({ profile_revision: 59, as_of_date: '2026-11-24', raw_receipt_files: ['r3-5001.json'], candidates: [{ candidate: candRange50, raw_receipt_files: ['r3-5001.json'] }] }, r59Profile, { baseDir: dir }),
      /supported_price_range/,
    );

    writeFileSync(join(dir, 'r3-keepa-janjun.json'), JSON.stringify({ code: 'OK', asin: 'B0SYNR3CUT', keepa_trend: { ts: tsJanJun, series: { price: tsJanJun.map(d => (d <= '2026-03-31' ? 39.00 : 59.00)) } } }), 'utf8');
    const candApr59 = structuredClone(candNullCpn);
    candApr59.id = 'cand-r3-apr59';
    candApr59.evidence = [{ id: 'synthetic-evidence', source: 'synth', observed_at: '2026-03-31' }];
    candApr59.newcomer_cohort.observation_date = '2026-03-31';
    candApr59.screening.reference_price_usd = { value: 59.00, matched_spec: true, target_variant_asin: 'B0SYNR3CUT', observed_at: '2026-03-31' };
    candApr59.economics.scenarios[0].price_anchor = { value: 59.00, target_variant_asin: 'B0SYNR3CUT' };
    candApr59.economics.scenarios[0].cost_ledger.price_usd = 59.00;
    assert.throws(
      () => ingestTrialSpecification({ profile_revision: 59, as_of_date: '2026-03-31', raw_receipt_files: ['r3-keepa-janjun.json'], candidates: [{ candidate: candApr59, raw_receipt_files: ['r3-keepa-janjun.json'] }] }, r59Profile, { baseDir: dir }),
      /do not match|price-binding violation/i,
    );

    const parsed2Day = parseSellerSpriteKeepaPayload({ asin: 'B0SYNR32DY', keepa_trend: { ts: ['2026-03-30', '2026-03-31'], series: { price: [59.00, 59.00] } } }, { age_days: 450 });
    assert.equal(parsed2Day.keepa_90d_steady, false);
    assert.equal(parsed2Day.keepa_90d_median_usd, null);

    writeFileSync(join(dir, 'r3-keepa-hvy50.json'), JSON.stringify({ code: 'OK', asin: 'B0SYNR3H50', availableDate: '2025-01-01', keepa_trend: { ts: ts90, series: { price: Array(90).fill(59.00), couponHistory: Array(90).fill('50%') } } }), 'utf8');
    writeFileSync(join(dir, 'r3-snap59.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B0SYNR3H50', price: 59.00, coupon: null }] }), 'utf8');
    const candHvy59 = structuredClone(candNullCpn);
    candHvy59.id = 'cand-r3-hvy59';
    candHvy59.screening.reference_price_usd = { value: 59.00, matched_spec: true, target_variant_asin: 'B0SYNR3H50', observed_at: '2026-10-29' };
    candHvy59.economics.scenarios[0].price_anchor = { value: 59.00, target_variant_asin: 'B0SYNR3H50' };
    candHvy59.economics.scenarios[0].cost_ledger.price_usd = 59.00;
    assert.throws(
      () => ingestTrialSpecification({ profile_revision: 59, as_of_date: '2026-10-29', raw_receipt_files: ['r3-keepa-hvy50.json', 'r3-snap59.json'], candidates: [{ candidate: candHvy59, raw_receipt_files: ['r3-keepa-hvy50.json', 'r3-snap59.json'] }] }, r59Profile, { baseDir: dir }),
      /pre-coupon list price|price-binding violation/i,
    );

    const parsedBare50Usd = parseSellerSpriteKeepaPayload({ asin: 'B0SYNBARE5', keepa_trend: { ts: ts90, series: { price: Array(90).fill(59.00), couponHistory: Array(90).fill(50) } } }, { age_days: 400 });
    assert.equal(parsedBare50Usd.realized_net_90d_median_usd, 9.00);
  });
});

test('SP-API read-only finalist calibration overrides stale SellerSprite cache, separates brand vs category gating, and runs via CLI & SQLite store', async () => {
  await withTempDirAsync('r59-spapi-cal-', async dir => {
    const specInput = {
      price_usd: 59.99,
      target_is_own_white_label: true,
      catalogItemRaw: {
        asin: 'B0SYNTH888',
        dimensions: [{
          package: {
            length: { value: 20.0, unit: 'inches' },
            width: { value: 10.0, unit: 'inches' },
            height: { value: 6.0, unit: 'inches' },
            weight: { value: 12.2, unit: 'pounds' },
          },
        }],
      },
      feesEstimateRaw: {
        FeesEstimateResult: {
          FeesEstimateIdentifier: {
            IdValue: 'B0SYNTH888',
            PriceToEstimateFees: { ListingPrice: { Amount: 59.99, CurrencyCode: 'USD' } },
          },
          FeesEstimate: {
            TotalFeesEstimate: { Amount: 24.29, CurrencyCode: 'USD' },
            FeeDetailList: [
              { FeeType: 'ReferralFee', FinalFee: { Amount: 9.00, CurrencyCode: 'USD' } },
              { FeeType: 'FBAFees', FinalFee: { Amount: 15.29, CurrencyCode: 'USD' } },
            ],
          },
        },
      },
      restrictionsRaw: {
        restrictions: [{
          reasons: [{ message: 'You need approval to list in this brand.' }],
        }],
      },
      sellerSpriteCachedRow: {
        length_in: 20.0,
        width_in: 10.0,
        height_in: 6.0,
        unit_weight_lb: 33.5,
      },
    };

    const cal = extractSpApiFinalistCalibration(specInput);
    assert.equal(cal.asin, 'B0SYNTH888');
    assert.equal(cal.official_pkg.unit_weight_lb, 12.2);
    assert.equal(cal.fee_calibration.referral_fraction, 0.150025);
    assert.equal(cal.restrictions.hard_category_ban, false);
    assert.equal(cal.restrictions.has_competitor_brand_gate, true);
    assert.equal(cal.stale_sellersprite_audit.stale_sellersprite_cache_corrected, true);
    assert.ok(cal.stale_sellersprite_audit.fba_2027_delta_usd < -8.0, 'SP-API official 12.2 lb saves >$8 vs stale 33.5 lb SellerSprite cache');

    const bannedCal = extractSpApiFinalistCalibration({
      restrictionsRaw: { restrictions: [{ reasons: [{ message: 'This product is prohibited and not permitted for sale.' }] }] },
    });
    assert.equal(bannedCal.restrictions.hard_category_ban, true);

    const inPath = join(dir, 'sp-in.json');
    const outPath = join(dir, 'sp-out.json');
    writeFileSync(inPath, JSON.stringify(specInput, null, 2), 'utf8');
    const cliRes = await runCliMem(['sp-api-calibrate', '--input', inPath, '--output', outPath]);
    assert.equal(cliRes.code, 0, cliRes.stderr);
    const saved = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(saved.calibration.official_pkg.unit_weight_lb, 12.2);

    const store = openSelectionStore(':memory:');
    try {
      const res = store.reserveRequestAttempt({
        account_scope: 'test-sp-api',
        provider: 'sp_api',
        tool_name: 'catalogItems_getCatalogItem',
        observation_cutoff_date: '2026-11-24',
        params: { asin: 'B0SYNTH888', marketplaceIds: ['ATVPDKIKX0DER'] },
      });
      store.markAttemptInFlight(res.attempt_id);
      store.completeAttempt(res.attempt_id, {
        payload: { asin: 'B0SYNTH888', unit_weight_lb: 12.2 },
      });
      assert.equal(store.getAttempt(res.attempt_id)?.status, 'succeeded' === store.getAttempt(res.attempt_id)?.status ? 'succeeded' : 'completed');
    } finally {
      store.close();
    }
  });
});

test('3-tier age priority, qualitative Keepa clearance, >=20% heavy coupon, <10 zombie denoising, blue-ocean band, Gate-0 exemptions, and star/Q31 refs', () => {
  assert.equal(detectKeepaVeteranClearanceOrWar({ keepa_clearance: true }), true);
  assert.equal(detectKeepaVeteranClearanceOrWar({ keepa_90d_prices: [59.99, 48.00, 36.00, 27.99] }), false);

  const dated1124 = (asin, priceUsd) => makeDatedKeepaReceipt({ asin, startDate: '2026-08-27', days: 90, priceUsd }).keepa_trend;
  const pb = analyzeMainstreamPriceBand([
    { asin: 'B0SYN100D1', price_usd: 50.00, coupon: '18%', fulfillment: 'FBA', monthlySales: 120, age_days: 150, keepa_90d_median_usd: 50.00, keepa_trend: dated1124('B0SYN100D1', 50.00) },
    { asin: 'B0SYNVET2Y', price_usd: 60.00, coupon: '25%', fulfillment: 'FBA', monthlySales: 140, age_days: 400, keepa_90d_median_usd: 60.00, keepa_trend: dated1124('B0SYNVET2Y', 60.00) },
    { asin: 'B0SYNVETWR', price_usd: 26.99, fulfillment: 'FBA', monthlySales: 300, age_days: 450, keepa_clearance: true, keepa_clearance_reason_zh: '全年稳态 $58 近期清仓跳水至 $26.99' },
    { asin: 'B0SYNYNG60', price_usd: 29.99, fulfillment: 'FBA', monthlySales: 90, age_days: 60 },
    { asin: 'B0SYNZMB05', price_usd: 19.99, fulfillment: 'FBA', monthlySales: 6, age_days: 420 },
    { asin: 'B0SYNHIGH3', price_usd: 68.00, fulfillment: 'FBA', monthlySales: 110, age_days: 240, keepa_90d_median_usd: 68.00, keepa_trend: dated1124('B0SYNHIGH3', 68.00) },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });

  assert.equal(pb.mature_regular_band.newcomer_cutoff_days, 90);
  assert.equal(pb.mature_regular_band.veteran_cutoff_days, 365);
  assert.equal(pb.mature_regular_band.basis, 'veteran_ge_365d_plus_steady_growth_91_364d_supplement');
  assert.equal(pb.mature_regular_band.growth_supplement_used, true);
  assert.equal(pb.mature_regular_band.peer_count, 3, 'Includes 400d veteran ($60) + 2 steady growth supplements (150d $41, 240d $68)');
  assert.equal(pb.mature_regular_band.min_usd, 41.00);
  assert.equal(pb.mature_regular_band.max_usd, 68.00);
  assert.equal(pb.veteran_clearance_watch.length, 1);
  assert.equal(pb.veteran_clearance_watch[0].asin, 'B0SYNVETWR');
  assert.equal(pb.newcomer_launch_band.label_zh, '新品起盘参考价（≤90天）');
  assert.equal(pb.newcomer_launch_band.peer_count, 1);
  assert.equal(pb.newcomer_launch_band.p50_usd, 29.99);
  assert.equal(pb.observed_out_of_band_peers.some(p => p.asin === 'B0SYNVETWR'), true);
  assert.equal(pb.observed_out_of_band_peers.some(p => p.asin === 'B0SYNYNG60'), true);
  assert.equal(pb.observed_out_of_band_peers.some(p => p.asin === 'B0SYNZMB05'), true);
  assert.equal(pb.guardrail.width_alarm, true);
  assert.equal(pb.guardrail.never_triggers_elimination, true);

  const pbVetPriority = analyzeMainstreamPriceBand([
    { asin: 'B0SYNVETA1', parent_asin: 'P0SYNVETAA', price_usd: 48.00, fulfillment: 'FBA', monthlySales: 200, age_days: 420, keepa_trend: dated1124('B0SYNVETA1', 48.00) },
    { asin: 'B0SYNVETA2', parent_asin: 'P0SYNVETAA', price_usd: 48.00, fulfillment: 'FBA', monthlySales: 200, age_days: 420, keepa_trend: dated1124('B0SYNVETA2', 48.00) },
    { asin: 'B0SYNVETB1', parent_asin: 'P0SYNVETBB', price_usd: 56.00, fulfillment: 'FBA', monthlySales: 180, age_days: 510, keepa_trend: dated1124('B0SYNVETB1', 56.00) },
    { asin: 'B0SYNGRW18', parent_asin: 'P0SYNGRW18', price_usd: 34.99, fulfillment: 'FBA', monthlySales: 150, age_days: 180, keepa_trend: dated1124('B0SYNGRW18', 34.99) },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });
  assert.equal(pbVetPriority.mature_regular_band.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(pbVetPriority.mature_regular_band.peer_count, 2, 'Deduplicated parent P0SYNVETAA + P0SYNVETBB = 2 veterans');
  assert.equal(pbVetPriority.mature_regular_band.growth_supplement_used, false);
  assert.equal(pbVetPriority.mature_regular_band.min_usd, 48.00);
  assert.equal(pbVetPriority.observed_out_of_band_peers.some(p => p.asin === 'B0SYNGRW18'), true);

  const pbBlueOcean = analyzeMainstreamPriceBand([
    { asin: 'B0SYNNEW01', price_usd: 42.99, coupon: '10%', fulfillment: 'FBA', monthlySales: 160, age_days: 35 },
    { asin: 'B0SYNNEW02', price_usd: 59.99, coupon: '25%', fulfillment: 'FBA', monthlySales: 120, age_days: 55 },
  ], { as_of_date: '2026-11-24', strict_mature_only: true });
  assert.equal(pbBlueOcean.mature_regular_band.all_under_90d_blue_ocean, true);
  assert.equal(pbBlueOcean.mature_regular_band.top_amber_banner_zh, '全员 90 天内新品蓝海，暂无一年期老品稳态价');
  assert.equal(pbBlueOcean.mature_regular_band.peer_count, 1);
  assert.equal(pbBlueOcean.mature_regular_band.min_usd, 38.69);
  assert.equal(pbBlueOcean.mature_regular_band.max_usd, 38.69);

  const stGate = openSelectionStore(':memory:');
  try {
    stGate.upsertCandidateForm({ form_id: 'form-blue-ocean', label: 'Adult Acrylic Stand', buyer_task: 'Hold vinyl records', saleable_set_composition: { qty: 1 } });
    const g1aBlue = runGate1AForForm(stGate, {
      form_id: 'form-blue-ocean',
      price_band_analysis: pbBlueOcean,
      scenarios: [{
        id: 'sc-blue',
        price_usd: 42.99,
        ongoing_coupon_pct: 0.10,
        pkg: { length_in: 12, width_in: 9, height_in: 3, weight_lb: 1.8 },
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.5,
        collection_rate: 0.006,
      }],
    });
    assert.equal(g1aBlue.proceed_to_gate1b, true);
  } finally {
    stGate.close();
  }

  assert.equal(evaluateGate0CategoryBoundary({ title: 'Baby Blue Anodized Aluminum Router Jig - Keep away from kids, NOT for children' }).hard_exclusion, false);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Montessori Toddler Wooden Climbing Arch for Kids Ages 3-8' }).hard_exclusion, true);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Heavy Canvas Workshop Apron', root_category: 'Clothing, Shoes & Jewelry' }).hard_exclusion, false);

  const starRef = extractNicheAverageStarReference([
    { asin: 'B0SYNSTAR1', parent_asin: 'P0STAR1', rating: 4.4, monthlySales: 100 },
    { asin: 'B0SYNSTAR2', parent_asin: 'P0STAR2', rating: 4.6, monthlySales: 200 },
  ]);
  assert.equal(starRef.value, 4.5);

  const kwCounts = extractQ31DualSourceKeywordCounts({
    sellerspriteRaw: { organic: 52, ad: 16 },
    sifRaw: { organic: 31, ad: 11 },
  });
  assert.deepEqual(kwCounts, {
    sellersprite: { organic: 52, ad: 16 },
    sif: { organic: 31, ad: 11 },
  });
});

test('Astra audit price-band, SP-API calibration, MarketObservationJudge wiring, Gate-0 exemptions, and connector guards', async () => {
  const multiFeeCal = extractSpApiFinalistCalibration({
    asin: 'B0SYNTARG2',
    price_usd: 45.00,
    feesEstimateRaw: {
      payload: {
        FeesEstimateResultList: [
          {
            Status: 'Success',
            FeesEstimateIdentifier: { IdValue: 'B0SYNWRNG1', MarketplaceId: 'ATVPDKIKX0DER', PriceToEstimateFees: { ListingPrice: { Amount: 45.00, CurrencyCode: 'USD' } } },
            FeesEstimate: { TotalFeesEstimate: { Amount: 9.10 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 3.60 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.50 } }] },
          },
          {
            Status: 'Success',
            FeesEstimateIdentifier: { IdValue: 'B0SYNTARG2', MarketplaceId: 'ATVPDKIKX0DER', PriceToEstimateFees: { ListingPrice: { Amount: 45.00, CurrencyCode: 'USD' } } },
            FeesEstimate: { TotalFeesEstimate: { Amount: 12.25 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 6.75 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.50 } }] },
          },
        ],
      },
    },
  });
  assert.equal(multiFeeCal.fee_calibration.referral_fraction, 0.15, 'Matches B0SYNTARG2 (15%) instead of taking [0] (8%)');

  assert.throws(
    () => extractSpApiFinalistCalibration({ restrictionsRaw: { errors: [{ code: 'QuotaExceeded', message: 'Rate exceeded' }] } }),
    /upstream error/i,
    'Plural SP-API errors[] must throw instead of reporting 0 restrictions',
  );

  const spIngestCand = structuredClone(syntheticFixture.candidates[0]);
  spIngestCand.id = 'cand-sp-heavy-box';
  spIngestCand.screening.reference_price_usd = {
    value: 40,
    unit: 'USD',
    matched_spec: true,
    target_variant_asin: 'B0SYNHVY30',
    fulfillment_channel: 'FBA',
    sales_history_supported: true,
    evidence: ['synthetic-evidence'],
  };
  const spIngested = ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    evidence: syntheticFixture.evidence,
    candidates: [{
      candidate: spIngestCand,
      sp_api_calibration_inputs: {
        asin: 'B0SYNHVY30',
        price_usd: 40,
        sellerSpriteCachedRow: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
        catalogItemRaw: {
          asin: 'B0SYNHVY30',
          dimensions: [{ marketplaceId: 'ATVPDKIKX0DER', package: { length: { value: 24, unit: 'inches' }, width: { value: 18, unit: 'inches' }, height: { value: 12, unit: 'inches' }, weight: { value: 30, unit: 'pounds' } } }],
        },
      },
    }],
  }, r59Profile);
  const scoredHeavy = scoreCandidate(spIngested.batch.candidates[0], r59Profile);
  assert.equal(scoredHeavy.screening.status, 'excluded', 'Official 30 lb Bulky SP-API box overrides stale 1.2 lb cache and drops margin < 30%');

  const pbUnsteadyVet = analyzeMainstreamPriceBand([
    { asin: 'B0SYNVETU1', title: 'Unsteady Vet 1', price_usd: 35.99, monthly_units: 80, fulfillment: 'FBA', age_days: 500, keepa_price_steady: false },
    { asin: 'B0SYNVETU2', title: 'Unsteady Vet 2', price_usd: 36.99, monthly_units: 70, fulfillment: 'FBA', age_days: 480, keepa_price_steady: false },
    { asin: 'B0SYNGRW01', title: 'Steady Growth 1', price_usd: 42.99, monthly_units: 150, fulfillment: 'FBA', age_days: 180, keepa_price_steady: true },
    { asin: 'B0SYNGRW02', title: 'Steady Growth 2', price_usd: 44.99, monthly_units: 140, fulfillment: 'FBA', age_days: 200, keepa_price_steady: true },
  ], { profile_revision: 59 });
  assert.equal(pbUnsteadyVet.growth_supplement_used, true);
  assert.equal(pbUnsteadyVet.mainstream_count, 2);

  const pbFbmSibling = analyzeMainstreamPriceBand([
    { asin: 'B0SYNFBM99', parent_asin: 'B0SYNPAR99', title: 'FBM Sibling', price_usd: 32.99, monthly_units: 500, fulfillment: 'FBM', age_days: 400 },
    { asin: 'B0SYNFBA99', parent_asin: 'B0SYNPAR99', title: 'FBA Sibling', price_usd: 42.99, monthly_units: 150, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
    { asin: 'B0SYNFBA98', parent_asin: 'B0SYNPAR98', title: 'FBA Peer 2', price_usd: 44.99, monthly_units: 120, fulfillment: 'FBA', age_days: 410, keepa_price_steady: true },
  ], { profile_revision: 59 });
  assert.equal(pbFbmSibling.mainstream_count, 2);

  const pbClearancePlusYoung = analyzeMainstreamPriceBand([
    { asin: 'B0SYNCLR01', title: '450d Clearance', price_usd: 22.99, keepa_90d_median_usd: 45.99, monthly_units: 90, fulfillment: 'FBA', age_days: 450, veteran_clearance_or_war: true },
    { asin: 'B0SYNYNG01', title: 'Newcomer 1', price_usd: 39.99, monthly_units: 80, fulfillment: 'FBA', age_days: 40 },
  ], { profile_revision: 59 });
  assert.equal(pbClearancePlusYoung.all_under_90d_blue_ocean, false);

  const rawMktInput = {
    form_id: 'form-h9-check',
    peers: [{ asin: 'B0SYNMKT01', price_usd: 29.98, keepa_high_usd: null, keepa_low_usd: null, review_count: 25 }],
  };
  assert.throws(
    () => parseMarketObservationResult({
      schema_version: 1,
      contract: 'MarketObservationJudge',
      form_id: 'form-h9-check',
      peer_observations: [{
        asin: 'B0SYNMKT01',
        mandatory_facts: {
          observed_price_usd: 29.99,
          keepa_high_usd: null,
          keepa_low_usd: null,
          review_count: 25,
          keepa_90d_trend: 'No Keepa history',
          coupon_status: 'none',
          review_curve_change: 'Steady',
          key_appearance_and_dims: '10x8x3 in',
        },
        qualitative_judgment: {
          bucket: 'primary_comparable',
          include_in_primary_band: true,
          keep_in_observation_bar: false,
          reason_zh: '篡改一美分测试。',
        },
      }],
      market_summary_zh: '市场观察汇总测试。',
    }, rawMktInput),
    /observed_price_usd/i,
  );
  const parsedJudgeForBand = parseMarketObservationResult({
    schema_version: 1,
    contract: 'MarketObservationJudge',
    form_id: 'form-h9-wire',
    peer_observations: [{
      asin: 'B0SYNWIR01',
      mandatory_facts: {
        observed_price_usd: 31.99,
        keepa_high_usd: 49.99,
        keepa_low_usd: 31.99,
        review_count: 88,
        keepa_90d_trend: 'Clearance drop',
        coupon_status: 'none',
        review_curve_change: 'Flat',
        key_appearance_and_dims: '12x8x3 in',
      },
      qualitative_judgment: {
        bucket: 'veteran_clearance_or_war',
        include_in_primary_band: false,
        keep_in_observation_bar: true,
        reason_zh: 'AI核定老品清仓跳水，移入观察栏。',
      },
    }],
    market_summary_zh: '主力稳态，清仓款单列观察。',
  }, { form_id: 'form-h9-wire', peers: [{ asin: 'B0SYNWIR01', price_usd: 31.99, keepa_high_usd: 49.99, keepa_low_usd: 31.99, review_count: 88, review_curve_change: 'Flat', key_appearance_and_dims: '12x8x3 in' }] });
  const pbWiredJudge = analyzeMainstreamPriceBand([
    { asin: 'B0SYNWIR01', title: 'Clearance Peer', price_usd: 31.99, monthly_units: 90, fulfillment: 'FBA', age_days: 420 },
    { asin: 'B0SYNWIR02', title: 'Steady Peer', price_usd: 48.99, monthly_units: 120, fulfillment: 'FBA', age_days: 420, keepa_price_steady: true },
  ], { profile_revision: 59, market_observation_result: parsedJudgeForBand });
  assert.equal(pbWiredJudge.band.p50_usd, 48.99);

  assert.equal(evaluateGate0CategoryBoundary({ title: 'Waterproof Diaper Bag Backpack for Parents', root_category: 'Baby Products' }).hard_exclusion, false);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Silicone Baby Teether Toy for Infants', root_category: 'Baby Products' }).hard_exclusion, true);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Diaper Bag Backpack for Parents with Pocket for Toddler Clothes' }).hard_exclusion, false);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Floating Wood Nursery Shelf for Bedding Storage' }).hard_exclusion, false);
  assert.equal(evaluateGate0CategoryBoundary({ title: 'Nursery Shelving Unit for Closet Organization' }, { profile_revision: 59 }).hard_exclusion, false);
  assert.throws(() => evaluateGate0CategoryBoundary({ title: 'Diaper Bag Backpack for Mom with Toddler Pocket' }, { profile_revision: 58 }), /retired/i);
  assert.throws(() => analyzeMainstreamPriceBand([], { profile_revision: 58 }), /retired/i);

  assert.equal(canonicalizeConnectorToolName('mcp__codex_apps__amz_spapi_sp_api_execute'), 'sp_api_execute');
  assert.equal(
    validateProviderCall('sp_api', 'mcp__codex_apps__amz_spapi_sp_api_execute', { method: 'GET', path: '/catalog/2022-04-01/items/B000000001' }).valid,
    true,
  );

  const mismatchPriceCal = extractSpApiFinalistCalibration({
    asin: 'B0SYNR2SP1',
    price_usd: 40.00,
    feesEstimateRaw: {
      FeesEstimateResult: {
        Status: 'Success',
        Error: {},
        FeesEstimateIdentifier: { IdValue: 'B0SYNR2SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 80.00 } } },
        FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 17.00 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 12.00 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
      },
    },
  });
  assert.equal(mismatchPriceCal.fee_calibration_status, 'unmatched');

  const emptyErrOkCal = extractSpApiFinalistCalibration({
    asin: 'B0SYNR2SP1',
    price_usd: 40.00,
    feesEstimateRaw: {
      FeesEstimateResult: {
        Status: 'Success',
        Error: {},
        FeesEstimateIdentifier: { IdValue: 'B0SYNR2SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 40.00 } } },
        FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 11.00 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 6.00 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
      },
    },
    restrictionsRaw: {
      asin: 'B0SYNR2SP1',
      restrictions: [{ marketplaceId: 'A2EUQ1WTGCTBG2', conditionType: 'used_like_new', reasons: [{ reasonCode: 'NOT_ELIGIBLE', message: 'Restricted in CA used.' }] }],
    },
  });
  assert.equal(emptyErrOkCal.fee_calibration_status, 'verified');
  assert.equal(emptyErrOkCal.restrictions.hard_category_ban, false);

  const adjCentCal = extractSpApiFinalistCalibration({
    asin: 'B0SYNR3SP1',
    price_usd: 90.02,
    feesEstimateRaw: {
      FeesEstimateResult: {
        Status: 'Success',
        FeesEstimateIdentifier: { IdValue: 'B0SYNR3SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 90.01 } } },
        FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 18.50 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 13.50 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
      },
    },
  });
  assert.equal(adjCentCal.fee_calibration_status, 'unmatched');

  const pbParentMix = analyzeMainstreamPriceBand([
    { asin: 'B0SYNR2P01', parent_asin: 'B0SYNR2PAR', title: 'Mug Rack Black', price_usd: 39.99, monthly_units: 300, is_best_selling_variant: true, fulfillment: 'FBA', age_days: 60 },
    { asin: 'B0SYNR2P02', parent_asin: 'B0SYNR2PAR', title: 'Mug Rack Walnut', price_usd: 44.99, monthly_units: 120, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
  ], { profile_revision: 59 });
  assert.equal(pbParentMix.all_under_90d_blue_ocean, false);
  assert.equal(pbParentMix.band.p50_usd, 44.99);

  const pbBlueValidated = analyzeMainstreamPriceBand([
    { asin: 'B0SYNR2N01', title: 'New 1', price_usd: 36.99, monthly_units: 90, fulfillment: 'FBA', age_days: 45, ai_qualitative_bucket: 'newcomer_reference' },
    { asin: 'B0SYNR2N02', title: 'New 2', price_usd: 39.99, monthly_units: 110, fulfillment: 'FBA', age_days: 55, ai_qualitative_bucket: 'newcomer_reference' },
  ], { profile_revision: 59 });
  assert.equal(pbBlueValidated.all_under_90d_blue_ocean, true);
  assert.ok(pbBlueValidated.band.p50_usd >= 36.99);

  assert.throws(
    () => parseMarketObservationResult({
      schema_version: 1, contract: 'MarketObservationJudge', form_id: 'form-r2-fab',
      peer_observations: [{
        asin: 'B0SYNR2FAB',
        mandatory_facts: { observed_price_usd: 39.99, keepa_high_usd: null, keepa_low_usd: null, review_count: null, keepa_90d_trend: '走势稳定', coupon_status: '40% OFF', review_curve_change: '三周增加60评', key_appearance_and_dims: '18x12x4 in' },
        qualitative_judgment: { bucket: 'primary_comparable', include_in_primary_band: true, keep_in_observation_bar: false, reason_zh: '测试编造事实拦截。' },
      }],
      market_summary_zh: '测试缺失源文本拦截。',
    }, { form_id: 'form-r2-fab', peers: [{ asin: 'B0SYNR2FAB', price_usd: 39.99 }] }),
    /fabricated/i,
  );
  assert.throws(
    () => parseMarketObservationResult({
      schema_version: 1, contract: 'MarketObservationJudge', form_id: 'form-r3-cpn-distort',
      peer_observations: [{
        asin: 'B0SYNR3CPN',
        mandatory_facts: { observed_price_usd: 39.99, keepa_high_usd: null, keepa_low_usd: null, review_count: null, keepa_90d_trend: '未提供', coupon_status: '40% OFF 大额券', review_curve_change: '未提供', key_appearance_and_dims: '未提供' },
        qualitative_judgment: { bucket: 'heavy_promo_coupon', include_in_primary_band: false, keep_in_observation_bar: true, reason_zh: '测试篡改优惠券比例拦截。' },
      }],
      market_summary_zh: '测试券比例核验。',
    }, { form_id: 'form-r3-cpn-distort', peers: [{ asin: 'B0SYNR3CPN', price_usd: 39.99, coupon_pct: 5, coupon_text: 'Save 5% with coupon' }] }),
    /distorted|coupon_status/i,
  );

  await withTempDirAsync('pb-r58-cli-', async dir => {
    const pbCliIn = join(dir, 'pb-r58.json');
    writeFileSync(pbCliIn, JSON.stringify({
      listings: [
        { asin: 'B0SYNR58A1', title: 'Mature 1', price_usd: 59.99, monthly_units: 150, fulfillment: 'FBA', age_days: 400 },
        { asin: 'B0SYNR58A2', title: '100d 16% Coupon', list_price_usd: 59.99, ongoing_coupon_pct: 0.16, price_usd: 50.39, monthly_units: 150, fulfillment: 'FBA', age_days: 100 },
      ],
    }), 'utf8');
    const pbCliR58 = await runCliMem(['price-band', '--input', pbCliIn, '--profile-revision', '58']);
    assert.notEqual(pbCliR58.code, 0, '--profile-revision 58 rejected after r50-r58 retirement');
    const pbCliR59 = await runCliMem(['price-band', '--input', pbCliIn, '--profile-revision', '59']);
    assert.equal(pbCliR59.code, 0, pbCliR59.stderr);
    const pbCliR59Json = JSON.parse(pbCliR59.stdout);
    assert.equal(pbCliR59Json.analysis.mainstream_count, 2);

    const rawMarketPath = join(dir, 'ss-market.json');
    const rawSpQuotaPath = join(dir, 'sp-quota-err.json');
    const rawSpTieredPath = join(dir, 'sp-tiered-fees.json');
    writeFileSync(rawMarketPath, JSON.stringify({ items: [{ asin: 'B0SYNR3SP1', price: 80.00, monthlySales: 120 }, { asin: 'B0SYNR3SP2', price: 120.00, monthlySales: 90 }] }), 'utf8');
    writeFileSync(rawSpQuotaPath, JSON.stringify({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] }), 'utf8');
    writeFileSync(rawSpTieredPath, JSON.stringify({
      FeesEstimateResultList: [
        {
          Status: 'Success',
          FeesEstimateIdentifier: { IdValue: 'B0SYNR3SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 80.00 } } },
          FeesEstimate: { TotalFeesEstimate: { Amount: 17.00 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 12.00 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
        {
          Status: 'Success',
          FeesEstimateIdentifier: { IdValue: 'B0SYNR3SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 120.00 } } },
          FeesEstimate: { TotalFeesEstimate: { Amount: 19.40 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 14.40 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
      ],
    }), 'utf8');

    const makeTieredCand = (id) => {
      const c = structuredClone(syntheticFixture.candidates[0]);
      c.id = id;
      c.screening.reference_price_usd = {
        ...c.screening.reference_price_usd,
        value: 80.00,
        supported_price_range: [80.00, 120.00],
        matched_spec: true,
        target_variant_asin: 'B0SYNR3SP1',
      };
      const sc80 = structuredClone(c.economics.scenarios[0]);
      sc80.id = 'sc-80';
      sc80.package_source = 'factory_quote';
      sc80.cost_ledger.price_usd = 80.00;
      const sc120 = structuredClone(c.economics.scenarios[0]);
      sc120.id = 'sc-120';
      sc120.package_source = 'factory_quote';
      sc120.cost_ledger.price_usd = 120.00;
      sc120.price_anchor = { target_variant_asin: 'B0SYNR3SP2' };
      c.economics.scenarios = [sc80, sc120];
      c.economics.expected_primary_scenarios = [{ id: 'sc-80', status: 'active' }, { id: 'sc-120', status: 'active' }];
      return c;
    };

    const quotaIngested = ingestTrialSpecification({
      batch_id: 'b-r3-sp',
      evaluated_at: '2026-11-24',
      profile_revision: 59,
      allow_synthetic_fixture_ids: true,
      raw_receipt_files: ['ss-market.json', 'sp-quota-err.json', 'sp-tiered-fees.json'],
      evidence: syntheticFixture.evidence,
      candidates: [
        { candidate: makeTieredCand('cand-sp-quota'), raw_receipt_files: ['ss-market.json', 'sp-quota-err.json'] },
        { candidate: makeTieredCand('cand-sp-tiered'), raw_receipt_files: ['ss-market.json', 'sp-tiered-fees.json'] },
      ],
    }, r59Profile, { baseDir: dir });

    const qCand = quotaIngested.batch.candidates.find(c => c.id === 'cand-sp-quota');
    assert.equal(qCand.ingest_isolated_pending, true);
    const tCand = quotaIngested.batch.candidates.find(c => c.id === 'cand-sp-tiered');
    assert.equal(tCand.ingest_isolated_pending ?? false, false);
    assert.equal(tCand.economics.scenarios.find(s => s.id === 'sc-80').cost_ledger.referral_terms.referral_fraction, 0.15);
    assert.equal(tCand.economics.scenarios.find(s => s.id === 'sc-120').cost_ledger.referral_terms.referral_fraction, 0.12);
  });
});
