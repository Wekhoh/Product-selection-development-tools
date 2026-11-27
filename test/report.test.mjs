import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { scoreBatch, isUsableActivePricingScenario } from '../src/scoring.mjs';
import { applyPeerComparabilityRulings, attachCandidateEvidenceReview, runOptionalGate4EvidenceReview } from '../src/pipeline.mjs';
import { freezeEvidenceReviewPacket, runCodexEvidenceReview } from '../src/openai/index.mjs';
import { renderReport, safeHttpUrl } from '../src/report.mjs';
import { makeSeasonalCandidate, makeStage4OrganizerTrayCandidate, withTempDir, withTempDirAsync } from './helpers/test-fixtures.mjs';

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

const temporaryDirectory = run => withTempDir('selection-trial-test-', run);

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

test('all remaining HTML free-text render paths scrub raw emails/paths while preserving https:// URLs with /Users/ segments', () => {
  const batch = structuredClone(fixture);
  batch.candidates = [structuredClone(batch.candidates[0])];
  batch.candidates[0].evidence[0].source = '来源 bib-link@probe.cn';
  Object.assign(batch.candidates[0].metrics.purchase_demand_scale, {
    value: null,
    value_range: [100, 500],
    coherent: true,
    range_basis: '区间依据 range-basis@probe.cn',
    niche: '市场 niche-range@probe.cn',
    period: '窗口 period-range@probe.cn',
  });
  Object.assign(batch.candidates[0].metrics.low_return_preference, {
    niche: '市场 niche-val@probe.cn',
    category: '类目 cat-val@probe.cn',
    period: '窗口 period-val@probe.cn',
  });
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
  batch.candidates[0].presentation.image_data_uri = png;
  batch.candidates[0].presentation.summary = '公开文档 https://example.com/Users/keepme 与 https://example.com/home/keepme 本地 /Users/alice_secret/doc.txt 共享 \\\\fileserver\\Users\\bob_secret\\quote.txt';
  batch.candidates[0].discovery = {
    label: '发现路径',
    description: '来源说明',
    leads: [],
    store_leads: [
      {
        lead_id: 'ld-url-keep',
        phrase_or_title: '保真链接测试',
        source_channel: 'reddit',
        source_ref: 'https://example.com/Users/keepme',
        observed_at: '2026-11-26',
        disposition: 'product',
      },
    ],
  };
  batch.candidates[0].sp_api_calibration = {
    asin: 'B0SPAPI01',
    stale_dimension_alert: true,
    stale_dimension_note: '尺寸陈旧 spapi-stale@probe.cn',
    restrictions: { status: '限售 spapi-rest@probe.cn' },
  };
  batch.candidates[0].peer_package_calibration = {
    valid: true,
    peer_count: 3,
    median_pkg: { length_in: 10, width_in: 6, height_in: 4, unit_weight_lb: 1.2 },
    supplier_borderline_alert: true,
    sample_warning_tag: '压线 warn-tag@probe.cn',
    supplier_borderline_note: '压线注 peer-note@probe.cn',
  };
  batch.candidates[0].review_notes = [
    '复核字符串 revnote-str@probe.cn',
    { kind: 'CALIBRATION_NOTE', reviewer: 'Alice Reviewer', note: '复核对象 revnote-obj@probe.cn' },
  ];

  const scored = scoreBatch(batch, profile);
  const demandItem = scored.candidates[0].items.find(i => i.id === 'purchase_demand_scale');
  demandItem.reason = '分项说明 item-reason@probe.cn（旺旺核对）';

  const bidItem = scored.candidates[0].items.find(i => i.id === 'relevant_purchase_entry_bid');
  bidItem.unbid_after_all_tiers = true;
  bidItem.deduction_note = '扣分说明 bid-deduct@probe.cn';
  bidItem.long_tail_opportunistic_terms = [{ query: 'longtail-q@probe.cn', volume: 120 }];
  bidItem.entries[0].query = 'entry-q@probe.cn';
  bidItem.entries[0].combined_point = 1.15;
  bidItem.entries[0].low_exposure_baseline = true;
  bidItem.entries[0].low_exposure_note = '低曝光 lowexp@probe.cn';
  bidItem.entries.push({
    query: 'entry2-q@probe.cn',
    volume: 200,
    source_label: 'sif_only',
    combined_point: null,
    sources: {
      sellersprite: { point: null },
      sif: {
        point: null,
        reason: 'SIF缺值 reading-reason@probe.cn',
        strategy_fallback_note: '策略回退 strat-fb@probe.cn',
      },
    },
  });

  const q31Item = scored.candidates[0].items.find(i => i.id === 'low_rating_sales_performance');
  q31Item.absence_note = '无新品 q31-abs@probe.cn';
  q31Item.rolling_source_disclosure = '滚动披露 q31-roll@probe.cn';
  q31Item.stratified_disclosure = '分层披露 q31-strat@probe.cn';
  q31Item.stratified_note = '分层附注 q31-stratnote@probe.cn';

  const nc = scored.candidates[0].diagnostics.newcomers;
  nc.no_qualifying_examples = true;
  nc.absence_note = '无样板 nc-abs@probe.cn';
  nc.lone_newcomer_alert = true;
  nc.lone_newcomer_note = '孤例预警 q31-lone@probe.cn';
  nc.stratification = {
    applied: true,
    disclosure: '分层披露 nc-strat@probe.cn',
    active_pool_size: 8,
    sampled_count: 5,
    unsampled_count: 3,
    stratified_bounds: [1, 3],
    natural_stratified_note: '自然分层注 nc-stratnote@probe.cn',
    strata: [],
  };
  if (nc.examples?.[0]) {
    nc.examples[0].natural.score = null;
    nc.examples[0].natural.reason = '自然缺因 nc-natreason@probe.cn';
    nc.examples[0].natural.coverage_exposure_mismatch = true;
    nc.examples[0].natural.coverage_exposure_diagnosis = '自然诊断 nc-natdiag@probe.cn';
    const matchingMember = nc.members.find(m => m.family_id === nc.examples[0].family_id && m.asin === nc.examples[0].asin);
    if (matchingMember) {
      matchingMember.reason = '纳入理由 nc-rawreason@probe.cn';
      matchingMember.review_origin_breakdown = { display_zh: '评论构成 nc-revorigin@probe.cn' };
    }
  }
  nc.members.push({
    family_id: 'fam-excl-probe',
    asin: 'B0EXCLPROBE',
    effective_status: 'excluded',
    reason: '排除理由 nc-memreason@probe.cn',
  });

  const seasonalCand = structuredClone(scored.candidates[0]);
  seasonalCand.candidate_id = 'seasonal-probe-1';
  seasonalCand.label = '分季探测款';
  seasonalCand.queue = 'seasonal_review';
  seasonalCand.operating_periods = [
    {
      id: 'off_peak',
      label: '淡季 2–9 月',
      months: [2, 3, 4, 5, 6, 7, 8, 9],
      queue: 'comparable',
      unpublished_peak_note: '旺季待定 unpub-peak@probe.cn',
      diagnostics: { economics: { scenarios: [] } },
      items: [],
      screening: { conditions: [] },
      supported_range: [50, 60],
      covered_weight: 80,
      total_range: [50, 60],
    },
  ];
  scored.candidates.push(seasonalCand);
  const seasonalOrig = structuredClone(batch.candidates[0]);
  seasonalOrig.id = 'seasonal-probe-1';
  batch.candidates.push(seasonalOrig);

  const html59 = renderReport(scored, batch);
  const scored58 = structuredClone(scored);
  scored58.profile_revision = 58;
  scored58.candidates.forEach(c => { c.profile_revision = 58; });
  const html58 = renderReport(scored58, batch);

  const leakedProbes = [
    'bib-link@probe.cn',
    'range-basis@probe.cn',
    'niche-range@probe.cn',
    'period-range@probe.cn',
    'niche-val@probe.cn',
    'cat-val@probe.cn',
    'period-val@probe.cn',
    'spapi-stale@probe.cn',
    'spapi-rest@probe.cn',
    'warn-tag@probe.cn',
    'peer-note@probe.cn',
    'revnote-str@probe.cn',
    'revnote-obj@probe.cn',
    'item-reason@probe.cn',
    'bid-deduct@probe.cn',
    'longtail-q@probe.cn',
    'entry-q@probe.cn',
    'lowexp@probe.cn',
    'reading-reason@probe.cn',
    'strat-fb@probe.cn',
    'q31-abs@probe.cn',
    'q31-roll@probe.cn',
    'q31-strat@probe.cn',
    'q31-stratnote@probe.cn',
    'q31-lone@probe.cn',
    'nc-abs@probe.cn',
    'nc-strat@probe.cn',
    'nc-stratnote@probe.cn',
    'nc-natreason@probe.cn',
    'nc-natdiag@probe.cn',
    'nc-rawreason@probe.cn',
    'nc-revorigin@probe.cn',
    'nc-memreason@probe.cn',
    'unpub-peak@probe.cn',
    'alice_secret',
    'bob_secret',
  ];
  for (const token of leakedProbes) {
    assert.equal(html59.includes(token), false, `token ${token} must not leak into r59 HTML`);
  }
  assert.equal(html58.includes('revnote-str@probe.cn'), false, 'r58 review_notes string must be scrubbed');
  assert.equal(html58.includes('revnote-obj@probe.cn'), false, 'r58 review_notes object must be scrubbed');
  assert.equal(html58.includes('Alice Reviewer'), false, 'r58 review_notes reviewer PII must be redacted');
  assert.doesNotMatch(html59, /旺旺/);
  assert.match(html59, /1688 问厂核对/);
  assert.ok(html59.includes('https://example.com/Users/keepme'), 'https:// URL with /Users/ segment must be preserved');
  assert.ok(html59.includes('https://example.com/home/keepme'), 'https:// URL with /home/ segment must be preserved');
  assert.ok(html59.includes(png), 'data:image/png;base64 URI must be preserved untouched');
  assert.match(html59, /依据：<a href="#candidate-1-e0">来源 \[REDACTED_EMAIL\] \[1\]<\/a>/);
  assert.match(html59, /旺季待定 \[REDACTED_EMAIL\]/);
});

// --- Migrated from test/revision58.test.mjs (B13 pass tone, banner sync, CSS t6, price hiding, path/UNC/apostrophe redaction) ---

test('B13 & Report Notes: exact 30% HTML pass tone, banner count sync with qualification, local path redaction, CSS tabs >= t6, and root+period stress merge', () => {
  const exact30Cand = structuredClone(fixture.candidates[0]);
  exact30Cand.id = 'b13-exact-30';
  const sc = exact30Cand.economics.scenarios[0];
  sc.cost_ledger.price_usd = 29.99;
  sc.cost_ledger.refund_fraction = 0;
  sc.cost_ledger.physical_return_fraction = 0;
  exact30Cand.screening.reference_price_usd.value = 29.99;
  const lines = sc.cost_ledger.lines;
  lines.find(l => l.id === 'referral').amount_usd = 4.4985;
  lines.find(l => l.id === 'fulfillment').amount_usd = 5.0;
  lines.find(l => l.id === 'placement').amount_usd = 0.4;
  lines.find(l => l.id === 'storage').amount_usd = 0.1;
  lines.find(l => l.id === 'returns_processing').amount_usd = 0;
  sc.cost_ledger.collection_rate = 0;
  lines.find(l => l.id === 'collection').amount_usd = 0;
  lines.find(l => l.id === 'headhaul').amount_usd = 1.0;
  lines.find(l => l.id === 'domestic_freight').amount_usd = 0.5;
  lines.find(l => l.id === 'procurement').amount_usd = 9.4945;
  exact30Cand.economics.scenarios = [sc];
  exact30Cand.economics.expected_primary_scenarios = [
    { id: sc.id, status: 'active' },
    { id: 'cancelled-with-path', status: 'cancelled', reason: 'Cancelled per C:/Users/AUDIT_NAME/quote.txt', evidence: ['synthetic-evidence'] },
  ];
  exact30Cand.economics.stress_scenarios = [
    {
      id: 'fbm-stress',
      label: 'Stress C:/Users/AUDIT_NAME/quote.txt <unsafe>',
      price_usd: 29.99,
      margin: 0.25,
      contribution_usd: 7.5,
      assumptions: ['Ref C:/Users/AUDIT_NAME/quote.txt'],
    },
  ];
  const exactBatch = { ...structuredClone(fixture), candidates: [exact30Cand] };
  const exactRes = scoreBatch(exactBatch, profile);
  assert.equal(exactRes.summary.qualifying, 1);
  assert.ok(exactRes.candidates[0].diagnostics.economics.scenarios[0].input.calculation.margin < 0.3);
  const exactHtml = renderReport(exactRes, exactBatch);
  const exactBody = exactHtml.split('<body>')[1];
  assert.doesNotMatch(exactBody, /低于红线/);
  assert.doesNotMatch(exactBody, /ink-fail|alloc-margin-fail|swatch-fail/);
  assert.match(exactBody, /\+0 pts 高于红线/);
  assert.equal(exactHtml.includes('AUDIT_NAME'), false);
  assert.ok(exactHtml.includes('&lt;unsafe&gt;'));

  const mutatedRes = structuredClone(exactRes);
  mutatedRes.candidates[0].qualification.counts_toward_target = false;
  const mutatedHtml = renderReport(mutatedRes, exactBatch);
  const mutatedBody = mutatedHtml.split('<body>')[1];
  assert.match(mutatedBody, /完整可比 0 个/);
  assert.match(mutatedBody, /达标可推进 0/);
  assert.match(mutatedBody, /data-eligible="false"/);
  assert.doesNotMatch(mutatedBody, /data-eligible="true"/);

  const multiPeriod = makeSeasonalCandidate('b13-six-periods');
  const pendingBase = structuredClone(multiPeriod.economics.operating_periods[1]);
  const comparableBase = structuredClone(multiPeriod.economics.operating_periods[0]);
  comparableBase.id = 'p6_comparable';
  comparableBase.label = '第6时段';
  comparableBase.months = [6, 7, 8, 9];
  comparableBase.scenarios[0].cost_ledger.fee_context.sales = { from: '2027-06-01', through: '2027-09-30' };
  comparableBase.scenarios[0].cost_ledger.fee_context.storage = { from: '2027-06-01', through: '2027-09-30' };
  comparableBase.stress_scenarios = [{ id: 'period-stress', label: 'Period stress', price_usd: 36, margin: 0.24 }];
  multiPeriod.economics.stress_scenarios = [{ id: 'root-stress', label: 'Root stress', price_usd: 35, margin: 0.22 }];
  multiPeriod.economics.operating_periods = [1, 2, 3, 4, 5].map(m => {
    const p = structuredClone(pendingBase);
    p.id = `p${m}`;
    p.label = `时段 ${m}`;
    p.months = [m];
    p.scenarios[0].cost_ledger.fee_context.sales = { from: `2027-0${m}-01`, through: `2027-0${m}-28` };
    p.scenarios[0].cost_ledger.fee_context.storage = { from: `2027-0${m}-01`, through: `2027-0${m}-28` };
    return p;
  }).concat([comparableBase]);
  const mpBatch = { ...structuredClone(fixture), candidates: [multiPeriod] };
  const mpRes = scoreBatch(mpBatch, profile);
  const p6Out = mpRes.candidates[0].operating_periods.find(p => p.id === 'p6_comparable');
  assert.equal(p6Out.diagnostics.economics.stress_scenarios.length, 2);
  const mpHtml = renderReport(mpRes, mpBatch);
  assert.match(mpHtml, /id="candidate-1-t6" checked/);
  assert.match(mpHtml, /\.card-tabs:has\(input\[id\$="-t6"\]:checked\) \.tab-p6/);
});

test('r59 Codex Rounds 2–6 report hiding and Windows/UNC/apostrophe/query-param path redaction', () => {
  const fresh = () => structuredClone(fixture.candidates[0]);
  const single = c => ({ ...structuredClone(fixture), candidates: [c] });
  const score = c => scoreBatch(single(c), profile);
  const bodyHtml = c => renderReport(score(c), single(c)).split('<body>')[1];

  // Round-2 Finding 3: unanchored $59.99 NOT displayed as green 55.35% or 美站参照价
  const f3High = fresh();
  f3High.id = 'f3-high-hidden';
  f3High.screening.reference_price_usd.value = 29.99;
  f3High.economics.scenarios[0].cost_ledger.price_usd = 59.99;
  f3High.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  const f3HtmlBody = bodyHtml(f3High);
  assert.doesNotMatch(f3HtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);
  assert.match(f3HtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 29\.99/);
  assert.doesNotMatch(f3HtmlBody, /hero-stat-val ink-pass">55\.35%/);

  // Round-2 Finding 7: spaced username & primary scenario label path redacted
  const f7Cand = fresh();
  f7Cand.id = 'f7-path-redact';
  f7Cand.economics.scenarios[0].label = 'Main C:/Users/AUDIT_NAME/quote.txt';
  f7Cand.economics.stress_scenarios = [{
    id: 'st-space', label: 'Stress C:/Users/Audit SurnameProof/quote.txt', price_usd: 35, margin: 0.25,
    assumptions: ['Proof C:/Users/Audit SurnameProof/quote.txt'],
  }];
  f7Cand.economics.expected_primary_scenarios = [
    { id: f7Cand.economics.scenarios[0].id, status: 'active' },
    { id: 'c-space', status: 'cancelled', reason: 'Per C:/Users/Audit SurnameProof/quote.txt', evidence: ['synthetic-evidence'] },
  ];
  const f7Html = renderReport(score(f7Cand), single(f7Cand));
  assert.equal(f7Html.includes('SurnameProof'), false);
  assert.equal(f7Html.includes('AUDIT_NAME'), false);

  // Round-3 R3-3 & R3-8
  const sensHigh = fresh();
  sensHigh.id = 'r3-sens-high';
  sensHigh.screening.reference_price_usd.value = 29.99;
  sensHigh.economics.scenarios[0].cost_ledger.price_usd = 59.99;
  sensHigh.economics.scenarios[0].cost_ledger.sensitivity_only = true;
  sensHigh.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  const sensHtmlBody = bodyHtml(sensHigh);
  assert.doesNotMatch(sensHtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);
  assert.match(sensHtmlBody, /<dt>美站参照价<\/dt><dd>US\$ 29\.99/);
  assert.doesNotMatch(sensHtmlBody, /ink-pass[^>]*>(?:<strong>)?55\.35%/);

  const r3Path = fresh();
  r3Path.id = 'r3-path-apos-unc';
  r3Path.economics.scenarios[0].label = "Main C:/Users/Audit O'ApostropheProof/quote.txt <script>x</script>";
  r3Path.economics.stress_scenarios = [
    { id: 'st-apos', label: "Stress \\\\?\\UNC\\fileserver\\share\\Users\\Audit O'ApostropheProof\\quote.txt", price_usd: 35, margin: 0.25, assumptions: ["Note C:/Users/Audit O'ApostropheProof/quote.txt", "UNC \\\\?\\UNC\\fileserver\\c$\\Users\\Audit O'ApostropheProof\\quote.txt"] },
  ];
  r3Path.economics.expected_primary_scenarios = [
    { id: r3Path.economics.scenarios[0].id, status: 'active' },
    { id: 'c-apos', status: 'cancelled', reason: "Per \\\\?\\UNC\\fileserver\\share\\Users\\Audit O'ApostropheProof\\quote.txt", evidence: ['synthetic-evidence'] },
  ];
  const r3PathHtml = renderReport(score(r3Path), single(r3Path));
  assert.equal(r3PathHtml.includes('ApostropheProof'), false);
  assert.equal(r3PathHtml.includes('fileserver'), false);
  assert.equal(r3PathHtml.includes('<script>x</script>'), false);

  // Round-4 R4-04 & R4-11
  const c4 = fresh();
  c4.screening.reference_price_usd.value = 29.99;
  const s4 = c4.economics.scenarios[0];
  Object.assign(s4.cost_ledger, { price_usd: 59.99, sensitivity_only: true });
  s4.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  s4.price_anchor = { ...c4.screening.reference_price_usd, value: 59.99 };
  const html4 = bodyHtml(c4);
  assert.doesNotMatch(html4, /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);
  assert.doesNotMatch(html4, /ink-pass[^>]*>(?:<strong>)?55\.35%/);
  assert.doesNotMatch(html4, /alloc-strip/);

  const c4p = structuredClone(c4);
  delete c4p.economics.scenarios[0].cost_ledger.sensitivity_only;
  c4p.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment').fee_basis = { status: 'unavailable' };
  assert.doesNotMatch(bodyHtml(c4p), /<dt>美站参照价<\/dt><dd>US\$ 59\.99/);

  const c11 = fresh();
  c11.presentation.summary = "Summary C:/Users/Audit O'ApostropheProof/quote.txt and https://example.com/home/keepme";
  c11.economics.scenarios[0].label = "Main C:\\Users\\D' AngeloSpaceProof\\quote.txt";
  const stHi = structuredClone(c11.economics.scenarios[0]);
  stHi.id = stHi.cost_ledger.id = 's-perm';
  stHi.label = "file:////?/UNC/fileserver/share/Users/D' AngeloSpaceProof/quote.txt";
  stHi.cost_ledger.price_usd = 59.99;
  stHi.assumptions = ["file://fileserver/share/Users/Audit O'ApostropheProof/quote.txt"];
  c11.economics.stress_scenarios = [stHi];
  const html11 = renderReport(score(c11), single(c11));
  assert.equal(html11.includes('ApostropheProof'), false);
  assert.equal(html11.includes('SpaceProof'), false);
  assert.equal(html11.includes('fileserver'), false);
  assert.equal(html11.includes('https://example.com/home/keepme'), true);

  // Round-5 R5-04 & R5-11
  const c4s = fresh();
  c4s.screening.reference_price_usd.value = 29.99;
  const s4s = c4s.economics.scenarios[0];
  Object.assign(s4s.cost_ledger, { price_usd: 59.99, sensitivity_only: 'true' });
  s4s.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 12;
  s4s.price_anchor = { ...c4s.screening.reference_price_usd, value: 59.99 };
  assert.doesNotMatch(bodyHtml(c4s), /ink-pass[^>]*>(?:<strong>)?55\.35%/);

  const c11r5 = fresh();
  c11r5.presentation.summary = "Quoted 'C:\\Users\\D' AngeloProof\\quote.txt' and standalone";
  c11r5.market.average_star_rating = { value: 4.4, note: 'C:/Users/RawProof/q.txt' };
  c11r5.presentation.procurement = [
    { label: 'ObjKey', value: { 'C:/Users/KeyProof/q.txt': 'file:///home/PosixProof/q.txt' }, url: 'https://example.com/?f=C%3A%2FUsers%2FParamProof%2Fq.txt' },
  ];
  const h11r5 = bodyHtml(c11r5);
  for (const tok of ['AngeloProof', 'RawProof', 'KeyProof', 'PosixProof', 'ParamProof']) {
    assert.equal(h11r5.includes(tok), false, `R5-11 leak token ${tok}`);
  }

  // Round-6 Finding 7: bare single-quoted directory & nested value.image_data_uri
  const cHtml = fresh();
  cHtml.presentation.summary = "Evidence 'C:\\Users\\D' FolderProbe' and 'keep' then 'C:\\Users\\D' FolderProbe2'. Also 'C:\\Users\\FolderProbe5' don't drop.";
  cHtml.presentation.procurement = [
    {
      label: 'NestedImg',
      value: { image_data_uri: 'file:///home/FolderProbe3/x' },
      url: "https://example.com/?q=Evidence%20%27C%3A%5CUsers%5CD%27%20FolderProbe4%27",
    },
  ];
  const h6 = bodyHtml(cHtml);
  for (const tok of ['FolderProbe', 'FolderProbe2', 'FolderProbe3', 'FolderProbe4', 'FolderProbe5']) {
    assert.equal(h6.includes(tok), false, `Round-6 leak token ${tok}`);
  }
  assert.equal(h6.includes('Evidence &#39;~&#39; and &#39;keep&#39; then &#39;~&#39;. Also &#39;~&#39; don&#39;t drop.'), true);
});

const A2_SPEC_SHA_V1 = '1'.repeat(64);

// Real Pillow-generated, Pillow-decodable baseline JPEG (64x48, Orientation 1),
// EXIF Orientation 6 JPEG (480x120 raw -> 120x480 displayed), and WebP (160x120 VP8).
const BASE_JPEG_64X48_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDMooor6Q8AKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';

const EXIF6_JPEG_480X120_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAB4AeADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDOooor5s+sCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=';

const BASE_WEBP_160X120_B64 =
  'UklGRngCAABXRUJQVlA4IGwCAADwCwCdASqgAHgAPm02mUmkIqIhIGgAgA2JaG7gMFmIQD//h5wGUI4G81/gH8A/jH5G/IJwDyDdFPgH4F/YrO+wBEAaci1R0uXLcQ9qIwnHIJNoaqk2TEOqpPg9kxDsXYgnHJnGvRlvAAD+5AX/8gUQgv/QrBJHXMa16+W344AsDGTLFIHGzQc4MlWB4MZGpVXEyHownsakELYRcftdmgUfETtxYnKVuV9yEM/Kj4iduNbdX8FmaOzETy6s3Ak11PCAcX5NGwSPASd6ayqhK0aW9irLILiKdlPJP5OmarQtlauTcLvZeVR1OGJtmCFiXzl6hMTHDFi4PY69tix7nTX+7vpH6nKeOQepwYQsNWYag/tlVYz4Ym2YIWJfOYGOzn8MVWiZISVbMNNanjuHqcLIONgxTyasDFLu72vPdKcCY900KsMRrXn0g1lVCVo0t6P3PqfOYGOzn8MVWiZISVbMNNanjuHqcGELDVmGoO4q5Af/GYpsZiZS4lE2UiCTsQYk72uqbeEaRE1Jr/d30j9TlPHIPU4MIWGrMNQf2yqsZ8MTbMELEvnMDHZz+GKrh+h/y7+VGKRVQa159INZVQlaNLej9z6nzmBjs5/DFVomSElWzDTWp47h6nBhCw1ZhqD+2VVjPhibZghYl85eoTExwxYuD2OvbYse501/u76R+pynjkHqcGELDVmGoP7ZVWM+GJtmCFiXzmBjs5/DFVomSElWzDTWp47h6nCyDjYMU8mrAxS7u9rz3SnAmPdNCrDEa159INZVQlaNLej9z6nzmBjs5/DFVomSElWzDTWp47h6nBhCw1ZhqDcAAA==';

function a2Crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function a2PngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(a2Crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeDecodablePngDataUri(width, height, { seedByte = 0x2a, solid = false, compressionLevel = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[off + 1 + x * 3] = solid ? seedByte : ((seedByte + x * 7 + y * 13) & 0xff);
      raw[off + 2 + x * 3] = solid ? ((seedByte + 40) & 0xff) : ((seedByte * 3 + x * 11 + y * 5) & 0xff);
      raw[off + 3 + x * 3] = solid ? ((seedByte + 80) & 0xff) : ((seedByte * 5 + x * 3 + y * 17) & 0xff);
    }
  }
  const idat = deflateSync(raw, { level: compressionLevel });
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    a2PngChunk('IHDR', ihdr),
    a2PngChunk('IDAT', idat),
    a2PngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function makeDecodableJpegWithComPadding(baseB64, comPadBytes = 3200) {
  const raw = Buffer.from(baseB64, 'base64');
  // Insert a valid JPEG COM segment (0xFF 0xFE) right after SOI (2B) + APP0 (18B) = offset 20.
  const com = Buffer.alloc(4 + comPadBytes, 0x41);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(comPadBytes + 2, 2);
  const combined = Buffer.concat([raw.subarray(0, 20), com, raw.subarray(20)]);
  return `data:image/jpeg;base64,${combined.toString('base64')}`;
}

function makeMalformedExifJpegDataUri(baseB64) {
  const raw = Buffer.from(baseB64, 'base64');
  // Insert a truncated/malformed APP1 "Exif\0\0" segment right after APP0 (offset 20).
  const badApp1Payload = Buffer.from('Exif\0\0BAD!', 'ascii');
  const app1 = Buffer.alloc(4 + badApp1Payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(badApp1Payload.length + 2, 2);
  badApp1Payload.copy(app1, 4);
  const combined = Buffer.concat([raw.subarray(0, 20), app1, raw.subarray(20)]);
  return `data:image/jpeg;base64,${combined.toString('base64')}`;
}

function makeDualPeriodCandidate(seasonality) {
  const base = makeStage4OrganizerTrayCandidate(fixture.candidates[0], {
    specSha256: A2_SPEC_SHA_V1,
    specVersion: 1,
  });
  base.product_seasonality = seasonality;
  const offScenarios = structuredClone(base.economics.scenarios);
  const peakScenarios = structuredClone(base.economics.scenarios).map(sc => {
    sc.id = `${sc.id}-peak`;
    sc.cost_ledger.id = sc.id;
    sc.cost_ledger.fee_context.sales = { from: '2027-10-15', through: '2027-12-31' };
    sc.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
    sc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
    const ful = sc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    ful.status = 'pending';
    ful.amount_usd = null;
    ful.fee_basis = { status: 'unavailable', version: 'US-FBA-2027-peak-unpublished', marketplace: 'US', currency: 'USD', year: 2027 };
    const col = sc.cost_ledger.lines.find(l => l.id === 'collection');
    col.status = 'pending';
    col.amount_usd = null;
    return sc;
  });
  base.economics = {
    saleable_unit: base.economics.saleable_unit,
    operating_periods: [
      {
        id: 'off_peak',
        label: '2027 淡季',
        months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        expected_primary_scenarios: offScenarios.map(sc => ({ id: sc.id, status: 'active' })),
        scenarios: offScenarios,
      },
      {
        id: 'peak_q4',
        label: '2027 旺季',
        months: [10, 11, 12],
        expected_primary_scenarios: peakScenarios.map(sc => ({ id: sc.id, status: 'active' })),
        scenarios: peakScenarios,
      },
    ],
  };
  return base;
}

test('Batch A2.1: post-ruling break_even_click_cvr, evergreen off_peak ruling parity, non-scorable labels, all-excluded ad summary, and crossing-30% copy', () => {
  const baseCand = makeStage4OrganizerTrayCandidate(fixture.candidates[0], {
    specSha256: A2_SPEC_SHA_V1,
    specVersion: 1,
  });

  // 1. Undisputed baseline preserves normal CVR and "已纳入" pre-declared status
  const baseBatch = { schema_version: 1, profile_revision: 59, candidates: [baseCand] };
  const baseScored = scoreBatch(baseBatch, profile);
  assert.equal(baseScored.candidates[0].diagnostics.economics.scenarios.every(isUsableActivePricingScenario), true);
  assert.ok(baseScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios.every(s => s.break_even_click_cvr > 0));
  const baseHtml = renderReport(baseScored, baseBatch);
  assert.match(baseHtml, /sc-low-no-tray（已纳入）/);
  assert.match(baseHtml, /sc-high-parts-unknown（已纳入）/);

  // 2. Formal ruling: low excluded + high pending_evidence -> zero leaked CVR %, zero stale "已纳入", and card-level ad summary
  const ruledCand = applyPeerComparabilityRulings(structuredClone(baseCand), [
    {
      peer_asin: 'B0SYN8LOW1',
      status: 'confirmed_excluded',
      source: 'owner_catalog_check',
      reason: '低价对标缺少可拆托盘，排除同套售价。',
      evidence: [baseCand.evidence[0].id],
    },
    {
      peer_asin: 'B0SYN8HIG2',
      status: 'pending_evidence',
      source: 'owner_catalog_check',
      reason: '高价对标同箱配件清单待补证。',
      evidence: [baseCand.evidence[0].id],
    },
  ]);
  const ruledBatch = { schema_version: 1, profile_revision: 59, candidates: [ruledCand] };
  const ruledScored = scoreBatch(ruledBatch, profile);
  const ruledEcon = ruledScored.candidates[0].diagnostics.economics;
  assert.equal(ruledEcon.scenarios.some(isUsableActivePricingScenario), false);
  const beLow = ruledEcon.break_even_click_cvr.scenarios.find(s => s.id === 'sc-low-no-tray');
  const beHigh = ruledEcon.break_even_click_cvr.scenarios.find(s => s.id === 'sc-high-parts-unknown');
  assert.equal(beLow.contribution_usd, null);
  assert.equal(beLow.break_even_click_cvr, null);
  assert.equal(beLow.excluded_from_active_pricing, true);
  assert.equal(beHigh.contribution_usd, null);
  assert.equal(beHigh.break_even_click_cvr, null);

  const ruledHtml = renderReport(ruledScored, ruledBatch);
  const adRowMatch = ruledHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/);
  assert.ok(adRowMatch, 'expected ad breakeven row in waterfall table');
  assert.match(adRowMatch[0], /无已确认可用主情景 · 广告盈亏平衡待补证/);
  assert.match(adRowMatch[0], /证据已排除/);
  assert.match(adRowMatch[0], /待补证/);
  assert.doesNotMatch(adRowMatch[0], /\d+(?:\.\d+)?%/, 'ruled card with no confirmed active scenario must not display any CVR %');

  const expRowMatch = ruledHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/);
  assert.ok(expRowMatch);
  assert.doesNotMatch(expRowMatch[0], /已纳入/, 'excluded/pending ruled scenarios must never display stale 已纳入');
  assert.match(expRowMatch[0], /sc-low-no-tray（[^）]*排除[^）]*）/);
  assert.match(expRowMatch[0], /sc-high-parts-unknown（[^）]*待补证[^）]*）/);

  // 3. All-excluded scenarios (both with and without reference bid) keep per-cell exclusion and show card-level ad-breakeven summary
  const allExclCand = applyPeerComparabilityRulings(structuredClone(baseCand), [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_check', reason: '排除低价' },
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_excluded', source: 'owner_check', reason: '排除高价' },
  ]);
  for (const dropBid of [false, true]) {
    const c = structuredClone(allExclCand);
    if (dropBid) delete c.bids;
    const b = { schema_version: 1, profile_revision: 59, candidates: [c] };
    const s = scoreBatch(b, profile);
    const h = renderReport(s, b);
    const row = h.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
    assert.ok(row, `all-excluded card (dropBid=${dropBid}) must still show ad breakeven summary row`);
    assert.match(row, /无已确认可用主情景 · 广告盈亏平衡待补证/);
    assert.equal((row.match(/证据已排除/g) ?? []).length, 2);
    assert.doesNotMatch(row, /\d+(?:\.\d+)?%/);
  }

  // 4. Dual-period evergreen card unwrapped from unpublished Q4 companion MUST preserve off_peak period_id rulings (Astra P1 #1)
  const evgDual = applyPeerComparabilityRulings(makeDualPeriodCandidate('evergreen'), [
    { peer_asin: 'B0SYN8LOW1', period_id: 'off_peak', status: 'confirmed_excluded', source: 'owner_check', reason: '淡季低价无托盘排除' },
    { peer_asin: 'B0SYN8HIG2', period_id: 'off_peak', status: 'pending_evidence', source: 'owner_check', reason: '淡季高价配件待补证' },
  ]);
  const evgDualBatch = { schema_version: 1, profile_revision: 59, candidates: [evgDual] };
  const evgDualScored = scoreBatch(evgDualBatch, profile);
  const evgDualCard = evgDualScored.candidates[0];
  assert.equal(evgDualCard.qualification.counts_toward_target, false, 'evergreen unwrapped card must respect off_peak-scoped rulings');
  assert.equal(evgDualCard.diagnostics.economics.operating_period_id, 'off_peak');
  assert.ok(evgDualCard.diagnostics.economics.break_even_click_cvr.scenarios.every(s => s.break_even_click_cvr === null));
  const evgDualHtml = renderReport(evgDualScored, evgDualBatch);
  const evgDualAdRow = evgDualHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.doesNotMatch(evgDualAdRow, /\d+(?:\.\d+)?%/, 'unwrapped evergreen card must not leak CVR % from excluded/pending off_peak scenarios');
  assert.match(evgDualAdRow, /证据已排除/);
  assert.match(evgDualAdRow, /待补证/);
  const evgDualExpRow = evgDualHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.doesNotMatch(evgDualExpRow, /已纳入/);
  assert.doesNotMatch(evgDualHtml, /非旺季达标/);

  // 5. Re-pricing: confirming high scenario restores CVR ONLY on high scenario; low stays excluded
  const repricedCand = applyPeerComparabilityRulings(structuredClone(ruledCand), [
    {
      peer_asin: 'B0SYN8HIG2',
      status: 'confirmed_comparable',
      source: 'owner_parts_verified',
      reason: '已核实同箱配件一致，确认可比。',
      evidence: [baseCand.evidence[0].id],
    },
  ]);
  const repricedBatch = { schema_version: 1, profile_revision: 59, candidates: [repricedCand] };
  const repricedScored = scoreBatch(repricedBatch, profile);
  const repBeLow = repricedScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios.find(s => s.id === 'sc-low-no-tray');
  const repBeHigh = repricedScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios.find(s => s.id === 'sc-high-parts-unknown');
  assert.equal(repBeLow.break_even_click_cvr, null);
  assert.ok(repBeHigh.break_even_click_cvr > 0);
  const repricedHtml = renderReport(repricedScored, repricedBatch);
  const repAdRow = repricedHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(repAdRow, /证据已排除/);
  assert.match(repAdRow, /\d+(?:\.\d+)?%/);
  const repExpRow = repricedHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.doesNotMatch(repExpRow, /sc-low-no-tray（已纳入）/);
  assert.match(repExpRow, /sc-low-no-tray（[^）]*排除[^）]*）/);

  // 6. confirmed_comparable + sensitivity_only & unpublished Q4 pending scenarios must NEVER say "已纳入" (Astra P2 #8)
  const compSensCand = applyPeerComparabilityRulings(structuredClone(baseCand), [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_comparable', source: 'owner_check', reason: '确认可比但仅作试算' },
  ]);
  compSensCand.economics.scenarios = [structuredClone(compSensCand.economics.scenarios[0])];
  compSensCand.economics.expected_primary_scenarios = [{ id: compSensCand.economics.scenarios[0].id, status: 'active' }];
  compSensCand.economics.scenarios[0].cost_ledger.sensitivity_only = true;
  const compSensBatch = { schema_version: 1, profile_revision: 59, candidates: [compSensCand] };
  const compSensScored = scoreBatch(compSensBatch, profile);
  assert.equal(compSensScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios[0].break_even_click_cvr, null);
  const compSensHtml = renderReport(compSensScored, compSensBatch);
  const compSensAdRow = compSensHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(compSensAdRow, /待补证/);
  assert.doesNotMatch(compSensAdRow, /\d+(?:\.\d+)?%/);
  const compSensExpRow = compSensHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.match(compSensExpRow, /裁决确认可比 · 条件试算 · 不计分/);
  assert.doesNotMatch(compSensExpRow, /已纳入/);

  // Seasonal Q4 unpublished-fulfillment scenarios must also say 待补证 instead of 已纳入
  const seasDual = makeDualPeriodCandidate('seasonal');
  const seasDualBatch = { schema_version: 1, profile_revision: 59, candidates: [seasDual] };
  const seasDualHtml = renderReport(scoreBatch(seasDualBatch, profile), seasDualBatch);
  const peakSection = seasDualHtml.match(/data-operating-period="peak_q4"[\s\S]*?<\/section>/)?.[0] ?? '';
  const peakExpRow = peakSection.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.ok(peakExpRow, 'expected Q4 expected_primary_scenarios line');
  assert.doesNotMatch(peakExpRow, /已纳入/, 'unpublished Q4 scenarios must not claim 已纳入');
  assert.match(peakExpRow, /待补证/);

  // 7. Crossing-30% card (counts_toward_target: false) qualifies scenario copy with explicit non-qualifying context
  const crossCand = structuredClone(fixture.candidates[0]);
  crossCand.id = 'cand-a2-crossing-honest';
  const scPass = structuredClone(crossCand.economics.scenarios[0]);
  scPass.id = scPass.cost_ledger.id = 'sc-cross-pass';
  scPass.quote_id = 'q-factory-pass';
  const scFail = structuredClone(scPass);
  scFail.id = scFail.cost_ledger.id = 'sc-cross-fail';
  scFail.quote_id = 'q-factory-fail';
  delete scFail.margin;
  delete scFail.contribution_usd;
  scFail.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 21.0;
  const r = scFail.cost_ledger.refund_fraction;
  const ref = scFail.cost_ledger.lines.find(l => l.id === 'referral').amount_usd;
  const payout = 40 * (1 - r) - (ref - r * (ref - Math.min(5, 0.2 * ref))) - 4.86 - 0.54 - 0.2925;
  scFail.cost_ledger.lines.find(l => l.id === 'collection').amount_usd = Number((payout * scFail.cost_ledger.collection_rate).toFixed(10));
  crossCand.economics.expected_primary_scenarios = [{ id: 'sc-cross-pass', status: 'active' }, { id: 'sc-cross-fail', status: 'active' }];
  crossCand.economics.scenarios = [scPass, scFail];
  const crossBatch = { schema_version: 1, profile_revision: 59, candidates: [crossCand] };
  const crossScored = scoreBatch(crossBatch, profile);
  assert.equal(crossScored.candidates[0].qualification.counts_toward_target, false);
  const crossHtml = renderReport(crossScored, crossBatch);
  assert.match(crossHtml, /跨 30% 红线（整卡未达标，不计入入围目标）/);
  assert.doesNotMatch(crossHtml, /<span class="ink-pass">达标可做：/);
  assert.doesNotMatch(crossHtml, /—/);
});

test('Batch A2.2: single-file HTML deduplicates decodable PNG/JPEG/WebP, rotates EXIF Orientation 6, guards malformed EXIF & tiny PNG bloat', () => {
  const pngA = makeDecodablePngDataUri(80, 60, { seedByte: 0x31, compressionLevel: 0 }); // ~19 KB real PNG
  const jpegB = makeDecodableJpegWithComPadding(BASE_JPEG_64X48_B64, 3600); // ~5.7 KB real Pillow-decodable JPEG (64x48)
  const exif6Jpeg = `data:image/jpeg;base64,${EXIF6_JPEG_480X120_B64}`; // real 480x120 EXIF-6 -> displayed 120x480
  const webpC = `data:image/webp;base64,${BASE_WEBP_160X120_B64}`; // real Pillow-decodable 160x120 WebP
  const pngSingle = makeDecodablePngDataUri(32, 24, { seedByte: 0x77, compressionLevel: 0 });

  const b64A = pngA.split(',')[1];
  const b64B = jpegB.split(',')[1];
  const b64Exif6 = EXIF6_JPEG_480X120_B64;
  const b64C = BASE_WEBP_160X120_B64;

  // Build independent 1x1-placeholder baseline batch (exact same figure/lightbox/AI-CSS structure, negligible payloads)
  const tiny1x1Png = makeDecodablePngDataUri(1, 1, { seedByte: 0x11, solid: true, compressionLevel: 9 });
  const noImgBatch = structuredClone(fixture);
  for (const c of noImgBatch.candidates) {
    if (c.presentation) {
      delete c.presentation.hero_image_data_uri;
      delete c.presentation.contact_sheet_data_uri;
      delete c.presentation.image_data_uri;
    }
    delete c.concept_images;
  }
  const placeholderBatch = structuredClone(noImgBatch);
  placeholderBatch.candidates[0].presentation.hero_image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[0].presentation.contact_sheet_data_uri = tiny1x1Png;
  placeholderBatch.candidates[0].presentation.image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[0].concept_images = [
    { data_uri: tiny1x1Png, title: '重复概念图 A', caption: '复用同一 PNG 载荷' },
    { data_uri: tiny1x1Png, title: '概念图 B', caption: '复用真实 JPEG 载荷' },
    { data_uri: tiny1x1Png, title: '概念图 C', caption: '复用真实 WebP 载荷' },
    { data_uri: tiny1x1Png, title: '旋转照片 D', caption: 'EXIF Orientation 6 应按 120x480 展示' },
  ];
  placeholderBatch.candidates[1].presentation.hero_image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[1].presentation.image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[1].presentation.contact_sheet_data_uri = tiny1x1Png;
  placeholderBatch.candidates[2].presentation.hero_image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[2].presentation.image_data_uri = tiny1x1Png;
  const placeholderHtml = renderReport(scoreBatch(placeholderBatch, profile), placeholderBatch);
  const placeholderBytes = Buffer.byteLength(placeholderHtml, 'utf8');

  const batch = structuredClone(noImgBatch);
  batch.candidates[0].presentation.hero_image_data_uri = pngA;
  batch.candidates[0].presentation.contact_sheet_data_uri = pngA;
  batch.candidates[0].presentation.image_data_uri = pngA;
  batch.candidates[0].concept_images = [
    { data_uri: pngA, title: '重复概念图 A', caption: '复用同一 PNG 载荷' },
    { data_uri: jpegB, title: '概念图 B', caption: '复用真实 JPEG 载荷' },
    { data_uri: webpC, title: '概念图 C', caption: '复用真实 WebP 载荷' },
    { data_uri: exif6Jpeg, title: '旋转照片 D', caption: 'EXIF Orientation 6 应按 120x480 展示' },
  ];
  batch.candidates[1].presentation.hero_image_data_uri = pngA;
  batch.candidates[1].presentation.image_data_uri = jpegB;
  batch.candidates[1].presentation.contact_sheet_data_uri = webpC;
  batch.candidates[2].presentation.hero_image_data_uri = pngSingle;
  batch.candidates[2].presentation.image_data_uri = exif6Jpeg;

  const scored = scoreBatch(batch, profile);
  const html = renderReport(scored, batch);
  assert.equal(html, renderReport(scored, batch), 'deduplicated HTML must be deterministic');

  // Strict single-file script-free CSP invariants
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /script-src 'none'; connect-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(html, /—/);

  // Each repeated base64 payload appears STRICTLY ONCE in the entire standalone HTML
  const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;
  assert.equal(countOccurrences(html, b64A), 1, 'repeated PNG must appear once');
  assert.equal(countOccurrences(html, b64B), 1, 'repeated JPEG must appear once');
  assert.equal(countOccurrences(html, b64C), 1, 'repeated WebP must appear once');
  assert.equal(countOccurrences(html, b64Exif6), 1, 'repeated EXIF-6 JPEG must appear once');
  assert.equal(countOccurrences(html, pngSingle.split(',')[1]), 1, 'single-use PNG appears once');

  // Independent byte-savings check against 1x1-placeholder baseline HTML (no algebraic cancellation!)
  // Naive total embedded image payload: 8*pngA + 4*jpegB + 4*webpC + 4*exif6Jpeg + 1*pngSingle
  const uniquePayloadBytes = pngA.length + jpegB.length + webpC.length + exif6Jpeg.length + pngSingle.length;
  const naivePayloadBytes = 8 * pngA.length + 4 * jpegB.length + 4 * webpC.length + 4 * exif6Jpeg.length + pngSingle.length;
  const actualDeltaBytes = Buffer.byteLength(html, 'utf8') - placeholderBytes;
  assert.ok(
    actualDeltaBytes < uniquePayloadBytes + 4_000,
    `expected added bytes (${actualDeltaBytes}) within 4 KB of 1x unique payloads (${uniquePayloadBytes})`,
  );
  assert.ok(
    actualDeltaBytes < naivePayloadBytes * 0.25,
    `expected >75% payload savings vs naive multi-embed (${actualDeltaBytes} vs naive ${naivePayloadBytes})`,
  );

  // EXIF Orientation 6 (480x120 raw) MUST emit swapped display viewBox 120x480 (Astra P2 #4)
  assert.match(html, /<svg\b[^>]*class="img-defs-sprite"[^>]*><defs>/);
  assert.match(html, /<image\b[^>]*width="80"[^>]*height="60"/);
  assert.match(html, /<image\b[^>]*width="64"[^>]*height="48"/);
  assert.match(html, /<image\b[^>]*width="160"[^>]*height="120"/);
  assert.match(html, /<image\b[^>]*width="120"[^>]*height="480"/, 'EXIF Orientation 6 JPEG must swap to 120x480');
  assert.match(html, /viewBox="0 0 120 480"/, 'EXIF Orientation 6 SVG use must have 120x480 viewBox');
  assert.doesNotMatch(html, /viewBox="0 0 480 120"/, 'EXIF Orientation 6 must not use unrotated 480x120 viewBox');

  // Malformed EXIF APP1 must fall back safely to inline <img> (not mis-sized SVG)
  const badExifBatch = structuredClone(noImgBatch);
  badExifBatch.candidates = [badExifBatch.candidates[0]];
  const badExifUri = makeMalformedExifJpegDataUri(BASE_JPEG_64X48_B64);
  badExifBatch.candidates[0].presentation.hero_image_data_uri = badExifUri;
  badExifBatch.candidates[0].presentation.image_data_uri = badExifUri;
  const badExifHtml = renderReport(scoreBatch(badExifBatch, profile), badExifBatch);
  assert.doesNotMatch(badExifHtml, /img-defs-sprite/, 'malformed EXIF JPEG must not hoist into SVG sprite');
  assert.equal(countOccurrences(badExifHtml, badExifUri.split(',')[1]), 3, 'malformed EXIF JPEG stays inline <img>');

  // Small repeated 48x48 PNG (short URI) must NOT hoist and bloat HTML beyond inline baseline (Astra P2 #10)
  const tinyPng = makeDecodablePngDataUri(48, 48, { seedByte: 0x55, solid: true, compressionLevel: 9 });
  assert.ok(tinyPng.length < 350, `expected small compressed 48x48 PNG URI (<350 chars, got ${tinyPng.length})`);
  const tinyBatch = structuredClone(noImgBatch);
  tinyBatch.candidates = [tinyBatch.candidates[0]];
  tinyBatch.candidates[0].presentation.hero_image_data_uri = tinyPng;
  tinyBatch.candidates[0].presentation.image_data_uri = tinyPng;
  const tinyHtml = renderReport(scoreBatch(tinyBatch, profile), tinyBatch);
  assert.doesNotMatch(tinyHtml, /img-defs-sprite/, 'tiny repeated PNG must not incur one-time CSS/sprite overhead');
  assert.doesNotMatch(tinyHtml, /\.img-defs-sprite\{/);
});

test('Batch A2.3: honest 2027 Q4 unpublished peak copy and Coupon flat-fee switch / actual campaign denominator note', () => {
  // 1. Evergreen qualifying card on 2027-02-01..2027-10-14 off-peak window (Q4 peak unpublished)
  const evgCand = structuredClone(fixture.candidates[0]);
  evgCand.id = 'cand-a2-evergreen-q4-honest';
  evgCand.product_seasonality = 'evergreen';
  const sc0 = evgCand.economics.scenarios[0];
  sc0.cost_ledger.fee_context = {
    ...sc0.cost_ledger.fee_context,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  for (const line of sc0.cost_ledger.lines) {
    if (line.fee_basis) {
      line.fee_basis.effective_from = '2027-01-15';
      line.fee_basis.effective_through = line.id === 'storage' ? '2027-09-30' : '2027-10-14';
    }
  }
  const evgBatch = { schema_version: 1, profile_revision: 59, candidates: [evgCand] };
  const evgScored = scoreBatch(evgBatch, profile);
  assert.equal(evgScored.candidates[0].effective_disposition, 'full_annual_qualifying');
  assert.ok(evgScored.candidates[0].unpublished_2027_q4_peak_note);
  const evgHtml = renderReport(evgScored, evgBatch);
  assert.match(evgHtml, /非旺季达标 · 2027 Q4 旺季费率待公布/);
  assert.doesNotMatch(evgHtml, /完整达标 · 可推进/);
  assert.doesNotMatch(evgHtml, /实际核券/);
  assert.doesNotMatch(evgHtml, /—/);

  // Helper to attach ongoing coupon fields to evgCand
  const makeCouponCand = ({ id, campaignUnits, includeFlat = true }) => {
    const c = structuredClone(evgCand);
    c.id = id;
    const sc = c.economics.scenarios[0];
    sc.cost_ledger.list_price_usd = 44.0;
    sc.cost_ledger.ongoing_coupon_usd = 4.0;
    sc.cost_ledger.net_effective_price_usd = 40.0;
    sc.cost_ledger.price_usd = 40.0;
    sc.cost_ledger.promo_basis_already_net = true;
    if (campaignUnits !== undefined) sc.cost_ledger.coupon_campaign_units = campaignUnits;
    sc.cost_ledger.include_coupon_campaign_flat = includeFlat;
    sc.price_anchor = {
      value: 40.0,
      unit: 'USD',
      matched_spec: true,
      target_variant_asin: 'B0SYNCPN01',
      fulfillment_channel: 'FBA',
      sales_history_supported: true,
      list_price_usd: 44.0,
      ongoing_coupon_usd: 4.0,
      net_effective_price_usd: 40.0,
      promo_basis_already_net: true,
      evidence: [c.evidence[0].id],
    };
    c.screening.reference_price_usd = structuredClone(sc.price_anchor);
    delete sc.margin;
    delete sc.contribution_usd;
    return c;
  };

  // 2. Ongoing coupon ($5/100 + 2.5%) surfaces honest fixed-fee amortization denominator note
  const cpn100 = makeCouponCand({ id: 'cand-a2-coupon-100', campaignUnits: 100, includeFlat: true });
  const cpn100Batch = { schema_version: 1, profile_revision: 59, candidates: [cpn100] };
  const cpn100Html = renderReport(scoreBatch(cpn100Batch, profile), cpn100Batch);
  assert.match(cpn100Html, /\$5\/100 \+ 2\.5%/);
  assert.match(cpn100Html, /100 笔核券单/);
  assert.match(cpn100Html, /不与 100 套采购量挂钩/);
  assert.doesNotMatch(cpn100Html, /—/);

  // 3. Custom coupon_campaign_units = 25 reflects actual denominator (not hardcoded 100) (Astra P1 #2)
  const cpn25 = makeCouponCand({ id: 'cand-a2-coupon-25', campaignUnits: 25, includeFlat: true });
  const cpn25Batch = { schema_version: 1, profile_revision: 59, candidates: [cpn25] };
  const cpn25Html = renderReport(scoreBatch(cpn25Batch, profile), cpn25Batch);
  assert.match(cpn25Html, /\$5\/25 \+ 2\.5%/);
  assert.match(cpn25Html, /25 笔核券单/);
  assert.doesNotMatch(cpn25Html, /100 笔核券单/);

  // 4. Disabled $5 flat fee (include_coupon_campaign_flat: false) must NOT claim $5 flat fee was included (Astra P1 #2)
  const cpnNoFlat = makeCouponCand({ id: 'cand-a2-coupon-no-flat', campaignUnits: 100, includeFlat: false });
  const cpnNoFlatBatch = { schema_version: 1, profile_revision: 59, candidates: [cpnNoFlat] };
  const cpnNoFlatHtml = renderReport(scoreBatch(cpnNoFlatBatch, profile), cpnNoFlatBatch);
  assert.match(cpnNoFlatHtml, /已关闭单场 \$5 固定活动费|未计入单场 \$5 固定活动费/);
  assert.doesNotMatch(cpnNoFlatHtml, /\$5\/100 \+ 2\.5%/);
  assert.doesNotMatch(cpnNoFlatHtml, /—/);

  // 5. Conditional post-coupon banner & single-parent anchor warning (Board #130 addendum)
  const pbCand = structuredClone(evgCand);
  pbCand.id = 'cand-a2-conditional-post-coupon';
  pbCand.price_band_analysis = {
    all_young_niche: true,
    mature_regular_band: {
      all_under_90d_blue_ocean: true,
      conditional_post_coupon_observation: true,
      heavy_coupon_excluded: false,
      top_amber_banner_zh: '全员 90 天内新品蓝海（未剔除大额券，仅作条件观察）',
      single_parent_anchor_note_zh: '高价锚点仅由单一父体 P0SYNANCHOR1 支撑，定价上限存在集中度风险。',
    },
  };
  const pbBatch = { schema_version: 1, profile_revision: 59, candidates: [pbCand] };
  const pbHtml = renderReport(scoreBatch(pbBatch, profile), pbBatch);
  assert.match(pbHtml, /全员 90 天内新品蓝海（未剔除大额券，仅作条件观察）/);
  assert.doesNotMatch(pbHtml, /已按剔除 ≥20% 大额券后的在售常规价核算参考账/, 'conditional post-coupon banner must not append contradictory ex-heavy-coupon suffix');
  assert.match(pbHtml, /高价锚点集中度提醒/);
  assert.match(pbHtml, /P0SYNANCHOR1/);
  assert.doesNotMatch(pbHtml, /—/);
});

test('Batch A2.4: Keepa newcomer review-jump/drop hints gate strictly to active <=90d newcomers and scrub all PII/paths/em-dashes', () => {
  const cleanCand = structuredClone(fixture.candidates[0]);
  cleanCand.id = 'cand-a2-keepa-review-control';
  const cleanScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [cleanCand] }, profile);

  const anomCand = structuredClone(cleanCand);
  const m0 = anomCand.newcomer_cohort.members[0];
  const m1 = anomCand.newcomer_cohort.members[1];
  m0.keepa_review_jump_detected = true;
  m0.keepa_review_drop_detected = true;
  m0.keepa_review_anomaly_events = [
    {
      direction: 'jump',
      delta: 32,
      from_count: 3,
      to_count: 35,
      date_from: '2026-11-10',
      date_to: '2026-11-12',
      asin: m0.asin,
    },
    {
      direction: 'drop',
      delta: -5,
      from_count: 35,
      to_count: 30,
      date_from: '2026-11-18',
      date_to: '2026-11-19',
      asin: m0.asin,
    },
  ];
  m0.keepa_review_anomaly_summary = {
    asin: m0.asin,
    parent_asin: 'P0SYNPARENT1',
    has_jump: true,
    has_drop: true,
    event_count: 2,
    max_jump_delta: 32,
    max_drop_delta: -5,
    largest_jump: m0.keepa_review_anomaly_events[0],
    largest_drop: m0.keepa_review_anomaly_events[1],
    note_zh: `${m0.asin} 2026-11-10→2026-11-12 评论跃升 +32（3→35），2026-11-18→2026-11-19 评论骤降 -5（35→30）。`,
  };
  m1.keepa_review_jump_detected = true;
  m1.keepa_review_anomaly_events = [
    {
      direction: 'jump',
      delta: 14,
      from_count: 6,
      to_count: 20,
      date_from: '2026-11-05',
      date_to: '2026-11-07',
      asin: m1.asin,
    },
  ];

  const anomBatch = { schema_version: 1, profile_revision: 59, candidates: [anomCand] };
  const anomScored = scoreBatch(anomBatch, profile);

  // Zero score penalty & non-blocking
  const cClean = cleanScored.candidates[0];
  const cAnom = anomScored.candidates[0];
  assert.deepEqual(cAnom.total_range, cClean.total_range);
  assert.deepEqual(cAnom.core_85_range, cClean.core_85_range);
  assert.deepEqual(cAnom.supported_range, cClean.supported_range);
  assert.equal(cAnom.qualification.counts_toward_target, cClean.qualification.counts_toward_target);
  assert.deepEqual(
    cAnom.items.find(i => i.id === 'low_rating_sales_performance').score_range,
    cClean.items.find(i => i.id === 'low_rating_sales_performance').score_range,
  );
  assert.deepEqual(
    cAnom.items.find(i => i.id === 'natural_visibility_development').score_range,
    cClean.items.find(i => i.id === 'natural_visibility_development').score_range,
  );

  // Scoring diagnostics preserve both jump and drop advisories with concrete events
  const advisories = cAnom.diagnostics.newcomers.review_anomaly_advisories;
  assert.ok(Array.isArray(advisories) && advisories.length === 2);
  const adv0 = advisories.find(a => a.asin === m0.asin);
  const adv1 = advisories.find(a => a.asin === m1.asin);
  assert.equal(adv0.has_jump, true);
  assert.equal(adv0.has_drop, true);
  assert.equal(adv0.events.length, 2);
  assert.equal(adv1.has_jump, true);
  assert.equal(adv1.has_drop, false);

  // HTML renders concrete dates, before/after counts, signed deltas (+32, -5, +14), and zero em-dashes
  const html = renderReport(anomScored, anomBatch);
  assert.match(html, /Keepa 评论变动提示/);
  assert.match(html, /2026-11-10→2026-11-12/);
  assert.match(html, /\+32/);
  assert.match(html, /3 → 35|3→35/);
  assert.match(html, /2026-11-18→2026-11-19/);
  assert.match(html, /-5/);
  assert.match(html, /35 → 30|35→30/);
  assert.match(html, /2026-11-05→2026-11-07/);
  assert.match(html, /\+14/);
  assert.match(html, /6 → 20|6→20/);
  assert.doesNotMatch(html, /—/);

  // Old (>90d) and excluded (old_reviews_predate_launch) members MUST NOT enter review_anomaly_advisories (Astra P2 #3)
  const gatedCand = structuredClone(cleanCand);
  gatedCand.newcomer_cohort.members.push(
    {
      ...structuredClone(gatedCand.newcomer_cohort.members[0]),
      family_id: 'fam-old-681d',
      asin: 'B0SYNOLD681',
      launch_date: '2025-01-01',
      keepa_review_drop_detected: true,
    },
    {
      ...structuredClone(gatedCand.newcomer_cohort.members[0]),
      family_id: 'fam-predate-excl',
      asin: 'B0SYNEXCL43',
      old_reviews_predate_launch: true,
      keepa_review_jump_detected: true,
    },
  );
  const gatedBatch = { schema_version: 1, profile_revision: 59, candidates: [gatedCand] };
  const gatedScored = scoreBatch(gatedBatch, profile);
  assert.equal(
    gatedScored.candidates[0].diagnostics.newcomers.members.find(m => m.asin === 'B0SYNOLD681')?.age_days,
    681,
  );
  assert.equal(gatedScored.candidates[0].diagnostics.newcomers.review_anomaly_advisories, undefined);
  const gatedHtml = renderReport(gatedScored, gatedBatch);
  assert.doesNotMatch(gatedHtml, /Keepa 评论变动提示/);
  assert.doesNotMatch(gatedHtml, /90天内新品 B0SYNOLD681/);
  assert.doesNotMatch(gatedHtml, /90天内新品 B0SYNEXCL43/);

  // Unified scrubbing on BOTH free-text note AND structured events: D:\ path, email parent_asin, and em-dash (Astra P1 #6)
  const scrubCand = structuredClone(cleanCand);
  scrubCand.newcomer_cohort.members[0].keepa_review_drop_detected = true;
  scrubCand.newcomer_cohort.members[0].keepa_review_anomaly_note =
    'Keepa 骤降见 D:\\fieldwork\\private-folder\\receipt.json — contact ops@example.com';
  scrubCand.newcomer_cohort.members[1].keepa_review_jump_detected = true;
  scrubCand.newcomer_cohort.members[1].keepa_review_anomaly_summary = {
    asin: scrubCand.newcomer_cohort.members[1].asin,
    parent_asin: 'sample@example.invalid',
    has_jump: true,
  };
  scrubCand.newcomer_cohort.members[1].keepa_review_anomaly_events = [
    {
      direction: 'jump',
      delta: 19,
      from_count: 1,
      to_count: 20,
      date_from: '2026-11-01 — D:\\secret\\log.txt',
      date_to: '2026-11-03',
      asin: scrubCand.newcomer_cohort.members[1].asin,
    },
  ];
  const scrubBatch = { schema_version: 1, profile_revision: 59, candidates: [scrubCand] };
  const scrubScored = scoreBatch(scrubBatch, profile);
  assert.equal(scrubScored.candidates[0].diagnostics.newcomers.review_anomaly_advisories.length, 2);
  assert.deepEqual(scrubScored.candidates[0].total_range, cClean.total_range);
  const scrubHtml = renderReport(scrubScored, scrubBatch);
  assert.match(scrubHtml, /Keepa 评论变动提示/);
  assert.doesNotMatch(scrubHtml, /fieldwork|receipt\.json|ops@example\.com|sample@example\.invalid|secret\\log\.txt/i);
  assert.doesNotMatch(scrubHtml, /—/, 'scrubbed Keepa advisories must emit zero em-dashes');
});

test('R3 closure (report PII & amber median): top-10 median 500 amber badge and registrant/reviewer/E.164 phone redaction in shareable HTML', async () => {
  const cand500 = structuredClone(fixture.candidates[0]);
  cand500.market = { ...(cand500.market ?? {}), top10_median_reviews: 500, top10_review_sample_count: 4 };
  const b500 = { ...structuredClone(fixture), profile_revision: 59, candidates: [cand500] };
  const html500 = renderReport(scoreBatch(b500, profile), b500);
  assert.match(html500, /500 条（黄 · 中等门槛 · 样本 4\/10 款）/);

  await withTempDirAsync('r59-r3-report-pii-', async dir => {
    const pktInherit = {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-inherit-01',
      execution_policy_ref: 'local-policy-only',
      candidate: { subject_id: fixture.candidates[0].id, intended_use: 'Store tools', saleable_spec: { pcs: 2, material: 'steel' }, unknown_fields: [] },
      subjects: [{ subject_id: 'box', spec: { pcs: 2 } }],
      criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'fit', description: 'Fit', required: true }] },
      questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['box'], criterion_ids: ['fit'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['box'], summary: 'Catalog control.', kind: 'fact', source_ref: 'r1', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
    };
    const frozenInh = freezeEvidenceReviewPacket(pktInherit);
    const recDirInh = join(dir, 'inh-receipts');
    const g4Out = await runOptionalGate4EvidenceReview(pktInherit, {
      enabled: true,
      testMode: true,
      receiptDir: recDirInh,
      candidateId: fixture.candidates[0].id,
      candidateQualification: { counts_toward_target: true },
      mockExecutor: async ({ outputFilePath }) => {
        writeFileSync(outputFilePath, JSON.stringify({
          schema_version: frozenInh.schema_version,
          review_id: frozenInh.review_id,
          packet_sha256: frozenInh.packet_sha256,
          subjects: [{ subject_id: 'box', disposition: 'included', criterion_ids: ['fit'], evidence_ids: ['e1'], reason: 'Registrant Name: Lumen Quillfield; REGISTRANT Zinnia Testwood; Registrant Mossvale, Elowen.' }],
          answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'Ship via 84 FIXTURE-GLEN RD; phone 202.555.0148.' }],
          contradictions: [],
          gaps: [],
          conclusion: 'Verified https://example.org/catalog/facts.',
        }), 'utf8');
        return { exitCode: 0 };
      },
    });
    const candShare = structuredClone(fixture.candidates[0]);
    attachCandidateEvidenceReview(candShare, g4Out, pktInherit, { receiptStoreDir: recDirInh, allowTestDoubleReceipt: true });
    candShare.review_notes = [{ kind: 'CALIBRATION_NOTE', note: 'Contact: Taylor Carter; phone 415.555.0123.' }];
    const shareBatch = { ...structuredClone(fixture), profile_revision: 59, candidates: [candShare] };
    const shareHtml = renderReport(scoreBatch(shareBatch, profile), shareBatch, { receiptStoreDir: recDirInh, allowTestDoubleReceipts: true });
    assert.match(shareHtml, /已复核/);
    assert.equal(shareHtml.includes('https://example.org/catalog/facts'), true);
    for (const leaked of ['Lumen Quillfield', 'Zinnia Testwood', 'Elowen', '84 FIXTURE-GLEN RD', '202.555.0148', 'Taylor Carter', '415.555.0123']) {
      assert.equal(shareHtml.includes(leaked), false, `Shareable HTML must redact "${leaked}"`);
    }

    const candPii2 = structuredClone(fixture.candidates[0]);
    candPii2.review_notes = [{ kind: 'CALIBRATION_NOTE', reviewer: 'Ember Examplewood', observed_at: '2026-11-24', note: 'Phone: +12025550147.' }];
    const bPii2 = { ...structuredClone(fixture), profile_revision: 59, candidates: [candPii2] };
    const htmlPii2 = renderReport(scoreBatch(bPii2, profile), bPii2);
    assert.equal(htmlPii2.includes('+12025550147'), false);
    assert.equal(htmlPii2.includes('Ember Examplewood'), false);

    candPii2.review_notes = [{ kind: 'CALIBRATION_NOTE', reviewer: 'Claude Examplewood', observed_at: '2026-11-24', note: 'Checked.' }];
    const htmlClaude = renderReport(scoreBatch(bPii2, profile), bPii2);
    assert.equal(htmlClaude.includes('Claude Examplewood'), false);
  });
});

test('Report Q31 Vine/VP/直评 & compliance fee note, and shareable HTML PII scrubbing (paths, phones, street addresses, inverted names)', async () => {
  const q31VineCand = structuredClone(fixture.candidates[0]);
  q31VineCand.one_time_compliance_fee_usd = 350;
  Object.assign(q31VineCand.newcomer_cohort.members[0], {
    vine_reviews: 12,
    vp_reviews: 5,
    non_vp_direct_reviews: 1,
  });
  const vineBatch = { schema_version: 1, profile_revision: 59, candidates: [q31VineCand] };
  const vineHtml = renderReport(scoreBatch(vineBatch, profile), vineBatch);
  assert.match(vineHtml, /Vine\s*12/);
  assert.match(vineHtml, /VP\s*5/);
  assert.match(vineHtml, /直评\s*1/);
  assert.match(vineHtml, /一次性实验室／合规检测费提醒/);
  assert.match(vineHtml, /不摊入单件毛利/);

  await withTempDirAsync('report-h16-pii-', async dir => {
    const piiRevDir = join(dir, 'pii-ev-receipts');
    mkdirSync(piiRevDir, { recursive: true });
    const dynPhone = ['138', '1234', '5678'].join('');
    const dynWinPath = ['C:', 'Users', 'synth_op', 'secret_quote.png'].join('\\');
    const h16Packet = freezeEvidenceReviewPacket({
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-h16-redact',
      candidate: { subject_id: 'synthetic-complete', intended_use: 'Hold items', saleable_spec: { pcs: 1 }, unknown_fields: [] },
      subjects: [{ subject_id: 'sub-1', spec: { pcs: 1 } }],
      criteria: { criteria_version: 'v1', rules: [{ criterion_id: 'c1', description: 'Match', required: true }] },
      questions: [{ question_id: 'q1', question: 'Match?', subject_ids: ['sub-1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['sub-1'], summary: 'Clean', kind: 'fact', source_ref: 'https://sellercentral.amazon.com/gp/help/G2027', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
    });
    const h16Env = await runCodexEvidenceReview(
      { ...h16Packet, execution_policy_ref: 'local-policy-only' },
      {
        enabled: true,
        testMode: true,
        candidateId: 'synthetic-complete',
        receiptStoreDir: piiRevDir,
        mockExecutor: async ({ outputFilePath }) => {
          writeFileSync(outputFilePath, JSON.stringify({
            schema_version: 'evidence-review-draft-v1',
            review_id: h16Packet.review_id,
            packet_sha256: h16Packet.packet_sha256,
            subjects: [{ subject_id: 'sub-1', disposition: 'included', criterion_ids: ['c1'], evidence_ids: ['https://sellercentral.amazon.com/gp/help/G2027'], reason: `Verified at ${dynWinPath}` }],
            answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'Confirmed.' }],
            contradictions: [],
            gaps: [],
            conclusion: `Factory Tel: ${dynPhone}; official fee ref https://sellercentral.amazon.com/gp/help/G2027.`,
          }), 'utf8');
          return { exitCode: 0 };
        },
      },
    );
    assert.equal(h16Env.status, 'ready', h16Env.reason ?? '');
    const h16Batch = { ...structuredClone(fixture), profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
    attachCandidateEvidenceReview(h16Batch.candidates[0], h16Env, h16Packet, { receiptStoreDir: piiRevDir, allowTestDoubleReceipt: true });
    const h16Html = renderReport(scoreBatch(h16Batch, profile), h16Batch, { receiptStoreDir: piiRevDir, allowTestDoubleReceipts: true });
    assert.equal(h16Html.includes(dynPhone), false);
    assert.equal(h16Html.includes(dynWinPath), false);
    assert.match(h16Html, /https:\/\/sellercentral\.amazon\.com\/gp\/help\/G2027/);

    const h16Pkt2 = freezeEvidenceReviewPacket({
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-r2-h16',
      candidate: { subject_id: 'synthetic-complete', intended_use: 'Storage', saleable_spec: { pcs: 1 }, unknown_fields: [] },
      subjects: [{ subject_id: 'sub-1', spec: { pcs: 1 } }],
      criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'c1', description: 'Fit', required: true }] },
      questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['sub-1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['sub-1'], summary: 'Valid.', kind: 'fact', source_ref: 's1', observed_at: '2026-11-24', window: '2026-10-25..2026-11-24', grain: 'asin', units: 'count', limitations: null }],
    });
    const r2RevDir = join(dir, 'r2-rev-receipts');
    const usPhone = ['415', '555', '0199'].join('-');
    const usStreet = ['1234', 'Maple', 'Street,', 'Suite', '200'].join(' ');
    const fullRecip = ['Jane', 'Roe'].join(' ');
    const h16Env2 = await runCodexEvidenceReview(h16Pkt2, {
      enabled: true, testMode: true, candidateId: 'synthetic-complete', receiptStoreDir: r2RevDir,
      mockExecutor: async ({ outputFilePath }) => {
        writeFileSync(outputFilePath, JSON.stringify({
          schema_version: 'evidence-review-draft-v1',
          review_id: h16Pkt2.review_id,
          packet_sha256: h16Pkt2.packet_sha256,
          subjects: [{ subject_id: 'sub-1', disposition: 'included', criterion_ids: ['c1'], evidence_ids: ['e1'], reason: `Recipient: ${fullRecip}; Address: ${usStreet}` }],
          answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'Verified.' }],
          contradictions: [], gaps: [],
          conclusion: `Call ${usPhone}; see https://sellercentral.amazon.com/gp/help/G2027.`,
        }), 'utf8');
        return { exitCode: 0 };
      },
    });
    const r2HtmlBatch = { ...structuredClone(fixture), profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
    r2HtmlBatch.candidates[0].market.top10_median_reviews = 85;
    r2HtmlBatch.candidates[0].market.category_avg_reviews = 340;
    attachCandidateEvidenceReview(r2HtmlBatch.candidates[0], h16Env2, h16Pkt2, { receiptStoreDir: r2RevDir, allowTestDoubleReceipt: true });
    const r2Html = renderReport(scoreBatch(r2HtmlBatch, profile), r2HtmlBatch, { receiptStoreDir: r2RevDir, allowTestDoubleReceipts: true });
    assert.equal(r2Html.includes('Roe'), false);
    assert.equal(r2Html.includes(usPhone), false);
    assert.equal(r2Html.includes('Maple Street'), false);
    assert.match(r2Html, /Top-10 评论中位数/);
    assert.match(r2Html, /类目平均评论数（参考）/);

    const r3Pkt = freezeEvidenceReviewPacket({
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-r3-h16',
      candidate: { subject_id: 'synthetic-complete', intended_use: 'Storage', saleable_spec: { pcs: 1 }, unknown_fields: [] },
      subjects: [{ subject_id: 'sub-1', spec: { pcs: 1 } }],
      criteria: { criteria_version: '1.0', rules: [{ criterion_id: 'c1', description: 'Fit', required: true }] },
      questions: [{ question_id: 'q1', question: 'Fit?', subject_ids: ['sub-1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'e1', subject_ids: ['sub-1'], summary: 'Valid.', kind: 'fact', source_ref: 's1', observed_at: '2026-11-24', window: '2026-10-25..2026-11-24', grain: 'asin', units: 'count', limitations: null }],
    });
    const r3RevDir = join(dir, 'r3-rev-receipts');
    const dotPhone = ['415', '555', '0199'].join('.');
    const invName = ['Roe,', 'Jane'].join(' ');
    const upperSt = ['1234', 'MAPLE', 'ST'].join(' ');
    const r3Env = await runCodexEvidenceReview(r3Pkt, {
      enabled: true, testMode: true, candidateId: 'synthetic-complete', receiptStoreDir: r3RevDir,
      mockExecutor: async ({ outputFilePath }) => {
        writeFileSync(outputFilePath, JSON.stringify({
          schema_version: 'evidence-review-draft-v1',
          review_id: r3Pkt.review_id,
          packet_sha256: r3Pkt.packet_sha256,
          subjects: [{ subject_id: 'sub-1', disposition: 'included', criterion_ids: ['c1'], evidence_ids: ['e1'], reason: `Contact: ${invName} at ${upperSt}` }],
          answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['e1'], explanation: 'Verified.' }],
          contradictions: [], gaps: [],
          conclusion: `Tel ${dotPhone}`,
        }), 'utf8');
        return { exitCode: 0 };
      },
    });
    const r3HtmlBatch = { ...structuredClone(fixture), profile_revision: 59, candidates: [structuredClone(fixture.candidates[0])] };
    attachCandidateEvidenceReview(r3HtmlBatch.candidates[0], r3Env, r3Pkt, { receiptStoreDir: r3RevDir, allowTestDoubleReceipt: true });
    const r3Html = renderReport(scoreBatch(r3HtmlBatch, profile), r3HtmlBatch, { receiptStoreDir: r3RevDir, allowTestDoubleReceipts: true });
    assert.equal(r3Html.includes('Roe, Jane'), false);
    assert.equal(r3Html.includes(dotPhone), false);
    assert.equal(r3Html.includes('1234 MAPLE ST'), false);
  });
});

