// Validate declared source applicability. This module does not fetch or invent rates.
const text = value => typeof value === 'string' && value.trim().length > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const windowValid = value => date(value?.from) && date(value?.through) && value.from <= value.through;
const FEE_WINDOWS = Object.freeze({ referral: 'sales', fulfillment: 'sales', placement: 'inbound',
  storage: 'storage', returns_processing: 'sales', other_applicable: 'sales' });

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

export function validateFeeBasis(input, { evidenceIds = [], operatingMonths } = {}) {
  const context = input.fee_context;
  const sources = new Set(evidenceIds);
  const evidenced = refs => Array.isArray(refs) && refs.length > 0 && refs.every(id => text(id) && sources.has(id));
  const issues = [];
  const components = new Map();
  const add = (line, code, reason) => issues.push({ line, code, reason });
  const validContext = context?.marketplace === 'US' && context?.currency === 'USD' && text(context?.package_ref) &&
    ['sales', 'storage', 'inbound'].every(key => windowValid(context[key]));
  if (!validContext) add('context', 'missing_fee_context', 'US/USD, one package reference and explicit valid sales, storage and inbound date windows are required.');
  else if (operatingMonths && monthsIn(context.sales).some(month => !operatingMonths.includes(month))) {
    add('context', 'operating_period_mismatch', 'The dated sales window extends beyond the displayed operating-period months.');
  }
  for (const line of input.lines) {
    if (!evidenced(line.evidence)) add(line.id, 'missing_cost_evidence', 'The cost needs registered source evidence, including any explicit zero or deferral.');
    if (line.id === 'domestic_freight' && line.status === 'deferred') {
      add(line.id, 'domestic_quote_required', 'The current 100-purchased-unit scope requires a domestic-delivery quote; the historical deferral cannot be reused.');
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
    if (!validContext) continue;
    if (basis.marketplace !== context.marketplace || basis.currency !== context.currency || basis.package_ref !== context.package_ref) {
      add(line.id, 'fee_scope_mismatch', 'Fee marketplace, currency or packaged-unit reference differs from the cost scenario.');
    }
    const target = context[FEE_WINDOWS[line.id]];
    if (target.from < basis.effective_from || (basis.effective_through !== null && target.through > basis.effective_through)) {
      add(line.id, 'fee_outside_dates', `${line.id}: target ${target.from}..${target.through} is outside ${basis.version} (${basis.effective_from}..${basis.effective_through ?? 'open'}).`);
    }
    if (basis.months !== undefined && (!Array.isArray(basis.months) || !basis.months.length ||
      basis.months.some(month => !Number.isInteger(month) || month < 1 || month > 12) ||
      monthsIn(target).some(month => !basis.months.includes(month)))) {
      add(line.id, 'fee_season_mismatch', `${line.id}: the target months are not covered by the declared seasonal rate.`);
    }
  }
  return { status: issues.length ? 'needs_evidence' : 'validated', context: context ?? null, issues };
}
