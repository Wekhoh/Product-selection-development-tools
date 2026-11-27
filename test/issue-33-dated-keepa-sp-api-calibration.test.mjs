import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMainstreamPriceBand } from '../src/price-band.mjs';
import { parseSellerSpriteKeepaPayload } from '../src/adapters/keepa.mjs';
import {
  classifySpApiRestrictionReasons,
  extractSpApiFinalistCalibration,
  extractSpApiPeerPackagesFromRawPayloads,
} from '../src/adapters/sp-api.mjs';
import {
  ingestTrialSpecification,
  mergeKeepaPayloadsIntoPeerListings,
} from '../src/raw-ingest.mjs';
import {
  STAGE4_AS_OF_DATE,
  makeDatedKeepaReceipt,
  makeSpApiCatalogItem,
  makeSpApiFeesEstimate,
  makeSteadyPeer,
} from './helpers/stage4-fixtures.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);
const syntheticFixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'),
);

test('Issue #33 (4B Keepa): locks >=365d veteran floor, blocks undated/sparse/sub-90d/AI-only Keepa bypasses, and aligns inline vs raw merge', () => {
  const datedVet = makeSteadyPeer({ asin: 'B0SYN4BV01', priceUsd: 49.99, ageDays: 400 });

  // Immutable >= 365d veteran age floor cannot be lowered by caller options
  assert.throws(
    () => analyzeMainstreamPriceBand([datedVet], { as_of_date: STAGE4_AS_OF_DATE, veteran_min_age_days: 90 }),
    /veteran_min_age_days.*365/i,
  );
  assert.throws(
    () => analyzeMainstreamPriceBand([datedVet], { as_of_date: STAGE4_AS_OF_DATE, veteran_min_age_days: 364 }),
    /veteran_min_age_days.*365/i,
  );

  // Undated trailing slice ($41.20 on last 5 undated samples vs $58.40 plateau) + AI primary_comparable + stale flags MUST stay out
  const undatedTrailingPeer = {
    asin: 'B0SYN4BU01',
    parent_asin: 'P0SYN4BU01',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 41.20,
    monthly_units: 200,
    age_days: 500,
    keepa_90d_steady: true,
    keepa_90d_median_usd: 58.40,
    historical_regular_price_usd: 58.40,
    ai_qualitative_bucket: 'primary_comparable',
    keepa_trend: {
      series: {
        price: [...Array(96).fill(58.40), 41.20, 41.20, 41.20, 41.20, 41.20],
      },
    },
  };
  const undatedBand = analyzeMainstreamPriceBand([undatedTrailingPeer], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(undatedBand.mature_regular_band, null, 'Undated Keepa slice must never anchor mature_regular_band');
  assert.equal(undatedBand.mainstream_count, 0);
  const obsUndated = undatedBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYN4BU01');
  assert.equal(obsUndated?.reason_code, 'undated_keepa_cannot_enter_mature_band');
  assert.equal(obsUndated?.net_price_usd, 41.20);

  // Top-level has_timestamps:false + historical_regular_price_usd MUST NOT enter mature_regular_band or historicalPeers
  const topUndatedBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BU03',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 57.00,
    monthly_units: 140,
    age_days: 430,
    has_timestamps: false,
    historical_regular_price_usd: 57.00,
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(topUndatedBand.mature_regular_band, null);
  assert.notEqual(topUndatedBand.regular_band_reference?.basis, 'observed_historical_regular_prices');

  // 400d veteran carrying ONLY AI primary_comparable (zero Keepa evidence) MUST NOT self-certify as Keepa-steady
  const aiOnlyBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BAI1',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 44.00,
    monthly_units: 120,
    age_days: 400,
    ai_qualitative_bucket: 'primary_comparable',
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(aiOnlyBand.mature_regular_band, null);

  // 90 dated timestamps where first 88 are null and only final 2 are $44 -> observed span is 2d (<90d), NOT steady!
  const sparseReceipt = makeDatedKeepaReceipt({
    asin: 'B0SYN4BSP0',
    startDate: '2026-08-30',
    days: 90,
    prices: [...Array(88).fill(null), 44.00, 44.00],
  });
  const parsedSparse = parseSellerSpriteKeepaPayload(sparseReceipt, { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(parsedSparse.keepa_90d_steady, false);
  assert.equal(parsedSparse.window_90d.calendar_span_days, 2);
  const sparseBand = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BSP0',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 44.00,
    monthly_units: 140,
    age_days: 440,
    keepa_trend: sparseReceipt.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(sparseBand.mature_regular_band, null);
  assert.equal(
    sparseBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYN4BSP0')?.reason_code,
    'keepa_window_under_90d_cannot_enter_mature_band',
  );

  // Sub-90d dated curve (60 days) MUST stay out of mature_regular_band
  const sub90dReceipt = makeDatedKeepaReceipt({ asin: 'B0SYN4BS60', startDate: '2026-09-28', days: 60, priceUsd: 46.50 });
  const sub90Band = analyzeMainstreamPriceBand([{
    asin: 'B0SYN4BS60',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 46.50,
    monthly_units: 180,
    age_days: 450,
    ai_qualitative_bucket: 'primary_comparable',
    keepa_90d_steady: true,
    keepa_trend: sub90dReceipt.keepa_trend,
  }], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(sub90Band.mature_regular_band, null);
  assert.equal(
    sub90Band.observed_out_of_band_peers.find(p => p.asin === 'B0SYN4BS60')?.reason_code,
    'keepa_window_under_90d_cannot_enter_mature_band',
  );

  // mergeKeepaPayloadsIntoPeerListings: undated receipt strips stale steady/median; fresh 90d $44 receipt overwrites stale $80 & package-only flag
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

  // Top-level { ts, series } preserves ts and passes >=365d veteran while 364d stays growth tier
  const valid90d = makeDatedKeepaReceipt({ asin: 'B0SYN4BV90', startDate: '2026-08-30', days: 90, priceUsd: 49.99 });
  const valid90dVet = {
    asin: 'B0SYN4BV90',
    parent_asin: 'P0SYN4BV90',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 49.99,
    monthly_units: 200,
    age_days: 365,
    ts: valid90d.keepa_trend.ts,
    series: valid90d.keepa_trend.series,
  };
  const peer364d = {
    asin: 'B0SYN4BG36',
    parent_asin: 'P0SYN4BG36',
    title: 'Solid Wood Desktop Paint Rack',
    fulfillment_channel: 'FBA',
    price_usd: 42.99,
    monthly_units: 200,
    age_days: 364,
    keepa_trend: makeDatedKeepaReceipt({ asin: 'B0SYN4BG36', startDate: '2026-08-30', days: 90, priceUsd: 42.99 }).keepa_trend,
  };
  const validBand = analyzeMainstreamPriceBand([valid90dVet, peer364d], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(validBand.age_tier_counts.veteran_ge_365d, 1, 'Exactly 365d qualifies as veteran; 364d remains growth');
  assert.equal(validBand.age_tier_counts.growth_91_364d_steady, 1);
  assert.equal(validBand.mature_regular_band.min_usd, 42.99);
  assert.equal(validBand.mature_regular_band.max_usd, 49.99);
});

test('Issue #33 (4B SP-API): CatalogItems shapes/units/marketplace/qty parity, fee completeness, archived summary receipt, recall scope, and PriceToEstimateFees isolation', () => {
  // 1. Wrapped payload.data.items[] with CA record before US record + hundredths-inches / hundredths-pounds + qty=4
  const caItem = makeSpApiCatalogItem({ asin: 'B0SYN4BSP1', marketplaceId: 'A2EUQ1WTGCTBG2', weight: 9.9 });
  const usItem = makeSpApiCatalogItem({
    asin: 'B0SYN4BSP1',
    length: 1450,
    width: 950,
    height: 325,
    weight: 275,
    dimUnit: 'hundredths-inches',
    weightUnit: 'hundredths-pounds',
    packageQuantity: 4,
  });
  const wrappedCatalog = { payload: { data: { items: [caItem, usItem] } } };
  const feesRaw = makeSpApiFeesEstimate({ asin: 'B0SYN4BSP1', priceUsd: 59.99, referralUsd: 9.00, fbaUsd: 8.15 });
  const brandGateRest = {
    asin: 'B0SYN4BSP1',
    restrictions: [{ marketplaceId: 'ATVPDKIKX0DER', conditionType: 'new_new', reasons: [{ message: 'You need approval to list in this brand.' }] }],
  };

  const fullCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    price_usd: 59.99,
    expected_package_quantity: 4,
    catalogItemRaw: wrappedCatalog,
    feesEstimateRaw: feesRaw,
    restrictionsRaw: brandGateRest,
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

  // 2. Missing package_quantity when expected_package_quantity is known -> unverified_package_quantity (not verified!)
  const noQtyCat = makeSpApiCatalogItem({ asin: 'B0SYN4BSP1' });
  delete noQtyCat.attributes;
  const unverifiedQtyCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    price_usd: 59.99,
    expected_package_quantity: 4,
    catalogItemRaw: noQtyCat,
    feesEstimateRaw: feesRaw,
    restrictionsRaw: brandGateRest,
  });
  assert.equal(unverifiedQtyCal.package_calibration_status, 'unverified_package_quantity');
  assert.equal(unverifiedQtyCal.finalist_calibration_complete, false);

  // 3. List envelope with single non-matching ASIN returns asin_not_found_in_catalog_items consistently
  const missListCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    catalogItemRaw: { items: [makeSpApiCatalogItem({ asin: 'B0SYNOTHER' })] },
  });
  assert.equal(missListCal.package_calibration_status, 'asin_not_found_in_catalog_items');

  // 4. Foreign marketplace only -> marketplace_mismatch
  const ukOnlyCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    marketplace_id: 'ATVPDKIKX0DER',
    catalogItemRaw: makeSpApiCatalogItem({ asin: 'B0SYN4BSP1', marketplaceId: 'A1F83G8C2ARO7P' }),
  });
  assert.equal(ukOnlyCal.package_calibration_status, 'marketplace_mismatch');
  assert.equal(ukOnlyCal.official_pkg, null);

  // 5. Total-only fee estimate (missing ReferralFee & FBAFees) -> incomplete_fee_details, NOT complete!
  const totalOnlyFeesCal = extractSpApiFinalistCalibration({
    asin: 'B0SYN4BSP1',
    price_usd: 59.99,
    catalogItemRaw: usItem,
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

  // 6. Single-ASIN recall (even when phrasing says "not permitted for sale") stays recall-scope review, NOT hard category ban; NOT_ELIGIBLE never falls to 'clear'
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

  // 6b. Multi-ASIN archived listings_restrictions missing target ASIN must NOT report clear
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

  // 7. End-to-end ingestTrialSpecification: archived fees_estimates[] + listings_restrictions[] triggers missing_catalog_items note,
  //    wrapped payload:[item] auto-discovers official_pkg, and fee-query price_usd NEVER satisfies market price provenance!
  const dir = mkdtempSync(join(tmpdir(), 'issue33-sp-api-'));
  try {
    const baseCand = structuredClone(syntheticFixture.candidates[0]);
    baseCand.id = 'cand-issue33-sp';
    baseCand.screening.reference_price_usd.target_variant_asin = 'B0SYN4BSP1';
    baseCand.screening.reference_price_usd.value = 40;
    baseCand.economics.scenarios[0].price_anchor = {
      ...baseCand.economics.scenarios[0].price_anchor,
      target_variant_asin: 'B0SYN4BSP1',
      value: 40,
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

    // (a) Archived fees_estimates + listings_restrictions WITHOUT CatalogItems -> surfaces missing_catalog_items gap note
    const missingCatRes = ingestTrialSpecification(
      {
        profile_revision: 59,
        raw_receipt_files: [ssMarketFile, spArchivedSummaryFile],
        candidates: [{ candidate: structuredClone(baseCand), raw_receipt_files: [ssMarketFile, spArchivedSummaryFile] }],
      },
      r59Profile,
      { baseDir: dir },
    );
    const missingCand = missingCatRes.batch.candidates[0];
    assert.equal(missingCand.sp_api_calibration.package_calibration_status, 'missing_catalog_items');
    assert.equal(missingCand.sp_api_calibration.fee_calibration_status, 'verified');
    assert.ok((missingCand.review_notes ?? []).some(n => /CatalogItems|官方包装尺寸/.test(String(n))));

    // (b) Multi-file CA CatalogItems before wrapped US payload:[item] auto-discovers US official_pkg (never masked by CA)
    const fullIngestRes = ingestTrialSpecification(
      {
        profile_revision: 59,
        raw_receipt_files: [ssMarketFile, spArchivedSummaryFile, spCatCaFile, spCatArrayFile],
        candidates: [{ candidate: structuredClone(baseCand), raw_receipt_files: [ssMarketFile, spArchivedSummaryFile, spCatCaFile, spCatArrayFile] }],
      },
      r59Profile,
      { baseDir: dir },
    );
    const fullCand = fullIngestRes.batch.candidates[0];
    assert.equal(fullCand.sp_api_calibration.package_calibration_status, 'verified');
    assert.equal(fullCand.sp_api_calibration.official_pkg.unit_weight_lb, 2.75);
    assert.equal(fullCand.economics.scenarios[0].cost_ledger.pkg.unit_weight_lb, 2.75);

    // (c) Archived fees_estimates price_usd ($40) WITHOUT SellerSprite/Keepa market observation MUST NOT satisfy market price provenance!
    assert.throws(
      () => ingestTrialSpecification(
        {
          profile_revision: 59,
          raw_receipt_files: [spArchivedSummaryFile, spCatArrayFile],
          candidates: [{ candidate: structuredClone(baseCand), raw_receipt_files: [spArchivedSummaryFile, spCatArrayFile] }],
        },
        r59Profile,
        { baseDir: dir },
      ),
      /price-binding|provenance/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
