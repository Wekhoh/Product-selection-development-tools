import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreBatch } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { runCli } from '../src/cli.mjs';
import { calculateEconomics } from '../src/economics.mjs';

const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.draft.json', import.meta.url), 'utf8'));
profile.revision = 52;
profile.workflow.scoring_and_ordering.revision = 52;
const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));

function seasonalBatch() {
  const batch = structuredClone(fixture);
  batch.profile_revision = 52;
  batch.candidates = [batch.candidates[0]];
  const candidate = batch.candidates[0];
  const scenario = structuredClone(candidate.economics.scenarios[0]);
  const economicScenario = (id, margin, contribution) => ({ ...structuredClone(scenario), id,
    margin: { ...scenario.margin, value: margin }, contribution_usd: { ...scenario.contribution_usd, value: contribution } });
  candidate.economics = { saleable_unit: candidate.economics.saleable_unit, operating_periods: [
    { id: 'off_peak', label: '淡季（1–9月）', months: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      scenarios: [economicScenario('off-peak-complete-cost', 0.35, 14)] },
    { id: 'peak', label: '旺季（10–12月）', months: [10, 11, 12],
      scenarios: [economicScenario('peak-complete-cost', 0.2, 8)] },
  ] };
  return batch;
}

test('one form retains an eligible off-peak plan and an excluded peak plan without a combined score or ranking', () => {
  const batch = seasonalBatch();
  const result = scoreBatch(batch, profile);
  assert.equal(result.candidates.length, 1);
  const form = result.candidates[0];
  assert.equal(form.queue, 'seasonal_review');
  assert.equal(form.total, null);
  assert.equal(form.total_range, null);
  assert.equal(form.covered_weight, null);
  assert.deepEqual(form.operating_periods.map(period => period.id), ['off_peak', 'peak']);
  assert.deepEqual(form.operating_periods.map(period => period.queue), ['comparable', 'excluded']);
  assert.deepEqual(form.operating_periods.map(period => period.diagnostics.economics.margin_range), [[0.35, 0.35], [0.2, 0.2]]);
  assert.ok(form.operating_periods.every(period => period.items.length === 21));
  assert.deepEqual(result.order.seasonal_review, [batch.candidates[0].id]);
  assert.equal(result.comparable_leader, null);
  assert.equal(result.summary.candidates, 1);
  assert.equal(result.summary.complete, 0);
  assert.equal(result.summary.partial, 0);
  assert.equal(result.summary.seasonal_review, 1);
  assert.equal(result.summary.seasonal_eligible, 1);
  assert.equal(result.summary.excluded, 0);
});

test('the report shows one pictured form with both period summaries and independently expandable costs, scores and evidence', () => {
  const batch = seasonalBatch();
  const presentation = batch.candidates[0].presentation;
  presentation.image_data_uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFz8AAAAASUVORK5CYII=';
  presentation.facts = [{ label: '统一规格', value: '合成完整套装' }];
  presentation.operating_periods = [
    { id: 'off_peak', summary: '淡季完整费用通过', facts: [{ label: '平均库存', value: 45, unit: '天' }],
      costs: [{ label: '淡季仓储', value: 0.2, unit: 'USD/售出件' }, { label: '供应商至货代运费', value: null, note: '主人允许延后核实' }] },
    { id: 'peak', summary: '旺季费用低于毛利条件 <proof>', costs: [{ label: '旺季仓储', value: 2.8, unit: 'USD/售出件' }] },
  ];
  const html = renderReport(scoreBatch(batch, profile), batch);
  assert.equal((html.match(/<article\b/g) ?? []).length, 1);
  assert.equal((html.match(/<img\b/g) ?? []).length, 1);
  assert.match(html, /data-queue="seasonal_review"/);
  assert.match(html, /分季评估/);
  assert.match(html, /至少一季初评通过 1 个款式/);
  assert.match(html, /淡季（1–9月）/);
  assert.match(html, /旺季（10–12月）/);
  assert.match(html, /data-operating-period="off_peak" data-queue="comparable"/);
  assert.match(html, /data-operating-period="peak" data-queue="excluded"/);
  assert.match(html, /本经营时段不满足筛选条件/);
  assert.match(html, /淡季仓储/);
  assert.match(html, /旺季仓储/);
  assert.match(html, /供应商至货代运费<\/dt><dd>未知/);
  assert.match(html, /旺季费用低于毛利条件 &lt;proof&gt;/);
  assert.match(html, /合成完整套装/);
  assert.equal((html.match(/class="card-details period-details"/g) ?? []).length, 2);
  assert.equal((html.match(/data-item-id=/g) ?? []).length, 42);
  assert.doesNotMatch(html, /当前规格已排除，不列完整总分|完整总分待补证/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, href] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(href), href);
});

test('seasonal reports retain shared blockers and next steps once before the independent period panels', () => {
  const batch = seasonalBatch();
  batch.candidates[0].presentation.blockers = [null, {},
    { problem: '共同规格仍需确认 <check>', next_step: '核对供应范围与包装 <next>' },
    { problem: '共同供货限制仍需核实', next_step: 3 },
  ];
  const html = renderReport(scoreBatch(batch, profile), batch);
  assert.equal((html.match(/共同规格仍需确认 &lt;check&gt;/g) ?? []).length, 1);
  assert.equal((html.match(/核对供应范围与包装 &lt;next&gt;/g) ?? []).length, 1);
  assert.equal((html.match(/共同供货限制仍需核实/g) ?? []).length, 1);
  assert.ok(html.indexOf('共同规格仍需确认') < html.indexOf('data-operating-period="off_peak"'));
  assert.ok(!html.includes('<check>'));
  assert.ok(!html.includes('下一步：3'));
});

test('malformed operating plans are rejected clearly instead of becoming an ordinary pending form', () => {
  const invalidPlans = [
    candidate => { candidate.economics.operating_periods = null; },
    candidate => { candidate.economics.operating_periods = []; },
    candidate => { candidate.economics.operating_periods[0] = null; },
    candidate => { candidate.economics.operating_periods[1].id = 'off_peak'; },
    candidate => { candidate.economics.operating_periods[0].id = ''; },
    candidate => { candidate.economics.operating_periods[0].label = ''; },
    candidate => { candidate.economics.operating_periods[0].months = []; },
    candidate => { candidate.economics.operating_periods[0].months = [0, 1]; },
    candidate => { candidate.economics.operating_periods[0].months = [1.5]; },
    candidate => { candidate.economics.operating_periods[0].months = ['1']; },
    candidate => { candidate.economics.operating_periods[0].months = [1, 1]; },
    candidate => { candidate.economics.operating_periods[1].months = [9, 10, 11, 12]; },
    candidate => { candidate.economics.operating_periods[0].scenarios = []; },
    candidate => { candidate.economics.operating_periods[0].scenarios = [null]; },
    candidate => { candidate.economics.operating_periods[0].scenarios[0].saleable_unit = 'another form'; },
    candidate => { candidate.economics.scenarios = [structuredClone(candidate.economics.operating_periods[0].scenarios[0])]; },
    candidate => { candidate.economics.scenarios = null; },
  ];
  for (const change of invalidPlans) {
    const batch = seasonalBatch();
    change(batch.candidates[0]);
    assert.throws(() => scoreBatch(batch, profile), error => error instanceof TypeError && /operating.period|Operating.period/.test(error.message));
  }
});

test('revision 53 keeps every revision-52 score and newcomer tie rule while adding period presentation', () => {
  const batch = seasonalBatch();
  const previous = scoreBatch(batch, profile).candidates[0];
  const currentProfile = structuredClone(profile);
  currentProfile.revision = 53;
  currentProfile.workflow.scoring_and_ordering.revision = 53;
  batch.profile_revision = 53;
  const result = scoreBatch(batch, currentProfile);
  assert.deepEqual(result.candidates[0].operating_periods.map(period => period.items), previous.operating_periods.map(period => period.items));
  assert.equal(result.candidates[0].operating_periods[0].diagnostics.newcomers.selection_tie_policy, 'complete_score_before_unresolved_equal_bound');
  const html = renderReport(result, batch);
  assert.ok(html.includes('独立类目参照'));
  assert.ok(html.includes('规则版本：修订 53'));
  assert.ok(!html.includes('评分数量中位数'));
});

test('uncertainty crossing the floor within one period and a missing margin in another stay unknown independently', () => {
  const batch = seasonalBatch();
  const [offPeak, peak] = batch.candidates[0].economics.operating_periods;
  const lower = structuredClone(offPeak.scenarios[0]);
  lower.id = 'off-peak-lower-price';
  lower.margin.value = 0.29;
  lower.contribution_usd.value = 11.6;
  offPeak.scenarios.push(lower);
  peak.scenarios[0].margin.value = null;
  const result = scoreBatch(batch, profile);
  const periods = result.candidates[0].operating_periods;
  assert.deepEqual(periods.map(period => period.queue), ['pending', 'pending']);
  assert.deepEqual(periods[0].diagnostics.economics.margin_range, [0.29, 0.35]);
  assert.equal(periods[1].diagnostics.economics.margin_range, null);
  assert.equal(periods[1].items[0].score, null);
  assert.equal(result.summary.seasonal_eligible, 0);
  const html = renderReport(result, batch);
  assert.ok(html.includes('毛利区间跨过30%'));
  assert.ok(html.includes('退款调整后广告前毛利率 未知'));
  assert.ok(html.includes('至少一季初评通过 0 个款式'));
  assert.ok(html.includes('仅计入至少有一个时段达到完整可比的款式'));
});

test('a missing storage cost from the economics helper leaves only that period pending in either input order', () => {
  const initial = seasonalBatch();
  const template = initial.candidates[0].economics.operating_periods[0].scenarios[0];
  const ledgerInput = {
    id: 'off-peak-ledger', saleable_unit: template.saleable_unit, price_usd: 50, refund_fraction: 0.04,
    assumptions: ['Synthetic same-unit full-cost ledger; missing applicable costs remain unknown.'],
    lines: [
      ['procurement', 12.5], ['domestic_freight', 0], ['headhaul', 3], ['referral', 7.2],
      ['fulfillment', 5], ['placement', 1], ['storage', 0.5], ['returns_processing', 0.3],
      ['returns_disposal', 0], ['collection', 0.5], ['other_applicable', 0], ['recovery_credit', 0],
    ].map(([id, amount_usd]) => ({ id, amount_usd, status: 'estimated', basis: 'Synthetic supported full-cost fixture.' })),
  };
  const offPeak = calculateEconomics(ledgerInput);
  const peakInput = structuredClone(ledgerInput);
  peakInput.id = 'peak-ledger-storage-pending';
  Object.assign(peakInput.lines.find(line => line.id === 'storage'), { amount_usd: null, status: 'pending' });
  const peak = calculateEconomics(peakInput);
  assert.equal(offPeak.margin, 0.375);
  assert.equal(peak.scoring_supported, false);
  assert.equal(peak.margin, null);
  assert.deepEqual(peak.pending_lines, ['storage']);
  const scenario = ledger => ({ ...structuredClone(template), id: ledger.id, assumptions: ledger.assumptions,
    coherent: ledger.scoring_supported, margin: { ...template.margin, value: ledger.margin },
    contribution_usd: { ...template.contribution_usd, value: ledger.contribution_usd } });
  const ordinary = structuredClone(initial);
  ordinary.candidates[0].economics = { saleable_unit: template.saleable_unit, scenarios: [scenario(peak)] };
  assert.equal(scoreBatch(ordinary, profile).candidates[0].queue, 'pending');
  for (const reverse of [false, true]) {
    const batch = structuredClone(initial);
    const periods = batch.candidates[0].economics.operating_periods;
    periods[0].scenarios = [scenario(offPeak)];
    periods[1].scenarios = [scenario(peak)];
    if (reverse) periods.reverse();
    batch.candidates[0].presentation.operating_periods = [
      { id: 'off_peak', costs: [{ label: '淡季仓储', value: 0.5, unit: 'USD/售出件' }] },
      { id: 'peak', costs: [{ label: '旺季仓储', value: null, unit: 'USD/售出件', note: '适用费用待补证' }] },
    ];
    const result = scoreBatch(batch, profile);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.summary.candidates, 1);
    assert.equal(result.summary.complete, 0);
    assert.equal(result.summary.seasonal_review, 1);
    assert.equal(result.summary.seasonal_eligible, 1);
    const evaluated = result.candidates[0].operating_periods;
    assert.deepEqual(evaluated.map(period => period.id), periods.map(period => period.id));
    assert.equal(evaluated.find(period => period.id === 'off_peak').queue, 'comparable');
    const pending = evaluated.find(period => period.id === 'peak');
    assert.equal(pending.queue, 'pending');
    assert.equal(pending.total, null);
    assert.equal(pending.diagnostics.economics.margin_range, null);
    assert.ok(evaluated.every(period => period.items.length === 21));
    const html = renderReport(result, batch);
    assert.equal((html.match(/<article\b/g) ?? []).length, 1);
    assert.equal((html.match(/data-item-id=/g) ?? []).length, 42);
    assert.ok(html.includes('data-operating-period="peak" data-queue="pending"'));
    assert.ok(html.includes('旺季仓储</dt><dd>未知 USD/售出件'));
  }
});

test('seasonal forms retain input order and common evidence without entering annual ranking or duplicating card counts', () => {
  const batch = seasonalBatch();
  const laterHigher = structuredClone(batch.candidates[0]);
  laterHigher.id = 'synthetic-later-higher';
  laterHigher.economics.operating_periods[0].scenarios[0].margin.value = 0.5;
  laterHigher.economics.operating_periods[0].scenarios[0].contribution_usd.value = 20;
  const ordinary = structuredClone(fixture.candidates[0]);
  ordinary.id = 'synthetic-ordinary';
  batch.candidates.push(laterHigher, ordinary);
  const result = scoreBatch(batch, profile);
  assert.deepEqual(result.order.seasonal_review, [batch.candidates[0].id, laterHigher.id]);
  assert.deepEqual(result.order.comparable, [ordinary.id]);
  assert.equal(result.comparable_leader.candidate_id, ordinary.id);
  assert.equal(result.summary.candidates, 3);
  assert.equal(result.summary.complete, 1);
  assert.equal(result.summary.all_items_supported, 1);
  assert.equal(result.summary.seasonal_review, 2);
  assert.equal(result.summary.seasonal_eligible, 2);
  const ordinaryResult = result.candidates.find(candidate => candidate.candidate_id === ordinary.id);
  for (const form of result.candidates.filter(candidate => candidate.queue === 'seasonal_review')) {
    assert.equal(Object.hasOwn(form, 'may_exceed_comparable_leader'), false);
    for (const period of form.operating_periods) {
      assert.deepEqual(period.evidence, ordinaryResult.evidence);
      assert.deepEqual(period.items.filter(item => item.group !== 'profit'), ordinaryResult.items.filter(item => item.group !== 'profit'));
    }
  }
});

test('common rights exclusions and missing non-economic evidence still apply to every operating period', () => {
  const batch = seasonalBatch();
  batch.candidates[0].judgments.specific_design_rights.anchor = 0;
  batch.candidates[0].metrics.purchase_demand_scale.value = null;
  const result = scoreBatch(batch, profile);
  assert.equal(result.candidates[0].queue, 'seasonal_review');
  assert.equal(result.summary.seasonal_eligible, 0);
  for (const period of result.candidates[0].operating_periods) {
    assert.equal(period.queue, 'excluded');
    assert.equal(period.items.find(item => item.id === 'specific_design_rights').score, 0);
    assert.equal(period.items.find(item => item.id === 'purchase_demand_scale').score, null);
    assert.equal(period.total, null);
  }
});

test('the actual offline CLI publishes one seasonal form and its independent plans in the result, report and receipt', async () => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'selection-seasonal-'));
  const batch = seasonalBatch();
  const input = join(directory, 'batch.json');
  const profilePath = join(directory, 'profile.r52.json');
  const discoveryPath = fileURLToPath(new URL('../fixtures/synthetic-discovery.json', import.meta.url));
  const output = join(directory, 'output');
  const messages = [];
  const streams = { stdout: { write: text => messages.push(text) }, stderr: { write: text => messages.push(text) } };
  try {
    await Promise.all([writeFile(input, JSON.stringify(batch)), writeFile(profilePath, JSON.stringify(profile))]);
    const status = await runCli(['--input', input, '--profile', profilePath, '--discovery', discoveryPath, '--output', output], streams);
    assert.equal(status, 0, messages.join(''));
    assert.ok(messages.join('').includes('已生成离线试评：1个候选，完整可比0个，待补证0个，分季评估1个款式，至少一季完整可比1个款式。'));
    const [result, receipt, html] = await Promise.all([
      readFile(join(output, 'result.json'), 'utf8').then(JSON.parse),
      readFile(join(output, 'receipt.json'), 'utf8').then(JSON.parse),
      readFile(join(output, 'index.html'), 'utf8'),
    ]);
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.summary.candidates, 1);
    assert.equal(receipt.summary.complete, 0);
    assert.equal(receipt.summary.seasonal_eligible, 1);
    assert.equal(receipt.provider_requests, 0);
    assert.equal(receipt.network_requests, 0);
    assert.equal(result.discovery.summary.bound_candidates, 1);
    assert.ok(receipt.inputs.discovery.sha256);
    assert.deepEqual(result.candidates[0].operating_periods.map(period => period.queue), ['comparable', 'excluded']);
    assert.equal((html.match(/<article\b/g) ?? []).length, 1);
    assert.equal((html.match(/data-item-id=/g) ?? []).length, 42);
    assert.equal((html.match(/如何发现这款/g) ?? []).length, 1);
    const ordinary = structuredClone(fixture);
    ordinary.profile_revision = 52;
    const ordinaryInput = join(directory, 'ordinary-batch.json');
    const ordinaryOutput = join(directory, 'ordinary-output');
    await writeFile(ordinaryInput, JSON.stringify(ordinary));
    messages.length = 0;
    assert.equal(await runCli(['--input', ordinaryInput, '--profile', profilePath, '--output', ordinaryOutput], streams), 0, messages.join(''));
    assert.equal(messages.join(''), `已生成离线试评：3个候选，完整可比2个，待补证1个。\n结果目录：${ordinaryOutput}\n`);
  } finally {
    const resolved = await realpath(directory);
    assert.equal(dirname(resolved), parent);
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    await rm(resolved, { recursive: true });
  }
});
