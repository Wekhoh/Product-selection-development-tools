import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUSINESS_THRESHOLDS } from '../src/business-thresholds.mjs';
import { detectRawPii, sanitizeDiagnosticText } from '../src/contracts.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { runPhase2Batch } from '../src/pipeline.mjs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import {
  buildBatchJsonl,
  parseBatchOutputJsonl,
  buildWorkflowTaskRequest,
  parseWorkflowTaskResult,
  freezeWorkflowTaskContext,
  extractStructuredResponsePayload,
  RETURN_CAUSE_DIAGNOSIS_JSON_SCHEMA,
  FACTORY_INQUIRY_CHECKLIST_JSON_SCHEMA,
  buildReturnCauseDiagnosisRequest,
  parseReturnCauseDiagnosisResult,
  resolveFactoryInquiryEligibility,
  resolvePackageCompressionTriggered,
  buildFactoryInquiryChecklistRequest,
  parseFactoryInquiryChecklistResult,
} from '../src/openai/index.mjs';
import { makeGate1AScenario, makeStage4OrganizerTrayCandidate } from './helpers/stage4-fixtures.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);
const syntheticFixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'),
);

function wrapResponsesEnvelope(obj) {
  return {
    id: 'resp_stage5a_test_001',
    object: 'response',
    status: 'completed',
    incomplete_details: null,
    error: null,
    output: [
      {
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(obj) }],
      },
    ],
  };
}

function wrapBatchLineEnvelope(customId, obj) {
  return {
    custom_id: customId,
    response: {
      status_code: 200,
      body: wrapResponsesEnvelope(obj),
    },
    error: null,
  };
}

test('Stage 5A Poteto Guard: zero user-facing "旺旺" wording in src/report.mjs and src/scoring.mjs (keeping internal wangwang_questions key)', () => {
  const guardedFiles = [
    new URL('../src/report.mjs', import.meta.url),
    new URL('../src/scoring.mjs', import.meta.url),
  ];
  for (const fileUrl of guardedFiles) {
    const src = readFileSync(fileUrl, 'utf8');
    assert.doesNotMatch(
      src,
      /旺旺/,
      `${fileUrl.pathname} still contains user-facing "旺旺"; replace with "1688 问厂" (keep internal key wangwang_questions for compatibility).`,
    );
  }
  // Confirm internal key wangwang_questions remains supported in src/report.mjs
  assert.match(readFileSync(new URL('../src/report.mjs', import.meta.url), 'utf8'), /\bwangwang_questions\b/);

  // Verify scoring.mjs sample-deferred label uses "1688 问厂" instead of "旺旺"
  const cand = structuredClone(syntheticFixture.candidates[0]);
  cand.id = 'cand-stage5a-label-check';
  const evId = cand.evidence[0].id;
  cand.judgments.routine_complexity = {
    anchor: null,
    sample_check_required: true,
    reason: '待确认常规质检抽检比例与备用配件包',
    evidence: [evId],
  };
  const scored = scoreCandidate(cand, r59Profile);
  const rcItem = scored.sample_check_items.find(it => it.id === 'routine_complexity');
  assert.ok(rcItem, 'expected routine_complexity in sample_check_items');
  assert.match(rcItem.label, /1688 问厂/);
  assert.doesNotMatch(rcItem.label, /旺旺/);
});

test('Stage 5A ② ReturnCauseDiagnosis: strict variant binding, honest complaint vs return labeling, missing Q&A/text guards, zero refund back-calc, and Batch compatibility', () => {
  const taskInput = {
    form_id: 'form-syn-mahjong-rack-20in',
    product_label: '20寸实木麻将架四件套',
    target_spec: '20-inch 4-rack solid walnut mahjong rack set with magnetic pushers and pouch',
    target_variant_sku: 'WALNUT-20IN-4PK',
    target_variant_asin: 'B0SYNMAHJ20',
    qa_total_count: 14,
    qa_count_only: true,
    qa_items: [],
    evidence_refs: ['ev-reviews-20261127'],
    reviews: [
      {
        review_id: 'rev-1',
        stars: 2,
        variant_sku: 'WALNUT-20IN-4PK',
        sku_verified: true,
        text: 'The magnetic pusher rail arrived chipped on one corner because the thin box had no corner foam, so I returned it for a refund.',
      },
      {
        review_id: 'rev-2',
        stars: 3,
        variant_sku: 'WALNUT-20IN-4PK',
        sku_verified: true,
        text: 'Nice walnut finish, though the pusher bar feels slightly stiff on the first slide until you wipe the groove.',
      },
      {
        review_id: 'rev-3',
        stars: 5,
        variant_sku: 'WALNUT-20IN-4PK',
        sku_verified: true,
        text: 'Solid wood feels great and all four racks arrived intact.',
      },
      {
        review_id: 'rev-other-sku',
        stars: 1,
        variant_sku: 'ACRYLIC-18IN-2PK',
        sku_verified: false,
        text: 'Acrylic cracked immediately, returned the next day.',
      },
    ],
  };

  // Request builder + alias + Batch JSONL compatibility
  const reqDirect = buildReturnCauseDiagnosisRequest(taskInput);
  const reqRegistry = buildWorkflowTaskRequest('return-cause-diagnosis', taskInput);
  const reqAlias = buildWorkflowTaskRequest('ReturnCauseDiagnosis', taskInput);
  assert.deepEqual(reqRegistry, reqDirect);
  assert.deepEqual(reqAlias, reqDirect);
  assert.equal(reqDirect.model, 'gpt-6.1-terra');
  assert.deepEqual(reqDirect.reasoning, { effort: 'xhigh' });
  assert.equal(reqDirect.text.format.strict, true);
  assert.deepEqual(reqDirect.text.format.schema, RETURN_CAUSE_DIAGNOSIS_JSON_SCHEMA);

  const batchJsonl = buildBatchJsonl([
    { custom_id: 'stage5-rc-001', method: 'POST', url: '/v1/responses', body: reqDirect },
  ]);
  assert.equal(batchJsonl.line_count, 1);

  // Paid Astra blocked & PII blocked
  assert.throws(() => buildReturnCauseDiagnosisRequest(taskInput, { model: 'gpt-6.2-astra' }), TypeError);
  assert.throws(
    () => buildReturnCauseDiagnosisRequest({ ...taskInput, target_spec: 'Contact owner@example.com for CAD' }),
    /PII|email/i,
  );

  // Valid structured output
  const validOutput = {
    schema_version: 1,
    contract: 'ReturnCauseDiagnosis',
    form_id: 'form-syn-mahjong-rack-20in',
    target_variant_sku: 'WALNUT-20IN-4PK',
    evidence_status: 'verified_variant_quotes',
    missing_evidence_flags: ['missing_qa_body_text'],
    missing_evidence_notes_zh: ['缺可核 Q&A 正文（仅返回 14 条计数，未含具体问答内容）。'],
    causes: [
      {
        cause_id: 'cause-corner-packaging',
        category: 'packaging_or_transit_damage',
        actionability: 'fixable_listing_manual_packaging',
        claim_basis: 'explicit_buyer_return',
        summary_zh: '单层薄彩盒缺护角缓冲，运输中导致磁吸推尺边角磕损并引发买家退货。',
        purchased_spec_note: 'WALNUT-20IN-4PK（20寸胡桃木四支装）',
        counter_evidence_zh: '同变体 5 星评价（rev-3）反映实木手感良好且四支完好送达，说明非普遍结构问题。',
        factory_verification_hook_zh: '确认四支套装零售盒是否加装 EVA/珍珠棉护角并满足常规运输防摔。',
        citations: [
          {
            source_type: 'review',
            source_id: 'rev-1',
            stars: 2,
            variant_sku: 'WALNUT-20IN-4PK',
            sku_verified: true,
            mentions_return_explicitly: true,
            excerpt: 'the thin box had no corner foam, so I returned it for a refund.',
          },
        ],
      },
      {
        cause_id: 'cause-groove-stiffness',
        category: 'assembly_or_usage_confusion',
        actionability: 'needs_factory_verification',
        claim_basis: 'buyer_complaint_possible_return',
        summary_zh: '买家抱怨首次推尺略紧需擦拭卡槽（未提及退货，属买家抱怨／可能导致退货）。',
        purchased_spec_note: 'WALNUT-20IN-4PK',
        counter_evidence_zh: '同条评论仍认可胡桃木表面做工。',
        factory_verification_hook_zh: '确认磁吸推尺卡槽公差打磨与出厂除尘质检标准。',
        citations: [
          {
            source_type: 'review',
            source_id: 'rev-2',
            stars: 3,
            variant_sku: 'WALNUT-20IN-4PK',
            sku_verified: true,
            mentions_return_explicitly: false,
            excerpt: 'the pusher bar feels slightly stiff on the first slide until you wipe the groove.',
          },
        ],
      },
    ],
    summary_zh: '已核同变体 1–3 星原文指向两类可行动点：一是护角包装不足导致的磕损退货（可优化包装），二是卡槽初推偏紧的买家抱怨（待问厂核实）；不从差评反推退款率。',
    disclaimer_zh: '本诊断仅基于已抽查原文归因，不从差评反推退款率，亦不改动 21 项确定性评分或 30% 毛利筛线。',
  };

  const parsedResp = parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(validOutput), taskInput);
  const parsedBatch = parseWorkflowTaskResult('return-cause-diagnosis', wrapBatchLineEnvelope('stage5-rc-001', validOutput), taskInput);
  assert.equal(parsedResp.valid, true);
  assert.equal(parsedResp.non_scoring, true);
  assert.equal(parsedResp.mutates_deterministic_scores, false);
  assert.equal(parsedResp.causes.length, 2);
  assert.equal(parsedResp.causes[1].claim_basis_label_zh, '买家抱怨／可能导致退货');
  assert.deepEqual(parsedBatch.causes, parsedResp.causes);

  // Guard 1: Non-verbatim excerpt rejected
  const badExcerpt = structuredClone(validOutput);
  badExcerpt.causes[0].citations[0].excerpt = 'thin box broke during shipping so buyer returned';
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(badExcerpt), taskInput), /verbatim/i);

  // Guard 2: Non-return complaint mislabeled as explicit_buyer_return rejected
  const badReturnClaim = structuredClone(validOutput);
  badReturnClaim.causes[1].claim_basis = 'explicit_buyer_return';
  badReturnClaim.causes[1].citations[0].mentions_return_explicitly = true;
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(badReturnClaim), taskInput), /return|refund/i);

  // Guard 3: Citing 5-star review as a return cause rejected
  const bad5Star = structuredClone(validOutput);
  bad5Star.causes[0].citations[0] = {
    source_type: 'review',
    source_id: 'rev-3',
    stars: 5,
    variant_sku: 'WALNUT-20IN-4PK',
    sku_verified: true,
    mentions_return_explicitly: false,
    excerpt: 'Solid wood feels great',
  };
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(bad5Star), taskInput), /1.*3|star/i);

  // Guard 4: Cross-SKU review falsely marked sku_verified: true rejected
  const badSku = structuredClone(validOutput);
  badSku.causes[0].citations[0] = {
    source_type: 'review',
    source_id: 'rev-other-sku',
    stars: 1,
    variant_sku: 'WALNUT-20IN-4PK',
    sku_verified: true,
    mentions_return_explicitly: true,
    excerpt: 'Acrylic cracked immediately, returned the next day.',
  };
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(badSku), taskInput), /variant_sku|sku_verified/i);

  // Guard 5: Missing Q&A flag required when qa_count_only is true
  const missingQaFlag = structuredClone(validOutput);
  missingQaFlag.missing_evidence_flags = [];
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(missingQaFlag), taskInput), /missing_qa_body_text/i);

  // Guard 6: Aggregate count-only input (zero texts) MUST be insufficient_evidence with causes=[]
  const countOnlyInput = {
    form_id: 'form-syn-counts-only',
    product_label: '仅计数示例商品',
    target_spec: 'Sample spec without review text',
    target_variant_sku: 'SKU-ONLY-1',
    review_count_only: true,
    total_review_count: 88,
    reviews: [],
    qa_items: [],
  };
  const fabricatedFromCounts = {
    ...structuredClone(validOutput),
    form_id: 'form-syn-counts-only',
    target_variant_sku: 'SKU-ONLY-1',
    evidence_status: 'insufficient_evidence',
    missing_evidence_flags: ['review_counts_only_no_text', 'missing_sku_matched_review_text'],
    missing_evidence_notes_zh: ['缺可核同变体原文（仅有评论总数）。'],
    causes: [],
    summary_zh: '当前仅有评论汇总计数，缺可核同变体原文，暂不推断退货根因。',
  };
  const parsedCountOnly = parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(fabricatedFromCounts), countOnlyInput);
  assert.equal(parsedCountOnly.evidence_status, 'insufficient_evidence');
  assert.deepEqual(parsedCountOnly.causes, []);

  const badCountOnlyStatus = { ...structuredClone(fabricatedFromCounts), evidence_status: 'verified_variant_quotes' };
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(badCountOnlyStatus), countOnlyInput), /insufficient_evidence|verified_variant_quotes/i);

  // Guard 7: Back-calculated refund rate / forbidden Product-P3 keys rejected
  const badRefundCalcKey = { ...structuredClone(validOutput), estimated_refund_rate: 0.14 };
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(badRefundCalcKey), taskInput), /forbidden|unexpected/i);
  const badRefundText = structuredClone(validOutput);
  badRefundText.summary_zh = '根据差评占比推算退货率约为 18%，建议重算毛利。';
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(badRefundText), taskInput), /refund|退货率/i);

  // Guard 8: Incomplete envelope rejected
  assert.throws(
    () => parseReturnCauseDiagnosisResult({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, taskInput),
    /incomplete/i,
  );
});

test('Stage 5A ③ FactoryInquiryChecklist1688: 5-bullet schema, wangwang_questions compat, qualifying vs on-demand gating, <=10mm compression trigger, and manual-only lock', () => {
  const baseInput = {
    form_id: 'form-syn-mahjong-rack-20in',
    product_label: '20寸实木麻将架四件套',
    target_spec: '20-inch 4-rack solid walnut mahjong rack set with magnetic pushers and pouch',
    counts_toward_target: true,
    sample_check_items: [
      { id: 'transport_tolerance', label: '运输耐受度', weight: 2, reason: '拿样核对内衬护角防摔' },
    ],
    return_cause_summary_zh: '单层薄彩盒缺护角导致磕损，磁吸推尺卡槽初推略紧。',
  };

  // Unselected non-qualifying card blocked ($0 spend protection)
  assert.throws(
    () => buildFactoryInquiryChecklistRequest({ ...baseInput, counts_toward_target: false }),
    /counts_toward_target|allow_on_demand_pending/i,
  );

  // Owner-picked near-line / pending card allowed with explicit allow_on_demand_pending: true
  const onDemandInput = {
    ...baseInput,
    counts_toward_target: false,
    allow_on_demand_pending: true,
    packaging_redesign_shortlist: {
      eligible: true,
      overshoot_mm: 1.8,
      offending_side: 'shortest',
      original_size_tier: 'Large Standard',
      target_size_tier: 'Small Standard',
    },
  };
  const reqAuto = buildFactoryInquiryChecklistRequest(baseInput);
  const reqOnDemand = buildWorkflowTaskRequest('factory-inquiry-1688', onDemandInput);
  const reqAlias = buildWorkflowTaskRequest('FactoryInquiryChecklist1688', onDemandInput);
  assert.deepEqual(reqAlias, reqOnDemand);
  assert.equal(reqAuto.model, 'gpt-6.1-terra');
  assert.deepEqual(reqAuto.reasoning, { effort: 'xhigh' });
  assert.deepEqual(reqAuto.text.format.schema, FACTORY_INQUIRY_CHECKLIST_JSON_SCHEMA);

  const batchJsonl = buildBatchJsonl([
    { custom_id: 'stage5-inq-001', method: 'POST', url: '/v1/responses', body: reqAuto },
  ]);
  assert.equal(batchJsonl.line_count, 1);

  const makeValidChecklist = ({ includeCompression = false } = {}) => {
    const bullets = [
      '请按 20 寸胡桃木四支套装核对完整清单：逐项确认实木材质、磁吸推尺、防滑垫、收纳袋与零售盒，并附实物合照。',
      '请按普通复购（不用首单补贴）分别报 100 套、300 套发广东深圳实际含运总价与大货交期。',
      '请提供单套零售包装尺寸毛重，以及每外箱装箱数、外箱毛尺寸与毛重，并说明是否支持亚马逊自有包装直发。',
      includeCompression
        ? '买家反馈存在护角磕损与推尺卡槽略紧：请说明内衬护角与打磨质检方案，并确认单边压线 1.8mm 能否在不降低防护强度的前提下压缩盒厚。'
        : '买家反馈存在护角磕损与推尺卡槽略紧：请说明常规包装是否加装护角缓冲以及磁吸卡槽出厂顺滑度质检标准。',
      '拿样核查：样品是否与大货同材质同包装？能否先寄 1 套样品供我核对跌落防摔与配件清单？',
    ];
    return {
      schema_version: 1,
      contract: 'FactoryInquiryChecklist1688',
      form_id: 'form-syn-mahjong-rack-20in',
      auto_send_prohibited: true,
      wangwang_questions: bullets,
      structured_items: [
        { slot: 1, topic: 'spec_parts_material_accessories', question_zh: bullets[0], includes_package_compression_check: false },
        { slot: 2, topic: 'regular_100_300_shenzhen_quote_lead_time', question_zh: bullets[1], includes_package_compression_check: false },
        { slot: 3, topic: 'retail_packaging_master_carton_own_box', question_zh: bullets[2], includes_package_compression_check: false },
        { slot: 4, topic: 'return_cause_and_quality_checks', question_zh: bullets[3], includes_package_compression_check: includeCompression },
        { slot: 5, topic: 'post_sample_verification_and_gaps', question_zh: bullets[4], includes_package_compression_check: false },
      ],
      copy_paste_message_zh: bullets.map((b, i) => `${i + 1}. ${b}`).join('\n'),
      manual_handoff_note_zh: '仅限主人审看后手动复制发给 1688 工厂，AI 严禁代发消息或自动议价。',
    };
  };

  // Qualifying card (no <=10mm trigger) parses cleanly & preserves internal wangwang_questions key
  const parsedAuto = parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeValidChecklist({ includeCompression: false })), baseInput);
  assert.equal(parsedAuto.valid, true);
  assert.equal(parsedAuto.auto_send_prohibited, true);
  assert.equal(parsedAuto.generation_mode, 'qualifying_auto');
  assert.equal(parsedAuto.package_compression_triggered, false);
  assert.equal(parsedAuto.wangwang_questions.length, 5);
  assert.deepEqual(parsedAuto.inquiry_bullets_zh, parsedAuto.wangwang_questions);

  // On-demand card WITH <=10mm trigger requires compression check in slot 4
  const parsedOnDemand = parseWorkflowTaskResult(
    'factory-inquiry-1688',
    wrapBatchLineEnvelope('stage5-inq-002', makeValidChecklist({ includeCompression: true })),
    onDemandInput,
  );
  assert.equal(parsedOnDemand.generation_mode, 'owner_on_demand_pending');
  assert.equal(parsedOnDemand.package_compression_triggered, true);
  assert.equal(parsedOnDemand.structured_items[3].includes_package_compression_check, true);

  // Guard 1: Unsolicited compression check when <=10mm NOT triggered rejected
  assert.throws(
    () => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeValidChecklist({ includeCompression: true })), baseInput),
    /compression|10\s*mm/i,
  );

  // Guard 2: Missing compression check when <=10mm IS triggered rejected
  assert.throws(
    () => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeValidChecklist({ includeCompression: false })), onDemandInput),
    /compression|10\s*mm/i,
  );

  // Guard 3: auto_send_prohibited: false rejected
  const badAutoSend = makeValidChecklist();
  badAutoSend.auto_send_prohibited = false;
  assert.throws(() => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(badAutoSend), baseInput), /auto_send_prohibited/i);

  // Guard 4: User-facing "旺旺" in generated inquiry copy rejected
  const badWangwangCopy = makeValidChecklist();
  badWangwangCopy.wangwang_questions[4] = '请旺旺回复样品交期与质检标准。';
  badWangwangCopy.structured_items[4].question_zh = badWangwangCopy.wangwang_questions[4];
  assert.throws(() => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(badWangwangCopy), baseInput), /旺旺|1688 问厂/);

  // Guard 5: Slot 2 missing 100/300 Shenzhen freight/lead-time rejected
  const badSlot2 = makeValidChecklist();
  badSlot2.wangwang_questions[1] = '请问这款产品多少钱一套？';
  badSlot2.structured_items[1].question_zh = badSlot2.wangwang_questions[1];
  assert.throws(() => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(badSlot2), baseInput), /100.*300|深圳|交期/);

  // Guard 5b: Raw email PII in output rejected
  const badEmailOut = makeValidChecklist();
  badEmailOut.wangwang_questions[4] = '请把样品寄给我并把报价发到 buyer@example.invalid 核对。';
  badEmailOut.structured_items[4].question_zh = badEmailOut.wangwang_questions[4];
  badEmailOut.copy_paste_message_zh = badEmailOut.wangwang_questions.map((b, i) => `${i + 1}. ${b}`).join('\n');
  assert.throws(() => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(badEmailOut), baseInput), /email|PII/i);

  // Guard 6: freezeWorkflowTaskContext protects against post-dispatch caller mutation
  const mutableCtxInput = structuredClone(baseInput);
  const frozen = freezeWorkflowTaskContext('factory-inquiry-1688', mutableCtxInput);
  mutableCtxInput.sample_check_items.push({ id: 'mutated', label: 'hack', weight: 1, reason: 'mutated' });
  assert.equal(frozen.sample_check_items.length, 1);
  assert.equal(Object.isFrozen(frozen), true);
});

test('Stage 5A HTML Rendering: renders ② Return-Cause & ③ 5-Bullet 1688 Checklist beneath 拿样／1688 问厂待核清单, scrubs PII/paths, keeps baseline free of Stage 5A sections', () => {
  // 1. Undisputed baseline without Stage 5A sections remains deterministic and omits Stage 5A sections
  const c0 = structuredClone(syntheticFixture.candidates[0]);
  if (c0.presentation) {
    delete c0.presentation.hero_image_data_uri;
    delete c0.presentation.contact_sheet_data_uri;
    delete c0.presentation.image_data_uri;
  }
  delete c0.concept_images;
  const b0 = { schema_version: 1, profile_revision: 59, candidates: [c0] };
  const h0 = renderReport(scoreBatch(b0, r59Profile), b0);
  assert.ok(h0.length > 0);
  assert.equal(renderReport(scoreBatch(b0, r59Profile), b0), h0, 'undisputed baseline HTML must remain deterministic');
  assert.match(h0, /lang="zh-CN"/);
  assert.equal((h0.match(/data-item-id=/g) ?? []).length, 21);
  assert.doesNotMatch(h0, /data-section="return-cause-diagnosis"|data-section="factory-inquiry-1688"/);
  assert.doesNotMatch(h0, /<script\b/i);
  assert.doesNotMatch(h0, /—/);

  // 2. Qualifying sample-pending card with ② + ③ attached (including zero score impact & PII/path scrubbing)
  const cand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
    specSha256: '2'.repeat(64),
    specVersion: 1,
  });
  const evId = cand.evidence[0].id;
  cand.judgments.routine_complexity = {
    anchor: null,
    sample_check_required: true,
    reason: '待拿样确认质检抽检比例与备件包。',
    evidence: [evId],
  };

  const controlScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [structuredClone(cand)] }, r59Profile);

  cand.return_cause_diagnosis = {
    schema_version: 1,
    contract: 'ReturnCauseDiagnosis',
    form_id: cand.id,
    target_variant_sku: 'TRAY-STD-1PK',
    evidence_status: 'verified_variant_quotes',
    missing_evidence_flags: ['missing_qa_body_text'],
    missing_evidence_notes_zh: ['缺可核 Q&A 正文（仅返回计数）。详见 D:\\private\\qa-dump.json — buyer@example.invalid'],
    causes: [
      {
        cause_id: 'c-lid',
        category: 'packaging_or_transit_damage',
        actionability: 'fixable_listing_manual_packaging',
        claim_basis: 'explicit_buyer_return',
        summary_zh: '单层纸盒未加护角导致边角压裂并退货。',
        purchased_spec_note: 'TRAY-STD-1PK',
        counter_evidence_zh: '同变体 5 星好评反馈无磕损。',
        factory_verification_hook_zh: '核实内衬护角与外箱抗压。',
        citations: [
          {
            source_type: 'review',
            source_id: 'rev-1',
            stars: 2,
            variant_sku: 'TRAY-STD-1PK',
            sku_verified: true,
            mentions_return_explicitly: true,
            excerpt: 'Box corner crushed in transit, had to return it.',
          },
        ],
      },
      {
        cause_id: 'c-fit',
        category: 'sizing_or_fit_mismatch',
        actionability: 'structural_defect_trap',
        claim_basis: 'buyer_complaint_possible_return',
        summary_zh: '隔板槽位略窄，大瓶装难放入。',
        purchased_spec_note: 'TRAY-STD-1PK',
        counter_evidence_zh: '常规标准瓶可正常收纳。',
        factory_verification_hook_zh: '确认每格净宽公差。',
        citations: [
          {
            source_type: 'review',
            source_id: 'rev-2',
            stars: 3,
            variant_sku: 'TRAY-STD-1PK',
            sku_verified: true,
            mentions_return_explicitly: false,
            excerpt: 'Slot width is tight for oversized jars.',
          },
        ],
      },
    ],
    summary_zh: '护角包装与隔板公差为两项核心待核点；不从差评反推退款率。',
    disclaimer_zh: '仅基于抽查原文诊断，不从差评反推退款率，不改动 21 项评分。',
  };

  cand.factory_inquiry_1688 = {
    schema_version: 1,
    contract: 'FactoryInquiryChecklist1688',
    form_id: cand.id,
    auto_send_prohibited: true,
    generation_mode: 'qualifying_auto',
    package_compression_triggered: false,
    wangwang_questions: [
      '请确认完整配件清单与材质，并附实物合照。',
      '普通复购不用首单券，100 套、300 套分别报发深圳含运总价与大货交期。',
      '请提供单套零售盒及外箱装箱数、毛尺寸与重量，并说明自有包装方式。',
      '针对边角磕损与隔板净宽偏紧问题，请说明护角防护与槽宽公差质检标准。',
      '样品是否与大货一致，能否先寄 1 套核对质检与备件包？联系路径 C:\\Users\\Private\\sheet.xlsx',
    ],
    structured_items: [
      { slot: 1, topic: 'spec_parts_material_accessories', question_zh: '请确认完整配件清单与材质，并附实物合照。', includes_package_compression_check: false },
      { slot: 2, topic: 'regular_100_300_shenzhen_quote_lead_time', question_zh: '普通复购不用首单券，100 套、300 套分别报发深圳含运总价与大货交期。', includes_package_compression_check: false },
      { slot: 3, topic: 'retail_packaging_master_carton_own_box', question_zh: '请提供单套零售盒及外箱装箱数、毛尺寸与重量，并说明自有包装方式。', includes_package_compression_check: false },
      { slot: 4, topic: 'return_cause_and_quality_checks', question_zh: '针对边角磕损与隔板净宽偏紧问题，请说明护角防护与槽宽公差质检标准。', includes_package_compression_check: false },
      { slot: 5, topic: 'post_sample_verification_and_gaps', question_zh: '样品是否与大货一致，能否先寄 1 套核对质检与备件包？联系路径 C:\\Users\\Private\\sheet.xlsx', includes_package_compression_check: false },
    ],
    copy_paste_message_zh: '1. 请确认完整配件清单与材质，并附实物合照。\n2. 普通复购不用首单券，100 套、300 套分别报发深圳含运总价与大货交期。\n3. 请提供单套零售盒及外箱装箱数、毛尺寸与重量，并说明自有包装方式。\n4. 针对边角磕损与隔板净宽偏紧问题，请说明护角防护与槽宽公差质检标准。\n5. 样品是否与大货一致，能否先寄 1 套核对质检与备件包？',
    manual_handoff_note_zh: '仅限主人人工审看后复制发送，AI 严禁自动联系 1688 供应商。',
  };

  const batch = { schema_version: 1, profile_revision: 59, candidates: [cand] };
  const scored = scoreBatch(batch, r59Profile);

  // Zero score mutation from Stage 5A attachments
  assert.deepEqual(scored.candidates[0].core_85_range, controlScored.candidates[0].core_85_range);
  assert.deepEqual(scored.candidates[0].supported_range, controlScored.candidates[0].supported_range);
  assert.equal(scored.candidates[0].qualification.counts_toward_target, controlScored.candidates[0].qualification.counts_toward_target);

  const html = renderReport(scored, batch);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /—/, 'rendered HTML must contain zero em-dashes');
  assert.doesNotMatch(html, /旺旺/, 'rendered HTML must contain zero user-facing 旺旺 wording');
  assert.doesNotMatch(html, /qa-dump\.json|buyer@example\.invalid|Private\\sheet\.xlsx/i, 'must scrub local paths and emails in Stage 5A sections');

  // Ordering: sample-pending-checklist -> return-cause-diagnosis -> factory-inquiry-1688
  const idxSample = html.indexOf('data-section="sample-pending-checklist"');
  const idxReturn = html.indexOf('data-section="return-cause-diagnosis"');
  const idxInquiry = html.indexOf('data-section="factory-inquiry-1688"');
  assert.ok(idxSample > 0 && idxReturn > idxSample && idxInquiry > idxReturn, '② and ③ must render beneath 拿样／1688 问厂待核清单');

  assert.match(html, /拿样／1688 问厂待核清单/);
  assert.match(html, /缺可核 Q&amp;A 正文/);
  assert.match(html, /买家抱怨／可能导致退货/);
  assert.match(html, /Box corner crushed in transit, had to return it\./);
  assert.match(html, /不从差评反推退款率/);
  assert.match(html, /1688 问厂与拿样 5 条清单/);
  assert.match(html, /100 套、300 套分别报发深圳含运总价与大货交期/);
  assert.match(html, /仅限人工复制发送 · AI 严禁代发消息/);
  assert.match(html, /<pre class="copy-block">/);

  // 3. On-demand pending card with insufficient_evidence (causes=[]) + <=10mm compression badge renders cleanly
  const onDemandCard = structuredClone(cand);
  onDemandCard.id = 'cand-stage5a-ondemand-10mm';
  onDemandCard.return_cause_diagnosis = {
    schema_version: 1,
    contract: 'ReturnCauseDiagnosis',
    form_id: onDemandCard.id,
    target_variant_sku: null,
    evidence_status: 'insufficient_evidence',
    missing_evidence_flags: ['missing_qa_body_text', 'missing_sku_matched_review_text'],
    missing_evidence_notes_zh: [],
    causes: [],
    summary_zh: '缺可核同变体原文与 Q&A 正文，暂不推断退货根因。',
    disclaimer_zh: '不从差评反推退款率，不改动 21 项评分。',
  };
  onDemandCard.factory_inquiry_1688.form_id = onDemandCard.id;
  onDemandCard.factory_inquiry_1688.generation_mode = 'owner_on_demand_pending';
  onDemandCard.factory_inquiry_1688.structured_items[3].includes_package_compression_check = true;
  const odBatch = { schema_version: 1, profile_revision: 59, candidates: [onDemandCard] };
  const odHtml = renderReport(scoreBatch(odBatch, r59Profile), odBatch);
  assert.match(odHtml, /原文证据不足/);
  assert.match(odHtml, /缺可核同变体原文/);
  assert.match(odHtml, /主人点选按需生成/);
  assert.match(odHtml, /含 ≤10 mm 压线减尺寸核查/);
  assert.doesNotMatch(odHtml, /旺旺/);
  assert.doesNotMatch(odHtml, /—/);
});

test('Stage 5A Round 1 Astra Regressions (STD-1..3, SPEC-2..5): provider normalization, PII/path whitelist, Chinese product-tier regex, shared envelope refusal, strict quote/return/no-text guards', () => {
  const ctx = {
    form_id: 'form-syn-r1-audit',
    product_label: '合成木质收纳架',
    target_spec: '4-piece wooden organizer rack set',
    target_variant_sku: 'WOOD',
  };

  // STD-1 & SPEC-2: SellerSprite provider shape (`reviewId`, `star`, `skus`, `author`, `content`, `source_file`) + detail `questions`
  const providerReview = {
    reviewId: 'r-ss-1',
    star: 2,
    skus: ['Wood'],
    author: 'Fixture Reviewer Name',
    content: 'Outer box split. Call 202-555-0147.',
    source_file: 'D:/fixture/packing.pdf',
  };
  const req = buildReturnCauseDiagnosisRequest({
    ...ctx,
    questions: 12,
    reviews: [providerReview],
  });
  const batchLine = buildBatchJsonl([{ custom_id: 'r1-p2', method: 'POST', url: '/v1/responses', body: req }]);
  assert.equal(batchLine.jsonl.includes('Fixture Reviewer Name'), false, 'author must be stripped before outbound dispatch');
  assert.equal(batchLine.jsonl.includes('202-555-0147'), false, 'US phone must be redacted before outbound dispatch');
  assert.equal(batchLine.jsonl.includes('D:/fixture/packing.pdf'), false, 'source_file local path must be stripped');
  const wireUserPayload = JSON.parse(req.input[1].content[0].text);
  assert.equal(wireUserPayload.qa_total_count, 12);
  assert.equal(wireUserPayload.qa_count_only, true);
  assert.equal(wireUserPayload.reviews[0].review_id, 'r-ss-1');
  assert.equal(wireUserPayload.reviews[0].stars, 2);
  assert.equal(wireUserPayload.reviews[0].sku_verified, 'unknown');
  assert.equal(wireUserPayload.reviews[0].variant_sku, null);

  // Provider review parses cleanly as partial_or_unverified_variant with missing_qa_body_text & missing_sku_matched_review_text
  const providerOut = {
    schema_version: 1,
    contract: 'ReturnCauseDiagnosis',
    form_id: ctx.form_id,
    target_variant_sku: 'WOOD',
    evidence_status: 'partial_or_unverified_variant',
    missing_evidence_flags: ['missing_qa_body_text', 'missing_sku_matched_review_text'],
    missing_evidence_notes_zh: ['缺可核 Q&A 正文（仅返回 12 条计数）。'],
    causes: [
      {
        cause_id: 'c-box',
        category: 'packaging_or_transit_damage',
        actionability: 'needs_factory_verification',
        claim_basis: 'buyer_complaint_possible_return',
        summary_zh: '外盒破损抱怨，变体未核实。',
        purchased_spec_note: null,
        counter_evidence_zh: null,
        factory_verification_hook_zh: '核查外箱防摔。',
        citations: [
          {
            source_type: 'review',
            source_id: 'r-ss-1',
            stars: 2,
            variant_sku: null,
            sku_verified: 'unknown',
            mentions_return_explicitly: false,
            excerpt: 'Outer box split.',
          },
        ],
      },
    ],
    summary_zh: '外盒存在运输破损抱怨，尚缺同变体核验。',
    disclaimer_zh: '不从差评反推退款率，不改动评分。',
  };
  const parsedProvider = parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(providerOut), {
    ...ctx,
    questions: 12,
    reviews: [providerReview],
  });
  assert.equal(parsedProvider.valid, true);

  // Missing `missing_qa_body_text` when `questions: 12` was supplied must throw
  assert.throws(
    () => parseReturnCauseDiagnosisResult(
      wrapResponsesEnvelope({ ...providerOut, missing_evidence_flags: ['missing_sku_matched_review_text'] }),
      { ...ctx, questions: 12, reviews: [providerReview] },
    ),
    /missing_qa_body_text/,
  );

  // STD-2: Chinese product-tier reviews pass detectRawPii AND Batch output round-trip verbatim without rewriting "三层瓦楞"
  assert.equal(detectRawPii('It jammed. 第二层卡住了。'), null);
  assert.equal(detectRawPii('三层瓦楞外箱开裂。'), null);
  assert.equal(sanitizeDiagnosticText('三层瓦楞外箱开裂。'), '三层瓦楞外箱开裂。');
  assert.equal(detectRawPii('收件地址：科技路88号3栋5层'), 'detailed_street_address');
  assert.equal(detectRawPii('科技大厦5层办公区'), 'detailed_street_address');

  const zhBody = '三层瓦楞外箱开裂。';
  const zhInput = { ...ctx, reviews: [{ review_id: 'r-zh', stars: 2, variant_sku: 'WOOD', sku_verified: true, text: zhBody }] };
  const zhOut = {
    ...providerOut,
    evidence_status: 'verified_variant_quotes',
    missing_evidence_flags: [],
    missing_evidence_notes_zh: [],
    causes: [{
      ...providerOut.causes[0],
      citations: [{ source_type: 'review', source_id: 'r-zh', stars: 2, variant_sku: 'WOOD', sku_verified: true, mentions_return_explicitly: false, excerpt: zhBody }],
    }],
  };
  const zhBatchReq = buildBatchJsonl([{ custom_id: 'r1-zh', method: 'POST', url: '/v1/responses', body: buildReturnCauseDiagnosisRequest(zhInput) }]);
  const zhBatchRaw = JSON.stringify({
    custom_id: 'r1-zh',
    response: { status_code: 200, body: { ...wrapResponsesEnvelope(zhOut), model: 'gpt-6.1-terra', usage: { input_tokens: 40, output_tokens: 40, total_tokens: 80 } } },
    error: null,
  });
  const zhBatchRow = parseBatchOutputJsonl(zhBatchRaw, {
    expectedEndpoint: '/v1/responses',
    lineModels: zhBatchReq.line_models,
    lineSpecs: zhBatchReq.line_specs,
  }).by_custom_id['r1-zh'];
  assert.equal(zhBatchRow.usable, true);
  assert.equal(parseReturnCauseDiagnosisResult(zhBatchRow, zhInput).valid, true);

  // STD-3: Shared response-envelope rejects object-shaped `content[0].refusal` identically everywhere
  const refusalEnv = wrapResponsesEnvelope(zhOut);
  refusalEnv.output[0].content[0].refusal = { reason: 'Synthetic refusal' };
  assert.throws(() => extractStructuredResponsePayload(refusalEnv, 'return-cause-diagnosis'), /refused/i);
  assert.throws(() => parseReturnCauseDiagnosisResult(refusalEnv, zhInput), /refused/i);

  // SPEC-3: Missing star, missing taskInput for verified_variant_quotes, mixed other-variant cause, curly-quote literal snapping
  const noStarInput = { ...ctx, reviews: [{ review_id: 'r-zh', variant_sku: 'WOOD', sku_verified: true, text: zhBody }] };
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(zhOut), noStarInput), /1–3★|verified_variant_quotes/i);
  assert.throws(() => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(zhOut)), /taskInput/i);

  const mixedVariantOut = structuredClone(zhOut);
  mixedVariantOut.causes.push({
    ...zhOut.causes[0],
    cause_id: 'c-acrylic',
    citations: [{ source_type: 'review', source_id: 'r-acr', stars: 2, variant_sku: 'ACRYLIC', sku_verified: false, mentions_return_explicitly: false, excerpt: 'Acrylic cracked.' }],
  });
  assert.throws(
    () => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope(mixedVariantOut), {
      ...ctx,
      reviews: [
        { review_id: 'r-zh', stars: 2, variant_sku: 'WOOD', sku_verified: true, text: zhBody },
        { review_id: 'r-acr', stars: 2, variant_sku: 'ACRYLIC', sku_verified: false, text: 'Acrylic cracked.' },
      ],
    }),
    /every cause/i,
  );

  const curlyParsed = parseReturnCauseDiagnosisResult(
    wrapResponsesEnvelope({
      ...zhOut,
      causes: [{ ...zhOut.causes[0], citations: [{ ...zhOut.causes[0].citations[0], excerpt: "It didn't fit." }] }],
    }),
    { ...ctx, reviews: [{ review_id: 'r-zh', stars: 2, variant_sku: 'WOOD', sku_verified: true, text: 'It didn’t fit.' }] },
  );
  assert.equal(curlyParsed.causes[0].citations[0].excerpt, 'It didn’t fit.');

  // SPEC-4: Honest return vs complaint labeling (return window, question, negated full sentence, Q&A vs affirmative return)
  const runExplicitReturn = (body, excerpt = body) => parseReturnCauseDiagnosisResult(
    wrapResponsesEnvelope({
      ...zhOut,
      causes: [{
        ...zhOut.causes[0],
        claim_basis: 'explicit_buyer_return',
        citations: [{ ...zhOut.causes[0].citations[0], mentions_return_explicitly: true, excerpt }],
      }],
    }),
    { ...ctx, reviews: [{ review_id: 'r-zh', stars: 2, variant_sku: 'WOOD', sku_verified: true, text: body }] },
  );
  assert.throws(() => runExplicitReturn('I kept it because the return window closed.'), /affirmative buyer return/i);
  assert.throws(() => runExplicitReturn('Can I get a refund?'), /affirmative buyer return/i);
  assert.throws(() => runExplicitReturn('I did not return it.', 'return it'), /affirmative buyer return/i);
  assert.equal(runExplicitReturn('I returned it.').causes[0].claim_basis_label_zh, '买家明言退货');

  // SPEC-5: No-text deterministic summary synthesis + all-prose refund back-calc + private path rejection
  const emptyParsed = parseReturnCauseDiagnosisResult(
    wrapResponsesEnvelope({
      ...zhOut,
      evidence_status: 'insufficient_evidence',
      missing_evidence_flags: ['missing_qa_body_text', 'missing_sku_matched_review_text', 'review_counts_only_no_text'],
      missing_evidence_notes_zh: ['缺可核 Q&A 正文'],
      causes: [],
      summary_zh: '退货主因是护角开裂。',
    }),
    { ...ctx, reviews: [], qa_items: [], review_count_only: true, qa_count_only: true },
  );
  assert.doesNotMatch(emptyParsed.summary_zh, /护角开裂/);
  assert.match(emptyParsed.summary_zh, /暂不推断退货根因/);
  assert.throws(
    () => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope({ ...zhOut, summary_zh: '据差评判断，退款率约为18%。' }), zhInput),
    /refund|return rate/i,
  );
  assert.throws(
    () => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope({ ...zhOut, disclaimer_zh: '根据差评推算退款率约为18%。' }), zhInput),
    /refund|return rate/i,
  );
  assert.throws(
    () => parseReturnCauseDiagnosisResult(wrapResponsesEnvelope({ ...zhOut, summary_zh: '查验记录在 .local/trials/fixture/private-comments.json。' }), zhInput),
    /local file path/i,
  );
});

test('Stage 5A Round 1 Astra Regressions (SPEC-6..10c): threshold SSOT, slot 1-5 & copy-block SSOT, eligibility/cross-card/vision/scored-card guards, and HTML legacy wording & unvalidated attachment rejection', () => {
  const ctx = {
    form_id: 'form-syn-r1-inq',
    product_label: '合成木质架',
    target_spec: 'Four-piece wooden organizer rack',
    counts_toward_target: true,
  };
  const baseBullets = [
    '请列完整规格、材质、配件，附套装合照。',
    '请按常规复购价分别报100套、300套到深圳含运总价和大货交期。',
    '请报零售包装及外箱尺寸、重量、每箱套数和原箱直发资格。',
    '如何核查买家反映的包装开裂？',
    '样品和大货是否同规格，如何拿样核实？',
  ];
  const makeInquiry = (bullets = baseBullets, compression = false, copyTail = '') => ({
    schema_version: 1,
    contract: 'FactoryInquiryChecklist1688',
    form_id: ctx.form_id,
    auto_send_prohibited: true,
    wangwang_questions: bullets,
    structured_items: bullets.map((question_zh, i) => ({
      slot: i + 1,
      topic: ['spec_parts_material_accessories', 'regular_100_300_shenzhen_quote_lead_time', 'retail_packaging_master_carton_own_box', 'return_cause_and_quality_checks', 'post_sample_verification_and_gaps'][i],
      question_zh,
      includes_package_compression_check: i === 3 && compression,
    })),
    copy_paste_message_zh: bullets.map((q, i) => `${i + 1}. ${q}`).join('\n') + copyTail,
    manual_handoff_note_zh: '仅限人工审看并手动发送。',
  });

  // SPEC-6: Registered threshold SSOT (10 mm), batch array shortlist, no spurious triggers
  assert.equal(BUSINESS_THRESHOLDS.borderline_package_rescue_max_mm, 10);
  const entry = { eligible: true, overshoot_mm: 1.8, form_id: ctx.form_id };
  assert.equal(resolvePackageCompressionTriggered({ ...ctx, packaging_redesign_shortlist: entry }), true);
  assert.equal(resolvePackageCompressionTriggered({ ...ctx, packaging_redesign_shortlist: [entry] }), true);
  assert.equal(resolvePackageCompressionTriggered({ package_compression_triggered: true, packaging_redesign_shortlist: { eligible: false, overshoot_mm: 14 } }), false);
  assert.equal(resolvePackageCompressionTriggered({ borderline_overshoot_mm: 10.00005 }), false);
  assert.equal(resolvePackageCompressionTriggered({ packaging_redesign_shortlist: { eligible: false }, borderline_overshoot_mm: 1.8 }), false);

  // Slot 4 compression precision: reject untriggered box-thinning, allow component 10 mm wood, reject triggered 10 mm board
  assert.throws(
    () => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(baseBullets.with(3, '能否把外盒减薄2毫米并保留保护强度？'))), ctx),
    /package-compression/i,
  );
  assert.equal(
    parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(baseBullets.with(3, '10 mm厚的木条如何防止开裂？'))), ctx).valid,
    true,
  );
  assert.throws(
    () => parseFactoryInquiryChecklistResult(
      wrapResponsesEnvelope(makeInquiry(baseBullets.with(3, '请确认10 mm板材的强度。'), true)),
      { ...ctx, packaging_redesign_shortlist: entry },
    ),
    /trimming packaging dimensions/i,
  );

  // SPEC-7: Slot 2 natural Chinese vs first-order/freight-excluded, substantive Slot 1/3/4/5, single copy-block SSOT
  assert.throws(
    () => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(baseBullets.with(1, '请报首单100套和300套的深圳出厂单价及交期，运费另算。'))), ctx),
    /first-order|首单/i,
  );
  assert.equal(
    parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(baseBullets.with(1, '常规复购100套和300套各自包邮到深圳多少钱，多久能发货？'))), ctx).valid,
    true,
  );
  assert.throws(
    () => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(['你好。', baseBullets[1], '包装外箱尺寸多少？', '你好。', '样品？'])), ctx),
    /slot 1/i,
  );
  const canonicalRes = parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(baseBullets, false, '\n6. 请直接安排300套生产。')), ctx);
  assert.equal(canonicalRes.copy_paste_message_zh, baseBullets.map((q, i) => `${i + 1}. ${q}`).join('\n'));
  assert.equal(canonicalRes.copy_paste_message_zh.split('\n').length, 5);

  const naturalParaphraseBullets = [
    '请确认整套用料、零件结构参数，并提供全套实物合照。',
    '按日常复购，一百套和三百套发到深圳包物流各自批价多少、生产周期几天？',
    '单品独立包装与大箱长宽高、毛重是多少？多少套一箱，是否支持原厂箱直发？',
    '针对实木件易变形松动的问题，大货品控如何把关？',
    '寄样确认后，大货与样板保持同工艺对照验货，请配合核对。',
  ];
  assert.equal(
    parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry(naturalParaphraseBullets)), ctx).valid,
    true,
  );

  // SPEC-8 & SPEC-10a-c: Unselected parse rejection, cross-card diagnosis rejection, rights-excluded block, stale flag override, Vision & scored-card direct build
  assert.throws(() => parseFactoryInquiryChecklistResult(wrapResponsesEnvelope(makeInquiry()), { ...ctx, counts_toward_target: false }), /counts_toward_target|allow_on_demand_pending/i);
  assert.throws(
    () => buildFactoryInquiryChecklistRequest({ ...ctx, return_cause_diagnosis: { form_id: 'other-form' } }),
    /does not match input\.form_id/i,
  );
  const rightsExcluded = { ...ctx, effective_disposition: 'hard_excluded', specific_rights_conflict: true, qualification: { counts_toward_target: false } };
  assert.throws(() => buildFactoryInquiryChecklistRequest({ ...rightsExcluded, allow_on_demand_pending: true }), /rights-conflict/i);
  assert.equal(resolveFactoryInquiryEligibility({ ...rightsExcluded, counts_toward_target: true }).generation_mode, null);

  const visionReq = buildFactoryInquiryChecklistRequest({
    ...ctx,
    component_gaps: ['缺内衬护角'],
    wangwang_questions: ['请提供外箱尺寸与毛重'],
  });
  const visionWire = JSON.parse(visionReq.input[1].content[0].text);
  assert.deepEqual(visionWire.vision_component_gaps, ['缺内衬护角']);
  assert.deepEqual(visionWire.existing_wangwang_questions, ['请提供外箱尺寸与毛重']);

  // Direct scored candidate accepted by buildFactoryInquiryChecklistRequest + HTML refuses unvalidated/cross-card attachments & normalizes legacy "旺旺"
  const cand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { specSha256: '3'.repeat(64), specVersion: 1 });
  cand.judgments.routine_complexity = {
    anchor: null,
    sample_check_required: true,
    reason: '随箱英文说明书与装箱率留待拿样/旺旺核对。',
    evidence: [cand.evidence[0].id],
  };
  const baseBatch = { schema_version: 1, profile_revision: 59, candidates: [cand] };
  const baseScored = scoreBatch(baseBatch, r59Profile);
  assert.equal(buildFactoryInquiryChecklistRequest(baseScored.candidates[0]).model, 'gpt-6.1-terra');

  // Inject malformed/cross-card attachments + relative .local/ path + single-note missing flags
  cand.factory_inquiry_1688 = {
    contract: 'FactoryInquiryChecklist1688',
    form_id: 'other-form',
    auto_send_prohibited: false,
    wangwang_questions: ['用旺旺联系合成示例。'],
  };
  cand.return_cause_diagnosis = {
    contract: 'ReturnCauseDiagnosis',
    form_id: 'other-form',
    evidence_status: 'insufficient_evidence',
    missing_evidence_flags: ['missing_qa_body_text', 'missing_sku_matched_review_text'],
    missing_evidence_notes_zh: ['缺可核 Q&A 正文'],
    causes: [],
    summary_zh: '跨卡不应渲染。',
    disclaimer_zh: '仅供人工核实。',
  };
  const rejectedHtml = renderReport(scoreBatch(baseBatch, r59Profile), baseBatch);
  assert.equal(rejectedHtml.includes('data-section="return-cause-diagnosis"'), false, 'cross-card diagnosis must not render');
  assert.equal(rejectedHtml.includes('data-section="factory-inquiry-1688"'), false, 'invalid/cross-card inquiry must not render');
  assert.doesNotMatch(rejectedHtml, /旺旺/, 'legacy card judgment/gap wording must render as 1688 问厂');

  // Valid same-card diagnosis with relative `.local/...` path & single note still exposes ALL missing_evidence_flags and scrubs `.local/...`
  cand.return_cause_diagnosis.form_id = cand.id;
  cand.return_cause_diagnosis.summary_zh = '查验记录在 .local/trials/fixture/private-comments.json。';
  const validHtml = renderReport(scoreBatch(baseBatch, r59Profile), baseBatch);
  assert.equal(validHtml.includes('.local/trials/fixture/private-comments.json'), false, 'relative .local path must be scrubbed');
  assert.match(validHtml, /缺可核同变体原文/, 'missing_sku_matched_review_text must never be masked by a single Q&A note');
  assert.match(validHtml, /缺可核 Q&amp;A 正文/);
});

test('Stage 5A Pipeline Wiring (SPEC-1 & STD-4): runPhase2Batch attaches optional ②/③ post-scoring without altering scores or evidence_bundle_sha256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage5a-pipeline-'));
  const dbPath = join(dir, 'selection.sqlite');
  const store = openSelectionStore(dbPath);
  try {
    const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
      specSha256: '4'.repeat(64),
      specVersion: 1,
    });
    const formId = baseCand.id;

    const makeValidDiag = (id) => ({
      schema_version: 1,
      contract: 'ReturnCauseDiagnosis',
      form_id: id,
      target_variant_sku: 'TRAY-STD-1PK',
      evidence_status: 'verified_variant_quotes',
      missing_evidence_flags: [],
      missing_evidence_notes_zh: [],
      causes: [
        {
          cause_id: 'c-corner',
          category: 'packaging_or_transit_damage',
          actionability: 'fixable_listing_manual_packaging',
          claim_basis: 'explicit_buyer_return',
          summary_zh: '薄彩盒缺护角致磕损退货，可补强包装。',
          purchased_spec_note: 'TRAY-STD-1PK',
          counter_evidence_zh: null,
          factory_verification_hook_zh: '确认彩盒护角缓冲。',
          citations: [
            {
              source_type: 'review',
              source_id: 'r-pipe-1',
              stars: 2,
              variant_sku: 'TRAY-STD-1PK',
              sku_verified: true,
              mentions_return_explicitly: true,
              excerpt: 'Corner crushed, returned it.',
            },
          ],
        },
      ],
      summary_zh: '薄彩盒护角不足引发退货，不从差评反推退款率。',
      disclaimer_zh: '仅基于抽查原文诊断，不改动评分。',
    });

    const makeValidInq = (id, firstBullet) => {
      const bullets = [
        firstBullet,
        '请按常规复购价分别报100套、300套到深圳含运总价和大货交期。',
        '请报零售包装及外箱尺寸、重量、每箱套数和原箱直发资格。',
        '针对买家反馈的护角磕损退货，请说明护角防护与质检标准。',
        '样品与大货是否同规格同材质，能否寄1套核实防摔与清单？',
      ];
      return {
        schema_version: 1,
        contract: 'FactoryInquiryChecklist1688',
        form_id: id,
        auto_send_prohibited: true,
        wangwang_questions: bullets,
        structured_items: bullets.map((question_zh, i) => ({
          slot: i + 1,
          topic: ['spec_parts_material_accessories', 'regular_100_300_shenzhen_quote_lead_time', 'retail_packaging_master_carton_own_box', 'return_cause_and_quality_checks', 'post_sample_verification_and_gaps'][i],
          question_zh,
          includes_package_compression_check: false,
        })),
        copy_paste_message_zh: bullets.map((q, i) => `${i + 1}. ${q}`).join('\n'),
        manual_handoff_note_zh: '仅限主人审看后手动复制发送，AI 严禁代发消息。',
      };
    };

    const runWithFirstBullet = async (firstBullet) => {
      const subDir = mkdtempSync(join(dir, 'run-'));
      const subStore = openSelectionStore(join(subDir, 'sub.sqlite'));
      try {
        const formDef = {
          form_id: formId,
          product_family_key: formId,
          label: baseCand.label,
          buyer_task: 'Organize desktop items with removable tray',
          saleable_set_composition: [{ component_id: 'tray-set', qty_per_saleable_set: 1 }],
        };
        const upserted = subStore.upsertCandidateForm({
          ...formDef,
          lifecycle_status: 'gate1b_queued',
        });
        const candClone = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
          id: formId,
          specSha256: upserted.form.spec_sha256,
          specVersion: upserted.form.spec_version,
          lowPrice: 48.00,
          highPrice: 48.00,
        });
        candClone.economics.expected_primary_scenarios = [{ id: 'sc-high-parts-unknown', status: 'active' }];
        candClone.economics.scenarios = [candClone.economics.scenarios[1]];
        const sc0 = candClone.economics.scenarios[0];
        const fx = 7.2;
        const orderUnits = 100;
        const prodLine = sc0.cost_ledger.lines.find(l => l.id === 'procurement' || l.components?.includes('procurement'));
        const domLine = sc0.cost_ledger.lines.find(l => l.id === 'domestic_freight');
        const goodsCny = Number(((prodLine?.amount_usd ?? 8.317) * fx * orderUnits).toFixed(2));
        const domCny = Number(((domLine?.amount_usd ?? 0) * fx * orderUnits).toFixed(2));
        const quoteRec = subStore.recordSourcingQuote1688({
          quote_id: 'q1688-syn-kit-100',
          form_id: formId,
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'readback:stage5a-syn-quote',
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          ui_readback: {
            logged_in: true,
            viewport_width_px: 1440,
            selected_sku_row_visible: true,
            settlement_bar_visible: true,
            applied_quantity_confirmed: true,
          },
          sku_lines: [{
            offer_id: 'o-stage5a',
            sku_id: 's-stage5a',
            component_id: 'tray-set',
            qty_per_saleable_set: 1,
            pack_multiple: 1,
            moq_qty: orderUnits,
            ordered_qty: orderUnits,
            unit_price_cny: Number((goodsCny / orderUnits).toFixed(4)),
            regular_goods_promo_false: true,
          }],
          actual_sets: orderUnits,
          actual_complete_sets: orderUnits,
          goods_cny_total: goodsCny,
          domestic_freight_cny_total: domCny,
        });
        for (const sc of candClone.economics.scenarios) {
          sc.quote_id = quoteRec.quote.quote_id;
          sc.cost_ledger.fx_cny_per_usd = fx;
          const setLine = (lid, amt) => {
            const line = sc.cost_ledger.lines.find(l => l.id === lid);
            if (line) line.amount_usd = amt;
          };
          setLine('headhaul', 2.5);
          setLine('fulfillment', 6.4791);
          setLine('placement', 0.6);
          setLine('storage', 0.219375);
          const r = sc.cost_ledger.refund_fraction ?? 0.04;
          const nonColAmz = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
            .reduce((s, lid) => s + (sc.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
          setLine('collection', Number((Math.max(0, 48 * (1 - r) - nonColAmz) * (sc.cost_ledger.collection_rate ?? 0.005)).toFixed(6)));
        }
        candClone.factory_inquiry_1688 = makeValidInq(formId, firstBullet);
        const batchOut = await runPhase2Batch(subStore, {
          profile: r59Profile,
          as_of_date: '2026-11-27',
          deep_research_executor: async () => ({
            batch: { schema_version: 1, profile_revision: 59, candidates: [candClone] },
          }),
          items: [
            {
              leads: [{
                lead_id: 'lead-syn-stage5a',
                event_dedup_key: 'reddit:syn-stage5a-tray',
                source_channel: 'reddit',
                entry_group: 'social',
                source_ref: 'https://www.reddit.com/r/organization/comments/stage5asyn',
                phrase_or_title: 'desktop organizer removable tray',
                observed_at: '2026-11-27',
                disposition: 'product',
              }],
              form: formDef,
              gate1a_scenarios: [
                makeGate1AScenario({ id: 'sc-high-parts-unknown', priceUsd: 48.00, fx_cny_per_usd: fx }),
              ],
              early_screen_builder: () => ({
                profile_revision: 59,
                id: 'stage5a-screen',
                saleable_unit: '1 complete tray set',
                price_usd: 48.00,
                fx_cny_per_usd: fx,
                order_units: orderUnits,
                goods_cny_per_unit: Number((goodsCny / orderUnits).toFixed(4)),
                domestic_freight_cny_per_unit: Number((domCny / orderUnits).toFixed(4)),
                first_order_promotion: false,
                goods_first_order_promotion: false,
                headhaul: { usd_per_unit: 2.5, bond_included: true },
                refund_fraction: 0.04,
                physical_return_fraction: 0.04,
                return_threshold: 0.081,
                returns_processing_usd: 0,
                is_apparel_or_shoes: false,
                referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
                fulfillment_usd: 6.4791,
                placement_usd: 0.34,
                storage: { cubic_feet_per_unit: 0.1875, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
                operating_period: 'off_peak',
                operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
                fee_context: {
                  marketplace: 'US',
                  currency: 'USD',
                  package_ref: 'pack-1',
                  sales: { from: '2027-02-01', through: '2027-10-14' },
                  storage: { from: '2027-02-01', through: '2027-09-30' },
                  inbound: { from: '2027-01-15', through: '2027-02-01' },
                },
                collection_rate: 0.006,
                other_applicable_usd: 0,
                specific_rights_conflict: 'unknown',
                strong_date_dependency: false,
              }),
              return_cause_diagnosis_input: {
                target_variant_sku: 'TRAY-STD-1PK',
                reviews: [{ review_id: 'r-pipe-1', stars: 2, variant_sku: 'TRAY-STD-1PK', sku_verified: true, text: 'Corner crushed, returned it.' }],
              },
            },
          ],
          openai_hooks: {
            return_cause_diagnosis: {
              enabled: true,
              responseExecutor: async () => wrapResponsesEnvelope(makeValidDiag(formId)),
            },
            factory_inquiry_1688: {
              enabled: true,
              responseExecutor: async () => wrapResponsesEnvelope(makeValidInq(formId, firstBullet)),
            },
          },
        });
        return { batchOut, evals: subStore.getEvaluationsForForm(formId) };
      } finally {
        subStore.close();
      }
    };

    const r1 = await runWithFirstBullet('请列完整规格、材质、配件，附套装合照。');
    const r2 = await runWithFirstBullet('请列完整规格、材质与所有配件，并附当前套装实物合照。');

    assert.equal(r1.batchOut.gate2_3[0]?.status, 'evaluated', JSON.stringify(r1.batchOut.gate2_3[0]));
    assert.equal(r1.batchOut.gate2_3[0].return_cause_diagnosis?.status, 'ready', JSON.stringify(r1.batchOut.gate2_3[0].return_cause_diagnosis));
    assert.equal(r1.batchOut.gate2_3[0].factory_inquiry_1688?.status, 'ready', JSON.stringify(r1.batchOut.gate2_3[0].factory_inquiry_1688));
    assert.equal(r1.evals.length, r2.evals.length);
    assert.ok(r1.evals.length >= 1);
    assert.equal(
      r1.evals[0].evidence_bundle_sha256,
      r2.evals[0].evidence_bundle_sha256,
      'STD-4: rewording Stage 5A 1688 inquiry bullets must NOT mutate evidence_bundle_sha256',
    );
    assert.equal(
      r1.evals[0].result_sha256,
      r2.evals[0].result_sha256,
      'Stage 5A must NOT mutate deterministic scoring result_sha256',
    );
    assert.notEqual(
      r1.evals[0].html_sha256,
      r2.evals[0].html_sha256,
      'updated Stage 5A inquiry text must render into the generated report HTML',
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
