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

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));
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
  assert.match(html, /正常新品：固定示例/);
  assert.match(html, /满30天同任务正常起步新品强制纳入/);
  assert.match(html, /独立类目参照/);
  assert.doesNotMatch(html, /相对数量分|包含弱表现与仍合格的退出样本/);
  assert.match(html, /原始精确竞价/);
});

test('cards display a supported demand interval and its basis rather than an unknown or midpoint input', () => {
  const batch = structuredClone(fixture);
  Object.assign(batch.candidates[0].metrics.purchase_demand_scale, {
    value: null, value_range: [100, 500], coherent: true,
    range_basis: '同一合成样本的有据范围 <bound>',
  });
  const html = renderReport(scoreBatch(batch, profile), batch);
  const row = html.match(/data-item-id="purchase_demand_scale"[\s\S]*?<p class="source">/)?.[0];
  assert.match(row, /1–2 \/ 4 分/);
  assert.match(row, /100–500 件/);
  assert.match(row, /同一合成样本的有据范围 &lt;bound&gt;/);
  assert.doesNotMatch(row, /输入：未知|输入：300/);
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
  batch.candidates[0].presentation.market_references = [{ label: attack, value: attack, note: attack, url: 'javascript:alert(1)' }];
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

  const belowFloor = structuredClone(fixture);
  belowFloor.candidates = [belowFloor.candidates[0]];
  for (const scenario of belowFloor.candidates[0].economics.scenarios) {
    scenario.margin.value = 0.20;
    scenario.contribution_usd.value = 8;
    scenario.cost_ledger.lines.find(line => line.id === 'procurement').amount_usd += 12;
  }
  belowFloor.candidates[0].presentation.blockers = [{ problem: '有据毛利低于硬线', next_step: '排除当前规格。' }];
  const failedMargin = renderReport(scoreBatch(belowFloor, profile), belowFloor);
  assert.match(failedMargin, /费用已算出，但该方案不满足毛利条件/);
  assert.match(failedMargin, /已计分权重 70 \/ 100/);
  assert.match(failedMargin, /不满足合格评分条件 2 项；待补证 0 项/);
  assert.match(failedMargin, /排除原因与后续处理/);
  assert.doesNotMatch(failedMargin, /需要解决的缺口|完整情景尚待补证/);

  belowFloor.candidates[0].metrics.purchase_demand_scale.value = null;
  const excludedWithGap = renderReport(scoreBatch(belowFloor, profile), belowFloor);
  assert.match(excludedWithGap, /不满足合格评分条件 2 项；待补证 1 项/);
  assert.match(excludedWithGap, /需要解决的缺口/);
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
const profilePath = fileURLToPath(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url));
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

test('r58 curatorial studio gallery embeds offline WOFF2 fonts, Polar Rose SVG, hero plinth crops, and CSS lightbox without script or path leaks', () => {
  const batch = structuredClone(fixture);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
  batch.candidates[0].presentation.hero_image_data_uri = png;
  batch.candidates[0].presentation.short_title = '合成测试短标题';
  batch.candidates[0].presentation.subtitle_en = 'Synthetic Machined Block Pair';
  batch.candidates[0].presentation.contact_sheet_data_uri = png;
  batch.candidates[0].presentation.procurement = [
    { label: 'NestedHeroProbe', value: { hero_image_data_uri: 'file:///Users/LeakHeroProbe/secret.png' } },
  ];
  const result = scoreBatch(batch, profile);
  const html = renderReport(result, batch);
  assert.match(html, /meta name="text-scale" content="scale"/);
  assert.match(html, /font-src data:; script-src 'none'; connect-src 'none'/);
  assert.match(html, /@font-face\{font-family:"Hanken Grotesk"/);
  assert.match(html, /@font-face\{font-family:"Newsreader";font-style:italic/);
  assert.match(html, /class="exhibition-reel"/);
  assert.match(html, /class="split-stage"/);
  assert.match(html, /class="rose-svg"/);
  assert.equal((html.match(/class="rose-sector/g) ?? []).length, 24);
  assert.equal((html.match(/data-group-id=/g) ?? []).length, 24);
  assert.equal((html.match(/data-item-id=/g) ?? []).length, 63);
  assert.match(html, /合成测试短标题/);
  assert.match(html, /Synthetic Machined Block Pair/);
  assert.match(html, /id="candidate-1-sheet-zoom" class="css-lightbox"/);
  assert.equal(html.includes('LeakHeroProbe'), false, 'nested hero_image_data_uri path must be redacted');
  assert.doesNotMatch(html, /—/, 'r58 report template must emit zero U+2014 em-dashes');

  // Invalid hero_image_data_uri must not emit <img>
  const badBatch = structuredClone(fixture);
  badBatch.candidates[0].presentation.hero_image_data_uri = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  assert.doesNotMatch(renderReport(scoreBatch(badBatch, profile), badBatch), /<img\b/);
});

test('presentation.summary, presentation.risks, presentation.next_checks, and related presentation free-text scrub raw emails in rendered HTML', () => {
  const batch = structuredClone(fixture);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
  batch.presentation.title = '批次标题 contact.batch@vendor.org';
  batch.presentation.summary = '批次摘要 owner.batch@example.net';
  batch.presentation.discovery = [{ label: '线索发现', detail: '来自 disc@example.org', source: 'src@example.org' }];
  batch.presentation.timings = [{ label: '耗时阶段', seconds: 12, note: '执行人 timing@example.org' }];
  batch.presentation.limitations = ['边界限制 lim@example.org'];
  batch.packaging_redesign_shortlist = [
    {
      form_id: 'pkg-rescue-probe',
      label: '改包装候选 pkg.label@vendor.cn',
      eligible: true,
      price_usd: 35,
      overshoot_mm: 4,
      original_margin: 0.27,
      redesigned_margin: 0.33,
      offending_side: 'longest',
      summary_zh: '压缩包装说明 pkg.note@vendor.cn',
    },
  ];
  batch.candidates[0].label = '候选产品 label@vendor.cn';
  batch.candidates[0].form = '可售规格 form@vendor.cn';
  batch.candidates[0].presentation.summary = '候选摘要 test.user@supplier.cn 请核对';
  batch.candidates[0].presentation.subtitle_en = 'Subtitle sub@vendor.cn';
  batch.candidates[0].presentation.one_time_lab_fee_note = '一次性实验室检测费 lab.fee@vendor.cn（不摊进单件）';
  batch.candidates[0].presentation.concept_images = [
    {
      data_uri: png,
      title: '概念图标题 concept.title@vendor.cn',
      caption: '概念图说明 concept.caption@vendor.cn',
      alt: '概念图替代文本 concept.alt@vendor.cn',
    },
  ];
  batch.candidates[0].presentation.risks = [
    '风险一：联系 leaked@domain.com 核对报价',
    { label: '结构风险', value: 'objval@domain.com', note: '附注 objnote@domain.com', source: 'objsrc@domain.com' },
  ];
  batch.candidates[0].presentation.next_checks = [
    '下一步：向 next.check@factory.cn 要包材尺寸',
    { problem: '待查项目 prob@factory.cn', next_step: '跟进 step@factory.cn' },
  ];
  batch.candidates[0].presentation.blockers = [
    { problem: '阻断问题 blk@factory.cn（通过旺旺核对）', next_step: '处置 blkstep@factory.cn' },
  ];
  batch.candidates[0].presentation.procurement = [
    { label: '采购联系 proc@factory.cn', value: 'val@factory.cn', note: 'note@factory.cn', source: 'src2@factory.cn' },
  ];

  const scored = scoreBatch(batch, profile);
  scored.candidates[0].diagnostics.operational_disclosures = [
    { id: 'ops_probe', label: '核查项 ops.label@vendor.cn', status: 'needs_check', note: '排雷备注 ops.note@vendor.cn' },
  ];
  const html = renderReport(scored, batch);
  for (const rawEmail of [
    'contact.batch@vendor.org',
    'owner.batch@example.net',
    'disc@example.org',
    'src@example.org',
    'timing@example.org',
    'lim@example.org',
    'pkg.label@vendor.cn',
    'pkg.note@vendor.cn',
    'label@vendor.cn',
    'form@vendor.cn',
    'test.user@supplier.cn',
    'sub@vendor.cn',
    'lab.fee@vendor.cn',
    'concept.title@vendor.cn',
    'concept.caption@vendor.cn',
    'concept.alt@vendor.cn',
    'leaked@domain.com',
    'objval@domain.com',
    'objnote@domain.com',
    'objsrc@domain.com',
    'next.check@factory.cn',
    'prob@factory.cn',
    'step@factory.cn',
    'blk@factory.cn',
    'blkstep@factory.cn',
    'proc@factory.cn',
    'val@factory.cn',
    'note@factory.cn',
    'src2@factory.cn',
    'ops.label@vendor.cn',
    'ops.note@vendor.cn',
  ]) {
    assert.equal(html.includes(rawEmail), false, `raw email ${rawEmail} must not leak into rendered HTML`);
  }
  assert.match(html, /\[REDACTED_EMAIL\]/);
  const matrixRow = html.match(/<th scope="row"><a class="row-jump" href="#candidate-1">[\s\S]*?<\/a><\/th>/)?.[0] ?? '';
  assert.match(matrixRow, /候选产品 \[REDACTED_EMAIL\]/);
  const reelSection = html.match(/<section class="exhibition-reel"[\s\S]*?<\/section>/)?.[0] ?? '';
  assert.match(reelSection, /候选产品 \[REDACTED_EMAIL\]/);
  const cardHeading = html.match(/<article class="candidate" id="candidate-1"[\s\S]*?<h2>([\s\S]*?)<\/h2>/)?.[1] ?? '';
  assert.match(cardHeading, /候选产品 \[REDACTED_EMAIL\]/);
  assert.match(html, /<p class="spec-copy">可售规格 \[REDACTED_EMAIL\]<\/p>/);
  assert.match(html, /一次性实验室检测费 \[REDACTED_EMAIL\]/);
  assert.match(html, /概念图标题 \[REDACTED_EMAIL\]/);
  assert.match(html, /概念图说明 \[REDACTED_EMAIL\]/);
  assert.match(html, /alt="概念图替代文本 \[REDACTED_EMAIL\]"/);
  assert.match(html, /核查项 \[REDACTED_EMAIL\]/);
  assert.match(html, /排雷备注 \[REDACTED_EMAIL\]/);
  assert.match(html, /改包装候选 \[REDACTED_EMAIL\]/);
  assert.match(html, /压缩包装说明 \[REDACTED_EMAIL\]/);
  assert.match(html, /阻断问题 \[REDACTED_EMAIL\]（通过1688 问厂核对）/);
  assert.doesNotMatch(html, /旺旺/);
});

