import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  categoryReturnObservation,
  observedDailyUnits,
  sanitizeNewcomerMemberReviews,
} from '../src/observations.mjs';
import { ingestTrialSpecification } from '../src/raw-ingest.mjs';
import { renderReport } from '../src/report.mjs';
import { scoreBatch } from '../src/scoring.mjs';

test('category and selected-market return rates retain distinct fields and percent units', () => {
  const result = categoryReturnObservation({ avgReturnRatio: 4.5, returnRatio: 7 });
  assert.equal(result.value, 0.045);
  assert.equal(result.selected_market_value, 0.07);
  assert.equal(categoryReturnObservation({ returnRatio: 7 }).value, null);
  assert.equal(categoryReturnObservation({ avgReturnRatio: 0 }).value, 0);
});

test('negative daily sentinel is missing, never a negative sale or zero-filled day', () => {
  const result = observedDailyUnits([{ date: '2026-01-01', units: 5 },
    { date: '2026-01-02', units: -1 }, { date: '2026-01-03', units: null },
    { date: '2026-01-04', units: 0 }]);
  assert.equal(result.observed_units, 5);
  assert.equal(result.observed_days, 2);
  assert.equal(result.missing_days, 2);
  assert.equal(result.complete_window_units, null);
});

test('daily adapter rejects duplicate dates and does not claim calendar coverage from supplied rows', () => {
  assert.throws(() => observedDailyUnits([{ date: '2026-01-01', units: 1 }, { date: '2026-01-01', units: 2 }]), /Unique/);
  assert.throws(() => observedDailyUnits([{ date: '2026-02-31', units: 1 }]), /Unique/);
  const result = observedDailyUnits([{ date: '2026-01-01', units: 2 }]);
  assert.equal(result.complete_declared_rows, true);
  assert.equal(result.complete_window_units, null);
});

test('sanitizeNewcomerMemberReviews strips top-level raw fields and derives breakdown without mutating input', () => {
  const member = {
    asin: 'B0SYNSAN01',
    reviews_raw: {
      reviews: [
        { author: 'Alice Reviewer', title: 'Great', content: 'Works well.', vine: true, purchased: false },
      ],
    },
    reviews_list: [{ author: 'Bob', content: 'Stale list', vine: false, purchased: true }],
    reviews: [{ author: 'Carol', content: 'Stale reviews', vine: false, purchased: false }],
    content: [{ type: 'text', text: 'raw mcp content block' }],
    structuredContent: { reviews: [{ author: 'Dan', content: 'Raw structured' }] },
  };
  const snapshot = structuredClone(member);

  const sanitized = sanitizeNewcomerMemberReviews(member);
  assert.notEqual(sanitized, member);
  assert.deepEqual(member, snapshot);
  assert.equal('reviews_raw' in sanitized, false);
  assert.equal('reviews_list' in sanitized, false);
  assert.equal('reviews' in sanitized, false);
  assert.equal('content' in sanitized, false);
  assert.equal('structuredContent' in sanitized, false);
  assert.equal(sanitized.review_origin_breakdown.display_zh, '抽查 1 篇文字评：Vine 1 · VP 0 · 直评 0');
});

test('sanitizeNewcomerMemberReviews strips nested member.data, member.data.data, and member.data.structuredContent without mutating input', () => {
  const withDataReviews = {
    asin: 'B0SYNSAN02',
    data: {
      reviews: [
        { author: 'Nested Author 1', title: 'OK', content: 'Solid build.', vine: false, purchased: true },
      ],
    },
  };
  const sanitizedDirectData = sanitizeNewcomerMemberReviews(withDataReviews);
  assert.equal('data' in sanitizedDirectData, false);
  assert.equal(Array.isArray(withDataReviews.data.reviews), true);
  assert.equal(sanitizedDirectData.review_origin_breakdown.display_zh, '抽查 1 篇文字评：Vine 0 · VP 1 · 直评 0');

  const withDoubleDataReviews = {
    asin: 'B0SYNSAN03',
    data: {
      data: {
        reviews: [
          { author: 'Deep Author', title: 'Direct', content: 'Unverified note.', vine: false, purchased: false },
        ],
      },
    },
  };
  const sanitizedDoubleData = sanitizeNewcomerMemberReviews(withDoubleDataReviews);
  assert.equal('data' in sanitizedDoubleData, false);
  assert.equal(Array.isArray(withDoubleDataReviews.data.data.reviews), true);
  assert.equal(sanitizedDoubleData.review_origin_breakdown.display_zh, '抽查 1 篇文字评：Vine 0 · VP 0 · 直评 1');

  const withDataStructured = {
    asin: 'B0SYNSAN04',
    data: {
      structuredContent: {
        reviews: [{ author: 'SC Author', title: 'Vine SC', content: 'Structured body.', vine: true, purchased: false }],
      },
    },
  };
  const sanitizedStructured = sanitizeNewcomerMemberReviews(withDataStructured);
  assert.equal('data' in sanitizedStructured, false);
  assert.equal(Array.isArray(withDataStructured.data.structuredContent.reviews), true);
  assert.equal(sanitizedStructured.review_origin_breakdown.display_zh, '抽查 1 篇文字评：Vine 1 · VP 0 · 直评 0');

  const withArrayData = { asin: 'B0SYNSAN05', data: [{ author: 'Arr Author', content: 'Array data.' }] };
  const sanitizedArrayData = sanitizeNewcomerMemberReviews(withArrayData);
  assert.equal('data' in sanitizedArrayData, false);
  assert.equal(Array.isArray(withArrayData.data), true);
});

test('sanitizeNewcomerMemberReviews preserves scalar diagnostics and handles boundary inputs cleanly', () => {
  const scalarMember = {
    asin: 'B0SYNSAN06',
    reviews: 84,
    content: 'plain note',
    reviews_raw: null,
    data: { reviews: 12, content: 'plain data note' },
  };
  const untouched = sanitizeNewcomerMemberReviews(scalarMember);
  assert.equal(untouched, scalarMember);
  assert.equal(untouched.reviews, 84);
  assert.equal(untouched.content, 'plain note');
  assert.deepEqual(untouched.data, { reviews: 12, content: 'plain data note' });

  // Top-level raw payload with scalar member.data preserves scalar member.data
  const mixedMember = {
    asin: 'B0SYNSAN07',
    reviews_raw: { vp_count: 3 },
    data: { content: 'plain data note' },
  };
  const sanitizedMixed = sanitizeNewcomerMemberReviews(mixedMember);
  assert.equal('reviews_raw' in sanitizedMixed, false);
  assert.deepEqual(sanitizedMixed.data, { content: 'plain data note' });
  assert.equal(sanitizedMixed.review_origin_breakdown.display_zh, 'VP 3');

  // Failed upstream payload clears stale cached breakdown while stripping raw payload
  const failedWithStaleCache = {
    asin: 'B0SYNSAN08',
    review_origin_breakdown: { display_zh: 'STALE CACHED' },
    reviews_raw: { isError: true, reviews: [{ author: 'Err Author', content: 'Err body', vine: true }] },
  };
  const sanitizedFailed = sanitizeNewcomerMemberReviews(failedWithStaleCache);
  assert.equal('reviews_raw' in sanitizedFailed, false);
  assert.equal('review_origin_breakdown' in sanitizedFailed, false);

  // Non-object / array boundaries: non-objects return unchanged; array member returns [] without leaking raw rows
  assert.equal(sanitizeNewcomerMemberReviews(null), null);
  assert.equal(sanitizeNewcomerMemberReviews(undefined), undefined);
  assert.equal(sanitizeNewcomerMemberReviews('raw'), 'raw');
  const arr = [{ author: 'Array Leak', content: 'Should not survive', vine: true }];
  const arrSnapshot = structuredClone(arr);
  assert.deepEqual(sanitizeNewcomerMemberReviews(arr), []);
  assert.deepEqual(arr, arrSnapshot);
});

test('sanitizeNewcomerMemberReviews preserves sibling diagnostics inside mixed member.data without mutating input', () => {
  const mixed = {
    asin: 'B0MIXED01',
    data: {
      asin: 'B0MIXED01',
      totalStoredReviewCount: 84,
      note: 'keep me',
      content: 'scalar note',
      reviews: [{ author: 'Mixed Author', title: 'Vine', content: 'Mixed raw body.', vine: true, purchased: false }],
    },
  };
  const snapshot = structuredClone(mixed);
  const sanitized = sanitizeNewcomerMemberReviews(mixed);
  assert.deepEqual(mixed, snapshot);
  assert.deepEqual(sanitized.data, {
    asin: 'B0MIXED01',
    totalStoredReviewCount: 84,
    note: 'keep me',
    content: 'scalar note',
  });
  assert.equal(sanitized.review_origin_breakdown.display_zh, '抽查 1 篇文字评：Vine 1 · VP 0 · 直评 0');
});

test('sanitizeNewcomerMemberReviews strips depth-3 and depth-4 member.data chains in direct scoreBatch and q31_review_sources replacement -> renderReport', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));
  const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));

  for (const depth of [3, 4]) {
    const buildDeepData = leaf => (depth === 3
      ? { data: { data: leaf } }
      : { data: { data: { data: leaf } } });

    // 1. Direct scoreBatch strips depth-3/4 raw author & body without mutating input
    const directBatch = { schema_version: 1, profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
    const dm = directBatch.candidates[0].newcomer_cohort.members[0];
    dm.data = buildDeepData({
      reviews: [{ author: `Deep${depth}LeakAuthor`, title: 'Old', content: `Deep${depth}LeakBody`, vine: false, purchased: true }],
    });
    const dmSnapshot = structuredClone(dm);
    const scoredDirect = scoreBatch(directBatch, profile);
    const directJson = JSON.stringify(scoredDirect);
    assert.equal(directJson.includes(`Deep${depth}LeakAuthor`), false);
    assert.equal(directJson.includes(`Deep${depth}LeakBody`), false);
    assert.deepEqual(dm, dmSnapshot);
    assert.equal(
      scoredDirect.candidates[0].diagnostics.newcomers.members[0].review_origin_breakdown.display_zh,
      '抽查 1 篇文字评：Vine 0 · VP 1 · 直评 0',
    );

    // 2. ingestTrialSpecification + q31_review_sources replacement -> renderReport shows new Vine breakdown, not stale VP
    const candIngest = structuredClone(fixture.candidates[0]);
    const m0 = candIngest.newcomer_cohort.members[0];
    m0.data = buildDeepData({
      reviews: [{ author: `Stale${depth}Author`, title: 'Old', content: `Stale${depth}Body`, vine: false, purchased: true }],
    });
    const ingested = ingestTrialSpecification({
      profile_revision: 59,
      allow_synthetic_without_receipts: true,
      evidence: fixture.evidence,
      candidates: [{
        candidate: candIngest,
        q31_review_sources: {
          [m0.asin]: {
            asin: m0.asin,
            reviews: [{ author: 'NewVineAuthor', title: 'Vine', content: 'Fresh vine body.', vine: true, purchased: false }],
          },
        },
      }],
    }, profile);
    const ingestedJson = JSON.stringify(ingested.batch);
    assert.equal(ingestedJson.includes(`Stale${depth}Author`), false);
    assert.equal(ingestedJson.includes(`Stale${depth}Body`), false);
    assert.equal(ingestedJson.includes('NewVineAuthor'), false);
    assert.equal(ingestedJson.includes('Fresh vine body.'), false);

    const scoredIngested = scoreBatch(ingested.batch, profile);
    const scoredJson = JSON.stringify(scoredIngested);
    assert.equal(scoredJson.includes(`Stale${depth}Author`), false);
    assert.equal(scoredJson.includes(`Stale${depth}Body`), false);

    const html = renderReport(scoredIngested, ingested.batch);
    const renderedOrigins = [...html.matchAll(/代表新品评论构成：([^<]*)</gu)].map(m => m[1]);
    assert.equal(renderedOrigins[0], '抽查 1 篇文字评：Vine 1 · VP 0 · 直评 0');
    assert.equal(html.includes('Vine 0 · VP 1 · 直评 0'), false);
  }
});
