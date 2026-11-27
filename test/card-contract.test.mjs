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
