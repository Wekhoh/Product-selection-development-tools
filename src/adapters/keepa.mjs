/**
 * SellerSprite / Keepa historical curve & package snapshot adapter.
 *
 * Fact-first invariants (verified against 5 real SellerSprite Keepa curves / 690 sample points):
 *  1. Unwraps MCP envelopes cleanly and supports all 3 SellerSprite Keepa shapes:
 *     - Timestamped curve (`ts[]` + `series.*`)
 *     - Compact undated curve (`series.*` without `ts[]` — outputs sample indices only, never invents dates)
 *     - Keepa-sourced package snapshot (`pkgDimensionsSize`, `pkgWeightGram`, `fbaFees`)
 *  2. Explicitly distinguishes `field_not_returned` vs `observed_all_null` vs `observed_values`
 *     for every price, coupon, review, rating, BSR, seller-count, and monthly-sales series.
 *  3. Preserves `ts[]` and enumerates missing calendar dates across the observed window.
 *  4. Computes per-series `high`, `low`, `latest`, `median`, and contiguous run-length plateaus (`runs`),
 *     recording exact `current_price_source` so a 1-point undated `buybox` snapshot NEVER overwrites
 *     a multi-point `price` curve's latest observation.
 *  5. Emits structured coupon status (`< 20%` routine vs `>= 20%` heavy single coupon vs `unknown_not_returned`),
 *     veteran sustained drop / clearance watch hints, and review drop/jump facts for Terra & Q31.
 */
import { BUSINESS_THRESHOLDS } from '../business-thresholds.mjs';
import { calendarDaysBetweenIso, validIsoDate } from '../utils/dates.mjs';
import { isFailedOrEmptyRawReceipt, unwrapMcpEnvelope } from './mcp-envelope.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;

export const KEEPA_PRICE_SERIES_KEYS = Object.freeze([
  'price',
  'buybox',
  'priceList',
  'dealPrice',
  'priceFBA',
  'priceFBM',
  'pricePrime',
]);

export const KEEPA_COUPON_SERIES_KEYS = Object.freeze([
  'couponHistory',
  'oneTimeCouponHistory',
]);

export const KEEPA_METRIC_SERIES_KEYS = Object.freeze([
  'reviews',
  'rating',
  'bsr',
  'sellers',
  'monthlySoldHistory',
]);

function normalizeKeepaTimestampToIsoDate(rawTs) {
  if (typeof rawTs === 'string') {
    const trimmed = rawTs.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const d = trimmed.slice(0, 10);
      return validIsoDate(d) ? d : null;
    }
    if (/^\d{8}$/.test(trimmed)) {
      const d = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
      return validIsoDate(d) ? d : null;
    }
  }
  if (finite(rawTs) && rawTs > 0) {
    // Handle Unix ms, Unix seconds, or Keepa minutes since 2011-01-01T00:00:00Z (1293840000000 ms).
    let ms = null;
    if (rawTs >= 1e12) ms = rawTs;
    else if (rawTs >= 1e9) ms = rawTs * 1000;
    else if (rawTs >= 1e6) ms = 1293840000000 + rawTs * 60_000;
    if (ms !== null && Number.isFinite(ms)) {
      const iso = new Date(ms).toISOString().slice(0, 10);
      return validIsoDate(iso) ? iso : null;
    }
  }
  return null;
}

function enumerateMissingCalendarDates(sortedUniqueDates) {
  if (sortedUniqueDates.length < 2) return [];
  const present = new Set(sortedUniqueDates);
  const missing = [];
  let curMs = Date.parse(`${sortedUniqueDates[0]}T00:00:00Z`);
  const endMs = Date.parse(`${sortedUniqueDates[sortedUniqueDates.length - 1]}T00:00:00Z`);
  while (curMs + 86_400_000 < endMs) {
    curMs += 86_400_000;
    const d = new Date(curMs).toISOString().slice(0, 10);
    if (!present.has(d)) missing.push(d);
  }
  return missing;
}

function normalizeObservationValue(rawVal, { allowZero = false, isCoupon = false } = {}) {
  if (rawVal === null || rawVal === undefined) return null;
  if (isCoupon && typeof rawVal === 'string') {
    const mPct = rawVal.match(/(\d+(?:\.\d+)?)\s*%/);
    if (mPct) return { kind: 'pct', value: Number(mPct[1]) / 100, raw: rawVal };
    const mUsd = rawVal.match(/\$?\s*(\d+(?:\.\d+)?)/);
    if (mUsd && Number(mUsd[1]) > 0) return { kind: 'usd', value: Number(mUsd[1]), raw: rawVal };
    return null;
  }
  if (isCoupon && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
    const pct = finite(rawVal.discountPct ?? rawVal.percent ?? rawVal.pct)
      ? Number(rawVal.discountPct ?? rawVal.percent ?? rawVal.pct)
      : null;
    const usd = finite(rawVal.discountUsd ?? rawVal.amount ?? rawVal.usd)
      ? Number(rawVal.discountUsd ?? rawVal.amount ?? rawVal.usd)
      : null;
    if (pct !== null && pct > 0) return { kind: 'pct', value: pct > 1 ? pct / 100 : pct, raw: rawVal };
    if (usd !== null && usd > 0) return { kind: 'usd', value: usd, raw: rawVal };
    return null;
  }
  if (!finite(rawVal)) return null;
  if (isCoupon) {
    if (rawVal === 0 || rawVal === -1) return null;
    if (rawVal < 0) {
      const absPct = Math.abs(rawVal);
      return absPct > 0 && absPct < 100 ? { kind: 'pct', value: absPct / 100, raw: rawVal } : null;
    }
    return rawVal < 1
      ? { kind: 'pct', value: rawVal, raw: rawVal }
      : { kind: 'usd', value: rawVal, raw: rawVal };
  }
  if (rawVal < 0 || (!allowZero && rawVal === 0)) return null;
  return rawVal;
}

function computeMedianSorted(sortedNums) {
  if (sortedNums.length === 0) return null;
  const mid = Math.floor(sortedNums.length / 2);
  return sortedNums.length % 2 === 1
    ? sortedNums[mid]
    : round2((sortedNums[mid - 1] + sortedNums[mid]) / 2);
}

function summarizeNumericSeries(seriesObj, key, tsDates, { allowZero = false } = {}) {
  if (!seriesObj || !Object.hasOwn(seriesObj, key) || seriesObj[key] === undefined) {
    return {
      field_status: 'field_not_returned',
      raw_length: 0,
      observed_count: 0,
      null_count: 0,
      high: null,
      low: null,
      latest: null,
      median: null,
      first_at: null,
      latest_at: null,
      runs: [],
    };
  }
  const rawArr = Array.isArray(seriesObj[key])
    ? seriesObj[key]
    : (finite(seriesObj[key]) ? [seriesObj[key]] : []);
  const hasAlignedTs = Array.isArray(tsDates) && tsDates.length === rawArr.length && tsDates.some(Boolean);

  const validVals = [];
  let latest = null;
  let latestAt = null;
  let firstAt = null;
  let high = null;
  let low = null;
  let nullCount = 0;
  const runs = [];

  for (let i = 0; i < rawArr.length; i++) {
    const v = normalizeObservationValue(rawArr[i], { allowZero });
    const loc = hasAlignedTs && tsDates[i] ? tsDates[i] : `sample_${i + 1}`;
    if (v === null) {
      nullCount += 1;
      if (runs.length > 0 && runs[runs.length - 1].value === null) {
        runs[runs.length - 1].count += 1;
        runs[runs.length - 1].end = loc;
        runs[runs.length - 1].end_index = i + 1;
      } else {
        runs.push({ value: null, count: 1, start: loc, end: loc, start_index: i + 1, end_index: i + 1 });
      }
      continue;
    }
    validVals.push(v);
    if (firstAt === null) firstAt = loc;
    latest = v;
    latestAt = loc;
    if (high === null || v > high) high = v;
    if (low === null || v < low) low = v;
    if (runs.length > 0 && runs[runs.length - 1].value === v) {
      runs[runs.length - 1].count += 1;
      runs[runs.length - 1].end = loc;
      runs[runs.length - 1].end_index = i + 1;
    } else {
      runs.push({ value: v, count: 1, start: loc, end: loc, start_index: i + 1, end_index: i + 1 });
    }
  }

  if (validVals.length === 0) {
    return {
      field_status: 'observed_all_null',
      raw_length: rawArr.length,
      observed_count: 0,
      null_count: nullCount,
      high: null,
      low: null,
      latest: null,
      median: null,
      first_at: null,
      latest_at: null,
      runs,
    };
  }

  const sorted = [...validVals].sort((a, b) => a - b);
  return {
    field_status: 'observed_values',
    raw_length: rawArr.length,
    observed_count: validVals.length,
    null_count: nullCount,
    high,
    low,
    latest,
    median: computeMedianSorted(sorted),
    first_at: firstAt,
    latest_at: latestAt,
    runs,
  };
}

function summarizeCouponSeries(seriesObj, key, tsDates, referencePriceUsd = null) {
  if (!seriesObj || !Object.hasOwn(seriesObj, key) || seriesObj[key] === undefined) {
    return {
      field_status: 'field_not_returned',
      raw_length: 0,
      observed_count: 0,
      latest_coupon: null,
      max_discount_fraction: null,
    };
  }
  const rawArr = Array.isArray(seriesObj[key]) ? seriesObj[key] : [seriesObj[key]];
  const hasAlignedTs = Array.isArray(tsDates) && tsDates.length === rawArr.length && tsDates.some(Boolean);
  let observedCount = 0;
  let latestCoupon = null;
  let maxFraction = null;

  for (let i = 0; i < rawArr.length; i++) {
    const parsed = normalizeObservationValue(rawArr[i], { isCoupon: true });
    if (!parsed) continue;
    observedCount += 1;
    const loc = hasAlignedTs && tsDates[i] ? tsDates[i] : `sample_${i + 1}`;
    let frac = null;
    if (parsed.kind === 'pct') frac = parsed.value;
    else if (parsed.kind === 'usd' && finite(referencePriceUsd) && referencePriceUsd > 0 && parsed.value < referencePriceUsd) {
      frac = parsed.value / referencePriceUsd;
    }
    latestCoupon = { ...parsed, at: loc, estimated_fraction: frac !== null ? round2(frac * 100) / 100 : null };
    if (frac !== null && (maxFraction === null || frac > maxFraction)) maxFraction = frac;
  }

  if (observedCount === 0) {
    return {
      field_status: 'observed_all_null',
      raw_length: rawArr.length,
      observed_count: 0,
      latest_coupon: null,
      max_discount_fraction: null,
    };
  }
  return {
    field_status: 'observed_values',
    raw_length: rawArr.length,
    observed_count: observedCount,
    latest_coupon: latestCoupon,
    max_discount_fraction: maxFraction !== null ? Math.round(maxFraction * 10000) / 10000 : null,
  };
}

function parseKeepaPackageSnapshot(node) {
  if (!node || typeof node !== 'object') return null;
  const dimStr = typeof node.pkgDimensionsSize === 'string' ? node.pkgDimensionsSize.trim() : '';
  const wtGram = finite(node.pkgWeightGram) && node.pkgWeightGram > 0 ? node.pkgWeightGram : null;
  let dimsIn = null;
  if (dimStr) {
    const m = dimStr.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(in|inch|inches|cm|mm)?/i);
    if (m) {
      const unit = (m[4] || 'in').toLowerCase();
      const factor = unit === 'cm' ? 1 / 2.54 : unit === 'mm' ? 1 / 25.4 : 1;
      const sides = [Number(m[1]) * factor, Number(m[2]) * factor, Number(m[3]) * factor].sort((a, b) => b - a);
      dimsIn = {
        length_in: Math.round(sides[0] * 1000) / 1000,
        width_in: Math.round(sides[1] * 1000) / 1000,
        height_in: Math.round(sides[2] * 1000) / 1000,
      };
    }
  }
  if (!dimsIn && wtGram === null && !finite(node.fbaFees)) return null;
  return {
    ...(dimsIn ?? {}),
    ...(wtGram !== null ? { unit_weight_lb: Math.round((wtGram / 453.59237) * 10000) / 10000, pkg_weight_gram: wtGram } : {}),
    ...(finite(node.fbaFees) && node.fbaFees > 0 ? { keepa_cached_fba_fee_usd: node.fbaFees } : {}),
  };
}

function detectReviewTrajectoryEvents(reviewsSummary, { age_days = null, asin = null } = {}) {
  if (!reviewsSummary || reviewsSummary.field_status !== 'observed_values') {
    return {
      asin,
      review_series_status: reviewsSummary?.field_status ?? 'field_not_returned',
      events: [],
      has_drop_event: false,
      has_jump_event: false,
      max_single_step_increase: 0,
      max_single_step_drop: 0,
      newcomer_review_anomaly_hint: false,
    };
  }
  const nonNullRuns = reviewsSummary.runs.filter(r => r.value !== null);
  const events = [];
  let hasDrop = false;
  let hasIncrease = false;
  let maxSingleStepIncrease = 0;
  let maxSingleStepDrop = 0;
  for (let i = 1; i < nonNullRuns.length; i++) {
    const prev = nonNullRuns[i - 1];
    const curr = nonNullRuns[i];
    const delta = curr.value - prev.value;
    const dateFrom = validIsoDate(prev.end) ? prev.end : null;
    const dateTo = validIsoDate(curr.start) ? curr.start : null;
    if (delta < 0) {
      hasDrop = true;
      if (delta < maxSingleStepDrop) maxSingleStepDrop = delta;
      events.push({
        kind: 'review_count_drop',
        direction: 'drop',
        from_count: prev.value,
        to_count: curr.value,
        delta,
        date_from: dateFrom,
        date_to: dateTo,
        at: curr.start,
        asin,
      });
    } else if (delta > 0) {
      hasIncrease = true;
      if (delta > maxSingleStepIncrease) maxSingleStepIncrease = delta;
      events.push({
        kind: 'review_count_increase',
        direction: 'jump',
        from_count: prev.value,
        to_count: curr.value,
        delta,
        date_from: dateFrom,
        date_to: dateTo,
        at: curr.start,
        asin,
      });
    }
  }
  const newcomerAnomaly =
    finite(age_days) &&
    age_days <= BUSINESS_THRESHOLDS.newcomer_max_age_days &&
    (hasDrop || hasIncrease);

  return {
    asin,
    review_series_status: 'observed_values',
    start_reviews: nonNullRuns[0]?.value ?? null,
    end_reviews: nonNullRuns[nonNullRuns.length - 1]?.value ?? null,
    events,
    has_drop_event: hasDrop,
    has_jump_event: hasIncrease,
    max_single_step_increase: maxSingleStepIncrease,
    max_single_step_drop: maxSingleStepDrop,
    newcomer_review_anomaly_hint: newcomerAnomaly,
  };
}

/**
 * Parse a raw SellerSprite Keepa MCP payload or unwrapped Keepa object into verified factual statistics.
 */
export function parseSellerSpriteKeepaPayload(rawPayload, { age_days = null, as_of_date = null } = {}) {
  if (isFailedOrEmptyRawReceipt(rawPayload)) {
    return { status: 'failed_or_empty_receipt', ok: false };
  }
  const unwrapped = unwrapMcpEnvelope(rawPayload);
  if (!unwrapped || typeof unwrapped !== 'object') {
    return { status: 'invalid_payload', ok: false };
  }

  const root = unwrapped.data && typeof unwrapped.data === 'object' && !Array.isArray(unwrapped.data)
    ? unwrapped.data
    : unwrapped;
  const trendNode = root.keepa_trend && typeof root.keepa_trend === 'object'
    ? root.keepa_trend
    : (root.keepa && typeof root.keepa === 'object' ? root.keepa : root);
  const seriesObj = trendNode.series && typeof trendNode.series === 'object'
    ? trendNode.series
    : (root.series && typeof root.series === 'object' ? root.series : null);

  const asinCandidate = root.asin ?? trendNode.asin ?? unwrapped.asin ?? null;
  const asin = typeof asinCandidate === 'string' && /^B0[A-Z0-9]{8}$/i.test(asinCandidate.trim())
    ? asinCandidate.trim().toUpperCase()
    : null;

  const packageSnapshot = parseKeepaPackageSnapshot(root) ?? parseKeepaPackageSnapshot(trendNode);

  const rawTsFull = Array.isArray(trendNode.ts)
    ? trendNode.ts
    : (Array.isArray(root.ts) ? root.ts : null);
  const tsDatesFull = rawTsFull ? rawTsFull.map(normalizeKeepaTimestampToIsoDate) : null;
  const cutoffIso = typeof as_of_date === 'string' && validIsoDate(as_of_date.trim().slice(0, 10))
    ? as_of_date.trim().slice(0, 10)
    : null;

  let rawTs = rawTsFull;
  let tsDates = tsDatesFull;
  let effectiveSeriesObj = seriesObj;
  if (cutoffIso && rawTsFull && tsDatesFull && seriesObj) {
    const keptIdx = [];
    for (let i = 0; i < tsDatesFull.length; i++) {
      if (!tsDatesFull[i] || tsDatesFull[i] <= cutoffIso) keptIdx.push(i);
    }
    rawTs = keptIdx.map(i => rawTsFull[i]);
    tsDates = keptIdx.map(i => tsDatesFull[i]);
    const slicedSeries = {};
    for (const [sKey, sVal] of Object.entries(seriesObj)) {
      if (Array.isArray(sVal) && sVal.length === rawTsFull.length) {
        slicedSeries[sKey] = keptIdx.map(i => sVal[i]);
      } else {
        slicedSeries[sKey] = sVal;
      }
    }
    effectiveSeriesObj = slicedSeries;
  }

  const validDates = tsDates ? [...new Set(tsDates.filter(Boolean))].sort() : [];
  const hasTimestamps = validDates.length > 0;
  const calendarSpanDays = hasTimestamps && validDates.length >= 2
    ? calendarDaysBetweenIso(validDates[0], validDates[validDates.length - 1]) + 1
    : (validDates.length === 1 ? 1 : null);
  const missingCalendarDates = hasTimestamps ? enumerateMissingCalendarDates(validDates) : [];

  if (!effectiveSeriesObj) {
    return {
      ok: Boolean(packageSnapshot),
      status: packageSnapshot ? 'package_snapshot_only' : 'no_keepa_series',
      asin,
      shape: packageSnapshot ? 'package_snapshot' : 'unknown',
      has_timestamps: false,
      ts: null,
      package_snapshot: packageSnapshot,
    };
  }

  const priceSeries = {};
  for (const key of KEEPA_PRICE_SERIES_KEYS) {
    priceSeries[key] = summarizeNumericSeries(effectiveSeriesObj, key, tsDates, { allowZero: false });
  }

  const metricSeries = {};
  for (const key of KEEPA_METRIC_SERIES_KEYS) {
    metricSeries[key] = summarizeNumericSeries(effectiveSeriesObj, key, tsDates, {
      allowZero: key === 'reviews' || key === 'monthlySoldHistory',
    });
  }

  // Determine authoritative current price & source WITHOUT letting a 1-point undated buybox override a multi-point price curve!
  const priceStat = priceSeries.price;
  const buyboxStat = priceSeries.buybox;
  let currentPriceUsd = null;
  let currentPriceSource = null;

  const buyboxAlignedOrLonger =
    buyboxStat.field_status === 'observed_values' &&
    (
      priceStat.field_status !== 'observed_values' ||
      (buyboxStat.raw_length > 1 && buyboxStat.raw_length >= priceStat.raw_length)
    );

  if (buyboxAlignedOrLonger) {
    currentPriceUsd = buyboxStat.latest;
    currentPriceSource = 'buybox';
  } else if (priceStat.field_status === 'observed_values') {
    currentPriceUsd = priceStat.latest;
    currentPriceSource = 'price';
  } else if (buyboxStat.field_status === 'observed_values') {
    currentPriceUsd = buyboxStat.latest;
    currentPriceSource = 'buybox_single_snapshot';
  } else if (priceSeries.priceFBA.field_status === 'observed_values') {
    currentPriceUsd = priceSeries.priceFBA.latest;
    currentPriceSource = 'priceFBA';
  }

  // Primary trajectory line for regular-price plateau analysis: aligned buybox when multi-point, else price.
  const primaryLineKey = buyboxAlignedOrLonger ? 'buybox' : 'price';
  const primaryLine = priceSeries[primaryLineKey];
  const nonNullRuns = primaryLine.runs.filter(r => r.value !== null);
  const latestRun = nonNullRuns.length > 0 ? nonNullRuns[nonNullRuns.length - 1] : null;
  const dominantPriceCounts = new Map();
  for (const r of nonNullRuns) {
    dominantPriceCounts.set(r.value, (dominantPriceCounts.get(r.value) ?? 0) + r.count);
  }
  let dominantPriceUsd = null;
  let dominantPriceSamples = 0;
  for (const [val, cnt] of dominantPriceCounts.entries()) {
    if (cnt > dominantPriceSamples) {
      dominantPriceUsd = val;
      dominantPriceSamples = cnt;
    }
  }

  const couponFractionAtIndex = (idx, refPrice) => {
    if (!finite(refPrice) || refPrice <= 0) return 0;
    let best = 0;
    for (const ck of KEEPA_COUPON_SERIES_KEYS) {
      const arr = effectiveSeriesObj[ck];
      if (!Array.isArray(arr) || idx >= arr.length) continue;
      const parsed = normalizeObservationValue(arr[idx], { isCoupon: true });
      if (!parsed) continue;
      let frac = 0;
      if (parsed.kind === 'pct') frac = parsed.value;
      else if (parsed.kind === 'usd' && parsed.value < refPrice) frac = parsed.value / refPrice;
      if (frac > 0 && frac < 1 && frac > best) best = frac;
    }
    return best;
  };

  // Slice timestamped series strictly to the trailing owner-confirmed 90-day window (`newcomer_max_age_days = 90`).
  // Undated or sub-90d curves never claim a verified 90-day steady plateau.
  let window90dPrimary = null;
  let window90dRange = null;
  let window90dCalendarSpanDays = 0;
  let heavyCouponDays90d = 0;
  let nonHeavyDays90dCount = 0;
  const realizedNet90dVals = [];
  let latestCouponFraction = 0;
  const rawPrimaryArr = Array.isArray(effectiveSeriesObj[primaryLineKey])
    ? effectiveSeriesObj[primaryLineKey]
    : (finite(effectiveSeriesObj[primaryLineKey]) ? [effectiveSeriesObj[primaryLineKey]] : []);
  if (rawPrimaryArr.length > 0) {
    for (let i = rawPrimaryArr.length - 1; i >= 0; i--) {
      const pv = normalizeObservationValue(rawPrimaryArr[i], { allowZero: false });
      if (pv !== null) {
        latestCouponFraction = Math.round(couponFractionAtIndex(i, pv) * 10000) / 10000;
        break;
      }
    }
  }
  if (hasTimestamps && Array.isArray(tsDates) && tsDates.length === rawPrimaryArr.length) {
    const windowEndIso = cutoffIso && cutoffIso >= validDates[validDates.length - 1]
      ? cutoffIso
      : validDates[validDates.length - 1];
    const slicedVals = [];
    const slicedDates = [];
    const observedPriceDates = [];
    for (let i = 0; i < rawPrimaryArr.length; i++) {
      const d = tsDates[i];
      if (!d) continue;
      const ageFromEnd = calendarDaysBetweenIso(d, windowEndIso);
      if (ageFromEnd >= 0 && ageFromEnd < BUSINESS_THRESHOLDS.newcomer_max_age_days) {
        slicedVals.push(rawPrimaryArr[i]);
        slicedDates.push(d);
        const pv = normalizeObservationValue(rawPrimaryArr[i], { allowZero: false });
        if (pv !== null) {
          observedPriceDates.push(d);
          const cf = couponFractionAtIndex(i, pv);
          realizedNet90dVals.push(round2(pv * (1 - cf)));
          if (cf >= BUSINESS_THRESHOLDS.heavy_single_coupon_pct_threshold) {
            heavyCouponDays90d += 1;
          } else {
            nonHeavyDays90dCount += 1;
          }
        }
      }
    }
    if (slicedDates.length > 0) {
      window90dPrimary = summarizeNumericSeries({ [primaryLineKey]: slicedVals }, primaryLineKey, slicedDates, { allowZero: false });
      const uniqueObservedDates = [...new Set(observedPriceDates)].sort();
      window90dCalendarSpanDays = uniqueObservedDates.length >= 2
        ? calendarDaysBetweenIso(uniqueObservedDates[0], uniqueObservedDates[uniqueObservedDates.length - 1]) + 1
        : (uniqueObservedDates.length === 1 ? 1 : 0);
      if (uniqueObservedDates.length > 0) {
        window90dRange = {
          from: uniqueObservedDates[0],
          through: uniqueObservedDates[uniqueObservedDates.length - 1],
          sampled_days: uniqueObservedDates.length,
          calendar_span_days: window90dCalendarSpanDays,
          window_days: BUSINESS_THRESHOLDS.newcomer_max_age_days,
        };
      }
    }
  }

  const coversFull90dWindow = window90dCalendarSpanDays >= BUSINESS_THRESHOLDS.newcomer_max_age_days;
  const continuousHeavyCoupon90d = Boolean(heavyCouponDays90d > 0 && nonHeavyDays90dCount === 0);
  const realizedNet90dMedianUsd = realizedNet90dVals.length > 0
    ? (() => {
        const s = [...realizedNet90dVals].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 === 1 ? s[m] : round2((s[m - 1] + s[m]) / 2);
      })()
    : null;

  const fullCurveMedianUsd = primaryLine.median;
  const regularMedianUsd = hasTimestamps && coversFull90dWindow && !continuousHeavyCoupon90d
    ? (window90dPrimary?.median ?? null)
    : null;
  const undatedSampleMedianUsd = !hasTimestamps ? fullCurveMedianUsd : null;

  // Factual zero-threshold tail & promo indicators (no unapproved sample-count or percentage drop cutoffs):
  // - `is_brief_tail_dip`: factual structural check on whether the latest run sits below the dominant plateau price.
  // - `sustained_drop_or_clearance_watch`: NEVER repurposes the single-coupon 20% cutoff on couponless price dips;
  //   true only when upstream structured metadata explicitly flags clearance / price-war volatility (qualitative
  //   curves with `nonNullRuns90d.length > 1` stay `keepa_90d_steady = false` for `MarketObservationJudge`).
  // - `keepa_90d_steady`: true ONLY when dated observations cover the full 90-day window (`newcomer_max_age_days = 90`)
  //   and form a verified un-heavy-couponed flat plateau.
  const isTailBelowDominant =
    latestRun !== null &&
    dominantPriceUsd !== null &&
    nonNullRuns.length >= 2 &&
    latestRun.value < dominantPriceUsd;
  const nonNullRuns90d = window90dPrimary ? window90dPrimary.runs.filter(r => r.value !== null) : [];
  const window90dTransitions = [];
  for (let i = 1; i < nonNullRuns90d.length; i++) {
    const prev = nonNullRuns90d[i - 1];
    const curr = nonNullRuns90d[i];
    window90dTransitions.push({
      from_price_usd: prev.value,
      to_price_usd: curr.value,
      delta_usd: round2(curr.value - prev.value),
      date_from: validIsoDate(prev.end) ? prev.end : null,
      date_to: validIsoDate(curr.start) ? curr.start : null,
    });
  }
  const window90dPriceDelta = window90dRange && window90dPrimary && finite(window90dPrimary.low) && finite(window90dPrimary.high)
    ? {
      observed_price_min_usd: window90dPrimary.low,
      observed_price_max_usd: window90dPrimary.high,
      observed_date_start: window90dRange.from,
      observed_date_end: window90dRange.through,
      delta_usd: round2(window90dPrimary.high - window90dPrimary.low),
      first_price_usd: nonNullRuns90d[0]?.value ?? null,
      latest_price_usd: nonNullRuns90d[nonNullRuns90d.length - 1]?.value ?? null,
      signed_change_usd: nonNullRuns90d.length >= 2
        ? round2(nonNullRuns90d[nonNullRuns90d.length - 1].value - nonNullRuns90d[0].value)
        : 0,
      transitions: window90dTransitions,
    }
    : null;
  const keepaSteadyVerified =
    hasTimestamps &&
    coversFull90dWindow &&
    !continuousHeavyCoupon90d &&
    window90dPrimary !== null &&
    window90dPrimary.observed_count >= 2 &&
    nonNullRuns90d.length === 1;

  const sustainedDropWatch = Boolean(
    root.sustained_drop_or_clearance_watch === true ||
    trendNode.sustained_drop_or_clearance_watch === true ||
    root.keepa_clearance === true ||
    root.keepa_price_war === true ||
    root.keepa_sustained_drop === true,
  );

  const refListForCoupon = priceSeries.priceList.latest ?? window90dPrimary?.median ?? fullCurveMedianUsd ?? currentPriceUsd;
  const couponSeries = {};
  for (const key of KEEPA_COUPON_SERIES_KEYS) {
    couponSeries[key] = summarizeCouponSeries(effectiveSeriesObj, key, tsDates, refListForCoupon);
  }
  const allCouponsNotReturned = KEEPA_COUPON_SERIES_KEYS.every(k => couponSeries[k].field_status === 'field_not_returned');
  const anyCouponObserved = KEEPA_COUPON_SERIES_KEYS.some(k => couponSeries[k].field_status === 'observed_values');
  const maxCouponFrac = KEEPA_COUPON_SERIES_KEYS.reduce((mx, k) => {
    const f = couponSeries[k].max_discount_fraction;
    return f !== null && (mx === null || f > mx) ? f : mx;
  }, null);
  const couponStatus = allCouponsNotReturned
    ? 'unknown_not_returned'
    : !anyCouponObserved
      ? 'none_observed'
      : (maxCouponFrac !== null && maxCouponFrac >= BUSINESS_THRESHOLDS.heavy_single_coupon_pct_threshold
        ? 'heavy_ge_20pct'
        : 'routine_under_20pct');

  const reviewTrajectory = detectReviewTrajectoryEvents(metricSeries.reviews, { age_days, asin });

  return {
    ok: true,
    status: 'parsed',
    asin,
    shape: hasTimestamps ? 'timestamped_keepa_curve' : 'undated_compact_curve',
    has_timestamps: hasTimestamps,
    ts: rawTs ? [...rawTs] : null,
    ts_iso_dates: tsDates,
    date_window: hasTimestamps
      ? {
        from: validDates[0],
        through: validDates[validDates.length - 1],
        calendar_span_days: calendarSpanDays,
        sampled_days: validDates.length,
        missing_calendar_days_count: missingCalendarDates.length,
        missing_calendar_dates: missingCalendarDates,
      }
      : null,
    window_90d: window90dRange
      ? {
        ...window90dRange,
        high_usd: window90dPrimary.high,
        low_usd: window90dPrimary.low,
        median_usd: window90dPrimary.median,
        realized_net_median_usd: realizedNet90dMedianUsd,
        latest_usd: window90dPrimary.latest,
        observed_count: window90dPrimary.observed_count,
        runs: window90dPrimary.runs,
        ...(window90dPriceDelta ?? {}),
      }
      : null,
    window_90d_price_delta: window90dPriceDelta,
    current_price_usd: currentPriceUsd,
    current_price_source: currentPriceSource,
    primary_trajectory_line: primaryLineKey,
    regular_median_usd: regularMedianUsd,
    keepa_90d_median_usd: regularMedianUsd,
    realized_net_90d_median_usd: realizedNet90dMedianUsd,
    continuous_heavy_coupon_90d: continuousHeavyCoupon90d,
    latest_coupon_fraction: latestCouponFraction > 0 ? latestCouponFraction : null,
    full_window_median_usd: fullCurveMedianUsd,
    undated_sample_median_usd: undatedSampleMedianUsd,
    dominant_plateau_usd: dominantPriceUsd,
    dominant_plateau_samples: dominantPriceSamples,
    tail_run_samples: latestRun?.count ?? 0,
    is_brief_tail_dip: isTailBelowDominant,
    keepa_90d_steady: keepaSteadyVerified,
    sustained_drop_or_clearance_watch: sustainedDropWatch,
    coupon_status: couponStatus,
    max_coupon_discount_fraction: maxCouponFrac,
    price_series: priceSeries,
    coupon_series: couponSeries,
    metric_series: metricSeries,
    review_trajectory: reviewTrajectory,
    package_snapshot: packageSnapshot,
  };
}

/**
 * Convert a parsed Keepa result into a fact-first peer summary for `MarketObservationJudge` (Terra)
 * without fabricating nulls for unreturned fields, overwriting multi-point `price` with 1-point `buybox`,
 * or throwing on package-only Keepa snapshots.
 */
export function buildKeepaPeerFactsForMarketJudge(parsedKeepa) {
  if (!parsedKeepa || !parsedKeepa.ok) return null;
  if (!parsedKeepa.price_series) {
    return {
      asin: parsedKeepa.asin ?? null,
      status: parsedKeepa.status ?? 'package_snapshot_only',
      has_timestamps: false,
      date_window: null,
      window_90d: null,
      current_price_usd: null,
      current_price_source: null,
      keepa_90d_high_usd: null,
      keepa_90d_low_usd: null,
      keepa_90d_median_usd: null,
      undated_sample_median_usd: null,
      is_brief_tail_dip: false,
      keepa_90d_steady: false,
      sustained_drop_or_clearance_watch: false,
      coupon_status: 'unknown_not_returned',
      price_line_runs: [],
      buybox_field_status: 'field_not_returned',
      buybox_line_runs: [],
      price_list_field_status: 'field_not_returned',
      review_trajectory: null,
      package_snapshot: parsedKeepa.package_snapshot ?? null,
    };
  }
  return {
    asin: parsedKeepa.asin,
    status: parsedKeepa.status ?? 'parsed',
    has_timestamps: parsedKeepa.has_timestamps,
    date_window: parsedKeepa.date_window,
    window_90d: parsedKeepa.window_90d ?? null,
    window_90d_price_delta: parsedKeepa.window_90d_price_delta ?? null,
    current_price_usd: parsedKeepa.current_price_usd,
    current_price_source: parsedKeepa.current_price_source,
    keepa_90d_high_usd: parsedKeepa.window_90d?.high_usd ?? null,
    keepa_90d_low_usd: parsedKeepa.window_90d?.low_usd ?? null,
    keepa_90d_median_usd: parsedKeepa.keepa_90d_median_usd ?? null,
    full_window_median_usd: parsedKeepa.full_window_median_usd ?? null,
    undated_sample_median_usd: parsedKeepa.undated_sample_median_usd ?? null,
    is_brief_tail_dip: parsedKeepa.is_brief_tail_dip,
    keepa_90d_steady: parsedKeepa.keepa_90d_steady,
    sustained_drop_or_clearance_watch: parsedKeepa.sustained_drop_or_clearance_watch,
    coupon_status: parsedKeepa.coupon_status,
    price_line_runs: parsedKeepa.price_series.price?.runs ?? [],
    buybox_field_status: parsedKeepa.price_series.buybox?.field_status ?? 'field_not_returned',
    buybox_line_runs: parsedKeepa.price_series.buybox?.runs ?? [],
    price_list_field_status: parsedKeepa.price_series.priceList?.field_status ?? 'field_not_returned',
    review_trajectory: parsedKeepa.review_trajectory ?? null,
    package_snapshot: parsedKeepa.package_snapshot ?? null,
  };
}
