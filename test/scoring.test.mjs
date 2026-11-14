import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreBatch, scoreCandidate, scoreNumericValue } from '../src/scoring.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
const evidence = [{ id: 'synthetic-source', source: 'Synthetic test evidence', observed_at: '2026-11-13' }];
const observation = (value, unit, extra = {}) => ({ value, unit, evidence: ['synthetic-source'], ...extra });
const judgment = (anchor, extra = {}) => ({ anchor, reason: 'Synthetic bounded judgment.', evidence: ['synthetic-source'], ...extra });
const item = (result, id) => result.items.find(entry => entry.id === id);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const market = () => ({
  provider: 'sellersprite', report_id: 'synthetic-market', relevant: true,
  population: 'Synthetic native recent-sales sample', family_basis: 'Synthetic family basis',
  period: '2026-10-15/2026-11-13', head_group: 'native top ten', evidence: ['synthetic-source'],
  newcomer_age_months: 3, newcomer_sales_window: 'latest_30_days',
  concentrations: { product: observation(0.4, 'fraction'), brand: observation(0.6, 'fraction'), seller: observation(0.8, 'fraction') },
  newcomer: { count_share: observation(0.1, 'fraction'), unit_sales_share: observation(0.15, 'fraction') },
});
const bids = () => ({
  marketplace: 'US', currency: 'USD', match_type: 'exact', volume_period: '2026-10',
  selection_reason: 'Synthetic supported main buying entries.', evidence: ['synthetic-source'],
  entries: [
    { query: 'synthetic form', volume: observation(100, 'searches_per_month'),
      sellersprite: observation(1, 'USD', { match_type: 'exact', strategy: 'unspecified', low: 0.5, high: 1.5 }),
      sif: observation(3, 'USD', { match_type: 'exact', strategy: 'fixed', low: 2, high: 4 }) },
    { query: 'synthetic form for specific use', volume: observation(300, 'searches_per_month'),
      sellersprite: observation(1, 'USD', { match_type: 'exact', strategy: 'fixed', low: 0.5, high: 1.5 }) },
  ],
});
const member = (family, ratings, units, share, extra = {}) => ({
  family_id: family, asin: `${family}-listing`, status: 'qualified',
  reason: 'Synthetic comparable normal-start newcomer with a supported relevant top-100 observation.', evidence: ['synthetic-source'],
  ratings: observation(ratings, 'count'), units_30d: observation(units, 'units'),
  natural: observation(share, 'fraction', { scope: 'overall', period: '2026-10-15/2026-11-13', relevant_entries_evidence: ['synthetic-source'] }),
  ...extra,
});
const cohort = (members = [member('family-a', 5, 40, 0.35), member('family-b', 20, 100, 0.7), member('family-c', 80, 10, 1)]) => ({
  observation_basis: 'current_latest_30_days', observation_date: '2026-11-13', period: '2026-10-15/2026-11-13',
  niche: 'Synthetic substitutable niche', grain: 'family', relevant_bsr_node: 'synthetic-node',
  reference_supported: true, evidence: ['synthetic-source'], members,
});
const scenario = (id, margin, contribution) => ({ id, saleable_unit: 'one synthetic bundle', coherent: true,
  assumptions: ['Synthetic supported matched-spec economic scenario.'],
  margin: observation(margin, 'fraction'), contribution_usd: observation(contribution, 'USD') });

function completeCandidate(id = 'synthetic-complete') {
  const nativeMarket = market();
  nativeMarket.concentrations = Object.fromEntries(['product', 'brand', 'seller'].map(key => [key, observation(0.4, 'fraction')]));
  nativeMarket.newcomer = { count_share: observation(0.2, 'fraction'), unit_sales_share: observation(0.3, 'fraction') };
  const mainBids = bids();
  for (const entry of mainBids.entries) {
    entry.sellersprite.value = 0.5;
    if (entry.sif) entry.sif.value = 0.5;
  }
  return {
    id, form: 'Synthetic concrete two-piece bundle', evidence: structuredClone(evidence),
    screening: { reference_price_usd: observation(40, 'USD', { matched_spec: true }), strong_date_dependency: observation(false, 'boolean') },
    metrics: {
      purchase_demand_scale: observation(5000, 'units', { niche: 'Synthetic niche', period: '2026-10-15/2026-11-13', grain: 'family', coverage_supported: true, deduplicated: true, window_days: 30, window_basis: 'latest_30_days' }),
      low_return_preference: observation(0.02, 'fraction', { category: 'Synthetic node', period: '2026-10', applicable: true }),
    },
    judgments: {
      supported_opportunity: judgment(6, { route: 'stable_demand' }), purchase_entry_match: judgment(6),
      existing_solution_fit: judgment(4), feasible_light_differentiation: judgment(1),
      storage_tolerance: judgment(2), transport_tolerance: judgment(2), routine_complexity: judgment(1),
      specific_design_rights: judgment(3), applicable_public_requirements: judgment(2),
    },
    market: nativeMarket, bids: mainBids, newcomer_cohort: cohort([member('family-a', 5, 100, 0.7), member('family-b', 5, 100, 0.7)]),
    economics: { saleable_unit: 'one synthetic bundle', scenarios: [scenario('base', 0.5, 20)] },
  };
}

test('a candidate with unknown evidence retains all 21 gaps without creating a total', () => {
  const result = scoreCandidate({ id: 'synthetic-unknown', form: 'Synthetic saleable form', evidence: [] }, profile);
  assert.equal(result.items.length, 21);
  assert.ok(result.items.every(item => item.score === null));
  assert.equal(result.total, null);
  assert.equal(result.total_range, null);
  assert.deepEqual(result.supported_range, [0, 0]);
  assert.equal(result.covered_weight, 0);
  assert.equal(result.unscored_weight, 100);
  assert.deepEqual(result.conditional_total_range, [0, 100]);
  assert.equal(result.queue, 'pending');
});

test('supported demand, return proxy and rubric anchors retain their original points and gaps', () => {
  const candidate = {
    id: 'synthetic-partial', form: 'Synthetic saleable form', evidence,
    metrics: {
      purchase_demand_scale: observation(1250, 'units', { niche: 'Synthetic substitutable niche', period: '2026-10-15/2026-11-13', grain: 'family', coverage_supported: true, deduplicated: true, window_days: 30, window_basis: 'latest_30_days' }),
      low_return_preference: observation(0.075, 'fraction', { category: 'Synthetic node', period: '2026-10', applicable: true }),
    },
    judgments: {
      supported_opportunity: judgment(4, { route: 'stable_demand' }),
      existing_solution_fit: judgment(3),
      specific_design_rights: judgment(2),
      transport_tolerance: { anchor: 2, reason: 'Unsearched assertion.', evidence: [] },
    },
  };
  const result = scoreCandidate(candidate, profile);
  assert.equal(item(result, 'purchase_demand_scale').score, 2.5);
  assert.equal(item(result, 'low_return_preference').score, 2.5);
  assert.equal(item(result, 'supported_opportunity').score, 4);
  assert.equal(item(result, 'existing_solution_fit').score, 3);
  assert.equal(item(result, 'specific_design_rights').score, null);
  assert.equal(item(result, 'transport_tolerance').score, null);
  assert.deepEqual(result.supported_range, [12, 12]);
  assert.equal(result.covered_weight, 18);
  assert.equal(result.total, null);
});

test('numeric observations distinguish a supported zero from invalid, wrong-unit and unsupported values', () => {
  for (const value of [null, '0.02', -0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = scoreCandidate({ id: 'synthetic-invalid', form: 'Synthetic form', evidence,
      metrics: { low_return_preference: observation(value, 'fraction', { category: 'Synthetic node', period: '2026-10', applicable: true }) } }, profile);
    assert.equal(item(result, 'low_return_preference').score, null, String(value));
  }
  const zero = scoreCandidate({ id: 'synthetic-zero', form: 'Synthetic form', evidence,
    metrics: { low_return_preference: observation(0, 'fraction', { category: 'Synthetic node', period: '2026-10', applicable: true }) } }, profile);
  assert.equal(item(zero, 'low_return_preference').score, 4);
  for (const invalid of [observation(0.02, 'percent'), observation(0.02, 'fraction', { evidence: ['not-found'] }), observation(0.02, 'fraction', { supported: false })]) {
    const result = scoreCandidate({ id: 'synthetic-invalid-boundary', form: 'Synthetic form', evidence,
      metrics: { low_return_preference: { ...invalid, category: 'Synthetic node', period: '2026-10', applicable: true } } }, profile);
    assert.equal(item(result, 'low_return_preference').score, null);
  }
});

test('the adopted numeric anchors, caps and continuous boundaries remain unchanged', () => {
  const cases = [
    ['refund_adjusted_pre_ad_margin', 0.3, 11], ['refund_adjusted_pre_ad_margin', 0.4, 16.5], ['refund_adjusted_pre_ad_margin', 0.7, 22],
    ['unit_contribution', 0, 0], ['unit_contribution', 10, 4], ['unit_contribution', 30, 8],
    ['relevant_purchase_entry_bid', 0.5, 15], ['relevant_purchase_entry_bid', 1.75, 7.5], ['relevant_purchase_entry_bid', 3, 0],
    ['purchase_demand_scale', 0, 0], ['purchase_demand_scale', 100, 1], ['purchase_demand_scale', 500, 2],
    ['purchase_demand_scale', 2000, 3], ['purchase_demand_scale', 10000, 4],
    ['product_dispersion', 0.4, 3], ['product_dispersion', 0.5, 2.25], ['brand_dispersion', 0.6, 1.5],
    ['seller_dispersion', 0.7, 1], ['seller_dispersion', 0.8, 0],
    ['new_product_count_share', 0.1, 1.5], ['new_product_count_share', 1, 3],
    ['new_product_sales_share', 0.15, 1], ['new_product_sales_share', 1, 2],
    ['low_return_preference', 0.02, 4], ['low_return_preference', 0.05, 3],
    ['low_return_preference', 0.1, 2], ['low_return_preference', 0.2, 1], ['low_return_preference', 0.3, 0], ['low_return_preference', 1, 0],
  ];
  for (const [id, value, expected] of cases) close(scoreNumericValue(id, value, profile), expected);
  assert.equal(scoreNumericValue('refund_adjusted_pre_ad_margin', 0.2999, profile), null);
  assert.equal(scoreNumericValue('new_product_count_share', 1.01, profile), null);
});

test('native concentration and newcomer shares use one labeled report without a cohort substitution', () => {
  const candidate = { id: 'synthetic-native', form: 'Synthetic form', evidence, market: market() };
  const result = scoreCandidate(candidate, profile);
  close(item(result, 'product_dispersion').score, 3);
  close(item(result, 'brand_dispersion').score, 1.5);
  close(item(result, 'seller_dispersion').score, 0);
  close(item(result, 'new_product_count_share').score, 1.5);
  close(item(result, 'new_product_sales_share').score, 1);
  assert.equal(result.covered_weight, 15);
  candidate.market.newcomer.count_share.report_id = 'different-report';
  candidate.market.newcomer_age_months = 6;
  candidate.market.concentrations.brand.value = 60;
  const incompatible = scoreCandidate(candidate, profile);
  assert.equal(item(incompatible, 'new_product_count_share').score, null);
  assert.equal(item(incompatible, 'new_product_sales_share').score, null);
  assert.equal(item(incompatible, 'brand_dispersion').score, null);
  assert.equal(item(incompatible, 'product_dispersion').score, 3);
});

test('exact bids average usable source points before monthly-entry weighting and preserve separate ranges', () => {
  const candidate = { id: 'synthetic-bids', form: 'Synthetic form', evidence, bids: bids() };
  const result = scoreCandidate(candidate, profile);
  const bidItem = item(result, 'relevant_purchase_entry_bid');
  close(bidItem.score, 10.5);
  close(bidItem.reference_bid_usd, 1.25);
  assert.equal(bidItem.entries[0].combined_point, 2);
  assert.equal(bidItem.entries[1].source_label, 'sellersprite_only');
  assert.deepEqual(bidItem.range_scenarios.sellersprite.bid_range_usd, [0.5, 1.5]);
  assert.deepEqual(bidItem.range_scenarios.sellersprite.score_range, [9, 15]);
  assert.equal(bidItem.range_scenarios.sif, null);
  candidate.bids.entries[0].sellersprite.low = 0;
  candidate.bids.entries[0].sellersprite.high = 20;
  assert.equal(item(scoreCandidate(candidate, profile), 'relevant_purchase_entry_bid').score, bidItem.score);
});

test('missing selected-entry inputs and duplicate queries do not disappear through bid reweighting', () => {
  const base = { id: 'synthetic-bid-gap', form: 'Synthetic form', evidence, bids: bids() };
  for (const change of [
    value => { value.bids.entries[1].volume.value = null; },
    value => { value.bids.entries[1].sellersprite.value = null; },
    value => { value.bids.entries[1].query = '  SYNTHETIC   FORM '; },
    value => { value.bids.entries.forEach(entry => { entry.volume.value = 0; }); },
  ]) {
    const candidate = structuredClone(base);
    change(candidate);
    assert.equal(item(scoreCandidate(candidate, profile), 'relevant_purchase_entry_bid').score, null);
  }
  const incompatible = structuredClone(base);
  incompatible.bids.entries[0].sellersprite.strategy = 'dynamic';
  const limited = item(scoreCandidate(incompatible, profile), 'relevant_purchase_entry_bid');
  assert.equal(limited.entries[0].combined_point, 3);
  assert.equal(limited.entries[0].source_label, 'sif_only');
});

test('newcomer medians retain weak outcomes and the selected low-rating pair supplies natural visibility', () => {
  const result = scoreCandidate({ id: 'synthetic-cohort', form: 'Synthetic form', evidence, newcomer_cohort: cohort() }, profile);
  close(item(result, 'low_rating_sales_performance').score, 3.75);
  close(item(result, 'natural_visibility_development').score, 0.75);
  assert.equal(result.diagnostics.newcomers.references.rating_median, 20);
  assert.equal(result.diagnostics.newcomers.references.sales_median, 40);
  assert.deepEqual(result.diagnostics.newcomers.selected_pair.map(entry => entry.family_id), ['family-a', 'family-b']);
  const weak = result.diagnostics.newcomers.examples.find(entry => entry.family_id === 'family-c');
  close(weak.actual_score, 0.75);
  close(weak.relative_score, 0.25);
  close(weak.sales_ceiling, 1.5);
  close(weak.score, 1);
});

test('ties use frozen identities and a missing natural share does not select a different example', () => {
  const members = [member('family-z', 5, 100, 1), member('family-b', 5, 100, 0.35), member('family-a', 5, 100, null)];
  members[2].natural.reason = 'Synthetic missing source share.';
  const candidate = { id: 'synthetic-fixed-pair', form: 'Synthetic form', evidence, newcomer_cohort: cohort(members) };
  const result = scoreCandidate(candidate, profile);
  assert.deepEqual(result.diagnostics.newcomers.selected_pair.map(entry => entry.family_id), ['family-a', 'family-b']);
  assert.equal(item(result, 'low_rating_sales_performance').score, 4);
  const natural = item(result, 'natural_visibility_development');
  assert.equal(natural.score, null);
  assert.deepEqual(natural.conditional_range, [0.25, 0.75]);
  assert.deepEqual(result.supported_range, [4, 4]);
  assert.equal(result.covered_weight, 4);
  assert.deepEqual(result.conditional_total_range, [4.25, 99.75]);
});

test('supported zero sales can enter the pair while zero references and single cases remain incomplete', () => {
  const weakPair = scoreCandidate({ id: 'synthetic-weak-pair', form: 'Synthetic form', evidence,
    newcomer_cohort: cohort([member('family-a', 5, 0, 0.35), member('family-b', 20, 100, 0.7)]) }, profile);
  close(item(weakPair, 'low_rating_sales_performance').score, 1.5625);
  assert.equal(item(weakPair, 'natural_visibility_development').score, 0.75);
  for (const members of [
    [member('family-a', 0, 10, 0.7), member('family-b', 0, 20, 0.7)],
    [member('family-a', 5, 0, 0.7), member('family-b', 20, 0, 0.7)],
    [member('family-a', 5, 100, 0.7)],
  ]) {
    const result = scoreCandidate({ id: 'synthetic-incomplete-cohort', form: 'Synthetic form', evidence, newcomer_cohort: cohort(members) }, profile);
    assert.equal(item(result, 'low_rating_sales_performance').score, null);
    assert.equal(item(result, 'natural_visibility_development').score, null);
    assert.ok(result.diagnostics.newcomers.examples.length > 0);
  }
});

test('old-review exclusions and family deduplication affect the cohort without rewriting native shares', () => {
  const original = member('family-a', 5, 100, 0.7);
  const candidate = { id: 'synthetic-cohort-exclusions', form: 'Synthetic form', evidence, market: market(),
    newcomer_cohort: cohort([original, { ...structuredClone(original), asin: 'alternate-child' }, member('family-b', 5, 100, 0.7, { old_reviews_predate_launch: true })]) };
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.diagnostics.newcomers.examples.length, 1);
  assert.equal(item(result, 'low_rating_sales_performance').score, null);
  assert.equal(item(result, 'new_product_count_share').score, 1.5);
  assert.ok(result.diagnostics.newcomers.members.some(entry => entry.effective_status === 'excluded' && entry.reason.includes('old reviews')));
});

test('all 21 supported items yield a complete original-weight total with resolved screening', () => {
  const result = scoreCandidate(completeCandidate(), profile);
  assert.equal(result.total, 100);
  assert.deepEqual(result.total_range, [100, 100]);
  assert.equal(result.covered_weight, 100);
  assert.equal(result.unscored_weight, 0);
  assert.ok(result.items.every(entry => entry.status === 'scored'));
  assert.ok(result.items.every(entry => entry.evidence.length > 0));
  assert.equal(result.screening.status, 'eligible');
  assert.equal(result.queue, 'comparable');
});

test('whole totals preserve the dependence between margin and contribution in each economic scenario', () => {
  const candidate = completeCandidate('synthetic-coherent');
  candidate.economics.scenarios = [scenario('higher-margin', 0.4, 10), scenario('higher-contribution', 0.35, 15)];
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.total, null);
  close(result.total_range[0], 89.75);
  close(result.total_range[1], 90.5);
  close(result.groups.find(group => group.id === 'profit').score_range[0], 19.75);
  close(result.groups.find(group => group.id === 'profit').score_range[1], 20.5);
  assert.equal(result.covered_weight, 100);
  assert.equal(result.queue, 'comparable');
  candidate.economics.scenarios[1].contribution_usd.value = null;
  candidate.economics.scenarios[1].contribution_usd.reason = 'Synthetic unavailable cost calculation.';
  const partial = scoreCandidate(candidate, profile);
  assert.equal(item(partial, 'refund_adjusted_pre_ad_margin').status, 'scored');
  assert.equal(item(partial, 'unit_contribution').score, null);
  assert.equal(partial.covered_weight, 92);
  assert.equal(partial.total_range, null);
  close(partial.supported_range[0], 83.75);
  close(partial.conditional_total_range[1], 91.75);
});

test('margin failures and crossing/missing scenarios remain distinct from an eligible floor result', () => {
  const candidate = completeCandidate('synthetic-margin-screen');
  candidate.economics.scenarios = [scenario('at-floor', 0.3, 20)];
  assert.equal(scoreCandidate(candidate, profile).total, 89);
  candidate.economics.scenarios = [scenario('failed', 0.29, 10)];
  const failed = scoreCandidate(candidate, profile);
  assert.equal(failed.screening.status, 'excluded');
  assert.equal(item(failed, 'refund_adjusted_pre_ad_margin').score, null);
  assert.equal(item(failed, 'unit_contribution').score, null);
  assert.equal(failed.total, null);
  assert.equal(failed.conditional_total_range, null);
  candidate.economics.scenarios.push(scenario('eligible', 0.4, 10));
  const crossing = scoreCandidate(candidate, profile);
  assert.equal(crossing.screening.status, 'pending');
  assert.equal(crossing.total, null);
  assert.equal(crossing.covered_weight, 70);
  assert.deepEqual(crossing.supported_range, [70, 70]);
  assert.deepEqual(crossing.conditional_total_range, [70, 100]);
  candidate.economics.scenarios[0].margin.value = null;
  const unknown = scoreCandidate(candidate, profile);
  assert.equal(unknown.screening.status, 'pending');
  assert.equal(item(unknown, 'refund_adjusted_pre_ad_margin').score, null);
});

test('batch queues use conservative complete ranges and supported pending points with stable ties', () => {
  const pointCandidate = completeCandidate('point-leader');
  pointCandidate.economics.scenarios = [scenario('point', 0.4, 10)]; // 90.5
  const rangeCandidate = completeCandidate('supported-range');
  rangeCandidate.economics.scenarios = [scenario('low', 0.35, 15), scenario('high', 0.5, 20)]; // 89.75..100
  const pendingHigh = completeCandidate('pending-high');
  delete pendingHigh.economics;
  const pendingTie = completeCandidate('pending-tie');
  delete pendingTie.economics;
  const unknown = { id: 'unknown-heavy', form: 'Synthetic form', evidence: [] };
  const excluded = completeCandidate('rights-conflict');
  excluded.judgments.specific_design_rights = judgment(0);
  const deferred = completeCandidate('date-dependent');
  deferred.screening.strong_date_dependency.value = true;
  const batch = { schema_version: 1, profile_revision: 50, candidates: [rangeCandidate, unknown, pendingHigh, pendingTie, deferred, excluded, pointCandidate] };
  const before = JSON.stringify(batch);
  const result = scoreBatch(batch, profile);
  assert.deepEqual(result.order.comparable, ['point-leader', 'supported-range']);
  assert.deepEqual(result.order.pending, ['pending-high', 'pending-tie', 'unknown-heavy']);
  assert.deepEqual(result.order.deferred, ['date-dependent']);
  assert.deepEqual(result.order.excluded, ['rights-conflict']);
  assert.equal(result.candidates.find(value => value.candidate_id === 'pending-high').may_exceed_comparable_leader, true);
  assert.equal(result.candidates.find(value => value.candidate_id === 'unknown-heavy').supported_score, 0);
  assert.equal(result.summary.complete, 2);
  assert.equal(result.summary.pending, 3);
  assert.equal(JSON.stringify(batch), before);
  assert.deepEqual(scoreBatch(batch, profile), result);
});

test('screening is independent of scores and incompatible economic records cannot manufacture totals', () => {
  for (const change of [
    candidate => { candidate.screening.reference_price_usd.value = 30; },
    candidate => { candidate.screening.reference_price_usd.matched_spec = false; },
    candidate => { candidate.judgments.specific_design_rights.anchor = null; },
    candidate => { candidate.economics.scenarios[0].saleable_unit = 'a different bundle'; },
    candidate => { candidate.economics.scenarios[0].coherent = false; },
    candidate => { candidate.economics.scenarios.push(structuredClone(candidate.economics.scenarios[0])); },
  ]) {
    const candidate = completeCandidate();
    change(candidate);
    const result = scoreCandidate(candidate, profile);
    assert.equal(result.total, null);
    assert.notEqual(result.queue, 'comparable');
  }
  assert.throws(() => scoreBatch({ schema_version: 1, profile_revision: 50, candidates: [completeCandidate('duplicate'), completeCandidate('duplicate')] }, profile), TypeError);
  assert.throws(() => scoreBatch({ candidates: [] }, profile), TypeError);
  assert.throws(() => scoreCandidate(completeCandidate(), { ...profile, revision: 49 }), TypeError);
});

test('invalid dates and duplicated evidence IDs cannot turn an assertion into supported points', () => {
  for (const invalidEvidence of [
    [{ ...evidence[0], observed_at: '2026-02-30' }],
    [{ ...evidence[0], observed_at: '11/13/2026' }],
    [evidence[0], { ...evidence[0], source: '' }],
  ]) {
    const candidate = completeCandidate('synthetic-invalid-evidence');
    candidate.evidence = invalidEvidence;
    assert.equal(scoreCandidate(candidate, profile).covered_weight, 0);
  }
});

test('transitively shared launches never supply independent exemplars', () => {
  const candidate = { id: 'synthetic-shared-launch', form: 'Synthetic form', evidence,
    newcomer_cohort: cohort([
      member('family-a', 5, 100, 0.7, { shared_launch_id: 'launch-x' }),
      member('family-b', 5, 100, 0.7, { shared_launch_id: 'launch-x' }),
      member('family-b', 5, 100, 0.7, { shared_launch_id: 'launch-y', asin: 'family-b-other' }),
      member('family-c', 5, 100, 0.7, { shared_launch_id: 'launch-y' }),
    ]) };
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.diagnostics.newcomers.qualified_deduplicated_count, 1);
  assert.equal(item(result, 'low_rating_sales_performance').score, null);
});

test('ordinary cross-source keyword differences do not replace exposure shares or add a penalty', () => {
  const candidate = completeCandidate('synthetic-count-corroboration');
  for (const entry of candidate.newcomer_cohort.members) {
    entry.natural.keyword_counts = {
      sellersprite: { organic: observation(100, 'count'), ad: observation(5, 'count') },
      sif: { organic: observation(10, 'count'), ad: observation(50, 'count') },
    };
  }
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.total, 100);
  assert.equal(result.diagnostics.newcomers.examples[0].natural.source_label, 'sif_with_sellersprite_corroboration');
  candidate.newcomer_cohort.members[0].natural.value = null;
  assert.equal(item(scoreCandidate(candidate, profile), 'natural_visibility_development').score, null);
});

test('zero native denominators and malformed profile groups are rejected at the declared boundary', () => {
  const candidate = completeCandidate('synthetic-zero-denominator');
  candidate.market.newcomer.unit_sales_share.denominator = 0;
  const result = scoreCandidate(candidate, profile);
  assert.equal(item(result, 'new_product_sales_share').score, null);
  assert.equal(result.total, null);
  for (const change of [
    value => { value.group_budgets[0].id = 'different-group'; },
    value => { value.production_eligible = true; },
    value => { value.group_budgets[0].items[0].mapping.full_score_at = 0.3; },
  ]) {
    const invalidProfile = structuredClone(profile);
    change(invalidProfile);
    assert.throws(() => scoreCandidate(completeCandidate(), invalidProfile), TypeError);
  }
});

test('empty batches stay empty and equal pending points use covered weight before stable input order', () => {
  const empty = scoreBatch({ schema_version: 1, profile_revision: 50, candidates: [] }, profile);
  assert.equal(empty.summary.candidates, 0);
  assert.deepEqual(empty.candidates, []);
  const partial = (id, dimension) => {
    const native = market();
    native.concentrations = { [dimension]: observation(0.8, 'fraction') };
    native.newcomer = {};
    return { id, form: 'Synthetic form', evidence, market: native };
  };
  const result = scoreBatch({ schema_version: 1, profile_revision: 50,
    candidates: [partial('covered-three', 'product'), partial('covered-four-first', 'seller'), partial('covered-four-second', 'seller')] }, profile);
  assert.deepEqual(result.order.pending, ['covered-four-first', 'covered-four-second', 'covered-three']);
  assert.ok(result.candidates.every(candidate => candidate.total === null && candidate.supported_score === 0));
});

test('a missing rubric anchor preserves its actual evidence gap while a non-null illegal anchor is rejected', () => {
  const candidate = completeCandidate('synthetic-null-judgment');
  candidate.judgments.specific_design_rights = judgment(null, { reason: 'Synthetic exact-form claim status has not been retrieved.' });
  const absent = item(scoreCandidate(candidate, profile), 'specific_design_rights');
  assert.equal(absent.score, null);
  assert.equal(absent.reason, 'Synthetic exact-form claim status has not been retrieved.');
  candidate.judgments.specific_design_rights.anchor = 1;
  assert.match(item(scoreCandidate(candidate, profile), 'specific_design_rights').reason, /adopted rubric anchor/);
});

test('the US bid trial rejects a different marketplace even when its currency is labeled USD', () => {
  const candidate = completeCandidate('synthetic-wrong-market');
  candidate.bids.marketplace = 'UK';
  const result = scoreCandidate(candidate, profile);
  assert.equal(item(result, 'relevant_purchase_entry_bid').score, null);
  assert.equal(result.total, null);
});

test('same-record margin and contribution must have compatible signs and zero under positive revenue', () => {
  for (const [margin, contribution] of [[0.5, 0], [0.5, -1], [0, 1], [0, -1], [-0.2, 0], [-0.2, 1]]) {
    const candidate = completeCandidate('synthetic-contradictory-tuple');
    candidate.economics.scenarios = [scenario('inconsistent', margin, contribution)];
    const result = scoreCandidate(candidate, profile);
    assert.equal(result.queue, 'pending', `${margin}, ${contribution}`);
    assert.equal(item(result, 'refund_adjusted_pre_ad_margin').score, null);
    assert.equal(item(result, 'unit_contribution').score, null);
    assert.equal(result.total, null);
  }
  const loss = completeCandidate('synthetic-consistent-loss');
  loss.economics.scenarios = [scenario('loss', -0.2, -4)];
  assert.equal(scoreCandidate(loss, profile).queue, 'excluded');
});

test('invalid economic records cannot expose eligible diagnostic scores or a margin-pass claim', () => {
  for (const change of [
    candidate => { candidate.economics.scenarios[0].coherent = false; },
    candidate => { candidate.economics.scenarios[0].saleable_unit = 'a different saleable bundle'; },
    candidate => { delete candidate.economics.scenarios[0].assumptions; },
    candidate => { candidate.economics.scenarios.push(structuredClone(candidate.economics.scenarios[0])); },
  ]) {
    const candidate = completeCandidate('synthetic-invalid-economic-record');
    change(candidate);
    const result = scoreCandidate(candidate, profile);
    assert.equal(result.queue, 'pending');
    assert.equal(result.total, null);
    for (const diagnostic of result.diagnostics.economics.scenarios) {
      assert.equal(diagnostic.margin_eligible, false);
      assert.equal(diagnostic.coherence_supported, false);
      assert.equal(diagnostic.margin_score, null);
      assert.equal(diagnostic.contribution_score, null);
      assert.ok(diagnostic.eligibility_reason);
    }
  }
  const supported = scoreCandidate(completeCandidate('synthetic-supported-record'), profile);
  assert.equal(supported.total, 100);
  assert.equal(supported.diagnostics.economics.scenarios[0].coherence_supported, true);
  assert.equal(supported.diagnostics.economics.scenarios[0].margin_eligible, true);
});
