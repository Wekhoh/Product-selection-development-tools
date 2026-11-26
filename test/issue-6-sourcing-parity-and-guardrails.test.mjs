import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSelectionStore } from '../src/store.mjs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { runGate1AForForm, runGate1BForForm, runPhase2Batch } from '../src/pipeline.mjs';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';
import { evaluateSingleFactoryCompleteKit, resolveVerifiedFactoryKey } from '../src/fba-calculator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const r59Profile = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'), 'utf8'));
const synthBatch = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic-batch.json'), 'utf8'));

const VALID_UI_READBACK = {
  logged_in: true,
  viewport_width_px: 1440,
  selected_sku_row_visible: true,
  settlement_bar_visible: true,
  applied_quantity_confirmed: true,
};

function buildMultiSkuCandidate({
  id = 'cand-kit-synth',
  skuLines,
  samplePending = false,
  seasonal = false,
  topLevelFactoryId = undefined,
}) {
  const cand = structuredClone(synthBatch.candidates[0]);
  cand.id = id;
  cand.label = `Synthetic Kit (${id})`;
  const evId = cand.evidence[0].id;
  const sc = cand.economics.scenarios[0];
  sc.id = 'sc-kit-50pct';
  sc.cost_ledger.id = sc.id;
  sc.cost_ledger.price_usd = 50.00;
  sc.cost_ledger.fx_cny_per_usd = 7.2;
  if (topLevelFactoryId !== undefined) {
    sc.factory_id = topLevelFactoryId;
    sc.cost_ledger.factory_id = topLevelFactoryId;
  }
  cand.screening.reference_price_usd.value = 50.00;
  cand.screening.reference_price_usd.supported_price_range = [45.00, 55.00];

  // Exact bare-goods procurement from sku_lines at FX=7.2 yielding ~50%+ margin at $50.00
  const totalGoodsCny = skuLines.reduce((sum, l) => sum + l.ordered_qty * l.unit_price_cny, 0);
  const procUsd = Number((totalGoodsCny / (100 * 7.2)).toFixed(10));
  const procLine = sc.cost_ledger.lines.find(l => l.id === 'procurement');
  procLine.amount_usd = procUsd;
  procLine.order_units = 100;
  procLine.first_order_promotion = false;
  procLine.fx_cny_per_usd = 7.2;
  procLine.sku_lines = structuredClone(skuLines);

  // Use bare-goods screening domestic_freight line so total margin sits cleanly ~50%
  sc.cost_ledger.cost_basis = 'bare_goods_1688';
  sc.cost_ledger.bare_goods_screening = true;
  const domLine = sc.cost_ledger.lines.find(l => l.id === 'domestic_freight');
  domLine.status = 'not_applicable';
  domLine.amount_usd = 0;
  domLine.bare_goods_screening = true;
  delete domLine.order_units;
  delete domLine.first_order_promotion;

  // Keep sales/storage windows aligned with 2027 off-peak
  sc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-10-14' };
  sc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  sc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
  for (const l of sc.cost_ledger.lines) {
    if (l.fee_basis) {
      if (l.id === 'fulfillment' || l.id === 'referral' || l.id === 'returns_processing') {
        l.fee_basis.effective_from = '2027-02-01';
        l.fee_basis.effective_through = '2027-10-14';
        if (l.id === 'fulfillment') l.fee_basis.price_band = '10_to_50';
      } else if (l.id === 'storage') {
        l.fee_basis.effective_from = '2027-02-01';
        l.fee_basis.effective_through = '2027-09-30';
        l.fee_basis.months = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      } else if (l.id === 'placement') {
        l.fee_basis.effective_from = '2027-01-01';
        l.fee_basis.effective_through = '2027-12-31';
      }
    }
  }
  const headLine = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
  headLine.amount_usd = 2.00;
  headLine.components = ['ocean_freight', 'carrier_bond'];
  delete headLine.cny_derivation;
  const placeLine = sc.cost_ledger.lines.find(l => l.id === 'placement');
  placeLine.amount_usd = 0;
  placeLine.status = 'not_applicable';
  placeLine.fee_basis = {
    ...placeLine.fee_basis,
    split_option: 'amazon_optimized',
    steady_state_replenishment: true,
    multi_destination_headhaul_verified: true,
  };
  sc.cost_ledger.steady_state_replenishment = true;
  sc.cost_ledger.multi_destination_headhaul_verified = true;

  delete sc.margin;
  delete sc.contribution_usd;
  cand.economics.expected_primary_scenarios = [{ id: sc.id, status: 'active' }];

  if (samplePending) {
    cand.judgments.existing_solution_fit = {
      anchor: null,
      complete_set_verified: true,
      sample_check_required: true,
      reason: '1688 现货齐套已核实，细节公差待拿样核验',
      evidence: [evId],
    };
  }

  if (seasonal) {
    cand.product_seasonality = 'seasonal';
    const peakSc = structuredClone(sc);
    peakSc.id = 'sc-kit-peak-unpub';
    peakSc.cost_ledger.id = peakSc.id;
    peakSc.cost_ledger.fee_context.sales = { from: '2027-10-15', through: '2028-01-14' };
    peakSc.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
    peakSc.cost_ledger.fee_context.inbound = { from: '2027-09-15', through: '2027-12-31' };
    const pkgRef = peakSc.cost_ledger.fee_context.package_ref;
    for (const l of peakSc.cost_ledger.lines) {
      if (l.fee_basis && (l.id === 'referral' || l.id === 'returns_processing' || l.id === 'other_applicable')) {
        l.fee_basis.effective_from = '2027-02-01';
        l.fee_basis.effective_through = '2028-01-14';
      }
    }
    const peakFul = peakSc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    peakFul.status = 'pending';
    peakFul.amount_usd = null;
    peakFul.fee_basis = {
      status: 'unavailable',
      version: 'US-FBA-2027-Q4-UNPUBLISHED',
      marketplace: 'US',
      currency: 'USD',
      package_ref: pkgRef,
      year: 2027,
      evidence: [evId],
      note: '待亚马逊公布 2027 旺季费率后补充',
    };
    const peakCol = peakSc.cost_ledger.lines.find(l => l.id === 'collection');
    if (peakCol) {
      peakCol.status = 'pending';
      peakCol.amount_usd = null;
    }
    const peakStor = peakSc.cost_ledger.lines.find(l => l.id === 'storage');
    peakStor.amount_usd = Number((peakStor.amount_usd * (2.40 / 0.78)).toFixed(4));
    if (peakStor.rate_usd_per_cuft_month !== undefined) peakStor.rate_usd_per_cuft_month = 2.40;
    if (peakStor.fee_basis) {
      peakStor.fee_basis.effective_from = '2027-10-01';
      peakStor.fee_basis.effective_through = '2027-12-31';
      peakStor.fee_basis.months = [10, 11, 12];
      if (peakStor.fee_basis.rate_usd_per_cuft_month !== undefined) peakStor.fee_basis.rate_usd_per_cuft_month = 2.40;
    }
    const offSc = cand.economics.scenarios[0];
    delete cand.economics.scenarios;
    delete cand.economics.expected_primary_scenarios;
    cand.economics.operating_periods = [
      {
        id: 'off_peak',
        label: '2027 淡季（2–10月）',
        months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        expected_primary_scenarios: [{ id: offSc.id, status: 'active' }],
        scenarios: [offSc],
      },
      {
        id: 'peak',
        label: '2027 旺季（10–12月）',
        months: [10, 11, 12],
        expected_primary_scenarios: [{ id: peakSc.id, status: 'active' }],
        scenarios: [peakSc],
      },
    ];
  }
  return cand;
}

test('Issue #6: unified single-factory complete-kit adjudication across store, scoreBatch (complete & sample_pending_qualifying & seasonal), and report with order-invariance', () => {
  const rackA = {
    component_id: 'rack',
    offer_id: 'off-rack-a',
    sku_id: 'sku-rack',
    factory_id: 'A',
    qty_per_saleable_set: 1,
    pack_multiple: 1,
    moq_qty: 100,
    ordered_qty: 100,
    unit_price_cny: 42,
    regular_goods_promo_false: true,
  };
  const bagA = {
    component_id: 'bag',
    offer_id: 'off-bag-a',
    sku_id: 'sku-bag',
    factory_id: 'A',
    qty_per_saleable_set: 1,
    pack_multiple: 1,
    moq_qty: 100,
    ordered_qty: 100,
    unit_price_cny: 18,
    regular_goods_promo_false: true,
  };
  const bagB = {
    ...bagA,
    offer_id: 'off-bag-b',
    factory_id: 'B',
  };

  // Direct helper parity + order invariance
  const sameAB = evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, bagA] });
  const sameBA = evaluateSingleFactoryCompleteKit({ sku_lines: [bagA, rackA] });
  assert.equal(sameAB.is_single_factory_complete_kit, true);
  assert.equal(sameAB.status, 'single_factory_complete_kit');
  assert.deepEqual(sameAB, sameBA, 'Same-factory helper verdict must be order-invariant');

  const crossAB = evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, bagB] });
  const crossBA = evaluateSingleFactoryCompleteKit({ sku_lines: [bagB, rackA] });
  assert.equal(crossAB.is_single_factory_complete_kit, false);
  assert.equal(crossAB.status, 'incomplete_cross_factory_kit');
  assert.deepEqual(crossAB.distinct_factory_ids, ['a', 'b']);
  assert.deepEqual(crossAB, crossBA, 'Cross-factory helper verdict must be order-invariant');

  // Mixed-case same factory ('A' vs 'a') stays valid; top-level 'A' vs line 'B' is cross-factory
  assert.equal(
    evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, { ...bagA, factory_id: 'a' }] }).status,
    'single_factory_complete_kit',
  );
  assert.equal(
    evaluateSingleFactoryCompleteKit({ factory_id: 'A', sku_lines: [bagB] }).status,
    'incomplete_cross_factory_kit',
  );
  // Multi-SKU where one line names factory A and another line omits factory_id (with no top-level factory) -> incomplete
  const bagNoFac = { ...bagA };
  delete bagNoFac.factory_id;
  assert.equal(
    evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, bagNoFac] }).status,
    'incomplete_cross_factory_kit',
  );

  // 1) Store adjudication parity
  const store = openSelectionStore(':memory:');
  try {
    store.upsertCandidateForm({
      form_id: 'form-issue6-kit',
      product_family_key: 'issue6-kit',
      label: 'Issue 6 Synthetic Rack + Bag Kit',
      buyer_task: 'Store desktop rack with carrying bag',
      saleable_set_composition: [
        { component_id: 'rack', qty_per_saleable_set: 1 },
        { component_id: 'bag', qty_per_saleable_set: 1 },
      ],
    });
    const baseQuoteFields = {
      form_id: 'form-issue6-kit',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-kit-1',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg: { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 },
      ui_readback: VALID_UI_READBACK,
      goods_cny_total: 6000,
      domestic_freight_cny_total: null,
    };
    const qSame = store.recordSourcingQuote1688({
      ...baseQuoteFields,
      quote_id: 'q-same-a',
      sku_lines: [rackA, bagA],
    }).quote;
    assert.equal(qSame.quote_status, 'verified');
    assert.equal(qSame.factory_id, 'A');

    const qCross = store.recordSourcingQuote1688({
      ...baseQuoteFields,
      quote_id: 'q-cross-ab',
      sku_lines: [rackA, bagB],
    }).quote;
    assert.equal(qCross.quote_status, 'incomplete_cross_factory_kit');
    assert.equal(qCross.factory_id, null);
    assert.match(qCross.kit_note, /单一工厂/);
  } finally {
    store.close();
  }

  // 2) Standalone scoreBatch: same-factory multi-SKU qualifies cleanly and is order-invariant
  const sameCand1 = buildMultiSkuCandidate({ id: 'cand-same-1', skuLines: [rackA, bagA] });
  const sameCand2 = buildMultiSkuCandidate({ id: 'cand-same-1', skuLines: [bagA, rackA] });
  const resSame1 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameCand1] }, r59Profile);
  const resSame2 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameCand2] }, r59Profile);
  const cSame1 = resSame1.candidates[0];
  const cSame2 = resSame2.candidates[0];
  assert.equal(cSame1.queue, 'comparable');
  assert.equal(cSame1.qualification.counts_toward_target, true);
  assert.equal(cSame1.qualification.mode, 'comparable');
  assert.ok(cSame1.diagnostics.economics.margin_range[0] >= 0.45, 'Expected ~50% margin on synthetic kit');
  assert.deepEqual(cSame1.qualification, cSame2.qualification);
  assert.deepEqual(cSame1.total_range, cSame2.total_range);
  assert.deepEqual(cSame1.core_85_range, cSame2.core_85_range);
  assert.deepEqual(cSame1.diagnostics.economics.margin_range, cSame2.diagnostics.economics.margin_range);
  assert.deepEqual(
    cSame1.diagnostics.economics.scenarios[0].single_factory_complete_kit,
    cSame2.diagnostics.economics.scenarios[0].single_factory_complete_kit,
  );

  // Same-factory multi-SKU in sample_pending_qualifying mode also qualifies with order-invariance
  const sameSample1 = buildMultiSkuCandidate({ id: 'cand-same-sp', skuLines: [rackA, bagA], samplePending: true });
  const sameSample2 = buildMultiSkuCandidate({ id: 'cand-same-sp', skuLines: [bagA, rackA], samplePending: true });
  const spSame1 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSample1] }, r59Profile).candidates[0];
  const spSame2 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSample2] }, r59Profile).candidates[0];
  assert.equal(spSame1.qualification.counts_toward_target, true);
  assert.equal(spSame1.qualification.mode, 'sample_pending_qualifying');
  assert.deepEqual(spSame1.qualification, spSame2.qualification);
  assert.deepEqual(spSame1.core_85_range, spSame2.core_85_range);

  // 3) Standalone scoreBatch: cross-factory kit preserves scenario but NEVER counts toward target (complete, sample_pending_qualifying, seasonal)
  const crossCand1 = buildMultiSkuCandidate({ id: 'cand-cross-full', skuLines: [rackA, bagB] });
  const crossCand2 = buildMultiSkuCandidate({ id: 'cand-cross-full', skuLines: [bagB, rackA] });
  const crossBatch1 = { schema_version: 1, profile_revision: 59, candidates: [crossCand1] };
  const crossBatch2 = { schema_version: 1, profile_revision: 59, candidates: [crossCand2] };
  const resCross1 = scoreBatch(crossBatch1, r59Profile);
  const resCross2 = scoreBatch(crossBatch2, r59Profile);
  const cCross1 = resCross1.candidates[0];
  const cCross2 = resCross2.candidates[0];

  assert.equal(cCross1.diagnostics.economics.scenarios.length, 1, 'Cross-factory procurement scenario must be preserved for inspection');
  assert.equal(cCross1.diagnostics.economics.scenarios[0].single_factory_complete_kit.status, 'incomplete_cross_factory_kit');
  assert.deepEqual(cCross1.diagnostics.economics.scenarios[0].single_factory_complete_kit.distinct_factory_ids, ['a', 'b']);
  assert.equal(cCross1.queue, 'pending', 'Cross-factory kit must NEVER return comparable');
  assert.equal(cCross1.qualification.counts_toward_target, false, 'Cross-factory kit must return counts_toward_target: false');
  assert.equal(resCross1.summary.qualifying, 0);
  assert.deepEqual(cCross1.qualification, cCross2.qualification, 'Cross-factory qualification must be order-invariant');
  assert.deepEqual(
    cCross1.diagnostics.economics.scenarios[0].single_factory_complete_kit,
    cCross2.diagnostics.economics.scenarios[0].single_factory_complete_kit,
  );

  // Cross-factory kit in sample_pending_qualifying mode ALSO returns counts_toward_target: false
  const crossSample = buildMultiSkuCandidate({ id: 'cand-cross-sp', skuLines: [rackA, bagB], samplePending: true });
  const cCrossSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossSample] }, r59Profile).candidates[0];
  assert.equal(cCrossSp.diagnostics.economics.scenarios.length, 1, 'Scenario preserved in sample-pending cross-factory mode');
  assert.equal(cCrossSp.qualification.counts_toward_target, false, 'Cross-factory kit must NEVER qualify via sample_pending_qualifying');
  assert.notEqual(cCrossSp.qualification.mode, 'sample_pending_qualifying');

  // Seasonal positive controls MUST pass first (proving seasonal negative failures come strictly from cross-factory / incomplete kit!)
  const sameSeasFull = buildMultiSkuCandidate({ id: 'cand-same-seas-full', skuLines: [rackA, bagA], seasonal: true });
  const cSameSeasFull = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSeasFull] }, r59Profile).candidates[0];
  assert.equal(cSameSeasFull.qualification.counts_toward_target, true);
  assert.equal(cSameSeasFull.qualification.mode, 'seasonal_eligible');

  const sameSeasSp = buildMultiSkuCandidate({ id: 'cand-same-seas-sp', skuLines: [rackA, bagA], seasonal: true, samplePending: true });
  const cSameSeasSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSeasSp] }, r59Profile).candidates[0];
  assert.equal(cSameSeasSp.qualification.counts_toward_target, true);
  assert.equal(cSameSeasSp.qualification.mode, 'seasonal_sample_pending_qualifying');

  // Cross-factory kit in seasonal operating_periods (complete & sample_pending) drops to counts_toward_target: false
  const crossSeasFull = buildMultiSkuCandidate({ id: 'cand-cross-seas-full', skuLines: [rackA, bagB], seasonal: true });
  const cCrossSeasFull = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossSeasFull] }, r59Profile).candidates[0];
  assert.equal(cCrossSeasFull.qualification.counts_toward_target, false);
  assert.equal(cCrossSeasFull.operating_periods[0].diagnostics.economics.scenarios.length, 1);

  const crossSeasSp = buildMultiSkuCandidate({ id: 'cand-cross-seas-sp', skuLines: [rackA, bagB], seasonal: true, samplePending: true });
  const cCrossSeasSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossSeasSp] }, r59Profile).candidates[0];
  assert.equal(cCrossSeasSp.qualification.counts_toward_target, false);

  // Peak-only bare_part_only on seasonal companion panel also blocks seasonal_eligible & seasonal_sample_pending_qualifying
  const peakBareFull = buildMultiSkuCandidate({ id: 'cand-peak-bare-full', skuLines: [rackA, bagA], seasonal: true });
  peakBareFull.economics.operating_periods[1].scenarios[0].bare_part_only = true;
  const cPeakBareFull = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [peakBareFull] }, r59Profile).candidates[0];
  assert.equal(cPeakBareFull.qualification.counts_toward_target, false);

  const peakBareSp = buildMultiSkuCandidate({ id: 'cand-peak-bare-sp', skuLines: [rackA, bagA], seasonal: true, samplePending: true });
  peakBareSp.economics.operating_periods[1].scenarios[0].bare_part_only = true;
  const cPeakBareSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [peakBareSp] }, r59Profile).candidates[0];
  assert.equal(cPeakBareSp.qualification.counts_toward_target, false);

  // Standalone calculateEconomics (even WITHOUT profileRevision) blocks cross-factory kit from scoring_supported
  const directCalc = calculateEconomics(crossCand1.economics.scenarios[0].cost_ledger);
  assert.equal(directCalc.scoring_supported, false);
  assert.equal(directCalc.single_factory_complete_kit.status, 'incomplete_cross_factory_kit');

  // 4) Report preserves the procurement scenario, renders cross-factory count ONLY (no raw seller/factory ID PII leak), and reports 0 qualifying
  const piiCrossCand = buildMultiSkuCandidate({
    id: 'cand-cross-pii-safe',
    skuLines: [
      { ...rackA, factory_id: undefined, seller_member_id: 'factory-alpha-secret-token' },
      { ...bagB, factory_id: undefined, seller_member_id: 'factory-beta-secret-token' },
    ],
  });
  const resPiiCross = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [piiCrossCand] }, r59Profile);
  const html = renderReport(resPiiCross, { schema_version: 1, profile_revision: 59, candidates: [piiCrossCand] });
  assert.match(html, /单件利润与费用拆解/, 'Report must still render the preserved procurement scenario waterfall');
  assert.match(html, /检测到 2 家不同工厂拼套/, 'Report must show safe count of distinct factories');
  assert.doesNotMatch(html, /factory-alpha-secret-token|factory-beta-secret-token/, 'Report must NEVER leak raw factory/seller identifiers into shareable HTML');
  assert.doesNotMatch(html, /完整可比 1|入围 1/);
});

test('Stage 3A: r59 crosses_30pct never auto-sets owner_crossing_override:true and requires explicit allow_crossing_to_gate2_3:true before Gate 2/3 spend', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const cuFt = (12 * 8 * 4) / 1728;
    const baseSc = {
      id: 'sc-cross-44',
      price_usd: 44.00,
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
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    store.upsertCandidateForm({
      form_id: 'form-cross-auth',
      product_family_key: 'cross-auth',
      label: 'Crossing 30pct Auth Guard',
      buyer_task: 'Organize modular tools',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1a = runGate1AForForm(store, { form_id: 'form-cross-auth', scenarios: [baseSc] });
    assert.equal(g1a.proceed_to_gate1b, true);

    const mkQuote = (qid, facId, cny) => store.recordSourcingQuote1688({
      quote_id: qid,
      form_id: 'form-cross-auth',
      factory_id: facId,
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: VALID_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: `off-${qid}`, sku_id: `sku-${qid}`, factory_id: facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: cny, regular_goods_promo_false: true }],
      goods_cny_total: cny * 100,
      domestic_freight_cny_total: null,
    }).quote;

    const qWin = mkQuote('q-cross-win', 'fac-win', 35);
    const qLose = mkQuote('q-cross-lose', 'fac-lose', 130);
    const decl = g1a.declared_scenarios[0];
    const esBuilder = () => ({
      profile_revision: 59,
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
      referral_terms: baseSc.referral_terms,
      fulfillment_usd: decl.fulfillment_usd,
      placement_usd: decl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    });

    // Without allow_crossing_to_gate2_3: must NOT auto-proceed and must NOT set owner_crossing_override: true
    const g1bNoAuth = await runGate1BForForm(store, {
      form_id: 'form-cross-auth',
      existing_quotes: [qWin, qLose],
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: esBuilder,
    });
    assert.equal(g1bNoAuth.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bNoAuth.owner_crossing_override, false, 'Must NEVER auto-set owner_crossing_override: true');
    assert.equal(g1bNoAuth.owner_review_required, true, 'Crossing interval must require explicit owner review');
    assert.equal(g1bNoAuth.proceed_to_gate2_3, false, 'Crossing interval must stop before Gate 2/3 spend without explicit owner auth');

    // Persisted gate1b_result_json must also record owner_crossing_override: false
    const storedG1b = JSON.parse(store.getCandidateForm('form-cross-auth').gate1b_result_json);
    assert.equal(storedG1b.owner_crossing_override, false);

    // runPhase2Batch without allow_crossing_to_gate2_3 must NOT invoke deep_research_executor (0 Gate 2/3 spend)
    let deepCalls = 0;
    const batchNoAuth = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-26',
      items: [{
        form: {
          form_id: 'form-cross-auth',
          product_family_key: 'cross-auth',
          label: 'Crossing 30pct Auth Guard',
          buyer_task: 'Organize modular tools',
          saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
        },
        leads: [{
          lead_id: 'lead-cross-auth',
          phrase_or_title: 'modular tool organizer',
          source_channel: 'keyword_research',
          source_ref: 'https://www.sellersprite.com/cross-auth',
          observed_at: '2026-11-26',
          disposition: 'product',
          link_role: 'primary_discovery',
        }],
        gate1a_scenarios: [baseSc],
        existing_quotes: [qWin, qLose],
        early_screen_builder: esBuilder,
        deep_research_executor: async () => {
          deepCalls += 1;
          return { batch: { schema_version: 1, profile_revision: 59, candidates: [] } };
        },
      }],
    });
    assert.equal(batchNoAuth.gate1b[0].owner_crossing_override, false);
    assert.equal(batchNoAuth.gate1b[0].proceed_to_gate2_3, false);
    assert.equal(deepCalls, 0, 'Gate 2/3 deep_research_executor must NOT run without explicit allow_crossing_to_gate2_3: true');

    // With explicit allow_crossing_to_gate2_3: true, Gate 1B records owner_crossing_override: true and allows Gate 2/3
    const g1bAuth = await runGate1BForForm(store, {
      form_id: 'form-cross-auth',
      existing_quotes: [qWin, qLose],
      allow_crossing_to_gate2_3: true,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: esBuilder,
    });
    assert.equal(g1bAuth.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bAuth.owner_crossing_override, true);
    assert.equal(g1bAuth.proceed_to_gate2_3, true);
  } finally {
    store.close();
  }
});

test('Stage 3A: empty historical factory_id is never miscounted via quote_id, AI 1-3 factory cap holds, and manual_owner_entry:true allows 4th+ complete-kit factories', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const cuFt = (12 * 8 * 4) / 1728;
    const baseSc = {
      id: 'sc-cap-44',
      price_usd: 44.00,
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
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };

    // 1) Historical quotes with empty factory_id crossing 30%: quote_id MUST NOT be counted as distinct factories!
    store.upsertCandidateForm({
      form_id: 'form-hist-empty-fac',
      product_family_key: 'hist-empty-fac',
      label: 'Historical Empty Factory ID Test',
      buyer_task: 'Hold accessories',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aHist = runGate1AForForm(store, { form_id: 'form-hist-empty-fac', scenarios: [baseSc] });
    const declHist = g1aHist.declared_scenarios[0];
    const mkHistNoFac = (qid, offerId, cny) => store.recordSourcingQuote1688({
      quote_id: qid,
      form_id: 'form-hist-empty-fac',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: VALID_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: offerId, sku_id: `sku-${qid}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: cny, regular_goods_promo_false: true }],
      goods_cny_total: cny * 100,
      domestic_freight_cny_total: null,
    }).quote;
    const h1 = mkHistNoFac('q-hist-1', 'off-h1', 35);
    const h2 = mkHistNoFac('q-hist-2', 'off-h2', 128);
    const h3 = mkHistNoFac('q-hist-3', 'off-h3', 132);
    assert.equal(h1.factory_id, null);

    const g1bHistCross = await runGate1BForForm(store, {
      form_id: 'form-hist-empty-fac',
      existing_quotes: [h1, h2, h3],
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: () => ({
        profile_revision: 59,
        id: declHist.id,
        saleable_unit: '1 unit',
        price_usd: declHist.price_usd,
        fx_cny_per_usd: declHist.fx_cny_per_usd,
        pkg,
        headhaul: { usd_per_unit: declHist.headhaul_usd, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: baseSc.referral_terms,
        fulfillment_usd: declHist.fulfillment_usd,
        placement_usd: declHist.placement_range_usd[1],
        storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
        collection_rate: 0.005,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }),
    });
    assert.equal(g1bHistCross.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bHistCross.checked_factory_quotes_count, 0, 'Historical quotes without factory_id must NOT be miscounted via quote_id/offer_id');
    assert.equal(g1bHistCross.second_factory_quote_needed, true);

    // Also verify standalone scoreCandidate doesn't miscount 3 scenarios with empty factory_id (distinct quote_id/id) as 3 factories
    const threePriceCand = structuredClone(synthBatch.candidates[0]);
    threePriceCand.id = 'cand-3-sc-no-fac';
    const baseScScoring = structuredClone(threePriceCand.economics.scenarios[0]);
    delete baseScScoring.margin;
    delete baseScScoring.contribution_usd;
    baseScScoring.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 21.0; // below 30%
    const sA = structuredClone(baseScScoring); sA.id = sA.cost_ledger.id = 'sc-1'; sA.quote_id = 'q-1';
    const sB = structuredClone(baseScScoring); sB.id = sB.cost_ledger.id = 'sc-2'; sB.quote_id = 'q-2';
    const sC = structuredClone(baseScScoring); sC.id = sC.cost_ledger.id = 'sc-3'; sC.quote_id = 'q-3';
    threePriceCand.economics.scenarios = [sA, sB, sC];
    threePriceCand.economics.expected_primary_scenarios = [
      { id: 'sc-1', status: 'active' },
      { id: 'sc-2', status: 'active' },
      { id: 'sc-3', status: 'active' },
    ];
    const scoredNoFac = scoreCandidate(threePriceCand, r59Profile);
    assert.equal(scoredNoFac.diagnostics.economics.second_factory_quote_needed, true, '3 scenarios without factory_id must NOT count as 3 checked factories');

    // 2) AI automated 1-3 factory cap vs manual_owner_entry: true 4th+ factory bypass
    store.upsertCandidateForm({
      form_id: 'form-manual-4th',
      product_family_key: 'manual-4th',
      label: 'Manual Owner 4th Factory Override Test',
      buyer_task: 'Hold hardware parts',
      saleable_set_composition: [
        { component_id: 'rack', qty_per_saleable_set: 1 },
        { component_id: 'bag', qty_per_saleable_set: 1 },
      ],
    });
    const mkKitQuote = (qid, facId, rackCny, bagCny, extra = {}) => ({
      quote_id: qid,
      form_id: 'form-manual-4th',
      factory_id: facId,
      spec_variant_key: 'std-kit-v1',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: VALID_UI_READBACK,
      sku_lines: [
        { component_id: 'rack', offer_id: `off-r-${qid}`, sku_id: `sr-${qid}`, factory_id: facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: rackCny, regular_goods_promo_false: true },
        { component_id: 'bag', offer_id: `off-b-${qid}`, sku_id: `sb-${qid}`, factory_id: extra.bagFactoryId ?? facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: bagCny, regular_goods_promo_false: true },
      ],
      goods_cny_total: (rackCny + bagCny) * 100,
      domestic_freight_cny_total: null,
      ...extra,
    });

    // Record 3 AI factories + 1 rejected_spec + 1 incomplete_cross_factory_kit (latter 2 do NOT consume quota!)
    store.recordSourcingQuote1688(mkKitQuote('q-rej', 'fac-rej', 20, 10, { quote_status: 'rejected_spec' }));
    store.recordSourcingQuote1688(mkKitQuote('q-xkit', 'fac-x1', 20, 10, { bagFactoryId: 'fac-x2' }));
    store.recordSourcingQuote1688(mkKitQuote('q-ai-1', 'fac-1', 100, 30));
    store.recordSourcingQuote1688(mkKitQuote('q-ai-2', 'fac-2', 95, 25));
    store.recordSourcingQuote1688(mkKitQuote('q-ai-3', 'fac-3', 90, 20));

    // AI automated 4th distinct factory WITHOUT manual_owner_entry MUST throw!
    assert.throws(
      () => store.recordSourcingQuote1688(mkKitQuote('q-ai-4-blocked', 'fac-4', 60, 15)),
      /caps distinct verified factories at 3/i,
    );

    // Owner manual 4th cheaper complete-kit factory WITH manual_owner_entry: true MUST succeed and supersede expensive same-spec quotes!
    const qOwner4 = store.recordSourcingQuote1688(
      mkKitQuote('q-owner-4', 'fac-4', 45, 10, { manual_owner_entry: true }),
    ).quote;
    assert.equal(qOwner4.quote_status, 'verified');
    assert.equal(qOwner4.manual_owner_entry, true);
    assert.equal(store.getQuoteById('q-ai-3').quote_status, 'superseded_uncompetitive');

    // Subsequent AI automated 5th factory WITHOUT manual_owner_entry is STILL blocked!
    assert.throws(
      () => store.recordSourcingQuote1688(mkKitQuote('q-ai-5-blocked', 'fac-5', 40, 10)),
      /caps distinct verified factories at 3/i,
    );

    // Owner manual 5th factory WITH manual_owner_entry: true also succeeds, while cross-factory kit is STILL flagged incomplete_cross_factory_kit!
    const qOwner5Cross = store.recordSourcingQuote1688(
      mkKitQuote('q-owner-5-cross', 'fac-5a', 30, 5, { manual_owner_entry: true, bagFactoryId: 'fac-5b' }),
    ).quote;
    assert.equal(qOwner5Cross.quote_status, 'incomplete_cross_factory_kit');

    const qOwner5Batch = store.recordSourcingQuotesBatch1688([
      mkKitQuote('q-owner-5-ok', 'fac-5', 40, 10, { manual_owner_entry: true }),
    ]);
    assert.equal(qOwner5Batch[0].quote.quote_status, 'verified');
    assert.equal(qOwner5Batch[0].quote.manual_owner_entry, true);
  } finally {
    store.close();
  }
});

test('Stage 3A Astra review regressions: identity normalization, conflict/component/fit guards, pending crossing block, iterative quota & manual reopen/ui_readback/email PII guard', async () => {
  // 1) Numeric factory IDs, same-factory aliases, disjoint fields, shop_url query stripping
  const numSame = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 101, qty_per_saleable_set: 1 },
      { component_id: 'bag', factory_id: 101, qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(numSame.is_single_factory_complete_kit, true);
  assert.equal(numSame.resolved_factory_id, '101');

  const numCross = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 101, qty_per_saleable_set: 1 },
      { component_id: 'bag', factory_id: 202, qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(numCross.is_cross_factory_or_incomplete, true);
  assert.deepEqual(numCross.distinct_factory_ids, ['101', '202']);

  const aliasSame = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 'FAC-1', supplier_id: 'SUP-ALIAS-1', qty_per_saleable_set: 1 },
      { component_id: 'bag', factory_id: 'FAC-1', supplier_id: 'SUP-ALIAS-1', qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(aliasSame.is_single_factory_complete_kit, true);
  assert.equal(aliasSame.resolved_factory_id, 'FAC-1');

  const disjointFields = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 'FAC-1', qty_per_saleable_set: 1 },
      { component_id: 'bag', supplier_id: 'SUP-2', qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(disjointFields.is_cross_factory_or_incomplete, true);

  const shopSame = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=a1', qty_per_saleable_set: 1 },
      { component_id: 'bag', shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=b2', qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(shopSame.is_single_factory_complete_kit, true);
  assert.equal(
    resolveVerifiedFactoryKey({ shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=a1' }),
    resolveVerifiedFactoryKey({ shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=b2' }),
  );

  // 2) Conflicting scenario.sku_lines vs cost_ledger, missing expected_components, rejected_spec & existing_solution_fit.complete_set_verified:false
  const rackA = { component_id: 'rack', offer_id: 'o1', sku_id: 's1', factory_id: 'A', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true };
  const bagA = { component_id: 'bag', offer_id: 'o2', sku_id: 's2', factory_id: 'A', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 18, regular_goods_promo_false: true };
  const bagB = { ...bagA, factory_id: 'B' };

  const conflictCand = buildMultiSkuCandidate({ id: 'cand-conflict-sku', skuLines: [rackA, bagA] });
  conflictCand.economics.scenarios[0].sku_lines = [rackA, bagB];
  const resConflict = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [conflictCand] }, r59Profile).candidates[0];
  assert.equal(resConflict.qualification.counts_toward_target, false);

  const missingCompCand = buildMultiSkuCandidate({ id: 'cand-missing-comp', skuLines: [rackA] });
  missingCompCand.saleable_set_composition = [
    { component_id: 'rack', qty_per_saleable_set: 1 },
    { component_id: 'bag', qty_per_saleable_set: 1 },
  ];
  const resMissingComp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [missingCompCand] }, r59Profile).candidates[0];
  assert.equal(resMissingComp.qualification.counts_toward_target, false);

  const fitFalseCand = buildMultiSkuCandidate({ id: 'cand-fit-false', skuLines: [rackA, bagA] });
  fitFalseCand.judgments.existing_solution_fit = {
    ...fitFalseCand.judgments.existing_solution_fit,
    complete_set_verified: false,
  };
  const resFitFalse = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [fitFalseCand] }, r59Profile).candidates[0];
  assert.equal(resFitFalse.qualification.counts_toward_target, false);

  const rejectedSpecCand = buildMultiSkuCandidate({ id: 'cand-rej-spec', skuLines: [rackA, bagA] });
  rejectedSpecCand.economics.scenarios[0].quote_status = 'rejected_spec';
  const resRejSpec = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [rejectedSpecCand] }, r59Profile).candidates[0];
  assert.equal(resRejSpec.qualification.counts_toward_target, false);

  // 3) evaluateEarlyScreen with bare_part_only: true must stay pending (never pass)
  const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
  const cuFt = (12 * 8 * 4) / 1728;
  const bareEarly = evaluateEarlyScreen({
    profile_revision: 59,
    id: 'early-bare-part',
    saleable_unit: '1 kit',
    price_usd: 50.0,
    fx_cny_per_usd: 7.2,
    pkg,
    order_units: 100,
    goods_cny_per_unit: 50,
    bare_goods_screening: true,
    goods_first_order_promotion: false,
    first_order_promotion: false,
    bare_part_only: true,
    headhaul: { usd_per_unit: 2.0, bond_included: true },
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    fulfillment_usd: 4.5,
    placement_usd: 0,
    storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
    collection_rate: 0.005,
    other_applicable_usd: 0,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  }, { profileRevision: 59 });
  assert.equal(bareEarly.gate_status, 'pending');
  assert.equal(bareEarly.ledger.single_factory_complete_kit.status, 'incomplete_cross_factory_kit');

  // 4) Store + Gate 1B regressions: rejected_spec preserved, email factory_id rejected, manual missing ui_readback rejected before supersede,
  //    manual 4th reopens gate1b_rejected + manual 5th allowed, pending 3rd quote blocks allow_crossing_to_gate2_3,
  //    pre-sourcing 3-factory cap skips sourcing_executor, iterative non-quota retry + mixed batch clearedInterval + legacy header/lines check
  const store = openSelectionStore(':memory:');
  try {
    const baseSc = {
      id: 'sc-reg-44',
      price_usd: 44.00,
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
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    const mkEsBuilder = (decl, extra = {}) => ({ quote }) => ({
      profile_revision: 59,
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
      referral_terms: baseSc.referral_terms,
      fulfillment_usd: decl.fulfillment_usd,
      placement_usd: decl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
      ...(typeof extra === 'function' ? extra(quote) : extra),
    });

    const mkSingleQ = (formId, qid, facId, cny, extra = {}) => ({
      quote_id: qid,
      form_id: formId,
      factory_id: facId,
      spec_variant_key: 'v1',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: VALID_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: `off-${qid}`, sku_id: `s-${qid}`, factory_id: facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: cny, regular_goods_promo_false: true }],
      goods_cny_total: cny * 100,
      domestic_freight_cny_total: null,
      ...extra,
    });

    // Form A: rejected_spec preserved + email factory_id rejected + manual missing ui_readback rejected before supersede + manual 4th reopens gate1b_rejected + manual 5th works + existing factory revision works
    store.upsertCandidateForm({
      form_id: 'form-reg-a',
      product_family_key: 'reg-a',
      label: 'Regression Form A',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aA = runGate1AForForm(store, { form_id: 'form-reg-a', scenarios: [baseSc] });
    const declA = g1aA.declared_scenarios[0];

    const qRejStored = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-rej', 'f-rej', 20, { quote_status: 'rejected_spec' })).quote;
    assert.equal(qRejStored.quote_status, 'rejected_spec', 'rejected_spec must NOT be overwritten to incomplete_cross_factory_kit');

    assert.throws(
      () => store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-email', 'sales@supplier-example.cn', 40)),
      /email/i,
    );

    const qA1 = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-1', 'fa-1', 140)).quote;
    const qA2 = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-2', 'fa-2', 135)).quote;
    const qA3 = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-3', 'fa-3', 130)).quote;

    // Revising existing factory fa-2 when 3 factories exist MUST succeed
    const qA2Rev = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-2-rev', 'fa-2', 132)).quote;
    assert.equal(qA2Rev.quote_status, 'superseded_uncompetitive');

    // Manual 4th verified quote missing ui_readback MUST throw BEFORE superseding qa-3!
    const badManual = mkSingleQ('form-reg-a', 'qa-man-noui', 'fa-4', 35, { manual_owner_entry: true });
    delete badManual.ui_readback;
    assert.throws(() => store.recordSourcingQuote1688(badManual), /ui_readback/i);
    assert.equal(store.getQuoteById('qa-3').quote_status, 'verified', 'Failed manual quote must NOT supersede older verified quote');

    // All 3 AI factories fail < 30% -> gate1b_rejected; automated sourcing_executor MUST NOT run when >= 3 factories already exist
    let autoExecCalls = 0;
    const g1bRej = await runGate1BForForm(store, {
      form_id: 'form-reg-a',
      profile_revision: 59,
      as_of_date: '2026-11-26',
      sourcing_executor: async () => { autoExecCalls += 1; return { status: 'no_matched_offer' }; },
      early_screen_builder: mkEsBuilder(declA),
    });
    assert.equal(g1bRej.status, 'gate1b_rejected');
    assert.equal(autoExecCalls, 0, 'Automated sourcing_executor must NOT run when >= 3 distinct verified factories already exist');

    // Cheaper verified manual 4th factory MUST reopen gate1b_rejected -> gate1b_passed!
    const qMan4 = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-man-4', 'fa-4', 35, { manual_owner_entry: true })).quote;
    assert.equal(qMan4.quote_status, 'verified');
    const g1bReopen = await runGate1BForForm(store, {
      form_id: 'form-reg-a',
      existing_quote: qMan4,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: mkEsBuilder(declA),
    });
    assert.equal(g1bReopen.status, 'gate1b_passed');
    assert.equal(g1bReopen.proceed_to_gate2_3, true);

    // Pure manual 5th quote via Gate 1B sourcing_executor (with manual_owner_entry: true) MUST also succeed!
    const g1bMan5 = await runGate1BForForm(store, {
      form_id: 'form-reg-a',
      manual_owner_entry: true,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: mkSingleQ('form-reg-a', 'qa-man-5', 'fa-5', 32, { manual_owner_entry: true }),
      }),
      early_screen_builder: mkEsBuilder(declA),
    });
    assert.equal(g1bMan5.status, 'gate1b_passed');

    // Form B: iterative while loop skips rejected_spec & cross-factory without burning 3-factory quota, AND mixed batch [rejected_spec, passing] stops cleanly
    store.upsertCandidateForm({
      form_id: 'form-reg-b',
      product_family_key: 'reg-b',
      label: 'Regression Form B',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aB = runGate1AForForm(store, { form_id: 'form-reg-b', scenarios: [baseSc] });
    const declB = g1aB.declared_scenarios[0];
    let iterCalls = 0;
    const g1bIter = await runGate1BForForm(store, {
      form_id: 'form-reg-b',
      profile_revision: 59,
      as_of_date: '2026-11-26',
      sourcing_executor: async () => {
        iterCalls += 1;
        if (iterCalls === 1) return { status: 'quoted', has_more_factories: true, quote: mkSingleQ('form-reg-b', 'qb-rej1', 'fb-r1', 20, { quote_status: 'rejected_spec' }) };
        if (iterCalls === 2) return { status: 'quoted', has_more_factories: true, quote: mkSingleQ('form-reg-b', 'qb-x1', 'fb-x1', 20, { bare_part_only: true }) };
        if (iterCalls === 3) return { status: 'quoted', has_more_factories: true, quote: mkSingleQ('form-reg-b', 'qb-f1', 'fb-1', 140) };
        if (iterCalls === 4) {
          return {
            status: 'quoted',
            has_more_factories: true,
            quotes: [
              mkSingleQ('form-reg-b', 'qb-rej2', 'fb-r2', 20, { quote_status: 'rejected_spec' }),
              mkSingleQ('form-reg-b', 'qb-f2', 'fb-2', 35),
            ],
          };
        }
        return { status: 'quoted', has_more_factories: false, quote: mkSingleQ('form-reg-b', 'qb-f3', 'fb-3', 30) };
      },
      early_screen_builder: mkEsBuilder(declB),
    });
    assert.equal(iterCalls, 4, 'Iterative loop must skip non-quota rejected/incomplete rows AND stop immediately once mixed batch passing factory clears >= 30%');
    assert.equal(g1bIter.status, 'gate1b_passed');

    // Form C: allow_crossing_to_gate2_3: true must NOT proceed when a 3rd active quote evaluates pending
    store.upsertCandidateForm({
      form_id: 'form-reg-c',
      product_family_key: 'reg-c',
      label: 'Regression Form C',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aC = runGate1AForForm(store, { form_id: 'form-reg-c', scenarios: [baseSc] });
    const declC = g1aC.declared_scenarios[0];
    const qC1 = store.recordSourcingQuote1688(mkSingleQ('form-reg-c', 'qc-pass', 'fc-1', 35, { spec_variant_key: null, keep_parallel_spec: true })).quote;
    const qC2 = store.recordSourcingQuote1688(mkSingleQ('form-reg-c', 'qc-fail', 'fc-2', 135, { spec_variant_key: null, keep_parallel_spec: true })).quote;
    const qC3 = store.recordSourcingQuote1688(mkSingleQ('form-reg-c', 'qc-pend', 'fc-3', 45, { spec_variant_key: null, keep_parallel_spec: true })).quote;
    const g1bPendCross = await runGate1BForForm(store, {
      form_id: 'form-reg-c',
      existing_quotes: [qC1, qC2, qC3],
      allow_crossing_to_gate2_3: true,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: mkEsBuilder(declC, q => (q.quote_id === 'qc-pend' ? { headhaul: null } : {})),
    });
    assert.equal(g1bPendCross.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bPendCross.owner_crossing_override, false, 'Pending 3rd active quote must block owner_crossing_override');
    assert.equal(g1bPendCross.proceed_to_gate2_3, false, 'Pending 3rd active quote must block proceed_to_gate2_3 even with allow_crossing_to_gate2_3: true');

    // Legacy SQLite row with header factory_id 'A' + sku_lines_json containing factory_id 'B' must be rejected as unusable by Gate 1B
    store.db.prepare('UPDATE sourcing_quotes_1688 SET factory_id = ? WHERE quote_id = ?').run('fc-mismatch', 'qc-pass');
    const g1bLegacy = await runGate1BForForm(store, {
      form_id: 'form-reg-c',
      existing_quote: { quote_id: 'qc-pass' },
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: mkEsBuilder(declC),
    });
    assert.equal(g1bLegacy.status, 'gate1b_pending');
    assert.equal(g1bLegacy.proceed_to_gate2_3, false);
  } finally {
    store.close();
  }
});
