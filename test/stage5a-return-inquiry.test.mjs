import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import {
  buildBatchJsonl,
  buildWorkflowTaskRequest,
  parseWorkflowTaskResult,
  freezeWorkflowTaskContext,
  RETURN_CAUSE_DIAGNOSIS_JSON_SCHEMA,
  FACTORY_INQUIRY_CHECKLIST_JSON_SCHEMA,
  buildReturnCauseDiagnosisRequest,
  parseReturnCauseDiagnosisResult,
  buildFactoryInquiryChecklistRequest,
  parseFactoryInquiryChecklistResult,
} from '../src/openai/index.mjs';
import { makeStage4OrganizerTrayCandidate } from './helpers/stage4-fixtures.mjs';

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

test('Stage 5A HTML Rendering: renders ② Return-Cause & ③ 5-Bullet 1688 Checklist beneath 拿样／1688 问厂待核清单, scrubs PII/paths, preserves undisputed SHA-256', () => {
  // 1. Undisputed baseline without Stage 5A sections keeps byte-identical origin/main SHA-256
  const c0 = structuredClone(syntheticFixture.candidates[0]);
  if (c0.presentation) {
    delete c0.presentation.hero_image_data_uri;
    delete c0.presentation.contact_sheet_data_uri;
    delete c0.presentation.image_data_uri;
  }
  delete c0.concept_images;
  const b0 = { schema_version: 1, profile_revision: 59, candidates: [c0] };
  const h0 = renderReport(scoreBatch(b0, r59Profile), b0);
  assert.equal(Buffer.byteLength(h0, 'utf8'), 228717);
  assert.equal(
    createHash('sha256').update(h0).digest('hex'),
    'ff183d872261aafe131a7306ae1fab6c6e433ae86509f302358574f6ffff38e5',
  );

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
