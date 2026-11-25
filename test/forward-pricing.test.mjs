import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateGate1A2027, solveMinPriceForMargin2027 } from '../src/fba-calculator.mjs';
import { runGate1AForForm, runGate1BForForm, runOptionalRightsPreScreen } from '../src/pipeline.mjs';
import { analyzeMainstreamPriceBand, tightenClusterBands } from '../src/price-band.mjs';
import { openSelectionStore } from '../src/store.mjs';

function scenario(overrides = {}) {
  return {
    profile_revision: 59,
    id: 'offpeak',
    price_usd: 39.99,
    pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 },
    fx_cny_per_usd: 7,
    refund_fraction: 0.04,
    fee_category: 'Tools & Home Improvement',
    referral_terms: {
      referral_fraction: 0.15,
      refund_admin_fraction: 0.20,
      refund_admin_cap_usd: 5,
      minimum_referral_usd: 0.30,
    },
    headhaul_usd: 2.20,
    collection_rate: 0.006,
    sales_window: { from: '2027-02-01', through: '2027-10-14' },
    storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-20', through: '2027-02-01' },
    ...overrides,
  };
}

function register(store, id) {
  store.upsertCandidateForm({
    form_id: id,
    product_family_key: id,
    label: 'Steel marking jig',
    buyer_task: 'Repeat a workpiece measurement',
    saleable_set_composition: { component_id: 'jig', qty_per_saleable_set: 1 },
  });
}

function quoteFor(store, formId, overrides = {}) {
  return store.recordSourcingQuote1688({
    form_id: formId,
    observed_at: '2026-11-22',
    redacted_destination: 'Shenzhen',
    goods_first_order_promotion: false,
    freight_first_order_promotion: false,
    sku_lines: [{
      component_id: 'jig',
      offer_id: 'fixture-offer',
      sku_id: 'fixture-sku',
      qty_per_saleable_set: 1,
      pack_multiple: 120,
      moq_qty: 120,
      ordered_qty: 120,
      unit_price_cny: 110,
      regular_goods_promo_false: true,
    }],
    target_sets: 100,
    actual_sets: 120,
    actual_complete_sets: 120,
    goods_cny_total: 13200,
    domestic_freight_cny_total: 120,
    raw_readback_ref: 'fixture:carton-quote',
    ui_readback: {
      logged_in: true,
      viewport_width_px: 1440,
      selected_sku_row_visible: true,
      settlement_bar_visible: true,
      applied_quantity_confirmed: true,
    },
    ...overrides,
  }).quote;
}

test('heavy single-coupon discounts at the >=20% r59 boundary and <=90d newcomers stay outside regular and cluster price bands', () => {
  const base = { fulfillment: 'FBA', age_days: 400, keepa_price_steady: true, monthly_units: 40 };
  const listings = [
    { ...base, asin: 'COUPON-A', list_price_usd: 30, net_price_usd: 24.00, monthly_units: 800 },
    { ...base, asin: 'COUPON-B', list_price_usd: 32, net_price_usd: 24.90, monthly_units: 500 },
    { ...base, asin: 'REGULAR-A', price_usd: 29.99, keepa_90d_median_usd: 35.27 },
    { ...base, asin: 'REGULAR-B', price_usd: 31.99 },
    { ...base, asin: 'YOUNG-A', age_days: 40, price_usd: 30.99, keepa_90d_median_usd: 40 },
  ];
  const analysis = analyzeMainstreamPriceBand(listings, { profile_revision: 59 });
  assert.deepEqual(analysis, analyzeMainstreamPriceBand([...listings].reverse(), { profile_revision: 59 }));
  assert.deepEqual(analysis.spiral_watch.map(r => [r.asin, r.watch_reasons]), [
    ['COUPON-A', ['heavy_coupon_outlier']],
    ['COUPON-B', ['heavy_coupon_outlier']],
    ['YOUNG-A', ['newcomer_le_90d_launch_ref']],
  ]);
  assert.equal(analysis.regular_band_reference.basis, 'veteran_ge_365d_keepa_steady');
  assert.equal(analysis.regular_band_reference.min_usd, 29.99);
  assert.equal(analysis.regular_band_reference.max_usd, 31.99);
  assert.equal(analysis.regular_band_reference.peer_count, 2);
  const tightened = tightenClusterBands(analysis, [{ asins: listings.map(row => row.asin) }]);
  assert.equal(tightened.clusters[0].band.min_usd, 29.99);
  assert.deepEqual(tightened.clusters[0].spiral_watch_asins, ['COUPON-A', 'COUPON-B', 'YOUNG-A']);
});

test('Gate 1A ignores pre-quote guesses and requires regular price or non-domestic cost proof to reject', t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  register(store, 'gate-proof');
  const guess = scenario({ min_landed_domestic_usd: 100, domestic_freight_usd: 99, margin_floor: 0.90 });
  const admitted = runGate1AForForm(store, { form_id: 'gate-proof', profile_revision: 59, scenarios: [guess] });
  assert.equal(admitted.proceed_to_gate1b, true);
  assert.equal(admitted.landed_domestic_cap_advisory_only, true);
  assert.ok(admitted.best_landed_domestic_cap_cny > 0);
  assert.equal(admitted.scenarios[0].estimate.bare_goods_cap_usd, null);
  assert.equal(admitted.scenarios[0].estimate.non_domestic_cost_exceeds_70pct_at_zero_goods, false);

  const gross = runGate1AForForm(store, {
    form_id: 'gate-proof',
    profile_revision: 59,
    scenarios: [scenario({ headhaul_usd: 100 })],
  });
  assert.equal(gross.gate_status, 'gate1a_rejected');
  assert.equal(gross.reason_code, 'non_domestic_cost_exceeds_70pct_at_zero_goods');

  const promo = scenario({ price_usd: 24.00, age_days: 150, keepa_90d_median_usd: 30 });
  const isolated = runGate1AForForm(store, { form_id: 'gate-proof', profile_revision: 59, scenarios: [promo] });
  assert.equal(isolated.gate_status, 'gate1a_needs_verification');
  assert.equal(isolated.scenarios[0].holiday_or_event_promo_outlier, true);

  const priceFloor = runGate1AForForm(store, {
    form_id: 'gate-proof',
    profile_revision: 59,
    scenarios: [scenario({ price_usd: 29.98 })],
  });
  assert.equal(priceFloor.reason_code, 'all_regular_scenario_prices_below_floor');
});

test('Gate 1A isolates the observed watch prices while retaining a different regular price for the same peer', t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  const formId = 'watched-prices';
  register(store, formId);
  const base = { fulfillment: 'FBA', age_days: 400, keepa_price_steady: true, monthly_units: 40 };
  const listings = [
    { ...base, asin: 'LAUNCH', age_days: 45, price_usd: 21 },
    { ...base, asin: 'COUPON', list_price_usd: 40, net_price_usd: 22 },
    { ...base, asin: 'YOUNG-COUPON', age_days: 45, list_price_usd: 35, net_price_usd: 28 },
    { ...base, asin: 'REG-A', price_usd: 28 },
    { ...base, asin: 'REG-B', price_usd: 28.50 },
  ];
  const watched = listings.slice(0, 3).map(peer => scenario({
    id: peer.asin, asin: peer.asin.toLowerCase(), price_usd: peer.net_price_usd ?? peer.price_usd,
  }));
  const held = runGate1AForForm(store, { form_id: formId, profile_revision: 59, scenarios: watched, price_band_analysis: listings });
  assert.equal(held.gate_status, 'gate1a_needs_verification');
  assert.deepEqual(held.scenarios.map(s => s.price_basis), [
    'newcomer_le_90d_launch_ref', 'heavy_coupon_outlier', 'young_heavy_coupon_outlier',
  ]);
  const listingsWithSteadyPeer = [...listings, { ...base, asin: 'REG-STEADY', price_usd: 40 }];
  const admitted = runGate1AForForm(store, {
    form_id: formId,
    profile_revision: 59,
    scenarios: [...watched, scenario({ id: 'regular-readback', asin: 'REG-STEADY', price_usd: 40 })],
    price_band_analysis: listingsWithSteadyPeer,
  });
  assert.equal(admitted.proceed_to_gate1b, true);
  assert.deepEqual(admitted.declared_scenarios.map(s => s.id), ['regular-readback']);
  const explicit = runGate1AForForm(store, {
    form_id: formId, profile_revision: 59, scenarios: [scenario({ price_usd: 21, price_basis: 'launch_spiral_low_price' })],
  });
  assert.equal(explicit.gate_status, 'gate1a_needs_verification');
});

test('cold-start Gate 1B prices a persisted carton quote over declared non-peak scenarios without qualifying', async t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  register(store, 'forward-cold');
  const formId = 'forward-cold';
  const low = scenario({ id: 'base', price_usd: null, headhaul_usd: 2.20 });
  const high = scenario({ id: 'freight-stress', price_usd: 24.99, headhaul_usd: 9.50 });
  const peak = scenario({ id: 'peak', price_usd: null, sales_window: { from: '2027-10-15', through: '2027-12-31' } });
  const g1a = runGate1AForForm(store, {
    form_id: formId,
    profile_revision: 59,
    scenarios: [low, high, peak],
    allow_forward_price_discovery: true,
  });
  assert.equal(g1a.proceed_to_gate1b, true);
  assert.equal(g1a.forward_price_discovery_only, true);
  assert.equal(g1a.best_landed_domestic_cap_cny, null);
  assert.deepEqual(g1a.declared_scenarios, []);
  assert.equal(g1a.scenarios[0].price_usd, null);

  const quote = quoteFor(store, formId);
  assert.equal(Object.hasOwn(quote, 'pkg'), false);
  assert.equal(Object.hasOwn(quote, 'fx_cny_per_usd'), false);
  const outcome = await runGate1BForForm(store, {
    form_id: formId,
    profile_revision: 59,
    existing_quote: { ...quote, goods_cny_total: 120 },
    as_of_date: '2026-11-22',
    early_screen_builder: () => { assert.fail('Cold start cannot run the actual-price margin builder.'); },
  });
  assert.equal(outcome.status, 'gate1b_pending');
  assert.equal(outcome.proceed_to_gate2_3, false);
  const pricing = outcome.forward_pricing;
  assert.equal(pricing.status, 'verified');
  assert.equal(pricing.advisory_only, true);
  assert.equal(pricing.quote_id, quote.quote_id);
  assert.equal(pricing.actual_sets, 120);
  assert.deepEqual(pricing.skipped_peak_scenario_ids, ['peak']);
  assert.ok(pricing.feasible_min_price_usd > 50);
  assert.equal(pricing.min_retail_price_for_30pct_usd, pricing.feasible_min_price_usd);
  for (const [i, input] of [low, high].entries()) {
    const point = pricing.scenario_results[i];
    assert.deepEqual(point.pricing_input_basis, { pkg: 'scenario_assumption', fx_cny_per_usd: 'scenario_assumption' });
    assert.equal(point.landed_domestic_cny_per_set, 111);
    assert.equal(point.feasible_min_price_usd,
      solveMinPriceForMargin2027({ ...input, landed_domestic_quote: quote }).feasible_min_price_usd);
    const atSharedPrice = estimateGate1A2027({
      ...input,
      price_usd: pricing.feasible_min_price_usd,
      min_landed_domestic_usd: 111 / 7,
    });
    assert.equal(atSharedPrice.zero_browser_fail, false);
  }
  assert.deepEqual(JSON.parse(store.getCandidateForm(formId).gate1b_result_json).forward_pricing, pricing);
});

test('Gate 1B uses a persisted saleable package and FX for a cold-start scenario missing both', async t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  const formId = 'quote-only-fee-basis';
  register(store, formId);
  const fees = scenario({ price_usd: null, pkg: undefined, fx_cny_per_usd: undefined });
  runGate1AForForm(store, { form_id: formId, profile_revision: 59, scenarios: [fees], allow_forward_price_discovery: true });
  const pkg = { length_in: 10, width_in: 6, height_in: 2, weight_lb: 5 };
  const quote = quoteFor(store, formId, { pkg: { ...pkg, unsupported_note: 'discarded fixture' }, fx_cny_per_usd: 6 });
  assert.deepEqual(quote.pkg, pkg);
  assert.deepEqual(store.getQuotesForForm(formId), [quote]);
  assert.equal(quote.fx_cny_per_usd, 6);
  const outcome = await runGate1BForForm(store, {
    form_id: formId,
    profile_revision: 59,
    existing_quote: { ...quote, pkg: scenario().pkg, fx_cny_per_usd: 7 },
    as_of_date: '2026-11-22',
  });
  assert.equal(outcome.proceed_to_gate2_3, false);
  const solved = solveMinPriceForMargin2027({ ...fees, landed_domestic_quote: quote });
  const baseline = solveMinPriceForMargin2027({ ...scenario(), landed_domestic_cny: 111 });
  assert.equal(solved.status, 'verified');
  assert.equal(solved.landed_domestic_usd, 18.5);
  assert.ok(solved.feasible_min_price_usd > baseline.feasible_min_price_usd);
  assert.deepEqual(solved.pricing_input_basis, { pkg: 'quote', fx_cny_per_usd: 'quote' });
  assert.equal(outcome.forward_pricing.feasible_min_price_usd, solved.feasible_min_price_usd);
  assert.deepEqual(outcome.forward_pricing.scenario_results[0].pricing_input_basis, solved.pricing_input_basis);
  assert.equal(solveMinPriceForMargin2027({ ...fees, landed_domestic_quote: quote, fx_cny_per_usd: 7 }).status,
    'needs_calculator_verification');
});

test('Gate 1B blocks package or FX conflicts in any declared scenario before the early screen', async t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  const equivalentQuotePkg = { length_cm: 25.4, width_cm: 15.24, height_cm: 5.08, weight_oz: 28 };
  for (const [key, override, reason] of [
    ['pkg', { pkg: scenario().pkg }, /pkg dimensions or weight conflict/],
    ['fx', { fx_cny_per_usd: 7 }, /fx_cny_per_usd conflicts/],
  ]) {
    const formId = `quoted-${key}-conflict`;
    register(store, formId);
    const base = scenario({ id: 'basis-matches', pkg: { ...scenario().pkg, weight_lb: 1.75 }, fx_cny_per_usd: 6.9 });
    const conflicting = { ...base, id: 'basis-conflicts', ...override };
    const admitted = runGate1AForForm(store, { form_id: formId, profile_revision: 59, scenarios: [base, conflicting] });
    assert.deepEqual(admitted.declared_scenarios.map(s => s.id), [base.id, conflicting.id]);
    const quote = quoteFor(store, formId, { pkg: equivalentQuotePkg, fx_cny_per_usd: 6.9 });
    const outcome = await runGate1BForForm(store, {
      form_id: formId,
      profile_revision: 59,
      existing_quote: quote,
      as_of_date: '2026-11-22',
      allow_crossing_to_gate2_3: true,
      early_screen_builder: () => { assert.fail('Conflicting verified quote must stop before early-screen.'); },
    });
    assert.equal(outcome.status, 'gate1b_pending');
    assert.equal(outcome.proceed_to_gate2_3, false);
    assert.match(outcome.reason, reason);
    assert.equal(outcome.forward_pricing.status, 'needs_calculator_verification');
    assert.equal(outcome.forward_pricing.feasible_min_price_usd, null);
    assert.deepEqual(outcome.forward_pricing.quote_basis_issues.map(issue => issue.id), [conflicting.id]);
    assert.equal(outcome.forward_pricing.scenario_results[0].status, 'verified');
  }
});

test('invalid supplied quote measurements or FX cannot disappear into scenario assumptions', t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  const formId = 'invalid-quote-basis';
  register(store, formId);
  const quote = quoteFor(store, formId);
  for (const [override, reason] of [
    [{ pkg: { weight_lb: 1.5 } }, /positive dimensions and weight/],
    [{ fx_cny_per_usd: 'unknown' }, /positive finite number/],
  ]) {
    assert.throws(() => quoteFor(store, formId, override), reason);
    const price = solveMinPriceForMargin2027({ ...scenario(), landed_domestic_quote: { ...quote, ...override } });
    assert.equal(price.status, 'needs_calculator_verification');
    assert.match(price.reason, reason);
  }
  assert.deepEqual(store.getQuotesForForm(formId), [quote]);
});

test('an explicit forward discovery request can source without any retail scenario or fee estimates', async t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  register(store, 'no-price');
  const gate = runGate1AForForm(store, { form_id: 'no-price', profile_revision: 59, allow_forward_price_discovery: true });
  assert.equal(gate.proceed_to_gate1b, true);
  assert.equal(gate.forward_price_discovery_only, true);
  assert.deepEqual(gate.scenarios, []);
  const quote = quoteFor(store, 'no-price');
  const result = await runGate1BForForm(store, { form_id: 'no-price', profile_revision: 59, existing_quote: quote, as_of_date: '2026-11-22' });
  assert.equal(result.status, 'gate1b_pending');
  assert.equal(result.forward_pricing.status, 'needs_calculator_verification');
  assert.equal(result.forward_pricing.min_retail_price_for_30pct_usd, null);
});

test('a Gate 1A rerun during the Gate 1B screen builder leaves the new scenarios queued', async t => {
  const store = openSelectionStore();
  t.after(() => store.close());
  const formId = 'scenario-rerun';
  register(store, formId);
  runGate1AForForm(store, { form_id: formId, profile_revision: 59, scenarios: [scenario()] });
  const quote = quoteFor(store, formId);
  const result = await runGate1BForForm(store, {
    form_id: formId,
    profile_revision: 59,
    existing_quote: quote,
    as_of_date: '2026-11-22',
    early_screen_builder: ({ quote: builderQuote }) => {
      builderQuote.goods_cny_total = 1;
      runGate1AForForm(store, { form_id: formId, profile_revision: 59, scenarios: [scenario({ id: 'replacement', price_usd: 43 })] });
      return [];
    },
  });
  assert.equal(result.status, 'stale_gate1a_scenarios');
  assert.equal(result.quote.goods_cny_total, quote.goods_cny_total);
  assert.equal(store.getCandidateForm(formId).lifecycle_status, 'gate1b_queued');
  assert.deepEqual(JSON.parse(store.getCandidateForm(formId).gate1a_result_json).declared_feasible_prices_usd, [43]);
});

test('an exact quote cost above the landed cap by less than display precision still needs the next cent', () => {
  const fees = scenario({
    price_usd: 29.99,
    fx_cny_per_usd: 1,
    refund_fraction: 0,
    collection_rate: 0,
  });
  const cap = estimateGate1A2027(fees).landed_domestic_cap_usd;
  const roundedCost = solveMinPriceForMargin2027({ ...fees, landed_domestic_usd: cap });
  const exactQuote = solveMinPriceForMargin2027({
    ...fees,
    landed_domestic_quote: {
      actual_sets: 100,
      goods_cny_total: Number((cap * 100 + 1e-9).toFixed(12)),
      domestic_freight_cny_total: 0,
    },
  });
  assert.equal(roundedCost.feasible_min_price_usd, 29.99);
  assert.equal(exactQuote.landed_domestic_usd, cap);
  assert.equal(exactQuote.feasible_min_price_usd, 30);
});

test('pipeline rights pre-screen defaults to background Responses with explicit synchronous override', async () => {
  const input = { form_id: 'form-rights', label: 'Steel marking jig', buyer_task: 'Repeat a workpiece measurement' };
  assert.equal((await runOptionalRightsPreScreen(input)).request.background, true);
  assert.equal((await runOptionalRightsPreScreen(input, { policy: { background: false } })).request.background, false);
});

test('pipeline reports a background progress file error independently of the response outcome', async () => {
  const input = { form_id: 'form-rights', label: 'Steel marking jig', buyer_task: 'Repeat a workpiece measurement' };
  const progressError = { code: 'BACKGROUND_PROGRESS_FILE_WRITE_FAILED', io_code: 'EACCES' };
  const opts = { enabled: true, responseExecutor: () => ({ status: 'pending_recovery', progress_error: progressError }) };
  const result = await runOptionalRightsPreScreen(input, opts);
  assert.equal(result.status, 'pending_recovery');
  assert.deepEqual(result.progress_error, progressError);
  const thrown = await runOptionalRightsPreScreen(input, {
    enabled: true,
    responseExecutor: () => { throw Object.assign(new Error('response failed'), { progress_error: progressError }); },
  });
  assert.equal(thrown.status, 'unavailable');
  assert.deepEqual(thrown.progress_error, progressError);
});
