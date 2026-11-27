import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  FBA_2027_UNPUBLISHED_PEAK_WINDOW,
  UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
  classifySizeTier2027,
  lookupBulkyFulfillmentFee2027,
  lookupOversizeFulfillmentFee2027,
  lookupOversizeHandlingFees2027,
  lookupApparelFulfillmentFee2027,
  lookupDangerousGoodsFulfillmentFee2027,
  lookupDangerousGoodsStorageFee2027,
  lookupUnifiedFulfillmentFee2027,
  lookupUnifiedPlacementFee2027,
  lookupUnifiedReturnsProcessing2027,
  isCategoryLowPriceEligible2027,
  buildOutOfTableLookupDirective,
  computeMatchedPeerMedianPackage,
  computePackagingRedesignShortlist2027,
  estimateGate1A2027,
  getFba2027RateTableSnapshot,
} from '../src/fba-calculator.mjs';
import { canonicalizeConnectorToolName, validateProviderCall } from '../src/provider-guards.mjs';
import { extractNewcomerReviewOriginBreakdown } from '../src/observations.mjs';
import {
  extractSpApiFinalistCalibration,
  ingestSellerSpriteMonthlyArchiveMarket,
  resolveStage1QualitativeJudgments,
  buildPairedSeasonalOperatingPeriods,
  ingestTrialSpecification,
  extractNicheAverageStarReference,
  extractQ31DualSourceKeywordCounts,
} from '../src/raw-ingest.mjs';
import { scoreCandidate, scoreBatch } from '../src/scoring.mjs';
import {
  attachCandidateEvidenceReview,
  runGate1AForForm,
  runGate1BForForm,
  runOptionalGate4EvidenceReview,
  runPhase2Batch,
} from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { replayBatchIntoStore } from '../src/history-import.mjs';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import {
  analyzeMainstreamPriceBand,
  detectKeepaVeteranClearanceOrWar,
  evaluateGate0CategoryBoundary,
} from '../src/price-band.mjs';
import { evaluateEarlyScreen } from '../src/economics.mjs';
import { calculateEconomics } from '../src/economics.mjs';
import { STAGE4_AS_OF_DATE, makeDatedKeepaReceipt } from './helpers/stage4-fixtures.mjs';
import { resolveEffectivePricing } from '../src/fba-calculator.mjs';
import * as openaiIndex from '../src/openai/index.mjs';
import * as openaiClientMod from '../src/openai/client.mjs';
import * as openaiPricingMod from '../src/openai/pricing.mjs';
import {
  OpenAiBudgetLedger,
  openOpenAiBudgetLedger,
  reconcileLegacyBudgetIntoStore,
} from '../src/openai/budget-ledger.mjs';
import {
  resolveRelevantRegulatoryFrameworks,
  buildMarketObservationRequest,
  parseMarketObservationResult,
  parseStage1DecisionsResponses,
  parse1688VisionInspectResult,
  buildRightsPreScreenRequest,
} from '../src/openai/workflow-tasks.mjs';
import { freezeEvidenceReviewPacket, buildEvidenceReviewPrompt } from '../src/openai/evidence-review.mjs';
import {
  buildCodexExecArgs,
  runCodexExecMarkdown,
  runCodexEvidenceReview,
  verifySavedCodexReceipt,
} from '../src/openai/codex-runner.mjs';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const r58Profile = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'archive', 'design', 'reference-profile.r58.archived.json'), 'utf8'));
const r59Profile = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'design', 'reference-profile.r59.draft.json'), 'utf8'));
const synthBatch = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'synthetic-batch.json'), 'utf8'));

function runCliMem(args, testHooks = undefined) {
  let stdout = '';
  let stderr = '';
  return runPhase2Cli(
    args,
    {
      stdout: { write: chunk => { stdout += String(chunk); } },
      stderr: { write: chunk => { stderr += String(chunk); } },
    },
    testHooks,
  ).then(code => ({ code, stdout, stderr }));
}

test('Round 1 (1 & 3): 2027 off-peak sales (2027-02-01..2027-10-14) vs storage (2027-02-01..2027-09-30), Q4 peak blank note, and 2026 peak extrapolation ban', () => {
  assert.deepEqual(FBA_2027_DEFAULT_OFF_PEAK_WINDOW, { from: '2027-02-01', through: '2027-10-14' });
  assert.deepEqual(FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW, { from: '2027-02-01', through: '2027-09-30' });
  assert.deepEqual(FBA_2027_COMPANION_PEAK_STORAGE_WINDOW, { from: '2027-10-01', through: '2027-12-31' });
  assert.deepEqual(FBA_2027_UNPUBLISHED_PEAK_WINDOW, { from: '2027-10-15', through: '2028-01-14' });
  assert.equal(UNPUBLISHED_2027_PEAK_MARGIN_NOTE, '待亚马逊公布 2027 旺季费率后补充');

  const baseCand = structuredClone(synthBatch.candidates[0]);
  baseCand.id = 'cand-seasonal-2027-win';
  const pkgRef = baseCand.economics.scenarios[0].cost_ledger.fee_context.package_ref;
  const scOff = structuredClone(baseCand.economics.scenarios[0]);
  scOff.id = scOff.cost_ledger.id = 'sc-offpeak-win';
  scOff.cost_ledger.fee_context = {
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  for (const line of scOff.cost_ledger.lines) {
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

  const paired = buildPairedSeasonalOperatingPeriods({
    saleable_unit: baseCand.economics.saleable_unit,
    off_peak_scenarios: [scOff],
    cubic_feet_per_unit: 0.25,
    storage_evidence: [baseCand.evidence[0].id],
  });
  const periods = paired.operating_periods;
  assert.equal(periods.length, 2);
  assert.deepEqual(periods[0].months, [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(periods[1].months, [10, 11, 12, 1]);

  delete baseCand.economics.scenarios;
  delete baseCand.economics.expected_primary_scenarios;
  baseCand.economics.operating_periods = periods;

  const scored = scoreCandidate(baseCand, r59Profile);
  assert.equal(scored.qualification.counts_toward_target, true, JSON.stringify(scored.qualification));
  assert.equal(scored.qualification.mode, 'seasonal_eligible');
  assert.equal(scored.effective_disposition, 'seasonal_off_peak_qualifying');
  const peakPeriod = scored.operating_periods.find(p => p.id === 'peak');
  assert.equal(scored.qualification.unpublished_peak_note, UNPUBLISHED_2027_PEAK_MARGIN_NOTE);
  assert.equal(peakPeriod.total_range, null);

  // Guard: fabricating Q4 2027 peak margin from 2026 holiday uplift is deterministically rejected!
  const badCand = structuredClone(baseCand);
  const badPeakFul = badCand.economics.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'fulfillment');
  badPeakFul.status = 'supported';
  badPeakFul.amount_usd = 7.45;
  badPeakFul.fee_basis = {
    status: 'published',
    version: 'estimated-from-2026-peak-uplift',
    marketplace: 'US',
    currency: 'USD',
    package_ref: pkgRef,
    effective_from: '2027-10-15',
    effective_through: '2028-01-14',
  };
  const badScored = scoreCandidate(badCand, r59Profile);
  assert.equal(badScored.qualification.counts_toward_target, false);
  assert.ok(badScored.qualification.reasons.some(r => /2026|peak/i.test(r)));
});

test('Round 1 (1): SP-API read-only finalist calibration overrides stale SellerSprite cache, separates brand vs category gating, and runs via CLI & SQLite store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-spapi-cal-'));
  try {
    const specInput = {
      price_usd: 59.99,
      target_is_own_white_label: true,
      catalogItemRaw: {
        asin: 'B0SYNTH888',
        dimensions: [{
          package: {
            length: { value: 20.0, unit: 'inches' },
            width: { value: 10.0, unit: 'inches' },
            height: { value: 6.0, unit: 'inches' },
            weight: { value: 12.2, unit: 'pounds' },
          },
        }],
      },
      feesEstimateRaw: {
        FeesEstimateResult: {
          FeesEstimateIdentifier: {
            IdValue: 'B0SYNTH888',
            PriceToEstimateFees: { ListingPrice: { Amount: 59.99, CurrencyCode: 'USD' } },
          },
          FeesEstimate: {
            TotalFeesEstimate: { Amount: 24.29, CurrencyCode: 'USD' },
            FeeDetailList: [
              { FeeType: 'ReferralFee', FinalFee: { Amount: 9.00, CurrencyCode: 'USD' } },
              { FeeType: 'FBAFees', FinalFee: { Amount: 15.29, CurrencyCode: 'USD' } },
            ],
          },
        },
      },
      restrictionsRaw: {
        restrictions: [{
          reasons: [{ message: 'You need approval to list in this brand.' }],
        }],
      },
      sellerSpriteCachedRow: {
        length_in: 20.0,
        width_in: 10.0,
        height_in: 6.0,
        unit_weight_lb: 33.5,
      },
    };

    const cal = extractSpApiFinalistCalibration(specInput);
    assert.equal(cal.asin, 'B0SYNTH888');
    assert.equal(cal.official_pkg.unit_weight_lb, 12.2);
    assert.equal(cal.fee_calibration.referral_fraction, 0.150025);
    assert.equal(cal.restrictions.hard_category_ban, false);
    assert.equal(cal.restrictions.has_competitor_brand_gate, true);
    assert.equal(cal.stale_sellersprite_audit.stale_sellersprite_cache_corrected, true);
    assert.ok(cal.stale_sellersprite_audit.fba_2027_delta_usd < -8.0, 'SP-API official 12.2 lb saves >$8 vs stale 33.5 lb SellerSprite cache');

    // Genuine category ban is still flagged hard_category_ban: true
    const bannedCal = extractSpApiFinalistCalibration({
      restrictionsRaw: { restrictions: [{ reasons: [{ message: 'This product is prohibited and not permitted for sale.' }] }] },
    });
    assert.equal(bannedCal.restrictions.hard_category_ban, true);

    // CLI `sp-api-calibrate` round-trip
    const inPath = join(dir, 'sp-in.json');
    const outPath = join(dir, 'sp-out.json');
    writeFileSync(inPath, JSON.stringify(specInput, null, 2), 'utf8');
    const cliRes = await runCliMem(['sp-api-calibrate', '--input', inPath, '--output', outPath]);
    assert.equal(cliRes.code, 0, cliRes.stderr);
    const saved = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(saved.calibration.official_pkg.unit_weight_lb, 12.2);

    // SQLite store supports 'sp_api' provider natively
    const store = openSelectionStore(':memory:');
    try {
      const res = store.reserveRequestAttempt({
        account_scope: 'test-sp-api',
        provider: 'sp_api',
        tool_name: 'catalogItems_getCatalogItem',
        observation_cutoff_date: '2026-11-24',
        params: { asin: 'B0SYNTH888', marketplaceIds: ['ATVPDKIKX0DER'] },
      });
      store.markAttemptInFlight(res.attempt_id);
      store.completeAttempt(res.attempt_id, {
        payload: { asin: 'B0SYNTH888', unit_weight_lb: 12.2 },
      });
      assert.equal(store.getAttempt(res.attempt_id)?.status, 'succeeded' === store.getAttempt(res.attempt_id)?.status ? 'succeeded' : 'completed');
    } finally {
      store.close();
    }
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});

test('Round 1 (2 & 4): Bulky default merged non-SIPP fee, 6-tier Oversize + Flat/Overhang handling, Apparel & Shoes, Dangerous Goods, Low-Price ineligibles, and out-of-table lookup directive', () => {
  // Bulky defaults to non-SIPP and merges round(base * 1.035) + packaging_service_fee_usd
  const bulkyPkg = { length_in: 20.0, width_in: 12.0, height_in: 6.0, unit_weight_lb: 4.0 };
  const defaultBulky = lookupBulkyFulfillmentFee2027({
    pkg: bulkyPkg,
    price_usd: 59.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(defaultBulky.status, 'verified');
  assert.equal(defaultBulky.size_tier, 'small_bulky');
  assert.ok(defaultBulky.packaging_service_fee_usd >= 1.51);
  assert.equal(
    Number((defaultBulky.fulfillment_with_fuel_usd + defaultBulky.packaging_service_fee_usd).toFixed(10)),
    defaultBulky.total_usd,
  );

  // Explicit is_sipp: true or requires_amazon_packaging: false omits non-SIPP packaging fee
  const sippBulky = lookupBulkyFulfillmentFee2027({
    pkg: bulkyPkg,
    price_usd: 59.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
    is_sipp: true,
  });
  assert.equal(sippBulky.packaging_service_fee_usd, 0);
  assert.equal(sippBulky.total_usd, defaultBulky.fulfillment_with_fuel_usd);

  // 6-tier Oversize + Flat Product ($8.40 on small_oversize) & Overhang ($3.45 on long_oversize), $0 placement, $26.33+ returns
  const flatOversizePkg = { length_in: 62.0, width_in: 28.0, height_in: 3.0, unit_weight_lb: 20.0 };
  const flatFul = lookupOversizeFulfillmentFee2027({
    pkg: flatOversizePkg,
    price_usd: 129.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(flatFul.status, 'verified');
  assert.equal(flatFul.size_tier, 'small_oversize');
  assert.equal(flatFul.flat_product_handling_fee_usd, 8.40);
  const overhangCheck = lookupOversizeHandlingFees2027(
    { length_in: 98.0, width_in: 44.0, height_in: 4.5, unit_weight_lb: 40.0 },
  );
  assert.equal(overhangCheck.status, 'verified');
  assert.ok(overhangCheck.overhang_handling_fee_usd > 0);

  const osPlc = lookupUnifiedPlacementFee2027({ pkg: flatOversizePkg });
  assert.equal(osPlc.status, 'verified');
  assert.equal(osPlc.selected_usd, 0);

  const osRet = lookupUnifiedReturnsProcessing2027({
    pkg: flatOversizePkg,
    physical_return_fraction: 0.12,
    fee_category: 'Home and Kitchen',
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(osRet.status, 'verified');
  assert.ok((osRet.per_return_fee_usd ?? osRet.rate_per_excess_return_usd) > 26.33);

  // Special Heavy Oversize (>150 lb unit weight)
  const heavyCls = classifySizeTier2027({ length_in: 80, width_in: 30, height_in: 20, unit_weight_lb: 160 });
  assert.equal(heavyCls.size_tier, 'special_oversize_heavy');

  // Apparel vs Shoes distinction
  const stdGarment = { length_in: 12, width_in: 9, height_in: 2, unit_weight_lb: 0.9 };
  const appFul = lookupApparelFulfillmentFee2027({
    pkg: stdGarment,
    price_usd: 34.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  const shoeFul = lookupUnifiedFulfillmentFee2027({
    pkg: stdGarment,
    price_usd: 34.99,
    is_shoes: true,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(appFul.status, 'verified');
  assert.equal(shoeFul.status, 'verified');
  assert.ok(appFul.total_usd > shoeFul.total_usd, 'Apparel fulfillment exceeds Shoes (which uses Non-Apparel fulfillment)');
  const shoeRet = lookupUnifiedReturnsProcessing2027({
    pkg: stdGarment,
    physical_return_fraction: 0.08,
    is_shoes: true,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(shoeRet.excess_return_fraction, 0.08, 'Shoes still pay per-return Apparel & Shoes processing fee on every returned unit');
  assert.ok((shoeRet.expected_fee_per_shipped_unit_usd ?? shoeRet.expected_per_sold_unit_usd) > 0);

  // Dangerous Goods fulfillment & storage ($0.99/$0.78 off-peak, $3.63/$2.43 peak)
  const dgFul = lookupDangerousGoodsFulfillmentFee2027({
    pkg: stdGarment,
    price_usd: 34.99,
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(dgFul.status, 'verified');
  const dgStoOff = lookupDangerousGoodsStorageFee2027({
    pkg: stdGarment,
    storage_window: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  });
  const dgStoPeak = lookupDangerousGoodsStorageFee2027({
    pkg: bulkyPkg,
    storage_window: FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  });
  assert.equal(dgStoOff.rate_usd_per_cuft_month, 0.99);
  assert.equal(dgStoPeak.rate_usd_per_cuft_month, 2.43);

  // 5 categories ineligible for <$10 Low-Price FBA in 2027 pay 10_to_50 band under $10
  assert.equal(isCategoryLowPriceEligible2027('Computers'), false);
  assert.equal(isCategoryLowPriceEligible2027('Automotive and Powersports'), false);
  assert.equal(isCategoryLowPriceEligible2027('Home and Kitchen'), true);
  const compUnder10 = lookupUnifiedFulfillmentFee2027({
    pkg: { length_in: 10, width_in: 6, height_in: 1, unit_weight_lb: 0.4 },
    price_usd: 8.99,
    fee_category: 'Computers',
    sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  });
  assert.equal(compUnder10.price_band, '10_to_50');

  // Out-of-table official lookup-and-persist directive
  const directive = buildOutOfTableLookupDirective({
    fee_category: 'Fine Collectible Watches',
    reason: 'Tiered referral schedule not yet cached locally.',
  });
  assert.equal(directive.protocol_id, 'spapi_then_official_seller_central_persist_v1');
  assert.equal(directive.required_steps.length, 3);
});

test('Round 1 (5): Minor package borderline anti-false-kill (peer median anchor + <=10mm packaging_redesign_shortlist rescue vs >10mm rejection)', () => {
  // Peer median package prefers SP-API official dims and flags 1688 borderline box without splitting sub-scenarios
  const peerAnchor = computeMatchedPeerMedianPackage(
    [
      { asin: 'B0SYNPEER1', length_in: 17.4, width_in: 11.2, height_in: 7.6, unit_weight_lb: 3.8, is_sp_api_official: true },
      { asin: 'B0SYNPEER2', length_in: 17.6, width_in: 11.4, height_in: 7.7, unit_weight_lb: 3.9, is_sp_api_official: true },
    ],
    {
      supplier_nominal_pkg: { length_in: 18.2, width_in: 11.5, height_in: 7.8, unit_weight_lb: 4.0 },
    },
  );
  assert.equal(peerAnchor.median_size_tier, 'large_standard');
  assert.equal(peerAnchor.supplier_cliff_crossed, true);
  assert.match(peerAnchor.sample_warning_tag, /拿样必测彩盒压线预警/);

  // Rescue pass: height 8.30 in exceeds 8.00 in Large Standard boundary by 0.30 in (7.62 mm <= 10 mm) -> trimming <=10mm drops Small Bulky to Large Standard and lifts margin from <30% to >=30%!
  const stdRefTerms = {
    referral_fraction: 0.15,
    refund_admin_fraction: 0.20,
    refund_admin_cap_usd: 5.00,
    minimum_referral_usd: 0.30,
  };
  const rescuePass = computePackagingRedesignShortlist2027({
    pkg: { id: 'pkg-borderline-7mm', length_in: 16.5, width_in: 12.0, height_in: 8.30, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 62.0,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
    collection_rate: 0.006,
  });
  assert.equal(rescuePass.eligible, true, rescuePass.reason);
  assert.ok(rescuePass.original_margin < 0.30);
  assert.ok(rescuePass.redesigned_margin >= 0.30);
  assert.ok(rescuePass.overshoot_mm > 0 && rescuePass.overshoot_mm <= 10);
  assert.equal(rescuePass.original_size_tier, 'small_bulky');
  assert.equal(rescuePass.target_size_tier, 'large_standard');

  // Overshoot > 10 mm (8.50 in -> 12.7 mm > 10 mm) MUST be rejected!
  const rescueTooWide = computePackagingRedesignShortlist2027({
    pkg: { id: 'pkg-over-10mm', length_in: 16.5, width_in: 12.0, height_in: 8.50, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 62.0,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
    collection_rate: 0.006,
  });
  assert.equal(rescueTooWide.eligible, false);

  // Missing explicit collection_rate (no hidden 0.005 default!) or fx is rejected
  const missingCollection = computePackagingRedesignShortlist2027({
    pkg: { length_in: 16.5, width_in: 12.0, height_in: 8.30, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 62.0,
    fx_cny_per_usd: 7.2,
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    fee_category: 'Home and Kitchen',
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
  });
  assert.equal(missingCollection.eligible, false);
  assert.match(missingCollection.reason, /collection_rate/);

  // Missing explicit fx / refund / headhaul is rejected (no silent hardcoded defaults)
  const missingFx = computePackagingRedesignShortlist2027({
    pkg: { length_in: 16.5, width_in: 12.0, height_in: 8.30, unit_weight_lb: 4.2 },
    price_usd: 49.99,
    landed_domestic_cny: 158.0,
    refund_fraction: 0.04,
    referral_terms: stdRefTerms,
    headhaul_usd: 3.20,
  });
  assert.equal(missingFx.eligible, false);
  assert.match(missingFx.reason, /fx_cny_per_usd/);
});

test('Round 1 (6) & Fixes: SellerSprite monthly archive market (15 pts), r59 NEAR_30_DAYS Q31 + interval target_child_units, #17/#21 null guards, regulatory pre-screen, and serve-report CLI', async () => {
  const cand = structuredClone(synthBatch.candidates[0]);
  cand.id = 'cand-near30-archive';
  const evId = cand.evidence[0].id;

  // Monthly archive macro market structure -> full 15-pt Market group compatibility
  cand.market = ingestSellerSpriteMonthlyArchiveMarket({
    dataMonth: '202610',
    newProductRatio: 18.5,
    newProductSalesRatio: 14.2,
    commodityConcentration: 34.0,
    brandConcentration: 38.0,
    sellerConcentration: 36.0,
    amzSalesRatio: 6.4,
    sellers: 12,
    top10MedianReviews: 85,
  }, { evidence: [evId] });

  // NEAR_30_DAYS Q31 cohort with interval target_child_units (no live storefront BSR rank 1-100 required in r59!)
  const origMember = structuredClone(cand.newcomer_cohort.members[0]);
  delete origMember.current_bsr_rank;
  delete origMember.current_bsr_node;
  origMember.family_id = 'fam-new-1';
  origMember.asin = 'B0SYNNEW01';
  origMember.launch_date = '2026-09-15';
  origMember.units_30d = { value_range: [42, 48], unit: 'units', period: 'NEAR_30_DAYS', grain: 'target_child_units', evidence: [evId] };
  origMember.natural = {
    ...origMember.natural,
    period: 'latelyDay_30',
    window_days: 30,
    view_grain: 'child_asin',
    request: { isListingSearch: false, timePieceType: 'latelyDay', timePieceValue: '30' },
  };

  cand.newcomer_cohort = {
    ...cand.newcomer_cohort,
    observation_basis: 'sellersprite_near_30_days',
    observation_date: '2026-11-13',
    period: 'NEAR_30_DAYS',
    scope: 'sellersprite_near_30_days',
    grain: 'target_child_units',
    relevant_bsr_node: 'Synthetic Leaf > Subnode (888888011)',
    query_complete: true,
    evidence: [evId],
    market_reference: {
      scope: 'sellersprite_near_30_days_all_ages',
      node: 'Synthetic Leaf > Subnode (888888011)',
      period: 'NEAR_30_DAYS',
      grain: 'target_child_units',
      deduplicated: true,
      coverage_supported: true,
      evidence: [evId],
      families: [
        {
          family_id: 'fam-ref-1',
          asin: 'B0SYNREF01',
          comparability_verdict: 'comparable',
          units_30d: { value: 60, unit: 'units', period: 'NEAR_30_DAYS', grain: 'target_child_units', evidence: [evId] },
        },
        {
          family_id: 'fam-new-1',
          asin: 'B0SYNNEW01',
          comparability_verdict: 'comparable',
          units_30d: { value_range: [42, 48], unit: 'units', period: 'NEAR_30_DAYS', grain: 'target_child_units', evidence: [evId] },
        },
      ],
    },
    members: [origMember],
  };

  // r58 rejects NEAR_30_DAYS (preserving 100% historical r50-r58 strictness), while r59 scores it cleanly!
  assert.throws(() => scoreCandidate(cand, r58Profile), TypeError);

  const r59Scored = scoreCandidate(cand, r59Profile);
  for (const mId of ['new_product_count_share', 'new_product_sales_share', 'product_dispersion', 'brand_dispersion', 'seller_dispersion']) {
    assert.equal(r59Scored.items.find(i => i.id === mId).status, 'scored', `${mId} must score from SellerSprite monthly archive`);
  }
  const q31Sales = r59Scored.items.find(i => i.id === 'low_rating_sales_performance');
  const q31Nat = r59Scored.items.find(i => i.id === 'natural_visibility_development');
  assert.equal(q31Sales.status, 'scored', JSON.stringify(q31Sales));
  assert.ok(q31Sales.score_range[0] < q31Sales.score_range[1], 'Interval target_child_units produces exact score_range');
  assert.equal(q31Nat.status, 'scored', JSON.stringify(q31Nat));

  // #17 uninspected reviews -> null (never 0), #21 needs_verification -> null (never 2/2)
  const jNulls = resolveStage1QualitativeJudgments({
    evidence: [evId],
    review_judge: null,
    rights_prescreen: {
      specific_design_rights: { status: 'needs_sample_comparison', summary: '1件近似专利待拿样比对' },
      applicable_public_requirements: { status: 'needs_verification', frameworks_checked: ['USDA_APHIS_Lacey_Act'], summary: '木头拉丁学名待核实' },
    },
  });
  assert.equal(jNulls.judgments.feasible_light_differentiation.anchor, null);
  assert.equal(jNulls.judgments.specific_design_rights.anchor, null);
  assert.equal(jNulls.judgments.applicable_public_requirements.anchor, null);

  // Regulatory pre-screen: Reese's Law button battery, CPSIA, Prop 65, FDA, EPA FIFRA, and clause-scoped negation
  const buttonCellRegs = resolveRelevantRegulatoryFrameworks({
    label: 'LED Magnifier Desk Stand (includes CR2032 coin cell battery)',
  });
  assert.ok(buttonCellRegs.applicable.includes('Reeses_Law_16_CFR_1263'));
  const negatedPassiveRegs = resolveRelevantRegulatoryFrameworks({
    label: 'Solid Walnut Organizer Tray (不含纽扣电池, no battery, non-electric)',
  });
  assert.ok(!negatedPassiveRegs.applicable.includes('Reeses_Law_16_CFR_1263'));
  assert.ok(negatedPassiveRegs.applicable.some(f => /Lacey/i.test(f)));
  const foodContactRegs = resolveRelevantRegulatoryFrameworks({
    label: 'Stainless Espresso Knock Box & Food Contact Tamping Mat',
  });
  assert.ok(foodContactRegs.applicable.some(f => /FDA/i.test(f)));
  const pestClaimRegs = resolveRelevantRegulatoryFrameworks({
    label: 'Plastic Closet Blocks with Antibacterial Moth Repellent Claim',
  });
  assert.ok(pestClaimRegs.applicable.includes('EPA'));

  // Built-in `serve-report --check` local 127.0.0.1 HTTP preview command
  const dir = mkdtempSync(join(tmpdir(), 'r59-serve-report-'));
  try {
    const html = renderReport(scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [cand] }, r59Profile), { candidates: [cand] });
    writeFileSync(join(dir, 'index.html'), html, 'utf8');
    const serveRes = await runCliMem(['serve-report', '--dir', dir, '--check']);
    assert.equal(serveRes.code, 0, serveRes.stderr);
    const parsedServe = JSON.parse(serveRes.stdout);
    assert.equal(parsedServe.verified_http_status, 200);
    assert.match(parsedServe.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});

test('Round 2 (1 & 2): sample_pending_qualifying gate (85-pt core + deferred sample items null), 1688 stop rule, competition callouts, and 100-set capital reference', () => {
  const candSamplePending = structuredClone(synthBatch.candidates[0]);
  candSamplePending.id = 'cand-sample-pending-qualifying';
  candSamplePending.label = '核桃木桌面收纳架（核心齐备·待拿样问工厂）';
  const evId = candSamplePending.evidence[0].id;

  candSamplePending.market = ingestSellerSpriteMonthlyArchiveMarket({
    dataMonth: '202610',
    newProductRatio: 22.0,
    newProductSalesRatio: 16.0,
    commodityConcentration: 42.0,
    brandConcentration: 44.0,
    sellerConcentration: 45.0,
    amzSalesRatio: 54.0,
    sellers: 11,
    top10MedianReviews: 78,
  }, { evidence: [evId] });

  // Defer post-sample / supplier-inquiry items (#16, #20, #21) honestly as null WITH clean pre-screen proof
  candSamplePending.judgments.existing_solution_fit = {
    anchor: null,
    complete_set_verified: true,
    sample_check_required: true,
    reason: '1688 齐套现货已核实，英文说明书与激光件号待拿样向工厂确认',
    evidence: [evId],
  };
  candSamplePending.judgments.specific_design_rights = {
    anchor: null,
    prescreen_completed: true,
    sample_check_required: true,
    reason: '公开专利初筛无实锤侵权；1件外观号待拿实物卡槽比对',
    evidence: [evId],
  };
  candSamplePending.judgments.applicable_public_requirements = {
    anchor: null,
    prescreen_completed: true,
    sample_check_required: true,
    reason: '常规法规初筛通过；Lacey Act 树种拉丁学名待旺旺核实',
    evidence: [evId],
  };

  // Attach fx_cny_per_usd for ¥ capital display; 1st factory passes entire margin interval >= 30% -> stop immediately (second_factory_quote_needed: false)!
  const probe = scoreCandidate(structuredClone(synthBatch.candidates[0]), r59Profile);
  const baseCalc = probe.diagnostics.economics.scenarios[0].input.calculation;
  const sc0 = candSamplePending.economics.scenarios[0];
  sc0.cost_ledger.fx_cny_per_usd = 7.20;
  const proc0 = sc0.cost_ledger.lines.find(l => l.id === 'procurement');
  proc0.amount_usd = Number((baseCalc.net_revenue_usd * (1 - 0.34) - (baseCalc.net_cost_usd - proc0.amount_usd)).toFixed(4));

  // Under r58: stays pending (counts_toward_target: false)
  assert.throws(() => scoreCandidate(candSamplePending, r58Profile), TypeError);

  // Under r59: qualifies as sample_pending_qualifying (counts_toward_target: true, 91/100 covered, ranked high-to-low)!
  const r59Res = scoreCandidate(candSamplePending, r59Profile);
  assert.equal(r59Res.qualification.counts_toward_target, true, JSON.stringify(r59Res.qualification));
  assert.equal(r59Res.qualification.mode, 'sample_pending_qualifying');
  assert.equal(r59Res.covered_weight, 91);
  assert.equal(r59Res.sample_check_items.length, 3);
  assert.equal(r59Res.diagnostics.economics.second_factory_quote_needed, false, '1st factory all >=30% stops without extra 1688 queries');

  // When 1st factory crosses 30% or falls <30%, second_factory_quote_needed is true (check 2nd, at most 3rd factory)
  const candBelow = structuredClone(synthBatch.candidates[0]);
  candBelow.id = 'cand-below-30-elim';
  candBelow.economics.scenarios[0].cost_ledger.fx_cny_per_usd = 7.20;
  const procBelow = candBelow.economics.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement');
  procBelow.amount_usd = Number((baseCalc.net_revenue_usd * (1 - 0.25) - (baseCalc.net_cost_usd - procBelow.amount_usd)).toFixed(4));
  const r59Below = scoreCandidate(candBelow, r59Profile);
  assert.equal(r59Below.diagnostics.economics.second_factory_quote_needed, true);

  // Proven IP conflict (anchor: 0) MUST still hard-exclude!
  const candProvenConflict = structuredClone(candSamplePending);
  candProvenConflict.id = 'cand-proven-ip-conflict';
  candProvenConflict.judgments.specific_design_rights = {
    anchor: 0,
    proven_conflict: true,
    reason: '命中实锤同结构专利冲突',
    evidence: [evId],
  };
  const conflictRes = scoreCandidate(candProvenConflict, r59Profile);
  assert.equal(conflictRes.qualification.counts_toward_target, false);
  assert.equal(conflictRes.queue, 'excluded');

  // Bare/incomplete parts (complete_set_verified: false) MUST NEVER qualify via sample_pending_qualifying!
  const candBareParts = structuredClone(candSamplePending);
  candBareParts.id = 'cand-bare-parts';
  candBareParts.economics.scenarios[0].complete_set_verified = false;
  const bareRes = scoreCandidate(candBareParts, r59Profile);
  assert.equal(bareRes.qualification.counts_toward_target, false);

  // Render HTML report and verify Round-2 & Round-3 UI elements (including retired negotiation_shortlist in r59 + target goods CNY note on eliminated card)
  const fullQualCand = structuredClone(synthBatch.candidates[0]);
  fullQualCand.id = 'cand-full-100';
  const batchInput = {
    schema_version: 1,
    profile_revision: 59,
    negotiation_shortlist: [{ form_id: 'cand-below-30-elim', label: 'Legacy shortlist', eligible: true, required_discount_fraction: 0.05, price_usd: 49.99 }],
    candidates: [candSamplePending, fullQualCand, candBelow],
  };
  const batchScored = scoreBatch(batchInput, r59Profile);
  assert.equal(batchScored.summary.qualifying, 2);
  assert.equal(batchScored.summary.sample_pending_qualifying, 1);
  assert.equal(batchScored.negotiation_shortlist, undefined, 'r59 retires separate <=12% negotiation_shortlist');

  const html = renderReport(batchScored, batchInput);
  assert.match(html, /已得分\s*[\d.–-]+\s*\/\s*已覆盖总权重\s*91/);
  assert.match(html, /拿样／1688 问厂待核清单/);
  assert.match(html, /Top-10\s*评论中位数/);
  assert.match(html, /亚马逊自营（AMZ）销量占比/);
  assert.match(html, /自营超第三方，强烈建议放弃/);
  assert.match(html, /小蓝海仅\s*11\s*家，非巨头垄断/);
  assert.match(html, /单件落地本金（采购\s*\+\s*国内运费\s*\+\s*头程）/);
  assert.match(html, /按\s*100\s*套试算参考本金/);
  assert.doesNotMatch(html, /data-section="negotiation-shortlist"/);
  assert.match(html, /需把拿货价压到\s*¥[\d.,–-]+\s*才达标/);
});

test('Round 3 & 4 (Age Priority & Price Band): 3-tier age priority (<=90d newcomer / >=365d veteran / 91-364d growth supplement when veterans < 2), qualitative Keepa clearance, >=20% OFF heavy coupon, <10 zombie denoising, and >1.35x advisory spread', () => {
  // Qualitative AI-driven Keepa clearance flag (no private hardcoded 21d / 0.80 / 0.92 numbers!)
  assert.equal(detectKeepaVeteranClearanceOrWar({ keepa_clearance: true }), true);
  assert.equal(detectKeepaVeteranClearanceOrWar({ keepa_90d_prices: [59.99, 48.00, 36.00, 27.99] }), false);

  // Here only 1 veteran (>=365d: B0SYNVET2Y at 400d) is steady -> < 2 veterans triggers 91-364d growth supplement!
  const dated1124 = (asin, priceUsd) => makeDatedKeepaReceipt({ asin, startDate: '2026-08-27', days: 90, priceUsd }).keepa_trend;
  const pb = analyzeMainstreamPriceBand([
    { asin: 'B0SYN100D1', price_usd: 50.00, coupon: '18%', fulfillment: 'FBA', monthlySales: 120, age_days: 150, keepa_90d_median_usd: 50.00, keepa_trend: dated1124('B0SYN100D1', 50.00) }, // 91-364d growth, 18% < 20% -> net $41.00
    { asin: 'B0SYNVET2Y', price_usd: 60.00, coupon: '25%', fulfillment: 'FBA', monthlySales: 140, age_days: 400, keepa_90d_median_usd: 60.00, keepa_trend: dated1124('B0SYNVET2Y', 60.00) }, // >=365d veteran, 25% >= 20% -> Keepa $60.00
    { asin: 'B0SYNVETWR', price_usd: 26.99, fulfillment: 'FBA', monthlySales: 300, age_days: 450, keepa_clearance: true, keepa_clearance_reason_zh: '全年稳态 $58 近期清仓跳水至 $26.99' }, // AI qualitative clearance -> isolated!
    { asin: 'B0SYNYNG60', price_usd: 29.99, fulfillment: 'FBA', monthlySales: 90, age_days: 60 }, // <=90d newcomer -> newcomer_launch_band ("新品起盘参考价")
    { asin: 'B0SYNZMB05', price_usd: 19.99, fulfillment: 'FBA', monthlySales: 6, age_days: 420 }, // <10/mo zombie excluded
    { asin: 'B0SYNHIGH3', price_usd: 68.00, fulfillment: 'FBA', monthlySales: 110, age_days: 240, keepa_90d_median_usd: 68.00, keepa_trend: dated1124('B0SYNHIGH3', 68.00) }, // 91-364d growth supplement triggers >1.35x width spread vs $41.00
  ], { as_of_date: '2026-11-24', strict_mature_only: true });

  assert.equal(pb.mature_regular_band.newcomer_cutoff_days, 90);
  assert.equal(pb.mature_regular_band.veteran_cutoff_days, 365);
  assert.equal(pb.mature_regular_band.basis, 'veteran_ge_365d_plus_steady_growth_91_364d_supplement');
  assert.equal(pb.mature_regular_band.growth_supplement_used, true);
  assert.equal(pb.mature_regular_band.peer_count, 3, 'Includes 400d veteran ($60) + 2 steady growth supplements (150d $41, 240d $68)');
  assert.equal(pb.mature_regular_band.min_usd, 41.00);
  assert.equal(pb.mature_regular_band.max_usd, 68.00);
  assert.equal(pb.veteran_clearance_watch.length, 1);
  assert.equal(pb.veteran_clearance_watch[0].asin, 'B0SYNVETWR');
  assert.equal(pb.newcomer_launch_band.label_zh, '新品起盘参考价（≤90天）');
  assert.equal(pb.newcomer_launch_band.peer_count, 1);
  assert.equal(pb.newcomer_launch_band.p50_usd, 29.99);
  assert.equal(pb.observed_out_of_band_peers.some(p => p.asin === 'B0SYNVETWR'), true, 'Out-of-band peer preserved transparently');
  assert.equal(pb.observed_out_of_band_peers.some(p => p.asin === 'B0SYNYNG60'), true);
  assert.equal(pb.observed_out_of_band_peers.some(p => p.asin === 'B0SYNZMB05'), true);
  assert.equal(pb.guardrail.width_alarm, true);
  assert.equal(pb.guardrail.never_triggers_elimination, true);
});

test('Round 2 (3 & 4): Per-candidate fault isolation in raw-ingest, SP-API/browser non-blocking ledger SHA tag, stale-spec GPT-6.2 badge retention, and stripped OpenAI locks/audio-image bloat', async () => {
  // 1) Verify unused Stage-4 audio/image functions & binary parsers are completely removed from exports
  assert.equal('createSpeechBriefing' in openaiIndex, false);
  assert.equal('createConceptImage' in openaiIndex, false);
  assert.equal('createSpeechBriefing' in openaiClientMod, false);
  assert.equal('createConceptImage' in openaiClientMod, false);
  assert.equal('computeTtsCostMicros' in openaiPricingMod, false);

  // 2) Verify OpenAI budget ledger creates ZERO ~/.local-selection-openai-ledger-registry.sqlite and never locks out on DELETE failure
  const homeLockPath = join(homedir(), '.local-selection-openai-ledger-registry.sqlite');
  const existedBefore = existsSync(homeLockPath);
  const dir = mkdtempSync(join(tmpdir(), 'r59-round2-suite-'));
  try {
    const dbPath = join(dir, 'selection.sqlite');
    const fileLedger = openOpenAiBudgetLedger(dbPath, { readOnly: false });
    fileLedger.close();
    if (!existedBefore) {
      assert.equal(existsSync(homeLockPath), false, 'Must NEVER create hidden home-directory inode registry SQLite');
    }

    const ledger = new OpenAiBudgetLedger(':memory:', {
      nowFn: () => new Date('2026-11-15T12:00:00Z'),
    });
    try {
      reconcileLegacyBudgetIntoStore(
        ledger,
        {
          recognized_schema: true,
          file_sha256: '0'.repeat(64),
          month_utc: '2026-11',
          total_rows: 0,
          status_counts: {},
          unresolved_count: 0,
          blocking_reasons: [],
          has_unresolved_holds: false,
          same_month_reserved_cents: 0,
        },
        {
          accountScope: 'openai-default',
          enable: true,
          autoRechargeOffConfirmed: true,
          hardMonthlyLimitConfirmed: true,
          monthlyLimitCents: 20_000,
        },
      );
      const res1 = ledger.reserveBillableRequest({
        logicalRequestId: 'req-del-fail-1',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: 'a'.repeat(64),
      });
      ledger.recordTerminalOutcome(res1.attempt_id, {
        status: 'completed',
        providerResponseId: 'resp_synth_del_1',
        usage: { input_tokens: 1000, output_tokens: 200 },
        usageCostMicros: 5_000,
        rawReceipt: { id: 'resp_synth_del_1', status: 'completed' },
        cleanupRequired: true,
      });
      ledger.updateCleanupStatus(res1.attempt_id, {
        cleanupStatus: 'delete_failed',
        reason: 'Simulated HTTP 502 on DELETE',
      });
      const summaryAfterDelFail = ledger.getMonthlySummary();
      assert.equal(summaryAfterDelFail.fenced, false, 'Remote DELETE cleanup failure must NEVER lock out the account');
      const res2 = ledger.reserveBillableRequest({
        logicalRequestId: 'req-after-del-fail-2',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: 'b'.repeat(64),
      });
      assert.equal(res2.status, 'in_progress');
    } finally {
      ledger.close();
    }

    // 3) Per-candidate fault isolation in ingestTrialSpecification + non-blocking ledger SHA tag
    const store = openSelectionStore(dbPath);
    const goodCand = structuredClone(synthBatch.candidates[0]);
    goodCand.id = 'form-good-sibling';
    goodCand.screening.reference_price_usd.target_variant_asin = 'B000000099';
    goodCand.economics.scenarios[0].quote_id = 'q1688-good-1';
    const expiredCand = structuredClone(synthBatch.candidates[0]);
    expiredCand.id = 'form-expired-sibling';
    expiredCand.screening.reference_price_usd.target_variant_asin = 'B000000099';
    expiredCand.economics.scenarios[0].quote_id = 'q1688-expired-1';

    const expSc = expiredCand.economics.scenarios[0];
    const expProcUsd = expSc.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd;
    const expDomUsd = expSc.cost_ledger.lines.find(l => l.id === 'domestic_freight').amount_usd;
    const expUnitCny = Number((expProcUsd * 7.2).toFixed(4));
    const expDomTotalCny = Number((expDomUsd * 7.2 * 100).toFixed(4));

    try {
      store.upsertCandidateForm({
        form_id: 'form-good-sibling',
        product_family_key: 'form-good-sibling',
        label: 'Good Sibling',
        buyer_task: 'Organize desk',
        saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
      });
      store.upsertCandidateForm({
        form_id: 'form-expired-sibling',
        product_family_key: 'form-expired-sibling',
        label: 'Expired Sibling',
        buyer_task: 'Organize desk',
        saleable_set_composition: [{ component_id: 'item', qty_per_saleable_set: 1 }],
      });
      store.recordSourcingQuote1688({
        quote_id: 'q1688-good-1',
        form_id: 'form-good-sibling',
        spec_version: 1,
        observed_at: '2026-11-20T10:00:00Z',
        expires_at: '2026-12-31',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-good-1',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        fx_cny_per_usd: 7.2,
        sku_lines: [{
          component_id: 'item',
          offer_id: 'off-good',
          sku_id: 'sku-good',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 10,
          ordered_qty: 100,
          unit_price_cny: expUnitCny,
          regular_goods_promo_false: true,
        }],
        goods_cny_total: Number((expUnitCny * 100).toFixed(4)),
        domestic_freight_cny_total: expDomTotalCny,
        ui_readback: {
          logged_in: true,
          viewport_width_px: 1440,
          selected_sku_row_visible: true,
          settlement_bar_visible: true,
          applied_quantity_confirmed: true,
        },
      });
      store.recordSourcingQuote1688({
        quote_id: 'q1688-expired-1',
        form_id: 'form-expired-sibling',
        spec_version: 1,
        observed_at: '2026-10-01T10:00:00Z',
        expires_at: '2026-10-15',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-exp-1',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        fx_cny_per_usd: 7.2,
        sku_lines: [{
          component_id: 'item',
          offer_id: 'off-exp',
          sku_id: 'sku-exp',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 10,
          ordered_qty: 100,
          unit_price_cny: expUnitCny,
          regular_goods_promo_false: true,
        }],
        goods_cny_total: Number((expUnitCny * 100).toFixed(4)),
        domestic_freight_cny_total: expDomTotalCny,
        ui_readback: {
          logged_in: true,
          viewport_width_px: 1440,
          selected_sku_row_visible: true,
          settlement_bar_visible: true,
          applied_quantity_confirmed: true,
        },
      });
    } finally {
      store.close();
    }

    const browserReceiptPath = join(dir, 'sp-api-or-browser-receipt.json');
    const goodRefPrice = goodCand.screening.reference_price_usd.value;
    writeFileSync(browserReceiptPath, JSON.stringify({
      asin: 'B000000099',
      price: goodRefPrice,
      items: [{ asin: 'B000000099', price: goodRefPrice, monthlySales: 180 }],
    }, null, 2), 'utf8');

    const ingestOut = ingestTrialSpecification({
      profile_revision: 59,
      allow_synthetic_fixture_ids: true,
      as_of_date: '2026-11-24',
      raw_receipt_files: [browserReceiptPath],
      candidates: [
        { candidate: goodCand, raw_receipt_files: [browserReceiptPath] },
        { candidate: expiredCand, raw_receipt_files: [browserReceiptPath] },
      ],
    }, r59Profile, {
      baseDir: dir,
      ledgerDbPath: dbPath,
    });
    assert.equal(ingestOut.ledger_provenance_verified, false, 'Unlogged SP-API/browser receipt tagged honestly without throwing');
    assert.equal(ingestOut.isolated_candidates.length, 1);
    assert.equal(ingestOut.isolated_candidates[0].candidate_id, 'form-expired-sibling');
    const scoredGood = ingestOut.scored.candidates.find(c => c.candidate_id === 'form-good-sibling');
    const scoredExp = ingestOut.scored.candidates.find(c => c.candidate_id === 'form-expired-sibling');
    assert.equal(scoredGood.qualification.counts_toward_target, true, 'Healthy sibling qualifies despite expired sibling in same batch');
    assert.equal(scoredExp.qualification.counts_toward_target, false);
    assert.equal(scoredExp.queue, 'pending');

    // 4) Unshackled GPT-6.2 Astra args (inherits ~/.codex/config.toml directly, --ephemeral + live web_search, no -s read-only / --ignore-rules / --ignore-user-config / mcp_servers={}) + stale-spec amber badge retention
    const args = buildCodexExecArgs({
      schemaPath: join(dir, 'schema.json'),
      outputPath: join(dir, 'out.json'),
      model: 'gpt-6.2-astra',
      reasoningEffort: 'max',
      serviceTier: 'ultrafast',
      platform: 'win32',
    });
    assert.equal(args.includes('--ephemeral'), true);
    assert.equal(args.includes('-s'), false);
    assert.equal(args.includes('--ignore-rules'), false);
    assert.equal(args.includes('--ignore-user-config'), false);
    assert.equal(args.some(a => a.includes('windows.sandbox')), false);
    assert.equal(args.some(a => a.includes('mcp_servers=')), false);
    assert.ok(args.some(a => a.includes('service_tier="ultrafast"')));
    assert.ok(args.some(a => a.includes('web_search="live"')));
    assert.equal(args.some(a => /shell_tool=false|tools\.view_image=false/.test(a)), false);

    const receiptDir = join(dir, 'codex-receipts');
    const rawPkt = {
      schema_version: 'evidence-review-draft-v1',
      review_id: 'rev-stale-spec-demo',
      execution_policy_ref: 'local-authorized-policy',
      candidate: {
        subject_id: 'form-good-sibling',
        intended_use: 'Organize desk stationery',
        saleable_spec: { pcs: 1 },
        unknown_fields: [],
      },
      subjects: [{ subject_id: 'sub-peer-1', spec: { pcs: 1 } }],
      criteria: { criteria_version: 'r59-v1', rules: [{ criterion_id: 'c1', description: 'Spec match', required: true }] },
      questions: [{ question_id: 'q1', question: 'Does peer match?', subject_ids: ['sub-peer-1'], criterion_ids: ['c1'] }],
      evidence: [{ evidence_id: 'ev1', subject_ids: ['sub-peer-1'], summary: 'Verified 100-set Shenzhen quote', kind: 'fact', source_ref: 's1', observed_at: '2026-11-22', window: '2026-10-24..2026-11-22', grain: 'sku', units: 'pc', limitations: null }],
    };
    const frozenPkt = freezeEvidenceReviewPacket(rawPkt);

    const oldSpecSha = '1'.repeat(64);
    const newSpecSha = '2'.repeat(64);
    const reviewEnv = await runCodexEvidenceReview(rawPkt, {
      enabled: true,
      reasoningEffort: 'max',
      serviceTier: 'ultrafast',
      candidateId: 'form-good-sibling',
      formSpecSha256: oldSpecSha,
      receiptDir,
      testMode: true,
      mockExecutor: async ({ outputFilePath }) => {
        writeFileSync(outputFilePath, JSON.stringify({
          schema_version: 'evidence-review-draft-v1',
          review_id: 'rev-stale-spec-demo',
          packet_sha256: frozenPkt.packet_sha256,
          subjects: [{ subject_id: 'sub-peer-1', disposition: 'included', criterion_ids: ['c1'], evidence_ids: ['ev1'], reason: 'Matches spec.' }],
          answers: [{ question_id: 'q1', status: 'answered', basis: 'fact', evidence_ids: ['ev1'], explanation: 'Supported.' }],
          contradictions: [],
          gaps: [],
          conclusion: 'Checked files via read-only tools; assumptions hold.',
        }), 'utf8');
        return {
          exitCode: 0,
          stderr: 'tool_call: read_file("src/fba-rates-2027.mjs")\n',
        };
      },
    });
    assert.equal(reviewEnv.status, 'ready', `reason=${reviewEnv.reason}`);
    assert.ok(typeof reviewEnv.reviewed_at === 'string' && reviewEnv.reviewed_at.length > 0);
    assert.equal(reviewEnv.spec_sha256, oldSpecSha);

    const staleCheck = verifySavedCodexReceipt(reviewEnv, {
      receiptStoreDir: receiptDir,
      allowTestDouble: true,
      allowStaleSpec: true,
      expectedCandidateId: 'form-good-sibling',
      expectedFormSpecSha256: newSpecSha,
    });
    assert.equal(staleCheck.verified, true);
    assert.equal(staleCheck.stale_spec, true);

    const candWithStaleReview = structuredClone(goodCand);
    candWithStaleReview.spec_sha256 = oldSpecSha;
    attachCandidateEvidenceReview(candWithStaleReview, reviewEnv, frozenPkt, {
      receiptStoreDir: receiptDir,
      allowTestDoubleReceipt: true,
    });
    // Now simulate a subsequent parameter/rate update changing spec_sha256 -> renders amber "已复核 · 基于旧版参数复核"!
    candWithStaleReview.spec_sha256 = newSpecSha;
    const batchStale = { schema_version: 1, profile_revision: 59, candidates: [candWithStaleReview] };
    const htmlStale = renderReport(scoreBatch(batchStale, r59Profile), batchStale, {
      receiptStoreDir: receiptDir,
      allowTestDoubleReceipts: true,
    });
    assert.match(htmlStale, /已复核 · 基于旧版参数复核/);
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});

test('Round 4 & Unshackled Codex Closure: 3-tier age priority + all-<90d blue ocean + parent dedup, MarketObservationJudge anti-hallucination, CHILDRENS_RE adult exemptions, #17 1/1 & 0.5/1, Coupon $50 list-price tier + $5+2.5%, Freight A4 margin, superseded_uncompetitive + single-factory kit, prohibitedThreshold=0.7, 0..5 Wangwang, Gate-4 qualifying-only, and runCodexExecMarkdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-round4-closure-'));
  try {
    // 1) 3-tier age priority when >= 2 veterans (>= 365d) exist + parent_asin deduplication before P25-P75 + all-<=90d ultra-new blue ocean!
    const dated1124 = (asin, priceUsd) => makeDatedKeepaReceipt({ asin, startDate: '2026-08-27', days: 90, priceUsd }).keepa_trend;
    const pbVetPriority = analyzeMainstreamPriceBand([
      { asin: 'B0SYNVETA1', parent_asin: 'P0SYNVETAA', price_usd: 48.00, fulfillment: 'FBA', monthlySales: 200, age_days: 420, keepa_trend: dated1124('B0SYNVETA1', 48.00) },
      { asin: 'B0SYNVETA2', parent_asin: 'P0SYNVETAA', price_usd: 48.00, fulfillment: 'FBA', monthlySales: 200, age_days: 420, keepa_trend: dated1124('B0SYNVETA2', 48.00) }, // duplicate child of same parent -> deduplicated!
      { asin: 'B0SYNVETB1', parent_asin: 'P0SYNVETBB', price_usd: 56.00, fulfillment: 'FBA', monthlySales: 180, age_days: 510, keepa_trend: dated1124('B0SYNVETB1', 56.00) },
      { asin: 'B0SYNGRW18', parent_asin: 'P0SYNGRW18', price_usd: 34.99, fulfillment: 'FBA', monthlySales: 150, age_days: 180, keepa_trend: dated1124('B0SYNGRW18', 34.99) }, // 91-364d growth NOT needed since veterans >= 2!
    ], { as_of_date: '2026-11-24', strict_mature_only: true });
    assert.equal(pbVetPriority.mature_regular_band.basis, 'veteran_ge_365d_keepa_steady');
    assert.equal(pbVetPriority.mature_regular_band.peer_count, 2, 'Deduplicated parent P0SYNVETAA + P0SYNVETBB = 2 veterans');
    assert.equal(pbVetPriority.mature_regular_band.growth_supplement_used, false);
    assert.equal(pbVetPriority.mature_regular_band.min_usd, 48.00);
    assert.equal(pbVetPriority.observed_out_of_band_peers.some(p => p.asin === 'B0SYNGRW18'), true, 'Unused growth peer preserved in observation bar');

    const pbBlueOcean = analyzeMainstreamPriceBand([
      { asin: 'B0SYNNEW01', price_usd: 42.99, coupon: '10%', fulfillment: 'FBA', monthlySales: 160, age_days: 35 }, // net $38.69 (<20% routine coupon)
      { asin: 'B0SYNNEW02', price_usd: 59.99, coupon: '25%', fulfillment: 'FBA', monthlySales: 120, age_days: 55 }, // >=20% heavy coupon -> uses list $59.99
    ], { as_of_date: '2026-11-24', strict_mature_only: true });
    assert.equal(pbBlueOcean.mature_regular_band.all_under_90d_blue_ocean, true);
    assert.equal(pbBlueOcean.mature_regular_band.top_amber_banner_zh, '全员 90 天内新品蓝海，暂无一年期老品稳态价');
    assert.equal(pbBlueOcean.mature_regular_band.peer_count, 1, 'Excludes >=20% heavy-coupon newcomer and prices reference band from regular <20% newcomer ($38.69)');
    assert.equal(pbBlueOcean.mature_regular_band.min_usd, 38.69);
    assert.equal(pbBlueOcean.mature_regular_band.max_usd, 38.69);

    // Gate 1A NEVER blocks on ultra-new blue ocean or single-peer niche in r59!
    const stGate = openSelectionStore(':memory:');
    stGate.upsertCandidateForm({ form_id: 'form-blue-ocean', label: 'Adult Acrylic Stand', buyer_task: 'Hold vinyl records', saleable_set_composition: { qty: 1 } });
    const g1aBlue = runGate1AForForm(stGate, {
      form_id: 'form-blue-ocean',
      price_band_analysis: pbBlueOcean,
      scenarios: [{
        id: 'sc-blue',
        price_usd: 42.99,
        ongoing_coupon_pct: 0.10,
        pkg: { length_in: 12, width_in: 9, height_in: 3, weight_lb: 1.8 },
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.5,
        collection_rate: 0.006,
      }],
    });
    assert.equal(g1aBlue.proceed_to_gate1b, true);

    // 2) Fact-first MarketObservationJudge (gpt-6.1-terra xhigh): verbatim mandatory_facts cross-check blocks hallucination!
    const mktInput = {
      form_id: 'form-walnut-knockbox',
      buyer_task: 'Knock spent espresso puck cleanly',
      target_spec: { label: 'Walnut Espresso Knock Box', pieces: 1 },
      peers: [{
        asin: 'B0SYNMKT01',
        observed_price_usd: 59.99,
        keepa_high_usd: 64.99,
        keepa_low_usd: 29.99,
        review_count: 84,
        review_curve_change: 'Steady +4/mo',
        key_appearance_and_dims: 'Walnut 24x23x9 cm',
      }],
    };
    const mktReq = buildMarketObservationRequest(mktInput);
    assert.equal(mktReq.model, 'gpt-6.1-terra');
    assert.equal(mktReq.reasoning.effort, 'xhigh');

    // Hallucinated keepa_high_usd ($99.99 != $64.99) MUST fail validation!
    assert.throws(() => parseMarketObservationResult({
      schema_version: 1,
      contract: 'MarketObservationJudge',
      form_id: 'form-walnut-knockbox',
      peer_observations: [{
        asin: 'B0SYNMKT01',
        mandatory_facts: {
          observed_price_usd: 59.99,
          keepa_high_usd: 99.99, // fabricated!
          keepa_low_usd: 29.99,
          review_count: 84,
          keepa_90d_trend: 'Dropped from $64.99 to $29.99 clearance',
          coupon_status: 'none',
          review_curve_change: 'Steady +4/mo',
          key_appearance_and_dims: 'Walnut 24x23x9 cm',
        },
        qualitative_judgment: {
          bucket: 'veteran_clearance_or_war',
          include_in_primary_band: false,
          keep_in_observation_bar: true,
          reason_zh: '老品清仓跳水，移出主力带保留观察。',
        },
      }],
      market_summary_zh: '主力老品稳态，1 款清仓跳水单列观察。',
    }, mktInput), /keepa_high_usd/i);

    const validMktJudge = parseMarketObservationResult({
      schema_version: 1,
      contract: 'MarketObservationJudge',
      form_id: 'form-walnut-knockbox',
      peer_observations: [{
        asin: 'B0SYNMKT01',
        mandatory_facts: {
          observed_price_usd: 59.99,
          keepa_high_usd: 64.99,
          keepa_low_usd: 29.99,
          review_count: 84,
          keepa_90d_trend: 'Dropped from $64.99 to $29.99 clearance',
          coupon_status: 'none',
          review_curve_change: 'Steady +4/mo',
          key_appearance_and_dims: 'Walnut 24x23x9 cm',
        },
        qualitative_judgment: {
          bucket: 'veteran_clearance_or_war',
          include_in_primary_band: false,
          keep_in_observation_bar: true,
          reason_zh: '老品清仓跳水，移出主力带保留观察。',
        },
      }],
      market_summary_zh: '主力老品稳态，1 款清仓跳水单列观察。',
    }, mktInput);
    assert.equal(validMktJudge.peer_observations[0].qualitative_judgment.bucket, 'veteran_clearance_or_war');

    // 3) Gate-0 CHILDRENS_RE CPSC <= 12 yrs + adult color/warning exemptions ("baby blue", "NOT for children", "keep away from kids")
    assert.equal(evaluateGate0CategoryBoundary({ title: 'Baby Blue Anodized Aluminum Router Jig - Keep away from kids, NOT for children' }).hard_exclusion, false);
    assert.equal(evaluateGate0CategoryBoundary({ title: 'Montessori Toddler Wooden Climbing Arch for Kids Ages 3-8' }).hard_exclusion, true);
    // Soft guidance in r59: apparel/furniture do NOT hard-kill unless children's!
    assert.equal(evaluateGate0CategoryBoundary({ title: 'Heavy Canvas Workshop Apron', root_category: 'Clothing, Shoes & Jewelry' }).hard_exclusion, false);

    // 4) Bug fix #17 feasible_light_differentiation: strong -> 1/1, moderate -> 0.5/1 (and #4 rejects single_color_child_median)!
    const jStrong = resolveStage1QualitativeJudgments({
      review_judge: {
        status: 'supported',
        support_level: 'strong',
        reason: 'SKU-verified 1-star reviews confirm loose brass thumbscrew.',
        evidence_refs: ['ev-rev-1'],
        review_citations: [{ review_id: 'R1', sku_verified: true }],
      },
    });
    assert.equal(jStrong.judgments.feasible_light_differentiation.anchor, 1);
    const jMod = resolveStage1QualitativeJudgments({
      review_judge: {
        status: 'supported',
        support_level: 'moderate',
        reason: 'SKU-verified reviews suggest thicker felt pad.',
        evidence_refs: ['ev-rev-2'],
        review_citations: [{ review_id: 'R2', sku_verified: true }],
      },
    });
    assert.equal(jMod.judgments.feasible_light_differentiation.anchor, 0.5);

    const badChildScaleCand = structuredClone(synthBatch.candidates[0]);
    badChildScaleCand.metrics.purchase_demand_scale.scope = 'single_color_child_median';
    const scoredBadChildScale = scoreCandidate(badChildScaleCand, r59Profile);
    assert.equal(scoredBadChildScale.items.find(i => i.id === 'purchase_demand_scale').score, null, '#4 must reject single_color_child_median');

    // 5) Ongoing Coupon真实账: $50.00 FBA tier judged by LIST PRICE ($54.99 list - $10 coupon = $44.99 net -> over_50 FBA tier + $5/100 + 2.5% coupon fee)!
    const couponEst = estimateGate1A2027({
      profile_revision: 59,
      list_price_usd: 54.99,
      ongoing_coupon_usd: 10.00,
      pkg: { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 },
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      headhaul_usd: 2.2,
      collection_rate: 0.006,
    });
    assert.equal(couponEst.status, 'verified');
    assert.equal(couponEst.price_usd, 44.99);
    assert.equal(couponEst.price_band, 'over_50', '$54.99 list price stays on over_50 FBA tier even when coupon lowers net to $44.99');
    assert.ok(couponEst.components.coupon_fee.per_unit_usd > 1.15, '$5/100 ($0.05) + 2.5% * $44.99 ($1.1248) = ~$1.1748/unit coupon fee');

    // 6) Freight A4 (<10kg min billable, <50kg small-shipment surcharge, <8kg/carton surcharge, volumetric) wired into early-screen & economics!
    const a4Spec = {
      actual_weight_kg_per_unit: 0.06, // 100 units = 6 kg < 10 kg min billable!
      min_shipment_billable_kg: 10,
      small_shipment_threshold_kg: 50,
      small_shipment_surcharge_cny_per_kg: 10,
      weight_per_carton_kg: 6, // < 8 kg/carton!
      carton_count: 1,
      small_carton_surcharge_cny_per_carton: 20,
      rate_cny_per_kg: 12,
      surcharge_cny_per_kg: 1,
      bond_cny_per_shipment: 150,
    };
    const esA4 = evaluateEarlyScreen({
      saleable_unit: '1 light acrylic rack',
      price_usd: 49.99,
      fx_cny_per_usd: 7.2,
      order_units: 100,
      goods_cny_per_unit: 45,
      domestic_freight_cny_total: 150,
      first_order_promotion: false,
      headhaul: a4Spec,
      refund_fraction: 0.04,
      return_threshold: 0.081,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      fulfillment_usd: 5.50,
      placement_usd: 0.40,
      storage: { cubic_feet_per_unit: 0.1, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      collection_rate: 0.006,
      other_applicable_usd: 0,
    });
    // 10 kg billable * (12 + 1 + 10 small-shipment) = 230 CNY + 20 underweight carton + 150 bond = 400 CNY total / 100 = 4.00 CNY/unit ($0.5556)
    const hhLineA4 = esA4.ledger.lines.find(l => l.id === 'headhaul');
    assert.ok(Math.abs(hhLineA4.amount_usd - (4.00 / 7.2)) < 1e-4, `Expected A4 headhaul $0.5556, got ${hhLineA4.amount_usd}`);

    const econLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    econLedger.fx_cny_per_usd = 7.2;
    const econHh = econLedger.lines.find(l => l.id === 'headhaul');
    econHh.amount_usd = 0.56;
    econHh.cny_derivation = { fx: 7.2, order_units: 100, ...a4Spec };
    const econOut = calculateEconomics(econLedger, { profileRevision: 59 });
    assert.ok(Math.abs(econOut.lines.find(l => l.id === 'headhaul').amount_usd - (4.00 / 7.2)) < 1e-6);

    // 7) 1688 superseded_uncompetitive archival + incomplete_cross_factory_kit + expires_at === null!
    const uiOk = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    stGate.upsertCandidateForm({ form_id: 'form-1688-supersede', label: 'Walnut Tray', buyer_task: 'Serve espresso', saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }] });
    runGate1AForForm(stGate, {
      form_id: 'form-1688-supersede',
      scenarios: [{
        id: 'sc-tray',
        price_usd: 49.99,
        pkg: { length_in: 12, width_in: 8, height_in: 2, weight_lb: 1.5 },
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 2.2,
        collection_rate: 0.006,
      }],
    });
    const qExpensive = stGate.recordSourcingQuote1688({
      quote_id: 'q-expensive-first',
      form_id: 'form-1688-supersede',
      spec_variant_key: 'walnut-24cm-fullkit',
      observed_at: '2026-11-24',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-q-exp',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      ui_readback: uiOk,
      sku_lines: [{ component_id: 'tray', offer_id: 'off-expensive', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 165, regular_goods_promo_false: true }],
      goods_cny_total: 16500,
      domestic_freight_cny_total: 200,
    }).quote;
    assert.equal(qExpensive.expires_at, null, 'Quotes keep expires_at: null with zero 30-day expiry nag');

    const qCheaper = stGate.recordSourcingQuote1688({
      quote_id: 'q-cheaper-second',
      form_id: 'form-1688-supersede',
      spec_variant_key: 'walnut-24cm-fullkit',
      observed_at: '2026-11-24',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-q-cheap',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      ui_readback: uiOk,
      sku_lines: [{ component_id: 'tray', offer_id: 'off-cheaper', sku_id: 's2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 72, regular_goods_promo_false: true }],
      goods_cny_total: 7200,
      domestic_freight_cny_total: 180,
    }).quote;
    const allQuotes = stGate.getQuotesForForm('form-1688-supersede');
    assert.equal(allQuotes.find(q => q.quote_id === 'q-expensive-first').quote_status, 'superseded_uncompetitive');
    assert.equal(allQuotes.find(q => q.quote_id === 'q-cheaper-second').quote_status, 'verified');

    // Cross-factory bare part + separate box factory is automatically flagged incomplete_cross_factory_kit!
    stGate.upsertCandidateForm({
      form_id: 'form-cross-factory',
      label: '2-Part Set',
      buyer_task: 'Hold rack',
      saleable_set_composition: [
        { component_id: 'rack', qty_per_saleable_set: 1 },
        { component_id: 'velvet_bag', qty_per_saleable_set: 1 },
      ],
    });
    const crossKit = stGate.recordSourcingQuote1688({
      quote_id: 'q-cross-factory',
      form_id: 'form-cross-factory',
      observed_at: '2026-11-24',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-cross',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      ui_readback: uiOk,
      sku_lines: [
        { component_id: 'rack', factory_id: 'factory-A', offer_id: 'offer-A', sku_id: 'sA', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 50, regular_goods_promo_false: true },
        { component_id: 'velvet_bag', factory_id: 'factory-B', offer_id: 'offer-B', sku_id: 'sB', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 10, regular_goods_promo_false: true },
      ],
      goods_cny_total: 6000,
      domestic_freight_cny_total: 200,
    }).quote;
    assert.equal(crossKit.quote_status, 'incomplete_cross_factory_kit');
    void qCheaper;
    stGate.close();

    // 8) Luna /v1/decisions prohibitedThreshold = 0.7 (0.60 -> amber_manual_review, 0.75 -> prohibited), 0..5 Wangwang questions, RightsPrescreen no duty dig!
    const lunaCands = [
      { candidate_id: 'C-MID-060', title: 'Borderline Insulated Bottle', price_usd: 35.99 },
      { candidate_id: 'C-HIGH-075', title: 'Prescription Medical Inhaler', price_usd: 39.99 },
    ];
    const parsedLuna = parseStage1DecisionsResponses(lunaCands, [{
      status: 'completed',
      usable: true,
      content_status: 'usable',
      decisions: [
        { id: 'gate0_prohibited_C-MID-060', type: 'predicate', probability: 0.60 },
        { id: 'visual_peer_C-MID-060', type: 'choice', value: 'exact_peer' },
        { id: 'gate0_prohibited_C-HIGH-075', type: 'predicate', probability: 0.75 },
        { id: 'visual_peer_C-HIGH-075', type: 'choice', value: 'exact_peer' },
      ],
    }]);
    assert.equal(parsedLuna.items[0].gate0_status, 'allowed');
    assert.equal(parsedLuna.items[0].gate0_review_watch, true);
    assert.equal(parsedLuna.items[0].triage_disposition, 'amber_manual_review');
    assert.equal(parsedLuna.items[1].gate0_status, 'prohibited');
    assert.equal(parsedLuna.items[1].triage_disposition, 'prohibited_auto_excluded');

    const zeroGap1688 = parse1688VisionInspectResult({
      schema_version: 1,
      contract: 'VisionInspector1688',
      spec_match_verdict: 'exact_match',
      dimension_weight_findings: {
        product_dimensions_mm: '240x230x90',
        package_dimensions_mm: '260x250x110',
        unit_weight_g: 1950,
        package_weight_g: 2100,
        carton_pack_qty: 6,
        evidence_notes: 'CAD callout on Thumbnail 4 confirms walnut + 304 liner.',
      },
      sensitive_freebie_flags: {
        oil_or_glue: 'none',
        battery_type: 'none',
        strong_magnet: 'none',
        notes: 'No sensitive freebies.',
      },
      component_gaps: [],
      wangwang_questions: [], // 0 questions allowed when complete!
    });
    assert.deepEqual(zeroGap1688.wangwang_questions, []);

    const rightsReq = buildRightsPreScreenRequest({
      form_id: 'form-walnut-tray',
      label: 'Walnut Espresso Knock Box',
      buyer_task: 'Knock espresso puck',
    });
    assert.match(rightsReq.input[0].content[0].text, /trade_duty_alerts.*deferred|do NOT spend extra web_search/i);

    // 9) Historical wired fields (niche_average_star_reference, dual-source keyword_counts, Q31 Vine/VP/直评, lab fee note) & Gate-4 qualifying-only guard!
    const starRef = extractNicheAverageStarReference([
      { asin: 'B0SYNSTAR1', parent_asin: 'P0STAR1', rating: 4.4, monthlySales: 100 },
      { asin: 'B0SYNSTAR2', parent_asin: 'P0STAR2', rating: 4.6, monthlySales: 200 },
    ]);
    assert.equal(starRef.value, 4.5);

    const kwCounts = extractQ31DualSourceKeywordCounts({
      sellerspriteRaw: { organic: 52, ad: 16 },
      sifRaw: { organic: 31, ad: 11 },
    });
    assert.deepEqual(kwCounts, {
      sellersprite: { organic: 52, ad: 16 },
      sif: { organic: 31, ad: 11 },
    });

    const q31VineCand = structuredClone(synthBatch.candidates[0]);
    q31VineCand.one_time_compliance_fee_usd = 350;
    Object.assign(q31VineCand.newcomer_cohort.members[0], {
      vine_reviews: 12,
      vp_reviews: 5,
      non_vp_direct_reviews: 1,
    });
    const vineBatch = { schema_version: 1, profile_revision: 59, candidates: [q31VineCand] };
    const vineHtml = renderReport(scoreBatch(vineBatch, r59Profile), vineBatch);
    assert.match(vineHtml, /Vine\s*12/);
    assert.match(vineHtml, /VP\s*5/);
    assert.match(vineHtml, /直评\s*1/);
    assert.match(vineHtml, /一次性实验室／合规检测费提醒/);
    assert.match(vineHtml, /不摊入单件毛利/);

    // Gate-4 skips non-qualifying cards immediately without spawning Codex!
    const nonQualSkip = await runOptionalGate4EvidenceReview(
      { review_id: 'rev-skip-nonqual', execution_policy_ref: 'local-authorized-policy' },
      {
        enabled: true,
        candidateQualification: { counts_toward_target: false },
        testMode: true,
        mockExecutor: async () => { throw new Error('Must NOT run Gate-4 on non-qualifying card'); },
      },
    );
    assert.equal(nonQualSkip.status, 'skipped_non_qualifying');
    assert.equal(nonQualSkip.execution_status, 'not_submitted');

    // 10) Unshackled free-form Markdown Codex review (`runCodexExecMarkdown`) + "目标 + 验收标准 + 两条边界 + 自由发挥" prompt!
    const promptPreview = buildEvidenceReviewPrompt(
      freezeEvidenceReviewPacket({
        schema_version: 'evidence-review-draft-v1',
        review_id: 'rev-prompt-preview',
        candidate: { subject_id: 'cand-1', intended_use: 'Hold tools', saleable_spec: { pcs: 1 }, unknown_fields: [] },
        subjects: [{ subject_id: 'sub-1', spec: { pcs: 1 } }],
        criteria: { criteria_version: 'v1', rules: [{ criterion_id: 'c1', description: 'Match', required: true }] },
        questions: [{ question_id: 'q1', question: 'Match?', subject_ids: ['sub-1'], criterion_ids: ['c1'] }],
        evidence: [{ evidence_id: 'e1', subject_ids: ['sub-1'], summary: 'https://sellercentral.amazon.com/gp/help/external/G2027', kind: 'fact', source_ref: 'https://sellercentral.amazon.com', observed_at: '2026-11-24', window: '30d', grain: 'sku', units: 'pc', limitations: null }],
      }),
    );
    assert.doesNotMatch(promptPreview, /Closed-evidence rule/i);
    assert.match(promptPreview, /No Concurrent Workspace.*NEVER modify, overwrite, or write into the primary repository/i);
    assert.match(promptPreview, /Amazon Seller Central/i);
    assert.match(promptPreview, /OPEN INVESTIGATION AUTONOMY/i);

    // Contact-sheet Python script defaults missing fulfillment to "UNKNOWN" (never silent "FBA")
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

    const mdStoreDir = join(dir, 'md-receipts');
    const synthWinPath = ['C:', 'Users', 'synth_reviewer', 'repos', 'src', 'fba-rates-2027.mjs'].join('\\');
    const mdRes = await runCodexExecMarkdown({
      prompt: '目标：深度红队排查本轮修改。\n验收标准：核对 2027 费率与 r58 回放。\n两条边界：禁写主工作区、禁改真实店铺。',
      model: 'gpt-6.2-astra',
      reasoningEffort: 'max',
      serviceTier: 'ultrafast',
      receiptStoreDir: mdStoreDir,
      useContentAddressedReceipt: true,
      testMode: true,
      mockExecutor: async ({ args, outputFilePath }) => {
        assert.equal(args.includes('--output-schema'), false, 'Markdown review must NOT force --output-schema');
        assert.equal(args.includes('--ephemeral'), true);
        assert.equal(args.includes('-s'), false);
        writeFileSync(
          outputFilePath,
          `# 深度审查结论\n\n- 核验文件：\`${synthWinPath}\`\n- 官方来源：https://sellercentral.amazon.com/gp/help/external/GFGVB6C7ZF38285W\n- 结果：未发现阻断性 Bug。\n`,
          'utf8',
        );
        return { exitCode: 0 };
      },
    });
    assert.match(mdRes.markdown, /https:\/\/sellercentral\.amazon\.com/);
    assert.ok(mdRes.markdown.includes(synthWinPath), 'Local .local/ Markdown review preserves local file paths without error');
    assert.equal(mdRes.receipt_persisted, true);
    assert.match(mdRes.receipt_sha256, /^[0-9a-f]{64}$/);
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});

test('Astra Full-Capability Audit Round-1 Remediations (B1, H1-H16, M1-M9, L1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-audit-r1-fixes-'));
  try {
    // 1) B1 + L1: CODEX_API_KEY stripped from childEnv & stdout-fallback Markdown receipt records exact raw_output_sha256
    const fakeCodexKey = ['s' + 'k', 'synthCodexPaidBillingKey99'].join('-');
    const stdoutMdDir = join(dir, 'stdout-md-receipts');
    const codexHomeDir = join(dir, '.codex');
    writeFileSync(join(dir, 'dummy.txt'), 'ok', 'utf8');
    const fsMod = await import('node:fs');
    fsMod.mkdirSync(codexHomeDir, { recursive: true });
    writeFileSync(join(codexHomeDir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'oauth-sub-tok' } }), 'utf8');

    let observedChildCodexKey = 'UNCHECKED';
    const stdoutMdRes = await runCodexExecMarkdown({
      prompt: 'Stdout markdown fallback test.',
      env: { ...process.env, CODEX_HOME: codexHomeDir, CODEX_API_KEY: fakeCodexKey },
      receiptStoreDir: stdoutMdDir,
      useContentAddressedReceipt: true,
      testMode: true,
      mockExecutor: async ({ env: childEnv }) => {
        observedChildCodexKey = childEnv.CODEX_API_KEY;
        // Leave outputFilePath unwritten so stdout fallback triggers in testMode
        return { exitCode: 0, stdout: '# Stdout Review\n\nVerified clean.\n' };
      },
    });
    assert.equal(observedChildCodexKey, undefined, 'B1: CODEX_API_KEY must be stripped so codex exec never bills paid API');
    assert.match(stdoutMdRes.raw_output_sha256, /^[0-9a-f]{64}$/);
    const savedReceiptFiles = fsMod.readdirSync(stdoutMdDir).filter(f => f.endsWith('.json'));
    assert.equal(savedReceiptFiles.length, 1);
    const savedStdoutReceipt = JSON.parse(readFileSync(join(stdoutMdDir, savedReceiptFiles[0]), 'utf8'));
    assert.equal(savedStdoutReceipt.raw_output_sha256, stdoutMdRes.raw_output_sha256, 'L1: Disk receipt raw_output_sha256 matches stdout fallback');

    // 2) H1: Ongoing Coupon ($54.99 list - $10 coupon = $44.99 net) charges $5/100 + 2.5% ($1.17475) in both Gate 1B early-screen & Stage-3 economics
    const esCoupon = evaluateEarlyScreen({
      profile_revision: 59,
      operating_period: 'off_peak',
      fee_context: {
        package_ref: 'synth-pack',
        sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
        storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
        inbound: { from: '2027-01-15', through: '2027-02-01' },
      },
      saleable_unit: '1 synthetic organizer',
      list_price_usd: 54.99,
      ongoing_coupon_usd: 10.00,
      fx_cny_per_usd: 7.20,
      order_units: 100,
      goods_cny_per_unit: 118.00,
      bare_goods_screening: false,
      domestic_freight_cny_total: 180,
      first_order_promotion: false,
      headhaul: { chargeable_kg_per_unit: 0.68, rate_cny_per_kg: 12, bond_cny_per_shipment: 150 },
      refund_fraction: 0.04,
      return_threshold: 0.05,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
      fulfillment_usd: 5.83,
      placement_usd: 0.68,
      storage: { cubic_feet_per_unit: 0.1667, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      collection_rate: 0.006,
      other_applicable_usd: 0,
    });
    assert.equal(esCoupon.checks.margin, 'fail', JSON.stringify(esCoupon.reasons));
    assert.ok(esCoupon.metrics.margin < 0.30, `H1: After deducting $1.1748 coupon fee, margin (${esCoupon.metrics.margin}) must fall < 30%`);

    const st3CouponLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    st3CouponLedger.list_price_usd = 54.99;
    st3CouponLedger.ongoing_coupon_usd = 10.00;
    st3CouponLedger.price_usd = 44.99;
    st3CouponLedger.refund_fraction = 0.04;
    st3CouponLedger.lines.find(l => l.id === 'procurement').amount_usd = Number((118 / 7.2).toFixed(6));
    st3CouponLedger.lines.find(l => l.id === 'domestic_freight').amount_usd = Number((1.8 / 7.2).toFixed(6));
    st3CouponLedger.lines.find(l => l.id === 'headhaul').amount_usd = Number(((0.68 * 12 + 1.50) / 7.2).toFixed(6));
    st3CouponLedger.lines.find(l => l.id === 'referral').amount_usd = Number((44.99 * 0.15).toFixed(6));
    st3CouponLedger.lines.find(l => l.id === 'fulfillment').amount_usd = 5.83;
    st3CouponLedger.lines.find(l => l.id === 'fulfillment').fee_basis.price_band = 'over_50';
    st3CouponLedger.lines.find(l => l.id === 'placement').amount_usd = 0.68;
    st3CouponLedger.lines.find(l => l.id === 'storage').amount_usd = Number((0.1667 * 0.78 * 1.5).toFixed(6));
    st3CouponLedger.lines.find(l => l.id === 'storage').fee_basis = {
      ...st3CouponLedger.lines.find(l => l.id === 'storage').fee_basis,
      cubic_feet_per_unit: 0.1667,
      rate_usd_per_cuft_month: 0.78,
      average_inventory_days: 45,
      effective_from: '2027-02-01',
      effective_through: '2027-09-30',
    };
    st3CouponLedger.fee_context.sales = { from: '2027-02-01', through: '2027-09-30' };
    st3CouponLedger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    for (const ln of st3CouponLedger.lines) {
      if (ln.fee_basis && ln.id !== 'storage') {
        ln.fee_basis.effective_from = '2027-01-15';
        ln.fee_basis.effective_through = '2027-10-14';
      }
    }
    st3CouponLedger.lines.find(l => l.id === 'returns_processing').fee_basis.effective_from = '2027-02-01';
    st3CouponLedger.lines.find(l => l.id === 'returns_processing').per_return_fee_usd = 3.26;
    const st3CouponCalc = calculateEconomics(st3CouponLedger, {
      requireFeeBasis: true,
      profileRevision: 59,
      evidenceIds: ['synthetic-evidence'],
    });
    assert.equal(st3CouponCalc.scoring_supported, true, JSON.stringify(st3CouponCalc.fee_validation?.issues));
    assert.ok(Math.abs(st3CouponCalc.margin - esCoupon.metrics.margin) < 1e-4, 'H1: Gate 1B and Stage 3 coupon margins match within 0.01pp');

    // 3) H2 + H5 + H13: Out-of-band peer blocked at Gate 1A, sequential 2nd factory quote & batch supersede in Gate 1B, and CAPTCHA_PAUSED halts r59 batch
    const uiReadback = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    const gateDb = openSelectionStore(':memory:');
    gateDb.upsertCandidateForm({ form_id: 'form-h5-oob', label: 'Out of band check', buyer_task: 'Hold plates', saleable_set_composition: [{ component_id: 'stand', qty_per_saleable_set: 1 }] });
    const datedOob = (asin, priceUsd) => makeDatedKeepaReceipt({ asin, startDate: '2026-08-30', days: 90, priceUsd }).keepa_trend;
    const pbOob = analyzeMainstreamPriceBand([
      { asin: 'B0SYNVET01', title: 'Veteran 1', price_usd: 27.99, monthly_units: 120, fulfillment: 'FBA', age_days: 420, keepa_trend: datedOob('B0SYNVET01', 27.99) },
      { asin: 'B0SYNVET02', title: 'Veteran 2', price_usd: 28.99, monthly_units: 110, fulfillment: 'FBA', age_days: 400, keepa_trend: datedOob('B0SYNVET02', 28.99) },
      { asin: 'B0SYNNEW45', title: 'Newcomer 45', price_usd: 45.00, monthly_units: 60, fulfillment: 'FBA', age_days: 30 },
    ], { profile_revision: 59, as_of_date: STAGE4_AS_OF_DATE });
    const g1aOob = runGate1AForForm(gateDb, {
      form_id: 'form-h5-oob',
      profile_revision: 59,
      price_band_analysis: pbOob,
      scenarios: [
        { id: 'sc-vet-28', asin: 'B0SYNVET02', price_usd: 28.99, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 },
        { id: 'sc-new-45', asin: 'B0SYNNEW45', price_usd: 45.00, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 },
      ],
    });
    assert.equal(g1aOob.gate_status, 'gate1a_rejected', 'H5: Out-of-band $45 newcomer peer must NOT smuggle a <$29.99 mature niche past Gate 1A');

    // H2 sequential 1st factory (<30%) -> 2nd factory (>=30% + supersede_same_spec)
    const seqPkg = { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 };
    gateDb.upsertCandidateForm({ form_id: 'form-h2-seq', label: 'Sequential 2nd factory', buyer_task: 'Hold mugs', saleable_set_composition: [{ component_id: 'rack', qty_per_saleable_set: 1 }] });
    const g1aSeq = runGate1AForForm(gateDb, {
      form_id: 'form-h2-seq',
      profile_revision: 59,
      strong_date_dependency: false,
      scenarios: [{ id: 'sc-45', price_usd: 45.00, pkg: seqPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 2.0, collection_rate: 0.006 }],
    });
    const seqDecl = g1aSeq.declared_scenarios[0];
    const seqCuFt = (12 * 8 * 3) / 1728;
    const seqEarlyBuilder = () => ({
      profile_revision: 59,
      id: seqDecl.id,
      saleable_unit: '1 mug rack',
      price_usd: seqDecl.price_usd,
      fx_cny_per_usd: seqDecl.fx_cny_per_usd,
      pkg: seqPkg,
      headhaul: { chargeable_kg_per_unit: 0.68, rate_cny_per_kg: 12, bond_cny_per_shipment: 624 }, // (0.68*12 + 6.24)/7.2 = $2.00/unit!
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      fulfillment_usd: seqDecl.fulfillment_usd,
      placement_usd: seqDecl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: seqCuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      fee_context: {
        marketplace: 'US',
        currency: 'USD',
        package_ref: 'pack-mug',
        sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
        storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
        inbound: { from: '2027-01-15', through: '2027-02-01' },
      },
      collection_rate: 0.006,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    });
    const g1bFirstFail = await runGate1BForForm(gateDb, {
      form_id: 'form-h2-seq',
      profile_revision: 59,
      as_of_date: '2026-11-24',
      early_screen_builder: seqEarlyBuilder,
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: {
          quote_id: 'q-seq-1-exp',
          spec_variant_key: 'mug-rack-std',
          observed_at: '2026-11-24',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'ev-seq-1',
          fx_cny_per_usd: 7.2,
          pkg: seqPkg,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          ui_readback: uiReadback,
          sku_lines: [{ component_id: 'rack', offer_id: 'off-1', sku_id: 'sk-1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 155, regular_goods_promo_false: true }],
          goods_cny_total: 15500,
          domestic_freight_cny_total: 200,
        },
      }),
    });
    assert.equal(g1bFirstFail.status, 'gate1b_rejected', JSON.stringify(g1bFirstFail));
    assert.equal(g1bFirstFail.second_factory_quote_needed, true);

    const g1bSecondPass = await runGate1BForForm(gateDb, {
      form_id: 'form-h2-seq',
      profile_revision: 59,
      as_of_date: '2026-11-24',
      early_screen_builder: seqEarlyBuilder,
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: {
          quote_id: 'q-seq-2-cheap',
          spec_variant_key: 'mug-rack-std',
          observed_at: '2026-11-24',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'ev-seq-2',
          fx_cny_per_usd: 7.2,
          pkg: seqPkg,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          ui_readback: uiReadback,
          sku_lines: [{ component_id: 'rack', offer_id: 'off-2', sku_id: 'sk-2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 62, regular_goods_promo_false: true }],
          goods_cny_total: 6200,
          domestic_freight_cny_total: 180,
        },
      }),
    });
    assert.equal(g1bSecondPass.status, 'gate1b_passed', 'H2: Cheaper 2nd factory quote supersedes expensive 1st same-spec quote and passes Gate 1B');
    assert.equal(g1bSecondPass.second_factory_quote_needed, false);

    // H13: CAPTCHA_PAUSED immediately halts r59 runPhase2Batch without probing subsequent candidates
    let secondCandidate1688Called = false;
    const batchPauseOut = await runPhase2Batch(gateDb, {
      profile: r59Profile,
      as_of_date: '2026-11-24',
      items: [
        {
          form: { form_id: 'form-cap-1', label: 'Cap 1', buyer_task: 'Task 1', saleable_set_composition: [{ component_id: 'c1', qty_per_saleable_set: 1 }] },
          leads: [{ lead_id: 'ld-cap-1', source_channel: 'reddit', source_ref: 'https://www.reddit.com/r/synth/1', phrase_or_title: 'Synth 1', observed_at: '2026-11-24', disposition: 'product' }],
          gate1a_scenarios: [{ id: 'sc-c1', price_usd: 45.00, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
          sourcing_executor: async () => ({ status: 'captcha_triggered', reason: '1688 slider verification appeared' }),
        },
        {
          form: { form_id: 'form-cap-2', label: 'Cap 2', buyer_task: 'Task 2', saleable_set_composition: [{ component_id: 'c2', qty_per_saleable_set: 1 }] },
          leads: [{ lead_id: 'ld-cap-2', source_channel: 'reddit', source_ref: 'https://www.reddit.com/r/synth/2', phrase_or_title: 'Synth 2', observed_at: '2026-11-24', disposition: 'product' }],
          gate1a_scenarios: [{ id: 'sc-c2', price_usd: 45.00, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
          sourcing_executor: async () => { secondCandidate1688Called = true; throw new Error('Must not run after CAPTCHA_PAUSED'); },
        },
      ],
    });
    assert.equal(batchPauseOut.batch_paused, true, 'H13: r59 batch halts immediately on CAPTCHA_PAUSED');
    assert.equal(batchPauseOut.resumable, true);
    assert.equal(secondCandidate1688Called, false);
    gateDb.close();

    // 4) H3 + H4: Multi-ASIN SP-API fee matching, plural QuotaExceeded error rejection, and official 30 lb box propagating into scored margin
    const multiFeeCal = extractSpApiFinalistCalibration({
      asin: 'B0SYNTARG2',
      price_usd: 45.00,
      feesEstimateRaw: {
        payload: {
          FeesEstimateResultList: [
            {
              Status: 'Success',
              FeesEstimateIdentifier: { IdValue: 'B0SYNWRNG1', MarketplaceId: 'ATVPDKIKX0DER', PriceToEstimateFees: { ListingPrice: { Amount: 45.00, CurrencyCode: 'USD' } } },
              FeesEstimate: { TotalFeesEstimate: { Amount: 9.10 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 3.60 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.50 } }] },
            },
            {
              Status: 'Success',
              FeesEstimateIdentifier: { IdValue: 'B0SYNTARG2', MarketplaceId: 'ATVPDKIKX0DER', PriceToEstimateFees: { ListingPrice: { Amount: 45.00, CurrencyCode: 'USD' } } },
              FeesEstimate: { TotalFeesEstimate: { Amount: 12.25 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 6.75 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.50 } }] },
            },
          ],
        },
      },
    });
    assert.equal(multiFeeCal.fee_calibration.referral_fraction, 0.15, 'H3: Matches B0SYNTARG2 (15%) instead of taking [0] (8%)');

    assert.throws(
      () => extractSpApiFinalistCalibration({ restrictionsRaw: { errors: [{ code: 'QuotaExceeded', message: 'Rate exceeded' }] } }),
      /upstream error/i,
      'H4a: Plural SP-API errors[] must throw instead of reporting 0 restrictions',
    );

    const spIngestCand = structuredClone(synthBatch.candidates[0]);
    spIngestCand.id = 'cand-sp-heavy-box';
    spIngestCand.screening.reference_price_usd = {
      value: 40,
      unit: 'USD',
      matched_spec: true,
      target_variant_asin: 'B0SYNHVY30',
      fulfillment_channel: 'FBA',
      sales_history_supported: true,
      evidence: ['synthetic-evidence'],
    };
    const spIngested = ingestTrialSpecification({
      profile_revision: 59,
      allow_synthetic_without_receipts: true,
      evidence: synthBatch.evidence,
      candidates: [{
        candidate: spIngestCand,
        sp_api_calibration_inputs: {
          asin: 'B0SYNHVY30',
          price_usd: 40,
          sellerSpriteCachedRow: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 },
          catalogItemRaw: {
            asin: 'B0SYNHVY30',
            dimensions: [{ marketplaceId: 'ATVPDKIKX0DER', package: { length: { value: 24, unit: 'inches' }, width: { value: 18, unit: 'inches' }, height: { value: 12, unit: 'inches' }, weight: { value: 30, unit: 'pounds' } } }],
          },
        },
      }],
    }, r59Profile);
    const scoredHeavy = scoreCandidate(spIngested.batch.candidates[0], r59Profile);
    assert.equal(scoredHeavy.screening.status, 'excluded', 'H4b: Official 30 lb Bulky SP-API box overrides stale 1.2 lb cache and drops margin < 30% -> excluded');

    // 5) H6 + H9 + H12 + H15: Price-band unsteady veteran supplement, FBM sibling non-eviction, 450d clearance non-blue-ocean, MarketObservationJudge wiring, caregiver exemption, and r58 CLI parity
    const pbUnsteadyVet = analyzeMainstreamPriceBand([
      { asin: 'B0SYNVETU1', title: 'Unsteady Vet 1', price_usd: 35.99, monthly_units: 80, fulfillment: 'FBA', age_days: 500, keepa_price_steady: false },
      { asin: 'B0SYNVETU2', title: 'Unsteady Vet 2', price_usd: 36.99, monthly_units: 70, fulfillment: 'FBA', age_days: 480, keepa_price_steady: false },
      { asin: 'B0SYNGRW01', title: 'Steady Growth 1', price_usd: 42.99, monthly_units: 150, fulfillment: 'FBA', age_days: 180, keepa_price_steady: true },
      { asin: 'B0SYNGRW02', title: 'Steady Growth 2', price_usd: 44.99, monthly_units: 140, fulfillment: 'FBA', age_days: 200, keepa_price_steady: true },
    ], { profile_revision: 59 });
    assert.equal(pbUnsteadyVet.growth_supplement_used, true, 'H6a: Unsteady >=365d veterans must allow steady 91-364d growth peers to supplement');
    assert.equal(pbUnsteadyVet.mainstream_count, 2);

    const pbFbmSibling = analyzeMainstreamPriceBand([
      { asin: 'B0SYNFBM99', parent_asin: 'B0SYNPAR99', title: 'FBM Sibling', price_usd: 32.99, monthly_units: 500, fulfillment: 'FBM', age_days: 400 },
      { asin: 'B0SYNFBA99', parent_asin: 'B0SYNPAR99', title: 'FBA Sibling', price_usd: 42.99, monthly_units: 150, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
      { asin: 'B0SYNFBA98', parent_asin: 'B0SYNPAR98', title: 'FBA Peer 2', price_usd: 44.99, monthly_units: 120, fulfillment: 'FBA', age_days: 410, keepa_price_steady: true },
    ], { profile_revision: 59 });
    assert.equal(pbFbmSibling.mainstream_count, 2, 'H6b: Higher-sales FBM sibling is filtered before parent_asin dedup so matched FBA sibling survives');

    const pbClearancePlusYoung = analyzeMainstreamPriceBand([
      { asin: 'B0SYNCLR01', title: '450d Clearance', price_usd: 22.99, keepa_90d_median_usd: 45.99, monthly_units: 90, fulfillment: 'FBA', age_days: 450, veteran_clearance_or_war: true },
      { asin: 'B0SYNYNG01', title: 'Newcomer 1', price_usd: 39.99, monthly_units: 80, fulfillment: 'FBA', age_days: 40 },
    ], { profile_revision: 59 });
    assert.equal(pbClearancePlusYoung.all_under_90d_blue_ocean, false, 'H6d: Presence of 450d veteran prevents false all-under-90d blue-ocean banner');

    // H9: Exact cent anti-tamper ($29.98 -> $29.99 rejected), null Keepa fabrication rejected, and market_observation_result wired into analyzeMainstreamPriceBand
    const rawMktInput = {
      form_id: 'form-h9-check',
      peers: [{ asin: 'B0SYNMKT01', price_usd: 29.98, keepa_high_usd: null, keepa_low_usd: null, review_count: 25 }],
    };
    assert.throws(
      () => parseMarketObservationResult({
        schema_version: 1,
        contract: 'MarketObservationJudge',
        form_id: 'form-h9-check',
        peer_observations: [{
          asin: 'B0SYNMKT01',
          mandatory_facts: {
            observed_price_usd: 29.99, // 1-cent tamper!
            keepa_high_usd: null,
            keepa_low_usd: null,
            review_count: 25,
            keepa_90d_trend: 'No Keepa history',
            coupon_status: 'none',
            review_curve_change: 'Steady',
            key_appearance_and_dims: '10x8x3 in',
          },
          qualitative_judgment: {
            bucket: 'primary_comparable',
            include_in_primary_band: true,
            keep_in_observation_bar: false,
            reason_zh: '篡改一美分测试。',
          },
        }],
        market_summary_zh: '市场观察汇总测试。',
      }, rawMktInput),
      /observed_price_usd/i,
      'H9: 1-cent $29.98 -> $29.99 tampering rejected',
    );
    const parsedJudgeForBand = parseMarketObservationResult({
      schema_version: 1,
      contract: 'MarketObservationJudge',
      form_id: 'form-h9-wire',
      peer_observations: [{
        asin: 'B0SYNWIR01',
        mandatory_facts: {
          observed_price_usd: 31.99,
          keepa_high_usd: 49.99,
          keepa_low_usd: 31.99,
          review_count: 88,
          keepa_90d_trend: 'Clearance drop',
          coupon_status: 'none',
          review_curve_change: 'Flat',
          key_appearance_and_dims: '12x8x3 in',
        },
        qualitative_judgment: {
          bucket: 'veteran_clearance_or_war',
          include_in_primary_band: false,
          keep_in_observation_bar: true,
          reason_zh: 'AI核定老品清仓跳水，移入观察栏。',
        },
      }],
      market_summary_zh: '主力稳态，清仓款单列观察。',
    }, { form_id: 'form-h9-wire', peers: [{ asin: 'B0SYNWIR01', price_usd: 31.99, keepa_high_usd: 49.99, keepa_low_usd: 31.99, review_count: 88, review_curve_change: 'Flat', key_appearance_and_dims: '12x8x3 in' }] });
    const pbWiredJudge = analyzeMainstreamPriceBand([
      { asin: 'B0SYNWIR01', title: 'Clearance Peer', price_usd: 31.99, monthly_units: 90, fulfillment: 'FBA', age_days: 420 },
      { asin: 'B0SYNWIR02', title: 'Steady Peer', price_usd: 48.99, monthly_units: 120, fulfillment: 'FBA', age_days: 420, keepa_price_steady: true },
    ], { profile_revision: 59, market_observation_result: parsedJudgeForBand });
    assert.equal(pbWiredJudge.band.p50_usd, 48.99, 'H9: market_observation_result isolates B0SYNWIR01 into observation bar');

    assert.equal(
      evaluateGate0CategoryBoundary({ title: 'Waterproof Diaper Bag Backpack for Parents', root_category: 'Baby Products' }).hard_exclusion,
      false,
      'H12: Adult parent diaper bag backpack exempted from CPSC <=12y child product ban',
    );
    assert.equal(
      evaluateGate0CategoryBoundary({ title: 'Silicone Baby Teether Toy for Infants', root_category: 'Baby Products' }).hard_exclusion,
      true,
    );

    const pbCliIn = join(dir, 'pb-r58.json');
    writeFileSync(pbCliIn, JSON.stringify({
      listings: [
        { asin: 'B0SYNR58A1', title: 'Mature 1', price_usd: 59.99, monthly_units: 150, fulfillment: 'FBA', age_days: 400 },
        { asin: 'B0SYNR58A2', title: '100d 16% Coupon', list_price_usd: 59.99, ongoing_coupon_pct: 0.16, price_usd: 50.39, monthly_units: 150, fulfillment: 'FBA', age_days: 100 },
      ],
    }), 'utf8');
    const pbCliR58 = await runCliMem(['price-band', '--input', pbCliIn, '--profile-revision', '58']);
    assert.notEqual(pbCliR58.code, 0, 'H15 closed: --profile-revision 58 rejected after r50-r58 retirement');
    const pbCliR59 = await runCliMem(['price-band', '--input', pbCliIn, '--profile-revision', '59']);
    assert.equal(pbCliR59.code, 0, pbCliR59.stderr);
    const pbCliR59Json = JSON.parse(pbCliR59.stdout);
    assert.equal(pbCliR59Json.analysis.mainstream_count, 2, 'r59 includes 100d (>90d) <20% routine coupon peer alongside 400d veteran');

    // 6) H7 + H8: sample_pending_qualifying blocks prescreen_completed:false, hard_ban excludes, and #4 rejects median while accepting family_units
    const unprescreenedCand = structuredClone(synthBatch.candidates[0]);
    unprescreenedCand.judgments.specific_design_rights = {
      anchor: null,
      prescreen_completed: false,
      sample_check_required: true,
      reason: 'Need physical comparison, but public patent search was NOT completed yet.',
      evidence: ['synthetic-evidence'],
    };
    const scoredUnprescreened = scoreCandidate(unprescreenedCand, r59Profile);
    assert.equal(scoredUnprescreened.qualification.counts_toward_target, false, 'H7a: prescreen_completed:false MUST NOT enter sample_pending_qualifying');

    const hardBanCand = structuredClone(synthBatch.candidates[0]);
    hardBanCand.judgments.applicable_public_requirements = {
      anchor: 0,
      hard_ban: true,
      proven_conflict: true,
      reason: 'Statutory CPSC / EPA hard ban.',
      evidence: ['synthetic-evidence'],
    };
    const scoredHardBan = scoreCandidate(hardBanCand, r59Profile);
    assert.equal(scoredHardBan.screening.status, 'excluded', 'H7b: hard_ban:true must set screening.status="excluded"');

    const medianDemandCand = structuredClone(synthBatch.candidates[0]);
    medianDemandCand.metrics.purchase_demand_scale = {
      ...medianDemandCand.metrics.purchase_demand_scale,
      grain: 'target_child_units',
      statistic: 'median',
    };
    assert.equal(
      scoreCandidate(medianDemandCand, r59Profile).items.find(i => i.id === 'purchase_demand_scale').score,
      null,
      'H8a: target_child_units + statistic:"median" must be rejected on #4',
    );
    const familyUnitsCand = structuredClone(synthBatch.candidates[0]);
    familyUnitsCand.metrics.purchase_demand_scale = {
      ...familyUnitsCand.metrics.purchase_demand_scale,
      grain: 'family_units',
    };
    assert.ok(
      scoreCandidate(familyUnitsCand, r59Profile).items.find(i => i.id === 'purchase_demand_scale').score > 0,
      'H8b: family_units is accepted on #4',
    );

    // 7) H10 + M2 + M4: Non-canonical live --db guard, --budget-db binding, M2 cleanup deadlock fix, and M4 redteam-review non-qualifying skip
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
    assert.equal(liveGuardRes.code, 2, 'H10: Non-canonical live --db without --budget-db is blocked before opening ledger or network');
    assert.match(liveGuardRes.stderr, /budget-db|selection\.sqlite/);

    // M2: Reconciling a pending_recovery attempt (missing usage_cost_micros) with postedBilledCents unlocks beginBoundResponseCleanup without Catch-22 deadlock
    const { createHash } = await import('node:crypto');
    const curMonth = new Date().toISOString().slice(0, 7);
    const m2Fp = 'd'.repeat(64);
    const m2Ledger = openOpenAiBudgetLedger(':memory:', { testMode: true });
    m2Ledger.reconcileLegacySummary(
      { recognized_schema: true, month_utc: curMonth, file_sha256: 'b'.repeat(64), total_rows: 0, unresolved_count: 0, same_month_reserved_cents: 0 },
      { allowSyntheticSummaryForTests: true, enable: true, hardMonthlyLimitConfirmed: true, autoRechargeOffConfirmed: true },
    );
    const m2Adm = m2Ledger.reserveBillableRequest({
      logicalRequestId: 'm2-deadlock-check',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      reservedCents: 10,
      payloadSha256: 'c'.repeat(64),
      cleanupRequired: true,
      apiBaseUrl: 'https://api.openai.com/v1',
      origin: 'https://api.openai.com',
      credentialFingerprintSha256: m2Fp,
    });
    const rawRespBytes = Buffer.from('{"id":"resp_m2_123","status":"incomplete"}', 'utf8');
    const rawRespSha = createHash('sha256').update(rawRespBytes).digest('hex');
    m2Ledger.savePrivatePayload(m2Adm.attempt_id, 'response_post', rawRespBytes);
    m2Ledger.recordTerminalOutcome(m2Adm.attempt_id, {
      status: 'pending_recovery',
      providerResponseId: 'resp_m2_123',
      httpStatus: 200,
      rawReceipt: { id: 'resp_m2_123', status: 'incomplete' },
      rawBodySha256: rawRespSha,
      originalBodySha256: rawRespSha,
      usageCostMicros: null,
    });
    const m2Rec = m2Ledger.reconcileAttempt(m2Adm.attempt_id, {
      status: 'completed',
      postedBilledCents: 2,
      note: 'Verified 2c billed on platform invoice while remote response awaits DELETE.',
    });
    assert.equal(m2Rec.status, 'completed');
    assert.equal(m2Rec.cleanup_status, 'pending_cleanup');
    const m2Cleanup = m2Ledger.beginBoundResponseCleanup(m2Adm.attempt_id, {
      providerResponseId: 'resp_m2_123',
      apiBaseUrl: 'https://api.openai.com/v1',
      origin: 'https://api.openai.com',
      credentialFingerprintSha256: m2Fp,
    });
    assert.equal((m2Cleanup.attempt ?? m2Cleanup).cleanup_status, 'pending_cleanup', 'M2: Settled attempt with pending_cleanup unlocks beginBoundResponseCleanup without deadlock');
    m2Ledger.close();

    // M4: redteam-review --db skips non-qualifying (gate1b_rejected) candidate cleanly without invoking codex
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
    assert.equal(m4CodexCalled, false, 'M4: Non-qualifying gate1b_rejected form is skipped before spawning Codex');
    assert.equal(JSON.parse(m4Cli.stdout).skipped_non_qualifying, true);

    // 8) H11 + H14 + H16 + M1 + M3 + M5 + M6 + M7 + M8
    const esMissingA4 = evaluateEarlyScreen({
      profile_revision: 59,
      operating_period: 'off_peak',
      fee_context: {
        package_ref: 'synth-pack',
        sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
        storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
        inbound: { from: '2027-01-15', through: '2027-02-01' },
      },
      saleable_unit: '1 light stand',
      price_usd: 45.00,
      fx_cny_per_usd: 7.2,
      order_units: 100,
      goods_cny_per_unit: 40,
      domestic_freight_cny_total: 120,
      first_order_promotion: false,
      headhaul: { actual_weight_kg_per_unit: 0.25, rate_cny_per_kg: 12, bond_cny_per_shipment: 150, steady_state_replenishment: false }, // explicit small-batch <50 kg without small_shipment_surcharge_cny_per_kg!
      refund_fraction: 0.04,
      return_threshold: 0.05,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
      fulfillment_usd: 4.50,
      placement_usd: 0.40,
      storage: { cubic_feet_per_unit: 0.1, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      collection_rate: 0.006,
      other_applicable_usd: 0,
    });
    assert.equal(esMissingA4.checks.margin, 'pending', 'H11: <50kg shipment without small_shipment_surcharge_cny_per_kg stays pending');

    // H14: Paired seasonal preserves partial effective_through < 2027-09-30 and sets peak storage rate $2.40
    const baseOffSc = structuredClone(synthBatch.candidates[0].economics.scenarios[0]);
    baseOffSc.cost_ledger.lines.find(l => l.id === 'storage').fee_basis = {
      status: 'published',
      version: 'US-FBA-2027-v1',
      marketplace: 'US',
      currency: 'USD',
      package_ref: 'synthetic-pack',
      effective_from: '2027-02-01',
      effective_through: '2027-06-30',
      rate_usd_per_cuft_month: 0.78,
      cubic_feet_per_unit: 0.2,
      average_inventory_days: 45,
      evidence: ['synthetic-evidence'],
    };
    const pairedH14 = buildPairedSeasonalOperatingPeriods({
      profile_revision: 59,
      saleable_unit: baseOffSc.saleable_unit,
      off_peak_scenarios: [baseOffSc],
      cubic_feet_per_unit: 0.2,
      average_inventory_days: 45,
      size_tier: 'large_standard',
    });
    const offStorBasis = pairedH14.operating_periods[0].scenarios[0].cost_ledger.lines.find(l => l.id === 'storage').fee_basis;
    const peakStorBasis = pairedH14.operating_periods[1].scenarios[0].cost_ledger.lines.find(l => l.id === 'storage').fee_basis;
    assert.equal(offStorBasis.effective_through, '2027-06-30', 'H14a: Partial 2027-06-30 storage window is NOT fabricated upward to 2027-09-30');
    assert.equal(peakStorBasis.rate_usd_per_cuft_month, 2.40, 'H14b: Companion peak storage fee_basis rate is updated to $2.40');

    // H16: r59 HTML redacts phone/contact/path in evidence_review while keeping https:// URLs
    const piiRevDir = join(dir, 'pii-ev-receipts');
    fsMod.mkdirSync(piiRevDir, { recursive: true });
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
    const h16Batch = structuredClone(synthBatch);
    h16Batch.profile_revision = 59;
    h16Batch.candidates = [h16Batch.candidates[0]];
    attachCandidateEvidenceReview(h16Batch.candidates[0], h16Env, h16Packet, {
      receiptStoreDir: piiRevDir,
      allowTestDoubleReceipt: true,
    });
    const h16Scored = scoreBatch(h16Batch, r59Profile);
    const h16Html = renderReport(h16Scored, h16Batch, { receiptStoreDir: piiRevDir, allowTestDoubleReceipts: true });
    assert.equal(h16Html.includes(dynPhone), false, 'H16: Phone number scrubbed from r59 shareable HTML');
    assert.equal(h16Html.includes(dynWinPath), false, 'H16: Local workstation path scrubbed from r59 shareable HTML');
    assert.match(h16Html, /https:\/\/sellercentral\.amazon\.com\/gp\/help\/G2027/, 'H16: Public https:// URL preserved');

    // M1 + M3 + M5 + M6 + M7 + M8
    const specOverPkg = { length_in: 110, width_in: 10, height_in: 8, unit_weight_lb: 40 };
    assert.equal(classifySizeTier2027(specOverPkg).size_tier, 'special_oversize_light');
    assert.equal(lookupUnifiedPlacementFee2027({ pkg: specOverPkg }).selected_usd, 0, 'M1: special_oversize_light exempt ($0.00) from placement');
    assert.equal(lookupUnifiedReturnsProcessing2027({ pkg: specOverPkg, physical_return_fraction: 0.08, fee_category: 'Home and Kitchen' }).status, 'verified');

    assert.throws(
      () => getFba2027RateTableSnapshot({ profileRevision: 58 }),
      /retired|59/i,
      'M3: pre-r59 rate snapshots retired in active runtime',
    );
    assert.equal(getFba2027RateTableSnapshot({ profileRevision: 59 }).metadata.default_off_peak_window.through, '2027-10-14');
    assert.equal(Array.isArray(getFba2027RateTableSnapshot({ profileRevision: 59 }).oversize_2027_tiers), true);
    assert.equal(canonicalizeConnectorToolName('mcp__codex_apps__amz_spapi_sp_api_execute'), 'sp_api_execute', 'M5: amz_spapi prefix stripped');
    assert.equal(
      validateProviderCall('sp_api', 'mcp__codex_apps__amz_spapi_sp_api_execute', { method: 'GET', path: '/catalog/2022-04-01/items/B000000001' }).valid,
      true,
      'M5: Full registered amz_spapi tool passes read-only validation',
    );

    const m7Mkt = ingestSellerSpriteMonthlyArchiveMarket({ items: [{ dataMonth: '202610', avgReviews: 312, sellers: 12 }] }, { evidence: ['ev-m7'] });
    assert.equal(m7Mkt.top10_median_reviews, undefined, 'M7a: avgReviews is NOT mislabeled as top10_median_reviews');
    assert.equal(m7Mkt.category_avg_reviews, 312);
    const m7Origin = extractNewcomerReviewOriginBreakdown({ vineCount: 3, verified_purchase_count: 8, direct_review_count: 2 });
    assert.deepEqual({ vine: m7Origin.vine_count, vp: m7Origin.vp_count, direct: m7Origin.direct_count }, { vine: 3, vp: 8, direct: 2 }, 'M7b: Aliased review origin fields parsed');

    const m8Uninspected = resolveStage1QualitativeJudgments({
      review_judge: {
        reviews_inspected: false,
        status: 'supported',
        support_level: 'strong',
        review_citations: [{ review_id: 'R1', sku_verified: true }],
      },
    });
    assert.equal(m8Uninspected.judgments.feasible_light_differentiation.anchor, null, 'M8: reviews_inspected:false must NOT score 1/1');

    const m6IsoSpec = ingestTrialSpecification({
      profile_revision: 59,
      allow_synthetic_without_receipts: true,
      evidence: synthBatch.evidence,
      candidates: [
        {
          candidate: { ...structuredClone(synthBatch.candidates[0]), id: 'cand-m6-empty-archive' },
          monthly_archive_market_raw: { items: [] },
        },
        {
          candidate: { ...structuredClone(synthBatch.candidates[0]), id: 'cand-m6-healthy' },
        },
      ],
    }, r59Profile);
    assert.equal(m6IsoSpec.isolated_candidates.length, 1, 'M6: Empty monthly archive items[] isolates only the affected candidate');
    assert.equal(m6IsoSpec.batch.candidates[1].id, 'cand-m6-healthy');
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});

test('Astra Full-Capability Audit Round-2 Remediations (R2-1..R2-4, H1-H16, M2/M4/M5/M7/M8)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-astra-r2-rem-'));
  try {
    // 1) R2-1 + H1: Coupon Gate 1A CLI exits 0 (no BigInt crash), Gate 1B rejects dropped coupon, packaging rescue keeps coupon, and Stage-3 scoring rejects understated net-band FBA fee
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
    assert.equal(cpnCliRes.code, 0, `R2-1: Coupon Gate 1A CLI must exit 0 without BigInt crash: ${cpnCliRes.stderr}`);
    const cpnCliParsed = JSON.parse(cpnCliRes.stdout);
    assert.equal(cpnCliParsed.result.gate_status, 'gate1a_passed');
    assert.equal(cpnCliParsed.result.declared_scenarios[0].coupon_fee_usd, 1.17475);

    const r2Store = openSelectionStore(r2DbPath);
    const uiOk = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
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
          ui_readback: uiOk,
          sku_lines: [{ component_id: 'box', offer_id: 'oc1', sku_id: 'sc1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 100, regular_goods_promo_false: true }],
          goods_cny_total: 10000,
          domestic_freight_cny_total: 200,
        },
      }),
      // Builder attempts to omit ongoing_coupon_usd while passing only net price $44.99
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
    assert.equal(droppedCpnG1b.status, 'gate1b_pending', 'H1: Gate 1B blocks scenario that drops Gate 1A ongoing coupon fee');
    assert.equal(droppedCpnG1b.proceed_to_gate2_3, false);
    assert.match(JSON.stringify(droppedCpnG1b), /ongoing coupon redemption fee/i);

    // Stage-3 formal scoring rejects understated net-band FBA fulfillment fee under ongoing coupon
    const netBandCand = structuredClone(synthBatch.candidates[0]);
    const netSc = netBandCand.economics.scenarios[0];
    const pkgIdRef = netSc.cost_ledger.fee_context.package_ref;
    netSc.cost_ledger.packages = [{ id: pkgIdRef, length_in: 14, width_in: 10, height_in: 3, unit_weight_lb: 1.4 }];
    netSc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-10-14' };
    netSc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    netSc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
    netSc.cost_ledger.list_price_usd = 54.99;
    netSc.cost_ledger.ongoing_coupon_usd = 10.00;
    netSc.cost_ledger.price_usd = 44.99;
    netSc.cost_ledger.promo_basis_already_net = true;
    const fulLineWrong = netSc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    fulLineWrong.amount_usd = 4.16; // understated net-band fee vs >$5.30 list-price over_50 fee!
    fulLineWrong.fee_basis.effective_from = '2027-01-15';
    fulLineWrong.fee_basis.effective_through = '2027-10-14';
    const scoredWrongFul = scoreCandidate(netBandCand, r59Profile);
    assert.equal(scoredWrongFul.qualification.counts_toward_target, false, 'H1: Formal scoring blocks understated net-band fulfillment fee');

    // 2) H2 + H13: Batch continuation dispatches 2nd factory when 1st failed, stops at 3 factories, and halts on pre-existing CAPTCHA_PAUSED
    let batchFactoryCalls = 0;
    const seqBatchItem = {
      form: { form_id: 'form-r2-h2-batch', label: 'Batch Seq', buyer_task: 'Hold mugs', saleable_set_composition: [{ component_id: 'rack', qty_per_saleable_set: 1 }] },
      leads: [{ lead_id: 'ld-r2-h2', source_channel: 'reddit', source_ref: 'https://www.reddit.com/r/synth/h2', phrase_or_title: 'Mug rack', observed_at: '2026-11-24', disposition: 'product' }],
      gate1a_scenarios: [{ id: 'sc-b1', price_usd: 45.00, pkg: stdPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
      early_screen_builder: ({ form }) => {
        const ds = JSON.parse(form.gate1a_result_json).declared_scenarios;
        return [{
          id: ds[0].id, saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
          headhaul: { usd_per_unit: 1.8, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0,
          is_apparel_or_shoes: false, referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          fulfillment_usd: ds[0].fulfillment_usd, placement_usd: ds[0].placement_range_usd[1],
          storage: { cubic_feet_per_unit: (14 * 10 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
          collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
        }];
      },
      sourcing_executor: async () => {
        batchFactoryCalls += 1;
        const unitCny = batchFactoryCalls === 1 ? 150 : 42;
        return {
          status: 'quoted',
          quote: {
            quote_id: `q-r2-b-${batchFactoryCalls}`,
            spec_variant_key: 'mug-rack-v1',
            observed_at: '2026-11-24',
            redacted_destination: '广东深圳',
            raw_readback_ref: `ev-b-${batchFactoryCalls}`,
            fx_cny_per_usd: 7.2,
            pkg: stdPkg,
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            ui_readback: uiOk,
            sku_lines: [{ component_id: 'rack', offer_id: `ob-${batchFactoryCalls}`, sku_id: `sb-${batchFactoryCalls}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: unitCny, regular_goods_promo_false: true }],
            goods_cny_total: unitCny * 100,
            domestic_freight_cny_total: 150,
          },
        };
      },
    };
    const bRun1 = await runPhase2Batch(r2Store, { profile: r59Profile, as_of_date: '2026-11-24', items: [seqBatchItem] });
    assert.equal(bRun1.gate1b[0].status, 'gate1b_rejected');
    assert.equal(bRun1.gate1b[0].second_factory_quote_needed, true);
    assert.equal(batchFactoryCalls, 1);

    const bRun2 = await runPhase2Batch(r2Store, { profile: r59Profile, as_of_date: '2026-11-24', items: [seqBatchItem] });
    assert.equal(batchFactoryCalls, 2, 'H2: Batch continuation dispatches 2nd factory when 1st failed');
    assert.equal(bRun2.gate1b[0].status, 'gate1b_passed');

    r2Store.pauseQueue('gate1b_1688_queue', 'Persistent slider', { paused_form_id: 'form-r2-h2-batch' });
    let deepCalledWhilePaused = false;
    const bPaused = await runPhase2Batch(r2Store, {
      profile: r59Profile,
      as_of_date: '2026-11-24',
      items: [seqBatchItem],
      deep_research_executor: async () => { deepCalledWhilePaused = true; throw new Error('Must not run while CAPTCHA_PAUSED'); },
    });
    assert.equal(bPaused.batch_paused, true, 'H13: Persistent CAPTCHA_PAUSED halts batch before deep_research_executor');
    assert.equal(deepCalledWhilePaused, false);

    // M5: amz_spapi full name and short name map to the exact same SQLite logical request key
    const spAtt1 = r2Store.reserveRequestAttempt({
      account_scope: 'sp-test',
      provider: 'sp_api',
      tool_name: 'sp_api_execute',
      observation_cutoff_date: '2026-11-24',
      params: { method: 'GET', path: '/catalog/2022-04-01/items/B000000001' },
    });
    const spAtt2 = r2Store.reserveRequestAttempt({
      account_scope: 'sp-test',
      provider: 'sp_api',
      tool_name: 'mcp__codex_apps__amz_spapi_sp_api_execute',
      observation_cutoff_date: '2026-11-24',
      params: { method: 'GET', path: '/catalog/2022-04-01/items/B000000001' },
    });
    assert.equal(spAtt1.logical_request_key, spAtt2.logical_request_key, 'M5: Short and full amz_spapi tool names share identical logical_request_key');
    r2Store.close();

    // 3) H3 + H4: $80 receipt not matched to $40 query, MFN ignored, empty Error:{} allowed, Canadian used restriction ignored, and QuotaExceeded receipt isolated
    const mismatchPriceCal = extractSpApiFinalistCalibration({
      asin: 'B0SYNR2SP1',
      price_usd: 40.00,
      feesEstimateRaw: {
        FeesEstimateResult: {
          Status: 'Success',
          Error: {},
          FeesEstimateIdentifier: { IdValue: 'B0SYNR2SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 80.00 } } },
          FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 17.00 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 12.00 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
      },
    });
    assert.equal(mismatchPriceCal.fee_calibration_status, 'unmatched', 'H3: $80 single receipt must not verify a $40 query');

    const emptyErrOkCal = extractSpApiFinalistCalibration({
      asin: 'B0SYNR2SP1',
      price_usd: 40.00,
      feesEstimateRaw: {
        FeesEstimateResult: {
          Status: 'Success',
          Error: {},
          FeesEstimateIdentifier: { IdValue: 'B0SYNR2SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 40.00 } } },
          FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 11.00 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 6.00 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
      },
      restrictionsRaw: {
        asin: 'B0SYNR2SP1',
        restrictions: [{ marketplaceId: 'A2EUQ1WTGCTBG2', conditionType: 'used_like_new', reasons: [{ reasonCode: 'NOT_ELIGIBLE', message: 'Restricted in CA used.' }] }],
      },
    });
    assert.equal(emptyErrOkCal.fee_calibration_status, 'verified', 'H3: Empty Error:{} object does not block Success');
    assert.equal(emptyErrOkCal.restrictions.hard_category_ban, false, 'H4: Non-US / used restriction does not trigger US new_new hard ban');

    // 4) H6 + H9 + H12 + H15: Parent dedup keeps 366d veteran over 90d child, validated newcomers form blue-ocean band, nursery shelf/toddler-pocket exempted, r58 frozen
    const pbParentMix = analyzeMainstreamPriceBand([
      { asin: 'B0SYNR2P01', parent_asin: 'B0SYNR2PAR', title: 'Mug Rack Black', price_usd: 39.99, monthly_units: 300, is_best_selling_variant: true, fulfillment: 'FBA', age_days: 60 },
      { asin: 'B0SYNR2P02', parent_asin: 'B0SYNR2PAR', title: 'Mug Rack Walnut', price_usd: 44.99, monthly_units: 120, fulfillment: 'FBA', age_days: 400, keepa_price_steady: true },
    ], { profile_revision: 59 });
    assert.equal(pbParentMix.all_under_90d_blue_ocean, false, 'H6: 400d sibling prevents false all-under-90d blue-ocean banner');
    assert.equal(pbParentMix.band.p50_usd, 44.99, 'H6: Steady 400d sibling wins parent representative over 60d newcomer');

    const pbBlueValidated = analyzeMainstreamPriceBand([
      { asin: 'B0SYNR2N01', title: 'New 1', price_usd: 36.99, monthly_units: 90, fulfillment: 'FBA', age_days: 45, ai_qualitative_bucket: 'newcomer_reference' },
      { asin: 'B0SYNR2N02', title: 'New 2', price_usd: 39.99, monthly_units: 110, fulfillment: 'FBA', age_days: 55, ai_qualitative_bucket: 'newcomer_reference' },
    ], { profile_revision: 59 });
    assert.equal(pbBlueValidated.all_under_90d_blue_ocean, true, 'H9: Validated newcomer_reference labels still populate blue-ocean band');
    assert.ok(pbBlueValidated.band.p50_usd >= 36.99);

    assert.throws(
      () => parseMarketObservationResult({
        schema_version: 1, contract: 'MarketObservationJudge', form_id: 'form-r2-fab',
        peer_observations: [{
          asin: 'B0SYNR2FAB',
          mandatory_facts: { observed_price_usd: 39.99, keepa_high_usd: null, keepa_low_usd: null, review_count: null, keepa_90d_trend: '走势稳定', coupon_status: '40% OFF', review_curve_change: '三周增加60评', key_appearance_and_dims: '18x12x4 in' },
          qualitative_judgment: { bucket: 'primary_comparable', include_in_primary_band: true, keep_in_observation_bar: false, reason_zh: '测试编造事实拦截。' },
        }],
        market_summary_zh: '测试缺失源文本拦截。',
      }, { form_id: 'form-r2-fab', peers: [{ asin: 'B0SYNR2FAB', price_usd: 39.99 }] }),
      /fabricated/i,
      'H9: Fabricated text facts rejected when raw source lacks Keepa/coupon/review/dims',
    );

    assert.equal(evaluateGate0CategoryBoundary({ title: 'Diaper Bag Backpack for Parents with Pocket for Toddler Clothes' }).hard_exclusion, false, 'H12a');
    assert.equal(evaluateGate0CategoryBoundary({ title: 'Floating Wood Nursery Shelf for Bedding Storage' }).hard_exclusion, false, 'H12b');

    assert.throws(() => analyzeMainstreamPriceBand([], { profile_revision: 58 }), /retired/i, 'H15 closed: r58 price-band branch retired');

    // 5) H7 + H8 + H11 + H14 + M8: Registry access failure not marked completed, trademark conflict excluded, point target_child_units rejected, A4 missing carton_count & <50kg unit-weight held pending, #17 reviews_inspected:false rejected
    const regFailResolved = resolveStage1QualitativeJudgments({
      rights_prescreen: {
        specific_design_rights: { status: 'needs_verification', summary: 'USPTO registry unavailable (HTTP 503); public search incomplete.' },
        applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['NONE_IDENTIFIED'], summary: 'Checked.' },
      },
    });
    assert.equal(regFailResolved.judgments.specific_design_rights.prescreen_completed, false, 'H7a: Registry access failure is NOT marked prescreen_completed:true');

    const tmConflictResolved = resolveStage1QualitativeJudgments({
      rights_prescreen: {
        specific_design_rights: { status: 'no_public_hit_observed', summary: 'No patent hit.' },
        trademark_conflicts: { status: 'proven_conflict', summary: 'Target shape/term infringes active registered trademark.' },
        applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['NONE_IDENTIFIED'], summary: 'Clean.' },
      },
    });
    assert.equal(tmConflictResolved.judgments.specific_design_rights.proven_conflict, true, 'H7b: Target-spec trademark proven_conflict blocks qualification');

    const childPointCand = structuredClone(synthBatch.candidates[0]);
    childPointCand.metrics.purchase_demand_scale = {
      ...childPointCand.metrics.purchase_demand_scale,
      grain: 'target_child_units',
      aggregation: 'sum',
    };
    assert.equal(scoreCandidate(childPointCand, r59Profile).items.find(i => i.id === 'purchase_demand_scale').score, null, 'H8: Point target_child_units rejected on #4');

    const falseInspCand = structuredClone(synthBatch.candidates[0]);
    falseInspCand.judgments.feasible_light_differentiation = {
      ...falseInspCand.judgments.feasible_light_differentiation,
      anchor: 1,
      reviews_inspected: false,
    };
    assert.equal(scoreCandidate(falseInspCand, r59Profile).items.find(i => i.id === 'feasible_light_differentiation').score, null, 'M8: reviews_inspected:false rejected in scoreCandidate');

    const missingCartonCntEv = evaluateEarlyScreen({
      profile_revision: 59, id: 'sc-a4-nocarton', saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
      procurement: { cny_per_unit: 40, order_units: 100, first_order_promotion: false },
      domestic_freight: { cny_per_shipment: 150, order_units: 100, first_order_promotion: false },
      headhaul: { chargeable_kg_per_unit: 0.15, rate_cny_per_kg: 5, bond_cny_per_kg: 0, order_units: 100, weight_per_carton_kg: 5, small_shipment_surcharge_cny_per_kg: 0, small_carton_surcharge_cny_per_carton: 10 },
      refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      fulfillment_usd: 4.50, placement_usd: 0.40,
      storage: { cubic_feet_per_unit: 0.2, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
      collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
    }, { profileRevision: 59 });
    assert.equal(missingCartonCntEv.ledger.margin, null, 'H11: Missing carton_count on per-carton surcharge holds headhaul pending');

    // 6) R2-2 + R2-3 + R2-4 + H10 + H16 + M4 + M7
    const fakeSecretVal = ['sk', 'proj', 'SyntheticSecretToken1234567890ABCDEF'].join('-');
    const secReceiptDir = join(dir, 'sec-receipts');
    await assert.rejects(
      () => runCodexExecMarkdown({
        prompt: 'Return test markdown',
        cwd: dir,
        receiptDir: secReceiptDir,
        testMode: true,
        mockExecutor: async () => ({ exitCode: 0, stdout: `Report leaked token ${fakeSecretVal} inline.`, stdoutBytes: 64 }),
      }),
      /CODEX_OUTPUT_SECRET_BLOCKED|secret/i,
      'R2-2: Secret token in Codex stdout is quarantined rather than returned as completed',
    );
    const secReceiptFiles = readdirSync(secReceiptDir).filter(f => f.endsWith('.json'));
    assert.equal(secReceiptFiles.length, 1);
    assert.equal(readFileSync(join(secReceiptDir, secReceiptFiles[0]), 'utf8').includes(fakeSecretVal), false, 'R2-2: Secret token never written into raw_output_scrubbed');

    await assert.rejects(
      () => runCodexExecMarkdown({
        prompt: 'Oversize stdout test',
        cwd: dir,
        testMode: true,
        mockExecutor: async () => ({ exitCode: 0, stdout: '# Header\n' + 'a'.repeat(2 * 1024 * 1024), stdoutBytes: 2 * 1024 * 1024 + 20 }),
      }),
      /exceeded.*capture limit/i,
      'R2-4: Truncated >2 MiB stdout is rejected instead of signed off as completed',
    );

    // R2-3: Cross-month duplicate pending payload blocked while distinct new-month payload succeeds
    let fakeNowIso = '2026-11-30T23:59:58.000Z';
    const rollLedger = openOpenAiBudgetLedger(':memory:', { testMode: true, nowFn: () => new Date(fakeNowIso) });
    rollLedger.reconcileLegacySummary(
      { recognized_schema: true, month_utc: '2026-11', file_sha256: 'e'.repeat(64), total_rows: 0, unresolved_count: 0, same_month_reserved_cents: 0 },
      { allowSyntheticSummaryForTests: true, enable: true, hardMonthlyLimitConfirmed: true, autoRechargeOffConfirmed: true },
    );
    const rollAtt1 = rollLedger.reserveBillableRequest({
      logicalRequestId: 'roll-req-1', endpoint: '/v1/responses', model: 'gpt-6.1-terra', reservedCents: 5, payloadSha256: '1'.repeat(64),
    });
    rollLedger.markPendingRecovery(rollAtt1.attempt_id, { reason: 'Client timeout at month end.' });
    fakeNowIso = '2026-12-01T00:00:03.000Z';
    assert.throws(
      () => rollLedger.reserveBillableRequest({
        logicalRequestId: 'roll-req-2-same-payload', endpoint: '/v1/responses', model: 'gpt-6.1-terra', reservedCents: 5, payloadSha256: '1'.repeat(64),
      }),
      { code: 'DUPLICATE_PENDING_PAYLOAD' },
      'R2-3: Identical unresolved payload blocked across month boundary',
    );
    const rollDistinct = rollLedger.reserveBillableRequest({
      logicalRequestId: 'roll-req-3-distinct', endpoint: '/v1/responses', model: 'gpt-6.1-terra', reservedCents: 5, payloadSha256: '2'.repeat(64),
    });
    assert.ok(rollDistinct.attempt_id, 'R2-3: Distinct new-month job proceeds without cross-month lockout');
    rollLedger.close();

    // H16 + M7: Shareable r59 HTML scrubs multi-word English recipient, US phone, and street address, and renders both Top-10 median & category avg reviews
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
    const r2HtmlBatch = structuredClone(synthBatch);
    r2HtmlBatch.profile_revision = 59;
    r2HtmlBatch.candidates = [r2HtmlBatch.candidates[0]];
    r2HtmlBatch.candidates[0].market.top10_median_reviews = 85;
    r2HtmlBatch.candidates[0].market.category_avg_reviews = 340;
    attachCandidateEvidenceReview(r2HtmlBatch.candidates[0], h16Env2, h16Pkt2, { receiptStoreDir: r2RevDir, allowTestDoubleReceipt: true });
    const r2HtmlScored = scoreBatch(r2HtmlBatch, r59Profile);
    const r2Html = renderReport(r2HtmlScored, r2HtmlBatch, { receiptStoreDir: r2RevDir, allowTestDoubleReceipts: true });
    assert.equal(r2Html.includes('Roe'), false, 'H16a: Multi-word English recipient surname scrubbed');
    assert.equal(r2Html.includes(usPhone), false, 'H16b: US phone scrubbed');
    assert.equal(r2Html.includes('Maple Street'), false, 'H16c: English street address scrubbed');
    assert.match(r2Html, /Top-10 评论中位数/, 'M7a: Top-10 median rendered');
    assert.match(r2Html, /类目平均评论数（参考）/, 'M7b: Category average rendered alongside Top-10 median');
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});

test('12. Astra Final Round-3 Sign-Off Remediations: stderr secret scrub, seasonal coupon FBA tier, distinct factory cap, exact-cent & per-scenario SP-API, volumetric carton_count, replay attribution & PII scrub', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r59-r3-signoff-'));
  try {
    const stdPkg = { length_in: 14, width_in: 10, height_in: 3, unit_weight_lb: 1.4 };

    // 1) R2-2: Secret token in stderr is scrubbed before writing stderr_scrubbed into Codex receipt (on both exitCode 0 and nonzero exit)
    const fakeSec = ['sk', 'proj', 'SyntheticStderrSecret9876543210ZYXWVU'].join('-');
    const r3SecDir = join(dir, 'r3-sec-receipts');
    const mdCleanOut = await runCodexExecMarkdown({
      prompt: 'Stderr secret test ok',
      cwd: dir,
      receiptDir: r3SecDir,
      testMode: true,
      mockExecutor: async () => ({
        exitCode: 0,
        stdout: '# Clean Markdown Output\nAll good.',
        stderr: `MCP debug header Authorization: Bearer ${fakeSec}`,
        stdoutBytes: 34,
        stderrBytes: 80,
      }),
    });
    assert.match(mdCleanOut.markdown, /Clean Markdown Output/);
    await assert.rejects(
      () => runCodexExecMarkdown({
        prompt: 'Stderr secret test fail',
        cwd: dir,
        receiptDir: r3SecDir,
        testMode: true,
        mockExecutor: async () => ({
          exitCode: 1,
          stdout: '',
          stderr: `Fatal transport header Authorization: Bearer ${fakeSec}`,
          stdoutBytes: 0,
          stderrBytes: 80,
        }),
      }),
      /exited with code 1/i,
    );
    const r3ReceiptFiles = readdirSync(r3SecDir).filter(f => f.endsWith('.json'));
    assert.equal(r3ReceiptFiles.length, 2);
    for (const rf of r3ReceiptFiles) {
      assert.equal(readFileSync(join(r3SecDir, rf), 'utf8').includes(fakeSec), false, 'R2-2: Secret token never persisted in stderr_scrubbed');
    }

    // 2) H1: Paired seasonal candidate using economics.packages (no ledger.packages) rejects understated net-band FBA fulfillment fee on ongoing coupon
    const seasCand = structuredClone(synthBatch.candidates[0]);
    const pkgRefId = seasCand.economics.scenarios[0].cost_ledger.fee_context.package_ref;
    const baseOffSc = structuredClone(seasCand.economics.scenarios[0]);
    delete baseOffSc.cost_ledger.packages;
    baseOffSc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-10-14' };
    baseOffSc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
    baseOffSc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
    baseOffSc.cost_ledger.list_price_usd = 54.99;
    baseOffSc.cost_ledger.ongoing_coupon_usd = 10.00;
    baseOffSc.cost_ledger.price_usd = 44.99;
    baseOffSc.cost_ledger.promo_basis_already_net = true;
    const wrongSeasFul = baseOffSc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    wrongSeasFul.amount_usd = 4.16; // understated <=$50 net-band fee vs >$50 list-price fee
    wrongSeasFul.fee_basis.effective_from = '2027-01-15';
    wrongSeasFul.fee_basis.effective_through = '2027-10-14';
    const builtPeriods = buildPairedSeasonalOperatingPeriods({
      saleable_unit: seasCand.economics.saleable_unit,
      off_peak_scenarios: [baseOffSc],
      cubic_feet_per_unit: (14 * 10 * 3) / 1728,
      profile_revision: 59,
    });
    seasCand.economics = {
      ...builtPeriods,
      packages: [{ id: pkgRefId, ...stdPkg }],
    };
    const scoredSeasWrong = scoreCandidate(seasCand, r59Profile);
    assert.equal(scoredSeasWrong.qualification.counts_toward_target, false, 'H1: Seasonal candidate with economics.packages rejects understated net-band coupon FBA fee');

    // 3) H2: Two SKU quotes from the SAME factory (same offer_id) count as 1 distinct factory so 2nd & 3rd factories still remain available
    const r3DbPath = join(dir, 'r3-store.sqlite');
    const r3Store = openSelectionStore(r3DbPath);
    const uiOk = { logged_in: true, viewport_width_px: 1440, selected_sku_row_visible: true, settlement_bar_visible: true, applied_quantity_confirmed: true };
    r3Store.upsertCandidateForm({
      form_id: 'form-r3-same-fac',
      label: 'Same Factory Multi-SKU',
      buyer_task: 'Hold plates',
      saleable_set_composition: [{ component_id: 'stand', qty_per_saleable_set: 1 }],
    });
    await runGate1AForForm(r3Store, {
      form_id: 'form-r3-same-fac',
      profile_revision: 59,
      scenarios: [{
        id: 'sc-sf1',
        price_usd: 42.00,
        pkg: stdPkg,
        fx_cny_per_usd: 7.2,
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        fee_category: 'Home and Kitchen',
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        headhaul_usd: 1.8,
        collection_rate: 0.006,
      }],
    });
    // Persist 2 uncompetitive SKU quotes from the SAME verified 1688 factory ('fac-1', 'offer-same-factory-1')
    for (const idx of [1, 2]) {
      r3Store.recordSourcingQuote1688({
        quote_id: `q-samefac-${idx}`,
        form_id: 'form-r3-same-fac',
        factory_id: 'fac-1',
        spec_variant_key: `sku-var-${idx}`,
        observed_at: '2026-11-24',
        redacted_destination: '广东深圳',
        raw_readback_ref: `ev-sf-${idx}`,
        fx_cny_per_usd: 7.2,
        pkg: stdPkg,
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        ui_readback: uiOk,
        sku_lines: [{ component_id: 'stand', offer_id: 'offer-same-factory-1', sku_id: `sku-${idx}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 155 + idx, regular_goods_promo_false: true }],
        goods_cny_total: (155 + idx) * 100,
        domestic_freight_cny_total: 180,
      });
    }
    const g1bSameFac = await runGate1BForForm(r3Store, {
      form_id: 'form-r3-same-fac',
      profile_revision: 59,
      as_of_date: '2026-11-24',
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: {
          quote_id: 'q-fac2-fail',
          factory_id: 'fac-2',
          spec_variant_key: 'sku-var-fac2',
          observed_at: '2026-11-24',
          redacted_destination: '广东深圳',
          raw_readback_ref: 'ev-sf-3',
          fx_cny_per_usd: 7.2,
          pkg: stdPkg,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          ui_readback: uiOk,
          sku_lines: [{ component_id: 'stand', offer_id: 'offer-second-factory-2', sku_id: 'sku-f2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 150, regular_goods_promo_false: true }],
          goods_cny_total: 15000,
          domestic_freight_cny_total: 180,
        },
      }),
      early_screen_builder: ({ form }) => {
        const ds = JSON.parse(form.gate1a_result_json).declared_scenarios;
        return [{
          id: ds[0].id, saleable_unit: '1 unit', price_usd: 42.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
          headhaul: { usd_per_unit: 1.8, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0,
          is_apparel_or_shoes: false, referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          fulfillment_usd: ds[0].fulfillment_usd, placement_usd: ds[0].placement_range_usd[1],
          storage: { cubic_feet_per_unit: (14 * 10 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
          operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
          collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
        }];
      },
    });
    assert.equal(g1bSameFac.checked_factory_quotes_count, 2, 'H2: 2 SKU quotes on factory #1 + 1 quote on factory #2 = 2 distinct factories');
    assert.equal(g1bSameFac.second_factory_quote_needed, true, 'H2: 3rd distinct factory remains available');

    // 4) M4: replayBatchIntoStore preserves replaySpecSha in evaluation receipt even when live form spec was upgraded
    const cand0Id = synthBatch.candidates[0].id;
    r3Store.upsertCandidateForm({
      form_id: cand0Id,
      label: 'Upgraded 2-Pack Spec',
      buyer_task: synthBatch.candidates[0].buyer_task ?? 'Upgraded task',
      saleable_set_composition: { saleable_unit: '2-pack upgraded set' },
    });
    const upgradedLiveForm = r3Store.getCandidateForm(cand0Id);
    replayBatchIntoStore(r3Store, {
      batch: synthBatch,
      profile: r59Profile,
    });
    const repEv = r3Store.getEvaluationsForForm(cand0Id)[0];
    assert.ok(repEv, 'M4: Replayed evaluation persisted');
    const repReceipt = JSON.parse(repEv.receipt_json);
    assert.notEqual(repReceipt.form_spec_sha256, upgradedLiveForm.spec_sha256, 'M4: Historical 1-pack replay receipt records replaySpecSha rather than upgraded live 2-pack spec_sha256');
    r3Store.close();

    // 5) H3 + H4: Exact-cent matching blocks $90.01 vs $90.02 collision, QuotaExceeded receipt isolated in ingestTrialSpecification, and per-scenario tiered referral applied
    const adjCentCal = extractSpApiFinalistCalibration({
      asin: 'B0SYNR3SP1',
      price_usd: 90.02,
      feesEstimateRaw: {
        FeesEstimateResult: {
          Status: 'Success',
          FeesEstimateIdentifier: { IdValue: 'B0SYNR3SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 90.01 } } },
          FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 18.50 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 13.50 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
      },
    });
    assert.equal(adjCentCal.fee_calibration_status, 'unmatched', 'H3: $90.01 SP-API receipt must not match $90.02 query');

    const rawMarketPath = join(dir, 'ss-market.json');
    const rawSpQuotaPath = join(dir, 'sp-quota-err.json');
    const rawSpTieredPath = join(dir, 'sp-tiered-fees.json');
    writeFileSync(rawMarketPath, JSON.stringify({ items: [{ asin: 'B0SYNR3SP1', price: 80.00, monthlySales: 120 }, { asin: 'B0SYNR3SP2', price: 120.00, monthlySales: 90 }] }), 'utf8');
    writeFileSync(rawSpQuotaPath, JSON.stringify({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] }), 'utf8');
    writeFileSync(rawSpTieredPath, JSON.stringify({
      FeesEstimateResultList: [
        {
          Status: 'Success',
          FeesEstimateIdentifier: { IdValue: 'B0SYNR3SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 80.00 } } },
          FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 17.00 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 12.00 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
        {
          Status: 'Success',
          FeesEstimateIdentifier: { IdValue: 'B0SYNR3SP1', MarketplaceId: 'ATVPDKIKX0DER', IsAmazonFulfilled: true, PriceToEstimateFees: { ListingPrice: { CurrencyCode: 'USD', Amount: 120.00 } } },
          FeesEstimate: { TotalFeesEstimate: { CurrencyCode: 'USD', Amount: 19.40 }, FeeDetailList: [{ FeeType: 'ReferralFee', FinalFee: { Amount: 14.40 } }, { FeeType: 'FBAFees', FinalFee: { Amount: 5.00 } }] },
        },
      ],
    }), 'utf8');

    const makeTieredCand = (id) => {
      const c = structuredClone(synthBatch.candidates[0]);
      c.id = id;
      c.screening.reference_price_usd = {
        ...c.screening.reference_price_usd,
        value: 80.00,
        supported_price_range: [80.00, 120.00],
        matched_spec: true,
        target_variant_asin: 'B0SYNR3SP1',
      };
      const sc80 = structuredClone(c.economics.scenarios[0]);
      sc80.id = 'sc-80';
      sc80.package_source = 'factory_quote';
      sc80.cost_ledger.price_usd = 80.00;
      const sc120 = structuredClone(c.economics.scenarios[0]);
      sc120.id = 'sc-120';
      sc120.package_source = 'factory_quote';
      sc120.cost_ledger.price_usd = 120.00;
      sc120.price_anchor = { target_variant_asin: 'B0SYNR3SP2' };
      c.economics.scenarios = [sc80, sc120];
      c.economics.expected_primary_scenarios = [{ id: 'sc-80', status: 'active' }, { id: 'sc-120', status: 'active' }];
      return c;
    };

    const quotaIngested = ingestTrialSpecification({
      batch_id: 'b-r3-sp',
      evaluated_at: '2026-11-24',
      profile_revision: 59,
      allow_synthetic_fixture_ids: true,
      raw_receipt_files: ['ss-market.json', 'sp-quota-err.json', 'sp-tiered-fees.json'],
      evidence: synthBatch.evidence,
      candidates: [
        { candidate: makeTieredCand('cand-sp-quota'), raw_receipt_files: ['ss-market.json', 'sp-quota-err.json'] },
        { candidate: makeTieredCand('cand-sp-tiered'), raw_receipt_files: ['ss-market.json', 'sp-tiered-fees.json'] },
      ],
    }, r59Profile, { baseDir: dir });

    const qCand = quotaIngested.batch.candidates.find(c => c.id === 'cand-sp-quota');
    assert.equal(qCand.ingest_isolated_pending, true, 'H4a: Upstream SP-API QuotaExceeded receipt isolates candidate to pending');
    const tCand = quotaIngested.batch.candidates.find(c => c.id === 'cand-sp-tiered');
    assert.equal(tCand.ingest_isolated_pending ?? false, false);
    const ref80 = tCand.economics.scenarios.find(s => s.id === 'sc-80').cost_ledger.referral_terms.referral_fraction;
    const ref120 = tCand.economics.scenarios.find(s => s.id === 'sc-120').cost_ledger.referral_terms.referral_fraction;
    assert.equal(ref80, 0.15, 'H4b: $80 factory_quote scenario gets 15% SP-API referral rate ($12/$80)');
    assert.equal(ref120, 0.12, 'H4c: $120 factory_quote scenario gets 12% tiered SP-API referral rate ($14.40/$120)');

    // 6) H7 + H9 + H11 + H14 + H15 + M8: Chinese connection failure blocked, 5%->40% coupon distortion blocked, volumetric carton_cm missing carton_count held pending, [2..9] months preserved, r58 Gate-0 preserved
    const cnFailRes = resolveStage1QualitativeJudgments({
      rights_prescreen: {
        specific_design_rights: { status: 'needs_verification', summary: 'USPTO 专利库连接失败，暂不可用，未能查验公开外观专利。' },
        applicable_public_requirements: { status: 'no_public_hit_observed', frameworks_checked: ['NONE_IDENTIFIED'], summary: 'Checked.' },
      },
    });
    assert.equal(cnFailRes.judgments.specific_design_rights.prescreen_completed, false, 'H7: Chinese 连接失败/未能查验 summary is NOT marked prescreen_completed:true');

    assert.throws(
      () => parseMarketObservationResult({
        schema_version: 1, contract: 'MarketObservationJudge', form_id: 'form-r3-cpn-distort',
        peer_observations: [{
          asin: 'B0SYNR3CPN',
          mandatory_facts: { observed_price_usd: 39.99, keepa_high_usd: null, keepa_low_usd: null, review_count: null, keepa_90d_trend: '未提供', coupon_status: '40% OFF 大额券', review_curve_change: '未提供', key_appearance_and_dims: '未提供' },
          qualitative_judgment: { bucket: 'heavy_promo_coupon', include_in_primary_band: false, keep_in_observation_bar: true, reason_zh: '测试篡改优惠券比例拦截。' },
        }],
        market_summary_zh: '测试券比例核验。',
      }, { form_id: 'form-r3-cpn-distort', peers: [{ asin: 'B0SYNR3CPN', price_usd: 39.99, coupon_pct: 5, coupon_text: 'Save 5% with coupon' }] }),
      /distorted|coupon_status/i,
      'H9: 5% coupon distorted into 40% OFF in coupon_status is rejected',
    );

    const volMissingCntEv = evaluateEarlyScreen({
      profile_revision: 59, id: 'sc-vol-nocnt', saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
      procurement: { cny_per_unit: 40, order_units: 100, first_order_promotion: false },
      domestic_freight: { cny_per_shipment: 150, order_units: 100, first_order_promotion: false },
      headhaul: { actual_weight_kg_per_unit: 0.5, chargeable_kg_per_unit: 0.5, carton_cm: { length_cm: 60, width_cm: 50, height_cm: 40 }, rate_cny_per_kg: 12, bond_cny_per_kg: 0, order_units: 100 },
      refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
      fulfillment_usd: 4.50, placement_usd: 0.40,
      storage: { cubic_feet_per_unit: 0.2, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
      collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
    }, { profileRevision: 59 });
    assert.equal(volMissingCntEv.ledger.margin, null, 'H11: Volumetric carton_cm without carton_count holds headhaul pending instead of silently assuming 100 cartons');

    assert.equal(builtPeriods.operating_periods[0].months.includes(10), false, 'H14: Paired off_peak months remain [2..9] without falsely claiming full-October storage coverage');
    assert.throws(() => evaluateGate0CategoryBoundary({ title: 'Diaper Bag Backpack for Mom with Toddler Pocket' }, { profile_revision: 58 }), /retired/i, 'H15 closed: r58 Gate-0 branch retired');
    assert.equal(evaluateGate0CategoryBoundary({ title: 'Nursery Shelving Unit for Closet Organization' }, { profile_revision: 59 }).hard_exclusion, false, 'H12: Nursery shelving exempted in r59');

    // 7) H16: Shareable HTML scrubs comma-inverted recipient ('Roe, Jane'), dot-separated US phone ('415.555.0199'), and uppercase abbreviated street ('1234 MAPLE ST')
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
    const r3HtmlBatch = structuredClone(synthBatch);
    r3HtmlBatch.profile_revision = 59;
    r3HtmlBatch.candidates = [r3HtmlBatch.candidates[0]];
    attachCandidateEvidenceReview(r3HtmlBatch.candidates[0], r3Env, r3Pkt, { receiptStoreDir: r3RevDir, allowTestDoubleReceipt: true });
    const r3Html = renderReport(scoreBatch(r3HtmlBatch, r59Profile), r3HtmlBatch, { receiptStoreDir: r3RevDir, allowTestDoubleReceipts: true });
    assert.equal(r3Html.includes('Roe, Jane'), false, 'H16d: Comma-inverted recipient name scrubbed');
    assert.equal(r3Html.includes(dotPhone), false, 'H16e: Dot-separated US phone scrubbed');
    assert.equal(r3Html.includes('1234 MAPLE ST'), false, 'H16f: Uppercase abbreviated street address scrubbed');
  } finally {
    try {
      const makeWritable = p => {
        try { chmodSync(p, 0o700); } catch { /* ignore */ }
        try {
          if (statSync(p).isDirectory()) {
            for (const f of readdirSync(p)) makeWritable(join(p, f));
          }
        } catch { /* ignore */ }
      };
      makeWritable(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
    } catch { /* ignore Windows AV file lock */ }
  }
});
