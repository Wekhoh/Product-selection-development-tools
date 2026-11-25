import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  scoreCandidate,
  scoreBatch,
  UNPUBLISHED_2027_Q4_PEAK_METADATA_NOTE,
} from '../src/scoring.mjs';
import {
  buildPairedSeasonalOperatingPeriods,
  buildEvergreen2027OffPeakEconomics,
  ingestTrialSpecification,
} from '../src/raw-ingest.mjs';
import { renderReport } from '../src/report.mjs';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const r58Profile = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'design', 'reference-profile.draft.json'), 'utf8'));
const r59Profile = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'), 'utf8'));
const synthBatch = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic-batch.json'), 'utf8'));

function make2027OffPeakScenarioFromBase(baseCand, id = 'sc-evergreen-2027') {
  const pkgRef = baseCand.economics.scenarios[0].cost_ledger.fee_context.package_ref;
  const sc = structuredClone(baseCand.economics.scenarios[0]);
  sc.id = sc.cost_ledger.id = id;
  sc.cost_ledger.fee_context = {
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  for (const line of sc.cost_ledger.lines) {
    if (line.fee_basis && typeof line.fee_basis === 'object') {
      if (line.id === 'fulfillment' || line.id === 'inbound_placement') {
        line.fee_basis.effective_from = '2027-01-15';
        line.fee_basis.effective_through = '2027-10-14';
      } else if (line.id === 'storage') {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-09-30';
      } else if (line.id === 'returns_processing') {
        line.fee_basis.effective_from = '2027-02-01';
        line.fee_basis.effective_through = '2027-12-31';
      }
    }
  }
  return sc;
}

function deferAllRemaining15ForSampleCheck(cand) {
  const ev = [cand.evidence[0].id];
  cand.judgments = {
    ...cand.judgments,
    existing_solution_fit: {
      anchor: null,
      complete_set_verified: true,
      sample_check_required: true,
      reason: '待拿样核对英文说明书与激光配件编号。',
      evidence: ev,
    },
    feasible_light_differentiation: {
      anchor: null,
      sample_check_required: true,
      reason: '待拿样同工厂核对防滑脚垫微改工艺。',
      evidence: ev,
    },
    storage_tolerance: {
      anchor: null,
      sample_check_required: true,
      reason: '待拿样核对防潮封膜与叠码承重。',
      evidence: ev,
    },
    transport_tolerance: {
      anchor: null,
      sample_check_required: true,
      reason: '待拿样实测六面跌落与珍珠棉内衬。',
      evidence: ev,
    },
    routine_complexity: {
      anchor: null,
      sample_check_required: true,
      reason: '待旺旺确认备用螺丝包与常规质检比例。',
      evidence: ev,
    },
    specific_design_rights: {
      anchor: null,
      prescreen_completed: true,
      proven_conflict: false,
      sample_check_required: true,
      reason: 'USPTO 公开初筛无实锤冲突，待拿实物逐条比对卡槽结构。',
      evidence: ev,
    },
    applicable_public_requirements: {
      anchor: null,
      prescreen_completed: true,
      proven_conflict: false,
      hard_ban: false,
      sample_check_required: true,
      reason: '无强制禁售，待向工厂确认木材拉丁学名用于 Lacey Act 申报。',
      evidence: ev,
    },
  };
}

test('Step 2.1: Unified 85-pt objective core ranking puts 85/85 sample-pending card ahead of 82/85 complete 97/100 card and breaks ties by confirmed_risk_deduction_15', () => {
  // 1) "82/85 完整 97/100 卡": core = 82/85 (product_dispersion = 0/3), remaining 15 = 15/15 -> total = 97/100
  const cardComplete97 = structuredClone(synthBatch.candidates[0]);
  cardComplete97.id = 'aaa-complete-97-core82';
  cardComplete97.label = '完整97分卡（核心82/85）';
  cardComplete97.market.concentrations.product.value = 1.0; // 0/3 on product_dispersion -> 85 - 3 = 82/85

  // 2) "85/85 待拿样卡": core = 85/85, all 7 remaining-15 items deferred -> covered_weight = 85, supported = 85/85
  const cardSamplePending85 = structuredClone(synthBatch.candidates[0]);
  cardSamplePending85.id = 'zzz-sample-pending-85-core85';
  cardSamplePending85.label = '待拿样85分卡（核心85/85）';
  deferAllRemaining15ForSampleCheck(cardSamplePending85);

  // 3) Seasonal qualifying 93/100 card with core = 83/85 (supported_opportunity = 4/6) and 8/8 scored in rem15 + 7 deferred
  const cardSeasonalCore83 = structuredClone(synthBatch.candidates[0]);
  cardSeasonalCore83.id = 'mmm-seasonal-93-core83';
  cardSeasonalCore83.label = '分季93分权重卡（核心83/85）';
  cardSeasonalCore83.product_seasonality = 'seasonal';
  cardSeasonalCore83.judgments.supported_opportunity.anchor = 4; // -2 -> core = 83/85
  const evS = [cardSeasonalCore83.evidence[0].id];
  cardSeasonalCore83.judgments.existing_solution_fit = {
    anchor: null,
    complete_set_verified: true,
    sample_check_required: true,
    reason: '待拿样核对说明书与箱规。',
    evidence: evS,
  };
  cardSeasonalCore83.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: true,
    proven_conflict: false,
    sample_check_required: true,
    reason: '公开库初筛无实锤冲突，待实物核对。',
    evidence: evS,
  };
  const scOff = make2027OffPeakScenarioFromBase(cardSeasonalCore83, 'sc-seas-83');
  const paired = buildPairedSeasonalOperatingPeriods({
    saleable_unit: cardSeasonalCore83.economics.saleable_unit,
    off_peak_scenarios: [scOff],
    cubic_feet_per_unit: 0.25,
    storage_evidence: evS,
  });
  cardSeasonalCore83.economics = paired;

  // 4) Tie-breaker pair at core = 82/85:
  //    - cardTieDeduct3: complete 100/100 weight, core = 82/85, rem15 = 12/15 (confirmed_risk_deduction_15 = 3) -> total = 94/100
  //    - cardTieDeduct0Pending: 93/100 weight, core = 82/85, rem15 = 8/8 scored (confirmed_risk_deduction_15 = 0) + 7 sample-pending -> supported = 90/93
  const cardTieDeduct3 = structuredClone(cardComplete97);
  cardTieDeduct3.id = 'bbb-tie-core82-deduct3-total94';
  cardTieDeduct3.label = '同核82分·已确认扣3分（总分94/100）';
  cardTieDeduct3.judgments.existing_solution_fit.anchor = 2; // 4 - 2 = 2 deduction
  cardTieDeduct3.judgments.storage_tolerance.anchor = 1; // 2 - 1 = 1 deduction -> total 3 deduction

  const cardTieDeduct0Pending = structuredClone(cardComplete97);
  cardTieDeduct0Pending.id = 'yyy-tie-core82-deduct0-wt93';
  cardTieDeduct0Pending.label = '同核82分·零扣分含7分待拿样（已得90/93）';
  cardTieDeduct0Pending.judgments.existing_solution_fit = {
    anchor: null,
    complete_set_verified: true,
    sample_check_required: true,
    reason: '待拿样核对配件袋标识。',
    evidence: [cardTieDeduct0Pending.evidence[0].id],
  };
  cardTieDeduct0Pending.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: true,
    proven_conflict: false,
    sample_check_required: true,
    reason: '公开库无实锤冲突，待拿样确认倒角细节。',
    evidence: [cardTieDeduct0Pending.evidence[0].id],
  };

  const batch = {
    schema_version: 1,
    profile_revision: 59,
    candidates: [
      cardTieDeduct3,
      cardComplete97,
      cardSeasonalCore83,
      cardTieDeduct0Pending,
      cardSamplePending85,
    ],
  };

  const res = scoreBatch(batch, r59Profile);
  const byId = new Map(res.candidates.map(c => [c.candidate_id, c]));

  // Verify exact core & total numbers on the acceptance pair
  const s85 = byId.get('zzz-sample-pending-85-core85');
  const s97 = byId.get('aaa-complete-97-core82');
  const s83 = byId.get('mmm-seasonal-93-core83');
  const sTie0 = byId.get('yyy-tie-core82-deduct0-wt93');
  const sTie3 = byId.get('bbb-tie-core82-deduct3-total94');

  assert.deepEqual(s85.core_85_range, [85, 85]);
  assert.equal(s85.covered_weight, 85);
  assert.deepEqual(s85.supported_range, [85, 85]);
  assert.equal(s85.confirmed_risk_deduction_15, 0);
  assert.equal(s85.qualification.counts_toward_target, true);

  assert.deepEqual(s97.core_85_range, [82, 82]);
  assert.equal(s97.covered_weight, 100);
  assert.deepEqual(s97.total_range, [97, 97]);
  assert.equal(s97.confirmed_risk_deduction_15, 0);
  assert.equal(s97.qualification.counts_toward_target, true);

  assert.deepEqual(s83.core_85_range, [83, 83]);
  assert.equal(s83.confirmed_risk_deduction_15, 0);
  assert.equal(s83.qualification.counts_toward_target, true);

  assert.deepEqual(sTie0.core_85_range, [82, 82]);
  assert.equal(sTie0.confirmed_risk_deduction_15, 0);
  assert.equal(sTie0.covered_weight, 93);
  assert.deepEqual(sTie0.supported_range, [90, 90]);

  assert.deepEqual(sTie3.core_85_range, [82, 82]);
  assert.equal(sTie3.confirmed_risk_deduction_15, 3);
  assert.deepEqual(sTie3.total_range, [94, 94]);

  // Unified ranking order:
  // 1. 85/85 sample-pending card
  // 2. 83/85 seasonal 93-wt card
  // 3. 82/85 complete 97/100 card (0 risk deduction, 97 total > 90 supported)
  // 4. 82/85 93-wt card (0 risk deduction, 90 supported -> beats 3-pt deduction!)
  // 5. 82/85 complete 94/100 card (3-pt confirmed risk deduction)
  const expectedOrder = [
    'zzz-sample-pending-85-core85',
    'mmm-seasonal-93-core83',
    'aaa-complete-97-core82',
    'yyy-tie-core82-deduct0-wt93',
    'bbb-tie-core82-deduct3-total94',
  ];
  assert.deepEqual(res.qualifying_order, expectedOrder);
  assert.deepEqual(res.candidates.map(c => c.candidate_id), expectedOrder);

  // Permutation invariance check
  const reversedRes = scoreBatch({ ...batch, candidates: [...batch.candidates].reverse() }, r59Profile);
  assert.deepEqual(reversedRes.candidates.map(c => c.candidate_id), expectedOrder);

  // HTML rendering check: core 85, evidenced remaining-15 items, and pending reasons all visible, 0 em-dashes
  const html = renderReport(res, batch);
  assert.ok(html.includes('85 分客观核心：85 / 85'));
  assert.ok(html.includes('85 分客观核心：82 / 85'));
  assert.ok(html.includes('已确认风险扣分 3 分'));
  assert.ok(html.includes('剩余 15 分已证项与待核原因明细'));
  assert.ok(html.includes('待拿样核对配件袋标识'));
  assert.equal(html.includes('\u2014'), false, 'HTML report must contain zero em-dashes');
});

test('Step 2.2: Evergreen products stay evergreen on 2027 off-peak window without forced seasonal_review and carry unpublished_2027_q4_peak_note metadata', () => {
  const baseEvergreen = structuredClone(synthBatch.candidates[0]);
  baseEvergreen.id = 'cand-evergreen-2027-flat';
  const scOff = make2027OffPeakScenarioFromBase(baseEvergreen, 'sc-evg-offpeak');

  // Case A: Direct flat 2027 off-peak evergreen candidate (no operating_periods)
  baseEvergreen.economics = buildEvergreen2027OffPeakEconomics({
    saleable_unit: baseEvergreen.economics.saleable_unit,
    off_peak_scenarios: [scOff],
  });
  const scoredFlat = scoreCandidate(baseEvergreen, r59Profile);
  assert.equal(scoredFlat.queue, 'comparable', JSON.stringify(scoredFlat.qualification));
  assert.notEqual(scoredFlat.queue, 'seasonal_review');
  assert.equal(scoredFlat.effective_disposition, 'full_annual_qualifying');
  assert.equal(scoredFlat.product_seasonality, 'evergreen');
  assert.equal(scoredFlat.unpublished_2027_q4_peak_note, UNPUBLISHED_2027_Q4_PEAK_METADATA_NOTE);
  assert.equal(scoredFlat.qualification.counts_toward_target, true);
  assert.equal(scoredFlat.qualification.product_seasonality, 'evergreen');
  assert.equal(scoredFlat.qualification.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');

  // Case B: Sample-pending evergreen 2027 off-peak candidate also stays flat evergreen (not seasonal_review)
  const sampleEvg = structuredClone(baseEvergreen);
  sampleEvg.id = 'cand-evergreen-2027-sample-pending';
  deferAllRemaining15ForSampleCheck(sampleEvg);
  const scoredSampleEvg = scoreCandidate(sampleEvg, r59Profile);
  assert.equal(scoredSampleEvg.queue, 'pending');
  assert.equal(scoredSampleEvg.qualification.counts_toward_target, true);
  assert.equal(scoredSampleEvg.qualification.mode, 'sample_pending_qualifying');
  assert.equal(scoredSampleEvg.effective_disposition, 'full_annual_qualifying');
  assert.equal(scoredSampleEvg.product_seasonality, 'evergreen');
  assert.equal(scoredSampleEvg.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');

  // Case C: Caller passing paired operating_periods tagged product_seasonality: 'evergreen' unwraps cleanly to flat evergreen
  const wrappedEvg = structuredClone(synthBatch.candidates[0]);
  wrappedEvg.id = 'cand-evergreen-unwrapped';
  wrappedEvg.product_seasonality = 'evergreen';
  wrappedEvg.economics = buildPairedSeasonalOperatingPeriods({
    saleable_unit: wrappedEvg.economics.saleable_unit,
    off_peak_scenarios: [make2027OffPeakScenarioFromBase(wrappedEvg, 'sc-evg-wrap')],
    cubic_feet_per_unit: 0.25,
    storage_evidence: [wrappedEvg.evidence[0].id],
  });
  const scoredUnwrapped = scoreCandidate(wrappedEvg, r59Profile);
  assert.equal(scoredUnwrapped.queue, 'comparable');
  assert.equal(scoredUnwrapped.product_seasonality, 'evergreen');
  assert.equal(scoredUnwrapped.unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');

  // Case D: Explicitly seasonal product with flat 2027 off-peak scenarios (no companion peak panel) cannot masquerade as flat full-year
  const explicitSeasonalFlat = structuredClone(baseEvergreen);
  explicitSeasonalFlat.id = 'cand-explicit-seasonal-missing-peak';
  explicitSeasonalFlat.product_seasonality = 'seasonal';
  const scoredBadSeasonal = scoreCandidate(explicitSeasonalFlat, r59Profile);
  assert.equal(scoredBadSeasonal.qualification.counts_toward_target, false);
  assert.equal(scoredBadSeasonal.queue, 'pending');

  // Case E: r58 frozen behavior unchanged (flat 2027-02-01..2027-10-14 still rejected in r58)
  const r58Check = scoreCandidate(structuredClone(baseEvergreen), r58Profile);
  assert.equal(r58Check.qualification.counts_toward_target, false);

  // Case F: ingestTrialSpecification({ evergreen_2027 }) produces flat evergreen 2027 candidate & HTML shows Q4 note
  const ingested = ingestTrialSpecification({
    profile_revision: 59,
    allow_synthetic_without_receipts: true,
    candidates: [
      {
        candidate: (() => {
          const c = structuredClone(synthBatch.candidates[0]);
          c.id = 'cand-ingested-evergreen-2027';
          delete c.economics.scenarios;
          return c;
        })(),
        evergreen_2027: {
          saleable_unit: synthBatch.candidates[0].economics.saleable_unit,
          off_peak_scenarios: [make2027OffPeakScenarioFromBase(synthBatch.candidates[0], 'sc-ing-evg')],
        },
      },
    ],
  }, r59Profile, { allowSyntheticWithoutReceipts: true });
  const batchRes = scoreBatch(ingested.batch, r59Profile);
  assert.equal(batchRes.candidates[0].queue, 'comparable');
  assert.equal(batchRes.candidates[0].product_seasonality, 'evergreen');
  assert.equal(batchRes.candidates[0].unpublished_2027_q4_peak_note, '2027 Q4 旺季费率待亚马逊公布');
  const html = renderReport(batchRes, ingested.batch);
  assert.ok(html.includes('常青品（非季节款）'));
  assert.ok(html.includes('2027 Q4 旺季费率待亚马逊公布'));
});
