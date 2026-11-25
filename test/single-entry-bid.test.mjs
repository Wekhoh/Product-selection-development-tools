import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
const evidence = [{ id: 'synthetic-entry', source: 'Synthetic researched main-entry evidence', observed_at: '2026-11-17' }];
const reading = (value, unit, more = {}) => ({ value, unit, evidence: ['synthetic-entry'], ...more });
const candidate = () => ({
  id: 'synthetic-single-entry', form: 'Synthetic tool form', evidence,
  bids: {
    marketplace: 'US', currency: 'USD', match_type: 'exact',
    selection_reason: 'Synthetic research supports exactly one genuine main purchase entry, with no unresolved additional entry.',
    evidence: ['synthetic-entry'],
    entries: [{ query: 'synthetic tool block',
      sif: reading(1, 'USD', { match_type: 'exact', strategy: 'fixed', low: 0.59, high: 1.33 }) }],
  },
});
const bidItem = (input, rule = profile) => scoreCandidate(input, rule).items.find(row => row.id === 'relevant_purchase_entry_bid');

test('one researched main entry uses its native exact point without inventing monthly volume', () => {
  const input = candidate();
  const result = scoreCandidate(input, profile);
  const bid = result.items.find(row => row.id === 'relevant_purchase_entry_bid');
  assert.equal(bid.score, 12);
  assert.equal(bid.reference_bid_usd, 1);
  assert.equal(bid.aggregation_method, 'single_main_entry');
  assert.equal(bid.entries[0].volume, null);
  assert.equal(bid.entries[0].source_label, 'sif_only');
  assert.deepEqual(bid.range_scenarios.sif.bid_range_usd, [0.59, 1.33]);
  assert.equal(bid.range_scenarios.sellersprite, null);
  const html = renderReport({ profile_revision: 59, candidates: [result] },
    { schema_version: 1, profile_revision: 59, candidates: [input] });
  assert.match(html, /单个主购买词直接参考/);
  assert.match(html, /本项不需要月搜索量，缺失时保留未知/);
});

test('single-entry scoring preserves source averaging and does not substitute ranges or incompatible points', () => {
  const input = candidate();
  input.bids.entries[0].sellersprite = reading(3, 'USD', { match_type: 'exact', strategy: 'unspecified' });
  assert.equal(bidItem(input).reference_bid_usd, 2);
  assert.equal(bidItem(input).score, 6);
  input.bids.entries[0].sellersprite.match_type = 'phrase';
  assert.equal(bidItem(input).score, 12);
  input.bids.entries[0].sif.value = null;
  assert.equal(bidItem(input).score, null);
  input.bids.entries[0].sif.value = 1;
  input.bids.evidence = [];
  assert.equal(bidItem(input).score, null);
});

test('multiple genuine entries still need every monthly weight and retain their weighted result', () => {
  const input = candidate();
  input.bids.volume_period = '2026-10';
  input.bids.entries[0].volume = reading(100, 'searches_per_month', { period: '2026-10' });
  input.bids.entries[0].sellersprite = reading(3, 'USD', { match_type: 'exact', strategy: 'unspecified' });
  input.bids.entries.push({ query: 'synthetic block for machining',
    volume: reading(300, 'searches_per_month', { period: '2026-10' }),
    sif: reading(1, 'USD', { match_type: 'exact', strategy: 'fixed' }) });
  assert.equal(bidItem(input).reference_bid_usd, 1.25);
  assert.equal(bidItem(input).score, 10.5);
  assert.equal(bidItem(input).aggregation_method, 'monthly_search_weighted');
  const missingOneVol = structuredClone(input);
  missingOneVol.bids.entries[1].volume.value = null;
  assert.equal(bidItem(missingOneVol).aggregation_method, 'equal_main_entries');
  assert.equal(bidItem(missingOneVol).score, 9);
  for (const change of [
    x => { x.bids.entries[1].sif.value = null; },
    x => { x.bids.entries[1].volume.period = '2026-09'; },
    x => { delete x.bids.volume_period; },
    x => { x.bids.entries[1].query = ' Synthetic   TOOL block '; },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    assert.equal(bidItem(changed).score, null);
  }
});

test('retired revisions < 59 are rejected at profile validation boundary', () => {
  for (const rev of [50, 54, 58]) {
    const retired = structuredClone(profile);
    retired.revision = retired.workflow.scoring_and_ordering.revision = rev;
    assert.throws(() => scoreCandidate(candidate(), retired), TypeError);
  }
});
