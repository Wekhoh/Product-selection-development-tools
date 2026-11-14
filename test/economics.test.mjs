import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEconomics, netReferral, collectionFromDisbursement } from '../src/economics.mjs';

const fixture = () => ({
  id: 'synthetic-plan', saleable_unit: 'one synthetic set', price_usd: 50,
  refund_fraction: 0.04, assumptions: ['Synthetic independent shipment ledger'],
  lines: [
    ['procurement', 12.5], ['domestic_freight', 0], ['headhaul', 3],
    ['referral', 7.2], ['fulfillment', 5], ['placement', 1], ['storage', 0.5],
    ['returns_processing', 0.3], ['returns_disposal', 0], ['collection', 0.5],
    ['other_applicable', 0], ['recovery_credit', 0],
  ].map(([id, amount_usd]) => ({ id, amount_usd, status: 'estimated', basis: 'Synthetic fixture' })),
});

test('a whole-shipment ledger uses refunded net revenue and keeps advertising separate', () => {
  const out = calculateEconomics(fixture());
  assert.equal(out.net_revenue_usd, 48);
  assert.equal(out.net_cost_usd, 30);
  assert.equal(out.contribution_usd, 18);
  assert.equal(out.margin, 0.375);
  assert.equal(out.advertising_15pct_usd, 7.5);
  assert.equal(out.advertising_scenario_contribution_usd, 10.5);
  assert.equal(out.advertising_scenario_margin, 0.21875);
});

test('a missing applicable cost blocks complete margin, while evidenced zero remains zero', () => {
  const input = fixture();
  input.lines.find(x => x.id === 'headhaul').amount_usd = null;
  input.lines.find(x => x.id === 'headhaul').status = 'pending';
  const out = calculateEconomics(input);
  assert.equal(out.margin, null);
  assert.equal(out.net_cost_usd, null);
  assert.equal(out.known_cost_usd, 27);
  assert.deepEqual(out.pending_lines, ['headhaul']);
  assert.equal(out.procurement_cap_at_30pct_usd, null);
});

test('an explicit paired return deferral produces a labeled initial estimate without claiming zero outcomes', () => {
  const input = fixture();
  for (const id of ['returns_disposal', 'recovery_credit']) {
    Object.assign(input.lines.find(x => x.id === id), {
      amount_usd: null, status: 'deferred', basis: 'Owner defers unsupported return outcomes from initial estimate',
    });
  }
  const out = calculateEconomics(input);
  assert.equal(out.margin, 0.375);
  assert.equal(out.net_cost_usd, 30);
  assert.equal(out.scoring_supported, true);
  assert.equal(out.status, 'initial_estimate_with_deferred_returns');
  assert.deepEqual(out.deferred_lines, ['returns_disposal', 'recovery_credit']);
  assert.deepEqual(out.pending_lines, []);
  assert.equal(out.lines.find(x => x.id === 'returns_disposal').amount_usd, null);
  assert.equal(out.lines.find(x => x.id === 'recovery_credit').amount_usd, null);
});

test('initial return scope cannot hide a required cost or retain a one-sided recovery benefit', () => {
  const missingFreight = fixture();
  for (const id of ['returns_disposal', 'recovery_credit']) {
    Object.assign(missingFreight.lines.find(x => x.id === id), { amount_usd: null, status: 'deferred' });
  }
  Object.assign(missingFreight.lines.find(x => x.id === 'headhaul'), { amount_usd: null, status: 'pending' });
  const out = calculateEconomics(missingFreight);
  assert.equal(out.margin, null);
  assert.equal(out.scoring_supported, false);
  assert.deepEqual(out.pending_lines, ['headhaul']);
  assert.deepEqual(out.deferred_lines, ['returns_disposal', 'recovery_credit']);

  const unauthorized = fixture();
  Object.assign(unauthorized.lines.find(x => x.id === 'procurement'), { amount_usd: null, status: 'deferred' });
  assert.throws(() => calculateEconomics(unauthorized), /paired return disposition/);
  const oneSided = fixture();
  Object.assign(oneSided.lines.find(x => x.id === 'returns_disposal'), { amount_usd: null, status: 'deferred' });
  assert.throws(() => calculateEconomics(oneSided), /paired return disposition/);
  const withAmount = fixture();
  for (const id of ['returns_disposal', 'recovery_credit']) {
    Object.assign(withAmount.lines.find(x => x.id === id), { amount_usd: 0, status: 'deferred' });
  }
  assert.throws(() => calculateEconomics(withAmount), /null amounts/);
});

test('refund commission credits and administration are netted once', () => {
  assert.deepEqual(netReferral({ price_usd: 50, refund_fraction: 0.08, referral_fraction: 0.15,
    refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }),
  { gross_usd: 7.5, refund_credit_usd: 0.6, administration_usd: 0.12, net_usd: 7.02 });
});

test('collection uses the Amazon payout estimate, not selling price or product profit', () => {
  const result = collectionFromDisbursement({ net_revenue_usd: 48, amazon_deductions_usd: [7.2, 5, 1, 0.5, 0.3], rate: 0.006 });
  assert.equal(result.estimated_disbursement_usd, 34);
  assert.equal(result.collection_usd, 0.204);
  assert.equal(collectionFromDisbursement({ net_revenue_usd: 4, amazon_deductions_usd: [5], rate: 0.006 }).collection_usd, 0);
  assert.throws(() => collectionFromDisbursement({ net_revenue_usd: 48, amazon_deductions_usd: [null], rate: 0.006 }));
});
