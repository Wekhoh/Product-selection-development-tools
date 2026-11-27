import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreBatch, resolveScenarioComparabilityLinkage } from '../src/scoring.mjs';
import { applyPeerComparabilityRulings } from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { makeStage4OrganizerTrayCandidate } from './helpers/stage4-fixtures.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);
const syntheticFixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'),
);

const SPEC_SHA_V1 = '1'.repeat(64);
const SPEC_SHA_V2 = '2'.repeat(64);

function attachSyntheticAiReview(cand, { specSha256 = SPEC_SHA_V1, lowDisposition = 'excluded', highDisposition = 'pending' } = {}) {
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
  // 0. Undisputed baseline (control)
  const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { specSha256: SPEC_SHA_V1, specVersion: 1 });
  const baseScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [baseCand] }, r59Profile);
  const baseCard = baseScored.candidates[0];
  assert.equal(baseCard.qualification.counts_toward_target, true);
  assert.equal(baseScored.summary.qualifying, 1);
  const baseLowMargin = baseCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray').margin.value;
  const baseHighMargin = baseCard.diagnostics.economics.scenarios.find(s => s.id === 'sc-high-parts-unknown').margin.value;
  assert.ok(baseHighMargin > baseLowMargin + 0.05);

  // 1. AI independent review ONLY (no formal ruling) -> deterministic scoreBatch stays 100% byte-identical;
  //    linkage helper + HTML report show advisory dispute/pending badges beside the exact affected scenarios.
  const aiOnlyCand = attachSyntheticAiReview(structuredClone(baseCand));
  const aiOnlyBatch = { schema_version: 1, profile_revision: 59, candidates: [aiOnlyCand] };
  const aiOnlyScored = scoreBatch(aiOnlyBatch, r59Profile);
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

  // 2. Formal ruling requires explicit source & reason
  assert.throws(
    () => applyPeerComparabilityRulings(structuredClone(aiOnlyCand), [{ peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', reason: '无托盘' }]),
    /source/i,
  );

  // 3. Formal ruling confirms low-price excluded + high-price pending -> preserves raw scenarios/quotes/review, revokes confirmed pricing, flips counts_toward_target to false
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
  const bothRuledScored = scoreBatch(bothRuledBatch, r59Profile);
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

  // 4. Re-pricing after supplying matching-spec evidence for high-price peer ($48) -> low stays archived excluded, margin recomputes strictly from $48, card re-qualifies!
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
  const repricedScored = scoreBatch(repricedBatch, r59Profile);
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
  // Confirmed hero/overview selling price must NOT list excluded $38 as the confirmed price range!
  assert.doesNotMatch(repricedHtml, /美站参照价<\/dt><dd>US\$\s*38/);

  // 5. Stale old-spec opinions & old-spec rulings NEVER overwrite a new spec (spec_version: 2 / SPEC_SHA_V2)
  const v2Cand = structuredClone(bothRuledCand);
  v2Cand.spec_version = 2;
  v2Cand.spec_sha256 = SPEC_SHA_V2;
  const v2Scored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [v2Cand] }, r59Profile);
  const v2Card = v2Scored.candidates[0];
  assert.equal(v2Card.qualification.counts_toward_target, true, 'Old v1 rulings/AI review must NOT overwrite v2 spec');
  assert.deepEqual(v2Card.diagnostics.economics.margin_range, baseCard.diagnostics.economics.margin_range);
  assert.equal(v2Card.diagnostics.economics.scenarios[0].comparability_linkage.status, 'undisputed');
  assert.equal(v2Card.diagnostics.economics.scenarios[0].comparability_linkage.stale_ignored_count >= 1, true);
});

test('Issue #8 (4C): handles seasonal operating_periods re-pricing, all-excluded fallback, raw sourceless ruling rejection, and PII scrubbing in HTML', () => {
  // A. Raw sourceless ruling injected directly into candidate JSON is ignored (cannot bypass source requirement)
  const rawBypassCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { specSha256: SPEC_SHA_V1, specVersion: 1 });
  rawBypassCand.peer_comparability_rulings = [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', reason: '试图无来源排除', spec_sha256: SPEC_SHA_V1, spec_version: 1 },
  ];
  const rawBypassScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [rawBypassCand] }, r59Profile);
  const rawBypassSc = rawBypassScored.candidates[0].diagnostics.economics.scenarios.find(s => s.id === 'sc-low-no-tray');
  assert.equal(rawBypassSc.comparability_linkage.status, 'undisputed');
  assert.equal(rawBypassSc.comparability_linkage.invalid_ruling_ignored_count, 1);
  assert.equal(rawBypassSc.excluded_from_active_pricing, undefined);

  // B. All scenarios formally excluded -> margin_range null, reference_price pending, counts_toward_target false, PII/path scrubbed in HTML
  const allExclCand = applyPeerComparabilityRulings(
    makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { specSha256: SPEC_SHA_V1, specVersion: 1 }),
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
  const allExclScored = scoreBatch(allExclBatch, r59Profile);
  const allExclCard = allExclScored.candidates[0];
  assert.equal(allExclCard.qualification.counts_toward_target, false);
  assert.equal(allExclCard.diagnostics.economics.margin_range, null);
  assert.equal(allExclCard.screening.conditions.find(c => c.id === 'reference_price').status, 'pending');
  const allExclHtml = renderReport(allExclScored, allExclBatch);
  assert.doesNotMatch(allExclHtml, /owner-secret|buyer@example\.com/i, 'Ruling reasons must redact local paths and emails in rendered HTML');
  assert.match(allExclHtml, /美站参照价<\/dt><dd>待补证<\/dd>/);

  // C. Seasonal operating_periods candidate (off-peak + companion Q4 peak): excluding low peer + confirming high peer preserves companion peak validity & re-qualifies cleanly
  const flatBase = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { specSha256: SPEC_SHA_V1, specVersion: 1 });
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

  const seasonalPending = applyPeerComparabilityRulings(flatBase, [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_check', reason: '无托盘排除' },
    { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_check', reason: '待核托盘清单' },
  ]);
  const sPendScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [seasonalPending] }, r59Profile);
  assert.equal(sPendScored.candidates[0].qualification.counts_toward_target, false);

  const seasonalConfirmed = applyPeerComparabilityRulings(seasonalPending, [
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_comparable', source: 'owner_check', reason: '已确认含托盘' },
  ]);
  const sConfBatch = { schema_version: 1, profile_revision: 59, candidates: [seasonalConfirmed] };
  const sConfScored = scoreBatch(sConfBatch, r59Profile);
  assert.equal(sConfScored.candidates[0].qualification.counts_toward_target, true);
  assert.equal(sConfScored.candidates[0].qualification.mode, 'seasonal_eligible');
  const sConfOffPeak = sConfScored.candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(sConfOffPeak.diagnostics.economics.margin_range[0], sConfOffPeak.diagnostics.economics.margin_range[1]);
  const sConfHtml = renderReport(sConfScored, sConfBatch);
  assert.match(sConfHtml, /证据已排除/);
});

test('Issue #8 (4C) Astra audit regressions: unified anchors, AND/subject_id/period matching, append-only rulings, mixed pending hero, PII/path scrubbing, and refused AI guard', () => {
  const mkCand = () => makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { specSha256: SPEC_SHA_V1, specVersion: 1 });

  // 1. P1-S1: Excluding all scenarios by scenario_id clears reference_price; excluding common ref blocks anchorless $48; evidenced $28 fails (<$29.99)
  const exclById = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', status: 'confirmed_excluded', source: 'owner', reason: '排除低价情景' },
    { scenario_id: 'sc-high-parts-unknown', status: 'confirmed_excluded', source: 'owner', reason: '排除高价情景' },
  ]);
  const exclByIdScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [exclById] }, r59Profile);
  assert.equal(exclByIdScored.candidates[0].screening.conditions.find(c => c.id === 'reference_price').status, 'pending');
  assert.match(renderReport(exclByIdScored, { schema_version: 1, profile_revision: 59, candidates: [exclById] }), /美站参照价<\/dt><dd>待补证<\/dd>/);

  const anchorlessHigh = mkCand();
  delete anchorlessHigh.economics.scenarios[1].price_anchor;
  const anchorlessRuled = applyPeerComparabilityRulings(anchorlessHigh, [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '公共锚点已排除' },
  ]);
  const anchorlessScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [anchorlessRuled] }, r59Profile);
  assert.equal(anchorlessScored.candidates[0].qualification.counts_toward_target, false);
  assert.equal(anchorlessScored.candidates[0].diagnostics.economics.margin_range, null);

  const belowFloorCand = mkCand();
  belowFloorCand.economics.scenarios[1].price_anchor.value = 28.00;
  belowFloorCand.economics.scenarios[1].cost_ledger.price_usd = 28.00;
  const belowFloorRuled = applyPeerComparabilityRulings(belowFloorCand, [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '仅剩低价实证' },
  ]);
  const belowFloorScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [belowFloorRuled] }, r59Profile);
  assert.equal(belowFloorScored.candidates[0].screening.conditions.find(c => c.id === 'reference_price').status, 'fail');

  // 2. P1-S2 + P2-2: Scenario carrying both ASIN and subject_id matches subject_id; AND semantics prevent cross-ASIN mis-exclusion; refused AI stays silent
  const dualIdCand = mkCand();
  dualIdCand.economics.scenarios[0].subject_id = 'peer-drawer-custom';
  dualIdCand.evidence_review = {
    status: 'ready', execution_status: 'completed', content_status: 'usable',
    candidate_id: dualIdCand.id, form_spec_sha256: SPEC_SHA_V1,
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

  // 3. P1-S3 + P1-S4 + P1-E5: Preserved excluded row passes expected_primary_scenarios cancelled; mixed pending_evidence hides hero margin & scrubs email/D:\ path
  const mixedCand = mkCand();
  mixedCand.economics.expected_primary_scenarios = [
    { id: 'sc-low-no-tray', status: 'cancelled', reason: '缺托盘有据撤销', evidence: [mixedCand.evidence[0].id] },
    { id: 'sc-high-parts-unknown', status: 'active' },
  ];
  const cancelRes = scoreBatch({
    schema_version: 1, profile_revision: 59,
    candidates: [applyPeerComparabilityRulings(mixedCand, [{ peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '确认排除' }])],
  }, r59Profile);
  assert.equal(cancelRes.candidates[0].qualification.counts_toward_target, true);

  const piiPending = applyPeerComparabilityRulings(mkCand(), [
    { peer_asin: 'B0SYN8LOW1', status: 'pending_evidence', source: 'D:\\private\\audit.txt', reason: '联系 leak@example.com 核实托盘' },
  ]);
  const piiPendingBatch = { schema_version: 1, profile_revision: 59, candidates: [piiPending] };
  const piiPendingScored = scoreBatch(piiPendingBatch, r59Profile);
  assert.equal(piiPendingScored.candidates[0].diagnostics.economics.margin_range, null);
  const piiHtml = renderReport(piiPendingScored, piiPendingBatch);
  assert.doesNotMatch(piiHtml, /leak@example\.com|D:\\private\\audit\.txt/i);
  assert.match(piiHtml, /hero-stat-val[^>]*>待补证<\/p>/);

  // 4. P1-E2 + P1-E3: Append-only rulings let newest win without erasing history; stale_spec & ruled_by-only bypasses blocked
  const multiHist = mkCand();
  multiHist.peer_comparability_rulings = [
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_excluded', source: 's1', reason: '初判排除', spec_sha256: SPEC_SHA_V1, spec_version: 1 },
    { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 's2', reason: '转待补证', spec_sha256: SPEC_SHA_V1, spec_version: 1 },
  ];
  const resolvedHist = applyPeerComparabilityRulings(multiHist, [
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_comparable', source: 's3', reason: '补齐清单确认可比' },
  ]);
  assert.equal(resolvedHist.peer_comparability_rulings.length, 3, 'Append-only keeps all 3 rulings');
  const histScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [resolvedHist] }, r59Profile);
  assert.equal(histScored.candidates[0].qualification.counts_toward_target, true);

  const stalePreserved = applyPeerComparabilityRulings(mkCand(), [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner', reason: '过期标记不可丢失', stale_spec: true },
  ]);
  assert.equal(stalePreserved.peer_comparability_rulings[0].stale_spec, true);
  assert.equal(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [stalePreserved] }, r59Profile).candidates[0].qualification.counts_toward_target, true);

  const ruledByOnly = mkCand();
  ruledByOnly.peer_comparability_rulings = [
    { peer_asin: 'B0SYN8LOW1', status: 'pending_evidence', ruled_by: 'owner', reason: '缺显式 source', spec_sha256: SPEC_SHA_V1, spec_version: 1 },
  ];
  assert.equal(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [ruledByOnly] }, r59Profile).candidates[0].qualification.counts_toward_target, true);
});
