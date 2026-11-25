import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  VERIFIED_2027_RETURN_THRESHOLDS,
  lookupVerified2027ReturnThreshold,
  resolveEffectivePricing,
  validateFeeBasis,
} from '../src/fba-calculator.mjs';
import {
  estimateGate1A2027,
  solveMinPriceForMargin2027,
  lookupReturnsProcessing2027,
} from '../src/fba-calculator.mjs';
import { calculateEconomics } from '../src/economics.mjs';
import { evaluateEarlyScreen } from '../src/economics.mjs';
import {
  evaluateGate0CategoryBoundary,
  analyzeMainstreamPriceBand,
  tightenClusterBands,
} from '../src/price-band.mjs';
import {
  validateProviderCall,
  computeSifOwnMargin,
  parseSifTrafficStructure,
  computeClickConversionRate,
  verifyReviewVariantOwnership,
} from '../src/provider-guards.mjs';
import { isShenzhenDestination } from '../src/contracts.mjs';
import {
  DISCOVERY_CHANNELS,
  resolveChannelMeta,
  classifyPromotionTrack,
  auditDiscoveryCoverage,
  planDiscoveryBatch,
} from '../src/discovery-channels.mjs';
import { openSelectionStore as rawOpenSelectionStore } from '../src/store.mjs';
import { replayBatchIntoStore } from '../src/history-import.mjs';
import { attachGate1APriceCliffStress, runGate1AForForm, runGate1BForForm, runPhase2Batch } from '../src/pipeline.mjs';
import { attachStoreDiscoveryProvenance } from '../src/discovery.mjs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';

const DEFAULT_R59_UI_READBACK = {
  logged_in: true,
  viewport_width_px: 1440,
  selected_sku_row_visible: true,
  settlement_bar_visible: true,
  applied_quantity_confirmed: true,
};
function openSelectionStore(dbPath, opts) {
  const s = rawOpenSelectionStore(dbPath, opts);
  const orig = s.recordSourcingQuote1688.bind(s);
  s.recordSourcingQuote1688 = q => orig(q && typeof q === 'object' && q.ui_readback === undefined ? { ...q, ui_readback: DEFAULT_R59_UI_READBACK } : q);
  return s;
}

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROFILE_PATH = join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json');
const FIXTURE_PATH = join(REPO_ROOT, 'fixtures', 'synthetic-batch.json');
const CLI_PATH = join(REPO_ROOT, 'src', 'phase2-cli.mjs');

const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-ab-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-ab-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeGate1AScenario(overrides = {}) {
  return {
    profile_revision: 59,
    id: 'std-offpeak',
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

function makeScreenScenario(priceUsd, overrides = {}) {
  return {
    profile_revision: 59,
    id: `screen-${priceUsd}`,
    saleable_unit: '1 complete set',
    price_usd: priceUsd,
    fx_cny_per_usd: 7.0,
    order_units: 100,
    goods_cny_per_unit: 90,
    domestic_freight_cny_per_unit: 2,
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
    storage: { cubic_feet_per_unit: 0.069444, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
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
    ...overrides,
  };
}

// ============================================================================
// P0-1: Gate 1B 30%-crossing, FBA parity, Stage 3 binding, rights guard, bond
// ============================================================================
test('P0-1: Gate 1B 30%-crossing interval, FBA tier parity, Stage 3 quote/price binding, rights guard, and r58 carrier_bond check', async () => {
  const store = openSelectionStore(':memory:');

  // 1) r58 carrier_bond requirement in validateFeeBasis
  const baseCand = structuredClone(fixture.candidates[0]);
  const ledgerNoBond = structuredClone(baseCand.economics.scenarios[0].cost_ledger);
  const hhLine = ledgerNoBond.lines.find(l => l.id === 'headhaul');
  hhLine.components = ['ocean_freight', 'customs_duty']; // omits carrier_bond
  const vNoBond = validateFeeBasis(ledgerNoBond, { profileRevision: 59, evidenceIds: baseCand.evidence.map(e => e.id) });
  assert.equal(vNoBond.status, 'needs_evidence');
  assert.ok(vNoBond.issues.some(i => i.code === 'missing_carrier_bond'));

  // With explicit bond_exemption -> passes
  hhLine.bond_exemption = { reason: 'DDP single-entry bond billed separately on customs receipt', evidence: [baseCand.evidence[0].id] };
  const vExempt = validateFeeBasis(ledgerNoBond, { profileRevision: 59, evidenceIds: baseCand.evidence.map(e => e.id) });
  assert.equal(vExempt.issues.some(i => i.code === 'missing_carrier_bond'), false);

  // 2) Gate 1B FBA tier parity rejects fabricated fulfillment_usd
  store.upsertCandidateForm({ form_id: 'f-parity', label: 'Parity Form', buyer_task: 'Task', saleable_set_composition: { qty: 1 } });
  runGate1AForForm(store, { form_id: 'f-parity', scenarios: [makeGate1AScenario({ price_usd: 54.99 })] });
  const qParity = store.recordSourcingQuote1688({
    form_id: 'f-parity',
    observed_at: '2026-11-20',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:p01-parity',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'o1', sku_id: 's1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 8000,
    domestic_freight_cny_total: 200,
  }).quote;
  const badParity = await runGate1BForForm(store, {
    form_id: 'f-parity',
    profile_revision: 59,
    existing_quote: qParity,
    early_screen_builder: () => makeScreenScenario(54.99, { fulfillment_usd: 3.10 }), // fabricated cheap FBA fee!
  });
  assert.equal(badParity.status, 'gate1b_pending');
  assert.equal(badParity.proceed_to_gate2_3, false);
  assert.match(badParity.reason, /FBA tier parity/);

  // 3) Rights conflict & low price block Stage 3 BEFORE dispatch (0 deep-research calls; negotiation_shortlist retired in r59)
  const rightsEv = evaluateEarlyScreen(makeScreenScenario(42, { goods_cny_per_unit: 120, specific_rights_conflict: true }), { profileRevision: 59 });
  assert.equal(rightsEv.gate_status, 'fail');
  assert.equal(rightsEv.negotiation_shortlist, undefined);
  const lowPriceEv = evaluateEarlyScreen(makeScreenScenario(28.99, { goods_cny_per_unit: 60 }), { profileRevision: 59 });
  assert.equal(lowPriceEv.gate_status, 'fail');
  assert.equal(lowPriceEv.negotiation_shortlist, undefined);

  let deepResearchDispatched = 0;
  store.upsertCandidateForm({ form_id: 'f-rights-block', label: 'Rights Block', buyer_task: 'Task', saleable_set_composition: { qty: 1 } });
  runGate1AForForm(store, { form_id: 'f-rights-block', profile_revision: 59, scenarios: [makeGate1AScenario({ price_usd: 54.99 })] });
  const qRights = store.recordSourcingQuote1688({
    form_id: 'f-rights-block',
    observed_at: '2026-11-20',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:p01-rights',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'oR', sku_id: 'sR', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 8000,
    domestic_freight_cny_total: 200,
  }).quote;
  const g1bRights = await runGate1BForForm(store, {
    form_id: 'f-rights-block',
    profile_revision: 59,
    existing_quote: qRights,
    early_screen_builder: () => makeScreenScenario(54.99, { specific_rights_conflict: true }),
  });
  assert.equal(g1bRights.status, 'gate1b_rejected');
  assert.equal(g1bRights.negotiation_shortlist, null);
  assert.equal(g1bRights.proceed_to_gate2_3, false);

  // Even re-running batch with specific_rights_conflict omitted ('unknown') carries forward Gate 1B proven rights conflict -> 0 deep-research calls!
  const rightsBatch = await runPhase2Batch(store, {
    profile,
    deep_research_executor: async () => {
      deepResearchDispatched++;
      throw new Error('Should never dispatch deep research on proven rights conflict');
    },
    items: [{
      leads: [{ lead_id: 'ld-r1', source_channel: 'reddit', source_ref: 'https://example.com/community/diy/r1', phrase_or_title: 'rights item', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-rights-block', label: 'Rights Block', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
      early_screen_builder: () => makeScreenScenario(54.99),
    }],
  });
  assert.equal(deepResearchDispatched, 0);
  assert.equal(rightsBatch.gate1a[0].gate_status, 'gate1a_rejected');

  // 4) Stage 3 rejects forged lower procurement cost & undeclared prices, AND propagates Gate 1A $50 cliff into stress_scenarios[]!
  const forgedStage3Cand = structuredClone(fixture.candidates[0]);
  forgedStage3Cand.id = 'f-forged-stage3';
  forgedStage3Cand.screening.reference_price_usd.value = 50.99;
  forgedStage3Cand.economics.scenarios[0].cost_ledger.price_usd = 50.99;
  forgedStage3Cand.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.0;
  forgedStage3Cand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = 2.2;
  forgedStage3Cand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 1.00; // forged low vs ¥80 ($11.43)!

  const forgedRun = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-20',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:p01-stage3-forged',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oF', sku_id: 'sF', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async () => ({ batch: { ...structuredClone(fixture), candidates: [forgedStage3Cand] } }),
    items: [{
      leads: [{ lead_id: 'ld-f3', source_channel: 'reddit', source_ref: 'https://example.com/community/tools/f3', phrase_or_title: 'forged stage3', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-forged-stage3', label: 'Forged S3', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeGate1AScenario({ price_usd: 50.99 })],
      early_screen_builder: () => makeScreenScenario(50.99),
    }],
  });
  assert.equal(forgedRun.gate2_3[0].status, 'gate2_3_error');
  assert.match(forgedRun.gate2_3[0].error, /disagrees with persisted 1688 quote/);

  // Aligned Stage 3 at $50.99 succeeds AND auto-propagates Gate 1A $50 cliff stress scenario!
  const cliffCand = structuredClone(fixture.candidates[0]);
  cliffCand.id = 'f-cliff-prop';
  cliffCand.screening.reference_price_usd.value = 50.99;
  const sc0 = cliffCand.economics.scenarios[0].cost_ledger;
  sc0.price_usd = 50.99;
  sc0.fx_cny_per_usd = 7.0;
  sc0.lines.find(l => l.id === 'headhaul').amount_usd = 2.2;
  sc0.lines.find(l => l.id === 'fulfillment').amount_usd = 6.3549;
  sc0.lines.find(l => l.id === 'placement').amount_usd = 0.34;
  sc0.lines.find(l => l.id === 'procurement').amount_usd = Number((80 / 7).toFixed(4));
  sc0.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((1 / 7).toFixed(4));
  sc0.lines.find(l => l.id === 'domestic_freight').status = 'confirmed';

  let observedHtml = null;
  const cliffRun = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-20',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:p01-cliff',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oC', sku_id: 'sC', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async () => ({
      batch: { ...structuredClone(fixture), candidates: [cliffCand] },
      review_notes: [{ tag: 'CALIBRATION_NOTE', reviewer: 'independent', date: '2026-11-20', note: 'Verified $50 cliff stress.' }],
    }),
    items: [{
      leads: [{ lead_id: 'ld-c50', source_channel: 'pinterest', source_ref: 'https://example.com/boards/pin/12345', phrase_or_title: 'cliff pin item', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-cliff-prop', label: 'Cliff Form', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeGate1AScenario({ price_usd: 50.99 })],
      early_screen_builder: () => makeScreenScenario(50.99),
    }],
  });
  assert.equal(cliffRun.gate2_3[0].status, 'evaluated');
  assert.ok(cliffRun.gate1a[0].scenarios[0].price_cliff_50.status === 'verified');
  const savedEv = store.getEvaluationsForForm('f-cliff-prop')[0];
  assert.equal(JSON.parse(savedEv.review_notes_json)[0].kind, 'CALIBRATION_NOTE');
  // Verify original caller cliffCand wasn't mutated
  assert.equal(cliffCand.economics.stress_scenarios, undefined);
  void observedHtml;
  store.close();
});

// ============================================================================
// P0-2: 8 Cross-category 2027 return thresholds, override seam, forward solver, Coupon/Prime
// ============================================================================
test('P0-2: Official 2027 cross-category return thresholds, calculator override seam, bidirectional forward price solver, and Coupon/Prime net-price & double-deduction guard', () => {
  // 1) All 8 new official 2027 thresholds + 4 canonical aliases
  const expected = {
    'Home and Kitchen': 0.081,
    'Lawn and Garden': 0.077,
    'Patio, Lawn and Garden': 0.077,
    'Pet Products': 0.102,
    'Pet Supplies': 0.102,
    'Sports and Outdoors': 0.087,
    'Office Products': 0.044,
    'Automotive and Powersports': 0.091,
    Automotive: 0.091,
    'Musical Instruments and AV Production': 0.092,
    'Musical Instruments': 0.092,
    'Beauty, Health, and Personal Care': 0.055,
  };
  for (const [cat, thr] of Object.entries(expected)) {
    const m = lookupVerified2027ReturnThreshold(cat);
    assert.ok(m, `Expected verified 2027 return threshold for ${cat}`);
    assert.equal(m.threshold, thr, `Threshold mismatch for ${cat}`);
  }
  assert.ok(Object.keys(VERIFIED_2027_RETURN_THRESHOLDS).length >= 12);

  // Verify lookupReturnsProcessing2027 accepts new cross-category alias ('Pet Supplies')
  const petRet = lookupReturnsProcessing2027({
    pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
    physical_return_fraction: 0.12,
    fee_category: 'Pet Supplies',
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    is_apparel_or_shoes: false,
    is_dangerous_goods: false,
  });
  assert.equal(petRet.status, 'verified');
  assert.equal(petRet.fee_category_canonical, 'Pet Products');
  assert.equal(petRet.return_threshold, 0.102);
  assert.ok(petRet.expected_fee_per_shipped_unit_usd > 0);

  // 2) Official 2027 Bulky schedule is verified in r59, while unpublished Q4 peak requires verification & evidenced calculator_verified_override seam works
  const bulkyBase = makeGate1AScenario({
    pkg: { length_in: 24, width_in: 18, height_in: 10, weight_lb: 22 }, // Bulky!
    price_usd: 79.99,
    fee_category: 'Home and Kitchen',
    physical_return_fraction: 0.10, // > 0.081 threshold!
  });
  assert.equal(estimateGate1A2027(bulkyBase).status, 'verified');
  assert.equal(estimateGate1A2027({ ...bulkyBase, sales_window: { from: '2027-10-15', through: '2027-12-31' } }).status, 'needs_calculator_verification');

  // Unexempted zero returns_processing_usd when r_physical > threshold MUST be rejected!
  const badOverride = estimateGate1A2027({
    ...bulkyBase,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-20',
      evidence_ref: 'ev-calc-bulky-1',
      verified_price_band: 'over_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: bulkyBase.pkg,
      fulfillment_usd: 14.20,
      placement_usd: 1.85,
      storage_per_unit_usd: 0.92,
      returns_processing_usd: 0, // illegal without returns_processing_exempt: true!
    },
  });
  assert.equal(badOverride.status, 'needs_calculator_verification');
  assert.match(badOverride.reason, /returns_processing_usd/);

  const goodOverride = estimateGate1A2027({
    ...bulkyBase,
    calculator_verified_override: {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-20',
      evidence_ref: 'ev-calc-bulky-1',
      verified_price_band: 'over_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: bulkyBase.pkg,
      size_tier: 'large_bulky',
      fulfillment_usd: 14.20,
      placement_usd: 1.85,
      storage_per_unit_usd: 0.92,
      returns_processing_usd: 0.19,
    },
  });
  assert.equal(goodOverride.status, 'verified');
  assert.equal(goodOverride.verification_source, 'calculator_verified_override');
  assert.ok(goodOverride.landed_domestic_cap_cny > 0);

  // 3) Bidirectional forward breakeven selling price solver across $50 FBA tier cliff
  const solved = solveMinPriceForMargin2027({
    ...makeGate1AScenario(),
    landed_domestic_cny: 112, // $16.00 landed domestic at FX 7.0
    fx_cny_per_usd: 7.0,
    margin_floor: 0.30,
  });
  assert.equal(solved.status, 'verified');
  assert.ok(solved.feasible_min_price_usd >= 29.99);
  // Exact cent optimality: solved price passes, solved - $0.01 fails!
  const atSolved = estimateGate1A2027({ ...makeGate1AScenario({ price_usd: solved.feasible_min_price_usd }), min_landed_domestic_usd: 16.0 });
  const oneCentBelow = estimateGate1A2027({ ...makeGate1AScenario({ price_usd: Number((solved.feasible_min_price_usd - 0.01).toFixed(2)) }), min_landed_domestic_usd: 16.0 });
  assert.equal(atSolved.zero_browser_fail, false);
  assert.equal(oneCentBelow.zero_browser_fail, true);

  // Test exact $50.00 cliff jump where $50.00 barely fails and $50.01 ALSO fails (dead zone), solving in over_50 band!
  const at50 = estimateGate1A2027(makeGate1AScenario({ price_usd: 50.00 }));
  const justAbove50CapUsd = Number((at50.landed_domestic_cap_usd + 0.05).toFixed(4));
  const solvedCliff = solveMinPriceForMargin2027({
    ...makeGate1AScenario(),
    landed_domestic_usd: justAbove50CapUsd,
    fx_cny_per_usd: 7.0,
    margin_floor: 0.30,
  });
  assert.equal(solvedCliff.status, 'verified');
  assert.ok(solvedCliff.feasible_min_price_usd > 50.01, `Expected cliff dead-zone jump above $50.01, got ${solvedCliff.feasible_min_price_usd}`);
  assert.equal(solvedCliff.price_band, 'over_50');

  // 4) Ongoing Coupon / Prime net_effective_price_usd + double-deduction guard
  const eff = resolveEffectivePricing({ list_price_usd: 59.99, ongoing_coupon_usd: 5.00 });
  assert.equal(eff.valid, true);
  assert.equal(eff.net_effective_price_usd, 54.99);
  const dbl = resolveEffectivePricing({ price_usd: 54.99, ongoing_coupon_usd: 5.00, promo_basis_already_net: true });
  assert.equal(dbl.valid, false);
  assert.match(dbl.reason, /Double-deduction/i);
  const docNet = resolveEffectivePricing({ list_price_usd: 59.99, price_usd: 54.99, ongoing_coupon_usd: 5.00, promo_basis_already_net: true });
  assert.equal(docNet.valid, true);
  assert.equal(docNet.net_effective_price_usd, 54.99);

  // Verify calculateEconomics & scoreCandidate block double-deduction on stress_scenarios[] and warn on unverified $50 promo tier crossing
  const promoCand = structuredClone(fixture.candidates[0]);
  promoCand.screening.reference_price_usd.list_price_usd = 54.99;
  promoCand.screening.reference_price_usd.ongoing_coupon_usd = 5.00;
  promoCand.screening.reference_price_usd.net_effective_price_usd = 49.99;
  promoCand.screening.reference_price_usd.value = 49.99;
  promoCand.economics.scenarios[0].cost_ledger.list_price_usd = 54.99;
  promoCand.economics.scenarios[0].cost_ledger.ongoing_coupon_usd = 5.00;
  promoCand.economics.scenarios[0].cost_ledger.price_usd = 49.99;
  promoCand.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.0;
  const primaryFul = promoCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment');
  primaryFul.fulfillment_promo_tier_verified = true;
  primaryFul.price_band = '10_to_50';
  const dblStressLedger = structuredClone(promoCand.economics.scenarios[0].cost_ledger);
  dblStressLedger.id = 'stress-double-coupon';
  dblStressLedger.list_price_usd = 49.99; // stacks another coupon on already-net $49.99!
  dblStressLedger.ongoing_coupon_usd = 5.00;
  dblStressLedger.price_usd = 44.99;
  const cross50StressLedger = structuredClone(promoCand.economics.scenarios[0].cost_ledger);
  cross50StressLedger.id = 'stress-promo-cross50';
  cross50StressLedger.list_price_usd = 54.99;
  cross50StressLedger.ongoing_coupon_usd = 5.00;
  cross50StressLedger.price_usd = 49.99;
  delete cross50StressLedger.lines.find(l => l.id === 'fulfillment').fulfillment_promo_tier_verified;
  delete cross50StressLedger.lines.find(l => l.id === 'fulfillment').price_band;
  promoCand.economics.stress_scenarios = [
    { id: 'stress-double-coupon', label: '重复扣券测试', stress_type: 'self_coupon', saleable_unit: promoCand.economics.saleable_unit, coherent: true, assumptions: ['测试双扣'], cost_ledger: dblStressLedger },
    { id: 'stress-promo-cross50', label: '跨$50促销费档测试', stress_type: 'self_coupon', saleable_unit: promoCand.economics.saleable_unit, coherent: true, assumptions: ['未核促销费档'], cost_ledger: cross50StressLedger },
  ];
  const scoredPromo = scoreCandidate(promoCand, profile);
  assert.ok(scoredPromo.diagnostics.economics.scenarios[0].input.calculation.landed_domestic_cap_at_30pct_cny > 0);
  const stDbl = scoredPromo.diagnostics.economics.stress_scenarios.find(s => s.id === 'stress-double-coupon');
  const stCross = scoredPromo.diagnostics.economics.stress_scenarios.find(s => s.id === 'stress-promo-cross50');
  assert.equal(stDbl.double_deduction_blocked, true);
  assert.equal(stDbl.margin, null);
  assert.ok(stDbl.stress_issues.some(i => i.code === 'coupon_double_deduction_blocked'));
  assert.ok(stCross.stress_issues.some(i => i.code === 'promo_tier_crossing_unverified'));
  assert.equal(stCross.margin, null);
});

// ============================================================================
// P0-3: Gate-0 filter, Stage-1 price-band denoising, Stage-2 contact-sheet
// ============================================================================
test('P0-3: Gate-0 cross-category filter, Stage-1 mainstream price-band denoising + width alarm + cluster tightening, and offline contact-sheet rendering', () => {
  // 1) Gate-0 category boundary
  const childBlocked = evaluateGate0CategoryBoundary({ root_category: 'Toys & Games', title: 'Montessori toddler puzzle box' });
  assert.equal(childBlocked.passed, false);
  assert.equal(childBlocked.hard_exclusion, true);

  const apparelAvoided = evaluateGate0CategoryBoundary({ root_category: 'Clothing, Shoes & Jewelry', title: 'Cotton work shirt' });
  assert.equal(apparelAvoided.passed, false);
  assert.equal(apparelAvoided.hard_exclusion, false);

  const poweredNeedsCost = evaluateGate0CategoryBoundary({ root_category: 'Home & Kitchen', title: 'Cordless ultrasonic cleaner', is_powered: true, has_battery: true });
  assert.equal(poweredNeedsCost.passed, true);
  assert.equal(poweredNeedsCost.powered_non_3c, true);
  assert.ok(poweredNeedsCost.required_cost_and_compliance_items.length >= 2);

  // 2) Stage-1 mainstream price-band denoising & width alarm
  const rawListings = [
    { asin: 'A01', price_usd: 39.99, units_30d: 200, fulfillment_channel: 'FBA', age_days: 400, size_tier: 'large_standard', cluster_id: 'basic' },
    { asin: 'A02', price_usd: 42.99, units_30d: 180, fulfillment_channel: 'FBA', age_days: 500, size_tier: 'large_standard', cluster_id: 'basic' },
    { asin: 'A03', price_usd: 74.99, units_30d: 210, fulfillment_channel: 'FBA', age_days: 600, size_tier: 'large_standard', cluster_id: 'pro' },
    { asin: 'A04', price_usd: 79.99, units_30d: 190, fulfillment_channel: 'FBA', age_days: 450, size_tier: 'large_standard', cluster_id: 'pro' },
    { asin: 'A05', price_usd: 45.00, units_30d: 50, fulfillment_channel: 'FBM', age_days: 300, size_tier: 'large_standard' }, // FBM excluded
    { asin: 'A06', price_usd: 55.00, units_30d: 5, fulfillment_channel: 'FBA', age_days: 300, size_tier: 'large_standard' }, // <10/mo zombie excluded
    { asin: 'A07', price_usd: 22.99, units_30d: 150, fulfillment_channel: 'FBA', age_days: 60, ongoing_coupon_pct: 0.25, size_tier: 'large_standard' }, // launch spiral -> spiral_watch!
    { asin: 'A08', price_usd: 35.00, units_30d: 90, fulfillment_channel: 'FBA', age_days: 400, is_childrens_product: true, size_tier: 'large_standard' }, // children excluded
    { asin: 'A09', price_usd: 99.00, units_30d: 80, fulfillment_channel: 'FBA', age_days: 400, size_tier: 'large_bulky' }, // tier mismatch excluded
  ];
  const band = analyzeMainstreamPriceBand(rawListings, { target_size_tier: 'large_standard' });
  assert.equal(band.mainstream_count, 4);
  assert.equal(band.excluded_count, 4);
  assert.equal(band.spiral_watch_count, 1);
  assert.equal(band.spiral_watch[0].asin, 'A07');
  assert.equal(band.guardrail.width_alarm, true); // P75/P25 ~ 74.99/42.99 > 1.35!

  // Stage-2 cluster tightening splits basic vs pro into tight bands!
  const tightened = tightenClusterBands(band, [
    { cluster_id: 'basic', label: 'Basic Tier', asins: ['A01', 'A02'] },
    { cluster_id: 'pro', label: 'Pro Tier', asins: ['A03', 'A04'] },
  ]);
  assert.equal(tightened.clusters.length, 2);
  assert.equal(tightened.clusters[0].tightened_pass, true);
  assert.equal(tightened.clusters[1].tightened_pass, true);
  assert.equal(tightened.all_clusters_tightened, true);

  // 3) Stage-2 offline 4x4 contact-sheet script (real PNG + graceful [NO IMAGE] fallback)
  withTempDir(dir => {
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=',
      'base64',
    );
    const localImgPath = join(dir, 'sample.png');
    writeFileSync(localImgPath, tinyPng);
    const itemsPath = join(dir, 'sheet-items.json');
    const outPng = join(dir, 'sheet.png');
    const outManifest = join(dir, 'sheet-manifest.json');
    writeFileSync(itemsPath, JSON.stringify([
      { asin: 'SYNTH00001', price_usd: 49.99, sales_30d: 320, rating: 4.5, reviews: 120, fba_fee_usd: 5.76, cluster: 'A', image_path: localImgPath },
      { asin: 'SYNTH00002', price_usd: 54.99, promo_text: '10% coupon', sales_30d: 180, rating: 4.2, reviews: 45, fba_fee_usd: 6.35, cluster: 'B', image_path: join(dir, 'does-not-exist.png') },
    ]), 'utf8');

    const cliRes = spawnSync('node', [
      CLI_PATH, 'contact-sheet',
      '--input', itemsPath,
      '--output', outPng,
      '--manifest-out', outManifest,
      '--title', 'Synthetic 4x4 Cluster Test',
      '--offline',
    ], { encoding: 'utf8' });
    assert.equal(cliRes.status, 0, `contact-sheet CLI failed: ${cliRes.stderr}`);
    const parsedOut = JSON.parse(cliRes.stdout);
    assert.equal(parsedOut.ok, true);
    assert.equal(parsedOut.rendered.images_loaded, 1);
    assert.equal(parsedOut.rendered.images_missing, 1);
    assert.equal(existsSync(outPng), true);
    const pngBytes = readFileSync(outPng);
    assert.deepEqual(pngBytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    // Render embedded contact-sheet data URI in r58 HTML card!
    const candWithSheet = structuredClone(fixture.candidates[0]);
    candWithSheet.presentation = {
      ...(candWithSheet.presentation ?? {}),
      contact_sheet_data_uri: `data:image/png;base64,${pngBytes.toString('base64')}`,
    };
    const b = { ...structuredClone(fixture), candidates: [candWithSheet] };
    const html = renderReport(scoreBatch(b, profile), b);
    assert.match(html, /data-section="contact-sheet"/);
    assert.match(html, /视觉聚类联系表（4×4）/);
  });
});

// ============================================================================
// P0-4: Connector parameter guards, Shenzhen regex, billed-failure & 4-way quota
// ============================================================================
test('P0-4: SellerSprite/SIF connector guards, Shenzhen destination parser, billed-failure reconciliation, and 4-way unknown quota reserve', () => {
  // 1) SellerSprite guards
  const leafBsr = validateProviderCall('sellersprite', 'asin_list_1234abcd', { categoryId: '123:456', bsr: { min: 1, max: 100 } });
  assert.equal(leafBsr.valid, false);
  assert.ok(leafBsr.issues.some(e => e.code === 'leaf_asin_list_bsr_forbidden'));

  const badCat = validateProviderCall('sellersprite', 'category_stats_list', { marketplace: 'US', categoryId: '552408' });
  assert.equal(badCat.valid, false);
  assert.ok(badCat.issues.some(e => e.code === 'missing_full_colon_category_path'));

  const badProdRes = validateProviderCall('sellersprite', 'product_research', { marketplace: 'US', nodeIdPath: '100:200' });
  assert.equal(badProdRes.valid, false);
  assert.ok(badProdRes.issues.some(e => e.code === 'missing_filter_sub_y'));
  assert.ok(badProdRes.issues.some(e => e.code === 'singular_node_id_path_forbidden'));

  // 2) SIF guards + math helpers
  const badSif7d = validateProviderCall('sif', 'ops_get_listing_traffic_overview', { asin: 'SYNTH00001', country: 'US' });
  assert.equal(badSif7d.valid, false);
  assert.ok(badSif7d.issues.some(e => e.code === 'sif_window_must_be_30_days'));

  const okSif30d = validateProviderCall('sif', 'ops_get_listing_traffic_overview', { asin: 'SYNTH00001', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true });
  assert.equal(okSif30d.valid, true);

  // market_assess_keyword_promotion rejects G/R instead of G/P
  assert.equal(computeSifOwnMargin(15, 50), 0.3);
  const badPromo = validateProviderCall('sif', 'market_assess_keyword_promotion', { own_price: 50, own_margin: 15 / 48 }, { contribution_usd: 15, price_usd: 50, refund_fraction: 0.04 });
  assert.equal(badPromo.valid, false);
  assert.ok(badPromo.issues.some(e => e.code === 'sif_own_margin_must_be_G_over_P'));

  const trafficStruct = parseSifTrafficStructure({
    chars: {
      dims: ['SYNTH00002', 'SYNTH00003'],
      nfs: [{ ratio: 0.62, dist: 0.41 }, null],
      sps: [{ ratio: 0.38, dist: 0.59 }, { ratio: 0.62, dist: 0.80 }],
    },
  });
  assert.equal(trafficStruct.variants[0].vertical_variant_share_ratio.nfs, 0.62);
  assert.equal(trafficStruct.variants[0].horizontal_channel_mix_dist.nfs, 0.41);
  assert.equal(trafficStruct.variants[1].vertical_variant_share_ratio.nfs, null); // null preserved, never 0!

  const clickCvr = computeClickConversionRate({ purchaseVolume: 24, clicks: 200 });
  assert.equal(clickCvr.click_conv_rate, 0.12);
  assert.throws(() => computeClickConversionRate({ purchaseRate: 0.04 }), /Forbidden denominator mixup/);
  assert.throws(() => computeClickConversionRate({ purchases: 24, clicks: 200 }), /purchaseVolume/);

  const revOwn = verifyReviewVariantOwnership(
    [
      { reviewId: 'r1', date: '2026-10-01', skus: ['SYNTH00004'] },
      { reviewId: 'r2', date: '2024-01-01', skus: ['SYNTH00005'] },
      { reviewId: 'r3', date: '2025-05-01' },
    ],
    { target_asin: 'SYNTH00004' },
  );
  assert.equal(revOwn.verified_reviews.length, 1);
  assert.equal(revOwn.excluded_other_variant.length, 1);
  assert.equal(revOwn.unverified_missing_sku.length, 1);

  // 3) Shenzhen destination parser
  assert.equal(isShenzhenDestination('发货地：深圳，收货地：上海'), false);
  assert.equal(isShenzhenDestination('From: Shenzhen, To: Shanghai'), false);
  assert.equal(isShenzhenDestination('深圳发往上海'), false);
  assert.equal(isShenzhenDestination('发货地：义乌，收货地：广东深圳'), true);
  assert.equal(isShenzhenDestination('广东深圳'), true);

  // 4) Billed-failure reconciliation keeps repeat_submission_allowed = 0 AND 4-way unknown reserve tracks all 4 lanes
  const store = openSelectionStore(':memory:');
  const rSs = store.reserveRequestAttempt({
    account_scope: 'default-us',
    provider: 'sellersprite',
    tool_name: 'asin_list',
    observation_cutoff_date: '2026-11-20',
    estimated_ss_mcp_units: 3,
  });
  store.failAttemptUnknownOutcome(rSs.attempt_id, 'socket hangup');
  const rExa = store.reserveRequestAttempt({
    account_scope: 'default-us',
    provider: 'exa',
    tool_name: 'web_search_exa',
    observation_cutoff_date: '2026-11-20',
    estimated_exa_calls: 2,
  });
  store.failAttemptUnknownOutcome(rExa.attempt_id, 'timeout');
  const qBefore = store.getQuotaSummary();
  assert.equal(qBefore.unknown_reserved_ss_mcp_units, 3);
  assert.equal(qBefore.unknown_reserved_exa_calls, 2);
  assert.equal(qBefore.by_lane.ss_mcp.unknown_reserved, 3);
  assert.equal(qBefore.by_lane.exa.unknown_reserved, 2);

  // Reconcile SS attempt as failed WITH ss_mcp_units: 3 -> repeat_submission_allowed MUST stay 0!
  const recBilled = store.reconcileUnknownAttempt(rSs.attempt_id, {
    resolved_status: 'failed',
    note: 'Confirmed deducted on SellerSprite usage console',
    ss_mcp_units: 3,
  });
  assert.equal(recBilled.repeat_submission_allowed, 0);
  // Reconcile Exa attempt as failed WITH 0 units -> repeat_submission_allowed becomes 1!
  const recUnbilled = store.reconcileUnknownAttempt(rExa.attempt_id, {
    resolved_status: 'failed',
    note: 'Confirmed 0 charge on Exa console',
    exa_calls: 0,
  });
  assert.equal(recUnbilled.repeat_submission_allowed, 1);
  store.close();
});

// ============================================================================
// P0-5: Multi-channel discovery registry, Track A/B/C, cooldown, validators, SQLite provenance
// ============================================================================
test('P0-5: Multi-channel anti-convergence registry, coverage audit, batch planner, SocialBridge/SpecMatcher/RubricJudge validators, and non-keyword HTML provenance', async () => {
  assert.ok(Object.keys(DISCOVERY_CHANNELS).length >= 15);
  assert.equal(resolveChannelMeta('reddit').route, 'social_cross_platform');
  assert.equal(resolveChannelMeta('1688_factory_cold_start').route, 'supply_factory_cold_start');
  assert.equal(resolveChannelMeta('google_trends').route, 'demand_signals_trends');
  assert.equal(resolveChannelMeta('ss_supply_gap_low_rating').route, 'in_site_product_market');

  assert.equal(classifyPromotionTrack({ leads: [{ source_channel: 'reddit' }, { source_channel: 'google_trends' }] }).promotion_track, 'track_a_resonance');
  assert.equal(classifyPromotionTrack({ leads: [{ source_channel: 'ss_supply_gap_low_rating' }], opportunity_type: 'supply_gap', is_breakout_signal: true }).promotion_track, 'track_b_breakout');
  assert.equal(classifyPromotionTrack({ leads: [{ source_channel: 'ss_category_steady' }], opportunity_type: 'steady' }).promotion_track, 'track_c_steady_sample');

  const store = openSelectionStore(':memory:');
  // Reject malformed SocialBridge payload
  assert.throws(() => store.ingestSocialBridgeLead({ source_channel: 'reddit', raw_excerpt: 'too short' }), /SocialBridgeExtractor/);

  // Ingest valid SocialBridge lead -> persists with real route/entry_group (never hardcoded 'in_site'!)
  store.upsertCandidateForm({ form_id: 'f-social-prov', label: 'Miter Corner Clamp', buyer_task: 'Hold mitered cabinet frames square while glue sets', saleable_set_composition: { qty: 1 } });
  const sbRes = store.ingestSocialBridgeLead({
    schema_version: 1,
    contract: 'SocialBridgeExtractor',
    status: 'extracted',
    platform: 'reddit',
    source_url: 'https://example.org/community/woodworking/sb1',
    observed_at: '2026-11-20',
    event_dedup_key: 'reddit:sb1:miter-clamp',
    verbatim_excerpt: 'My cheap corner clamp always slips when gluing mitered cabinet frames.',
    buyer_task: 'Hold mitered cabinet frames square while glue sets',
    candidate_phrases: ['miter corner clamp woodworking'],
  }, { form_id: 'f-social-prov', disposition: 'product' });
  assert.equal(sbRes.lead.route, 'social_cross_platform');
  assert.equal(sbRes.lead.entry_group, 'social');

  // Cooldown tracking
  const cd = store.setFormCooldown('f-social-prov', '2027-02-20', 'Wait for Q1 restock');
  assert.equal(cd.cooldown_until, '2027-02-20');

  // Invalid spec_match on upsertCandidateForm throws
  assert.throws(() => store.upsertCandidateForm({
    form_id: 'f-bad-spec',
    label: 'Bad Spec',
    buyer_task: 'Task',
    saleable_set_composition: { qty: 1 },
    spec_match: { candidate_url: 'not-a-url', matched: true },
  }), /SpecMatcher|url|dimensions|match/i);

  // Add 6 Amazon in-site leads so coverage audit flags single-channel concentration (>70%) & plans untested routes first!
  for (let i = 1; i <= 6; i++) {
    store.upsertRawLead({
      lead_id: `ld-amz-${i}`,
      source_channel: 'ss_category_steady',
      source_ref: `ss:cat:row-${i}`,
      phrase_or_title: `in site keyword ${i}`,
      observed_at: '2026-11-20',
      disposition: 'product',
    });
  }
  const audit = auditDiscoveryCoverage(store);
  assert.ok(audit.anti_convergence_alerts.some(a => a.code === 'single_channel_concentration'));
  assert.ok(audit.available_untested_channels.includes('1688_factory_cold_start'));
  assert.equal(DISCOVERY_CHANNELS.x_twitter.active, false);
  assert.equal(resolveChannelMeta('x').channel_id, 'x_twitter');
  assert.ok(audit.deferred_channels.includes('x_twitter'));
  assert.ok(!audit.available_untested_channels.includes('x_twitter'));

  const plan = planDiscoveryBatch(store, { max_channels: 5 });
  assert.equal(plan.recommended_channels.length, 5);
  assert.ok(plan.recommended_channels.some(a => a.route === 'supply_factory_cold_start'));
  assert.ok(plan.recommended_channels.some(a => a.route === 'demand_signals_trends'));
  const fullPlan = planDiscoveryBatch(store, { max_channels: 20 });
  assert.ok(!fullPlan.recommended_channels.some(a => a.channel_id === 'x_twitter'));
  assert.ok(fullPlan.deferred_channels.includes('x_twitter'));

  // SQLite non-keyword discovery provenance attaches & renders cleanly into r58 HTML!
  const candSocial = structuredClone(fixture.candidates[0]);
  candSocial.id = 'f-social-prov';
  const attached = attachStoreDiscoveryProvenance({ ...structuredClone(fixture), candidates: [candSocial] }, store);
  assert.equal(attached.candidates[0].discovery.store_leads.length, 1);
  const scored = scoreBatch(attached, profile);
  const html = renderReport(scored, attached);
  assert.match(html, /data-section="store-discovery-provenance"/);
  assert.match(html, /social_cross_platform/);

  // Verify summary exposes funnel_by_route & quota_by_lane & sanitized db_path
  const sum = store.getSummary();
  assert.ok(sum.funnel_by_route.in_site_product_market);
  assert.ok(sum.quota_by_lane.ss_mcp);
  store.close();
});

// ============================================================================
// P1-2, P1-3, P1-4: 6 Operational Disclosures, r58 Report Polish, Negotiation Appendix
// ============================================================================
test('P1-2/P1-3/P1-4: 6 deterministic operational disclosures, break_even_click_cvr, coverage-vs-exposure diagnosis, >100 sets label, 4 filter pills, split seasonal nav, and folded negotiation appendix', () => {
  const cand = structuredClone(fixture.candidates[0]);
  cand.id = 'cand-full-ops';
  // Trigger >100 order_units (360 -> MOQ >= 300 alert!), Amazon 1P, private A4 freight tariff flags, sensitive freebie, ADD/CVD, and 2027-01-11 bundle warning!
  const ledger = cand.economics.scenarios[0].cost_ledger;
  ledger.fx_cny_per_usd = 7.0;
  ledger.lines.find(l => l.id === 'procurement').order_units = 360;
  ledger.lines.find(l => l.id === 'domestic_freight').order_units = 360;
  cand.operations = {
    order_units: 360,
    actual_complete_sets: 360,
    remainder_units: 12,
    lead_time_days: 22,
    amazon_1p_offers: [{ asin: 'SYNTH1P001', seller_type: 'AMZ', buybox_share: 0.35 }],
    shipment: { actual_weight_kg: 7.2, carton_cm: [50, 40, 40], volumetric_divisor: 6000, carton_count: 1 },
    sensitive_freebie_flags: ['included lubricating oil bottle'],
    hs_code: '8205.59.5510',
    us_add_cvd_risk: true,
    packaging: { is_multi_sku_bundle: true, original_manufacturer_packaging: false, micron_tolerance: 50 },
  };
  cand.review_notes = [{ tag: 'CALIBRATION_NOTE', reviewer: 'qa', date: '2026-11-20', note: 'Checked 6 operational disclosures.' }];

  // Trigger SS organic high vs SIF natural low -> 覆盖广、曝光弱!
  const nc0 = cand.newcomer_cohort.members[0];
  nc0.natural.value = 0.22;
  nc0.natural.keyword_counts = {
    sellersprite: {
      organic: { value: 95, unit: 'count', evidence: [cand.evidence[0].id] },
      ad: { value: 18, unit: 'count', evidence: [cand.evidence[0].id] },
    },
    sif: {
      organic: { value: 30, unit: 'count', evidence: [cand.evidence[0].id] },
      ad: { value: 40, unit: 'count', evidence: [cand.evidence[0].id] },
    },
  };

  // Add a second excluded candidate + batch negotiation_shortlist (one <=12% valid, one >12% filtered out, one rights-conflict filtered out)
  const batch = {
    ...structuredClone(fixture),
    candidates: [cand],
    negotiation_shortlist: [
      { candidate_id: 'cand-neg-1', label: 'Close-Margin Wrench', required_discount_fraction: 0.065, current_cost_usd: 14.0, target_cost_usd: 13.09, price_usd: 49.99 },
      { candidate_id: 'cand-neg-too-far', label: 'Too Expensive', required_discount_fraction: 0.22, current_cost_usd: 20.0, target_cost_usd: 15.6, price_usd: 49.99 },
      { candidate_id: 'cand-neg-rights', label: 'Patented Item', required_discount_fraction: 0.04, specific_rights_conflict: true, price_usd: 49.99 },
    ],
  };

  const res = scoreBatch(batch, profile);
  const sc = res.candidates[0];
  assert.equal(sc.diagnostics.operational_disclosures.length, 6);
  for (const d of sc.diagnostics.operational_disclosures) {
    assert.equal(d.status, 'alert', `Expected alert on ${d.id}`);
  }
  assert.ok(sc.diagnostics.economics.break_even_click_cvr);
  assert.ok(sc.diagnostics.economics.break_even_click_cvr.scenarios[0].break_even_click_cvr > 0);
  assert.equal(sc.diagnostics.newcomers.examples[0].natural.coverage_exposure_mismatch, true);

  const html = renderReport(res, batch);
  assert.match(html, /运营排雷与实操核查（6 项零否决披露 · 6 项预警）/);
  assert.match(html, /2027-01-11/);
  assert.match(html, /覆盖广、曝光弱/);
  assert.match(html, /1688到深含运（360套）/);
  assert.match(html, /约 ¥/);
  assert.match(html, /id="filter-pending"/);
  assert.match(html, /淘汰／暂缓/);
  assert.match(html, /data-section="review-notes"/);
  assert.doesNotMatch(html, /data-section="negotiation-shortlist"/);
  assert.doesNotMatch(html, /Too Expensive/);
  assert.doesNotMatch(html, /Patented Item/);
  // Stale r51-57 Q31 copy must NOT appear in r58 HTML
  assert.doesNotMatch(html, /再取至多两个最佳完整示例/);
});

// ============================================================================
// P1-1: Real spawnSync subprocess tests for src/phase2-cli.mjs
// ============================================================================
test('P1-1: Real subprocess CLI tests for phase2-cli (init, price-band, gate1a, gate1b, reconcile, coverage, plan-discovery, export-report, stderr redaction)', () => {
  withTempDir(dir => {
    const dbPath = join(dir, 'cli-e2e.sqlite');
    const runCli = args => spawnSync('node', [CLI_PATH, ...args], { encoding: 'utf8' });

    // 1) init
    const initRes = runCli(['init', '--db', dbPath]);
    assert.equal(initRes.status, 0, initRes.stderr);
    const initJson = JSON.parse(initRes.stdout);
    assert.equal(initJson.ok, true);
    assert.doesNotMatch(initJson.summary.db_path, /[A-Za-z]:\\Users\\[^\\]+/i);

    // 2) price-band (stateless)
    const pbIn = join(dir, 'pb.json');
    const pbOut = join(dir, 'pb-out.json');
    writeFileSync(pbIn, JSON.stringify({
      category_check: { category: 'Tools & Home Improvement', title: 'Manual miter gauge' },
      listings: [
        { asin: 'PB1', price_usd: 44.99, units_30d: 120, fulfillment_channel: 'FBA', age_days: 300 },
        { asin: 'PB2', price_usd: 49.99, units_30d: 150, fulfillment_channel: 'FBA', age_days: 400 },
      ],
    }), 'utf8');
    const pbRes = runCli(['price-band', '--input', pbIn, '--output', pbOut]);
    assert.equal(pbRes.status, 0, pbRes.stderr);
    assert.equal(JSON.parse(pbRes.stdout).analysis.mainstream_count, 2);
    assert.equal(existsSync(pbOut), true);

    // 3) gate1a + gate1b via CLI
    const g1aPath = join(dir, 'g1a.json');
    writeFileSync(g1aPath, JSON.stringify({
      form: { form_id: 'cli-form-1', label: 'CLI Jig', buyer_task: 'Drill holes', saleable_set_composition: { qty: 1 } },
      leads: [{ lead_id: 'cli-ld-1', source_channel: '1688_factory_cold_start', source_ref: 'https://example.com/supplier/offer/1', phrase_or_title: 'cli jig', observed_at: '2026-11-20', disposition: 'product' }],
      scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
    }), 'utf8');
    const g1aRes = runCli(['gate1a', '--db', dbPath, '--input', g1aPath]);
    assert.equal(g1aRes.status, 0, g1aRes.stderr);
    assert.equal(JSON.parse(g1aRes.stdout).result.gate_status, 'gate1a_passed');

    const g1bPath = join(dir, 'g1b.json');
    writeFileSync(g1bPath, JSON.stringify({
      form_id: 'cli-form-1',
      profile_revision: 59,
      quote: {
        observed_at: '2026-11-20',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:cli-1',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'o1', sku_id: 's1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 85, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8500,
        domestic_freight_cny_total: 200,
        ui_readback: DEFAULT_R59_UI_READBACK,
      },
      early_screen_scenarios: [makeScreenScenario(54.99)],
    }), 'utf8');
    const g1bRes = runCli(['gate1b', '--db', dbPath, '--input', g1bPath, '--as-of', '2026-11-20']);
    assert.equal(g1bRes.status, 0, g1bRes.stderr);
    assert.equal(JSON.parse(g1bRes.stdout).result.status, 'gate1b_passed');

    // 4) coverage & plan-discovery (read-only)
    const covRes = runCli(['coverage', '--db', dbPath]);
    assert.equal(covRes.status, 0, covRes.stderr);
    assert.equal(JSON.parse(covRes.stdout).audit.totals.raw_leads, 1);

    const planRes = runCli(['plan-discovery', '--db', dbPath, '--budget', '4']);
    assert.equal(planRes.status, 0, planRes.stderr);
    assert.equal(JSON.parse(planRes.stdout).plan.recommended_channels.length, 4);

    // 5) reconcile via CLI
    const s = openSelectionStore(dbPath);
    const unk = s.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-20',
      estimated_sif_units: 3,
    });
    s.failAttemptUnknownOutcome(unk.attempt_id, 'timeout');
    s.close();

    const recRes = runCli(['reconcile', '--db', dbPath, '--attempt', unk.attempt_id, '--status', 'failed', '--sif-units', '3', '--note', 'Billed on console']);
    assert.equal(recRes.status, 0, recRes.stderr);
    const recJson = JSON.parse(recRes.stdout);
    assert.equal(recJson.reconciled.repeat_submission_allowed, 0);
    assert.equal(recJson.quota_summary.unknown_attempts, 0);

    // 6) export-report writes result.json, index.html, receipt.json to disk (no longer discarded!)
    const outDir = join(dir, 'exported-report');
    const expRes = runCli(['export-report', '--db', dbPath, '--batch', FIXTURE_PATH, '--profile', PROFILE_PATH, '--output', outDir]);
    assert.equal(expRes.status, 0, expRes.stderr);
    assert.equal(existsSync(join(outDir, 'result.json')), true);
    assert.equal(existsSync(join(outDir, 'index.html')), true);
    assert.equal(existsSync(join(outDir, 'receipt.json')), true);

    // 7) stderr sanitization never leaks raw local user home path
    const synthWinUserPath = ['C:', 'Users', 'placeholderacct', 'missing-secret-file.json'].join('\\');
    const errRes = runCli(['gate1a', '--db', dbPath, '--input', synthWinUserPath]);
    assert.equal(errRes.status, 2);
    assert.doesNotMatch(errRes.stderr, /placeholderacct/i);
  });
});

// ============================================================================
// Independent GPT-6.2 Astra Review Regressions (CRITICAL #1-#3, HIGH #1-#10, MEDIUM #1-#9, LOW #1-#2, Privacy & Harness)
// ============================================================================
test('GPT Review Regressions C1-C3: scenario-ID preservation, authoritative quote/FX binding, and concurrent rights/deferral protection', async () => {
  const store = openSelectionStore(':memory:');

  // CRITICAL #1a: Two declared $40 scenarios with different headhaul ($2.00 vs $8.50) -> submitting ONLY the winning one MUST NOT pass!
  store.upsertCandidateForm({ form_id: 'f-c1-sameprice', label: 'Same-Price Dual Headhaul', buyer_task: 'Task', saleable_set_composition: { qty: 1 } });
  const g1aDual = runGate1AForForm(store, {
    form_id: 'f-c1-sameprice',
    scenarios: [
      makeGate1AScenario({ id: 'h-low', price_usd: 40.00, headhaul_usd: 2.00 }),
      makeGate1AScenario({ id: 'h-high', price_usd: 40.00, headhaul_usd: 8.50 }),
    ],
  });
  assert.equal(g1aDual.gate_status, 'gate1a_passed');
  assert.equal(g1aDual.declared_scenarios.length, 2);
  const qDual = store.recordSourcingQuote1688({
    form_id: 'f-c1-sameprice',
    observed_at: '2026-11-20',
    redacted_destination: '广东深圳',
    raw_readback_ref: 'readback:c1-dual',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{ offer_id: 'oc1', sku_id: 'sc1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 70, regular_goods_promo_false: true }],
    actual_sets: 100,
    actual_complete_sets: 100,
    goods_cny_total: 7000,
    domestic_freight_cny_total: 100,
  }).quote;

  const droppedLosing = await runGate1BForForm(store, {
    form_id: 'f-c1-sameprice',
    profile_revision: 59,
    existing_quote: qDual,
    early_screen_builder: () => [makeScreenScenario(40.00, { id: 'h-low', headhaul: { usd_per_unit: 2.00, bond_included: true } })],
  });
  assert.equal(droppedLosing.status, 'gate1b_pending');
  assert.equal(droppedLosing.proceed_to_gate2_3, false);

  // Submitting BOTH shows crossing 30% interval cleanly (pending, owner_review_required)
  const bothDual = await runGate1BForForm(store, {
    form_id: 'f-c1-sameprice',
    profile_revision: 59,
    existing_quote: qDual,
    early_screen_builder: () => [
      makeScreenScenario(40.00, { id: 'h-low', headhaul: { usd_per_unit: 2.00, bond_included: true } }),
      makeScreenScenario(40.00, { id: 'h-high', headhaul: { usd_per_unit: 8.50, bond_included: true } }),
    ],
  });
  assert.equal(bothDual.status, 'gate1b_pending');
  assert.equal(bothDual.margin_interval_verdict, 'crosses_30pct');

  // CRITICAL #1b: Owner override on crossing ($40 fail + $60 pass) MUST NOT let Stage 3 drop the losing $40 scenario!
  const dropS3Cand = structuredClone(fixture.candidates[0]);
  dropS3Cand.id = 'f-c1-override-drop';
  dropS3Cand.screening.reference_price_usd.value = 60.00;
  const dLed = dropS3Cand.economics.scenarios[0].cost_ledger;
  dLed.price_usd = 60.00;
  dLed.fx_cny_per_usd = 7.0;
  dLed.lines.find(l => l.id === 'headhaul').amount_usd = 2.2;
  dLed.lines.find(l => l.id === 'fulfillment').amount_usd = 6.3549;
  dLed.lines.find(l => l.id === 'placement').amount_usd = 0.34;
  dLed.lines.find(l => l.id === 'procurement').amount_usd = Number((100 / 7).toFixed(4));
  dLed.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((2 / 7).toFixed(4));
  dLed.lines.find(l => l.id === 'domestic_freight').status = 'confirmed';

  const overrideDropRun = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-20',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:c1-override',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oc1b', sku_id: 'sc1b', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 10000,
        domestic_freight_cny_total: 200,
      },
    }),
    deep_research_executor: async () => ({ batch: { ...structuredClone(fixture), candidates: [dropS3Cand] } }),
    items: [{
      leads: [{ lead_id: 'ld-c1b', source_channel: 'reddit', source_ref: 'https://example.com/c1b', phrase_or_title: 'override item', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-c1-override-drop', label: 'Override Drop', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [
        makeGate1AScenario({ id: 'p40', price_usd: 40.00 }),
        makeGate1AScenario({ id: 'p60', price_usd: 60.00 }),
      ],
      early_screen_builder: () => [
        makeScreenScenario(40.00, { id: 'p40' }),
        makeScreenScenario(60.00, { id: 'p60' }),
      ],
      allow_crossing_to_gate2_3: true,
    }],
  });
  assert.equal(overrideDropRun.gate2_3[0].status, 'gate2_3_error');
  assert.match(overrideDropRun.gate2_3[0].error, /omitted active Gate 1A declared scenario/);
  assert.equal(store.getEvaluationsForForm('f-c1-override-drop').length, 0);

  // CRITICAL #2a: Unpersisted caller-supplied existing_quote object (0 quotes in store) MUST NOT pass Gate 1B!
  store.upsertCandidateForm({ form_id: 'f-c2-unpersisted', label: 'Unpersisted Quote Form', buyer_task: 'Task', saleable_set_composition: { qty: 1 } });
  runGate1AForForm(store, { form_id: 'f-c2-unpersisted', scenarios: [makeGate1AScenario({ price_usd: 54.99 })] });
  const fakeUnpersistedQuote = {
    quote_id: 'fake-never-inserted',
    form_id: 'f-c2-unpersisted',
    spec_version: 1,
    quote_status: 'verified',
    goods_first_order_promotion: 0,
    freight_first_order_promotion: 0,
    goods_cny_total: 5000,
    domestic_freight_cny_total: 100,
    actual_sets: 100,
    sku_lines_json: '[]',
  };
  const unpersistedRes = await runGate1BForForm(store, {
    form_id: 'f-c2-unpersisted',
    existing_quote: fakeUnpersistedQuote,
    early_screen_builder: () => makeScreenScenario(54.99),
  });
  assert.equal(unpersistedRes.status, 'gate1b_pending');
  assert.match(unpersistedRes.reason, /not persisted/i);

  // CRITICAL #2b: Stage 3 FX manipulation (inflating FX to 9.62 to shrink CNY 80 into $8.317) MUST fail!
  const fxCheatCand = structuredClone(fixture.candidates[0]);
  fxCheatCand.id = 'f-c2-fx-cheat';
  fxCheatCand.screening.reference_price_usd.value = 54.99;
  const fxLed = fxCheatCand.economics.scenarios[0].cost_ledger;
  fxLed.price_usd = 54.99;
  fxLed.fx_cny_per_usd = 9.6188;
  fxLed.lines.find(l => l.id === 'headhaul').amount_usd = 2.2;
  fxLed.lines.find(l => l.id === 'procurement').amount_usd = 8.317;
  fxLed.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((1 / 9.6188).toFixed(4));
  fxLed.lines.find(l => l.id === 'domestic_freight').status = 'confirmed';
  const fxRun = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-20',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:c2-fx',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oc2', sku_id: 'sc2', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async () => ({ batch: { ...structuredClone(fixture), candidates: [fxCheatCand] } }),
    items: [{
      leads: [{ lead_id: 'ld-c2fx', source_channel: 'reddit', source_ref: 'https://example.com/c2fx', phrase_or_title: 'fx cheat', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-c2-fx-cheat', label: 'FX Cheat', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeGate1AScenario({ price_usd: 54.99, fx_cny_per_usd: 7.0 })],
      early_screen_builder: () => makeScreenScenario(54.99),
    }],
  });
  assert.equal(fxRun.gate2_3[0].status, 'gate2_3_error');
  assert.match(fxRun.gate2_3[0].error, /conflicts with Gate 1A accepted FX/);

  // CRITICAL #3a: Concurrent same-spec rights rejection during Stage 3 + callback throw MUST NOT overwrite rights rejection & blocks subsequent paid dispatches!
  let paidDispatchesAfterRights = 0;
  const c3Run = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async () => ({
      status: 'quoted',
      quote: {
        observed_at: '2026-11-20',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'readback:c3-rights',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        sku_lines: [{ offer_id: 'oc3', sku_id: 'sc3', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
        actual_sets: 100,
        actual_complete_sets: 100,
        goods_cny_total: 8000,
        domestic_freight_cny_total: 100,
      },
    }),
    deep_research_executor: async ({ form, request }) => {
      // Simulate concurrent rights conflict recorded on same spec while Stage 3 is running
      store.updateFormLifecycle(form.form_id, 'gate1b_rejected', {
        gate1b_result: { status: 'gate1b_rejected', spec_sha256: form.spec_sha256, specific_rights_conflict_proven: true },
        negotiation_shortlist: null,
      });
      // Attempting a paid dispatch MUST throw BEFORE calling executor!
      await request({
        account_scope: 'default-us',
        provider: 'sif',
        tool_name: 'ops_get_listing_traffic_overview',
        observation_cutoff_date: '2026-11-20',
        params: { asin: 'B9RIGHTS01', country: 'US', timePieceType: 'latelyDay', timePieceValue: '30', isListingSearch: true },
      }, async () => {
        paidDispatchesAfterRights++;
        return { payload: { ok: true }, sif_units: 3 };
      });
      return { batch: fixture };
    },
    items: [{
      leads: [{ lead_id: 'ld-c3r', source_channel: 'reddit', source_ref: 'https://example.com/c3r', phrase_or_title: 'concurrent rights', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-c3-rights', label: 'Concurrent Rights', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
      early_screen_builder: () => makeScreenScenario(54.99),
    }],
  });
  assert.equal(paidDispatchesAfterRights, 0);
  assert.equal(c3Run.gate2_3[0].status, 'blocked_rights_conflict');
  const fC3 = store.getCandidateForm('f-c3-rights');
  assert.equal(fC3.lifecycle_status, 'gate1b_rejected');
  assert.equal(JSON.parse(fC3.gate1b_result_json).specific_rights_conflict_proven, true);

  // CRITICAL #3b: Concurrent Gate 1A deferral during async 1688 sourcing MUST NOT proceed to Gate 2/3!
  let deepCalledOnDeferred = 0;
  const deferRun = await runPhase2Batch(store, {
    profile,
    sourcing_executor: async ({ form }) => {
      runGate1AForForm(store, {
        form_id: form.form_id,
        scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
        strong_date_dependency: true,
      });
      return {
        status: 'quoted',
        quote: {
          observed_at: '2026-11-20',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'readback:c3-defer',
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'oc3d', sku_id: 'sc3d', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
          actual_sets: 100,
          actual_complete_sets: 100,
          goods_cny_total: 8000,
          domestic_freight_cny_total: 100,
        },
      };
    },
    deep_research_executor: async () => { deepCalledOnDeferred++; return { batch: fixture }; },
    items: [{
      leads: [{ lead_id: 'ld-c3d', source_channel: 'reddit', source_ref: 'https://example.com/c3d', phrase_or_title: 'concurrent defer', observed_at: '2026-11-20', disposition: 'product' }],
      form: { form_id: 'f-c3-defer', label: 'Concurrent Defer', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
      gate1a_scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
      early_screen_builder: () => makeScreenScenario(54.99),
    }],
  });
  assert.equal(deferRun.gate1b[0].status, 'deferred');
  assert.equal(deferRun.gate1b[0].proceed_to_gate2_3, false);
  assert.equal(deepCalledOnDeferred, 0);

  store.close();
});

test('GPT Review Regressions H1-H10 & M1-M9 & L1-L2: fees, guards, judgments, 4-lane reopen, disclosures, contact-sheet & CLI privacy', async () => {
  await withTempDirAsync(async dir => {
    // HIGH #2 + LOW #1: Calculator override scope binding & solver upper-limit cent cap ($49.995 must never admit $50.00!)
    const std4999Receipt = {
      verified_by: 'amazon_fba_revenue_calculator',
      observed_at: '2026-11-20',
      evidence_ref: 'ev-small-std',
      verified_price_usd: 49.99,
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: { length_in: 8, width_in: 5, height_in: 1, weight_lb: 0.5 },
      fulfillment_usd: 3.50,
      placement_usd: 0.25,
      storage_per_unit_usd: 0.04,
      returns_processing_usd: 0,
    };
    const crossPkgAttempt = estimateGate1A2027({
      ...makeGate1AScenario({
        price_usd: 50.01,
        pkg: { length_in: 24, width_in: 18, height_in: 10, weight_lb: 22 },
        sales_window: { from: '2028-02-01', through: '2028-06-30' },
      }),
      calculator_verified_override: std4999Receipt,
    });
    assert.equal(crossPkgAttempt.status, 'needs_calculator_verification');

    const cappedSolve = solveMinPriceForMargin2027({
      ...makeGate1AScenario(),
      landed_domestic_usd: 22.0,
      fx_cny_per_usd: 7.0,
      margin_floor: 0.30,
      max_search_price_usd: 49.995,
    });
    if (cappedSolve.status === 'verified') {
      assert.ok(cappedSolve.feasible_min_price_usd <= 49.99);
    }

    // HIGH #3: Payable USD cent rounding ($54.35 less 8% -> $50.00, NOT $50.002!) + r59 Coupon $50 list-price FBA tier ('over_50') + Gate 1B $0.019 FBA drift rejected!
    const pctRound = resolveEffectivePricing({ list_price_usd: 54.35, ongoing_coupon_pct: 0.08 });
    assert.equal(pctRound.valid, true);
    assert.equal(pctRound.net_effective_price_usd, 50.00);
    const estAt50 = estimateGate1A2027(makeGate1AScenario({ list_price_usd: 54.35, ongoing_coupon_pct: 0.08, price_usd: undefined }));
    assert.equal(estAt50.price_band, 'over_50');

    const sTight = openSelectionStore(':memory:');
    sTight.upsertCandidateForm({ form_id: 'f-tight-fba', label: 'Tight FBA', buyer_task: 'Task', saleable_set_composition: { qty: 1 } });
    runGate1AForForm(sTight, { form_id: 'f-tight-fba', scenarios: [makeGate1AScenario({ price_usd: 54.99 })] });
    const qTight = sTight.recordSourcingQuote1688({
      form_id: 'f-tight-fba',
      observed_at: '2026-11-20',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:tight',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'ot1', sku_id: 'st1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 8000,
      domestic_freight_cny_total: 100,
    }).quote;
    const drift019 = await runGate1BForForm(sTight, {
      form_id: 'f-tight-fba',
      profile_revision: 59,
      existing_quote: qTight,
      early_screen_builder: () => makeScreenScenario(54.99, { fulfillment_usd: 6.3359 }), // $0.019 below $6.3549!
    });
    assert.equal(drift019.status, 'gate1b_pending');
    assert.match(drift019.reason, /FBA tier/);

    // HIGH #4: carrier_bond ONLY on negative recovery credit MUST NOT satisfy positive headhaul Bond check!
    const creditBondLedger = structuredClone(fixture.candidates[0].economics.scenarios[0].cost_ledger);
    creditBondLedger.lines.find(l => l.id === 'headhaul').components = ['headhaul'];
    creditBondLedger.lines.push({
      id: 'headhaul_bond_recovery',
      amount_usd: -0.50,
      status: 'confirmed',
      basis: 'Fake recovery credit carrying bond tag',
      evidence: ['synthetic-evidence'],
      components: ['carrier_bond'],
    });
    const creditBondCheck = validateFeeBasis(creditBondLedger, { profileRevision: 59 });
    assert.equal(creditBondCheck.status, 'needs_evidence');
    assert.ok(creditBondCheck.issues.some(i => i.code === 'missing_carrier_bond'));

    // HIGH #5: Default provider guards on executeGuardedRequest + strict SIF types + SKU word-boundary ("8" != "18-roll")!
    let leafCalled = 0;
    await assert.rejects(() => sTight.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sellersprite',
      tool_name: 'asin_list',
      observation_cutoff_date: '2026-11-20',
      params: { categoryId: '1055398:3744011', bsr: { min: 1, max: 100 } },
    }, async () => { leafCalled++; return { payload: { items: [] } }; }), /SellerSprite guard violation/);
    assert.equal(leafCalled, 0);
    assert.equal(sTight.getQuotaSummary().total_attempts, 0);

    assert.equal(validateProviderCall('sif', 'ops_get_listing_traffic_overview', {
      asin: 'B9GUARD001', country: 'US', timePieceType: 'latelyDay', timePieceValue: 30, isListingSearch: true,
    }).valid, false);
    assert.equal(validateProviderCall('sif', 'ops_get_asin_traffic_trend', {
      asin: 'B9GUARD001', listingSearch: true, lastDays: '30', granularity: 'day',
    }).valid, false);
    const sku18vs8 = verifyReviewVariantOwnership(
      [{ reviewId: 'R1', skus: ['18-roll dispenser'] }, { reviewId: 'R2', skus: ['8-roll dispenser'] }],
      { target_sku_tokens: ['8'] },
    );
    assert.equal(sku18vs8.verified_reviews.length, 1);
    assert.equal(sku18vs8.verified_reviews[0].reviewId, 'R2');

    // HIGH #6: Unrelated SocialBridge primary rejected + SpecMatcher mismatch / RubricJudge not_supported blocks Stage 3!
    sTight.upsertCandidateForm({ form_id: 'f-sb-align', label: 'Kitchen Drawer Organizer', buyer_task: 'Divide utensils neatly inside kitchen drawer', saleable_set_composition: { qty: 1 } });
    assert.throws(() => sTight.ingestSocialBridgeLead({
      schema_version: 1,
      contract: 'SocialBridgeExtractor',
      status: 'extracted',
      platform: 'reddit',
      source_url: 'https://example.org/r/bicycling/unrelated',
      observed_at: '2026-11-20',
      event_dedup_key: 'reddit:unrelated-bike',
      verbatim_excerpt: 'My mountain bicycle derailleur cable snapped during uphill climb.',
      buyer_task: 'Replace mountain bicycle derailleur shift cable',
      candidate_phrases: ['bicycle derailleur cable'],
    }, { form_id: 'f-sb-align', link_role: 'primary_discovery' }), /alignment failed/i);

    const judgeCand = structuredClone(fixture.candidates[0]);
    judgeCand.id = 'f-judge-block';
    judgeCand.screening.reference_price_usd.value = 54.99;
    const jLed = judgeCand.economics.scenarios[0].cost_ledger;
    jLed.price_usd = 54.99;
    jLed.fx_cny_per_usd = 7.0;
    jLed.lines.find(l => l.id === 'headhaul').amount_usd = 2.2;
    jLed.lines.find(l => l.id === 'procurement').amount_usd = Number((80 / 7).toFixed(4));
    jLed.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((1 / 7).toFixed(4));
    jLed.lines.find(l => l.id === 'domestic_freight').status = 'confirmed';
    const judgeRun = await runPhase2Batch(sTight, {
      profile,
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: {
          observed_at: '2026-11-20',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'readback:judge',
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'oj1', sku_id: 'sj1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 80, regular_goods_promo_false: true }],
          actual_sets: 100,
          actual_complete_sets: 100,
          goods_cny_total: 8000,
          domestic_freight_cny_total: 100,
        },
      }),
      deep_research_executor: async () => ({
        batch: { ...structuredClone(fixture), candidates: [judgeCand] },
        rubric_judgments: [{
          schema_version: 1,
          contract: 'PainPointAndRubricJudge',
          item_id: 'supported_opportunity',
          status: 'not_supported',
          evidence_refs: ['synthetic-evidence'],
          counter_evidence: ['Demand unproven in primary channel'],
        }],
      }),
      items: [{
        leads: [{ lead_id: 'ld-jb1', source_channel: 'reddit', source_ref: 'https://example.com/jb1', phrase_or_title: 'judge block', observed_at: '2026-11-20', disposition: 'product' }],
        form: { form_id: 'f-judge-block', label: 'Judge Block', buyer_task: 'Task', saleable_set_composition: { qty: 1 } },
        gate1a_scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
        early_screen_builder: () => makeScreenScenario(54.99),
      }],
    });
    assert.equal(judgeRun.gate2_3[0].status, 'blocked_contradictory_rubric_judgment');
    assert.equal(sTight.getEvaluationsForForm('f-judge-block').length, 0);

    // HIGH #7: Fixed non-overridable children's exclusion + operational Gate 1A price-band guardrail!
    assert.equal(evaluateGate0CategoryBoundary(
      { root_category: 'Home & Kitchen', title: 'Kids toddler step stool', is_children_product: true },
      { exclude_childrens_products: false },
    ).hard_exclusion, true);
    sTight.upsertCandidateForm({ form_id: 'f-child-g1a', label: 'Baby toddler play mat', buyer_task: 'Soft mat for toddlers', saleable_set_composition: { qty: 1 } });
    const g1aChild = runGate1AForForm(sTight, { form_id: 'f-child-g1a', scenarios: [makeGate1AScenario({ price_usd: 54.99 })] });
    assert.equal(g1aChild.gate_status, 'gate1a_rejected');
    assert.equal(g1aChild.gate0.hard_exclusion, true);

    sTight.upsertCandidateForm({ form_id: 'f-wide-g1a', label: 'Desk Shelf', buyer_task: 'Organize desk', saleable_set_composition: { qty: 1 } });
    const g1aWide = runGate1AForForm(sTight, {
      form_id: 'f-wide-g1a',
      profile_revision: 59,
      scenarios: [makeGate1AScenario({ price_usd: 54.99 })],
      price_band_analysis: [
        { asin: 'W1', price_usd: 25, units_30d: 300, fulfillment_channel: 'FBA', age_days: 400, keepa_price_steady: true },
        { asin: 'W2', price_usd: 75, units_30d: 300, fulfillment_channel: 'FBA', age_days: 400, keepa_price_steady: true },
      ],
    });
    assert.equal(g1aWide.gate_status, 'gate1a_passed');
    assert.equal(g1aWide.price_band_guardrail.width_alarm, true);
    assert.equal(g1aWide.price_band_guardrail.advisory_only, true);

    // HIGH #1 + HIGH #8 + Harness-to-Ledger: 4-lane reopen invariance, no_retry lock preservation, stale reimport protection, and trusted not_dispatched preflight!
    const db4Lane = join(dir, 'lanes.sqlite');
    const s1 = openSelectionStore(db4Lane);
    const webRes = s1.reserveRequestAttempt({
      account_scope: 'default-us',
      provider: 'sellersprite',
      tool_name: 'ss_web_realtime_task',
      observation_cutoff_date: '2026-11-20',
      params: { q: 'desk tray' },
    });
    s1.failAttemptUnknownOutcome(webRes.attempt_id, { note: 'CUA disconnected' });
    const qBeforeReopen = s1.getQuotaSummary();
    assert.equal(qBeforeReopen.by_lane.ss_web.unknown_attempts, 1);
    assert.equal(qBeforeReopen.by_lane.ss_web.unknown_reserved, 1);
    assert.equal(qBeforeReopen.by_lane.ss_mcp.unknown_attempts, 0);
    assert.equal(qBeforeReopen.by_lane.ss_mcp.unknown_reserved, 0);

    // Trusted pre-flight not_dispatched error settles to failed/repeat_allowed=1 with ZERO reserved quota!
    await assert.rejects(() => s1.executeGuardedRequest({
      account_scope: 'default-us',
      provider: 'sellersprite',
      tool_name: 'keyword_trend',
      observation_cutoff_date: '2026-11-20',
      params: { keyword: 'preflight test' },
    }, async () => {
      const err = new Error('Proactive upstream HTTP session refresh failed; request was not dispatched.');
      err.data = { category: 'session_refresh_failed', outcome: 'not_dispatched', not_dispatched: true, replayed: false };
      throw err;
    }), /not dispatched/);
    const qAfterPreflight = s1.getQuotaSummary();
    assert.equal(qAfterPreflight.by_lane.ss_mcp.unknown_attempts, 0);
    assert.equal(qAfterPreflight.by_lane.ss_mcp.unknown_reserved, 0);

    // Historical completed no_retry stays locked on billing reconciliation, and reimporting stale unknown cannot revert settlement!
    s1.recordHistoricalAttempt({
      attempt_id: 'hist-noretry-1',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-18',
      status: 'completed',
      billing_status: 'unknown_not_exposed',
      no_retry: true,
      params: { asin: 'B9HIST0001' },
    });
    const recNoRetry = s1.reconcileUnknownAttempt('hist-noretry-1', {
      resolved_status: 'completed',
      sif_units: 3,
      note: 'Settled billing while preserving no_retry',
    });
    assert.equal(recNoRetry.repeat_submission_allowed, 0);

    const staleReimport = s1.recordHistoricalAttempt({
      attempt_id: 'hist-noretry-1',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-18',
      status: 'unknown_needs_reconciliation',
      billing_status: 'unknown_not_exposed',
      params: { asin: 'B9HIST0001' },
    });
    assert.equal(staleReimport.preserved_settlement, true);
    assert.equal(s1.getAttempt('hist-noretry-1').status, 'completed');
    assert.equal(s1.getAttempt('hist-noretry-1').billing_status, 'known');
    s1.close();

    // Reopen SQLite file -> 4-lane reserves MUST NOT drift or add ss_mcp reserve to ss_web!
    const s2 = openSelectionStore(db4Lane);
    const qAfterReopen = s2.getQuotaSummary();
    assert.equal(qAfterReopen.by_lane.ss_web.unknown_reserved, 1);
    assert.equal(qAfterReopen.by_lane.ss_mcp.unknown_reserved, 0);
    s2.close();

    // MEDIUM #2, #3, #4: Peer permutation invariance, Shenzhen origin-only rejection, and Pet Supplies/Pet Products alias consistency!
    const dupPeers = [
      { asin: 'D1', price_usd: 30, units_30d: 100, fulfillment_channel: 'FBA', age_days: 300 },
      { asin: 'D1', price_usd: 65, units_30d: 400, fulfillment_channel: 'FBA', age_days: 300 },
      { asin: 'D2', price_usd: 32, units_30d: 150, fulfillment_channel: 'FBA', age_days: 300 },
    ];
    const pbFwd = analyzeMainstreamPriceBand(dupPeers);
    const pbRev = analyzeMainstreamPriceBand([...dupPeers].reverse());
    assert.equal(pbFwd.band.width_ratio, pbRev.band.width_ratio);
    assert.equal(pbFwd.band.p25_usd, pbRev.band.p25_usd);

    assert.equal(isShenzhenDestination('From: Guangdong Shenzhen'), false);
    assert.equal(isShenzhenDestination('上海 发货地：深圳'), false);
    assert.equal(isShenzhenDestination('广东深圳'), true);

    const aliasLedger = structuredClone(fixture.candidates[0].economics.scenarios[0].cost_ledger);
    aliasLedger.fee_category = 'Pet Supplies';
    aliasLedger.lines.push({
      id: 'returns_processing',
      amount_usd: 0,
      status: 'confirmed',
      basis: 'Below Pet Products threshold',
      evidence: ['synthetic-evidence'],
      fee_category: 'Pet Products',
      physical_return_fraction: 0.05,
    });
    const aliasCheck = validateFeeBasis(aliasLedger, { profileRevision: 59 });
    assert.equal(aliasCheck.issues.some(i => i.code === 'conflicting_fee_category'), false);

    // HIGH #10 & MEDIUM #6: No private numeric freight surcharges, AMZ seller.type=AMZ detection, stored order_plan & unknown bundle compliance!
    const opsCand = structuredClone(fixture.candidates[0]);
    opsCand.operations = {
      order_plan: { allocated_sets: 100, actual_complete_sets: 102, total_remainder_pieces: 3 },
      quote: { lead_time_days: 12, actual_sets: 100, goods_cny_total: 8000, domestic_freight_cny_total: 100 },
      offers: [{ asin: 'SYNTH00006', seller: { type: 'AMZ' } }],
      shipment: { actual_weight_kg: 12, outer_carton_weight_kg: 6.5, carton_count: 2 },
      packaging: { is_multi_sku_bundle: true },
    };
    const scoredOps = scoreCandidate(opsCand, profile);
    const discList = scoredOps.diagnostics.operational_disclosures;
    const byId = Object.fromEntries(discList.map(d => [d.id, d]));
    assert.equal(byId.amazon_1p_presence.status, 'alert');
    assert.equal(byId.batch_cash_and_moq.actual_complete_sets, 102);
    assert.equal(byId.batch_cash_and_moq.remainder_units, 3);
    assert.equal(byId.batch_cash_and_moq.lead_time_days, 12);
    assert.doesNotMatch(byId.freight_a4_rules.note, /¥\d/);
    assert.equal(byId.packaging_and_2027_bundle_check.status, 'needs_check');
    assert.match(byId.packaging_and_2027_bundle_check.note, /尚缺两项显式确认/);

    // MEDIUM #5 & #7: Replay preserves ALL provenance events for a lead, partial lead update preserves custom route,
    // funnel_by_route counts primary origins only, single_leaf_concentration alert, and idempotent review_notes!
    const sProv = openSelectionStore(':memory:');
    const synthDiscovery = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic-discovery.json'), 'utf8'));
    replayBatchIntoStore(sProv, {
      batch: structuredClone(fixture),
      profile,
      discovery: synthDiscovery,
    });
    // synthetic-discovery.json merges 2 provenance rows for 'synthetic rack' (plus 2 more keywords -> 4 total linked leads!)
    const provLeads = sProv.getLeadsForForm('synthetic-rack-form');
    assert.ok(provLeads.length >= 4, `Expected all provenance events preserved (>=4 leads), got ${provLeads.length}`);
    assert.equal(provLeads.filter(l => l.normalized_key === 'synthetic rack').length, 2);
    assert.equal(provLeads.filter(l => l.link_role === 'primary_discovery').length, 1);
    assert.ok(provLeads.filter(l => l.link_role === 'corroboration').length >= 3);

    // Idempotent review_notes on identical evaluation replay (never duplicates!)
    const ev0 = sProv.getEvaluationsForForm('synthetic-rack-form')[0];
    sProv.appendEvaluationReviewNotes(ev0.evaluation_id, [{ kind: 'CALIBRATION_NOTE', reviewer: 'qa', observed_at: '2026-11-20', note: 'Idempotent check' }]);
    sProv.appendEvaluationReviewNotes(ev0.evaluation_id, [{ kind: 'CALIBRATION_NOTE', reviewer: 'qa', observed_at: '2026-11-20', note: 'Idempotent check' }]);
    assert.equal(JSON.parse(sProv.getEvaluationsForForm('synthetic-rack-form')[0].review_notes_json).length, 1);
    sProv.upsertRawLead({
      lead_id: 'ld-custom-rt',
      source_channel: 'ss_category_steady',
      route: 'demand_signals_trends',
      source_ref: 'ss:custom:1',
      phrase_or_title: 'custom route lead',
      observed_at: '2026-11-20',
      disposition: 'unreviewed',
      metadata: { leaf_node_id: 'leaf-A' },
    });
    sProv.upsertRawLead({
      lead_id: 'ld-custom-rt',
      source_channel: 'ss_category_steady',
      source_ref: 'ss:custom:1',
      phrase_or_title: 'custom route lead',
      observed_at: '2026-11-20',
      disposition: 'product',
      metadata: { leaf_node_id: 'leaf-A' },
    });
    assert.equal(sProv.db.prepare("SELECT route FROM raw_leads WHERE lead_id = 'ld-custom-rt'").get().route, 'demand_signals_trends');
    for (let k = 2; k <= 4; k++) {
      sProv.upsertRawLead({
        lead_id: `ld-leaf-${k}`,
        source_channel: k === 2 ? 'reddit' : (k === 3 ? 'etsy' : '1688_factory_cold_start'),
        source_ref: `https://example.org/leaf/${k}`,
        phrase_or_title: `leaf item ${k}`,
        observed_at: '2026-11-20',
        disposition: 'product',
        metadata: { leaf_node_id: 'leaf-A' },
      });
    }
    const leafAudit = auditDiscoveryCoverage(sProv, { profile_revision: 59 });
    assert.equal(leafAudit.anti_convergence_alerts.some(a => a.code === 'single_leaf_concentration'), false);
    sProv.close();

    // MEDIUM #8 & #9: Contact sheet renders price-band rows cleanly AND blocks loopback HTTP URLs!
    const csIn = join(dir, 'cs-stage1.json');
    const csOut = join(dir, 'cs-stage1.png');
    const csMan = join(dir, 'cs-stage1-manifest.json');
    const pbStage1 = analyzeMainstreamPriceBand([
      { asin: 'SYNTH00007', price_usd: 54.99, ongoing_coupon_usd: 5.00, units_30d: 180, fulfillment_channel: 'FBA', age_days: 300, fba_fee_usd: 5.76 },
    ]);
    const csRow = { ...pbStage1.mainstream_pool[0], promo_text: '$5 coupon', image_url: 'http://127.0.0.1:1/forbidden.png' };
    writeFileSync(csIn, JSON.stringify({ title: 'Stage1 Format Check', items: [csRow] }), 'utf8');
    const pyBin = process.platform === 'win32' ? 'python' : 'python3';
    const pyRes = spawnSync(pyBin, [join(REPO_ROOT, 'scripts', 'render_contact_sheet.py'), '--input', csIn, '--output', csOut, '--manifest-out', csMan], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    assert.equal(pyRes.status, 0, pyRes.stderr);
    const man = JSON.parse(readFileSync(csMan, 'utf8'));
    assert.equal(man.rows[0].list_price_usd, 54.99);
    assert.equal(man.rows[0].net_price_usd, 49.99);
    assert.equal(man.rows[0].monthly_units, 180);
    assert.equal(man.rows[0].promo_text, '$5 coupon');
    assert.equal(man.rows[0].image_status, 'http_blocked');

    // HIGH #1 CLI + HIGH #9 CLI + CLI Privacy:
    const cliDb = join(dir, 'cli-priv.sqlite');
    const runCli = args => spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(runCli(['init', '--db', cliDb]).status, 0);

    // Malformed private input MUST NOT echo raw text to stderr!
    const secretFile = join(dir, 'private-notes.md');
    writeFileSync(secretFile, '# TOP_SECRET_SUPPLIER_QUOTE_XYZ_9999\nNot valid JSON!', 'utf8');
    const badJsonRes = runCli(['price-band', '--input', secretFile]);
    assert.equal(badJsonRes.status, 2);
    assert.doesNotMatch(badJsonRes.stderr, /TOP_SECRET_SUPPLIER_QUOTE_XYZ_9999/);

    // Reconcile --status failed omitting charge flags & --confirmed-zero-charge MUST FAIL!
    const sCli = openSelectionStore(cliDb);
    const uCli = sCli.reserveRequestAttempt({ account_scope: 'default-us', provider: 'exa', tool_name: 'web_search_exa', observation_cutoff_date: '2026-11-20', params: { q: 'test' } });
    sCli.failAttemptUnknownOutcome(uCli.attempt_id, { note: 'timeout' });
    sCli.close();
    const unsafeRec = runCli(['reconcile', '--db', cliDb, '--attempt', uCli.attempt_id, '--status', 'failed', '--note', 'Forgot charge flag']);
    assert.equal(unsafeRec.status, 2);
    const safeRec = runCli(['reconcile', '--db', cliDb, '--attempt', uCli.attempt_id, '--status', 'failed', '--confirmed-zero-charge', '--note', 'Verified 0 charge']);
    assert.equal(safeRec.status, 0, safeRec.stderr);

    // Output collision with input file MUST BE BLOCKED!
    const collDir = join(dir, 'coll');
    writeFileSync(join(dir, 'batch-in.json'), readFileSync(FIXTURE_PATH));
    const collBatch = join(collDir, 'result.json');
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(collDir)}, { recursive: true }); require('fs').copyFileSync(${JSON.stringify(FIXTURE_PATH)}, ${JSON.stringify(collBatch)});`]);
    const collRes = runCli(['export-report', '--db', cliDb, '--batch', collBatch, '--profile', PROFILE_PATH, '--output', collDir]);
    assert.equal(collRes.status, 2);
    assert.match(collRes.stderr, /覆盖/);

    // MEDIUM #1: Seasonal cliff stress propagates BOTH $49.99 & $50.00 independently per operating period!
    const seasonalCand = structuredClone(fixture.candidates[0]);
    const baseSc = structuredClone(seasonalCand.economics.scenarios[0]);
    const peakSc = structuredClone(seasonalCand.economics.scenarios[0]);
    peakSc.cost_ledger.lines.find(l => l.id === 'storage').amount_usd = 1.25;
    seasonalCand.economics = {
      saleable_unit: seasonalCand.economics.saleable_unit,
      operating_periods: [
        { id: 'off_peak', sales_window: 'off_peak', scenarios: [baseSc] },
        { id: 'peak', sales_window: 'peak', scenarios: [peakSc] },
      ],
    };
    const fakeG1aSeasonal = {
      scenarios: [
        {
          id: 'off',
          sales_window: 'off_peak',
          price_cliff_50: {
            status: 'verified',
            cliff_jump_usd: 0.59,
            points: [
              { price_usd: 49.99, status: 'verified', price_band: 'from_10_to_50', fulfillment_usd: 5.76, referral_usd: 7.50, collection_usd: 0.22 },
              { price_usd: 50.00, status: 'verified', price_band: 'from_10_to_50', fulfillment_usd: 5.76, referral_usd: 7.50, collection_usd: 0.22 },
            ],
          },
        },
        {
          id: 'pk',
          sales_window: 'peak',
          price_cliff_50: {
            status: 'verified',
            cliff_jump_usd: 0.65,
            points: [
              { price_usd: 49.99, status: 'verified', price_band: 'from_10_to_50', fulfillment_usd: 6.10, referral_usd: 7.50, collection_usd: 0.22 },
              { price_usd: 50.00, status: 'verified', price_band: 'from_10_to_50', fulfillment_usd: 6.10, referral_usd: 7.50, collection_usd: 0.22 },
            ],
          },
        },
      ],
    };
    attachGate1APriceCliffStress(seasonalCand, fakeG1aSeasonal);
    assert.equal(seasonalCand.economics.stress_scenarios.length, 4);
    const pkStress = seasonalCand.economics.stress_scenarios.find(s => s.id === 'gate1a-price-cliff-peak-49-99');
    assert.equal(pkStress.cost_ledger.lines.find(l => l.id === 'storage').amount_usd, 1.25);
    assert.equal(pkStress.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd, 6.10);

    sTight.close();
  });
});

// ============================================================================
// Post-Remediation Audit Regressions (B1-B18)
// ============================================================================
test('Post-Remediation Audit Regressions (B1-B18): Gate-0 red-ocean, low-peer guardrail, seasonal & FBA Stage-3 binding, cross-script link_note, partial-override solver, Shenzhen/SKU/coverage/HTML/CLI & concurrent SQLite hardening', async () => {
  const pkg = { length_in: 10, width_in: 6, height_in: 3, weight_lb: 1.5 };
  const baseG1A = {
    profile_revision: 59,
    pkg,
    price_usd: 54.99,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
    headhaul_usd: 4.0,
    collection_rate: 0.008,
    sales_window: { from: '2027-02-01', through: '2027-09-30' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-09-30' },
  };
  const est40 = estimateGate1A2027({ ...baseG1A, price_usd: 40 });
  const est55 = estimateGate1A2027({ ...baseG1A, price_usd: 54.99 });
  const est60 = estimateGate1A2027({ ...baseG1A, price_usd: 60 });
  const mkEs = (id, p, est) => ({
    id,
    saleable_unit: '1 unit',
    price_usd: p,
    fx_cny_per_usd: 7.0,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    return_threshold: 0.081,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    referral_terms: baseG1A.referral_terms,
    fulfillment_usd: est.components.fulfillment.total_usd,
    placement_usd: est.components.placement.selected_usd,
    storage: { cubic_feet_per_unit: est.components.storage.cubic_feet, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    headhaul: { usd_per_unit: 4.0, bond_included: true },
    other_applicable_usd: 0,
    collection_rate: 0.008,
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-1', sales: baseG1A.sales_window, storage: baseG1A.storage_window, inbound: baseG1A.inbound_window },
    specific_rights_conflict: false,
    strong_date_dependency: false,
  });
  const mkQuote = () => ({
    status: 'quoted',
    quote: {
      observed_at: '2026-11-20',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'readback:audit-ok',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{ offer_id: 'oa1', sku_id: 'sa1', qty_per_saleable_set: 1, pack_multiple: 10, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
      actual_sets: 100,
      actual_complete_sets: 100,
      goods_cny_total: 10000,
      domestic_freight_cny_total: 200,
    },
  });

  // B1: Under r59 (4 hard kill lines only), non-children Apparel is soft-avoid advisory (not hard-killed), while <=12y children's items are hard-rejected!
  {
    const s = openSelectionStore(':memory:');
    s.upsertCandidateForm({ form_id: 'f-b1-apparel', label: 'Cotton T-Shirt Hoodie', buyer_task: 'Everyday clothing', saleable_set_composition: { qty: 1 } });
    const softAvoid = runGate1AForForm(s, {
      form_id: 'f-b1-apparel',
      profile_revision: 59,
      scenarios: [{ id: 'p55', ...baseG1A }],
      category_check: { title: 'Cotton T-Shirt Hoodie', root_category: 'Clothing, Shoes & Jewelry' },
    });
    assert.equal(softAvoid.gate_status, 'gate1a_passed');
    assert.equal(softAvoid.proceed_to_gate1b, true);
    assert.equal(softAvoid.gate0.hard_exclusion, false);
    s.close();
  }

  // B2: Under r59, low_peer_count is advisory non-blocking when an explicit regular scenario >= $29.99 is supplied
  {
    const s = openSelectionStore(':memory:');
    s.upsertCandidateForm({ form_id: 'f-b2-lowpeer', label: 'Garden Bracket', buyer_task: 'Mount hose bracket', saleable_set_composition: { qty: 1 } });
    const pb = analyzeMainstreamPriceBand([
      { asin: 'SYNTH00008', price_usd: 45, fulfillment: 'FBM', monthly_units: 50 },
      { asin: 'SYNTH00009', price_usd: 48, fulfillment: 'FBA', monthly_units: 3 },
    ], { profile_revision: 59 });
    assert.equal(pb.mainstream_count, 0);
    const nonBlocking = runGate1AForForm(s, {
      form_id: 'f-b2-lowpeer',
      profile_revision: 59,
      scenarios: [{ id: 'p55', ...baseG1A }],
      price_band_analysis: pb,
    });
    assert.equal(nonBlocking.price_band_guardrail.low_peer_blocks_gate1a, false);
    s.close();
  }

  // B3: Seasonal candidate dropping losing p40 from off_peak (hiding p40 only in peak) MUST be blocked at Stage 3!
  {
    const s = openSelectionStore(':memory:');
    const baseCand = structuredClone(fixture.candidates[0]);
    baseCand.id = 'f-b3-seasonal';
    const sc60 = structuredClone(baseCand.economics.scenarios[0]);
    sc60.id = 'p60';
    sc60.cost_ledger.id = 'p60';
    sc60.cost_ledger.price_usd = 60;
    sc60.cost_ledger.fx_cny_per_usd = 7.0;
    sc60.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = Number((100 / 7).toFixed(4));
    sc60.cost_ledger.lines.find(l => l.id === 'procurement').order_units = 100;
    sc60.cost_ledger.lines.find(l => l.id === 'procurement').fx_cny_per_usd = 7.0;
    sc60.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((2 / 7).toFixed(4));
    sc60.cost_ledger.lines.find(l => l.id === 'domestic_freight').order_units = 100;
    sc60.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = 4.0;
    sc60.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = est60.components.fulfillment.total_usd;
    sc60.cost_ledger.lines.find(l => l.id === 'placement').amount_usd = est60.components.placement.selected_usd;
    const sc40Peak = structuredClone(sc60);
    sc40Peak.id = 'p40';
    sc40Peak.cost_ledger.id = 'p40';
    sc40Peak.cost_ledger.price_usd = 40;
    sc40Peak.cost_ledger.lines.find(l => l.id === 'fulfillment').status = 'pending';
    sc40Peak.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = null;
    baseCand.screening.reference_price_usd.value = 60;
    baseCand.economics = {
      saleable_unit: baseCand.economics.saleable_unit,
      operating_periods: [
        { id: 'off_peak', label: 'Off-Peak', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [sc60] },
        { id: 'peak', label: 'Peak', months: [10, 11, 12], scenarios: [sc40Peak] },
      ],
    };
    const out = await runPhase2Batch(s, {
      profile,
      items: [{
        form: { form_id: 'f-b3-seasonal', label: 'Garden Bracket', buyer_task: 'Mount hose bracket', saleable_set_composition: { qty: 1 } },
        leads: [{ lead_id: 'l-b3', source_channel: 'reddit', source_ref: 'https://example.com/r/b3', phrase_or_title: 'garden hose bracket', observed_at: '2026-11-20', disposition: 'product' }],
        gate1a_scenarios: [{ id: 'p40', ...baseG1A, price_usd: 40 }, { id: 'p60', ...baseG1A, price_usd: 60 }],
        allow_crossing_to_gate2_3: true,
        sourcing_executor: async () => mkQuote(),
        early_screen_builder: () => [mkEs('p40', 40, est40), mkEs('p60', 60, est60)],
        deep_research_executor: async () => ({ batch: { schema_version: 1, profile_revision: 59, candidates: [baseCand] } }),
      }],
    });
    assert.equal(out.gate2_3[0].status, 'gate2_3_error');
    assert.match(out.gate2_3[0].error, /period "off_peak" omitted active Gate 1A declared scenario/);
    assert.equal(s.getEvaluationsForForm('f-b3-seasonal').length, 0);
    s.close();
  }

  // B4 + B13 + B14: Cross-script SocialBridge link_note succeeds through Stage 3; forged $1 FBA fee is blocked; Stage-3 error preserves gate1b_passed & funnel!
  {
    const s = openSelectionStore(':memory:');
    const validCand = structuredClone(fixture.candidates[0]);
    validCand.id = 'f-b4-xscript';
    const vsc = validCand.economics.scenarios[0];
    vsc.id = 'p55';
    vsc.cost_ledger.id = 'p55';
    vsc.cost_ledger.price_usd = 54.99;
    vsc.cost_ledger.fx_cny_per_usd = 7.0;
    vsc.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = Number((100 / 7).toFixed(4));
    vsc.cost_ledger.lines.find(l => l.id === 'procurement').order_units = 100;
    vsc.cost_ledger.lines.find(l => l.id === 'procurement').fx_cny_per_usd = 7.0;
    vsc.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((2 / 7).toFixed(4));
    vsc.cost_ledger.lines.find(l => l.id === 'domestic_freight').order_units = 100;
    vsc.cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd = 4.0;
    vsc.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = est55.components.fulfillment.total_usd;
    vsc.cost_ledger.lines.find(l => l.id === 'placement').amount_usd = est55.components.placement.selected_usd;
    validCand.screening.reference_price_usd.value = 54.99;
    validCand.screening.reference_price_usd.supported_price_range = [54.99, 54.99];

    const forgedFbaCand = structuredClone(validCand);
    forgedFbaCand.id = 'f-b13-fba';
    forgedFbaCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = 1.00;

    const out = await runPhase2Batch(s, {
      profile,
      items: [
        {
          form: { form_id: 'f-b4-xscript', label: '重型黄铜双通园艺分水器', buyer_task: '户外园艺水管分流接驳', saleable_set_composition: { qty: 1 } },
          leads: [{
            lead_id: 'l-b4',
            link_role: 'primary_discovery',
            link_note: '英文园艺黄铜双通分水器对应本形态',
            social_bridge: {
              schema_version: 1,
              contract: 'SocialBridgeExtractor',
              status: 'extracted',
              platform: 'reddit',
              source_url: 'https://example.com/r/gardening/b4',
              observed_at: '2026-11-20',
              event_dedup_key: 'reddit:b4:1',
              buyer_task: 'split outdoor garden faucet into two heavy brass valves',
              candidate_phrases: ['heavy duty brass garden hose splitter'],
              verbatim_excerpt: 'Need a brass hose splitter that never leaks',
              evidence_refs: ['ev1'],
            },
          }],
          gate1a_scenarios: [{ id: 'p55', ...baseG1A }],
          sourcing_executor: async () => mkQuote(),
          early_screen_builder: () => mkEs('p55', 54.99, est55),
          deep_research_executor: async () => ({ batch: { schema_version: 1, profile_revision: 59, candidates: [validCand] } }),
        },
        {
          form: { form_id: 'f-b13-fba', label: 'Garden Bracket Forged FBA', buyer_task: 'Mount hose bracket', saleable_set_composition: { qty: 1 } },
          leads: [{ lead_id: 'l-b13', source_channel: 'pinterest', source_ref: 'https://example.com/pin/b13', phrase_or_title: 'garden hose bracket', observed_at: '2026-11-20', disposition: 'product' }],
          gate1a_scenarios: [{ id: 'p55', ...baseG1A }],
          sourcing_executor: async () => mkQuote(),
          early_screen_builder: () => mkEs('p55', 54.99, est55),
          deep_research_executor: async () => ({ batch: { schema_version: 1, profile_revision: 59, candidates: [forgedFbaCand] } }),
        },
      ],
    });
    assert.equal(out.gate2_3.find(x => x.form_id === 'f-b4-xscript').status, 'evaluated');
    const b13Res = out.gate2_3.find(x => x.form_id === 'f-b13-fba');
    assert.equal(b13Res.status, 'gate2_3_error');
    assert.match(b13Res.error, /conflicts with Gate 1A verified 2027 FBA tier/);
    // B14: Stage 3 failure preserved Gate 1B pass metadata & funnel count!
    const b13Form = s.getCandidateForm('f-b13-fba');
    const b13G1b = JSON.parse(b13Form.gate1b_result_json);
    assert.equal(b13G1b.status, 'gate1b_passed');
    assert.ok(b13G1b.quote_id);
    assert.equal(b13G1b.stage3_status, 'gate2_3_error');
    assert.equal(s.getSummary().funnel_by_route.social_cross_platform.gate1b_passed_or_beyond, 2);
    s.close();
  }

  // B5 & B6: Partial calculator override in solveMinPriceForMargin2027 + pkg-level DG/cm matching
  {
    const ov10To50 = {
      verified_by: 'owner',
      evidence_ref: 'ev-calc-b5',
      observed_at: '2026-11-20',
      verified_price_band: '10_to_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: { length_in: 22, width_in: 14, height_in: 8, weight_lb: 6 },
      fulfillment_usd: 11.50,
      storage_per_unit_usd: 1.10,
      placement_usd: 1.20,
      returns_processing_usd: 0,
    };
    const sol = solveMinPriceForMargin2027({
      ...baseG1A,
      pkg: { length_in: 22, width_in: 14, height_in: 8, weight_lb: 6 },
      landed_domestic_cny: 160,
      calculator_verified_override: { band_overrides: { '10_to_50': ov10To50 } },
    });
    assert.equal(sol.status, 'needs_calculator_verification');

    const dgPkg = { length_in: 10, width_in: 6, height_in: 3, weight_lb: 1.5, is_dangerous_goods: true };
    const nonDgOv = {
      verified_by: 'owner',
      evidence_ref: 'ev-calc-b6',
      observed_at: '2026-11-20',
      verified_price_band: 'over_50',
      effective_from: '2027-01-15',
      effective_through: '2027-10-14',
      pkg: { length_cm: 25.4, width_cm: 15.24, height_cm: 7.62, weight_kg: 1.5 * 0.45359237 },
      is_dangerous_goods: false,
      fulfillment_usd: 6.35,
      storage_per_unit_usd: 0.20,
      placement_usd: 0.50,
      returns_processing_usd: 0,
    };
    assert.equal(estimateGate1A2027({ ...baseG1A, pkg: dgPkg, calculator_verified_override: nonDgOv }).status, 'needs_calculator_verification');
    // Metric cm/kg override matching inch/lb scenario pkg with matching is_dangerous_goods: true succeeds!
    assert.equal(estimateGate1A2027({ ...baseG1A, pkg: dgPkg, calculator_verified_override: { ...nonDgOv, is_dangerous_goods: true } }).status, 'verified');
  }

  // B7: resolveEffectivePricing blocks half-cent drift across $50 cliff ($54.35 - 8% = $50.002 -> $50.00, rejects 50.005)
  {
    const bad = resolveEffectivePricing({ list_price_usd: 54.35, ongoing_coupon_pct: 0.08, net_effective_price_usd: 50.005 });
    assert.equal(bad.valid, false);
    const ok = resolveEffectivePricing({ list_price_usd: 54.35, ongoing_coupon_pct: 0.08, net_effective_price_usd: 50.00 });
    assert.equal(ok.valid, true);
    assert.equal(ok.net_effective_price_usd, 50.00);
  }

  // B8: Shenzhen destination parser handles multi-segment province+city AND origin-first formats
  assert.equal(isShenzhenDestination('收货地：广东省，深圳市'), true);
  assert.equal(isShenzhenDestination('To: Guangdong, Shenzhen'), true);
  assert.equal(isShenzhenDestination('广东深圳发货，收货上海'), false);
  assert.equal(isShenzhenDestination('从深圳发上海'), false);
  assert.equal(isShenzhenDestination('从上海发深圳'), true);

  // B9: verifyReviewVariantOwnership never lets parent-echoed rev.asin override contradicting skus[]!
  {
    const res = verifyReviewVariantOwnership(
      [
        { reviewId: 'R1', asin: 'SYNTH00010', skus: ['18-roll'] },
        { reviewId: 'R2', asin: 'SYNTH00010', skus: ['8-roll'] },
      ],
      { target_asin: 'SYNTH00010', target_sku_tokens: ['8-roll'] },
    );
    assert.equal(res.verified_reviews.length, 1);
    assert.equal(res.verified_reviews[0].reviewId, 'R2');
    assert.equal(res.excluded_other_variant.length, 1);
  }

  // B10: auditDiscoveryCoverage detects cross-channel single-leaf concentration via candidate_forms.leaf_node_path!
  {
    const s = openSelectionStore(':memory:');
    for (let i = 1; i <= 4; i++) {
      s.upsertRawLead({ lead_id: `lb10-${i}`, source_channel: i <= 2 ? 'reddit' : 'pinterest', source_ref: `https://example.com/b10/${i}`, phrase_or_title: `item ${i}`, observed_at: '2026-11-20', disposition: 'product' });
      s.upsertCandidateForm({ form_id: `fb10-${i}`, label: `Form ${i}`, buyer_task: `Task ${i}`, saleable_set_composition: { qty: 1 }, leaf_node_path: '100:200:300' });
      s.linkLeadToForm({ lead_id: `lb10-${i}`, form_id: `fb10-${i}`, link_role: 'primary_discovery' });
    }
    const cov = auditDiscoveryCoverage(s, { profile_revision: 59 });
    assert.equal(cov.leaf_categories['100:200:300'], 4);
    assert.equal(cov.anti_convergence_alerts.some(a => a.code === 'single_leaf_concentration'), false);
    s.close();
  }

  // B11: HTML report renders SQLite store_leads raw_excerpt!
  {
    const b = structuredClone(fixture);
    b.candidates = [b.candidates[0]];
    b.candidates[0].discovery = {
      form_id: b.candidates[0].id,
      label: 'L',
      description: 'D',
      offer_evidence: [],
      lead_keywords: [],
      leads: [],
      store_leads: [{
        lead_id: 'sl-b11',
        phrase_or_title: 'brass valve',
        source_channel: 'reddit',
        channel_id: 'reddit',
        route: 'social_cross_platform',
        entry_group: 'social',
        opportunity_type: 'supply_gap',
        link_role: 'primary_discovery',
        source_ref: 'https://example.com/r/b11',
        raw_excerpt: 'VERBATIM_SQLITE_EXCERPT_B11',
        observed_at: '2026-11-20',
        disposition: 'product',
      }],
    };
    const html = renderReport(scoreBatch(b, profile), b);
    assert.ok(html.includes('VERBATIM_SQLITE_EXCERPT_B11'));
  }

  // B12: attachGate1APriceCliffStress never leaks off-peak cliff onto pending peak & updates fee_basis.price_band
  {
    const cand = structuredClone(fixture.candidates[0]);
    const scOff = structuredClone(cand.economics.scenarios[0]);
    scOff.cost_ledger.price_usd = 50.99;
    scOff.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.price_band = 'over_50';
    const scPeak = structuredClone(scOff);
    scPeak.cost_ledger.lines.find(l => l.id === 'fulfillment').status = 'pending';
    scPeak.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = null;
    cand.economics = {
      saleable_unit: '1 unit',
      operating_periods: [
        { id: 'off_peak', label: 'Off-Peak', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [scOff] },
        { id: 'peak', label: 'Peak', months: [10, 11, 12], scenarios: [scPeak] },
      ],
    };
    const fakeOffCliff = {
      status: 'verified',
      cliff_jump_usd: 0.59,
      points: [
        { price_usd: 49.99, status: 'verified', price_band: '10_to_50', fulfillment_usd: 5.76495, referral_usd: 7.50, collection_usd: 0.22 },
        { price_usd: 50.00, status: 'verified', price_band: '10_to_50', fulfillment_usd: 5.76495, referral_usd: 7.50, collection_usd: 0.22 },
      ],
    };
    attachGate1APriceCliffStress(cand, {
      scenarios: [{ id: 'p51', sales_window: baseG1A.sales_window, operating_period_id: 'off_peak', price_cliff_50: fakeOffCliff }],
    });
    assert.equal(cand.economics.stress_scenarios.some(s => s.operating_period_id === 'peak'), false);
    const off49 = cand.economics.stress_scenarios.find(s => s.id === 'gate1a-price-cliff-off_peak-49-99');
    assert.equal(off49.cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis.price_band, '10_to_50');
  }

  // B15: Re-importing completed unknown_not_exposed historical row never reverts reconciled billing_status='known'!
  {
    const s = openSelectionStore(':memory:');
    s.recordHistoricalAttempt({
      attempt_id: 'hist-b15',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-16',
      status: 'completed',
      billing_status: 'unknown_not_exposed',
      unknown_reserved_sif_units: 3,
      params: { asin: 'SYNTH00011' },
    });
    s.reconcileUnknownAttempt('hist-b15', { resolved_status: 'completed', note: 'Verified 3 pts', sif_units: 3 });
    s.recordHistoricalAttempt({
      attempt_id: 'hist-b15',
      provider: 'sif',
      tool_name: 'ops_get_listing_traffic_overview',
      observation_cutoff_date: '2026-11-16',
      status: 'completed',
      billing_status: 'unknown_not_exposed',
      unknown_reserved_sif_units: 3,
      params: { asin: 'SYNTH00011' },
    });
    const att = s.getAttempt('hist-b15');
    assert.equal(att.billing_status, 'known');
    assert.equal(att.unknown_reserved_sif_units, 0);
    s.close();
  }

  // B16 & B17: CLI import-history stderr privacy, price-band gate0_options, price-band -> contact-sheet piping, Python stderr path redaction & size-cap/redirect unit checks
  await withTempDirAsync(async dir => {
    const badRec = join(dir, 'secret-rec.json');
    writeFileSync(badRec, 'PRIVATE_SUPPLIER_SECRET_B16', 'utf8');
    const recRes = spawnSync(process.execPath, [CLI_PATH, 'import-history', '--db', join(dir, 'b16.sqlite'), '--recovery', badRec], { encoding: 'utf8' });
    assert.equal(recRes.status, 2);
    assert.equal(recRes.stderr.includes('PRIVATE_SUPPLIER_SECRET_B16'), false);

    const pbFile = join(dir, 'pb-b17.json');
    writeFileSync(pbFile, JSON.stringify({
      category_check: { title: 'Oak Standing Desk', root_category: 'Office Furniture' },
      gate0_options: { avoid_red_ocean: { red_ocean_furniture: false } },
      listings: [
        { asin: 'SYNTH00012', price_usd: 199, fulfillment: 'FBA', monthly_units: 80, title: 'Oak Desk A' },
        { asin: 'SYNTH00013', price_usd: 219, fulfillment: 'FBA', monthly_units: 90, title: 'Oak Desk B' },
      ],
    }), 'utf8');
    const pbRes = spawnSync(process.execPath, [CLI_PATH, 'price-band', '--input', pbFile], { encoding: 'utf8' });
    assert.equal(pbRes.status, 0);
    const pbOut = JSON.parse(pbRes.stdout);
    assert.equal(pbOut.gate0.passed, true);

    // Pipe price-band output directly into contact-sheet!
    const pbOutFile = join(dir, 'pb-out.json');
    writeFileSync(pbOutFile, pbRes.stdout, 'utf8');
    const csPng = join(dir, 'b17-sheet.png');
    const csRes = spawnSync(process.execPath, [CLI_PATH, 'contact-sheet', '--input', pbOutFile, '--output', csPng, '--offline'], { encoding: 'utf8' });
    assert.equal(csRes.status, 0, csRes.stderr);
    const csJson = JSON.parse(csRes.stdout);
    assert.equal(csJson.rendered.items_rendered, 2);

    // Python script directly on missing file MUST NOT leak full absolute path / username!
    const pyBin = process.platform === 'win32' ? 'python' : 'python3';
    const pyMiss = spawnSync(pyBin, [join(REPO_ROOT, 'scripts', 'render_contact_sheet.py'), '--input', join(dir, 'nonexistent-b17.json'), '--output', join(dir, 'x.png'), '--offline'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    assert.equal(pyMiss.status, 2);
    assert.equal(pyMiss.stderr.includes(dir), false);

    // Direct Python unit test for _read_bounded 8 MiB cap + _SafeRedirectHandler + CGNAT 100.64.0.1 block!
    const pyUnit = spawnSync(pyBin, ['-c', `
import io, sys, urllib.error, urllib.request
sys.path.insert(0, r'${join(REPO_ROOT, 'scripts')}')
import render_contact_sheet as rcs
assert rcs._read_bounded(io.BytesIO(b'a' * 100), max_bytes=50) is None
assert len(rcs._read_bounded(io.BytesIO(b'a' * 50), max_bytes=50)) == 50
assert rcs._is_public_http_url('http://127.0.0.1/img.png') is False
assert rcs._is_public_http_url('http://100.64.0.1/img.png') is False
assert rcs._is_public_http_url('http://169.254.169.254/latest') is False
h = rcs._SafeRedirectHandler()
try:
    h.redirect_request(urllib.request.Request('https://example.com/a'), None, 302, 'Found', {}, 'http://127.0.0.1/secret')
    raise AssertionError('Expected redirect block')
except urllib.error.URLError:
    pass
print('PY_SECURITY_OK')
`], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
    assert.equal(pyUnit.status, 0, pyUnit.stderr);
    assert.match(pyUnit.stdout, /PY_SECURITY_OK/);

    // B18: Concurrent multi-process cold-start SQLite open (WAL + busy_timeout ordering + retry) & single-dispatch deduplication
    const concDb = join(dir, 'concurrent-b18.sqlite');
    const workerSrc = `
      import { SelectionStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
      const db = process.argv[1];
      const idx = process.argv[2];
      const s = new SelectionStore(db);
      s.upsertRawLead({
        lead_id: 'lead_b18_' + idx,
        phrase_or_title: 'synthetic organizer ' + idx,
        source_channel: 'reddit',
        source_ref: 'https://example.com/b18/' + idx,
        observed_at: '2026-11-20T00:00:00Z',
        raw_excerpt: 'synthetic excerpt ' + idx,
      });
      const r = s.reserveRequestAttempt({
        provider: 'sif',
        account_scope: 'default_us',
        observation_cutoff_date: '2026-11-20',
        tool_name: 'ops_get_listing_traffic_structure',
        params: { site: 'US', asin: 'SYNTH00014', lastDays: 30, timePieceValue: '30' },
        stage: 'gate1a',
        estimated_sif_units: 1,
      });
      if (r.decision === 'dispatch' || r.allowed === true) {
        s.markAttemptInFlight(r.attempt_id);
        s.completeAttempt(r.attempt_id, { sif_units: 1, billing_status: 'known' });
      }
      s.close();
    `;
    const workerResults = await Promise.all(
      Array.from({ length: 6 }, (_, i) => new Promise((resolvePromise) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerSrc, concDb, String(i)], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', d => { err += d; });
        child.on('close', code => resolvePromise({ idx: i, code, err }));
      })),
    );
    for (const wr of workerResults) {
      assert.equal(wr.code, 0, `concurrent worker ${wr.idx} failed: ${wr.err}`);
    }
    const checkStore = openSelectionStore(concDb, { readOnly: true });
    try {
      const sum = checkStore.getSummary();
      assert.equal(sum.counts.raw_leads, 6);
      assert.equal(sum.counts.api_request_ledger, 1, 'shared logical key across 6 parallel processes must only reserve/dispatch once');
    } finally {
      checkStore.close();
    }
  });
});

// ============================================================================
// Phase 3 pre-1688 audit remediation: prohibition-aware freebie scan, purchase-to-set bundle lineage,
// precise companion-peak reasons and r58 headline/filter pending-count parity.
// ============================================================================
function makeAuditSeasonalCandidate(id, { allPeriodsPending = false, peakProcurementPending = false, includePeak = true } = {}) {
  const c = structuredClone(fixture.candidates[0]);
  c.id = id;
  c.label = `合成分季款 ${id}`;
  const off = structuredClone(c.economics.scenarios[0]);
  off.id = off.cost_ledger.id = 'sc-regular';
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
    amount_usd: null, status: 'pending', fee_basis: { status: 'unavailable', version: 'Unpublished 2027 peak fulfillment' },
  });
  if (allPeriodsPending) {
    for (const sc of [off, peak]) {
      for (const lid of ['procurement', 'domestic_freight']) {
        Object.assign(sc.cost_ledger.lines.find(l => l.id === lid), { amount_usd: null, status: 'pending' });
      }
    }
  } else if (peakProcurementPending) {
    Object.assign(peak.cost_ledger.lines.find(l => l.id === 'procurement'), { amount_usd: null, status: 'pending' });
  }
  const periods = [{ id: 'off_peak', label: '2027年2–9月淡季', months: [2, 3, 4, 5, 6, 7, 8, 9], scenarios: [off] }];
  if (includePeak) periods.push({ id: 'peak', label: '2027年10–12月旺季', months: [10, 11, 12], scenarios: [peak] });
  c.economics = { saleable_unit: c.economics.saleable_unit, operating_periods: periods };
  return c;
}

test('Phase 3 audit: prohibition clauses never raise positive sensitive-freebie alerts and pre-quote packing lists are never marked checked', () => {
  const prohibitionNote = '合成不锈钢支架套装（铝合金底座＋硅胶缓冲垫），明确排除强磁夹具、润滑油、胶水、电池或清洁粉赠品。';
  const disclosure = (ops, mutateLedger = null) => {
    const cand = structuredClone(fixture.candidates[0]);
    cand.id = 'synthetic-freebie-check';
    if (mutateLedger) mutateLedger(cand.economics.scenarios[0].cost_ledger);
    cand.operations = ops;
    return scoreCandidate(cand, profile).diagnostics.operational_disclosures.find(d => d.id === 'sensitive_freebie_flags');
  };

  // Quoted procurement + prohibition wording -> clear (packing list checked), prohibited items recorded, no alert.
  const quoted = disclosure({ sensitive_freebie_checked: true, sensitive_freebie_flags: [], freebie_notes: prohibitionNote });
  assert.equal(quoted.status, 'clear');
  assert.equal(quoted.packing_list_checked, true);
  assert.deepEqual(quoted.matched_categories, []);
  assert.deepEqual(quoted.prohibited_categories.map(c => c.key).sort(), ['battery', 'glue', 'magnet', 'oil']);

  // Same prohibition text while the 1688 procurement line is still pending -> needs_check / needs_evidence, never clear.
  const pendingProc = ledger => Object.assign(ledger.lines.find(l => l.id === 'procurement'), { status: 'pending', amount_usd: null });
  const preQuote = disclosure({ sensitive_freebie_checked: true, sensitive_freebie_flags: [], freebie_notes: prohibitionNote }, pendingProc);
  assert.equal(preQuote.status, 'needs_check');
  assert.equal(preQuote.evidence_state, 'needs_evidence');
  assert.equal(preQuote.packing_list_checked, false);
  assert.equal(preQuote.procurement_quote_pending, true);
  assert.doesNotMatch(preQuote.note, /已核对 1688 装箱清单/);
  // A bare sensitive_freebie_checked claim (no notes) before any quote is also not a checked packing list.
  const bareClaim = disclosure({ sensitive_freebie_checked: true }, pendingProc);
  assert.equal(bareClaim.status, 'needs_check');
  assert.equal(bareClaim.packing_list_checked, false);

  // Affirmative inclusions still alert; mixed clauses separate prohibited from included items.
  assert.equal(disclosure({ freebie_notes: '每套附带润滑油一瓶。' }).status, 'alert');
  const mixed = disclosure({ freebie_notes: '不含电池，但附带润滑油。' });
  assert.equal(mixed.status, 'alert');
  assert.deepEqual(mixed.matched_categories.map(c => c.key), ['oil']);
  assert.deepEqual(mixed.prohibited_categories.map(c => c.key), ['battery']);
  const english = disclosure({ included_accessories: ['No batteries or magnets included; comes with glue stick', 'Battery not included', 'without lubricant oil'] });
  assert.equal(english.status, 'alert');
  assert.deepEqual(english.matched_categories.map(c => c.key), ['glue']);
  assert.deepEqual(english.prohibited_categories.map(c => c.key).sort(), ['battery', 'magnet', 'oil']);
  assert.equal(disclosure({ freebie_notes: '严禁附带强磁；禁止润滑油；无胶水；不得含电池；切勿附带粉末。' }).status, 'unverified');
  assert.equal(disclosure({ freebie_notes: 'Does not include batteries or magnets; forbid lubricant oil; prohibit glue.' }).status, 'unverified');
  const commaContrast = disclosure({ freebie_notes: '不含电池，附带润滑油。' });
  assert.equal(commaContrast.status, 'alert');
  assert.deepEqual(commaContrast.matched_categories.map(c => c.key), ['oil']);
  assert.deepEqual(commaContrast.prohibited_categories.map(c => c.key), ['battery']);
  // An explicit flag worded purely as a prohibition is not a positive alert; an affirmative flag still is.
  assert.equal(disclosure({ sensitive_freebie_flags: ['不含电池'] }).status, 'unverified');
  assert.equal(disclosure({ sensitive_freebie_flags: ['included lubricating oil bottle'] }).status, 'alert');
});

test('Phase 3 audit: purchase-to-set lineage (200 pcs -> 100 sets) surfaces the multi-SKU 2027-01-11 bundle check without moving scores', () => {
  const base = structuredClone(fixture.candidates[0]);
  base.id = 'synthetic-bundle-lineage';
  const bundled = structuredClone(base);
  const ledger = bundled.economics.scenarios[0].cost_ledger;
  ledger.source_inputs = { ...(ledger.source_inputs ?? {}), purchased_pieces: 200, complete_saleable_sets: 100 };
  const rBase = scoreCandidate(base, profile);
  const rBundled = scoreCandidate(bundled, profile);
  assert.deepEqual(rBundled.total_range, rBase.total_range);
  assert.deepEqual(rBundled.supported_range, rBase.supported_range);
  assert.equal(rBundled.queue, rBase.queue);
  const byId = Object.fromEntries(rBundled.diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(byId.packaging_and_2027_bundle_check.is_multi_sku_bundle, true);
  assert.equal(byId.packaging_and_2027_bundle_check.bundle_basis, 'purchase_units_exceed_sets');
  assert.equal(byId.packaging_and_2027_bundle_check.status, 'needs_check');
  assert.match(byId.packaging_and_2027_bundle_check.note, /采购 200 件组成 100 套，每套 2 件/);
  assert.match(byId.packaging_and_2027_bundle_check.note, /2027-01-11/);
  assert.equal(byId.batch_cash_and_moq.purchase_units, 200);
  assert.equal(byId.batch_cash_and_moq.purchase_units_per_set, 2);
  const baseById = Object.fromEntries(rBase.diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(baseById.packaging_and_2027_bundle_check.is_multi_sku_bundle, false);
  assert.equal(baseById.packaging_and_2027_bundle_check.bundle_basis, null);

  // Declared purchase SKUs and assumption/quote purchase-to-set lineage also mark the bundle.
  const declared = structuredClone(base);
  declared.operations = { purchase_sku_count: 2 };
  const decl = scoreCandidate(declared, profile).diagnostics.operational_disclosures.find(d => d.id === 'packaging_and_2027_bundle_check');
  assert.equal(decl.is_multi_sku_bundle, true);
  assert.equal(decl.bundle_basis, 'declared_purchase_skus');

  const fromAssumptions = structuredClone(base);
  fromAssumptions.economics.scenarios[0].cost_ledger.assumptions = [
    '采用单店200采购只＝100只甲规组件＋100只乙规组件＝100完整销售套非首单常规复购原价。',
  ];
  const assumpOps = Object.fromEntries(scoreCandidate(fromAssumptions, profile).diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(assumpOps.batch_cash_and_moq.purchase_units, 200);
  assert.equal(assumpOps.batch_cash_and_moq.declared_purchase_sku_count, 2);
  assert.equal(assumpOps.packaging_and_2027_bundle_check.is_multi_sku_bundle, true);
  assert.equal(assumpOps.packaging_and_2027_bundle_check.status, 'needs_check');
});

test('Phase 3 audit: a present [10,11,12] peak panel with pending cost inputs is reported precisely, not as a missing companion', () => {
  const valid = scoreCandidate(makeAuditSeasonalCandidate('synthetic-peak-valid'), profile);
  assert.equal(valid.qualification.mode, 'seasonal_eligible');
  assert.equal(valid.qualification.counts_toward_target, true);

  const incomplete = scoreCandidate(makeAuditSeasonalCandidate('synthetic-peak-incomplete', { peakProcurementPending: true }), profile);
  assert.equal(incomplete.qualification.counts_toward_target, false);
  const reasons = incomplete.qualification.reasons.join('\n');
  assert.doesNotMatch(reasons, /Missing valid 2027 companion/);
  assert.match(reasons, /Companion 2027 holiday peak panel \(peak\) is present with exact months \[10, 11, 12\]/);
  assert.match(reasons, /scenario sc-peak: pending cost inputs: procurement/);
  // The off-peak panel itself stays comparable; only the companion binding blocks qualification.
  assert.equal(incomplete.operating_periods.find(p => p.id === 'off_peak').queue, 'comparable');

  const noPeak = scoreCandidate(makeAuditSeasonalCandidate('synthetic-peak-absent', { includePeak: false }), profile);
  assert.match(noPeak.qualification.reasons.join('\n'), /Missing valid 2027 companion holiday peak operating panel/);
});

test('Phase 3 audit: r58 headline pending count matches the 待补证 filter pill and names seasonal pending cards', () => {
  const batch = {
    schema_version: 1,
    profile_revision: 59,
    candidates: [
      makeAuditSeasonalCandidate('synthetic-hdr-seasonal-pending', { peakProcurementPending: true }),
      makeAuditSeasonalCandidate('synthetic-hdr-seasonal-ok'),
    ],
  };
  const res = scoreBatch(batch, profile);
  const html = renderReport(res, batch);
  const headline = html.match(/<p class="batch-counts">本轮[^<]*<\/p>/)?.[0] ?? '';
  assert.match(headline, /待补证 1 个（含分季待补 1 个）/);
  assert.doesNotMatch(headline, /待补证 0 个/);
  assert.match(html, /id="filter-pending">待补证 1</);

  // Without seasonal pending cards the headline carries no seasonal qualifier.
  const flat = { schema_version: 1, profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
  const flatHtml = renderReport(scoreBatch(flat, profile), flat);
  assert.match(flatHtml.match(/<p class="batch-counts">本轮[^<]*<\/p>/)?.[0] ?? '', /待补证 0 个。/);
});

test('Phase 3 audit: synthetic 4-card mixed seasonal batch preserves 2-SKU bundle control score while aligning pre-quote disclosures and banner counts', () => {
  const unbundledRef = scoreCandidate(makeAuditSeasonalCandidate('synthetic-unbundled-ref'), profile);
  const bundleControl = makeAuditSeasonalCandidate('synthetic-2sku-bundle');
  for (const period of bundleControl.economics.operating_periods) {
    for (const sc of period.scenarios) {
      sc.cost_ledger.source_inputs = {
        ...(sc.cost_ledger.source_inputs ?? {}),
        purchased_pieces: 200,
        complete_saleable_sets: 100,
      };
      sc.cost_ledger.assumptions = [
        '采用单店200采购只＝100只甲规组件＋100只乙规组件＝100完整销售套非首单常规复购原价。',
      ];
    }
  }
  const candA = makeAuditSeasonalCandidate('synthetic-seasonal-a', { allPeriodsPending: true });
  const candB = makeAuditSeasonalCandidate('synthetic-seasonal-b', { allPeriodsPending: true });
  candB.operations = { order_units: 100, actual_complete_sets: 100, sensitive_freebie_checked: true };
  const candC = makeAuditSeasonalCandidate('synthetic-seasonal-c', { allPeriodsPending: true });
  candC.operations = {
    order_units: 100,
    actual_complete_sets: 100,
    sensitive_freebie_checked: true,
    sensitive_freebie_flags: [],
    freebie_notes: '合成金属支架套装，明确排除强磁组件、润滑油、胶水或电池赠品。',
  };

  const batch = {
    schema_version: 1,
    profile_revision: 59,
    candidates: [bundleControl, candA, candB, candC],
  };
  const res = scoreBatch(batch, profile);
  assert.equal(res.summary.qualifying, 1);
  assert.equal(res.summary.seasonal_review, 4);
  assert.equal(res.summary.seasonal_eligible, 1);
  const byId = Object.fromEntries(res.candidates.map(c => [c.candidate_id, c]));

  const ctrl = byId['synthetic-2sku-bundle'];
  assert.equal(ctrl.qualification.mode, 'seasonal_eligible');
  assert.deepEqual(
    ctrl.operating_periods.find(p => p.id === 'off_peak').supported_range,
    unbundledRef.operating_periods.find(p => p.id === 'off_peak').supported_range,
  );
  const ctrlOps = Object.fromEntries(ctrl.diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(ctrlOps.packaging_and_2027_bundle_check.is_multi_sku_bundle, true);
  assert.equal(ctrlOps.packaging_and_2027_bundle_check.status, 'needs_check');
  assert.equal(ctrlOps.batch_cash_and_moq.purchase_units, 200);
  assert.equal(ctrlOps.batch_cash_and_moq.declared_purchase_sku_count, 2);

  const freebieB = byId['synthetic-seasonal-b'].diagnostics.operational_disclosures.find(d => d.id === 'sensitive_freebie_flags');
  assert.equal(freebieB.packing_list_checked, false);
  assert.equal(freebieB.status, 'needs_check');
  assert.equal(freebieB.evidence_state, 'needs_evidence');

  const freebieC = byId['synthetic-seasonal-c'].diagnostics.operational_disclosures.find(d => d.id === 'sensitive_freebie_flags');
  assert.equal(freebieC.status, 'needs_check');
  assert.equal(freebieC.packing_list_checked, false);
  assert.deepEqual(freebieC.matched_categories, []);
  assert.deepEqual(freebieC.prohibited_categories.map(c => c.key).sort(), ['battery', 'glue', 'magnet', 'oil']);

  for (const id of ['synthetic-seasonal-a', 'synthetic-seasonal-b', 'synthetic-seasonal-c']) {
    const reasons = byId[id].qualification.reasons.join('\n');
    assert.doesNotMatch(reasons, /Missing valid 2027 companion/);
    assert.match(reasons, /pending cost inputs: procurement, domestic_freight/);
  }
  const html = renderReport(res, batch);
  assert.match(html.match(/<p class="batch-counts">本轮[^<]*<\/p>/)?.[0] ?? '', /待补证 3 个（含分季待补 3 个）/);
  assert.match(html, /id="filter-pending">待补证 3</);
});

test('Phase 3 Round-2 audit: pre-quote candidates never fabricate actualCompleteSets=100/remainder=0 or clear packaging from waiting tolerance notes', () => {
  const preQuote = makeAuditSeasonalCandidate('synthetic-prequote-ops', { allPeriodsPending: true });
  preQuote.operations = {
    order_units: 100,
    actual_complete_sets: null,
    remainder_units: null,
    sku_lines: [],
    packaging: {
      compatible_inner_pack: null,
      tolerance_note: '待1688报价核实单厂整套原箱出货、EPE护角独立盒及接口实测公差。',
    },
  };
  const rPre = scoreCandidate(preQuote, profile);
  const preById = Object.fromEntries(rPre.diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(preById.batch_cash_and_moq.order_units, 100);
  assert.equal(preById.batch_cash_and_moq.actual_complete_sets, null);
  assert.equal(preById.batch_cash_and_moq.remainder_units, null);
  assert.equal(preById.batch_cash_and_moq.batch_cash_tie_up_usd, null);
  assert.equal(preById.batch_cash_and_moq.status, 'unverified');
  assert.doesNotMatch(preById.batch_cash_and_moq.note, /首批 100 齐套|完全齐套无余料/);
  assert.equal(preById.packaging_and_2027_bundle_check.status, 'unverified');

  // Even if ops prematurely asserts actual_complete_sets=100, remainder_units=0, or compatible_inner_pack=true while procurement is pending
  // (without an observed order_plan or verified sku_lines), neither 100 sets nor packaging 'clear' is emitted.
  const premature = makeAuditSeasonalCandidate('synthetic-premature-ops', { allPeriodsPending: true });
  premature.operations = {
    order_units: 100,
    actual_complete_sets: 100,
    remainder_units: 0,
    packaging: { compatible_inner_pack: true, micron_tolerance: 50 },
  };
  const premById = Object.fromEntries(scoreCandidate(premature, profile).diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(premById.batch_cash_and_moq.actual_complete_sets, null);
  assert.equal(premById.batch_cash_and_moq.remainder_units, null);
  assert.notEqual(premById.packaging_and_2027_bundle_check.status, 'clear');
  assert.doesNotMatch(premById.packaging_and_2027_bundle_check.note, /已核查/);

  // Explicit order_plan or verified sku_lines still surface real pack-out sets & remainders even pre-quote.
  const planned = makeAuditSeasonalCandidate('synthetic-planned-ops', { allPeriodsPending: true });
  planned.operations = {
    order_plan: { allocated_sets: 100, actual_complete_sets: 104, total_remainder_pieces: 4 },
  };
  const planById = Object.fromEntries(scoreCandidate(planned, profile).diagnostics.operational_disclosures.map(d => [d.id, d]));
  assert.equal(planById.batch_cash_and_moq.actual_complete_sets, 104);
  assert.equal(planById.batch_cash_and_moq.remainder_units, 4);
  assert.equal(planById.batch_cash_and_moq.status, 'alert');

  // Even on a quoted candidate, waiting/placeholder tolerance wording never produces packaging 'clear'.
  for (const note of [
    '打样前核对接口公差 ±0.2 mm',
    '下单前向工厂确认内盒尺寸',
    'Tolerance awaiting supplier sample to be verified',
    'Inner tray fit pending / TBD',
  ]) {
    const cWait = structuredClone(fixture.candidates[0]);
    cWait.id = 'synthetic-wait-pkg';
    cWait.operations = { packaging: { compatible_inner_pack: true, tolerance_note: note } };
    const pkgDisc = scoreCandidate(cWait, profile).diagnostics.operational_disclosures.find(d => d.id === 'packaging_and_2027_bundle_check');
    assert.equal(pkgDisc.status, 'unverified', `Expected unverified for waiting note: ${note}`);
  }

  // Quoted candidate with a verified non-waiting tolerance note still achieves 'clear'.
  const cVerified = structuredClone(fixture.candidates[0]);
  cVerified.id = 'synthetic-verified-pkg';
  cVerified.operations = {
    packaging: { compatible_inner_pack: true, tolerance_note: '已实测卡槽公差 ±0.15 mm，EPE护角独立盒跌落核验通过。' },
  };
  const verPkg = scoreCandidate(cVerified, profile).diagnostics.operational_disclosures.find(d => d.id === 'packaging_and_2027_bundle_check');
  assert.equal(verPkg.status, 'clear');
});

test('Phase 3 Round-3 audit: seasonal candidate with excluded or deferred primary off_peak routes to hold bucket and aligns r58 banner, filter pills, and queue nav', () => {
  const elig = makeAuditSeasonalCandidate('synthetic-r3-eligible');
  const pend1 = makeAuditSeasonalCandidate('synthetic-r3-pend-1', { allPeriodsPending: true });
  const pend2 = makeAuditSeasonalCandidate('synthetic-r3-pend-2', { allPeriodsPending: true });
  const pend3 = makeAuditSeasonalCandidate('synthetic-r3-pend-3', { allPeriodsPending: true });

  // Economically rejected seasonal card (off_peak procurement exceeds price floor, domestic_freight deferred -> off_peak.queue === 'excluded')
  const excl = makeAuditSeasonalCandidate('synthetic-r3-seasonal-excluded');
  for (const period of excl.economics.operating_periods) {
    for (const sc of period.scenarios) {
      Object.assign(sc.cost_ledger.lines.find(l => l.id === 'procurement'), { status: 'sourced', amount_usd: 26.50 });
      Object.assign(sc.cost_ledger.lines.find(l => l.id === 'domestic_freight'), { status: 'deferred', amount_usd: null });
    }
  }

  const batch = {
    schema_version: 1,
    profile_revision: 59,
    candidates: [elig, pend1, pend2, pend3, excl],
  };
  const res = scoreBatch(batch, profile);
  const exclOut = res.candidates.find(c => c.candidate_id === 'synthetic-r3-seasonal-excluded');
  assert.equal(exclOut.queue, 'seasonal_review');
  assert.equal(exclOut.operating_periods.find(p => p.id === 'off_peak').queue, 'excluded');

  const html = renderReport(res, batch);
  const headline = html.match(/<p class="batch-counts">本轮[^<]*<\/p>/)?.[0] ?? '';
  assert.match(headline, /待补证 3 个（含分季待补 3 个），淘汰／暂缓 1 个（含分季排除／暂缓 1 个）/);
  assert.match(html, /id="filter-pass">达标可推进 1</);
  assert.match(html, /id="filter-pending">待补证 3</);
  assert.match(html, /id="filter-hold">淘汰／暂缓 1</);
  assert.match(html, /分季达标 1<\/a>/);
  assert.match(html, /分季待补 3<\/a>/);
  assert.match(html, /淘汰／暂缓 1<\/a>/);
  assert.match(html, /<article class="candidate"[^>]*data-queue="seasonal_review" data-eligible="false" data-bucket="hold">/);
  assert.match(html, /主营淡季不满足 · 排除/);

  // Seasonal card with strong_date_dependency = true on off_peak also routes to hold bucket.
  const def = makeAuditSeasonalCandidate('synthetic-r3-seasonal-deferred');
  def.screening.strong_date_dependency = { value: true, unit: 'boolean', evidence: ['synthetic-evidence'] };
  const defBatch = { schema_version: 1, profile_revision: 59, candidates: [def] };
  const defRes = scoreBatch(defBatch, profile);
  assert.equal(defRes.candidates[0].operating_periods.find(p => p.id === 'off_peak').queue, 'deferred');
  const defHtml = renderReport(defRes, defBatch);
  assert.match(defHtml, /data-bucket="hold"/);
  assert.match(defHtml, /id="filter-hold">淘汰／暂缓 1</);
});

test('Phase 3 Round-3 audit (r59): phase2-cli export-report admits only gate1b_rejected all_below_30pct into packaging_redesign_shortlist and excludes crossing-30% pending & rights-conflict forms', () => {
  withTempDir(dir => {
    const dbPath = join(dir, 'shortlist-filter.sqlite');
    const s = openSelectionStore(dbPath);
    const fCross = s.upsertCandidateForm({
      form_id: 'synthetic-cross-pending',
      label: 'Crossing Margin Form',
      buyer_task: 'Task A',
      saleable_set_composition: { qty: 1 },
    }).form;
    s.updateFormLifecycle(fCross.form_id, 'gate1b_pending', {
      gate1b_result: { status: 'gate1b_pending', margin_interval_verdict: 'crosses_30pct', spec_sha256: fCross.spec_sha256 },
      packaging_redesign_shortlist: { eligible: true, overshoot_mm: 5, current_margin: 0.27, redesigned_margin: 0.32, current_tier_id: 'small_bulky', target_tier_id: 'large_standard' },
    });

    const fRights = s.upsertCandidateForm({
      form_id: 'synthetic-rej-rights',
      label: 'Rights Rejected Form',
      buyer_task: 'Task B',
      saleable_set_composition: { qty: 1 },
    }).form;
    s.updateFormLifecycle(fRights.form_id, 'gate1b_rejected', {
      gate1b_result: { status: 'gate1b_rejected', margin_interval_verdict: 'rights_conflict', specific_rights_conflict_proven: true, spec_sha256: fRights.spec_sha256 },
      packaging_redesign_shortlist: { eligible: true, overshoot_mm: 5, current_margin: 0.27, redesigned_margin: 0.32, current_tier_id: 'small_bulky', target_tier_id: 'large_standard' },
    });

    const fBelow = s.upsertCandidateForm({
      form_id: 'synthetic-rej-allbelow',
      label: 'All Below Floor Form',
      buyer_task: 'Task C',
      saleable_set_composition: { qty: 1 },
    }).form;
    s.updateFormLifecycle(fBelow.form_id, 'gate1b_rejected', {
      gate1b_result: { status: 'gate1b_rejected', margin_interval_verdict: 'all_below_30pct', spec_sha256: fBelow.spec_sha256 },
      packaging_redesign_shortlist: { eligible: true, overshoot_mm: 5, current_margin: 0.27, redesigned_margin: 0.32, current_tier_id: 'small_bulky', target_tier_id: 'large_standard' },
    });
    s.close();

    const outDir = join(dir, 'out-report');
    const cliRes = spawnSync(process.execPath, [CLI_PATH, 'export-report', '--db', dbPath, '--batch', FIXTURE_PATH, '--profile', PROFILE_PATH, '--output', outDir], { encoding: 'utf8' });
    assert.equal(cliRes.status, 0, cliRes.stderr);
    const resJson = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'));
    assert.deepEqual((resJson.packaging_redesign_shortlist ?? []).map(x => x.form_id), ['synthetic-rej-allbelow']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    assert.match(html, /All Below Floor Form/);
    assert.doesNotMatch(html, /Crossing Margin Form/);
    assert.doesNotMatch(html, /Rights Rejected Form/);
  });
});

test('Phase 3 Round-3 audit: bare-goods margin upper bound < 30% with deferred/pending domestic_freight excludes in r58 while keeping crossing/viable bare-goods pending', () => {
  // 1) Bare goods already push upper-bound margin strictly below 30% while domestic_freight is deferred -> excluded!
  const cFail = makeAuditSeasonalCandidate('synthetic-bare-below30');
  for (const period of cFail.economics.operating_periods) {
    for (const sc of period.scenarios) {
      Object.assign(sc.cost_ledger.lines.find(l => l.id === 'procurement'), { status: 'sourced', amount_usd: 25.00 });
      Object.assign(sc.cost_ledger.lines.find(l => l.id === 'domestic_freight'), { status: 'deferred', amount_usd: null });
    }
  }
  const rFail = scoreCandidate(cFail, profile);
  const offFail = rFail.operating_periods.find(p => p.id === 'off_peak');
  assert.equal(offFail.queue, 'excluded');
  assert.equal(offFail.items.find(i => i.id === 'refund_adjusted_pre_ad_margin').status, 'ineligible');
  assert.ok(Array.isArray(offFail.diagnostics.economics.bare_goods_margin_upper_bounds));
  assert.ok(offFail.diagnostics.economics.bare_goods_margin_upper_bounds[1] < 0.30);

  // 2) Bare goods leave >= 30% upper-bound margin while domestic_freight is deferred -> MUST remain 'pending' (never pass or exclude)!
  const cViable = makeAuditSeasonalCandidate('synthetic-bare-above30');
  for (const period of cViable.economics.operating_periods) {
    for (const sc of period.scenarios) {
      Object.assign(sc.cost_ledger.lines.find(l => l.id === 'domestic_freight'), { status: 'deferred', amount_usd: null });
    }
  }
  const rViable = scoreCandidate(cViable, profile);
  const offViable = rViable.operating_periods.find(p => p.id === 'off_peak');
  assert.equal(offViable.queue, 'pending');
  assert.equal(offViable.diagnostics.economics.bare_goods_margin_upper_bounds, undefined);
});
