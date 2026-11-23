import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  extractVerifiedAsinSetFromRawPayloads,
  extractVerifiedAsinCatalogFromRawPayloads,
  assertRawAsinProvenance,
  ingestRawCategoryAndDemandMetrics,
  extractSifThreeTierBidPlan,
  classifySpApiRestrictionReasons,
  resolveStage1QualitativeJudgments,
  buildPairedSeasonalOperatingPeriods,
  ingestTrialSpecification,
} from '../src/raw-ingest.mjs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { openSelectionStore } from '../src/store.mjs';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CLI_PATH = join(REPO_ROOT, 'src', 'phase2-cli.mjs');
const R59_PROFILE_PATH = join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json');
const FIXTURE_PATH = join(REPO_ROOT, 'fixtures', 'synthetic-batch.json');

const r59Profile = JSON.parse(readFileSync(R59_PROFILE_PATH, 'utf8'));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

test('Slice 3A: Raw ASIN provenance guard, avgReturnRatio extraction (never returnRatio), SIF 3-tier bid extractor, and SP-API brand-vs-category classifier', () => {
  const rawPayloads = [
    {
      source_id: 'raw-ss-list',
      payload: {
        structuredContent: {
          data: {
            items: [
              { asin: 'B0RAW00001', parent: 'B0PAR00001', price: 65.00, monthlySales: 140 },
              { asin: 'B0RAW00002', parent: 'B0PAR00001', price: 65.00, monthlySales: 140 },
            ],
          },
        },
      },
    },
    {
      source_id: 'raw-mcp-text',
      payload: {
        content: [{ type: 'text', text: JSON.stringify({ top_asins: ['B0RAW00003'] }) }],
      },
    },
  ];

  const asinSet = extractVerifiedAsinSetFromRawPayloads(rawPayloads);
  assert.ok(asinSet.has('B0RAW00001'));
  assert.ok(asinSet.has('B0PAR00001'));
  assert.ok(asinSet.has('B0RAW00003'));
  assert.doesNotThrow(() => assertRawAsinProvenance(['B0RAW00001', 'B0RAW00003'], rawPayloads));
  assert.throws(() => assertRawAsinProvenance(['B0RAW00001', 'B0PHANTOM9'], rawPayloads), /B0PHANTOM9/);

  // avgReturnRatio = 3.25 -> 0.0325 (must NEVER pick returnRatio = 6.50!)
  const metricsSynth = ingestRawCategoryAndDemandMetrics({
    demand365Raw: {
      structuredContent: {
        data: {
          ratioComparison: { avgReturnRatio: 3.25, returnRatio: 6.50 },
        },
      },
    },
    asinRows: [
      { asin: 'B0RAW00001', parent: 'B0PAR00001', monthlySales: 140 },
      { asin: 'B0RAW00002', parent: 'B0PAR00001', monthlySales: 140 },
    ],
  });
  assert.ok(Math.abs(metricsSynth.category_return.value - 0.0325) < 1e-8);
  assert.equal(metricsSynth.deduplicated_sales.total_parent_units, 140, 'Same parent monthlySales counted once');

  // Leaf NO_DATA falls back to parent avgReturnRatio, never 0.05 or returnRatio
  const metricsNoData = ingestRawCategoryAndDemandMetrics({
    demand365Raw: { structuredContent: { data: { ratioComparison: null } } },
    parentDemand365Raw: { structuredContent: { data: { ratioComparison: { avgReturnRatio: 4.20, returnRatio: 7.10 } } } },
    parentCategoryLabel: 'Synthetic Parent Department',
  });
  assert.equal(metricsNoData.category_return.value, 0.042);
  assert.equal(metricsNoData.category_return.fallback_used, true);

  // SIF 3-tier progressive bid extraction: moves unbid 6-word query to long_tail_opportunistic_terms and uses cpc_raise_exact when cpc_fixed_exact is null
  const bidPlan = extractSifThreeTierBidPlan({
    evidence: ['ev-bids-1'],
    volume_period: '2026-10',
    selection_reason: 'Auto-extracted 3-tier bid plan',
    queries: [
      {
        query: 'under desk wire basket',
        monthly_searches: 1200,
        sif_row: {
          supporting_signals: {
            cpc_fixed_exact: null,
            cpc_raise_exact: 0.80,
            cpc_raise_exact_low: 0.60,
            cpc_raise_exact_high: 1.00,
          },
        },
      },
      {
        query: 'modular desk cable organizer tray clamp',
        monthly_searches: 210,
        sif_row: { supporting_signals: { cpc_fixed_exact: null, cpc_raise_exact: null } },
      },
    ],
  });
  assert.equal(bidPlan.entries.length, 1);
  assert.equal(bidPlan.entries[0].query, 'under desk wire basket');
  assert.equal(bidPlan.entries[0].sif.cpc_raise_exact, 0.80);
  assert.equal(bidPlan.long_tail_opportunistic_terms.length, 1);
  assert.equal(bidPlan.long_tail_opportunistic_terms[0].query, 'modular desk cable organizer tray clamp');

  // SP-API restriction classifier separates competitor brand-gating from category gating
  const spClass = classifySpApiRestrictionReasons([
    { reasonCode: 'NOT_ELIGIBLE', message: 'You need approval to list in this brand.' },
    { reasonCode: 'APPROVAL_REQUIRED', message: 'You need approval to list this product.' },
  ], { target_is_own_white_label: true });
  assert.equal(spClass.hard_category_ban, false);
  assert.equal(spClass.has_competitor_brand_gate, true);
  assert.match(spClass.white_label_note, /竞品品牌锁/);
});

test('Slice 3B: Stage-1 vs Stage-2 qualitative judgments unlock & paired seasonal off_peak + peak builder without root expected_primary_scenarios leak', () => {
  const baseCand = structuredClone(fixture.candidates[0]);
  const evId = baseCand.evidence[0].id;

  // 1) Public evidence sufficient -> unlocks #16 (3/4), #17 (0/1 ready-stock no-mod), #20 (3/3 + oligopoly patent tag), #21 (1/2 + compliance tags)
  const unlocked = resolveStage1QualitativeJudgments({
    evidence: [evId],
    spec_verification: {
      complete_set_verified: true,
      anchor: 3,
      reason: '合成现货规格含完整组件与配件，无需开模即可覆盖目标买法。',
    },
    review_judge: null, // Pre-review-mining ready-stock needs no modification -> 0/1!
    rights_prescreen: {
      specific_design_rights: { status: 'no_public_hit_observed', summary: 'USPTO/Google Patents 初查未见同结构冲突。' },
      applicable_public_requirements: {
        status: 'needs_verification',
        frameworks_checked: ['Lacey_Act', 'CPSC'],
        summary: '涉及木质材料树种申报及常规物理安全核验路径。',
      },
    },
    market_seller_count: 2,
    reference_price_usd: 58.00,
  });
  assert.equal(unlocked.judgments.existing_solution_fit.anchor, 3);
  assert.equal(unlocked.judgments.feasible_light_differentiation.anchor, 0);
  assert.equal(unlocked.judgments.specific_design_rights.anchor, 3);
  assert.equal(unlocked.judgments.applicable_public_requirements.anchor, 1);
  assert.ok(unlocked.objective_tags.includes('寡头高利·二阶段专利预警'));
  assert.ok(unlocked.objective_tags.includes('留存后二阶段实物细节专利复核'));

  // Spec omission/contradiction keeps #16 pending!
  const specMismatch = resolveStage1QualitativeJudgments({
    evidence: [evId],
    spec_verification: {
      complete_set_verified: false,
      spec_conflict_reason: '合成测试报价仅含裸件，缺对标套装随附的收纳袋与彩盒。',
    },
    rights_prescreen: {
      specific_design_rights: { status: 'no_public_hit_observed', summary: 'No hit.' },
      applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['Lacey_Act'], summary: 'Lacey Act.' },
    },
  });
  assert.equal(specMismatch.judgments.existing_solution_fit.anchor, null);

  // 2) Paired seasonal builder: builds valid off_peak + companion peak with period-scoped expected_primary_scenarios and rejects duplicate stress IDs!
  const offScen = structuredClone(baseCand.economics.scenarios[0]);
  offScen.id = offScen.cost_ledger.id = 'sc-factory-1';
  offScen.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
  offScen.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  offScen.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-01-25' };
  for (const l of offScen.cost_ledger.lines.filter(x => x.fee_basis)) {
    l.fee_basis.effective_from = '2027-01-15';
    l.fee_basis.effective_through = l.id === 'fulfillment' ? '2027-10-14' : '2027-12-31';
  }

  const seasonalEcon = buildPairedSeasonalOperatingPeriods({
    saleable_unit: baseCand.economics.saleable_unit,
    off_peak_scenarios: [offScen],
    cubic_feet_per_unit: 0.25,
    average_inventory_days: 45,
    size_tier: 'large_standard',
    storage_evidence: offScen.cost_ledger.lines.find(l => l.id === 'storage').evidence,
  });
  assert.equal(Object.hasOwn(seasonalEcon, 'expected_primary_scenarios'), false, 'Must NEVER put root expected_primary_scenarios across periods');
  assert.equal(seasonalEcon.operating_periods.length, 2);

  const seasonalCand = structuredClone(baseCand);
  seasonalCand.id = 'cand-seasonal-ingested';
  seasonalCand.economics = seasonalEcon;
  const scoredSeasonal = scoreCandidate(seasonalCand, r59Profile);
  assert.equal(scoredSeasonal.qualification.counts_toward_target, true);
  assert.equal(scoredSeasonal.effective_disposition, 'seasonal_off_peak_qualifying');

  // Duplicate stress scenario IDs must throw TypeError
  assert.throws(() => buildPairedSeasonalOperatingPeriods({
    saleable_unit: baseCand.economics.saleable_unit,
    off_peak_scenarios: [offScen],
    cubic_feet_per_unit: 0.25,
    storage_evidence: offScen.cost_ledger.lines.find(l => l.id === 'storage').evidence,
    stress_scenarios: [
      { id: 'dup-stress-1', label: 'A', saleable_unit: baseCand.economics.saleable_unit, coherent: true, assumptions: ['a'], cost_ledger: offScen.cost_ledger },
      { id: 'dup-stress-1', label: 'B', saleable_unit: baseCand.economics.saleable_unit, coherent: true, assumptions: ['b'], cost_ledger: offScen.cost_ledger },
    ],
  }), /Duplicate stress_scenarios id/i);
});

test('Slice 3C: phase2-cli ingest-trial builds a validated r59 seasonal batch offline via subprocess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-ingest-cli-'));
  try {
    const rawFile = join(dir, 'raw-sample.json');
    const specFile = join(dir, 'trial-ingest-spec.json');
    const outBatch = join(dir, 'ingested.batch.json');

    const baseCand = structuredClone(fixture.candidates[0]);
    baseCand.screening.reference_price_usd.target_variant_asin = 'B0RAW10001';
    const targetPrice = baseCand.screening.reference_price_usd.value;
    const rawAsins = [
      'B0RAW10001',
      ...baseCand.newcomer_cohort.members.map(m => m.asin),
      ...baseCand.newcomer_cohort.market_reference.families.map(f => f.asin).filter(Boolean),
    ].filter(a => /^B0[A-Z0-9]{8}$/.test(String(a || '')));
    const rawBytes = Buffer.from(JSON.stringify({
      structuredContent: { data: { items: rawAsins.map(asin => ({ asin, price: targetPrice })) } },
    }), 'utf8');
    writeFileSync(rawFile, rawBytes);
    const rawSha = createHash('sha256').update(rawBytes).digest('hex');

    const offScen = structuredClone(baseCand.economics.scenarios[0]);
    offScen.id = offScen.cost_ledger.id = 'sc-off-1';
    offScen.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
    offScen.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    offScen.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-01-25' };
    for (const l of offScen.cost_ledger.lines.filter(x => x.fee_basis)) {
      l.fee_basis.effective_from = '2027-01-15';
      l.fee_basis.effective_through = l.id === 'fulfillment' ? '2027-10-14' : '2027-12-31';
    }
    const baseCandidateForIngest = structuredClone(baseCand);
    delete baseCandidateForIngest.economics;

    writeFileSync(specFile, JSON.stringify({
      profile_revision: 59,
      raw_receipt_files: [rawFile],
      expected_raw_sha256s: { [rawFile]: rawSha },
      candidates: [
        {
          candidate: baseCandidateForIngest,
          raw_receipt_files: [rawFile],
          paired_seasonal: {
            saleable_unit: baseCand.economics.saleable_unit,
            off_peak_scenarios: [offScen],
            cubic_feet_per_unit: 0.2,
            storage_evidence: offScen.cost_ledger.lines.find(l => l.id === 'storage').evidence,
          },
        },
      ],
    }, null, 2), 'utf8');

    const run = spawnSync(process.execPath, [
      CLI_PATH,
      'ingest-trial',
      '--input', specFile,
      '--profile', R59_PROFILE_PATH,
      '--output', outBatch,
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, `CLI failed: ${run.stderr}`);
    const parsedStdout = JSON.parse(run.stdout);
    assert.equal(parsedStdout.ok, true);
    assert.equal(parsedStdout.summary.qualifying, 1);

    const writtenBatch = JSON.parse(readFileSync(outBatch, 'utf8'));
    const reScored = scoreBatch(writtenBatch, r59Profile);
    assert.equal(reScored.summary.dispositions.seasonal_off_peak_qualifying, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Astra Round-1 & Round-2 Regressions (Raw Ingest): BLOCKER 4 cross-product ASIN swap, price-row & scenario-price provenance, outer RATE_LIMIT/NO_DATA envelope rejection, missing ledgerDbPath failure, BLOCKER 3b 2x2 Cartesian seasonal matrix, and HIGH 5b contradictory exhausted bid guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-ingest-astra-'));
  try {
    // 1) Failed / NO_DATA / outer RATE_LIMIT envelopes with nested structuredContent.data.items MUST NEVER enter the verified ASIN/price catalog!
    const noisyPayloads = [
      { source_id: 'err-1', payload: { isError: true, content: [{ type: 'text', text: 'Failed lookup for B0ERR00001' }], structuredContent: { data: { items: [{ asin: 'B0ERR00002', price: 85.00 }] } } } },
      { source_id: 'nodata-1', payload: { code: 'OK', dataStatus: 'NO_DATA', items: [{ asin: 'B0NODATA01', price: 45 }] } },
      { source_id: 'nodata-nested', payload: { code: 'OK', dataStatus: 'NO_DATA', structuredContent: { data: { items: [{ asin: 'B0NODATA02', price: 85.00 }] } } } },
      { source_id: 'badcode-1', payload: { code: 'RATE_LIMIT', message: 'Throttled B0BADCODE1', items: [{ asin: 'B0BADCODE2', price: 45 }] } },
      { source_id: 'badcode-nested', payload: { code: 'RATE_LIMIT', structuredContent: { data: { items: [{ asin: 'B0BADCODE3', price: 85.00 }] } } } },
      { source_id: 'errobj-nested', payload: { error: { code: 'RATE_LIMIT', message: 'Throttled' }, structuredContent: { data: { items: [{ asin: 'B0ERROBJ01', price: 90.00 }] } } } },
      { source_id: 'ok-1', payload: { code: 'OK', items: [
        { asin: 'B0GOOD0001', price: 54.00 },
        { asin: 'B0ROWERR01', price: 54.00, resultStatus: 'error' },
        { title: 'Free text mentioning B0FREETXT1 without structured ASIN field', price: 54.00 },
      ] } },
    ];
    const cat = extractVerifiedAsinCatalogFromRawPayloads(noisyPayloads);
    assert.deepEqual([...cat.keys()], ['B0GOOD0001']);

    // 2) Cross-product ASIN substitution, scenario selling-price provenance, mandatory raw_receipt_files, and SQLite ledger SHA-256 check!
    const alphaReceiptPath = join(dir, 'alpha-receipt.json');
    const betaReceiptPath = join(dir, 'beta-receipt.json');
    const alphaPayload = { code: 'OK', items: [{ asin: 'B0ALPHA001', price: 42.00 }] };
    const betaPayload = { code: 'OK', items: [{ asin: 'B0BETAA001', price: 54.00 }] };
    writeFileSync(alphaReceiptPath, JSON.stringify(alphaPayload), 'utf8');
    writeFileSync(betaReceiptPath, JSON.stringify(betaPayload), 'utf8');

    const cAlpha = structuredClone(fixture.candidates[0]);
    cAlpha.id = 'cand-alpha';
    cAlpha.screening.reference_price_usd.target_variant_asin = 'B0ALPHA001';
    cAlpha.screening.reference_price_usd.value = 42.00;
    cAlpha.economics.scenarios[0].cost_ledger.price_usd = 42.00;

    const cBeta = structuredClone(fixture.candidates[0]);
    cBeta.id = 'cand-beta';
    cBeta.screening.reference_price_usd.target_variant_asin = 'B0BETAA001';
    cBeta.screening.reference_price_usd.value = 54.00;
    cBeta.economics.scenarios[0].cost_ledger.price_usd = 54.00;

    // Missing raw_receipt_files MUST reject unless allow_synthetic_without_receipts: true
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      candidates: [{ candidate: cAlpha }],
    }, r59Profile, { baseDir: dir }), /raw_receipt_files/i);

    // Swapping Beta's target_variant_asin to Alpha's B0ALPHA001 rejects via candidate-scoped receipts!
    const cBetaSwapped = structuredClone(cBeta);
    cBetaSwapped.screening.reference_price_usd.target_variant_asin = 'B0ALPHA001';
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json', 'beta-receipt.json'],
      candidates: [
        { candidate: cAlpha, raw_receipt_files: ['alpha-receipt.json'] },
        { candidate: cBetaSwapped, raw_receipt_files: ['beta-receipt.json'] },
      ],
    }, r59Profile, { baseDir: dir }), /B0ALPHA001/);

    // Even if attacker adds alpha-receipt.json into Beta's raw_receipt_files, price-row binding ($42.00 !== $54.00) STILL rejects!
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json', 'beta-receipt.json'],
      candidates: [
        { candidate: cAlpha, raw_receipt_files: ['alpha-receipt.json'] },
        { candidate: cBetaSwapped, raw_receipt_files: ['beta-receipt.json', 'alpha-receipt.json'] },
      ],
    }, r59Profile, { baseDir: dir }), /price-binding violation/i);

    // Round-2 BLOCKER 4: Keeping screening.reference_price_usd.value = $42.00 while inflating economics scenario price_anchor & cost_ledger.price_usd to $85.00 MUST reject!
    const cAlphaInflatedScen = structuredClone(cAlpha);
    cAlphaInflatedScen.economics.scenarios[0].price_anchor = {
      value: 85.00,
      unit: 'USD',
      matched_spec: true,
      target_variant_asin: 'B0ALPHA001',
      fulfillment_channel: 'FBA',
      sales_history_supported: true,
      evidence: cAlpha.screening.reference_price_usd.evidence,
    };
    cAlphaInflatedScen.economics.scenarios[0].cost_ledger.price_usd = 85.00;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json'],
      candidates: [{ candidate: cAlphaInflatedScen, raw_receipt_files: ['alpha-receipt.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    // Tampered expected_raw_sha256s MUST reject!
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json'],
      expected_raw_sha256s: { 'alpha-receipt.json': '0'.repeat(64) },
      candidates: [{ candidate: cAlpha, raw_receipt_files: ['alpha-receipt.json'] }],
    }, r59Profile, { baseDir: dir }), /SHA-256 mismatch/i);

    // Round-2 BLOCKER 4c: Explicitly passing a non-existent ledgerDbPath MUST throw (never silently skip)!
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json'],
      candidates: [{ candidate: cAlpha, raw_receipt_files: ['alpha-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: join(dir, 'does-not-exist.sqlite') }), /Specified ledger_db_path does not exist/i);

    // SQLite ledgerDbPath rejects receipts absent from completed api_request_ledger, and accepts once completed!
    const dbPath = join(dir, 'ledger-verify.sqlite');
    const st = openSelectionStore(dbPath);
    st.close();
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json'],
      candidates: [{ candidate: cAlpha, raw_receipt_files: ['alpha-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbPath }), /api_request_ledger/i);

    const stWrite = openSelectionStore(dbPath);
    const resAttempt = stWrite.reserveRequestAttempt({
      account_scope: 'test-scope',
      provider: 'sellersprite',
      tool_name: 'product_research',
      observation_cutoff_date: '2026-11-22',
      params: { keyword: 'modular desk tray' },
      estimated_ss_mcp_units: 1,
    });
    stWrite.markAttemptInFlight(resAttempt.attempt_id);
    stWrite.completeAttempt(resAttempt.attempt_id, { payload: alphaPayload, ss_mcp_units: 1 });
    stWrite.close();

    // Embedded raster Base64 data URIs (e.g. concept_image_data_uri containing +b0egj8eN9V/) must NEVER trigger false-positive ASIN matches!
    const cAlphaWithRaster = structuredClone(cAlpha);
    cAlphaWithRaster.concept_image_data_uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB+B0EGJ8EN9V/+b0egj8eN9V==';
    const verifiedRasterOut = ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['alpha-receipt.json'],
      candidates: [{ candidate: cAlphaWithRaster, raw_receipt_files: ['alpha-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbPath });
    assert.equal(verifiedRasterOut.per_candidate_verified_asin_counts['cand-alpha'], 1);

    // 3) BLOCKER 3b: buildPairedSeasonalOperatingPeriods rejects omitting a declared off-peak scenario, omitting a quote_id, OR submitting a 2x2 diagonal 2-cell matrix!
    const offSc = structuredClone(fixture.candidates[0].economics.scenarios[0]);
    offSc.id = offSc.cost_ledger.id = 'sc-pass-50pct';
    offSc.quote_id = 'q-1';
    assert.throws(() => buildPairedSeasonalOperatingPeriods({
      saleable_unit: '1 unit',
      off_peak_scenarios: [offSc],
      declared_off_peak_scenario_ids: ['sc-pass-50pct', 'sc-omitted-17pct'],
      cubic_feet_per_unit: 0.25,
    }), /omitted active declared off-peak scenario/i);

    assert.throws(() => buildPairedSeasonalOperatingPeriods({
      saleable_unit: '1 unit',
      off_peak_scenarios: [offSc],
      required_quote_ids: ['q-1', 'q-2-losing'],
      cubic_feet_per_unit: 0.25,
    }), /omitted required Gate 1B quote_id/i);

    // Diagonal 2-cell bypass ($40 x q-1 and $55 x q-2, omitting $40 x q-2 losing cell) MUST reject!
    const diagCell1 = structuredClone(offSc);
    diagCell1.id = diagCell1.cost_ledger.id = 'sc-40-q1';
    diagCell1.quote_id = 'q-1';
    diagCell1.cost_ledger.price_usd = 40.00;
    const diagCell2 = structuredClone(offSc);
    diagCell2.id = diagCell2.cost_ledger.id = 'sc-55-q2';
    diagCell2.quote_id = 'q-2';
    diagCell2.cost_ledger.price_usd = 55.00;
    assert.throws(() => buildPairedSeasonalOperatingPeriods({
      saleable_unit: '1 unit',
      off_peak_scenarios: [diagCell1, diagCell2],
      required_quote_ids: ['q-1', 'q-2'],
      cubic_feet_per_unit: 0.25,
    }), /omitted Cartesian \(price × quote_id\) cell/i);

    // 4) HIGH 5b: Exhausted queries propagate unbid_after_all_tiers: true -> scores 0/15; contradictory all_tiers_exhausted + usable SIF bid fails scoring!
    const exhaustedPlan = extractSifThreeTierBidPlan({
      evidence: [fixture.candidates[0].bids.evidence[0]],
      volume_period: '2026-10',
      queries: [
        { query: 'obscure wood holder', monthly_searches: 400, all_tiers_exhausted: true },
        { query: 'niche tool tray', monthly_searches: 300, all_tiers_exhausted: true },
      ],
    });
    assert.equal(exhaustedPlan.unbid_after_all_tiers, true);
    const candExh = structuredClone(fixture.candidates[0]);
    candExh.bids = exhaustedPlan;
    const exhBidOut = scoreCandidate(candExh, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid');
    assert.equal(exhBidOut.status, 'scored');
    assert.equal(exhBidOut.score, 0);

    const contradictExhaustedPlan = extractSifThreeTierBidPlan({
      evidence: [fixture.candidates[0].bids.evidence[0]],
      volume_period: '2026-10',
      queries: [
        {
          query: 'contradictory query',
          monthly_searches: 500,
          all_tiers_exhausted: true,
          sif_row: { supporting_signals: { cpc_fixed_exact: 0.60 } },
        },
      ],
    });
    const candContradictIngest = structuredClone(fixture.candidates[0]);
    candContradictIngest.bids = contradictExhaustedPlan;
    candContradictIngest.bids.single_entry_support = { status: 'verified', reason: 'Sole term', evidence: [fixture.candidates[0].bids.evidence[0]] };
    assert.equal(scoreCandidate(candContradictIngest, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid').status, 'needs_evidence');

    const fourMainPlan = extractSifThreeTierBidPlan({
      evidence: [fixture.candidates[0].bids.evidence[0]],
      volume_period: '2026-10',
      queries: ['main one', 'main two', 'main three', 'main four'].map(q => ({
        query: q,
        monthly_searches: 500,
        sif_row: { supporting_signals: { cpc_fixed_exact: 0.65 } },
      })),
    });
    const cand4Main = structuredClone(fixture.candidates[0]);
    cand4Main.bids = fourMainPlan;
    assert.equal(scoreCandidate(cand4Main, r59Profile).items.find(i => i.id === 'relevant_purchase_entry_bid').status, 'needs_evidence');

    // 5) Round-3 BLOCKER 4a: Mixed search-page receipt containing $42.00 target AND $290.00 unrelated mega-bundle MUST block $290.00 hijacking across all vectors!
    const mixedPagePath = join(dir, 'mixed-page-receipt.json');
    const mixedPayload = {
      code: 'OK',
      items: [
        { asin: 'B0ALPHA001', price: 42.00, fulfillment: 'FBA', monthlySales: 120, availableDate: '2025-04-01' },
        { asin: 'B0PEER0002', price: 40.00, fulfillment: 'FBA', monthlySales: 110, availableDate: '2025-05-01' },
        { asin: 'B0PEER0003', price: 44.00, fulfillment: 'FBA', monthlySales: 95, availableDate: '2025-03-10' },
        { asin: 'B0PEER0004', price: 39.00, fulfillment: 'FBA', monthlySales: 90, availableDate: '2025-06-01' },
        { asin: 'B0PEER0005', price: 43.00, fulfillment: 'FBA', monthlySales: 80, availableDate: '2025-02-01' },
        { asin: 'B0PEER0006', price: 41.00, fulfillment: 'FBA', monthlySales: 75, availableDate: '2025-04-15' },
        { asin: 'B0PEER0007', price: 45.00, fulfillment: 'FBA', monthlySales: 70, availableDate: '2025-05-20' },
        { asin: 'B0MEGA9999', price: 290.00, fulfillment: 'FBA', monthlySales: 35, availableDate: '2025-01-10' }, // unrelated mega-bundle!
      ],
    };
    writeFileSync(mixedPagePath, JSON.stringify(mixedPayload), 'utf8');

    // Vector A: un-anchored $290.00 scenario price while screening.reference_price_usd = $42.00
    const cHijackUnanchored = structuredClone(cAlpha);
    cHijackUnanchored.economics.scenarios[0].cost_ledger.price_usd = 290.00;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mixed-page-receipt.json'],
      candidates: [{ candidate: cHijackUnanchored, raw_receipt_files: ['mixed-page-receipt.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    // Vector B: anchored to B0MEGA9999 with widened supported_price_range: [42, 290] STILL fails 2.25x / 2.5x bundle-outlier guard!
    const cHijackBundleAnchor = structuredClone(cAlpha);
    cHijackBundleAnchor.screening.reference_price_usd.supported_price_range = [42.00, 290.00];
    cHijackBundleAnchor.economics.scenarios[0].price_anchor = {
      value: 290.00,
      unit: 'USD',
      matched_spec: true,
      target_variant_asin: 'B0MEGA9999',
      fulfillment_channel: 'FBA',
      sales_history_supported: true,
      evidence: cAlpha.screening.reference_price_usd.evidence,
    };
    cHijackBundleAnchor.economics.scenarios[0].cost_ledger.price_usd = 290.00;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mixed-page-receipt.json'],
      candidates: [{ candidate: cHijackBundleAnchor, raw_receipt_files: ['mixed-page-receipt.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    // 6) Round-3 BLOCKER 3b: ingestTrialSpecification with ledgerDbPath enforces SQLite Gate 1A declared prices [$40, $55] x quotes ['q-1', 'q-2']!
    const dbMatrixPath = join(dir, 'matrix-verify.sqlite');
    const stMat = openSelectionStore(dbMatrixPath);
    const attMat = stMat.reserveRequestAttempt({
      account_scope: 'mat-scope',
      provider: 'sellersprite',
      tool_name: 'product_research',
      observation_cutoff_date: '2026-11-22',
      params: { keyword: 'matrix test' },
      estimated_ss_mcp_units: 1,
    });
    stMat.markAttemptInFlight(attMat.attempt_id);
    const matReceiptPayload = { code: 'OK', items: [{ asin: 'B0MAT00001', price: 40 }, { asin: 'B0MAT00002', price: 55 }] };
    stMat.completeAttempt(attMat.attempt_id, { payload: matReceiptPayload, ss_mcp_units: 1 });
    writeFileSync(join(dir, 'mat-receipt.json'), JSON.stringify(matReceiptPayload), 'utf8');

    const pkgMat = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const uiMat = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    stMat.upsertCandidateForm({
      form_id: 'cand-db-matrix',
      product_family_key: 'db-matrix',
      label: 'DB matrix form',
      buyer_task: 'Task',
      saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
    });
    const formRow = stMat.getCandidateForm('cand-db-matrix');
    stMat.updateFormLifecycle('cand-db-matrix', 'gate1a_passed', {
      gate1a_result: {
        spec_sha256: formRow.spec_sha256,
        proceed_to_gate1b: true,
        declared_scenarios: [{ id: 'sc-40', price_usd: 40 }, { id: 'sc-55', price_usd: 55 }],
      },
    });
    stMat.recordSourcingQuote1688({
      quote_id: 'q-mat-1',
      form_id: 'cand-db-matrix',
      observed_at: '2026-11-22T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-m1',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: pkgMat,
      ui_readback: uiMat,
      sku_lines: [{ component_id: 'item', offer_id: 'o1', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 35, regular_goods_promo_false: true }],
      goods_cny_total: 3500,
      domestic_freight_cny_total: 200,
    });
    stMat.recordSourcingQuote1688({
      quote_id: 'q-mat-2',
      form_id: 'cand-db-matrix',
      observed_at: '2026-11-22T10:05:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-m2',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      fx_cny_per_usd: 7.2,
      pkg: pkgMat,
      ui_readback: uiMat,
      sku_lines: [{ component_id: 'item', offer_id: 'o2', sku_id: 's2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 130, regular_goods_promo_false: true }],
      goods_cny_total: 13000,
      domestic_freight_cny_total: 800,
    });
    stMat.close();

    // Keep all 4 scenario IDs, but mutate the two $40 cells to $55 -> MUST throw omitted declared Gate 1A price!
    const cMat = structuredClone(fixture.candidates[0]);
    cMat.id = 'cand-db-matrix';
    cMat.screening.reference_price_usd.target_variant_asin = 'B0MAT00001';
    cMat.screening.reference_price_usd.value = 40;
    cMat.screening.reference_price_usd.supported_price_range = [40, 55];
    cMat.screening.reference_price_usd.note = 'Peers B0MAT00001 ($40) & B0MAT00002 ($55)';
    delete cMat.economics;
    const mkMatSc = (id, qid, priceUsd) => {
      const s = structuredClone(offSc);
      s.id = s.cost_ledger.id = id;
      s.quote_id = qid;
      s.cost_ledger.price_usd = priceUsd;
      return s;
    };
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{
        candidate: cMat,
        raw_receipt_files: ['mat-receipt.json'],
        paired_seasonal: {
          saleable_unit: '1 unit',
          declared_off_peak_scenario_ids: ['sc-40-q1', 'sc-40-q2', 'sc-55-q1', 'sc-55-q2'],
          off_peak_scenarios: [
            mkMatSc('sc-40-q1', 'q-mat-1', 55), // mutated $40 -> $55!
            mkMatSc('sc-40-q2', 'q-mat-2', 55), // mutated $40 -> $55!
            mkMatSc('sc-55-q1', 'q-mat-1', 55),
            mkMatSc('sc-55-q2', 'q-mat-2', 55),
          ],
          cubic_feet_per_unit: 0.25,
        },
      }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /omitted declared Gate 1A off-peak price/i);

    // 7) Post-Round-3 Hardening:
    //    (a) value_range [40, 290] on <8-item receipt MUST reject $290 mega-bundle hijacking;
    //    (b) scenario target_variant_asin pointing to excluded_different_task ASIN or outside supported_price_range MUST reject;
    //    (c) flat-annual diagonal 2-cell ($40 x q-win, $55 x q-lose) without paired_seasonal MUST reject;
    //    (d) SQLite quote cost tampering, single losing SQLite quote bypass, and r58 partial-UI quote under r59 MUST reject, while expired SQLite quote does NOT falsely block fresh quote!
    writeFileSync(join(dir, 'small-page-bundle.json'), JSON.stringify({
      code: 'OK',
      items: [
        { asin: 'B0TARG0040', price: 40.00, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-04-01' },
        { asin: 'B0PEER0041', price: 41.00, fulfillment: 'FBA', monthlySales: 90, availableDate: '2025-04-01' },
        { asin: 'B0DIFF0049', price: 49.99, fulfillment: 'FBA', monthlySales: 50, availableDate: '2025-04-01' },
        { asin: 'B0MEGA0290', price: 290.00, fulfillment: 'FBA', monthlySales: 30, availableDate: '2025-04-01' },
      ],
    }), 'utf8');
    const anchorTpl = fixture.candidates[1].economics.scenarios[1].price_anchor;

    const cValRangeHijack = structuredClone(fixture.candidates[0]);
    cValRangeHijack.id = 'cand-valrange-hijack';
    cValRangeHijack.screening.reference_price_usd.target_variant_asin = 'B0TARG0040';
    delete cValRangeHijack.screening.reference_price_usd.value;
    cValRangeHijack.screening.reference_price_usd.value_range = [40.00, 290.00];
    cValRangeHijack.screening.reference_price_usd.coherent = true;
    cValRangeHijack.screening.reference_price_usd.range_basis = 'synthetic range';
    cValRangeHijack.economics.scenarios[0].price_anchor = {
      ...structuredClone(anchorTpl),
      value: 290.00,
      target_variant_asin: 'B0MEGA0290',
      evidence: cValRangeHijack.screening.reference_price_usd.evidence,
    };
    cValRangeHijack.economics.scenarios[0].cost_ledger.price_usd = 290.00;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['small-page-bundle.json'],
      candidates: [{ candidate: cValRangeHijack, raw_receipt_files: ['small-page-bundle.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    const cExclTaskHijack = structuredClone(fixture.candidates[0]);
    cExclTaskHijack.id = 'cand-excl-task-hijack';
    cExclTaskHijack.newcomer_cohort.market_reference.families[4] = {
      family_id: 'FAM-DIFF',
      asin: 'B0DIFF0049',
      comparability_verdict: 'excluded_different_task',
      reason: 'Different mechanism',
      evidence: cExclTaskHijack.screening.reference_price_usd.evidence,
      units_30d: { value: 50, unit: 'units', evidence: cExclTaskHijack.screening.reference_price_usd.evidence },
    };
    cExclTaskHijack.screening.reference_price_usd.target_variant_asin = 'B0TARG0040';
    cExclTaskHijack.screening.reference_price_usd.value = 40.00;
    cExclTaskHijack.screening.reference_price_usd.supported_price_range = [40.00, 41.00];
    cExclTaskHijack.economics.scenarios[0].price_anchor = {
      ...structuredClone(anchorTpl),
      value: 49.99,
      target_variant_asin: 'B0DIFF0049',
      evidence: cExclTaskHijack.screening.reference_price_usd.evidence,
    };
    cExclTaskHijack.economics.scenarios[0].cost_ledger.price_usd = 49.99;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['small-page-bundle.json'],
      candidates: [{ candidate: cExclTaskHijack, raw_receipt_files: ['small-page-bundle.json'] }],
    }, r59Profile, { baseDir: dir }), /excluded_different_task|supported_price_range/i);

    // Flat-annual diagonal 2-cell submission without paired_seasonal MUST reject!
    const cFlatDiag = structuredClone(fixture.candidates[0]);
    cFlatDiag.id = 'cand-flat-diag';
    cFlatDiag.screening.reference_price_usd.target_variant_asin = 'B0MAT00001';
    cFlatDiag.screening.reference_price_usd.value = 40.00;
    cFlatDiag.screening.reference_price_usd.supported_price_range = [40.00, 55.00];
    cFlatDiag.screening.reference_price_usd.note = 'Peers B0MAT00001 and B0MAT00002';
    const fCell1 = structuredClone(cFlatDiag.economics.scenarios[0]);
    fCell1.id = fCell1.cost_ledger.id = 'flat-40-q1';
    fCell1.quote_id = 'q-win';
    fCell1.cost_ledger.price_usd = 40.00;
    const fCell2 = structuredClone(cFlatDiag.economics.scenarios[0]);
    fCell2.id = fCell2.cost_ledger.id = 'flat-55-q2';
    fCell2.quote_id = 'q-lose';
    fCell2.cost_ledger.price_usd = 55.00;
    cFlatDiag.economics.expected_primary_scenarios = [{ id: 'flat-40-q1', status: 'active' }, { id: 'flat-55-q2', status: 'active' }];
    cFlatDiag.economics.scenarios = [fCell1, fCell2];
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cFlatDiag, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir }), /omitted Cartesian \(price × quote_id\) cell/i);

    // SQLite quote cost tampering on cand-db-matrix MUST reject!
    const cCostTamper = structuredClone(fixture.candidates[0]);
    cCostTamper.id = 'cand-db-matrix';
    cCostTamper.screening.reference_price_usd.target_variant_asin = 'B0MAT00001';
    cCostTamper.screening.reference_price_usd.value = 40.00;
    cCostTamper.screening.reference_price_usd.supported_price_range = [40.00, 55.00];
    cCostTamper.screening.reference_price_usd.note = 'Peers B0MAT00001 and B0MAT00002';
    const mkTampered = (id, qid, pr) => {
      const s = structuredClone(cCostTamper.economics.scenarios[0]);
      s.id = s.cost_ledger.id = id;
      s.quote_id = qid;
      s.cost_ledger.price_usd = pr;
      s.cost_ledger.fx_cny_per_usd = 7.2;
      s.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 35 / 7.2; // tampered on q-mat-2 ($130/7.2)!
      s.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = 2 / 7.2;
      return s;
    };
    cCostTamper.economics.expected_primary_scenarios = ['t-40-1', 't-40-2', 't-55-1', 't-55-2'].map(id => ({ id, status: 'active' }));
    cCostTamper.economics.scenarios = [
      mkTampered('t-40-1', 'q-mat-1', 40),
      mkTampered('t-40-2', 'q-mat-2', 40),
      mkTampered('t-55-1', 'q-mat-1', 55),
      mkTampered('t-55-2', 'q-mat-2', 55),
    ];
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cCostTamper, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /disagrees with persisted SQLite 1688 quote "q-mat-2"/i);

    // Single losing quote, partial-UI quote, and expired quote in SQLite!
    const stExtra = openSelectionStore(dbMatrixPath);
    stExtra.upsertCandidateForm({ form_id: 'cand-1q-only', product_family_key: '1qo', label: '1QO', buyer_task: 'T', saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }] });
    stExtra.recordSourcingQuote1688({
      quote_id: 'q-1q-lose', form_id: 'cand-1q-only', observed_at: '2026-11-22T10:00:00Z', redacted_destination: '广东深圳', raw_readback_ref: 'ev-1ql',
      goods_first_order_promotion: false, freight_first_order_promotion: false, fx_cny_per_usd: 7.2, pkg: pkgMat, ui_readback: uiMat,
      sku_lines: [{ component_id: 'item', offer_id: 'o1', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 180, regular_goods_promo_false: true }],
      goods_cny_total: 18000, domestic_freight_cny_total: 720,
    });
    stExtra.upsertCandidateForm({ form_id: 'cand-partial-ui', product_family_key: 'pui', label: 'PUI', buyer_task: 'T', saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }] });
    stExtra.recordSourcingQuote1688({
      quote_id: 'q-partial-ui', form_id: 'cand-partial-ui', observed_at: '2026-11-22T10:00:00Z', redacted_destination: '广东深圳', raw_readback_ref: 'ev-pui',
      goods_first_order_promotion: false, freight_first_order_promotion: false, fx_cny_per_usd: 7.2, pkg: pkgMat,
      ui_readback: { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true }, // missing applied_quantity_confirmed!
      sku_lines: [{ component_id: 'item', offer_id: 'o2', sku_id: 's2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40.32, regular_goods_promo_false: true }],
      goods_cny_total: 4032, domestic_freight_cny_total: 576,
    });
    stExtra.upsertCandidateForm({ form_id: 'cand-expired-plus-fresh', product_family_key: 'epf', label: 'EPF', buyer_task: 'T', saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }] });
    stExtra.recordSourcingQuote1688({
      quote_id: 'q-old-exp', form_id: 'cand-expired-plus-fresh', observed_at: '2026-10-01T10:00:00Z', expires_at: '2026-10-15T10:00:00Z', redacted_destination: '广东深圳', raw_readback_ref: 'ev-exp',
      goods_first_order_promotion: false, freight_first_order_promotion: false, fx_cny_per_usd: 7.2, pkg: pkgMat, ui_readback: uiMat,
      sku_lines: [{ component_id: 'item', offer_id: 'o3', sku_id: 's3', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 180, regular_goods_promo_false: true }],
      goods_cny_total: 18000, domestic_freight_cny_total: 720,
    });
    stExtra.recordSourcingQuote1688({
      quote_id: 'q-now-fresh', form_id: 'cand-expired-plus-fresh', observed_at: '2026-11-12T10:00:00Z', expires_at: '2026-12-22T10:00:00Z', redacted_destination: '广东深圳', raw_readback_ref: 'ev-fr',
      goods_first_order_promotion: false, freight_first_order_promotion: false, fx_cny_per_usd: 7.2, pkg: pkgMat, ui_readback: uiMat,
      sku_lines: [{ component_id: 'item', offer_id: 'o4', sku_id: 's4', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40.32, regular_goods_promo_false: true }],
      goods_cny_total: 4032, domestic_freight_cny_total: 576,
    });
    stExtra.close();

    const cFake1Q = structuredClone(fixture.candidates[0]);
    cFake1Q.id = 'cand-1q-only';
    cFake1Q.screening.reference_price_usd.target_variant_asin = 'B0MAT00001';
    cFake1Q.screening.reference_price_usd.value = 40.00;
    cFake1Q.economics.scenarios[0].quote_id = 'q-invented-win';
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cFake1Q, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /unknown or expired quote_id/i);

    const cPartialUi = structuredClone(fixture.candidates[0]);
    cPartialUi.id = 'cand-partial-ui';
    cPartialUi.screening.reference_price_usd.target_variant_asin = 'B0MAT00001';
    cPartialUi.screening.reference_price_usd.value = 40.00;
    cPartialUi.economics.scenarios[0].quote_id = 'q-partial-ui';
    cPartialUi.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.2;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cPartialUi, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /incomplete ui_readback/i);

    const cExpFresh = structuredClone(fixture.candidates[0]);
    cExpFresh.id = 'cand-expired-plus-fresh';
    cExpFresh.screening.reference_price_usd.target_variant_asin = 'B0MAT00001';
    cExpFresh.screening.reference_price_usd.value = 40.00;
    cExpFresh.economics.scenarios[0].quote_id = 'q-now-fresh';
    cExpFresh.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.2;
    cExpFresh.economics.scenarios[0].cost_ledger.order_units = 100;
    cExpFresh.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 5.60;
    cExpFresh.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = 0.80;
    const okExpFresh = ingestTrialSpecification({
      profile_revision: 59,
      as_of_date: '2026-11-13',
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cExpFresh, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath });
    assert.equal(okExpFresh.scored.summary.qualifying, 1, 'Expired quote must not falsely block valid fresh quote');

    // Round-4 BLOCKER 3a & 3b:
    //  - Stale FX (7.4 in scenario + costs computed at 7.4 when SQLite quote FX is 7.2) MUST fail!
    //  - All SQLite quotes expired as_of_date MUST fail!
    const cStaleFx = structuredClone(cExpFresh);
    cStaleFx.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.4;
    cStaleFx.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = Number((40.32 / 7.4).toFixed(6));
    cStaleFx.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((5.76 / 7.4).toFixed(6));
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      as_of_date: '2026-11-13',
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cStaleFx, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /fx_cny_per_usd.*conflicts/i);

    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      as_of_date: '2027-01-10', // AFTER q-now-fresh expires_at (2026-12-22)!
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cExpFresh, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /expired as of 2027-01-10/i);

    // Backdated spec.as_of_date CANNOT rewind past candidate observation_date to resurrect an expired SQLite quote,
    // and SQLite Gate-1A accepted fx_cny_per_usd (7.2) blocks stale 7.4 even when quote.fx_cny_per_usd is null!
    const stG1aFx = openSelectionStore(dbMatrixPath);
    stG1aFx.upsertCandidateForm({ form_id: 'cand-g1afx-backdate', product_family_key: 'g1afx', label: 'G1AFX', buyer_task: 'T', saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }] });
    const g1aFxForm = stG1aFx.getCandidateForm('cand-g1afx-backdate');
    stG1aFx.updateFormLifecycle('cand-g1afx-backdate', 'gate1a_passed', {
      gate1a_result: { spec_sha256: g1aFxForm.spec_sha256, proceed_to_gate1b: true, declared_scenarios: [{ id: 'sc-40', price_usd: 40, fx_cny_per_usd: 7.2 }] },
    });
    stG1aFx.recordSourcingQuote1688({
      quote_id: 'q-null-fx-exp', form_id: 'cand-g1afx-backdate', observed_at: '2026-11-01T10:00:00Z', expires_at: '2026-12-22T10:00:00Z',
      redacted_destination: '广东深圳', raw_readback_ref: 'ev-nf', goods_first_order_promotion: false, freight_first_order_promotion: false,
      fx_cny_per_usd: null, pkg: pkgMat, ui_readback: uiMat,
      sku_lines: [{ component_id: 'item', offer_id: 'o5', sku_id: 's5', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 40.32, regular_goods_promo_false: true }],
      goods_cny_total: 4032, domestic_freight_cny_total: 576,
    });
    stG1aFx.close();

    const cNullQuoteFx = structuredClone(cStaleFx);
    cNullQuoteFx.id = 'cand-g1afx-backdate';
    cNullQuoteFx.economics.scenarios[0].quote_id = 'q-null-fx-exp';
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      as_of_date: '2026-11-13',
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cNullQuoteFx, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /fx_cny_per_usd.*conflicts/i);

    const cFutureObsBackdate = structuredClone(cExpFresh);
    cFutureObsBackdate.evidence.push({ id: 'ev-jan-obs', source: 'Observed Jan 2027', observed_at: '2027-01-10' });
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      as_of_date: '2026-11-13', // backdated BEFORE 2027-01-10 evidence!
      raw_receipt_files: ['mat-receipt.json'],
      candidates: [{ candidate: cFutureObsBackdate, raw_receipt_files: ['mat-receipt.json'] }],
    }, r59Profile, { baseDir: dir, ledgerDbPath: dbMatrixPath }), /expired as of 2027-01-10/i);

    // Round-4 BLOCKER 4a-d:
    //  - Seasonal primary [2..9] period renamed id:'peak' + companion [10..12] renamed id:'holiday' STILL rejects $289.99;
    //  - Free-text prose in scenario.label ("Cross-check excluded wall-mount rack B0DIFF0049 at $49.99") CANNOT authorize $49.99;
    //  - Cross-category asin_detail receipt (toys-and-games + arts-crafts + kitchen) CANNOT leak $64.69 quantile or cross-category anchor;
    //  - screening.reference_price_usd.target_variant_asin pointing to an excluded_different_task ASIN on a 2-row page is rejected;
    //  - Per-row error item is excluded from extractVerifiedAsinCatalogFromRawPayloads.
    const mixedCatReceiptPath = join(dir, 'mixed-cat-detail.json');
    const mixedCatPayload = {
      code: 'OK',
      items: [
        { asin: 'B0TARG0040', price: 39.99, categoryId: 'arts-crafts', fulfillment: 'FBA', availableDate: '2025-01-01' },
        { asin: 'B0DIFF0049', price: 49.99, categoryId: 'arts-crafts', fulfillment: 'FBA', availableDate: '2025-01-01' },
        { asin: 'B0TOYS0065', price: 64.69, categoryId: 'toys-and-games', fulfillment: 'FBA', availableDate: '2025-01-01' },
        { asin: 'B0TOYS0088', price: 88.00, categoryId: 'toys-and-games', fulfillment: 'FBA', availableDate: '2025-01-01' },
        { asin: 'B0KITC0052', price: 51.99, categoryId: 'kitchen', fulfillment: 'FBA', availableDate: '2025-01-01' },
      ],
    };
    writeFileSync(mixedCatReceiptPath, JSON.stringify(mixedCatPayload));
    const twoRowBundlePath = join(dir, 'two-row-bundle.json');
    writeFileSync(twoRowBundlePath, JSON.stringify({
      code: 'OK',
      items: [
        { asin: 'B0TARG0040', price: 39.99, fulfillment: 'FBA', monthlySales: 100, availableDate: '2025-01-01' },
        { asin: 'B0MEGA0290', price: 289.99, fulfillment: 'FBA', monthlySales: 40, availableDate: '2025-01-01' },
      ],
    }));

    const cProseWall = structuredClone(fixture.candidates[0]);
    cProseWall.id = 'cand-prose-wall';
    cProseWall.screening.reference_price_usd = {
      ...cProseWall.screening.reference_price_usd,
      value: 39.99,
      target_variant_asin: 'B0TARG0040',
      matched_spec: true,
      supported_price_range: [39.99, 49.99],
    };
    cProseWall.economics.scenarios[0].cost_ledger.price_usd = 49.99;
    cProseWall.economics.scenarios[0].label = 'Cross-check excluded wall-mount rack B0DIFF0049 at $49.99';
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mixed-cat-detail.json'],
      candidates: [{ candidate: cProseWall, raw_receipt_files: ['mixed-cat-detail.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    const cMixedQuantile = structuredClone(cProseWall);
    cMixedQuantile.id = 'cand-mixed-quantile';
    cMixedQuantile.screening.reference_price_usd.supported_price_range = [39.99, 64.69];
    cMixedQuantile.economics.scenarios[0].cost_ledger.price_usd = 64.69;
    cMixedQuantile.economics.scenarios[0].label = 'Standard scenario';
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mixed-cat-detail.json'],
      candidates: [{ candidate: cMixedQuantile, raw_receipt_files: ['mixed-cat-detail.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    const cCrossCatAnchor = structuredClone(cMixedQuantile);
    cCrossCatAnchor.economics.scenarios[0].price_anchor = {
      value: 64.69,
      target_variant_asin: 'B0TOYS0065',
      evidence: cMixedQuantile.screening.reference_price_usd.evidence,
    };
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['mixed-cat-detail.json'],
      candidates: [{ candidate: cCrossCatAnchor, raw_receipt_files: ['mixed-cat-detail.json'] }],
    }, r59Profile, { baseDir: dir }), /disjoint from candidate category/i);

    const cTwoRowExcluded = structuredClone(fixture.candidates[0]);
    cTwoRowExcluded.id = 'cand-2row-excl';
    cTwoRowExcluded.newcomer_cohort.market_reference.families.push({
      family_id: 'fam-excl-bundle',
      asin: 'B0MEGA0290',
      comparability_verdict: 'excluded_different_task',
      units_30d: { value: 40, unit: 'units', evidence: cTwoRowExcluded.screening.reference_price_usd.evidence },
    });
    cTwoRowExcluded.screening.reference_price_usd = {
      ...cTwoRowExcluded.screening.reference_price_usd,
      value: 289.99,
      target_variant_asin: 'B0MEGA0290',
      matched_spec: true,
    };
    cTwoRowExcluded.economics.scenarios[0].cost_ledger.price_usd = 289.99;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['two-row-bundle.json'],
      candidates: [{ candidate: cTwoRowExcluded, raw_receipt_files: ['two-row-bundle.json'] }],
    }, r59Profile, { baseDir: dir }), /excluded_different_task/i);

    // Seasonal [2..9] period renamed id:'peak' + [10..12] renamed id:'holiday' STILL blocks $289.99!
    const cRenamedSeasonal = structuredClone(fixture.candidates[0]);
    cRenamedSeasonal.id = 'cand-renamed-peak-months';
    cRenamedSeasonal.screening.reference_price_usd = {
      ...cRenamedSeasonal.screening.reference_price_usd,
      value: 39.99,
      target_variant_asin: 'B0TARG0040',
      matched_spec: true,
    };
    const paired = buildPairedSeasonalOperatingPeriods({
      saleable_unit: '1 unit',
      off_peak_scenarios: [structuredClone(cRenamedSeasonal.economics.scenarios[0])],
      cubic_feet_per_unit: 0.25,
      size_tier: 'large_standard',
      storage_evidence: [cRenamedSeasonal.screening.reference_price_usd.evidence[0]],
    });
    paired.operating_periods[0].id = 'peak'; // adversarial rename of [2..9] off-peak period!
    paired.operating_periods[0].scenarios[0].cost_ledger.price_usd = 289.99;
    paired.operating_periods[1].id = 'holiday';
    cRenamedSeasonal.economics = paired;
    assert.throws(() => ingestTrialSpecification({
      profile_revision: 59,
      raw_receipt_files: ['two-row-bundle.json'],
      candidates: [{ candidate: cRenamedSeasonal, raw_receipt_files: ['two-row-bundle.json'] }],
    }, r59Profile, { baseDir: dir }), /Scenario price provenance violation/i);

    const perRowCat = extractVerifiedAsinCatalogFromRawPayloads([{
      structuredContent: {
        data: {
          items: [
            { asin: 'B0ROWERR99', price: 64.69, error: { code: 'RATE_LIMIT' } },
          ],
        },
      },
    }]);
    assert.equal(perRowCat.size, 0, 'Per-row error object must not enter verified ASIN catalog');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
