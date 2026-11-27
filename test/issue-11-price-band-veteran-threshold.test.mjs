import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUSINESS_THRESHOLDS } from '../src/business-thresholds.mjs';
import { analyzeMainstreamPriceBand } from '../src/price-band.mjs';
import { runGate1AForForm } from '../src/pipeline.mjs';
import { openSelectionStore } from '../src/store.mjs';
import {
  STAGE4_AS_OF_DATE,
  makeGate1AScenario,
  makeSteadyPeer,
  registerStage4Form,
} from './helpers/stage4-fixtures.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Issue #11: approved registry value (2) supplements with 0/1 veterans, stops with 2 veterans, and keeps <59 replay on archive tag', () => {
  assert.equal(BUSINESS_THRESHOLDS.min_veterans_before_growth_supplement, 2);

  const vet1 = makeSteadyPeer({ asin: 'B0SYNVET01', priceUsd: 49.99, ageDays: 420 });
  const vet2 = makeSteadyPeer({ asin: 'B0SYNVET02', priceUsd: 54.99, ageDays: 510 });
  const growth1 = makeSteadyPeer({ asin: 'B0SYNGRW01', priceUsd: 39.99, ageDays: 180 });

  // 0 eligible >=365d veterans -> supplements with steady 91-364d growth peer
  const zeroVetBand = analyzeMainstreamPriceBand([growth1], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(zeroVetBand.growth_supplement_used, true);
  assert.deepEqual(zeroVetBand.mainstream_pool.map(r => r.asin), ['B0SYNGRW01']);

  // 1 eligible >=365d veteran (< 2) -> supplements with steady 91-364d growth peer
  const oneVetBand = analyzeMainstreamPriceBand([vet1, growth1], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(oneVetBand.growth_supplement_used, true);
  assert.equal(oneVetBand.mature_regular_band.growth_supplement_used, true);
  assert.equal(oneVetBand.mature_regular_band.basis, 'veteran_ge_365d_plus_steady_growth_91_364d_supplement');
  assert.deepEqual(oneVetBand.mainstream_pool.map(r => r.asin).sort(), ['B0SYNGRW01', 'B0SYNVET01']);
  assert.equal(oneVetBand.mature_regular_band.min_usd, 39.99);
  assert.equal(oneVetBand.mature_regular_band.max_usd, 49.99);

  // 2 eligible >=365d veterans (>= 2) -> stops supplementing and parks growth peer in observation bar
  const twoVetBand = analyzeMainstreamPriceBand([vet1, vet2, growth1], { as_of_date: STAGE4_AS_OF_DATE });
  assert.equal(twoVetBand.growth_supplement_used, false);
  assert.equal(twoVetBand.mature_regular_band.growth_supplement_used, false);
  assert.equal(twoVetBand.mature_regular_band.basis, 'veteran_ge_365d_keepa_steady');
  assert.deepEqual(twoVetBand.mainstream_pool.map(r => r.asin).sort(), ['B0SYNVET01', 'B0SYNVET02']);
  assert.equal(twoVetBand.mature_regular_band.min_usd, 49.99);
  assert.equal(twoVetBand.mature_regular_band.max_usd, 54.99);
  const heldGrowth = twoVetBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNGRW01');
  assert.ok(heldGrowth, 'Growth peer must remain visible in observed_out_of_band_peers when >=2 veterans anchor the band');
  assert.equal(heldGrowth.reason_code, 'growth_stage_held_veterans_sufficient');

  // Verify string-typed CLI options.spiral_max_age_days ("90") formats "91–364" rather than "901–364"
  const strOptBand = analyzeMainstreamPriceBand([vet1, vet2, growth1], { as_of_date: STAGE4_AS_OF_DATE, spiral_max_age_days: '90' });
  assert.match(
    strOptBand.observed_out_of_band_peers.find(p => p.asin === 'B0SYNGRW01')?.reason_zh ?? '',
    /91–364 天/,
  );

  // Verify real Gate 1A caller reflects 0/1/2-veteran supplementation when anchored on the growth peer ($39.99)
  const store = openSelectionStore(':memory:');
  try {
    const formId = registerStage4Form(store, { formId: 'form-issue11-vet-threshold' });
    const growthScenario = makeGate1AScenario({ asin: 'B0SYNGRW01', priceUsd: 39.99, ageDays: 180 });
    const baseGate1A = { form_id: formId, profile_revision: 59, scenarios: [growthScenario] };
    const g1aZeroVet = runGate1AForForm(store, {
      ...baseGate1A,
      price_band_analysis: { listings: [growth1], options: { as_of_date: STAGE4_AS_OF_DATE } },
    });
    const g1aOneVet = runGate1AForForm(store, {
      ...baseGate1A,
      price_band_analysis: { listings: [vet1, growth1], options: { as_of_date: STAGE4_AS_OF_DATE } },
    });
    const g1aTwoVet = runGate1AForForm(store, {
      ...baseGate1A,
      price_band_analysis: { listings: [vet1, vet2, growth1], options: { as_of_date: STAGE4_AS_OF_DATE } },
    });
    assert.equal(g1aZeroVet.proceed_to_gate1b, true);
    assert.equal(g1aZeroVet.regular_band_reference?.growth_supplement_used, true);
    assert.equal(g1aOneVet.proceed_to_gate1b, true);
    assert.equal(g1aOneVet.regular_band_reference?.growth_supplement_used, true);
    assert.equal(g1aOneVet.regular_band_reference?.min_usd, 39.99);
    assert.equal(g1aTwoVet.proceed_to_gate1b, false);
    assert.equal(g1aTwoVet.regular_band_reference?.growth_supplement_used, false);
    assert.equal(g1aTwoVet.regular_band_reference?.min_usd, 49.99);
  } finally {
    store.close();
  }

  // Historical <59 replay stays retired on Git tag archive/r50-r58-frozen-replay-20261125
  assert.throws(
    () => analyzeMainstreamPriceBand([vet1, growth1], { profile_revision: 58, as_of_date: STAGE4_AS_OF_DATE }),
    /profile_revision 58.*retired/i,
  );
});

test('Issue #11: isolated registry mutation of min_veterans_before_growth_supplement (2 -> 3) dynamically shifts price-band supplementation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue11-veteran-threshold-'));
  try {
    const tmpSrc = join(dir, 'src');
    cpSync(join(REPO_ROOT, 'src', 'rates'), join(tmpSrc, 'rates'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'utils'), join(tmpSrc, 'utils'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'adapters'), join(tmpSrc, 'adapters'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src', 'business-thresholds.mjs'), join(tmpSrc, 'business-thresholds.mjs'));
    cpSync(join(REPO_ROOT, 'src', 'fba-calculator.mjs'), join(tmpSrc, 'fba-calculator.mjs'));
    cpSync(join(REPO_ROOT, 'src', 'price-band.mjs'), join(tmpSrc, 'price-band.mjs'));

    const thresholdsPath = join(tmpSrc, 'business-thresholds.mjs');
    const orig = readFileSync(thresholdsPath, 'utf8');
    const mutated = orig.replace(
      /(min_veterans_before_growth_supplement:\s*\{\s*value:\s*)2(\s*,)/,
      '$13$2',
    );
    assert.notEqual(mutated, orig, 'Expected min_veterans_before_growth_supplement value: 2 in src/business-thresholds.mjs');
    writeFileSync(thresholdsPath, mutated, 'utf8');

    const isoThresholds = await import(pathToFileURL(thresholdsPath).href);
    const isoPriceBand = await import(pathToFileURL(join(tmpSrc, 'price-band.mjs')).href);
    assert.equal(isoThresholds.BUSINESS_THRESHOLDS.min_veterans_before_growth_supplement, 3);

    const vet1 = makeSteadyPeer({ asin: 'B0SYNVET01', priceUsd: 49.99, ageDays: 420 });
    const vet2 = makeSteadyPeer({ asin: 'B0SYNVET02', priceUsd: 54.99, ageDays: 510 });
    const vet3 = makeSteadyPeer({ asin: 'B0SYNVET03', priceUsd: 59.99, ageDays: 600 });
    const growth1 = makeSteadyPeer({ asin: 'B0SYNGRW01', priceUsd: 39.99, ageDays: 180 });

    const twoVetMutated = isoPriceBand.analyzeMainstreamPriceBand([vet1, vet2, growth1], { as_of_date: STAGE4_AS_OF_DATE });
    assert.equal(twoVetMutated.growth_supplement_used, true, 'Branch must read mutated threshold 3 so 2 veterans still supplement');
    assert.deepEqual(
      twoVetMutated.mainstream_pool.map(r => r.asin).sort(),
      ['B0SYNGRW01', 'B0SYNVET01', 'B0SYNVET02'],
    );

    const threeVetMutated = isoPriceBand.analyzeMainstreamPriceBand([vet1, vet2, vet3, growth1], { as_of_date: STAGE4_AS_OF_DATE });
    assert.equal(threeVetMutated.growth_supplement_used, false, 'Branch must stop supplementing once veteran count reaches mutated threshold 3');
    assert.deepEqual(
      threeVetMutated.mainstream_pool.map(r => r.asin).sort(),
      ['B0SYNVET01', 'B0SYNVET02', 'B0SYNVET03'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
