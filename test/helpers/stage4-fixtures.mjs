/**
 * Minimal shared synthetic fixture builders for Stage 4 tests (4A #11, 4B Keepa + SP-API, 4C #8).
 * Pure synthetic identifiers only (zero real ASINs, 1688 offers, or PII).
 */

export const STAGE4_AS_OF_DATE = '2026-11-27';

export function makeSteadyPeer({
  asin,
  priceUsd,
  ageDays,
  monthlyUnits = 120,
  title = 'Solid Wood Desktop Paint Rack Organizer',
  fulfillment = 'FBA',
  ...extra
}) {
  return {
    asin,
    parent_asin: `P${asin.slice(1)}`,
    title,
    fulfillment_channel: fulfillment,
    price_usd: priceUsd,
    monthly_units: monthlyUnits,
    age_days: ageDays,
    keepa_90d_steady: true,
    keepa_90d_median_usd: priceUsd,
    ...extra,
  };
}

export function makeGate1AScenario({
  id = 's1',
  asin = 'B0SYNVET01',
  priceUsd = 49.99,
  ageDays = 420,
  pkg = { length_in: 12, width_in: 9, height_in: 3, weight_lb: 2.0 },
  ...extra
} = {}) {
  return {
    id,
    asin,
    price_usd: priceUsd,
    age_days: ageDays,
    pkg,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    headhaul_usd: 2.5,
    collection_rate: 0.006,
    ...extra,
  };
}

export function registerStage4Form(store, {
  formId = 'form-stage4-test',
  label = 'Solid Wood Desktop Paint Rack Organizer',
  coreForm = 'wood paint rack organizer',
  buyerTask = 'organize hobby paint bottles on a desk',
  components = [{ name: 'wood_paint_rack', qty: 1 }],
  specVersion = 1,
} = {}) {
  store.upsertCandidateForm({
    form_id: formId,
    label,
    core_form: coreForm,
    buyer_task: buyerTask,
    saleable_set_composition: { components },
    spec_version: specVersion,
  });
  return formId;
}

export function makeDatedKeepaReceipt({
  asin,
  startDate = '2026-08-30',
  days = 90,
  priceUsd = 49.99,
  prices = null,
} = {}) {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const ts = Array.from({ length: days }, (_, i) => new Date(startMs + i * 86_400_000).toISOString().slice(0, 10));
  const priceSeries = Array.isArray(prices) ? prices : Array(days).fill(priceUsd);
  return {
    asin,
    keepa_trend: {
      ts,
      series: {
        price: priceSeries,
        buybox: priceSeries,
        couponHistory: Array(days).fill(null),
      },
    },
  };
}

export function makeSpApiCatalogItem({
  asin,
  length = 12,
  width = 8,
  height = 4,
  weight = 2.0,
  dimUnit = 'inches',
  weightUnit = 'pounds',
  marketplaceId = 'ATVPDKIKX0DER',
  packageQuantity = 1,
} = {}) {
  return {
    asin,
    dimensions: [
      {
        marketplaceId,
        package: {
          length: { value: length, unit: dimUnit },
          width: { value: width, unit: dimUnit },
          height: { value: height, unit: dimUnit },
          weight: { value: weight, unit: weightUnit },
        },
      },
    ],
    attributes: {
      number_of_items: [{ value: packageQuantity, marketplace_id: marketplaceId }],
    },
  };
}

export function makeSpApiFeesEstimate({
  asin,
  priceUsd,
  referralUsd,
  fbaUsd,
  marketplaceId = 'ATVPDKIKX0DER',
  currency = 'USD',
} = {}) {
  return {
    FeesEstimateResult: {
      Status: 'Success',
      FeesEstimateIdentifier: {
        MarketplaceId: marketplaceId,
        IdType: 'ASIN',
        IdValue: asin,
        IsAmazonFulfilled: true,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: currency, Amount: priceUsd },
        },
      },
      FeesEstimate: {
        TotalFeesEstimate: { CurrencyCode: currency, Amount: Number((referralUsd + fbaUsd).toFixed(2)) },
        FeeDetailList: [
          { FeeType: 'ReferralFee', FinalFee: { CurrencyCode: currency, Amount: referralUsd } },
          { FeeType: 'FBAFees', FinalFee: { CurrencyCode: currency, Amount: fbaUsd } },
        ],
      },
    },
  };
}

