import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { calculateEconomics, netReferral } from '../src/economics.mjs';
import { evaluateEarlyScreen } from '../src/early-screen.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
profile.revision = profile.workflow.scoring_and_ordering.revision = 57;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));
fixture.profile_revision = 57;
for (const c of fixture.candidates) {
  for (const sc of c.economics.scenarios) {
    sc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
    sc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    sc.cost_ledger.fee_context.inbound = { from: '2027-02-01', through: '2027-02-01' };
    for (const line of sc.cost_ledger.lines) {
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-09-30';
      }
    }
  }
}

test('revision 57 accepts matched-spec USD 29.99 while frozen revisions 50-56 preserve strictly greater than USD 30', () => {
  assert.equal(profile.revision, 57);
  const candidate = structuredClone(fixture.candidates[0]);
  candidate.screening.reference_price_usd.value = 29.99;
  const r57AtFloor = scoreCandidate(candidate, profile);
  assert.equal(r57AtFloor.screening.status, 'eligible');
  assert.equal(r57AtFloor.queue, 'comparable');
  assert.match(r57AtFloor.screening.conditions.find(c => c.id === 'reference_price').reason, /at least USD 29\.99/);

  candidate.screening.reference_price_usd.value = 29.98;
  const r57Below = scoreCandidate(candidate, profile);
  assert.equal(r57Below.screening.status, 'excluded');
  assert.equal(r57Below.queue, 'excluded');
  assert.match(r57Below.screening.conditions.find(c => c.id === 'reference_price').reason, /below USD 29\.99/);

  for (const rev of [54, 55, 56]) {
    const frozen = structuredClone(profile);
    frozen.revision = frozen.workflow.scoring_and_ordering.revision = rev;
    candidate.screening.reference_price_usd.value = 30.00;
    const at30 = scoreCandidate(candidate, frozen);
    assert.equal(at30.screening.conditions.find(c => c.id === 'reference_price').status, 'fail');
    assert.equal(at30.queue, 'excluded');
  }
});

test('revision 57 requires full primary Feb-Sep coverage for seasonal_eligible ordering while preserving r52-56 legacy behavior', () => {
  const seasonalEligible = structuredClone(fixture.candidates[0]);
  seasonalEligible.id = 'synthetic-seasonal-eligible';
  const offPeak = structuredClone(seasonalEligible.economics.scenarios[0]);
  const peakUnpublished = structuredClone(offPeak);
  peakUnpublished.id = peakUnpublished.cost_ledger.id = 'peak-unpublished';
  peakUnpublished.cost_ledger.fee_context.sales = peakUnpublished.cost_ledger.fee_context.storage = { from: '2027-10-15', through: '2027-12-31' };
  Object.assign(peakUnpublished.cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null, status: 'pending', fee_basis: { status: 'unavailable', version: 'Unpublished 2027 peak fulfillment' },
  });
  seasonalEligible.economics = {
    saleable_unit: seasonalEligible.economics.saleable_unit,
    operating_periods: [
      { id: 'off_peak', label: '2027年2–9月淡季', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [offPeak] },
      { id: 'peak', label: '2027年10–12月旺季', months: [10, 11, 12], scenarios: [peakUnpublished] },
    ],
  };

  // A narrow single-month slice (March alone) must NOT qualify as seasonal_eligible in revision 57
  const marchOnly = structuredClone(seasonalEligible);
  marchOnly.id = 'synthetic-march-only';
  marchOnly.economics.operating_periods = [
    { id: 'march', label: '2027年3月单月', months: [3], scenarios: [structuredClone(offPeak)] },
  ];
  marchOnly.economics.operating_periods[0].scenarios[0].cost_ledger.fee_context.sales = { from: '2027-03-01', through: '2027-03-31' };
  marchOnly.economics.operating_periods[0].scenarios[0].cost_ledger.fee_context.storage = { from: '2027-03-01', through: '2027-03-31' };

  // Labeling months [2..9] while supplying sales/storage only for March 2027 must ALSO be rejected
  const mislabeledMonths = structuredClone(seasonalEligible);
  mislabeledMonths.id = 'synthetic-mislabeled-months';
  mislabeledMonths.economics.operating_periods = [
    { id: 'off_peak', label: '2027年2–9月名义标签但仅3月窗口', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [structuredClone(offPeak)] },
  ];
  mislabeledMonths.economics.operating_periods[0].scenarios[0].cost_ledger.fee_context.sales = { from: '2027-03-01', through: '2027-03-31' };
  mislabeledMonths.economics.operating_periods[0].scenarios[0].cost_ledger.fee_context.storage = { from: '2027-03-01', through: '2027-03-31' };

  // A 2028-only period with zero 2027 Feb-Sep coverage must NOT qualify for the 2027 target
  const year2028Only = structuredClone(seasonalEligible);
  year2028Only.id = 'synthetic-2028-only';
  const sc2028 = structuredClone(offPeak);
  sc2028.cost_ledger.fee_context.sales = { from: '2028-02-01', through: '2028-09-30' };
  sc2028.cost_ledger.fee_context.storage = { from: '2028-02-01', through: '2028-09-30' };
  sc2028.cost_ledger.fee_context.inbound = { from: '2028-02-01', through: '2028-02-01' };
  for (const line of sc2028.cost_ledger.lines.filter(l => l.fee_basis)) {
    line.fee_basis.effective_from = '2028-01-15';
    line.fee_basis.effective_through = '2028-10-14';
  }
  year2028Only.economics.operating_periods = [
    { id: 'off_peak', label: '2028年2–9月', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [sc2028] },
  ];

  const comparable = structuredClone(fixture.candidates[0]);
  comparable.id = 'synthetic-comparable';
  const pending = structuredClone(fixture.candidates[2]);
  pending.id = 'synthetic-pending';

  const batchR57 = {
    schema_version: 1,
    profile_revision: 57,
    candidates: [pending, marchOnly, mislabeledMonths, year2028Only, seasonalEligible, comparable],
  };
  const outR57 = scoreBatch(batchR57, profile);
  assert.deepEqual(outR57.candidates.map(c => c.candidate_id), [
    'synthetic-comparable',
    'synthetic-seasonal-eligible',
    'synthetic-pending',
    'synthetic-march-only',
    'synthetic-mislabeled-months',
    'synthetic-2028-only',
  ]);
  assert.equal(outR57.summary.seasonal_review, 4);
  assert.equal(outR57.summary.seasonal_eligible, 1);

  const frozenR56 = structuredClone(profile);
  frozenR56.revision = frozenR56.workflow.scoring_and_ordering.revision = 56;
  const outR56 = scoreBatch({ ...batchR57, profile_revision: 56 }, frozenR56);
  assert.deepEqual(outR56.candidates.map(c => c.candidate_id), [
    'synthetic-comparable',
    'synthetic-pending',
    'synthetic-march-only',
    'synthetic-mislabeled-months',
    'synthetic-2028-only',
    'synthetic-seasonal-eligible',
  ]);
  assert.equal(outR56.summary.seasonal_eligible, 4);
});

test('revision 57 requires explicit first_order_promotion: false on procurement and freight while preserving r54-56 replay', () => {
  assert.deepEqual(
    netReferral({ price_usd: 1.5, refund_fraction: 0, referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 }),
    { gross_usd: 0.3, refund_credit_usd: 0, administration_usd: 0, net_usd: 0.3 },
  );

  for (const targetLine of ['domestic_freight', 'procurement']) {
    for (const badPromo of [undefined, null, 'true', true]) {
      const candidate = structuredClone(fixture.candidates[0]);
      const line = candidate.economics.scenarios[0].cost_ledger.lines.find(l => l.id === targetLine);
      if (badPromo === undefined) delete line.first_order_promotion;
      else line.first_order_promotion = badPromo;

      const r57Out = scoreCandidate(candidate, profile);
      assert.equal(r57Out.queue, 'pending');
      assert.equal(r57Out.total, null);
      assert.ok(r57Out.diagnostics.economics.scenarios[0].input.calculation.pending_lines.includes(targetLine));
      assert.ok(r57Out.diagnostics.economics.scenarios[0].input.calculation.fee_validation.issues.some(i => i.code === 'domestic_quote_required'));
    }

    for (const badUnits of [undefined, null, 50, '100']) {
      const candidate = structuredClone(fixture.candidates[0]);
      const line = candidate.economics.scenarios[0].cost_ledger.lines.find(l => l.id === targetLine);
      if (badUnits === undefined) delete line.order_units;
      else line.order_units = badUnits;
      const r57Out = scoreCandidate(candidate, profile);
      assert.equal(r57Out.queue, 'pending');
      assert.equal(r57Out.total, null);
    }
  }

  // Contradictory source_inputs.complete_saleable_sets: 50 must also be rejected in r57
  const badSourceSets = structuredClone(fixture.candidates[0]);
  badSourceSets.economics.scenarios[0].cost_ledger.source_inputs = { complete_saleable_sets: 50 };
  assert.equal(scoreCandidate(badSourceSets, profile).queue, 'pending');

  // Demand scale in r57 requires grain === 'parent_units'
  for (const badGrain of ['child_variant_attribution_split', 'family', 'arbitrary']) {
    const badDemand = structuredClone(fixture.candidates[0]);
    badDemand.metrics.purchase_demand_scale.grain = badGrain;
    const r57Demand = scoreCandidate(badDemand, profile);
    assert.equal(r57Demand.items.find(i => i.id === 'purchase_demand_scale').status, 'needs_evidence');
    assert.equal(r57Demand.queue, 'pending');
  }

  // Frozen revisions 54-56 must preserve exact fee-validation, minimum-referral, and grain behavior
  for (const rev of [54, 55, 56]) {
    const frozen = structuredClone(profile);
    frozen.revision = frozen.workflow.scoring_and_ordering.revision = rev;
    const candidate = structuredClone(fixture.candidates[0]);
    candidate.screening.reference_price_usd.value = 40;
    candidate.metrics.purchase_demand_scale.grain = 'family';
    candidate.economics.scenarios[0].cost_ledger.referral_terms.minimum_referral_usd = 30;
    candidate.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').first_order_promotion = true;
    candidate.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'domestic_freight').first_order_promotion = true;
    const frozenOut = scoreCandidate(candidate, frozen);
    assert.equal(frozenOut.queue, 'comparable');
    assert.equal(frozenOut.total, 100);
    assert.deepEqual(frozenOut.diagnostics.economics.margin_range, [0.5, 0.5]);

    const missingComp = structuredClone(fixture.candidates[0]);
    missingComp.screening.reference_price_usd.value = 40;
    delete missingComp.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'collection').components;
    const frozenMissingComp = scoreCandidate(missingComp, frozen);
    assert.equal(frozenMissingComp.queue, 'pending');
    assert.equal(frozenMissingComp.total, null);
  }
});

test('three-calendar-month launch check uses calendar dates in revision 57 while preserving exact UTC behavior for revisions 51-56', () => {
  const candidate = structuredClone(fixture.candidates[0]);
  candidate.newcomer_cohort.observation_date = '2026-11-17';
  candidate.newcomer_cohort.members[0].launch_date = '2026-08-17T00:00:00+08:00'; // 2026-08-16T16:00:00Z

  const r57Result = scoreCandidate(candidate, profile);
  const r57Member = r57Result.diagnostics.newcomers.members.find(m => m.family_id === candidate.newcomer_cohort.members[0].family_id);
  assert.equal(r57Member.effective_status, 'qualified');

  for (const rev of [51, 54, 56]) {
    const frozen = structuredClone(profile);
    frozen.revision = frozen.workflow.scoring_and_ordering.revision = rev;
    const frozenResult = scoreCandidate(candidate, frozen);
    const frozenMember = frozenResult.diagnostics.newcomers.members.find(m => m.family_id === candidate.newcomer_cohort.members[0].family_id);
    assert.equal(frozenMember.effective_status, 'pending');

    // Upper-bound replay checks on observation_date 2026-11-17
    candidate.newcomer_cohort.members[0].launch_date = '2026-11-17T23:30:00-08:00';
    assert.equal(scoreCandidate(candidate, frozen).diagnostics.newcomers.members[0].effective_status, 'qualified');
    candidate.newcomer_cohort.members[0].launch_date = '2026-11-18T00:30:00+14:00';
    assert.equal(scoreCandidate(candidate, frozen).diagnostics.newcomers.members[0].effective_status, 'pending');
    candidate.newcomer_cohort.members[0].launch_date = '2026-08-17T00:00:00+08:00';
  }

  // Missing, null, or numeric launch_date on a qualified member must stay pending without throwing
  for (const badLaunch of [undefined, null, 20261001, 'not-a-date']) {
    const malformed = structuredClone(candidate);
    if (badLaunch === undefined) delete malformed.newcomer_cohort.members[0].launch_date;
    else malformed.newcomer_cohort.members[0].launch_date = badLaunch;
    const res = scoreCandidate(malformed, profile);
    assert.equal(res.diagnostics.newcomers.members[0].effective_status, 'pending');
  }
});

test('report renders revision 57 newcomer mode, 15% ad sensitivity, low-exposure bid notes, risks/next_checks, star reference, and sanitized local paths', () => {
  const batch = structuredClone(fixture);
  batch.candidates = [batch.candidates[0]];
  const c = batch.candidates[0];
  c.screening.reference_price_usd.value = 29.99;
  c.market.average_star_rating = { value: 4.4, note: '合成均星样本说明' };
  c.bids.entries = [c.bids.entries[0]];
  c.bids.entries[0].low_exposure_baseline = true;
  c.bids.entries[0].low_exposure_note = '周搜索极低，采用原生实时精确基准值';
  c.presentation.risks = [
    '合成权利与规格边界提示 <risk>',
    { label: '低价竞品核对', value: 'FBM直邮不含配件', note: '非同规格FBA可比价' },
  ];
  c.presentation.next_checks = ['下单前向工厂书面确认专利授权状态'];
  c.evidence[0].path = 'C:\\Users\\synthetic_owner\\repos\\Product-selection-development-tools\\.local\\trials\\synthetic\\raw.json';
  c.evidence.push(
    { id: 'syn-file-uri', source: 'File URI probe', observed_at: '2026-11-17', path: 'file:///C:/Users/synthetic_owner/Desktop/raw.json' },
    { id: 'syn-single-slash-file', source: 'Single-slash file URI probe', observed_at: '2026-11-17', path: 'file:/C:/Users/synthetic_owner/Desktop/raw.json' },
    { id: 'syn-admin-share', source: 'Admin share path probe', observed_at: '2026-11-17', path: '\\\\localhost\\C$\\Users\\synthetic_owner\\Desktop\\raw.json' },
    { id: 'syn-ext-win', source: 'Extended Win path probe', observed_at: '2026-11-17', path: '\\\\?\\C:\\Users\\synthetic_owner\\Desktop\\raw.json' },
    { id: 'syn-non-string', source: 'Malformed object path probe', observed_at: '2026-11-17', path: { leaked: 'C:\\Users\\synthetic_owner\\Desktop\\raw.json' } },
  );

  const result = scoreBatch(batch, profile);
  const html = renderReport(result, batch);
  assert.match(html, /正常新品：固定示例/);
  assert.doesNotMatch(html, /评分数量中位数/);
  assert.match(html, /售价15%广告敏感度参考/);
  assert.match(html, /30%广告前毛利对应采购单价上限/);
  assert.match(html, /已记录的月搜索量仅作展示参考/);
  assert.match(html, /低曝光提示：周搜索极低，采用原生实时精确基准值/);
  assert.match(html, /细分市场显示均星参考（不计分）：<strong>4\.4 星<\/strong>/);
  assert.match(html, /风险与边界提示/);
  assert.match(html, /合成权利与规格边界提示 &lt;risk&gt;/);
  assert.match(html, /后续核查事项/);
  assert.match(html, /下单前向工厂书面确认专利授权状态/);
  assert.doesNotMatch(html, /synthetic_owner/);
  assert.match(html, /\.local\/trials\/synthetic\/raw\.json/);
});

test('early-screen helper keeps missing returns-processing or bond costs pending instead of converting them to zero', () => {
  const baseInput = {
    profile_revision: 57,
    saleable_unit: 'one synthetic 2-piece set',
    price_usd: 45,
    fx_cny_per_usd: 7,
    order_units: 100,
    goods_cny_per_unit: 80,
    domestic_freight_cny_total: 300,
    first_order_promotion: false,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 10, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1 },
    refund_fraction: 0.04,
    return_threshold: 0.06,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0 },
    fulfillment_usd: 6.5,
    placement_usd: 0.5,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
  };

  const pass = evaluateEarlyScreen(baseInput);
  assert.equal(pass.gate_status, 'pass');
  assert.equal(pass.proceed_to_21_items, true);
  assert.ok(pass.metrics.margin >= 0.3);
  assert.ok(pass.metrics.procurement_buffer_cny > 0);

  // Omitting both return_threshold and returns_processing_usd keeps margin pending rather than assuming 0
  const missingReturnsThreshold = structuredClone(baseInput);
  delete missingReturnsThreshold.return_threshold;
  const pendingReturns = evaluateEarlyScreen(missingReturnsThreshold);
  assert.equal(pendingReturns.gate_status, 'pending');
  assert.equal(pendingReturns.checks.margin, 'pending');
  assert.ok(pendingReturns.ledger.pending_lines.includes('returns_processing'));

  // Omitting bond in CNY/kg headhaul keeps headhaul pending rather than assuming 0 bond
  const missingBond = structuredClone(baseInput);
  delete missingBond.headhaul.bond_cny_per_kg;
  const pendingBond = evaluateEarlyScreen(missingBond);
  assert.equal(pendingBond.gate_status, 'pending');
  assert.ok(pendingBond.ledger.pending_lines.includes('headhaul'));

  const belowMargin = evaluateEarlyScreen({
    ...baseInput,
    price_usd: 34.5,
    headhaul: { chargeable_kg_per_unit: 1.5, rate_cny_per_kg: 12, surcharge_cny_per_kg: 1, bond_cny_per_kg: 1 },
  });
  assert.equal(belowMargin.gate_status, 'fail');
  assert.equal(belowMargin.checks.margin, 'fail');
  assert.ok(belowMargin.metrics.procurement_buffer_cny < 0);

  for (const promoInput of [
    { first_order_promotion: undefined },
    { first_order_promotion: null },
    { first_order_promotion: 'true' },
    { first_order_promotion: true },
    { first_order_promotion: false, goods_first_order_promotion: true },
    { order_units: undefined },
    { order_units: null },
    { order_units: 50 },
  ]) {
    const candidateInput = { ...baseInput, ...promoInput };
    if (promoInput.first_order_promotion === undefined && Object.hasOwn(promoInput, 'first_order_promotion')) delete candidateInput.first_order_promotion;
    if (promoInput.order_units === undefined && Object.hasOwn(promoInput, 'order_units')) delete candidateInput.order_units;
    const promoRes = evaluateEarlyScreen(candidateInput);
    assert.equal(promoRes.gate_status, 'pending');
    assert.equal(promoRes.proceed_to_21_items, false);
    assert.equal(promoRes.checks.domestic_quote, 'pending');
  }

  assert.throws(() => evaluateEarlyScreen({ ...baseInput, price_usd: 29.98, minimum_price_usd: 29.98 }), TypeError);
  assert.throws(() => evaluateEarlyScreen({ ...baseInput, price_usd: 35, margin_floor: 0.10 }), TypeError);
});

test('exact decimal 30% margin passes in revision 57 and early-screen despite IEEE-754 drift while sub-30% fails and r54-56 replay holds', () => {
  const exact30Early = evaluateEarlyScreen({
    profile_revision: 57,
    saleable_unit: 'one synthetic set',
    price_usd: 29.99,
    order_units: 100,
    procurement_usd: 11.4945,
    domestic_freight_usd: 1,
    first_order_promotion: false,
    fx_cny_per_usd: 1,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 0.5, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0.5 },
    refund_fraction: 0,
    return_threshold: 0.06,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0 },
    fulfillment_usd: 1,
    placement_usd: 1,
    storage: 1,
    collection_rate: 0,
    other_applicable_usd: 0,
  });
  assert.equal(exact30Early.gate_status, 'pass');
  assert.equal(exact30Early.checks.margin, 'pass');

  const slightlyBelowEarly = evaluateEarlyScreen({
    profile_revision: 57,
    saleable_unit: 'one synthetic set',
    price_usd: 29.99,
    order_units: 100,
    procurement_usd: 11.4946,
    domestic_freight_usd: 1,
    first_order_promotion: false,
    fx_cny_per_usd: 1,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 0.5, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0.5 },
    refund_fraction: 0,
    return_threshold: 0.06,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0 },
    fulfillment_usd: 1,
    placement_usd: 1,
    storage: 1,
    collection_rate: 0,
    other_applicable_usd: 0,
  });
  assert.equal(slightlyBelowEarly.gate_status, 'fail');
  assert.equal(slightlyBelowEarly.checks.margin, 'fail');
  assert.doesNotMatch(slightlyBelowEarly.reasons.join(' '), /30\.00% is below/);

  const candidate = structuredClone(fixture.candidates[0]);
  candidate.screening.reference_price_usd.value = 29.99;
  const ledger = candidate.economics.scenarios[0].cost_ledger;
  ledger.price_usd = 29.99;
  ledger.refund_fraction = 0;
  ledger.collection_rate = 0;
  for (const [lineId, amt] of [
    ['procurement', 11.4945], ['domestic_freight', 1], ['headhaul', 1],
    ['fulfillment', 1], ['placement', 1], ['storage', 1],
    ['returns_processing', 0], ['returns_disposal', 0], ['other_applicable', 0], ['recovery_credit', 0],
  ]) {
    ledger.lines.find(l => l.id === lineId).amount_usd = amt;
  }

  const r57Exact = scoreCandidate(candidate, profile);
  assert.equal(r57Exact.queue, 'comparable');
  assert.equal(r57Exact.items.find(i => i.id === 'refund_adjusted_pre_ad_margin').score, profile.group_budgets[0].items[0].mapping.score_at_floor);

  ledger.lines.find(l => l.id === 'procurement').amount_usd = 11.49450001;
  const r57Below = scoreCandidate(candidate, profile);
  assert.equal(r57Below.queue, 'excluded');

  // Frozen r56 preserves legacy binary64 comparison
  ledger.lines.find(l => l.id === 'procurement').amount_usd = 11.4945;
  candidate.screening.reference_price_usd.value = 40;
  const frozenR56 = structuredClone(profile);
  frozenR56.revision = frozenR56.workflow.scoring_and_ordering.revision = 56;
  const r56Legacy = scoreCandidate(candidate, frozenR56);
  assert.equal(r56Legacy.queue, 'excluded');
});

test('revision 57 enforces full operating-period month coverage, profile floors, r50-56 bid JSON parity, UNC file URIs, and Gate-1 missing-refund/headhaul/storage/peak checks', () => {
  // 1. Fourteen days of Oct 1-14 fees cannot qualify a peak panel labelled [10, 11, 12] in r57
  const partialPeak = structuredClone(fixture.candidates[0]);
  const scOct14 = structuredClone(partialPeak.economics.scenarios[0]);
  scOct14.cost_ledger.fee_context.sales = { from: '2027-10-01', through: '2027-10-14' };
  scOct14.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
  for (const line of scOct14.cost_ledger.lines.filter(l => l.fee_basis)) {
    line.fee_basis.effective_from = '2027-01-15';
    line.fee_basis.effective_through = line.id === 'fulfillment' ? '2027-10-14' : '2027-12-31';
  }
  partialPeak.economics = {
    saleable_unit: partialPeak.economics.saleable_unit,
    operating_periods: [{ id: 'peak', label: '2027年10–12月', months: [10, 11, 12], scenarios: [scOct14] }],
  };
  const partialPeakOut = scoreCandidate(partialPeak, profile);
  assert.equal(partialPeakOut.operating_periods[0].queue, 'pending');
  assert.equal(partialPeakOut.operating_periods[0].total, null);

  // 2. Tampered r57 profile lowering floors below 29.99 or 0.30 throws TypeError
  const weakPriceProfile = structuredClone(profile);
  weakPriceProfile.reference_screening.comparable_reference_price.minimum_inclusive = 29.98;
  assert.throws(() => scoreCandidate(fixture.candidates[0], weakPriceProfile), TypeError);

  const weakMarginProfile = structuredClone(profile);
  weakMarginProfile.reference_screening.margin.minimum = 0.1;
  weakMarginProfile.group_budgets[0].items[0].mapping.eligible_margin_floor = 0.1;
  assert.throws(() => scoreCandidate(fixture.candidates[0], weakMarginProfile), TypeError);

  // 3. Direct calculateEconomics with profileRevision: 57 enforces repeat-order quote fields & source_inputs.first_order_promotion
  const directLedger = structuredClone(fixture.candidates[0].economics.scenarios[0].cost_ledger);
  delete directLedger.lines.find(l => l.id === 'procurement').order_units;
  const directOut = calculateEconomics(directLedger, {
    profileRevision: 57,
    requireFeeBasis: true,
    evidenceIds: fixture.candidates[0].evidence.map(e => e.id),
  });
  assert.equal(directOut.scoring_supported, false);

  const promoSourceCand = structuredClone(fixture.candidates[0]);
  promoSourceCand.economics.scenarios[0].cost_ledger.source_inputs = { first_order_promotion: true };
  assert.equal(scoreCandidate(promoSourceCand, profile).queue, 'pending');

  // 4. Frozen r50-56 bid JSON does not emit low_exposure_baseline / low_exposure_note
  const frozenBidCand = structuredClone(fixture.candidates[0]);
  frozenBidCand.bids.entries[0].low_exposure_baseline = true;
  frozenBidCand.bids.entries[0].low_exposure_note = 'probe';
  const frozenR56 = structuredClone(profile);
  frozenR56.revision = frozenR56.workflow.scoring_and_ordering.revision = 56;
  const frozenBidOut = scoreCandidate(frozenBidCand, frozenR56);
  assert.equal(Object.hasOwn(frozenBidOut.diagnostics.bids.entries[0], 'low_exposure_baseline'), false);
  assert.equal(Object.hasOwn(frozenBidOut.diagnostics.bids.entries[0], 'low_exposure_note'), false);

  // 5. file://server/Users/PRIVATE_CASE/receipt.json redacts login name in r57 report
  const pathBatch = structuredClone(fixture);
  pathBatch.candidates = [pathBatch.candidates[0]];
  pathBatch.candidates[0].evidence.push({
    id: 'unc-file-uri',
    source: 'UNC file URI probe',
    observed_at: '2026-11-17',
    path: 'file://server/Users/PRIVATE_CASE/receipt.json',
  });
  const pathHtml = renderReport(scoreBatch(pathBatch, profile), pathBatch);
  assert.doesNotMatch(pathHtml, /PRIVATE_CASE/);

  // 6. Gate-1 handles missing/null refund_fraction as pending and blocks zero headhaul/storage overrides & unavailable peak fees
  const gateBase = {
    profile_revision: 57,
    saleable_unit: 'one synthetic set',
    price_usd: 45,
    fx_cny_per_usd: 7,
    order_units: 100,
    goods_cny_per_unit: 80,
    domestic_freight_cny_total: 300,
    first_order_promotion: false,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 10, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1 },
    refund_fraction: 0.04,
    return_threshold: 0.06,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0 },
    fulfillment_usd: 6.5,
    placement_usd: 0.5,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
  };

  for (const missingRefund of [undefined, null]) {
    const inp = { ...gateBase, refund_fraction: missingRefund };
    if (missingRefund === undefined) delete inp.refund_fraction;
    const out = evaluateEarlyScreen(inp);
    assert.equal(out.gate_status, 'pending');
    assert.equal(out.proceed_to_21_items, false);
    assert.equal(out.checks.margin, 'pending');
  }

  // Adding usd_per_unit: 0 alongside per-kg headhaul (with or without bond) stays pending
  const zeroHeadhaulOverride = evaluateEarlyScreen({
    ...gateBase,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 10, surcharge_cny_per_kg: 0, usd_per_unit: 0 },
  });
  assert.equal(zeroHeadhaulOverride.gate_status, 'pending');
  assert.equal(zeroHeadhaulOverride.proceed_to_21_items, false);

  // Lowering average_inventory_days below 45 stays pending
  const zeroDaysStorage = evaluateEarlyScreen({
    ...gateBase,
    storage: { cubic_feet_per_unit: 0.05, rate_usd_per_cuft_month: 0.78, average_inventory_days: 0 },
  });
  assert.equal(zeroDaysStorage.gate_status, 'pending');
  assert.equal(zeroDaysStorage.proceed_to_21_items, false);

  // Holiday peak sales window without covering published fulfillment_fee_basis stays pending
  const peakEarly = evaluateEarlyScreen({
    ...gateBase,
    sales_window: { from: '2027-10-15', through: '2027-12-31' },
    fulfillment_fee_basis: { status: 'published', effective_from: '2027-01-15', effective_through: '2027-10-14' },
  });
  assert.equal(peakEarly.gate_status, 'pending');
  assert.equal(peakEarly.proceed_to_21_items, false);
});

test('revision 57 enforces companion peak panel, storage month bounds, explicit Gate-1 terms/bond/period alignment, single-source bid labels, double-slash/limitation path redaction, and malformed observed_at resilience', () => {
  // 1. Seasonal card omitting peak panel or extending storage into October cannot qualify as seasonal_eligible
  const offOnlyCand = structuredClone(fixture.candidates[0]);
  offOnlyCand.id = 'off-only-no-peak';
  offOnlyCand.economics = {
    saleable_unit: offOnlyCand.economics.saleable_unit,
    operating_periods: [
      { id: 'off_peak', label: '2027年2–9月', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [structuredClone(fixture.candidates[0].economics.scenarios[0])] },
    ],
  };
  const offOnlyBatch = scoreBatch({ schema_version: 1, profile_revision: 57, candidates: [offOnlyCand] }, profile);
  assert.equal(offOnlyBatch.summary.seasonal_eligible, 0);

  const storageSpillCand = structuredClone(fixture.candidates[0]);
  storageSpillCand.id = 'storage-spill-oct1';
  const spillOff = structuredClone(fixture.candidates[0].economics.scenarios[0]);
  spillOff.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-10-01' };
  const spillPeak = structuredClone(spillOff);
  spillPeak.id = spillPeak.cost_ledger.id = 'spill-peak';
  spillPeak.cost_ledger.fee_context.sales = spillPeak.cost_ledger.fee_context.storage = { from: '2027-10-15', through: '2027-12-31' };
  Object.assign(spillPeak.cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null, status: 'pending', fee_basis: { status: 'unavailable', version: 'Unpublished' },
  });
  storageSpillCand.economics = {
    saleable_unit: storageSpillCand.economics.saleable_unit,
    operating_periods: [
      { id: 'off_peak', label: '2027年2–9月', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [spillOff] },
      { id: 'peak', label: '2027年10–12月', months: [10, 11, 12], scenarios: [spillPeak] },
    ],
  };
  const spillBatch = scoreBatch({ schema_version: 1, profile_revision: 57, candidates: [storageSpillCand] }, profile);
  assert.equal(spillBatch.candidates[0].operating_periods[0].queue, 'pending');
  assert.equal(spillBatch.summary.seasonal_eligible, 0);

  // 2 & 3. Gate-1 rejects mismatched operating_period/sales_window, usd_per_unit without bond_included: true, and omitted referral/collection/other_applicable
  const validGate = {
    profile_revision: 57,
    saleable_unit: 'one synthetic set',
    price_usd: 29.99,
    order_units: 100,
    procurement_usd: 11.4945,
    domestic_freight_usd: 1,
    first_order_promotion: false,
    fx_cny_per_usd: 1,
    headhaul: { chargeable_kg_per_unit: 1, rate_cny_per_kg: 0.5, surcharge_cny_per_kg: 0, bond_cny_per_kg: 0.5 },
    refund_fraction: 0,
    return_threshold: 0.06,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0 },
    fulfillment_usd: 1,
    placement_usd: 1,
    storage: 1,
    collection_rate: 0,
    other_applicable_usd: 0,
  };
  assert.equal(evaluateEarlyScreen(validGate).gate_status, 'pass');

  assert.equal(evaluateEarlyScreen({
    ...validGate,
    operating_period: 'peak',
    operating_months: [10, 11, 12],
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
  }).gate_status, 'pending');

  assert.equal(evaluateEarlyScreen({
    ...validGate,
    procurement_usd: 11.9945,
    headhaul: { usd_per_unit: 0.5 },
  }).gate_status, 'pending');

  assert.equal(evaluateEarlyScreen({
    ...validGate,
    headhaul: { usd_per_unit: 1, bond_included: true },
  }).gate_status, 'pass');

  for (const omittedKey of ['referral_terms', 'collection_rate', 'other_applicable_usd']) {
    const copy = structuredClone(validGate);
    delete copy[omittedKey];
    assert.equal(evaluateEarlyScreen(copy).gate_status, 'pending');
  }

  // 6. Phrase-match bid without usable exact point does not claim low-exposure baseline; single-source SellerSprite point uses SellerSprite label in r57
  const phraseBidBatch = structuredClone(fixture);
  phraseBidBatch.candidates = [phraseBidBatch.candidates[0]];
  phraseBidBatch.candidates[0].bids.entries = [phraseBidBatch.candidates[0].bids.entries[0]];
  phraseBidBatch.candidates[0].bids.entries[0].sellersprite.match_type = 'phrase';
  phraseBidBatch.candidates[0].bids.entries[0].sif.value = null;
  phraseBidBatch.candidates[0].bids.entries[0].low_exposure_baseline = true;
  delete phraseBidBatch.candidates[0].bids.entries[0].low_exposure_note;
  const phraseRes = scoreBatch(phraseBidBatch, profile);
  assert.equal(phraseRes.candidates[0].diagnostics.bids.entries[0].combined_point, null);
  assert.equal(Object.hasOwn(phraseRes.candidates[0].diagnostics.bids.entries[0], 'low_exposure_baseline'), false);
  const phraseHtml = renderReport(phraseRes, phraseBidBatch);
  assert.doesNotMatch(phraseHtml, /采用原生工具返回的平台基准建议竞价/);

  const ssOnlyBatch = structuredClone(fixture);
  ssOnlyBatch.candidates = [ssOnlyBatch.candidates[0]];
  ssOnlyBatch.candidates[0].bids.entries = [ssOnlyBatch.candidates[0].bids.entries[0]];
  ssOnlyBatch.candidates[0].bids.entries[0].sif.value = null;
  const ssOnlyHtml = renderReport(scoreBatch(ssOnlyBatch, profile), ssOnlyBatch);
  assert.match(ssOnlyHtml, /SellerSprite 单源精确点/);
  assert.doesNotMatch(ssOnlyHtml, /两源可用点均值/);

  // 7 & 8. Double-backslash Windows path, limitations.source_path file URI, and observed_at {"toString":null} do not leak or crash
  const edgeBatch = structuredClone(fixture);
  edgeBatch.candidates = [edgeBatch.candidates[0]];
  edgeBatch.candidates[0].evidence.push(
    {
      id: 'double-slash-win',
      source: 'Double backslash path probe',
      observed_at: { toString: null },
      path: 'C:\\Users\\\\AUDIT_MARKER\\Desktop\\receipt.json',
      limitations: { source_path: 'file:///C:/Users/AUDIT_MARKER/Desktop/receipt.json' },
    },
  );
  const edgeHtml = renderReport(scoreBatch(edgeBatch, profile), edgeBatch);
  assert.doesNotMatch(edgeHtml, /AUDIT_MARKER/);
  assert.match(edgeHtml, /日期未知/);
});
