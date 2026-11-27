import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  calculateEconomics,
  collectionFromDisbursement,
  evaluateEarlyScreen,
  ledgerMeetsMarginFloor,
  netReferral,
} from '../src/economics.mjs';
import {
  BARE_GOODS_DISCLOSURE_ZH,
  BUSINESS_THRESHOLDS,
  BUSINESS_THRESHOLD_AUDIT_REGISTRY,
} from '../src/business-thresholds.mjs';
import {
  computeHeadhaulWithA4Rules,
  estimateGate1A2027,
  lookupBulkyPlacementFee2027,
  validateFeeBasis,
} from '../src/fba-calculator.mjs';
import { runFastProfitHealthcheck2027 } from '../src/pipeline.mjs';
import { runCliMem, withTempDirAsync } from './helpers/test-fixtures.mjs';

const fixture = () => ({
  id: 'synthetic-plan', saleable_unit: 'one synthetic set', price_usd: 50,
  refund_fraction: 0.04, return_threshold: 0.081, assumptions: ['Synthetic independent shipment ledger'],
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

test('an explicitly deferred domestic delivery cost stays unknown while the initial estimate can be scored', () => {
  const input = fixture();
  Object.assign(input.lines.find(x => x.id === 'domestic_freight'), {
    amount_usd: null, status: 'deferred', basis: 'Owner excludes domestic delivery from the initial screen; verify after retention',
  });
  const out = calculateEconomics(input);
  assert.equal(out.net_cost_usd, 30);
  assert.equal(out.margin, 0.375);
  assert.equal(out.scoring_supported, true);
  assert.equal(out.status, 'initial_estimate_with_deferred_costs');
  assert.deepEqual(out.deferred_lines, ['domestic_freight']);
  assert.equal(out.lines.find(x => x.id === 'domestic_freight').amount_usd, null);

  for (const id of ['returns_disposal', 'recovery_credit']) {
    Object.assign(input.lines.find(x => x.id === id), { amount_usd: null, status: 'deferred' });
  }
  assert.equal(calculateEconomics(input).margin, 0.375);
  Object.assign(input.lines.find(x => x.id === 'procurement'), { amount_usd: null, status: 'pending' });
  assert.equal(calculateEconomics(input).scoring_supported, false);
  input.lines.find(x => x.id === 'domestic_freight').amount_usd = 0;
  assert.throws(() => calculateEconomics(input), /null amounts/);
});

test('collection uses the Amazon payout estimate, not selling price or product profit', () => {
  const result = collectionFromDisbursement({ net_revenue_usd: 48, amazon_deductions_usd: [7.2, 5, 1, 0.5, 0.3], rate: 0.006 });
  assert.equal(result.estimated_disbursement_usd, 34);
  assert.equal(result.collection_usd, 0.204);
  assert.equal(collectionFromDisbursement({ net_revenue_usd: 4, amazon_deductions_usd: [5], rate: 0.006 }).collection_usd, 0);
  assert.throws(() => collectionFromDisbursement({ net_revenue_usd: 48, amazon_deductions_usd: [null], rate: 0.006 }));
});

// --- Migrated from test/revision58.test.mjs (ledgerMeetsMarginFloor & evaluateEarlyScreen / economics parity) ---

test('r59 ledgerMeetsMarginFloor rejects forged exact_usd_rational and guards 3-SKU, per-kg headhaul, and USD+CNY precision', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const opts59 = { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };

  // R5-01: direct ledgerMeetsMarginFloor rejects forged exact_usd_rational on headhaul (or off by 4e-8) AND early-screen preserves exact $1.00000000004 headhaul
  const directLedger = { price_usd: 40, refund_fraction: 0, margin: 0.299999999, lines: [{ id: 'headhaul', amount_usd: 28.00000004, exact_usd_rational: { num: '28', den: '1' } }] };
  assert.equal(ledgerMeetsMarginFloor(directLedger, 0.3), false, 'direct ledgerMeetsMarginFloor must ignore forged exact_usd_rational on headhaul');
  const directProcForge = { price_usd: 40, refund_fraction: 0, margin: 0.299999999, lines: [{ id: 'procurement', amount_usd: 28.00000004, exact_usd_rational: { num: '28', den: '1' } }] };
  assert.equal(ledgerMeetsMarginFloor(directProcForge, 0.3), false, 'procurement exact_usd_rational off by 4e-8 (>5e-11) must be ignored');
  const exactHhEarly = evaluateEarlyScreen({
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 100, first_order_promotion: false,
    refund_fraction: 0, physical_return_fraction: 0, return_threshold: 0.087,
    procurement_usd: 10, domestic_freight_usd: 1, headhaul: { usd_per_unit: 1.00000000004, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 9, placement_usd: 0.9415, storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
  });
  assert.equal(exactHhEarly.gate_status, 'fail', 'early-screen must preserve sub-10-decimal headhaul usd_per_unit precision');

  // R5-02 nested source_inputs.first_order_promotion
  assert.equal(evaluateEarlyScreen({
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 120, first_order_promotion: false,
    source_inputs: { first_order_promotion: true, complete_saleable_sets: 120 },
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087,
    procurement_usd: 5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.005, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending');

  // R5-10: omitted effective_through & backdated US-FBA-2027 schedule
  const janEarlyBase = {
    profile_revision: 59, saleable_unit: '1 unit', operating_months: [1],
    fee_context: { ...validFeeCtx, sales: { from: '2027-01-15', through: '2027-01-31' }, storage: { from: '2027-01-15', through: '2027-01-31' } },
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.12, fee_category: 'Tools and Home Improvement',
    return_threshold: 0.087, per_return_fee_usd: 4.32, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    storage_fee_basis: { ...validBasis, months: [1] }, evidence_ids: ['src'],
    specific_rights_conflict: false, strong_date_dependency: false,
  };
  const missingEndBasis = { ...validBasis };
  delete missingEndBasis.effective_through;
  assert.equal(evaluateEarlyScreen({ ...janEarlyBase, returns_processing_fee_basis: missingEndBasis }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({
    ...janEarlyBase, per_return_fee_usd: 0.01,
    returns_processing_fee_basis: { ...validBasis, version: 'US-FBA-2027-nonpeak-standard-v1', effective_from: '2027-01-15', effective_through: null },
  }).gate_status, 'pending');

  // R6-1: cross-line DG storage floor + ledgerMeetsMarginFloor + duplicate packages[].id
  const mkOffPeakLedger = () => ({
    id: 'r6-off', saleable_unit: '1 unit', price_usd: 40, refund_fraction: 0.05, physical_return_fraction: 0.05,
    fee_category: 'Tools and Home Improvement', assumptions: ['R6'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005, fee_context: validFeeCtx,
    packages: [{ id: 'pack-1', length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, evidence: ['src'] }],
    lines: [
      { id: 'procurement', amount_usd: 11.425, status: 'estimated', basis: '1688', evidence: ['src'], components: ['procurement'], order_units: 100, first_order_promotion: false },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Dom', evidence: ['src'], components: ['domestic_freight'], order_units: 100, first_order_promotion: false },
      { id: 'headhaul', amount_usd: 2.4, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 5.76, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { ...validBasis, effective_through: null } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: validBasis },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { ...validBasis, effective_through: null } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'Below', evidence: ['src'], return_threshold: 0.087, fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null } },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.13, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { ...validBasis, effective_from: '2027-01-01', effective_through: null } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
    ],
  });
  assert.equal(validateFeeBasis(mkOffPeakLedger(), opts59).status, 'validated');
  const crossDgLowStore = mkOffPeakLedger();
  crossDgLowStore.lines.find(l => l.id === 'returns_processing').is_dangerous_goods = true;
  assert.equal(validateFeeBasis(crossDgLowStore, opts59).status, 'needs_evidence');
  assert.equal(calculateEconomics(crossDgLowStore, opts59).scoring_supported, false);
  const crossDgProperStore = structuredClone(crossDgLowStore);
  crossDgProperStore.lines.find(l => l.id === 'storage').amount_usd = 0.07425;
  assert.equal(validateFeeBasis(crossDgProperStore, opts59).status, 'validated');
  assert.equal(ledgerMeetsMarginFloor(calculateEconomics(crossDgProperStore, opts59), 0.3), false);
  const crossDgConflict = structuredClone(crossDgProperStore);
  crossDgConflict.lines.find(l => l.id === 'storage').is_dangerous_goods = false;
  assert.equal(validateFeeBasis(crossDgConflict, opts59).status, 'needs_evidence');

  for (const revPkgs of [false, true]) {
    const dupPkgLedger = mkOffPeakLedger();
    const pkgs = [
      { id: 'pack-1', length_in: 1, width_in: 1, height_in: 1, weight_lb: 0.5, evidence: ['src'] },
      { id: 'pack-1', length_in: 10, width_in: 10, height_in: 5, weight_lb: 5, evidence: ['src'] },
    ];
    dupPkgLedger.packages = revPkgs ? pkgs.reverse() : pkgs;
    dupPkgLedger.lines.find(l => l.id === 'storage').amount_usd = 0.0007;
    assert.equal(validateFeeBasis(dupPkgLedger, opts59).status, 'needs_evidence');
    assert.equal(calculateEconomics(dupPkgLedger, opts59).scoring_supported, false);
  }

  // R6-6: 3-SKU BigInt rounding in early-screen, direct forge, per-kg headhaul, USD+CNY conflict
  const mkSku3 = rev => {
    const prices = [89.99080000045001, 0.0046, 0.0046];
    if (rev) prices.reverse();
    return prices.map((p, i) => ({ sku_id: `SKU-${i}`, qty_per_saleable_set: 1, pack_multiple: 100, moq_qty: 100, ordered_qty: 100, unit_price_cny: p, regular_goods_promo_false: true }));
  };
  const baseEarly = {
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 9, order_units: 100, first_order_promotion: false,
    refund_fraction: 0, physical_return_fraction: 0, return_threshold: 0.087,
    domestic_freight_usd: 1, headhaul: { usd_per_unit: 1, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 9, placement_usd: 0.9415, storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
  };
  assert.equal(evaluateEarlyScreen({ ...baseEarly, sku_lines: mkSku3(false) }).gate_status, 'fail');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, sku_lines: mkSku3(true) }).gate_status, 'fail');
  assert.equal(ledgerMeetsMarginFloor({
    price_usd: 40, refund_fraction: 0, margin: 0.299999999,
    lines: [{ id: 'procurement', amount_usd: 28.00000000004, exact_usd_rational: { num: '28', den: '1' } }],
  }, 0.3), false);
  assert.equal(evaluateEarlyScreen({
    ...baseEarly, procurement_usd: 10,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 9.00000000036, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0 },
  }).gate_status, 'fail');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, fx_cny_per_usd: 10, goods_cny_per_unit: 100.000005, procurement_usd: 10 }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, fx_cny_per_usd: 10, procurement_usd: 10, domestic_freight_usd: 1, domestic_freight_cny_per_unit: 10.000005 }).gate_status, 'pending');
});

test('Batch A1 Req 1 & Astra #9/#14: evaluateEarlyScreen bare-goods default, explicit landed-cost mode, and decoupled coupon 100-unit denominator', () => {
  const makeBareGoodsProbeInput = (overrides = {}) => ({
    profile_revision: 59,
    id: 'syn-a1-bare-goods-probe',
    saleable_unit: '1 synthetic desktop tray set',
    price_usd: 45.00,
    specific_rights_conflict: false,
    strong_date_dependency: false,
    fx_cny_per_usd: 7.20,
    order_units: 100,
    goods_cny_per_unit: 125.00,
    domestic_freight_cny_total: 500,
    first_order_promotion: false,
    pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
    headhaul: { usd_per_unit: 0.90, bond_included: true },
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00, minimum_referral_usd: 0.30 },
    fulfillment_usd: 4.50,
    placement_usd: 0.30,
    storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: {
      marketplace: 'US', currency: 'USD', package_ref: 'syn-pkg',
      sales: { from: '2027-02-01', through: '2027-10-14' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-15', through: '2027-10-14' },
    },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    ...overrides,
  });

  const defaultBare = evaluateEarlyScreen(makeBareGoodsProbeInput());
  assert.equal(defaultBare.cost_basis, 'bare_goods_1688');
  assert.equal(defaultBare.gate_status, 'pass', JSON.stringify(defaultBare.reasons));
  assert.equal(defaultBare.metrics.domestic_freight_usd, 0);
  assert.ok(defaultBare.metrics.margin >= 0.30);
  assert.match(defaultBare.bare_goods_disclosure ?? '', /1688 裸货价/);
  assert.equal(defaultBare.domestic_freight_advisory_cny_total, 500);
  assert.equal(defaultBare.domestic_freight_advisory?.advisory_only, true);
  assert.equal(defaultBare.domestic_freight_advisory?.excluded_from_bare_goods_margin, true);
  assert.equal(defaultBare.domestic_freight_advisory?.cny_total, 500);
  assert.equal(defaultBare.domestic_freight_advisory?.cny_per_unit, 5);
  assert.ok(defaultBare.domestic_freight_advisory?.landed_margin_if_incurred < 0.30);

  const freightPromoBare = evaluateEarlyScreen(makeBareGoodsProbeInput({ first_order_promotion: true, goods_first_order_promotion: false }));
  assert.equal(freightPromoBare.cost_basis, 'bare_goods_1688');
  assert.equal(freightPromoBare.gate_status, 'pass');

  const explicitLandedFlag = evaluateEarlyScreen(makeBareGoodsProbeInput({ bare_goods_screening: false }));
  assert.equal(explicitLandedFlag.cost_basis, 'landed_domestic_explicit');
  assert.equal(explicitLandedFlag.gate_status, 'fail');
  assert.ok(explicitLandedFlag.metrics.domestic_freight_usd > 0.69);
  assert.ok(explicitLandedFlag.metrics.margin < 0.30);

  const explicitLandedBasis = evaluateEarlyScreen(makeBareGoodsProbeInput({ cost_basis: 'landed_domestic_explicit' }));
  assert.equal(explicitLandedBasis.cost_basis, 'landed_domestic_explicit');
  assert.equal(explicitLandedBasis.gate_status, 'fail');
  assert.equal(explicitLandedBasis.metrics.margin, explicitLandedFlag.metrics.margin);

  assert.throws(() => evaluateEarlyScreen(makeBareGoodsProbeInput({ bare_goods_screening: true, cost_basis: 'landed_domestic_explicit' })), TypeError);
  assert.throws(() => evaluateEarlyScreen(makeBareGoodsProbeInput({ bare_goods_screening: false, cost_basis: 'bare_goods_1688' })), TypeError);

  // Coupon $5 fixed-fee denominator stays decoupled from procurement order_units
  const couponOrder100 = evaluateEarlyScreen(makeBareGoodsProbeInput({ list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99, order_units: 100 }));
  const couponOrder500 = evaluateEarlyScreen(makeBareGoodsProbeInput({ list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99, order_units: 500 }));
  assert.equal(couponOrder100.metrics.margin, couponOrder500.metrics.margin);
  assert.equal(couponOrder500.ledger.lines.find(l => l.id === 'other_applicable')?.coupon_campaign_units, 100);
  assert.equal(couponOrder500.ledger.lines.find(l => l.id === 'other_applicable')?.include_coupon_campaign_flat, true);

  const couponNoFlat = evaluateEarlyScreen(makeBareGoodsProbeInput({ list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99, order_units: 500, include_coupon_campaign_flat: false }));
  assert.equal(couponNoFlat.ledger.lines.find(l => l.id === 'other_applicable')?.include_coupon_campaign_flat, false);
  assert.equal(couponNoFlat.ledger.include_coupon_campaign_flat, false);

  const calcCoupon500 = calculateEconomics({
    id: 'syn-calc-coupon', saleable_unit: '1 unit', assumptions: ['synthetic'],
    list_price_usd: 54.99, ongoing_coupon_usd: 10.00, price_usd: 44.99,
    refund_fraction: 0.04, order_units: 500, bare_goods_screening: true,
    lines: [
      { id: 'procurement', amount_usd: 12, status: 'estimated', basis: 'goods' },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'sea' },
      { id: 'referral', amount_usd: 6.53, status: 'estimated', basis: 'ref' },
      { id: 'fulfillment', amount_usd: 5.5, status: 'estimated', basis: 'fba' },
      { id: 'placement', amount_usd: 0.3, status: 'estimated', basis: 'pl' },
      { id: 'storage', amount_usd: 0.1, status: 'estimated', basis: 'st' },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'ret' },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'def' },
      { id: 'collection', amount_usd: 0.18, status: 'estimated', basis: 'col' },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'none' },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'def' },
    ],
  }, { profileRevision: 59 });
  assert.equal(calcCoupon500.coupon_campaign_units, 100);
  assert.equal(calcCoupon500.lines.find(l => l.id === 'other_applicable')?.coupon_campaign_units, 100);

  const conflictingFreight = evaluateEarlyScreen(makeBareGoodsProbeInput({ domestic_freight_cny_total: 500, domestic_freight_cny_per_unit: 0 }));
  assert.equal(conflictingFreight.gate_status, 'pass');
  assert.equal(conflictingFreight.domestic_freight_advisory?.conflict_detected, true);
  assert.equal(conflictingFreight.domestic_freight_advisory?.cny_per_unit, null);
  assert.equal(conflictingFreight.domestic_freight_advisory?.landed_margin_if_incurred, null);

  const missingRefundAdvisory = evaluateEarlyScreen(makeBareGoodsProbeInput({ refund_fraction: undefined }));
  assert.equal(missingRefundAdvisory.gate_status, 'pending');
  assert.equal(missingRefundAdvisory.domestic_freight_advisory?.cny_total, 500);
  assert.equal(missingRefundAdvisory.domestic_freight_advisory?.advisory_only, true);
});

const ISSUE5_BASE_STD_PKG = {
  id: 'pkg-1',
  length_in: 10,
  width_in: 8,
  height_in: 4,
  weight_lb: 1.2,
};

const ISSUE5_BASE_WINDOW = {
  sales: { from: '2027-02-01', through: '2027-10-14' },
  storage: { from: '2027-02-01', through: '2027-09-30' },
  inbound: { from: '2027-01-15', through: '2027-10-14' },
};

const ISSUE5_BASE_REFERRAL = {
  referral_fraction: 0.15,
  refund_admin_fraction: 0.20,
  refund_admin_cap_usd: 5.00,
  minimum_referral_usd: 0.30,
};

function makeIssue5EarlyScreenInput(headhaul) {
  return {
    profile_revision: 59,
    id: 'issue-5-screen',
    saleable_unit: '1 synthetic hardware kit',
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: 50,
    domestic_freight_cny_total: 100,
    first_order_promotion: false,
    goods_first_order_promotion: false,
    headhaul,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    fee_category: 'Home and Kitchen',
    pkg: ISSUE5_BASE_STD_PKG,
    is_apparel_or_shoes: false,
    referral_terms: ISSUE5_BASE_REFERRAL,
    fulfillment_usd: 5.50,
    placement_usd: 0.40,
    storage: { cubic_feet_per_unit: 0.1852, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-1', ...ISSUE5_BASE_WINDOW },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  };
}

function makeIssue5FormalLedger(headhaulSpec, headhaulAmountUsd = 0.90) {
  const pubBasis = {
    status: 'published',
    version: 'US-FBA-2027',
    marketplace: 'US',
    currency: 'USD',
    package_ref: 'pkg-1',
    effective_from: '2027-01-15',
    effective_through: '2027-10-14',
    evidence: ['ev-fba'],
  };
  return {
    id: 'issue-5-ledger',
    saleable_unit: '1 synthetic hardware kit',
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    fee_category: 'Home and Kitchen',
    referral_terms: ISSUE5_BASE_REFERRAL,
    collection_rate: 0.006,
    packages: [ISSUE5_BASE_STD_PKG],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-1', ...ISSUE5_BASE_WINDOW },
    assumptions: ['Synthetic Issue #5 headhaul regression ledger'],
    lines: [
      { id: 'procurement', amount_usd: 7.1428571429, status: 'sourced', basis: '100-set regular quote', order_units: 100, first_order_promotion: false, components: ['goods'], evidence: ['ev-1688'] },
      { id: 'domestic_freight', amount_usd: 0.1428571429, status: 'sourced', basis: '100-set domestic freight', order_units: 100, first_order_promotion: false, components: ['domestic_freight'], evidence: ['ev-1688'] },
      { id: 'headhaul', amount_usd: headhaulAmountUsd, status: 'estimated', basis: 'Sea-truck headhaul', components: ['headhaul', 'carrier_bond'], cny_derivation: headhaulSpec, evidence: ['ev-hh'] },
      { id: 'referral', amount_usd: 6.534, status: 'estimated', basis: '15% referral', components: ['referral_after_refunds', 'refund_administration'], fee_basis: pubBasis, evidence: ['ev-fba'] },
      { id: 'fulfillment', amount_usd: 5.50, status: 'estimated', basis: '2027 FBA', components: ['fulfillment'], fee_basis: pubBasis, evidence: ['ev-fba'] },
      { id: 'placement', amount_usd: 0.40, status: 'estimated', basis: '2027 placement', components: ['placement'], fee_basis: { ...pubBasis, effective_through: null }, evidence: ['ev-fba'] },
      { id: 'storage', amount_usd: 0.2167, status: 'estimated', basis: '2027 storage', components: ['storage'], fee_basis: { ...pubBasis, effective_from: '2027-02-01', effective_through: '2027-09-30', cubic_feet_per_unit: 0.1852, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 }, evidence: ['ev-fba'] },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'Below threshold', return_threshold: 0.081, fee_basis: { ...pubBasis, effective_from: '2027-02-01', effective_through: '2027-12-31' }, evidence: ['ev-fba'] },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Paired deferral', evidence: ['ev-fba'] },
      { id: 'collection', amount_usd: 0.18, status: 'estimated', basis: '0.6% collection', components: ['payment_collection'], evidence: ['ev-fba'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', payee: 'external', basis: 'None', evidence: ['ev-fba'] },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Paired deferral', evidence: ['ev-fba'] },
    ],
  };
}

test('Issue #5: weight_per_carton_kg * carton_count derives 60 kg actual weight vs 18 kg volumetric ($0.90/set parity)', () => {
  const perCartonOnly = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
    small_shipment_surcharge_cny_per_kg: 0,
    small_carton_surcharge_cny_per_carton: 0,
  }, 7, 100, { isR58: true, isR59: true });

  const withMatchingTotal = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 60,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
    small_shipment_surcharge_cny_per_kg: 0,
    small_carton_surcharge_cny_per_carton: 0,
  }, 7, 100, { isR58: true, isR59: true });

  assert.equal(perCartonOnly.amount_usd, 0.90);
  assert.equal(perCartonOnly.a4_applied.billed_total_kg, 60);
  assert.equal(perCartonOnly.a4_applied.volumetric_exceeds_actual, false);
  assert.equal(perCartonOnly.a4_applied.actual_weight_derived_from_cartons, true);

  assert.equal(withMatchingTotal.amount_usd, 0.90);
  assert.equal(withMatchingTotal.a4_applied.billed_total_kg, 60);
  assert.equal(perCartonOnly.amount_usd, withMatchingTotal.amount_usd);

  // Without carton_cm at all, weight_per_carton_kg * carton_count alone also derives 60 kg ($0.90/set)
  const noCartonCm = computeHeadhaulWithA4Rules({
    carton_count: 4,
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(noCartonCm.amount_usd, 0.90);
  assert.equal(noCartonCm.a4_applied.billed_total_kg, 60);
});

test('Issue #5: preserves material conflict between weight_per_carton_kg * carton_count and actual_weight_kg_total / per_unit using exact decimal-precision rounding', () => {
  const conflictLowTotal = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 40,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(conflictLowTotal.amount_usd, null);
  assert.equal(conflictLowTotal.exact_usd_rational, null);
  assert.equal(conflictLowTotal.weight_conflict, true);
  assert.equal(conflictLowTotal.a4_applied?.weight_conflict, true);
  assert.equal(conflictLowTotal.a4_applied?.derived_actual_weight_kg_total, 60);
  assert.equal(conflictLowTotal.a4_applied?.supplied_actual_weight_kg_total, 40);

  const conflictHighTotal = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 75,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(conflictHighTotal.amount_usd, null);
  assert.equal(conflictHighTotal.weight_conflict, true);

  const conflictPerUnit = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_per_unit: 0.40,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(conflictPerUnit.amount_usd, null);
  assert.equal(conflictPerUnit.weight_conflict, true);

  // Benign decimal-precision rounding (6 * 16.67 = 100.02 vs 100.00 AND 3 * 16.67 = 50.01 vs 50.00) must NOT false-conflict
  const benignRounding3 = computeHeadhaulWithA4Rules({
    carton_count: 3,
    weight_per_carton_kg: 16.67,
    actual_weight_kg_total: 50,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(benignRounding3.weight_conflict ?? false, false);
  assert.equal(benignRounding3.amount_usd, 0.75);

  const benignRounding6 = computeHeadhaulWithA4Rules({
    carton_count: 6,
    weight_per_carton_kg: 16.67,
    actual_weight_kg_total: 100,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(benignRounding6.weight_conflict ?? false, false);
  assert.equal(benignRounding6.amount_usd, 1.50);

  // Integer carton weight vs 1 kg off total weight MUST still conflict (zero invented tolerance!)
  const intConflict = computeHeadhaulWithA4Rules({
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 59,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(intConflict.weight_conflict, true);
  assert.equal(intConflict.amount_usd, null);
});

test('Issue #5: unknown carton_count, partial carton remainder, and mixed cartons never blindly multiply weight_per_carton_kg', () => {
  const unknownCount = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(unknownCount.amount_usd, null);
  assert.equal(unknownCount.missing_surcharge_quote, true);

  const unknownCountNoDims = computeHeadhaulWithA4Rules({
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(unknownCountNoDims.amount_usd, null);
  assert.equal(unknownCountNoDims.missing_surcharge_quote, true);

  // 100 units at 30 units/carton => 3 full cartons + 1 partial carton (10 units); cannot multiply weight_per_carton_kg * 4!
  const partialCarton = computeHeadhaulWithA4Rules({
    units_per_carton: 30,
    weight_per_carton_kg: 15,
    carton_cm: [30, 30, 30],
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(partialCarton.amount_usd, null);
  assert.equal(partialCarton.missing_surcharge_quote, true);

  // Mixed cartons without total actual weight cannot multiply weight_per_carton_kg * carton_count or silently bill 18 kg volumetric!
  const mixedNoTotal = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    mixed_cartons: true,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(mixedNoTotal.amount_usd, null);
  assert.equal(mixedNoTotal.missing_surcharge_quote, true);

  // Mixed cartons WITH explicit actual_weight_kg_total (and no uniform carton_cm assumption) works cleanly without false conflict
  const mixedWithTotal = computeHeadhaulWithA4Rules({
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 52,
    mixed_cartons: true,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(mixedWithTotal.amount_usd, 0.78);
  assert.equal(mixedWithTotal.a4_applied.billed_total_kg, 52);
  assert.equal(mixedWithTotal.a4_applied.actual_weight_derived_from_cartons, false);
});

test('Issue #5: volumetric > actual preserved and verified across evaluateEarlyScreen, calculateEconomics, validateFeeBasis, and estimateGate1A2027', () => {
  // 4 cartons of 60x50x40 cm -> 20 kg/carton -> 80 kg volumetric > 60 kg actual -> 80 * 10.50 / 100 / 7 = $1.20/set
  const volHeavySpec = {
    carton_cm: [60, 50, 40],
    carton_count: 4,
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  };
  const volRes = computeHeadhaulWithA4Rules(volHeavySpec, 7, 100, { isR58: true, isR59: true });
  assert.equal(volRes.amount_usd, 1.20);
  assert.equal(volRes.a4_applied.billed_total_kg, 80);
  assert.equal(volRes.a4_applied.volumetric_exceeds_actual, true);

  // 1) evaluateEarlyScreen parity ($0.90/set) + volumetric ($1.20/set) + conflict (pending/null margin)
  const actualHeavySpec = {
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  };
  const esPerCarton = evaluateEarlyScreen(makeIssue5EarlyScreenInput(actualHeavySpec));
  const esWithTotal = evaluateEarlyScreen(makeIssue5EarlyScreenInput({ ...actualHeavySpec, actual_weight_kg_total: 60 }));
  assert.equal(esPerCarton.metrics.headhaul_usd, 0.90);
  assert.equal(esWithTotal.metrics.headhaul_usd, 0.90);
  assert.equal(esPerCarton.metrics.margin, esWithTotal.metrics.margin);

  const esVolHeavy = evaluateEarlyScreen(makeIssue5EarlyScreenInput(volHeavySpec));
  assert.equal(esVolHeavy.metrics.headhaul_usd, 1.20);
  assert.equal(esVolHeavy.headhaul_a4_applied.volumetric_exceeds_actual, true);

  const conflictSpec = { ...actualHeavySpec, actual_weight_kg_total: 40 };
  const esConflict = evaluateEarlyScreen(makeIssue5EarlyScreenInput(conflictSpec));
  assert.equal(esConflict.metrics.headhaul_usd, null);
  assert.equal(esConflict.ledger.margin, null);
  assert.equal(esConflict.headhaul_a4_applied?.weight_conflict, true);
  assert.ok(esConflict.reasons.some(r => /conflict|冲突/i.test(r)), 'evaluateEarlyScreen must preserve weight conflict reason');

  // 2) calculateEconomics & validateFeeBasis (formal cost entrypoints)
  const formalOk = calculateEconomics(
    makeIssue5FormalLedger(actualHeavySpec, 0.90),
    { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(formalOk.lines.find(l => l.id === 'headhaul').amount_usd, 0.90);
  assert.ok(formalOk.margin !== null);

  // Underbilled $0.27 (old volumetric-only bug) must be rejected by validateFeeBasis + calculateEconomics!
  const formalUnderbilled = validateFeeBasis(
    makeIssue5FormalLedger(actualHeavySpec, 0.27),
    { profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(formalUnderbilled.status, 'needs_evidence');
  assert.ok(formalUnderbilled.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_tariff_mismatch'));

  const formalConflictVal = validateFeeBasis(
    makeIssue5FormalLedger(conflictSpec, 0.90),
    { profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(formalConflictVal.status, 'needs_evidence');
  assert.ok(formalConflictVal.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_weight_conflict'));

  const formalConflictEcon = calculateEconomics(
    makeIssue5FormalLedger(conflictSpec, 0.90),
    { profileRevision: 59, requireFeeBasis: false },
  );
  assert.equal(formalConflictEcon.margin, null, 'Direct calculateEconomics must hold conflicted headhaul pending');
  assert.ok(formalConflictEcon.pending_lines.includes('headhaul'));

  // 3) estimateGate1A2027
  const g1aBase = {
    pkg: ISSUE5_BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: ISSUE5_BASE_REFERRAL,
    collection_rate: 0.006,
    order_units: 100,
    profile_revision: 59,
  };
  const g1aActual = estimateGate1A2027({ ...g1aBase, headhaul: actualHeavySpec });
  assert.equal(g1aActual.status, 'verified');
  assert.equal(g1aActual.components.headhaul.amount_usd, 0.90);

  const g1aVol = estimateGate1A2027({ ...g1aBase, headhaul: volHeavySpec });
  assert.equal(g1aVol.status, 'verified');
  assert.equal(g1aVol.components.headhaul.amount_usd, 1.20);

  const g1aConflict = estimateGate1A2027({ ...g1aBase, headhaul: conflictSpec });
  assert.equal(g1aConflict.status, 'needs_calculator_verification');
  assert.equal(g1aConflict.weight_conflict, true);

  // 4) Formal volumetric > actual mismatch: non-strict recomputes $0.90 -> $1.20; strict rejects!
  const volLedgerLoose = calculateEconomics(
    makeIssue5FormalLedger(volHeavySpec, 0.90),
    { profileRevision: 59, requireFeeBasis: false },
  );
  assert.equal(volLedgerLoose.lines.find(l => l.id === 'headhaul').amount_usd, 1.20);

  const volLedgerStrict = calculateEconomics(
    makeIssue5FormalLedger(volHeavySpec, 0.90),
    { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(volLedgerStrict.margin, null);
  assert.ok(volLedgerStrict.pending_lines.includes('headhaul'));
  assert.ok(volLedgerStrict.fee_validation.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_tariff_mismatch'));
});

test('Issue #5 Astra audit regressions: stale scalar headhaul_usd bypass, input.headhaul conflict, partial carton with explicit count, chargeable_kg_per_unit parity, exact 150-set round-trip, mixed cartons[] dims, and headhaul.order_units', () => {
  const conflictSpec = {
    carton_cm: [30, 30, 30],
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 40,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  };

  // P1-1: Stale scalar headhaul_usd: 0.27 CANNOT bypass structured headhaul conflict in Gate 1A or profit-check!
  const g1aBypassAttempt = estimateGate1A2027({
    pkg: ISSUE5_BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: ISSUE5_BASE_REFERRAL,
    collection_rate: 0.006,
    headhaul_usd: 0.27,
    headhaul: conflictSpec,
    profile_revision: 59,
  });
  assert.equal(g1aBypassAttempt.status, 'needs_calculator_verification');
  assert.equal(g1aBypassAttempt.weight_conflict, true);

  const hcBypassAttempt = runFastProfitHealthcheck2027({
    pkg: ISSUE5_BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: 50,
    domestic_freight_cny_total: 100,
    headhaul_usd: 0.27,
    headhaul: conflictSpec,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: ISSUE5_BASE_REFERRAL,
    collection_rate: 0.006,
  });
  assert.equal(hcBypassAttempt.realized_2027_off_peak.status, 'needs_calculator_verification');
  assert.equal(hcBypassAttempt.realized_2027_off_peak.margin, null);

  // P1-2: Conflict placed in input.headhaul (even when line.cny_derivation is absent or stale) is caught in BOTH non-strict & strict calculateEconomics/validateFeeBasis!
  const ledgerWithRootConflict = makeIssue5FormalLedger(undefined, 0.27);
  delete ledgerWithRootConflict.lines.find(l => l.id === 'headhaul').cny_derivation;
  ledgerWithRootConflict.headhaul = conflictSpec;
  const looseRootConflict = calculateEconomics(ledgerWithRootConflict, { profileRevision: 59, requireFeeBasis: false });
  assert.equal(looseRootConflict.margin, null);
  assert.ok(looseRootConflict.pending_lines.includes('headhaul'));
  assert.ok(/conflicts/i.test(looseRootConflict.headhaul_conflict_reason));

  const strictWithStaleDeriv = makeIssue5FormalLedger({
    carton_cm: [30, 30, 30], carton_count: 4, weight_per_carton_kg: 15, actual_weight_kg_total: 60,
    rate_cny_per_kg: 10.50, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0,
  }, 0.90);
  strictWithStaleDeriv.headhaul = conflictSpec;
  const valBoth = validateFeeBasis(strictWithStaleDeriv, {
    profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(valBoth.status, 'needs_evidence');
  assert.ok(valBoth.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_weight_conflict'));

  // P1-3: Partial last carton (100 sets, 30/carton, explicit carton_count: 4) MUST NOT multiply 4*15=60 and MUST accept measured 50 kg total cleanly!
  const partialWithCountNoTotal = computeHeadhaulWithA4Rules({
    units_per_carton: 30,
    carton_count: 4,
    weight_per_carton_kg: 15,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(partialWithCountNoTotal.amount_usd, null);
  assert.equal(partialWithCountNoTotal.missing_surcharge_quote, true);

  const partialWithCountAndTotal = computeHeadhaulWithA4Rules({
    units_per_carton: 30,
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 50,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(partialWithCountAndTotal.amount_usd, 0.75);

  // P1-4: chargeable_kg_per_unit: 0.8 (80 kg) keeps $1.20/set identically before AND after adding consistent actual_weight_kg_total: 60
  const chgBefore = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30], carton_count: 4, weight_per_carton_kg: 15, chargeable_kg_per_unit: 0.8,
    rate_cny_per_kg: 10.50, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  const chgAfter = computeHeadhaulWithA4Rules({
    carton_cm: [30, 30, 30], carton_count: 4, weight_per_carton_kg: 15, chargeable_kg_per_unit: 0.8, actual_weight_kg_total: 60,
    rate_cny_per_kg: 10.50, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(chgBefore.amount_usd, 1.20);
  assert.equal(chgAfter.amount_usd, 1.20);

  // P1-5: 150 sets / 50 kg exact round-trip through evaluateEarlyScreen -> calculateEconomics has ZERO 10-dp drift ($0.50/set, no spurious <50kg surcharge!)
  const es150 = evaluateEarlyScreen({
    ...makeIssue5EarlyScreenInput({
      actual_weight_kg_total: 50,
      carton_count: 4,
      rate_cny_per_kg: 10.50,
      surcharge_cny_per_kg: 0,
      bond_cny_per_kg: 0,
      small_shipment_surcharge_cny_per_kg: 2,
    }),
    order_units: 150,
  });
  assert.equal(es150.metrics.headhaul_usd, 0.50);
  assert.equal(es150.ledger.lines.find(l => l.id === 'headhaul').amount_usd, 0.50);

  // Also round-trip partial-carton 52 kg via evaluateEarlyScreen -> calculateEconomics must stay $0.78 (no false 60 vs 52 conflict!)
  const esPartial52 = evaluateEarlyScreen(makeIssue5EarlyScreenInput({
    units_per_carton: 30,
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 52,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }));
  assert.equal(esPartial52.metrics.headhaul_usd, 0.78);
  assert.equal(esPartial52.ledger.lines.find(l => l.id === 'headhaul').amount_usd, 0.78);
  assert.ok(esPartial52.ledger.margin !== null);

  // P2-6: Mixed cartons[] with 4x 60x50x40 cm sums 80 kg volumetric > 52 kg actual ($1.20/set), and malformed carton_cm [60,50,null] is rejected!
  const mixedCartonsVol = computeHeadhaulWithA4Rules({
    cartons: [
      { count: 2, carton_cm: [60, 50, 40], weight_kg: 13 },
      { count: 2, carton_cm: [60, 50, 40], weight_kg: 13 },
    ],
    actual_weight_kg_total: 52,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(mixedCartonsVol.amount_usd, 1.20);
  assert.equal(mixedCartonsVol.a4_applied.volumetric_exceeds_actual, true);

  const malformedCm = computeHeadhaulWithA4Rules({
    carton_cm: [60, 50, null],
    carton_count: 4,
    actual_weight_kg_total: 52,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(malformedCm.amount_usd, null);
  assert.equal(malformedCm.missing_surcharge_quote, true);

  // P2-7: Gate 1A respects headhaul.order_units: 120 when top-level order_units is omitted ($0.75/set, not $0.90/set!)
  const g1a120 = estimateGate1A2027({
    pkg: ISSUE5_BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: ISSUE5_BASE_REFERRAL,
    collection_rate: 0.006,
    headhaul: {
      carton_count: 4,
      weight_per_carton_kg: 15,
      order_units: 120,
      rate_cny_per_kg: 10.50,
      surcharge_cny_per_kg: 0,
      bond_cny_per_kg: 0,
    },
    profile_revision: 59,
  });
  assert.equal(g1a120.status, 'verified');
  assert.equal(g1a120.components.headhaul.amount_usd, 0.75);
});

test('Issue #5 adversarial review regressions: cartons[] vs actual_weight_kg_per_unit, carton lower-bound vs chargeable_kg_per_unit, mixed usd_per_unit bypass, and order_units conflict parity', async () => {
  // 1) cartons[] total weight (4 x 15 = 60 kg) conflicting with actual_weight_kg_per_unit (0.40 x 100 = 40 kg)
  const cartonsVsPerUnit = computeHeadhaulWithA4Rules({
    cartons: [{ count: 4, carton_cm: [30, 30, 30], weight_kg: 15 }],
    actual_weight_kg_per_unit: 0.40,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  }, 7, 100, { isR58: true, isR59: true });
  assert.equal(cartonsVsPerUnit.amount_usd, null);
  assert.equal(cartonsVsPerUnit.weight_conflict, true);

  // 2) Unknown carton_count or partial last carton: weight_per_carton_kg lower bound rejects impossible underbilled chargeable_kg_per_unit
  const underbilledUnknownCount = computeHeadhaulWithA4Rules({
    weight_per_carton_kg: 15,
    chargeable_kg_per_unit: 0.10, // 10 kg total < 15 kg single carton minimum!
    rate_cny_per_kg: 10.0,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 1.0,
  }, 7.2, 100, { isR58: true, isR59: true });
  assert.equal(underbilledUnknownCount.amount_usd, null);
  assert.equal(underbilledUnknownCount.weight_conflict, true);

  const underbilledPartialCarton = computeHeadhaulWithA4Rules({
    units_per_carton: 30, // 100 sets => at least 3 full cartons = 45 kg
    weight_per_carton_kg: 15,
    chargeable_kg_per_unit: 0.20, // 20 kg total < 45 kg full-carton floor!
    rate_cny_per_kg: 10.0,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 1.0,
  }, 7.2, 100, { isR58: true, isR59: true });
  assert.equal(underbilledPartialCarton.amount_usd, null);
  assert.equal(underbilledPartialCarton.weight_conflict, true);

  // 3) Mixed usd_per_unit + structured per-kg/carton keys must NEVER bypass A4 conflict checks in profit-check or CLI reverse-1688
  const mixedBypassHh = {
    usd_per_unit: 0.27,
    bond_included: true,
    carton_count: 4,
    weight_per_carton_kg: 15,
    actual_weight_kg_total: 40,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  };
  const directMixed = computeHeadhaulWithA4Rules(mixedBypassHh, 7, 100, { isR58: true, isR59: true });
  assert.equal(directMixed.amount_usd, null);
  assert.equal(directMixed.weight_conflict, true);

  const hcMixed = runFastProfitHealthcheck2027({
    pkg: ISSUE5_BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: 50,
    headhaul: mixedBypassHh,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: ISSUE5_BASE_REFERRAL,
    collection_rate: 0.006,
  });
  assert.equal(hcMixed.realized_2027_off_peak.status, 'needs_calculator_verification');
  assert.equal(hcMixed.realized_2027_off_peak.margin, null);

  await withTempDirAsync('issue5-mixed-cli-', async dir => {
    const specPath = join(dir, 'rev-mixed.json');
    writeFileSync(specPath, JSON.stringify({
      fx_cny_per_usd: 7.0,
      pkg: ISSUE5_BASE_STD_PKG,
      headhaul: mixedBypassHh,
      quote: { goods_cny_total: 5000, order_units: 100 },
    }), 'utf8');
    const { code, stdout } = await runCliMem(['reverse-1688', '--db', join(dir, 't.sqlite'), '--input', specPath]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.reverse_1688.solution.status, 'needs_calculator_verification');
  });

  // 4) Conflicting outer order_units (100) vs headhaul.order_units (200) must reject consistently across ALL entrypoints
  const orderConflictHh = {
    carton_count: 4,
    weight_per_carton_kg: 15,
    order_units: 200,
    rate_cny_per_kg: 10.50,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 0,
  };
  assert.equal(computeHeadhaulWithA4Rules(orderConflictHh, 7, 100, { isR58: true, isR59: true }).weight_conflict, true);
  const esOrderConflict = evaluateEarlyScreen(makeIssue5EarlyScreenInput(orderConflictHh));
  assert.equal(esOrderConflict.metrics.headhaul_usd, null);
  assert.equal(esOrderConflict.ledger.margin, null);
  const econOrderConflict = calculateEconomics(makeIssue5FormalLedger(orderConflictHh, 0.90), { profileRevision: 59, requireFeeBasis: false });
  assert.equal(econOrderConflict.margin, null);
  assert.ok(econOrderConflict.pending_lines.includes('headhaul'));
  const valOrderConflict = validateFeeBasis(makeIssue5FormalLedger(orderConflictHh, 0.90), {
    profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(valOrderConflict.status, 'needs_evidence');
  assert.ok(valOrderConflict.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_weight_conflict'));
});

test('Issue #23: Kaiqi ¥10.0/kg nationwide base rate and bare-goods disclosure are registered in business-thresholds', () => {
  const EXPECTED_DISCLOSURE = '当前按 1688 裸货价算，未含国内到深圳运费（常规约占 0.5%～1.5%，超大超重抛货拿样下单前实询）';
  assert.equal(BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg, 10.0);
  assert.equal(BUSINESS_THRESHOLD_AUDIT_REGISTRY.kaiqi_nationwide_sea_truck_base_cny_per_kg.confirmed_at, '2026-11-26');
  assert.equal(BARE_GOODS_DISCLOSURE_ZH, EXPECTED_DISCLOSURE);
});

test('Issue #23 (ADR-0001): steady-state multi-warehouse $0 placement decouples from 100-set cartons, blocks US-West ¥8.48/kg + $0 placement, and emits >=50kg/dest advisory note', () => {
  const STD_PKG = { id: 'pkg-std', length_in: 10, width_in: 8, height_in: 3, weight_lb: 1.0 };
  const REF_TERMS = {
    referral_fraction: 0.15,
    refund_admin_fraction: 0.20,
    refund_admin_cap_usd: 5.00,
    minimum_referral_usd: 0.30,
  };
  const WIN_2027 = {
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };

  // 1) Ultra-light SKU: 100 sets, 4 cartons x 5 kg = 20 kg total (<50 kg, <8 kg/carton)
  const kaiqiLightHeadhaul = {
    carton_count: 4,
    weight_per_carton_kg: 5,
    carton_cm: [30, 30, 20],
    rate_cny_per_kg: 10.0,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 1.0,
  };
  const hhSteady = computeHeadhaulWithA4Rules(kaiqiLightHeadhaul, 7.2, 100, { isR58: true, isR59: true });
  assert.equal(hhSteady.missing_surcharge_quote ?? false, false, 'Steady-state primary headhaul must NOT block on 100-set <50kg or <8kg test-batch penalties');
  assert.equal(hhSteady.a4_applied.billed_total_kg, 20);
  assert.equal(hhSteady.a4_applied.replenishment_50kg_per_destination_units, 250, '0.2 kg/set -> 250 sets/destination to clear 50 kg');
  assert.match(hhSteady.a4_applied.advisory_replenishment_note, /50 kg/);
  assert.ok(Math.abs(hhSteady.amount_usd - ((20 * 11) / 100 / 7.2)) < 1e-6);

  // 2) Gate 1A defaults to steady-state $0 amazon_optimized when paired with Kaiqi >= ¥10.0/kg (even with <5 cartons on 100-set quote)
  const g1aSteady = estimateGate1A2027({
    pkg: STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: REF_TERMS,
    collection_rate: 0.006,
    order_units: 100,
    headhaul: kaiqiLightHeadhaul,
    profile_revision: 59,
  });
  assert.equal(g1aSteady.status, 'verified');
  assert.equal(g1aSteady.components.placement.split_option, 'amazon_optimized');
  assert.equal(g1aSteady.components.placement.selected_usd, 0);
  assert.equal(g1aSteady.components.headhaul.a4_applied.replenishment_50kg_per_destination_units, 250);

  // 3) Structural block: pure US-West ¥8.48/kg + non-oversize $0 amazon_optimized MUST be rejected (even with identical_cartons_count: 5 & multi_destination_headhaul_verified: true!)
  const usWestHeadhaul = {
    carton_count: 5,
    weight_per_carton_kg: 12,
    rate_cny_per_kg: 8.48,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 1.0,
  };
  const g1aUsWestZeroPlace = estimateGate1A2027({
    pkg: STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: REF_TERMS,
    collection_rate: 0.006,
    order_units: 100,
    headhaul: usWestHeadhaul,
    placement_split_option: 'amazon_optimized',
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    profile_revision: 59,
  });
  assert.equal(g1aUsWestZeroPlace.status, 'sensitivity_only', 'Pure US-West ¥8.48/kg must be structurally blocked from non-oversize $0 amazon_optimized placement');

  const plcUsWestDirect = lookupBulkyPlacementFee2027({
    pkg: STD_PKG,
    inbound_window: WIN_2027.inbound,
    split_option: 'amazon_optimized',
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    headhaul_rate_cny_per_kg: 8.48,
  });
  assert.equal(plcUsWestDirect.status, 'sensitivity_only');

  const esUsWestZeroPlace = evaluateEarlyScreen({
    profile_revision: 59,
    id: 'es-us-west-block',
    saleable_unit: '1 synthetic desk tray',
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    order_units: 100,
    goods_cny_per_unit: 40,
    goods_first_order_promotion: false,
    headhaul: usWestHeadhaul,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    fee_category: 'Home and Kitchen',
    pkg: STD_PKG,
    is_apparel_or_shoes: false,
    referral_terms: REF_TERMS,
    fulfillment_usd: 4.50,
    placement_usd: 0,
    placement_split_option: 'amazon_optimized',
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    storage: { cubic_feet_per_unit: 0.1389, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...WIN_2027 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  });
  assert.equal(esUsWestZeroPlace.gate_status, 'pending', 'evaluateEarlyScreen must block US-West ¥8.48/kg paired with $0 placement');
  assert.equal(esUsWestZeroPlace.ledger.margin, null);

  // Explicit headhaul_destination_scope: 'us_west_single' even at ¥10.50/kg is also blocked from $0 placement!
  const g1aScopeBlock = estimateGate1A2027({
    pkg: STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: REF_TERMS,
    collection_rate: 0.006,
    order_units: 100,
    headhaul: { ...kaiqiLightHeadhaul, destination_scope: 'us_west_single' },
    placement_split_option: 'amazon_optimized',
    profile_revision: 59,
  });
  assert.equal(g1aScopeBlock.status, 'sensitivity_only');
});
