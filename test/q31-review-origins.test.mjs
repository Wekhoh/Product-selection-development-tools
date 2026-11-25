import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractNewcomerReviewOriginBreakdown as breakdown } from '../src/observations.mjs';
import { ingestTrialSpecification } from '../src/raw-ingest.mjs';
import { renderReport } from '../src/report.mjs';
import { scoreBatch } from '../src/scoring.mjs';

const partialSample = [
  { title: 'Fits cleanly', content: 'Arrived intact and matches listing.', verified_purchase: true },
  { title: 'Example A', content: 'Written review without origin flags.' },
  { title: 'Example B', content: 'Second written review without origin flags.' },
];

test('partial written sample discloses sample size, omits unproven zeros, and labels missing flags as 来源字段缺失', () => {
  const result = breakdown({ reviews_list: partialSample });
  assert.deepEqual(result.sample, { size: 3, vine_count: 0, vp_count: 1, direct_count: 0, unknown_count: 2 });
  assert.equal(result.vine_count, null);
  assert.equal(result.vp_count, 1);
  assert.equal(result.direct_count, null);
  assert.equal(result.display_zh, '抽查 3 篇文字评：VP 1 · 来源字段缺失 2');
});

test('complete written samples classify native SellerSprite reviews[] (vine + purchased), data.reviews[], reviews_raw, and symmetric vp:false with explicit zeros while keeping totalStoredReviewCount separate', () => {
  const nativeBundle = {
    asin: 'B0SYNRVW01',
    totalStoredReviewCount: 84,
    returnedReviewCount: 4,
    reviews: [
      { title: 'T1', content: 'Body 1', vine: true, purchased: false },
      { title: 'T2', content: 'Body 2', vine: false, purchased: true },
      { title: 'T3', content: 'Body 3', vine: false, purchased: true },
      { title: 'T4', content: 'Body 4', vine: false, purchased: false },
    ],
  };
  const nativeRes = breakdown(nativeBundle);
  assert.deepEqual(nativeRes.sample, { size: 4, vine_count: 1, vp_count: 2, direct_count: 1, unknown_count: 0 });
  assert.equal(nativeRes.vine_count, 1);
  assert.equal(nativeRes.vp_count, 2);
  assert.equal(nativeRes.direct_count, 1);
  assert.equal(nativeRes.display_zh, '抽查 4 篇文字评：Vine 1 · VP 2 · 直评 1');

  // Unwrapped data.reviews[] with explicit zero categories
  const dataWrapped = breakdown({
    code: 'OK',
    data: {
      totalStoredReviewCount: 42,
      reviews: [
        { title: 'Only VP 1', content: 'Sturdy unit.', vine: false, purchased: true },
        { title: 'Only VP 2', content: 'Good finish.', vine: false, purchased: true },
      ],
    },
  });
  assert.deepEqual(dataWrapped.sample, { size: 2, vine_count: 0, vp_count: 2, direct_count: 0, unknown_count: 0 });
  assert.equal(dataWrapped.vine_count, 0);
  assert.equal(dataWrapped.direct_count, 0);
  assert.equal(dataWrapped.display_zh, '抽查 2 篇文字评：Vine 0 · VP 2 · 直评 0');

  // Symmetric vp:false and vine precedence over verified_purchase
  const symmetric = breakdown({
    reviews_raw: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          reviews: [
            { title: 'Vine item', content: 'Reviewed via Vine.', is_vine: true, verified_purchase: true },
            { title: 'Direct item', content: 'Unverified review.', vp: false },
          ],
        }),
      }],
    },
  });
  assert.deepEqual(symmetric.sample, { size: 2, vine_count: 1, vp_count: 0, direct_count: 1, unknown_count: 0 });
  assert.equal(symmetric.vp_count, 0);
  assert.equal(symmetric.display_zh, '抽查 2 篇文字评：Vine 1 · VP 0 · 直评 1');
});

test('written-review-only filter excludes star-only and empty-text rows, keeps vine:false-only rows unknown, and never resurrects stale cached breakdowns when a raw array is supplied', () => {
  const mixed = breakdown({
    review_origin_breakdown: { display_zh: 'STALE CACHE SHOULD NOT APPEAR' },
    reviews: [
      { star: 5, purchased: true, vine: false }, // star-only (no text) -> excluded
      { star: 4, title: '   ', content: '', purchased: true, vine: false }, // empty text -> excluded
      { star: 5, title: 'Star only flagged', star_only: true, purchased: true, vine: false }, // explicit star_only -> excluded
      { star: 5, title: 'Only title text', content: '', vine: false, purchased: true }, // written (title) -> VP
      { star: 4, title: '', content: 'Only body text', vine: false, purchased: false }, // written (content) -> 直评
      { star: 3, title: 'Missing purchased flag', content: 'Has vine:false only.', vine: false }, // unknown
    ],
  });
  assert.deepEqual(mixed.sample, { size: 3, vine_count: 0, vp_count: 1, direct_count: 1, unknown_count: 1 });
  assert.equal(mixed.vine_count, null);
  assert.equal(mixed.vp_count, 1);
  assert.equal(mixed.direct_count, 1);
  assert.equal(mixed.display_zh, '抽查 3 篇文字评：VP 1 · 直评 1 · 来源字段缺失 1');

  // Raw review array with zero written reviews MUST return null and never resurrect stale cache
  assert.equal(breakdown({
    reviews_list: [null, 'unreadable', [], { star: 5, purchased: true, vine: false }],
    review_origin_breakdown: { display_zh: 'Vine 0 · VP 1 · 直评 0' },
  }), null);
  assert.equal(breakdown({
    reviews: [],
    review_origin_breakdown: { display_zh: 'Vine 0 · VP 1 · 直评 0' },
  }), null);

  // Wholly unknown written sample
  const unknown = breakdown({ reviews_list: [{ title: 'No origin supplied', content: 'Text without flags.' }] });
  assert.equal(unknown.vp_count, null);
  assert.equal(unknown.display_zh, '抽查 1 篇文字评：来源字段缺失 1');
});

test('independent totals and shares keep their scope alongside a sample or standalone', () => {
  const result = breakdown({ vine_count: 0, vp_share: 0.75, reviews_list: partialSample });
  assert.equal(result.vine_count, 0);
  assert.equal(result.vp_share, 0.75);
  assert.equal(result.display_zh, '来源汇总 Vine 0 · VP 75%。抽查 3 篇文字评：VP 1 · 来源字段缺失 2');
  assert.equal(breakdown({ vine_count: 0, vp_share: 0.75 }).display_zh, 'Vine 0 · VP 75%');
});

test('raw-ingest wires member.reviews_raw and entry.q31_review_sources[asin], clears stale caches, and r59 report keeps listing rating count separate from written review sample', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));
  const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));

  // 1. Direct report path: summary-only preserved; raw reviews rebuild cleanly & keep total ratings separate
  const batch = { schema_version: 1, profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
  const member = batch.candidates[0].newcomer_cohort.members[0];
  member.review_origin_breakdown = { display_zh: 'Vine 0 · VP 1 · 直评 0' };
  function renderCardHtml() {
    return renderReport(scoreBatch(batch, profile), batch);
  }
  function displayedOrigin(html) {
    return html.match(/代表新品评论构成：([^<]*)</u)?.[1] ?? null;
  }
  assert.equal(displayedOrigin(renderCardHtml()), member.review_origin_breakdown.display_zh);

  member.reviews_list = partialSample;
  const partialHtml = renderCardHtml();
  assert.equal(displayedOrigin(partialHtml), '抽查 3 篇文字评：VP 1 · 来源字段缺失 2');
  assert.match(partialHtml, /评价数\s*\d+/u, 'Listing total rating count remains displayed separately');

  // Raw array with only star-only rows clears stale display in report
  member.reviews_list = [{ star: 5, purchased: true, vine: false }];
  assert.equal(displayedOrigin(renderCardHtml()), null);

  // Summary-only legacy card with numeric fields but no display_zh still renders verifiable summary
  delete member.reviews_list;
  member.review_origin_breakdown = { vp_count: 7 };
  assert.equal(displayedOrigin(renderCardHtml()), 'VP 7');

  // 2. raw-ingest path: entry.q31_review_sources[asin] and member.reviews_raw
  const candForIngest = structuredClone(fixture.candidates[0]);
  const m0 = candForIngest.newcomer_cohort.members[0];
  const m1 = candForIngest.newcomer_cohort.members[1];
  m0.review_origin_breakdown = { display_zh: 'STALE_M0' };
  m0.vine_count = 6;
  m0.vp_share = 0.75;
  m0.data = { reviews: [{ title: 'Old stale row', content: 'Must be cleared.', vine: false, purchased: true }] };
  m1.review_origin_breakdown = { display_zh: 'STALE_M1' };
  m1.reviews_raw = {
    asin: m1.asin,
    totalStoredReviewCount: 50,
    reviews: [
      { author: 'Synthetic Private Author', title: 'Good', content: 'Synthetic raw body should not leak.', vine: false, purchased: true },
      { author: 'Second Synthetic Author', title: 'Direct', content: 'No VP badge.', vine: false, purchased: false },
    ],
  };

  const ingested = ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    evidence: fixture.evidence,
    candidates: [{
      candidate: candForIngest,
      q31_review_sources: {
        [m0.asin]: {
          asin: m0.asin,
          totalStoredReviewCount: 75,
          reviews: [
            { title: 'Vine 1', content: 'Early review.', vine: true, purchased: false },
            { title: 'VP 1', content: 'Verified buy.', vine: false, purchased: true },
            { title: 'Missing vine flag', content: 'Has purchased:false without vine flag.', purchased: false },
            { star: 5, vine: false, purchased: true }, // star-only excluded
          ],
        },
        [m1.asin]: null, // null mapping must NOT wipe member.reviews_raw
      },
    }],
  }, profile);

  const outMembers = ingested.batch.candidates[0].newcomer_cohort.members;
  assert.equal(outMembers[0].review_origin_breakdown.display_zh, '来源汇总 Vine 6 · VP 75%。抽查 3 篇文字评：Vine 1 · VP 1 · 来源字段缺失 1');
  assert.equal(outMembers[0].review_origin_breakdown.sample.size, 3);
  assert.equal(outMembers[1].review_origin_breakdown.display_zh, '抽查 2 篇文字评：Vine 0 · VP 1 · 直评 1');
  assert.equal(outMembers[1].review_origin_breakdown.sample.size, 2);

  // Raw reviewer authors/bodies are stripped from ingested batch & scored result.json
  const scoredIngested = scoreBatch(ingested.batch, profile);
  const scoredJson = JSON.stringify(scoredIngested);
  assert.equal(scoredJson.includes('Synthetic Private Author'), false);
  assert.equal(scoredJson.includes('Synthetic raw body should not leak.'), false);

  // Render ingested batch through real report pipeline: BOTH summary+sample and standalone sample survive into HTML
  const ingestedHtml = renderReport(scoredIngested, ingested.batch);
  assert.match(ingestedHtml, /代表新品评论构成：来源汇总 Vine 6 · VP 75%。抽查 3 篇文字评：Vine 1 · VP 1 · 来源字段缺失 1/u);
  assert.match(ingestedHtml, /代表新品评论构成：抽查 2 篇文字评：Vine 0 · VP 1 · 直评 1/u);

  // Empty replacement q31_review_sources[asin] clears stale member.data.reviews & summary-only q31_review_sources supersedes old reviews_list
  const candReplace = structuredClone(fixture.candidates[0]);
  const r0 = candReplace.newcomer_cohort.members[0];
  const r1 = candReplace.newcomer_cohort.members[1];
  r0.data = { reviews: [{ title: 'Old VP', content: 'Stale row.', vine: false, purchased: true }] };
  r0.review_origin_breakdown = { display_zh: 'STALE' };
  r1.reviews_list = [{ title: 'Old list VP', content: 'Should be superseded by summary-only source.', vine: false, purchased: true }];
  const replaced = ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    evidence: fixture.evidence,
    candidates: [{
      candidate: candReplace,
      q31_review_sources: {
        [r0.asin]: { asin: r0.asin, reviews: [] },
        [r1.asin]: { vp_count: 0 },
      },
    }],
  }, profile);
  assert.equal(replaced.batch.candidates[0].newcomer_cohort.members[0].review_origin_breakdown, undefined);
  assert.equal(replaced.batch.candidates[0].newcomer_cohort.members[1].review_origin_breakdown.display_zh, 'VP 0');
  const replacedHtml = renderReport(scoreBatch(replaced.batch, profile), replaced.batch);
  assert.equal(replacedHtml.includes('Old VP'), false);
  assert.match(replacedHtml, /代表新品评论构成：VP 0/u);

  // member.reviews_raw takes precedence over stale member.data.reviews and cleans it so HTML matches ingest
  const candDataClean = structuredClone(fixture.candidates[0]);
  const d0 = candDataClean.newcomer_cohort.members[0];
  d0.data = { reviews: [{ title: 'Stale data VP', content: 'Old data row.', vine: false, purchased: true }] };
  d0.reviews_raw = { asin: d0.asin, reviews: [{ title: 'Fresh Vine', content: 'New review.', vine: true, purchased: false }] };
  const cleanedIngest = ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    evidence: fixture.evidence,
    candidates: [{ candidate: candDataClean, q31_review_sources: { [d0.asin]: null } }],
  }, profile);
  const cleanedHtml = renderReport(scoreBatch(cleanedIngest.batch, profile), cleanedIngest.batch);
  assert.match(cleanedHtml, /代表新品评论构成：抽查 1 篇文字评：Vine 1 · VP 0 · 直评 0/u);

  // Wrong-ASIN review source bundle (including inline member.data) is rejected at ingest boundary
  const candWrongAsin = structuredClone(fixture.candidates[0]);
  const wrongMember = candWrongAsin.newcomer_cohort.members[0];
  assert.throws(() => ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    evidence: fixture.evidence,
    candidates: [{
      candidate: candWrongAsin,
      q31_review_sources: {
        [wrongMember.asin]: {
          asin: 'B0SYNWRONG',
          reviews: [{ title: 'Wrong item', content: 'Belongs to another ASIN.', vine: true, purchased: false }],
        },
      },
    }],
  }, profile), /does not match newcomer member ASIN/);
  const candWrongInline = structuredClone(fixture.candidates[0]);
  candWrongInline.newcomer_cohort.members[0].data = {
    asin: 'B0SYNWRONG',
    reviews: [{ title: 'Wrong inline', content: 'Belongs to another ASIN.', vine: true, purchased: false }],
  };
  assert.throws(() => ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    evidence: fixture.evidence,
    candidates: [{ candidate: candWrongInline }],
  }, profile), /does not match newcomer member ASIN/);
});

test('missing vine flag on purchased:false, non-vine origin text, and failed MCP envelopes are handled accurately', () => {
  // SellerSprite purchased:false without explicit vine:false cannot distinguish Vine from 直评 -> 来源字段缺失
  const missingVine = breakdown({
    reviews: [
      { title: 'Ambiguous', content: 'No vine flag.', purchased: false },
      { title: 'Non-vine VP', content: 'Explicitly not Vine.', vine: false, purchased: true, origin: 'non-vine' },
    ],
  });
  assert.deepEqual(missingVine.sample, { size: 2, vine_count: 0, vp_count: 1, direct_count: 0, unknown_count: 1 });
  assert.equal(missingVine.display_zh, '抽查 2 篇文字评：VP 1 · 来源字段缺失 1');

  // Failed MCP envelopes (RATE_LIMIT / NO_DATA / isError) never fabricate counts from partial payloads or summary fields
  assert.equal(breakdown({
    code: 'RATE_LIMIT',
    vp_count: 7,
    reviews: [{ title: 'Should ignore', content: 'Error envelope row.', vine: false, purchased: true }],
  }), null);
  assert.equal(breakdown({
    dataStatus: 'NO_DATA',
    reviews: [{ title: 'Should ignore', content: 'No data row.', vine: false, purchased: true }],
  }), null);

  // External bundle carrying BOTH summary totals and raw reviews preserves both scopes
  const combinedExt = breakdown({
    reviews_raw: {
      vine_count: 6,
      vp_share: 0.75,
      reviews: [{ title: 'VP row', content: 'Verified buy.', vine: false, purchased: true }],
    },
  });
  assert.equal(combinedExt.display_zh, '来源汇总 Vine 6 · VP 75%。抽查 1 篇文字评：Vine 0 · VP 1 · 直评 0');
});
