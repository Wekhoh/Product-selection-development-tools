// Deterministic Gate-1 early screener wrapping calculateEconomics before 21-item quota spend.
// Missing required costs or fee terms remain unknown (pending) rather than silently defaulting.
// Revision 58 (profile_revision >= 58) enforces explicit operating period, three date windows,
// tri-state rights/date checks, physical vs refund return separation, carton/MOQ sku_lines[],
// and landed domestic procurement caps while preserving exact revision 57 replay.

import { calculateEconomics, netReferral, collectionFromDisbursement, ledgerMeetsMarginFloor } from './economics.mjs';
import {
  resolveConsistentNumeric,
  resolveConsistentText,
  resolveConsistentBoolean,
  resolveConsistentPkgWeightLb,
  resolveConsistentSkuLines,
  resolveUniquePackageByRef,
  resolvePackageDimsRat,
  isOfficial2027ScheduleWindowValid,
  lookupVerified2027ReturnThreshold,
  lookupVerified2027PerReturnFee,
  toBigRat,
  gcdBig,
  addBigRat,
  mulBigRat,
  divBigRat,
  ratCmp,
  roundBigRat,
} from './fee-basis.mjs';
import { computeOrderPlan, computeNegotiationShortlist } from './fba-rates-2027.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round((value + Number.EPSILON) * 1e10) / 1e10;
const text = value => typeof value === 'string' && value.trim().length > 0;
function ratMatchesSupply(suppliedNum, exactRat) {
  const sRat = toBigRat(suppliedNum);
  if (ratCmp(sRat, exactRat) === 0) return true;
  // Allow only exact 10-decimal rounding or IEEE-754 double representation (|supplied - exact| <= 5e-11) when exactRat is not representable in <=10 decimals.
  const rounded10 = roundBigRat(exactRat.n, exactRat.d, 10);
  if (ratCmp(toBigRat(rounded10), exactRat) === 0) return false;
  const diffNum = sRat.n * exactRat.d - exactRat.n * sRat.d;
  const absDiff = diffNum < 0n ? -diffNum : diffNum;
  return absDiff * 100000000000n <= 5n * sRat.d * exactRat.d;
}
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validWindow = value => isoDate(value?.from) && isoDate(value?.through) && value.from <= value.through;

const PER_KG_KEYS = ['chargeable_kg_per_unit', 'rate_cny_per_kg', 'surcharge_cny_per_kg', 'bond_cny_per_kg', 'bond_cny_per_shipment'];
const STORAGE_CALC_KEYS = ['cubic_feet_per_unit', 'rate_usd_per_cuft_month', 'average_inventory_days'];

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

function parseTriState(value, fieldName) {
  if (value === undefined || value === null || value === 'unknown') return 'unknown';
  if (typeof value === 'boolean') return value;
  throw new TypeError(`${fieldName} must be boolean true, false, or 'unknown' under revision 58.`);
}

function resolveHeadhaul(headhaul, fx, orderUnits, isR58 = false) {
  if (!headhaul || typeof headhaul !== 'object') return { amount_usd: null, cny_derivation: null };
  const hasPerKgField = PER_KG_KEYS.some(key => Object.hasOwn(headhaul, key));
  if (!hasPerKgField) {
    return headhaul.bond_included === true && finite(headhaul.usd_per_unit) && headhaul.usd_per_unit > 0
      ? { amount_usd: isR58 ? headhaul.usd_per_unit : round(headhaul.usd_per_unit), cny_derivation: null }
      : { amount_usd: null, cny_derivation: null };
  }
  if (Object.hasOwn(headhaul, 'usd_per_unit')) return { amount_usd: null, cny_derivation: null };
  const {
    chargeable_kg_per_unit: kg,
    rate_cny_per_kg: rate,
    surcharge_cny_per_kg: surcharge,
    bond_cny_per_kg: bondPerKg,
    bond_cny_per_shipment: bondPerShipment,
  } = headhaul;
  const hasPerKgBond = finite(bondPerKg) && bondPerKg >= 0;
  const hasShipmentBond = finite(bondPerShipment) && bondPerShipment >= 0;
  const needsOrderUnits = !isR58 || hasShipmentBond;
  if (!finite(kg) || kg <= 0 || ![rate, surcharge].every(value => finite(value) && value >= 0) ||
    (!hasPerKgBond && !hasShipmentBond) || (hasPerKgBond && hasShipmentBond) ||
    !finite(fx) || fx <= 0 || (needsOrderUnits && (!finite(orderUnits) || orderUnits <= 0))) {
    return { amount_usd: null, cny_derivation: null };
  }
  if (isR58) {
    const kgR = toBigRat(kg);
    const baseR = mulBigRat(kgR, addBigRat(toBigRat(rate), toBigRat(surcharge)));
    const bondR = hasPerKgBond
      ? mulBigRat(kgR, toBigRat(bondPerKg))
      : divBigRat(toBigRat(bondPerShipment), toBigRat(orderUnits));
    const cnyPerUnitR = addBigRat(baseR, bondR);
    if (cnyPerUnitR.n <= 0n) return { amount_usd: null, cny_derivation: null };
    const usdR = divBigRat(cnyPerUnitR, toBigRat(fx));
    return {
      amount_usd: roundBigRat(usdR.n, usdR.d, 10),
      cny_derivation: {
        fx,
        chargeable_kg_per_unit: kg,
        rate_cny_per_kg: rate,
        surcharge_cny_per_kg: surcharge,
        ...(hasPerKgBond ? { bond_cny_per_kg: bondPerKg } : { bond_cny_per_shipment: bondPerShipment, order_units: orderUnits }),
      },
    };
  }
  const bondCnyPerUnit = hasPerKgBond ? kg * bondPerKg : bondPerShipment / orderUnits;
  const cnyPerUnit = kg * (rate + surcharge) + bondCnyPerUnit;
  return { amount_usd: cnyPerUnit > 0 ? round(cnyPerUnit / fx) : null, cny_derivation: null };
}

function resolveRequiredMonths(operatingPeriod, operatingMonths, isR58) {
  let months = null;
  if (operatingMonths !== undefined) {
    if (!Array.isArray(operatingMonths) || !operatingMonths.length ||
      operatingMonths.some(month => !Number.isInteger(month) || month < 1 || month > 12)) {
      return { valid: false, months: null, explicitFullPeriod: null };
    }
    months = [...new Set(operatingMonths)];
  }
  let explicitFullPeriod = null;
  if (operatingPeriod !== undefined) {
    if (operatingPeriod === 'peak') {
      if (months && ([10, 11, 12].some(month => !months.includes(month)) || months.some(month => ![10, 11, 12].includes(month)))) {
        return { valid: false, months: null, explicitFullPeriod: null };
      }
      months = months ?? [10, 11, 12];
      explicitFullPeriod = 'peak';
    } else if (operatingPeriod === 'off_peak') {
      if (months && months.some(month => [10, 11, 12].includes(month))) {
        return { valid: false, months: null, explicitFullPeriod: null };
      }
      if (!months) explicitFullPeriod = 'off_peak';
      months = months ?? [2, 3, 4, 5, 6, 7, 8, 9];
    } else if (isR58 && operatingPeriod === 'annual') {
      const all12 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      if (months && (all12.some(m => !months.includes(m)) || months.length !== 12)) {
        return { valid: false, months: null, explicitFullPeriod: null };
      }
      months = all12;
      explicitFullPeriod = 'annual';
    } else {
      return { valid: false, months: null, explicitFullPeriod: null };
    }
  }
  if (isR58 && months === null) return { valid: false, months: null, explicitFullPeriod: null };
  return { valid: true, months, explicitFullPeriod };
}

function resolveDateContextR58({ operating_period, operating_months, sales_window, fee_context }) {
  const periodSpec = resolveRequiredMonths(operating_period, operating_months, true);
  if (!periodSpec.valid) return { valid: false, reason: 'Revision 58 requires explicit valid operating_period or operating_months.' };
  if (!fee_context || typeof fee_context !== 'object' ||
    !text(fee_context.package_ref) ||
    (fee_context.marketplace !== undefined && fee_context.marketplace !== 'US') ||
    (fee_context.currency !== undefined && fee_context.currency !== 'USD') ||
    !['sales', 'storage', 'inbound'].every(key => validWindow(fee_context[key]))) {
    return { valid: false, reason: 'Revision 58 requires US/USD, package_ref, and explicit valid ISO date windows for fee_context.sales, storage, and inbound.' };
  }
  if (sales_window !== undefined && sales_window !== null) {
    if (!validWindow(sales_window) ||
      sales_window.from !== fee_context.sales.from || sales_window.through !== fee_context.sales.through) {
      return { valid: false, reason: 'Supplied sales_window contradicts fee_context.sales.' };
    }
  }
  const salesWin = fee_context.sales;
  const storageWin = fee_context.storage;
  const inboundWin = fee_context.inbound;
  if (inboundWin.from > salesWin.through) {
    return { valid: false, reason: 'Inbound plan window cannot start after the sales window ends.' };
  }
  const year = salesWin.from.slice(0, 4);
  if (salesWin.through.slice(0, 4) !== year || storageWin.from.slice(0, 4) !== year || storageWin.through.slice(0, 4) !== year) {
    return { valid: false, reason: 'Sales and storage windows must fall within one target calendar year.' };
  }
  const salesMonths = monthsIn(salesWin);
  const storageMonths = monthsIn(storageWin);
  const required = periodSpec.months;
  if (salesMonths.some(m => !required.includes(m)) || required.some(m => !salesMonths.includes(m)) ||
    storageMonths.some(m => !required.includes(m)) || required.some(m => !storageMonths.includes(m))) {
    return { valid: false, reason: 'Sales and storage windows must exactly cover every month declared in the operating period.' };
  }
  if (periodSpec.explicitFullPeriod === 'annual') {
    if (salesWin.from !== `${year}-01-01` || salesWin.through !== `${year}-12-31` ||
      storageWin.from !== `${year}-01-01` || storageWin.through !== `${year}-12-31`) {
      return { valid: false, reason: 'Annual operating period must cover all days of the target calendar year (YYYY-01-01..YYYY-12-31).' };
    }
  } else if (periodSpec.explicitFullPeriod === 'off_peak') {
    if (salesWin.from !== `${year}-02-01` || salesWin.through !== `${year}-09-30` ||
      storageWin.from !== `${year}-02-01` || storageWin.through !== `${year}-09-30`) {
      return { valid: false, reason: 'Default off_peak operating period must cover full Feb 1 through Sep 30.' };
    }
  }
  return { valid: true, periodSpec, salesWin, storageWin, inboundWin };
}

function basisCoversWindow(basis, win, requireBoundedThrough = false, registeredIds = null, expectedPackageRef = null, lineId = null, isApparel = false) {
  if (!basis || basis.status !== 'published' || !text(basis.version) ||
    !Array.isArray(basis.evidence) || basis.evidence.length === 0 ||
    !basis.evidence.every(id => text(id) && (!registeredIds || registeredIds.has(id))) ||
    basis.marketplace !== 'US' || basis.currency !== 'USD' ||
    !isoDate(basis.effective_from)) return false;
  if (!text(expectedPackageRef) || basis.package_ref !== expectedPackageRef) return false;
  if (!(basis.effective_through === null || isoDate(basis.effective_through))) return false;
  if (requireBoundedThrough && !isoDate(basis.effective_through)) return false;
  if (basis.effective_through && basis.effective_through < basis.effective_from) return false;
  if (lineId !== null && !isOfficial2027ScheduleWindowValid(lineId, basis, isApparel)) return false;
  if (win.from < basis.effective_from) return false;
  if (basis.effective_through && win.through > basis.effective_through) return false;
  if (basis.months !== undefined) {
    if (!Array.isArray(basis.months) || !basis.months.length ||
      basis.months.some(m => !Number.isInteger(m) || m < 1 || m > 12)) return false;
    if (monthsIn(win).some(m => !basis.months.includes(m))) return false;
  }
  return true;
}

function isProvenOversizePkg(pkg) {
  const dims = resolvePackageDimsRat(pkg);
  return Boolean(dims?.isOversize);
}

function pkgCubicFeet(pkg) {
  const dims = resolvePackageDimsRat(pkg);
  return dims ? dims.cubic_feet : null;
}

function resolveStorageUsd(storage, dateCtxR58, storageFeeBasis, registeredIds = null, expectedPackageRef = null, pkg = null, rootFlags = {}) {
  let amount = null;
  let ratePerCuft = null;
  let suppliedCuft = null;
  const overCheck = rootFlags.overCheck ?? resolveConsistentBoolean([rootFlags.is_oversize, storage && typeof storage === 'object' ? storage.is_oversize : undefined, pkg?.is_oversize]);
  const dgCheck = rootFlags.dgCheck ?? resolveConsistentBoolean([rootFlags.is_dangerous_goods, storage && typeof storage === 'object' ? storage.is_dangerous_goods : undefined, pkg?.is_dangerous_goods]);
  const wtCheck = resolveConsistentPkgWeightLb(pkg);
  const badBoolFlag = !overCheck.valid || !dgCheck.valid || (wtCheck.present && !wtCheck.valid) ||
    rootFlags.badPackages === true ||
    (Array.isArray(rootFlags.packages) && rootFlags.packages.length === 0) ||
    (storage && typeof storage === 'object' && (storage.status === 'not_applicable' || storage.amount_usd === 0));
  const claimedOversize = overCheck.value === true;
  const isDg = dgCheck.value === true;
  if (finite(storage)) {
    amount = storage > 0 ? round(storage) : null;
  } else if (storage && typeof storage === 'object') {
    const hasCalcField = STORAGE_CALC_KEYS.some(key => Object.hasOwn(storage, key));
    if (!hasCalcField) {
      amount = finite(storage.usd_per_unit) && storage.usd_per_unit > 0 ? round(storage.usd_per_unit) : null;
    } else if (!Object.hasOwn(storage, 'usd_per_unit')) {
      const { cubic_feet_per_unit: cuft, rate_usd_per_cuft_month: rate, average_inventory_days: days = 45 } = storage;
      if (finite(cuft) && cuft > 0 && finite(rate) && rate > 0 && finite(days) && days >= 45) {
        suppliedCuft = cuft;
        ratePerCuft = rate;
        amount = round(cuft * rate * (days / 30));
      }
    }
  }
  if (amount === null) return null;
  if (!dateCtxR58) return amount;
  if (!dateCtxR58.valid || badBoolFlag) return null;
  // Revision 58 rejects unverified pre-computed scalar/usd_per_unit storage so Q4 $2.40 / off-peak $0.78 floors cannot be bypassed.
  if (ratePerCuft === null) return null;
  const computedPkgCuft = pkgCubicFeet(pkg);
  if (computedPkgCuft !== null && suppliedCuft !== null && Math.abs(suppliedCuft - computedPkgCuft) > 1e-4) return null;
  const provenOversize = isProvenOversizePkg(pkg);
  if (claimedOversize && !provenOversize) return null;
  const win = dateCtxR58.storageWin;
  const winMonths = monthsIn(win);
  const hasOffPeak = winMonths.some(m => m <= 9);
  const hasPeak = winMonths.some(m => m >= 10);
  if (storageFeeBasis !== undefined) {
    if (!basisCoversWindow(storageFeeBasis, win, false, registeredIds, expectedPackageRef, 'storage')) return null;
  } else {
    // 2027 unified monthly storage takes effect 2027-02-01.
    if (win.from < '2027-02-01') return null;
  }
  if (hasOffPeak && hasPeak) return null; // Single scalar rate cannot mix off-peak ($0.78) and peak ($2.40).
  // Dangerous goods storage is strictly HIGHER than non-DG ($0.99/$3.63 standard, $0.78/$2.43 oversize); never bypass floor downward.
  const peakFloor = isDg ? (provenOversize ? 2.43 : 3.63) : (provenOversize ? 1.40 : 2.40);
  const offFloor = isDg ? (provenOversize ? 0.78 : 0.99) : (provenOversize ? 0.56 : 0.78);
  if (hasPeak && ratePerCuft < peakFloor) return null;
  if (hasOffPeak && ratePerCuft < offFloor) return null;
  return amount;
}

function resolvePlacementUsd(placementUsd, dateCtxR58, placementFeeBasis, registeredIds = null, expectedPackageRef = null) {
  if (!finite(placementUsd) || placementUsd < 0) return null;
  if (!dateCtxR58) return round(placementUsd);
  if (!dateCtxR58.valid) return null;
  const win = dateCtxR58.inboundWin;
  if (placementFeeBasis !== undefined) {
    if (!basisCoversWindow(placementFeeBasis, win, false, registeredIds, expectedPackageRef, 'placement')) return null;
  } else if (win.from < '2027-01-15') {
    return null;
  }
  return round(placementUsd);
}

function resolveFulfillmentUsd(fulfillmentUsd, { sales_window, fee_context, fulfillment_fee_basis, operating_period, operating_months }, dateCtxR58, registeredIds = null, expectedPackageRef = null) {
  if (!finite(fulfillmentUsd) || fulfillmentUsd <= 0) return null;
  if (dateCtxR58) {
    if (!dateCtxR58.valid) return null;
    const salesWin = dateCtxR58.salesWin;
    if (fulfillment_fee_basis !== undefined) {
      return basisCoversWindow(fulfillment_fee_basis, salesWin, true, registeredIds, expectedPackageRef, 'fulfillment') ? round(fulfillmentUsd) : null;
    }
    const withinNonPeak2027 = salesWin.from >= '2027-01-15' && salesWin.through <= '2027-10-14';
    return withinNonPeak2027 ? round(fulfillmentUsd) : null;
  }
  // Legacy revision 57 behavior preserved verbatim.
  const periodSpec = resolveRequiredMonths(operating_period, operating_months, false);
  if (!periodSpec.valid) return null;
  const salesWin = sales_window ?? fee_context?.sales ?? null;
  if (periodSpec.months !== null) {
    if (!salesWin || !validWindow(salesWin)) return null;
    const winMonths = monthsIn(salesWin);
    if (winMonths.some(month => !periodSpec.months.includes(month)) ||
      periodSpec.months.some(month => !winMonths.includes(month))) {
      return null;
    }
  }
  if (salesWin !== null) {
    if (!validWindow(salesWin)) return null;
    const outsideNonPeak2027 = salesWin.from < '2027-01-15' || salesWin.through > '2027-10-14';
    if (outsideNonPeak2027 || fulfillment_fee_basis !== undefined) {
      if (fulfillment_fee_basis?.status !== 'published' || !isoDate(fulfillment_fee_basis.effective_from) ||
        !isoDate(fulfillment_fee_basis.effective_through) || fulfillment_fee_basis.effective_through < fulfillment_fee_basis.effective_from ||
        salesWin.from < fulfillment_fee_basis.effective_from || salesWin.through > fulfillment_fee_basis.effective_through) {
        return null;
      }
    }
  } else if (fulfillment_fee_basis !== undefined) {
    if (fulfillment_fee_basis?.status !== 'published' || !isoDate(fulfillment_fee_basis.effective_from) ||
      !isoDate(fulfillment_fee_basis.effective_through) || fulfillment_fee_basis.effective_through < fulfillment_fee_basis.effective_from) {
      return null;
    }
  }
  return round(fulfillmentUsd);
}

function resolveReferral(referralTerms, priceUsd, refundFraction) {
  if (!referralTerms || typeof referralTerms !== 'object' || Array.isArray(referralTerms)) return null;
  const {
    referral_fraction,
    refund_admin_fraction,
    refund_admin_cap_usd,
    minimum_referral_usd = 0,
  } = referralTerms;
  if (!finite(referral_fraction) || referral_fraction < 0 || referral_fraction >= 1 ||
    !finite(refund_admin_fraction) || refund_admin_fraction < 0 || refund_admin_fraction > 1 ||
    !finite(refund_admin_cap_usd) || refund_admin_cap_usd < 0 ||
    !finite(minimum_referral_usd) || minimum_referral_usd < 0) {
    return null;
  }
  return netReferral({
    price_usd: priceUsd,
    referral_fraction,
    refund_fraction: refundFraction,
    refund_admin_fraction,
    refund_admin_cap_usd,
    minimum_referral_usd,
  });
}

export function evaluateEarlyScreen(input, options = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Early-screen input object is required.');
  if (input.profile_revision !== undefined && options.profileRevision !== undefined &&
    input.profile_revision !== options.profileRevision) {
    throw new TypeError('Conflicting input.profile_revision and options.profileRevision.');
  }
  const rev = input.profile_revision ?? options.profileRevision ?? 57;
  if (!Number.isInteger(rev) || rev < 57) throw new TypeError('profileRevision must be an integer >= 57.');
  const isR58 = rev >= 58;

  const {
    id = 'early-screen',
    saleable_unit,
    price_usd,
    minimum_price_usd = 29.99,
    margin_floor = 0.3,
    fx_cny_per_usd: rawFx = null,
    order_units: rawOrderUnits,
    sku_lines = null,
    allow_remainder = false,
    target_sets = null,
    goods_cny_per_unit: rawGoodsCnyPerUnit = null,
    procurement_usd: rawProcurementUsd = null,
    domestic_freight_cny_total = null,
    domestic_freight_cny_per_unit = null,
    domestic_freight_usd: rawDomesticUsd = null,
    first_order_promotion,
    goods_first_order_promotion,
    headhaul = null,
    refund_fraction,
    physical_return_fraction = null,
    return_threshold = null,
    per_return_fee_usd = null,
    returns_processing_exemption = null,
    returns_processing_fee_basis = undefined,
    fee_category = null,
    pkg = null,
    evidence_ids = null,
    evidence = null,
    is_apparel_or_shoes: rawApparel,
    referral_terms,
    fulfillment_usd = null,
    fulfillment_fee_basis,
    storage_fee_basis,
    placement_fee_basis,
    sales_window,
    fee_context,
    operating_period,
    operating_months,
    placement_usd = null,
    storage = null,
    returns_processing_usd,
    defer_return_outcomes = true,
    returns_disposal_usd = null,
    recovery_credit_usd = null,
    collection_rate,
    other_applicable_usd,
    other_payee = 'external',
    assumptions = [isR58
      ? 'Deterministic Gate-1 early screen on >=100 complete saleable units (carton/MOQ compliant) under revision 58.'
      : 'Deterministic Gate-1 early screen on 100 complete saleable units before full 21-item expansion.'],
  } = input;

  if (typeof saleable_unit !== 'string' || !saleable_unit.trim()) throw new TypeError('A nonempty saleable_unit is required.');
  if (!finite(price_usd) || price_usd <= 0) throw new TypeError('A positive finite price_usd is required.');
  if (!finite(minimum_price_usd) || minimum_price_usd < 29.99) throw new TypeError('minimum_price_usd must be at least the revision-57 floor of USD 29.99.');
  if (!finite(margin_floor) || margin_floor < 0.3 || margin_floor >= 1) throw new TypeError('margin_floor must be in [0.3, 1) under revision 57.');

  const rightsState = isR58
    ? parseTriState(input.specific_rights_conflict, 'specific_rights_conflict')
    : Boolean(input.specific_rights_conflict ?? false);
  const dateState = isR58
    ? parseTriState(input.strong_date_dependency, 'strong_date_dependency')
    : Boolean(input.strong_date_dependency ?? false);

  const fxCheck = isR58
    ? resolveConsistentNumeric([rawFx, input?.source_inputs?.fx_cny_per_usd, input?.procurement?.fx_cny_per_usd], v => finite(v) && v > 0)
    : { present: finite(rawFx) && rawFx > 0, valid: true, value: rawFx };
  const fx = fxCheck.valid && fxCheck.present ? fxCheck.value : null;

  let orderPlan = null;
  let skuLineOrderedMismatch = false;
  let skuLinesConflict = !fxCheck.valid;
  let activeSkuLines = null;
  let order_units = rawOrderUnits;
  let goods_cny_per_unit = rawGoodsCnyPerUnit;
  if (isR58) {
    const skuRes = resolveConsistentSkuLines(input, input?.procurement && typeof input.procurement === 'object' ? input.procurement : null);
    if (skuRes.conflict) {
      skuLinesConflict = true;
    } else if (skuRes.present && skuRes.skuLines !== null) {
      activeSkuLines = skuRes.skuLines;
      orderPlan = computeOrderPlan({ sku_lines: activeSkuLines, min_sets: 100, allow_remainder, target_sets });
      if (order_units === undefined || order_units === null) order_units = orderPlan.allocated_sets;
      for (let i = 0; i < activeSkuLines.length; i++) {
        const suppliedOrd = activeSkuLines[i]?.ordered_qty;
        if (suppliedOrd !== undefined && suppliedOrd !== null && suppliedOrd !== orderPlan.sku_lines[i].ordered_qty) {
          skuLineOrderedMismatch = true;
        }
      }
      if (goods_cny_per_unit === null && rawProcurementUsd === null && orderPlan.per_allocated_set_goods_cny !== null) {
        goods_cny_per_unit = orderPlan.per_allocated_set_goods_cny;
      }
    }
  }

  if (order_units !== undefined && order_units !== null && (!finite(order_units) || order_units <= 0)) {
    throw new TypeError('Supplied order_units must be positive.');
  }
  const refundMissing = refund_fraction === undefined || refund_fraction === null;
  if (!refundMissing && (!finite(refund_fraction) || refund_fraction < 0 || refund_fraction >= 1)) {
    throw new TypeError('refund_fraction must be a fraction in [0, 1).');
  }
  const hasExplicitPhysical = physical_return_fraction !== undefined && physical_return_fraction !== null;
  if (hasExplicitPhysical && (!finite(physical_return_fraction) || physical_return_fraction < 0 || physical_return_fraction >= 1)) {
    throw new TypeError('physical_return_fraction must be a fraction in [0, 1).');
  }

  const nestedSetsInvalid = isR58 && [input?.source_inputs, input?.procurement].some(bag => {
    if (!bag || typeof bag !== 'object') return false;
    for (const k of ['complete_saleable_sets', 'order_units']) {
      if (Object.hasOwn(bag, k)) {
        const v = bag[k];
        if (!Number.isSafeInteger(v) || v < 100 || (order_units !== undefined && order_units !== null && v !== order_units)) return true;
      }
    }
    return false;
  });
  const nestedPromoInvalid = isR58 && (
    (input?.source_inputs && Object.hasOwn(input.source_inputs, 'first_order_promotion') && input.source_inputs.first_order_promotion !== false) ||
    (input?.procurement && typeof input.procurement === 'object' && Object.hasOwn(input.procurement, 'first_order_promotion') && input.procurement.first_order_promotion !== false)
  );
  const pricePass = price_usd >= minimum_price_usd;
  const orderUnitsValid = isR58
    ? (!skuLinesConflict && !nestedSetsInvalid && Number.isSafeInteger(order_units) && order_units >= 100 && !skuLineOrderedMismatch && (!orderPlan || order_units === orderPlan.allocated_sets))
    : order_units === 100;
  const goodsPromoClear = !nestedPromoInvalid && (goods_first_order_promotion === undefined
    ? first_order_promotion === false
    : goods_first_order_promotion === false) && (!orderPlan || orderPlan.all_promo_clear);
  const freightPromoClear = !nestedPromoInvalid && first_order_promotion === false;
  let rawProc = null;
  let procCnyDerivation = null;
  if (isR58) {
    if (!orderPlan) {
      let badProcSupply = false;
      let usdSupply = null;
      let cnyRat = null;
      if (rawProcurementUsd !== null && rawProcurementUsd !== undefined) {
        if (finite(rawProcurementUsd) && rawProcurementUsd >= 0) usdSupply = rawProcurementUsd;
        else badProcSupply = true;
      }
      if (goods_cny_per_unit !== null && goods_cny_per_unit !== undefined) {
        if (finite(goods_cny_per_unit) && goods_cny_per_unit >= 0 && finite(fx) && fx > 0) {
          cnyRat = divBigRat(toBigRat(goods_cny_per_unit), toBigRat(fx));
        } else badProcSupply = true;
      }
      if (!badProcSupply) {
        if (cnyRat !== null && usdSupply !== null) {
          if (ratMatchesSupply(usdSupply, cnyRat)) {
            rawProc = roundBigRat(cnyRat.n, cnyRat.d, 10);
            procCnyDerivation = { fx, cny_per_unit: goods_cny_per_unit };
          }
        } else if (cnyRat !== null) {
          rawProc = roundBigRat(cnyRat.n, cnyRat.d, 10);
          procCnyDerivation = { fx, cny_per_unit: goods_cny_per_unit };
        } else if (usdSupply !== null) {
          rawProc = usdSupply;
        }
      }
    }
  } else {
    rawProc = finite(rawProcurementUsd) && rawProcurementUsd >= 0
      ? round(rawProcurementUsd)
      : (finite(goods_cny_per_unit) && goods_cny_per_unit >= 0 && finite(fx) && fx > 0 ? round(goods_cny_per_unit / fx) : null);
  }
  let exactProcRational = null;
  if (isR58 && orderPlan) {
    if (orderPlan.per_allocated_set_goods_cny === null || !finite(fx) || fx <= 0) {
      rawProc = null;
    } else {
      let totalGoodsR = { n: 0n, d: 1n };
      for (const l of orderPlan.sku_lines) {
        const pr = toBigRat(l.unit_price_cny);
        totalGoodsR = addBigRat(totalGoodsR, { n: BigInt(l.ordered_qty) * pr.n, d: pr.d });
      }
      const perSetCnyR = divBigRat(totalGoodsR, toBigRat(orderPlan.allocated_sets));
      const procUsdR = divBigRat(perSetCnyR, toBigRat(fx));
      exactProcRational = { num: procUsdR.n.toString(), den: procUsdR.d.toString() };
      const expectedProcUsd = roundBigRat(procUsdR.n, procUsdR.d, 10);
      const conflictUsd = rawProcurementUsd !== null && rawProcurementUsd !== undefined &&
        (!finite(rawProcurementUsd) || !ratMatchesSupply(rawProcurementUsd, procUsdR));
      const conflictCny = rawGoodsCnyPerUnit !== null && rawGoodsCnyPerUnit !== undefined &&
        (!finite(rawGoodsCnyPerUnit) || !ratMatchesSupply(rawGoodsCnyPerUnit, perSetCnyR));
      rawProc = (conflictUsd || conflictCny) ? null : expectedProcUsd;
      if (rawProc === null) exactProcRational = null;
    }
  }
  const procurementUsd = goodsPromoClear && orderUnitsValid ? rawProc : null;
  if (procurementUsd === null) {
    exactProcRational = null;
    procCnyDerivation = null;
  }

  let registeredIds = null;
  if (Array.isArray(evidence_ids)) {
    registeredIds = new Set(evidence_ids.filter(text));
  } else if (Array.isArray(evidence)) {
    registeredIds = new Set(evidence.map(e => (typeof e === 'string' ? e : e?.id)).filter(text));
  }

  let domesticUsd = null;
  let domCnyDerivation = null;
  if (freightPromoClear && orderUnitsValid) {
    if (isR58) {
      let badDomSupply = false;
      let usdSupply = null;
      const cnySpecs = [];
      if (rawDomesticUsd !== null && rawDomesticUsd !== undefined) {
        if (finite(rawDomesticUsd) && rawDomesticUsd >= 0) usdSupply = rawDomesticUsd;
        else badDomSupply = true;
      }
      if (domestic_freight_cny_per_unit !== null && domestic_freight_cny_per_unit !== undefined) {
        if (finite(domestic_freight_cny_per_unit) && domestic_freight_cny_per_unit >= 0 && finite(fx) && fx > 0) {
          cnySpecs.push({
            rat: divBigRat(toBigRat(domestic_freight_cny_per_unit), toBigRat(fx)),
            deriv: { fx, cny_per_unit: domestic_freight_cny_per_unit },
          });
        } else badDomSupply = true;
      }
      if (domestic_freight_cny_total !== null && domestic_freight_cny_total !== undefined) {
        if (finite(domestic_freight_cny_total) && domestic_freight_cny_total >= 0 && finite(fx) && fx > 0) {
          cnySpecs.push({
            rat: divBigRat(toBigRat(domestic_freight_cny_total), mulBigRat(toBigRat(order_units), toBigRat(fx))),
            deriv: { fx, cny_total: domestic_freight_cny_total, order_units },
          });
        } else badDomSupply = true;
      }
      if (!badDomSupply) {
        const cnyConsistent = cnySpecs.every(s => ratCmp(s.rat, cnySpecs[0].rat) === 0);
        if (cnySpecs.length > 0 && cnyConsistent) {
          const refRat = cnySpecs[0].rat;
          if (usdSupply === null || ratMatchesSupply(usdSupply, refRat)) {
            domesticUsd = roundBigRat(refRat.n, refRat.d, 10);
            domCnyDerivation = cnySpecs[0].deriv;
          }
        } else if (cnySpecs.length === 0 && usdSupply !== null) {
          domesticUsd = usdSupply;
        }
      }
    } else if (finite(rawDomesticUsd) && rawDomesticUsd >= 0) domesticUsd = round(rawDomesticUsd);
    else if (finite(domestic_freight_cny_per_unit) && domestic_freight_cny_per_unit >= 0 && finite(fx) && fx > 0) {
      domesticUsd = round(domestic_freight_cny_per_unit / fx);
    } else if (finite(domestic_freight_cny_total) && domestic_freight_cny_total >= 0 && finite(fx) && fx > 0) {
      domesticUsd = round((domestic_freight_cny_total / order_units) / fx);
    }
  }
  const domesticQuoteValid = goodsPromoClear && freightPromoClear && orderUnitsValid && procurementUsd !== null && domesticUsd !== null;

  const expectedPackageRef = text(fee_context?.package_ref) ? fee_context.package_ref : null;
  const dateCtxR58 = isR58 ? resolveDateContextR58({ operating_period, operating_months, sales_window, fee_context }) : null;
  const pkgResR58 = isR58 ? resolveUniquePackageByRef(input.packages, expectedPackageRef) : { present: false, valid: true, pkg: null };
  let badPackagesR58 = isR58 && pkgResR58.present && !pkgResR58.valid;
  const effectivePkg = pkg ?? pkgResR58.pkg;
  if (isR58 && pkg && pkgResR58.pkg) {
    const d1 = resolvePackageDimsRat(pkg);
    const d2 = resolvePackageDimsRat(pkgResR58.pkg);
    if (!d1 || !d2 || ratCmp(d1.s1Rat, d2.s1Rat) !== 0 || ratCmp(d1.s2Rat, d2.s2Rat) !== 0 || ratCmp(d1.s3Rat, d2.s3Rat) !== 0 ||
      (d1.wtLbRat && d2.wtLbRat && ratCmp(d1.wtLbRat, d2.wtLbRat) !== 0)) {
      badPackagesR58 = true;
    }
  }
  const apparelCheckR58 = resolveConsistentBoolean([
    rawApparel, input.is_apparel,
    returns_processing_fee_basis?.is_apparel_or_shoes, fulfillment_fee_basis?.is_apparel_or_shoes,
    effectivePkg?.is_apparel_or_shoes, pkgResR58.pkg?.is_apparel_or_shoes,
  ]);
  const is_apparel_or_shoes = isR58 ? apparelCheckR58.value === true : Boolean(rawApparel ?? false);
  const dgCheckR58 = resolveConsistentBoolean([
    input.is_dangerous_goods,
    storage && typeof storage === 'object' ? storage.is_dangerous_goods : undefined,
    storage_fee_basis?.is_dangerous_goods, fulfillment_fee_basis?.is_dangerous_goods,
    placement_fee_basis?.is_dangerous_goods, returns_processing_fee_basis?.is_dangerous_goods,
    effectivePkg?.is_dangerous_goods, pkgResR58.pkg?.is_dangerous_goods,
  ]);
  const overCheckR58 = resolveConsistentBoolean([
    input.is_oversize,
    storage && typeof storage === 'object' ? storage.is_oversize : undefined,
    storage_fee_basis?.is_oversize, fulfillment_fee_basis?.is_oversize,
    placement_fee_basis?.is_oversize, returns_processing_fee_basis?.is_oversize,
    effectivePkg?.is_oversize, pkgResR58.pkg?.is_oversize,
  ]);

  const headhaulRes = resolveHeadhaul(headhaul, fx, order_units, isR58);
  const headhaulUsd = headhaulRes.amount_usd;
  const storageUsd = resolveStorageUsd(storage, dateCtxR58, storage_fee_basis, registeredIds, expectedPackageRef, effectivePkg, {
    is_oversize: input.is_oversize, is_dangerous_goods: input.is_dangerous_goods, packages: input.packages,
    overCheck: overCheckR58, dgCheck: dgCheckR58, badPackages: badPackagesR58,
  });
  const resolvedPlacementUsd = resolvePlacementUsd(placement_usd, dateCtxR58, placement_fee_basis, registeredIds, expectedPackageRef);
  const resolvedFulfillmentUsd = resolveFulfillmentUsd(fulfillment_usd, {
    sales_window, fee_context, fulfillment_fee_basis, operating_period, operating_months,
  }, dateCtxR58, registeredIds, expectedPackageRef);

  const rightsCheck = rightsState === true ? 'fail' : rightsState === false ? 'pass' : 'rights_unsearched';
  const dateCheck = dateState === true ? 'defer' : dateState === false ? 'pass' : 'date_unverified';

  if (refundMissing) {
    const reasons = [];
    if (!pricePass) reasons.push(`Matched-spec reference price USD ${price_usd} is below minimum USD ${minimum_price_usd}.`);
    if (rightsState === true) reasons.push('Confirmed specific-design rights conflict excludes this concrete form.');
    if (dateState === true) reasons.push('Strong holiday/date dependency is deferred in this profile.');
    if (dateState === 'unknown') reasons.push('Strong holiday/date dependency has not been verified.');
    if (dateCtxR58 && !dateCtxR58.valid) reasons.push(dateCtxR58.reason);
    reasons.push('Category return/refund proxy (refund_fraction) is missing.');
    const gateStatus = (!pricePass || rightsState === true) ? 'fail' : dateState === true ? 'deferred' : 'pending';
    return {
      gate_status: gateStatus,
      proceed_to_21_items: false,
      ...(isR58 ? { proceed_to_gate2: false, profile_revision: rev, order_plan: orderPlan } : {}),
      reasons,
      checks: {
        reference_price: pricePass ? 'pass' : 'fail',
        specific_form_rights: rightsCheck,
        strong_date_dependency: dateCheck,
        domestic_quote: domesticQuoteValid ? 'pass' : 'pending',
        margin: 'pending',
      },
      ledger: {
        id, saleable_unit, price_usd, refund_fraction: null, margin: null, contribution_usd: null,
        net_revenue_usd: null, net_cost_usd: null, pending_lines: ['refund_fraction'], deferred_lines: [],
        scoring_supported: false, status: 'pending_costs',
      },
      metrics: {
        price_usd, net_revenue_usd: null, procurement_usd: procurementUsd,
        domestic_freight_usd: domesticQuoteValid ? domesticUsd : null, headhaul_usd: headhaulUsd,
        net_cost_usd: null, contribution_usd: null, margin: null, advertising_scenario_margin: null,
        procurement_cap_at_floor_usd: null, procurement_buffer_usd: null, procurement_buffer_cny: null,
        ...(isR58 ? { landed_domestic_cap_at_floor_usd: null, landed_domestic_cap_at_floor_cny: null } : {}),
      },
    };
  }

  const referral = resolveReferral(referral_terms, price_usd, refund_fraction);
  const collectionRateValid = finite(collection_rate) && collection_rate >= 0 && collection_rate < 1;
  const otherApplicableValid = finite(other_applicable_usd) && other_applicable_usd >= 0;
  const resolvedOtherApplicable = otherApplicableValid ? round(other_applicable_usd) : null;

  const rPhysical = hasExplicitPhysical ? physical_return_fraction : refund_fraction;
  const catCheck = isR58
    ? resolveConsistentText([returns_processing_fee_basis?.fee_category, fee_category])
    : { present: false, valid: true, value: null };
  const verifiedCat = catCheck.valid && catCheck.present ? lookupVerified2027ReturnThreshold(catCheck.value) : null;
  const threshCheck = isR58
    ? resolveConsistentNumeric([returns_processing_fee_basis?.return_threshold, return_threshold], v => finite(v) && v >= 0 && v < 1)
    : { present: finite(return_threshold) && return_threshold >= 0 && return_threshold < 1, valid: true, value: return_threshold };
  const perRetCheck = isR58
    ? resolveConsistentNumeric([returns_processing_fee_basis?.per_return_fee_usd, per_return_fee_usd], v => finite(v) && v > 0)
    : { present: finite(per_return_fee_usd) && per_return_fee_usd > 0, valid: true, value: per_return_fee_usd };
  const effectiveThreshold = threshCheck.valid && threshCheck.present ? threshCheck.value : null;
  const effectivePerReturn = perRetCheck.valid && perRetCheck.present ? perRetCheck.value : null;
  const hasThreshold = effectiveThreshold !== null;
  const hasPerReturn = effectivePerReturn !== null;
  const hasExemption = Boolean(returns_processing_exemption && typeof returns_processing_exemption === 'object' &&
    text(returns_processing_exemption.reason) &&
    Array.isArray(returns_processing_exemption.evidence) && returns_processing_exemption.evidence.length > 0 &&
    (!isR58 || registeredIds !== null) &&
    returns_processing_exemption.evidence.every(id => text(id) && (!registeredIds || registeredIds.has(id))));

  let resolvedReturnsProcessing = null;
  let returnsProcessingStatus = 'pending';
  let returnsProcessingBasis = 'Missing returns-processing fee or category return threshold';
  let returnsComponents = null;

  if (isR58) {
    const wtCheck = resolveConsistentPkgWeightLb(effectivePkg);
    const isOfficial2027RetVersion = /^US-FBA-2027/i.test(String(returns_processing_fee_basis?.version ?? '').trim());
    const backdatedOfficial2027Ret = !isOfficial2027ScheduleWindowValid('returns_processing', returns_processing_fee_basis, is_apparel_or_shoes);
    const in2027RetWindow = Boolean(dateCtxR58?.valid && dateCtxR58.salesWin.from >= '2027-02-01' && dateCtxR58.salesWin.through <= '2027-12-31');
    const verifiedPerRet = !is_apparel_or_shoes && (in2027RetWindow || isOfficial2027RetVersion) ? lookupVerified2027PerReturnFee(effectivePkg) : null;
    const catThreshMismatch = Boolean(verifiedCat && hasThreshold && effectiveThreshold !== verifiedCat.threshold);
    const perRetMismatch = Boolean(verifiedPerRet !== null && hasPerReturn && Math.abs(effectivePerReturn - verifiedPerRet) > 1e-9);
    const preFeb2027NoBasis = Boolean(returns_processing_fee_basis === undefined && !is_apparel_or_shoes && !hasExemption && rPhysical > 0 &&
      (!dateCtxR58?.valid || dateCtxR58.salesWin.from < '2027-02-01' || dateCtxR58.salesWin.through > '2027-12-31'));
    if (badPackagesR58 || !apparelCheckR58.valid || !dgCheckR58.valid || !overCheckR58.valid || (wtCheck.present && !wtCheck.valid) || backdatedOfficial2027Ret ||
      !catCheck.valid || !threshCheck.valid || !perRetCheck.valid || catThreshMismatch || perRetMismatch || preFeb2027NoBasis ||
      (returns_processing_fee_basis !== undefined && (!dateCtxR58?.valid || !basisCoversWindow(returns_processing_fee_basis, dateCtxR58.salesWin, false, registeredIds, expectedPackageRef, 'returns_processing', is_apparel_or_shoes)))) {
      resolvedReturnsProcessing = null;
      returnsProcessingStatus = 'pending';
      returnsProcessingBasis = preFeb2027NoBasis
        ? '2027 non-apparel returns-processing schedule starts 2027-02-01; sales outside 2027-02-01..2027-12-31 require an explicit covering returns_processing_fee_basis.'
        : 'Conflicting or invalid returns_processing fee_category, threshold, per-return fee, or fee_basis.';
    } else if (is_apparel_or_shoes) {
      if (hasExemption) {
        resolvedReturnsProcessing = 0;
        returnsProcessingStatus = 'not_applicable';
        returnsProcessingBasis = `Official exemption: ${returns_processing_exemption.reason}`;
        returnsComponents = {
          r_refund: refund_fraction, r_physical: rPhysical, physical_return_proxy_assumed: !hasExplicitPhysical,
          is_apparel_or_shoes: true, return_threshold: null, per_return_fee_usd: hasPerReturn ? effectivePerReturn : null,
          excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: returns_processing_exemption,
        };
      } else if (rPhysical === 0) {
        resolvedReturnsProcessing = 0;
        returnsProcessingStatus = 'not_applicable';
        returnsProcessingBasis = 'Zero physical return rate in declared apparel scenario';
        returnsComponents = {
          r_refund: refund_fraction, r_physical: 0, physical_return_proxy_assumed: !hasExplicitPhysical,
          is_apparel_or_shoes: true, return_threshold: null, per_return_fee_usd: hasPerReturn ? effectivePerReturn : null,
          excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: null,
        };
      } else if (hasPerReturn) {
        const expected = round(rPhysical * effectivePerReturn);
        if (returns_processing_usd === undefined || returns_processing_usd === null ||
          (finite(returns_processing_usd) && Math.abs(returns_processing_usd - expected) <= 1e-6)) {
          resolvedReturnsProcessing = expected;
          returnsProcessingStatus = 'estimated';
          returnsProcessingBasis = 'Derived apparel per-return processing fee';
          returnsComponents = {
            r_refund: refund_fraction, r_physical: rPhysical, physical_return_proxy_assumed: !hasExplicitPhysical,
            is_apparel_or_shoes: true, return_threshold: null, per_return_fee_usd: effectivePerReturn,
            excess_return_fraction: rPhysical, expected_fee_per_shipped_unit_usd: expected, exemption: null,
          };
        }
      }
    } else if (hasExemption) {
      resolvedReturnsProcessing = 0;
      returnsProcessingStatus = 'not_applicable';
      returnsProcessingBasis = `Official returns-processing exemption: ${returns_processing_exemption.reason}`;
      returnsComponents = {
        r_refund: refund_fraction, r_physical: rPhysical, physical_return_proxy_assumed: !hasExplicitPhysical,
        return_threshold: hasThreshold ? effectiveThreshold : null, per_return_fee_usd: hasPerReturn ? effectivePerReturn : null,
        excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: returns_processing_exemption,
      };
    } else if (hasThreshold && rPhysical <= effectiveThreshold) {
      if (returns_processing_usd === undefined || returns_processing_usd === null || returns_processing_usd === 0) {
        resolvedReturnsProcessing = 0;
        returnsProcessingStatus = 'not_applicable';
        returnsProcessingBasis = 'Physical return rate does not exceed supplied FBA returns threshold';
        returnsComponents = {
          r_refund: refund_fraction, r_physical: rPhysical, physical_return_proxy_assumed: !hasExplicitPhysical,
          return_threshold: effectiveThreshold, per_return_fee_usd: hasPerReturn ? effectivePerReturn : null,
          excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: null,
        };
      } else if (finite(returns_processing_usd) && returns_processing_usd > 0) {
        resolvedReturnsProcessing = round(returns_processing_usd);
        returnsProcessingStatus = 'estimated';
        returnsProcessingBasis = 'Explicit conservative positive returns-processing fee';
      }
    } else if (hasThreshold && rPhysical > effectiveThreshold) {
      // Strictly reject 0 without exemption when r_physical > return_threshold!
      if (returns_processing_usd === 0) {
        resolvedReturnsProcessing = null;
        returnsProcessingStatus = 'pending';
        returnsProcessingBasis = `Rejected unexempted zero returns_processing because physical return rate ${rPhysical} exceeds threshold ${effectiveThreshold}.`;
      } else if (hasPerReturn) {
        const excess = round(rPhysical - effectiveThreshold);
        const expected = round(excess * effectivePerReturn);
        if (returns_processing_usd === undefined || returns_processing_usd === null ||
          (finite(returns_processing_usd) && Math.abs(returns_processing_usd - expected) <= 1e-6)) {
          resolvedReturnsProcessing = expected;
          returnsProcessingStatus = 'estimated';
          returnsProcessingBasis = 'Derived excess returns-processing fee above category threshold';
          returnsComponents = {
            r_refund: refund_fraction, r_physical: rPhysical, physical_return_proxy_assumed: !hasExplicitPhysical,
            return_threshold: effectiveThreshold, per_return_fee_usd: effectivePerReturn, excess_return_fraction: excess,
            expected_fee_per_shipped_unit_usd: expected, exemption: null,
          };
        } else {
          resolvedReturnsProcessing = null;
          returnsProcessingStatus = 'pending';
          returnsProcessingBasis = 'Supplied returns_processing_usd contradicts max(0, r_physical - threshold) * per_return_fee_usd.';
        }
      } else {
        resolvedReturnsProcessing = null;
        returnsProcessingStatus = 'pending';
        returnsProcessingBasis = 'Excess returns above threshold require explicit positive per_return_fee_usd.';
      }
    } else if (!hasThreshold) {
      // Missing return_threshold: zero physical returns trivially incurs $0; otherwise stay pending (even for positive placeholders).
      if (rPhysical === 0 && (returns_processing_usd === undefined || returns_processing_usd === null || returns_processing_usd === 0)) {
        resolvedReturnsProcessing = 0;
        returnsProcessingStatus = 'not_applicable';
        returnsProcessingBasis = 'Zero physical return rate in declared scenario';
        returnsComponents = {
          r_refund: refund_fraction, r_physical: 0, physical_return_proxy_assumed: !hasExplicitPhysical,
          return_threshold: null, per_return_fee_usd: hasPerReturn ? effectivePerReturn : null,
          excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: null,
        };
      } else {
        resolvedReturnsProcessing = null;
        returnsProcessingStatus = 'pending';
        returnsProcessingBasis = 'Revision 58 requires a verified return_threshold or evidenced official exemption whenever r_physical > 0.';
      }
    }
  } else {
    // Legacy revision 57 behavior preserved verbatim.
    const thresholdProvenBelow = hasThreshold && refund_fraction <= return_threshold;
    if (finite(returns_processing_usd) && returns_processing_usd >= 0) {
      resolvedReturnsProcessing = round(returns_processing_usd);
      if (resolvedReturnsProcessing === 0 && thresholdProvenBelow) {
        returnsProcessingStatus = 'not_applicable';
        returnsProcessingBasis = 'Category return proxy does not exceed supplied FBA returns threshold';
      } else if (resolvedReturnsProcessing === 0) {
        returnsProcessingStatus = 'not_applicable';
        returnsProcessingBasis = 'Explicitly supplied zero returns-processing fee for declared scenario';
      } else {
        returnsProcessingStatus = 'estimated';
        returnsProcessingBasis = 'Supplied FBA returns-processing fee estimate';
      }
    } else if (returns_processing_usd === undefined && thresholdProvenBelow) {
      resolvedReturnsProcessing = 0;
      returnsProcessingStatus = 'not_applicable';
      returnsProcessingBasis = 'Category return proxy does not exceed supplied FBA returns threshold';
    }
  }

  const amazonKnown = referral !== null && collectionRateValid &&
    [resolvedFulfillmentUsd, resolvedPlacementUsd, storageUsd, resolvedReturnsProcessing,
      other_payee === 'amazon' ? resolvedOtherApplicable : 0]
      .every(value => finite(value) && value >= 0) &&
    (defer_return_outcomes || (finite(returns_disposal_usd) && returns_disposal_usd >= 0));
  const amazonDeductions = amazonKnown
    ? [referral.net_usd, resolvedFulfillmentUsd, resolvedPlacementUsd, storageUsd, resolvedReturnsProcessing,
      ...(defer_return_outcomes ? [] : [returns_disposal_usd]),
      ...(other_payee === 'amazon' && resolvedOtherApplicable > 0 ? [resolvedOtherApplicable] : [])]
    : null;
  const payout = amazonDeductions
    ? collectionFromDisbursement({ net_revenue_usd: price_usd * (1 - refund_fraction), amazon_deductions_usd: amazonDeductions, rate: collection_rate })
    : null;

  const line = (lineId, amount, basis, status = amount === null ? 'pending' : 'estimated') => ({
    id: lineId, amount_usd: amount, status, basis,
  });

  const lines = [
    {
      ...line('procurement', procurementUsd, goodsPromoClear ? `${order_units ?? 100}-unit regular repeat-order unit procurement` : 'Unconfirmed or promotional goods quote'),
      ...(isR58 && orderPlan && procurementUsd !== null ? { order_units: orderPlan.allocated_sets, sku_lines: orderPlan.sku_lines } : {}),
      ...(isR58 && !orderPlan && procCnyDerivation && procurementUsd !== null ? { cny_derivation: procCnyDerivation } : {}),
    },
    {
      ...line('domestic_freight', domesticQuoteValid ? domesticUsd : null, !freightPromoClear
        ? 'Unconfirmed or promotional domestic shipping quote' : `${order_units ?? 100}-unit regular domestic delivery allocation`),
      ...(isR58 && domesticQuoteValid && domCnyDerivation ? { cny_derivation: domCnyDerivation } : {}),
    },
    {
      ...line('headhaul', headhaulUsd, 'Sea-freight chargeable weight plus explicit surcharge and bond'),
      ...(isR58 && headhaulRes.cny_derivation && headhaulUsd !== null ? { cny_derivation: headhaulRes.cny_derivation } : {}),
    },
    line('referral', referral ? referral.net_usd : null, referral ? 'Refund-adjusted net referral fee including refund administration' : 'Missing category referral terms'),
    line('fulfillment', resolvedFulfillmentUsd, 'Applicable dated non-SIPP FBA fulfillment fee'),
    line('placement', resolvedPlacementUsd, 'FBA inbound placement service fee'),
    line('storage', storageUsd, 'FBA monthly storage fee allocated to >=45 average inventory days'),
    {
      id: 'returns_processing', amount_usd: resolvedReturnsProcessing, status: returnsProcessingStatus, basis: returnsProcessingBasis,
      ...(isR58 && hasThreshold ? { return_threshold: effectiveThreshold } : {}),
      ...(isR58 && hasPerReturn ? { per_return_fee_usd: effectivePerReturn } : {}),
      ...(isR58 && catCheck.present && catCheck.valid ? { fee_category: catCheck.value } : {}),
      ...(isR58 && hasExemption ? { exemption: returns_processing_exemption } : {}),
      ...(isR58 && is_apparel_or_shoes ? { is_apparel_or_shoes: true } : {}),
    },
    defer_return_outcomes
      ? { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Paired return disposition and recovery deferred in initial screen' }
      : line('returns_disposal', finite(returns_disposal_usd) && returns_disposal_usd >= 0 ? round(returns_disposal_usd) : null, 'Return disposition cost'),
    line('collection', payout ? payout.collection_usd : null, collectionRateValid ? 'Collection fee on estimated Amazon disbursement' : 'Missing collection rate'),
    line('other_applicable', resolvedOtherApplicable,
      resolvedOtherApplicable === 0 ? 'Declared ordinary scenario has no extra conditional charge' : resolvedOtherApplicable === null ? 'Missing other_applicable_usd declaration' : 'Additional applicable charge',
      resolvedOtherApplicable === 0 ? 'not_applicable' : resolvedOtherApplicable === null ? 'pending' : 'estimated'),
    defer_return_outcomes
      ? { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Paired return disposition and recovery deferred in initial screen' }
      : line('recovery_credit', finite(recovery_credit_usd) && recovery_credit_usd >= 0 ? round(recovery_credit_usd) : null, 'Salvage recovery credit',
        recovery_credit_usd === 0 ? 'not_applicable' : 'estimated'),
  ];

  const ledger = calculateEconomics(
    {
      id, saleable_unit, price_usd, refund_fraction,
      ...(isR58 && hasExplicitPhysical ? { physical_return_fraction } : {}),
      ...(isR58 && orderPlan && finite(fx) && fx > 0 ? { source_inputs: { fx_cny_per_usd: fx } } : {}),
      assumptions, lines,
    },
    isR58 ? { profileRevision: rev } : {},
  );
  const marginComplete = ledger.margin !== null && (!dateCtxR58 || dateCtxR58.valid);
  const marginPass = marginComplete && ledgerMeetsMarginFloor(ledger, margin_floor);

  const reasons = [];
  if (!pricePass) reasons.push(`Matched-spec reference price USD ${price_usd} is below minimum USD ${minimum_price_usd}.`);
  if (rightsState === true) reasons.push('Confirmed specific-design rights conflict excludes this concrete form.');
  if (dateState === true) reasons.push('Strong holiday/date dependency is deferred in this profile.');
  if (dateState === 'unknown') reasons.push('Strong holiday/date dependency has not been verified.');
  if (dateCtxR58 && !dateCtxR58.valid) reasons.push(dateCtxR58.reason);
  if (first_order_promotion === true || goods_first_order_promotion === true) {
    reasons.push('First-order promotion on goods or domestic shipping cannot support repeat-order economics.');
  } else if (!goodsPromoClear || !freightPromoClear) {
    reasons.push('Regular repeat-order status (first_order_promotion: false) must be explicitly confirmed.');
  } else if (!orderUnitsValid) {
    reasons.push(isR58
      ? `Regular domestic quote must use an integer order_units >= 100 matching any sku_lines[] (received ${order_units}).`
      : `Regular domestic quote must use 100 complete saleable units (received ${order_units}).`);
  } else if (procurementUsd === null || domesticUsd === null) {
    reasons.push('Regular goods or domestic freight quote is missing.');
  }
  if (!marginComplete) {
    reasons.push(`Complete margin pending (${ledger.pending_lines.join(', ')}).`);
  } else if (!marginPass) {
    const pct2 = (ledger.margin * 100).toFixed(2);
    const floorPct = (margin_floor * 100).toFixed(2).replace(/\.00$/, '');
    const pctDisplay = Number(pct2) >= margin_floor * 100 ? (ledger.margin * 100).toFixed(6) : pct2;
    reasons.push(`Pre-ad net margin ${pctDisplay}% is below the ${floorPct}% floor.`);
  }
  if (isR58 && rightsState === 'unknown' && pricePass && dateState === false && domesticQuoteValid && marginPass) {
    reasons.push('Economic checks passed; specific-design rights remain unsearched (eligible to advance to Gate 2 rights check).');
  }

  let gateStatus;
  if (!pricePass || rightsState === true || (marginComplete && !marginPass)) {
    gateStatus = 'fail';
  } else if (dateState === true) {
    gateStatus = 'deferred';
  } else if (!domesticQuoteValid || !marginComplete || dateState === 'unknown') {
    gateStatus = 'pending';
  } else if (rightsState === 'unknown') {
    gateStatus = 'economic_pass_rights_unsearched';
  } else {
    gateStatus = 'pass';
  }

  const netRevenue = ledger.net_revenue_usd;
  const targetMaxCost = netRevenue * (1 - margin_floor);
  const procurementCap = ledger.net_cost_usd !== null && procurementUsd !== null
    ? round(targetMaxCost - (ledger.net_cost_usd - procurementUsd))
    : null;
  const bufferUsd = procurementCap !== null && procurementUsd !== null ? round(procurementCap - procurementUsd) : null;
  const bufferCny = bufferUsd !== null && finite(fx) && fx > 0 ? round(bufferUsd * fx) : null;

  let landedDomesticCapUsd = null;
  let landedDomesticCapCny = null;
  if (isR58 && (!dateCtxR58 || dateCtxR58.valid)) {
    const nonDomesticPending = ledger.pending_lines.filter(k => k !== 'procurement' && k !== 'domestic_freight');
    if (nonDomesticPending.length === 0) {
      let nonDomesticA = 0;
      for (const l of ledger.lines) {
        if (l.id === 'procurement' || l.id === 'domestic_freight' || ledger.deferred_lines.includes(l.id) || ledger.pending_lines.includes(l.id)) continue;
        nonDomesticA += (l.id === 'recovery_credit' ? -1 : 1) * l.amount_usd;
      }
      landedDomesticCapUsd = round(targetMaxCost - nonDomesticA);
      landedDomesticCapCny = finite(fx) && fx > 0 ? round(landedDomesticCapUsd * fx) : null;
    }
  }

  let negotiationShortlist = null;
  if (isR58 && marginComplete && !marginPass && procurementUsd !== null && domesticUsd !== null) {
    const negotiableCostUsd = procurementUsd > 0 ? procurementUsd : 0;
    if (negotiableCostUsd > 0) {
      // Exact unrounded BigInt rational shortlist check: max(0, floor*R - G) / C <= 0.12
      const pR = toBigRat(price_usd);
      const rR = toBigRat(refund_fraction);
      const netRevR = { n: pR.n * (rR.d - rR.n), d: pR.d * rR.d };
      const flR = toBigRat(margin_floor);
      const allowCostR = { n: netRevR.n * (flR.d - flR.n), d: netRevR.d * flR.d };
      const excludedSet = new Set([...ledger.pending_lines, ...ledger.deferred_lines]);
      let totalCostR = { n: 0n, d: 1n };
      for (const l of ledger.lines) {
        if (excludedSet.has(l.id)) continue;
        const amtR = l.exact_usd_rational && typeof l.exact_usd_rational.num === 'string' && typeof l.exact_usd_rational.den === 'string'
          ? { n: BigInt(l.exact_usd_rational.num), d: BigInt(l.exact_usd_rational.den) }
          : toBigRat(l.amount_usd);
        totalCostR = addBigRat(totalCostR, l.id === 'recovery_credit' ? { n: -amtR.n, d: amtR.d } : amtR);
      }
      // gap = totalCost - (1 - floor)*R = floor*R - G
      const rawGapR = addBigRat(totalCostR, { n: -allowCostR.n, d: allowCostR.d });
      const gapR = rawGapR.n > 0n ? rawGapR : { n: 0n, d: 1n };
      const procLineObj = ledger.lines.find(l => l.id === 'procurement');
      const cR = procLineObj?.exact_usd_rational && typeof procLineObj.exact_usd_rational.num === 'string' && typeof procLineObj.exact_usd_rational.den === 'string'
        ? { n: BigInt(procLineObj.exact_usd_rational.num), d: BigInt(procLineObj.exact_usd_rational.den) }
        : toBigRat(negotiableCostUsd);
      const maxDiscR = { n: 12n, d: 100n };
      const rhsR = { n: maxDiscR.n * cR.n, d: maxDiscR.d * cR.d };
      const exactEligible = gapR.n * rhsR.d <= rhsR.n * gapR.d;
      const baseShortlist = computeNegotiationShortlist({
        net_revenue_usd: netRevenue,
        contribution_usd: ledger.contribution_usd,
        negotiable_cost_usd: negotiableCostUsd,
        margin_floor,
      });
      negotiationShortlist = {
        ...baseShortlist,
        eligible: exactEligible,
      };
    }
  }

  return {
    gate_status: gateStatus,
    proceed_to_21_items: gateStatus === 'pass',
    ...(isR58 ? {
      proceed_to_gate2: gateStatus === 'pass' || gateStatus === 'economic_pass_rights_unsearched',
      profile_revision: rev,
      order_plan: orderPlan,
      returns_processing_components: returnsComponents,
      negotiation_shortlist: negotiationShortlist,
    } : {}),
    reasons,
    checks: {
      reference_price: pricePass ? 'pass' : 'fail',
      specific_form_rights: rightsCheck,
      strong_date_dependency: dateCheck,
      domestic_quote: domesticQuoteValid ? 'pass' : 'pending',
      margin: !marginComplete ? 'pending' : marginPass ? 'pass' : 'fail',
    },
    ledger,
    metrics: {
      price_usd,
      net_revenue_usd: ledger.net_revenue_usd,
      procurement_usd: procurementUsd,
      domestic_freight_usd: domesticQuoteValid ? domesticUsd : null,
      headhaul_usd: headhaulUsd,
      net_cost_usd: ledger.net_cost_usd,
      contribution_usd: ledger.contribution_usd,
      margin: ledger.margin,
      advertising_scenario_margin: ledger.advertising_scenario_margin,
      procurement_cap_at_floor_usd: procurementCap,
      procurement_buffer_usd: bufferUsd,
      procurement_buffer_cny: bufferCny,
      ...(isR58 ? {
        landed_domestic_cap_at_floor_usd: landedDomesticCapUsd,
        landed_domestic_cap_at_floor_cny: landedDomesticCapCny,
      } : {}),
    },
  };
}
