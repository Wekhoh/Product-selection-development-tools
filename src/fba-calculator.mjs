/**
 * Layer 2: Unified 2027 US FBA fee calculator, Freight A4 headhaul engine, fee-basis validator,
 * Gate 1A landed-cap estimator, forward breakeven solver, <= 10 mm package rescue, and order planner.
 * Strictly acyclic: imports ONLY src/utils/, src/business-thresholds.mjs, and src/rates/index.mjs.
 */
import {
  BARE_GOODS_DISCLOSURE_ZH,
  BUSINESS_THRESHOLDS,
  CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
} from './business-thresholds.mjs';
import {
  gcdBig,
  lcmBig,
  ceilDivBig,
  normBigRat,
  toBigRat,
  addBigRat,
  subBigRat,
  mulBigRat,
  divBigRat,
  ratCmp,
  ratMin,
  ratMax,
  roundBigRat,
  monthsIn,
  validIsoDate,
  validIsoWindow,
} from './utils/index.mjs';
import {
  FEE_WINDOWS,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  FBA_2027_UNPUBLISHED_PEAK_WINDOW,
  UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
  isCanonical2027OffPeakWindow,
  isCanonical2027OffPeakStorageWindow,
  isCanonical2027OffPeakWin,
  isCanonical2027OffPeakStorageWin,
  isCanonical2027PeakWin,
  isCanonical2027PeakStorageWin,
  hasProhibited2026PeakExtrapolation,
  FBA_2027_METADATA,
  SMALL_STANDARD_2027_OZ,
  LARGE_STANDARD_2027_LB,
  LARGE_STANDARD_OVER_3LB,
  PLACEMENT_MINIMAL_SMALL_OZ,
  PLACEMENT_MINIMAL_LARGE_LB,
  STORAGE_2027_RATES,
  BULKY_STORAGE_2027_RATES,
  PLACEMENT_BULKY_SMALL_MEDIUM_LB,
  PLACEMENT_BULKY_LARGE_XL_LB,
  BULKY_RETURNS_2027_RULE,
  BULKY_2027_TIERS,
  OVERSIZE_2027_TIERS,
  OVERSIZE_HANDLING_2027_FEES,
  OVERSIZE_RETURNS_2027_TIERS,
  SMALL_STANDARD_APPAREL_2027_OZ,
  LARGE_STANDARD_APPAREL_2027_LB,
  LARGE_STANDARD_APPAREL_OVER_3LB,
  APPAREL_SHOES_STANDARD_RETURNS_2027,
  SMALL_STANDARD_DG_2027_OZ,
  LARGE_STANDARD_DG_2027_LB,
  LARGE_STANDARD_DG_OVER_3LB,
  BULKY_DG_2027_TIERS,
  OVERSIZE_DG_2027_TIERS,
  DG_STORAGE_2027_RATES,
  LOW_PRICE_INELIGIBLE_2027_CATEGORIES,
  VERIFIED_2027_RETURN_THRESHOLDS,
  lookupVerified2027ReturnThreshold,
  isCategoryLowPriceEligible2027,
  getHistoricalFba2027RateTableSnapshots,
  getFba2027RateTableSnapshot,
  netReferral,
  collectionFromDisbursement,
  buildOutOfTableLookupDirective,
  validateAndComputeOutOfTableRule2027,
  registerSupplementalOutOfTableRule2027,
  listSupplementalOutOfTableRules2027,
} from './rates/index.mjs';

export {
  gcdBig,
  lcmBig,
  ceilDivBig,
  normBigRat,
  toBigRat,
  addBigRat,
  subBigRat,
  mulBigRat,
  divBigRat,
  ratCmp,
  ratMin,
  ratMax,
  roundBigRat,
  FEE_WINDOWS,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  FBA_2027_UNPUBLISHED_PEAK_WINDOW,
  UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
  isCanonical2027OffPeakWindow,
  isCanonical2027OffPeakStorageWindow,
  isCanonical2027OffPeakWin,
  isCanonical2027OffPeakStorageWin,
  isCanonical2027PeakWin,
  isCanonical2027PeakStorageWin,
  hasProhibited2026PeakExtrapolation,
  FBA_2027_METADATA,
  PLACEMENT_BULKY_SMALL_MEDIUM_LB,
  PLACEMENT_BULKY_LARGE_XL_LB,
  BULKY_RETURNS_2027_RULE,
  BULKY_2027_TIERS,
  OVERSIZE_2027_TIERS,
  OVERSIZE_HANDLING_2027_FEES,
  OVERSIZE_RETURNS_2027_TIERS,
  SMALL_STANDARD_APPAREL_2027_OZ,
  LARGE_STANDARD_APPAREL_2027_LB,
  LARGE_STANDARD_APPAREL_OVER_3LB,
  APPAREL_SHOES_STANDARD_RETURNS_2027,
  SMALL_STANDARD_DG_2027_OZ,
  LARGE_STANDARD_DG_2027_LB,
  LARGE_STANDARD_DG_OVER_3LB,
  BULKY_DG_2027_TIERS,
  OVERSIZE_DG_2027_TIERS,
  DG_STORAGE_2027_RATES,
  LOW_PRICE_INELIGIBLE_2027_CATEGORIES,
  VERIFIED_2027_RETURN_THRESHOLDS,
  lookupVerified2027ReturnThreshold,
  isCategoryLowPriceEligible2027,
  getHistoricalFba2027RateTableSnapshots,
  getFba2027RateTableSnapshot,
  buildOutOfTableLookupDirective,
  validateAndComputeOutOfTableRule2027,
  registerSupplementalOutOfTableRule2027,
  listSupplementalOutOfTableRules2027,
};

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round((value + Number.EPSILON) * 1e10) / 1e10;
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = validIsoDate;
const isoDate = validIsoDate;
const windowValid = validIsoWindow;
const validWindow = validIsoWindow;
const toRat = toBigRat;

const CM_PER_INCH = 2.54;
const KG_PER_LB = 0.45359237;
const OZ_PER_LB = 16;

/**
 * Resolve ongoing Coupon / Prime exclusive discount into a single net effective USD price
 * without double-deducting when price_usd is already supplied net.
 * Returns { valid, has_ongoing_discount, list_price_usd, net_effective_price_usd, total_discount_usd, reason }.
 */
export function resolveEffectivePricing(input = {}) {
  const {
    price_usd,
    list_price_usd,
    net_effective_price_usd,
    ongoing_coupon_usd = 0,
    ongoing_coupon_pct = 0,
    prime_exclusive_discount_usd = 0,
    prime_exclusive_discount_pct = 0,
    promo_basis_already_net = false,
  } = input ?? {};

  const hasList = list_price_usd !== undefined && list_price_usd !== null;
  const hasNet = net_effective_price_usd !== undefined && net_effective_price_usd !== null;
  const hasDiscountField =
    (ongoing_coupon_usd !== undefined && ongoing_coupon_usd !== null && ongoing_coupon_usd !== 0) ||
    (ongoing_coupon_pct !== undefined && ongoing_coupon_pct !== null && ongoing_coupon_pct !== 0) ||
    (prime_exclusive_discount_usd !== undefined && prime_exclusive_discount_usd !== null && prime_exclusive_discount_usd !== 0) ||
    (prime_exclusive_discount_pct !== undefined && prime_exclusive_discount_pct !== null && prime_exclusive_discount_pct !== 0);

  if (!hasList && !hasNet && !hasDiscountField) {
    if (!finite(price_usd) || price_usd <= 0) {
      return { valid: false, has_ongoing_discount: false, list_price_usd: null, net_effective_price_usd: null, total_discount_usd: 0, reason: 'Positive finite price_usd is required.' };
    }
    return {
      valid: true,
      has_ongoing_discount: false,
      list_price_usd: price_usd,
      net_effective_price_usd: price_usd,
      total_discount_usd: 0,
      reason: null,
    };
  }

  const cUsd = ongoing_coupon_usd ?? 0;
  const cPct = ongoing_coupon_pct ?? 0;
  const pUsd = prime_exclusive_discount_usd ?? 0;
  const pPct = prime_exclusive_discount_pct ?? 0;
  if (!finite(cUsd) || cUsd < 0 || !finite(pUsd) || pUsd < 0 ||
    !finite(cPct) || cPct < 0 || cPct >= 1 || !finite(pPct) || pPct < 0 || pPct >= 1 ||
    (cPct + pPct) >= 1) {
    return { valid: false, has_ongoing_discount: true, list_price_usd: null, net_effective_price_usd: null, total_discount_usd: null, reason: 'Ongoing coupon/Prime discounts must be finite nonnegative amounts or fractions < 1.' };
  }
  if (hasList && (!finite(list_price_usd) || list_price_usd <= 0)) {
    return { valid: false, has_ongoing_discount: true, list_price_usd: null, net_effective_price_usd: null, total_discount_usd: null, reason: 'list_price_usd must be a positive finite number.' };
  }
  if (hasNet && (!finite(net_effective_price_usd) || net_effective_price_usd <= 0)) {
    return { valid: false, has_ongoing_discount: true, list_price_usd: null, net_effective_price_usd: null, total_discount_usd: null, reason: 'net_effective_price_usd must be a positive finite number.' };
  }
  if (price_usd !== undefined && price_usd !== null && (!finite(price_usd) || price_usd <= 0)) {
    return { valid: false, has_ongoing_discount: true, list_price_usd: null, net_effective_price_usd: null, total_discount_usd: null, reason: 'price_usd must be a positive finite number when supplied.' };
  }
  if (promo_basis_already_net === true && hasDiscountField && !hasList) {
    return {
      valid: false,
      has_ongoing_discount: true,
      list_price_usd: null,
      net_effective_price_usd: null,
      total_discount_usd: null,
      reason: 'Double-deduction guard: cannot apply additional coupon/Prime discounts when promo_basis_already_net is true without an explicit gross list_price_usd.',
    };
  }

  const baseList = hasList ? list_price_usd : (finite(price_usd) ? price_usd : (hasNet && !hasDiscountField ? net_effective_price_usd : null));
  if (baseList === null) {
    return { valid: false, has_ongoing_discount: hasDiscountField, list_price_usd: null, net_effective_price_usd: null, total_discount_usd: null, reason: 'list_price_usd or price_usd is required to derive net_effective_price_usd.' };
  }

  const listR = toBigRat(baseList);
  const discUsdR = addBigRat(toBigRat(cUsd), toBigRat(pUsd));
  const discPctR = addBigRat(toBigRat(cPct), toBigRat(pPct));
  const pctAmtR = mulBigRat(listR, discPctR);
  const totalDiscR = addBigRat(discUsdR, pctAmtR);
  const computedNetR = addBigRat(listR, { n: -totalDiscR.n, d: totalDiscR.d });
  if (computedNetR.n <= 0n) {
    return { valid: false, has_ongoing_discount: hasDiscountField, list_price_usd: baseList, net_effective_price_usd: null, total_discount_usd: null, reason: 'Ongoing discounts cannot reduce net_effective_price_usd to <= 0.' };
  }
  const computedNetRaw = roundBigRat(computedNetR.n, computedNetR.d, 4);
  // Amazon US retail prices settle in whole USD cents; round percentage-discounted net price to payable cents.
  const computedNet = roundBigRat(computedNetR.n, computedNetR.d, 2);
  const totalDisc = roundBigRat(addBigRat(listR, { n: -toBigRat(computedNet).n, d: toBigRat(computedNet).d }).n,
    addBigRat(listR, { n: -toBigRat(computedNet).n, d: toBigRat(computedNet).d }).d, 4);

  if (hasNet && Math.abs(net_effective_price_usd - computedNet) > 1e-6 && Math.abs(net_effective_price_usd - computedNetRaw) > 1e-4) {
    return {
      valid: false,
      has_ongoing_discount: hasDiscountField,
      list_price_usd: baseList,
      net_effective_price_usd: null,
      total_discount_usd: totalDisc,
      reason: `Supplied net_effective_price_usd (${net_effective_price_usd}) disagrees with payable list price (${baseList}) minus ongoing discounts (${computedNet}).`,
    };
  }
  // Always resolve to exact payable whole cents derived from gross minus discount (prevents half-cent drift across $10/$50 cliffs).
  const resolvedNet = computedNet;

  if (finite(price_usd)) {
    const matchesNet = Math.abs(price_usd - resolvedNet) <= 1e-4 || Math.abs(price_usd - computedNetRaw) <= 1e-4;
    const matchesList = Math.abs(price_usd - baseList) <= 1e-4;
    if (promo_basis_already_net === true && !matchesNet) {
      return {
        valid: false,
        has_ongoing_discount: hasDiscountField,
        list_price_usd: baseList,
        net_effective_price_usd: null,
        total_discount_usd: totalDisc,
        reason: `price_usd (${price_usd}) does not match net_effective_price_usd (${resolvedNet}) under promo_basis_already_net.`,
      };
    }
    if (!matchesNet && !matchesList) {
      return {
        valid: false,
        has_ongoing_discount: hasDiscountField,
        list_price_usd: baseList,
        net_effective_price_usd: null,
        total_discount_usd: totalDisc,
        reason: `Supplied price_usd (${price_usd}) matches neither list_price_usd (${baseList}) nor net_effective_price_usd (${resolvedNet}).`,
      };
    }
  }

  return {
    valid: true,
    has_ongoing_discount: hasDiscountField || (resolvedNet < baseList - 1e-6),
    list_price_usd: baseList,
    net_effective_price_usd: resolvedNet,
    total_discount_usd: totalDisc,
    ongoing_coupon_usd: cUsd,
    ongoing_coupon_pct: cPct,
    prime_exclusive_discount_usd: pUsd,
    prime_exclusive_discount_pct: pPct,
    reason: null,
  };
}

export function resolveConsistentText(values) {
  const present = values.filter(v => v !== undefined && v !== null);
  if (present.length === 0) return { present: false, valid: true, value: null };
  if (present.some(v => !text(v))) return { present: true, valid: false, value: null };
  const norm = s => s.trim().toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ');
  for (let i = 1; i < present.length; i++) {
    if (norm(present[i]) !== norm(present[0])) return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value: present[0].trim() };
}

export function resolveConsistentFeeCategory(values) {
  const present = values.filter(v => v !== undefined && v !== null);
  if (present.length === 0) return { present: false, valid: true, value: null };
  if (present.some(v => !text(v))) return { present: true, valid: false, value: null };
  const canon = s => {
    const m = lookupVerified2027ReturnThreshold(s);
    if (m) return m.canonical.toLowerCase();
    return s.trim().toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ');
  };
  const firstCanon = canon(present[0]);
  for (let i = 1; i < present.length; i++) {
    if (canon(present[i]) !== firstCanon) return { present: true, valid: false, value: null };
  }
  const m0 = lookupVerified2027ReturnThreshold(present[0]);
  return { present: true, valid: true, value: m0 ? m0.canonical : present[0].trim() };
}


export function resolveConsistentNumeric(values, predicate) {
  const present = values.filter(v => v !== undefined && v !== null);
  if (present.length === 0) return { present: false, valid: true, value: null };
  if (present.some(v => !predicate(v))) return { present: true, valid: false, value: null };
  for (let i = 1; i < present.length; i++) {
    if (present[i] !== present[0]) return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value: present[0] };
}

export function resolveConsistentBoolean(values) {
  const present = values.filter(v => v !== undefined);
  if (present.length === 0) return { present: false, valid: true, value: false };
  if (present.some(v => typeof v !== 'boolean')) return { present: true, valid: false, value: null };
  for (let i = 1; i < present.length; i++) {
    if (present[i] !== present[0]) return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value: present[0] };
}

export function resolveUniquePackageByRef(packages, pkgRef) {
  if (packages === undefined) return { present: false, valid: true, pkg: null };
  if (!Array.isArray(packages) || packages.length === 0) return { present: true, valid: false, pkg: null };
  const seenExact = new Set();
  const seenTrim = new Set();
  let matched = null;
  for (const p of packages) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !text(p.id)) {
      return { present: true, valid: false, pkg: null };
    }
    const trimId = p.id.trim();
    if (seenExact.has(p.id) || seenTrim.has(trimId)) {
      return { present: true, valid: false, pkg: null };
    }
    seenExact.add(p.id);
    seenTrim.add(trimId);
    if (text(pkgRef) && p.id === pkgRef) matched = p;
  }
  if (text(pkgRef) && !matched) return { present: true, valid: false, pkg: null };
  return { present: true, valid: true, pkg: matched };
}

export function collectLedgerFlag(input, flagName, matchedPkg = null) {
  const values = [input?.[flagName], matchedPkg?.[flagName]];
  if (Array.isArray(input?.lines)) {
    for (const l of input.lines) {
      values.push(l?.[flagName], l?.fee_basis?.[flagName]);
    }
  }
  return resolveConsistentBoolean(values);
}

const KG_PER_LB_RAT = toBigRat(0.45359237);
const OZ_PER_LB_RAT = { n: 16n, d: 1n };
const CM_PER_IN_RAT = toBigRat(2.54);

export function resolveConsistentPkgWeightLb(pkg) {
  if (!pkg || typeof pkg !== 'object') return { present: false, valid: true, weight_lb: null, weight_lb_rat: null };
  const specs = [
    ['weight_lb', v => toBigRat(v)],
    ['unit_weight_lb', v => toBigRat(v)],
    ['weight_oz', v => divBigRat(toBigRat(v), OZ_PER_LB_RAT)],
    ['unit_weight_oz', v => divBigRat(toBigRat(v), OZ_PER_LB_RAT)],
    ['weight_kg', v => divBigRat(toBigRat(v), KG_PER_LB_RAT)],
    ['unit_weight_kg', v => divBigRat(toBigRat(v), KG_PER_LB_RAT)],
  ];
  const vals = [];
  for (const [key, toLbRat] of specs) {
    if (pkg[key] === undefined || pkg[key] === null) continue;
    if (!finite(pkg[key]) || pkg[key] <= 0) return { present: true, valid: false, weight_lb: null, weight_lb_rat: null };
    vals.push(toLbRat(pkg[key]));
  }
  if (vals.length === 0) return { present: false, valid: true, weight_lb: null, weight_lb_rat: null };
  for (let i = 1; i < vals.length; i++) {
    if (ratCmp(vals[i], vals[0]) !== 0) return { present: true, valid: false, weight_lb: null, weight_lb_rat: null };
  }
  return {
    present: true,
    valid: true,
    weight_lb: Number(vals[0].n) / Number(vals[0].d),
    weight_lb_rat: vals[0],
  };
}

export function resolvePackageDimsRat(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const inKeys = ['length_in', 'width_in', 'height_in'];
  const cmKeys = ['length_cm', 'width_cm', 'height_cm'];
  const anyIn = inKeys.some(k => pkg[k] !== undefined && pkg[k] !== null);
  const anyCm = cmKeys.some(k => pkg[k] !== undefined && pkg[k] !== null);
  if (!anyIn && !anyCm) return null;
  let lRat = null, wRat = null, hRat = null;
  if (anyIn) {
    if (!inKeys.every(k => finite(pkg[k]) && pkg[k] > 0)) return null;
    lRat = toBigRat(pkg.length_in);
    wRat = toBigRat(pkg.width_in);
    hRat = toBigRat(pkg.height_in);
  }
  if (anyCm) {
    if (!cmKeys.every(k => finite(pkg[k]) && pkg[k] > 0)) return null;
    const cmL = divBigRat(toBigRat(pkg.length_cm), CM_PER_IN_RAT);
    const cmW = divBigRat(toBigRat(pkg.width_cm), CM_PER_IN_RAT);
    const cmH = divBigRat(toBigRat(pkg.height_cm), CM_PER_IN_RAT);
    if (anyIn) {
      if (ratCmp(cmL, lRat) !== 0 || ratCmp(cmW, wRat) !== 0 || ratCmp(cmH, hRat) !== 0) return null;
    } else {
      lRat = cmL; wRat = cmW; hRat = cmH;
    }
  }
  const [s1Rat, s2Rat, s3Rat] = [lRat, wRat, hRat].sort((a, b) => ratCmp(b, a));
  const cubicInRat = mulBigRat(mulBigRat(s1Rat, s2Rat), s3Rat);
  const dimLbRat = divBigRat(cubicInRat, { n: 139n, d: 1n });
  const cubicFtRat = divBigRat(cubicInRat, { n: 1728n, d: 1n });
  const wtRes = resolveConsistentPkgWeightLb(pkg);
  if (wtRes.present && !wtRes.valid) return null;
  const wtLbRat = wtRes.present ? wtRes.weight_lb_rat : null;
  const shipLbRat = wtLbRat ? ratMax(wtLbRat, dimLbRat) : null;
  const isOversize = ratCmp(s1Rat, { n: 18n, d: 1n }) > 0 ||
    ratCmp(s2Rat, { n: 14n, d: 1n }) > 0 ||
    ratCmp(s3Rat, { n: 8n, d: 1n }) > 0 ||
    (wtLbRat !== null && ratCmp(wtLbRat, { n: 20n, d: 1n }) > 0);
  return {
    s1Rat, s2Rat, s3Rat, cubicInRat, dimLbRat, cubicFtRat, wtLbRat, shipLbRat,
    ozRat: wtLbRat ? mulBigRat(wtLbRat, OZ_PER_LB_RAT) : null,
    isOversize,
    cubic_feet: Number(cubicFtRat.n) / Number(cubicFtRat.d),
    dim_weight_lb: Number(dimLbRat.n) / Number(dimLbRat.d),
  };
}

export function isOfficial2027ScheduleWindowValid(lineId, basis, isApparel = false) {
  const version = String(basis?.version ?? '').trim();
  if (!version) return true;
  if (lineId === 'fulfillment') {
    const is2027NonPeak = /^US-FBA-2027-nonpeak/i.test(version) || (/2027/.test(version) && /non[-_ ]?peak/i.test(version));
    if (is2027NonPeak) {
      if (!date(basis.effective_from) || basis.effective_from < '2027-01-15') return false;
      if (!date(basis.effective_through) || basis.effective_through > '2027-10-14') return false;
    }
  } else if (lineId === 'storage') {
    if (/^US-FBA-2027/i.test(version) && date(basis.effective_from) && basis.effective_from < '2027-02-01') return false;
  } else if (lineId === 'placement') {
    if (/^US-FBA-2027/i.test(version) && date(basis.effective_from) && basis.effective_from < '2027-01-15') return false;
  } else if (lineId === 'returns_processing') {
    const minStart = isApparel ? '2027-01-15' : '2027-02-01';
    if (/^US-FBA-2027/i.test(version) && date(basis.effective_from) && basis.effective_from < minStart) return false;
  }
  return true;
}

/**
 * Single source of truth for 2027 US FBA per-return processing fees across Standard (Non-Apparel & Apparel/Shoes),
 * Bulky (4 tiers), and Oversize (6 tiers). Reads exclusively from canonical annual tables in `src/rates/fba-2027-tables.mjs`.
 */
function resolve2027PerReturnFeeFromTier(cls, { isApparelOrShoes = false, allowAll2027Tiers = true } = {}) {
  if (!cls || cls.status !== 'verified' || !cls.rawRat) {
    return { per_return_fee_usd: null, extra_lb_steps: 0, reason: 'Unclassified package.' };
  }
  if (cls.size_tier === 'small_standard') {
    if (isApparelOrShoes) {
      if (!allowAll2027Tiers) return { per_return_fee_usd: null, extra_lb_steps: 0, reason: 'Apparel returns require unified 2027 schedule.' };
      const fee = APPAREL_SHOES_STANDARD_RETURNS_2027.small_standard_oz.find(
        r => ratCmp(cls.rawRat.ozRat, toBigRat(r.max_oz)) <= 0,
      )?.return_fee ?? null;
      return { per_return_fee_usd: fee, extra_lb_steps: 0, reason: fee === null ? 'Unlisted returns-processing weight bracket.' : null };
    }
    const fee = SMALL_STANDARD_2027_OZ.find(
      r => ratCmp(cls.rawRat.ozRat, toBigRat(r.max_oz)) <= 0,
    )?.return_fee ?? null;
    return { per_return_fee_usd: fee, extra_lb_steps: 0, reason: fee === null ? 'Unlisted returns-processing weight bracket.' : null };
  }
  if (cls.size_tier === 'large_standard') {
    const lbRat = cls.rawRat.shipLbRat;
    if (isApparelOrShoes) {
      if (!allowAll2027Tiers) return { per_return_fee_usd: null, extra_lb_steps: 0, reason: 'Apparel returns require unified 2027 schedule.' };
      if (ratCmp(lbRat, { n: 3n, d: 1n }) <= 0) {
        const fee = APPAREL_SHOES_STANDARD_RETURNS_2027.large_standard_lb.find(
          r => ratCmp(lbRat, toBigRat(r.max_lb)) <= 0,
        )?.return_fee ?? null;
        return { per_return_fee_usd: fee, extra_lb_steps: 0, reason: fee === null ? 'Unlisted returns-processing weight bracket.' : null };
      }
      const extraHalfLbs = extraHalfLbStepsRat(lbRat);
      const over = APPAREL_SHOES_STANDARD_RETURNS_2027.large_standard_over_3lb;
      return {
        per_return_fee_usd: round(over.return_base_usd + extraHalfLbs * over.return_step_usd_per_half_lb),
        extra_lb_steps: extraHalfLbs,
        reason: null,
      };
    }
    if (ratCmp(lbRat, { n: 3n, d: 1n }) <= 0) {
      const fee = LARGE_STANDARD_2027_LB.find(
        r => ratCmp(lbRat, toBigRat(r.max_lb)) <= 0,
      )?.return_fee ?? null;
      return { per_return_fee_usd: fee, extra_lb_steps: 0, reason: fee === null ? 'Unlisted returns-processing weight bracket.' : null };
    }
    const extraQuarterLbs = extraQuarterLbStepsRat(lbRat);
    return {
      per_return_fee_usd: round(LARGE_STANDARD_OVER_3LB.return_base_usd + extraQuarterLbs * LARGE_STANDARD_OVER_3LB.return_step_usd),
      extra_lb_steps: extraQuarterLbs,
      reason: null,
    };
  }
  if (!allowAll2027Tiers) {
    return { per_return_fee_usd: null, extra_lb_steps: 0, reason: 'Bulky/Oversize returns require unified 2027 schedule.' };
  }
  if (cls.size_tier.endsWith('_bulky')) {
    const shipLbRat = cls.rawRat.shipLbRat;
    const excessLbNum = shipLbRat.n - 1n * shipLbRat.d;
    const extraWholeLbs = excessLbNum > 0n ? Number(ceilDivBig(excessLbNum, shipLbRat.d)) : 0;
    return {
      per_return_fee_usd: round(
        BULKY_RETURNS_2027_RULE.base_first_lb_usd + extraWholeLbs * BULKY_RETURNS_2027_RULE.step_usd_per_lb_over_1,
      ),
      extra_lb_steps: extraWholeLbs,
      reason: null,
    };
  }
  if (cls.tier_family === 'oversize') {
    const retRule = OVERSIZE_RETURNS_2027_TIERS[cls.size_tier];
    if (!retRule) {
      return { per_return_fee_usd: null, extra_lb_steps: 0, reason: `Unlisted Oversize returns-processing tier: ${cls.size_tier}` };
    }
    const billableRat = retRule.unit_weight_only ? cls.rawRat.wtLbRat : cls.rawRat.shipLbRat;
    const threshBig = BigInt(retRule.base_threshold_lb);
    const excessLbNum = billableRat.n - threshBig * billableRat.d;
    const extraWholeLbs = excessLbNum > 0n ? Number(ceilDivBig(excessLbNum, billableRat.d)) : 0;
    return {
      per_return_fee_usd: round(retRule.base_usd + extraWholeLbs * retRule.step_usd_per_lb),
      extra_lb_steps: extraWholeLbs,
      reason: null,
    };
  }
  return { per_return_fee_usd: null, extra_lb_steps: 0, reason: 'Unlisted returns-processing weight bracket.' };
}

export function lookupVerified2027PerReturnFee(pkg, { isApparelOrShoes = false, allowAll2027Tiers = false } = {}) {
  const dims = parsePackage(pkg);
  if (!dims) return null;
  const cls = classifyPhysicalSizeTier2027(dims);
  if (cls.status !== 'verified') return null;
  return resolve2027PerReturnFeeFromTier(cls, { isApparelOrShoes, allowAll2027Tiers }).per_return_fee_usd;
}

function canonicalValue(val) {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(canonicalValue);
  const out = {};
  for (const key of Object.keys(val).sort()) {
    if (val[key] !== undefined) out[key] = canonicalValue(val[key]);
  }
  return out;
}

function canonicalSkuSignature(skuLines) {
  if (!Array.isArray(skuLines)) return null;
  const rows = [];
  for (const row of skuLines) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const normalized = {
      pack_multiple: 1,
      moq_qty: 1,
      ...row,
    };
    rows.push(JSON.stringify(canonicalValue(normalized)));
  }
  rows.sort();
  return JSON.stringify(rows);
}

export const INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH =
  '初筛仅认单一工厂一站齐套；只卖裸件或需跨两家厂另配标准袋/盒暂置归档';

const FACTORY_IDENTITY_FIELDS = Object.freeze([
  'factory_id',
  'supplier_id',
  'seller_member_id',
  'company_name',
  'shop_url',
]);

function parseSkuLinesArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore malformed JSON */ }
  }
  return null;
}

function normalizeShopUrlKey(trimmed) {
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, '').toLowerCase();
      return `${host}${path}`;
    }
  } catch { /* fall back to lowercased string */ }
  return trimmed.toLowerCase();
}

function addFieldIdentity(fieldMap, fieldName, rawVal) {
  let trimmed = '';
  if (typeof rawVal === 'string') {
    trimmed = rawVal.trim();
  } else if (typeof rawVal === 'number' && Number.isSafeInteger(rawVal)) {
    trimmed = String(rawVal);
  }
  if (!trimmed) return false;
  const key = fieldName === 'shop_url' ? normalizeShopUrlKey(trimmed) : trimmed.toLowerCase();
  const prev = fieldMap.get(key);
  if (prev === undefined || trimmed < prev) {
    fieldMap.set(key, trimmed);
  }
  return true;
}

function normalizeExpectedComponentsList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.components)) return raw.components;
    if (Number.isSafeInteger(raw.qty_per_saleable_set) && raw.qty_per_saleable_set >= 1 &&
      (typeof raw.component_id === 'string' || typeof raw.id === 'string')) {
      return [raw];
    }
  }
  return null;
}

/**
 * Unified single-factory complete-kit adjudication shared by sourcing storage (`src/store.mjs`),
 * cost/fee validation (`src/fba-calculator.mjs`, `src/economics.mjs`), standalone scoring
 * (`src/scoring.mjs`), Gate 1B (`src/pipeline.mjs`), and HTML reports (`src/report.mjs`).
 *
 * Strictly permutation-invariant over `sku_lines[]` ordering, accepts both string and safe-integer
 * factory IDs, compares each identity field cleanly (preserving same-factory aliases and stripping
 * tracking query params on `shop_url`), checks all present `sku_lines[]` arrays for conflicts, and
 * never falls back to `quote_id`, `offer_id`, or `scenario.id` when factory identity is absent.
 */
export function evaluateSingleFactoryCompleteKit(source) {
  const src = source && typeof source === 'object' ? source : {};
  const ledger = src.cost_ledger && typeof src.cost_ledger === 'object'
    ? src.cost_ledger
    : (src.scenario?.cost_ledger && typeof src.scenario.cost_ledger === 'object' ? src.scenario.cost_ledger : null);
  const procFromLedger = Array.isArray(ledger?.lines)
    ? ledger.lines.find(l => l?.id === 'procurement') ?? null
    : (Array.isArray(src.lines) ? src.lines.find(l => l?.id === 'procurement') ?? null : null);
  const procLine = (src.procLine && typeof src.procLine === 'object' ? src.procLine : null) ?? procFromLedger;

  const containers = [
    src,
    src.quote,
    src.scenario,
    ledger,
    src.source_inputs,
    ledger?.source_inputs,
    procLine,
  ].filter(c => c && typeof c === 'object');

  // Inspect ALL present sku_lines arrays so conflicting arrays (e.g., scenario vs cost_ledger) cannot hide cross-factory kits.
  const candidateSkuArrays = [
    parseSkuLinesArray(src.sku_lines),
    parseSkuLinesArray(procLine?.sku_lines),
    parseSkuLinesArray(ledger?.sku_lines),
    parseSkuLinesArray(ledger?.source_inputs?.sku_lines),
    parseSkuLinesArray(src.source_inputs?.sku_lines),
    parseSkuLinesArray(src.quote?.sku_lines),
    parseSkuLinesArray(src.scenario?.sku_lines),
    parseSkuLinesArray(src.sku_lines_json),
    parseSkuLinesArray(src.quote?.sku_lines_json),
  ].filter(arr => Array.isArray(arr) && arr.length > 0);

  const reasons = new Set();
  if (candidateSkuArrays.length > 1) {
    const sig0 = canonicalSkuSignature(candidateSkuArrays[0]);
    for (let i = 1; i < candidateSkuArrays.length; i++) {
      if (sig0 === null || canonicalSkuSignature(candidateSkuArrays[i]) !== sig0) {
        reasons.add('Conflicting sku_lines[] supplied across scenario, cost_ledger, and procurement line.');
        break;
      }
    }
  }

  const checkExplicitFlags = obj => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.single_factory_complete_kit === false) {
      reasons.add('Declared single_factory_complete_kit: false.');
    }
    if (obj.requires_cross_factory_packaging === true) {
      reasons.add('Declared requires_cross_factory_packaging: true.');
    }
    if (obj.bare_parts_incomplete === true || obj.bare_part_only === true) {
      reasons.add('Declared bare parts / incomplete kit only.');
    }
    if (obj.complete_set_verified === false) {
      reasons.add('Declared complete_set_verified: false.');
    }
    if (obj.rejected_spec === true || obj.quote_status === 'rejected_spec') {
      reasons.add('Quote or scenario is marked rejected_spec.');
    }
    if (obj.quote_status === 'incomplete_cross_factory_kit') {
      reasons.add('Quote status is incomplete_cross_factory_kit.');
    }
  };
  for (const c of containers) checkExplicitFlags(c);

  const topMapsByField = Object.fromEntries(FACTORY_IDENTITY_FIELDS.map(f => [f, new Map()]));
  const mergedMapsByField = Object.fromEntries(FACTORY_IDENTITY_FIELDS.map(f => [f, new Map()]));
  let hasTopLevelFactory = false;
  for (const c of containers) {
    for (const f of FACTORY_IDENTITY_FIELDS) {
      if (addFieldIdentity(topMapsByField[f], f, c[f])) {
        addFieldIdentity(mergedMapsByField[f], f, c[f]);
        hasTopLevelFactory = true;
      }
    }
  }

  for (const skuLines of candidateSkuArrays) {
    let linesWithFactory = 0;
    let validLineObjects = 0;
    const lineFieldCounts = Object.fromEntries(FACTORY_IDENTITY_FIELDS.map(f => [f, 0]));
    for (const line of skuLines) {
      if (!line || typeof line !== 'object') continue;
      validLineObjects += 1;
      checkExplicitFlags(line);
      let lineHasAny = false;
      for (const f of FACTORY_IDENTITY_FIELDS) {
        if (addFieldIdentity(mergedMapsByField[f], f, line[f])) {
          lineHasAny = true;
          lineFieldCounts[f] += 1;
        }
      }
      if (lineHasAny) linesWithFactory += 1;
    }
    if (validLineObjects > 1 && linesWithFactory > 0) {
      const sharedFieldCoversAllLines = FACTORY_IDENTITY_FIELDS.some(
        f => lineFieldCounts[f] === validLineObjects,
      );
      const allAttributedLinesUseTopLevelField = hasTopLevelFactory && skuLines.every(line => {
        if (!line || typeof line !== 'object') return true;
        const lineFields = FACTORY_IDENTITY_FIELDS.filter(f => {
          const v = line[f];
          return (typeof v === 'string' && v.trim().length > 0) || (typeof v === 'number' && Number.isSafeInteger(v));
        });
        return lineFields.length === 0 || lineFields.some(f => topMapsByField[f].size > 0);
      });
      if (!sharedFieldCoversAllLines && !allAttributedLinesUseTopLevelField) {
        reasons.add(
          'Multi-SKU kit mixes attributed and unattributed or disjoint-field SKU lines without a shared single factory identity; confirm all components ship from one factory.',
        );
      }
    }
  }

  // Enforce required saleable-set component coverage when expected_components / saleable_set_composition is supplied.
  const expectedComponents =
    normalizeExpectedComponentsList(src.expected_components) ??
    normalizeExpectedComponentsList(src.saleable_set_composition) ??
    normalizeExpectedComponentsList(src.scenario?.expected_components) ??
    normalizeExpectedComponentsList(src.scenario?.saleable_set_composition) ??
    normalizeExpectedComponentsList(ledger?.expected_components) ??
    normalizeExpectedComponentsList(ledger?.saleable_set_composition) ??
    null;
  if (expectedComponents && expectedComponents.length > 0 && candidateSkuArrays.length > 0) {
    for (const skuLines of candidateSkuArrays) {
      for (const comp of expectedComponents) {
        if (!comp || typeof comp !== 'object') continue;
        const compId = typeof comp.component_id === 'string' && comp.component_id.trim()
          ? comp.component_id.trim()
          : (typeof comp.id === 'string' && comp.id.trim() ? comp.id.trim() : null);
        const reqQty = comp.qty_per_saleable_set;
        if (!compId || !Number.isSafeInteger(reqQty) || reqQty < 1) continue;
        const matched = skuLines.filter(l => l && typeof l === 'object' && (l.component_id ?? l.sku_id) === compId);
        const coveredQty = matched.reduce((sum, l) => sum + (Number.isSafeInteger(l.qty_per_saleable_set) ? l.qty_per_saleable_set : 0), 0);
        if (coveredQty < reqQty) {
          reasons.add(`Missing required saleable-set component "${compId}" (needs qty_per_saleable_set=${reqQty}, got ${coveredQty}).`);
        }
      }
    }
  }

  let conflictingField = null;
  let primaryPresentField = null;
  for (const f of FACTORY_IDENTITY_FIELDS) {
    const keys = [...mergedMapsByField[f].keys()].sort();
    if (keys.length > 0 && !primaryPresentField) primaryPresentField = f;
    if (keys.length > 1) {
      if (!conflictingField) conflictingField = f;
      reasons.add(
        `Cross-factory kit detected across multiple ${f} values (${keys.join(', ')}); initial screening requires one factory to deliver the complete saleable set.`,
      );
    }
  }

  const isCrossFactoryOrIncomplete = reasons.size > 0;
  const activeField = conflictingField ?? primaryPresentField;
  const distinctFactoryIds = activeField ? [...mergedMapsByField[activeField].keys()].sort() : [];
  const resolvedFactoryId = conflictingField || !primaryPresentField
    ? null
    : mergedMapsByField[primaryPresentField].get([...mergedMapsByField[primaryPresentField].keys()].sort()[0]);

  return {
    status: isCrossFactoryOrIncomplete ? 'incomplete_cross_factory_kit' : 'single_factory_complete_kit',
    is_single_factory_complete_kit: !isCrossFactoryOrIncomplete,
    is_cross_factory_or_incomplete: isCrossFactoryOrIncomplete,
    distinct_factory_ids: distinctFactoryIds,
    distinct_factory_count: distinctFactoryIds.length,
    resolved_factory_id: resolvedFactoryId,
    reasons: [...reasons].sort(),
    kit_note: isCrossFactoryOrIncomplete ? INCOMPLETE_CROSS_FACTORY_KIT_NOTE_ZH : null,
  };
}

/**
 * Canonical verified distinct-factory key resolver.
 * Returns normalized lowercase factory identity ONLY for single-factory quotes/scenarios with an
 * explicit factory/supplier identifier. Returns `null` for historical rows without `factory_id`
 * and for cross-factory/incomplete/rejected kits (NEVER falls back to `quote_id`, `offer_id`, or `scenario.id`).
 */
export function resolveVerifiedFactoryKey(source) {
  const kit = evaluateSingleFactoryCompleteKit(source);
  if (kit.is_cross_factory_or_incomplete || kit.distinct_factory_ids.length !== 1) return null;
  return kit.distinct_factory_ids[0];
}

export function resolveConsistentSkuLines(input, procLine) {
  const present = [input?.sku_lines, input?.source_inputs?.sku_lines, procLine?.sku_lines]
    .filter(v => v !== undefined);
  if (present.length === 0) return { present: false, conflict: false, skuLines: undefined };
  if (present.length === 1) return { present: true, conflict: false, skuLines: present[0] };
  const sig0 = canonicalSkuSignature(present[0]);
  if (sig0 === null) return { present: true, conflict: true, skuLines: null };
  for (let i = 1; i < present.length; i++) {
    if (canonicalSkuSignature(present[i]) !== sig0) return { present: true, conflict: true, skuLines: null };
  }
  return { present: true, conflict: false, skuLines: present[0] };
}

export function validateSkuLinesR58(skuLines, allocatedSets, procAmountUsd, fxValues) {
  if (!Array.isArray(skuLines) || skuLines.length === 0) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
  if (!Number.isSafeInteger(allocatedSets) || allocatedSets < 100) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
  const fxCheck = resolveConsistentNumeric(fxValues, v => finite(v) && v > 0);
  if (!fxCheck.present || !fxCheck.valid) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
  let minCompleteSets = Infinity;
  let totalGoodsRat = { n: 0n, d: 1n };
  for (const row of skuLines) {
    if (!row || typeof row !== 'object') return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
    const q = row.qty_per_saleable_set;
    const p = row.pack_multiple ?? 1;
    const m = row.moq_qty ?? 1;
    const ordered = row.ordered_qty;
    if (!Number.isSafeInteger(q) || q < 1 || !Number.isSafeInteger(p) || p < 1 ||
      !Number.isSafeInteger(m) || m < 1 || !Number.isSafeInteger(ordered) || ordered < 1) {
      return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
    }
    if (row.regular_goods_promo_false !== true) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
    if (ordered < m || ordered % p !== 0 || ordered < allocatedSets * q) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
    if (!finite(row.unit_price_cny) || row.unit_price_cny < 0) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
    minCompleteSets = Math.min(minCompleteSets, Math.floor(ordered / q));
    const priceRat = toBigRat(row.unit_price_cny);
    totalGoodsRat = addBigRat(totalGoodsRat, { n: BigInt(ordered) * priceRat.n, d: priceRat.d });
  }
  if (!Number.isFinite(minCompleteSets) || minCompleteSets < allocatedSets) return { valid: false, expected_proc_usd: null, exact_usd_rational: null };
  const fxRat = toBigRat(fxCheck.value);
  // proc_usd = totalGoodsRat / (allocatedSets * fxRat) = (totalGoodsRat.n * fxRat.d) / (totalGoodsRat.d * allocatedSets * fxRat.n)
  const rawN = totalGoodsRat.n * fxRat.d;
  const rawD = totalGoodsRat.d * BigInt(allocatedSets) * fxRat.n;
  const g = gcdBig(rawN, rawD);
  const redN = rawN / g;
  const redD = rawD / g;
  const exactRat = { num: redN.toString(), den: redD.toString() };
  const expectedProcUsd = roundBigRat(redN, redD, 10);
  if (!finite(procAmountUsd) || Math.abs(procAmountUsd - expectedProcUsd) > 1e-6) {
    return { valid: false, expected_proc_usd: expectedProcUsd, exact_usd_rational: exactRat };
  }
  return { valid: true, expected_proc_usd: expectedProcUsd, exact_usd_rational: exactRat };
}

export function storageMeets2027Floor(input, storageLine, storageMonths) {
  if (!storageLine || storageLine.status === 'pending' || !finite(storageLine.amount_usd) || storageLine.amount_usd < 0) return true;
  if (storageLine.amount_usd === 0 || storageLine.status === 'not_applicable') return false;
  if (!Array.isArray(storageMonths) || storageMonths.length === 0) return true;
  const pkgRef = input?.fee_context?.package_ref;
  const pkgRes = resolveUniquePackageByRef(input?.packages, pkgRef);
  if (pkgRes.present && !pkgRes.valid) return false;
  const pkg = pkgRes.pkg;
  let pkgCuft = null;
  let pkgOversize = false;
  if (pkg && typeof pkg === 'object') {
    const wtRes = resolveConsistentPkgWeightLb(pkg);
    if (wtRes.present && !wtRes.valid) return false;
    const dims = resolvePackageDimsRat(pkg);
    if (dims) {
      pkgCuft = dims.cubic_feet;
      pkgOversize = dims.isOversize;
    } else if (pkg.length_in !== undefined || pkg.width_in !== undefined || pkg.height_in !== undefined ||
      pkg.length_cm !== undefined || pkg.width_cm !== undefined || pkg.height_cm !== undefined) {
      return false;
    }
  }
  const lineCuft = finite(storageLine.cubic_feet_per_unit) && storageLine.cubic_feet_per_unit > 0
    ? storageLine.cubic_feet_per_unit
    : (finite(input?.source_inputs?.cubic_feet_per_unit) && input.source_inputs.cubic_feet_per_unit > 0
      ? input.source_inputs.cubic_feet_per_unit
      : null);
  if (lineCuft !== null && pkgCuft !== null && Math.abs(lineCuft - pkgCuft) > 1e-4) return false;
  const cuft = lineCuft ?? pkgCuft;
  if (storageLine.average_inventory_days !== undefined && (!finite(storageLine.average_inventory_days) || storageLine.average_inventory_days < 45)) {
    return false;
  }
  const days = storageLine.average_inventory_days ?? 45;
  const overCheck = collectLedgerFlag(input, 'is_oversize', pkg);
  const dgCheck = collectLedgerFlag(input, 'is_dangerous_goods', pkg);
  if (!overCheck.valid || !dgCheck.valid) return false;
  // Reject claiming is_oversize:true on physically Standard-size package or without proven oversize dimensions.
  if (overCheck.value === true && !pkgOversize) return false;
  const isDg = dgCheck.value === true;
  // Dangerous goods storage in US FBA is strictly HIGHER than non-DG ($0.99/$3.63 standard, $0.78/$2.43 oversize); never bypass floor downward.
  const offPeakFloor = isDg ? (pkgOversize ? 0.78 : 0.99) : (pkgOversize ? 0.56 : 0.78);
  const peakFloor = isDg ? (pkgOversize ? 2.43 : 3.63) : (pkgOversize ? 1.40 : 2.40);
  const rateCheck = resolveConsistentNumeric(
    [storageLine.fee_basis?.rate_usd_per_cuft_month, storageLine.rate_usd_per_cuft_month],
    v => finite(v) && v > 0,
  );
  if (!rateCheck.valid) return false;
  const storageWinCtx = input?.fee_context?.storage;
  const effectiveStorageMonths = windowValid(storageWinCtx) ? monthsIn(storageWinCtx) : storageMonths;
  const hasOffPeak = effectiveStorageMonths.some(m => m <= 9);
  const hasPeak = effectiveStorageMonths.some(m => m >= 10);
  if (rateCheck.present) {
    if (hasOffPeak && hasPeak) return false;
    if (hasPeak && rateCheck.value < peakFloor) return false;
    if (hasOffPeak && rateCheck.value < offPeakFloor) return false;
  }
  if (cuft !== null) {
    if (hasOffPeak && hasPeak) return false;
    const minRate = effectiveStorageMonths.reduce((sum, m) => sum + (m >= 10 ? peakFloor : offPeakFloor), 0) / effectiveStorageMonths.length;
    const minUsd = cuft * minRate * (days / 30);
    if (storageLine.amount_usd < minUsd - 1e-6) return false;
  }
  return true;
}

export function validateFeeBasis(input, { evidenceIds = [], operatingMonths, requireRegularRepeatOrder = false, profileRevision = 0 } = {}) {
  const strictR57 = Boolean(requireRegularRepeatOrder || profileRevision >= 57);
  const isR58 = profileRevision >= 58;
  const isR59 = profileRevision >= 59;
  const context = input.fee_context;
  const sources = new Set(evidenceIds);
  const evidenced = refs => Array.isArray(refs) && refs.length > 0 && refs.every(id => text(id) && sources.has(id));
  const issues = [];
  const components = new Map();
  const add = (line, code, reason) => issues.push({ line, code, reason });
  const validContext = context?.marketplace === 'US' && context?.currency === 'USD' && text(context?.package_ref) &&
    ['sales', 'storage', 'inbound'].every(key => windowValid(context[key]));
  if (!validContext) add('context', 'missing_fee_context', 'US/USD, one package reference and explicit valid sales, storage and inbound date windows are required.');
  else {
    if (isR58 && context.inbound.from > context.sales.through) {
      add('context', 'operating_period_mismatch', 'The inbound plan window cannot start after the declared sales window ends.');
    }
    if (operatingMonths) {
      const salesMonths = monthsIn(context.sales);
      const storageMonths = monthsIn(context.storage);
      const canonicalR59OffPeak = isR59 && isCanonical2027OffPeakWin(context.sales) && isCanonical2027OffPeakStorageWin(context.storage);
      const canonicalR59Peak = isR59 && isCanonical2027PeakWin(context.sales) && isCanonical2027PeakStorageWin(context.storage);
      const yearMismatch = isR58 && !canonicalR59Peak && (
        context.sales.from.slice(0, 4) !== context.sales.through.slice(0, 4) ||
        context.storage.from.slice(0, 4) !== context.storage.through.slice(0, 4) ||
        context.sales.from.slice(0, 4) !== context.storage.from.slice(0, 4)
      );
      const r59OffPeakMonthsOk = canonicalR59OffPeak && (
        ([2, 3, 4, 5, 6, 7, 8, 9].every(m => operatingMonths.includes(m)) &&
          operatingMonths.every(m => m >= 2 && m <= 10))
      );
      const r59PeakMonthsOk = canonicalR59Peak && (
        ([10, 11, 12].every(m => operatingMonths.includes(m)) &&
          operatingMonths.every(m => [10, 11, 12, 1].includes(m)))
      );
      if (yearMismatch || (!r59OffPeakMonthsOk && !r59PeakMonthsOk && (
        salesMonths.some(month => !operatingMonths.includes(month)) ||
        (strictR57 && (storageMonths.some(month => !operatingMonths.includes(month)) ||
          operatingMonths.some(month => !salesMonths.includes(month)) ||
          operatingMonths.some(month => !storageMonths.includes(month))))
      ))) {
        add('context', 'operating_period_mismatch', strictR57
          ? 'The dated sales and storage windows must match one target year and cover every month declared in the operating period.'
          : 'The dated sales window extends beyond the displayed operating-period months.');
      }
    }
  }
  const pkgResR58 = isR58 ? resolveUniquePackageByRef(input.packages, context?.package_ref) : { present: false, valid: true, pkg: null };
  if (isR58 && pkgResR58.present && !pkgResR58.valid) {
    add('context', 'invalid_fee_basis', 'packages[] must have unique nonempty ids matching fee_context.package_ref.');
  }
  const matchedPkgR58 = pkgResR58.pkg;
  const ledgerApparelCheck = isR58 ? collectLedgerFlag(input, 'is_apparel_or_shoes', matchedPkgR58) : { present: false, valid: true, value: false };
  const ledgerDgCheck = isR58 ? collectLedgerFlag(input, 'is_dangerous_goods', matchedPkgR58) : { present: false, valid: true, value: false };
  const ledgerOverCheck = isR58 ? collectLedgerFlag(input, 'is_oversize', matchedPkgR58) : { present: false, valid: true, value: false };

  const procLine = input.lines.find(line => line.id === 'procurement');
  const domLine = input.lines.find(line => line.id === 'domestic_freight');
  const isBareGoodsLedgerDeclared = Boolean(
    isR59 && (input.cost_basis === 'bare_goods_1688' || input.bare_goods_screening === true),
  );
  const isBareGoodsDomLine = Boolean(
    isR59 &&
    ((domLine && domLine.status === 'not_applicable' && domLine.amount_usd === 0) ||
      (isBareGoodsLedgerDeclared && !domLine)),
  );
  const validOrderUnits = value => isR58 ? (Number.isSafeInteger(value) && value >= 100) : value === 100;
  const orderUnitsMismatch = isR58 && procLine && domLine && !isBareGoodsDomLine &&
    procLine.status !== 'pending' && domLine.status !== 'pending' &&
    procLine.order_units !== domLine.order_units;
  let invalidSourceUnits = false;
  if (input.source_inputs && typeof input.source_inputs === 'object') {
    const unitKeys = isR58 ? ['complete_saleable_sets', 'order_units'] : ['complete_saleable_sets'];
    const presentSourceUnits = [];
    for (const k of unitKeys) {
      if (Object.hasOwn(input.source_inputs, k)) {
        const v = input.source_inputs[k];
        if (!validOrderUnits(v)) invalidSourceUnits = true;
        else presentSourceUnits.push(v);
      }
    }
    if (presentSourceUnits.length > 1 && presentSourceUnits.some(v => v !== presentSourceUnits[0])) {
      invalidSourceUnits = true;
    }
    if (isR58 && presentSourceUnits.length > 0) {
      const sv = presentSourceUnits[0];
      if ((procLine && procLine.status !== 'pending' && sv !== procLine.order_units) ||
        (domLine && !isBareGoodsDomLine && domLine.status !== 'pending' && sv !== domLine.order_units)) {
        invalidSourceUnits = true;
      }
    }
  }
  const invalidSourcePromo = input.source_inputs && Object.hasOwn(input.source_inputs, 'first_order_promotion') &&
    input.source_inputs.first_order_promotion !== false;
  const skuResolution = isR58 ? resolveConsistentSkuLines(input, procLine) : { present: false, conflict: false, skuLines: undefined };
  const skuCheck = isR58 && skuResolution.present && !skuResolution.conflict
    ? validateSkuLinesR58(skuResolution.skuLines, procLine?.order_units, procLine?.amount_usd, [
      procLine?.fx_cny_per_usd, input.fx_cny_per_usd, input.source_inputs?.fx_cny_per_usd,
    ])
    : null;
  const invalidSkuLines = Boolean(skuResolution.conflict || (skuCheck && !skuCheck.valid));
  const kitCheck = isR59
    ? evaluateSingleFactoryCompleteKit({
      cost_ledger: input,
      procLine,
      sku_lines: skuResolution.present && !skuResolution.conflict ? skuResolution.skuLines : undefined,
    })
    : null;
  if (kitCheck?.is_cross_factory_or_incomplete) {
    add('procurement', 'incomplete_cross_factory_kit', kitCheck.kit_note);
  }

  // Revision 58 physical return rate (distinct from refund_fraction when explicitly supplied).
  let rPhysical = input.refund_fraction;
  let invalidPhysicalReturn = false;
  if (isR58 && input.physical_return_fraction !== undefined && input.physical_return_fraction !== null) {
    if (!finite(input.physical_return_fraction) || input.physical_return_fraction < 0 || input.physical_return_fraction >= 1) {
      invalidPhysicalReturn = true;
    } else {
      rPhysical = input.physical_return_fraction;
    }
  }

  for (const line of input.lines) {
    if (!evidenced(line.evidence) && !(line.id === 'domestic_freight' && isBareGoodsDomLine)) {
      add(line.id, 'missing_cost_evidence', 'The cost needs registered source evidence, including any explicit zero or deferral.');
    }
    if (line.id === 'domestic_freight' && line.status === 'deferred') {
      add(line.id, 'domestic_quote_required', 'The current >=100-purchased-unit scope requires a domestic-delivery quote; the historical deferral cannot be reused.');
    } else if (strictR57 && (line.id === 'procurement' || (line.id === 'domestic_freight' && !isBareGoodsDomLine)) &&
      line.status !== 'pending' && (line.first_order_promotion !== false || !validOrderUnits(line.order_units) ||
        orderUnitsMismatch || invalidSourceUnits || invalidSourcePromo || invalidSkuLines)) {
      add(line.id, 'domestic_quote_required', isR58
        ? 'Revision 58 requires explicit integer order_units >= 100 (matching across procurement, domestic delivery, source_inputs, and any sku_lines[]) plus first_order_promotion: false.'
        : 'Revision 57 requires explicit order_units: 100 and first_order_promotion: false on both regular repeat-order procurement and domestic delivery.');
    }
    if (isR59 && line.id === 'headhaul' && line.status !== 'pending') {
      const rawHhSpecs = collectStructuredHeadhaulSpecs(line.cny_derivation, input.headhaul, input.source_inputs?.headhaul);
      if (rawHhSpecs.length > 0) {
        let firstExpectedUsd = null;
        for (const rawHhSpec of rawHhSpecs) {
          const effFx = rawHhSpec.fx ?? rawHhSpec.fx_cny_per_usd ?? input.fx_cny_per_usd ?? input.source_inputs?.fx_cny_per_usd;
          const effUnits = input.order_units ?? procLine?.order_units ?? rawHhSpec.order_units ?? null;
          const hhCalc = computeHeadhaulWithA4Rules(rawHhSpec, effFx, effUnits, {
            isR58: true,
            isR59: true,
            steadyStateReplenishment: input.steady_state_replenishment,
          });
          if (hhCalc.weight_conflict) {
            add('headhaul', 'headhaul_weight_conflict', hhCalc.conflict_reason ?? 'Conflicting carton weight and total actual weight in headhaul inputs.');
            break;
          }
          if (hhCalc.missing_surcharge_quote) {
            add('headhaul', 'headhaul_surcharge_quote_required', `Freight A4 surcharge triggered (${hhCalc.a4_applied?.missing_surcharge_quote ?? 'small shipment / carton'}) without an explicit surcharge quote.`);
            break;
          }
          if (!hhCalc.exact_usd_rational) {
            add('headhaul', 'invalid_headhaul_tariff', 'Supplied Freight A4 headhaul tariff inputs are incomplete or invalid.');
            break;
          }
          const expectedHhUsd = roundBigRat(hhCalc.exact_usd_rational.n, hhCalc.exact_usd_rational.d, 10);
          if (firstExpectedUsd !== null && Math.abs(firstExpectedUsd - expectedHhUsd) > 0.005) {
            add('headhaul', 'headhaul_weight_conflict', `Conflicting structured headhaul specs compute different per-unit costs ($${firstExpectedUsd} vs $${expectedHhUsd}).`);
            break;
          }
          firstExpectedUsd = expectedHhUsd;
          if (finite(line.amount_usd) && Math.abs(line.amount_usd - expectedHhUsd) > 0.005) {
            add('headhaul', 'headhaul_tariff_mismatch', `Supplied headhaul amount_usd (${line.amount_usd}) conflicts with recomputed Freight A4 tariff (${expectedHhUsd}).`);
            break;
          }
        }
      }
    }
    if (isR58 && line.id === 'returns_processing' && line.status !== 'pending') {
      if (invalidPhysicalReturn) {
        add('returns_processing', 'invalid_return_rate', 'Supplied physical_return_fraction must be a finite fraction in [0, 1).');
      } else {
        const hasExemption = Boolean(line.exemption && typeof line.exemption === 'object' &&
          text(line.exemption.reason) && evidenced(line.exemption.evidence));
        const wtCheck = resolveConsistentPkgWeightLb(matchedPkgR58);
        const isApparel = ledgerApparelCheck.value === true;
        const isOfficial2027RetVersion = /^US-FBA-2027/i.test(String(line.fee_basis?.version ?? '').trim());
        const backdatedOfficial2027Ret = !isOfficial2027ScheduleWindowValid('returns_processing', line.fee_basis, isApparel);
        const minRetStart = isApparel && isR59 ? '2027-01-15' : '2027-02-01';
        const maxRetEnd = isR59 ? '2028-01-14' : '2027-12-31';
        const in2027RetSchedule = validContext && context.sales.from >= minRetStart && context.sales.through <= maxRetEnd;
        const verifiedPerRet = (!isApparel || isR59) && (in2027RetSchedule || isOfficial2027RetVersion)
          ? lookupVerified2027PerReturnFee(matchedPkgR58, { isApparelOrShoes: isApparel, allowAll2027Tiers: isR59 })
          : null;
        const catCheck = resolveConsistentFeeCategory([line.fee_basis?.fee_category, line.fee_category, input.fee_category]);
        const verifiedCat = catCheck.valid && catCheck.present ? lookupVerified2027ReturnThreshold(catCheck.value) : null;
        const threshCheck = resolveConsistentNumeric(
          [line.fee_basis?.return_threshold, line.return_threshold, input.return_threshold],
          v => finite(v) && v >= 0 && v < 1,
        );
        const perRetCheck = resolveConsistentNumeric(
          [line.fee_basis?.per_return_fee_usd, line.per_return_fee_usd, input.per_return_fee_usd],
          v => finite(v) && v > 0,
        );
        if ((pkgResR58.present && !pkgResR58.valid) || !ledgerApparelCheck.valid || !ledgerDgCheck.valid || !ledgerOverCheck.valid ||
          (wtCheck.present && !wtCheck.valid)) {
          add('returns_processing', 'returns_processing_required', 'Conflicting or invalid is_apparel_or_shoes, is_dangerous_goods, is_oversize, or package fields.');
        } else if (backdatedOfficial2027Ret) {
          add('returns_processing', 'invalid_fee_basis', 'Official 2027 US returns-processing schedule cannot be backdated before its effective start date.');
        } else if (!catCheck.valid) {
          add('returns_processing', 'returns_processing_required', 'Conflicting or invalid fee_category across line, fee_basis, and ledger.');
        } else if (!threshCheck.valid) {
          add('returns_processing', 'returns_processing_required', 'Conflicting or invalid return_threshold across line, fee_basis, and ledger.');
        } else if (verifiedCat && threshCheck.present && threshCheck.value !== verifiedCat.threshold) {
          add('returns_processing', 'returns_processing_required', `Supplied return_threshold (${threshCheck.value}) conflicts with verified 2027 threshold (${verifiedCat.threshold}) for ${verifiedCat.canonical}.`);
        } else if (!perRetCheck.valid) {
          add('returns_processing', 'returns_processing_required', 'Conflicting or invalid per_return_fee_usd across line, fee_basis, and ledger.');
        } else if (verifiedPerRet !== null && perRetCheck.present && Math.abs(perRetCheck.value - verifiedPerRet) > 1e-9) {
          add('returns_processing', 'returns_processing_required', `Supplied per_return_fee_usd (${perRetCheck.value}) conflicts with verified 2027 FBA return fee (${verifiedPerRet}).`);
        } else if (isApparel) {
          if (rPhysical > 0 && !hasExemption) {
            if (line.amount_usd === 0 || line.status === 'not_applicable') {
              add('returns_processing', 'returns_processing_required', 'Apparel and shoes incur per-return processing fees with no threshold exemption unless officially waived.');
            } else if (!perRetCheck.present) {
              add('returns_processing', 'returns_processing_required', 'Apparel and shoes returns processing requires explicit positive per_return_fee_usd for deterministic verification.');
            } else {
              const expected = Math.round((rPhysical * perRetCheck.value + Number.EPSILON) * 1e10) / 1e10;
              if (!finite(line.amount_usd) || Math.abs(line.amount_usd - expected) > 1e-6) {
                add('returns_processing', 'returns_processing_required', `Apparel returns_processing amount ${line.amount_usd} does not match expected r_physical * per_return_fee_usd (${expected}).`);
              }
            }
          }
        } else if (!hasExemption) {
          if (!threshCheck.present && rPhysical > 0) {
            add('returns_processing', 'returns_processing_required', 'Revision 58 requires a verified return_threshold or official exemption whenever r_physical > 0.');
          } else if (threshCheck.present && rPhysical > threshCheck.value) {
            if (line.amount_usd === 0 || line.status === 'not_applicable') {
              add('returns_processing', 'returns_processing_required', `Physical return rate ${rPhysical} exceeds category threshold ${threshCheck.value} without an evidenced exemption; zero returns_processing is rejected.`);
            } else if (!perRetCheck.present) {
              add('returns_processing', 'returns_processing_required', 'Excess returns processing above threshold requires explicit positive per_return_fee_usd for deterministic verification.');
            } else {
              const expected = Math.round(((rPhysical - threshCheck.value) * perRetCheck.value + Number.EPSILON) * 1e10) / 1e10;
              if (!finite(line.amount_usd) || Math.abs(line.amount_usd - expected) > 1e-6) {
                add('returns_processing', 'returns_processing_required', `Returns processing amount ${line.amount_usd} does not match expected (r_physical - threshold) * per_return_fee_usd (${expected}).`);
              }
            }
          }
        }
      }
    }
    if (line.amount_usd > 0 && !['pending', 'deferred'].includes(line.status)) {
      if (!Array.isArray(line.components) || !line.components.length || line.components.some(value => !text(value))) {
        add(line.id, 'missing_components', 'A positive cost must declare the charge components it already includes.');
      } else {
        for (const component of line.components) {
          if (components.has(component)) {
            const previous = components.get(component);
            add(line.id, 'duplicate_component', `${component} is already included in ${previous}; do not charge it twice.`);
            add(previous, 'duplicate_component', `${component} is repeated in ${line.id}.`);
          } else components.set(component, line.id);
        }
      }
    }
    if (!Object.hasOwn(FEE_WINDOWS, line.id) || (line.id === 'other_applicable' && line.payee === 'external')) continue;
    if (isR58 && line.id === 'fulfillment' && validContext && context.sales.through > '2027-10-14' &&
      (line.status !== 'pending' || line.fee_basis?.status === 'published') &&
      hasProhibited2026PeakExtrapolation(line, input)) {
      add('fulfillment', 'prohibited_2026_peak_extrapolation', '2027 Q4 peak fulfillment fees cannot be estimated from 2026 peak uplifts; keep 2027 Q4 peak margin blank/pending until Amazon publishes official 2027 peak rates.');
      continue;
    }
    const basis = line.fee_basis;
    if (basis?.status !== 'published') {
      add(line.id, 'unpublished_fee', 'A published applicable fee basis is missing; a hypothetical or unavailable rate cannot support this period.');
      continue;
    }
    if (!text(basis.version) || !evidenced(basis.evidence) || !date(basis.effective_from) ||
      !(basis.effective_through === null || date(basis.effective_through)) ||
      (basis.effective_through !== null && basis.effective_through < basis.effective_from) ||
      (line.id === 'fulfillment' && basis.effective_through === null)) {
      add(line.id, 'invalid_fee_basis', 'A fee version, registered sources and valid effective dates are required; fulfillment needs a bounded published window.');
      continue;
    }
    if (isR58 && !isOfficial2027ScheduleWindowValid(line.id, basis, ledgerApparelCheck.value === true)) {
      add(line.id, 'invalid_fee_basis', `${line.id}: declared dates on official 2027 schedule (${basis.version}) exceed its published effective window.`);
      continue;
    }
    if (!validContext) continue;
    if (basis.marketplace !== context.marketplace || basis.currency !== context.currency || basis.package_ref !== context.package_ref) {
      add(line.id, 'fee_scope_mismatch', 'Fee marketplace, currency or packaged-unit reference differs from the cost scenario.');
    }
    const target = context[FEE_WINDOWS[line.id]];
    if (target.from < basis.effective_from || (basis.effective_through !== null && target.through > basis.effective_through)) {
      add(line.id, 'fee_outside_dates', `${line.id}: target ${target.from}..${target.through} is outside ${basis.version} (${basis.effective_from}..${basis.effective_through ?? 'open'}).`);
    }
    if (basis.months !== undefined) {
      const targetMonthsForSeason = monthsIn(target);
      if (!Array.isArray(basis.months) || !basis.months.length ||
        basis.months.some(month => !Number.isInteger(month) || month < 1 || month > 12)) {
        add(line.id, isR58 ? 'invalid_fee_basis' : 'fee_season_mismatch', `${line.id}: declared fee_basis.months must be a nonempty array of integers 1..12.`);
      } else if (targetMonthsForSeason.some(month => !basis.months.includes(month))) {
        add(line.id, 'fee_season_mismatch', `${line.id}: the target months are not covered by the declared seasonal rate.`);
      }
    }
    if (isR58 && line.id === 'fulfillment' && line.status !== 'pending') {
      const pricingRes = resolveEffectivePricing(input);
      if (pricingRes.valid) {
        const bandOf = p => (p < 10 ? 'under_10' : p <= 50 ? '10_to_50' : 'over_50');
        const listBand = bandOf(pricingRes.list_price_usd);
        const netBand = bandOf(pricingRes.net_effective_price_usd);
        const declaredBand = text(basis?.price_band) ? basis.price_band.trim() : null;
        const hasCouponOnly = Boolean(
          ((pricingRes.ongoing_coupon_usd ?? 0) > 0 || (pricingRes.ongoing_coupon_pct ?? 0) > 0) &&
          !((input?.prime_exclusive_discount_usd ?? 0) > 0 || (input?.prime_exclusive_discount_pct ?? 0) > 0),
        );
        const r59CouponListTierVerified = isR59 && hasCouponOnly && (declaredBand === null || declaredBand === listBand);
        const promoVerified = line.fulfillment_promo_tier_verified === true || input.fulfillment_promo_tier_verified === true || r59CouponListTierVerified;
        if (isR59 && hasCouponOnly && listBand !== netBand && declaredBand && declaredBand !== listBand) {
          add('fulfillment', 'fee_scope_mismatch', `Fulfillment fee_basis.price_band (${declaredBand}) under ongoing coupon must match list_price_usd band (${listBand}), not net band (${netBand}).`);
        } else if (pricingRes.has_ongoing_discount && listBand !== netBand && !promoVerified) {
          add('fulfillment', 'invalid_fee_basis', `Ongoing discount crosses FBA price tier (${listBand} -> ${netBand}) without fulfillment_promo_tier_verified: true; verify exact Amazon promo tier fee before scoring.`);
        } else if (declaredBand && declaredBand !== netBand && !(pricingRes.has_ongoing_discount && promoVerified)) {
          add('fulfillment', 'fee_scope_mismatch', `Fulfillment fee_basis.price_band (${declaredBand}) conflicts with payable net price band (${netBand}).`);
        }
      }
    }
    if (isR58 && line.id === 'storage' && !storageMeets2027Floor(input, line, monthsIn(target))) {
      add('storage', 'fee_season_mismatch', 'storage: amount or rate violates the 2027 US unified monthly storage floor ($0.78 Jan–Sep / $2.40 Oct–Dec, >=45d average inventory).');
    }
  }
  if (isR58) {
    const headhaulLine = input.lines.find(l => l.id === 'headhaul');
    if (headhaulLine && headhaulLine.amount_usd > 0 && !['pending', 'deferred'].includes(headhaulLine.status)) {
      const hasBondExemption = Boolean(
        headhaulLine.bond_exemption &&
        typeof headhaulLine.bond_exemption === 'object' &&
        text(headhaulLine.bond_exemption.reason) &&
        evidenced(headhaulLine.bond_exemption.evidence),
      );
      const bondInHeadhaul = Array.isArray(headhaulLine.components) && headhaulLine.components.includes('carrier_bond');
      const bondElsewherePositive = input.lines.some(
        l => l &&
          l.id !== 'headhaul' &&
          l.id !== 'recovery_credit' &&
          !['pending', 'deferred'].includes(l.status) &&
          typeof l.amount_usd === 'number' &&
          l.amount_usd > 0 &&
          Array.isArray(l.components) &&
          l.components.includes('carrier_bond'),
      );
      if (!bondInHeadhaul && !bondElsewherePositive && !hasBondExemption) {
        add('headhaul', 'missing_carrier_bond', 'Revision 58 requires positive headhaul to include "carrier_bond" in components (or declare carrier_bond once in another positive cost line, never recovery_credit or negative credit, or supply an evidenced bond_exemption).');
      }
    }
  }
  return {
    status: issues.length ? 'needs_evidence' : 'validated',
    context: context ?? null,
    issues,
    ...(kitCheck ? { single_factory_complete_kit: kitCheck } : {}),
  };
}

/**
 * Official Amazon US Coupon Fee (June 2025 onward, carried into 2027):
 * $5.00 upfront per coupon campaign + 2.5% of coupon-attributed sales.
 * Allocates the $5.00 campaign flat fee across `coupon_campaign_units` (default 100 units)
 * plus 2.5% of `net_effective_price_usd * coupon_redemption_share`.
 */
export function computeAmazonCouponRedemptionFee2027({
  net_effective_price_usd,
  ongoing_coupon_usd = 0,
  ongoing_coupon_pct = 0,
  coupon_redemption_share = 1,
  coupon_campaign_units = 100,
  include_campaign_flat_usd = true,
} = {}) {
  const hasCoupon = (finite(ongoing_coupon_usd) && ongoing_coupon_usd > 0) ||
    (finite(ongoing_coupon_pct) && ongoing_coupon_pct > 0);
  if (!hasCoupon || !finite(net_effective_price_usd) || net_effective_price_usd <= 0) {
    return {
      applicable: false,
      per_unit_usd: 0,
      variable_2_5pct_usd: 0,
      campaign_flat_per_unit_usd: 0,
      exact_usd_rational: { n: 0n, d: 1n },
    };
  }
  const share = finite(coupon_redemption_share) && coupon_redemption_share >= 0 && coupon_redemption_share <= 1
    ? coupon_redemption_share
    : 1;
  const units = Number.isSafeInteger(coupon_campaign_units) && coupon_campaign_units > 0
    ? coupon_campaign_units
    : 100;
  const netR = toBigRat(net_effective_price_usd);
  const shareR = toBigRat(share);
  // 2.5% = 25 / 1000 = 1 / 40
  const varR = mulBigRat(mulBigRat(netR, { n: 1n, d: 40n }), shareR);
  const flatR = include_campaign_flat_usd !== false
    ? divBigRat({ n: 5n, d: 1n }, toBigRat(units))
    : { n: 0n, d: 1n };
  const totalR = addBigRat(varR, flatR);
  return {
    applicable: true,
    per_unit_usd: roundBigRat(totalR.n, totalR.d, 10),
    variable_2_5pct_usd: roundBigRat(varR.n, varR.d, 10),
    campaign_flat_per_unit_usd: roundBigRat(flatR.n, flatR.d, 10),
    coupon_campaign_units: units,
    coupon_redemption_share: share,
    exact_usd_rational: totalR,
  };
}

const A4_HEADHAUL_EXTRA_KEYS = [
  'carton_cm',
  'carton_count',
  'units_per_carton',
  'cartons',
  'mixed_cartons',
  'identical_cartons',
  'uniform_cartons',
  'actual_weight_kg_total',
  'actual_weight_kg_per_unit',
  'weight_per_carton_kg',
  'volumetric_divisor',
  'min_shipment_billable_kg',
  'small_shipment_threshold_kg',
  'small_shipment_surcharge_cny_per_kg',
  'small_carton_threshold_kg',
  'small_carton_surcharge_cny_per_carton',
  'small_carton_surcharge_cny_per_kg',
];

const STRUCTURED_PER_KG_HEADHAUL_KEYS = [
  'rate_cny_per_kg',
  'chargeable_kg_per_unit',
  'surcharge_cny_per_kg',
  'bond_cny_per_kg',
  'bond_cny_per_shipment',
  ...A4_HEADHAUL_EXTRA_KEYS,
];

export function isStructuredHeadhaulSpec(cand) {
  if (!cand || typeof cand !== 'object' || Array.isArray(cand)) return false;
  return STRUCTURED_PER_KG_HEADHAUL_KEYS.some(k => cand[k] !== undefined && cand[k] !== null);
}

export function collectStructuredHeadhaulSpecs(...candidates) {
  const seen = new Set();
  const out = [];
  for (const cand of candidates) {
    if (!isStructuredHeadhaulSpec(cand) || seen.has(cand)) continue;
    seen.add(cand);
    out.push(cand);
  }
  return out;
}

function normalizeCartonDimensionsCm(cm) {
  if (cm === undefined || cm === null) return { present: false, valid: true, dims: null };
  if (Array.isArray(cm)) {
    if (cm.length === 3 && cm.every(v => finite(v) && v > 0)) {
      return { present: true, valid: true, dims: [cm[0], cm[1], cm[2]] };
    }
    return { present: true, valid: false, dims: null };
  }
  if (typeof cm === 'object') {
    const l = cm.length_cm ?? cm.l_cm;
    const w = cm.width_cm ?? cm.w_cm;
    const h = cm.height_cm ?? cm.h_cm;
    if (finite(l) && l > 0 && finite(w) && w > 0 && finite(h) && h > 0) {
      return { present: true, valid: true, dims: [l, w, h] };
    }
    return { present: true, valid: false, dims: null };
  }
  return { present: true, valid: false, dims: null };
}

function decimalPlacesOfNumber(num) {
  const s = String(num).toLowerCase();
  const [mantissa, expStr] = s.split('e');
  const exp = expStr ? Number(expStr) : 0;
  const fracLen = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
  return Math.max(0, fracLen - exp);
}

function halfUlpRat(num) {
  const d = decimalPlacesOfNumber(num);
  if (d <= 0) return { n: 0n, d: 1n };
  return { n: 1n, d: 2n * (10n ** BigInt(d)) };
}

function absRatDiff(a, b) {
  const diff = addBigRat(a, { n: -b.n, d: b.d });
  return diff.n < 0n ? { n: -diff.n, d: diff.d } : diff;
}

function totalsConsistentWithinDecimalPrecision(unitNum, countR, totalNum, totalR) {
  const unitR = toBigRat(unitNum);
  const derivedTotalR = mulBigRat(unitR, countR);
  if (ratCmp(derivedTotalR, totalR) === 0) return true;
  const unitHalfUlp = halfUlpRat(unitNum);
  if (unitHalfUlp.n > 0n) {
    const expectedUnitR = divBigRat(totalR, countR);
    if (ratCmp(absRatDiff(unitR, expectedUnitR), unitHalfUlp) <= 0) return true;
  }
  if (finite(totalNum)) {
    const totalHalfUlp = halfUlpRat(totalNum);
    if (totalHalfUlp.n > 0n && ratCmp(absRatDiff(derivedTotalR, totalR), totalHalfUlp) <= 0) return true;
  }
  return false;
}

/**
 * Shared exact BigInt rational headhaul calculator incorporating freight-forwarder A4 rules:
 *  - Actual gross weight: `actual_weight_kg_total`, `actual_weight_kg_per_unit * order_units`,
 *    `weight_per_carton_kg * carton_count` (for uniform cartons), or summed `cartons[]` weights
 *  - Volumetric weight: `carton_cm[0]*carton_cm[1]*carton_cm[2] / volumetric_divisor (default 6000) * carton_count`
 *    or summed per-carton dimensions in `cartons[]`
 *  - Minimum shipment billable weight: <10 kg billed at 10 kg minimum (enabled in r59 or when A4 fields supplied)
 *  - <50 kg small-shipment surcharge (`small_shipment_surcharge_cny_per_kg`)
 *  - <8 kg outer-carton surcharge (`small_carton_surcharge_cny_per_carton` / `small_carton_surcharge_cny_per_kg`)
 *  - Base rate + product surcharge + per-kg or per-shipment carrier bond
 */
export function computeHeadhaulWithA4Rules(headhaul, fx, orderUnits, {
  isR58 = false,
  isR59 = false,
  steadyStateReplenishment = undefined,
} = {}) {
  if (!headhaul || typeof headhaul !== 'object') {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }
  const {
    chargeable_kg_per_unit: kgPerUnit,
    rate_cny_per_kg: rawRate,
    surcharge_cny_per_kg: surcharge = 0,
    bond_cny_per_kg: bondPerKg,
    bond_cny_per_shipment: bondPerShipment,
    carton_cm,
    carton_count,
    actual_weight_kg_total,
    actual_weight_kg_per_unit,
    weight_per_carton_kg,
    volumetric_divisor,
    min_shipment_billable_kg,
    small_shipment_threshold_kg,
    small_shipment_surcharge_cny_per_kg,
    small_carton_threshold_kg,
    small_carton_surcharge_cny_per_carton,
    small_carton_surcharge_cny_per_kg,
  } = headhaul;

  if (headhaul.usd_per_unit !== undefined && headhaul.usd_per_unit !== null) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: 'headhaul cannot mix scalar usd_per_unit with per-kg/A4 CNY headhaul tariff fields.',
      a4_applied: { weight_conflict: true },
    };
  }
  if (typeof steadyStateReplenishment === 'boolean' &&
    typeof headhaul.steady_state_replenishment === 'boolean' &&
    steadyStateReplenishment !== headhaul.steady_state_replenishment) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: `Conflicting top-level steady_state_replenishment (${steadyStateReplenishment}) vs headhaul.steady_state_replenishment (${headhaul.steady_state_replenishment}).`,
      a4_applied: { weight_conflict: true },
    };
  }
  const resolvedSteadyStateFlag = typeof steadyStateReplenishment === 'boolean'
    ? steadyStateReplenishment
    : (typeof headhaul.steady_state_replenishment === 'boolean' ? headhaul.steady_state_replenishment : undefined);
  const scopeStr = String(headhaul.destination_scope ?? headhaul.headhaul_destination_scope ?? '').trim().toLowerCase();
  const isExplicitKaiqiNationwide = scopeStr === 'nationwide_multi_warehouse' ||
    scopeStr === 'kaiqi_nationwide' ||
    scopeStr === 'nationwide' ||
    scopeStr === 'multi_warehouse';
  const rate = (rawRate === undefined || rawRate === null) && isExplicitKaiqiNationwide && resolvedSteadyStateFlag !== false
    ? BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg
    : rawRate;

  const hasA4Extras = A4_HEADHAUL_EXTRA_KEYS.some(k => headhaul[k] !== undefined && headhaul[k] !== null);
  const hasPerKgBond = finite(bondPerKg) && bondPerKg >= 0;
  const hasShipmentBond = finite(bondPerShipment) && bondPerShipment >= 0;
  if (finite(orderUnits) && orderUnits > 0 && finite(headhaul.order_units) && headhaul.order_units > 0 &&
    orderUnits !== headhaul.order_units) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: `Conflicting order_units (${orderUnits}) vs headhaul.order_units (${headhaul.order_units}).`,
      a4_applied: { weight_conflict: true },
    };
  }
  const effectiveUnits = finite(orderUnits) && orderUnits > 0
    ? orderUnits
    : (finite(headhaul.order_units) && headhaul.order_units > 0 ? headhaul.order_units : null);
  const needsUnits = !isR58 || hasShipmentBond || hasA4Extras || isR59;

  const cartonCmRes = normalizeCartonDimensionsCm(carton_cm);
  if (cartonCmRes.present && !cartonCmRes.valid) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      missing_surcharge_quote: true,
      a4_applied: {
        volumetric_dimensions_present: true,
        missing_surcharge_quote: 'invalid_carton_cm_dimensions',
      },
    };
  }
  const normalizedCartonCm = cartonCmRes.dims;

  const hasInvalidCartonCount = carton_count !== undefined && carton_count !== null &&
    (!Number.isSafeInteger(carton_count) || carton_count <= 0);
  const hasInvalidUnitsPerCarton = headhaul.units_per_carton !== undefined && headhaul.units_per_carton !== null &&
    (!Number.isSafeInteger(headhaul.units_per_carton) || headhaul.units_per_carton <= 0);
  const hasInvalidWeightPerCarton = weight_per_carton_kg !== undefined && weight_per_carton_kg !== null &&
    (!finite(weight_per_carton_kg) || weight_per_carton_kg <= 0);
  const hasInvalidActualTotal = actual_weight_kg_total !== undefined && actual_weight_kg_total !== null &&
    (!finite(actual_weight_kg_total) || actual_weight_kg_total <= 0);
  const hasInvalidActualPerUnit = actual_weight_kg_per_unit !== undefined && actual_weight_kg_per_unit !== null &&
    (!finite(actual_weight_kg_per_unit) || actual_weight_kg_per_unit <= 0);
  const hasInvalidCartonsList = headhaul.cartons !== undefined && headhaul.cartons !== null &&
    (!Array.isArray(headhaul.cartons) || headhaul.cartons.length === 0);
  if (hasInvalidCartonCount || hasInvalidUnitsPerCarton || hasInvalidWeightPerCarton ||
    hasInvalidActualTotal || hasInvalidActualPerUnit || hasInvalidCartonsList) {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }

  const hasCartonsArray = Array.isArray(headhaul.cartons) && headhaul.cartons.length > 0;
  const hasValidCartonCm = normalizedCartonCm !== null;
  const hasWeightPerCarton = finite(weight_per_carton_kg) && weight_per_carton_kg > 0;
  const hasActualTotal = finite(actual_weight_kg_total) && actual_weight_kg_total > 0;
  const hasActualPerUnit = finite(actual_weight_kg_per_unit) && actual_weight_kg_per_unit > 0;
  const hasKgPerUnit = finite(kgPerUnit) && kgPerUnit > 0;
  const canDeriveWeight = hasKgPerUnit || hasActualPerUnit || hasActualTotal || hasWeightPerCarton || hasValidCartonCm || hasCartonsArray;

  if (!canDeriveWeight || ![rate, surcharge].every(v => finite(v) && v >= 0) ||
    (!hasPerKgBond && !hasShipmentBond) || (hasPerKgBond && hasShipmentBond) ||
    !finite(fx) || fx <= 0 || (needsUnits && (!finite(effectiveUnits) || effectiveUnits <= 0))) {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }

  const unitsR = effectiveUnits !== null ? toBigRat(effectiveUnits) : { n: 100n, d: 1n };
  const divisorVal = finite(volumetric_divisor) && volumetric_divisor > 0 ? volumetric_divisor : 6000;
  const divisorR = toBigRat(divisorVal);
  const isMixedCartons = headhaul.mixed_cartons === true ||
    headhaul.identical_cartons === false ||
    headhaul.uniform_cartons === false ||
    hasCartonsArray;
  const explicitCartonCount = Number.isSafeInteger(carton_count) && carton_count > 0 ? carton_count : null;
  const hasUnitsPerCarton = Number.isSafeInteger(headhaul.units_per_carton) && headhaul.units_per_carton > 0 &&
    finite(effectiveUnits) && effectiveUnits > 0;
  const derivedCartonsFromPack = hasUnitsPerCarton
    ? Math.ceil(effectiveUnits / headhaul.units_per_carton)
    : null;
  if (explicitCartonCount !== null && derivedCartonsFromPack !== null && explicitCartonCount !== derivedCartonsFromPack) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: `carton_count (${explicitCartonCount}) conflicts with Math.ceil(order_units / units_per_carton) (${derivedCartonsFromPack}).`,
      a4_applied: {
        weight_conflict: true,
        carton_count: explicitCartonCount,
        derived_carton_count: derivedCartonsFromPack,
      },
    };
  }
  const hasPartialLastCarton = hasUnitsPerCarton && (effectiveUnits % headhaul.units_per_carton !== 0);

  // Sum per-carton specs when mixed `cartons[]` list is supplied.
  let cartonsTotalCount = null;
  let cartonsActualTotalR = null;
  let cartonsVolTotalR = null;
  let cartonsMinPerCartonKgR = null;
  if (hasCartonsArray) {
    let totalCnt = 0;
    let anyDims = false;
    let allDims = true;
    let anyWt = false;
    let allWt = true;
    let sumVolR = { n: 0n, d: 1n };
    let sumWtR = { n: 0n, d: 1n };
    for (const item of headhaul.cartons) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return {
          amount_usd: null,
          exact_usd_rational: null,
          cny_derivation: null,
          missing_surcharge_quote: true,
          a4_applied: { mixed_cartons: true, missing_surcharge_quote: 'invalid_cartons_entry' },
        };
      }
      const cnt = item.count === undefined || item.count === null ? 1 : item.count;
      if (!Number.isSafeInteger(cnt) || cnt <= 0) {
        return {
          amount_usd: null,
          exact_usd_rational: null,
          cny_derivation: null,
          missing_surcharge_quote: true,
          a4_applied: { mixed_cartons: true, missing_surcharge_quote: 'invalid_carton_entry_count' },
        };
      }
      totalCnt += cnt;
      const cntR = toBigRat(cnt);
      const rawItemCm = item.carton_cm !== undefined
        ? item.carton_cm
        : ((item.length_cm !== undefined || item.l_cm !== undefined || item.width_cm !== undefined || item.w_cm !== undefined || item.height_cm !== undefined || item.h_cm !== undefined)
          ? item
          : null);
      const itemCm = normalizeCartonDimensionsCm(rawItemCm);
      if (itemCm.present && !itemCm.valid) {
        return {
          amount_usd: null,
          exact_usd_rational: null,
          cny_derivation: null,
          missing_surcharge_quote: true,
          a4_applied: { mixed_cartons: true, volumetric_dimensions_present: true, missing_surcharge_quote: 'invalid_carton_cm_dimensions' },
        };
      }
      if (itemCm.present) {
        anyDims = true;
        const volOneR = divBigRat(
          mulBigRat(mulBigRat(toBigRat(itemCm.dims[0]), toBigRat(itemCm.dims[1])), toBigRat(itemCm.dims[2])),
          divisorR,
        );
        sumVolR = addBigRat(sumVolR, mulBigRat(volOneR, cntR));
      } else {
        allDims = false;
      }
      const rawWt = item.weight_kg ?? item.weight_per_carton_kg;
      if (rawWt !== undefined && rawWt !== null) {
        if (!finite(rawWt) || rawWt <= 0) {
          return {
            amount_usd: null,
            exact_usd_rational: null,
            cny_derivation: null,
            missing_surcharge_quote: true,
            a4_applied: { mixed_cartons: true, missing_surcharge_quote: 'invalid_carton_entry_weight' },
          };
        }
        anyWt = true;
        const wtR = toBigRat(rawWt);
        sumWtR = addBigRat(sumWtR, mulBigRat(wtR, cntR));
        if (cartonsMinPerCartonKgR === null || ratCmp(wtR, cartonsMinPerCartonKgR) < 0) {
          cartonsMinPerCartonKgR = wtR;
        }
      } else {
        allWt = false;
      }
    }
    if (anyDims && !allDims) {
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        missing_surcharge_quote: true,
        a4_applied: { mixed_cartons: true, volumetric_dimensions_present: true, missing_surcharge_quote: 'incomplete_cartons_dimensions' },
      };
    }
    if (anyWt && !allWt && !hasActualTotal && !hasActualPerUnit) {
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        missing_surcharge_quote: true,
        a4_applied: { mixed_cartons: true, missing_surcharge_quote: 'incomplete_cartons_weights' },
      };
    }
    if (explicitCartonCount !== null && explicitCartonCount !== totalCnt) {
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        weight_conflict: true,
        conflict_reason: `carton_count (${explicitCartonCount}) conflicts with cartons[] summed count (${totalCnt}).`,
        a4_applied: { weight_conflict: true, carton_count: explicitCartonCount, derived_carton_count: totalCnt },
      };
    }
    cartonsTotalCount = totalCnt;
    if (anyDims && allDims) cartonsVolTotalR = sumVolR;
    if (anyWt && allWt) cartonsActualTotalR = sumWtR;
  }

  const cartonCountInt = explicitCartonCount ?? cartonsTotalCount ?? derivedCartonsFromPack;
  const effectiveUniformCartonCount = cartonCountInt ?? (headhaul.single_carton_verified === true && !isMixedCartons ? 1 : null);
  const canMultiplyUniformCartons = !isMixedCartons && !hasPartialLastCarton && effectiveUniformCartonCount !== null;

  const actualTotalFromTotalR = hasActualTotal ? toBigRat(actual_weight_kg_total) : null;
  const actualTotalFromPerUnitR = hasActualPerUnit ? mulBigRat(toBigRat(actual_weight_kg_per_unit), unitsR) : null;
  const declaredChargeableTotalR = hasKgPerUnit ? mulBigRat(toBigRat(kgPerUnit), unitsR) : null;

  if (actualTotalFromTotalR && actualTotalFromPerUnitR &&
    !totalsConsistentWithinDecimalPrecision(actual_weight_kg_per_unit, unitsR, actual_weight_kg_total, actualTotalFromTotalR)) {
    const suppliedTotalKg = roundBigRat(actualTotalFromTotalR.n, actualTotalFromTotalR.d, 6);
    const derivedUnitTotalKg = roundBigRat(actualTotalFromPerUnitR.n, actualTotalFromPerUnitR.d, 6);
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: `actual_weight_kg_total (${suppliedTotalKg} kg) conflicts with actual_weight_kg_per_unit * order_units (${derivedUnitTotalKg} kg).`,
      a4_applied: {
        weight_conflict: true,
        supplied_actual_weight_kg_total: suppliedTotalKg,
        derived_actual_weight_kg_total: derivedUnitTotalKg,
      },
    };
  }

  if (cartonsActualTotalR && actualTotalFromTotalR) {
    const totHalfUlp = halfUlpRat(actual_weight_kg_total);
    if (ratCmp(absRatDiff(cartonsActualTotalR, actualTotalFromTotalR), totHalfUlp) > 0) {
      const derivedKg = roundBigRat(cartonsActualTotalR.n, cartonsActualTotalR.d, 6);
      const suppliedKg = roundBigRat(actualTotalFromTotalR.n, actualTotalFromTotalR.d, 6);
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        weight_conflict: true,
        conflict_reason: `cartons[] summed weight (${derivedKg} kg) conflicts with actual_weight_kg_total (${suppliedKg} kg).`,
        a4_applied: {
          weight_conflict: true,
          derived_actual_weight_kg_total: derivedKg,
          supplied_actual_weight_kg_total: suppliedKg,
        },
      };
    }
  }

  if (cartonsActualTotalR && actualTotalFromPerUnitR &&
    !totalsConsistentWithinDecimalPrecision(actual_weight_kg_per_unit, unitsR, null, cartonsActualTotalR)) {
    const derivedKg = roundBigRat(cartonsActualTotalR.n, cartonsActualTotalR.d, 6);
    const suppliedKg = roundBigRat(actualTotalFromPerUnitR.n, actualTotalFromPerUnitR.d, 6);
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: `cartons[] summed weight (${derivedKg} kg) conflicts with actual_weight_kg_per_unit * order_units (${suppliedKg} kg).`,
      a4_applied: {
        weight_conflict: true,
        derived_actual_weight_kg_total: derivedKg,
        supplied_actual_weight_kg_total: suppliedKg,
      },
    };
  }

  let actualTotalR = actualTotalFromTotalR ?? actualTotalFromPerUnitR ?? cartonsActualTotalR;
  let actualWeightDerivedFromCartons = Boolean(!actualTotalFromTotalR && !actualTotalFromPerUnitR && cartonsActualTotalR);

  if (hasWeightPerCarton) {
    if (canMultiplyUniformCartons) {
      const countR = toBigRat(effectiveUniformCartonCount);
      const cartonDerivedTotalR = mulBigRat(toBigRat(weight_per_carton_kg), countR);
      if (actualTotalR) {
        const refTotalNum = hasActualTotal ? actual_weight_kg_total : null;
        if (!totalsConsistentWithinDecimalPrecision(weight_per_carton_kg, countR, refTotalNum, actualTotalR)) {
          const derivedKg = roundBigRat(cartonDerivedTotalR.n, cartonDerivedTotalR.d, 6);
          const suppliedKg = roundBigRat(actualTotalR.n, actualTotalR.d, 6);
          return {
            amount_usd: null,
            exact_usd_rational: null,
            cny_derivation: null,
            weight_conflict: true,
            conflict_reason: `weight_per_carton_kg (${weight_per_carton_kg} kg) * carton_count (${effectiveUniformCartonCount}) = ${derivedKg} kg conflicts with supplied total actual weight (${suppliedKg} kg).`,
            a4_applied: {
              weight_conflict: true,
              weight_per_carton_kg,
              carton_count: effectiveUniformCartonCount,
              derived_actual_weight_kg_total: derivedKg,
              supplied_actual_weight_kg_total: suppliedKg,
            },
          };
        }
      } else {
        actualTotalR = cartonDerivedTotalR;
        actualWeightDerivedFromCartons = true;
      }
    } else if (actualTotalR === null) {
      if (declaredChargeableTotalR === null) {
        const missingReason = isMixedCartons
          ? 'actual_weight_kg_total_required_for_mixed_cartons'
          : (hasPartialLastCarton
            ? 'actual_weight_kg_total_required_for_partial_carton'
            : 'carton_count_required_for_carton_weight');
        return {
          amount_usd: null,
          exact_usd_rational: null,
          cny_derivation: null,
          missing_surcharge_quote: true,
          a4_applied: {
            ...(isMixedCartons ? { mixed_cartons: true } : {}),
            ...(hasPartialLastCarton ? { partial_last_carton: true } : {}),
            missing_surcharge_quote: missingReason,
          },
        };
      }
      const minFullCartons = hasPartialLastCarton
        ? Math.max(1, Math.floor(effectiveUnits / headhaul.units_per_carton))
        : 1;
      const minGuaranteedActualR = mulBigRat(toBigRat(weight_per_carton_kg), toBigRat(minFullCartons));
      if (ratCmp(declaredChargeableTotalR, minGuaranteedActualR) < 0) {
        const minKg = roundBigRat(minGuaranteedActualR.n, minGuaranteedActualR.d, 6);
        const declKg = roundBigRat(declaredChargeableTotalR.n, declaredChargeableTotalR.d, 6);
        return {
          amount_usd: null,
          exact_usd_rational: null,
          cny_derivation: null,
          weight_conflict: true,
          conflict_reason: `Minimum full-carton actual weight (${minFullCartons} * ${weight_per_carton_kg} kg = ${minKg} kg) exceeds supplied chargeable_kg_per_unit * order_units (${declKg} kg).`,
          a4_applied: {
            weight_conflict: true,
            derived_actual_weight_kg_total: minKg,
            supplied_actual_weight_kg_total: declKg,
          },
        };
      }
    }
  }

  let volTotalR = cartonsVolTotalR;
  if (hasValidCartonCm) {
    if (isMixedCartons) {
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        missing_surcharge_quote: true,
        a4_applied: {
          mixed_cartons: true,
          volumetric_dimensions_present: true,
          missing_surcharge_quote: 'uniform_carton_cm_invalid_for_mixed_cartons',
        },
      };
    }
    if ((cartonCountInt === null && headhaul.single_carton_verified !== true && !(effectiveUnits === 1)) || hasPartialLastCarton) {
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        missing_surcharge_quote: true,
        a4_applied: {
          volumetric_dimensions_present: true,
          ...(hasPartialLastCarton ? { partial_last_carton: true } : {}),
          missing_surcharge_quote: hasPartialLastCarton
            ? 'explicit_carton_count_required_for_partial_carton_volumetric_weight'
            : 'carton_count_required_for_volumetric_weight',
        },
      };
    }
    const volOneR = divBigRat(
      mulBigRat(mulBigRat(toBigRat(normalizedCartonCm[0]), toBigRat(normalizedCartonCm[1])), toBigRat(normalizedCartonCm[2])),
      divisorR,
    );
    volTotalR = mulBigRat(volOneR, toBigRat(cartonCountInt ?? 1));
  }

  // If declared chargeable_kg_per_unit is supplied alongside actual weight, chargeable cannot be lower than actual weight.
  if (declaredChargeableTotalR && actualTotalR && ratCmp(actualTotalR, declaredChargeableTotalR) > 0 &&
    !totalsConsistentWithinDecimalPrecision(kgPerUnit, unitsR, hasActualTotal ? actual_weight_kg_total : null, actualTotalR)) {
    const actualKg = roundBigRat(actualTotalR.n, actualTotalR.d, 6);
    const declKg = roundBigRat(declaredChargeableTotalR.n, declaredChargeableTotalR.d, 6);
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      weight_conflict: true,
      conflict_reason: `Actual shipment weight (${actualKg} kg) exceeds supplied chargeable_kg_per_unit * order_units (${declKg} kg).`,
      a4_applied: {
        weight_conflict: true,
        derived_actual_weight_kg_total: actualKg,
        supplied_actual_weight_kg_total: declKg,
      },
    };
  }

  let rawTotalKgR = actualTotalR ?? volTotalR ?? declaredChargeableTotalR;
  if (!rawTotalKgR) {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }
  let volumetricExceedsActual = false;
  if (actualTotalR && volTotalR && ratCmp(volTotalR, actualTotalR) > 0) {
    rawTotalKgR = volTotalR;
    volumetricExceedsActual = true;
  }
  if (declaredChargeableTotalR && ratCmp(declaredChargeableTotalR, rawTotalKgR) > 0) {
    rawTotalKgR = declaredChargeableTotalR;
  }

  const hasExplicitPositiveSmallBatchRate = Boolean(
    (finite(min_shipment_billable_kg) && min_shipment_billable_kg > 0) ||
    (finite(small_shipment_surcharge_cny_per_kg) && small_shipment_surcharge_cny_per_kg > 0) ||
    (finite(small_carton_surcharge_cny_per_carton) && small_carton_surcharge_cny_per_carton > 0) ||
    (finite(small_carton_surcharge_cny_per_kg) && small_carton_surcharge_cny_per_kg > 0),
  );
  // ADR-0001: Explicit steady_state_replenishment: true NEVER applies 100-set test-batch penalties even when
  // carrier tariff metadata fields are present; explicit false ALWAYS enforces small-batch A4 rules;
  // omitted defaults to steady-state unless caller explicitly supplies positive small-batch surcharge rates.
  const applySmallBatchPenalties = resolvedSteadyStateFlag === true
    ? false
    : (resolvedSteadyStateFlag === false ? true : hasExplicitPositiveSmallBatchRate);
  const applyA4Rules = Boolean(isR59 || hasA4Extras);
  const minBillVal = finite(min_shipment_billable_kg) && min_shipment_billable_kg >= 0
    ? min_shipment_billable_kg
    : (applySmallBatchPenalties ? BUSINESS_THRESHOLDS.freight_a4_min_shipment_billable_kg : 0);
  const minBillR = toBigRat(minBillVal);
  const below10kgMinBill = applySmallBatchPenalties && minBillVal > 0 && ratCmp(rawTotalKgR, minBillR) < 0;
  const billedTotalKgR = below10kgMinBill ? minBillR : rawTotalKgR;

  const smallShipThreshKg = finite(small_shipment_threshold_kg) && small_shipment_threshold_kg > 0
    ? small_shipment_threshold_kg
    : BUSINESS_THRESHOLDS.freight_a4_small_shipment_threshold_kg;
  const smallShipThreshR = toBigRat(smallShipThreshKg);
  const rawBelow50kg = ratCmp(rawTotalKgR, smallShipThreshR) < 0;
  const below50kg = applySmallBatchPenalties && rawBelow50kg;
  const hasExplicitA4ShipmentInputs = Boolean(
    isR59 ||
    actual_weight_kg_total !== undefined ||
    actual_weight_kg_per_unit !== undefined ||
    weight_per_carton_kg !== undefined ||
    carton_count !== undefined ||
    hasValidCartonCm ||
    small_shipment_threshold_kg !== undefined ||
    small_carton_threshold_kg !== undefined,
  );
  if (
    below50kg &&
    hasExplicitA4ShipmentInputs &&
    headhaul.small_shipment_surcharge_exempt !== true &&
    !(finite(small_shipment_surcharge_cny_per_kg) && small_shipment_surcharge_cny_per_kg >= 0)
  ) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      missing_surcharge_quote: true,
      a4_applied: {
        below_50kg_small_shipment: true,
        missing_surcharge_quote: 'small_shipment_surcharge_cny_per_kg',
      },
    };
  }
  const smallShipRateR = below50kg && finite(small_shipment_surcharge_cny_per_kg) && small_shipment_surcharge_cny_per_kg > 0
    ? toBigRat(small_shipment_surcharge_cny_per_kg)
    : { n: 0n, d: 1n };

  let perCartonKgR = null;
  if (cartonsMinPerCartonKgR !== null) {
    perCartonKgR = cartonsMinPerCartonKgR;
  } else if (finite(weight_per_carton_kg) && weight_per_carton_kg > 0) {
    perCartonKgR = toBigRat(weight_per_carton_kg);
  } else if (actualTotalR && cartonCountInt !== null) {
    perCartonKgR = divBigRat(actualTotalR, toBigRat(cartonCountInt));
  }
  const smallCartonThreshR = toBigRat(
    finite(small_carton_threshold_kg) && small_carton_threshold_kg > 0
      ? small_carton_threshold_kg
      : BUSINESS_THRESHOLDS.freight_a4_min_carton_weight_kg,
  );
  const below8kgCarton = applySmallBatchPenalties && perCartonKgR !== null && ratCmp(perCartonKgR, smallCartonThreshR) < 0;
  const hasExplicitSmallCartonRate =
    (finite(small_carton_surcharge_cny_per_carton) && small_carton_surcharge_cny_per_carton >= 0) ||
    (finite(small_carton_surcharge_cny_per_kg) && small_carton_surcharge_cny_per_kg >= 0);
  if (below8kgCarton && headhaul.small_carton_surcharge_exempt !== true && !hasExplicitSmallCartonRate) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      missing_surcharge_quote: true,
      a4_applied: {
        below_8kg_carton: true,
        missing_surcharge_quote: 'small_carton_surcharge_cny_per_carton_or_per_kg',
      },
    };
  }
  if (
    below8kgCarton &&
    headhaul.small_carton_surcharge_exempt !== true &&
    finite(small_carton_surcharge_cny_per_carton) &&
    small_carton_surcharge_cny_per_carton > 0 &&
    cartonCountInt === null
  ) {
    return {
      amount_usd: null,
      exact_usd_rational: null,
      cny_derivation: null,
      missing_surcharge_quote: true,
      a4_applied: {
        below_8kg_carton: true,
        missing_surcharge_quote: 'carton_count_required_for_per_carton_surcharge',
      },
    };
  }
  const smallCartonPerCartonCnyR = below8kgCarton && cartonCountInt !== null &&
    finite(small_carton_surcharge_cny_per_carton) && small_carton_surcharge_cny_per_carton > 0
    ? mulBigRat(toBigRat(cartonCountInt), toBigRat(small_carton_surcharge_cny_per_carton))
    : { n: 0n, d: 1n };
  const smallCartonPerKgRateR = below8kgCarton && finite(small_carton_surcharge_cny_per_kg) && small_carton_surcharge_cny_per_kg > 0
    ? toBigRat(small_carton_surcharge_cny_per_kg)
    : { n: 0n, d: 1n };

  const combinedPerKgRateR = addBigRat(
    addBigRat(toBigRat(rate), toBigRat(surcharge)),
    addBigRat(smallShipRateR, smallCartonPerKgRateR),
  );
  const totalBaseAndSurchargeCnyR = addBigRat(
    mulBigRat(billedTotalKgR, combinedPerKgRateR),
    smallCartonPerCartonCnyR,
  );
  const totalBondCnyR = hasPerKgBond
    ? mulBigRat(billedTotalKgR, toBigRat(bondPerKg))
    : toBigRat(bondPerShipment);
  const totalShipmentCnyR = addBigRat(totalBaseAndSurchargeCnyR, totalBondCnyR);
  const cnyPerUnitR = divBigRat(totalShipmentCnyR, unitsR);
  if (cnyPerUnitR.n <= 0n) {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }
  const usdPerUnitR = divBigRat(cnyPerUnitR, toBigRat(fx));
  const kgPerUnitR = divBigRat(billedTotalKgR, unitsR);
  const effKgPerUnit = roundBigRat(kgPerUnitR.n, kgPerUnitR.d, 10);

  // ADR-0001 advisory replenishment quantity to reach >=50 kg per destination warehouse on ultra-light / slow SKUs
  let replenishment50kgPerDestUnits = null;
  let advisoryReplenishmentNote = null;
  if (kgPerUnitR.n > 0n) {
    const minDestKgR = toBigRat(BUSINESS_THRESHOLDS.freight_a4_small_shipment_threshold_kg);
    const ratioR = divBigRat(minDestKgR, kgPerUnitR);
    const unitsBig = ceilDivBig(ratioR.n, ratioR.d);
    if (unitsBig > 0n && unitsBig <= BigInt(Number.MAX_SAFE_INTEGER)) {
      replenishment50kgPerDestUnits = Number(unitsBig);
      const fiveDestCount = BigInt(BUSINESS_THRESHOLDS.amazon_optimized_min_cartons);
      const fiveDestUnits = unitsBig * fiveDestCount;
      const isUsWestScope = scopeStr === 'us_west_single' || scopeStr === 'single_warehouse' || scopeStr === 'us_west_only';
      const multiWarehousePerDestBelow50kg = !applySmallBatchPenalties &&
        !isUsWestScope &&
        rate >= BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg &&
        effectiveUnits !== null &&
        fiveDestUnits > BigInt(effectiveUnits);
      if (rawBelow50kg || multiWarehousePerDestBelow50kg || (effectiveUnits !== null && replenishment50kgPerDestUnits > effectiveUnits)) {
        advisoryReplenishmentNote = `稳态多仓补货提示：单仓达到 50 kg 起运量约需 ${replenishment50kgPerDestUnits} 套/仓（若按 ${BUSINESS_THRESHOLDS.amazon_optimized_min_cartons} 仓分仓约需 ${fiveDestUnits.toString()} 套）；当前按稳态补货测算未扣 100 套试单小票/小箱罚金，超轻或慢动 SKU 下单前请核对稳态补货节奏与实际分仓费率。`;
      }
    }
  }

  const cnyDerivation = {
    fx,
    ...(hasKgPerUnit ? { chargeable_kg_per_unit: kgPerUnit } : {}),
    rate_cny_per_kg: rate,
    surcharge_cny_per_kg: surcharge,
    ...(effectiveUnits !== null ? { order_units: effectiveUnits } : {}),
    ...(hasPerKgBond ? { bond_cny_per_kg: bondPerKg } : { bond_cny_per_shipment: bondPerShipment, order_units: effectiveUnits }),
    ...(headhaul.destination_scope ? { destination_scope: headhaul.destination_scope } : {}),
    ...(headhaul.headhaul_destination_scope ? { headhaul_destination_scope: headhaul.headhaul_destination_scope } : {}),
    ...(resolvedSteadyStateFlag === false ? { steady_state_replenishment: false } : {}),
    ...(resolvedSteadyStateFlag === true ? { steady_state_replenishment: true } : {}),
    ...((applyA4Rules && (below10kgMinBill || below50kg || below8kgCarton || volumetricExceedsActual || hasA4Extras)) ? {
      order_units: effectiveUnits,
      ...(hasValidCartonCm ? { carton_cm } : {}),
      ...(cartonCountInt !== null ? { carton_count: cartonCountInt } : {}),
      ...(hasUnitsPerCarton ? { units_per_carton: headhaul.units_per_carton } : {}),
      ...(hasCartonsArray ? { cartons: headhaul.cartons } : {}),
      ...(finite(actual_weight_kg_total) ? { actual_weight_kg_total } : {}),
      ...(finite(actual_weight_kg_per_unit) ? { actual_weight_kg_per_unit } : {}),
      ...(finite(weight_per_carton_kg) ? { weight_per_carton_kg } : {}),
      ...(headhaul.mixed_cartons === true ? { mixed_cartons: true } : {}),
      ...(headhaul.identical_cartons === false ? { identical_cartons: false } : {}),
      ...(headhaul.uniform_cartons === false ? { uniform_cartons: false } : {}),
      ...(headhaul.single_carton_verified === true ? { single_carton_verified: true } : {}),
      ...(headhaul.small_shipment_surcharge_exempt === true ? { small_shipment_surcharge_exempt: true } : {}),
      ...(headhaul.small_carton_surcharge_exempt === true ? { small_carton_surcharge_exempt: true } : {}),
      ...(finite(volumetric_divisor) ? { volumetric_divisor } : {}),
      ...(minBillVal > 0 ? { min_shipment_billable_kg: minBillVal } : {}),
      ...(finite(small_shipment_threshold_kg) ? { small_shipment_threshold_kg } : {}),
      ...(finite(small_shipment_surcharge_cny_per_kg) ? { small_shipment_surcharge_cny_per_kg } : {}),
      ...(finite(small_carton_threshold_kg) ? { small_carton_threshold_kg } : {}),
      ...(finite(small_carton_surcharge_cny_per_carton) ? { small_carton_surcharge_cny_per_carton } : {}),
      ...(finite(small_carton_surcharge_cny_per_kg) ? { small_carton_surcharge_cny_per_kg } : {}),
    } : {}),
  };

  return {
    amount_usd: roundBigRat(usdPerUnitR.n, usdPerUnitR.d, 10),
    exact_usd_rational: usdPerUnitR,
    cny_derivation: isR58 ? cnyDerivation : null,
    ...(advisoryReplenishmentNote ? { advisory_replenishment_note: advisoryReplenishmentNote } : {}),
    a4_applied: {
      steady_state_replenishment: !applySmallBatchPenalties,
      below_10kg_min_bill: below10kgMinBill,
      below_50kg_small_shipment: below50kg,
      below_8kg_outer_carton: below8kgCarton,
      volumetric_exceeds_actual: volumetricExceedsActual,
      actual_weight_derived_from_cartons: actualWeightDerivedFromCartons,
      actual_weight_kg_total: actualTotalR ? roundBigRat(actualTotalR.n, actualTotalR.d, 6) : null,
      volumetric_weight_kg_total: volTotalR ? roundBigRat(volTotalR.n, volTotalR.d, 6) : null,
      billed_total_kg: roundBigRat(billedTotalKgR.n, billedTotalKgR.d, 6),
      effective_billed_kg_per_unit: effKgPerUnit,
      ...(replenishment50kgPerDestUnits !== null ? { replenishment_50kg_per_destination_units: replenishment50kgPerDestUnits } : {}),
      ...(advisoryReplenishmentNote ? { advisory_replenishment_note: advisoryReplenishmentNote } : {}),
    },
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
  return classifyPhysicalSizeTier2027(dims);
}

function classifyPhysicalSizeTier2027(dims) {
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
  multi_destination_headhaul_verified = undefined,
  steady_state_replenishment = true,
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
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
  const usWestSingleBlocked = isUsWestSingleWarehouseHeadhaul({
    headhaul,
    headhaul_rate_cny_per_kg,
    headhaul_destination_scope,
  });
  const optVerified = isAmazonOptimizedPlacementVerified2027({
    identical_cartons_count: effOptCartons,
    multi_destination_headhaul_verified,
    steady_state_replenishment,
    headhaul,
    headhaul_rate_cny_per_kg,
    headhaul_destination_scope,
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
          reason: usWestSingleBlocked
            ? `Standard-size amazon_optimized ($0 placement) cannot pair with pure US-West single-warehouse headhaul (< ¥${BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg}/kg or us_west_single); use Kaiqi nationwide multi-warehouse >= ¥${BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg}/kg.`
            : 'Standard-size amazon_optimized ($0 placement) requires verified nationwide multi-warehouse headhaul (and >= 5 identical cartons when steady_state_replenishment is false); sensitivity-only otherwise.',
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
        steady_state_replenishment: steady_state_replenishment !== false,
        identical_cartons_count: effOptCartons,
        multi_destination_headhaul_verified: true,
        note: 'Steady-state Amazon-optimized splits incur $0 placement fee (paired with nationwide multi-warehouse sea-truck headhaul >= ¥10.0/kg).',
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
        reason: usWestSingleBlocked
          ? `Bulky amazon_optimized ($0 placement) cannot pair with pure US-West single-warehouse headhaul (< ¥${BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg}/kg or us_west_single); use Kaiqi nationwide multi-warehouse >= ¥${BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg}/kg.`
          : 'Bulky amazon_optimized ($0 placement) requires verified nationwide multi-warehouse headhaul (and >= 5 identical cartons when steady_state_replenishment is false); sensitivity-only otherwise.',
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
      steady_state_replenishment: steady_state_replenishment !== false,
      identical_cartons_count: effOptCartons,
      multi_destination_headhaul_verified: true,
      note: 'Steady-state Amazon-optimized splits incur $0 placement fee (paired with nationwide multi-warehouse sea-truck headhaul >= ¥10.0/kg).',
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

  const feeLookup = resolve2027PerReturnFeeFromTier(cls, { isApparelOrShoes, allowAll2027Tiers: true });
  const perReturnFee = feeLookup.per_return_fee_usd;
  const extraWholeLbs = feeLookup.extra_lb_steps;
  if (perReturnFee === null) {
    return { status: 'needs_calculator_verification', reason: feeLookup.reason ?? 'Unlisted returns-processing weight bracket.' };
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

const US_WEST_SINGLE_SCOPES = new Set(['us_west_single', 'single_warehouse', 'us_west_only']);
const NATIONWIDE_MULTI_SCOPES = new Set(['nationwide_multi_warehouse', 'multi_warehouse', 'nationwide', 'kaiqi_nationwide']);

export function isUsWestSingleWarehouseHeadhaul({
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
  extra_headhauls = null,
} = {}) {
  const specs = [headhaul, ...(Array.isArray(extra_headhauls) ? extra_headhauls : [])].filter(s => s && typeof s === 'object');
  const scopes = [
    headhaul_destination_scope,
    ...specs.flatMap(s => [s.destination_scope, s.headhaul_destination_scope]),
  ].map(s => String(s ?? '').trim().toLowerCase()).filter(Boolean);
  if (scopes.some(s => US_WEST_SINGLE_SCOPES.has(s))) return true;
  const rates = [
    headhaul_rate_cny_per_kg,
    ...specs.flatMap(s => [s.rate_cny_per_kg, s.headhaul_rate_cny_per_kg]),
  ].filter(v => finite(v));
  return rates.some(r => r < BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg);
}

export function isNationwideMultiWarehouseHeadhaul({
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
  multi_destination_headhaul_verified = undefined,
  extra_headhauls = null,
} = {}) {
  if (multi_destination_headhaul_verified === false) return false;
  if (isUsWestSingleWarehouseHeadhaul({ headhaul, headhaul_rate_cny_per_kg, headhaul_destination_scope, extra_headhauls })) {
    return false;
  }
  if (multi_destination_headhaul_verified === true) return true;
  const specs = [headhaul, ...(Array.isArray(extra_headhauls) ? extra_headhauls : [])].filter(s => s && typeof s === 'object');
  const scopes = [
    headhaul_destination_scope,
    ...specs.flatMap(s => [s.destination_scope, s.headhaul_destination_scope]),
  ].map(s => String(s ?? '').trim().toLowerCase()).filter(Boolean);
  if (scopes.some(s => NATIONWIDE_MULTI_SCOPES.has(s))) {
    return true;
  }
  const rates = [
    headhaul_rate_cny_per_kg,
    ...specs.flatMap(s => [s.rate_cny_per_kg, s.headhaul_rate_cny_per_kg]),
  ].filter(v => finite(v));
  return rates.some(r => r >= BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg);
}

export function isAmazonOptimizedPlacementVerified2027({
  identical_cartons_count = null,
  multi_destination_headhaul_verified = undefined,
  steady_state_replenishment = true,
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
  extra_headhauls = null,
} = {}) {
  if (!isNationwideMultiWarehouseHeadhaul({
    headhaul,
    headhaul_rate_cny_per_kg,
    headhaul_destination_scope,
    multi_destination_headhaul_verified,
    extra_headhauls,
  })) {
    return false;
  }
  if (steady_state_replenishment === false) {
    return Number.isInteger(identical_cartons_count) &&
      identical_cartons_count >= BUSINESS_THRESHOLDS.amazon_optimized_min_cartons;
  }
  return true;
}

export function lookupPlacementFee2027({
  pkg,
  inbound_window = null,
  split_option = 'minimal_west_conservative',
  is_dangerous_goods,
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = undefined,
  steady_state_replenishment = true,
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
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
    const usWestSingleBlocked = isUsWestSingleWarehouseHeadhaul({
      headhaul,
      headhaul_rate_cny_per_kg,
      headhaul_destination_scope,
    });
    const optVerified = isAmazonOptimizedPlacementVerified2027({
      identical_cartons_count: effOptCartons,
      multi_destination_headhaul_verified,
      steady_state_replenishment,
      headhaul,
      headhaul_rate_cny_per_kg,
      headhaul_destination_scope,
    });
    if (!optVerified) {
      return {
        status: 'sensitivity_only',
        version: FBA_2027_METADATA.version,
        size_tier: cls.size_tier,
        split_option,
        range_usd: [0, 0],
        selected_usd: 0,
        reason: usWestSingleBlocked
          ? `Standard-size amazon_optimized ($0 placement) cannot pair with pure US-West single-warehouse headhaul (< ¥${BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg}/kg or us_west_single); use Kaiqi nationwide multi-warehouse >= ¥${BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg}/kg.`
          : 'Standard-size amazon_optimized ($0 placement) requires verified nationwide multi-warehouse headhaul (and >= 5 identical cartons when steady_state_replenishment is false); sensitivity-only otherwise.',
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
      steady_state_replenishment: steady_state_replenishment !== false,
      identical_cartons_count: effOptCartons,
      multi_destination_headhaul_verified: true,
      note: 'Steady-state Amazon-optimized splits incur $0 placement fee (paired with nationwide multi-warehouse sea-truck headhaul >= ¥10.0/kg).',
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
  const feeLookup = resolve2027PerReturnFeeFromTier(cls, { isApparelOrShoes: false, allowAll2027Tiers: false });
  const perReturnFee = feeLookup.per_return_fee_usd;
  if (perReturnFee === null) return { status: 'needs_calculator_verification', reason: feeLookup.reason ?? 'Unlisted returns-processing weight bracket.' };
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
  profile_revision = 59,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = undefined,
  steady_state_replenishment = true,
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
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
  const classifiedForPlacement = (active.pkg ?? pkg) ? classifySizeTier2027(active.pkg ?? pkg) : null;
  const isOversizeTier = classifiedForPlacement?.tier_family === 'oversize' || /oversize/i.test(sizeTier);
  const overrideUsWestBlocked = isUsWestSingleWarehouseHeadhaul({
    headhaul: active.headhaul ?? null,
    headhaul_rate_cny_per_kg: active.headhaul_rate_cny_per_kg ?? null,
    headhaul_destination_scope: active.headhaul_destination_scope ?? null,
    extra_headhauls: [headhaul],
  }) || isUsWestSingleWarehouseHeadhaul({
    headhaul,
    headhaul_rate_cny_per_kg,
    headhaul_destination_scope,
  });
  const overrideMultiDest = active.multi_destination_headhaul_verified === false || multi_destination_headhaul_verified === false
    ? false
    : (active.multi_destination_headhaul_verified ?? multi_destination_headhaul_verified);
  const overrideSteadyState = active.steady_state_replenishment === false || steady_state_replenishment === false
    ? false
    : (active.steady_state_replenishment ?? steady_state_replenishment);
  const unverifiedZeroPlacementOverride = Boolean(
    !isOversizeTier &&
    (profile_revision ?? 59) >= 59 &&
    round(active.placement_usd) === 0 &&
    (overrideUsWestBlocked || !isAmazonOptimizedPlacementVerified2027({
      identical_cartons_count: active.identical_cartons_count ?? identical_cartons_count,
      multi_destination_headhaul_verified: overrideMultiDest,
      steady_state_replenishment: overrideSteadyState,
      headhaul: active.headhaul ?? headhaul,
      headhaul_rate_cny_per_kg: active.headhaul_rate_cny_per_kg ?? headhaul_rate_cny_per_kg,
      headhaul_destination_scope: active.headhaul_destination_scope ?? headhaul_destination_scope,
    })),
  );
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
    placement: unverifiedZeroPlacementOverride
      ? {
        status: 'sensitivity_only',
        selected_usd: 0,
        range_usd: [0, 0],
        split_option: 'amazon_optimized',
        reason: 'Standard/Bulky $0 inbound placement in calculator_verified_override requires >= 5 identical cartons and verified multi-destination headhaul (sensitivity_only).',
      }
      : {
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
  headhaul = null,
  headhaul_usd,
  order_units = undefined,
  collection_rate,
  other_applicable_usd = 0,
  other_payee = 'external',
  sales_window,
  storage_window,
  inbound_window,
  average_inventory_days = 45,
  placement_usd = null,
  placement_split_option = undefined,
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = undefined,
  steady_state_replenishment = true,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
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
  const explicitScalarHeadhaulUsd = finite(headhaul_usd) && headhaul_usd >= 0 ? headhaul_usd : null;
  let resolvedHeadhaulUsd = null;
  let resolvedHeadhaulExactRat = null;
  let resolvedHeadhaulA4 = null;
  let resolvedHeadhaulRate = null;
  const headhaulObj = headhaul && typeof headhaul === 'object' && !Array.isArray(headhaul) ? headhaul : null;
  const structuredHeadhaulObj = isStructuredHeadhaulSpec(headhaulObj) ? headhaulObj : null;
  if (structuredHeadhaulObj) {
    if (!finite(fx_cny_per_usd) || fx_cny_per_usd <= 0) {
      return { status: 'needs_calculator_verification', reason: 'Valid fx_cny_per_usd > 0 is required to verify structured headhaul inputs.' };
    }
    if (order_units !== undefined && order_units !== null &&
      structuredHeadhaulObj.order_units !== undefined && structuredHeadhaulObj.order_units !== null &&
      order_units !== structuredHeadhaulObj.order_units) {
      return {
        status: 'needs_calculator_verification',
        reason: `Conflicting order_units (${order_units}) vs headhaul.order_units (${structuredHeadhaulObj.order_units}).`,
      };
    }
    const effOrderUnits = finite(order_units) && order_units > 0
      ? order_units
      : (finite(structuredHeadhaulObj.order_units) && structuredHeadhaulObj.order_units > 0 ? structuredHeadhaulObj.order_units : 100);
    const a4Res = computeHeadhaulWithA4Rules(structuredHeadhaulObj, fx_cny_per_usd, effOrderUnits, {
      isR58: (profile_revision ?? 59) >= 58,
      isR59: (profile_revision ?? 59) >= 59,
      steadyStateReplenishment: steady_state_replenishment,
    });
    if (a4Res.weight_conflict) {
      return {
        status: 'needs_calculator_verification',
        reason: a4Res.conflict_reason ?? 'Conflicting carton weight and total actual weight in headhaul inputs.',
        weight_conflict: true,
        a4_applied: a4Res.a4_applied,
      };
    }
    if (a4Res.missing_surcharge_quote) {
      return {
        status: 'needs_calculator_verification',
        reason: `Headhaul Freight A4 requires ${a4Res.a4_applied?.missing_surcharge_quote ?? 'surcharge quote'}.`,
        a4_applied: a4Res.a4_applied,
      };
    }
    if (!finite(a4Res.amount_usd)) {
      return { status: 'needs_calculator_verification', reason: 'Supplied structured Freight A4 headhaul inputs are incomplete or invalid.' };
    }
    if (explicitScalarHeadhaulUsd !== null && Math.abs(explicitScalarHeadhaulUsd - a4Res.amount_usd) > 0.005) {
      return {
        status: 'needs_calculator_verification',
        reason: `Supplied headhaul_usd ($${explicitScalarHeadhaulUsd}) conflicts with recomputed structured headhaul ($${a4Res.amount_usd}).`,
        a4_applied: a4Res.a4_applied,
      };
    }
    if (finite(structuredHeadhaulObj.amount_usd) && Math.abs(structuredHeadhaulObj.amount_usd - a4Res.amount_usd) > 0.005) {
      return {
        status: 'needs_calculator_verification',
        reason: `Supplied headhaul.amount_usd ($${structuredHeadhaulObj.amount_usd}) conflicts with recomputed structured headhaul ($${a4Res.amount_usd}).`,
        a4_applied: a4Res.a4_applied,
      };
    }
    resolvedHeadhaulUsd = a4Res.amount_usd;
    resolvedHeadhaulExactRat = a4Res.exact_usd_rational ?? null;
    resolvedHeadhaulA4 = a4Res.a4_applied ?? null;
    resolvedHeadhaulRate = finite(a4Res.cny_derivation?.rate_cny_per_kg) ? a4Res.cny_derivation.rate_cny_per_kg : null;
  } else if (explicitScalarHeadhaulUsd !== null) {
    resolvedHeadhaulUsd = explicitScalarHeadhaulUsd;
  } else if (headhaul !== null && headhaul !== undefined) {
    if (finite(headhaul) && headhaul >= 0) {
      resolvedHeadhaulUsd = headhaul;
    } else if (typeof headhaul === 'object') {
      if (finite(headhaul.amount_usd) && headhaul.amount_usd >= 0) {
        resolvedHeadhaulUsd = headhaul.amount_usd;
      } else if (finite(headhaul.usd_per_unit) && headhaul.usd_per_unit >= 0 && (headhaul.bond_included === true || finite(headhaul.bond_usd_per_unit))) {
        resolvedHeadhaulUsd = headhaul.usd_per_unit + (headhaul.bond_included === true ? 0 : headhaul.bond_usd_per_unit);
      }
    }
  }
  const effectivePriceUsd = pricing.net_effective_price_usd;
  if (!finite(effectivePriceUsd) || effectivePriceUsd <= 0 || !finite(fx_cny_per_usd) || fx_cny_per_usd <= 0 ||
    !finite(refund_fraction) || refund_fraction < 0 || refund_fraction >= 1 ||
    !finite(resolvedHeadhaulUsd) || resolvedHeadhaulUsd < 0 ||
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

  const effectivePlacementHeadhaulScope = headhaul_destination_scope ?? headhaulObj?.destination_scope ?? headhaulObj?.headhaul_destination_scope ?? null;
  const effectivePlacementHeadhaulRate = finite(headhaul_rate_cny_per_kg)
    ? headhaul_rate_cny_per_kg
    : (finite(headhaulObj?.rate_cny_per_kg) ? headhaulObj.rate_cny_per_kg : resolvedHeadhaulRate);
  if (headhaulObj) {
    const innerRate = finite(headhaulObj.rate_cny_per_kg) ? headhaulObj.rate_cny_per_kg : resolvedHeadhaulRate;
    if (finite(headhaul_rate_cny_per_kg) && innerRate !== null && Math.abs(headhaul_rate_cny_per_kg - innerRate) > 1e-6) {
      return {
        status: 'needs_calculator_verification',
        reason: `Conflicting outer headhaul_rate_cny_per_kg (${headhaul_rate_cny_per_kg}) vs headhaul.rate_cny_per_kg (${innerRate}).`,
      };
    }
    const outerScopeNorm = String(headhaul_destination_scope ?? '').trim().toLowerCase();
    const innerScopeNorm = String(headhaulObj.destination_scope ?? headhaulObj.headhaul_destination_scope ?? '').trim().toLowerCase();
    if (outerScopeNorm && innerScopeNorm && outerScopeNorm !== innerScopeNorm) {
      return {
        status: 'needs_calculator_verification',
        reason: `Conflicting outer headhaul_destination_scope (${outerScopeNorm}) vs headhaul.destination_scope (${innerScopeNorm}).`,
      };
    }
  }
  const effectiveSteadyState = steady_state_replenishment !== false && headhaulObj?.steady_state_replenishment !== false;
  const placementNationwideOk = isNationwideMultiWarehouseHeadhaul({
    headhaul: headhaulObj,
    headhaul_rate_cny_per_kg: effectivePlacementHeadhaulRate,
    headhaul_destination_scope: effectivePlacementHeadhaulScope,
    multi_destination_headhaul_verified,
  });
  const effectivePlacementSplitOption = placement_split_option ??
    (effectiveSteadyState && placementNationwideOk ? 'amazon_optimized' : 'minimal_west_conservative');

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
      profile_revision,
      identical_cartons_count,
      multi_destination_headhaul_verified,
      steady_state_replenishment: effectiveSteadyState,
      headhaul: headhaulObj,
      headhaul_rate_cny_per_kg: effectivePlacementHeadhaulRate,
      headhaul_destination_scope: effectivePlacementHeadhaulScope,
    });
    if (!ov.valid) {
      return { status: 'needs_calculator_verification', reason: ov.reason };
    }
    overrideReceipt = ov.receipt;
    fulfillment = ov.fulfillment;
    storage = ov.storage;
    placement = ov.placement;
    if (placement.status !== 'verified') return placement;
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
      (effectivePlacementSplitOption === 'amazon_optimized' || round(placement_usd) === 0) &&
      !isAmazonOptimizedPlacementVerified2027({
        identical_cartons_count,
        multi_destination_headhaul_verified,
        steady_state_replenishment: effectiveSteadyState,
        headhaul: headhaulObj,
        headhaul_rate_cny_per_kg: effectivePlacementHeadhaulRate,
        headhaul_destination_scope: effectivePlacementHeadhaulScope,
      }),
    );
    placement = finite(placement_usd) && placement_usd >= 0 && !requiresVerifiedOptForExplicitPlacement
      ? { status: 'verified', selected_usd: round(placement_usd), range_usd: [round(placement_usd), round(placement_usd)], split_option: 'explicit' }
      : (useUnified2027Tiers
        ? lookupBulkyPlacementFee2027({
          pkg,
          inbound_window: effectiveInboundWindow,
          split_option: requiresVerifiedOptForExplicitPlacement ? 'amazon_optimized' : effectivePlacementSplitOption,
          is_apparel,
          is_dangerous_goods,
          carton_count,
          identical_cartons_count,
          multi_destination_headhaul_verified,
          steady_state_replenishment: effectiveSteadyState,
          headhaul: headhaulObj,
          headhaul_rate_cny_per_kg: effectivePlacementHeadhaulRate,
          headhaul_destination_scope: effectivePlacementHeadhaulScope,
        })
        : lookupPlacementFee2027({
          pkg,
          inbound_window: effectiveInboundWindow,
          split_option: requiresVerifiedOptForExplicitPlacement ? 'amazon_optimized' : effectivePlacementSplitOption,
          is_dangerous_goods,
          carton_count,
          identical_cartons_count,
          multi_destination_headhaul_verified,
          steady_state_replenishment: effectiveSteadyState,
          headhaul: headhaulObj,
          headhaul_rate_cny_per_kg: effectivePlacementHeadhaulRate,
          headhaul_destination_scope: effectivePlacementHeadhaulScope,
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
    resolvedHeadhaulUsd +
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
    referral.net_usd,
    fulfillment.total_usd,
    placement.selected_usd,
    storage.per_unit_usd,
    returns.expected_fee_per_shipped_unit_usd,
    extraCouponFeeUsd,
    payout.collection_usd,
    other_applicable_usd,
  ];
  const aR = exactCostComponents.reduce(
    (acc, v) => ratAdd(acc, toRat(v)),
    resolvedHeadhaulExactRat ?? toRat(resolvedHeadhaulUsd),
  );
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
      headhaul: {
        amount_usd: round(resolvedHeadhaulUsd),
        ...(resolvedHeadhaulA4 ? { a4_applied: resolvedHeadhaulA4 } : {}),
      },
      headhaul_usd: round(resolvedHeadhaulUsd),
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
 * 按 1688 成本算保底定价 (Forward breakeven selling price solver: 1688 bare-goods or landed cost ->
 * exact minimum US retail price achieving >= margin_floor across Amazon US 2027 $10/$50 FBA cliffs).
 * Uses exact cent-level binary search inside each monotonic price band with BigInt zero_browser_fail verification.
 */
export function solveMinPriceForMargin2027({
  landed_domestic_cny = null,
  landed_domestic_usd = null,
  landed_domestic_quote = null,
  bare_goods_cny = null,
  bare_goods_usd = null,
  bare_goods_quote = null,
  bare_goods_screening = undefined,
  fx_cny_per_usd: scenarioFx,
  margin_floor = 0.30,
  min_retail_price_usd = 29.99,
  low_price_eligible = true,
  max_search_price_usd = 100000,
  ...gate1aParams
} = {}) {
  const effectiveQuote = bare_goods_quote ?? landed_domestic_quote;
  const effectiveCny = bare_goods_cny ?? landed_domestic_cny;
  const effectiveUsd = bare_goods_usd ?? landed_domestic_usd;
  if (bare_goods_quote !== null && landed_domestic_quote !== null) {
    return { status: 'needs_calculator_verification', reason: 'Provide either bare_goods_quote or landed_domestic_quote, not both.' };
  }
  if (bare_goods_cny !== null && landed_domestic_cny !== null) {
    return { status: 'needs_calculator_verification', reason: 'Provide either bare_goods_cny or landed_domestic_cny, not both.' };
  }
  if (bare_goods_usd !== null && landed_domestic_usd !== null) {
    return { status: 'needs_calculator_verification', reason: 'Provide either bare_goods_usd or landed_domestic_usd, not both.' };
  }
  const quoteInputs = effectiveQuote === null
    ? null
    : bindSourcingQuotePricingInputs(effectiveQuote, { ...gate1aParams, fx_cny_per_usd: scenarioFx });
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
  const hasCny = effectiveCny !== null && effectiveCny !== undefined;
  const hasUsd = effectiveUsd !== null && effectiveUsd !== undefined;
  if (!hasCny && !hasUsd && effectiveQuote === null) {
    return { status: 'needs_calculator_verification', reason: 'A 1688 bare-goods/landed quote or cost amount is required.' };
  }
  if ((hasCny && (!finite(effectiveCny) || effectiveCny < 0)) ||
    (hasUsd && (!finite(effectiveUsd) || effectiveUsd < 0))) {
    return { status: 'needs_calculator_verification', reason: 'bare_goods / landed_domestic CNY and USD amounts must be nonnegative finite numbers.' };
  }
  let landedCnyRat = hasCny ? toBigRat(effectiveCny) : null;
  let isBareGoodsBasis = Boolean(
    bare_goods_screening === true ||
    bare_goods_quote !== null ||
    bare_goods_cny !== null ||
    bare_goods_usd !== null ||
    effectiveQuote?.pricing_basis === 'bare_goods_1688' ||
    effectiveQuote?.bare_goods_screening === true,
  );
  let domesticFreightAdvisoryCnyTotal = finite(gate1aParams.domestic_freight_advisory_cny_total) && gate1aParams.domestic_freight_advisory_cny_total >= 0
    ? gate1aParams.domestic_freight_advisory_cny_total
    : (finite(effectiveQuote?.domestic_freight_advisory_cny_total) && effectiveQuote.domestic_freight_advisory_cny_total >= 0
      ? effectiveQuote.domestic_freight_advisory_cny_total
      : null);
  if (effectiveQuote !== null) {
    const { goods_cny_total, domestic_freight_cny_total, actual_sets } = effectiveQuote;
    const hasQuoteDomFreight = domestic_freight_cny_total !== undefined && domestic_freight_cny_total !== null;
    const quoteDisallowedStatus = typeof effectiveQuote.quote_status === 'string' &&
      effectiveQuote.quote_status !== 'verified' &&
      effectiveQuote.quote_status !== 'superseded_uncompetitive';
    const quoteGoodsPromo = effectiveQuote.goods_first_order_promotion === true || effectiveQuote.goods_first_order_promotion === 1;
    const quoteFreightPromo = !isBareGoodsBasis && hasQuoteDomFreight &&
      (effectiveQuote.freight_first_order_promotion === true || effectiveQuote.freight_first_order_promotion === 1);
    if (quoteDisallowedStatus || quoteGoodsPromo || quoteFreightPromo) {
      return {
        status: 'needs_calculator_verification',
        calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
        cost_basis: (!hasQuoteDomFreight || isBareGoodsBasis) ? 'bare_goods_1688' : 'landed_domestic_explicit',
        ...((!hasQuoteDomFreight || isBareGoodsBasis) ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
        reason: 'Promotional, rejected, expired, or incomplete 1688 quote cannot produce a verified repeat-order floor price.',
      };
    }
    if (hasCny || hasUsd || !finite(goods_cny_total) || goods_cny_total <= 0 ||
      (hasQuoteDomFreight && (!finite(domestic_freight_cny_total) || domestic_freight_cny_total < 0)) ||
      !Number.isSafeInteger(actual_sets) || actual_sets < 100) {
      return {
        status: 'needs_calculator_verification',
        calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
        reason: 'Quote requires positive goods, at least 100 actual sets, optional nonnegative domestic freight, and no separate landed cost.',
      };
    }
    if (bare_goods_screening === false && !hasQuoteDomFreight) {
      return {
        status: 'pending_domestic_freight',
        calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
        cost_basis: 'landed_domestic_explicit',
        reason: 'Explicit landed-freight floor-price check (bare_goods_screening: false) requires domestic_freight_cny_total.',
      };
    }
    if (!hasQuoteDomFreight || isBareGoodsBasis) {
      isBareGoodsBasis = true;
      if (hasQuoteDomFreight && domesticFreightAdvisoryCnyTotal === null) {
        domesticFreightAdvisoryCnyTotal = domestic_freight_cny_total;
      }
      landedCnyRat = divBigRat(toBigRat(goods_cny_total), toBigRat(actual_sets));
    } else {
      landedCnyRat = divBigRat(addBigRat(toBigRat(goods_cny_total), toBigRat(domestic_freight_cny_total)), toBigRat(actual_sets));
    }
  }
  const fxRat = toBigRat(fx_cny_per_usd);
  const derivedUsdRat = landedCnyRat ? divBigRat(landedCnyRat, fxRat) : null;
  const derivedUsd = derivedUsdRat ? roundBigRat(derivedUsdRat.n, derivedUsdRat.d, 10) : null;
  if (hasCny && hasUsd && Math.abs(derivedUsd - effectiveUsd) > 1e-4) {
    return {
      status: 'needs_calculator_verification',
      calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
      cost_basis: isBareGoodsBasis ? 'bare_goods_1688' : 'landed_domestic_explicit',
      ...(isBareGoodsBasis ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
      reason: 'Supplied cost USD conflicts with CNY / fx_cny_per_usd.',
    };
  }
  const landedUsdRat = hasUsd ? toBigRat(effectiveUsd) : derivedUsdRat;
  const landedUsd = hasUsd ? effectiveUsd : derivedUsd;
  landedCnyRat ??= mulBigRat(landedUsdRat, fxRat);
  const landedCny = hasCny ? effectiveCny : roundBigRat(landedCnyRat.n, landedCnyRat.d, 10);
  const costBasis = isBareGoodsBasis ? 'bare_goods_1688' : 'landed_domestic_explicit';
  const solverMeta = {
    calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
    cost_basis: costBasis,
    ...(isBareGoodsBasis ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
    ...(domesticFreightAdvisoryCnyTotal !== null ? { domestic_freight_advisory_cny_total: domesticFreightAdvisoryCnyTotal } : {}),
  };

  const solverCouponUsd = finite(gate1aParams.ongoing_coupon_usd) && gate1aParams.ongoing_coupon_usd > 0 ? gate1aParams.ongoing_coupon_usd : 0;
  const solverCouponPct = finite(gate1aParams.ongoing_coupon_pct) && gate1aParams.ongoing_coupon_pct > 0 && gate1aParams.ongoing_coupon_pct < 1 ? gate1aParams.ongoing_coupon_pct : 0;
  const solverHasPrime = (finite(gate1aParams.prime_exclusive_discount_usd) && gate1aParams.prime_exclusive_discount_usd > 0) ||
    (finite(gate1aParams.prime_exclusive_discount_pct) && gate1aParams.prime_exclusive_discount_pct > 0);
  const solverCouponActive = Boolean((gate1aParams.profile_revision ?? 59) >= 59 && !solverHasPrime && (solverCouponUsd > 0 || solverCouponPct > 0));

  const resolvedSolverOrderUnits = finite(gate1aParams.order_units) && gate1aParams.order_units > 0
    ? gate1aParams.order_units
    : (Number.isSafeInteger(effectiveQuote?.actual_sets) && effectiveQuote.actual_sets >= 100
      ? effectiveQuote.actual_sets
      : undefined);
  const cleanParams = {
    ...gate1aParams,
    ...(resolvedSolverOrderUnits !== undefined ? { order_units: resolvedSolverOrderUnits } : {}),
    ...(quoteInputs ? { pkg: quoteInputs.pkg } : {}),
    fx_cny_per_usd,
    margin_floor,
  };
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
    return { status: 'needs_calculator_verification', ...solverMeta, reason: 'Maximum search price exceeds the safe cent range.' };
  }
  if (maxCents < floorCents) {
    return { status: 'infeasible', ...solverMeta, landed_domestic_usd: landedUsd, landed_domestic_cny: landedCny, margin_floor, reason: 'No whole-cent retail price lies within [min_retail_price_usd, max_search_price_usd].' };
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
        ...solverMeta,
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
            ...solverMeta,
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
        ...solverMeta,
        landed_domestic_usd: landedUsd,
        landed_domestic_cny: landedCny,
        margin_floor,
        reason: anyUnverified.res.reason || `Fee schedule verification required for band "${anyUnverified.key}".`,
      };
    }
    return {
      status: 'infeasible',
      ...solverMeta,
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
  const solverAdvisoryReplenishmentNote = winningEst?.components?.headhaul?.a4_applied?.advisory_replenishment_note ?? null;

  return {
    status: 'verified',
    calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
    cost_basis: costBasis,
    ...(isBareGoodsBasis ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
    ...(domesticFreightAdvisoryCnyTotal !== null ? { domestic_freight_advisory_cny_total: domesticFreightAdvisoryCnyTotal } : {}),
    ...(solverAdvisoryReplenishmentNote ? { advisory_replenishment_note: solverAdvisoryReplenishmentNote } : {}),
    ...(quoteInputs ? { pricing_input_basis: quoteInputs.pricing_input_basis } : {}),
    version: winningEst.version ?? FBA_2027_METADATA.version,
    landed_domestic_usd: landedUsd,
    landed_domestic_cny: landedCny,
    ...(isBareGoodsBasis ? { bare_goods_usd: landedUsd, bare_goods_cny: landedCny } : {}),
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
    const keepId = v => (typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : null));
    const facId = keepId(line.factory_id);
    const supId = keepId(line.supplier_id);
    const sellerMemberId = keepId(line.seller_member_id);
    const companyName = keepId(line.company_name);
    const shopUrl = keepId(line.shop_url);
    return {
      ...(typeof line.component_id === 'string' && line.component_id.trim() ? { component_id: line.component_id.trim() } : {}),
      ...(facId !== null ? { factory_id: facId } : {}),
      ...(supId !== null ? { supplier_id: supId } : {}),
      ...(sellerMemberId !== null ? { seller_member_id: sellerMemberId } : {}),
      ...(companyName !== null ? { company_name: companyName } : {}),
      ...(shopUrl !== null ? { shop_url: shopUrl } : {}),
      ...(line.single_factory_complete_kit === false ? { single_factory_complete_kit: false } : {}),
      ...(line.bare_part_only === true ? { bare_part_only: true } : {}),
      ...(line.bare_parts_incomplete === true ? { bare_parts_incomplete: true } : {}),
      ...(line.requires_cross_factory_packaging === true ? { requires_cross_factory_packaging: true } : {}),
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

  const effProfileRev = profile_revision ?? profileRevision ?? 59;
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
    per_complete_set_goods_cny: perCompleteRat ? roundBigRat(perCompleteRat.n, perCompleteRat.d, 10) : null,
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
  bare_goods_usd = null,
  bare_goods_cny = null,
  fx_cny_per_usd = undefined,
  refund_fraction = undefined,
  physical_return_fraction = null,
  fee_category = null,
  return_threshold = null,
  referral_terms = undefined,
  headhaul_usd = undefined,
  headhaul = null,
  headhaul_rate_cny_per_kg = null,
  headhaul_destination_scope = null,
  steady_state_replenishment = true,
  recompute_headhaul_fn = null,
  collection_rate = undefined,
  other_applicable_usd = 0,
  other_payee = 'external',
  sales_window = FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  storage_window = FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  inbound_window = FBA_2027_DEFAULT_INBOUND_WINDOW,
  average_inventory_days = 45,
  placement_split_option = undefined,
  carton_count = null,
  identical_cartons_count = null,
  multi_destination_headhaul_verified = undefined,
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
  const effDomesticUsd = landed_domestic_usd ?? bare_goods_usd;
  const effDomesticCny = landed_domestic_cny ?? bare_goods_cny;
  const hasUsd = effDomesticUsd !== null && effDomesticUsd !== undefined;
  const hasCny = effDomesticCny !== null && effDomesticCny !== undefined;
  if (!hasUsd && !hasCny) {
    return { eligible: false, reason: 'landed_domestic_usd/bare_goods_usd or landed_domestic_cny/bare_goods_cny is required.' };
  }
  if ((hasUsd && (!finite(effDomesticUsd) || effDomesticUsd < 0)) ||
    (hasCny && (!finite(effDomesticCny) || effDomesticCny < 0))) {
    return { eligible: false, reason: 'Domestic/bare-goods cost must be a nonnegative finite number.' };
  }
  const landedUsdRat = hasUsd ? toBigRat(effDomesticUsd) : divBigRat(toBigRat(effDomesticCny), toBigRat(fx_cny_per_usd));
  const landedUsd = roundBigRat(landedUsdRat.n, landedUsdRat.d, 10);
  const resolvedHeadhaulRate = finite(headhaul_rate_cny_per_kg)
    ? headhaul_rate_cny_per_kg
    : (headhaul && typeof headhaul === 'object' && finite(headhaul.rate_cny_per_kg) ? headhaul.rate_cny_per_kg : null);
  const resolvedHeadhaulScope = headhaul_destination_scope ??
    (headhaul && typeof headhaul === 'object' ? (headhaul.destination_scope ?? headhaul.headhaul_destination_scope ?? null) : null);
  const resolvedSteadyState = steady_state_replenishment !== false &&
    !(headhaul && typeof headhaul === 'object' && headhaul.steady_state_replenishment === false);

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
    headhaul_rate_cny_per_kg: resolvedHeadhaulRate,
    headhaul_destination_scope: resolvedHeadhaulScope,
    steady_state_replenishment: resolvedSteadyState,
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

