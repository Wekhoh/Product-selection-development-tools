import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runPhase2Batch, runGate1AForForm, runGate1BForForm, applyPeerComparabilityRulings } from '../src/pipeline.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { replayBatchIntoStore } from '../src/history-import.mjs';
import { estimateGate1A2027, getFba2027RateTableSnapshot } from '../src/fba-calculator.mjs';
import { freezeEvidenceReviewPacket } from '../src/openai/evidence-review.mjs';
import { openOpenAiBudgetLedger, OpenAiClient } from '../src/openai/index.mjs';
import { renderReport } from '../src/report.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { buildEvergreen2027OffPeakEconomics } from '../src/raw-ingest.mjs';
import {
  DEFAULT_R59_UI_READBACK,
  REPO_ROOT,
  loadR59Profile,
  loadSyntheticBatch,
  makeActivatedTestBudgetDb,
  makeBatchErrorLine,
  makeBatchOutputLine,
  makeCapturingStreams,
  makeJsonResponse,
  makeStage4OrganizerTrayCandidate,
  runCliMem,
  withTempDirAsync,
} from './helpers/test-fixtures.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';

const r59Profile = loadR59Profile();
const syntheticFixture = loadSyntheticBatch();

test('Issue #8 (4C) SQLite E2E: runPhase2Batch binds DB spec_sha256 pre-score (enforces v1 ruling, blocks stale v1 ruling on v2) and matches export-report --verify-result with Gate-4 dispute', async () => {
  await withTempDirAsync('issue8-sqlite-e2e-', async dir => {
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
            ui_readback: DEFAULT_R59_UI_READBACK,
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

      const candV1Ruled = alignCand(applyPeerComparabilityRulings(baseCand, [
        { peer_asin: 'B0SYN8LOW1', status: 'pending_evidence', source: 'owner_db_check', reason: 'v1 待补证' },
      ]), 'q1688-i8-v1');
      delete candV1Ruled.spec_sha256;
      delete candV1Ruled.spec_version;
      const rV1 = await runPhase2Batch(store, { items: [buildItem(formV1, candV1Ruled, 'q1688-i8-v1')], profile: r59Profile, as_of_date: '2026-11-27' });
      assert.equal(rV1.gate2_3[0].status, 'evaluated');
      assert.equal(rV1.gate2_3[0].qualification.counts_toward_target, false);

      const formV2 = { ...formV1, saleable_set_composition: { components: [{ component_id: 'kit', qty_per_saleable_set: 1 }], set_count: 2 } };
      const candV2Stale = alignCand(applyPeerComparabilityRulings(baseCand, [
        { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_v1', reason: 'v1 excluded' },
        { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_v1', reason: 'v1 pending' },
      ]), 'q1688-i8-v2');
      const rV2 = await runPhase2Batch(store, { items: [buildItem(formV2, candV2Stale, 'q1688-i8-v2')], profile: r59Profile, as_of_date: '2026-11-27' });
      assert.equal(rV2.gate2_3[0].status, 'evaluated');
      assert.equal(rV2.gate2_3[0].qualification.counts_toward_target, true);

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
      const { stdout, stderr, getErr } = makeCapturingStreams();
      const exitCode = await runPhase2Cli([
        'export-report', '--db', dbPath, '--batch', bPath, '--profile', 'docs/design/reference-profile.r59.draft.json',
        '--output', outDir, '--verify-result', rGate4.gate2_3[0].batch_result_sha256,
      ], { stdout, stderr }, { codexReceiptDir: receiptDir, allowTestDoubleReceipts: true });
      assert.equal(exitCode, 0, getErr());
      assert.match(readFileSync(join(outDir, 'index.html'), 'utf8'), /复核提出异议/);
    } finally {
      if (store) store.close();
    }
  });
});

test('Issue #9 acceptance: separates system suggestion, owner-confirmed decision, and physical sample measurement end-to-end across CLI -> SQLite -> retrospective summary', async () => {
  await withTempDirAsync('issue9-cal-accept-', async dir => {
    const dbPath = join(dir, 'selection.sqlite');
    assert.equal((await runCliMem(['init', '--db', dbPath])).code, 0);

    const stInit = openSelectionStore(dbPath);
    const { form } = stInit.upsertCandidateForm({
      form_id: 'form-syn-cal-1',
      label: 'Synthetic Bamboo Desk Tray',
      buyer_task: 'Organize desktop accessories',
      saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }],
    });
    stInit.close();

    const t1 = '2026-11-26T09:00:00Z';
    const step1Path = join(dir, 'step1-system-suggest.json');
    writeFileSync(step1Path, JSON.stringify({
      records: [{
        form_id: form.form_id,
        batch_id: 'batch-syn-cal',
        system_verdict: 'sample',
        system_suggested_at: t1,
        core_85_range: [74, 78],
        supported_range: [88, 92],
        pre_ad_margin_range: [0.34, 0.38],
      }],
    }, null, 2));

    const r1 = await runCliMem(['calibration-track', '--db', dbPath, '--input', step1Path, '--summary']);
    assert.equal(r1.code, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout);
    assert.equal(j1.saved_count, 1);
    assert.equal(j1.saved[0].system_verdict, 'sample');
    assert.equal(j1.saved[0].system_suggested_at, t1);
    assert.equal(j1.saved[0].owner_decision, null);
    assert.equal(j1.saved[0].owner_decision_source, null);
    assert.equal(j1.saved[0].owner_decision_confirmed_at, null);
    assert.equal(j1.saved[0].sample_measured_pkg, null);
    assert.equal(j1.saved[0].sample_measured_at, null);
    assert.equal(j1.saved[0].recalculated_margin, null);
    assert.equal(j1.retrospective_summary.system_suggested_count, 1);
    assert.equal(j1.retrospective_summary.owner_confirmed_count, 0);
    assert.equal(j1.retrospective_summary.owner_acceptance_rate, null);
    assert.equal(j1.retrospective_summary.unconfirmed_or_legacy_unknown_count, 1);
    assert.equal(j1.retrospective_summary.sample_measured_realized_count, 0);

    const t2 = '2026-11-27T10:30:00Z';
    const step2Path = join(dir, 'step2-owner-hold.json');
    writeFileSync(step2Path, JSON.stringify({
      records: [{
        form_id: form.form_id,
        owner_decision: 'hold',
        owner_decision_confirmed_at: t2,
        owner_reason: '先等工厂补齐外箱与内托实拍，暂缓拿样。',
      }],
    }, null, 2));

    const r2 = await runCliMem(['calibration-track', '--db', dbPath, '--input', step2Path, '--confirm-owner']);
    assert.equal(r2.code, 0, r2.stderr);

    const rRead = await runCliMem(['calibration-track', '--db', dbPath, '--list', '--summary', '--batch-id', 'batch-syn-cal']);
    assert.equal(rRead.code, 0, rRead.stderr);
    const jRead = JSON.parse(rRead.stdout);
    assert.equal(jRead.count, 1);
    const rec2 = jRead.records[0];
    assert.equal(rec2.system_verdict, 'sample');
    assert.equal(rec2.system_suggested_at, t1);
    assert.equal(rec2.owner_decision, 'hold');
    assert.equal(rec2.owner_decision_source, 'owner_confirmed');
    assert.equal(rec2.owner_decision_confirmed_at, t2);
    assert.ok(Date.parse(rec2.system_suggested_at) < Date.parse(rec2.owner_decision_confirmed_at));
    assert.equal(rec2.sample_measured_pkg, null);
    assert.equal(rec2.sample_measured_at, null);
    assert.equal(rec2.recalculated_margin, null);

    const sum2 = jRead.retrospective_summary;
    assert.equal(sum2.system_suggested_count, 1);
    assert.equal(sum2.owner_confirmed_count, 1);
    assert.equal(sum2.owner_accepted_count, 0);
    assert.equal(sum2.owner_acceptance_rate, 0);
    assert.equal(sum2.owner_confirmed_by_decision.hold, 1);
    assert.equal(sum2.sample_measured_realized_count, 0);
    assert.equal(sum2.records_timeline[0].has_sample_measurement, false);

    const t3 = '2026-11-28T14:15:00Z';
    const step3Path = join(dir, 'step3-sample-measured.json');
    writeFileSync(step3Path, JSON.stringify({
      records: [{
        form_id: form.form_id,
        sample_measured_pkg: { length_in: 10.5, width_in: 6.2, height_in: 2.1, weight_lb: 1.45 },
        sample_measured_at: t3,
        sample_spec_ref: `spec:${form.spec_sha256.slice(0, 12)}`,
        recalculate_profit_spec: {
          price_usd: 45.00,
          goods_cny_per_unit: 62.00,
          domestic_freight_cny_per_unit: 2.00,
          fx_cny_per_usd: 7.20,
          headhaul_usd: 2.10,
        },
      }],
    }, null, 2));

    const r3 = await runCliMem(['calibration-track', '--db', dbPath, '--input', step3Path, '--as-of', '2026-11-28', '--summary']);
    assert.equal(r3.code, 0, r3.stderr);
    const j3 = JSON.parse(r3.stdout);
    const rec3 = j3.saved[0];
    assert.equal(rec3.system_verdict, 'sample');
    assert.equal(rec3.system_suggested_at, t1, 'Sample measurement must preserve original system_suggested_at');
    assert.equal(rec3.owner_decision, 'hold');
    assert.equal(rec3.owner_decision_source, 'owner_confirmed');
    assert.equal(rec3.owner_decision_confirmed_at, t2, 'Sample measurement must preserve original owner_decision_confirmed_at');
    assert.equal(rec3.sample_measured_at, t3);
    assert.equal(rec3.sample_spec_ref, `spec:${form.spec_sha256.slice(0, 12)}`);
    assert.deepEqual(rec3.pre_ad_margin_range, [0.34, 0.38], 'Original baseline pre_ad_margin_range must remain intact');
    assert.deepEqual(rec3.recalculated_margin.baseline_pre_ad_margin_range, [0.34, 0.38]);
    assert.equal(typeof rec3.recalculated_margin.margin, 'number');
    assert.ok(Date.parse(rec3.owner_decision_confirmed_at) < Date.parse(rec3.sample_measured_at));
    assert.equal(j3.retrospective_summary.sample_measured_realized_count, 1);

    const stRead = openSelectionStore(dbPath, { readOnly: true });
    try {
      const dbRow = stRead.getCalibrationTrackingForForm(form.form_id);
      assert.equal(dbRow.system_suggested_at, t1);
      assert.equal(dbRow.owner_decision_confirmed_at, t2);
      assert.equal(dbRow.sample_measured_at, t3);
      assert.equal(dbRow.sample_measured_pkg.weight_lb, 1.45);
    } finally {
      stRead.close();
    }
  });
});

test('Issue #9 anti-pollution: legacy_unknown & script_demo_excluded never inflate owner_acceptance_rate and cannot overwrite owner_confirmed decisions', async () => {
  await withTempDirAsync('issue9-cal-guard-', async dir => {
    const dbPath = join(dir, 'selection.sqlite');
    assert.equal((await runCliMem(['init', '--db', dbPath])).code, 0);

    const legacyIn = join(dir, 'legacy-import.json');
    writeFileSync(legacyIn, JSON.stringify({
      records: [
        { form_id: 'form-legacy-1', batch_id: 'b-mix', system_verdict: 'sample', owner_decision: 'sample_check', owner_reason: '旧导入未标来源' },
        { form_id: 'form-await-1', batch_id: 'b-mix', system_verdict: 'sample' },
      ],
    }, null, 2));
    const rLeg = await runCliMem(['calibration-track', '--db', dbPath, '--input', legacyIn]);
    assert.equal(rLeg.code, 0, rLeg.stderr);
    const jLeg = JSON.parse(rLeg.stdout);
    assert.equal(jLeg.saved.find(x => x.form_id === 'form-legacy-1').owner_decision_source, 'legacy_unknown');
    assert.equal(jLeg.saved.find(x => x.form_id === 'form-legacy-1').owner_decision_confirmed_at, null);
    assert.equal(jLeg.saved.find(x => x.form_id === 'form-await-1').owner_decision, null);

    const demoIn = join(dir, 'demo-import.json');
    writeFileSync(demoIn, JSON.stringify({
      records: [
        { form_id: 'form-demo-1', batch_id: 'b-mix', system_verdict: 'sample', owner_decision: 'sample_check', owner_reason: '脚本演练预填' },
      ],
    }, null, 2));
    const rDemo = await runCliMem(['calibration-track', '--db', dbPath, '--input', demoIn, '--exclude-demo']);
    assert.equal(rDemo.code, 0, rDemo.stderr);
    assert.equal(JSON.parse(rDemo.stdout).saved[0].owner_decision_source, 'script_demo_excluded');

    const confirmedIn = join(dir, 'owner-confirmed.json');
    writeFileSync(confirmedIn, JSON.stringify({
      records: [
        { form_id: 'form-real-accept', batch_id: 'b-mix', system_verdict: 'sample', owner_decision: 'sample_check', owner_reason: '利润与差异化确认，安排拿样' },
        { form_id: 'form-real-hold', batch_id: 'b-mix', system_verdict: 'sample', owner_decision: 'hold', owner_reason: '竞品稳态价待复核' },
      ],
    }, null, 2));
    const rConf = await runCliMem(['calibration-track', '--db', dbPath, '--input', confirmedIn, '--confirm-owner', '--summary', '--batch-id', 'b-mix']);
    assert.equal(rConf.code, 0, rConf.stderr);
    const sum = JSON.parse(rConf.stdout).retrospective_summary;
    assert.equal(sum.total_records, 5);
    assert.equal(sum.business_records_count, 4, 'Demo rows must be excluded before business counts');
    assert.equal(sum.system_suggested_count, 4);
    assert.equal(sum.owner_confirmed_count, 2);
    assert.equal(sum.owner_accepted_count, 1);
    assert.equal(sum.owner_acceptance_rate, 0.5);
    assert.equal(sum.unconfirmed_or_legacy_unknown_count, 2);
    assert.equal(sum.awaiting_owner_decision_count, 1);
    assert.equal(sum.legacy_unknown_decided_count, 1);
    assert.equal(sum.legacy_unknown_source_count, 1);
    assert.equal(sum.script_demo_excluded_count, 1);
    assert.equal(sum.owner_confirmed_count + sum.unconfirmed_or_legacy_unknown_count + sum.script_demo_excluded_count, sum.total_records);
    assert.equal(sum.sample_measured_realized_count, 0);

    const overwriteIn = join(dir, 'bad-overwrite.json');
    writeFileSync(overwriteIn, JSON.stringify({
      records: [
        { form_id: 'form-new-atomic', batch_id: 'b-mix', system_verdict: 'sample' },
        { form_id: 'form-real-hold', batch_id: 'b-mix', system_verdict: 'sample', owner_decision: 'sample_check' },
      ],
    }, null, 2));
    const rBadOverwrite = await runCliMem(['calibration-track', '--db', dbPath, '--input', overwriteIn]);
    assert.notEqual(rBadOverwrite.code, 0, 'Unconfirmed import must not overwrite owner_confirmed decision');

    const stCheck = openSelectionStore(dbPath, { readOnly: true });
    try {
      assert.equal(stCheck.getCalibrationTrackingForForm('form-real-hold').owner_decision, 'hold');
      assert.equal(stCheck.getCalibrationTrackingForForm('form-new-atomic'), null, 'Failed batch import must roll back atomically');
    } finally {
      stCheck.close();
    }

    const stWrite = openSelectionStore(dbPath);
    try {
      assert.throws(() => stWrite.upsertCalibrationTracking({
        form_id: 'form-bad-confirm',
        system_verdict: 'sample',
        owner_decision: 'pending_owner_review',
        owner_decision_source: 'owner_confirmed',
      }), /owner_confirmed/);
      assert.throws(() => stWrite.upsertCalibrationTracking({
        form_id: 'form-bad-ts',
        system_verdict: 'sample',
        owner_decision: 'hold',
        owner_decision_source: 'legacy_unknown',
        owner_decision_confirmed_at: '2026-11-27T12:00:00Z',
      }), /owner_decision_confirmed_at/);
      assert.throws(() => stWrite.upsertCalibrationTracking({
        form_id: 'form-empty-pkg',
        system_verdict: 'sample',
        sample_measured_pkg: {},
      }), /sample_measured_pkg/);
      assert.throws(() => stWrite.upsertCalibrationTracking({
        form_id: 'form-null-sample-ts',
        system_verdict: 'sample',
        sample_measured_at: '2026-11-27T12:00:00Z',
      }), /sample_measured_at/);
      assert.throws(() => stWrite.upsertCalibrationTracking({
        form_id: 'form-real-hold',
        owner_reason: '脚本无权覆盖主人确认理由',
      }), /owner_reason/);
    } finally {
      stWrite.close();
    }

    const reclassIn = join(dir, 'reclass-demo.json');
    writeFileSync(reclassIn, JSON.stringify({ records: [{ form_id: 'form-legacy-1' }] }, null, 2));
    const rReclass = await runCliMem(['calibration-track', '--db', dbPath, '--input', reclassIn, '--exclude-demo', '--summary', '--batch-id', 'b-mix']);
    assert.equal(rReclass.code, 0, rReclass.stderr);
    const sumAfterReclass = JSON.parse(rReclass.stdout).retrospective_summary;
    assert.equal(sumAfterReclass.script_demo_excluded_count, 2);
    assert.equal(sumAfterReclass.legacy_unknown_decided_count, 0);
    assert.equal(sumAfterReclass.legacy_unknown_source_count, 0);
    assert.equal(sumAfterReclass.system_suggested_count, 3);
    assert.equal(sumAfterReclass.owner_confirmed_count, 2);
    assert.equal(sumAfterReclass.owner_acceptance_rate, 0.5);
  });
});

test('Issue #9 migration: pre-PR SQLite DB reads safely read-only and migrates idempotently with legacy_unknown backfill', async () => {
  await withTempDirAsync('issue9-cal-migrate-', async dir => {
    const dbPath = join(dir, 'legacy-pre-issue9.sqlite');
    const stInit = openSelectionStore(dbPath);
    stInit.close();

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      DROP TABLE calibration_tracking;
      CREATE TABLE calibration_tracking (
        tracking_id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL,
        spec_version INTEGER NOT NULL DEFAULT 1,
        form_spec_sha256 TEXT,
        batch_id TEXT,
        system_verdict TEXT NOT NULL,
        core_85_range_json TEXT,
        supported_range_json TEXT,
        pre_ad_margin_range_json TEXT,
        owner_decision TEXT CHECK(owner_decision IS NULL OR owner_decision IN ('keep', 'drop', 'sample_check', 'hold', 'pending_owner_review')),
        owner_reason TEXT,
        sample_measured_pkg_json TEXT,
        recalculated_margin_json TEXT,
        calibration_note TEXT,
        near_miss_spot_check_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(form_id, spec_version)
      );
      INSERT INTO calibration_tracking (
        tracking_id, form_id, spec_version, batch_id, system_verdict,
        owner_decision, owner_reason, sample_measured_pkg_json, recalculated_margin_json, created_at, updated_at
      ) VALUES
        ('cal-leg-1', 'form-leg-1', 1, 'b-old', 'full_annual_qualifying', 'sample_check', '旧脚本写入', NULL, NULL, '2026-11-25T08:00:00Z', '2026-11-25T08:00:00Z'),
        ('cal-leg-2', 'form-leg-2', 1, 'b-old', 'sample_pending_qualifying', 'pending_owner_review', '待主人复核', NULL, NULL, '2026-11-25T08:05:00Z', '2026-11-25T08:05:00Z'),
        ('cal-leg-3', 'form-leg-3', 1, 'b-old', 'full_annual_qualifying', 'keep', '旧记录含实测', '{"length_in":10,"width_in":6,"height_in":2,"weight_lb":1.2}', '{"margin":0.36,"meets_30pct_floor":true}', '2026-11-25T08:10:00Z', '2026-11-25T09:00:00Z');
    `);
    rawDb.close();

    const rRo = await runCliMem(['calibration-track', '--db', dbPath, '--list', '--summary', '--batch-id', 'b-old']);
    assert.equal(rRo.code, 0, rRo.stderr);
    const jRo = JSON.parse(rRo.stdout);
    assert.equal(jRo.count, 3);
    assert.ok(jRo.records.every(r => r.owner_decision_source === 'legacy_unknown'));
    assert.ok(jRo.records.every(r => r.owner_decision_confirmed_at === null));
    assert.equal(jRo.retrospective_summary.owner_confirmed_count, 0);
    assert.equal(jRo.retrospective_summary.owner_acceptance_rate, null);
    assert.equal(jRo.retrospective_summary.unconfirmed_or_legacy_unknown_count, 3);
    assert.equal(jRo.retrospective_summary.legacy_unknown_source_count, 3);
    assert.equal(jRo.retrospective_summary.legacy_unknown_decided_count, 2);
    assert.equal(jRo.retrospective_summary.awaiting_owner_decision_count, 1);
    assert.equal(jRo.retrospective_summary.sample_measured_realized_count, 1);
    assert.equal(jRo.records.find(r => r.form_id === 'form-leg-1').system_suggested_at, null, 'Pre-PR unknown suggestion timestamp must stay null');
    assert.equal(jRo.records.find(r => r.form_id === 'form-leg-3').sample_measured_at, null, 'Pre-PR unknown measurement timestamp must stay null');

    const stMig1 = openSelectionStore(dbPath);
    const s1 = stMig1.getCalibrationRetrospectiveSummary({ batch_id: 'b-old' });
    const row1 = stMig1.getCalibrationTrackingForForm('form-leg-1');
    const row3 = stMig1.getCalibrationTrackingForForm('form-leg-3');
    stMig1.close();

    assert.equal(row1.system_suggested_at, null);
    assert.equal(row1.owner_decision_source, 'legacy_unknown');
    assert.equal(row1.owner_decision_confirmed_at, null);
    assert.equal(row1.sample_measured_at, null);
    assert.equal(row3.sample_measured_at, null);
    assert.equal(s1.owner_confirmed_count, 0);
    assert.equal(s1.sample_measured_realized_count, 1);

    const stMig2 = openSelectionStore(dbPath);
    const s2 = stMig2.getCalibrationRetrospectiveSummary({ batch_id: 'b-old' });
    stMig2.close();
    assert.deepEqual(s2, s1, 'Repeated migration opens must be strictly idempotent');
  });
});

test('Issue #9 Round-1 Astra regressions (#1-#12): margin SSOT, email PII, stale margin invalidation, verdict-aware acceptance, demo/scope/baseline isolation & legacy compat', async () => {
  await withTempDirAsync('issue9-r1-reg-', async dir => {
    const ghostDb = join(dir, 'should-not-exist.sqlite');
    assert.notEqual((await runCliMem(['calibration-track', '--db', ghostDb, '--confirm-owner', '--exclude-demo'])).code, 0);
    assert.notEqual((await runCliMem(['calibration-track', '--db', ghostDb, '--list', '--as-of', 'not-a-date'])).code, 0);
    assert.equal(existsSync(ghostDb), false, 'Invalid calibration-track flags must fail before creating SQLite file');

    const dbPath = join(dir, 'reg.sqlite');
    assert.equal((await runCliMem(['init', '--db', dbPath])).code, 0);

    const st = openSelectionStore(dbPath);
    try {
      const pkg = { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 };
      st.upsertCalibrationTracking({ form_id: 'f-m1', batch_id: 'b-m', system_verdict: 'sample', sample_measured_pkg: pkg, recalculated_margin: { margin: 0.18, meets_30pct_floor: true } });
      st.upsertCalibrationTracking({ form_id: 'f-m2', batch_id: 'b-m', system_verdict: 'sample', sample_measured_pkg: pkg, recalculated_margin: { pre_ad_margin: 0.36 } });
      st.upsertCalibrationTracking({ form_id: 'f-m3', batch_id: 'b-m', system_verdict: 'sample', sample_measured_pkg: pkg, recalculated_margin: { pre_ad_margin_range: [0.35, 0.40] } });
      st.upsertCalibrationTracking({ form_id: 'f-recalc-only', batch_id: 'b-m', system_verdict: 'sample', recalculated_margin: { margin: 0.38 } });
      const sumM = st.getCalibrationRetrospectiveSummary({ batch_id: 'b-m' });
      assert.equal(sumM.sample_recalculated_meets_30pct_count, 2, 'Numeric margin must override stale meets_30pct_floor=true and honor pre_ad_margin + range');
      assert.equal(sumM.sample_physical_measured_count, 3);
      assert.equal(sumM.sample_recalculated_count, 4);
      const roRec = sumM.records_timeline.find(r => r.form_id === 'f-recalc-only');
      assert.equal(roRec.has_sample_measurement, false);
      assert.equal(roRec.has_recalculated_margin, true);
      assert.equal(roRec.sample_measured_at, null);

      assert.throws(() => st.upsertCalibrationTracking({
        form_id: 'f-email',
        system_verdict: 'sample',
        sample_spec_ref: 'contact: supplier@example-factory.com',
      }), /email/i);
      st.db.prepare("UPDATE calibration_tracking SET sample_spec_ref = 'legacy supplier@example-factory.com' WHERE form_id = 'f-m1'").run();
      const scrubbed = st.getCalibrationRetrospectiveSummary({ form_id: 'f-m1' });
      assert.equal(JSON.stringify(scrubbed).includes('supplier@example-factory.com'), false);
      assert.match(scrubbed.records_timeline[0].sample_spec_ref, /\[REDACTED_EMAIL\]/);

      st.upsertCalibrationTracking({ form_id: 'f-excl', batch_id: 'b-v', system_verdict: 'hard_excluded', owner_decision: 'keep', owner_decision_source: 'owner_confirmed' });
      st.upsertCalibrationTracking({ form_id: 'f-chg', batch_id: 'b-v', system_verdict: 'sample', owner_decision: 'sample_check', owner_decision_source: 'owner_confirmed' });
      st.upsertCalibrationTracking({ form_id: 'f-chg', batch_id: 'b-v', system_verdict: 'hard_excluded' });
      const sumV = st.getCalibrationRetrospectiveSummary({ batch_id: 'b-v' });
      assert.equal(sumV.owner_acceptance_rate, null, 'keep on hard_excluded & stale verdict confirmation must never inflate acceptance rate');
      assert.equal(sumV.verdict_x_decision.hard_excluded.keep, 1);
      assert.equal(sumV.owner_confirmed_stale_verdict_count, 1);

      st.upsertCalibrationTracking({ form_id: 'f-demo-null', batch_id: 'b-d', system_verdict: 'sample', owner_decision_source: 'script_demo_excluded', sample_measured_pkg: pkg, recalculated_margin: { margin: 0.42 } });
      st.upsertCalibrationTracking({ form_id: 'f-demo-null', batch_id: 'b-d', system_verdict: 'sample', owner_decision: 'sample_check' });
      assert.equal(st.getCalibrationTrackingForForm('f-demo-null').owner_decision_source, 'script_demo_excluded');
      const sumD = st.getCalibrationRetrospectiveSummary({ batch_id: 'b-d' });
      assert.equal(sumD.script_demo_excluded_count, 1);
      assert.equal(sumD.system_suggested_count, 0);
      assert.equal(sumD.sample_measured_realized_count, 0);
      assert.equal(sumD.sample_recalculated_meets_30pct_count, 0);

      st.upsertCalibrationTracking({ form_id: 'f-demo-null', owner_decision: 'hold', owner_decision_source: 'owner_confirmed' });
      assert.equal(st.getCalibrationTrackingForForm('f-demo-null').owner_reason, null);
      assert.throws(() => st.upsertCalibrationTracking({ form_id: 'f-demo-null', owner_decision_confirmed_at: '2026-11-27T12:00:00Z' }), /owner_confirmed/);

      const { form: fV1 } = st.upsertCandidateForm({ form_id: 'f-ver', label: 'V1', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'a', qty_per_saleable_set: 1 }] });
      st.upsertCalibrationTracking({ form_id: 'f-ver', spec_version: 1, system_verdict: 'sample', pre_ad_margin_range: [0.70, 0.72] });
      const { form: fV2 } = st.upsertCandidateForm({ form_id: 'f-ver', label: 'V2', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'a', qty_per_saleable_set: 2 }] });
      assert.equal(fV2.spec_version, 2);
      const backV1 = st.upsertCalibrationTracking({ form_id: 'f-ver', spec_version: 1, sample_measured_pkg: pkg });
      assert.notEqual(backV1.sample_spec_ref, fV2.spec_sha256, 'v1 backfill must not stamp v2 spec_sha256');
      assert.equal(backV1.form_spec_sha256, fV1.spec_sha256);
    } finally {
      st.close();
    }

    const fPkg1 = join(dir, 'pkg1.json');
    writeFileSync(fPkg1, JSON.stringify({
      records: [{
        form_id: 'f-ver', spec_version: 2, batch_id: 'b-cli', system_verdict: 'sample', pre_ad_margin_range: null,
        sample_measured_pkg: { length_in: 10, width_in: 6, height_in: 2, weight_oz: 20 },
        recalculate_profit_spec: { price_usd: 45, goods_cny_per_unit: 60, domestic_freight_cny_per_unit: 2, fx_cny_per_usd: 7.2, headhaul_usd: 2.0 },
      }],
    }));
    const rPkg1 = await runCliMem(['calibration-track', '--db', dbPath, '--input', fPkg1, '--as-of', '2026-11-27']);
    assert.equal(rPkg1.code, 0, rPkg1.stderr);
    const jPkg1 = JSON.parse(rPkg1.stdout);
    assert.equal(jPkg1.saved[0].recalculated_margin.baseline_pre_ad_margin_range, undefined, 'v2 must not inherit v1 70-72% baseline');
    assert.equal(jPkg1.saved[0].recalculated_margin.meets_30pct_floor, true);

    const fPkg2 = join(dir, 'pkg2-missing-fx.json');
    writeFileSync(fPkg2, JSON.stringify({
      records: [{
        form_id: 'f-ver', spec_version: 2,
        sample_measured_pkg: { length_in: 12, width_in: 9, height_in: 5, weight_g: 1928 },
        recalculate_profit_spec: { price_usd: 45, goods_cny_per_unit: 60, headhaul_usd: 2.0 },
      }],
    }));
    const rPkg2 = await runCliMem(['calibration-track', '--db', dbPath, '--input', fPkg2]);
    assert.equal(rPkg2.code, 0, rPkg2.stderr);
    const jPkg2 = JSON.parse(rPkg2.stdout);
    assert.equal(jPkg2.saved[0].recalculated_margin, null, 'Changed pkg with failed recalc must invalidate stale margin');
    assert.equal(jPkg2.recalculation_pending[0].reason, 'incomplete_recalculate_profit_spec');

    const fPkg3 = join(dir, 'pkg3-fill-fx.json');
    writeFileSync(fPkg3, JSON.stringify({
      records: [{
        form_id: 'f-ver', spec_version: 2, recalculated_margin: null,
        recalculate_profit_spec: { price_usd: 45, goods_cny_per_unit: 60, domestic_freight_cny_per_unit: 2, fx_cny_per_usd: 7.2, headhaul_usd: 2.0 },
      }],
    }));
    const rPkg3 = await runCliMem(['calibration-track', '--db', dbPath, '--input', fPkg3]);
    assert.equal(rPkg3.code, 0, rPkg3.stderr);
    assert.ok(typeof JSON.parse(rPkg3.stdout).saved[0].recalculated_margin.margin === 'number');

    const fLegPh = join(dir, 'legacy-placeholder.json');
    writeFileSync(fLegPh, JSON.stringify({
      records: [{ form_id: 'f-leg-ph', batch_id: 'b-cli', system_verdict: 'sample', recalculated_margin: { size_tier: 'Small Standard', margin: null, margin_pct: null, meets_30pct_floor: null } }],
    }));
    const rLegPh = await runCliMem(['calibration-track', '--db', dbPath, '--input', fLegPh]);
    assert.equal(rLegPh.code, 0, rLegPh.stderr);
    assert.equal(JSON.parse(rLegPh.stdout).saved[0].recalculated_margin, null);

    const fScope = join(dir, 'scope-mixed.json');
    writeFileSync(fScope, JSON.stringify({
      records: [
        { form_id: 'f-scope-a', batch_id: 'b-a', system_verdict: 'sample', owner_decision: 'sample_check' },
        { form_id: 'f-scope-b', batch_id: 'b-b', system_verdict: 'sample', owner_decision: 'sample_check' },
      ],
    }));
    assert.notEqual((await runCliMem(['calibration-track', '--db', dbPath, '--input', fScope, '--confirm-owner', '--form', 'f-scope-a', '--batch-id', 'b-a'])).code, 0);
    const fMalformed = join(dir, 'malformed.json');
    writeFileSync(fMalformed, JSON.stringify({ records: [{ form_id: 'f-ok', system_verdict: 'sample' }, 'not-an-object'] }));
    assert.notEqual((await runCliMem(['calibration-track', '--db', dbPath, '--input', fMalformed])).code, 0);
  });
});

test('Batch A3.1: real CLI openai-batch-build -> openai-batch-poll submit -> GET recovery -> out-of-order custom_id alignment', async () => {
  await withTempDirAsync('batch-a3-cli-e2e-', async dir => {
    const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir);
    const itemsPath = join(dir, 'items.json');
    const jsonlPath = join(dir, 'batch.jsonl');
    const submitOutPath = join(dir, 'submit-out.json');

    writeFileSync(itemsPath, JSON.stringify({
      items: [
        {
          custom_id: 'lead-alpha',
          input: {
            platform: 'reddit',
            observed_at: '2026-11-27',
            event_dedup_key: 'reddit-syn-1',
            source_url: 'https://example.com/r/hobby/1',
            source_ref: 'reddit:syn-1',
            post_text: 'Looking for a solid wood desktop paint rack organizer for 1oz bottles.',
          },
        },
        {
          custom_id: 'lead-beta',
          input: {
            platform: 'pinterest',
            observed_at: '2026-11-27',
            event_dedup_key: 'pinterest-syn-2',
            source_url: 'https://example.com/pin/2',
            source_ref: 'pinterest:syn-2',
            post_text: 'Need a compact bamboo drawer tray with removable dividers for craft tools.',
          },
        },
      ],
    }, null, 2));

    const buildRes = await runCliMem([
      'openai-batch-build',
      '--task', 'social-bridge',
      '--input', itemsPath,
      '--output', jsonlPath,
    ]);
    assert.equal(buildRes.code, 0, buildRes.stderr);
    const builtMeta = JSON.parse(buildRes.stdout);
    assert.equal(builtMeta.line_count, 2);
    assert.deepEqual(builtMeta.custom_ids, ['lead-alpha', 'lead-beta']);

    let postFilesCount = 0;
    let postBatchesCount = 0;
    let getBatchCount = 0;
    let getFileContentCount = 0;
    let remoteBatchPhase = 'in_progress';

    const mockFetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'POST' && u.endsWith('/v1/files')) {
        postFilesCount += 1;
        return makeJsonResponse(200, { id: 'file_syn_up_01', object: 'file', purpose: 'batch' });
      }
      if (method === 'POST' && u.endsWith('/v1/batches')) {
        postBatchesCount += 1;
        const body = JSON.parse(String(init.body));
        assert.equal(body.input_file_id, 'file_syn_up_01');
        assert.equal(body.endpoint, '/v1/responses');
        return makeJsonResponse(200, {
          id: 'batch_syn_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_syn_up_01',
          status: 'validating',
        });
      }
      if (method === 'GET' && u.endsWith('/v1/batches/batch_syn_01')) {
        getBatchCount += 1;
        if (remoteBatchPhase === 'in_progress') {
          return makeJsonResponse(200, {
            id: 'batch_syn_01',
            object: 'batch',
            endpoint: '/v1/responses',
            input_file_id: 'file_syn_up_01',
            status: 'in_progress',
            request_counts: { total: 2, completed: 1, failed: 0 },
          });
        }
        return makeJsonResponse(200, {
          id: 'batch_syn_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_syn_up_01',
          output_file_id: 'file_syn_out_01',
          error_file_id: null,
          status: 'completed',
          request_counts: { total: 2, completed: 2, failed: 0 },
        });
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_syn_out_01/content')) {
        getFileContentCount += 1;
        const alphaJson = JSON.stringify({
          schema_version: 1,
          contract: 'SocialBridgeExtractor',
          status: 'extracted',
          platform: 'reddit',
          source_url: 'https://example.com/r/hobby/1',
          source_ref: 'reddit:syn-1',
          observed_at: '2026-11-27',
          event_dedup_key: 'reddit-syn-1',
          verbatim_excerpt: 'solid wood desktop paint rack organizer for 1oz bottles',
          buyer_task: 'organize paint bottles',
          candidate_phrases: ['wood paint rack organizer'],
          notes: 'synthetic alpha',
        });
        const betaJson = JSON.stringify({
          schema_version: 1,
          contract: 'SocialBridgeExtractor',
          status: 'extracted',
          platform: 'pinterest',
          source_url: 'https://example.com/pin/2',
          source_ref: 'pinterest:syn-2',
          observed_at: '2026-11-27',
          event_dedup_key: 'pinterest-syn-2',
          verbatim_excerpt: 'compact bamboo drawer tray with removable dividers for craft tools',
          buyer_task: 'organize craft tools',
          candidate_phrases: ['bamboo drawer tray'],
          notes: 'synthetic beta',
        });
        return makeJsonResponse(200, `${makeBatchOutputLine('lead-beta', betaJson)}\n${makeBatchOutputLine('lead-alpha', alphaJson)}\n`);
      }
      throw new Error(`Unexpected mock fetch: ${method} ${u}`);
    };

    const hooks = {
      testLedgerOptions: ledgerOpts,
      openAiClientOptions: { testMode: true, fetchImpl: mockFetch, baseUrl: 'https://api.openai.com' },
    };

    const submitRes = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--submit-jsonl', jsonlPath,
      '--output', submitOutPath,
    ], hooks);
    assert.equal(submitRes.code, 0, submitRes.stderr);
    assert.equal(postFilesCount, 1);
    assert.equal(postBatchesCount, 1);
    const submitPayload = JSON.parse(readFileSync(submitOutPath, 'utf8'));
    assert.equal(submitPayload.mode, 'submitted');
    assert.equal(submitPayload.input_file_id, 'file_syn_up_01');
    assert.equal(submitPayload.file_id, 'file_syn_up_01');
    assert.equal(submitPayload.batch_id, 'batch_syn_01');
    assert.equal(submitPayload.batch_status, 'validating');
    assert.equal(submitPayload.request_count, 2);
    assert.ok(submitPayload.attempt_id);
    assert.equal(submitPayload.receipt.provider_response_id, 'batch_syn_01');

    const retrySubmitRes = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--submit-jsonl', jsonlPath,
    ], hooks);
    assert.equal(postFilesCount, 1, 'Second entry must NEVER re-upload file');
    assert.equal(postBatchesCount, 1, 'Second entry must NEVER re-POST /v1/batches');
    assert.equal(getBatchCount, 1);
    const retrySubmitPayload = JSON.parse(retrySubmitRes.stdout);
    assert.equal(retrySubmitPayload.mode, 'recovered_existing_batch');
    assert.equal(retrySubmitPayload.batch_id, 'batch_syn_01');
    assert.equal(retrySubmitPayload.batch_status, 'in_progress');

    remoteBatchPhase = 'completed';
    const pollRes = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--batch-id', 'batch_syn_01',
      '--download-output',
    ], hooks);
    assert.equal(pollRes.code, 0, pollRes.stderr);
    assert.equal(postFilesCount, 1);
    assert.equal(postBatchesCount, 1);
    assert.equal(getFileContentCount, 1);
    const pollPayload = JSON.parse(pollRes.stdout);
    assert.equal(pollPayload.mode, 'polled');
    assert.equal(pollPayload.batch_id, 'batch_syn_01');
    assert.equal(pollPayload.batch_status, 'completed');
    assert.equal(pollPayload.parsed_output_count, 2);
    assert.equal(pollPayload.parsed_output.total_lines, 2);
    assert.deepEqual(
      pollPayload.reconciliation.items.map(i => i.custom_id),
      ['lead-alpha', 'lead-beta'],
      'Out-of-order Batch responses must align to submitted manifest custom_id order',
    );
    assert.match(pollPayload.reconciliation.by_custom_id['lead-alpha'].output_text, /wood paint rack/);
    assert.match(pollPayload.reconciliation.by_custom_id['lead-beta'].output_text, /bamboo drawer tray/);
    assert.equal(pollPayload.receipt.status, 'completed');
    assert.ok(pollPayload.receipt.usage_cost_micros > 0);

    const settledPoll = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--batch-id', 'batch_syn_01',
    ], hooks);
    assert.equal(settledPoll.code, 0, settledPoll.stderr);
    assert.equal(JSON.parse(settledPoll.stdout).already_settled, true);
  });
});

test('Batch A3.1b: partial success + error_file_id reconciliation, expired partial output, and unknown submission 0-duplicate-POST guard', async () => {
  await withTempDirAsync('batch-a3-partial-', async dir => {
    const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir);

    const writeRawBatchJsonl = (filename, customIds) => {
      const fp = join(dir, filename);
      const lines = customIds.map(cid => JSON.stringify({
        custom_id: cid,
        method: 'POST',
        url: '/v1/responses',
        body: { model: 'gpt-6.1-terra', input: `Synthetic task for ${cid}` },
      }));
      writeFileSync(fp, `${lines.join('\n')}\n`, 'utf8');
      return fp;
    };

    const partialJsonl = writeRawBatchJsonl('partial.jsonl', ['cid-1', 'cid-2', 'cid-3']);
    const expiredJsonl = writeRawBatchJsonl('expired.jsonl', ['exp-1', 'exp-2', 'exp-3']);
    const ambigJsonl = writeRawBatchJsonl('ambig.jsonl', ['amb-1']);

    let mode = 'partial';
    const postCounts = { files: 0, batches: 0 };

    const mockFetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      const u = String(url);
      if (method === 'POST' && u.endsWith('/v1/files')) {
        postCounts.files += 1;
        return makeJsonResponse(200, { id: `file_up_${mode}`, object: 'file', purpose: 'batch' });
      }
      if (method === 'POST' && u.endsWith('/v1/batches')) {
        postCounts.batches += 1;
        if (mode === 'ambig') {
          throw new Error('Simulated network disconnect during POST /v1/batches');
        }
        return makeJsonResponse(200, {
          id: `batch_${mode}_01`,
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: `file_up_${mode}`,
          status: 'validating',
        });
      }
      if (method === 'GET' && u.endsWith('/v1/batches/batch_partial_01')) {
        return makeJsonResponse(200, {
          id: 'batch_partial_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_up_partial',
          output_file_id: 'file_out_partial',
          error_file_id: 'file_err_partial',
          status: 'completed',
          request_counts: { total: 3, completed: 2, failed: 1 },
        });
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_out_partial/content')) {
        return makeJsonResponse(200, `${makeBatchOutputLine('cid-3', 'ok-3')}\n${makeBatchOutputLine('cid-1', 'ok-1')}\n`);
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_err_partial/content')) {
        return makeJsonResponse(200, `${makeBatchErrorLine('cid-2', 'Upstream rate limit')}\n`);
      }
      if (method === 'GET' && u.endsWith('/v1/batches/batch_expired_01')) {
        return makeJsonResponse(200, {
          id: 'batch_expired_01',
          object: 'batch',
          endpoint: '/v1/responses',
          input_file_id: 'file_up_expired',
          output_file_id: 'file_out_expired',
          error_file_id: 'file_err_expired',
          status: 'expired',
          request_counts: { total: 3, completed: 1, failed: 1 },
        });
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_out_expired/content')) {
        return makeJsonResponse(200, `${makeBatchOutputLine('exp-1', 'ok-exp-1')}\n`);
      }
      if (method === 'GET' && u.endsWith('/v1/files/file_err_expired/content')) {
        return makeJsonResponse(200, `${makeBatchErrorLine('exp-2', 'Item failed before expiry', 500)}\n`);
      }
      throw new Error(`Unexpected fetch: ${method} ${u}`);
    };

    const hooks = {
      testLedgerOptions: ledgerOpts,
      openAiClientOptions: { testMode: true, fetchImpl: mockFetch, baseUrl: 'https://api.openai.com' },
    };

    mode = 'partial';
    const subPartial = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', partialJsonl,
    ], hooks);
    assert.equal(subPartial.code, 0, subPartial.stderr);

    const pollPartial = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath,
      '--batch-id', 'batch_partial_01', '--download-output',
    ], hooks);
    assert.equal(pollPartial.code, 2, 'Partial batch with error_file_id stays fenced for reconciliation');
    const partialOut = JSON.parse(pollPartial.stdout);
    assert.equal(partialOut.parsed_output_count, 2);
    assert.equal(partialOut.parsed_error_count, 1);
    assert.deepEqual(partialOut.reconciliation.items.map(i => i.custom_id), ['cid-1', 'cid-2', 'cid-3']);
    assert.equal(partialOut.reconciliation.by_custom_id['cid-1'].output_text, 'ok-1');
    assert.equal(partialOut.reconciliation.by_custom_id['cid-1'].source_file, 'output_file');
    assert.equal(partialOut.reconciliation.by_custom_id['cid-2'].source_file, 'error_file');
    assert.match(partialOut.reconciliation.by_custom_id['cid-2'].error, /Upstream rate limit/);
    assert.equal(partialOut.reconciliation.by_custom_id['cid-3'].output_text, 'ok-3');
    assert.equal(partialOut.reconciliation.partial_success, true);
    assert.ok(partialOut.reconciliation.known_usage_cost_micros > 0);
    assert.equal(partialOut.reconciliation.has_unknown_usage, true);
    assert.equal(partialOut.fenced, true);
    assert.equal(partialOut.receipt.status, 'pending_recovery');

    mode = 'expired';
    const subExpired = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', expiredJsonl,
    ], hooks);
    assert.equal(subExpired.code, 0, subExpired.stderr);

    const pollExpired = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath,
      '--batch-id', 'batch_expired_01', '--download-output',
    ], hooks);
    assert.equal(pollExpired.code, 2);
    const expiredOut = JSON.parse(pollExpired.stdout);
    assert.equal(expiredOut.batch_status, 'expired');
    assert.equal(expiredOut.parsed_output_count, 1);
    assert.equal(expiredOut.parsed_error_count, 1);
    assert.deepEqual(expiredOut.reconciliation.missing_custom_ids, ['exp-3']);
    assert.equal(expiredOut.reconciliation.by_custom_id['exp-1'].usable, true);
    assert.equal(expiredOut.reconciliation.by_custom_id['exp-2'].source_file, 'error_file');
    assert.equal(expiredOut.reconciliation.by_custom_id['exp-3'].status, 'expired');
    assert.ok(expiredOut.reconciliation.known_usage_cost_micros > 0);
    assert.equal(expiredOut.reconciliation.has_unknown_usage, true);

    mode = 'ambig';
    const beforeFiles = postCounts.files;
    const beforeBatches = postCounts.batches;
    const ambigFirst = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', ambigJsonl,
    ], hooks);
    assert.equal(ambigFirst.code, 2);
    assert.equal(postCounts.files, beforeFiles + 1);
    assert.equal(postCounts.batches, beforeBatches + 1);

    const ambigSecond = await runCliMem([
      'openai-batch-poll', '--db', dbPath, '--credential-file', credPath, '--submit-jsonl', ambigJsonl,
    ], hooks);
    assert.equal(ambigSecond.code, 2);
    assert.equal(postCounts.files, beforeFiles + 1, 'Second entry on unknown submission MUST NOT re-POST /v1/files');
    assert.equal(postCounts.batches, beforeBatches + 1, 'Second entry on unknown submission MUST NOT re-POST /v1/batches');
    const ambigSecondPayload = JSON.parse(ambigSecond.stdout);
    assert.equal(ambigSecondPayload.mode, 'pending_recovery_blocked');
    assert.equal(ambigSecondPayload.duplicate_post_prevented, true);
    assert.equal(ambigSecondPayload.input_file_id, 'file_up_ambig');
    assert.equal(ambigSecondPayload.batch_id, null);
    assert.equal(ambigSecondPayload.receipt.status, 'pending_recovery');
  });
});

test('Batch A3.2: resume_skip_completed recomputes on new quote, new #8 ruling, or fee-table change while skipping truly unchanged candidates', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const formDef = {
      form_id: 'form-a3-resume-test',
      label: '桌面收纳盒＋可拆托盘',
      buyer_task: 'Desktop organizer with removable tray',
      saleable_set_composition: { components: [{ component_id: 'kit', qty_per_saleable_set: 1 }], set_count: 1 },
    };
    const { form: f1 } = store.upsertCandidateForm(formDef);
    const fx = 7.0;
    const salesWin = { from: '2027-02-01', through: '2027-10-14' };
    const storageWin = { from: '2027-02-01', through: '2027-09-30' };
    const inboundWin = { from: '2027-01-20', through: '2027-02-01' };

    const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
      id: formDef.form_id,
      specSha256: f1.spec_sha256,
      specVersion: f1.spec_version,
    });
    const hhUsd = baseCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul').amount_usd;

    const g1aScens = baseCand.economics.scenarios.map(sc => ({
      id: sc.id,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
      price_usd: sc.cost_ledger.price_usd,
      fx_cny_per_usd: fx,
      refund_fraction: 0.02,
      physical_return_fraction: 0.02,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
      headhaul_usd: hhUsd,
      collection_rate: 0.006,
      sales_window: salesWin,
      storage_window: storageWin,
      inbound_window: inboundWin,
      is_apparel: false,
      is_dangerous_goods: false,
      is_sipp: false,
    }));
    const rawEst = estimateGate1A2027(g1aScens[0]);
    const cachedEst = {
      fulfillment_usd: rawEst.components.fulfillment.total_usd,
      placement_usd: rawEst.components.placement.selected_usd,
      storage_usd: rawEst.components.storage.per_unit_usd,
    };

    const makeQuoteRow = (quoteId, factoryId, unitGoodsCny) => ({
      quote_id: quoteId,
      factory_id: factoryId,
      spec_variant_key: 'kit-std',
      form_id: formDef.form_id,
      spec_version: f1.spec_version,
      observed_at: '2026-11-27',
      expires_at: null,
      redacted_destination: '广东深圳',
      raw_readback_ref: `rb-${quoteId}`,
      ui_readback: DEFAULT_R59_UI_READBACK,
      require_ui_readback: true,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{
        offer_id: `off-${quoteId}`,
        sku_id: 'kit',
        component_id: 'kit',
        qty_per_saleable_set: 1,
        pack_multiple: 1,
        moq_qty: 100,
        ordered_qty: 100,
        unit_price_cny: unitGoodsCny,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: Math.round(unitGoodsCny * 100 * 100) / 100,
      domestic_freight_cny_total: 100,
    });

    const buildAlignedCand = (quoteId, unitGoodsCny) => {
      const cand = structuredClone(baseCand);
      for (const s of cand.economics.scenarios) {
        s.quote_id = quoteId;
        s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
        s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: quoteId, fx_cny_per_usd: fx };
        for (const l of s.cost_ledger.lines) {
          if (l.id === 'procurement') {
            l.fx_cny_per_usd = fx;
            l.order_units = 100;
            l.amount_usd = Number((unitGoodsCny / fx).toFixed(6));
          }
          if (l.id === 'domestic_freight') {
            l.fx_cny_per_usd = fx;
            l.order_units = 100;
            l.amount_usd = Number((1 / fx).toFixed(6));
          }
          if (l.id === 'fulfillment') l.amount_usd = cachedEst.fulfillment_usd;
          if (l.id === 'placement') l.amount_usd = cachedEst.placement_usd;
          if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, cachedEst.storage_usd);
        }
        const r = s.cost_ledger.refund_fraction ?? 0.04;
        const nonCol = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
          .reduce((sum, lid) => sum + (s.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
        const colLine = s.cost_ledger.lines.find(l => l.id === 'collection');
        if (colLine) {
          colLine.amount_usd = Number((Math.max(0, s.cost_ledger.price_usd * (1 - r) - nonCol) * (s.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
        }
      }
      return cand;
    };

    store.recordSourcingQuotesBatch1688([makeQuoteRow('q-a3-1', 'fac-a3-1', 63)]);

    let deepResearchCalls = 0;
    const makeBatchItem = ({ quoteId, unitGoodsCny, peerRulings = null }) => {
      const cand = buildAlignedCand(quoteId, unitGoodsCny);
      return {
        form: formDef,
        leads: [{
          lead_id: 'lead-a3-1',
          source_channel: 'reddit',
          source_ref: 'https://example.com/r/a3',
          phrase_or_title: 'organizer tray',
          observed_at: '2026-11-27',
          disposition: 'product',
        }],
        gate1a_scenarios: g1aScens,
        ...(peerRulings ? { peer_comparability_rulings: peerRulings } : {}),
        early_screen_builder: ({ quote }) => {
          const unitCny = Number(quote.goods_cny_total) / Number(quote.actual_complete_sets);
          return g1aScens.map(g => ({
            profile_revision: 59,
            id: g.id,
            saleable_unit: '1 complete set',
            price_usd: g.price_usd,
            fx_cny_per_usd: fx,
            order_units: 100,
            goods_cny_per_unit: unitCny,
            domestic_freight_cny_per_unit: 1,
            first_order_promotion: false,
            goods_first_order_promotion: false,
            headhaul: { usd_per_unit: hhUsd, bond_included: true },
            refund_fraction: 0.02,
            physical_return_fraction: 0.02,
            return_threshold: 0.08,
            returns_processing_usd: 0,
            is_apparel_or_shoes: false,
            referral_terms: g.referral_terms,
            fulfillment_usd: cachedEst.fulfillment_usd,
            placement_usd: cachedEst.placement_usd,
            storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWin, storage: storageWin, inbound: inboundWin },
            collection_rate: 0.006,
            other_applicable_usd: 0,
            specific_rights_conflict: 'unknown',
            strong_date_dependency: false,
          }));
        },
        deep_research_executor: async () => {
          deepResearchCalls += 1;
          return {
            batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(cand)] },
          };
        },
      };
    };

    const run1 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-1', unitGoodsCny: 63 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 1);
    assert.equal(run1.gate2_3[0].status, 'evaluated');
    assert.equal(run1.gate2_3[0].qualification.counts_toward_target, true);
    const shaRun1 = run1.gate2_3[0].result_sha256;

    const run2 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-1', unitGoodsCny: 63 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 1, 'Truly unchanged candidate must reuse completed evaluation without extra calls');
    assert.equal(run2.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run2.gate2_3[0].result_sha256, shaRun1);

    store.recordSourcingQuotesBatch1688([makeQuoteRow('q-a3-2', 'fac-a3-2', 42)]);
    const run3 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-2', unitGoodsCny: 42 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 2, 'New cheaper quote on same form/spec must invalidate stale reuse and recompute');
    assert.equal(run3.gate2_3[0].status, 'evaluated', JSON.stringify(run3.gate2_3[0]));
    assert.notEqual(run3.gate2_3[0].reused_completed_evaluation, true);
    assert.notEqual(run3.gate2_3[0].result_sha256, shaRun1);
    const shaRun3 = run3.gate2_3[0].result_sha256;

    const run4 = await runPhase2Batch(store, {
      items: [makeBatchItem({ quoteId: 'q-a3-2', unitGoodsCny: 42 })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 2);
    assert.equal(run4.gate2_3[0].status, 'evaluated');
    assert.equal(run4.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run4.gate2_3[0].result_sha256, shaRun3);

    const run5 = await runPhase2Batch(store, {
      items: [makeBatchItem({
        quoteId: 'q-a3-2',
        unitGoodsCny: 42,
        peerRulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '高价款同箱清单待核' },
        ],
      })],
      profile: r59Profile,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 3, 'New #8 comparability ruling must invalidate stale reuse and recompute');
    assert.equal(run5.gate2_3[0].status, 'evaluated', JSON.stringify(run5.gate2_3[0]));
    assert.notEqual(run5.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run5.gate2_3[0].qualification.counts_toward_target, false);

    const modifiedFeeSnap = structuredClone(getFba2027RateTableSnapshot({ profileRevision: 59 }));
    modifiedFeeSnap.metadata = { ...(modifiedFeeSnap.metadata ?? {}), version: 'US-FBA-2027-mutated-test' };
    const run6 = await runPhase2Batch(store, {
      items: [makeBatchItem({
        quoteId: 'q-a3-2',
        unitGoodsCny: 42,
        peerRulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '高价款同箱清单待核' },
        ],
      })],
      profile: r59Profile,
      fee_table_snapshot: modifiedFeeSnap,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 4, 'Changed fee_table_snapshot must invalidate stale reuse and recompute');
    assert.equal(run6.gate2_3[0].status, 'evaluated', JSON.stringify(run6.gate2_3[0]));
    assert.notEqual(run6.gate2_3[0].reused_completed_evaluation, true);

    const staticItemUnchanged = {
      ...makeBatchItem({
        quoteId: 'q-a3-2',
        unitGoodsCny: 42,
        peerRulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '高价款同箱清单待核' },
        ],
      }),
      scored_batch: { schema_version: 1, profile_revision: 59, candidates: [buildAlignedCand('q-a3-2', 42)] },
    };
    const run7 = await runPhase2Batch(store, {
      items: [staticItemUnchanged],
      profile: r59Profile,
      fee_table_snapshot: modifiedFeeSnap,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 4, 'Unchanged static scored_batch must skip cleanly');
    assert.equal(run7.gate2_3[0].reused_completed_evaluation, true);

    const staticCandWithConfirmedHigh = buildAlignedCand('q-a3-2', 42);
    staticCandWithConfirmedHigh.peer_comparability_rulings = [
      { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '低价款缺托盘', spec_sha256: f1.spec_sha256, spec_version: f1.spec_version },
      { peer_asin: 'B0SYN8HIG2', status: 'confirmed_comparable', source: 'owner_audit', reason: '高价款已补齐清单确认可比', spec_sha256: f1.spec_sha256, spec_version: f1.spec_version },
    ];
    const staticItemUpdatedRuling = {
      ...makeBatchItem({ quoteId: 'q-a3-2', unitGoodsCny: 42 }),
      scored_batch: { schema_version: 1, profile_revision: 59, candidates: [staticCandWithConfirmedHigh] },
      deep_research_executor: async () => {
        deepResearchCalls += 1;
        return { batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(staticCandWithConfirmedHigh)] } };
      },
    };
    const run8 = await runPhase2Batch(store, {
      items: [staticItemUpdatedRuling],
      profile: r59Profile,
      fee_table_snapshot: modifiedFeeSnap,
      as_of_date: '2026-11-27',
      resume_skip_completed: true,
    });
    assert.equal(deepResearchCalls, 5, 'Candidate-level #8 ruling change in scored_batch must recompute');
    assert.equal(run8.gate2_3[0].status, 'evaluated');
    assert.notEqual(run8.gate2_3[0].reused_completed_evaluation, true);
    assert.equal(run8.gate2_3[0].qualification.counts_toward_target, true);
  } finally {
    store.close();
  }
});

test('Batch A3.4: Round 1 Batch CLI/Client regressions (#1-#5, #10-#12)', async () => {
  await withTempDirAsync('batch-a3-r1-cli-', async dir => {
    const mkLine = (cid, text) => JSON.stringify({
      custom_id: cid,
      method: 'POST',
      url: '/v1/responses',
      body: { model: 'gpt-6.1-terra', input: text, max_output_tokens: 4096 },
    });

    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'pii.sqlite');
      const emailJsonl = join(dir, 'email-in.jsonl');
      writeFileSync(emailJsonl, `${mkLine('pii-1', 'Contact vendor at alice.vendor@example-supplier.com for quote')}\n`);
      let netCalls = 0;
      const hooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async () => { netCalls += 1; return makeJsonResponse(200, {}); },
        },
      };
      const blockedRes = await runCliMem([
        'openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath,
        '--submit-jsonl', emailJsonl,
      ], hooks);
      assert.notEqual(blockedRes.code, 0, 'Outgoing raw email must be blocked');
      assert.equal(netCalls, 0, 'Outgoing raw email must fail before any network POST');

      const cleanJsonl = join(dir, 'pii-clean.jsonl');
      writeFileSync(cleanJsonl, `${mkLine('pii-out-1', 'Summarize wooden desktop rack specs')}\n`);
      const outLineWithEmail = makeBatchOutputLine('pii-out-1', 'Supplier contact: bob.factory@example-mail.org');
      const hooksOut = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_pii_1' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_pii_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_pii_1' });
            if (m === 'GET' && url.includes('/v1/batches/batch_pii_1')) {
              return makeJsonResponse(200, { id: 'batch_pii_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_pii_1', output_file_id: 'file_pii_out', request_counts: { total: 1, completed: 1, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_pii_out/content')) return makeJsonResponse(200, `${outLineWithEmail}\n`);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const subPii = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', cleanJsonl], hooksOut);
      assert.equal(subPii.code, 0, subPii.stderr);
      const pollPii = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_pii_1', '--download-output'], hooksOut);
      assert.equal(pollPii.code, 0, pollPii.stderr);
      assert.equal(pollPii.stdout.includes('bob.factory@example-mail.org'), false, 'Polled output must redact raw email');
      assert.match(pollPii.stdout, /\[REDACTED_EMAIL\]/);
    }

    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'order-rec.sqlite');
      const jA = join(dir, 'order-a.jsonl');
      const jB = join(dir, 'order-b.jsonl');
      writeFileSync(jA, `${mkLine('cid-1', 'Item one')}\n${mkLine('cid-2', 'Item two')}\n`);
      writeFileSync(jB, `${mkLine('cid-2', 'Item two')}\n${mkLine('cid-1', 'Item one')}\n`);
      let batchPostCount = 0;
      const outBoth = `${makeBatchOutputLine('cid-1', '{"ok":1}')}\n${makeBatchOutputLine('cid-2', '{"ok":2}')}\n`;
      const hooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_rec_1' });
            if (m === 'POST' && url.endsWith('/v1/batches')) {
              batchPostCount += 1;
              throw new Error('ECONNRESET after batch creation');
            }
            if (m === 'GET' && url.includes('/v1/batches/batch_wrong_file')) {
              return makeJsonResponse(200, { id: 'batch_wrong_file', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_other_999', output_file_id: 'file_out_rec', request_counts: { total: 2, completed: 2, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/batches/batch_rec_1')) {
              return makeJsonResponse(200, { id: 'batch_rec_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_rec_1', output_file_id: 'file_out_rec', request_counts: { total: 2, completed: 2, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_out_rec/content')) return makeJsonResponse(200, outBoth);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const firstFail = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jA], hooks);
      assert.notEqual(firstFail.code, 0);
      assert.equal(batchPostCount, 1);

      const secondSwapped = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jB], hooks);
      assert.notEqual(secondSwapped.code, 0);
      assert.equal(batchPostCount, 1, 'Swapping JSONL line order must not trigger duplicate POST /v1/batches');
      const swappedJson = JSON.parse(secondSwapped.stdout);
      const origAttemptId = swappedJson.attempt_id;
      assert.equal(swappedJson.duplicate_post_prevented, true);

      const wrongBind = await runCliMem([
        'openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath,
        '--batch-id', 'batch_wrong_file', '--attempt', origAttemptId, '--download-output',
      ], hooks);
      assert.notEqual(wrongBind.code, 0, 'Mismatched input_file_id must refuse to bind onto pending_recovery attempt');

      const recPoll = await runCliMem([
        'openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath,
        '--batch-id', 'batch_rec_1', '--download-output',
      ], hooks);
      assert.equal(recPoll.code, 0, recPoll.stderr);
      const recJson = JSON.parse(recPoll.stdout);
      assert.equal(recJson.attempt_id, origAttemptId);
      assert.equal(recJson.receipt.status, 'completed');
      assert.ok(recJson.receipt.usage_cost_micros > 0);
      const ledgerCheck = openOpenAiBudgetLedger(dbPath, ledgerOpts);
      try {
        const row = ledgerCheck.getAttemptById(origAttemptId);
        assert.equal(row.provider_response_id, 'batch_rec_1');
        assert.equal(row.status, 'completed');
        assert.ok(row.usage_cost_micros > 0);
      } finally {
        ledgerCheck.close();
      }
    }

    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'retry403.sqlite');
      const jPath = join(dir, 'retry403.jsonl');
      writeFileSync(jPath, `${mkLine('r403-1', 'Retry after 403 test')}\n`);
      let allowUpload = false;
      let batchPosts = 0;
      const hooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) {
              if (!allowUpload) return makeJsonResponse(403, { error: { message: 'Forbidden upload' } });
              return makeJsonResponse(200, { id: 'file_403_ok' });
            }
            if (m === 'POST' && url.endsWith('/v1/batches')) {
              batchPosts += 1;
              return makeJsonResponse(200, { id: 'batch_403_ok', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_403_ok' });
            }
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const rejectedRun = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jPath], hooks);
      assert.notEqual(rejectedRun.code, 0);
      assert.equal(batchPosts, 0);

      allowUpload = true;
      const retriedRun = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', jPath], hooks);
      assert.equal(retriedRun.code, 0, retriedRun.stderr);
      assert.equal(batchPosts, 1);
      assert.equal(JSON.parse(retriedRun.stdout).batch_id, 'batch_403_ok');
    }

    {
      const { dbPath, credPath, ledgerOpts } = makeActivatedTestBudgetDb(dir, 'reconcile-edges.sqlite');

      const dupJsonl = join(dir, 'dup.jsonl');
      writeFileSync(dupJsonl, `${mkLine('dup-1', 'Single item duplicated')}\n`);
      const dupOutLine = makeBatchOutputLine('dup-1', '{"ok":true}', { inputTokens: 1000, outputTokens: 200 });
      const dupErrLine = JSON.stringify({
        id: 'br_dup_err',
        custom_id: 'dup-1',
        response: {
          status_code: 500,
          body: { status: 'failed', model: 'gpt-6.1-terra', error: { message: 'Internal error' }, usage: { input_tokens: 1000, output_tokens: 200 } },
        },
        error: null,
      });
      const dupHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_dup_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_dup_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_dup_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_dup_1')) {
              return makeJsonResponse(200, { id: 'batch_dup_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_dup_in', output_file_id: 'file_dup_out', error_file_id: 'file_dup_err', request_counts: { total: 1, completed: 1, failed: 1 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_dup_out/content')) return makeJsonResponse(200, `${dupOutLine}\n`);
            if (m === 'GET' && url.includes('/v1/files/file_dup_err/content')) return makeJsonResponse(200, `${dupErrLine}\n`);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const dupSub = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', dupJsonl], dupHooks);
      assert.equal(dupSub.code, 0, dupSub.stderr);
      const dupAttemptId = JSON.parse(dupSub.stdout).attempt_id;
      const dupPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_dup_1', '--download-output'], dupHooks);
      const dupPollJson = JSON.parse(dupPoll.stdout);
      assert.deepEqual(dupPollJson.reconciliation.duplicate_custom_ids, ['dup-1']);
      assert.equal(dupPollJson.known_usage_cost_micros, 0, 'Conflicted duplicate item must not inflate known_usage_cost_micros');
      assert.equal(dupPollJson.has_unknown_usage, true);
      const dupLedger = openOpenAiBudgetLedger(dbPath, ledgerOpts);
      try {
        const settled = dupLedger.reconcileAttempt(dupAttemptId, {
          accountScope: 'openai-default',
          status: 'completed',
          usageCostMicros: 1750,
          note: 'Verified single charge for duplicate custom_id',
        });
        assert.equal(settled.status, 'completed');
        assert.equal(settled.usage_cost_micros, 1750);
      } finally {
        dupLedger.close();
      }

      const corruptJsonl = join(dir, 'corrupt.jsonl');
      writeFileSync(corruptJsonl, `${mkLine('cor-ok', 'Item A')}\n${mkLine('cor-bad', 'Item B')}\n`);
      const corHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_cor_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_cor_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_cor_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_cor_1')) {
              return makeJsonResponse(200, { id: 'batch_cor_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_cor_in', output_file_id: 'file_cor_out', error_file_id: 'file_cor_err', request_counts: { total: 2, completed: 1, failed: 1 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_cor_out/content')) return makeJsonResponse(200, `${makeBatchOutputLine('cor-ok', '{"delivered":true}')}\n`);
            if (m === 'GET' && url.includes('/v1/files/file_cor_err/content')) return makeJsonResponse(200, 'NOT_VALID_JSON\n');
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const corSub = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', corruptJsonl], corHooks);
      assert.equal(corSub.code, 0, corSub.stderr);
      const corPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_cor_1', '--download-output'], corHooks);
      const corJson = JSON.parse(corPoll.stdout);
      assert.equal(corJson.parsed_output_count, 1, 'Valid output_file item must still be delivered');
      assert.ok(corJson.error_file_error, 'error_file_error must be surfaced');
      assert.equal(corJson.has_unknown_usage, true);
      assert.ok(corJson.known_usage_cost_micros > 0);
      assert.ok(corJson.receipt.provisional_usage_cost_micros > 0);

      const knownErrJsonl = join(dir, 'known-err.jsonl');
      writeFileSync(knownErrJsonl, `${mkLine('ke-ok', 'Good item')}\n${mkLine('ke-err', 'Known-usage error item')}\n`);
      const keErrLine = JSON.stringify({
        id: 'br_ke_err',
        custom_id: 'ke-err',
        response: {
          status_code: 500,
          body: { status: 'failed', model: 'gpt-6.1-terra', error: { message: 'Server fault' }, usage: { input_tokens: 100, output_tokens: 10 } },
        },
        error: null,
      });
      const keHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_ke_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_ke_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_ke_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_ke_1')) {
              return makeJsonResponse(200, { id: 'batch_ke_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_ke_in', output_file_id: 'file_ke_out', error_file_id: 'file_ke_err', request_counts: { total: 2, completed: 1, failed: 1 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_ke_out/content')) return makeJsonResponse(200, `${makeBatchOutputLine('ke-ok', '{"ok":1}')}\n`);
            if (m === 'GET' && url.includes('/v1/files/file_ke_err/content')) return makeJsonResponse(200, `${keErrLine}\n`);
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      const keSub = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', knownErrJsonl], keHooks);
      assert.equal(keSub.code, 0, keSub.stderr);
      const kePoll1 = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_ke_1', '--download-output'], keHooks);
      assert.equal(kePoll1.code, 0, kePoll1.stderr);
      const keJson1 = JSON.parse(kePoll1.stdout);
      assert.equal(keJson1.receipt.status, 'completed', 'Fully known-cost batch with terminal error_file must settle');
      assert.equal(keJson1.has_unknown_usage, false);
      const kePoll2 = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_ke_1', '--download-output'], keHooks);
      assert.equal(kePoll2.code, 0, 'Re-downloading settled batch with error_file_id must succeed without digest mismatch');
      assert.equal(JSON.parse(kePoll2.stdout).already_settled, true);

      const refJsonl = join(dir, 'refusal.jsonl');
      writeFileSync(refJsonl, `${mkLine('ref-ok', 'Normal item')}\n${mkLine('ref-no', 'Refused item')}\n`);
      const refusalLine = JSON.stringify({
        id: 'br_ref_no',
        custom_id: 'ref-no',
        response: {
          status_code: 200,
          body: {
            id: 'resp_ref_no',
            status: 'completed',
            model: 'gpt-6.1-terra',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }],
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
        error: null,
      });
      const refHooks = {
        testLedgerOptions: ledgerOpts,
        openAiClientOptions: {
          testMode: true,
          fetchImpl: async (url, init = {}) => {
            const m = String(init.method || 'GET').toUpperCase();
            if (m === 'POST' && url.endsWith('/v1/files')) return makeJsonResponse(200, { id: 'file_ref_in' });
            if (m === 'POST' && url.endsWith('/v1/batches')) return makeJsonResponse(200, { id: 'batch_ref_1', status: 'in_progress', endpoint: '/v1/responses', input_file_id: 'file_ref_in' });
            if (m === 'GET' && url.includes('/v1/batches/batch_ref_1')) {
              return makeJsonResponse(200, { id: 'batch_ref_1', status: 'completed', endpoint: '/v1/responses', input_file_id: 'file_ref_in', output_file_id: 'file_ref_out', request_counts: { total: 2, completed: 2, failed: 0 } });
            }
            if (m === 'GET' && url.includes('/v1/files/file_ref_out/content')) {
              return makeJsonResponse(200, `${makeBatchOutputLine('ref-ok', '{"ok":true}')}\n${refusalLine}\n`);
            }
            if (m === 'GET' && url.includes('/v1/batches/batch_errdata_1')) {
              return makeJsonResponse(200, {
                id: 'batch_errdata_1',
                status: 'failed',
                endpoint: '/v1/responses',
                input_file_id: 'file_errdata_in',
                errors: { data: [{ code: 'invalid_json_line', message: 'Line 1 invalid schema' }] },
              });
            }
            throw new Error(`Unexpected ${m} ${url}`);
          },
        },
      };
      await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--submit-jsonl', refJsonl], refHooks);
      const refPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_ref_1', '--download-output'], refHooks);
      const refJson = JSON.parse(refPoll.stdout);
      assert.equal(refJson.reconciliation.succeeded_count, 1);
      assert.equal(refJson.reconciliation.failed_count, 1, 'Refusal must be counted in failed_count');
      assert.equal(refJson.reconciliation.partial_success, true, 'Refusal must set partial_success=true');

      const errDataPoll = await runCliMem(['openai-batch-poll', '--db', dbPath, '--budget-db', dbPath, '--credential-file', credPath, '--batch-id', 'batch_errdata_1', '--download-output'], refHooks);
      const errDataJson = JSON.parse(errDataPoll.stdout);
      assert.equal(errDataJson.batch_errors[0].code, 'invalid_json_line');
    }
  });
});

test('Batch A3.5: Round 1 Pipeline/CLI resume, Keepa precomputed, single-product export, quote conflict & Gate 1B landed basis (#6-#9, #13-#15, #129)', async () => {
  await withTempDirAsync('batch-a3-r1-pipe-', async dir => {
    {
      const stKeepa = openSelectionStore(':memory:');
      try {
        const baseForm = {
          form_id: 'form-a3-keepa',
          label: 'Adult Desktop Tray',
          buyer_task: 'Hold studio tools',
          saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }],
        };
        stKeepa.upsertCandidateForm(baseForm);
        const scen52 = {
          id: 'sc-52',
          asin: 'B0LEGACY52',
          price_usd: 52.00,
          pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 },
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          headhaul_usd: 1.8,
          collection_rate: 0.006,
        };
        const barePrecomputed = {
          options: { as_of_date: '2026-11-24', strict_mature_only: true },
          strict_mature_only: true,
          mainstream_count: 1,
          mainstream_pool: [{
            asin: 'B0LEGACY52',
            net_price_usd: 52.00,
            list_price_usd: 52.00,
            fulfillment: 'FBA',
            monthly_units: 80,
            age_days: 420,
            keepa_steady_verified: true,
          }],
          mature_regular_band: { min_usd: 52, max_usd: 52, peer_count: 1 },
          spiral_watch: [],
          observed_out_of_band_peers: [],
        };
        const g1aBare = runGate1AForForm(stKeepa, {
          form_id: baseForm.form_id,
          profile_revision: 59,
          price_band_analysis: barePrecomputed,
          scenarios: [scen52],
        });
        assert.equal(g1aBare.gate_status, 'gate1a_needs_verification', 'Bare legacy keepa_steady_verified without dates must not pass');

        const datedPrecomputed = {
          options: { as_of_date: '2026-11-24', strict_mature_only: true },
          strict_mature_only: true,
          mainstream_count: 2,
          mainstream_pool: [
            {
              asin: 'B0DATED49',
              net_price_usd: 49.99,
              list_price_usd: 49.99,
              fulfillment: 'FBA',
              monthly_units: 95,
              age_days: 430,
              keepa_dated_90d_verified: true,
              keepa_steady_provenance: 'dated_90d_keepa',
              keepa_steady_reference: { price_usd: 49.99, source: 'keepa_90d_median_usd' },
            },
            {
              asin: 'B0UNVER55',
              net_price_usd: 55.00,
              list_price_usd: 55.00,
              fulfillment: 'FBA',
              monthly_units: 70,
              age_days: 410,
            },
          ],
          mature_regular_band: { min_usd: 49.99, max_usd: 55.00, peer_count: 2 },
          spiral_watch: [],
          observed_out_of_band_peers: [],
        };
        const g1aDated = runGate1AForForm(stKeepa, {
          form_id: baseForm.form_id,
          profile_revision: 59,
          price_band_analysis: datedPrecomputed,
          scenarios: [{ ...scen52, id: 'sc-49', asin: 'B0DATED49', price_usd: 49.99 }],
        });
        assert.equal(g1aDated.gate_status, 'gate1a_passed', 'Dated-verified $49.99 peer must survive filtering out unverified peer');
        assert.equal(g1aDated.regular_band_reference.min_usd, 49.99);
        assert.equal(g1aDated.regular_band_reference.max_usd, 49.99);
      } finally {
        stKeepa.close();
      }
    }

    {
      const stLanded = openSelectionStore(':memory:');
      try {
        const fDef = {
          form_id: 'form-a3-landed',
          label: 'Steel Storage Rack',
          buyer_task: 'Hold pantry jars',
          saleable_set_composition: [{ component_id: 'rack', qty_per_saleable_set: 1 }],
        };
        const { form: fRow } = stLanded.upsertCandidateForm(fDef);
        const g1a = runGate1AForForm(stLanded, {
          form_id: fDef.form_id,
          profile_revision: 59,
          scenarios: [{
            id: 'sc-landed',
            price_usd: 45.00,
            pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 },
            fx_cny_per_usd: 7.2,
            refund_fraction: 0.04,
            fee_category: 'Home and Kitchen',
            referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            headhaul_usd: 1.8,
            collection_rate: 0.006,
          }],
        });
        stLanded.recordSourcingQuotesBatch1688([{
          quote_id: 'q-landed-explicit',
          factory_id: 'fac-landed-1',
          form_id: fDef.form_id,
          spec_version: fRow.spec_version,
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'rb-landed',
          ui_readback: DEFAULT_R59_UI_READBACK,
          require_ui_readback: true,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'o-l1', sku_id: 's1', component_id: 'rack', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
          goods_cny_total: 10000,
          domestic_freight_cny_total: 500,
        }]);
        const d = g1a.declared_scenarios[0];
        const g1b = await runGate1BForForm(stLanded, {
          form_id: fDef.form_id,
          profile_revision: 59,
          as_of_date: '2026-11-27',
          early_screen_builder: () => [{
            profile_revision: 59,
            id: d.id,
            saleable_unit: '1 rack',
            price_usd: d.price_usd,
            fx_cny_per_usd: d.fx_cny_per_usd,
            order_units: 100,
            goods_cny_per_unit: 100,
            domestic_freight_cny_per_unit: 5,
            headhaul: { usd_per_unit: 1.8, bond_included: true },
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            return_threshold: 0.08,
            returns_processing_usd: 0,
            is_apparel_or_shoes: false,
            referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            fulfillment_usd: d.fulfillment_usd,
            placement_usd: d.placement_range_usd[1],
            storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: { from: '2027-02-01', through: '2027-09-30' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-01-25' } },
            collection_rate: 0.006,
            other_applicable_usd: 0,
          }],
        });
        const es = Array.isArray(g1b.early_screen) ? g1b.early_screen[0] : g1b.early_screen;
        assert.equal(es.cost_basis, 'landed_domestic_explicit');
        assert.ok(es.metrics.domestic_freight_usd > 0, 'Persisted landed-domestic quote must include domestic freight in Gate 1B margin');
      } finally {
        stLanded.close();
      }
    }

    {
      const store = openSelectionStore(':memory:');
      try {
        const salesWin = { from: '2027-02-01', through: '2027-10-14' };
        const storageWin = { from: '2027-02-01', through: '2027-09-30' };
        const inboundWin = { from: '2027-01-20', through: '2027-02-01' };
        const formDef = {
          form_id: 'form-a3-r1',
          label: 'Bamboo Organizer Tray R1',
          buyer_task: 'Organize desk items',
          saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
        };
        const { form: fRow } = store.upsertCandidateForm(formDef);
        const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
          id: formDef.form_id,
          specSha256: fRow.spec_sha256,
          specVersion: fRow.spec_version,
        });
        const fx = 7.0;
        const hhUsd = baseCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul')?.amount_usd ?? 2.0;
        const g1aScens = baseCand.economics.scenarios.map(s => ({
          id: s.id,
          price_usd: s.cost_ledger.price_usd,
          pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
          fx_cny_per_usd: fx,
          refund_fraction: 0.02,
          physical_return_fraction: 0.02,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
          headhaul_usd: hhUsd,
          collection_rate: 0.006,
          sales_window: salesWin,
          storage_window: storageWin,
          inbound_window: inboundWin,
          is_apparel: false,
          is_dangerous_goods: false,
          is_sipp: false,
        }));
        const rawEst = estimateGate1A2027(g1aScens[0]);
        const cachedEst = {
          fulfillment_usd: rawEst.components.fulfillment.total_usd,
          placement_usd: rawEst.components.placement.selected_usd,
          storage_usd: rawEst.components.storage.per_unit_usd,
        };
        const mkQuote = (qid, fid, unitCny, targetFormId = formDef.form_id, specVer = fRow.spec_version) => ({
          quote_id: qid,
          factory_id: fid,
          spec_variant_key: 'kit-std',
          form_id: targetFormId,
          spec_version: specVer,
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: `rb-${qid}`,
          ui_readback: DEFAULT_R59_UI_READBACK,
          require_ui_readback: true,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: `o-${qid}`, sku_id: 'kit', component_id: 'kit', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: unitCny, regular_goods_promo_false: true }],
          goods_cny_total: Math.round(unitCny * 100 * 100) / 100,
          domestic_freight_cny_total: 100,
        });
        const mkCand = (qid, unitCny, candId = formDef.form_id, specSha = fRow.spec_sha256, specVer = fRow.spec_version) => {
          const c = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], { id: candId, specSha256: specSha, specVersion: specVer });
          for (const s of c.economics.scenarios) {
            s.quote_id = qid;
            s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
            s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: qid, fx_cny_per_usd: fx };
            for (const l of s.cost_ledger.lines) {
              if (l.id === 'procurement') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((unitCny / fx).toFixed(6)); }
              if (l.id === 'domestic_freight') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((1 / fx).toFixed(6)); }
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
        store.recordSourcingQuotesBatch1688([mkQuote('q-r1-1', 'fac-r1-1', 63)]);

        let calls = 0;
        const mkItem = ({
          qid = 'q-r1-1',
          unitCny = 63,
          leadDisp = 'product',
          note = null,
          peerRulings = null,
          embeddedRulings = null,
          staticResearchOut = null,
          rightsInput = null,
          fDef = formDef,
          specSha = fRow.spec_sha256,
          specVer = fRow.spec_version,
        } = {}) => {
          const cand = mkCand(qid, unitCny, fDef.form_id, specSha, specVer);
          if (embeddedRulings) cand.peer_comparability_rulings = embeddedRulings;
          return {
            form: fDef,
            leads: [{
              lead_id: `lead-${fDef.form_id}`,
              source_channel: 'reddit',
              source_ref: `https://example.com/r/${fDef.form_id}`,
              phrase_or_title: 'organizer tray',
              observed_at: '2026-11-27',
              disposition: leadDisp,
            }],
            gate1a_scenarios: note ? g1aScens.map(g => ({ ...g, notes: note })) : g1aScens,
            ...(peerRulings ? { peer_comparability_rulings: peerRulings } : {}),
            ...(rightsInput ? { rights_prescreen_input: rightsInput } : {}),
            ...(staticResearchOut ? { research_out: staticResearchOut } : {}),
            early_screen_builder: ({ quote }) => {
              const uc = Number(quote.goods_cny_total) / Number(quote.actual_complete_sets);
              return g1aScens.map(g => ({
                profile_revision: 59, id: g.id, saleable_unit: '1 set', price_usd: g.price_usd, fx_cny_per_usd: fx, order_units: 100,
                goods_cny_per_unit: uc, domestic_freight_cny_per_unit: 1, first_order_promotion: false, goods_first_order_promotion: false,
                headhaul: { usd_per_unit: hhUsd, bond_included: true }, refund_fraction: 0.02, physical_return_fraction: 0.02,
                return_threshold: 0.08, returns_processing_usd: 0, is_apparel_or_shoes: false, referral_terms: g.referral_terms,
                fulfillment_usd: cachedEst.fulfillment_usd, placement_usd: cachedEst.placement_usd,
                storage: { cubic_feet_per_unit: (10 * 6 * 2) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
                operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
                fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pack-1', sales: salesWin, storage: storageWin, inbound: inboundWin },
                collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
              }));
            },
            deep_research_executor: async () => {
              calls += 1;
              return staticResearchOut ? structuredClone(staticResearchOut) : {
                batch: { schema_version: 1, profile_revision: 59, candidates: [structuredClone(cand)] },
              };
            },
          };
        };

        const embeddedR = [{ peer_asin: 'B0SYN8LOW1', status: 'confirmed_comparable', source: 'owner_audit', reason: 'Embedded comparable', spec_sha256: fRow.spec_sha256, spec_version: fRow.spec_version }];
        const r1 = await runPhase2Batch(store, { items: [mkItem({ embeddedRulings: embeddedR })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(calls, 1);
        assert.equal(r1.gate2_3[0].qualification.counts_toward_target, true);
        const r1Cosmetic = await runPhase2Batch(store, { items: [mkItem({ embeddedRulings: embeddedR, note: 'Cosmetic operator memo' })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(calls, 1, 'Cosmetic Gate 1A note & unchanged dynamic embedded rulings must reuse cleanly');
        assert.equal(r1Cosmetic.gate2_3[0].reused_completed_evaluation, true);

        const rInad = await runPhase2Batch(store, { items: [mkItem({ leadDisp: 'promotion_only' })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(rInad.gate2_3[0].status, 'blocked_inadmissible_leads');
        assert.equal(calls, 1);

        const mismatchOut = {
          batch: { schema_version: 1, profile_revision: 59, candidates: [mkCand('q-r1-1', 63)] },
          spec_matches: [{
            schema_version: 1,
            contract: 'SpecMatcher',
            form_id: formDef.form_id,
            verdict: 'mismatch',
            comparable_for_q31: false,
            scope: 'complete_kit',
            buyer_task: 'Organize desk items',
            reason: 'Missing tray lid',
            evidence_refs: ['ev-sm-1'],
          }],
        };
        const rMis = await runPhase2Batch(store, { items: [mkItem({ staticResearchOut: mismatchOut })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(rMis.gate2_3[0].status, 'blocked_spec_mismatch');
        assert.equal(calls, 2);

        const badDiscOut = {
          batch: { schema_version: 1, profile_revision: 59, candidates: [mkCand('q-r1-1', 63)] },
          discovery: { pool: null, decisions: null },
        };
        const rBadDisc = await runPhase2Batch(store, { items: [mkItem({ staticResearchOut: badDiscOut })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.equal(rBadDisc.gate2_3[0].status, 'gate2_3_error', 'Invalid static discovery must not hit stale cache');
        assert.equal(calls, 3);

        const sameRightsInput = { candidate_id: formDef.form_id, target_spec: { label: 'Bamboo Organizer Tray' }, claim_texts: [] };
        const staticCleanOut = { batch: { schema_version: 1, profile_revision: 59, candidates: [mkCand('q-r1-1', 63)] } };
        const rRights1 = await runPhase2Batch(store, {
          items: [mkItem({ staticResearchOut: staticCleanOut, rightsInput: sameRightsInput })],
          profile: r59Profile,
          as_of_date: '2026-11-27',
          resume_skip_completed: true,
        });
        assert.equal(rRights1.gate2_3[0].qualification.counts_toward_target, true);
        assert.equal(calls, 4);
        const rRightsRuling = await runPhase2Batch(store, {
          items: [mkItem({
            staticResearchOut: staticCleanOut,
            rightsInput: sameRightsInput,
            peerRulings: [
              { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '缺托盘' },
              { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '待补清单' },
            ],
          })],
          profile: r59Profile,
          as_of_date: '2026-11-27',
          resume_skip_completed: true,
        });
        assert.notEqual(rRightsRuling.gate2_3[0].reused_completed_evaluation, true, 'Adding #8 rulings alongside unchanged rights_prescreen_input must recompute');
        assert.equal(rRightsRuling.gate2_3[0].qualification.counts_toward_target, false);
        assert.equal(calls, 5);

        const rOmittedAfterRevoke = await runPhase2Batch(store, { items: [mkItem()], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.notEqual(rOmittedAfterRevoke.gate2_3[0].reused_completed_evaluation, true, 'Omitting rulings after revocation must never time-travel to an older qualifying row');
        assert.equal(calls, 6);

        store.db.prepare(
          'UPDATE evaluations SET receipt_json = ? WHERE form_id = ?',
        ).run(JSON.stringify({ profile_revision: 59, form_spec_sha256: fRow.spec_sha256 }), formDef.form_id);
        store.recordSourcingQuotesBatch1688([mkQuote('q-r1-2', 'fac-r1-2', 42)]);
        const rLegacyUpgrade = await runPhase2Batch(store, { items: [mkItem({ qid: 'q-r1-2', unitCny: 42 })], profile: r59Profile, as_of_date: '2026-11-27', resume_skip_completed: true });
        assert.notEqual(rLegacyUpgrade.gate2_3[0].reused_completed_evaluation, true, 'Legacy receipt without detailed fingerprints must recompute');
        assert.equal(calls, 7);

        const form2Def = {
          form_id: 'form-a3-r1-sibling',
          label: 'Sibling Tray R1',
          buyer_task: 'Hold craft supplies',
          saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
        };
        const { form: f2Row } = store.upsertCandidateForm(form2Def);
        store.recordSourcingQuotesBatch1688([mkQuote('q-r1-sib', 'fac-r1-sib', 42, form2Def.form_id, f2Row.spec_version)]);
        const rIso = await runPhase2Batch(store, {
          items: [
            mkItem({ qid: 'q-r1-2', unitCny: 42, peerRulings: [{ peer_asin: 'B0SYN8LOW1', status: 'bogus_status', source: 'owner_audit', reason: 'bad' }] }),
            mkItem({ qid: 'q-r1-sib', unitCny: 42, fDef: form2Def, specSha: f2Row.spec_sha256, specVer: f2Row.spec_version }),
          ],
          profile: r59Profile,
          as_of_date: '2026-11-27',
          resume_skip_completed: false,
        });
        assert.equal(rIso.gate2_3.find(x => x.form_id === formDef.form_id).status, 'gate2_3_error');
        assert.equal(rIso.gate2_3.find(x => x.form_id === form2Def.form_id).status, 'evaluated');
      } finally {
        store.close();
      }

      const cliDbPath = join(dir, 'single-prod.sqlite');
      const reportDir = join(dir, 'single-report');
      const specPath = join(dir, 'single-spec.json');
      const conflictSpecPath = join(dir, 'single-spec-conflict.json');
      const profilePath = join(dir, 'profile.json');
      writeFileSync(profilePath, JSON.stringify(r59Profile));
      await runCliMem(['init', '--db', cliDbPath]);

      const stPre = openSelectionStore(cliDbPath);
      const spFormDef = {
        form_id: 'form-sp-a3',
        label: 'Single Product Ruling Test',
        buyer_task: 'Organize desk items',
        saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
      };
      const { form: spForm } = stPre.upsertCandidateForm(spFormDef);
      stPre.close();

      const salesWin = { from: '2027-02-01', through: '2027-10-14' };
      const storageWin = { from: '2027-02-01', through: '2027-09-30' };
      const inboundWin = { from: '2027-01-20', through: '2027-02-01' };
      const spCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
        id: spFormDef.form_id,
        specSha256: spForm.spec_sha256,
        specVersion: spForm.spec_version,
      });
      const fx = 7.0;
      const hhUsd = spCand.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'headhaul')?.amount_usd ?? 2.0;
      const spG1a = spCand.economics.scenarios.map(s => ({
        id: s.id, price_usd: s.cost_ledger.price_usd, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
        fx_cny_per_usd: fx, refund_fraction: 0.02, physical_return_fraction: 0.02, fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
        headhaul_usd: hhUsd, collection_rate: 0.006, sales_window: salesWin, storage_window: storageWin, inbound_window: inboundWin,
        is_apparel: false, is_dangerous_goods: false, is_sipp: false,
      }));
      const spEst = estimateGate1A2027(spG1a[0]);
      for (const s of spCand.economics.scenarios) {
        s.quote_id = 'q-sp-1';
        s.cost_ledger.fee_context = { ...s.cost_ledger.fee_context, sales: salesWin, storage: storageWin, inbound: inboundWin };
        s.cost_ledger.source_inputs = { ...(s.cost_ledger.source_inputs ?? {}), quote_id: 'q-sp-1', fx_cny_per_usd: fx };
        for (const l of s.cost_ledger.lines) {
          if (l.id === 'procurement') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((63 / fx).toFixed(6)); }
          if (l.id === 'domestic_freight') { l.fx_cny_per_usd = fx; l.order_units = 100; l.amount_usd = Number((1 / fx).toFixed(6)); }
          if (l.id === 'fulfillment') l.amount_usd = spEst.components.fulfillment.total_usd;
          if (l.id === 'placement') l.amount_usd = spEst.components.placement.selected_usd;
          if (l.id === 'storage') l.amount_usd = Math.max(l.amount_usd, spEst.components.storage.per_unit_usd);
        }
        const r = s.cost_ledger.refund_fraction ?? 0.04;
        const nonCol = ['referral', 'fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
          .reduce((sum, lid) => sum + (s.cost_ledger.lines.find(l => l.id === lid)?.amount_usd ?? 0), 0);
        const colLine = s.cost_ledger.lines.find(l => l.id === 'collection');
        if (colLine) colLine.amount_usd = Number((Math.max(0, s.cost_ledger.price_usd * (1 - r) - nonCol) * (s.cost_ledger.collection_rate ?? 0.005)).toFixed(6));
      }
      const spBaseSpec = {
        as_of_date: '2026-11-27',
        form: spFormDef,
        leads: [{ lead_id: 'lead-sp-1', source_channel: 'reddit', source_ref: 'https://example.com/r/sp', phrase_or_title: 'tray', observed_at: '2026-11-27', disposition: 'product' }],
        gate1a_scenarios: spG1a,
        quotes: [{
          quote_id: 'q-sp-1',
          factory_id: 'fac-sp-1',
          spec_variant_key: 'kit-std',
          observed_at: '2026-11-27',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'rb-sp-1',
          ui_readback: DEFAULT_R59_UI_READBACK,
          require_ui_readback: true,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          sku_lines: [{ offer_id: 'o-sp-1', sku_id: 'kit', component_id: 'kit', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 63, regular_goods_promo_false: true }],
          goods_cny_total: 6300,
          domestic_freight_cny_total: 100,
        }],
        peer_comparability_rulings: [
          { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_audit', reason: '缺托盘' },
          { peer_asin: 'B0SYN8HIG2', status: 'pending_evidence', source: 'owner_audit', reason: '清单待核' },
        ],
        scored_batch: { schema_version: 1, profile_revision: 59, candidates: [spCand] },
      };
      writeFileSync(specPath, JSON.stringify(spBaseSpec, null, 2));
      const spRes = await runCliMem(['single-product', '--db', cliDbPath, '--input', specPath, '--profile', profilePath, '--report-dir', reportDir]);
      assert.equal(spRes.code, 0, spRes.stderr);
      const spOut = JSON.parse(spRes.stdout);
      assert.equal(spOut.batch_report.gate2_3[0].qualification.counts_toward_target, false);
      const exportedResult = JSON.parse(readFileSync(join(reportDir, 'result.json'), 'utf8'));
      assert.equal(
        exportedResult.candidates[0].qualification.counts_toward_target,
        false,
        'single-product --report-dir must apply peer_comparability_rulings consistently with batch_report',
      );

      const conflictSpec = structuredClone(spBaseSpec);
      conflictSpec.quotes[0].goods_cny_total = 4200;
      conflictSpec.quotes[0].sku_lines[0].unit_price_cny = 42;
      writeFileSync(conflictSpecPath, JSON.stringify(conflictSpec, null, 2));
      const conflictRes = await runCliMem(['single-product', '--db', cliDbPath, '--input', conflictSpecPath, '--profile', profilePath]);
      assert.notEqual(conflictRes.code, 0, 'Conflicting price under same quote_id must fail instead of silently reusing old quote');
    }
  });
});

function makeStep3ScoringCandidateMatchingForm(formId, priceUsd = 45.00, goodsCny = 50.00, freightCny = 1.50, fx = 7.20) {
  const c = structuredClone(syntheticFixture.candidates[0]);
  c.id = formId;
  c.label = `Synthetic ${formId}`;
  c.screening.reference_price_usd.value = priceUsd;
  const pkgObj = { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 };
  const estRef = estimateGate1A2027({
    price_usd: priceUsd,
    pkg: pkgObj,
    fx_cny_per_usd: fx,
    refund_fraction: 0,
    physical_return_fraction: 0,
    fee_category: 'Home and Kitchen',
    referral_terms: { referral_fraction: 0.15, minimum_referral_usd: 0.30, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
    headhaul_usd: 1.80,
    collection_rate: 0.006,
    sales_window: { from: '2027-02-01', through: '2027-10-14' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    profile_revision: 59,
  });
  const sc = structuredClone(c.economics.scenarios[0]);
  const pkgRef = sc.cost_ledger.fee_context.package_ref;
  c.economics.packages = [{ id: pkgRef, ...pkgObj }];
  sc.id = sc.cost_ledger.id = 'sc-c1';
  sc.quote_id = `q-${formId}`;
  sc.cost_ledger.price_usd = priceUsd;
  sc.cost_ledger.fx_cny_per_usd = fx;
  sc.cost_ledger.refund_fraction = 0;
  sc.cost_ledger.physical_return_fraction = 0;
  sc.cost_ledger.source_inputs = {
    quote_id: `q-${formId}`,
    fx_cny_per_usd: fx,
    order_units: 100,
    goods_cny_total: Math.round(goodsCny * 100),
    domestic_freight_cny_total: Math.round(freightCny * 100),
  };
  sc.cost_ledger.fee_context = {
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  const procUsd = Number((goodsCny / fx).toFixed(6));
  const domUsd = Number((freightCny / fx).toFixed(6));
  const fbaUsd = estRef.components.fulfillment.total_usd;
  const placeUsd = estRef.components.placement.selected_usd;
  const storUsd = estRef.components.storage.per_unit_usd;
  const refNetUsd = estRef.components.referral.net_usd;
  const colUsd = estRef.components.collection.collection_usd;
  for (const line of sc.cost_ledger.lines) {
    if (line.id === 'procurement') { line.amount_usd = procUsd; line.order_units = 100; line.fx_cny_per_usd = fx; line.status = 'sourced'; }
    else if (line.id === 'domestic_freight') { line.amount_usd = domUsd; line.order_units = 100; line.fx_cny_per_usd = fx; line.status = 'sourced'; }
    else if (line.id === 'headhaul') { line.amount_usd = 1.80; }
    else if (line.id === 'referral') {
      line.amount_usd = refNetUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-12-31';
        line.fee_basis.referral_fraction = 0.15;
        line.fee_basis.minimum_referral_usd = 0.30;
        line.fee_basis.refund_admin_fraction = 0.20;
        line.fee_basis.refund_admin_cap_usd = 5.00;
      }
    } else if (line.id === 'fulfillment') {
      line.amount_usd = fbaUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-10-14';
      }
    } else if (line.id === 'placement' || line.id === 'inbound_placement') {
      line.amount_usd = placeUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-10-14';
      }
    } else if (line.id === 'storage') {
      line.amount_usd = storUsd;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-09-30';
        line.fee_basis.cubic_feet_per_unit = estRef.components.storage.cubic_feet;
        line.fee_basis.rate_usd_per_cuft_month = estRef.components.storage.rate_usd_per_cuft_month;
        line.fee_basis.average_inventory_days = 45;
      }
    } else if (line.id === 'returns_processing') {
      line.amount_usd = 0;
      line.return_threshold = estRef.components.returns_processing.return_threshold;
      if (line.fee_basis) {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-12-31';
        line.fee_basis.fee_category = 'Home and Kitchen';
        line.fee_basis.return_threshold = estRef.components.returns_processing.return_threshold;
      }
    } else if (line.id === 'collection') {
      line.amount_usd = colUsd;
      line.rate = 0.006;
    }
  }
  delete sc.margin;
  delete sc.contribution_usd;
  c.economics = {
    ...c.economics,
    ...buildEvergreen2027OffPeakEconomics({
      saleable_unit: c.economics.saleable_unit,
      off_peak_scenarios: [sc],
    }),
  };
  return c;
}

test('Step 3.1: profit-check & rate-lookup stateless CLI entrypoints verify 2027 off-peak profit, <=10mm rescue, and official rate lookup/persistence', async () => {
  await withTempDirAsync('r59-step3-stateless-', async dir => {
    const profitSpecPath = join(dir, 'profit-spec.json');
    const profitOutPath = join(dir, 'profit-out.json');
    writeFileSync(profitSpecPath, JSON.stringify({
      price_usd: 42.99,
      pkg: { length_in: 16.0, width_in: 12.0, height_in: 8.20, weight_lb: 3.5 },
      goods_cny_per_unit: 92.0,
      domestic_freight_cny_per_unit: 3.0,
      fx_cny_per_usd: 7.20,
      headhaul_usd: 3.10,
      fee_category: 'Home and Kitchen',
      refund_fraction: 0.04,
      collection_rate: 0.006,
    }, null, 2));
    const pRes = await runCliMem(['profit-check', '--input', profitSpecPath, '--output', profitOutPath]);
    assert.equal(pRes.code, 0, pRes.stderr);
    const parsedProfit = JSON.parse(pRes.stdout);
    assert.equal(parsedProfit.healthcheck.window.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');
    assert.equal(parsedProfit.healthcheck.window.q4_peak_margin, null);
    assert.equal(parsedProfit.healthcheck.advisory_gate1a_cap.advisory_only_never_pre_kills, true);
    assert.ok(Number.isFinite(parsedProfit.healthcheck.forward_breakeven_30pct.feasible_min_price_usd));
    assert.ok(Number.isFinite(parsedProfit.healthcheck.realized_2027_off_peak.margin));

    const dirLookupPath = join(dir, 'lookup-req.json');
    writeFileSync(dirLookupPath, JSON.stringify({
      fee_category: 'Fine Art',
      asin: 'B0SYNART01',
      reason: 'Tiered referral schedule check',
    }, null, 2));
    const rDir = await runCliMem(['rate-lookup', '--input', dirLookupPath]);
    assert.equal(rDir.code, 0, rDir.stderr);
    assert.equal(JSON.parse(rDir.stdout).mode, 'lookup_directive');

    const regPath = join(dir, 'register-tiered.json');
    const persistRegPath = join(dir, 'supplemental-rates.json');
    writeFileSync(regPath, JSON.stringify({
      fee_category: 'Fine Art Synthetic Tiered',
      official_source_url: 'https://sellercentral.amazon.com/help/hub/reference/GTG4BAWSY39Z98Z3',
      effective_from: '2027-01-15',
      effective_through: '2027-12-31',
      sp_api_verified: true,
      comparable_asin: 'B0SYNART01',
      referral_schedule: {
        type: 'tiered',
        minimum_fee_usd: 0.30,
        tiers: [
          { up_to_usd: 100, rate: 0.20 },
          { up_to_usd: null, rate: 0.15 },
        ],
      },
      return_threshold_fraction: 0.05,
      test_price_usd: 150,
    }, null, 2));
    const rReg = await runCliMem(['rate-lookup', '--input', regPath, '--persist-file', persistRegPath]);
    assert.equal(rReg.code, 0, rReg.stderr);
    const parsedReg = JSON.parse(rReg.stdout);
    assert.equal(parsedReg.mode, 'verified_rule_registered');
    assert.equal(parsedReg.sample_referral_calculation.referral_fee_usd, 27.50);
    const persistedDisk = JSON.parse(readFileSync(persistRegPath, 'utf8'));
    assert.ok(persistedDisk.rules.fine_art_synthetic_tiered);

    const badUrlPath = join(dir, 'bad-url.json');
    writeFileSync(badUrlPath, JSON.stringify({
      fee_category: 'Fake Blog',
      official_source_url: 'https://random-blog.example.com/fba-rates',
      effective_from: '2027-01-15',
      sp_api_verified: true,
      referral_schedule: { type: 'flat', rate: 0.15 },
    }, null, 2));
    const rBad = await runCliMem(['rate-lookup', '--input', badUrlPath]);
    assert.equal(rBad.code, 2);
  });
});

test('Step 3.2: daily-batch, single-dive, reverse-1688, calibration-track, Gate 1A pre-kill ban, M4 visible pending review state, and CAPTCHA_PAUSED resume skipping completed work', async () => {
  await withTempDirAsync('r59-step3-workflow-', async dir => {
    const dbPath = join(dir, 'workflow.sqlite');
    await runCliMem(['init', '--db', dbPath]);

    const badKillPath = join(dir, 'bad-kill.json');
    writeFileSync(badKillPath, JSON.stringify({
      form_id: 'form-bad-kill',
      label: 'Bad Kill',
      buyer_task: 'Organize desk',
      disallow_pre1688_cost_guess_kill: false,
      gate1a_scenarios: [{ id: 'sc-1', price_usd: 45, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
    }, null, 2));
    const rBadKill = await runCliMem(['single-dive', '--db', dbPath, '--input', badKillPath]);
    assert.equal(rBadKill.code, 2);
    assert.match(rBadKill.stderr, /disallow_pre1688_cost_guess_kill/);

    const cand1 = makeStep3ScoringCandidateMatchingForm('form-daily-1', 45.00, 50.00, 1.50, 7.20);
    const cand2 = makeStep3ScoringCandidateMatchingForm('form-daily-2', 45.00, 48.00, 1.50, 7.20);
    const makeQuote = (fid, goodsTotal = 5000) => ({
      quote_id: `q-${fid}`,
      factory_id: `fac-${fid}`,
      sku_lines: [{
        component_id: 'main',
        offer_id: `off-${fid}`,
        sku_id: `sku-${fid}`,
        pack_multiple: 1,
        qty_per_saleable_set: 1,
        moq_qty: 10,
        ordered_qty: 100,
        unit_price_cny: goodsTotal / 100,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: goodsTotal,
      domestic_freight_cny_total: 150,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.20,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
      redacted_destination: '广东省深圳市',
      raw_readback_ref: `readback-${fid}`,
      observed_at: '2026-11-24',
      ui_readback: DEFAULT_R59_UI_READBACK,
    });
    const g1aScen = {
      id: 'sc-c1',
      price_usd: 45.00,
      pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
      fx_cny_per_usd: 7.20,
      refund_fraction: 0,
      physical_return_fraction: 0,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
      headhaul_usd: 1.80,
      collection_rate: 0.006,
    };

    const dailyPausedPath = join(dir, 'daily-paused.json');
    writeFileSync(dailyPausedPath, JSON.stringify({
      as_of_date: '2026-11-24',
      items: [
        {
          form: { form_id: 'form-daily-1', label: 'Daily 1', buyer_task: 'Task 1', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          asin: 'B0SYNDAIL1',
          gate1a_scenarios: [g1aScen],
          quote: makeQuote('form-daily-1', 5000),
          scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand1] },
        },
        {
          form: { form_id: 'form-daily-2', label: 'Daily 2', buyer_task: 'Task 2', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          post_url: 'https://www.reddit.com/r/synth/comments/1/post/',
          source_channel: 'reddit',
          gate1a_scenarios: [g1aScen],
          simulate_1688_captcha: true,
        },
      ],
    }, null, 2));

    const rPause = await runCliMem(['daily-batch', '--db', dbPath, '--input', dailyPausedPath]);
    assert.equal(rPause.code, 0, rPause.stderr);
    const parsedPause = JSON.parse(rPause.stdout);
    assert.equal(parsedPause.batch_report.batch_paused, true);
    assert.equal(parsedPause.batch_report.pause_status, 'CAPTCHA_PAUSED');
    assert.equal(parsedPause.batch_report.paused_form_id, 'form-daily-2');
    assert.deepEqual(parsedPause.batch_report.completed_gate1b_form_ids, ['form-daily-1']);

    const rRes1688 = await runCliMem([
      'resume-1688',
      '--db', dbPath,
      '--login-verified',
      '--form', 'form-daily-2',
      '--city', '广东省深圳市',
      '--quantity', '100',
      '--sku', 'main',
      '--validity', '2027-12-31',
      '--as-of', '2026-11-24',
    ]);
    assert.equal(rRes1688.code, 0, rRes1688.stderr);

    const dailyResumedPath = join(dir, 'daily-resumed.json');
    writeFileSync(dailyResumedPath, JSON.stringify({
      as_of_date: '2026-11-24',
      items: [
        {
          form: { form_id: 'form-daily-1', label: 'Daily 1', buyer_task: 'Task 1', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          asin: 'B0SYNDAIL1',
          gate1a_scenarios: [g1aScen],
          scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand1] },
        },
        {
          form: { form_id: 'form-daily-2', label: 'Daily 2', buyer_task: 'Task 2', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          post_url: 'https://www.reddit.com/r/synth/comments/1/post/',
          source_channel: 'reddit',
          gate1a_scenarios: [g1aScen],
          quote: makeQuote('form-daily-2', 4800),
          scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand2] },
        },
      ],
    }, null, 2));

    const rResumed = await runCliMem(['daily-batch', '--db', dbPath, '--input', dailyResumedPath]);
    assert.equal(rResumed.code, 0, rResumed.stderr);
    const parsedResumed = JSON.parse(rResumed.stdout);
    assert.equal(parsedResumed.batch_report.gate2_3.length, 2);
    assert.equal(parsedResumed.batch_report.gate2_3[0].review_visible_state, '业务入围、当前规格待复核', JSON.stringify(parsedResumed.batch_report.gate2_3[0]));
    assert.equal(parsedResumed.batch_report.gate2_3[0].current_spec_review_verified, false);

    const rSkip = await runCliMem(['daily-batch', '--db', dbPath, '--input', dailyResumedPath]);
    assert.equal(rSkip.code, 0, rSkip.stderr);
    const parsedSkip = JSON.parse(rSkip.stdout);
    assert.equal(parsedSkip.batch_report.gate2_3[0].reused_completed_evaluation, true);
    assert.ok(parsedSkip.batch_report.skipped_zero_incremental.some(s => s.stage === 'resume_completed_evaluation_reused'));

    const batchForHtml = { schema_version: 1, profile_revision: 59, candidates: [cand1] };
    const html = renderReport(scoreBatch(batchForHtml, r59Profile), batchForHtml);
    assert.ok(html.includes('业务入围、当前规格待复核'));

    const rev1688Path = join(dir, 'rev1688.json');
    writeFileSync(rev1688Path, JSON.stringify({
      form_id: 'form-rev-1688-1',
      label: '1688 Cold Start Rack',
      buyer_task: 'Store paint bottles',
      pkg: { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.8 },
      fx_cny_per_usd: 7.20,
      headhaul_usd: 2.10,
      mature_price_band: { p25_usd: 39.99, p50_usd: 45.99, p75_usd: 52.99 },
      quote: makeQuote('form-rev-1688-1', 4200),
    }, null, 2));
    const rRev = await runCliMem(['reverse-1688', '--db', dbPath, '--input', rev1688Path]);
    assert.equal(rRev.code, 0, rRev.stderr);
    const parsedRev = JSON.parse(rRev.stdout);
    assert.ok(Number.isFinite(parsedRev.reverse_1688.min_retail_price_for_30pct_usd));
    assert.ok(['below_band_strong_headroom', 'within_mature_band_viable'].includes(parsedRev.reverse_1688.mature_band_comparison));

    const calPath = join(dir, 'cal-track.json');
    writeFileSync(calPath, JSON.stringify({
      records: [
        {
          form_id: 'form-daily-1',
          batch_id: 'batch-step3-test',
          system_verdict: 'full_annual_qualifying',
          core_85_range: [85, 85],
          supported_range: [100, 100],
          pre_ad_margin_range: [0.49, 0.49],
          owner_decision: 'sample_check',
          owner_reason: '核心85分满分且毛利超45%，拿样实测外盒与木料细节。',
          sample_measured_pkg: { length_in: 10.2, width_in: 6.1, height_in: 2.0, weight_lb: 1.25 },
          recalculate_profit_spec: {
            price_usd: 45.00,
            goods_cny_per_unit: 50.00,
            domestic_freight_cny_per_unit: 1.50,
            fx_cny_per_usd: 7.20,
            headhaul_usd: 1.80,
          },
          calibration_note: 'CALIBRATION_NOTE: Batch-1 Terra vs Astra Keepa 1-year curve reading aligned on steady band.',
          near_miss_spot_check: {
            terra_vs_astra_keepa_audit: { aligned: true, delta_usd: 0 },
            near_miss_forms_checked: ['form-bad-kill'],
          },
        },
      ],
    }, null, 2));
    const rCalWrite = await runCliMem(['calibration-track', '--db', dbPath, '--input', calPath]);
    assert.equal(rCalWrite.code, 0, rCalWrite.stderr);
    const parsedCalWrite = JSON.parse(rCalWrite.stdout);
    assert.equal(parsedCalWrite.saved_count, 1);
    assert.equal(parsedCalWrite.saved[0].owner_decision, 'sample_check');
    assert.equal(parsedCalWrite.saved[0].recalculated_margin.meets_30pct_floor, true);

    const rCalList = await runCliMem(['calibration-track', '--db', dbPath, '--list', '--batch-id', 'batch-step3-test']);
    assert.equal(rCalList.code, 0, rCalList.stderr);
    assert.equal(JSON.parse(rCalList.stdout).count, 1);
  });
});

test('Step 3.3: openai-recover & openai-batch-poll CLI commands recover GET /v1/responses/{id} and poll Batch API without duplicate POST', async () => {
  await withTempDirAsync('r59-step3-openai-cli-', async dir => {
    const dbPath = join(dir, 'budget.sqlite');
    const credPath = join(dir, 'cred.json');
    const apiKey = 'sk-proj-Step3SyntheticTestKey0123456789ABCDEF';
    writeFileSync(credPath, JSON.stringify({ api_key: apiKey }));

    const ledgerOpts = { testMode: true, canonicalRegistryPath: join(dir, 'mock-registry.sqlite') };
    const ledger = openOpenAiBudgetLedger(dbPath, ledgerOpts);
    ledger.reconcileLegacySummary(
      {
        recognized_schema: true,
        file_sha256: '0'.repeat(64),
        month_utc: new Date().toISOString().slice(0, 7),
        total_rows: 0,
        status_counts: {},
        unresolved_count: 0,
        blocking_reasons: [],
        has_unresolved_holds: false,
        same_month_reserved_cents: 0,
      },
      {
        accountScope: 'openai-default',
        allowSyntheticSummaryForTests: true,
        enable: true,
        monthlyLimitCents: 20_000,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      },
    );
    const dropClient = new OpenAiClient({
      ledger,
      credentialFile: credPath,
      testMode: true,
      baseUrl: 'https://api.openai.com',
      fetchImpl: async (url, init = {}) => {
        if (String(init.method || 'GET').toUpperCase() === 'POST') {
          return new Response(JSON.stringify({
            id: 'resp_step3_rec_001',
            object: 'response',
            status: 'in_progress',
            model: 'gpt-6.1-terra',
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error('Simulated network drop during background poll');
      },
    });
    let droppedAttemptId = null;
    await assert.rejects(async () => {
      await dropClient.createResponse(
        { model: 'gpt-6.1-terra', input: 'test prompt' },
        { accountScope: 'openai-default', logicalRequestId: 'step3-rec-req-1', background: true, pollIntervalMs: 1 },
      );
    }, err => {
      droppedAttemptId = err?.attempt_id ?? ledger.getAttemptByLogicalId('step3-rec-req-1', { accountScope: 'openai-default' })?.attempt_id ?? null;
      return true;
    });
    assert.ok(droppedAttemptId);
    ledger.close();

    let postCount = 0;
    let getCount = 0;
    const mockFetch = async (url, init = {}) => {
      const m = String(init.method || 'GET').toUpperCase();
      if (m === 'POST') postCount++;
      if (m === 'GET') getCount++;
      const u = String(url);
      if (u.endsWith('/v1/responses/resp_step3_rec_001')) {
        return new Response(JSON.stringify({
          id: 'resp_step3_rec_001',
          object: 'response',
          status: 'completed',
          model: 'gpt-6.1-terra',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
          usage: { input_tokens: 1200, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/v1/batches/batch_step3_001')) {
        return new Response(JSON.stringify({
          id: 'batch_step3_001',
          object: 'batch',
          endpoint: '/v1/responses',
          status: 'in_progress',
          request_counts: { total: 2, completed: 1, failed: 0 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected URL: ${u}`);
    };

    const hooks = {
      testLedgerOptions: ledgerOpts,
      openAiClientOptions: { testMode: true, fetchImpl: mockFetch, baseUrl: 'https://api.openai.com' },
    };

    const recOut = await runCliMem([
      'openai-recover',
      '--db', dbPath,
      '--credential-file', credPath,
      '--attempt', droppedAttemptId,
    ], hooks);
    assert.equal(recOut.code, 0, recOut.stderr);
    assert.equal(postCount, 0, 'openai-recover must NEVER issue a POST');
    assert.equal(getCount, 1);
    const parsedRec = JSON.parse(recOut.stdout);
    assert.equal(parsedRec.recovered, true);
    assert.equal(parsedRec.receipt.status, 'completed');
    assert.ok(parsedRec.receipt.usage_cost_micros > 0);

    const pollOut = await runCliMem([
      'openai-batch-poll',
      '--db', dbPath,
      '--credential-file', credPath,
      '--batch-id', 'batch_step3_001',
    ], hooks);
    assert.equal(pollOut.code, 0, pollOut.stderr);
    assert.equal(JSON.parse(pollOut.stdout).batch_status, 'in_progress');
  });
});

test('Step 4 Sign-Off (#10-#12, R2-B, R3 CLI): pre-write r58 guard, single-product seed/ingest/export, 4-factory CLI rejection, 102/104 remainder reverse-1688, concurrent deferred abort, and deferred export sync', async () => {
  await withTempDirAsync('step4-cli-guards-', async dir => {
    const dbPath = join(dir, 'cli-e2e.sqlite');
    await runCliMem(['init', '--db', dbPath]);

    const g1a58Path = join(dir, 'g1a-58.json');
    writeFileSync(g1a58Path, JSON.stringify({
      form: { form_id: 'form-should-not-write', label: 'No Write', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'u', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 's1', price_usd: 45, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
    }, null, 2));
    assert.equal((await runCliMem(['gate1a', '--db', dbPath, '--input', g1a58Path, '--profile-revision', '58'])).code, 2);
    const checkStore1 = openSelectionStore(dbPath, { readOnly: true });
    assert.equal(checkStore1.getCandidateForm('form-should-not-write'), null);
    checkStore1.close();

    const nonExistentDb = join(dir, 'must-not-be-created.sqlite');
    const dummyG1aPath = join(dir, 'dummy-g1a.json');
    writeFileSync(dummyG1aPath, JSON.stringify({ form_id: 'f-r58', scenarios: [] }), 'utf8');
    assert.equal((await runCliMem(['gate1a', '--db', nonExistentDb, '--input', dummyG1aPath, '--profile-revision', '58'])).code, 2);
    assert.equal(existsSync(nonExistentDb), false, 'Rejected --profile-revision 58 must NOT create a SQLite database file');

    const validFormSpecPath = join(dir, 'g1a-valid.json');
    writeFileSync(validFormSpecPath, JSON.stringify({
      form: { form_id: 'form-g1b-58-guard', label: 'Guard Test', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'u', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 's1', price_usd: 45, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
    }, null, 2));
    assert.equal((await runCliMem(['gate1a', '--db', dbPath, '--input', validFormSpecPath])).code, 0);

    const g1b58Path = join(dir, 'g1b-58.json');
    writeFileSync(g1b58Path, JSON.stringify({
      form_id: 'form-g1b-58-guard',
      quote: {
        quote_id: 'q-should-not-write', observed_at: '2026-11-24', redacted_destination: '广东深圳', raw_readback_ref: 'ref-no',
        fx_cny_per_usd: 7.2, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, goods_first_order_promotion: false, freight_first_order_promotion: false, ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{ component_id: 'u', offer_id: 'o1', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
        goods_cny_total: 4000, domestic_freight_cny_total: 100,
      },
    }, null, 2));
    assert.equal((await runCliMem(['gate1b', '--db', dbPath, '--input', g1b58Path, '--profile-revision', '58'])).code, 2);
    const checkStore2 = openSelectionStore(dbPath, { readOnly: true });
    assert.equal(checkStore2.getQuotesForForm('form-g1b-58-guard').length, 0);
    checkStore2.close();

    const cand = structuredClone(syntheticFixture.candidates[0]);
    cand.id = 'form-single-prod-1';
    const pkgObj = { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 };
    const est = estimateGate1A2027({
      price_usd: 45.00, pkg: pkgObj, fx_cny_per_usd: 7.20, refund_fraction: 0, physical_return_fraction: 0, fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, minimum_referral_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
      headhaul_usd: 1.80, collection_rate: 0.006,
      sales_window: { from: '2027-02-01', through: '2027-10-14' }, storage_window: { from: '2027-02-01', through: '2027-09-30' }, inbound_window: { from: '2027-01-15', through: '2027-10-14' }, profile_revision: 59,
    });
    cand.screening.reference_price_usd.value = 45.00;
    const sc = cand.economics.scenarios[0];
    const pkgRef = sc.cost_ledger.fee_context.package_ref;
    cand.economics.packages = [{ id: pkgRef, ...pkgObj }];
    sc.id = sc.cost_ledger.id = 'sc-sp1';
    sc.quote_id = 'q-sp1';
    sc.cost_ledger.price_usd = 45.00; sc.cost_ledger.fx_cny_per_usd = 7.20; sc.cost_ledger.refund_fraction = 0; sc.cost_ledger.physical_return_fraction = 0;
    sc.cost_ledger.source_inputs = { quote_id: 'q-sp1', fx_cny_per_usd: 7.20, order_units: 100, goods_cny_total: 5000, domestic_freight_cny_total: 150 };
    sc.cost_ledger.fee_context = { marketplace: 'US', currency: 'USD', package_ref: pkgRef, sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } };
    for (const line of sc.cost_ledger.lines) {
      if (line.id === 'procurement') { line.amount_usd = Number((50 / 7.20).toFixed(6)); line.order_units = 100; line.fx_cny_per_usd = 7.20; line.status = 'sourced'; }
      else if (line.id === 'domestic_freight') { line.amount_usd = Number((1.5 / 7.20).toFixed(6)); line.order_units = 100; line.fx_cny_per_usd = 7.20; line.status = 'sourced'; }
      else if (line.id === 'headhaul') line.amount_usd = 1.80;
      else if (line.id === 'referral') { line.amount_usd = est.components.referral.net_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-01-15'; line.fee_basis.effective_through = '2027-12-31'; line.fee_basis.referral_fraction = 0.15; line.fee_basis.minimum_referral_usd = 0.30; line.fee_basis.refund_admin_fraction = 0.20; line.fee_basis.refund_admin_cap_usd = 5.00; } }
      else if (line.id === 'fulfillment') { line.amount_usd = est.components.fulfillment.total_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-01-15'; line.fee_basis.effective_through = '2027-10-14'; } }
      else if (line.id === 'placement') { line.amount_usd = est.components.placement.selected_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-01-15'; line.fee_basis.effective_through = '2027-10-14'; } }
      else if (line.id === 'storage') { line.amount_usd = est.components.storage.per_unit_usd; if (line.fee_basis) { line.fee_basis.effective_from = '2027-02-01'; line.fee_basis.effective_through = '2027-09-30'; line.fee_basis.cubic_feet_per_unit = est.components.storage.cubic_feet; line.fee_basis.rate_usd_per_cuft_month = est.components.storage.rate_usd_per_cuft_month; line.fee_basis.average_inventory_days = 45; } }
      else if (line.id === 'returns_processing') { line.amount_usd = 0; line.return_threshold = 0.081; if (line.fee_basis) { line.fee_basis.effective_from = '2027-02-01'; line.fee_basis.effective_through = '2027-12-31'; line.fee_basis.fee_category = 'Home and Kitchen'; line.fee_basis.return_threshold = 0.081; } }
      else if (line.id === 'collection') { line.amount_usd = est.components.collection.collection_usd; line.rate = 0.006; }
    }
    delete sc.margin;
    delete sc.contribution_usd;

    const singleProdPath = join(dir, 'single-product-in.json');
    writeFileSync(singleProdPath, JSON.stringify({
      as_of_date: '2026-11-24',
      form: { form_id: 'form-single-prod-1', label: 'Single Product CLI Test', buyer_task: 'Organize desk', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
      asin: 'B0SYNSING1',
      gate1a_scenarios: [{ id: 'sc-sp1', price_usd: 45.00, pkg: pkgObj, fx_cny_per_usd: 7.20, refund_fraction: 0, physical_return_fraction: 0, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 }, headhaul_usd: 1.80, collection_rate: 0.006 }],
      quote: { quote_id: 'q-sp1', factory_id: 'fac-sp1', observed_at: '2026-11-24', redacted_destination: '广东省深圳市', raw_readback_ref: 'ref-sp1', fx_cny_per_usd: 7.20, pkg: pkgObj, goods_first_order_promotion: false, freight_first_order_promotion: false, ui_readback: DEFAULT_R59_UI_READBACK, sku_lines: [{ component_id: 'main', offer_id: 'off-sp1', sku_id: 'sku-sp1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 50, regular_goods_promo_false: true }], goods_cny_total: 5000, domestic_freight_cny_total: 150 },
      scored_batch: { schema_version: 1, profile_revision: 59, candidates: [cand] },
    }, null, 2));
    const rSingle = await runCliMem(['single-product', '--db', dbPath, '--input', singleProdPath]);
    assert.equal(rSingle.code, 0, rSingle.stderr);
    assert.equal(JSON.parse(rSingle.stdout).batch_report.evaluations.length, 1);

    const batchJsonPath = join(dir, 'single-batch.json');
    writeFileSync(batchJsonPath, JSON.stringify({ schema_version: 1, profile_revision: 59, candidates: [cand] }, null, 2));
    const reportOutDir = join(dir, 'single-report');
    const rExport = await runCliMem(['export-report', '--db', dbPath, '--batch', batchJsonPath, '--profile', join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'), '--output', reportOutDir]);
    assert.equal(rExport.code, 0, rExport.stderr);
    assert.equal(JSON.parse(readFileSync(join(reportOutDir, 'result.json'), 'utf8')).candidates[0].candidate_id, 'form-single-prod-1');
    assert.ok(readFileSync(join(reportOutDir, 'index.html'), 'utf8').length > 10_000);

    // Concurrent deferred during Gate 4
    const raceDbPath = join(dir, 'race-g4.sqlite');
    const storeA = openSelectionStore(raceDbPath);
    const storeB = openSelectionStore(raceDbPath);
    try {
      const candRace = structuredClone(cand);
      candRace.id = 'form-race-defer';
      candRace.economics.scenarios[0].quote_id = 'q-race-1';
      candRace.economics.scenarios[0].cost_ledger.source_inputs.quote_id = 'q-race-1';
      const raceRes = await runPhase2Batch(storeA, {
        profile: r59Profile, as_of_date: '2026-11-24',
        openai_hooks: { evidence_review: { enabled: true, testMode: true, receiptDir: join(dir, 'race-receipts'), reviewExecutor: async () => { storeB.updateFormLifecycle('form-race-defer', 'deferred'); return { status: 'unavailable', execution_status: 'not_submitted', reason: 'mock' }; } } },
        items: [{
          form: { form_id: 'form-race-defer', label: 'Race Defer', buyer_task: 'Organize desk', saleable_set_composition: [{ component_id: 'main', qty_per_saleable_set: 1 }] },
          leads: [{ lead_id: 'ld-race', source_channel: 'reddit', source_ref: 'https://example.com/race', phrase_or_title: 'desk rack', observed_at: '2026-11-24', disposition: 'product' }],
          gate1a_scenarios: [{ id: 'sc-sp1', price_usd: 45.00, pkg: pkgObj, fx_cny_per_usd: 7.20, refund_fraction: 0, physical_return_fraction: 0, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 }, headhaul_usd: 1.80, collection_rate: 0.006 }],
          sourcing_executor: async () => ({ status: 'quoted', quote: { quote_id: 'q-race-1', factory_id: 'fac-race-1', observed_at: '2026-11-24', redacted_destination: '广东省深圳市', raw_readback_ref: 'ref-race', fx_cny_per_usd: 7.20, pkg: pkgObj, goods_first_order_promotion: false, freight_first_order_promotion: false, ui_readback: DEFAULT_R59_UI_READBACK, sku_lines: [{ component_id: 'main', offer_id: 'off-r1', sku_id: 'sku-r1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 50, regular_goods_promo_false: true }], goods_cny_total: 5000, domestic_freight_cny_total: 150 } }),
          early_screen_builder: () => ({ profile_revision: 59, id: 'sc-sp1', saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.20, pkg: pkgObj, headhaul: { usd_per_unit: 1.80, bond_included: true }, refund_fraction: 0, physical_return_fraction: 0, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false, referral_terms: { referral_fraction: 0.15, minimum_referral_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 }, fulfillment_usd: est.components.fulfillment.total_usd, placement_usd: est.components.placement.selected_usd, storage: { cubic_feet_per_unit: est.components.storage.cubic_feet, rate_usd_per_cuft_month: est.components.storage.rate_usd_per_cuft_month, average_inventory_days: 45 }, operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9], fee_context: { marketplace: 'US', currency: 'USD', package_ref: pkgRef, sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } }, collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false }),
          deep_research_executor: async () => ({
            batch: { schema_version: 1, profile_revision: 59, candidates: [candRace] },
            evidence_review_packet: { schema_version: 'evidence-review-draft-v1', review_id: 'rev-race-defer', execution_policy_ref: 'local-policy-only', candidate: { subject_id: 'form-race-defer', intended_use: 'Organize desk', saleable_spec: { qty_per_saleable_set: 1 }, unknown_fields: [] }, subjects: [{ subject_id: 'desk', spec: { qty: 1 } }], criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'fit', description: 'Fit', required: true }] }, questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['desk'], criterion_ids: ['fit'] }], evidence: [{ evidence_id: 'e1', subject_ids: ['desk'], summary: 'Control.', kind: 'fact', source_ref: 'r1', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }] },
          }),
        }],
      });
      assert.equal(raceRes.gate2_3[0].status, 'deferred');
      assert.equal(storeA.getCandidateForm('form-race-defer').lifecycle_status, 'deferred');
      assert.equal(storeA.getEvaluationsForForm('form-race-defer').length, 0);
    } finally {
      storeA.close();
      storeB.close();
    }

    // reverse-1688 221-set + 102/104 remainder + missing freight; 4-factory CLI batch & sequential rejection; iter deferred abort; bare asin seed; raw ingest report & deferred export sync
    const cliDb = join(dir, 'cli-r2.sqlite');
    await runCliMem(['init', '--db', cliDb]);
    const rev221SpecPath = join(dir, 'rev-221.json');
    writeFileSync(rev221SpecPath, JSON.stringify({
      fx_cny_per_usd: 7.20, pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, headhaul_usd: 2.20,
      saleable_set_composition: [{ component_id: 'body', qty_per_saleable_set: 1 }, { component_id: 'lid', qty_per_saleable_set: 1 }],
      quote: { goods_cny_total: 22100, domestic_freight_cny_total: 150, sku_lines: [{ component_id: 'body', offer_id: 'o17', sku_id: 's17', pack_multiple: 17, qty_per_saleable_set: 1, moq_qty: 17, ordered_qty: 221, unit_price_cny: 60 }, { component_id: 'lid', offer_id: 'o13', sku_id: 's13', pack_multiple: 13, qty_per_saleable_set: 1, moq_qty: 13, ordered_qty: 221, unit_price_cny: 40 }] },
    }), 'utf8');
    const revDerivedJson = JSON.parse((await runCliMem(['reverse-1688', '--db', cliDb, '--input', rev221SpecPath])).stdout);
    assert.equal(revDerivedJson.reverse_1688.actual_complete_sets_used, 221);
    const revExplicit221Path = join(dir, 'rev-221-explicit.json');
    const explicit221Payload = JSON.parse(readFileSync(rev221SpecPath, 'utf8'));
    explicit221Payload.quote.actual_complete_sets = 221;
    writeFileSync(revExplicit221Path, JSON.stringify(explicit221Payload), 'utf8');
    const revExplicit221Json = JSON.parse((await runCliMem(['reverse-1688', '--db', cliDb, '--input', revExplicit221Path])).stdout);
    assert.equal(revDerivedJson.reverse_1688.min_retail_price_for_30pct_usd, revExplicit221Json.reverse_1688.min_retail_price_for_30pct_usd);

    const revMissingFreightPath = join(dir, 'rev-no-freight.json');
    writeFileSync(revMissingFreightPath, JSON.stringify({ fx_cny_per_usd: 7.20, pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, quote: { goods_cny_total: 10000 } }), 'utf8');
    assert.equal(JSON.parse((await runCliMem(['reverse-1688', '--db', cliDb, '--input', revMissingFreightPath])).stdout).reverse_1688.min_retail_price_for_30pct_usd, null);

    const rev102Path = join(dir, 'rev-102.json');
    writeFileSync(rev102Path, JSON.stringify({
      fx_cny_per_usd: 7.20, pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 }, headhaul_usd: 2.20,
      quote: { allow_remainder: true, goods_cny_total: 10300, domestic_freight_cny_total: 150, sku_lines: [{ component_id: 'body', offer_id: 'o17', sku_id: 's17', pack_multiple: 17, qty_per_saleable_set: 1, moq_qty: 17, ordered_qty: 102, unit_price_cny: 60 }, { component_id: 'lid', offer_id: 'o13', sku_id: 's13', pack_multiple: 13, qty_per_saleable_set: 1, moq_qty: 13, ordered_qty: 104, unit_price_cny: 40 }] },
    }), 'utf8');
    assert.equal(JSON.parse((await runCliMem(['reverse-1688', '--db', cliDb, '--input', rev102Path])).stdout).reverse_1688.actual_complete_sets_used, 102);

    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const g1aSpec4Path = join(dir, 'g1a-4fac.json');
    writeFileSync(g1aSpec4Path, JSON.stringify({
      form: { form_id: 'form-4fac-cli', product_family_key: 'form-4fac-cli', label: '4-factory CLI guard', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 'sc-4fac', price_usd: 45.00, available_date: '2025-01-01', pkg, fx_cny_per_usd: 7.20, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 }, headhaul_usd: 1.50, collection_rate: 0.006, other_applicable_usd: 0 }],
    }), 'utf8');
    const decl = JSON.parse((await runCliMem(['gate1a', '--db', cliDb, '--input', g1aSpec4Path])).stdout).result.declared_scenarios[0];
    const mkCliQ = (id, facId) => ({
      quote_id: id, factory_id: facId, observed_at: '2026-11-24T10:00:00Z', redacted_destination: '广东深圳', raw_readback_ref: `ref-${id}`,
      goods_first_order_promotion: false, freight_first_order_promotion: false, fx_cny_per_usd: 7.20, pkg, ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: `off-${id}`, sku_id: `sku-${id}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
      goods_cny_total: 4000, domestic_freight_cny_total: 200,
    });
    const es4 = [{
      profile_revision: 59, id: decl.id, saleable_unit: '1 unit', price_usd: decl.price_usd, fx_cny_per_usd: decl.fx_cny_per_usd, pkg,
      headhaul: { usd_per_unit: decl.headhaul_usd, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      fulfillment_usd: decl.fulfillment_usd, placement_usd: decl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: (12 * 8 * 4) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
      collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
    }];
    const g1b4Path = join(dir, 'g1b-4fac.json');
    writeFileSync(g1b4Path, JSON.stringify({ form_id: 'form-4fac-cli', quotes: [mkCliQ('q4-1', 'fac-1'), mkCliQ('q4-2', 'fac-2'), mkCliQ('q4-3', 'fac-3'), mkCliQ('q4-4', 'fac-4')], early_screen_scenarios: es4 }), 'utf8');
    assert.equal((await runCliMem(['gate1b', '--db', cliDb, '--input', g1b4Path])).code, 2);
    const checkSt = openSelectionStore(cliDb, { readOnly: true });
    assert.equal(checkSt.getQuotesForForm('form-4fac-cli').length, 0);
    checkSt.close();

    const g1aSeqPath = join(dir, 'g1a-seq4.json');
    writeFileSync(g1aSeqPath, JSON.stringify({
      form: { form_id: 'form-seq-4', product_family_key: 'form-seq-4', label: 'Seq 4', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] },
      scenarios: [{ id: 'sc-s4', price_usd: 45, available_date: '2025-01-01', pkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 }, headhaul_usd: 1.5, collection_rate: 0.006, other_applicable_usd: 0 }],
    }), 'utf8');
    const declSeq = JSON.parse((await runCliMem(['gate1a', '--db', cliDb, '--input', g1aSeqPath])).stdout).result.declared_scenarios[0];
    const esSeq = [{ ...es4[0], id: declSeq.id, fulfillment_usd: declSeq.fulfillment_usd, placement_usd: declSeq.placement_range_usd[1] }];
    for (let k = 1; k <= 4; k++) {
      const qPath = join(dir, `seq-q${k}.json`);
      writeFileSync(qPath, JSON.stringify({ form_id: 'form-seq-4', quote: { ...mkCliQ(`qs-${k}`, `fac-seq-${k}`), goods_cny_total: 14000, domestic_freight_cny_total: 300, sku_lines: [{ ...mkCliQ(`qs-${k}`, `fac-seq-${k}`).sku_lines[0], unit_price_cny: 140 }] }, early_screen_scenarios: esSeq }), 'utf8');
      const qRes = await runCliMem(['gate1b', '--db', cliDb, '--input', qPath]);
      assert.equal(qRes.code, k <= 3 ? 0 : 2);
    }

    const iterDb = join(dir, 'iter-defer.sqlite');
    const stMain = openSelectionStore(iterDb);
    const stPeer = openSelectionStore(iterDb);
    try {
      stMain.upsertCandidateForm({ form_id: 'form-iter-defer', product_family_key: 'form-iter-defer', label: 'Iter defer guard', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] });
      const dIter = runGate1AForForm(stMain, {
        form_id: 'form-iter-defer', profile_revision: 59,
        scenarios: [{ id: 'sc-iter', price_usd: 45.00, available_date: '2025-01-01', pkg, fx_cny_per_usd: 7.20, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 }, headhaul_usd: 1.50, collection_rate: 0.006, other_applicable_usd: 0 }],
      }).declared_scenarios[0];
      let iterCalls = 0;
      const iterRes = await runGate1BForForm(stMain, {
        form_id: 'form-iter-defer', profile_revision: 59, as_of_date: '2026-11-24',
        sourcing_executor: async () => {
          iterCalls += 1;
          if (iterCalls === 1) return { status: 'quoted', has_more_factories: true, quote: { ...mkCliQ('q-it-1', 'fac-it-1'), goods_cny_total: 14000, sku_lines: [{ ...mkCliQ('q-it-1', 'fac-it-1').sku_lines[0], unit_price_cny: 140 }] } };
          if (iterCalls === 2) { stPeer.updateFormLifecycle('form-iter-defer', 'deferred', {}); return { status: 'quoted', has_more_factories: true, quote: mkCliQ('q-it-2', 'fac-it-2') }; }
          return { status: 'quoted', quote: mkCliQ('q-it-3', 'fac-it-3') };
        },
        early_screen_builder: () => [{ ...es4[0], id: dIter.id, fulfillment_usd: dIter.fulfillment_usd, placement_usd: dIter.placement_range_usd[1] }],
      });
      assert.equal(iterRes.status, 'deferred');
      assert.equal(iterCalls, 2);
      assert.equal(stMain.getQuotesForForm('form-iter-defer').length, 1);
    } finally {
      stMain.close();
      stPeer.close();
    }

    const bareAsinPath = join(dir, 'bare-asin.json');
    writeFileSync(bareAsinPath, JSON.stringify({ asin: 'B0SYNV400D' }), 'utf8');
    const bareJson = JSON.parse((await runCliMem(['single-product', '--db', cliDb, '--input', bareAsinPath])).stdout);
    assert.equal(bareJson.mode, 'seed_registered_awaiting_gate1a');
    assert.equal(bareJson.form_id, 'form-b0synv400d');

    writeFileSync(join(dir, 'sp-raw-r1.json'), JSON.stringify({ code: 'OK', items: [{ asin: 'B000000001', price: 40.00 }] }), 'utf8');
    const stLedger = openSelectionStore(cliDb);
    const att = stLedger.reserveRequestAttempt({ account_scope: 'r3-test', provider: 'sellersprite', tool_name: 'product_research', observation_cutoff_date: '2026-11-24', params: { asin: 'B000000001' }, estimated_ss_mcp_units: 1 });
    stLedger.markAttemptInFlight(att.attempt_id);
    stLedger.completeAttempt(att.attempt_id, { payload: { code: 'OK', items: [{ asin: 'B000000001', price: 40.00 }] }, ss_mcp_units: 1 });
    stLedger.close();

    const spRawCand = structuredClone(syntheticFixture.candidates[0]);
    spRawCand.id = 'form-sp-raw-1';
    spRawCand.screening.reference_price_usd.target_variant_asin = 'B000000001';
    const spRawSpecPath = join(dir, 'sp-raw-spec.json');
    writeFileSync(spRawSpecPath, JSON.stringify({ profile_revision: 59, raw_receipt_files: ['sp-raw-r1.json'], candidates: [{ candidate: spRawCand, raw_receipt_files: ['sp-raw-r1.json'] }] }), 'utf8');
    const spRawRepDir = join(dir, 'sp-raw-report');
    const spRawRes = await runCliMem(['single-product', '--db', cliDb, '--input', spRawSpecPath, '--report-dir', spRawRepDir]);
    assert.equal(spRawRes.code, 0, spRawRes.stderr);
    assert.equal(JSON.parse(spRawRes.stdout).summary.qualifying, 1);
    assert.equal(existsSync(join(spRawRepDir, 'index.html')), true);

    const stDefer = openSelectionStore(cliDb);
    stDefer.updateFormLifecycle('form-sp-raw-1', 'deferred', {});
    stDefer.close();
    const batchForDefPath = join(dir, 'batch-def.json');
    writeFileSync(batchForDefPath, JSON.stringify({ schema_version: 1, profile_revision: 59, candidates: [spRawCand] }), 'utf8');
    const defRepDir = join(dir, 'def-report');
    const defExpRes = await runCliMem(['export-report', '--db', cliDb, '--batch', batchForDefPath, '--profile', join(REPO_ROOT, 'docs/design/reference-profile.r59.draft.json'), '--output', defRepDir]);
    assert.equal(defExpRes.code, 0, defExpRes.stderr);
    const defExpJson = JSON.parse(defExpRes.stdout);
    assert.equal(defExpJson.summary.qualifying, 0, 'Deferred SQLite form must NOT export as qualifying');
    assert.equal(defExpJson.summary.deferred, 1);
  });
});

test('Phase-2 CLI & replay: serve-report --check, contact-sheet UNKNOWN default, non-canonical --db guard, redteam-review skip, coupon Gate 1A/1B, and replaySpecSha preservation', async () => {
  await withTempDirAsync('phase2-cli-r1-r3-', async dir => {
    const html = renderReport(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [syntheticFixture.candidates[0]] }, r59Profile), { candidates: [syntheticFixture.candidates[0]] });
    writeFileSync(join(dir, 'index.html'), html, 'utf8');
    const serveRes = await runCliMem(['serve-report', '--dir', dir, '--check']);
    assert.equal(serveRes.code, 0, serveRes.stderr);
    const parsedServe = JSON.parse(serveRes.stdout);
    assert.equal(parsedServe.verified_http_status, 200);
    assert.match(parsedServe.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);

    const csIn = join(dir, 'cs-unknown.json');
    const csOut = join(dir, 'cs-unknown.png');
    const csMan = join(dir, 'cs-unknown-manifest.json');
    writeFileSync(csIn, JSON.stringify({
      title: 'Unknown Fulfillment Check',
      items: [{ asin: 'B0SYNUNK01', title: 'Synthetic Stand', price_usd: 45.99, monthly_units: 90 }],
    }), 'utf8');
    const csCli = await runCliMem(['contact-sheet', '--input', csIn, '--output', csOut, '--manifest-out', csMan, '--offline']);
    assert.equal(csCli.code, 0, csCli.stderr);
    const csManJson = JSON.parse(readFileSync(csMan, 'utf8'));
    assert.equal(csManJson.rows[0].fulfillment, 'UNKNOWN');

    const trialDbPath = join(dir, 'trial-custom.sqlite');
    const credPath = join(dir, 'synth-cred.json');
    const peersPath = join(dir, 'synth-peers.json');
    writeFileSync(credPath, JSON.stringify({ api_key: ['mock', 'cred'].join('-') }), 'utf8');
    writeFileSync(peersPath, JSON.stringify([{ candidate_id: 'B0SYNPEER1', title: 'Organizer', fulfillment: 'FBA', price_usd: 42 }]), 'utf8');
    const liveGuardRes = await runCliMem([
      'luna-triage',
      '--db', trialDbPath,
      '--credential-file', credPath,
      '--listings', peersPath,
      '--output', join(dir, 'triage-blocked.json'),
    ]);
    assert.equal(liveGuardRes.code, 2);
    assert.match(liveGuardRes.stderr, /budget-db|selection\.sqlite/);

    const m4Store = openSelectionStore(trialDbPath);
    m4Store.upsertCandidateForm({ form_id: 'cand-1', label: 'Eliminated Form', buyer_task: 'Hold tools', saleable_set_composition: [{ component_id: 'c', qty_per_saleable_set: 1 }] });
    m4Store.updateFormLifecycle('cand-1', 'gate1b_rejected');
    m4Store.close();
    const m4PacketPath = join(dir, 'm4-packet.json');
    const m4OutPath = join(dir, 'm4-out.json');
    writeFileSync(m4PacketPath, JSON.stringify({
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-m4-skip',
      execution_policy_ref: 'local-policy-only',
      candidate: { subject_id: 'cand-1', intended_use: 'Hold tools', saleable_spec: { pcs: 1 }, unknown_fields: [] },
      subjects: [{ subject_id: 'sub-1', spec: { pcs: 1 } }],
      criteria: { criteria_version: 'v1', rules: [{ criterion_id: 'c1', description: 'Match', required: true }] },
      questions: [{ question_id: 'q1', question: 'Match?', subject_ids: ['sub-1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['sub-1'], summary: 'Fact', kind: 'fact', source_ref: 'ref-1', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
    }), 'utf8');
    let m4CodexCalled = false;
    const m4Cli = await runCliMem(
      ['redteam-review', '--db', trialDbPath, '--packet', m4PacketPath, '--output', m4OutPath],
      { codexMockExecutor: async () => { m4CodexCalled = true; return { exitCode: 0 }; } },
    );
    assert.equal(m4Cli.code, 0, m4Cli.stderr);
    assert.equal(m4CodexCalled, false);
    assert.equal(JSON.parse(m4Cli.stdout).skipped_non_qualifying, true);

    const r2DbPath = join(dir, 'r2-gate.sqlite');
    const r2Init = await runCliMem(['init', '--db', r2DbPath]);
    assert.equal(r2Init.code, 0);
    const couponG1aPath = join(dir, 'coupon-g1a.json');
    const stdPkg = { length_in: 14, width_in: 10, height_in: 3, unit_weight_lb: 1.4 };
    writeFileSync(couponG1aPath, JSON.stringify({
      form: { form_id: 'form-r2-coupon', label: 'Coupon Form', buyer_task: 'Organize cables', saleable_set_composition: [{ component_id: 'box', qty_per_saleable_set: 1 }] },
      scenarios: [{
        id: 'sc-cpn-4499',
        list_price_usd: 54.99,
        ongoing_coupon_usd: 10.00,
        price_usd: 44.99,
        promo_basis_already_net: true,
        pkg: stdPkg,
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
        headhaul_usd: 1.8,
        collection_rate: 0.006,
      }],
    }), 'utf8');
    const cpnCliRes = await runCliMem(['gate1a', '--db', r2DbPath, '--input', couponG1aPath, '--profile-revision', '59']);
    assert.equal(cpnCliRes.code, 0, cpnCliRes.stderr);
    const cpnCliParsed = JSON.parse(cpnCliRes.stdout);
    assert.equal(cpnCliParsed.result.gate_status, 'gate1a_passed');
    assert.equal(cpnCliParsed.result.declared_scenarios[0].coupon_fee_usd, 1.17475);

    const r2Store = openSelectionStore(r2DbPath);
    try {
      const droppedCpnG1b = await runGate1BForForm(r2Store, {
        form_id: 'form-r2-coupon',
        profile_revision: 59,
        as_of_date: '2026-11-24',
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-cpn-1',
            observed_at: '2026-11-24',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-cpn-1',
            fx_cny_per_usd: 7.2,
            pkg: stdPkg,
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            ui_readback: DEFAULT_R59_UI_READBACK,
            sku_lines: [{ component_id: 'box', offer_id: 'oc1', sku_id: 'sc1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
            goods_cny_total: 10000,
            domestic_freight_cny_total: 200,
          },
        }),
        early_screen_builder: () => [{
          id: 'sc-cpn-4499',
          saleable_unit: '1 unit',
          price_usd: 44.99,
          fx_cny_per_usd: 7.2,
          pkg: stdPkg,
          headhaul: { usd_per_unit: 1.8, bond_included: true },
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          is_apparel_or_shoes: false,
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
          fulfillment_usd: cpnCliParsed.result.declared_scenarios[0].fulfillment_usd,
          placement_usd: cpnCliParsed.result.declared_scenarios[0].placement_range_usd[1],
          storage: { cubic_feet_per_unit: (14 * 10 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: {
            marketplace: 'US', currency: 'USD', package_ref: 'p1',
            sales: { from: '2027-02-01', through: '2027-10-14' },
            storage: { from: '2027-02-01', through: '2027-09-30' },
            inbound: { from: '2027-01-15', through: '2027-10-14' },
          },
          collection_rate: 0.006,
          other_applicable_usd: 0,
          specific_rights_conflict: 'unknown',
          strong_date_dependency: false,
        }],
      });
      assert.equal(droppedCpnG1b.status, 'gate1b_pending');
      assert.equal(droppedCpnG1b.proceed_to_gate2_3, false);
      assert.match(JSON.stringify(droppedCpnG1b), /ongoing coupon redemption fee/i);

      const cand0Id = syntheticFixture.candidates[0].id;
      r2Store.upsertCandidateForm({
        form_id: cand0Id,
        label: 'Upgraded 2-Pack Spec',
        buyer_task: syntheticFixture.candidates[0].buyer_task ?? 'Upgraded task',
        saleable_set_composition: { saleable_unit: '2-pack upgraded set' },
      });
      const upgradedLiveForm = r2Store.getCandidateForm(cand0Id);
      replayBatchIntoStore(r2Store, {
        batch: syntheticFixture,
        profile: r59Profile,
      });
      const repEv = r2Store.getEvaluationsForForm(cand0Id)[0];
      assert.ok(repEv);
      const repReceipt = JSON.parse(repEv.receipt_json);
      assert.notEqual(repReceipt.form_spec_sha256, upgradedLiveForm.spec_sha256);
    } finally {
      r2Store.close();
    }
  });
});

test('Issue #55 & Step 2 CLI: daily-batch supports uncapped --input vs explicit --limit, --from-store --limit 10 with pending-pool isolation, --dry-run, CAPTCHA_PAUSED guard, and README smoke example', async () => {
  await withTempDirAsync('issue55-daily-batch-', async dir => {
    const mkInputItem = idx => ({
      form: {
        form_id: `form-i55-${String(idx).padStart(2, '0')}`,
        product_family_key: `fam-i55-${idx}`,
        label: `Synthetic Item ${idx}`,
        buyer_task: 'Sort workshop tools',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      },
      asin: `B0I55000${String(idx).padStart(2, '0')}`,
      gate1a_scenarios: [{
        id: 'sc-40',
        price_usd: 40,
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
        sales_window: { from: '2027-02-01', through: '2027-10-14' },
        storage_window: { from: '2027-02-01', through: '2027-09-30' },
        inbound_window: { from: '2027-01-15', through: '2027-10-14' },
      }],
    });

    const elevenPath = join(dir, 'eleven.json');
    writeFileSync(elevenPath, JSON.stringify({
      as_of_date: '2026-11-27',
      items: Array.from({ length: 11 }, (_, i) => mkInputItem(i + 1)),
    }, null, 2));

    // 1. --input without --limit remains uncapped (11 items -> 11 ingested)
    const rUncapped = await runCliMem(['daily-batch', '--db', ':memory:', '--input', elevenPath]);
    assert.equal(rUncapped.code, 0, rUncapped.stderr);
    const jUncapped = JSON.parse(rUncapped.stdout);
    assert.equal(jUncapped.mode, 'input_batch');
    assert.equal(jUncapped.input_item_count, 11);
    assert.equal(jUncapped.limit_applied, null);
    assert.equal(jUncapped.selected_count, 11);
    assert.equal(jUncapped.truncated_by_limit, false);
    assert.equal(jUncapped.batch_report.ingested.length, 11);

    // 2. --input with explicit --limit 10 slices cleanly and reports metadata
    const rLimited = await runCliMem(['daily-batch', '--db', ':memory:', '--input', elevenPath, '--limit', '10']);
    assert.equal(rLimited.code, 0, rLimited.stderr);
    const jLimited = JSON.parse(rLimited.stdout);
    assert.equal(jLimited.input_item_count, 11);
    assert.equal(jLimited.limit_applied, 10);
    assert.equal(jLimited.selected_count, 10);
    assert.equal(jLimited.truncated_by_limit, true);
    assert.equal(jLimited.batch_report.ingested.length, 10);

    // 3. Invalid flags & flag combos exit 2
    for (const badArgs of [
      ['daily-batch', '--db', ':memory:', '--input', elevenPath, '--limit', '0'],
      ['daily-batch', '--db', ':memory:', '--input', elevenPath, '--limit', 'abc'],
      ['daily-batch', '--db', ':memory:', '--from-store', '--input', elevenPath],
      ['daily-batch', '--db', ':memory:', '--pending-pool'],
      ['daily-batch', '--db', ':memory:', '--include-shown'],
      ['daily-batch', '--db', ':memory:', '--from-store', '--pending-pool', '--include-shown'],
      ['single-product', '--db', ':memory:', '--from-store'],
      ['single-product', '--db', ':memory:', '--input', elevenPath, '--limit', '1'],
    ]) {
      const rBad = await runCliMem(badArgs);
      assert.equal(rBad.code, 2, `Expected exit 2 for ${badArgs.join(' ')}`);
    }

    // 4. --from-store queue pulling, pending-pool isolation, --dry-run, and CAPTCHA_PAUSED
    const storeDbPath = join(dir, 'store-queue.sqlite');
    const st = openSelectionStore(storeDbPath);
    for (let i = 1; i <= 12; i++) {
      st.upsertCandidateForm({
        form_id: `form-q-${String(i).padStart(2, '0')}`,
        product_family_key: `fam-q-${i}`,
        label: `Queue Form ${i}`,
        buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
        lifecycle_status: i <= 2 ? 'discovered' : 'gate1a_needs_verification',
      });
    }
    st.upsertCandidateForm({
      form_id: 'form-q-rejected',
      product_family_key: 'fam-q-rej',
      label: 'Rejected',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      lifecycle_status: 'gate1a_rejected',
    });
    st.close();

    // --dry-run does not mark presented
    const rDry = await runCliMem(['daily-batch', '--db', storeDbPath, '--from-store', '--dry-run']);
    assert.equal(rDry.code, 0, rDry.stderr);
    const jDry = JSON.parse(rDry.stdout);
    assert.equal(jDry.limit, 10);
    assert.equal(jDry.dry_run, true);
    assert.equal(jDry.marked_presented, false);
    assert.equal(jDry.selected_count, 10);

    // Real pull 1 marks first 10
    const rPull1 = await runCliMem(['daily-batch', '--db', storeDbPath, '--from-store']);
    assert.equal(rPull1.code, 0, rPull1.stderr);
    const jPull1 = JSON.parse(rPull1.stdout);
    assert.equal(jPull1.marked_presented, true);
    assert.equal(jPull1.selected_count, 10);
    assert.equal(jPull1.unseen_eligible_count, 12);

    // Real pull 2 skips the 10 shown undecided cards -> returns remaining 2 unseen
    const rPull2 = await runCliMem(['daily-batch', '--db', storeDbPath, '--from-store', '--limit', '10']);
    assert.equal(rPull2.code, 0, rPull2.stderr);
    const jPull2 = JSON.parse(rPull2.stdout);
    assert.equal(jPull2.selected_count, 2);
    assert.equal(jPull2.pending_pool_skipped_count, 10);
    assert.equal(jPull2.pending_pool_form_ids.length, 10);

    // Confirm 8 of the 10 from pull 1, leaving 2 in pending_pool; verify --pending-pool returns those 2
    const stConf = openSelectionStore(storeDbPath);
    for (const s of jPull1.selected_forms.slice(0, 8)) {
      stConf.upsertCalibrationTracking({
        form_id: s.form_id,
        system_verdict: 'pending_evidence',
        owner_decision: 'drop',
        owner_decision_source: 'owner_confirmed',
      });
    }
    stConf.close();

    const rPending = await runCliMem(['daily-batch', '--db', storeDbPath, '--from-store', '--pending-pool', '--limit', '10']);
    assert.equal(rPending.code, 0, rPending.stderr);
    const jPending = JSON.parse(rPending.stdout);
    // 2 remaining undecided from pull 1 + 2 shown by pull 2 = 4 in pending_pool
    assert.equal(jPending.selected_count, 4);
    assert.deepEqual(
      jPending.selected_forms.map(x => x.form_id).sort(),
      [...jPull1.selected_forms.slice(8, 10), ...jPull2.selected_forms].map(x => x.form_id).sort(),
    );

    // CAPTCHA_PAUSED blocks marking presented on non-dry-run --from-store
    const stPause = openSelectionStore(storeDbPath);
    stPause.upsertCandidateForm({
      form_id: 'form-q-unseen-after-pause',
      product_family_key: 'fam-q-p',
      label: 'Unseen Paused',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      lifecycle_status: 'discovered',
    });
    stPause.pauseQueue('gate1b_1688_queue', '1688 slider active');
    stPause.close();

    const rPaused = await runCliMem(['daily-batch', '--db', storeDbPath, '--from-store', '--limit', '10']);
    assert.equal(rPaused.code, 0, rPaused.stderr);
    const jPaused = JSON.parse(rPaused.stdout);
    assert.equal(jPaused.batch_paused, true);
    assert.equal(jPaused.pause_status, 'CAPTCHA_PAUSED');
    assert.equal(jPaused.marked_presented, false);
    const stVerifyPause = openSelectionStore(storeDbPath, { readOnly: true });
    assert.equal(stVerifyPause.getCandidateForm('form-q-unseen-after-pause').last_presented_at, null);
    stVerifyPause.close();

    // 5. Minimal README daily-batch smoke example (1 synthetic item, :memory:, no 1688 quote -> gate1b_pending)
    const readmeMinPath = join(dir, 'readme-daily-batch.json');
    writeFileSync(readmeMinPath, JSON.stringify({
      as_of_date: '2026-11-27',
      items: [mkInputItem(1)],
    }, null, 2));
    const rReadme = await runCliMem(['daily-batch', '--db', ':memory:', '--input', readmeMinPath, '--limit', '10']);
    assert.equal(rReadme.code, 0, rReadme.stderr);
    const jReadme = JSON.parse(rReadme.stdout);
    assert.equal(jReadme.ok, true);
    assert.equal(jReadme.batch_report.ingested.length, 1);
    assert.equal(jReadme.batch_report.gate1a[0].proceed_to_gate1b, true);
    assert.equal(jReadme.batch_report.gate1b[0].status, 'gate1b_pending');
    assert.equal(jReadme.batch_report.evaluations.length, 0);
  });
});
