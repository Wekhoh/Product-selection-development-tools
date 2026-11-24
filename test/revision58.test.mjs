import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  scoreBatch,
  scoreCandidate,
  evalGreedyFRat,
  computeStratifiedBoundsRat,
  selectStratifiedNewcomers,
} from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { calculateEconomics, ledgerMeetsMarginFloor } from '../src/economics.mjs';
import { validateFeeBasis, lookupVerified2027PerReturnFee } from '../src/fee-basis.mjs';
import { evaluateEarlyScreen } from '../src/early-screen.mjs';
import { prepareDiscovery, attachDiscovery } from '../src/discovery.mjs';
import {
  classifyStandardSize2027,
  lookupFulfillmentFee2027,
  lookupStorageFee2027,
  lookupPlacementFee2027,
  lookupReturnsProcessing2027,
  estimateGate1A2027,
  evaluatePriceCliff2027,
  computeNegotiationShortlist,
  computeOrderPlan,
} from '../src/fba-rates-2027.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

function makeSeasonalCandidate(id, { offPeakFrom = '2027-02-01', offPeakThrough = '2027-09-30', includePeak = true, reversePeriods = false } = {}) {
  const c = structuredClone(fixture.candidates[0]);
  c.id = id;
  c.label = `合成季节款 ${id}`;
  const off = structuredClone(c.economics.scenarios[0]);
  off.id = off.cost_ledger.id = 'sc-regular';
  off.cost_ledger.fee_context.sales = { from: offPeakFrom, through: offPeakThrough };
  off.cost_ledger.fee_context.storage = { from: offPeakFrom, through: offPeakThrough };
  off.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-01-15' };
  for (const l of off.cost_ledger.lines.filter(x => x.fee_basis)) {
    l.fee_basis.effective_from = '2027-01-15';
    l.fee_basis.effective_through = l.id === 'fulfillment' ? '2027-10-14' : '2027-12-31';
  }
  const peak = structuredClone(off);
  peak.id = peak.cost_ledger.id = 'sc-peak';
  peak.cost_ledger.fee_context.sales = peak.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
  Object.assign(peak.cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null, status: 'pending', fee_basis: { status: 'unavailable', version: 'Unpublished 2027 peak fulfillment' },
  });
  const offPeriod = { id: 'off_peak', label: '2027年2–9月淡季', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [off] };
  const peakPeriod = { id: 'peak', label: '2027年10–12月旺季', months: [10, 11, 12], scenarios: [peak] };
  c.economics = {
    saleable_unit: c.economics.saleable_unit,
    operating_periods: includePeak ? (reversePeriods ? [peakPeriod, offPeriod] : [offPeriod, peakPeriod]) : [offPeriod],
  };
  return c;
}

const rat = (n, d = 1n) => ({ n: BigInt(n), d: BigInt(d) });
const ratToFloat = r => Number(r.n) / Number(r.d);
const obs = (value, unit) => ({ value, unit, evidence: ['synthetic-evidence'] });

function makeNewcomerMember(id, { ratings = 5, units = 100, launch = '2026-10-01', share = 0.7, status = 'qualified', comparability_verdict = 'comparable', ...rest } = {}) {
  return {
    family_id: id,
    asin: `${id}-asin`,
    status,
    ...(comparability_verdict !== undefined ? { comparability_verdict } : {}),
    reason: 'Synthetic normal launch newcomer.',
    evidence: ['synthetic-evidence'],
    launch_date: launch,
    current_bsr_node: 'synthetic-node',
    current_bsr_rank: 20,
    ratings: obs(ratings, 'count'),
    units_30d: obs(units, 'units'),
    natural: share === undefined ? undefined : {
      ...obs(share, 'fraction'),
      provider: 'sif',
      scope: 'overall',
      period: '2026-10-15/2026-11-13',
      relevant_entries_evidence: ['synthetic-evidence'],
    },
    ...rest,
  };
}

test('revision 58 Router 4-state expected_primary_scenarios prevents dropped-scenario false passes', () => {
  assert.equal(profile.revision, 58);

  // State 1: original active scenario passes -> seasonal_eligible
  const c1 = makeSeasonalCandidate('router-4state');
  c1.economics.operating_periods[0].expected_primary_scenarios = [
    { id: 'sc-regular', status: 'active' },
  ];
  const r1 = scoreCandidate(c1, profile);
  assert.equal(r1.qualification.counts_toward_target, true);
  assert.equal(r1.qualification.mode, 'seasonal_eligible');

  // State 2: adding carton scenario with narrow 2027-02-02 start -> pending (counts_toward_target false)
  const c2 = makeSeasonalCandidate('router-4state');
  const carton = structuredClone(c2.economics.operating_periods[0].scenarios[0]);
  carton.id = carton.cost_ledger.id = 'sc-carton';
  carton.cost_ledger.fee_context.sales = { from: '2027-02-02', through: '2027-09-30' };
  carton.cost_ledger.fee_context.storage = { from: '2027-02-02', through: '2027-09-30' };
  c2.economics.operating_periods[0].scenarios.push(carton);
  c2.economics.operating_periods[0].expected_primary_scenarios = [
    { id: 'sc-regular', status: 'active' },
    { id: 'sc-carton', status: 'active' },
  ];
  const r2 = scoreCandidate(c2, profile);
  assert.equal(r2.qualification.counts_toward_target, false);
  assert.equal(r2.qualification.mode, 'none');

  // State 3: silently dropping sc-carton while it remains active in expected_primary_scenarios -> STILL pending!
  const c3 = structuredClone(c2);
  c3.economics.operating_periods[0].scenarios = [c3.economics.operating_periods[0].scenarios[0]];
  const r3 = scoreCandidate(c3, profile);
  assert.equal(r3.operating_periods[0].queue, 'pending');
  assert.equal(r3.qualification.counts_toward_target, false);
  assert.match(r3.operating_periods[0].diagnostics.economics.reason, /Missing active pre-declared primary scenario: sc-carton/);

  // State 3b: cancelling sc-carton WITHOUT valid evidence -> STILL pending!
  const c3b = structuredClone(c3);
  c3b.economics.operating_periods[0].expected_primary_scenarios[1] = {
    id: 'sc-carton', status: 'cancelled', reason: 'Unverified drop', evidence: ['nonexistent-id'],
  };
  const r3b = scoreCandidate(c3b, profile);
  assert.equal(r3b.operating_periods[0].queue, 'pending');
  assert.equal(r3b.qualification.counts_toward_target, false);

  // State 3c: cancelling sc-carton while still keeping it in scenarios -> conflict -> STILL pending!
  const c3c = structuredClone(c2);
  c3c.economics.operating_periods[0].expected_primary_scenarios[1] = {
    id: 'sc-carton', status: 'cancelled', reason: 'Discontinued', evidence: ['synthetic-evidence'],
  };
  assert.equal(scoreCandidate(c3c, profile).operating_periods[0].queue, 'pending');

  // State 4: evidenced cancellation of sc-carton -> passes cleanly!
  const c4 = structuredClone(c3);
  c4.economics.operating_periods[0].expected_primary_scenarios[1] = {
    id: 'sc-carton',
    status: 'cancelled',
    reason: 'Supplier confirmed carton SKU discontinued before sourcing.',
    evidence: ['synthetic-evidence'],
  };
  const r4 = scoreCandidate(c4, profile);
  assert.equal(r4.operating_periods[0].queue, 'comparable');
  assert.equal(r4.qualification.counts_toward_target, true);
  assert.equal(r4.qualification.mode, 'seasonal_eligible');
});

test('revision 58 flat annual mode rejects partial-year windows and report.mjs consumes qualification without self-judging', () => {
  // Full 12-month flat annual candidate passes
  const annual = structuredClone(fixture.candidates[0]);
  annual.id = 'annual-full';
  const rAnnual = scoreCandidate(annual, profile);
  assert.equal(rAnnual.queue, 'comparable');
  assert.equal(rAnnual.qualification.counts_toward_target, true);
  assert.equal(rAnnual.qualification.mode, 'comparable');

  // 8-month flat annual candidate (2027-02-01..2027-09-30 and 2027-02-02..2027-09-30) MUST be rejected from comparable
  for (const from of ['2027-02-01', '2027-02-02']) {
    const partial = structuredClone(fixture.candidates[0]);
    partial.id = `flat-partial-${from}`;
    partial.economics.scenarios[0].cost_ledger.fee_context.sales = { from, through: '2027-09-30' };
    partial.economics.scenarios[0].cost_ledger.fee_context.storage = { from, through: '2027-09-30' };
    const batch = { schema_version: 1, profile_revision: 58, candidates: [partial] };
    const res = scoreBatch(batch, profile);
    const out = res.candidates[0];
    assert.equal(out.queue, 'pending');
    assert.equal(out.total, null);
    assert.equal(out.conditional_total_range, null);
    assert.equal(out.qualification.counts_toward_target, false);
    assert.equal(out.qualification.mode, 'none');
    assert.equal(res.summary.complete, 0);
    assert.equal(res.summary.qualifying, 0);

    const html = renderReport(res, batch);
    assert.match(html, /data-eligible="false"/);
    assert.match(html, /data-bucket="pending"/);
    assert.match(html, /达标可推进 0/);
    assert.match(html, /待补证 1/);
    assert.match(html, /淘汰／暂缓 0/);
  }

  // Strong-fail on partial-year flat candidate still routes to excluded (not pending)
  const partialFail = structuredClone(fixture.candidates[0]);
  partialFail.id = 'flat-partial-excluded';
  partialFail.economics.scenarios[0].cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
  partialFail.economics.scenarios[0].cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  partialFail.judgments.specific_design_rights.anchor = 0;
  const failOut = scoreCandidate(partialFail, profile);
  assert.equal(failOut.queue, 'excluded');
  assert.equal(failOut.qualification.counts_toward_target, false);

  // Proof that report.mjs strictly obeys qualification.counts_toward_target with zero self-judging
  const batchFull = { schema_version: 1, profile_revision: 58, candidates: [annual] };
  const scoredFull = scoreBatch(batchFull, profile);
  scoredFull.candidates[0].qualification.counts_toward_target = false;
  const tamperedHtml = renderReport(scoredFull, batchFull);
  assert.match(tamperedHtml, /data-eligible="false"/);
  assert.match(tamperedHtml, /达标可推进 0/);
});

test('revision 58 isolates stress_scenarios[] from 21-item score and renders stress section, landed cap, and break-even click CVR', () => {
  const c = makeSeasonalCandidate('stress-iso');
  const fbmStress = structuredClone(c.economics.operating_periods[0].scenarios[0]);
  fbmStress.id = fbmStress.cost_ledger.id = 'fbm-48-99-stress';
  fbmStress.label = 'FBM $48.99 价格带压力情景';
  fbmStress.stress_type = 'fbm_price_defense';
  fbmStress.cost_ledger.price_usd = 48.99;
  fbmStress.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 28; // pushes stress margin well below 30%
  c.economics.operating_periods[0].stress_scenarios = [fbmStress];

  const batch = { schema_version: 1, profile_revision: 58, candidates: [c] };
  const res = scoreBatch(batch, profile);
  const out = res.candidates[0];
  assert.equal(out.qualification.counts_toward_target, true);
  assert.equal(out.operating_periods[0].queue, 'comparable');
  assert.equal(out.operating_periods[0].total, 100);
  const stressDiag = out.operating_periods[0].diagnostics.economics.stress_scenarios;
  assert.equal(stressDiag.length, 1);
  assert.equal(stressDiag[0].calculation.status, 'sensitivity_only');
  assert.ok(stressDiag[0].margin < 0.3);

  const html = renderReport(res, batch);
  assert.match(html, /data-section="stress-scenarios"/);
  assert.match(html, /独立压力情景（仅作敏感度观察，不计入 21 项主分与 30% 淘汰线）/);
  assert.match(html, /FBM \$48\.99 价格带压力情景/);
  assert.match(html, /保 30% 毛利对应到深含运采购上限/);
  assert.match(html, /广告盈亏平衡所需点击转化率/);
  assert.match(html, /仅可与点击转化率 clickConvRate 对照，严禁与搜索购买率 purchaseRate 混比/);
});

test('revision 58 is strictly permutation-invariant across period order and candidate order for all 6 queues and report HTML', () => {
  const compA = structuredClone(fixture.candidates[0]);
  compA.id = 'cand-comp-a';
  compA.label = '全年可比 A';
  const compB = structuredClone(fixture.candidates[0]);
  compB.id = 'cand-comp-b';
  compB.label = '全年可比 B';

  const seasEligA = makeSeasonalCandidate('cand-seas-elig-a', { reversePeriods: false });
  const seasEligB = makeSeasonalCandidate('cand-seas-elig-b', { reversePeriods: true });

  const seasPendA = makeSeasonalCandidate('cand-seas-pend-a', { offPeakFrom: '2027-02-02', reversePeriods: false });
  const seasPendB = makeSeasonalCandidate('cand-seas-pend-b', { offPeakFrom: '2027-02-02', reversePeriods: true });

  const pendA = structuredClone(fixture.candidates[2]);
  pendA.id = 'cand-pend-a';
  const pendB = structuredClone(fixture.candidates[2]);
  pendB.id = 'cand-pend-b';

  const defA = structuredClone(fixture.candidates[0]);
  defA.id = 'cand-def-a';
  defA.screening.strong_date_dependency.value = true;
  const defB = structuredClone(fixture.candidates[0]);
  defB.id = 'cand-def-b';
  defB.screening.strong_date_dependency.value = true;

  const exclA = structuredClone(fixture.candidates[0]);
  exclA.id = 'cand-excl-a';
  exclA.judgments.specific_design_rights.anchor = 0;
  const exclB = structuredClone(fixture.candidates[0]);
  exclB.id = 'cand-excl-b';
  exclB.judgments.specific_design_rights.anchor = 0;

  const list1 = [compA, compB, seasEligA, seasEligB, pendA, pendB, seasPendA, seasPendB, defA, defB, exclA, exclB];
  // Reversed candidate order AND flipped period order inside every seasonal card!
  const list2 = [...list1].reverse().map(c => {
    const clone = structuredClone(c);
    if (clone.economics?.operating_periods) clone.economics.operating_periods.reverse();
    return clone;
  });

  const batch1 = { schema_version: 1, profile_revision: 58, candidates: list1 };
  const batch2 = { schema_version: 1, profile_revision: 58, candidates: list2 };
  const res1 = scoreBatch(batch1, profile);
  const res2 = scoreBatch(batch2, profile);

  assert.deepEqual(res1, res2);
  assert.deepEqual(res1.candidates.map(c => c.candidate_id), [
    'cand-comp-a', 'cand-comp-b',
    'cand-seas-elig-a', 'cand-seas-elig-b',
    'cand-pend-a', 'cand-pend-b',
    'cand-seas-pend-a', 'cand-seas-pend-b',
    'cand-def-a', 'cand-def-b',
    'cand-excl-a', 'cand-excl-b',
  ]);
  assert.equal(res1.summary.qualifying, 4);

  const html1 = renderReport(res1, batch1);
  const html2 = renderReport(res2, batch2);
  assert.equal(html1, html2);
});

test('revision 58 aligns r_refund vs r_physical excess returns processing, tri-state Gate-1 checks, and date validation across early-screen, fee-basis, and economics', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const baseEarlyR58 = {
    profile_revision: 58,
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

  // 1. All 3 modules compute exact excess fee (0.12 - 0.087) * 4.32 = 0.14256
  const ePass = evaluateEarlyScreen(baseEarlyR58);
  assert.equal(ePass.gate_status, 'pass');
  const retLineEarly = ePass.ledger.lines.find(l => l.id === 'returns_processing');
  assert.equal(retLineEarly.amount_usd, 0.14256);

  // Build identical cost_ledger for fee-basis.mjs & economics.mjs
  const mkLedger = retOverrides => ({
    id: 'r58-ret-check',
    saleable_unit: 'one synthetic tool',
    price_usd: 29.99,
    refund_fraction: 0.05,
    physical_return_fraction: 0.12,
    assumptions: ['R58 excess returns alignment check'],
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

  const econOk = calculateEconomics(mkLedger({}), { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(econOk.scoring_supported, true);
  assert.equal(econOk.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256);
  assert.equal(econOk.margin, ePass.metrics.margin);

  // 2. Reject unexempted returns_processing = 0 when r_physical > return_threshold in ALL THREE modules!
  const earlyZero = evaluateEarlyScreen({ ...baseEarlyR58, returns_processing_usd: 0 });
  assert.equal(earlyZero.gate_status, 'pending');
  assert.ok(earlyZero.ledger.pending_lines.includes('returns_processing'));

  const fbZero = validateFeeBasis(mkLedger({ amount_usd: 0, status: 'not_applicable' }), { profileRevision: 58, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(fbZero.status, 'needs_evidence');
  assert.ok(fbZero.issues.some(i => i.code === 'returns_processing_required'));

  const econZero = calculateEconomics(mkLedger({ amount_usd: 0, status: 'not_applicable' }), { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(econZero.scoring_supported, false);
  assert.ok(econZero.pending_lines.includes('returns_processing'));

  // Even without requireFeeBasis, economics.mjs under r58 rejects unexempted 0
  const econZeroDirect = calculateEconomics(mkLedger({ amount_usd: 0, status: 'not_applicable' }), { profileRevision: 58 });
  assert.equal(econZeroDirect.scoring_supported, false);
  assert.ok(econZeroDirect.pending_lines.includes('returns_processing'));

  // 3. $29.99 boundary where excess returns_processing ($0.14256) pushes margin from >=30% to <30%!
  // At procurement = 6.5 -> find procurement right at 30.1% without returns fee so +0.14256 breaks 30%
  const bareNoRet = evaluateEarlyScreen({ ...baseEarlyR58, physical_return_fraction: 0.05 });
  const boundaryProc = Math.floor((bareNoRet.metrics.procurement_cap_at_floor_usd - 0.05) * 100) / 100;
  const passBelowThresh = evaluateEarlyScreen({ ...baseEarlyR58, procurement_usd: boundaryProc, physical_return_fraction: 0.05 });
  assert.equal(passBelowThresh.gate_status, 'pass');
  const failAboveThresh = evaluateEarlyScreen({ ...baseEarlyR58, procurement_usd: boundaryProc, physical_return_fraction: 0.12 });
  assert.equal(failAboveThresh.gate_status, 'fail');
  assert.ok(failAboveThresh.metrics.margin < 0.3);

  // 4. Evidenced exemption allows 0 cleanly across all 3 modules (un-evidenced or unregistered exemption stays pending!)
  const earlyExemptUnEvidenced = evaluateEarlyScreen({ ...baseEarlyR58, returns_processing_usd: 0, returns_processing_exemption: { reason: 'Un-evidenced claim' } });
  assert.equal(earlyExemptUnEvidenced.gate_status, 'pending');
  const earlyExemptUnregistered = evaluateEarlyScreen({ ...baseEarlyR58, returns_processing_usd: 0, returns_processing_exemption: { reason: 'Fake ID', evidence: ['unregistered-id'] } });
  assert.equal(earlyExemptUnregistered.gate_status, 'pending');
  const earlyExempt = evaluateEarlyScreen({ ...baseEarlyR58, evidence_ids: ['src'], returns_processing_usd: 0, returns_processing_exemption: { reason: 'Official <25/mo threshold waiver', evidence: ['src'] } });
  assert.equal(earlyExempt.gate_status, 'pass');
  assert.equal(earlyExempt.ledger.lines.find(l => l.id === 'returns_processing').amount_usd, 0);
  const econExempt = calculateEconomics(mkLedger({
    amount_usd: 0, status: 'not_applicable',
    exemption: { reason: 'Official waiver', evidence: ['src'] },
  }), { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(econExempt.scoring_supported, true);

  // 5. Tri-state rights/date checks & Gate-1 mandatory date windows in r58
  assert.throws(() => evaluateEarlyScreen({ ...baseEarlyR58, specific_rights_conflict: 'false' }), TypeError);
  assert.throws(() => evaluateEarlyScreen({ ...baseEarlyR58, strong_date_dependency: 'no' }), TypeError);

  const rightsUnknown = evaluateEarlyScreen({ ...baseEarlyR58, specific_rights_conflict: 'unknown' });
  assert.equal(rightsUnknown.gate_status, 'economic_pass_rights_unsearched');
  assert.equal(rightsUnknown.proceed_to_gate2, true);
  assert.equal(rightsUnknown.proceed_to_21_items, false);

  const dateUnknown = evaluateEarlyScreen({ ...baseEarlyR58, strong_date_dependency: undefined });
  assert.equal(dateUnknown.gate_status, 'pending');
  assert.equal(dateUnknown.checks.strong_date_dependency, 'date_unverified');
  assert.equal(dateUnknown.proceed_to_21_items, false);
  assert.equal(dateUnknown.proceed_to_gate2, false);

  // Strong fail wins over unknown rights
  const strongFailWins = evaluateEarlyScreen({ ...baseEarlyR58, price_usd: 25, specific_rights_conflict: 'unknown' });
  assert.equal(strongFailWins.gate_status, 'fail');
  assert.equal(strongFailWins.proceed_to_gate2, false);

  // Omitted operating_period / fee_context rejected in r58
  const noDates = structuredClone(baseEarlyR58);
  delete noDates.fee_context;
  assert.equal(evaluateEarlyScreen(noDates).gate_status, 'pending');

  // Contradictory sales_window rejected in r58
  assert.equal(evaluateEarlyScreen({ ...baseEarlyR58, sales_window: { from: '2027-03-01', through: '2027-09-30' } }).gate_status, 'pending');

  // Q4 storage with $0.78 off-peak rate rejected in r58
  assert.equal(evaluateEarlyScreen({
    ...baseEarlyR58,
    operating_period: 'peak',
    fee_context: {
      ...validFeeCtx,
      sales: { from: '2027-10-01', through: '2027-12-31' },
      storage: { from: '2027-10-01', through: '2027-12-31' },
    },
    fulfillment_fee_basis: { status: 'published', effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
  }).gate_status, 'pending');

  // Gate 1A landed domestic cap is returned even before 1688 quotes
  const gate1A = structuredClone(baseEarlyR58);
  delete gate1A.procurement_usd;
  delete gate1A.domestic_freight_usd;
  const g1aRes = evaluateEarlyScreen(gate1A);
  assert.equal(g1aRes.gate_status, 'pending');
  assert.ok(g1aRes.metrics.landed_domestic_cap_at_floor_usd > 0);
  assert.ok(g1aRes.metrics.landed_domestic_cap_at_floor_cny > 0);
});

test('revision 58 Q31 exact rational greedy F(S) resolves JS float tie 0.18x3, T=0/9.9/10 continuity, missing T pending, US calendar age_days, and 4+1 shared S* & D', () => {
  // 1. Exact rational greedy stops at shortest prefix on 0.18 + 0.18 + 0.18 tie (JS float 0.5400000000000001 / 3 > 0.18!)
  assert.ok((0.18 + 0.18 + 0.18) / 3 > 0.18); // confirm IEEE-754 drift exists
  const greedyTie = evalGreedyFRat(
    [{ family_id: 'f1', asin: 'a1', e_rat: rat(18, 100) }, { family_id: 'f2', asin: 'a2', e_rat: rat(18, 100) }],
    [{ family_id: 'r1', asin: 'ra1', e_rat: rat(18, 100) }],
  );
  assert.equal(greedyTie.selected.length, 2);
  assert.equal(greedyTie.rejected_ramp_up.length, 1);
  assert.equal(greedyTie.denominator, 2);

  // 2. T = 0, T = 9.9, T = 10.0 continuity & missing T stays pending
  for (const [tVal, expectFloor] of [[0, true], [9.9, true], [10, false]]) {
    const c = structuredClone(fixture.candidates[0]);
    c.newcomer_cohort.market_reference.families = [
      { family_id: 'ref1', comparability_verdict: 'comparable', units_30d: obs(tVal, 'units') },
      { family_id: 'ref2', comparability_verdict: 'comparable', units_30d: obs(tVal, 'units') },
      { family_id: 'ref3', comparability_verdict: 'comparable', units_30d: obs(tVal, 'units') },
    ];
    c.newcomer_cohort.members = [
      makeNewcomerMember('m1', { ratings: 5, units: 8, launch: '2026-10-01', share: 0.7 }),
      makeNewcomerMember('m2', { ratings: 5, units: 8, launch: '2026-10-01', share: 0.7 }),
    ];
    const res = scoreCandidate(c, profile);
    assert.equal(res.diagnostics.newcomers.references.sales_median, tVal);
    assert.equal(res.diagnostics.newcomers.references.effective_sales_median, 10);
    assert.equal(res.diagnostics.newcomers.references.floor_applied, expectFloor);
    assert.equal(res.items.find(i => i.id === 'low_rating_sales_performance').score, 4);
  }

  // Missing/empty T stays pending (never defaults to 10)
  const missingT = structuredClone(fixture.candidates[0]);
  missingT.newcomer_cohort.market_reference.families = [];
  const resMissingT = scoreCandidate(missingT, profile);
  assert.equal(resMissingT.items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  assert.equal(resMissingT.queue, 'pending');

  // 3. US-site calendar age_days (no 7-day floor) & future launch rejection
  const tzCand = structuredClone(fixture.candidates[0]);
  tzCand.newcomer_cohort.observation_date = '2026-11-17';
  tzCand.newcomer_cohort.period = '2026-10-19/2026-11-17';
  tzCand.newcomer_cohort.market_reference.period = '2026-10-19/2026-11-17';
  const tzMember = makeNewcomerMember('tz-1day', { ratings: 5, units: 80, launch: '2026-11-17T02:00:00+08:00', share: 0.7 });
  tzMember.natural.period = '2026-10-19/2026-11-17';
  tzCand.newcomer_cohort.members = [
    // 2026-11-17T02:00:00+08:00 == 2026-11-16T10:00:00-08:00 (America/Los_Angeles) -> age_days = 1!
    tzMember,
  ];
  const tzRes = scoreCandidate(tzCand, profile);
  assert.equal(tzRes.diagnostics.newcomers.members[0].launch_calendar_date, '2026-11-16');
  assert.equal(tzRes.diagnostics.newcomers.members[0].age_days, 1);
  assert.equal(tzRes.items.find(i => i.id === 'low_rating_sales_performance').score, 2); // 4 / max(1, 2) = 2
  assert.equal(tzRes.items.find(i => i.id === 'natural_visibility_development').score, 0.5); // 1 / 2 = 0.5
  assert.equal(tzRes.diagnostics.newcomers.lone_newcomer_alert, true);

  // Future US launch date rejected
  const futureCand = structuredClone(tzCand);
  futureCand.newcomer_cohort.members[0].launch_date = '2026-11-18';
  assert.equal(scoreCandidate(futureCand, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  // 4. Non-monotonicity of 4+1: full = [(4, 1), (0, 1)], ramp = [(2.4, 0)] -> 4-pt rises 2 -> 6.4/3, 1-pt drops 1 -> 2/3, shared S* & D=3
  const nonMono = structuredClone(fixture.candidates[0]);
  nonMono.newcomer_cohort.observation_date = '2026-11-13';
  nonMono.newcomer_cohort.members = [
    makeNewcomerMember('full-good', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }), // e=4, nat=1
    makeNewcomerMember('full-zero', { ratings: 5, units: 0, launch: '2026-10-01', share: 0.7 }),   // e=0, nat=1
    makeNewcomerMember('ramp-mid', { ratings: 5, units: 40, launch: '2026-11-01', share: 0 }),     // ratio=0.4 -> e=2.4, nat=0
  ];
  const nmRes = scoreCandidate(nonMono, profile);
  assert.equal(nmRes.diagnostics.newcomers.denominator, 3);
  assert.equal(nmRes.diagnostics.newcomers.selected_pair.length, 3);
  assert.ok(Math.abs(nmRes.items.find(i => i.id === 'low_rating_sales_performance').score - (6.4 / 3)) < 1e-12);
  assert.ok(Math.abs(nmRes.items.find(i => i.id === 'natural_visibility_development').score - (2 / 3)) < 1e-12);

  // 5. Missing SIF on S* keeps 1-pt needs_evidence with [knownSum/D, (knownSum+m)/D] without swapping
  const missSif = structuredClone(nonMono);
  missSif.newcomer_cohort.members[2].natural.value = null;
  const msRes = scoreCandidate(missSif, profile);
  const natItem = msRes.items.find(i => i.id === 'natural_visibility_development');
  assert.equal(natItem.status, 'needs_evidence');
  assert.deepEqual(natItem.conditional_range, [2 / 3, 3 / 3]);

  // 6. <30d zero-sale pre-exclusion: all <30d zero-sale -> 0/4 and 0/1, NO lone-newcomer alert
  const allRampZero = structuredClone(fixture.candidates[0]);
  allRampZero.newcomer_cohort.members = [
    makeNewcomerMember('rz1', { ratings: 0, units: 0, launch: '2026-11-05', share: null }),
    makeNewcomerMember('rz2', { ratings: 0, units: 0, launch: '2026-11-10', share: null }),
  ];
  const rzRes = scoreCandidate(allRampZero, profile);
  assert.equal(rzRes.items.find(i => i.id === 'low_rating_sales_performance').score, 0);
  assert.equal(rzRes.items.find(i => i.id === 'natural_visibility_development').score, 0);
  assert.equal(rzRes.diagnostics.newcomers.lone_newcomer_alert, false);
  assert.equal(rzRes.diagnostics.newcomers.absence_note, '所查范围内无同任务正常起步新品样板');
  assert.equal(rzRes.diagnostics.newcomers.ramp_up_zero_sales.length, 2);

  // 7. Weak 2nd newcomer (e < 2) cannot silence lone-newcomer alert
  const weakSecond = structuredClone(fixture.candidates[0]);
  weakSecond.newcomer_cohort.members = [
    makeNewcomerMember('strong1', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }), // e=4
    makeNewcomerMember('weak2', { ratings: 5, units: 10, launch: '2026-10-01', share: 0.7 }),    // e=0.6
  ];
  const wsRes = scoreCandidate(weakSecond, profile);
  assert.equal(wsRes.diagnostics.newcomers.lone_newcomer_alert, true);
});

test('revision 58 Q31 deterministic 5-quintile stratification, replacement, cherry-pick blocking, and brute-force verified stratified_bounds', () => {
  // 1. N = 6: [4, 4, 4, 4, 4, 0] -> strata [[0],[1],[2],[3],[4,5]], midpoints [0,1,2,3,4] -> 5th item (0) is unsampled!
  // Sampled score = 4, stratified_bounds = [20/6, 4] = [3.3333..., 4], allows complete 21/21 with disclosure!
  const c6 = structuredClone(fixture.candidates[0]);
  c6.newcomer_cohort.members = [
    makeNewcomerMember('n1', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n2', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n3', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n4', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n5', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n6', { ratings: 5, units: 0, launch: '2026-10-01', share: null, status: 'unsampled_stratified' }),
  ];
  const b6 = { schema_version: 1, profile_revision: 58, candidates: [c6] };
  const res6 = scoreBatch(b6, profile);
  const out6 = res6.candidates[0];
  assert.equal(out6.queue, 'comparable');
  assert.equal(out6.total, 100);
  assert.equal(out6.diagnostics.newcomers.stratification.applied, true);
  assert.equal(out6.diagnostics.newcomers.stratification.disclosure, 'Q31 为 5/6 分层代表估计');
  assert.ok(Math.abs(out6.diagnostics.newcomers.stratification.stratified_bounds[0] - (20 / 6)) < 1e-12);
  assert.equal(out6.diagnostics.newcomers.stratification.stratified_bounds[1], 4);
  const html6 = renderReport(res6, b6);
  assert.match(html6, /Q31 为 5\/6 分层代表估计/);
  assert.match(html6, /3\.33–4 \/ 4/);

  // 2. Cherry-picking: swapping n5 (qualified) with n6 (unsampled) violates deterministic midpoint -> pending!
  const cherry = structuredClone(c6);
  cherry.newcomer_cohort.members[4].status = 'unsampled_stratified';
  cherry.newcomer_cohort.members[5].status = 'qualified';
  cherry.newcomer_cohort.members[5].natural.value = 0.7;
  assert.equal(scoreCandidate(cherry, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  // 3. Missing ratings on unsampled_stratified blocks Q31
  const missingUnsampled = structuredClone(c6);
  missingUnsampled.newcomer_cohort.members[5].ratings.value = null;
  assert.equal(scoreCandidate(missingUnsampled, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  // 4. unsampled_stratified when N_active <= 5 is rejected
  const smallPool = structuredClone(c6);
  smallPool.newcomer_cohort.members = smallPool.newcomer_cohort.members.slice(0, 5);
  smallPool.newcomer_cohort.members[4].status = 'unsampled_stratified';
  assert.equal(scoreCandidate(smallPool, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  // 5. In-stratum replacement + nearest-stratum borrowing via selectStratifiedNewcomers
  const pool = [
    { family_id: 'a0', asin: 'x0', e_rat: rat(4), units_30d: 100, excluded: true },  // Stratum 0 depleted!
    { family_id: 'a1', asin: 'x1', e_rat: rat(39, 10), units_30d: 95 },             // Stratum 1 mid -> selected for S1
    { family_id: 'a2', asin: 'x2', e_rat: rat(38, 10), units_30d: 90 },             // Stratum 1 backup -> borrowed by S0!
    { family_id: 'a3', asin: 'x3', e_rat: rat(30, 10), units_30d: 80 },             // Stratum 2 mid -> selected
    { family_id: 'a4', asin: 'x4', e_rat: rat(25, 10), units_30d: 70, excluded: true }, // Stratum 3 mid excluded!
    { family_id: 'a5', asin: 'x5', e_rat: rat(20, 10), units_30d: 60 },             // Stratum 3 backup -> in-stratum replace
    { family_id: 'a6', asin: 'x6', e_rat: rat(10, 10), units_30d: 50 },             // Stratum 4 mid -> selected
    { family_id: 'a7', asin: 'x7', e_rat: rat(5, 10), units_30d: 40 },              // Stratum 4 unsampled
  ];
  const sel = selectStratifiedNewcomers(pool);
  assert.equal(sel.stratified, true);
  assert.equal(sel.blocked, false);
  assert.equal(sel.selected.length, 5);
  assert.equal(sel.strata[0].borrowed_from_stratum, 1);
  assert.deepEqual(sel.selected.map(s => s.family_id).sort(), ['a1', 'a2', 'a3', 'a5', 'a6']);

  // 6. Exhaustive brute-force 2^|U| verification of computeStratifiedBoundsRat across tricky configurations
  const bruteForce = (vFull, vRamp, uFull, uRamp) => {
    const uAll = [...uFull.map(r => ({ r, full: true })), ...uRamp.map(r => ({ r, full: false }))];
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let mask = 0; mask < (1 << uAll.length); mask++) {
      const fSet = [...vFull];
      const rSet = [...vRamp];
      for (let i = 0; i < uAll.length; i++) {
        if ((mask & (1 << i)) !== 0) {
          if (uAll[i].full) fSet.push(uAll[i].r);
          else rSet.push(uAll[i].r);
        }
      }
      const g = evalGreedyFRat(
        fSet.map((e_rat, idx) => ({ family_id: `f${idx}`, asin: `fa${idx}`, e_rat })),
        rSet.map((e_rat, idx) => ({ family_id: `r${idx}`, asin: `ra${idx}`, e_rat })),
      );
      const val = ratToFloat(g.f_rat);
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
    return [minVal, maxVal];
  };

  const cases = [
    [[rat(4), rat(4), rat(4), rat(4), rat(4)], [], [rat(0)], []],
    [[], [rat(35, 10)], [rat(0), rat(12, 10), rat(4)], [rat(28, 10), rat(39, 10)]],
    [[rat(15, 10)], [rat(3), rat(25, 10), rat(18, 10)], [rat(0), rat(5, 10), rat(38, 10)], [rat(4), rat(22, 10)]],
    [[rat(4), rat(1)], [rat(24, 10), rat(18, 10)], [rat(0), rat(18, 10), rat(35, 10)], [rat(32, 10)]],
    [[], [], [rat(0), rat(2)], [rat(3), rat(1)]],
  ];
  for (const [vf, vr, uf, ur] of cases) {
    const [loRat, hiRat] = computeStratifiedBoundsRat(vf, vr, uf, ur);
    const [bLo, bHi] = bruteForce(vf, vr, uf, ur);
    assert.ok(Math.abs(ratToFloat(loRat) - bLo) < 1e-12, `low_min mismatch: ${ratToFloat(loRat)} vs ${bLo}`);
    assert.ok(Math.abs(ratToFloat(hiRat) - bHi) < 1e-12, `low_max mismatch: ${ratToFloat(hiRat)} vs ${bHi}`);
  }
});

test('src/fba-rates-2027.mjs verifies 2027 US Standard-size table, $49.99/$50.00/$50.01 cliff, landed cap, oversize pending, shortlist, and carton/MOQ sku_lines', () => {
  const pkg152 = { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.52 };
  const refTerms = { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 };
  const offWin = { from: '2027-02-01', through: '2027-09-30' };
  const inbWin = { from: '2027-01-15', through: '2027-01-15' };

  // 1. $49.99 / $50.00 / $50.01 cliff on Large Standard 1.5+..1.75 lb
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
  const p4999 = cliff.points.find(p => p.price_usd === 49.99);
  const p5000 = cliff.points.find(p => p.price_usd === 50.00);
  const p5001 = cliff.points.find(p => p.price_usd === 50.01);
  assert.equal(p4999.fulfillment_usd, 5.9202);
  assert.equal(p5000.fulfillment_usd, 5.9202);
  assert.equal(p5001.fulfillment_usd, 6.51015);
  assert.equal(cliff.sweet_spot_alert, true);

  // 2. Exact match against all local revcal-verified 2027 anchors
  const anchors = [
    { dims: [10, 7, 4], wt: 2.58, price: 39.99, exp: 6.6447 },
    { dims: [10, 7, 4], wt: 2.97, price: 39.99, exp: 7.08975 },
    { dims: [12, 9, 5], wt: 6.31, price: 54.99, exp: 9.15975 },
    { dims: [12, 9, 4], wt: 4.278, price: 39.99, exp: 7.9074 },
  ];
  for (const a of anchors) {
    const f = lookupFulfillmentFee2027({
      pkg: { length_in: a.dims[0], width_in: a.dims[1], height_in: a.dims[2], unit_weight_lb: a.wt },
      price_usd: a.price,
      sales_window: offWin,
    });
    assert.equal(f.status, 'verified');
    assert.equal(f.total_usd, a.exp);
  }

  // 3. Unlisted bulky/oversize, apparel, DG, SIPP, peak window, mixed storage, and unlisted categories -> needs_calculator_verification
  assert.equal(classifyStandardSize2027({ length_in: 19, width_in: 10, height_in: 5, unit_weight_lb: 5 }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, is_apparel: true }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, is_dangerous_goods: true }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, is_sipp: true }).status, 'needs_calculator_verification');
  assert.equal(lookupFulfillmentFee2027({ pkg: pkg152, price_usd: 39.99, sales_window: { from: '2027-10-15', through: '2027-12-31' } }).status, 'needs_calculator_verification');
  assert.equal(lookupStorageFee2027({ pkg: pkg152, months: [9, 10] }).status, 'needs_calculator_verification');
  assert.equal(lookupReturnsProcessing2027({ pkg: pkg152, physical_return_fraction: 0.06, fee_category: 'Unlisted Exotic Category' }).status, 'needs_calculator_verification');
  assert.equal(lookupPlacementFee2027({ pkg: pkg152, inbound_window: inbWin }).status, 'verified');

  // 4. Landed domestic procurement cap (0.70*R - A)*FX distinct from bare goods cap
  const g1a = estimateGate1A2027({
    pkg: pkg152,
    price_usd: 49.99,
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
    domestic_freight_usd: 0.8,
  });
  assert.equal(g1a.status, 'verified');
  const expectedNetRev = 49.99 * 0.95;
  const expectedLandedUsd = Math.round((0.70 * expectedNetRev - g1a.non_domestic_cost_a_usd) * 1e10) / 1e10;
  assert.equal(g1a.landed_domestic_cap_usd, expectedLandedUsd);
  assert.equal(g1a.landed_domestic_cap_cny, Math.round(expectedLandedUsd * 7.2 * 1e10) / 1e10);
  assert.equal(g1a.bare_goods_cap_usd, Math.round((expectedLandedUsd - 0.8) * 1e10) / 1e10);

  // 5. Negotiation shortlist drops 26.5% cutoff: R=40, G=10.4 (26%), C=16 -> required reduction (12 - 10.4)/16 = 10% <= 12% -> eligible!
  const negYes = computeNegotiationShortlist({ net_revenue_usd: 40, contribution_usd: 10.4, negotiable_cost_usd: 16 });
  assert.equal(negYes.eligible, true);
  assert.equal(negYes.required_discount_fraction, 0.1);
  const negNo = computeNegotiationShortlist({ net_revenue_usd: 40, contribution_usd: 10.4, negotiable_cost_usd: 10 });
  assert.equal(negNo.eligible, false);

  // 6. sku_lines[] carton & MOQ exact formulas (144 & 150 verified)
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

  // 2 SKUs 24/carton vs 25/carton: auto-remainder (LCM 600 > 200 cap) -> permutation-invariant sMin=100 -> 120 & 100, actual_complete_sets = 100
  const skuA = { sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 100, unit_price_cny: 10 };
  const skuB = { sku_id: 'B', qty_per_saleable_set: 1, pack_multiple: 25, moq_qty: 100, unit_price_cny: 20 };
  const planTwoRem = computeOrderPlan({ sku_lines: [skuA, skuB], min_sets: 100, allow_remainder: false });
  const planTwoRemRev = computeOrderPlan({ sku_lines: [skuB, skuA], min_sets: 100, allow_remainder: false });
  assert.equal(planTwoRem.mode, 'allow_remainder');
  assert.equal(planTwoRem.sku_lines[0].ordered_qty, 120);
  assert.equal(planTwoRem.sku_lines[1].ordered_qty, 100);
  assert.equal(planTwoRem.actual_complete_sets, 100);
  assert.equal(planTwoRem.total_goods_cny, 120 * 10 + 100 * 20);
  assert.equal(planTwoRemRev.allocated_sets, planTwoRem.allocated_sets);
  assert.equal(planTwoRemRev.actual_complete_sets, planTwoRem.actual_complete_sets);
  assert.equal(planTwoRemRev.total_goods_cny, planTwoRem.total_goods_cny);

  // Explicit high lcm_cap allows exact no-remainder LCM = 600
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

test('frozen r57 closure replay matches committed SHA-256 hashes byte-for-byte when local trial fixture exists', () => {
  const closureDir = new URL('../.local/trials/20261118-r57-closure/', import.meta.url);
  const batchUrl = new URL('batch.r57.json', closureDir);
  if (!existsSync(batchUrl)) return; // clean CI clone without private .local/
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const frozenProfile = structuredClone(profile);
  frozenProfile.revision = frozenProfile.workflow.scoring_and_ordering.revision = 57;
  const batch = JSON.parse(readFileSync(batchUrl, 'utf8'));
  const disc = JSON.parse(readFileSync(new URL('discovery-bundle.json', closureDir), 'utf8'));
  const manifest = prepareDiscovery(disc.pool, disc.decisions);
  const bound = attachDiscovery(batch, manifest);
  const res = scoreBatch(bound, frozenProfile);
  res.discovery = { ...manifest, summary: bound.discovery_summary };
  const resBytes = Buffer.from(`${JSON.stringify(res, null, 2)}\n`, 'utf8');
  const htmlBytes = Buffer.from(renderReport(res, bound), 'utf8');
  assert.equal(sha(resBytes), 'bd450fc8e10b7fd3efb8f4ea85f0e52e6b281611f1285f475406d1e38a2d2e4e');
  assert.equal(sha(htmlBytes), '8c44f80d99b897a0a90d4e6f2d5163b46d9c6825233c674ea03c2e2fc6fbe81b');
});

test('B14: frozen r55 and r56 legacy HTML replays preserve byte-exact LF SHA-256 hashes when local receipts exist', () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  // Frozen r55 (full re-score from real single-entry-r55 archive + profile.r55.before.json)
  const r55BatchDir = new URL('../.local/trials/20261116-next-cards/resumed-flow/single-entry-r55/', import.meta.url);
  const r55ProfDir = new URL('../.local/trials/20261116-next-cards/resumed-flow/equal-entry-r56/', import.meta.url);
  const r55BatchUrl = new URL('batch.r55.json', r55BatchDir);
  if (existsSync(r55BatchUrl)) {
    const r55Batch = JSON.parse(readFileSync(r55BatchUrl, 'utf8'));
    const r55Prof = JSON.parse(readFileSync(new URL('profile.r55.before.json', r55ProfDir), 'utf8'));
    const r55Disc = JSON.parse(readFileSync(new URL('discovery-bundle.json', r55BatchDir), 'utf8'));
    const manifest = prepareDiscovery(r55Disc.pool, r55Disc.decisions);
    const bound = attachDiscovery(r55Batch, manifest);
    const res = scoreBatch(bound, r55Prof);
    res.discovery = { ...manifest, summary: bound.discovery_summary };
    assert.equal(sha(Buffer.from(`${JSON.stringify(res, null, 2)}\n`, 'utf8')), '4c1f2fb5bf3567bac6f34483b3d5ed6ea15a3dc1582acabf836d3b9a5bf99f3b');
    assert.equal(sha(Buffer.from(renderReport(res, bound), 'utf8')), 'a7bdebcd67e33b5301813cb16ee8b21d7f19c6a4debee4faba8a50d58ecc0c58');
  }
  // Frozen r56 (full re-score from raw batch + r56 profile)
  const r56Dir = new URL('../.local/trials/20261116-next-cards/resumed-flow/card-completion-20261117/', import.meta.url);
  const r56BatchUrl = new URL('batch.complete-evidence.r56.json', r56Dir);
  if (existsSync(r56BatchUrl)) {
    const r56Batch = JSON.parse(readFileSync(r56BatchUrl, 'utf8'));
    const r56Prof = structuredClone(profile);
    r56Prof.revision = r56Prof.workflow.scoring_and_ordering.revision = 56;
    const r56Disc = JSON.parse(readFileSync(new URL('../discovery-bundle.json', r56Dir), 'utf8'));
    const manifest = prepareDiscovery(r56Disc.pool, r56Disc.decisions);
    const bound = attachDiscovery(r56Batch, manifest);
    const res = scoreBatch(bound, r56Prof);
    res.discovery = { ...manifest, summary: bound.discovery_summary };
    assert.equal(sha(Buffer.from(`${JSON.stringify(res, null, 2)}\n`, 'utf8')), '4551d1f9139cca3384bca78149c633b1ee2206d7fa5cf646c94a6f4a31c7b64c');
    assert.equal(sha(Buffer.from(renderReport(res, bound), 'utf8')), '6962a3d8de918b59f3850664f73dc4a19c43c9166775fcd90056598270ab782c');
  }
});

test('B01–B03: flat annual bypass prevention, closed-set expected_primary_scenarios, and strict seasonal peak/off-peak validation', () => {
  // B01(a): flat annual card with 8-month window + root economics.operating_months MUST remain pending
  const flatBypass = structuredClone(fixture.candidates[0]);
  flatBypass.id = 'b01-flat-bypass';
  flatBypass.economics.operating_months = [2, 3, 4, 5, 6, 7, 8, 9];
  for (const sc of flatBypass.economics.scenarios) {
    sc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
    sc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    sc.cost_ledger.fee_context.inbound = { from: '2027-02-01', through: '2027-02-01' };
  }
  const b01Batch = { ...structuredClone(fixture), candidates: [flatBypass] };
  const b01Res = scoreBatch(b01Batch, profile);
  assert.equal(b01Res.summary.qualifying, 0);
  assert.equal(b01Res.candidates[0].queue, 'pending');
  assert.equal(b01Res.candidates[0].qualification.counts_toward_target, false);
  assert.match(renderReport(b01Res, b01Batch), /data-eligible="false"/);

  // B01(b): full-year dates with only pending fulfillment MUST NOT blame full-year date coverage and MUST keep conditional_total_range
  const flatPendingFulfill = structuredClone(fixture.candidates[0]);
  flatPendingFulfill.id = 'b01-full-year-pending-fulfill';
  Object.assign(flatPendingFulfill.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null, status: 'pending',
  });
  const b01bRes = scoreBatch({ ...structuredClone(fixture), candidates: [flatPendingFulfill] }, profile);
  assert.equal(b01bRes.candidates[0].queue, 'pending');
  assert.ok(Array.isArray(b01bRes.candidates[0].conditional_total_range), 'conditional_total_range must be preserved');
  assert.ok(!b01bRes.candidates[0].qualification.reasons.some(r => r.includes('all 12 calendar months')));

  // B02(a): closed-set expected_primary_scenarios rejects undeclared extra scenario ID even if declared ID is cancelled
  const b02Closed = structuredClone(fixture.candidates[0]);
  b02Closed.id = 'b02-closed-set';
  b02Closed.economics.expected_primary_scenarios = [
    { id: 'old-cancelled', status: 'cancelled', reason: 'Discontinued SKU', evidence: ['synthetic-evidence'] },
  ];
  const b02aRes = scoreBatch({ ...structuredClone(fixture), candidates: [b02Closed] }, profile);
  assert.equal(b02aRes.summary.qualifying, 0);
  assert.equal(b02aRes.candidates[0].qualification.counts_toward_target, false);

  // B02(b): period-level shorter expected_primary_scenarios CANNOT override root-level missing active scenario
  const b02Merge = makeSeasonalCandidate('b02-merge');
  b02Merge.economics.expected_primary_scenarios = [
    { id: 'sc-regular', status: 'active' },
    { id: 'sc-carton-missing', status: 'active' },
  ];
  b02Merge.economics.operating_periods[0].expected_primary_scenarios = [
    { id: 'sc-regular', status: 'active' },
  ];
  const b02bRes = scoreBatch({ ...structuredClone(fixture), candidates: [b02Merge] }, profile);
  assert.equal(b02bRes.summary.qualifying, 0);
  assert.equal(b02bRes.candidates[0].qualification.counts_toward_target, false);

  // B02(c): deleting last active scenario (scenarios: []) with expected_primary_scenarios stays pending without throwing TypeError
  const b02Empty = makeSeasonalCandidate('b02-empty-scenarios');
  b02Empty.economics.operating_periods[0].expected_primary_scenarios = [{ id: 'sc-regular', status: 'active' }];
  b02Empty.economics.operating_periods[0].scenarios = [];
  const b02cRes = scoreBatch({ ...structuredClone(fixture), candidates: [b02Empty] }, profile);
  assert.equal(b02cRes.summary.qualifying, 0);
  assert.equal(b02cRes.candidates[0].qualification.counts_toward_target, false);
  assert.equal(b02cRes.candidates[0].operating_periods[0].queue, 'pending');

  // B03(a): companion peak panel with 2026 dates, missing cost_ledger, or [1,10,11,12] MUST NOT qualify
  const peak2026 = makeSeasonalCandidate('b03-peak-2026');
  peak2026.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.sales = { from: '2026-10-15', through: '2026-12-31' };
  peak2026.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.storage = { from: '2026-10-15', through: '2026-12-31' };
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peak2026] }, profile).summary.qualifying, 0);

  const peakNoLedger = makeSeasonalCandidate('b03-peak-no-ledger');
  delete peakNoLedger.economics.operating_periods[1].scenarios[0].cost_ledger;
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakNoLedger] }, profile).summary.qualifying, 0);

  const peakWrongMonths = makeSeasonalCandidate('b03-peak-wrong-months');
  peakWrongMonths.economics.operating_periods[1].months = [1, 10, 11, 12];
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakWrongMonths] }, profile).summary.qualifying, 0);

  // B03(b): off-peak starting 2027-02-02 turns inner off-peak period ITSELF pending (total_range null, amber dot)
  const offDayShort = makeSeasonalCandidate('b03-day-short', { offPeakFrom: '2027-02-02' });
  const offShortBatch = { ...structuredClone(fixture), candidates: [offDayShort] };
  const offShortRes = scoreBatch(offShortBatch, profile);
  assert.equal(offShortRes.summary.qualifying, 0);
  const innerOff = offShortRes.candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(innerOff.queue, 'pending');
  assert.equal(innerOff.total_range, null);
  const offShortHtml = renderReport(offShortRes, offShortBatch);
  assert.doesNotMatch(offShortHtml, /data-operating-period="off_peak" data-queue="comparable"/);
  assert.match(offShortHtml, /data-operating-period="off_peak" data-queue="pending"/);
});

test('B04: primary scenario price cannot float above validated target-variant FBA reference price anchor', () => {
  // Price anchor at $29.99, procurement $12 -> at $29.99 margin < 30%; inflating ledger to $59.99 MUST NOT pass!
  const inflated = structuredClone(fixture.candidates[0]);
  inflated.id = 'b04-inflated-price';
  inflated.screening.reference_price_usd = {
    value: 29.99, unit: 'USD', matched_spec: true, target_variant_asin: 'SYN-VAR-01',
    fulfillment_channel: 'FBA', sales_history_supported: true, evidence: ['synthetic-evidence'],
  };
  const sc = inflated.economics.scenarios[0];
  sc.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  sc.cost_ledger.price_usd = 59.99;
  sc.cost_ledger.lines.find(l => l.id === 'referral').amount_usd = 8.6386;
  inflated.economics.scenarios = [sc];
  const res = scoreBatch({ ...structuredClone(fixture), candidates: [inflated] }, profile);
  assert.equal(res.summary.qualifying, 0);
  assert.equal(res.candidates[0].queue, 'pending');

  // Missing target_variant_asin, FBM anchor, or unsupported sales history blocks qualification
  for (const mutate of [
    rp => { delete rp.target_variant_asin; },
    rp => { rp.fulfillment_channel = 'FBM'; },
    rp => { rp.sales_history_supported = false; },
  ]) {
    const c = structuredClone(fixture.candidates[0]);
    c.id = 'b04-bad-anchor';
    mutate(c.screening.reference_price_usd);
    const r = scoreBatch({ ...structuredClone(fixture), candidates: [c] }, profile);
    assert.equal(r.summary.qualifying, 0);
    assert.equal(r.candidates[0].queue, 'pending');
  }
});

test('B05–B08: Q31 grain/comparability/natural-period enforcement, unconditional N_active>5 stratification, transitive old-review exclusion, and BigInt-free pending JSON', () => {
  // B05(a): all-excluded different-task ref families + grain:'unknown' MUST stay pending (never T=0 -> T_eff=10)
  const b05 = structuredClone(fixture.candidates[0]);
  b05.id = 'b05-bad-grain-and-ref';
  b05.newcomer_cohort.sales_grain = 'unknown';
  b05.newcomer_cohort.market_reference.grain = 'unknown';
  for (const f of b05.newcomer_cohort.market_reference.families) {
    f.comparability_verdict = 'excluded_different_task';
    f.reason = 'Different task';
    f.evidence = ['synthetic-evidence'];
    f.units_30d.value = 0;
  }
  const b05aRes = scoreBatch({ ...structuredClone(fixture), candidates: [b05] }, profile);
  assert.equal(b05aRes.summary.qualifying, 0);
  assert.equal(b05aRes.candidates[0].items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  // B05(b): natural exposure with wrong period or 7-day window MUST stay needs_evidence [0, 0.5] keeping S* & D=2
  const b05Nat = structuredClone(fixture.candidates[0]);
  b05Nat.id = 'b05-bad-natural-window';
  b05Nat.newcomer_cohort.members = [
    {
      ...structuredClone(b05Nat.newcomer_cohort.members[0]),
      family_id: 'f-nat-1', asin: 'SYN-NAT-1',
      natural: {
        ...structuredClone(b05Nat.newcomer_cohort.members[0].natural),
        period: '2026-01', window_days: 7,
      },
    },
  ];
  const b05bRes = scoreBatch({ ...structuredClone(fixture), candidates: [b05Nat] }, profile);
  const natItem = b05bRes.candidates[0].items.find(i => i.id === 'natural_visibility_development');
  assert.equal(natItem.status, 'needs_evidence');
  assert.deepEqual(natItem.conditional_range, [0, 0.5]);

  // B06: six full-month newcomers [4,4,4,4,4,0] unconditionally trigger 5-quintile stratification regardless of qualified vs unsampled_stratified label
  const mkSix = (sixthStatus) => {
    const c = structuredClone(fixture.candidates[0]);
    c.id = `b06-${sixthStatus}`;
    const baseM = structuredClone(c.newcomer_cohort.members[0]);
    c.newcomer_cohort.members = [
      { ...structuredClone(baseM), family_id: 'f1', asin: 'SYN-S1', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 120, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified' },
      { ...structuredClone(baseM), family_id: 'f2', asin: 'SYN-S2', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 110, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified' },
      { ...structuredClone(baseM), family_id: 'f3', asin: 'SYN-S3', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 100, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified' },
      { ...structuredClone(baseM), family_id: 'f4', asin: 'SYN-S4', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 90, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified' },
      { ...structuredClone(baseM), family_id: 'f5', asin: 'SYN-S5', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 80, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified' },
      { ...structuredClone(baseM), family_id: 'f6', asin: 'SYN-S6', ratings: { value: 500, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 0, unit: 'units', evidence: ['synthetic-evidence'] }, status: sixthStatus },
    ];
    return scoreBatch({ ...structuredClone(fixture), candidates: [c] }, profile).candidates[0];
  };
  const allQual6 = mkSix('qualified');
  const strat6 = mkSix('unsampled_stratified');
  assert.equal(allQual6.diagnostics.newcomers.stratification.applied, true);
  assert.equal(strat6.diagnostics.newcomers.stratification.applied, true);
  assert.equal(allQual6.diagnostics.newcomers.denominator, 5);
  assert.deepEqual(
    allQual6.items.find(i => i.id === 'low_rating_sales_performance').score_range,
    strat6.items.find(i => i.id === 'low_rating_sales_performance').score_range,
  );
  // Also verify Q31 HTML includes strata details!
  const stratHtml = renderReport({ ...scoreBatch({ ...structuredClone(fixture), candidates: [structuredClone(fixture.candidates[0])] }, profile), candidates: [allQual6] }, fixture);
  assert.match(stratHtml, /5 分位分层抽样与替补明细/);

  // B07(a): same ASIN with one old-review row and one unmarked row propagates exclusion to whole group -> [0, 0] (never 2+0.5)
  const b07Prop = structuredClone(fixture.candidates[0]);
  b07Prop.id = 'b07-propagate';
  const bm = structuredClone(b07Prop.newcomer_cohort.members[0]);
  b07Prop.newcomer_cohort.members = [
    { ...structuredClone(bm), family_id: 'f-old', asin: 'SYN-OLD', status: 'excluded', old_reviews_predate_launch: true, reason: 'Old reviews', evidence: ['synthetic-evidence'], ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 100, unit: 'units', evidence: ['synthetic-evidence'] } },
    { ...structuredClone(bm), family_id: 'f-old-dup', asin: 'SYN-OLD', status: 'qualified', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 100, unit: 'units', evidence: ['synthetic-evidence'] } },
  ];
  const b07PropRes = scoreBatch({ ...structuredClone(fixture), candidates: [b07Prop] }, profile).candidates[0];
  assert.deepEqual(b07PropRes.items.find(i => i.id === 'low_rating_sales_performance').score_range, [0, 0]);
  assert.equal(b07PropRes.diagnostics.newcomers.no_qualifying_examples, true);

  // B07(b): duplicating an old_reviews_predate_launch excluded row in a 6+1 pool deduplicates to 1 excluded pool entry -> identical score!
  const mkB07Strat = (dupExcluded) => {
    const c = structuredClone(fixture.candidates[0]);
    c.id = `b07-dup-excl-${dupExcluded}`;
    const base6 = [100, 90, 80, 60, 40, 30].map((u, idx) => ({
      ...structuredClone(bm),
      family_id: `f-act-${idx + 1}`, asin: `SYN-A${idx + 1}`,
      ratings: { value: 10, unit: 'count', evidence: ['synthetic-evidence'] },
      units_30d: { value: u, unit: 'units', evidence: ['synthetic-evidence'] },
      status: 'qualified',
    }));
    const exclRow = {
      ...structuredClone(bm),
      family_id: 'f-excl-50', asin: 'SYN-EX50', status: 'excluded', old_reviews_predate_launch: true,
      reason: 'Old reviews predate launch', evidence: ['synthetic-evidence'],
      ratings: { value: 10, unit: 'count', evidence: ['synthetic-evidence'] },
      units_30d: { value: 50, unit: 'units', evidence: ['synthetic-evidence'] },
    };
    c.newcomer_cohort.members = dupExcluded ? [...base6, exclRow, structuredClone(exclRow)] : [...base6, exclRow];
    return scoreBatch({ ...structuredClone(fixture), candidates: [c] }, profile).candidates[0];
  };
  const b07SingleExcl = mkB07Strat(false);
  const b07DupExcl = mkB07Strat(true);
  assert.equal(b07SingleExcl.items.find(i => i.id === 'low_rating_sales_performance').status, 'scored');
  assert.deepEqual(
    b07DupExcl.items.find(i => i.id === 'low_rating_sales_performance').score_range,
    b07SingleExcl.items.find(i => i.id === 'low_rating_sales_performance').score_range,
  );
  assert.equal(b07DupExcl.diagnostics.newcomers.stratification.full_pool_size, 7);

  // B07(c): duplicate family with conflicting launch_calendar_date (31d vs 29d before 2026-11-13) stays pending in EITHER order
  for (const reverse of [false, true]) {
    const b07Date = structuredClone(fixture.candidates[0]);
    b07Date.id = `b07-date-${reverse}`;
    const d1 = { ...structuredClone(bm), family_id: 'f-dup', asin: 'SYN-D1', launch_date: '2026-10-13' }; // 31d
    const d2 = { ...structuredClone(bm), family_id: 'f-dup', asin: 'SYN-D2', launch_date: '2026-10-15' }; // 29d
    b07Date.newcomer_cohort.members = reverse ? [d2, d1] : [d1, d2];
    const r = scoreBatch({ ...structuredClone(fixture), candidates: [b07Date] }, profile).candidates[0];
    assert.equal(r.items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  }

  // B08: missing ratings on a qualified newcomer returns pending AND JSON.stringify succeeds (zero BigInt leak!)
  const b08 = structuredClone(fixture.candidates[0]);
  b08.id = 'b08-no-bigint';
  b08.newcomer_cohort.members[0].ratings = { value: null, unit: 'count', evidence: ['synthetic-evidence'] };
  const b08Res = scoreBatch({ ...structuredClone(fixture), candidates: [b08] }, profile);
  assert.equal(b08Res.candidates[0].queue, 'pending');
  assert.doesNotThrow(() => JSON.stringify(b08Res));
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
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
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
  assert.equal(evaluateEarlyScreen(baseEarly).gate_status, 'pass', 'baseline early-screen must pass before adversarial mutations');

  // B09(a): missing return_threshold + positive placeholder $0.00001 rejected in ALL THREE modules
  const earlyNoThresh = evaluateEarlyScreen({ ...baseEarly, return_threshold: null, returns_processing_usd: 0.00001 });
  assert.equal(earlyNoThresh.gate_status, 'pending');

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
  assert.equal(validateFeeBasis(mkB09Ledger(), { profileRevision: 58, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'validated', 'baseline ledger must validate');
  assert.equal(calculateEconomics(mkB09Ledger(), { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).scoring_supported, true, 'baseline economics must pass');
  const noThreshLedger = mkB09Ledger({ amount_usd: 0.00001, return_threshold: undefined });
  assert.equal(validateFeeBasis(noThreshLedger, { profileRevision: 58, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(noThreshLedger, { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).scoring_supported, false);

  // B09(b): wrong positive amount_usd $0.00001 with valid threshold MUST be rejected in ALL THREE modules (no silent overwrite!)
  const wrongPosLedger = mkB09Ledger({ amount_usd: 0.00001 });
  assert.equal(evaluateEarlyScreen({ ...baseEarly, returns_processing_usd: 0.00001 }).gate_status, 'pending');
  assert.equal(validateFeeBasis(wrongPosLedger, { profileRevision: 58, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(wrongPosLedger, { profileRevision: 58 }).scoring_supported, false);

  // B09(c): conflicting line return_threshold (0.90) vs fee_basis return_threshold (0.087) MUST be rejected!
  const conflictThresh = mkB09Ledger({ return_threshold: 0.90, fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, return_threshold: 0.087 } });
  assert.equal(validateFeeBasis(conflictThresh, { profileRevision: 58, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(conflictThresh, { profileRevision: 58 }).scoring_supported, false);

  // B10(a): minimal fee_basis (missing version/evidence/marketplace/currency) OR Q4 $0.78 storage rate (even with complete fee_basis) rejected in early-screen
  const q4Minimal = evaluateEarlyScreen({
    ...baseEarly,
    operating_period: 'peak',
    fee_context: { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } },
    fulfillment_fee_basis: { status: 'published', effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage_fee_basis: { status: 'published', effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 2.40, average_inventory_days: 45 },
  });
  assert.equal(q4Minimal.gate_status, 'pending');
  const q4LowStorageWithValidBasis = evaluateEarlyScreen({
    ...baseEarly,
    operating_period: 'peak',
    fee_context: { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } },
    fulfillment_fee_basis: { ...validBasis, effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage_fee_basis: { ...validBasis, effective_from: '2027-10-01', effective_through: '2027-12-31' },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
  });
  assert.equal(q4LowStorageWithValidBasis.gate_status, 'pending');

  // B10(b): estimateGate1A2027 rejects missing sales/inbound windows or inbound after sales (2029)
  const g1aNoWindows = estimateGate1A2027({
    profile_revision: 58,
    price_usd: 49.99, refund_fraction: 0.05, physical_return_fraction: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
  });
  assert.equal(g1aNoWindows.status, 'needs_calculator_verification');
  const g1a2029 = estimateGate1A2027({
    price_usd: 49.99, refund_fraction: 0.05, physical_return_fraction: 0.05,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2029-01-15', through: '2029-01-15' },
  });
  assert.equal(g1a2029.status, 'needs_calculator_verification');

  // B10(c): unlisted fee_category in lookupReturnsProcessing2027 ALWAYS returns needs_calculator_verification even with caller return_threshold=0.99
  const unlistedRet = lookupReturnsProcessing2027({
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    fee_category: 'unlisted_exotic_category',
    physical_return_fraction: 0.05,
    return_threshold: 0.99,
  });
  assert.equal(unlistedRet.status, 'needs_calculator_verification');

  // B11: sku_lines[] carton/MOQ (24/ctn, MOQ 125 -> 144 sets, ¥125, FX 7.2 -> $17.361111/set) tampered procurement $0.01 rejected in ALL THREE modules!
  const skuLinesTamper = [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, unit_price_cny: 125, ordered_qty: 144 }];
  const b11Ledger = mkB09Ledger();
  b11Ledger.source_inputs = { fx_cny_per_usd: 7.2 };
  Object.assign(b11Ledger.lines.find(l => l.id === 'procurement'), {
    amount_usd: 0.01, order_units: 144, sku_lines: skuLinesTamper, fx_cny_per_usd: 7.2,
  });
  Object.assign(b11Ledger.lines.find(l => l.id === 'domestic_freight'), { order_units: 144 });
  assert.equal(validateFeeBasis(b11Ledger, { profileRevision: 58, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).status, 'needs_evidence');
  assert.equal(calculateEconomics(b11Ledger, { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] }).scoring_supported, false);
  assert.equal(calculateEconomics(b11Ledger, { profileRevision: 58 }).scoring_supported, false);
  // Early screen rejects BOTH tampered procurement_usd=$0.01 AND illegal order_units=125 (never silently replaces 125 with 144!)
  assert.equal(evaluateEarlyScreen({ ...baseEarly, procurement_usd: 0.01, order_units: 144, fx_cny_per_usd: 7.2, sku_lines: skuLinesTamper }).gate_status, 'pending');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, procurement_usd: 125 / 7.2, order_units: 125, fx_cny_per_usd: 7.2, sku_lines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, unit_price_cny: 125 }] }).gate_status, 'pending');

  // B12: exact $0 landed domestic cap (0.70*R - A === 0) without positive floor MUST NOT fail zero-browser gate!
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
  // Choose headhaul so 0.70 * 40 - A === 0 exactly:
  const exactZeroHeadhaul = Number((28 - (probeG1a.non_domestic_cost_a_usd - 1)).toFixed(10));
  const zeroCapNoFloor = estimateGate1A2027({ ...g1aBase, headhaul_usd: exactZeroHeadhaul });
  assert.equal(zeroCapNoFloor.status, 'verified');
  assert.equal(zeroCapNoFloor.landed_domestic_cap_usd, 0);
  assert.equal(zeroCapNoFloor.zero_browser_fail, false);
  const zeroCapWithFloor = estimateGate1A2027({ ...g1aBase, headhaul_usd: exactZeroHeadhaul, min_landed_domestic_usd: 0.01 });
  assert.equal(zeroCapWithFloor.zero_browser_fail, true);

  // Calibration Note 1: exact rational 12% shortlist rejects 12.0000000002% & procurement=0 does not negotiate freight
  const exactOver12 = computeNegotiationShortlist({ net_revenue_usd: 33.3333333334, contribution_usd: 8.8, negotiable_cost_usd: 10 });
  assert.equal(exactOver12.eligible, false);
  const zeroGoodsEarly = evaluateEarlyScreen({ ...baseEarly, procurement_usd: 0, domestic_freight_usd: 10, headhaul: { usd_per_unit: 2, bond_included: true } });
  assert.equal(zeroGoodsEarly.gate_status, 'fail');
  assert.equal(zeroGoodsEarly.negotiation_shortlist, null);

  // Calibration Note 2: computeOrderPlan throws RangeError instead of silently truncating > MAX_SAFE_INTEGER
  assert.throws(() => computeOrderPlan({
    sku_lines: [{ sku_id: 'BIG', qty_per_saleable_set: 3, pack_multiple: 1, moq_qty: 1 }],
    min_sets: 100, target_sets: 3002399751580331, allow_remainder: true,
  }), RangeError);
});

test('B13 & Report Notes: exact 30% HTML pass tone, banner count sync with qualification, local path redaction, CSS tabs >= t6, and root+period stress merge', () => {
  // Exact 30% decimal margin where IEEE-754 float produces 0.2999999999999999:
  // price=30, refund=0.05 -> net_rev = 28.5, 70% cost = 19.95 -> float (28.5 - 19.95)/28.5 = 0.29999999999999999...
  // Let's specifically construct exact 30% float < 0.3: price=29.99, r=0 -> net_rev=29.99, 0.70*29.99 = 20.993 (exact decimal!)
  // Check: (29.99 - 20.993) / 29.99 in IEEE-754 is 0.29999999999999993 < 0.3!
  const exact30Cand = structuredClone(fixture.candidates[0]);
  exact30Cand.id = 'b13-exact-30';
  const sc = exact30Cand.economics.scenarios[0];
  sc.cost_ledger.price_usd = 29.99;
  sc.cost_ledger.refund_fraction = 0;
  sc.cost_ledger.physical_return_fraction = 0;
  exact30Cand.screening.reference_price_usd.value = 29.99;
  const lines = sc.cost_ledger.lines;
  lines.find(l => l.id === 'referral').amount_usd = 4.4985;
  lines.find(l => l.id === 'fulfillment').amount_usd = 5.0;
  lines.find(l => l.id === 'placement').amount_usd = 0.4;
  lines.find(l => l.id === 'storage').amount_usd = 0.1;
  lines.find(l => l.id === 'returns_processing').amount_usd = 0;
  // Let collection_rate=0 (payout collection 0) so total cost is exact 20.993 without rounding drift:
  sc.cost_ledger.collection_rate = 0;
  lines.find(l => l.id === 'collection').amount_usd = 0;
  lines.find(l => l.id === 'headhaul').amount_usd = 1.0;
  lines.find(l => l.id === 'domestic_freight').amount_usd = 0.5;
  lines.find(l => l.id === 'procurement').amount_usd = 9.4945; // 4.4985 + 5 + 0.4 + 0.1 + 0 + 0 + 1 + 0.5 + 9.4945 = 20.993 exact!
  exact30Cand.economics.scenarios = [sc];
  exact30Cand.economics.expected_primary_scenarios = [
    { id: sc.id, status: 'active' },
    { id: 'cancelled-with-path', status: 'cancelled', reason: 'Cancelled per C:/Users/AUDIT_NAME/quote.txt', evidence: ['synthetic-evidence'] },
  ];
  exact30Cand.economics.stress_scenarios = [
    {
      id: 'fbm-stress',
      label: 'Stress C:/Users/AUDIT_NAME/quote.txt <unsafe>',
      price_usd: 29.99,
      margin: 0.25,
      contribution_usd: 7.5,
      assumptions: ['Ref C:/Users/AUDIT_NAME/quote.txt'],
    },
  ];
  const exactBatch = { ...structuredClone(fixture), candidates: [exact30Cand] };
  const exactRes = scoreBatch(exactBatch, profile);
  assert.equal(exactRes.summary.qualifying, 1);
  assert.ok(exactRes.candidates[0].diagnostics.economics.scenarios[0].input.calculation.margin < 0.3, 'IEEE-754 float must be < 0.3 to prove exact decimal guard');
  const exactHtml = renderReport(exactRes, exactBatch);
  const exactBody = exactHtml.split('<body>')[1];
  assert.doesNotMatch(exactBody, /低于红线/);
  assert.doesNotMatch(exactBody, /ink-fail|alloc-margin-fail|swatch-fail/);
  assert.match(exactBody, /\+0 pts 高于红线/);
  assert.equal(exactHtml.includes('AUDIT_NAME'), false, 'local username path must be redacted in stress & cancellation copy');
  assert.ok(exactHtml.includes('&lt;unsafe&gt;'), 'angle brackets remain escaped');

  // Mutating qualification.counts_toward_target=false updates banner, pills, matrix, AND card consistently!
  const mutatedRes = structuredClone(exactRes);
  mutatedRes.candidates[0].qualification.counts_toward_target = false;
  const mutatedHtml = renderReport(mutatedRes, exactBatch);
  const mutatedBody = mutatedHtml.split('<body>')[1];
  assert.match(mutatedBody, /完整可比 0 个/);
  assert.match(mutatedBody, /达标可推进 0/);
  assert.match(mutatedBody, /data-eligible="false"/);
  assert.doesNotMatch(mutatedBody, /data-eligible="true"/);

  // Report Notes: 6-period seasonal card generates CSS for t6..t8 AND merges root + period stress_scenarios!
  const multiPeriod = makeSeasonalCandidate('b13-six-periods');
  const pendingBase = structuredClone(multiPeriod.economics.operating_periods[1]);
  const comparableBase = structuredClone(multiPeriod.economics.operating_periods[0]);
  // 6 disjoint periods (months [1],[2],[3],[4],[5] pending; period 6 months [6,7,8,9] comparable so default display tab is t6!)
  comparableBase.id = 'p6_comparable';
  comparableBase.label = '第6时段';
  comparableBase.months = [6, 7, 8, 9];
  comparableBase.scenarios[0].cost_ledger.fee_context.sales = { from: '2027-06-01', through: '2027-09-30' };
  comparableBase.scenarios[0].cost_ledger.fee_context.storage = { from: '2027-06-01', through: '2027-09-30' };
  comparableBase.stress_scenarios = [{ id: 'period-stress', label: 'Period stress', price_usd: 36, margin: 0.24 }];
  multiPeriod.economics.stress_scenarios = [{ id: 'root-stress', label: 'Root stress', price_usd: 35, margin: 0.22 }];
  multiPeriod.economics.operating_periods = [1, 2, 3, 4, 5].map(m => {
    const p = structuredClone(pendingBase);
    p.id = `p${m}`;
    p.label = `时段 ${m}`;
    p.months = [m];
    p.scenarios[0].cost_ledger.fee_context.sales = { from: `2027-0${m}-01`, through: `2027-0${m}-28` };
    p.scenarios[0].cost_ledger.fee_context.storage = { from: `2027-0${m}-01`, through: `2027-0${m}-28` };
    return p;
  }).concat([comparableBase]);
  const mpBatch = { ...structuredClone(fixture), candidates: [multiPeriod] };
  const mpRes = scoreBatch(mpBatch, profile);
  const p6Out = mpRes.candidates[0].operating_periods.find(p => p.id === 'p6_comparable');
  assert.equal(p6Out.diagnostics.economics.stress_scenarios.length, 2, 'root and period stress_scenarios must merge');
  const mpHtml = renderReport(mpRes, mpBatch);
  assert.match(mpHtml, /id="candidate-1-t6" checked/);
  assert.match(mpHtml, /\.card-tabs:has\(input\[id\$="-t6"\]:checked\) \.tab-p6/);
});

test('Round-2 Codex Findings 1–7 & Notes: airtight sku_lines/FX/rounding, peak/merge/inbound guards, price lower-bound & report hiding, Q31 strictness/duplicates, returns/storage/Gate1A parity, and spaced-path/label redaction', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };

  // Finding 1(a): actually omitting unit_price_cny from sku_lines[] + $0.01 procurement MUST fail validation!
  const mkSkuLedger = ({ unitPrice = 125, omitUnitPrice = false, procUsd = 125 / 7.2, lineFx = undefined, sourceFx = 7.2 } = {}) => ({
    id: 'f1-sc', saleable_unit: '1 unit', price_usd: 29.99, refund_fraction: 0.05, physical_return_fraction: 0.05,
    assumptions: ['F1 probe'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005,
    source_inputs: { fx_cny_per_usd: sourceFx },
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
  const opts58 = { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };
  assert.equal(Object.hasOwn(mkSkuLedger({ omitUnitPrice: true, procUsd: 0.01 }).lines[0].sku_lines[0], 'unit_price_cny'), false);
  assert.equal(calculateEconomics(mkSkuLedger({ omitUnitPrice: true, procUsd: 0.01 }), opts58).scoring_supported, false, 'omitted unit_price_cny must be rejected');
  // Finding 1(b): conflicting line fx_cny_per_usd=12500 vs source_inputs fx=7.2 MUST be rejected!
  assert.equal(calculateEconomics(mkSkuLedger({ unitPrice: 125, procUsd: 0.01, lineFx: 12500, sourceFx: 7.2 }), opts58).scoring_supported, false, 'conflicting FX must be rejected');
  // Finding 1(c): rounded $9.49 vs exact ¥68.36/7.2=$9.4944444444 MUST be rejected (> 1e-6)!
  assert.equal(calculateEconomics(mkSkuLedger({ unitPrice: 68.36, procUsd: 9.49 }), opts58).scoring_supported, false, 'cached $9.49 fudge must be rejected');
  assert.equal(calculateEconomics(mkSkuLedger({ unitPrice: 68.36, procUsd: 9.4944444444 }), opts58).scoring_supported, true, 'exact unit procurement passes');

  // Finding 2(a): peak panel missing active expected_primary_scenarios, bad ledger ID, marketplace CA, or 2029 inbound CANNOT qualify!
  const peakMissExp = makeSeasonalCandidate('f2-peak-miss-exp');
  peakMissExp.economics.operating_periods[1].expected_primary_scenarios = [
    { id: 'sc-peak', status: 'active' }, { id: 'sc-peak-carton', status: 'active' },
  ];
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakMissExp] }, profile).summary.qualifying, 0);

  const peakBadId = makeSeasonalCandidate('f2-peak-bad-id');
  peakBadId.economics.operating_periods[1].scenarios[0].cost_ledger.id = 'wrong-id';
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakBadId] }, profile).summary.qualifying, 0);

  const peakCA = makeSeasonalCandidate('f2-peak-ca');
  peakCA.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.marketplace = 'CA';
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakCA] }, profile).summary.qualifying, 0);

  const peak2029Inb = makeSeasonalCandidate('f2-peak-2029-inb');
  peak2029Inb.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.inbound = { from: '2029-01-15', through: '2029-01-15' };
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peak2029Inb] }, profile).summary.qualifying, 0);

  // Finding 2(b): conflicting invalid + cancelled entries in root/period expected_primary_scenarios rejected in EITHER order
  for (const swap of [false, true]) {
    const f2Conflict = makeSeasonalCandidate(`f2-merge-conflict-${swap}`);
    const badEntry = { id: 'sc-x', status: 'bogus_status' };
    const cancelEntry = { id: 'sc-x', status: 'cancelled', reason: 'Dropped', evidence: ['synthetic-evidence'] };
    f2Conflict.economics.expected_primary_scenarios = [{ id: 'sc-regular', status: 'active' }, swap ? cancelEntry : badEntry];
    f2Conflict.economics.operating_periods[0].expected_primary_scenarios = [{ id: 'sc-regular', status: 'active' }, swap ? badEntry : cancelEntry];
    assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [f2Conflict] }, profile).summary.qualifying, 0);
  }

  // Finding 2(c): off-peak inbound 2027-01-14 makes inner off-peak panel itself pending!
  const f2EarlyInb = makeSeasonalCandidate('f2-early-inbound');
  f2EarlyInb.economics.operating_periods[0].scenarios[0].cost_ledger.fee_context.inbound = { from: '2027-01-14', through: '2027-01-14' };
  const f2EarlyRes = scoreBatch({ ...structuredClone(fixture), candidates: [f2EarlyInb] }, profile);
  assert.equal(f2EarlyRes.summary.qualifying, 0);
  assert.equal(f2EarlyRes.candidates[0].operating_periods.find(p => p.id === 'off_peak').queue, 'pending');

  // Finding 3: price anchor lower bound ($29.98 below [$38, $45] rejected) AND unanchored $59.99 NOT displayed as green 55.35% or 美站参照价!
  const f3Low = structuredClone(fixture.candidates[0]);
  f3Low.id = 'f3-below-range';
  f3Low.screening.reference_price_usd.supported_price_range = [38, 45];
  f3Low.economics.scenarios[0].cost_ledger.price_usd = 29.98;
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [f3Low] }, profile).summary.qualifying, 0);

  const f3High = structuredClone(fixture.candidates[0]);
  f3High.id = 'f3-high-hidden';
  f3High.screening.reference_price_usd.value = 29.99;
  f3High.economics.scenarios[0].cost_ledger.price_usd = 59.99;
  f3High.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  const f3HighBatch = { ...structuredClone(fixture), candidates: [f3High] };
  const f3HighRes = scoreBatch(f3HighBatch, profile);
  assert.equal(f3HighRes.summary.qualifying, 0);
  const f3HtmlBody = renderReport(f3HighRes, f3HighBatch).split('<body>')[1];
  assert.doesNotMatch(f3HtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);
  assert.match(f3HtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 29\.99/);
  assert.doesNotMatch(f3HtmlBody, /hero-stat-val ink-pass">55\.35%/);

  // Finding 4: comparability_verdict:'unknown', 7-day / last-year aligned period, SellerSprite-only natural, and child-ASIN natural under parent grain ALL blocked!
  const f4Unk = structuredClone(fixture.candidates[0]);
  f4Unk.newcomer_cohort.members[0].comparability_verdict = 'unknown';
  for (const rf of f4Unk.newcomer_cohort.market_reference.families) { rf.comparability_verdict = 'unknown'; rf.units_30d.value = 0; }
  assert.equal(scoreCandidate(f4Unk, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const f4Seven = structuredClone(fixture.candidates[0]);
  f4Seven.newcomer_cohort.period = '2026-11-07/2026-11-13';
  f4Seven.newcomer_cohort.market_reference.period = '2026-11-07/2026-11-13';
  f4Seven.newcomer_cohort.members[0].natural.period = '2026-11-07/2026-11-13';
  assert.equal(scoreCandidate(f4Seven, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const f4SsOnly = structuredClone(fixture.candidates[0]);
  f4SsOnly.evidence.push({ id: 'ss-only', source: 'SellerSprite keyword list', observed_at: '2026-11-13' });
  f4SsOnly.newcomer_cohort.members[0].natural.evidence = ['ss-only'];
  delete f4SsOnly.newcomer_cohort.members[0].natural.keyword_counts.sif;
  assert.equal(scoreCandidate(f4SsOnly, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence');

  const f4ChildView = structuredClone(fixture.candidates[0]);
  f4ChildView.newcomer_cohort.grain = 'parent_units';
  f4ChildView.newcomer_cohort.market_reference.grain = 'parent_units';
  f4ChildView.newcomer_cohort.members[0].natural.isListingSearch = false;
  assert.equal(scoreCandidate(f4ChildView, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence');

  // Finding 5: duplicate active conflicting natural (0.7 vs 0) pending in BOTH orders; excluded old-review missing ratings blocks stratification; <30d 0-sale old-review duplicate does NOT inflate pool!
  const bm = structuredClone(fixture.candidates[0].newcomer_cohort.members[0]);
  for (const rev of [false, true]) {
    const f5Nat = structuredClone(fixture.candidates[0]);
    const r1 = { ...structuredClone(bm), family_id: 'f-dup-nat', asin: 'SYN-DN1', natural: { ...structuredClone(bm.natural), value: 0.7 } };
    const r2 = { ...structuredClone(bm), family_id: 'f-dup-nat', asin: 'SYN-DN1', natural: { ...structuredClone(bm.natural), value: 0 } };
    f5Nat.newcomer_cohort.members = rev ? [r2, r1] : [r1, r2];
    assert.equal(scoreCandidate(f5Nat, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  }
  const f5MissRat = structuredClone(fixture.candidates[0]);
  f5MissRat.newcomer_cohort.members = [
    ...[100, 90, 80, 60, 40, 30].map((u, i) => ({
      ...structuredClone(bm), family_id: `fa${i}`, asin: `SYN-FA${i}`,
      ratings: { value: 10, unit: 'count', evidence: ['synthetic-evidence'] },
      units_30d: { value: u, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified',
    })),
    { ...structuredClone(bm), family_id: 'f-ex-norat', asin: 'SYN-EXNR', status: 'excluded', old_reviews_predate_launch: true, ratings: { value: null, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 50, unit: 'units', evidence: ['synthetic-evidence'] } },
  ];
  assert.equal(scoreCandidate(f5MissRat, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const f5RampExcl = structuredClone(fixture.candidates[0]);
  f5RampExcl.newcomer_cohort.members = [
    ...[100, 90, 80, 60, 40, 30].map((u, i) => ({
      ...structuredClone(bm), family_id: `fb${i}`, asin: `SYN-FB${i}`,
      ratings: { value: 10, unit: 'count', evidence: ['synthetic-evidence'] },
      units_30d: { value: u, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified',
    })),
    { ...structuredClone(bm), family_id: 'f-ramp0', asin: 'SYN-R0', launch_date: '2026-11-01', status: 'excluded', old_reviews_predate_launch: true, ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 0, unit: 'units', evidence: ['synthetic-evidence'] } },
    { ...structuredClone(bm), family_id: 'f-ramp0', asin: 'SYN-R0', launch_date: '2026-11-01', status: 'qualified', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 0, unit: 'units', evidence: ['synthetic-evidence'] } },
  ];
  const f5RampRes = scoreCandidate(f5RampExcl, profile);
  assert.equal(f5RampRes.diagnostics.newcomers.stratification.full_pool_size, 6, '<30d 0-sale old-review duplicate must not inflate pool from 6 to 7');

  // Finding 6: returns_processing exact recomputation ($0.1425591 cannot cross 30%), Q4 pre-computed storage rejected in early-screen & formal ledger, Gate 1A omitted category & 2029 storage rejected!
  const q4PeakCtx = { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } };
  const q4PeakLedger = mkSkuLedger({ unitPrice: 40, procUsd: 40 / 7.2 });
  q4PeakLedger.fee_context = q4PeakCtx;
  q4PeakLedger.lines.find(l => l.id === 'fulfillment').fee_basis = { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31' };
  q4PeakLedger.lines.find(l => l.id === 'storage').fee_basis = { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31', months: [10, 11, 12] };
  q4PeakLedger.lines.find(l => l.id === 'storage').amount_usd = 0.0585; // 0.05 ft³ * 45d Q4 requires $0.18!
  assert.equal(calculateEconomics(q4PeakLedger, { ...opts58, operatingMonths: [10, 11, 12] }).scoring_supported, false, 'Q4 pre-computed $0.0585 storage must fail 2027 $2.40 floor');
  q4PeakLedger.lines.find(l => l.id === 'storage').amount_usd = 0.18;
  assert.equal(calculateEconomics(q4PeakLedger, { ...opts58, operatingMonths: [10, 11, 12] }).scoring_supported, true, 'Q4 $0.18 storage passes');

  // Early screen rejects pre-computed scalar storage & returns_processing_fee_basis conflict
  assert.equal(evaluateEarlyScreen({
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 29.99, fx_cny_per_usd: 7.2, order_units: 120, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, storage: 0.0585, collection_rate: 0.005, other_applicable_usd: 0,
    specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending', 'r58 early-screen must reject pre-computed scalar storage');

  assert.equal(lookupReturnsProcessing2027({ pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 }, physical_return_fraction: 0.05, return_threshold: 0.99 }).status, 'needs_calculator_verification', 'omitted fee_category cannot pass with return_threshold: 0.99');
  assert.equal(estimateGate1A2027({
    price_usd: 40, refund_fraction: 0, physical_return_fraction: 0,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Business, Industrial, and Scientific Supplies',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2029-02-01', through: '2029-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  }).status, 'needs_calculator_verification', '2027 sales + 2029 storage must return needs_calculator_verification');

  // Finding 7: spaced username C:/Users/Audit SurnameProof/quote.txt & primary scenario label path redacted!
  const f7Cand = structuredClone(fixture.candidates[0]);
  f7Cand.id = 'f7-path-redact';
  f7Cand.economics.scenarios[0].label = 'Main C:/Users/AUDIT_NAME/quote.txt';
  f7Cand.economics.stress_scenarios = [{
    id: 'st-space', label: 'Stress C:/Users/Audit SurnameProof/quote.txt', price_usd: 35, margin: 0.25,
    assumptions: ['Proof C:/Users/Audit SurnameProof/quote.txt'],
  }];
  f7Cand.economics.expected_primary_scenarios = [
    { id: f7Cand.economics.scenarios[0].id, status: 'active' },
    { id: 'c-space', status: 'cancelled', reason: 'Per C:/Users/Audit SurnameProof/quote.txt', evidence: ['synthetic-evidence'] },
  ];
  const f7Batch = { ...structuredClone(fixture), candidates: [f7Cand] };
  const f7Html = renderReport(scoreBatch(f7Batch, profile), f7Batch);
  assert.equal(f7Html.includes('SurnameProof'), false, 'spaced username must be fully redacted');
  assert.equal(f7Html.includes('AUDIT_NAME'), false, 'primary scenario label path must be fully redacted');

  // Non-blocking Notes: direct scoreCandidate(c, p, { isOperatingPeriod: true }) CANNOT forge internal period bypass!
  const fNoteFlat = structuredClone(fixture.candidates[0]);
  fNoteFlat.economics.operating_months = [2, 3, 4, 5, 6, 7, 8, 9];
  for (const sc of fNoteFlat.economics.scenarios) {
    sc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
    sc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  }
  const forgedRes = scoreCandidate(fNoteFlat, profile, { isOperatingPeriod: true });
  assert.equal(forgedRes.queue, 'pending');
  assert.equal(forgedRes.qualification?.counts_toward_target, false);

  // Non-blocking Notes: returns_processing $0.1425591 recomputed to exact $0.14256 in economics.mjs; Gate 1A -$4e-11 cap fails; same-layer duplicate stress ID deduplicated!
  const retRecompLedger = mkSkuLedger({ unitPrice: 40, procUsd: 40 / 7.2 });
  retRecompLedger.physical_return_fraction = 0.12;
  Object.assign(retRecompLedger.lines.find(l => l.id === 'returns_processing'), {
    amount_usd: 0.1425591, status: 'estimated', components: ['returns_processing'],
    return_threshold: 0.087, per_return_fee_usd: 4.32,
  });
  const retRecompOut = calculateEconomics(retRecompLedger, opts58);
  assert.equal(retRecompOut.scoring_supported, true);
  assert.equal(retRecompOut.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256, 'cached $0.1425591 must recompute to exact $0.14256');

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
  const tinyNegCap = estimateGate1A2027({ ...tinyNegBase, headhaul_usd: exactZeroHh + 4e-11 });
  assert.equal(tinyNegCap.zero_browser_fail, true, 'true -$4e-11 landed cap must not round to 0');

  // Same-layer duplicate stress ID deduplicated
  const dupStressCard = makeSeasonalCandidate('f-note-dup-stress');
  dupStressCard.economics.operating_periods[0].stress_scenarios = [
    { id: 'dup-st', label: 'First', price_usd: 35, margin: 0.22 },
    { id: 'dup-st', label: 'Duplicate', price_usd: 35, margin: 0.22 },
  ];
  const dupStressRes = scoreCandidate(dupStressCard, profile);
  assert.equal(dupStressRes.operating_periods.find(p => p.id === 'off_peak').diagnostics.economics.stress_scenarios.length, 1);
});

test('Round-3 Codex Findings 1–8 & Notes: dual sku_lines conflict & exact rational procurement, peak completeness & 2028 off-peak, sensitivity_only report hiding, Q31 comparability/SIF/duplicate-identity guards, oversize/return-threshold parity, Gate1A/early-screen date & pkg alignment, apostrophe/UNC redaction, and flat stress dedup', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const opts58 = { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };

  const mkLedgerR3 = ({ unitPriceCny = 125, procUsd = 125 / 7.2, fx = 7.2, extraRootSkuLines = undefined, priceUsd = 40 } = {}) => ({
    id: 'r3-sc', saleable_unit: '1 unit', price_usd: priceUsd, refund_fraction: 0.05, physical_return_fraction: 0.05,
    assumptions: ['R3 probe'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005,
    source_inputs: { fx_cny_per_usd: fx },
    ...(extraRootSkuLines ? { sku_lines: extraRootSkuLines } : {}),
    fee_context: validFeeCtx,
    packages: [{ id: 'pack-1', length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, evidence: ['src'] }],
    lines: [
      {
        id: 'procurement', amount_usd: procUsd, status: 'estimated', basis: '1688', evidence: ['src'], components: ['procurement'],
        order_units: 144, first_order_promotion: false,
        sku_lines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, ordered_qty: 144, unit_price_cny: unitPriceCny, regular_goods_promo_false: true }],
      },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Dom', evidence: ['src'], components: ['domestic_freight'], order_units: 144, first_order_promotion: false },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 5.76, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_through: null } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: { ...validBasis, package_ref: 'pack-1' } },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_through: null } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'Below threshold', evidence: ['src'], return_threshold: 0.087, fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-02-01', effective_through: null } },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.12, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-01-01', effective_through: null } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
    ],
  });

  // R3-1(a): Dual conflicting sku_lines (cost_ledger.sku_lines ¥0.072 vs procurement.sku_lines ¥125) rejected across fee-basis & economics!
  const dualSku = mkLedgerR3({
    unitPriceCny: 125, procUsd: 0.01, fx: 7.2,
    extraRootSkuLines: [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, ordered_qty: 144, unit_price_cny: 0.072, regular_goods_promo_false: true }],
  });
  assert.equal(validateFeeBasis(dualSku, opts58).status, 'needs_evidence', 'dual conflicting sku_lines must fail fee validation');
  assert.equal(calculateEconomics(dualSku, opts58).scoring_supported, false, 'dual conflicting sku_lines must fail economics');

  // R3-1(b): Exact rational procurement precision — true cost $4.44e-11 over 30% ceiling CANNOT pass via 10-decimal rounding!
  // Let price=40, refund=0 (netRev=40, 70% cap=28), collection_rate=0, referral_fraction=0.15 (ref=6), all other fixed costs = 12 (total non-proc = 18 -> exact proc cap = 10 USD).
  // With fx = 9, unit_price_cny = 90 + 4e-10 (exact proc = 10 + 4.444...e-11 USD, rounds at 10 decimals to 10.0000000000!):
  const ratCand = structuredClone(fixture.candidates[0]);
  ratCand.id = 'r3-exact-rat';
  const rSc = ratCand.economics.scenarios[0];
  rSc.cost_ledger.price_usd = 40;
  rSc.cost_ledger.refund_fraction = 0;
  rSc.cost_ledger.physical_return_fraction = 0;
  rSc.cost_ledger.collection_rate = 0;
  rSc.cost_ledger.source_inputs = { fx_cny_per_usd: 9 };
  rSc.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = 1;
  rSc.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = 1;
  rSc.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = 9;
  rSc.cost_ledger.lines.find(l => l.id === 'placement').amount_usd = 0.5;
  rSc.cost_ledger.lines.find(l => l.id === 'storage').amount_usd = 0.5;
  rSc.cost_ledger.lines.find(l => l.id === 'returns_processing').amount_usd = 0;
  rSc.cost_ledger.lines.find(l => l.id === 'other_applicable').amount_usd = 0;
  const rProc = rSc.cost_ledger.lines.find(l => l.id === 'procurement');
  rProc.order_units = 100;
  rSc.cost_ledger.lines.find(l => l.id === 'domestic_freight').order_units = 100;
  rProc.amount_usd = 10;
  // Exact 90.0000000004 / 9 = 10 + 4/9 * 1e-10 > 10 (rounds down to 10.0000000000 at 10 decimals!)
  rProc.sku_lines = [{ sku_id: 'EX', qty_per_saleable_set: 1, pack_multiple: 100, moq_qty: 100, ordered_qty: 100, unit_price_cny: 90.0000000004, regular_goods_promo_false: true }];
  const ratRes = scoreBatch({ ...structuredClone(fixture), candidates: [ratCand] }, profile);
  assert.equal(ratRes.summary.qualifying, 0, 'exact rational procurement $4.44e-11 above 30% cap must NOT qualify');
  assert.equal(ratRes.candidates[0].queue, 'excluded', 'exact rational over-cap must route to excluded');
  // Verify exact 90 / 9 = 10.0 DOES pass
  rProc.sku_lines[0].unit_price_cny = 90;
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [ratCand] }, profile).summary.qualifying, 1, 'exact 30% rational boundary passes');

  // R3-2(a): Peak empty lines: [] MUST NOT qualify!
  const peakEmpty = makeSeasonalCandidate('r3-peak-empty');
  peakEmpty.economics.operating_periods[1].scenarios[0].cost_ledger.lines = [];
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakEmpty] }, profile).summary.qualifying, 0);

  // R3-2(b): Peak all 12 lines with wrong fee_basis.package_ref MUST NOT qualify!
  const peakWrongPkg = makeSeasonalCandidate('r3-peak-wrong-pkg');
  for (const l of peakWrongPkg.economics.operating_periods[1].scenarios[0].cost_ledger.lines) {
    if (l.fee_basis) l.fee_basis.package_ref = 'wrong-pkg-ref';
  }
  assert.equal(scoreBatch({ ...structuredClone(fixture), candidates: [peakWrongPkg] }, profile).summary.qualifying, 0);

  // R3-2(c): Off-peak shifted to 2028 MUST stay pending BOTH outer AND inner!
  const off2028 = makeSeasonalCandidate('r3-off-2028', { offPeakFrom: '2028-02-01', offPeakThrough: '2028-09-30' });
  const offSc2028 = off2028.economics.operating_periods[0].scenarios[0];
  offSc2028.cost_ledger.fee_context.inbound = { from: '2028-01-15', through: '2028-01-15' };
  for (const l of offSc2028.cost_ledger.lines.filter(x => x.fee_basis)) {
    l.fee_basis.effective_from = '2028-01-15';
    l.fee_basis.effective_through = l.id === 'fulfillment' ? '2028-10-14' : '2028-12-31';
  }
  const off2028Res = scoreBatch({ ...structuredClone(fixture), candidates: [off2028] }, profile);
  assert.equal(off2028Res.summary.qualifying, 0);
  const innerOff2028 = off2028Res.candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(innerOff2028.queue, 'pending', '2028 off-peak inner period must itself be pending');
  assert.equal(innerOff2028.total, null);

  // R3-3: sensitivity_only: true on unanchored $59.99 MUST NOT overwrite report headline price or green 55.35%!
  const sensHigh = structuredClone(fixture.candidates[0]);
  sensHigh.id = 'r3-sens-high';
  sensHigh.screening.reference_price_usd.value = 29.99;
  sensHigh.economics.scenarios[0].cost_ledger.price_usd = 59.99;
  sensHigh.economics.scenarios[0].cost_ledger.sensitivity_only = true;
  sensHigh.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  const sensBatch = { ...structuredClone(fixture), candidates: [sensHigh] };
  const sensRes = scoreBatch(sensBatch, profile);
  assert.equal(sensRes.summary.qualifying, 0);
  assert.equal(sensRes.candidates[0].queue, 'pending');
  const sensHtmlBody = renderReport(sensRes, sensBatch).split('<body>')[1];
  assert.doesNotMatch(sensHtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);
  assert.match(sensHtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 29\.99/);
  assert.doesNotMatch(sensHtmlBody, /ink-pass[^>]*>(?:<strong>)?55\.35%/);

  // R3-4: comparability_verdict:'comparable' passes; omitted verdict stays pending; timePieceValue:'7' & keyword-count-distribution-only natural evidence stay needs_evidence!
  const cComp = structuredClone(fixture.candidates[0]);
  cComp.id = 'r3-comp-ok';
  assert.equal(scoreCandidate(cComp, profile).queue, 'comparable', 'documented comparability_verdict:"comparable" must pass');

  const cOmitMem = structuredClone(fixture.candidates[0]);
  delete cOmitMem.newcomer_cohort.members[0].comparability_verdict;
  assert.equal(scoreCandidate(cOmitMem, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence', 'omitted member comparability_verdict must stay needs_evidence');

  const cOmitRef = structuredClone(fixture.candidates[0]);
  delete cOmitRef.newcomer_cohort.market_reference.families[0].comparability_verdict;
  assert.equal(scoreCandidate(cOmitRef, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence', 'omitted reference comparability_verdict must stay needs_evidence');

  const cTp7 = structuredClone(fixture.candidates[0]);
  cTp7.newcomer_cohort.members[0].natural.timePieceValue = '7';
  assert.equal(scoreCandidate(cTp7, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence', 'timePieceValue:"7" must stay needs_evidence even with 30-day label');

  const cKwDistOnly = structuredClone(fixture.candidates[0]);
  cKwDistOnly.evidence.push({ id: 'sif-kw-dist', source: 'SIF ops_get_listing_keyword_distribution 关键词数量分布', observed_at: '2026-11-13' });
  cKwDistOnly.newcomer_cohort.members[0].natural.evidence = ['sif-kw-dist'];
  assert.equal(scoreCandidate(cKwDistOnly, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence', 'SIF keyword-count-distribution-only evidence must stay needs_evidence');

  // R3-5(a): 12d zero-sale old-review duplicated with 35-sale unmarked row stays pending in BOTH orders!
  const bm = structuredClone(fixture.candidates[0].newcomer_cohort.members[0]);
  for (const rev of [false, true]) {
    const cDupEx = structuredClone(fixture.candidates[0]);
    const six = [100, 90, 80, 60, 40, 30].map((u, i) => ({
      ...structuredClone(bm), family_id: `r3p${i}`, asin: `SYN-R3P${i}`, comparability_verdict: 'comparable',
      ratings: obs(10, 'count'), units_30d: obs(u, 'units'), status: i === 3 ? 'unsampled_stratified' : 'qualified',
    }));
    const oldExcl = { ...structuredClone(bm), family_id: 'r3-dup-ex', asin: 'SYN-DUP-EX', comparability_verdict: 'comparable', launch_date: '2026-11-01', status: 'excluded', old_reviews_predate_launch: true, ratings: obs(5, 'count'), units_30d: obs(0, 'units') };
    const unmarked35 = { ...structuredClone(bm), family_id: 'r3-dup-ex', asin: 'SYN-DUP-EX', comparability_verdict: 'comparable', launch_date: '2026-10-01', status: 'qualified', ratings: obs(5, 'count'), units_30d: obs(35, 'units') };
    cDupEx.newcomer_cohort.members = rev ? [...six, unmarked35, oldExcl] : [...six, oldExcl, unmarked35];
    assert.equal(scoreCandidate(cDupEx, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence', 'conflicting old-review duplicate must not expand pool to 7');
  }

  // R3-5(b): Duplicate ASIN across market_reference.families rejected!
  const cDupRefAsin = structuredClone(fixture.candidates[0]);
  cDupRefAsin.newcomer_cohort.market_reference.families = [
    { family_id: 'rf1', asin: 'SAME-REF-ASIN', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'rf2', asin: 'SAME-REF-ASIN', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'rf3', asin: 'OTHER-ASIN-1', comparability_verdict: 'comparable', units_30d: obs(100, 'units') },
    { family_id: 'rf4', asin: 'OTHER-ASIN-2', comparability_verdict: 'comparable', units_30d: obs(100, 'units') },
  ];
  assert.equal(scoreCandidate(cDupRefAsin, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence', 'duplicate ASIN across market_reference.families must be rejected');

  // R3-6(a): Fake is_oversize: true on Standard-size 0.05 ft³ package rejected in BOTH early-screen and formal ledger!
  const q4Ctx = { ...validFeeCtx, sales: { from: '2027-10-01', through: '2027-12-31' }, storage: { from: '2027-10-01', through: '2027-12-31' } };
  const fakeOverLedger = mkLedgerR3({ unitPriceCny: 40, procUsd: 40 / 7.2 });
  fakeOverLedger.fee_context = q4Ctx;
  fakeOverLedger.lines.find(l => l.id === 'fulfillment').fee_basis = { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31' };
  Object.assign(fakeOverLedger.lines.find(l => l.id === 'storage'), {
    amount_usd: 0.0585, is_oversize: true,
    fee_basis: { ...validBasis, package_ref: 'pack-1', effective_from: '2027-10-01', effective_through: '2027-12-31', months: [10, 11, 12] },
  });
  assert.equal(calculateEconomics(fakeOverLedger, { ...opts58, operatingMonths: [10, 11, 12] }).scoring_supported, false, 'fake is_oversize:true on Standard-size package must fail formal ledger');

  assert.equal(evaluateEarlyScreen({
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'peak', fee_context: q4Ctx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.5 },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45, is_oversize: true },
    specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending', 'fake is_oversize:true on Standard-size package must fail early-screen');

  // R3-6(b): Verified category Tools and Home Improvement CANNOT override threshold to 0.99 across all 3 modules!
  const fakeThreshLedger = mkLedgerR3({ unitPriceCny: 40, procUsd: 40 / 7.2 });
  fakeThreshLedger.fee_category = 'Tools and Home Improvement';
  fakeThreshLedger.physical_return_fraction = 0.12;
  fakeThreshLedger.refund_fraction = 0.12;
  Object.assign(fakeThreshLedger.lines.find(l => l.id === 'returns_processing'), { amount_usd: 0, status: 'not_applicable', return_threshold: 0.99 });
  assert.equal(validateFeeBasis(fakeThreshLedger, opts58).status, 'needs_evidence', 'fee-basis must reject 0.99 threshold override on Tools and Home Improvement');
  assert.equal(calculateEconomics(fakeThreshLedger, opts58).scoring_supported, false, 'economics must reject 0.99 threshold override on Tools and Home Improvement');
  assert.equal(evaluateEarlyScreen({
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    fee_category: 'Tools and Home Improvement',
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.12, physical_return_fraction: 0.12, return_threshold: 0.99, returns_processing_usd: 0,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending', 'early-screen must reject 0.99 threshold override on Tools and Home Improvement');

  // R3-7(a): Gate 1A 2027-01-15..2027-01-31 sales_window must NOT apply Feb-1 2027 return fee!
  assert.equal(estimateGate1A2027({
    price_usd: 29.99, refund_fraction: 0.12, physical_return_fraction: 0.12,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fee_category: 'Tools and Home Improvement',
    pkg: { length_in: 10, width_in: 7, height_in: 3, unit_weight_lb: 1.5 },
    headhaul_usd: 1.5, fx_cny_per_usd: 7.2, collection_rate: 0.005,
    sales_window: { from: '2027-01-15', through: '2027-01-31' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  }).status, 'needs_calculator_verification', 'Jan 2027 sales cannot apply Feb-1 2027 return processing fee');

  // R3-7(b): early-screen wrong package_ref on fulfillment_fee_basis rejected (while matching package_ref passes)!
  const r3PkgBase = {
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92,
    placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  };
  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, fulfillment_fee_basis: { ...validBasis, package_ref: 'wrong-pack' },
  }).gate_status, 'pending', 'early-screen must reject mismatched fulfillment_fee_basis.package_ref');
  assert.equal(evaluateEarlyScreen({
    ...r3PkgBase, fulfillment_fee_basis: { ...validBasis, package_ref: 'pack-1' },
  }).gate_status, 'pass', 'matching fulfillment_fee_basis.package_ref passes');

  // R3-7(c): early-screen supplying threshold & per_return ONLY in returns_processing_fee_basis forwards cleanly to calculateEconomics!
  const r3Handoff = evaluateEarlyScreen({
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.12, physical_return_fraction: 0.12,
    returns_processing_fee_basis: { ...validBasis, package_ref: 'pack-1', fee_category: 'Tools and Home Improvement', return_threshold: 0.087, per_return_fee_usd: 4.32, effective_from: '2027-02-01', effective_through: null },
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  });
  assert.equal(r3Handoff.gate_status, 'pass', 'valid returns_processing_fee_basis params must forward cleanly to calculateEconomics');
  assert.equal(r3Handoff.ledger.lines.find(l => l.id === 'returns_processing').amount_usd, 0.14256);

  // R3-8: Apostrophe username C:/Users/Audit O'ApostropheProof/quote.txt & extended UNC \\?\UNC\fileserver\share\Users\Audit O'ApostropheProof\quote.txt redacted!
  const r3Path = structuredClone(fixture.candidates[0]);
  r3Path.id = 'r3-path-apos-unc';
  r3Path.economics.scenarios[0].label = "Main C:/Users/Audit O'ApostropheProof/quote.txt <script>x</script>";
  r3Path.economics.stress_scenarios = [
    { id: 'st-apos', label: "Stress \\\\?\\UNC\\fileserver\\share\\Users\\Audit O'ApostropheProof\\quote.txt", price_usd: 35, margin: 0.25, assumptions: ["Note C:/Users/Audit O'ApostropheProof/quote.txt", "UNC \\\\?\\UNC\\fileserver\\c$\\Users\\Audit O'ApostropheProof\\quote.txt"] },
    { id: 'st-apos', label: 'Duplicate flat stress ID must dedup', price_usd: 35, margin: 0.25, assumptions: ['dup'] },
  ];
  r3Path.economics.expected_primary_scenarios = [
    { id: r3Path.economics.scenarios[0].id, status: 'active' },
    { id: 'c-apos', status: 'cancelled', reason: "Per \\\\?\\UNC\\fileserver\\share\\Users\\Audit O'ApostropheProof\\quote.txt", evidence: ['synthetic-evidence'] },
  ];
  const r3PathBatch = { ...structuredClone(fixture), candidates: [r3Path] };
  const r3PathRes = scoreBatch(r3PathBatch, profile);
  assert.equal(r3PathRes.candidates[0].diagnostics.economics.stress_scenarios.length, 1, 'flat annual duplicate stress_scenarios ID must deduplicate to 1');
  const r3PathHtml = renderReport(r3PathRes, r3PathBatch);
  assert.equal(r3PathHtml.includes('ApostropheProof'), false, 'apostrophe username must be 0 occurrences in HTML');
  assert.equal(r3PathHtml.includes('fileserver'), false, 'extended UNC server name must be 0 occurrences in HTML');
  assert.equal(r3PathHtml.includes('<script>x</script>'), false, 'HTML tags must remain escaped');
});

test('Round-4 Codex Findings 1–11 & Note: untrusted exact_usd_rational stripping, early-screen nested sku_lines & deep SKU field equality, peak fulfillment fee_basis strictness, sensitivity_only+price_anchor hiding, deep Q31 window/tool/comparability/identity/cross-table guards, DG/package storage & verified per-return/exact-threshold parity, Jan returns & package_ref enforcement, full presentation/apostrophe-space/UNC-file-URI sanitization, and permutation-invariant stress dedup', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const opts58 = { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };
  const fresh = () => structuredClone(fixture.candidates[0]);
  const single = c => ({ ...structuredClone(fixture), candidates: [c] });
  const score = c => scoreBatch(single(c), profile);

  // R4-01: Untrusted exact_usd_rational on headhaul ($200 -> -445% margin) CANNOT pass 30% OR crash with SyntaxError!
  const c1 = fresh();
  const h1 = c1.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul');
  h1.amount_usd = 200;
  h1.exact_usd_rational = { num: '0', den: '1' };
  const r1 = score(c1);
  assert.equal(r1.summary.qualifying, 0, 'untrusted exact_usd_rational:{0/1} on $200 headhaul must NOT qualify');
  assert.equal(r1.candidates[0].queue, 'excluded');
  h1.exact_usd_rational = { num: 'junk', den: '1' };
  assert.equal(score(c1).summary.qualifying, 0, 'malformed exact_usd_rational must NOT throw SyntaxError');

  // R4-02: Early-screen nested source_inputs.sku_lines conflict & formal deep SKU field conflict (offer_id / quote_unit)!
  const earlyBase = {
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 144, first_order_promotion: false,
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087, per_return_fee_usd: 4.32,
    procurement_usd: 5.5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, collection_rate: 0.005, other_applicable_usd: 0,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    specific_rights_conflict: false, strong_date_dependency: false,
  };
  const mkSku = (price, extra = {}) => [{ sku_id: 'A', qty_per_saleable_set: 1, pack_multiple: 24, moq_qty: 125, ordered_qty: 144, unit_price_cny: price, regular_goods_promo_false: true, ...extra }];
  assert.equal(evaluateEarlyScreen({
    ...earlyBase, sku_lines: mkSku(0.072), source_inputs: { sku_lines: mkSku(125) }, procurement_usd: 0.01,
  }).gate_status, 'pending', 'early-screen must reject conflicting source_inputs.sku_lines');
  const dupMetaLedger = {
    id: 'r4-meta', saleable_unit: '1 unit', price_usd: 40, refund_fraction: 0.05, physical_return_fraction: 0.05,
    assumptions: ['R4-02'], referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005, source_inputs: { fx_cny_per_usd: 7.2 }, fee_context: validFeeCtx,
    packages: [{ id: 'pack-1', length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, evidence: ['src'] }],
    sku_lines: mkSku(40, { offer_id: 'offer-A', quote_unit: 'piece' }),
    lines: [
      { id: 'procurement', amount_usd: 40 / 7.2, status: 'estimated', basis: '1688', evidence: ['src'], components: ['procurement'], order_units: 144, first_order_promotion: false, sku_lines: mkSku(40, { offer_id: 'offer-B', quote_unit: 'box_24' }) },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Dom', evidence: ['src'], components: ['domestic_freight'], order_units: 144, first_order_promotion: false },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 5.76, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { ...validBasis, effective_through: null } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: validBasis },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { ...validBasis, effective_through: null } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { id: 'returns_processing', amount_usd: 0, status: 'not_applicable', basis: 'Below', evidence: ['src'], return_threshold: 0.087, fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null } },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.12, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { ...validBasis, effective_from: '2027-01-01', effective_through: null } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
    ],
  };
  assert.equal(validateFeeBasis(dupMetaLedger, opts58).status, 'needs_evidence', 'conflicting offer_id/quote_unit across sku_lines copies must fail validation');

  // R4-03: Companion peak panel rejects unpublished wrong package_ref, coherent:false, sensitivity_only:true, omitted fee_basis, and typo status!
  for (const [tag, mutate] of [
    ['unpub_wrong_pkg', p => { p.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.package_ref = 'wrong'; }],
    ['coherent_false', p => { p.coherent = false; }],
    ['sensitivity_only', p => { p.cost_ledger.sensitivity_only = true; }],
    ['missing_basis', p => { delete p.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis; }],
    ['typo_status', p => { p.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.status = 'publsihed'; }],
  ]) {
    const c3 = makeSeasonalCandidate(`r4-peak-${tag}`);
    mutate(c3.economics.operating_periods[1].scenarios[0]);
    assert.equal(score(c3).summary.qualifying, 0, `peak mutation ${tag} must NOT qualify`);
  }

  // R4-04: sensitivity_only + price_anchor AND pending_costs + price_anchor NEVER overwrite report headline or show green 55.35%!
  const c4 = fresh();
  c4.screening.reference_price_usd.value = 29.99;
  const s4 = c4.economics.scenarios[0];
  Object.assign(s4.cost_ledger, { price_usd: 59.99, sensitivity_only: true });
  s4.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  s4.price_anchor = { ...c4.screening.reference_price_usd, value: 59.99 };
  const b4 = single(c4);
  const res4 = scoreBatch(b4, profile);
  assert.equal(res4.summary.qualifying, 0);
  const html4 = renderReport(res4, b4).split('<body>')[1];
  assert.doesNotMatch(html4, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);
  assert.doesNotMatch(html4, /ink-pass[^>]*>(?:<strong>)?55\.35%/);
  assert.doesNotMatch(html4, /alloc-strip/);
  // Also with fulfillment unavailable (pending_costs):
  const c4p = structuredClone(c4);
  delete c4p.economics.scenarios[0].cost_ledger.sensitivity_only;
  c4p.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = { status: 'unavailable' };
  const b4p = single(c4p);
  const html4p = renderReport(scoreBatch(b4p, profile), b4p).split('<body>')[1];
  assert.doesNotMatch(html4p, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);

  // R4-05: natural.tool cannot override keyword_distribution evidence; nested request.params.timePieceValue:'7' & units_30d.window_days:7 blocked!
  const c5a = fresh();
  c5a.evidence.push({ id: 'kw-ev', source: 'SIF ops_get_listing_keyword_distribution', observed_at: '2026-11-13' });
  Object.assign(c5a.newcomer_cohort.members[0].natural, { evidence: ['kw-ev'], tool: 'ops_get_listing_traffic_overview' });
  assert.equal(score(c5a).summary.qualifying, 0, 'self-declared natural.tool cannot override keyword-distribution-only cited evidence');

  const c5b = fresh();
  c5b.evidence.push({ id: 'nest7', source: 'SIF traffic_overview', observed_at: '2026-11-13', request: { params: { timePieceValue: '7' } } });
  c5b.newcomer_cohort.members[0].natural.evidence = ['nest7'];
  assert.equal(score(c5b).summary.qualifying, 0, 'deeply nested request.params.timePieceValue:"7" must be rejected');

  const c5c = fresh();
  c5c.newcomer_cohort.members[0].units_30d.window_days = 7;
  assert.equal(score(c5c).summary.qualifying, 0, 'member units_30d.window_days:7 must be rejected');
  const c5d = fresh();
  c5d.newcomer_cohort.market_reference.families[0].units_30d.window_days = 7;
  assert.equal(score(c5d).summary.qualifying, 0, 'reference units_30d.window_days:7 must be rejected');

  // R4-06: Mixed active + (excluded_different_task + old_reviews_predate_launch) OR pending-comparability old-review NEVER expands pool to 7!
  const bm = structuredClone(fresh().newcomer_cohort.members[0]);
  const sixBase = [100, 90, 80, 60, 40, 30].map((v, i) => ({
    ...structuredClone(bm), asin: `R4S${i}`, family_id: `R4F${i}`, comparability_verdict: 'comparable',
    ratings: obs(10, 'count'), units_30d: obs(v, 'units'), status: i === 3 ? 'unsampled_stratified' : 'qualified',
  }));
  const act35 = { ...structuredClone(bm), asin: 'R4-CONFLICT', family_id: 'R4-FC', comparability_verdict: 'comparable', units_30d: obs(35, 'units') };
  const diffOld35 = { ...structuredClone(act35), status: 'excluded', old_reviews_predate_launch: true, comparability_verdict: 'excluded_different_task' };
  const pendOld35 = { ...structuredClone(act35), asin: 'R4-PEND-OLD', family_id: 'R4-FPO', status: 'excluded', old_reviews_predate_launch: true, comparability_verdict: 'pending' };
  for (const extra of [[act35, diffOld35], [diffOld35, act35], [pendOld35]]) {
    const c6 = fresh();
    c6.newcomer_cohort.members = [...structuredClone(sixBase), ...structuredClone(extra)];
    assert.equal(score(c6).summary.qualifying, 0, 'conflicting/pending excluded row must not inflate pool to 7');
  }

  // R4-07: Shared parent_asin merges active newcomers; trimmed family_id detects duplicates; cross-table units_30d conflict rejected!
  const c7a = fresh();
  c7a.newcomer_cohort.members[0].parent_asin = 'SHARED-PARENT-1';
  c7a.newcomer_cohort.members = [c7a.newcomer_cohort.members[0]];
  const loneTotal = score(c7a).candidates[0].total;
  c7a.newcomer_cohort.members.push({ ...structuredClone(c7a.newcomer_cohort.members[0]), family_id: 'other-fam', asin: 'other-child' });
  assert.equal(score(c7a).candidates[0].total, loneTotal, 'two child ASINs with same parent_asin must merge and keep lone-newcomer score');

  const c7b = fresh();
  c7b.newcomer_cohort.market_reference.families = [
    { family_id: 'a', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: ' a', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'a ', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'b', comparability_verdict: 'comparable', units_30d: obs(100, 'units') },
  ];
  assert.equal(score(c7b).summary.qualifying, 0, 'whitespace-padded duplicate reference family_id must be rejected');

  const c7c = fresh();
  c7c.newcomer_cohort.market_reference.families.push({
    family_id: c7c.newcomer_cohort.members[0].family_id, comparability_verdict: 'comparable', units_30d: obs(0, 'units'),
  });
  assert.equal(score(c7c).summary.qualifying, 0, 'cross-table units_30d contradiction between members and market_reference must be rejected');

  // R4-08: is_dangerous_goods: true or 'false' NEVER bypasses storage floor downward; early-screen pkgCuft mismatch & unmatched packages[] rejected!
  assert.equal(evaluateEarlyScreen({
    ...earlyBase, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.01, average_inventory_days: 45, is_dangerous_goods: 'false' },
  }).gate_status, 'pending', 'string "false" is_dangerous_goods must be rejected');
  assert.equal(evaluateEarlyScreen({
    ...earlyBase, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45, is_dangerous_goods: true },
  }).gate_status, 'pending', 'DG storage must meet >=$0.99 off-peak floor, never lower');
  assert.equal(evaluateEarlyScreen({
    ...earlyBase, pkg: { length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75 },
    storage: { cubic_feet_per_unit: 0.00005, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
  }).gate_status, 'pending', 'storage cubic_feet_per_unit contradicting pkg dimensions must be rejected');
  const dgLedger = structuredClone(dupMetaLedger);
  delete dgLedger.sku_lines;
  delete dgLedger.lines[0].sku_lines;
  Object.assign(dgLedger.lines.find(l => l.id === 'storage'), { amount_usd: 0.00075, is_dangerous_goods: true });
  assert.equal(validateFeeBasis(dgLedger, opts58).status, 'needs_evidence', 'formal ledger DG cannot bypass storage floor downward');
  const unmatchPkgLedger = structuredClone(dgLedger);
  Object.assign(unmatchPkgLedger.lines.find(l => l.id === 'storage'), { amount_usd: 0.00075, is_dangerous_goods: false });
  unmatchPkgLedger.packages[0].id = 'different-pack';
  assert.equal(validateFeeBasis(unmatchPkgLedger, opts58).status, 'needs_evidence', 'unmatched packages[] entry must fail storage check');

  // R4-09: Fake $0.01 per_return_fee_usd on verified 2027 Standard-size package AND 0.0870000005 micro-threshold override rejected!
  const fakePerRet = structuredClone(dupMetaLedger);
  delete fakePerRet.sku_lines;
  delete fakePerRet.lines[0].sku_lines;
  fakePerRet.fee_category = 'Tools and Home Improvement';
  fakePerRet.physical_return_fraction = 0.12;
  Object.assign(fakePerRet.lines.find(l => l.id === 'returns_processing'), {
    status: 'estimated', components: ['returns_processing'], return_threshold: 0.087, per_return_fee_usd: 0.01, amount_usd: 0.00033,
  });
  assert.equal(validateFeeBasis(fakePerRet, opts58).status, 'needs_evidence', '$0.01 per_return_fee_usd on 1.75 lb Standard-size must fail fee-basis');
  assert.equal(calculateEconomics(fakePerRet, opts58).scoring_supported, false, '$0.01 per_return_fee_usd must fail economics');
  const microThresh = structuredClone(fakePerRet);
  microThresh.physical_return_fraction = 0.0870000004;
  Object.assign(microThresh.lines.find(l => l.id === 'returns_processing'), {
    status: 'not_applicable', return_threshold: 0.0870000005, per_return_fee_usd: undefined, amount_usd: 0, components: undefined,
  });
  assert.equal(validateFeeBasis(microThresh, opts58).status, 'needs_evidence', '0.0870000005 threshold micro-override must be rejected with zero tolerance');
  assert.equal(calculateEconomics(microThresh, opts58).scoring_supported, false, '0.0870000005 threshold micro-override must fail economics');

  // R4-10: Jan 2027 early-screen omitting returns_processing_fee_basis stays pending; omitting package_ref on fee_basis or fee_context stays pending!
  const janNoRetBasis = {
    ...earlyBase, operating_period: undefined, operating_months: [1],
    fee_context: { ...validFeeCtx, sales: { from: '2027-01-15', through: '2027-01-31' }, storage: { from: '2027-01-15', through: '2027-01-31' } },
    fee_category: 'Tools and Home Improvement', physical_return_fraction: 0.12,
    storage_fee_basis: { ...validBasis, months: [1] },
  };
  assert.equal(evaluateEarlyScreen(janNoRetBasis).gate_status, 'pending', 'Jan 2027 sales omitting returns_processing_fee_basis must stay pending');
  const noPkgRefBasis = { ...validBasis };
  delete noPkgRefBasis.package_ref;
  assert.equal(evaluateEarlyScreen({ ...earlyBase, fulfillment_fee_basis: noPkgRefBasis }).gate_status, 'pending', 'omitting package_ref on fee_basis must stay pending');
  const noCtxPkg = structuredClone(earlyBase);
  delete noCtxPkg.fee_context.package_ref;
  assert.equal(evaluateEarlyScreen(noCtxPkg).gate_status, 'pending', 'omitting fee_context.package_ref must stay pending');

  // R4-11: presentation.summary, apostrophe+space D' AngeloSpaceProof, file:////?/UNC/..., unencoded-space file://, and https://.../home/ preservation!
  const c11 = fresh();
  c11.presentation.summary = "Summary C:/Users/Audit O'ApostropheProof/quote.txt and https://example.com/home/keepme";
  c11.economics.scenarios[0].label = "Main C:\\Users\\D' AngeloSpaceProof\\quote.txt";
  const stHi = structuredClone(c11.economics.scenarios[0]);
  stHi.id = stHi.cost_ledger.id = 's-perm';
  stHi.label = "file:////?/UNC/fileserver/share/Users/D' AngeloSpaceProof/quote.txt";
  stHi.cost_ledger.price_usd = 59.99;
  stHi.assumptions = ["file://fileserver/share/Users/Audit O'ApostropheProof/quote.txt"];
  const stLo = structuredClone(c11.economics.scenarios[0]);
  stLo.id = stLo.cost_ledger.id = 's-perm';
  stLo.label = 'Low price';
  stLo.cost_ledger.price_usd = 29.99;
  stLo.assumptions = ['dup'];
  c11.economics.stress_scenarios = [stHi, stLo];
  const b11 = single(c11);
  const res11 = scoreBatch(b11, profile);
  const html11 = renderReport(res11, b11);
  assert.equal(html11.includes('ApostropheProof'), false, 'presentation.summary & unencoded-space file:// must redact username');
  assert.equal(html11.includes('SpaceProof'), false, "apostrophe+space Windows username D' AngeloSpaceProof must redact");
  assert.equal(html11.includes('fileserver'), false, 'file:////?/UNC/ server name must redact');
  assert.equal(html11.includes('https://example.com/home/keepme'), true, 'legitimate https:// URL containing /home/ must not be mangled');

  // Non-Blocking Note: reversing duplicate flat stress_scenarios yields identical canonical winner ($29.99)!
  const c11Rev = structuredClone(c11);
  c11Rev.economics.stress_scenarios.reverse();
  const res11Rev = scoreBatch(single(c11Rev), profile);
  assert.equal(res11.candidates[0].diagnostics.economics.stress_scenarios[0].price_usd, 29.99);
  assert.equal(res11Rev.candidates[0].diagnostics.economics.stress_scenarios[0].price_usd, 29.99, 'duplicate flat stress_scenarios must be permutation-invariant');
});

test('Round-5 Codex Findings 1–11 & Note: strict rational tolerance & exact headhaul precision, zero-tolerance numeric equality & nested source_inputs guards, strict peak coherent/published/year checks, boolean sensitivity_only, deep nested Q31 tool/alias/subject/comparability/equivalence/cross-table guards, root DG storage/returns & package weight parity, explicit effective_through & backdated 2027 schedule checks, quoted/file-URI/market/object-key/https-param redaction, and key-order-invariant stress tie-break', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const opts58 = { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };
  const fresh = () => structuredClone(fixture.candidates[0]);
  const single = c => ({ ...structuredClone(fixture), candidates: [c] });
  const score = c => scoreBatch(single(c), profile);
  const bodyHtml = c => renderReport(score(c), single(c)).split('<body>')[1];

  // R5-01: direct ledgerMeetsMarginFloor rejects forged exact_usd_rational on headhaul (or off by 4e-8) AND early-screen preserves exact $1.00000000004 headhaul!
  const directLedger = { price_usd: 40, refund_fraction: 0, margin: 0.299999999, lines: [{ id: 'headhaul', amount_usd: 28.00000004, exact_usd_rational: { num: '28', den: '1' } }] };
  assert.equal(ledgerMeetsMarginFloor(directLedger, 0.3), false, 'direct ledgerMeetsMarginFloor must ignore forged exact_usd_rational on headhaul');
  const directProcForge = { price_usd: 40, refund_fraction: 0, margin: 0.299999999, lines: [{ id: 'procurement', amount_usd: 28.00000004, exact_usd_rational: { num: '28', den: '1' } }] };
  assert.equal(ledgerMeetsMarginFloor(directProcForge, 0.3), false, 'procurement exact_usd_rational off by 4e-8 (>5e-11) must be ignored');
  const exactHhEarly = evaluateEarlyScreen({
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 100, first_order_promotion: false,
    refund_fraction: 0, physical_return_fraction: 0, return_threshold: 0.087,
    procurement_usd: 10, domestic_freight_usd: 1, headhaul: { usd_per_unit: 1.00000000004, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 9, placement_usd: 0.9415, storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
  });
  // Total = 10 + 1 + 1.00000000004 + 6 + 9 + 0.9415 + 0.0585 = 28.00000000004 > 28 (70% cap) -> must FAIL!
  assert.equal(exactHhEarly.gate_status, 'fail', 'early-screen must preserve sub-10-decimal headhaul usd_per_unit precision');

  // R5-02: Zero-tolerance numeric consistency (9 vs 8.9999999995 FX rejected) & nested source_inputs promo/sets conflict rejected!
  const fxCand = fresh();
  const fxSc = fxCand.economics.scenarios[0].cost_ledger;
  fxSc.price_usd = 40; fxSc.refund_fraction = 0; fxSc.physical_return_fraction = 0; fxSc.collection_rate = 0;
  fxSc.source_inputs = { fx_cny_per_usd: 8.9999999995 };
  fxSc.lines.find(l => l.id === 'domestic_freight').amount_usd = 1;
  fxSc.lines.find(l => l.id === 'headhaul').amount_usd = 1;
  fxSc.lines.find(l => l.id === 'fulfillment').amount_usd = 9;
  fxSc.lines.find(l => l.id === 'placement').amount_usd = 0.5;
  fxSc.lines.find(l => l.id === 'storage').amount_usd = 0.5;
  fxSc.lines.find(l => l.id === 'returns_processing').amount_usd = 0;
  const fxProc = fxSc.lines.find(l => l.id === 'procurement');
  fxProc.amount_usd = 10; fxProc.fx_cny_per_usd = 9;
  fxProc.sku_lines = [{ sku_id: 'FX', qty_per_saleable_set: 1, pack_multiple: 100, moq_qty: 100, ordered_qty: 100, unit_price_cny: 90, regular_goods_promo_false: true }];
  assert.equal(score(fxCand).summary.qualifying, 0, 'conflicting FX 9 vs 8.9999999995 must be rejected with zero tolerance');
  assert.equal(evaluateEarlyScreen({
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 7.2, order_units: 120, first_order_promotion: false,
    source_inputs: { first_order_promotion: true, complete_saleable_sets: 120 },
    refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.087,
    procurement_usd: 5, domestic_freight_usd: 0.5, headhaul: { usd_per_unit: 1.5, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 5.92, placement_usd: 0.4, storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.005, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
  }).gate_status, 'pending', 'nested source_inputs.first_order_promotion:true must block early-screen');

  // R5-03: Peak missing/non-boolean coherent, published covering peak left pending, 2028 published fee_basis, and string months rejected!
  for (const [tag, mut] of [
    ['missing_coherent', (off, pk) => { delete pk.coherent; }],
    ['string_coherent', (off, pk) => { pk.coherent = 'false'; }],
    ['published_covering_pending', (off, pk) => { const f = structuredClone(off.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis); f.effective_through = '2027-12-31'; pk.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = f; }],
    ['year_2028_basis', (off, pk) => { const f = structuredClone(off.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis); f.effective_from = '2028-01-15'; f.effective_through = '2028-10-14'; pk.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = f; }],
    ['string_months', (off, pk) => { const f = structuredClone(off.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis); f.effective_through = '2027-12-31'; f.months = ['Oct', 'Nov', 'Dec']; pk.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = f; }],
  ]) {
    const c3 = makeSeasonalCandidate(`r5-pk-${tag}`);
    mut(c3.economics.operating_periods[0].scenarios[0], c3.economics.operating_periods[1].scenarios[0]);
    assert.equal(score(c3).summary.qualifying, 0, `peak guard ${tag} must fail`);
  }

  // R5-04: sensitivity_only: 'true' (string) MUST NOT qualify or render green 55.35%!
  const c4s = fresh();
  c4s.screening.reference_price_usd.value = 29.99;
  const s4s = c4s.economics.scenarios[0];
  Object.assign(s4s.cost_ledger, { price_usd: 59.99, sensitivity_only: 'true' });
  s4s.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  s4s.price_anchor = { ...c4s.screening.reference_price_usd, value: 59.99 };
  assert.equal(score(c4s).summary.qualifying, 0, 'string sensitivity_only:"true" must never qualify');
  assert.doesNotMatch(bodyHtml(c4s), /ink-pass[^>]*>(?:<strong>)?55\.35%/);

  // R5-05: nested request.tool kw_dist blocked, aliased timePieceValue:'30'+time_piece_value:'7' blocked, parent_asin subject allowed!
  const c5a = fresh();
  c5a.evidence.push({ id: 'ev-nested-tool', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', request: { tool: 'ops_get_listing_keyword_distribution', params: { timePieceValue: '30', isListingSearch: true } } });
  Object.assign(c5a.newcomer_cohort.members[0].natural, { evidence: ['ev-nested-tool'], tool: 'ops_get_listing_traffic_overview' });
  assert.equal(score(c5a).summary.qualifying, 0, 'nested request.tool keyword_distribution must block even when natural.tool claims overview');

  const c5b = fresh();
  c5b.evidence.push({ id: 'ev-alias', provider: 'sif', source: 'SIF traffic_overview', observed_at: '2026-11-13', request: { timePieceValue: '30', time_piece_value: '7' } });
  c5b.newcomer_cohort.members[0].natural.evidence = ['ev-alias'];
  assert.equal(score(c5b).summary.qualifying, 0, 'conflicting aliased time_piece_value:"7" alongside timePieceValue:"30" must block');

  const c5c = fresh();
  c5c.newcomer_cohort.members[0].parent_asin = 'PARENT-VALID-1';
  c5c.newcomer_cohort.members[0].natural.subject = 'PARENT-VALID-1';
  assert.equal(score(c5c).summary.qualifying, 1, 'valid parent_asin in natural.subject must be accepted');

  // R5-06: old_reviews_predate_launch omitting comparability_verdict stays pending (never silently drops zero-sale family)!
  const c6 = fresh();
  const mBase = structuredClone(c6.newcomer_cohort.members[0]);
  const mkMem = (id, u) => ({ ...structuredClone(mBase), family_id: id, asin: `${id}-a`, ratings: obs(10, 'count'), units_30d: obs(u, 'units') });
  const exOmit = { ...mkMem('c', 0), status: 'excluded', old_reviews_predate_launch: true };
  delete exOmit.comparability_verdict;
  c6.newcomer_cohort.members = [mkMem('a', 100), mkMem('b', 90), mkMem('c', 0), exOmit];
  assert.equal(score(c6).candidates[0].total, null, 'old-review exclusion omitting comparability_verdict must stay pending');

  // R5-07: transitive parent_asin reference dedup, cross-table contradiction even with 0 active newcomers, and trimmed identity sort!
  const c7 = fresh();
  const mkRef = (id, u) => ({ family_id: id, comparability_verdict: 'comparable', units_30d: obs(u, 'units') });
  c7.newcomer_cohort.members = [{ ...mkMem('a', 0), parent_asin: 'P' }, { ...mkMem('b', 0), parent_asin: 'P' }, mkMem('x', 8)];
  c7.newcomer_cohort.market_reference.families = [mkRef('a', 0), mkRef('b', 0), mkRef('x', 8), mkRef('j', 100), mkRef('k', 100)];
  assert.equal(score(c7).candidates[0].total, null, 'reference table aliasing two merged child families must be rejected');

  const c7Zero = fresh();
  c7Zero.newcomer_cohort.members = [{ ...mkMem('o', 0), status: 'excluded', old_reviews_predate_launch: true }];
  c7Zero.newcomer_cohort.market_reference.families = [{ ...mkRef('o', 0), comparability_verdict: 'excluded_different_task', reason: 'syn', evidence: ['synthetic-evidence'] }];
  assert.equal(score(c7Zero).summary.qualifying, 0, 'cross-table comparability contradiction must block even with zero active newcomers');

  // R5-08 & R5-09 & R5-10: root is_dangerous_goods storage floor + DG/pkg conflict + empty packages[]/$0 storage + conflicting weight_lb/unit_weight_lb + duplicate threshold micro-diff + missing effective_through + backdated US-FBA-2027 version!
  const mkR5Ledger = () => ({
    id: 'r5-sc', saleable_unit: '1 unit', price_usd: 40, refund_fraction: 0.05, physical_return_fraction: 0.12,
    fee_category: 'Tools and Home Improvement', assumptions: ['R5'],
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0.005, fee_context: validFeeCtx,
    packages: [{ id: 'pack-1', length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, evidence: ['src'] }],
    lines: [
      { id: 'procurement', amount_usd: 5, status: 'estimated', basis: '1688', evidence: ['src'], components: ['procurement'], order_units: 120, first_order_promotion: false },
      { id: 'domestic_freight', amount_usd: 0.5, status: 'estimated', basis: 'Dom', evidence: ['src'], components: ['domestic_freight'], order_units: 120, first_order_promotion: false },
      { id: 'headhaul', amount_usd: 1.5, status: 'estimated', basis: 'Sea', evidence: ['src'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: 5.76, status: 'estimated', basis: 'Ref', evidence: ['src'], components: ['referral'], fee_basis: { ...validBasis, effective_through: null } },
      { id: 'fulfillment', amount_usd: 5.92, status: 'estimated', basis: 'FBA', evidence: ['src'], components: ['fulfillment'], fee_basis: validBasis },
      { id: 'placement', amount_usd: 0.4, status: 'estimated', basis: 'Place', evidence: ['src'], components: ['placement'], fee_basis: { ...validBasis, effective_through: null } },
      { id: 'storage', amount_usd: 0.0585, status: 'estimated', basis: 'Store', evidence: ['src'], components: ['storage'], fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9] } },
      { id: 'returns_processing', amount_usd: 0.14256, status: 'estimated', basis: 'Ret', evidence: ['src'], components: ['returns_processing'], return_threshold: 0.087, per_return_fee_usd: 4.32, fee_basis: { ...validBasis, version: 'US-FBA-2027-nonpeak-standard-v1', effective_from: '2027-02-01', effective_through: null } },
      { id: 'returns_disposal', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
      { id: 'collection', amount_usd: 0.12, status: 'estimated', basis: 'Payout', evidence: ['src'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'not_applicable', basis: 'None', evidence: ['src'], fee_basis: { ...validBasis, effective_from: '2027-01-01', effective_through: null } },
      { id: 'recovery_credit', amount_usd: null, status: 'deferred', basis: 'Deferred', evidence: ['src'] },
    ],
  });
  assert.equal(validateFeeBasis(mkR5Ledger(), opts58).status, 'validated');

  const rootDgLowStore = mkR5Ledger();
  rootDgLowStore.is_dangerous_goods = true; // requires >= $0.07425 ($0.99/ft³ * 0.05 * 1.5), NOT $0.0585!
  assert.equal(validateFeeBasis(rootDgLowStore, opts58).status, 'needs_evidence', 'root is_dangerous_goods:true must enforce DG storage floor');

  const emptyPkgsZeroStore = mkR5Ledger();
  emptyPkgsZeroStore.packages = [];
  Object.assign(emptyPkgsZeroStore.lines.find(l => l.id === 'storage'), { amount_usd: 0, status: 'not_applicable', components: undefined });
  assert.equal(validateFeeBasis(emptyPkgsZeroStore, opts58).status, 'needs_evidence', 'empty packages:[] and $0 storage must fail validation');

  const dgConflictRet = mkR5Ledger();
  dgConflictRet.packages[0].is_dangerous_goods = false;
  dgConflictRet.is_dangerous_goods = true;
  Object.assign(dgConflictRet.lines.find(l => l.id === 'returns_processing'), { per_return_fee_usd: 0.01, amount_usd: 0.00033 });
  assert.equal(validateFeeBasis(dgConflictRet, opts58).status, 'needs_evidence', 'conflicting root/pkg is_dangerous_goods + $0.01 per-return must fail');

  const dupThresh = mkR5Ledger();
  Object.assign(dupThresh.lines.find(l => l.id === 'returns_processing'), {
    return_threshold: 0.0870000005,
    fee_basis: { ...validBasis, effective_from: '2027-02-01', effective_through: null, return_threshold: 0.087 },
  });
  assert.equal(validateFeeBasis(dupThresh, opts58).status, 'needs_evidence', '0.087 vs 0.0870000005 threshold conflict must fail fee-basis');
  assert.equal(calculateEconomics(dupThresh, opts58).scoring_supported, false, '0.087 vs 0.0870000005 threshold conflict must fail economics');

  assert.equal(classifyStandardSize2027({ length_in: 6, width_in: 4.8, height_in: 3, unit_weight_lb: 1.75, weight_lb: 0.25 }).status, 'needs_calculator_verification', 'conflicting unit_weight_lb vs weight_lb must be rejected');

  const janEarlyBase = {
    profile_revision: 58, saleable_unit: '1 unit', operating_months: [1],
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
  assert.equal(evaluateEarlyScreen({ ...janEarlyBase, returns_processing_fee_basis: missingEndBasis }).gate_status, 'pending', 'omitted effective_through on fee_basis must stay pending');
  assert.equal(evaluateEarlyScreen({
    ...janEarlyBase, per_return_fee_usd: 0.01,
    returns_processing_fee_basis: { ...validBasis, version: 'US-FBA-2027-nonpeak-standard-v1', effective_from: '2027-01-15', effective_through: null },
  }).gate_status, 'pending', 'backdated official US-FBA-2027 returns schedule must stay pending');

  // R5-11: single-quoted D' AngeloProof, standalone file:///home/PosixProof/q.txt, market.average_star_rating.note, object-key path, and https query-param encoded path!
  const c11r5 = fresh();
  c11r5.presentation.summary = "Quoted 'C:\\Users\\D' AngeloProof\\quote.txt' and standalone";
  c11r5.market.average_star_rating = { value: 4.4, note: 'C:/Users/RawProof/q.txt' };
  c11r5.presentation.procurement = [
    { label: 'ObjKey', value: { 'C:/Users/KeyProof/q.txt': 'file:///home/PosixProof/q.txt' }, url: 'https://example.com/?f=C%3A%2FUsers%2FParamProof%2Fq.txt' },
  ];
  const h11r5 = bodyHtml(c11r5);
  for (const tok of ['AngeloProof', 'RawProof', 'KeyProof', 'PosixProof', 'ParamProof']) {
    assert.equal(h11r5.includes(tok), false, `R5-11 leak token ${tok} must be 0 in HTML`);
  }

  // Note: same-price duplicate stress_scenarios with reordered object keys yields identical canonical winner!
  const cNote = fresh();
  const sA = structuredClone(cNote.economics.scenarios[0]);
  sA.id = sA.cost_ledger.id = 'same-price';
  sA.label = 'A';
  sA.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = 1;
  const sB = structuredClone(sA);
  sB.label = 'B';
  sB.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = 3;
  const sBReordered = { assumptions: sB.assumptions, ...sB };
  const winners = [[sA, sB], [sB, sA], [sA, sBReordered]].map(list => {
    const cx = structuredClone(cNote);
    cx.economics.stress_scenarios = list;
    return score(cx).candidates[0].diagnostics.economics.stress_scenarios[0].label;
  });
  assert.deepEqual(winners, ['A', 'A', 'A'], 'same-price duplicate stress tie-break must be invariant to array and JSON key order');
});

test('Round-6 Codex Findings: cross-line DG & duplicate packages[].id, exact 13x6.95x5=3.25 lb dim-weight & strict boolean/weight parity, companion peak 2028-01-14 & official 2027 non-peak window guards, plain excluded comparability & cross-table/trimmed Q31 permutation invariance, SIF omitted timePieceValue & scope override rejection, exact 3-SKU/per-kg/direct-forge/USD-CNY/order_units/priceFloor precision, and quoted-directory & nested image_data_uri HTML redaction', () => {
  const validFeeCtx = {
    marketplace: 'US', currency: 'USD', package_ref: 'pack-1',
    sales: { from: '2027-02-01', through: '2027-09-30' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-01-15' },
  };
  const validBasis = { status: 'published', version: '2027-US', marketplace: 'US', currency: 'USD', package_ref: 'pack-1', effective_from: '2027-01-15', effective_through: '2027-10-14', evidence: ['src'] };
  const opts58 = { profileRevision: 58, requireFeeBasis: true, evidenceIds: ['src'], operatingMonths: [2, 3, 4, 5, 6, 7, 8, 9] };
  const fresh = () => structuredClone(fixture.candidates[0]);
  const single = c => ({ ...structuredClone(fixture), candidates: [c] });
  const score = c => scoreBatch(single(c), profile);
  const bodyHtml = c => renderReport(score(c), single(c)).split('<body>')[1];

  // 1. Cross-line is_dangerous_goods (set ONLY on returns_processing) enforces DG storage floor ($0.99/cuft = $0.07425, NOT $0.0585) AND duplicate packages[].id rejected in BOTH orders!
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
  assert.equal(validateFeeBasis(mkOffPeakLedger(), opts58).status, 'validated');
  const crossDgLowStore = mkOffPeakLedger();
  crossDgLowStore.lines.find(l => l.id === 'returns_processing').is_dangerous_goods = true;
  assert.equal(validateFeeBasis(crossDgLowStore, opts58).status, 'needs_evidence', 'is_dangerous_goods:true on returns_processing alone must reject $0.0585 non-DG storage');
  assert.equal(calculateEconomics(crossDgLowStore, opts58).scoring_supported, false, 'calculateEconomics must reject $0.0585 non-DG storage when returns_processing is DG');
  const crossDgProperStore = structuredClone(crossDgLowStore);
  crossDgProperStore.lines.find(l => l.id === 'storage').amount_usd = 0.07425;
  assert.equal(validateFeeBasis(crossDgProperStore, opts58).status, 'validated', 'proper $0.07425 DG storage passes fee-basis');
  assert.equal(ledgerMeetsMarginFloor(calculateEconomics(crossDgProperStore, opts58), 0.3), false, 'with true DG storage $0.07425, borderline margin drops below 30%');
  // Explicit conflict: returns_processing DG=true vs storage DG=false -> rejected even with $0.07425!
  const crossDgConflict = structuredClone(crossDgProperStore);
  crossDgConflict.lines.find(l => l.id === 'storage').is_dangerous_goods = false;
  assert.equal(validateFeeBasis(crossDgConflict, opts58).status, 'needs_evidence', 'conflicting is_dangerous_goods across returns_processing vs storage must fail');

  // Duplicate packages[].id rejected regardless of array order!
  for (const revPkgs of [false, true]) {
    const dupPkgLedger = mkOffPeakLedger();
    const pkgs = [
      { id: 'pack-1', length_in: 1, width_in: 1, height_in: 1, weight_lb: 0.5, evidence: ['src'] },
      { id: 'pack-1', length_in: 10, width_in: 10, height_in: 5, weight_lb: 5, evidence: ['src'] },
    ];
    dupPkgLedger.packages = revPkgs ? pkgs.reverse() : pkgs;
    dupPkgLedger.lines.find(l => l.id === 'storage').amount_usd = 0.0007;
    assert.equal(validateFeeBasis(dupPkgLedger, opts58).status, 'needs_evidence', `duplicate packages[].id (rev=${revPkgs}) must fail fee-basis`);
    assert.equal(calculateEconomics(dupPkgLedger, opts58).scoring_supported, false, `duplicate packages[].id (rev=${revPkgs}) must fail economics`);
  }

  // 2. Exact dimensional weight 13 x 6.95 x 5 in = 451.75 / 139 = exact 3.25 lb (NOT 3.2500000000000004), strict boolean DG, & exact weight alias parity!
  const dimPkg = { length_in: 13, width_in: 6.95, height_in: 5, weight_lb: 1 };
  const dimCls = classifyStandardSize2027(dimPkg);
  assert.equal(dimCls.status, 'verified');
  assert.equal(dimCls.size_tier, 'large_standard');
  assert.equal(dimCls.shipping_weight_lb, 3.25);
  const dimFul = lookupFulfillmentFee2027({ pkg: dimPkg, price_usd: 40 });
  assert.equal(dimFul.status, 'verified');
  assert.equal(dimFul.extra_quarter_lb_steps, 1, 'exact 3.25 lb dim-weight is 1 quarter-lb step above 3 lb, not 2');
  assert.equal(dimFul.base_usd, 7.24);
  assert.equal(dimFul.total_usd, 7.4934);
  assert.equal(lookupVerified2027PerReturnFee(dimPkg), 5.05, 'exact 3.25 lb dim-weight return fee is $5.05, not $5.10');
  const gate1ADim = estimateGate1A2027({
    pkg: dimPkg, price_usd: 40, fx_cny_per_usd: 7.2, refund_fraction: 0.05, physical_return_fraction: 0.05,
    fee_category: 'Tools and Home Improvement', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    headhaul_usd: 2.5, collection_rate: 0.006, other_applicable_usd: 0,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-01-15' },
  });
  assert.equal(gate1ADim.status, 'verified');
  assert.ok(gate1ADim.landed_domestic_cap_usd > 9.60 && gate1ADim.landed_domestic_cap_usd < 9.65, `exact 3.25 lb Gate-1A landed cap must reflect 1-step $7.4934 fulfillment (~$9.6386), not 2-step $7.5762 (~$9.5563); got ${gate1ADim.landed_domestic_cap_usd}`);

  // Strict boolean checks in classifyStandardSize2027
  assert.equal(classifyStandardSize2027({ length_in: 10, width_in: 7, height_in: 3, weight_lb: 1.5, is_dangerous_goods: 'true' }).status, 'needs_calculator_verification');
  assert.equal(classifyStandardSize2027({ length_in: 10, width_in: 7, height_in: 3, weight_lb: 1.5 }, { is_dangerous_goods: 'true' }).status, 'needs_calculator_verification');
  assert.equal(classifyStandardSize2027({ length_in: 10, width_in: 7, height_in: 3, weight_lb: 1.5 }, { is_apparel: 'false' }).status, 'needs_calculator_verification');

  // Exact weight alias parity: 1.75 vs 1.7500005 rejected; exact 1.75 lb == 28 oz accepted!
  assert.equal(lookupVerified2027PerReturnFee({ length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, unit_weight_lb: 1.7500005 }), null);
  assert.equal(classifyStandardSize2027({ length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, unit_weight_lb: 1.7500005 }).status, 'needs_calculator_verification');
  assert.equal(lookupVerified2027PerReturnFee({ length_in: 6, width_in: 4.8, height_in: 3, weight_lb: 1.75, weight_oz: 28 }), 4.32);

  // 3. Companion peak effective_through:'2028-01-14' accepted; unavailable 2028-only rejected; stretched US-FBA-2027-nonpeak rejected!
  const pkJan14 = makeSeasonalCandidate('r6-peak-2028-01-14');
  const pkFul = pkJan14.economics.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment');
  Object.assign(pkFul, {
    amount_usd: 6.5, status: 'estimated', components: ['fulfillment'],
    fee_basis: { status: 'published', version: '2027-US-Holiday-Peak', marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', effective_from: '2027-10-01', effective_through: '2028-01-14', evidence: ['synthetic-evidence'] },
  });
  assert.equal(score(pkJan14).summary.qualifying, 1, 'valid 2027 holiday peak fulfillment ending 2028-01-14 must qualify');

  const pkUnavail2028 = makeSeasonalCandidate('r6-peak-unavail-2028');
  Object.assign(pkUnavail2028.economics.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis, {
    effective_from: '2028-01-01', effective_through: '2028-12-31',
  });
  assert.equal(score(pkUnavail2028).summary.qualifying, 0, 'unavailable peak basis scoped exclusively to 2028 must be rejected');

  const flatStretched = fresh();
  flatStretched.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.version = 'US-FBA-2027-nonpeak-standard-v1';
  assert.equal(score(flatStretched).summary.qualifying, 0, 'official US-FBA-2027-nonpeak fulfillment basis stretched to full year must be rejected');

  // 4. Plain status:'excluded' omitting comparability_verdict stays pending; zero-active duplicate contradictory ref rows order-invariant; 'b' vs ' b' tie-break order-invariant!
  const cPlainExcl = fresh();
  const mBase = structuredClone(cPlainExcl.newcomer_cohort.members[0]);
  const mkM = (id, u, extra = {}) => ({ ...structuredClone(mBase), family_id: id, asin: `${id}-a`, ratings: obs(10, 'count'), units_30d: obs(u, 'units'), ...extra });
  const plainZero = { ...mkM('z', 0), status: 'excluded' };
  delete plainZero.comparability_verdict;
  cPlainExcl.newcomer_cohort.members = [mkM('a', 100), mkM('b', 90), plainZero];
  assert.equal(score(cPlainExcl).candidates[0].total, null, 'plain status:excluded omitting comparability_verdict must stay pending');

  for (const revRefs of [false, true]) {
    const cDupRef = fresh();
    cDupRef.newcomer_cohort.members = [{ ...mkM('o', 0), status: 'excluded', old_reviews_predate_launch: true, comparability_verdict: 'comparable' }];
    const rfs = [
      { family_id: 'o', comparability_verdict: 'excluded_different_task', reason: 'diff', evidence: ['synthetic-evidence'] },
      { family_id: 'o', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    ];
    cDupRef.newcomer_cohort.market_reference.families = revRefs ? rfs.reverse() : rfs;
    assert.equal(score(cDupRef).summary.qualifying, 0, `zero-active duplicate contradictory ref rows (rev=${revRefs}) must stay pending`);
  }

  const runLeadSpaceSwap = revOrder => {
    const cs = fresh();
    const nat0 = { ...structuredClone(mBase.natural), value: 0 };
    const nat1 = { ...structuredClone(mBase.natural), value: 0.7 };
    const full1 = mkM('f0', 100, { launch_date: '2026-09-20', natural: nat1 });
    const rampA = mkM('a', 100, { launch_date: '2026-10-25', natural: nat0 });
    const rampB1 = mkM('b', 100, { launch_date: '2026-10-25', asin: 'B-SAME', natural: nat1 });
    const rampB2 = mkM(' b', 100, { launch_date: '2026-10-25', asin: 'B-SAME', natural: nat1 });
    cs.newcomer_cohort.members = revOrder ? [full1, rampA, rampB2, rampB1] : [full1, rampA, rampB1, rampB2];
    const r = score(cs).candidates[0];
    return { total: r.total, nat: r.items.find(i => i.id === 'natural_visibility_development').score };
  };
  assert.deepEqual(runLeadSpaceSwap(false), runLeadSpaceSwap(true), 'swapping family b and leading-space alias " b" must produce identical natural and total scores');

  // 5. SIF omitted timePieceValue (defaults to 7d) & evidence.scope overriding structured request.tool rejected; explicit 30d control passes!
  const cOmitTpv = fresh();
  cOmitTpv.evidence.push({ id: 'sif-no-tpv', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', request: { tool: 'ops_get_listing_traffic_overview', country: 'US', timePieceType: 'latelyDay', isListingSearch: true } });
  cOmitTpv.newcomer_cohort.members[0].natural.evidence = ['sif-no-tpv'];
  assert.equal(score(cOmitTpv).summary.qualifying, 0, 'SIF overview request omitting timePieceValue (7-day default) must stay pending');

  const cScopeOvr = fresh();
  cScopeOvr.evidence.push({ id: 'sif-scope-ovr', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', scope: 'traffic_overview note', request: { tool: 'ops_get_listing_keyword_distribution', params: { timePieceValue: '30' } } });
  cScopeOvr.newcomer_cohort.members[0].natural.evidence = ['sif-scope-ovr'];
  assert.equal(score(cScopeOvr).summary.qualifying, 0, 'evidence.scope mentioning traffic_overview cannot override structured keyword_distribution tool');

  const cValidSif30 = fresh();
  cValidSif30.evidence.push({ id: 'sif-ok-30', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', request: { tool: 'ops_get_listing_traffic_overview', params: { country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true } } });
  cValidSif30.newcomer_cohort.members[0].natural.evidence = ['sif-ok-30'];
  assert.equal(score(cValidSif30).summary.qualifying, 1, 'explicit 30-day SIF overview request must pass');

  // 6. 3-SKU order-invariant BigInt rounding, direct ledgerMeetsMarginFloor forge rejection, per-kg headhaul exact precision, USD+CNY conflict, source_inputs.order_units, & strict $29.99 floor!
  const mkSku3 = rev => {
    const prices = [89.99080000045001, 0.0046, 0.0046];
    if (rev) prices.reverse();
    return prices.map((p, i) => ({ sku_id: `SKU-${i}`, qty_per_saleable_set: 1, pack_multiple: 100, moq_qty: 100, ordered_qty: 100, unit_price_cny: p, regular_goods_promo_false: true }));
  };
  const baseEarly = {
    profile_revision: 58, saleable_unit: '1 unit', operating_period: 'off_peak', fee_context: validFeeCtx,
    price_usd: 40, fx_cny_per_usd: 9, order_units: 100, first_order_promotion: false,
    refund_fraction: 0, physical_return_fraction: 0, return_threshold: 0.087,
    domestic_freight_usd: 1, headhaul: { usd_per_unit: 1, bond_included: true },
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    fulfillment_usd: 9, placement_usd: 0.9415, storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
  };
  assert.equal(evaluateEarlyScreen({ ...baseEarly, sku_lines: mkSku3(false) }).gate_status, 'fail', '3-SKU forward over-cap must fail early-screen');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, sku_lines: mkSku3(true) }).gate_status, 'fail', '3-SKU reverse over-cap must fail early-screen');
  for (const revSku of [false, true]) {
    const cSku = fresh();
    const cl = cSku.economics.scenarios[0].cost_ledger;
    cl.price_usd = 40; cl.refund_fraction = 0; cl.physical_return_fraction = 0; cl.collection_rate = 0;
    cl.source_inputs = { fx_cny_per_usd: 9 };
    cl.lines.find(l => l.id === 'domestic_freight').amount_usd = 1;
    cl.lines.find(l => l.id === 'headhaul').amount_usd = 1;
    cl.lines.find(l => l.id === 'fulfillment').amount_usd = 9;
    cl.lines.find(l => l.id === 'placement').amount_usd = 0.5;
    cl.lines.find(l => l.id === 'storage').amount_usd = 0.5;
    cl.lines.find(l => l.id === 'returns_processing').amount_usd = 0;
    const pLine = cl.lines.find(l => l.id === 'procurement');
    pLine.amount_usd = 10; pLine.sku_lines = mkSku3(revSku);
    assert.equal(score(cSku).summary.qualifying, 0, `3-SKU formal scoring (rev=${revSku}) must fail over-cap consistently`);
  }
  assert.equal(ledgerMeetsMarginFloor({
    price_usd: 40, refund_fraction: 0, margin: 0.299999999,
    lines: [{ id: 'procurement', amount_usd: 28.00000000004, exact_usd_rational: { num: '28', den: '1' } }],
  }, 0.3), false, 'direct ledgerMeetsMarginFloor must never trust unverified caller exact_usd_rational');
  assert.equal(evaluateEarlyScreen({
    ...baseEarly, procurement_usd: 10,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 9.00000000036, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0 },
  }).gate_status, 'fail', 'per-kg headhaul equivalent to $1.00000000004 must fail 30% margin');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, fx_cny_per_usd: 10, goods_cny_per_unit: 100.000005, procurement_usd: 10 }).gate_status, 'pending', 'conflicting CNY 100.000005 + USD 10 procurement must stay pending');
  assert.equal(evaluateEarlyScreen({ ...baseEarly, fx_cny_per_usd: 10, procurement_usd: 10, domestic_freight_usd: 1, domestic_freight_cny_per_unit: 10.000005 }).gate_status, 'pending', 'conflicting CNY 10.000005 + USD 1 domestic freight must stay pending');

  const cOrdUnits = fresh();
  cOrdUnits.economics.scenarios[0].cost_ledger.source_inputs = { order_units: 99 };
  assert.equal(score(cOrdUnits).summary.qualifying, 0, 'source_inputs.order_units=99 contradicting lines order_units=100 must fail');

  const cPriceFloor = fresh();
  cPriceFloor.screening.reference_price_usd.value = 29.99;
  cPriceFloor.economics.scenarios[0].cost_ledger.price_usd = 29.9899999995;
  cPriceFloor.economics.scenarios[0].price_anchor = { ...cPriceFloor.screening.reference_price_usd, value: 29.9899999995 };
  assert.equal(score(cPriceFloor).summary.qualifying, 0, 'primary scenario price $29.9899999995 below $29.99 hard floor must not qualify');

  // 7. HTML path redaction: bare single-quoted directory 'C:\Users\D' FolderProbe' (incl. trailing period & encoded HTTPS query param) & nested value.image_data_uri!
  const cHtml = fresh();
  cHtml.presentation.summary = "Evidence 'C:\\Users\\D' FolderProbe' and 'keep' then 'C:\\Users\\D' FolderProbe2'. Also 'C:\\Users\\FolderProbe5' don't drop.";
  cHtml.presentation.procurement = [
    {
      label: 'NestedImg',
      value: { image_data_uri: 'file:///home/FolderProbe3/x' },
      url: "https://example.com/?q=Evidence%20%27C%3A%5CUsers%5CD%27%20FolderProbe4%27",
    },
  ];
  const h6 = bodyHtml(cHtml);
  for (const tok of ['FolderProbe', 'FolderProbe2', 'FolderProbe3', 'FolderProbe4', 'FolderProbe5']) {
    assert.equal(h6.includes(tok), false, `Round-6 leak token ${tok} must be 0 in rendered HTML`);
  }
  assert.equal(h6.includes('Evidence &#39;~&#39; and &#39;keep&#39; then &#39;~&#39;. Also &#39;~&#39; don&#39;t drop.'), true, 'quoted paths must redact cleanly to ~ while preserving unrelated single-quoted prose, contractions, and trailing period');
});
