/** Offline cost ledger. No rate defaults, network requests, or account actions. */
import { validateFeeBasis } from './fee-basis.mjs';
export const REQUIRED_COSTS = Object.freeze([
  'procurement', 'domestic_freight', 'headhaul', 'referral', 'fulfillment',
  'placement', 'storage', 'returns_processing', 'returns_disposal',
  'collection', 'other_applicable', 'recovery_credit',
]);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n) => Math.round((n + Number.EPSILON) * 1e10) / 1e10;
function fraction(n, name) {
  if (!finite(n) || n < 0 || n >= 1) throw new TypeError(`${name} must be a fraction in [0,1)`);
}

export function netReferral(input) {
  const { price_usd: p, refund_fraction: r, referral_fraction: f,
    refund_admin_fraction: a, refund_admin_cap_usd: cap } = input;
  if (!finite(p) || p <= 0 || !finite(cap) || cap < 0) throw new TypeError('Invalid price or refund administration cap');
  fraction(r, 'refund_fraction'); fraction(f, 'referral_fraction'); fraction(a, 'refund_admin_fraction');
  const gross = p * f, credit = gross * r, admin = Math.min(cap, gross * a) * r;
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
  const { id, saleable_unit, price_usd: p, refund_fraction: r, assumptions } = input;
  if (!id || !saleable_unit || !finite(p) || p <= 0 || !Array.isArray(input.lines) ||
    !Array.isArray(assumptions) || !assumptions.length) throw new TypeError('A coherent named saleable-unit scenario is required');
  const lines = input.lines.map(line => ({ ...line }));
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
  let refundComponents = null, payoutComponents = null;
  const amazonDeductions = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'returns_disposal'];
  if (options.requireFeeBasis) {
    refundComponents = netReferral({ ...input.referral_terms, price_usd: p, refund_fraction: r });
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
  if (options.requireFeeBasis && map.has('collection') &&
    amazonDeductions.every(key => deferred.includes(key) || (map.has(key) && finite(map.get(key).amount_usd) && map.get(key).status !== 'pending'))) {
    payoutComponents = collectionFromDisbursement({ net_revenue_usd: p * (1 - r), rate: input.collection_rate,
      amazon_deductions_usd: amazonDeductions.filter(key => !deferred.includes(key)).map(key => map.get(key).amount_usd) });
    const collection = map.get('collection');
    if (collection.status === 'not_applicable' && payoutComponents.collection_usd !== 0) throw new TypeError('Collection rate contradicts a not-applicable collection line.');
    collection.amount_usd = payoutComponents.collection_usd;
  }
  const validation = options.requireFeeBasis ? validateFeeBasis({ ...input, lines }, options) : null;
  const invalid = new Set(validation?.issues.map(issue => issue.line) ?? []);
  const pending = REQUIRED_COSTS.filter(k => !deferred.includes(k) &&
    (!map.has(k) || map.get(k).amount_usd === null || map.get(k).status === 'pending'));
  for (const key of REQUIRED_COSTS) {
    if (invalid.has(key) && !pending.includes(key)) pending.push(key);
  }
  // Payout-based collection cannot remain confirmed when an Amazon deduction is unknown.
  if (validation && (invalid.has('context') || [...amazonDeductions, 'other_applicable'].some(key => pending.includes(key))) &&
    !pending.includes('collection')) pending.push('collection');
  if (validation && pending.includes('collection')) payoutComponents = null;
  let known = 0;
  for (const [key, line] of map) {
    if (!pending.includes(key) && !deferred.includes(key)) known += (key === 'recovery_credit' ? -1 : 1) * line.amount_usd;
  }
  const net = p * (1 - r), complete = pending.length === 0 && !invalid.has('context');
  if (!finite(net) || net <= 0 || !finite(known)) throw new TypeError('Economic totals must remain finite with positive net revenue.');
  const cost = complete ? known : null, contribution = complete ? net - cost : null;
  const supported = complete && input.sensitivity_only !== true;
  return { id, saleable_unit, assumptions, lines, price_usd: p, refund_fraction: r,
    ...(validation ? { fee_validation: validation } : {}),
    ...(options.requireFeeBasis ? { refund_components: refundComponents, payout_components: payoutComponents } : {}),
    expected_refund_usd: round(p * r), net_revenue_usd: round(net),
    known_cost_usd: round(known), pending_lines: pending, deferred_lines: deferred,
    net_cost_usd: complete ? round(cost) : null,
    contribution_usd: complete ? round(contribution) : null,
    margin: complete ? contribution / net : null,
    advertising_15pct_usd: round(p * 0.15),
    advertising_scenario_contribution_usd: complete ? round(contribution - p * 0.15) : null,
    advertising_scenario_margin: complete ? (contribution - p * 0.15) / net : null,
    // This cap holds the supplied recovery credit fixed; it is not a procurement quote.
    procurement_cap_at_30pct_usd: complete ? round(net * 0.7 - (cost - map.get('procurement').amount_usd)) : null,
    scoring_supported: supported,
    status: !complete ? 'pending_costs' : !supported ? 'sensitivity_only' :
      deferred.includes('domestic_freight') ? 'initial_estimate_with_deferred_costs' :
        deferred.length ? 'initial_estimate_with_deferred_returns' : 'conditional_estimate',
  };
}
