/**
 * Layer 1: Pure 2027->2028 US FBA rate cards, canonical windows, category return thresholds,
 * and immutable rate-table snapshots. Zero calculator or ledger dependencies.
 */
import { BUSINESS_THRESHOLDS } from '../business-thresholds.mjs';
import { validIsoDate, validIsoWindow } from '../utils/dates.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const validWindow = validIsoWindow;
const windowValid = validIsoWindow;

export const FEE_WINDOWS = Object.freeze({ referral: 'sales', fulfillment: 'sales', placement: 'inbound',
  storage: 'storage', returns_processing: 'sales', other_applicable: 'sales' });

export function isCanonical2027OffPeakWin(w) {
  return Boolean(windowValid(w) && w.from === '2027-02-01' && w.through === '2027-10-14');
}

export function isCanonical2027OffPeakStorageWin(w) {
  return Boolean(windowValid(w) && w.from === '2027-02-01' && w.through === '2027-09-30');
}

export function isCanonical2027PeakWin(w) {
  return Boolean(windowValid(w) && w.from === '2027-10-15' && (w.through === '2028-01-14' || w.through === '2027-12-31'));
}

export function isCanonical2027PeakStorageWin(w) {
  return Boolean(windowValid(w) && w.from === '2027-10-01' && w.through === '2027-12-31');
}

export function hasProhibited2026PeakExtrapolation(line, input = null) {
  if (!line || typeof line !== 'object') return false;
  const basis = line.fee_basis;
  if (
    line.extrapolated_from_2026 === true ||
    line.estimated_from_2026 === true ||
    line.peak_2026_uplift_estimate === true ||
    basis?.extrapolated_from_2026 === true ||
    basis?.estimated_from_2026 === true ||
    basis?.peak_2026_uplift_estimate === true ||
    input?.extrapolated_from_2026 === true ||
    input?.estimated_from_2026 === true
  ) {
    return true;
  }
  if (line.status === 'pending' && line.amount_usd === null && basis?.status === 'unavailable') {
    return false;
  }
  const combined = `${line.basis ?? ''} ${basis?.version ?? ''} ${basis?.notes ?? ''} ${basis?.source ?? ''}`
    .replace(/(?:严禁|禁止|不得|切勿|不准|未|不)(?:使?用|按|拿)?\s*2026[^。；;)\n]{0,24}/gi, ' ')
    .replace(/\b(?:never|do\s+not|must\s+not|without|forbid\w*|prohibit\w*)\s+[^.;)\n]{0,32}\b2026\b/gi, ' ');
  return /2026[-_ ]?peak|2026\s*旺季|extrapolat.*2026|2026.*extrapolat|按\s*2026.*估算/i.test(combined);
}


export const VERIFIED_2027_RETURN_THRESHOLDS = Object.freeze({
  '3D Printers': 0.06,
  'Amazon Device Accessories': 0.113,
  'Amazon Explore': 0.048,
  'Automotive and Powersports': 0.091,
  'Baby Products': 0.093,
  'Backpacks, Handbags, and Luggage': 0.128,
  'Base Equipment Power Tools': 0.071,
  'Beauty, Health, and Personal Care': 0.055,
  'Business, Industrial, and Scientific Supplies': 0.06,
  'Compact Appliances': 0.126,
  Computers: 0.114,
  'Consumer Electronics': 0.112,
  'Electronics Accessories': 0.088,
  'Everything Else': 0.048,
  Eyewear: 0.121,
  'Fine Art': 0.056,
  'Full-Size Appliances': 0.119,
  Furniture: 0.096,
  'Gift Cards': 0.048,
  'Grocery and Gourmet': 0.029,
  'Home and Kitchen': 0.081,
  Jewelry: 0.108,
  'Lawn and Garden': 0.077,
  'Lawn mowers and Snow Throwers': 0.095,
  Mattresses: 0.093,
  'Media - Books, DVD, Music, Software, Video': 0.051,
  'Musical Instruments and AV Production': 0.092,
  'Office Products': 0.044,
  'Pet Products': 0.102,
  'Sports and Outdoors': 0.087,
  Tires: 0.087,
  'Tools and Home Improvement': 0.087,
  'Toys and Games': 0.047,
  'Video Game Consoles': 0.107,
  'Video Games and Gaming Accessories': 0.065,
  Watches: 0.12,
});

const RETURN_THRESHOLD_ALIASES = Object.freeze({
  'patio lawn and garden': 'Lawn and Garden',
  'pet supplies': 'Pet Products',
  automotive: 'Automotive and Powersports',
  'musical instruments': 'Musical Instruments and AV Production',
  'industrial and scientific': 'Business, Industrial, and Scientific Supplies',
  'beauty and personal care': 'Beauty, Health, and Personal Care',
  'health and personal care': 'Beauty, Health, and Personal Care',
  'grocery and gourmet food': 'Grocery and Gourmet',
  'video games': 'Video Games and Gaming Accessories',
  media: 'Media - Books, DVD, Music, Software, Video',
});

const normalizeFeeCategoryKey = value => value
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const NORMALIZED_RETURN_THRESHOLDS = new Map([
  ...Object.entries(VERIFIED_2027_RETURN_THRESHOLDS).map(([k, v]) => [
    normalizeFeeCategoryKey(k),
    { canonical: k, threshold: v },
  ]),
  ...Object.entries(RETURN_THRESHOLD_ALIASES).map(([alias, canonical]) => [
    normalizeFeeCategoryKey(alias),
    { canonical, threshold: VERIFIED_2027_RETURN_THRESHOLDS[canonical] },
  ]),
]);

export function lookupVerified2027ReturnThreshold(category) {
  if (!text(category)) return null;
  if (Object.hasOwn(VERIFIED_2027_RETURN_THRESHOLDS, category)) {
    return { canonical: category, threshold: VERIFIED_2027_RETURN_THRESHOLDS[category] };
  }
  const key = normalizeFeeCategoryKey(category);
  return NORMALIZED_RETURN_THRESHOLDS.get(key) ?? null;
}


export const FBA_2027_DEFAULT_OFF_PEAK_WINDOW = BUSINESS_THRESHOLDS.fba_2027_off_peak_sales_window;
export const FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW = BUSINESS_THRESHOLDS.fba_2027_off_peak_storage_window;
export const FBA_2027_COMPANION_PEAK_STORAGE_WINDOW = Object.freeze({ from: '2027-10-01', through: '2027-12-31' });
export const FBA_2027_DEFAULT_INBOUND_WINDOW = Object.freeze({ from: '2027-01-15', through: '2027-02-01' });
export const FBA_2027_UNPUBLISHED_PEAK_WINDOW = BUSINESS_THRESHOLDS.fba_2027_unpublished_q4_peak_window;
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
export const SMALL_STANDARD_2027_OZ = Object.freeze([
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
export const LARGE_STANDARD_2027_LB = Object.freeze([
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

export const LARGE_STANDARD_OVER_3LB = Object.freeze({
  under_10: 6.15,
  '10_to_50': 7.16,
  over_50: 7.73,
  step_usd: 0.08,
  step_lb: 0.25,
  return_base_usd: 5.00,
  return_step_usd: 0.05,
});

export const PLACEMENT_MINIMAL_SMALL_OZ = Object.freeze([
  { max_oz: 8, range: Object.freeze([0.14, 0.32]) },
  { max_oz: 16, range: Object.freeze([0.16, 0.32]) },
]);

export const PLACEMENT_MINIMAL_LARGE_LB = Object.freeze([
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

export const STORAGE_2027_RATES = Object.freeze({ off_peak: 0.78, peak: 2.40 });
export const BULKY_STORAGE_2027_RATES = Object.freeze({ off_peak: 0.56, peak: 1.40 });

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

