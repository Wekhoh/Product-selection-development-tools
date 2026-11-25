// Offline 2027 US common Standard-size FBA rate table, Gate 1A landed-cap estimator,
// $50.00 tier-cliff analyzer, and Gate 1B carton/MOQ order planner.
// Importing performs no I/O. Unlisted oversize, bulky, apparel, dangerous-goods,
// unpublished holiday-peak, or unverified categories return status: 'needs_calculator_verification'.

import { netReferral, collectionFromDisbursement } from './economics.mjs';
import {
  VERIFIED_2027_RETURN_THRESHOLDS,
  lookupVerified2027ReturnThreshold,
  resolveConsistentBoolean,
  resolvePackageDimsRat,
  resolveEffectivePricing,
  computeAmazonCouponRedemptionFee2027,
  toBigRat,
  addBigRat,
  mulBigRat,
  divBigRat,
  roundBigRat,
} from './fee-basis.mjs';
export { VERIFIED_2027_RETURN_THRESHOLDS };

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round((value + Number.EPSILON) * 1e10) / 1e10;
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validWindow = value => isoDate(value?.from) && isoDate(value?.through) && value.from <= value.through;

const CM_PER_INCH = 2.54;
const KG_PER_LB = 0.45359237;
const OZ_PER_LB = 16;

function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x;
}

function lcmBig(a, b) {
  return (a / gcdBig(a, b)) * b;
}

function ceilDivBig(a, b) {
  return (a + b - 1n) / b;
}

function toRat(n) {
  if (!finite(n)) throw new TypeError('Finite number required.');
  const [mantissa, expPart = '0'] = n.toString().toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const [intPart, fracPart = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = BigInt(intPart + fracPart);
  const exp = Number(expPart) - fracPart.length;
  let num, den;
  if (exp >= 0) { num = sign * digits * (10n ** BigInt(exp)); den = 1n; }
  else { num = sign * digits; den = 10n ** BigInt(-exp); }
  const g = gcdBig(num, den);
  return { n: num / g, d: den / g };
}

function ratCmp(a, b) {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

function ratMax(a, b) {
  return ratCmp(a, b) >= 0 ? a : b;
}

function monthsIn(window) {
  const result = new Set();
  let year = Number(window.from.slice(0, 4)), month = Number(window.from.slice(5, 7));
  const lastYear = Number(window.through.slice(0, 4)), lastMonth = Number(window.through.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    result.add(month);
    if (++month > 12) { month = 1; year++; }
    if (result.size === 12) break;
  }
  return [...result];
}

export const FBA_2027_DEFAULT_OFF_PEAK_WINDOW = Object.freeze({ from: '2027-02-01', through: '2027-10-14' });
export const FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW = Object.freeze({ from: '2027-02-01', through: '2027-09-30' });
export const FBA_2027_COMPANION_PEAK_STORAGE_WINDOW = Object.freeze({ from: '2027-10-01', through: '2027-12-31' });
export const FBA_2027_DEFAULT_INBOUND_WINDOW = Object.freeze({ from: '2027-01-15', through: '2027-02-01' });
export const FBA_2027_UNPUBLISHED_PEAK_WINDOW = Object.freeze({ from: '2027-10-15', through: '2028-01-14' });
export const UNPUBLISHED_2027_PEAK_MARGIN_NOTE = '待亚马逊公布 2027 旺季费率后补充';

export function isCanonical2027OffPeakWindow(window) {
  return Boolean(
    validWindow(window) &&
    window.from === FBA_2027_DEFAULT_OFF_PEAK_WINDOW.from &&
    window.through === FBA_2027_DEFAULT_OFF_PEAK_WINDOW.through,
  );
}

export function isCanonical2027OffPeakStorageWindow(window) {
  return Boolean(
    validWindow(window) &&
    window.from === FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW.from &&
    window.through === FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW.through,
  );
}

export const FBA_2027_METADATA = Object.freeze({
  version: 'US-FBA-2027-nonpeak-standard-v1',
  unified_version: 'US-FBA-2027-nonpeak-complete-v2',
  marketplace: 'US',
  currency: 'USD',
  fuel_surcharge_fraction: 0.035,
  non_peak_fulfillment_window: Object.freeze({ from: '2027-01-15', through: '2027-10-14' }),
  default_off_peak_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  default_off_peak_storage_window: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  companion_peak_storage_window: FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  default_inbound_window: FBA_2027_DEFAULT_INBOUND_WINDOW,
  unpublished_holiday_peak_window: FBA_2027_UNPUBLISHED_PEAK_WINDOW,
  unpublished_holiday_peak_note: UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
  unified_storage_effective_from: '2027-02-01',
  placement_effective_from: '2027-01-15',
  returns_non_apparel_effective_from: '2027-02-01',
  official_sources: Object.freeze({
    announcement: 'https://sellingpartners.aboutamazon.com/update-to-us-referral-and-fulfillment-by-amazon-fees-for-2027',
    fulfillment: 'https://sellercentral.amazon.com/help/hub/reference/external/GABBX6GZPA8MSZGW',
    apparel_fulfillment: 'https://sellercentral.amazon.com/help/hub/reference/external/GPDC3KPYAGDTVDJP',
    dangerous_goods_fulfillment: 'https://sellercentral.amazon.com/help/hub/reference/external/GZPA23LMZ9G6699P',
    bulky_packaging_service: 'https://sellercentral.amazon.com/help/hub/reference/external/GFGVB6C7ZF38285W',
    size_tiers: 'https://sellercentral.amazon.com/gp/help/external/GG5KW835AHDJCH8W',
    storage: 'https://sellercentral.amazon.com/help/hub/reference/external/GVZX6EAEL2KZ3SGA',
    placement: 'https://sellercentral.amazon.com/help/hub/reference/external/GC3Q44PBK8BXQW3Z',
    returns: 'https://sellercentral.amazon.com/help/hub/reference/external/GZGEQLTM3RZXUV6T',
  }),
});

// Verified 2027 US non-apparel Small Standard non-peak base rates (before 3.5% fuel surcharge).
const SMALL_STANDARD_2027_OZ = Object.freeze([
  { max_oz: 2, under_10: 2.64, '10_to_50': 3.75, over_50: 4.31, return_fee: 1.78 },
  { max_oz: 4, under_10: 2.72, '10_to_50': 3.78, over_50: 4.34, return_fee: 1.84 },
  { max_oz: 6, under_10: 2.80, '10_to_50': 3.92, over_50: 4.47, return_fee: 1.90 },
  { max_oz: 8, under_10: 2.83, '10_to_50': 3.97, over_50: 4.53, return_fee: 1.96 },
  { max_oz: 10, under_10: 2.87, '10_to_50': 4.06, over_50: 4.62, return_fee: 2.02 },
  { max_oz: 12, under_10: 2.92, '10_to_50': 4.16, over_50: 4.73, return_fee: 2.08 },
  { max_oz: 14, under_10: 2.96, '10_to_50': 4.30, over_50: 4.85, return_fee: 2.14 },
  { max_oz: 16, under_10: 2.99, '10_to_50': 4.32, over_50: 4.88, return_fee: 2.21 },
]);

// Verified 2027 US non-apparel Large Standard non-peak base rates (before 3.5% fuel surcharge).
const LARGE_STANDARD_2027_LB = Object.freeze([
  { max_lb: 0.25, under_10: 2.91, '10_to_50': 3.79, over_50: 4.35, return_fee: 2.36 },
  { max_lb: 0.50, under_10: 3.13, '10_to_50': 4.01, over_50: 4.57, return_fee: 2.70 },
  { max_lb: 0.75, under_10: 3.38, '10_to_50': 4.26, over_50: 4.83, return_fee: 3.05 },
  { max_lb: 1.00, under_10: 3.78, '10_to_50': 4.67, over_50: 5.23, return_fee: 3.39 },
  { max_lb: 1.25, under_10: 4.22, '10_to_50': 5.19, over_50: 5.75, return_fee: 3.70 },
  { max_lb: 1.50, under_10: 4.60, '10_to_50': 5.57, over_50: 6.14, return_fee: 4.01 },
  { max_lb: 1.75, under_10: 4.75, '10_to_50': 5.72, over_50: 6.29, return_fee: 4.32 },
  { max_lb: 2.00, under_10: 5.00, '10_to_50': 5.98, over_50: 6.54, return_fee: 4.63 },
  { max_lb: 2.25, under_10: 5.10, '10_to_50': 6.08, over_50: 6.64, return_fee: 4.66 },
  { max_lb: 2.50, under_10: 5.28, '10_to_50': 6.26, over_50: 6.83, return_fee: 4.68 },
  { max_lb: 2.75, under_10: 5.44, '10_to_50': 6.42, over_50: 6.99, return_fee: 4.71 },
  { max_lb: 3.00, under_10: 5.85, '10_to_50': 6.85, over_50: 7.41, return_fee: 4.73 },
]);

const LARGE_STANDARD_OVER_3LB = Object.freeze({
  under_10: 6.15,
  '10_to_50': 7.16,
  over_50: 7.73,
  step_usd: 0.08,
  step_lb: 0.25,
  return_base_usd: 5.00,
  return_step_usd: 0.05,
});

const PLACEMENT_MINIMAL_SMALL_OZ = Object.freeze([
  { max_oz: 8, range: Object.freeze([0.14, 0.32]) },
  { max_oz: 16, range: Object.freeze([0.16, 0.32]) },
]);

const PLACEMENT_MINIMAL_LARGE_LB = Object.freeze([
  { max_lb: 0.75, range: Object.freeze([0.20, 0.40]) },
  { max_lb: 1.5, range: Object.freeze([0.24, 0.50]) },
  { max_lb: 3.0, range: Object.freeze([0.34, 0.60]) },
  { max_lb: 5.0, range: Object.freeze([0.38, 0.76]) },
  { max_lb: 7.0, range: Object.freeze([0.40, 0.98]) },
  { max_lb: 10.0, range: Object.freeze([0.42, 1.20]) },
  { max_lb: 15.0, range: Object.freeze([0.44, 1.50]) },
  { max_lb: 20.0, range: Object.freeze([0.55, 1.90]) },
]);

// VERIFIED_2027_RETURN_THRESHOLDS is owned by and re-exported from src/fee-basis.mjs to keep the module graph acyclic.

const STORAGE_2027_RATES = { off_peak: 0.78, peak: 2.40 };
const BULKY_STORAGE_2027_RATES = Object.freeze({ off_peak: 0.56, peak: 1.40 });

// Official US FBA Bulky Inbound Placement Service Fee rate card (GC3Q44PBK8BXQW3Z; unchanged for 2027, mapped to Small/Medium vs Large/Extra-Large Bulky).
export const PLACEMENT_BULKY_SMALL_MEDIUM_LB = Object.freeze([
  Object.freeze({ max_lb: 5, minimal: Object.freeze([1.10, 1.60]), partial: Object.freeze([0.55, 1.10]) }),
  Object.freeze({ max_lb: 12, minimal: Object.freeze([1.75, 2.40]), partial: Object.freeze([0.65, 1.75]) }),
  Object.freeze({ max_lb: 28, minimal: Object.freeze([2.74, 3.50]), partial: Object.freeze([0.81, 2.19]) }),
  Object.freeze({ max_lb: 42, minimal: Object.freeze([3.95, 4.95]), partial: Object.freeze([1.05, 2.83]) }),
  Object.freeze({ max_lb: 50, minimal: Object.freeze([4.80, 5.95]), partial: Object.freeze([1.23, 3.32]) }),
]);

export const PLACEMENT_BULKY_LARGE_XL_LB = Object.freeze([
  Object.freeze({ max_lb: 5, minimal: Object.freeze([1.30, 1.80]), partial: Object.freeze([0.55, 1.25]) }),
  Object.freeze({ max_lb: 12, minimal: Object.freeze([2.10, 2.90]), partial: Object.freeze([0.65, 1.80]) }),
  Object.freeze({ max_lb: 28, minimal: Object.freeze([3.40, 4.10]), partial: Object.freeze([0.81, 2.30]) }),
  Object.freeze({ max_lb: 42, minimal: Object.freeze([4.70, 5.60]), partial: Object.freeze([1.05, 2.95]) }),
  Object.freeze({ max_lb: 50, minimal: Object.freeze([5.50, 6.50]), partial: Object.freeze([1.23, 3.50]) }),
]);

// Official 2027 US FBA Bulky Returns Processing Fee (GZGEQLTM3RZXUV6T; Small, Medium, Large, and Extra-Large Bulky 0–50 lb: $6.74 + $0.32/lb above first lb).
export const BULKY_RETURNS_2027_RULE = Object.freeze({
  base_first_lb_usd: 6.74,
  step_usd_per_lb_over_1: 0.32,
});

// Official 2027 US FBA Bulky 4-tier non-peak structure (effective 2027-01-15, before 3.5% fuel surcharge).
export const BULKY_2027_TIERS = Object.freeze([
  Object.freeze({
    size_tier: 'small_bulky',
    max_longest_in: 28,
    max_median_in: 24,
    max_shortest_in: 20,
    max_length_plus_girth_in: 130,
    max_weight_lb: 50,
    under_10: 6.73,
    '10_to_50': 7.51,
    over_50: 7.51,
    step_usd_per_lb_over_1: 0.39,
  }),
  Object.freeze({
    size_tier: 'medium_bulky',
    max_longest_in: 37,
    max_median_in: 28,
    max_shortest_in: 20,
    max_length_plus_girth_in: 130,
    max_weight_lb: 50,
    under_10: 6.88,
    '10_to_50': 7.66,
    over_50: 7.66,
    step_usd_per_lb_over_1: 0.39,
  }),
  Object.freeze({
    size_tier: 'large_bulky',
    max_longest_in: 52,
    max_median_in: 28,
    max_shortest_in: 28,
    max_length_plus_girth_in: 130,
    max_weight_lb: 50,
    under_10: 9.09,
    '10_to_50': 9.88,
    over_50: 9.88,
    step_usd_per_lb_over_1: 0.39,
  }),
  Object.freeze({
    size_tier: 'extra_large_bulky',
    max_longest_in: 59,
    max_median_in: 33,
    max_shortest_in: 33,
    max_length_plus_girth_in: 130,
    max_weight_lb: 50,
    under_10: 9.31,
    '10_to_50': 10.09,
    over_50: 10.09,
    step_usd_per_lb_over_1: 0.39,
  }),
]);

// Official 2027 US FBA 6-tier Oversize non-peak structure (effective 2027-01-15, before 3.5% fuel surcharge; shared by Non-Apparel & Apparel).
export const OVERSIZE_2027_TIERS = Object.freeze([
  Object.freeze({
    size_tier: 'small_oversize',
    max_longest_in: 72,
    max_length_plus_girth_in: 130,
    max_weight_lb: 50,
    base_threshold_lb: 1,
    under_10: 13.44,
    '10_to_50': 14.22,
    over_50: 14.22,
    step_usd_per_lb: 0.28,
    unit_weight_only: false,
  }),
  Object.freeze({
    size_tier: 'medium_oversize',
    max_longest_in: 78,
    max_length_plus_girth_in: 130,
    max_weight_lb: 70,
    base_threshold_lb: 51,
    under_10: 27.36,
    '10_to_50': 28.15,
    over_50: 28.15,
    step_usd_per_lb: 0.56,
    unit_weight_only: false,
  }),
  Object.freeze({
    size_tier: 'large_oversize',
    max_longest_in: 96,
    max_length_plus_girth_in: 130,
    max_weight_lb: 150,
    base_threshold_lb: 51,
    under_10: 37.97,
    '10_to_50': 38.75,
    over_50: 38.75,
    step_usd_per_lb: 0.68,
    unit_weight_only: false,
  }),
  Object.freeze({
    size_tier: 'long_oversize',
    max_longest_in: 108,
    max_length_plus_girth_in: 165,
    max_weight_lb: 150,
    base_threshold_lb: 1,
    under_10: 62.97,
    '10_to_50': 63.75,
    over_50: 63.75,
    step_usd_per_lb: 0.30,
    unit_weight_only: false,
  }),
  Object.freeze({
    size_tier: 'special_oversize_light',
    max_longest_in: Infinity,
    max_length_plus_girth_in: Infinity,
    max_weight_lb: 150,
    base_threshold_lb: 1,
    under_10: 71.09,
    '10_to_50': 71.87,
    over_50: 71.87,
    step_usd_per_lb: 0.30,
    unit_weight_only: false,
  }),
  Object.freeze({
    size_tier: 'special_oversize_heavy',
    max_longest_in: Infinity,
    max_length_plus_girth_in: Infinity,
    max_weight_lb: Infinity,
    base_threshold_lb: 151,
    under_10: 190.50,
    '10_to_50': 191.28,
    over_50: 191.28,
    step_usd_per_lb: 0.19,
    unit_weight_only: true,
  }),
]);

// Official 2027 US FBA Oversize Flat Product (shortest < 4 in AND median >= 25 in) & Overhang (median > 43 in) Handling Fees
// (effective 2027-01-15, replacing Overmax; identical across Non-Apparel, Apparel, and Dangerous Goods; cumulative if both apply).
export const OVERSIZE_HANDLING_2027_FEES = Object.freeze({
  small_oversize: Object.freeze({ flat_product_usd: 8.40, overhang_usd: 0 }),
  medium_oversize: Object.freeze({ flat_product_usd: 8.65, overhang_usd: 0 }),
  large_oversize: Object.freeze({ flat_product_usd: 9.42, overhang_usd: 0 }),
  long_oversize: Object.freeze({ flat_product_usd: 10.48, overhang_usd: 3.45 }),
  special_oversize_light: Object.freeze({ flat_product_usd: 21.67, overhang_usd: 5.23 }),
  special_oversize_heavy: Object.freeze({ flat_product_usd: 29.53, overhang_usd: 10.45 }),
});

// Official 2027 US FBA Oversize Returns Processing Fee Schedule (GZGEQLTM3RZXUV6T; Non-Apparel from 2027-02-01, Apparel & Shoes from 2027-01-15).
export const OVERSIZE_RETURNS_2027_TIERS = Object.freeze({
  small_oversize: Object.freeze({ base_usd: 26.33, base_threshold_lb: 1, step_usd_per_lb: 0.38, unit_weight_only: false }),
  medium_oversize: Object.freeze({ base_usd: 40.12, base_threshold_lb: 51, step_usd_per_lb: 0.75, unit_weight_only: false }),
  large_oversize: Object.freeze({ base_usd: 52.45, base_threshold_lb: 71, step_usd_per_lb: 0.75, unit_weight_only: false }),
  long_oversize: Object.freeze({ base_usd: 52.45, base_threshold_lb: 71, step_usd_per_lb: 0.75, unit_weight_only: false }),
  special_oversize_light: Object.freeze({ base_usd: 52.45, base_threshold_lb: 71, step_usd_per_lb: 0.75, unit_weight_only: false }),
  special_oversize_heavy: Object.freeze({ base_usd: 157.35, base_threshold_lb: 151, step_usd_per_lb: 0.19, unit_weight_only: true }),
});

// Official 2027 US Apparel Standard-Size FBA Fulfillment Fees (GPDC3KPYAGDTVDJP, non-peak 2027-01-15..2027-10-14, before 3.5% fuel surcharge).
// Note: Bulky & Oversize Apparel share BULKY_2027_TIERS / OVERSIZE_2027_TIERS; Shoes use Non-Apparel fulfillment + Apparel/Shoes returns processing.
export const SMALL_STANDARD_APPAREL_2027_OZ = Object.freeze([
  Object.freeze({ max_oz: 2, under_10: 2.83, '10_to_50': 3.92, over_50: 4.54 }),
  Object.freeze({ max_oz: 4, under_10: 2.85, '10_to_50': 3.95, over_50: 4.57 }),
  Object.freeze({ max_oz: 6, under_10: 2.90, '10_to_50': 4.01, over_50: 4.62 }),
  Object.freeze({ max_oz: 8, under_10: 3.03, '10_to_50': 4.11, over_50: 4.72 }),
  Object.freeze({ max_oz: 10, under_10: 3.17, '10_to_50': 4.25, over_50: 4.74 }),
  Object.freeze({ max_oz: 12, under_10: 3.27, '10_to_50': 4.43, over_50: 4.92 }),
  Object.freeze({ max_oz: 14, under_10: 3.38, '10_to_50': 4.55, over_50: 5.03 }),
  Object.freeze({ max_oz: 16, under_10: 3.48, '10_to_50': 4.60, over_50: 5.08 }),
]);

export const LARGE_STANDARD_APPAREL_2027_LB = Object.freeze([
  Object.freeze({ max_lb: 0.25, under_10: 3.53, '10_to_50': 4.36, over_50: 4.93 }),
  Object.freeze({ max_lb: 0.50, under_10: 3.74, '10_to_50': 4.57, over_50: 5.13 }),
  Object.freeze({ max_lb: 0.75, under_10: 3.96, '10_to_50': 4.79, over_50: 5.35 }),
  Object.freeze({ max_lb: 1.00, under_10: 4.42, '10_to_50': 5.25, over_50: 5.81 }),
  Object.freeze({ max_lb: 1.25, under_10: 5.13, '10_to_50': 5.96, over_50: 6.52 }),
  Object.freeze({ max_lb: 1.50, under_10: 5.30, '10_to_50': 6.13, over_50: 6.69 }),
  Object.freeze({ max_lb: 1.75, under_10: 5.40, '10_to_50': 6.23, over_50: 6.80 }),
  Object.freeze({ max_lb: 2.00, under_10: 5.51, '10_to_50': 6.34, over_50: 6.91 }),
  Object.freeze({ max_lb: 2.25, under_10: 5.87, '10_to_50': 6.70, over_50: 7.26 }),
  Object.freeze({ max_lb: 2.50, under_10: 5.99, '10_to_50': 6.82, over_50: 7.38 }),
  Object.freeze({ max_lb: 2.75, under_10: 6.04, '10_to_50': 6.87, over_50: 7.44 }),
  Object.freeze({ max_lb: 3.00, under_10: 6.17, '10_to_50': 7.00, over_50: 7.57 }),
]);

export const LARGE_STANDARD_APPAREL_OVER_3LB = Object.freeze({
  under_10: 6.24,
  '10_to_50': 7.07,
  over_50: 7.64,
  step_usd_per_half_lb: 0.16,
});

// Official 2027 US Apparel & Shoes Standard-Size Returns Processing Fees (GZGEQLTM3RZXUV6T, effective 2027-01-15, charged per returned unit with zero threshold).
export const APPAREL_SHOES_STANDARD_RETURNS_2027 = Object.freeze({
  small_standard_oz: Object.freeze([
    Object.freeze({ max_oz: 4, return_fee: 1.65 }),
    Object.freeze({ max_oz: 8, return_fee: 1.75 }),
    Object.freeze({ max_oz: 12, return_fee: 1.85 }),
    Object.freeze({ max_oz: 16, return_fee: 1.95 }),
  ]),
  large_standard_lb: Object.freeze([
    Object.freeze({ max_lb: 0.25, return_fee: 2.04 }),
    Object.freeze({ max_lb: 0.50, return_fee: 2.12 }),
    Object.freeze({ max_lb: 0.75, return_fee: 2.19 }),
    Object.freeze({ max_lb: 1.00, return_fee: 2.27 }),
    Object.freeze({ max_lb: 1.50, return_fee: 2.62 }),
    Object.freeze({ max_lb: 2.00, return_fee: 2.98 }),
    Object.freeze({ max_lb: 2.50, return_fee: 3.33 }),
    Object.freeze({ max_lb: 3.00, return_fee: 3.69 }),
  ]),
  large_standard_over_3lb: Object.freeze({
    return_base_usd: 3.89,
    return_step_usd_per_half_lb: 0.10,
  }),
});

// Official 2027 US Dangerous Goods (Hazmat) FBA Fulfillment Fees (GZPA23LMZ9G6699P, non-peak 2027-01-15..2027-10-14, before 3.5% fuel surcharge).
export const SMALL_STANDARD_DG_2027_OZ = Object.freeze([
  Object.freeze({ max_oz: 2, under_10: 3.57, '10_to_50': 4.59, over_50: 5.15 }),
  Object.freeze({ max_oz: 4, under_10: 3.62, '10_to_50': 4.61, over_50: 5.17 }),
  Object.freeze({ max_oz: 6, under_10: 3.69, '10_to_50': 4.75, over_50: 5.32 }),
  Object.freeze({ max_oz: 8, under_10: 3.71, '10_to_50': 4.80, over_50: 5.37 }),
  Object.freeze({ max_oz: 10, under_10: 3.74, '10_to_50': 4.88, over_50: 5.45 }),
  Object.freeze({ max_oz: 12, under_10: 3.75, '10_to_50': 4.97, over_50: 5.54 }),
  Object.freeze({ max_oz: 14, under_10: 3.79, '10_to_50': 5.01, over_50: 5.57 }),
  Object.freeze({ max_oz: 16, under_10: 3.83, '10_to_50': 5.04, over_50: 5.60 }),
]);

export const LARGE_STANDARD_DG_2027_LB = Object.freeze([
  Object.freeze({ max_lb: 0.25, under_10: 3.73, '10_to_50': 4.62, over_50: 5.18 }),
  Object.freeze({ max_lb: 0.50, under_10: 3.94, '10_to_50': 4.83, over_50: 5.40 }),
  Object.freeze({ max_lb: 0.75, under_10: 4.17, '10_to_50': 5.06, over_50: 5.63 }),
  Object.freeze({ max_lb: 1.00, under_10: 4.37, '10_to_50': 5.27, over_50: 5.83 }),
  Object.freeze({ max_lb: 1.25, under_10: 4.82, '10_to_50': 5.79, over_50: 6.36 }),
  Object.freeze({ max_lb: 1.50, under_10: 5.20, '10_to_50': 6.18, over_50: 6.74 }),
  Object.freeze({ max_lb: 1.75, under_10: 5.35, '10_to_50': 6.33, over_50: 6.90 }),
  Object.freeze({ max_lb: 2.00, under_10: 5.49, '10_to_50': 6.47, over_50: 7.04 }),
  Object.freeze({ max_lb: 2.25, under_10: 5.56, '10_to_50': 6.55, over_50: 7.11 }),
  Object.freeze({ max_lb: 2.50, under_10: 5.74, '10_to_50': 6.73, over_50: 7.29 }),
  Object.freeze({ max_lb: 2.75, under_10: 5.90, '10_to_50': 6.89, over_50: 7.45 }),
  Object.freeze({ max_lb: 3.00, under_10: 6.31, '10_to_50': 7.32, over_50: 7.88 }),
]);

export const LARGE_STANDARD_DG_OVER_3LB = Object.freeze({
  under_10: 6.61,
  '10_to_50': 7.63,
  over_50: 8.20,
  step_usd: 0.08,
});

export const BULKY_DG_2027_TIERS = Object.freeze({
  small_bulky: Object.freeze({ under_10: 7.46, '10_to_50': 8.24, over_50: 8.24, step_usd_per_lb_over_1: 0.39 }),
  medium_bulky: Object.freeze({ under_10: 7.61, '10_to_50': 8.39, over_50: 8.39, step_usd_per_lb_over_1: 0.39 }),
  large_bulky: Object.freeze({ under_10: 9.83, '10_to_50': 10.61, over_50: 10.61, step_usd_per_lb_over_1: 0.39 }),
  extra_large_bulky: Object.freeze({ under_10: 10.04, '10_to_50': 10.82, over_50: 10.82, step_usd_per_lb_over_1: 0.39 }),
});

export const OVERSIZE_DG_2027_TIERS = Object.freeze({
  small_oversize: Object.freeze({ under_10: 15.58, '10_to_50': 16.36, over_50: 16.36, base_threshold_lb: 1, step_usd_per_lb: 0.28, unit_weight_only: false }),
  medium_oversize: Object.freeze({ under_10: 30.62, '10_to_50': 31.40, over_50: 31.40, base_threshold_lb: 51, step_usd_per_lb: 0.56, unit_weight_only: false }),
  large_oversize: Object.freeze({ under_10: 45.21, '10_to_50': 45.99, over_50: 45.99, base_threshold_lb: 51, step_usd_per_lb: 0.68, unit_weight_only: false }),
  long_oversize: Object.freeze({ under_10: 70.21, '10_to_50': 70.99, over_50: 70.99, base_threshold_lb: 1, step_usd_per_lb: 0.30, unit_weight_only: false }),
  special_oversize_light: Object.freeze({ under_10: 78.33, '10_to_50': 79.11, over_50: 79.11, base_threshold_lb: 1, step_usd_per_lb: 0.30, unit_weight_only: false }),
  special_oversize_heavy: Object.freeze({ under_10: 215.44, '10_to_50': 216.23, over_50: 216.23, base_threshold_lb: 151, step_usd_per_lb: 0.19, unit_weight_only: true }),
});

// Official 2027 US Dangerous Goods Unified Monthly Storage Rates (GVZX6EAEL2KZ3SGA, 0–180 days, effective 2027-02-01).
export const DG_STORAGE_2027_RATES = Object.freeze({
  standard: Object.freeze({ off_peak: 0.99, peak: 3.63 }),
  bulky_and_oversize: Object.freeze({ off_peak: 0.78, peak: 2.43 }),
});

// Five fee categories losing <$10 Low-Price FBA eligibility from 2027-01-15 (billed at $10_to_50 when price_usd < $10).
export const LOW_PRICE_INELIGIBLE_2027_CATEGORIES = Object.freeze([
  'Automotive and Powersports',
  'Compact Appliances',
  'Computers',
  'Musical Instruments and AV Production',
  'Media - Books, DVD, Music, Software, Video',
]);

export function isCategoryLowPriceEligible2027(feeCategory) {
  if (typeof feeCategory !== 'string' || !feeCategory.trim()) return true;
  const canonical = lookupVerified2027ReturnThreshold(feeCategory)?.canonical ?? feeCategory.trim();
  return !LOW_PRICE_INELIGIBLE_2027_CATEGORIES.some(c => c.toLowerCase() === canonical.toLowerCase());
}

/**
 * Out-of-table fallback directive: whenever a candidate hits an unlisted new fee category,
 * tiered referral rule, or future fee schedule announcement, enforce the 3-step verified lookup-and-persist protocol.
 */
export function buildOutOfTableLookupDirective({ reason = '', fee_category = null, asin = null } = {}) {
  return {
    protocol_id: 'spapi_then_official_seller_central_persist_v1',
    fee_category: fee_category ?? null,
    comparable_asin: asin ?? null,
    reason,
    required_steps: [
      '1. Query read-only SP-API (catalogItems_getCatalogItem + productFees_getMyFeesEstimateForASIN + listingsRestrictions) on comparable ASIN(s) for official packaged dimensions, referral percentage, and live FBA baseline.',
      '2. Search official Amazon Seller Central help pages / 2027+ fee announcements to verify the exact published rate card and effective dates, recording explicit source URLs.',
      '3. Calculate using the verified official schedule with source attribution and persist the verified table/rule back into src/fba-rates-2027.mjs.',
    ],
  };
}

function computeOversizeOrSpecialHandlingFloor2027(pkgObj, band = '10_to_50') {
  const dims = parsePackage(pkgObj);
  if (!dims) return null;
  const { s1Rat, s2Rat, s3Rat, wtLbRat } = dims.rawRat;
  const bulkyS2Rat = ratMax(s2Rat, { n: 2n, d: 1n });
  const bulkyS3Rat = ratMax(s3Rat, { n: 2n, d: 1n });
  const bulkyCubicInRat = mulBigRat(mulBigRat(s1Rat, bulkyS2Rat), bulkyS3Rat);
  const bulkyDimLbRat = divBigRat(bulkyCubicInRat, { n: 139n, d: 1n });
  const bulkyShipLbRat = ratMax(wtLbRat, bulkyDimLbRat);
  const girthPlusLenRat = addBigRat(s1Rat, mulBigRat({ n: 2n, d: 1n }, addBigRat(s2Rat, s3Rat)));
  const fuelMultiplier = 1 + FBA_2027_METADATA.fuel_surcharge_fraction;

  for (const bTier of BULKY_2027_TIERS) {
    const fitsBulky =
      ratCmp(wtLbRat, toRat(bTier.max_weight_lb)) <= 0 &&
      ratCmp(bulkyShipLbRat, toRat(bTier.max_weight_lb)) <= 0 &&
      ratCmp(s1Rat, toRat(bTier.max_longest_in)) <= 0 &&
      ratCmp(s2Rat, toRat(bTier.max_median_in)) <= 0 &&
      ratCmp(s3Rat, toRat(bTier.max_shortest_in)) <= 0 &&
      ratCmp(girthPlusLenRat, toRat(bTier.max_length_plus_girth_in)) <= 0;
    if (fitsBulky) {
      const excessNum = bulkyShipLbRat.n - 1n * bulkyShipLbRat.d;
      const extraLbs = excessNum > 0n ? Number(ceilDivBig(excessNum, bulkyShipLbRat.d)) : 0;
      const baseUsd = round((bTier[band] ?? bTier['10_to_50']) + extraLbs * bTier.step_usd_per_lb_over_1);
      return {
        size_tier: bTier.size_tier,
        floor_usd: round(baseUsd * fuelMultiplier),
      };
    }
  }

  for (const oTier of OVERSIZE_2027_TIERS) {
    const fitsWt = oTier.max_weight_lb === Infinity || (
      ratCmp(wtLbRat, toRat(oTier.max_weight_lb)) <= 0 &&
      ratCmp(bulkyShipLbRat, toRat(oTier.max_weight_lb)) <= 0
    );
    const fitsLen = oTier.max_longest_in === Infinity || ratCmp(s1Rat, toRat(oTier.max_longest_in)) <= 0;
    const fitsGirth = oTier.max_length_plus_girth_in === Infinity || ratCmp(girthPlusLenRat, toRat(oTier.max_length_plus_girth_in)) <= 0;
    if (fitsWt && fitsLen && fitsGirth) {
      const billableRat = oTier.unit_weight_only ? wtLbRat : bulkyShipLbRat;
      const threshBig = BigInt(oTier.base_threshold_lb);
      const excessNum = billableRat.n - threshBig * billableRat.d;
      const extraLbs = excessNum > 0n ? Number(ceilDivBig(excessNum, billableRat.d)) : 0;
      const baseUsd = round((oTier[band] ?? oTier['10_to_50']) + extraLbs * oTier.step_usd_per_lb);
      const handlingRule = OVERSIZE_HANDLING_2027_FEES[oTier.size_tier] ?? { flat_product_usd: 0, overhang_usd: 0 };
      const flatFee = (ratCmp(s3Rat, { n: 4n, d: 1n }) < 0 && ratCmp(s2Rat, { n: 25n, d: 1n }) >= 0) ? handlingRule.flat_product_usd : 0;
      const overhangFee = ratCmp(s2Rat, { n: 43n, d: 1n }) > 0 ? handlingRule.overhang_usd : 0;
      return {
        size_tier: oTier.size_tier,
        floor_usd: round(round(baseUsd * fuelMultiplier) + flatFee + overhangFee),
      };
    }
  }
  return null;
}

const FBA_2027_METADATA_R58_FROZEN = Object.freeze({
  version: 'US-FBA-2027-nonpeak-standard-v1',
  marketplace: 'US',
  currency: 'USD',
  fuel_surcharge_fraction: 0.035,
  non_peak_fulfillment_window: Object.freeze({ from: '2027-01-15', through: '2027-10-14' }),
  unified_storage_effective_from: '2027-02-01',
  placement_effective_from: '2027-01-15',
  returns_non_apparel_effective_from: '2027-02-01',
  official_sources: Object.freeze({
    announcement: 'https://sellingpartners.aboutamazon.com/update-to-us-referral-and-fulfillment-by-amazon-fees-for-2027',
    fulfillment: 'https://sellercentral.amazon.com/help/hub/reference/external/GABBX6GZPA8MSZGW',
    size_tiers: 'https://sellercentral.amazon.com/gp/help/external/GG5KW835AHDJCH8W',
    storage: 'https://sellercentral.amazon.com/help/hub/reference/external/GVZX6EAEL2KZ3SGA',
    placement: 'https://sellercentral.amazon.com/help/hub/reference/external/GC3Q44PBK8BXQW3Z',
    returns: 'https://sellercentral.amazon.com/help/hub/reference/external/GZGEQLTM3RZXUV6T',
  }),
});

const VERIFIED_2027_RETURN_THRESHOLDS_R57_NOV19 = Object.freeze({
  'Business, Industrial, and Scientific Supplies': 0.06,
  'Base Equipment Power Tools': 0.071,
  'Tools and Home Improvement': 0.087,
  'Everything Else': 0.048,
});

export function getHistoricalFba2027RateTableSnapshots() {
  const r57Nov19 = {
    metadata: FBA_2027_METADATA_R58_FROZEN,
    small_standard_2027_oz: SMALL_STANDARD_2027_OZ,
    large_standard_2027_lb: LARGE_STANDARD_2027_LB,
    large_standard_over_3lb: LARGE_STANDARD_OVER_3LB,
    placement_minimal_small_oz: PLACEMENT_MINIMAL_SMALL_OZ,
    placement_minimal_large_lb: PLACEMENT_MINIMAL_LARGE_LB,
    storage_usd_per_cuft_month: STORAGE_2027_RATES,
    verified_2027_return_thresholds: VERIFIED_2027_RETURN_THRESHOLDS_R57_NOV19,
  };
  const r58Frozen = {
    metadata: FBA_2027_METADATA_R58_FROZEN,
    small_standard_2027_oz: SMALL_STANDARD_2027_OZ,
    large_standard_2027_lb: LARGE_STANDARD_2027_LB,
    large_standard_over_3lb: LARGE_STANDARD_OVER_3LB,
    bulky_2027_tiers: BULKY_2027_TIERS,
    placement_minimal_small_oz: PLACEMENT_MINIMAL_SMALL_OZ,
    placement_minimal_large_lb: PLACEMENT_MINIMAL_LARGE_LB,
    storage_usd_per_cuft_month: STORAGE_2027_RATES,
    bulky_storage_usd_per_cuft_month: BULKY_STORAGE_2027_RATES,
    verified_2027_return_thresholds: VERIFIED_2027_RETURN_THRESHOLDS,
  };
  return [r57Nov19, r58Frozen];
}

/**
 * Return the live 2027 US FBA rate tables & metadata for immutable evaluation fingerprinting.
 * Shares exact live rate objects with lookup functions so any rate-cell change alters evidence_bundle_sha256.
 * When `profileRevision <= 57` is requested, returns the Nov-19 r57 snapshot; when `profileRevision === 58`, returns the frozen r58 snapshot.
 */
export function getFba2027RateTableSnapshot({ profileRevision = 59 } = {}) {
  if (Number.isFinite(profileRevision) && profileRevision <= 57) {
    return getHistoricalFba2027RateTableSnapshots()[0];
  }
  if (Number.isFinite(profileRevision) && profileRevision <= 58) {
    return getHistoricalFba2027RateTableSnapshots()[1];
  }
  return {
    metadata: FBA_2027_METADATA,
    small_standard_2027_oz: SMALL_STANDARD_2027_OZ,
    large_standard_2027_lb: LARGE_STANDARD_2027_LB,
    large_standard_over_3lb: LARGE_STANDARD_OVER_3LB,
    bulky_2027_tiers: BULKY_2027_TIERS,
    oversize_2027_tiers: OVERSIZE_2027_TIERS,
    oversize_handling_2027_fees: OVERSIZE_HANDLING_2027_FEES,
    oversize_returns_2027_tiers: OVERSIZE_RETURNS_2027_TIERS,
    small_standard_apparel_2027_oz: SMALL_STANDARD_APPAREL_2027_OZ,
    large_standard_apparel_2027_lb: LARGE_STANDARD_APPAREL_2027_LB,
    large_standard_apparel_over_3lb: LARGE_STANDARD_APPAREL_OVER_3LB,
    apparel_shoes_standard_returns_2027: APPAREL_SHOES_STANDARD_RETURNS_2027,
    small_standard_dg_2027_oz: SMALL_STANDARD_DG_2027_OZ,
    large_standard_dg_2027_lb: LARGE_STANDARD_DG_2027_LB,
    large_standard_dg_over_3lb: LARGE_STANDARD_DG_OVER_3LB,
    bulky_dg_2027_tiers: BULKY_DG_2027_TIERS,
    oversize_dg_2027_tiers: OVERSIZE_DG_2027_TIERS,
    placement_minimal_small_oz: PLACEMENT_MINIMAL_SMALL_OZ,
    placement_minimal_large_lb: PLACEMENT_MINIMAL_LARGE_LB,
    storage_usd_per_cuft_month: STORAGE_2027_RATES,
    bulky_storage_usd_per_cuft_month: BULKY_STORAGE_2027_RATES,
    dg_storage_usd_per_cuft_month: DG_STORAGE_2027_RATES,
    low_price_ineligible_2027_categories: LOW_PRICE_INELIGIBLE_2027_CATEGORIES,
    verified_2027_return_thresholds: VERIFIED_2027_RETURN_THRESHOLDS,
  };
}

function parsePackage(pkg) {
  const dims = resolvePackageDimsRat(pkg);
  if (!dims || !dims.wtLbRat || !dims.shipLbRat) return null;
  const { s1Rat, s2Rat, s3Rat, wtLbRat, ozRat, dimLbRat, shipLbRat, cubicFtRat } = dims;
  const longest_in = Number(s1Rat.n) / Number(s1Rat.d);
  const median_in = Number(s2Rat.n) / Number(s2Rat.d);
  const shortest_in = Number(s3Rat.n) / Number(s3Rat.d);
  const unitWeightLb = Number(wtLbRat.n) / Number(wtLbRat.d);
  const dim_weight_lb = Number(dimLbRat.n) / Number(dimLbRat.d);
  const cubic_feet = Number(cubicFtRat.n) / Number(cubicFtRat.d);
  return {
    longest_in: roundBigRat(s1Rat.n, s1Rat.d, 10),
    median_in: roundBigRat(s2Rat.n, s2Rat.d, 10),
    shortest_in: roundBigRat(s3Rat.n, s3Rat.d, 10),
    unit_weight_lb: roundBigRat(wtLbRat.n, wtLbRat.d, 10),
    dim_weight_lb: roundBigRat(dimLbRat.n, dimLbRat.d, 10),
    cubic_feet: roundBigRat(cubicFtRat.n, cubicFtRat.d, 10),
    raw: { longest_in, median_in, shortest_in, unit_weight_lb: unitWeightLb, dim_weight_lb, cubic_feet },
    rawRat: { s1Rat, s2Rat, s3Rat, wtLbRat, ozRat, dimLbRat, shipLbRat, cubicFtRat },
  };
}

export function classifyStandardSize2027(pkg, { is_apparel, is_dangerous_goods, is_sipp } = {}) {
  const appCheck = resolveConsistentBoolean([is_apparel, pkg?.is_apparel, pkg?.is_apparel_or_shoes]);
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  const sippCheck = resolveConsistentBoolean([is_sipp, pkg?.is_sipp]);
  const overFlagCheck = resolveConsistentBoolean([pkg?.is_oversize]);
  if (!appCheck.valid || !dgCheck.valid || !sippCheck.valid || !overFlagCheck.valid) {
    return {
      status: 'needs_calculator_verification',
      size_tier: null,
      reason: 'Boolean flags (is_apparel, is_dangerous_goods, is_sipp, is_oversize) must be strict booleans without contradiction.',
    };
  }
  if (appCheck.value || dgCheck.value || sippCheck.value || overFlagCheck.value) {
    return {
      status: 'needs_calculator_verification',
      size_tier: null,
      reason: 'Apparel, dangerous goods, SIPP, and explicitly oversize items are outside the verified ordinary non-SIPP Standard-size table.',
    };
  }
  const dims = parsePackage(pkg);
  if (!dims) {
    return {
      status: 'needs_calculator_verification',
      size_tier: null,
      reason: 'Valid positive packaged length, width, height, and unit weight are required.',
    };
  }
  const { s1Rat, s2Rat, s3Rat, wtLbRat, ozRat, dimLbRat, shipLbRat } = dims.rawRat;
  const isSmall = ratCmp(wtLbRat, { n: 1n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 15n, d: 1n }) <= 0 &&
    ratCmp(s2Rat, { n: 12n, d: 1n }) <= 0 &&
    ratCmp(s3Rat, { n: 3n, d: 4n }) <= 0;
  if (isSmall) {
    return {
      status: 'verified',
      size_tier: 'small_standard',
      shipping_weight_lb: roundBigRat(wtLbRat.n, wtLbRat.d, 10),
      shipping_weight_oz: roundBigRat(ozRat.n, ozRat.d, 10),
      weight_basis: 'unit_weight',
      ...dims,
    };
  }
  const isLarge = ratCmp(wtLbRat, { n: 20n, d: 1n }) <= 0 &&
    ratCmp(shipLbRat, { n: 20n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 18n, d: 1n }) <= 0 &&
    ratCmp(s2Rat, { n: 14n, d: 1n }) <= 0 &&
    ratCmp(s3Rat, { n: 8n, d: 1n }) <= 0;
  if (isLarge) {
    const shipOzRat = mulBigRat(shipLbRat, { n: 16n, d: 1n });
    return {
      status: 'verified',
      size_tier: 'large_standard',
      shipping_weight_lb: roundBigRat(shipLbRat.n, shipLbRat.d, 10),
      shipping_weight_oz: roundBigRat(shipOzRat.n, shipOzRat.d, 10),
      weight_basis: ratCmp(dimLbRat, wtLbRat) > 0 ? 'dimensional_weight' : 'unit_weight',
      ...dims,
    };
  }
  const flatTriggered = ratCmp(s3Rat, { n: 4n, d: 1n }) < 0 && ratCmp(s2Rat, { n: 25n, d: 1n }) >= 0;
  const overhangTriggered = ratCmp(s2Rat, { n: 43n, d: 1n }) > 0;
  return {
    status: 'needs_calculator_verification',
    size_tier: 'bulky_or_oversize',
    reason: 'Package exceeds 2027 Large Standard limits (18 x 14 x 8 in, 20 lb); bulky/oversize rates require Revenue Calculator verification.',
    special_handling_flags: { flat_surcharge_eligible: flatTriggered, overhang_surcharge_eligible: overhangTriggered },
    ...dims,
  };
}

function extraHalfLbStepsRat(lbRat) {
  const excessNum = lbRat.n - 3n * lbRat.d;
  if (excessNum <= 0n) return 0;
  return Number(ceilDivBig(excessNum * 2n, lbRat.d));
}

/**
 * Classify a complete packaged unit across ALL 12 official 2027 US FBA size tiers:
 *  - Standard (2): `small_standard`, `large_standard`
 *  - Bulky (4): `small_bulky`, `medium_bulky`, `large_bulky`, `extra_large_bulky`
 *  - Oversize (6): `small_oversize`, `medium_oversize`, `large_oversize`, `long_oversize`, `special_oversize_light`, `special_oversize_heavy`
 * Also resolves 2027 Oversize Flat Product (`shortest < 4 in && median >= 25 in`) and Overhang (`median > 43 in`) handling fees.
 * Keeps `classifyStandardSize2027` strictly Standard-size non-apparel non-DG so `r58` callers/tests remain unchanged.
 */
export function classifySizeTier2027(pkg, { is_apparel, is_shoes, is_apparel_or_shoes, is_dangerous_goods, is_sipp } = {}) {
  const appCheck = resolveConsistentBoolean([is_apparel, pkg?.is_apparel]);
  const shoesCheck = resolveConsistentBoolean([is_shoes, pkg?.is_shoes]);
  const comboCheck = resolveConsistentBoolean([is_apparel_or_shoes, pkg?.is_apparel_or_shoes]);
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  const sippCheck = resolveConsistentBoolean([is_sipp, pkg?.is_sipp]);
  if (!appCheck.valid || !shoesCheck.valid || !comboCheck.valid || !dgCheck.valid || !sippCheck.valid ||
    (comboCheck.present && comboCheck.value === false && (appCheck.value === true || shoesCheck.value === true))) {
    return {
      status: 'needs_calculator_verification',
      reason: 'is_apparel, is_shoes, is_apparel_or_shoes, is_dangerous_goods, and is_sipp must be strict booleans without contradiction.',
    };
  }
  const dims = parsePackage(pkg);
  if (!dims) {
    return {
      status: 'needs_calculator_verification',
      reason: 'Valid positive packaged length, width, height, and unit weight are required.',
    };
  }
  const { s1Rat, s2Rat, s3Rat, wtLbRat, ozRat, dimLbRat, shipLbRat } = dims.rawRat;

  // 1) Small Standard: unit weight <= 16 oz, longest <= 15 in, median <= 12 in, shortest <= 0.75 in
  const isSmallStd =
    ratCmp(ozRat, { n: 16n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 15n, d: 1n }) <= 0 &&
    ratCmp(s2Rat, { n: 12n, d: 1n }) <= 0 &&
    ratCmp(s3Rat, { n: 3n, d: 4n }) <= 0;
  if (isSmallStd) {
    return {
      status: 'verified',
      size_tier: 'small_standard',
      shipping_weight_lb: dims.unit_weight_lb,
      shipping_weight_oz: roundBigRat(ozRat.n, ozRat.d, 10),
      weight_basis: 'unit_weight',
      special_handling_flags: {
        flat_surcharge_eligible: false,
        overhang_surcharge_eligible: false,
        flat_product_handling_fee_usd: 0,
        overhang_handling_fee_usd: 0,
        total_special_handling_usd: 0,
      },
      ...dims,
    };
  }

  // 2) Large Standard: max(unit, dim) <= 20 lb, longest <= 18 in, median <= 14 in, shortest <= 8 in
  const isLargeStd =
    ratCmp(wtLbRat, { n: 20n, d: 1n }) <= 0 &&
    ratCmp(shipLbRat, { n: 20n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 18n, d: 1n }) <= 0 &&
    ratCmp(s2Rat, { n: 14n, d: 1n }) <= 0 &&
    ratCmp(s3Rat, { n: 8n, d: 1n }) <= 0;
  if (isLargeStd) {
    const shipOzRat = mulBigRat(shipLbRat, { n: 16n, d: 1n });
    return {
      status: 'verified',
      size_tier: 'large_standard',
      shipping_weight_lb: roundBigRat(shipLbRat.n, shipLbRat.d, 10),
      shipping_weight_oz: roundBigRat(shipOzRat.n, shipOzRat.d, 10),
      weight_basis: ratCmp(dimLbRat, wtLbRat) > 0 ? 'dimensional_weight' : 'unit_weight',
      special_handling_flags: {
        flat_surcharge_eligible: false,
        overhang_surcharge_eligible: false,
        flat_product_handling_fee_usd: 0,
        overhang_handling_fee_usd: 0,
        total_special_handling_usd: 0,
      },
      ...dims,
    };
  }

  // Official Amazon US Bulky & Oversize dimensional weight rule (GABBX6GZPA8MSZGW): enforce minimum 2 inches on width & height.
  const bulkyS2Rat = ratMax(s2Rat, { n: 2n, d: 1n });
  const bulkyS3Rat = ratMax(s3Rat, { n: 2n, d: 1n });
  const bulkyCubicInRat = mulBigRat(mulBigRat(s1Rat, bulkyS2Rat), bulkyS3Rat);
  const bulkyDimLbRat = divBigRat(bulkyCubicInRat, { n: 139n, d: 1n });
  const bulkyShipLbRat = ratMax(wtLbRat, bulkyDimLbRat);
  const girthPlusLenRat = addBigRat(s1Rat, mulBigRat({ n: 2n, d: 1n }, addBigRat(s2Rat, s3Rat)));

  // 3) Bulky (4 tiers)
  for (const tier of BULKY_2027_TIERS) {
    const fits =
      ratCmp(wtLbRat, toRat(tier.max_weight_lb)) <= 0 &&
      ratCmp(bulkyShipLbRat, toRat(tier.max_weight_lb)) <= 0 &&
      ratCmp(s1Rat, toRat(tier.max_longest_in)) <= 0 &&
      ratCmp(s2Rat, toRat(tier.max_median_in)) <= 0 &&
      ratCmp(s3Rat, toRat(tier.max_shortest_in)) <= 0 &&
      ratCmp(girthPlusLenRat, toRat(tier.max_length_plus_girth_in)) <= 0;
    if (fits) {
      const shipOzRat = mulBigRat(bulkyShipLbRat, { n: 16n, d: 1n });
      return {
        status: 'verified',
        size_tier: tier.size_tier,
        tier_family: 'bulky',
        tier_rule: tier,
        ...dims,
        dim_weight_lb: roundBigRat(bulkyDimLbRat.n, bulkyDimLbRat.d, 10),
        shipping_weight_lb: roundBigRat(bulkyShipLbRat.n, bulkyShipLbRat.d, 10),
        shipping_weight_oz: roundBigRat(shipOzRat.n, shipOzRat.d, 10),
        length_plus_girth_in: roundBigRat(girthPlusLenRat.n, girthPlusLenRat.d, 10),
        weight_basis: ratCmp(bulkyDimLbRat, wtLbRat) > 0 ? 'dimensional_weight' : 'unit_weight',
        special_handling_flags: {
          flat_surcharge_eligible: false,
          overhang_surcharge_eligible: false,
          flat_product_handling_fee_usd: 0,
          overhang_handling_fee_usd: 0,
          total_special_handling_usd: 0,
        },
        rawRat: { ...dims.rawRat, dimLbRat: bulkyDimLbRat, shipLbRat: bulkyShipLbRat, girthPlusLenRat },
      };
    }
  }

  // 4) Oversize (6 tiers: small_oversize..special_oversize_heavy) + 2027 Flat Product & Overhang handling fees
  const flatTriggered = ratCmp(s3Rat, { n: 4n, d: 1n }) < 0 && ratCmp(s2Rat, { n: 25n, d: 1n }) >= 0;
  const overhangTriggered = ratCmp(s2Rat, { n: 43n, d: 1n }) > 0;
  for (const oTier of OVERSIZE_2027_TIERS) {
    const fitsWt = oTier.max_weight_lb === Infinity || (
      ratCmp(wtLbRat, toRat(oTier.max_weight_lb)) <= 0 &&
      ratCmp(bulkyShipLbRat, toRat(oTier.max_weight_lb)) <= 0
    );
    const fitsLen = oTier.max_longest_in === Infinity || ratCmp(s1Rat, toRat(oTier.max_longest_in)) <= 0;
    const fitsGirth = oTier.max_length_plus_girth_in === Infinity || ratCmp(girthPlusLenRat, toRat(oTier.max_length_plus_girth_in)) <= 0;
    if (fitsWt && fitsLen && fitsGirth) {
      const billableRat = oTier.unit_weight_only ? wtLbRat : bulkyShipLbRat;
      const shipOzRat = mulBigRat(billableRat, { n: 16n, d: 1n });
      const handlingRule = OVERSIZE_HANDLING_2027_FEES[oTier.size_tier] ?? { flat_product_usd: 0, overhang_usd: 0 };
      const flatFeeUsd = flatTriggered ? handlingRule.flat_product_usd : 0;
      const overhangFeeUsd = overhangTriggered ? handlingRule.overhang_usd : 0;
      return {
        status: 'verified',
        size_tier: oTier.size_tier,
        tier_family: 'oversize',
        tier_rule: oTier,
        ...dims,
        dim_weight_lb: roundBigRat(bulkyDimLbRat.n, bulkyDimLbRat.d, 10),
        shipping_weight_lb: roundBigRat(billableRat.n, billableRat.d, 10),
        shipping_weight_oz: roundBigRat(shipOzRat.n, shipOzRat.d, 10),
        length_plus_girth_in: roundBigRat(girthPlusLenRat.n, girthPlusLenRat.d, 10),
        weight_basis: oTier.unit_weight_only
          ? 'unit_weight'
          : (ratCmp(bulkyDimLbRat, wtLbRat) > 0 ? 'dimensional_weight' : 'unit_weight'),
        special_handling_flags: {
          flat_surcharge_eligible: flatTriggered,
          overhang_surcharge_eligible: overhangTriggered && overhangFeeUsd > 0,
          overhang_dimension_triggered: overhangTriggered,
          flat_product_handling_fee_usd: flatFeeUsd,
          overhang_handling_fee_usd: overhangFeeUsd,
          total_special_handling_usd: round(flatFeeUsd + overhangFeeUsd),
        },
        rawRat: { ...dims.rawRat, dimLbRat: bulkyDimLbRat, shipLbRat: billableRat, bulkyShipLbRat, girthPlusLenRat },
      };
    }
  }
  return {
    status: 'needs_calculator_verification',
    size_tier: 'oversize_beyond_bulky',
    reason: 'Package could not be classified into any 2027 US FBA size tier.',
    ...dims,
  };
}

export function lookupOversizeHandlingFees2027(pkg) {
  const cls = classifySizeTier2027(pkg);
  if (cls.status !== 'verified') return cls;
  const flags = cls.special_handling_flags ?? {
    flat_surcharge_eligible: false,
    overhang_surcharge_eligible: false,
    flat_product_handling_fee_usd: 0,
    overhang_handling_fee_usd: 0,
    total_special_handling_usd: 0,
  };
  return {
    status: 'verified',
    size_tier: cls.size_tier,
    applicable: flags.total_special_handling_usd > 0,
    flat_product_applies: Boolean(flags.flat_surcharge_eligible),
    overhang_applies: Boolean(flags.overhang_surcharge_eligible),
    flat_product_handling_fee_usd: flags.flat_product_handling_fee_usd ?? 0,
    overhang_handling_fee_usd: flags.overhang_handling_fee_usd ?? 0,
    total_usd: flags.total_special_handling_usd ?? 0,
    effective_from: FBA_2027_METADATA.non_peak_fulfillment_window.from,
    source_url: FBA_2027_METADATA.official_sources.fulfillment,
  };
}

// Official Amazon Seller Central US Bulky Non-SIPP Packaging Service Fee (GFGVB6C7ZF38285W, by dimensional weight):
const BULKY_NON_SIPP_PACKAGING_FEE_BY_DIM_LB = Object.freeze([
  Object.freeze({ max_dim_lb: 5, fee_usd: 1.51 }),
  Object.freeze({ max_dim_lb: 10, fee_usd: 1.68 }),
  Object.freeze({ max_dim_lb: 15, fee_usd: 1.97 }),
  Object.freeze({ max_dim_lb: 20, fee_usd: 2.60 }),
  Object.freeze({ max_dim_lb: 25, fee_usd: 2.92 }),
  Object.freeze({ max_dim_lb: 30, fee_usd: 3.47 }),
  Object.freeze({ max_dim_lb: 35, fee_usd: 3.60 }),
  Object.freeze({ max_dim_lb: 40, fee_usd: 3.78 }),
  Object.freeze({ max_dim_lb: 45, inclusive_upper: false, fee_usd: 3.80 }),
  Object.freeze({ max_dim_lb: Infinity, fee_usd: 4.04 }),
]);

/**
 * Look up the 2027 US Bulky Non-SIPP Packaging Service Fee ($1.51–$4.04 by dimensional weight, GFGVB6C7ZF38285W).
 * Defaults to non-SIPP (`requires_amazon_packaging = true` when omitted and `is_sipp !== true`) on all 4 Bulky tiers;
 * only explicit `is_sipp: true` or `requires_amazon_packaging: false` overrides the fee to $0.
 */
export function lookupBulkyPackagingServiceFee2027({
  pkg,
  is_sipp = false,
  requires_amazon_packaging,
  is_apparel,
  is_dangerous_goods,
} = {}) {
  const sippCheck = resolveConsistentBoolean([is_sipp, pkg?.is_sipp]);
  if (!sippCheck.valid) {
    return { status: 'needs_calculator_verification', reason: 'is_sipp must be a strict boolean without contradiction.' };
  }
  if (sippCheck.value === true) {
    return {
      status: 'verified',
      applicable: false,
      fee_usd: 0,
      packaging_service_status: 'sipp_certified_exempt',
      reason: 'SIPP-enrolled items are exempt from the Bulky packaging service fee.',
    };
  }
  const reqPkg = requires_amazon_packaging !== undefined ? requires_amazon_packaging : pkg?.requires_amazon_packaging;
  if (reqPkg !== undefined && typeof reqPkg !== 'boolean') {
    return {
      status: 'needs_calculator_verification',
      reason: 'requires_amazon_packaging must be a boolean when explicitly supplied.',
    };
  }
  const cls = classifySizeTier2027(pkg, { is_apparel, is_dangerous_goods, is_sipp: false });
  if (cls.status !== 'verified') return cls;
  if (cls.size_tier === 'small_standard' || cls.size_tier === 'large_standard') {
    return {
      status: 'verified',
      applicable: false,
      size_tier: cls.size_tier,
      fee_usd: 0,
      packaging_service_status: 'not_applicable_standard',
      reason: 'Standard-size items do not incur the Bulky packaging service fee.',
    };
  }
  if (!cls.size_tier.endsWith('_bulky')) {
    return {
      status: 'verified',
      applicable: false,
      size_tier: cls.size_tier,
      fee_usd: 0,
      packaging_service_status: 'not_applicable_oversize',
      reason: 'Oversize tiers beyond Extra-Large Bulky do not incur the Bulky non-SIPP packaging service fee.',
    };
  }
  const effectiveReqPkg = reqPkg === undefined ? true : reqPkg;
  if (!effectiveReqPkg) {
    return {
      status: 'verified',
      applicable: false,
      size_tier: cls.size_tier,
      dim_weight_lb: cls.dim_weight_lb,
      fee_usd: 0,
      packaging_service_status: 'own_compliant_box_exempt',
      source_url: FBA_2027_METADATA.official_sources.bulky_packaging_service,
    };
  }
  const dimRat = cls.rawRat.dimLbRat;
  const row = BULKY_NON_SIPP_PACKAGING_FEE_BY_DIM_LB.find(r => {
    if (r.max_dim_lb === Infinity) return true;
    const cmp = ratCmp(dimRat, toRat(r.max_dim_lb));
    return r.inclusive_upper === false ? cmp < 0 : cmp <= 0;
  });
  return {
    status: 'verified',
    applicable: true,
    size_tier: cls.size_tier,
    dim_weight_lb: cls.dim_weight_lb,
    fee_usd: row.fee_usd,
    packaging_service_status: reqPkg === undefined ? 'default_non_sipp_merged' : 'charged_non_sipp',
    source_url: FBA_2027_METADATA.official_sources.bulky_packaging_service,
  };
}

/**
 * Unified 2027 US FBA Fulfillment Fee Lookup across ALL 12 size tiers (Standard 2 + Bulky 4 + Oversize 6),
 * Apparel & Shoes, Dangerous Goods (Hazmat), 5 Low-Price Ineligible Categories, Default Non-SIPP Bulky Merged Packaging Fee,
 * and 2027 Oversize Flat Product & Overhang Handling Fees (`2027-01-15` through `2027-10-14`).
 */
export function lookupBulkyFulfillmentFee2027({
  pkg,
  price_usd,
  list_price_usd = undefined,
  has_ongoing_coupon = false,
  has_prime_discount = false,
  ongoing_coupon_usd = undefined,
  ongoing_coupon_pct = undefined,
  sales_window = null,
  include_fuel_surcharge = true,
  is_apparel,
  is_shoes,
  is_apparel_or_shoes,
  is_dangerous_goods,
  is_sipp,
  sipp_discount_usd = 0,
  requires_amazon_packaging = undefined,
  low_price_eligible = true,
  fee_category = null,
} = {}) {
  if (typeof include_fuel_surcharge !== 'boolean' || typeof low_price_eligible !== 'boolean') {
    return { status: 'needs_calculator_verification', reason: 'include_fuel_surcharge and low_price_eligible must be booleans.' };
  }
  if (!finite(price_usd) || price_usd <= 0) {
    return { status: 'needs_calculator_verification', reason: 'Positive finite price_usd is required.' };
  }
  if (!finite(sipp_discount_usd) || sipp_discount_usd < 0) {
    return { status: 'needs_calculator_verification', reason: 'sipp_discount_usd must be a nonnegative finite number.' };
  }
  if (sales_window !== null) {
    if (!validWindow(sales_window)) {
      return { status: 'needs_calculator_verification', reason: 'Invalid sales_window dates.' };
    }
    if (sales_window.from < FBA_2027_METADATA.non_peak_fulfillment_window.from ||
      sales_window.through > FBA_2027_METADATA.non_peak_fulfillment_window.through) {
      return {
        status: 'needs_calculator_verification',
        reason: `sales_window ${sales_window.from}..${sales_window.through} falls outside published 2027 non-peak fulfillment window (${FBA_2027_METADATA.non_peak_fulfillment_window.from}..${FBA_2027_METADATA.non_peak_fulfillment_window.through}); ${UNPUBLISHED_2027_PEAK_MARGIN_NOTE}.`,
        unpublished_peak_note: UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
      };
    }
  }

  const explicitAppCheck = resolveConsistentBoolean([is_apparel, pkg?.is_apparel]);
  const shoesCheck = resolveConsistentBoolean([is_shoes, pkg?.is_shoes]);
  const appOrShoesCheck = resolveConsistentBoolean([is_apparel_or_shoes, pkg?.is_apparel_or_shoes]);
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  const sippCheck = resolveConsistentBoolean([is_sipp, pkg?.is_sipp]);
  if (!explicitAppCheck.valid || !shoesCheck.valid || !appOrShoesCheck.valid || !dgCheck.valid || !sippCheck.valid) {
    return { status: 'needs_calculator_verification', reason: 'Boolean flags (is_apparel, is_shoes, is_dangerous_goods, is_sipp) must be strict booleans without contradiction.' };
  }
  if (explicitAppCheck.value === true && shoesCheck.value === true) {
    return { status: 'needs_calculator_verification', reason: 'Conflicting is_apparel: true and is_shoes: true on the same SKU.' };
  }
  const catLower = typeof fee_category === 'string' ? fee_category.trim().toLowerCase() : '';
  const inferredShoesFromCategory = !explicitAppCheck.present && (
    catLower === 'shoes' || catLower.includes('shoes') || catLower.includes('footwear')
  );
  const isShoesSku = shoesCheck.value === true || inferredShoesFromCategory;
  // Apparel Standard-size uses GPDC3KPYAGDTVDJP; Shoes use Non-Apparel fulfillment (GABBX6GZPA8MSZGW).
  const usesApparelFulfillmentCard = explicitAppCheck.value === true ||
    (!isShoesSku && appOrShoesCheck.value === true);
  const isDg = dgCheck.value === true;
  const isSipp = sippCheck.value === true;

  const cls = classifySizeTier2027(pkg, {
    is_apparel: usesApparelFulfillmentCard,
    is_shoes: isShoesSku,
    is_dangerous_goods: isDg,
    is_sipp: isSipp,
  });
  if (cls.status !== 'verified') return cls;

  const couponActive = Boolean(
    has_ongoing_coupon === true ||
    (finite(ongoing_coupon_usd) && ongoing_coupon_usd > 0) ||
    (finite(ongoing_coupon_pct) && ongoing_coupon_pct > 0),
  );
  const tierBasisPriceUsd = couponActive && has_prime_discount !== true && finite(list_price_usd) && list_price_usd > 0
    ? list_price_usd
    : price_usd;
  const rawBand = priceBand2027(tierBasisPriceUsd);
  const catLowPriceEligible = isCategoryLowPriceEligible2027(fee_category);
  if (rawBand === 'under_10' && !low_price_eligible && catLowPriceEligible) {
    return { status: 'needs_calculator_verification', reason: 'Category is marked ineligible for 2027 Low-Price FBA rates without a listed 2027 fee_category.' };
  }
  const lowPriceBumped = rawBand === 'under_10' && !catLowPriceEligible;
  const band = lowPriceBumped ? '10_to_50' : rawBand;
  const fuelMultiplier = include_fuel_surcharge ? (1 + FBA_2027_METADATA.fuel_surcharge_fraction) : 1;

  // A) Standard-size (Small Standard & Large Standard): Non-Apparel, Apparel, and Dangerous Goods
  if (cls.size_tier === 'small_standard' || cls.size_tier === 'large_standard') {
    if (isSipp && sipp_discount_usd === 0) {
      // Standard-size SIPP discount varies by weight/category; require explicit verified sipp_discount_usd or non-SIPP default.
      return {
        status: 'needs_calculator_verification',
        size_tier: cls.size_tier,
        reason: 'Standard-size SIPP requires an explicit verified sipp_discount_usd or default non-SIPP (is_sipp: false).',
      };
    }
    let baseUsd = null;
    let weightBracket = null;
    let extraSteps = 0;
    if (cls.size_tier === 'small_standard') {
      const table = isDg
        ? SMALL_STANDARD_DG_2027_OZ
        : (usesApparelFulfillmentCard ? SMALL_STANDARD_APPAREL_2027_OZ : SMALL_STANDARD_2027_OZ);
      const row = table.find(entry => ratCmp(cls.rawRat.ozRat, toRat(entry.max_oz)) <= 0);
      if (!row) return { status: 'needs_calculator_verification', reason: 'Small Standard weight exceeded 16 oz.' };
      baseUsd = row[band];
      weightBracket = `small_standard <= ${row.max_oz} oz`;
    } else {
      const lbRat = cls.rawRat.shipLbRat;
      if (ratCmp(lbRat, toRat(3)) <= 0) {
        const table = isDg
          ? LARGE_STANDARD_DG_2027_LB
          : (usesApparelFulfillmentCard ? LARGE_STANDARD_APPAREL_2027_LB : LARGE_STANDARD_2027_LB);
        const row = table.find(entry => ratCmp(lbRat, toRat(entry.max_lb)) <= 0);
        if (!row) return { status: 'needs_calculator_verification', reason: 'Large Standard weight bracket lookup failed.' };
        baseUsd = row[band];
        weightBracket = `large_standard <= ${row.max_lb} lb`;
      } else if (usesApparelFulfillmentCard && !isDg) {
        extraSteps = extraHalfLbStepsRat(lbRat);
        baseUsd = round(LARGE_STANDARD_APPAREL_OVER_3LB[band] + extraSteps * LARGE_STANDARD_APPAREL_OVER_3LB.step_usd_per_half_lb);
        weightBracket = `large_standard_apparel 3+ to 20 lb (${extraSteps} x 0.5 lb intervals above 3 lb)`;
      } else {
        extraSteps = extraQuarterLbStepsRat(lbRat);
        const overRule = isDg ? LARGE_STANDARD_DG_OVER_3LB : LARGE_STANDARD_OVER_3LB;
        baseUsd = round(overRule[band] + extraSteps * overRule.step_usd);
        weightBracket = `large_standard 3+ to 20 lb (${extraSteps} x 4 oz intervals above 3 lb)`;
      }
    }
    const netBaseUsd = Math.max(0, round(baseUsd - (isSipp ? sipp_discount_usd : 0)));
    const fulfillmentWithFuelUsd = round(netBaseUsd * fuelMultiplier);
    return {
      status: 'verified',
      version: isDg || usesApparelFulfillmentCard || lowPriceBumped
        ? FBA_2027_METADATA.unified_version
        : FBA_2027_METADATA.version,
      schedule_family: isDg ? 'dangerous_goods' : (usesApparelFulfillmentCard ? 'apparel' : 'non_apparel'),
      size_tier: cls.size_tier,
      price_band: band,
      ...(lowPriceBumped ? { low_price_bumped_to_10_to_50: true } : {}),
      weight_bracket: weightBracket,
      shipping_weight_lb: cls.shipping_weight_lb,
      weight_basis: cls.weight_basis,
      base_usd: netBaseUsd,
      fulfillment_with_fuel_usd: fulfillmentWithFuelUsd,
      packaging_service_fee_usd: 0,
      special_handling_fee_usd: 0,
      fuel_surcharge_included: Boolean(include_fuel_surcharge),
      fuel_surcharge_fraction: include_fuel_surcharge ? FBA_2027_METADATA.fuel_surcharge_fraction : 0,
      total_usd: fulfillmentWithFuelUsd,
      extra_steps: extraSteps,
      effective_from: FBA_2027_METADATA.non_peak_fulfillment_window.from,
      effective_through: FBA_2027_METADATA.non_peak_fulfillment_window.through,
      source_url: isDg
        ? FBA_2027_METADATA.official_sources.dangerous_goods_fulfillment
        : (usesApparelFulfillmentCard
          ? FBA_2027_METADATA.official_sources.apparel_fulfillment
          : FBA_2027_METADATA.official_sources.fulfillment),
    };
  }

  // B) Bulky (4 tiers): Non-Apparel & Apparel share BULKY_2027_TIERS; DG uses BULKY_DG_2027_TIERS.
  // Default non-SIPP automatically merges `round(base * 1.035) + non_sipp_packaging_fee($1.51–$4.04)`.
  if (cls.size_tier.endsWith('_bulky')) {
    const effReqPkg = requires_amazon_packaging !== undefined ? requires_amazon_packaging : pkg?.requires_amazon_packaging;
    if (effReqPkg !== undefined && typeof effReqPkg !== 'boolean') {
      return {
        status: 'needs_calculator_verification',
        size_tier: cls.size_tier,
        reason: 'Non-SIPP Bulky requires_amazon_packaging must be boolean when supplied.',
      };
    }
    const pkgFee = lookupBulkyPackagingServiceFee2027({
      pkg,
      is_sipp: isSipp,
      requires_amazon_packaging: effReqPkg,
      is_apparel: usesApparelFulfillmentCard,
      is_dangerous_goods: isDg,
    });
    if (pkgFee.status !== 'verified') return pkgFee;
    const packagingFeeUsd = pkgFee.fee_usd;
    const shipLbRat = cls.rawRat.shipLbRat;
    const excessNum = shipLbRat.n - 1n * shipLbRat.d;
    const extraWholeLbs = excessNum > 0n ? Number(ceilDivBig(excessNum, shipLbRat.d)) : 0;
    const tier = isDg ? BULKY_DG_2027_TIERS[cls.size_tier] : cls.tier_rule;
    const rawBaseUsd = round(tier[band] + extraWholeLbs * tier.step_usd_per_lb_over_1);
    const baseUsd = Math.max(0, round(rawBaseUsd - (isSipp ? sipp_discount_usd : 0)));
    const fulfillmentWithFuelUsd = round(baseUsd * fuelMultiplier);
    const totalUsd = round(fulfillmentWithFuelUsd + packagingFeeUsd);
    const tierFirstLbTotalUsd = round(tier[band] * fuelMultiplier);
    return {
      status: 'verified',
      version: isDg ? FBA_2027_METADATA.unified_version : 'US-FBA-2027-nonpeak-bulky4-v1',
      schedule_family: isDg ? 'dangerous_goods' : (usesApparelFulfillmentCard ? 'apparel' : 'non_apparel'),
      size_tier: cls.size_tier,
      price_band: band,
      ...(lowPriceBumped ? { low_price_bumped_to_10_to_50: true } : {}),
      weight_bracket: `${cls.size_tier} (${extraWholeLbs} lb intervals above first 1 lb)`,
      shipping_weight_lb: cls.shipping_weight_lb,
      dim_weight_lb: cls.dim_weight_lb,
      weight_basis: cls.weight_basis,
      base_usd: baseUsd,
      fulfillment_with_fuel_usd: fulfillmentWithFuelUsd,
      packaging_service_fee_usd: packagingFeeUsd,
      packaging_service_status: pkgFee.packaging_service_status,
      special_handling_fee_usd: 0,
      tier_first_lb_total_usd: tierFirstLbTotalUsd,
      extra_lb_steps: extraWholeLbs,
      fuel_surcharge_included: Boolean(include_fuel_surcharge),
      fuel_surcharge_fraction: include_fuel_surcharge ? FBA_2027_METADATA.fuel_surcharge_fraction : 0,
      total_usd: totalUsd,
      effective_from: FBA_2027_METADATA.non_peak_fulfillment_window.from,
      effective_through: FBA_2027_METADATA.non_peak_fulfillment_window.through,
      source_url: isDg
        ? FBA_2027_METADATA.official_sources.dangerous_goods_fulfillment
        : FBA_2027_METADATA.official_sources.fulfillment,
    };
  }

  // C) Oversize (6 tiers): Non-Apparel & Apparel share OVERSIZE_2027_TIERS; DG uses OVERSIZE_DG_2027_TIERS;
  // stacks 2027 Flat Product & Overhang handling fees (fuel multiplies base fulfillment only).
  const oTier = isDg ? OVERSIZE_DG_2027_TIERS[cls.size_tier] : cls.tier_rule;
  if (!oTier) {
    return { status: 'needs_calculator_verification', reason: `Unlisted Oversize tier: ${cls.size_tier}` };
  }
  const billableRat = cls.rawRat.shipLbRat;
  const threshBig = BigInt(oTier.base_threshold_lb);
  const excessNum = billableRat.n - threshBig * billableRat.d;
  const extraWholeLbs = excessNum > 0n ? Number(ceilDivBig(excessNum, billableRat.d)) : 0;
  const rawBaseUsd = round(oTier[band] + extraWholeLbs * oTier.step_usd_per_lb);
  const baseUsd = Math.max(0, round(rawBaseUsd - (isSipp ? sipp_discount_usd : 0)));
  const fulfillmentWithFuelUsd = round(baseUsd * fuelMultiplier);
  const flags = cls.special_handling_flags ?? {};
  const flatFeeUsd = flags.flat_product_handling_fee_usd ?? 0;
  const overhangFeeUsd = flags.overhang_handling_fee_usd ?? 0;
  const specialHandlingUsd = round(flatFeeUsd + overhangFeeUsd);
  const totalUsd = round(fulfillmentWithFuelUsd + specialHandlingUsd);
  const tierBaseTotalUsd = round(round(oTier[band] * fuelMultiplier) + specialHandlingUsd);
  return {
    status: 'verified',
    version: FBA_2027_METADATA.unified_version,
    schedule_family: isDg ? 'dangerous_goods' : (usesApparelFulfillmentCard ? 'apparel' : 'non_apparel'),
    size_tier: cls.size_tier,
    price_band: band,
    ...(lowPriceBumped ? { low_price_bumped_to_10_to_50: true } : {}),
    weight_bracket: `${cls.size_tier} (${extraWholeLbs} lb intervals above ${oTier.base_threshold_lb} lb)`,
    shipping_weight_lb: cls.shipping_weight_lb,
    dim_weight_lb: cls.dim_weight_lb,
    weight_basis: cls.weight_basis,
    base_usd: baseUsd,
    fulfillment_with_fuel_usd: fulfillmentWithFuelUsd,
    packaging_service_fee_usd: 0,
    packaging_service_status: 'not_applicable_oversize',
    flat_product_handling_fee_usd: flatFeeUsd,
    overhang_handling_fee_usd: overhangFeeUsd,
    special_handling_fee_usd: specialHandlingUsd,
    tier_first_lb_total_usd: tierBaseTotalUsd,
    extra_lb_steps: extraWholeLbs,
    fuel_surcharge_included: Boolean(include_fuel_surcharge),
    fuel_surcharge_fraction: include_fuel_surcharge ? FBA_2027_METADATA.fuel_surcharge_fraction : 0,
    total_usd: totalUsd,
    effective_from: FBA_2027_METADATA.non_peak_fulfillment_window.from,
    effective_through: FBA_2027_METADATA.non_peak_fulfillment_window.through,
    source_url: isDg
      ? FBA_2027_METADATA.official_sources.dangerous_goods_fulfillment
      : FBA_2027_METADATA.official_sources.fulfillment,
  };
}

export const lookupUnifiedFulfillmentFee2027 = lookupBulkyFulfillmentFee2027;
export const lookupOversizeFulfillmentFee2027 = lookupBulkyFulfillmentFee2027;
export const lookupApparelFulfillmentFee2027 = (params = {}) =>
  lookupBulkyFulfillmentFee2027({ ...params, is_apparel: params.is_shoes === true ? false : (params.is_apparel ?? true) });
export const lookupDangerousGoodsFulfillmentFee2027 = (params = {}) =>
  lookupBulkyFulfillmentFee2027({ ...params, is_dangerous_goods: true });

export function lookupBulkyStorageFee2027({
  pkg,
  storage_window = null,
  months = null,
  average_inventory_days = 45,
  inventory_age_days = 45,
  is_apparel,
  is_dangerous_goods,
} = {}) {
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  if (!dgCheck.valid) {
    return { status: 'needs_calculator_verification', reason: 'is_dangerous_goods must be a strict boolean without contradiction.' };
  }
  const isDg = dgCheck.value === true;
  const cls = classifySizeTier2027(pkg, { is_apparel, is_dangerous_goods: isDg });
  if (cls.status !== 'verified') return cls;
  const isStandard = cls.size_tier === 'small_standard' || cls.size_tier === 'large_standard';
  if (isStandard && !isDg) {
    return lookupStorageFee2027({ pkg, storage_window, months, average_inventory_days, inventory_age_days, is_dangerous_goods: false });
  }
  if (!finite(average_inventory_days) || average_inventory_days < 45) {
    return { status: 'needs_calculator_verification', reason: 'average_inventory_days must be at least 45.' };
  }
  if (!finite(inventory_age_days) || inventory_age_days < 0 || inventory_age_days > 180) {
    return { status: 'needs_calculator_verification', reason: 'Only 0–180 day unified storage is verified in this lookup.' };
  }
  let targetMonths = months;
  if (storage_window !== null) {
    if (!validWindow(storage_window) || storage_window.from < FBA_2027_METADATA.unified_storage_effective_from || storage_window.through > '2027-12-31') {
      return { status: 'needs_calculator_verification', reason: 'storage_window must lie within 2027-02-01..2027-12-31.' };
    }
    const winMonths = monthsIn(storage_window);
    if (Array.isArray(months) && (months.some(m => !winMonths.includes(m)) || winMonths.some(m => !months.includes(m)))) {
      return { status: 'needs_calculator_verification', reason: 'Supplied months conflict with storage_window.' };
    }
    targetMonths = winMonths;
  }
  if (!Array.isArray(targetMonths) || targetMonths.length === 0 || targetMonths.some(m => !Number.isInteger(m) || m < 1 || m > 12)) {
    return { status: 'needs_calculator_verification', reason: 'Explicit valid storage_window or months array is required.' };
  }
  const hasOffPeak = targetMonths.some(m => m <= 9);
  const hasPeak = targetMonths.some(m => m >= 10);
  if (hasOffPeak && hasPeak) {
    return { status: 'needs_calculator_verification', reason: 'Storage window mixes Jan–Sep and Oct–Dec rates; evaluate seasons separately.' };
  }
  const rateCard = isDg
    ? (isStandard ? DG_STORAGE_2027_RATES.standard : DG_STORAGE_2027_RATES.bulky_and_oversize)
    : (isStandard ? STORAGE_2027_RATES : BULKY_STORAGE_2027_RATES);
  const rateUsdPerCuftMonth = hasPeak ? rateCard.peak : rateCard.off_peak;
  const allocatedRat = divBigRat(
    mulBigRat(mulBigRat(cls.rawRat.cubicFtRat, toBigRat(rateUsdPerCuftMonth)), toBigRat(average_inventory_days)),
    { n: 30n, d: 1n },
  );
  return {
    status: 'verified',
    version: isDg || cls.tier_family === 'oversize' ? FBA_2027_METADATA.unified_version : 'US-FBA-2027-nonpeak-bulky4-v1',
    schedule_family: isDg ? 'dangerous_goods' : 'general',
    size_tier: cls.size_tier,
    season: hasPeak ? 'peak_oct_dec' : 'off_peak_jan_sep',
    cubic_feet: cls.cubic_feet,
    rate_usd_per_cuft_month: rateUsdPerCuftMonth,
    average_inventory_days,
    per_unit_usd: roundBigRat(allocatedRat.n, allocatedRat.d, 10),
    effective_from: FBA_2027_METADATA.unified_storage_effective_from,
    source_url: FBA_2027_METADATA.official_sources.storage,
  };
}

export const lookupUnifiedStorageFee2027 = lookupBulkyStorageFee2027;
export const lookupDangerousGoodsStorageFee2027 = (params = {}) =>
  lookupBulkyStorageFee2027({ ...params, is_dangerous_goods: true });

export function lookupBulkyPlacementFee2027({
  pkg,
  inbound_window = null,
  split_option = 'minimal_west_conservative',
  is_apparel,
  is_dangerous_goods,
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = false,
} = {}) {
  if (inbound_window !== null) {
    if (!validWindow(inbound_window)) {
      return { status: 'needs_calculator_verification', reason: 'Invalid inbound_window.' };
    }
    if (inbound_window.from < FBA_2027_METADATA.placement_effective_from) {
      return { status: 'needs_calculator_verification', reason: 'inbound_window precedes 2027-01-15 placement schedule.' };
    }
  }
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  if (!dgCheck.valid) {
    return { status: 'needs_calculator_verification', reason: 'is_dangerous_goods must be a strict boolean without contradiction.' };
  }
  const cls = classifySizeTier2027(pkg, { is_apparel, is_dangerous_goods: dgCheck.value });
  if (cls.status !== 'verified') return cls;
  const effOptCartons = Number.isInteger(identical_cartons_count) ? identical_cartons_count : null;
  const optVerified = isAmazonOptimizedPlacementVerified2027({
    identical_cartons_count: effOptCartons,
    multi_destination_headhaul_verified,
  });
  if (cls.size_tier === 'small_standard' || cls.size_tier === 'large_standard') {
    if (split_option === 'amazon_optimized') {
      if (!optVerified) {
        return {
          status: 'sensitivity_only',
          version: FBA_2027_METADATA.version,
          size_tier: cls.size_tier,
          split_option,
          range_usd: [0, 0],
          selected_usd: 0,
          reason: 'Standard-size amazon_optimized ($0 placement) requires >= 5 identical cartons AND verified multi-destination headhaul freight; sensitivity-only otherwise.',
          effective_from: FBA_2027_METADATA.placement_effective_from,
          source_url: FBA_2027_METADATA.official_sources.placement,
        };
      }
      return {
        status: 'verified',
        version: FBA_2027_METADATA.version,
        size_tier: cls.size_tier,
        split_option,
        range_usd: [0, 0],
        selected_usd: 0,
        identical_cartons_count: effOptCartons,
        multi_destination_headhaul_verified: true,
        note: 'Amazon-optimized splits incur $0 placement fee (>=5 identical cartons and multi-destination headhaul verified).',
        effective_from: FBA_2027_METADATA.placement_effective_from,
        source_url: FBA_2027_METADATA.official_sources.placement,
      };
    }
    const range = cls.size_tier === 'small_standard'
      ? (PLACEMENT_MINIMAL_SMALL_OZ.find(r => ratCmp(cls.rawRat.ozRat, toRat(r.max_oz)) <= 0)?.range ?? null)
      : (PLACEMENT_MINIMAL_LARGE_LB.find(r => ratCmp(cls.rawRat.shipLbRat, toRat(r.max_lb)) <= 0)?.range ?? null);
    if (!range) return { status: 'needs_calculator_verification', reason: 'Unlisted placement weight bracket.' };
    const selectedUsd = split_option === 'minimal_east_low' ? range[0] : range[1];
    return {
      status: 'verified',
      version: FBA_2027_METADATA.version,
      size_tier: cls.size_tier,
      split_option,
      range_usd: [...range],
      selected_usd: selectedUsd,
      effective_from: FBA_2027_METADATA.placement_effective_from,
      source_url: FBA_2027_METADATA.official_sources.placement,
    };
  }
  if (cls.tier_family === 'oversize') {
    return {
      status: 'verified',
      version: FBA_2027_METADATA.unified_version,
      size_tier: cls.size_tier,
      split_option,
      exempt_oversize_tier: true,
      range_usd: [0, 0],
      selected_usd: 0,
      note: '2027 Oversize tiers beyond Extra-Large Bulky are exempt ($0.00) from FBA inbound placement service fees (GC3Q44PBK8BXQW3Z).',
      effective_from: FBA_2027_METADATA.placement_effective_from,
      source_url: FBA_2027_METADATA.official_sources.placement,
    };
  }
  if (split_option === 'amazon_optimized') {
    if (!optVerified) {
      return {
        status: 'sensitivity_only',
        version: 'US-FBA-2027-nonpeak-bulky4-v1',
        size_tier: cls.size_tier,
        split_option,
        range_usd: [0, 0],
        selected_usd: 0,
        reason: 'Bulky amazon_optimized ($0 placement) requires >= 5 identical cartons AND verified multi-destination headhaul freight; sensitivity-only otherwise.',
        effective_from: FBA_2027_METADATA.placement_effective_from,
        source_url: FBA_2027_METADATA.official_sources.placement,
      };
    }
    return {
      status: 'verified',
      version: 'US-FBA-2027-nonpeak-bulky4-v1',
      size_tier: cls.size_tier,
      split_option,
      range_usd: [0, 0],
      selected_usd: 0,
      identical_cartons_count: effOptCartons,
      multi_destination_headhaul_verified: true,
      note: 'Amazon-optimized splits incur $0 placement fee (>=5 identical cartons and multi-destination headhaul verified).',
      effective_from: FBA_2027_METADATA.placement_effective_from,
      source_url: FBA_2027_METADATA.official_sources.placement,
    };
  }
  const table = (cls.size_tier === 'small_bulky' || cls.size_tier === 'medium_bulky')
    ? PLACEMENT_BULKY_SMALL_MEDIUM_LB
    : PLACEMENT_BULKY_LARGE_XL_LB;
  const row = table.find(r => ratCmp(cls.rawRat.shipLbRat, toRat(r.max_lb)) <= 0) ?? null;
  if (!row) return { status: 'needs_calculator_verification', reason: 'Unlisted bulky placement weight bracket (>50 lb).' };
  const isPartial = split_option === 'partial_east_low' || split_option === 'partial_west_conservative';
  const range = isPartial ? row.partial : row.minimal;
  const isLow = split_option === 'minimal_east_low' || split_option === 'partial_east_low';
  const selectedUsd = isLow ? range[0] : range[1];
  return {
    status: 'verified',
    version: 'US-FBA-2027-nonpeak-bulky4-v1',
    size_tier: cls.size_tier,
    shipping_weight_lb: cls.shipping_weight_lb,
    split_option,
    range_usd: [...range],
    selected_usd: selectedUsd,
    effective_from: FBA_2027_METADATA.placement_effective_from,
    source_url: FBA_2027_METADATA.official_sources.placement,
  };
}

export const lookupUnifiedPlacementFee2027 = lookupBulkyPlacementFee2027;

export function lookupBulkyReturnsProcessing2027({
  pkg,
  physical_return_fraction,
  fee_category = null,
  return_threshold = null,
  sales_window = null,
  is_apparel,
  is_shoes,
  is_apparel_or_shoes,
  is_dangerous_goods,
} = {}) {
  const appCheck = resolveConsistentBoolean([is_apparel_or_shoes, is_apparel, is_shoes, pkg?.is_apparel_or_shoes, pkg?.is_apparel, pkg?.is_shoes]);
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  if (!appCheck.valid || !dgCheck.valid) {
    // Allow e.g. is_apparel: false + is_shoes: true without false contradiction!
    const expApp = resolveConsistentBoolean([is_apparel, pkg?.is_apparel]);
    const expShoes = resolveConsistentBoolean([is_shoes, pkg?.is_shoes]);
    const expCombo = resolveConsistentBoolean([is_apparel_or_shoes, pkg?.is_apparel_or_shoes]);
    if (!expApp.valid || !expShoes.valid || !expCombo.valid || !dgCheck.valid ||
      (expCombo.present && expCombo.value === false && (expApp.value === true || expShoes.value === true))) {
      return { status: 'needs_calculator_verification', reason: 'is_apparel_or_shoes / is_apparel / is_shoes / is_dangerous_goods must be strict booleans without contradiction.' };
    }
  }
  const catLower = typeof fee_category === 'string' ? fee_category.trim().toLowerCase() : '';
  const isApparelOrShoes = Boolean(
    is_apparel_or_shoes === true || is_apparel === true || is_shoes === true ||
    pkg?.is_apparel_or_shoes === true || pkg?.is_apparel === true || pkg?.is_shoes === true ||
    catLower === 'apparel' || catLower === 'clothing and accessories' || catLower === 'shoes',
  );
  if (!finite(physical_return_fraction) || physical_return_fraction < 0 || physical_return_fraction >= 1) {
    return { status: 'needs_calculator_verification', reason: 'physical_return_fraction in [0, 1) is required.' };
  }
  const cls = classifySizeTier2027(pkg, { is_dangerous_goods: dgCheck.value });
  if (cls.status !== 'verified') return cls;

  const effectiveFrom = isApparelOrShoes ? '2027-01-15' : FBA_2027_METADATA.returns_non_apparel_effective_from;
  if (sales_window !== null && sales_window !== undefined) {
    if (!validWindow(sales_window) || sales_window.from < effectiveFrom || sales_window.through > '2027-12-31') {
      return {
        status: 'needs_calculator_verification',
        reason: `sales_window must lie within ${effectiveFrom}..2027-12-31 for the 2027 returns-processing schedule.`,
      };
    }
  }

  let threshold = 0;
  let canonicalCat = 'Apparel and Shoes';
  if (!isApparelOrShoes) {
    const catMatch = lookupVerified2027ReturnThreshold(fee_category);
    if (!catMatch) {
      const reason = `A listed 2027 fee_category is required (received ${fee_category ?? 'none'}).`;
      return {
        status: 'needs_calculator_verification',
        reason,
        out_of_table_protocol: buildOutOfTableLookupDirective({ reason, fee_category }),
      };
    }
    threshold = catMatch.threshold;
    canonicalCat = catMatch.canonical;
    if (return_threshold !== null && return_threshold !== undefined && (!finite(return_threshold) || return_threshold !== threshold)) {
      return {
        status: 'needs_calculator_verification',
        reason: `Supplied return_threshold (${return_threshold}) conflicts with verified 2027 threshold (${threshold}) for ${fee_category}.`,
      };
    }
  }

  let perReturnFee = null;
  let extraWholeLbs = 0;
  if (cls.size_tier === 'small_standard') {
    if (isApparelOrShoes) {
      perReturnFee = APPAREL_SHOES_STANDARD_RETURNS_2027.small_standard_oz.find(r => ratCmp(cls.rawRat.ozRat, toRat(r.max_oz)) <= 0)?.return_fee ?? null;
    } else {
      perReturnFee = SMALL_STANDARD_2027_OZ.find(r => ratCmp(cls.rawRat.ozRat, toRat(r.max_oz)) <= 0)?.return_fee ?? null;
    }
  } else if (cls.size_tier === 'large_standard') {
    const lbRat = cls.rawRat.shipLbRat;
    if (isApparelOrShoes) {
      if (ratCmp(lbRat, toRat(3)) <= 0) {
        perReturnFee = APPAREL_SHOES_STANDARD_RETURNS_2027.large_standard_lb.find(r => ratCmp(lbRat, toRat(r.max_lb)) <= 0)?.return_fee ?? null;
      } else {
        extraWholeLbs = extraHalfLbStepsRat(lbRat);
        perReturnFee = round(
          APPAREL_SHOES_STANDARD_RETURNS_2027.large_standard_over_3lb.return_base_usd +
          extraWholeLbs * APPAREL_SHOES_STANDARD_RETURNS_2027.large_standard_over_3lb.return_step_usd_per_half_lb,
        );
      }
    } else if (ratCmp(lbRat, toRat(3)) <= 0) {
      perReturnFee = LARGE_STANDARD_2027_LB.find(r => ratCmp(lbRat, toRat(r.max_lb)) <= 0)?.return_fee ?? null;
    } else {
      extraWholeLbs = extraQuarterLbStepsRat(lbRat);
      perReturnFee = round(LARGE_STANDARD_OVER_3LB.return_base_usd + extraWholeLbs * LARGE_STANDARD_OVER_3LB.return_step_usd);
    }
  } else if (cls.size_tier.endsWith('_bulky')) {
    const shipLbRat = cls.rawRat.shipLbRat;
    const excessLbNum = shipLbRat.n - 1n * shipLbRat.d;
    extraWholeLbs = excessLbNum > 0n ? Number(ceilDivBig(excessLbNum, shipLbRat.d)) : 0;
    perReturnFee = round(BULKY_RETURNS_2027_RULE.base_first_lb_usd + extraWholeLbs * BULKY_RETURNS_2027_RULE.step_usd_per_lb_over_1);
  } else if (cls.tier_family === 'oversize') {
    const retRule = OVERSIZE_RETURNS_2027_TIERS[cls.size_tier];
    if (!retRule) {
      return { status: 'needs_calculator_verification', reason: `Unlisted Oversize returns-processing tier: ${cls.size_tier}` };
    }
    const billableRat = retRule.unit_weight_only ? cls.rawRat.wtLbRat : cls.rawRat.shipLbRat;
    const threshBig = BigInt(retRule.base_threshold_lb);
    const excessLbNum = billableRat.n - threshBig * billableRat.d;
    extraWholeLbs = excessLbNum > 0n ? Number(ceilDivBig(excessLbNum, billableRat.d)) : 0;
    perReturnFee = round(retRule.base_usd + extraWholeLbs * retRule.step_usd_per_lb);
  }
  if (perReturnFee === null) {
    return { status: 'needs_calculator_verification', reason: 'Unlisted returns-processing weight bracket.' };
  }
  const excessFraction = isApparelOrShoes ? physical_return_fraction : Math.max(0, round(physical_return_fraction - threshold));
  const expectedPerShippedUnit = round(excessFraction * perReturnFee);
  return {
    status: 'verified',
    version: isApparelOrShoes || cls.tier_family === 'oversize' ? FBA_2027_METADATA.unified_version : (cls.size_tier.endsWith('_bulky') ? 'US-FBA-2027-nonpeak-bulky4-v1' : FBA_2027_METADATA.version),
    size_tier: cls.size_tier,
    shipping_weight_lb: cls.shipping_weight_lb,
    fee_category,
    fee_category_canonical: canonicalCat,
    is_apparel_or_shoes: isApparelOrShoes,
    r_physical: physical_return_fraction,
    return_threshold: isApparelOrShoes ? null : threshold,
    per_return_fee_usd: perReturnFee,
    extra_lb_steps: extraWholeLbs,
    excess_return_fraction: excessFraction,
    expected_fee_per_shipped_unit_usd: expectedPerShippedUnit,
    effective_from: effectiveFrom,
    source_url: FBA_2027_METADATA.official_sources.returns,
  };
}

export const lookupUnifiedReturnsProcessing2027 = lookupBulkyReturnsProcessing2027;

/**
 * Validate a public logged-out guest Amazon Revenue Calculator (`https://sellercentral.amazon.com/revcalpublic`)
 * readback and convert it into a scope-bound `calculator_verified_override`:
 *  - Rejects any non-`revcalpublic` seller console/login URL or `guest_logged_out !== true`.
 *  - Anti-429 guard: rejects when `getfeeswithnew` HTTP 429 silently blanks the right-hand standard FBA column
 *    (`fba_panel_present !== true` or missing positive `fulfillment_usd` / `storage_per_unit_usd`).
 */
export function validateGuestRevcalReadback(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error_code: 'invalid_payload', reason: 'Guest revcal readback must be an object.' };
  }
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!/^https:\/\/sellercentral\.amazon\.com\/revcalpublic(?:[/?#]|$)/i.test(url)) {
    return {
      valid: false,
      error_code: 'forbidden_non_guest_revcal_url',
      reason: `Only https://sellercentral.amazon.com/revcalpublic is permitted; got "${url || 'empty'}".`,
    };
  }
  if (raw.guest_logged_out !== true || raw.login_prompt_detected === true) {
    return {
      valid: false,
      error_code: 'not_logged_out_guest_state',
      reason: 'Guest Revenue Calculator requires verified logged-out guest mode without sign-in prompts.',
    };
  }
  if (raw.http_status === 429 || (finite(raw.http_status) && raw.http_status >= 400) || raw.rate_limited === true) {
    return {
      valid: false,
      error_code: 'revcal_429_rate_limited',
      reason: 'Guest Revenue Calculator response flagged HTTP 429 / rate limit; positive stale fee fields cannot be accepted.',
    };
  }
  if (raw.fba_panel_present !== true || raw.awd_only === true ||
    raw.right_column_fba_non_empty === false || raw.standard_fba_column_non_empty === false ||
    !finite(raw.fulfillment_usd) || raw.fulfillment_usd <= 0 ||
    !finite(raw.storage_per_unit_usd) || raw.storage_per_unit_usd <= 0) {
    return {
      valid: false,
      error_code: 'revcal_429_empty_fba_column',
      reason: 'Right-hand standard Amazon FBA column is empty or missing (likely silent HTTP 429 on getfeeswithnew); AWD-only readbacks are rejected.',
    };
  }
  if (!finite(raw.placement_usd) || raw.placement_usd < 0) {
    return { valid: false, error_code: 'missing_placement_usd', reason: 'Nonnegative placement_usd is required from Guest Revenue Calculator.' };
  }
  const returnsUsd = raw.returns_processing_usd ?? 0;
  if (!finite(returnsUsd) || returnsUsd < 0) {
    return { valid: false, error_code: 'invalid_returns_processing_usd', reason: 'Nonnegative returns_processing_usd is required.' };
  }
  const override = {
    verified_by: 'guest_revcalpublic',
    observed_at: raw.observed_at,
    evidence_ref: typeof raw.evidence_ref === 'string' && raw.evidence_ref.trim() ? raw.evidence_ref.trim() : `guest-revcal:${raw.observed_at}`,
    verified_price_usd: raw.verified_price_usd ?? raw.price_usd,
    verified_price_band: raw.verified_price_band ?? priceBand2027(raw.verified_price_usd ?? raw.price_usd),
    effective_from: raw.effective_from,
    effective_through: raw.effective_through,
    pkg: raw.pkg,
    size_tier: raw.size_tier ?? 'guest_revcal_verified',
    fulfillment_usd: raw.fulfillment_usd,
    storage_per_unit_usd: raw.storage_per_unit_usd,
    placement_usd: raw.placement_usd,
    returns_processing_usd: returnsUsd,
    ...(raw.fee_category ? { fee_category: raw.fee_category } : {}),
    ...(raw.notes ? { notes: raw.notes } : {}),
  };
  return { valid: true, error_code: null, override };
}

/**
 * Compute median packaged specs across `3–5` (or >=1 with low-peer warning) matched Amazon FBA peers.
 * Prioritizes SP-API official `catalogItems_getCatalogItem` package records over stale SellerSprite cached
 * dimensions for the same ASIN, and never overwrites Amazon retail package specs with 1688 nominal box specs
 * (flagging cliff-crossing 1688 nominal box specs with `'拿样必测彩盒压线预警'` without splitting primary scenarios).
 */
export function computeMatchedPeerMedianPackage(peers = [], { supplier_nominal_pkg = null } = {}) {
  if (!Array.isArray(peers) || peers.length === 0) {
    throw new TypeError('computeMatchedPeerMedianPackage requires a nonempty peers array.');
  }
  const isSpApiOfficial = p => Boolean(
    p?.is_sp_api_official === true ||
    /^sp[-_]?api/i.test(String(p?.source ?? p?.dimension_source ?? '')),
  );
  const spApiByAsin = new Map();
  for (const p of peers) {
    const asin = typeof p?.asin === 'string' && p.asin.trim() ? p.asin.trim().toUpperCase() : null;
    if (asin && isSpApiOfficial(p) && parsePackage(p)) {
      spApiByAsin.set(asin, p);
    }
  }
  const overriddenStaleSellerSpriteAsins = [];
  const seenSpApiAsins = new Set();
  const parsedPeers = [];
  for (const p of peers) {
    const asin = typeof p?.asin === 'string' && p.asin.trim() ? p.asin.trim().toUpperCase() : null;
    const officialOverride = asin ? spApiByAsin.get(asin) : null;
    if (officialOverride) {
      if (!isSpApiOfficial(p) && !overriddenStaleSellerSpriteAsins.includes(asin)) {
        overriddenStaleSellerSpriteAsins.push(asin);
      }
      if (seenSpApiAsins.has(asin)) continue;
      seenSpApiAsins.add(asin);
      const dims = parsePackage(officialOverride);
      if (!dims) continue;
      parsedPeers.push({
        asin,
        is_sp_api_official: true,
        longest_in: dims.longest_in,
        median_in: dims.median_in,
        shortest_in: dims.shortest_in,
        unit_weight_lb: dims.unit_weight_lb,
      });
      continue;
    }
    const dims = parsePackage(p);
    if (!dims) continue;
    parsedPeers.push({
      asin,
      is_sp_api_official: isSpApiOfficial(p),
      longest_in: dims.longest_in,
      median_in: dims.median_in,
      shortest_in: dims.shortest_in,
      unit_weight_lb: dims.unit_weight_lb,
    });
  }
  if (parsedPeers.length === 0) {
    throw new TypeError('At least one matched FBA peer with valid positive dimensions and weight is required.');
  }
  const med = arr => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : round((s[m - 1] + s[m]) / 2);
  };
  const medianPkg = {
    length_in: med(parsedPeers.map(p => p.longest_in)),
    width_in: med(parsedPeers.map(p => p.median_in)),
    height_in: med(parsedPeers.map(p => p.shortest_in)),
    unit_weight_lb: med(parsedPeers.map(p => p.unit_weight_lb)),
  };
  const peerTier = classifySizeTier2027(medianPkg);
  const peerFulSample = lookupBulkyFulfillmentFee2027({ pkg: medianPkg, price_usd: 39.99 });

  let supplierCliffCrossed = false;
  let supplierStressPkg = null;
  let supplierTier = null;
  if (supplier_nominal_pkg && typeof supplier_nominal_pkg === 'object') {
    const supDims = parsePackage(supplier_nominal_pkg);
    if (supDims) {
      supplierStressPkg = {
        length_in: supDims.longest_in,
        width_in: supDims.median_in,
        height_in: supDims.shortest_in,
        unit_weight_lb: supDims.unit_weight_lb,
      };
      supplierTier = classifySizeTier2027(supplierStressPkg);
      const supFulSample = lookupBulkyFulfillmentFee2027({ pkg: supplierStressPkg, price_usd: 39.99 });
      supplierCliffCrossed = Boolean(
        supplierTier.size_tier !== peerTier.size_tier ||
        (peerFulSample.status === 'verified' && supFulSample.status === 'verified' && supFulSample.total_usd > peerFulSample.total_usd + 0.005) ||
        (peerFulSample.status === 'verified' && supFulSample.status !== 'verified'),
      );
    }
  }

  return {
    peer_count: parsedPeers.length,
    sp_api_official_peer_count: parsedPeers.filter(p => p.is_sp_api_official).length,
    ...(overriddenStaleSellerSpriteAsins.length > 0 ? { overridden_stale_sellersprite_asins: overriddenStaleSellerSpriteAsins } : {}),
    low_peer_warning: parsedPeers.length < 3 && parsedPeers.every(p => !p.is_sp_api_official),
    peer_asins: parsedPeers.map(p => p.asin).filter(Boolean),
    median_pkg: medianPkg,
    median_size_tier: peerTier.size_tier,
    supplier_nominal_pkg: supplierStressPkg,
    supplier_size_tier: supplierTier?.size_tier ?? null,
    supplier_cliff_crossed: supplierCliffCrossed,
    sample_warning_tag: supplierCliffCrossed ? '拿样必测彩盒压线预警' : null,
  };
}

/**
 * Evaluate whether ANY payable cent price inside `[min_mature_price_usd, max_mature_price_usd]` clears `margin_floor`,
 * explicitly checking FBA tier-cliff interior boundaries (`$10.00` and `$50.00`) so candidates where `$49.99` and
 * `$50.01` both fail `<30%` while `$50.00` passes `>=30%` are never falsely eliminated!
 */
export function checkMatureBandMarginFeasibility2027({
  min_mature_price_usd,
  max_mature_price_usd,
  landed_domestic_usd,
  margin_floor = 0.30,
  ...gate1aParams
} = {}) {
  if (!finite(min_mature_price_usd) || !finite(max_mature_price_usd) || min_mature_price_usd <= 0 || max_mature_price_usd < min_mature_price_usd) {
    return { status: 'needs_calculator_verification', reason: 'Valid mature price bounds [min_mature_price_usd, max_mature_price_usd] are required.' };
  }
  if (!finite(landed_domestic_usd) || landed_domestic_usd < 0) {
    return { status: 'needs_calculator_verification', reason: 'Valid nonnegative landed_domestic_usd is required.' };
  }
  const candidatePrices = new Set([
    Math.round(min_mature_price_usd * 100) / 100,
    Math.round(max_mature_price_usd * 100) / 100,
  ]);
  const cpnUsd = finite(gate1aParams.ongoing_coupon_usd) && gate1aParams.ongoing_coupon_usd > 0 ? gate1aParams.ongoing_coupon_usd : 0;
  const cpnPct = finite(gate1aParams.ongoing_coupon_pct) && gate1aParams.ongoing_coupon_pct > 0 && gate1aParams.ongoing_coupon_pct < 1 ? gate1aParams.ongoing_coupon_pct : 0;
  const boundsAreNet = gate1aParams.promo_basis_already_net === true;
  for (const cliffPrice of [9.99, 10.00, 49.99, 50.00, 50.01]) {
    if (cliffPrice >= min_mature_price_usd - 1e-6 && cliffPrice <= max_mature_price_usd + 1e-6) {
      candidatePrices.add(cliffPrice);
    }
    if (boundsAreNet && (cpnUsd > 0 || cpnPct > 0)) {
      const shiftedNet = cpnUsd > 0
        ? Math.round((cliffPrice - cpnUsd) * 100) / 100
        : Math.round(cliffPrice * (1 - cpnPct) * 100) / 100;
      if (shiftedNet > 0 && shiftedNet >= min_mature_price_usd - 1e-6 && shiftedNet <= max_mature_price_usd + 1e-6) {
        candidatePrices.add(shiftedNet);
      }
    }
  }
  const landedRat = toRat(landed_domestic_usd);
  const evaluated = [];
  for (const p of [...candidatePrices].sort((a, b) => a - b)) {
    const derivedListP = boundsAreNet && (cpnUsd > 0 || cpnPct > 0)
      ? (cpnUsd > 0 ? Math.round((p + cpnUsd) * 100) / 100 : Math.round((p / (1 - cpnPct)) * 100) / 100)
      : gate1aParams.list_price_usd;
    const est = estimateGate1AWithLandedCost({
      ...gate1aParams,
      price_usd: p,
      ...(boundsAreNet && derivedListP !== undefined ? { list_price_usd: derivedListP, net_effective_price_usd: p, promo_basis_already_net: true } : {}),
      margin_floor,
      min_landed_domestic_usd: null,
    }, landedRat);
    if (est.status !== 'verified') {
      return { status: 'needs_calculator_verification', reason: est.reason, failed_at_price_usd: p };
    }
    const contrib = round(est.net_revenue_usd - (est.non_domestic_cost_a_usd + landed_domestic_usd));
    const margin = contrib / est.net_revenue_usd;
    evaluated.push({
      price_usd: p,
      passes_floor: !est.zero_browser_fail,
      margin,
      contribution_usd: contrib,
      price_band: est.price_band,
    });
  }
  const best = [...evaluated].sort((a, b) => Number(b.passes_floor) - Number(a.passes_floor) || b.margin - a.margin)[0];
  return {
    status: 'verified',
    any_ge_floor: evaluated.some(e => e.passes_floor),
    all_ge_floor: evaluated.every(e => e.passes_floor),
    best_price_usd: best?.price_usd ?? null,
    best_margin: best?.margin ?? null,
    evaluated_points: evaluated,
  };
}

export function priceBand2027(priceUsd) {
  if (!finite(priceUsd) || priceUsd <= 0) return null;
  const p = toRat(priceUsd);
  if (ratCmp(p, toRat(10)) < 0) return 'under_10';
  if (ratCmp(p, toRat(50)) <= 0) return '10_to_50';
  return 'over_50';
}

function extraQuarterLbStepsRat(r) {
  // Exact ceil((shippingLb - 3) / 0.25) = ceil(4 * (shippingLb - 3))
  const excessNum = r.n - 3n * r.d;
  if (excessNum <= 0n) return 0;
  return Number(ceilDivBig(excessNum * 4n, r.d));
}

export function lookupFulfillmentFee2027({
  pkg,
  price_usd,
  list_price_usd = undefined,
  has_ongoing_coupon = false,
  has_prime_discount = false,
  ongoing_coupon_usd = undefined,
  ongoing_coupon_pct = undefined,
  sales_window = null,
  include_fuel_surcharge = true,
  is_apparel,
  is_dangerous_goods,
  is_sipp,
  low_price_eligible = true,
} = {}) {
  if (typeof include_fuel_surcharge !== 'boolean' || typeof low_price_eligible !== 'boolean') {
    return { status: 'needs_calculator_verification', reason: 'include_fuel_surcharge and low_price_eligible must be booleans.' };
  }
  if (!finite(price_usd) || price_usd <= 0) {
    return { status: 'needs_calculator_verification', reason: 'Positive finite price_usd is required.' };
  }
  if (sales_window !== null) {
    if (!validWindow(sales_window)) {
      return { status: 'needs_calculator_verification', reason: 'Invalid sales_window dates.' };
    }
    if (sales_window.from < FBA_2027_METADATA.non_peak_fulfillment_window.from ||
      sales_window.through > FBA_2027_METADATA.non_peak_fulfillment_window.through) {
      return {
        status: 'needs_calculator_verification',
        reason: `sales_window ${sales_window.from}..${sales_window.through} falls outside published 2027 non-peak fulfillment window (${FBA_2027_METADATA.non_peak_fulfillment_window.from}..${FBA_2027_METADATA.non_peak_fulfillment_window.through}); late-2027 holiday peak fulfillment rates are unpublished.`,
      };
    }
  }
  const cls = classifyStandardSize2027(pkg, { is_apparel, is_dangerous_goods, is_sipp });
  if (cls.status !== 'verified') return cls;
  const couponActive = Boolean(
    has_ongoing_coupon === true ||
    (finite(ongoing_coupon_usd) && ongoing_coupon_usd > 0) ||
    (finite(ongoing_coupon_pct) && ongoing_coupon_pct > 0),
  );
  const tierBasisPriceUsd = couponActive && has_prime_discount !== true && finite(list_price_usd) && list_price_usd > 0
    ? list_price_usd
    : price_usd;
  const band = priceBand2027(tierBasisPriceUsd);
  if (band === 'under_10' && !low_price_eligible) {
    return {
      status: 'needs_calculator_verification',
      reason: 'Category is marked ineligible for 2027 Low-Price FBA rates.',
    };
  }

  let baseUsd = null;
  let weightBracket = null;
  let extraSteps = 0;

  if (cls.size_tier === 'small_standard') {
    const ozRat = cls.rawRat.ozRat;
    const row = SMALL_STANDARD_2027_OZ.find(entry => ratCmp(ozRat, toRat(entry.max_oz)) <= 0);
    if (!row) return { status: 'needs_calculator_verification', reason: 'Small Standard weight exceeded 16 oz.' };
    baseUsd = row[band];
    weightBracket = `small_standard <= ${row.max_oz} oz`;
  } else {
    const lbRat = cls.rawRat.shipLbRat;
    if (ratCmp(lbRat, toRat(3)) <= 0) {
      const row = LARGE_STANDARD_2027_LB.find(entry => ratCmp(lbRat, toRat(entry.max_lb)) <= 0);
      if (!row) return { status: 'needs_calculator_verification', reason: 'Large Standard weight bracket lookup failed.' };
      baseUsd = row[band];
      weightBracket = `large_standard <= ${row.max_lb} lb`;
    } else {
      extraSteps = extraQuarterLbStepsRat(lbRat);
      baseUsd = round(LARGE_STANDARD_OVER_3LB[band] + extraSteps * LARGE_STANDARD_OVER_3LB.step_usd);
      weightBracket = `large_standard 3+ to 20 lb (${extraSteps} x 4 oz intervals above 3 lb)`;
    }
  }

  const fuelMultiplier = include_fuel_surcharge ? (1 + FBA_2027_METADATA.fuel_surcharge_fraction) : 1;
  const totalUsd = round(baseUsd * fuelMultiplier);
  return {
    status: 'verified',
    version: FBA_2027_METADATA.version,
    size_tier: cls.size_tier,
    price_band: band,
    weight_bracket: weightBracket,
    shipping_weight_lb: cls.shipping_weight_lb,
    weight_basis: cls.weight_basis,
    base_usd: baseUsd,
    fuel_surcharge_included: Boolean(include_fuel_surcharge),
    fuel_surcharge_fraction: include_fuel_surcharge ? FBA_2027_METADATA.fuel_surcharge_fraction : 0,
    total_usd: totalUsd,
    extra_quarter_lb_steps: extraSteps,
    effective_from: FBA_2027_METADATA.non_peak_fulfillment_window.from,
    effective_through: FBA_2027_METADATA.non_peak_fulfillment_window.through,
    source_url: FBA_2027_METADATA.official_sources.fulfillment,
  };
}

export function lookupStorageFee2027({
  pkg,
  storage_window = null,
  months = null,
  average_inventory_days = 45,
  inventory_age_days = 45,
  is_dangerous_goods,
} = {}) {
  const cls = classifyStandardSize2027(pkg, { is_dangerous_goods });
  if (cls.status !== 'verified') return cls;
  if (!finite(average_inventory_days) || average_inventory_days < 45) {
    return { status: 'needs_calculator_verification', reason: 'average_inventory_days must be at least 45.' };
  }
  if (!finite(inventory_age_days) || inventory_age_days < 0 || inventory_age_days > 180) {
    return { status: 'needs_calculator_verification', reason: 'Only 0–180 day standard unified storage is verified in this lookup.' };
  }
  let targetMonths = months;
  if (storage_window !== null) {
    if (!validWindow(storage_window)) {
      return { status: 'needs_calculator_verification', reason: 'Invalid storage_window.' };
    }
    if (storage_window.from < FBA_2027_METADATA.unified_storage_effective_from || storage_window.through > '2027-12-31') {
      return { status: 'needs_calculator_verification', reason: 'storage_window must lie within the verified 2027-02-01..2027-12-31 unified storage schedule.' };
    }
    const winMonths = monthsIn(storage_window);
    if (Array.isArray(months) && (months.some(m => !winMonths.includes(m)) || winMonths.some(m => !months.includes(m)))) {
      return { status: 'needs_calculator_verification', reason: 'Supplied months conflict with storage_window.' };
    }
    targetMonths = winMonths;
  }
  if (!Array.isArray(targetMonths) || targetMonths.length === 0 ||
    targetMonths.some(m => !Number.isInteger(m) || m < 1 || m > 12)) {
    return { status: 'needs_calculator_verification', reason: 'Explicit valid storage_window or months array is required.' };
  }
  const hasOffPeak = targetMonths.some(m => m <= 9);
  const hasPeak = targetMonths.some(m => m >= 10);
  if (hasOffPeak && hasPeak) {
    return { status: 'needs_calculator_verification', reason: 'Storage window mixes Jan–Sep ($0.78) and Oct–Dec ($2.40) rates; evaluate seasons separately.' };
  }
  const rateUsdPerCuftMonth = hasPeak ? STORAGE_2027_RATES.peak : STORAGE_2027_RATES.off_peak;
  const allocatedRat = divBigRat(
    mulBigRat(mulBigRat(cls.rawRat.cubicFtRat, toBigRat(rateUsdPerCuftMonth)), toBigRat(average_inventory_days)),
    { n: 30n, d: 1n },
  );
  const allocatedUsd = roundBigRat(allocatedRat.n, allocatedRat.d, 10);
  return {
    status: 'verified',
    version: FBA_2027_METADATA.version,
    season: hasPeak ? 'peak_oct_dec' : 'off_peak_jan_sep',
    cubic_feet: cls.cubic_feet,
    rate_usd_per_cuft_month: rateUsdPerCuftMonth,
    average_inventory_days,
    per_unit_usd: allocatedUsd,
    effective_from: FBA_2027_METADATA.unified_storage_effective_from,
    source_url: FBA_2027_METADATA.official_sources.storage,
  };
}

export function isAmazonOptimizedPlacementVerified2027({
  identical_cartons_count = null,
  multi_destination_headhaul_verified = false,
} = {}) {
  return Boolean(
    Number.isInteger(identical_cartons_count) &&
    identical_cartons_count >= 5 &&
    multi_destination_headhaul_verified === true,
  );
}

export function lookupPlacementFee2027({
  pkg,
  inbound_window = null,
  split_option = 'minimal_west_conservative',
  is_dangerous_goods,
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = false,
} = {}) {
  if (inbound_window !== null) {
    if (!validWindow(inbound_window)) {
      return { status: 'needs_calculator_verification', reason: 'Invalid inbound_window.' };
    }
    if (inbound_window.from < FBA_2027_METADATA.placement_effective_from) {
      return { status: 'needs_calculator_verification', reason: 'inbound_window precedes 2027-01-15 placement schedule.' };
    }
  }
  const cls = classifyStandardSize2027(pkg, { is_dangerous_goods });
  if (cls.status !== 'verified') return cls;
  if (split_option === 'amazon_optimized') {
    const effOptCartons = Number.isInteger(identical_cartons_count) ? identical_cartons_count : null;
    const optVerified = isAmazonOptimizedPlacementVerified2027({
      identical_cartons_count: effOptCartons,
      multi_destination_headhaul_verified,
    });
    if (!optVerified) {
      return {
        status: 'sensitivity_only',
        version: FBA_2027_METADATA.version,
        size_tier: cls.size_tier,
        split_option,
        range_usd: [0, 0],
        selected_usd: 0,
        reason: 'Standard-size amazon_optimized ($0 placement) requires >= 5 identical cartons AND verified multi-destination headhaul freight; sensitivity-only otherwise.',
        effective_from: FBA_2027_METADATA.placement_effective_from,
        source_url: FBA_2027_METADATA.official_sources.placement,
      };
    }
    return {
      status: 'verified',
      version: FBA_2027_METADATA.version,
      size_tier: cls.size_tier,
      split_option,
      range_usd: [0, 0],
      selected_usd: 0,
      identical_cartons_count: effOptCartons,
      multi_destination_headhaul_verified: true,
      note: 'Amazon-optimized splits incur $0 placement fee (>=5 identical cartons and multi-destination headhaul verified).',
      effective_from: FBA_2027_METADATA.placement_effective_from,
      source_url: FBA_2027_METADATA.official_sources.placement,
    };
  }
  let range = null;
  if (cls.size_tier === 'small_standard') {
    range = PLACEMENT_MINIMAL_SMALL_OZ.find(r => ratCmp(cls.rawRat.ozRat, toRat(r.max_oz)) <= 0)?.range ?? null;
  } else {
    range = PLACEMENT_MINIMAL_LARGE_LB.find(r => ratCmp(cls.rawRat.shipLbRat, toRat(r.max_lb)) <= 0)?.range ?? null;
  }
  if (!range) return { status: 'needs_calculator_verification', reason: 'Unlisted placement weight bracket.' };
  const selectedUsd = split_option === 'minimal_east_low' ? range[0] : range[1];
  return {
    status: 'verified',
    version: FBA_2027_METADATA.version,
    size_tier: cls.size_tier,
    split_option,
    range_usd: [...range],
    selected_usd: selectedUsd,
    effective_from: FBA_2027_METADATA.placement_effective_from,
    source_url: FBA_2027_METADATA.official_sources.placement,
  };
}

export function lookupReturnsProcessing2027({
  pkg,
  physical_return_fraction,
  fee_category = null,
  return_threshold = null,
  sales_window = null,
  is_apparel_or_shoes,
  is_dangerous_goods,
} = {}) {
  const appCheck = resolveConsistentBoolean([is_apparel_or_shoes, pkg?.is_apparel_or_shoes, pkg?.is_apparel]);
  if (!appCheck.valid) {
    return { status: 'needs_calculator_verification', reason: 'is_apparel_or_shoes must be a strict boolean without contradiction.' };
  }
  if (appCheck.value) {
    return { status: 'needs_calculator_verification', reason: 'Apparel and shoes incur per-return processing without threshold; use explicit apparel table or calculator.' };
  }
  if (!finite(physical_return_fraction) || physical_return_fraction < 0 || physical_return_fraction >= 1) {
    return { status: 'needs_calculator_verification', reason: 'physical_return_fraction in [0, 1) is required.' };
  }
  if (sales_window !== null && sales_window !== undefined) {
    if (!validWindow(sales_window) || sales_window.from < FBA_2027_METADATA.returns_non_apparel_effective_from || sales_window.through > '2027-12-31') {
      return {
        status: 'needs_calculator_verification',
        reason: `sales_window must lie within 2027-02-01..2027-12-31 for the 2027 non-apparel returns-processing schedule.`,
      };
    }
  }
  const catMatch = lookupVerified2027ReturnThreshold(fee_category);
  if (!catMatch) {
    return {
      status: 'needs_calculator_verification',
      reason: `A listed 2027 fee_category is required (received ${fee_category ?? 'none'}); unlisted or omitted categories cannot use unverified custom return_threshold overrides.`,
    };
  }
  const tableThreshold = catMatch.threshold;
  if (return_threshold !== null && return_threshold !== undefined) {
    if (!finite(return_threshold) || return_threshold !== tableThreshold) {
      return {
        status: 'needs_calculator_verification',
        reason: `Supplied return_threshold (${return_threshold}) conflicts with verified 2027 threshold (${tableThreshold}) for ${fee_category}.`,
      };
    }
  }
  const threshold = tableThreshold;
  const cls = classifyStandardSize2027(pkg, { is_dangerous_goods });
  if (cls.status !== 'verified') {
    const bulkyCls = classifySizeTier2027(pkg, { is_dangerous_goods });
    if (bulkyCls.status === 'verified' && physical_return_fraction <= threshold) {
      return {
        status: 'verified',
        version: 'US-FBA-2027-nonpeak-bulky4-v1',
        size_tier: bulkyCls.size_tier,
        fee_category,
        fee_category_canonical: catMatch.canonical,
        r_physical: physical_return_fraction,
        return_threshold: threshold,
        per_return_fee_usd: null,
        excess_return_fraction: 0,
        expected_fee_per_shipped_unit_usd: 0,
        effective_from: FBA_2027_METADATA.returns_non_apparel_effective_from,
        source_url: FBA_2027_METADATA.official_sources.returns,
      };
    }
    return cls;
  }
  let perReturnFee = null;
  if (cls.size_tier === 'small_standard') {
    perReturnFee = SMALL_STANDARD_2027_OZ.find(r => ratCmp(cls.rawRat.ozRat, toRat(r.max_oz)) <= 0)?.return_fee ?? null;
  } else {
    const lbRat = cls.rawRat.shipLbRat;
    if (ratCmp(lbRat, toRat(3)) <= 0) {
      perReturnFee = LARGE_STANDARD_2027_LB.find(r => ratCmp(lbRat, toRat(r.max_lb)) <= 0)?.return_fee ?? null;
    } else {
      const steps = extraQuarterLbStepsRat(lbRat);
      perReturnFee = round(LARGE_STANDARD_OVER_3LB.return_base_usd + steps * LARGE_STANDARD_OVER_3LB.return_step_usd);
    }
  }
  if (perReturnFee === null) return { status: 'needs_calculator_verification', reason: 'Unlisted returns-processing weight bracket.' };
  const excess = Math.max(0, round(physical_return_fraction - threshold));
  const expectedPerShippedUnit = round(excess * perReturnFee);
  return {
    status: 'verified',
    version: FBA_2027_METADATA.version,
    size_tier: cls.size_tier,
    fee_category,
    fee_category_canonical: catMatch.canonical,
    r_physical: physical_return_fraction,
    return_threshold: threshold,
    per_return_fee_usd: perReturnFee,
    excess_return_fraction: excess,
    expected_fee_per_shipped_unit_usd: expectedPerShippedUnit,
    effective_from: FBA_2027_METADATA.returns_non_apparel_effective_from,
    source_url: FBA_2027_METADATA.official_sources.returns,
  };
}

function pkgMatchesOverride(targetPkg, overridePkg) {
  if (!overridePkg || typeof overridePkg !== 'object') return false;
  if (!targetPkg || typeof targetPkg !== 'object') return false;
  const d1 = resolvePackageDimsRat(targetPkg);
  const d2 = resolvePackageDimsRat(overridePkg);
  if (!d1 || !d2 || !d1.wtLbRat || !d2.wtLbRat) return false;
  const ratNear = (a, b) => Math.abs((Number(a.n) / Number(a.d)) - (Number(b.n) / Number(b.d))) <= 1e-5;
  return ratNear(d1.s1Rat, d2.s1Rat) &&
    ratNear(d1.s2Rat, d2.s2Rat) &&
    ratNear(d1.s3Rat, d2.s3Rat) &&
    ratNear(d1.wtLbRat, d2.wtLbRat);
}

function validateCalculatorVerifiedOverride(override, {
  price_usd,
  pkg = null,
  sales_window = null,
  storage_window = null,
  rPhysical,
  fee_category,
  is_apparel,
  is_dangerous_goods,
  is_sipp,
}) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { valid: false, reason: 'calculator_verified_override must be an object.' };
  }
  const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;
  const targetBand = priceBand2027(price_usd);

  // Support multi-band overrides map when supplied (e.g. band_overrides: { '10_to_50': {...}, 'over_50': {...} })
  const active = override.band_overrides && typeof override.band_overrides === 'object'
    ? (override.band_overrides[targetBand]
      ? { ...override, ...override.band_overrides[targetBand] }
      : null)
    : override;
  if (!active) {
    return { valid: false, reason: `calculator_verified_override.band_overrides has no verified receipt for price band "${targetBand}" ($${price_usd}).` };
  }

  if (!nonEmpty(active.verified_by) || !nonEmpty(active.evidence_ref) || !isoDate(active.observed_at)) {
    return { valid: false, reason: 'calculator_verified_override requires verified_by, evidence_ref, and ISO observed_at (YYYY-MM-DD).' };
  }
  if (active.awd_only === true || active.fba_panel_present === false ||
    active.right_column_fba_non_empty === false || active.standard_fba_column_non_empty === false ||
    active.login_prompt_detected === true || active.guest_logged_out === false ||
    active.http_status === 429 || (finite(active.http_status) && active.http_status >= 400) ||
    active.rate_limited === true) {
    return {
      valid: false,
      reason: 'calculator_verified_override rejected due to HTTP 429 / empty standard FBA column / AWD-only / non-guest login state.',
    };
  }
  if (active.guest_readback && typeof active.guest_readback === 'object') {
    const rb = validateGuestRevcalReadback(active.guest_readback);
    if (!rb.valid) {
      return { valid: false, reason: `calculator_verified_override.guest_readback invalid: ${rb.reason}` };
    }
    if (finite(active.fulfillment_usd) && Math.abs(active.fulfillment_usd - rb.override.fulfillment_usd) > 0.01) {
      return {
        valid: false,
        reason: `calculator_verified_override.fulfillment_usd ($${active.fulfillment_usd}) conflicts with guest_readback.fulfillment_usd ($${rb.override.fulfillment_usd}).`,
      };
    }
    if (finite(active.storage_per_unit_usd) && Math.abs(active.storage_per_unit_usd - rb.override.storage_per_unit_usd) > 0.01) {
      return {
        valid: false,
        reason: `calculator_verified_override.storage_per_unit_usd ($${active.storage_per_unit_usd}) conflicts with guest_readback.storage_per_unit_usd ($${rb.override.storage_per_unit_usd}).`,
      };
    }
    if (finite(active.placement_usd) && Math.abs(active.placement_usd - rb.override.placement_usd) > 0.01) {
      return {
        valid: false,
        reason: `calculator_verified_override.placement_usd ($${active.placement_usd}) conflicts with guest_readback.placement_usd ($${rb.override.placement_usd}).`,
      };
    }
  }
  if (nonEmpty(active.url) && !/^https:\/\/sellercentral\.amazon\.com\/revcalpublic(?:[/?#]|$)/i.test(active.url.trim())) {
    return {
      valid: false,
      reason: `calculator_verified_override.url must be the logged-out guest https://sellercentral.amazon.com/revcalpublic endpoint; got "${active.url}".`,
    };
  }
  if ((finite(active.rate_schedule_year) && active.rate_schedule_year < 2027) ||
    (nonEmpty(active.fee_schedule_version) && /\b202[0-6]\b/.test(active.fee_schedule_version))) {
    return {
      valid: false,
      reason: 'calculator_verified_override cannot certify pre-2027 historical fee schedules for 2027 evaluation.',
    };
  }
  const has2026PeakExtrapolation = Boolean(
    active.extrapolated_from_2026 === true ||
    active.estimated_from_2026 === true ||
    active.peak_2026_uplift_estimate === true ||
    (nonEmpty(active.verified_by) && /2026[-_ ]?peak|2026\s*旺季|extrapolat/i.test(active.verified_by)) ||
    (nonEmpty(active.evidence_ref) && /2026[-_ ]?peak|2026\s*旺季|extrapolat/i.test(active.evidence_ref)) ||
    (nonEmpty(active.fee_schedule_version) && /2026[-_ ]?peak|2026\s*旺季|extrapolat/i.test(active.fee_schedule_version)) ||
    (nonEmpty(active.notes) && /2026[-_ ]?peak|2026\s*旺季.*估|按\s*2026/i.test(active.notes)),
  );
  if (has2026PeakExtrapolation) {
    return {
      valid: false,
      reason: `2027 holiday-peak FBA fulfillment fees cannot be extrapolated from 2026 peak uplifts (${UNPUBLISHED_2027_PEAK_MARGIN_NOTE}).`,
    };
  }
  if (!finite(active.fulfillment_usd) || active.fulfillment_usd <= 0 ||
    !finite(active.storage_per_unit_usd) || active.storage_per_unit_usd <= 0 ||
    !finite(active.placement_usd) || active.placement_usd < 0 ||
    !finite(active.returns_processing_usd) || active.returns_processing_usd < 0) {
    return { valid: false, reason: 'calculator_verified_override requires positive fulfillment_usd and storage_per_unit_usd, plus nonnegative placement_usd and returns_processing_usd.' };
  }
  if (isoDate(active.effective_from) && active.effective_from < '2027-01-15') {
    return {
      valid: false,
      reason: `calculator_verified_override effective_from (${active.effective_from}) predates the 2027 US FBA schedule (2027-01-15).`,
    };
  }
  const explicitStorRate = active.storage_rate_usd_per_cuft_month ?? active.storage_rate_per_cuft_usd ?? null;
  if (finite(explicitStorRate)) {
    const parsedDimsForRate = parsePackage(active.pkg ?? pkg);
    const isOverForRate = parsedDimsForRate
      ? (parsedDimsForRate.longest_in > 18 || parsedDimsForRate.median_in > 14 || parsedDimsForRate.shortest_in > 8 || parsedDimsForRate.unit_weight_lb > 20)
      : false;
    const hasPkForRate = validWindow(storage_window) &&
      monthsIn(storage_window).some(m => m >= 10);
    const minRate = hasPkForRate ? (isOverForRate ? 1.40 : 2.40) : (isOverForRate ? 0.56 : 0.78);
    if (explicitStorRate + 1e-6 < minRate) {
      return {
        valid: false,
        reason: `calculator_verified_override storage rate ($${explicitStorRate}/cu ft) is below 2027 minimum ($${minRate}/cu ft).`,
      };
    }
  }
  const dgScen = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  const appScen = resolveConsistentBoolean([is_apparel, pkg?.is_apparel, pkg?.is_apparel_or_shoes]);
  const sippScen = resolveConsistentBoolean([is_sipp, pkg?.is_sipp]);
  if (!dgScen.valid || !appScen.valid || !sippScen.valid) {
    return { valid: false, reason: 'Scenario is_dangerous_goods, is_apparel, and is_sipp flags must be strict booleans without contradiction.' };
  }
  const stdFulCheck = lookupFulfillmentFee2027({
    pkg: active.pkg ?? pkg,
    price_usd,
    sales_window,
    is_apparel: appScen.value,
    is_dangerous_goods: dgScen.value,
    is_sipp: sippScen.value,
  });
  if (stdFulCheck.status === 'verified' && active.fulfillment_usd + 0.01 < stdFulCheck.total_usd) {
    return {
      valid: false,
      reason: `calculator_verified_override fulfillment_usd ($${active.fulfillment_usd}) understates verified 2027 Standard-size fee ($${stdFulCheck.total_usd}).`,
    };
  }
  if (!sippScen.value) {
    const rawOverridePkg = active.pkg ?? pkg;
    const floorPkg = rawOverridePkg && typeof rawOverridePkg === 'object'
      ? {
          ...rawOverridePkg,
          is_apparel: undefined,
          is_apparel_or_shoes: undefined,
          is_dangerous_goods: undefined,
          is_sipp: undefined,
          is_oversize: undefined,
          requires_amazon_packaging: undefined,
        }
      : rawOverridePkg;
    if (stdFulCheck.status !== 'verified') {
      const stdBaseFloorCheck = lookupFulfillmentFee2027({
        pkg: floorPkg,
        price_usd,
        sales_window: null,
        include_fuel_surcharge: false,
        is_apparel: false,
        is_dangerous_goods: false,
        is_sipp: false,
      });
      if (stdBaseFloorCheck.status === 'verified' && active.fulfillment_usd + 0.01 < stdBaseFloorCheck.total_usd) {
        return {
          valid: false,
          reason: `calculator_verified_override fulfillment_usd ($${active.fulfillment_usd}) understates 2027 Standard-size base fee floor ($${stdBaseFloorCheck.total_usd}).`,
        };
      }
    }
    const bulkyFloorCheck = lookupBulkyFulfillmentFee2027({
      pkg: floorPkg,
      price_usd,
      sales_window: null,
      is_apparel: false,
      is_dangerous_goods: false,
      is_sipp: false,
    });
    if (bulkyFloorCheck.status === 'verified' && String(bulkyFloorCheck.size_tier || '').includes('bulky')) {
      const isGuestRevcal = Boolean(active.guest_readback || nonEmpty(active.url) || active.verified_by === 'guest_revcalpublic');
      const bulkyBasePlusFuel = bulkyFloorCheck.fulfillment_with_fuel_usd ?? bulkyFloorCheck.total_usd;
      const minBulkyFloorUsd = isGuestRevcal
        ? bulkyBasePlusFuel
        : (finite(bulkyFloorCheck.tier_first_lb_total_usd) ? bulkyFloorCheck.tier_first_lb_total_usd : bulkyBasePlusFuel);
      if (active.fulfillment_usd + 0.01 < minBulkyFloorUsd) {
        return {
          valid: false,
          reason: `calculator_verified_override fulfillment_usd ($${active.fulfillment_usd}) understates 2027 Bulky fee floor ($${minBulkyFloorUsd}).`,
        };
      }
    } else if (String(bulkyFloorCheck.size_tier || '').includes('oversize') || bulkyFloorCheck.size_tier === 'bulky_special_handling') {
      const computedFloor = computeOversizeOrSpecialHandlingFloor2027(floorPkg, targetBand);
      const xlTier = BULKY_2027_TIERS[BULKY_2027_TIERS.length - 1];
      const minOversizeFloorUsd = computedFloor
        ? computedFloor.floor_usd
        : round((xlTier[targetBand] ?? xlTier['10_to_50']) * (1 + FBA_2027_METADATA.fuel_surcharge_fraction));
      if (active.fulfillment_usd + 0.01 < minOversizeFloorUsd) {
        return {
          valid: false,
          reason: `calculator_verified_override fulfillment_usd ($${active.fulfillment_usd}) understates 2027 Extra-Large Bulky / Oversize fee floor ($${minOversizeFloorUsd} for ${computedFloor?.size_tier ?? bulkyFloorCheck.size_tier}).`,
        };
      }
    }
  }

  // Strictly bind override to price band, effective window, package, and DG/apparel/SIPP flags!
  const declaredBand = nonEmpty(active.verified_price_band)
    ? active.verified_price_band.trim()
    : (finite(active.verified_price_usd) && active.verified_price_usd > 0 ? priceBand2027(active.verified_price_usd) : null);
  if (!declaredBand) {
    return { valid: false, reason: 'calculator_verified_override must bind verified_price_band or verified_price_usd so a single receipt cannot certify other FBA price tiers.' };
  }
  if (declaredBand !== targetBand) {
    return { valid: false, reason: `calculator_verified_override price band (${declaredBand}) does not match evaluated price band (${targetBand} at $${price_usd}).` };
  }
  if (!isoDate(active.effective_from) || !isoDate(active.effective_through) || active.effective_through < active.effective_from) {
    return { valid: false, reason: 'calculator_verified_override requires valid effective_from and effective_through dates covering the target window.' };
  }
  if (validWindow(sales_window) && (sales_window.from < active.effective_from || sales_window.through > active.effective_through)) {
    return { valid: false, reason: `calculator_verified_override effective window (${active.effective_from}..${active.effective_through}) does not cover sales_window (${sales_window.from}..${sales_window.through}).` };
  }
  if (validWindow(storage_window) && (storage_window.from < active.effective_from || storage_window.through > active.effective_through)) {
    return { valid: false, reason: `calculator_verified_override effective window (${active.effective_from}..${active.effective_through}) does not cover storage_window (${storage_window.from}..${storage_window.through}).` };
  }
  if (active.pkg !== undefined && !pkgMatchesOverride(pkg, active.pkg)) {
    return { valid: false, reason: 'calculator_verified_override.pkg dimensions/weight do not match scenario pkg.' };
  }
  if (active.pkg_ref !== undefined && (!nonEmpty(active.pkg_ref) || !nonEmpty(pkg?.id) || active.pkg_ref.trim() !== pkg.id.trim())) {
    return { valid: false, reason: 'calculator_verified_override.pkg_ref does not match scenario pkg.id.' };
  }
  if (active.pkg === undefined && active.pkg_ref === undefined) {
    return { valid: false, reason: 'calculator_verified_override must bind pkg (dimensions/weight) or pkg_ref matching the evaluated package.' };
  }
  const ovDg = resolveConsistentBoolean([active.is_dangerous_goods, active.pkg?.is_dangerous_goods]);
  const ovApp = resolveConsistentBoolean([active.is_apparel, active.is_apparel_or_shoes, active.pkg?.is_apparel, active.pkg?.is_apparel_or_shoes]);
  const ovSipp = resolveConsistentBoolean([active.is_sipp, active.pkg?.is_sipp]);
  if (!ovDg.valid || !ovApp.valid || !ovSipp.valid) {
    return { valid: false, reason: 'calculator_verified_override boolean flags (is_dangerous_goods, is_apparel, is_sipp) must be strict booleans without contradiction.' };
  }
  if (dgScen.value === true && (!ovDg.present || ovDg.value !== true)) {
    return { valid: false, reason: 'Dangerous-goods scenario requires calculator_verified_override.is_dangerous_goods: true.' };
  }
  if (ovDg.present && ovDg.value !== dgScen.value) {
    return { valid: false, reason: 'calculator_verified_override.is_dangerous_goods conflicts with scenario is_dangerous_goods.' };
  }
  if (appScen.value === true && (!ovApp.present || ovApp.value !== true)) {
    return { valid: false, reason: 'Apparel scenario requires calculator_verified_override.is_apparel: true.' };
  }
  if (ovApp.present && ovApp.value !== appScen.value) {
    return { valid: false, reason: 'calculator_verified_override.is_apparel conflicts with scenario is_apparel.' };
  }
  if (sippScen.value === true && (!ovSipp.present || ovSipp.value !== true)) {
    return { valid: false, reason: 'SIPP scenario requires calculator_verified_override.is_sipp: true.' };
  }
  if (ovSipp.present && ovSipp.value !== sippScen.value) {
    return { valid: false, reason: 'calculator_verified_override.is_sipp conflicts with scenario is_sipp.' };
  }
  if (nonEmpty(active.fee_category) && nonEmpty(fee_category)) {
    const c1 = lookupVerified2027ReturnThreshold(active.fee_category)?.canonical ?? active.fee_category.trim().toLowerCase();
    const c2 = lookupVerified2027ReturnThreshold(fee_category)?.canonical ?? fee_category.trim().toLowerCase();
    if (c1.toLowerCase() !== c2.toLowerCase()) {
      return { valid: false, reason: `calculator_verified_override.fee_category (${active.fee_category}) conflicts with scenario fee_category (${fee_category}).` };
    }
  }

  const catMatch = fee_category ? lookupVerified2027ReturnThreshold(fee_category) : null;
  const effectiveThreshold = finite(active.return_threshold) && active.return_threshold >= 0 && active.return_threshold < 1
    ? active.return_threshold
    : (catMatch ? catMatch.threshold : null);
  if (catMatch && finite(active.return_threshold) && active.return_threshold !== catMatch.threshold) {
    return { valid: false, reason: `calculator_verified_override.return_threshold (${active.return_threshold}) conflicts with verified 2027 threshold (${catMatch.threshold}) for ${catMatch.canonical}.` };
  }
  const hasExemption = Boolean(active.returns_exemption && nonEmpty(active.returns_exemption.reason) && nonEmpty(active.returns_exemption.evidence_ref));
  if (!hasExemption && active.returns_processing_usd === 0) {
    if (appScen.value === true && rPhysical > 0) {
      return { valid: false, reason: 'calculator_verified_override cannot set returns_processing_usd = 0 for apparel with positive returns without an evidenced returns_exemption.' };
    }
    if (effectiveThreshold !== null && rPhysical > effectiveThreshold) {
      return { valid: false, reason: `calculator_verified_override cannot set returns_processing_usd = 0 when r_physical (${rPhysical}) exceeds threshold (${effectiveThreshold}) without an evidenced returns_exemption.` };
    }
  }
  const sizeTier = nonEmpty(active.size_tier) ? active.size_tier.trim() : 'calculator_verified';
  return {
    valid: true,
    receipt: {
      verified_by: active.verified_by.trim(),
      observed_at: active.observed_at,
      evidence_ref: active.evidence_ref.trim(),
      verified_price_band: declaredBand,
      effective_from: active.effective_from,
      effective_through: active.effective_through,
      size_tier: sizeTier,
      notes: nonEmpty(active.notes) ? active.notes.trim() : null,
    },
    fulfillment: {
      status: 'verified',
      version: `calculator-override:${active.observed_at}`,
      size_tier: sizeTier,
      price_band: targetBand,
      total_usd: round(active.fulfillment_usd),
      source: 'calculator_verified_override',
    },
    storage: {
      status: 'verified',
      version: `calculator-override:${active.observed_at}`,
      per_unit_usd: round(active.storage_per_unit_usd),
      source: 'calculator_verified_override',
    },
    placement: {
      status: 'verified',
      version: `calculator-override:${active.observed_at}`,
      selected_usd: round(active.placement_usd),
      range_usd: [round(active.placement_usd), round(active.placement_usd)],
      split_option: 'calculator_verified_override',
    },
    returns: {
      status: 'verified',
      version: `calculator-override:${active.observed_at}`,
      size_tier: sizeTier,
      fee_category,
      fee_category_canonical: catMatch?.canonical ?? null,
      r_physical: rPhysical,
      return_threshold: effectiveThreshold,
      per_return_fee_usd: finite(active.per_return_fee_usd) ? active.per_return_fee_usd : null,
      excess_return_fraction: effectiveThreshold !== null ? Math.max(0, round(rPhysical - effectiveThreshold)) : null,
      expected_fee_per_shipped_unit_usd: round(active.returns_processing_usd),
      source: 'calculator_verified_override',
    },
  };
}

/**
 * Compute Gate 1A maximum allowable landed domestic cost (goods + domestic freight to Shenzhen)
 * at the target pre-ad margin floor: landed_domestic_cap_usd = (1 - floor) * R - A.
 * Distinct from bare-goods cap (landed_domestic_cap_usd - domestic_freight_usd).
 */
export function estimateGate1A2027(params) {
  return estimateGate1AWithLandedCost(params);
}

function estimateGate1AWithLandedCost({
  pkg,
  price_usd,
  list_price_usd = undefined,
  net_effective_price_usd = undefined,
  ongoing_coupon_usd = undefined,
  ongoing_coupon_pct = undefined,
  prime_exclusive_discount_usd = undefined,
  prime_exclusive_discount_pct = undefined,
  promo_basis_already_net = false,
  fx_cny_per_usd,
  refund_fraction,
  physical_return_fraction = null,
  fee_category = null,
  return_threshold = null,
  referral_terms,
  headhaul_usd,
  collection_rate,
  other_applicable_usd = 0,
  other_payee = 'external',
  sales_window,
  storage_window,
  inbound_window,
  average_inventory_days = 45,
  placement_usd = null,
  placement_split_option = 'minimal_west_conservative',
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = false,
  margin_floor = 0.30,
  domestic_freight_usd = null,
  min_landed_domestic_usd = null,
  is_apparel,
  is_shoes,
  is_apparel_or_shoes,
  is_dangerous_goods,
  is_sipp,
  sipp_discount_usd = 0,
  requires_amazon_packaging = undefined,
  low_price_eligible = true,
  allow_bulky_2027 = undefined,
  allow_all_2027_tiers = false,
  use_default_2027_off_peak_window = false,
  profile_revision = 59,
  coupon_campaign_units = 100,
  coupon_redemption_share = 1,
  coupon_redemption_fee_usd = undefined,
  coupon_fee_already_in_other = false,
  include_coupon_fee = undefined,
  include_coupon_campaign_flat = true,
  calculator_verified_override = null,
} = {}, exactLandedUsd = null) {
  const isR59OrDefaultWin = Boolean((profile_revision ?? 0) >= 59 || use_default_2027_off_peak_window === true);
  const effectiveSalesWindow = sales_window === undefined && isR59OrDefaultWin
    ? FBA_2027_DEFAULT_OFF_PEAK_WINDOW
    : sales_window;
  const effectiveStorageWindow = storage_window === undefined && isR59OrDefaultWin
    ? FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW
    : storage_window;
  const effectiveInboundWindow = inbound_window === undefined && isR59OrDefaultWin
    ? FBA_2027_DEFAULT_INBOUND_WINDOW
    : inbound_window;
  const useUnified2027Tiers = Boolean(
    ((profile_revision ?? 0) >= 59 || allow_bulky_2027 === true || allow_all_2027_tiers === true) &&
    allow_bulky_2027 !== false,
  );

  const pricing = resolveEffectivePricing({
    price_usd,
    list_price_usd,
    net_effective_price_usd,
    ongoing_coupon_usd,
    ongoing_coupon_pct,
    prime_exclusive_discount_usd,
    prime_exclusive_discount_pct,
    promo_basis_already_net,
  });
  if (!pricing.valid) {
    return { status: 'needs_calculator_verification', reason: pricing.reason };
  }
  const effectivePriceUsd = pricing.net_effective_price_usd;
  if (!finite(effectivePriceUsd) || effectivePriceUsd <= 0 || !finite(fx_cny_per_usd) || fx_cny_per_usd <= 0 ||
    !finite(refund_fraction) || refund_fraction < 0 || refund_fraction >= 1 ||
    !finite(headhaul_usd) || headhaul_usd < 0 ||
    !finite(collection_rate) || collection_rate < 0 || collection_rate >= 1 ||
    !finite(other_applicable_usd) || other_applicable_usd < 0 ||
    !finite(margin_floor) || margin_floor < 0.3 || margin_floor >= 1) {
    return { status: 'needs_calculator_verification', reason: 'Missing or invalid numeric Gate 1A inputs.' };
  }
  if (!validWindow(effectiveSalesWindow) || !validWindow(effectiveStorageWindow) || !validWindow(effectiveInboundWindow)) {
    return { status: 'needs_calculator_verification', reason: 'Valid sales_window, storage_window, and inbound_window are all required for Gate 1A.' };
  }
  if (effectiveSalesWindow.from.slice(0, 4) !== effectiveSalesWindow.through.slice(0, 4) ||
    effectiveStorageWindow.from.slice(0, 4) !== effectiveStorageWindow.through.slice(0, 4) ||
    effectiveSalesWindow.from.slice(0, 4) !== effectiveStorageWindow.from.slice(0, 4)) {
    return { status: 'needs_calculator_verification', reason: 'sales_window and storage_window must share a single target year (2027).' };
  }
  if (effectiveInboundWindow.from > effectiveSalesWindow.through) {
    return { status: 'needs_calculator_verification', reason: 'inbound_window cannot begin after sales_window ends.' };
  }
  if (effectiveInboundWindow.from < FBA_2027_METADATA.placement_effective_from) {
    return { status: 'needs_calculator_verification', reason: 'inbound_window precedes 2027-01-15 placement schedule.' };
  }
  if (min_landed_domestic_usd !== null && min_landed_domestic_usd !== undefined &&
    (!finite(min_landed_domestic_usd) || min_landed_domestic_usd < 0)) {
    return { status: 'needs_calculator_verification', reason: 'min_landed_domestic_usd must be a nonnegative finite number when supplied.' };
  }
  const rPhysical = physical_return_fraction === null || physical_return_fraction === undefined
    ? refund_fraction
    : physical_return_fraction;

  const hasOngoingCoupon = ((ongoing_coupon_usd ?? 0) > 0 || (ongoing_coupon_pct ?? 0) > 0 || (coupon_redemption_fee_usd ?? 0) > 0);
  const hasPrimeDiscount = ((prime_exclusive_discount_usd ?? 0) > 0 || (prime_exclusive_discount_pct ?? 0) > 0);
  const isR59Coupon = Boolean((profile_revision ?? 0) >= 59 && hasOngoingCoupon);
  // Under official Amazon US Coupon rules (r59), $10/$50 FBA fulfillment tier is determined by standard list price when a Coupon is active.
  const fulfillmentTierPriceUsd = isR59Coupon && !hasPrimeDiscount ? pricing.list_price_usd : effectivePriceUsd;

  let fulfillment, storage, placement, returns;
  let overrideReceipt = null;
  if (calculator_verified_override !== null && calculator_verified_override !== undefined) {
    const ov = validateCalculatorVerifiedOverride(calculator_verified_override, {
      price_usd: fulfillmentTierPriceUsd,
      pkg,
      sales_window: effectiveSalesWindow,
      storage_window: effectiveStorageWindow,
      rPhysical,
      fee_category,
      is_apparel: is_apparel ?? is_apparel_or_shoes,
      is_dangerous_goods,
      is_sipp,
    });
    if (!ov.valid) {
      return { status: 'needs_calculator_verification', reason: ov.reason };
    }
    overrideReceipt = ov.receipt;
    fulfillment = ov.fulfillment;
    storage = ov.storage;
    placement = ov.placement;
    returns = ov.returns;
  } else {
    const effReqPkg = requires_amazon_packaging !== undefined ? requires_amazon_packaging : pkg?.requires_amazon_packaging;
    fulfillment = lookupBulkyFulfillmentFee2027({
      pkg,
      price_usd: fulfillmentTierPriceUsd,
      sales_window: effectiveSalesWindow,
      is_apparel,
      is_shoes,
      is_apparel_or_shoes,
      is_dangerous_goods,
      is_sipp,
      sipp_discount_usd,
      requires_amazon_packaging: effReqPkg,
      low_price_eligible,
      fee_category,
    });
    if (fulfillment.status !== 'verified') return fulfillment;
    storage = lookupBulkyStorageFee2027({
      pkg,
      storage_window: effectiveStorageWindow,
      average_inventory_days,
      is_apparel,
      is_dangerous_goods,
    });
    if (storage.status !== 'verified') return storage;
    const requiresVerifiedOptForExplicitPlacement = Boolean(
      finite(placement_usd) &&
      placement_usd >= 0 &&
      fulfillment.tier_family !== 'oversize' &&
      (placement_split_option === 'amazon_optimized' || ((profile_revision ?? 0) >= 59 && round(placement_usd) === 0)) &&
      !isAmazonOptimizedPlacementVerified2027({
        identical_cartons_count,
        multi_destination_headhaul_verified,
      }),
    );
    placement = finite(placement_usd) && placement_usd >= 0 && !requiresVerifiedOptForExplicitPlacement
      ? { status: 'verified', selected_usd: round(placement_usd), range_usd: [round(placement_usd), round(placement_usd)], split_option: 'explicit' }
      : (useUnified2027Tiers
        ? lookupBulkyPlacementFee2027({
          pkg,
          inbound_window: effectiveInboundWindow,
          split_option: requiresVerifiedOptForExplicitPlacement ? 'amazon_optimized' : placement_split_option,
          is_apparel,
          is_dangerous_goods,
          carton_count,
          identical_cartons_count,
          multi_destination_headhaul_verified,
        })
        : lookupPlacementFee2027({
          pkg,
          inbound_window: effectiveInboundWindow,
          split_option: requiresVerifiedOptForExplicitPlacement ? 'amazon_optimized' : placement_split_option,
          is_dangerous_goods,
          carton_count,
          identical_cartons_count,
          multi_destination_headhaul_verified,
        }));
    if (placement.status !== 'verified') return placement;
    returns = useUnified2027Tiers
      ? lookupBulkyReturnsProcessing2027({
        pkg,
        physical_return_fraction: rPhysical,
        fee_category,
        return_threshold,
        sales_window: effectiveSalesWindow,
        is_apparel,
        is_shoes,
        is_apparel_or_shoes,
        is_dangerous_goods,
      })
      : lookupReturnsProcessing2027({
        pkg,
        physical_return_fraction: rPhysical,
        fee_category,
        return_threshold,
        sales_window: effectiveSalesWindow,
        is_apparel_or_shoes: is_apparel_or_shoes ?? is_apparel,
        is_dangerous_goods,
      });
    if (returns.status !== 'verified') return returns;
  }

  let referral;
  try {
    referral = netReferral({ ...referral_terms, price_usd: effectivePriceUsd, refund_fraction });
  } catch (err) {
    return { status: 'needs_calculator_verification', reason: err.message };
  }

  const computedCouponFee = isR59Coupon && include_coupon_fee !== false
    ? computeAmazonCouponRedemptionFee2027({
      net_effective_price_usd: effectivePriceUsd,
      ongoing_coupon_usd,
      ongoing_coupon_pct,
      coupon_redemption_share,
      coupon_campaign_units,
      include_campaign_flat_usd: include_coupon_campaign_flat,
    })
    : { applicable: false, per_unit_usd: 0, variable_2_5pct_usd: 0, campaign_flat_per_unit_usd: 0, exact_usd_rational: { n: 0n, d: 1n } };
  const explicitCouponUsd = isR59Coupon && include_coupon_fee !== false && finite(coupon_redemption_fee_usd) && coupon_redemption_fee_usd > 0
    ? round(coupon_redemption_fee_usd)
    : 0;
  const couponFee = computedCouponFee.applicable && computedCouponFee.per_unit_usd >= explicitCouponUsd
    ? computedCouponFee
    : (explicitCouponUsd > 0
      ? { applicable: true, per_unit_usd: explicitCouponUsd, variable_2_5pct_usd: explicitCouponUsd, campaign_flat_per_unit_usd: 0, exact_usd_rational: toBigRat(explicitCouponUsd) }
      : { applicable: false, per_unit_usd: 0, variable_2_5pct_usd: 0, campaign_flat_per_unit_usd: 0, exact_usd_rational: { n: 0n, d: 1n } });

  const couponAlreadyInOther = Boolean(
    coupon_fee_already_in_other === true &&
    couponFee.applicable &&
    couponFee.per_unit_usd > 0 &&
    finite(other_applicable_usd) &&
    other_applicable_usd >= couponFee.per_unit_usd - 0.005,
  );
  const extraCouponFeeUsd = couponAlreadyInOther ? 0 : couponFee.per_unit_usd;

  const netRevenue = effectivePriceUsd * (1 - refund_fraction);
  const amazonDeductions = [
    referral.net_usd,
    fulfillment.total_usd,
    placement.selected_usd,
    storage.per_unit_usd,
    returns.expected_fee_per_shipped_unit_usd,
    ...(couponFee.applicable && couponFee.per_unit_usd > 0 && !(couponAlreadyInOther && other_payee === 'amazon')
      ? [couponFee.per_unit_usd]
      : []),
    ...(other_payee === 'amazon' && other_applicable_usd > 0 ? [other_applicable_usd] : []),
  ];
  const payout = collectionFromDisbursement({
    net_revenue_usd: netRevenue,
    amazon_deductions_usd: amazonDeductions,
    rate: collection_rate,
  });

  // A = all non-landed-domestic USD costs (independent of 1688 goods & domestic freight).
  const nonDomesticCostA = round(
    headhaul_usd +
    referral.net_usd +
    fulfillment.total_usd +
    placement.selected_usd +
    storage.per_unit_usd +
    returns.expected_fee_per_shipped_unit_usd +
    extraCouponFeeUsd +
    payout.collection_usd +
    other_applicable_usd,
  );
  const landedCapUsd = round((1 - margin_floor) * netRevenue - nonDomesticCostA);
  const landedCapCny = round(landedCapUsd * fx_cny_per_usd);
  const bareGoodsCapUsd = finite(domestic_freight_usd) && domestic_freight_usd >= 0
    ? round(landedCapUsd - domestic_freight_usd)
    : null;
  const bareGoodsCapCny = bareGoodsCapUsd !== null ? round(bareGoodsCapUsd * fx_cny_per_usd) : null;

  // Exact BigInt rational comparison for zero_browser_fail (summing components WITHOUT premature 10-decimal rounding):
  // Fails only when exact landedCap < 0 OR a proven positive min_landed_domestic_usd > exact landedCap.
  const ratAdd = (a, b) => {
    const n = a.n * b.d + b.n * a.d;
    const d = a.d * b.d;
    const g = gcdBig(n < 0n ? -n : n, d);
    return { n: n / g, d: d / g };
  };
  const exactCostComponents = [
    headhaul_usd,
    referral.net_usd,
    fulfillment.total_usd,
    placement.selected_usd,
    storage.per_unit_usd,
    returns.expected_fee_per_shipped_unit_usd,
    extraCouponFeeUsd,
    payout.collection_usd,
    other_applicable_usd,
  ];
  const aR = exactCostComponents.reduce((acc, v) => ratAdd(acc, toRat(v)), { n: 0n, d: 1n });
  const pR = toRat(effectivePriceUsd), refR = toRat(refund_fraction), flR = toRat(margin_floor);
  const netRevRat = { n: pR.n * (refR.d - refR.n), d: pR.d * refR.d };
  const allowCostRat = { n: netRevRat.n * (flR.d - flR.n), d: netRevRat.d * flR.d };
  const landedCapRat = { n: allowCostRat.n * aR.d - aR.n * allowCostRat.d, d: allowCostRat.d * aR.d };
  const landedCostRat = exactLandedUsd ?? toRat(min_landed_domestic_usd ?? 0);
  const zeroBrowserFail = ratCmp(landedCostRat, landedCapRat) > 0;
  const nonDomesticCostExceeds70Pct = aR.n * netRevRat.d * 10n > 7n * netRevRat.n * aR.d;

  return {
    status: 'verified',
    version: overrideReceipt ? `calculator-override:${overrideReceipt.observed_at}` : FBA_2027_METADATA.version,
    ...(overrideReceipt ? { verification_source: 'calculator_verified_override', override_receipt: overrideReceipt } : {}),
    price_usd: effectivePriceUsd,
    ...(pricing.has_ongoing_discount || list_price_usd !== undefined || net_effective_price_usd !== undefined ? {
      list_price_usd: pricing.list_price_usd,
      net_effective_price_usd: pricing.net_effective_price_usd,
      ongoing_discount_usd: pricing.total_discount_usd,
    } : {}),
    size_tier: fulfillment.size_tier,
    price_band: fulfillment.price_band,
    ...(isR59Coupon ? {
      fulfillment_tier_price_basis: !hasPrimeDiscount ? 'list_price_usd' : 'net_effective_price_usd',
      coupon_fee_usd: couponFee.per_unit_usd,
    } : {}),
    net_revenue_usd: round(netRevenue),
    fx_cny_per_usd,
    non_domestic_cost_a_usd: nonDomesticCostA,
    landed_domestic_cap_usd: landedCapUsd,
    landed_domestic_cap_cny: landedCapCny,
    bare_goods_cap_usd: bareGoodsCapUsd,
    bare_goods_cap_cny: bareGoodsCapCny,
    non_domestic_cost_exceeds_70pct_at_zero_goods: nonDomesticCostExceeds70Pct,
    zero_browser_fail: zeroBrowserFail,
    components: {
      referral,
      fulfillment,
      placement,
      storage,
      returns_processing: returns,
      ...(couponFee.applicable ? {
        coupon_fee: {
          applicable: true,
          per_unit_usd: couponFee.per_unit_usd,
          variable_2_5pct_usd: couponFee.variable_2_5pct_usd,
          campaign_flat_per_unit_usd: couponFee.campaign_flat_per_unit_usd,
          coupon_campaign_units: couponFee.coupon_campaign_units,
          coupon_redemption_share: couponFee.coupon_redemption_share,
        },
      } : {}),
      collection: payout,
      headhaul_usd: round(headhaul_usd),
      other_applicable_usd: round(other_applicable_usd),
    },
  };
}

/**
 * Evaluate the $50.00 US FBA price-tier cliff across $49.99, $50.00, $50.01 (and optional anchor price).
 * Returns independent stress comparisons without altering the primary reference price.
 */
export function evaluatePriceCliff2027(params, { landed_domestic_usd = null, candidate_prices = [49.99, 50.00, 50.01] } = {}) {
  const pricing = resolveEffectivePricing(params);
  const anchorPrice = pricing.valid ? pricing.net_effective_price_usd : (finite(params?.price_usd) && params.price_usd > 0 ? params.price_usd : null);
  const cleanParams = { ...params };
  delete cleanParams.list_price_usd;
  delete cleanParams.net_effective_price_usd;
  delete cleanParams.ongoing_coupon_usd;
  delete cleanParams.ongoing_coupon_pct;
  delete cleanParams.prime_exclusive_discount_usd;
  delete cleanParams.prime_exclusive_discount_pct;
  delete cleanParams.promo_basis_already_net;

  const uniquePrices = [...new Set([
    ...candidate_prices,
    ...(anchorPrice !== null ? [anchorPrice] : []),
  ])].sort((a, b) => a - b);

  const points = uniquePrices.map(price => {
    const est = estimateGate1A2027({ ...cleanParams, price_usd: price });
    if (est.status !== 'verified') return { price_usd: price, status: est.status, reason: est.reason };
    let contributionUsd = null;
    let margin = null;
    if (finite(landed_domestic_usd) && landed_domestic_usd >= 0) {
      const totalCost = est.non_domestic_cost_a_usd + landed_domestic_usd;
      contributionUsd = round(est.net_revenue_usd - totalCost);
      margin = contributionUsd / est.net_revenue_usd;
    }
    return {
      price_usd: price,
      status: 'verified',
      price_band: est.price_band,
      fulfillment_usd: est.components.fulfillment.total_usd,
      referral_usd: est.components.referral.net_usd,
      collection_usd: est.components.collection.collection_usd,
      net_revenue_usd: est.net_revenue_usd,
      non_domestic_cost_a_usd: est.non_domestic_cost_a_usd,
      landed_domestic_cap_usd: est.landed_domestic_cap_usd,
      landed_domestic_cap_cny: est.landed_domestic_cap_cny,
      contribution_usd: contributionUsd,
      margin,
    };
  });

  const p4999 = points.find(p => p.price_usd === 49.99 && p.status === 'verified');
  const p5000 = points.find(p => p.price_usd === 50.00 && p.status === 'verified');
  const p5001 = points.find(p => p.price_usd === 50.01 && p.status === 'verified');
  const anchor = anchorPrice !== null ? points.find(p => p.price_usd === anchorPrice && p.status === 'verified') : null;
  const cliffJumpUsd = p5000 && p5001 ? round(p5001.fulfillment_usd - p5000.fulfillment_usd) : null;
  const sweetCandidate = p5000 ?? p4999;
  const sweetSpotBetter = Boolean(
    anchor && anchor.price_usd > 50 && anchor.price_usd <= 51.5 && sweetCandidate &&
    ((sweetCandidate.contribution_usd !== null && anchor.contribution_usd !== null && sweetCandidate.contribution_usd > anchor.contribution_usd) ||
      (sweetCandidate.landed_domestic_cap_usd > anchor.landed_domestic_cap_usd)),
  );

  return {
    status: points.every(p => p.status === 'verified') ? 'verified' : 'partial',
    cliff_jump_usd: cliffJumpUsd,
    sweet_spot_alert: sweetSpotBetter,
    sweet_spot_note: sweetSpotBetter
      ? '定价甜点提示：定 $49.99 或 $50.00 卡入 $10–$50 低一档 FBA 配送费，单件实赚或可承受采购上限反而更高（独立压力参考，不篡改有据主价锚）。'
      : null,
    points,
  };
}

const QUOTE_PACKAGE_MEASURES = [
  'length_in', 'width_in', 'height_in', 'length_cm', 'width_cm', 'height_cm',
  'weight_lb', 'unit_weight_lb', 'weight_oz', 'unit_weight_oz', 'weight_kg', 'unit_weight_kg',
];
const QUOTE_PACKAGE_FLAG_ALIASES = [
  ['is_apparel_or_shoes', 'is_apparel'], ['is_dangerous_goods'], ['is_sipp'], ['is_oversize'],
];

export function bindSourcingQuotePricingInputs(quote, scenario = {}, { requireDeclaredPackage = false } = {}) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    return { issue: 'A landed domestic quote must be an object.' };
  }
  scenario ??= {};
  const quoteFx = quote.fx_cny_per_usd;
  const scenarioFx = scenario.fx_cny_per_usd;
  if (quoteFx != null && (!finite(quoteFx) || quoteFx <= 0)) {
    return { issue: 'Quote fx_cny_per_usd must be a positive finite number.' };
  }
  if (quoteFx != null && scenarioFx != null && quoteFx !== scenarioFx) {
    return { issue: 'Quote fx_cny_per_usd conflicts with the scenario FX.' };
  }

  let pkg = scenario.pkg;
  const quotePkg = quote.pkg;
  if (quotePkg != null) {
    if (typeof quotePkg !== 'object' || Array.isArray(quotePkg)) {
      return { issue: 'Quote pkg must describe the complete saleable package.' };
    }
    const quotedMeasures = Object.fromEntries(QUOTE_PACKAGE_MEASURES
      .filter(key => Object.hasOwn(quotePkg, key) && quotePkg[key] != null)
      .map(key => [key, quotePkg[key]]));
    const quoteDims = resolvePackageDimsRat(quotedMeasures);
    if (!quoteDims?.wtLbRat) {
      return { issue: 'Quote pkg requires consistent positive dimensions and weight for the complete saleable package.' };
    }
    if (pkg == null && requireDeclaredPackage) {
      return { issue: 'Rerun Gate 1A with the quoted package to verify its fees.' };
    }
    if (pkg != null) {
      const scenarioDims = resolvePackageDimsRat(pkg);
      if (!scenarioDims?.wtLbRat || ['s1Rat', 's2Rat', 's3Rat', 'wtLbRat'].some(key => ratCmp(quoteDims[key], scenarioDims[key]) !== 0)) {
        return { issue: 'Quote pkg dimensions or weight conflict with the scenario package.' };
      }
    }
    const flags = {};
    for (const aliases of QUOTE_PACKAGE_FLAG_ALIASES) {
      const quoted = resolveConsistentBoolean(aliases.map(key => Object.hasOwn(quotePkg, key) ? quotePkg[key] : undefined));
      if (!quoted.valid) return { issue: 'Quote pkg flags must be consistent booleans.' };
      const declared = aliases.flatMap(key => [pkg?.[key], scenario[key]]).filter(value => value !== undefined);
      const resolved = resolveConsistentBoolean([
        ...(quoted.present ? [quoted.value] : []),
        ...(requireDeclaredPackage && declared.length === 0 ? [false] : declared),
      ]);
      if (!resolved.valid) return { issue: 'Quote pkg flags conflict with the scenario package.' };
      if (resolved.present) flags[aliases[0]] = resolved.value;
    }
    pkg = { ...quotedMeasures, ...flags };
  }

  const fx = quoteFx ?? scenarioFx;
  return {
    pkg,
    fx_cny_per_usd: fx,
    pricing_input_basis: {
      pkg: quotePkg != null ? 'quote' : pkg != null ? 'scenario_assumption' : null,
      fx_cny_per_usd: quoteFx != null ? 'quote' : fx != null ? 'scenario_assumption' : null,
    },
  };
}

/**
 * Bidirectional forward breakeven selling price solver (1688 landed cost -> exact minimum US retail price
 * achieving >= margin_floor across Amazon US 2027 $10/$50 FBA fulfillment tier cliffs).
 * Uses exact cent-level binary search inside each monotonic price band with BigInt zero_browser_fail verification.
 */
export function solveMinPriceForMargin2027({
  landed_domestic_cny = null,
  landed_domestic_usd = null,
  landed_domestic_quote = null,
  fx_cny_per_usd: scenarioFx,
  margin_floor = 0.30,
  min_retail_price_usd = 29.99,
  low_price_eligible = true,
  max_search_price_usd = 100000,
  ...gate1aParams
} = {}) {
  const quoteInputs = landed_domestic_quote === null
    ? null
    : bindSourcingQuotePricingInputs(landed_domestic_quote, { ...gate1aParams, fx_cny_per_usd: scenarioFx });
  if (quoteInputs?.issue) {
    return { status: 'needs_calculator_verification', reason: quoteInputs.issue };
  }
  const fx_cny_per_usd = quoteInputs?.fx_cny_per_usd ?? scenarioFx;
  if (!finite(fx_cny_per_usd) || fx_cny_per_usd <= 0 || !finite(margin_floor) || margin_floor < 0.3 || margin_floor >= 1) {
    return { status: 'needs_calculator_verification', reason: 'Valid fx_cny_per_usd > 0 and margin_floor in [0.3, 1) are required.' };
  }
  if (!finite(min_retail_price_usd) || min_retail_price_usd <= 0 || !finite(max_search_price_usd) || max_search_price_usd < min_retail_price_usd) {
    return { status: 'needs_calculator_verification', reason: 'Valid positive min_retail_price_usd <= max_search_price_usd is required.' };
  }
  const hasCny = landed_domestic_cny !== null && landed_domestic_cny !== undefined;
  const hasUsd = landed_domestic_usd !== null && landed_domestic_usd !== undefined;
  if (!hasCny && !hasUsd && landed_domestic_quote === null) {
    return { status: 'needs_calculator_verification', reason: 'A landed domestic quote or landed_domestic_cny/USD amount is required.' };
  }
  if ((hasCny && (!finite(landed_domestic_cny) || landed_domestic_cny < 0)) ||
    (hasUsd && (!finite(landed_domestic_usd) || landed_domestic_usd < 0))) {
    return { status: 'needs_calculator_verification', reason: 'landed_domestic_cny / landed_domestic_usd must be nonnegative finite numbers.' };
  }
  let landedCnyRat = hasCny ? toBigRat(landed_domestic_cny) : null;
  if (landed_domestic_quote !== null) {
    const { goods_cny_total, domestic_freight_cny_total, actual_sets } = landed_domestic_quote;
    if (hasCny || hasUsd || !finite(goods_cny_total) || goods_cny_total <= 0 ||
      !finite(domestic_freight_cny_total) || domestic_freight_cny_total < 0 ||
      !Number.isSafeInteger(actual_sets) || actual_sets < 100) {
      return { status: 'needs_calculator_verification', reason: 'Quote requires positive goods, nonnegative domestic freight and at least 100 actual sets with no separate landed cost.' };
    }
    landedCnyRat = divBigRat(addBigRat(toBigRat(goods_cny_total), toBigRat(domestic_freight_cny_total)), toBigRat(actual_sets));
  }
  const fxRat = toBigRat(fx_cny_per_usd);
  const derivedUsdRat = landedCnyRat ? divBigRat(landedCnyRat, fxRat) : null;
  const derivedUsd = derivedUsdRat ? roundBigRat(derivedUsdRat.n, derivedUsdRat.d, 10) : null;
  if (hasCny && hasUsd && Math.abs(derivedUsd - landed_domestic_usd) > 1e-4) {
    return { status: 'needs_calculator_verification', reason: 'Supplied landed_domestic_usd conflicts with landed_domestic_cny / fx_cny_per_usd.' };
  }
  const landedUsdRat = hasUsd ? toBigRat(landed_domestic_usd) : derivedUsdRat;
  const landedUsd = hasUsd ? landed_domestic_usd : derivedUsd;
  landedCnyRat ??= mulBigRat(landedUsdRat, fxRat);
  const landedCny = hasCny ? landed_domestic_cny : roundBigRat(landedCnyRat.n, landedCnyRat.d, 10);

  const solverCouponUsd = finite(gate1aParams.ongoing_coupon_usd) && gate1aParams.ongoing_coupon_usd > 0 ? gate1aParams.ongoing_coupon_usd : 0;
  const solverCouponPct = finite(gate1aParams.ongoing_coupon_pct) && gate1aParams.ongoing_coupon_pct > 0 && gate1aParams.ongoing_coupon_pct < 1 ? gate1aParams.ongoing_coupon_pct : 0;
  const solverHasPrime = (finite(gate1aParams.prime_exclusive_discount_usd) && gate1aParams.prime_exclusive_discount_usd > 0) ||
    (finite(gate1aParams.prime_exclusive_discount_pct) && gate1aParams.prime_exclusive_discount_pct > 0);
  const solverCouponActive = Boolean((gate1aParams.profile_revision ?? 59) >= 59 && !solverHasPrime && (solverCouponUsd > 0 || solverCouponPct > 0));

  const cleanParams = { ...gate1aParams, ...(quoteInputs ? { pkg: quoteInputs.pkg } : {}), fx_cny_per_usd, margin_floor };
  delete cleanParams.price_usd;
  delete cleanParams.list_price_usd;
  delete cleanParams.net_effective_price_usd;
  delete cleanParams.ongoing_coupon_usd;
  delete cleanParams.ongoing_coupon_pct;
  delete cleanParams.prime_exclusive_discount_usd;
  delete cleanParams.prime_exclusive_discount_pct;
  delete cleanParams.promo_basis_already_net;

  const listPriceAtNetCents = cents => {
    const netUsd = cents / 100;
    if (!solverCouponActive) return netUsd;
    return solverCouponUsd > 0
      ? Math.round((netUsd + solverCouponUsd) * 100) / 100
      : Math.round((netUsd / (1 - solverCouponPct)) * 100) / 100;
  };

  const evalAtCents = cents => estimateGate1AWithLandedCost({
    ...cleanParams,
    low_price_eligible,
    price_usd: cents / 100,
    ...(solverCouponActive ? {
      list_price_usd: listPriceAtNetCents(cents),
      net_effective_price_usd: cents / 100,
      ongoing_coupon_usd: solverCouponUsd > 0 ? solverCouponUsd : undefined,
      ongoing_coupon_pct: solverCouponPct > 0 ? solverCouponPct : undefined,
      promo_basis_already_net: true,
    } : {}),
    min_landed_domestic_usd: null,
  }, landedUsdRat);

  // Round the ceiling down and the floor up to whole payable cents.
  const ceilingRat = toBigRat(max_search_price_usd);
  const floorRat = toBigRat(min_retail_price_usd);
  const maxCents = Number(ceilingRat.n * 100n / ceilingRat.d);
  const floorCents = Number((floorRat.n * 100n + floorRat.d - 1n) / floorRat.d);
  if (!Number.isSafeInteger(maxCents)) {
    return { status: 'needs_calculator_verification', reason: 'Maximum search price exceeds the safe cent range.' };
  }
  if (maxCents < floorCents) {
    return { status: 'infeasible', landed_domestic_usd: landedUsd, landed_domestic_cny: landedCny, margin_floor, reason: 'No whole-cent retail price lies within [min_retail_price_usd, max_search_price_usd].' };
  }

  const searchBand = (loCents, hiCents) => {
    if (loCents > hiCents) return { state: 'out_of_range', sol: null, reason: null };
    const hiEst = evalAtCents(hiCents);
    if (hiEst.status !== 'verified') {
      return { state: 'unverified', sol: null, reason: hiEst.reason };
    }
    if (hiEst.zero_browser_fail) {
      return { state: 'infeasible', sol: null, reason: null };
    }
    let lo = loCents;
    let hi = hiCents;
    let bestEst = hiEst;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midEst = evalAtCents(mid);
      if (midEst.status !== 'verified') {
        return { state: 'unverified', sol: null, reason: midEst.reason };
      }
      if (!midEst.zero_browser_fail) {
        bestEst = midEst;
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return { state: 'feasible', sol: { cents: hi, price_usd: hi / 100, estimate: bestEst }, reason: null };
  };

  const under10MaxNetCents = solverCouponActive
    ? (solverCouponUsd > 0 ? Math.max(0, Math.round((9.99 - solverCouponUsd) * 100)) : Math.max(0, Math.floor(9.99 * (1 - solverCouponPct) * 100)))
    : 999;
  const band10To50MinNetCents = Math.max(100, under10MaxNetCents + 1);
  const band10To50MaxNetCents = solverCouponActive
    ? (solverCouponUsd > 0 ? Math.max(0, Math.round((50.00 - solverCouponUsd) * 100)) : Math.max(0, Math.floor(50.00 * (1 - solverCouponPct) * 100)))
    : 5000;
  const over50MinNetCents = Math.max(100, band10To50MaxNetCents + 1);

  const resUnder10 = low_price_eligible && under10MaxNetCents >= 100
    ? searchBand(100, Math.min(under10MaxNetCents, maxCents))
    : { state: 'out_of_range', sol: null, reason: null };
  const res10To50 = band10To50MaxNetCents >= band10To50MinNetCents
    ? searchBand(band10To50MinNetCents, Math.min(band10To50MaxNetCents, maxCents))
    : { state: 'out_of_range', sol: null, reason: null };

  let resOver50 = { state: 'out_of_range', sol: null, reason: null };
  if (maxCents >= over50MinNetCents) {
    let hi = Math.min(over50MinNetCents, maxCents);
    let hiEst = evalAtCents(hi);
    if (hiEst.status !== 'verified') {
      resOver50 = { state: 'unverified', sol: null, reason: hiEst.reason };
    } else {
      while (hi < maxCents && hiEst.status === 'verified' && hiEst.zero_browser_fail) {
        hi = Math.min(maxCents, hi * 2);
        hiEst = evalAtCents(hi);
      }
      if (hiEst.status !== 'verified') {
        resOver50 = { state: 'unverified', sol: null, reason: hiEst.reason };
      } else if (!hiEst.zero_browser_fail) {
        resOver50 = searchBand(over50MinNetCents, hi);
      } else {
        resOver50 = { state: 'infeasible', sol: null, reason: null };
      }
    }
  }

  const bandEntries = [
    { key: 'under_10', lo: 100, hi: Math.min(under10MaxNetCents, maxCents), res: resUnder10 },
    { key: '10_to_50', lo: band10To50MinNetCents, hi: Math.min(band10To50MaxNetCents, maxCents), res: res10To50 },
    { key: 'over_50', lo: over50MinNetCents, hi: maxCents, res: resOver50 },
  ].filter(b => b.res.state !== 'out_of_range');

  const overlappingBands = bandEntries.filter(b => b.hi >= floorCents && b.lo <= maxCents);

  // Determine exact feasible minimum in [floorCents, maxCents]; never falsely claim infeasible or a higher-band minimum
  // when an overlapping band (or lower overlapping band) is unverified (needs_calculator_verification)!
  let feasibleSol = null;
  for (const b of overlappingBands) {
    if (b.res.state === 'unverified') {
      return {
        status: 'needs_calculator_verification',
        landed_domestic_usd: landedUsd,
        landed_domestic_cny: landedCny,
        margin_floor,
        reason: b.res.reason || `Band "${b.key}" requires calculator verification before determining minimum feasible selling price.`,
      };
    }
    if (b.res.state === 'feasible') {
      const candCents = Math.max(b.res.sol.cents, floorCents);
      if (candCents <= b.hi) {
        const candEst = candCents === b.res.sol.cents ? b.res.sol.estimate : evalAtCents(candCents);
        if (candEst.status !== 'verified') {
          return {
            status: 'needs_calculator_verification',
            landed_domestic_usd: landedUsd,
            landed_domestic_cny: landedCny,
            margin_floor,
            reason: candEst.reason,
          };
        }
        if (!candEst.zero_browser_fail) {
          feasibleSol = { cents: candCents, price_usd: candCents / 100, estimate: candEst };
          break;
        }
      }
    }
  }

  const solUnder10 = resUnder10.sol;
  const sol10To50 = res10To50.sol;
  const solOver50 = resOver50.sol;
  const orderedSolutions = [solUnder10, sol10To50, solOver50].filter(Boolean);
  if (orderedSolutions.length === 0) {
    const anyUnverified = bandEntries.find(b => b.res.state === 'unverified');
    if (anyUnverified) {
      return {
        status: 'needs_calculator_verification',
        landed_domestic_usd: landedUsd,
        landed_domestic_cny: landedCny,
        margin_floor,
        reason: anyUnverified.res.reason || `Fee schedule verification required for band "${anyUnverified.key}".`,
      };
    }
    return {
      status: 'infeasible',
      landed_domestic_usd: landedUsd,
      landed_domestic_cny: landedCny,
      margin_floor,
      reason: `No retail price up to USD ${max_search_price_usd} satisfies ${(margin_floor * 100).toFixed(1)}% pre-ad margin (variable fees or cost structure exceed floor).`,
    };
  }

  const unconstrained = orderedSolutions[0];

  // Detect $50.00 FBA fulfillment tier cliff dead zone: list $50.00 passes, list $50.01 fails, recovers at solOver50.
  let cliffDeadZone = null;
  if (sol10To50 && solOver50 && solOver50.cents > over50MinNetCents) {
    const estOver50Start = evalAtCents(over50MinNetCents);
    if (estOver50Start.status === 'verified' && estOver50Start.zero_browser_fail) {
      const deadStartUsd = round(over50MinNetCents / 100);
      const sweetSpotUsd = round(band10To50MaxNetCents / 100);
      cliffDeadZone = {
        from_usd: deadStartUsd,
        through_usd: round((solOver50.cents - 1) / 100),
        over_50_recovery_price_usd: solOver50.price_usd,
        note: `定价悬崖死区：$${sweetSpotUsd.toFixed(2)} 达标，但 $${deadStartUsd.toFixed(2)} 至 $${((solOver50.cents - 1) / 100).toFixed(2)} 因跳入 over_50 FBA 费档跌破 ${(margin_floor * 100).toFixed(0)}% 红线，需涨至 $${solOver50.price_usd.toFixed(2)} 才重新达标。`,
      };
    }
  }

  const computeMarginAt = est => {
    const totalCost = est.non_domestic_cost_a_usd + landedUsd;
    const contrib = round(est.net_revenue_usd - totalCost);
    return { contribution_usd: contrib, margin: contrib / est.net_revenue_usd };
  };
  const winningEst = feasibleSol ? feasibleSol.estimate : unconstrained.estimate;

  return {
    status: 'verified',
    ...(quoteInputs ? { pricing_input_basis: quoteInputs.pricing_input_basis } : {}),
    version: winningEst.version ?? FBA_2027_METADATA.version,
    landed_domestic_usd: landedUsd,
    landed_domestic_cny: landedCny,
    margin_floor,
    min_retail_price_usd,
    unconstrained_min_price_usd: unconstrained.price_usd,
    feasible_min_price_usd: feasibleSol ? feasibleSol.price_usd : null,
    price_band: winningEst.price_band,
    at_feasible_price: feasibleSol ? { ...feasibleSol.estimate, ...computeMarginAt(feasibleSol.estimate) } : null,
    at_unconstrained_price: { ...unconstrained.estimate, ...computeMarginAt(unconstrained.estimate) },
    band_solutions: {
      under_10: solUnder10 ? { min_price_usd: solUnder10.price_usd, ...computeMarginAt(solUnder10.estimate) } : null,
      '10_to_50': sol10To50 ? { min_price_usd: sol10To50.price_usd, ...computeMarginAt(sol10To50.estimate) } : null,
      over_50: solOver50 ? { min_price_usd: solOver50.price_usd, ...computeMarginAt(solOver50.estimate) } : null,
    },
    cliff_dead_zone: cliffDeadZone,
  };
}

/**
 * Exact negotiation shortlist check for all-scenarios-below-30% economic failures.
 * Drops the old 26.5% heuristic cutoff; uses exact max(0, floor*R - G) / C <= maxDiscountFraction.
 */
export function computeNegotiationShortlist({
  net_revenue_usd,
  contribution_usd,
  negotiable_cost_usd,
  margin_floor = 0.30,
  max_discount_fraction = 0.12,
} = {}) {
  if (!finite(net_revenue_usd) || net_revenue_usd <= 0 || !finite(contribution_usd) ||
    !finite(negotiable_cost_usd) || negotiable_cost_usd <= 0 || !finite(margin_floor)) {
    return { eligible: false, required_discount_fraction: null, gap_usd: null, reason: 'Valid positive net revenue, contribution, and negotiable cost are required.' };
  }
  // Exact BigInt rational comparison without premature rounding: max(0, floor*R - G) / C <= max_discount_fraction
  const flRat = toRat(margin_floor);
  const revRat = toRat(net_revenue_usd);
  const contribRat = toRat(contribution_usd);
  const targetGRat = { n: flRat.n * revRat.n, d: flRat.d * revRat.d };
  const gapRat = { n: targetGRat.n * contribRat.d - contribRat.n * targetGRat.d, d: targetGRat.d * contribRat.d };
  if (gapRat.n <= 0n) {
    return { eligible: false, required_discount_fraction: 0, gap_usd: 0, reason: 'Scenario already meets or exceeds the margin floor.' };
  }
  const costRat = toRat(negotiable_cost_usd);
  const maxDiscRat = toRat(max_discount_fraction);
  const reqRat = { n: gapRat.n * costRat.d, d: gapRat.d * costRat.n };
  const eligible = ratCmp(reqRat, maxDiscRat) <= 0;
  const gapUsd = round(Number(gapRat.n) / Number(gapRat.d));
  return {
    eligible,
    required_discount_fraction: round((Number(gapRat.n) / Number(gapRat.d)) / negotiable_cost_usd),
    gap_usd: gapUsd,
    negotiable_cost_usd: round(negotiable_cost_usd),
    max_discount_fraction,
  };
}

/**
 * Gate 1B deterministic carton/MOQ order planner for single-SKU or multi-SKU sku_lines[].
 * - No-remainder path (K <= lcm_cap and !allow_remainder):
 *     K = lcm_i(p_i / gcd(p_i, q_i)), S_min = max(min_sets, max_i ceil(m_i / q_i)),
 *     S = K * ceil(S_min / K), ordered_i = S * q_i.
 * - Allow-remainder path (allow_remainder or K > lcm_cap):
 *     ordered_i = p_i * ceil(max(S * q_i, m_i) / p_i).
 * Always validates MOQ, carton-multiple, and complete-set invariants and reads back actual_complete_sets.
 */
export function computeOrderPlan({
  sku_lines,
  min_sets = 100,
  allow_remainder = false,
  target_sets = null,
  lcm_cap = undefined,
  profile_revision = undefined,
  profileRevision = undefined,
} = {}) {
  if (!Array.isArray(sku_lines) || sku_lines.length === 0) {
    throw new TypeError('A nonempty sku_lines array is required.');
  }
  if (!Number.isSafeInteger(min_sets) || min_sets < 100) {
    throw new TypeError('min_sets must be a safe integer >= 100.');
  }
  const hasExplicitLcmCap = lcm_cap !== undefined && lcm_cap !== null;
  const effectiveLcmCap = hasExplicitLcmCap ? lcm_cap : 200;
  if (!Number.isSafeInteger(effectiveLcmCap) || effectiveLcmCap < 1) {
    throw new TypeError('lcm_cap must be a positive safe integer.');
  }
  if (target_sets !== null && target_sets !== undefined && (!Number.isSafeInteger(target_sets) || target_sets < min_sets)) {
    throw new TypeError('target_sets must be a safe integer >= min_sets when supplied.');
  }

  const normalized = sku_lines.map((line, index) => {
    if (!line || typeof line !== 'object') throw new TypeError(`sku_lines[${index}] must be an object.`);
    const q = line.qty_per_saleable_set;
    const p = line.pack_multiple ?? 1;
    const m = line.moq_qty ?? 1;
    if (!Number.isSafeInteger(q) || q < 1) throw new TypeError(`sku_lines[${index}].qty_per_saleable_set must be a positive integer.`);
    if (!Number.isSafeInteger(p) || p < 1) throw new TypeError(`sku_lines[${index}].pack_multiple must be a positive integer.`);
    if (!Number.isSafeInteger(m) || m < 1) throw new TypeError(`sku_lines[${index}].moq_qty must be a positive integer.`);
    const unitPrice = line.unit_price_cny;
    if (unitPrice !== undefined && unitPrice !== null && (!finite(unitPrice) || unitPrice < 0)) {
      throw new TypeError(`sku_lines[${index}].unit_price_cny must be a nonnegative finite number.`);
    }
    return {
      ...(typeof line.component_id === 'string' && line.component_id.trim() ? { component_id: line.component_id.trim() } : {}),
      ...(typeof line.factory_id === 'string' && line.factory_id.trim() ? { factory_id: line.factory_id.trim() } : {}),
      ...(typeof line.supplier_id === 'string' && line.supplier_id.trim() ? { supplier_id: line.supplier_id.trim() } : {}),
      offer_id: line.offer_id ?? null,
      sku_id: line.sku_id ?? `sku-${index + 1}`,
      quote_unit: line.quote_unit ?? 'piece',
      qty_per_saleable_set: q,
      pack_multiple: p,
      moq_qty: m,
      unit_price_cny: unitPrice ?? null,
      regular_goods_promo_false: line.regular_goods_promo_false === true,
    };
  });

  const kList = normalized.map(l => BigInt(l.pack_multiple) / gcdBig(BigInt(l.pack_multiple), BigInt(l.qty_per_saleable_set)));
  const sMinList = normalized.map(l => ceilDivBig(BigInt(l.moq_qty), BigInt(l.qty_per_saleable_set)));
  const K = kList.reduce((acc, k) => lcmBig(acc, k), 1n);
  const sMin = sMinList.reduce((acc, s) => (s > acc ? s : acc), BigInt(min_sets));

  const safeNum = (bigVal, label) => {
    if (bigVal > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER (${bigVal.toString()}).`);
    }
    return Number(bigVal);
  };

  const effProfileRev = profile_revision ?? profileRevision ?? 58;
  const isR59AdvisoryLcm = effProfileRev >= 59 && !hasExplicitLcmCap;
  const highLcmAdvisory = K > BigInt(effectiveLcmCap);
  const useRemainderPath = Boolean(allow_remainder) || (!isR59AdvisoryLcm && highLcmAdvisory);
  let allocatedSets;
  let plannedLines;

  if (!useRemainderPath) {
    const minNeeded = target_sets !== null && target_sets !== undefined
      ? (BigInt(target_sets) > sMin ? BigInt(target_sets) : sMin)
      : sMin;
    const sBig = K * ceilDivBig(minNeeded, K);
    allocatedSets = safeNum(sBig, 'allocated_sets');
    plannedLines = normalized.map(line => {
      const ordered = safeNum(sBig * BigInt(line.qty_per_saleable_set), `ordered_qty(${line.sku_id})`);
      return { ...line, ordered_qty: ordered };
    });
  } else {
    // Permutation-invariant default allocated sets: sMin = max(min_sets, max_i ceil(moq_i / qty_i)).
    const sBig = target_sets !== null && target_sets !== undefined ? BigInt(target_sets) : sMin;
    allocatedSets = safeNum(sBig, 'allocated_sets');
    plannedLines = normalized.map(line => {
      const need = sBig * BigInt(line.qty_per_saleable_set);
      const minNeed = need > BigInt(line.moq_qty) ? need : BigInt(line.moq_qty);
      const pBig = BigInt(line.pack_multiple);
      const ordered = safeNum(pBig * ceilDivBig(minNeed, pBig), `ordered_qty(${line.sku_id})`);
      return { ...line, ordered_qty: ordered };
    });
  }

  // Enforce order invariants and read back actual_complete_sets.
  for (const line of plannedLines) {
    if (line.ordered_qty < line.moq_qty ||
      line.ordered_qty % line.pack_multiple !== 0 ||
      line.ordered_qty < allocatedSets * line.qty_per_saleable_set) {
      throw new Error(`Order invariant violation on ${line.sku_id}: ordered=${line.ordered_qty}, moq=${line.moq_qty}, pack=${line.pack_multiple}.`);
    }
  }
  const actualCompleteSets = Math.min(...plannedLines.map(line => Math.floor(line.ordered_qty / line.qty_per_saleable_set)));
  let totalGoodsRat = { n: 0n, d: 1n };
  let allPriced = true;
  const linesWithRemainders = plannedLines.map(line => {
    let lineGoodsCny = null;
    if (line.unit_price_cny !== null) {
      const lr = mulBigRat(toBigRat(line.ordered_qty), toBigRat(line.unit_price_cny));
      totalGoodsRat = addBigRat(totalGoodsRat, lr);
      lineGoodsCny = roundBigRat(lr.n, lr.d, 10);
    } else {
      allPriced = false;
    }
    return {
      ...line,
      remainder_vs_allocated: line.ordered_qty - allocatedSets * line.qty_per_saleable_set,
      remainder_vs_actual_complete: line.ordered_qty - actualCompleteSets * line.qty_per_saleable_set,
      line_goods_cny: lineGoodsCny,
    };
  });

  const totalGoodsCny = allPriced ? roundBigRat(totalGoodsRat.n, totalGoodsRat.d, 10) : null;
  const perAllocatedRat = allPriced ? divBigRat(totalGoodsRat, toBigRat(allocatedSets)) : null;
  const perCompleteRat = allPriced ? divBigRat(totalGoodsRat, toBigRat(actualCompleteSets)) : null;

  return {
    mode: useRemainderPath ? 'allow_remainder' : 'no_remainder_exact',
    lcm_step_sets: K <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(K) : K.toString(),
    allocated_sets: allocatedSets,
    actual_complete_sets: actualCompleteSets,
    has_remainder: linesWithRemainders.some(l => l.remainder_vs_allocated > 0),
    all_promo_clear: linesWithRemainders.every(l => l.regular_goods_promo_false),
    total_goods_cny: totalGoodsCny,
    per_allocated_set_goods_cny: perAllocatedRat ? roundBigRat(perAllocatedRat.n, perAllocatedRat.d, 10) : null,
    per_complete_set_goods_cny: perCompleteRat ? roundBigRat(perAllocatedRat.n, perCompleteRat.d, 10) : null,
    moq_capital_alert: allocatedSets >= 300 || actualCompleteSets >= 300,
    ...(isR59AdvisoryLcm && highLcmAdvisory ? {
      high_lcm_advisory: true,
      advisory_note: `装箱最小公倍数 K=${K.toString()} > ${effectiveLcmCap}，当前按零尾货整箱对齐核算，建议向工厂核实散箱／混装可行性以降低起订套数。`,
    } : {}),
    sku_lines: linesWithRemainders,
  };
}

const SIZE_TIER_RANK_2027 = Object.freeze({
  small_standard: 1,
  large_standard: 2,
  small_bulky: 3,
  medium_bulky: 4,
  large_bulky: 5,
  extra_large_bulky: 6,
  small_oversize: 7,
  medium_oversize: 8,
  large_oversize: 9,
  long_oversize: 10,
  special_oversize_light: 11,
  special_oversize_heavy: 12,
});

const AXIS_LABEL_ZH = Object.freeze({
  length: '长度',
  width: '宽度',
  height: '高度',
});

const ROLE_LABEL_ZH = Object.freeze({
  longest: '最长边',
  median: '次长边',
  shortest: '最短边',
});

function subBigRatLocal(a, b) {
  return addBigRat(a, { n: -b.n, d: b.d });
}

function floorBigRatDecimal(r, decimals = 8) {
  if (r.n <= 0n || r.d <= 0n) return 0;
  const scale = 10n ** BigInt(decimals);
  const scaled = (r.n * scale) / r.d;
  return Number(scaled) / Number(scale);
}

function ceilBigRatDecimal(r, decimals = 8) {
  if (r.n <= 0n || r.d <= 0n) return 0;
  const scale = 10n ** BigInt(decimals);
  const scaled = ceilDivBig(r.n * scale, r.d);
  return Number(scaled) / Number(scale);
}

/**
 * Packaging Down-Tier Rescuable Check (`packaging_redesign_shortlist`, peer-level with `negotiation_shortlist`).
 * For a candidate about to be rejected (`margin < 30%`), checks whether:
 *   1) Compressing a SINGLE package side (`length`, `width`, or `height`) by `> 0 mm` and `<= 10 mm` (`1 cm`,
 *      exact rational `50/127 in`) crosses a discrete 2027 FBA size-tier, special-handling, or dimensional-fee boundary
 *      into a lower FBA bracket (leaving the other two sides and unit weight unchanged); AND
 *   2) Under that single-side `<= 10 mm` compression, 2027 off-peak pre-ad margin reaches `>= 30%`.
 * Preserves primary margin `< 30%` (`counts_toward_target: false`) and outputs actionable millimeter/savings diagnostics.
 */
export function computePackagingRedesignShortlist2027({
  pkg,
  price_usd,
  list_price_usd = undefined,
  net_effective_price_usd = undefined,
  ongoing_coupon_usd = undefined,
  ongoing_coupon_pct = undefined,
  coupon_redemption_fee_usd = undefined,
  prime_exclusive_discount_usd = undefined,
  prime_exclusive_discount_pct = undefined,
  promo_basis_already_net = false,
  landed_domestic_usd = null,
  landed_domestic_cny = null,
  fx_cny_per_usd = undefined,
  refund_fraction = undefined,
  physical_return_fraction = null,
  fee_category = null,
  return_threshold = null,
  referral_terms = undefined,
  headhaul_usd = undefined,
  recompute_headhaul_fn = null,
  collection_rate = undefined,
  other_applicable_usd = 0,
  other_payee = 'external',
  sales_window = FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  storage_window = FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  inbound_window = FBA_2027_DEFAULT_INBOUND_WINDOW,
  average_inventory_days = 45,
  placement_split_option = 'minimal_west_conservative',
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = false,
  is_apparel,
  is_shoes,
  is_apparel_or_shoes,
  is_dangerous_goods,
  is_sipp,
  sipp_discount_usd = 0,
  requires_amazon_packaging = undefined,
  low_price_eligible = true,
  min_retail_price_usd = 29.99,
  margin_floor = 0.30,
  max_single_side_overshoot_mm = 10,
} = {}) {
  if (!pkg || typeof pkg !== 'object') {
    return { eligible: false, reason: 'Valid package object is required.' };
  }
  if (!finite(max_single_side_overshoot_mm) || max_single_side_overshoot_mm <= 0 || max_single_side_overshoot_mm > 10) {
    return { eligible: false, reason: 'max_single_side_overshoot_mm must be in (0, 10] mm (hard ceiling 10 mm / 1 cm).' };
  }
  if (!finite(fx_cny_per_usd) || fx_cny_per_usd <= 0) {
    return { eligible: false, reason: 'Explicit positive finite fx_cny_per_usd is required.' };
  }
  if (!finite(refund_fraction) || refund_fraction < 0 || refund_fraction >= 1) {
    return { eligible: false, reason: 'Explicit finite refund_fraction in [0, 1) is required.' };
  }
  if (!finite(headhaul_usd) || headhaul_usd < 0) {
    return { eligible: false, reason: 'Explicit nonnegative finite headhaul_usd is required.' };
  }
  if (!finite(collection_rate) || collection_rate < 0 || collection_rate >= 1) {
    return { eligible: false, reason: 'Explicit finite collection_rate in [0, 1) is required (do not rely on hidden 0.5% default; supply account rate such as 0.006).' };
  }
  if (!referral_terms || typeof referral_terms !== 'object') {
    return { eligible: false, reason: 'Explicit referral_terms object is required.' };
  }
  const hasUsd = landed_domestic_usd !== null && landed_domestic_usd !== undefined;
  const hasCny = landed_domestic_cny !== null && landed_domestic_cny !== undefined;
  if (!hasUsd && !hasCny) {
    return { eligible: false, reason: 'landed_domestic_usd or landed_domestic_cny is required.' };
  }
  if ((hasUsd && (!finite(landed_domestic_usd) || landed_domestic_usd < 0)) ||
    (hasCny && (!finite(landed_domestic_cny) || landed_domestic_cny < 0))) {
    return { eligible: false, reason: 'Landed domestic cost must be a nonnegative finite number.' };
  }
  const landedUsdRat = hasUsd ? toBigRat(landed_domestic_usd) : divBigRat(toBigRat(landed_domestic_cny), toBigRat(fx_cny_per_usd));
  const landedUsd = roundBigRat(landedUsdRat.n, landedUsdRat.d, 10);

  const pricing = resolveEffectivePricing({
    price_usd,
    list_price_usd,
    net_effective_price_usd,
    ongoing_coupon_usd,
    ongoing_coupon_pct,
    prime_exclusive_discount_usd,
    prime_exclusive_discount_pct,
    promo_basis_already_net,
  });
  if (!pricing.valid || pricing.net_effective_price_usd < min_retail_price_usd) {
    return { eligible: false, reason: pricing.reason ?? `Effective retail price ($${pricing.net_effective_price_usd}) is below $${min_retail_price_usd} floor.` };
  }

  const inKeys = ['length_in', 'width_in', 'height_in'];
  const cmKeys = ['length_cm', 'width_cm', 'height_cm'];
  const hasIn = inKeys.every(k => finite(pkg[k]) && pkg[k] > 0);
  const hasCm = cmKeys.every(k => finite(pkg[k]) && pkg[k] > 0);
  if (!hasIn && !hasCm) {
    return { eligible: false, reason: 'Package requires complete positive (length, width, height) in inches or cm.' };
  }
  const origDims = resolvePackageDimsRat(pkg);
  if (!origDims || !origDims.wtLbRat) {
    return { eligible: false, reason: 'Package requires valid positive dimensions and unit weight.' };
  }
  const preferCm = !hasIn && hasCm;
  const cmPerInRat = { n: 127n, d: 50n }; // exact 2.54 cm/in
  const mmPerInRat = { n: 127n, d: 5n }; // exact 25.4 mm/in
  const maxMmRat = toBigRat(max_single_side_overshoot_mm);
  const maxTrimInRat = divBigRat(maxMmRat, mmPerInRat); // for 10 mm: exact 50/127 in

  const baseEvalParams = {
    price_usd,
    list_price_usd,
    net_effective_price_usd,
    ongoing_coupon_usd,
    ongoing_coupon_pct,
    coupon_redemption_fee_usd,
    prime_exclusive_discount_usd,
    prime_exclusive_discount_pct,
    promo_basis_already_net,
    fx_cny_per_usd,
    refund_fraction,
    physical_return_fraction,
    fee_category,
    return_threshold,
    referral_terms,
    collection_rate,
    other_applicable_usd,
    other_payee,
    sales_window,
    storage_window,
    inbound_window,
    average_inventory_days,
    placement_usd: null,
    placement_split_option,
    carton_count,
    identical_cartons_count,
    multi_destination_headhaul_verified,
    margin_floor,
    is_apparel,
    is_shoes,
    is_apparel_or_shoes,
    is_dangerous_goods,
    is_sipp,
    sipp_discount_usd,
    requires_amazon_packaging,
    low_price_eligible,
    allow_bulky_2027: true,
    allow_all_2027_tiers: true,
    profile_revision: 59,
  };

  const origEst = estimateGate1AWithLandedCost({
    ...baseEvalParams,
    pkg,
    headhaul_usd,
  }, landedUsdRat);
  if (origEst.status !== 'verified') {
    return { eligible: false, reason: origEst.reason };
  }
  if (!origEst.zero_browser_fail) {
    return { eligible: false, reason: 'Scenario already meets or exceeds the 30% margin floor on original package.' };
  }

  const origContribUsd = round(origEst.net_revenue_usd - (origEst.non_domestic_cost_a_usd + landedUsd));
  const origMargin = origContribUsd / origEst.net_revenue_usd;
  const origFul = origEst.components.fulfillment;
  const origPlc = origEst.components.placement;
  const origSto = origEst.components.storage;
  const origRet = origEst.components.returns_processing;
  const origFbaTotalUsd = round(
    origFul.total_usd +
    origPlc.selected_usd +
    origSto.per_unit_usd +
    origRet.expected_fee_per_shipped_unit_usd,
  );
  const origTierRank = SIZE_TIER_RANK_2027[origEst.size_tier] ?? 99;

  const axes = [
    {
      axis: 'length',
      inKey: 'length_in',
      cmKey: 'length_cm',
      inRat: preferCm ? divBigRat(toBigRat(pkg.length_cm), cmPerInRat) : toBigRat(pkg.length_in),
    },
    {
      axis: 'width',
      inKey: 'width_in',
      cmKey: 'width_cm',
      inRat: preferCm ? divBigRat(toBigRat(pkg.width_cm), cmPerInRat) : toBigRat(pkg.width_in),
    },
    {
      axis: 'height',
      inKey: 'height_in',
      cmKey: 'height_cm',
      inRat: preferCm ? divBigRat(toBigRat(pkg.height_cm), cmPerInRat) : toBigRat(pkg.height_in),
    },
  ];
  const sortedIdx = [0, 1, 2].sort((a, b) => ratCmp(axes[b].inRat, axes[a].inRat));
  axes[sortedIdx[0]].role = 'longest';
  axes[sortedIdx[1]].role = 'median';
  axes[sortedIdx[2]].role = 'shortest';

  // Direct inclusive single-axis ceilings in inches across all 12 official 2027 US FBA tiers + Flat/Overhang handling boundaries
  const directBoundariesIn = [
    { n: 3n, d: 4n },   // 0.75 in Small Standard shortest
    { n: 4n, d: 1n },   // 4 in Oversize Flat Product shortest
    { n: 8n, d: 1n },   // 8 in Large Standard shortest
    { n: 10n, d: 1n },  // 10 in auxiliary boundary
    { n: 12n, d: 1n },  // 12 in Small Standard median
    { n: 14n, d: 1n },  // 14 in Large Standard median
    { n: 15n, d: 1n },  // 15 in Small Standard longest
    { n: 16n, d: 1n },  // 16 in auxiliary boundary
    { n: 18n, d: 1n },  // 18 in Large Standard longest
    { n: 20n, d: 1n },  // 20 in Small/Medium Bulky shortest
    { n: 22n, d: 1n },  // 22 in auxiliary boundary
    { n: 24n, d: 1n },  // 24 in Small Bulky median
    { n: 25n, d: 1n },  // 25 in Oversize Flat Product median
    { n: 26n, d: 1n },  // 26 in auxiliary boundary
    { n: 28n, d: 1n },  // 28 in Small Bulky longest / Medium Bulky median / Large Bulky median & shortest
    { n: 30n, d: 1n },  // 30 in auxiliary boundary
    { n: 32n, d: 1n },  // 32 in auxiliary boundary
    { n: 33n, d: 1n },  // 33 in Extra-Large Bulky median & shortest
    { n: 36n, d: 1n },  // 36 in auxiliary boundary
    { n: 37n, d: 1n },  // 37 in Medium Bulky longest
    { n: 40n, d: 1n },  // 40 in auxiliary boundary
    { n: 43n, d: 1n },  // 43 in Oversize Overhang median
    { n: 46n, d: 1n },  // 46 in auxiliary boundary
    { n: 47n, d: 1n },  // 47 in auxiliary boundary
    { n: 49n, d: 1n },  // 49 in auxiliary boundary
    { n: 52n, d: 1n },  // 52 in Large Bulky longest
    { n: 59n, d: 1n },  // 59 in Extra-Large Bulky longest
    { n: 60n, d: 1n },  // 60 in auxiliary boundary
    { n: 61n, d: 1n },  // 61 in auxiliary boundary
    { n: 70n, d: 1n },  // 70 in auxiliary boundary
    { n: 72n, d: 1n },  // 72 in Small Oversize longest
    { n: 78n, d: 1n },  // 78 in Medium Oversize longest
    { n: 96n, d: 1n },  // 96 in Large Oversize longest
    { n: 108n, d: 1n }, // 108 in Long Oversize longest
  ];
  // Strict `< 25 in` median boundary for Oversize Flat Product (`shortest < 4 && median >= 25`)
  const strictEpsIn = { n: 1n, d: 2540n }; // 0.01 mm

  const validCandidates = [];

  for (let i = 0; i < 3; i++) {
    const ax = axes[i];
    const other1 = axes[(i + 1) % 3].inRat;
    const other2 = axes[(i + 2) % 3].inRat;
    const minAllowedInRat = subBigRatLocal(ax.inRat, maxTrimInRat);
    if (minAllowedInRat.n <= 0n) continue;

    const candidateRats = [];
    const pushIfInWindow = targetInRat => {
      if (!targetInRat || targetInRat.d <= 0n || targetInRat.n <= 0n) return;
      if (ratCmp(targetInRat, ax.inRat) < 0 && ratCmp(targetInRat, minAllowedInRat) >= 0) {
        candidateRats.push(targetInRat);
      }
    };

    // 1) Direct dimensional boundaries + strict `< 25 in` Flat Product boundary
    for (const b of directBoundariesIn) pushIfInWindow(b);
    pushIfInWindow(subBigRatLocal({ n: 25n, d: 1n }, strictEpsIn));

    // 2) Length + Girth boundaries (`130 in` and `165 in`)
    const otherMax = ratMax(other1, other2);
    const otherMin = ratCmp(other1, other2) <= 0 ? other1 : other2;
    for (const gCap of [130n, 165n]) {
      // Case A: candidate remains >= otherMax (`cand + 2*(other1 + other2) <= gCap`)
      pushIfInWindow(subBigRatLocal({ n: gCap, d: 1n }, mulBigRat({ n: 2n, d: 1n }, addBigRat(other1, other2))));
      // Case B: `otherMax` becomes longest (`otherMax + 2*(cand + otherMin) <= gCap => cand <= (gCap - otherMax)/2 - otherMin`)
      pushIfInWindow(subBigRatLocal(divBigRat(subBigRatLocal({ n: gCap, d: 1n }, otherMax), { n: 2n, d: 1n }), otherMin));
    }

    // 3) Standard dim-weight quarter-lb boundaries `(ax' * other1 * other2) / 139 <= k / 4`
    const prodOthers = mulBigRat(other1, other2);
    const origStdDim4 = divBigRat(mulBigRat(mulBigRat(ax.inRat, prodOthers), { n: 4n, d: 1n }), { n: 139n, d: 1n });
    const minStdDim4 = divBigRat(mulBigRat(mulBigRat(minAllowedInRat, prodOthers), { n: 4n, d: 1n }), { n: 139n, d: 1n });
    const maxQuarterK = Number((origStdDim4.n - 1n) / origStdDim4.d);
    const minQuarterK = Math.max(1, Number(ceilDivBig(minStdDim4.n, minStdDim4.d)));
    if (maxQuarterK >= minQuarterK && (maxQuarterK - minQuarterK) <= 64) {
      for (let k = maxQuarterK; k >= minQuarterK; k--) {
        const wCapRat = { n: BigInt(k), d: 4n };
        pushIfInWindow(divBigRat(mulBigRat({ n: 139n, d: 1n }, wCapRat), prodOthers));
      }
    }

    // 4) Bulky/Oversize 2-inch-clamped dim-weight whole-lb boundaries + strict `< 45 lb` packaging boundary
    // Case A: `ax'` is longest (`s1 = ax'`, `s2 = max(otherMax, 2)`, `s3 = max(otherMin, 2)`)
    const bulkyProdOthersLongest = mulBigRat(ratMax(otherMax, { n: 2n, d: 1n }), ratMax(otherMin, { n: 2n, d: 1n }));
    // Case B: `otherMax` is longest (`s1 = otherMax`, `otherMinClamped = max(otherMin, 2)`, `ax' >= 2`)
    const bulkyProdOthersSub = mulBigRat(otherMax, ratMax(otherMin, { n: 2n, d: 1n }));
    for (const denomProd of [bulkyProdOthersLongest, bulkyProdOthersSub]) {
      const origDimLb = divBigRat(mulBigRat(ax.inRat, denomProd), { n: 139n, d: 1n });
      const minDimLb = divBigRat(mulBigRat(minAllowedInRat, denomProd), { n: 139n, d: 1n });
      const maxWholeLb = Number((origDimLb.n - 1n) / origDimLb.d);
      const minWholeLb = Math.max(1, Number(ceilDivBig(minDimLb.n, minDimLb.d)));
      if (maxWholeLb >= minWholeLb && (maxWholeLb - minWholeLb) <= 64) {
        for (let lb = maxWholeLb; lb >= minWholeLb; lb--) {
          pushIfInWindow(divBigRat({ n: 139n * BigInt(lb), d: 1n }, denomProd));
        }
      }
      // Strict `< 45 lb` Bulky non-SIPP packaging boundary ($3.80 vs $4.04)
      pushIfInWindow(subBigRatLocal(divBigRat({ n: 139n * 45n, d: 1n }, denomProd), strictEpsIn));
    }

    // 5) Also include the exact maximum legal `<= max_single_side_overshoot_mm` trim point
    pushIfInWindow(minAllowedInRat);

    // Deduplicate converted decimal candidates on this axis
    const seenVals = new Set();
    for (const targetInRat of candidateRats) {
      let candPkg;
      if (preferCm) {
        const targetCmRat = mulBigRat(targetInRat, cmPerInRat);
        // Use floor to stay at/below cliff, falling back to ceil(minAllowedCm) if floor slightly overshoots max_mm
        let candCm = floorBigRatDecimal(targetCmRat, 8);
        const minAllowedCm = ceilBigRatDecimal(mulBigRat(minAllowedInRat, cmPerInRat), 8);
        if (candCm < minAllowedCm) candCm = minAllowedCm;
        if (!(candCm > 0 && candCm < pkg[ax.cmKey])) continue;
        if (seenVals.has(candCm)) continue;
        seenVals.add(candCm);
        candPkg = { ...pkg };
        delete candPkg.length_in;
        delete candPkg.width_in;
        delete candPkg.height_in;
        candPkg[ax.cmKey] = candCm;
      } else {
        let candIn = floorBigRatDecimal(targetInRat, 8);
        const minAllowedIn = ceilBigRatDecimal(minAllowedInRat, 8);
        if (candIn < minAllowedIn) candIn = minAllowedIn;
        if (!(candIn > 0 && candIn < pkg[ax.inKey])) continue;
        if (seenVals.has(candIn)) continue;
        seenVals.add(candIn);
        candPkg = { ...pkg };
        delete candPkg.length_cm;
        delete candPkg.width_cm;
        delete candPkg.height_cm;
        candPkg[ax.inKey] = candIn;
      }

      const candAxisInRat = preferCm
        ? divBigRat(toBigRat(candPkg[ax.cmKey]), cmPerInRat)
        : toBigRat(candPkg[ax.inKey]);
      const deltaInRat = subBigRatLocal(ax.inRat, candAxisInRat);
      const overshootMmRat = mulBigRat(deltaInRat, mmPerInRat);
      if (ratCmp(overshootMmRat, { n: 0n, d: 1n }) <= 0 || ratCmp(overshootMmRat, maxMmRat) > 0) {
        continue;
      }

      const candHeadhaulUsd = typeof recompute_headhaul_fn === 'function'
        ? recompute_headhaul_fn(candPkg)
        : headhaul_usd;
      const candEst = estimateGate1AWithLandedCost({
        ...baseEvalParams,
        pkg: candPkg,
        headhaul_usd: candHeadhaulUsd,
      }, landedUsdRat);
      if (candEst.status !== 'verified' || candEst.zero_browser_fail) {
        continue;
      }

      // Enforce that the single-side trim genuinely crossed into a lower discrete FBA tier, handling rule, or fee bracket
      // (reject pure continuous storage cubic-foot shaves that cross zero FBA bracket boundaries).
      const candFul = candEst.components.fulfillment;
      const candPlc = candEst.components.placement;
      const candSto = candEst.components.storage;
      const candRet = candEst.components.returns_processing;
      const candTierRank = SIZE_TIER_RANK_2027[candEst.size_tier] ?? 99;
      const sizeTierDropped = candTierRank < origTierRank;
      const specialHandlingDropped = (candFul.special_handling_fee_usd ?? 0) + 1e-6 < (origFul.special_handling_fee_usd ?? 0);
      const discreteBracketDropped =
        candFul.total_usd + 1e-6 < origFul.total_usd ||
        candPlc.selected_usd + 1e-6 < origPlc.selected_usd ||
        (candRet.per_return_fee_usd ?? 0) + 1e-6 < (origRet.per_return_fee_usd ?? 0);
      if (!sizeTierDropped && !specialHandlingDropped && !discreteBracketDropped) {
        continue;
      }

      const candFbaTotalUsd = round(
        candFul.total_usd +
        candPlc.selected_usd +
        candSto.per_unit_usd +
        candRet.expected_fee_per_shipped_unit_usd,
      );
      const fbaSavingsUsd = round(origFbaTotalUsd - candFbaTotalUsd);
      if (fbaSavingsUsd <= 0) continue;

      const candContribUsd = round(candEst.net_revenue_usd - (candEst.non_domestic_cost_a_usd + landedUsd));
      const candMargin = candContribUsd / candEst.net_revenue_usd;
      const jumpKind = sizeTierDropped
        ? 'size_tier_drop'
        : (specialHandlingDropped ? 'special_handling_drop' : 'weight_or_packaging_bracket_drop');
      const jumpPriority = sizeTierDropped ? 1 : (specialHandlingDropped ? 2 : 3);
      const origAxisCmRat = mulBigRat(ax.inRat, cmPerInRat);
      const candAxisCmRat = mulBigRat(candAxisInRat, cmPerInRat);
      const overshootMm = roundBigRat(overshootMmRat.n, overshootMmRat.d, 4);
      const overshootIn = roundBigRat(deltaInRat.n, deltaInRat.d, 6);
      const sideLabelZh = `${AXIS_LABEL_ZH[ax.axis]}（${ROLE_LABEL_ZH[ax.role]}）`;

      const summaryZh = `单边压线可救：${sideLabelZh} 仅超红线 ${overshootMm.toFixed(2).replace(/\.?0+$/, '')} mm（≤${max_single_side_overshoot_mm} mm），缩至 ${roundBigRat(candAxisCmRat.n, candAxisCmRat.d, 2)} cm（${roundBigRat(candAxisInRat.n, candAxisInRat.d, 2)} in）降入 ${candEst.size_tier} 档，单件省 FBA 费 $${fbaSavingsUsd.toFixed(2)}，2027 淡季毛利率由 ${(origMargin * 100).toFixed(2)}% 升至 ${(candMargin * 100).toFixed(2)}%（原主毛利仍如实标 <30%，交主人看实物结构拍板）。`;

      validCandidates.push({
        jumpPriority,
        overshootMmRat,
        candMargin,
        payload: {
          eligible: true,
          advisory_pool: 'packaging_redesign_shortlist',
          counts_toward_target: false,
          primary_margin_preserved_below_floor: true,
          price_usd: pricing.net_effective_price_usd,
          offending_axis: ax.axis,
          offending_role: ax.role,
          offending_side: ax.role,
          offending_side_label_zh: sideLabelZh,
          original_dim_in: roundBigRat(ax.inRat.n, ax.inRat.d, 4),
          original_dim_cm: roundBigRat(origAxisCmRat.n, origAxisCmRat.d, 4),
          target_dim_in: roundBigRat(candAxisInRat.n, candAxisInRat.d, 4),
          target_dim_cm: roundBigRat(candAxisCmRat.n, candAxisCmRat.d, 4),
          overshoot_in: overshootIn,
          overshoot_mm: overshootMm,
          max_allowed_overshoot_mm: max_single_side_overshoot_mm,
          tier_jump_kind: jumpKind,
          original_size_tier: origEst.size_tier,
          target_size_tier: candEst.size_tier,
          trimmed_size_tier: candEst.size_tier,
          original_weight_bracket: origFul.weight_bracket ?? null,
          target_weight_bracket: candFul.weight_bracket ?? null,
          original_fba_total_usd: origFbaTotalUsd,
          target_fba_total_usd: candFbaTotalUsd,
          fba_fee_savings_usd: fbaSavingsUsd,
          original_margin: round(origMargin),
          redesigned_margin: round(candMargin),
          trimmed_margin: round(candMargin),
          original_contribution_usd: origContribUsd,
          redesigned_contribution_usd: candContribUsd,
          redesigned_pkg: candPkg,
          summary_zh: summaryZh,
          note: summaryZh,
        },
      });
    }
  }

  if (validCandidates.length === 0) {
    return {
      eligible: false,
      original_size_tier: origEst.size_tier,
      original_margin: round(origMargin),
      max_allowed_overshoot_mm: max_single_side_overshoot_mm,
      reason: `No single-side package trim <= ${max_single_side_overshoot_mm} mm drops an FBA tier/bracket into >= ${(margin_floor * 100).toFixed(0)}% 2027 off-peak margin.`,
    };
  }

  validCandidates.sort((a, b) =>
    a.jumpPriority - b.jumpPriority ||
    ratCmp(a.overshootMmRat, b.overshootMmRat) ||
    b.candMargin - a.candMargin,
  );
  return validCandidates[0].payload;
}
