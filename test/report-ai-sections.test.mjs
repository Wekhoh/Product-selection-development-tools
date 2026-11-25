import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeEvidenceReviewPacket } from '../src/openai/evidence-review.mjs';
import { runCodexEvidenceReview } from '../src/openai/codex-runner.mjs';
import { attachCandidateEvidenceReview } from '../src/pipeline.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

const VALID_PNG_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
// Minimal valid JPEG SOI + EOI header bytes (\xff\xd8\xff\xe0 ... \xff\xd9)
const VALID_JPEG_URI = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]).toString('base64')}`;
// Minimal valid RIFF....WEBP header bytes
const VALID_WEBP_URI = `data:image/webp;base64,${Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 \x04\x00\x00\x00\x00\x00\x00\x00', 'latin1').toString('base64')}`;

function makeSeasonalCandidate(baseCandidate, id = 'seasonal-ai-card') {
  const c = structuredClone(baseCandidate);
  c.id = id;
  c.label = '合成季节精算款';
  const off = structuredClone(c.economics.scenarios[0]);
  off.id = off.cost_ledger.id = 'sc-off';
  off.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
  off.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  off.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-01-15' };
  for (const l of off.cost_ledger.lines.filter(x => x.fee_basis)) {
    l.fee_basis.effective_from = '2027-01-15';
    l.fee_basis.effective_through = l.id === 'fulfillment' ? '2027-10-14' : '2027-12-31';
  }
  const peak = structuredClone(off);
  peak.id = peak.cost_ledger.id = 'sc-peak';
  peak.cost_ledger.fee_context.sales = peak.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
  Object.assign(peak.cost_ledger.lines.find(l => l.id === 'fulfillment'), {
    amount_usd: null,
    status: 'pending',
    fee_basis: { status: 'unavailable', version: 'Unpublished 2027 peak fulfillment' },
  });
  c.economics = {
    saleable_unit: c.economics.saleable_unit,
    operating_periods: [
      { id: 'off_peak', label: '2027年2–9月淡季', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [off] },
      { id: 'peak', label: '2027年10–12月旺季', months: [10, 11, 12], scenarios: [peak] },
    ],
  };
  return c;
}

test('r58 renders Red-Team Audit (evidence_review) across statuses and Concept Plinth (concept_images) with CSS lightboxes and clean heading hierarchy', async () => {
  const tempReceiptDir = mkdtempSync(join(tmpdir(), 'r58-report-rec-'));
  try {
  const batch = structuredClone(fixture);
  const seasonal = makeSeasonalCandidate(batch.candidates[0], 'seasonal-audit-1');
  batch.candidates = [batch.candidates[0], batch.candidates[1], batch.candidates[2], seasonal];

  // Candidate 0: genuinely executed & receipt-verified envelope with subjects, answers, contradictions, gaps, and valid PNG/JPEG/WEBP concept images
  const cand0RawPacket = {
    schema_version: 'evidence-review-draft-v1',
    review_id: 'rev-synth-001',
    execution_policy_ref: 'local-authorized-policy',
    candidate: {
      subject_id: batch.candidates[0].id,
      intended_use: 'Countertop organizer',
      saleable_spec: { material: '304 stainless steel', pieces: 2 },
      unknown_fields: ['liner_grade'],
    },
    subjects: [
      { subject_id: 'sub-peer-1', spec: { pieces: 2 } },
      { subject_id: 'sub-peer-2', spec: { pieces: 2 } },
      { subject_id: 'sub-decoy-3', spec: { pieces: 1 } },
      { subject_id: 'sub-ambig-4', spec: { liner: 'unknown' } },
    ],
    criteria: {
      criteria_version: 'r58-v1',
      rules: [
        { criterion_id: 'crit-spec', description: 'Core dimensions', required: true },
        { criterion_id: 'crit-bundle', description: 'Complete saleable set', required: false },
        { criterion_id: 'crit-mat', description: 'Verified liner grade', required: false },
      ],
    },
    questions: [
      {
        question_id: 'q-liner-grade',
        question: 'Is sub-ambig-4 liner grade verified?',
        subject_ids: ['sub-ambig-4'],
        criterion_ids: ['crit-mat'],
      },
    ],
    evidence: [
      { evidence_id: 'ev-dim-01', subject_ids: ['sub-peer-1'], summary: 'Matched core dimensions.', kind: 'fact', source_ref: 'snap-01', observed_at: '2026-11-20', window: '2026-10-22..2026-11-20', grain: 'sku', units: 'mm', limitations: null },
      { evidence_id: 'ev-dim-02', subject_ids: ['sub-peer-2'], summary: 'Matched bundle count.', kind: 'fact', source_ref: 'snap-02', observed_at: '2026-11-20', window: '2026-10-22..2026-11-20', grain: 'sku', units: 'set', limitations: null },
      { evidence_id: 'ev-acc-03', subject_ids: ['sub-decoy-3'], summary: 'Replacement spare part only.', kind: 'fact', source_ref: 'snap-03', observed_at: '2026-11-20', window: '2026-10-22..2026-11-20', grain: 'sku', units: 'pc', limitations: null },
      { evidence_id: 'ev-cad-04', subject_ids: ['sub-ambig-4'], summary: 'CAD drawing shows 90mm height.', kind: 'fact', source_ref: 'snap-04', observed_at: '2026-11-20', window: '2026-10-22..2026-11-20', grain: 'sku', units: 'mm', limitations: null },
      { evidence_id: 'ev-table-05', subject_ids: ['sub-ambig-4'], summary: 'Attribute table lists 80mm.', kind: 'fact', source_ref: 'snap-05', observed_at: '2026-11-20', window: '2026-10-22..2026-11-20', grain: 'sku', units: 'mm', limitations: null },
    ],
  };
  const cand0Packet = freezeEvidenceReviewPacket(cand0RawPacket);
  const cand0ExecEnv = await runCodexEvidenceReview(cand0RawPacket, {
    enabled: true,
    testMode: true,
    reasoningEffort: 'max',
    receiptDir: tempReceiptDir,
    candidateId: batch.candidates[0].id,
    mockExecutor: async ({ outputFilePath }) => {
      writeFileSync(outputFilePath, `${JSON.stringify({
        schema_version: 'evidence-review-draft-v1',
        review_id: 'rev-synth-001',
        packet_sha256: cand0Packet.packet_sha256,
        subjects: [
          { subject_id: 'sub-peer-1', disposition: 'included', criterion_ids: ['crit-spec'], evidence_ids: ['ev-dim-01'], reason: 'Matched core dimensions.' },
          { subject_id: 'sub-peer-2', disposition: 'included', criterion_ids: ['crit-spec'], evidence_ids: ['ev-dim-02'], reason: 'Matched bundle count.' },
          { subject_id: 'sub-decoy-3', disposition: 'excluded', criterion_ids: ['crit-bundle'], evidence_ids: ['ev-acc-03'], reason: 'Replacement spare part only.' },
          { subject_id: 'sub-ambig-4', disposition: 'pending', criterion_ids: ['crit-mat'], evidence_ids: ['ev-cad-04', 'ev-table-05'], reason: 'Liner material unconfirmed.' },
        ],
        answers: [
          { question_id: 'q-liner-grade', status: 'pending', basis: 'fact', evidence_ids: ['ev-cad-04', 'ev-table-05'], explanation: 'Conflicting dimensions and missing mill certificate.' },
        ],
        contradictions: [
          {
            subject_ids: ['sub-ambig-4'],
            criterion_ids: ['crit-mat'],
            question_ids: ['q-liner-grade'],
            evidence_ids: ['ev-cad-04', 'ev-table-05'],
            disagreement: 'CAD drawing shows 90mm height while attribute table lists 80mm.',
          },
        ],
        gaps: [
          {
            subject_ids: ['sub-ambig-4'],
            criterion_ids: ['crit-mat'],
            question_ids: ['q-liner-grade'],
            evidence_ids: [],
            missing_information: 'Inner liner alloy grade certificate',
            why_it_matters: 'Determines food-contact compliance route and landed unit weight.',
            resolution_evidence: 'Factory mill certificate and physical sample magnet/spark check.',
          },
        ],
        conclusion: 'Two true peers confirmed; hold ambiguous liner peer pending factory spec sheet.',
      })}\n`, 'utf8');
      return { exitCode: 0 };
    },
  });
  attachCandidateEvidenceReview(batch.candidates[0], cand0ExecEnv, cand0Packet, {
    receiptStoreDir: tempReceiptDir,
    allowTestDoubleReceipt: true,
  });
  batch.candidates[0].concept_images = [
    {
      data_uri: VALID_PNG_URI,
      title: '圆角防滑底座微改款 A',
      caption: '底部增设一体硅胶防滑垫圈，消除台面滑移痛点。',
    },
    {
      data_uri: VALID_JPEG_URI,
      title: '可拆卸内胆导流槽方案 B',
      caption: '边缘加深 3mm 导流翻边，便于日常冲洗。',
    },
    {
      data_uri: VALID_WEBP_URI,
      title: '紧凑套盒内衬排布方案 C',
      caption: '缩减外箱体积以避开泡重计费档。',
    },
  ];

  // Candidate 1: pending_recovery status
  batch.candidates[1].evidence_review = {
    status: 'pending_recovery',
    conclusion: 'Original review attempt timed out after dispatch; reservation held pending readback.',
  };

  // Candidate 2: disabled / unavailable status
  batch.candidates[2].evidence_review = {
    status: 'unavailable',
    reason: 'Offline run: independent red-team review was not enabled for this batch.',
  };

  // Seasonal candidate: post-scoring receipt-verified attachment on scored result object also works seamlessly
  const scored = scoreBatch(batch, profile);
  const scoredSeasonal = scored.candidates.find(c => c.candidate_id === 'seasonal-audit-1');
  const seasonalRawPacket = {
    schema_version: 'evidence-review-draft-v1',
    review_id: 'rev-seasonal-002',
    execution_policy_ref: 'local-authorized-policy',
    candidate: {
      subject_id: 'seasonal-audit-1',
      intended_use: 'Foldable seasonal organizer',
      saleable_spec: { lock_pin: 'stainless' },
      unknown_fields: [],
    },
    subjects: [{ subject_id: 'sub-s1', spec: { lock_pin: 'stainless' } }],
    criteria: {
      criteria_version: 'r58-v1',
      rules: [{ criterion_id: 'c1', description: 'Matched lock pin', required: true }],
    },
    questions: [
      { question_id: 'q-s1', question: 'Does sub-s1 match?', subject_ids: ['sub-s1'], criterion_ids: ['c1'] },
    ],
    evidence: [
      { evidence_id: 'e1', subject_ids: ['sub-s1'], summary: 'Matched.', kind: 'fact', source_ref: 'snap-s1', observed_at: '2026-11-20', window: '2026-10-22..2026-11-20', grain: 'sku', units: 'set', limitations: null },
    ],
  };
  const seasonalPacket = freezeEvidenceReviewPacket(seasonalRawPacket);
  const seasonalExecEnv = await runCodexEvidenceReview(seasonalRawPacket, {
    enabled: true,
    testMode: true,
    reasoningEffort: 'xhigh',
    receiptDir: tempReceiptDir,
    candidateId: 'seasonal-audit-1',
    mockExecutor: async ({ outputFilePath }) => {
      writeFileSync(outputFilePath, JSON.stringify({
        schema_version: 'evidence-review-draft-v1',
        review_id: 'rev-seasonal-002',
        packet_sha256: seasonalPacket.packet_sha256,
        subjects: [{ subject_id: 'sub-s1', disposition: 'included', criterion_ids: ['c1'], evidence_ids: ['e1'], reason: 'Matched.' }],
        answers: [{ question_id: 'q-s1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'Confirmed.' }],
        contradictions: [],
        gaps: [],
        conclusion: 'Seasonal off-peak comparison sample is internally consistent.',
      }), 'utf8');
      return { exitCode: 0 };
    },
  });
  attachCandidateEvidenceReview(scoredSeasonal, seasonalExecEnv, seasonalPacket, {
    receiptStoreDir: tempReceiptDir,
    allowTestDoubleReceipt: true,
  });
  scoredSeasonal.concept_images = [
    { data_uri: VALID_PNG_URI, title: '季节款折叠锁扣概念图', caption: '加厚不锈钢定位销示意。' },
  ];

  // Production mode (without allowTestDoubleReceipts) refuses to award 已复核 to synthetic_test_double receipts!
  const prodHtml = renderReport(scored, batch);
  assert.doesNotMatch(prodHtml, /已复核/);

  const html = renderReport(scored, batch, {
    receiptStoreDir: tempReceiptDir,
    allowTestDoubleReceipts: true,
  });

  // CSP & zero-script / zero-em-dash invariants
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; connect-src 'none'/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /—/, 'r58 report must contain zero U+2014 em-dashes');

  // Red-Team Audit statuses, explicit synthetic-double provenance, disposition counts, contradictions, and gaps
  assert.equal((html.match(/data-section="evidence-review"/g) ?? []).length, 4);
  assert.match(html, /独立红队复核 · Red-Team Audit/);
  assert.match(html, /已复核/);
  assert.match(html, /待恢复/);
  assert.match(html, /未启用/);
  assert.match(html, /Synthetic Test Double · max/);
  assert.match(html, /Synthetic Test Double · xhigh/);
  assert.doesNotMatch(html, /GPT-6\.2 Astra · max/, 'synthetic test-double receipts must never claim live GPT-6.2 Astra attribution');
  assert.match(html, /纳入 <span class="mono-id">included<\/span> <strong class="ink-pass">2<\/strong>/);
  assert.match(html, /排除 <span class="mono-id">excluded<\/span> <strong class="ink-fail">1<\/strong>/);
  assert.match(html, /待定 <span class="mono-id">pending<\/span> <strong>1<\/strong>/);
  assert.match(html, /<code class="mono-id rt-conflict-id">ev-cad-04<\/code>/);
  assert.match(html, /<code class="mono-id rt-conflict-id">ev-table-05<\/code>/);
  assert.match(html, /CAD drawing shows 90mm height while attribute table lists 80mm\./);
  assert.match(html, /Inner liner alloy grade certificate/);
  assert.match(html, /Determines food-contact compliance route and landed unit weight\./);
  assert.match(html, /Seasonal off-peak comparison sample is internally consistent\./);

  // Concept Plinth gallery & pure-CSS :target lightboxes
  assert.equal((html.match(/data-section="concept-plinth"/g) ?? []).length, 2);
  assert.match(html, /微创新改款概念 · Concept Plinth/);
  assert.ok(html.includes(`src="${VALID_PNG_URI}"`));
  assert.ok(html.includes(`src="${VALID_JPEG_URI}"`));
  assert.ok(html.includes(`src="${VALID_WEBP_URI}"`));
  assert.match(html, /id="candidate-\d+-concept-1-zoom" class="css-lightbox"/);
  assert.match(html, /id="candidate-\d+-concept-3-zoom" class="css-lightbox"/);
  assert.match(html, /圆角防滑底座微改款 A/);
  assert.match(html, /季节款折叠锁扣概念图/);

  // Heading hierarchy check: zero <h4> inside evidence-review or concept-plinth blocks
  for (const block of html.match(/<section[^>]*data-section="(?:evidence-review|concept-plinth)"[\s\S]*?<\/section>/g) ?? []) {
    assert.doesNotMatch(block, /<h4\b/i, 'repeated items inside AI sections must use <strong> rather than <h4>');
  }
  } finally {
    rmSync(tempReceiptDir, { recursive: true, force: true });
  }
});

test('r58 escapes XSS payloads, redacts local user paths, and rejects non-data or non-raster concept_images URIs', () => {
  const batch = structuredClone(fixture);
  batch.candidates = [structuredClone(batch.candidates[0])];
  const xss = '<script>alert("xss")</script><img src=x onerror="alert(7)">';
  const leakWin = ['C:', 'Users', 'SyntheticProbeOwner', 'Documents', 'secret-packet.json'].join('\\');
  const leakPosix = ['', 'Users', 'SyntheticProbeOwner', 'private', 'mockup.png'].join('/');
  const leakFileUri = ['file://', 'Users', 'SyntheticProbeOwner', 'secret.png'].join('/');

  batch.candidates[0].evidence_review = {
    status: 'ready',
    schema_version: 'evidence-review-draft-v1',
    review_id: 'rev-xss-001',
    packet_sha256: 'c'.repeat(64),
    reviewer: `GPT-6.2 Astra ${xss}`,
    conclusion: `Summary ${xss} from ${leakWin}`,
    subjects: [
      { subject_id: `sub-${xss}`, disposition: 'excluded', evidence_ids: ['ev-1'], reason: xss },
    ],
    contradictions: [
      {
        conflicting_evidence_ids: [`ev-${xss}`, 'ev-clean'],
        disagreement: `Conflict ${xss} in ${leakPosix}`,
      },
    ],
    gaps: [
      {
        missing_information: `Missing ${xss}`,
        why_it_matters: `Impact ${xss} at ${leakWin}`,
      },
    ],
  };

  batch.candidates[0].concept_images = [
    { data_uri: 'https://evil.example.com/remote.png', title: 'Remote HTTPS must drop', caption: xss },
    { data_uri: 'http://127.0.0.1:8080/ssrf.png', title: 'Local HTTP must drop', caption: 'drop' },
    { data_uri: 'javascript:alert(1)', title: 'JS URI must drop', caption: 'drop' },
    { data_uri: leakFileUri, title: 'File URI must drop', caption: 'drop' },
    { data_uri: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', title: 'HTML data URI must drop', caption: 'drop' },
    { data_uri: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+', title: 'SVG data URI must drop', caption: 'drop' },
    { data_uri: 'data:image/png;base64,PHN2Zz48L3N2Zz4=', title: 'Polyglot SVG-as-PNG must drop', caption: 'drop' },
    { data_uri: `${VALID_PNG_URI}" onerror="alert(9)`, title: 'Attribute breakout must drop', caption: 'drop' },
    { data_uri: VALID_PNG_URI, title: `Safe Plinth ${xss} ${leakPosix}`, caption: `Caption ${xss} ${leakWin}` },
  ];

  const scored = scoreBatch(batch, profile);
  const html = renderReport(scored, batch);

  // XSS payloads must be HTML-escaped, never executable
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.doesNotMatch(html, /onerror="alert/i);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));

  // Local OS user paths must be sanitized
  assert.equal(html.includes('SyntheticProbeOwner'), false, 'local username must never leak into HTML');

  // Only the single valid raster data:image/png URI may appear in <img> tags (thumbnail + lightbox = 2 <img> tags)
  const imgTags = html.match(/<img\b[^>]*>/gi) ?? [];
  assert.equal(imgTags.length, 2);
  for (const tag of imgTags) {
    assert.ok(tag.includes(`src="${VALID_PNG_URI}"`), `unexpected img tag: ${tag}`);
  }
  assert.doesNotMatch(html, /evil\.example\.com|127\.0\.0\.1|javascript:|data:text\/html|data:image\/svg\+xml|PHN2Zz48/);
  assert.doesNotMatch(html, /Remote HTTPS must drop|Polyglot SVG-as-PNG must drop/);

  // When ALL concept_images entries are invalid, zero <img> tags and zero concept-plinth sections are emitted
  const allInvalidBatch = structuredClone(batch);
  allInvalidBatch.candidates[0].concept_images = [
    { data_uri: 'https://evil.example.com/remote.png', title: 'Bad 1', caption: 'Bad' },
    { data_uri: 'javascript:alert(1)', title: 'Bad 2', caption: 'Bad' },
  ];
  const allInvalidHtml = renderReport(scoreBatch(allInvalidBatch, profile), allInvalidBatch);
  assert.doesNotMatch(allInvalidHtml, /<img\b/i);
  assert.doesNotMatch(allInvalidHtml, /data-section="concept-plinth"/);
});

test('unadorned r59 HTML omits optional AI sections cleanly while preserving V4 Curatorial Studio CSP & structure', () => {
  const cleanBatch = structuredClone(fixture);
  const cleanScored = scoreBatch(cleanBatch, profile);
  const cleanHtml = renderReport(cleanScored, cleanBatch);
  assert.match(cleanHtml, /script-src 'none'/);
  assert.doesNotMatch(cleanHtml, /data-section="redteam-audit"/);
  assert.doesNotMatch(cleanHtml, /data-section="concept-plinth"/);
});

test('r58 refuses to render 已复核 or fabricate GPT-6.2 Astra for unvalidated, reviewerless, or mismatched envelopes', () => {
  const batch = structuredClone(fixture);
  batch.candidates = [
    structuredClone(batch.candidates[0]),
    structuredClone(batch.candidates[1]),
    structuredClone(batch.candidates[2]),
  ];
  batch.candidates[0].spec_sha256 = 'e'.repeat(64);

  // Case 1: unvalidated envelope missing `validated_envelope: true` and `form_spec_sha256` when `spec_sha256` exists -> must NOT display 已复核
  batch.candidates[0].evidence_review = {
    status: 'ready',
    execution_status: 'completed',
    content_status: 'usable',
    model: 'gpt-6.2-astra',
    reasoning_effort: 'max',
    candidate_id: batch.candidates[0].id,
    schema_version: 'evidence-review-draft-v1',
    review_id: 'rev-unvalidated-raw',
    packet_sha256: 'a'.repeat(64),
    subjects: [{ subject_id: 's1', disposition: 'included', criterion_ids: ['c1'], evidence_ids: ['e1'], reason: 'ok' }],
    answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'ok' }],
    conclusion: 'Direct unvalidated object without attachCandidateEvidenceReview or matching spec_sha256.',
  };

  // Case 2: missing explicit reviewer metadata + spoofed disposition_counts -> must NOT display 已复核 or fabricate GPT-6.2 Astra
  batch.candidates[1].evidence_review = {
    status: 'ready',
    validated_envelope: true,
    execution_status: 'completed',
    content_status: 'usable',
    candidate_id: batch.candidates[1].id,
    schema_version: 'evidence-review-draft-v1',
    review_id: 'rev-no-reviewer',
    packet_sha256: 'f'.repeat(64),
    disposition_counts: { included: 99, excluded: 0, pending: 0 },
    subjects: [{ subject_id: 's1', disposition: 'included', evidence_ids: ['e1'], reason: 'ok' }],
    answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'ok' }],
    conclusion: 'Missing reviewer identity.',
  };

  // Case 3: candidate_id mismatch or missing spec_sha256 binding -> must NOT display 已复核
  batch.candidates[2].spec_sha256 = '2'.repeat(64);
  batch.candidates[2].evidence_review = {
    status: 'ready',
    validated_envelope: true,
    execution_status: 'completed',
    content_status: 'usable',
    model: 'gpt-6.2-astra',
    reasoning_effort: 'max',
    candidate_id: batch.candidates[2].id,
    review: {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-missing-spec-sha',
      packet_sha256: '1'.repeat(64),
      subjects: [{ subject_id: 's1', disposition: 'included', evidence_ids: ['e1'], reason: 'ok' }],
      answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'ok' }],
      conclusion: 'Missing form_spec_sha256 when candidate.spec_sha256 is present.',
    },
  };

  const scored = scoreBatch(batch, profile);
  const html = renderReport(scored, batch);
  assert.doesNotMatch(html, /已复核/);
  assert.doesNotMatch(html, /对标样本核定/);
  assert.doesNotMatch(html, /GPT-6\.2 Astra<\/span>/, 'must never fabricate bare GPT-6.2 Astra when reviewer metadata is absent');
});
