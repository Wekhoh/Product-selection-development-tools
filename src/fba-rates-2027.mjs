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
  const rateUsdPerCuftMonth = hasPeak ? 2.40 : 0.78;
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
  if (cls.status !== 'verified') return cls;
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
    r_physical: physical_return_fraction,
    return_threshold: threshold,
    per_return_fee_usd: perReturnFee,
    excess_return_fraction: excess,
    expected_fee_per_shipped_unit_usd: expectedPerShippedUnit,
    effective_from: FBA_2027_METADATA.returns_non_apparel_effective_from,
    source_url: FBA_2027_METADATA.official_sources.returns,
  };
}

/**
 * Compute Gate 1A maximum allowable landed domestic cost (goods + domestic freight to Shenzhen)
 * at the target pre-ad margin floor: landed_domestic_cap_usd = (1 - floor) * R - A.
 * Distinct from bare-goods cap (landed_domestic_cap_usd - domestic_freight_usd).
 */
export function estimateGate1A2027({
  pkg,
  price_usd,
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
} = {}) {
  if (!finite(price_usd) || price_usd <= 0 || !finite(fx_cny_per_usd) || fx_cny_per_usd <= 0 ||
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
  const fulfillment = lookupFulfillmentFee2027({ pkg, price_usd, sales_window, is_apparel, is_dangerous_goods, is_sipp });
  if (fulfillment.status !== 'verified') return fulfillment;
  const storage = lookupStorageFee2027({ pkg, storage_window, average_inventory_days, is_dangerous_goods });
  if (storage.status !== 'verified') return storage;
  const placement = finite(placement_usd) && placement_usd >= 0
    ? { status: 'verified', selected_usd: round(placement_usd), range_usd: [round(placement_usd), round(placement_usd)], split_option: 'explicit' }
    : lookupPlacementFee2027({ pkg, inbound_window, split_option: placement_split_option, is_dangerous_goods });
  if (placement.status !== 'verified') return placement;
  const returns = lookupReturnsProcessing2027({
    pkg, physical_return_fraction: rPhysical, fee_category, return_threshold, sales_window, is_apparel_or_shoes: is_apparel, is_dangerous_goods,
  });
  if (returns.status !== 'verified') return returns;

  let referral;
  try {
    referral = netReferral({ ...referral_terms, price_usd, refund_fraction });
  } catch (err) {
    return { status: 'needs_calculator_verification', reason: err.message };
  }

  const netRevenue = price_usd * (1 - refund_fraction);
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
  const pR = toRat(price_usd), refR = toRat(refund_fraction), flR = toRat(margin_floor);
  const netRevRat = { n: pR.n * (refR.d - refR.n), d: pR.d * refR.d };
  const allowCostRat = { n: netRevRat.n * (flR.d - flR.n), d: netRevRat.d * flR.d };
  const landedCapRat = { n: allowCostRat.n * aR.d - aR.n * allowCostRat.d, d: allowCostRat.d * aR.d };
  const zeroBrowserFail = landedCapRat.n < 0n ||
    (finite(min_landed_domestic_usd) && min_landed_domestic_usd > 0 && ratCmp(toRat(min_landed_domestic_usd), landedCapRat) > 0);

  return {
    status: 'verified',
    version: FBA_2027_METADATA.version,
    price_usd,
    price_band: fulfillment.price_band,
    net_revenue_usd: round(netRevenue),
    non_domestic_cost_a_usd: nonDomesticCostA,
    landed_domestic_cap_usd: landedCapUsd,
    landed_domestic_cap_cny: landedCapCny,
    bare_goods_cap_usd: bareGoodsCapUsd,
    bare_goods_cap_cny: bareGoodsCapCny,
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
  const uniquePrices = [...new Set([
    ...candidate_prices,
    ...(finite(params?.price_usd) && params.price_usd > 0 ? [params.price_usd] : []),
  ])].sort((a, b) => a - b);

  const points = uniquePrices.map(price => {
    const est = estimateGate1A2027({ ...params, price_usd: price });
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
  const anchor = finite(params?.price_usd) ? points.find(p => p.price_usd === params.price_usd && p.status === 'verified') : null;
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
