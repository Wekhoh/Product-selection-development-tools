import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreBatch, resolveScenarioComparabilityLinkage } from '../src/scoring.mjs';
import { applyPeerComparabilityRulings, runPhase2Batch } from '../src/pipeline.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { estimateGate1A2027 } from '../src/fba-calculator.mjs';
import { freezeEvidenceReviewPacket } from '../src/openai/evidence-review.mjs';
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

  const seasonalPeakOnly = applyPeerComparabilityRulings(structuredClone(flatBase), [
    { peer_asin: 'B0SYN8LOW1', period_id: 'peak_q4', status: 'confirmed_excluded', source: 'owner_check', reason: '仅旺季排除低价' },
  ]);
  const sPeakOnlyOff = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [seasonalPeakOnly] }, r59Profile)
    .candidates[0].operating_periods.find(p => p.id === 'off_peak');
  assert.equal(sPeakOnlyOff.screening.conditions.find(c => c.id === 'reference_price').reanchored_from_excluded_ref, undefined, 'peak_q4-scoped ruling must not leak into off_peak');

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
  assert.match(piiHtml, /单件净留存<\/span>\s*<strong[^>]*>待补证<\/strong>/);
  assert.match(piiHtml, /美站参照价<\/dt><dd>待补证<\/dd>/);
  assert.equal(piiHtml.includes('<div class="alloc-strip"'), false);

  // 3b. Period-scoped ruling isolation (peak_q4 must not leak into off_peak or flat), partial scenario_id re-anchoring, and standalone advisory review without root spec_sha256
  const flatPeriodLeak = applyPeerComparabilityRulings(mkCand(), [
    { peer_asin: 'B0SYN8LOW1', period_id: 'peak_q4', status: 'confirmed_excluded', source: 'owner', reason: '仅旺季排除' },
  ]);
  assert.equal(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [flatPeriodLeak] }, r59Profile).candidates[0].diagnostics.economics.scenarios[0].excluded_from_active_pricing, undefined);

  const partialScenExcl = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', status: 'confirmed_excluded', source: 'owner', reason: '按情景排除低价' },
  ]);
  const partialScenRef = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [partialScenExcl] }, r59Profile)
    .candidates[0].screening.conditions.find(c => c.id === 'reference_price');
  assert.deepEqual(partialScenRef.effective_price_range, [48, 48]);
  assert.equal(partialScenRef.reanchored_from_excluded_ref, true);

  const partialScenPend = applyPeerComparabilityRulings(mkCand(), [
    { scenario_id: 'sc-low-no-tray', status: 'confirmed_excluded', source: 'owner', reason: '排除低价' },
    { scenario_id: 'sc-high-parts-unknown', status: 'pending_evidence', source: 'owner', reason: '高价待补证' },
  ]);
  assert.equal(
    scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [partialScenPend] }, r59Profile)
      .candidates[0].screening.conditions.find(c => c.id === 'reference_price').status,
    'pending',
  );

  const noRootShaCand = attachSyntheticAiReview(mkCand());
  delete noRootShaCand.spec_sha256;
  delete noRootShaCand.spec_version;
  assert.equal(resolveScenarioComparabilityLinkage(noRootShaCand.economics.scenarios[0], noRootShaCand)?.status, 'ai_dispute_pending_ruling');

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

test('Issue #8 (4C) SQLite E2E: runPhase2Batch binds DB spec_sha256 pre-score (enforces v1 ruling, blocks stale v1 ruling on v2) and matches export-report --verify-html with Gate-4 dispute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue8-sqlite-e2e-'));
  const dbPath = join(dir, 'selection.sqlite');
  const receiptDir = join(dir, 'receipts');
  mkdirSync(receiptDir, { recursive: true });
  let store = openSelectionStore(dbPath);
  try {
    const formV1 = {
      form_id: 'form-issue8-e2e',
      label: '桌面收纳盒＋可拆托盘',
      buyer_task: 'Desktop organizer with removable tray',
      saleable_set_composition: { components: [{ component_id: 'kit', qty_per_saleable_set: 1 }], set_count: 1 },
    };
    const { form: f1 } = store.upsertCandidateForm(formV1);
    const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
      id: 'form-issue8-e2e',
      specSha256: f1.spec_sha256,
      specVersion: f1.spec_version,
    });
    const sc0 = baseCand.economics.scenarios[0];
    const fx = 7.0;
    const procUsd = sc0.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd;
    const domUsd = sc0.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd;
    const hhUsd = sc0.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd;
    const unitGoodsCny = Math.round(procUsd * fx * 10000) / 10000;
    const totalDomCny = Math.round(domUsd * fx * 100 * 100) / 100;
    const salesWin = { from: '2027-02-01', through: '2027-10-14' };
    const storageWin = { from: '2027-02-01', through: '2027-09-30' };
    const inboundWin = { from: '2027-01-20', through: '2027-02-01' };
    const g1aScens = baseCand.economics.scenarios.map(sc => ({
      id: sc.id,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
      price_usd: sc.cost_ledger.price_usd,
      fx_cny_per_usd: fx, refund_fraction: 0.02, physical_return_fraction: 0.02,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
      headhaul_usd: hhUsd, collection_rate: 0.006,
      sales_window: salesWin, storage_window: storageWin, inbound_window: inboundWin,
      is_apparel: false, is_dangerous_goods: false, is_sipp: false,
    }));
    const rawEst = estimateGate1A2027(g1aScens[0]);
    const cachedEst = {
      fulfillment_usd: rawEst.components.fulfillment.total_usd,
      placement_usd: rawEst.components.placement.selected_usd,
      storage_usd: rawEst.components.storage.per_unit_usd,
    };
    const alignCand = (cand, qid) => {
      for (const s of cand.economics.scenarios) {
        s.quote_id = qid;
        s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
        s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: qid, fx_cny_per_usd: fx };
        for (const l of s.cost_ledger.lines) {
          if (l.id === 'procurement' || l.id === 'domestic_freight') { l.fx_cny_per_usd = fx; l.order_units = 100; }
          if (l.id === 'fulfillment') l.amount_usd = cachedEst.fulfillment_usd;
          if (l.id === 'placement') l.amount_usd = cachedEst.placement_usd;
          if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, cachedEst.storage_usd);
        }
        const r = s.cost_ledger.refund_fraction ?? 0.04;
        const nonCol = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
          .reduce((sum, lid) => sum + (s.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
        const colLine = s.cost_ledger.lines.find(l => l.id === 'collection');
        if (colLine) colLine.amount_usd = Number((Math.max(0, s.cost_ledger.price_usd * (1 - r) - nonCol) * (s.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
      }
      return cand;
    };
    const buildItem = (formDef, cand, qid, reviewPacket = null) => ({
      form: formDef,
      leads: [{ lead_id: 'lead-i8-1', source_channel: 'reddit', source_ref: 'https://example.com/r/i8', phrase_or_title: 'organizer tray', observed_at: '2026-11-20', disposition: 'product' }],
      gate1a_scenarios: g1aScens,
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: {
          quote_id: qid, factory_id: 'factory-syn-1', observed_at: '2026-11-20', expires_at: null,
          redacted_destination: '广东深圳', raw_readback_ref: `rb-${qid}`,
          ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
          goods_first_order_promotion: false, freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'syn-offer-1', sku_id: 'kit', component_id: 'kit', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: unitGoodsCny, regular_goods_promo_false: true }],
          goods_cny_total: Math.round(unitGoodsCny * 100 * 100) / 100, domestic_freight_cny_total: totalDomCny,
        },
      }),
      early_screen_builder: () => g1aScens.map(g => ({
        profile_revision: 59, id: g.id, saleable_unit: '1 complete set',
        price_usd: g.price_usd, fx_cny_per_usd: fx, order_units: 100,
        goods_cny_per_unit: unitGoodsCny, domestic_freight_cny_per_unit: totalDomCny / 100,
        first_order_promotion: false, goods_first_order_promotion: false,
        headhaul: { usd_per_unit: hhUsd, bond_included: true },
        refund_fraction: 0.02, physical_return_fraction: 0.02, return_threshold: 0.08, returns_processing_usd: 0,
        is_apparel_or_shoes: false, referral_terms: g.referral_terms,
        fulfillment_usd: cachedEst.fulfillment_usd, placement_usd: cachedEst.placement_usd,
        storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWin, storage: storageWin, inbound: inboundWin },
        collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
      })),
      deep_research_executor: async () => ({
        batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(cand)] },
        ...(reviewPacket ? { evidence_review_packet: reviewPacket } : {}),
      }),
    });

    // 1. Input omits spec_sha256, carries valid v1 pending_evidence ruling -> DB pre-score binding applies ruling & revokes qualification
    const candV1Ruled = alignCand(applyPeerComparabilityRulings(baseCand, [
      { peer_asin: 'B0SYN8LOW1', status: 'pending_evidence', source: 'owner_db_check', reason: 'v1 待补证' },
    ]), 'q1688-i8-v1');
    delete candV1Ruled.spec_sha256;
    delete candV1Ruled.spec_version;
    const rV1 = await runPhase2Batch(store, { items: [buildItem(formV1, candV1Ruled, 'q1688-i8-v1')], profile: r59Profile, as_of_date: '2026-11-27' });
    assert.equal(rV1.gate2_3[0].status, 'evaluated');
    assert.equal(rV1.gate2_3[0].qualification.counts_toward_target, false);

    // 2. Bump DB spec to v2; input carries stale v1 SHA + v1 rulings -> DB v2 spec ignores stale rulings & stays qualifying
    const formV2 = { ...formV1, saleable_set_composition: { components: [{ component_id: 'kit', qty_per_saleable_set: 1 }], set_count: 2 } };
    const candV2Stale = alignCand(applyPeerComparabilityRulings(baseCand, [
      { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_v1', reason: 'v1 excluded' },
      { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_v1', reason: 'v1 pending' },
    ]), 'q1688-i8-v2');
    const rV2 = await runPhase2Batch(store, { items: [buildItem(formV2, candV2Stale, 'q1688-i8-v2')], profile: r59Profile, as_of_date: '2026-11-27' });
    assert.equal(rV2.gate2_3[0].status, 'evaluated');
    assert.equal(rV2.gate2_3[0].qualification.counts_toward_target, true);

    // 3. Gate-4 AI dispute in runPhase2Batch reproduces exact result & HTML SHA on export-report --verify-html
    const f2 = store.getCandidateForm('form-issue8-e2e');
    const pktV2 = {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-i8-v2',
      execution_policy_ref: 'local-authorized-policy',
      candidate: { subject_id: 'form-issue8-e2e', intended_use: formV2.buyer_task, saleable_spec: formV2.saleable_set_composition, unknown_fields: [] },
      subjects: [{ subject_id: 'peer-B0SYN8LOW1', spec: { material: 'wood', tray: false } }],
      criteria: { criteria_version: 'r59-peer-v1', rules: [{ criterion_id: 'c1', description: 'Must include tray', required: true }] },
      questions: [{ question_id: 'q1', question: 'Does peer include tray?', subject_ids: ['peer-B0SYN8LOW1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'ev-1', subject_ids: ['peer-B0SYN8LOW1'], summary: 'Catalog shows box only without tray.', kind: 'fact', source_ref: 'local-cat-1', observed_at: '2026-11-20', window: '2026-11-01..2026-11-20', grain: 'child_sku', units: 'sets', limitations: null }],
    };
    const frozenPkt = freezeEvidenceReviewPacket(pktV2);
    const candV2Clean = alignCand(structuredClone(baseCand), 'q1688-i8-v2');
    candV2Clean.spec_sha256 = f2.spec_sha256;
    candV2Clean.spec_version = f2.spec_version;
    const rGate4 = await runPhase2Batch(store, {
      items: [buildItem(formV2, candV2Clean, 'q1688-i8-v2', pktV2)],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      openai_hooks: {
        evidence_review: {
          enabled: true, testMode: true, allowTestDoubleReceipt: true, reasoningEffort: 'max', receiptDir,
          mockExecutor: async ({ outputFilePath }) => {
            writeFileSync(outputFilePath, JSON.stringify({
              schema_version: 'evidence-review-draft-v1',
              review_id: frozenPkt.review_id,
              packet_sha256: frozenPkt.packet_sha256,
              subjects: [{ subject_id: 'peer-B0SYN8LOW1', disposition: 'excluded', criterion_ids: ['c1'], evidence_ids: ['ev-1'], reason: '仅含主盒无托盘' }],
              answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['ev-1'], explanation: '目录无托盘' }],
              contradictions: [], gaps: [], conclusion: '低价对标疑无托盘。',
            }));
            return { exitCode: 0 };
          },
        },
      },
    });
    assert.equal(rGate4.gate2_3[0].evidence_review.status, 'ready');
    assert.equal(rGate4.gate2_3[0].qualification.counts_toward_target, true);
    store.close();
    store = null;

    const bPath = join(dir, 'batch.json');
    const outDir = join(dir, 'report');
    writeFileSync(bPath, JSON.stringify({ schema_version: 1, profile_revision: 59, candidates: [candV2Clean] }, null, 2));
    let stderr = '';
    const exitCode = await runPhase2Cli([
      'export-report', '--db', dbPath, '--batch', bPath, '--profile', 'docs/design/reference-profile.r59.draft.json',
      '--output', outDir, '--verify-result', rGate4.gate2_3[0].batch_result_sha256, '--verify-html', rGate4.gate2_3[0].html_sha256,
    ], { stdout: { write() {} }, stderr: { write(s) { stderr += s; } } }, { codexReceiptDir: receiptDir, allowTestDoubleReceipts: true });
    assert.equal(exitCode, 0, stderr);
    assert.match(readFileSync(join(outDir, 'index.html'), 'utf8'), /复核提出异议/);
  } finally {
    if (store) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
