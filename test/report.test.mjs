import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { scoreBatch } from '../src/scoring.mjs';
import { renderReport, safeHttpUrl } from '../src/report.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

test('Chinese cards distinguish complete point/range totals from supported partial points and all 21 rows', () => {
  const result = scoreBatch(fixture, profile);
  const html = renderReport(result, fixture);
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /完整总分/);
  assert.match(html, /已支持分数/);
  assert.match(html, /证据覆盖权重/);
  assert.match(html, /完整总分待补证/);
  assert.match(html, /89\.75[–—-]90\.5/);
  assert.equal((html.match(/data-item-id=/g) ?? []).length, 63);
  assert.equal((html.match(/data-group-id=/g) ?? []).length, 24);
  assert.match(html, /同一对示例/);
  assert.match(html, /原始精确竞价/);
});

test('untrusted copy is escaped, source URLs are limited to HTTP(S), and SVG or remote images are omitted', () => {
  const batch = structuredClone(fixture);
  const attack = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  batch.presentation.title = attack;
  batch.presentation.summary = attack;
  batch.presentation.discovery = [{ label: attack, detail: attack, source: attack, url: 'javascript:alert(1)' }];
  batch.candidates[0].label = attack;
  batch.candidates[0].presentation.summary = attack;
  batch.candidates[0].presentation.image_data_uri = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  batch.candidates[0].presentation.blockers = [{ problem: attack, next_step: attack }];
  batch.candidates[0].presentation.procurement = [{ label: attack, value: attack, source: attack, url: 'file:///private-record' }];
  batch.candidates[0].evidence[0].url = 'data:text/html,<script>alert(3)</script>';
  const html = renderReport(scoreBatch(batch, profile), batch);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.doesNotMatch(html, /<script\b|<img src=x|href="(?:javascript|file|data):|data:image\/svg\+xml/);
  assert.match(html, /script-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///local', 'https://user:password@example.com/', null, {}]) assert.equal(safeHttpUrl(value), null);
  assert.equal(safeHttpUrl('https://example.com/source?q=1&v=2'), 'https://example.com/source?q=1&v=2');
  assert.equal(safeHttpUrl('http://example.com/source'), 'http://example.com/source');
});

test('optional presentation shapes are defensive and a missing total is not displayed as zero', () => {
  const batch = structuredClone(fixture);
  batch.presentation.timings = [{ label: '待测量', seconds: null }, null];
  batch.candidates[2].presentation = { summary: {}, blockers: [null, {}, { problem: '仍缺费用', next_step: 3 }], procurement: [null, 'bad'], economics_details: {} };
  const html = renderReport(scoreBatch(batch, profile), batch);
  const pendingCard = html.match(/<article\b[^>]*id="candidate-3"[\s\S]*?<\/article>/)?.[0];
  assert.ok(pendingCard);
  assert.match(pendingCard, /完整总分待补证/);
  assert.doesNotMatch(pendingCard, /完整总分\s*<strong>0/);
  assert.match(pendingCard, /已支持分数 70/);
  assert.match(pendingCard, /证据覆盖权重 70 \/ 100/);
  assert.match(html, /未测量/);
});

test('only embedded raster images with a matching file signature are rendered', () => {
  const batch = structuredClone(fixture);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
  batch.candidates[0].presentation.image_data_uri = png;
  batch.candidates[0].presentation.image_alt = '合成测试像素，非产品图';
  const result = scoreBatch(batch, profile);
  assert.ok(renderReport(result, batch).includes(`src="${png}"`));
  for (const invalid of ['https://example.com/photo.png', 'data:image/png;base64,PHN2Zz48L3N2Zz4=']) {
    batch.candidates[0].presentation.image_data_uri = invalid;
    assert.doesNotMatch(renderReport(result, batch), /<img\b/);
  }
});

test('known exclusions and deferrals are not mislabeled as missing score evidence', () => {
  const batch = structuredClone(fixture);
  batch.candidates = [batch.candidates[0], structuredClone(batch.candidates[0])];
  batch.candidates[0].id = 'synthetic-excluded';
  batch.candidates[0].judgments.specific_design_rights.anchor = 0;
  batch.candidates[1].id = 'synthetic-deferred';
  batch.candidates[1].screening.strong_date_dependency.value = true;
  const html = renderReport(scoreBatch(batch, profile), batch);
  const excluded = html.match(/<article\b[^>]*data-queue="excluded"[\s\S]*?<\/article>/)?.[0];
  const deferred = html.match(/<article\b[^>]*data-queue="deferred"[\s\S]*?<\/article>/)?.[0];
  assert.ok(excluded?.includes('当前规格已排除，不列完整总分'));
  assert.ok(deferred?.includes('本期暂缓，不列完整总分'));
  assert.doesNotMatch(excluded, /完整总分待补证/);
  assert.doesNotMatch(deferred, /完整总分待补证/);
});

test('unsupported economic records never display a margin pass, including stale eligibility-only diagnostics', () => {
  for (const change of [
    scenario => { scenario.coherent = false; },
    scenario => { scenario.saleable_unit = 'another synthetic bundle'; },
    scenario => { delete scenario.assumptions; },
  ]) {
    const batch = structuredClone(fixture);
    batch.candidates = [batch.candidates[0]];
    change(batch.candidates[0].economics.scenarios[0]);
    const result = scoreBatch(batch, profile);
    let html = renderReport(result, batch);
    assert.ok(!html.includes('该情景满足毛利条件。'));
    assert.ok(html.includes('费用情景的规格、可售单位、假设或编号存在未解决的问题。'));
    const savedDiagnostic = result.candidates[0].diagnostics.economics.scenarios[0];
    delete savedDiagnostic.coherence_supported;
    savedDiagnostic.margin_eligible = true;
    html = renderReport(result, batch);
    assert.ok(!html.includes('该情景满足毛利条件。'));
  }
  assert.ok(renderReport(scoreBatch(fixture, profile), fixture).includes('该情景满足毛利条件。'));
});

function temporaryDirectory(run) {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'selection-trial-test-'));
  try { return run(directory); }
  finally {
    if (existsSync(directory)) {
      const resolved = realpathSync(directory);
      assert.equal(dirname(resolved), parent);
      assert.ok(basename(resolved).startsWith('selection-trial-test-'));
      assert.equal(lstatSync(directory).isSymbolicLink(), false);
      rmSync(resolved, { recursive: true });
    }
  }
}

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const profilePath = fileURLToPath(new URL('../docs/design/reference-profile.draft.json', import.meta.url));
const fixturePath = fileURLToPath(new URL('../fixtures/synthetic-batch.json', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('the actual offline CLI writes a readable fixture report, exact score result and hashed execution receipt', () => temporaryDirectory(directory => {
  const output = join(directory, 'output with spaces');
  const run = spawnSync(process.execPath, [cli, '--input', fixturePath, '--profile', profilePath, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const resultBytes = readFileSync(join(output, 'result.json'));
  const htmlBytes = readFileSync(join(output, 'index.html'));
  const result = JSON.parse(resultBytes);
  const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
  assert.deepEqual(result, scoreBatch(fixture, profile));
  assert.match(htmlBytes.toString('utf8'), /合成教学数据/);
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.inputs.batch.sha256, hash(readFileSync(fixturePath)));
  assert.equal(receipt.inputs.profile.sha256, hash(readFileSync(profilePath)));
  assert.equal(receipt.outputs['result.json'].sha256, hash(resultBytes));
  assert.equal(receipt.outputs['index.html'].sha256, hash(htmlBytes));
  assert.equal(receipt.provider_requests, 0);
  assert.equal(receipt.model_requests, 0);
  assert.ok(receipt.elapsed_ms >= 0);
  assert.equal(receipt.summary.complete, 2);
  assert.equal(receipt.summary.pending, 1);
}));

test('malformed CLI input fails before creating report outputs and never echoes its content', () => temporaryDirectory(directory => {
  const input = join(directory, 'bad.json');
  const output = join(directory, 'not-created');
  writeFileSync(input, '{ synthetic-private-marker: ', 'utf8');
  const run = spawnSync(process.execPath, [cli, '--input', input, '--profile', profilePath, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /JSON/);
  assert.doesNotMatch(run.stderr, /synthetic-private-marker/);
  assert.equal(existsSync(output), false);
}));

test('CLI reruns are deterministic for cards/results and cannot overwrite the source batch', () => temporaryDirectory(directory => {
  const output = join(directory, 'repeat');
  const args = [cli, '--input', fixturePath, '--profile', profilePath, '--output', output];
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
  const firstResult = readFileSync(join(output, 'result.json'));
  const firstHtml = readFileSync(join(output, 'index.html'));
  assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
  assert.deepEqual(readFileSync(join(output, 'result.json')), firstResult);
  assert.deepEqual(readFileSync(join(output, 'index.html')), firstHtml);
  const source = join(directory, 'result.json');
  const sourceBytes = readFileSync(fixturePath);
  writeFileSync(source, sourceBytes);
  const collision = spawnSync(process.execPath, [cli, '--input', source, '--profile', profilePath, '--output', directory], { encoding: 'utf8' });
  assert.equal(collision.status, 2);
  assert.match(collision.stderr, /覆盖输入/);
  assert.deepEqual(readFileSync(source), sourceBytes);
}));

test('a real output publication failure records partial state instead of retaining an old success receipt', () => temporaryDirectory(directory => {
  const output = join(directory, 'partial-output');
  mkdirSync(output);
  mkdirSync(join(output, 'index.html'));
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ status: 'complete', run_id: 'synthetic-old-run' }));
  const run = spawnSync(process.execPath, [cli, '--input', fixturePath, '--profile', profilePath, '--output', output], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /输出未完整写入/);
  const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
  assert.notEqual(receipt.run_id, 'synthetic-old-run');
  assert.equal(lstatSync(join(output, 'index.html')).isDirectory(), true);
  for (const name of receipt.published_outputs) assert.equal(hash(readFileSync(join(output, name))), receipt.expected_outputs[name].sha256);
  assert.ok(readdirSync(output).every(name => !name.endsWith('.tmp')));
}));
