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

export function makeStage4OrganizerTrayCandidate(baseTemplate, {
  id = 'form-syn-organizer-tray-kit',
  specSha256 = 'a'.repeat(64),
  specVersion = 1,
  lowAsin = 'B0SYN8LOW1',
  highAsin = 'B0SYN8HIG2',
  lowPrice = 38.00,
  highPrice = 48.00,
} = {}) {
  const cand = structuredClone(baseTemplate);
  cand.id = id;
  cand.label = '桌面收纳盒＋可拆托盘套装（合成验收案例）';
  cand.form = '1整套桌面收纳盒含可拆托盘';
  cand.spec_sha256 = specSha256;
  cand.spec_version = specVersion;
  cand.product_seasonality = 'evergreen';

  const makeScenario = (scId, label, priceUsd, asin) => {
    const sc = structuredClone(cand.economics.scenarios[0]);
    sc.id = scId;
    sc.label = label;
    sc.quote_id = 'q1688-syn-kit-100';
    sc.price_anchor = {
      value: priceUsd,
      unit: 'USD',
      matched_spec: true,
      target_variant_asin: asin,
      fulfillment_channel: 'FBA',
      sales_history_supported: true,
      evidence: [cand.evidence[0].id],
    };
    sc.cost_ledger.id = scId;
    sc.cost_ledger.price_usd = priceUsd;
    sc.cost_ledger.fee_context = {
      ...sc.cost_ledger.fee_context,
      sales: { from: '2027-02-01', through: '2027-10-14' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-15', through: '2027-10-14' },
    };
    const refLine = sc.cost_ledger.lines.find(l => l.id === 'referral');
    if (refLine) {
      const r = sc.cost_ledger.refund_fraction ?? 0.04;
      const grossRef = priceUsd * 0.15;
      refLine.amount_usd = Number((grossRef * (1 - r) + r * Math.min(5, grossRef * 0.2)).toFixed(6));
    }
    const colLine = sc.cost_ledger.lines.find(l => l.id === 'collection');
    if (colLine) {
      const r = sc.cost_ledger.refund_fraction ?? 0.04;
      const nonColAmz = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
        .reduce((s, lid) => s + (sc.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
      const payout = Math.max(0, priceUsd * (1 - r) - nonColAmz);
      colLine.amount_usd = Number((payout * (sc.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
    }
    delete sc.margin;
    delete sc.contribution_usd;
    return sc;
  };

  cand.screening.reference_price_usd = {
    value: lowPrice,
    unit: 'USD',
    matched_spec: true,
    target_variant_asin: lowAsin,
    fulfillment_channel: 'FBA',
    sales_history_supported: true,
    supported_price_range: [lowPrice, highPrice],
    evidence: [cand.evidence[0].id],
  };
  cand.economics.expected_primary_scenarios = [
    { id: 'sc-low-no-tray', status: 'active' },
    { id: 'sc-high-parts-unknown', status: 'active' },
  ];
  cand.economics.scenarios = [
    makeScenario('sc-low-no-tray', `低价对标 $${lowPrice}（${lowAsin}）`, lowPrice, lowAsin),
    makeScenario('sc-high-parts-unknown', `高价对标 $${highPrice}（${highAsin}）`, highPrice, highAsin),
  ];
  return cand;
}


