// Absorbed from .local/reviews/20261127-maintainability-retrospective/public/card-contract.test.mjs (Issue #53)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const batch = readJson('fixtures/synthetic-batch.json');
batch.candidates = batch.candidates.filter(candidate => candidate.id === 'synthetic-complete');
const profile = readJson('docs/design/reference-profile.r59.draft.json');
const { scoreBatch } = await import(pathToFileURL(resolve('src/scoring.mjs')).href);

test('Control: the original single-candidate evidence qualifies in standalone scoring', () => {
  assert.equal(batch.candidates.length, 1);
  assert.equal(scoreBatch(structuredClone(batch), profile).summary.qualifying, 1);
});

test('A confirmed rights conflict in the current workflow prevents a qualifying export (and overwrites stale qualifying: 1 artifacts)', () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'r59-card-contract-'));
  try {
    const report = join(scratch, 'report');
    mkdirSync(report, { recursive: true });
    // Seed stale qualifying: 1 export files to confirm single-product overwrites them cleanly
    writeFileSync(join(report, 'result.json'), JSON.stringify({ summary: { qualifying: 1 }, candidates: [{ id: 'synthetic-complete', qualification: { counts_toward_target: true } }] }), 'utf8');
    writeFileSync(join(report, 'receipt.json'), JSON.stringify({ summary: { qualifying: 1 } }), 'utf8');
    writeFileSync(join(report, 'index.html'), '<html>stale</html>', 'utf8');

    const input = join(scratch, 'input.json');
    writeFileSync(input, JSON.stringify({
      form_id: 'synthetic-complete',
      label: 'Synthetic sample A',
      gate1a_scenarios: [],
      allow_forward_price_discovery: true,
      specific_rights_conflict: true,
      scored_batch: batch,
    }));
    const child = spawnSync(process.execPath, ['--no-warnings', 'src/phase2-cli.mjs',
      'single-product', '--db', ':memory:', '--input', input, '--report-dir', report],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const workflow = JSON.parse(child.stdout).batch_report;
    assert.equal(workflow.gate1a[0].specific_rights_conflict_proven, true);
    assert.equal(workflow.gate1a[0].gate_status, 'gate1a_rejected');
    assert.equal(workflow.gate1a[0].proceed_to_gate2_3, false);
    assert.equal(workflow.evaluations.length, 0);
    const resultPath = join(report, 'result.json');
    assert.equal(existsSync(resultPath), true);
    const result = readJson(resultPath);
    const card = result.candidates.find(candidate =>
      (candidate.candidate_id ?? candidate.id) === 'synthetic-complete');
    const actual = {
      qualifyingInReport: result.summary.qualifying,
      cardCounts: card?.qualification?.counts_toward_target === true,
      qualifyingInReceipt: readJson(join(report, 'receipt.json')).summary?.qualifying,
    };
    assert.deepEqual(actual, { qualifyingInReport: 0, cardCounts: false, qualifyingInReceipt: 0 },
      'Export must use the current workflow ruling. A stopped candidate can only appear as nonqualifying.');
    assert.equal(readFileSync(join(report, 'index.html'), 'utf8').includes('<html>stale</html>'), false);
  } finally {
    const actual = realpathSync(scratch);
    if (dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith('r59-card-contract-')) {
      throw new Error('Unexpected scratch path');
    }
    rmSync(actual, { recursive: true });
  }
});

test('A non-Gate-1A gate1b_rejected workflow lifecycle clamps single-product export summary, dispositions, and queues consistently', () => {
  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'r59-card-contract-g1b-'));
  try {
    const report = join(scratch, 'report');
    const input = join(scratch, 'input.json');
    const uiReadback = {
      logged_in: true,
      viewport_width_px: 1440,
      selected_sku_row_visible: true,
      settlement_bar_visible: true,
      applied_quantity_confirmed: true,
    };
    const overpricedQuotes = [1, 2, 3].map(n => ({
      quote_id: `q-overpriced-${n}`,
      factory_id: `fac-overpriced-${n}`,
      spec_variant_key: 'kit-std',
      observed_at: '2026-11-27',
      redacted_destination: '广东深圳',
      raw_readback_ref: `rb-overpriced-${n}`,
      ui_readback: uiReadback,
      require_ui_readback: true,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      sku_lines: [{
        offer_id: `o-over-${n}`,
        sku_id: 'kit',
        component_id: 'kit',
        qty_per_saleable_set: 1,
        pack_multiple: 1,
        moq_qty: 100,
        ordered_qty: 100,
        unit_price_cny: 900,
        regular_goods_promo_false: true,
      }],
      goods_cny_total: 90000,
      domestic_freight_cny_total: 100,
    }));
    writeFileSync(input, JSON.stringify({
      as_of_date: '2026-11-27',
      form: {
        form_id: 'synthetic-complete',
        label: 'Synthetic sample A',
        buyer_task: 'Countertop 2-piece storage',
        saleable_set_composition: [{ component_id: 'kit', qty_per_saleable_set: 1 }],
      },
      leads: [{
        lead_id: 'ld-g1b-rej',
        source_channel: 'reddit',
        source_ref: 'https://example.com/r/g1b-rej',
        phrase_or_title: 'Countertop storage',
        observed_at: '2026-11-27',
        disposition: 'product',
      }],
      gate1a_scenarios: [{
        id: 'sc-g1a-1',
        price_usd: 40,
        pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.02,
        physical_return_fraction: 0.02,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.0, minimum_referral_usd: 0.30 },
        headhaul_usd: 1.2,
        collection_rate: 0.006,
        sales_window: { from: '2027-02-01', through: '2027-10-14' },
        storage_window: { from: '2027-02-01', through: '2027-09-30' },
        inbound_window: { from: '2027-01-15', through: '2027-01-15' },
        is_apparel: false,
        is_dangerous_goods: false,
        is_sipp: false,
      }],
      quotes: overpricedQuotes,
      scored_batch: batch,
    }));
    const child = spawnSync(process.execPath, ['--no-warnings', 'src/phase2-cli.mjs',
      'single-product', '--db', ':memory:', '--input', input, '--report-dir', report],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const workflow = JSON.parse(child.stdout).batch_report;
    assert.equal(workflow.gate1b.at(-1)?.status, 'gate1b_rejected');
    assert.equal(workflow.evaluations.length, 0);

    const result = readJson(join(report, 'result.json'));
    const receipt = readJson(join(report, 'receipt.json'));
    const card = result.candidates.find(candidate =>
      (candidate.candidate_id ?? candidate.id) === 'synthetic-complete');

    assert.equal(card?.qualification?.counts_toward_target, false);
    assert.equal(card?.queue, 'excluded');
    assert.equal(card?.effective_disposition, 'hard_excluded');
    assert.equal(result.summary.qualifying, 0);
    assert.equal(result.summary.complete, 0);
    assert.equal(result.summary.complete_points, 0);
    assert.equal(result.summary.complete_ranges, 0);
    assert.equal(result.summary.excluded, 1);
    assert.deepEqual(result.summary.dispositions, {
      full_annual_qualifying: 0,
      seasonal_off_peak_qualifying: 0,
      crossing_30pct_interval: 0,
      pending_evidence: 0,
      private_mold_reserved: 0,
      deferred: 0,
      hard_excluded: 1,
    });
    assert.deepEqual(result.qualifying_order, []);
    assert.equal(result.comparable_leader, null);
    assert.equal(result.queues.comparable.length, 0);
    assert.equal(result.queues.excluded.length, 1);
    assert.deepEqual(receipt.summary, result.summary);
  } finally {
    const actual = realpathSync(scratch);
    if (dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith('r59-card-contract-g1b-')) {
      throw new Error('Unexpected scratch path');
    }
    rmSync(actual, { recursive: true });
  }
});
