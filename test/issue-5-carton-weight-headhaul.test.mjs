import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeHeadhaulWithA4Rules,
  estimateGate1A2027,
  validateFeeBasis,
} from '../src/fba-calculator.mjs';
import {
  calculateEconomics,
  evaluateEarlyScreen,
} from '../src/economics.mjs';
import { runFastProfitHealthcheck2027 } from '../src/pipeline.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';

const BASE_STD_PKG = {
  id: 'pkg-1',
  length_in: 10,
  width_in: 8,
  height_in: 4,
  weight_lb: 1.2,
};

const BASE_WINDOW = {
  sales: { from: '2027-02-01', through: '2027-10-14' },
  storage: { from: '2027-02-01', through: '2027-09-30' },
  inbound: { from: '2027-01-15', through: '2027-10-14' },
};

const BASE_REFERRAL = {
  referral_fraction: 0.15,
  refund_admin_fraction: 0.20,
  refund_admin_cap_usd: 5.00,
  minimum_referral_usd: 0.30,
};

function makeEarlyScreenInput(headhaul) {
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
    pkg: BASE_STD_PKG,
    is_apparel_or_shoes: false,
    referral_terms: BASE_REFERRAL,
    fulfillment_usd: 5.50,
    placement_usd: 0.40,
    storage: { cubic_feet_per_unit: 0.1852, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-1', ...BASE_WINDOW },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  };
}

function makeFormalLedger(headhaulSpec, headhaulAmountUsd = 0.90) {
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
    referral_terms: BASE_REFERRAL,
    collection_rate: 0.006,
    packages: [BASE_STD_PKG],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-1', ...BASE_WINDOW },
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
  const esPerCarton = evaluateEarlyScreen(makeEarlyScreenInput(actualHeavySpec));
  const esWithTotal = evaluateEarlyScreen(makeEarlyScreenInput({ ...actualHeavySpec, actual_weight_kg_total: 60 }));
  assert.equal(esPerCarton.metrics.headhaul_usd, 0.90);
  assert.equal(esWithTotal.metrics.headhaul_usd, 0.90);
  assert.equal(esPerCarton.metrics.margin, esWithTotal.metrics.margin);

  const esVolHeavy = evaluateEarlyScreen(makeEarlyScreenInput(volHeavySpec));
  assert.equal(esVolHeavy.metrics.headhaul_usd, 1.20);
  assert.equal(esVolHeavy.headhaul_a4_applied.volumetric_exceeds_actual, true);

  const conflictSpec = { ...actualHeavySpec, actual_weight_kg_total: 40 };
  const esConflict = evaluateEarlyScreen(makeEarlyScreenInput(conflictSpec));
  assert.equal(esConflict.metrics.headhaul_usd, null);
  assert.equal(esConflict.ledger.margin, null);
  assert.equal(esConflict.headhaul_a4_applied?.weight_conflict, true);
  assert.ok(esConflict.reasons.some(r => /conflict|冲突/i.test(r)), 'evaluateEarlyScreen must preserve weight conflict reason');

  // 2) calculateEconomics & validateFeeBasis (formal cost entrypoints)
  const formalOk = calculateEconomics(
    makeFormalLedger(actualHeavySpec, 0.90),
    { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(formalOk.lines.find(l => l.id === 'headhaul').amount_usd, 0.90);
  assert.ok(formalOk.margin !== null);

  // Underbilled $0.27 (old volumetric-only bug) must be rejected by validateFeeBasis + calculateEconomics!
  const formalUnderbilled = validateFeeBasis(
    makeFormalLedger(actualHeavySpec, 0.27),
    { profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(formalUnderbilled.status, 'needs_evidence');
  assert.ok(formalUnderbilled.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_tariff_mismatch'));

  const formalConflictVal = validateFeeBasis(
    makeFormalLedger(conflictSpec, 0.90),
    { profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10] },
  );
  assert.equal(formalConflictVal.status, 'needs_evidence');
  assert.ok(formalConflictVal.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_weight_conflict'));

  const formalConflictEcon = calculateEconomics(
    makeFormalLedger(conflictSpec, 0.90),
    { profileRevision: 59, requireFeeBasis: false },
  );
  assert.equal(formalConflictEcon.margin, null, 'Direct calculateEconomics must hold conflicted headhaul pending');
  assert.ok(formalConflictEcon.pending_lines.includes('headhaul'));

  // 3) estimateGate1A2027
  const g1aBase = {
    pkg: BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: BASE_REFERRAL,
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
    makeFormalLedger(volHeavySpec, 0.90),
    { profileRevision: 59, requireFeeBasis: false },
  );
  assert.equal(volLedgerLoose.lines.find(l => l.id === 'headhaul').amount_usd, 1.20);

  const volLedgerStrict = calculateEconomics(
    makeFormalLedger(volHeavySpec, 0.90),
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
    pkg: BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: BASE_REFERRAL,
    collection_rate: 0.006,
    headhaul_usd: 0.27,
    headhaul: conflictSpec,
    profile_revision: 59,
  });
  assert.equal(g1aBypassAttempt.status, 'needs_calculator_verification');
  assert.equal(g1aBypassAttempt.weight_conflict, true);

  const hcBypassAttempt = runFastProfitHealthcheck2027({
    pkg: BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: 50,
    domestic_freight_cny_total: 100,
    headhaul_usd: 0.27,
    headhaul: conflictSpec,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: BASE_REFERRAL,
    collection_rate: 0.006,
  });
  assert.equal(hcBypassAttempt.realized_2027_off_peak.status, 'needs_calculator_verification');
  assert.equal(hcBypassAttempt.realized_2027_off_peak.margin, null);

  // P1-2: Conflict placed in input.headhaul (even when line.cny_derivation is absent or stale) is caught in BOTH non-strict & strict calculateEconomics/validateFeeBasis!
  const ledgerWithRootConflict = makeFormalLedger(undefined, 0.27);
  delete ledgerWithRootConflict.lines.find(l => l.id === 'headhaul').cny_derivation;
  ledgerWithRootConflict.headhaul = conflictSpec;
  const looseRootConflict = calculateEconomics(ledgerWithRootConflict, { profileRevision: 59, requireFeeBasis: false });
  assert.equal(looseRootConflict.margin, null);
  assert.ok(looseRootConflict.pending_lines.includes('headhaul'));
  assert.ok(/conflicts/i.test(looseRootConflict.headhaul_conflict_reason));

  const strictWithStaleDeriv = makeFormalLedger({
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
    ...makeEarlyScreenInput({
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
  const esPartial52 = evaluateEarlyScreen(makeEarlyScreenInput({
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
    pkg: BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: BASE_REFERRAL,
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
    pkg: BASE_STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: 50,
    headhaul: mixedBypassHh,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: BASE_REFERRAL,
    collection_rate: 0.006,
  });
  assert.equal(hcMixed.realized_2027_off_peak.status, 'needs_calculator_verification');
  assert.equal(hcMixed.realized_2027_off_peak.margin, null);

  const dir = mkdtempSync(join(tmpdir(), 'issue5-mixed-cli-'));
  try {
    const specPath = join(dir, 'rev-mixed.json');
    writeFileSync(specPath, JSON.stringify({
      fx_cny_per_usd: 7.0,
      pkg: BASE_STD_PKG,
      headhaul: mixedBypassHh,
      quote: { goods_cny_total: 5000, order_units: 100 },
    }), 'utf8');
    let out = '';
    const code = await runPhase2Cli(['reverse-1688', '--db', join(dir, 't.sqlite'), '--input', specPath], {
      stdout: { write: s => { out += String(s); } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.reverse_1688.solution.status, 'needs_calculator_verification');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

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
  const esOrderConflict = evaluateEarlyScreen(makeEarlyScreenInput(orderConflictHh));
  assert.equal(esOrderConflict.metrics.headhaul_usd, null);
  assert.equal(esOrderConflict.ledger.margin, null);
  const econOrderConflict = calculateEconomics(makeFormalLedger(orderConflictHh, 0.90), { profileRevision: 59, requireFeeBasis: false });
  assert.equal(econOrderConflict.margin, null);
  assert.ok(econOrderConflict.pending_lines.includes('headhaul'));
  const valOrderConflict = validateFeeBasis(makeFormalLedger(orderConflictHh, 0.90), {
    profileRevision: 59, evidenceIds: ['ev-1688', 'ev-hh', 'ev-fba'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(valOrderConflict.status, 'needs_evidence');
  assert.ok(valOrderConflict.issues.some(i => i.line === 'headhaul' && i.code === 'headhaul_weight_conflict'));
});
