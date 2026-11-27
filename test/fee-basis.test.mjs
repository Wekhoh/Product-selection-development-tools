import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';
import {
  FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_UNPUBLISHED_PEAK_WINDOW,
  UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
  buildOutOfTableLookupDirective,
  classifySizeTier2027,
  classifyStandardSize2027,
  computeHeadhaulWithA4Rules,
  computeMatchedPeerMedianPackage,
  computeNegotiationShortlist,
  computeOrderPlan,
  computePackagingRedesignShortlist2027,
  estimateGate1A2027,
  evaluatePriceCliff2027,
  getFba2027RateTableSnapshot,
  isCategoryLowPriceEligible2027,
  lookupApparelFulfillmentFee2027,
  lookupBulkyFulfillmentFee2027,
  lookupDangerousGoodsFulfillmentFee2027,
  lookupDangerousGoodsStorageFee2027,
  lookupFulfillmentFee2027,
  lookupOversizeFulfillmentFee2027,
  lookupOversizeHandlingFees2027,
  lookupPlacementFee2027,
  lookupReturnsProcessing2027,
  lookupStorageFee2027,
  lookupUnifiedFulfillmentFee2027,
  lookupUnifiedPlacementFee2027,
  lookupUnifiedReturnsProcessing2027,
  lookupVerified2027PerReturnFee,
  validateFeeBasis,
} from '../src/fba-calculator.mjs';
import { extractSpApiFinalistCalibration } from '../src/adapters/sp-api.mjs';
import { resolveTargetChildSalesObservation } from '../src/observations.mjs';
import { buildPairedSeasonalOperatingPeriods, ingestTrialSpecification } from '../src/raw-ingest.mjs';
import { runFastProfitHealthcheck2027 } from '../src/pipeline.mjs';
import { scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { loadR59Profile, loadSyntheticBatch, withTempDir } from './helpers/test-fixtures.mjs';

const r59Profile = loadR59Profile();
const synthBatch = loadSyntheticBatch();

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
      evidence: ['synthetic-source'], components: id === 'headhaul' ? ['headhaul', 'carrier_bond'] : [id],
      ...(id === 'procurement' ? { order_units: 100, first_order_promotion: false } : {}),
      ...(id === 'domestic_freight' ? { order_units: 100, first_order_promotion: false } : {}),
      ...(id === 'headhaul' ? { bond_included: true } : {}),
      ...(id === 'returns_processing' ? { return_threshold: 0.081 } : {}),
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
  const profile = loadR59Profile();
  const candidate = loadSyntheticBatch().candidates[0];
  const sc = candidate.economics.scenarios[0];
  sc.margin = { value: 0.7, unit: 'fraction', evidence: ['synthetic-evidence'] };
  sc.contribution_usd = { value: 35, unit: 'USD', evidence: ['synthetic-evidence'] };
  const fulLine = sc.cost_ledger.lines.find(line => line.id === 'fulfillment');
  const origThrough = fulLine.fee_basis.effective_through;
  fulLine.fee_basis.effective_through = '2027-02-15';
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.total, null);
  assert.equal(result.diagnostics.economics.margin_range, null);
  assert.match(result.diagnostics.economics.scenarios[0].margin.reason, /fulfillment/);
  fulLine.fee_basis.effective_through = origThrough;
  const corrected = scoreCandidate(candidate, profile);
  assert.ok(corrected.diagnostics.economics.margin_range[0] > 0.30 && corrected.diagnostics.economics.margin_range[0] < 0.70);
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
  const profile = loadR59Profile();
  const candidate = loadSyntheticBatch().candidates[0];
  const off = candidate.economics.scenarios[0];
  off.cost_ledger.fee_context.sales = off.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
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
  const html = renderReport({ profile_revision: 59, candidates:[result], queues:{} }, { candidates:[candidate] });
  assert.match(html, /2027-10-01/);
  assert.match(html, /待补证|未知/);
  peak.cost_ledger.lines.find(line => line.id === 'storage').fee_basis.months = '10,11,12';
  const malformed = scoreCandidate(candidate, profile);
  assert.equal(malformed.operating_periods[0].queue, 'comparable');
  assert.equal(malformed.operating_periods[1].queue, 'pending');
  assert.doesNotThrow(() => renderReport({ profile_revision: 59, candidates:[malformed], queues:{} }, { candidates:[candidate] }));
});

test('a sensitivity-only ledger is shown as an unscored conditional estimate, not a missing fee date', () => {
  const profile = loadR59Profile();
  const candidate = loadSyntheticBatch().candidates[0];
  for (const scenario of candidate.economics.scenarios) scenario.cost_ledger.sensitivity_only = true;
  const result = scoreCandidate(candidate, profile);
  const calculations = result.diagnostics.economics.scenarios.map(scenario => scenario.input.calculation);
  assert.ok(calculations.every(calc => calc.status === 'sensitivity_only' && calc.fee_validation.status === 'validated'));
  assert.equal(result.diagnostics.economics.margin_range, null);
  assert.equal(result.total, null);
  const html = renderReport({ profile_revision: 59, candidates:[result], queues:{} }, { candidates:[candidate] });
  assert.match(html, /不授予经济分|敏感性|完整总分待补证/);
  assert.doesNotMatch(html, /完整费用尚待补证：费率适用日期或来源/);
  assert.doesNotMatch(html, /该情景满足毛利条件/);
});

// --- Migrated from test/revision58.test.mjs (2027 FBA rates, price cliff, storage/placement/returns, shortlist, order plan, fee-basis parity) ---

test('r59 aligns r_refund vs r_physical excess returns processing, tri-state Gate-1 checks, and date validation across early-screen, fee-basis, and economics', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const baseEarly = {
    profile_revision: 59,
    saleable_unit: 'one synthetic tool',
    price_usd: 29.99,
    fx_cny_per_usd: 7.2,
    order_units: 120,
    procurement_usd: 5.5,
    domestic_freight_usd: 0.5,
    first_order_promotion: false,
    headhaul: { usd_per_unit: 2.0, bond_included: true },
    refund_fraction: 0.05,
    physical_return_fraction: 0.12,
    return_threshold: 0.087,
    per_return_fee_usd: 4.32,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    fulfillment_usd: 5.92,
    placement_usd: 0.4,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    operating_period: 'off_peak',
    fee_context: validFeeCtx,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  };

  const ePass = evaluateEarlyScreen(baseEarly);
  assert.equal(ePass.gate_status, 'pass');
  assert.equal(ePass.ledger.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256);

  const mkRetLedger = retOverrides => ({
    id: 'r59-ret-check',
    saleable_unit: 'one synthetic tool',
    price_usd: 29.99,
    refund_fraction: 0.05,
    physical_return_fraction: 0.12,
    assumptions: ['R59 excess returns alignment check'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    collection_rate: 0.006,
    fee_context: validFeeCtx,
    lines: [
      { id: 'procurement', amount_usd: 5.5, status: 'estimated', basis: 'Regular', evidence: ['src'], order_units: 120, first_order_promotion: false, components: ['procurement'] },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Regular', evidence: ['src'], order_units: 120, first_order_promotion: false, components: ['domestic_freight'] },
      { id: 'headhaul', amount_usd: 2.0, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 4.3635, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { status: 'published', version: '2027', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-01', effective_through: '2027-12-31', evidence: ['src'] } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: { status: 'published', version: '2027', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] } },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { status: 'published', version: '2027', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: null, evidence: ['src'] } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { status: 'published', version: '2027', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9], evidence: ['src'] } },
      {
        id: 'returns_processing', amount_usd: 0.14256, status: 'estimated', basis: 'Excess returns',
        evidence: ['src'], components: ['returns_processing'],
        return_threshold: 0.087, per_return_fee_usd: 4.32,
        fee_basis: { status: 'published', version: '2027', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, evidence: ['src'] },
        ...retOverrides,
      },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Paired deferral', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.09, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { status: 'published', version: '2027', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-01', effective_through: null, evidence: ['src'] } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Paired deferral', evidence: ['src'] },
    ],
  });

  const econOk = calculateEconomics(mkRetLedger({}), { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(econOk.scoring_supported, true);
  assert.equal(econOk.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256);
  assert.equal(econOk.margin, ePass.metrics.margin);

  const earlyZero = evaluateEarlyScreen({ ...baseEarly, returns_processing_usd: 0 });
  assert.equal(earlyZero.gate_status, 'pending');
  assert.ok(earlyZero.ledger.pending_lines.includes('returns_processing'));

  const fbZero = validateFeeBasis(mkRetLedger({ amount_usd: 0, status: 'not_applicable' }), { profileRevision: 59, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(fbZero.status, 'needs_evidence');
  assert.ok(fbZero.issues.some(i => i.code === 'returns_processing_required'));

  const econZero = calculateEconomics(mkRetLedger({ amount_usd: 0, status: 'not_applicable' }), { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(econZero.scoring_supported, false);
  assert.ok(econZero.pending_lines.includes('returns_processing'));

  const econZeroDirect = calculateEconomics(mkRetLedger({ amount_usd: 0, status: 'not_applicable' }), { profileRevision: 59 });
  assert.equal(econZeroDirect.scoring_supported, false);
  assert.ok(econZeroDirect.pending_lines.includes('returns_processing'));

  const bareNoRet = evaluateEarlyScreen({ ...baseEarly, physical_return_fraction: 0.05 });
  const boundaryProc = Math.floor((bareNoRet.metrics.procurement_cap_at_floor_usd - 0.05) * 100) / 100;
  assert.equal(evaluateEarlyScreen({ ...baseEarly, procurement_usd: boundaryProc, physical_return_fraction: 0.05 }).gate_status, 'pass');
  const failAboveThresh = evaluateEarlyScreen({ ...baseEarly, procurement_usd: boundaryProc, physical_return_fraction: 0.12 });
  assert.equal(failAboveThresh.gate_status, 'fail');
  assert.ok(failAboveThresh.metrics.margin < 0.3);

  assert.equal(evaluateEarlyScreen({ ...baseEarly, returns_processing_usd: 0, returns_processing_exemption: { reason: 'Un-evidenced claim' } }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, returns_processing_usd: 0, returns_processing_exemption: { reason: 'Fake ID', evidence: ['unregistered-id'] } }).gate_status, 'pending');
  const earlyExempt = evaluateEarlyScreen({ ...baseEarly, evidence_ids: ['src'], returns_processing_usd: 0, returns_processing_exemption: { reason: 'Official <25/mo threshold waiver', evidence: ['src'] } });
  assert.equal(earlyExempt.gate_status, 'pass');
  assert.equal(earlyExempt.ledger.lines.find(l => l.id === 'returns_processing').amount_usd, 0);
  const econExempt = calculateEconomics(mkRetLedger({
    amount_usd: 0, status: 'not_applicable',
    exemption: { reason: 'Official waiver', evidence: ['src'] },
  }), { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(econExempt.scoring_supported, true);

  assert.throws(() => evaluateEarlyScreen({ ...baseEarly, specific_rights_conflict: 'false' }), TypeError);
  assert.throws(() => evaluateEarlyScreen({ ...baseEarly, strong_date_dependency: 'no' }), TypeError);

  const rightsUnknown = evaluateEarlyScreen({ ...baseEarly, specific_rights_conflict: 'unknown' });
  assert.equal(rightsUnknown.gate_status, 'economic_pass_rights_unsearched');
  assert.equal(rightsUnknown.proceed_to_gate2, true);
  assert.equal(rightsUnknown.proceed_to_21_items, false);

  const dateUnknown = evaluateEarlyScreen({ ...baseEarly, strong_date_dependency: undefined });
  assert.equal(dateUnknown.gate_status, 'pending');
  assert.equal(dateUnknown.checks.strong_date_dependency, 'date_unverified');
  assert.equal(dateUnknown.proceed_to_21_items, false);
  assert.equal(dateUnknown.proceed_to_gate2, false);

  const strongFailWins = evaluateEarlyScreen({ ...baseEarly, price_usd: 25, specific_rights_conflict: 'unknown' });
  assert.equal(strongFailWins.gate_status, 'fail');
  assert.equal(strongFailWins.proceed_to_gate2, false);

  const noDates = structuredClone(baseEarly);
  delete noDates.fee_context;
  assert.equal(evaluateEarlyScreen(noDates).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, sales_window: { from: '2027-03-01', through: '2027-09-30' } }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({
    ...baseEarly,
    operating_period: 'peak',
    fee_context: { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } },
    fulfillment_fee_basis: { status: 'published', effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
  }).gate_status, 'pending');

  const gate1A = structuredClone(baseEarly);
  delete gate1A.procurement_usd;
  delete gate1A.domestic_freight_usd;
  const g1aRes = evaluateEarlyScreen(gate1A);
  assert.equal(g1aRes.gate_status, 'pending');
  assert.ok(g1aRes.metrics.landed_domestic_cap_at_floor_usd > 0);
  assert.ok(g1aRes.metrics.landed_domestic_cap_at_floor_cny > 0);
});

test('2027 US Standard-size table, $49.99/$50.00/$50.01 cliff, landed cap, oversize pending, shortlist, and carton/MOQ sku_lines', () => {
  const pkg152 = { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.52 };
  const refTerms = { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 };
  const offWin = { from: '2027-02-01', through: '2027-09-30' };
  const inbWin = { from: '2027-01-15', through: '2027-01-15' };

  const cliff = evaluatePriceCliff2027({
    pkg: pkg152,
    price_usd: 50.50,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.05,
    fee_category: 'Business, Industrial, and Scientific Supplies',
    return_threshold: 0.06,
    referral_terms: refTerms,
    headhaul_usd: 2.5,
    placement_usd: 0.4,
    collection_rate: 0.006,
    sales_window: offWin,
    storage_window: offWin,
    inbound_window: inbWin,
  }, { landed_domestic_usd: 10 });
  assert.equal(cliff.status, 'verified');
  assert.equal(cliff.cliff_jump_usd, 0.58995);
  assert.equal(cliff.points.find(p => p.price_usd === 49.99).fulfillment_usd, 5.9202);
  assert.equal(cliff.points.find(p => p.price_usd === 50.00).fulfillment_usd, 5.9202);
  assert.equal(cliff.points.find(p => p.price_usd === 50.01).fulfillment_usd, 6.51015);
  assert.equal(cliff.sweet_spot_alert, true);

  for (const a of [
    { dims: [10, 7, 4], wt: 2.58, price: 39.99, exp: 6.6447 },
    { dims: [10, 7, 4], wt: 2.97, price: 39.99, exp: 7.08975 },
    { dims: [12, 9, 5], wt: 6.31, price: 54.99, exp: 9.15975 },
    { dims: [12, 9, 4], wt: 4.278, price: 39.99, exp: 7.9074 },
  ]) {
    const f = lookupFulfillmentFee2027({
      pkg: { length_in: a.dims[0], width_in: a.dims[1], height_in: a.dims[2], unit_weight_lb: a.wt },
      price_usd: a.price,
      sales_window: offWin,
    });
    assert.equal(f.status, 'verified');
    assert.equal(f.total_usd, a.exp);
  }

  assert.equal(classifyStandardSize2027({ length_in: 19, width_in: 10, height_in: 5, unit_weight_lb: 5 }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, is_apparel: true }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, is_dangerous_goods: true }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, is_sipp: true }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, sales_window: { from: '2027-10-15', through: '2027-12-31' } }).status, 'needs_calculator_verification');
  assert.equal(lookupStorageFee2027({ pkg: pkg152, months: [9, 10] }).status, 'needs_calculator_verification');
  assert.equal(lookupReturnsProcessing2027({ pkg: pkg152, physical_return_fraction: 0.06, fee_category: 'Unlisted Exotic Category' }).status, 'needs_calculator_verification');
  assert.equal(lookupPlacementFee2027({ pkg: pkg152, inbound_window: inbWin }).status, 'verified');

  const g1a = estimateGate1A2027({
    pkg: pkg152, price_usd: 49.99, fx_cny_per_usd: 7.2, refund_fraction: 0.05,
    fee_category: 'Business, Industrial, and Scientific Supplies', return_threshold: 0.06,
    referral_terms: refTerms, headhaul_usd: 2.5, placement_usd: 0.4, collection_rate: 0.006,
    sales_window: offWin, storage_window: offWin, inbound_window: inbWin, domestic_freight_usd: 0.8,
  });
  assert.equal(g1a.status, 'verified');
  const expectedNetRev = 49.99 * 0.95;
  const expectedLandedUsd = Math.round((0.70 * expectedNetRev - g1a.non_domestic_cost_a_usd) * 1e10) / 1e10;
  assert.equal(g1a.landed_domestic_cap_usd, expectedLandedUsd);
  assert.equal(g1a.landed_domestic_cap_cny, Math.round(expectedLandedUsd * 7.2 * 1e10) / 1e10);
  assert.equal(g1a.bare_goods_cap_usd, Math.round((expectedLandedUsd - 0.8) * 1e10) / 1e10);

  const negYes = computeNegotiationShortlist({ net_revenue_usd: 40, contribution_usd: 10.4, negotiable_cost_usd: 16 });
  assert.equal(negYes.eligible, true);
  assert.equal(negYes.required_discount_fraction, 0.1);
  assert.equal(computeNegotiationShortlist({ net_revenue_usd: 40, contribution_usd: 10.4, negotiable_cost_usd: 10 }).eligible, false);

  const plan144 = computeOrderPlan({
    sku_lines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, unit_price_cny: 10 }],
    min_sets: 100, allow_remainder: false,
  });
  assert.equal(plan144.allocated_sets, 144);
  assert.equal(plan144.actual_complete_sets, 144);
  assert.equal(plan144.sku_lines[0].ordered_qty, 144);
  assert.equal(plan144.sku_lines[0].remainder_vs_allocated, 0);

  const plan150 = computeOrderPlan({
    sku_lines: [{ sku_id: 'B', qty_per_saleable_set: 1, pack_multiple: 25, moq_qty: 126, unit_price_cny: 10 }],
    min_sets: 120, allow_remainder: true, target_sets: 120,
  });
  assert.equal(plan150.allocated_sets, 120);
  assert.equal(plan150.actual_complete_sets, 150);
  assert.equal(plan150.sku_lines[0].ordered_qty, 150);
  assert.equal(plan150.sku_lines[0].remainder_vs_allocated, 30);

  const skuA = { sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 100, unit_price_cny: 10 };
  const skuB = { sku_id: 'B', qty_per_saleable_set: 1, pack_multiple: 25, moq_qty: 100, unit_price_cny: 20 };
  const planR59Default = computeOrderPlan({ sku_lines: [skuA, skuB], min_sets: 100, allow_remainder: false });
  assert.equal(planR59Default.mode, 'no_remainder_exact');
  assert.equal(planR59Default.allocated_sets, 600);
  assert.equal(planR59Default.high_lcm_advisory, true);
  const planTwoRem = computeOrderPlan({ sku_lines: [skuA, skuB], min_sets: 100, allow_remainder: false, lcm_cap: 200 });
  const planTwoRemRev = computeOrderPlan({ sku_lines: [skuB, skuA], min_sets: 100, allow_remainder: false, lcm_cap: 200 });
  assert.equal(planTwoRem.mode, 'allow_remainder');
  assert.equal(planTwoRem.sku_lines[0].ordered_qty, 120);
  assert.equal(planTwoRem.sku_lines[1].ordered_qty, 100);
  assert.equal(planTwoRem.actual_complete_sets, 100);
  assert.equal(planTwoRem.total_goods_cny, 120 * 10 + 100 * 20);
  assert.equal(planTwoRemRev.allocated_sets, planTwoRem.allocated_sets);
  assert.equal(planTwoRemRev.actual_complete_sets, planTwoRem.actual_complete_sets);
  assert.equal(planTwoRemRev.total_goods_cny, planTwoRem.total_goods_cny);

  const planTwoNoRem = computeOrderPlan({
    sku_lines: [
      { sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 100 },
      { sku_id: 'B', qty_per_saleable_set: 1, pack_multiple: 25, moq_qty: 100 },
    ],
    min_sets: 100, allow_remainder: false, lcm_cap: 1000,
  });
  assert.equal(planTwoNoRem.mode, 'no_remainder_exact');
  assert.equal(planTwoNoRem.allocated_sets, 600);
  assert.equal(planTwoNoRem.actual_complete_sets, 600);
});

test('B09–B12 & Calibration Notes: 3-way returns_processing parity, Gate 1 basis/window strictness, sku_lines tamper rejection, exact $0 landed cap, and BigInt overflow guard', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const baseEarly = {
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 29.99, fx_cny_per_usd: 7.2, order_units: 120, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.12,
    return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    fulfillment_usd: 5.92, placement_usd: 0.4,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.005, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
    fulfillment_fee_basis: validBasis,
  };
  assert.equal(evaluateEarlyScreen(baseEarly).gate_status, 'pass');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, return_threshold: null, returns_processing_usd: 0.00001 }).gate_status, 'pending');

  const mkB09Ledger = (retOverrides = {}) => ({
    id: 'b09-sc', saleable_unit: '1 unit', price_usd: 29.99, refund_fraction: 0.05, physical_return_fraction: 0.12,
    assumptions: ['B09 probe'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005,
    fee_context: validFeeCtx,
    packages: [{ id: 'pack-1', length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, evidence: ['src'] }],
    lines: [
      { id: 'procurement', amount_usd: 5.5, status: 'estimated', basis: '1688', evidence: ['src'], components: ['procurement'], order_units: 120, first_order_promotion: false },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Dom', evidence: ['src'], components: ['domestic_freight'], order_units: 120, first_order_promotion: false },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 4.3186, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_through: null } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: { ...validBasis, package_ref: 'pack-1' } },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_through: null } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { id: 'returns_processing', amount_usd: 0.14256, status: 'estimated', basis: 'Ret', evidence: ['src'], components: ['returns_processing'], return_threshold: 0.087, per_return_fee_usd: 4.32, fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null }, ...retOverrides },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.09, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-01-01', effective_through: null } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
    ],
  });
  assert.equal(validateFeeBasis(mkB09Ledger(), { profileRevision: 59, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'validated');
  assert.equal(calculateEconomics(mkB09Ledger(), { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).scoring_supported, true);
  const noThreshLedger = mkB09Ledger({ amount_usd: 0.00001, return_threshold: undefined });
  assert.equal(validateFeeBasis(noThreshLedger, { profileRevision: 59, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(noThreshLedger, { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).scoring_supported, false);

  const wrongPosLedger = mkB09Ledger({ amount_usd: 0.00001 });
  assert.equal(evaluateEarlyScreen({ ...baseEarly, returns_processing_usd: 0.00001 }).gate_status, 'pending');
  assert.equal(validateFeeBasis(wrongPosLedger, { profileRevision: 59, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(wrongPosLedger, { profileRevision: 59 }).scoring_supported, false);

  const conflictThresh = mkB09Ledger({ return_threshold: 0.90, fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, return_threshold: 0.087 } });
  assert.equal(validateFeeBasis(conflictThresh, { profileRevision: 59, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(conflictThresh, { profileRevision: 59 }).scoring_supported, false);

  assert.equal(evaluateEarlyScreen({
    ...baseEarly,
    operating_period: 'peak',
    fee_context: { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } },
    fulfillment_fee_basis: { status: 'published', effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage_fee_basis: { status: 'published', effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 2.40, average_inventory_days: 45 },
  }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({
    ...baseEarly,
    operating_period: 'peak',
    fee_context: { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } },
    fulfillment_fee_basis: { ...validBasis, effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage_fee_basis: { ...validBasis, effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
  }).gate_status, 'pending');

  assert.equal(estimateGate1A2027({
    profile_revision: 59,
    price_usd: 49.99, refund_fraction: 0.05, physical_return_fraction: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
  }).status, 'verified');
  assert.equal(estimateGate1A2027({
    profile_revision: 59,
    price_usd: 49.99, refund_fraction: 0.05, physical_return_fraction: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-10-15', through: '2027-12-31' },
  }).status, 'needs_calculator_verification');
  assert.equal(estimateGate1A2027({
    price_usd: 49.99, refund_fraction: 0.05, physical_return_fraction: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2029-01-15', through: '2029-01-15' },
  }).status, 'needs_calculator_verification');
  assert.equal(lookupReturnsProcessing2027({
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    fee_category: 'unlisted_exotic_category',
    physical_return_fraction: 0.05,
    return_threshold: 0.99,
  }).status, 'needs_calculator_verification');

  const skuLinesTamper = [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, unit_price_cny: 125, ordered_qty: 144 }];
  const b11Ledger = mkB09Ledger();
  b11Ledger.source_inputs = { fx_cny_per_usd: 7.2 };
  Object.assign(b11Ledger.lines.find(l => l.id === 'procurement'), {
    amount_usd: 0.01, order_units: 144, sku_lines: skuLinesTamper, fx_cny_per_usd: 7.2,
  });
  Object.assign(b11Ledger.lines.find(l => l.id === 'domestic_freight'), { order_units: 144 });
  assert.equal(validateFeeBasis(b11Ledger, { profileRevision: 59, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(b11Ledger, { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).scoring_supported, false);
  assert.equal(calculateEconomics(b11Ledger, { profileRevision: 59 }).scoring_supported, false);
  assert.equal(evaluateEarlyScreen({ ...baseEarly, procurement_usd: 0.01, order_units: 144, fx_cny_per_usd: 7.2, sku_lines: skuLinesTamper }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, procurement_usd: 125 / 7.2, order_units: 125, fx_cny_per_usd: 7.2, sku_lines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, unit_price_cny: 125 }] }).gate_status, 'pending');

  const g1aBase = {
    price_usd: 40, refund_fraction: 0, physical_return_fraction: 0,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  };
  const probeG1a = estimateGate1A2027(g1aBase);
  assert.equal(probeG1a.status, 'verified');
  const exactZeroHeadhaul = Number((28 - (probeG1a.non_domestic_cost_a_usd - 1)).toFixed(10));
  const zeroCapNoFloor = estimateGate1A2027({ ...g1aBase, headhaul_usd: exactZeroHeadhaul });
  assert.equal(zeroCapNoFloor.status, 'verified');
  assert.equal(zeroCapNoFloor.landed_domestic_cap_usd, 0);
  assert.equal(zeroCapNoFloor.zero_browser_fail, false);
  assert.equal(estimateGate1A2027({ ...g1aBase, headhaul_usd: exactZeroHeadhaul, min_landed_domestic_usd: 0.01 }).zero_browser_fail, true);

  assert.equal(computeNegotiationShortlist({ net_revenue_usd: 33.3333333334, contribution_usd: 8.8, negotiable_cost_usd: 10 }).eligible, false);
  const zeroGoodsEarly = evaluateEarlyScreen({ ...baseEarly, procurement_usd: 0, domestic_freight_usd: 10, headhaul: { usd_per_unit: 2, bond_included: true } });
  assert.equal(zeroGoodsEarly.gate_status, 'fail');
  assert.equal(zeroGoodsEarly.negotiation_shortlist, undefined);

  assert.throws(() => computeOrderPlan({
    sku_lines: [{ sku_id: 'BIG', qty_per_saleable_set: 3, pack_multiple: 1, moq_qty: 1 }],
    min_sets: 100, target_sets: 3002399751580331, allow_remainder: true,
  }), RangeError);
});

test('r59 Codex Rounds 2–6 fee-basis, 2027 dim-weight, DG storage, and SKU/FX regressions', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const opts59 = { profileRevision: 59, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };

  const mkSkuLedger = ({ unitPrice = 125, omitUnitPrice = false, procUsd = 125 / 7.2, lineFx = undefined, sourceFx = 7.2, extraRootSkuLines = undefined, priceUsd = 29.99 } = {}) => ({
    id: 'f1-sc', saleable_unit: '1 unit', price_usd: priceUsd, refund_fraction: 0.05, physical_return_fraction: 0.05,
    assumptions: ['F1 probe'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005,
    source_inputs: { fx_cny_per_usd: sourceFx },
    ...(extraRootSkuLines ? { sku_lines: extraRootSkuLines } : {}),
    fee_context: validFeeCtx,
    packages: [{ id: 'pack-1', length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, evidence: ['src'] }],
    lines: [
      {
        id: 'procurement', amount_usd: procUsd, status: 'estimated', basis: '1688', evidence: ['src'], components: ['procurement'],
        order_units: 144, first_order_promotion: false,
        ...(lineFx !== undefined ? { fx_cny_per_usd: lineFx } : {}),
        sku_lines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, ordered_qty: 144, regular_goods_promo_false: true, ...(!omitUnitPrice ? { unit_price_cny: unitPrice } : {}) }],
      },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Dom', evidence: ['src'], components: ['domestic_freight'], order_units: 144, first_order_promotion: false },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 4.3186, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_through: null } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: { ...validBasis, package_ref: 'pack-1' } },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_through: null } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'Below threshold', evidence: ['src'], return_threshold: 0.087, fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null } },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.09, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-01-01', effective_through: null } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
    ],
  });

  // Round-2 Finding 1(a)-(c), Finding 6, Notes
  assert.equal(Object.hasOwn(mkSkuLedger({ omitUnitPrice: true, procUsd: 0.01 }).lines[0].sku_lines[0], 'unit_price_cny'), false);
  assert.equal(calculateEconomics(mkSkuLedger({ omitUnitPrice: true, procUsd: 0.01 }), opts59).scoring_supported, false);
  assert.equal(calculateEconomics(mkSkuLedger({ unitPrice: 125, procUsd: 0.01, lineFx: 12500, sourceFx: 7.2 }), opts59).scoring_supported, false);
  assert.equal(calculateEconomics(mkSkuLedger({ unitPrice: 68.36, procUsd: 9.49 }), opts59).scoring_supported, false);
  assert.equal(calculateEconomics(mkSkuLedger({ unitPrice: 68.36, procUsd: 9.4944444444 }), opts59).scoring_supported, true);

  const q4PeakCtx = { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } };
  const q4PeakLedger = mkSkuLedger({ unitPrice: 40, procUsd: 40 / 7.2 });
  q4PeakLedger.fee_context = q4PeakCtx;
  q4PeakLedger.lines.find(l => l.id === 'fulfillment').fee_basis = { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31' };
  q4PeakLedger.lines.find(l => l.id === 'storage').fee_basis = { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31', months: [10, 11, 12] };
  q4PeakLedger.lines.find(l => l.id === 'storage').amount_usd = 0.0585;
  assert.equal(calculateEconomics(q4PeakLedger, { ...opts59, operatingMonths: [10, 11, 12] }).scoring_supported, false);
  q4PeakLedger.lines.find(l => l.id === 'storage').amount_usd = 0.18;
  assert.equal(calculateEconomics(q4PeakLedger, { ...opts59, operatingMonths: [10, 11, 12] }).scoring_supported, true);

  assert.equal(evaluateEarlyScreen({
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 29.99, fx_cny_per_usd: 7.2, order_units: 120, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, storage: 0.0585, collection_rate: 0.005, other_applicable_usd: 0,
    specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending');

  assert.equal(lookupReturnsProcessing2027({ pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 }, physical_return_fraction: 0.05, return_threshold: 0.99 }).status, 'needs_calculator_verification');
  assert.equal(estimateGate1A2027({
    price_usd: 40, refund_fraction: 0, physical_return_fraction: 0,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2029-02-01', through: '2029-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  }).status, 'needs_calculator_verification');

  const retRecompLedger = mkSkuLedger({ unitPrice: 40, procUsd: 40 / 7.2 });
  retRecompLedger.physical_return_fraction = 0.12;
  Object.assign(retRecompLedger.lines.find(l => l.id === 'returns_processing'), {
    amount_usd: 0.1425591, status: 'estimated', components: ['returns_processing'],
    return_threshold: 0.087, per_return_fee_usd: 4.32,
  });
  const retRecompOut = calculateEconomics(retRecompLedger, opts59);
  assert.equal(retRecompOut.scoring_supported, true);
  assert.equal(retRecompOut.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256);

  const tinyNegBase = {
    price_usd: 40, refund_fraction: 0, physical_return_fraction: 0,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  };
  const tinyProbe = estimateGate1A2027(tinyNegBase);
  const exactZeroHh = Number((28 - (tinyProbe.non_domestic_cost_a_usd - 1)).toFixed(10));
  assert.equal(estimateGate1A2027({ ...tinyNegBase, headhaul_usd: exactZeroHh + 4e-11 }).zero_browser_fail, true);

  // Round-3 R3-1(a), R3-6, R3-7
  const dualSku = mkSkuLedger({
    unitPrice: 125, procUsd: 0.01, sourceFx: 7.2, priceUsd: 40,
    extraRootSkuLines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, ordered_qty: 144, unit_price_cny: 0.072, regular_goods_promo_false: true }],
  });
  assert.equal(validateFeeBasis(dualSku, opts59).status, 'needs_evidence');
  assert.equal(calculateEconomics(dualSku, opts59).scoring_supported, false);

  const fakeOverLedger = mkSkuLedger({ unitPrice: 40, procUsd: 40 / 7.2, priceUsd: 40 });
  fakeOverLedger.fee_context = q4PeakCtx;
  fakeOverLedger.lines.find(l => l.id === 'fulfillment').fee_basis = { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31' };
  Object.assign(fakeOverLedger.lines.find(l => l.id === 'storage'), {
    amount_usd: 0.0585, is_oversize: true,
    fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31', months: [10, 11, 12] },
  });
  assert.equal(calculateEconomics(fakeOverLedger, { ...opts59, operatingMonths: [10, 11, 12] }).scoring_supported, false);

  assert.equal(evaluateEarlyScreen({
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'peak', fee_context: q4PeakCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.5 },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45, is_oversize: true },
    specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending');

  const fakeThreshLedger = mkSkuLedger({ unitPrice: 40, procUsd: 40 / 7.2, priceUsd: 40 });
  fakeThreshLedger.fee_category = 'Tools and Home Improvement';
  fakeThreshLedger.physical_return_fraction = 0.12;
  fakeThreshLedger.refund_fraction = 0.12;
  Object.assign(fakeThreshLedger.lines.find(l => l.id === 'returns_processing'), { amount_usd: 0, status: 'not_applicable', return_threshold: 0.99 });
  assert.equal(validateFeeBasis(fakeThreshLedger, opts59).status, 'needs_evidence');
  assert.equal(calculateEconomics(fakeThreshLedger, opts59).scoring_supported, false);
  assert.equal(evaluateEarlyScreen({
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    fee_category: 'Tools and Home Improvement',
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.12, physical_return_fraction: 0.12, return_threshold: 0.99, returns_processing_usd: 0,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending');

  assert.equal(estimateGate1A2027({
    price_usd: 29.99, refund_fraction: 0.12, physical_return_fraction: 0.12,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Tools and Home Improvement',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-01-15', through: '2027-01-31' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  }).status, 'needs_calculator_verification');

  const r3PkgBase = {
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  };
  assert.equal(evaluateEarlyScreen({ ...r3PkgBase, fulfillment_fee_basis: { ...validBasis, package_ref: 'wrong-pack' } }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({ ...r3PkgBase, fulfillment_fee_basis: { ...validBasis, package_ref: 'pack-1' } }).gate_status, 'pass');

  const r3Handoff = evaluateEarlyScreen({
    profile_revision: 59, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.12, physical_return_fraction: 0.12,
    returns_processing_fee_basis: { ...validBasis, package_ref: 'pack-1', fee_category: 'Tools and Home Improvement', return_threshold: 0.087, per_return_fee_usd: 4.32, effective_from: '2027-02-01', effective_through: null },
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  });
  assert.equal(r3Handoff.gate_status, 'pass');
  assert.equal(r3Handoff.ledger.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256);

  // Round-4 R4-02, R4-08, R4-09, R4-10
  const mkSku = (price, extra = {}) => [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, ordered_qty: 144, unit_price_cny: price, regular_goods_promo_false: true, ...extra }];
  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, sku_lines: mkSku(0.072), source_inputs: { sku_lines: mkSku(125) }, procurement_usd: 0.01,
  }).gate_status, 'pending');
  const dupMetaLedger = mkSkuLedger({
    unitPrice: 40, procUsd: 40 / 7.2, priceUsd: 40,
    extraRootSkuLines: mkSku(40, { offer_id: 'offer-A', quote_unit: 'piece' }),
  });
  dupMetaLedger.lines[0].sku_lines = mkSku(40, { offer_id: 'offer-B', quote_unit: 'box_24' });
  assert.equal(validateFeeBasis(dupMetaLedger, opts59).status, 'needs_evidence');

  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.01, average_inventory_days: 45, is_dangerous_goods: 'false' },
  }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45, is_dangerous_goods: true },
  }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    storage: { cubic_feet_per_unit: 0.00005, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
  }).gate_status, 'pending');
  const dgLedger = structuredClone(dupMetaLedger);
  delete dgLedger.sku_lines;
  delete dgLedger.lines[0].sku_lines;
  Object.assign(dgLedger.lines.find(l => l.id === 'storage'), { amount_usd: 0.00075, is_dangerous_goods: true });
  assert.equal(validateFeeBasis(dgLedger, opts59).status, 'needs_evidence');
  const unmatchPkgLedger = structuredClone(dgLedger);
  Object.assign(unmatchPkgLedger.lines.find(l => l.id === 'storage'), { amount_usd: 0.00075, is_dangerous_goods: false });
  unmatchPkgLedger.packages[0].id = 'different-pack';
  assert.equal(validateFeeBasis(unmatchPkgLedger, opts59).status, 'needs_evidence');

  const fakePerRet = structuredClone(dupMetaLedger);
  delete fakePerRet.sku_lines;
  delete fakePerRet.lines[0].sku_lines;
  fakePerRet.fee_category = 'Tools and Home Improvement';
  fakePerRet.physical_return_fraction = 0.12;
  Object.assign(fakePerRet.lines.find(l => l.id === 'returns_processing'), {
    status: 'estimated', components: ['returns_processing'], return_threshold: 0.087, per_return_fee_usd: 0.01, amount_usd: 0.00033,
  });
  assert.equal(validateFeeBasis(fakePerRet, opts59).status, 'needs_evidence');
  assert.equal(calculateEconomics(fakePerRet, opts59).scoring_supported, false);
  const microThresh = structuredClone(fakePerRet);
  microThresh.physical_return_fraction = 0.0870000004;
  Object.assign(microThresh.lines.find(l => l.id === 'returns_processing'), {
    status: 'not_applicable', return_threshold: 0.0870000005, per_return_fee_usd: undefined, amount_usd: 0, components: undefined,
  });
  assert.equal(validateFeeBasis(microThresh, opts59).status, 'needs_evidence');
  assert.equal(calculateEconomics(microThresh, opts59).scoring_supported, false);

  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, operating_period: undefined, operating_months: [1],
    fee_context: { ...validFeeCtx, sales: { from: '2027-01-15', through: '2027-01-31' }, storage: { from: '2027-01-15', through: '2027-01-31' } },
    fee_category: 'Tools and Home Improvement', physical_return_fraction: 0.12,
    storage_fee_basis: { ...validBasis, months: [1] },
  }).gate_status, 'pending');
  const noPkgRefBasis = { ...validBasis };
  delete noPkgRefBasis.package_ref;
  assert.equal(evaluateEarlyScreen({ ...r3PkgBase, fulfillment_fee_basis: noPkgRefBasis }).gate_status, 'pending');
  const noCtxPkg = structuredClone(r3PkgBase);
  delete noCtxPkg.fee_context.package_ref;
  assert.equal(evaluateEarlyScreen(noCtxPkg).gate_status, 'pending');

  // Round-5 R5-08 & R5-09: root is_dangerous_goods, empty packages[], dup threshold micro-diff, weight conflict
  const mkR5Ledger = () => ({
    ...mkSkuLedger({ unitPrice: 40, procUsd: 5, priceUsd: 40 }),
    id: 'r5-sc', physical_return_fraction: 0.12, fee_category: 'Tools and Home Improvement',
  });
  const r5Base = mkR5Ledger();
  delete r5Base.lines[0].sku_lines;
  r5Base.lines[0].order_units = 120;
  r5Base.lines[1].order_units = 120;
  Object.assign(r5Base.lines.find(l => l.id === 'returns_processing'), {
    amount_usd: 0.14256, status: 'estimated', components: ['returns_processing'],
    return_threshold: 0.087, per_return_fee_usd: 4.32,
    fee_basis: { ...validBasis, version: 'US-FBA-2027-nonpeak-standard-v1', effective_from: '2027-02-01', effective_through: null },
  });
  assert.equal(validateFeeBasis(r5Base, opts59).status, 'validated');

  const rootDgLowStore = structuredClone(r5Base);
  rootDgLowStore.is_dangerous_goods = true;
  assert.equal(validateFeeBasis(rootDgLowStore, opts59).status, 'needs_evidence');

  const emptyPkgsZeroStore = structuredClone(r5Base);
  emptyPkgsZeroStore.packages = [];
  Object.assign(emptyPkgsZeroStore.lines.find(l => l.id === 'storage'), { amount_usd: 0, status: 'not_applicable', components: undefined });
  assert.equal(validateFeeBasis(emptyPkgsZeroStore, opts59).status, 'needs_evidence');

  const dgConflictRet = structuredClone(r5Base);
  dgConflictRet.packages[0].is_dangerous_goods = false;
  dgConflictRet.is_dangerous_goods = true;
  Object.assign(dgConflictRet.lines.find(l => l.id === 'returns_processing'), { per_return_fee_usd: 0.01, amount_usd: 0.00033 });
  assert.equal(validateFeeBasis(dgConflictRet, opts59).status, 'needs_evidence');

  const dupThresh = structuredClone(r5Base);
  Object.assign(dupThresh.lines.find(l => l.id === 'returns_processing'), {
    return_threshold: 0.0870000005,
    fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null, return_threshold: 0.087 },
  });
  assert.equal(validateFeeBasis(dupThresh, opts59).status, 'needs_evidence');
  assert.equal(calculateEconomics(dupThresh, opts59).scoring_supported, false);

  assert.equal(classifyStandardSize2027({ length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75, weight_lb: 0.25 }).status, 'needs_calculator_verification');

  // Round-6 R6-2: exact 13x6.95x5 = 3.25 lb dim-weight & strict boolean/weight parity
  const dimPkg = { length_in: 13, width_in: 6.95, height_in: 5, weight_lb: 1 };
  const dimCls = classifyStandardSize2027(dimPkg);
  assert.equal(dimCls.status, 'verified');
  assert.equal(dimCls.size_tier, 'large_standard');
  assert.equal(dimCls.shipping_weight_lb, 3.25);
  const dimFul = lookupFulfillmentFee2027({ pkg: dimPkg, price_usd: 40 });
  assert.equal(dimFul.status, 'verified');
  assert.equal(dimFul.extra_quarter_lb_steps, 1);
  assert.equal(dimFul.base_usd, 7.24);
  assert.equal(dimFul.total_usd, 7.4934);
  assert.equal(lookupVerified2027PerReturnFee(dimPkg), 5.05);
  const gate1ADim = estimateGate1A2027({
    pkg: dimPkg, price_usd: 40, fx_cny_per_usd: 7.2, refund_fraction: 0.05, physical_return_fraction: 0.05,
    fee_category: 'Tools and Home Improvement', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    headhaul_usd: 2.5, collection_rate: 0.006, other_applicable_usd: 0,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  });
  assert.equal(gate1ADim.status, 'verified');
  assert.ok(gate1ADim.landed_domestic_cap_usd > 9.60 && gate1ADim.landed_domestic_cap_usd < 9.65);

  assert.equal(classifyStandardSize2027({ length_in: 10, width_in: 7, height_in: 3, weight_lb: 1.5, is_dangerous_goods: 'true' }).status, 'needs_calculator_verification');
  assert.equal(classifyStandardSize2027({ length_in: 10, width_in: 7, height_in: 3, weight_lb: 1.5 }, { is_dangerous_goods: 'true' }).status, 'needs_calculator_verification');
  assert.equal(classifyStandardSize2027({ length_in: 10, width_in: 7, height_in: 3, weight_lb: 1.5 }, { is_apparel: 'false' }).status, 'needs_calculator_verification');
  assert.equal(lookupVerified2027PerReturnFee({ length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, unit_weight_lb: 1.7500005 }), null);
  assert.equal(classifyStandardSize2027({ length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, unit_weight_lb: 1.7500005 }).status, 'needs_calculator_verification');
  assert.equal(lookupVerified2027PerReturnFee({ length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, weight_oz: 28 }), 4.32);

  // Sanity reference to shared fixture so imports stay exercised
  assert.equal(r59Profile.revision, 59);
  assert.ok(synthBatch.candidates.length >= 1);
});

test('R3 closure (fees & provenance): SP-API echo block, coupon >=$50 FBA tier, >=5-carton amazon_optimized, A4 volumetric carton_count, SP-API exact-cent, leafRank/LCM advisories, and shared pkg guards', () => {
  withTempDir('r59-r3-fees-', dir => {
    const candEcho = structuredClone(synthBatch.candidates[0]);
    candEcho.id = 'cand-sp-echo';
    candEcho.screening.reference_price_usd.value = 88.88;
    candEcho.economics.scenarios[0].cost_ledger.price_usd = 88.88;
    const spFeeOnly = [{
      Status: 'Success',
      FeesEstimateIdentifier: {
        MarketplaceId: 'ATVPDKIKX0DER',
        IdType: 'ASIN',
        IdValue: 'B0SYNECHO1',
        IsAmazonFulfilled: true,
        PriceToEstimateFees: { ListingPrice: { Amount: 88.88, CurrencyCode: 'USD' } },
      },
      FeesEstimate: {
        TotalFeesEstimate: { Amount: 18.33, CurrencyCode: 'USD' },
        FeeDetailList: [
          { FeeType: 'ReferralFee', FinalFee: { Amount: 13.33, CurrencyCode: 'USD' } },
          { FeeType: 'FBAFees', FinalFee: { Amount: 5.00, CurrencyCode: 'USD' } },
        ],
      },
    }];
    const echoFeePath = join(dir, 'sp-echo.json');
    const echoBytes = Buffer.from(JSON.stringify(spFeeOnly), 'utf8');
    writeFileSync(echoFeePath, echoBytes);
    assert.throws(
      () => ingestTrialSpecification(
        {
          profile_revision: 59,
          evidence: synthBatch.evidence,
          raw_receipt_files: ['sp-echo.json'],
          expected_raw_sha256s: { 'sp-echo.json': createHash('sha256').update(echoBytes).digest('hex') },
          candidates: [{ candidate: candEcho }],
        },
        r59Profile,
        { baseDir: dir },
      ),
      /price|provenance|88\.88/i,
      'SP-API fee-inquiry input price echo must never satisfy market selling-price provenance',
    );

    const pkgStd = { length_in: 12, width_in: 9, height_in: 3, weight_lb: 1.8 };
    const fbaCouponCross = lookupFulfillmentFee2027({
      pkg: pkgStd,
      price_usd: 45.90,
      list_price_usd: 51.00,
      ongoing_coupon_pct: 0.10,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
    });
    const fbaOver50 = lookupFulfillmentFee2027({
      pkg: pkgStd,
      price_usd: 51.00,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
    });
    assert.equal(fbaCouponCross.total_usd, fbaOver50.total_usd, 'List price $51 w/ 10% coupon ($45.90 net) pays >$50 FBA fulfillment tier');

    const candUnderFba = structuredClone(synthBatch.candidates[0]);
    const fbaUnder50 = lookupFulfillmentFee2027({
      pkg: pkgStd,
      price_usd: 45.90,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
    });
    const ledUnder = candUnderFba.economics.scenarios[0].cost_ledger;
    ledUnder.price_usd = 45.90;
    ledUnder.list_price_usd = 51.00;
    ledUnder.ongoing_coupon_pct = 0.10;
    ledUnder.fee_context = {
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'pkg-std',
      sales: { from: '2027-02-01', through: '2027-10-14' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-15', through: '2027-10-14' },
    };
    const fulLine = ledUnder.lines.find(l => l.id === 'fulfillment');
    fulLine.amount_usd = fbaUnder50.total_usd;
    fulLine.fee_basis = { pkg: pkgStd };
    const scoredUnderFba = scoreCandidate(candUnderFba, r59Profile);
    assert.equal(scoredUnderFba.qualification.counts_toward_target, false, 'Under-billed <$50 FBA tier on $51 list-price coupon must block qualification');

    const combLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    combLedger.price_usd = 45.00;
    combLedger.list_price_usd = 50.00;
    combLedger.ongoing_coupon_pct = 0.10;
    combLedger.lines.find(l => l.id === 'fulfillment').amount_usd = fbaOver50.total_usd;
    const combOther = combLedger.lines.find(l => l.id === 'other_applicable');
    combOther.amount_usd = 2.00;
    combOther.payee = 'external';
    const econCombined = calculateEconomics(combLedger, { profileRevision: 59 });
    const otherAfter = econCombined.lines.find(l => l.id === 'other_applicable');
    assert.ok(otherAfter.amazon_portion_usd > 1.1 && otherAfter.amazon_portion_usd < 1.3, 'Amazon coupon fee portion (~$1.175) recorded separately from external $2.00 other_applicable');

    const g1aUnverifiedOpt = estimateGate1A2027({
      price_usd: 45,
      pkg: pkgStd,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      headhaul_usd: 2.5,
      collection_rate: 0.006,
      placement_split_option: 'amazon_optimized',
    });
    assert.equal(g1aUnverifiedOpt.status, 'sensitivity_only', 'Unverified amazon_optimized is sensitivity_only, never verified primary');
    const g1aVerifiedOpt = estimateGate1A2027({
      price_usd: 45,
      pkg: pkgStd,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      headhaul_usd: 2.5,
      collection_rate: 0.006,
      placement_split_option: 'amazon_optimized',
      identical_cartons_count: 5,
      multi_destination_headhaul_verified: true,
    });
    assert.equal(g1aVerifiedOpt.status, 'verified');
    assert.equal(g1aVerifiedOpt.components.placement.selected_usd, 0);

    const oversizeTier = classifySizeTier2027({ length_in: 62, width_in: 20, height_in: 12, weight_lb: 18 });
    assert.match(oversizeTier.size_tier, /oversize/i);

    const a4MissingCnt = computeHeadhaulWithA4Rules({
      actual_weight_kg_per_unit: 0.5,
      order_units: 100,
      carton_cm: [60, 50, 40],
      rate_cny_per_kg: 12,
      bond_cny_per_kg: 0,
    }, 7.2, 100, { isR59: true });
    assert.equal(a4MissingCnt.missing_surcharge_quote, true);
    assert.equal(a4MissingCnt.amount_usd, null);

    const spCalUnmatchedCent = extractSpApiFinalistCalibration({
      asin: 'B0SYNCENT1',
      price_usd: 90.01,
      feesEstimateRaw: [{
        Status: 'Success',
        FeesEstimateIdentifier: {
          MarketplaceId: 'ATVPDKIKX0DER',
          IdType: 'ASIN',
          IdValue: 'B0SYNCENT1',
          IsAmazonFulfilled: true,
          PriceToEstimateFees: { ListingPrice: { Amount: 90.02, CurrencyCode: 'USD' } },
        },
        FeesEstimate: {
          TotalFeesEstimate: { Amount: 18.5, CurrencyCode: 'USD' },
          FeeDetailList: [
            { FeeType: 'ReferralFee', FinalFee: { Amount: 13.5, CurrencyCode: 'USD' } },
            { FeeType: 'FBAFees', FinalFee: { Amount: 5.0, CurrencyCode: 'USD' } },
          ],
        },
      }],
    });
    assert.equal(spCalUnmatchedCent.fee_calibration_status, 'unmatched', '1-cent mismatch ($90.01 vs $90.02) must not cross-match');

    const childAdv = resolveTargetChildSalesObservation({
      asin: 'B0CHDADV01',
      variant_count: 3,
      leaf_bsr_rank: 205,
    });
    assert.equal(childAdv.tier, 'sub_50_active_starter');
    assert.equal(childAdv.high_leaf_rank_advisory, true, 'leafRank 205 emits non-blocking advisory');

    const lcmAdv = computeOrderPlan({
      sku_lines: [
        { sku_id: 'A', unit_price_cny: 10, qty_per_saleable_set: 1, moq: 100, pack_multiple: 17, first_order_promotion: false },
        { sku_id: 'B', unit_price_cny: 10, qty_per_saleable_set: 1, moq: 100, pack_multiple: 13, first_order_promotion: false },
      ],
      min_order_sets: 100,
      profileRevision: 59,
    });
    assert.equal(lcmAdv.lcm_step_sets, 221);
    assert.ok(lcmAdv.high_lcm_advisory, 'LCM 221 > 200 emits non-blocking high_lcm_advisory in r59');

    const baseWin = {
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    const refTerms = { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 };
    const smallStdPkg = { length_in: 10, width_in: 6, height_in: 2, unit_weight_lb: 1.2 };

    assert.equal(estimateGate1A2027({
      ...baseWin, pkg: smallStdPkg, profile_revision: 59, price_usd: 45, fx_cny_per_usd: 7.2,
      refund_fraction: 0.04, physical_return_fraction: 0.04, collection_rate: 0.006, headhaul_usd: 1.8,
      referral_terms: refTerms, fee_category: 'Home and Kitchen', placement_split_option: 'amazon_optimized', placement_usd: 0,
    }).status, 'sensitivity_only');
    assert.equal(estimateGate1A2027({
      ...baseWin, pkg: smallStdPkg, profile_revision: 59, price_usd: 45, fx_cny_per_usd: 7.2,
      refund_fraction: 0.04, physical_return_fraction: 0.04, collection_rate: 0.006, headhaul_usd: 1.8,
      referral_terms: refTerms, fee_category: 'Home and Kitchen', placement_split_option: 'amazon_optimized',
      steady_state_replenishment: false, carton_count: 5, multi_destination_headhaul_verified: true,
    }).status, 'sensitivity_only');
    const badFormalCand = structuredClone(synthBatch.candidates[0]);
    const badPlaceLine = badFormalCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'placement');
    badPlaceLine.amount_usd = 0;
    badPlaceLine.fee_basis.split_option = 'amazon_optimized';
    assert.equal(scoreCandidate(badFormalCand, r59Profile).qualification.counts_toward_target, false);

    const esNetUnderstated = evaluateEarlyScreen({
      ...baseWin, id: 'es-net-understated', profile_revision: 59, operating_period: 'off_peak', saleable_unit: '1 unit',
      fee_context: { package_ref: 'p1', sales: baseWin.sales_window, storage: baseWin.storage_window, inbound: baseWin.inbound_window },
      pkg: smallStdPkg, order_units: 100, goods_cny_per_unit: 100, domestic_freight_cny_total: 180, fx_cny_per_usd: 7.2,
      first_order_promotion: false, strong_date_dependency: false,
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99,
      headhaul: { usd_per_unit: 1.8, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04,
      return_threshold: 0.081, returns_processing_usd: 0, fee_category: 'Home and Kitchen', referral_terms: refTerms,
      fulfillment_usd: 5.37165, placement_usd: 0.50,
      storage: { cubic_feet_per_unit: 120 / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      collection_rate: 0.006, other_applicable_usd: 0,
    });
    assert.equal(esNetUnderstated.gate_status, 'pending');
    const capPlain = estimateGate1A2027({
      ...baseWin, pkg: { length_in: 18, width_in: 10, height_in: 2, weight_lb: 1.2 }, profile_revision: 59,
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, promo_basis_already_net: true,
      fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006, other_applicable_usd: 0,
    });
    const capPreInc = estimateGate1A2027({
      ...baseWin, pkg: { length_in: 18, width_in: 10, height_in: 2, weight_lb: 1.2 }, profile_revision: 59,
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, promo_basis_already_net: true,
      fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: refTerms, headhaul_usd: 1.8, collection_rate: 0.006,
      other_applicable_usd: 1.17475, other_payee: 'amazon', coupon_fee_already_in_other: true,
    });
    assert.equal(capPreInc.non_domestic_cost_a_usd, capPlain.non_domestic_cost_a_usd);

    const makeCrossPkgCand = ({ pkgLoc, plAmt, fulAmt }) => {
      const c = structuredClone(synthBatch.candidates[0]);
      c.screening.reference_price_usd.value = 44.99;
      const sc = structuredClone(c.economics.scenarios[0]);
      delete sc.margin;
      delete sc.contribution_usd;
      const l = sc.cost_ledger;
      Object.assign(l, {
        list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, refund_fraction: 0.04, physical_return_fraction: 0.04,
        fx_cny_per_usd: 7.2, fee_category: 'Home and Kitchen',
        fee_context: { ...l.fee_context, sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW, storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, inbound: FBA_2027_DEFAULT_INBOUND_WINDOW },
      });
      for (const ln of l.lines) {
        if (ln.fee_basis) { ln.fee_basis.effective_from = '2027-01-15'; ln.fee_basis.effective_through = '2028-01-14'; }
      }
      l.lines.find(x => x.id === 'procurement').amount_usd = 100 / 7.2;
      l.lines.find(x => x.id === 'headhaul').amount_usd = 1.8;
      l.lines.find(x => x.id === 'referral').amount_usd = 44.99 * 0.15;
      l.lines.find(x => x.id === 'fulfillment').amount_usd = fulAmt;
      l.lines.find(x => x.id === 'placement').amount_usd = plAmt;
      const stLn = l.lines.find(x => x.id === 'storage');
      stLn.amount_usd = Number((((120 / 1728) * 0.78 * 45) / 30).toFixed(6));
      Object.assign(stLn.fee_basis, { effective_from: '2027-02-01', effective_through: '2027-09-30', cubic_feet_per_unit: 120 / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 });
      const retLn = l.lines.find(x => x.id === 'returns_processing');
      retLn.amount_usd = 0; retLn.return_threshold = 0.081; retLn.fee_basis.effective_from = '2027-02-01';
      const othLn = l.lines.find(x => x.id === 'other_applicable');
      othLn.amount_usd = Number((0.05 + 44.99 * 0.025).toFixed(6));
      othLn.fee_basis = { status: 'published', version: 'SYNTHETIC-2027-annual', marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', effective_from: '2027-01-15', effective_through: '2028-01-14', evidence: ['synthetic-evidence'] };
      const payout = 44.99 * 0.96 - (44.99 * 0.15 * 0.96 + 0.04 * Math.min(5, 44.99 * 0.15 * 0.2)) - (fulAmt + plAmt + stLn.amount_usd + othLn.amount_usd);
      l.lines.find(x => x.id === 'collection').amount_usd = Number((payout * 0.006).toFixed(6));
      l.lines.find(x => x.id === pkgLoc).fee_basis.pkg = { ...smallStdPkg };
      c.economics = buildPairedSeasonalOperatingPeriods({
        profile_revision: 59, saleable_unit: sc.saleable_unit, off_peak_scenarios: [sc],
        cubic_feet_per_unit: 120 / 1728, average_inventory_days: 45, size_tier: 'large_standard',
      });
      return scoreCandidate(c, r59Profile);
    };
    assert.equal(makeCrossPkgCand({ pkgLoc: 'fulfillment', plAmt: 0, fulAmt: 5.95125 }).qualification.counts_toward_target, false, 'Unverified $0 placement blocked even when pkg lives on fulfillment line');
    assert.equal(makeCrossPkgCand({ pkgLoc: 'placement', plAmt: 0.5, fulAmt: 5.37165 }).qualification.counts_toward_target, false, 'Post-coupon net FBA tier blocked even when pkg lives on placement line');

    const cSharedPkg = structuredClone(synthBatch.candidates[0]);
    cSharedPkg.screening.reference_price_usd.value = 44.99;
    const scSp = structuredClone(cSharedPkg.economics.scenarios[0]);
    delete scSp.margin;
    delete scSp.contribution_usd;
    const lSp = scSp.cost_ledger;
    Object.assign(lSp, {
      list_price_usd: 54.99, ongoing_coupon_usd: 10, price_usd: 44.99, refund_fraction: 0.04, physical_return_fraction: 0.04,
      fx_cny_per_usd: 7.2, fee_category: 'Home and Kitchen',
      fee_context: { ...lSp.fee_context, sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW, storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, inbound: FBA_2027_DEFAULT_INBOUND_WINDOW },
    });
    for (const ln of lSp.lines) if (ln.fee_basis) { ln.fee_basis.effective_from = '2027-01-15'; ln.fee_basis.effective_through = '2028-01-14'; }
    lSp.lines.find(x => x.id === 'procurement').amount_usd = 100 / 7.2;
    lSp.lines.find(x => x.id === 'headhaul').amount_usd = 1.8;
    lSp.lines.find(x => x.id === 'referral').amount_usd = 44.99 * 0.15;
    lSp.lines.find(x => x.id === 'fulfillment').amount_usd = 5.95125;
    lSp.lines.find(x => x.id === 'placement').amount_usd = 0;
    const stSp = lSp.lines.find(x => x.id === 'storage');
    stSp.amount_usd = Number((((120 / 1728) * 0.78 * 45) / 30).toFixed(6));
    Object.assign(stSp.fee_basis, { effective_from: '2027-02-01', effective_through: '2027-09-30', cubic_feet_per_unit: 120 / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 });
    const retSp = lSp.lines.find(x => x.id === 'returns_processing');
    retSp.amount_usd = 0; retSp.return_threshold = 0.081; retSp.fee_basis.effective_from = '2027-02-01';
    const othSp = lSp.lines.find(x => x.id === 'other_applicable');
    othSp.amount_usd = Number((0.05 + 44.99 * 0.025).toFixed(6));
    othSp.fee_basis = { status: 'published', version: 'SYNTHETIC-2027-annual', marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', effective_from: '2027-01-15', effective_through: '2028-01-14', evidence: ['synthetic-evidence'] };
    cSharedPkg.economics = {
      ...buildPairedSeasonalOperatingPeriods({ profile_revision: 59, saleable_unit: scSp.saleable_unit, off_peak_scenarios: [scSp], cubic_feet_per_unit: 120 / 1728, average_inventory_days: 45, size_tier: 'large_standard' }),
      packages: [{ id: 'synthetic-pack', ...smallStdPkg }],
    };
    assert.equal(scoreCandidate(cSharedPkg, r59Profile).qualification.counts_toward_target, false, 'Shared economics.packages registry blocks unverified $0 placement');
  });
});

test('Step 4 Sign-Off (#4, #5, R2-B, R3 fees): structured A4 headhaul in Gate 1A, missing headhaul/bond guards, and $0 placement proof across Gate 1A/economics/early-screen/profit-check', () => {
  const pkg = { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 };
  const base = {
    pkg, price_usd: 45.00, fx_cny_per_usd: 7.20, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 }, collection_rate: 0.006,
  };
  const estStruct = estimateGate1A2027({ ...base, order_units: 100, headhaul: { rate_cny_per_kg: 10.0, bond_cny_per_kg: 1.0, chargeable_kg_per_unit: 0.60 } });
  const estScalar = estimateGate1A2027({ ...base, headhaul_usd: 660 / 100 / 7.20, multi_destination_headhaul_verified: true });
  assert.equal(estStruct.status, 'verified');
  assert.equal(estStruct.components.placement.selected_usd, 0);
  assert.equal(estStruct.landed_domestic_cap_usd, estScalar.landed_domestic_cap_usd);
  assert.ok(Math.abs(estStruct.components.headhaul.amount_usd - 0.9166666667) < 1e-9);
  assert.equal(estimateGate1A2027(base).status, 'needs_calculator_verification');

  const baseOverride = {
    verified_by: 'sp_api_and_schedule', observed_at: '2026-11-24', evidence_ref: 'synth-override-ref', verified_price_band: '10_to_50',
    effective_from: '2027-02-01', effective_through: '2027-10-14', pkg, fulfillment_usd: 6.50, storage_per_unit_usd: 0.25, placement_usd: 0, returns_processing_usd: 0,
  };
  assert.equal(estimateGate1A2027({ ...base, headhaul_usd: 1.50, calculator_verified_override: baseOverride }).status, 'sensitivity_only');
  assert.equal(estimateGate1A2027({ ...base, headhaul_usd: 1.50, identical_cartons_count: 5, multi_destination_headhaul_verified: true, calculator_verified_override: baseOverride }).status, 'verified');
  const oversizePkg = { length_in: 62, width_in: 10, height_in: 6, unit_weight_lb: 35 };
  assert.equal(estimateGate1A2027({
    ...base, pkg: oversizePkg, price_usd: 199.99, headhaul_usd: 14.00,
    calculator_verified_override: { ...baseOverride, verified_price_band: 'over_50', size_tier: 'small_oversize', pkg: oversizePkg, fulfillment_usd: 45.00, storage_per_unit_usd: 4.00, placement_usd: 0 },
  }).status, 'verified');

  const stdPkg = { id: 'synthetic-pack', length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 };
  const scZero = structuredClone(synthBatch.candidates[0]).economics.scenarios[0];
  scZero.cost_ledger.packages = [stdPkg];
  const placeComp = scZero.cost_ledger.lines.find(c => c.id === 'placement');
  placeComp.amount_usd = 0;
  placeComp.fee_basis = { ...(placeComp.fee_basis ?? {}), calculator_verified: true, sp_api_calibrated: true };
  assert.equal(calculateEconomics(scZero.cost_ledger, { profileRevision: 59, externalPackages: [stdPkg] }).status, 'pending_costs');

  const earlyBase = {
    profile_revision: 59, id: 'es-zero-place', saleable_unit: '1 set', price_usd: 45.00, fx_cny_per_usd: 7.20,
    pkg: stdPkg, goods_cny_per_unit: 40, domestic_freight_cny_per_unit: 2, headhaul: { usd_per_unit: 1.50, bond_included: true },
    refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.08, returns_processing_usd: 0, is_apparel_or_shoes: false,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
    fulfillment_usd: 5.50, placement_usd: 0, placement_fee_basis: { calculator_verified: true, sp_api_calibrated: true },
    storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
    collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
  };
  assert.equal(evaluateEarlyScreen(earlyBase, { profileRevision: 59 }).gate_status, 'pending');

  const pkgLessLedger = structuredClone(synthBatch.candidates[0]).economics.scenarios[0].cost_ledger;
  delete pkgLessLedger.packages;
  const plLine = pkgLessLedger.lines.find(l => l.id === 'placement');
  plLine.amount_usd = 0;
  plLine.fee_basis = { size_tier: 'large_standard', calculator_verified: true };
  assert.equal(calculateEconomics(pkgLessLedger, { profileRevision: 59 }).status, 'pending_costs');
  assert.equal(evaluateEarlyScreen({ ...earlyBase, id: 'es-pkgless-std', pkg: undefined, placement_fee_basis: { size_tier: 'large_standard', calculator_verified: true } }, { profileRevision: 59 }).gate_status, 'pending');

  const hcBareGoods = runFastProfitHealthcheck2027({
    pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, price_usd: 45.00, fx_cny_per_usd: 7.20, order_units: 100, goods_cny_total: 10480, headhaul_usd: 1.50,
  });
  assert.equal(hcBareGoods.cost_basis, 'bare_goods_1688');
  assert.match(hcBareGoods.bare_goods_disclosure, /当前按 1688 裸货价算/);
  assert.equal(hcBareGoods.realized_2027_off_peak.status, 'verified');
  assert.ok(Number.isFinite(hcBareGoods.realized_2027_off_peak.margin));

  const hcScalarA4 = runFastProfitHealthcheck2027({
    pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, price_usd: 45.00, fx_cny_per_usd: 7.20,
    order_units: 100, goods_cny_total: 6000, domestic_freight_cny_total: 280, headhaul_usd: 660 / 100 / 7.20, multi_destination_headhaul_verified: true,
  });
  const hcStructA4 = runFastProfitHealthcheck2027({
    pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, price_usd: 45.00, fx_cny_per_usd: 7.20,
    order_units: 100, goods_cny_total: 6000, domestic_freight_cny_total: 280, headhaul: { rate_cny_per_kg: 10, bond_cny_per_kg: 1, chargeable_kg_per_unit: 0.60 },
  });
  assert.equal(hcStructA4.realized_2027_off_peak.status, 'verified');
  assert.equal(hcStructA4.realized_2027_off_peak.margin, hcScalarA4.realized_2027_off_peak.margin);

  const hcNoBond = runFastProfitHealthcheck2027({
    pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, price_usd: 45.00, fx_cny_per_usd: 7.20,
    goods_cny_total: 6000, domestic_freight_cny_total: 200, headhaul: { usd_per_unit: 1.50, bond_included: false },
  });
  assert.equal(hcNoBond.realized_2027_off_peak.margin, null, 'Missing carrier bond when bond_included=false must not be treated as $0');
});

test('2027 off-peak sales (2027-02-01..2027-10-14) vs storage (2027-02-01..2027-09-30), Q4 peak blank note, and 2026 peak extrapolation ban', () => {
  assert.deepEqual(FBA_2027_DEFAULT_OFF_PEAK_WINDOW, { from: '2027-02-01', through: '2027-10-14' });
  assert.deepEqual(FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, { from: '2027-02-01', through: '2027-09-30' });
  assert.deepEqual(FBA_2027_COMPANION_PEAK_STORAGE_WINDOW, { from: '2027-10-01', through: '2027-12-31' });
  assert.deepEqual(FBA_2027_UNPUBLISHED_PEAK_WINDOW, { from: '2027-10-15', through: '2028-01-14' });
  assert.equal(UNPUBLISHED_2027_PEAK_MARGIN_NOTE, '待亚马逊公布 2027 旺季费率后补充');

  const baseCand = structuredClone(synthBatch.candidates[0]);
  baseCand.id = 'cand-seasonal-2027-win';
  const pkgRef = baseCand.economics.scenarios[0].cost_ledger.fee_context.package_ref;
  const scOff = structuredClone(baseCand.economics.scenarios[0]);
  scOff.id = scOff.cost_ledger.id = 'sc-offpeak-win';
  scOff.cost_ledger.fee_context = {
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  for (const line of scOff.cost_ledger.lines) {
    if (line.fee_basis && typeof line.fee_basis === 'object') {
      if (line.id === 'fulfillment' || line.id === 'inbound_placement') {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-10-14';
      } else if (line.id === 'storage') {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-09-30';
      } else if (line.id === 'returns_processing') {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-12-31';
      }
    }
  }

  const paired = buildPairedSeasonalOperatingPeriods({
    saleable_unit: baseCand.economics.saleable_unit,
    off_peak_scenarios: [scOff],
    cubic_feet_per_unit: 0.25,
    storage_evidence: [baseCand.evidence[0].id],
  });
  const periods = paired.operating_periods;
  assert.equal(periods.length, 2);
  assert.deepEqual(periods[0].months, [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(periods[1].months, [10, 11, 12, 1]);

  delete baseCand.economics.scenarios;
  delete baseCand.economics.expected_primary_scenarios;
  baseCand.economics.operating_periods = periods;

  const scored = scoreCandidate(baseCand, r59Profile);
  assert.equal(scored.qualification.counts_toward_target, true, JSON.stringify(scored.qualification));
  assert.equal(scored.qualification.mode, 'seasonal_eligible');
  assert.equal(scored.effective_disposition, 'seasonal_off_peak_qualifying');
  const peakPeriod = scored.operating_periods.find(p => p.id === 'peak');
  assert.equal(scored.qualification.unpublished_peak_note, UNPUBLISHED_2027_PEAK_MARGIN_NOTE);
  assert.equal(peakPeriod.total_range, null);

  const badCand = structuredClone(baseCand);
  const badPeakFul = badCand.economics.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment');
  badPeakFul.status = 'supported';
  badPeakFul.amount_usd = 7.45;
  badPeakFul.fee_basis = {
    status: 'published',
    version: 'estimated-from-2026-peak-uplift',
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    effective_from: '2027-10-15',
    effective_through: '2028-01-14',
  };
  const badScored = scoreCandidate(badCand, r59Profile);
  assert.equal(badScored.qualification.counts_toward_target, false);
  assert.ok(badScored.qualification.reasons.some(r => /2026|peak/i.test(r)));
});

test('2027 Bulky non-SIPP, 6-tier Oversize + Flat/Overhang, Apparel vs Shoes, DG, Low-Price ineligibles, and out-of-table directive', () => {
  const bulkyPkg = { length_in: 20.0, width_in: 12.0, height_in: 6.0, unit_weight_lb: 4.0 };
  const defaultBulky = lookupBulkyFulfillmentFee2027({
    pkg: bulkyPkg,
    price_usd: 59.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(defaultBulky.status, 'verified');
  assert.equal(defaultBulky.size_tier, 'small_bulky');
  assert.ok(defaultBulky.packaging_service_fee_usd >= 1.51);
  assert.equal(
    Number((defaultBulky.fulfillment_with_fuel_usd + defaultBulky.packaging_service_fee_usd).toFixed(10)),
    defaultBulky.total_usd,
  );

  const sippBulky = lookupBulkyFulfillmentFee2027({
    pkg: bulkyPkg,
    price_usd: 59.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
    is_sipp: true,
  });
  assert.equal(sippBulky.packaging_service_fee_usd, 0);
  assert.equal(sippBulky.total_usd, defaultBulky.fulfillment_with_fuel_usd);

  const flatOversizePkg = { length_in: 62.0, width_in: 28.0, height_in: 3.0, unit_weight_lb: 20.0 };
  const flatFul = lookupOversizeFulfillmentFee2027({
    pkg: flatOversizePkg,
    price_usd: 129.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(flatFul.status, 'verified');
  assert.equal(flatFul.size_tier, 'small_oversize');
  assert.equal(flatFul.flat_product_handling_fee_usd, 8.40);
  const overhangCheck = lookupOversizeHandlingFees2027(
    { length_in: 98.0, width_in: 44.0, height_in: 4.5, unit_weight_lb: 40.0 },
  );
  assert.equal(overhangCheck.status, 'verified');
  assert.ok(overhangCheck.overhang_handling_fee_usd > 0);

  const osPlc = lookupUnifiedPlacementFee2027({ pkg: flatOversizePkg });
  assert.equal(osPlc.status, 'verified');
  assert.equal(osPlc.selected_usd, 0);

  const osRet = lookupUnifiedReturnsProcessing2027({
    pkg: flatOversizePkg,
    physical_return_fraction: 0.12,
    fee_category: 'Home and Kitchen',
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(osRet.status, 'verified');
  assert.ok((osRet.per_return_fee_usd ?? osRet.rate_per_excess_return_usd) > 26.33);

  const heavyCls = classifySizeTier2027({ length_in: 80, width_in: 30, height_in: 20, unit_weight_lb: 160 });
  assert.equal(heavyCls.size_tier, 'special_oversize_heavy');

  const stdGarment = { length_in: 12, width_in: 9, height_in: 2, unit_weight_lb: 0.9 };
  const appFul = lookupApparelFulfillmentFee2027({
    pkg: stdGarment,
    price_usd: 34.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  const shoeFul = lookupUnifiedFulfillmentFee2027({
    pkg: stdGarment,
    price_usd: 34.99,
    is_shoes: true,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(appFul.status, 'verified');
  assert.equal(shoeFul.status, 'verified');
  assert.ok(appFul.total_usd > shoeFul.total_usd, 'Apparel fulfillment exceeds Shoes (which uses Non-Apparel fulfillment)');
  const shoeRet = lookupUnifiedReturnsProcessing2027({
    pkg: stdGarment,
    physical_return_fraction: 0.08,
    is_shoes: true,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(shoeRet.excess_return_fraction, 0.08, 'Shoes still pay per-return Apparel & Shoes processing fee on every returned unit');
  assert.ok((shoeRet.expected_fee_per_shipped_unit_usd ?? shoeRet.expected_per_sold_unit_usd) > 0);

  const dgFul = lookupDangerousGoodsFulfillmentFee2027({
    pkg: stdGarment,
    price_usd: 34.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(dgFul.status, 'verified');
  const dgStoOff = lookupDangerousGoodsStorageFee2027({
    pkg: stdGarment,
    storage_window: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  });
  const dgStoPeak = lookupDangerousGoodsStorageFee2027({
    pkg: bulkyPkg,
    storage_window: FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  });
  assert.equal(dgStoOff.rate_usd_per_cuft_month, 0.99);
  assert.equal(dgStoPeak.rate_usd_per_cuft_month, 2.43);

  assert.equal(isCategoryLowPriceEligible2027('Computers'), false);
  assert.equal(isCategoryLowPriceEligible2027('Automotive and Powersports'), false);
  assert.equal(isCategoryLowPriceEligible2027('Home and Kitchen'), true);
  const compUnder10 = lookupUnifiedFulfillmentFee2027({
    pkg: { length_in: 10, width_in: 6, height_in: 1, unit_weight_lb: 0.4 },
    price_usd: 8.99,
    fee_category: 'Computers',
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(compUnder10.price_band, '10_to_50');

  const directive = buildOutOfTableLookupDirective({
    fee_category: 'Fine Collectible Watches',
    reason: 'Tiered referral schedule not yet cached locally.',
  });
  assert.equal(directive.protocol_id, 'spapi_then_official_seller_central_persist_v1');
  assert.equal(directive.required_steps.length, 3);
});

test('Minor package borderline anti-false-kill: peer median anchor and <=10mm packaging_redesign_shortlist rescue vs >10mm rejection', () => {
  const peerAnchor = computeMatchedPeerMedianPackage(
    [
      { asin: 'B0SYNPEER1', length_in: 17.4, width_in: 11.2, height_in: 7.6, unit_weight_lb: 3.8, is_sp_api_official: true },
      { asin: 'B0SYNPEER2', length_in: 17.6, width_in: 11.4, height_in: 7.7, unit_weight_lb: 3.9, is_sp_api_official: true },
    ],
    {
      supplier_nominal_pkg: { length_in: 18.2, width_in: 11.5, height_in: 7.8, unit_weight_lb: 4.0 },
    },
  );
  assert.equal(peerAnchor.median_size_tier, 'large_standard');
  assert.equal(peerAnchor.supplier_cliff_crossed, true);
  assert.match(peerAnchor.sample_warning_tag, /拿样必测彩盒压线预警/);

  const stdRefTerms = {
    referral_fraction: 0.15,
    refund_admin_fraction: 0.20,
    refund_admin_cap_usd: 5.00,
    minimum_referral_usd: 0.30,
  };
  const rescuePass = computePackagingRedesignShortlist2027({
    pkg: { id: 'pkg-borderline-7mm', length_in: 16.5, width_in: 12.0, height_in: 8.30, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 62.0,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
    collection_rate: 0.006,
  });
  assert.equal(rescuePass.eligible, true, rescuePass.reason);
  assert.ok(rescuePass.original_margin < 0.30);
  assert.ok(rescuePass.redesigned_margin >= 0.30);
  assert.ok(rescuePass.overshoot_mm > 0 && rescuePass.overshoot_mm <= 10);
  assert.equal(rescuePass.original_size_tier, 'small_bulky');
  assert.equal(rescuePass.target_size_tier, 'large_standard');

  const rescueTooWide = computePackagingRedesignShortlist2027({
    pkg: { id: 'pkg-over-10mm', length_in: 16.5, width_in: 12.0, height_in: 8.50, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 62.0,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
    collection_rate: 0.006,
  });
  assert.equal(rescueTooWide.eligible, false);

  const missingCollection = computePackagingRedesignShortlist2027({
    pkg: { length_in: 16.5, width_in: 12.0, height_in: 8.30, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 62.0,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
  });
  assert.equal(missingCollection.eligible, false);
  assert.match(missingCollection.reason, /collection_rate/);

  const missingFx = computePackagingRedesignShortlist2027({
    pkg: { length_in: 16.5, width_in: 12.0, height_in: 8.30, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 158.0,
    refund_fraction: 0.04,
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
  });
  assert.equal(missingFx.eligible, false);
  assert.match(missingFx.reason, /fx_cny_per_usd/);
});

test('Coupon list-price FBA tier + $5+2.5% fee parity across Gate 1A/early-screen/economics/seasonal and Freight A4 + size-tier audits', () => {
  const couponEst = estimateGate1A2027({
    profile_revision: 59,
    list_price_usd: 54.99,
    ongoing_coupon_usd: 10.00,
    pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    headhaul_usd: 2.2,
    collection_rate: 0.006,
  });
  assert.equal(couponEst.status, 'verified');
  assert.equal(couponEst.price_usd, 44.99);
  assert.equal(couponEst.price_band, 'over_50', '$54.99 list price stays on over_50 FBA tier even when coupon lowers net to $44.99');
  assert.ok(couponEst.components.coupon_fee.per_unit_usd > 1.15, '$5/100 ($0.05) + 2.5% * $44.99 ($1.1248) = ~$1.1748/unit coupon fee');

  const a4Spec = {
    actual_weight_kg_per_unit: 0.06,
    min_shipment_billable_kg: 10,
    small_shipment_threshold_kg: 50,
    small_shipment_surcharge_cny_per_kg: 10,
    weight_per_carton_kg: 6,
    carton_count: 1,
    small_carton_surcharge_cny_per_carton: 20,
    rate_cny_per_kg: 12,
    surcharge_cny_per_kg: 1,
    bond_cny_per_shipment: 150,
  };
  const esA4 = evaluateEarlyScreen({
    saleable_unit: '1 light acrylic rack',
    price_usd: 49.99,
    fx_cny_per_usd: 7.2,
    order_units: 100,
    goods_cny_per_unit: 45,
    domestic_freight_cny_total: 150,
    first_order_promotion: false,
    headhaul: a4Spec,
    refund_fraction: 0.04,
    return_threshold: 0.081,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    fulfillment_usd: 5.50,
    placement_usd: 0.40,
    storage: { cubic_feet_per_unit: 0.1, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
  });
  const hhLineA4 = esA4.ledger.lines.find(l => l.id === 'headhaul');
  assert.ok(Math.abs(hhLineA4.amount_usd - (4.00 / 7.2)) < 1e-4, `Expected A4 headhaul $0.5556, got ${hhLineA4.amount_usd}`);

  const econLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
  econLedger.fx_cny_per_usd = 7.2;
  const econHh = econLedger.lines.find(l => l.id === 'headhaul');
  econHh.amount_usd = 0.56;
  econHh.cny_derivation = { fx: 7.2, order_units: 100, ...a4Spec };
  const econOut = calculateEconomics(econLedger, { profileRevision: 59 });
  assert.ok(Math.abs(econOut.lines.find(l => l.id === 'headhaul').amount_usd - (4.00 / 7.2)) < 1e-6);

  const esCoupon = evaluateEarlyScreen({
    profile_revision: 59,
    operating_period: 'off_peak',
    fee_context: {
      package_ref: 'synth-pack',
      sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
      storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
      inbound: { from: '2027-01-15', through: '2027-02-01' },
    },
    saleable_unit: '1 synthetic organizer',
    list_price_usd: 54.99,
    ongoing_coupon_usd: 10.00,
    fx_cny_per_usd: 7.20,
    order_units: 100,
    goods_cny_per_unit: 118.00,
    bare_goods_screening: false,
    domestic_freight_cny_total: 180,
    first_order_promotion: false,
    headhaul: { chargeable_kg_per_unit: 0.68, rate_cny_per_kg: 12, bond_cny_per_shipment: 150 },
    refund_fraction: 0.04,
    return_threshold: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
    fulfillment_usd: 5.83,
    placement_usd: 0.68,
    storage: { cubic_feet_per_unit: 0.1667, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
  });
  assert.equal(esCoupon.checks.margin, 'fail', JSON.stringify(esCoupon.reasons));
  assert.ok(esCoupon.metrics.margin < 0.30, `After deducting $1.1748 coupon fee, margin (${esCoupon.metrics.margin}) must fall < 30%`);

  const st3CouponLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
  st3CouponLedger.list_price_usd = 54.99;
  st3CouponLedger.ongoing_coupon_usd = 10.00;
  st3CouponLedger.price_usd = 44.99;
  st3CouponLedger.refund_fraction = 0.04;
  st3CouponLedger.lines.find(l => l.id === 'procurement').amount_usd = Number((118 / 7.2).toFixed(6));
  st3CouponLedger.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((1.8 / 7.2).toFixed(6));
  st3CouponLedger.lines.find(l => l.id === 'headhaul').amount_usd = Number(((0.68 * 12 + 1.50) / 7.2).toFixed(6));
  st3CouponLedger.lines.find(l => l.id === 'referral').amount_usd = Number((44.99 * 0.15).toFixed(6));
  st3CouponLedger.lines.find(l => l.id === 'fulfillment').amount_usd = 5.83;
  st3CouponLedger.lines.find(l => l.id === 'fulfillment').fee_basis.price_band = 'over_50';
  st3CouponLedger.lines.find(l => l.id === 'placement').amount_usd = 0.68;
  st3CouponLedger.lines.find(l => l.id === 'storage').amount_usd = Number((0.1667 * 0.78 * 1.5).toFixed(6));
  st3CouponLedger.lines.find(l => l.id === 'storage').fee_basis = {
    ...st3CouponLedger.lines.find(l => l.id === 'storage').fee_basis,
    cubic_feet_per_unit: 0.1667,
    rate_usd_per_cuft_month: 0.78,
    average_inventory_days: 45,
    effective_from: '2027-02-01',
    effective_through: '2027-09-30',
  };
  st3CouponLedger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
  st3CouponLedger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  for (const ln of st3CouponLedger.lines) {
    if (ln.fee_basis && ln.id !== 'storage') {
      ln.fee_basis.effective_from = '2027-01-15';
      ln.fee_basis.effective_through = '2027-10-14';
    }
  }
  st3CouponLedger.lines.find(l => l.id === 'returns_processing').fee_basis.effective_from = '2027-02-01';
  st3CouponLedger.lines.find(l => l.id === 'returns_processing').per_return_fee_usd = 3.26;
  const st3CouponCalc = calculateEconomics(st3CouponLedger, {
    requireFeeBasis: true,
    profileRevision: 59,
    evidenceIds: ['synthetic-evidence'],
  });
  assert.equal(st3CouponCalc.scoring_supported, true, JSON.stringify(st3CouponCalc.fee_validation?.issues));
  assert.ok(Math.abs(st3CouponCalc.margin - esCoupon.metrics.margin) < 1e-4, 'Gate 1B and Stage 3 coupon margins match within 0.01pp');

  const esMissingA4 = evaluateEarlyScreen({
    profile_revision: 59,
    operating_period: 'off_peak',
    fee_context: {
      package_ref: 'synth-pack',
      sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
      storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
      inbound: { from: '2027-01-15', through: '2027-02-01' },
    },
    saleable_unit: '1 light stand',
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    order_units: 100,
    goods_cny_per_unit: 40,
    domestic_freight_cny_total: 120,
    first_order_promotion: false,
    headhaul: { actual_weight_kg_per_unit: 0.25, rate_cny_per_kg: 12, bond_cny_per_shipment: 150, steady_state_replenishment: false },
    refund_fraction: 0.04,
    return_threshold: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
    fulfillment_usd: 4.50,
    placement_usd: 0.40,
    storage: { cubic_feet_per_unit: 0.1, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
  });
  assert.equal(esMissingA4.checks.margin, 'pending', '<50kg shipment without small_shipment_surcharge_cny_per_kg stays pending');

  const baseOffSc = structuredClone(synthBatch.candidates[0].economics.scenarios[0]);
  baseOffSc.cost_ledger.lines.find(l => l.id === 'storage').fee_basis = {
    status: 'published',
    version: 'US-FBA-2027-v1',
    marketplace: 'US',
    currency: 'USD',
    package_ref: 'synthetic-pack',
    effective_from: '2027-02-01',
    effective_through: '2027-06-30',
    rate_usd_per_cuft_month: 0.78,
    cubic_feet_per_unit: 0.2,
    average_inventory_days: 45,
    evidence: ['synthetic-evidence'],
  };
  const pairedH14 = buildPairedSeasonalOperatingPeriods({
    profile_revision: 59,
    saleable_unit: baseOffSc.saleable_unit,
    off_peak_scenarios: [baseOffSc],
    cubic_feet_per_unit: 0.2,
    average_inventory_days: 45,
    size_tier: 'large_standard',
  });
  const offStorBasis = pairedH14.operating_periods[0].scenarios[0].cost_ledger.lines.find(l => l.id === 'storage').fee_basis;
  const peakStorBasis = pairedH14.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'storage').fee_basis;
  assert.equal(offStorBasis.effective_through, '2027-06-30', 'Partial 2027-06-30 storage window is NOT fabricated upward to 2027-09-30');
  assert.equal(peakStorBasis.rate_usd_per_cuft_month, 2.40, 'Companion peak storage fee_basis rate is updated to $2.40');

  const specOverPkg = { length_in: 110, width_in: 10, height_in: 8, unit_weight_lb: 40 };
  assert.equal(classifySizeTier2027(specOverPkg).size_tier, 'special_oversize_light');
  assert.equal(lookupUnifiedPlacementFee2027({ pkg: specOverPkg }).selected_usd, 0, 'special_oversize_light exempt ($0.00) from placement');
  assert.equal(lookupUnifiedReturnsProcessing2027({ pkg: specOverPkg, physical_return_fraction: 0.08, fee_category: 'Home and Kitchen' }).status, 'verified');

  assert.throws(
    () => getFba2027RateTableSnapshot({ profileRevision: 58 }),
    /retired|59/i,
    'pre-r59 rate snapshots retired in active runtime',
  );
  assert.equal(getFba2027RateTableSnapshot({ profileRevision: 59 }).metadata.default_off_peak_window.through, '2027-10-14');
  assert.equal(Array.isArray(getFba2027RateTableSnapshot({ profileRevision: 59 }).oversize_2027_tiers), true);

  const stdPkg = { length_in: 14, width_in: 10, height_in: 3, unit_weight_lb: 1.4 };
  const netBandCand = structuredClone(synthBatch.candidates[0]);
  const netSc = netBandCand.economics.scenarios[0];
  const pkgIdRef = netSc.cost_ledger.fee_context.package_ref;
  netSc.cost_ledger.packages = [{ id: pkgIdRef, ...stdPkg }];
  netSc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-10-14' };
  netSc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  netSc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
  netSc.cost_ledger.list_price_usd = 54.99;
  netSc.cost_ledger.ongoing_coupon_usd = 10.00;
  netSc.cost_ledger.price_usd = 44.99;
  netSc.cost_ledger.promo_basis_already_net = true;
  const fulLineWrong = netSc.cost_ledger.lines.find(l => l.id === 'fulfillment');
  fulLineWrong.amount_usd = 4.16;
  fulLineWrong.fee_basis.effective_from = '2027-01-15';
  fulLineWrong.fee_basis.effective_through = '2027-10-14';
  const scoredWrongFul = scoreCandidate(netBandCand, r59Profile);
  assert.equal(scoredWrongFul.qualification.counts_toward_target, false, 'Formal scoring blocks understated net-band fulfillment fee');

  const missingCartonCntEv = evaluateEarlyScreen({
    profile_revision: 59, id: 'sc-a4-nocarton', saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
    procurement: { cny_per_unit: 40, order_units: 100, first_order_promotion: false },
    domestic_freight: { cny_per_shipment: 150, order_units: 100, first_order_promotion: false },
    headhaul: { chargeable_kg_per_unit: 0.15, rate_cny_per_kg: 5, bond_cny_per_kg: 0, order_units: 100, weight_per_carton_kg: 5, small_shipment_surcharge_cny_per_kg: 0, small_carton_surcharge_cny_per_carton: 10 },
    refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 4.50, placement_usd: 0.40,
    storage: { cubic_feet_per_unit: 0.2, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
    collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
  }, { profileRevision: 59 });
  assert.equal(missingCartonCntEv.ledger.margin, null, 'Missing carton_count on per-carton surcharge holds headhaul pending');

  const seasCand = structuredClone(synthBatch.candidates[0]);
  const pkgRefId = seasCand.economics.scenarios[0].cost_ledger.fee_context.package_ref;
  const baseOffSc2 = structuredClone(seasCand.economics.scenarios[0]);
  delete baseOffSc2.cost_ledger.packages;
  baseOffSc2.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-10-14' };
  baseOffSc2.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  baseOffSc2.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
  baseOffSc2.cost_ledger.list_price_usd = 54.99;
  baseOffSc2.cost_ledger.ongoing_coupon_usd = 10.00;
  baseOffSc2.cost_ledger.price_usd = 44.99;
  baseOffSc2.cost_ledger.promo_basis_already_net = true;
  const wrongSeasFul = baseOffSc2.cost_ledger.lines.find(l => l.id === 'fulfillment');
  wrongSeasFul.amount_usd = 4.16;
  wrongSeasFul.fee_basis.effective_from = '2027-01-15';
  wrongSeasFul.fee_basis.effective_through = '2027-10-14';
  const builtPeriods = buildPairedSeasonalOperatingPeriods({
    saleable_unit: seasCand.economics.saleable_unit,
    off_peak_scenarios: [baseOffSc2],
    cubic_feet_per_unit: (14 * 10 * 3) / 1728,
    profile_revision: 59,
  });
  seasCand.economics = {
    ...builtPeriods,
    packages: [{ id: pkgRefId, ...stdPkg }],
  };
  const scoredSeasWrong = scoreCandidate(seasCand, r59Profile);
  assert.equal(scoredSeasWrong.qualification.counts_toward_target, false, 'Seasonal candidate with economics.packages rejects understated net-band coupon FBA fee');
  assert.equal(builtPeriods.operating_periods[0].months.includes(10), false, 'Paired off_peak months remain [2..9] without falsely claiming full-October storage coverage');

  const volMissingCntEv = evaluateEarlyScreen({
    profile_revision: 59, id: 'sc-vol-nocnt', saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
    procurement: { cny_per_unit: 40, order_units: 100, first_order_promotion: false },
    domestic_freight: { cny_per_shipment: 150, order_units: 100, first_order_promotion: false },
    headhaul: { actual_weight_kg_per_unit: 0.5, chargeable_kg_per_unit: 0.5, carton_cm: { length_cm: 60, width_cm: 50, height_cm: 40 }, rate_cny_per_kg: 12, bond_cny_per_kg: 0, order_units: 100 },
    refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 4.50, placement_usd: 0.40,
    storage: { cubic_feet_per_unit: 0.2, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
    collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
  }, { profileRevision: 59 });
  assert.equal(volMissingCntEv.ledger.margin, null, 'Volumetric carton_cm without carton_count holds headhaul pending instead of silently assuming 100 cartons');
});
