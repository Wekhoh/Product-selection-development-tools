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

export const FBA_2027_METADATA = Object.freeze({
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

// Official 2027 US FBA 6-tier Oversize non-peak structure (effective 2027-01-15, before 3.5% fuel surcharge).
export const OVERSIZE_2027_TIERS = Object.freeze([
  Object.freeze({
    size_tier: 'small_oversize',
    max_longest_in: 72,
    max_length_plus_girth_in: 130,
    max_weight_lb: 50,
    base_threshold_lb: 1,
    under_10: 13.45,
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
    under_10: 27.38,
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
    under_10: 37.98,
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
    under_10: 62.98,
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
    under_10: 71.10,
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
    under_10: 190.51,
    '10_to_50': 191.28,
    over_50: 191.28,
    step_usd_per_lb: 0.19,
    unit_weight_only: true,
  }),
]);

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
      return {
        size_tier: oTier.size_tier,
        floor_usd: round(baseUsd * fuelMultiplier),
      };
    }
  }
  return null;
}

/**
 * Return the live 2027 US Standard-size rate tables & metadata for immutable evaluation fingerprinting.
 * Shares exact live rate objects with lookup functions so any rate-cell change alters evidence_bundle_sha256.
 */
export function getFba2027RateTableSnapshot() {
  return {
    metadata: FBA_2027_METADATA,
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

/**
 * Classify a complete packaged unit across BOTH 2027 Standard-size AND 2027 Bulky 4 tiers
 * (`small_bulky`, `medium_bulky`, `large_bulky`, `extra_large_bulky`).
 * Keeps `classifyStandardSize2027` strictly Standard-size so legacy callers/tests remain unchanged.
 */
export function classifySizeTier2027(pkg, { is_apparel, is_dangerous_goods, is_sipp } = {}) {
  const std = classifyStandardSize2027(pkg, { is_apparel, is_dangerous_goods, is_sipp });
  if (std.status === 'verified') return std;
  const appCheck = resolveConsistentBoolean([is_apparel, pkg?.is_apparel, pkg?.is_apparel_or_shoes]);
  const dgCheck = resolveConsistentBoolean([is_dangerous_goods, pkg?.is_dangerous_goods]);
  const sippCheck = resolveConsistentBoolean([is_sipp, pkg?.is_sipp]);
  if (!appCheck.valid || !dgCheck.valid || !sippCheck.valid || appCheck.value || dgCheck.value || sippCheck.value) {
    return std;
  }
  const dims = parsePackage(pkg);
  if (!dims) return std;
  const { s1Rat, s2Rat, s3Rat, wtLbRat } = dims.rawRat;
  // Official Amazon US Bulky dimensional weight rule (GABBX6GZPA8MSZGW): enforce minimum 2 inches on width & height.
  const bulkyS2Rat = ratMax(s2Rat, { n: 2n, d: 1n });
  const bulkyS3Rat = ratMax(s3Rat, { n: 2n, d: 1n });
  const bulkyCubicInRat = mulBigRat(mulBigRat(s1Rat, bulkyS2Rat), bulkyS3Rat);
  const bulkyDimLbRat = divBigRat(bulkyCubicInRat, { n: 139n, d: 1n });
  const bulkyShipLbRat = ratMax(wtLbRat, bulkyDimLbRat);
  const flatTriggered = ratCmp(s3Rat, { n: 4n, d: 1n }) < 0 && ratCmp(s2Rat, { n: 25n, d: 1n }) >= 0;
  const overhangTriggered = ratCmp(s2Rat, { n: 43n, d: 1n }) > 0;
  if (flatTriggered || overhangTriggered) {
    return {
      status: 'needs_calculator_verification',
      size_tier: 'bulky_special_handling',
      reason: 'Package triggers 2027 flat or overhang handling rules; verify exact surcharge via guest revcalpublic.',
      special_handling_flags: { flat_surcharge_eligible: flatTriggered, overhang_surcharge_eligible: overhangTriggered },
      ...dims,
    };
  }
  const girthPlusLenRat = addBigRat(s1Rat, mulBigRat({ n: 2n, d: 1n }, addBigRat(s2Rat, s3Rat)));
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
        tier_rule: tier,
        ...dims,
        dim_weight_lb: roundBigRat(bulkyDimLbRat.n, bulkyDimLbRat.d, 10),
        shipping_weight_lb: roundBigRat(bulkyShipLbRat.n, bulkyShipLbRat.d, 10),
        shipping_weight_oz: roundBigRat(shipOzRat.n, shipOzRat.d, 10),
        length_plus_girth_in: roundBigRat(girthPlusLenRat.n, girthPlusLenRat.d, 10),
        weight_basis: ratCmp(bulkyDimLbRat, wtLbRat) > 0 ? 'dimensional_weight' : 'unit_weight',
        special_handling_flags: { flat_surcharge_eligible: false, overhang_surcharge_eligible: false },
        rawRat: { ...dims.rawRat, dimLbRat: bulkyDimLbRat, shipLbRat: bulkyShipLbRat },
      };
    }
  }
  return {
    status: 'needs_calculator_verification',
    size_tier: 'oversize_beyond_bulky',
    reason: 'Package exceeds 2027 Extra-Large Bulky limits (59 x 33 x 33 in, 130 in L+G, 50 lb); requires 6-tier Oversize calculator verification.',
    special_handling_flags: { flat_surcharge_eligible: flatTriggered, overhang_surcharge_eligible: overhangTriggered },
    ...dims,
  };
}

export function lookupBulkyFulfillmentFee2027({
  pkg,
  price_usd,
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
        reason: `sales_window ${sales_window.from}..${sales_window.through} falls outside published 2027 non-peak fulfillment window.`,
      };
    }
  }
  const cls = classifySizeTier2027(pkg, { is_apparel, is_dangerous_goods, is_sipp });
  if (cls.status !== 'verified') return cls;
  if (cls.size_tier === 'small_standard' || cls.size_tier === 'large_standard') {
    return lookupFulfillmentFee2027({ pkg, price_usd, sales_window, include_fuel_surcharge, is_apparel, is_dangerous_goods, is_sipp, low_price_eligible });
  }
  const band = priceBand2027(price_usd);
  if (band === 'under_10' && !low_price_eligible) {
    return { status: 'needs_calculator_verification', reason: 'Category is marked ineligible for 2027 Low-Price FBA rates.' };
  }
  const shipLbRat = cls.rawRat.shipLbRat;
  const excessNum = shipLbRat.n - 1n * shipLbRat.d;
  const extraWholeLbs = excessNum > 0n ? Number(ceilDivBig(excessNum, shipLbRat.d)) : 0;
  const tier = cls.tier_rule;
  const baseUsd = round(tier[band] + extraWholeLbs * tier.step_usd_per_lb_over_1);
  const fuelMultiplier = include_fuel_surcharge ? (1 + FBA_2027_METADATA.fuel_surcharge_fraction) : 1;
  const totalUsd = round(baseUsd * fuelMultiplier);
  const tierFirstLbTotalUsd = round(tier[band] * fuelMultiplier);
  return {
    status: 'verified',
    version: 'US-FBA-2027-nonpeak-bulky4-v1',
    size_tier: cls.size_tier,
    price_band: band,
    weight_bracket: `${cls.size_tier} (${extraWholeLbs} lb intervals above first 1 lb)`,
    shipping_weight_lb: cls.shipping_weight_lb,
    weight_basis: cls.weight_basis,
    base_usd: baseUsd,
    tier_first_lb_total_usd: tierFirstLbTotalUsd,
    extra_lb_steps: extraWholeLbs,
    fuel_surcharge_included: Boolean(include_fuel_surcharge),
    fuel_surcharge_fraction: include_fuel_surcharge ? FBA_2027_METADATA.fuel_surcharge_fraction : 0,
    total_usd: totalUsd,
    effective_from: FBA_2027_METADATA.non_peak_fulfillment_window.from,
    effective_through: FBA_2027_METADATA.non_peak_fulfillment_window.through,
    source_url: FBA_2027_METADATA.official_sources.fulfillment,
  };
}

export function lookupBulkyStorageFee2027({
  pkg,
  storage_window = null,
  months = null,
  average_inventory_days = 45,
  inventory_age_days = 45,
  is_dangerous_goods,
} = {}) {
  const cls = classifySizeTier2027(pkg, { is_dangerous_goods });
  if (cls.status !== 'verified') return cls;
  if (cls.size_tier === 'small_standard' || cls.size_tier === 'large_standard') {
    return lookupStorageFee2027({ pkg, storage_window, months, average_inventory_days, inventory_age_days, is_dangerous_goods });
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
    targetMonths = monthsIn(storage_window);
  }
  if (!Array.isArray(targetMonths) || targetMonths.length === 0 || targetMonths.some(m => !Number.isInteger(m) || m < 1 || m > 12)) {
    return { status: 'needs_calculator_verification', reason: 'Explicit valid storage_window or months array is required.' };
  }
  const hasOffPeak = targetMonths.some(m => m <= 9);
  const hasPeak = targetMonths.some(m => m >= 10);
  if (hasOffPeak && hasPeak) {
    return { status: 'needs_calculator_verification', reason: 'Storage window mixes Jan–Sep ($0.56) and Oct–Dec ($1.40) bulky rates.' };
  }
  const rateUsdPerCuftMonth = hasPeak ? BULKY_STORAGE_2027_RATES.peak : BULKY_STORAGE_2027_RATES.off_peak;
  const allocatedRat = divBigRat(
    mulBigRat(mulBigRat(cls.rawRat.cubicFtRat, toBigRat(rateUsdPerCuftMonth)), toBigRat(average_inventory_days)),
    { n: 30n, d: 1n },
  );
  return {
    status: 'verified',
    version: 'US-FBA-2027-nonpeak-bulky4-v1',
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
 * Never overwrites Amazon retail package specs with 1688 nominal box specs; instead flags cliff-crossing
 * 1688 nominal box specs into a stress package + `'拿样必测彩盒压线预警'`.
 */
export function computeMatchedPeerMedianPackage(peers = [], { supplier_nominal_pkg = null } = {}) {
  if (!Array.isArray(peers) || peers.length === 0) {
    throw new TypeError('computeMatchedPeerMedianPackage requires a nonempty peers array.');
  }
  const parsedPeers = [];
  for (const p of peers) {
    const dims = parsePackage(p);
    if (!dims) continue;
    parsedPeers.push({
      asin: typeof p?.asin === 'string' ? p.asin.trim().toUpperCase() : null,
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
    low_peer_warning: parsedPeers.length < 3,
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
  for (const cliffPrice of [9.99, 10.00, 49.99, 50.00, 50.01]) {
    if (cliffPrice >= min_mature_price_usd - 1e-6 && cliffPrice <= max_mature_price_usd + 1e-6) {
      candidatePrices.add(cliffPrice);
    }
  }
  const landedRat = toRat(landed_domestic_usd);
  const evaluated = [];
  for (const p of [...candidatePrices].sort((a, b) => a - b)) {
    const est = estimateGate1AWithLandedCost({ ...gate1aParams, price_usd: p, margin_floor, min_landed_domestic_usd: null }, landedRat);
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
  const band = priceBand2027(price_usd);
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

export function lookupPlacementFee2027({
  pkg,
  inbound_window = null,
  split_option = 'minimal_west_conservative',
  is_dangerous_goods,
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
    return {
      status: 'verified',
      version: FBA_2027_METADATA.version,
      size_tier: cls.size_tier,
      split_option,
      range_usd: [0, 0],
      selected_usd: 0,
      note: 'Amazon-optimized splits incur $0 placement fee, but multi-location carrier freight still applies.',
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
    const hasPkForRate = validWindow(storage_window) && monthsIn(storage_window).some(m => m >= 10);
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
      const minBulkyFloorUsd = isGuestRevcal
        ? bulkyFloorCheck.total_usd
        : (finite(bulkyFloorCheck.tier_first_lb_total_usd) ? bulkyFloorCheck.tier_first_lb_total_usd : bulkyFloorCheck.total_usd);
      if (active.fulfillment_usd + 0.01 < minBulkyFloorUsd) {
        return {
          valid: false,
          reason: `calculator_verified_override fulfillment_usd ($${active.fulfillment_usd}) understates 2027 Bulky fee floor ($${minBulkyFloorUsd}).`,
        };
      }
    } else if (bulkyFloorCheck.size_tier === 'oversize_beyond_bulky' || bulkyFloorCheck.size_tier === 'bulky_special_handling') {
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
  margin_floor = 0.30,
  domestic_freight_usd = null,
  min_landed_domestic_usd = null,
  is_apparel,
  is_dangerous_goods,
  is_sipp,
  low_price_eligible = true,
  calculator_verified_override = null,
} = {}, exactLandedUsd = null) {
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
  if (!validWindow(sales_window) || !validWindow(storage_window) || !validWindow(inbound_window)) {
    return { status: 'needs_calculator_verification', reason: 'Valid sales_window, storage_window, and inbound_window are all required for Gate 1A.' };
  }
  if (sales_window.from.slice(0, 4) !== sales_window.through.slice(0, 4) ||
    storage_window.from.slice(0, 4) !== storage_window.through.slice(0, 4) ||
    sales_window.from.slice(0, 4) !== storage_window.from.slice(0, 4)) {
    return { status: 'needs_calculator_verification', reason: 'sales_window and storage_window must share a single target year (2027).' };
  }
  if (inbound_window.from > sales_window.through) {
    return { status: 'needs_calculator_verification', reason: 'inbound_window cannot begin after sales_window ends.' };
  }
  if (inbound_window.from < FBA_2027_METADATA.placement_effective_from) {
    return { status: 'needs_calculator_verification', reason: 'inbound_window precedes 2027-01-15 placement schedule.' };
  }
  if (min_landed_domestic_usd !== null && min_landed_domestic_usd !== undefined &&
    (!finite(min_landed_domestic_usd) || min_landed_domestic_usd < 0)) {
    return { status: 'needs_calculator_verification', reason: 'min_landed_domestic_usd must be a nonnegative finite number when supplied.' };
  }
  const rPhysical = physical_return_fraction === null || physical_return_fraction === undefined
    ? refund_fraction
    : physical_return_fraction;

  let fulfillment, storage, placement, returns;
  let overrideReceipt = null;
  if (calculator_verified_override !== null && calculator_verified_override !== undefined) {
    const ov = validateCalculatorVerifiedOverride(calculator_verified_override, {
      price_usd: effectivePriceUsd,
      pkg,
      sales_window,
      storage_window,
      rPhysical,
      fee_category,
      is_apparel,
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
    fulfillment = lookupBulkyFulfillmentFee2027({ pkg, price_usd: effectivePriceUsd, sales_window, is_apparel, is_dangerous_goods, is_sipp, low_price_eligible });
    if (fulfillment.status !== 'verified') return fulfillment;
    storage = lookupBulkyStorageFee2027({ pkg, storage_window, average_inventory_days, is_dangerous_goods });
    if (storage.status !== 'verified') return storage;
    placement = finite(placement_usd) && placement_usd >= 0
      ? { status: 'verified', selected_usd: round(placement_usd), range_usd: [round(placement_usd), round(placement_usd)], split_option: 'explicit' }
      : lookupPlacementFee2027({ pkg, inbound_window, split_option: placement_split_option, is_dangerous_goods });
    if (placement.status !== 'verified') return placement;
    returns = lookupReturnsProcessing2027({
      pkg, physical_return_fraction: rPhysical, fee_category, return_threshold, sales_window, is_apparel_or_shoes: is_apparel, is_dangerous_goods,
    });
    if (returns.status !== 'verified') return returns;
  }

  let referral;
  try {
    referral = netReferral({ ...referral_terms, price_usd: effectivePriceUsd, refund_fraction });
  } catch (err) {
    return { status: 'needs_calculator_verification', reason: err.message };
  }

  const netRevenue = effectivePriceUsd * (1 - refund_fraction);
  const amazonDeductions = [
    referral.net_usd,
    fulfillment.total_usd,
    placement.selected_usd,
    storage.per_unit_usd,
    returns.expected_fee_per_shipped_unit_usd,
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

  const cleanParams = { ...gate1aParams, ...(quoteInputs ? { pkg: quoteInputs.pkg } : {}), fx_cny_per_usd, margin_floor };
  delete cleanParams.price_usd;
  delete cleanParams.list_price_usd;
  delete cleanParams.net_effective_price_usd;
  delete cleanParams.ongoing_coupon_usd;
  delete cleanParams.ongoing_coupon_pct;
  delete cleanParams.prime_exclusive_discount_usd;
  delete cleanParams.prime_exclusive_discount_pct;
  delete cleanParams.promo_basis_already_net;

  const evalAtCents = cents => estimateGate1AWithLandedCost({
    ...cleanParams,
    low_price_eligible,
    price_usd: cents / 100,
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

  const resUnder10 = low_price_eligible
    ? searchBand(100, Math.min(999, maxCents))
    : { state: 'out_of_range', sol: null, reason: null };
  const res10To50 = searchBand(1000, Math.min(5000, maxCents));

  let resOver50 = { state: 'out_of_range', sol: null, reason: null };
  if (maxCents >= 5001) {
    let hi = Math.min(5001, maxCents);
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
        resOver50 = searchBand(5001, hi);
      } else {
        resOver50 = { state: 'infeasible', sol: null, reason: null };
      }
    }
  }

  const bandEntries = [
    { key: 'under_10', lo: 100, hi: Math.min(999, maxCents), res: resUnder10 },
    { key: '10_to_50', lo: 1000, hi: Math.min(5000, maxCents), res: res10To50 },
    { key: 'over_50', lo: 5001, hi: maxCents, res: resOver50 },
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

  // Detect $50.00 FBA fulfillment tier cliff dead zone: $50.00 passes, $50.01 fails, recovers at solOver50.
  let cliffDeadZone = null;
  if (sol10To50 && solOver50 && solOver50.cents > 5001) {
    const est5001 = evalAtCents(5001);
    if (est5001.status === 'verified' && est5001.zero_browser_fail) {
      cliffDeadZone = {
        from_usd: 50.01,
        through_usd: round((solOver50.cents - 1) / 100),
        over_50_recovery_price_usd: solOver50.price_usd,
        note: `定价悬崖死区：$50.00 达标，但 $50.01 至 $${((solOver50.cents - 1) / 100).toFixed(2)} 因跳入 over_50 FBA 费档跌破 ${(margin_floor * 100).toFixed(0)}% 红线，需涨至 $${solOver50.price_usd.toFixed(2)} 才重新达标。`,
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
  lcm_cap = 200,
} = {}) {
  if (!Array.isArray(sku_lines) || sku_lines.length === 0) {
    throw new TypeError('A nonempty sku_lines array is required.');
  }
  if (!Number.isSafeInteger(min_sets) || min_sets < 100) {
    throw new TypeError('min_sets must be a safe integer >= 100.');
  }
  if (!Number.isSafeInteger(lcm_cap) || lcm_cap < 1) {
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

  const useRemainderPath = Boolean(allow_remainder) || K > BigInt(lcm_cap);
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
    per_complete_set_goods_cny: perCompleteRat ? roundBigRat(perCompleteRat.n, perCompleteRat.d, 10) : null,
    moq_capital_alert: allocatedSets >= 300 || actualCompleteSets >= 300,
    sku_lines: linesWithRemainders,
  };
}
