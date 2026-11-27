import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreBatch,
  scoreCandidate,
  scoreNumericValue,
  evalGreedyFRat,
  computeStratifiedBoundsRat,
  selectStratifiedNewcomers,
  resolveScenarioComparabilityLinkage,
  UNPUBLISHED_2027_Q4_PEAK_METADATA_NOTE,
} from '../src/scoring.mjs';
import { applyPeerComparabilityRulings } from '../src/pipeline.mjs';
import {
  buildPairedSeasonalOperatingPeriods,
  buildEvergreen2027OffPeakEconomics,
  ingestSellerSpriteMonthlyArchiveMarket,
  ingestTrialSpecification,
  resolveStage1QualitativeJudgments,
} from '../src/raw-ingest.mjs';
import { renderReport } from '../src/report.mjs';
import {
  loadR59Profile,
  loadSyntheticBatch,
  makeSeasonalCandidate,
  makeStage4OrganizerTrayCandidate,
} from './helpers/test-fixtures.mjs';

const profile = loadR59Profile();
const batchFixture = loadSyntheticBatch();
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
  natural: observation(share, 'fraction', {
    scope: 'overall', period: '2026-10-15/2026-11-13', relevant_entries_evidence: ['synthetic-source'],
    keyword_counts: {
      sellersprite: { organic: observation(20, 'count'), ad: observation(10, 'count') },
      sif: { organic: observation(24, 'count'), ad: observation(12, 'count') },
    },
  }),
  launch_date: '2026-10-01',
  current_bsr_node: 'synthetic-node',
  current_bsr_rank: 20,
  comparability_verdict: 'comparable',
  ...extra,
});

const cohort = (members = [member('family-a', 5, 100, 0.7), member('family-b', 5, 100, 0.7)]) => ({
  observation_basis: 'current_latest_30_days', observation_date: '2026-11-13', period: '2026-10-15/2026-11-13',
  niche: 'Synthetic substitutable niche', grain: 'family', relevant_bsr_node: 'synthetic-node',
  scope: 'current_relevant_bsr_top100', query_complete: true,
  reference_supported: true, evidence: ['synthetic-source'], members,
  market_reference: {
    scope: 'current_relevant_bsr_top100_all_ages',
    node: 'synthetic-node',
    period: '2026-10-15/2026-11-13',
    grain: 'family',
    deduplicated: true,
    coverage_supported: true,
    evidence: ['synthetic-source'],
    families: [
      { family_id: 'synthetic-old-a', units_30d: observation(50, 'units'), comparability_verdict: 'comparable' },
      { family_id: 'synthetic-old-b', units_30d: observation(50, 'units'), comparability_verdict: 'comparable' },
      { family_id: 'synthetic-old-c', units_30d: observation(50, 'units'), comparability_verdict: 'comparable' },
    ],
  },
});

const publishedBasis = () => ({
  status: 'published',
  version: 'SYNTHETIC-2027-annual',
  marketplace: 'US',
  currency: 'USD',
  package_ref: 'synthetic-pack',
  effective_from: '2027-01-01',
  effective_through: '2027-12-31',
  evidence: ['synthetic-source'],
});

function buildCostLedger(id, margin, contribution) {
  if (typeof margin !== 'number' || typeof contribution !== 'number') return null;
  if (!((margin > 0 && contribution > 0) || (margin < 0 && contribution < 0))) return null;
  const rawNetRevenue = contribution / margin;
  if (!(rawNetRevenue > 0)) return null;
  const priceUsd = rawNetRevenue >= 80 ? Number(rawNetRevenue.toFixed(12)) : 80;
  const refundFraction = rawNetRevenue >= 80 ? 0 : Number((1 - rawNetRevenue / priceUsd).toFixed(15));
  const effectiveNetRevenue = priceUsd * (1 - refundFraction);
  const referralUsd = 2;
  const fulfillmentUsd = 2;
  const placementUsd = 0.5;
  const storageUsd = 0.5;
  const headhaulUsd = 1;
  const refundAdminUsd = refundFraction > 0 ? refundFraction * Math.min(5, referralUsd * 0.2) : 0;
  const nonGoods = referralUsd * (1 - refundFraction) + refundAdminUsd + fulfillmentUsd + placementUsd + storageUsd + headhaulUsd;
  const procurementUsd = Number((effectiveNetRevenue - contribution - nonGoods).toFixed(12));
  if (procurementUsd < 0) return null;
  return {
    id,
    saleable_unit: 'one synthetic bundle',
    price_usd: priceUsd,
    refund_fraction: refundFraction,
    ...(refundFraction > 0 ? { physical_return_fraction: 0.02 } : {}),
    assumptions: ['Synthetic supported matched-spec economic scenario.'],
    referral_terms: { referral_fraction: Number((referralUsd / priceUsd).toFixed(12)), refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
    collection_rate: 0,
    fee_context: {
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'synthetic-pack',
      sales: { from: '2027-01-01', through: '2027-12-31' },
      storage: { from: '2027-01-01', through: '2027-12-31' },
      inbound: { from: '2027-01-15', through: '2027-01-15' },
    },
    lines: [
      { id: 'procurement', amount_usd: procurementUsd, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], order_units: 100, first_order_promotion: false, components: ['procurement'] },
      { id: 'domestic_freight', amount_usd: 0, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], order_units: 100, first_order_promotion: false, components: ['domestic_freight'] },
      { id: 'headhaul', amount_usd: headhaulUsd, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['headhaul', 'carrier_bond'] },
      { id: 'referral', amount_usd: referralUsd, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['referral'], fee_basis: publishedBasis() },
      { id: 'fulfillment', amount_usd: fulfillmentUsd, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['fulfillment'], fee_basis: publishedBasis() },
      { id: 'placement', amount_usd: placementUsd, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['placement'], fee_basis: publishedBasis() },
      { id: 'storage', amount_usd: storageUsd, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['storage'], fee_basis: publishedBasis() },
      { id: 'returns_processing', amount_usd: 0, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['returns_processing'], fee_basis: publishedBasis(), return_threshold: 0.05 },
      { id: 'returns_disposal', amount_usd: 0, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['returns_disposal'] },
      { id: 'collection', amount_usd: 0, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['collection'] },
      { id: 'other_applicable', amount_usd: 0, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['other_applicable'], fee_basis: publishedBasis() },
      { id: 'recovery_credit', amount_usd: 0, status: 'estimated', basis: 'Synthetic', evidence: ['synthetic-source'], components: ['recovery_credit'] },
    ],
  };
}

const scenario = (id, margin, contribution) => {
  const ledger = buildCostLedger(id, margin, contribution);
  return {
    id,
    saleable_unit: 'one synthetic bundle',
    coherent: true,
    assumptions: ['Synthetic supported matched-spec economic scenario.'],
    margin: observation(margin, 'fraction'),
    contribution_usd: observation(contribution, 'USD'),
    ...(ledger ? { cost_ledger: ledger } : {}),
  };
};

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
    screening: {
      reference_price_usd: observation(80, 'USD', {
        matched_spec: true,
        target_variant_asin: 'SYNTHETIC-VAR',
        fulfillment_channel: 'FBA',
        sales_history_supported: true,
      }),
      strong_date_dependency: observation(false, 'boolean'),
    },
    metrics: {
      purchase_demand_scale: observation(5000, 'units', { niche: 'Synthetic niche', period: '2026-10-15/2026-11-13', grain: 'parent_units', coverage_supported: true, deduplicated: true, window_days: 30, window_basis: 'latest_30_days' }),
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

test('supported demand intervals preserve score and total ranges without inventing a point', () => {
  const candidate = completeCandidate();
  Object.assign(candidate.metrics.purchase_demand_scale, {
    value: null, value_range: [100, 500], coherent: true,
    range_basis: 'Synthetic bounds for the same observed niche, period and family population.',
  });
  const result = scoreCandidate(candidate, profile);
  const demand = item(result, 'purchase_demand_scale');
  assert.equal(demand.status, 'scored');
  assert.equal(demand.score, null);
  assert.deepEqual(demand.score_range, [1, 2]);
  assert.equal(result.covered_weight, 100);
  assert.equal(result.total, null);
  assert.deepEqual(result.total_range, [97, 98]);
});

test('a candidate with unknown evidence retains all 21 gaps without creating a total', () => {
  const result = scoreCandidate({ id: 'synthetic-unknown', form: 'Synthetic saleable form', evidence: [] }, profile);
  assert.equal(result.items.length, 21);
  assert.ok(result.items.every(item => item.score === null));
  assert.equal(result.total, null);
  assert.equal(result.total_range, null);
  assert.deepEqual(result.supported_range, [0, 0]);
  assert.equal(result.covered_weight, 0);
  assert.equal(result.unscored_weight, 100);
  assert.equal(result.conditional_total_range, null);
  assert.equal(result.queue, 'pending');
});

test('unsupported or contradictory demand ranges remain evidence gaps and capped ranges can have one score', () => {
  const candidate = completeCandidate();
  const metric = candidate.metrics.purchase_demand_scale;
  Object.assign(metric, { value: null, value_range: [5000, 7000], coherent: true, range_basis: 'Synthetic same-population bounds.' });
  const capped = scoreCandidate(candidate, profile);
  assert.equal(item(capped, 'purchase_demand_scale').score, 4);
  assert.equal(capped.total, 100);
  for (const patch of [
    { value_range: [500, 100] }, { value_range: [-1, 500] }, { value_range: [100, null] },
    { value_range: [100, '500'] }, { value_range: [100, Infinity] }, { value_range: [100] },
    { value: 500 }, { coherent: false }, { range_basis: '' }, { unit: 'USD' },
    { evidence: [] }, { supported: false }, { material_conflict: true }, { coverage_supported: false },
  ]) {
    const invalid = structuredClone(candidate);
    Object.assign(invalid.metrics.purchase_demand_scale, patch);
    const result = scoreCandidate(invalid, profile);
    assert.equal(item(result, 'purchase_demand_scale').status, 'needs_evidence', JSON.stringify(patch));
    assert.equal(result.total_range, null);
    assert.equal(result.covered_weight, 96);
  }
});

test('supported demand, return proxy and rubric anchors retain their original points and gaps', () => {
  const candidate = {
    id: 'synthetic-partial', form: 'Synthetic saleable form', evidence,
    metrics: {
      purchase_demand_scale: observation(1250, 'units', { niche: 'Synthetic substitutable niche', period: '2026-10-15/2026-11-13', grain: 'parent_units', coverage_supported: true, deduplicated: true, window_days: 30, window_basis: 'latest_30_days' }),
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

test('old-review exclusions and family deduplication affect the cohort without rewriting native shares', () => {
  const original = member('family-a', 5, 100, 0.7);
  const candidate = { id: 'synthetic-cohort-exclusions', form: 'Synthetic form', evidence, market: market(),
    newcomer_cohort: cohort([original, { ...structuredClone(original), asin: 'alternate-child' }, member('family-b', 5, 100, 0.7, { old_reviews_predate_launch: true, reason: undefined })]) };
  const result = scoreCandidate(candidate, profile);
  assert.equal(result.diagnostics.newcomers.examples.length, 1);
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
  delete candidate.economics.scenarios[1].cost_ledger;
  candidate.economics.scenarios[1].contribution_usd.value = null;
  candidate.economics.scenarios[1].contribution_usd.reason = 'Synthetic unavailable cost calculation.';
  const partial = scoreCandidate(candidate, profile);
  assert.equal(partial.total_range, null);
  assert.equal(partial.queue, 'pending');
});

test('margin failures and r59 crossing/missing scenarios remain distinct from an eligible floor result', () => {
  const candidate = completeCandidate('synthetic-margin-screen');
  candidate.economics.scenarios = [scenario('at-floor', 0.3, 15)];
  assert.equal(scoreCandidate(candidate, profile).total, 87);
  candidate.economics.scenarios = [scenario('failed', 0.29, 10)];
  const failed = scoreCandidate(candidate, profile);
  assert.equal(failed.screening.status, 'excluded');
  assert.equal(item(failed, 'refund_adjusted_pre_ad_margin').score, null);
  assert.equal(item(failed, 'unit_contribution').score, null);
  assert.equal(failed.total, null);
  assert.equal(failed.conditional_total_range, null);
  candidate.economics.scenarios.push(scenario('eligible', 0.4, 10));
  const crossing = scoreCandidate(candidate, profile);
  assert.equal(crossing.screening.status, 'crossing_eligible');
  assert.equal(crossing.qualification.counts_toward_target, false);
  assert.equal(crossing.covered_weight, 100);
  delete candidate.economics.scenarios[0].cost_ledger;
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
  delete pendingHigh.bids;
  const pendingTie = completeCandidate('pending-tie');
  delete pendingTie.bids;
  const unknown = { id: 'unknown-heavy', form: 'Synthetic form', evidence: [] };
  const excluded = completeCandidate('rights-conflict');
  excluded.judgments.specific_design_rights = judgment(0);
  const deferred = completeCandidate('date-dependent');
  deferred.screening.strong_date_dependency.value = true;
  const batch = { schema_version: 1, profile_revision: 59, candidates: [rangeCandidate, unknown, pendingHigh, pendingTie, deferred, excluded, pointCandidate] };
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

test('screening is independent of scores, incompatible economic records cannot manufacture totals, and <59 revisions are rejected', () => {
  for (const change of [
    candidate => { candidate.screening.reference_price_usd.value = 29.98; },
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
  assert.throws(() => scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [completeCandidate('duplicate'), completeCandidate('duplicate')] }, profile), TypeError);
  assert.throws(() => scoreBatch({ candidates: [] }, profile), TypeError);
  assert.throws(() => scoreCandidate(completeCandidate(), { ...profile, revision: 58 }), TypeError);
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
  const empty = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [] }, profile);
  assert.equal(empty.summary.candidates, 0);
  assert.deepEqual(empty.candidates, []);
  const partial = (id, dimension) => {
    const native = market();
    native.concentrations = { [dimension]: observation(0.8, 'fraction') };
    native.newcomer = {};
    return { id, form: 'Synthetic form', evidence, market: native };
  };
  const result = scoreBatch({ schema_version: 1, profile_revision: 59,
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

// --- Migrated from test/revision58.test.mjs (active r59 scoring, Q31 BigInt/stratification, and Codex regressions) ---

test('Router 4-state expected_primary_scenarios prevents dropped-scenario false passes', () => {
  assert.equal(profile.revision, 59);

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

test('r59 flat annual mode rejects partial-year windows and report.mjs consumes qualification without self-judging', () => {
  const annual = structuredClone(batchFixture.candidates[0]);
  annual.id = 'annual-full';
  const rAnnual = scoreCandidate(annual, profile);
  assert.equal(rAnnual.queue, 'comparable');
  assert.equal(rAnnual.qualification.counts_toward_target, true);
  assert.equal(rAnnual.qualification.mode, 'comparable');

  for (const from of ['2027-03-01', '2027-02-02']) {
    const partial = structuredClone(batchFixture.candidates[0]);
    partial.id = `flat-partial-${from}`;
    partial.economics.scenarios[0].cost_ledger.fee_context.sales = { from, through: '2027-08-31' };
    partial.economics.scenarios[0].cost_ledger.fee_context.storage = { from, through: '2027-08-31' };
    const batch = { schema_version: 1, profile_revision: 59, candidates: [partial] };
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

  const partialFail = structuredClone(batchFixture.candidates[0]);
  partialFail.id = 'flat-partial-excluded';
  partialFail.economics.scenarios[0].cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
  partialFail.economics.scenarios[0].cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  partialFail.judgments.specific_design_rights.anchor = 0;
  const failOut = scoreCandidate(partialFail, profile);
  assert.equal(failOut.queue, 'excluded');
  assert.equal(failOut.qualification.counts_toward_target, false);

  const batchFull = { schema_version: 1, profile_revision: 59, candidates: [annual] };
  const scoredFull = scoreBatch(batchFull, profile);
  scoredFull.candidates[0].qualification.counts_toward_target = false;
  const tamperedHtml = renderReport(scoredFull, batchFull);
  assert.match(tamperedHtml, /data-eligible="false"/);
  assert.match(tamperedHtml, /达标可推进 0/);
});

test('r59 isolates stress_scenarios[] from 21-item score and renders stress section, landed cap, and break-even click CVR', () => {
  const c = makeSeasonalCandidate('stress-iso');
  const fbmStress = structuredClone(c.economics.operating_periods[0].scenarios[0]);
  fbmStress.id = fbmStress.cost_ledger.id = 'fbm-48-99-stress';
  fbmStress.label = 'FBM $48.99 价格带压力情景';
  fbmStress.stress_type = 'fbm_price_defense';
  fbmStress.cost_ledger.price_usd = 48.99;
  fbmStress.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 28;
  c.economics.operating_periods[0].stress_scenarios = [fbmStress];

  const batch = { schema_version: 1, profile_revision: 59, candidates: [c] };
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

test('r59 is strictly permutation-invariant across period order and candidate order for all 6 queues and report HTML', () => {
  const compA = structuredClone(batchFixture.candidates[0]);
  compA.id = 'cand-comp-a';
  compA.label = '全年可比 A';
  const compB = structuredClone(batchFixture.candidates[0]);
  compB.id = 'cand-comp-b';
  compB.label = '全年可比 B';

  const seasEligA = makeSeasonalCandidate('cand-seas-elig-a', { reversePeriods: false });
  const seasEligB = makeSeasonalCandidate('cand-seas-elig-b', { reversePeriods: true });

  const seasPendA = makeSeasonalCandidate('cand-seas-pend-a', { offPeakFrom: '2027-02-02', reversePeriods: false });
  const seasPendB = makeSeasonalCandidate('cand-seas-pend-b', { offPeakFrom: '2027-02-02', reversePeriods: true });

  const pendA = structuredClone(batchFixture.candidates[2]);
  pendA.id = 'cand-pend-a';
  const pendB = structuredClone(batchFixture.candidates[2]);
  pendB.id = 'cand-pend-b';

  const defA = structuredClone(batchFixture.candidates[0]);
  defA.id = 'cand-def-a';
  defA.screening.strong_date_dependency.value = true;
  const defB = structuredClone(batchFixture.candidates[0]);
  defB.id = 'cand-def-b';
  defB.screening.strong_date_dependency.value = true;

  const exclA = structuredClone(batchFixture.candidates[0]);
  exclA.id = 'cand-excl-a';
  exclA.judgments.specific_design_rights.anchor = 0;
  const exclB = structuredClone(batchFixture.candidates[0]);
  exclB.id = 'cand-excl-b';
  exclB.judgments.specific_design_rights.anchor = 0;

  const list1 = [compA, compB, seasEligA, seasEligB, pendA, pendB, seasPendA, seasPendB, defA, defB, exclA, exclB];
  const list2 = [...list1].reverse().map(c => {
    const clone = structuredClone(c);
    if (clone.economics?.operating_periods) clone.economics.operating_periods.reverse();
    return clone;
  });

  const batch1 = { schema_version: 1, profile_revision: 59, candidates: list1 };
  const batch2 = { schema_version: 1, profile_revision: 59, candidates: list2 };
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

test('r59 Q31 exact rational greedy F(S) resolves JS float tie 0.18x3, T=0/9.9/10 continuity, missing T pending, US calendar age_days, and 4+1 shared S* & D', () => {
  assert.ok((0.18 + 0.18 + 0.18) / 3 > 0.18);
  const greedyTie = evalGreedyFRat(
    [{ family_id: 'f1', asin: 'a1', e_rat: rat(18, 100) }, { family_id: 'f2', asin: 'a2', e_rat: rat(18, 100) }],
    [{ family_id: 'r1', asin: 'ra1', e_rat: rat(18, 100) }],
  );
  assert.equal(greedyTie.selected.length, 2);
  assert.equal(greedyTie.rejected_ramp_up.length, 1);
  assert.equal(greedyTie.denominator, 2);

  for (const [tVal, expectFloor] of [[0, true], [9.9, true], [10, false]]) {
    const c = structuredClone(batchFixture.candidates[0]);
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

  const missingT = structuredClone(batchFixture.candidates[0]);
  missingT.newcomer_cohort.market_reference.families = [];
  const resMissingT = scoreCandidate(missingT, profile);
  assert.equal(resMissingT.items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  assert.equal(resMissingT.queue, 'pending');

  const tzCand = structuredClone(batchFixture.candidates[0]);
  tzCand.newcomer_cohort.observation_date = '2026-11-17';
  tzCand.newcomer_cohort.period = '2026-10-19/2026-11-17';
  tzCand.newcomer_cohort.market_reference.period = '2026-10-19/2026-11-17';
  const tzMember = makeNewcomerMember('tz-1day', { ratings: 5, units: 80, launch: '2026-11-17T02:00:00+08:00', share: 0.7 });
  tzMember.natural.period = '2026-10-19/2026-11-17';
  tzCand.newcomer_cohort.members = [tzMember];
  const tzRes = scoreCandidate(tzCand, profile);
  assert.equal(tzRes.diagnostics.newcomers.members[0].launch_calendar_date, '2026-11-16');
  assert.equal(tzRes.diagnostics.newcomers.members[0].age_days, 1);
  assert.equal(tzRes.items.find(i => i.id === 'low_rating_sales_performance').score, 2);
  assert.equal(tzRes.items.find(i => i.id === 'natural_visibility_development').score, 0.5);
  assert.equal(tzRes.diagnostics.newcomers.lone_newcomer_alert, true);

  const futureCand = structuredClone(tzCand);
  futureCand.newcomer_cohort.members[0].launch_date = '2026-11-18';
  assert.equal(scoreCandidate(futureCand, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const nonMono = structuredClone(batchFixture.candidates[0]);
  nonMono.newcomer_cohort.observation_date = '2026-11-13';
  nonMono.newcomer_cohort.members = [
    makeNewcomerMember('full-good', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('full-zero', { ratings: 5, units: 0, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('ramp-mid', { ratings: 5, units: 40, launch: '2026-11-01', share: 0 }),
  ];
  const nmRes = scoreCandidate(nonMono, profile);
  assert.equal(nmRes.diagnostics.newcomers.denominator, 3);
  assert.equal(nmRes.diagnostics.newcomers.selected_pair.length, 3);
  assert.ok(Math.abs(nmRes.items.find(i => i.id === 'low_rating_sales_performance').score - (6.4 / 3)) < 1e-12);
  assert.ok(Math.abs(nmRes.items.find(i => i.id === 'natural_visibility_development').score - (2 / 3)) < 1e-12);

  const missSif = structuredClone(nonMono);
  missSif.newcomer_cohort.members[2].natural.value = null;
  const msRes = scoreCandidate(missSif, profile);
  const natItem = msRes.items.find(i => i.id === 'natural_visibility_development');
  assert.equal(natItem.status, 'needs_evidence');
  assert.deepEqual(natItem.conditional_range, [2 / 3, 3 / 3]);

  const allRampZero = structuredClone(batchFixture.candidates[0]);
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

  const weakSecond = structuredClone(batchFixture.candidates[0]);
  weakSecond.newcomer_cohort.members = [
    makeNewcomerMember('strong1', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('weak2', { ratings: 5, units: 10, launch: '2026-10-01', share: 0.7 }),
  ];
  const wsRes = scoreCandidate(weakSecond, profile);
  assert.equal(wsRes.diagnostics.newcomers.lone_newcomer_alert, true);
});

test('r59 Q31 deterministic 5-quintile stratification, replacement, cherry-pick blocking, and brute-force verified stratified_bounds', () => {
  const c6 = structuredClone(batchFixture.candidates[0]);
  c6.newcomer_cohort.members = [
    makeNewcomerMember('n1', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n2', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n3', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n4', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n5', { ratings: 5, units: 100, launch: '2026-10-01', share: 0.7 }),
    makeNewcomerMember('n6', { ratings: 5, units: 0, launch: '2026-10-01', share: null, status: 'unsampled_stratified' }),
  ];
  const b6 = { schema_version: 1, profile_revision: 59, candidates: [c6] };
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

  const cherry = structuredClone(c6);
  cherry.newcomer_cohort.members[4].status = 'unsampled_stratified';
  cherry.newcomer_cohort.members[5].status = 'qualified';
  cherry.newcomer_cohort.members[5].natural.value = 0.7;
  assert.equal(scoreCandidate(cherry, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const missingUnsampled = structuredClone(c6);
  missingUnsampled.newcomer_cohort.members[5].ratings.value = null;
  assert.equal(scoreCandidate(missingUnsampled, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const smallPool = structuredClone(c6);
  smallPool.newcomer_cohort.members = smallPool.newcomer_cohort.members.slice(0, 5);
  smallPool.newcomer_cohort.members[4].status = 'unsampled_stratified';
  assert.equal(scoreCandidate(smallPool, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const pool = [
    { family_id: 'a0', asin: 'x0', e_rat: rat(4), units_30d: 100, excluded: true },
    { family_id: 'a1', asin: 'x1', e_rat: rat(39, 10), units_30d: 95 },
    { family_id: 'a2', asin: 'x2', e_rat: rat(38, 10), units_30d: 90 },
    { family_id: 'a3', asin: 'x3', e_rat: rat(30, 10), units_30d: 80 },
    { family_id: 'a4', asin: 'x4', e_rat: rat(25, 10), units_30d: 70, excluded: true },
    { family_id: 'a5', asin: 'x5', e_rat: rat(20, 10), units_30d: 60 },
    { family_id: 'a6', asin: 'x6', e_rat: rat(10, 10), units_30d: 50 },
    { family_id: 'a7', asin: 'x7', e_rat: rat(5, 10), units_30d: 40 },
  ];
  const sel = selectStratifiedNewcomers(pool);
  assert.equal(sel.stratified, true);
  assert.equal(sel.blocked, false);
  assert.equal(sel.selected.length, 5);
  assert.equal(sel.strata[0].borrowed_from_stratum, 1);
  assert.deepEqual(sel.selected.map(s => s.family_id).sort(), ['a1', 'a2', 'a3', 'a5', 'a6']);

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

test('B01–B03: flat annual bypass prevention, closed-set expected_primary_scenarios, and strict seasonal peak/off-peak validation', () => {
  const flatBypass = structuredClone(batchFixture.candidates[0]);
  flatBypass.id = 'b01-flat-bypass';
  flatBypass.economics.operating_months = [3, 4, 5, 6, 7, 8];
  for (const sc of flatBypass.economics.scenarios) {
    sc.cost_ledger.fee_context.sales = { from: '2027-03-01', through: '2027-08-31' };
    sc.cost_ledger.fee_context.storage = { from: '2027-03-01', through: '2027-08-31' };
    sc.cost_ledger.fee_context.inbound = { from: '2027-02-01', through: '2027-02-01' };
  }
  const b01Batch = { ...structuredClone(batchFixture), candidates: [flatBypass] };
  const b01Res = scoreBatch(b01Batch, profile);
  assert.equal(b01Res.summary.qualifying, 0);
  assert.equal(b01Res.candidates[0].queue, 'pending');
  assert.equal(b01Res.candidates[0].qualification.counts_toward_target, false);
  assert.match(renderReport(b01Res, b01Batch), /data-eligible="false"/);

  const flatPendingFulfill = structuredClone(batchFixture.candidates[0]);
  flatPendingFulfill.id = 'b01-full-year-pending-fulfill';
  Object.assign(flatPendingFulfill.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null, status: 'pending',
  });
  const b01bRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [flatPendingFulfill] }, profile);
  assert.equal(b01bRes.candidates[0].queue, 'pending');
  assert.ok(Array.isArray(b01bRes.candidates[0].conditional_total_range), 'conditional_total_range must be preserved');
  assert.ok(!b01bRes.candidates[0].qualification.reasons.some(r => r.includes('all 12 calendar months')));

  const b02Closed = structuredClone(batchFixture.candidates[0]);
  b02Closed.id = 'b02-closed-set';
  b02Closed.economics.expected_primary_scenarios = [
    { id: 'old-cancelled', status: 'cancelled', reason: 'Discontinued SKU', evidence: ['synthetic-evidence'] },
  ];
  const b02aRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [b02Closed] }, profile);
  assert.equal(b02aRes.summary.qualifying, 0);
  assert.equal(b02aRes.candidates[0].qualification.counts_toward_target, false);

  const b02Merge = makeSeasonalCandidate('b02-merge');
  b02Merge.economics.expected_primary_scenarios = [
    { id: 'sc-regular', status: 'active' },
    { id: 'sc-carton-missing', status: 'active' },
  ];
  b02Merge.economics.operating_periods[0].expected_primary_scenarios = [
    { id: 'sc-regular', status: 'active' },
  ];
  const b02bRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [b02Merge] }, profile);
  assert.equal(b02bRes.summary.qualifying, 0);
  assert.equal(b02bRes.candidates[0].qualification.counts_toward_target, false);

  const b02Empty = makeSeasonalCandidate('b02-empty-scenarios');
  b02Empty.economics.operating_periods[0].expected_primary_scenarios = [{ id: 'sc-regular', status: 'active' }];
  b02Empty.economics.operating_periods[0].scenarios = [];
  const b02cRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [b02Empty] }, profile);
  assert.equal(b02cRes.summary.qualifying, 0);
  assert.equal(b02cRes.candidates[0].qualification.counts_toward_target, false);
  assert.equal(b02cRes.candidates[0].operating_periods[0].queue, 'pending');

  const peak2026 = makeSeasonalCandidate('b03-peak-2026');
  peak2026.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.sales = { from: '2026-10-15', through: '2026-12-31' };
  peak2026.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.storage = { from: '2026-10-15', through: '2026-12-31' };
  assert.equal(scoreBatch({ ...structuredClone(batchFixture), candidates: [peak2026] }, profile).summary.qualifying, 0);

  const peakNoLedger = makeSeasonalCandidate('b03-peak-no-ledger');
  delete peakNoLedger.economics.operating_periods[1].scenarios[0].cost_ledger;
  assert.equal(scoreBatch({ ...structuredClone(batchFixture), candidates: [peakNoLedger] }, profile).summary.qualifying, 0);

  const peakWrongMonths = makeSeasonalCandidate('b03-peak-wrong-months');
  peakWrongMonths.economics.operating_periods[1].months = [1, 10, 11, 12];
  assert.equal(scoreBatch({ ...structuredClone(batchFixture), candidates: [peakWrongMonths] }, profile).summary.qualifying, 0);

  const offDayShort = makeSeasonalCandidate('b03-day-short', { offPeakFrom: '2027-02-02' });
  const offShortBatch = { ...structuredClone(batchFixture), candidates: [offDayShort] };
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
  const inflated = structuredClone(batchFixture.candidates[0]);
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
  const res = scoreBatch({ ...structuredClone(batchFixture), candidates: [inflated] }, profile);
  assert.equal(res.summary.qualifying, 0);
  assert.equal(res.candidates[0].queue, 'pending');

  for (const mutate of [
    rp => { delete rp.target_variant_asin; },
    rp => { rp.fulfillment_channel = 'FBM'; },
    rp => { rp.sales_history_supported = false; },
  ]) {
    const c = structuredClone(batchFixture.candidates[0]);
    c.id = 'b04-bad-anchor';
    mutate(c.screening.reference_price_usd);
    const r = scoreBatch({ ...structuredClone(batchFixture), candidates: [c] }, profile);
    assert.equal(r.summary.qualifying, 0);
    assert.equal(r.candidates[0].queue, 'pending');
  }
});

test('B05–B08: Q31 grain/comparability/natural-period enforcement, unconditional N_active>5 stratification, transitive old-review exclusion, and BigInt-free pending JSON', () => {
  const b05 = structuredClone(batchFixture.candidates[0]);
  b05.id = 'b05-bad-grain-and-ref';
  b05.newcomer_cohort.sales_grain = 'unknown';
  b05.newcomer_cohort.market_reference.grain = 'unknown';
  for (const f of b05.newcomer_cohort.market_reference.families) {
    f.comparability_verdict = 'excluded_different_task';
    f.reason = 'Different task';
    f.evidence = ['synthetic-evidence'];
    f.units_30d.value = 0;
  }
  const b05aRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [b05] }, profile);
  assert.equal(b05aRes.summary.qualifying, 0);
  assert.equal(b05aRes.candidates[0].items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const b05Nat = structuredClone(batchFixture.candidates[0]);
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
  const b05bRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [b05Nat] }, profile);
  const natItem = b05bRes.candidates[0].items.find(i => i.id === 'natural_visibility_development');
  assert.equal(natItem.status, 'needs_evidence');
  assert.deepEqual(natItem.conditional_range, [0, 0.5]);

  const mkSix = (sixthStatus) => {
    const c = structuredClone(batchFixture.candidates[0]);
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
    return scoreBatch({ ...structuredClone(batchFixture), candidates: [c] }, profile).candidates[0];
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
  const stratHtml = renderReport({ ...scoreBatch({ ...structuredClone(batchFixture), candidates: [structuredClone(batchFixture.candidates[0])] }, profile), candidates: [allQual6] }, batchFixture);
  assert.match(stratHtml, /5 分位分层抽样与替补明细/);

  const b07Prop = structuredClone(batchFixture.candidates[0]);
  b07Prop.id = 'b07-propagate';
  const bm = structuredClone(b07Prop.newcomer_cohort.members[0]);
  b07Prop.newcomer_cohort.members = [
    { ...structuredClone(bm), family_id: 'f-old', asin: 'SYN-OLD', status: 'excluded', old_reviews_predate_launch: true, reason: 'Old reviews', evidence: ['synthetic-evidence'], ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 100, unit: 'units', evidence: ['synthetic-evidence'] } },
    { ...structuredClone(bm), family_id: 'f-old-dup', asin: 'SYN-OLD', status: 'qualified', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 100, unit: 'units', evidence: ['synthetic-evidence'] } },
  ];
  const b07PropRes = scoreBatch({ ...structuredClone(batchFixture), candidates: [b07Prop] }, profile).candidates[0];
  assert.deepEqual(b07PropRes.items.find(i => i.id === 'low_rating_sales_performance').score_range, [0, 0]);
  assert.equal(b07PropRes.diagnostics.newcomers.no_qualifying_examples, true);

  const mkB07Strat = (dupExcluded) => {
    const c = structuredClone(batchFixture.candidates[0]);
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
    return scoreBatch({ ...structuredClone(batchFixture), candidates: [c] }, profile).candidates[0];
  };
  const b07SingleExcl = mkB07Strat(false);
  const b07DupExcl = mkB07Strat(true);
  assert.equal(b07SingleExcl.items.find(i => i.id === 'low_rating_sales_performance').status, 'scored');
  assert.deepEqual(
    b07DupExcl.items.find(i => i.id === 'low_rating_sales_performance').score_range,
    b07SingleExcl.items.find(i => i.id === 'low_rating_sales_performance').score_range,
  );
  assert.equal(b07DupExcl.diagnostics.newcomers.stratification.full_pool_size, 7);

  for (const reverse of [false, true]) {
    const b07Date = structuredClone(batchFixture.candidates[0]);
    b07Date.id = `b07-date-${reverse}`;
    const d1 = { ...structuredClone(bm), family_id: 'f-dup', asin: 'SYN-D1', launch_date: '2026-10-13' };
    const d2 = { ...structuredClone(bm), family_id: 'f-dup', asin: 'SYN-D2', launch_date: '2026-10-15' };
    b07Date.newcomer_cohort.members = reverse ? [d2, d1] : [d1, d2];
    const r = scoreBatch({ ...structuredClone(batchFixture), candidates: [b07Date] }, profile).candidates[0];
    assert.equal(r.items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  }

  const b08 = structuredClone(batchFixture.candidates[0]);
  b08.id = 'b08-no-bigint';
  b08.newcomer_cohort.members[0].ratings = { value: null, unit: 'count', evidence: ['synthetic-evidence'] };
  const b08Res = scoreBatch({ ...structuredClone(batchFixture), candidates: [b08] }, profile);
  assert.equal(b08Res.candidates[0].queue, 'pending');
  assert.doesNotThrow(() => JSON.stringify(b08Res));
});

test('r59 Codex Rounds 2–6 scoring regressions: peak/inbound/merge guards, Q31 comparability/SIF/identity/cross-table/old-review guards, exact rational BigInt procurement & 3-SKU rounding, stress dedup, and price floor', () => {
  const fresh = () => structuredClone(batchFixture.candidates[0]);
  const single = c => ({ ...structuredClone(batchFixture), candidates: [c] });
  const score = c => scoreBatch(single(c), profile);

  // Round-2 Finding 2(a)–(c): peak/merge/inbound guards
  const peakMissExp = makeSeasonalCandidate('f2-peak-miss-exp');
  peakMissExp.economics.operating_periods[1].expected_primary_scenarios = [
    { id: 'sc-peak', status: 'active' }, { id: 'sc-peak-carton', status: 'active' },
  ];
  assert.equal(score(peakMissExp).summary.qualifying, 0);

  const peakBadId = makeSeasonalCandidate('f2-peak-bad-id');
  peakBadId.economics.operating_periods[1].scenarios[0].cost_ledger.id = 'wrong-id';
  assert.equal(score(peakBadId).summary.qualifying, 0);

  const peakCA = makeSeasonalCandidate('f2-peak-ca');
  peakCA.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.marketplace = 'CA';
  assert.equal(score(peakCA).summary.qualifying, 0);

  const peak2029Inb = makeSeasonalCandidate('f2-peak-2029-inb');
  peak2029Inb.economics.operating_periods[1].scenarios[0].cost_ledger.fee_context.inbound = { from: '2029-01-15', through: '2029-01-15' };
  assert.equal(score(peak2029Inb).summary.qualifying, 0);

  for (const swap of [false, true]) {
    const f2Conflict = makeSeasonalCandidate(`f2-merge-conflict-${swap}`);
    const badEntry = { id: 'sc-x', status: 'bogus_status' };
    const cancelEntry = { id: 'sc-x', status: 'cancelled', reason: 'Dropped', evidence: ['synthetic-evidence'] };
    f2Conflict.economics.expected_primary_scenarios = [{ id: 'sc-regular', status: 'active' }, swap ? cancelEntry : badEntry];
    f2Conflict.economics.operating_periods[0].expected_primary_scenarios = [{ id: 'sc-regular', status: 'active' }, swap ? badEntry : cancelEntry];
    assert.equal(score(f2Conflict).summary.qualifying, 0);
  }

  const f2EarlyInb = makeSeasonalCandidate('f2-early-inbound');
  f2EarlyInb.economics.operating_periods[0].scenarios[0].cost_ledger.fee_context.inbound = { from: '2027-01-14', through: '2027-01-14' };
  const f2EarlyRes = score(f2EarlyInb);
  assert.equal(f2EarlyRes.summary.qualifying, 0);
  assert.equal(f2EarlyRes.candidates[0].operating_periods.find(p => p.id === 'off_peak').queue, 'pending');

  // Round-2 Finding 3 lower bound
  const f3Low = fresh();
  f3Low.id = 'f3-below-range';
  f3Low.screening.reference_price_usd.supported_price_range = [38, 45];
  f3Low.economics.scenarios[0].cost_ledger.price_usd = 29.98;
  assert.equal(score(f3Low).summary.qualifying, 0);

  // Round-2 Finding 4 & 5: Q31 strictness / duplicates
  const f4Unk = fresh();
  f4Unk.newcomer_cohort.members[0].comparability_verdict = 'unknown';
  for (const rf of f4Unk.newcomer_cohort.market_reference.families) { rf.comparability_verdict = 'unknown'; rf.units_30d.value = 0; }
  assert.equal(scoreCandidate(f4Unk, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const f4Seven = fresh();
  f4Seven.newcomer_cohort.period = '2026-11-07/2026-11-13';
  f4Seven.newcomer_cohort.market_reference.period = '2026-11-07/2026-11-13';
  f4Seven.newcomer_cohort.members[0].natural.period = '2026-11-07/2026-11-13';
  assert.equal(scoreCandidate(f4Seven, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const f4SsOnly = fresh();
  f4SsOnly.evidence.push({ id: 'ss-only', source: 'SellerSprite keyword list', observed_at: '2026-11-13' });
  f4SsOnly.newcomer_cohort.members[0].natural.evidence = ['ss-only'];
  delete f4SsOnly.newcomer_cohort.members[0].natural.keyword_counts.sif;
  assert.equal(scoreCandidate(f4SsOnly, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence');

  const f4ChildView = fresh();
  f4ChildView.newcomer_cohort.grain = 'parent_units';
  f4ChildView.newcomer_cohort.market_reference.grain = 'parent_units';
  f4ChildView.newcomer_cohort.members[0].natural.isListingSearch = false;
  assert.equal(scoreCandidate(f4ChildView, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence');

  const bm = structuredClone(fresh().newcomer_cohort.members[0]);
  for (const rev of [false, true]) {
    const f5Nat = fresh();
    const r1 = { ...structuredClone(bm), family_id: 'f-dup-nat', asin: 'SYN-DN1', natural: { ...structuredClone(bm.natural), value: 0.7 } };
    const r2 = { ...structuredClone(bm), family_id: 'f-dup-nat', asin: 'SYN-DN1', natural: { ...structuredClone(bm.natural), value: 0 } };
    f5Nat.newcomer_cohort.members = rev ? [r2, r1] : [r1, r2];
    assert.equal(scoreCandidate(f5Nat, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  }
  const f5MissRat = fresh();
  f5MissRat.newcomer_cohort.members = [
    ...[100, 90, 80, 60, 40, 30].map((u, i) => ({
      ...structuredClone(bm), family_id: `fa${i}`, asin: `SYN-FA${i}`,
      ratings: { value: 10, unit: 'count', evidence: ['synthetic-evidence'] },
      units_30d: { value: u, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified',
    })),
    { ...structuredClone(bm), family_id: 'f-ex-norat', asin: 'SYN-EXNR', status: 'excluded', old_reviews_predate_launch: true, ratings: { value: null, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 50, unit: 'units', evidence: ['synthetic-evidence'] } },
  ];
  assert.equal(scoreCandidate(f5MissRat, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'scored');

  const f5RampExcl = fresh();
  f5RampExcl.newcomer_cohort.members = [
    ...[100, 90, 80, 60, 40, 30].map((u, i) => ({
      ...structuredClone(bm), family_id: `fb${i}`, asin: `SYN-FB${i}`,
      ratings: { value: 10, unit: 'count', evidence: ['synthetic-evidence'] },
      units_30d: { value: u, unit: 'units', evidence: ['synthetic-evidence'] }, status: 'qualified',
    })),
    { ...structuredClone(bm), family_id: 'f-ramp0', asin: 'SYN-R0', launch_date: '2026-11-01', status: 'excluded', old_reviews_predate_launch: true, ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 0, unit: 'units', evidence: ['synthetic-evidence'] } },
    { ...structuredClone(bm), family_id: 'f-ramp0', asin: 'SYN-R0', launch_date: '2026-11-01', status: 'qualified', ratings: { value: 5, unit: 'count', evidence: ['synthetic-evidence'] }, units_30d: { value: 0, unit: 'units', evidence: ['synthetic-evidence'] } },
  ];
  assert.equal(scoreCandidate(f5RampExcl, profile).diagnostics.newcomers.stratification.full_pool_size, 6);

  // Round-2 Notes: forged isOperatingPeriod & same-layer stress dedup
  const fNoteFlat = fresh();
  fNoteFlat.economics.operating_months = [3, 4, 5, 6, 7, 8];
  for (const sc of fNoteFlat.economics.scenarios) {
    sc.cost_ledger.fee_context.sales = { from: '2027-03-01', through: '2027-08-31' };
    sc.cost_ledger.fee_context.storage = { from: '2027-03-01', through: '2027-08-31' };
  }
  const forgedRes = scoreCandidate(fNoteFlat, profile, { isOperatingPeriod: true });
  assert.equal(forgedRes.queue, 'pending');
  assert.equal(forgedRes.qualification?.counts_toward_target, false);

  const dupStressCard = makeSeasonalCandidate('f-note-dup-stress');
  dupStressCard.economics.operating_periods[0].stress_scenarios = [
    { id: 'dup-st', label: 'First', price_usd: 35, margin: 0.22 },
    { id: 'dup-st', label: 'Duplicate', price_usd: 35, margin: 0.22 },
  ];
  assert.equal(scoreCandidate(dupStressCard, profile).operating_periods.find(p => p.id === 'off_peak').diagnostics.economics.stress_scenarios.length, 1);

  // Round-3 R3-1(b): Exact rational procurement precision ($4.44e-11 over 30% ceiling)
  const ratCand = fresh();
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
  rProc.sku_lines = [{ sku_id: 'EX', qty_per_saleable_set: 1, pack_multiple: 100, moq_qty: 100, ordered_qty: 100, unit_price_cny: 90.0000000004, regular_goods_promo_false: true }];
  const ratRes = score(ratCand);
  assert.equal(ratRes.summary.qualifying, 0);
  assert.equal(ratRes.candidates[0].queue, 'excluded');
  rProc.sku_lines[0].unit_price_cny = 90;
  assert.equal(score(ratCand).summary.qualifying, 1);

  // Round-3 R3-2, R3-4, R3-5, Note
  const peakEmpty = makeSeasonalCandidate('r3-peak-empty');
  peakEmpty.economics.operating_periods[1].scenarios[0].cost_ledger.lines = [];
  assert.equal(score(peakEmpty).summary.qualifying, 0);

  const peakWrongPkg = makeSeasonalCandidate('r3-peak-wrong-pkg');
  for (const l of peakWrongPkg.economics.operating_periods[1].scenarios[0].cost_ledger.lines) {
    if (l.fee_basis) l.fee_basis.package_ref = 'wrong-pkg-ref';
  }
  assert.equal(score(peakWrongPkg).summary.qualifying, 0);

  const off2028 = makeSeasonalCandidate('r3-off-2028', { offPeakFrom: '2028-02-01', offPeakThrough: '2028-09-30' });
  const offSc2028 = off2028.economics.operating_periods[0].scenarios[0];
  offSc2028.cost_ledger.fee_context.inbound = { from: '2028-01-15', through: '2028-01-15' };
  for (const l of offSc2028.cost_ledger.lines.filter(x => x.fee_basis)) {
    l.fee_basis.effective_from = '2028-01-15';
    l.fee_basis.effective_through = l.id === 'fulfillment' ? '2028-10-14' : '2028-12-31';
  }
  const off2028Res = score(off2028);
  assert.equal(off2028Res.summary.qualifying, 0);
  const innerOff2028 = off2028Res.candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(innerOff2028.queue, 'pending');
  assert.equal(innerOff2028.total, null);

  const cComp = fresh();
  cComp.id = 'r3-comp-ok';
  assert.equal(scoreCandidate(cComp, profile).queue, 'comparable');
  const cOmitMem = fresh();
  delete cOmitMem.newcomer_cohort.members[0].comparability_verdict;
  assert.equal(scoreCandidate(cOmitMem, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  const cOmitRef = fresh();
  delete cOmitRef.newcomer_cohort.market_reference.families[0].comparability_verdict;
  assert.equal(scoreCandidate(cOmitRef, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  const cTp7 = fresh();
  cTp7.newcomer_cohort.members[0].natural.timePieceValue = '7';
  assert.equal(scoreCandidate(cTp7, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence');
  const cKwDistOnly = fresh();
  cKwDistOnly.evidence.push({ id: 'sif-kw-dist', source: 'SIF ops_get_listing_keyword_distribution 关键词数量分布', observed_at: '2026-11-13' });
  cKwDistOnly.newcomer_cohort.members[0].natural.evidence = ['sif-kw-dist'];
  assert.equal(scoreCandidate(cKwDistOnly, profile).items.find(i => i.id === 'natural_visibility_development').status, 'needs_evidence');

  for (const rev of [false, true]) {
    const cDupEx = fresh();
    const six = [100, 90, 80, 60, 40, 30].map((u, i) => ({
      ...structuredClone(bm), family_id: `r3p${i}`, asin: `SYN-R3P${i}`, comparability_verdict: 'comparable',
      ratings: obs(10, 'count'), units_30d: obs(u, 'units'), status: i === 3 ? 'unsampled_stratified' : 'qualified',
    }));
    const oldExcl = { ...structuredClone(bm), family_id: 'r3-dup-ex', asin: 'SYN-DUP-EX', comparability_verdict: 'comparable', launch_date: '2026-11-01', status: 'excluded', old_reviews_predate_launch: true, ratings: obs(5, 'count'), units_30d: obs(0, 'units') };
    const unmarked35 = { ...structuredClone(bm), family_id: 'r3-dup-ex', asin: 'SYN-DUP-EX', comparability_verdict: 'comparable', launch_date: '2026-10-01', status: 'qualified', ratings: obs(5, 'count'), units_30d: obs(35, 'units') };
    cDupEx.newcomer_cohort.members = rev ? [...six, unmarked35, oldExcl] : [...six, oldExcl, unmarked35];
    assert.equal(scoreCandidate(cDupEx, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');
  }
  const cDupRefAsin = fresh();
  cDupRefAsin.newcomer_cohort.market_reference.families = [
    { family_id: 'rf1', asin: 'SAME-REF-ASIN', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'rf2', asin: 'SAME-REF-ASIN', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'rf3', asin: 'OTHER-ASIN-1', comparability_verdict: 'comparable', units_30d: obs(100, 'units') },
    { family_id: 'rf4', asin: 'OTHER-ASIN-2', comparability_verdict: 'comparable', units_30d: obs(100, 'units') },
  ];
  assert.equal(scoreCandidate(cDupRefAsin, profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const r3FlatDupStress = fresh();
  r3FlatDupStress.economics.stress_scenarios = [
    { id: 'st-apos', label: 'A', price_usd: 35, margin: 0.25 },
    { id: 'st-apos', label: 'Duplicate flat stress ID must dedup', price_usd: 35, margin: 0.25 },
  ];
  assert.equal(score(r3FlatDupStress).candidates[0].diagnostics.economics.stress_scenarios.length, 1);

  // Round-4 R4-01, R4-03, R4-05..R4-07, stress permutation invariance
  const c1 = fresh();
  const h1 = c1.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul');
  h1.amount_usd = 200;
  h1.exact_usd_rational = { num: '0', den: '1' };
  const r1 = score(c1);
  assert.equal(r1.summary.qualifying, 0);
  assert.equal(r1.candidates[0].queue, 'excluded');
  h1.exact_usd_rational = { num: 'junk', den: '1' };
  assert.equal(score(c1).summary.qualifying, 0);

  for (const [tag, mutate] of [
    ['unpub_wrong_pkg', p => { p.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.package_ref = 'wrong'; }],
    ['coherent_false', p => { p.coherent = false; }],
    ['sensitivity_only', p => { p.cost_ledger.sensitivity_only = true; }],
    ['missing_basis', p => { delete p.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis; }],
    ['typo_status', p => { p.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.status = 'publsihed'; }],
  ]) {
    const c3 = makeSeasonalCandidate(`r4-peak-${tag}`);
    mutate(c3.economics.operating_periods[1].scenarios[0]);
    assert.equal(score(c3).summary.qualifying, 0, `peak mutation ${tag}`);
  }

  const c5a = fresh();
  c5a.evidence.push({ id: 'kw-ev', source: 'SIF ops_get_listing_keyword_distribution', observed_at: '2026-11-13' });
  Object.assign(c5a.newcomer_cohort.members[0].natural, { evidence: ['kw-ev'], tool: 'ops_get_listing_traffic_overview' });
  assert.equal(score(c5a).summary.qualifying, 0);

  const c5b = fresh();
  c5b.evidence.push({ id: 'nest7', source: 'SIF traffic_overview', observed_at: '2026-11-13', request: { params: { timePieceValue: '7' } } });
  c5b.newcomer_cohort.members[0].natural.evidence = ['nest7'];
  assert.equal(score(c5b).summary.qualifying, 0);

  const c5c = fresh();
  c5c.newcomer_cohort.members[0].units_30d.window_days = 7;
  assert.equal(score(c5c).summary.qualifying, 0);
  const c5d = fresh();
  c5d.newcomer_cohort.market_reference.families[0].units_30d.window_days = 7;
  assert.equal(score(c5d).summary.qualifying, 0);

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
    assert.equal(score(c6).summary.qualifying, 0);
  }

  const c7a = fresh();
  c7a.newcomer_cohort.members[0].parent_asin = 'SHARED-PARENT-1';
  c7a.newcomer_cohort.members = [c7a.newcomer_cohort.members[0]];
  const loneTotal = score(c7a).candidates[0].total;
  c7a.newcomer_cohort.members.push({ ...structuredClone(c7a.newcomer_cohort.members[0]), family_id: 'other-fam', asin: 'other-child' });
  assert.equal(score(c7a).candidates[0].total, loneTotal);

  const c7b = fresh();
  c7b.newcomer_cohort.market_reference.families = [
    { family_id: 'a', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: ' a', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'a ', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    { family_id: 'b', comparability_verdict: 'comparable', units_30d: obs(100, 'units') },
  ];
  assert.equal(score(c7b).summary.qualifying, 0);

  const c7c = fresh();
  c7c.newcomer_cohort.market_reference.families.push({
    family_id: c7c.newcomer_cohort.members[0].family_id, comparability_verdict: 'comparable', units_30d: obs(0, 'units'),
  });
  assert.equal(score(c7c).summary.qualifying, 0);

  const c11 = fresh();
  const stHi = structuredClone(c11.economics.scenarios[0]);
  stHi.id = stHi.cost_ledger.id = 's-perm';
  stHi.cost_ledger.price_usd = 59.99;
  const stLo = structuredClone(c11.economics.scenarios[0]);
  stLo.id = stLo.cost_ledger.id = 's-perm';
  stLo.cost_ledger.price_usd = 29.99;
  c11.economics.stress_scenarios = [stHi, stLo];
  const res11 = score(c11);
  const c11Rev = structuredClone(c11);
  c11Rev.economics.stress_scenarios.reverse();
  const res11Rev = score(c11Rev);
  assert.equal(res11.candidates[0].diagnostics.economics.stress_scenarios[0].price_usd, 29.99);
  assert.equal(res11Rev.candidates[0].diagnostics.economics.stress_scenarios[0].price_usd, 29.99);

  // Round-5 R5-02..R5-07 & stress key-order invariance
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
  assert.equal(score(fxCand).summary.qualifying, 0);

  for (const [tag, mut] of [
    ['missing_coherent', (off, pk) => { delete pk.coherent; }],
    ['string_coherent', (off, pk) => { pk.coherent = 'false'; }],
    ['published_covering_pending', (off, pk) => { const f = structuredClone(off.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis); f.effective_through = '2027-12-31'; pk.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = f; }],
    ['year_2028_basis', (off, pk) => { const f = structuredClone(off.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis); f.effective_from = '2028-01-15'; f.effective_through = '2028-10-14'; pk.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = f; }],
    ['string_months', (off, pk) => { const f = structuredClone(off.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis); f.effective_through = '2027-12-31'; f.months = ['Oct', 'Nov', 'Dec']; pk.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = f; }],
  ]) {
    const c3 = makeSeasonalCandidate(`r5-pk-${tag}`);
    mut(c3.economics.operating_periods[0].scenarios[0], c3.economics.operating_periods[1].scenarios[0]);
    assert.equal(score(c3).summary.qualifying, 0, `R5 peak guard ${tag}`);
  }

  const c4s = fresh();
  c4s.screening.reference_price_usd.value = 29.99;
  const s4s = c4s.economics.scenarios[0];
  Object.assign(s4s.cost_ledger, { price_usd: 59.99, sensitivity_only: 'true' });
  s4s.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  s4s.price_anchor = { ...c4s.screening.reference_price_usd, value: 59.99 };
  assert.equal(score(c4s).summary.qualifying, 0);

  const c5aR5 = fresh();
  c5aR5.evidence.push({ id: 'ev-nested-tool', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', request: { tool: 'ops_get_listing_keyword_distribution', params: { timePieceValue: '30', isListingSearch: true } } });
  Object.assign(c5aR5.newcomer_cohort.members[0].natural, { evidence: ['ev-nested-tool'], tool: 'ops_get_listing_traffic_overview' });
  assert.equal(score(c5aR5).summary.qualifying, 0);

  const c5bR5 = fresh();
  c5bR5.evidence.push({ id: 'ev-alias', provider: 'sif', source: 'SIF traffic_overview', observed_at: '2026-11-13', request: { timePieceValue: '30', time_piece_value: '7' } });
  c5bR5.newcomer_cohort.members[0].natural.evidence = ['ev-alias'];
  assert.equal(score(c5bR5).summary.qualifying, 0);

  const c5cR5 = fresh();
  c5cR5.newcomer_cohort.members[0].parent_asin = 'PARENT-VALID-1';
  c5cR5.newcomer_cohort.members[0].natural.subject = 'PARENT-VALID-1';
  assert.equal(score(c5cR5).summary.qualifying, 1);

  const c6R5 = fresh();
  const mkMem = (id, u) => ({ ...structuredClone(bm), family_id: id, asin: `${id}-a`, ratings: obs(10, 'count'), units_30d: obs(u, 'units') });
  const exOmit = { ...mkMem('c', 0), status: 'excluded', old_reviews_predate_launch: true };
  delete exOmit.comparability_verdict;
  c6R5.newcomer_cohort.members = [mkMem('a', 100), mkMem('b', 90), mkMem('c', 0), exOmit];
  assert.equal(score(c6R5).candidates[0].total, null);

  const c7R5 = fresh();
  const mkRef = (id, u) => ({ family_id: id, comparability_verdict: 'comparable', units_30d: obs(u, 'units') });
  c7R5.newcomer_cohort.members = [{ ...mkMem('a', 0), parent_asin: 'P' }, { ...mkMem('b', 0), parent_asin: 'P' }, mkMem('x', 8)];
  c7R5.newcomer_cohort.market_reference.families = [mkRef('a', 0), mkRef('b', 0), mkRef('x', 8), mkRef('j', 100), mkRef('k', 100)];
  assert.equal(score(c7R5).candidates[0].total, null);

  const c7Zero = fresh();
  c7Zero.newcomer_cohort.members = [{ ...mkMem('o', 0), status: 'excluded', old_reviews_predate_launch: true }];
  c7Zero.newcomer_cohort.market_reference.families = [{ ...mkRef('o', 0), comparability_verdict: 'excluded_different_task', reason: 'syn', evidence: ['synthetic-evidence'] }];
  assert.equal(score(c7Zero).summary.qualifying, 0);

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
  assert.deepEqual(winners, ['A', 'A', 'A']);

  // Round-6 scoring checks: peak 2028-01-14, plain excluded, SIF timePieceValue, 3-SKU BigInt rounding, order_units, $29.99 floor
  const pkJan14 = makeSeasonalCandidate('r6-peak-2028-01-14');
  const pkFul = pkJan14.economics.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment');
  Object.assign(pkFul, {
    amount_usd: 6.5, status: 'estimated', components: ['fulfillment'],
    fee_basis: { status: 'published', version: '2027-US-Holiday-Peak', marketplace: 'US', currency: 'USD', package_ref: 'synthetic-pack', effective_from: '2027-10-01', effective_through: '2028-01-14', evidence: ['synthetic-evidence'] },
  });
  assert.equal(score(pkJan14).summary.qualifying, 1);

  const pkUnavail2028 = makeSeasonalCandidate('r6-peak-unavail-2028');
  Object.assign(pkUnavail2028.economics.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis, {
    effective_from: '2028-01-01', effective_through: '2028-12-31',
  });
  assert.equal(score(pkUnavail2028).summary.qualifying, 0);

  const flatStretched = fresh();
  flatStretched.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.version = 'US-FBA-2027-nonpeak-standard-v1';
  assert.equal(score(flatStretched).summary.qualifying, 0);

  const cPlainExcl = fresh();
  const mkM = (id, u, extra = {}) => ({ ...structuredClone(bm), family_id: id, asin: `${id}-a`, ratings: obs(10, 'count'), units_30d: obs(u, 'units'), ...extra });
  const plainZero = { ...mkM('z', 0), status: 'excluded' };
  delete plainZero.comparability_verdict;
  cPlainExcl.newcomer_cohort.members = [mkM('a', 100), mkM('b', 90), plainZero];
  assert.equal(score(cPlainExcl).candidates[0].total, null);

  for (const revRefs of [false, true]) {
    const cDupRef = fresh();
    cDupRef.newcomer_cohort.members = [{ ...mkM('o', 0), status: 'excluded', old_reviews_predate_launch: true, comparability_verdict: 'comparable' }];
    const rfs = [
      { family_id: 'o', comparability_verdict: 'excluded_different_task', reason: 'diff', evidence: ['synthetic-evidence'] },
      { family_id: 'o', comparability_verdict: 'comparable', units_30d: obs(0, 'units') },
    ];
    cDupRef.newcomer_cohort.market_reference.families = revRefs ? rfs.reverse() : rfs;
    assert.equal(score(cDupRef).summary.qualifying, 0);
  }

  const runLeadSpaceSwap = revOrder => {
    const cs = fresh();
    const nat0 = { ...structuredClone(bm.natural), value: 0 };
    const nat1 = { ...structuredClone(bm.natural), value: 0.7 };
    const full1 = mkM('f0', 100, { launch_date: '2026-09-20', natural: nat1 });
    const rampA = mkM('a', 100, { launch_date: '2026-10-25', natural: nat0 });
    const rampB1 = mkM('b', 100, { launch_date: '2026-10-25', asin: 'B-SAME', natural: nat1 });
    const rampB2 = mkM(' b', 100, { launch_date: '2026-10-25', asin: 'B-SAME', natural: nat1 });
    cs.newcomer_cohort.members = revOrder ? [full1, rampA, rampB2, rampB1] : [full1, rampA, rampB1, rampB2];
    const r = score(cs).candidates[0];
    return { total: r.total, nat: r.items.find(i => i.id === 'natural_visibility_development').score };
  };
  assert.deepEqual(runLeadSpaceSwap(false), runLeadSpaceSwap(true));

  const cOmitTpv = fresh();
  cOmitTpv.evidence.push({ id: 'sif-no-tpv', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', request: { tool: 'ops_get_listing_traffic_overview', country: 'US', timePieceType: 'latelyDay', isListingSearch: true } });
  cOmitTpv.newcomer_cohort.members[0].natural.evidence = ['sif-no-tpv'];
  assert.equal(score(cOmitTpv).summary.qualifying, 0);

  const cScopeOvr = fresh();
  cScopeOvr.evidence.push({ id: 'sif-scope-ovr', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', scope: 'traffic_overview note', request: { tool: 'ops_get_listing_keyword_distribution', params: { timePieceValue: '30' } } });
  cScopeOvr.newcomer_cohort.members[0].natural.evidence = ['sif-scope-ovr'];
  assert.equal(score(cScopeOvr).summary.qualifying, 0);

  const cValidSif30 = fresh();
  cValidSif30.evidence.push({ id: 'sif-ok-30', provider: 'sif', source: 'SIF', observed_at: '2026-11-13', request: { tool: 'ops_get_listing_traffic_overview', params: { country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true } } });
  cValidSif30.newcomer_cohort.members[0].natural.evidence = ['sif-ok-30'];
  assert.equal(score(cValidSif30).summary.qualifying, 1);

  const mkSku3 = rev => {
    const prices = [89.99080000045001, 0.0046, 0.0046];
    if (rev) prices.reverse();
    return prices.map((p, i) => ({ sku_id: `SKU-${i}`, qty_per_saleable_set: 1, pack_multiple: 100, moq_qty: 100, ordered_qty: 100, unit_price_cny: p, regular_goods_promo_false: true }));
  };
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
    assert.equal(score(cSku).summary.qualifying, 0, `3-SKU formal scoring (rev=${revSku}) must fail over-cap`);
  }

  const cOrdUnits = fresh();
  cOrdUnits.economics.scenarios[0].cost_ledger.source_inputs = { order_units: 99 };
  assert.equal(score(cOrdUnits).summary.qualifying, 0);

  const cPriceFloor = fresh();
  cPriceFloor.screening.reference_price_usd.value = 29.99;
  cPriceFloor.economics.scenarios[0].cost_ledger.price_usd = 29.9899999995;
  cPriceFloor.economics.scenarios[0].price_anchor = { ...cPriceFloor.screening.reference_price_usd, value: 29.9899999995 };
  assert.equal(score(cPriceFloor).summary.qualifying, 0);
});

const I8_SPEC_SHA_V1 = '1'.repeat(64);
const I8_SPEC_SHA_V2 = '2'.repeat(64);

function i8AttachSyntheticAiReview(cand, { specSha256 = I8_SPEC_SHA_V1, lowDisposition = 'excluded', highDisposition = 'pending' } = {}) {
  cand.evidence_review = {
    status: 'ready',
    execution_status: 'completed',
    content_status: 'usable',
    advisory_only: true,
    validated_envelope: true,
    candidate_id: cand.id,
    form_spec_sha256: specSha256,
    spec_sha256: specSha256,
    review_id: 'rev-issue8-syn-1',
    packet_sha256: '3'.repeat(64),
    review: {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-issue8-syn-1',
      packet_sha256: '3'.repeat(64),
      subjects: [
        {
          subject_id: 'peer-B0SYN8LOW1',
          disposition: lowDisposition,
          criterion_ids: ['same-buyer-task-and-bundle'],
          evidence_ids: ['ev-catalog-low'],
          reason: '低价对标仅含收纳盒主体，明确不含可拆托盘，与整套规格不符。',
        },
        {
          subject_id: 'peer-B0SYN8HIG2',
          disposition: highDisposition,
          criterion_ids: ['same-buyer-task-and-bundle'],
          evidence_ids: ['ev-catalog-high'],
          reason: '高价对标主图可见托盘，但同箱部件清单尚未核实。',
        },
      ],
      answers: [],
      contradictions: [],
      gaps: [],
      conclusion: '低价对标疑缺托盘，高价对标同箱清单待补证。',
    },
  };
  return cand;
}

test('Issue #8 (4C): distinguishes AI advisory dispute pending ruling vs confirmed excluded vs pending evidence, recomputes margin/qualification, blocks stale opinions, and re-prices cleanly', () => {
  const baseCand = makeStage4OrganizerTrayCandidate(batchFixture.candidates[0], { specSha256: I8_SPEC_SHA_V1, specVersion: 1 });
  const baseScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [baseCand] }, profile);
  const baseCard = baseScored.candidates[0];
  assert.equal(baseCard.qualification.counts_toward_target, true);
  assert.equal(baseScored.summary.qualifying, 1);
  const baseLowMargin = baseCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray').margin.value;
  const baseHighMargin = baseCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-high-parts-unknown').margin.value;
  assert.ok(baseHighMargin > baseLowMargin + 0.05);

  const aiOnlyCand = i8AttachSyntheticAiReview(structuredClone(baseCand));
  const aiOnlyBatch = { schema_version: 1, profile_revision: 59, candidates: [aiOnlyCand] };
  const aiOnlyScored = scoreBatch(aiOnlyBatch, profile);
  const aiOnlyCard = aiOnlyScored.candidates[0];
  assert.deepEqual(aiOnlyScored, baseScored, 'Bare AI advice must not mutate deterministic scoreBatch output or result SHA');
  assert.equal(aiOnlyCard.qualification.counts_toward_target, true, 'Bare AI advice remains pending ruling');
  const aiLowSc = aiOnlyCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray');
  const aiHighSc = aiOnlyCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-high-parts-unknown');
  const aiLowLink = resolveScenarioComparabilityLinkage(aiLowSc.input, aiOnlyCand);
  const aiHighLink = resolveScenarioComparabilityLinkage(aiHighSc.input, aiOnlyCand);
  assert.equal(aiLowLink.status, 'ai_dispute_pending_ruling');
  assert.equal(aiLowLink.needs_ruling, true);
  assert.equal(aiLowLink.peer_asin, 'B0SYN8LOW1');
  assert.equal(aiHighLink.status, 'ai_pending_evidence');
  assert.equal(aiHighLink.needs_ruling, true);
  const aiOnlyHtml = renderReport(aiOnlyScored, aiOnlyBatch);
  assert.match(aiOnlyHtml, /复核提出异议/);
  assert.match(aiOnlyHtml, /待裁决/);
  assert.match(aiOnlyHtml, /待补证/);

  assert.throws(
    () => applyPeerComparabilityRulings(structuredClone(aiOnlyCand), [{ peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', reason: '无托盘' }]),
    /source/i,
  );

  const bothRuledCand = applyPeerComparabilityRulings(structuredClone(aiOnlyCand), [
    {
      peer_asin: 'B0SYN8LOW1',
      status: 'confirmed_excluded',
      source: 'owner_confirmed_catalog_check',
      reason: '实核目录确认无托盘，排除同套售价。',
      evidence: [baseCand.evidence[0].id],
    },
    {
      peer_asin: 'B0SYN8HIG2',
      status: 'pending_evidence',
      source: 'owner_confirmed_catalog_check',
      reason: '高价对标同箱托盘清单尚未补齐，暂待补证。',
      evidence: [baseCand.evidence[0].id],
    },
  ]);
  const bothRuledBatch = { schema_version: 1, profile_revision: 59, candidates: [bothRuledCand] };
  const bothRuledScored = scoreBatch(bothRuledBatch, profile);
  const bothRuledCard = bothRuledScored.candidates[0];
  assert.equal(bothRuledCard.qualification.counts_toward_target, false, 'When low is excluded and high is pending, card must NOT count toward qualifying target');
  assert.equal(bothRuledScored.summary.qualifying, 0);
  assert.equal(bothRuledCard.diagnostics.economics.margin_range, null);
  assert.equal(bothRuledCard.diagnostics.economics.scenarios.length, 2, 'Raw scenarios must be preserved for audit');
  const ruledLowSc = bothRuledCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray');
  const ruledHighSc = bothRuledCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-high-parts-unknown');
  assert.equal(ruledLowSc.comparability_linkage.status, 'confirmed_excluded');
  assert.equal(ruledLowSc.excluded_from_active_pricing, true);
  assert.equal(ruledLowSc.price_anchor_supported, false);
  assert.equal(ruledLowSc.input.quote_id, 'q1688-syn-kit-100', 'Original quote_id preserved');
  assert.equal(ruledHighSc.comparability_linkage.status, 'pending_evidence');
  assert.equal(ruledHighSc.price_anchor_supported, false);
  assert.ok(bothRuledCand.evidence_review?.review?.subjects?.length === 2, 'Original review records preserved');
  const bothRuledHtml = renderReport(bothRuledScored, bothRuledBatch);
  assert.match(bothRuledHtml, /证据已排除/);
  assert.match(bothRuledHtml, /待补证/);

  const repricedCand = applyPeerComparabilityRulings(structuredClone(bothRuledCand), [
    {
      peer_asin: 'B0SYN8HIG2',
      status: 'confirmed_comparable',
      source: 'owner_verified_parts_list',
      reason: '已补齐同箱含可拆托盘完整清单，同规同销售单位确认可比。',
      evidence: [baseCand.evidence[0].id],
    },
  ]);
  const repricedBatch = { schema_version: 1, profile_revision: 59, candidates: [repricedCand] };
  const repricedScored = scoreBatch(repricedBatch, profile);
  const repricedCard = repricedScored.candidates[0];
  assert.equal(repricedCard.qualification.counts_toward_target, true, 'Re-pricing with verified matching-spec peer restores qualification');
  assert.equal(repricedScored.summary.qualifying, 1);
  assert.deepEqual(
    repricedCard.diagnostics.economics.margin_range,
    [baseHighMargin, baseHighMargin],
    'Recomputed margin range must strictly reflect remaining confirmed $48 scenario only (excluding $38)',
  );
  assert.equal(repricedCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray').comparability_linkage.status, 'confirmed_excluded');
  assert.equal(repricedCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-high-parts-unknown').comparability_linkage.status, 'confirmed_comparable');
  const repricedHtml = renderReport(repricedScored, repricedBatch);
  assert.match(repricedHtml, /证据已排除/);
  assert.doesNotMatch(repricedHtml, /美站参照价<\/dt><dd>US\$\s*38/);

  const v2Cand = structuredClone(bothRuledCand);
  v2Cand.spec_version = 2;
  v2Cand.spec_sha256 = I8_SPEC_SHA_V2;
  const v2Scored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [v2Cand] }, profile);
  const v2Card = v2Scored.candidates[0];
  assert.equal(v2Card.qualification.counts_toward_target, true, 'Old v1 rulings/AI review must NOT overwrite v2 spec');
  assert.deepEqual(v2Card.diagnostics.economics.margin_range, baseCard.diagnostics.economics.margin_range);
  assert.equal(v2Card.diagnostics.economics.scenarios[0].comparability_linkage.status, 'undisputed');
  assert.equal(v2Card.diagnostics.economics.scenarios[0].comparability_linkage.stale_ignored_count >= 1, true);
});

test('Issue #8 (4C): handles seasonal operating_periods re-pricing, all-excluded fallback, raw sourceless ruling rejection, and PII scrubbing in HTML', () => {
  const rawBypassCand = makeStage4OrganizerTrayCandidate(batchFixture.candidates[0], { specSha256: I8_SPEC_SHA_V1, specVersion: 1 });
  rawBypassCand.peer_comparability_rulings = [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', reason: '试图无来源排除', spec_sha256: I8_SPEC_SHA_V1, spec_version: 1 },
  ];
  const rawBypassScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [rawBypassCand] }, profile);
  const rawBypassSc = rawBypassScored.candidates[0].diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray');
  assert.equal(rawBypassSc.comparability_linkage.status, 'undisputed');
  assert.equal(rawBypassSc.comparability_linkage.invalid_ruling_ignored_count, 1);
  assert.equal(rawBypassSc.excluded_from_active_pricing, undefined);

  const allExclCand = applyPeerComparabilityRulings(
    makeStage4OrganizerTrayCandidate(batchFixture.candidates[0], { specSha256: I8_SPEC_SHA_V1, specVersion: 1 }),
    [
      {
        peer_asin: 'B0SYN8LOW1',
        status: 'confirmed_excluded',
        source: 'owner_audit',
        reason: '缺可拆托盘，详见 C:\\Users\\owner-secret\\notes.txt 或 contact buyer@example.com',
      },
      {
        peer_asin: 'B0SYN8HIG2',
        status: 'confirmed_excluded',
        source: 'owner_audit',
        reason: '实核尺寸与件数均不匹配。',
      },
    ],
  );
  const allExclBatch = { schema_version: 1, profile_revision: 59, candidates: [allExclCand] };
  const allExclScored = scoreBatch(allExclBatch, profile);
  const allExclCard = allExclScored.candidates[0];
  assert.equal(allExclCard.qualification.counts_toward_target, false);
  assert.equal(allExclCard.diagnostics.economics.margin_range, null);
  assert.equal(allExclCard.screening.conditions.find(c => c.id === 'reference_price').status, 'pending');
  const allExclHtml = renderReport(allExclScored, allExclBatch);
  assert.doesNotMatch(allExclHtml, /owner-secret|buyer@example\.com/i, 'Ruling reasons must redact local paths and emails in rendered HTML');
  assert.match(allExclHtml, /美站参照价<\/dt><dd>待补证<\/dd>/);

  const flatBase = makeStage4OrganizerTrayCandidate(batchFixture.candidates[0], { specSha256: I8_SPEC_SHA_V1, specVersion: 1 });
  flatBase.product_seasonality = 'seasonal';
  const offScenarios = structuredClone(flatBase.economics.scenarios);
  const peakScenarios = structuredClone(flatBase.economics.scenarios).map(sc => {
    sc.id = `${sc.id}-peak`;
    sc.cost_ledger.id = sc.id;
    sc.cost_ledger.fee_context.sales = { from: '2027-10-15', through: '2027-12-31' };
    sc.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
    sc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
    const ful = sc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    ful.status = 'pending';
    ful.amount_usd = null;
    ful.fee_basis = { status: 'unavailable', version: 'US-FBA-2027-peak-unpublished', marketplace: 'US', currency: 'USD', year: 2027 };
    const col = sc.cost_ledger.lines.find(l => l.id === 'collection');
    col.status = 'pending';
    col.amount_usd = null;
    return sc;
  });
  flatBase.economics = {
    saleable_unit: flatBase.economics.saleable_unit,
    operating_periods: [
      { id: 'off_peak', label: '2027 淡季', months: [2, 3, 4, 5, 6, 7, 8, 9, 10], scenarios: offScenarios },
      { id: 'peak_q4', label: '2027 旺季', months: [10, 11, 12], scenarios: peakScenarios },
    ],
  };

  const seasonalPeakOnly = applyPeerComparabilityRulings(structuredClone(flatBase), [
    { peer_asin: 'B0SYN8LOW1', period_id: 'peak_q4', status: 'confirmed_excluded', source: 'owner_check', reason: '仅旺季排除低价' },
  ]);
  const sPeakOnlyOff = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [seasonalPeakOnly] }, profile)
    .candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(sPeakOnlyOff.screening.conditions.find(c => c.id === 'reference_price').reanchored_from_excluded_ref, undefined, 'peak_q4-scoped ruling must not leak into off_peak');

  const seasonalPending = applyPeerComparabilityRulings(flatBase, [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_check', reason: '无托盘排除' },
    { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_check', reason: '待核托盘清单' },
  ]);
  const sPendScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [seasonalPending] }, profile);
  assert.equal(sPendScored.candidates[0].qualification.counts_toward_target, false);

  const seasonalConfirmed = applyPeerComparabilityRulings(seasonalPending, [
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_comparable', source: 'owner_check', reason: '已确认含托盘' },
  ]);
  const sConfBatch = { schema_version: 1, profile_revision: 59, candidates: [seasonalConfirmed] };
  const sConfScored = scoreBatch(sConfBatch, profile);
  assert.equal(sConfScored.candidates[0].qualification.counts_toward_target, true);
  assert.equal(sConfScored.candidates[0].qualification.mode, 'seasonal_eligible');
  const sConfOffPeak = sConfScored.candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(sConfOffPeak.diagnostics.economics.margin_range[0], sConfOffPeak.diagnostics.economics.margin_range[1]);
  const sConfHtml = renderReport(sConfScored, sConfBatch);
  assert.match(sConfHtml, /证据已排除/);
});

test('Issue #8 (4C) Astra audit regressions: unified anchors, AND/subject_id/period matching, append-only rulings, mixed pending hero, PII/path scrubbing, and refused AI guard', () => {
  const mkCand = () => makeStage4OrganizerTrayCandidate(batchFixture.candidates[0], { specSha256: I8_SPEC_SHA_V1, specVersion: 1 });

  const exclById = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', status: 'confirmed_excluded', source: 'owner', reason: '排除低价情景' },
    { scenario_id: 'sc-high-parts-unknown', status: 'confirmed_excluded', source: 'owner', reason: '排除高价情景' },
  ]);
  const exclByIdScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [exclById] }, profile);
  assert.equal(exclByIdScored.candidates[0].screening.conditions.find(c => c.id === 'reference_price').status, 'pending');
  assert.match(renderReport(exclByIdScored, { schema_version: 1, profile_revision: 59, candidates: [exclById] }), /美站参照价<\/dt><dd>待补证<\/dd>/);

  const anchorlessHigh = mkCand();
  delete anchorlessHigh.economics.scenarios[1].price_anchor;
  const anchorlessRuled = applyPeerComparabilityRulings(anchorlessHigh, [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '公共锚点已排除' },
  ]);
  const anchorlessScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [anchorlessRuled] }, profile);
  assert.equal(anchorlessScored.candidates[0].qualification.counts_toward_target, false);
  assert.equal(anchorlessScored.candidates[0].diagnostics.economics.margin_range, null);

  const belowFloorCand = mkCand();
  belowFloorCand.economics.scenarios[1].price_anchor.value = 28.00;
  belowFloorCand.economics.scenarios[1].cost_ledger.price_usd = 28.00;
  const belowFloorRuled = applyPeerComparabilityRulings(belowFloorCand, [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '仅剩低价实证' },
  ]);
  const belowFloorScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [belowFloorRuled] }, profile);
  assert.equal(belowFloorScored.candidates[0].screening.conditions.find(c => c.id === 'reference_price').status, 'fail');

  const dualIdCand = mkCand();
  dualIdCand.economics.scenarios[0].subject_id = 'peer-drawer-custom';
  dualIdCand.evidence_review = {
    status: 'ready', execution_status: 'completed', content_status: 'usable',
    candidate_id: dualIdCand.id, form_spec_sha256: I8_SPEC_SHA_V1,
    review: { subjects: [{ subject_id: 'peer-drawer-custom', disposition: 'excluded', reason: '缺抽屉' }] },
  };
  assert.equal(resolveScenarioComparabilityLinkage(dualIdCand.economics.scenarios[0], dualIdCand).status, 'ai_dispute_pending_ruling');
  dualIdCand.evidence_review.execution_status = 'failed_known';
  dualIdCand.evidence_review.content_status = 'refused';
  assert.equal(resolveScenarioComparabilityLinkage(dualIdCand.economics.scenarios[0], dualIdCand), null);

  const andCand = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', peer_asin: 'B0OTHER999', status: 'confirmed_excluded', source: 'owner', reason: '不同 ASIN 不应命中' },
  ]);
  assert.equal(resolveScenarioComparabilityLinkage(andCand.economics.scenarios[0], andCand), null);

  const mixedCand = mkCand();
  mixedCand.economics.expected_primary_scenarios = [
    { id: 'sc-low-no-tray', status: 'cancelled', reason: '缺托盘有据撤销', evidence: [mixedCand.evidence[0].id] },
    { id: 'sc-high-parts-unknown', status: 'active' },
  ];
  const cancelRes = scoreBatch({
    schema_version: 1, profile_revision: 59,
    candidates: [applyPeerComparabilityRulings(mixedCand, [{ peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '确认排除' }])],
  }, profile);
  assert.equal(cancelRes.candidates[0].qualification.counts_toward_target, true);

  const piiPending = applyPeerComparabilityRulings(mkCand(), [
    { peer_asin: 'B0SYN8LOW1', status: 'pending_evidence', source: 'D:\\private\\audit.txt', reason: '联系 leak@example.com 核实托盘' },
  ]);
  const piiPendingBatch = { schema_version: 1, profile_revision: 59, candidates: [piiPending] };
  const piiPendingScored = scoreBatch(piiPendingBatch, profile);
  assert.equal(piiPendingScored.candidates[0].diagnostics.economics.margin_range, null);
  const piiHtml = renderReport(piiPendingScored, piiPendingBatch);
  assert.doesNotMatch(piiHtml, /leak@example\.com|D:\\private\\audit\.txt/i);
  assert.match(piiHtml, /hero-stat-val[^>]*>待补证<\/p>/);
  assert.match(piiHtml, /单件净留存<\/span>\s*<strong[^>]*>待补证<\/strong>/);
  assert.match(piiHtml, /美站参照价<\/dt><dd>待补证<\/dd>/);
  assert.equal(piiHtml.includes('<div class="alloc-strip"'), false);

  const flatPeriodLeak = applyPeerComparabilityRulings(mkCand(), [
    { peer_asin: 'B0SYN8LOW1', period_id: 'peak_q4', status: 'confirmed_excluded', source: 'owner', reason: '仅旺季排除' },
  ]);
  assert.equal(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [flatPeriodLeak] }, profile).candidates[0].diagnostics.economics.scenarios[0].excluded_from_active_pricing, undefined);

  const partialScenExcl = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', status: 'confirmed_excluded', source: 'owner', reason: '按情景排除低价' },
  ]);
  const partialScenRef = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [partialScenExcl] }, profile)
    .candidates[0].screening.conditions.find(c => c.id === 'reference_price');
  assert.deepEqual(partialScenRef.effective_price_range, [48, 48]);
  assert.equal(partialScenRef.reanchored_from_excluded_ref, true);

  const partialScenPend = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', status: 'confirmed_excluded', source: 'owner', reason: '排除低价' },
    { scenario_id: 'sc-high-parts-unknown', status: 'pending_evidence', source: 'owner', reason: '高价待补证' },
  ]);
  assert.equal(
    scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [partialScenPend] }, profile)
      .candidates[0].screening.conditions.find(c => c.id === 'reference_price').status,
    'pending',
  );

  const noRootShaCand = i8AttachSyntheticAiReview(mkCand());
  delete noRootShaCand.spec_sha256;
  delete noRootShaCand.spec_version;
  assert.equal(resolveScenarioComparabilityLinkage(noRootShaCand.economics.scenarios[0], noRootShaCand)?.status, 'ai_dispute_pending_ruling');

  const multiHist = mkCand();
  multiHist.peer_comparability_rulings = [
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_excluded', source: 's1', reason: '初判排除', spec_sha256: I8_SPEC_SHA_V1, spec_version: 1 },
    { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 's2', reason: '转待补证', spec_sha256: I8_SPEC_SHA_V1, spec_version: 1 },
  ];
  const resolvedHist = applyPeerComparabilityRulings(multiHist, [
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_comparable', source: 's3', reason: '补齐清单确认可比' },
  ]);
  assert.equal(resolvedHist.peer_comparability_rulings.length, 3, 'Append-only keeps all 3 rulings');
  const histScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [resolvedHist] }, profile);
  assert.equal(histScored.candidates[0].qualification.counts_toward_target, true);

  const stalePreserved = applyPeerComparabilityRulings(mkCand(), [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '过期标记不可丢失', stale_spec: true },
  ]);
  assert.equal(stalePreserved.peer_comparability_rulings[0].stale_spec, true);
  assert.equal(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [stalePreserved] }, profile).candidates[0].qualification.counts_toward_target, true);

  const ruledByOnly = mkCand();
  ruledByOnly.peer_comparability_rulings = [
    { peer_asin: 'B0SYN8LOW1', status: 'pending_evidence', ruled_by: 'owner', reason: '缺显式 source', spec_sha256: I8_SPEC_SHA_V1, spec_version: 1 },
  ];
  assert.equal(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [ruledByOnly] }, profile).candidates[0].qualification.counts_toward_target, true);
});

function step2Make2027OffPeakScenarioFromBase(baseCand, id = 'sc-evergreen-2027') {
  const pkgRef = baseCand.economics.scenarios[0].cost_ledger.fee_context.package_ref;
  const sc = structuredClone(baseCand.economics.scenarios[0]);
  sc.id = sc.cost_ledger.id = id;
  sc.cost_ledger.fee_context = {
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  for (const line of sc.cost_ledger.lines) {
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
  return sc;
}

function step2DeferAllRemaining15ForSampleCheck(cand) {
  const ev = [cand.evidence[0].id];
  cand.judgments = {
    ...cand.judgments,
    existing_solution_fit: {
      anchor: null,
      complete_set_verified: true,
      sample_check_required: true,
      reason: '待拿样核对英文说明书与激光配件编号。',
      evidence: ev,
    },
    feasible_light_differentiation: {
      anchor: null,
      sample_check_required: true,
      reason: '待拿样同工厂核对防滑脚垫微改工艺。',
      evidence: ev,
    },
    storage_tolerance: {
      anchor: null,
      sample_check_required: true,
      reason: '待拿样核对防潮封膜与叠码承重。',
      evidence: ev,
    },
    transport_tolerance: {
      anchor: null,
      sample_check_required: true,
      reason: '待拿样实测六面跌落与珍珠棉内衬。',
      evidence: ev,
    },
    routine_complexity: {
      anchor: null,
      sample_check_required: true,
      reason: '待旺旺确认备用螺丝包与常规质检比例。',
      evidence: ev,
    },
    specific_design_rights: {
      anchor: null,
      prescreen_completed: true,
      proven_conflict: false,
      sample_check_required: true,
      reason: 'USPTO 公开初筛无实锤冲突，待拿实物逐条比对卡槽结构。',
      evidence: ev,
    },
    applicable_public_requirements: {
      anchor: null,
      prescreen_completed: true,
      proven_conflict: false,
      hard_ban: false,
      sample_check_required: true,
      reason: '无强制禁售，待向工厂确认木材拉丁学名用于 Lacey Act 申报。',
      evidence: ev,
    },
  };
}

test('Step 2.1: Unified 85-pt objective core ranking puts 85/85 sample-pending card ahead of 82/85 complete 97/100 card and breaks ties by confirmed_risk_deduction_15', () => {
  const cardComplete97 = structuredClone(batchFixture.candidates[0]);
  cardComplete97.id = 'aaa-complete-97-core82';
  cardComplete97.label = '完整97分卡（核心82/85）';
  cardComplete97.market.concentrations.product.value = 1.0;

  const cardSamplePending85 = structuredClone(batchFixture.candidates[0]);
  cardSamplePending85.id = 'zzz-sample-pending-85-core85';
  cardSamplePending85.label = '待拿样85分卡（核心85/85）';
  step2DeferAllRemaining15ForSampleCheck(cardSamplePending85);

  const cardSeasonalCore83 = structuredClone(batchFixture.candidates[0]);
  cardSeasonalCore83.id = 'mmm-seasonal-93-core83';
  cardSeasonalCore83.label = '分季93分权重卡（核心83/85）';
  cardSeasonalCore83.product_seasonality = 'seasonal';
  cardSeasonalCore83.judgments.supported_opportunity.anchor = 4;
  const evS = [cardSeasonalCore83.evidence[0].id];
  cardSeasonalCore83.judgments.existing_solution_fit = {
    anchor: null,
    complete_set_verified: true,
    sample_check_required: true,
    reason: '待拿样核对说明书与箱规。',
    evidence: evS,
  };
  cardSeasonalCore83.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: true,
    proven_conflict: false,
    sample_check_required: true,
    reason: '公开库初筛无实锤冲突，待实物核对。',
    evidence: evS,
  };
  const scOff = step2Make2027OffPeakScenarioFromBase(cardSeasonalCore83, 'sc-seas-83');
  cardSeasonalCore83.economics = buildPairedSeasonalOperatingPeriods({
    saleable_unit: cardSeasonalCore83.economics.saleable_unit,
    off_peak_scenarios: [scOff],
    cubic_feet_per_unit: 0.25,
    storage_evidence: evS,
  });

  const cardTieDeduct3 = structuredClone(cardComplete97);
  cardTieDeduct3.id = 'bbb-tie-core82-deduct3-total94';
  cardTieDeduct3.label = '同核82分·已确认扣3分（总分94/100）';
  cardTieDeduct3.judgments.existing_solution_fit.anchor = 2;
  cardTieDeduct3.judgments.storage_tolerance.anchor = 1;

  const cardTieDeduct0Pending = structuredClone(cardComplete97);
  cardTieDeduct0Pending.id = 'yyy-tie-core82-deduct0-wt93';
  cardTieDeduct0Pending.label = '同核82分·零扣分含7分待拿样（已得90/93）';
  cardTieDeduct0Pending.judgments.existing_solution_fit = {
    anchor: null,
    complete_set_verified: true,
    sample_check_required: true,
    reason: '待拿样核对配件袋标识。',
    evidence: [cardTieDeduct0Pending.evidence[0].id],
  };
  cardTieDeduct0Pending.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: true,
    proven_conflict: false,
    sample_check_required: true,
    reason: '公开库无实锤冲突，待拿样确认倒角细节。',
    evidence: [cardTieDeduct0Pending.evidence[0].id],
  };

  const batch = {
    schema_version: 1,
    profile_revision: 59,
    candidates: [
      cardTieDeduct3,
      cardComplete97,
      cardSeasonalCore83,
      cardTieDeduct0Pending,
      cardSamplePending85,
    ],
  };

  const res = scoreBatch(batch, profile);
  const byId = new Map(res.candidates.map(c => [c.candidate_id, c]));

  const s85 = byId.get('zzz-sample-pending-85-core85');
  const s97 = byId.get('aaa-complete-97-core82');
  const s83 = byId.get('mmm-seasonal-93-core83');
  const sTie0 = byId.get('yyy-tie-core82-deduct0-wt93');
  const sTie3 = byId.get('bbb-tie-core82-deduct3-total94');

  assert.deepEqual(s85.core_85_range, [85, 85]);
  assert.equal(s85.covered_weight, 85);
  assert.deepEqual(s85.supported_range, [85, 85]);
  assert.equal(s85.confirmed_risk_deduction_15, 0);
  assert.equal(s85.qualification.counts_toward_target, true);

  assert.deepEqual(s97.core_85_range, [82, 82]);
  assert.equal(s97.covered_weight, 100);
  assert.deepEqual(s97.total_range, [97, 97]);
  assert.equal(s97.confirmed_risk_deduction_15, 0);
  assert.equal(s97.qualification.counts_toward_target, true);

  assert.deepEqual(s83.core_85_range, [83, 83]);
  assert.equal(s83.confirmed_risk_deduction_15, 0);
  assert.equal(s83.qualification.counts_toward_target, true);

  assert.deepEqual(sTie0.core_85_range, [82, 82]);
  assert.equal(sTie0.confirmed_risk_deduction_15, 0);
  assert.equal(sTie0.covered_weight, 93);
  assert.deepEqual(sTie0.supported_range, [90, 90]);

  assert.deepEqual(sTie3.core_85_range, [82, 82]);
  assert.equal(sTie3.confirmed_risk_deduction_15, 3);
  assert.deepEqual(sTie3.total_range, [94, 94]);

  const expectedOrder = [
    'zzz-sample-pending-85-core85',
    'mmm-seasonal-93-core83',
    'aaa-complete-97-core82',
    'yyy-tie-core82-deduct0-wt93',
    'bbb-tie-core82-deduct3-total94',
  ];
  assert.deepEqual(res.qualifying_order, expectedOrder);
  assert.deepEqual(res.candidates.map(c => c.candidate_id), expectedOrder);

  const reversedRes = scoreBatch({ ...batch, candidates: [...batch.candidates].reverse() }, profile);
  assert.deepEqual(reversedRes.candidates.map(c => c.candidate_id), expectedOrder);

  const html = renderReport(res, batch);
  assert.ok(html.includes('85 分客观核心：85 / 85'));
  assert.ok(html.includes('85 分客观核心：82 / 85'));
  assert.ok(html.includes('已确认风险扣分 3 分'));
  assert.ok(html.includes('剩余 15 分已证项与待核原因明细'));
  assert.ok(html.includes('待拿样核对配件袋标识'));
  assert.equal(html.includes('\u2014'), false, 'HTML report must contain zero em-dashes');
});

test('Step 2.2: Evergreen products stay evergreen on 2027 off-peak window without forced seasonal_review and carry unpublished_2027_q4_peak_note metadata', () => {
  const baseEvergreen = structuredClone(batchFixture.candidates[0]);
  baseEvergreen.id = 'cand-evergreen-2027-flat';
  const scOff = step2Make2027OffPeakScenarioFromBase(baseEvergreen, 'sc-evg-offpeak');

  baseEvergreen.economics = buildEvergreen2027OffPeakEconomics({
    saleable_unit: baseEvergreen.economics.saleable_unit,
    off_peak_scenarios: [scOff],
  });
  const scoredFlat = scoreCandidate(baseEvergreen, profile);
  assert.equal(scoredFlat.queue, 'comparable', JSON.stringify(scoredFlat.qualification));
  assert.notEqual(scoredFlat.queue, 'seasonal_review');
  assert.equal(scoredFlat.effective_disposition, 'full_annual_qualifying');
  assert.equal(scoredFlat.product_seasonality, 'evergreen');
  assert.equal(scoredFlat.unpublished_2027_q4_peak_note, UNPUBLISHED_2027_Q4_PEAK_METADATA_NOTE);
  assert.equal(scoredFlat.qualification.counts_toward_target, true);
  assert.equal(scoredFlat.qualification.product_seasonality, 'evergreen');
  assert.equal(scoredFlat.qualification.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');

  const sampleEvg = structuredClone(baseEvergreen);
  sampleEvg.id = 'cand-evergreen-2027-sample-pending';
  step2DeferAllRemaining15ForSampleCheck(sampleEvg);
  const scoredSampleEvg = scoreCandidate(sampleEvg, profile);
  assert.equal(scoredSampleEvg.queue, 'pending');
  assert.equal(scoredSampleEvg.qualification.counts_toward_target, true);
  assert.equal(scoredSampleEvg.qualification.mode, 'sample_pending_qualifying');
  assert.equal(scoredSampleEvg.effective_disposition, 'full_annual_qualifying');
  assert.equal(scoredSampleEvg.product_seasonality, 'evergreen');
  assert.equal(scoredSampleEvg.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');

  const wrappedEvg = structuredClone(batchFixture.candidates[0]);
  wrappedEvg.id = 'cand-evergreen-unwrapped';
  wrappedEvg.product_seasonality = 'evergreen';
  wrappedEvg.economics = buildPairedSeasonalOperatingPeriods({
    saleable_unit: wrappedEvg.economics.saleable_unit,
    off_peak_scenarios: [step2Make2027OffPeakScenarioFromBase(wrappedEvg, 'sc-evg-wrap')],
    cubic_feet_per_unit: 0.25,
    storage_evidence: [wrappedEvg.evidence[0].id],
  });
  const scoredUnwrapped = scoreCandidate(wrappedEvg, profile);
  assert.equal(scoredUnwrapped.queue, 'comparable');
  assert.equal(scoredUnwrapped.product_seasonality, 'evergreen');
  assert.equal(scoredUnwrapped.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');

  const explicitSeasonalFlat = structuredClone(baseEvergreen);
  explicitSeasonalFlat.id = 'cand-explicit-seasonal-missing-peak';
  explicitSeasonalFlat.product_seasonality = 'seasonal';
  const scoredBadSeasonal = scoreCandidate(explicitSeasonalFlat, profile);
  assert.equal(scoredBadSeasonal.qualification.counts_toward_target, false);
  assert.equal(scoredBadSeasonal.queue, 'pending');

  const ingested = ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    candidates: [
      {
        candidate: (() => {
          const c = structuredClone(batchFixture.candidates[0]);
          c.id = 'cand-ingested-evergreen-2027';
          delete c.economics.scenarios;
          return c;
        })(),
        evergreen_2027: {
          saleable_unit: batchFixture.candidates[0].economics.saleable_unit,
          off_peak_scenarios: [step2Make2027OffPeakScenarioFromBase(batchFixture.candidates[0], 'sc-ing-evg')],
        },
      },
    ],
  }, profile, { allowSyntheticWithoutReceipts: true });
  const batchRes = scoreBatch(ingested.batch, profile);
  assert.equal(batchRes.candidates[0].queue, 'comparable');
  assert.equal(batchRes.candidates[0].product_seasonality, 'evergreen');
  assert.equal(batchRes.candidates[0].unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');
  const html = renderReport(batchRes, ingested.batch);
  assert.ok(html.includes('常青品（非季节款）'));
  assert.ok(html.includes('2027 Q4 旺季费率待亚马逊公布'));
});

test('R3 closure (scoring): excluded/deferred priority strictly beats crossing_30pct_interval in scoring and report', () => {
  const candExclCross = structuredClone(batchFixture.candidates[0]);
  candExclCross.id = 'cand-excl-cross';
  candExclCross.judgments.specific_design_rights = {
    anchor: 0,
    proven_conflict: true,
    reason: 'Matched synthetic active design patent.',
    evidence: ['synthetic-evidence'],
  };
  const scPass = structuredClone(candExclCross.economics.scenarios[0]);
  const scFail = structuredClone(scPass);
  scFail.id = scFail.cost_ledger.id = 'sc-below-30';
  scFail.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd += 12;
  candExclCross.economics.scenarios = [scPass, scFail];
  const batchExcl = { ...structuredClone(batchFixture), profile_revision: 59, candidates: [candExclCross] };
  const scoredExcl = scoreBatch(batchExcl, profile);
  assert.equal(scoredExcl.candidates[0].queue, 'excluded');
  assert.notEqual(scoredExcl.candidates[0].effective_disposition, 'crossing_30pct_interval');
  const htmlExcl = renderReport(scoredExcl, batchExcl);
  assert.equal(htmlExcl.includes('跨 30% 红线'), false, 'Excluded card must never display 跨 30% 红线');
});

test('SellerSprite monthly archive market (15 pts) and r59 NEAR_30_DAYS Q31 interval target_child_units scoring', () => {
  const cand = structuredClone(batchFixture.candidates[0]);
  cand.id = 'cand-near30-archive';
  const evId = cand.evidence[0].id;

  cand.market = ingestSellerSpriteMonthlyArchiveMarket({
    dataMonth: '202610',
    newProductRatio: 18.5,
    newProductSalesRatio: 14.2,
    commodityConcentration: 34.0,
    brandConcentration: 38.0,
    sellerConcentration: 36.0,
    amzSalesRatio: 6.4,
    sellers: 12,
    top10MedianReviews: 85,
  }, { evidence: [evId] });

  const origMember = structuredClone(cand.newcomer_cohort.members[0]);
  delete origMember.current_bsr_rank;
  delete origMember.current_bsr_node;
  origMember.family_id = 'fam-new-1';
  origMember.asin = 'B0SYNNEW01';
  origMember.launch_date = '2026-09-15';
  origMember.units_30d = { value_range: [42, 48], unit: 'units', period: 'NEAR_30_DAYS', grain: 'target_child_units', evidence: [evId] };
  origMember.natural = {
    ...origMember.natural,
    period: 'latelyDay_30',
    window_days: 30,
    view_grain: 'child_asin',
    request: { isListingSearch: false, timePieceType: 'latelyDay', timePieceValue: '30' },
  };

  cand.newcomer_cohort = {
    ...cand.newcomer_cohort,
    observation_basis: 'sellersprite_near_30_days',
    observation_date: '2026-11-13',
    period: 'NEAR_30_DAYS',
    scope: 'sellersprite_near_30_days',
    grain: 'target_child_units',
    relevant_bsr_node: 'Synthetic Leaf > Subnode (888888011)',
    query_complete: true,
    evidence: [evId],
    market_reference: {
      scope: 'sellersprite_near_30_days_all_ages',
      node: 'Synthetic Leaf > Subnode (888888011)',
      period: 'NEAR_30_DAYS',
      grain: 'target_child_units',
      deduplicated: true,
      coverage_supported: true,
      evidence: [evId],
      families: [
        {
          family_id: 'fam-ref-1',
          asin: 'B0SYNREF01',
          comparability_verdict: 'comparable',
          units_30d: { value: 60, unit: 'units', period: 'NEAR_30_DAYS', grain: 'target_child_units', evidence: [evId] },
        },
        {
          family_id: 'fam-new-1',
          asin: 'B0SYNNEW01',
          comparability_verdict: 'comparable',
          units_30d: { value_range: [42, 48], unit: 'units', period: 'NEAR_30_DAYS', grain: 'target_child_units', evidence: [evId] },
        },
      ],
    },
    members: [origMember],
  };

  const r59Scored = scoreCandidate(cand, profile);
  for (const mId of ['new_product_count_share', 'new_product_sales_share', 'product_dispersion', 'brand_dispersion', 'seller_dispersion']) {
    assert.equal(r59Scored.items.find(i => i.id === mId).status, 'scored', `${mId} must score from SellerSprite monthly archive`);
  }
  const q31Sales = r59Scored.items.find(i => i.id === 'low_rating_sales_performance');
  const q31Nat = r59Scored.items.find(i => i.id === 'natural_visibility_development');
  assert.equal(q31Sales.status, 'scored', JSON.stringify(q31Sales));
  assert.ok(q31Sales.score_range[0] < q31Sales.score_range[1], 'Interval target_child_units produces exact score_range');
  assert.equal(q31Nat.status, 'scored', JSON.stringify(q31Nat));
});

test('sample_pending_qualifying gate (91/100 covered + deferred sample items null), 1688 stop rule, competition callouts, and 100-set capital reference', () => {
  const candSamplePending = structuredClone(batchFixture.candidates[0]);
  candSamplePending.id = 'cand-sample-pending-qualifying';
  candSamplePending.label = '核桃木桌面收纳架（核心齐备·待拿样问工厂）';
  const evId = candSamplePending.evidence[0].id;

  candSamplePending.market = ingestSellerSpriteMonthlyArchiveMarket({
    dataMonth: '202610',
    newProductRatio: 22.0,
    newProductSalesRatio: 16.0,
    commodityConcentration: 42.0,
    brandConcentration: 44.0,
    sellerConcentration: 45.0,
    amzSalesRatio: 54.0,
    sellers: 11,
    top10MedianReviews: 78,
  }, { evidence: [evId] });

  candSamplePending.judgments.existing_solution_fit = {
    anchor: null,
    complete_set_verified: true,
    sample_check_required: true,
    reason: '1688 齐套现货已核实，英文说明书与激光件号待拿样向工厂确认',
    evidence: [evId],
  };
  candSamplePending.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: true,
    sample_check_required: true,
    reason: '公开专利初筛无实锤侵权；1件外观号待拿实物卡槽比对',
    evidence: [evId],
  };
  candSamplePending.judgments.applicable_public_requirements = {
    anchor: null,
    prescreen_completed: true,
    sample_check_required: true,
    reason: '常规法规初筛通过；Lacey Act 树种拉丁学名待旺旺核实',
    evidence: [evId],
  };

  const probe = scoreCandidate(structuredClone(batchFixture.candidates[0]), profile);
  const baseCalc = probe.diagnostics.economics.scenarios[0].input.calculation;
  const sc0 = candSamplePending.economics.scenarios[0];
  sc0.cost_ledger.fx_cny_per_usd = 7.20;
  const proc0 = sc0.cost_ledger.lines.find(l => l.id === 'procurement');
  proc0.amount_usd = Number((baseCalc.net_revenue_usd * (1 - 0.34) - (baseCalc.net_cost_usd - proc0.amount_usd)).toFixed(4));

  const r59Res = scoreCandidate(candSamplePending, profile);
  assert.equal(r59Res.qualification.counts_toward_target, true, JSON.stringify(r59Res.qualification));
  assert.equal(r59Res.qualification.mode, 'sample_pending_qualifying');
  assert.equal(r59Res.covered_weight, 91);
  assert.equal(r59Res.sample_check_items.length, 3);
  assert.equal(r59Res.diagnostics.economics.second_factory_quote_needed, false, '1st factory all >=30% stops without extra 1688 queries');

  const candBelow = structuredClone(batchFixture.candidates[0]);
  candBelow.id = 'cand-below-30-elim';
  candBelow.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.20;
  const procBelow = candBelow.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement');
  procBelow.amount_usd = Number((baseCalc.net_revenue_usd * (1 - 0.25) - (baseCalc.net_cost_usd - procBelow.amount_usd)).toFixed(4));
  const r59Below = scoreCandidate(candBelow, profile);
  assert.equal(r59Below.diagnostics.economics.second_factory_quote_needed, true);

  const candProvenConflict = structuredClone(candSamplePending);
  candProvenConflict.id = 'cand-proven-ip-conflict';
  candProvenConflict.judgments.specific_design_rights = {
    anchor: 0,
    proven_conflict: true,
    reason: '命中实锤同结构专利冲突',
    evidence: [evId],
  };
  const conflictRes = scoreCandidate(candProvenConflict, profile);
  assert.equal(conflictRes.qualification.counts_toward_target, false);
  assert.equal(conflictRes.queue, 'excluded');

  const candBareParts = structuredClone(candSamplePending);
  candBareParts.id = 'cand-bare-parts';
  candBareParts.economics.scenarios[0].complete_set_verified = false;
  const bareRes = scoreCandidate(candBareParts, profile);
  assert.equal(bareRes.qualification.counts_toward_target, false);

  const fullQualCand = structuredClone(batchFixture.candidates[0]);
  fullQualCand.id = 'cand-full-100';
  const batchInput = {
    schema_version: 1,
    profile_revision: 59,
    negotiation_shortlist: [{ form_id: 'cand-below-30-elim', label: 'Legacy shortlist', eligible: true, required_discount_fraction: 0.05, price_usd: 49.99 }],
    candidates: [candSamplePending, fullQualCand, candBelow],
  };
  const batchScored = scoreBatch(batchInput, profile);
  assert.equal(batchScored.summary.qualifying, 2);
  assert.equal(batchScored.summary.sample_pending_qualifying, 1);
  assert.equal(batchScored.negotiation_shortlist, undefined, 'r59 retires separate <=12% negotiation_shortlist');

  const html = renderReport(batchScored, batchInput);
  assert.match(html, /已得分\s*[\d.–-]+\s*\/\s*已覆盖总权重\s*91/);
  assert.match(html, /拿样／1688 问厂待核清单/);
  assert.match(html, /Top-10\s*评论中位数/);
  assert.match(html, /亚马逊自营（AMZ）销量占比/);
  assert.match(html, /自营超第三方，强烈建议放弃/);
  assert.match(html, /小蓝海仅\s*11\s*家，非巨头垄断/);
  assert.match(html, /单件落地本金（采购\s*\+\s*国内运费\s*\+\s*头程）/);
  assert.match(html, /按\s*100\s*套试算参考本金/);
  assert.doesNotMatch(html, /data-section="negotiation-shortlist"/);
  assert.match(html, /需把拿货价压到\s*¥[\d.,–-]+\s*才达标/);
});

test('Scoring & judgment guards (#4, #17, H7, H8, M8): strong/moderate #17, #4 grain/stat rejections vs family_units, prescreen_completed, hard_ban, and reviews_inspected', () => {
  const jStrong = resolveStage1QualitativeJudgments({
    review_judge: {
      status: 'supported',
      support_level: 'strong',
      reason: 'SKU-verified 1-star reviews confirm loose brass thumbscrew.',
      evidence_refs: ['ev-rev-1'],
      review_citations: [{ review_id: 'R1', sku_verified: true }],
    },
  });
  assert.equal(jStrong.judgments.feasible_light_differentiation.anchor, 1);
  const jMod = resolveStage1QualitativeJudgments({
    review_judge: {
      status: 'supported',
      support_level: 'moderate',
      reason: 'SKU-verified reviews suggest thicker felt pad.',
      evidence_refs: ['ev-rev-2'],
      review_citations: [{ review_id: 'R2', sku_verified: true }],
    },
  });
  assert.equal(jMod.judgments.feasible_light_differentiation.anchor, 0.5);

  const badChildScaleCand = structuredClone(batchFixture.candidates[0]);
  badChildScaleCand.metrics.purchase_demand_scale.scope = 'single_color_child_median';
  assert.equal(scoreCandidate(badChildScaleCand, profile).items.find(i => i.id === 'purchase_demand_scale').score, null, '#4 rejects single_color_child_median');

  const medianDemandCand = structuredClone(batchFixture.candidates[0]);
  medianDemandCand.metrics.purchase_demand_scale = {
    ...medianDemandCand.metrics.purchase_demand_scale,
    grain: 'target_child_units',
    statistic: 'median',
  };
  assert.equal(scoreCandidate(medianDemandCand, profile).items.find(i => i.id === 'purchase_demand_scale').score, null, '#4 rejects target_child_units + median');

  const childPointCand = structuredClone(batchFixture.candidates[0]);
  childPointCand.metrics.purchase_demand_scale = {
    ...childPointCand.metrics.purchase_demand_scale,
    grain: 'target_child_units',
    aggregation: 'sum',
  };
  assert.equal(scoreCandidate(childPointCand, profile).items.find(i => i.id === 'purchase_demand_scale').score, null, '#4 rejects point target_child_units');

  const familyUnitsCand = structuredClone(batchFixture.candidates[0]);
  familyUnitsCand.metrics.purchase_demand_scale = {
    ...familyUnitsCand.metrics.purchase_demand_scale,
    grain: 'family_units',
  };
  assert.ok(scoreCandidate(familyUnitsCand, profile).items.find(i => i.id === 'purchase_demand_scale').score > 0, '#4 accepts family_units');

  const unprescreenedCand = structuredClone(batchFixture.candidates[0]);
  unprescreenedCand.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: false,
    sample_check_required: true,
    reason: 'Need physical comparison, but public patent search was NOT completed yet.',
    evidence: ['synthetic-evidence'],
  };
  assert.equal(scoreCandidate(unprescreenedCand, profile).qualification.counts_toward_target, false, 'prescreen_completed:false MUST NOT enter sample_pending_qualifying');

  const hardBanCand = structuredClone(batchFixture.candidates[0]);
  hardBanCand.judgments.applicable_public_requirements = {
    anchor: 0,
    hard_ban: true,
    proven_conflict: true,
    reason: 'Statutory CPSC / EPA hard ban.',
    evidence: ['synthetic-evidence'],
  };
  assert.equal(scoreCandidate(hardBanCand, profile).screening.status, 'excluded', 'hard_ban:true sets screening.status="excluded"');

  const falseInspCand = structuredClone(batchFixture.candidates[0]);
  falseInspCand.judgments.feasible_light_differentiation = {
    ...falseInspCand.judgments.feasible_light_differentiation,
    anchor: 1,
    reviews_inspected: false,
  };
  assert.equal(scoreCandidate(falseInspCand, profile).items.find(i => i.id === 'feasible_light_differentiation').score, null, 'reviews_inspected:false rejected in scoreCandidate');
});
