/**
 * SellerSprite adapter: raw ASIN catalog/provenance, leaf-first return & parent demand extraction,
 * monthly archive macro market normalization, niche star reference, and Q31 dual-source keyword counts.
 */
import { BUSINESS_THRESHOLDS } from '../business-thresholds.mjs';
import {
  deduplicateParentSalesRows,
  extractNewcomerReviewOriginBreakdown,
  resolveCategoryReturnWithFallback,
} from '../observations.mjs';
import { parseSingleUnitUsdCoupon } from '../price-band.mjs';
import {
  hasEnvelopeFailureMarkers,
  hasUpstreamErrorMarkers,
  isFailedOrEmptyRawReceipt,
  isFailedUnwrappedBody,
  isPayloadUpstreamFailure,
  unwrapMcpEnvelope,
} from './mcp-envelope.mjs';

export const ASIN_EXACT_RE = /^B0[A-Z0-9]{8}$/;
export const ASIN_TOKEN_RE = /\bB0[A-Z0-9]{8}\b/g;
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


export function extractItemCategoryRoot(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (nonemptyStr(obj.categoryId)) return obj.categoryId.trim().toLowerCase();
  if (Array.isArray(obj.categoryPath) && nonemptyStr(obj.categoryPath[0])) {
    return obj.categoryPath[0].trim().toLowerCase();
  }
  if (nonemptyStr(obj.rootCategory)) return obj.rootCategory.trim().toLowerCase();
  return null;
}

export function extractStructuredPricesFromObject(obj) {
  // Never treat SP-API productFees request/estimate echo structures as observed market selling prices.
  if (obj && typeof obj === 'object' && (
    obj.PriceToEstimateFees !== undefined ||
    obj.FeesEstimateIdentifier !== undefined ||
    obj.FeesEstimate !== undefined ||
    obj.FeesEstimateResult !== undefined
  )) {
    return {
      observed_prices_usd: [],
      net_prices_usd: [],
      list_prices_usd: [],
      verified_regular_prices_usd: [],
      has_keepa_series: false,
    };
  }
  const netPrices = new Set();
  const listPrices = new Set();
  const verifiedRegularPrices = new Set();
  const addTo = (setObj, p) => {
    if (finite(p) && p > 0) setObj.add(round2(p));
  };

  if (finite(obj?.list_price_usd) && obj.list_price_usd > 0) {
    addTo(listPrices, obj.list_price_usd);
  }

  const baseListPrice = finite(obj?.list_price_usd) && obj.list_price_usd > 0
    ? obj.list_price_usd
    : (finite(obj?.price_usd) && obj.price_usd > 0
      ? obj.price_usd
      : (finite(obj?.price) && obj.price > 0
        ? obj.price
        : (finite(obj?.buyboxPrice) && obj.buyboxPrice > 0 ? obj.buyboxPrice : null)));

  let discountedNetFromRow = null;
  const explicitNet = finite(obj?.net_effective_price_usd) && obj.net_effective_price_usd > 0
    ? obj.net_effective_price_usd
    : (finite(obj?.net_price_usd) && obj.net_price_usd > 0 ? obj.net_price_usd : null);
  if (explicitNet !== null) {
    discountedNetFromRow = explicitNet;
  } else if (finite(obj?.promo_price_usd) && obj.promo_price_usd > 0 && (baseListPrice === null || obj.promo_price_usd < baseListPrice)) {
    discountedNetFromRow = obj.promo_price_usd;
  } else if (baseListPrice !== null) {
    let couponDiscUsd = 0;
    let primeDiscUsd = 0;
    const hasExplicitCouponUsd = (finite(obj?.ongoing_coupon_usd) && obj.ongoing_coupon_usd > 0) ||
      (finite(obj?.coupon_usd) && obj.coupon_usd > 0);
    const hasExplicitCouponPct = (finite(obj?.ongoing_coupon_pct) && obj.ongoing_coupon_pct > 0 && obj.ongoing_coupon_pct < 1) ||
      (finite(obj?.coupon_pct) && obj.coupon_pct > 0 && obj.coupon_pct < 1);
    if (finite(obj?.ongoing_coupon_usd) && obj.ongoing_coupon_usd > 0) couponDiscUsd += obj.ongoing_coupon_usd;
    else if (finite(obj?.coupon_usd) && obj.coupon_usd > 0) couponDiscUsd += obj.coupon_usd;
    if (finite(obj?.ongoing_coupon_pct) && obj.ongoing_coupon_pct > 0 && obj.ongoing_coupon_pct < 1) {
      couponDiscUsd += baseListPrice * obj.ongoing_coupon_pct;
    } else if (finite(obj?.coupon_pct) && obj.coupon_pct > 0 && obj.coupon_pct < 1) {
      couponDiscUsd += baseListPrice * obj.coupon_pct;
    } else if (!hasExplicitCouponUsd && !hasExplicitCouponPct && obj?.coupon !== undefined && obj?.coupon !== null) {
      const parsedCoupon = parseSingleUnitUsdCoupon(obj.coupon);
      if (parsedCoupon.type === 'pct') {
        couponDiscUsd += baseListPrice * parsedCoupon.pct;
      } else if (parsedCoupon.type === 'usd') {
        couponDiscUsd += parsedCoupon.usd;
      }
    }
    if (finite(obj?.prime_exclusive_discount_usd) && obj.prime_exclusive_discount_usd > 0) {
      primeDiscUsd += obj.prime_exclusive_discount_usd;
    }
    if (finite(obj?.prime_exclusive_discount_pct) && obj.prime_exclusive_discount_pct > 0 && obj.prime_exclusive_discount_pct < 1) {
      primeDiscUsd += baseListPrice * obj.prime_exclusive_discount_pct;
    }
    const totalDiscUsd = couponDiscUsd + primeDiscUsd;
    if (totalDiscUsd > 0 && totalDiscUsd < baseListPrice) {
      discountedNetFromRow = round2(baseListPrice - totalDiscUsd);
    }
  }

  const hasActiveDiscount = Boolean(
    discountedNetFromRow !== null &&
    baseListPrice !== null &&
    round2(baseListPrice) > round2(discountedNetFromRow),
  );

  if (discountedNetFromRow !== null) {
    addTo(netPrices, discountedNetFromRow);
    if (baseListPrice !== null && round2(baseListPrice) > round2(discountedNetFromRow)) {
      // Pre-coupon / pre-promo list price is recorded strictly as list_price_usd, NEVER as realized net price!
      addTo(listPrices, baseListPrice);
    }
  } else {
    for (const key of ['price', 'price_usd', 'buyboxPrice', 'salePrice']) {
      addTo(netPrices, obj?.[key]);
    }
    if (netPrices.size === 0 && finite(obj?.list_price_usd) && obj.list_price_usd > 0) {
      addTo(netPrices, obj.list_price_usd);
    }
  }
  if (finite(obj?.salePrice) && obj.salePrice > 0) {
    addTo(netPrices, obj.salePrice);
  }

  // Independent verified historical regular prices
  if (
    finite(obj?.keepa_90d_median_usd) &&
    obj.keepa_90d_median_usd > 0 &&
    obj?.keepa_90d_steady === true &&
    obj?.keepa_price_steady !== false
  ) {
    addTo(verifiedRegularPrices, obj.keepa_90d_median_usd);
  }
  if (finite(obj?.historical_regular_price_usd) && obj.historical_regular_price_usd > 0) {
    addTo(verifiedRegularPrices, obj.historical_regular_price_usd);
  }

  // SP-API competitive pricing summary structures (do NOT treat PriceToEstimateFees input query price as observed market price)
  let hasCompetitiveSummarySnapshot = false;
  for (const lp of obj?.Summary?.LowestPrices ?? []) {
    hasCompetitiveSummarySnapshot = true;
    addTo(netPrices, lp?.LandedPrice?.Amount);
    addTo(listPrices, lp?.ListingPrice?.Amount);
    if (!finite(lp?.LandedPrice?.Amount)) addTo(netPrices, lp?.ListingPrice?.Amount);
  }
  for (const bp of obj?.Summary?.BuyBoxPrices ?? []) {
    hasCompetitiveSummarySnapshot = true;
    addTo(netPrices, bp?.LandedPrice?.Amount);
    addTo(listPrices, bp?.ListingPrice?.Amount);
    if (!finite(bp?.LandedPrice?.Amount)) addTo(netPrices, bp?.ListingPrice?.Amount);
  }

  // Keepa / SellerSprite historical transaction price arrays:
  // - Undated arrays (e.g. 1-point `buybox: [40]` snapshot without `ts`) NEVER certify historical regular prices!
  // - Dated curves check aligned coupon arrays so pre-coupon prices on couponed days go to `listPrices` + net to `netPrices`.
  let hasKeepaSeries = false;
  let hasKeepaActiveDiscount = false;
  const datedKeepaPoints = [];
  const normalizeTsElem = raw => {
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.trim())) return raw.trim().slice(0, 10);
    if (finite(raw) && raw > 0) {
      let ms = null;
      if (raw >= 1e12 && raw <= 4e12) ms = raw;
      else if (raw >= 1e9 && raw <= 4e9) ms = raw * 1000;
      else if (raw >= 5e6 && raw <= 2.5e7) ms = (raw + 21564000) * 60000;
      if (ms !== null) return new Date(ms).toISOString().slice(0, 10);
    }
    return null;
  };
  const extractAlignedCouponAtIndex = (seriesContainer, idx, basePrice) => {
    if (!seriesContainer || typeof seriesContainer !== 'object' || !finite(basePrice) || basePrice <= 0) return 0;
    let bestDiscUsd = 0;
    for (const ck of ['coupon', 'couponHistory', 'oneTimeCouponHistory', 'subscribeAndSaveCouponHistory']) {
      const arr = seriesContainer[ck];
      if (!Array.isArray(arr) || idx >= arr.length) continue;
      const tok = arr[idx];
      if (tok === null || tok === undefined || tok === '' || tok === 0 || tok === -1) continue;
      if (finite(tok)) {
        let disc = 0;
        if (tok < 0 && Math.abs(tok) < 100) disc = basePrice * (Math.abs(tok) / 100);
        else if (tok > 0 && tok < 1) disc = basePrice * tok;
        else if (tok >= 1 && tok < basePrice) disc = tok;
        if (disc > bestDiscUsd) bestDiscUsd = disc;
      } else if (typeof tok === 'string') {
        const parsed = parseSingleUnitUsdCoupon(tok);
        const disc = parsed.type === 'pct' ? basePrice * parsed.pct : (parsed.type === 'usd' ? parsed.usd : 0);
        if (disc > 0 && disc < basePrice && disc > bestDiscUsd) bestDiscUsd = disc;
      }
    }
    return bestDiscUsd;
  };
  const seriesSpecs = [
    { arr: obj?.series?.price, container: obj?.series, ts: obj?.ts ?? obj?.series?.ts },
    { arr: obj?.series?.buybox, container: obj?.series, ts: obj?.ts ?? obj?.series?.ts },
    { arr: obj?.keepa?.price, container: obj?.keepa, ts: obj?.keepa?.ts ?? obj?.ts },
    { arr: obj?.keepa?.buybox, container: obj?.keepa, ts: obj?.keepa?.ts ?? obj?.ts },
    { arr: obj?.keepa_trend?.series?.price, container: obj?.keepa_trend?.series, ts: obj?.keepa_trend?.ts ?? obj?.ts },
    { arr: obj?.keepa_trend?.series?.buybox, container: obj?.keepa_trend?.series, ts: obj?.keepa_trend?.ts ?? obj?.ts },
  ];
  for (const { arr, container, ts } of seriesSpecs) {
    if (!Array.isArray(arr)) continue;
    const normDates = Array.isArray(ts) && ts.length === arr.length ? ts.map(normalizeTsElem) : null;
    const validSortedDates = normDates ? [...new Set(normDates.filter(Boolean))].sort() : [];
    const isDatedCurve = validSortedDates.length >= 2;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (!finite(p) || p <= 0) continue;
      if (!isDatedCurve) {
        if (!hasActiveDiscount) addTo(netPrices, p);
        else addTo(listPrices, p);
        continue;
      }
      hasKeepaSeries = true;
      const dIso = normDates[i];
      const couponDisc = extractAlignedCouponAtIndex(container, i, p);
      if (dIso) {
        datedKeepaPoints.push({
          date: dIso,
          price_usd: round2(p),
          coupon_disc_usd: couponDisc > 0 && couponDisc < p ? round2(couponDisc) : 0,
        });
      }
      if (couponDisc > 0 && couponDisc < p) {
        hasKeepaActiveDiscount = true;
        addTo(listPrices, p);
        addTo(netPrices, round2(p - couponDisc));
      } else if (!hasActiveDiscount) {
        addTo(verifiedRegularPrices, p);
      } else {
        addTo(listPrices, p);
      }
    }
  }
  for (const listArr of [obj?.priceList, obj?.series?.priceList, obj?.keepa?.priceList, obj?.keepa_trend?.series?.priceList]) {
    if (Array.isArray(listArr)) {
      for (const p of listArr) {
        addTo(listPrices, p);
      }
    }
  }

  let ageHint = null;
  if (finite(obj?.age_days) && obj.age_days >= 0) ageHint = obj.age_days;
  else if (finite(obj?.listing_age_days) && obj.listing_age_days >= 0) ageHint = obj.listing_age_days;
  else {
    for (const k of ['available_date', 'availableDate', 'launch_date', 'launchDate', 'firstAvailableDate']) {
      const v = obj?.[k];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) {
        ageHint = v.trim().slice(0, 10);
        break;
      }
    }
  }

  const effectiveHasActiveDiscount = Boolean(hasActiveDiscount || hasKeepaActiveDiscount);
  const hasExplicitNonEmptyCouponField =
    (obj?.coupon !== undefined && obj?.coupon !== null && obj?.coupon !== '' && obj?.coupon !== 0) ||
    (finite(obj?.ongoing_coupon_usd) && obj.ongoing_coupon_usd > 0) ||
    (finite(obj?.ongoing_coupon_pct) && obj.ongoing_coupon_pct > 0) ||
    (finite(obj?.coupon_usd) && obj.coupon_usd > 0) ||
    (finite(obj?.coupon_pct) && obj.coupon_pct > 0);
  const couponBlindSnapshot = Boolean(
    !effectiveHasActiveDiscount &&
    !hasKeepaSeries &&
    verifiedRegularPrices.size === 0 &&
    !hasExplicitNonEmptyCouponField &&
    (hasCompetitiveSummarySnapshot || netPrices.size > 0),
  );

  const observedSellingPrices = new Set([...netPrices, ...verifiedRegularPrices]);
  return {
    observed_prices_usd: [...observedSellingPrices],
    net_prices_usd: [...netPrices],
    list_prices_usd: [...listPrices],
    verified_regular_prices_usd: [...verifiedRegularPrices],
    dated_keepa_points: datedKeepaPoints,
    has_keepa_series: hasKeepaSeries,
    has_active_discount: effectiveHasActiveDiscount,
    coupon_blind_snapshot: couponBlindSnapshot,
    age_hint: ageHint,
  };
}

/**
 * Reconcile price provenance across multiple structured receipts for the SAME ASIN so an undated /
 * coupon-blind Buy Box snapshot (`$40`) cannot resurrect a pre-coupon list price (`$40` list - `$13.01` coupon = `$26.99` net)
 * when no dated un-couponed regular-price curve certifies `$40` (or when the ASIN is a `<= 90d` newcomer),
 * and strictly truncate dated Keepa points to `<= asOfDate` so future prices never leak into historical evaluations.
 */
export function reconcileAsinPriceProvenance(obsRecords = [], { asOfDate = null, newcomerMaxAgeDays = 90 } = {}) {
  if (!Array.isArray(obsRecords) || obsRecords.length === 0) {
    return { observed_prices_usd: [], list_prices_usd: [], verified_regular_prices_usd: [] };
  }
  const cutoffIso = typeof asOfDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(asOfDate.trim())
    ? asOfDate.trim().slice(0, 10)
    : null;

  let isYoungNewcomer = false;
  for (const r of obsRecords) {
    const h = r?.age_hint;
    if (finite(h) && h <= newcomerMaxAgeDays) {
      isYoungNewcomer = true;
      break;
    }
    if (typeof h === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h) && cutoffIso) {
      const dLaunch = Date.parse(`${h}T00:00:00Z`);
      const dAsOf = Date.parse(`${cutoffIso}T00:00:00Z`);
      if (Number.isFinite(dLaunch) && Number.isFinite(dAsOf)) {
        const ageDays = Math.floor((dAsOf - dLaunch) / 86400000);
        if (ageDays >= 0 && ageDays <= newcomerMaxAgeDays) {
          isYoungNewcomer = true;
          break;
        }
      }
    }
  }

  const verifiedRegular = new Set();
  const discountedListPrices = new Set();
  const allListPrices = new Set();
  const keepaRealizedNets = new Set();

  for (const r of obsRecords) {
    const hasDatedPts = Array.isArray(r?.dated_keepa_points) && r.dated_keepa_points.length > 0;
    if (hasDatedPts) {
      for (const pt of r.dated_keepa_points) {
        if (!pt || !finite(pt.price_usd) || pt.price_usd <= 0) continue;
        if (cutoffIso && typeof pt.date === 'string' && pt.date > cutoffIso) continue;
        if (finite(pt.coupon_disc_usd) && pt.coupon_disc_usd > 0 && pt.coupon_disc_usd < pt.price_usd) {
          allListPrices.add(round2(pt.price_usd));
          discountedListPrices.add(round2(pt.price_usd));
          keepaRealizedNets.add(round2(pt.price_usd - pt.coupon_disc_usd));
        } else if (!isYoungNewcomer && r?.has_active_discount !== true) {
          verifiedRegular.add(round2(pt.price_usd));
        } else if (!isYoungNewcomer) {
          verifiedRegular.add(round2(pt.price_usd));
        } else {
          keepaRealizedNets.add(round2(pt.price_usd));
        }
      }
    } else if (!isYoungNewcomer) {
      for (const p of r?.verified_regular_prices_usd ?? []) {
        if (finite(p) && p > 0) verifiedRegular.add(round2(p));
      }
    }
    for (const lp of r?.list_prices_usd ?? []) {
      if (finite(lp) && lp > 0) {
        allListPrices.add(round2(lp));
        if (r?.has_active_discount === true) discountedListPrices.add(round2(lp));
      }
    }
  }

  const observed = new Set([...verifiedRegular, ...keepaRealizedNets]);
  for (const r of obsRecords) {
    const hasDatedPts = Array.isArray(r?.dated_keepa_points) && r.dated_keepa_points.length > 0;
    if (hasDatedPts) continue;
    const srcNets = Array.isArray(r?.net_prices_usd)
      ? r.net_prices_usd
      : (Array.isArray(r?.observed_prices_usd) ? r.observed_prices_usd : []);
    for (const p of srcNets) {
      if (!finite(p) || p <= 0) continue;
      const rp = round2(p);
      const matchesDiscountedList = [...discountedListPrices].some(lp => Math.abs(lp - rp) <= 0.01);
      const backedByVerifiedRegular = [...verifiedRegular].some(vp => Math.abs(vp - rp) <= 0.01);
      if (r?.coupon_blind_snapshot === true && matchesDiscountedList && !backedByVerifiedRegular) {
        allListPrices.add(rp);
        continue;
      }
      observed.add(rp);
    }
    if (isYoungNewcomer) {
      for (const vp of r?.verified_regular_prices_usd ?? []) {
        if (!finite(vp) || vp <= 0) continue;
        const rvp = round2(vp);
        const matchesDiscountedList = [...discountedListPrices].some(lp => Math.abs(lp - rvp) <= 0.01);
        if (matchesDiscountedList) {
          allListPrices.add(rvp);
        } else {
          observed.add(rvp);
        }
      }
    }
  }

  return {
    observed_prices_usd: [...observed],
    list_prices_usd: [...allListPrices],
    verified_regular_prices_usd: [...verifiedRegular],
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
              net_prices_usd: isPrimaryRowAsin ? priceInfo.net_prices_usd : [],
              list_prices_usd: isPrimaryRowAsin ? priceInfo.list_prices_usd : [],
              verified_regular_prices_usd: isPrimaryRowAsin ? priceInfo.verified_regular_prices_usd : [],
              dated_keepa_points: isPrimaryRowAsin ? priceInfo.dated_keepa_points : [],
              has_keepa_series: isPrimaryRowAsin ? priceInfo.has_keepa_series : false,
              has_active_discount: isPrimaryRowAsin ? priceInfo.has_active_discount : false,
              coupon_blind_snapshot: isPrimaryRowAsin ? priceInfo.coupon_blind_snapshot : false,
              age_hint: isPrimaryRowAsin ? priceInfo.age_hint : null,
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
                  net_prices_usd: [],
                  list_prices_usd: [],
                  verified_regular_prices_usd: [],
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

/**
 * Normalize SellerSprite latest monthly archive macro metrics (`category_report_detail` / `category_stats_list`)
 * directly into `candidate.market` under Revision 59+ (accepting monthly archive directly for macro structure).
 */
export function ingestSellerSpriteMonthlyArchiveMarket(archiveRaw, {
  evidence = [],
  report_id = 'sellersprite-monthly-archive',
  population = '卖家精灵最新月度归档类目宏观样本',
  family_basis = '卖家精灵月度归档父体/Listing 口径',
} = {}) {
  if (!archiveRaw || isPayloadUpstreamFailure(archiveRaw)) {
    throw new TypeError('Valid SellerSprite monthly archive receipt is required.');
  }
  const body = unwrapMcpEnvelope(archiveRaw);
  if (Array.isArray(body?.items) && body.items.length === 0 && !body?.stat && !body?.detail) {
    throw new TypeError('SellerSprite monthly archive items[] is empty; required category record is missing.');
  }
  const row = Array.isArray(body?.items) ? body.items[0] : (body?.stat ?? body?.detail ?? body);
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('SellerSprite monthly archive payload contains no structured category record.');
  }
  const normFrac = v => {
    if (!finite(v) || v < 0) return null;
    return v > 1 ? Number((v / 100).toFixed(6)) : Number(v.toFixed(6));
  };
  const rawMonth = String(row.dataMonth ?? row.month ?? body?.dataMonth ?? '').trim();
  const archiveMonth = /^\d{6}$/.test(rawMonth)
    ? `${rawMonth.slice(0, 4)}-${rawMonth.slice(4, 6)}`
    : (nonemptyStr(rawMonth) ? rawMonth : null);

  const countShare = normFrac(row.newProductRatio ?? row.newProductsRatio ?? row.newcomer_count_share);
  const salesShare = normFrac(row.newProductSalesRatio ?? row.newProductsSalesRatio ?? row.newcomer_sales_share);
  const prodConc = normFrac(row.commodityConcentration ?? row.top10ProductSalesRatio ?? row.product_concentration_top10);
  const brandConc = normFrac(row.brandConcentration ?? row.top10BrandSalesRatio ?? row.brand_concentration_top10);
  const sellerConc = normFrac(row.sellerConcentration ?? row.top10SellerSalesRatio ?? row.seller_concentration_top10);
  const amzSalesShare = normFrac(row.amzSalesRatio ?? row.amzUnitRatio ?? row.amz_sales_share ?? body?.stat?.amzSalesRatio);
  const rawSellerCount = row.sellers ?? row.sellerCount ?? row.seller_count ?? body?.stat?.sellers;
  const sellerCount = finite(rawSellerCount) && rawSellerCount >= 0 ? Math.round(rawSellerCount) : null;

  let top10MedianReviews = finite(row.top10_median_reviews ?? row.top10MedianReviews ?? row.medianReviews)
    ? Number(row.top10_median_reviews ?? row.top10MedianReviews ?? row.medianReviews)
    : null;
  const categoryAvgReviews = finite(row.avgReviews ?? row.average_reviews ?? row.category_avg_reviews)
    ? Number(row.avgReviews ?? row.average_reviews ?? row.category_avg_reviews)
    : null;
  const rawSampleCount = row.top10_review_sample_count ?? row.top10ReviewSampleCount ?? body?.stat?.top10_review_sample_count ?? body?.top10_review_sample_count;
  let top10ReviewSampleCount = finite(rawSampleCount)
    ? Math.round(Number(rawSampleCount))
    : null;
  if (top10MedianReviews === null && Array.isArray(body?.items) && body.items.length > 0) {
    const revNums = body.items
      .slice(0, 10)
      .map(it => it?.ratings ?? it?.reviews ?? it?.reviewCount)
      .filter(v => finite(v) && v >= 0)
      .sort((a, b) => a - b);
    if (top10ReviewSampleCount === null) top10ReviewSampleCount = revNums.length;
    if (revNums.length >= 2) {
      const mid = Math.floor(revNums.length / 2);
      top10MedianReviews = revNums.length % 2 === 1 ? revNums[mid] : (revNums[mid - 1] + revNums[mid]) / 2;
    }
  } else if (top10ReviewSampleCount === null && Array.isArray(body?.items) && body.items.length > 1) {
    const revNums = body.items
      .slice(0, 10)
      .map(it => it?.ratings ?? it?.reviews ?? it?.reviewCount)
      .filter(v => finite(v) && v >= 0);
    if (revNums.length > 0) top10ReviewSampleCount = revNums.length;
  }
  const avgStarRef = Array.isArray(body?.items) && body.items.length > 0
    ? extractNicheAverageStarReference(body.items)
    : (finite(row.avgRating ?? row.average_star_rating) && Number(row.avgRating ?? row.average_star_rating) > 0 && Number(row.avgRating ?? row.average_star_rating) <= 5
      ? Number(Number(row.avgRating ?? row.average_star_rating).toFixed(2))
      : null);

  const mkMetric = val => (val !== null ? { value: val, unit: 'fraction', evidence } : null);
  const concentrations = {};
  if (mkMetric(prodConc)) concentrations.product = mkMetric(prodConc);
  if (mkMetric(brandConc)) concentrations.brand = mkMetric(brandConc);
  if (mkMetric(sellerConc)) concentrations.seller = mkMetric(sellerConc);
  const newcomer = {};
  if (mkMetric(countShare)) newcomer.count_share = mkMetric(countShare);
  if (mkMetric(salesShare)) {
    newcomer.unit_sales_share = {
      ...mkMetric(salesShare),
      window: 'latest_monthly_archive',
    };
  }
  return {
    provider: 'sellersprite',
    report_id,
    relevant: true,
    archive_basis: 'sellersprite_latest_monthly_archive',
    ...(archiveMonth ? { period: archiveMonth, archive_month: archiveMonth } : {}),
    population,
    family_basis,
    head_group: 'top10',
    newcomer_age_months: 3,
    newcomer_sales_window: 'latest_monthly_archive',
    evidence,
    ...(Object.keys(concentrations).length > 0 ? { concentrations } : {}),
    ...(Object.keys(newcomer).length > 0 ? { newcomer } : {}),
    ...(mkMetric(countShare) ? { newcomer_count_share: mkMetric(countShare) } : {}),
    ...(mkMetric(salesShare) ? {
      newcomer_sales_share: {
        ...mkMetric(salesShare),
        window: 'latest_monthly_archive',
      },
    } : {}),
    ...(mkMetric(prodConc) ? { product_concentration_top10: mkMetric(prodConc) } : {}),
    ...(mkMetric(brandConc) ? { brand_concentration_top10: mkMetric(brandConc) } : {}),
    ...(mkMetric(sellerConc) ? { seller_concentration_top10: mkMetric(sellerConc) } : {}),
    ...(top10MedianReviews !== null ? { top10_median_reviews: top10MedianReviews } : {}),
    ...(top10ReviewSampleCount !== null ? { top10_review_sample_count: top10ReviewSampleCount } : {}),
    ...(categoryAvgReviews !== null ? { avg_reviews: categoryAvgReviews, category_avg_reviews: categoryAvgReviews } : {}),
    ...(amzSalesShare !== null ? { amz_sales_share: amzSalesShare } : {}),
    ...(sellerCount !== null ? { seller_count: sellerCount } : {}),
    ...(avgStarRef !== null ? { average_star_rating: typeof avgStarRef === 'object' ? avgStarRef.value : avgStarRef, niche_average_star_reference: avgStarRef } : {}),
  };
}

/**
 * Compute equal-weight niche average star reference (`r20`) across parent-deduplicated comparable listings (`(0, 5]`).
 */
export function extractNicheAverageStarReference(rows = [], {
  scope = '去重同款父体等权均星',
  period = null,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const flatRows = rows.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const unwrapped = unwrapMcpEnvelope(entry);
    if (Array.isArray(unwrapped?.items)) return unwrapped.items;
    if (Array.isArray(unwrapped?.list)) return unwrapped.list;
    return [unwrapped];
  });
  if (flatRows.length === 0) return null;
  const rowByAsin = new Map();
  for (const r of flatRows) {
    const a = typeof r?.asin === 'string' && r.asin.trim() ? r.asin.trim().toUpperCase() : null;
    if (a && !rowByAsin.has(a)) rowByAsin.set(a, r);
  }
  const dedupRes = deduplicateParentSalesRows(flatRows);
  const repRows = dedupRes.families.length > 0
    ? dedupRes.families.map(f => rowByAsin.get(f.representative_asin) ?? f)
    : flatRows;
  const stars = repRows
    .map(r => r?.rating ?? r?.stars ?? r?.star_rating ?? r?.avgRating ?? r?.representative?.rating)
    .map(v => Number(v))
    .filter(v => Number.isFinite(v) && v > 0 && v <= 5);
  if (stars.length === 0) return null;
  const mean = Number((stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(2));
  return {
    value: mean,
    family_count: stars.length,
    scope: `${scope}（${stars.length} 款）`,
    ...(period ? { period } : {}),
    note: '仅作细分市场口碑与差评预期参考，不纳入 100 分评分。',
  };
}

/**
 * Extract Q31 dual-source organic/ad keyword counts (`r48/r50`: SellerSprite + SIF).
 */
export function extractQ31DualSourceKeywordCounts({
  sellerspriteRaw = null,
  sifRaw = null,
} = {}) {
  const readCounts = (raw, isSif = false) => {
    if (!raw || typeof raw !== 'object') return null;
    const body = unwrapMcpEnvelope(raw);
    if (!body || typeof body !== 'object') return null;
    if (finite(body.organic) && finite(body.ad)) {
      return { organic: Math.max(0, Math.round(body.organic)), ad: Math.max(0, Math.round(body.ad)) };
    }
    const orgDirect = body.organic_keywords ?? body.organicKeywords ?? body.naturalKeywordCount ?? body.organicCount ?? body.natural_count;
    const adDirect = body.ad_keywords ?? body.adKeywords ?? body.sponsoredKeywordCount ?? body.adCount ?? body.sponsored_count;
    if (finite(orgDirect) && finite(adDirect)) {
      return { organic: Math.max(0, Math.round(orgDirect)), ad: Math.max(0, Math.round(adDirect)) };
    }
    const items = Array.isArray(body.items) ? body.items : (Array.isArray(body.list) ? body.list : null);
    if (items) {
      let org = 0;
      let ad = 0;
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const hasOrg = isSif
          ? Boolean(finite(it.naturalRank ?? it.organic_rank) && Number(it.naturalRank ?? it.organic_rank) > 0)
          : Boolean(finite(it.naturalRank ?? it.rankPosition ?? it.organic_rank) && Number(it.naturalRank ?? it.rankPosition ?? it.organic_rank) > 0);
        const hasAd = Boolean(finite(it.adRank ?? it.sponsoredRank ?? it.ad_rank) && Number(it.adRank ?? it.sponsoredRank ?? it.ad_rank) > 0);
        if (hasOrg) org += 1;
        if (hasAd) ad += 1;
      }
      return { organic: org, ad };
    }
    return null;
  };
  const ss = readCounts(sellerspriteRaw, false);
  const sif = readCounts(sifRaw, true);
  if (!ss && !sif) return null;
  return {
    ...(ss ? { sellersprite: ss } : {}),
    ...(sif ? { sif } : {}),
  };
}

/**
 * Resolve Stage-1 qualitative rubric judgments (#16/#17/#20/#21) from public/listing evidence,
 * reserving physical tolerance/compliance lab checks for Stage-2 sample tags rather than blocking Stage-1 scoring.
 */
