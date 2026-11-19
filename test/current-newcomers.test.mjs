import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreCandidate } from '../src/scoring.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
const currentProfile = structuredClone(profile);
currentProfile.revision = currentProfile.workflow.scoring_and_ordering.revision = 57;
profile.revision = 51;
profile.workflow.scoring_and_ordering.revision = 51;
const obs = (value, unit) => ({ value, unit, evidence: ['source'] });
const member = (id, ratings, units, share = 0.35) => ({
  family_id: id, asin: `${id}-listing`, status: 'qualified', reason: 'Synthetic current normal launch.',
  evidence: ['source'], launch_date: '2026-10-01', current_bsr_node: 'node', current_bsr_rank: 20,
  ratings: obs(ratings, 'count'), units_30d: obs(units, 'units'),
  natural: { ...obs(share, 'fraction'), provider: 'sif', scope: 'overall', period: '30d', relevant_entries_evidence: ['source'] },
});
function candidate(members = [member('new', 0, 1)]) {
  return { id: 'synthetic-current', form: 'Synthetic complete saleable form',
    evidence: [{ id: 'source', source: 'Synthetic query and normal-start checks', observed_at: '2026-11-15' }],
    newcomer_cohort: {
      reference_supported: true, observation_basis: 'current_latest_30_days', observation_date: '2026-11-15',
      period: '30d', niche: 'Relevant broad functional category', grain: 'family_representative', relevant_bsr_node: 'node',
      scope: 'current_relevant_bsr_top100', query_complete: true, evidence: ['source'], members,
      market_reference: {
        node: 'node', period: '30d', grain: 'family_representative', deduplicated: true, coverage_supported: true,
        scope: 'current_relevant_bsr_top100_all_ages', evidence: ['source'],
        families: ['old-a', 'old-b', 'old-c'].map(id => ({ family_id: id, units_30d: obs(100, 'units') })),
      },
    },
  };
}
const get = (result, id) => result.items.find(item => item.id === id);

test('complete four-point examples take precedence over unresolved examples that can only tie', () => {
  const input = candidate([member('a-unknown', null, 100), member('b-unknown', null, 100),
    member('y-complete', 5, 100, 0.35), member('z-complete', 10, 100, 0.7)]);
  const result = scoreCandidate(input, currentProfile);
  assert.equal(get(result, 'low_rating_sales_performance').score, 4);
  assert.equal(get(result, 'natural_visibility_development').score, 0.75);
  assert.deepEqual(result.diagnostics.newcomers.selected_pair.map(row => row.family_id), ['y-complete', 'z-complete']);
  assert.deepEqual(result.diagnostics.newcomers.unresolved_possible_examples.map(row => row.possible_upper), [4, 4]);
  assert.equal(result.diagnostics.newcomers.examples[0].score, null);
  assert.equal(input.newcomer_cohort.members[0].ratings.value, null);
});

test('equal-bound precedence also applies below four points and preserves revision-51 replay', () => {
  const input = candidate([member('a-unknown', null, 50), member('y-complete', 25, 100), member('z-complete', 25, 100)]);
  const current = scoreCandidate(input, currentProfile);
  assert.equal(get(current, 'low_rating_sales_performance').score, 3);
  assert.equal(current.diagnostics.newcomers.unresolved_possible_examples[0].selection_blocking, false);
  const previous = scoreCandidate(input, profile);
  assert.equal(get(previous, 'low_rating_sales_performance').score, null);
  assert.equal(previous.diagnostics.newcomers.unresolved_possible_examples[0].selection_blocking, true);
});

test('a possibly stronger unknown or an unresolved second example still blocks scoring', () => {
  for (const rows of [
    [member('a-unknown', null, 100), member('y-complete', 5, 100), member('z-complete', 25, 100)],
    [member('a-unknown', null, 100), member('y-complete', 5, 100)],
  ]) {
    const result = scoreCandidate(candidate(rows), currentProfile);
    assert.equal(get(result, 'low_rating_sales_performance').score, null);
    assert.equal(get(result, 'natural_visibility_development').score, null);
    assert.equal(result.diagnostics.newcomers.unresolved_possible_examples[0].selection_blocking, true);
  }
});

test('ties among complete scores keep canonical identity without choosing easier or higher natural evidence', () => {
  const result = scoreCandidate(candidate([member('c', 5, 100, 0.7), member('b', 5, 100, 0.35), member('a', 5, 100, null)]), currentProfile);
  assert.equal(get(result, 'low_rating_sales_performance').score, 4);
  assert.deepEqual(result.diagnostics.newcomers.selected_pair.map(row => row.family_id), ['a', 'b']);
  assert.equal(get(result, 'natural_visibility_development').score, null);
  assert.deepEqual(get(result, 'natural_visibility_development').conditional_range, [0.25, 0.75]);
});

test('one verified newcomer uses the independent all-age market, not its own one-unit median', () => {
  const result = scoreCandidate(candidate(), profile);
  assert.equal(get(result, 'low_rating_sales_performance').score, 0.06);
  assert.equal(get(result, 'natural_visibility_development').score, 0.5);
  assert.equal(result.diagnostics.newcomers.references.sales_median, 100);
  assert.equal(result.diagnostics.newcomers.selected_pair.length, 1);
});

test('unknown possible exemplars are not dropped to manufacture a pair or an observed absence', () => {
  const unresolved = { ...member('unknown', null, 200), status: 'pending', reason: 'Launch and ratings still being checked.' };
  for (const members of [[member('known', 5, 100), unresolved], [unresolved], [member('incomplete', null, 20)]]) {
    const result = scoreCandidate(candidate(members), profile);
    assert.equal(get(result, 'low_rating_sales_performance').score, null);
    assert.equal(get(result, 'natural_visibility_development').score, null);
    assert.deepEqual(result.diagnostics.newcomers.selected_pair, []);
  }
  const complete = scoreCandidate(candidate([]), profile);
  assert.equal(get(complete, 'low_rating_sales_performance').score, 0);
  assert.equal(get(complete, 'natural_visibility_development').score, 0);
  const observedAbsence = candidate([]);
  delete observedAbsence.newcomer_cohort.market_reference;
  assert.equal(get(scoreCandidate(observedAbsence, profile), 'low_rating_sales_performance').score, 0);
  const unfinished = candidate([]);
  unfinished.newcomer_cohort.query_complete = false;
  assert.equal(get(scoreCandidate(unfinished, profile), 'low_rating_sales_performance').score, null);
});

test('current-list examples require the declared node, rank and three-calendar-month launch', () => {
  for (const patch of [{ current_bsr_rank: 101 }, { current_bsr_node: 'other' }, { launch_date: '2026-07-01' }, { launch_date: null }]) {
    const result = scoreCandidate(candidate([{ ...member('new', 5, 100), ...patch }]), profile);
    assert.equal(get(result, 'low_rating_sales_performance').score, null, JSON.stringify(patch));
  }
  const oldReview = { ...member('new', 5, 100), old_reviews_predate_launch: true };
  assert.equal(get(scoreCandidate(candidate([oldReview]), profile), 'low_rating_sales_performance').score, 0);
});

test('best capped low-rating examples stay fixed even when another listing has higher sales or usable traffic', () => {
  const rows = [member('a', 100, 120), member('b', 80, 100), member('c', 5, 80, null)];
  const result = scoreCandidate(candidate(rows), profile);
  assert.equal(get(result, 'low_rating_sales_performance').score, 2.5);
  assert.deepEqual(result.diagnostics.newcomers.selected_pair.map(row => row.family_id), ['c', 'b']);
  assert.equal(get(result, 'natural_visibility_development').score, null);
  assert.deepEqual(get(result, 'natural_visibility_development').conditional_range, [0.25, 0.75]);
});

test('real zero sales stay zero while missing or zero-median positive sales stay unresolved', () => {
  const zero = candidate([member('a', 0, 0)]);
  zero.newcomer_cohort.market_reference.families.forEach(row => { row.units_30d.value = 0; });
  assert.equal(get(scoreCandidate(zero, profile), 'low_rating_sales_performance').score, 0);
  zero.newcomer_cohort.members[0].units_30d.value = 1;
  assert.equal(get(scoreCandidate(zero, profile), 'low_rating_sales_performance').score, null);
  const missing = candidate();
  missing.newcomer_cohort.market_reference.families[0].units_30d.value = null;
  assert.equal(get(scoreCandidate(missing, profile), 'low_rating_sales_performance').score, null);
});

test('the four-point rating curve is continuous and a weak pending example cannot displace stronger evidence', () => {
  for (const [ratings, score] of [[0, 4], [10, 4], [25, 3], [40, 2], [80, 1]]) {
    assert.equal(get(scoreCandidate(candidate([member('a', ratings, 100)]), profile), 'low_rating_sales_performance').score, score);
  }
  const weak = { ...member('weak', 100, 1), status: 'pending' };
  const result = scoreCandidate(candidate([member('a', 5, 100), member('b', 20, 100), weak]), profile);
  assert.ok(get(result, 'low_rating_sales_performance').score > 3);
  assert.equal(result.diagnostics.newcomers.unresolved_possible_examples.length, 1);
});

test('unverified duplicate claims cannot become zero support, and weak missing launch evidence uses its bounded priority', () => {
  const duplicate = candidate([{ status: 'duplicate', reason: 'Unverified upstream label.' }]);
  delete duplicate.newcomer_cohort.market_reference;
  const unsupported = scoreCandidate(duplicate, profile);
  assert.equal(get(unsupported, 'low_rating_sales_performance').score, null);
  assert.equal(unsupported.diagnostics.newcomers.reference_mode, 'current_category_r51');
  const weak = { ...member('weak', 100, 1), launch_date: null };
  const result = scoreCandidate(candidate([member('a', 5, 100), member('b', 5, 100), weak]), profile);
  assert.equal(get(result, 'low_rating_sales_performance').score, 4);
  assert.equal(result.diagnostics.newcomers.unresolved_possible_examples.length, 1);
  const invalid = candidate([member('a', 5, 100)]);
  invalid.newcomer_cohort.reference_supported = false;
  assert.equal(scoreCandidate(invalid, profile).diagnostics.newcomers.reference_mode, 'current_category_r51');
});
