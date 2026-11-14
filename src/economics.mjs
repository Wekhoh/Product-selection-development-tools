/** Offline cost ledger. No rate defaults, network requests, or account actions. */
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

export function calculateEconomics(input) {
  const { id, saleable_unit, price_usd: p, refund_fraction: r, lines, assumptions } = input;
  if (!id || !saleable_unit || !finite(p) || p <= 0 || !Array.isArray(lines) ||
    !Array.isArray(assumptions) || !assumptions.length) throw new TypeError('A coherent named saleable-unit scenario is required');
  fraction(r, 'refund_fraction');
  const map = new Map();
  for (const line of lines) {
    if (!REQUIRED_COSTS.includes(line.id) || map.has(line.id)) throw new TypeError(`Unknown or duplicate cost: ${line.id}`);
    if (!['sourced', 'estimated', 'not_applicable', 'pending'].includes(line.status) ||
      typeof line.basis !== 'string' || !line.basis.trim()) throw new TypeError(`Cost status and basis required: ${line.id}`);
    if (line.amount_usd !== null && (!finite(line.amount_usd) || line.amount_usd < 0)) throw new TypeError(`Invalid amount: ${line.id}`);
    if (line.status === 'not_applicable' && line.amount_usd !== 0) throw new TypeError(`Not-applicable cost must be explicit zero: ${line.id}`);
    map.set(line.id, line);
  }
  const pending = REQUIRED_COSTS.filter(k => !map.has(k) || map.get(k).amount_usd === null || map.get(k).status === 'pending');
  let known = 0;
  for (const [key, line] of map) {
    if (!pending.includes(key)) known += (key === 'recovery_credit' ? -1 : 1) * line.amount_usd;
  }
  const net = p * (1 - r), complete = pending.length === 0;
  const cost = complete ? known : null, contribution = complete ? net - cost : null;
  const supported = complete && input.sensitivity_only !== true;
  return { id, saleable_unit, assumptions, lines, price_usd: p, refund_fraction: r,
    expected_refund_usd: round(p * r), net_revenue_usd: round(net),
    known_cost_usd: round(known), pending_lines: pending,
    net_cost_usd: complete ? round(cost) : null,
    contribution_usd: complete ? round(contribution) : null,
    margin: complete ? contribution / net : null,
    advertising_15pct_usd: round(p * 0.15),
    advertising_scenario_contribution_usd: complete ? round(contribution - p * 0.15) : null,
    advertising_scenario_margin: complete ? (contribution - p * 0.15) / net : null,
    // This cap holds the supplied recovery credit fixed; it is not a procurement quote.
    procurement_cap_at_30pct_usd: complete ? round(net * 0.7 - (cost - map.get('procurement').amount_usd)) : null,
    scoring_supported: supported,
    status: !complete ? 'pending_costs' : supported ? 'conditional_estimate' : 'sensitivity_only',
  };
}
