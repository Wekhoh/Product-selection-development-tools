/**
 * Layer 3: Unified unit-economics cost ledger and deterministic Gate-1 early screener.
 * Imports ONLY src/utils/, src/business-thresholds.mjs, src/rates/index.mjs, and src/fba-calculator.mjs.
 */
import { BUSINESS_THRESHOLDS } from './business-thresholds.mjs';
import {
  gcdBig,
  toBigRat,
  addBigRat,
  mulBigRat,
  divBigRat,
  ratCmp,
  roundBigRat,
  monthsIn,
  validIsoDate,
  validIsoWindow,
} from './utils/index.mjs';
import {
  isCanonical2027OffPeakWin,
  isCanonical2027OffPeakStorageWin,
  isCanonical2027PeakWin,
  isCanonical2027PeakStorageWin,
  hasProhibited2026PeakExtrapolation,
  lookupVerified2027ReturnThreshold,
  netReferral,
  collectionFromDisbursement,
  fraction,
} from './rates/index.mjs';
import {
  validateFeeBasis,
  validateSkuLinesR58,
  resolveConsistentNumeric,
  resolveConsistentText,
  resolveConsistentFeeCategory,
  resolveConsistentBoolean,
  resolveConsistentPkgWeightLb,
  resolveConsistentSkuLines,
  resolveUniquePackageByRef,
  resolvePackageDimsRat,
  resolveEffectivePricing,
  collectLedgerFlag,
  isOfficial2027ScheduleWindowValid,
  lookupVerified2027PerReturnFee,
  storageMeets2027Floor,
  computeHeadhaulWithA4Rules,
  computeAmazonCouponRedemptionFee2027,
  classifySizeTier2027,
  computeOrderPlan,
  computeNegotiationShortlist,
  computePackagingRedesignShortlist2027,
  isAmazonOptimizedPlacementVerified2027,
  lookupUnifiedFulfillmentFee2027,
  priceBand2027,
} from './fba-calculator.mjs';

export { netReferral, collectionFromDisbursement };

export const REQUIRED_COSTS = Object.freeze([
  'procurement', 'domestic_freight', 'headhaul', 'referral', 'fulfillment',
  'placement', 'storage', 'returns_processing', 'returns_disposal',
  'collection', 'other_applicable', 'recovery_credit',
]);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n) => Math.round((n + Number.EPSILON) * 1e10) / 1e10;
const VERIFIED_LINE_RATIONALS = new WeakMap();

export function resolveSharedLedgerPackage(ledger, { preferredLine = null, externalPackages = undefined } = {}) {
  if (!ledger || typeof ledger !== 'object') return { pkg: null, conflict: false };
  const pkgRef = ledger.fee_context?.package_ref;
  const pool = Array.isArray(ledger.packages) && ledger.packages.length > 0
    ? ledger.packages
    : (Array.isArray(externalPackages) && externalPackages.length > 0 ? externalPackages : undefined);
  const poolRes = resolveUniquePackageByRef(pool, pkgRef);
  if (poolRes.present && !poolRes.valid) return { pkg: null, conflict: true };

  const candidates = [];
  if (poolRes.pkg && typeof poolRes.pkg === 'object' && !Array.isArray(poolRes.pkg)) candidates.push(poolRes.pkg);
  if (ledger.pkg && typeof ledger.pkg === 'object' && !Array.isArray(ledger.pkg)) candidates.push(ledger.pkg);
  if (preferredLine?.fee_basis?.pkg && typeof preferredLine.fee_basis.pkg === 'object' && !Array.isArray(preferredLine.fee_basis.pkg)) {
    const pRef = preferredLine.fee_basis.package_ref;
    if (pRef === undefined || pRef === null || !pkgRef || pRef === pkgRef) {
      candidates.push(preferredLine.fee_basis.pkg);
    }
  }
  if (Array.isArray(ledger.lines)) {
    for (const ln of ledger.lines) {
      const fbPkg = ln?.fee_basis?.pkg;
      if (!fbPkg || typeof fbPkg !== 'object' || Array.isArray(fbPkg)) continue;
      const lineRef = ln?.fee_basis?.package_ref;
      if (lineRef !== undefined && lineRef !== null && pkgRef && lineRef !== pkgRef) continue;
      candidates.push(fbPkg);
    }
  }
  if (candidates.length === 0) return { pkg: null, conflict: false };

  const sigOf = p => {
    const cls = classifySizeTier2027(p);
    if (!cls || cls.status === 'invalid_package') return null;
    const sides = [cls.longest_in, cls.median_in, cls.shortest_in];
    if (sides.some(v => !finite(v) || v <= 0) || !finite(cls.unit_weight_lb) || cls.unit_weight_lb <= 0) return null;
    return [...sides, cls.unit_weight_lb];
  };
  let baseSig = null;
  let chosen = candidates[0];
  for (const cand of candidates) {
    const sig = sigOf(cand);
    if (!sig) continue;
    if (!baseSig) {
      baseSig = sig;
      chosen = cand;
    } else if (sig.some((v, idx) => Math.abs(v - baseSig[idx]) > 1e-4)) {
      return { pkg: null, conflict: true };
    }
  }
  return { pkg: chosen, conflict: false };
}

function toDecimalParts(n) {
  if (!finite(n)) throw new TypeError('Finite number required');
  const [mantissa, expPart = '0'] = n.toString().toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const [intPart, fracPart = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = BigInt(intPart + fracPart);
  const exp = Number(expPart) - fracPart.length;
  return exp >= 0 ? { num: sign * digits * (10n ** BigInt(exp)), scale: 0 } : { num: sign * digits, scale: -exp };
}


/** Exact rational comparison of (net_revenue - total_cost) / net_revenue >= floor without IEEE-754 or 10-decimal drift. */
export function ledgerMeetsMarginFloor(ledger, floor) {
  if (!ledger || ledger.margin === null || !finite(floor)) return false;
  const p = toDecimalParts(ledger.price_usd);
  const r = toDecimalParts(ledger.refund_fraction);
  const f = toDecimalParts(floor);
  const netNum = p.num * ((10n ** BigInt(r.scale)) - r.num);
  if (netNum <= 0n) return false;
  const lhsNum = netNum * ((10n ** BigInt(f.scale)) - f.num);
  const lhsDen = 10n ** BigInt(p.scale + r.scale + f.scale);
  const excluded = new Set([...(ledger.pending_lines ?? []), ...(ledger.deferred_lines ?? [])]);
  let costNum = 0n;
  let costDen = 1n;
  for (const l of (ledger.lines ?? [])) {
    if (excluded.has(l.id)) continue;
    const sign = l.id === 'recovery_credit' ? -1n : 1n;
    const parts = toDecimalParts(l.amount_usd);
    const scalePow = 10n ** BigInt(parts.scale);
    let lNum = parts.num, lDen = scalePow;
    // Only trust rationals verified inside calculateEconomics via the module-private WeakMap.
    const verifiedRat = VERIFIED_LINE_RATIONALS.get(l);
    if (verifiedRat) {
      lNum = verifiedRat.n;
      lDen = verifiedRat.d;
    }
    const n = costNum * lDen + sign * lNum * costDen;
    const d = costDen * lDen;
    const g = gcdBig(n, d);
    costNum = n / g;
    costDen = d / g;
  }
  return lhsNum * costDen >= costNum * lhsDen;
}

function deriveExactCnyLineRat(lineId, deriv, isR59 = false) {
  if (!deriv || typeof deriv !== 'object' || !finite(deriv.fx) || deriv.fx <= 0) return null;
  const fxR = toBigRat(deriv.fx);
  if (lineId === 'procurement' && finite(deriv.cny_per_unit) && deriv.cny_per_unit >= 0) {
    return divBigRat(toBigRat(deriv.cny_per_unit), fxR);
  }
  if (lineId === 'domestic_freight') {
    if (finite(deriv.cny_per_unit) && deriv.cny_per_unit >= 0) {
      return divBigRat(toBigRat(deriv.cny_per_unit), fxR);
    }
    if (finite(deriv.cny_total) && deriv.cny_total >= 0 && Number.isSafeInteger(deriv.order_units) && deriv.order_units >= 100) {
      return divBigRat(toBigRat(deriv.cny_total), mulBigRat(toBigRat(deriv.order_units), fxR));
    }
  }
  if (lineId === 'headhaul') {
    const hh = computeHeadhaulWithA4Rules(deriv, deriv.fx, deriv.order_units ?? null, { isR58: true, isR59 });
    return hh.exact_usd_rational;
  }
  return null;
}

export function calculateEconomics(input, options = {}) {
  const isR57Plus = (options.profileRevision ?? 0) >= 57;
  const isR58Plus = (options.profileRevision ?? 0) >= 58;
  const isR59Plus = (options.profileRevision ?? 0) >= 59;
  const pricing = isR58Plus ? resolveEffectivePricing(input) : null;
  if (isR58Plus && !pricing.valid && (input?.list_price_usd !== undefined || input?.net_effective_price_usd !== undefined ||
    input?.ongoing_coupon_usd !== undefined || input?.ongoing_coupon_pct !== undefined ||
    input?.prime_exclusive_discount_usd !== undefined || input?.prime_exclusive_discount_pct !== undefined ||
    input?.promo_basis_already_net === true)) {
    throw new TypeError(pricing.reason);
  }
  const { id, saleable_unit, refund_fraction: r, assumptions } = input;
  const p = isR58Plus && pricing?.valid ? pricing.net_effective_price_usd : input.price_usd;
  if (!id || !saleable_unit || !finite(p) || p <= 0 || !Array.isArray(input.lines) ||
    !Array.isArray(assumptions) || !assumptions.length) throw new TypeError('A coherent named saleable-unit scenario is required');
  const cnyDerivations = new Map();
  const lines = input.lines.map(line => {
    const copy = { ...line };
    if (copy.cny_derivation !== undefined) {
      cnyDerivations.set(copy.id, copy.cny_derivation);
      delete copy.cny_derivation;
    }
    // Never accept untrusted caller-injected exact_usd_rational; only calculateEconomics attaches verified rationals.
    delete copy.exact_usd_rational;
    return copy;
  });
  fraction(r, 'refund_fraction');
  const map = new Map();
  for (const line of lines) {
    if (!REQUIRED_COSTS.includes(line.id) || map.has(line.id)) throw new TypeError(`Unknown or duplicate cost: ${line.id}`);
    if (!['sourced', 'estimated', 'not_applicable', 'pending', 'deferred'].includes(line.status) ||
      typeof line.basis !== 'string' || !line.basis.trim()) throw new TypeError(`Cost status and basis required: ${line.id}`);
    if (line.amount_usd !== null && (!finite(line.amount_usd) || line.amount_usd < 0)) throw new TypeError(`Invalid amount: ${line.id}`);
    if (line.status === 'not_applicable' && line.amount_usd !== 0) throw new TypeError(`Not-applicable cost must be explicit zero: ${line.id}`);
    map.set(line.id, line);
  }
  let refundComponents = null, payoutComponents = null, returnsComponents = null;
  const amazonDeductions = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'returns_disposal'];

  let r58ReturnsInvalid = false;
  let r58ProcInvalid = false;
  let r58HeadhaulInvalid = false;
  let r58StorageInvalid = false;
  let r58FulfillmentInvalid = false;
  let r59PlacementInvalid = false;
  const consistentNum = (values, predicate) => {
    const present = values.filter(v => v !== undefined && v !== null);
    if (present.length === 0) return { present: false, valid: true, value: null };
    if (present.some(v => !predicate(v))) return { present: true, valid: false, value: null };
    for (let i = 1; i < present.length; i++) {
      if (present[i] !== present[0]) return { present: true, valid: false, value: null };
    }
    return { present: true, valid: true, value: present[0] };
  };
  if (isR58Plus) {
    const procLine = map.get('procurement');
    const skuRes = resolveConsistentSkuLines(input, procLine);
    if (skuRes.conflict) {
      r58ProcInvalid = true;
    } else if (skuRes.present && procLine && procLine.status !== 'pending') {
      const skuCheck = validateSkuLinesR58(skuRes.skuLines, procLine.order_units, procLine.amount_usd, [
        procLine.fx_cny_per_usd, input.fx_cny_per_usd, input.source_inputs?.fx_cny_per_usd,
      ]);
      if (!skuCheck.valid) {
        r58ProcInvalid = true;
      } else {
        // Recompute exact unit procurement USD and preserve verified rational in module-private WeakMap.
        procLine.amount_usd = skuCheck.expected_proc_usd;
        procLine.exact_usd_rational = skuCheck.exact_usd_rational;
        VERIFIED_LINE_RATIONALS.set(procLine, {
          n: BigInt(skuCheck.exact_usd_rational.num),
          d: BigInt(skuCheck.exact_usd_rational.den),
        });
      }
    }
    if (!options.requireFeeBasis) {
      for (const [lineId, deriv] of cnyDerivations.entries()) {
        const targetLine = map.get(lineId);
        if (!targetLine || targetLine.status === 'pending' || VERIFIED_LINE_RATIONALS.has(targetLine)) continue;
        const derivedRat = deriveExactCnyLineRat(lineId, deriv, isR59Plus);
        if (derivedRat) {
          targetLine.amount_usd = roundBigRat(derivedRat.n, derivedRat.d, 10);
          targetLine.exact_usd_rational = { num: derivedRat.n.toString(), den: derivedRat.d.toString() };
          VERIFIED_LINE_RATIONALS.set(targetLine, derivedRat);
        }
      }
    } else if (isR59Plus) {
      // H11: In formal r59 scoring (`requireFeeBasis: true`), recompute/cross-check A4 headhaul when tariff inputs exist!
      const hhLine = map.get('headhaul');
      const rawHhSpec = cnyDerivations.get('headhaul')
        ?? (input.headhaul && typeof input.headhaul === 'object' ? input.headhaul : null)
        ?? (input.source_inputs?.headhaul && typeof input.source_inputs.headhaul === 'object' ? input.source_inputs.headhaul : null);
      if (hhLine && hhLine.status !== 'pending' && rawHhSpec && typeof rawHhSpec === 'object' && rawHhSpec.rate_cny_per_kg !== undefined) {
        const effFx = rawHhSpec.fx ?? rawHhSpec.fx_cny_per_usd ?? input.fx_cny_per_usd ?? input.source_inputs?.fx_cny_per_usd;
        const effUnits = rawHhSpec.order_units ?? input.order_units ?? procLine?.order_units ?? null;
        const hhCalc = computeHeadhaulWithA4Rules(rawHhSpec, effFx, effUnits, { isR58: true, isR59: true });
        if (hhCalc.missing_surcharge_quote || !hhCalc.exact_usd_rational) {
          r58HeadhaulInvalid = true;
        } else {
          const expectedHhUsd = roundBigRat(hhCalc.exact_usd_rational.n, hhCalc.exact_usd_rational.d, 10);
          if (finite(hhLine.amount_usd) && Math.abs(hhLine.amount_usd - expectedHhUsd) > 0.005) {
            r58HeadhaulInvalid = true;
          } else {
            hhLine.amount_usd = expectedHhUsd;
            hhLine.exact_usd_rational = {
              num: hhCalc.exact_usd_rational.n.toString(),
              den: hhCalc.exact_usd_rational.d.toString(),
            };
            VERIFIED_LINE_RATIONALS.set(hhLine, hhCalc.exact_usd_rational);
          }
        }
      }
    }

    const pkgRef = input?.fee_context?.package_ref;
    const pkgRes = resolveUniquePackageByRef(input?.packages, pkgRef);
    const sharedPkgRes = isR59Plus ? resolveSharedLedgerPackage(input, { externalPackages: options?.externalPackages }) : { pkg: pkgRes.pkg, conflict: false };
    const matchedPkg = pkgRes.pkg;
    if ((pkgRes.present && !pkgRes.valid) || sharedPkgRes.conflict) {
      r58StorageInvalid = true;
      r58ReturnsInvalid = true;
      if (isR59Plus) {
        r58FulfillmentInvalid = true;
        r59PlacementInvalid = true;
      }
    }

    const storageLine = map.get('storage');
    const sw = input.fee_context?.storage;
    let storageMonths = Array.isArray(options.operatingMonths) ? options.operatingMonths : [];
    if (sw && typeof sw.from === 'string' && typeof sw.through === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sw.from) && /^\d{4}-\d{2}-\d{2}$/.test(sw.through) && sw.from <= sw.through) {
      const mSet = new Set();
      let y = Number(sw.from.slice(0, 4)), m = Number(sw.from.slice(5, 7));
      const ly = Number(sw.through.slice(0, 4)), lm = Number(sw.through.slice(5, 7));
      while (y < ly || (y === ly && m <= lm)) {
        mSet.add(m);
        if (++m > 12) { m = 1; y++; }
        if (mSet.size === 12) break;
      }
      storageMonths = [...mSet];
    }
    if (storageLine && !storageMeets2027Floor(input, storageLine, storageMonths)) {
      r58StorageInvalid = true;
    }
    const fulLine = map.get('fulfillment');
    const salesWinForFul = input.fee_context?.sales;
    if (fulLine && fulLine.status !== 'pending' && salesWinForFul?.through > '2027-10-14' &&
      hasProhibited2026PeakExtrapolation(fulLine, input)) {
      r58FulfillmentInvalid = true;
    }
    if (isR59Plus && fulLine && fulLine.status !== 'pending' && finite(fulLine.amount_usd) &&
      pricing?.has_ongoing_discount && !pricing.has_prime_discount &&
      finite(pricing.list_price_usd) && priceBand2027(pricing.list_price_usd) !== priceBand2027(p) &&
      fulLine.fee_basis?.sp_api_calibrated !== true && fulLine.fee_basis?.calculator_verified !== true) {
      if (fulLine.fee_basis?.price_band === priceBand2027(p)) {
        r58FulfillmentInvalid = true;
      } else {
        const fulPkg = resolveSharedLedgerPackage(input, { preferredLine: fulLine, externalPackages: options?.externalPackages }).pkg ?? matchedPkg;
        const in2027OffPeakSales = !salesWinForFul || (
          typeof salesWinForFul.from === 'string' && typeof salesWinForFul.through === 'string' &&
          salesWinForFul.from >= '2027-01-15' && salesWinForFul.through <= '2027-10-14'
        );
        if (fulPkg && in2027OffPeakSales) {
          const apparelFlag = collectLedgerFlag(input, 'is_apparel_or_shoes', fulPkg);
          const dgFlag = collectLedgerFlag(input, 'is_dangerous_goods', fulPkg);
          if (apparelFlag.valid && dgFlag.valid) {
            const expectedListFul = lookupUnifiedFulfillmentFee2027({
              ...fulPkg,
              price_usd: p,
              list_price_usd: pricing.list_price_usd,
              has_ongoing_coupon: true,
              has_prime_discount: false,
              fee_category: fulLine.fee_basis?.fee_category ?? input.fee_category,
              is_apparel: input.is_apparel,
              is_shoes: input.is_shoes,
              is_apparel_or_shoes: apparelFlag.value === true,
              is_dangerous_goods: dgFlag.value === true,
              is_sipp: fulLine.fee_basis?.is_sipp ?? input.is_sipp ?? fulPkg.is_sipp,
              requires_amazon_packaging: fulLine.fee_basis?.requires_amazon_packaging ?? input.requires_amazon_packaging ?? fulPkg.requires_amazon_packaging,
            });
            if (expectedListFul.status === 'verified' && fulLine.amount_usd < expectedListFul.total_usd - 0.005) {
              r58FulfillmentInvalid = true;
            }
          }
        }
      }
    }

    const placeLine = map.get('placement');
    if (isR59Plus && placeLine && placeLine.status !== 'pending' && finite(placeLine.amount_usd)) {
      const placePkg = resolveSharedLedgerPackage(input, { preferredLine: placeLine, externalPackages: options?.externalPackages }).pkg ?? matchedPkg;
      const placeSplitOpt = placeLine.split_option ?? placeLine.fee_basis?.split_option ?? input.placement_split_option ?? null;
      const placeOverFlag = collectLedgerFlag(input, 'is_oversize', placePkg);
      const placeAppFlag = collectLedgerFlag(input, 'is_apparel_or_shoes', placePkg);
      const placeDgFlag = collectLedgerFlag(input, 'is_dangerous_goods', placePkg);
      const pkgCls = placePkg && placeAppFlag.valid && placeDgFlag.valid
        ? classifySizeTier2027(placePkg, { is_apparel: placeAppFlag.value === true, is_dangerous_goods: placeDgFlag.value === true })
        : null;
      const declaredPlaceTier = String(
        placeLine.size_tier ??
        placeLine.fee_basis?.size_tier ??
        map.get('fulfillment')?.fee_basis?.size_tier ??
        input.size_tier ??
        '',
      ).trim().toLowerCase();
      const isConfirmedOversize = placeOverFlag.value === true ||
        pkgCls?.tier_family === 'oversize' ||
        (declaredPlaceTier.includes('oversize') && (!pkgCls || pkgCls.tier_family === 'oversize')) ||
        (placeLine.fee_basis?.exempt_oversize_tier === true && (!pkgCls || pkgCls.tier_family === 'oversize'));
      const hasNonOversizeEvidence =
        placePkg !== null ||
        placeOverFlag.value === false ||
        (declaredPlaceTier.length > 0 && !declaredPlaceTier.includes('oversize'));
      if (!isConfirmedOversize &&
        (placeSplitOpt === 'amazon_optimized' || (hasNonOversizeEvidence && round(placeLine.amount_usd) === 0))) {
        const optVerified = isAmazonOptimizedPlacementVerified2027({
          identical_cartons_count: placeLine.identical_cartons_count ??
            placeLine.fee_basis?.identical_cartons_count ??
            input.identical_cartons_count ??
            null,
          multi_destination_headhaul_verified: placeLine.multi_destination_headhaul_verified ??
            placeLine.fee_basis?.multi_destination_headhaul_verified ??
            input.multi_destination_headhaul_verified ??
            false,
        });
        if (!optVerified) {
          r59PlacementInvalid = true;
        }
      }
    }

    const retLine = map.get('returns_processing');
    const hasExplicitPhys = input.physical_return_fraction !== undefined && input.physical_return_fraction !== null;
    const rPhysValid = !hasExplicitPhys || (finite(input.physical_return_fraction) && input.physical_return_fraction >= 0 && input.physical_return_fraction < 1);
    const rPhys = hasExplicitPhys ? input.physical_return_fraction : r;
    const apparelCheck = collectLedgerFlag(input, 'is_apparel_or_shoes', matchedPkg);
    const dgCheck = collectLedgerFlag(input, 'is_dangerous_goods', matchedPkg);
    const overCheck = collectLedgerFlag(input, 'is_oversize', matchedPkg);
    const wtCheck = resolveConsistentPkgWeightLb(matchedPkg);
    const isApparel = apparelCheck.value === true;
    const salesWin = input?.fee_context?.sales;
    const isOfficial2027RetVersion = /^US-FBA-2027/i.test(String(retLine?.fee_basis?.version ?? '').trim());
    const backdatedOfficial2027Ret = !isOfficial2027ScheduleWindowValid('returns_processing', retLine?.fee_basis, isApparel);
    const maxRetEndEcon = isR59Plus ? '2028-01-14' : '2027-12-31';
    const in2027RetSchedule = Boolean(salesWin?.from && salesWin?.through && salesWin.from >= (isApparel ? '2027-01-15' : '2027-02-01') && salesWin.through <= maxRetEndEcon);
    const verifiedPerRet = (!isApparel || isR59Plus) && (in2027RetSchedule || isOfficial2027RetVersion)
      ? lookupVerified2027PerReturnFee(matchedPkg, { isApparelOrShoes: isApparel, allowAll2027Tiers: isR59Plus })
      : null;
    const catCheck = resolveConsistentFeeCategory([retLine?.fee_basis?.fee_category, retLine?.fee_category, input.fee_category]);
    const verifiedCat = catCheck.valid && catCheck.present ? lookupVerified2027ReturnThreshold(catCheck.value) : null;
    const threshCheck = consistentNum(
      [retLine?.fee_basis?.return_threshold, retLine?.return_threshold, input.return_threshold],
      v => finite(v) && v >= 0 && v < 1,
    );
    const perRetCheck = consistentNum(
      [retLine?.fee_basis?.per_return_fee_usd, retLine?.per_return_fee_usd, input.per_return_fee_usd],
      v => finite(v) && v > 0,
    );
    const sources = new Set(options.evidenceIds ?? []);
    const hasExemption = Boolean(retLine?.exemption && typeof retLine.exemption === 'object' &&
      typeof retLine.exemption.reason === 'string' && retLine.exemption.reason.trim().length > 0 &&
      Array.isArray(retLine.exemption.evidence) && retLine.exemption.evidence.length > 0 &&
      retLine.exemption.evidence.every(id => typeof id === 'string' && id.trim().length > 0 && (!options.requireFeeBasis || sources.has(id))));
    const catThreshMismatch = Boolean(verifiedCat && threshCheck.present && threshCheck.value !== verifiedCat.threshold);
    const perRetMismatch = Boolean(verifiedPerRet !== null && perRetCheck.present && Math.abs(perRetCheck.value - verifiedPerRet) > 1e-9);
    if ((pkgRes.present && !pkgRes.valid) || !apparelCheck.valid || !dgCheck.valid || !overCheck.valid ||
      (wtCheck.present && !wtCheck.valid) || backdatedOfficial2027Ret ||
      !rPhysValid || !catCheck.valid || !threshCheck.valid || !perRetCheck.valid || catThreshMismatch || perRetMismatch) {
      r58ReturnsInvalid = true;
    } else if (retLine && retLine.status !== 'pending') {
      if (isApparel) {
        if (rPhys > 0 && !hasExemption) {
          if (retLine.amount_usd === 0 || retLine.status === 'not_applicable' || !perRetCheck.present) {
            r58ReturnsInvalid = true;
          } else if (finite(retLine.amount_usd) && retLine.amount_usd > 0) {
            const expected = round(rPhys * perRetCheck.value);
            if (Math.abs(retLine.amount_usd - expected) > 1e-6) {
              r58ReturnsInvalid = true;
            } else {
              retLine.amount_usd = expected;
              returnsComponents = {
                r_refund: r, r_physical: rPhys, physical_return_proxy_assumed: !hasExplicitPhys,
                is_apparel_or_shoes: true, return_threshold: null, per_return_fee_usd: perRetCheck.value,
                excess_return_fraction: rPhys, expected_fee_per_shipped_unit_usd: expected, exemption: null,
              };
            }
          }
        } else {
          returnsComponents = {
            r_refund: r, r_physical: rPhys, physical_return_proxy_assumed: !hasExplicitPhys,
            is_apparel_or_shoes: true, return_threshold: null, per_return_fee_usd: perRetCheck.present ? perRetCheck.value : null,
            excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: hasExemption ? retLine.exemption : null,
          };
        }
      } else if (hasExemption) {
        returnsComponents = {
          r_refund: r, r_physical: rPhys, physical_return_proxy_assumed: !hasExplicitPhys,
          is_apparel_or_shoes: false, return_threshold: threshCheck.present ? threshCheck.value : null,
          per_return_fee_usd: perRetCheck.present ? perRetCheck.value : null,
          excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: retLine.exemption,
        };
      } else if (!threshCheck.present) {
        if (rPhys > 0) r58ReturnsInvalid = true;
      } else if (rPhys > threshCheck.value) {
        if (retLine.amount_usd === 0 || retLine.status === 'not_applicable' || !perRetCheck.present) {
          r58ReturnsInvalid = true;
        } else if (finite(retLine.amount_usd) && retLine.amount_usd > 0) {
          const excess = round(rPhys - threshCheck.value);
          const expected = round(excess * perRetCheck.value);
          if (Math.abs(retLine.amount_usd - expected) > 1e-6) {
            r58ReturnsInvalid = true;
          } else {
            retLine.amount_usd = expected;
            returnsComponents = {
              r_refund: r, r_physical: rPhys, physical_return_proxy_assumed: !hasExplicitPhys,
              is_apparel_or_shoes: false, return_threshold: threshCheck.value, per_return_fee_usd: perRetCheck.value,
              excess_return_fraction: excess, expected_fee_per_shipped_unit_usd: expected, exemption: null,
            };
          }
        }
      } else {
        returnsComponents = {
          r_refund: r, r_physical: rPhys, physical_return_proxy_assumed: !hasExplicitPhys,
          is_apparel_or_shoes: false, return_threshold: threshCheck.value,
          per_return_fee_usd: perRetCheck.present ? perRetCheck.value : null,
          excess_return_fraction: 0, expected_fee_per_shipped_unit_usd: 0, exemption: null,
        };
      }
    }
  }

  const computedCouponFeeR59 = isR59Plus
    ? computeAmazonCouponRedemptionFee2027({
      net_effective_price_usd: p,
      ongoing_coupon_usd: input.ongoing_coupon_usd,
      ongoing_coupon_pct: input.ongoing_coupon_pct,
      coupon_redemption_share: input.coupon_redemption_share ?? 1,
      coupon_campaign_units: input.coupon_campaign_units ?? (Number.isSafeInteger(input.order_units) && input.order_units > 0 ? input.order_units : 100),
      include_campaign_flat_usd: input.include_coupon_campaign_flat !== false,
    })
    : { applicable: false, per_unit_usd: 0, exact_usd_rational: { n: 0n, d: 1n } };
  const explicitCouponFeeUsd = isR59Plus && finite(input.coupon_redemption_fee_usd) && input.coupon_redemption_fee_usd > 0
    ? round(input.coupon_redemption_fee_usd)
    : 0;
  const couponFeeR59 = computedCouponFeeR59.applicable && computedCouponFeeR59.per_unit_usd >= explicitCouponFeeUsd
    ? computedCouponFeeR59
    : (explicitCouponFeeUsd > 0
      ? { applicable: true, per_unit_usd: explicitCouponFeeUsd, exact_usd_rational: toBigRat(explicitCouponFeeUsd) }
      : { applicable: false, per_unit_usd: 0, exact_usd_rational: { n: 0n, d: 1n } });
  let extraCouponAmazonDeductionUsd = 0;
  if (couponFeeR59.applicable && couponFeeR59.per_unit_usd > 0) {
    const otherLine = map.get('other_applicable');
    const declaredInOther = Boolean(
      input.coupon_fee_already_in_other === true ||
      otherLine?.coupon_fee_included === true ||
      (Array.isArray(otherLine?.components) && otherLine.components.includes('coupon_redemption')) ||
      (typeof otherLine?.basis === 'string' && /coupon/i.test(otherLine.basis)),
    );
    const alreadyHasCoupon = Boolean(
      declaredInOther &&
      otherLine &&
      finite(otherLine.amount_usd) &&
      otherLine.amount_usd >= couponFeeR59.per_unit_usd - 1e-6,
    );
    if (alreadyHasCoupon && otherLine.payee !== 'amazon') {
      extraCouponAmazonDeductionUsd = finite(otherLine.amazon_portion_usd) && otherLine.amazon_portion_usd > 0
        ? otherLine.amazon_portion_usd
        : couponFeeR59.per_unit_usd;
    } else if (!alreadyHasCoupon && otherLine && otherLine.status !== 'pending' && finite(otherLine.amount_usd)) {
      const priorExternalAmt = otherLine.payee === 'external' && otherLine.amount_usd > 0 ? otherLine.amount_usd : 0;
      const prevAmt = otherLine.amount_usd;
      otherLine.amount_usd = round(prevAmt + couponFeeR59.per_unit_usd);
      otherLine.status = 'estimated';
      otherLine.coupon_fee_included = true;
      otherLine.basis = prevAmt > 0
        ? `${otherLine.basis}; plus Amazon ongoing coupon redemption fee ($5/100 + 2.5%)`
        : 'Amazon ongoing coupon redemption fee ($5/100 + 2.5%)';
      otherLine.components = [...new Set([...(Array.isArray(otherLine.components) ? otherLine.components : []), 'coupon_redemption'])];
      if (priorExternalAmt === 0) {
        otherLine.payee = 'amazon';
        if (options.requireFeeBasis && !otherLine.fee_basis) {
          const refBasis = map.get('referral')?.fee_basis ?? map.get('fulfillment')?.fee_basis ?? null;
          if (refBasis) otherLine.fee_basis = { ...refBasis };
        }
      } else {
        otherLine.amazon_portion_usd = round(
          (finite(otherLine.amazon_portion_usd) && otherLine.amazon_portion_usd > 0 ? otherLine.amazon_portion_usd : 0) +
          couponFeeR59.per_unit_usd,
        );
        extraCouponAmazonDeductionUsd = otherLine.amazon_portion_usd;
      }
      if (prevAmt === 0 && couponFeeR59.exact_usd_rational) {
        otherLine.exact_usd_rational = {
          num: couponFeeR59.exact_usd_rational.n.toString(),
          den: couponFeeR59.exact_usd_rational.d.toString(),
        };
        VERIFIED_LINE_RATIONALS.set(otherLine, couponFeeR59.exact_usd_rational);
      }
      if (!options.requireFeeBasis && map.has('collection') && finite(input.collection_rate) && input.collection_rate >= 0 && input.collection_rate < 1) {
        const colLine = map.get('collection');
        const nonDeferredAmz = amazonDeductions
          .filter(k => map.get(k)?.status !== 'deferred')
          .map(k => map.get(k)?.amount_usd);
        if (colLine && colLine.status !== 'pending' && nonDeferredAmz.every(v => finite(v) && v >= 0)) {
          const amzList = [...nonDeferredAmz, ...(otherLine.payee === 'amazon' ? [otherLine.amount_usd] : [extraCouponAmazonDeductionUsd])];
          const recomputedPayout = collectionFromDisbursement({
            net_revenue_usd: p * (1 - r),
            rate: input.collection_rate,
            amazon_deductions_usd: amzList,
          });
          colLine.amount_usd = recomputedPayout.collection_usd;
        }
      }
    }
  }

  if (options.requireFeeBasis) {
    refundComponents = netReferral({ ...input.referral_terms,
      minimum_referral_usd: isR57Plus ? input.referral_terms?.minimum_referral_usd : 0,
      price_usd: p, refund_fraction: r });
    fraction(input.collection_rate, 'collection_rate');
    const referral = map.get('referral');
    if (referral) {
      if (referral.status === 'not_applicable' && refundComponents.net_usd !== 0) throw new TypeError('Referral terms contradict a not-applicable referral line.');
      referral.amount_usd = refundComponents.net_usd;
      referral.components = [...new Set([...(Array.isArray(referral.components) ? referral.components : []), 'referral_after_refunds', 'refund_administration'])];
    }
    const other = map.get('other_applicable');
    if (other?.amount_usd > 0) {
      if (!['amazon', 'external'].includes(other.payee)) throw new TypeError('A positive other_applicable cost must identify its amazon or external payee.');
      if (other.payee === 'amazon') amazonDeductions.push('other_applicable');
    }
  }
  const deferred = REQUIRED_COSTS.filter(k => map.get(k)?.status === 'deferred');
  if (deferred.length) {
    const returns = deferred.filter(k => k === 'returns_disposal' || k === 'recovery_credit');
    if (deferred.some(k => !['domestic_freight', 'returns_disposal', 'recovery_credit'].includes(k)) ||
      (returns.length !== 0 && returns.length !== 2)) {
      throw new TypeError('Only domestic freight or paired return disposition and recovery may be deferred from the initial estimate');
    }
    if (deferred.some(k => map.get(k).amount_usd !== null)) {
      throw new TypeError('Deferred outcomes must retain null amounts, not asserted zeros');
    }
  }
  if (options.requireFeeBasis && map.has('collection') && !r58ReturnsInvalid &&
    amazonDeductions.every(key => deferred.includes(key) || (map.has(key) && finite(map.get(key).amount_usd) && map.get(key).status !== 'pending'))) {
    payoutComponents = collectionFromDisbursement({ net_revenue_usd: p * (1 - r), rate: input.collection_rate,
      amazon_deductions_usd: [
        ...amazonDeductions.filter(key => !deferred.includes(key)).map(key => map.get(key).amount_usd),
        ...(extraCouponAmazonDeductionUsd > 0 ? [extraCouponAmazonDeductionUsd] : []),
      ] });
    const collection = map.get('collection');
    if (collection.status === 'not_applicable' && payoutComponents.collection_usd !== 0) throw new TypeError('Collection rate contradicts a not-applicable collection line.');
    collection.amount_usd = payoutComponents.collection_usd;
    if (isR57Plus) {
      collection.components = [...new Set([...(Array.isArray(collection.components) ? collection.components : []), 'payment_collection'])];
    }
  }
  const validationLines = isR59Plus && cnyDerivations.has('headhaul')
    ? lines.map(l => l.id === 'headhaul' ? { ...l, cny_derivation: cnyDerivations.get('headhaul') } : l)
    : lines;
  const validation = options.requireFeeBasis
    ? validateFeeBasis({ ...input, lines: validationLines }, { ...options, requireRegularRepeatOrder: Boolean(options.requireRegularRepeatOrder || isR57Plus) })
    : null;
  if (validation && r59PlacementInvalid && !validation.issues.some(iss => iss.line === 'placement')) {
    validation.valid = false;
    validation.issues.push({
      line: 'placement',
      code: 'unverified_amazon_optimized_placement',
      reason: 'Standard/Bulky $0 placement (amazon_optimized) requires identical_cartons_count >= 5 AND multi_destination_headhaul_verified === true.',
    });
  }
  const invalid = new Set(validation?.issues.map(issue => issue.line) ?? []);
  const pending = REQUIRED_COSTS.filter(k => !deferred.includes(k) &&
    (!map.has(k) || map.get(k).amount_usd === null || map.get(k).status === 'pending'));
  if (r58ProcInvalid && !pending.includes('procurement')) pending.push('procurement');
  if (r58HeadhaulInvalid && !pending.includes('headhaul')) pending.push('headhaul');
  if (r58StorageInvalid && !pending.includes('storage')) pending.push('storage');
  if (r58ReturnsInvalid && !pending.includes('returns_processing')) pending.push('returns_processing');
  if (r58FulfillmentInvalid && !pending.includes('fulfillment')) pending.push('fulfillment');
  if (r59PlacementInvalid && !pending.includes('placement')) pending.push('placement');
  for (const key of REQUIRED_COSTS) {
    if (invalid.has(key) && !pending.includes(key)) pending.push(key);
  }
  // Payout-based collection cannot remain confirmed when an Amazon deduction is unknown.
  if ((validation || isR58Plus) && (invalid.has('context') || [...amazonDeductions, 'other_applicable'].some(key => pending.includes(key))) &&
    !pending.includes('collection')) pending.push('collection');
  if (validation && pending.includes('collection')) payoutComponents = null;
  let known = 0;
  for (const [key, line] of map) {
    if (!pending.includes(key) && !deferred.includes(key)) known += (key === 'recovery_credit' ? -1 : 1) * line.amount_usd;
  }
  const net = p * (1 - r), complete = pending.length === 0 && !invalid.has('context');
  if (!finite(net) || net <= 0 || !finite(known)) throw new TypeError('Economic totals must remain finite with positive net revenue.');
  const cost = complete ? known : null, contribution = complete ? net - cost : null;
  const sensitivityInvalid = isR58Plus && input.sensitivity_only !== undefined && typeof input.sensitivity_only !== 'boolean';
  const supported = complete && input.sensitivity_only !== true && !sensitivityInvalid;
  let landedDomesticCap = null;
  let landedDomesticCapCny = null;
  if (isR58Plus && !invalid.has('context')) {
    const nonDomesticPending = pending.filter(k => k !== 'procurement' && k !== 'domestic_freight');
    if (nonDomesticPending.length === 0) {
      let nonDomesticCost = 0;
      for (const [key, line] of map) {
        if (key === 'procurement' || key === 'domestic_freight' || deferred.includes(key) || pending.includes(key)) continue;
        nonDomesticCost += (key === 'recovery_credit' ? -1 : 1) * line.amount_usd;
      }
      landedDomesticCap = round(net * 0.7 - nonDomesticCost);
      const fxCheck = consistentNum(
        [map.get('procurement')?.fx_cny_per_usd, input.fx_cny_per_usd, input.source_inputs?.fx_cny_per_usd],
        v => finite(v) && v > 0,
      );
      if (fxCheck.present && fxCheck.valid) {
        landedDomesticCapCny = round(landedDomesticCap * fxCheck.value);
      }
    }
  }
  const hasPricingDetails = Boolean(isR58Plus && pricing && (
    pricing.has_ongoing_discount ||
    input.list_price_usd !== undefined ||
    input.net_effective_price_usd !== undefined
  ));
  return { id, saleable_unit, assumptions, lines, price_usd: p, refund_fraction: r,
    ...(hasPricingDetails ? {
      list_price_usd: pricing.list_price_usd,
      net_effective_price_usd: pricing.net_effective_price_usd,
      ongoing_discount_usd: pricing.total_discount_usd,
    } : {}),
    ...(validation ? { fee_validation: validation } : {}),
    ...(options.requireFeeBasis ? { refund_components: refundComponents, payout_components: payoutComponents } : {}),
    ...(isR58Plus ? {
      returns_processing_components: returnsComponents,
      landed_domestic_cap_at_30pct_usd: landedDomesticCap,
      ...(landedDomesticCapCny !== null ? { landed_domestic_cap_at_30pct_cny: landedDomesticCapCny } : {}),
    } : {}),
    expected_refund_usd: round(p * r), net_revenue_usd: round(net),
    known_cost_usd: round(known), pending_lines: pending, deferred_lines: deferred,
    net_cost_usd: complete ? round(cost) : null,
    contribution_usd: complete ? round(contribution) : null,
    margin: complete ? contribution / net : null,
    advertising_15pct_usd: round(p * 0.15),
    advertising_scenario_contribution_usd: complete ? round(contribution - p * 0.15) : null,
    advertising_scenario_margin: complete ? (contribution - p * 0.15) / net : null,
    // Bare-goods cap holds domestic_freight and recovery_credit fixed; distinct from landed_domestic_cap_at_30pct_usd.
    procurement_cap_at_30pct_usd: complete ? round(net * 0.7 - (cost - map.get('procurement').amount_usd)) : null,
    scoring_supported: supported,
    status: !complete ? 'pending_costs' : !supported ? 'sensitivity_only' :
      deferred.includes('domestic_freight') ? 'initial_estimate_with_deferred_costs' :
        deferred.length ? 'initial_estimate_with_deferred_returns' : 'conditional_estimate',
  };
}


const text = value => typeof value === 'string' && value.trim().length > 0;
const isoDate = validIsoDate;
const validWindow = validIsoWindow;

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

const PER_KG_KEYS = [
  'chargeable_kg_per_unit',
  'rate_cny_per_kg',
  'surcharge_cny_per_kg',
  'bond_cny_per_kg',
  'bond_cny_per_shipment',
  'carton_cm',
  'carton_count',
  'actual_weight_kg_total',
  'actual_weight_kg_per_unit',
  'weight_per_carton_kg',
];
const STORAGE_CALC_KEYS = ['cubic_feet_per_unit', 'rate_usd_per_cuft_month', 'average_inventory_days'];


function parseTriState(value, fieldName) {
  if (value === undefined || value === null || value === 'unknown') return 'unknown';
  if (typeof value === 'boolean') return value;
  throw new TypeError(`${fieldName} must be boolean true, false, or 'unknown' under revision 58.`);
}

function resolveHeadhaul(headhaul, fx, orderUnits, isR58 = false, isR59 = false) {
  if (!headhaul || typeof headhaul !== 'object') return { amount_usd: null, cny_derivation: null, a4_applied: null };
  const hasPerKgField = PER_KG_KEYS.some(key => Object.hasOwn(headhaul, key));
  if (!hasPerKgField) {
    return headhaul.bond_included === true && finite(headhaul.usd_per_unit) && headhaul.usd_per_unit > 0
      ? { amount_usd: isR58 ? headhaul.usd_per_unit : round(headhaul.usd_per_unit), cny_derivation: null, a4_applied: null }
      : { amount_usd: null, cny_derivation: null, a4_applied: null };
  }
  if (Object.hasOwn(headhaul, 'usd_per_unit')) return { amount_usd: null, cny_derivation: null, a4_applied: null };
  return computeHeadhaulWithA4Rules(headhaul, fx, orderUnits, { isR58, isR59 });
}

function resolveRequiredMonths(operatingPeriod, operatingMonths, isR58, isR59 = false, feeContext = null) {
  let months = null;
  if (operatingMonths !== undefined) {
    if (!Array.isArray(operatingMonths) || !operatingMonths.length ||
      operatingMonths.some(month => !Number.isInteger(month) || month < 1 || month > 12)) {
      return { valid: false, months: null, explicitFullPeriod: null };
    }
    months = [...new Set(operatingMonths)];
  }
  const canonicalR59OffPeak = isR59 &&
    isCanonical2027OffPeakWin(feeContext?.sales) &&
    isCanonical2027OffPeakStorageWin(feeContext?.storage);
  const canonicalR59Peak = isR59 && isCanonical2027PeakWin(feeContext?.sales);
  let explicitFullPeriod = null;
  if (operatingPeriod !== undefined) {
    if (operatingPeriod === 'peak') {
      const allowedPeak = canonicalR59Peak ? [10, 11, 12, 1] : [10, 11, 12];
      if (months && ([10, 11, 12].some(month => !months.includes(month)) || months.some(month => !allowedPeak.includes(month)))) {
        return { valid: false, months: null, explicitFullPeriod: null };
      }
      months = months ?? [10, 11, 12];
      explicitFullPeriod = 'peak';
    } else if (operatingPeriod === 'off_peak') {
      const forbiddenOffPeak = canonicalR59OffPeak ? [11, 12] : [10, 11, 12];
      if (months && months.some(month => forbiddenOffPeak.includes(month))) {
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
  return { valid: true, months, explicitFullPeriod, canonicalR59OffPeak, canonicalR59Peak };
}

function resolveDateContextR58({ operating_period, operating_months, sales_window, fee_context }, isR59 = false) {
  const periodSpec = resolveRequiredMonths(operating_period, operating_months, true, isR59, fee_context);
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
  const canonicalR59Peak = Boolean(periodSpec.canonicalR59Peak && isCanonical2027PeakStorageWin(storageWin));
  const year = salesWin.from.slice(0, 4);
  if (!canonicalR59Peak && (salesWin.through.slice(0, 4) !== year || storageWin.from.slice(0, 4) !== year || storageWin.through.slice(0, 4) !== year)) {
    return { valid: false, reason: 'Sales and storage windows must fall within one target calendar year.' };
  }
  const salesMonths = monthsIn(salesWin);
  const storageMonths = monthsIn(storageWin);
  const required = periodSpec.months;
  const r59OffPeakMonthsOk = Boolean(periodSpec.canonicalR59OffPeak &&
    [2, 3, 4, 5, 6, 7, 8, 9].every(m => required.includes(m)) &&
    required.every(m => m >= 2 && m <= 10));
  const r59PeakMonthsOk = Boolean(canonicalR59Peak &&
    [10, 11, 12].every(m => required.includes(m)) &&
    required.every(m => [10, 11, 12, 1].includes(m)));
  if (!r59OffPeakMonthsOk && !r59PeakMonthsOk && (
    salesMonths.some(m => !required.includes(m)) || required.some(m => !salesMonths.includes(m)) ||
    storageMonths.some(m => !required.includes(m)) || required.some(m => !storageMonths.includes(m))
  )) {
    return { valid: false, reason: 'Sales and storage windows must exactly cover every month declared in the operating period.' };
  }
  if (periodSpec.explicitFullPeriod === 'annual') {
    if (salesWin.from !== `${year}-01-01` || salesWin.through !== `${year}-12-31` ||
      storageWin.from !== `${year}-01-01` || storageWin.through !== `${year}-12-31`) {
      return { valid: false, reason: 'Annual operating period must cover all days of the target calendar year (YYYY-01-01..YYYY-12-31).' };
    }
  } else if (periodSpec.explicitFullPeriod === 'off_peak') {
    const validLegacyOffPeak = salesWin.from === `${year}-02-01` && salesWin.through === `${year}-09-30` &&
      storageWin.from === `${year}-02-01` && storageWin.through === `${year}-09-30`;
    const validR59OffPeak = isR59 && periodSpec.canonicalR59OffPeak;
    if (!validLegacyOffPeak && !validR59OffPeak) {
      return {
        valid: false,
        reason: isR59
          ? 'Default off_peak operating period requires sales 2027-02-01..2027-10-14 with storage 2027-02-01..2027-09-30 (or historical YYYY-02-01..YYYY-09-30).'
          : 'Default off_peak operating period must cover full Feb 1 through Sep 30.',
      };
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
    const effectiveMonths = monthsIn(win);
    if (effectiveMonths.some(m => !basis.months.includes(m))) return false;
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

function resolveFulfillmentUsd(fulfillmentUsd, { sales_window, fee_context, fulfillment_fee_basis, operating_period, operating_months, rawInput }, dateCtxR58, registeredIds = null, expectedPackageRef = null) {
  if (!finite(fulfillmentUsd) || fulfillmentUsd <= 0) return null;
  if (dateCtxR58) {
    if (!dateCtxR58.valid) return null;
    const salesWin = dateCtxR58.salesWin;
    if (salesWin.through > '2027-10-14' && hasProhibited2026PeakExtrapolation({ fee_basis: fulfillment_fee_basis }, rawInput)) {
      return null;
    }
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
  const rev = input.profile_revision ?? options.profileRevision ?? 59;
  if (!Number.isInteger(rev) || rev < 59) throw new TypeError('profileRevision must be an integer >= 59 (r50-r58 retired; see archive/r50-r58-frozen-replay-20261125).');
  const isR58 = rev >= 58;
  const isR59 = rev >= 59;

  const {
    id = 'early-screen',
    saleable_unit,
    price_usd: rawPriceUsd,
    list_price_usd = undefined,
    net_effective_price_usd = undefined,
    ongoing_coupon_usd = undefined,
    ongoing_coupon_pct = undefined,
    prime_exclusive_discount_usd = undefined,
    prime_exclusive_discount_pct = undefined,
    promo_basis_already_net = false,
    minimum_price_usd = BUSINESS_THRESHOLDS.minimum_reference_price_usd,
    margin_floor = BUSINESS_THRESHOLDS.pre_ad_margin_floor,
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
  const pricing = isR58
    ? resolveEffectivePricing({
      price_usd: rawPriceUsd,
      list_price_usd,
      net_effective_price_usd,
      ongoing_coupon_usd,
      ongoing_coupon_pct,
      prime_exclusive_discount_usd,
      prime_exclusive_discount_pct,
      promo_basis_already_net,
    })
    : null;
  if (isR58 && !pricing.valid && (list_price_usd !== undefined || net_effective_price_usd !== undefined ||
    ongoing_coupon_usd !== undefined || ongoing_coupon_pct !== undefined ||
    prime_exclusive_discount_usd !== undefined || prime_exclusive_discount_pct !== undefined ||
    promo_basis_already_net === true)) {
    throw new TypeError(pricing.reason);
  }
  const price_usd = isR58 && pricing?.valid ? pricing.net_effective_price_usd : rawPriceUsd;
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
      orderPlan = computeOrderPlan({
        sku_lines: activeSkuLines,
        min_sets: 100,
        allow_remainder,
        target_sets,
        lcm_cap: input?.lcm_cap,
        profile_revision: rev,
      });
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
  const dateCtxR58 = isR58 ? resolveDateContextR58({ operating_period, operating_months, sales_window, fee_context }, isR59) : null;
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

  const headhaulRes = resolveHeadhaul(headhaul, fx, order_units, isR58, isR59);
  const headhaulUsd = headhaulRes.amount_usd;
  const storageUsd = resolveStorageUsd(storage, dateCtxR58, storage_fee_basis, registeredIds, expectedPackageRef, effectivePkg, {
    is_oversize: input.is_oversize, is_dangerous_goods: input.is_dangerous_goods, packages: input.packages,
    overCheck: overCheckR58, dgCheck: dgCheckR58, badPackages: badPackagesR58,
  });
  let resolvedPlacementUsd = resolvePlacementUsd(placement_usd, dateCtxR58, placement_fee_basis, registeredIds, expectedPackageRef);
  let resolvedFulfillmentUsd = resolveFulfillmentUsd(fulfillment_usd, {
    sales_window, fee_context, fulfillment_fee_basis, operating_period, operating_months, rawInput: input,
  }, dateCtxR58, registeredIds, expectedPackageRef);
  if (isR59 && resolvedPlacementUsd !== null) {
    const splitOpt = input.placement_split_option ?? placement_fee_basis?.split_option ?? null;
    const pkgTier = effectivePkg
      ? classifySizeTier2027(effectivePkg, { is_apparel: is_apparel_or_shoes, is_dangerous_goods: dgCheckR58.value === true })
      : null;
    const declaredEarlyTier = String(
      placement_fee_basis?.size_tier ??
      fulfillment_fee_basis?.size_tier ??
      input.size_tier ??
      '',
    ).trim().toLowerCase();
    const isConfirmedOversize = overCheckR58.value === true ||
      pkgTier?.tier_family === 'oversize' ||
      (declaredEarlyTier.includes('oversize') && (!pkgTier || pkgTier.tier_family === 'oversize')) ||
      (placement_fee_basis?.exempt_oversize_tier === true && (!pkgTier || pkgTier.tier_family === 'oversize'));
    const hasEarlyNonOversizeEvidence =
      Boolean(effectivePkg) ||
      overCheckR58.value === false ||
      (declaredEarlyTier.length > 0 && !declaredEarlyTier.includes('oversize'));
    if (!isConfirmedOversize &&
      (splitOpt === 'amazon_optimized' || (hasEarlyNonOversizeEvidence && round(resolvedPlacementUsd) === 0))) {
      const optOk = isAmazonOptimizedPlacementVerified2027({
        identical_cartons_count: input.identical_cartons_count ?? placement_fee_basis?.identical_cartons_count ?? null,
        multi_destination_headhaul_verified: input.multi_destination_headhaul_verified ?? placement_fee_basis?.multi_destination_headhaul_verified ?? false,
      });
      if (!optOk) resolvedPlacementUsd = null;
    }
  }
  if (isR59 && resolvedFulfillmentUsd !== null && pricing?.valid) {
    const hasCouponNoPrime = (
      (pricing.ongoing_coupon_usd ?? 0) > 0 ||
      (pricing.ongoing_coupon_pct ?? 0) > 0 ||
      (finite(input.coupon_redemption_fee_usd) && input.coupon_redemption_fee_usd > 0)
    ) && !((pricing.prime_exclusive_discount_usd ?? 0) > 0 || (pricing.prime_exclusive_discount_pct ?? 0) > 0);
    if (hasCouponNoPrime && finite(pricing.list_price_usd) &&
      priceBand2027(pricing.list_price_usd) !== priceBand2027(price_usd) &&
      fulfillment_fee_basis?.sp_api_calibrated !== true &&
      fulfillment_fee_basis?.calculator_verified !== true) {
      if (fulfillment_fee_basis?.price_band === priceBand2027(price_usd)) {
        resolvedFulfillmentUsd = null;
      } else if (effectivePkg && dateCtxR58?.valid &&
        dateCtxR58.salesWin.from >= '2027-01-15' && dateCtxR58.salesWin.through <= '2027-10-14') {
        const expectedListFul = lookupUnifiedFulfillmentFee2027({
          pkg: effectivePkg,
          price_usd,
          list_price_usd: pricing.list_price_usd,
          has_ongoing_coupon: true,
          has_prime_discount: false,
          sales_window: dateCtxR58.salesWin,
          is_apparel: input.is_apparel,
          is_shoes: input.is_shoes,
          is_apparel_or_shoes,
          is_dangerous_goods: dgCheckR58.value === true,
          is_sipp: input.is_sipp,
          requires_amazon_packaging: input.requires_amazon_packaging,
          fee_category: fee_category ?? null,
        });
        if (expectedListFul.status === 'verified' && resolvedFulfillmentUsd < expectedListFul.total_usd - 0.005) {
          resolvedFulfillmentUsd = null;
        }
      }
    }
  }

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
    ? resolveConsistentFeeCategory([returns_processing_fee_basis?.fee_category, fee_category])
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
    const minRetStart = is_apparel_or_shoes && isR59 ? '2027-01-15' : '2027-02-01';
    const maxRetEnd = isR59 ? '2028-01-14' : '2027-12-31';
    const in2027RetWindow = Boolean(dateCtxR58?.valid && dateCtxR58.salesWin.from >= minRetStart && dateCtxR58.salesWin.through <= maxRetEnd);
    const verifiedPerRet = (!is_apparel_or_shoes || isR59) && (in2027RetWindow || isOfficial2027RetVersion)
      ? lookupVerified2027PerReturnFee(effectivePkg, { isApparelOrShoes: is_apparel_or_shoes, allowAll2027Tiers: isR59 })
      : null;
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

  const computedCouponFeeR59 = isR59
    ? computeAmazonCouponRedemptionFee2027({
      net_effective_price_usd: price_usd,
      ongoing_coupon_usd,
      ongoing_coupon_pct,
      coupon_redemption_share: input.coupon_redemption_share ?? 1,
      coupon_campaign_units: input.coupon_campaign_units ?? (Number.isSafeInteger(order_units) && order_units >= 100 ? order_units : 100),
      include_campaign_flat_usd: input.include_coupon_campaign_flat !== false,
    })
    : { applicable: false, per_unit_usd: 0 };
  const explicitCouponFeeUsd = isR59 && finite(input.coupon_redemption_fee_usd) && input.coupon_redemption_fee_usd > 0
    ? round(input.coupon_redemption_fee_usd)
    : 0;
  const requiredCouponFeeUsd = Math.max(
    computedCouponFeeR59.applicable && computedCouponFeeR59.per_unit_usd > 0 ? computedCouponFeeR59.per_unit_usd : 0,
    explicitCouponFeeUsd,
  );
  const couponAlreadyInOther = Boolean(
    input.coupon_fee_already_in_other === true &&
    resolvedOtherApplicable !== null &&
    resolvedOtherApplicable >= requiredCouponFeeUsd - 1e-6,
  );
  const couponFeeUsd = !couponAlreadyInOther ? requiredCouponFeeUsd : 0;
  const effectiveOtherWithCoupon = resolvedOtherApplicable === null
    ? null
    : round(resolvedOtherApplicable + couponFeeUsd);
  const predeclaredAmazonCouponInExternal = couponAlreadyInOther && other_payee !== 'amazon' && requiredCouponFeeUsd > 0
    ? requiredCouponFeeUsd
    : 0;

  const amazonKnown = referral !== null && collectionRateValid &&
    [resolvedFulfillmentUsd, resolvedPlacementUsd, storageUsd, resolvedReturnsProcessing,
      other_payee === 'amazon' ? resolvedOtherApplicable : 0]
      .every(value => finite(value) && value >= 0) &&
    (defer_return_outcomes || (finite(returns_disposal_usd) && returns_disposal_usd >= 0));
  const amazonDeductions = amazonKnown
    ? [referral.net_usd, resolvedFulfillmentUsd, resolvedPlacementUsd, storageUsd, resolvedReturnsProcessing,
      ...(defer_return_outcomes ? [] : [returns_disposal_usd]),
      ...(couponFeeUsd > 0 ? [couponFeeUsd] : (predeclaredAmazonCouponInExternal > 0 ? [predeclaredAmazonCouponInExternal] : [])),
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
    {
      ...line('other_applicable', effectiveOtherWithCoupon,
        effectiveOtherWithCoupon === 0 ? 'Declared ordinary scenario has no extra conditional charge' : effectiveOtherWithCoupon === null ? 'Missing other_applicable_usd declaration' : (requiredCouponFeeUsd > 0 ? 'Amazon ongoing coupon redemption fee ($5/100 + 2.5%) plus declared conditional charges' : 'Additional applicable charge'),
        effectiveOtherWithCoupon === 0 ? 'not_applicable' : effectiveOtherWithCoupon === null ? 'pending' : 'estimated'),
      ...(requiredCouponFeeUsd > 0 ? {
        coupon_fee_included: true,
        ...(other_payee === 'amazon' || (couponFeeUsd > 0 && (resolvedOtherApplicable ?? 0) === 0)
          ? { payee: 'amazon' }
          : { payee: other_payee, amazon_portion_usd: requiredCouponFeeUsd }),
      } : {}),
    },
    defer_return_outcomes
      ? { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Paired return disposition and recovery deferred in initial screen' }
      : line('recovery_credit', finite(recovery_credit_usd) && recovery_credit_usd >= 0 ? round(recovery_credit_usd) : null, 'Salvage recovery credit',
        recovery_credit_usd === 0 ? 'not_applicable' : 'estimated'),
  ];

  const ledger = calculateEconomics(
    {
      id, saleable_unit, price_usd, refund_fraction,
      ...(isR59 && requiredCouponFeeUsd > 0 ? {
        coupon_redemption_fee_usd: requiredCouponFeeUsd,
        coupon_fee_already_in_other: true,
      } : {}),
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
  if (isR58 && !isR59 && pricePass && rightsState !== true && marginComplete && !marginPass && procurementUsd !== null && domesticUsd !== null) {
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

  let packagingRedesignShortlist = null;
  if (isR59 && pricePass && rightsState !== true && marginComplete && !marginPass &&
    procurementUsd !== null && domesticUsd !== null && effectivePkg && referral !== null &&
    collectionRateValid && headhaulUsd !== null && finite(fx) && fx > 0 && dateCtxR58?.valid &&
    dateCtxR58.salesWin.from >= '2027-01-15' && dateCtxR58.salesWin.through <= '2027-10-14') {
    const pkgCheck = computePackagingRedesignShortlist2027({
      pkg: effectivePkg,
      price_usd,
      list_price_usd: pricing?.valid ? pricing.list_price_usd : input.list_price_usd,
      net_effective_price_usd: price_usd,
      ongoing_coupon_usd: input.ongoing_coupon_usd,
      ongoing_coupon_pct: input.ongoing_coupon_pct,
      coupon_redemption_fee_usd: requiredCouponFeeUsd > 0 ? requiredCouponFeeUsd : undefined,
      prime_exclusive_discount_usd: input.prime_exclusive_discount_usd,
      prime_exclusive_discount_pct: input.prime_exclusive_discount_pct,
      promo_basis_already_net: true,
      fx_cny_per_usd: fx,
      landed_domestic_usd: round(procurementUsd + domesticUsd),
      refund_fraction,
      physical_return_fraction: rPhysical,
      fee_category: catCheck.present && catCheck.valid ? catCheck.value : fee_category,
      return_threshold: hasThreshold ? effectiveThreshold : null,
      referral_terms,
      headhaul_usd: headhaulUsd,
      collection_rate,
      other_applicable_usd: couponAlreadyInOther
        ? Math.max(0, round((resolvedOtherApplicable ?? 0) - requiredCouponFeeUsd))
        : (resolvedOtherApplicable ?? 0),
      other_payee,
      placement_split_option: input.placement_split_option ?? placement_fee_basis?.split_option,
      identical_cartons_count: input.identical_cartons_count ?? placement_fee_basis?.identical_cartons_count,
      multi_destination_headhaul_verified: input.multi_destination_headhaul_verified ?? placement_fee_basis?.multi_destination_headhaul_verified,
      sales_window: dateCtxR58.salesWin,
      storage_window: dateCtxR58.storageWin,
      inbound_window: dateCtxR58.inboundWin,
      average_inventory_days: storage && typeof storage === 'object' && finite(storage.average_inventory_days) ? storage.average_inventory_days : 45,
      is_apparel: input.is_apparel,
      is_shoes: input.is_shoes,
      is_apparel_or_shoes,
      is_dangerous_goods: dgCheckR58.value === true,
      is_sipp: input.is_sipp,
      requires_amazon_packaging: input.requires_amazon_packaging,
      minimum_price_usd,
      min_retail_price_usd: minimum_price_usd,
      margin_floor,
    });
    packagingRedesignShortlist = pkgCheck;
  }

  return {
    gate_status: gateStatus,
    proceed_to_21_items: gateStatus === 'pass',
    ...(isR58 ? {
      proceed_to_gate2: gateStatus === 'pass' || gateStatus === 'economic_pass_rights_unsearched',
      profile_revision: rev,
      order_plan: orderPlan,
      returns_processing_components: returnsComponents,
      ...(!isR59 ? { negotiation_shortlist: negotiationShortlist } : {}),
      ...(isR59 ? {
        ...(headhaulRes.a4_applied ? { headhaul_a4_applied: headhaulRes.a4_applied } : {}),
        packaging_redesign_shortlist: packagingRedesignShortlist,
        target_goods_cny_for_30pct: procurementCap !== null && finite(fx) && fx > 0 ? Math.max(0, Math.round(procurementCap * fx * 100) / 100) : null,
        second_factory_quote_needed: !marginComplete ? null : !marginPass,
        second_factory_quote_note: !marginComplete
          ? null
          : marginPass
            ? '首家齐套 1688 报价毛利已过 30% 红线，直接停手过关，无需再多刷工厂防撞滑块。'
            : '当前工厂报价毛利 < 30%，建议补查更便宜的第 2 家（最多第 3 家）靠谱齐套厂。',
      } : {}),
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

