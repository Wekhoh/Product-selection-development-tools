/**
 * Deterministic, zero-glue raw-receipt -> pipeline ingestion & seasonal companion builder (Revision 59+).
 *
 * Guarantees:
 *  1. 100% raw-receipt ASIN provenance (blocks phantom un-sourced ASINs before SpecMatcher/scoring).
 *  2. SellerSprite leaf-first `returnRatio` extraction with explicit fallback to department `avgReturnRatio` ONLY when the leaf is missing/`NO_DATA` (never 0.05 or sibling-leaf `returnRatio`).
 *  3. Parent-family `monthlySales` deduplication across child rows.
 *  4. 3-Tier Progressive Suggested Bid auto-extraction (mid-core vs 5+-word opportunistic long-tail, SIF `cpc_raise_exact` fallback).
 *  5. Stage-1 vs Stage-2 qualitative scoring unlock (#16/#17/#20/#21) + SP-API competitor-brand vs category gating classification.
 *  6. Paired `off_peak` + `peak` seasonal operating period builder with period-scoped `expected_primary_scenarios` and unique `stress_scenarios[]` IDs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveCategoryReturnWithFallback,
  deduplicateParentSalesRows,
} from './observations.mjs';
import { scoreBatch } from './scoring.mjs';
import { assertNoRawPii, containsSecretToken } from './contracts.mjs';
import { analyzeMainstreamPriceBand, parseSingleUnitUsdCoupon } from './price-band.mjs';
import { resolveEffectivePricing } from './fee-basis.mjs';
import { canonicalJson, openSelectionStore, sha256Hex } from './store.mjs';

const ASIN_EXACT_RE = /^B0[A-Z0-9]{8}$/;
const ASIN_TOKEN_RE = /\bB0[A-Z0-9]{8}\b/g;
const STRUCTURED_ASIN_KEY_RE = /^(?:asin|parent|parent_asin|parentAsin|child_asin|target_asin|variation_asin|IdValue)$/i;
const STRUCTURED_ASIN_ARRAY_KEY_RE = /^(?:asins|asinList|top_asins|topAsins|variationAsins|childAsins)$/i;
const DIRECT_PRICE_KEYS = [
  'price',
  'price_usd',
  'list_price_usd',
  'net_price_usd',
  'keepa_90d_median_usd',
  'historical_regular_price_usd',
  'buyboxPrice',
  'salePrice',
];
const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;
const round2 = v => Number(v.toFixed(2));

function hasUpstreamErrorMarkers(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.isError === true) return true;
  if (obj.error !== undefined && obj.error !== null && obj.error !== false && obj.error !== '') return true;
  if (obj.status === 'failed' || obj.status === 'error') return true;
  if (obj.code !== undefined && obj.code !== null && !['OK', '0', 0, 200].includes(obj.code)) {
    return true;
  }
  return false;
}

function isPayloadUpstreamFailure(rawPayload, depth = 0, seen = new Set()) {
  if (!rawPayload || typeof rawPayload !== 'object' || depth > 5 || seen.has(rawPayload)) return false;
  seen.add(rawPayload);
  if (hasUpstreamErrorMarkers(rawPayload)) return true;
  for (const key of ['structuredContent', 'data', 'result', 'response', 'payload']) {
    const child = rawPayload[key];
    if (child && typeof child === 'object' && isPayloadUpstreamFailure(child, depth + 1, seen)) {
      return true;
    }
  }
  if (Array.isArray(rawPayload.content)) {
    for (const block of rawPayload.content) {
      if (block?.isError === true) return true;
      if (typeof block?.text === 'string') {
        const s = block.text.trim();
        if (s.startsWith('{') && s.endsWith('}')) {
          try {
            const parsed = JSON.parse(s);
            if (isPayloadUpstreamFailure(parsed, depth + 1, seen)) return true;
          } catch { /* ignore */ }
        }
      }
    }
  }
  return false;
}

function hasEnvelopeFailureMarkers(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (hasUpstreamErrorMarkers(obj)) return true;
  if (obj.dataStatus === 'NO_DATA') return true;
  return false;
}

export function isFailedOrEmptyRawReceipt(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return true;
  if (isPayloadUpstreamFailure(rawPayload)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload.structuredContent)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload.structuredContent?.data)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload.data)) return true;
  return false;
}

export function unwrapMcpEnvelope(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return rawPayload;
  if (isFailedOrEmptyRawReceipt(rawPayload)) return null;
  if (rawPayload.structuredContent?.data !== undefined) return rawPayload.structuredContent.data;
  if (rawPayload.data !== undefined && typeof rawPayload.data === 'object') return rawPayload.data;
  if (Array.isArray(rawPayload.content)) {
    for (const block of rawPayload.content) {
      if (typeof block?.text === 'string') {
        const s = block.text.trim();
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
          try {
            const parsed = JSON.parse(s);
            if (hasEnvelopeFailureMarkers(parsed)) return null;
            if (parsed?.data !== undefined && typeof parsed.data === 'object') {
              return hasEnvelopeFailureMarkers(parsed.data) ? null : parsed.data;
            }
            return parsed;
          } catch { /* ignore */ }
        }
      }
    }
  }
  return rawPayload;
}

function isFailedUnwrappedBody(unwrapped) {
  if (!unwrapped || typeof unwrapped !== 'object') return true;
  if (Array.isArray(unwrapped)) return unwrapped.length === 0;
  if (hasEnvelopeFailureMarkers(unwrapped)) return true;
  return false;
}

function extractItemCategoryRoot(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (nonemptyStr(obj.categoryId)) return obj.categoryId.trim().toLowerCase();
  if (Array.isArray(obj.categoryPath) && nonemptyStr(obj.categoryPath[0])) {
    return obj.categoryPath[0].trim().toLowerCase();
  }
  if (nonemptyStr(obj.rootCategory)) return obj.rootCategory.trim().toLowerCase();
  return null;
}

function extractStructuredPricesFromObject(obj) {
  const prices = new Set();
  const addPrice = p => {
    if (finite(p) && p > 0) prices.add(round2(p));
  };
  for (const key of DIRECT_PRICE_KEYS) {
    addPrice(obj?.[key]);
  }
  const baseListPrice = finite(obj?.list_price_usd) ? obj.list_price_usd : (finite(obj?.price) ? obj.price : null);
  if (baseListPrice !== null && obj?.coupon !== undefined && obj?.coupon !== null) {
    const parsedCoupon = parseSingleUnitUsdCoupon(obj.coupon);
    if (parsedCoupon.type === 'pct') {
      addPrice(baseListPrice * (1 - parsedCoupon.pct));
    } else if (parsedCoupon.type === 'usd' && parsedCoupon.usd < baseListPrice) {
      addPrice(baseListPrice - parsedCoupon.usd);
    }
  }
  // SP-API fee estimate / pricing summary structures
  addPrice(obj?.PriceToEstimateFees?.ListingPrice?.Amount);
  addPrice(obj?.FeesEstimateIdentifier?.PriceToEstimateFees?.ListingPrice?.Amount);
  for (const lp of obj?.Summary?.LowestPrices ?? []) {
    addPrice(lp?.LandedPrice?.Amount);
    addPrice(lp?.ListingPrice?.Amount);
  }
  for (const bp of obj?.Summary?.BuyBoxPrices ?? []) {
    addPrice(bp?.LandedPrice?.Amount);
    addPrice(bp?.ListingPrice?.Amount);
  }
  // Keepa / SellerSprite historical price arrays
  let hasKeepaSeries = false;
  for (const arr of [obj?.series?.price, obj?.priceList, obj?.keepa?.price]) {
    if (Array.isArray(arr)) {
      for (const p of arr) {
        if (finite(p) && p > 0) {
          addPrice(p);
          hasKeepaSeries = true;
        }
      }
    }
  }
  return {
    observed_prices_usd: [...prices],
    has_keepa_series: hasKeepaSeries,
  };
}

/**
 * Build a structured ASIN provenance & price catalog strictly from successful structured receipt objects.
 * Never regex-scans free-text error/summary strings, and rejects failed/error/NO_DATA envelopes.
 */
export function extractVerifiedAsinCatalogFromRawPayloads(rawPayloads = []) {
  const catalog = new Map();
  const recordAsin = (asin, meta) => {
    if (!ASIN_EXACT_RE.test(asin)) return;
    let bucket = catalog.get(asin);
    if (!bucket) {
      bucket = [];
      catalog.set(asin, bucket);
    }
    bucket.push(meta);
  };

  for (const entry of rawPayloads) {
    const raw = entry?.payload ?? entry;
    const sourceId = nonemptyStr(entry?.source_id) ? entry.source_id : null;
    const sourceSha256 = nonemptyStr(entry?.source_sha256) ? entry.source_sha256 : null;
    if (isFailedOrEmptyRawReceipt(raw)) continue;
    const unwrapped = unwrapMcpEnvelope(raw);
    if (isFailedUnwrappedBody(unwrapped)) continue;

    const seen = new Set();
    const visit = (val, depth = 0) => {
      if (!val || typeof val !== 'object' || depth > 12 || seen.has(val)) return;
      seen.add(val);
      if (Array.isArray(val)) {
        for (const item of val) visit(item, depth + 1);
        return;
      }
      // Skip failed individual sub-rows (e.g. SP-API batch error item, per-row error envelope, or failed sub-call)
      if (hasEnvelopeFailureMarkers(val) || val.resultStatus === 'error') {
        return;
      }

      const priceInfo = extractStructuredPricesFromObject(val);
      const itemCatRoot = extractItemCategoryRoot(val);
      for (const [k, v] of Object.entries(val)) {
        if (STRUCTURED_ASIN_KEY_RE.test(k) && typeof v === 'string') {
          const norm = v.trim().toUpperCase();
          if (ASIN_EXACT_RE.test(norm)) {
            const isPrimaryRowAsin = /^(?:asin|child_asin|target_asin|IdValue)$/i.test(k);
            recordAsin(norm, {
              asin: norm,
              key: k,
              source_id: sourceId,
              source_sha256: sourceSha256,
              category_root: isPrimaryRowAsin ? itemCatRoot : null,
              observed_prices_usd: isPrimaryRowAsin ? priceInfo.observed_prices_usd : [],
              has_keepa_series: isPrimaryRowAsin ? priceInfo.has_keepa_series : false,
            });
          }
        } else if (STRUCTURED_ASIN_ARRAY_KEY_RE.test(k) && Array.isArray(v)) {
          for (const elem of v) {
            if (typeof elem === 'string') {
              const norm = elem.trim().toUpperCase();
              if (ASIN_EXACT_RE.test(norm)) {
                recordAsin(norm, {
                  asin: norm,
                  key: k,
                  source_id: sourceId,
                  source_sha256: sourceSha256,
                  observed_prices_usd: [],
                  has_keepa_series: false,
                });
              }
            }
          }
        }
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    };
    visit(unwrapped, 0);
  }
  return catalog;
}

/**
 * Scan raw provider receipt objects/JSON trees and return the exact uppercase set of observed structured ASINs.
 */
export function extractVerifiedAsinSetFromRawPayloads(rawPayloads = []) {
  return new Set(extractVerifiedAsinCatalogFromRawPayloads(rawPayloads).keys());
}

/**
 * Extract every B0xxxxxxxx ASIN token referenced anywhere inside a candidate object tree,
 * skipping embedded raster data URIs (`data:image/...;base64,...`) and requiring uppercase `B0[A-Z0-9]{8}`
 * in prose while normalizing structured ASIN fields.
 */
export function extractAllCandidateAsins(value) {
  const found = new Set();
  const seen = new Set();
  const walk = (v, keyHint = '', depth = 0) => {
    if (v === null || v === undefined || depth > 14) return;
    if (typeof v === 'string') {
      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(v)) return;
      if (STRUCTURED_ASIN_KEY_RE.test(keyHint)) {
        const norm = v.trim().toUpperCase();
        if (ASIN_EXACT_RE.test(norm)) found.add(norm);
        return;
      }
      for (const m of v.matchAll(ASIN_TOKEN_RE)) found.add(m[0]);
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, keyHint, depth + 1);
      return;
    }
    for (const [k, child] of Object.entries(v)) walk(child, k, depth + 1);
  };
  walk(value, '', 0);
  return found;
}

/**
 * Hard-reject any ASIN in a candidate/SpecMatcher/cohort payload that does not exist in raw receipts.
 */
export function assertRawAsinProvenance(asins, rawPayloads = []) {
  const verifiedSet = rawPayloads instanceof Set
    ? rawPayloads
    : (rawPayloads instanceof Map
      ? new Set(rawPayloads.keys())
      : extractVerifiedAsinSetFromRawPayloads(rawPayloads));
  const missing = [];
  for (const rawAsin of asins ?? []) {
    if (!nonemptyStr(rawAsin)) continue;
    const norm = rawAsin.trim().toUpperCase();
    if (ASIN_EXACT_RE.test(norm) && !verifiedSet.has(norm)) {
      missing.push(norm);
    }
  }
  if (missing.length > 0) {
    throw new TypeError(
      `Raw ASIN provenance violation: un-sourced phantom ASIN(s) [${[...new Set(missing)].join(', ')}] never appeared in verified structured raw receipts.`,
    );
  }
  return { valid: true, verified_count: verifiedSet.size };
}

/**
 * Extract category return rate under Revision 59 leaf-first priority (`returnRatio` first, falling back strictly to
 * department `avgReturnRatio` ONLY when leaf `returnRatio` is missing/`NO_DATA`) and deduplicated parent sales from raw receipts.
 */
export function ingestRawCategoryAndDemandMetrics({
  demand365Raw = null,
  parentDemand365Raw = null,
  parentCategoryLabel = null,
  preferLeafReturnRatio = true,
  asinRows = [],
} = {}) {
  if (demand365Raw !== null && demand365Raw !== undefined && isPayloadUpstreamFailure(demand365Raw)) {
    throw new TypeError(
      'Upstream leaf category_demand_report failed with an error payload; cannot treat API/transport failure as NO_DATA fallback.',
    );
  }
  if (parentDemand365Raw !== null && parentDemand365Raw !== undefined && isPayloadUpstreamFailure(parentDemand365Raw)) {
    throw new TypeError(
      'Upstream parent category_demand_report failed with an error payload; cannot adopt failed fallback metrics.',
    );
  }
  const leafData = unwrapMcpEnvelope(demand365Raw);
  const parentData = unwrapMcpEnvelope(parentDemand365Raw);
  const leafRatioObj = leafData?.ratioComparison ?? leafData?.stat ?? leafData ?? null;
  const parentRatioObj = parentData
    ? {
      ...(parentData?.ratioComparison ?? parentData?.stat ?? parentData),
      ...(parentCategoryLabel ? { category_label: parentCategoryLabel } : {}),
    }
    : null;
  const categoryReturn = resolveCategoryReturnWithFallback(leafRatioObj, parentRatioObj, { preferLeafReturnRatio });
  const deduplicatedSales = deduplicateParentSalesRows(asinRows);
  return {
    category_return: categoryReturn,
    deduplicated_sales: deduplicatedSales,
  };
}

/**
 * Build a Revision 59 3-Tier Progressive Bid payload from raw SIF & SellerSprite rows:
 *  - Tier 1: keeps 1–3 searched mid-core purchase terms in `entries`; moves unbid 5+-word ultra-long-tail terms to `long_tail_opportunistic_terms[]`.
 *  - Tier 2: prefers SIF `cpc_fixed_exact`, automatically falling back to SIF `cpc_raise_exact` (`up_and_down`) when fixed exact is absent.
 *  - Tier 3: supports `entry_scope: 'parent_functional_proxy'` or `unbid_after_all_tiers: true`.
 */
export function extractSifThreeTierBidPlan({
  queries = [],
  evidence = [],
  marketplace = 'US',
  currency = 'USD',
  volume_period = null,
  selection_reason = '3-Tier Progressive Suggested Bid auto-extracted from raw receipts.',
  entry_scope = null,
  proxy_reason = null,
  unbid_after_all_tiers = null,
  unbid_reason = null,
} = {}) {
  const entries = [];
  const opportunistic = [];
  const mainQueriesMeta = [];

  for (const q of queries) {
    if (!q || !nonemptyStr(q.query)) continue;
    const queryText = q.query.trim();
    const wordCount = queryText.split(/\s+/).length;
    const ssExact = finite(q.ss_row?.exactPpc) ? q.ss_row.exactPpc
      : finite(q.ss_row?.ppc?.exact?.value) ? q.ss_row.ppc.exact.value
        : finite(q.ss_exact_usd) ? q.ss_exact_usd : null;
    const ssLow = finite(q.ss_row?.minExactPpc) ? q.ss_row.minExactPpc : null;
    const ssHigh = finite(q.ss_row?.maxExactPpc) ? q.ss_row.maxExactPpc : null;
    const ssStrategy = q.ss_strategy ?? 'unspecified';

    const sig = q.sif_row?.supporting_signals ?? q.sif_row ?? {};
    const sifFixed = finite(sig.cpc_fixed_exact) ? sig.cpc_fixed_exact : null;
    const sifFixedLow = finite(sig.cpc_fixed_exact_low) ? sig.cpc_fixed_exact_low : null;
    const sifFixedHigh = finite(sig.cpc_fixed_exact_high) ? sig.cpc_fixed_exact_high : null;
    const sifRaise = finite(sig.cpc_raise_exact) ? sig.cpc_raise_exact : null;
    const sifRaiseLow = finite(sig.cpc_raise_exact_low) ? sig.cpc_raise_exact_low : null;
    const sifRaiseHigh = finite(sig.cpc_raise_exact_high) ? sig.cpc_raise_exact_high : null;

    const hasSifTier1Or2 = sifFixed !== null || sifRaise !== null;
    // Tier 3a (`ss_web`) is strictly a fallback when Tier 1/2 lack exact bids; ignore ss_web when SIF Tier 1/2 already returned an exact point!
    const effectiveSsExact = (q.ss_channel === 'ss_web' && hasSifTier1Or2) ? null : ssExact;
    const hasAnyExactBid = effectiveSsExact !== null || hasSifTier1Or2;

    // Tier 1: unbid 5+-word ultra-long-tail queries move to opportunistic list instead of locking the 15-pt item!
    if (!hasAnyExactBid && (wordCount >= 5 || q.is_long_tail_opportunistic === true)) {
      opportunistic.push({
        query: queryText,
        volume: finite(q.monthly_searches) ? q.monthly_searches : null,
        note: '超长尾蓝海捡漏词（同行未单独建精准词组，不锁死主词竞价 15 分）',
      });
      continue;
    }

    const entry = {
      query: queryText,
      ...(finite(q.monthly_searches) && volume_period ? {
        volume: {
          value: q.monthly_searches,
          unit: 'searches_per_month',
          period: volume_period,
          evidence,
        },
      } : {}),
      sellersprite: effectiveSsExact !== null ? {
        value: effectiveSsExact,
        ...(ssLow !== null && ssHigh !== null ? { low: ssLow, high: ssHigh } : {}),
        unit: 'USD',
        match_type: 'exact',
        strategy: ssStrategy,
        ...(q.ss_channel ? { channel: q.ss_channel } : {}),
        evidence,
      } : null,
      sif: sifFixed !== null ? {
        value: sifFixed,
        ...(sifFixedLow !== null && sifFixedHigh !== null ? { low: sifFixedLow, high: sifFixedHigh } : {}),
        unit: 'USD',
        match_type: 'exact',
        strategy: 'fixed',
        evidence,
      } : sifRaise !== null ? {
        value: null,
        cpc_raise_exact: sifRaise,
        ...(sifRaiseLow !== null && sifRaiseHigh !== null ? {
          cpc_raise_exact_low: sifRaiseLow,
          cpc_raise_exact_high: sifRaiseHigh,
        } : {}),
        unit: 'USD',
        match_type: 'exact',
        strategy: 'up_and_down',
        evidence,
      } : null,
      ...(q.unbid_after_all_tiers === true || q.all_tiers_exhausted === true ? { all_tiers_exhausted: true } : {}),
    };
    entries.push(entry);
    mainQueriesMeta.push({
      hasAnyExactBid,
      exhausted: q.unbid_after_all_tiers === true || q.all_tiers_exhausted === true,
    });
  }

  const allMainQueriesExhausted = mainQueriesMeta.length > 0 &&
    mainQueriesMeta.every(m => !m.hasAnyExactBid && m.exhausted);
  const anyContradictoryExhausted = mainQueriesMeta.some(m => m.hasAnyExactBid && m.exhausted);
  const resolvedUnbidAfterAllTiers = unbid_after_all_tiers === true || allMainQueriesExhausted || anyContradictoryExhausted;

  return {
    marketplace,
    currency,
    match_type: 'exact',
    ...(volume_period ? { volume_period } : {}),
    selection_reason,
    evidence,
    ...(entry_scope ? { entry_scope } : {}),
    ...(proxy_reason ? { proxy_reason } : {}),
    ...(resolvedUnbidAfterAllTiers ? { unbid_after_all_tiers: true } : {}),
    ...(unbid_reason ? { unbid_reason } : {}),
    entries,
    ...(opportunistic.length > 0 ? { long_tail_opportunistic_terms: opportunistic } : {}),
  };
}

/**
 * Classify SP-API getListingsRestrictions reasons so competitor brand-gating on a peer ASIN
 * is never mistaken for a category ban on a new own-brand white-label listing.
 */
export function classifySpApiRestrictionReasons(reasons = [], { target_is_own_white_label = true } = {}) {
  const msgs = (Array.isArray(reasons) ? reasons : []).map(r => String(r?.message || '')).filter(Boolean);
  const hasBrandGate = msgs.some(m => /approval to list in this brand|brand owner contribution/i.test(m));
  const hasCategoryOrProductApproval = msgs.some(m =>
    /approval to list this product|other listing limitations|toys|topical|dietary|medical|hazmat/i.test(m) &&
    !/in this brand/i.test(m),
  );
  const hardBan = msgs.some(m => /prohibited|recalled|banned|not permitted for sale/i.test(m));
  return {
    hard_category_ban: hardBan,
    has_competitor_brand_gate: hasBrandGate,
    has_category_or_product_approval_note: hasCategoryOrProductApproval,
    white_label_note: target_is_own_white_label && hasBrandGate
      ? 'SP-API 竞品 ASIN 限制含「竞品品牌锁（approval to list in this brand）」，对自有白牌新建链接不构成品牌封锁；类目准入按自有 productType 预检核实。'
      : '已按 SP-API 准入原因分类核对。',
  };
}

/**
 * Resolve Stage-1 qualitative rubric judgments (#16/#17/#20/#21) from public/listing evidence,
 * reserving physical tolerance/compliance lab checks for Stage-2 sample tags rather than blocking Stage-1 scoring.
 */
export function resolveStage1QualitativeJudgments({
  evidence = [],
  spec_verification = null,
  review_judge = null,
  rights_prescreen = null,
  market_seller_count = null,
  reference_price_usd = null,
} = {}) {
  const objectiveTags = [];

  // #16 existing_solution_fit (0..4)
  let existingSolutionFit;
  if (spec_verification?.complete_set_verified === true && Number.isInteger(spec_verification.anchor)) {
    existingSolutionFit = {
      anchor: spec_verification.anchor,
      reason: spec_verification.reason || '1688 公开规格与齐套配件覆盖核心买家任务，实物公差留待二阶段拿样核对。',
      evidence,
    };
  } else {
    existingSolutionFit = {
      anchor: null,
      reason: spec_verification?.spec_conflict_reason || '1688 报价存在规格缺件、尺寸矛盾或未入镜，待补核齐套规格后评定。',
      evidence,
    };
  }

  // #17 feasible_light_differentiation (0..1)
  let lightDiff;
  const hasSkuVerifiedReview = Array.isArray(review_judge?.review_citations) &&
    review_judge.review_citations.some(c => c?.sku_verified === true);
  if (review_judge?.status === 'supported' && hasSkuVerifiedReview && review_judge?.proposed_score === 1) {
    lightDiff = {
      anchor: 1,
      reason: review_judge.reason || '已验证子体差评痛点可通过低成本现货微改解决。',
      evidence,
    };
  } else {
    lightDiff = {
      anchor: 0,
      reason: '现成公模现货无需额外改模即可销售（或尚未发现需微改的子体差评痛点），初筛按 0/1 计入。',
      evidence,
    };
  }

  // #20 specific_design_rights (0..3)
  let specificRights;
  const sdrStatus = rights_prescreen?.specific_design_rights?.status ?? 'unknown';
  if (sdrStatus === 'proven_conflict') {
    specificRights = {
      anchor: 0,
      reason: rights_prescreen.specific_design_rights.summary || '公开专利检索命中具体外观／结构冲突，直接一票否决。',
      evidence,
    };
  } else if (sdrStatus === 'no_public_hit_observed') {
    objectiveTags.push('留存后二阶段实物细节专利复核');
    if (finite(market_seller_count) && market_seller_count >= 1 && market_seller_count <= 3 &&
      finite(reference_price_usd) && reference_price_usd >= 45) {
      objectiveTags.push('寡头高利·二阶段专利预警');
    }
    specificRights = {
      anchor: 3,
      reason: `${rights_prescreen.specific_design_rights.summary || '有界公开专利初查未见同结构冲突。'}（初筛记 3/3，留存后复核实物细节权利要求）。`,
      evidence,
    };
  } else {
    specificRights = {
      anchor: null,
      reason: rights_prescreen?.specific_design_rights?.summary || '具体款式公开专利初查尚未完成或存在待排冲突。',
      evidence,
    };
  }

  // #21 applicable_public_requirements (0..2)
  let publicReq;
  const apr = rights_prescreen?.applicable_public_requirements;
  const fws = Array.isArray(apr?.frameworks_checked) ? apr.frameworks_checked : [];
  if (apr?.status === 'proven_conflict') {
    publicReq = {
      anchor: 0,
      reason: apr.summary || '命中强制禁售或个人卖家不可行的准入限制。',
      evidence,
    };
  } else if (apr && ['no_public_hit_observed', 'needs_verification'].includes(apr.status)) {
    const nonRoutineOnly = fws.length === 0 || (fws.length === 1 && fws[0] === 'NONE_IDENTIFIED');
    if (!nonRoutineOnly) {
      for (const fw of fws) objectiveTags.push(`合规路径标签:${fw}`);
    }
    publicReq = {
      anchor: nonRoutineOnly ? 2 : 1,
      reason: nonRoutineOnly
        ? (apr.summary || '普通非带电非食品现货，初查无特殊法规认证门槛。')
        : `${apr.summary || '识别到适用常规合规路径（如 Lacey Act / 16 CFR 1262 / TSCA / 食品接触检测）且可常规办理。'}（初筛记 1/2 并挂合规标签）。`,
      evidence,
    };
  } else {
    publicReq = {
      anchor: null,
      reason: '尚未完成适用公共法规与类目准入路径初查。',
      evidence,
    };
  }

  return {
    judgments: {
      existing_solution_fit: existingSolutionFit,
      feasible_light_differentiation: lightDiff,
      specific_design_rights: specificRights,
      applicable_public_requirements: publicReq,
    },
    objective_tags: [...new Set(objectiveTags)],
  };
}

/**
 * Build paired 2027 `off_peak` ([2..9]) + companion `peak` ([10..12]) operating periods from verified off-peak ledgers:
 *  - Keeps `expected_primary_scenarios` strictly period-scoped (NEVER placed on root `economics` where off-peak IDs would break `peak`!).
 *  - Sets peak storage to verified 2027 Oct–Dec rate ($2.40/cu ft Standard or $1.40/cu ft Bulky).
 *  - Marks peak fulfillment `pending` with `fee_basis: { status: 'unavailable', version: 'Unpublished 2027 US Holiday Peak FBA fulfillment schedule' }`
 *    so `isValidCompanionPeakPanelR58` passes cleanly without fabricating unpublished late-2027 holiday fulfillment fees.
 *  - Enforces strict uniqueness on `stress_scenarios[].id`.
 */
export function buildPairedSeasonalOperatingPeriods({
  saleable_unit,
  off_peak_scenarios,
  declared_off_peak_scenario_ids = null,
  required_quote_ids = null,
  required_prices_usd = null,
  strict_declared_completeness = true,
  cubic_feet_per_unit,
  average_inventory_days = 45,
  size_tier = 'large_standard',
  storage_evidence = [],
  stress_scenarios = undefined,
} = {}) {
  if (!nonemptyStr(saleable_unit)) throw new TypeError('saleable_unit is required.');
  if (!Array.isArray(off_peak_scenarios) || off_peak_scenarios.length === 0) {
    throw new TypeError('off_peak_scenarios must be a nonempty array.');
  }
  if (!finite(cubic_feet_per_unit) || cubic_feet_per_unit <= 0) {
    throw new TypeError('cubic_feet_per_unit must be a positive finite number.');
  }

  if (Array.isArray(stress_scenarios)) {
    const seenStress = new Set();
    for (const st of stress_scenarios) {
      if (!nonemptyStr(st?.id)) throw new TypeError('Every stress_scenarios entry requires a nonempty id.');
      const sid = st.id.trim();
      if (seenStress.has(sid)) {
        throw new TypeError(`Duplicate stress_scenarios id "${sid}" is prohibited.`);
      }
      seenStress.add(sid);
    }
  }

  const isBulky = /bulky/i.test(String(size_tier || ''));
  const peakStorageRate = isBulky ? 1.40 : 2.40;
  const peakStorageUsd = Number((cubic_feet_per_unit * peakStorageRate * (average_inventory_days / 30)).toFixed(6));

  const normalizedOffPeak = off_peak_scenarios.map(sc => {
    const clone = structuredClone(sc);
    clone.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
    clone.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    if (!clone.cost_ledger.fee_context.inbound || clone.cost_ledger.fee_context.inbound.from < '2027-01-15') {
      clone.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-02-01' };
    }
    return clone;
  });

  const suppliedOffPeakIds = new Set(normalizedOffPeak.map(s => String(s?.id || '').trim()).filter(Boolean));
  let offPeakExpectedPrimary;
  if (Array.isArray(declared_off_peak_scenario_ids) && declared_off_peak_scenario_ids.length > 0) {
    offPeakExpectedPrimary = declared_off_peak_scenario_ids.map(item =>
      typeof item === 'string' ? { id: item.trim(), status: 'active' } : structuredClone(item),
    );
    const missingDeclared = offPeakExpectedPrimary
      .filter(exp => exp?.status !== 'cancelled' && nonemptyStr(exp?.id) && !suppliedOffPeakIds.has(exp.id.trim()))
      .map(exp => exp.id.trim());
    if (strict_declared_completeness && missingDeclared.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted active declared off-peak scenario(s) [${missingDeclared.join(', ')}].`,
      );
    }
  } else {
    offPeakExpectedPrimary = normalizedOffPeak.map(s => ({ id: s.id, status: 'active' }));
  }

  const resolveScenarioPriceForMatrix = sc => {
    const ledger = sc?.cost_ledger ?? {};
    const eff = resolveEffectivePricing(ledger);
    if (eff.valid && finite(eff.net_effective_price_usd)) return round2(eff.net_effective_price_usd);
    if (finite(ledger.price_usd)) return round2(ledger.price_usd);
    if (finite(sc?.price_anchor?.value)) return round2(sc.price_anchor.value);
    return null;
  };

  const implicitQuotesInScenarios = [...new Set(
    normalizedOffPeak
      .map(s => s?.quote_id ?? s?.cost_ledger?.source_inputs?.quote_id ?? null)
      .filter(nonemptyStr)
      .map(q => q.trim()),
  )];
  const normReqQuotes = Array.isArray(required_quote_ids) && required_quote_ids.length > 0
    ? [...new Set(required_quote_ids.filter(nonemptyStr).map(q => q.trim()))]
    : implicitQuotesInScenarios;

  const explicitReqPrices = Array.isArray(required_prices_usd)
    ? [...new Set(required_prices_usd.filter(finite).map(round2))]
    : [];
  const observedOffPeakPrices = [...new Set(normalizedOffPeak.map(resolveScenarioPriceForMatrix).filter(finite))];
  if (strict_declared_completeness && explicitReqPrices.length > 0) {
    const missingPrices = explicitReqPrices.filter(rp => !observedOffPeakPrices.some(op => Math.abs(op - rp) <= 0.02));
    if (missingPrices.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted declared Gate 1A off-peak price(s) [${missingPrices.map(p => `$${p.toFixed(2)}`).join(', ')}].`,
      );
    }
  }

  if (normReqQuotes.length > 1) {
    const missingQuotes = normReqQuotes.filter(qid => !implicitQuotesInScenarios.includes(qid));
    if (missingQuotes.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted required Gate 1B quote_id(s) [${missingQuotes.join(', ')}] in off_peak_scenarios.`,
      );
    }
    // Enforce full Cartesian product (price / base_scenario_id × quote_id) so a diagonal 2-cell submission cannot hide a losing (price × factory) cell!
    const distinctPrices = [...new Set([...explicitReqPrices, ...observedOffPeakPrices])];
    const presentPriceQuoteCells = new Set();
    for (const s of normalizedOffPeak) {
      const qid = (s?.quote_id ?? s?.cost_ledger?.source_inputs?.quote_id ?? '').trim();
      const pr = resolveScenarioPriceForMatrix(s);
      if (!qid) {
        throw new TypeError(
          `buildPairedSeasonalOperatingPeriods scenario "${s?.id ?? 'unknown'}" must specify an explicit quote_id when multiple quotes (${normReqQuotes.join(', ')}) participate.`,
        );
      }
      if (pr !== null) presentPriceQuoteCells.add(`${pr.toFixed(2)}::${qid}`);
    }
    const missingCells = [];
    for (const pr of distinctPrices) {
      for (const qid of normReqQuotes) {
        if (!presentPriceQuoteCells.has(`${pr.toFixed(2)}::${qid}`)) {
          missingCells.push(`$${pr.toFixed(2)}×${qid}`);
        }
      }
    }
    if (strict_declared_completeness && missingCells.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted Cartesian (price × quote_id) cell(s) [${missingCells.join(', ')}]; diagonal subset submissions are prohibited.`,
      );
    }
  }

  const peakScenarios = normalizedOffPeak.map(offSc => {
    const pk = structuredClone(offSc);
    delete pk.margin;
    delete pk.contribution_usd;
    const pkId = `${offSc.id}-peak`;
    pk.id = pkId;
    pk.label = `${offSc.label ?? offSc.id}（10–12月旺季伴随面板）`;
    pk.cost_ledger.id = pkId;
    pk.cost_ledger.fee_context.sales = { from: '2027-10-01', through: '2027-12-31' };
    pk.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
    pk.cost_ledger.fee_context.inbound = { from: '2027-09-01', through: '2027-10-01' };

    const fulLine = pk.cost_ledger.lines.find(l => l?.id === 'fulfillment');
    if (fulLine) {
      fulLine.status = 'pending';
      fulLine.amount_usd = null;
      fulLine.basis = 'Amazon 2027 US Holiday Peak FBA fulfillment schedule not yet published; held pending per seasonal companion rule.';
      fulLine.fee_basis = {
        status: 'unavailable',
        version: 'Unpublished 2027 US Holiday Peak FBA fulfillment schedule',
        marketplace: 'US',
        currency: 'USD',
        package_ref: pk.cost_ledger.fee_context.package_ref,
        year: 2027,
        months: [10, 11, 12],
      };
    }

    const storLine = pk.cost_ledger.lines.find(l => l?.id === 'storage');
    if (storLine) {
      storLine.status = 'sourced';
      storLine.amount_usd = peakStorageUsd;
      storLine.basis = `2027 Oct–Dec unified peak storage $${peakStorageRate.toFixed(2)}/cu ft (${cubic_feet_per_unit.toFixed(4)} cu ft × ${average_inventory_days}d/30)`;
      if (Array.isArray(storage_evidence) && storage_evidence.length > 0) {
        storLine.evidence = storage_evidence;
      }
      if (storLine.fee_basis && typeof storLine.fee_basis === 'object') {
        storLine.fee_basis = {
          ...storLine.fee_basis,
          status: 'published',
          effective_from: '2027-02-01',
          effective_through: '2027-12-31',
          months: [10, 11, 12],
        };
      }
    }

    const colLine = pk.cost_ledger.lines.find(l => l?.id === 'collection');
    if (colLine) {
      colLine.status = 'pending';
      colLine.amount_usd = null;
      colLine.basis = 'Collection fee depends on Amazon payout after 2027 holiday peak fulfillment deduction; held pending alongside fulfillment.';
    }

    return pk;
  });

  const peakExpectedPrimary = offPeakExpectedPrimary.map(exp => ({
    ...exp,
    id: `${exp.id}-peak`,
  }));

  return {
    saleable_unit,
    ...(Array.isArray(stress_scenarios) && stress_scenarios.length > 0 ? { stress_scenarios } : {}),
    operating_periods: [
      {
        id: 'off_peak',
        label: '2027年2–9月主营淡季',
        months: [2, 3, 4, 5, 6, 7, 8, 9],
        expected_primary_scenarios: offPeakExpectedPrimary,
        scenarios: normalizedOffPeak,
      },
      {
        id: 'peak',
        label: '2027年10–12月假日旺季',
        months: [10, 11, 12],
        expected_primary_scenarios: peakExpectedPrimary,
        scenarios: peakScenarios,
      },
    ],
  };
}

function extractQuantileSupportedPricesFromPayloads(candPayloads = [], {
  asOfDate = null,
  excludedAsins = new Set(),
  targetCategoryRoots = new Set(),
  strictMatureOnly = false,
} = {}) {
  const quantilePrices = new Set();
  const mainstreamMedians = [];
  const rowFloorPrices = [];
  for (const entry of candPayloads) {
    const raw = entry?.payload ?? entry;
    if (isFailedOrEmptyRawReceipt(raw)) continue;
    const unwrapped = unwrapMcpEnvelope(raw);
    if (isFailedUnwrappedBody(unwrapped)) continue;
    const rawItems = Array.isArray(unwrapped?.items) ? unwrapped.items : null;
    if (!rawItems || rawItems.length < 2) continue;

    let items = rawItems.filter(it => {
      if (!it || typeof it !== 'object' || hasEnvelopeFailureMarkers(it)) return false;
      const a = typeof it.asin === 'string' ? it.asin.trim().toUpperCase() : '';
      return !(a && excludedAsins.has(a));
    });
    if (items.length < 2) continue;

    // Record low-end page price even on 2-row pages so 2-row ($39.99 + $289.99) bundle hijacking cannot evade median checks.
    for (const it of items) {
      const p = finite(it.price_usd) ? it.price_usd : (finite(it.price) ? it.price : null);
      if (p !== null && p > 0) rowFloorPrices.push(p);
    }

    // Never derive search-page quantiles from heterogeneous cross-category detail batches (e.g. 13-ss-asin-detail-cats.json)!
    const distinctRowCats = new Set(items.map(extractItemCategoryRoot).filter(Boolean));
    if (distinctRowCats.size > 1) {
      if (targetCategoryRoots.size > 0) {
        items = items.filter(it => {
          const c = extractItemCategoryRoot(it);
          return c && targetCategoryRoots.has(c);
        });
      } else {
        continue;
      }
    }
    const hasSalesCensus = items.some(it => finite(it?.monthlySales) || finite(it?.units_30d) || finite(it?.sales));
    if (distinctRowCats.size > 1 && !hasSalesCensus) continue;
    if (items.length < 2) continue;

    const strictModes = strictMatureOnly ? [true] : [false, true];
    for (const strictOpt of strictModes) {
      try {
        const bandRes = analyzeMainstreamPriceBand(items, {
          ...(asOfDate ? { as_of_date: asOfDate } : {}),
          strict_mature_only: strictOpt,
        });
        const hasAnyLaunchAge = items.some(it => nonemptyStr(it?.availableDate ?? it?.available_date ?? it?.launch_date) || finite(it?.age_days));
        const candidateBands = strictOpt && hasAnyLaunchAge
          ? [bandRes?.mature_regular_band]
          : [bandRes?.band, bandRes?.mature_regular_band, bandRes?.regular_band_reference];
        for (const b of candidateBands) {
          if (finite(b?.p50_usd) && b.p50_usd > 0 && items.length >= 2) {
            mainstreamMedians.push(b.p50_usd);
          }
          // Only denoised P25/P50/P75 quantiles qualify as derived band anchors — NEVER raw min_usd/max_usd outliers!
          for (const val of [b?.p25_usd, b?.p50_usd, b?.p75_usd]) {
            if (finite(val) && val > 0) quantilePrices.add(round2(val));
          }
        }
      } catch { /* ignore non-listing item arrays */ }
    }
  }
  return { quantilePrices, mainstreamMedians, rowFloorPrices };
}

const EXCLUDED_VERDICTS = new Set(['excluded_different_task', 'mismatch', 'non_comparable', 'excluded']);

function collectExcludedDifferentTaskAsins(cand) {
  const excluded = new Set();
  const addExcl = val => {
    if (nonemptyStr(val)) {
      const up = val.trim().toUpperCase();
      if (ASIN_EXACT_RE.test(up)) excluded.add(up);
    }
  };
  for (const m of cand?.newcomer_cohort?.members ?? []) {
    if (EXCLUDED_VERDICTS.has(m?.comparability_verdict)) addExcl(m?.asin);
  }
  for (const f of cand?.newcomer_cohort?.market_reference?.families ?? []) {
    if (EXCLUDED_VERDICTS.has(f?.comparability_verdict)) addExcl(f?.asin);
  }
  return excluded;
}

function collectReferencedComparableAsinsForPricing(cand, primaryScenarios = [], excludedAsins = new Set()) {
  const refs = new Set();
  const addAsin = val => {
    if (nonemptyStr(val)) {
      const up = val.trim().toUpperCase();
      if (ASIN_EXACT_RE.test(up) && !excludedAsins.has(up)) refs.add(up);
    }
  };
  // Strictly accept ONLY structured ASIN fields (NEVER free-text prose in refPrice.note or scenario.label)!
  const refPrice = cand?.screening?.reference_price_usd;
  addAsin(refPrice?.target_variant_asin);
  for (const m of cand?.newcomer_cohort?.members ?? []) {
    if (!m?.comparability_verdict || m.comparability_verdict === 'comparable') addAsin(m?.asin);
  }
  for (const f of cand?.newcomer_cohort?.market_reference?.families ?? []) {
    if (!f?.comparability_verdict || f.comparability_verdict === 'comparable') addAsin(f?.asin);
  }
  for (const sc of primaryScenarios) {
    addAsin(sc?.price_anchor?.target_variant_asin);
  }
  return refs;
}

function isCompanionHolidayPeakOnlyPeriod(p) {
  return Array.isArray(p?.months) && p.months.length > 0 && p.months.every(m => m === 10 || m === 11 || m === 12);
}

function collectPrimaryContainersForChecks(cand) {
  const econ = cand?.economics;
  if (!econ || typeof econ !== 'object') return [];
  if (Array.isArray(econ.operating_periods) && econ.operating_periods.length > 0) {
    // Identify primary vs companion holiday peak periods strictly by months (matching scoring.mjs), NEVER by p.id === 'peak'!
    const nonHolidayPeriods = econ.operating_periods.filter(p => !isCompanionHolidayPeakOnlyPeriod(p));
    const selectedPeriods = nonHolidayPeriods.length > 0 ? nonHolidayPeriods : econ.operating_periods;
    return selectedPeriods.map(p => ({
      container_id: p?.id ?? 'operating_period',
      scenarios: Array.isArray(p?.scenarios) ? p.scenarios : [],
    }));
  }
  return Array.isArray(econ.scenarios)
    ? [{ container_id: 'annual', scenarios: econ.scenarios }]
    : [];
}

function collectPrimaryScenariosForPriceCheck(cand) {
  const econ = cand?.economics;
  if (!econ || typeof econ !== 'object') return [];
  if (Array.isArray(econ.operating_periods) && econ.operating_periods.length > 0) {
    return econ.operating_periods.flatMap(p => (Array.isArray(p?.scenarios) ? p.scenarios : []));
  }
  return Array.isArray(econ.scenarios) ? econ.scenarios : [];
}

function resolveCandidateReferenceAsOfDate(cand, fallbackDate = null) {
  const observedDates = [];
  const pushIsoDate = raw => {
    if (!nonemptyStr(raw)) return;
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      observedDates.push(trimmed.slice(0, 10));
    }
  };
  pushIsoDate(fallbackDate);
  pushIsoDate(cand?.newcomer_cohort?.observation_date);
  if (Array.isArray(cand?.evidence)) {
    for (const e of cand.evidence) {
      pushIsoDate(e?.observed_at);
    }
  }
  return observedDates.length > 0 ? observedDates.sort().at(-1) : null;
}

function assertCandidateRawProvenanceAndPriceBinding(cand, candCatalog, {
  candPayloads = [],
  extraVerifiedAsins = [],
  allowSyntheticIds = false,
  effectiveRev = 58,
  fallbackAsOfDate = null,
} = {}) {
  const allCandAsins = extractAllCandidateAsins(cand);
  for (const extraAsin of extraVerifiedAsins) {
    if (nonemptyStr(extraAsin)) {
      const norm = extraAsin.trim().toUpperCase();
      if (ASIN_EXACT_RE.test(norm)) allCandAsins.add(norm);
    }
  }
  assertRawAsinProvenance([...allCandAsins], candCatalog);

  const excludedAsins = collectExcludedDifferentTaskAsins(cand);
  const refPrice = cand?.screening?.reference_price_usd;
  const refPriceScalar = finite(refPrice?.value) ? refPrice.value : null;
  const refValueRange = Array.isArray(refPrice?.value_range) &&
    refPrice.value_range.length === 2 &&
    finite(refPrice.value_range[0]) &&
    finite(refPrice.value_range[1])
    ? [refPrice.value_range[0], refPrice.value_range[1]]
    : null;
  const refAnchorBaseline = refPriceScalar ?? (refValueRange ? refValueRange[0] : null);

  if (refPrice && typeof refPrice === 'object' && nonemptyStr(refPrice.target_variant_asin) && refAnchorBaseline !== null) {
    const targetAsin = refPrice.target_variant_asin.trim().toUpperCase();
    if (!ASIN_EXACT_RE.test(targetAsin)) {
      if (!allowSyntheticIds) {
        throw new TypeError(
          `Raw ASIN provenance violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" is not a valid B0xxxxxxxx ASIN.`,
        );
      }
      return allCandAsins;
    }
    if (!allowSyntheticIds && excludedAsins.has(targetAsin)) {
      throw new TypeError(
        `Scenario price provenance violation on candidate "${cand.id}": screening.reference_price_usd.target_variant_asin "${targetAsin}" cannot reference an ASIN marked excluded_different_task / non-comparable.`,
      );
    }
    const obsRecords = candCatalog.get(targetAsin) ?? [];
    if (obsRecords.length === 0) {
      throw new TypeError(
        `Raw ASIN provenance violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" is absent from candidate's verified structured receipts.`,
      );
    }
    const observedPrices = [...new Set(obsRecords.flatMap(r => r.observed_prices_usd ?? []))];
    if (refPriceScalar !== null && (refPrice.matched_spec === true || (observedPrices.length > 0 && refPrice.allow_unobserved_derived_price !== true))) {
      const matched = observedPrices.some(p => Math.abs(p - refPriceScalar) <= 0.05);
      if (!matched) {
        throw new TypeError(
          `Raw ASIN price-binding violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" observed structured receipt price(s) [${observedPrices.map(p => `$${p.toFixed(2)}`).join(', ') || 'none'}] do not match screening.reference_price_usd.value ($${refPriceScalar}).`,
        );
      }
    }
  }

  // Enforce economics scenario selling-price provenance against candidate's verified receipts across ALL operating periods!
  // Blocks un-evidenced prices ($89.99), value_range / mega-bundle hijacking ($289.99), cross-category detail batch quantiles ($64.69),
  // free-text prose wall-mount notes ($49.99), AND excluded_different_task ASIN hijacking.
  if (!allowSyntheticIds) {
    const targetAsinNorm = nonemptyStr(refPrice?.target_variant_asin)
      ? refPrice.target_variant_asin.trim().toUpperCase()
      : null;
    const targetCategoryRoots = new Set(
      targetAsinNorm
        ? (candCatalog.get(targetAsinNorm) ?? []).map(r => r.category_root).filter(Boolean)
        : [],
    );
    const candObsDate = resolveCandidateReferenceAsOfDate(cand, fallbackAsOfDate);
    const { quantilePrices, mainstreamMedians, rowFloorPrices } = extractQuantileSupportedPricesFromPayloads(candPayloads, {
      asOfDate: candObsDate,
      excludedAsins,
      targetCategoryRoots,
      strictMatureOnly: effectiveRev >= 59,
    });
    const primaryScenarios = collectPrimaryScenariosForPriceCheck(cand);
    const rawReferencedAsins = collectReferencedComparableAsinsForPricing(cand, primaryScenarios, excludedAsins);
    const referencedComparableAsins = new Set(
      [...rawReferencedAsins].filter(a => {
        if (targetCategoryRoots.size === 0) return true;
        const aCats = (candCatalog.get(a) ?? []).map(r => r.category_root).filter(Boolean);
        return aCats.length === 0 || aCats.some(c => targetCategoryRoots.has(c));
      }),
    );
    const referencedPeerPrices = [
      ...new Set(
        [...referencedComparableAsins]
          .flatMap(a => candCatalog.get(a) ?? [])
          .flatMap(r => r.observed_prices_usd ?? []),
      ),
    ];
    const allowedScenarioPrices = [...new Set([...referencedPeerPrices, ...quantilePrices])];
    const supportedRange = Array.isArray(refPrice?.supported_price_range) &&
      refPrice.supported_price_range.length === 2 &&
      finite(refPrice.supported_price_range[0]) &&
      finite(refPrice.supported_price_range[1])
      ? [refPrice.supported_price_range[0], refPrice.supported_price_range[1]]
      : null;
    const effectiveRangeBounds = supportedRange ?? refValueRange;
    const maxMainstreamMedian = mainstreamMedians.length > 0 ? Math.max(...mainstreamMedians) : null;
    const minRowFloor = rowFloorPrices.length >= 2 ? Math.min(...rowFloorPrices) : null;

    if (refPrice?.matched_spec === true && refAnchorBaseline !== null) {
      if (maxMainstreamMedian !== null && refAnchorBaseline > maxMainstreamMedian * 2.5 + 0.05) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": reference_price_usd ($${refAnchorBaseline}) exceeds 2.5x denoised search-page median ($${round2(maxMainstreamMedian)}); split distinct sub-forms instead of adopting mega-bundle outliers.`,
        );
      }
      if (maxMainstreamMedian === null && minRowFloor !== null && refAnchorBaseline > minRowFloor * 2.5 + 0.05) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": reference_price_usd ($${refAnchorBaseline}) exceeds 2.5x observed page baseline ($${round2(minRowFloor)}); 2-row mega-bundle hijacking is prohibited.`,
        );
      }
      if (effectiveRangeBounds && effectiveRangeBounds[1] > refAnchorBaseline * 2.25 + 0.05) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": reference price upper bound ($${effectiveRangeBounds[1]}) exceeds 2.25x baseline ($${refAnchorBaseline}); split distinct sub-forms instead of pooling unrelated bundle ASINs.`,
        );
      }
    }

    for (const sc of primaryScenarios) {
      const ledger = sc?.cost_ledger ?? {};
      const eff = resolveEffectivePricing(ledger);
      const ledgerPrice = eff.valid && finite(eff.net_effective_price_usd)
        ? eff.net_effective_price_usd
        : (finite(ledger.price_usd) ? ledger.price_usd : null);
      const anchorPrice = finite(sc?.price_anchor?.value) ? sc.price_anchor.value : null;
      if (ledgerPrice !== null && anchorPrice !== null && Math.abs(ledgerPrice - anchorPrice) > 0.02) {
        throw new TypeError(
          `Scenario "${sc?.id ?? 'unknown'}" on candidate "${cand.id}" has conflicting price_anchor ($${anchorPrice}) vs cost_ledger price ($${ledgerPrice}).`,
        );
      }
      const effectiveScPrice = ledgerPrice ?? anchorPrice;
      if (effectiveScPrice === null) continue;

      if (refPrice?.matched_spec === true) {
        if (refAnchorBaseline !== null && effectiveScPrice > refAnchorBaseline * 2.25 + 0.05) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) exceeds 2.25x reference_price_usd ($${refAnchorBaseline}); cross-ASIN bundle price hijacking is prohibited.`,
          );
        }
        if (maxMainstreamMedian !== null && effectiveScPrice > maxMainstreamMedian * 2.5 + 0.05) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) exceeds 2.5x denoised search-page median ($${round2(maxMainstreamMedian)}).`,
          );
        }
        if (maxMainstreamMedian === null && minRowFloor !== null && effectiveScPrice > minRowFloor * 2.5 + 0.05) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) exceeds 2.5x observed page baseline ($${round2(minRowFloor)}).`,
          );
        }
      }

      const scenTargetAsin = nonemptyStr(sc?.price_anchor?.target_variant_asin)
        ? sc.price_anchor.target_variant_asin.trim().toUpperCase()
        : null;
      if (scenTargetAsin && excludedAsins.has(scenTargetAsin)) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" cannot anchor selling price ($${effectiveScPrice}) to ASIN "${scenTargetAsin}" marked excluded_different_task.`,
        );
      }

      // Orthogonally enforce supported_price_range EVEN when scenario target_variant_asin is set!
      if (supportedRange && (effectiveScPrice < supportedRange[0] - 0.05 || effectiveScPrice > supportedRange[1] + 0.05)) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) lies outside supported_price_range [$${supportedRange[0]}, $${supportedRange[1]}].`,
        );
      }

      if (scenTargetAsin) {
        const scenRecs = candCatalog.get(scenTargetAsin) ?? [];
        const scenCats = [...new Set(scenRecs.map(r => r.category_root).filter(Boolean))];
        if (targetCategoryRoots.size > 0 && scenCats.length > 0 && !scenCats.some(c => targetCategoryRoots.has(c))) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" target_variant_asin "${scenTargetAsin}" belongs to category [${scenCats.join(', ')}], disjoint from candidate category [${[...targetCategoryRoots].join(', ')}].`,
          );
        }
        const scenObsPrices = [...new Set(scenRecs.flatMap(r => r.observed_prices_usd ?? []))];
        if (!scenObsPrices.some(p => Math.abs(p - effectiveScPrice) <= 0.05)) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" target_variant_asin "${scenTargetAsin}" observed prices [${scenObsPrices.map(p => `$${p.toFixed(2)}`).join(', ') || 'none'}] do not match $${effectiveScPrice}.`,
          );
        }
        if (!supportedRange && refPriceScalar !== null && Math.abs(effectiveScPrice - refPriceScalar) > 0.05) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) differs from single-point screening.reference_price_usd.value ($${refPriceScalar}) without declaring supported_price_range.`,
          );
        }
      } else if (supportedRange) {
        if ((refPrice?.matched_spec === true || allowedScenarioPrices.length > 0) &&
          !allowedScenarioPrices.some(p => Math.abs(p - effectiveScPrice) <= 0.05)) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) is not backed by any referenced comparable ASIN or denoised P25/P50/P75 quantile in candidate's verified receipts.`,
          );
        }
      } else if (refPriceScalar !== null) {
        if (Math.abs(effectiveScPrice - refPriceScalar) > 0.05) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) differs from single-point screening.reference_price_usd.value ($${refPriceScalar}) without an explicit scenario price_anchor.target_variant_asin or supported_price_range.`,
          );
        }
      } else if (allowedScenarioPrices.length > 0 && !allowedScenarioPrices.some(p => Math.abs(p - effectiveScPrice) <= 0.05)) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) is not backed by candidate's verified receipts.`,
        );
      }
    }
  }
  return allCandAsins;
}

function enforceCandidateContainerMatrixAndDbParity(cand, {
  dbConstraints = null,
  effectiveRev = 58,
} = {}) {
  const containers = collectPrimaryContainersForChecks(cand);
  if (containers.length === 0) return { unverifiedUiQuoteUsed: false };

  const resolveScPrice = sc => {
    const ledger = sc?.cost_ledger ?? {};
    const eff = resolveEffectivePricing(ledger);
    if (eff.valid && finite(eff.net_effective_price_usd)) return round2(eff.net_effective_price_usd);
    if (finite(ledger.price_usd)) return round2(ledger.price_usd);
    if (finite(sc?.price_anchor?.value)) return round2(sc.price_anchor.value);
    return null;
  };

  const usableQuotes = dbConstraints?.usableQuotes ?? [];
  const usableQuotesById = new Map(usableQuotes.map(q => [q.quote_id, q]));
  const dbDeclaredPrices = dbConstraints?.declaredPricesUsd ?? [];
  const allImplicitQuotes = [...new Set(
    containers
      .flatMap(c => c.scenarios)
      .map(sc => String(sc?.quote_id ?? sc?.cost_ledger?.source_inputs?.quote_id ?? '').trim())
      .filter(Boolean),
  )];
  const requiredQuoteIds = usableQuotes.length > 0
    ? usableQuotes.map(q => q.quote_id)
    : allImplicitQuotes;

  let unverifiedUiQuoteUsed = false;

  for (const container of containers) {
    const scens = container.scenarios;
    const obsPrices = [...new Set(scens.map(resolveScPrice).filter(finite))];
    if (dbDeclaredPrices.length > 0) {
      const missingDbPrices = dbDeclaredPrices.filter(dp => !obsPrices.some(op => Math.abs(op - dp) <= 0.02));
      if (missingDbPrices.length > 0) {
        throw new TypeError(
          `Candidate "${cand.id}" (${container.container_id}) omitted SQLite Gate 1A declared price(s) [${missingDbPrices.map(p => `$${p.toFixed(2)}`).join(', ')}].`,
        );
      }
    }

    // Block sourced 1688 costs when all SQLite quotes on this spec expired, or prevent unpersisted SQLite quotes from qualifying!
    if (usableQuotes.length === 0 && dbConstraints?.dbFormPresent === true) {
      for (const sc of scens) {
        const ledger = sc?.cost_ledger ?? {};
        const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
        const procLine = lines.find(l => l?.id === 'procurement');
        const domLine = lines.find(l => l?.id === 'domestic_freight');
        const hasSourcedProc = Boolean(procLine && procLine.status !== 'pending' && finite(procLine.amount_usd));
        const hasSourcedDom = Boolean(domLine && domLine.status !== 'pending' && domLine.status !== 'deferred' && finite(domLine.amount_usd));
        if (hasSourcedProc || hasSourcedDom) {
          if ((dbConstraints.expiredQuoteIds?.length ?? 0) > 0) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" cannot score sourced 1688 cost when persisted SQLite quote(s) [${dbConstraints.expiredQuoteIds.join(', ')}] have expired as of ${dbConstraints.candAsOf}.`,
            );
          }
          if (effectiveRev >= 59) {
            unverifiedUiQuoteUsed = true;
          }
        }
      }
    }

    // Verify authoritative SQLite quote cost, FX, order_units, and r59 ui_readback parity on every primary scenario!
    if (usableQuotes.length > 0) {
      for (const sc of scens) {
        const explicitQid = String(sc?.quote_id ?? sc?.cost_ledger?.source_inputs?.quote_id ?? '').trim();
        if (explicitQid && !usableQuotesById.has(explicitQid)) {
          throw new TypeError(
            `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" references unknown or expired quote_id "${explicitQid}" not in SQLite usable quotes [${usableQuotes.map(q => q.quote_id).join(', ')}].`,
          );
        }
        if (!explicitQid && usableQuotes.length > 1) {
          throw new TypeError(
            `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" must bind quote_id when SQLite holds multiple verified quotes (${usableQuotes.map(q => q.quote_id).join(', ')}).`,
          );
        }
        const activeQuote = explicitQid ? usableQuotesById.get(explicitQid) : usableQuotes[0];
        const ledger = sc?.cost_ledger ?? {};
        const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
        const procLine = lines.find(l => l?.id === 'procurement');
        const domLine = lines.find(l => l?.id === 'domestic_freight');
        const hasSourcedProc = Boolean(procLine && procLine.status !== 'pending' && finite(procLine.amount_usd));
        const hasSourcedDom = Boolean(domLine && domLine.status !== 'pending' && domLine.status !== 'deferred' && finite(domLine.amount_usd));

        if ((hasSourcedProc || hasSourcedDom) && effectiveRev >= 59) {
          if (activeQuote.ui_readback_verified === false) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" cannot score sourced 1688 cost under Revision 59 from quote "${activeQuote.quote_id}" with incomplete ui_readback.`,
            );
          }
          if (activeQuote.ui_readback_verified !== true) {
            unverifiedUiQuoteUsed = true;
          }
        }

        const explicitLedgerFxs = [
          procLine?.fx_cny_per_usd,
          domLine?.fx_cny_per_usd,
          ledger.fx_cny_per_usd,
          ledger.source_inputs?.fx_cny_per_usd,
          ledger.source_inputs?.fx_usdcny,
        ].filter(v => finite(v) && v > 0);
        const quoteFx = (finite(activeQuote.fx_cny_per_usd) && activeQuote.fx_cny_per_usd > 0)
          ? activeQuote.fx_cny_per_usd
          : null;
        const gate1aFx = (finite(dbConstraints?.declaredFxCnyPerUsd) && dbConstraints.declaredFxCnyPerUsd > 0)
          ? dbConstraints.declaredFxCnyPerUsd
          : null;
        if ((hasSourcedProc || hasSourcedDom) && quoteFx !== null && gate1aFx !== null && Math.abs(quoteFx - gate1aFx) > 1e-4) {
          throw new TypeError(
            `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" persisted SQLite 1688 quote "${activeQuote.quote_id}" fx_cny_per_usd (${quoteFx}) conflicts with SQLite Gate 1A accepted fx_cny_per_usd (${gate1aFx}).`,
          );
        }
        const dbAuthoritativeFx = quoteFx ?? gate1aFx;
        if (dbAuthoritativeFx !== null && (hasSourcedProc || hasSourcedDom)) {
          for (const lfx of explicitLedgerFxs) {
            if (Math.abs(lfx - dbAuthoritativeFx) > 1e-4) {
              throw new TypeError(
                `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" fx_cny_per_usd (${lfx}) conflicts with persisted SQLite authoritative fx_cny_per_usd (${dbAuthoritativeFx} on quote "${activeQuote.quote_id}").`,
              );
            }
          }
        }
        const effectiveFx = dbAuthoritativeFx ?? (explicitLedgerFxs[0] ?? null);

        if (hasSourcedProc) {
          if (procLine.order_units !== undefined && procLine.order_units !== activeQuote.actual_sets) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" procurement.order_units (${procLine.order_units}) conflicts with persisted SQLite quote "${activeQuote.quote_id}" actual_sets (${activeQuote.actual_sets}).`,
            );
          }
          if (effectiveFx === null) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" requires fx_cny_per_usd to verify procurement parity against SQLite quote "${activeQuote.quote_id}".`,
            );
          }
          const expectedProcUsd = (activeQuote.goods_cny_total / activeQuote.actual_sets) / effectiveFx;
          if (Math.abs(procLine.amount_usd - expectedProcUsd) > 0.005) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" procurement ($${procLine.amount_usd}) disagrees with persisted SQLite 1688 quote "${activeQuote.quote_id}" ($${expectedProcUsd.toFixed(4)} at FX ${effectiveFx}).`,
            );
          }
        }
        if (hasSourcedDom) {
          if (domLine.order_units !== undefined && domLine.order_units !== activeQuote.actual_sets) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" domestic_freight.order_units (${domLine.order_units}) conflicts with persisted SQLite quote "${activeQuote.quote_id}" actual_sets (${activeQuote.actual_sets}).`,
            );
          }
          if (effectiveFx === null) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" requires fx_cny_per_usd to verify domestic_freight parity against SQLite quote "${activeQuote.quote_id}".`,
            );
          }
          const expectedDomUsd = (activeQuote.domestic_freight_cny_total / activeQuote.actual_sets) / effectiveFx;
          if (Math.abs(domLine.amount_usd - expectedDomUsd) > 0.005) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" domestic_freight ($${domLine.amount_usd}) disagrees with persisted SQLite 1688 quote "${activeQuote.quote_id}" ($${expectedDomUsd.toFixed(4)} at FX ${effectiveFx}).`,
            );
          }
        }
      }
    }

    // Enforce full (price × quote_id) Cartesian completeness per primary container whenever >=2 quotes participate (or SQLite holds usable quotes)!
    if (requiredQuoteIds.length > 1 || (usableQuotes.length === 1 && dbDeclaredPrices.length > 0)) {
      const reqPrices = [...new Set([...dbDeclaredPrices, ...obsPrices])];
      const presentCells = new Set();
      for (const sc of scens) {
        const rawQid = String(sc?.quote_id ?? sc?.cost_ledger?.source_inputs?.quote_id ?? '').trim();
        const qid = rawQid || (requiredQuoteIds.length === 1 ? requiredQuoteIds[0] : '');
        const pr = resolveScPrice(sc);
        if (!qid) {
          throw new TypeError(
            `Candidate "${cand.id}" (${container.container_id}) scenario "${sc?.id ?? 'unknown'}" must specify an explicit quote_id when multiple quotes (${requiredQuoteIds.join(', ')}) participate.`,
          );
        }
        if (pr !== null) presentCells.add(`${pr.toFixed(2)}::${qid}`);
      }
      const missingCells = [];
      for (const pr of reqPrices) {
        for (const qid of requiredQuoteIds) {
          if (!presentCells.has(`${pr.toFixed(2)}::${qid}`)) {
            missingCells.push(`$${pr.toFixed(2)}×${qid}`);
          }
        }
      }
      if (missingCells.length > 0) {
        throw new TypeError(
          `Candidate "${cand.id}" (${container.container_id}) omitted Cartesian (price × quote_id) cell(s) [${missingCells.join(', ')}]; diagonal subset submissions are prohibited.`,
        );
      }
    }
  }

  return { unverifiedUiQuoteUsed };
}

/**
 * Ingest a structured trial specification + raw receipt files into a provenance-verified batch JSON.
 */
export function ingestTrialSpecification(spec, profile, {
  baseDir = process.cwd(),
  allowSyntheticWithoutReceipts = false,
  ledgerDbPath = null,
} = {}) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Trial specification object is required.');
  const {
    raw_receipt_files: rawFilesField,
    expected_raw_sha256s: expectedRawSha256sField,
    ledger_db_path: specLedgerDbField,
    ...specBodyRaw
  } = spec;
  const sanitizedSpecCandidates = Array.isArray(specBodyRaw.candidates)
    ? specBodyRaw.candidates.map(entry => {
        if (!entry || typeof entry !== 'object') return entry;
        const { raw_receipt_files: _crf, ...restEntry } = entry;
        return restEntry;
      })
    : specBodyRaw.candidates;
  const specBody = { ...specBodyRaw, candidates: sanitizedSpecCandidates };
  assertNoRawPii(specBody, 'ingest_trial_spec');
  if (containsSecretToken(specBody)) {
    throw new TypeError('ingest_trial_spec contains a secret or token; redact before ingesting.');
  }

  const effectiveRev = spec.profile_revision ?? profile?.revision ?? 58;
  const allowSynthetic = allowSyntheticWithoutReceipts === true || spec.allow_synthetic_without_receipts === true;
  const rawFiles = Array.isArray(rawFilesField) ? rawFilesField : [];
  if (!allowSynthetic && rawFiles.length === 0) {
    throw new TypeError(
      'ingestTrialSpecification requires a nonempty raw_receipt_files array (or explicit allow_synthetic_without_receipts: true for synthetic fixtures).',
    );
  }

  const verifiedReceiptSha256s = {};
  const rawPayloadByResolvedPath = new Map();
  const rawPayloads = rawFiles.map(fp => {
    const absPath = resolve(baseDir, String(fp));
    const rawBytes = readFileSync(absPath);
    const rawFileSha = sha256Hex(rawBytes);
    const parsedPayload = JSON.parse(rawBytes.toString('utf8'));
    const canonicalSha = sha256Hex(canonicalJson(parsedPayload));
    if (expectedRawSha256sField && typeof expectedRawSha256sField === 'object') {
      const expSha = expectedRawSha256sField[String(fp)] ?? null;
      if (!nonemptyStr(expSha)) {
        throw new TypeError(`expected_raw_sha256s is missing required SHA-256 entry for receipt "${fp}".`);
      }
      const normExp = expSha.trim().toLowerCase();
      if (normExp !== rawFileSha && normExp !== canonicalSha) {
        throw new TypeError(
          `Raw receipt SHA-256 mismatch for "${fp}": expected ${normExp}, got file=${rawFileSha} / canonical=${canonicalSha}.`,
        );
      }
    }
    verifiedReceiptSha256s[String(fp)] = {
      raw_file_sha256: rawFileSha,
      canonical_payload_sha256: canonicalSha,
    };
    const item = {
      source_id: String(fp),
      source_sha256: rawFileSha,
      canonical_payload_sha256: canonicalSha,
      payload: parsedPayload,
    };
    rawPayloadByResolvedPath.set(absPath, item);
    return item;
  });

  const resolvedLedgerDb = ledgerDbPath ?? (nonemptyStr(specLedgerDbField) ? resolve(baseDir, String(specLedgerDbField)) : null);
  const dbFormConstraintsById = new Map();
  if (resolvedLedgerDb) {
    if (!existsSync(resolvedLedgerDb)) {
      throw new TypeError(`Specified ledger_db_path does not exist: "${resolvedLedgerDb}".`);
    }
    const roStore = openSelectionStore(resolvedLedgerDb, { readOnly: true });
    try {
      if (rawPayloads.length > 0) {
        const completedRows = roStore.db.prepare(
          "SELECT payload_sha256, raw_artifact_path FROM api_request_ledger WHERE status = 'completed'",
        ).all();
        const completedHashes = new Set(completedRows.map(r => r.payload_sha256).filter(Boolean));
        for (const fp of rawFiles) {
          const absPath = resolve(baseDir, String(fp));
          const item = rawPayloadByResolvedPath.get(absPath);
          if (!completedHashes.has(item.canonical_payload_sha256) && !completedHashes.has(item.source_sha256)) {
            throw new TypeError(
              `Raw receipt "${fp}" does not match any status='completed' api_request_ledger payload_sha256 in SQLite ledger.`,
            );
          }
        }
      }
      for (const entry of Array.isArray(spec.candidates) ? spec.candidates : []) {
        const rawCand = entry?.candidate ?? entry;
        const cid = String(rawCand?.id ?? '').trim();
        if (!cid) continue;
        const dbForm = roStore.getCandidateForm(cid);
        if (!dbForm) continue;
        let declaredPricesUsd = [];
        let declaredFxCnyPerUsd = null;
        try {
          const g1a = dbForm.gate1a_result_json ? JSON.parse(dbForm.gate1a_result_json) : null;
          if (g1a && (!g1a.spec_sha256 || g1a.spec_sha256 === dbForm.spec_sha256) && g1a.proceed_to_gate1b === true) {
            if (Array.isArray(g1a.declared_scenarios)) {
              declaredPricesUsd = [...new Set(g1a.declared_scenarios.map(d => d?.price_usd).filter(finite).map(round2))];
            }
            const g1aFxs = [
              ...(Array.isArray(g1a.declared_scenarios) ? g1a.declared_scenarios.map(d => d?.fx_cny_per_usd) : []),
              ...(Array.isArray(g1a.scenarios) ? g1a.scenarios.map(s => s?.estimate?.fx_cny_per_usd) : []),
            ].filter(v => finite(v) && v > 0);
            if (g1aFxs.length > 0) declaredFxCnyPerUsd = g1aFxs[0];
          }
        } catch { /* ignore malformed json */ }
        const candAsOf = resolveCandidateReferenceAsOfDate(rawCand, entry?.as_of_date ?? spec.as_of_date ?? null) ??
          new Date().toISOString().slice(0, 10);
        const allVerifiedQuotesForSpec = roStore.getQuotesForForm(cid)
          .filter(q => q.quote_status === 'verified' && q.spec_version === dbForm.spec_version);
        const usableQuotes = allVerifiedQuotesForSpec
          .filter(q => !q.expires_at || String(q.expires_at).slice(0, 10) >= candAsOf);
        const expiredQuoteIds = allVerifiedQuotesForSpec
          .filter(q => q.expires_at && String(q.expires_at).slice(0, 10) < candAsOf)
          .map(q => q.quote_id);
        dbFormConstraintsById.set(cid, {
          dbFormPresent: true,
          candAsOf,
          declaredPricesUsd,
          declaredFxCnyPerUsd,
          usableQuotes,
          verifiedQuoteIds: usableQuotes.map(q => q.quote_id),
          expiredQuoteIds,
        });
      }
    } finally {
      roStore.close();
    }
  }

  const globalCatalog = extractVerifiedAsinCatalogFromRawPayloads(rawPayloads);
  const perCandidateVerifiedAsinCounts = {};
  const unverifiedUiQuoteCandidateIds = new Set();
  const rawCandidateEntries = Array.isArray(spec.candidates) ? spec.candidates : [];

  const builtCandidates = rawCandidateEntries.map((entry, idx) => {
    const cand = structuredClone(entry.candidate ?? entry);
    if (!nonemptyStr(cand?.id)) throw new TypeError(`Candidate #${idx + 1} requires a nonempty id.`);

    if (entry.qualitative_inputs) {
      const qual = resolveStage1QualitativeJudgments(entry.qualitative_inputs);
      cand.judgments = { ...(cand.judgments ?? {}), ...qual.judgments };
      if (qual.objective_tags.length > 0) {
        cand.presentation = {
          ...(cand.presentation ?? {}),
          risks: [...(cand.presentation?.risks ?? []), ...qual.objective_tags],
        };
      }
    }

    if (entry.bid_plan_inputs) {
      cand.bids = extractSifThreeTierBidPlan(entry.bid_plan_inputs);
    }

    const dbConstraints = dbFormConstraintsById.get(cand.id) ?? null;
    if (entry.paired_seasonal) {
      const mergedReqQuotes = [
        ...(Array.isArray(entry.paired_seasonal.required_quote_ids) ? entry.paired_seasonal.required_quote_ids : []),
        ...((dbConstraints?.verifiedQuoteIds?.length ?? 0) > 1 ? dbConstraints.verifiedQuoteIds : []),
      ];
      const mergedReqPrices = [
        ...(Array.isArray(entry.paired_seasonal.required_prices_usd) ? entry.paired_seasonal.required_prices_usd : []),
        ...(dbConstraints?.declaredPricesUsd ?? []),
      ];
      cand.economics = buildPairedSeasonalOperatingPeriods({
        ...entry.paired_seasonal,
        ...(mergedReqQuotes.length > 0 ? { required_quote_ids: mergedReqQuotes } : {}),
        ...(mergedReqPrices.length > 0 ? { required_prices_usd: mergedReqPrices } : {}),
      });
    }

    const parityCheck = enforceCandidateContainerMatrixAndDbParity(cand, {
      dbConstraints,
      effectiveRev,
    });
    if (parityCheck.unverifiedUiQuoteUsed) {
      unverifiedUiQuoteCandidateIds.add(cand.id);
    }

    if (rawPayloads.length > 0) {
      let candPayloads = rawPayloads;
      if (Array.isArray(entry.raw_receipt_files) && entry.raw_receipt_files.length > 0) {
        candPayloads = entry.raw_receipt_files.map(fp => {
          const absPath = resolve(baseDir, String(fp));
          const found = rawPayloadByResolvedPath.get(absPath);
          if (!found) {
            throw new TypeError(
              `Candidate "${cand.id}" references raw_receipt_files entry "${fp}" that is not declared in top-level raw_receipt_files.`,
            );
          }
          return found;
        });
      } else if (!allowSynthetic && rawCandidateEntries.length > 1) {
        throw new TypeError(
          `Multi-candidate ingestTrialSpecification requires per-candidate raw_receipt_files on "${cand.id}" to prevent cross-product ASIN substitution.`,
        );
      }
      const candCatalog = candPayloads === rawPayloads
        ? globalCatalog
        : extractVerifiedAsinCatalogFromRawPayloads(candPayloads);
      const candAsins = assertCandidateRawProvenanceAndPriceBinding(cand, candCatalog, {
        candPayloads,
        extraVerifiedAsins: entry.verified_asins ?? [],
        allowSyntheticIds: allowSynthetic,
        effectiveRev,
        fallbackAsOfDate: entry?.as_of_date ?? spec.as_of_date ?? null,
      });
      if (effectiveRev >= 59) {
        const candLeafNodeIds = new Set();
        const rawRelBsr = String(cand?.newcomer_cohort?.relevant_bsr_node ?? '').trim();
        for (const m of rawRelBsr.matchAll(/\b\d{5,15}\b/g)) candLeafNodeIds.add(m[0]);
        const rawCatLabel = String(cand?.metrics?.low_return_preference?.category ?? '');
        const leafTagMatch = rawCatLabel.match(/leaf\s+(\d{5,15})\b/i) ?? rawCatLabel.match(/\((\d{5,15})\)\s*$/);
        if (leafTagMatch) candLeafNodeIds.add(leafTagMatch[1]);

        const validDemandReceipts = [];
        let hasNoDataDemandReceipt = false;
        for (const item of candPayloads) {
          const rawP = item?.payload;
          let parsedTextObj = null;
          if (Array.isArray(rawP?.content)) {
            for (const block of rawP.content) {
              if (typeof block?.text === 'string') {
                const s = block.text.trim();
                if (s.startsWith('{') && s.endsWith('}')) {
                  try {
                    const p = JSON.parse(s);
                    if (p && typeof p === 'object' && ('ratioComparison' in p || 'ratioComparison' in (p.data ?? {}))) {
                      parsedTextObj = p.data ?? p;
                      break;
                    }
                  } catch { /* ignore */ }
                }
              }
            }
          }
          const rawData = rawP?.structuredContent?.data ?? rawP?.structuredContent ?? rawP?.data ?? parsedTextObj ?? rawP;
          const looksLikeDemand = /(?:demand|compass)/i.test(String(item?.source_id ?? '')) ||
            Boolean(rawData && typeof rawData === 'object' && ('ratioComparison' in rawData || ('goodsTrendItems' in rawData && 'popularKeywordItems' in rawData)));
          if (looksLikeDemand && isPayloadUpstreamFailure(rawP)) {
            throw new TypeError(
              `Candidate "${cand.id}" binds a failed category_demand_report receipt ("${item.source_id}"); upstream errors cannot be treated as NO_DATA fallback.`,
            );
          }
          if (looksLikeDemand && (rawP?.dataStatus === 'NO_DATA' || rawData?.dataStatus === 'NO_DATA' || rawData?.ratioComparison === null)) {
            hasNoDataDemandReceipt = true;
          }
          const unw = unwrapMcpEnvelope(rawP);
          const rc = unw?.ratioComparison;
          if (rc && typeof rc === 'object' && (finite(rc.returnRatio) || finite(rc.avgReturnRatio))) {
            const np = String(unw?.nodePath ?? unw?.categoryId ?? '').trim();
            const tailNode = np.match(/(\d{5,15})\s*$/)?.[1] ?? null;
            validDemandReceipts.push({
              source_id: item?.source_id ?? 'unknown',
              rc,
              leafNodeId: tailNode,
            });
          }
        }

        if (validDemandReceipts.length >= 1) {
          const matchingLeafReceipts = validDemandReceipts.filter(r => r.leafNodeId && candLeafNodeIds.has(r.leafNodeId));
          let expectedReturn = null;
          if (matchingLeafReceipts.length >= 1) {
            const leafVals = matchingLeafReceipts
              .map(r => resolveCategoryReturnWithFallback(r.rc, null, { preferLeafReturnRatio: true }).value)
              .filter(finite);
            if (leafVals.some(v => Math.abs(v - leafVals[0]) > 1e-6)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate ambiguity on candidate "${cand.id}": multiple bound leaf category_demand_report receipts disagree (${leafVals.join(', ')}).`,
              );
            }
            expectedReturn = leafVals[0] ?? null;
          } else if (hasNoDataDemandReceipt) {
            const hasDistinctLeafRate = validDemandReceipts.some(
              r => finite(r.rc.returnRatio) && finite(r.rc.avgReturnRatio) && Math.abs(r.rc.returnRatio - r.rc.avgReturnRatio) > 1e-6,
            );
            if (hasDistinctLeafRate && (candLeafNodeIds.size === 0 || validDemandReceipts.some(r => !r.leafNodeId))) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate check on candidate "${cand.id}": department NO_DATA fallback requires explicit candidate leaf node ID (relevant_bsr_node) and receipt nodePath to prove the valid receipt is not the candidate's own leaf.`,
              );
            }
            const deptVals = validDemandReceipts
              .map(r => resolveCategoryReturnWithFallback(null, r.rc, { preferLeafReturnRatio: true }).value)
              .filter(finite);
            if (deptVals.length === 0) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate check on candidate "${cand.id}": NO_DATA fallback receipt lacks department avgReturnRatio.`,
              );
            }
            if (deptVals.some(v => Math.abs(v - deptVals[0]) > 1e-6)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate ambiguity on candidate "${cand.id}": bound fallback category_demand_report receipts have conflicting avgReturnRatio values (${deptVals.join(', ')}).`,
              );
            }
            expectedReturn = deptVals[0];
          } else if (validDemandReceipts.length > 1) {
            throw new TypeError(
              `Revision 59 leaf-first return-rate ambiguity on candidate "${cand.id}": ${validDemandReceipts.length} category_demand_report receipts bound without matching candidate leaf node (${[...candLeafNodeIds].join(',') || 'none'}); set newcomer_cohort.relevant_bsr_node or bind only the candidate's leaf report.`,
            );
          } else {
            const only = validDemandReceipts[0];
            if (only.leafNodeId && candLeafNodeIds.size > 0 && !candLeafNodeIds.has(only.leafNodeId)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate mismatch on candidate "${cand.id}": bound category_demand_report node (${only.leafNodeId}) disagrees with candidate leaf node (${[...candLeafNodeIds].join(',')}) without a NO_DATA leaf receipt.`,
              );
            }
            expectedReturn = resolveCategoryReturnWithFallback(only.rc, null, { preferLeafReturnRatio: true }).value;
          }

          if (expectedReturn !== null) {
            const suppliedPref = cand?.metrics?.low_return_preference?.value;
            if (cand?.metrics?.low_return_preference?.applicable !== false && (!finite(suppliedPref) || Math.abs(suppliedPref - expectedReturn) > 1e-6)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate parity violation on candidate "${cand.id}": metrics.low_return_preference.value (${suppliedPref}) disagrees with bound category_demand_report (${expectedReturn}); fix low_return_preference to match resolveCategoryReturnWithFallback.`,
              );
            }
            for (const sc of collectPrimaryScenariosForPriceCheck(cand)) {
              const scRef = sc?.cost_ledger?.refund_fraction;
              if (finite(scRef) && Math.abs(scRef - expectedReturn) > 1e-6) {
                throw new TypeError(
                  `Revision 59 leaf-first return-rate parity violation on candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}": refund_fraction (${scRef}) disagrees with bound category_demand_report (${expectedReturn}).`,
                );
              }
              const scPhys = sc?.cost_ledger?.physical_return_fraction;
              if (finite(scPhys) && Math.abs(scPhys - expectedReturn) > 1e-6) {
                throw new TypeError(
                  `Revision 59 leaf-first return-rate parity violation on candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}": physical_return_fraction (${scPhys}) disagrees with bound category_demand_report (${expectedReturn}).`,
                );
              }
            }
          }
        }
      }
      perCandidateVerifiedAsinCounts[cand.id] = candAsins.size;
    } else {
      perCandidateVerifiedAsinCounts[cand.id] = 0;
    }

    return cand;
  });

  const batch = {
    schema_version: 1,
    profile_revision: spec.profile_revision ?? profile.revision,
    ...(spec.presentation ? { presentation: spec.presentation } : {}),
    ...(Array.isArray(spec.negotiation_shortlist) ? { negotiation_shortlist: spec.negotiation_shortlist } : {}),
    candidates: builtCandidates,
  };

  const scored = scoreBatch(batch, profile);
  if (effectiveRev >= 59 && unverifiedUiQuoteCandidateIds.size > 0) {
    const falselyQualifying = (scored?.candidates ?? []).filter(
      c => unverifiedUiQuoteCandidateIds.has(c?.candidate_id ?? c?.id) && c?.qualification?.counts_toward_target === true,
    );
    if (falselyQualifying.length > 0) {
      throw new TypeError(
        `Revision 59 prohibits counts_toward_target qualification from SQLite 1688 quote(s) lacking verified 5-field ui_readback on [${falselyQualifying.map(c => c.candidate_id ?? c.id).join(', ')}].`,
      );
    }
  }
  return {
    batch,
    scored,
    verified_raw_asin_count: globalCatalog.size,
    per_candidate_verified_asin_counts: perCandidateVerifiedAsinCounts,
    verified_receipt_sha256s: verifiedReceiptSha256s,
  };
}
