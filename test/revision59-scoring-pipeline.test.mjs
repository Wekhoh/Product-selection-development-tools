import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scoreCandidate, scoreBatch } from '../src/scoring.mjs';
import { validateSourcingVerifier1688Output } from '../src/contracts.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { runGate1AForForm, runGate1BForForm, runPhase2Batch, attachCandidateEvidenceReview } from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { buildFunnelLedger } from '../src/funnel-ledger.mjs';
import { freezeEvidenceReviewPacket } from '../src/openai/evidence-review.mjs';
import { runCodexEvidenceReview } from '../src/openai/codex-runner.mjs';

const r58Profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
const r59Profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

test('Slice 2A: r59 profile & crossing-30% multi-factory interval linear slope extension (without inflating strict qualifying count)', () => {
  assert.equal(r58Profile.revision, 58, 'reference-profile.draft.json must remain frozen at r58');
  assert.equal(r59Profile.revision, 59, 'reference-profile.r59.draft.json must be r59');
  const upgraded = structuredClone(r59Profile);
  assert.equal(upgraded.revision, 59);
  assert.equal(upgraded.workflow.scoring_and_ordering.revision, 59);

  // Build a multi-factory candidate where Factory A achieves >= 30% margin and Factory B is below 30% (~28.5%)
  const baseCand = structuredClone(fixture.candidates[0]);
  baseCand.id = 'cand-crossing-factories';
  baseCand.label = '双厂跨30%红线精算款';
  const scPass = structuredClone(baseCand.economics.scenarios[0]);
  scPass.id = scPass.cost_ledger.id = 'sc-factory-a';
  scPass.label = '工厂A（深圳到仓 ¥42）';

  const scBelow = structuredClone(scPass);
  scBelow.id = scBelow.cost_ledger.id = 'sc-factory-b';
  scBelow.label = '工厂B（深圳到仓高报价，压线约28.5%）';
  // Adjust procurement line on scBelow so refund-adjusted pre-ad margin lands strictly below 30% (around 28.5%)
  const procA = scPass.cost_ledger.lines.find(l => l.id === 'procurement');
  const procB = scBelow.cost_ledger.lines.find(l => l.id === 'procurement');
  // Compute exact procurement amount to hit ~28.5% margin on scBelow:
  // First score scPass to read exact net_revenue_usd & net_cost_usd
  const probeScored = scoreCandidate(baseCand, r58Profile);
  const baseCalc = probeScored.diagnostics.economics.scenarios[0].input.calculation;
  const targetMarginB = 0.285;
  // net_revenue - (net_cost - procA + procB) = 0.285 * net_revenue => procB = net_revenue * (1 - 0.285) - (net_cost - procA)
  const desiredProcB = Number((baseCalc.net_revenue_usd * (1 - targetMarginB) - (baseCalc.net_cost_usd - procA.amount_usd)).toFixed(4));
  procB.amount_usd = desiredProcB;
  baseCand.economics.scenarios = [scPass, scBelow];
  if (Array.isArray(baseCand.economics.expected_primary_scenarios)) {
    baseCand.economics.expected_primary_scenarios = [
      { id: 'sc-factory-a', status: 'active' },
      { id: 'sc-factory-b', status: 'active' },
    ];
  }

  // Under r58: crossing-30% keeps margin & contribution needs_evidence and total_range null
  const r58Res = scoreCandidate(baseCand, r58Profile);
  assert.equal(r58Res.queue, 'pending');
  assert.equal(r58Res.total_range, null);

  // Under r59: <30% scenario extends linearly along min(22, max(0, 11 + 55*(m - 0.30))) and emits full [min_total, max_total]
  const r59Res = scoreCandidate(baseCand, r59Profile);
  const scBDiag = r59Res.diagnostics.economics.scenarios.find(s => s.id === 'sc-factory-b');
  const actualMarginB = scBDiag.margin.value;
  const expectedScoreB = Math.min(22, Math.max(0, 11 + 55 * (actualMarginB - 0.30)));
  assert.ok(actualMarginB < 0.30 && actualMarginB > 0.28);
  assert.ok(Math.abs(scBDiag.margin_score - expectedScoreB) < 1e-6, `Expected ~10.175, got ${scBDiag.margin_score}`);
  assert.ok(scBDiag.contribution_score > 0);
  assert.equal(r59Res.diagnostics.economics.crossing_margin_floor, true);
  assert.deepEqual(r59Res.diagnostics.economics.passing_scenario_ids, ['sc-factory-a']);
  assert.deepEqual(r59Res.diagnostics.economics.below_floor_scenario_ids, ['sc-factory-b']);
  assert.ok(Array.isArray(r59Res.total_range) && r59Res.total_range[0] < r59Res.total_range[1]);
  assert.equal(r59Res.effective_disposition, 'crossing_30pct_interval');
  assert.equal(r59Res.qualification.counts_toward_target, false, 'Crossing-30% card must NOT inflate strict qualifying count');

  // Extreme low margin <= 10% on below-floor scenario clamps cleanly to 0 (never negative)
  const scVeryLow = structuredClone(scBelow);
  scVeryLow.id = scVeryLow.cost_ledger.id = 'sc-factory-c';
  scVeryLow.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = Number((baseCalc.net_revenue_usd * 0.95 - (baseCalc.net_cost_usd - procA.amount_usd)).toFixed(4));
  const candClamp = structuredClone(baseCand);
  candClamp.economics.scenarios = [scPass, scVeryLow];
  if (Array.isArray(candClamp.economics.expected_primary_scenarios)) {
    candClamp.economics.expected_primary_scenarios = [
      { id: 'sc-factory-a', status: 'active' },
      { id: 'sc-factory-c', status: 'active' },
    ];
  }
  const r59Clamp = scoreCandidate(candClamp, r59Profile);
  const scCDiag = r59Clamp.diagnostics.economics.scenarios.find(s => s.id === 'sc-factory-c');
  assert.equal(scCDiag.margin_score, 0);

  // When ALL coherent scenarios are < 30%, r59 STILL marks queue = 'excluded' and effective_disposition = 'hard_excluded'
  const candAllBelow = structuredClone(baseCand);
  candAllBelow.id = 'cand-all-below-30';
  candAllBelow.economics.scenarios = [scBelow];
  if (Array.isArray(candAllBelow.economics.expected_primary_scenarios)) {
    candAllBelow.economics.expected_primary_scenarios = [{ id: 'sc-factory-b', status: 'active' }];
  }
  const r59AllBelow = scoreCandidate(candAllBelow, r59Profile);
  assert.equal(r59AllBelow.queue, 'excluded');
  assert.equal(r59AllBelow.effective_disposition, 'hard_excluded');
  assert.equal(r59AllBelow.total_range, null);

  // Batch summary dispositions separate strict qualifying vs crossing_30pct_interval vs hard_excluded
  const batchOut = scoreBatch({
    schema_version: 1,
    profile_revision: 59,
    candidates: [structuredClone(fixture.candidates[0]), baseCand, candAllBelow],
  }, r59Profile);
  assert.equal(batchOut.summary.qualifying, 1);
  assert.equal(batchOut.summary.dispositions.full_annual_qualifying, 1);
  assert.equal(batchOut.summary.dispositions.crossing_30pct_interval, 1);
  assert.equal(batchOut.summary.dispositions.hard_excluded, 1);
});

test('Slice 2B: r59 3-Tier Progressive Suggested Bid (Tier 1 long-tail non-veto, Tier 2 SIF cpc_raise_exact & SS down_only, Tier 3 cold-start parent proxy & exhausted 0/15 deduction)', () => {
  // Tier 1 + Tier 2: 2 mid-core purchase terms where 2nd term has null fixed exact in SIF,
  // but SIF already returned "提高和降低（精准）" cpc_raise_exact = $0.80, plus unbid ultra-long-tail opportunistic list!
  const candTier2 = structuredClone(fixture.candidates[0]);
  candTier2.id = 'cand-bid-tier2';
  const bidEv = candTier2.bids.evidence[0];
  candTier2.bids = {
    marketplace: 'US',
    currency: 'USD',
    match_type: 'exact',
    volume_period: '2026-10',
    selection_reason: '2 mid-core purchase entries; ultra-long-tail 6-word queries moved to opportunistic list.',
    evidence: [bidEv],
    long_tail_opportunistic_terms: [
      { query: 'modular desk cable organizer tray clamp', volume: 240, note: '超长尾捡漏词，同行未单独建精准词组，不锁死主分' },
    ],
    entries: [
      {
        query: 'desk cable tray',
        volume: { value: 3000, unit: 'searches_per_month', period: '2026-10', evidence: [bidEv] },
        sellersprite: { value: 1.10, low: 0.85, high: 1.40, unit: 'USD', match_type: 'exact', strategy: 'unspecified', channel: 'ss_mcp', evidence: [bidEv] },
        sif: { value: 1.00, low: 0.80, high: 1.25, unit: 'USD', match_type: 'exact', strategy: 'fixed', evidence: [bidEv] },
      },
      {
        query: 'under desk wire basket',
        volume: { value: 1000, unit: 'searches_per_month', period: '2026-10', evidence: [bidEv] },
        sellersprite: null,
        sif: {
          value: null,
          cpc_raise_exact: 0.80,
          cpc_raise_exact_low: 0.60,
          cpc_raise_exact_high: 1.00,
          unit: 'USD',
          match_type: 'exact',
          strategy: 'up_and_down',
          evidence: [bidEv],
        },
      },
    ],
  };

  // Under r58, strategy 'up_and_down' / 'down_only' is rejected -> needs_evidence
  const r58Bid = scoreCandidate(candTier2, r58Profile).items.find(i => i.id === 'relevant_purchase_entry_bid');
  assert.equal(r58Bid.status, 'needs_evidence');

  // Under r59, Tier 1 + Tier 2 resolves cleanly at 0 extra browser wait!
  // Entry 1: (1.10 + 1.00)/2 = 1.05 * 0.75 = 0.7875; Entry 2: 0.80 * 0.25 = 0.2000 => B = 0.9875
  const r59Bid = scoreCandidate(candTier2, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid');
  assert.equal(r59Bid.status, 'scored');
  assert.ok(Math.abs(r59Bid.reference_bid_usd - 0.9875) < 1e-6);
  assert.equal(r59Bid.entries[1].sources.sif.tier_used, 'tier2_sif_raise_exact');
  assert.match(r59Bid.entries[1].sources.sif.strategy_fallback_note, /提高和降低（精准）/);
  assert.equal(r59Bid.long_tail_opportunistic_terms.length, 1);

  // Tier 3a: 1688 factory cold-start novel item with zero dedicated US search term -> parent_functional_proxy
  const candColdStart = structuredClone(fixture.candidates[0]);
  candColdStart.id = 'cand-cold-start-proxy';
  candColdStart.bids = {
    marketplace: 'US',
    currency: 'USD',
    match_type: 'exact',
    entry_scope: 'parent_functional_proxy',
    proxy_reason: '1688 工厂冷启动分格收纳盒在美亚尚无专属大词，取最贴近上位功能词 modular storage tray 参考。',
    selection_reason: 'Cold-start novel form scored via closest parent functional query.',
    evidence: [bidEv],
    entries: [
      {
        query: 'modular storage tray',
        sellersprite: { value: 0.90, unit: 'USD', match_type: 'exact', strategy: 'down_only', channel: 'ss_web', evidence: [bidEv] },
      },
    ],
  };
  const r59ProxyBid = scoreCandidate(candColdStart, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid');
  assert.equal(r59ProxyBid.status, 'scored');
  assert.equal(r59ProxyBid.entry_scope, 'parent_functional_proxy');
  assert.equal(r59ProxyBid.scope_badge, '美亚尚无专属词 · 按上位词参考');

  // Tier 3b: All 3 tiers exhausted and still zero bids anywhere -> deducts the 15 pts (scores 0/15, NOT 15/15 and NOT deadlocked!)
  const candUnbidZero = structuredClone(fixture.candidates[0]);
  candUnbidZero.id = 'cand-unbid-deduct-15';
  candUnbidZero.bids = {
    marketplace: 'US',
    currency: 'USD',
    match_type: 'exact',
    unbid_after_all_tiers: true,
    selection_reason: 'Exhausted SellerSprite MCP, SIF fixed+raise, and SellerSprite Web real-time bid; zero exact bids returned.',
    evidence: [bidEv],
    entries: [{ query: 'ultra novel unindexed craft tool' }],
  };
  const r59Unbid = scoreCandidate(candUnbidZero, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid');
  assert.equal(r59Unbid.status, 'scored');
  assert.equal(r59Unbid.score, 0, 'Must deduct 15 points (score 0/15), never award 15/15 on missing bids');
  assert.deepEqual(r59Unbid.score_range, [0, 0]);
});

test('Slice 2C: r59 target_child_units grain on demand & Q31 newcomer cohort + mature-only T reference + child SIF & parent-evidence guard', () => {
  const candChild = structuredClone(fixture.candidates[0]);
  candChild.id = 'cand-child-grain';
  const demandEv = candChild.metrics.purchase_demand_scale.evidence;
  candChild.metrics.purchase_demand_scale = {
    value_range: [100, 199],
    coherent: true,
    range_basis: 'Synthetic child-variant monthly unit range across target spec',
    unit: 'units',
    window_days: 30,
    window_basis: 'latest_30_days',
    coverage_supported: true,
    deduplicated: true,
    niche: 'synthetic modular desk shelf child spec',
    period: '2026-10-22/2026-11-20',
    grain: 'target_child_units',
    evidence: demandEv,
  };
  candChild.newcomer_cohort.grain = 'target_child_units';
  candChild.newcomer_cohort.market_reference.grain = 'target_child_units';
  candChild.newcomer_cohort.market_reference.scope = 'current_relevant_bsr_top100_mature_only';
  candChild.newcomer_cohort.market_reference.mature_age_floor_days = 90;

  // Ensure member/reference units_30d explicitly declare target_child_units and natural visibility uses child-level SIF
  for (const m of candChild.newcomer_cohort.members) {
    if (m.units_30d) m.units_30d.grain = 'target_child_units';
    if (m.natural) {
      m.natural.view_grain = 'child_asin';
      m.natural.request = { isListingSearch: false, timePieceType: 'latelyDay', timePieceValue: '30' };
    }
  }
  for (const f of candChild.newcomer_cohort.market_reference.families) {
    if (f.units_30d) f.units_30d.grain = 'target_child_units';
  }

  // r58 rejects target_child_units; r59 scores both demand range and Q31 cleanly!
  const r58Out = scoreCandidate(candChild, r58Profile);
  assert.equal(r58Out.items.find(i => i.id === 'purchase_demand_scale').status, 'needs_evidence');
  assert.equal(r58Out.items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  const r59Out = scoreCandidate(candChild, r59Profile);
  const demItem = r59Out.items.find(i => i.id === 'purchase_demand_scale');
  const lowItem = r59Out.items.find(i => i.id === 'low_rating_sales_performance');
  const natItem = r59Out.items.find(i => i.id === 'natural_visibility_development');
  assert.equal(demItem.status, 'scored');
  assert.equal(lowItem.status, 'scored');
  assert.equal(natItem.status, 'scored');

  // Omitting units_30d.grain on a target_child_units cohort member must be rejected!
  const candOmittedMemberGrain = structuredClone(candChild);
  delete candOmittedMemberGrain.newcomer_cohort.members[0].units_30d.grain;
  assert.equal(
    scoreCandidate(candOmittedMemberGrain, r59Profile).items.find(i => i.id === 'low_rating_sales_performance').status,
    'needs_evidence',
  );

  // Referencing parent-aggregated sales evidence on a target_child_units cohort must be rejected!
  const candParentSalesEv = structuredClone(candChild);
  candParentSalesEv.evidence.push({
    id: 'ev-parent-agg-sales',
    grain: 'parent_units',
    source: 'Synthetic parent family monthlySales aggregated across all variants',
    observed_at: '2026-11-20',
  });
  candParentSalesEv.newcomer_cohort.members[0].units_30d.evidence = ['ev-parent-agg-sales'];
  assert.equal(
    scoreCandidate(candParentSalesEv, r59Profile).items.find(i => i.id === 'low_rating_sales_performance').status,
    'needs_evidence',
  );

  // Parent-aggregated SIF (isListingSearch: true) on target_child_units cohort must be blocked!
  const candBadParentSif = structuredClone(candChild);
  const qualMem = candBadParentSif.newcomer_cohort.members.find(m => m.status === 'qualified');
  qualMem.natural.request = { isListingSearch: true, timePieceType: 'latelyDay', timePieceValue: '30' };
  const badNatOut = scoreCandidate(candBadParentSif, r59Profile).items.find(i => i.id === 'natural_visibility_development');
  assert.equal(badNatOut.status, 'needs_evidence');
});

test('Slice 2D: 1688 Stage-1 pack_multiple=1 default, strict UI readback guards, private_mold_reserved, shared lineage, multi-quote Gate 1B, and honest report badges', async () => {
  // 1) Stage-1 1688 quote omitting pack_multiple defaults to 1 with carton_pack_unverified_stage1: true
  const stage1Quote = validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    stage: 'stage1_initial',
    status: 'verified',
    observed_at: '2026-11-22T12:00:00Z',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'ev-1688-stage1',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [
      { offer_id: 'offer-synth-1', sku_id: 'sku-synth-box', qty_per_saleable_set: 1, moq_qty: 50, ordered_qty: 100, unit_price_cny: 25, regular_goods_promo_false: true },
    ],
    goods_cny_total: 2500,
    domestic_freight_cny_total: 250,
    ui_readback: {
      logged_in: true,
      viewport_width_px: 1440,
      selected_sku_row_visible: true,
      settlement_bar_visible: true,
      applied_quantity_confirmed: true,
    },
  });
  assert.equal(stage1Quote.valid, true);
  assert.equal(stage1Quote.carton_pack_unverified_stage1, true);
  assert.equal(stage1Quote.stage2_sample_check_tag, '整箱装箱率待向客服核实');

  // Logged-out screenshot, cropped freight bar, or platform subsidy in freight (可再减) must reject!
  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    stage: 'stage1_initial',
    status: 'verified',
    observed_at: '2026-11-22T12:00:00Z',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'ev-logged-out',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'off-1', sku_id: 'sku-1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 150, regular_goods_promo_false: true }],
    goods_cny_total: 15000,
    domestic_freight_cny_total: 300,
    ui_readback: { logged_in: false, viewport_width_px: 1440, selected_sku_row_visible: false, settlement_bar_visible: true },
  }), /logged_in/i);

  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1,
    contract: 'SourcingVerifier1688',
    stage: 'stage1_initial',
    status: 'verified',
    observed_at: '2026-11-22T12:00:00Z',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'ev-subsidy',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    includes_platform_subsidy_in_freight: true,
    sku_lines: [{ offer_id: 'off-2', sku_id: 'sku-2', pack_multiple: 1, qty_per_saleable_set: 2, moq_qty: 10, ordered_qty: 200, unit_price_cny: 22, regular_goods_promo_false: true }],
    goods_cny_total: 4400,
    domestic_freight_cny_total: 310,
  }), /platform_subsidy|可再减/i);

  // 2) Store: station_verification link role, shared receipt lineage across split sub-forms, private_mold_reserved, and multi-quote r59 Gate 1B
  const store = openSelectionStore(':memory:');
  const validUiReadback = {
    logged_in: true,
    viewport_width_px: 1440,
    selected_sku_row_visible: true,
    settlement_bar_visible: true,
    applied_quantity_confirmed: true,
  };
  try {
    const sharedAttempt = store.reserveRequestAttempt({
      account_scope: 'synth-test',
      provider: 'sellersprite',
      tool_name: 'product_research',
      observation_cutoff_date: '2026-11-22',
      params: { keyword: 'modular desk caddy' },
      stage: 'discovery',
      estimated_ss_mcp_units: 1,
    });
    store.markAttemptInFlight(sharedAttempt.attempt_id);
    store.completeAttempt(sharedAttempt.attempt_id, {
      payload: { items: [] },
      ss_mcp_units: 1,
    });

    store.upsertRawLead({
      lead_id: 'lead-pin-desk',
      phrase_or_title: 'modular walnut desk caddy',
      source_channel: 'pinterest_visual_pick',
      source_ref: 'https://www.pinterest.com/pin/123456789/',
      observed_at: '2026-11-22',
      disposition: 'product',
      metadata: { shared_attempt_ids: [sharedAttempt.attempt_id] },
    });
    store.upsertRawLead({
      lead_id: 'lead-ss-verify',
      phrase_or_title: 'tabletop desk caddy',
      source_channel: 'keyword_research',
      source_ref: 'https://www.sellersprite.com/synth-verify',
      observed_at: '2026-11-22',
      disposition: 'context',
      source_attempt_id: sharedAttempt.attempt_id,
    });

    store.upsertCandidateForm({
      form_id: 'form-synth-desk-caddy',
      product_family_key: 'synth-desk-caddy',
      label: '合成桌面收纳架测试款',
      buyer_task: 'Organize desktop stationery upright on tabletop',
      saleable_set_composition: [{ component_id: 'stand-set', qty_per_saleable_set: 1 }],
    });
    store.linkLeadToForm({ lead_id: 'lead-pin-desk', form_id: 'form-synth-desk-caddy', link_role: 'primary_discovery' });
    store.linkLeadToForm({ lead_id: 'lead-ss-verify', form_id: 'form-synth-desk-caddy', link_role: 'station_verification' });

    const lineage = store.traceFormLineage('form-synth-desk-caddy');
    assert.equal(lineage.primary_discovery_leads.length, 1);
    assert.equal(lineage.station_verification_leads.length, 1);
    assert.ok(lineage.ledger_attempts.some(a => a.attempt_id === sharedAttempt.attempt_id), 'Shared receipt attempt must be linked in lineage');

    // Private-mold reserve routing in Gate 1B
    const baseFeeScenario = {
      id: 'sc-mature-1',
      price_usd: 41.00,
      pkg: { length_in: 13.5, width_in: 5.5, height_in: 3.0, unit_weight_lb: 1.8 },
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 2.2,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-09-30' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-01-15' },
    };
    const g1a = runGate1AForForm(store, {
      form_id: 'form-synth-desk-caddy',
      scenarios: [baseFeeScenario],
    });
    assert.equal(g1a.proceed_to_gate1b, true);

    const g1bPriv = await runGate1BForForm(store, {
      form_id: 'form-synth-desk-caddy',
      sourcing_executor: async () => ({
        status: 'no_public_mold_private_only',
        reason: '1688 仅见专利私模定制款，无开放公模现货，转入私模储备池。',
      }),
    });
    assert.equal(g1bPriv.status, 'private_mold_reserved');
    assert.equal(store.getCandidateForm('form-synth-desk-caddy').effective_lifecycle_status, 'private_mold_reserved');

    // Multi-quote Gate 1B under r59: Factory A passes >=30%, Factory B is <30% -> crosses_30pct auto-proceeds in r59 with negotiation_shortlist: null!
    store.upsertCandidateForm({
      form_id: 'form-multi-factory-r59',
      product_family_key: 'multi-factory-r59',
      label: '多厂比价跨30%合成测试款',
      buyer_task: 'Organize modular desktop supplies on workbench',
      saleable_set_composition: [{ component_id: 'rack-set', qty_per_saleable_set: 1 }],
    });
    const g1aMulti = runGate1AForForm(store, {
      form_id: 'form-multi-factory-r59',
      scenarios: [{ ...baseFeeScenario, price_usd: 44.00 }],
    });
    assert.equal(g1aMulti.proceed_to_gate1b, true);

    const qPass = store.recordSourcingQuote1688({
      quote_id: 'quote-factory-pass',
      form_id: 'form-multi-factory-r59',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-q-pass',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: baseFeeScenario.pkg,
      ui_readback: validUiReadback,
      sku_lines: [{ component_id: 'rack-set', offer_id: 'off-a', sku_id: 'sku-a', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 35, regular_goods_promo_false: true }],
      goods_cny_total: 3500,
      domestic_freight_cny_total: 250,
    }).quote;

    const qFail = store.recordSourcingQuote1688({
      quote_id: 'quote-factory-high',
      form_id: 'form-multi-factory-r59',
      observed_at: '2026-11-22T10:05:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-q-fail',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: baseFeeScenario.pkg,
      ui_readback: validUiReadback,
      sku_lines: [{ component_id: 'rack-set', offer_id: 'off-b', sku_id: 'sku-b', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 120, regular_goods_promo_false: true }],
      goods_cny_total: 12000,
      domestic_freight_cny_total: 600,
    }).quote;

    const decl0 = g1aMulti.declared_scenarios[0];
    const cuFt = (baseFeeScenario.pkg.length_in * baseFeeScenario.pkg.width_in * baseFeeScenario.pkg.height_in) / 1728;
    const g1bMulti = await runGate1BForForm(store, {
      form_id: 'form-multi-factory-r59',
      existing_quotes: [qPass, qFail],
      profile_revision: 59,
      as_of_date: '2026-11-22',
      early_screen_builder: () => ({
        profile_revision: 58,
        id: decl0.id,
        saleable_unit: '1 rack set',
        price_usd: decl0.price_usd,
        fx_cny_per_usd: decl0.fx_cny_per_usd,
        pkg: baseFeeScenario.pkg,
        headhaul: { usd_per_unit: decl0.headhaul_usd, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: baseFeeScenario.referral_terms,
        fulfillment_usd: decl0.fulfillment_usd,
        placement_usd: decl0.placement_range_usd[1],
        storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
        fee_context: {
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pack-rack',
          sales: baseFeeScenario.sales_window,
          storage: baseFeeScenario.storage_window,
          inbound: baseFeeScenario.inbound_window,
        },
        collection_rate: 0.005,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }),
    });
    assert.equal(g1bMulti.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bMulti.proceed_to_gate2_3, true, 'r59 crossing-30% multi-quote must auto-proceed to Gate 2/3');
    assert.equal(g1bMulti.negotiation_shortlist, null, 'Crossing-30% form must never enter negotiation_shortlist');
    assert.deepEqual(g1bMulti.passing_quote_ids, ['quote-factory-pass']);
    assert.deepEqual(g1bMulti.failing_quote_ids, ['quote-factory-high']);

    const funnel = buildFunnelLedger(store.db, null);
    assert.equal(funnel.candidates.private_mold_reserved, 1);
  } finally {
    store.close();
  }

  // 3) Report honesty: partial-pending scenario never lights green '+X pts 高于红线', Astra pending/conflict badge is state-pending, AND unadorned r58 SHA-256 is untouched!
  const cleanR58Scored = scoreBatch(structuredClone(fixture), r58Profile);
  const cleanR58Html = renderReport(cleanR58Scored, structuredClone(fixture));
  const cleanR58Sha = createHash('sha256').update(Buffer.from(cleanR58Html, 'utf8')).digest('hex');
  assert.equal(cleanR58Sha, '1d5f071d7e75ac6fb030eafcf9b06b5408952b1cf401a7168c529bd362901062');

  // Partial-pending candidate: Scenario 1 passes (>=30%), Scenario 2 has pending domestic_freight
  const partialCand = structuredClone(fixture.candidates[0]);
  partialCand.id = 'cand-partial-pending';
  const sc1 = structuredClone(partialCand.economics.scenarios[0]);
  sc1.id = sc1.cost_ledger.id = 'sc-ok';
  const sc2 = structuredClone(sc1);
  sc2.id = sc2.cost_ledger.id = 'sc-pend';
  Object.assign(sc2.cost_ledger.lines.find(l => l.id === 'domestic_freight'), {
    status: 'pending',
    amount_usd: null,
  });
  partialCand.economics.scenarios = [sc1, sc2];
  if (Array.isArray(partialCand.economics.expected_primary_scenarios)) {
    partialCand.economics.expected_primary_scenarios = [
      { id: 'sc-ok', status: 'active' },
      { id: 'sc-pend', status: 'active' },
    ];
  }
  const partialBatch = { schema_version: 1, profile_revision: 59, candidates: [partialCand] };
  const partialScored = scoreBatch(partialBatch, r59Profile);
  const partialHtml = renderReport(partialScored, partialBatch);
  assert.doesNotMatch(partialHtml, /高于红线/, 'Partial-pending scenarios must NEVER render green +pts 高于红线');

  // Gate-4 Astra evidence review with pending subjects/contradictions renders state-pending (amber), NOT state-pass (green)!
  const tempReceiptDir = mkdtempSync(join(tmpdir(), 'r59-evrev-'));
  try {
    const revBatch = { schema_version: 1, profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
    const rawPkt = {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-amber-check',
      execution_policy_ref: 'local-authorized-policy',
      candidate: { subject_id: revBatch.candidates[0].id, intended_use: 'Test', saleable_spec: { pcs: 1 }, unknown_fields: [] },
      subjects: [{ subject_id: 'sub-1', spec: { pcs: 1 } }],
      criteria: { criteria_version: 'r59-v1', rules: [{ criterion_id: 'c1', description: 'Spec', required: true }] },
      questions: [{ question_id: 'q1', question: 'Confirmed?', subject_ids: ['sub-1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'ev1', subject_ids: ['sub-1'], summary: 'Ambiguous', kind: 'fact', source_ref: 's1', observed_at: '2026-11-22', window: '2026-10-24..2026-11-22', grain: 'sku', units: 'pc', limitations: null }],
    };
    const frozenPkt = freezeEvidenceReviewPacket(rawPkt);
    const execEnv = await runCodexEvidenceReview(rawPkt, {
      enabled: true,
      testMode: true,
      reasoningEffort: 'max',
      receiptDir: tempReceiptDir,
      candidateId: revBatch.candidates[0].id,
      mockExecutor: async ({ outputFilePath }) => {
        writeFileSync(outputFilePath, JSON.stringify({
          schema_version: 'evidence-review-draft-v1',
          review_id: 'rev-amber-check',
          packet_sha256: frozenPkt.packet_sha256,
          subjects: [{ subject_id: 'sub-1', disposition: 'pending', criterion_ids: ['c1'], evidence_ids: ['ev1'], reason: 'Needs check.' }],
          answers: [{ question_id: 'q1', status: 'pending', basis: 'fact', evidence_ids: ['ev1'], explanation: 'Pending.' }],
          contradictions: [],
          gaps: [{ subject_ids: ['sub-1'], criterion_ids: ['c1'], question_ids: ['q1'], evidence_ids: [], missing_information: 'Spec sheet', why_it_matters: 'Weight', resolution_evidence: 'Sample' }],
          conclusion: 'Pending spec sheet.',
        }), 'utf8');
        return { exitCode: 0 };
      },
    });
    attachCandidateEvidenceReview(revBatch.candidates[0], execEnv, frozenPkt, {
      receiptStoreDir: tempReceiptDir,
      allowTestDoubleReceipt: true,
    });
    const revScored = scoreBatch(revBatch, r59Profile);
    const revHtml = renderReport(revScored, revBatch, { receiptStoreDir: tempReceiptDir, allowTestDoubleReceipts: true });
    const auditBlock = revHtml.match(/<section[^>]*data-section="evidence-review"[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.match(auditBlock, /state-pending[\s\S]*已复核/, 'Astra review with pending items/gaps must use amber state-pending');
    assert.doesNotMatch(auditBlock, /state-pass"><i class="dot" aria-hidden="true"><\/i>已复核/, 'Must not render green state-pass when items are pending');
  } finally {
    rmSync(tempReceiptDir, { recursive: true, force: true });
  }
});

test('Astra Round-1 Regressions (Scoring & Pipeline): BLOCKER 3 multi-quote Stage-3 matrix parity & strict quote_id, HIGH 2 $50.00 interior cliff, HIGH 3b strict_mature_only & all-young niche, HIGH 4 atomic quotes & SQLite carton tag, HIGH 5/6/7 bid/grain/qualifying guards', async () => {
  // 1) HIGH 5: >3 main bid entries rejected in r59; contradictory unbid_after_all_tiers rejected; ss_web ignored when SIF fixed exists & rejected with unspecified strategy
  const cand4Bids = structuredClone(fixture.candidates[0]);
  cand4Bids.id = 'cand-4-main-bids';
  const bEv = cand4Bids.bids.evidence[0];
  cand4Bids.bids.entries = ['term a', 'term b', 'term c', 'term d'].map(q => ({
    query: q,
    volume: { value: 500, unit: 'searches_per_month', period: '2026-10', evidence: [bEv] },
    sellersprite: null,
    sif: { value: 0.80, unit: 'USD', match_type: 'exact', strategy: 'fixed', evidence: [bEv] },
  }));
  assert.equal(scoreCandidate(cand4Bids, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid').status, 'needs_evidence');

  const candContradictUnbid = structuredClone(fixture.candidates[0]);
  candContradictUnbid.bids.unbid_after_all_tiers = true;
  assert.equal(scoreCandidate(candContradictUnbid, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid').status, 'needs_evidence');

  const candSifPlusWeb = structuredClone(fixture.candidates[0]);
  candSifPlusWeb.bids.entries = [{
    query: 'niche organizer',
    sellersprite: { value: 4.00, unit: 'USD', match_type: 'exact', strategy: 'unspecified', channel: 'ss_web', evidence: [bEv] },
    sif: { value: 0.50, unit: 'USD', match_type: 'exact', strategy: 'fixed', evidence: [bEv] },
  }];
  candSifPlusWeb.bids.single_entry_support = { status: 'verified', reason: 'Sole core query', evidence: [bEv] };
  const sifWebRes = scoreCandidate(candSifPlusWeb, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid');
  assert.equal(sifWebRes.status, 'scored');
  assert.equal(sifWebRes.reference_bid_usd, 0.50, 'ss_web Tier-3 fallback must NOT average $4.00 into existing SIF $0.50 fixed bid');

  // 2) HIGH 6: Q31 rejects mixed member/reference units_30d.grain vs cohort.grain
  const candGrainMismatch = structuredClone(fixture.candidates[0]);
  candGrainMismatch.newcomer_cohort.grain = 'target_child_units';
  candGrainMismatch.newcomer_cohort.market_reference.grain = 'target_child_units';
  candGrainMismatch.newcomer_cohort.members[0].units_30d.grain = 'parent_family_units';
  assert.equal(scoreCandidate(candGrainMismatch, r59Profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'needs_evidence');

  // 3) HIGH 7: private_mold_reserved complete candidate has summary.qualifying === 0; crossing-30% card excluded from negotiation_shortlist; missing declared off_peak scenario never lights green 高于红线
  const privCand = structuredClone(fixture.candidates[0]);
  privCand.id = 'cand-priv-reserve-check';
  privCand.sourcing_disposition = 'private_mold_reserved';
  const privBatchRes = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [privCand] }, r59Profile);
  assert.equal(privBatchRes.summary.qualifying, 0, 'private_mold_reserved must never count toward qualifying');
  assert.equal(privBatchRes.summary.dispositions.private_mold_reserved, 1);

  const crossCand = structuredClone(fixture.candidates[0]);
  crossCand.id = 'cand-cross-neg-block';
  const scWin = structuredClone(crossCand.economics.scenarios[0]);
  scWin.id = scWin.cost_ledger.id = 'sc-win';
  const scLose = structuredClone(scWin);
  scLose.id = scLose.cost_ledger.id = 'sc-lose';
  scLose.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 22.0;
  crossCand.economics.scenarios = [scWin, scLose];
  crossCand.economics.expected_primary_scenarios = [{ id: 'sc-win', status: 'active' }, { id: 'sc-lose', status: 'active' }];
  const crossBatch = {
    schema_version: 1,
    profile_revision: 59,
    negotiation_shortlist: [{ form_id: 'cand-cross-neg-block', label: 'Stale negotiation row', required_discount_fraction: 0.08 }],
    candidates: [crossCand],
  };
  const crossScored = scoreBatch(crossBatch, r59Profile);
  assert.equal((crossScored.negotiation_shortlist ?? []).length, 0, 'Crossing-30% card must NOT remain in negotiation_shortlist');
  const crossHtml = renderReport(crossScored, crossBatch);
  assert.doesNotMatch(crossHtml, /Stale negotiation row|8\.0%/, 'HTML negotiation appendix must NOT re-merge stale Crossing-30% negotiation rows');

  const droppedOffPeakCand = structuredClone(fixture.candidates[0]);
  droppedOffPeakCand.id = 'cand-dropped-offpeak';
  const singlePass = structuredClone(droppedOffPeakCand.economics.scenarios[0]);
  singlePass.id = singlePass.cost_ledger.id = 'sc-only-pass';
  droppedOffPeakCand.economics = {
    saleable_unit: droppedOffPeakCand.economics.saleable_unit,
    operating_periods: [{
      id: 'off_peak',
      label: '淡季',
      months: [2, 3, 4, 5, 6, 7, 8, 9],
      expected_primary_scenarios: [{ id: 'sc-only-pass', status: 'active' }, { id: 'sc-omitted-fail', status: 'active' }],
      scenarios: [singlePass],
    }],
  };
  const droppedBatch = { schema_version: 1, profile_revision: 59, candidates: [droppedOffPeakCand] };
  const droppedHtml = renderReport(scoreBatch(droppedBatch, r59Profile), droppedBatch);
  assert.doesNotMatch(droppedHtml, /高于红线/, 'Omitted expected_primary_scenario must NEVER light green 高于红线');

  // 4) HIGH 2, HIGH 3b, HIGH 4, and BLOCKER 3 end-to-end in SelectionStore + runGate1AForForm / runGate1BForForm / runPhase2Batch
  const store = openSelectionStore(':memory:');
  try {
    const baseSc = {
      id: 'sc-base',
      price_usd: 40.00,
      available_date: '2025-05-01',
      pkg: { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 },
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 2.0,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-09-30' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-01-15' },
    };

    // HIGH 3b-1: Mature ceiling $28 + 50-day newcomer $31 under strict_mature_only MUST reject (cannot pass on young newcomer!)
    store.upsertCandidateForm({
      form_id: 'form-strict-mature-reject',
      product_family_key: 'strict-mature-reject',
      label: 'Strict mature reject test',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    const g1aStrictReject = runGate1AForForm(store, {
      form_id: 'form-strict-mature-reject',
      price_band_analysis: {
        options: { as_of_date: '2026-11-22', strict_mature_only: true },
        listings: [
          { asin: 'B0MAT28001', price_usd: 28, fulfillment: 'FBA', monthlySales: 120, availableDate: '2025-05-01', keepa_price_steady: true },
          { asin: 'B0MAT28002', price_usd: 27.5, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-06-01', keepa_price_steady: true },
          { asin: 'B0YNG31001', price_usd: 31, fulfillment: 'FBA', monthlySales: 40, availableDate: '2026-10-03' },
        ],
      },
      scenarios: [
        { ...baseSc, id: 'sc-mat-28', asin: 'B0MAT28001', price_usd: 28, available_date: '2025-05-01' },
        { ...baseSc, id: 'sc-yng-31', asin: 'B0YNG31001', price_usd: 31, available_date: '2026-10-03' },
      ],
    });
    assert.equal(g1aStrictReject.gate_status, 'gate1a_rejected');

    // HIGH 3b-2: Niche with ONLY $25 <120d newcomers must return gate1a_needs_verification (NEVER gate1a_rejected!)
    store.upsertCandidateForm({
      form_id: 'form-all-young-25',
      product_family_key: 'all-young-25',
      label: 'All young $25 niche',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    const g1aAllYoung = runGate1AForForm(store, {
      form_id: 'form-all-young-25',
      price_band_analysis: {
        options: { as_of_date: '2026-11-22', strict_mature_only: true },
        listings: [
          { asin: 'B0YNG25001', price_usd: 25, fulfillment: 'FBA', monthlySales: 50, availableDate: '2026-10-05' },
          { asin: 'B0YNG25002', price_usd: 26, fulfillment: 'FBA', monthlySales: 45, availableDate: '2026-10-10' },
        ],
      },
      scenarios: [
        { ...baseSc, id: 'sc-yng-25', asin: 'B0YNG25001', price_usd: 25, available_date: '2026-10-05' },
      ],
    });
    assert.equal(g1aAllYoung.gate_status, 'gate1a_needs_verification');

    // HIGH 2: $49.99 & $50.01 both <30% while $50.00 interior cliff achieves >=30% -> Gate 1B returns crosses_30pct (NOT gate1b_rejected!)
    store.upsertCandidateForm({
      form_id: 'form-cliff-50-interior',
      product_family_key: 'cliff-50-interior',
      label: 'Interior $50.00 cliff test',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const g1aCliff = runGate1AForForm(store, {
      form_id: 'form-cliff-50-interior',
      scenarios: [
        { ...baseSc, id: 'sc-4999', price_usd: 49.99 },
        { ...baseSc, id: 'sc-5001', price_usd: 50.01 },
      ],
    });
    const cap50 = runGate1AForForm(store, {
      form_id: 'form-cliff-50-interior',
      scenarios: [
        { ...baseSc, id: 'sc-4999', price_usd: 49.99 },
        { ...baseSc, id: 'sc-5000', price_usd: 50.00 },
        { ...baseSc, id: 'sc-5001', price_usd: 50.01 },
      ],
    }).scenarios.find(s => s.id === 'sc-5000').estimate.landed_domestic_cap_cny;
    // Re-run Gate 1A with ONLY $49.99 and $50.01 declared!
    const g1aCliffOnly2 = runGate1AForForm(store, {
      form_id: 'form-cliff-50-interior',
      scenarios: [
        { ...baseSc, id: 'sc-4999', price_usd: 49.99 },
        { ...baseSc, id: 'sc-5001', price_usd: 50.01 },
      ],
    });
    const cap4999 = g1aCliffOnly2.scenarios[0].estimate.landed_domestic_cap_cny;
    const cap5001 = g1aCliffOnly2.scenarios[1].estimate.landed_domestic_cap_cny;
    const midUnitCny = Number((((Math.max(cap4999, cap5001) + cap50) / 2)).toFixed(2));
    const qCliff = store.recordSourcingQuote1688({
      quote_id: 'q-cliff-50',
      form_id: 'form-cliff-50-interior',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-cliff',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: baseSc.pkg,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
      sku_lines: [{ component_id: 'item', offer_id: 'off-c', sku_id: 'sku-c', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: midUnitCny, regular_goods_promo_false: true }],
      goods_cny_total: Number((midUnitCny * 100).toFixed(2)),
      domestic_freight_cny_total: 0,
    }).quote;
    const cuFtBase = (baseSc.pkg.length_in * baseSc.pkg.width_in * baseSc.pkg.height_in) / 1728;
    const g1bCliff = await runGate1BForForm(store, {
      form_id: 'form-cliff-50-interior',
      existing_quote: qCliff,
      profile_revision: 59,
      as_of_date: '2026-11-22',
      early_screen_builder: () => g1aCliffOnly2.declared_scenarios.map(d => ({
        profile_revision: 58,
        id: d.id,
        saleable_unit: '1 unit',
        price_usd: d.price_usd,
        fx_cny_per_usd: d.fx_cny_per_usd,
        pkg: baseSc.pkg,
        headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: baseSc.referral_terms,
        fulfillment_usd: d.fulfillment_usd,
        placement_usd: d.placement_range_usd[1],
        storage: { cubic_feet_per_unit: cuFtBase, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
        collection_rate: 0.005,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      })),
    });
    assert.equal(g1bCliff.status, 'gate1b_pending', 'Interior $50.00 cliff must NOT be gate1b_rejected');
    assert.equal(g1bCliff.margin_interval_verdict, 'crosses_30pct');
    assert.deepEqual(g1bCliff.interior_cliff_feasible_prices_usd, [50]);
    assert.ok(g1bCliff.margin_range[1] >= 0.30, `margin_range upper bound must include interior $50.00 >=30% point, got ${JSON.stringify(g1bCliff.margin_range)}`);

    // HIGH 4: SQLite persists carton_pack_unverified_stage1, and atomic 2-quote batch rolls back Quote #1 if Quote #2 fails!
    const persistedStage1 = store.recordSourcingQuote1688({
      quote_id: 'q-stage1-persist',
      form_id: 'form-cliff-50-interior',
      stage: 'stage1_initial',
      observed_at: '2026-11-22T12:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-st1',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: baseSc.pkg,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
      sku_lines: [{ component_id: 'item', offer_id: 'off-s1', sku_id: 'sku-s1', qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
      goods_cny_total: 4000,
      domestic_freight_cny_total: 200,
    }).quote;
    assert.equal(persistedStage1.carton_pack_unverified_stage1, true);
    assert.equal(persistedStage1.carton_verification_tag, '整箱装箱率待向客服核实');

    store.upsertCandidateForm({
      form_id: 'form-atomic-2q',
      product_family_key: 'atomic-2q',
      label: 'Atomic 2-quote rollback test',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    assert.throws(() => store.recordSourcingQuotesBatch1688([
      {
        quote_id: 'q-atomic-1',
        form_id: 'form-atomic-2q',
        stage: 'stage1_initial',
        observed_at: '2026-11-22T12:00:00Z',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-a1',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        fx_cny_per_usd: 7.2,
        pkg: baseSc.pkg,
        ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
        sku_lines: [{ component_id: 'item', offer_id: 'off-a1', sku_id: 'sku-a1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
        goods_cny_total: 3600,
        domestic_freight_cny_total: 200,
      },
      {
        quote_id: 'q-atomic-2-bad',
        form_id: 'form-atomic-2q',
        stage: 'stage1_initial',
        observed_at: '2026-11-22T12:00:00Z',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-a2',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        fx_cny_per_usd: 7.2,
        pkg: baseSc.pkg,
        ui_readback: { logged_in: true, viewport_width_px: 1200, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true }, // narrow viewport fails!
        sku_lines: [{ component_id: 'item', offer_id: 'off-a2', sku_id: 'sku-a2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 110, regular_goods_promo_false: true }],
        goods_cny_total: 11000,
        domestic_freight_cny_total: 500,
      },
    ]), /1440/);
    assert.equal(store.getQuotesForForm('form-atomic-2q').length, 0, 'Quote #1 MUST be rolled back when Quote #2 fails validation');

    // BLOCKER 3: Full runPhase2Batch with 2 quotes ($40 -> 49.23% vs 10.17%):
    //  (a) Stage 3 omitting losing quote MUST fail;
    //  (b) Stage 3 passing unknown quote_id MUST fail;
    //  (c) Stage 3 passing BOTH quotes with unique scenario IDs (sc-base-q1, sc-base-q2) succeeds AND scores counts_toward_target: false!
    const buildBaseItem = (formId, deepResearchExecutor) => ({
      form: {
        form_id: formId,
        product_family_key: formId,
        label: 'Multi-quote Stage 3 parity test',
        buyer_task: 'Store desktop tools',
        saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
      },
      leads: [{
        lead_id: `lead-${formId}`,
        phrase_or_title: 'desktop tool organizer',
        source_channel: 'keyword_research',
        source_ref: `https://www.sellersprite.com/${formId}`,
        observed_at: '2026-11-22',
        disposition: 'product',
        link_role: 'primary_discovery',
      }],
      gate1a_scenarios: [baseSc],
      sourcing_executor: async () => ({
        status: 'quoted',
        quotes: [
          {
            quote_id: `${formId}-q-win`,
            observed_at: '2026-11-22T10:00:00Z',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-qw',
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            fx_cny_per_usd: 7.2,
            pkg: baseSc.pkg,
            ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
            sku_lines: [{ component_id: 'item', offer_id: 'ow', sku_id: 'sw', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
            goods_cny_total: 3600,
            domestic_freight_cny_total: 360,
          },
          {
            quote_id: `${formId}-q-lose`,
            observed_at: '2026-11-22T10:05:00Z',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-ql',
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            fx_cny_per_usd: 7.2,
            pkg: baseSc.pkg,
            ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
            sku_lines: [{ component_id: 'item', offer_id: 'ol', sku_id: 'sl', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 135, regular_goods_promo_false: true }],
            goods_cny_total: 13500,
            domestic_freight_cny_total: 900,
          },
        ],
      }),
      early_screen_builder: () => ({
        profile_revision: 58,
        id: 'sc-base',
        saleable_unit: '1 unit',
        price_usd: 40.00,
        fx_cny_per_usd: 7.2,
        pkg: baseSc.pkg,
        headhaul: { usd_per_unit: 2.0, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: baseSc.referral_terms,
        fulfillment_usd: 5.00,
        placement_usd: 0.68,
        storage: { cubic_feet_per_unit: cuFtBase, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
        collection_rate: 0.005,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }),
      deep_research_executor: deepResearchExecutor,
    });

    const makeStage3ScenarioForQuote = (formId, qObj, decl) => {
      const sc = structuredClone(fixture.candidates[0].economics.scenarios[0]);
      sc.id = `sc-base-${qObj.quote_id}`;
      sc.quote_id = qObj.quote_id;
      sc.cost_ledger.id = sc.id;
      sc.cost_ledger.price_usd = decl.price_usd;
      sc.cost_ledger.fx_cny_per_usd = decl.fx_cny_per_usd;
      sc.cost_ledger.refund_fraction = 0.04;
      sc.cost_ledger.physical_return_fraction = 0.04;
      sc.cost_ledger.fee_context.sales = baseSc.sales_window;
      sc.cost_ledger.fee_context.storage = baseSc.storage_window;
      sc.cost_ledger.fee_context.inbound = baseSc.inbound_window;
      const proc = sc.cost_ledger.lines.find(l => l.id === 'procurement');
      proc.amount_usd = Number(((qObj.goods_cny_total / qObj.actual_sets) / decl.fx_cny_per_usd).toFixed(6));
      proc.order_units = 100;
      const dom = sc.cost_ledger.lines.find(l => l.id === 'domestic_freight');
      dom.amount_usd = Number(((qObj.domestic_freight_cny_total / qObj.actual_sets) / decl.fx_cny_per_usd).toFixed(6));
      dom.order_units = 100;
      const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
      hh.amount_usd = decl.headhaul_usd;
      const ful = sc.cost_ledger.lines.find(l => l.id === 'fulfillment');
      ful.amount_usd = decl.fulfillment_usd;
      ful.fee_basis.effective_from = '2027-01-15';
      ful.fee_basis.effective_through = '2027-10-14';
      const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
      plc.amount_usd = decl.placement_range_usd[1];
      plc.fee_basis.effective_from = '2027-01-15';
      plc.fee_basis.effective_through = '2027-12-31';
      const stor = sc.cost_ledger.lines.find(l => l.id === 'storage');
      stor.amount_usd = decl.storage_per_unit_usd;
      stor.fee_basis.effective_from = '2027-02-01';
      stor.fee_basis.effective_through = '2027-12-31';
      return sc;
    };

    // Fix fulfillment_usd in early_screen_builder dynamically from Gate 1A declared scenario
    const patchBuilder = item => {
      item.early_screen_builder = ({ form: f }) => {
        const g1aRec = JSON.parse(store.getCandidateForm(f.form_id).gate1a_result_json);
        const d = g1aRec.declared_scenarios[0];
        return {
          profile_revision: 58,
          id: d.id,
          saleable_unit: '1 unit',
          price_usd: d.price_usd,
          fx_cny_per_usd: d.fx_cny_per_usd,
          pkg: baseSc.pkg,
          headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true },
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          is_apparel_or_shoes: false,
          referral_terms: baseSc.referral_terms,
          fulfillment_usd: d.fulfillment_usd,
          placement_usd: d.placement_range_usd[1],
          storage: { cubic_feet_per_unit: cuFtBase, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
          collection_rate: 0.005,
          other_applicable_usd: 0,
          specific_rights_conflict: 'unknown',
          strong_date_dependency: false,
        };
      };
      return item;
    };

    // (a) Omitting losing quote in Stage 3 MUST fail Stage 3!
    const repOmit = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [patchBuilder(buildBaseItem('f-omit-lose', async ({ form: f, quotes }) => {
        const decl = JSON.parse(f.gate1a_result_json).declared_scenarios[0];
        const cand = structuredClone(fixture.candidates[0]);
        cand.id = f.form_id;
        const onlyWin = makeStage3ScenarioForQuote(f.form_id, quotes[0], decl);
        cand.economics.scenarios = [onlyWin];
        cand.economics.expected_primary_scenarios = [{ id: onlyWin.id, status: 'active' }];
        return { batch: { schema_version: 1, profile_revision: 59, candidates: [cand] } };
      }))],
    });
    assert.equal(repOmit.gate2_3[0].status, 'gate2_3_error');
    assert.match(repOmit.gate2_3[0].error, /scenario-quote pair|losing factory/i);

    // (b) Passing unknown quote_id in Stage 3 MUST fail (never fall back to first quote!)
    const repUnkQ = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [patchBuilder(buildBaseItem('f-unk-qid', async ({ form: f, quotes }) => {
        const decl = JSON.parse(f.gate1a_result_json).declared_scenarios[0];
        const cand = structuredClone(fixture.candidates[0]);
        cand.id = f.form_id;
        const s1 = makeStage3ScenarioForQuote(f.form_id, quotes[0], decl);
        s1.quote_id = 'nonexistent-quote-id';
        cand.economics.scenarios = [s1];
        cand.economics.expected_primary_scenarios = [{ id: s1.id, status: 'active' }];
        return { batch: { schema_version: 1, profile_revision: 59, candidates: [cand] } };
      }))],
    });
    assert.equal(repUnkQ.gate2_3[0].status, 'gate2_3_error');
    assert.match(repUnkQ.gate2_3[0].error, /unknown or unusable quote_id/i);

    // (c) Submitting BOTH quotes with unique scenario IDs succeeds AND keeps counts_toward_target: false!
    const repBoth = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [patchBuilder(buildBaseItem('f-both-quotes', async ({ form: f, quotes }) => {
        const decl = JSON.parse(f.gate1a_result_json).declared_scenarios[0];
        const cand = structuredClone(fixture.candidates[0]);
        cand.id = f.form_id;
        const sWin = makeStage3ScenarioForQuote(f.form_id, quotes[0], decl);
        const sLose = makeStage3ScenarioForQuote(f.form_id, quotes[1], decl);
        cand.economics = {
          saleable_unit: cand.economics.saleable_unit,
          operating_periods: [
            {
              id: 'off_peak',
              label: '淡季',
              months: [2, 3, 4, 5, 6, 7, 8, 9],
              expected_primary_scenarios: [{ id: sWin.id, status: 'active' }, { id: sLose.id, status: 'active' }],
              scenarios: [sWin, sLose],
            },
            {
              id: 'peak',
              label: '旺季',
              months: [10, 11, 12],
              expected_primary_scenarios: [{ id: `${sWin.id}-pk`, status: 'active' }, { id: `${sLose.id}-pk`, status: 'active' }],
              scenarios: [sWin, sLose].map(s => {
                const pk = structuredClone(s);
                pk.id = pk.cost_ledger.id = `${s.id}-pk`;
                pk.cost_ledger.fee_context.sales = { from: '2027-10-01', through: '2027-12-31' };
                pk.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
                pk.cost_ledger.fee_context.inbound = { from: '2027-09-01', through: '2027-10-01' };
                const fl = pk.cost_ledger.lines.find(l => l.id === 'fulfillment');
                fl.status = 'pending';
                fl.amount_usd = null;
                fl.fee_basis = { status: 'unavailable', version: 'Unpublished 2027 US Holiday Peak FBA fulfillment schedule', marketplace: 'US', currency: 'USD', package_ref: 'p1', year: 2027, months: [10, 11, 12] };
                const cl = pk.cost_ledger.lines.find(l => l.id === 'collection');
                cl.status = 'pending';
                cl.amount_usd = null;
                return pk;
              }),
            },
          ],
        };
        return { batch: { schema_version: 1, profile_revision: 59, candidates: [cand] } };
      }))],
    });
    assert.equal(repBoth.gate2_3[0].status, 'evaluated');
    assert.equal(repBoth.gate2_3[0].qualification.counts_toward_target, false, 'Crossing multi-quote card must NEVER count toward qualifying target');

    // (d) Round-2 BLOCKER 3a: Passing existing_quotes: [qWin] when SQLite ALSO holds qLose MUST merge qLose (cannot cherry-pick winning quote!)
    const preseededFormId = 'f-preseeded-subset-bypass';
    store.upsertCandidateForm({
      form_id: preseededFormId,
      product_family_key: preseededFormId,
      label: 'Preseeded 2-quote subset bypass guard',
      buyer_task: 'Store desktop tools',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const qPreWin = store.recordSourcingQuote1688({
      quote_id: `${preseededFormId}-q-win`,
      form_id: preseededFormId,
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-pw',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: baseSc.pkg,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
      sku_lines: [{ component_id: 'item', offer_id: 'ow', sku_id: 'sw', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
      goods_cny_total: 3600,
      domestic_freight_cny_total: 360,
    }).quote;
    store.recordSourcingQuote1688({
      quote_id: `${preseededFormId}-q-lose`,
      form_id: preseededFormId,
      observed_at: '2026-11-22T10:05:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-pl',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: baseSc.pkg,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
      sku_lines: [{ component_id: 'item', offer_id: 'ol', sku_id: 'sl', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 135, regular_goods_promo_false: true }],
      goods_cny_total: 13500,
      domestic_freight_cny_total: 900,
    });
    const cherryPickItem = patchBuilder(buildBaseItem(preseededFormId, async ({ form: f, quotes }) => {
      assert.equal(quotes.length, 2, 'Stage 3 must receive BOTH persisted quotes even when existing_quotes only passed qWin');
      const decl = JSON.parse(f.gate1a_result_json).declared_scenarios[0];
      const cand = structuredClone(fixture.candidates[0]);
      cand.id = f.form_id;
      const onlyWin = makeStage3ScenarioForQuote(f.form_id, quotes[0], decl);
      cand.economics.scenarios = [onlyWin];
      cand.economics.expected_primary_scenarios = [{ id: onlyWin.id, status: 'active' }];
      return { batch: { schema_version: 1, profile_revision: 59, candidates: [cand] } };
    }));
    delete cherryPickItem.sourcing_executor;
    cherryPickItem.existing_quotes = [qPreWin];
    const repCherry = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [cherryPickItem],
    });
    assert.equal(repCherry.gate1b[0].margin_interval_verdict, 'crosses_30pct', 'Gate 1B must merge losing quote from SQLite');
    assert.equal(repCherry.gate2_3[0].status, 'gate2_3_error', 'Cherry-picking only qWin must NEVER qualify');

    // (e) Round-2 HIGH 3: runPhase2Batch under r59 defaults strict_mature_only: true automatically without caller opt-in!
    const repAutoStrict = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [{
        form: {
          form_id: 'f-r59-default-strict-mature',
          product_family_key: 'r59-default-strict-mature',
          label: 'Default r59 strict mature band',
          buyer_task: 'Task',
          saleable_set_composition: { qty: 1 },
        },
        leads: [{
          lead_id: 'lead-auto-strict',
          phrase_or_title: 'synth item',
          source_channel: 'keyword_research',
          source_ref: 'https://www.sellersprite.com/synth-auto',
          observed_at: '2026-11-22',
          disposition: 'product',
          link_role: 'primary_discovery',
        }],
        price_band_analysis: {
          options: { as_of_date: '2026-11-22' }, // NO strict_mature_only flag passed!
          listings: [
            { asin: 'B0MAT28011', price_usd: 28, fulfillment: 'FBA', monthlySales: 120, availableDate: '2025-05-01' },
            { asin: 'B0MAT28012', price_usd: 27.5, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-06-01' },
            { asin: 'B0YNG31011', price_usd: 31, fulfillment: 'FBA', monthlySales: 40, availableDate: '2026-10-03' },
          ],
        },
        gate1a_scenarios: [
          { ...baseSc, id: 'sc-mat-28', asin: 'B0MAT28011', price_usd: 28, available_date: '2025-05-01' },
          { ...baseSc, id: 'sc-yng-31', asin: 'B0YNG31011', price_usd: 31, available_date: '2026-10-03' },
        ],
      }],
    });
    assert.equal(repAutoStrict.gate1a[0].gate_status, 'gate1a_rejected', 'r59 batch must enforce strict_mature_only by default');

    // (f) Round-2 HIGH 4: Explicitly passing require_ui_readback: false under r59 MUST throw!
    await assert.rejects(() => runGate1BForForm(store, {
      form_id: 'form-cliff-50-interior',
      profile_revision: 59,
      require_ui_readback: false,
      as_of_date: '2026-11-22',
      early_screen_builder: () => ({}),
    }), /Cannot disable require_ui_readback/i);
  } finally {
    store.close();
  }
});

test('Astra Round-2 CLI & Bid Contradiction Regressions: phase2-cli gate1b --profile-revision 59 enforces ui_readback + multi-quote parity, and per-entry all_tiers_exhausted contradiction fails', () => {
  // 1) Per-entry all_tiers_exhausted: true + usable bid value fails scoring
  const candEntryContradict = structuredClone(fixture.candidates[0]);
  const bEv = candEntryContradict.bids.evidence[0];
  candEntryContradict.bids.entries = [{
    query: 'synth shelf',
    all_tiers_exhausted: true,
    sellersprite: null,
    sif: { value: 0.60, unit: 'USD', match_type: 'exact', strategy: 'fixed', evidence: [bEv] },
  }];
  candEntryContradict.bids.single_entry_support = { status: 'verified', reason: 'Sole term', evidence: [bEv] };
  assert.equal(scoreCandidate(candEntryContradict, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid').status, 'needs_evidence');

  // 2) Standalone phase2-cli gate1b --profile-revision 59 subprocess checks
  const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const cliPath = join(repoRoot, 'src', 'phase2-cli.mjs');
  const tmp = mkdtempSync(join(tmpdir(), 'r59-cli-g1b-'));
  try {
    const dbPath = join(tmp, 'cli-g1b.sqlite');
    const g1aSpecPath = join(tmp, 'g1a.json');
    const g1bNoUiPath = join(tmp, 'g1b-no-ui.json');
    const g1bTwoQuotesPath = join(tmp, 'g1b-2q.json');

    assert.equal(spawnSync(process.execPath, [cliPath, 'init', '--db', dbPath], { encoding: 'utf8' }).status, 0);

    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    writeFileSync(g1aSpecPath, JSON.stringify({
      form: {
        form_id: 'form-cli-r59-g1b',
        product_family_key: 'cli-r59-g1b',
        label: 'CLI r59 Gate 1B test',
        buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
      },
      scenarios: [{
        id: 'sc-cli-40',
        price_usd: 40.00,
        available_date: '2025-05-01',
        pkg,
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
        headhaul_usd: 2.0,
        collection_rate: 0.005,
        other_applicable_usd: 0,
        sales_window: { from: '2027-02-01', through: '2027-09-30' },
        storage_window: { from: '2027-02-01', through: '2027-09-30' },
        inbound_window: { from: '2027-01-15', through: '2027-01-15' },
      }],
    }), 'utf8');

    const r1a = spawnSync(process.execPath, [cliPath, 'gate1a', '--db', dbPath, '--input', g1aSpecPath, '--profile-revision', '59'], { encoding: 'utf8' });
    assert.equal(r1a.status, 0, r1a.stderr);
    const decl = JSON.parse(r1a.stdout).result.declared_scenarios[0];
    const cuFt = (12 * 8 * 4) / 1728;
    const earlyScreen = {
      profile_revision: 58,
      id: decl.id,
      saleable_unit: '1 unit',
      price_usd: decl.price_usd,
      fx_cny_per_usd: decl.fx_cny_per_usd,
      pkg,
      headhaul: { usd_per_unit: decl.headhaul_usd, bond_included: true },
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      fulfillment_usd: decl.fulfillment_usd,
      placement_usd: decl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-09-30' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-01-15' } },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    };

    // Quote WITHOUT ui_readback MUST be rejected by gate1b --profile-revision 59!
    writeFileSync(g1bNoUiPath, JSON.stringify({
      form_id: 'form-cli-r59-g1b',
      as_of_date: '2026-11-22',
      quote: {
        quote_id: 'q-cli-no-ui',
        observed_at: '2026-11-22T10:00:00Z',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-no-ui',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        fx_cny_per_usd: 7.2,
        pkg,
        sku_lines: [{ component_id: 'item', offer_id: 'o1', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 35, regular_goods_promo_false: true }],
        goods_cny_total: 3500,
        domestic_freight_cny_total: 200,
      },
      early_screen_scenarios: [earlyScreen],
    }), 'utf8');
    const rNoUi = spawnSync(process.execPath, [cliPath, 'gate1b', '--db', dbPath, '--input', g1bNoUiPath, '--profile-revision', '59'], { encoding: 'utf8' });
    assert.notEqual(rNoUi.status, 0, 'gate1b --profile-revision 59 must reject quote missing ui_readback');

    // Submitting 2 quotes (losing first, winning second!) evaluates BOTH together -> crosses_30pct (NEVER drops 2nd quote via .find()!)
    const uiOk = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    writeFileSync(g1bTwoQuotesPath, JSON.stringify({
      form_id: 'form-cli-r59-g1b',
      as_of_date: '2026-11-22',
      quotes: [
        {
          quote_id: 'q-cli-lose-first',
          observed_at: '2026-11-22T10:00:00Z',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'ev-ql',
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          fx_cny_per_usd: 7.2,
          pkg,
          ui_readback: uiOk,
          sku_lines: [{ component_id: 'item', offer_id: 'ol', sku_id: 'sl', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 135, regular_goods_promo_false: true }],
          goods_cny_total: 13500,
          domestic_freight_cny_total: 900,
        },
        {
          quote_id: 'q-cli-win-second',
          observed_at: '2026-11-22T10:05:00Z',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'ev-qw',
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          fx_cny_per_usd: 7.2,
          pkg,
          ui_readback: uiOk,
          sku_lines: [{ component_id: 'item', offer_id: 'ow', sku_id: 'sw', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 35, regular_goods_promo_false: true }],
          goods_cny_total: 3500,
          domestic_freight_cny_total: 250,
        },
      ],
      early_screen_scenarios: [earlyScreen],
    }), 'utf8');
    const rTwoQ = spawnSync(process.execPath, [cliPath, 'gate1b', '--db', dbPath, '--input', g1bTwoQuotesPath, '--profile-revision', '59'], { encoding: 'utf8' });
    assert.equal(rTwoQ.status, 0, rTwoQ.stderr);
    const outTwoQ = JSON.parse(rTwoQ.stdout).result;
    assert.equal(outTwoQ.margin_interval_verdict, 'crosses_30pct');
    assert.deepEqual(outTwoQ.passing_quote_ids, ['q-cli-win-second']);
    assert.deepEqual(outTwoQ.failing_quote_ids, ['q-cli-lose-first']);

    // Top-level require_ui_readback: false in gate1b CLI JSON MUST be rejected under --profile-revision 59!
    const g1bDisableTopPath = join(tmp, 'g1b-disable-top.json');
    writeFileSync(g1bDisableTopPath, JSON.stringify({
      form_id: 'form-cli-r59-g1b',
      require_ui_readback: false,
      as_of_date: '2026-11-22',
      early_screen_scenarios: [earlyScreen],
    }), 'utf8');
    const rDisableTop = spawnSync(process.execPath, [cliPath, 'gate1b', '--db', dbPath, '--input', g1bDisableTopPath, '--profile-revision', '59'], { encoding: 'utf8' });
    assert.notEqual(rDisableTop.status, 0, 'CLI must reject top-level require_ui_readback: false under r59');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Astra Round-3 Regressions (Scoring & Pipeline): re-sourcing after expired quote merges valid losing quote, multi-headhaul $50 cliff margin_range, strict_mature_only:false block, r58 partial ui_readback re-entry block, and single-variant Q31 prose', async () => {
  // 1) HIGH 6: Verified single-variant listing stating "单变体：父体销量等于目标子体销量" MUST score Q31 (not falsely rejected!)
  const candSingleVar = structuredClone(fixture.candidates[0]);
  candSingleVar.newcomer_cohort.grain = 'target_child_units';
  candSingleVar.newcomer_cohort.market_reference.grain = 'target_child_units';
  candSingleVar.newcomer_cohort.market_reference.scope = 'current_relevant_bsr_top100_mature_only';
  candSingleVar.newcomer_cohort.market_reference.mature_age_floor_days = 90;
  candSingleVar.evidence.push({
    id: 'ev-single-var-exact',
    grain: 'target_child_units',
    source: '单变体同款核实：该链接仅1个子体，父体销量等于目标子体销量',
    observed_at: '2026-11-20',
  });
  for (const m of candSingleVar.newcomer_cohort.members) {
    m.units_30d.grain = 'target_child_units';
    m.units_30d.evidence = ['ev-single-var-exact'];
    if (m.natural) {
      m.natural.view_grain = 'child_asin';
      m.natural.request = { isListingSearch: false, timePieceType: 'latelyDay', timePieceValue: '30' };
    }
  }
  for (const f of candSingleVar.newcomer_cohort.market_reference.families) {
    f.units_30d.grain = 'target_child_units';
    f.units_30d.evidence = ['ev-single-var-exact'];
  }
  assert.equal(scoreCandidate(candSingleVar, r59Profile).items.find(i => i.id === 'low_rating_sales_performance').status, 'scored');

  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const uiFull = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };

    // 2) HIGH 3: Passing strict_mature_only: false under r59 MUST throw!
    store.upsertCandidateForm({
      form_id: 'f-disable-strict-r59',
      product_family_key: 'disable-strict-r59',
      label: 'Disable strict test',
      buyer_task: 'Task',
      saleable_set_composition: { qty: 1 },
    });
    assert.throws(() => runGate1AForForm(store, {
      form_id: 'f-disable-strict-r59',
      profile_revision: 59,
      price_band_analysis: {
        options: { as_of_date: '2026-11-22', strict_mature_only: false },
        listings: [{ asin: 'B0MAT28001', price_usd: 28, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-05-01' }],
      },
      scenarios: [{
        id: 'sc-1',
        price_usd: 31,
        available_date: '2026-10-05',
        pkg,
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.0,
        collection_rate: 0.005,
        sales_window: { from: '2027-02-01', through: '2027-09-30' },
        storage_window: { from: '2027-02-01', through: '2027-09-30' },
        inbound_window: { from: '2027-01-15', through: '2027-01-15' },
      }],
    }), /Cannot disable strict_mature_only/i);

    // 3) HIGH 4: Quote persisted under r58 with logged_in:true but missing applied_quantity_confirmed MUST block under r59 Gate 1B!
    store.upsertCandidateForm({
      form_id: 'f-r58-partial-ui',
      product_family_key: 'r58-partial-ui',
      label: 'Partial UI quote test',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const g1aPartialUi = runGate1AForForm(store, {
      form_id: 'f-r58-partial-ui',
      profile_revision: 59,
      scenarios: [{
        id: 'sc-40',
        price_usd: 40,
        available_date: '2025-05-01',
        pkg,
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.0,
        collection_rate: 0.005,
        sales_window: { from: '2027-02-01', through: '2027-09-30' },
        storage_window: { from: '2027-02-01', through: '2027-09-30' },
        inbound_window: { from: '2027-01-15', through: '2027-01-15' },
      }],
    });
    const qR58Partial = store.recordSourcingQuote1688({
      quote_id: 'q-r58-no-qty-confirm',
      form_id: 'f-r58-partial-ui',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-partial',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true }, // missing applied_quantity_confirmed!
      sku_lines: [{ component_id: 'item', offer_id: 'op', sku_id: 'sp', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 35, regular_goods_promo_false: true }],
      goods_cny_total: 3500,
      domestic_freight_cny_total: 200,
    }).quote;
    assert.notEqual(qR58Partial.ui_readback_verified, true);
    const g1bReenter = await runGate1BForForm(store, {
      form_id: 'f-r58-partial-ui',
      existing_quote: qR58Partial,
      profile_revision: 59,
      as_of_date: '2026-11-22',
      early_screen_builder: () => ({ id: g1aPartialUi.declared_scenarios[0].id }),
    });
    assert.equal(g1bReenter.status, 'gate1b_pending', 'r58 quote missing applied_quantity_confirmed must NOT pass r59 Gate 1B');

    // 4) HIGH 2: Two scenarios ($49.99 w/ higher headhaul $4.50 and $50.01 w/ lower headhaul $2.00) -> $50.00 cliff margin_range[1] >= 0.30!
    store.upsertCandidateForm({
      form_id: 'f-diff-headhaul-cliff',
      product_family_key: 'diff-headhaul-cliff',
      label: 'Diff headhaul $50 cliff',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const probe50 = runGate1AForForm(store, {
      form_id: 'f-diff-headhaul-cliff',
      profile_revision: 59,
      scenarios: [
        { id: 'sc-4999-hi', price_usd: 49.99, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 4.5, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
        { id: 'sc-5000-lo', price_usd: 50.00, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 2.0, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
        { id: 'sc-5001-lo', price_usd: 50.01, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 2.0, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
      ],
    });
    const cap50Lo = probe50.scenarios.find(s => s.id === 'sc-5000-lo').estimate.landed_domestic_cap_cny;
    const cap5001Lo = probe50.scenarios.find(s => s.id === 'sc-5001-lo').estimate.landed_domestic_cap_cny;
    const g1aDiffHh = runGate1AForForm(store, {
      form_id: 'f-diff-headhaul-cliff',
      profile_revision: 59,
      scenarios: [
        { id: 'sc-4999-hi', price_usd: 49.99, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 4.5, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
        { id: 'sc-5001-lo', price_usd: 50.01, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 2.0, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
      ],
    });
    const unitCnyDiff = Number((((cap50Lo + cap5001Lo) / 2)).toFixed(2));
    const qDiff = store.recordSourcingQuote1688({
      quote_id: 'q-diff-hh',
      form_id: 'f-diff-headhaul-cliff',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-dhh',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: uiFull,
      sku_lines: [{ component_id: 'item', offer_id: 'od', sku_id: 'sd', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: unitCnyDiff, regular_goods_promo_false: true }],
      goods_cny_total: Number((unitCnyDiff * 100).toFixed(2)),
      domestic_freight_cny_total: 0,
    }).quote;
    const cuFt = (12 * 8 * 4) / 1728;
    const g1bDiff = await runGate1BForForm(store, {
      form_id: 'f-diff-headhaul-cliff',
      existing_quote: qDiff,
      profile_revision: 59,
      as_of_date: '2026-11-22',
      early_screen_builder: () => g1aDiffHh.declared_scenarios.map(d => ({
        profile_revision: 58,
        id: d.id,
        saleable_unit: '1 unit',
        price_usd: d.price_usd,
        fx_cny_per_usd: d.fx_cny_per_usd,
        pkg,
        headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        fulfillment_usd: d.fulfillment_usd,
        placement_usd: d.placement_range_usd[1],
        storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-09-30' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-01-15' } },
        collection_rate: 0.005,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      })),
    });
    assert.equal(g1bDiff.margin_interval_verdict, 'crosses_30pct');
    assert.ok(g1bDiff.margin_range[1] >= 0.30, `Different-headhaul $50.00 cliff must include >=30% upper bound, got ${JSON.stringify(g1bDiff.margin_range)}`);

    // 5) BLOCKER 3a: Expired quote q1 passed in existing_quotes triggers sourcing_executor for q3 (winning), while SQLite ALSO holds valid losing quote q2 -> Gate 1B MUST merge q2 + q3!
    store.upsertCandidateForm({
      form_id: 'f-expired-resourced',
      product_family_key: 'expired-resourced',
      label: 'Expired resourced 2-quote merge',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const qExpired = store.recordSourcingQuote1688({
      quote_id: 'q-exp-1',
      form_id: 'f-expired-resourced',
      observed_at: '2026-10-01T10:00:00Z',
      expires_at: '2026-10-15T10:00:00Z', // expired before 2026-11-22!
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-exp',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: uiFull,
      sku_lines: [{ component_id: 'item', offer_id: 'oe', sku_id: 'se', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
      goods_cny_total: 3600,
      domestic_freight_cny_total: 200,
    }).quote;
    store.recordSourcingQuote1688({
      quote_id: 'q-valid-lose-2',
      form_id: 'f-expired-resourced',
      observed_at: '2026-11-20T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-vl2',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: uiFull,
      sku_lines: [{ component_id: 'item', offer_id: 'ol', sku_id: 'sl', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 135, regular_goods_promo_false: true }],
      goods_cny_total: 13500,
      domestic_freight_cny_total: 900,
    });
    const repResourced = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [{
        form: {
          form_id: 'f-expired-resourced',
          product_family_key: 'expired-resourced',
          label: 'Expired resourced 2-quote merge',
          buyer_task: 'Task',
          saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
        },
        leads: [{
          lead_id: 'lead-exp-res',
          phrase_or_title: 'synth shelf',
          source_channel: 'keyword_research',
          source_ref: 'https://www.sellersprite.com/exp-res',
          observed_at: '2026-11-22',
          disposition: 'product',
          link_role: 'primary_discovery',
        }],
        gate1a_scenarios: [{
          id: 'sc-40',
          price_usd: 40,
          available_date: '2025-05-01',
          pkg,
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          headhaul_usd: 2.0,
          collection_rate: 0.005,
          sales_window: { from: '2027-02-01', through: '2027-09-30' },
          storage_window: { from: '2027-02-01', through: '2027-09-30' },
          inbound_window: { from: '2027-01-15', through: '2027-01-15' },
        }],
        existing_quotes: [qExpired],
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-fresh-win-3',
            observed_at: '2026-11-22T10:00:00Z',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-fw3',
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            fx_cny_per_usd: 7.2,
            pkg,
            ui_readback: uiFull,
            sku_lines: [{ component_id: 'item', offer_id: 'ow', sku_id: 'sw', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
            goods_cny_total: 3600,
            domestic_freight_cny_total: 360,
          },
        }),
        early_screen_builder: ({ form: f }) => {
          const d = JSON.parse(store.getCandidateForm(f.form_id).gate1a_result_json).declared_scenarios[0];
          return {
            profile_revision: 58,
            id: d.id,
            saleable_unit: '1 unit',
            price_usd: d.price_usd,
            fx_cny_per_usd: d.fx_cny_per_usd,
            pkg,
            headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true },
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            return_threshold: 0.081,
            returns_processing_usd: 0,
            is_apparel_or_shoes: false,
            referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            fulfillment_usd: d.fulfillment_usd,
            placement_usd: d.placement_range_usd[1],
            storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-09-30' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-01-15' } },
            collection_rate: 0.005,
            other_applicable_usd: 0,
            specific_rights_conflict: 'unknown',
            strong_date_dependency: false,
          };
        },
        deep_research_executor: async ({ form: f, quotes }) => {
          assert.equal(quotes.length, 2, 'Stage 3 must receive BOTH q-fresh-win-3 AND q-valid-lose-2');
          const cand = structuredClone(fixture.candidates[0]);
          cand.id = f.form_id;
          return { batch: { schema_version: 1, profile_revision: 59, candidates: [cand] } };
        },
      }],
    });
    assert.equal(repResourced.gate1b[0].margin_interval_verdict, 'crosses_30pct', 'Re-sourcing after expired quote must merge q-valid-lose-2');
    assert.equal(repResourced.gate2_3[0].status, 'gate2_3_error', 'Omitting q-valid-lose-2 in Stage 3 must NEVER qualify');

    // 6) Post-Round-3 Hardening:
    //    (a) store.mjs honors applied_qty_confirmed: true alias identically to contracts.mjs;
    //    (b) Stage 3 rejects swapping the evaluated Gate 1B quote for a newly inserted un-evaluated winning quote;
    //    (c) r59 HTML report isolates private_mold_reserved into its own reserved pool (never "待补证 0 个（其中...私模储备 1 个）"), badges "疑似私模／需开模留档", and labels passing vs failing factories on crossing-30% cards!
    store.upsertCandidateForm({
      form_id: 'f-qty-alias',
      product_family_key: 'qty-alias',
      label: 'Qty alias test',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const qAlias = store.recordSourcingQuote1688({
      quote_id: 'q-qty-alias',
      form_id: 'f-qty-alias',
      require_ui_readback: true,
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-qa',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_qty_confirmed: true },
      sku_lines: [{ component_id: 'item', offer_id: 'oa', sku_id: 'sa', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
      goods_cny_total: 3600,
      domestic_freight_cny_total: 360,
    }).quote;
    assert.equal(qAlias.ui_readback_verified, true, 'applied_qty_confirmed: true must persist ui_readback_verified = true');

    // Stage 3 un-evaluated quote swap block
    store.upsertCandidateForm({
      form_id: 'f-stage3-swap-block',
      product_family_key: 's3-swap-block',
      label: 'Stage 3 swap block',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const qEvalCross = store.recordSourcingQuote1688({
      quote_id: 'q-eval-cross-1',
      form_id: 'f-stage3-swap-block',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-ec1',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: uiFull,
      sku_lines: [{ component_id: 'item', offer_id: 'oc', sku_id: 'sc', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 108, regular_goods_promo_false: true }],
      goods_cny_total: 10800,
      domestic_freight_cny_total: 576,
    }).quote;
    const repSwapBlock = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-22',
      items: [{
        form: {
          form_id: 'f-stage3-swap-block',
          product_family_key: 's3-swap-block',
          label: 'Stage 3 swap block',
          buyer_task: 'Task',
          saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
        },
        leads: [{
          lead_id: 'lead-s3-swap',
          phrase_or_title: 'synth holder',
          source_channel: 'keyword_research',
          source_ref: 'https://www.sellersprite.com/s3-swap',
          observed_at: '2026-11-22',
          disposition: 'product',
          link_role: 'primary_discovery',
        }],
        gate1a_scenarios: [
          { id: 'sc-40', price_usd: 40, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.05, physical_return_fraction: 0.05, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.5, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
          { id: 'sc-55', price_usd: 55, available_date: '2025-05-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.05, physical_return_fraction: 0.05, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.5, collection_rate: 0.005, sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-01-15' } },
        ],
        existing_quotes: [qEvalCross],
        early_screen_builder: ({ form: f }) => JSON.parse(store.getCandidateForm(f.form_id).gate1a_result_json).declared_scenarios.map(d => ({
          profile_revision: 58, id: d.id, saleable_unit: '1 unit', price_usd: d.price_usd, fx_cny_per_usd: 7.2, pkg,
          headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true }, refund_fraction: 0.05, physical_return_fraction: 0.05, return_threshold: 0.081, returns_processing_usd: 0,
          is_apparel_or_shoes: false, referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          fulfillment_usd: d.fulfillment_usd, placement_usd: d.placement_range_usd[1],
          storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-09-30' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-01-15' } },
          collection_rate: 0.005, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
        })),
        deep_research_executor: async ({ form: f }) => {
          store.recordSourcingQuote1688({
            quote_id: 'q-sneak-win-2',
            form_id: f.form_id,
            observed_at: '2026-11-22T11:00:00Z',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-sw2',
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            fx_cny_per_usd: 7.2,
            pkg,
            ui_readback: uiFull,
            sku_lines: [{ component_id: 'item', offer_id: 'os', sku_id: 'ss', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 36, regular_goods_promo_false: true }],
            goods_cny_total: 3600,
            domestic_freight_cny_total: 576,
          });
          const decls = JSON.parse(store.getCandidateForm(f.form_id).gate1a_result_json).declared_scenarios;
          const cand = structuredClone(fixture.candidates[0]);
          cand.id = f.form_id;
          cand.screening.reference_price_usd.value = 40;
          cand.screening.reference_price_usd.supported_price_range = [40, 55];
          cand.economics.expected_primary_scenarios = decls.map(d => ({ id: d.id, status: 'active' }));
          cand.economics.scenarios = decls.map(d => {
            const s = structuredClone(cand.economics.scenarios[0]);
            delete s.margin; delete s.contribution_usd;
            s.id = s.cost_ledger.id = d.id;
            s.quote_id = 'q-sneak-win-2';
            s.cost_ledger.price_usd = d.price_usd;
            s.cost_ledger.fx_cny_per_usd = 7.2;
            s.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 5.00;
            s.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = 0.80;
            s.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = d.headhaul_usd;
            s.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = d.fulfillment_usd;
            s.cost_ledger.lines.find(l => l.id === 'placement').amount_usd = d.placement_range_usd[1];
            return s;
          });
          return { batch: { schema_version: 1, profile_revision: 59, candidates: [cand] } };
        },
      }],
    });
    assert.equal(repSwapBlock.gate1b[0].margin_interval_verdict, 'crosses_30pct');
    assert.equal(repSwapBlock.gate2_3[0].status, 'gate2_3_error', 'Stage 3 must reject un-evaluated quote swap');

    // r59 HTML report private_mold_reserved isolation + crossing-30% factory clearance labels
    const cPm = structuredClone(fixture.candidates[0]);
    cPm.id = 'cand-pm-isolated';
    cPm.sourcing_disposition = 'private_mold_reserved';
    cPm.screening.strong_date_dependency.value = true;

    const cCross = structuredClone(fixture.candidates[0]);
    cCross.id = 'cand-cross-labeled';
    const scWin = structuredClone(cCross.economics.scenarios[0]);
    scWin.id = scWin.cost_ledger.id = 'sc-win';
    scWin.quote_id = 'factory-alpha-pass';
    const scLose = structuredClone(scWin);
    scLose.id = scLose.cost_ledger.id = 'sc-lose';
    scLose.quote_id = 'factory-beta-low';
    delete scLose.margin; delete scLose.contribution_usd;
    scLose.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 21.00; // <30% at $40
    const r = scLose.cost_ledger.refund_fraction;
    const ref = scLose.cost_ledger.lines.find(l => l.id === 'referral').amount_usd;
    const payout = 40 * (1 - r) - (ref - r * (ref - Math.min(5, 0.2 * ref))) - 4.86 - 0.54 - 0.2925;
    scLose.cost_ledger.lines.find(l => l.id === 'collection').amount_usd = Number((payout * scLose.cost_ledger.collection_rate).toFixed(10));
    cCross.economics.expected_primary_scenarios = [{ id: 'sc-win', status: 'active' }, { id: 'sc-lose', status: 'active' }];
    cCross.economics.scenarios = [scWin, scLose];

    const mixedBatch = { schema_version: 1, profile_revision: 59, candidates: [cCross, cPm] };
    const mixedRes = scoreBatch(mixedBatch, r59Profile);
    const mixedHtml = renderReport(mixedRes, mixedBatch);
    assert.match(mixedHtml, /疑似私模／需开模留档/);
    assert.match(mixedHtml, /私模留档 1/);
    assert.doesNotMatch(mixedHtml, /待补证 0 个（其中/);
    assert.match(mixedHtml, /达标可做：factory-alpha-pass/);
    assert.match(mixedHtml, /未过 30% 红线：factory-beta-low/);

    // 7) Round-4 Regressions:
    //    (a) HIGH 3: spiral_max_age_days < 90 rejected under Revision 59;
    //    (b) HIGH 2: interior $50.00 peak included when endpoints already cross AND interior $50.01 dip prevents false all_ge_30pct;
    //    (c) HIGH 4: legacy 6d8069d SQLite row with bare order_plan_json.ui_readback_verified=true (no 5-field ui_readback) rejected in r59 Gate 1B;
    //    (d) HIGH 6: negated prose "父体销量不等于目标子体销量" blocks Q31 scoring.
    const pkgR4 = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    store.upsertCandidateForm({
      form_id: 'f-r4-spiral',
      product_family_key: 'f-r4-spiral',
      label: 'R4 spiral lock',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    assert.throws(() => runGate1AForForm(store, {
      form_id: 'f-r4-spiral',
      profile_revision: 59,
      price_band_analysis: {
        options: { as_of_date: '2026-11-22', spiral_max_age_days: 30 },
        listings: [
          { asin: 'B0MAT28001', price_usd: 28, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-01-01' },
          { asin: 'B0YNG31001', price_usd: 31, fulfillment: 'FBA', monthlySales: 60, availableDate: '2026-10-03' },
        ],
      },
      scenarios: [{
        id: 'sc-31',
        price_usd: 31,
        available_date: '2025-01-01',
        pkg: pkgR4,
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.0,
        collection_rate: 0.005,
        sales_window: { from: '2027-02-01', through: '2027-09-30' },
        storage_window: { from: '2027-02-01', through: '2027-09-30' },
        inbound_window: { from: '2027-01-15', through: '2027-01-25' },
      }],
    }), /spiral_max_age_days >= 90/i);

    // HIGH 2: [$49.99, $52.00] where both endpoints >=30% while interior $50.01 dips <30% MUST be crosses_30pct (never all_ge_30pct)!
    // Also [$48.00, $51.00] where endpoints already cross raises margin_range[1] to the $50.00 pre-cliff peak!
    store.upsertCandidateForm({
      form_id: 'f-r4-cliff-dip',
      product_family_key: 'f-r4-cliff-dip',
      label: 'R4 cliff dip',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const mkG1AScen = (id, price) => ({
      id,
      price_usd: price,
      available_date: '2025-01-01',
      pkg: pkgR4,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 2.0,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-09-30' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-01-25' },
    });
    const probeDip = runGate1AForForm(store, {
      form_id: 'f-r4-cliff-dip',
      profile_revision: 59,
      scenarios: [mkG1AScen('sc-4999', 49.99), mkG1AScen('sc-5001', 50.01), mkG1AScen('sc-5200', 52.00)],
    });
    const cap4999 = probeDip.scenarios.find(s => s.id === 'sc-4999').estimate.landed_domestic_cap_cny;
    const cap5001 = probeDip.scenarios.find(s => s.id === 'sc-5001').estimate.landed_domestic_cap_cny;
    const cap5200 = probeDip.scenarios.find(s => s.id === 'sc-5200').estimate.landed_domestic_cap_cny;
    const unitCnyDip = Number(((Math.min(cap4999, cap5200) + cap5001) / 2).toFixed(2));

    const g1aDip = runGate1AForForm(store, {
      form_id: 'f-r4-cliff-dip',
      profile_revision: 59,
      scenarios: [mkG1AScen('sc-4999', 49.99), mkG1AScen('sc-5200', 52.00)],
    });
    assert.equal(g1aDip.proceed_to_gate1b, true);
    const toScreenFromDecl = d => ({
      profile_revision: 58,
      id: d.id,
      saleable_unit: '1 unit',
      price_usd: d.price_usd,
      fx_cny_per_usd: d.fx_cny_per_usd,
      pkg: pkgR4,
      headhaul: { usd_per_unit: d.headhaul_usd, bond_included: true },
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      fulfillment_usd: d.fulfillment_usd,
      placement_usd: d.placement_range_usd[1],
      storage: { cubic_feet_per_unit: (12 * 8 * 4) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
      fee_context: {
        marketplace: 'US',
        currency: 'USD',
        package_ref: 'p1',
        sales: { from: '2027-02-01', through: '2027-09-30' },
        storage: { from: '2027-02-01', through: '2027-09-30' },
        inbound: { from: '2027-01-15', through: '2027-01-25' },
      },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    });
    const uiFullR4 = {
      logged_in: true,
      viewport_width_px: 1440,
      selected_sku_row_visible: true,
      settlement_bar_visible: true,
      applied_quantity_confirmed: true,
    };
    const qDipSaved = store.recordSourcingQuote1688({
      quote_id: 'q-dip-borderline',
      form_id: 'f-r4-cliff-dip',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-dip',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: pkgR4,
      ui_readback: uiFullR4,
      sku_lines: [{ component_id: 'item', offer_id: 'od', sku_id: 'sd', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: unitCnyDip, regular_goods_promo_false: true }],
      goods_cny_total: Number((unitCnyDip * 100).toFixed(2)),
      domestic_freight_cny_total: 0,
    }).quote;
    const g1bDip = await runGate1BForForm(store, {
      form_id: 'f-r4-cliff-dip',
      profile_revision: 59,
      as_of_date: '2026-11-22',
      existing_quote: qDipSaved,
      early_screen_builder: () => g1aDip.declared_scenarios.map(toScreenFromDecl),
    });
    assert.equal(g1bDip.margin_interval_verdict, 'crosses_30pct', 'Interior $50.01 dip must prevent false all_ge_30pct');
    assert.ok(g1bDip.margin_range[0] < 0.30 && g1bDip.margin_range[1] >= 0.30);

    // Endpoint-crossing [$48.00, $50.50] where $50.00 peak exceeds $50.50 upper endpoint!
    store.upsertCandidateForm({
      form_id: 'f-r4-cliff-peak',
      product_family_key: 'f-r4-cliff-peak',
      label: 'R4 cliff peak',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const g1aPeak = runGate1AForForm(store, {
      form_id: 'f-r4-cliff-peak',
      profile_revision: 59,
      scenarios: [mkG1AScen('sc-4800', 48.00), mkG1AScen('sc-5050', 50.50)],
    });
    const g1aPeakWith50 = runGate1AForForm(store, {
      form_id: 'f-r4-cliff-peak',
      profile_revision: 59,
      scenarios: [mkG1AScen('sc-4800', 48.00), mkG1AScen('sc-5000', 50.00), mkG1AScen('sc-5050', 50.50)],
    });
    const cap5050 = g1aPeakWith50.scenarios.find(s => s.id === 'sc-5050').estimate.landed_domestic_cap_cny;
    const unitCnyPeak = Number((cap5050 - 0.50).toFixed(2)); // $50.50 barely passes (~30.1%), $48 fails, $50.00 is higher (~31.2%)!
    // Re-set g1a without explicit $50.00
    runGate1AForForm(store, {
      form_id: 'f-r4-cliff-peak',
      profile_revision: 59,
      scenarios: [mkG1AScen('sc-4800', 48.00), mkG1AScen('sc-5050', 50.50)],
    });
    const qPeakSaved = store.recordSourcingQuote1688({
      quote_id: 'q-peak-5000',
      form_id: 'f-r4-cliff-peak',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-pk',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: pkgR4,
      ui_readback: uiFullR4,
      sku_lines: [{ component_id: 'item', offer_id: 'op', sku_id: 'sp', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: unitCnyPeak, regular_goods_promo_false: true }],
      goods_cny_total: Number((unitCnyPeak * 100).toFixed(2)),
      domestic_freight_cny_total: 0,
    }).quote;
    const g1bPeak = await runGate1BForForm(store, {
      form_id: 'f-r4-cliff-peak',
      profile_revision: 59,
      as_of_date: '2026-11-22',
      existing_quote: qPeakSaved,
      early_screen_builder: () => g1aPeak.declared_scenarios.map(toScreenFromDecl),
    });
    const marginAt5050 = g1bPeak.early_screen[1].ledger.margin;
    assert.equal(g1bPeak.margin_interval_verdict, 'crosses_30pct');
    assert.ok(g1bPeak.margin_range[1] > marginAt5050 + 0.005, `Expected $50.00 interior peak (${g1bPeak.margin_range[1]}) > $50.50 endpoint (${marginAt5050})`);

    // HIGH 4: Legacy 6d8069d bare ui_readback_verified:true SQLite row without 5-field ui_readback object MUST be blocked in r59
    store.upsertCandidateForm({
      form_id: 'f-r4-legacy-6d80',
      product_family_key: 'f-r4-legacy-6d80',
      label: 'Legacy 6d8069d quote',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const g1aLeg = runGate1AForForm(store, {
      form_id: 'f-r4-legacy-6d80',
      profile_revision: 59,
      scenarios: [mkG1AScen('sc-leg-40', 40.00)],
    });
    store.recordSourcingQuote1688({
      quote_id: 'q-leg-6d80',
      form_id: 'f-r4-legacy-6d80',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-leg',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: pkgR4,
      ui_readback: uiFullR4,
      sku_lines: [{ component_id: 'item', offer_id: 'ol', sku_id: 'sl', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
      goods_cny_total: 4000,
      domestic_freight_cny_total: 200,
    });
    // Simulate 6d8069d's writer stripping order_plan_json.ui_readback while leaving bare ui_readback_verified: true!
    const rawPlanRow = store.db.prepare('SELECT order_plan_json FROM sourcing_quotes_1688 WHERE quote_id = ?').get('q-leg-6d80');
    const legacyPlan = JSON.parse(rawPlanRow.order_plan_json);
    delete legacyPlan.ui_readback;
    legacyPlan.ui_readback_verified = true;
    store.db.prepare('UPDATE sourcing_quotes_1688 SET order_plan_json = ? WHERE quote_id = ?').run(JSON.stringify(legacyPlan), 'q-leg-6d80');

    const reloadedLeg = store.getQuotesForForm('f-r4-legacy-6d80')[0];
    assert.notEqual(reloadedLeg.ui_readback_verified, true, 'Bare legacy ui_readback_verified without 5-field ui_readback must not be trusted');
    const g1bLeg = await runGate1BForForm(store, {
      form_id: 'f-r4-legacy-6d80',
      profile_revision: 59,
      as_of_date: '2026-11-22',
      existing_quotes: [reloadedLeg],
      early_screen_scenarios: g1aLeg.declared_scenarios.map(toScreenFromDecl),
    });
    assert.equal(g1bLeg.status, 'gate1b_pending');
    assert.match(g1bLeg.reason, /ui_readback/i);

    // Structured `ev.grain` check (replacing brittle 400-char prose regex): parent_units / family_representative grain blocks Q31!
    for (const parentGrain of ['parent_units', 'family_representative', 'parent_family_units']) {
      const cNegQ31 = structuredClone(candSingleVar);
      cNegQ31.evidence.find(e => e.id === 'ev-single-var-exact').grain = parentGrain;
      const scoredNegQ31 = scoreCandidate(cNegQ31, r59Profile);
      const q31ItemNeg = scoredNegQ31.items.find(i => i.id === 'low_rating_sales_performance');
      assert.equal(q31ItemNeg.status, 'needs_evidence', `Structured parent grain (${parentGrain}) must block Q31`);
      assert.equal(scoredNegQ31.qualification.counts_toward_target, false);
    }
  } finally {
    store.close();
  }
});
