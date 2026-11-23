/** Offline cost ledger. No rate defaults, network requests, or account actions. */
import {
  validateFeeBasis,
  validateSkuLinesR58,
  resolveConsistentSkuLines,
  resolveConsistentText,
  resolveConsistentFeeCategory,
  resolveConsistentPkgWeightLb,
  resolveUniquePackageByRef,
  resolveEffectivePricing,
  collectLedgerFlag,
  isOfficial2027ScheduleWindowValid,
  lookupVerified2027ReturnThreshold,
  lookupVerified2027PerReturnFee,
  storageMeets2027Floor,
  toBigRat,
  addBigRat,
  mulBigRat,
  divBigRat,
  roundBigRat,
} from './fee-basis.mjs';
export const REQUIRED_COSTS = Object.freeze([
  'procurement', 'domestic_freight', 'headhaul', 'referral', 'fulfillment',
  'placement', 'storage', 'returns_processing', 'returns_disposal',
  'collection', 'other_applicable', 'recovery_credit',
]);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n) => Math.round((n + Number.EPSILON) * 1e10) / 1e10;
const VERIFIED_LINE_RATIONALS = new WeakMap();

function toDecimalParts(n) {
  if (!finite(n)) throw new TypeError('Finite number required');
  const [mantissa, expPart = '0'] = n.toString().toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const [intPart, fracPart = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = BigInt(intPart + fracPart);
  const exp = Number(expPart) - fracPart.length;
  return exp >= 0 ? { num: sign * digits * (10n ** BigInt(exp)), scale: 0 } : { num: sign * digits, scale: -exp };
}

function gcdBig(a, b) {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x === 0n ? 1n : x;
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

function deriveExactCnyLineRat(lineId, deriv) {
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
  if (lineId === 'headhaul' && finite(deriv.chargeable_kg_per_unit) && deriv.chargeable_kg_per_unit > 0 &&
    finite(deriv.rate_cny_per_kg) && deriv.rate_cny_per_kg >= 0 &&
    finite(deriv.surcharge_cny_per_kg) && deriv.surcharge_cny_per_kg >= 0) {
    const kgR = toBigRat(deriv.chargeable_kg_per_unit);
    const baseR = mulBigRat(kgR, addBigRat(toBigRat(deriv.rate_cny_per_kg), toBigRat(deriv.surcharge_cny_per_kg)));
    let bondR = null;
    if (finite(deriv.bond_cny_per_kg) && deriv.bond_cny_per_kg >= 0) {
      bondR = mulBigRat(kgR, toBigRat(deriv.bond_cny_per_kg));
    } else if (finite(deriv.bond_cny_per_shipment) && deriv.bond_cny_per_shipment >= 0 &&
      Number.isSafeInteger(deriv.order_units) && deriv.order_units > 0) {
      bondR = divBigRat(toBigRat(deriv.bond_cny_per_shipment), toBigRat(deriv.order_units));
    }
    if (!bondR) return null;
    const totalCnyR = addBigRat(baseR, bondR);
    return totalCnyR.n > 0n ? divBigRat(totalCnyR, fxR) : null;
  }
  return null;
}
function fraction(n, name) {
  if (!finite(n) || n < 0 || n >= 1) throw new TypeError(`${name} must be a fraction in [0,1)`);
}

export function netReferral(input) {
  const { price_usd: p, refund_fraction: r, referral_fraction: f,
    refund_admin_fraction: a, refund_admin_cap_usd: cap, minimum_referral_usd: minFee = 0 } = input;
  if (!finite(p) || p <= 0 || !finite(cap) || cap < 0 || !finite(minFee) || minFee < 0) {
    throw new TypeError('Invalid price, minimum referral or refund administration cap');
  }
  fraction(r, 'refund_fraction'); fraction(f, 'referral_fraction'); fraction(a, 'refund_admin_fraction');
  const gross = Math.max(minFee, p * f), credit = gross * r, admin = Math.min(cap, gross * a) * r;
  return { gross_usd: round(gross), refund_credit_usd: round(credit),
    administration_usd: round(admin), net_usd: round(gross - credit + admin) };
}

/** Per-unit estimate of collection on Amazon payout, never on revenue or profit. */
export function collectionFromDisbursement({ net_revenue_usd, amazon_deductions_usd, rate }) {
  if (!finite(net_revenue_usd) || net_revenue_usd < 0 || !Array.isArray(amazon_deductions_usd) ||
    amazon_deductions_usd.some(n => !finite(n) || n < 0)) throw new TypeError('Known nonnegative Amazon payout components required');
  fraction(rate, 'collection rate');
  const deductions = amazon_deductions_usd.reduce((sum, n) => sum + n, 0);
  if (!finite(deductions)) throw new TypeError('Amazon deductions exceed finite numeric range');
  const base = Math.max(0, net_revenue_usd - deductions);
  return { estimated_disbursement_usd: round(base), collection_usd: round(base * rate), rate,
    basis: 'Per-unit payout estimate before collection; excludes off-Amazon procurement, freight and noncash inventory recoveries. Actual account disbursement requires settlement reconciliation.' };
}

export function calculateEconomics(input, options = {}) {
  const isR57Plus = (options.profileRevision ?? 0) >= 57;
  const isR58Plus = (options.profileRevision ?? 0) >= 58;
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
  let r58StorageInvalid = false;
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
        const derivedRat = deriveExactCnyLineRat(lineId, deriv);
        if (derivedRat) {
          targetLine.amount_usd = roundBigRat(derivedRat.n, derivedRat.d, 10);
          targetLine.exact_usd_rational = { num: derivedRat.n.toString(), den: derivedRat.d.toString() };
          VERIFIED_LINE_RATIONALS.set(targetLine, derivedRat);
        }
      }
    }

    const pkgRef = input?.fee_context?.package_ref;
    const pkgRes = resolveUniquePackageByRef(input?.packages, pkgRef);
    const matchedPkg = pkgRes.pkg;
    if (pkgRes.present && !pkgRes.valid) {
      r58StorageInvalid = true;
      r58ReturnsInvalid = true;
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
    const in2027RetSchedule = Boolean(salesWin?.from && salesWin?.through && salesWin.from >= '2027-02-01' && salesWin.through <= '2027-12-31');
    const verifiedPerRet = !isApparel && (in2027RetSchedule || isOfficial2027RetVersion) ? lookupVerified2027PerReturnFee(matchedPkg) : null;
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
      amazon_deductions_usd: amazonDeductions.filter(key => !deferred.includes(key)).map(key => map.get(key).amount_usd) });
    const collection = map.get('collection');
    if (collection.status === 'not_applicable' && payoutComponents.collection_usd !== 0) throw new TypeError('Collection rate contradicts a not-applicable collection line.');
    collection.amount_usd = payoutComponents.collection_usd;
    if (isR57Plus) {
      collection.components = [...new Set([...(Array.isArray(collection.components) ? collection.components : []), 'payment_collection'])];
    }
  }
  const validation = options.requireFeeBasis
    ? validateFeeBasis({ ...input, lines }, { ...options, requireRegularRepeatOrder: Boolean(options.requireRegularRepeatOrder || isR57Plus) })
    : null;
  const invalid = new Set(validation?.issues.map(issue => issue.line) ?? []);
  const pending = REQUIRED_COSTS.filter(k => !deferred.includes(k) &&
    (!map.has(k) || map.get(k).amount_usd === null || map.get(k).status === 'pending'));
  if (r58ProcInvalid && !pending.includes('procurement')) pending.push('procurement');
  if (r58StorageInvalid && !pending.includes('storage')) pending.push('storage');
  if (r58ReturnsInvalid && !pending.includes('returns_processing')) pending.push('returns_processing');
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
