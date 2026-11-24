/**
 * Phase 2 single-controller resumable selection pipeline:
 *  Stage 0: Multi-source lead ingestion & form registration (raw_leads + lead_form_links + candidate_forms)
 *  Stage 1: Gate 1A zero-browser 2027 landed-domestic cap & $49.99/$50.00/$50.01 cliff screening
 *  Stage 2: Gate 1B serial 1688 sourcing queue (exclusive DB lease) with persistent CAPTCHA_PAUSED isolation
 *  Stage 3: Gate 2/3 guarded deep research (forced fresh_observation, isolated per-form errors) -> immutable evaluations
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluateEarlyScreen } from './early-screen.mjs';
import {
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  getFba2027RateTableSnapshot,
  computeOrderPlan,
  estimateGate1A2027,
  evaluatePriceCliff2027,
  computeNegotiationShortlist,
  computePackagingRedesignShortlist2027,
  computeMatchedPeerMedianPackage,
  bindSourcingQuotePricingInputs,
  solveMinPriceForMargin2027,
  lookupFulfillmentFee2027,
  lookupBulkyFulfillmentFee2027,
} from './fba-rates-2027.mjs';
import {
  toBigRat,
  divBigRat,
  roundBigRat,
  resolveEffectivePricing,
} from './fee-basis.mjs';
import {
  assertNoRawPii,
  containsSecretToken,
  detectRawPii,
  sanitizeDiagnosticText,
  validateSpecMatcherOutput,
  validatePainPointAndRubricJudgeOutput,
} from './contracts.mjs';
import {
  evaluateGate0CategoryBoundary,
  analyzeMainstreamPriceBand,
  resolveAgeDays,
  resolveHolidayPromoReference,
  tightenClusterBands,
} from './price-band.mjs';
import { scoreBatch } from './scoring.mjs';
import { renderReport } from './report.mjs';
import { prepareDiscovery, attachDiscovery, attachStoreDiscoveryProvenance } from './discovery.mjs';
import { canonicalJson, computeEvidenceBundleHash, isSocialBridgeAlignedWithForm, sha256Hex } from './store.mjs';
import {
  OpenAiAmbiguousOutcomeError,
  SCHEMA_VERSION as EVIDENCE_REVIEW_SCHEMA_VERSION,
  assertAuthorizedReviewExecutionPolicy,
  buildStage1DecisionsRequests,
  parseStage1DecisionsResponses,
  buildWorkflowTaskRequest,
  freezeWorkflowTaskContext,
  parseWorkflowTaskResult,
  freezeEvidenceReviewPacket,
  isEvidenceReviewStale,
  validateEvidenceReviewOutput,
  runCodexEvidenceReview,
  stageAndHashReviewAttachments,
  verifySavedCodexReceipt,
} from './openai/index.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;
const PARITY_TOLERANCE_USD = 0.005;
const FX_TOLERANCE = 1e-6;
const HOLIDAY_PROMO_REASON = 'holiday_or_event_promo_outlier';
const PRICE_WATCH_REASONS = [
  HOLIDAY_PROMO_REASON,
  'launch_spiral_low_price',
  'heavy_coupon_outlier',
  'young_heavy_coupon_outlier',
  'young_newcomer_launch_band_only',
  'unknown_age_excluded_from_mature_band',
  'seed_merged_unverified_regular_price',
  'veteran_clearance_or_war_watch',
  'veteran_keepa_price_unsteady',
  'growth_stage_price_unsteady',
  'growth_stage_held_veterans_sufficient',
  'out_of_primary_band_observation_only',
  'excluded_spec_mismatch_or_bare_part',
  'spec_mismatch_or_accessory',
];
const FORWARD_FEE_INPUTS = [
  'pkg', 'fx_cny_per_usd', 'refund_fraction', 'physical_return_fraction',
  'fee_category', 'return_threshold', 'referral_terms', 'headhaul_usd',
  'collection_rate', 'other_applicable_usd', 'other_payee', 'sales_window',
  'storage_window', 'inbound_window', 'average_inventory_days', 'placement_usd',
  'placement_split_option', 'is_apparel', 'is_shoes', 'is_apparel_or_shoes',
  'is_dangerous_goods', 'is_sipp', 'sipp_discount_usd',
  'low_price_eligible', 'allow_bulky_2027', 'allow_all_2027_tiers',
  'profile_revision', 'requires_amazon_packaging', 'calculator_verified_override',
  'list_price_usd', 'ongoing_coupon_usd', 'ongoing_coupon_pct',
  'prime_exclusive_discount_usd', 'prime_exclusive_discount_pct', 'promo_basis_already_net',
  'coupon_campaign_units', 'coupon_redemption_share', 'include_coupon_fee', 'include_coupon_campaign_flat',
];
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

function hasProvenRightsConflictOnCurrentSpec(form) {
  if (!form) return false;
  for (const rawJson of [form.gate1a_result_json, form.gate1b_result_json]) {
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed?.spec_sha256 === form.spec_sha256 && parsed?.specific_rights_conflict_proven === true) {
        return true;
      }
    } catch { /* ignore malformed historical JSON */ }
  }
  return false;
}

function hasTerminalRejectionOrDeferralOnCurrentSpec(form) {
  if (!form) return { blocked: true, reason: 'Form no longer exists.' };
  if (hasProvenRightsConflictOnCurrentSpec(form)) {
    return {
      blocked: true,
      status: 'blocked_rights_conflict',
      preserve_rights_conflict: true,
      reason: 'Form has a proven specific design rights conflict on its current specification.',
    };
  }
  if (form.lifecycle_status === 'gate1a_rejected' || form.lifecycle_status === 'gate1b_rejected' ||
    form.lifecycle_status === 'deferred' || form.effective_lifecycle_status === 'private_mold_reserved') {
    return {
      blocked: true,
      status: form.effective_lifecycle_status === 'private_mold_reserved' ? 'private_mold_reserved' : form.lifecycle_status,
      preserve_rights_conflict: false,
      reason: `Form is currently in terminal/deferred status "${form.effective_lifecycle_status ?? form.lifecycle_status}" on spec v${form.spec_version}.`,
    };
  }
  return { blocked: false, status: null, preserve_rights_conflict: false, reason: null };
}

function resolveScreenHeadhaulUsd(sc) {
  if (!sc || typeof sc !== 'object') return null;
  let objVal = null;
  if (finite(sc.headhaul)) objVal = sc.headhaul;
  else if (sc.headhaul && typeof sc.headhaul === 'object') {
    if (finite(sc.headhaul.amount_usd)) objVal = sc.headhaul.amount_usd;
    else if (finite(sc.headhaul.usd_per_unit)) objVal = sc.headhaul.usd_per_unit;
  }
  const flatVal = finite(sc.headhaul_usd) ? sc.headhaul_usd : null;
  if (objVal !== null && flatVal !== null && Math.abs(objVal - flatVal) > PARITY_TOLERANCE_USD) {
    return Math.min(objVal, flatVal); // conservative lower bound flags parity discrepancy when both conflict
  }
  if (objVal !== null) return objVal;
  if (flatVal !== null) return flatVal;
  if (Array.isArray(sc.lines)) {
    const pos = sc.lines.filter(l => l?.id === 'headhaul' && finite(l.amount_usd) && l.amount_usd >= 0);
    if (pos.length > 0) return pos.reduce((a, l) => a + l.amount_usd, 0);
  }
  return null;
}

function resolveScreenStorageUsd(sc) {
  if (!sc || typeof sc !== 'object') return null;
  if (finite(sc.storage)) return sc.storage;
  if (sc.storage && typeof sc.storage === 'object') {
    if (finite(sc.storage.cubic_feet_per_unit) && finite(sc.storage.rate_usd_per_cuft_month)) {
      const days = finite(sc.storage.average_inventory_days) ? sc.storage.average_inventory_days : 45;
      return sc.storage.cubic_feet_per_unit * sc.storage.rate_usd_per_cuft_month * (days / 30);
    }
    if (finite(sc.storage.usd_per_unit)) return sc.storage.usd_per_unit;
  }
  if (Array.isArray(sc.lines)) {
    const stor = sc.lines.find(l => l?.id === 'storage' && finite(l.amount_usd));
    if (stor) return stor.amount_usd;
  }
  return null;
}

function extractDeclaredScenariosFromGate1A(gate1aRecord) {
  if (Array.isArray(gate1aRecord?.declared_scenarios) && gate1aRecord.declared_scenarios.length > 0) {
    return gate1aRecord.declared_scenarios;
  }
  return (gate1aRecord?.scenarios ?? [])
    .filter(s => !s.price_below_floor && finite(s.price_usd))
    .map((s, idx) => ({
      id: nonemptyStr(s.id) ? s.id.trim() : `scenario-${idx + 1}`,
      operating_period_id: s.operating_period_id ?? null,
      price_usd: s.price_usd,
      fx_cny_per_usd: finite(s.fx_cny_per_usd) ? s.fx_cny_per_usd : (s.estimate?.fx_cny_per_usd ?? null),
      headhaul_usd: finite(s.headhaul_usd) ? s.headhaul_usd : (s.estimate?.components?.headhaul?.amount_usd ?? null),
      fulfillment_usd: s.estimate?.components?.fulfillment?.total_usd ?? null,
      placement_range_usd: s.estimate?.components?.placement?.range_usd ?? (
        finite(s.estimate?.components?.placement?.selected_usd)
          ? [s.estimate.components.placement.selected_usd, s.estimate.components.placement.selected_usd]
          : null
      ),
      storage_per_unit_usd: s.estimate?.components?.storage?.per_unit_usd ?? null,
      price_band: s.estimate?.price_band ?? null,
      sales_window: s.sales_window ?? s.estimate?.sales_window ?? null,
      storage_window: s.storage_window ?? s.estimate?.storage_window ?? null,
    }));
}

function mergeStage3DiagnosticIntoGate1b(form, diagnostic) {
  let prev = null;
  if (form?.gate1b_result_json) {
    try {
      const parsed = JSON.parse(form.gate1b_result_json);
      if (parsed && typeof parsed === 'object' && (!parsed.spec_sha256 || parsed.spec_sha256 === form.spec_sha256)) {
        prev = parsed;
      }
    } catch { /* ignore malformed historical JSON */ }
  }
  if (prev && (prev.status === 'gate1b_passed' || prev.owner_crossing_override === true || prev.quote_id)) {
    return {
      ...prev,
      stage3_status: diagnostic.status,
      ...(diagnostic.reason ? { stage3_reason: diagnostic.reason } : {}),
      ...(diagnostic.error ? { stage3_error: diagnostic.error } : {}),
      ...(Array.isArray(diagnostic.issues) ? { stage3_issues: diagnostic.issues } : {}),
    };
  }
  return diagnostic;
}

/**
 * Authoritatively inject persisted verified 1688 quote costs and exact sku_lines / order plan
 * into an early-screen scenario input, preventing caller builders from forging lower costs
 * or losing BigInt rational exactness from sku_lines[].
 */
function applyAuthoritativeQuoteToScreenInput(rawInput, persistedQuote, orderPlan, pricingInputs, effectiveProfileRevision = 59) {
  let skuLines = [];
  try {
    const parsed = JSON.parse(persistedQuote.sku_lines_json || '[]');
    if (Array.isArray(parsed)) skuLines = parsed;
  } catch { /* ignore */ }

  const sanitizedRaw = { ...rawInput };
  if (persistedQuote.pkg != null) sanitizedRaw.pkg = pricingInputs.pkg;
  if (persistedQuote.fx_cny_per_usd != null) sanitizedRaw.fx_cny_per_usd = pricingInputs.fx_cny_per_usd;
  // Strip any caller-injected nested procurement or conflicting source_inputs.sku_lines/order_units.
  delete sanitizedRaw.procurement;
  if (sanitizedRaw.source_inputs && typeof sanitizedRaw.source_inputs === 'object') {
    const si = { ...sanitizedRaw.source_inputs };
    delete si.sku_lines;
    delete si.order_units;
    delete si.complete_saleable_sets;
    sanitizedRaw.source_inputs = si;
  }

  const resolvedRev = Math.max(58, Number.isInteger(effectiveProfileRevision) ? effectiveProfileRevision : 59);

  if (skuLines.length > 0) {
    return {
      ...sanitizedRaw,
      profile_revision: resolvedRev,
      order_units: persistedQuote.actual_sets,
      target_sets: persistedQuote.actual_sets,
      allow_remainder: Boolean(orderPlan?.mode === 'allow_remainder'),
      sku_lines: skuLines,
      goods_cny_per_unit: null,
      procurement_usd: null,
      domestic_freight_cny_total: persistedQuote.domestic_freight_cny_total,
      domestic_freight_cny_per_unit: null,
      domestic_freight_usd: null,
      goods_first_order_promotion: Boolean(persistedQuote.goods_first_order_promotion),
      first_order_promotion: Boolean(persistedQuote.freight_first_order_promotion),
    };
  }

  const goodsPerSetRat = divBigRat(toBigRat(persistedQuote.goods_cny_total), toBigRat(persistedQuote.actual_sets));
  const goodsCnyPerUnit = roundBigRat(goodsPerSetRat.n, goodsPerSetRat.d, 10);
  return {
    ...sanitizedRaw,
    profile_revision: resolvedRev,
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

function resolveScenarioEffectivePrice(sc) {
  const pricing = resolveEffectivePricing(sc ?? {});
  return pricing.valid ? pricing.net_effective_price_usd : (finite(sc?.price_usd) ? sc.price_usd : null);
}

/**
 * Bind Gate 1B scenario inputs strictly against Gate 1A declared scenarios by scenario ID
 * (with safe 1-to-1 price/headhaul fallback only for legacy single-price callers omitting IDs).
 * Rejects omitted losing scenarios, invented prices, FX shifts, cheaper headhaul, and >$0.005 FBA drift.
 */
function bindGate1BScenariosToGate1A(rawScenarios, gate1aRecord) {
  const declared = extractDeclaredScenariosFromGate1A(gate1aRecord);
  if (declared.length === 0) {
    return { valid: true, matches: [], missingDeclared: [], issues: [] };
  }
  const byId = new Map(declared.map(d => [d.id, d]));
  const usedIds = new Set();
  const matches = new Array(rawScenarios.length).fill(null);
  const issues = [];

  // Pass 1: exact ID matching.
  for (let i = 0; i < rawScenarios.length; i++) {
    const sc = rawScenarios[i];
    const sid = nonemptyStr(sc?.id) ? sc.id.trim() : null;
    if (sid && byId.has(sid)) {
      if (usedIds.has(sid)) {
        issues.push(`Duplicate Gate 1B scenario id "${sid}".`);
        continue;
      }
      usedIds.add(sid);
      matches[i] = byId.get(sid);
    }
  }

  // Pass 2: fallback match for callers omitting declared scenario IDs (never lets 1 scenario satisfy 2 declared scenarios).
  for (let i = 0; i < rawScenarios.length; i++) {
    if (matches[i]) continue;
    const sc = rawScenarios[i];
    const effPrice = resolveScenarioEffectivePrice(sc);
    const scHeadhaul = resolveScreenHeadhaulUsd(sc);
    const candidates = declared.filter(d =>
      !usedIds.has(d.id) &&
      finite(effPrice) &&
      Math.abs(effPrice - d.price_usd) <= PARITY_TOLERANCE_USD,
    );
    let chosen = null;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else if (candidates.length > 1) {
      let narrowed = candidates;
      const scSalesWin = sc?.fee_context?.sales ?? sc?.sales_window ?? null;
      if (scSalesWin?.from && scSalesWin?.through) {
        const byWin = narrowed.filter(d => d.sales_window?.from === scSalesWin.from && d.sales_window?.through === scSalesWin.through);
        if (byWin.length >= 1) narrowed = byWin;
      }
      if (narrowed.length > 1 && finite(scHeadhaul)) {
        const exactH = narrowed.filter(d => finite(d.headhaul_usd) && Math.abs(scHeadhaul - d.headhaul_usd) <= PARITY_TOLERANCE_USD);
        if (exactH.length >= 1) narrowed = exactH;
      }
      const scStor = resolveScreenStorageUsd(sc);
      if (narrowed.length > 1 && finite(scStor)) {
        const exactS = narrowed.filter(d => finite(d.storage_per_unit_usd) && Math.abs(scStor - d.storage_per_unit_usd) <= PARITY_TOLERANCE_USD);
        if (exactS.length >= 1) narrowed = exactS;
      }
      if (narrowed.length >= 1 && (narrowed.length < candidates.length || finite(scHeadhaul) || finite(scStor))) {
        chosen = narrowed[0];
      }
    }
    if (!chosen) {
      issues.push(
        `Gate 1B scenario #${i + 1} (${sc?.id ?? 'unnamed'}, $${effPrice ?? sc?.price_usd}) does not match any remaining Gate 1A declared scenario (${declared.map(d => `${d.id}@$${d.price_usd}`).join(', ')}).`,
      );
      continue;
    }
    usedIds.add(chosen.id);
    matches[i] = chosen;
  }

  // Verify tight parity on every matched scenario.
  for (let i = 0; i < rawScenarios.length; i++) {
    const sc = rawScenarios[i];
    const decl = matches[i];
    if (!decl) continue;
    const effPrice = resolveScenarioEffectivePrice(sc);
    if (!finite(effPrice) || Math.abs(effPrice - decl.price_usd) > PARITY_TOLERANCE_USD) {
      issues.push(`Scenario "${decl.id}": Gate 1B payable price ($${effPrice}) conflicts with Gate 1A declared price ($${decl.price_usd}).`);
    }
    if (finite(sc.fx_cny_per_usd) && finite(decl.fx_cny_per_usd) && Math.abs(sc.fx_cny_per_usd - decl.fx_cny_per_usd) > FX_TOLERANCE) {
      issues.push(`Scenario "${decl.id}": Gate 1B fx_cny_per_usd (${sc.fx_cny_per_usd}) conflicts with Gate 1A declared FX (${decl.fx_cny_per_usd}).`);
    }
    const scHeadhaul = resolveScreenHeadhaulUsd(sc);
    if (finite(scHeadhaul) && finite(decl.headhaul_usd) && scHeadhaul < decl.headhaul_usd - PARITY_TOLERANCE_USD) {
      issues.push(`Scenario "${decl.id}": Gate 1B headhaul ($${scHeadhaul}) is below Gate 1A declared headhaul ($${decl.headhaul_usd}).`);
    }
    if (finite(sc.fulfillment_usd) && finite(decl.fulfillment_usd) && Math.abs(sc.fulfillment_usd - decl.fulfillment_usd) > PARITY_TOLERANCE_USD) {
      issues.push(`Scenario "${decl.id}" ($${effPrice}): Gate 1B fulfillment_usd ($${sc.fulfillment_usd}) conflicts with Gate 1A verified 2027 FBA tier ($${decl.fulfillment_usd}, band ${decl.price_band}).`);
    }
    if (finite(decl.coupon_fee_usd) && decl.coupon_fee_usd > 0) {
      const scHasCouponFields = (finite(sc.ongoing_coupon_usd) && sc.ongoing_coupon_usd > 0) ||
        (finite(sc.ongoing_coupon_pct) && sc.ongoing_coupon_pct > 0);
      const scExplicitAmazonOther = sc.other_payee === 'amazon' && finite(sc.other_applicable_usd)
        ? sc.other_applicable_usd
        : null;
      if (!scHasCouponFields && (!finite(scExplicitAmazonOther) || scExplicitAmazonOther < decl.coupon_fee_usd - PARITY_TOLERANCE_USD)) {
        issues.push(`Scenario "${decl.id}" ($${effPrice}): Gate 1B omits Gate 1A declared ongoing coupon redemption fee ($${decl.coupon_fee_usd}); supply ongoing_coupon_usd/ongoing_coupon_pct or Amazon other_applicable_usd.`);
      }
    }
    if (finite(sc.placement_usd) && Array.isArray(decl.placement_range_usd) && decl.placement_range_usd.length === 2) {
      const [lo, hi] = decl.placement_range_usd;
      if (finite(lo) && finite(hi) && (sc.placement_usd < lo - PARITY_TOLERANCE_USD || sc.placement_usd > hi + PARITY_TOLERANCE_USD)) {
        issues.push(`Scenario "${decl.id}" ($${effPrice}): Gate 1B placement_usd ($${sc.placement_usd}) falls outside Gate 1A verified placement range [$${lo}, $${hi}].`);
      }
    }
    const g1bStorUsd = resolveScreenStorageUsd(sc);
    if (finite(g1bStorUsd) && finite(decl.storage_per_unit_usd) && g1bStorUsd < decl.storage_per_unit_usd - PARITY_TOLERANCE_USD) {
      issues.push(`Scenario "${decl.id}" ($${effPrice}): Gate 1B storage ($${g1bStorUsd.toFixed(4)}) is below Gate 1A verified storage floor ($${decl.storage_per_unit_usd}).`);
    }
  }

  const missingDeclared = declared.filter(d => !usedIds.has(d.id));
  return {
    valid: issues.length === 0,
    matches,
    missingDeclared,
    issues,
  };
}

function collectPrimaryScenariosFromCandidate(inputCand) {
  const econ = inputCand?.economics;
  if (!econ || typeof econ !== 'object') return [];
  if (Array.isArray(econ.operating_periods)) {
    return econ.operating_periods.flatMap(p => (Array.isArray(p?.scenarios) ? p.scenarios : []));
  }
  return Array.isArray(econ.scenarios) ? econ.scenarios : [];
}

function extractEvidencedCancellations(expectedLists) {
  const cancelledIds = new Set();
  for (const list of expectedLists) {
    if (!Array.isArray(list)) continue;
    for (const exp of list) {
      if (
        exp &&
        exp.status === 'cancelled' &&
        nonemptyStr(exp.id) &&
        (nonemptyStr(exp.reason) || nonemptyStr(exp.evidence_note) || (Array.isArray(exp.evidence) && exp.evidence.length > 0))
      ) {
        cancelledIds.add(exp.id.trim());
      }
    }
  }
  return cancelledIds;
}

function isPeakOperatingContainer(period, scenarios = []) {
  if (Array.isArray(period?.months) && period.months.length > 0) {
    const sorted = [...period.months].sort((a, b) => a - b);
    if (sorted.length === 3 && sorted[0] === 10 && sorted[1] === 11 && sorted[2] === 12) return true;
    if (sorted.length === 4 && sorted[0] === 1 && sorted[1] === 10 && sorted[2] === 11 && sorted[3] === 12) return true;
    return period.months.every(m => Number.isInteger(m) && m >= 10 && m <= 12);
  }
  const firstSales = scenarios.find(s => s?.cost_ledger?.fee_context?.sales?.from)?.cost_ledger?.fee_context?.sales;
  return Boolean(firstSales?.from && firstSales.from >= '2027-10-01');
}

function windowsEqual(a, b) {
  if (!a || !b) return false;
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  return Boolean(a.from && a.through && b.from && b.through && a.from === b.from && a.through === b.through);
}

function verifyStage3ContainerBindings({
  containerLabel,
  scenarios,
  declaredForContainer,
  cancelledIds,
  isPeak,
  gate1aRecord,
  quote,
  quotesPool = null,
  requiredQuoteIds = null,
}) {
  const activeDeclared = declaredForContainer.filter(d => !cancelledIds.has(d.id));
  const declaredById = new Map(activeDeclared.map(d => [d.id, d]));
  const matchedDeclaredIds = new Set();
  const matchedDeclaredPairs = new Set();
  const availableQuotes = Array.isArray(quotesPool) && quotesPool.length > 0
    ? quotesPool
    : (quote ? [quote] : []);
  const quotesById = new Map(availableQuotes.filter(q => q?.quote_id).map(q => [q.quote_id, q]));
  const normalizedRequiredQuoteIds = Array.isArray(requiredQuoteIds)
    ? [...new Set(requiredQuoteIds.filter(nonemptyStr).map(q => q.trim()))]
    : [];
  const requiredQuoteIdSet = new Set(normalizedRequiredQuoteIds);
  for (const reqQid of normalizedRequiredQuoteIds) {
    if (!quotesById.has(reqQid)) {
      throw new TypeError(
        `Stage 3 ${containerLabel}missing usable persisted 1688 quote "${reqQid}" that was evaluated in Gate 1B.`,
      );
    }
  }

  for (const sc of scenarios) {
    const ledger = sc?.cost_ledger;
    if (!ledger || typeof ledger !== 'object') continue;
    const effPrice = resolveScenarioEffectivePrice(ledger);
    const scHeadhaul = resolveScreenHeadhaulUsd(ledger);
    const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
    const rawExplicitQuoteId = sc?.quote_id ?? ledger?.source_inputs?.quote_id ?? null;
    const explicitQuoteId = nonemptyStr(rawExplicitQuoteId) ? rawExplicitQuoteId.trim() : null;
    if (explicitQuoteId && !quotesById.has(explicitQuoteId)) {
      throw new TypeError(
        `Stage 3 ${containerLabel}scenario "${sc?.id ?? 'unknown'}" references unknown or unusable quote_id "${explicitQuoteId}".`,
      );
    }
    if (explicitQuoteId && requiredQuoteIdSet.size > 0 && !requiredQuoteIdSet.has(explicitQuoteId)) {
      throw new TypeError(
        `Stage 3 ${containerLabel}scenario "${sc?.id ?? 'unknown'}" references quote_id "${explicitQuoteId}" which was not evaluated in Gate 1B (${normalizedRequiredQuoteIds.join(', ')}); re-run Gate 1B before Stage 3.`,
      );
    }
    if (!explicitQuoteId && normalizedRequiredQuoteIds.length > 1) {
      throw new TypeError(
        `Stage 3 ${containerLabel}scenario "${sc?.id ?? 'unknown'}" must specify an explicit quote_id when multiple Gate 1B quotes (${normalizedRequiredQuoteIds.join(', ')}) were evaluated.`,
      );
    }
    const activeQuote = explicitQuoteId ? quotesById.get(explicitQuoteId) : quote;
    const activeQuoteKey = activeQuote?.quote_id ?? (normalizedRequiredQuoteIds.length === 1 ? normalizedRequiredQuoteIds[0] : 'default');

    // Match Stage 3 scenario against Gate 1A declared scenario strictly within this period/container.
    let matchedDecl = null;
    if (activeDeclared.length > 0) {
      const sid = nonemptyStr(sc?.id) ? sc.id.trim() : null;
      const rawBaseId = sc?.base_scenario_id ?? sc?.declared_scenario_id ?? ledger?.source_inputs?.declared_scenario_id ?? null;
      const baseId = nonemptyStr(rawBaseId) ? rawBaseId.trim() : null;
      if (baseId) {
        if (!declaredById.has(baseId)) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc?.id ?? 'unknown'}" declared_scenario_id "${baseId}" is not in Gate 1A declared scenarios.`,
          );
        }
        matchedDecl = declaredById.get(baseId);
      } else if (sid && declaredById.has(sid)) {
        matchedDecl = declaredById.get(sid);
      } else {
        const prefixMatches = sid
          ? [...activeDeclared]
              .sort((a, b) => b.id.length - a.id.length)
              .filter(d =>
                (sid.startsWith(`${d.id}:`) || sid.startsWith(`${d.id}__`) || sid.startsWith(`${d.id}-`)) &&
                (!finite(effPrice) || Math.abs(effPrice - d.price_usd) <= PARITY_TOLERANCE_USD),
              )
          : [];
        if (prefixMatches.length > 0) {
          matchedDecl = prefixMatches.find(d => !matchedDeclaredPairs.has(`${d.id}::${activeQuoteKey}`)) ?? prefixMatches[0];
        } else {
          const byPriceUnusedForQuote = activeDeclared.filter(d =>
            !matchedDeclaredPairs.has(`${d.id}::${activeQuoteKey}`) &&
            finite(effPrice) &&
            Math.abs(effPrice - d.price_usd) <= PARITY_TOLERANCE_USD,
          );
          if (byPriceUnusedForQuote.length === 1) {
            matchedDecl = byPriceUnusedForQuote[0];
          } else if (byPriceUnusedForQuote.length > 1) {
            const byHeadhaul = finite(scHeadhaul)
              ? byPriceUnusedForQuote.filter(d => finite(d.headhaul_usd) && Math.abs(scHeadhaul - d.headhaul_usd) <= PARITY_TOLERANCE_USD)
              : [];
            matchedDecl = byHeadhaul[0] ?? byPriceUnusedForQuote[0];
          }
        }
      }
      if (!matchedDecl) {
        throw new TypeError(
          `Stage 3 ${containerLabel}scenario "${sc.id}" ($${effPrice}) is not bound to Gate 1A declared scenarios (${activeDeclared.map(d => `${d.id}@$${d.price_usd}`).join(', ')}).`,
        );
      }
      if (!finite(effPrice) || Math.abs(effPrice - matchedDecl.price_usd) > PARITY_TOLERANCE_USD) {
        throw new TypeError(
          `Stage 3 ${containerLabel}scenario "${sc.id}" price ($${effPrice}) conflicts with Gate 1A declared scenario "${matchedDecl.id}" ($${matchedDecl.price_usd}).`,
        );
      }
      if (finite(scHeadhaul) && finite(matchedDecl.headhaul_usd) && scHeadhaul < matchedDecl.headhaul_usd - PARITY_TOLERANCE_USD) {
        throw new TypeError(
          `Stage 3 ${containerLabel}scenario "${sc.id}" headhaul ($${scHeadhaul}) is below Gate 1A declared headhaul ($${matchedDecl.headhaul_usd}) for "${matchedDecl.id}".`,
        );
      }

      matchedDeclaredIds.add(matchedDecl.id);
      matchedDeclaredPairs.add(`${matchedDecl.id}::${activeQuoteKey}`);
    }

    if (activeQuote) {
      const procLine = lines.find(l => l?.id === 'procurement');
      const domLine = lines.find(l => l?.id === 'domestic_freight');
      const acceptedFx = matchedDecl?.fx_cny_per_usd ??
        (gate1aRecord?.scenarios ?? []).map(s => s?.estimate?.fx_cny_per_usd).find(v => finite(v) && v > 0) ??
        null;
      const suppliedFxList = [procLine?.fx_cny_per_usd, domLine?.fx_cny_per_usd, ledger.fx_cny_per_usd, ledger.source_inputs?.fx_cny_per_usd]
        .filter(v => finite(v) && v > 0);

      if (acceptedFx !== null) {
        for (const sFx of suppliedFxList) {
          if (Math.abs(sFx - acceptedFx) > FX_TOLERANCE) {
            throw new TypeError(
              `Stage 3 ${containerLabel}scenario "${sc.id}" FX (${sFx}) conflicts with Gate 1A accepted FX (${acceptedFx}); quote conversion cannot drift across gates.`,
            );
          }
        }
      }
      const effectiveFx = acceptedFx ?? suppliedFxList[0] ?? null;

      if (procLine && procLine.status !== 'pending' && finite(procLine.amount_usd)) {
        if (procLine.order_units !== undefined && procLine.order_units !== activeQuote.actual_sets) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" procurement.order_units (${procLine.order_units}) conflicts with persisted 1688 quote actual_sets (${activeQuote.actual_sets}).`,
          );
        }
        if (effectiveFx === null) {
          throw new TypeError(`Stage 3 ${containerLabel}scenario "${sc.id}" requires fx_cny_per_usd to verify procurement parity against persisted CNY 1688 quote.`);
        }
        const expectedProcUsd = (activeQuote.goods_cny_total / activeQuote.actual_sets) / effectiveFx;
        if (Math.abs(procLine.amount_usd - expectedProcUsd) > PARITY_TOLERANCE_USD) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" procurement ($${procLine.amount_usd}) disagrees with persisted 1688 quote "${activeQuote.quote_id}" ($${expectedProcUsd.toFixed(4)} at accepted FX ${effectiveFx}).`,
          );
        }
      }
      if (domLine && domLine.status !== 'pending' && domLine.status !== 'deferred' && finite(domLine.amount_usd)) {
        if (domLine.order_units !== undefined && domLine.order_units !== activeQuote.actual_sets) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" domestic_freight.order_units (${domLine.order_units}) conflicts with persisted 1688 quote actual_sets (${activeQuote.actual_sets}).`,
          );
        }
        if (effectiveFx === null) {
          throw new TypeError(`Stage 3 ${containerLabel}scenario "${sc.id}" requires fx_cny_per_usd to verify domestic_freight parity against persisted CNY 1688 quote.`);
        }
        const expectedDomUsd = (activeQuote.domestic_freight_cny_total / activeQuote.actual_sets) / effectiveFx;
        if (Math.abs(domLine.amount_usd - expectedDomUsd) > PARITY_TOLERANCE_USD) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" domestic_freight ($${domLine.amount_usd}) disagrees with persisted 1688 quote "${activeQuote.quote_id}" ($${expectedDomUsd.toFixed(4)} at accepted FX ${effectiveFx}).`,
          );
        }
      }
    }

    if (matchedDecl) {
      // Enforce tight FBA fee parity against Gate 1A verified 2027 schedule on non-pending Stage 3 lines!
      const fulLine = lines.find(l => l?.id === 'fulfillment');
      const salesWindowMatches = !matchedDecl.sales_window || !ledger.fee_context?.sales ||
        windowsEqual(matchedDecl.sales_window, ledger.fee_context.sales);
      if (
        fulLine &&
        fulLine.status !== 'pending' &&
        finite(fulLine.amount_usd) &&
        finite(matchedDecl.fulfillment_usd) &&
        (!isPeak || salesWindowMatches)
      ) {
        if (Math.abs(fulLine.amount_usd - matchedDecl.fulfillment_usd) > PARITY_TOLERANCE_USD) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" fulfillment ($${fulLine.amount_usd}) conflicts with Gate 1A verified 2027 FBA tier ($${matchedDecl.fulfillment_usd}, band ${matchedDecl.price_band}).`,
          );
        }
      }
      if (!isPeak && finite(matchedDecl.coupon_fee_usd) && matchedDecl.coupon_fee_usd > 0) {
        const ledgerHasCouponFields = (finite(ledger.ongoing_coupon_usd) && ledger.ongoing_coupon_usd > 0) ||
          (finite(ledger.ongoing_coupon_pct) && ledger.ongoing_coupon_pct > 0);
        const otherLine = lines.find(l => l?.id === 'other_applicable');
        const otherLineHasCoupon = otherLine && otherLine.status !== 'pending' &&
          finite(otherLine.amount_usd) && otherLine.amount_usd >= matchedDecl.coupon_fee_usd - PARITY_TOLERANCE_USD;
        if (!ledgerHasCouponFields && !otherLineHasCoupon) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" omits Gate 1A declared ongoing coupon redemption fee ($${matchedDecl.coupon_fee_usd}).`,
          );
        }
      }
      const plcLine = lines.find(l => l?.id === 'placement');
      if (
        plcLine &&
        plcLine.status !== 'pending' &&
        finite(plcLine.amount_usd) &&
        Array.isArray(matchedDecl.placement_range_usd) &&
        matchedDecl.placement_range_usd.length === 2
      ) {
        const [lo, hi] = matchedDecl.placement_range_usd;
        const allowZeroOpt = plcLine.amount_usd === 0 && plcLine.split_option === 'amazon_optimized';
        if (!allowZeroOpt && finite(lo) && finite(hi) && (plcLine.amount_usd < lo - PARITY_TOLERANCE_USD || plcLine.amount_usd > hi + PARITY_TOLERANCE_USD)) {
          throw new TypeError(
            `Stage 3 ${containerLabel}scenario "${sc.id}" placement ($${plcLine.amount_usd}) falls outside Gate 1A verified placement range [$${lo}, $${hi}].`,
          );
        }
      }
      const storLine = lines.find(l => l?.id === 'storage');
      if (
        storLine &&
        storLine.status !== 'pending' &&
        finite(storLine.amount_usd) &&
        finite(matchedDecl.storage_per_unit_usd) &&
        storLine.amount_usd < matchedDecl.storage_per_unit_usd - PARITY_TOLERANCE_USD
      ) {
        throw new TypeError(
          `Stage 3 ${containerLabel}scenario "${sc.id}" storage ($${storLine.amount_usd}) is below Gate 1A verified storage floor ($${matchedDecl.storage_per_unit_usd}).`,
        );
      }
    }
  }

  // Require EVERY active (non-cancelled) Gate 1A declared scenario to remain present in this period/container!
  // Prevents an owner-overridden crossing interval or seasonal off_peak panel from dropping its losing half in Stage 3.
  const missingInStage3 = activeDeclared.filter(d => !matchedDeclaredIds.has(d.id));
  if (missingInStage3.length > 0) {
    throw new TypeError(
      `Stage 3 ${containerLabel}omitted active Gate 1A declared scenario(s) (${missingInStage3.map(d => `${d.id}@$${d.price_usd}`).join(', ')}) without evidenced cancellation in expected_primary_scenarios.`,
    );
  }

  // When verified 1688 quote(s) were evaluated in Gate 1B, require EVERY active (declaredScenario × quote_id) pair!
  if (normalizedRequiredQuoteIds.length >= 1 && activeDeclared.length > 0) {
    const missingPairs = [];
    for (const d of activeDeclared) {
      for (const reqQid of normalizedRequiredQuoteIds) {
        const pairCancelled =
          cancelledIds.has(`${d.id}:${reqQid}`) ||
          cancelledIds.has(`${d.id}__${reqQid}`) ||
          cancelledIds.has(`${d.id}-${reqQid}`) ||
          (normalizedRequiredQuoteIds.length === 1 && cancelledIds.has(d.id));
        if (!pairCancelled && !matchedDeclaredPairs.has(`${d.id}::${reqQid}`)) {
          missingPairs.push(`${d.id}×${reqQid}@$${d.price_usd}`);
        }
      }
    }
    if (missingPairs.length > 0) {
      throw new TypeError(
        `Stage 3 ${containerLabel}omitted active Gate 1A × Gate 1B scenario-quote pair(s) (${missingPairs.join(', ')}); cannot drop losing factory quote(s) in Stage 3.`,
      );
    }
  }
}

function verifyStage3CandidateBindings(inputCand, gate1aRecord, quote, quotesPool = null, gate1bRecord = null) {
  const declared = extractDeclaredScenariosFromGate1A(gate1aRecord);
  const econ = inputCand?.economics ?? {};
  const requiredQuoteIds = Array.isArray(gate1bRecord?.quote_ids) && gate1bRecord.quote_ids.length > 0
    ? gate1bRecord.quote_ids
    : (quote?.quote_id ? [quote.quote_id] : []);

  if (Array.isArray(econ.operating_periods) && econ.operating_periods.length > 0) {
    for (const period of econ.operating_periods) {
      const pScens = Array.isArray(period?.scenarios) ? period.scenarios : [];
      const periodSpecific = declared.filter(d =>
        (nonemptyStr(period?.id) && d.operating_period_id === period.id) ||
        (period?.sales_window && d.sales_window && windowsEqual(d.sales_window, period.sales_window)),
      );
      const declaredForPeriod = periodSpecific.length > 0 ? periodSpecific : declared;
      const cancelledIds = extractEvidencedCancellations([
        econ.expected_primary_scenarios,
        period?.expected_primary_scenarios,
      ]);
      verifyStage3ContainerBindings({
        containerLabel: `period "${period?.id ?? 'unknown'}" `,
        scenarios: pScens,
        declaredForContainer: declaredForPeriod,
        cancelledIds,
        isPeak: isPeakOperatingContainer(period, pScens),
        gate1aRecord,
        quote,
        quotesPool,
        requiredQuoteIds,
      });
    }
    return;
  }

  const primaryScenarios = collectPrimaryScenariosFromCandidate(inputCand);
  const cancelledIds = extractEvidencedCancellations([econ.expected_primary_scenarios]);
  verifyStage3ContainerBindings({
    containerLabel: '',
    scenarios: primaryScenarios,
    declaredForContainer: declared,
    cancelledIds,
    isPeak: false,
    gate1aRecord,
    quote,
    quotesPool,
    requiredQuoteIds,
  });
}

function buildCliffStressObject(templateLedger, targetPoint, cliff, { id, label, saleableUnit, operatingPeriodId = null }) {
  const stressLedger = structuredClone(templateLedger);
  stressLedger.id = id;
  stressLedger.price_usd = targetPoint.price_usd;
  delete stressLedger.list_price_usd;
  delete stressLedger.net_effective_price_usd;
  delete stressLedger.ongoing_coupon_usd;
  delete stressLedger.ongoing_coupon_pct;
  delete stressLedger.prime_exclusive_discount_usd;
  delete stressLedger.prime_exclusive_discount_pct;
  stressLedger.sensitivity_only = true;
  const fulLine = stressLedger.lines.find(l => l.id === 'fulfillment');
  if (fulLine && finite(targetPoint.fulfillment_usd)) {
    fulLine.amount_usd = targetPoint.fulfillment_usd;
    fulLine.basis = `Gate 1A $50.00 tier-cliff stress comparison ($${targetPoint.price_usd} -> ${targetPoint.price_band})`;
    if (fulLine.fee_basis && typeof fulLine.fee_basis === 'object' && targetPoint.price_band) {
      fulLine.fee_basis.price_band = targetPoint.price_band;
    }
  }
  const refLine = stressLedger.lines.find(l => l.id === 'referral');
  if (refLine && finite(targetPoint.referral_usd)) {
    refLine.amount_usd = targetPoint.referral_usd;
    refLine.basis = `Gate 1A $50.00 tier-cliff referral recalculated at $${targetPoint.price_usd}`;
  }
  const colLine = stressLedger.lines.find(l => l.id === 'collection');
  if (colLine && finite(targetPoint.collection_usd)) {
    colLine.amount_usd = targetPoint.collection_usd;
    colLine.basis = `Gate 1A $50.00 tier-cliff collection recalculated at $${targetPoint.price_usd}`;
  }
  return {
    id,
    label,
    stress_type: 'price_cliff_50',
    ...(operatingPeriodId ? { operating_period_id: operatingPeriodId } : {}),
    saleable_unit: saleableUnit,
    coherent: true,
    assumptions: [
      cliff.sweet_spot_note || `Gate 1A $50.00 FBA 配送费跳档对照（跳幅 +$${cliff.cliff_jump_usd ?? 0}）。`,
    ],
    cost_ledger: stressLedger,
  };
}

export function attachGate1APriceCliffStress(inputCand, gate1aRecord) {
  const cliffScenarios = (gate1aRecord?.scenarios ?? []).filter(s => s?.price_cliff_50?.status === 'verified');
  if (cliffScenarios.length === 0) return;

  const econ = inputCand?.economics;
  if (!econ || typeof econ !== 'object') return;
  const existingStress = Array.isArray(econ.stress_scenarios) ? [...econ.stress_scenarios] : [];
  const existingIds = new Set(existingStress.map(s => s?.id).filter(Boolean));

  const attachForContainer = (templateSc, cliff, periodId = null) => {
    if (!templateSc?.cost_ledger || !Array.isArray(templateSc.cost_ledger.lines)) return;
    const fulLine = templateSc.cost_ledger.lines.find(l => l?.id === 'fulfillment');
    if (fulLine && (fulLine.status === 'pending' || fulLine.amount_usd === null)) return;
    const pts = (cliff.points ?? []).filter(p => (p.price_usd === 49.99 || p.price_usd === 50.00) && p.status === 'verified');
    for (const pt of pts) {
      const suffix = pt.price_usd === 49.99 ? '49-99' : '50-00';
      const stressId = periodId ? `gate1a-price-cliff-${periodId}-${suffix}` : `gate1a-price-cliff-${suffix}`;
      if (existingIds.has(stressId)) continue;
      existingIds.add(stressId);
      existingStress.push(buildCliffStressObject(templateSc.cost_ledger, pt, cliff, {
        id: stressId,
        label: `${periodId ? `[${periodId}] ` : ''}$50 费档甜点压力对照（$${pt.price_usd.toFixed(2)}）`,
        saleableUnit: econ.saleable_unit,
        operatingPeriodId: periodId,
      }));
    }
  };

  if (Array.isArray(econ.operating_periods) && econ.operating_periods.length > 0) {
    for (const period of econ.operating_periods) {
      const pScens = Array.isArray(period?.scenarios) ? period.scenarios : [];
      const templateSc = pScens.find(s => s?.cost_ledger && Array.isArray(s.cost_ledger.lines));
      if (!templateSc) continue;
      const periodSalesWin = period.sales_window ?? templateSc.cost_ledger?.fee_context?.sales ?? null;
      const directMatch = cliffScenarios.find(cs =>
        (period.id && cs.operating_period_id && cs.operating_period_id === period.id) ||
        (periodSalesWin && cs.sales_window && windowsEqual(cs.sales_window, periodSalesWin)) ||
        (period.id && cs.id?.includes(period.id)),
      );
      // NEVER copy non-peak Gate 1A cliff rates onto an Oct-Dec peak period or pending fulfillment panel!
      const isPeak = isPeakOperatingContainer(period, pScens);
      const nonPeakTemplateOk = !isPeak &&
        (!periodSalesWin || (periodSalesWin.from >= '2027-01-15' && periodSalesWin.through <= '2027-10-14'));
      const matchedCliff = directMatch?.price_cliff_50 ??
        (nonPeakTemplateOk ? cliffScenarios.find(cs => !cs.operating_period_id)?.price_cliff_50 : null);
      if (!matchedCliff) continue;
      attachForContainer(templateSc, matchedCliff, period.id ?? 'period');
    }
  } else {
    const primaryScenarios = collectPrimaryScenariosFromCandidate(inputCand);
    const templateSc = primaryScenarios.find(s => s?.cost_ledger && Array.isArray(s.cost_ledger.lines));
    if (templateSc) {
      attachForContainer(templateSc, cliffScenarios[0].price_cliff_50, null);
    }
  }

  econ.stress_scenarios = existingStress;
}

function getNegotiationDiscountFraction(neg) {
  if (!neg || typeof neg !== 'object') return Infinity;
  const val = neg.required_discount_fraction ?? neg.required_reduction_fraction;
  return finite(val) ? val : Infinity;
}

function projectForwardPricingInputs(scenario) {
  const inputs = Object.fromEntries(
    FORWARD_FEE_INPUTS.filter(key => Object.hasOwn(scenario, key)).map(key => [key, scenario[key]]),
  );
  if (containsSecretToken(inputs)) return null;
  try {
    assertNoRawPii(inputs, 'Gate 1A forward pricing inputs');
  } catch {
    return null;
  }
  return inputs;
}

function computeGate1BForwardPricing(gate1a, quote) {
  const minRetail = gate1a.minimum_price_usd ?? 29.99;
  const floorRat = toBigRat(minRetail);
  const retailFloorCents = Number((floorRat.n * 100n + floorRat.d - 1n) / floorRat.d);
  const lastNonPeakDay = getFba2027RateTableSnapshot().metadata.non_peak_fulfillment_window.through;
  const pricingScenarios = gate1a.forward_pricing_scenarios ?? [];
  const feeInputsById = new Map(pricingScenarios.map(s => [s.id, s.fee_inputs]));
  const discoveryOnly = gate1a.forward_price_discovery_only === true;
  const declarations = discoveryOnly ? pricingScenarios : extractDeclaredScenariosFromGate1A(gate1a);
  const bindings = new Map(declarations.map(declared => [declared.id, bindSourcingQuotePricingInputs(quote, {
    ...declared,
    ...feeInputsById.get(declared.id),
  }, { requireDeclaredPackage: !discoveryOnly })]));
  const quoteBasisIssues = [...bindings].flatMap(([id, binding]) =>
    binding.issue ? [{ id, reason: binding.issue }] : []);
  const skippedPeakIds = [];
  const results = [];
  for (const declared of pricingScenarios) {
    const inputs = declared.fee_inputs;
    if (declared.operating_period_id === 'peak' ||
      (inputs?.sales_window?.through > lastNonPeakDay && inputs.sales_window.through <= '2028-01-14')) {
      skippedPeakIds.push(declared.id);
      continue;
    }
    const binding = bindings.get(declared.id);
    const solution = binding?.issue
      ? { status: 'needs_calculator_verification', reason: binding.issue }
      : inputs
      ? solveMinPriceForMargin2027({ ...inputs, landed_domestic_quote: quote, min_retail_price_usd: minRetail })
      : { status: 'needs_calculator_verification', reason: 'No usable persisted fee inputs for this scenario.' };
    results.push({ declared, solution, binding });
  }

  // Every scenario must support the same payable price. Compare within fee bands so a
  // price just above $50 cannot pass on the strength of a lower-band minimum alone.
  const sharedBandMinima = ['under_10', '10_to_50', 'over_50'].flatMap(band => {
    if (results.length === 0) return [];
    const minima = results.map(({ solution }) => solution.band_solutions?.[band]?.min_price_usd);
    if (!minima.every(finite)) return [];
    const price = Math.max(retailFloorCents / 100, ...minima);
    const inBand = band === 'under_10' ? price < 10 : (band === '10_to_50' ? price <= 50 : true);
    return inBand ? [price] : [];
  });
  const sharedMinimum = quoteBasisIssues.length === 0 && sharedBandMinima.length > 0 ? Math.min(...sharedBandMinima) : null;
  const hasProvenInfeasibleScenario = results.some(({ solution }) => solution.status === 'infeasible');
  return {
    status: sharedMinimum !== null ? 'verified' : (quoteBasisIssues.length === 0 && hasProvenInfeasibleScenario ? 'infeasible' : 'needs_calculator_verification'),
    advisory_only: true,
    quote_id: quote.quote_id,
    actual_sets: quote.actual_sets,
    margin_floor: 0.30,
    min_retail_price_usd: minRetail,
    feasible_min_price_usd: sharedMinimum,
    min_retail_price_for_30pct_usd: sharedMinimum,
    skipped_peak_scenario_ids: skippedPeakIds,
    ...(quoteBasisIssues.length > 0 ? { quote_basis_issues: quoteBasisIssues } : {}),
    scenario_results: results.map(({ declared, solution, binding }) => ({
      id: declared.id,
      operating_period_id: declared.operating_period_id,
      status: solution.status,
      feasible_min_price_usd: solution.feasible_min_price_usd ?? null,
      min_retail_price_for_30pct_usd: solution.feasible_min_price_usd ?? null,
      landed_domestic_cny_per_set: solution.landed_domestic_cny ?? null,
      landed_domestic_usd_per_set: solution.landed_domestic_usd ?? null,
      price_band: solution.price_band ?? null,
      cliff_dead_zone: solution.cliff_dead_zone ?? null,
      ...(binding?.pricing_input_basis ? { pricing_input_basis: binding.pricing_input_basis } : {}),
      ...(solution.reason ? { reason: solution.reason } : {}),
    })),
    ...(results.length === 0 ? { reason: 'No declared non-peak fee scenarios are available for forward pricing.' } : {}),
  };
}

/**
 * Evaluate Gate 1A locally (0 browser / 0 paid deep-research calls).
 * - Enforces Gate 0 category boundary (fixed non-overridable children's exclusion + configurable red-ocean defaults).
 * - Enforces Stage-1 price-band width guardrail when price_band_analysis is supplied without tightened cluster bands.
 * - Enforces minimum_price_usd >= 29.99.
 * - Persists complete declared_scenarios[] (IDs + price/FX/headhaul/FBA fees) for strict Gate 1B & Stage 3 binding.
 * - Preserves a previously proven specific_rights_conflict on the SAME spec_sha256 and clears stale shortlist.
 */
export function runGate1AForForm(store, {
  form_id,
  scenarios,
  matched_peers = null,
  supplier_nominal_pkg = null,
  minimum_price_usd = 29.99,
  specific_rights_conflict = 'unknown',
  strong_date_dependency = 'unknown',
  category_check = null,
  gate0_options = {},
  price_band_analysis = null,
  cluster_bands = null,
  profile_revision = 59,
  disallow_pre1688_cost_guess_kill = true,
  allow_forward_price_discovery = false,
} = {}) {
  const form = store.getCandidateForm(form_id);
  if (!form) throw new TypeError(`Unknown form_id for Gate 1A: ${form_id}`);
  if (!finite(minimum_price_usd) || minimum_price_usd < 29.99) {
    throw new TypeError('Gate 1A minimum_price_usd must be a finite number >= 29.99.');
  }
  if (typeof disallow_pre1688_cost_guess_kill !== 'boolean' || typeof allow_forward_price_discovery !== 'boolean') {
    throw new TypeError('Gate 1A forward pricing options must be booleans.');
  }
  scenarios ??= allow_forward_price_discovery ? [] : null;
  if (!Array.isArray(scenarios) || (scenarios.length === 0 && !allow_forward_price_discovery)) {
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
  if (effectiveRights === 'unknown' && hasProvenRightsConflictOnCurrentSpec(form)) {
    effectiveRights = true;
  }

  const baseMeta = {
    spec_sha256: form.spec_sha256,
    spec_version: form.spec_version,
    specific_rights_conflict_proven: effectiveRights === true,
    minimum_price_usd,
    disallow_pre1688_cost_guess_kill,
    allow_forward_price_discovery,
    landed_domestic_cap_advisory_only: true,
  };

  // Gate 0 category boundary check (fixed non-overridable children's exclusion + configurable red-ocean defaults).
  const gate0Input = {
    title: [form.label, form.core_form, form.buyer_task].filter(Boolean).join(' '),
    ...(category_check && typeof category_check === 'object' ? category_check : {}),
  };
  const isR59Gate1ADefault = (profile_revision ?? 59) >= 59;
  const gate0 = evaluateGate0CategoryBoundary(gate0Input, {
    ...(gate0_options ?? {}),
    profile_revision: profile_revision ?? 59,
  });
  const enforceRedOceanHardBlock = gate0_options?.enforce_red_ocean_skip === true || !isR59Gate1ADefault;
  if (gate0.hard_exclusion === true || (gate0.passed === false && enforceRedOceanHardBlock)) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      gate0,
      reason: `Gate 0 category boundary rejected form: ${gate0.reasons.join(' ')}`,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: [],
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', {
      gate1a_result: payload,
      landed_domestic_cap_cny: null,
      negotiation_shortlist: null,
      packaging_redesign_shortlist: null,
    });
    return payload;
  }
  if (gate0.passed === false && !gate0.hard_exclusion) {
    baseMeta.red_ocean_soft_guidance = gate0;
  }

  // Stage-1 price-band guardrail check when peer listings or analysis are provided.
  const defaultStrictMature = isR59Gate1ADefault;
  if (defaultStrictMature && (price_band_analysis?.options?.strict_mature_only === false || price_band_analysis?.strict_mature_only === false)) {
    throw new TypeError('Cannot disable strict_mature_only under Revision 59.');
  }
  const requestedSpiralMaxAge = price_band_analysis?.options?.spiral_max_age_days ?? price_band_analysis?.spiral_max_age_days;
  if (defaultStrictMature && requestedSpiralMaxAge !== undefined && (!finite(requestedSpiralMaxAge) || requestedSpiralMaxAge < 90)) {
    throw new TypeError('Revision 59 requires spiral_max_age_days >= 90 (3 months) for newcomer separation.');
  }
  const effectiveBandOptions = {
    ...(price_band_analysis?.options ?? {}),
    ...(profile_revision !== undefined ? { profile_revision } : {}),
    ...(defaultStrictMature ? { strict_mature_only: true, spiral_max_age_days: Math.max(90, finite(requestedSpiralMaxAge) ? requestedSpiralMaxAge : 90) } : {}),
  };
  let resolvedPriceBand = null;
  let resolvedClusterBands = cluster_bands ?? null;
  if (price_band_analysis) {
    resolvedPriceBand = Array.isArray(price_band_analysis)
      ? analyzeMainstreamPriceBand(price_band_analysis, effectiveBandOptions)
      : (Array.isArray(price_band_analysis.listings)
        ? analyzeMainstreamPriceBand(price_band_analysis.listings, effectiveBandOptions)
        : price_band_analysis);
    if (Array.isArray(price_band_analysis.clusters) && !resolvedClusterBands) {
      resolvedClusterBands = tightenClusterBands(resolvedPriceBand, price_band_analysis.clusters, effectiveBandOptions);
    }
  }

  const strictMatureMode = Boolean(
    effectiveBandOptions.strict_mature_only === true ||
    resolvedPriceBand?.strict_mature_only === true,
  );
  const effectiveAsOfDate = price_band_analysis?.options?.as_of_date ?? price_band_analysis?.options?.observation_date ?? new Date().toISOString().slice(0, 10);
  const spiralMaxAgeDays = defaultStrictMature
    ? Math.max(90, finite(requestedSpiralMaxAge) ? requestedSpiralMaxAge : 90)
    : (finite(requestedSpiralMaxAge) ? requestedSpiralMaxAge : 120);
  const regularBand = strictMatureMode
    ? (resolvedPriceBand?.mature_regular_band ?? null)
    : (resolvedPriceBand?.regular_band_reference ?? resolvedPriceBand?.band ?? null);
  if (regularBand) baseMeta.regular_band_reference = regularBand;
  const isAllUnder90dBlueOcean = Boolean(
    resolvedPriceBand?.all_under_90d_blue_ocean === true ||
    resolvedPriceBand?.mature_regular_band?.all_under_90d_blue_ocean === true,
  );
  if (isAllUnder90dBlueOcean) {
    baseMeta.all_under_90d_blue_ocean = true;
    baseMeta.top_amber_banner_zh = resolvedPriceBand?.top_amber_banner_zh ??
      resolvedPriceBand?.mature_regular_band?.top_amber_banner_zh ??
      '全员 90 天内新品蓝海，暂无一年期老品稳态价';
  }
  const peerPackageCalibration = Array.isArray(matched_peers) && matched_peers.length > 0
    ? computeMatchedPeerMedianPackage(matched_peers, { supplier_nominal_pkg })
    : null;
  if (peerPackageCalibration) {
    baseMeta.peer_package_calibration = peerPackageCalibration;
    if (peerPackageCalibration.sample_warning_tag) {
      baseMeta.sample_warning_tag = peerPackageCalibration.sample_warning_tag;
    }
  }
  const isR59Gate1A = (profile_revision ?? 59) >= 59;
  const promoRowsByAsin = new Map(
    (Array.isArray(resolvedPriceBand?.spiral_watch) ? resolvedPriceBand.spiral_watch : [])
      .map(row => [row.asin, row]),
  );
  const mainstreamAsinsR59 = isR59Gate1A && Array.isArray(resolvedPriceBand?.mainstream_pool)
    ? new Set(resolvedPriceBand.mainstream_pool.map(r => String(r?.asin || '').trim().toUpperCase()).filter(Boolean))
    : null;
  const outOfBandPeersR59 = isR59Gate1A && Array.isArray(resolvedPriceBand?.observed_out_of_band_peers)
    ? resolvedPriceBand.observed_out_of_band_peers
    : [];
  const outOfBandByAsinR59 = new Map(
    outOfBandPeersR59
      .filter(r => nonemptyStr(r?.asin))
      .map(r => [r.asin.trim().toUpperCase(), r]),
  );
  const hasAgeContextForScenarios = scenarios.some(
    s => resolveAgeDays(s, effectiveAsOfDate) !== null || s?.strict_age_check === true || nonemptyStr(s?.asin),
  );
  const scenarioResults = [];
  const resolvedInputScenarios = [];
  const seenIds = new Set();
  for (let i = 0; i < scenarios.length; i++) {
    const rawSc = scenarios[i];
    if (!rawSc || typeof rawSc !== 'object' || Array.isArray(rawSc)) {
      throw new TypeError('Each Gate 1A scenario must be an object.');
    }
    const sc = {
      ...rawSc,
      ...(peerPackageCalibration && (!rawSc.pkg || rawSc.use_peer_median_pkg === true)
        ? { pkg: peerPackageCalibration.median_pkg }
        : {}),
      ...(isR59Gate1A && rawSc.sales_window === undefined ? { sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW } : {}),
      ...(isR59Gate1A && rawSc.storage_window === undefined ? { storage_window: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW } : {}),
      ...(isR59Gate1A && rawSc.inbound_window === undefined ? { inbound_window: FBA_2027_DEFAULT_INBOUND_WINDOW } : {}),
      ...(rawSc.profile_revision === undefined ? { profile_revision } : {}),
    };
    resolvedInputScenarios.push(sc);
    const sid = nonemptyStr(sc.id) ? sc.id.trim() : `scenario-${i + 1}`;
    if (seenIds.has(sid)) {
      throw new TypeError(`Duplicate Gate 1A scenario id: "${sid}".`);
    }
    seenIds.add(sid);
    const pricing = resolveEffectivePricing(sc);
    const price = pricing.valid ? pricing.net_effective_price_usd : null;
    const priceBelowFloor = finite(price) && price < minimum_price_usd;
    const scAsinUpper = nonemptyStr(sc.asin) ? sc.asin.trim().toUpperCase() : null;
    const promoPeer = scAsinUpper ? promoRowsByAsin.get(scAsinUpper) : null;
    const outOfBandPeer = scAsinUpper && (!mainstreamAsinsR59 || !mainstreamAsinsR59.has(scAsinUpper))
      ? outOfBandByAsinR59.get(scAsinUpper) ?? null
      : null;
    const matchedMainstreamPeerR59 = scAsinUpper && Array.isArray(resolvedPriceBand?.mainstream_pool)
      ? resolvedPriceBand.mainstream_pool.find(r => String(r?.asin || '').trim().toUpperCase() === scAsinUpper) ?? null
      : null;
    const mainstreamAsinPriceMismatchR59 = Boolean(
      isR59Gate1A &&
      matchedMainstreamPeerR59 &&
      finite(price) &&
      finite(matchedMainstreamPeerR59.net_price_usd) &&
      Math.abs(price - matchedMainstreamPeerR59.net_price_usd) > PARITY_TOLERANCE_USD,
    );
    const trueOutOfBandPeersR59 = isR59Gate1A
      ? outOfBandPeersR59.filter(o => !mainstreamAsinsR59 || !mainstreamAsinsR59.has(String(o?.asin || '').trim().toUpperCase()))
      : [];
    const matchesInBandMainstreamPriceR59 = Boolean(
      isR59Gate1A &&
      finite(price) &&
      (
        resolvedPriceBand?.mainstream_pool?.some(m =>
          (finite(m?.net_price_usd) && Math.abs(price - m.net_price_usd) <= PARITY_TOLERANCE_USD) ||
          (isAllUnder90dBlueOcean && finite(m?.list_price_usd) && Math.abs(price - m.list_price_usd) <= PARITY_TOLERANCE_USD),
        ) ||
        (finite(regularBand?.min_usd) && finite(regularBand?.max_usd) && price >= regularBand.min_usd - PARITY_TOLERANCE_USD && price <= regularBand.max_usd + PARITY_TOLERANCE_USD)
      ),
    );
    const matchesOnlyOutOfBandPrice = Boolean(
      isR59Gate1A &&
      !scAsinUpper &&
      finite(price) &&
      !matchesInBandMainstreamPriceR59 &&
      trueOutOfBandPeersR59.some(o =>
        (finite(o?.net_price_usd) && Math.abs(price - o.net_price_usd) <= PARITY_TOLERANCE_USD) ||
        (finite(o?.original_price_usd) && Math.abs(price - o.original_price_usd) <= PARITY_TOLERANCE_USD),
      ),
    );
    const outOfBandWatchReason = outOfBandPeer
      ? (PRICE_WATCH_REASONS.includes(outOfBandPeer.reason_code) ? outOfBandPeer.reason_code : 'out_of_primary_band_observation_only')
      : ((matchesOnlyOutOfBandPrice || mainstreamAsinPriceMismatchR59) ? 'out_of_primary_band_observation_only' : null);
    const scAgeDays = resolveAgeDays(sc, effectiveAsOfDate);
    const isYoungNewcomerScenario = isR59Gate1A
      ? ((scAgeDays !== null && scAgeDays <= spiralMaxAgeDays) ||
        Boolean(promoPeer?.age_days !== null && promoPeer?.age_days !== undefined && promoPeer.age_days <= spiralMaxAgeDays))
      : ((scAgeDays !== null && scAgeDays < spiralMaxAgeDays) ||
        Boolean(promoPeer?.age_days !== null && promoPeer?.age_days !== undefined && promoPeer.age_days < spiralMaxAgeDays));
    const scSeedMergedUnverified = Boolean(
      (sc.old_reviews_predate_launch === true || sc.seed_merged_reviews === true) &&
      sc.current_form_sustained_regular_price_verified !== true,
    );
    const peerWatchReason = Array.isArray(promoPeer?.watch_reasons) && finite(price) && finite(promoPeer.net_price_usd) &&
      Math.abs(price - promoPeer.net_price_usd) <= PARITY_TOLERANCE_USD
      ? promoPeer.watch_reasons.find(reason => PRICE_WATCH_REASONS.includes(reason) && !(isR59Gate1A && isAllUnder90dBlueOcean && reason === 'newcomer_le_90d_launch_ref'))
      : null;
    const isConfirmedMainstreamPeer = Boolean(
      scAsinUpper &&
      Array.isArray(resolvedPriceBand?.mainstream_pool) &&
      resolvedPriceBand.mainstream_pool.some(
        r => String(r?.asin || '').trim().toUpperCase() === scAsinUpper && r?.age_days !== null && r?.age_days !== undefined,
      ),
    );
    const strictAgeWatchReason = strictMatureMode
      ? (scSeedMergedUnverified
        ? 'seed_merged_unverified_regular_price'
        : (isYoungNewcomerScenario && !(isR59Gate1A && isAllUnder90dBlueOcean)
          ? 'young_newcomer_launch_band_only'
          : (hasAgeContextForScenarios && scAgeDays === null && !promoPeer && !isConfirmedMainstreamPeer ? 'unknown_age_excluded_from_mature_band' : null)))
      : (scSeedMergedUnverified ? 'seed_merged_unverified_regular_price' : null);
    const priceWatchReason = PRICE_WATCH_REASONS.find(reason => sc[reason] === true || sc.price_basis === reason) ??
      (resolveHolidayPromoReference(sc, price, effectiveBandOptions)
        ? HOLIDAY_PROMO_REASON
        : (peerWatchReason ?? outOfBandWatchReason ?? strictAgeWatchReason));

    const costInputs = disallow_pre1688_cost_guess_kill
      ? { ...sc, margin_floor: 0.30, min_landed_domestic_usd: null, domestic_freight_usd: null }
      : sc;
    const est = estimateGate1A2027(costInputs);
    const cliff = !priceWatchReason && finite(price) && price > 50.00 && price <= 51.50
      ? evaluatePriceCliff2027(costInputs, { landed_domestic_usd: costInputs.min_landed_domestic_usd ?? null })
      : null;

    scenarioResults.push({
      id: sid,
      price_usd: price ?? null,
      fx_cny_per_usd: est.fx_cny_per_usd ?? (finite(sc.fx_cny_per_usd) ? sc.fx_cny_per_usd : null),
      headhaul_usd: resolveScreenHeadhaulUsd(sc) ?? est.components?.headhaul?.amount_usd ?? null,
      sales_window: sc.sales_window ?? est.sales_window ?? null,
      storage_window: sc.storage_window ?? est.storage_window ?? null,
      operating_period_id: sc.operating_period_id ?? null,
      price_below_floor: priceBelowFloor,
      ...(peerPackageCalibration?.sample_warning_tag ? { sample_warning_tag: peerPackageCalibration.sample_warning_tag } : {}),
      ...(isYoungNewcomerScenario ? { is_young_newcomer: true } : {}),
      ...(priceWatchReason ? { price_basis: priceWatchReason, [priceWatchReason]: true } : {}),
      estimate: est,
      price_cliff_50: cliff,
    });
  }

  if (effectiveRights === true) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      gate0,
      reason: 'Proven specific design rights conflict (specific_rights_conflict === true).',
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', {
      gate1a_result: payload,
      landed_domestic_cap_cny: null,
      negotiation_shortlist: null,
      packaging_redesign_shortlist: null,
    });
    return payload;
  }

  const regularScenarios = scenarioResults.filter(s => !PRICE_WATCH_REASONS.includes(s.price_basis));
  const eligiblePriceScenarios = regularScenarios.filter(s => finite(s.price_usd) && !s.price_below_floor);
  const onlyYoungNewcomersObserved = resolvedPriceBand?.all_young_niche === true ||
    (regularScenarios.length > 0 && regularScenarios.every(s => s.is_young_newcomer === true));
  const allPricesBelowFloor = !onlyYoungNewcomersObserved &&
    regularScenarios.length > 0 &&
    regularScenarios.every(s => s.price_below_floor) &&
    !(finite(regularBand?.max_usd) && regularBand.max_usd >= minimum_price_usd);
  if (allPricesBelowFloor && !allow_forward_price_discovery) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      gate0,
      reason_code: 'all_regular_scenario_prices_below_floor',
      reason: `All feasible scenario net prices are below USD ${minimum_price_usd}.`,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', {
      gate1a_result: payload,
      landed_domestic_cap_cny: null,
      negotiation_shortlist: null,
      packaging_redesign_shortlist: null,
    });
    return payload;
  }

  if (strong_date_dependency === true) {
    const payload = {
      ...baseMeta,
      gate_status: 'deferred',
      gate0,
      reason: 'Strong holiday/date dependency (deferred, not excluded).',
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'deferred', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  // Require Stage-2 visual cluster tightening whenever a Stage-1 mainstream band triggers a width alarm
  // OR lacks sufficient mainstream peer breadth (low_peer_count)!
  const hasValidTightenedClusters = Boolean(
    resolvedClusterBands?.all_clusters_tightened === true &&
    Array.isArray(resolvedClusterBands?.clusters) &&
    resolvedClusterBands.clusters.length > 0,
  );
  const priceDiscoveryOnly = allow_forward_price_discovery && (
    eligiblePriceScenarios.length === 0 || resolvedPriceBand?.guardrail?.low_peer_count === true
  );
  if (resolvedPriceBand?.guardrail) {
    baseMeta.price_band_guardrail = resolvedPriceBand.guardrail;
  }
  if (!isR59Gate1A && resolvedPriceBand?.guardrail?.low_peer_count === true && !priceDiscoveryOnly) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_needs_verification',
      gate0,
      price_band_guardrail: resolvedPriceBand.guardrail,
      cluster_bands: resolvedClusterBands,
      reason: 'Stage-1 mainstream price band has insufficient peer breadth (<2 mainstream listings after denoising); collect additional comparable peers before Gate 1B.',
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_needs_verification', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }
  if (!isR59Gate1A && resolvedPriceBand?.guardrail?.width_alarm === true && !hasValidTightenedClusters && !priceDiscoveryOnly) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_needs_verification',
      gate0,
      price_band_guardrail: resolvedPriceBand.guardrail,
      cluster_bands: resolvedClusterBands,
      reason: 'Stage-1 mainstream price band triggered width alarm; Stage-2 visual clustering and tightened sub-cluster bands are required before Gate 1B.',
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_needs_verification', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  const unverified = regularScenarios.filter(s => !s.price_below_floor && s.estimate.status !== 'verified');
  if (!priceDiscoveryOnly && (unverified.length > 0 || eligiblePriceScenarios.length === 0)) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_needs_verification',
      gate0,
      reason: eligiblePriceScenarios.length === 0
        ? 'A regular matched-spec price at or above the screening floor has not been established.'
        : `Calculator verification needed on ${unverified.length} scenario(s); cannot zero-browser reject on missing fee cells.`,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_needs_verification', { gate1a_result: payload, landed_domestic_cap_cny: null });
    return payload;
  }

  const verifiedPriceScenarios = eligiblePriceScenarios.filter(s => s.estimate.status === 'verified');
  const bestCapCny = !priceDiscoveryOnly && verifiedPriceScenarios.length > 0
    ? Math.max(...verifiedPriceScenarios.map(s => s.estimate.landed_domestic_cap_cny))
    : null;
  const allNonDomesticCostsOverCeiling = eligiblePriceScenarios.every(
    s => s.estimate.non_domestic_cost_exceeds_70pct_at_zero_goods === true,
  );
  const allZeroBrowserRejected = !priceDiscoveryOnly && (disallow_pre1688_cost_guess_kill
    ? allNonDomesticCostsOverCeiling
    : eligiblePriceScenarios.every(s => s.estimate.zero_browser_fail === true));

  if (allZeroBrowserRejected) {
    const payload = {
      ...baseMeta,
      gate_status: 'gate1a_rejected',
      gate0,
      reason_code: allNonDomesticCostsOverCeiling
        ? 'non_domestic_cost_exceeds_70pct_at_zero_goods'
        : 'domestic_cost_estimate_exceeds_landed_cap',
      reason: 'All evidenced feasible scenarios fail 30% pre-ad margin ceiling even before 1688 browsing (zero-browser elimination).',
      best_landed_domestic_cap_cny: bestCapCny,
      proceed_to_gate1b: false,
      proceed_to_gate2_3: false,
      scenarios: scenarioResults,
    };
    store.updateFormLifecycle(form_id, 'gate1a_rejected', { gate1a_result: payload, landed_domestic_cap_cny: bestCapCny });
    return payload;
  }

  const declaredScenarios = (priceDiscoveryOnly ? [] : eligiblePriceScenarios).map(s => ({
    id: s.id,
    operating_period_id: s.operating_period_id ?? null,
    price_usd: s.price_usd,
    fx_cny_per_usd: s.fx_cny_per_usd,
    headhaul_usd: s.headhaul_usd,
    fulfillment_usd: s.estimate?.components?.fulfillment?.total_usd ?? null,
    ...(s.estimate?.components?.fulfillment?.packaging_service_status === 'charged_non_sipp' ||
      s.estimate?.components?.fulfillment?.packaging_service_status === 'default_non_sipp_merged'
      ? {
        ...(s.estimate.components.fulfillment.packaging_service_status === 'charged_non_sipp' ? { requires_amazon_packaging: true } : {}),
        packaging_service_fee_usd: s.estimate.components.fulfillment.packaging_service_fee_usd,
      }
      : (s.estimate?.components?.fulfillment?.packaging_service_status === 'own_compliant_box_exempt'
        ? { requires_amazon_packaging: false, packaging_service_fee_usd: 0 }
        : {})),
    placement_range_usd: s.estimate?.components?.placement?.range_usd ?? (
      finite(s.estimate?.components?.placement?.selected_usd)
        ? [s.estimate.components.placement.selected_usd, s.estimate.components.placement.selected_usd]
        : null
    ),
    storage_per_unit_usd: s.estimate?.components?.storage?.per_unit_usd ?? null,
    price_band: s.estimate?.price_band ?? null,
    ...(finite(s.estimate?.coupon_fee_usd) && s.estimate.coupon_fee_usd > 0 ? {
      coupon_fee_usd: s.estimate.coupon_fee_usd,
      list_price_usd: s.estimate.list_price_usd ?? null,
      ongoing_discount_usd: s.estimate.ongoing_discount_usd ?? null,
    } : {}),
    sales_window: s.sales_window,
    storage_window: s.storage_window,
  }));
  const declaredIds = new Set(declaredScenarios.map(s => s.id));
  const forwardPricingScenarios = scenarioResults.flatMap((result, idx) => {
    if (!priceDiscoveryOnly && !declaredIds.has(result.id)) return [];
    return [{
      id: result.id,
      operating_period_id: result.operating_period_id,
      fee_inputs: projectForwardPricingInputs(resolvedInputScenarios[idx]),
    }];
  });

  const nextStatus = form.lifecycle_status === 'evaluated' ? 'evaluated' : 'gate1b_queued';
  const payload = {
    ...baseMeta,
    gate_status: 'gate1a_passed',
    gate0,
    ...(resolvedPriceBand ? { price_band_guardrail: resolvedPriceBand.guardrail } : {}),
    ...(resolvedClusterBands ? { cluster_bands: resolvedClusterBands } : {}),
    reason: priceDiscoveryOnly
      ? 'Gate 1B may verify sourcing costs for forward pricing. A regular matched-spec price is still required for margin qualification.'
      : 'At least one verified 2027 feasible scenario stays within the pre-1688 non-domestic cost ceiling.',
    best_landed_domestic_cap_cny: bestCapCny,
    forward_price_discovery_only: priceDiscoveryOnly,
    forward_pricing_scenarios: forwardPricingScenarios,
    declared_scenarios: declaredScenarios,
    declared_feasible_prices_usd: [...new Set(declaredScenarios.filter(s => finite(s.price_usd)).map(s => s.price_usd))],
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
  existing_quotes = null,
  supplier_nominal_pkg = null,
  profile_revision = 59,
  require_ui_readback = undefined,
  as_of_date = new Date().toISOString().slice(0, 10),
  lease_owner = 'gate1b',
  allow_crossing_to_gate2_3 = false,
  on_lease_acquired_hook = null,
} = {}) {
  const form = store.getCandidateForm(form_id);
  if (!form) throw new TypeError(`Unknown form_id for Gate 1B: ${form_id}`);
  const isR59 = (profile_revision ?? 59) >= 59;
  if (isR59 && require_ui_readback === false) {
    throw new TypeError('Cannot disable require_ui_readback under Revision 59.');
  }

  // Enforce prior Gate 1A clearance and zero proven rights conflicts on the current spec_sha256.
  const gate1aRecord = form.gate1a_result_json ? JSON.parse(form.gate1a_result_json) : null;
  const hasValidGate1A = gate1aRecord &&
    gate1aRecord.spec_sha256 === form.spec_sha256 &&
    gate1aRecord.proceed_to_gate1b === true &&
    !hasProvenRightsConflictOnCurrentSpec(form);

  const canRetrySecondFactoryR59 = isR59 &&
    form.lifecycle_status === 'gate1b_rejected' &&
    (typeof sourcing_executor === 'function' || existing_quote !== null || (Array.isArray(existing_quotes) && existing_quotes.length > 0)) &&
    (() => {
      try {
        const prev = form.gate1b_result_json ? JSON.parse(form.gate1b_result_json) : null;
        return Boolean(prev && prev.second_factory_quote_needed === true && prev.specific_rights_conflict_proven !== true);
      } catch {
        return false;
      }
    })();

  if ((!ALLOWED_GATE1B_ENTRY_STATUSES.has(form.lifecycle_status) && !canRetrySecondFactoryR59) || !hasValidGate1A) {
    return {
      form_id,
      status: 'blocked_by_gate1a',
      lifecycle_status: form.lifecycle_status,
      reason: hasProvenRightsConflictOnCurrentSpec(form)
        ? 'Form has a proven specific design rights conflict on its current specification.'
        : 'Form has not passed Gate 1A on its current specification.',
      proceed_to_gate2_3: false,
    };
  }

  const expectedSpecVersion = form.spec_version;
  // NEVER trust an unpersisted caller-supplied quote object; ALWAYS re-load by quote_id from the owning store!
  const persistedQuotes = [];
  const suppliedList = Array.isArray(existing_quotes) && existing_quotes.length > 0
    ? existing_quotes
    : (existing_quote && typeof existing_quote === 'object' ? [existing_quote] : []);
  for (const candQ of suppliedList) {
    if (!candQ || typeof candQ !== 'object') continue;
    const stored = nonemptyStr(candQ.quote_id) ? store.getQuoteById(candQ.quote_id) : null;
    if (stored && isQuoteUsableForForm(stored, form, as_of_date)) {
      if (!persistedQuotes.some(q => q.quote_id === stored.quote_id)) {
        persistedQuotes.push(stored);
      }
    } else if (suppliedList.length === 1 && typeof sourcing_executor !== 'function') {
      const g1bRes = {
        status: 'gate1b_pending',
        reason: stored
          ? `Persisted quote (${stored.quote_id}) is not usable for form ${form_id} on current spec v${expectedSpecVersion}.`
          : 'Supplied existing_quote is not persisted in the owning store.',
      };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, proceed_to_gate2_3: false };
    }
  }
  // Under r59 (or whenever multiple verified quotes exist on the current spec_version),
  // NEVER allow callers to cherry-pick only the winning quote while ignoring other persisted usable quotes!
  // However, if `sourcing_executor` is supplied without explicit `suppliedList`, let `sourcing_executor` record
  // the new factory quote first before reloading active non-superseded quotes!
  let prevG1bOnCurrentSpec = null;
  if (form.gate1b_result_json) {
    try {
      const parsedPrev = JSON.parse(form.gate1b_result_json);
      if (!parsedPrev?.spec_sha256 || parsedPrev.spec_sha256 === form.spec_sha256) {
        prevG1bOnCurrentSpec = parsedPrev;
      }
    } catch { /* ignore */ }
  }
  const allUsableStoreQuotes = store.getQuotesForForm(form_id).filter(q => isQuoteUsableForForm(q, form, as_of_date));
  const shouldReuseWithoutNewSourcing = isR59 && allUsableStoreQuotes.length > 0 && (
    persistedQuotes.length > 0 ||
    typeof sourcing_executor !== 'function' ||
    prevG1bOnCurrentSpec?.second_factory_quote_needed === false
  );
  if (shouldReuseWithoutNewSourcing) {
    for (const sq of allUsableStoreQuotes) {
      if (!persistedQuotes.some(q => q.quote_id === sq.quote_id)) {
        persistedQuotes.push(sq);
      }
    }
  }
  let persistedQuote = persistedQuotes[0] ?? null;
  let orderPlan = persistedQuote ? deriveOrderPlanFromPersistedQuote(persistedQuote) : null;
  const staleGate1AScenarios = (current = store.getCandidateForm(form_id)) => {
    const specChanged = current?.spec_version !== expectedSpecVersion;
    if (!specChanged && current.gate1a_result_json === form.gate1a_result_json) return null;
    return {
      form_id,
      status: specChanged ? 'stale_spec_version_conflict' : 'stale_gate1a_scenarios',
      reason: specChanged ? 'Form specification changed during Gate 1B evaluation.' : 'Gate 1A scenarios changed during Gate 1B evaluation.',
      quote: persistedQuote,
      order_plan: orderPlan,
      proceed_to_gate2_3: false,
    };
  };

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
      if (typeof on_lease_acquired_hook === 'function') {
        const hookRes = await on_lease_acquired_hook({ form });
        if (hookRes && typeof hookRes === 'object' && hookRes.blocked === true) {
          return {
            form_id,
            status: hookRes.status ?? 'aborted_before_sourcing',
            reason: sanitizeDiagnosticText(hookRes.reason || 'Gate 1B pre-sourcing hook blocked dispatch.'),
            proceed_to_gate2_3: false,
          };
        }
      }
      // P0-29: Re-verify authoritative live form state immediately BEFORE calling sourcing_executor!
      const liveBeforeSourcing = store.getCandidateForm(form_id);
      if (!liveBeforeSourcing || liveBeforeSourcing.spec_version !== expectedSpecVersion) {
        return {
          form_id,
          status: 'stale_spec_version_conflict',
          reason: `Form ${form_id} spec changed concurrently before 1688 sourcing dispatch.`,
          proceed_to_gate2_3: false,
        };
      }
      const termBeforeSourcing = hasTerminalRejectionOrDeferralOnCurrentSpec(liveBeforeSourcing);
      if (termBeforeSourcing.blocked && !(canRetrySecondFactoryR59 && termBeforeSourcing.status === 'gate1b_rejected' && !termBeforeSourcing.preserve_rights_conflict)) {
        return {
          form_id,
          status: termBeforeSourcing.status,
          reason: sanitizeDiagnosticText(termBeforeSourcing.reason),
          proceed_to_gate2_3: false,
        };
      }
      const staleBeforeSourcing = staleGate1AScenarios(liveBeforeSourcing);
      if (staleBeforeSourcing) return staleBeforeSourcing;
      sourcingOutcome = await sourcing_executor({
        form: liveBeforeSourcing,
        landed_domestic_cap_cny: liveBeforeSourcing.landed_domestic_cap_cny,
        landed_domestic_cap_advisory_only: true,
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
      const termNow = hasTerminalRejectionOrDeferralOnCurrentSpec(latestNow);
      if (latestNow && !termNow.blocked && latestNow.lifecycle_status !== 'evaluated') {
        store.updateFormLifecycle(form_id, 'gate1b_queued');
      }
      return {
        form_id,
        status: 'captcha_paused',
        queue_status: 'CAPTCHA_PAUSED',
        pause_reason: pauseReason,
        paused_form_id: form_id,
        proceed_to_gate2_3: false,
      };
    }

    // Re-check spec_version, proven rights conflicts, and concurrent Gate 1A rejection/deferral after async sourcing!
    const latestAfterSource = store.getCandidateForm(form_id);
    if (!latestAfterSource || latestAfterSource.spec_version !== expectedSpecVersion) {
      return {
        form_id,
        status: 'stale_spec_version_conflict',
        reason: `Form spec changed from v${expectedSpecVersion} to v${latestAfterSource?.spec_version} during Gate 1B sourcing.`,
        proceed_to_gate2_3: false,
      };
    }
    const terminalAfterSource = hasTerminalRejectionOrDeferralOnCurrentSpec(latestAfterSource);
    if (terminalAfterSource.blocked && !(canRetrySecondFactoryR59 && terminalAfterSource.status === 'gate1b_rejected' && !terminalAfterSource.preserve_rights_conflict)) {
      if (terminalAfterSource.preserve_rights_conflict) {
        const g1bRes = {
          status: 'gate1b_rejected',
          spec_sha256: latestAfterSource.spec_sha256,
          specific_rights_conflict_proven: true,
          reason: 'Proven specific design rights conflict recorded during or prior to Gate 1B sourcing.',
        };
        store.updateFormLifecycle(form_id, 'gate1b_rejected', { gate1b_result: g1bRes, negotiation_shortlist: null });
        return {
          form_id,
          status: 'gate1b_rejected',
          negotiation_shortlist: null,
          proceed_to_gate2_3: false,
        };
      }
      return {
        form_id,
        status: terminalAfterSource.status,
        reason: terminalAfterSource.reason,
        proceed_to_gate2_3: false,
      };
    }

    if (sourcingOutcome.status !== 'quoted') {
      const staleAfterSourcing = staleGate1AScenarios(latestAfterSource);
      if (staleAfterSourcing) return staleAfterSourcing;
    }
    if (sourcingOutcome.status === 'no_public_mold_private_only') {
      const g1bRes = {
        status: 'private_mold_reserved',
        spec_sha256: latestAfterSource.spec_sha256,
        sourcing_disposition: 'private_mold_reserved',
        reason: sanitizeDiagnosticText(sourcingOutcome.reason || 'High-potential form has no open 1688 public mold; archived in private_mold_reserved pool.'),
      };
      store.updateFormLifecycle(form_id, 'private_mold_reserved', {
        gate1b_result: g1bRes,
        negotiation_shortlist: null,
        sourcing_disposition: 'private_mold_reserved',
      });
      return { form_id, ...g1bRes, proceed_to_gate2_3: false };
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

    const incomingQuotes = Array.isArray(sourcingOutcome.quotes) && sourcingOutcome.quotes.length > 0
      ? sourcingOutcome.quotes
      : [sourcingOutcome.quote];
    const recordedBatch = store.recordSourcingQuotesBatch1688(
      incomingQuotes.map(qObj => {
        if (isR59 && qObj?.require_ui_readback === false) {
          throw new TypeError('Revision 59 prohibits disabling require_ui_readback on verified 1688 quotes.');
        }
        return {
          ...qObj,
          ...(isR59 ? { require_ui_readback: true } : {}),
          form_id,
          spec_version: expectedSpecVersion,
        };
      }),
    );
    // H2: Reload each recorded quote from SQLite AFTER the batch completes so any same-spec quote
    // archived as `superseded_uncompetitive` by a cheaper later quote in the same batch is NOT evaluated!
    for (const rec of recordedBatch) {
      const freshQuote = store.getQuoteById(rec.quote.quote_id) ?? rec.quote;
      if (isQuoteUsableForForm(freshQuote, latestAfterSource, as_of_date)) {
        persistedQuotes.push(freshQuote);
      }
      if (!persistedQuote) {
        persistedQuote = freshQuote;
        orderPlan = rec.order_plan;
      }
    }
    const staleAfterQuote = staleGate1AScenarios();
    if (staleAfterQuote) return staleAfterQuote;

    if (persistedQuotes.length === 0) {
      const g1bRes = {
        status: 'gate1b_pending',
        reason: `Persisted quote (${persistedQuote?.quote_status ?? 'none'}) is not a valid active verified quote for current spec v${expectedSpecVersion}.`,
        quote_id: persistedQuote?.quote_id ?? null,
      };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, proceed_to_gate2_3: false };
    }
    persistedQuote = persistedQuotes[0];
    orderPlan = deriveOrderPlanFromPersistedQuote(persistedQuote);
  }

  const staleBeforePricing = staleGate1AScenarios();
  if (staleBeforePricing) return staleBeforePricing;
  if (isR59) {
    const latestFormForQuotes = store.getCandidateForm(form_id);
    const allCurrentUsableQuotes = store.getQuotesForForm(form_id).filter(
      q => isQuoteUsableForForm(q, latestFormForQuotes, as_of_date),
    );
    for (const sq of allCurrentUsableQuotes) {
      if (!persistedQuotes.some(q => q.quote_id === sq.quote_id)) {
        persistedQuotes.push(sq);
      }
    }
  }
  const quotesToEvaluate = persistedQuotes.length > 0 ? persistedQuotes : [persistedQuote];
  if (isR59 && quotesToEvaluate.some(q => q.ui_readback_verified !== true)) {
    const missingUiQids = quotesToEvaluate.filter(q => q.ui_readback_verified !== true).map(q => q.quote_id);
    const g1bRes = {
      status: 'gate1b_pending',
      quote_id: persistedQuote.quote_id,
      ...(quotesToEvaluate.length > 1 ? { quote_ids: quotesToEvaluate.map(q => q.quote_id) } : {}),
      reason: `Revision 59 requires verified 1688 ui_readback (logged_in, >=1440px viewport, visible SKU row & settlement bar, confirmed applied quantity) on quote(s) [${missingUiQids.join(', ')}].`,
    };
    store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes, negotiation_shortlist: null });
    return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, early_screen: null, proceed_to_gate2_3: false };
  }
  const quotePricing = {
    quote_id: persistedQuote.quote_id,
    ...(quotesToEvaluate.length > 1 ? { quote_ids: quotesToEvaluate.map(q => q.quote_id) } : {}),
    forward_pricing: computeGate1BForwardPricing(gate1aRecord, persistedQuote),
    ...(quotesToEvaluate.length > 1 ? {
      forward_pricing_by_quote: quotesToEvaluate.map(q => computeGate1BForwardPricing(gate1aRecord, q)),
    } : {}),
  };
  const allQuoteBasisIssues = (quotePricing.forward_pricing_by_quote ?? [quotePricing.forward_pricing])
    .flatMap(fp => fp.quote_basis_issues ?? []);
  if (allQuoteBasisIssues.length > 0) {
    const g1bRes = {
      status: 'gate1b_pending',
      ...quotePricing,
      reason: allQuoteBasisIssues.map(({ id, reason }) => `Scenario "${id}": ${reason}`).join(' '),
    };
    store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes, negotiation_shortlist: null });
    return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, early_screen: null, proceed_to_gate2_3: false };
  }
  if (gate1aRecord.forward_price_discovery_only === true || typeof early_screen_builder !== 'function') {
    const g1bRes = {
      status: 'gate1b_pending',
      ...quotePricing,
      reason: gate1aRecord.forward_price_discovery_only === true
        ? 'A regular matched-spec selling price and a Gate 1A rerun are required for margin qualification.'
        : 'early_screen_builder is required to verify 30% pre-ad margin from the persisted 1688 quote.',
    };
    store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
    return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, early_screen: null, proceed_to_gate2_3: false };
  }

  const evaluations = [];
  const rawScenarios = [];
  const matchedDeclList = [];
  const scenarioQuoteIds = [];
  const missingDeclaredIdsSet = new Set();
  const passingQuoteIds = [];
  const failingQuoteIds = [];
  const effectiveRevForEval = Math.max(58, Number.isInteger(profile_revision) ? profile_revision : 59);

  for (const activeQuote of quotesToEvaluate) {
    const activePlan = deriveOrderPlanFromPersistedQuote(activeQuote);
    const builtRaw = early_screen_builder({
      form: { ...form },
      quote: structuredClone(activeQuote),
      order_plan: structuredClone(activePlan),
    });
    const latestAfterBuilder = store.getCandidateForm(form_id);
    const staleAfterBuilder = staleGate1AScenarios(latestAfterBuilder);
    if (staleAfterBuilder) return staleAfterBuilder;
    const terminalAfterBuilder = hasTerminalRejectionOrDeferralOnCurrentSpec(latestAfterBuilder);
    if (terminalAfterBuilder.blocked && !(canRetrySecondFactoryR59 && terminalAfterBuilder.status === 'gate1b_rejected' && !terminalAfterBuilder.preserve_rights_conflict)) {
      return {
        form_id,
        status: terminalAfterBuilder.status,
        reason: terminalAfterBuilder.reason,
        proceed_to_gate2_3: false,
      };
    }
    const qRawScenarios = Array.isArray(builtRaw) ? builtRaw : [builtRaw];
    if (qRawScenarios.length === 0) {
      throw new TypeError('early_screen_builder must return a scenario object or a nonempty array of scenario objects.');
    }

    // Bind Gate 1B scenarios strictly to Gate 1A declared scenario IDs, payable prices, FX, headhaul, and FBA fee tiers (<= $0.005).
    const qBinding = bindGate1BScenariosToGate1A(qRawScenarios, gate1aRecord);
    if (!qBinding.valid) {
      const g1bRes = {
        status: 'gate1b_pending',
        ...quotePricing,
        reason: `Gate 1B scenario binding / FBA tier parity check failed: ${qBinding.issues.join(' ')}`,
        fba_parity_issues: qBinding.issues,
      };
      store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
      return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, proceed_to_gate2_3: false };
    }

    const qQuoteBindings = qRawScenarios.map(raw => bindSourcingQuotePricingInputs(activeQuote, raw));
    const qQuoteIssues = qQuoteBindings.flatMap((b, i) => b.issue ? [`Gate 1B quote "${activeQuote.quote_id}" scenario #${i + 1}: ${b.issue}`] : []);
    if (qQuoteIssues.length > 0) {
      const g1bRes = { status: 'gate1b_pending', ...quotePricing, reason: qQuoteIssues.join(' ') };
      store.updateFormLifecycle(form_id, 'gate1b_pending', {
        gate1b_result: g1bRes,
        negotiation_shortlist: null,
        packaging_redesign_shortlist: null,
      });
      return { form_id, ...g1bRes, quote: persistedQuote, order_plan: orderPlan, early_screen: null, proceed_to_gate2_3: false };
    }

    for (const md of qBinding.missingDeclared) missingDeclaredIdsSet.add(`${md.id}@$${md.price_usd}`);
    const qEvaluations = qRawScenarios.map((raw, i) => {
      const authoritativeInput = applyAuthoritativeQuoteToScreenInput(raw, activeQuote, activePlan, qQuoteBindings[i], effectiveRevForEval);
      return evaluateEarlyScreen(authoritativeInput, { profileRevision: effectiveRevForEval });
    });
    if (qEvaluations.some(e => e.gate_status === 'pass' || e.gate_status === 'economic_pass_rights_unsearched')) {
      passingQuoteIds.push(activeQuote.quote_id);
    } else if (qEvaluations.every(e => e.gate_status === 'fail')) {
      failingQuoteIds.push(activeQuote.quote_id);
    }
    for (let i = 0; i < qEvaluations.length; i++) {
      evaluations.push(qEvaluations[i]);
      rawScenarios.push(qRawScenarios[i]);
      matchedDeclList.push(qBinding.matches[i]);
      scenarioQuoteIds.push(activeQuote.quote_id);
    }
  }
  const binding = {
    matches: matchedDeclList,
    missingDeclared: [...missingDeclaredIdsSet].map(tok => {
      const [id, p] = tok.split('@$');
      return { id, price_usd: Number(p) };
    }),
  };

  const anyRightsHardFail = evaluations.some(e => e.checks?.specific_form_rights === 'fail');
  const allSuppliedFail = evaluations.every(e => e.gate_status === 'fail');
  const allSuppliedPass = evaluations.every(e => e.gate_status === 'pass' || e.gate_status === 'economic_pass_rights_unsearched');
  const anyPass = evaluations.some(e => e.gate_status === 'pass' || e.gate_status === 'economic_pass_rights_unsearched');
  const anyFail = evaluations.some(e => e.gate_status === 'fail');
  const anyDeferred = evaluations.some(e => e.gate_status === 'deferred' || e.gate_status === 'defer');

  const missingDeclared = binding.missingDeclared;
  const evaluatedScenarioSummary = evaluations.map((ev, idx) => ({
    id: quotesToEvaluate.length > 1
      ? `${matchedDeclList[idx]?.id ?? rawScenarios[idx]?.id ?? `scenario-${idx + 1}`}:${scenarioQuoteIds[idx]}`
      : (matchedDeclList[idx]?.id ?? rawScenarios[idx]?.id ?? `scenario-${idx + 1}`),
    declared_scenario_id: matchedDeclList[idx]?.id ?? null,
    quote_id: scenarioQuoteIds[idx],
    price_usd: resolveScenarioEffectivePrice(rawScenarios[idx]),
    margin: finite(ev.ledger?.margin) ? ev.ledger.margin : null,
    gate_status: ev.gate_status,
  }));

  if (!anyRightsHardFail && allSuppliedFail && missingDeclared.length > 0) {
    const g1bRes = {
      status: 'gate1b_pending',
      ...quotePricing,
      reason: `Cannot reject form while Gate 1A declared scenario(s) (${missingDeclared.map(d => `${d.id}@$${d.price_usd}`).join(', ')}) were omitted from Gate 1B.`,
      scenarios_checked: evaluations.length,
      evaluated_scenarios: evaluatedScenarioSummary,
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

  const evaluatedFinitePrices = evaluatedScenarioSummary.map(s => s.price_usd).filter(finite);
  const minEvaluatedPrice = evaluatedFinitePrices.length > 0 ? Math.min(...evaluatedFinitePrices) : null;
  const maxEvaluatedPrice = evaluatedFinitePrices.length > 0 ? Math.max(...evaluatedFinitePrices) : null;
  const interiorCliffProbePrices = !anyRightsHardFail && !anyDeferred && minEvaluatedPrice !== null && maxEvaluatedPrice !== null
    ? [...new Set([
        ...[9.99, 10.00, 49.99, 50.00, 50.01].filter(
          c => c > minEvaluatedPrice + 1e-9 && c < maxEvaluatedPrice - 1e-9,
        ),
        ...(quotePricing.forward_pricing_by_quote ?? [quotePricing.forward_pricing])
          .flatMap(fp => {
            const srVerified = !fp?.quote_basis_issues?.length && Array.isArray(fp?.scenario_results)
              ? fp.scenario_results.filter(sr => sr?.status === 'verified' && finite(sr.feasible_min_price_usd))
              : [];
            const candidates = [
              fp?.status === 'verified' ? fp.feasible_min_price_usd : null,
              ...srVerified.map(sr => sr.feasible_min_price_usd),
            ];
            if (
              minEvaluatedPrice <= 50.00 + 1e-9 &&
              maxEvaluatedPrice >= 50.00 - 1e-9 &&
              candidates.some(p => finite(p) && p <= 50.00 + 1e-9)
            ) {
              candidates.push(50.00);
            }
            return candidates;
          })
          .filter(p => finite(p) && p >= minEvaluatedPrice - 1e-9 && p <= maxEvaluatedPrice + 1e-9),
      ])]
    : [];

  const interiorPassPrices = [];
  const interiorFailPrices = [];
  const interiorMargins = [];
  if (interiorCliffProbePrices.length > 0 && rawScenarios.length > 0 && maxEvaluatedPrice > minEvaluatedPrice + 1e-9) {
    const fwdById = new Map(
      (gate1aRecord?.forward_pricing_scenarios ?? [])
        .filter(s => nonemptyStr(s?.id))
        .map(s => [s.id.trim(), s.fee_inputs ?? null]),
    );
    for (let idx = 0; idx < rawScenarios.length; idx++) {
      const baseRaw = rawScenarios[idx];
      const matchedDecl = matchedDeclList[idx] ?? null;
      const declFeeInputs = matchedDecl?.id ? (fwdById.get(matchedDecl.id) ?? null) : null;
      for (const pCliff of interiorCliffProbePrices) {
        for (const activeQ of quotesToEvaluate) {
          const activeP = deriveOrderPlanFromPersistedQuote(activeQ);
          const qBind = bindSourcingQuotePricingInputs(activeQ, baseRaw);
          if (qBind.issue) continue;
          const effAllowBulky = baseRaw.allow_bulky_2027 ?? declFeeInputs?.allow_bulky_2027;
          const effSipp = baseRaw.is_sipp ?? activeQ.pkg?.is_sipp ?? baseRaw.pkg?.is_sipp ?? declFeeInputs?.is_sipp;
          const effRequiresPackaging = activeQ.requires_amazon_packaging !== undefined
            ? activeQ.requires_amazon_packaging
            : (activeQ.pkg?.requires_amazon_packaging !== undefined
              ? activeQ.pkg.requires_amazon_packaging
              : (baseRaw.requires_amazon_packaging !== undefined
                ? baseRaw.requires_amazon_packaging
                : (baseRaw.pkg?.requires_amazon_packaging !== undefined
                  ? baseRaw.pkg.requires_amazon_packaging
                  : (declFeeInputs?.requires_amazon_packaging !== undefined
                    ? declFeeInputs.requires_amazon_packaging
                    : (declFeeInputs?.pkg?.requires_amazon_packaging !== undefined
                      ? declFeeInputs.pkg.requires_amazon_packaging
                      : matchedDecl?.requires_amazon_packaging)))));
          const cliffFul = effAllowBulky === false
            ? lookupFulfillmentFee2027({
              pkg: activeQ.pkg ?? baseRaw.pkg,
              price_usd: pCliff,
              sales_window: baseRaw.fee_context?.sales ?? baseRaw.sales_window,
              is_apparel: baseRaw.is_apparel_or_shoes,
              is_dangerous_goods: baseRaw.is_dangerous_goods,
              is_sipp: effSipp,
            })
            : lookupBulkyFulfillmentFee2027({
              pkg: activeQ.pkg ?? baseRaw.pkg,
              price_usd: pCliff,
              sales_window: baseRaw.fee_context?.sales ?? baseRaw.sales_window,
              is_apparel: baseRaw.is_apparel_or_shoes,
              is_dangerous_goods: baseRaw.is_dangerous_goods,
              is_sipp: effSipp,
              requires_amazon_packaging: effRequiresPackaging,
            });
          if (cliffFul.status !== 'verified') continue;
          const cliffEvalRev = Math.max(58, Number.isInteger(profile_revision) ? profile_revision : 59);
          const hasBaseCouponUsd = finite(baseRaw.ongoing_coupon_usd) && baseRaw.ongoing_coupon_usd > 0;
          const hasBaseCouponPct = finite(baseRaw.ongoing_coupon_pct) && baseRaw.ongoing_coupon_pct > 0 && baseRaw.ongoing_coupon_pct < 1;
          const cliffListPrice = hasBaseCouponUsd
            ? Number((pCliff + baseRaw.ongoing_coupon_usd).toFixed(2))
            : (hasBaseCouponPct ? Number((pCliff / (1 - baseRaw.ongoing_coupon_pct)).toFixed(2)) : undefined);
          const cliffFulForEval = (cliffEvalRev >= 59 && cliffListPrice !== undefined)
            ? (effAllowBulky === false
              ? lookupFulfillmentFee2027({
                pkg: activeQ.pkg ?? baseRaw.pkg,
                price_usd: cliffListPrice,
                sales_window: baseRaw.fee_context?.sales ?? baseRaw.sales_window,
                is_apparel: baseRaw.is_apparel_or_shoes,
                is_dangerous_goods: baseRaw.is_dangerous_goods,
                is_sipp: effSipp,
              })
              : lookupBulkyFulfillmentFee2027({
                pkg: activeQ.pkg ?? baseRaw.pkg,
                price_usd: cliffListPrice,
                sales_window: baseRaw.fee_context?.sales ?? baseRaw.sales_window,
                is_apparel: baseRaw.is_apparel_or_shoes,
                is_dangerous_goods: baseRaw.is_dangerous_goods,
                is_sipp: effSipp,
                requires_amazon_packaging: effRequiresPackaging,
              }))
            : cliffFul;
          if (cliffFulForEval.status !== 'verified') continue;
          const cliffInput = applyAuthoritativeQuoteToScreenInput({
            ...structuredClone(baseRaw),
            price_usd: pCliff,
            list_price_usd: cliffListPrice,
            net_effective_price_usd: cliffListPrice !== undefined ? pCliff : undefined,
            ongoing_coupon_pct: hasBaseCouponPct ? baseRaw.ongoing_coupon_pct : undefined,
            ongoing_coupon_usd: hasBaseCouponUsd ? baseRaw.ongoing_coupon_usd : undefined,
            promo_basis_already_net: cliffListPrice !== undefined ? true : undefined,
            fulfillment_usd: cliffFulForEval.total_usd,
          }, activeQ, activeP, qBind, cliffEvalRev);
          const cliffEv = evaluateEarlyScreen(cliffInput, { profileRevision: cliffEvalRev });
          if (finite(cliffEv.ledger?.margin)) interiorMargins.push(cliffEv.ledger.margin);
          if (cliffEv.gate_status === 'pass' || cliffEv.gate_status === 'economic_pass_rights_unsearched') {
            if (!interiorPassPrices.includes(pCliff)) interiorPassPrices.push(pCliff);
          } else if (cliffEv.gate_status === 'fail') {
            if (!interiorFailPrices.includes(pCliff)) interiorFailPrices.push(pCliff);
          }
        }
      }
    }
  }
  const hasInteriorCliffCrossing = (allSuppliedFail && interiorPassPrices.length > 0) ||
    (allSuppliedPass && interiorFailPrices.length > 0);

  const effectiveSupplierNominalPkg = supplier_nominal_pkg ?? persistedQuote?.supplier_nominal_pkg ?? null;
  let sampleWarningTag = gate1aRecord?.sample_warning_tag ?? null;
  if (!sampleWarningTag && gate1aRecord?.peer_package_calibration?.median_pkg && effectiveSupplierNominalPkg) {
    try {
      const recalib = computeMatchedPeerMedianPackage([gate1aRecord.peer_package_calibration.median_pkg], {
        supplier_nominal_pkg: effectiveSupplierNominalPkg,
      });
      sampleWarningTag = recalib.sample_warning_tag;
    } catch { /* ignore */ }
  }

  if (anyRightsHardFail || (allSuppliedFail && interiorPassPrices.length === 0)) {
    let bestNegotiation = null;
    let bestPackagingRedesign = null;
    let maxTargetGoodsCnyFor30Pct = null;
    if (!anyRightsHardFail) {
      for (let i = 0; i < evaluations.length; i++) {
        const ev = evaluations[i];
        if (ev.checks?.specific_form_rights === 'fail' || ev.checks?.reference_price === 'fail') continue;
        const led = ev.ledger;
        const met = ev.metrics;
        const fallbackFx = finite(rawScenarios[i]?.fx_cny_per_usd)
          ? rawScenarios[i].fx_cny_per_usd
          : (finite(quotePricing?.fx_cny_per_usd) ? quotePricing.fx_cny_per_usd : persistedQuote?.fx_cny_per_usd);
        if (led && finite(led.landed_domestic_cap_at_30pct_cny)) {
          const domCny = finite(met?.domestic_freight_usd) && finite(fallbackFx) && fallbackFx > 0
            ? met.domestic_freight_usd * fallbackFx
            : 0;
          const candTargetGoodsCny = Math.max(0, Number((led.landed_domestic_cap_at_30pct_cny - domCny).toFixed(2)));
          if (maxTargetGoodsCnyFor30Pct === null || candTargetGoodsCny > maxTargetGoodsCnyFor30Pct) {
            maxTargetGoodsCnyFor30Pct = candTargetGoodsCny;
          }
        }
        if (effectiveRevForEval < 59) {
          let candNeg = ev.negotiation_shortlist ?? null;
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

        let candPkgRescue = ev.packaging_redesign_shortlist ?? null;
        if (!candPkgRescue && rawScenarios[i]?.pkg && met && finite(met.procurement_usd) && finite(met.domestic_freight_usd) &&
          finite(met.headhaul_usd) && finite(fallbackFx) && fallbackFx > 0 && finite(rawScenarios[i].refund_fraction)) {
          candPkgRescue = computePackagingRedesignShortlist2027({
            pkg: rawScenarios[i].pkg,
            price_usd: met.price_usd,
            list_price_usd: rawScenarios[i].list_price_usd,
            net_effective_price_usd: rawScenarios[i].net_effective_price_usd,
            ongoing_coupon_usd: rawScenarios[i].ongoing_coupon_usd,
            ongoing_coupon_pct: rawScenarios[i].ongoing_coupon_pct,
            prime_exclusive_discount_usd: rawScenarios[i].prime_exclusive_discount_usd,
            prime_exclusive_discount_pct: rawScenarios[i].prime_exclusive_discount_pct,
            promo_basis_already_net: rawScenarios[i].promo_basis_already_net,
            other_applicable_usd: rawScenarios[i].other_applicable_usd,
            other_payee: rawScenarios[i].other_payee,
            fx_cny_per_usd: fallbackFx,
            landed_domestic_usd: met.procurement_usd + met.domestic_freight_usd,
            refund_fraction: rawScenarios[i].refund_fraction,
            physical_return_fraction: rawScenarios[i].physical_return_fraction ?? null,
            fee_category: rawScenarios[i].fee_category ?? null,
            return_threshold: rawScenarios[i].return_threshold ?? null,
            referral_terms: rawScenarios[i].referral_terms,
            headhaul_usd: met.headhaul_usd,
            collection_rate: rawScenarios[i].collection_rate,
            sales_window: rawScenarios[i].fee_context?.sales ?? rawScenarios[i].sales_window ?? FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
            storage_window: rawScenarios[i].fee_context?.storage ?? rawScenarios[i].storage_window ?? FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
            inbound_window: rawScenarios[i].fee_context?.inbound ?? rawScenarios[i].inbound_window ?? FBA_2027_DEFAULT_INBOUND_WINDOW,
            is_apparel: rawScenarios[i].is_apparel,
            is_shoes: rawScenarios[i].is_shoes,
            is_apparel_or_shoes: rawScenarios[i].is_apparel_or_shoes,
            is_dangerous_goods: rawScenarios[i].is_dangerous_goods,
            is_sipp: rawScenarios[i].is_sipp,
            requires_amazon_packaging: rawScenarios[i].requires_amazon_packaging,
          });
        }
        if (candPkgRescue?.eligible === true) {
          if (!bestPackagingRedesign ||
            candPkgRescue.overshoot_mm < bestPackagingRedesign.overshoot_mm ||
            (candPkgRescue.overshoot_mm === bestPackagingRedesign.overshoot_mm &&
              candPkgRescue.redesigned_margin > bestPackagingRedesign.redesigned_margin)) {
            bestPackagingRedesign = {
              ...candPkgRescue,
              form_id,
              scenario_id: evaluatedScenarioSummary[i]?.id ?? null,
              quote_id: scenarioQuoteIds[i] ?? null,
              price_usd: evaluatedScenarioSummary[i]?.price_usd ?? null,
            };
          }
        }
      }
    }
    const resolveQuoteDistinctFactoryKey = q => {
      if (nonemptyStr(q?.factory_id)) return `fac:${q.factory_id.trim()}`;
      let lines = Array.isArray(q?.sku_lines) ? q.sku_lines : null;
      if (!lines && nonemptyStr(q?.sku_lines_json)) {
        try {
          const parsed = JSON.parse(q.sku_lines_json);
          if (Array.isArray(parsed)) lines = parsed;
        } catch { /* ignore */ }
      }
      const offerIds = Array.isArray(lines)
        ? [...new Set(lines.map(l => (nonemptyStr(l?.offer_id) ? l.offer_id.trim() : null)).filter(Boolean))].sort()
        : [];
      if (offerIds.length > 0) return `off:${offerIds.join('+')}`;
      return `qid:${q?.quote_id ?? 'unknown'}`;
    };
    const countDistinctCheckedFactories = () => {
      const rows = store.getQuotesForForm(form_id).filter(
        q => q.spec_version === expectedSpecVersion &&
          q.goods_first_order_promotion === 0 &&
          q.freight_first_order_promotion === 0 &&
          (q.quote_status === 'verified' || q.quote_status === 'superseded_uncompetitive'),
      );
      return new Set(rows.map(resolveQuoteDistinctFactoryKey)).size;
    };
    const checkedFactoryQuotesCount = effectiveRevForEval >= 59
      ? countDistinctCheckedFactories()
      : quotesToEvaluate.length;
    const g1bRes = {
      status: 'gate1b_rejected',
      margin_interval_verdict: anyRightsHardFail ? 'rights_conflict' : 'all_below_30pct',
      spec_sha256: form.spec_sha256,
      specific_rights_conflict_proven: anyRightsHardFail,
      ...(sampleWarningTag ? { sample_warning_tag: sampleWarningTag } : {}),
      ...quotePricing,
      scenarios_checked: evaluations.length,
      evaluated_scenarios: evaluatedScenarioSummary,
      ...(effectiveRevForEval >= 59 ? { checked_factory_quotes_count: checkedFactoryQuotesCount } : {}),
      ...(effectiveRevForEval >= 59 && maxTargetGoodsCnyFor30Pct !== null ? { target_goods_cny_for_30pct: maxTargetGoodsCnyFor30Pct } : {}),
      ...(effectiveRevForEval >= 59 && !anyRightsHardFail ? { second_factory_quote_needed: checkedFactoryQuotesCount < 3 } : {}),
      ...(bestPackagingRedesign ? { packaging_redesign_shortlist: bestPackagingRedesign } : {}),
      reasons: evaluations.flatMap(e => e.reasons || []).map(sanitizeDiagnosticText),
    };
    store.updateFormLifecycle(form_id, 'gate1b_rejected', {
      gate1b_result: g1bRes,
      negotiation_shortlist: bestNegotiation,
      packaging_redesign_shortlist: bestPackagingRedesign,
    });
    return {
      form_id,
      status: 'gate1b_rejected',
      margin_interval_verdict: g1bRes.margin_interval_verdict,
      ...(effectiveRevForEval >= 59 ? { checked_factory_quotes_count: checkedFactoryQuotesCount } : {}),
      ...(effectiveRevForEval >= 59 && maxTargetGoodsCnyFor30Pct !== null ? { target_goods_cny_for_30pct: maxTargetGoodsCnyFor30Pct } : {}),
      ...(effectiveRevForEval >= 59 && !anyRightsHardFail ? { second_factory_quote_needed: checkedFactoryQuotesCount < 3 } : {}),
      ...(sampleWarningTag ? { sample_warning_tag: sampleWarningTag } : {}),
      ...quotePricing,
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      negotiation_shortlist: bestNegotiation,
      packaging_redesign_shortlist: bestPackagingRedesign,
      proceed_to_gate2_3: false,
    };
  }

  if (anyDeferred) {
    const g1bRes = {
      status: 'deferred',
      spec_sha256: form.spec_sha256,
      ...quotePricing,
      scenarios_checked: evaluations.length,
      evaluated_scenarios: evaluatedScenarioSummary,
      reasons: evaluations.flatMap(e => e.reasons || []),
    };
    store.updateFormLifecycle(form_id, 'deferred', { gate1b_result: g1bRes });
    return {
      form_id,
      status: 'deferred',
      ...quotePricing,
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      proceed_to_gate2_3: false,
    };
  }

  if (allSuppliedPass && interiorFailPrices.length === 0 && missingDeclared.length === 0) {
    const latest = store.getCandidateForm(form_id);
    if (!latest || latest.spec_version !== expectedSpecVersion) {
      return {
        form_id,
        status: 'stale_spec_version_conflict',
        proceed_to_gate2_3: false,
      };
    }
    const terminalNow = hasTerminalRejectionOrDeferralOnCurrentSpec(latest);
    if (terminalNow.blocked && !(canRetrySecondFactoryR59 && terminalNow.status === 'gate1b_rejected' && !terminalNow.preserve_rights_conflict)) {
      if (terminalNow.preserve_rights_conflict) {
        const g1bRes = {
          status: 'gate1b_rejected',
          spec_sha256: latest.spec_sha256,
          specific_rights_conflict_proven: true,
          quote_id: persistedQuote.quote_id,
          reason: 'Proven specific design rights conflict recorded on current specification.',
        };
        store.updateFormLifecycle(form_id, 'gate1b_rejected', { gate1b_result: g1bRes, negotiation_shortlist: null });
        return {
          form_id,
          status: 'gate1b_rejected',
          negotiation_shortlist: null,
          proceed_to_gate2_3: false,
        };
      }
      return {
        form_id,
        status: terminalNow.status,
        reason: terminalNow.reason,
        proceed_to_gate2_3: false,
      };
    }
    const secondFactoryQuoteNeeded = false;
    const nextStatus = latest.lifecycle_status === 'evaluated' ? 'evaluated' : 'gate1b_passed';
    const g1bRes = {
      status: 'gate1b_passed',
      margin_interval_verdict: 'all_ge_30pct',
      ...(effectiveRevForEval >= 59 ? { second_factory_quote_needed: secondFactoryQuoteNeeded } : {}),
      spec_sha256: latest.spec_sha256,
      ...(sampleWarningTag ? { sample_warning_tag: sampleWarningTag } : {}),
      ...quotePricing,
      spec_version: expectedSpecVersion,
      scenarios_checked: evaluations.length,
      declared_scenario_ids: binding.matches.filter(Boolean).map(d => d.id),
      evaluated_scenarios: evaluatedScenarioSummary,
    };
    store.updateFormLifecycle(form_id, nextStatus, {
      gate1b_result: g1bRes,
      negotiation_shortlist: null,
      packaging_redesign_shortlist: null,
    });
    return {
      form_id,
      status: 'gate1b_passed',
      margin_interval_verdict: 'all_ge_30pct',
      ...(effectiveRevForEval >= 59 ? { second_factory_quote_needed: secondFactoryQuoteNeeded } : {}),
      ...(sampleWarningTag ? { sample_warning_tag: sampleWarningTag } : {}),
      ...quotePricing,
      quote: persistedQuote,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      proceed_to_gate2_3: true,
    };
  }

  // Distinguish 30%-crossing intervals (some scenarios >=30%, some <30%, or interior $50.00/$50.01 cliff crossing) from all-pass and all-fail.
  if (((anyPass || interiorPassPrices.length > 0) && (anyFail || interiorFailPrices.length > 0)) || hasInteriorCliffCrossing) {
    const passingPrices = [...interiorPassPrices];
    const failingPrices = [...interiorFailPrices];
    const margins = [...interiorMargins];
    for (let i = 0; i < evaluations.length; i++) {
      const ev = evaluations[i];
      const p = resolveScenarioEffectivePrice(rawScenarios[i]);
      if (finite(ev.ledger?.margin)) margins.push(ev.ledger.margin);
      if (ev.gate_status === 'pass' || ev.gate_status === 'economic_pass_rights_unsearched') {
        if (finite(p) && !passingPrices.includes(p)) passingPrices.push(p);
      } else if (ev.gate_status === 'fail') {
        if (finite(p) && !failingPrices.includes(p)) failingPrices.push(p);
      }
    }
    const marginRange = margins.length > 0 ? [Math.min(...margins), Math.max(...margins)] : null;
    const latest = store.getCandidateForm(form_id);
    if (!latest || latest.spec_version !== expectedSpecVersion) {
      return {
        form_id,
        status: 'stale_spec_version_conflict',
        proceed_to_gate2_3: false,
      };
    }
    const terminalNow = hasTerminalRejectionOrDeferralOnCurrentSpec(latest);
    if (terminalNow.blocked && !(canRetrySecondFactoryR59 && terminalNow.status === 'gate1b_rejected' && !terminalNow.preserve_rights_conflict)) {
      return {
        form_id,
        status: terminalNow.status,
        reason: terminalNow.reason,
        proceed_to_gate2_3: false,
      };
    }
    const canProceed = (allow_crossing_to_gate2_3 === true || isR59) && missingDeclared.length === 0 && (anyPass || interiorPassPrices.length > 0);
    const checkedFactoryQuotesCountCross = effectiveRevForEval >= 59
      ? (() => {
          const rows = store.getQuotesForForm(form_id).filter(
            q => q.spec_version === expectedSpecVersion &&
              q.goods_first_order_promotion === 0 &&
              q.freight_first_order_promotion === 0 &&
              (q.quote_status === 'verified' || q.quote_status === 'superseded_uncompetitive'),
          );
          return new Set(rows.map(q => {
            if (nonemptyStr(q?.factory_id)) return `fac:${q.factory_id.trim()}`;
            let lines = Array.isArray(q?.sku_lines) ? q.sku_lines : null;
            if (!lines && nonemptyStr(q?.sku_lines_json)) {
              try {
                const parsed = JSON.parse(q.sku_lines_json);
                if (Array.isArray(parsed)) lines = parsed;
              } catch { /* ignore */ }
            }
            const offerIds = Array.isArray(lines)
              ? [...new Set(lines.map(l => (nonemptyStr(l?.offer_id) ? l.offer_id.trim() : null)).filter(Boolean))].sort()
              : [];
            if (offerIds.length > 0) return `off:${offerIds.join('+')}`;
            return `qid:${q?.quote_id ?? 'unknown'}`;
          })).size;
        })()
      : quotesToEvaluate.length;
    const g1bRes = {
      status: 'gate1b_pending',
      margin_interval_verdict: 'crosses_30pct',
      spec_sha256: form.spec_sha256,
      ...(effectiveRevForEval >= 59 ? {
        checked_factory_quotes_count: checkedFactoryQuotesCountCross,
        second_factory_quote_needed: checkedFactoryQuotesCountCross < 3,
      } : {}),
      owner_review_required: !isR59 || hasInteriorCliffCrossing,
      owner_crossing_override: canProceed,
      ...quotePricing,
      spec_version: expectedSpecVersion,
      scenarios_checked: evaluations.length,
      declared_scenario_ids: [...new Set(binding.matches.filter(Boolean).map(d => d.id))],
      evaluated_scenarios: evaluatedScenarioSummary,
      passing_prices_usd: passingPrices,
      failing_prices_usd: failingPrices,
      ...(allSuppliedFail && interiorPassPrices.length > 0 ? { interior_cliff_feasible_prices_usd: interiorPassPrices } : {}),
      ...(allSuppliedPass && interiorFailPrices.length > 0 ? { interior_cliff_failing_prices_usd: interiorFailPrices } : {}),
      ...(quotesToEvaluate.length > 1 ? {
        passing_quote_ids: passingQuoteIds,
        failing_quote_ids: failingQuoteIds,
      } : {}),
      margin_range: marginRange,
      reason: allSuppliedFail && interiorPassPrices.length > 0
        ? `Forward solver found a >=30% feasible interior cliff price ($${interiorPassPrices.join(', $')}) inside the evaluated interval [$${minEvaluatedPrice}, $${maxEvaluatedPrice}]; add the interior cliff price scenario rather than rejecting as all_below_30pct.`
        : (allSuppliedPass && interiorFailPrices.length > 0
          ? `Interior FBA tier cliff ($${interiorFailPrices.join(', $')}) dips below 30% inside [$${minEvaluatedPrice}, $${maxEvaluatedPrice}]; treat as crosses_30pct rather than all_ge_30pct.`
          : (isR59
            ? 'Gate 1B scenarios cross the 30% pre-ad margin floor across verified quotes/prices; r59 auto-admits to Gate 2/3 to score [min_total, max_total] without inflating strict qualifying counts.'
            : 'Gate 1B margin interval crosses the 30% pre-ad margin floor across feasible scenarios; requires owner review or price-band tightening rather than collapsing to pass or reject.')),
    };
    store.updateFormLifecycle(form_id, 'gate1b_pending', {
      gate1b_result: g1bRes,
      negotiation_shortlist: null,
      packaging_redesign_shortlist: null,
    });
    return {
      form_id,
      status: 'gate1b_pending',
      margin_interval_verdict: 'crosses_30pct',
      ...(effectiveRevForEval >= 59 ? {
        checked_factory_quotes_count: checkedFactoryQuotesCountCross,
        second_factory_quote_needed: checkedFactoryQuotesCountCross < 3,
      } : {}),
      owner_review_required: g1bRes.owner_review_required,
      owner_crossing_override: canProceed,
      ...(sampleWarningTag ? { sample_warning_tag: sampleWarningTag } : {}),
      ...quotePricing,
      passing_prices_usd: passingPrices,
      failing_prices_usd: failingPrices,
      ...(allSuppliedFail && interiorPassPrices.length > 0 ? { interior_cliff_feasible_prices_usd: interiorPassPrices } : {}),
      ...(allSuppliedPass && interiorFailPrices.length > 0 ? { interior_cliff_failing_prices_usd: interiorFailPrices } : {}),
      ...(quotesToEvaluate.length > 1 ? {
        passing_quote_ids: passingQuoteIds,
        failing_quote_ids: failingQuoteIds,
      } : {}),
      margin_range: marginRange,
      reason: g1bRes.reason,
      quote: persistedQuote,
      quotes: quotesToEvaluate,
      order_plan: orderPlan,
      early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
      negotiation_shortlist: null,
      packaging_redesign_shortlist: null,
      proceed_to_gate2_3: canProceed,
    };
  }

  const g1bRes = {
    status: 'gate1b_pending',
    margin_interval_verdict: 'incomplete_pending',
    ...quotePricing,
    scenarios_checked: evaluations.length,
    evaluated_scenarios: evaluatedScenarioSummary,
    reasons: [
      ...(missingDeclared.length > 0
        ? [`Gate 1A declared scenario(s) (${missingDeclared.map(d => `${d.id}@$${d.price_usd}`).join(', ')}) were omitted from Gate 1B.`]
        : []),
      ...evaluations.flatMap(e => e.reasons || []),
    ],
  };
  store.updateFormLifecycle(form_id, 'gate1b_pending', { gate1b_result: g1bRes });
  return {
    form_id,
    status: 'gate1b_pending',
    margin_interval_verdict: 'incomplete_pending',
    ...quotePricing,
    quote: persistedQuote,
    order_plan: orderPlan,
    early_screen: evaluations.length === 1 ? evaluations[0] : evaluations,
    proceed_to_gate2_3: false,
  };
}

/**
 * Verify that structured SpecMatcher and PainPointAndRubricJudge outputs are substantively
 * consistent with the scored candidate rather than silently contradicting awarded scores.
 */
function verifyStructuredAgentJudgments(formId, rawInputCand, { specMatches = null, rubricJudgments = null }) {
  const issues = [];
  if (specMatches !== undefined && specMatches !== null) {
    for (const sm of Array.isArray(specMatches) ? specMatches : [specMatches]) {
      const validated = validateSpecMatcherOutput(sm);
      if (nonemptyStr(sm.form_id) && sm.form_id.trim() !== formId) {
        issues.push(`SpecMatcher form_id "${sm.form_id}" does not match target form "${formId}".`);
      }
      if (validated.verdict === 'mismatch') {
        issues.push(`SpecMatcher verdict is "mismatch" (${validated.reason}); candidate cannot be evaluated as matched.`);
      } else if (validated.verdict === 'unknown') {
        issues.push(`SpecMatcher verdict is "unknown" (${validated.reason}); specification match remains unresolved.`);
      }
      if (validated.comparable_for_q31 === false && nonemptyStr(sm.asin) && Array.isArray(rawInputCand?.newcomer_cohort?.members)) {
        const badMember = rawInputCand.newcomer_cohort.members.find(m => m?.asin === sm.asin && m?.status === 'qualified');
        if (badMember) {
          issues.push(`SpecMatcher marked ASIN "${sm.asin}" comparable_for_q31=false, conflicting with qualified newcomer_cohort member.`);
        }
      }
    }
  }

  if (rubricJudgments !== undefined && rubricJudgments !== null) {
    const judgments = rawInputCand?.judgments && typeof rawInputCand.judgments === 'object' ? rawInputCand.judgments : {};
    for (const rj of Array.isArray(rubricJudgments) ? rubricJudgments : [rubricJudgments]) {
      const validated = validatePainPointAndRubricJudgeOutput(rj);
      if (nonemptyStr(rj.form_id) && rj.form_id.trim() !== formId) {
        issues.push(`PainPointAndRubricJudge form_id "${rj.form_id}" does not match target form "${formId}".`);
      }
      const candItem = judgments[validated.item_id];
      const awardedAnchor = candItem && finite(candItem.anchor) ? candItem.anchor : null;
      if ((validated.status === 'not_supported' || validated.status === 'unknown') && awardedAnchor !== null && awardedAnchor > 0) {
        issues.push(
          `PainPointAndRubricJudge marked "${validated.item_id}" as "${validated.status}", conflicting with awarded anchor (${awardedAnchor}) on candidate "${formId}".`,
        );
      }
      if (validated.status === 'supported' && finite(rj.proposed_score) && awardedAnchor !== null && awardedAnchor > rj.proposed_score) {
        issues.push(
          `PainPointAndRubricJudge proposed_score (${rj.proposed_score}) for "${validated.item_id}" is below awarded anchor (${awardedAnchor}).`,
        );
      }
    }
  }
  return issues;
}

function isPrimaryLeadAdmissibleForForm(lead, form) {
  if (!lead || lead.link_role !== 'primary_discovery') return false;
  if (lead.disposition !== 'product' && lead.disposition !== 'context') return false;
  let meta = null;
  try { meta = lead.metadata_json ? JSON.parse(lead.metadata_json) : null; } catch { /* ignore */ }
  if (meta?.social_bridge_contract) {
    const check = isSocialBridgeAlignedWithForm(meta.social_bridge_contract, form, { linkNote: lead.link_note ?? lead.note ?? null });
    if (!check.aligned) return false;
  }
  return true;
}

function isPendingRecoveryOpenAiError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'ACCOUNT_FENCED_PENDING_RECOVERY') return false;
  if (err instanceof OpenAiAmbiguousOutcomeError) return true;
  return err.status === 'pending_recovery' || err.code === 'PENDING_RECOVERY';
}

function isAccountFencedPreDispatchError(err) {
  return Boolean(err && typeof err === 'object' && err.code === 'ACCOUNT_FENCED_PENDING_RECOVERY');
}

function assertStrictOptionalBoolean(value, label, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'boolean') {
    const err = new TypeError(`${label} must be a boolean (received ${typeof value}).`);
    err.code = 'INVALID_BOOLEAN_OPTION';
    err.not_dispatched = true;
    throw err;
  }
  return value;
}

/**
 * Optional Stage 1–2 `gpt-6-luna` `/v1/decisions` visual & Gate-0 peer triage helper.
 * Preserves deterministic `evaluateGate0CategoryBoundary` (`Product-P3`) and degrades
 * gracefully to `status: 'unavailable'` when `enabled === false`, offline, or given invalid optional inputs.
 */
export async function runOptionalStage12LunaTriage({
  candidates,
  targetSpec = null,
  contactSheetDataUrl = null,
  contactSheetDataUrls = null,
  imageDetail = 'high',
  prohibitedThreshold = 0.7,
  gate0Config = {},
  enabled = false,
  client = null,
  policy = {},
  decisionExecutor = null,
  beforeDispatchGuard = null,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new TypeError('runOptionalStage12LunaTriage requires a nonempty candidates array.');
  }
  const frozenCandidates = structuredClone(candidates);
  const frozenGate0Config = gate0Config && typeof gate0Config === 'object' ? structuredClone(gate0Config) : {};
  const deterministicGate0 = frozenCandidates.map((cand, idx) => ({
    candidate_id: String(cand?.candidate_id ?? cand?.asin ?? cand?.id ?? `cand_${idx + 1}`),
    gate0: evaluateGate0CategoryBoundary(cand ?? {}, frozenGate0Config),
  }));

  let isEnabled = false;
  try {
    isEnabled = assertStrictOptionalBoolean(enabled, 'enabled', false);
    if (typeof prohibitedThreshold !== 'number' || !Number.isFinite(prohibitedThreshold) || prohibitedThreshold <= 0 || prohibitedThreshold >= 1) {
      const err = new RangeError('prohibitedThreshold must be a finite number strictly between 0 and 1.');
      err.code = 'INVALID_PROHIBITED_THRESHOLD';
      err.not_dispatched = true;
      throw err;
    }
  } catch (optErr) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      error_code: optErr?.code ?? 'INVALID_OPTION',
      reason: sanitizeDiagnosticText(String(optErr?.message || optErr)),
      request_count: 0,
      completed_chunks: [],
      deterministic_gate0: deterministicGate0,
      triage: null,
    };
  }

  let requests;
  try {
    requests = buildStage1DecisionsRequests({
      candidates: frozenCandidates,
      targetSpec,
      contactSheetDataUrl,
      ...(contactSheetDataUrls ? { contactSheetDataUrls } : {}),
      imageDetail,
    });
  } catch (admErr) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      error_code: admErr?.code ?? 'ADMISSION_ERROR',
      reason: sanitizeDiagnosticText(String(admErr?.message || admErr)),
      request_count: 0,
      completed_chunks: [],
      deterministic_gate0: deterministicGate0,
      triage: null,
    };
  }

  if (isEnabled !== true) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      reason: 'Stage 1–2 Luna Decisions triage is disabled (enabled=false).',
      request_count: requests.length,
      completed_chunks: [],
      deterministic_gate0: deterministicGate0,
      triage: null,
    };
  }

  if (typeof decisionExecutor !== 'function' && (!client || typeof client.createDecision !== 'function')) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      reason: 'No OpenAiClient or decisionExecutor supplied for Stage 1–2 Luna Decisions triage.',
      request_count: requests.length,
      completed_chunks: [],
      deterministic_gate0: deterministicGate0,
      triage: null,
    };
  }

  const completedChunks = [];
  let activeChunkIdx = 0;
  let activeLogicalId = null;
  try {
    const responses = [];
    for (let i = 0; i < requests.length; i++) {
      activeChunkIdx = i;
      const baseId = policy?.logicalRequestId ? `${policy.logicalRequestId}-chunk-${i + 1}` : undefined;
      activeLogicalId = baseId ?? null;
      if (typeof beforeDispatchGuard === 'function') {
        const guardRes = await beforeDispatchGuard(i);
        if (guardRes && guardRes.allowed === false) {
          return {
            status: 'unavailable',
            execution_status: completedChunks.length > 0 ? 'partial_aborted_by_guard' : 'not_submitted',
            error_code: guardRes.status ?? 'DISPATCH_GUARD_BLOCKED',
            reason: sanitizeDiagnosticText(String(guardRes.reason || 'Live form guard blocked Stage 1–2 Luna dispatch.')),
            request_count: requests.length,
            completed_chunks: completedChunks,
            deterministic_gate0: deterministicGate0,
            triage: null,
          };
        }
      }
      const chunkPolicy = baseId ? { ...policy, logicalRequestId: baseId } : policy;
      const resp = typeof decisionExecutor === 'function'
        ? await decisionExecutor(requests[i], i)
        : await client.createDecision(requests[i], chunkPolicy);
      if (resp?.status === 'pending_recovery') {
        const currentChunk = {
          chunk_index: i,
          attempt_id: resp.attempt_id ?? null,
          logical_request_id: resp.logical_request_id ?? baseId ?? null,
          provider_response_id: resp.provider_response_id ?? resp.response_id ?? resp.id ?? null,
          content_status: resp.content_status ?? null,
        };
        return {
          status: 'pending_recovery',
          execution_status: 'pending_recovery',
          attempt_id: currentChunk.attempt_id,
          logical_request_id: currentChunk.logical_request_id,
          provider_response_id: currentChunk.provider_response_id,
          current_chunk: currentChunk,
          reason: sanitizeDiagnosticText('POST /v1/decisions response requires recovery/reconciliation.'),
          request_count: requests.length,
          completed_chunks: completedChunks,
          deterministic_gate0: deterministicGate0,
          triage: null,
        };
      }
      const chunkRec = {
        chunk_index: i,
        attempt_id: resp?.attempt_id ?? null,
        logical_request_id: resp?.logical_request_id ?? baseId ?? null,
        provider_response_id: resp?.provider_response_id ?? resp?.response_id ?? resp?.id ?? null,
        content_status: resp?.content_status ?? 'usable',
      };
      completedChunks.push(chunkRec);
      // P1-12: Reject invalid/incomplete responses immediately, while letting `refused` chunks pass into
      // `parseStage1DecisionsResponses` so safe per-candidate `'unknown'` / `'unclear_needs_zoom'` mappings are preserved!
      const isRefusalOnlyChunk = resp?.content_status === 'refused';
      if (
        resp &&
        !isRefusalOnlyChunk &&
        (resp.usable === false || (typeof resp.content_status === 'string' && resp.content_status !== 'usable'))
      ) {
        return {
          status: 'unavailable',
          execution_status: resp.status ?? 'completed',
          content_status: resp.content_status ?? 'invalid',
          attempt_id: resp.attempt_id ?? null,
          provider_response_id: chunkRec.provider_response_id,
          current_chunk: chunkRec,
          reason: sanitizeDiagnosticText(
            `POST /v1/decisions chunk ${i + 1} returned unusable content_status=${resp.content_status ?? 'invalid'}.`,
          ),
          request_count: requests.length,
          completed_chunks: completedChunks,
          deterministic_gate0: deterministicGate0,
          triage: null,
        };
      }
      responses.push(resp);
    }

    const triage = parseStage1DecisionsResponses(frozenCandidates, responses, {
      prohibitedThreshold,
      gate0Config: frozenGate0Config,
      requests,
      contactSheetDataUrl,
      ...(contactSheetDataUrls ? { contactSheetDataUrls } : {}),
    });
    const anyRefusedChunk = completedChunks.some(c => c.content_status === 'refused');
    if (triage?.all_refused === true || (anyRefusedChunk && triage?.summary?.refusal_count === frozenCandidates.length * 2)) {
      return {
        status: 'unavailable',
        execution_status: 'completed',
        content_status: 'refused',
        reason: 'All Stage 1–2 Luna Decisions questions were refused by the model.',
        request_count: requests.length,
        completed_chunks: completedChunks,
        deterministic_gate0: deterministicGate0,
        triage,
      };
    }
    return {
      status: 'ready',
      execution_status: 'completed',
      content_status: 'usable',
      reason: null,
      request_count: requests.length,
      completed_chunks: completedChunks,
      deterministic_gate0: deterministicGate0,
      triage,
    };
  } catch (err) {
    const currentChunk = {
      chunk_index: activeChunkIdx,
      attempt_id: err?.attempt_id ?? null,
      logical_request_id: err?.logical_request_id ?? activeLogicalId,
      provider_response_id: err?.provider_response_id ?? err?.response_id ?? null,
    };
    if (isAccountFencedPreDispatchError(err)) {
      return {
        status: 'unavailable',
        execution_status: completedChunks.length > 0 ? 'partial_completed' : 'not_submitted',
        error_code: err.code,
        blocking_attempt_id: err.blocking_attempt_id ?? err.attempt_id ?? null,
        current_chunk: currentChunk,
        reason: sanitizeDiagnosticText(String(err?.message || 'Account fenced by prior pending_recovery attempt.')),
        request_count: requests.length,
        completed_chunks: completedChunks,
        deterministic_gate0: deterministicGate0,
        triage: null,
      };
    }
    const pendingRec = isPendingRecoveryOpenAiError(err);
    return {
      status: pendingRec ? 'pending_recovery' : 'unavailable',
      execution_status: pendingRec
        ? 'pending_recovery'
        : (err?.not_dispatched ? (completedChunks.length > 0 ? 'partial_completed' : 'not_submitted') : 'failed_known'),
      error_code: err?.code ?? null,
      attempt_id: currentChunk.attempt_id,
      logical_request_id: currentChunk.logical_request_id,
      provider_response_id: currentChunk.provider_response_id,
      blocking_attempt_id: err?.blocking_attempt_id ?? null,
      current_chunk: currentChunk,
      reason: sanitizeDiagnosticText(String(err?.message || 'Stage 1–2 Luna triage unavailable.')),
      request_count: requests.length,
      completed_chunks: completedChunks,
      deterministic_gate0: deterministicGate0,
      triage: null,
    };
  }
}

function workflowProgressDiagnostic(source) {
  const error = source?.progress_error;
  if (error?.code !== 'BACKGROUND_PROGRESS_FILE_WRITE_FAILED') return {};
  const ioCode = typeof error.io_code === 'string' && /^[A-Z_]{2,40}$/.test(error.io_code) ? error.io_code : null;
  return { progress_error: { code: error.code, io_code: ioCode } };
}

/**
 * Optional `gpt-6.1-terra` (`effort: 'xhigh'`) `/v1/responses` structured workflow task runner.
 * Validates inputs & builds strict Structured Output wire payloads offline first; degrades
 * gracefully to `unavailable` or `pending_recovery` without paid auto-repair.
 */
export async function runOptionalTerraWorkflowTask(taskName, taskInput, {
  enabled = false,
  client = null,
  policy = {},
  responseExecutor = null,
  requestOptions = {},
} = {}) {
  let isEnabled = false;
  try {
    isEnabled = assertStrictOptionalBoolean(enabled, 'enabled', false);
  } catch (boolErr) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      task: taskName,
      error_code: boolErr?.code ?? 'INVALID_BOOLEAN_OPTION',
      request: null,
      result: null,
      reason: sanitizeDiagnosticText(String(boolErr?.message || boolErr)),
    };
  }

  let frozenTaskInput;
  let builtRequest;
  try {
    frozenTaskInput = freezeWorkflowTaskContext(taskName, taskInput);
    builtRequest = buildWorkflowTaskRequest(taskName, frozenTaskInput, requestOptions);
    if (taskName === 'rights-prescreen') {
      const background = policy?.background ?? requestOptions.background ?? true;
      builtRequest.background = assertStrictOptionalBoolean(background, 'background');
    }
  } catch (admErr) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      task: taskName,
      error_code: admErr?.code ?? 'ADMISSION_ERROR',
      request: null,
      result: null,
      reason: sanitizeDiagnosticText(String(admErr?.message || admErr)),
    };
  }

  if (isEnabled !== true) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      task: taskName,
      request: builtRequest,
      result: null,
      reason: `Terra "${taskName}" enhancement is disabled (enabled=false).`,
    };
  }

  if (typeof responseExecutor !== 'function' && (!client || typeof client.createResponse !== 'function')) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      task: taskName,
      request: builtRequest,
      result: null,
      reason: `No OpenAiClient or responseExecutor supplied for Terra "${taskName}".`,
    };
  }

  let resp;
  try {
    resp = typeof responseExecutor === 'function'
      ? await responseExecutor(builtRequest)
      : await client.createResponse(builtRequest, policy);
  } catch (err) {
    if (isAccountFencedPreDispatchError(err)) {
      return {
        status: 'unavailable',
        execution_status: 'not_submitted',
        content_status: null,
        task: taskName,
        error_code: err.code,
        blocking_attempt_id: err.blocking_attempt_id ?? err.attempt_id ?? null,
        ...workflowProgressDiagnostic(err),
        result: null,
        reason: sanitizeDiagnosticText(String(err?.message || `Account fenced prior to Terra "${taskName}" dispatch.`)),
      };
    }
    const pendingRec = isPendingRecoveryOpenAiError(err);
    return {
      status: pendingRec ? 'pending_recovery' : 'unavailable',
      execution_status: pendingRec ? 'pending_recovery' : (err?.status === 'rejected' ? 'rejected' : (err?.not_dispatched ? 'not_submitted' : 'failed_known')),
      content_status: null,
      task: taskName,
      error_code: err?.code ?? null,
      attempt_id: err?.attempt_id ?? null,
      blocking_attempt_id: err?.blocking_attempt_id ?? null,
      ...workflowProgressDiagnostic(err),
      result: null,
      reason: sanitizeDiagnosticText(String(err?.message || `Terra "${taskName}" call failed.`)),
    };
  }

  if (resp?.status === 'pending_recovery') {
    return {
      status: 'pending_recovery',
      execution_status: 'pending_recovery',
      content_status: resp.content_status ?? null,
      task: taskName,
      attempt_id: resp.attempt_id ?? null,
      ...workflowProgressDiagnostic(resp),
      result: null,
      reason: sanitizeDiagnosticText('OpenAI /v1/responses attempt is pending recovery.'),
    };
  }

  if (resp && (resp.usable === false || (typeof resp.content_status === 'string' && resp.content_status !== 'usable'))) {
    return {
      status: 'unavailable',
      execution_status: resp.status ?? 'completed',
      content_status: resp.content_status ?? 'invalid',
      task: taskName,
      attempt_id: resp.attempt_id ?? null,
      usage_cost_micros: resp.usage_cost_micros ?? null,
      ...workflowProgressDiagnostic(resp),
      result: null,
      reason: sanitizeDiagnosticText(
        resp.refusal || resp.incomplete_details?.reason || `OpenAI response unusable (content_status=${resp.content_status ?? 'invalid'}).`,
      ),
    };
  }

  try {
    const parsed = parseWorkflowTaskResult(taskName, resp, frozenTaskInput);
    return {
      status: 'ready',
      execution_status: 'completed',
      content_status: 'usable',
      task: taskName,
      attempt_id: resp?.attempt_id ?? null,
      usage_cost_micros: resp?.usage_cost_micros ?? null,
      ...workflowProgressDiagnostic(resp),
      result: parsed,
      reason: null,
    };
  } catch (parseErr) {
    return {
      status: 'unavailable',
      execution_status: resp?.status ?? 'completed',
      content_status: 'invalid',
      task: taskName,
      error_code: 'WORKFLOW_TASK_VALIDATION_FAILED',
      attempt_id: resp?.attempt_id ?? null,
      usage_cost_micros: resp?.usage_cost_micros ?? null,
      ...workflowProgressDiagnostic(resp),
      result: null,
      reason: sanitizeDiagnosticText(String(parseErr?.message || parseErr)),
    };
  }
}

export function runOptional1688VisionPrecheck(input, options = {}) {
  return runOptionalTerraWorkflowTask('1688-vision', input, options);
}

export function runOptionalReviewJudge(input, options = {}) {
  return runOptionalTerraWorkflowTask('review-judge', input, options);
}

export function runOptionalRightsPreScreen(input, options = {}) {
  return runOptionalTerraWorkflowTask('rights-prescreen', input, options);
}

export function runOptionalSocialBridge(input, options = {}) {
  return runOptionalTerraWorkflowTask('social-bridge', input, options);
}

export function runOptionalSpecMatcher(input, options = {}) {
  return runOptionalTerraWorkflowTask('spec-matcher', input, options);
}

/**
 * Optional Gate 4 closed-evidence hostile red-team review (`evidence-review-draft-v1`)
 * via subscription-backed local `Codex CLI` (`gpt-6.2-astra` `xhigh`/`max`) or injected executor.
 * Degrades gracefully to `unavailable` when disabled/offline without mutating 21-item scores.
 */
export async function runOptionalGate4EvidenceReview(packetInput, {
  enabled = false,
  dryRun = false,
  testMode = false,
  mockExecutor = undefined,
  receiptDir = undefined,
  candidateId = undefined,
  formSpecSha256 = undefined,
  model = 'gpt-6.2-astra',
  reasoningEffort = 'xhigh',
  serviceTier = null,
  imagePaths = [],
  timeoutMs = null,
  cwd = null,
  skipGitRepoCheck = false,
  codexBin = 'codex',
  env = process.env,
  spawnImpl = undefined,
  reviewExecutor = null,
  candidateQualification = null,
  forceNonQualifyingReview = false,
} = {}) {
  if (candidateQualification && typeof candidateQualification === 'object' &&
      candidateQualification.counts_toward_target !== true &&
      forceNonQualifyingReview !== true) {
    return {
      status: 'skipped_non_qualifying',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review: null,
      reason: 'Gate-4 red-team review runs only on genuinely qualifying cards (counts_toward_target === true).',
    };
  }
  if (!packetInput || typeof packetInput !== 'object' || Array.isArray(packetInput)) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review: null,
      reason: 'No valid evidence-review packet object supplied.',
    };
  }

  let isEnabled = false;
  let isDryRun = false;
  try {
    isEnabled = assertStrictOptionalBoolean(enabled, 'enabled', false);
    isDryRun = assertStrictOptionalBoolean(dryRun, 'dryRun', false);
  } catch (boolErr) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      error_code: boolErr?.code ?? 'INVALID_BOOLEAN_OPTION',
      review: null,
      reason: sanitizeDiagnosticText(String(boolErr?.message || boolErr)),
    };
  }

  let hasAuthorizedExecutionPolicy = false;
  try {
    assertAuthorizedReviewExecutionPolicy(packetInput);
    hasAuthorizedExecutionPolicy = true;
  } catch {
    hasAuthorizedExecutionPolicy = false;
  }

  const normalizedGate4Model = typeof model === 'string' ? model.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalizedGate4Model) || !['xhigh', 'max'].includes(reasoningEffort)) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      error_code: 'INVALID_GATE4_MODEL_OR_EFFORT',
      review: null,
      reason: 'Gate-4 evidence review requires a valid safe model identifier and reasoningEffort in ["xhigh", "max"].',
    };
  }

  let frozenPacket;
  try {
    frozenPacket = freezeEvidenceReviewPacket(packetInput);
  } catch (admErr) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      error_code: admErr?.code ?? 'ADMISSION_ERROR',
      review: null,
      reason: sanitizeDiagnosticText(String(admErr?.message || admErr)),
    };
  }

  if (isDryRun === true) {
    try {
      return await runCodexEvidenceReview(frozenPacket, {
        enabled: false,
        dryRun: true,
        model: normalizedGate4Model,
        reasoningEffort,
        serviceTier,
        imagePaths,
        cwd,
        skipGitRepoCheck,
      });
    } catch (dryErr) {
      return {
        status: 'unavailable',
        execution_status: 'not_submitted',
        content_status: null,
        advisory_only: true,
        schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
        review_id: frozenPacket.review_id,
        packet_sha256: frozenPacket.packet_sha256,
        review: null,
        reason: sanitizeDiagnosticText(String(dryErr?.message || dryErr)),
      };
    }
  }

  if (isEnabled !== true) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozenPacket.review_id,
      packet_sha256: frozenPacket.packet_sha256,
      review: null,
      reason: 'Gate-4 evidence review is disabled (enabled=false).',
    };
  }

  if (!hasAuthorizedExecutionPolicy) {
    return {
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozenPacket.review_id,
      packet_sha256: frozenPacket.packet_sha256,
      error_code: 'EXECUTION_POLICY_DISABLED',
      review: null,
      reason: 'Local execution_policy_ref is missing or disabled; live Gate-4 evidence review blocked.',
    };
  }

  if (typeof reviewExecutor === 'function') {
    const reviewerLabel = `Synthetic Executor · ${reasoningEffort}`;
    const tempStageDir = mkdtempSync(join(tmpdir(), 'p4-rev-exec-stage-'));
    let executorAttachmentShas = [];
    try {
      let stagedInfo;
      try {
        stagedInfo = stageAndHashReviewAttachments(imagePaths ?? [], {
          stageDir: tempStageDir,
          expectedSha256s: Array.isArray(frozenPacket.attachment_sha256s) ? frozenPacket.attachment_sha256s : undefined,
        });
        executorAttachmentShas = [...stagedInfo.attachmentSha256s];
      } catch (attErr) {
        return {
          status: 'unavailable',
          execution_status: 'not_submitted',
          content_status: null,
          advisory_only: true,
          schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
          review_id: frozenPacket.review_id,
          packet_sha256: frozenPacket.packet_sha256,
          error_code: 'ATTACHMENT_VALIDATION_FAILED',
          review: null,
          reason: sanitizeDiagnosticText(String(attErr?.message || attErr)),
        };
      }

      try {
        const rawOut = await reviewExecutor(frozenPacket, {
          staged_image_paths: [...stagedInfo.stagedPaths],
          attachment_sha256s: executorAttachmentShas,
          attachments: stagedInfo.attachments,
        });
        if (rawOut && typeof rawOut === 'object' && !Array.isArray(rawOut)) {
          if (rawOut.status === 'pending_recovery' || rawOut.execution_status === 'pending_recovery') {
            return {
              status: 'pending_recovery',
              execution_status: 'pending_recovery',
              content_status: null,
              advisory_only: true,
              execution_provenance: 'injected_executor',
              schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
              review_id: frozenPacket.review_id,
              packet_sha256: frozenPacket.packet_sha256,
              attachment_sha256s: executorAttachmentShas,
              reviewer_label: reviewerLabel,
              reasoning_effort: reasoningEffort,
              review: null,
              reason: sanitizeDiagnosticText(rawOut.reason || 'Evidence review is pending recovery.'),
            };
          }
          if (rawOut.status === 'unavailable' && !rawOut.review) {
            return {
              status: 'unavailable',
              execution_status: rawOut.execution_status ?? 'not_submitted',
              content_status: rawOut.content_status ?? null,
              advisory_only: true,
              execution_provenance: 'injected_executor',
              schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
              review_id: frozenPacket.review_id,
              packet_sha256: frozenPacket.packet_sha256,
              attachment_sha256s: executorAttachmentShas,
              reviewer_label: reviewerLabel,
              reasoning_effort: reasoningEffort,
              review: null,
              reason: sanitizeDiagnosticText(rawOut.reason || 'Evidence review unavailable.'),
            };
          }
        }
        const candidateReview = rawOut?.review ?? rawOut;
        const validated = validateEvidenceReviewOutput(frozenPacket, candidateReview);
        return {
          status: 'ready',
          execution_status: 'completed',
          content_status: 'usable',
          advisory_only: true,
          validated_envelope: false,
          execution_provenance: 'injected_executor',
          schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
          review_id: frozenPacket.review_id,
          packet_sha256: frozenPacket.packet_sha256,
          attachment_sha256s: executorAttachmentShas,
          reviewer_label: reviewerLabel,
          reasoning_effort: reasoningEffort,
          disposition_counts: validated.disposition_counts,
          review: validated.review,
          subjects: validated.subjects,
          answers: validated.answers,
          contradictions: validated.contradictions,
          gaps: validated.gaps,
          conclusion: validated.conclusion,
          reason: null,
        };
      } catch (err) {
        const pendingRec = isPendingRecoveryOpenAiError(err) || Boolean(err?.timedOut);
        return {
          status: pendingRec ? 'pending_recovery' : 'unavailable',
          execution_status: pendingRec ? 'pending_recovery' : 'completed',
          content_status: pendingRec ? null : 'invalid',
          advisory_only: true,
          execution_provenance: 'injected_executor',
          schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
          review_id: frozenPacket.review_id,
          packet_sha256: frozenPacket.packet_sha256,
          attachment_sha256s: executorAttachmentShas,
          reviewer_label: reviewerLabel,
          reasoning_effort: reasoningEffort,
          review: null,
          reason: sanitizeDiagnosticText(String(err?.message || err)),
        };
      }
    } finally {
      rmSync(tempStageDir, { recursive: true, force: true });
    }
  }

  try {
    return await runCodexEvidenceReview(packetInput, {
      enabled: true,
      testMode,
      ...(mockExecutor !== undefined ? { mockExecutor } : {}),
      ...(receiptDir !== undefined ? { receiptDir } : {}),
      ...(candidateId !== undefined ? { candidateId } : {}),
      ...(formSpecSha256 !== undefined ? { formSpecSha256 } : {}),
      model: normalizedGate4Model,
      reasoningEffort,
      serviceTier,
      imagePaths,
      timeoutMs,
      cwd,
      skipGitRepoCheck,
      codexBin,
      env,
      ...(spawnImpl ? { spawnImpl } : {}),
    });
  } catch (err) {
    const pendingRec = isPendingRecoveryOpenAiError(err) || Boolean(err?.timedOut);
    return {
      status: pendingRec ? 'pending_recovery' : 'unavailable',
      execution_status: pendingRec ? 'pending_recovery' : 'not_submitted',
      content_status: null,
      advisory_only: true,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozenPacket.review_id,
      packet_sha256: frozenPacket.packet_sha256,
      review: null,
      reason: sanitizeDiagnosticText(String(err?.message || err)),
    };
  }
}

function scrubSafeAdvisoryProse(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const cleaned = sanitizeDiagnosticText(value.trim()).slice(0, 512);
  if (!cleaned || containsSecretToken(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function projectSafeAdvisoryMarker(rawEnv, { expectedCandId = null, expectedSpecSha = null } = {}) {
  const rawStatus = typeof rawEnv?.status === 'string' ? rawEnv.status.trim().toLowerCase() : '';
  const safeStatus = ['pending_recovery', 'in_progress', 'recovering', 'unknown'].includes(rawStatus)
    ? 'pending_recovery'
    : 'unavailable';
  const rawExec = typeof rawEnv?.execution_status === 'string' ? rawEnv.execution_status.trim().toLowerCase() : '';
  const safeExec = ['not_submitted', 'pending_recovery', 'completed', 'failed_known', 'rejected'].includes(rawExec)
    ? rawExec
    : (safeStatus === 'pending_recovery' ? 'pending_recovery' : 'not_submitted');
  const rawRevId = typeof rawEnv?.review_id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(rawEnv.review_id.trim()) &&
    !containsSecretToken(rawEnv.review_id) &&
    detectRawPii(rawEnv.review_id) === null
    ? rawEnv.review_id.trim()
    : undefined;
  const rawPktSha = typeof rawEnv?.packet_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rawEnv.packet_sha256.trim())
    ? rawEnv.packet_sha256.trim()
    : undefined;
  const rawRecSha = typeof rawEnv?.receipt_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rawEnv.receipt_sha256.trim())
    ? rawEnv.receipt_sha256.trim()
    : undefined;
  const effortStr = typeof rawEnv?.reasoning_effort === 'string' && ['xhigh', 'max'].includes(rawEnv.reasoning_effort.trim())
    ? rawEnv.reasoning_effort.trim()
    : undefined;
  const provStr = typeof rawEnv?.execution_provenance === 'string' && ['live_subscription_codex', 'synthetic_test_double', 'injected_executor'].includes(rawEnv.execution_provenance.trim())
    ? rawEnv.execution_provenance.trim()
    : undefined;

  return {
    status: safeStatus,
    execution_status: safeExec,
    content_status: null,
    advisory_only: true,
    validated_envelope: false,
    schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
    ...(rawRevId ? { review_id: rawRevId } : {}),
    ...(rawPktSha ? { packet_sha256: rawPktSha } : {}),
    ...(rawRecSha ? { receipt_sha256: rawRecSha, private_receipt_ref: `codex-receipt:${rawRecSha}` } : {}),
    ...(provStr ? { execution_provenance: provStr } : {}),
    ...(effortStr ? { reasoning_effort: effortStr } : {}),
    ...(expectedCandId ? { candidate_id: expectedCandId } : {}),
    ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
    review: null,
    reason: scrubSafeAdvisoryProse(
      rawEnv?.reason ?? rawEnv?.conclusion,
      safeStatus === 'pending_recovery'
        ? 'Evidence review is pending recovery.'
        : 'Optional evidence review unavailable.',
    ),
  };
}

/**
 * Attach an advisory Gate 4 `evidence_review` envelope onto a candidate record,
 * enforcing packet validation, candidate/spec binding, verified saved execution receipt, and stale-packet invalidation.
 */
export function attachCandidateEvidenceReview(
  candidate,
  reviewEnvelope,
  currentFrozenPacket = null,
  {
    formSpecSha256 = null,
    attachmentSha256s = null,
    currentImagePaths = null,
    expectedPacketSubjectId = null,
    receiptStoreDir = null,
    allowTestDoubleReceipt = false,
  } = {},
) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('candidate must be an object.');
  }
  if (!reviewEnvelope || typeof reviewEnvelope !== 'object' || Array.isArray(reviewEnvelope)) {
    return null;
  }

  const expectedCandId = typeof (candidate.id ?? candidate.candidate_id) === 'string' && String(candidate.id ?? candidate.candidate_id).trim()
    ? String(candidate.id ?? candidate.candidate_id).trim()
    : null;
  const expectedSpecSha = typeof (formSpecSha256 ?? candidate.spec_sha256) === 'string' && String(formSpecSha256 ?? candidate.spec_sha256).trim()
    ? String(formSpecSha256 ?? candidate.spec_sha256).trim()
    : null;

  const rawStatus = typeof reviewEnvelope.status === 'string' ? reviewEnvelope.status.trim().toLowerCase() : '';
  const hasPurportedReview = Boolean(
    reviewEnvelope.review ||
    rawStatus === 'ready' ||
    (!rawStatus && (reviewEnvelope.conclusion || Array.isArray(reviewEnvelope.subjects))) ||
    (reviewEnvelope.schema_version === EVIDENCE_REVIEW_SCHEMA_VERSION && Array.isArray(reviewEnvelope.subjects) && reviewEnvelope.subjects.length > 0),
  );

  // P1-15: Project non-reviewed markers onto a small safe schema BEFORE reading `currentImagePaths`!
  if (!hasPurportedReview) {
    const nonReviewed = projectSafeAdvisoryMarker(reviewEnvelope, { expectedCandId, expectedSpecSha });
    candidate.evidence_review = nonReviewed;
    return nonReviewed;
  }

  let effectiveAttachmentShas = attachmentSha256s;
  if (effectiveAttachmentShas === null && Array.isArray(currentImagePaths)) {
    try {
      const stagedAtts = stageAndHashReviewAttachments(currentImagePaths);
      effectiveAttachmentShas = [...stagedAtts.attachmentSha256s];
    } catch (imgErr) {
      const readFailMarker = {
        status: 'unavailable',
        execution_status: 'attachment_read_failed',
        content_status: null,
        advisory_only: true,
        validated_envelope: false,
        schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
        ...(expectedCandId ? { candidate_id: expectedCandId } : {}),
        ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
        review: null,
        reason: scrubSafeAdvisoryProse(
          `Unable to validate review attachment for staleness check: ${imgErr?.message || imgErr}`,
          'Unable to validate review attachment for staleness check.',
        ),
      };
      candidate.evidence_review = readFailMarker;
      return readFailMarker;
    }
  }

  if (!currentFrozenPacket) {
    const unvalidatedMarker = {
      status: 'unavailable',
      execution_status: 'unvalidated_envelope_rejected',
      content_status: 'invalid',
      advisory_only: true,
      validated_envelope: false,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      ...(expectedCandId ? { candidate_id: expectedCandId } : {}),
      ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
      review: null,
      reason: 'Rejected unvalidated evidence_review lacking an admitted current packet.',
    };
    candidate.evidence_review = unvalidatedMarker;
    return unvalidatedMarker;
  }

  let frozen;
  try {
    frozen = freezeEvidenceReviewPacket(currentFrozenPacket);
  } catch (pktErr) {
    const badPktMarker = {
      status: 'unavailable',
      execution_status: 'invalid_packet',
      content_status: 'invalid',
      advisory_only: true,
      validated_envelope: false,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      ...(expectedCandId ? { candidate_id: expectedCandId } : {}),
      ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
      review: null,
      reason: scrubSafeAdvisoryProse(String(pktErr?.message || pktErr), 'Invalid evidence_review packet.'),
    };
    candidate.evidence_review = badPktMarker;
    return badPktMarker;
  }

  const requiredPacketSubId = expectedPacketSubjectId ?? expectedCandId;
  const packetSubjectAligned = !requiredPacketSubId || frozen.candidate?.subject_id === requiredPacketSubId;
  const boundAttShas = Array.isArray(reviewEnvelope.attachment_sha256s) ? reviewEnvelope.attachment_sha256s : [];
  // P1-07: Enforce equality even when effectiveAttachmentShas is an explicit empty list `[]`!
  const explicitAttListMismatch = Array.isArray(effectiveAttachmentShas) && (
    boundAttShas.length !== effectiveAttachmentShas.length ||
    boundAttShas.some((h, idx) => h !== effectiveAttachmentShas[idx])
  );

  if (
    !packetSubjectAligned ||
    explicitAttListMismatch ||
    (reviewEnvelope.candidate_id && expectedCandId && reviewEnvelope.candidate_id !== expectedCandId) ||
    (reviewEnvelope.form_spec_sha256 && expectedSpecSha && reviewEnvelope.form_spec_sha256 !== expectedSpecSha) ||
    isEvidenceReviewStale(reviewEnvelope, frozen, effectiveAttachmentShas)
  ) {
    const staleMarker = {
      status: 'unavailable',
      execution_status: 'stale_packet_mismatch',
      content_status: null,
      advisory_only: true,
      validated_envelope: false,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozen.review_id,
      packet_sha256: frozen.packet_sha256,
      ...(expectedCandId ? { candidate_id: expectedCandId } : {}),
      ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
      review: null,
      reason: 'Prior evidence review was marked stale because packet, attachment, candidate, or spec digest changed.',
    };
    candidate.evidence_review = staleMarker;
    return staleMarker;
  }

  let validated;
  try {
    validated = validateEvidenceReviewOutput(frozen, reviewEnvelope.review ?? reviewEnvelope);
  } catch (valErr) {
    const invalidMarker = {
      status: 'unavailable',
      execution_status: 'invalid_review_payload',
      content_status: 'invalid',
      advisory_only: true,
      validated_envelope: false,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozen.review_id,
      packet_sha256: frozen.packet_sha256,
      ...(expectedCandId ? { candidate_id: expectedCandId } : {}),
      ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
      review: null,
      reason: scrubSafeAdvisoryProse(String(valErr?.message || valErr), 'Invalid evidence_review payload.'),
    };
    candidate.evidence_review = invalidMarker;
    return invalidMarker;
  }

  if (!expectedCandId) {
    const missingCandMarker = {
      status: 'unavailable',
      execution_status: 'missing_candidate_binding',
      content_status: 'invalid',
      advisory_only: true,
      validated_envelope: false,
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozen.review_id,
      packet_sha256: frozen.packet_sha256,
      review: null,
      reason: 'Target candidate lacks a non-empty id / candidate_id.',
    };
    candidate.evidence_review = missingCandMarker;
    return missingCandMarker;
  }

  // P1-16: Verify saved Codex execution receipt on disk before granting `validated_envelope: true` (`已复核`)!
  const receiptCheck = verifySavedCodexReceipt(reviewEnvelope, {
    receiptStoreDir,
    allowTestDouble: allowTestDoubleReceipt === true,
    expectedCandidateId: expectedCandId,
    expectedFormSpecSha256: expectedSpecSha,
    expectedPacketSha256: frozen.packet_sha256,
    expectedAttachmentSha256s: Array.isArray(effectiveAttachmentShas) ? effectiveAttachmentShas : boundAttShas,
  });

  if (!receiptCheck.verified) {
    const effortStr = typeof (reviewEnvelope.reasoning_effort ?? reviewEnvelope.effort) === 'string'
      ? String(reviewEnvelope.reasoning_effort ?? reviewEnvelope.effort).trim()
      : '';
    const isInjectedExec = reviewEnvelope.execution_provenance === 'injected_executor';
    const unverifiedMarker = {
      status: 'unavailable',
      execution_status: isInjectedExec ? 'synthetic_executor_advisory' : 'unverified_execution_provenance',
      content_status: 'usable',
      advisory_only: true,
      validated_envelope: false,
      execution_provenance: isInjectedExec ? 'injected_executor' : 'unverified_synthetic',
      schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
      review_id: frozen.review_id,
      packet_sha256: frozen.packet_sha256,
      attachment_sha256s: [...boundAttShas],
      candidate_id: expectedCandId,
      ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
      ...(isInjectedExec && ['xhigh', 'max'].includes(effortStr) ? { reviewer_label: `Synthetic Executor · ${effortStr}`, reasoning_effort: effortStr } : {}),
      disposition_counts: validated.disposition_counts,
      review: validated.review,
      subjects: validated.subjects,
      answers: validated.answers,
      contradictions: validated.contradictions,
      gaps: validated.gaps,
      conclusion: validated.conclusion,
      reason: scrubSafeAdvisoryProse(
        receiptCheck.reason || 'Evidence review lacks a verified saved execution receipt.',
        'Evidence review lacks a verified saved execution receipt.',
      ),
    };
    candidate.evidence_review = unverifiedMarker;
    return unverifiedMarker;
  }

  const boundEnvelope = {
    status: 'ready',
    execution_status: 'completed',
    content_status: 'usable',
    advisory_only: true,
    validated_envelope: true,
    execution_provenance: receiptCheck.execution_provenance,
    receipt_sha256: receiptCheck.receipt_sha256,
    private_receipt_ref: `codex-receipt:${receiptCheck.receipt_sha256}`,
    ...(typeof reviewEnvelope.raw_output_sha256 === 'string' ? { raw_output_sha256: reviewEnvelope.raw_output_sha256 } : {}),
    schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
    review_id: frozen.review_id,
    packet_sha256: frozen.packet_sha256,
    attachment_sha256s: [...receiptCheck.attachment_sha256s],
    candidate_id: expectedCandId,
    ...(expectedSpecSha ? { form_spec_sha256: expectedSpecSha } : {}),
    reviewer_label: receiptCheck.reviewer_label,
    model: receiptCheck.model,
    reasoning_effort: receiptCheck.reasoning_effort,
    disposition_counts: validated.disposition_counts,
    review: validated.review,
    subjects: validated.subjects,
    answers: validated.answers,
    contradictions: validated.contradictions,
    gaps: validated.gaps,
    conclusion: validated.conclusion,
    reason: null,
  };
  candidate.evidence_review = boundEnvelope;
  return boundEnvelope;
}

/**
 * Run a complete multi-item Phase 2 batch with single-controller non-blocking orchestration:
 *  - Rejects duplicate form_ids upfront.
 *  - Stage 0: Ingest leads, forms, and primary_discovery/corroboration links.
 *  - Stage 1: Gate 1A ALWAYS runs (enforcing Gate 0, price-band guardrail, and preserving prior proven rights conflicts).
 *  - Stage 2: Gate 1B runs serially with DB lease + isolated sanitized per-form error handling.
 *  - Stage 3: Verifies primary_discovery lead admissibility, checks spec_version/rights/terminal status
 *             before EVERY paid dispatch and after async research, enforces provider guards on all paid calls,
 *             binds quotes/FX/scenarios/structured judgments, isolates per-form errors without overwriting
 *             rights rejections or deferrals, and writes immutable evaluations.
 */
export async function runPhase2Batch(store, {
  items,
  profile,
  sourcing_executor = null,
  deep_research_executor = null,
  fee_table_snapshot = null,
  as_of_date = new Date().toISOString().slice(0, 10),
  openai_hooks = null,
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

  const effectiveFeeSnapshot = fee_table_snapshot ?? getFba2027RateTableSnapshot({ profileRevision: Number(profile.revision ?? 59) });
  const report = {
    ingested: [],
    gate1a: [],
    gate1b: [],
    gate2_3: [],
    evaluations: [],
    skipped_zero_incremental: [],
  };

  // Stage 0: Ingest leads, candidate forms, and links (including validated SocialBridge payloads).
  for (const item of items) {
    const { form } = store.upsertCandidateForm(item.form);
    const linkedLeads = [];
    for (const leadSpec of item.leads ?? []) {
      if (leadSpec && leadSpec.social_bridge) {
        const res = store.ingestSocialBridgeLead(leadSpec.social_bridge, {
          ...leadSpec,
          form_id: form.form_id,
          link_role: leadSpec.link_role ?? 'primary_discovery',
          link_note: leadSpec.link_note ?? null,
        });
        linkedLeads.push({ lead_id: res.lead.lead_id, link_role: res.link?.link_role ?? (leadSpec.link_role ?? 'primary_discovery') });
      } else {
        const { lead } = store.upsertRawLead(leadSpec);
        const { link } = store.linkLeadToForm({
          lead_id: lead.lead_id,
          form_id: form.form_id,
          link_role: leadSpec.link_role ?? 'primary_discovery',
          note: leadSpec.link_note ?? null,
        });
        linkedLeads.push({ lead_id: lead.lead_id, link_role: link.link_role });
      }
    }
    report.ingested.push({ form_id: form.form_id, leads: linkedLeads });
  }

  // Stage 1: Gate 1A ALWAYS runs (0-cost local check, including Gate 0 & price-band guardrails).
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
      category_check: item.category_check ?? null,
      gate0_options: item.gate0_options ?? {},
      price_band_analysis: item.price_band_analysis ?? null,
      cluster_bands: item.cluster_bands ?? null,
      profile_revision: profile.revision ?? 58,
      disallow_pre1688_cost_guess_kill: item.disallow_pre1688_cost_guess_kill ?? true,
      allow_forward_price_discovery: item.allow_forward_price_discovery ?? false,
    });
    let lunaTriageOut = null;
    // P0-29: NEVER dispatch paid Luna triage on a form that did not pass Gate 1A (`proceed_to_gate1b === true`),
    // and keep the authoritative controller guard OUTSIDE user-overridable hook options!
    if (g1a.proceed_to_gate1b && Array.isArray(item.luna_triage_candidates) && item.luna_triage_candidates.length > 0) {
      const lunaHookOpts = openai_hooks?.luna_triage ?? {};
      const userLunaGuard = typeof lunaHookOpts.beforeDispatchGuard === 'function' ? lunaHookOpts.beforeDispatchGuard : null;
      lunaTriageOut = await runOptionalStage12LunaTriage({
        ...lunaHookOpts,
        candidates: item.luna_triage_candidates,
        targetSpec: item.luna_target_spec ?? { buyer_task: currentForm.buyer_task, label: currentForm.label },
        contactSheetDataUrl: item.contact_sheet_data_url ?? null,
        contactSheetDataUrls: item.contact_sheet_data_urls ?? null,
        gate0Config: item.gate0_options ?? {},
        beforeDispatchGuard: async (chunkIdx) => {
          const checkAuthoritativeLiveForm = () => {
            const live = store.getCandidateForm(formId);
            if (!live || live.spec_version !== currentForm.spec_version) {
              return { allowed: false, status: 'stale_spec_version_conflict', reason: `Form ${formId} spec changed concurrently.` };
            }
            const term = hasTerminalRejectionOrDeferralOnCurrentSpec(live);
            if (term.blocked) {
              return { allowed: false, status: term.status, reason: term.reason };
            }
            return { allowed: true };
          };
          const preCheck = checkAuthoritativeLiveForm();
          if (!preCheck.allowed) return preCheck;
          if (userLunaGuard) {
            const userRes = await userLunaGuard(chunkIdx);
            if (userRes && userRes.allowed === false) return userRes;
            // P0-29: Re-verify authoritative live form state IMMEDIATELY AFTER awaiting caller guard!
            return checkAuthoritativeLiveForm();
          }
          return preCheck;
        },
      });
    }
    report.gate1a.push({
      form_id: formId,
      ...g1a,
      ...(lunaTriageOut ? { luna_triage: lunaTriageOut } : {}),
    });
    if (g1a.proceed_to_gate1b) {
      const usableQuotes = store.getQuotesForForm(formId).filter(q => isQuoteUsableForForm(q, currentForm, as_of_date));
      let prevNeedMore = false;
      if ((profile.revision ?? 58) >= 59 && currentForm?.gate1b_result_json) {
        try {
          const prevG1b = JSON.parse(currentForm.gate1b_result_json);
          if ((!prevG1b?.spec_sha256 || prevG1b.spec_sha256 === currentForm.spec_sha256) && prevG1b?.second_factory_quote_needed === true) {
            prevNeedMore = true;
          }
        } catch { /* ignore */ }
      }
      const hasSourcingExec = typeof (item.sourcing_executor ?? sourcing_executor) === 'function';
      const requestFreshFactory = prevNeedMore && hasSourcingExec && !Array.isArray(item.existing_quotes) && !item.existing_quote;
      afterGate1A.push({
        item,
        form_id: formId,
        expected_spec_version: currentForm.spec_version,
        existing_quote: requestFreshFactory ? null : (usableQuotes[0] ?? null),
        existing_quotes: requestFreshFactory ? [] : usableQuotes,
      });
    } else if (g1a.gate_status === 'gate1a_rejected') {
      report.skipped_zero_incremental.push({ form_id: formId, stage: 'gate1a_rejected' });
    }
  }

  // Stage 2: Gate 1B serial 1688 queue (isolated sanitized per-form errors + CAPTCHA_PAUSED isolation).
  if ((profile.revision ?? 58) >= 59) {
    const initialQueue = store.getQueueState('gate1b_1688_queue');
    if (initialQueue && initialQueue.status === 'CAPTCHA_PAUSED') {
      report.batch_paused = true;
      report.pause_status = 'CAPTCHA_PAUSED';
      report.pause_reason = initialQueue.pause_reason ?? '1688 queue is persistently paused (CAPTCHA_PAUSED); clear slider and resume before continuing batch.';
      report.paused_form_id = initialQueue.paused_form_id ?? null;
      report.resumable = true;
      return report;
    }
  }
  const readyForGate23 = [];
  for (const entry of afterGate1A) {
    const { item, form_id: formId, existing_quote: existingQuote, existing_quotes: existingQuotes } = entry;
    const gate1aBeforeGate1b = store.getCandidateForm(formId)?.gate1a_result_json;
    let vision1688Out = null;
    let g1b;
    try {
      const hasVisionInput = Boolean(item.vision_1688_input && typeof item.vision_1688_input === 'object');
      g1b = await runGate1BForForm(store, {
        form_id: formId,
        sourcing_executor: item.sourcing_executor ?? sourcing_executor,
        early_screen_builder: item.early_screen_builder,
        existing_quote: existingQuote,
        existing_quotes: item.existing_quotes ?? existingQuotes,
        profile_revision: profile.revision ?? 59,
        require_ui_readback: item.require_ui_readback,
        as_of_date,
        allow_crossing_to_gate2_3: item.allow_crossing_to_gate2_3 === true,
        // P0-29: Dispatch 1688 vision precheck ONLY AFTER authoritative Gate-1B queue admission & exclusive lease acquisition!
        on_lease_acquired_hook: hasVisionInput
          ? async () => {
              const liveNow = store.getCandidateForm(formId);
              const termNow = liveNow ? hasTerminalRejectionOrDeferralOnCurrentSpec(liveNow) : { blocked: true, status: 'missing_form', reason: 'Form missing.' };
              if (!liveNow || liveNow.spec_version !== entry.expected_spec_version) {
                vision1688Out = {
                  status: 'unavailable',
                  execution_status: 'not_submitted',
                  task: '1688-vision',
                  reason: `Form ${formId} spec changed before Gate 1B vision precheck.`,
                };
                return { blocked: true, status: 'stale_spec_version_conflict', reason: vision1688Out.reason };
              }
              if (termNow.blocked) {
                vision1688Out = {
                  status: 'unavailable',
                  execution_status: 'not_submitted',
                  task: '1688-vision',
                  reason: sanitizeDiagnosticText(termNow.reason),
                };
                return { blocked: true, status: termNow.status, reason: vision1688Out.reason };
              }
              vision1688Out = await runOptional1688VisionPrecheck(item.vision_1688_input, openai_hooks?.vision_1688 ?? {});
              const liveAfterVision = store.getCandidateForm(formId);
              const termAfterVision = liveAfterVision
                ? hasTerminalRejectionOrDeferralOnCurrentSpec(liveAfterVision)
                : { blocked: true, status: 'missing_form', reason: 'Form missing.' };
              if (!liveAfterVision || liveAfterVision.spec_version !== entry.expected_spec_version) {
                return { blocked: true, status: 'stale_spec_version_conflict', reason: `Form ${formId} spec changed during Gate 1B vision precheck.` };
              }
              if (termAfterVision.blocked) {
                return { blocked: true, status: termAfterVision.status, reason: sanitizeDiagnosticText(termAfterVision.reason) };
              }
              return { blocked: false };
            }
          : null,
      });
      if (hasVisionInput && vision1688Out === null) {
        vision1688Out = {
          status: 'unavailable',
          execution_status: 'not_submitted',
          task: '1688-vision',
          reason: existingQuote
            ? 'Existing usable 1688 quote satisfied Gate 1B without fresh sourcing or paid vision precheck.'
            : `Gate 1B did not acquire sourcing queue lease (${g1b?.status ?? 'not_admitted'}); skipping paid vision precheck.`,
        };
      }
    } catch (error) {
      const safeErr = sanitizeDiagnosticText(error?.message || 'Gate 1B quote validation failed.');
      const errRes = { status: 'gate1b_pending', error: safeErr };
      const latestNow = store.getCandidateForm(formId);
      if (latestNow?.spec_version === entry.expected_spec_version &&
        latestNow.gate1a_result_json === gate1aBeforeGate1b &&
        !hasTerminalRejectionOrDeferralOnCurrentSpec(latestNow).blocked) {
        store.updateFormLifecycle(formId, 'gate1b_pending', { gate1b_result: errRes });
      }
      g1b = { form_id: formId, ...errRes, proceed_to_gate2_3: false };
    }
    if (vision1688Out) {
      g1b = { ...g1b, vision_1688_precheck: vision1688Out };
    }
    report.gate1b.push(g1b);
    if ((profile.revision ?? 58) >= 59 && (g1b.status === 'captcha_paused' || g1b.queue_status === 'CAPTCHA_PAUSED')) {
      report.batch_paused = true;
      report.pause_status = 'CAPTCHA_PAUSED';
      report.pause_reason = g1b.pause_reason ?? '1688 session requires owner verification (CAPTCHA_PAUSED).';
      report.paused_form_id = formId;
      report.resumable = true;
      return report;
    }
    if (g1b.proceed_to_gate2_3) {
      readyForGate23.push({
        item,
        form_id: formId,
        quote_id: g1b.quote?.quote_id ?? null,
        quote_ids: Array.isArray(g1b.quote_ids) && g1b.quote_ids.length > 0
          ? g1b.quote_ids
          : (g1b.quote?.quote_id ? [g1b.quote.quote_id] : []),
        expected_spec_version: g1b.quote?.spec_version ?? entry.expected_spec_version,
      });
    } else if (g1b.status === 'gate1b_rejected') {
      report.skipped_zero_incremental.push({ form_id: formId, stage: 'gate1b_rejected' });
    }
  }

  // Stage 3: Gate 2/3 guarded deep research + scoring + immutable evaluations (isolated per form!).
  for (const entry of readyForGate23) {
    const { item, form_id: formId, quote_id: quoteId, quote_ids: requiredQuoteIds = [], expected_spec_version: expectedSpecVersion } = entry;
    const form = store.getCandidateForm(formId);
    const quote = quoteId ? store.getQuoteById(quoteId) : null;
    const evaluatedQuotes = requiredQuoteIds.map(qid => store.getQuoteById(qid)).filter(Boolean);

    // Verify form spec, persisted quote parity, and zero rights/terminal conflicts BEFORE dispatching deep research!
    if (
      !form ||
      form.spec_version !== expectedSpecVersion ||
      !isQuoteUsableForForm(quote, form, as_of_date) ||
      evaluatedQuotes.length !== requiredQuoteIds.length ||
      evaluatedQuotes.some(q => !isQuoteUsableForForm(q, form, as_of_date))
    ) {
      report.gate2_3.push({ form_id: formId, status: 'stale_spec_version_conflict', attempt_ids: [] });
      continue;
    }
    const terminalPre = hasTerminalRejectionOrDeferralOnCurrentSpec(form);
    if (terminalPre.blocked) {
      report.gate2_3.push({
        form_id: formId,
        status: terminalPre.status,
        reason: terminalPre.reason,
        attempt_ids: [],
      });
      continue;
    }
    const gate1aRecord = form.gate1a_result_json ? JSON.parse(form.gate1a_result_json) : null;

    // Require at least one admissible primary_discovery lead (product/context + aligned SocialBridge if applicable).
    const linkedLeads = store.getLeadsForForm(formId);
    const hasAdmissiblePrimary = linkedLeads.some(l => isPrimaryLeadAdmissibleForForm(l, form));
    if (!hasAdmissiblePrimary) {
      const keepEval = store.getEvaluationsForForm(formId).length > 0;
      store.updateFormLifecycle(formId, keepEval ? 'evaluated' : 'gate1b_pending', {
        gate1b_result: mergeStage3DiagnosticIntoGate1b(form, {
          status: 'blocked_inadmissible_leads',
          reason: 'Form requires at least one admissible primary_discovery lead with reviewed product or context disposition aligned to the form.',
        }),
      });
      report.gate2_3.push({ form_id: formId, status: 'blocked_inadmissible_leads', attempt_ids: [] });
      continue;
    }

    store.updateFormLifecycle(formId, 'gate2_3_in_progress');
    const attemptIds = [];

    const checkLiveFormAllowsDispatch = () => {
      const lf = store.getCandidateForm(formId);
      const allReqUsable = requiredQuoteIds.every(qid => isQuoteUsableForForm(store.getQuoteById(qid), lf, as_of_date));
      if (!lf || lf.spec_version !== expectedSpecVersion || !isQuoteUsableForForm(store.getQuoteById(quote.quote_id), lf, as_of_date) || !allReqUsable) {
        return { allowed: false, status: 'stale_spec_version_conflict', reason: `Form ${formId} spec or quote changed concurrently.` };
      }
      const lt = hasTerminalRejectionOrDeferralOnCurrentSpec(lf);
      if (lt.blocked) {
        return { allowed: false, status: lt.status, reason: lt.reason };
      }
      const curLeads = store.getLeadsForForm(formId);
      if (!curLeads.some(l => isPrimaryLeadAdmissibleForForm(l, lf))) {
        return { allowed: false, status: 'blocked_inadmissible_leads', reason: `No admissible primary_discovery lead remains for ${formId}.` };
      }
      return { allowed: true, form: lf };
    };

    const guardedRequest = async (spec, executorFn) => {
      // Re-verify live form spec & rights/terminal status immediately BEFORE EVERY paid dispatch!
      const liveForm = store.getCandidateForm(formId);
      if (!liveForm || liveForm.spec_version !== expectedSpecVersion) {
        throw new Error(`Paid dispatch blocked: form ${formId} spec changed concurrently.`);
      }
      const liveTerm = hasTerminalRejectionOrDeferralOnCurrentSpec(liveForm);
      if (liveTerm.blocked) {
        throw new Error(`Paid dispatch blocked: ${liveTerm.reason}`);
      }
      const res = await store.executeGuardedRequest({
        ...spec,
        mode: 'fresh_observation',
        form_id: formId,
        stage: 'gate2_3',
        enforce_provider_guards: true,
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
        quotes: evaluatedQuotes,
        request: guardedRequest,
        store,
      });

      // Re-check spec_version, rights conflicts, and concurrent deferrals after async deep research!
      const postResearchCheck = checkLiveFormAllowsDispatch();
      if (!postResearchCheck.allowed) {
        report.gate2_3.push({
          form_id: formId,
          status: postResearchCheck.status,
          ...(postResearchCheck.reason ? { reason: postResearchCheck.reason } : {}),
          attempt_ids: attemptIds,
        });
        continue;
      }
      const latestForm = postResearchCheck.form;

      if (!researchOut || !researchOut.batch) {
        const keepEval = store.getEvaluationsForForm(formId).length > 0;
        store.updateFormLifecycle(formId, keepEval ? 'evaluated' : 'gate1b_pending', {
          gate1b_result: mergeStage3DiagnosticIntoGate1b(latestForm, { status: researchOut?.status || 'blocked_or_pending' }),
        });
        report.gate2_3.push({ form_id: formId, status: researchOut?.status || 'blocked_or_pending', attempt_ids: attemptIds });
        continue;
      }

      const clonedBatch = structuredClone(researchOut.batch);
      const rawInputCand = Array.isArray(clonedBatch?.candidates)
        ? clonedBatch.candidates.find(c => c?.id === formId)
        : null;
      if (!rawInputCand) {
        throw new TypeError(`Deep research batch did not contain a scored candidate matching form_id "${formId}".`);
      }

      // Enforce structured agent output contracts AND substantive consistency with scored candidate!
      const judgmentIssues = verifyStructuredAgentJudgments(formId, rawInputCand, {
        specMatches: researchOut.spec_matches ?? researchOut.spec_match,
        rubricJudgments: researchOut.rubric_judgments ?? researchOut.rubric_judge,
      });
      if (judgmentIssues.length > 0) {
        const blockedStatus = judgmentIssues.some(m => m.includes('SpecMatcher'))
          ? 'blocked_spec_mismatch'
          : 'blocked_contradictory_rubric_judgment';
        const reason = sanitizeDiagnosticText(judgmentIssues.join(' '));
        const keepEval = store.getEvaluationsForForm(formId).length > 0;
        store.updateFormLifecycle(formId, keepEval ? 'evaluated' : 'gate1b_pending', {
          gate1b_result: mergeStage3DiagnosticIntoGate1b(latestForm, {
            status: blockedStatus,
            spec_sha256: latestForm.spec_sha256,
            reason,
            issues: judgmentIssues.map(sanitizeDiagnosticText),
          }),
        });
        report.gate2_3.push({ form_id: formId, status: blockedStatus, reason, attempt_ids: attemptIds });
        continue;
      }

      // Bind Stage 3 scoring inputs authoritatively to persisted 1688 quote(s), accepted FX & Gate 1A declared scenarios.
      const usableQuotesPool = store.getQuotesForForm(formId).filter(q => isQuoteUsableForForm(q, latestForm, as_of_date));
      const latestGate1bRecord = latestForm.gate1b_result_json ? JSON.parse(latestForm.gate1b_result_json) : null;
      verifyStage3CandidateBindings(rawInputCand, gate1aRecord, quote, usableQuotesPool, latestGate1bRecord);
      // Propagate Gate 1A $49.99 & $50.00 cliff stress comparisons (per period for seasonal candidates).
      attachGate1APriceCliffStress(rawInputCand, gate1aRecord);

      const manifest = researchOut.discovery
        ? prepareDiscovery(researchOut.discovery.pool, researchOut.discovery.decisions)
        : null;
      const withManifest = manifest ? attachDiscovery(clonedBatch, manifest) : clonedBatch;
      const boundBatch = attachStoreDiscoveryProvenance(withManifest, store);
      const scoredResult = scoreBatch(boundBatch, profile);
      if (manifest) scoredResult.discovery = { ...manifest, summary: boundBatch.discovery_summary };

      // Strictly match scored candidate to formId (NEVER fall back to candidates[0]!).
      const scoredCand = scoredResult.candidates.find(c => (c.candidate_id || c.id) === formId);
      if (!scoredCand) {
        throw new TypeError(`Deep research batch did not contain a scored candidate matching form_id "${formId}".`);
      }
      const inputCand = boundBatch.candidates.find(c => c.id === formId);
      if (!inputCand) {
        throw new TypeError(`Deep research input batch did not contain an input candidate matching form_id "${formId}".`);
      }

      // Compute deterministic evidence_bundle_sha256 BEFORE attaching advisory Gate-4 evidence_review
      // so advisory red-team reviews never fracture deterministic evaluation identity.
      const deterministicCandInput = Object.hasOwn(inputCand, 'evidence_review')
        ? (() => { const { evidence_review: _advisory, ...rest } = inputCand; return rest; })()
        : inputCand;
      const bundleHash = computeEvidenceBundleHash({
        form_spec_sha256: latestForm.spec_sha256,
        candidate_input: deterministicCandInput,
        discovery_manifest: manifest,
        profile_snapshot: profile,
        fee_table_snapshot: effectiveFeeSnapshot,
      });
      const perCandidateSha = sha256Hex(canonicalJson(scoredCand));

      // Optional Stage 3 Terra enhancements & Gate 4 Codex CLI Astra evidence_review attachment
      // Re-check live form/spec/rights/deferral BEFORE EVERY paid or external dispatch!
      let rightsPreScreenOut = null;
      const rightsInput = researchOut.rights_prescreen_input ?? item.rights_prescreen_input ?? null;
      if (rightsInput) {
        const preRightsGuard = checkLiveFormAllowsDispatch();
        if (!preRightsGuard.allowed) {
          report.gate2_3.push({ form_id: formId, status: preRightsGuard.status, reason: preRightsGuard.reason, attempt_ids: attemptIds });
          continue;
        }
        rightsPreScreenOut = await runOptionalRightsPreScreen(rightsInput, openai_hooks?.rights_prescreen ?? {});
        if (rightsPreScreenOut?.attempt_id) attemptIds.push(rightsPreScreenOut.attempt_id);
      }

      const afterRightsGuard = checkLiveFormAllowsDispatch();
      if (!afterRightsGuard.allowed) {
        report.gate2_3.push({
          form_id: formId,
          status: afterRightsGuard.status,
          reason: afterRightsGuard.reason,
          attempt_ids: attemptIds,
          ...(rightsPreScreenOut ? { rights_prescreen: rightsPreScreenOut } : {}),
        });
        continue;
      }

      let reviewJudgeOut = null;
      const reviewJudgeInput = researchOut.review_judge_input ?? item.review_judge_input ?? null;
      if (reviewJudgeInput) {
        reviewJudgeOut = await runOptionalReviewJudge(reviewJudgeInput, openai_hooks?.review_judge ?? {});
        if (reviewJudgeOut?.attempt_id) attemptIds.push(reviewJudgeOut.attempt_id);
      }

      const afterJudgeGuard = checkLiveFormAllowsDispatch();
      if (!afterJudgeGuard.allowed) {
        report.gate2_3.push({
          form_id: formId,
          status: afterJudgeGuard.status,
          reason: afterJudgeGuard.reason,
          attempt_ids: attemptIds,
          ...(rightsPreScreenOut ? { rights_prescreen: rightsPreScreenOut } : {}),
          ...(reviewJudgeOut ? { review_judge: reviewJudgeOut } : {}),
        });
        continue;
      }

      const qualification = scoredCand.qualification ?? {
        counts_toward_target: scoredCand.queue === 'comparable',
        mode: scoredCand.queue === 'comparable' ? 'comparable' : 'none',
        primary_period_id: null,
        display_period_id: null,
        reasons: [],
      };

      let attachedEvidenceReview = null;
      const gate4HookOpts = openai_hooks?.evidence_review ?? {};
      const receiptStoreDir = gate4HookOpts.receiptStoreDir ?? gate4HookOpts.receiptDir ?? null;
      const allowTestDoubleReceipt = Boolean(gate4HookOpts.allowTestDoubleReceipt === true);
      const reviewPacket = researchOut.evidence_review_packet ?? item.evidence_review_packet ?? null;
      const enforceQualifyingOnlyGate4 = (profile.revision ?? 59) >= 59 || gate4HookOpts.qualifyingOnly === true;
      if (reviewPacket) {
        const gate4Res = await runOptionalGate4EvidenceReview(reviewPacket, {
          ...gate4HookOpts,
          candidateId: formId,
          formSpecSha256: latestForm.spec_sha256,
          ...(enforceQualifyingOnlyGate4 ? { candidateQualification: qualification } : {}),
        });
        if (gate4Res?.status !== 'skipped_non_qualifying') {
          attachedEvidenceReview = attachCandidateEvidenceReview(inputCand, gate4Res, reviewPacket, {
            formSpecSha256: latestForm.spec_sha256,
            currentImagePaths: Array.isArray(gate4HookOpts.imagePaths) ? gate4HookOpts.imagePaths : null,
            receiptStoreDir,
            allowTestDoubleReceipt,
          });
        }
      } else if (researchOut.evidence_review && typeof researchOut.evidence_review === 'object') {
        attachedEvidenceReview = attachCandidateEvidenceReview(inputCand, researchOut.evidence_review, null, {
          formSpecSha256: latestForm.spec_sha256,
          receiptStoreDir,
          allowTestDoubleReceipt,
        });
      }
      // Local SQLite / evidence_review storage checks ONLY real credential/secret tokens (`containsSecretToken`),
      // never wiping `evidence_review` over local paths or public patent/web text (`renderReport` sanitizes HTML display).
      if (attachedEvidenceReview) {
        try {
          if (containsSecretToken(attachedEvidenceReview)) {
            throw new Error('Advisory marker contained a secret token.');
          }
          canonicalJson(attachedEvidenceReview);
        } catch {
          attachedEvidenceReview = projectSafeAdvisoryMarker(
            { status: 'unavailable', reason: 'Optional evidence_review contained a secret token and was sanitized.' },
            { expectedCandId: formId, expectedSpecSha: latestForm.spec_sha256 },
          );
          inputCand.evidence_review = attachedEvidenceReview;
        }
      }

      const resultBytes = Buffer.from(`${JSON.stringify(scoredResult, null, 2)}\n`, 'utf8');
      const htmlBytes = Buffer.from(
        renderReport(scoredResult, boundBatch, {
          receiptStoreDir,
          allowTestDoubleReceipts: allowTestDoubleReceipt,
        }),
        'utf8',
      );
      const batchResultSha = sha256Hex(resultBytes);
      const htmlSha = sha256Hex(htmlBytes);

      const periods = Array.isArray(scoredCand.operating_periods) && scoredCand.operating_periods.length > 0
        ? scoredCand.operating_periods
        : [{
          id: 'annual',
          queue: scoredCand.queue,
          covered_weight: scoredCand.covered_weight,
          supported_range: scoredCand.supported_range,
          total_range: scoredCand.total_range,
        }];

      let persistedHtmlSha = htmlSha;
      let persistedEvidenceReview = attachedEvidenceReview;
      store.runInTransaction(() => {
        const recheck = store.getCandidateForm(formId);
        if (!recheck || recheck.spec_version !== expectedSpecVersion) {
          throw new Error(`Spec version changed concurrently for ${formId}; aborting stale evaluation write.`);
        }
        const recheckTerm = hasTerminalRejectionOrDeferralOnCurrentSpec(recheck);
        if (recheckTerm.blocked) {
          throw new Error(`${recheckTerm.reason}; aborting evaluation write.`);
        }
        const currentLeads = store.getLeadsForForm(formId);
        if (!currentLeads.some(l => isPrimaryLeadAdmissibleForForm(l, recheck))) {
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
              form_spec_sha256: recheck.spec_sha256,
              batch_result_sha256: batchResultSha,
              batch_html_sha256: htmlSha,
              summary: scoredResult.summary,
              fee_table_version: effectiveFeeSnapshot?.metadata?.version ?? effectiveFeeSnapshot?.version ?? null,
            },
            review_notes: researchOut.review_notes ?? null,
            evidence_review: attachedEvidenceReview ?? null,
            source_attempt_ids: attemptIds,
          });
          persistedHtmlSha = evRec.evaluation.html_sha256 ?? htmlSha;
          if (!persistedEvidenceReview && evRec.evaluation.evidence_review_json) {
            try { persistedEvidenceReview = JSON.parse(evRec.evaluation.evidence_review_json); } catch { /* ignore */ }
          }
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
        html_sha256: persistedHtmlSha,
        this_run_html_sha256: htmlSha,
        attempt_ids: attemptIds,
        ...(rightsPreScreenOut ? { rights_prescreen: rightsPreScreenOut } : {}),
        ...(reviewJudgeOut ? { review_judge: reviewJudgeOut } : {}),
        ...(persistedEvidenceReview ? { evidence_review: persistedEvidenceReview } : {}),
      });
    } catch (error) {
      // Isolate per-form Stage 3 error so sibling ready forms still complete,
      // while NEVER overwriting a concurrent same-spec rights rejection, deferral, or newer spec_version!
      const safeErr = sanitizeDiagnosticText(error?.message || 'Gate 2/3 execution failed.');
      const latestOnError = store.getCandidateForm(formId);
      const termOnError = hasTerminalRejectionOrDeferralOnCurrentSpec(latestOnError);
      const specChanged = !latestOnError || latestOnError.spec_version !== expectedSpecVersion;
      if (!specChanged && !termOnError.blocked) {
        const keepEval = store.getEvaluationsForForm(formId).length > 0;
        store.updateFormLifecycle(formId, keepEval ? 'evaluated' : 'gate1b_pending', {
          gate1b_result: mergeStage3DiagnosticIntoGate1b(latestOnError, { status: 'gate2_3_error', error: safeErr }),
        });
      }
      report.gate2_3.push({
        form_id: formId,
        status: termOnError.blocked ? termOnError.status : (specChanged ? 'stale_spec_version_conflict' : 'gate2_3_error'),
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
