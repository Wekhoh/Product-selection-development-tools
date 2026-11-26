import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BARE_GOODS_DISCLOSURE_ZH,
  BUSINESS_THRESHOLDS,
  BUSINESS_THRESHOLD_AUDIT_REGISTRY,
} from '../src/business-thresholds.mjs';
import {
  computeHeadhaulWithA4Rules,
  estimateGate1A2027,
  lookupBulkyPlacementFee2027,
  solveMinPriceForMargin2027,
  validateFeeBasis,
} from '../src/fba-calculator.mjs';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';
import { openSelectionStore } from '../src/store.mjs';
import {
  runFastProfitHealthcheck2027,
  runGate1AForForm,
  runGate1BForForm,
  runPhase2Batch,
} from '../src/pipeline.mjs';
import { ingestTrialSpecification } from '../src/raw-ingest.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);
const synthBatch = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'),
);

const EXPECTED_DISCLOSURE = '当前按 1688 裸货价算，未含国内到深圳运费（常规约占 0.5%～1.5%，超大超重抛货拿样下单前实询）';
const STD_PKG = { id: 'pkg-std', length_in: 10, width_in: 8, height_in: 3, weight_lb: 1.0 };
const REF_TERMS = {
  referral_fraction: 0.15,
  refund_admin_fraction: 0.20,
  refund_admin_cap_usd: 5.00,
  minimum_referral_usd: 0.30,
};
const WIN_2027 = {
  sales: { from: '2027-02-01', through: '2027-10-14' },
  storage: { from: '2027-02-01', through: '2027-09-30' },
  inbound: { from: '2027-01-15', through: '2027-10-14' },
};

function makeCapturingStreams() {
  let out = '';
  let err = '';
  return {
    stdout: { write: chunk => { out += String(chunk); } },
    stderr: { write: chunk => { err += String(chunk); } },
    getOut: () => out,
    getErr: () => err,
  };
}

test('Issue #23: Kaiqi ¥10.0/kg nationwide base rate and bare-goods disclosure are registered in business-thresholds', () => {
  assert.equal(BUSINESS_THRESHOLDS.kaiqi_nationwide_sea_truck_base_cny_per_kg, 10.0);
  assert.equal(BUSINESS_THRESHOLD_AUDIT_REGISTRY.kaiqi_nationwide_sea_truck_base_cny_per_kg.confirmed_at, '2026-11-26');
  assert.equal(BARE_GOODS_DISCLOSURE_ZH, EXPECTED_DISCLOSURE);
});

test('Issue #23 (ADR-0001): steady-state multi-warehouse $0 placement decouples from 100-set cartons, blocks US-West ¥8.48/kg + $0 placement, and emits >=50kg/dest advisory note', () => {
  // 1) Ultra-light SKU: 100 sets, only 2 cartons (20 kg total < 50 kg, 5 kg/carton < 8 kg/carton? wait 10 kg/carton; use 4 cartons x 5 kg = 20 kg)
  const kaiqiLightHeadhaul = {
    carton_count: 4,
    weight_per_carton_kg: 5, // 20 kg total (<50 kg) and 5 kg/carton (<8 kg)
    carton_cm: [30, 30, 20], // 3 kg/carton -> 12 kg vol < 20 kg actual
    rate_cny_per_kg: 10.0,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 1.0,
  };
  const hhSteady = computeHeadhaulWithA4Rules(kaiqiLightHeadhaul, 7.2, 100, { isR58: true, isR59: true });
  assert.equal(hhSteady.missing_surcharge_quote ?? false, false, 'Steady-state primary headhaul must NOT block on 100-set <50kg or <8kg test-batch penalties');
  assert.equal(hhSteady.a4_applied.billed_total_kg, 20);
  assert.equal(hhSteady.a4_applied.replenishment_50kg_per_destination_units, 250, '0.2 kg/set -> 250 sets/destination to clear 50 kg');
  assert.match(hhSteady.a4_applied.advisory_replenishment_note, /50 kg/);
  assert.ok(Math.abs(hhSteady.amount_usd - ((20 * 11) / 100 / 7.2)) < 1e-6);

  // 2) Gate 1A defaults to steady-state $0 amazon_optimized when paired with Kaiqi >= ¥10.0/kg (even with <5 cartons on 100-set quote)
  const g1aSteady = estimateGate1A2027({
    pkg: STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: REF_TERMS,
    collection_rate: 0.006,
    order_units: 100,
    headhaul: kaiqiLightHeadhaul,
    profile_revision: 59,
  });
  assert.equal(g1aSteady.status, 'verified');
  assert.equal(g1aSteady.components.placement.split_option, 'amazon_optimized');
  assert.equal(g1aSteady.components.placement.selected_usd, 0);
  assert.equal(g1aSteady.components.headhaul.a4_applied.replenishment_50kg_per_destination_units, 250);

  // 3) Structural block: pure US-West ¥8.48/kg + non-oversize $0 amazon_optimized MUST be rejected (even with identical_cartons_count: 5 & multi_destination_headhaul_verified: true!)
  const usWestHeadhaul = {
    carton_count: 5,
    weight_per_carton_kg: 12,
    rate_cny_per_kg: 8.48,
    surcharge_cny_per_kg: 0,
    bond_cny_per_kg: 1.0,
  };
  const g1aUsWestZeroPlace = estimateGate1A2027({
    pkg: STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: REF_TERMS,
    collection_rate: 0.006,
    order_units: 100,
    headhaul: usWestHeadhaul,
    placement_split_option: 'amazon_optimized',
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    profile_revision: 59,
  });
  assert.equal(g1aUsWestZeroPlace.status, 'sensitivity_only', 'Pure US-West ¥8.48/kg must be structurally blocked from non-oversize $0 amazon_optimized placement');

  const plcUsWestDirect = lookupBulkyPlacementFee2027({
    pkg: STD_PKG,
    inbound_window: WIN_2027.inbound,
    split_option: 'amazon_optimized',
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    headhaul_rate_cny_per_kg: 8.48,
  });
  assert.equal(plcUsWestDirect.status, 'sensitivity_only');

  const esUsWestZeroPlace = evaluateEarlyScreen({
    profile_revision: 59,
    id: 'es-us-west-block',
    saleable_unit: '1 synthetic desk tray',
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    order_units: 100,
    goods_cny_per_unit: 40,
    goods_first_order_promotion: false,
    headhaul: usWestHeadhaul,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    fee_category: 'Home and Kitchen',
    pkg: STD_PKG,
    is_apparel_or_shoes: false,
    referral_terms: REF_TERMS,
    fulfillment_usd: 4.50,
    placement_usd: 0,
    placement_split_option: 'amazon_optimized',
    identical_cartons_count: 5,
    multi_destination_headhaul_verified: true,
    storage: { cubic_feet_per_unit: 0.1389, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...WIN_2027 },
    collection_rate: 0.006,
    other_applicable_usd: 0,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  });
  assert.equal(esUsWestZeroPlace.gate_status, 'pending', 'evaluateEarlyScreen must block US-West ¥8.48/kg paired with $0 placement');
  assert.equal(esUsWestZeroPlace.ledger.margin, null);

  // Explicit headhaul_destination_scope: 'us_west_single' even at ¥10.50/kg is also blocked from $0 placement!
  const g1aScopeBlock = estimateGate1A2027({
    pkg: STD_PKG,
    price_usd: 45.00,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: REF_TERMS,
    collection_rate: 0.006,
    order_units: 100,
    headhaul: { ...kaiqiLightHeadhaul, destination_scope: 'us_west_single' },
    placement_split_option: 'amazon_optimized',
    profile_revision: 59,
  });
  assert.equal(g1aScopeBlock.status, 'sensitivity_only');
});

test('Issue #23 (ADR-0002): SQLite CHECK migration allows null domestic_freight_cny_total on verified bare-goods quotes, preserves factory_id, and ranks superseded_uncompetitive on bare-goods price', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue23-sqlite-'));
  try {
    const dbPath = join(dir, 'legacy-check.sqlite');
    // Seed a legacy DB with the old strict domestic_freight_cny_total IS NOT NULL CHECK + factory_id column
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE candidate_forms (
        form_id TEXT PRIMARY KEY,
        product_family_key TEXT NOT NULL,
        label TEXT NOT NULL,
        buyer_task TEXT NOT NULL,
        saleable_set_composition_json TEXT NOT NULL,
        spec_version INTEGER NOT NULL DEFAULT 1,
        spec_sha256 TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sourcing_quotes_1688 (
        quote_id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
        spec_version INTEGER NOT NULL CHECK(spec_version >= 1),
        sku_lines_json TEXT NOT NULL,
        order_plan_json TEXT,
        pack_multiple INTEGER NOT NULL CHECK(pack_multiple >= 1),
        moq_sets INTEGER NOT NULL CHECK(moq_sets >= 1),
        actual_sets INTEGER NOT NULL CHECK(actual_sets >= 1),
        actual_complete_sets INTEGER NOT NULL CHECK(actual_complete_sets >= 1),
        goods_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (goods_cny_total IS NULL OR goods_cny_total > 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND goods_cny_total IS NOT NULL AND goods_cny_total > 0)),
        domestic_freight_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
        pkg_json TEXT,
        fx_cny_per_usd REAL CHECK(fx_cny_per_usd > 0),
        factory_id TEXT,
        spec_variant_key TEXT,
        kit_note TEXT,
        goods_first_order_promotion INTEGER NOT NULL CHECK(goods_first_order_promotion IN (0, 1)),
        freight_first_order_promotion INTEGER NOT NULL CHECK(freight_first_order_promotion IN (0, 1)),
        lead_time_days INTEGER CHECK(lead_time_days IS NULL OR lead_time_days >= 0),
        sensitive_freebie_flags_json TEXT NOT NULL,
        redacted_destination TEXT NOT NULL,
        redacted_screenshot_path TEXT,
        redacted_webp_sha256 TEXT,
        raw_readback_ref TEXT,
        observed_at TEXT NOT NULL,
        expires_at TEXT,
        quote_status TEXT NOT NULL CHECK(quote_status IN ('verified', 'superseded_uncompetitive', 'incomplete_cross_factory_kit', 'rejected_promo', 'rejected_spec', 'expired', 'pending')),
        created_at TEXT NOT NULL
      );
      INSERT INTO candidate_forms VALUES ('f-mig', 'fam-mig', 'Mig Test', 'Task', '[{"component_id":"unit","qty_per_saleable_set":1}]', 1, 'sha1', 'gate1a_passed', '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z');
      INSERT INTO sourcing_quotes_1688 VALUES (
        'q-old-fac', 'f-mig', 1, '[]', NULL, 1, 100, 100, 100, 4500, 120, NULL, 7.2, 'fac-legacy-1', 'std-v1', NULL,
        0, 0, 7, '{}', '广东深圳', NULL, NULL, NULL, '2026-11-26T00:00:00Z', NULL, 'verified', '2026-11-26T00:00:00Z'
      );
    `);
    rawDb.close();

    // Opening via openSelectionStore must migrate CHECK cleanly AND preserve factory_id='fac-legacy-1'!
    const store = openSelectionStore(dbPath);
    try {
      const preserved = store.getQuoteById('q-old-fac');
      assert.equal(preserved.factory_id, 'fac-legacy-1', 'Migration must preserve existing factory_id column');

      const uiOk = {
        logged_in: true,
        viewport_width_px: 1440,
        selected_sku_row_visible: true,
        settlement_bar_visible: true,
        applied_quantity_confirmed: true,
      };
      // Insert a cheaper bare-goods quote (¥40/set, domestic_freight_cny_total: null) -> must succeed and supersede q-old-fac (¥45/set)
      const qBare = store.recordSourcingQuote1688({
        quote_id: 'q-bare-cheaper',
        form_id: 'f-mig',
        factory_id: 'fac-bare-2',
        spec_variant_key: 'std-v1',
        observed_at: '2026-11-26T10:00:00Z',
        redacted_destination: '广东深圳',
        goods_first_order_promotion: false,
        quote_status: 'verified',
        goods_cny_total: 4000,
        domestic_freight_cny_total: null,
        fx_cny_per_usd: 7.2,
        raw_readback_ref: 'readback://1688/offer-2',
        ui_readback: uiOk,
        sku_lines: [{
          component_id: 'unit',
          offer_id: 'offer-2',
          sku_id: 'sku-2',
          factory_id: 'fac-bare-2',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 100,
          ordered_qty: 100,
          unit_price_cny: 40,
          regular_goods_promo_false: true,
        }],
      });
      assert.equal(qBare.quote.quote_status, 'verified');
      assert.equal(qBare.quote.domestic_freight_cny_total, null);
      assert.equal(store.getQuoteById('q-old-fac').quote_status, 'superseded_uncompetitive');

      // Insert an even cheaper bare-goods quote WITH large advisory freight (¥38/set bare + ¥500 advisory freight)
      // Must rank strictly on bare-goods price (¥38 < ¥40), superseding q-bare-cheaper!
      const qBareWithAdvisory = store.recordSourcingQuote1688({
        quote_id: 'q-bare-advisory',
        form_id: 'f-mig',
        factory_id: 'fac-bare-3',
        spec_variant_key: 'std-v1',
        observed_at: '2026-11-26T11:00:00Z',
        redacted_destination: '广东深圳',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        quote_status: 'verified',
        goods_cny_total: 3800,
        domestic_freight_cny_total: 500,
        fx_cny_per_usd: 7.2,
        raw_readback_ref: 'readback://1688/offer-3',
        ui_readback: uiOk,
        sku_lines: [{
          component_id: 'unit',
          offer_id: 'offer-3',
          sku_id: 'sku-3',
          factory_id: 'fac-bare-3',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 100,
          ordered_qty: 100,
          unit_price_cny: 38,
          regular_goods_promo_false: true,
        }],
      });
      assert.equal(qBareWithAdvisory.quote.quote_status, 'verified');
      assert.equal(store.getQuoteById('q-bare-cheaper').quote_status, 'superseded_uncompetitive');
    } finally {
      store.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Issue #23 (ADR-0001 + ADR-0002): end-to-end Gate 1A -> Gate 1B -> solveMinPrice -> CLI reverse-1688 -> profit-check -> scoreBatch -> HTML report bare-goods screening & disclosure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue23-e2e-'));
  try {
    const dbPath = join(dir, 'e2e.sqlite');
    const store = openSelectionStore(dbPath);
    try {
      store.upsertCandidateForm({
        form_id: 'form-bare-e2e',
        product_family_key: 'form-bare-e2e',
        label: 'Synthetic Bare-Goods Tray',
        buyer_task: 'Organize desk accessories',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      const kaiqiHh = {
        carton_count: 2,
        weight_per_carton_kg: 12, // 24 kg < 50 kg steady-state
        carton_cm: [35, 30, 25],
        rate_cny_per_kg: 10.0,
        surcharge_cny_per_kg: 0,
        bond_cny_per_kg: 1.0,
      };
      const g1a = runGate1AForForm(store, {
        form_id: 'form-bare-e2e',
        profile_revision: 59,
        scenarios: [{
          id: 'sc-bare-1',
          price_usd: 45.00,
          pkg: STD_PKG,
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: REF_TERMS,
          headhaul: kaiqiHh,
          collection_rate: 0.006,
          other_applicable_usd: 0,
        }],
      });
      assert.equal(g1a.gate_status, 'gate1a_passed');
      assert.equal(g1a.scenarios[0].estimate.components.placement.selected_usd, 0);

      const qRec = store.recordSourcingQuote1688({
        quote_id: 'q-bare-e2e',
        form_id: 'form-bare-e2e',
        factory_id: 'fac-e2e-1',
        observed_at: '2026-11-26T10:00:00Z',
        redacted_destination: '广东深圳',
        goods_first_order_promotion: false,
        quote_status: 'verified',
        goods_cny_total: 4200,
        domestic_freight_cny_total: null,
        fx_cny_per_usd: 7.2,
        pkg: STD_PKG,
        raw_readback_ref: 'readback://1688/off-e2e',
        ui_readback: {
          logged_in: true,
          viewport_width_px: 1440,
          selected_sku_row_visible: true,
          settlement_bar_visible: true,
          applied_quantity_confirmed: true,
        },
        sku_lines: [{
          component_id: 'unit',
          offer_id: 'off-e2e',
          sku_id: 'sku-e2e',
          factory_id: 'fac-e2e-1',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 100,
          ordered_qty: 100,
          unit_price_cny: 42,
          regular_goods_promo_false: true,
        }],
      });
      assert.equal(qRec.quote.quote_status, 'verified');

      const g1b = await runGate1BForForm(store, {
        form_id: 'form-bare-e2e',
        profile_revision: 59,
        as_of_date: '2026-11-26',
        existing_quote: qRec.quote,
        early_screen_builder: () => [{
          id: 'sc-bare-1',
          saleable_unit: '1 synthetic tray',
          price_usd: 45.00,
          pkg: STD_PKG,
          fx_cny_per_usd: 7.2,
          headhaul: kaiqiHh,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          fee_category: 'Home and Kitchen',
          referral_terms: REF_TERMS,
          fulfillment_usd: g1a.scenarios[0].estimate.components.fulfillment.total_usd,
          placement_usd: 0,
          placement_split_option: 'amazon_optimized',
          storage: {
            cubic_feet_per_unit: g1a.scenarios[0].estimate.components.storage.cubic_feet,
            rate_usd_per_cuft_month: 0.78,
            average_inventory_days: 45,
          },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...WIN_2027 },
          collection_rate: 0.006,
          other_applicable_usd: 0,
          specific_rights_conflict: false,
          strong_date_dependency: false,
        }],
      });
      assert.equal(g1b.status, 'gate1b_passed');
      assert.equal(g1b.proceed_to_gate2_3, true);
      assert.equal(g1b.forward_pricing.status, 'verified');
      assert.equal(g1b.forward_pricing.calculator_name_zh, '按 1688 成本算保底定价');
      assert.equal(g1b.forward_pricing.bare_goods_disclosure, EXPECTED_DISCLOSURE);
      assert.equal(g1b.early_screen.cost_basis, 'bare_goods_1688');
      assert.equal(g1b.early_screen.bare_goods_disclosure, EXPECTED_DISCLOSURE);
    } finally {
      store.close();
    }

    // 2) solveMinPriceForMargin2027 & profit-check & CLI reverse-1688 / solve-min-price on bare-goods quote
    const bareSolved = solveMinPriceForMargin2027({
      pkg: STD_PKG,
      bare_goods_quote: { goods_cny_total: 4200, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: STD_PKG },
      headhaul: { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: REF_TERMS,
      collection_rate: 0.006,
    });
    assert.equal(bareSolved.status, 'verified');
    assert.equal(bareSolved.cost_basis, 'bare_goods_1688');
    assert.equal(bareSolved.calculator_name_zh, '按 1688 成本算保底定价');
    assert.equal(bareSolved.bare_goods_disclosure, EXPECTED_DISCLOSURE);

    const hcBare = runFastProfitHealthcheck2027({
      pkg: STD_PKG,
      price_usd: 45.00,
      fx_cny_per_usd: 7.2,
      order_units: 100,
      goods_cny_total: 4200,
      headhaul: { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
    });
    assert.equal(hcBare.cost_basis, 'bare_goods_1688');
    assert.equal(hcBare.bare_goods_disclosure, EXPECTED_DISCLOSURE);
    assert.equal(hcBare.realized_2027_off_peak.status, 'verified');
    assert.equal(hcBare.forward_breakeven_30pct.status, 'verified');
    assert.equal(hcBare.forward_breakeven_30pct.calculator_name_zh, '按 1688 成本算保底定价');

    const revSpecPath = join(dir, 'rev-bare.json');
    writeFileSync(revSpecPath, JSON.stringify({
      fx_cny_per_usd: 7.2,
      pkg: STD_PKG,
      headhaul: { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
      quote: { goods_cny_total: 4200, order_units: 100 },
    }), 'utf8');
    const revStreams = makeCapturingStreams();
    const revCode = await runPhase2Cli(['reverse-1688', '--db', dbPath, '--input', revSpecPath], revStreams);
    assert.equal(revCode, 0, revStreams.getErr());
    const revJson = JSON.parse(revStreams.getOut());
    assert.equal(revJson.reverse_1688.calculator_name_zh, '按 1688 成本算保底定价');
    assert.equal(revJson.reverse_1688.cost_basis, 'bare_goods_1688');
    assert.equal(revJson.reverse_1688.bare_goods_disclosure, EXPECTED_DISCLOSURE);
    assert.equal(revJson.reverse_1688.solution.status, 'verified');
    assert.ok(Number.isFinite(revJson.reverse_1688.min_retail_price_for_30pct_usd));

    // 3) Formal scoreBatch + HTML renderReport with bare-goods domestic_freight (not_applicable, $0):
    //    No 待补证 on reference capital, and mandatory disclosure rendered in HTML!
    const batchCopy = structuredClone(synthBatch);
    const cand0 = batchCopy.candidates[0];
    for (const sc of cand0.economics.scenarios) {
      const dom = sc.cost_ledger.lines.find(l => l.id === 'domestic_freight');
      dom.amount_usd = 0;
      dom.status = 'not_applicable';
      dom.bare_goods_screening = true;
      dom.basis = EXPECTED_DISCLOSURE;
      delete dom.components;
      if (sc.cost_ledger.source_inputs) {
        delete sc.cost_ledger.source_inputs.domestic_per_unit_cny;
        sc.cost_ledger.source_inputs.domestic_freight_advisory_note = '页面显示包邮（参考）';
      }
      const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
      plc.amount_usd = 0;
      plc.split_option = 'amazon_optimized';
      plc.fee_basis.split_option = 'amazon_optimized';
      sc.cost_ledger.multi_destination_headhaul_verified = true;
    }
    const scored = scoreBatch(batchCopy, r59Profile);
    const candRes = scored.candidates.find(c => c.candidate_id === cand0.id);
    assert.ok(candRes, 'Target candidate must be present by candidate_id');
    assert.equal(candRes.qualification.counts_toward_target, true, 'Bare-goods + steady-state $0 placement card must qualify');

    const html = renderReport(scored, batchCopy, r59Profile);
    assert.ok(html.includes(EXPECTED_DISCLOSURE), 'HTML report must render mandatory bare-goods disclosure');
    assert.ok(html.includes('1688 裸货 + 头程'), 'HTML report must render bare-goods + headhaul reference capital row cleanly');
    assert.equal(
      /单件参考本金（1688 裸货 \+ 头程）[\s\S]{0,200}待补证/.test(html),
      false,
      'Bare-goods reference capital row must NOT show 待补证',
    );
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Issue #23 Astra audit regressions (P1-1..P1-5 & P2-1..P2-5): advisory freight never kills, US-West cannot spoof via outer label, steady-state parity, 200-set order_units, omitted domestic_freight bare-goods card, Kaiqi default ¥10/kg, legacy migration re-rank, and advisory 50kg/dest note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue23-astra-'));
  try {
    const uiOk = {
      logged_in: true,
      viewport_width_px: 1440,
      selected_sku_row_visible: true,
      settlement_bar_visible: true,
      applied_quantity_confirmed: true,
    };

    // P1-1: Same ¥121/set × 100 bare-goods quote with null freight vs ¥500 advisory freight + freight promo produces identical Gate 1B margin & forward price
    const db1 = join(dir, 'p1-1.sqlite');
    const store1 = openSelectionStore(db1);
    try {
      const kaiqi10 = { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
      const runSameBareQuote = async (formId, quotePatch) => {
        store1.upsertCandidateForm({
          form_id: formId,
          product_family_key: formId,
          label: `Form ${formId}`,
          buyer_task: 'Desk organizer',
          saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
        });
        const g1a = runGate1AForForm(store1, {
          form_id: formId,
          profile_revision: 59,
          scenarios: [{
            id: 'sc-1',
            price_usd: 45.00,
            pkg: STD_PKG,
            fx_cny_per_usd: 7.2,
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            fee_category: 'Home and Kitchen',
            referral_terms: REF_TERMS,
            headhaul: kaiqi10,
            collection_rate: 0.006,
            other_applicable_usd: 0,
          }],
        });
        const q = store1.recordSourcingQuote1688({
          quote_id: `q-${formId}`,
          form_id: formId,
          factory_id: 'fac-1',
          observed_at: '2026-11-26T10:00:00Z',
          redacted_destination: '广东深圳',
          goods_first_order_promotion: false,
          quote_status: 'verified',
          goods_cny_total: 11700,
          fx_cny_per_usd: 7.2,
          pkg: STD_PKG,
          raw_readback_ref: `rb://${formId}`,
          ui_readback: uiOk,
          sku_lines: [{
            component_id: 'unit', offer_id: 'o1', sku_id: 's1', factory_id: 'fac-1',
            pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100,
            unit_price_cny: 117, regular_goods_promo_false: true,
          }],
          ...quotePatch,
        });
        const g1b = await runGate1BForForm(store1, {
          form_id: formId,
          profile_revision: 59,
          as_of_date: '2026-11-26',
          existing_quote: q.quote,
          early_screen_builder: () => [{
            id: 'sc-1',
            saleable_unit: '1 organizer',
            price_usd: 45.00,
            pkg: STD_PKG,
            fx_cny_per_usd: 7.2,
            headhaul: kaiqi10,
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            return_threshold: 0.081,
            returns_processing_usd: 0,
            fee_category: 'Home and Kitchen',
            referral_terms: REF_TERMS,
            fulfillment_usd: g1a.scenarios[0].estimate.components.fulfillment.total_usd,
            placement_usd: 0,
            placement_split_option: 'amazon_optimized',
            storage: { cubic_feet_per_unit: g1a.scenarios[0].estimate.components.storage.cubic_feet, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...WIN_2027 },
            collection_rate: 0.006,
            other_applicable_usd: 0,
            specific_rights_conflict: false,
            strong_date_dependency: false,
          }],
        });
        return g1b;
      };
      const resNull = await runSameBareQuote('f-bare-null', { domestic_freight_cny_total: null, freight_first_order_promotion: true });
      const resAdv500 = await runSameBareQuote('f-bare-adv500', { bare_goods_screening: true, domestic_freight_cny_total: 500, freight_first_order_promotion: true });
      assert.equal(resNull.status, 'gate1b_passed');
      assert.equal(resAdv500.status, 'gate1b_passed');
      assert.equal(resNull.early_screen.metrics.margin, resAdv500.early_screen.metrics.margin);
      assert.equal(resNull.forward_pricing.feasible_min_price_usd, resAdv500.forward_pricing.feasible_min_price_usd);
      assert.equal(resAdv500.quote.pricing_basis, 'bare_goods_1688');
      assert.equal(resAdv500.quote.domestic_freight_advisory_cny_total, 500);
    } finally {
      store1.close();
    }

    // P1-2: US-West ¥8.48/kg + us_west_single headhaul CANNOT be spoofed into $0 placement via outer ¥10/kg + nationwide labels
    const usWestInner = { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 8.48, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0, destination_scope: 'us_west_single' };
    assert.equal(lookupBulkyPlacementFee2027({
      pkg: STD_PKG, inbound_window: WIN_2027.inbound, split_option: 'amazon_optimized',
      headhaul: usWestInner, headhaul_rate_cny_per_kg: 10.0, headhaul_destination_scope: 'nationwide', multi_destination_headhaul_verified: true,
    }).status, 'sensitivity_only');
    assert.notEqual(estimateGate1A2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: REF_TERMS, collection_rate: 0.006, order_units: 100,
      headhaul: usWestInner, headhaul_rate_cny_per_kg: 10.0, headhaul_destination_scope: 'nationwide', placement_split_option: 'amazon_optimized',
    }).status, 'verified');
    const hcSpoof = runFastProfitHealthcheck2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_total: 4000,
      headhaul: usWestInner, headhaul_rate_cny_per_kg: 10.0, headhaul_destination_scope: 'nationwide', placement_split_option: 'amazon_optimized',
    });
    assert.notEqual(hcSpoof.realized_2027_off_peak.status, 'verified');

    // P1-3: Top-level steady_state_replenishment: false enforces small-batch A4; explicit true ignores carrier rate-table metadata
    const light4x5 = { carton_count: 4, weight_per_carton_kg: 5, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
    assert.equal(estimateGate1A2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: REF_TERMS, collection_rate: 0.006, order_units: 100,
      steady_state_replenishment: false, headhaul: light4x5,
    }).status, 'needs_calculator_verification');
    const steadyWithRateTableMeta = computeHeadhaulWithA4Rules({
      ...light4x5,
      steady_state_replenishment: true,
      small_shipment_threshold_kg: 50,
      small_shipment_surcharge_cny_per_kg: 3,
      small_carton_threshold_kg: 8,
      small_carton_surcharge_cny_per_carton: 20,
    }, 7.2, 100, { isR58: true, isR59: true });
    assert.equal(steadyWithRateTableMeta.a4_applied.steady_state_replenishment, true);
    assert.equal(steadyWithRateTableMeta.a4_applied.below_50kg_small_shipment, false);
    assert.equal(steadyWithRateTableMeta.a4_applied.below_8kg_outer_carton, false);
    assert.ok(Math.abs(steadyWithRateTableMeta.amount_usd - ((20 * 11) / 100 / 7.2)) < 1e-6);

    // P1-4: 200-set 80 kg quote preserves order_units across Gate 1A -> forward pricing (no silent fallback to 100 sets)
    const db200 = join(dir, 'p1-4.sqlite');
    const store200 = openSelectionStore(db200);
    try {
      store200.upsertCandidateForm({
        form_id: 'f-200', product_family_key: 'f-200', label: '200-set MOQ', buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      const hh80 = { actual_weight_kg_total: 80, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
      const g1a200 = runGate1AForForm(store200, {
        form_id: 'f-200', profile_revision: 59,
        scenarios: [{
          id: 'sc-200', price_usd: 45, pkg: STD_PKG, fx_cny_per_usd: 7.2, order_units: 200,
          refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
          referral_terms: REF_TERMS, headhaul: hh80, collection_rate: 0.006, other_applicable_usd: 0,
        }],
      });
      assert.equal(g1a200.gate_status, 'gate1a_passed');
      const q200 = store200.recordSourcingQuote1688({
        quote_id: 'q-200', form_id: 'f-200', factory_id: 'fac-200', observed_at: '2026-11-26T10:00:00Z',
        redacted_destination: '广东深圳', goods_first_order_promotion: false, quote_status: 'verified',
        goods_cny_total: 18000, domestic_freight_cny_total: null, fx_cny_per_usd: 7.2, pkg: STD_PKG,
        raw_readback_ref: 'rb://200', ui_readback: uiOk, target_sets: 200,
        sku_lines: [{ component_id: 'unit', offer_id: 'o200', sku_id: 's200', factory_id: 'fac-200', pack_multiple: 200, qty_per_saleable_set: 1, moq_qty: 200, ordered_qty: 200, unit_price_cny: 90, regular_goods_promo_false: true }],
      });
      const direct200 = solveMinPriceForMargin2027({
        pkg: STD_PKG, bare_goods_quote: q200.quote, fx_cny_per_usd: 7.2, order_units: 200,
        headhaul: { ...hh80, order_units: 200 }, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
        referral_terms: REF_TERMS, collection_rate: 0.006,
      });
      const inferred200 = solveMinPriceForMargin2027({
        pkg: STD_PKG, bare_goods_quote: q200.quote, fx_cny_per_usd: 7.2,
        headhaul: hh80, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
        referral_terms: REF_TERMS, collection_rate: 0.006,
      });
      assert.equal(inferred200.feasible_min_price_usd, direct200.feasible_min_price_usd);
    } finally {
      store200.close();
    }

    // P1-5 & P2-5: Explicit cost_basis:'bare_goods_1688' card omitting domestic_freight line still qualifies + overview shows 1688百套裸货
    const bareOmitBatch = structuredClone(synthBatch);
    const singleCand = bareOmitBatch.candidates[0];
    bareOmitBatch.candidates = [singleCand];
    for (const sc of singleCand.economics.scenarios) {
      sc.cost_ledger.cost_basis = 'bare_goods_1688';
      sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
      if (sc.cost_ledger.source_inputs) delete sc.cost_ledger.source_inputs.domestic_per_unit_cny;
    }
    const scoredOmit = scoreBatch(bareOmitBatch, r59Profile);
    const omitRes = scoredOmit.candidates.find(c => c.candidate_id === singleCand.id);
    assert.equal(omitRes.qualification.counts_toward_target, true);
    const htmlOmit = renderReport(scoredOmit, bareOmitBatch, r59Profile);
    assert.ok(htmlOmit.includes('1688百套裸货'), 'Overview matrix must display 1688百套裸货 when all cards are bare-goods');
    assert.ok(htmlOmit.includes(EXPECTED_DISCLOSURE));

    // P2-1: Profit-check rejects explicit bare_goods_screening:false without freight & <100-set batch total; solveMinPrice rejects promo quote & keeps disclosure on infeasible
    const hcNeedFreight = runFastProfitHealthcheck2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_total: 4000,
      bare_goods_screening: false, headhaul_usd: 1.5,
    });
    assert.equal(hcNeedFreight.realized_2027_off_peak.status, 'pending_domestic_freight');
    const hc1Set = runFastProfitHealthcheck2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 1, goods_cny_total: 40, headhaul_usd: 1.5,
    });
    assert.equal(hc1Set.realized_2027_off_peak.status, 'needs_calculator_verification');
    const promoSolve = solveMinPriceForMargin2027({
      pkg: STD_PKG, fx_cny_per_usd: 7.2, headhaul_usd: 1.5, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
      bare_goods_quote: { goods_cny_total: 4000, actual_sets: 100, goods_first_order_promotion: true, quote_status: 'rejected_promo', fx_cny_per_usd: 7.2, pkg: STD_PKG },
    });
    assert.equal(promoSolve.status, 'needs_calculator_verification');
    const infeasibleBare = solveMinPriceForMargin2027({
      pkg: STD_PKG, bare_goods_cny: 4000, fx_cny_per_usd: 7.2, headhaul_usd: 1.5, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006, max_search_price_usd: 40,
    });
    assert.equal(infeasibleBare.status, 'infeasible');
    assert.equal(infeasibleBare.calculator_name_zh, '按 1688 成本算保底定价');
    assert.equal(infeasibleBare.cost_basis, 'bare_goods_1688');
    assert.equal(infeasibleBare.bare_goods_disclosure, EXPECTED_DISCLOSURE);

    // P2-2 & P2-4: Kaiqi nationwide default ¥10.0/kg when rate omitted, and 60 kg / 5 warehouses = 12 kg/dest surfaces advisory_replenishment_note in profit-check
    const hcKaiqiDefault = runFastProfitHealthcheck2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_total: 4200,
      headhaul: { carton_count: 5, weight_per_carton_kg: 12, destination_scope: 'nationwide_multi_warehouse', bond_cny_per_kg: 1.0 },
    });
    assert.equal(hcKaiqiDefault.realized_2027_off_peak.status, 'verified');
    assert.match(hcKaiqiDefault.advisory_replenishment_note ?? '', /50 kg/, '60 kg / 5 warehouses (<50 kg/dest) must surface replenishment note in profit-check');

    // P2-3: Legacy DB migration re-ranks freight-distorted winner (A ¥38+¥500 previously superseded by B ¥40+¥0 -> A promoted to verified)
    const legacyRankDb = join(dir, 'legacy-rerank.sqlite');
    const rawR = new DatabaseSync(legacyRankDb);
    try {
      rawR.exec(`
        CREATE TABLE candidate_forms (
          form_id TEXT PRIMARY KEY, product_family_key TEXT NOT NULL, spec_version INTEGER NOT NULL DEFAULT 1,
          spec_sha256 TEXT NOT NULL, label TEXT NOT NULL, buyer_task TEXT NOT NULL,
          saleable_set_composition_json TEXT NOT NULL, lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE sourcing_quotes_1688 (
          quote_id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
          spec_version INTEGER NOT NULL, sku_lines_json TEXT NOT NULL, order_plan_json TEXT,
          pack_multiple INTEGER NOT NULL, moq_sets INTEGER NOT NULL, actual_sets INTEGER NOT NULL, actual_complete_sets INTEGER NOT NULL,
          goods_cny_total REAL CHECK(goods_cny_total > 0),
          domestic_freight_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
          pkg_json TEXT, fx_cny_per_usd REAL, factory_id TEXT, spec_variant_key TEXT, kit_note TEXT,
          goods_first_order_promotion INTEGER NOT NULL, freight_first_order_promotion INTEGER NOT NULL,
          lead_time_days INTEGER, sensitive_freebie_flags_json TEXT NOT NULL, redacted_destination TEXT NOT NULL,
          redacted_screenshot_path TEXT, redacted_webp_sha256 TEXT, raw_readback_ref TEXT,
          observed_at TEXT NOT NULL, expires_at TEXT, quote_status TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO candidate_forms VALUES ('f-rank','f-rank',1,'abc','L','T','[]','discovered','2026-11-20T00:00:00Z','2026-11-20T00:00:00Z');
        INSERT INTO sourcing_quotes_1688 VALUES
          ('q-a-38','f-rank',1,'[]',NULL,1,100,100,100,3800,500,NULL,7.2,'fac-a','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://a','2026-11-20T00:00:00Z',NULL,'superseded_uncompetitive','2026-11-20T00:00:00Z'),
          ('q-b-40','f-rank',1,'[]',NULL,1,100,100,100,4000,0,NULL,7.2,'fac-b','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://b','2026-11-20T01:00:00Z',NULL,'verified','2026-11-20T01:00:00Z');
      `);
    } finally {
      rawR.close();
    }
    const migratedRankStore = openSelectionStore(legacyRankDb);
    try {
      assert.equal(migratedRankStore.getQuoteById('q-a-38').quote_status, 'verified', 'Migration must promote cheaper bare-goods quote A (¥38)');
      assert.equal(migratedRankStore.getQuoteById('q-b-40').quote_status, 'superseded_uncompetitive', 'Migration must supersede pricier bare-goods quote B (¥40)');
    } finally {
      migratedRankStore.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Issue #23 adversarial review regressions: Kaiqi default ¥10/kg parity, usd_per_unit us_west_single block, bare-goods freight-only promo, explicit non-bare solveMinPrice & replenishment note, and expired-quote immunity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue23-adv-core-'));
  try {
    // 1) Kaiqi nationwide default ¥10.0/kg with chargeable_kg_per_unit (rate_cny_per_kg omitted) matches across ALL entrypoints
    const kaiqiDefaultChg = { destination_scope: 'nationwide_multi_warehouse', chargeable_kg_per_unit: 0.60, bond_cny_per_kg: 1.0 };
    const hhDef = computeHeadhaulWithA4Rules(kaiqiDefaultChg, 7.2, 100, { isR58: true, isR59: true });
    assert.ok(Math.abs(hhDef.amount_usd - (0.60 * 11 / 7.2)) < 1e-6);

    const g1aDef = estimateGate1A2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
      order_units: 100, headhaul: kaiqiDefaultChg, profile_revision: 59,
    });
    assert.equal(g1aDef.status, 'verified');
    assert.equal(g1aDef.components.placement.selected_usd, 0);
    assert.equal(g1aDef.components.headhaul.amount_usd, hhDef.amount_usd);

    const hcDef = runFastProfitHealthcheck2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100,
      goods_cny_total: 4200, headhaul: kaiqiDefaultChg,
    });
    assert.equal(hcDef.realized_2027_off_peak.status, 'verified');

    const revDefPath = join(dir, 'rev-kaiqi-default.json');
    writeFileSync(revDefPath, JSON.stringify({
      fx_cny_per_usd: 7.2, pkg: STD_PKG, headhaul: kaiqiDefaultChg,
      quote: { goods_cny_total: 4200, order_units: 100 },
    }), 'utf8');
    const revDefStreams = makeCapturingStreams();
    assert.equal(await runPhase2Cli(['reverse-1688', '--db', join(dir, 'rev.sqlite'), '--input', revDefPath], revDefStreams), 0);
    const revDefOut = JSON.parse(revDefStreams.getOut());
    assert.equal(revDefOut.reverse_1688.solution.status, 'verified');

    // 2) usd_per_unit-only headhaul with destination_scope:'us_west_single' is blocked from $0 placement in Gate 1A AND calculateEconomics
    const usWestUsdHh = { usd_per_unit: 0.70, bond_included: true, destination_scope: 'us_west_single' };
    const g1aUsWestUsd = estimateGate1A2027({
      pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
      order_units: 100, headhaul: usWestUsdHh, placement_split_option: 'amazon_optimized',
      identical_cartons_count: 5, multi_destination_headhaul_verified: true, profile_revision: 59,
    });
    assert.equal(g1aUsWestUsd.status, 'sensitivity_only');

    const econUsWestLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    econUsWestLedger.headhaul = usWestUsdHh;
    const plcLn = econUsWestLedger.lines.find(l => l.id === 'placement');
    plcLn.amount_usd = 0;
    plcLn.split_option = 'amazon_optimized';
    plcLn.fee_basis = { ...(plcLn.fee_basis ?? {}), split_option: 'amazon_optimized' };
    econUsWestLedger.multi_destination_headhaul_verified = true;
    const econUsWestRes = calculateEconomics(econUsWestLedger, { profileRevision: 59, requireFeeBasis: false });
    assert.equal(econUsWestRes.margin, null, 'calculateEconomics must hold pending when usd_per_unit us_west_single pairs with $0 placement');
    assert.ok(econUsWestRes.pending_lines.includes('placement'));

    // 3) evaluateEarlyScreen bare-goods ignores freight-only first_order_promotion when goods_first_order_promotion === false
    const esBase = {
      profile_revision: 59, id: 'es-bare-promo', saleable_unit: '1 organizer',
      price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_per_unit: 42,
      headhaul: { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
      refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0,
      fee_category: 'Home and Kitchen', pkg: STD_PKG, is_apparel_or_shoes: false, referral_terms: REF_TERMS,
      fulfillment_usd: 4.50, placement_usd: 0, placement_split_option: 'amazon_optimized',
      storage: { cubic_feet_per_unit: 0.1389, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...WIN_2027 },
      collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
    };
    const esFreightOnlyPromo = evaluateEarlyScreen({
      ...esBase, bare_goods_screening: true, goods_first_order_promotion: false, first_order_promotion: true,
    });
    assert.equal(esFreightOnlyPromo.gate_status, 'pass');
    assert.equal(esFreightOnlyPromo.cost_basis, 'bare_goods_1688');
    // Still rejects when goods_first_order_promotion is omitted (ambiguous promo) or non-bare-goods mode
    const esAmbigPromo = evaluateEarlyScreen({ ...esBase, bare_goods_screening: true, first_order_promotion: true });
    assert.equal(esAmbigPromo.gate_status, 'pending');

    // 4) solveMinPriceForMargin2027 rejects bare_goods_screening:false + null freight AND exposes advisory_replenishment_note (+ CLI solve-min-price)
    const solveNeedFreight = solveMinPriceForMargin2027({
      pkg: STD_PKG, fx_cny_per_usd: 7.2, headhaul_usd: 1.5, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
      bare_goods_screening: false,
      landed_domestic_quote: { goods_cny_total: 4200, domestic_freight_cny_total: null, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: STD_PKG },
    });
    assert.equal(solveNeedFreight.status, 'pending_domestic_freight');
    assert.equal(solveNeedFreight.cost_basis, 'landed_domestic_explicit');

    const lightHh = { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
    const solveWithNote = solveMinPriceForMargin2027({
      pkg: STD_PKG, fx_cny_per_usd: 7.2, headhaul: lightHh, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
      bare_goods_quote: { goods_cny_total: 4200, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: STD_PKG },
    });
    assert.equal(solveWithNote.status, 'verified');
    assert.match(solveWithNote.advisory_replenishment_note ?? '', /50 kg/);

    const solveCliPath = join(dir, 'solve-min.json');
    writeFileSync(solveCliPath, JSON.stringify({
      pkg: STD_PKG, fx_cny_per_usd: 7.2, headhaul: lightHh, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
      bare_goods_quote: { goods_cny_total: 4200, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: STD_PKG },
    }), 'utf8');
    const solveStreams = makeCapturingStreams();
    assert.equal(await runPhase2Cli(['solve-min-price', '--db', join(dir, 'solve.sqlite'), '--input', solveCliPath], solveStreams), 0);
    const solveCliOut = JSON.parse(solveStreams.getOut());
    assert.match(solveCliOut.advisory_replenishment_note ?? '', /50 kg/);

    // 5) Expired quotes are NEVER promoted during legacy migration reranking AND NEVER supersede fresh quotes in recordSourcingQuote1688
    const expDbPath = join(dir, 'expired-immunity.sqlite');
    const rawExp = new DatabaseSync(expDbPath);
    try {
      rawExp.exec(`
        CREATE TABLE candidate_forms (
          form_id TEXT PRIMARY KEY, product_family_key TEXT NOT NULL, spec_version INTEGER NOT NULL DEFAULT 1,
          spec_sha256 TEXT NOT NULL, label TEXT NOT NULL, buyer_task TEXT NOT NULL,
          saleable_set_composition_json TEXT NOT NULL, lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE sourcing_quotes_1688 (
          quote_id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
          spec_version INTEGER NOT NULL, sku_lines_json TEXT NOT NULL, order_plan_json TEXT,
          pack_multiple INTEGER NOT NULL, moq_sets INTEGER NOT NULL, actual_sets INTEGER NOT NULL, actual_complete_sets INTEGER NOT NULL,
          goods_cny_total REAL CHECK(goods_cny_total > 0),
          domestic_freight_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
          pkg_json TEXT, fx_cny_per_usd REAL, factory_id TEXT, spec_variant_key TEXT, kit_note TEXT,
          goods_first_order_promotion INTEGER NOT NULL, freight_first_order_promotion INTEGER NOT NULL,
          lead_time_days INTEGER, sensitive_freebie_flags_json TEXT NOT NULL, redacted_destination TEXT NOT NULL,
          redacted_screenshot_path TEXT, redacted_webp_sha256 TEXT, raw_readback_ref TEXT,
          observed_at TEXT NOT NULL, expires_at TEXT, quote_status TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO candidate_forms VALUES ('f-exp','f-exp',1,'sha','Exp Test','Task','[{"component_id":"unit","qty_per_saleable_set":1}]','discovered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO sourcing_quotes_1688 VALUES
          ('q-expired-cheap','f-exp',1,'[]',NULL,1,100,100,100,3500,500,NULL,7.2,'fac-old','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://old','2026-01-01T00:00:00Z','2026-02-01','superseded_uncompetitive','2026-01-01T00:00:00Z'),
          ('q-active-cur','f-exp',1,'[]',NULL,1,100,100,100,4000,0,NULL,7.2,'fac-cur','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://cur','2026-11-20T00:00:00Z',NULL,'verified','2026-11-20T00:00:00Z');
      `);
    } finally {
      rawExp.close();
    }
    const expStore = openSelectionStore(expDbPath);
    try {
      assert.equal(expStore.getQuoteById('q-expired-cheap').quote_status, 'superseded_uncompetitive', 'Expired quote must NOT be resurrected by migration rerank');
      assert.equal(expStore.getQuoteById('q-active-cur').quote_status, 'verified', 'Active quote must stay verified when only cheaper peer is expired');
    } finally {
      expStore.close();
    }

    // Seed a fresh DB with an expired 'verified' cheap quote (¥35) and insert a fresh quote (¥40) -> fresh quote must stay 'verified'!
    const expRecStore = openSelectionStore(join(dir, 'expired-rec.sqlite'));
    try {
      expRecStore.upsertCandidateForm({
        form_id: 'f-exp-rec', product_family_key: 'f-exp-rec', label: 'Exp Rec', buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      expRecStore.db.prepare(`
        INSERT INTO sourcing_quotes_1688 (
          quote_id, form_id, spec_version, sku_lines_json, order_plan_json, pack_multiple, moq_sets, actual_sets, actual_complete_sets,
          goods_cny_total, domestic_freight_cny_total, pkg_json, fx_cny_per_usd, factory_id, spec_variant_key, kit_note,
          goods_first_order_promotion, freight_first_order_promotion, lead_time_days, sensitive_freebie_flags_json,
          redacted_destination, redacted_screenshot_path, redacted_webp_sha256, raw_readback_ref, observed_at, expires_at, quote_status, created_at
        ) VALUES ('q-exp-ver','f-exp-rec',1,'[]',NULL,1,100,100,100,3500,NULL,NULL,7.2,'fac-exp','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://e','2026-01-01T00:00:00Z','2026-02-01','verified','2026-01-01T00:00:00Z')
      `).run();
      const freshRec = expRecStore.recordSourcingQuote1688({
        quote_id: 'q-fresh-40', form_id: 'f-exp-rec', factory_id: 'fac-new', spec_variant_key: 'v1',
        observed_at: '2026-11-26T10:00:00Z', redacted_destination: '广东深圳',
        goods_first_order_promotion: false, quote_status: 'verified',
        goods_cny_total: 4000, domestic_freight_cny_total: null, fx_cny_per_usd: 7.2,
        raw_readback_ref: 'rb://fresh',
        ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
        sku_lines: [{ component_id: 'unit', offer_id: 'o-f', sku_id: 's-f', factory_id: 'fac-new', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
      });
      assert.equal(freshRec.quote.quote_status, 'verified', 'Fresh quote must NOT be superseded by an expired verified quote');
    } finally {
      expRecStore.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('Issue #23 adversarial review regressions: raw-ingest SP-API calibration preserves $0 placement & recalibrates carton headhaul, Stage 3 rejects [0,0]+us_west_single, and report renders pending bare-goods + mobile CSS cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue23-adv-e2e-'));
  try {
    // 1) ingestTrialSpecification with SQLite bare-goods quote (¥500 advisory freight + freight promo) + omitted domestic_freight + SP-API calibration
    const spDb = join(dir, 'sp-bare.sqlite');
    const spStore = openSelectionStore(spDb);
    try {
      spStore.upsertCandidateForm({
        form_id: 'form-sp-bare', product_family_key: 'form-sp-bare', label: 'SP Bare', buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      spStore.recordSourcingQuote1688({
        quote_id: 'q-sp-bare', form_id: 'form-sp-bare', factory_id: 'fac-sp',
        observed_at: '2026-11-26T10:00:00Z', redacted_destination: '广东深圳',
        goods_first_order_promotion: false, freight_first_order_promotion: true,
        bare_goods_screening: true, quote_status: 'verified',
        goods_cny_total: 4200, domestic_freight_cny_total: 500, fx_cny_per_usd: 7.2, pkg: STD_PKG,
        raw_readback_ref: 'rb://sp-bare',
        ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
        sku_lines: [{ component_id: 'unit', offer_id: 'o-sp', sku_id: 's-sp', factory_id: 'fac-sp', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true }],
      });

      const makeSpCand = (id, cartonWtKg) => {
        const c = structuredClone(synthBatch.candidates[0]);
        c.id = id;
        c.form_id = 'form-sp-bare';
        c.screening.reference_price_usd = {
          value: 45, unit: 'USD', matched_spec: true, target_variant_asin: 'B0SYNSP001',
          fulfillment_channel: 'FBA', sales_history_supported: true, evidence: ['synthetic-evidence'],
        };
        for (const sc of c.economics.scenarios) {
          sc.quote_id = 'q-sp-bare';
          sc.cost_ledger.cost_basis = 'bare_goods_1688';
          sc.cost_ledger.fx_cny_per_usd = 7.2;
          sc.cost_ledger.order_units = 100;
          sc.cost_ledger.multi_destination_headhaul_verified = true;
          sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
          const proc = sc.cost_ledger.lines.find(l => l.id === 'procurement');
          proc.amount_usd = Number((42 / 7.2).toFixed(6));
          proc.order_units = 100;
          proc.first_order_promotion = false;
          const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
          plc.amount_usd = 0;
          plc.split_option = 'amazon_optimized';
          plc.fee_basis = { ...(plc.fee_basis ?? {}), split_option: 'amazon_optimized' };
          const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
          hh.cny_derivation = {
            carton_count: 4, weight_per_carton_kg: cartonWtKg, carton_cm: [30, 30, 30],
            rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0,
          };
          hh.amount_usd = Number(((4 * cartonWtKg * 11) / 100 / 7.2).toFixed(6));
        }
        return c;
      };

      // (a) Heavier SP-API unit weight (2.0 lb = 0.907185 kg/unit > 0.60 kg/unit carton weight) updates headhaul cleanly AND preserves $0 placement
      // (b) Lighter SP-API unit weight (1.0 lb = 0.453592 kg/unit < 0.60 kg/unit carton weight) preserves supplier's heavier master-carton gross weight (60 kg)
      const ingHeavier = ingestTrialSpecification({
        profile_revision: 59, allow_synthetic_without_receipts: true, evidence: synthBatch.evidence,
        candidates: [{
          candidate: makeSpCand('cand-sp-heavier', 15),
          sp_api_calibration_inputs: {
            asin: 'B0SYNSP001', price_usd: 45,
            catalogItemRaw: {
              asin: 'B0SYNSP001',
              dimensions: [{ marketplaceId: 'ATVPDKIKX0DER', package: { length: { value: 10, unit: 'inches' }, width: { value: 8, unit: 'inches' }, height: { value: 3, unit: 'inches' }, weight: { value: 2.0, unit: 'pounds' } } }],
            },
          },
        }],
      }, r59Profile, { store: spStore });
      const lHeavier = ingHeavier.batch.candidates[0].economics.scenarios[0].cost_ledger;
      assert.equal(lHeavier.lines.find(l => l.id === 'placement').amount_usd, 0, 'SP-API calibration must preserve steady-state $0 amazon_optimized placement');
      const hhHeavierAmt = lHeavier.lines.find(l => l.id === 'headhaul').amount_usd;
      assert.ok(hhHeavierAmt > 1.35 && hhHeavierAmt < 1.42, `Expected SP-API 2.0 lb headhaul ~$1.386, got ${hhHeavierAmt}`);

      const ingLighter = ingestTrialSpecification({
        profile_revision: 59, allow_synthetic_without_receipts: true, evidence: synthBatch.evidence,
        candidates: [{
          candidate: makeSpCand('cand-sp-lighter', 15),
          sp_api_calibration_inputs: {
            asin: 'B0SYNSP001', price_usd: 45,
            catalogItemRaw: {
              asin: 'B0SYNSP001',
              dimensions: [{ marketplaceId: 'ATVPDKIKX0DER', package: { length: { value: 8, unit: 'inches' }, width: { value: 6, unit: 'inches' }, height: { value: 2, unit: 'inches' }, weight: { value: 1.0, unit: 'pounds' } } }],
            },
          },
        }],
      }, r59Profile, { store: spStore });
      const lLighter = ingLighter.batch.candidates[0].economics.scenarios[0].cost_ledger;
      assert.equal(lLighter.lines.find(l => l.id === 'placement').amount_usd, 0);
      const hhLighterAmt = lLighter.lines.find(l => l.id === 'headhaul').amount_usd;
      assert.ok(Math.abs(hhLighterAmt - ((60 * 11) / 100 / 7.2)) < 1e-6, `Lighter SP-API unit weight must not underbill 60 kg master carton ($0.9167), got ${hhLighterAmt}`);
    } finally {
      spStore.close();
    }

    // 2) Stage 3 runPhase2Batch (verifyStage3ContainerBindings) blocks [0,0] placement when cny_derivation has destination_scope:'us_west_single'
    const st3Db = join(dir, 'stage3-uswest.sqlite');
    const st3Store = openSelectionStore(st3Db);
    try {
      const kaiqiHh = { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
      const st3Est = estimateGate1A2027({
        pkg: STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04,
        fee_category: 'Home and Kitchen', referral_terms: REF_TERMS, collection_rate: 0.006,
        order_units: 100, headhaul: kaiqiHh, profile_revision: 59,
      });
      const st3FulUsd = st3Est.components.fulfillment.total_usd;
      const st3HhUsd = st3Est.components.headhaul.amount_usd;
      const st3Out = await runPhase2Batch(st3Store, {
        profile: r59Profile,
        as_of_date: '2026-11-26',
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-st3-usw', factory_id: 'fac-st3', observed_at: '2026-11-26T10:00:00Z',
            redacted_destination: '广东深圳', raw_readback_ref: 'rb://st3',
            goods_first_order_promotion: false, freight_first_order_promotion: false,
            fx_cny_per_usd: 7.2, pkg: STD_PKG,
            ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true },
            sku_lines: [{ component_id: 'unit', offer_id: 'o-s3', sku_id: 's-s3', factory_id: 'fac-st3', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true }],
            goods_cny_total: 4200, domestic_freight_cny_total: null,
          },
        }),
        deep_research_executor: async ({ form }) => {
          const batchCopy = structuredClone(synthBatch);
          const c = batchCopy.candidates[0];
          c.id = form.form_id;
          c.form_id = form.form_id;
          const sc = c.economics.scenarios[0];
          sc.id = 'sc-st3-usw';
          sc.quote_id = 'q-st3-usw';
          sc.cost_ledger.price_usd = 45;
          sc.cost_ledger.fx_cny_per_usd = 7.2;
          sc.cost_ledger.order_units = 100;
          sc.cost_ledger.cost_basis = 'bare_goods_1688';
          sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
          sc.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = Number((42 / 7.2).toFixed(6));
          sc.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = st3FulUsd;
          const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
          plc.amount_usd = 0;
          plc.split_option = 'amazon_optimized';
          plc.fee_basis = { ...(plc.fee_basis ?? {}), split_option: 'amazon_optimized' };
          const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
          hh.amount_usd = st3HhUsd;
          hh.cny_derivation = { ...kaiqiHh, destination_scope: 'us_west_single' };
          c.economics.scenarios = [sc];
          batchCopy.candidates = [c];
          return { batch: batchCopy };
        },
        items: [{
          leads: [{
            lead_id: 'lead-st3-usw', source_channel: 'reddit',
            source_ref: 'https://www.reddit.com/r/tools/comments/st3usw/',
            phrase_or_title: 'synthetic organizer', observed_at: '2026-11-26', disposition: 'product',
          }],
          form: { form_id: 'form-st3-usw', label: 'Stage 3 USW Guard', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] },
          gate1a_scenarios: [{
            id: 'sc-st3-usw', price_usd: 45, pkg: STD_PKG, fx_cny_per_usd: 7.2, order_units: 100,
            refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
            referral_terms: REF_TERMS, headhaul: kaiqiHh, collection_rate: 0.006, other_applicable_usd: 0,
          }],
          early_screen_builder: () => [{
            profile_revision: 59, id: 'sc-st3-usw', saleable_unit: '1 organizer',
            price_usd: 45, pkg: STD_PKG, fx_cny_per_usd: 7.2,
            order_units: 100, headhaul: kaiqiHh, refund_fraction: 0.04, physical_return_fraction: 0.04,
            return_threshold: 0.081, returns_processing_usd: 0, fee_category: 'Home and Kitchen',
            referral_terms: REF_TERMS, fulfillment_usd: st3FulUsd, placement_usd: 0,
            placement_split_option: 'amazon_optimized',
            storage: { cubic_feet_per_unit: (10 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...WIN_2027 },
            collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
          }],
        }],
      });
      const st3Entry = st3Out.gate2_3.find(x => x.form_id === 'form-st3-usw');
      assert.equal(st3Entry.status, 'gate2_3_error');
      assert.match(st3Entry.error, /US-West single-warehouse|us_west_single/i);
    } finally {
      st3Store.close();
    }

    // 3) Pending bare-goods card renders bare-goods labels, disclosure, stress cap label, AND mobile CSS --m4:"1688百套裸货"
    const pendingBareBatch = structuredClone(synthBatch);
    const pCand = pendingBareBatch.candidates[0];
    pendingBareBatch.candidates = [pCand];
    for (const sc of pCand.economics.scenarios) {
      sc.cost_ledger.cost_basis = 'bare_goods_1688';
      sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
      if (sc.cost_ledger.source_inputs) delete sc.cost_ledger.source_inputs.domestic_per_unit_cny;
      // Leave headhaul pending so activeLedgers is empty and card enters pending queue
      const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
      hh.status = 'pending';
      hh.amount_usd = null;
    }
    const stBareLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    stBareLedger.id = 'st-bare-1';
    stBareLedger.cost_basis = 'bare_goods_1688';
    stBareLedger.lines = stBareLedger.lines.filter(l => l.id !== 'domestic_freight');
    pCand.economics.stress_scenarios = [
      { id: 'st-bare-1', label: 'Promo Stress', cost_ledger: stBareLedger },
    ];

    const pScored = scoreBatch(pendingBareBatch, r59Profile);
    const pHtml = renderReport(pScored, pendingBareBatch, r59Profile);
    assert.ok(pHtml.includes('1688百套裸货'), 'Pending bare-goods card must render 1688百套裸货');
    assert.ok(pHtml.includes('保 30% 裸货封顶'), 'Pending bare-goods card hero must render 保 30% 裸货封顶');
    assert.ok(pHtml.includes('保30%裸货上限'), 'Stress scenario on bare-goods card must render 保30%裸货上限');
    assert.ok(pHtml.includes(EXPECTED_DISCLOSURE), 'Pending bare-goods card must render mandatory bare-goods disclosure');
    assert.ok(pHtml.includes('--m4:"1688百套裸货"'), 'Mobile CSS @container override must match bare-goods overview header');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
