import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { openSelectionStore } from '../src/store.mjs';

async function runCliMem(args) {
  let stdout = '';
  let stderr = '';
  const code = await runPhase2Cli(args, {
    stdout: { write(chunk) { stdout += String(chunk); } },
    stderr: { write(chunk) { stderr += String(chunk); } },
  });
  return { code, stdout, stderr };
}

test('Issue #9 acceptance: separates system suggestion, owner-confirmed decision, and physical sample measurement end-to-end across CLI -> SQLite -> retrospective summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue9-cal-accept-'));
  try {
    const dbPath = join(dir, 'selection.sqlite');
    assert.equal((await runCliMem(['init', '--db', dbPath])).code, 0);

    // Register synthetic candidate form to verify form_spec_sha256 linkage
    const stInit = openSelectionStore(dbPath);
    const { form } = stInit.upsertCandidateForm({
      form_id: 'form-syn-cal-1',
      label: 'Synthetic Bamboo Desk Tray',
      buyer_task: 'Organize desktop accessories',
      saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }],
    });
    stInit.close();

    // 1) System suggests 'sample' at T1 — owner_decision & sample measurement MUST remain null
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

    // 2) Owner later confirms 'hold' at T2 (still NO sample weight!) via --confirm-owner
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

    // Verify full 3-fact chronological reconstruction via read-only CLI --list --summary AND direct SQLite readback
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

    // 3) Physical sample arrives at T3: record measured pkg + recalculated margin while preserving T1, T2 & original baseline
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
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Issue #9 anti-pollution: legacy_unknown & script_demo_excluded never inflate owner_acceptance_rate and cannot overwrite owner_confirmed decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue9-cal-guard-'));
  try {
    const dbPath = join(dir, 'selection.sqlite');
    assert.equal((await runCliMem(['init', '--db', dbPath])).code, 0);

    // 1) Legacy import omitting owner_decision_source stays backwards-compatible as 'legacy_unknown'
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

    // 2) Demo script rows explicitly tagged via --exclude-demo
    const demoIn = join(dir, 'demo-import.json');
    writeFileSync(demoIn, JSON.stringify({
      records: [
        { form_id: 'form-demo-1', batch_id: 'b-mix', system_verdict: 'sample', owner_decision: 'sample_check', owner_reason: '脚本演练预填' },
      ],
    }, null, 2));
    const rDemo = await runCliMem(['calibration-track', '--db', dbPath, '--input', demoIn, '--exclude-demo']);
    assert.equal(rDemo.code, 0, rDemo.stderr);
    assert.equal(JSON.parse(rDemo.stdout).saved[0].owner_decision_source, 'script_demo_excluded');

    // 3) Real owner confirms 2 rows: 1 'sample_check' (accepted) + 1 'hold' (not accepted) -> acceptance rate = 0.5
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

    // 4) Unconfirmed / legacy import MUST NOT overwrite an existing owner_confirmed decision (atomic rollback)
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

    // 5) Validation guards: pending_owner_review cannot be owner_confirmed; empty sample pkg / unattributed timestamp rejected
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

    // 6) Existing legacy_unknown row can be explicitly reclassified to script_demo_excluded via --exclude-demo
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
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Issue #9 migration: pre-PR SQLite DB reads safely read-only and migrates idempotently with legacy_unknown backfill', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue9-cal-migrate-'));
  try {
    const dbPath = join(dir, 'legacy-pre-issue9.sqlite');
    // Build authentic pre-Issue-#9 database (init full store, then downgrade calibration_tracking to pre-PR 17 columns)
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

    // 1) Read-only CLI --list --summary works BEFORE any ALTER TABLE runs!
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

    // 2) Writable open runs idempotent ALTER TABLE + backfill (without fabricating timestamps); second open preserves exact values
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
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});

test('Issue #9 Round-1 Astra regressions (#1-#12): margin SSOT, email PII, stale margin invalidation, verdict-aware acceptance, demo/scope/baseline isolation & legacy compat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue9-r1-reg-'));
  try {
    // (#11 S-2 + #10 S-1) Pre-open flag & --as-of validation must fail BEFORE creating SQLite DB
    const ghostDb = join(dir, 'should-not-exist.sqlite');
    assert.notEqual((await runCliMem(['calibration-track', '--db', ghostDb, '--confirm-owner', '--exclude-demo'])).code, 0);
    assert.notEqual((await runCliMem(['calibration-track', '--db', ghostDb, '--list', '--as-of', 'not-a-date'])).code, 0);
    assert.equal(existsSync(ghostDb), false, 'Invalid calibration-track flags must fail before creating SQLite file');

    const dbPath = join(dir, 'reg.sqlite');
    assert.equal((await runCliMem(['init', '--db', dbPath])).code, 0);

    // (#1 STD-1 + #6 SPEC-4 + #2 STD-2) Numeric margin priority over stale boolean, email block/scrub, recalc-without-pkg separation
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

      // Raw email rejected on write; legacy SQLite email scrubbed on read/summary
      assert.throws(() => st.upsertCalibrationTracking({
        form_id: 'f-email',
        system_verdict: 'sample',
        sample_spec_ref: 'contact: supplier@example-factory.com',
      }), /email/i);
      st.db.prepare("UPDATE calibration_tracking SET sample_spec_ref = 'legacy supplier@example-factory.com' WHERE form_id = 'f-m1'").run();
      const scrubbed = st.getCalibrationRetrospectiveSummary({ form_id: 'f-m1' });
      assert.equal(JSON.stringify(scrubbed).includes('supplier@example-factory.com'), false);
      assert.match(scrubbed.records_timeline[0].sample_spec_ref, /\[REDACTED_EMAIL\]/);

      // (#4 SPEC-2) Verdict-aware acceptance rate + verdict_x_decision + verdict-change staleness
      st.upsertCalibrationTracking({ form_id: 'f-excl', batch_id: 'b-v', system_verdict: 'hard_excluded', owner_decision: 'keep', owner_decision_source: 'owner_confirmed' });
      st.upsertCalibrationTracking({ form_id: 'f-chg', batch_id: 'b-v', system_verdict: 'sample', owner_decision: 'sample_check', owner_decision_source: 'owner_confirmed' });
      st.upsertCalibrationTracking({ form_id: 'f-chg', batch_id: 'b-v', system_verdict: 'hard_excluded' }); // verdict changed after confirmation
      const sumV = st.getCalibrationRetrospectiveSummary({ batch_id: 'b-v' });
      assert.equal(sumV.owner_acceptance_rate, null, 'keep on hard_excluded & stale verdict confirmation must never inflate acceptance rate');
      assert.equal(sumV.verdict_x_decision.hard_excluded.keep, 1);
      assert.equal(sumV.owner_confirmed_stale_verdict_count, 1);

      // (#5 SPEC-3) Decision-less demo row excluded completely & sourceless re-import preserves script_demo_excluded
      st.upsertCalibrationTracking({ form_id: 'f-demo-null', batch_id: 'b-d', system_verdict: 'sample', owner_decision_source: 'script_demo_excluded', sample_measured_pkg: pkg, recalculated_margin: { margin: 0.42 } });
      st.upsertCalibrationTracking({ form_id: 'f-demo-null', batch_id: 'b-d', system_verdict: 'sample', owner_decision: 'sample_check' }); // sourceless replay
      assert.equal(st.getCalibrationTrackingForForm('f-demo-null').owner_decision_source, 'script_demo_excluded');
      const sumD = st.getCalibrationRetrospectiveSummary({ batch_id: 'b-d' });
      assert.equal(sumD.script_demo_excluded_count, 1);
      assert.equal(sumD.system_suggested_count, 0);
      assert.equal(sumD.sample_measured_realized_count, 0);
      assert.equal(sumD.sample_recalculated_meets_30pct_count, 0);

      // (#7 SPEC-5) Changing decision/source without owner_reason clears stale script reason; confirmed_at requires owner_confirmed
      st.upsertCalibrationTracking({ form_id: 'f-demo-null', owner_decision: 'hold', owner_decision_source: 'owner_confirmed' });
      assert.equal(st.getCalibrationTrackingForForm('f-demo-null').owner_reason, null);
      assert.throws(() => st.upsertCalibrationTracking({ form_id: 'f-demo-null', owner_decision_confirmed_at: '2026-11-27T12:00:00Z' }), /owner_confirmed/);

      // (#8 SPEC-6) v1 vs v2 spec_version baseline & spec_sha256 isolation
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

    // (#3 SPEC-1 + #9 SPEC-7 + #7 SPEC-5 + #8 SPEC-6 + #11 S-2) Real CLI checks
    // 1) Initial 1.25 lb sample -> 32.90%+; then pkg changes to 4.25 lb with missing FX -> stale margin invalidated + recalculation_pending!
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
        recalculate_profit_spec: { price_usd: 45, goods_cny_per_unit: 60, headhaul_usd: 2.0 }, // missing fx_cny_per_usd
      }],
    }));
    const rPkg2 = await runCliMem(['calibration-track', '--db', dbPath, '--input', fPkg2]);
    assert.equal(rPkg2.code, 0, rPkg2.stderr);
    const jPkg2 = JSON.parse(rPkg2.stdout);
    assert.equal(jPkg2.saved[0].recalculated_margin, null, 'Changed pkg with failed recalc must invalidate stale margin');
    assert.equal(jPkg2.recalculation_pending[0].reason, 'incomplete_recalculate_profit_spec');

    // Supplying cost spec later with recalculated_margin: null reuses stored 1928g pkg!
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

    // Legacy parent-CLI null-margin placeholder accepted compatibly as pending (null)
    const fLegPh = join(dir, 'legacy-placeholder.json');
    writeFileSync(fLegPh, JSON.stringify({
      records: [{ form_id: 'f-leg-ph', batch_id: 'b-cli', system_verdict: 'sample', recalculated_margin: { size_tier: 'Small Standard', margin: null, margin_pct: null, meets_30pct_floor: null } }],
    }));
    const rLegPh = await runCliMem(['calibration-track', '--db', dbPath, '--input', fLegPh]);
    assert.equal(rLegPh.code, 0, rLegPh.stderr);
    assert.equal(JSON.parse(rLegPh.stdout).saved[0].recalculated_margin, null);

    // (#7 SPEC-5) --confirm-owner --form A rejects batch containing Form B before mutating anything; malformed entry rejected
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
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows WAL cleanup */ }
  }
});
