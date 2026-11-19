/**
 * Phase 2 single-controller resumable selection pipeline:
 *  Stage 0: Multi-source lead ingestion & form registration (raw_leads + lead_form_links + candidate_forms)
 *  Stage 1: Gate 1A zero-browser 2027 landed-domestic cap & $49.99/$50.00/$50.01 cliff screening
 *  Stage 2: Gate 1B serial 1688 sourcing queue (exclusive DB lease) with persistent CAPTCHA_PAUSED isolation
 *  Stage 3: Gate 2/3 guarded deep research (forced fresh_observation, isolated per-form errors) -> immutable evaluations
 */
import { evaluateEarlyScreen } from './early-screen.mjs';
import {
  getFba2027RateTableSnapshot,
  computeOrderPlan,
  estimateGate1A2027,
  evaluatePriceCliff2027,
  computeNegotiationShortlist,
} from './fba-rates-2027.mjs';
import { toBigRat, divBigRat, roundBigRat } from './fee-basis.mjs';
import { sanitizeDiagnosticText } from './contracts.mjs';
import { scoreBatch } from './scoring.mjs';
import { renderReport } from './report.mjs';
import { prepareDiscovery, attachDiscovery } from './discovery.mjs';
import { canonicalJson, computeEvidenceBundleHash, sha256Hex } from './store.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const ALLOWED_GATE1B_ENTRY_STATUSES = new Set([
  'gate1a_passed',
  'gate1b_queued',
  'gate1b_pending',
  'gate1b_passed',
  'evaluated',
]);

function isQuoteUsableForForm(quote, form, asOfDay) {
  if (!quote || quote.quote_status !== 'verified') return false;
  if (quote.form_id !== form.form_id) return false;
  if (quote.spec_version !== form.spec_version) return false;
  if (quote.goods_first_order_promotion !== 0 || quote.freight_first_order_promotion !== 0) return false;
  if (!finite(quote.goods_cny_total) || quote.goods_cny_total <= 0) return false;
  if (!finite(quote.domestic_freight_cny_total) || quote.domestic_freight_cny_total < 0) return false;
  if (quote.expires_at && quote.expires_at.slice(0, 10) < asOfDay) return false;
  return true;
}

function deriveOrderPlanFromPersistedQuote(quote) {
  if (quote?.order_plan_json) {
    try {
      const parsed = JSON.parse(quote.order_plan_json);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through */ }
  }
  try {
    const skuLines = JSON.parse(quote.sku_lines_json || '[]');
    if (!Array.isArray(skuLines) || skuLines.length === 0) return null;
    for (const allowRem of [false, true]) {
      const plan = computeOrderPlan({ sku_lines: skuLines, allow_remainder: allowRem, target_sets: quote.actual_sets });
      const qtyMatch = skuLines.every((l, i) => l.ordered_qty === undefined || l.ordered_qty === plan.sku_lines[i]?.ordered_qty);
      if (plan.allocated_sets === quote.actual_sets && qtyMatch) return plan;
    }
    return computeOrderPlan({ sku_lines: skuLines, target_sets: quote.actual_sets });
  } catch {
    return null;
  }
}

/**
 * Authoritatively inject persisted verified 1688 quote costs into an early-screen scenario input,
 * preventing caller builders from forging lower costs against a stored quote.
 */
function applyAuthoritativeQuoteToScreenInput(rawInput, persistedQuote) {
  const goodsPerSetRat = divBigRat(toBigRat(persistedQuote.goods_cny_total), toBigRat(persistedQuote.actual_sets));
  const goodsCnyPerUnit = roundBigRat(goodsPerSetRat.n, goodsPerSetRat.d, 10);
  return {
    ...rawInput,
    profile_revision: 58,
    order_units: persistedQuote.actual_sets,
    sku_lines: null,
    goods_cny_per_unit: goodsCnyPerUnit,
    procurement_usd: null,
    domestic_freight_cny_total: persistedQuote.domestic_freight_cny_total,
    domestic_freight_cny_per_unit: null,
    domestic_freight_usd: null,
    goods_first_order_promotion: Boolean(persistedQuote.goods_first_order_promotion),
    first_order_promotion: Boolean(persistedQuote.freight_first_order_promotion),
  };
}

function getNegotiationDiscountFraction(neg) {
  if (!neg || typeof neg !== 'object') return Infinity;
  const val = neg.required_discount_fraction ?? neg.required_reduction_fraction;
  return finite(val) ? val : Infinity;
}

/**
 * Evaluate Gate 1A locally (0 browser / 0 paid deep-research calls).
 * - Enforces minimum_price_usd >= 29.99.
 * - Preserves a previously proven specific_rights_conflict on the SAME spec_sha256 when
 *   re-runs omit specific_rights_conflict ('unknown'), preventing silent rights-conflict erasure.
 */
export function runGate1AForForm(store, {
  form_id,
  scenarios,
  minimum_price_usd = 29.99,
  specific_rights_conflict = 'unknown',
  strong_date_dependency = 'unknown',
} = {}) {
  const form = store.getCandidateForm(form_id);
  if (!form) throw new TypeError(`Unknown form_id for Gate 1A: ${form_id}`);
  if (!finite(minimum_price_usd) || minimum_price_usd < 29.99) {
    throw new TypeError('Gate 1A minimum_price_usd must be a finite number >= 29.99.');
  }
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new TypeError('Gate 1A requires a nonempty scenarios array.');
  }
  if (![true, false, 'unknown'].includes(specific_rights_conflict)) {
    throw new TypeError('Gate 1A specific_rights_conflict must be true, false, or "unknown".');
  }
  if (![true, false, 'unknown'].includes(strong_date_dependency)) {
    throw new TypeError('Gate 1A strong_date_dependency must be true, false, or "unknown".');
  }

  // Carry forward any previously proven rights conflict on the exact same spec_sha256 when omitted.
  let effectiveRights = specific_rights_conflict;
  if (effectiveRights === 'unknown') {
    for (const rawJson of [form.gate1a_result_json, form.gate1b_result_json]) {
      if (!rawJson) continue;
      try {
        const prev = JSON.parse(rawJson);
        if (prev?.spec_sha256 === form.spec_sha256 && prev?.specific_rights_conflict_proven === true) {
          effectiveRights = true;
          break;
        }
      } catch { /* ignore parse issue */ }
    }
  }

  const scenarioResults = [];
  let allPricesBelowFloor = true;
  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    const price = sc.price_usd;
    const priceBelowFloor = finite(price) && price < minimum_price_usd;
    if (!priceBelowFloor) allPricesBelowFloor = false;

    const est = estimateGate1A2027(sc);
    const cliff = finite(price) && price > 50.00 && price <= 51.50
      ? evaluatePriceCliff2027(sc, { landed_domestic_usd: sc.min_landed_domestic_usd ?? null })
      : null;

    scenarioResults.push({
      id: sc.id ?? `scenario-${i + 1}`,
      price_usd: price ?? null,
      price_below_floor: priceBelowFloor,
      estimate: est,
      price_cliff_50: cliff,
    });
  }

  const baseMeta = {
    spec_sha256: form.spec_sha256,
    spec_version: form.spec_version,
    specific_rights_conflict_proven: effectiveRights === true,
  };

  if (effectiveRights === true) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      reason: 'Proven specific design rights conflict (specific_rights_conflict === true).',
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  if (allPricesBelowFloor) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      reason: `All feasible scenario net prices are below USD ${minimum_price_usd}.`,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  if (strong_date_dependency === true) {
    const payload = {
      ...baseMeta,
      gate_status: 'deferred',
      reason: 'Strong holiday/date dependency (deferred, not excluded).',
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'deferred', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  const eligiblePriceScenarios = scenarioResults.filter(s => !s.price_below_floor);
  const unverified = eligiblePriceScenarios.filter(s => s.estimate.status !== 'verified');
  if (unverified.length > 0) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_needs_verification',
      reason: `Calculator verification needed on ${unverified.length} scenario(s); cannot zero-browser reject on missing fee cells.`,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_needs_verification', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  const allZeroBrowserRejected = eligiblePriceScenarios.every(s => s.estimate.zero_browser_fail === true);
  const bestCapCny = Math.max(...eligiblePriceScenarios.map(s => s.estimate.landed_domestic_cap_cny));

  if (allZeroBrowserRejected) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      reason: 'All evidenced feasible scenarios fail 30% pre-ad margin ceiling even before 1688 browsing (zero-browser elimination).',
      best_landed_domestic_cap_cny: bestCapCny,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', { gate1a_result: payload, landed_domestic_cap_cny: bestCapCny });
    return payload;
  }

  const nextStatus = form.lifecycle_status === 'evaluated' ? 'evaluated' : 'gate1b_queued';
  const payload = {
    ...baseMeta,
    gate_status: 'gate1a_passed',
    reason: 'At least one verified 2027 feasible scenario leaves positive landed domestic cost headroom for Gate 1B sourcing.',
    best_landed_domestic_cap_cny: bestCapCny,
    declared_feasible_prices_usd: [...new Set(eligiblePriceScenarios.filter(s => finite(s.price_usd)).map(s => s.price_usd))],
    proceed_to_gate1b: true,
    proceed_to_gate2_3: false,
    scenarios: scenarioResults,
  };
  store.updateFormLifecycle(form_id, nextStatus, { gate1a_result: payload, landed_domestic_cap_cny: bestCapCny });
  return payload;
}

/**
 * Evaluate Gate 1B for a single form via the exclusively leased serial 1688 queue.
 * - Requires prior Gate 1A pass on the form's current spec_sha256 (rejects unscreened 'discovered' or rejected forms).
 * - Guards against concurrent spec_version upgrades across async sourcing calls.
 * - Validates Gate 1B scenario prices against Gate 1A declared feasible prices (blocks invented high prices
 *   AND refuses to kill a form if declared Gate 1A scenarios were omitted).
 * - Picks the lowest required_discount_fraction across failed scenarios for negotiation_shortlist.
 */
export async function runGate1BForForm(store, {
  form_id,
  sourcing_executor,
  early_screen_builder,
  existing_quote = null,
  as_of_date = new Date().toISOString().slice(0, 10),
  lease_owner = 'gate1b',
} = {}) {
  const form = store.getCandidateForm(form_id);
  if (!form) throw new TypeError(`Unknown form_id for Gate 1B: ${form_id}`);

  // Enforce prior Gate 1A clearance on the current spec_sha256.
  const gate1aRecord = form.gate1a_result_json ? JSON.parse(form.gate1a_result_json) : null;
  const hasValidGate1A = gate1aRecord &&
    gate1aRecord.spec_sha256 === form.spec_sha256 &&
    gate1aRecord.proceed_to_gate1b === true &&
    gate1aRecord.specific_rights_conflict_proven !== true;

  if (!ALLOWED_GATE1B_ENTRY_STATUSES.has(form.lifecycle_status) || !hasValidGate1A) {
    return {
      form_id,
      status: 'blocked_by_gate1a',
      lifecycle_status: form.lifecycle_status,
      reason: 'Form has not passed Gate 1A on its current specification.',
      proceed_to_gate2_3: false,
    };
  }

  const expectedSpecVersion = form.spec_version;
  let persistedQuote = isQuoteUsableForForm(existing_quote, form, as_of_date) ? existing_quote : null;
  let orderPlan = persistedQuote ? deriveOrderPlanFromPersistedQuote(persistedQuote) : null;

  if (!persistedQuote) {
    const queue = store.getQueueState('gate1b_1688_queue');
    if (queue && queue.status === 'CAPTCHA_PAUSED') {
      return {
        form_id,
        status: 'skipped_queue_paused',
        queue_status: 'CAPTCHA_PAUSED',
        pause_reason: queue.pause_reason,
        proceed_to_gate2_3: false,
      };
    }
    if (typeof sourcing_executor !== 'function') {
      const g1bRes = { status: 'gate1b_pending', reason: 'No usable verified quote and no sourcing_executor supplied.' };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, proceed_to_gate2_3: false };
    }

    const lease = store.acquireQueueLease('gate1b_1688_queue', lease_owner);
    if (!lease.acquired) {
      return {
        form_id,
        status: lease.reason === 'CAPTCHA_PAUSED' ? 'skipped_queue_paused' : 'skipped_serial_busy',
        queue_status: lease.queue_state.status,
        reason: lease.reason,
        proceed_to_gate2_3: false,
      };
    }

    let sourcingOutcome;
    try {
      sourcingOutcome = await sourcing_executor({
        form,
        landed_domestic_cap_cny: form.landed_domestic_cap_cny,
      });
    } finally {
      store.releaseQueueLease('gate1b_1688_queue', lease.lease_token);
    }

    if (!sourcingOutcome || typeof sourcingOutcome !== 'object') {
      throw new TypeError('sourcing_executor must return an outcome object.');
    }
    // Queue-wide CAPTCHA / login expiry MUST pause the queue FIRST, even if the form spec also changed.
    if (sourcingOutcome.status === 'captcha_triggered' || sourcingOutcome.status === 'login_expired') {
      const pauseReason = sourcingOutcome.reason || `1688 queue paused due to ${sourcingOutcome.status}`;
      store.pauseQueue('gate1b_1688_queue', pauseReason, {
        paused_form_id: form_id,
        paused_sku_hint: sourcingOutcome.sku_hint ?? sourcingOutcome.sku_id ?? null,
        paused_min_qty: sourcingOutcome.min_qty ?? sourcingOutcome.required_qty ?? sourcingOutcome.quantity ?? 100,
      });
      const latestNow = store.getCandidateForm(form_id);
      if (latestNow && latestNow.lifecycle_status !== 'evaluated') store.updateFormLifecycle(form_id, 'gate1b_queued');
      return {
        form_id,
        status: 'captcha_paused',
        queue_status: 'CAPTCHA_PAUSED',
        pause_reason: pauseReason,
        paused_form_id: form_id,
        proceed_to_gate2_3: false,
      };
    }

    // Re-check spec_version after async sourcing so an overlapping batch upgrade never binds a v1 quote to v2!
    const latestAfterSource = store.getCandidateForm(form_id);
    if (!latestAfterSource || latestAfterSource.spec_version !== expectedSpecVersion) {
      return {
        form_id,
        status: 'stale_spec_version_conflict',
        reason: `Form spec changed from v${expectedSpecVersion} to v${latestAfterSource?.spec_version} during Gate 1B sourcing.`,
        proceed_to_gate2_3: false,
      };
    }

    if (sourcingOutcome.status === 'no_matched_offer') {
      const g1bRes = { status: 'gate1b_pending', reason: sanitizeDiagnosticText(sourcingOutcome.reason || 'No matched 1688 offer verified yet.') };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, proceed_to_gate2_3: false };
    }

    if (sourcingOutcome.status !== 'quoted') {
      const pendingQuote = sourcingOutcome.quote && typeof sourcingOutcome.quote === 'object'
        ? store.recordSourcingQuote1688({
          ...sourcingOutcome.quote,
          quote_status: 'pending',
          form_id,
          spec_version: expectedSpecVersion,
        }).quote
        : null;
      const g1bRes = {
        status: 'gate1b_pending',
        reason: sanitizeDiagnosticText(sourcingOutcome.reason || `Sourcing outcome "${sourcingOutcome.status}" is not a verified quote.`),
        quote_id: pendingQuote?.quote_id ?? null,
      };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, quote: pendingQuote, proceed_to_gate2_3: false };
    }

    const rec = store.recordSourcingQuote1688({
      ...sourcingOutcome.quote,
      form_id,
      spec_version: expectedSpecVersion,
    });
    persistedQuote = rec.quote;
    orderPlan = rec.order_plan;

    if (!isQuoteUsableForForm(persistedQuote, latestAfterSource, as_of_date)) {
      const g1bRes = {
        status: 'gate1b_pending',
        reason: `Persisted quote (${persistedQuote.quote_status}) is not a valid active verified quote for current spec v${expectedSpecVersion}.`,
        quote_id: persistedQuote.quote_id,
      };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, proceed_to_gate2_3: false };
    }
  }

  if (typeof early_screen_builder !== 'function') {
    const g1bRes = {
      status: 'gate1b_pending',
      reason: 'early_screen_builder is required to verify 30% pre-ad margin from the persisted 1688 quote.',
      quote_id: persistedQuote.quote_id,
    };
    store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
    return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, early_screen: null, proceed_to_gate2_3: false };
  }

  const builtRaw = early_screen_builder({ form, quote: persistedQuote, order_plan: orderPlan });
  const rawScenarios = Array.isArray(builtRaw) ? builtRaw : [builtRaw];
  if (rawScenarios.length === 0) {
    throw new TypeError('early_screen_builder must return a scenario object or a nonempty array of scenario objects.');
  }

  // Cross-check Gate 1B scenario prices against Gate 1A declared feasible prices.
  const declaredPrices = Array.isArray(gate1aRecord?.declared_feasible_prices_usd)
    ? gate1aRecord.declared_feasible_prices_usd
    : (gate1aRecord?.scenarios ?? []).filter(s => !s.price_below_floor && finite(s.price_usd)).map(s => s.price_usd);

  if (declaredPrices.length > 0) {
    const declaredSet = new Set(declaredPrices.map(p => Number(p).toFixed(4)));
    for (const sc of rawScenarios) {
      if (!finite(sc?.price_usd) || !declaredSet.has(Number(sc.price_usd).toFixed(4))) {
        const g1bRes = {
          status: 'gate1b_pending',
          quote_id: persistedQuote.quote_id,
          reason: `Gate 1B scenario price (${sc?.price_usd}) is not in Gate 1A declared feasible prices (${declaredPrices.join(', ')}).`,
        };
        store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
        return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, proceed_to_gate2_3: false };
      }
    }
  }

  const evaluations = rawScenarios.map(raw => {
    const authoritativeInput = applyAuthoritativeQuoteToScreenInput(raw, persistedQuote);
    return evaluateEarlyScreen(authoritativeInput, { profileRevision: 58 });
  });

  const anyRightsHardFail = evaluations.some(e => e.checks?.specific_form_rights === 'fail');
  const allSuppliedFail = evaluations.every(e => e.gate_status === 'fail');
  const anyPass = evaluations.some(e => e.gate_status === 'pass' || e.gate_status === 'economic_pass_rights_unsearched');
  const anyDeferred = evaluations.some(e => e.gate_status === 'deferred' || e.gate_status === 'defer');

  // Check whether any declared Gate 1A feasible scenario was omitted from Gate 1B before rejecting!
  const suppliedPriceSet = new Set(rawScenarios.filter(s => finite(s?.price_usd)).map(s => Number(s.price_usd).toFixed(4)));
  const missingDeclaredPrices = declaredPrices.filter(p => !suppliedPriceSet.has(Number(p).toFixed(4)));

  if (!anyRightsHardFail && allSuppliedFail && missingDeclaredPrices.length > 0) {
    const g1bRes = {
      status: 'gate1b_pending',
      quote_id: persistedQuote.quote_id,
      reason: `Cannot reject form while Gate 1A declared feasible price scenario(s) (${missingDeclaredPrices.join(', ')}) were omitted from Gate 1B.`,
      scenarios_checked: evaluations.length,
    };
    store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
    return {
      form_id,
      ...g1bRes,
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      proceed_to_gate2_3: false,
    };
  }

  if (anyRightsHardFail || allSuppliedFail) {
    let bestNegotiation = null;
    for (const ev of evaluations) {
      let candNeg = ev.negotiation_shortlist ?? null;
      const led = ev.ledger;
      const met = ev.metrics;
      if (!candNeg && led && met && finite(led.net_revenue_usd) && finite(led.contribution_usd) && finite(met.procurement_usd) && met.procurement_usd > 0) {
        candNeg = computeNegotiationShortlist({
          net_revenue_usd: led.net_revenue_usd,
          contribution_usd: led.contribution_usd,
          negotiable_cost_usd: met.procurement_usd,
          margin_floor: 0.30,
        });
      }
      if (candNeg && (!bestNegotiation || getNegotiationDiscountFraction(candNeg) < getNegotiationDiscountFraction(bestNegotiation))) {
        bestNegotiation = candNeg;
      }
    }
    const g1bRes = {
      status: 'gate1b_rejected',
      spec_sha256: form.spec_sha256,
      specific_rights_conflict_proven: anyRightsHardFail,
      quote_id: persistedQuote.quote_id,
      scenarios_checked: evaluations.length,
      reasons: evaluations.flatMap(e => e.reasons || []).map(sanitizeDiagnosticText),
    };
    store.updateFormLifecycle(form_id, 'gate1b_rejected', {
      gate1b_result: g1bRes,
      negotiation_shortlist: bestNegotiation,
    });
    return {
      form_id,
      status: 'gate1b_rejected',
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      negotiation_shortlist: bestNegotiation,
      proceed_to_gate2_3: false,
    };
  }

  if (anyDeferred) {
    const g1bRes = {
      status: 'deferred',
      quote_id: persistedQuote.quote_id,
      scenarios_checked: evaluations.length,
      reasons: evaluations.flatMap(e => e.reasons || []),
    };
    store.updateFormLifecycle(form_id, 'deferred', { gate1b_result: g1bRes });
    return {
      form_id,
      status: 'deferred',
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      proceed_to_gate2_3: false,
    };
  }

  if (anyPass) {
    const latest = store.getCandidateForm(form_id);
    if (!latest || latest.spec_version !== expectedSpecVersion) {
      return {
        form_id,
        status: 'stale_spec_version_conflict',
        proceed_to_gate2_3: false,
      };
    }
    const nextStatus = latest.lifecycle_status === 'evaluated' ? 'evaluated' : 'gate1b_passed';
    const g1bRes = {
      status: 'gate1b_passed',
      quote_id: persistedQuote.quote_id,
      spec_version: expectedSpecVersion,
      scenarios_checked: evaluations.length,
    };
    store.updateFormLifecycle(form_id, nextStatus, { gate1b_result: g1bRes, negotiation_shortlist: null });
    return {
      form_id,
      status: 'gate1b_passed',
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      proceed_to_gate2_3: true,
    };
  }

  const g1bRes = {
    status: 'gate1b_pending',
    quote_id: persistedQuote.quote_id,
    scenarios_checked: evaluations.length,
    reasons: evaluations.flatMap(e => e.reasons || []),
  };
  store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
  return {
    form_id,
    status: 'gate1b_pending',
    quote: persistedQuote,
    order_plan: orderPlan,
    early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
    proceed_to_gate2_3: false,
  };
}

/**
 * Run a complete multi-item Phase 2 batch with single-controller non-blocking orchestration:
 *  - Rejects duplicate form_ids upfront.
 *  - Stage 0: Ingest leads, forms, and primary_discovery/corroboration links.
 *  - Stage 1: Gate 1A ALWAYS runs (preserving prior proven rights conflicts on the same spec).
 *  - Stage 2: Gate 1B runs serially with DB lease + isolated sanitized per-form error handling.
 *  - Stage 3: Verifies primary_discovery product/context lead admissibility, checks spec_version parity
 *             before/after async deep research, isolates per-form errors so healthy siblings finish,
 *             forces fresh_observation + gate2_3 ledger tagging, and writes immutable evaluations.
 */
export async function runPhase2Batch(store, {
  items,
  profile,
  sourcing_executor = null,
  deep_research_executor = null,
  fee_table_snapshot = null,
  as_of_date = new Date().toISOString().slice(0, 10),
} = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('runPhase2Batch requires a nonempty items array.');
  if (!profile || typeof profile !== 'object') throw new TypeError('runPhase2Batch requires a profile object.');

  const seenFormIds = new Set();
  for (const item of items) {
    const fid = item?.form?.form_id;
    if (typeof fid !== 'string' || !fid.trim()) throw new TypeError('Every batch item requires a nonempty form.form_id.');
    const normFid = fid.trim();
    if (seenFormIds.has(normFid)) throw new TypeError(`Duplicate form_id in batch items: ${normFid}`);
    seenFormIds.add(normFid);
  }

  const effectiveFeeSnapshot = fee_table_snapshot ?? getFba2027RateTableSnapshot();
  const report = {
    ingested: [],
    gate1a: [],
    gate1b: [],
    gate2_3: [],
    evaluations: [],
    skipped_zero_incremental: [],
  };

  // Stage 0: Ingest leads, candidate forms, and links.
  for (const item of items) {
    const { form } = store.upsertCandidateForm(item.form);
    const linkedLeads = [];
    for (const leadSpec of item.leads ?? []) {
      const { lead } = store.upsertRawLead(leadSpec);
      const { link } = store.linkLeadToForm({
        lead_id: lead.lead_id,
        form_id: form.form_id,
        link_role: leadSpec.link_role ?? 'primary_discovery',
        note: leadSpec.link_note ?? null,
      });
      linkedLeads.push({ lead_id: lead.lead_id, link_role: link.link_role });
    }
    report.ingested.push({ form_id: form.form_id, leads: linkedLeads });
  }

  // Stage 1: Gate 1A ALWAYS runs (0-cost local check).
  const afterGate1A = [];
  for (const item of items) {
    const formId = item.form.form_id;
    const currentForm = store.getCandidateForm(formId);
    const g1a = runGate1AForForm(store, {
      form_id: formId,
      scenarios: item.gate1a_scenarios,
      minimum_price_usd: item.minimum_price_usd ?? 29.99,
      specific_rights_conflict: item.specific_rights_conflict ?? 'unknown',
      strong_date_dependency: item.strong_date_dependency ?? 'unknown',
    });
    report.gate1a.push({ form_id: formId, ...g1a });
    if (g1a.proceed_to_gate1b) {
      const usableQuotes = store.getQuotesForForm(formId).filter(q => isQuoteUsableForForm(q, currentForm, as_of_date));
      afterGate1A.push({
        item,
        form_id: formId,
        expected_spec_version: currentForm.spec_version,
        existing_quote: usableQuotes[0] ?? null,
      });
    } else if (g1a.gate_status === 'gate1a_rejected') {
      report.skipped_zero_incremental.push({ form_id: formId, stage: 'gate1a_rejected' });
    }
  }

  // Stage 2: Gate 1B serial 1688 queue (isolated sanitized per-form errors + CAPTCHA_PAUSED isolation).
  const readyForGate23 = [];
  for (const entry of afterGate1A) {
    const { item, form_id: formId, existing_quote: existingQuote } = entry;
    let g1b;
    try {
      g1b = await runGate1BForForm(store, {
        form_id: formId,
        sourcing_executor: item.sourcing_executor ?? sourcing_executor,
        early_screen_builder: item.early_screen_builder,
        existing_quote: existingQuote,
        as_of_date,
      });
    } catch (error) {
      const safeErr = sanitizeDiagnosticText(error?.message || 'Gate 1B quote validation failed.');
      const errRes = { status: 'gate1b_pending', error: safeErr };
      store.updateFormLifecycle(formId, 'gate1b_pending', { gate1b_result: errRes });
      g1b = { form_id: formId, ...errRes, proceed_to_gate2_3: false };
    }
    report.gate1b.push(g1b);
    if (g1b.proceed_to_gate2_3) {
      readyForGate23.push({
        item,
        form_id: formId,
        quote: g1b.quote,
        expected_spec_version: g1b.quote?.spec_version ?? entry.expected_spec_version,
      });
    } else if (g1b.status === 'gate1b_rejected') {
      report.skipped_zero_incremental.push({ form_id: formId, stage: 'gate1b_rejected' });
    }
  }

  // Stage 3: Gate 2/3 guarded deep research + scoring + immutable evaluations (isolated per form!).
  for (const entry of readyForGate23) {
    const { item, form_id: formId, quote, expected_spec_version: expectedSpecVersion } = entry;
    const form = store.getCandidateForm(formId);

    // Verify form spec and quote still match before starting Stage 3.
    if (!form || form.spec_version !== expectedSpecVersion || (quote && quote.spec_version !== form.spec_version)) {
      report.gate2_3.push({ form_id: formId, status: 'stale_spec_version_conflict', attempt_ids: [] });
      continue;
    }

    // Require at least one primary_discovery lead with reviewed 'product' or 'context' disposition.
    const linkedLeads = store.getLeadsForForm(formId);
    const hasAdmissiblePrimary = linkedLeads.some(
      l => l.link_role === 'primary_discovery' && (l.disposition === 'product' || l.disposition === 'context'),
    );
    if (!hasAdmissiblePrimary) {
      store.updateFormLifecycle(formId, 'gate1b_pending', {
        gate1b_result: {
          status: 'blocked_inadmissible_leads',
          reason: 'Form requires at least one primary_discovery lead with reviewed product or context disposition.',
        },
      });
      report.gate2_3.push({ form_id: formId, status: 'blocked_inadmissible_leads', attempt_ids: [] });
      continue;
    }

    store.updateFormLifecycle(formId, 'gate2_3_in_progress');
    const attemptIds = [];

    const guardedRequest = async (spec, executorFn) => {
      const res = await store.executeGuardedRequest({
        ...spec,
        mode: 'fresh_observation',
        form_id: formId,
        stage: 'gate2_3',
      }, executorFn);
      if (res.attempt_id) attemptIds.push(res.attempt_id);
      return res;
    };

    try {
      const researchFn = item.deep_research_executor ?? deep_research_executor;
      if (typeof researchFn !== 'function') {
        throw new TypeError(`Gate 2/3 requires deep_research_executor for passed form ${formId}.`);
      }

      const researchOut = await researchFn({
        form,
        quote,
        request: guardedRequest,
        store,
      });

      // Re-check spec_version after async deep research before committing evaluations!
      const latestForm = store.getCandidateForm(formId);
      if (!latestForm || latestForm.spec_version !== expectedSpecVersion || (quote && quote.spec_version !== latestForm.spec_version)) {
        report.gate2_3.push({ form_id: formId, status: 'stale_spec_version_conflict', attempt_ids: attemptIds });
        continue;
      }

      if (!researchOut || !researchOut.batch) {
        store.updateFormLifecycle(formId, 'gate1b_pending', {
          gate1b_result: { status: researchOut?.status || 'blocked_or_pending' },
        });
        report.gate2_3.push({ form_id: formId, status: researchOut?.status || 'blocked_or_pending', attempt_ids: attemptIds });
        continue;
      }

      const manifest = researchOut.discovery
        ? prepareDiscovery(researchOut.discovery.pool, researchOut.discovery.decisions)
        : null;
      const boundBatch = manifest ? attachDiscovery(researchOut.batch, manifest) : researchOut.batch;
      const scoredResult = scoreBatch(boundBatch, profile);
      if (manifest) scoredResult.discovery = { ...manifest, summary: boundBatch.discovery_summary };

      const resultBytes = Buffer.from(`${JSON.stringify(scoredResult, null, 2)}\n`, 'utf8');
      const htmlBytes = Buffer.from(renderReport(scoredResult, boundBatch), 'utf8');
      const batchResultSha = sha256Hex(resultBytes);
      const htmlSha = sha256Hex(htmlBytes);

      // Strictly match scored candidate to formId (NEVER fall back to candidates[0]!).
      const scoredCand = scoredResult.candidates.find(c => (c.candidate_id || c.id) === formId);
      if (!scoredCand) {
        throw new TypeError(`Deep research batch did not contain a scored candidate matching form_id "${formId}".`);
      }
      const inputCand = boundBatch.candidates.find(c => c.id === formId);
      if (!inputCand) {
        throw new TypeError(`Deep research input batch did not contain an input candidate matching form_id "${formId}".`);
      }

      const bundleHash = computeEvidenceBundleHash({
        form_spec_sha256: latestForm.spec_sha256,
        candidate_input: inputCand,
        discovery_manifest: manifest,
        profile_snapshot: profile,
        fee_table_snapshot: effectiveFeeSnapshot,
      });
      const perCandidateSha = sha256Hex(canonicalJson(scoredCand));

      const qualification = scoredCand.qualification ?? {
        counts_toward_target: scoredCand.queue === 'comparable',
        mode: scoredCand.queue === 'comparable' ? 'comparable' : 'none',
        primary_period_id: null,
        display_period_id: null,
        reasons: [],
      };

      const periods = Array.isArray(scoredCand.operating_periods) && scoredCand.operating_periods.length > 0
        ? scoredCand.operating_periods
        : [{
          id: 'annual',
          queue: scoredCand.queue,
          covered_weight: scoredCand.covered_weight,
          supported_range: scoredCand.supported_range,
          total_range: scoredCand.total_range,
        }];

      store.runInTransaction(() => {
        const recheck = store.getCandidateForm(formId);
        if (!recheck || recheck.spec_version !== expectedSpecVersion) {
          throw new Error(`Spec version changed concurrently for ${formId}; aborting stale evaluation write.`);
        }
        const recheckG1A = recheck.gate1a_result_json ? JSON.parse(recheck.gate1a_result_json) : null;
        if (recheckG1A?.specific_rights_conflict_proven === true) {
          throw new Error(`Proven rights conflict recorded for ${formId}; aborting evaluation write.`);
        }
        const currentLeads = store.getLeadsForForm(formId);
        if (!currentLeads.some(l => l.link_role === 'primary_discovery' && (l.disposition === 'product' || l.disposition === 'context'))) {
          throw new Error(`No admissible primary_discovery lead remains for ${formId}; aborting evaluation write.`);
        }
        for (const p of periods) {
          const evRec = store.recordEvaluation({
            form_id: formId,
            period_id: p.id,
            profile_revision: profile.revision,
            evidence_bundle_sha256: bundleHash,
            qualification,
            sort_keys: {
              queue: p.queue ?? scoredCand.queue,
              total_range: p.total_range ?? null,
              supported_range: p.supported_range ?? null,
              covered_weight: p.covered_weight ?? 0,
              candidate_id: formId,
            },
            queue_bucket: p.queue ?? scoredCand.queue,
            covered_weight: p.covered_weight ?? 0,
            supported_range: p.supported_range ?? [0, 0],
            total_range: p.total_range ?? null,
            result_sha256: perCandidateSha,
            html_sha256: htmlSha,
            receipt: {
              profile_revision: profile.revision,
              batch_result_sha256: batchResultSha,
              batch_html_sha256: htmlSha,
              summary: scoredResult.summary,
              fee_table_version: effectiveFeeSnapshot?.metadata?.version ?? effectiveFeeSnapshot?.version ?? null,
            },
            source_attempt_ids: attemptIds,
          });
          report.evaluations.push(evRec.evaluation);
        }
        store.updateFormLifecycle(formId, 'evaluated');
      });

      report.gate2_3.push({
        form_id: formId,
        status: 'evaluated',
        qualification,
        result_sha256: perCandidateSha,
        batch_result_sha256: batchResultSha,
        html_sha256: htmlSha,
        attempt_ids: attemptIds,
      });
    } catch (error) {
      // Isolate per-form Stage 3 error so sibling ready forms still complete!
      const safeErr = sanitizeDiagnosticText(error?.message || 'Gate 2/3 execution failed.');
      store.updateFormLifecycle(formId, 'gate1b_pending', {
        gate1b_result: { status: 'gate2_3_error', error: safeErr },
      });
      report.gate2_3.push({
        form_id: formId,
        status: 'gate2_3_error',
        error: safeErr,
        attempt_ids: attemptIds,
      });
    }
  }

  return {
    ...report,
    queue_state: store.getQueueState('gate1b_1688_queue'),
    quota_summary: store.getQuotaSummary(),
  };
}
