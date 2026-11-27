import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSocialBridgeOutput,
  validateSpecMatcherOutput,
  validateSourcingVerifier1688Output,
  validatePainPointAndRubricJudgeOutput,
  assertNoRawPii,
  validateRedactedDestination,
} from '../src/contracts.mjs';
import {
  computeEvidenceBundleHash,
  sha256Hex,
} from '../src/store.mjs';
import {
  importRecoveryLockFile,
  importRequestLedgerFile,
  replayBatchIntoStore,
} from '../src/history-import.mjs';
import {
  runGate1AForForm,
  runGate1BForForm,
  runPhase2Batch,
} from '../src/pipeline.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { FBA_2027_METADATA, getFba2027RateTableSnapshot } from '../src/fba-calculator.mjs';
import {
  openSelectionStoreWithDefaultUiReadback as openSelectionStore,
  withTempDir as _withTempDir,
  withTempDirAsync as _withTempDirAsync,
} from './helpers/test-fixtures.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

const withTempDir = fn => _withTempDir('phase2-test-', fn);
const withTempDirAsync = fn => _withTempDirAsync('phase2-test-', fn);

function makeStandardGate1AScenario(overrides = {}) {
  return {
    profile_revision: 59,
    id: 'off-peak-standard',
    pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
    price_usd: 54.99,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Tools & Home Improvement',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
    headhaul_usd: 2.20,
    collection_rate: 0.006,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-20', through: '2027-02-01' },
    is_apparel: false,
    is_dangerous_goods: false,
    is_sipp: false,
    ...overrides,
  };
}

function alignMockCandidateToQuote(cand, { priceUsd = 54.99, goodsCnyTotal = 10000, domesticFreightCnyTotal = 200, actualSets = 100, fx = 7.0, headhaulUsd = 4.0, fulfillmentUsd = null, placementUsd = 0.34 } = {}) {
  const clone = structuredClone(cand);
  if (clone.screening?.reference_price_usd) {
    clone.screening.reference_price_usd.value = priceUsd;
    if (Array.isArray(clone.screening.reference_price_usd.supported_price_range)) {
      clone.screening.reference_price_usd.supported_price_range = [Math.min(clone.screening.reference_price_usd.supported_price_range[0], priceUsd), Math.max(clone.screening.reference_price_usd.supported_price_range[1], priceUsd)];
    }
  }
  const procUsd = Number(((goodsCnyTotal / actualSets) / fx).toFixed(4));
  const domUsd = Number(((domesticFreightCnyTotal / actualSets) / fx).toFixed(4));
  const resolvedFulUsd = fulfillmentUsd ?? (priceUsd <= 50 ? 5.76495 : 6.3549);
  const allScens = Array.isArray(clone.economics?.operating_periods)
    ? clone.economics.operating_periods.flatMap(p => p.scenarios ?? [])
    : (clone.economics?.scenarios ?? []);
  for (const sc of allScens) {
    if (!sc?.cost_ledger) continue;
    sc.cost_ledger.price_usd = priceUsd;
    sc.cost_ledger.fx_cny_per_usd = fx;
    const pLine = sc.cost_ledger.lines?.find(l => l.id === 'procurement');
    if (pLine) {
      pLine.amount_usd = procUsd;
      pLine.order_units = actualSets;
      pLine.fx_cny_per_usd = fx;
    }
    const dLine = sc.cost_ledger.lines?.find(l => l.id === 'domestic_freight');
    if (dLine) {
      dLine.amount_usd = domUsd;
      dLine.order_units = actualSets;
      dLine.status = 'confirmed';
    }
    const hLine = sc.cost_ledger.lines?.find(l => l.id === 'headhaul');
    if (hLine) {
      hLine.amount_usd = headhaulUsd;
    }
    const fLine = sc.cost_ledger.lines?.find(l => l.id === 'fulfillment');
    if (fLine) {
      fLine.amount_usd = resolvedFulUsd;
    }
    const plLine = sc.cost_ledger.lines?.find(l => l.id === 'placement');
    if (plLine) {
      plLine.amount_usd = placementUsd;
    }
  }
  return clone;
}

function makeEarlyScreenBuilder(priceUsd, goodsCnyPerUnit, domesticFreightCnyPerUnit) {
  return () => ({
    profile_revision: 59,
    id: 'phase2-screen',
    saleable_unit: '1 complete tool set',
    price_usd: priceUsd,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: goodsCnyPerUnit,
    domestic_freight_cny_per_unit: domesticFreightCnyPerUnit,
    first_order_promotion: false,
    goods_first_order_promotion: false,
    headhaul: { usd_per_unit: 2.20, bond_included: true },
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.087,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
    fulfillment_usd: priceUsd <= 50 ? 5.76495 : 6.3549,
    placement_usd: 0.34,
    storage: {
      cubic_feet_per_unit: 0.069444,
      rate_usd_per_cuft_month: 0.78,
      average_inventory_days: 45,
    },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
    fee_context: {
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'pack-1',
      sales: { from: '2027-02-01', through: '2027-09-30' },
      storage: { from: '2027-02-01', through: '2027-09-30' },
      inbound: { from: '2027-01-20', through: '2027-02-01' },
    },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    specific_rights_conflict: 'unknown',
    strong_date_dependency: false,
  });
}

test('Phase 2 Core 5 SQLite objects: WAL persistence, secret/date guards, and 4-way quota ledger', () => {
  withTempDir(dir => {
    const dbPath = join(dir, 'selection.sqlite');
    const store = openSelectionStore(dbPath);
    const summary = store.getSummary();
    assert.deepEqual(Object.keys(summary.counts).sort(), [
      'api_request_ledger',
      'candidate_forms',
      'evaluations',
      'lead_form_links',
      'raw_leads',
      'sourcing_quotes_1688',
    ]);
    assert.equal(summary.queues[0].queue_name, 'gate1b_1688_queue');
    assert.equal(summary.queues[0].status, 'active');

    // Secret-like account_scope and unpinned rolling dates must be rejected.
    assert.throws(() => store.reserveRequestAttempt({
      account_scope: 'sk-live-secret1234567890',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9SYNTH001' },
    }), /non-sensitive/i);

    assert.throws(() => store.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sellersprite',
      tool_name: 'asin_list',
      observation_cutoff_date: 'LAST_30_DAYS',
      params: { categoryId: '123:456' },
    }), /YYYY-MM-DD/);

    // Complete 2 distinct provider requests and confirm 4-way independent quota tracking.
    const r1 = store.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9SYNTH001', timePieceType: 'latelyDay', timePieceValue: '30' },
    });
    assert.equal(r1.allowed, true);
    store.markAttemptInFlight(r1.attempt_id);
    store.completeAttempt(r1.attempt_id, { sif_units: 3, payload_sha256: sha256Hex('ok-sif') });

    const r2 = store.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sellersprite',
      tool_name: 'keyword_batch_info',
      observation_cutoff_date: '2026-11-19',
      params: { keywords: ['router jig'] },
    });
    store.markAttemptInFlight(r2.attempt_id);
    store.completeAttempt(r2.attempt_id, { ss_mcp_units: 1, ss_web_realtime_tasks: 2, payload_sha256: sha256Hex('ok-ss') });

    // Re-requesting the exact same logical key reuses completed attempt at 0 spend.
    const r1Reuse = store.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'mcp__sif__ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      params: { timePieceValue: '30', asin: 'B9SYNTH001', timePieceType: 'latelyDay' },
    });
    assert.equal(r1Reuse.allowed, false);
    assert.equal(r1Reuse.reused, true);
    assert.equal(r1Reuse.attempt_id, r1.attempt_id);

    const quota = store.getQuotaSummary();
    assert.equal(quota.sif_units, 3);
    assert.equal(quota.ss_mcp_units, 1);
    assert.equal(quota.ss_web_realtime_tasks, 2);
    assert.equal(quota.exa_calls, 0);
    store.close();

    // Reopen and verify durable WAL persistence.
    const reopened = openSelectionStore(dbPath);
    assert.equal(reopened.getQuotaSummary().completed_attempts, 2);
    reopened.close();
  });
});

test('Phase 2 Permanent Lock (SIF 101 contract) survives restarts, account aliases, wrapper renames, and pageSize/date tweaks', () => {
  withTempDir(dir => {
    const dbPath = join(dir, 'lock101.sqlite');
    const store = openSelectionStore(dbPath);
    store.recordHistoricalAttempt({
      attempt_id: '101-synth-locked',
      account_scope: 'historical-default',
      provider: 'sif',
      tool_name: 'mcp__sif__ops_get_listing_keyword_distribution',
      observation_cutoff_date: '2026-11-15',
      page_or_cursor: 'page:1',
      params: {
        asin: 'B9SYNTH101',
        country: 'US',
        dimension: 'asin',
        showType: 1,
        timePieceType: 'latelyDay',
        timePieceValue: '30',
        pageNum: 1,
        pageSize: 100,
      },
      status: 'permanently_locked',
      unknown_reserved_sif_units: 2,
      reconciliation_note: 'Permanent synthetic 101 lock',
    });
    store.close();

    // Reopen (simulated restart) and attempt bypasses across wrappers, aliases, pageSize, and date.
    const restarted = openSelectionStore(dbPath);
    // Also test exact Codex Apps registered tool name (with _mcp_) and omitted default country:"US".
    const bypassSpecs = [
      {
        account_scope: 'work-alias',
        provider: 'sif',
        tool_name: 'ops_get_listing_keyword_distribution',
        observation_cutoff_date: '2026-11-20',
        params: { asin: 'b9synth101', country: 'us', dimension: 'asin', showType: 1, timePieceType: 'latelyDay', timePieceValue: 30, pageNum: 1, pageSize: 50 },
      },
      {
        account_scope: 'codex-seat',
        provider: 'sif',
        tool_name: 'mcp__codex_apps__sif_mcp_ops_get_listing_keyword_distribution',
        observation_cutoff_date: '2026-11-25',
        params: { asin: 'B9SYNTH101', timePieceType: 'latelyDay', timePieceValue: '30' },
      },
      {
        account_scope: 'codex-seat-2',
        provider: 'sif',
        tool_name: 'mcp__sif__ops_get_listing_keyword_distribution',
        observation_cutoff_date: '2026-11-26',
        // Omitting default country:"US", dimension, showType, pageNum still hits the exact same 101 lock!
        params: { asin: 'B9SYNTH101', timePieceType: 'latelyDay', timePieceValue: '30' },
      },
    ];
    for (const spec of bypassSpecs) {
      const res = restarted.reserveRequestAttempt(spec);
      assert.equal(res.allowed, false);
      assert.equal(res.reason, 'permanently_locked');
      assert.equal(res.blocking_attempt_id, '101-synth-locked');
    }

    // Cannot unlock a permanently_locked attempt via routine reconciliation.
    assert.throws(() => restarted.reconcileUnknownAttempt('101-synth-locked', {
      resolved_status: 'failed',
      note: 'Attempt to unlock permanent lock',
    }), /permanently_locked/);

    // Genuinely distinct requests (different ASIN, different tool, or different showType) remain allowed.
    const distinctAsin = restarted.reserveRequestAttempt({
      account_scope: 'work-alias',
      provider: 'sif',
      tool_name: 'ops_get_listing_keyword_distribution',
      observation_cutoff_date: '2026-11-20',
      params: { asin: 'B9SYNTH202', country: 'US', dimension: 'asin', showType: 1, timePieceType: 'latelyDay', timePieceValue: '30', pageNum: 1 },
    });
    assert.equal(distinctAsin.allowed, true);

    const distinctTool = restarted.reserveRequestAttempt({
      account_scope: 'work-alias',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-20',
      params: { asin: 'B9SYNTH101', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30' },
    });
    assert.equal(distinctTool.allowed, true);
    assert.equal(restarted.getQuotaSummary().unknown_reserved_sif_units, 2);
    restarted.close();
  });
});

test('Phase 2 Crash Recovery: mid-flight crash blocks duplicate paid send across restart until reconciled', () => {
  withTempDir(dir => {
    const dbPath = join(dir, 'crash.sqlite');
    const store1 = openSelectionStore(dbPath);
    const spec = {
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9CRASH001', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30' },
    };
    const res1 = store1.reserveRequestAttempt(spec);
    assert.equal(res1.allowed, true);
    store1.markAttemptInFlight(res1.attempt_id);
    // Simulate sudden crash BEFORE completeAttempt() is called!
    store1.close();

    // Restart with authoritative controller recovery: marks dangling in_flight as unknown_needs_reconciliation.
    const store2 = openSelectionStore(dbPath, { reconcileOnOpen: true });
    assert.deepEqual(store2.startup_reconciled_attempts, [res1.attempt_id]);
    const attempt = store2.getAttempt(res1.attempt_id);
    assert.equal(attempt.status, 'unknown_needs_reconciliation');
    assert.equal(attempt.repeat_submission_allowed, 0);

    // Blind retry (even on a later date or different wrapper) MUST be blocked!
    const retryBlocked = store2.reserveRequestAttempt({
      ...spec,
      tool_name: 'mcp__sif__ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-20',
    });
    assert.equal(retryBlocked.allowed, false);
    assert.equal(retryBlocked.reason, 'in_flight_or_unknown_reconciliation_required');
    assert.equal(retryBlocked.blocking_attempt_id, res1.attempt_id);

    // After explicit reconciliation confirming the provider never billed or executed it, a fresh send is allowed.
    store2.reconcileUnknownAttempt(res1.attempt_id, {
      resolved_status: 'failed',
      note: 'Verified with provider quota history that request never reached backend.',
    });
    const retryAllowed = store2.reserveRequestAttempt({ ...spec, observation_cutoff_date: '2026-11-20' });
    assert.equal(retryAllowed.allowed, true);
    store2.close();
  });
});

test('Phase 2 Contracts & PII Redaction: rejects raw PII, promo quotes, carton/MOQ errors, and unverified parent reviews', () => {
  // Raw PII detection
  assert.throws(() => assertNoRawPii({ note: '联系手机 13812345678 发货' }), /cn_mobile_number/);
  assert.throws(() => assertNoRawPii({ receiver: '收货人：王小明' }), /receiver_contact_label/);
  assert.throws(() => assertNoRawPii({ addr: '深圳市南山区科技园路88号3栋502室' }), /detailed_street_address/);
  assert.throws(() => assertNoRawPii({ path: 'C:\\Users\\alice\\Desktop\\quote.png' }), /windows_user_path/);
  assert.throws(() => validateRedactedDestination('广东省深圳市南山区科技园路88号'), /detailed_street_address/);
  assert.equal(validateRedactedDestination('广东深圳'), '广东深圳');

  // Contract 1: SocialBridgeExtractor
  const socialValid = validateSocialBridgeOutput({
    schema_version: 1,
    contract: 'SocialBridgeExtractor',
    status: 'extracted',
    platform: 'reddit',
    source_url: 'https://www.reddit.com/r/woodworking/comments/synth123/example/',
    observed_at: '2026-11-19',
    event_dedup_key: 'reddit:synth123',
    verbatim_excerpt: 'Wish there was a cleaner magnetic miter stop gauge.',
    buyer_task: 'Repeatable miter saw stop positioning for woodworking',
    candidate_phrases: ['magnetic miter stop gauge'],
  });
  assert.equal(socialValid.valid, true);
  assert.equal(validateSocialBridgeOutput({
    schema_version: 1,
    contract: 'SocialBridgeExtractor',
    status: 'unknown',
    platform: 'reddit',
    source_ref: 'reddit:synth-unknown',
    observed_at: '2026-11-19',
    event_dedup_key: 'reddit:synth-unknown',
    candidate_phrases: [],
  }).status, 'unknown');

  // Contract 2: SpecMatcher consistency
  assert.throws(() => validateSpecMatcherOutput({
    schema_version: 1,
    contract: 'SpecMatcher',
    verdict: 'mismatch',
    comparable_for_q31: true,
    scope: 'q31_newcomer_pool',
    buyer_task: 'Static indexing block',
    reason: 'Different tool altogether',
    evidence_refs: ['ev-1'],
  }), /mismatch/);
  assert.equal(validateSpecMatcherOutput({
    schema_version: 1,
    contract: 'SpecMatcher',
    verdict: 'unknown',
    comparable_for_q31: 'unknown',
    scope: 'q31_newcomer_pool',
    buyer_task: 'Static indexing block',
    reason: 'Missing product dimensions',
    evidence_refs: [],
  }).verdict, 'unknown');

  // Contract 3: SourcingVerifier1688 carton/MOQ (24/carton MOQ 125 -> 144, not 125!) & promo rejection
  const validSkuLines = [{
    offer_id: 'offer-synth-1',
    sku_id: 'sku-a',
    qty_per_saleable_set: 1,
    pack_multiple: 24,
    moq_qty: 125,
    ordered_qty: 144,
    unit_price_cny: 35.5,
    regular_goods_promo_false: true,
  }];
  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    status: 'verified',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-carton-check',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ ...validSkuLines[0], ordered_qty: 125 }],
    actual_sets: 125,
    actual_complete_sets: 125,
    goods_cny_total: 125 * 35.5,
    domestic_freight_cny_total: 80,
  }), /144/);

  // Rejects first-order promo on verified quote
  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    status: 'verified',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-promo-check',
    goods_first_order_promotion: false,
    freight_first_order_promotion: true,
    sku_lines: validSkuLines,
    actual_sets: 144,
    actual_complete_sets: 144,
    goods_cny_total: 144 * 35.5,
    domestic_freight_cny_total: 0,
  }), /freight_first_order_promotion: false/);

  const okQuote = validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    status: 'verified',
    observed_at: '2026-11-19',
    expires_at: '2026-11-30',
    redacted_destination: '广东深圳',
    redacted_webp_sha256: sha256Hex('redacted-webp-bytes'),
    sensitive_freebie_flags: { oil_or_glue: 'none', battery_type: 'none', strong_magnet: 'none' },
    lead_time_days: 7,
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: validSkuLines,
    actual_sets: 144,
    actual_complete_sets: 144,
    goods_cny_total: 144 * 35.5,
    domestic_freight_cny_total: 96,
  });
  assert.equal(okQuote.valid, true);
  assert.equal(okQuote.order_plan.allocated_sets, 144);
  assert.equal(okQuote.order_plan.actual_complete_sets, 144);

  // Contract 4: PainPointAndRubricJudge parent-review anti-attribution guard
  assert.throws(() => validatePainPointAndRubricJudgeOutput({
    schema_version: 1,
    contract: 'PainPointAndRubricJudge',
    status: 'supported',
    item_id: 'feasible_light_differentiation',
    proposed_score: 0.5,
    evidence_refs: ['rev-batch-1'],
    counter_evidence: [],
    review_citations: [{ review_id: 'R123', sku_verified: 'unknown', excerpt: 'Handle slipped on another size.' }],
  }), /sku_verified: true/);

  const okJudge = validatePainPointAndRubricJudgeOutput({
    schema_version: 1,
    contract: 'PainPointAndRubricJudge',
    status: 'supported',
    item_id: 'feasible_light_differentiation',
    proposed_score: 0.5,
    evidence_refs: ['rev-batch-1'],
    counter_evidence: ['Most 5-star reviews praise stock grip'],
    review_citations: [{ review_id: 'R123', sku_verified: true, variant_sku: 'SIZE-L', excerpt: 'Thumb screw loosens quickly.' }],
  });
  assert.equal(okJudge.valid, true);
});

test('Phase 2 Lead Deduplication, Variant Coexistence, and Immutable Versioned Evaluations', () => {
  const store = openSelectionStore(':memory:');
  store.upsertCandidateForm({
    form_id: 'synth-collet-high-precision',
    product_family_key: 'synth-collet-box',
    label: 'High-precision variant',
    buyer_task: 'Hold CNC cutters at 0.0003" TIR',
    saleable_set_composition: { pieces: 18, grade: 'high' },
    grade_or_material: '0.0003-in TIR',
    lifecycle_status: 'gate1b_rejected',
  });
  store.upsertCandidateForm({
    form_id: 'synth-collet-standard-grade',
    product_family_key: 'synth-collet-box',
    label: 'Standard-precision variant',
    buyer_task: 'Hold workshop router/mill cutters at standard precision',
    saleable_set_composition: { pieces: 18, grade: 'standard' },
    grade_or_material: 'standard-grade',
    lifecycle_status: 'discovered',
  });

  // Two tools report the same discovery event -> second auto-downgrades to corroboration.
  store.upsertRawLead({
    lead_id: 'lead-reddit-1',
    event_dedup_key: 'event:woodshop-stop-42',
    source_channel: 'reddit',
    entry_group: 'social',
    source_ref: 'https://www.reddit.com/r/machinists/comments/42/',
    phrase_or_title: 'precision collet box',
    observed_at: '2026-11-19',
    disposition: 'product',
  });
  store.upsertRawLead({
    lead_id: 'lead-sellersprite-echo',
    event_dedup_key: 'event:woodshop-stop-42',
    source_channel: 'sellersprite',
    entry_group: 'in_site',
    source_ref: 'sellersprite:asin_list:echo',
    phrase_or_title: 'precision collet box',
    observed_at: '2026-11-19',
    disposition: 'product',
  });

  const l1 = store.linkLeadToForm({ lead_id: 'lead-reddit-1', form_id: 'synth-collet-standard-grade', link_role: 'primary_discovery' });
  const l2 = store.linkLeadToForm({ lead_id: 'lead-sellersprite-echo', form_id: 'synth-collet-standard-grade', link_role: 'primary_discovery' });
  assert.equal(l1.link.link_role, 'primary_discovery');
  assert.equal(l2.link.link_role, 'corroboration');

  // Immutable evaluations: same key with different result hash throws; updated fee table inserts a new version!
  const form = store.getCandidateForm('synth-collet-standard-grade');
  const h1 = computeEvidenceBundleHash({
    form_spec_sha256: form.spec_sha256,
    candidate_input: { id: form.form_id, price: 49.99 },
    profile_snapshot: { revision: 58 },
    fee_table_snapshot: { version: '2027-v1' },
  });
  const ev1 = store.recordEvaluation({
    form_id: form.form_id,
    period_id: 'off_peak',
    profile_revision: 59,
    evidence_bundle_sha256: h1,
    qualification: { counts_toward_target: false, mode: 'none' },
    queue_bucket: 'pending',
    covered_weight: 50,
    supported_range: [30, 30],
    total_range: [30, 80],
    result_sha256: sha256Hex('result-v1'),
    html_sha256: sha256Hex('html-v1'),
  });
  assert.equal(ev1.inserted, true);

  // Identical replay is idempotent.
  const ev1Dup = store.recordEvaluation({
    form_id: form.form_id,
    period_id: 'off_peak',
    profile_revision: 59,
    evidence_bundle_sha256: h1,
    qualification: { counts_toward_target: false, mode: 'none' },
    queue_bucket: 'pending',
    covered_weight: 50,
    supported_range: [30, 30],
    total_range: [30, 80],
    result_sha256: sha256Hex('result-v1'),
    html_sha256: sha256Hex('html-v1'),
  });
  assert.equal(ev1Dup.inserted, false);
  assert.equal(ev1Dup.identical, true);

  // Different result hash on identical bundle throws immutability error!
  assert.throws(() => store.recordEvaluation({
    form_id: form.form_id,
    period_id: 'off_peak',
    profile_revision: 59,
    evidence_bundle_sha256: h1,
    qualification: { counts_toward_target: true, mode: 'seasonal_eligible' },
    queue_bucket: 'comparable',
    covered_weight: 100,
    supported_range: [70, 70],
    total_range: [70, 70],
    result_sha256: sha256Hex('mutated-result'),
    html_sha256: sha256Hex('html-v1'),
  }), /immutability violation/i);

  // Fee table update produces a new evidence_bundle_sha256 and preserves both evaluations side by side!
  const h2 = computeEvidenceBundleHash({
    form_spec_sha256: form.spec_sha256,
    candidate_input: { id: form.form_id, price: 49.99 },
    profile_snapshot: { revision: 58 },
    fee_table_snapshot: { version: '2027-v2' },
  });
  assert.notEqual(h1, h2);
  store.recordEvaluation({
    form_id: form.form_id,
    period_id: 'off_peak',
    profile_revision: 59,
    evidence_bundle_sha256: h2,
    qualification: { counts_toward_target: false, mode: 'none' },
    queue_bucket: 'pending',
    covered_weight: 50,
    supported_range: [31, 31],
    total_range: [31, 81],
    result_sha256: sha256Hex('result-v2'),
    html_sha256: sha256Hex('html-v2'),
  });
  assert.equal(store.getEvaluationsForForm(form.form_id).length, 2);
  store.close();
});

test('Phase 2 End-to-End Pipeline: non-Amazon lead Gate 1A 0-call rejection, Gate 1B CAPTCHA_PAUSED non-blocking isolation, and verified resume', async () => {
  await withTempDirAsync(async dir => {
    const dbPath = join(dir, 'pipeline.sqlite');
    const store = openSelectionStore(dbPath);

    // Pre-seed one already-quoted form so it bypasses 1688 and MUST finish Gate 2/3 even when 1688 hits CAPTCHA!
    const preQuotedCand = alignMockCandidateToQuote(fixture.candidates[0], {
      priceUsd: 54.99,
      goodsCnyTotal: 10000,
      domesticFreightCnyTotal: 200,
      actualSets: 100,
      fx: 7.0,
    });
    preQuotedCand.id = 'form-already-quoted';
    store.upsertCandidateForm({
      form_id: 'form-already-quoted',
      product_family_key: 'fam-prequoted',
      label: 'Pre-quoted woodworking jig',
      buyer_task: 'Repeatable router slot cutting',
      saleable_set_composition: { qty: 1 },
      lifecycle_status: 'gate1b_queued',
    });
    store.recordSourcingQuote1688({
      form_id: 'form-already-quoted',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:synth-prequoted',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'o1', sku_id: 's1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 10000,
      domestic_freight_cny_total: 200,
    });

    const sourcingCalls = [];
    const deepResearchCalls = [];

    const batchOut = await runPhase2Batch(store, {
      profile,
      sourcing_executor: async ({ form }) => {
        sourcingCalls.push(form.form_id);
        if (form.form_id === 'form-g1b-reject') {
          // Expensive 1688 quote -> fails <30% margin in Gate 1B, triggers 0 Gate 2/3 calls!
          return {
            status: 'quoted',
            quote: {
              observed_at: '2026-11-19',
              redacted_destination: '广东深圳',
              raw_readback_ref: 'readback:synth-g1b-reject',
              goods_first_order_promotion: false,
              freight_first_order_promotion: false,
              sku_lines: [{ offer_id: 'o-hi', sku_id: 's-hi', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 220, regular_goods_promo_false: true }],
              actual_sets: 100,
              actual_complete_sets: 100,
              goods_cny_total: 22000,
              domestic_freight_cny_total: 500,
            },
          };
        }
        if (form.form_id === 'form-captcha-trigger') {
          return { status: 'captcha_triggered', reason: '1688 slider verification appeared during serial check' };
        }
        throw new Error(`Unexpected sourcing_executor call for ${form.form_id} after CAPTCHA_PAUSED!`);
      },
      deep_research_executor: async ({ form, request }) => {
        deepResearchCalls.push(form.form_id);
        const r = await request({
          account_scope: 'default-us',
          provider: 'sif',
          tool_name: 'ops_get_listing_traffic_overview',
          observation_cutoff_date: '2026-11-19',
          params: { asin: 'B9PREQ0001', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
        }, async () => ({
          payload: { natural_ratio: 0.72 },
          sif_units: 3,
          pagination_complete: true,
        }));
        assert.equal(r.completed, true);
        return {
          batch: { ...structuredClone(fixture), candidates: [preQuotedCand] },
        };
      },
      items: [
        // 1. Independent non-Amazon Reddit lead -> heavy/low-price -> Gate 1A 0-browser elimination!
        {
          leads: [{
            lead_id: 'lead-reddit-heavy',
            event_dedup_key: 'reddit:heavy-vise-1',
            source_channel: 'reddit',
            entry_group: 'social',
            source_ref: 'https://www.reddit.com/r/DIY/comments/heavy1/',
            phrase_or_title: 'heavy cast iron bench clamp',
            raw_excerpt: 'Looking for a budget cast iron clamp around $31',
            observed_at: '2026-11-19',
            disposition: 'product',
          }],
          form: {
            form_id: 'form-social-g1a-dead',
            product_family_key: 'fam-heavy-clamp',
            label: 'Heavy low-price cast-iron clamp',
            buyer_task: 'Clamp heavy timber on workbench',
            saleable_set_composition: { qty: 1 },
          },
          gate1a_scenarios: [makeStandardGate1AScenario({
            price_usd: 31.99,
            pkg: { length_in: 16, width_in: 12, height_in: 6, weight_lb: 12 },
            headhaul_usd: 11.50,
          })],
        },
        // 2. Passes Gate 1A, rejected in Gate 1B (<30% margin) -> 0 Gate 2/3 requests + negotiation shortlist!
        {
          leads: [{
            lead_id: 'lead-1688-factory-1',
            event_dedup_key: '1688:catalog-item-1',
            source_channel: '1688_catalog',
            entry_group: 'factory_catalog',
            source_ref: 'https://detail.1688.com/offer/synth1.html',
            phrase_or_title: 'cnc aluminum stop block',
            observed_at: '2026-11-19',
            disposition: 'product',
          }],
          form: {
            form_id: 'form-g1b-reject',
            product_family_key: 'fam-stop-block',
            label: 'Expensive CNC stop block',
            buyer_task: 'Fence stop positioning',
            saleable_set_composition: { qty: 1 },
          },
          gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
          early_screen_builder: makeEarlyScreenBuilder(54.99, 220, 5),
        },
        // 3. Triggers 1688 CAPTCHA_PAUSED!
        {
          leads: [{
            lead_id: 'lead-yt-1',
            event_dedup_key: 'youtube:vid-99',
            source_channel: 'youtube',
            entry_group: 'social',
            source_ref: 'https://www.youtube.com/watch?v=synth99',
            phrase_or_title: 'router depth gauge',
            observed_at: '2026-11-19',
            disposition: 'product',
          }],
          form: {
            form_id: 'form-captcha-trigger',
            product_family_key: 'fam-depth-gauge',
            label: 'Router depth gauge',
            buyer_task: 'Set router bit height accurately',
            saleable_set_composition: { qty: 1 },
          },
          gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 50.49 })],
          early_screen_builder: makeEarlyScreenBuilder(50.49, 100, 2),
        },
        // 4. Queued behind CAPTCHA -> MUST be skipped without calling sourcing_executor!
        {
          leads: [{
            lead_id: 'lead-pin-1',
            event_dedup_key: 'pinterest:pin-77',
            source_channel: 'pinterest',
            entry_group: 'social',
            source_ref: 'https://www.pinterest.com/pin/synth77/',
            phrase_or_title: 'dovetail marker jig',
            observed_at: '2026-11-19',
            disposition: 'product',
          }],
          form: {
            form_id: 'form-behind-captcha',
            product_family_key: 'fam-dovetail',
            label: 'Dovetail marker jig',
            buyer_task: 'Mark repeatable dovetail angles',
            saleable_set_composition: { qty: 1 },
          },
          gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 44.99 })],
          early_screen_builder: makeEarlyScreenBuilder(44.99, 80, 2),
        },
        // 5. Already quoted -> MUST NOT be blocked by 1688 CAPTCHA_PAUSED and MUST finish Stage 3!
        {
          skip_gate1a_already_quoted: true,
          leads: [{
            lead_id: 'lead-prequoted-1',
            event_dedup_key: 'reddit:prequoted-1',
            source_channel: 'reddit',
            entry_group: 'social',
            source_ref: 'https://www.reddit.com/r/woodworking/comments/prequoted1/',
            phrase_or_title: 'prequoted router slot jig',
            observed_at: '2026-11-19',
            disposition: 'product',
          }],
          form: {
            form_id: 'form-already-quoted',
            product_family_key: 'fam-prequoted',
            label: 'Pre-quoted woodworking jig',
            buyer_task: 'Repeatable router slot cutting',
            saleable_set_composition: { qty: 1 },
          },
          gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
          early_screen_builder: makeEarlyScreenBuilder(54.99, 100, 2),
        },
      ],
    });

    // Assert Gate 1A zero-browser elimination + 0 incremental calls + unbroken lineage back to Reddit lead!
    assert.equal(store.getCandidateForm('form-social-g1a-dead').lifecycle_status, 'gate1a_rejected');
    assert.equal(store.countIncrementalRequestsForForm('form-social-g1a-dead'), 0);
    const deadLineage = store.traceFormLineage('form-social-g1a-dead');
    assert.equal(deadLineage.primary_discovery_leads.length, 1);
    assert.equal(deadLineage.primary_discovery_leads[0].source_channel, 'reddit');

    // Assert Gate 1A attached $49.99/$50.00/$50.01 cliff evaluation for $50.49 item!
    const g1aCliff = batchOut.gate1a.find(x => x.form_id === 'form-captcha-trigger');
    assert.ok(g1aCliff.scenarios[0].price_cliff_50);

    // Assert Gate 1B rejection triggered 0 Gate 2/3 requests and retired negotiation_shortlist in r59!
    assert.equal(store.getCandidateForm('form-g1b-reject').lifecycle_status, 'gate1b_rejected');
    assert.equal(store.countIncrementalRequestsForForm('form-g1b-reject', ['gate2_3']), 0);
    const g1bRej = batchOut.gate1b.find(x => x.form_id === 'form-g1b-reject');
    assert.equal(g1bRej.negotiation_shortlist, null);

    // Assert CAPTCHA_PAUSED immediately stops the r59 batch (Emergency Stop #1: zero calls to form-behind-captcha!)
    assert.deepEqual(sourcingCalls, ['form-g1b-reject', 'form-captcha-trigger']);
    assert.deepEqual(deepResearchCalls, []);
    assert.equal(batchOut.batch_paused, true);
    assert.equal(batchOut.queue_state.status, 'CAPTCHA_PAUSED');
    assert.equal(store.getCandidateForm('form-captcha-trigger').lifecycle_status, 'gate1b_queued');
    assert.equal(store.getCandidateForm('form-behind-captcha').lifecycle_status, 'gate1b_queued');
    store.close();

    // Restart persistence check: CAPTCHA_PAUSED survives restart and requires full verification to resume!
    const reopened = openSelectionStore(dbPath);
    assert.equal(reopened.getQueueState('gate1b_1688_queue').status, 'CAPTCHA_PAUSED');
    assert.throws(() => reopened.resumeQueue('gate1b_1688_queue', {
      login_verified: false,
      destination_city: '广东深圳',
      quantity: 100,
      sku_id: 's1',
      quote_validity: '2026-12-31',
    }), /login_verified/);
    assert.throws(() => reopened.resumeQueue('gate1b_1688_queue', {
      login_verified: true,
      destination_city: '广东省深圳市科技园路88号',
      quantity: 100,
      sku_id: 's1',
      quote_validity: '2026-12-31',
    }), /detailed_street_address/);

    const resumed = reopened.resumeQueue('gate1b_1688_queue', {
      login_verified: true,
      form_id: 'form-captcha-trigger',
      destination_city: '广东深圳',
      quantity: 100,
      sku_id: 'sku-depth-gauge',
      quote_validity: '2027-12-31',
    }, { as_of_date: '2026-11-19' });
    assert.equal(resumed.status, 'active');
    reopened.close();
  });
});

test('Phase 2 CLI real entry point: init, replay synthetic r58 batch, status, trace, and resume-1688', async () => {
  await withTempDirAsync(async dir => {
    const dbPath = join(dir, 'cli.sqlite');
    const run = async args => {
      let stdout = '';
      let stderr = '';
      const code = await runPhase2Cli(args, {
        stdout: { write: s => { stdout += s; } },
        stderr: { write: s => { stderr += s; } },
      });
      return { code, stdout, stderr };
    };

    const initOut = await run(['init', '--db', dbPath]);
    assert.equal(initOut.code, 0, initOut.stderr);
    assert.equal(JSON.parse(initOut.stdout).ok, true);

    const replayOut = await run([
      'replay',
      '--db', dbPath,
      '--batch', 'fixtures/synthetic-batch.json',
      '--profile', 'docs/design/reference-profile.r59.draft.json',
    ]);
    assert.equal(replayOut.code, 0, replayOut.stderr);
    const replayJson = JSON.parse(replayOut.stdout);
    assert.equal(replayJson.evaluations_recorded, 3);

    const statusOut = await run(['status', '--db', dbPath]);
    assert.equal(statusOut.code, 0, statusOut.stderr);
    assert.equal(JSON.parse(statusOut.stdout).summary.counts.evaluations, 3);

    const traceOut = await run(['trace', '--db', dbPath, '--form', fixture.candidates[0].id]);
    assert.equal(traceOut.code, 0, traceOut.stderr);
    assert.equal(JSON.parse(traceOut.stdout).lineage.evaluations.length, 1);

    const resumeOut = await run([
      'resume-1688',
      '--db', dbPath,
      '--login-verified',
      '--city', '广东深圳',
      '--quantity', '100',
      '--sku', 'sku-cli-1',
      '--validity', '2027-12-31',
      '--as-of', '2026-11-19',
    ]);
    assert.equal(resumeOut.code, 0, resumeOut.stderr);
    assert.equal(JSON.parse(resumeOut.stdout).queue_state.status, 'active');
  });
});

test('Phase 2 Local Historical Recovery & Ledger Import (when local .local/ trials exist)', () => {
  const recoveryPath = new URL('../.local/trials/20261115-next-cards/request-recovery.json', import.meta.url);
  const ledger20261116 = new URL('../.local/trials/20261116-next-cards/request-ledger.json', import.meta.url);
  if (!existsSync(recoveryPath)) return; // Clean CI clone without .local/

  withTempDir(dir => {
    const dbPath = join(dir, 'local-replay.sqlite');
    const store = openSelectionStore(dbPath);

    // 1. Import real request-recovery.json and confirm 101 lock survives restart + alias + wrapper swap!
    const rec = importRecoveryLockFile(store, recoveryPath);
    assert.equal(rec.status, 'permanently_locked');
    assert.equal(rec.unknown_reserved_sif_units, 2);

    if (existsSync(ledger20261116)) {
      const ledRes = importRequestLedgerFile(store, ledger20261116);
      assert.ok(ledRes.total_entries >= 100);
      // Re-import is strictly idempotent.
      const ledRes2 = importRequestLedgerFile(store, ledger20261116);
      assert.equal(ledRes2.inserted, 0);
    }
    store.close();

    // 2. Reopen after restart and confirm real 101 lock still blocks alternative wrapper & alias!
    const recoveryRaw = JSON.parse(readFileSync(recoveryPath, 'utf8'));
    const reopened = openSelectionStore(dbPath);
    const blocked = reopened.reserveRequestAttempt({
      account_scope: 'alt-account-alias',
      provider: 'sif',
      tool_name: 'mcp__codex_apps__sif_mcp_ops_get_listing_keyword_distribution',
      observation_cutoff_date: '2026-11-19',
      params: { ...recoveryRaw.original_request.args, country: undefined, pageSize: 20 },
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'permanently_locked');
    assert.equal(blocked.blocking_attempt_id, recoveryRaw.original_request.id);
    reopened.close();
  });
});

test('Phase 2 Gate 1A never zero-browser rejects when fee lookup returns needs_calculator_verification', () => {
  const store = openSelectionStore(':memory:');
  store.upsertCandidateForm({
    form_id: 'form-bulky-unknown',
    product_family_key: 'fam-bulky',
    label: 'Oversize shelving unit',
    buyer_task: 'Garage storage shelving',
    saleable_set_composition: { qty: 1 },
  });
  const res = runGate1AForForm(store, {
    form_id: 'form-bulky-unknown',
    profile_revision: 59,
    scenarios: [makeStandardGate1AScenario({
      price_usd: 49.99,
      sales_window: { from: '2027-10-15', through: '2027-12-31' },
      pkg: { length_in: 30, width_in: 20, height_in: 10, weight_lb: 25 },
    })],
  });
  assert.equal(res.gate_status, 'gate1a_needs_verification');
  assert.equal(store.getCandidateForm('form-bulky-unknown').lifecycle_status, 'gate1a_needs_verification');
  store.close();
});


test('Round-1 Codex Regressions #2, #3, #5, #6: default pagination dedup, cached payload return, error status, crash reserve preservation, read-only status, and forced fresh_observation', async () => {
  await withTempDirAsync(async dir => {
    const dbPath = join(dir, 'r1-ledger.sqlite');
    const store = openSelectionStore(dbPath);
    let calls = 0;

    // #2a: Omitting default pageNum:1 vs supplying pageNum:1 must bill ONCE and return cached payload (40) + artifact path!
    const specNoPage = {
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_keyword_distribution',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9DEDUP001', timePieceType: 'latelyDay', timePieceValue: '30', showType: 1 },
    };
    const first = await store.executeGuardedRequest(specNoPage, async () => {
      calls++;
      return { payload: { total: 40 }, sif_units: 2, raw_artifact_path: '.local/tmp/ok.json' };
    });
    assert.equal(first.completed, true);
    assert.equal(first.payload.total, 40);

    const second = await store.executeGuardedRequest({
      ...specNoPage,
      params: { ...specNoPage.params, country: 'US', dimension: 'asin', pageNum: 1 },
    }, async () => {
      calls++;
      return { payload: { total: 999 }, sif_units: 2 };
    });
    assert.equal(calls, 1);
    assert.equal(second.reused, true);
    assert.equal(second.payload.total, 40);
    assert.equal(second.raw_artifact_path, '.local/tmp/ok.json');
    assert.equal(store.getQuotaSummary().sif_units, 2);

    // #2b: Executor returning { isError: true } must NOT be recorded as completed!
    const errOut = await store.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sellersprite',
      tool_name: 'keyword_trend',
      observation_cutoff_date: '2026-11-19',
      params: { keyword: 'synth test err' },
    }, async () => ({ isError: true, error: 'Rate limit reached for 13812345678' }));
    assert.equal(errOut.completed, false);
    assert.equal(errOut.status, 'unknown_needs_reconciliation');
    const errAttempt = store.getAttempt(errOut.attempt_id);
    assert.equal(errAttempt.status, 'unknown_needs_reconciliation');
    // #15: Phone number in error message must be scrubbed from reconciliation_note!
    assert.equal(errAttempt.reconciliation_note.includes('13812345678'), false);

    // #6: historical_replay mode must NEVER invoke live executor when uncached!
    let liveInvoked = false;
    await assert.rejects(() => store.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sif',
      mode: 'historical_replay',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9REPLAY01' },
    }, async () => {
      liveInvoked = true;
      return { payload: { x: 1 } };
    }), /historical_replay/);
    assert.equal(liveInvoked, false);

    // #3: Pre-reserved estimated_sif_units (5) survives crash recovery, AND read-only CLI status does NOT disturb an active in_flight request!
    const inflightRes = store.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      estimated_sif_units: 5,
      params: { asin: 'B9INFLIGHT1', timePieceType: 'latelyDay', timePieceValue: '30' },
    });
    store.markAttemptInFlight(inflightRes.attempt_id);

    // Read-only CLI status & trace MUST NOT flip in_flight to unknown_needs_reconciliation!
    let statusStdout = '';
    const statusCode = await runPhase2Cli(['status', '--db', dbPath], {
      stdout: { write: s => { statusStdout += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(statusCode, 0);
    assert.equal(JSON.parse(statusStdout).summary.quota.active_attempts, 1);
    assert.equal(store.getAttempt(inflightRes.attempt_id).status, 'in_flight');
    store.close();

    // Now simulate actual controller crash recovery on reopen -> unknown_reserved_sif_units MUST be 5!
    const recovered = openSelectionStore(dbPath, { reconcileOnOpen: true });
    assert.deepEqual(recovered.startup_reconciled_attempts, [inflightRes.attempt_id]);
    assert.equal(recovered.getAttempt(inflightRes.attempt_id).unknown_reserved_sif_units, 5);
    assert.equal(recovered.getQuotaSummary().unknown_reserved_sif_units, 5);
    recovered.close();
  });
});

test('Round-1 Codex Regressions #7, #8, #9, #10, #11, #12: Gate 1A/1B hard gates, authoritative quote injection, multi-scenario pass, component coverage, serial lease, negotiation persistence, and strict candidate matching', async () => {
  const store = openSelectionStore(':memory:');

  // #7a: minimum_price_usd < 29.99 throws TypeError
  store.upsertCandidateForm({
    form_id: 'f-low-floor',
    product_family_key: 'fam-low',
    label: 'Low price test',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  assert.throws(() => runGate1AForForm(store, {
    form_id: 'f-low-floor',
    minimum_price_usd: 0,
    scenarios: [makeStandardGate1AScenario({ price_usd: 25 })],
  }), /29\.99/);

  // #7b: Direct runGate1BForForm on gate1a_rejected form MUST NOT browse 1688
  runGate1AForForm(store, {
    form_id: 'f-low-floor',
    specific_rights_conflict: true,
    scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
  });
  let browsed = 0;
  const blockedG1B = await runGate1BForForm(store, {
    form_id: 'f-low-floor',
    sourcing_executor: async () => { browsed++; return { status: 'no_matched_offer' }; },
    early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 2),
  });
  assert.equal(browsed, 0);
  assert.equal(blockedG1B.status, 'blocked_by_gate1a');

  // #8a: Forged early_screen_builder trying to pass ¥1 when persisted quote is ¥222 MUST still reject!
  store.upsertCandidateForm({
    form_id: 'f-forge-cost',
    product_family_key: 'fam-forge',
    label: 'Expensive quote form',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  runGate1AForForm(store, {
    form_id: 'f-forge-cost',
    scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
  });
  store.recordSourcingQuote1688({
    form_id: 'f-forge-cost',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-forge',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'o1', sku_id: 's1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 222, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 22200,
    domestic_freight_cny_total: 0,
  });
  const storedExpQuote = store.getQuotesForForm('f-forge-cost')[0];
  // Omitting early_screen_builder must park pending, never pass!
  const noBuilderRes = await runGate1BForForm(store, {
    form_id: 'f-forge-cost',
    existing_quote: storedExpQuote,
  });
  assert.equal(noBuilderRes.proceed_to_gate2_3, false);
  assert.equal(noBuilderRes.status, 'gate1b_pending');

  // Builder trying to forge goods_cny_per_unit: 1 is overridden by authoritative ¥222 persisted quote!
  const forgedRes = await runGate1BForForm(store, {
    form_id: 'f-forge-cost',
    profile_revision: 59,
    existing_quote: storedExpQuote,
    early_screen_builder: makeEarlyScreenBuilder(54.99, 1, 0),
  });
  assert.equal(forgedRes.status, 'gate1b_rejected');
  assert.equal(forgedRes.proceed_to_gate2_3, false);
  // #11a: Under r59, negotiation_shortlist is retired (null in traceFormLineage)!
  assert.equal(store.traceFormLineage('f-forge-cost').negotiation_shortlist, null);

  // #8b (P0-1 upgraded): Multi-scenario Gate 1B ($40 fail + $60 pass) crosses 30%:
  // MUST NOT falsely reject AND MUST NOT blindly auto-pass; parks pending with owner_review_required!
  store.upsertCandidateForm({
    form_id: 'f-multi-scen',
    product_family_key: 'fam-multi',
    label: 'Multi-scenario form',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  runGate1AForForm(store, {
    form_id: 'f-multi-scen',
    scenarios: [
      makeStandardGate1AScenario({ id: 'p40', price_usd: 40 }),
      makeStandardGate1AScenario({ id: 'p60', price_usd: 60 }),
    ],
  });
  const qMulti = store.recordSourcingQuote1688({
    form_id: 'f-multi-scen',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-multi',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'o2', sku_id: 's2', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 10000,
    domestic_freight_cny_total: 200,
  }).quote;
  const multiRes = await runGate1BForForm(store, {
    form_id: 'f-multi-scen',
    profile_revision: 59,
    existing_quote: qMulti,
    early_screen_builder: ({ order_plan }) => {
      // #10: Reusing cached verified quote MUST pass a recomputed non-null order_plan!
      assert.ok(order_plan && order_plan.allocated_sets === 100);
      return [
        makeEarlyScreenBuilder(40, 100, 2)(),
        makeEarlyScreenBuilder(60, 100, 2)(),
      ];
    },
  });
  assert.equal(multiRes.status, 'gate1b_pending');
  assert.equal(multiRes.margin_interval_verdict, 'crosses_30pct');
  assert.equal(multiRes.second_factory_quote_needed, true);
  assert.equal(multiRes.owner_crossing_override, false);
  assert.equal(multiRes.proceed_to_gate2_3, false);
  assert.deepEqual(multiRes.passing_prices_usd, [60]);
  assert.deepEqual(multiRes.failing_prices_usd, [40]);

  // All-passing multi-scenario ($54.99 + $60) cleanly returns gate1b_passed with all_ge_30pct!
  store.upsertCandidateForm({
    form_id: 'f-multi-allpass',
    product_family_key: 'fam-multi-allpass',
    label: 'Multi-scenario all-pass form',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  runGate1AForForm(store, {
    form_id: 'f-multi-allpass',
    profile_revision: 59,
    scenarios: [
      makeStandardGate1AScenario({ id: 'p55', price_usd: 54.99 }),
      makeStandardGate1AScenario({ id: 'p60', price_usd: 60 }),
    ],
  });
  const qMultiPass = store.recordSourcingQuote1688({
    form_id: 'f-multi-allpass',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-multi-allpass',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'o2p', sku_id: 's2p', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 10000,
    domestic_freight_cny_total: 200,
  }).quote;
  const multiAllPassRes = await runGate1BForForm(store, {
    form_id: 'f-multi-allpass',
    profile_revision: 59,
    existing_quote: qMultiPass,
    early_screen_builder: () => [
      makeEarlyScreenBuilder(54.99, 100, 2)(),
      makeEarlyScreenBuilder(60, 100, 2)(),
    ],
  });
  assert.equal(multiAllPassRes.status, 'gate1b_passed');
  assert.equal(multiAllPassRes.margin_interval_verdict, 'all_ge_30pct');
  assert.equal(multiAllPassRes.proceed_to_gate2_3, true);

  // #11b: Strong date dependency ('deferred' from evaluateEarlyScreen) persists as lifecycle_status = 'deferred'!
  store.upsertCandidateForm({
    form_id: 'f-date-def',
    product_family_key: 'fam-def',
    label: 'Holiday form',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  runGate1AForForm(store, {
    form_id: 'f-date-def',
    profile_revision: 59,
    scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
  });
  const qDef = store.recordSourcingQuote1688({
    form_id: 'f-date-def',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-def',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'o3', sku_id: 's3', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 8000,
    domestic_freight_cny_total: 100,
  }).quote;
  const defRes = await runGate1BForForm(store, {
    form_id: 'f-date-def',
    profile_revision: 59,
    existing_quote: qDef,
    early_screen_builder: () => ({ ...makeEarlyScreenBuilder(54.99, 80, 1)(), strong_date_dependency: true }),
  });
  assert.equal(defRes.status, 'deferred');
  assert.equal(store.getCandidateForm('f-date-def').lifecycle_status, 'deferred');

  // #9: Component completeness, exact cent parity (199.99 vs 200.00), and pending quote nullable freight
  store.upsertCandidateForm({
    form_id: 'f-two-comp',
    product_family_key: 'fam-two',
    label: 'Two-component set',
    buyer_task: 'Task',
    saleable_set_composition: {
      components: [
        { component_id: 'comp-A', qty_per_saleable_set: 1 },
        { component_id: 'comp-B', qty_per_saleable_set: 1 },
      ],
    },
  });
  assert.throws(() => store.recordSourcingQuote1688({
    form_id: 'f-two-comp',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-two-comp',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'oA', sku_id: 'comp-A', component_id: 'comp-A', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 2, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 200,
    domestic_freight_cny_total: 10,
  }), /missing required saleable-set component "comp-B"/);

  // Rejects 199.99 when exact 100 * 2.00 = 200.00
  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    status: 'verified',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-parity',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'oA', sku_id: 'sA', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 2, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 199.99,
    domestic_freight_cny_total: 10,
  }), /disagrees/);

  // Pending quote with domestic_freight_cny_total: null succeeds cleanly!
  const pendingQ = store.recordSourcingQuote1688({
    form_id: 'f-two-comp',
    quote_status: 'pending',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'oA', sku_id: 'comp-A', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 2, regular_goods_promo_false: true }],
    goods_cny_total: 200,
    domestic_freight_cny_total: null,
  });
  assert.equal(pendingQ.quote.quote_status, 'pending');
  assert.equal(pendingQ.quote.domestic_freight_cny_total, null);

  // #10: Expired quote_validity (2001-01-01) and wrong paused_form_id rejected on resumeQueue; duplicate form_id rejected in runPhase2Batch!
  store.pauseQueue('gate1b_1688_queue', 'captcha', { paused_form_id: 'f-multi-scen', paused_sku_hint: 's2' });
  assert.throws(() => store.resumeQueue('gate1b_1688_queue', {
    login_verified: true,
    form_id: 'f-multi-scen',
    destination_city: '广东深圳',
    quantity: 100,
    sku_id: 's2',
    quote_validity: '2001-01-01',
  }, { as_of_date: '2026-11-19' }), /expired/);
  assert.throws(() => store.resumeQueue('gate1b_1688_queue', {
    login_verified: true,
    form_id: 'wrong-form',
    destination_city: '广东深圳',
    quantity: 100,
    sku_id: 's2',
    quote_validity: '2027-01-01',
  }, { as_of_date: '2026-11-19' }), /paused_form_id/);
  store.resumeQueue('gate1b_1688_queue', {
    login_verified: true,
    form_id: 'f-multi-scen',
    destination_city: '广东深圳',
    quantity: 100,
    sku_id: 's2',
    quote_validity: '2027-01-01',
  }, { as_of_date: '2026-11-19' });

  await assert.rejects(() => runPhase2Batch(store, {
    profile,
    items: [
      { form: { form_id: 'dup-1', label: 'A', buyer_task: 'T', saleable_set_composition: { qty: 1 } }, gate1a_scenarios: [makeStandardGate1AScenario()] },
      { form: { form_id: 'dup-1', label: 'A', buyer_task: 'T', saleable_set_composition: { qty: 1 } }, gate1a_scenarios: [makeStandardGate1AScenario()] },
    ],
  }), /Duplicate form_id/);

  // #12: Same source_ref URL with rewritten titles deduplicates to 1 primary_discovery + 1 corroboration!
  store.upsertRawLead({
    lead_id: 'url-lead-1',
    source_channel: 'reddit',
    source_ref: 'https://www.reddit.com/r/tools/comments/abc999/?utm_source=share',
    phrase_or_title: 'first tool title',
    observed_at: '2026-11-19',
    disposition: 'product',
  });
  store.upsertRawLead({
    lead_id: 'url-lead-2',
    source_channel: 'exa',
    source_ref: 'https://www.reddit.com/r/tools/comments/abc999/#top',
    phrase_or_title: 'completely rewritten title',
    observed_at: '2026-11-19',
    disposition: 'product',
  });
  const lk1 = store.linkLeadToForm({ lead_id: 'url-lead-1', form_id: 'f-multi-scen', link_role: 'primary_discovery' });
  const lk2 = store.linkLeadToForm({ lead_id: 'url-lead-2', form_id: 'f-multi-scen', link_role: 'primary_discovery' });
  assert.equal(lk1.link.link_role, 'primary_discovery');
  assert.equal(lk2.link.link_role, 'corroboration');

  // #12: delivery_only lead blocked from Gate 2/3, AND mismatched candidate B under form A is isolated while sibling B completes!
  const candB = structuredClone(fixture.candidates[0]);
  candB.id = 'cand-B-wrong';
  const candHealthyB = alignMockCandidateToQuote(fixture.candidates[0], {
    priceUsd: 54.99,
    goodsCnyTotal: 8000,
    domesticFreightCnyTotal: 100,
    actualSets: 100,
    fx: 7.0,
  });
  candHealthyB.id = 'form-B-healthy';
  const batchDeliveryOnly = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-19',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:synth-deliv',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oD', sku_id: 'sD', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async () => ({ batch: { ...structuredClone(fixture), candidates: [candB] } }),
    items: [{
      leads: [{
        lead_id: 'lead-deliv-only',
        source_channel: 'reddit',
        source_ref: 'https://www.reddit.com/r/tools/comments/deliv1/',
        phrase_or_title: 'prime fast shipping',
        observed_at: '2026-11-19',
        disposition: 'delivery_only',
      }],
      form: { form_id: 'form-deliv-only', label: 'Deliv only', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
      early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
    }],
  });
  assert.equal(batchDeliveryOnly.gate2_3[0].status, 'blocked_inadmissible_leads');
  assert.equal(store.getEvaluationsForForm('form-deliv-only').length, 0);

  const isolatedStage3 = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-19',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:synth-mismatch',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oM', sku_id: 'sM', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async ({ form }) => ({
      batch: { ...structuredClone(fixture), candidates: [form.form_id === 'form-A-strict' ? candB : candHealthyB] },
    }),
    items: [
      {
        leads: [{
          lead_id: 'lead-mismatch-A',
          source_channel: 'reddit',
          source_ref: 'https://www.reddit.com/r/tools/comments/mismatchA/',
          phrase_or_title: 'actual product A',
          observed_at: '2026-11-19',
          disposition: 'product',
        }],
        form: { form_id: 'form-A-strict', label: 'Form A', buyer_task: 'Task A', saleable_set_composition: { qty: 1 } },
        gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
        early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
      },
      {
        leads: [{
          lead_id: 'lead-healthy-B',
          source_channel: 'reddit',
          source_ref: 'https://www.reddit.com/r/tools/comments/healthyB/',
          phrase_or_title: 'actual product B',
          observed_at: '2026-11-19',
          disposition: 'product',
        }],
        form: { form_id: 'form-B-healthy', label: 'Form B', buyer_task: 'Task B', saleable_set_composition: { qty: 1 } },
        gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
        early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
      },
    ],
  });
  const stage3A = isolatedStage3.gate2_3.find(x => x.form_id === 'form-A-strict');
  const stage3B = isolatedStage3.gate2_3.find(x => x.form_id === 'form-B-healthy');
  assert.equal(stage3A.status, 'gate2_3_error');
  assert.match(stage3A.error, /matching form_id "form-A-strict"/);
  assert.equal(store.getEvaluationsForForm('form-A-strict').length, 0);
  assert.equal(store.getCandidateForm('form-A-strict').lifecycle_status, 'gate1b_pending');
  assert.equal(stage3B.status, 'evaluated');
  assert.equal(store.getEvaluationsForForm('form-B-healthy').length, 1);
  assert.equal(store.getCandidateForm('form-B-healthy').lifecycle_status, 'evaluated');

  store.close();
});

test('Round-1 Codex Regressions #13, #14, #15: live FBA table hash, single-vs-batch replay parity, non-destructive replay, and expanded PII/token guards', () => {
  // #15: Expanded PII & credential guards
  assert.throws(() => assertNoRawPii({ mobile: 13812345678 }), /mobile/);
  assert.throws(() => assertNoRawPii({ note: 13812345678 }), /cn_mobile_number/);
  assert.throws(() => assertNoRawPii({ note: '深圳座机 0755 88888888' }), /cn_landline_number/);
  assert.throws(() => assertNoRawPii({ receiver_name: '张伟' }), /receiver_name/);
  assert.throws(() => assertNoRawPii({ addr: '南山区科技园路八十八号' }), /detailed_street_address/);

  const store = openSelectionStore(':memory:');
  assert.throws(() => store.reserveRequestAttempt({
    account_scope: 'ghp_1234567890abcdef1234567890abcdef',
    provider: 'sif',
    tool_name: 'ping',
    observation_cutoff_date: '2026-11-19',
  }), /non-sensitive/i);

  store.upsertCandidateForm({
    form_id: 'f-pii-quote-id',
    product_family_key: 'fam-pii',
    label: 'PII test',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  assert.throws(() => store.recordSourcingQuote1688({
    quote_id: 'C:\\Users\\alice\\quote.json',
    form_id: 'f-pii-quote-id',
    observed_at: '2026-11-19',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:synth-pii',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'o1', sku_id: 's1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 10, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 1000,
    domestic_freight_cny_total: 50,
  }), /windows_user_path/);

  // #13a: Live FBA rate table snapshot changes hash immediately when any rate cell changes!
  const snap1 = structuredClone(getFba2027RateTableSnapshot());
  const snap2 = structuredClone(getFba2027RateTableSnapshot());
  snap2.small_standard_2027_oz[0]['10_to_50'] = 3.85;
  const hash1 = computeEvidenceBundleHash({ form_spec_sha256: 'abc', candidate_input: { id: 'x' }, profile_snapshot: { revision: 58 }, fee_table_snapshot: snap1 });
  const hash2 = computeEvidenceBundleHash({ form_spec_sha256: 'abc', candidate_input: { id: 'x' }, profile_snapshot: { revision: 58 }, fee_table_snapshot: snap2 });
  assert.notEqual(hash1, hash2);

  // #13b & #14: Replaying candidate #2 alone then the full 3-card fixture succeeds without immutability error,
  // AND preserves pre-existing live candidate_forms grade/lifecycle untouched!
  const secondCandId = fixture.candidates[1].id;
  store.upsertCandidateForm({
    form_id: secondCandId,
    product_family_key: secondCandId,
    label: 'Live spec preserved',
    buyer_task: 'Live buyer task',
    saleable_set_composition: { qty: 1 },
    grade_or_material: 'hardened-steel',
    target_child_asin: 'B9LIVE0001',
    lifecycle_status: 'gate1a_rejected',
  });
  const singleBatch = { ...structuredClone(fixture), candidates: [structuredClone(fixture.candidates[1])] };
  replayBatchIntoStore(store, { batch: singleBatch, profile });
  replayBatchIntoStore(store, { batch: structuredClone(fixture), profile });
  assert.equal(store.getEvaluationsForForm(secondCandId).length, 1);
  const preserved = store.getCandidateForm(secondCandId);
  assert.equal(preserved.grade_or_material, 'hardened-steel');
  assert.equal(preserved.target_child_asin, 'B9LIVE0001');
  assert.equal(preserved.lifecycle_status, 'gate1a_rejected');
  store.close();
});

test('Round-2 Codex Regressions #1, #2, #3: receipt charge extraction, CLI format rejection, SIF defaults, no_retry on completed, order-invariant recovery ID, non-interfering open, unknown-billing reserve, null outcome, and incremental count', async () => {
  await withTempDirAsync(async dir => {
    // R2-1: Unrecognized ledger format (e.g. passing a recovery lock file to --ledger) MUST fail cleanly!
    const fakeRecPath = join(dir, 'fake-recovery.json');
    const fakeRawDir = join(dir, 'raw');
    const fakeLedgerPath = join(dir, 'fake-ledger.json');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(fakeRawDir, { recursive: true });
    writeFileSync(fakeRecPath, JSON.stringify({
      original_request: {
        id: '101-synth-rec',
        tool: 'mcp__sif__ops_get_listing_keyword_distribution',
        started_at: '2026-11-15T10:00:00Z',
        args: { asin: 'B9REC101', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', pageNum: 1 },
      },
      provider: 'sif',
      repeat_submission_allowed: false,
      execution_outcome: 'unknown',
      billing_outcome: 'unknown',
      distinct_batch_reconciliation_20261116: { extra_unknown_reservation_points: 2 },
    }), 'utf8');
    // Raw receipts: 1 SIF (costThisCall: 3 inside MCP text JSON), 1 SS MCP (chargedUnits: 4), 1 raw isError:true
    writeFileSync(join(fakeRawDir, 'r-sif.json'), JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ _quota: { costThisCall: 3 }, data: { ok: true } }) }],
    }), 'utf8');
    writeFileSync(join(fakeRawDir, 'r-ss.json'), JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ billing: { chargedUnits: 4 }, items: [] }) }],
    }), 'utf8');
    writeFileSync(join(fakeRawDir, 'r-err.json'), JSON.stringify({
      isError: true,
      content: [{ type: 'text', text: 'Upstream validation failed' }],
    }), 'utf8');
    writeFileSync(fakeLedgerPath, JSON.stringify({
      requests: [
        { id: 'r-sif', tool: 'mcp__sif__ops_get_listing_traffic_overview', status: 'response_saved', started_at: '2026-11-15T11:00:00Z', args: { asin: 'B9CH01', timePieceType: 'latelyDay', timePieceValue: '30' }, no_retry: true },
        { id: 'r-ss', tool: 'mcp__sellersprite__asin_list', status: 'returned_saved', started_at: '2026-11-15T11:01:00Z', args: { marketplace: 'US', categoryId: '999' } },
        { id: 'r-web', provider: 'sellersprite', tool: 'sellersprite_web_realtime', status: 'response_saved', started_at: '2026-11-15T11:02:00Z', billing: { unit: 'website new-task opportunity', quantity: 1 }, args: { keyword: 'synth' } },
        { id: 'r-err', tool: 'mcp__sellersprite__keyword_trend', status: 'response_received', started_at: '2026-11-15T11:03:00Z', args: { keyword: 'bad' } },
        { id: '101-synth-rec', tool: 'mcp__sif__ops_get_listing_keyword_distribution', status: 'unknown', started_at: '2026-11-15T10:00:00Z', args: { asin: 'B9REC101', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', pageNum: 1 } },
      ],
    }), 'utf8');

    const dbPath = join(dir, 'r2-1.sqlite');
    let cliStderr = '';
    const badCliCode = await runPhase2Cli(['import-history', '--db', dbPath, '--ledger', fakeRecPath], {
      stdout: { write: () => {} },
      stderr: { write: s => { cliStderr += s; } },
    });
    assert.equal(badCliCode, 2);
    assert.match(cliStderr, /Unrecognized request ledger format/i);

    // R2-1 & R2-2: Import ledger FIRST then recovery SECOND vs recovery FIRST then ledger SECOND must yield identical physical attempt_id, source_ledger_ref, and charges!
    const sFwd = openSelectionStore(':memory:');
    importRecoveryLockFile(sFwd, fakeRecPath, { repoRoot: dir });
    importRequestLedgerFile(sFwd, fakeLedgerPath, { repoRoot: dir });

    const sRev = openSelectionStore(':memory:');
    importRequestLedgerFile(sRev, fakeLedgerPath, { repoRoot: dir });
    importRecoveryLockFile(sRev, fakeRecPath, { repoRoot: dir });

    assert.equal(sFwd.getQuotaSummary().total_attempts, 5);
    assert.equal(sRev.getQuotaSummary().total_attempts, 5);
    assert.equal(sFwd.getQuotaSummary().sif_units, 3);
    assert.equal(sFwd.getQuotaSummary().ss_mcp_units, 4);
    assert.equal(sFwd.getQuotaSummary().ss_web_realtime_tasks, 1);
    assert.equal(sFwd.getQuotaSummary().unknown_reserved_sif_units, 2);
    assert.equal(sRev.getQuotaSummary().sif_units, 3);
    assert.equal(sRev.getQuotaSummary().ss_mcp_units, 4);
    assert.equal(sRev.getQuotaSummary().ss_web_realtime_tasks, 1);
    assert.equal(sRev.getQuotaSummary().unknown_reserved_sif_units, 2);

    // Both import orders MUST expose the permanent lock under its canonical recovery ID & source_ledger_ref!
    const fwdLock = sFwd.getAttempt('101-synth-rec');
    const revLock = sRev.getAttempt('101-synth-rec');
    assert.ok(fwdLock && revLock);
    assert.equal(fwdLock.status, 'permanently_locked');
    assert.equal(revLock.status, 'permanently_locked');
    assert.equal(fwdLock.source_ledger_ref, revLock.source_ledger_ref);

    // Raw isError:true receipt marked unknown_needs_reconciliation (NOT completed!)
    const errRows = sFwd.db.prepare("SELECT status FROM api_request_ledger WHERE attempt_id LIKE '%:r-err'").all();
    assert.equal(errRows.length, 1);
    assert.equal(errRows[0].status, 'unknown_needs_reconciliation');

    // R2-2: Completed historical row with no_retry:true MUST block fresh_observation reservation on same date!
    const blockedNoRetry = sFwd.reserveRequestAttempt({
      account_scope: 'historical-default',
      provider: 'sif',
      tool_name: 'mcp__sif__ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-15',
      params: { asin: 'B9CH01', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
    });
    assert.equal(blockedNoRetry.allowed, false);
    assert.equal(blockedNoRetry.reason, 'no_retry_locked_historical_attempt');

    // R2-2: Explicit SIF default pageSize:100 (keyword_distribution) and isListingSearch:true (traffic_overview) must NOT double-bill!
    let kdCalls = 0;
    const kd1 = await sFwd.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_keyword_distribution',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9DEF10000', timePieceType: 'latelyDay', timePieceValue: '30' },
    }, async () => { kdCalls++; return { payload: { total: 40 }, sif_units: 2 }; });
    const kd2 = await sFwd.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_keyword_distribution',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9DEF10000', timePieceType: 'latelyDay', timePieceValue: '30', pageNum: 1, pageSize: 100, country: 'US', dimension: 'asin', showType: 1 },
    }, async () => { kdCalls++; return { payload: { total: 99 }, sif_units: 2 }; });
    assert.equal(kdCalls, 1);
    assert.equal(kd1.payload.total, 40);
    assert.equal(kd2.reused, true);
    assert.equal(kd2.payload.total, 40);

    let ovCalls = 0;
    await sFwd.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      enforce_provider_guards: false, // explicitly testing legacy server-default 7-day key dedup
      params: { asin: 'B9OV01' },
    }, async () => { ovCalls++; return { payload: { ratio: 0.6 }, sif_units: 3 }; });
    const ov2 = await sFwd.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      enforce_provider_guards: false, // explicitly testing legacy server-default 7-day key dedup
      params: { asin: 'B9OV01', country: 'US', timePieceType: 'latelyDay', timePieceValue: '7', isListingSearch: true },
    }, async () => { ovCalls++; return { payload: { ratio: 0.9 }, sif_units: 3 }; });
    assert.equal(ovCalls, 1);
    assert.equal(ov2.reused, true);
    sFwd.close();
    sRev.close();

    // R2-3: Secondary default writable open MUST NOT hijack active in_flight 5-pt request;
    // unknown_not_exposed completion preserves 5-pt reserve; null outcome becomes unknown_needs_reconciliation;
    // reserveRequestAttempt rejects historical_replay; pre-dispatch failed is excluded from incremental count!
    const liveDb = join(dir, 'r2-3.sqlite');
    const c1 = openSelectionStore(liveDb);
    const rActive = c1.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      estimated_sif_units: 5,
      form_id: 'f-inc',
      stage: 'gate2_3',
      params: { asin: 'B9ACTIVE5' },
    });
    c1.markAttemptInFlight(rActive.attempt_id);

    // Secondary default writable connection does NOT trigger crash reconciliation!
    const c2 = openSelectionStore(liveDb);
    assert.deepEqual(c2.startup_reconciled_attempts, []);
    c2.close();

    // Delayed 5-pt receipt succeeds cleanly!
    const okHash = sha256Hex('delayed-receipt');
    c1.completeAttempt(rActive.attempt_id, { sif_units: 5, payload_sha256: okHash });
    assert.equal(c1.getAttempt(rActive.attempt_id).sif_units, 5);
    assert.equal(c1.getAttempt(rActive.attempt_id).payload_sha256, okHash);

    // Unknown-billing completion preserves estimated 5-pt reserve!
    const rUnkBill = c1.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      estimated_sif_units: 5,
      params: { asin: 'B9UNKBILL5' },
    });
    c1.markAttemptInFlight(rUnkBill.attempt_id);
    c1.completeAttempt(rUnkBill.attempt_id, { billing_status: 'unknown_not_exposed', payload: { ok: true } });
    assert.equal(c1.getAttempt(rUnkBill.attempt_id).unknown_reserved_sif_units, 5);

    // Null executor outcome becomes unknown_needs_reconciliation (NEVER completed/0)!
    const nullRes = await c1.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      estimated_sif_units: 3,
      params: { asin: 'B9NULLOUT1', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
    }, async () => null);
    assert.equal(nullRes.completed, false);
    assert.equal(nullRes.status, 'unknown_needs_reconciliation');
    assert.equal(c1.getAttempt(nullRes.attempt_id).unknown_reserved_sif_units, 3);

    // Low-level reserveRequestAttempt rejects mode:'historical_replay'!
    assert.throws(() => c1.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      mode: 'historical_replay',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      params: { asin: 'B9HISTNO' },
    }), /historical_replay/);

    // Pre-dispatch local failure MUST NOT be counted as an incremental request!
    const rPreFail = c1.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-19',
      form_id: 'f-prefail-only',
      stage: 'gate2_3',
      params: { asin: 'B9PREFAIL' },
    });
    c1.failAttemptBeforeDispatch(rPreFail.attempt_id, 'Local validation failed before dispatch');
    assert.equal(c1.countIncrementalRequestsForForm('f-prefail-only', ['gate2_3']), 0);
    c1.close();
  });
});

test('Round-2 Codex Regressions #4, #5, #6, #7: sticky rights conflict, Gate 1A/1B price alignment, 4.43% negotiation choice, array components, Shenzhen & readback proof, remainder order_plan persistence, exclusive lease, crashed lease takeover, and strict CAPTCHA resume', async () => {
  await withTempDirAsync(async dir => {
    const dbPath = join(dir, 'r2-gates.sqlite');
    const store = openSelectionStore(dbPath);

    // R2-4a: Sticky proven rights conflict on the exact same spec_sha256 cannot be erased by omitting specific_rights_conflict!
    store.upsertCandidateForm({
      form_id: 'f-rights-sticky',
      product_family_key: 'fam-rights',
      label: 'Rights conflict item',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    const r1 = runGate1AForForm(store, {
      form_id: 'f-rights-sticky',
      specific_rights_conflict: true,
      scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
    });
    assert.equal(r1.gate_status, 'gate1a_rejected');
    const r2 = runGate1AForForm(store, {
      form_id: 'f-rights-sticky',
      // Omitted (defaults to 'unknown') on identical spec -> MUST remain rejected!
      scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
    });
    assert.equal(r2.gate_status, 'gate1a_rejected');
    assert.equal(r2.proceed_to_gate1b, false);

    // R2-4b: Direct runGate1BForForm on unscreened 'discovered' form MUST be blocked!
    store.upsertCandidateForm({
      form_id: 'f-unscreened',
      product_family_key: 'fam-un',
      label: 'Unscreened form',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
      lifecycle_status: 'discovered',
    });
    let unscreenedBrowse = 0;
    const unscreenedRes = await runGate1BForForm(store, {
      form_id: 'f-unscreened',
      sourcing_executor: async () => { unscreenedBrowse++; return { status: 'no_matched_offer' }; },
      early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
    });
    assert.equal(unscreenedBrowse, 0);
    assert.equal(unscreenedRes.status, 'blocked_by_gate1a');

    // R2-4c: Concurrent spec v1 -> v2 upgrade during async Gate 1B sourcing aborts stale v1 write!
    store.upsertCandidateForm({
      form_id: 'f-spec-race',
      product_family_key: 'fam-race',
      label: 'Spec race item',
      buyer_task: 'Task v1',
      saleable_set_composition: { qty: 1 },
    });
    runGate1AForForm(store, {
      form_id: 'f-spec-race',
      scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
    });
    const raceRes = await runGate1BForForm(store, {
      form_id: 'f-spec-race',
      sourcing_executor: async () => {
        // Overlapping batch bumps spec_version v1 -> v2 mid-flight!
        store.upsertCandidateForm({
          form_id: 'f-spec-race',
          product_family_key: 'fam-race',
          label: 'Spec race item',
          buyer_task: 'Task v2 redesigned',
          saleable_set_composition: { qty: 2 },
        });
        return {
          status: 'quoted',
          quote: {
            observed_at: '2026-11-19',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'readback:v1-stale',
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            sku_lines: [{ offer_id: 'oR', sku_id: 'sR', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
            actual_sets: 100,
            actual_complete_sets: 100,
            goods_cny_total: 8000,
            domestic_freight_cny_total: 100,
          },
        };
      },
      early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
    });
    assert.equal(raceRes.status, 'stale_spec_version_conflict');
    assert.equal(raceRes.proceed_to_gate2_3, false);
    assert.equal(store.getQuotesForForm('f-spec-race').length, 0);

    // R2-5a: Declared [$40, $60], ¥102/set -> supplying ONLY $40 MUST park gate1b_pending (NOT kill the form)!
    store.upsertCandidateForm({
      form_id: 'f-g1b-omit',
      product_family_key: 'fam-g1b-omit',
      label: 'Omit scenario guard',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    runGate1AForForm(store, {
      form_id: 'f-g1b-omit',
      scenarios: [
        makeStandardGate1AScenario({ id: 'p40', price_usd: 40 }),
        makeStandardGate1AScenario({ id: 'p60', price_usd: 60 }),
      ],
    });
    const q102 = store.recordSourcingQuote1688({
      form_id: 'f-g1b-omit',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:q102',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'o102', sku_id: 's102', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 10000,
      domestic_freight_cny_total: 200,
    }).quote;
    const omitRes = await runGate1BForForm(store, {
      form_id: 'f-g1b-omit',
      existing_quote: q102,
      early_screen_builder: () => [makeEarlyScreenBuilder(40, 100, 2)()],
    });
    assert.equal(omitRes.status, 'gate1b_pending');
    assert.equal(omitRes.proceed_to_gate2_3, false);

    // R2-5b: Declared ONLY [$40], ¥152/set -> sneaking undeclared $60 MUST park gate1b_pending (NOT pass)!
    store.upsertCandidateForm({
      form_id: 'f-g1b-invent',
      product_family_key: 'fam-g1b-invent',
      label: 'Invented price guard',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    runGate1AForForm(store, {
      form_id: 'f-g1b-invent',
      scenarios: [makeStandardGate1AScenario({ id: 'p40', price_usd: 40 })],
    });
    const q152 = store.recordSourcingQuote1688({
      form_id: 'f-g1b-invent',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:q152',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'o152', sku_id: 's152', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 150, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 15000,
      domestic_freight_cny_total: 200,
    }).quote;
    const inventRes = await runGate1BForForm(store, {
      form_id: 'f-g1b-invent',
      existing_quote: q152,
      early_screen_builder: () => [makeEarlyScreenBuilder(60, 150, 2)()],
    });
    assert.equal(inventRes.status, 'gate1b_pending');
    assert.equal(inventRes.proceed_to_gate2_3, false);

    // R2-5c: Two failed scenarios ($42 -> ~23.40%, $47 -> ~8.18% required discount) -> MUST persist the ~8.18% eligible negotiation_shortlist!
    store.upsertCandidateForm({
      form_id: 'f-neg-best',
      product_family_key: 'fam-neg',
      label: 'Best negotiation pick',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    runGate1AForForm(store, {
      form_id: 'f-neg-best',
      scenarios: [
        makeStandardGate1AScenario({ id: 'low', price_usd: 42 }),
        makeStandardGate1AScenario({ id: 'high', price_usd: 47 }),
      ],
    });
    const qNeg = store.recordSourcingQuote1688({
      form_id: 'f-neg-best',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:qneg',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'oN', sku_id: 'sN', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 120, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 12000,
      domestic_freight_cny_total: 200,
    }).quote;
    const negRes = await runGate1BForForm(store, {
      form_id: 'f-neg-best',
      profile_revision: 59,
      existing_quote: qNeg,
      early_screen_builder: () => [
        makeEarlyScreenBuilder(42, 120, 2)(),
        makeEarlyScreenBuilder(47, 120, 2)(),
      ],
    });
    assert.equal(negRes.status, 'gate1b_rejected');
    assert.equal(negRes.negotiation_shortlist, null);
    assert.equal(store.traceFormLineage('f-neg-best').negotiation_shortlist, null);

    // R2-6: Array-form saleable_set_composition, Shanghai rejected, missing readback rejected, and allow_remainder 120/100 plan preserved verbatim!
    store.upsertCandidateForm({
      form_id: 'f-arr-comp',
      product_family_key: 'fam-arr',
      label: 'Array component form',
      buyer_task: 'Task',
      saleable_set_composition: [
        { component_id: 'part-A', qty_per_saleable_set: 1 },
        { component_id: 'part-B', qty_per_saleable_set: 1 },
      ],
    });
    runGate1AForForm(store, {
      form_id: 'f-arr-comp',
      scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
    });
    assert.throws(() => store.recordSourcingQuote1688({
      form_id: 'f-arr-comp',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:arr-missing',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'oA', sku_id: 'part-A', component_id: 'part-A', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 10, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 1000,
      domestic_freight_cny_total: 20,
    }), /missing required saleable-set component "part-B"/);

    // Non-Shenzhen destination (上海) rejected on verified quote!
    assert.throws(() => store.recordSourcingQuote1688({
      form_id: 'f-arr-comp',
      observed_at: '2026-11-19',
      redacted_destination: '上海',
      raw_readback_ref: 'readback:shanghai',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [
        { offer_id: 'oA', sku_id: 'part-A', component_id: 'part-A', qty_per_saleable_set: 1, pack_multiple: 60, moq_qty: 60, ordered_qty: 120, unit_price_cny: 1, regular_goods_promo_false: true },
        { offer_id: 'oB', sku_id: 'part-B', component_id: 'part-B', qty_per_saleable_set: 1, pack_multiple: 50, moq_qty: 50, ordered_qty: 100, unit_price_cny: 1, regular_goods_promo_false: true },
      ],
      allow_remainder: true,
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 220,
      domestic_freight_cny_total: 0,
    }), /Shenzhen/i);

    // Missing readback/screenshot proof rejected on verified quote!
    assert.throws(() => store.recordSourcingQuote1688({
      form_id: 'f-arr-comp',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [
        { offer_id: 'oA', sku_id: 'part-A', component_id: 'part-A', qty_per_saleable_set: 1, pack_multiple: 60, moq_qty: 60, ordered_qty: 120, unit_price_cny: 1, regular_goods_promo_false: true },
        { offer_id: 'oB', sku_id: 'part-B', component_id: 'part-B', qty_per_saleable_set: 1, pack_multiple: 50, moq_qty: 50, ordered_qty: 100, unit_price_cny: 1, regular_goods_promo_false: true },
      ],
      allow_remainder: true,
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 220,
      domestic_freight_cny_total: 0,
    }), /readback or redacted screenshot reference/i);

    // Valid allow_remainder 120/100 quote persists order_plan_json and preserves 120/100 (NOT 200/200) on cached reuse!
    const remRec = store.recordSourcingQuote1688({
      form_id: 'f-arr-comp',
      observed_at: '2026-11-19',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:rem-120-100',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [
        { offer_id: 'oA', sku_id: 'part-A', component_id: 'part-A', qty_per_saleable_set: 1, pack_multiple: 60, moq_qty: 60, ordered_qty: 120, unit_price_cny: 1, regular_goods_promo_false: true },
        { offer_id: 'oB', sku_id: 'part-B', component_id: 'part-B', qty_per_saleable_set: 1, pack_multiple: 50, moq_qty: 50, ordered_qty: 100, unit_price_cny: 1, regular_goods_promo_false: true },
      ],
      allow_remainder: true,
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 220,
      domestic_freight_cny_total: 20,
    });
    let cachedPlanSeen = null;
    await runGate1BForForm(store, {
      form_id: 'f-arr-comp',
      profile_revision: 59,
      existing_quote: remRec.quote,
      early_screen_builder: ({ order_plan }) => {
        cachedPlanSeen = order_plan;
        return makeEarlyScreenBuilder(54.99, 2.2, 0.2)();
      },
    });
    assert.equal(cachedPlanSeen.allocated_sets, 100);
    assert.equal(cachedPlanSeen.sku_lines[0].ordered_qty, 120);
    assert.equal(cachedPlanSeen.sku_lines[1].ordered_qty, 100);

    // R2-7a: Same lease_owner cannot double-acquire serial 1688 lease (max concurrent = 1)!
    const lA = store.acquireQueueLease('gate1b_1688_queue', 'shared-controller');
    const lB = store.acquireQueueLease('gate1b_1688_queue', 'shared-controller');
    assert.equal(lA.acquired, true);
    assert.equal(lB.acquired, false);
    assert.equal(lB.reason, 'busy_serial_lease_held');

    // R2-7b: Crashed controller leaves stale lease -> authoritative reopen ({ reconcileOnOpen: true }) clears it so new controller proceeds!
    store.close();
    const crashedReopen = openSelectionStore(dbPath, { reconcileOnOpen: true });
    assert.equal(crashedReopen.getQueueState('gate1b_1688_queue').active_lease_owner, null);
    const lAfterCrash = crashedReopen.acquireQueueLease('gate1b_1688_queue', 'new-controller');
    assert.equal(lAfterCrash.acquired, true);
    crashedReopen.releaseQueueLease('gate1b_1688_queue', lAfterCrash.lease_token);

    // R2-7c: CAPTCHA resume rejects non-Shenzhen city, < paused_min_qty, and unrelated SKU when form has declared components!
    crashedReopen.pauseQueue('gate1b_1688_queue', '1688 slider', {
      paused_form_id: 'f-arr-comp',
      paused_min_qty: 144,
    });
    assert.throws(() => crashedReopen.resumeQueue('gate1b_1688_queue', {
      login_verified: true,
      form_id: 'f-arr-comp',
      destination_city: '上海',
      quantity: 144,
      sku_id: 'part-A',
      quote_validity: '2027-01-01',
    }, { as_of_date: '2026-11-19' }), /Shenzhen/i);
    assert.throws(() => crashedReopen.resumeQueue('gate1b_1688_queue', {
      login_verified: true,
      form_id: 'f-arr-comp',
      destination_city: '广东深圳',
      quantity: 100,
      sku_id: 'part-A',
      quote_validity: '2027-01-01',
    }, { as_of_date: '2026-11-19' }), /144/);
    assert.throws(() => crashedReopen.resumeQueue('gate1b_1688_queue', {
      login_verified: true,
      form_id: 'f-arr-comp',
      destination_city: '广东深圳',
      quantity: 144,
      sku_id: 'unrelated-sku',
      quote_validity: '2027-01-01',
    }, { as_of_date: '2026-11-19' }), /known SKUs\/components/i);
    const okResume = crashedReopen.resumeQueue('gate1b_1688_queue', {
      login_verified: true,
      form_id: 'f-arr-comp',
      destination_city: '广东深圳',
      quantity: 144,
      sku_id: 'part-A',
      quote_validity: '2027-01-01',
    }, { as_of_date: '2026-11-19' });
    assert.equal(okResume.status, 'active');
    crashedReopen.close();
  });
});

test('Round-2 Codex Regressions #8, #9, #10: primary_discovery admissibility & cross-key URL dedup, live storage rate hash, batch receipt & attempt backfill, preserved lead disposition, and full PII/token redaction across all write paths', async () => {
  const store = openSelectionStore(':memory:');

  // R2-8a: Two tools citing same original URL with DIFFERENT custom event_dedup_keys still deduplicate to 1 primary_discovery!
  store.upsertCandidateForm({
    form_id: 'f-url-dedup',
    product_family_key: 'fam-url',
    label: 'URL dedup item',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
  });
  store.upsertRawLead({
    lead_id: 'ld-tool-1',
    event_dedup_key: 'toolA:custom-key-1',
    source_channel: 'reddit',
    source_ref: 'https://www.reddit.com/r/tools/comments/samepost/?utm_medium=web',
    phrase_or_title: 'Tool post',
    observed_at: '2026-11-19',
    disposition: 'product',
  });
  store.upsertRawLead({
    lead_id: 'ld-tool-2',
    event_dedup_key: 'toolB:custom-key-2',
    source_channel: 'exa',
    source_ref: 'https://www.reddit.com/r/tools/comments/samepost/#comments',
    phrase_or_title: 'Same tool post via exa',
    observed_at: '2026-11-19',
    disposition: 'product',
  });
  const dl1 = store.linkLeadToForm({ lead_id: 'ld-tool-1', form_id: 'f-url-dedup', link_role: 'primary_discovery' });
  const dl2 = store.linkLeadToForm({ lead_id: 'ld-tool-2', form_id: 'f-url-dedup', link_role: 'primary_discovery' });
  assert.equal(dl1.link.link_role, 'primary_discovery');
  assert.equal(dl2.link.link_role, 'corroboration');

  // R2-8b: Form with ONLY corroboration lead (0 primary_discovery) MUST be blocked from Stage 3!
  const candCorrob = structuredClone(fixture.candidates[0]);
  candCorrob.id = 'f-corrob-only';
  const corrobBatch = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-19',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:corrob',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oC', sku_id: 'sC', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async () => ({ batch: { ...structuredClone(fixture), candidates: [candCorrob] } }),
    items: [{
      leads: [{
        lead_id: 'ld-corrob-only',
        source_channel: 'reddit',
        source_ref: 'https://www.reddit.com/r/tools/comments/corrob1/',
        phrase_or_title: 'Corroboration only',
        observed_at: '2026-11-19',
        disposition: 'product',
        link_role: 'corroboration',
      }],
      form: { form_id: 'f-corrob-only', label: 'Corrob only', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
      early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
    }],
  });
  assert.equal(corrobBatch.gate2_3[0].status, 'blocked_inadmissible_leads');
  assert.equal(store.getEvaluationsForForm('f-corrob-only').length, 0);

  // R2-9a: Storage rate in getFba2027RateTableSnapshot is deep-frozen and computeEvidenceBundleHash tracks fee_table_snapshot changes!
  const liveSnap = getFba2027RateTableSnapshot();
  const origOffPeak = liveSnap.storage_usd_per_cuft_month.off_peak;
  assert.equal(origOffPeak, 0.78);
  assert.throws(() => { liveSnap.storage_usd_per_cuft_month.off_peak = 0.88; }, TypeError);
  const hashBefore = computeEvidenceBundleHash({ form_spec_sha256: 'abc', candidate_input: { id: 'x' }, profile_snapshot: { revision: 59 }, fee_table_snapshot: liveSnap });
  const modifiedSnap = { ...liveSnap, storage_usd_per_cuft_month: { ...liveSnap.storage_usd_per_cuft_month, off_peak: 0.88 } };
  const hashAfter = computeEvidenceBundleHash({ form_spec_sha256: 'abc', candidate_input: { id: 'x' }, profile_snapshot: { revision: 59 }, fee_table_snapshot: modifiedSnap });
  assert.notEqual(hashBefore, hashAfter);

  // R2-9b & R2-9c: Replaying 3-card batch then 1-card batch records BOTH batch receipts AND merges new source_attempt_ids!
  const cand0Id = fixture.candidates[0].id;
  const fullOut = replayBatchIntoStore(store, { batch: structuredClone(fixture), profile, source_attempt_ids: ['att-initial'] });
  const oneOut = replayBatchIntoStore(store, {
    batch: { ...structuredClone(fixture), candidates: [structuredClone(fixture.candidates[0])] },
    profile,
    source_attempt_ids: ['att-backfilled'],
  });
  const evAfter = store.getEvaluationsForForm(cand0Id)[0];
  const parsedReceipt = JSON.parse(evAfter.receipt_json);
  const parsedAttempts = JSON.parse(evAfter.source_attempt_ids_json);
  assert.ok(parsedReceipt.batch_receipts.some(r => r.batch_result_sha256 === fullOut.result_sha256 && r.batch_html_sha256 === fullOut.html_sha256));
  assert.ok(parsedReceipt.batch_receipts.some(r => r.batch_result_sha256 === oneOut.result_sha256 && r.batch_html_sha256 === oneOut.html_sha256));
  assert.deepEqual(parsedAttempts, ['att-backfilled', 'att-initial']);

  // R2-9d: Replaying a batch with discovery preserves a later reviewed disposition ('delivery_only') on an existing raw_lead!
  const synthDiscovery = JSON.parse(readFileSync(new URL('../fixtures/synthetic-discovery.json', import.meta.url), 'utf8'));
  replayBatchIntoStore(store, { batch: structuredClone(fixture), profile, discovery: synthDiscovery });
  const discLead = store.db.prepare("SELECT lead_id, source_channel, source_ref, phrase_or_title, disposition FROM raw_leads WHERE normalized_key = 'synthetic rack'").get();
  assert.equal(discLead.disposition, 'product');
  // Reviewer updates lead to delivery_only
  store.upsertRawLead({
    lead_id: discLead.lead_id,
    source_channel: discLead.source_channel,
    source_ref: discLead.source_ref,
    phrase_or_title: discLead.phrase_or_title,
    observed_at: '2026-11-19',
    disposition: 'delivery_only',
  });
  // Old batch replay MUST preserve delivery_only!
  replayBatchIntoStore(store, { batch: structuredClone(fixture), profile, discovery: synthDiscovery });
  assert.equal(store.db.prepare('SELECT disposition FROM raw_leads WHERE lead_id = ?').get(discLead.lead_id).disposition, 'delivery_only');

  // R2-10: All 3 write paths scrub/withhold PII and credentials:
  // (a) Gate 1B caught exception phone number scrubbed from gate1b_result_json
  const piiErrBatch = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => { throw new Error('1688 page failed for contact 13900001111 token=sk-live123456789'); },
    items: [{
      leads: [{
        lead_id: 'ld-pii-g1b',
        source_channel: 'reddit',
        source_ref: 'https://www.reddit.com/r/tools/comments/piig1b/',
        phrase_or_title: 'pii err guard',
        observed_at: '2026-11-19',
        disposition: 'product',
      }],
      form: { form_id: 'f-pii-g1b', label: 'PII G1B', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeStandardGate1AScenario({ price_usd: 54.99 })],
      early_screen_builder: makeEarlyScreenBuilder(54.99, 80, 1),
    }],
  });
  const savedG1bJson = store.getCandidateForm('f-pii-g1b').gate1b_result_json;
  assert.equal(piiErrBatch.gate1b[0].status, 'gate1b_pending');
  assert.equal(savedG1bJson.includes('13900001111'), false);
  assert.equal(savedG1bJson.includes('sk-live123456789'), false);

  // (b) Request exception credential scrubbed from reconciliation_note
  await assert.rejects(() => store.executeGuardedRequest({
    account_scope: 'default-us',
    provider: 'sif',
    tool_name: 'ops_get_listing_traffic_overview',
    observation_cutoff_date: '2026-11-19',
    params: { asin: 'B9TOKERR01', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
  }, async () => { throw new Error('401 Unauthorized ghp_1234567890abcdef123456 Bearer secret_abc_999'); }));
  const tokAttempt = store.db.prepare("SELECT reconciliation_note FROM api_request_ledger WHERE normalized_params_json LIKE '%B9TOKERR01%'").get();
  assert.equal(tokAttempt.reconciliation_note.includes('ghp_1234567890'), false);
  assert.equal(tokAttempt.reconciliation_note.includes('secret_abc_999'), false);

  // (c) Successful response payload containing PII or token is withheld from response_payload_json while preserving spent quota!
  const piiResp = await store.executeGuardedRequest({
    account_scope: 'default-us',
    provider: 'sif',
    tool_name: 'ops_get_listing_traffic_overview',
    observation_cutoff_date: '2026-11-19',
    params: { asin: 'B9PIIRESP1', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
  }, async () => ({
    payload: { receiver_name: '张三', phone: '13800138000', ok: true },
    sif_units: 3,
  }));
  assert.equal(piiResp.completed, true);
  const piiRow = store.getAttempt(piiResp.attempt_id);
  assert.equal(piiRow.sif_units, 3);
  assert.equal(piiRow.response_payload_json, null);
  assert.match(piiRow.reconciliation_note, /withheld/i);

  // R3 final surgical checks:
  // (1) { payload: null } is treated as unknown_needs_reconciliation (preserving reserve), NOT completed/0!
  const nullPayloadRes = await store.executeGuardedRequest({
    account_scope: 'default-us',
    provider: 'sif',
    tool_name: 'ops_get_listing_traffic_overview',
    observation_cutoff_date: '2026-11-19',
    estimated_sif_units: 5,
    params: { asin: 'B9NULLPAY1', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
  }, async () => ({ payload: null }));
  assert.equal(nullPayloadRes.completed, false);
  assert.equal(store.getAttempt(nullPayloadRes.attempt_id).unknown_reserved_sif_units, 5);

  // (2) Completed attempt with billing_status:'unknown_not_exposed' can be settled via reconcileUnknownAttempt!
  const unkBillComp = store.reserveRequestAttempt({
    account_scope: 'default-us',
    provider: 'sif',
    tool_name: 'ops_get_listing_traffic_overview',
    observation_cutoff_date: '2026-11-19',
    estimated_sif_units: 5,
    params: { asin: 'B9SETTLE05', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
  });
  store.markAttemptInFlight(unkBillComp.attempt_id);
  store.completeAttempt(unkBillComp.attempt_id, { billing_status: 'unknown_not_exposed', payload: { ok: true } });
  const settled = store.reconcileUnknownAttempt(unkBillComp.attempt_id, {
    resolved_status: 'completed',
    sif_units: 3,
    note: 'Confirmed 3 pts via SIF quota log.',
  });
  assert.equal(settled.sif_units, 3);
  assert.equal(settled.unknown_reserved_sif_units, 0);
  assert.equal(settled.billing_status, 'known');

  // (3) Auto-extracts SIF _quota.costThisCall and blocks MCP content[].text stringified JSON PII/tokens!
  const mcpTextPii = await store.executeGuardedRequest({
    account_scope: 'default-us',
    provider: 'sif',
    tool_name: 'ops_get_listing_traffic_overview',
    observation_cutoff_date: '2026-11-19',
    params: { asin: 'B9MCPPII01', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
  }, async () => ({
    payload: {
      content: [{ type: 'text', text: JSON.stringify({ _quota: { costThisCall: 6 }, receiver_name: '李四', token: 'ghp_1234567890abcdef' }) }],
    },
  }));
  const mcpRow = store.getAttempt(mcpTextPii.attempt_id);
  assert.equal(mcpRow.sif_units, 6);
  assert.equal(mcpRow.response_payload_json, null);

  // (4) Lead metadata PII/token rejected, paused_sku_hint PII scrubbed, and cross-form quote rejected by runGate1BForForm!
  assert.throws(() => store.upsertRawLead({
    lead_id: 'ld-meta-secret',
    source_channel: 'reddit',
    source_ref: 'https://www.reddit.com/r/tools/comments/metasec/',
    phrase_or_title: 'meta secret test',
    observed_at: '2026-11-19',
    metadata: { api_key: 'sk-secret123456789' },
  }), /credential or token/i);

  store.pauseQueue('gate1b_1688_queue', 'slider', { paused_sku_hint: 'contact 13800138000' });
  assert.equal(store.getQueueState('gate1b_1688_queue').paused_sku_hint.includes('13800138000'), false);

  store.close();
});

test('Step 2 auto-wiring & store queue: runPhase2Batch upserts calibration_tracking without overwriting owner_confirmed, and selectNextStoreBatch isolates pending pool & exclusions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  await withTempDirAsync(async dir => {
    const dbPath = join(dir, 'step2.sqlite');

    // 1. Simulate legacy candidate_forms schema lacking presentation tracking columns, then verify additive _migrateSchema()
    const seedStore = openSelectionStore(dbPath);
    seedStore.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE candidate_forms_old AS SELECT
        form_id, product_family_key, spec_version, spec_sha256, label, buyer_task,
        saleable_set_composition_json, grade_or_material, target_child_asin, leaf_node_path,
        lifecycle_status, sourcing_disposition, gate1a_result_json, gate1b_result_json,
        negotiation_shortlist_json, packaging_redesign_shortlist_json, landed_domestic_cap_cny,
        cooldown_until, cooldown_reason, promotion_track, created_at, updated_at
      FROM candidate_forms;
      DROP TABLE candidate_forms;
      CREATE TABLE candidate_forms (
        form_id TEXT PRIMARY KEY,
        product_family_key TEXT NOT NULL,
        spec_version INTEGER NOT NULL DEFAULT 1 CHECK(spec_version >= 1),
        spec_sha256 TEXT NOT NULL,
        label TEXT NOT NULL,
        buyer_task TEXT NOT NULL,
        saleable_set_composition_json TEXT NOT NULL,
        grade_or_material TEXT,
        target_child_asin TEXT,
        leaf_node_path TEXT,
        lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
        sourcing_disposition TEXT,
        gate1a_result_json TEXT,
        gate1b_result_json TEXT,
        negotiation_shortlist_json TEXT,
        packaging_redesign_shortlist_json TEXT,
        landed_domestic_cap_cny REAL,
        cooldown_until TEXT,
        cooldown_reason TEXT,
        promotion_track TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE candidate_forms_old;
    `);
    raw.close();

    const store = openSelectionStore(dbPath);
    try {
      const formCols = store._tableColumns('candidate_forms');
      assert.equal(formCols.has('last_presented_at'), true);
      assert.equal(formCols.has('presentation_count'), true);

      // 2. Test runPhase2Batch auto-wiring into calibration_tracking
      const { estimateGate1A2027 } = await import('../src/fba-calculator.mjs');
      const baseCand = structuredClone(fixture.candidates[0]);
      const sc0Base = baseCand.economics.scenarios[0];
      const fx = 7.0;
      const procUsd = sc0Base.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd;
      const domUsd = sc0Base.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd;
      const hhUsd = sc0Base.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd;
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
      const quoteForCand = (formId, qid) => ({
        quote_id: qid,
        factory_id: 'fac-step2-1',
        observed_at: '2026-11-27',
        expires_at: null,
        redacted_destination: '广东深圳',
        raw_readback_ref: `rb-${qid}`,
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        fx_cny_per_usd: fx,
        pkg: { length_in: 10, width_in: 6, height_in: 2, unit_weight_lb: 1.5 },
        sku_lines: [{ offer_id: 'o1', sku_id: 's1', component_id: 'item', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: unitGoodsCny, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: Math.round(unitGoodsCny * 100 * 100) / 100,
        domestic_freight_cny_total: totalDomCny,
      });
      const alignCand = (cand, id, qid) => {
        const c = structuredClone(cand);
        c.id = id;
        delete c.spec_sha256;
        delete c.spec_version;
        for (const s of c.economics.scenarios) {
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
        return c;
      };
      const mkBatchItem = (formId, qid) => ({
        form: {
          form_id: formId,
          product_family_key: formId,
          label: `AutoCal ${formId}`,
          buyer_task: 'Organize bench parts',
          saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
        },
        leads: [{
          lead_id: `ld-${formId}`,
          source_channel: 'reddit',
          source_ref: `https://example.com/${formId}`,
          phrase_or_title: formId,
          observed_at: '2026-11-27',
          disposition: 'product',
        }],
        gate1a_scenarios: g1aScens,
        sourcing_executor: async () => ({ status: 'quoted', quote: quoteForCand(formId, qid) }),
        early_screen_builder: () => g1aScens.map(g => ({
          profile_revision: 59, id: g.id, saleable_unit: '1 complete set', price_usd: g.price_usd, fx_cny_per_usd: fx,
          order_units: 100, goods_cny_per_unit: unitGoodsCny, domestic_freight_cny_per_unit: totalDomCny / 100,
          first_order_promotion: false, goods_first_order_promotion: false,
          pkg: { length_in: 10, width_in: 6, height_in: 2, unit_weight_lb: 1.5 },
          headhaul: { usd_per_unit: hhUsd, bond_included: true },
          refund_fraction: 0.02, physical_return_fraction: 0.02, return_threshold: 0.08, returns_processing_usd: 0,
          is_apparel_or_shoes: false,
          referral_terms: g.referral_terms,
          fulfillment_usd: cachedEst.fulfillment_usd, placement_usd: cachedEst.placement_usd,
          storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWin, storage: storageWin, inbound: inboundWin },
          collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
        })),
        deep_research_executor: async () => ({
          batch: { schema_version: 1, profile_revision: 59, candidates: [alignCand(baseCand, formId, qid)] },
        }),
      });

      // Pre-seed form-auto-cal-b with owner_confirmed decision BEFORE runPhase2Batch
      store.upsertCalibrationTracking({
        form_id: 'form-auto-cal-b',
        spec_version: 1,
        system_verdict: 'pending_evidence',
        owner_decision: 'keep',
        owner_decision_source: 'owner_confirmed',
        owner_reason: '主人已确认保留',
      });
      // Pre-seed form-auto-cal-c with legacy_unknown sample_check
      store.upsertCalibrationTracking({
        form_id: 'form-auto-cal-c',
        spec_version: 1,
        system_verdict: 'pending_evidence',
        owner_decision: 'sample_check',
        owner_reason: '旧脚本已定',
      });

      const autoOut = await runPhase2Batch(store, {
        items: [
          mkBatchItem('form-auto-cal-a', 'q-auto-a'),
          mkBatchItem('form-auto-cal-b', 'q-auto-b'),
          mkBatchItem('form-auto-cal-c', 'q-auto-c'),
        ],
        profile,
        as_of_date: '2026-11-27',
        batch_id: 'batch-step2-auto',
      });
      assert.equal(autoOut.gate2_3.filter(x => x.status === 'evaluated').length, 3);

      const calA = store.getCalibrationTrackingForForm('form-auto-cal-a', 1);
      assert.ok(calA);
      assert.equal(calA.batch_id, 'batch-step2-auto');
      assert.ok(Array.isArray(calA.core_85_range));
      assert.ok(Array.isArray(calA.supported_range));
      assert.ok(Array.isArray(calA.pre_ad_margin_range));
      assert.equal(calA.owner_decision, null);
      assert.equal(calA.owner_decision_source, null);

      const calB = store.getCalibrationTrackingForForm('form-auto-cal-b', 1);
      assert.equal(calB.owner_decision, 'keep');
      assert.equal(calB.owner_decision_source, 'owner_confirmed');
      assert.equal(calB.owner_reason, '主人已确认保留');
      assert.equal(calB.batch_id, 'batch-step2-auto');

      const calC = store.getCalibrationTrackingForForm('form-auto-cal-c', 1);
      assert.equal(calC.owner_decision, 'sample_check');
      assert.equal(calC.owner_decision_source, 'legacy_unknown');

      const calSummary = store.getCalibrationRetrospectiveSummary({ batch_id: 'batch-step2-auto' });
      assert.equal(calSummary.awaiting_owner_decision_count, 1);
      assert.equal(calSummary.owner_confirmed_count, 1);
      assert.equal(calSummary.legacy_unknown_source_count, 1);

      // 3. Seed exclusion buckets + 3 priority tiers for selectNextStoreBatch
      const addForm = (id, status, opts = {}) => {
        store.upsertCandidateForm({
          form_id: id,
          product_family_key: id,
          label: `Form ${id}`,
          buyer_task: 'Task',
          saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
          lifecycle_status: status,
          ...(opts.promotion_track ? { promotion_track: opts.promotion_track } : {}),
          ...(opts.cooldown_until ? { cooldown_until: opts.cooldown_until, cooldown_reason: 'cooling' } : {}),
        });
        if (opts.gate1a_result || opts.gate1b_result || opts.sourcing_disposition) {
          store.updateFormLifecycle(id, status, {
            ...(opts.gate1a_result ? { gate1a_result: opts.gate1a_result } : {}),
            ...(opts.gate1b_result ? { gate1b_result: opts.gate1b_result } : {}),
            ...(opts.sourcing_disposition ? { sourcing_disposition: opts.sourcing_disposition } : {}),
          });
        }
      };

      // Exclusions
      addForm('squirrel-basic', 'discovered');
      addForm('form-hist-custom', 'discovered');
      store.upsertRawLead({
        lead_id: 'ld-hist-1',
        source_channel: 'historical_trial_r57',
        source_ref: 'https://example.com/hist1',
        phrase_or_title: 'hist trial',
        observed_at: '2026-11-19',
      });
      store.linkLeadToForm({ lead_id: 'ld-hist-1', form_id: 'form-hist-custom', link_role: 'primary_discovery' });
      addForm('form-excl-g1a', 'gate1a_rejected');
      addForm('form-excl-g1b-json', 'gate1a_needs_verification', { gate1b_result: { status: 'gate1b_rejected' } });
      addForm('form-excl-cooldown', 'discovered', { cooldown_until: '2099-12-31' });
      addForm('form-excl-private-eval', 'gate1b_pending');
      store.recordEvaluation({
        form_id: 'form-excl-private-eval',
        period_id: 'annual',
        profile_revision: 59,
        evidence_bundle_sha256: 'a'.repeat(64),
        qualification: { counts_toward_target: false, mode: 'private_mold_reserved' },
        queue_bucket: 'pending',
        covered_weight: 80,
        supported_range: [70, 75],
        result_sha256: 'b'.repeat(64),
        receipt: { spec_version: 1 },
      });
      addForm('form-excl-r57-only', 'evaluated');
      store.recordEvaluation({
        form_id: 'form-excl-r57-only',
        period_id: 'annual',
        profile_revision: 57,
        evidence_bundle_sha256: 'c'.repeat(64),
        qualification: { counts_toward_target: true, mode: 'complete' },
        queue_bucket: 'comparable',
        covered_weight: 100,
        supported_range: [80, 82],
        result_sha256: 'd'.repeat(64),
        receipt: { spec_version: 1 },
      });

      // Eligible Tier 1 & Tier 2 & Tier 3
      addForm('form-elig-t1-g1b', 'gate1a_needs_verification', { gate1b_result: { status: 'gate1b_passed' } });
      addForm('form-elig-t1-disc', 'discovered', { promotion_track: 'track_a_resonance' });
      addForm('form-elig-t2-uneval', 'gate1a_needs_verification');
      addForm('form-elig-t3-pending-rev', 'evaluated');
      store.recordEvaluation({
        form_id: 'form-elig-t3-pending-rev',
        period_id: 'annual',
        profile_revision: 59,
        evidence_bundle_sha256: 'e'.repeat(64),
        qualification: { counts_toward_target: false, mode: 'none' },
        queue_bucket: 'pending',
        covered_weight: 60,
        supported_range: [50, 55],
        result_sha256: 'f'.repeat(64),
        receipt: { spec_version: 1 },
      });
      store.upsertCalibrationTracking({
        form_id: 'form-elig-t3-pending-rev',
        spec_version: 1,
        system_verdict: 'pending_evidence',
        owner_decision: 'pending_owner_review',
      });

      const pull1 = store.selectNextStoreBatch({ limit: 10, asOfDate: '2026-11-27' });
      assert.deepEqual(
        pull1.selected.map(x => x.form_id),
        [
          'form-elig-t1-g1b',
          'form-elig-t1-disc',
          'form-elig-t2-uneval',
          'form-auto-cal-a',
          'form-elig-t3-pending-rev',
        ],
      );
      assert.equal(pull1.excluded_counts.historical_trial_drill, 2);
      assert.equal(pull1.excluded_counts.terminal_lifecycle_or_private_mold, 1);
      assert.equal(pull1.excluded_counts.cooldown_active, 1);
      assert.equal(pull1.excluded_counts.gate1b_rejected_json, 1);
      assert.equal(pull1.excluded_counts.evaluation_reserved_or_excluded, 1);
      assert.equal(pull1.excluded_counts.legacy_pre_r59_archived, 1);
      assert.equal(pull1.excluded_counts.calibration_decided_or_excluded, 2);

      // Pending-pool isolation ("待拍板池")
      store.markFormsPresented(['form-elig-t1-g1b', 'form-elig-t1-disc'], '2026-11-27T10:00:00Z');
      const pull2 = store.selectNextStoreBatch({ limit: 10, asOfDate: '2026-11-27' });
      assert.deepEqual(pull2.selected.map(x => x.form_id), ['form-elig-t2-uneval', 'form-auto-cal-a', 'form-elig-t3-pending-rev']);
      assert.equal(pull2.pending_pool_skipped_count, 2);
      assert.deepEqual(pull2.pending_pool_form_ids, ['form-elig-t1-g1b', 'form-elig-t1-disc']);

      const pullPending = store.selectNextStoreBatch({ limit: 10, pendingPool: true, asOfDate: '2026-11-27' });
      assert.deepEqual(pullPending.selected.map(x => x.form_id), ['form-elig-t1-g1b', 'form-elig-t1-disc']);

      const pullInclude = store.selectNextStoreBatch({ limit: 5, includeShown: true, asOfDate: '2026-11-27' });
      assert.deepEqual(
        pullInclude.selected.map(x => x.form_id),
        ['form-elig-t2-uneval', 'form-auto-cal-a', 'form-elig-t3-pending-rev', 'form-elig-t1-g1b', 'form-elig-t1-disc'],
      );
      assert.equal(pullInclude.pending_pool_skipped_count, 0);
    } finally {
      store.close();
    }
  });
});
