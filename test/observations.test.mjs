import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryReturnObservation,
  observedDailyUnits,
  sanitizeNewcomerMemberReviews,
} from '../src/observations.mjs';

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

  // Non-object / array boundaries return input unchanged
  assert.equal(sanitizeNewcomerMemberReviews(null), null);
  assert.equal(sanitizeNewcomerMemberReviews(undefined), undefined);
  assert.equal(sanitizeNewcomerMemberReviews('raw'), 'raw');
  const arr = [{ reviews: [] }];
  assert.equal(sanitizeNewcomerMemberReviews(arr), arr);
});
