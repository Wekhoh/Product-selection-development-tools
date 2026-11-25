import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreCandidate } from '../src/scoring.mjs';
import { runCli } from '../src/cli.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
const reading = (value, unit, extra = {}) => ({ value, unit, evidence: ['synthetic-entry'], ...extra });
const exact = (value, extra = {}) => reading(value, 'USD', { match_type: 'exact', strategy: 'fixed', ...extra });
const candidate = () => ({
  id: 'synthetic-equal-entry', form: 'Synthetic tool form',
  evidence: [{ id: 'synthetic-entry', source: 'Synthetic main-entry research', observed_at: '2026-11-17' }],
  bids: {
    marketplace: 'US', currency: 'USD', match_type: 'exact', evidence: ['synthetic-entry'],
    selection_reason: 'Synthetic research supports both main purchase entries for the same form.',
    entries: [
      { query: 'synthetic tool block', sellersprite: exact(1), sif: exact(3) },
      { query: 'synthetic machining block', sif: exact(1) },
    ],
  },
});
const bidItem = (input, rule = profile) => scoreCandidate(input, rule).items.find(row => row.id === 'relevant_purchase_entry_bid');

test('complete exact quotes with missing monthly volumes use equal entry means after source fusion', () => {
  const bid = bidItem(candidate());
  // The first entry is $2 after source fusion; the second is $1. Their equal mean is $1.50.
  assert.equal(bid.reference_bid_usd, 1.5);
  assert.equal(bid.score, 9);
  assert.equal(bid.aggregation_method, 'equal_main_entries');
  assert.deepEqual(bid.entries.map(row => row.volume), [null, null]);
  assert.deepEqual(bid.entries.map(row => row.source_label), ['two_source_mean', 'sif_only']);
});

test('partial monthly coverage uses every entry equally, while complete weights retain their original result', () => {
  const input = candidate();
  input.bids.volume_period = '2026-10';
  input.bids.entries[1].volume = reading(300, 'searches_per_month', { period: '2026-10' });
  assert.equal(bidItem(input).score, 9);
  assert.equal(bidItem(input).aggregation_method, 'equal_main_entries');
  input.bids.entries[0].volume = reading(100, 'searches_per_month', { period: '2026-10' });
  assert.equal(bidItem(input).reference_bid_usd, 1.25);
  assert.equal(bidItem(input).score, 10.5);
  assert.equal(bidItem(input).aggregation_method, 'monthly_search_weighted');
});

test('missing main-entry exact points cannot use the remaining subset or range endpoints', () => {
  for (const change of [
    entry => { entry.sif.value = null; },
    entry => { entry.sif.match_type = 'phrase'; },
    entry => { entry.sif.strategy = 'dynamic'; },
    entry => { entry.sif.evidence = []; },
    entry => { entry.sif.material_conflict = true; },
  ]) {
    const input = candidate();
    input.bids.entries[1].sif.low = 0.5;
    input.bids.entries[1].sif.high = 2;
    change(input.bids.entries[1]);
    const result = scoreCandidate(input, profile);
    const bid = result.items.find(row => row.id === 'relevant_purchase_entry_bid');
    assert.equal(bid.score, null);
    assert.equal(bid.reference_bid_usd, null);
    assert.equal(bid.aggregation_method, null);
    assert.match(bid.reason, /native exact point/);
    assert.equal(result.total_range, null);
  }
});

test('invalid or conflicting supplied volumes and duplicate queries are not missing-volume exceptions', () => {
  for (const volume of [
    100, '100', [100],
    reading(-1, 'searches_per_month'), reading('100', 'searches_per_month'),
    reading(100, 'searches_per_week'), reading(100, 'searches_per_month', { period: '2026-09' }),
    reading(100, 'searches_per_month', { evidence: [] }),
    reading(null, 'searches_per_month', { material_conflict: true }),
    reading(100, 'searches_per_month', { supported: false }),
  ]) {
    const input = candidate();
    input.bids.volume_period = '2026-10';
    input.bids.entries[0].volume = volume;
    assert.equal(bidItem(input).score, null);
  }
  const input = candidate();
  input.bids.entries[1].query = ' SYNTHETIC   TOOL BLOCK ';
  assert.equal(bidItem(input).score, null);
  assert.equal(bidItem(input).aggregation_method, null);
  assert.equal(bidItem(input).aggregation_reason, undefined);
  input.bids.entries[1].query = ' ';
  assert.equal(bidItem(input).aggregation_method, null);
  input.bids.entries[1].query = 'synthetic machining block';
  input.bids.entries.forEach(entry => { entry.volume = reading(0, 'searches_per_month'); });
  input.bids.volume_period = '2026-10';
  assert.equal(bidItem(input).score, null);
});

test('equal-entry scoring preserves source-labeled bounds and rejects retired revisions < 59', () => {
  const input = candidate();
  input.bids.entries[0].sellersprite = reading(1, 'USD', { match_type: 'exact', strategy: 'unspecified', low: 0.7, high: 1.4 });
  input.bids.entries[0].sif = exact(3, { low: 2.1, high: 3.8 });
  const item = bidItem(input);
  assert.deepEqual(item.entries[0].sources.sellersprite.range, [0.7, 1.4]);
  assert.deepEqual(item.entries[0].sources.sif.range, [2.1, 3.8]);
  for (const rev of [50, 55, 58]) {
    const retired = structuredClone(profile);
    retired.revision = retired.workflow.scoring_and_ordering.revision = rev;
    assert.throws(() => scoreCandidate(candidate(), retired), TypeError);
  }
});

test('the CLI and Chinese card disclose equal weighting and preserve unknown monthly volumes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'selection-equal-bid-'));
  try {
    writeFileSync(join(directory, 'batch.json'), JSON.stringify({ schema_version: 1, profile_revision: 59, candidates: [candidate()] }));
    writeFileSync(join(directory, 'profile.json'), JSON.stringify(profile));
    const output = join(directory, 'report');
    let stderr = '';
    assert.equal(await runCli(['--input', join(directory, 'batch.json'), '--profile', join(directory, 'profile.json'), '--output', output],
      { stdout: { write() {} }, stderr: { write(value) { stderr += value; } } }), 0, stderr);
    const result = JSON.parse(readFileSync(join(output, 'result.json'), 'utf8'));
    assert.equal(result.candidates[0].items.find(row => row.id === 'relevant_purchase_entry_bid').score, 9);
    const html = readFileSync(join(output, 'index.html'), 'utf8');
    assert.match(html, /等权/);
    assert.doesNotMatch(html, /再按同周期月搜索量加权/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
