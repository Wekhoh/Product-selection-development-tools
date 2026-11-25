import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BUSINESS_THRESHOLDS,
  BUSINESS_THRESHOLD_AUDIT_REGISTRY,
} from '../src/business-thresholds.mjs';
import { MAX_MONTHLY_LIMIT_CENTS } from '../src/openai/budget-ledger.mjs';
import {
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_UNPUBLISHED_PEAK_WINDOW,
} from '../src/rates/index.mjs';
import { scoreNumericValue } from '../src/scoring.mjs';
import { validIsoDate } from '../src/utils/dates.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);

test('business-thresholds: every registered cutoff is deep-frozen with verified YYYY-MM-DD confirmation date and provenance', () => {
  assert.equal(Object.isFrozen(BUSINESS_THRESHOLD_AUDIT_REGISTRY), true);
  assert.equal(Object.isFrozen(BUSINESS_THRESHOLDS), true);

  const keys = Object.keys(BUSINESS_THRESHOLD_AUDIT_REGISTRY);
  assert.ok(keys.length >= 30, 'Registry must cover all owner-confirmed business cutoffs');

  for (const key of keys) {
    const entry = BUSINESS_THRESHOLD_AUDIT_REGISTRY[key];
    assert.equal(Object.isFrozen(entry), true, `Registry entry "${key}" must be frozen`);
    assert.equal(
      validIsoDate(entry.confirmed_at),
      true,
      `Registry entry "${key}" requires a valid YYYY-MM-DD confirmed_at date (fix in src/business-thresholds.mjs after owner confirmation).`,
    );
    assert.equal(
      typeof entry.provenance === 'string' && entry.provenance.trim().length >= 12,
      true,
      `Registry entry "${key}" requires explicit provenance citing owner decision / official source.`,
    );
    assert.equal(
      typeof entry.unit === 'string' && entry.unit.trim().length > 0,
      true,
      `Registry entry "${key}" requires an explicit unit.`,
    );
    assert.deepEqual(BUSINESS_THRESHOLDS[key], entry.value);
  }
});

test('business-thresholds: locked 4 hard kill lines, 21-item 100-pt rubric, 15-pt USD CPC anchors, 2027 windows, and ultrafast Codex default match active runtime', () => {
  // 4 hard kill lines
  assert.equal(BUSINESS_THRESHOLDS.minimum_reference_price_usd, 29.99);
  assert.equal(BUSINESS_THRESHOLDS.pre_ad_margin_floor, 0.30);
  assert.equal(BUSINESS_THRESHOLDS.children_statutory_max_age_years, 12);
  assert.equal(BUSINESS_THRESHOLDS.allow_strong_date_dependency, false);

  // Profile alignment (21 items, 100 points, 85 core + 15 post-sample, CPC anchors)
  const items = r59Profile.group_budgets.flatMap(g => g.items);
  assert.equal(items.length, BUSINESS_THRESHOLDS.scoring_item_count);
  assert.equal(r59Profile.total_budget, BUSINESS_THRESHOLDS.scoring_total_weight);
  assert.equal(
    BUSINESS_THRESHOLDS.scoring_objective_core_weight + BUSINESS_THRESHOLDS.scoring_remaining_post_sample_weight,
    BUSINESS_THRESHOLDS.scoring_total_weight,
  );
  assert.equal(r59Profile.reference_screening.comparable_reference_price.minimum_inclusive, BUSINESS_THRESHOLDS.minimum_reference_price_usd);
  assert.equal(r59Profile.reference_screening.margin.minimum, BUSINESS_THRESHOLDS.pre_ad_margin_floor);

  const bidItem = items.find(i => i.id === 'relevant_purchase_entry_bid');
  assert.equal(bidItem.weight, 15);
  assert.equal(bidItem.mapping.full_score_at_or_below, BUSINESS_THRESHOLDS.cpc_absolute_usd_anchors[0].max_bid_usd);
  assert.equal(
    bidItem.mapping.zero_score_at_or_above,
    BUSINESS_THRESHOLDS.cpc_absolute_usd_anchors[BUSINESS_THRESHOLDS.cpc_absolute_usd_anchors.length - 1].min_bid_usd,
  );
  assert.deepEqual(BUSINESS_THRESHOLDS.cpc_absolute_usd_anchors, [
    { max_bid_usd: 0.50, points: 15 },
    { bid_usd: 1.00, points: 12 },
    { bid_usd: 1.50, points: 9 },
    { bid_usd: 2.00, points: 6 },
    { bid_usd: 2.50, points: 3 },
    { min_bid_usd: 3.00, points: 0 },
  ]);
  for (const anchor of BUSINESS_THRESHOLDS.cpc_absolute_usd_anchors) {
    const bidVal = anchor.max_bid_usd ?? anchor.bid_usd ?? anchor.min_bid_usd;
    assert.ok(
      Math.abs(scoreNumericValue('relevant_purchase_entry_bid', bidVal, r59Profile) - anchor.points) < 1e-9,
      `CPC anchor $${bidVal} must score ${anchor.points} pts via scoreNumericValue`,
    );
  }
  // Also verify intermediate points $0.80 -> 13.2 pts and $2.50 -> 3.0 pts
  assert.ok(Math.abs(scoreNumericValue('relevant_purchase_entry_bid', 0.80, r59Profile) - 13.2) < 1e-9);
  assert.ok(Math.abs(scoreNumericValue('relevant_purchase_entry_bid', 2.50, r59Profile) - 3.0) < 1e-9);

  // Runtime wiring parity
  assert.equal(MAX_MONTHLY_LIMIT_CENTS, BUSINESS_THRESHOLDS.openai_monthly_limit_cents);
  assert.deepEqual(FBA_2027_DEFAULT_OFF_PEAK_WINDOW, BUSINESS_THRESHOLDS.fba_2027_off_peak_sales_window);
  assert.deepEqual(FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, BUSINESS_THRESHOLDS.fba_2027_off_peak_storage_window);
  assert.deepEqual(FBA_2027_UNPUBLISHED_PEAK_WINDOW, BUSINESS_THRESHOLDS.fba_2027_unpublished_q4_peak_window);
  assert.equal(BUSINESS_THRESHOLDS.codex_default_service_tier, 'ultrafast');
  assert.equal(BUSINESS_THRESHOLDS.codex_default_reasoning_effort, 'max');
});

test('business-thresholds: guard check blocks re-introduction of purged AI-invented cutoffs in src/', () => {
  const priceBandSrc = readFileSync(new URL('../src/price-band.mjs', import.meta.url), 'utf8');
  const wtSrc = readFileSync(new URL('../src/openai/workflow-tasks.mjs', import.meta.url), 'utf8');
  const discSrc = readFileSync(new URL('../src/discovery-channels.mjs', import.meta.url), 'utf8');
  const keepaSrc = readFileSync(new URL('../src/adapters/keepa.mjs', import.meta.url), 'utf8');

  assert.equal(
    /observed_count\s*>=\s*1[45]|latestRun\.count\s*>=\s*1[45]|regularMedianUsd\s*\*\s*0\.92|1\.12/.test(keepaSrc),
    false,
    'Unconfirmed 14/15-point or 8%/12% heuristic cutoffs must never appear in src/adapters/keepa.mjs.',
  );
  assert.equal(
    /\bB0[A-Z0-9]{8}\b/.test(keepaSrc),
    false,
    'Tracked src/adapters/keepa.mjs must never contain literal B0xxxxxxxx ASIN identifiers.',
  );

  assert.equal(
    /spiral_max_age_days\s*=\s*120|mature_peers_ge_120d|max_margin_spread_pp\s*=\s*12/.test(priceBandSrc),
    false,
    'Purged 120d newcomer / 12pp spread cutoffs must never reappear in src/price-band.mjs; use BUSINESS_THRESHOLDS.',
  );
  assert.equal(
    /prohibitedThreshold\s*=\s*0\.5\b/.test(wtSrc),
    false,
    'Luna prohibitedThreshold must use BUSINESS_THRESHOLDS.luna_prohibited_threshold (0.70), never 0.5.',
  );
  assert.equal(
    /single_leaf_concentration/.test(discSrc),
    false,
    'Forced per-batch single_leaf_concentration alerts are retired; keep zero forced category dispersion caps.',
  );
});
