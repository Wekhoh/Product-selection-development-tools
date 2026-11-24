// Validate declared source applicability. This module does not fetch or invent rates.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const windowValid = value => date(value?.from) && date(value?.through) && value.from <= value.through;
const FEE_WINDOWS = Object.freeze({ referral: 'sales', fulfillment: 'sales', placement: 'inbound',
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

export function gcdBig(a, b) {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x === 0n ? 1n : x;
}

export function normBigRat(n, d = 1n) {
  if (d === 0n) throw new RangeError('Zero denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  const sign = d < 0n ? -1n : 1n;
  const nn = sign * n, dd = sign * d;
  const g = gcdBig(nn, dd);
  return { n: nn / g, d: dd / g };
}

export function toBigRat(value) {
  const [mantissa, expPart = '0'] = value.toString().toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const [intPart, fracPart = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = BigInt(intPart + fracPart);
  const exp = Number(expPart) - fracPart.length;
  return exp >= 0
    ? normBigRat(sign * digits * (10n ** BigInt(exp)), 1n)
    : normBigRat(sign * digits, 10n ** BigInt(-exp));
}

export function addBigRat(a, b) {
  return normBigRat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function mulBigRat(a, b) {
  return normBigRat(a.n * b.n, a.d * b.d);
}

export function divBigRat(a, b) {
  return normBigRat(a.n * b.d, a.d * b.n);
}

export function ratCmp(a, b) {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function ratMax(a, b) {
  return ratCmp(a, b) >= 0 ? a : b;
}

export function roundBigRat(n, d, decimals = 10) {
  if (d === 0n) throw new RangeError('Zero denominator');
  const sign = (n < 0n) !== (d < 0n) ? -1n : 1n;
  const absN = n < 0n ? -n : n;
  const absD = d < 0n ? -d : d;
  const scale = 10n ** BigInt(decimals);
  const scaled = (absN * scale * 2n + absD) / (2n * absD);
  return Number(sign * scaled) / Number(scale);
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

const SMALL_STD_RETURN_FEE_OZ = Object.freeze([
  { max_oz: 2, fee: 1.78 }, { max_oz: 4, fee: 1.84 }, { max_oz: 6, fee: 1.90 }, { max_oz: 8, fee: 1.96 },
  { max_oz: 10, fee: 2.02 }, { max_oz: 12, fee: 2.08 }, { max_oz: 14, fee: 2.14 }, { max_oz: 16, fee: 2.21 },
]);

const LARGE_STD_RETURN_FEE_LB = Object.freeze([
  { max_lb: 0.25, fee: 2.36 }, { max_lb: 0.50, fee: 2.70 }, { max_lb: 0.75, fee: 3.05 }, { max_lb: 1.00, fee: 3.39 },
  { max_lb: 1.25, fee: 3.70 }, { max_lb: 1.50, fee: 4.01 }, { max_lb: 1.75, fee: 4.32 }, { max_lb: 2.00, fee: 4.63 },
  { max_lb: 2.25, fee: 4.66 }, { max_lb: 2.50, fee: 4.68 }, { max_lb: 2.75, fee: 4.71 }, { max_lb: 3.00, fee: 4.73 },
]);

const SMALL_STD_APPAREL_RETURN_FEE_OZ = Object.freeze([
  { max_oz: 4, fee: 1.65 }, { max_oz: 8, fee: 1.75 }, { max_oz: 12, fee: 1.85 }, { max_oz: 16, fee: 1.95 },
]);

const LARGE_STD_APPAREL_RETURN_FEE_LB = Object.freeze([
  { max_lb: 0.25, fee: 2.04 }, { max_lb: 0.50, fee: 2.12 }, { max_lb: 0.75, fee: 2.19 }, { max_lb: 1.00, fee: 2.27 },
  { max_lb: 1.50, fee: 2.62 }, { max_lb: 2.00, fee: 2.98 }, { max_lb: 2.50, fee: 3.33 }, { max_lb: 3.00, fee: 3.69 },
]);

export function lookupVerified2027PerReturnFee(pkg, { isApparelOrShoes = false, allowAll2027Tiers = false } = {}) {
  const dims = resolvePackageDimsRat(pkg);
  if (!dims || !dims.wtLbRat || !dims.shipLbRat) return null;
  const { s1Rat, s2Rat, s3Rat, wtLbRat, ozRat, shipLbRat } = dims;
  const isSmall = ratCmp(wtLbRat, { n: 1n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 15n, d: 1n }) <= 0 &&
    ratCmp(s2Rat, { n: 12n, d: 1n }) <= 0 &&
    ratCmp(s3Rat, { n: 3n, d: 4n }) <= 0;
  if (isSmall) {
    if (isApparelOrShoes) {
      return allowAll2027Tiers
        ? (SMALL_STD_APPAREL_RETURN_FEE_OZ.find(r => ratCmp(ozRat, toBigRat(r.max_oz)) <= 0)?.fee ?? null)
        : null;
    }
    return SMALL_STD_RETURN_FEE_OZ.find(r => ratCmp(ozRat, toBigRat(r.max_oz)) <= 0)?.fee ?? null;
  }
  const isLarge = ratCmp(wtLbRat, { n: 20n, d: 1n }) <= 0 &&
    ratCmp(shipLbRat, { n: 20n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 18n, d: 1n }) <= 0 &&
    ratCmp(s2Rat, { n: 14n, d: 1n }) <= 0 &&
    ratCmp(s3Rat, { n: 8n, d: 1n }) <= 0;
  if (isLarge) {
    if (isApparelOrShoes) {
      if (!allowAll2027Tiers) return null;
      if (ratCmp(shipLbRat, { n: 3n, d: 1n }) <= 0) {
        return LARGE_STD_APPAREL_RETURN_FEE_LB.find(r => ratCmp(shipLbRat, toBigRat(r.max_lb)) <= 0)?.fee ?? null;
      }
      const num2 = 2n * (shipLbRat.n - 3n * shipLbRat.d);
      const halfSteps = num2 <= 0n ? 0 : Number((num2 + shipLbRat.d - 1n) / shipLbRat.d);
      return Math.round((3.89 + halfSteps * 0.10 + Number.EPSILON) * 100) / 100;
    }
    if (ratCmp(shipLbRat, { n: 3n, d: 1n }) <= 0) {
      return LARGE_STD_RETURN_FEE_LB.find(r => ratCmp(shipLbRat, toBigRat(r.max_lb)) <= 0)?.fee ?? null;
    }
    const num4 = 4n * (shipLbRat.n - 3n * shipLbRat.d);
    const steps = num4 <= 0n ? 0 : Number((num4 + shipLbRat.d - 1n) / shipLbRat.d);
    return Math.round((5.00 + steps * 0.05 + Number.EPSILON) * 100) / 100;
  }
  if (!allowAll2027Tiers) return null;

  const bulkyS2Rat = ratCmp(s2Rat, { n: 2n, d: 1n }) >= 0 ? s2Rat : { n: 2n, d: 1n };
  const bulkyS3Rat = ratCmp(s3Rat, { n: 2n, d: 1n }) >= 0 ? s3Rat : { n: 2n, d: 1n };
  const bulkyCubicInRat = mulBigRat(mulBigRat(s1Rat, bulkyS2Rat), bulkyS3Rat);
  const bulkyDimLbRat = divBigRat(bulkyCubicInRat, { n: 139n, d: 1n });
  const bulkyShipLbRat = ratCmp(bulkyDimLbRat, wtLbRat) >= 0 ? bulkyDimLbRat : wtLbRat;
  const girthPlusLenRat = addBigRat(s1Rat, mulBigRat({ n: 2n, d: 1n }, addBigRat(s2Rat, s3Rat)));
  const ceilWholeExcess = (r, baseLb) => {
    const excess = r.n - BigInt(baseLb) * r.d;
    return excess > 0n ? Number((excess + r.d - 1n) / r.d) : 0;
  };

  // Official 2027 Bulky 4 tiers (<= 59 x 33 x 33 in, L+G <= 130 in, unit & shipping weight <= 50 lb): $6.74 + $0.32/lb over 1 lb
  const fitsAnyBulky =
    ratCmp(wtLbRat, { n: 50n, d: 1n }) <= 0 &&
    ratCmp(bulkyShipLbRat, { n: 50n, d: 1n }) <= 0 &&
    ratCmp(girthPlusLenRat, { n: 130n, d: 1n }) <= 0 && (
      (ratCmp(s1Rat, { n: 28n, d: 1n }) <= 0 && ratCmp(s2Rat, { n: 24n, d: 1n }) <= 0 && ratCmp(s3Rat, { n: 20n, d: 1n }) <= 0) ||
      (ratCmp(s1Rat, { n: 37n, d: 1n }) <= 0 && ratCmp(s2Rat, { n: 28n, d: 1n }) <= 0 && ratCmp(s3Rat, { n: 20n, d: 1n }) <= 0) ||
      (ratCmp(s1Rat, { n: 52n, d: 1n }) <= 0 && ratCmp(s2Rat, { n: 28n, d: 1n }) <= 0 && ratCmp(s3Rat, { n: 28n, d: 1n }) <= 0) ||
      (ratCmp(s1Rat, { n: 59n, d: 1n }) <= 0 && ratCmp(s2Rat, { n: 33n, d: 1n }) <= 0 && ratCmp(s3Rat, { n: 33n, d: 1n }) <= 0)
    );
  if (fitsAnyBulky) {
    return Math.round((6.74 + ceilWholeExcess(bulkyShipLbRat, 1) * 0.32 + Number.EPSILON) * 100) / 100;
  }

  // Official 2027 Oversize 6 tiers returns processing (GZGEQLTM3RZXUV6T)
  if (ratCmp(wtLbRat, { n: 50n, d: 1n }) <= 0 && ratCmp(bulkyShipLbRat, { n: 50n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 72n, d: 1n }) <= 0 && ratCmp(girthPlusLenRat, { n: 130n, d: 1n }) <= 0) {
    return Math.round((26.33 + ceilWholeExcess(bulkyShipLbRat, 1) * 0.38 + Number.EPSILON) * 100) / 100;
  }
  if (ratCmp(wtLbRat, { n: 70n, d: 1n }) <= 0 && ratCmp(bulkyShipLbRat, { n: 70n, d: 1n }) <= 0 &&
    ratCmp(s1Rat, { n: 78n, d: 1n }) <= 0 && ratCmp(girthPlusLenRat, { n: 130n, d: 1n }) <= 0) {
    return Math.round((40.12 + ceilWholeExcess(bulkyShipLbRat, 51) * 0.75 + Number.EPSILON) * 100) / 100;
  }
  if (ratCmp(wtLbRat, { n: 150n, d: 1n }) <= 0 && ratCmp(bulkyShipLbRat, { n: 150n, d: 1n }) <= 0) {
    return Math.round((52.45 + ceilWholeExcess(bulkyShipLbRat, 71) * 0.75 + Number.EPSILON) * 100) / 100;
  }
  return Math.round((157.35 + ceilWholeExcess(wtLbRat, 151) * 0.19 + Number.EPSILON) * 100) / 100;
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
  const validOrderUnits = value => isR58 ? (Number.isSafeInteger(value) && value >= 100) : value === 100;
  const orderUnitsMismatch = isR58 && procLine && domLine && procLine.status !== 'pending' && domLine.status !== 'pending' &&
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
        (domLine && domLine.status !== 'pending' && sv !== domLine.order_units)) {
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
    if (!evidenced(line.evidence)) add(line.id, 'missing_cost_evidence', 'The cost needs registered source evidence, including any explicit zero or deferral.');
    if (line.id === 'domestic_freight' && line.status === 'deferred') {
      add(line.id, 'domestic_quote_required', 'The current >=100-purchased-unit scope requires a domestic-delivery quote; the historical deferral cannot be reused.');
    } else if (strictR57 && (line.id === 'procurement' || line.id === 'domestic_freight') &&
      line.status !== 'pending' && (line.first_order_promotion !== false || !validOrderUnits(line.order_units) ||
        orderUnitsMismatch || invalidSourceUnits || invalidSourcePromo || invalidSkuLines)) {
      add(line.id, 'domestic_quote_required', isR58
        ? 'Revision 58 requires explicit integer order_units >= 100 (matching across procurement, domestic delivery, source_inputs, and any sku_lines[]) plus first_order_promotion: false.'
        : 'Revision 57 requires explicit order_units: 100 and first_order_promotion: false on both regular repeat-order procurement and domestic delivery.');
    }
    if (isR59 && line.id === 'headhaul' && line.status !== 'pending') {
      const rawHhSpec = line.cny_derivation
        ?? (input.headhaul && typeof input.headhaul === 'object' ? input.headhaul : null)
        ?? (input.source_inputs?.headhaul && typeof input.source_inputs.headhaul === 'object' ? input.source_inputs.headhaul : null);
      if (rawHhSpec && typeof rawHhSpec === 'object' && rawHhSpec.rate_cny_per_kg !== undefined) {
        const effFx = rawHhSpec.fx ?? rawHhSpec.fx_cny_per_usd ?? input.fx_cny_per_usd ?? input.source_inputs?.fx_cny_per_usd;
        const effUnits = rawHhSpec.order_units ?? input.order_units ?? procLine?.order_units ?? null;
        const hhCalc = computeHeadhaulWithA4Rules(rawHhSpec, effFx, effUnits, { isR58: true, isR59: true });
        if (hhCalc.missing_surcharge_quote) {
          add('headhaul', 'headhaul_surcharge_quote_required', `Freight A4 surcharge triggered (${hhCalc.a4_applied?.missing_surcharge_quote ?? 'small shipment / carton'}) without an explicit surcharge quote.`);
        } else if (!hhCalc.exact_usd_rational) {
          add('headhaul', 'invalid_headhaul_tariff', 'Supplied Freight A4 headhaul tariff inputs are incomplete or invalid.');
        } else {
          const expectedHhUsd = roundBigRat(hhCalc.exact_usd_rational.n, hhCalc.exact_usd_rational.d, 10);
          if (finite(line.amount_usd) && Math.abs(line.amount_usd - expectedHhUsd) > 0.005) {
            add('headhaul', 'headhaul_tariff_mismatch', `Supplied headhaul amount_usd (${line.amount_usd}) conflicts with recomputed Freight A4 tariff (${expectedHhUsd}).`);
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
  return { status: issues.length ? 'needs_evidence' : 'validated', context: context ?? null, issues };
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

/**
 * Shared exact BigInt rational headhaul calculator incorporating freight-forwarder A4 rules:
 *  - Volumetric weight: carton_cm[0]*carton_cm[1]*carton_cm[2] / volumetric_divisor (default 6000) * carton_count
 *  - Minimum shipment billable weight: <10 kg billed at 10 kg minimum (enabled in r59 or when A4 fields supplied)
 *  - <50 kg small-shipment surcharge (`small_shipment_surcharge_cny_per_kg`)
 *  - <8 kg outer-carton surcharge (`small_carton_surcharge_cny_per_carton` / `small_carton_surcharge_cny_per_kg`)
 *  - Base rate + product surcharge + per-kg or per-shipment carrier bond
 */
export function computeHeadhaulWithA4Rules(headhaul, fx, orderUnits, { isR58 = false, isR59 = false } = {}) {
  if (!headhaul || typeof headhaul !== 'object') {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }
  const {
    chargeable_kg_per_unit: kgPerUnit,
    rate_cny_per_kg: rate,
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

  const hasA4Extras = A4_HEADHAUL_EXTRA_KEYS.some(k => headhaul[k] !== undefined && headhaul[k] !== null);
  const hasPerKgBond = finite(bondPerKg) && bondPerKg >= 0;
  const hasShipmentBond = finite(bondPerShipment) && bondPerShipment >= 0;
  const effectiveUnits = finite(orderUnits) && orderUnits > 0
    ? orderUnits
    : (finite(headhaul.order_units) && headhaul.order_units > 0 ? headhaul.order_units : null);
  const needsUnits = !isR58 || hasShipmentBond || hasA4Extras || isR59;

  const hasValidCartonCm = Array.isArray(carton_cm) && carton_cm.length === 3 && carton_cm.every(v => finite(v) && v > 0);
  const canDeriveWeight = (finite(kgPerUnit) && kgPerUnit > 0) ||
    (finite(actual_weight_kg_per_unit) && actual_weight_kg_per_unit > 0) ||
    (finite(actual_weight_kg_total) && actual_weight_kg_total > 0) ||
    hasValidCartonCm;

  if (!canDeriveWeight || ![rate, surcharge].every(v => finite(v) && v >= 0) ||
    (!hasPerKgBond && !hasShipmentBond) || (hasPerKgBond && hasShipmentBond) ||
    !finite(fx) || fx <= 0 || (needsUnits && (!finite(effectiveUnits) || effectiveUnits <= 0))) {
    return { amount_usd: null, exact_usd_rational: null, cny_derivation: null, a4_applied: null };
  }

  const unitsR = effectiveUnits !== null ? toBigRat(effectiveUnits) : { n: 100n, d: 1n };
  const divisorVal = finite(volumetric_divisor) && volumetric_divisor > 0 ? volumetric_divisor : 6000;
  const cartonCountInt = Number.isSafeInteger(carton_count) && carton_count > 0 ? carton_count : null;

  let actualTotalR = null;
  if (finite(actual_weight_kg_total) && actual_weight_kg_total > 0) {
    actualTotalR = toBigRat(actual_weight_kg_total);
  } else if (finite(actual_weight_kg_per_unit) && actual_weight_kg_per_unit > 0) {
    actualTotalR = mulBigRat(toBigRat(actual_weight_kg_per_unit), unitsR);
  } else if (finite(kgPerUnit) && kgPerUnit > 0) {
    actualTotalR = mulBigRat(toBigRat(kgPerUnit), unitsR);
  }

  let volTotalR = null;
  if (hasValidCartonCm) {
    if (isR59 && cartonCountInt === null && headhaul.single_carton_verified !== true) {
      return {
        amount_usd: null,
        exact_usd_rational: null,
        cny_derivation: null,
        missing_surcharge_quote: true,
        a4_applied: {
          volumetric_dimensions_present: true,
          missing_surcharge_quote: 'carton_count_required_for_volumetric_weight',
        },
      };
    }
    const volOneR = divBigRat(
      mulBigRat(mulBigRat(toBigRat(carton_cm[0]), toBigRat(carton_cm[1])), toBigRat(carton_cm[2])),
      toBigRat(divisorVal),
    );
    volTotalR = mulBigRat(volOneR, toBigRat(cartonCountInt ?? 1));
  }

  let rawTotalKgR = actualTotalR ?? volTotalR;
  let volumetricExceedsActual = false;
  if (actualTotalR && volTotalR && ratCmp(volTotalR, actualTotalR) > 0) {
    rawTotalKgR = volTotalR;
    volumetricExceedsActual = true;
  }

  const applyA4Rules = Boolean(isR59 || hasA4Extras);
  const minBillVal = finite(min_shipment_billable_kg) && min_shipment_billable_kg >= 0
    ? min_shipment_billable_kg
    : (applyA4Rules ? 10 : 0);
  const minBillR = toBigRat(minBillVal);
  const below10kgMinBill = minBillVal > 0 && ratCmp(rawTotalKgR, minBillR) < 0;
  const billedTotalKgR = below10kgMinBill ? minBillR : rawTotalKgR;

  const smallShipThreshR = toBigRat(finite(small_shipment_threshold_kg) && small_shipment_threshold_kg > 0 ? small_shipment_threshold_kg : 50);
  const below50kg = applyA4Rules && ratCmp(rawTotalKgR, smallShipThreshR) < 0;
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
  if (finite(weight_per_carton_kg) && weight_per_carton_kg > 0) {
    perCartonKgR = toBigRat(weight_per_carton_kg);
  } else if (actualTotalR && cartonCountInt !== null) {
    perCartonKgR = divBigRat(actualTotalR, toBigRat(cartonCountInt));
  }
  const smallCartonThreshR = toBigRat(finite(small_carton_threshold_kg) && small_carton_threshold_kg > 0 ? small_carton_threshold_kg : 8);
  const below8kgCarton = applyA4Rules && perCartonKgR !== null && ratCmp(perCartonKgR, smallCartonThreshR) < 0;
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
  const effKgPerUnit = roundBigRat(divBigRat(billedTotalKgR, unitsR).n, divBigRat(billedTotalKgR, unitsR).d, 10);

  const cnyDerivation = {
    fx,
    chargeable_kg_per_unit: finite(kgPerUnit) && kgPerUnit > 0 ? kgPerUnit : effKgPerUnit,
    rate_cny_per_kg: rate,
    surcharge_cny_per_kg: surcharge,
    ...(hasPerKgBond ? { bond_cny_per_kg: bondPerKg } : { bond_cny_per_shipment: bondPerShipment, order_units: effectiveUnits }),
    ...((applyA4Rules && (below10kgMinBill || below50kg || below8kgCarton || volumetricExceedsActual || hasA4Extras)) ? {
      order_units: effectiveUnits,
      ...(hasValidCartonCm ? { carton_cm } : {}),
      ...(cartonCountInt !== null ? { carton_count: cartonCountInt } : {}),
      ...(finite(actual_weight_kg_total) ? { actual_weight_kg_total } : {}),
      ...(finite(actual_weight_kg_per_unit) ? { actual_weight_kg_per_unit } : {}),
      ...(finite(weight_per_carton_kg) ? { weight_per_carton_kg } : {}),
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
    a4_applied: {
      below_10kg_min_bill: below10kgMinBill,
      below_50kg_small_shipment: below50kg,
      below_8kg_outer_carton: below8kgCarton,
      volumetric_exceeds_actual: volumetricExceedsActual,
      billed_total_kg: roundBigRat(billedTotalKgR.n, billedTotalKgR.d, 6),
      effective_billed_kg_per_unit: effKgPerUnit,
    },
  };
}
