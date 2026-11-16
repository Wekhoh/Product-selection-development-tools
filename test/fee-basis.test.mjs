import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEconomics } from '../src/economics.mjs';
import { readFileSync } from 'node:fs';
import { scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';

function ledger() {
  return {
    id: 'synthetic-dated-cost', saleable_unit: 'one synthetic set', price_usd: 50,
    refund_fraction: 0.04, assumptions: ['Synthetic dated cost example, not a real quote'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, collection_rate: 0.006,
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack',
      sales: { from: '2027-11-01', through: '2027-11-30' },
      storage: { from: '2027-11-01', through: '2027-11-30' },
      inbound: { from: '2027-10-20', through: '2027-10-20' } },
    lines: [
      ['procurement', 12.5], ['domestic_freight', 0], ['headhaul', 3],
      ['referral', 7.2], ['fulfillment', 5], ['placement', 1], ['storage', 0.5],
      ['returns_processing', 0.3], ['returns_disposal', 0], ['collection', 0.5],
      ['other_applicable', 0], ['recovery_credit', 0],
    ].map(([id, amount_usd]) => ({ id, amount_usd, status: 'estimated', basis: 'Synthetic fixture',
      evidence: ['synthetic-source'], components: [id],
      ...(['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'other_applicable'].includes(id)
        ? { fee_basis: { status: 'published', version: 'synthetic-2027', marketplace: 'US', currency: 'USD',
          package_ref: 'synthetic-pack', effective_from: '2027-01-01', effective_through: '2027-12-31',
          evidence: ['synthetic-source'] } } : {}) })),
  };
}
const strict = { requireFeeBasis: true, evidenceIds: ['synthetic-source'] };

test('a non-peak fulfillment rate cannot produce a confirmed November margin', () => {
  const input = ledger();
  input.lines.find(line => line.id === 'fulfillment').fee_basis.effective_through = '2027-10-14';
  const result = calculateEconomics(input, strict);
  assert.equal(result.margin, null);
  assert.equal(result.scoring_supported, false);
  assert.ok(result.pending_lines.includes('fulfillment'));
});

test('the current scorer recomputes the ledger and cannot trust a cached passing margin', () => {
  const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url)));
  profile.revision = profile.workflow.scoring_and_ordering.revision = 54;
  const candidate = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url))).candidates[0];
  candidate.evidence.push({ id: 'synthetic-source', source: 'Synthetic fees', observed_at: '2026-11-16' });
  const input = ledger();
  input.lines.find(line => line.id === 'fulfillment').fee_basis.effective_through = '2027-10-14';
  candidate.economics = { saleable_unit: input.saleable_unit, scenarios: [{ id: input.id,
    saleable_unit: input.saleable_unit, coherent: true, assumptions: input.assumptions,
    margin: { value: 0.7, unit: 'fraction', evidence: ['synthetic-source'] },
    contribution_usd: { value: 35, unit: 'USD', evidence: ['synthetic-source'] }, cost_ledger: input }] };
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.total, null);
  assert.equal(result.diagnostics.economics.margin_range, null);
  assert.match(result.diagnostics.economics.scenarios[0].eligibility_reason, /fulfillment/);
  input.fee_context.sales = input.fee_context.storage = { from: '2027-02-01', through: '2027-02-28' };
  const corrected = scoreCandidate(candidate, profile);
  assert.ok(Math.abs(corrected.diagnostics.economics.margin_range[0] - 0.3799241666666667) < 1e-10);
});

test('bond or refund administration cannot be included twice under different cost IDs', () => {
  for (const [owner, component] of [['headhaul', 'carrier_bond'], ['referral', 'refund_administration'], ['fulfillment', 'fuel_surcharge'], ['procurement', 'domestic_delivery']]) {
    const input = ledger();
    input.lines.find(line => line.id === owner).components.push(component);
    Object.assign(input.lines.find(line => line.id === 'other_applicable'), { amount_usd: 1, payee: 'amazon', components: [component] });
    const result = calculateEconomics(input, strict);
    assert.equal(result.margin, null);
    assert.ok(result.fee_validation.issues.some(issue => issue.code === 'duplicate_component'));
  }
});

test('dated ledgers recompute refund netting and payout-based collection from the same fees', () => {
  const input = ledger();
  input.lines.find(line => line.id === 'referral').amount_usd = 99;
  input.lines.find(line => line.id === 'collection').amount_usd = 99;
  const result = calculateEconomics(input, strict);
  assert.equal(result.refund_components.net_usd, 7.26);
  assert.equal(result.payout_components.collection_usd, 0.20364);
  assert.equal(result.net_cost_usd, 29.76364);
  assert.equal(result.contribution_usd, 18.23636);
  assert.equal(input.lines.find(line => line.id === 'referral').amount_usd, 99);
});

test('a recomputed collection charge is checked for duplication even when its cached amount was zero', () => {
  const input = ledger();
  input.lines.find(line => line.id === 'collection').amount_usd = 0;
  Object.assign(input.lines.find(line => line.id === 'other_applicable'), { amount_usd: 1, components: ['collection'], payee: 'external' });
  const out = calculateEconomics(input, strict);
  assert.equal(out.margin, null);
  assert.ok(out.fee_validation.issues.some(issue => issue.code === 'duplicate_component'));
});

test('a sourced external charge needs no Amazon fee schedule and is excluded from payout deductions', () => {
  const input = ledger();
  const other = input.lines.find(line => line.id === 'other_applicable');
  Object.assign(other, { amount_usd: 1, components: ['external_inspection'], payee: 'external' });
  delete other.fee_basis;
  const out = calculateEconomics(input, strict);
  assert.equal(out.scoring_supported, true);
  assert.equal(out.payout_components.collection_usd, 0.20364);
  assert.equal(out.net_cost_usd, 30.76364);
});

test('source, year, season and packaged-unit gaps remain named gaps rather than zero fees', () => {
  const mutations = [
    ['unpublished_fee', input => { input.lines.find(l => l.id === 'fulfillment').fee_basis.status = 'unavailable'; }],
    ['fee_outside_dates', input => { input.lines.find(l => l.id === 'fulfillment').fee_basis.effective_through = '2027-01-14'; }],
    ['fee_outside_dates', input => { input.lines.find(l => l.id === 'placement').fee_basis.effective_from = '2027-11-01'; }],
    ['fee_season_mismatch', input => { input.lines.find(l => l.id === 'storage').fee_basis.months = [1,2,3,4,5,6,7,8,9]; }],
    ['fee_scope_mismatch', input => { input.lines.find(l => l.id === 'fulfillment').fee_basis.package_ref = 'single-unit-not-a-set'; }],
    ['invalid_fee_basis', input => { input.lines.find(l => l.id === 'fulfillment').fee_basis.evidence = ['unknown-source']; }],
    ['missing_cost_evidence', input => { input.lines.find(l => l.id === 'procurement').evidence = []; }],
    ['missing_fee_context', input => { input.fee_context.storage.from = '2027-02-30'; }],
    ['domestic_quote_required', input => { Object.assign(input.lines.find(l => l.id === 'domestic_freight'), { status: 'deferred', amount_usd: null }); }],
  ];
  for (const [code, mutate] of mutations) {
    const input = ledger(); mutate(input);
    const out = calculateEconomics(input, strict);
    assert.equal(out.margin, null, code);
    assert.equal(out.scoring_supported, false, code);
    assert.ok(out.fee_validation.issues.some(issue => issue.code === code), code);
  }
});

test('different effective dates are valid when each fee covers its own event window', () => {
  const input = ledger();
  input.fee_context.sales = input.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  input.fee_context.inbound = { from: '2027-01-20', through: '2027-01-20' };
  Object.assign(input.lines.find(l => l.id === 'fulfillment').fee_basis, { effective_from: '2027-01-15', effective_through: '2027-10-14' });
  Object.assign(input.lines.find(l => l.id === 'storage').fee_basis, { effective_from: '2027-02-01', months: [1,2,3,4,5,6,7,8,9] });
  input.lines.find(l => l.id === 'placement').fee_basis.effective_from = '2027-01-15';
  assert.equal(calculateEconomics(input, strict).scoring_supported, true);
  input.fee_context.storage.from = '2027-01-31';
  assert.ok(calculateEconomics(input, strict).pending_lines.includes('storage'));
});

test('a complete off-peak plan survives an unknown holiday rate, and the card exposes the actual ledger', () => {
  const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url)));
  const candidate = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url))).candidates[0];
  const off = candidate.economics.scenarios[0];
  const peak = structuredClone(off); peak.id = peak.cost_ledger.id = 'peak';
  peak.cost_ledger.fee_context.sales = peak.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
  for (const line of peak.cost_ledger.lines.filter(l => l.fee_basis)) line.fee_basis.effective_through = '2027-12-31';
  Object.assign(peak.cost_ledger.lines.find(l => l.id === 'fulfillment'), { amount_usd: null, status: 'pending',
    fee_basis: { status: 'unavailable', version: 'Unpublished 2027 holiday fee' } });
  candidate.economics = { saleable_unit: candidate.economics.saleable_unit, operating_periods: [
    { id: 'off', label: '2027年2—9月', months: [2,3,4,5,6,7,8,9], scenarios: [off] },
    { id: 'peak', label: '2027年10—12月', months: [10,11,12], scenarios: [peak] },
  ] };
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.operating_periods[0].queue, 'comparable');
  assert.equal(result.operating_periods[1].total, null);
  assert.equal(result.operating_periods[1].diagnostics.economics.margin_range, null);
  assert.equal(result.operating_periods[1].diagnostics.economics.scenarios[0].input.calculation.payout_components, null);
  const html = renderReport({ profile_revision:54, candidates:[result], queues:{} }, { candidates:[candidate] });
  assert.match(html, /2027-10-01/);
  assert.match(html, /费率适用性/);
  assert.match(html, /Unpublished 2027 holiday fee/);
  peak.cost_ledger.lines.find(line => line.id === 'storage').fee_basis.months = '10,11,12';
  const malformed = scoreCandidate(candidate, profile);
  assert.equal(malformed.operating_periods[0].queue, 'comparable');
  assert.equal(malformed.operating_periods[1].queue, 'pending');
  assert.doesNotThrow(() => renderReport({ profile_revision:54, candidates:[malformed], queues:{} }, { candidates:[candidate] }));
});

test('a sensitivity-only ledger is shown as an unscored conditional estimate, not a missing fee date', () => {
  const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url)));
  const candidate = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url))).candidates[0];
  for (const scenario of candidate.economics.scenarios) scenario.cost_ledger.sensitivity_only = true;
  const result = scoreCandidate(candidate, profile);
  const calculations = result.diagnostics.economics.scenarios.map(scenario => scenario.input.calculation);
  assert.ok(calculations.every(calc => calc.status === 'sensitivity_only' && calc.fee_validation.status === 'validated'));
  assert.equal(result.diagnostics.economics.margin_range, null);
  assert.equal(result.total, null);
  const html = renderReport({ profile_revision:54, candidates:[result], queues:{} }, { candidates:[candidate] });
  assert.match(html, /条件试算毛利率/);
  assert.match(html, /不授予经济分/);
  assert.doesNotMatch(html, /完整费用尚待补证：费率适用日期或来源/);
  assert.doesNotMatch(html, /该情景满足毛利条件/);
});
