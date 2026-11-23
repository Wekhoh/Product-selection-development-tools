// Offline trial calculations, with revision-50 replay. Importing performs no I/O.
import { validEvidenceDate as validDate } from './observations.mjs';
import { calculateEconomics, ledgerMeetsMarginFloor, REQUIRED_COSTS } from './economics.mjs';
import { resolveEffectivePricing } from './fee-basis.mjs';

const EXPECTED_ITEMS = [
  ['refund_adjusted_pre_ad_margin', 22], ['unit_contribution', 8],
  ['relevant_purchase_entry_bid', 15], ['purchase_demand_scale', 4],
  ['supported_opportunity', 6], ['purchase_entry_match', 6],
  ['product_dispersion', 3], ['brand_dispersion', 3], ['seller_dispersion', 4],
  ['new_product_count_share', 3], ['new_product_sales_share', 2],
  ['low_rating_sales_performance', 4], ['natural_visibility_development', 1],
  ['existing_solution_fit', 4], ['feasible_light_differentiation', 1],
  ['low_return_preference', 4], ['storage_tolerance', 2], ['transport_tolerance', 2],
  ['routine_complexity', 1], ['specific_design_rights', 3], ['applicable_public_requirements', 2],
];
const EXPECTED_GROUPS = ['profit', 'suggested_bid_pressure', 'niche_demand', 'market_entry',
  'normal_newcomer', 'need_fit', 'product_risk_and_operations', 'rights_and_requirements'];

const text = value => typeof value === 'string' && value.trim().length > 0;
const number = value => typeof value === 'number' && Number.isFinite(value);
const addRanges = (a, b) => [a[0] + b[0], a[1] + b[1]];
const span = values => [Math.min(...values), Math.max(...values)];
const point = range => range[0] === range[1] ? range[0] : null;
const mergeRefs = (...lists) => [...new Set(lists.flatMap(list => Array.isArray(list) ? list.filter(text) : []))];
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareIdentity = (a, b) => compareText(a.family_id, b.family_id) || compareText(a.asin, b.asin);
const compareIdentityTrimmed = (a, b) =>
  compareText(text(a?.family_id) ? a.family_id.trim() : '', text(b?.family_id) ? b.family_id.trim() : '') ||
  compareText(text(a?.asin) ? a.asin.trim() : '', text(b?.asin) ? b.asin.trim() : '');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
};

// Exact BigInt rational arithmetic for Revision 58 Q31 (zero IEEE-754 drift in sorting, ties, and greedy F(S)).
function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) { const t = x % y; x = y; y = t; }
  return x;
}
function rat(n, d = 1n) {
  if (d === 0n) throw new RangeError('Zero denominator in rational arithmetic.');
  if (n === 0n) return { n: 0n, d: 1n };
  const sign = d < 0n ? -1n : 1n;
  const nn = sign * n;
  const dd = sign * d;
  const g = gcdBig(nn, dd);
  return { n: nn / g, d: dd / g };
}
function ratFromNumber(value) {
  if (!number(value)) throw new TypeError('Finite number required for rational conversion.');
  const [mantissa, expPart = '0'] = value.toString().toLowerCase().split('e');
  const sign = mantissa.startsWith('-') ? -1n : 1n;
  const [intPart, fracPart = ''] = mantissa.replace(/^[+-]/, '').split('.');
  const digits = BigInt(intPart + fracPart);
  const exp = Number(expPart) - fracPart.length;
  return exp >= 0 ? rat(sign * digits * (10n ** BigInt(exp)), 1n) : rat(sign * digits, 10n ** BigInt(-exp));
}
const ratAdd = (a, b) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const ratSub = (a, b) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const ratMul = (a, b) => rat(a.n * b.n, a.d * b.d);
const ratDiv = (a, b) => rat(a.n * b.d, a.d * b.n);
const ratCmp = (a, b) => {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
};
const ratMin = (a, b) => ratCmp(a, b) <= 0 ? a : b;
const ratMax = (a, b) => ratCmp(a, b) >= 0 ? a : b;
function ratToNumber(r) {
  if (r.n === 0n) return 0;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const absN = r.n < 0n ? -r.n : r.n;
  if (absN <= maxSafe && r.d <= maxSafe) return Number(r.n) / Number(r.d);
  // Scale to 18 decimal places before converting to IEEE-754 double to avoid BigInt overflow truncation.
  const scale = 10n ** 18n;
  const scaled = (r.n * scale) / r.d;
  return Number(scaled) / 1e18;
}
function medianRat(values) {
  const sorted = values.map(ratFromNumber).sort(ratCmp);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : ratDiv(ratAdd(sorted[mid - 1], sorted[mid]), rat(2n, 1n));
}

const US_SITE_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});
function toUsSiteCalendarDate(value) {
  if (!validDate(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return US_SITE_DATE_FORMATTER.format(new Date(value));
}
function threeCalendarMonthsEarlier(isoCalDate) {
  const y = Number(isoCalDate.slice(0, 4));
  const m = Number(isoCalDate.slice(5, 7)) - 1;
  const d = Number(isoCalDate.slice(8, 10));
  const maxDayInTarget = new Date(Date.UTC(y, m - 2, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 3, Math.min(d, maxDayInTarget))).toISOString().slice(0, 10);
}
function calendarDayDiff(laterCal, earlierCal) {
  return Math.round((Date.parse(`${laterCal}T00:00:00Z`) - Date.parse(`${earlierCal}T00:00:00Z`)) / 86_400_000);
}

export function upgradeProfileToR59(baseProfile) {
  if (!baseProfile || typeof baseProfile !== 'object') {
    throw new TypeError('A valid base reference profile object is required to upgrade to revision 59.');
  }
  const next = structuredClone(baseProfile);
  next.revision = 59;
  if (next.workflow?.scoring_and_ordering) {
    next.workflow.scoring_and_ordering.revision = 59;
    next.workflow.scoring_and_ordering.crossing_margin_interval_r59 =
      'When coherent validated primary scenarios cross the 30% pre-ad margin floor (at least one scenario >= 30% and at least one < 30%), extend the below-floor scenario margin score linearly along min(22, max(0, 11 + 55 * (m - 0.30))) paired with the same scenario unit contribution (0-8) so [min_total, max_total] is displayed without inflating strict all-scenario qualifying counts.';
    next.workflow.scoring_and_ordering.progressive_bid_tiers_r59 =
      '3-Tier Progressive Suggested Bid: Tier 1 keeps 1-3 searched mid-core purchase terms in entries and moves unbid ultra-long-tail terms to long_tail_opportunistic_terms; Tier 2 accepts SIF cpc_raise_exact (up_and_down) when cpc_fixed_exact is absent plus SellerSprite down_only; Tier 3 allows cold-start parent_functional_proxy with explicit disclosure or deducts the 15-pt item (0/15) when all tiers return zero bids.';
  }
  return next;
}

function definitions(profile) {
  if (![50, 51, 52, 53, 54, 55, 56, 57, 58, 59].includes(profile?.revision) || profile.total_budget !== 100 || profile.production_eligible !== false ||
    profile.activate_by_import !== false || !Array.isArray(profile.group_budgets) ||
    profile.group_budgets.length !== EXPECTED_GROUPS.length || profile.group_budgets.some((group, index) =>
      group?.id !== EXPECTED_GROUPS[index] || !Array.isArray(group.items))) {
    throw new TypeError('A supported frozen 100-point trial profile is required.');
  }
  const items = profile.group_budgets.flatMap(group => (group.items ?? []).map(item => ({ ...item, group: group.id })));
  if (items.length !== EXPECTED_ITEMS.length || items.some((item, i) =>
    item.id !== EXPECTED_ITEMS[i][0] || item.weight !== EXPECTED_ITEMS[i][1] || !item.mapping)) {
    throw new TypeError('The profile must preserve the adopted 21 item IDs, order, weights and mappings.');
  }
  if (profile.group_budgets.some(group => group.weight !== group.items.reduce((sum, item) => sum + item.weight, 0))) {
    throw new TypeError('Profile group budgets do not match their items.');
  }
  const margin = items[0].mapping;
  const priceRule = profile.reference_screening?.comparable_reference_price;
  if (!number(margin.eligible_margin_floor) || !number(margin.full_score_at) ||
    margin.full_score_at <= margin.eligible_margin_floor || !number(margin.score_at_floor) ||
    margin.eligible_margin_floor !== profile.reference_screening?.margin?.minimum || !profile.measurement ||
    (profile.revision >= 57 && (!number(priceRule?.minimum_inclusive) || priceRule.minimum_inclusive < 29.99 ||
      margin.eligible_margin_floor < 0.3)) ||
    profile.workflow?.scoring_and_ordering?.revision !== profile.revision) {
    throw new TypeError('The profile needs valid margin and matching shared mappings.');
  }
  if (profile.revision >= 51) {
    const { actual_rating_points: a, sales_cap: s } = profile.measurement.current_category_newcomers ?? {};
    if (!a || !s || !Object.values(a).every(number) || !Object.values(s).every(number) ||
      a.max_points !== 4 || s.max_points !== 4 || a.full_points_through < 0 || a.linear_end_rating <= a.full_points_through ||
      a.linear_end_points < 0 || a.linear_end_points > 4 || s.lower_ratio <= 0 || s.upper_ratio <= s.lower_ratio ||
      s.lower_points < 0 || s.lower_points > 4) throw new TypeError('Current-category newcomer curves need valid ordered anchors.');
  }
  return items;
}

function context(candidate) {
  if (!candidate || !text(candidate.id)) throw new TypeError('A candidate needs a stable nonempty ID.');
  const evidence = new Map();
  const duplicates = new Set();
  const seen = new Set();
  for (const entry of Array.isArray(candidate.evidence) ? candidate.evidence : []) {
    if (!text(entry?.id)) continue;
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
    if (!text(entry.source) || !validDate(entry.observed_at)) continue;
    evidence.set(entry.id, entry);
  }
  for (const id of duplicates) evidence.delete(id);
  return { candidate, evidence };
}

function hasEvidence(refs, ctx) {
  return text(ctx.candidate.form) && Array.isArray(refs) && refs.length > 0 && refs.every(id => text(id) && ctx.evidence.has(id));
}

function readNumber(input, unit, ctx, { min = 0, max = Infinity, integer = false } = {}) {
  if (!input || input.value === null || input.value === undefined) return { value: null, reason: input?.reason ?? 'Observation is missing.' };
  if (input.supported === false || input.material_conflict === true) return { value: null, reason: input.reason ?? 'Observation has unresolved support or conflict.' };
  if (input.unit !== unit) return { value: null, reason: `Expected unit ${unit}.` };
  if (!number(input.value) || input.value < min || input.value > max || (integer && !Number.isSafeInteger(input.value))) {
    return { value: null, reason: 'Observation is outside its valid numeric domain.' };
  }
  if (!hasEvidence(input.evidence, ctx)) return { value: null, reason: 'Observation needs valid source/date evidence references and a concrete form.' };
  return { value: input.value, reason: null };
}

function interpolate(value, anchors) {
  if (value <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x, y] = anchors[i];
    const [previousX, previousY] = anchors[i - 1];
    if (value <= x) return previousY + (y - previousY) * (value - previousX) / (x - previousX);
  }
  return anchors.at(-1)[1];
}

function numericScore(item, value) {
  if (!number(value)) return null;
  const m = item.mapping;
  let result;
  switch (item.id) {
    case 'refund_adjusted_pre_ad_margin':
      if (value < m.eligible_margin_floor || value > 1) return null;
      result = Math.min(item.weight, m.score_at_floor + (item.weight - m.score_at_floor) *
        (value - m.eligible_margin_floor) / (m.full_score_at - m.eligible_margin_floor));
      break;
    case 'unit_contribution':
      if (value < 0) return null;
      result = item.weight * Math.min(value / m.full_score_at, 1);
      break;
    case 'relevant_purchase_entry_bid':
      if (value < 0) return null;
      result = item.weight * Math.min(1, Math.max(0, (m.zero_score_at_or_above - value) /
        (m.zero_score_at_or_above - m.full_score_at_or_below)));
      break;
    case 'purchase_demand_scale':
      if (value < 0) return null;
      result = interpolate(value, m.anchors);
      break;
    case 'low_return_preference':
      if (value < 0 || value > 1) return null;
      result = interpolate(value, m.anchors);
      break;
    case 'product_dispersion': case 'brand_dispersion': case 'seller_dispersion':
      if (value < 0 || value > 1) return null;
      result = item.weight * Math.min(1, Math.max(0, (m.zero_score_at_or_above - value) /
        (m.zero_score_at_or_above - m.full_score_at_or_below)));
      break;
    case 'new_product_count_share': case 'new_product_sales_share':
      if (value < 0 || value > 1) return null;
      result = item.weight * Math.min(value / m.full_score_at, 1);
      break;
    default: throw new TypeError(`${item.id} is not a point-valued numeric mapping.`);
  }
  return number(result) ? result : null;
}

export function scoreNumericValue(itemId, value, profile) {
  const definition = definitions(profile).find(item => item.id === itemId);
  if (!definition) throw new TypeError(`Unknown scoring item: ${itemId}`);
  return numericScore(definition, value);
}

function missing(item, reason, input = null, extra = {}) {
  return {
    id: item.id, group: item.group, weight: item.weight, status: 'needs_evidence',
    score: null, score_range: null, conditional_range: null, input,
    evidence: Array.isArray(input?.evidence) ? input.evidence : [], reason, ...extra,
  };
}

function scored(item, score, input, extra = {}) {
  const range = extra.score_range ?? [score, score];
  if (!Array.isArray(range) || range.length !== 2 || !range.every(number) || range[0] < 0 || range[1] > item.weight || range[0] > range[1]) {
    throw new TypeError(`The profile produced an invalid supported score for ${item.id}.`);
  }
  return { ...missing(item, null, input), status: 'scored', score, score_range: [score, score], ...extra };
}

function scoreMetric(item, input, ctx, profile) {
  let validScope;
  if (item.id === 'purchase_demand_scale') {
    const allowedGrains = profile.revision >= 59
      ? new Set(['parent_units', 'target_child_units'])
      : new Set(['parent_units']);
    validScope = input?.window_days === 30 && input.window_basis === 'latest_30_days' &&
      input.coverage_supported === true && input.deduplicated === true &&
      ['niche', 'period', 'grain'].every(key => text(input[key])) &&
      (profile.revision < 57 || allowedGrains.has(input.grain));
  } else {
    validScope = input?.applicable === true && text(input.category) && text(input.period);
  }
  if (!validScope) return missing(item, input?.reason ?? 'Required metric scope, period or applicability is unsupported.', input);
  if (item.id === 'purchase_demand_scale' && Object.hasOwn(input, 'value_range')) {
    const range = input.value_range;
    if (input.value != null || input.coherent !== true || !text(input.range_basis) ||
      !Array.isArray(range) || range.length !== 2 || !range.every(number) || range[0] > range[1]) {
      return missing(item, 'Demand bounds need one supported coherent population and an explained range, without a competing point.', input);
    }
    const readings = range.map(value => readNumber({ ...input, value }, 'units', ctx));
    const invalid = readings.find(reading => reading.value === null);
    if (invalid) return missing(item, invalid.reason, input);
    const scoreRange = range.map(value => numericScore(item, value));
    return scored(item, point(scoreRange), input, { score_range: scoreRange });
  }
  const reading = readNumber(input, item.id === 'purchase_demand_scale' ? 'units' : 'fraction', ctx,
    { max: item.id === 'purchase_demand_scale' ? Infinity : 1 });
  return reading.value === null ? missing(item, reading.reason, input) : scored(item, numericScore(item, reading.value), input);
}

function scoreJudgment(item, input, ctx) {
  if (input?.anchor === null || input?.anchor === undefined) {
    return missing(item, text(input?.reason) ? input.reason : 'The rubric judgment is unavailable and needs evidence.', input);
  }
  if (!input || !text(input.reason) || !hasEvidence(input.evidence, ctx) || input.supported === false || input.material_conflict === true) {
    return missing(item, input?.reason ?? 'A bounded judgment needs a reason and valid evidence references.', input);
  }
  const anchor = item.mapping.anchors.find(entry => (entry.score ?? entry.points) === input.anchor);
  if (!anchor) return missing(item, 'Judgment does not name an adopted rubric anchor.', input);
  if (item.id === 'supported_opportunity' && input.anchor > 0 && !item.mapping.routes.includes(input.route)) {
    return missing(item, 'A supported opportunity needs one adopted strongest route.', input);
  }
  return scored(item, input.anchor, input, {
    reason: input.reason, anchor_meaning: anchor.meaning ?? anchor.evidence, anchor_label: anchor.label ?? null,
  });
}

function scoreMarket(item, market, ctx) {
  const concentration = { product_dispersion: 'product', brand_dispersion: 'brand', seller_dispersion: 'seller' }[item.id];
  const input = concentration ? market?.concentrations?.[concentration] :
    market?.newcomer?.[item.id === 'new_product_count_share' ? 'count_share' : 'unit_sales_share'];
  const commonValid = market?.provider === 'sellersprite' && market.relevant === true &&
    ['report_id', 'population', 'family_basis', 'period'].every(key => text(market[key])) &&
    hasEvidence(market.evidence, ctx) && (!input?.report_id || input.report_id === market.report_id);
  if (!commonValid || (concentration && !text(market.head_group))) {
    return missing(item, input?.reason ?? 'One relevant source-native report with compatible population, period and basis is required.', input);
  }
  if (!concentration && (market.newcomer_age_months !== 3 || market.newcomer_sales_window !== 'latest_30_days')) {
    return missing(item, 'Native newcomer shares require the same three-month report and latest-30-day unit window.', input);
  }
  if (!concentration && input && Object.hasOwn(input, 'denominator') && (!number(input.denominator) || input.denominator <= 0)) {
    return missing(item, 'A supplied native ratio denominator must be supported and positive; zero or unknown is not a zero share.', input);
  }
  const reading = readNumber(input, 'fraction', ctx, { max: 1 });
  return reading.value === null ? missing(item, reading.reason, input) : scored(item, numericScore(item, reading.value), input,
    { report_id: market.report_id, source_population: market.population, period: market.period, family_basis: market.family_basis });
}

function bidSource(input, source, bids, ctx, profile = null) {
  const isR59 = (profile?.revision ?? 0) >= 59;
  if (!isR59) {
    const strategy = input?.strategy ?? (source === 'sellersprite' ? 'unspecified' : null);
    const compatible = input?.match_type === 'exact' &&
      (source === 'sif' ? strategy === 'fixed' : ['fixed', 'unspecified'].includes(strategy)) &&
      (!input.marketplace || input.marketplace === bids.marketplace) && (!input.currency || input.currency === bids.currency);
    if (!compatible) return { point: null, range: null, reason: 'Missing or incompatible exact-match strategy, currency or marketplace.', strategy };
    const reading = readNumber(input, 'USD', ctx);
    const low = readNumber({ ...input, value: input.low }, 'USD', ctx);
    const high = readNumber({ ...input, value: input.high }, 'USD', ctx);
    const range = low.value !== null && high.value !== null && low.value <= high.value ? [low.value, high.value] : null;
    return { point: reading.value, range, reason: reading.reason, strategy,
      limitation: source === 'sellersprite' && strategy === 'unspecified' ? 'SellerSprite strategy is unspecified; this is an approximate trial input.' : null };
  }
  if (!input || typeof input !== 'object') {
    return { point: null, range: null, reason: 'Source observation not supplied.', strategy: null };
  }
  const channel = source === 'sellersprite' && text(input.channel) ? input.channel.trim() : (source === 'sellersprite' ? 'ss_mcp' : null);
  const rawStrategy = input.strategy ?? (source === 'sellersprite' && channel !== 'ss_web' ? 'unspecified' : null);
  const marketCurrencyOk = (!input.marketplace || input.marketplace === bids.marketplace) &&
    (!input.currency || input.currency === bids.currency);

  if (isR59 && source === 'sif') {
    // Tier 1: SIF fixed exact when present; Tier 2: SIF already-returned "提高和降低（精准）" (cpc_raise_exact / up_and_down) when fixed is absent!
    const fixedPresent = input.value !== null && input.value !== undefined;
    const raiseVal = input.cpc_raise_exact ?? input.raise_exact_value ??
      (['up_and_down', 'raise', 'raise_and_lower'].includes(rawStrategy) ? input.value : null);
    const raiseLow = input.cpc_raise_exact_low ?? input.raise_exact_low ?? input.low;
    const raiseHigh = input.cpc_raise_exact_high ?? input.raise_exact_high ?? input.high;
    if (input.match_type === 'exact' && marketCurrencyOk) {
      if (rawStrategy === 'fixed' && fixedPresent) {
        const reading = readNumber(input, 'USD', ctx);
        const low = readNumber({ ...input, value: input.low }, 'USD', ctx);
        const high = readNumber({ ...input, value: input.high }, 'USD', ctx);
        const range = low.value !== null && high.value !== null && low.value <= high.value ? [low.value, high.value] : null;
        return { point: reading.value, range, reason: reading.reason, strategy: 'fixed', tier_used: 'tier1_fixed_exact', limitation: null };
      }
      if (raiseVal !== null && raiseVal !== undefined && ['fixed', 'up_and_down', 'raise', 'raise_and_lower', null].includes(rawStrategy)) {
        const reading = readNumber({ ...input, value: raiseVal }, 'USD', ctx);
        const low = readNumber({ ...input, value: raiseLow }, 'USD', ctx);
        const high = readNumber({ ...input, value: raiseHigh }, 'USD', ctx);
        const range = low.value !== null && high.value !== null && low.value <= high.value ? [low.value, high.value] : null;
        return {
          point: reading.value,
          range,
          reason: reading.reason,
          strategy: 'up_and_down',
          tier_used: 'tier2_sif_raise_exact',
          strategy_fallback_note: 'SIF 固定精准为空，自动采用同回包「提高和降低（精准）」出价参考（0 网页等待）。',
          limitation: 'SIF up-and-down exact bid used as Tier-2 fallback because fixed exact bid was absent.',
        };
      }
    }
  }

  if (isR59 && source === 'sellersprite') {
    // Tier 3a ss_web real-time requires explicit down_only or fixed strategy (unspecified web scrapes are rejected).
    const allowedSsStrategies = channel === 'ss_web' ? ['fixed', 'down_only'] : ['fixed', 'down_only', 'unspecified'];
    const compatibleSs = input.match_type === 'exact' && allowedSsStrategies.includes(rawStrategy) && marketCurrencyOk;
    if (!compatibleSs) {
      return { point: null, range: null, reason: 'Missing or incompatible exact-match strategy, currency or marketplace.', strategy: rawStrategy };
    }
    const reading = readNumber(input, 'USD', ctx);
    const low = readNumber({ ...input, value: input.low }, 'USD', ctx);
    const high = readNumber({ ...input, value: input.high }, 'USD', ctx);
    const range = low.value !== null && high.value !== null && low.value <= high.value ? [low.value, high.value] : null;
    return {
      point: reading.value,
      range,
      reason: reading.reason,
      strategy: rawStrategy,
      channel,
      tier_used: channel === 'ss_web' ? 'tier3_ss_web_realtime' : 'tier1_ss_exact',
      limitation: rawStrategy === 'unspecified'
        ? 'SellerSprite strategy is unspecified; this is an approximate trial input.'
        : rawStrategy === 'down_only'
          ? 'SellerSprite exact bid uses down-only strategy.'
          : null,
    };
  }

  const strategy = rawStrategy;
  const compatible = input?.match_type === 'exact' &&
    (source === 'sif' ? strategy === 'fixed' : ['fixed', 'unspecified'].includes(strategy)) &&
    marketCurrencyOk;
  if (!compatible) return { point: null, range: null, reason: 'Missing or incompatible exact-match strategy, currency or marketplace.', strategy };
  const reading = readNumber(input, 'USD', ctx);
  const low = readNumber({ ...input, value: input.low }, 'USD', ctx);
  const high = readNumber({ ...input, value: input.high }, 'USD', ctx);
  const range = low.value !== null && high.value !== null && low.value <= high.value ? [low.value, high.value] : null;
  return { point: reading.value, range, reason: reading.reason, strategy,
    limitation: source === 'sellersprite' && strategy === 'unspecified' ? 'SellerSprite strategy is unspecified; this is an approximate trial input.' : null };
}

function scoreBids(item, bids, ctx, profile) {
  const isR59 = profile.revision >= 59;
  const singleEntry = profile.revision >= 55 && bids?.entries?.length === 1;
  const allowEqualEntries = profile.revision >= 56;
  const longTailTerms = isR59 && Array.isArray(bids?.long_tail_opportunistic_terms)
    ? bids.long_tail_opportunistic_terms
      .filter(t => t && typeof t === 'object' && text(t.query))
      .map(t => ({
        query: t.query.trim(),
        volume: number(t.volume) ? t.volume : null,
        note: text(t.note) ? t.note.trim() : '超长尾蓝海捡漏词（仅作投放捡漏参考，不锁死主词竞价 15 分）',
      }))
    : undefined;
  const isParentProxy = isR59 && bids?.entry_scope === 'parent_functional_proxy';
  if (isParentProxy && !text(bids?.proxy_reason)) {
    return missing(item, 'Cold-start parent_functional_proxy requires a nonempty proxy_reason.', bids);
  }
  const r59ScopeMeta = {
    ...(longTailTerms !== undefined ? { long_tail_opportunistic_terms: longTailTerms } : {}),
    ...(isParentProxy ? {
      entry_scope: 'parent_functional_proxy',
      scope_badge: '美亚尚无专属词 · 按上位词参考',
      proxy_reason: bids.proxy_reason.trim(),
    } : {}),
  };

  if (!bids || bids.marketplace !== 'US' || bids.currency !== 'USD' || bids.match_type !== 'exact' ||
    (!singleEntry && !allowEqualEntries && !text(bids.volume_period) && !(isR59 && bids?.unbid_after_all_tiers === true)) ||
    !text(bids.selection_reason) || !hasEvidence(bids.evidence, ctx) ||
    !Array.isArray(bids.entries) || bids.entries.length === 0) {
    return missing(item, bids?.reason ?? (allowEqualEntries
      ? 'A supported main-entry set with US/exact/USD scope is required.'
      : 'A supported main-entry set with common monthly volume and US/exact/USD scope is required.'), bids, r59ScopeMeta);
  }
  if (isR59 && bids.entries.length > 3) {
    return missing(item, 'Revision 59 Tier 1 restricts main purchase entries to 1–3 core/mid-core queries; move peripheral long-tail queries to long_tail_opportunistic_terms.', bids, r59ScopeMeta);
  }
  const queries = new Set();
  let duplicate = false;
  const entries = bids.entries.map(entry => {
    const query = typeof entry?.query === 'string' ? entry.query.trim().replace(/\s+/g, ' ').toLowerCase() : '';
    if (!query || queries.has(query)) duplicate = true;
    queries.add(query);
    const volume = readNumber(entry?.volume, 'searches_per_month', ctx);
    if (entry?.volume?.period && entry.volume.period !== bids.volume_period) {
      volume.value = null;
      volume.reason = 'Entry volume does not use the declared common period.';
    }
    if (allowEqualEntries && !singleEntry && entry?.volume?.value != null && !text(bids.volume_period)) {
      volume.value = null;
      volume.reason = 'Supplied monthly volumes need a declared common period.';
    }
    const sources = Object.fromEntries(['sellersprite', 'sif'].map(source => [source, bidSource(entry?.[source], source, bids, ctx, profile)]));
    // Tier 3a ss_web is strictly a fallback when SIF Tier 1/2 has no usable exact bid.
    const rawUsable = Object.entries(sources).filter(([, value]) => value.point !== null);
    const usable = isR59 && sources.sif.point !== null && sources.sellersprite.channel === 'ss_web'
      ? [['sif', sources.sif]]
      : rawUsable;
    const combined = usable.length ? usable.reduce((sum, [, value]) => sum + value.point / usable.length, 0) : null;
    return { query: entry?.query ?? null, volume: volume.value, volume_reason: volume.reason, sources,
      combined_point: combined, source_label: usable.length === 2 ? 'two_source_mean' : usable.length ? `${usable[0][0]}_only` : 'needs_evidence',
      ...(profile.revision >= 57 && combined !== null && (entry?.low_exposure_baseline === true || text(entry?.low_exposure_note))
        ? { low_exposure_baseline: true, low_exposure_note: text(entry?.low_exposure_note)
          ? entry.low_exposure_note.trim()
          : '周曝光极低或无历史数据，采用原生工具返回的平台基准建议竞价。' }
        : {}) };
  });

  if (isR59 && bids.entries.some((rawE, i) =>
    (rawE?.all_tiers_exhausted === true || rawE?.unbid_after_all_tiers === true) && entries[i]?.combined_point !== null,
  )) {
    return missing(item, 'Entry declares all_tiers_exhausted / unbid_after_all_tiers while supplying a usable exact bid.', bids, r59ScopeMeta);
  }
  if (isR59 && (bids.unbid_after_all_tiers === true || bids.entries.every(e => e?.all_tiers_exhausted === true || e?.unbid_after_all_tiers === true))) {
    if (duplicate) {
      return missing(item, 'Main purchase entries must be unique.', bids, r59ScopeMeta);
    }
    if (entries.some(e => e.combined_point !== null)) {
      return missing(item, 'unbid_after_all_tiers: true conflicts with usable exact bid observations present on one or more entries.', bids, r59ScopeMeta);
    }
    return scored(item, 0, bids, {
      ...r59ScopeMeta,
      entries,
      range_scenarios: { sellersprite: null, sif: null },
      reference_bid_usd: null,
      aggregation_method: 'unbid_after_all_tiers_deduct_15',
      unbid_after_all_tiers: true,
      deduction_note: '三级递进全工具补查后仍无可用精准竞价，按规则扣减本项 15 分（记 0/15，不锁死整张卡）。',
      evidence: mergeRefs(bids.evidence, ...bids.entries.flatMap(entry => [entry?.volume?.evidence, entry?.sellersprite?.evidence, entry?.sif?.evidence])),
    });
  }
  const totalVolume = entries.reduce((sum, entry) => sum + (entry.volume ?? 0), 0);
  const validVolumes = entries.every(entry => entry.volume !== null) && number(totalVolume) && totalVolume > 0;
  const allPoints = entries.every(entry => entry.combined_point !== null);
  const absentVolumes = bids.entries.map(entry => (entry?.volume == null ||
    (typeof entry.volume === 'object' && !Array.isArray(entry.volume) && entry.volume.value == null)) &&
    entry?.volume?.supported !== false && entry?.volume?.material_conflict !== true);
  const equalEntries = allowEqualEntries && !singleEntry && !duplicate && allPoints && absentVolumes.some(Boolean) &&
    entries.every((entry, index) => entry.volume !== null || absentVolumes[index]);
  const rangeScenarios = Object.fromEntries(['sellersprite', 'sif'].map(source => {
    if (duplicate || (!singleEntry && !validVolumes && !equalEntries) || entries.some(entry => !entry.sources[source].range)) return [source, null];
    const range = singleEntry ? [...entries[0].sources[source].range]
      : [0, 1].map(i => entries.reduce((sum, entry) => sum +
        (equalEntries ? 1 / entries.length : entry.volume / totalVolume) * entry.sources[source].range[i], 0));
    return [source, { source, bid_range_usd: range,
      score_range: [numericScore(item, range[1]), numericScore(item, range[0])], interpretation: 'Source-labeled range scenario; not the main score or actual CPC.' }];
  }));
  const extra = { ...r59ScopeMeta, entries, range_scenarios: rangeScenarios, reference_bid_usd: null,
    ...(profile.revision >= 55 ? { aggregation_method: allowEqualEntries && duplicate ? null : singleEntry ? 'single_main_entry' : equalEntries
      ? 'equal_main_entries' : allowEqualEntries && !validVolumes ? null : 'monthly_search_weighted' } : {}),
    ...(equalEntries ? { aggregation_reason: 'Monthly search volume is missing; every main entry has a usable exact point. Equal entry weights do not establish equal demand.' } : {}),
    evidence: mergeRefs(bids.evidence, ...bids.entries.flatMap(entry => [entry?.volume?.evidence, entry?.sellersprite?.evidence, entry?.sif?.evidence])) };
  if (duplicate) return missing(item, 'Main-entry queries must be nonempty and deduplicated before scoring.', bids, extra);
  if (allowEqualEntries && !allPoints) return missing(item, 'A required main-entry native exact point is missing from both usable sources.', bids, extra);
  if (!singleEntry && !validVolumes && !equalEntries) return missing(item, allowEqualEntries
    ? 'Supplied monthly volumes need valid compatible evidence and a positive total; equal weighting only resolves missing volume.'
    : 'Every selected entry needs supported monthly volume and the total must be positive.', bids, extra);
  if (!allPoints) return missing(item, 'A required main-entry native exact point is missing from both usable sources.', bids, extra);
  const reference = singleEntry ? entries[0].combined_point
    : entries.reduce((sum, entry) => sum +
      (equalEntries ? 1 / entries.length : entry.volume / totalVolume) * entry.combined_point, 0);
  if (!number(reference)) return missing(item, 'The weighted bid reference is not finite.', bids, extra);
  return scored(item, numericScore(item, reference), bids, { ...extra, reference_bid_usd: reference });
}

function collectNestedObjects(root, maxDepth = 6) {
  const out = [];
  const seen = new Set();
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node) || depth > maxDepth) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
    } else {
      out.push(node);
      for (const val of Object.values(node)) {
        if (val && typeof val === 'object') stack.push({ node: val, depth: depth + 1 });
      }
    }
  }
  return out;
}

function hasNon30DayWindowParam(roots) {
  for (const root of roots) {
    for (const bag of collectNestedObjects(root)) {
      for (const key of ['timePieceValue', 'time_piece_value']) {
        const tpv = bag[key];
        if (tpv !== undefined && tpv !== null && String(tpv).trim() !== '30') return `${key}="${tpv}"`;
      }
      for (const key of ['timePieceType', 'time_piece_type']) {
        const tpt = bag[key];
        if (tpt !== undefined && tpt !== null && String(tpt).trim() !== 'latelyDay') return `${key}="${tpt}"`;
      }
      for (const key of ['lastDays', 'last_days']) {
        const ld = bag[key];
        if (ld !== undefined && ld !== null && Number(ld) !== 30) return `${key}=${ld}`;
      }
      for (const key of ['window_days', 'windowDays']) {
        const wd = bag[key];
        if (wd !== undefined && wd !== null && Number(wd) !== 30) return `${key}=${wd}`;
      }
    }
  }
  return null;
}

const SIF_REQUEST_WRAPPER_KEYS = ['request', 'params', 'arguments', 'query_params'];
const SIF_LISTING_TOOL_RE = /(ops_get_listing_traffic_overview|ops_get_listing_traffic_structure|ops_get_listing_keyword_distribution)/i;
const SIF_TREND_TOOL_RE = /(ops_get_asin_traffic_trend)/i;
const STRUCTURED_TOOL_KEYS = ['tool', 'endpoint', 'source_tool', 'api', 'method', 'operation'];
const DESCRIPTIVE_TOOL_KEYS = ['source', 'scope'];

function findMissingSif30DayParam(input, citedEv) {
  const reqSubtrees = [];
  const collectReqSubtrees = (root, allowSelfFlat) => {
    if (!root || typeof root !== 'object') return;
    let foundWrapper = false;
    for (const k of SIF_REQUEST_WRAPPER_KEYS) {
      if (root[k] && typeof root[k] === 'object' && !Array.isArray(root[k])) {
        reqSubtrees.push(root[k]);
        foundWrapper = true;
      }
    }
    if (!foundWrapper && allowSelfFlat) {
      const hasSifReqSignal = ['timePieceType', 'time_piece_type', 'isListingSearch', 'listingSearch', 'granularity'].some(k => root[k] !== undefined) ||
        STRUCTURED_TOOL_KEYS.some(k => typeof root[k] === 'string' && (SIF_LISTING_TOOL_RE.test(root[k]) || SIF_TREND_TOOL_RE.test(root[k])));
      if (hasSifReqSignal) reqSubtrees.push(root);
    }
  };
  collectReqSubtrees(input, false);
  for (const ev of citedEv) collectReqSubtrees(ev, true);

  for (const reqRoot of reqSubtrees) {
    const bags = collectNestedObjects(reqRoot);
    const isTrend = bags.some(b =>
      b.granularity !== undefined || b.listingSearch !== undefined ||
      STRUCTURED_TOOL_KEYS.some(k => typeof b[k] === 'string' && SIF_TREND_TOOL_RE.test(b[k])));
    if (isTrend) {
      const hasExplicitLast30 = bags.some(b => Number(b.lastDays) === 30 || Number(b.last_days) === 30);
      if (!hasExplicitLast30) return 'omitted lastDays=30 (SIF trend request)';
    } else {
      const hasExplicit30 = bags.some(b =>
        (b.timePieceValue !== undefined && b.timePieceValue !== null && String(b.timePieceValue).trim() === '30') ||
        (b.time_piece_value !== undefined && b.time_piece_value !== null && String(b.time_piece_value).trim() === '30'));
      if (!hasExplicit30) return 'omitted timePieceValue="30" (SIF defaults to 7 days)';
    }
  }
  return null;
}

function scoreNatural(member, ctx, profile, cohortPeriod = null, cohortGrain = null) {
  const input = member.natural;
  const validSubjects = profile.revision >= 58
    ? [member.family_id, member.asin, member.parent_asin, member.representative_asin].filter(text).map(s => s.trim())
    : [member.family_id, member.asin];
  const subjectOk = !input?.subject || (profile.revision >= 58
    ? (text(input.subject) && validSubjects.includes(input.subject.trim()))
    : validSubjects.includes(input.subject));
  if (input?.scope !== 'overall' || !text(input.period) || !hasEvidence(input.relevant_entries_evidence, ctx) ||
    (input.provider && input.provider !== 'sif') || !subjectOk) {
    return { score: null, reason: input?.reason ?? 'A SIF overall share needs identified period, subject and relevant-entry evidence.', input };
  }
  if (profile.revision >= 58) {
    if (cohortPeriod !== null && (input.period !== cohortPeriod || (input.window_days !== undefined && input.window_days !== 30))) {
      return { score: null, reason: 'Natural visibility period must align with the cohort latest-30-day period.', input };
    }
    if (input.source !== undefined && !/\bsif\b/i.test(String(input.source))) {
      return { score: null, reason: 'Natural visibility exposure share must be sourced from SIF, not SellerSprite alone.', input };
    }
    const citedEv = (Array.isArray(input.evidence) ? input.evidence : []).map(id => ctx.evidence.get(id)).filter(Boolean);
    const badWin = hasNon30DayWindowParam([input, ...citedEv]) ?? findMissingSif30DayParam(input, citedEv);
    if (badWin) {
      return { score: null, reason: `SIF natural visibility request must use an explicit 30-day window, not ${badWin}.`, input };
    }
    const kwDistRe = /(ops_get_listing_keyword_distribution|keyword_distribution|关键词数量分布|词数分布)/i;
    const overviewRe = /(ops_get_listing_traffic_overview|traffic_overview|曝光占比|traffic_structure)/i;
    const extractKeys = (objs, keys) => objs
      .flatMap(b => keys.map(k => b[k]))
      .filter(v => typeof v === 'string' && v.trim().length > 0);
    const inputObjs = collectNestedObjects(input);
    const citedObjs = citedEv.flatMap(e => collectNestedObjects(e));
    const inputStructured = extractKeys(inputObjs, STRUCTURED_TOOL_KEYS);
    const inputDescriptive = extractKeys(inputObjs, DESCRIPTIVE_TOOL_KEYS);
    const citedStructured = extractKeys(citedObjs, STRUCTURED_TOOL_KEYS);
    const citedDescriptive = extractKeys(citedObjs, DESCRIPTIVE_TOOL_KEYS);
    // Structured tool/endpoint fields take strict precedence over free-text scope/source descriptions.
    const inputToolTexts = inputStructured.length > 0 ? inputStructured : inputDescriptive;
    const citedToolTexts = citedStructured.length > 0 ? citedStructured : citedDescriptive;
    if (inputToolTexts.some(s => kwDistRe.test(s)) && !inputToolTexts.some(s => overviewRe.test(s))) {
      return { score: null, reason: 'Natural visibility 1-point item requires SIF traffic-overview exposure share, not keyword-count distribution alone.', input };
    }
    if (citedToolTexts.some(s => kwDistRe.test(s)) && !citedToolTexts.some(s => overviewRe.test(s))) {
      return { score: null, reason: 'Cited SIF evidence records keyword-count distribution without traffic-overview exposure share.', input };
    }
    const hasExplicitSifEv = citedEv.some(e => /\bsif\b/i.test(`${e.provider ?? ''} ${e.source ?? ''}`));
    const hasExplicitSsOnlyEv = citedEv.some(e => /(sellersprite|卖家精灵)/i.test(`${e.provider ?? ''} ${e.source ?? ''}`) && !/\bsif\b/i.test(`${e.provider ?? ''} ${e.source ?? ''}`));
    if (hasExplicitSsOnlyEv && !hasExplicitSifEv) {
      return { score: null, reason: 'Natural visibility exposure share requires SIF evidence and cannot rely solely on SellerSprite.', input };
    }
    if (input.keyword_counts && typeof input.keyword_counts === 'object' &&
      input.keyword_counts.sellersprite !== undefined && input.keyword_counts.sif === undefined && input.provider !== 'sif') {
      return { score: null, reason: 'Natural visibility exposure share requires SIF traffic evidence rather than SellerSprite-only counts.', input };
    }
    const viewGrain = typeof (input.view_grain ?? input.grain ?? input.view) === 'string'
      ? (input.view_grain ?? input.grain ?? input.view).trim().toLowerCase()
      : null;
    const nestedBags = collectNestedObjects(input).concat(citedEv.flatMap(e => collectNestedObjects(e)));
    if (cohortGrain === 'parent_units' || cohortGrain === 'family') {
      if (nestedBags.some(b => b.isListingSearch === false || b.listingSearch === false) ||
        (viewGrain && ['child', 'child_asin', 'variant', 'single_asin', 'asin'].includes(viewGrain))) {
        return { score: null, reason: 'Parent/family cohort grain requires parent-aggregated SIF view (isListingSearch: true), not a child-ASIN view.', input };
      }
    } else if (cohortGrain === 'family_representative' || cohortGrain === 'target_child_units') {
      if (nestedBags.some(b => b.isListingSearch === true || b.listingSearch === true) ||
        (viewGrain && ['parent', 'parent_units', 'family'].includes(viewGrain))) {
        return { score: null, reason: `${cohortGrain} cohort grain conflicts with a parent-aggregated SIF view.`, input };
      }
    }
  }
  const reading = readNumber(input, 'fraction', ctx, { max: 1 });
  const counts = Object.fromEntries(['sellersprite', 'sif'].map(source => [source,
    Object.fromEntries(['organic', 'ad'].map(channel => [channel,
      readNumber(input.keyword_counts?.[source]?.[channel], 'count', ctx, { integer: true }).value]))]));
  const ssOrg = counts.sellersprite.organic;
  const ssAd = counts.sellersprite.ad;
  const coverageExposureMismatch = profile.revision >= 58 && reading.value !== null && ssOrg !== null &&
    reading.value < 0.35 &&
    (ssOrg >= 50 || (ssOrg >= 20 && ssAd !== null && ssOrg >= ssAd * 1.5));
  return {
    score: reading.value === null ? null : Math.min(reading.value / profile.measurement.newcomer_natural_visibility_example_score.full_points_at, 1),
    reason: reading.reason, input, keyword_counts: counts,
    source_label: Object.values(counts.sellersprite).some(value => value !== null) ? 'sif_with_sellersprite_corroboration' : 'sif_only',
    ...(coverageExposureMismatch ? {
      coverage_exposure_mismatch: true,
      coverage_exposure_diagnosis: '覆盖广、曝光弱：SellerSprite 收录自然词数较多，但 SIF 近30天自然曝光占比偏低（仅反映口径与曝光不匹配，具体自然坑位与广告结构须结合核心词排名及流量结构进一步核实）。',
    } : {}),
  };
}

function scoreNewcomers(cohort, ctx, profile, defs) {
  if (profile.revision >= 58) return scoreNewcomersR58(cohort, ctx, profile, defs);
  const lowDef = defs.find(item => item.id === 'low_rating_sales_performance');
  const naturalDef = defs.find(item => item.id === 'natural_visibility_development');
  const diagnostics = { members: [], examples: [], selected_pair: [], references: { rating_median: null, sales_median: null },
    reference_mode: profile.revision >= 51 ? `current_category_r${profile.revision}` : 'qualified_cohort_r50' };
  const pending = reason => ({
    low: missing(lowDef, reason, cohort), natural: missing(naturalDef, reason, cohort), diagnostics,
  });
  if (!cohort || cohort.reference_supported !== true || cohort.observation_basis !== 'current_latest_30_days' ||
    !['observation_date', 'period', 'niche', 'grain', 'relevant_bsr_node'].every(key => text(cohort[key])) ||
    !validDate(cohort.observation_date) || !hasEvidence(cohort.evidence, ctx) || !Array.isArray(cohort.members)) {
    diagnostics.members = Array.isArray(cohort?.members) ? cohort.members : [];
    return pending(cohort?.reason ?? 'A supported current/latest-30-day comparable normal-newcomer reference is required.');
  }
  let invalidReference = false;
  const qualified = [];
  for (const member of cohort.members) {
    const record = { ...member, effective_status: member?.status ?? 'pending' };
    if (profile.revision >= 51 && record.effective_status === 'duplicate') record.effective_status = 'pending';
    diagnostics.members.push(record);
    if (member?.old_reviews_predate_launch === true) {
      record.effective_status = hasEvidence(member.evidence, ctx) ? 'excluded' : 'pending';
      record.reason = record.effective_status === 'excluded' ? 'Supported old reviews predate the purported recent launch; excluded from the normal-start reference.' :
        'The asserted old-review conflict lacks valid evidence references.';
    }
    if (record.effective_status !== 'qualified') continue;
    if (!text(member.family_id) || !text(member.asin) || !text(member.reason) || !hasEvidence(member.evidence, ctx)) {
      invalidReference = true;
      record.effective_status = 'pending';
      record.reason = 'A qualified member needs frozen family/listing identity and qualification evidence.';
      continue;
    }
    if (profile.revision >= 51) {
      const observed = new Date(`${cohort.observation_date.slice(0, 10)}T00:00:00Z`);
      const earliest = new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() - 3,
        Math.min(observed.getUTCDate(), new Date(Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() - 2, 0)).getUTCDate())));
      const earliestDate = earliest.toISOString().slice(0, 10);
      if (!validDate(member.launch_date) ||
        (profile.revision >= 57 ? member.launch_date.slice(0, 10) < earliestDate : Date.parse(member.launch_date) < earliest.getTime()) ||
        member.launch_date.slice(0, 10) > cohort.observation_date.slice(0, 10) ||
        member.current_bsr_node !== cohort.relevant_bsr_node || !Number.isInteger(member.current_bsr_rank) ||
        member.current_bsr_rank < 1 || member.current_bsr_rank > 100) {
        record.effective_status = 'pending';
        record.reason = 'A qualified current example needs matching rank 1-100 and a supported launch within three calendar months.';
        continue;
      }
    }
    qualified.push(record);
  }
  qualified.sort(compareIdentity);
  const groups = [];
  for (const member of qualified) {
    const matches = groups.filter(group => group.some(existing => existing.family_id === member.family_id || existing.asin === member.asin ||
      (text(member.shared_launch_id) && existing.shared_launch_id === member.shared_launch_id)));
    if (matches.length === 0) groups.push([member]);
    else {
      const target = matches[0];
      target.push(member);
      for (const merged of matches.slice(1)) {
        target.push(...merged);
        groups.splice(groups.indexOf(merged), 1);
      }
    }
  }
  const unique = [];
  for (const group of groups) {
    group.sort(compareIdentity);
    const existing = group[0];
    unique.push(existing);
    for (const member of group.slice(1)) {
      member.effective_status = 'duplicate';
      member.duplicate_of = { family_id: existing.family_id, asin: existing.asin };
      if (member.ratings?.value !== existing.ratings?.value || member.units_30d?.value !== existing.units_30d?.value) {
        invalidReference = true;
        member.reason = 'Duplicated family/shared-launch records have incompatible current observations.';
      }
    }
  }
  diagnostics.observed_count = cohort.members.length;
  diagnostics.qualified_deduplicated_count = unique.length;
  if (invalidReference) return pending('Qualified identity, grouping or duplicate observations remain unresolved.');
  if (profile.revision >= 51) return scoreCurrentNewcomers(cohort, unique, ctx, profile, lowDef, naturalDef, diagnostics, pending);
  if (unique.length === 0) return pending('No supported qualified normal-newcomer reference member is available.');
  const readings = unique.map(member => ({ member,
    ratings: readNumber(member.ratings, 'count', ctx, { integer: true }),
    units: readNumber(member.units_30d, 'units', ctx), natural: scoreNatural(member, ctx, profile),
  }));
  const ratingMedian = readings.every(row => row.ratings.value !== null) ? median(readings.map(row => row.ratings.value)) : null;
  const salesMedian = readings.every(row => row.units.value !== null) ? median(readings.map(row => row.units.value)) : null;
  diagnostics.references = { rating_median: ratingMedian, sales_median: salesMedian,
    ratings: readings.map(row => row.ratings.value), sales_units: readings.map(row => row.units.value) };
  const actual = profile.measurement.low_rating_actual_count_component;
  const salesCap = profile.measurement.low_rating_sales_cap;
  const lowerAnchor = salesCap.confirmed_anchor;
  const upperAnchor = salesCap.confirmed_middle_segment.endpoints[1];
  diagnostics.examples = readings.map(({ member, ratings, units, natural }) => {
    const r = ratings.value;
    const actualScore = r === null ? null : r <= actual.above_40_mapping.continuity_anchor.rating_count ?
      (r <= actual.full_points_through ? actual.component_max_points : actual.component_max_points - actual.decrease_per_additional_rating_above_10 * (r - actual.full_points_through)) :
      actual.above_40_mapping.continuity_anchor.points * actual.above_40_mapping.continuity_anchor.rating_count / r;
    const relative = r !== null && ratingMedian > 0 ? (r <= ratingMedian ? 1 : ratingMedian / r) : null;
    const ratio = units.value !== null && salesMedian > 0 ? units.value / salesMedian : null;
    const ceiling = ratio === null ? null : ratio <= lowerAnchor.sales_ratio ? lowerAnchor.max_points * ratio / lowerAnchor.sales_ratio :
      ratio < upperAnchor.sales_ratio ? lowerAnchor.max_points + (upperAnchor.max_points - lowerAnchor.max_points) *
        (ratio - lowerAnchor.sales_ratio) / (upperAnchor.sales_ratio - lowerAnchor.sales_ratio) : salesCap.item_max_points;
    return { family_id: member.family_id, asin: member.asin, actual_score: actualScore, relative_score: relative,
      sales_ratio: ratio, sales_ceiling: ceiling, natural,
      score: actualScore !== null && relative !== null && ceiling !== null ? Math.min(actualScore + relative, ceiling) : null,
      reason: ratingMedian === 0 ? 'True-zero rating median leaves the relative component unscored.' :
        salesMedian === 0 ? 'True-zero sales median supplies no sales ratio.' : ratings.reason ?? units.reason,
    };
  });
  const complete = diagnostics.examples.filter(example => example.score !== null)
    .sort((a, b) => b.score - a.score || compareIdentity(a, b));
  if (complete.length < 2) return pending(complete.length === 1 ? 'One complete example is single-case evidence, not a direction score.' :
    'Two complete qualified examples require supported full-cohort rating and positive sales references.');
  const pair = complete.slice(0, 2);
  diagnostics.selected_pair = pair.map(({ family_id, asin }) => ({ family_id, asin }));
  const lowEvidence = mergeRefs(cohort.evidence, ...unique.flatMap(member => [member.evidence, member.ratings?.evidence, member.units_30d?.evidence]));
  const naturalEvidence = mergeRefs(lowEvidence, ...pair.flatMap(example => [example.natural.input?.evidence, example.natural.input?.relevant_entries_evidence]));
  const low = scored(lowDef, pair[0].score / 2 + pair[1].score / 2, cohort, { selected_pair: diagnostics.selected_pair, evidence: lowEvidence });
  const naturalScores = pair.map(example => example.natural.score);
  let natural;
  if (naturalScores.every(value => value !== null)) {
    natural = scored(naturalDef, naturalScores[0] / 2 + naturalScores[1] / 2, cohort, { selected_pair: diagnostics.selected_pair, evidence: naturalEvidence });
  } else {
    const known = naturalScores.filter(value => value !== null);
    natural = missing(naturalDef, 'The fixed low-rating pair lacks supported SIF overall share evidence for one or both members.', cohort,
      { selected_pair: diagnostics.selected_pair, evidence: naturalEvidence,
        conditional_range: known.length === 1 ? [known[0] / 2, (known[0] + 1) / 2] : null });
  }
  return { low, natural, diagnostics };
}

function scoreCurrentNewcomers(cohort, unique, ctx, profile, lowDef, naturalDef, diagnostics, pending) {
  diagnostics.reference_mode = `current_category_r${profile.revision}`;
  diagnostics.selection_tie_policy = profile.revision >= 52 ? 'complete_score_before_unresolved_equal_bound' : 'stable_identity';
  if (cohort.scope !== 'current_relevant_bsr_top100' || cohort.query_complete !== true) {
    return pending('A completed current-category query and aligned all-age sales reference are required.');
  }
  const unresolvedMembers = diagnostics.members.filter(row => !['qualified', 'duplicate'].includes(row.effective_status) &&
    !(row.effective_status === 'excluded' && text(row.reason) && hasEvidence(row.evidence, ctx)));
  if (!unique.length && !unresolvedMembers.length) {
    diagnostics.no_qualifying_examples = true;
    const evidence = mergeRefs(cohort.evidence, ...diagnostics.members.map(row => row.evidence));
    return { low: scored(lowDef, 0, cohort, { evidence }), natural: scored(naturalDef, 0, cohort, { evidence }), diagnostics };
  }
  const reference = cohort.market_reference;
  if (reference?.scope !== 'current_relevant_bsr_top100_all_ages' || reference.node !== cohort.relevant_bsr_node ||
    reference.period !== cohort.period || reference.grain !== cohort.grain || reference.deduplicated !== true ||
    reference.coverage_supported !== true || !hasEvidence(reference.evidence, ctx) ||
    !Array.isArray(reference.families) || reference.families.length === 0) {
    return pending('A completed current-category query and aligned all-age sales reference are required.');
  }
  const ids = reference.families.map(row => row?.family_id);
  const sales = reference.families.map(row => readNumber(row?.units_30d, 'units', ctx));
  if (ids.some(id => !text(id)) || new Set(ids).size !== ids.length || sales.some(row => row.value === null)) {
    return pending('All-age reference families need unique identities and supported sales, including real zeros.');
  }
  const benchmark = median(sales.map(row => row.value));
  diagnostics.references = { sales_median: benchmark, family_count: ids.length, grain: reference.grain,
    scope: reference.scope, sales_units: sales.map(row => row.value) };
  const calculate = member => {
    const ratings = readNumber(member.ratings, 'count', ctx, { integer: true });
    const units = readNumber(member.units_30d, 'units', ctx);
    const r = ratings.value;
    const { actual_rating_points: a, sales_cap: s } = profile.measurement.current_category_newcomers;
    const actualScore = r === null ? null : r <= a.full_points_through ? a.max_points : r <= a.linear_end_rating ?
      a.max_points - (r - a.full_points_through) * (a.max_points - a.linear_end_points) / (a.linear_end_rating - a.full_points_through) :
      a.linear_end_points * a.linear_end_rating / r;
    const ratio = units.value !== null && benchmark > 0 ? units.value / benchmark : null;
    const ceiling = units.value === 0 ? 0 : ratio === null ? null : ratio <= s.lower_ratio ? s.lower_points * ratio / s.lower_ratio :
      ratio < s.upper_ratio ? s.lower_points + (s.max_points - s.lower_points) * (ratio - s.lower_ratio) / (s.upper_ratio - s.lower_ratio) : s.max_points;
    return { family_id: member.family_id, asin: member.asin, actual_score: actualScore, sales_ratio: ratio,
      sales_ceiling: ceiling, natural: scoreNatural(member, ctx, profile),
      score: actualScore !== null && ceiling !== null ? Math.min(actualScore, ceiling) : null,
      possible_upper: Math.min(actualScore ?? 4, ceiling ?? 4),
      reason: ratings.reason ?? units.reason ?? (ceiling === null ? 'A positive category sales reference is required for positive sales.' : null) };
  };
  diagnostics.examples = unique.map(calculate);
  const complete = diagnostics.examples.filter(row => row.score !== null)
    .sort((a, b) => b.score - a.score || compareIdentity(a, b));
  const pair = complete.slice(0, 2);
  const unresolved = [
    ...diagnostics.examples.filter(row => row.score === null),
    ...unresolvedMembers.map(calculate),
  ];
  const couldDisplace = row => pair.length < 2 || row.possible_upper > pair[1].score ||
    (profile.revision === 51 && row.possible_upper === pair[1].score &&
      (!text(row.family_id) || !text(row.asin) || compareIdentity(row, pair[1]) < 0));
  diagnostics.unresolved_possible_examples = unresolved.map(row => ({ family_id: row.family_id, asin: row.asin,
    possible_upper: row.possible_upper, selection_blocking: couldDisplace(row) }));
  if (unresolved.some(couldDisplace)) {
    return pending('An unresolved observed newcomer could change the selected examples.');
  }
  diagnostics.selected_pair = pair.map(({ family_id, asin }) => ({ family_id, asin }));
  diagnostics.no_qualifying_examples = pair.length === 0;
  const evidence = mergeRefs(cohort.evidence, reference.evidence, ...reference.families.map(row => row.units_30d?.evidence),
    ...unique.flatMap(member => [member.evidence, member.ratings?.evidence, member.units_30d?.evidence]));
  const low = pair.length ? scored(lowDef, pair.reduce((sum, row) => sum + row.score / pair.length, 0), cohort,
    { selected_pair: diagnostics.selected_pair, evidence }) : scored(lowDef, 0, cohort, { evidence });
  const naturalScores = pair.map(row => row.natural.score);
  const knownNatural = naturalScores.filter(value => value !== null);
  const knownTotal = knownNatural.reduce((sum, value) => sum + value, 0);
  const naturalEvidence = mergeRefs(evidence, ...pair.flatMap(row => [row.natural.input?.evidence, row.natural.input?.relevant_entries_evidence]));
  const natural = naturalScores.every(value => value !== null) ? scored(naturalDef,
    pair.length ? naturalScores.reduce((sum, value) => sum + value / pair.length, 0) : 0, cohort,
    { selected_pair: diagnostics.selected_pair, evidence: naturalEvidence }) :
    missing(naturalDef, 'The fixed current-category examples lack supported SIF overall shares.', cohort,
      { selected_pair: diagnostics.selected_pair, evidence: naturalEvidence,
        conditional_range: knownNatural.length ? [knownTotal / pair.length, (knownTotal + pair.length - knownNatural.length) / pair.length] : null });
  return { low, natural, diagnostics };
}

function evalExampleRat(ratingsVal, unitsVal, tEffRat, profile) {
  const { actual_rating_points: a, sales_cap: s } = profile.measurement.current_category_newcomers;
  let actualRat = null;
  if (ratingsVal !== null) {
    const r = BigInt(ratingsVal);
    const fullThrough = BigInt(a.full_points_through);
    const linEnd = BigInt(a.linear_end_rating);
    const maxPts = ratFromNumber(a.max_points);
    const linEndPts = ratFromNumber(a.linear_end_points);
    if (r <= fullThrough) actualRat = maxPts;
    else if (r <= linEnd) {
      // max_points - (r - fullThrough) * (max_points - linEndPts) / (linEnd - fullThrough)
      actualRat = ratSub(maxPts, ratDiv(ratMul(rat(r - fullThrough, 1n), ratSub(maxPts, linEndPts)), rat(linEnd - fullThrough, 1n)));
    } else {
      actualRat = ratDiv(ratMul(linEndPts, rat(linEnd, 1n)), rat(r, 1n));
    }
  }
  let ratioRat = null;
  let ceilingRat = null;
  if (unitsVal !== null) {
    const uRat = ratFromNumber(unitsVal);
    if (uRat.n === 0n) {
      ratioRat = rat(0n, 1n);
      ceilingRat = rat(0n, 1n);
    } else if (tEffRat && tEffRat.n > 0n) {
      ratioRat = ratDiv(uRat, tEffRat);
      const lowR = ratFromNumber(s.lower_ratio);
      const upR = ratFromNumber(s.upper_ratio);
      const lowP = ratFromNumber(s.lower_points);
      const maxP = ratFromNumber(s.max_points);
      if (ratCmp(ratioRat, lowR) <= 0) {
        ceilingRat = ratDiv(ratMul(lowP, ratioRat), lowR);
      } else if (ratCmp(ratioRat, upR) < 0) {
        ceilingRat = ratAdd(lowP, ratDiv(ratMul(ratSub(maxP, lowP), ratSub(ratioRat, lowR)), ratSub(upR, lowR)));
      } else {
        ceilingRat = maxP;
      }
    }
  }
  const eRat = actualRat && ceilingRat ? ratMin(actualRat, ceilingRat) : null;
  return { actualRat, ratioRat, ceilingRat, eRat };
}

/**
 * Exact BigInt rational greedy optimizer for Revision 58 Q31 4-point objective:
 * F(S) = (sum_{x in S} e_x) / max(|S|, 2), with mandatory full-month set M_full
 * and optional positive-score ramp-up set M_ramp. Strictly improving additions only
 * (ties stop at the shortest prefix).
 */
export function evalGreedyFRat(fullMonthItems, rampUpItems) {
  const selected = [...fullMonthItems];
  let sum = fullMonthItems.reduce((acc, item) => ratAdd(acc, item.e_rat), rat(0n, 1n));
  let count = fullMonthItems.length;
  const fOf = (sRat, cnt) => cnt === 0 ? rat(0n, 1n) : ratDiv(sRat, rat(BigInt(Math.max(cnt, 2)), 1n));
  const sortedRamp = [...rampUpItems]
    .filter(item => item.e_rat && item.e_rat.n > 0n)
    .sort((a, b) => ratCmp(b.e_rat, a.e_rat) || compareIdentityTrimmed(a, b) || compareIdentity(a, b));
  const rejected = [];
  let stopped = false;
  for (const u of sortedRamp) {
    if (stopped) { rejected.push(u); continue; }
    const curF = fOf(sum, count);
    const nextSum = ratAdd(sum, u.e_rat);
    const nextCount = count + 1;
    const nextF = fOf(nextSum, nextCount);
    if (ratCmp(nextF, curF) > 0) {
      selected.push(u);
      sum = nextSum;
      count = nextCount;
    } else {
      stopped = true;
      rejected.push(u);
    }
  }
  return {
    selected,
    rejected_ramp_up: rejected,
    f_rat: fOf(sum, count),
    denominator: count === 0 ? 0 : Math.max(count, 2),
  };
}

/**
 * Closed-form O(N log N) exact BigInt rational bounds [low_min, low_max] for the 4-point
 * Q31 objective across all 2^|U| possible normal-start/excluded worlds for unsampled candidates.
 */
export function computeStratifiedBoundsRat(vFullRats, vRampRats, uFullRats, uRampRats) {
  const zero = rat(0n, 1n);
  const fOf = (sRat, cnt) => cnt === 0 ? zero : ratDiv(sRat, rat(BigInt(Math.max(cnt, 2)), 1n));

  // Upper bound low_max: every unsampled item (full-month or ramp-up) is optional.
  const maxOptional = [...vRampRats, ...uFullRats, ...uRampRats]
    .filter(r => r.n > 0n)
    .sort((a, b) => ratCmp(b, a));
  let maxSum = vFullRats.reduce((acc, r) => ratAdd(acc, r), zero);
  let maxCnt = vFullRats.length;
  for (const r of maxOptional) {
    const curF = fOf(maxSum, maxCnt);
    const nextF = fOf(ratAdd(maxSum, r), maxCnt + 1);
    if (ratCmp(nextF, curF) > 0) {
      maxSum = ratAdd(maxSum, r);
      maxCnt += 1;
    } else break;
  }
  const lowMax = fOf(maxSum, maxCnt);

  // Lower bound low_min: unsampled <30d excluded; for each r in 0..|U_full|, take r smallest
  // U_full items and binary-search optimal prefix of V_ramp in O(log |V_ramp|).
  const vRampDesc = [...vRampRats].filter(r => r.n > 0n).sort((a, b) => ratCmp(b, a));
  const m = vRampDesc.length;
  const pPref = [zero];
  for (let i = 0; i < m; i++) pPref.push(ratAdd(pPref[i], vRampDesc[i]));

  const uFullAsc = [...uFullRats].sort(ratCmp);
  const k = uFullAsc.length;
  const qPref = [zero];
  for (let i = 0; i < k; i++) qPref.push(ratAdd(qPref[i], uFullAsc[i]));

  const baseSum = vFullRats.reduce((acc, r) => ratAdd(acc, r), zero);
  const baseCnt = vFullRats.length;

  let lowMin = null;
  for (let r = 0; r <= k; r++) {
    const sR = ratAdd(baseSum, qPref[r]);
    const cR = baseCnt + r;
    const pLo = Math.min(m, Math.max(0, 2 - cR));
    let lo = pLo, hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const lhs = ratMul(vRampDesc[mid], rat(BigInt(cR + mid), 1n));
      const rhs = ratAdd(sR, pPref[mid]);
      if (ratCmp(lhs, rhs) > 0) lo = mid + 1;
      else hi = mid;
    }
    const totalSum = ratAdd(sR, pPref[lo]);
    const totalCnt = cR + lo;
    const fVal = fOf(totalSum, totalCnt);
    if (lowMin === null || ratCmp(fVal, lowMin) < 0) lowMin = fVal;
  }

  return [lowMin ?? zero, lowMax];
}

/**
 * Deterministic 5-quintile stratification with lower-midpoint selection, in-stratum
 * distance-from-center replacement, and nearest-stratum borrowing for N_active > 5.
 */
export function selectStratifiedNewcomers(pool) {
  if (!Array.isArray(pool)) throw new TypeError('Stratification pool array is required.');
  const normalized = pool.map(item => ({
    ...item,
    e_rat: item.e_rat ?? ratFromNumber(item.provisional_e ?? item.score ?? 0),
    units_num: number(item.units_30d?.value) ? item.units_30d.value : (number(item.units_30d) ? item.units_30d : 0),
  }));
  normalized.sort((a, b) => ratCmp(b.e_rat, a.e_rat) || (b.units_num - a.units_num) || compareIdentityTrimmed(a, b) || compareIdentity(a, b));
  const N = normalized.length;
  if (N <= 5) {
    const blocked = normalized.some(x => x.pending_identity === true);
    const excluded = normalized.filter(x => x.excluded === true);
    const selected = normalized.filter(x => !x.excluded && !x.pending_identity);
    return { stratified: false, pool_size: N, blocked, selected, unsampled: [], excluded, strata: [] };
  }

  const strata = [];
  for (let k = 0; k < 5; k++) {
    const lo = Math.floor((k * N) / 5);
    const hi = Math.floor(((k + 1) * N) / 5);
    const mid = Math.floor((lo + hi - 1) / 2);
    const order = [];
    for (let i = lo; i < hi; i++) order.push(i);
    order.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
    strata.push({ stratum: k, lo, hi, count: hi - lo, mid, order, chosen_index: null, borrowed_from: null, depleted: false });
  }

  const reserved = new Set();
  const inspectedExcluded = new Set();
  let blocked = false;
  const selected = [];

  // Phase A: preserve each stratum's in-stratum representative first.
  for (const st of strata) {
    let found = false;
    for (const idx of st.order) {
      const item = normalized[idx];
      if (item.excluded === true) { inspectedExcluded.add(idx); continue; }
      if (item.pending_identity === true) { blocked = true; found = true; break; }
      reserved.add(idx);
      st.chosen_index = idx;
      selected.push({ ...item, stratum: st.stratum, borrowed_from_stratum: null, sorted_index: idx });
      found = true;
      break;
    }
    if (!found) st.depleted = true;
  }

  // Phase B: nearest-stratum borrowing for any depleted strata.
  for (const st of strata) {
    if (!st.depleted || blocked) continue;
    const neighborStrata = strata
      .filter(other => other.stratum !== st.stratum)
      .sort((a, b) => Math.abs(a.stratum - st.stratum) - Math.abs(b.stratum - st.stratum) || a.stratum - b.stratum);
    outer: for (const donor of neighborStrata) {
      for (const idx of donor.order) {
        if (reserved.has(idx)) continue;
        const item = normalized[idx];
        if (item.excluded === true) { inspectedExcluded.add(idx); continue; }
        if (item.pending_identity === true) { blocked = true; break outer; }
        reserved.add(idx);
        st.chosen_index = idx;
        st.borrowed_from = donor.stratum;
        selected.push({ ...item, stratum: st.stratum, borrowed_from_stratum: donor.stratum, sorted_index: idx });
        break outer;
      }
    }
  }

  const unsampled = [];
  const excluded = [];
  for (let i = 0; i < N; i++) {
    if (reserved.has(i)) continue;
    if (normalized[i].excluded === true) excluded.push({ ...normalized[i], sorted_index: i });
    else unsampled.push({ ...normalized[i], sorted_index: i });
  }

  return {
    stratified: true,
    pool_size: N,
    blocked,
    selected,
    unsampled,
    excluded,
    strata: strata.map(st => ({
      stratum: st.stratum,
      range: [st.lo, st.hi - 1],
      count: st.count,
      mid_index: st.mid,
      chosen: st.chosen_index !== null ? { family_id: normalized[st.chosen_index].family_id, asin: normalized[st.chosen_index].asin } : null,
      borrowed_from_stratum: st.borrowed_from,
      depleted: st.depleted,
    })),
  };
}

const R58_VALID_NEWCOMER_GRAINS = new Set(['parent_units', 'family', 'family_representative']);
const R58_VALID_COMPARABILITY = new Set(['comparable', 'same_task', 'excluded_different_task']);
const R58_COMPARABLE_VERDICTS = new Set(['comparable', 'same_task']);
const INTERNAL_PERIOD_TOKEN = Symbol('INTERNAL_OPERATING_PERIOD');
const stripInternalRat = ({ e_rat: _unused, ...rest }) => rest;

function isAlignedLatest30DayPeriod(period, obsCal) {
  if (!text(period) || !obsCal) return false;
  const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(period.trim());
  if (!m) return false;
  const fromCal = toUsSiteCalendarDate(m[1]);
  const throughCal = toUsSiteCalendarDate(m[2]);
  if (!fromCal || !throughCal || fromCal > throughCal) return false;
  const spanDays = calendarDayDiff(throughCal, fromCal) + 1;
  if (spanDays !== 30) return false;
  const lagDays = calendarDayDiff(obsCal, throughCal);
  return lagDays >= 0 && lagDays <= 2;
}

function scoreNewcomersR58(cohort, ctx, profile, defs) {
  const lowDef = defs.find(item => item.id === 'low_rating_sales_performance');
  const naturalDef = defs.find(item => item.id === 'natural_visibility_development');
  const diagnostics = {
    members: [],
    examples: [],
    selected_pair: [],
    selected_examples: [],
    ramp_up_excluded: [],
    ramp_up_zero_sales: [],
    references: { sales_median: null, effective_sales_median: null, floor_applied: null },
    reference_mode: `current_category_r${profile.revision}`,
    selection_tie_policy: 'r58_exact_rational_full_month_plus_greedy_ramp_up',
    stratification: { applied: false },
    lone_newcomer_alert: false,
    lone_newcomer_note: null,
    absence_note: null,
  };
  const pending = reason => ({
    low: missing(lowDef, reason, cohort), natural: missing(naturalDef, reason, cohort), diagnostics,
  });

  const isR59 = profile.revision >= 59;
  const validGrains = isR59
    ? new Set([...R58_VALID_NEWCOMER_GRAINS, 'target_child_units'])
    : R58_VALID_NEWCOMER_GRAINS;
  const validRefScopes = isR59
    ? new Set(['current_relevant_bsr_top100_all_ages', 'current_relevant_bsr_top100_mature_only'])
    : new Set(['current_relevant_bsr_top100_all_ages']);

  if (!cohort || cohort.reference_supported !== true || cohort.observation_basis !== 'current_latest_30_days' ||
    cohort.scope !== 'current_relevant_bsr_top100' || cohort.query_complete !== true ||
    !['observation_date', 'period', 'niche', 'grain', 'relevant_bsr_node'].every(key => text(cohort[key])) ||
    !validGrains.has(cohort.grain) ||
    !validDate(cohort.observation_date) || !hasEvidence(cohort.evidence, ctx) || !Array.isArray(cohort.members)) {
    diagnostics.members = Array.isArray(cohort?.members) ? cohort.members : [];
    return pending(cohort?.reason ?? 'A completed current-category query with valid sales grain and aligned all-age sales reference is required.');
  }

  const obsCal = toUsSiteCalendarDate(cohort.observation_date);
  if (!obsCal) return pending('Invalid observation_date on newcomer_cohort.');
  if ((cohort.window_days !== undefined && cohort.window_days !== 30) || !isAlignedLatest30DayPeriod(cohort.period, obsCal)) {
    return pending('Revision 58 newcomer cohort requires a verified latest-30-day period aligned with observation_date (YYYY-MM-DD/YYYY-MM-DD, 30 days).');
  }
  const earliestCal = threeCalendarMonthsEarlier(obsCal);

  const hasParentSalesEvidenceSignal = evList => evList.some(ev => {
    if (!ev || typeof ev !== 'object') return false;
    if (text(ev.grain) && ev.grain.trim() !== 'target_child_units') return true;
    const prose = [ev.summary, ev.note, ev.source, ev.label, ev.locator].filter(Boolean).join(' ');
    const hasMultiOrNegation = /(?:多变体|多个子体|多子体|非单变体|并非单变体|不是单变体|非唯一子体|并非唯一子体|不等于|不等同|不同于|大于目标子体|高于目标子体|超过目标子体|!=|≠|\b(?:multi[- ]variant|multiple\s+(?:child(?:ren)?|variants?)|not\s+(?:a\s+)?(?:single[- ]variant|sole\s+child)|does(?:n't|\s+not)\s+equal|do(?:n't|\s+not)\s+equal|not\s+equal\s+to|unequal)\b)/i.test(prose);
    if (!hasMultiOrNegation && /(?<!不|非)(?:单变体|唯一子体|仅1个子体|只有一个子体|等于目标子体)|\b(?:single[- ]variant|sole\s+child|only\s+one\s+child|equals?\s+target\s+child)\b/i.test(prose)) {
      return false;
    }
    return /parent_family_units|family_representative|父体销量|父体月销|父体汇总销量|\bparent\s+(?:family\s+)?(?:monthly\s*)?(?:sales|units)\b/i.test(prose);
  });

  let invalidReference = false;
  const classified = [];

  for (const member of cohort.members) {
    const record = { ...member, effective_status: member?.status ?? 'pending', age_days: null, launch_calendar_date: null };
    if (record.effective_status === 'duplicate') record.effective_status = 'pending';
    diagnostics.members.push(record);

    const launchCal = toUsSiteCalendarDate(member?.launch_date);
    const ratingsReading = readNumber(member?.ratings, 'count', ctx, { integer: true });
    const unitsReading = readNumber(member?.units_30d, 'units', ctx);
    const unitsEv = (Array.isArray(member?.units_30d?.evidence) ? member.units_30d.evidence : []).map(id => ctx.evidence.get(id)).filter(Boolean);
    const badUnitsWindow = Boolean(
      (member?.units_30d && typeof member.units_30d === 'object' && (
        (member.units_30d.period !== undefined && member.units_30d.period !== cohort.period) ||
        (text(member.units_30d.grain) && member.units_30d.grain !== cohort.grain) ||
        (cohort.grain === 'target_child_units' && (member.units_30d.grain !== 'target_child_units' || hasParentSalesEvidenceSignal(unitsEv))) ||
        hasNon30DayWindowParam([member.units_30d, ...unitsEv])
      ))
    );
    const inBsrWindow = Boolean(text(member?.family_id) && text(member?.asin) && launchCal &&
      launchCal >= earliestCal && launchCal <= obsCal &&
      member?.current_bsr_node === cohort.relevant_bsr_node && Number.isInteger(member?.current_bsr_rank) &&
      member.current_bsr_rank >= 1 && member.current_bsr_rank <= 100);
    if (launchCal && launchCal <= obsCal) {
      record.launch_calendar_date = launchCal;
      record.age_days = calendarDayDiff(obsCal, launchCal);
    }

    // Evaluate buyer-task comparability BEFORE old-review / sampling exclusions so pending/different-task rows never enter the stratification pool.
    if (member?.comparability_verdict !== undefined && !R58_VALID_COMPARABILITY.has(member.comparability_verdict)) {
      record.effective_status = 'pending';
      record.reason = text(member.reason) ? member.reason : 'Buyer-task comparability verdict must be comparable (or same_task) or excluded_different_task; unknown/pending remains blocking.';
      classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      continue;
    }

    if (member?.comparability_verdict === 'excluded_different_task') {
      if (text(member.reason) && hasEvidence(member.evidence, ctx)) {
        record.effective_status = 'excluded';
        classified.push({ record, kind: 'task_excluded', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      } else {
        record.effective_status = 'pending';
        record.reason = 'Task-comparability exclusion requires a reason and valid evidence references.';
        classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      }
      continue;
    }

    if (member?.old_reviews_predate_launch === true) {
      if (hasEvidence(member.evidence, ctx) && !badUnitsWindow && R58_COMPARABLE_VERDICTS.has(member.comparability_verdict)) {
        record.effective_status = 'excluded';
        record.reason = text(member.reason) ? member.reason : 'Supported old reviews predate the purported recent launch; excluded from the normal-start reference.';
        const relevantForStrat = inBsrWindow && !(record.age_days < 30 && unitsReading.value === 0);
        const missingPoolStats = relevantForStrat && (ratingsReading.value === null || unitsReading.value === null);
        const poolEligible = relevantForStrat && !missingPoolStats;
        classified.push({
          record, kind: 'old_review_excluded', poolEligible, missingPoolStats,
          ratingsVal: ratingsReading.value, unitsVal: unitsReading.value,
        });
      } else {
        record.effective_status = 'pending';
        record.reason = !R58_COMPARABLE_VERDICTS.has(member.comparability_verdict)
          ? 'Old-review exclusion requires explicit comparability_verdict ("comparable"/"same_task" or "excluded_different_task").'
          : badUnitsWindow
            ? 'Newcomer units_30d observation must cover the aligned 30-day cohort window.'
            : 'The asserted old-review conflict lacks valid evidence references.';
        classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      }
      continue;
    }

    if (record.effective_status === 'excluded') {
      if (!text(member.reason) || !hasEvidence(member.evidence, ctx) || badUnitsWindow ||
        !R58_COMPARABLE_VERDICTS.has(member.comparability_verdict)) {
        record.effective_status = 'pending';
        record.reason = !R58_COMPARABLE_VERDICTS.has(member.comparability_verdict)
          ? 'Excluded newcomer records require explicit comparability_verdict ("comparable"/"same_task" or "excluded_different_task").'
          : badUnitsWindow
            ? 'Newcomer units_30d observation must cover the aligned 30-day cohort window.'
            : 'An excluded newcomer record requires a reason and valid evidence references.';
        classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      } else {
        const relevantForStrat = member.sampling_excluded === true && inBsrWindow &&
          R58_COMPARABLE_VERDICTS.has(member.comparability_verdict) &&
          !(record.age_days < 30 && unitsReading.value === 0);
        const missingPoolStats = relevantForStrat && (ratingsReading.value === null || unitsReading.value === null);
        const poolEligible = relevantForStrat && !missingPoolStats;
        classified.push({
          record, kind: member.sampling_excluded === true ? 'sampling_excluded' : 'other_excluded',
          poolEligible, missingPoolStats, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value,
        });
      }
      continue;
    }

    if (badUnitsWindow) {
      record.effective_status = 'pending';
      record.reason = 'Newcomer units_30d observation must cover the aligned 30-day cohort window.';
      classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      continue;
    }

    if (!['qualified', 'unsampled_stratified', 'ramp_up_zero_sales'].includes(record.effective_status)) {
      record.effective_status = 'pending';
      classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      continue;
    }

    if (!R58_COMPARABLE_VERDICTS.has(member?.comparability_verdict)) {
      record.effective_status = 'pending';
      record.reason = 'Revision 58 requires an explicit buyer-task comparability_verdict ("comparable" or "same_task") on every active newcomer record.';
      classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      continue;
    }

    if (!text(member.family_id) || !text(member.asin) || !hasEvidence(member.evidence, ctx) ||
      (record.effective_status === 'qualified' && !text(member.reason))) {
      invalidReference = true;
      record.effective_status = 'pending';
      record.reason = 'A newcomer record needs frozen family/listing identity and valid evidence references.';
      classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      continue;
    }

    if (!inBsrWindow) {
      record.effective_status = 'pending';
      record.reason = 'A current-category newcomer needs matching rank 1-100 and a valid US-site launch date within three calendar months (not in the future).';
      classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
      continue;
    }

    if (record.effective_status === 'ramp_up_zero_sales') {
      if (record.age_days >= 30 || unitsReading.value !== 0) {
        record.effective_status = 'pending';
        record.reason = 'Only verified <30-day zero-sales listings may be pre-excluded as ramp_up_zero_sales.';
        classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
        continue;
      }
    } else if (record.effective_status === 'unsampled_stratified') {
      if (ratingsReading.value === null || unitsReading.value === null) {
        record.effective_status = 'pending';
        record.reason = 'unsampled_stratified requires reliable ratings and units_30d inputs; missing inputs remain blocking.';
        classified.push({ record, kind: 'pending', poolEligible: false, missingPoolStats: false, ratingsVal: ratingsReading.value, unitsVal: unitsReading.value });
        continue;
      }
      if (record.age_days < 30 && unitsReading.value === 0) {
        record.effective_status = 'ramp_up_zero_sales';
      }
    } else if (record.effective_status === 'qualified') {
      if (record.age_days < 30 && unitsReading.value === 0) {
        record.effective_status = 'ramp_up_zero_sales';
      }
    }

    const activePoolEligible = record.effective_status !== 'ramp_up_zero_sales' &&
      !(record.age_days < 30 && unitsReading.value === 0);
    classified.push({
      record, kind: 'active', poolEligible: activePoolEligible, missingPoolStats: false,
      ratingsVal: ratingsReading.value, unitsVal: unitsReading.value,
    });
  }

  // Transitive family/ASIN/parent_asin/representative_asin/shared_launch grouping across ALL members so duplicates never inflate counts or distort pools.
  const identityTokensOf = row => {
    const tokens = new Set();
    if (text(row?.family_id)) tokens.add(`family:${row.family_id.trim()}`);
    for (const key of ['asin', 'representative_asin', 'parent_asin']) {
      if (text(row?.[key])) tokens.add(`asin:${row[key].trim()}`);
    }
    if (text(row?.shared_launch_id)) tokens.add(`launch:${row.shared_launch_id.trim()}`);
    return tokens;
  };
  const hasIdentity = entry => identityTokensOf(entry.record).size > 0;
  const overlaps = (a, b) => {
    const ta = identityTokensOf(a.record);
    for (const tok of identityTokensOf(b.record)) if (ta.has(tok)) return true;
    return false;
  };

  const allGroups = [];
  for (const entry of classified) {
    if (!hasIdentity(entry)) {
      allGroups.push([entry]);
      continue;
    }
    const matches = allGroups.filter(group => group.some(existing => overlaps(existing, entry)));
    if (matches.length === 0) allGroups.push([entry]);
    else {
      const target = matches[0];
      target.push(entry);
      for (const merged of matches.slice(1)) {
        target.push(...merged);
        allGroups.splice(allGroups.indexOf(merged), 1);
      }
    }
  }

  const statusRank = s => s === 'qualified' ? 0 : s === 'unsampled_stratified' ? 1 : 2;
  const uniqueActive = [];
  const samplingExcludedPool = [];
  let hasExcludedMissingPoolStats = false;

  for (const group of allGroups) {
    if (group.some(e => e.kind === 'pending')) continue;

    // If task_excluded or other_excluded coexists with active or old_review_excluded for the same identity, block Q31 regardless of row order!
    if (group.some(e => e.kind === 'task_excluded' || e.kind === 'other_excluded')) {
      if (group.some(e => e.kind === 'active' || e.kind === 'old_review_excluded' || e.kind === 'sampling_excluded')) {
        invalidReference = true;
        for (const e of group) {
          e.record.effective_status = 'pending';
          e.record.reason = 'Conflicting comparability or exclusion records for the same family/ASIN.';
        }
      }
      continue;
    }

    if (group.some(e => e.kind === 'old_review_excluded' || e.kind === 'sampling_excluded')) {
      const exclMembers = group.filter(e => e.kind === 'old_review_excluded' || e.kind === 'sampling_excluded');
      exclMembers.sort((a, b) => compareIdentityTrimmed(a.record, b.record) || compareIdentity(a.record, b.record));
      const canonical = exclMembers[0];
      // Propagate old-review/sampling exclusion across the entire duplicate family/ASIN/shared-launch group.
      for (const entry of group) {
        if (entry === canonical) continue;
        if (entry.kind === 'active') {
          entry.record.effective_status = 'excluded';
          entry.record.reason = canonical.record.reason;
        } else {
          entry.record.effective_status = 'duplicate';
          entry.record.duplicate_of = { family_id: canonical.record.family_id, asin: canonical.record.asin };
        }
      }
      // Check observation consistency across ALL members in the duplicate excluded group (not just poolEligible ones)
      // so a <30d zero-sales old-review row duplicated with a 35-sale unmarked row never silently inflates the pool.
      const obsRatings = [...new Set(group.map(e => e.ratingsVal).filter(v => v !== null))];
      const obsUnits = [...new Set(group.map(e => e.unitsVal).filter(v => v !== null))];
      const obsDates = [...new Set(group.map(e => e.record.launch_calendar_date).filter(Boolean))];
      if (obsRatings.length > 1 || obsUnits.length > 1 || obsDates.length > 1) {
        invalidReference = true;
        canonical.record.reason = 'Duplicated excluded family/ASIN records have incompatible observations or launch dates.';
      } else {
        const eligibleExcl = exclMembers
          .filter(e => e.poolEligible && !(e.record.age_days < 30 && e.unitsVal === 0))
          .sort((a, b) => compareIdentityTrimmed(a.record, b.record) || compareIdentity(a.record, b.record));
        if (eligibleExcl.length > 0) {
          const rep = eligibleExcl[0];
          samplingExcludedPool.push({
            record: rep.record, ratings: rep.ratingsVal, units: rep.unitsVal, age_days: rep.record.age_days,
          });
        } else if (group.some(e => e.missingPoolStats)) {
          hasExcludedMissingPoolStats = true;
        }
      }
      continue;
    }

    // All entries in this group are active (qualified / unsampled_stratified / ramp_up_zero_sales).
    group.sort((a, b) =>
      statusRank(a.record.effective_status) - statusRank(b.record.effective_status) ||
      compareText(a.record.launch_calendar_date ?? '', b.record.launch_calendar_date ?? '') ||
      compareIdentityTrimmed(a.record, b.record) ||
      compareIdentity(a.record, b.record));
    const canonical = group[0];
    const canonNat = canonical.record.effective_status === 'qualified'
      ? scoreNatural(canonical.record, ctx, profile, cohort.period, cohort.grain)
      : null;
    uniqueActive.push(canonical.record);
    for (const dup of group.slice(1)) {
      dup.record.effective_status = 'duplicate';
      dup.record.duplicate_of = { family_id: canonical.record.family_id, asin: canonical.record.asin };
      let natConflict = false;
      if (canonNat !== null && (dup.record.status === 'qualified' || dup.record.natural !== undefined)) {
        const dupNat = scoreNatural(dup.record, ctx, profile, cohort.period, cohort.grain);
        const s1 = canonNat.score, s2 = dupNat.score;
        const scoreDiffers = (s1 === null) !== (s2 === null) || (s1 !== null && Math.abs(s1 - s2) > 1e-9);
        const metaDiffers = (canonical.record.natural?.period ?? null) !== (dup.record.natural?.period ?? null) ||
          (canonical.record.natural?.window_days ?? null) !== (dup.record.natural?.window_days ?? null) ||
          (canonical.record.natural?.scope ?? null) !== (dup.record.natural?.scope ?? null);
        if (scoreDiffers || metaDiffers) natConflict = true;
      }
      if (dup.ratingsVal !== canonical.ratingsVal || dup.unitsVal !== canonical.unitsVal ||
        dup.record.launch_calendar_date !== canonical.record.launch_calendar_date || natConflict) {
        invalidReference = true;
        dup.record.reason = 'Duplicated family/shared-launch records have incompatible observations, launch dates, or natural exposure records.';
      }
    }
  }

  const rampUpZeroSales = uniqueActive.filter(r => r.effective_status === 'ramp_up_zero_sales');
  const qualifiedActive = uniqueActive.filter(r => r.effective_status === 'qualified');
  const unsampledActive = uniqueActive.filter(r => r.effective_status === 'unsampled_stratified');
  const unresolvedMembers = diagnostics.members.filter(r =>
    !['qualified', 'unsampled_stratified', 'ramp_up_zero_sales', 'duplicate', 'excluded'].includes(r.effective_status));

  diagnostics.observed_count = cohort.members.length;
  diagnostics.qualified_deduplicated_count = qualifiedActive.length;
  diagnostics.ramp_up_zero_sales = rampUpZeroSales.map(r => ({ family_id: r.family_id, asin: r.asin, age_days: r.age_days }));

  if (invalidReference || unresolvedMembers.length > 0) {
    return pending('Unresolved or invalid newcomer observations remain pending and block Q31 scoring.');
  }

  // Build transitive family-equivalence map across members[] so reference rows aliasing two merged child records are caught too.
  const memberTokenToGroup = new Map();
  allGroups.forEach((group, gIdx) => {
    for (const entry of group) {
      for (const tok of identityTokensOf(entry.record)) {
        memberTokenToGroup.set(tok, gIdx);
      }
    }
  });

  // Check cross-table consistency AND reference duplicate identities whenever market_reference.families is present — even before zero-active early return!
  const checkCrossTableRef = refFamilies => {
    const seenRefTokens = new Set();
    const seenRefGroups = new Set();
    const refTokenList = new Map();
    const refGroupList = new Map();
    const pushMap = (map, key, val) => {
      const arr = map.get(key);
      if (arr) arr.push(val);
      else map.set(key, [val]);
    };
    for (const rf of refFamilies) {
      const rowTokens = identityTokensOf(rf);
      const matchedGroups = new Set();
      for (const tok of rowTokens) {
        if (seenRefTokens.has(tok)) {
          return 'All-age reference families contain duplicate or conflicting family/ASIN identities.';
        }
        seenRefTokens.add(tok);
        if (memberTokenToGroup.has(tok)) matchedGroups.add(memberTokenToGroup.get(tok));
      }
      for (const gIdx of matchedGroups) {
        if (seenRefGroups.has(gIdx)) {
          return 'All-age reference families contain duplicate entries aliasing the same merged newcomer family.';
        }
        seenRefGroups.add(gIdx);
      }
      if (!R58_VALID_COMPARABILITY.has(rf?.comparability_verdict)) {
        if (matchedGroups.size > 0) {
          return 'All-age reference entry matching an observed newcomer family lacks a valid comparability_verdict.';
        }
        continue;
      }
      const isExcluded = rf.comparability_verdict === 'excluded_different_task';
      const refVal = isExcluded ? null : readNumber(rf?.units_30d, 'units', ctx).value;
      const info = { isExcluded, units: refVal };
      for (const tok of rowTokens) {
        pushMap(refTokenList, tok, info);
      }
      for (const gIdx of matchedGroups) {
        pushMap(refGroupList, gIdx, info);
      }
    }
    for (const entry of classified) {
      if (entry.kind === 'pending') continue;
      const memExcludedTask = entry.kind === 'task_excluded';
      const memIsSameTask = entry.kind === 'active' || entry.kind === 'old_review_excluded' || entry.kind === 'sampling_excluded';
      const matches = [];
      for (const tok of identityTokensOf(entry.record)) {
        if (refTokenList.has(tok)) matches.push(...refTokenList.get(tok));
        if (memberTokenToGroup.has(tok) && refGroupList.has(memberTokenToGroup.get(tok))) {
          matches.push(...refGroupList.get(memberTokenToGroup.get(tok)));
        }
      }
      for (const refMatch of matches) {
        if ((memExcludedTask && !refMatch.isExcluded) || (memIsSameTask && refMatch.isExcluded)) {
          return 'Conflicting comparability verdict between newcomer_cohort.members and market_reference.families for the same family/ASIN.';
        }
        if (!refMatch.isExcluded && entry.unitsVal !== null && refMatch.units !== null &&
          Math.abs(entry.unitsVal - refMatch.units) > 1e-9) {
          return 'Conflicting units_30d between newcomer_cohort.members and market_reference.families for the same family/ASIN.';
        }
      }
    }
    return null;
  };

  if (Array.isArray(cohort.market_reference?.families) && cohort.market_reference.families.length > 0) {
    const crossErr = checkCrossTableRef(cohort.market_reference.families);
    if (crossErr) return pending(crossErr);
  }

  // Completed query with zero active full-month or positive ramp-up newcomers (including all-<30d zero-sales).
  if (qualifiedActive.length === 0 && unsampledActive.length === 0) {
    diagnostics.no_qualifying_examples = true;
    diagnostics.absence_note = '所查范围内无同任务正常起步新品样板';
    const evidence = mergeRefs(cohort.evidence, ...diagnostics.members.map(row => row.evidence));
    return {
      low: scored(lowDef, 0, cohort, { evidence, absence_note: diagnostics.absence_note }),
      natural: scored(naturalDef, 0, cohort, { evidence, absence_note: diagnostics.absence_note }),
      diagnostics,
    };
  }

  // Verified non-empty all-age (or r59 mature-only) market reference T (missing/empty/all-excluded T stays pending, never defaults to 10).
  const reference = cohort.market_reference;
  if (!validRefScopes.has(reference?.scope) || reference.node !== cohort.relevant_bsr_node ||
    reference.period !== cohort.period || reference.grain !== cohort.grain ||
    (reference.window_days !== undefined && reference.window_days !== 30) ||
    !validGrains.has(reference.grain) || reference.deduplicated !== true ||
    reference.coverage_supported !== true || !hasEvidence(reference.evidence, ctx) ||
    !Array.isArray(reference.families) || reference.families.length === 0) {
    return pending('A verified non-empty all-age sales reference T is required; missing T cannot default to 10.');
  }
  const allRefIds = reference.families.map(row => (text(row?.family_id) ? row.family_id.trim() : ''));
  const refAsins = new Set();
  const refMemberGroups = new Set();
  let duplicateRefIdentity = allRefIds.some(id => !id) || new Set(allRefIds).size !== allRefIds.length;
  for (const row of reference.families) {
    const rowTokens = identityTokensOf(row);
    const matchedGroups = new Set();
    for (const token of rowTokens) {
      if (!token.startsWith('family:')) {
        if (refAsins.has(token)) duplicateRefIdentity = true;
        refAsins.add(token);
      }
      if (memberTokenToGroup.has(token)) matchedGroups.add(memberTokenToGroup.get(token));
    }
    for (const gIdx of matchedGroups) {
      if (refMemberGroups.has(gIdx)) duplicateRefIdentity = true;
      refMemberGroups.add(gIdx);
    }
  }
  if (duplicateRefIdentity) {
    return pending('All-age reference families need unique family/ASIN identities and supported sales, including real zeros; missing T stays pending.');
  }
  if (reference.families.some(row => !R58_VALID_COMPARABILITY.has(row?.comparability_verdict))) {
    return pending('All-age reference families require explicit buyer-task comparability_verdict ("comparable"/"same_task" or "excluded_different_task"); missing/unknown T stays pending.');
  }
  const comparableRefFamilies = [];
  for (const row of reference.families) {
    if (row?.comparability_verdict === 'excluded_different_task') {
      if (!text(row.reason) || !hasEvidence(row.evidence, ctx)) {
        return pending('Excluded all-age reference families require a reason and valid evidence.');
      }
      continue;
    }
    comparableRefFamilies.push(row);
  }
  if (comparableRefFamilies.length === 0) {
    return pending('All-age reference contains zero buyer-task-comparable families; missing T cannot default to 10.');
  }
  for (const row of comparableRefFamilies) {
    const rEv = (Array.isArray(row?.units_30d?.evidence) ? row.units_30d.evidence : []).map(id => ctx.evidence.get(id)).filter(Boolean);
    if (row?.units_30d && typeof row.units_30d === 'object' && (
      (row.units_30d.period !== undefined && row.units_30d.period !== cohort.period) ||
      (text(row.units_30d.grain) && row.units_30d.grain !== cohort.grain) ||
      (cohort.grain === 'target_child_units' && (row.units_30d.grain !== 'target_child_units' || hasParentSalesEvidenceSignal(rEv))) ||
      hasNon30DayWindowParam([row.units_30d, ...rEv])
    )) {
      return pending('All-age reference units_30d observations must cover the aligned 30-day cohort window and match cohort.grain.');
    }
  }
  const refSales = comparableRefFamilies.map(row => readNumber(row?.units_30d, 'units', ctx));
  if (refSales.some(row => row.value === null)) {
    return pending('All-age reference families need unique identities and supported sales, including real zeros; missing T stays pending.');
  }
  const tRat = medianRat(refSales.map(row => row.value));
  const tEffRat = ratMax(tRat, rat(10n, 1n));
  diagnostics.references = {
    sales_median: ratToNumber(tRat),
    effective_sales_median: ratToNumber(tEffRat),
    floor_applied: ratCmp(tRat, rat(10n, 1n)) < 0,
    family_count: comparableRefFamilies.length,
    grain: reference.grain,
    scope: reference.scope,
    task_filter_signature: reference.task_filter_signature ?? null,
    sales_units: refSales.map(row => row.value),
  };

  const evaluateRow = member => {
    const ratings = readNumber(member.ratings, 'count', ctx, { integer: true });
    const units = readNumber(member.units_30d, 'units', ctx);
    const { actualRat, ratioRat, ceilingRat, eRat } = evalExampleRat(ratings.value, units.value, tEffRat, profile);
    return {
      family_id: member.family_id,
      asin: member.asin,
      age_days: member.age_days,
      launch_calendar_date: member.launch_calendar_date,
      is_full_month: member.age_days >= 30,
      effective_status: member.effective_status,
      units_30d: units.value,
      ratings: ratings.value,
      actual_score: actualRat ? ratToNumber(actualRat) : null,
      sales_ratio: ratioRat ? ratToNumber(ratioRat) : null,
      sales_ceiling: ceilingRat ? ratToNumber(ceilingRat) : null,
      score: eRat ? ratToNumber(eRat) : null,
      e_rat: eRat,
      natural: member.effective_status === 'qualified' ? scoreNatural(member, ctx, profile, cohort.period, cohort.grain) : null,
      reason: ratings.reason ?? units.reason ?? null,
    };
  };

  const evalQualified = qualifiedActive.map(evaluateRow);
  if (evalQualified.some(row => row.e_rat === null)) {
    diagnostics.examples = evalQualified.map(stripInternalRat);
    return pending('Every verified qualified newcomer requires supported ratings and 30-day sales.');
  }
  const evalUnsampled = unsampledActive.map(evaluateRow);
  if (evalUnsampled.some(row => row.e_rat === null)) {
    diagnostics.examples = evalQualified.map(stripInternalRat);
    return pending('Every unsampled_stratified candidate requires supported ratings and 30-day sales.');
  }

  const memberKey = r => `${String(r?.family_id ?? '').trim()}\0${String(r?.asin ?? '').trim()}`;
  const nActive = evalQualified.length + evalUnsampled.length;
  let stratifiedMeta = { applied: false, active_pool_size: nActive };
  let scoringPool = evalQualified;

  if (nActive <= 5) {
    if (evalUnsampled.length > 0) {
      diagnostics.examples = evalQualified.map(stripInternalRat);
      return pending('Stratified sampling (unsampled_stratified) is only permitted when N_active > 5.');
    }
  } else {
    if (hasExcludedMissingPoolStats) {
      diagnostics.examples = evalQualified.map(stripInternalRat);
      return pending('Stratified sampling requires reliable ratings and units_30d on every in-window old-review/sampling-excluded listing so quintile placement and replacement order remain deterministic.');
    }
    // Deterministic 5-quintile stratification is unconditionally triggered by deduplicated N_active > 5
    // so input-label switching between qualified and unsampled_stratified can never game the score.
    const allActiveEval = [...evalQualified, ...evalUnsampled];
    const qualifiedMap = new Map(evalQualified.map(r => [memberKey(r), r]));
    const seenKeys = new Set(allActiveEval.map(memberKey));
    const exclPoolItems = samplingExcludedPool
      .filter(item => !seenKeys.has(memberKey(item.record)))
      .map(item => {
        const { eRat } = evalExampleRat(item.ratings, item.units, tEffRat, profile);
        return {
          family_id: item.record.family_id,
          asin: item.record.asin,
          e_rat: eRat,
          units_30d: item.units,
          excluded: true,
        };
      });
    const fullPool = [
      ...allActiveEval.map(r => ({ family_id: r.family_id, asin: r.asin, e_rat: r.e_rat, units_30d: r.units_30d, excluded: false })),
      ...exclPoolItems,
    ];
    const stratResult = selectStratifiedNewcomers(fullPool);
    const selectedKeys = new Set(stratResult.selected.map(memberKey));
    const allSelectedVerified = !stratResult.blocked && selectedKeys.size > 0 &&
      [...selectedKeys].every(k => qualifiedMap.has(k));
    if (!allSelectedVerified) {
      diagnostics.examples = evalQualified.map(stripInternalRat);
      return pending('Qualified representatives do not match the deterministic 5-quintile stratified selection and replacement order.');
    }
    const selectedReps = [...selectedKeys].map(k => qualifiedMap.get(k));
    const nonSelected = allActiveEval.filter(r => !selectedKeys.has(memberKey(r)));
    const vFull = selectedReps.filter(r => r.is_full_month).map(r => r.e_rat);
    const vRamp = selectedReps.filter(r => !r.is_full_month).map(r => r.e_rat);
    const uFull = nonSelected.filter(r => r.is_full_month).map(r => r.e_rat);
    const uRamp = nonSelected.filter(r => !r.is_full_month).map(r => r.e_rat);
    const [lowMinRat, lowMaxRat] = computeStratifiedBoundsRat(vFull, vRamp, uFull, uRamp);
    const disclosure = `Q31 为 ${selectedReps.length}/${nActive} 分层代表估计`;
    stratifiedMeta = {
      applied: true,
      active_pool_size: nActive,
      full_pool_size: fullPool.length,
      sampled_count: selectedReps.length,
      unsampled_count: nonSelected.length,
      disclosure,
      stratified_bounds: [ratToNumber(lowMinRat), ratToNumber(lowMaxRat)],
      natural_stratified_note: '自然可见度为给定所选代表样本 S* 与分母 D 的估计（不含未抽检全集自然极值）。',
      strata: stratResult.strata,
    };
    scoringPool = selectedReps;
  }

  diagnostics.stratification = stratifiedMeta;
  diagnostics.examples = scoringPool.map(stripInternalRat);

  const mFull = scoringPool.filter(r => r.is_full_month);
  const mRamp = scoringPool.filter(r => !r.is_full_month && r.e_rat.n > 0n);
  const greedy = evalGreedyFRat(mFull, mRamp);
  const selectedSorted = [...greedy.selected].sort((a, b) => ratCmp(b.e_rat, a.e_rat) || compareIdentityTrimmed(a, b) || compareIdentity(a, b));
  const selectedIds = selectedSorted.map(({ family_id, asin }) => ({ family_id, asin }));

  diagnostics.selected_pair = selectedIds;
  diagnostics.selected_examples = selectedSorted.map(r => ({
    family_id: r.family_id, asin: r.asin, age_days: r.age_days, is_full_month: r.is_full_month, score: r.score,
  }));
  diagnostics.denominator = greedy.denominator;
  diagnostics.ramp_up_excluded = greedy.rejected_ramp_up.map(r => ({
    family_id: r.family_id, asin: r.asin, age_days: r.age_days, score: r.score,
  }));
  diagnostics.no_qualifying_examples = selectedSorted.length === 0;

  const scoringKeySet = new Set(scoringPool.map(memberKey));
  const scoringMembers = qualifiedActive.filter(m => scoringKeySet.has(memberKey(m)));
  const evidence = mergeRefs(cohort.evidence, reference.evidence, ...comparableRefFamilies.map(row => row.units_30d?.evidence),
    ...scoringMembers.flatMap(member => [member.evidence, member.ratings?.evidence, member.units_30d?.evidence]));

  if (selectedSorted.length === 0) {
    diagnostics.absence_note = '所查范围内无同任务正常起步新品样板';
    return {
      low: scored(lowDef, 0, cohort, { evidence, denominator: 0, absence_note: diagnostics.absence_note }),
      natural: scored(naturalDef, 0, cohort, { evidence, denominator: 0, absence_note: diagnostics.absence_note }),
      diagnostics,
    };
  }

  const D = greedy.denominator; // max(|S*|, 2)
  const substantialCount = selectedSorted.filter(r => ratCmp(r.e_rat, rat(2n, 1n)) >= 0).length;
  const loneAlert = selectedSorted.length === 1 || substantialCount < 2;
  diagnostics.lone_newcomer_alert = loneAlert;
  diagnostics.lone_newcomer_note = loneAlert
    ? (stratifiedMeta.applied
      ? '已核代表样本中达到实质起量水位（e≥2）的同任务新品不足 2 家（未抽检候选尚可能改变人数，暂不推断隐形壁垒）。'
      : '孤例/单极新品突围预警（有效起量 e≥2 同任务新品不足 2 家）：二阶段重点排查专利或站外/关联壁垒。')
    : null;

  const lowExtra = {
    selected_pair: selectedIds,
    denominator: D,
    evidence,
    ...(stratifiedMeta.applied ? {
      stratified_estimate: true,
      stratified_disclosure: stratifiedMeta.disclosure,
      stratified_bounds: stratifiedMeta.stratified_bounds,
    } : {}),
  };
  const low = scored(lowDef, ratToNumber(greedy.f_rat), cohort, lowExtra);

  const naturalScores = selectedSorted.map(row => row.natural.score);
  const knownNatural = naturalScores.filter(v => v !== null);
  const missingCount = selectedSorted.length - knownNatural.length;
  const knownTotal = knownNatural.reduce((sum, v) => sum + v, 0);
  const naturalEvidence = mergeRefs(evidence, ...selectedSorted.flatMap(row => [row.natural.input?.evidence, row.natural.input?.relevant_entries_evidence]));
  const naturalExtra = {
    selected_pair: selectedIds,
    denominator: D,
    evidence: naturalEvidence,
    ...(stratifiedMeta.applied ? {
      stratified_estimate: true,
      stratified_disclosure: stratifiedMeta.disclosure,
      stratified_note: stratifiedMeta.natural_stratified_note,
    } : {}),
  };
  const natural = missingCount === 0
    ? scored(naturalDef, knownTotal / D, cohort, naturalExtra)
    : missing(naturalDef, 'The fixed current-category examples lack supported SIF overall shares.', cohort, {
      ...naturalExtra,
      conditional_range: [knownTotal / D, (knownTotal + missingCount) / D],
    });

  return { low, natural, diagnostics };
}

function datedScenario(scenario, economics, ctx, profile, forceSensitivityOnly = false) {
  let calculation = null, reason = null;
  try {
    const rawLedger = scenario?.cost_ledger;
    if (!rawLedger || rawLedger.id !== scenario.id || rawLedger.saleable_unit !== economics.saleable_unit) {
      throw new TypeError('Revision54 requires a cost_ledger with the same scenario ID and saleable unit.');
    }
    const ledger = forceSensitivityOnly ? { ...rawLedger, sensitivity_only: true } : rawLedger;
    calculation = calculateEconomics(ledger, { requireFeeBasis: true, requireRegularRepeatOrder: profile.revision >= 57,
      profileRevision: profile.revision, evidenceIds: [...ctx.evidence.keys()], operatingMonths: economics.operating_months });
    if (!calculation.scoring_supported) {
      reason = calculation.fee_validation.issues.map(issue => `${issue.line}: ${issue.reason}`).join(' ') ||
        `Unconfirmed costs: ${calculation.pending_lines.join(', ')}; sensitivity-only results cannot be scored.`;
    }
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    reason = error.message;
  }
  const refs = mergeRefs(...(Array.isArray(scenario?.cost_ledger?.lines) ? scenario.cost_ledger.lines : []).map(line => line?.evidence));
  return { ...scenario, calculation,
    supplied_observations: { margin: scenario?.margin ?? null, contribution_usd: scenario?.contribution_usd ?? null },
    margin: { value: reason ? null : calculation.margin, unit: 'fraction', evidence: refs, reason },
    contribution_usd: { value: reason ? null : calculation.contribution_usd, unit: 'USD', evidence: refs, reason } };
}

function validateR58PriceAnchor(anchor, ctx, minFloor = 29.99) {
  const reading = readNumber(anchor, 'USD', ctx, { min: Number.MIN_VALUE });
  if (reading.value === null) return { supported: false, value: null, min_value: null, max_value: null, reason: anchor?.reason ?? 'A supported positive matched-spec FBA reference price is required.' };
  if (anchor.matched_spec !== true) return { supported: false, value: null, min_value: null, max_value: null, reason: 'Reference price must explicitly confirm matched_spec: true.' };
  if (!text(anchor.target_variant_asin)) return { supported: false, value: null, min_value: null, max_value: null, reason: 'Revision 58 requires target_variant_asin on the reference price anchor.' };
  if (anchor.fulfillment_channel !== 'FBA') return { supported: false, value: null, min_value: null, max_value: null, reason: 'Revision 58 primary reference price must be fulfillment_channel: "FBA" (FBM benchmarks belong in stress_scenarios[]).' };
  if (anchor.sales_history_supported !== true) return { supported: false, value: null, min_value: null, max_value: null, reason: 'Revision 58 reference price requires sales_history_supported: true.' };

  // Support ongoing Coupon / Prime Exclusive Discount net_effective_price_usd without double-deduction.
  const hasPromoFields = ['list_price_usd', 'ongoing_coupon_usd', 'ongoing_coupon_pct',
    'prime_exclusive_discount_usd', 'prime_exclusive_discount_pct', 'net_effective_price_usd', 'promo_basis_already_net']
    .some(k => anchor[k] !== undefined && anchor[k] !== null);
  let pricingMeta = null;
  if (hasPromoFields) {
    const pricing = resolveEffectivePricing({
      price_usd: anchor.list_price_usd === undefined ? reading.value : undefined,
      list_price_usd: anchor.list_price_usd,
      ongoing_coupon_usd: anchor.ongoing_coupon_usd,
      ongoing_coupon_pct: anchor.ongoing_coupon_pct,
      prime_exclusive_discount_usd: anchor.prime_exclusive_discount_usd,
      prime_exclusive_discount_pct: anchor.prime_exclusive_discount_pct,
      net_effective_price_usd: anchor.net_effective_price_usd,
      promo_basis_already_net: anchor.promo_basis_already_net,
    });
    if (!pricing.valid) {
      return { supported: false, value: null, min_value: null, max_value: null, reason: pricing.reason };
    }
    if (Math.abs(reading.value - pricing.net_effective_price_usd) > 1e-4) {
      return {
        supported: false,
        value: null,
        min_value: null,
        max_value: null,
        reason: `Reference price anchor value (${reading.value}) must equal resolved ongoing-promo net_effective_price_usd (${pricing.net_effective_price_usd}) without double deduction.`,
      };
    }
    pricingMeta = pricing;
  }

  let minVal = minFloor;
  let maxVal = reading.value;
  if (anchor.supported_price_range !== undefined) {
    const rng = anchor.supported_price_range;
    if (!Array.isArray(rng) || rng.length !== 2 || !number(rng[0]) || !number(rng[1]) || rng[0] <= 0 || rng[0] > rng[1] ||
      reading.value < rng[0] - 1e-6 || reading.value > rng[1] + 1e-6) {
      return { supported: false, value: null, min_value: null, max_value: null, reason: 'Invalid supported_price_range on reference price anchor.' };
    }
    minVal = Math.max(minFloor, rng[0]);
    maxVal = rng[1];
  }
  return {
    supported: true,
    value: reading.value,
    min_value: minVal,
    max_value: maxVal,
    reason: null,
    ...(pricingMeta ? {
      has_ongoing_discount: pricingMeta.has_ongoing_discount,
      list_price_usd: pricingMeta.list_price_usd,
      net_effective_price_usd: pricingMeta.net_effective_price_usd,
      ongoing_discount_usd: pricingMeta.total_discount_usd,
    } : {}),
  };
}

function scoreEconomics(economics, ctx, profile, defs, priceRefR58 = null) {
  const marginDef = defs.find(item => item.id === 'refund_adjusted_pre_ad_margin');
  const contributionDef = defs.find(item => item.id === 'unit_contribution');
  const floor = profile.reference_screening.margin.minimum;
  const priceFloor = profile.reference_screening.comparable_reference_price.minimum_inclusive ?? 29.99;
  const isR58 = profile.revision >= 58;
  const diagnostics = {
    saleable_unit: economics?.saleable_unit ?? null,
    scenarios: [],
    margin_range: null,
    ...(isR58 ? { stress_scenarios: [], expected_primary_scenarios: null, structural_reason: null } : {}),
  };
  const idCounts = new Map();
  let structuralReason = null;
  let outerStructuralReason = null;
  if (!text(economics?.saleable_unit) || !Array.isArray(economics?.scenarios)) {
    structuralReason = 'A common saleable unit and nonempty supported economic scenario set are required.';
    outerStructuralReason = structuralReason;
  } else {
    for (const scenario of economics.scenarios) {
      if (text(scenario?.id)) idCounts.set(scenario.id, (idCounts.get(scenario.id) ?? 0) + 1);
    }
    if (isR58 && economics.expected_primary_scenarios !== undefined) {
      const expectedList = economics.expected_primary_scenarios;
      if (!Array.isArray(expectedList) || expectedList.length === 0) {
        structuralReason = 'expected_primary_scenarios must be a nonempty array when supplied.';
      } else {
        const expectedSeen = new Set();
        const activeExpected = new Set();
        const summary = [];
        for (const entry of expectedList) {
          if (!entry || typeof entry !== 'object' || !text(entry.id) || expectedSeen.has(entry.id) ||
            !['active', 'cancelled'].includes(entry.status)) {
            structuralReason = 'expected_primary_scenarios entries need unique nonempty ids and status active or cancelled.';
            summary.push({ id: entry?.id ?? null, status: entry?.status ?? null, verdict: 'invalid' });
            continue;
          }
          expectedSeen.add(entry.id);
          const present = idCounts.has(entry.id);
          if (entry.status === 'active') {
            activeExpected.add(entry.id);
            if (!present) {
              structuralReason ??= `Missing active pre-declared primary scenario: ${entry.id}.`;
              summary.push({ id: entry.id, status: 'active', verdict: 'missing' });
            } else {
              summary.push({ id: entry.id, status: 'active', verdict: 'present' });
            }
          } else {
            const validCancel = text(entry.reason) && hasEvidence(entry.evidence, ctx) && !present;
            if (!validCancel) {
              structuralReason ??= present
                ? `Cancelled pre-declared primary scenario ${entry.id} still appears in active scenarios.`
                : `Cancelled pre-declared primary scenario ${entry.id} requires a reason and valid registered evidence.`;
              summary.push({ id: entry.id, status: 'cancelled', verdict: present ? 'conflict_still_present' : 'unverified_cancellation' });
            } else {
              summary.push({ id: entry.id, status: 'cancelled', verdict: 'evidenced_cancellation', reason: entry.reason, evidence: entry.evidence });
            }
          }
        }
        if (activeExpected.size === 0) {
          structuralReason ??= 'expected_primary_scenarios must include at least one active primary scenario.';
        }
        for (const scenarioId of idCounts.keys()) {
          if (!activeExpected.has(scenarioId)) {
            structuralReason ??= `Undeclared primary scenario ${scenarioId} is not listed as active in expected_primary_scenarios.`;
            summary.push({ id: scenarioId, status: 'undeclared', verdict: 'undeclared_in_expected' });
          }
        }
        diagnostics.expected_primary_scenarios = summary;
      }
    }
    if (economics.scenarios.length === 0) {
      structuralReason ??= 'A common saleable unit and nonempty supported economic scenario set are required.';
    }
    outerStructuralReason = structuralReason;
    for (const original of economics.scenarios) {
      const scenario = profile.revision >= 54 ? datedScenario(original, economics, ctx, profile) : original;
      const validRecord = text(scenario?.id) && idCounts.get(scenario.id) === 1 && scenario.saleable_unit === economics.saleable_unit &&
        scenario.coherent === true && Array.isArray(scenario.assumptions) && scenario.assumptions.length > 0 && scenario.assumptions.every(text) &&
        (!isR58 || scenario?.calculation?.scoring_supported === true);
      let eligibilityReason = validRecord ? null : 'Economic scenarios need unique IDs, the same saleable unit, coherent inputs and explicit assumptions.';
      let priceAnchorReason = null;
      if (isR58 && scenario?.calculation?.price_usd !== undefined) {
        const ledgerPrice = scenario.calculation.price_usd;
        if (ledgerPrice < priceFloor) {
          priceAnchorReason = `Primary scenario price USD ${ledgerPrice} is below the USD ${priceFloor} minimum retail floor.`;
        } else if (scenario.price_anchor !== undefined) {
          const sa = validateR58PriceAnchor(scenario.price_anchor, ctx, priceFloor);
          if (!sa.supported || sa.value < priceFloor || sa.value !== ledgerPrice) {
            priceAnchorReason = sa.reason ?? 'Scenario price_anchor does not match cost_ledger.price_usd or falls below the price floor.';
          }
        } else if (priceRefR58 && (!priceRefR58.supported || ledgerPrice < priceRefR58.min_value || ledgerPrice > priceRefR58.max_value)) {
          priceAnchorReason = priceRefR58.supported
            ? `Primary scenario price USD ${ledgerPrice} lies outside supported matched-spec FBA reference price bounds [${priceRefR58.min_value}, ${priceRefR58.max_value}] without an evidenced price_anchor.`
            : (priceRefR58.reason ?? 'A supported matched-spec FBA reference price anchor is required.');
        }
      }
      if (priceAnchorReason && !eligibilityReason) eligibilityReason = priceAnchorReason;
      if (eligibilityReason) structuralReason ??= eligibilityReason;
      const margin = readNumber(scenario?.margin, 'fraction', ctx, { min: -Infinity, max: 1 });
      const contribution = readNumber(scenario?.contribution_usd, 'USD', ctx, { min: -Infinity });
      const contradictoryTuple = margin.value !== null && contribution.value !== null && Math.sign(margin.value) !== Math.sign(contribution.value);
      if (contradictoryTuple) {
        eligibilityReason = 'Supported margin and contribution have contradictory signs or zero under the required positive net revenue.';
        structuralReason = eligibilityReason;
      }
      const coherenceSupported = validRecord && !contradictoryTuple && !eligibilityReason;
      const meetsFloor = margin.value !== null && (profile.revision >= 57 && scenario?.calculation?.scoring_supported
        ? ledgerMeetsMarginFloor(scenario.calculation, floor)
        : margin.value >= floor);
      const eligible = coherenceSupported && meetsFloor;
      eligibilityReason ??= margin.reason ?? (!meetsFloor ? 'The supported scenario margin is below the existing 30% floor.' : null);
      const effectiveMargin = eligible && margin.value < floor ? floor : margin.value;
      diagnostics.scenarios.push({ id: scenario?.id ?? null, input: scenario, margin, contribution,
        coherence_supported: coherenceSupported, ...(isR58 ? { price_anchor_supported: priceAnchorReason === null } : {}),
        margin_eligible: eligible, eligibility_reason: eligibilityReason,
        margin_score: eligible ? numericScore(marginDef, effectiveMargin) : null,
        contribution_score: eligible && contribution.value !== null ? numericScore(contributionDef, contribution.value) : null });
    }
  }
  if (isR58 && Array.isArray(economics?.stress_scenarios)) {
    const primaryHasOngoingPromo = Boolean(priceRefR58?.has_ongoing_discount) ||
      diagnostics.scenarios.some(sc => sc.input?.calculation?.ongoing_discount_usd > 0 || sc.input?.cost_ledger?.ongoing_coupon_usd > 0 ||
        sc.input?.cost_ledger?.ongoing_coupon_pct > 0 || sc.input?.cost_ledger?.prime_exclusive_discount_usd > 0 ||
        sc.input?.cost_ledger?.prime_exclusive_discount_pct > 0);
    const primaryNetPrices = diagnostics.scenarios
      .map(sc => sc.input?.calculation?.price_usd)
      .filter(number);
    const primaryListPrices = diagnostics.scenarios
      .map(sc => sc.input?.calculation?.list_price_usd ?? sc.input?.calculation?.price_usd)
      .filter(number);
    if (number(priceRefR58?.net_effective_price_usd)) primaryNetPrices.push(priceRefR58.net_effective_price_usd);
    if (number(priceRefR58?.list_price_usd)) primaryListPrices.push(priceRefR58.list_price_usd);

    const dedupedStress = mergeStressScenarios(undefined, economics.stress_scenarios) ?? [];
    diagnostics.stress_scenarios = dedupedStress.map(stress => {
      const stressType = stress?.stress_type ?? 'stress_sensitivity';
      const ledger = stress?.cost_ledger;
      const isPromoStress = /coupon|promo|prime/i.test(String(stressType)) ||
        ['self_coupon_usd', 'self_coupon_pct', 'ongoing_coupon_usd', 'ongoing_coupon_pct',
          'prime_exclusive_discount_usd', 'prime_exclusive_discount_pct']
          .some(k => number(stress?.[k]) || number(ledger?.[k]));
      const stressIssues = [];
      let doubleDeductionBlocked = false;

      if (isPromoStress) {
        const hasSecondaryDiscount = ['self_coupon_usd', 'self_coupon_pct', 'ongoing_coupon_usd', 'ongoing_coupon_pct',
          'prime_exclusive_discount_usd', 'prime_exclusive_discount_pct']
          .some(k => (number(stress?.[k]) && stress[k] > 0) || (number(ledger?.[k]) && ledger[k] > 0));
        const alreadyNet = stress?.promo_basis_already_net === true || ledger?.promo_basis_already_net === true;
        const stressBaseList = number(ledger?.list_price_usd) ? ledger.list_price_usd
          : number(stress?.list_price_usd) ? stress.list_price_usd
            : (number(ledger?.price_usd) ? ledger.price_usd : null);
        const stressNetCandidate = number(ledger?.net_effective_price_usd) ? ledger.net_effective_price_usd
          : (number(ledger?.price_usd) ? ledger.price_usd : null);
        const stacksOntoPrimaryNet = primaryHasOngoingPromo && stress?.explicit_stackable_promo !== true && (
          (hasSecondaryDiscount && stressBaseList !== null &&
            primaryNetPrices.some(p => Math.abs(p - stressBaseList) < 0.01) &&
            !primaryListPrices.some(p => Math.abs(p - stressBaseList) < 0.01)) ||
          (stressNetCandidate !== null && !number(ledger?.list_price_usd) && !number(stress?.list_price_usd) &&
            primaryNetPrices.some(p => stressNetCandidate < p - 0.01) &&
            (hasSecondaryDiscount || /coupon|promo|prime/i.test(String(stressType))))
        );
        if ((alreadyNet && hasSecondaryDiscount) || stacksOntoPrimaryNet) {
          doubleDeductionBlocked = true;
          stressIssues.push({
            code: 'coupon_double_deduction_blocked',
            reason: 'Self-coupon/promo stress scenario attempts to deduct an ongoing coupon/Prime discount a second time on an already-net effective price without an explicit gross list_price_usd basis or stackable promo proof.',
          });
        }
      }

      const evaluated = doubleDeductionBlocked ? { calculation: null, margin: { reason: stressIssues[0].reason } } : datedScenario(stress, economics, ctx, profile, true);
      const calc = evaluated.calculation;
      let promoTierUnverified = false;
      if (!doubleDeductionBlocked) {
        if (!calc) {
          stressIssues.push({ code: 'stress_ledger_invalid', reason: evaluated.margin?.reason || 'Stress scenario cost_ledger could not be calculated.' });
        } else {
          for (const iss of (calc.fee_validation?.issues ?? [])) {
            stressIssues.push({ code: iss.code ?? 'fee_issue', line: iss.line ?? null, reason: iss.reason });
          }
          if (Array.isArray(calc.pending_lines) && calc.pending_lines.length > 0) {
            stressIssues.push({ code: 'stress_pending_lines', reason: `Unconfirmed stress cost lines: ${calc.pending_lines.join(', ')}.` });
          }
          const stressPrice = calc.price_usd;
          const baseAbove50 = primaryListPrices.some(p => p > 50.00) || (number(ledger?.list_price_usd) && ledger.list_price_usd > 50.00);
          if (isPromoStress && baseAbove50 && number(stressPrice) && stressPrice <= 50.00 &&
            stress?.fulfillment_promo_tier_verified !== true && ledger?.fulfillment_promo_tier_verified !== true) {
            promoTierUnverified = true;
            stressIssues.push({
              code: 'promo_tier_crossing_unverified',
              reason: 'Self-coupon/promo stress crosses the $50.00 FBA fulfillment threshold without fulfillment_promo_tier_verified: true; margin stays pending until Amazon promo tier fee rules are verified.',
            });
          }
        }
      }

      const blockNumbers = doubleDeductionBlocked || promoTierUnverified;
      return {
        id: stress?.id ?? null,
        label: stress?.label ?? stress?.id ?? '独立压力情景',
        stress_type: stressType,
        assumptions: Array.isArray(stress?.assumptions) ? stress.assumptions : [],
        price_usd: calc?.price_usd ?? stress?.cost_ledger?.price_usd ?? null,
        margin: blockNumbers ? null : (calc?.margin ?? null),
        contribution_usd: blockNumbers ? null : (calc?.contribution_usd ?? null),
        advertising_scenario_margin: blockNumbers ? null : (calc?.advertising_scenario_margin ?? null),
        landed_domestic_cap_at_30pct_usd: blockNumbers ? null : (calc?.landed_domestic_cap_at_30pct_usd ?? null),
        landed_domestic_cap_at_30pct_cny: blockNumbers ? null : (calc?.landed_domestic_cap_at_30pct_cny ?? null),
        double_deduction_blocked: doubleDeductionBlocked,
        promo_tier_unverified: promoTierUnverified,
        stress_issues: stressIssues,
        calculation: calc,
      };
    });
  }
  const scenarios = diagnostics.scenarios;
  const isR59 = profile.revision >= 59;
  const marginsComplete = !structuralReason && scenarios.every(scenario => scenario.margin.value !== null);
  if (marginsComplete) diagnostics.margin_range = span(scenarios.map(scenario => scenario.margin.value));
  let marginStatus = 'pending';
  let marginReason = structuralReason ?? 'One or more economic scenarios lacks a supported complete margin; missing costs are not zero.';
  if (marginsComplete) {
    const allFail = profile.revision >= 57 ? scenarios.every(s => !s.margin_eligible) : diagnostics.margin_range[1] < floor;
    const allPass = profile.revision >= 57 ? scenarios.every(s => s.margin_eligible) : diagnostics.margin_range[0] >= floor;
    if (allFail) {
      marginStatus = 'fail';
      marginReason = 'The supported margin upper bound is below the existing 30% floor.';
    } else if (allPass) {
      marginStatus = 'pass';
      marginReason = 'All supported coherent scenarios meet the margin condition.';
    } else if (isR59) {
      // Revision 59: crossing-30% coherent multi-quote / multi-price interval extends below-floor margin score
      // linearly along the exact BigInt rational slope min(22, max(0, 11 + 55 * (m - 0.30))) paired with the same scenario's unit contribution.
      const floorRat = ratFromNumber(marginDef.mapping.eligible_margin_floor);
      const fullAtRat = ratFromNumber(marginDef.mapping.full_score_at);
      const scoreFloorRat = ratFromNumber(marginDef.mapping.score_at_floor);
      const weightRat = ratFromNumber(marginDef.weight);
      const slopeRat = ratDiv(ratSub(weightRat, scoreFloorRat), ratSub(fullAtRat, floorRat));
      for (const s of scenarios) {
        if (s.margin_score === null && s.margin.value !== null) {
          const mRat = ratFromNumber(s.margin.value);
          const rawRat = ratAdd(scoreFloorRat, ratMul(slopeRat, ratSub(mRat, floorRat)));
          s.margin_score = ratToNumber(ratMin(weightRat, ratMax(rat(0n, 1n), rawRat)));
        }
        if (s.contribution_score === null && s.contribution.value !== null) {
          s.contribution_score = s.contribution.value <= 0 ? 0 : numericScore(contributionDef, s.contribution.value);
        }
      }
      diagnostics.crossing_margin_floor = true;
      diagnostics.passing_scenario_ids = scenarios.filter(s => s.margin_eligible).map(s => s.id);
      diagnostics.below_floor_scenario_ids = scenarios.filter(s => !s.margin_eligible).map(s => s.id);
      marginStatus = 'crossing_pass';
      marginReason = `Supported scenarios cross the 30% floor (passing: ${diagnostics.passing_scenario_ids.join(', ')}; below floor: ${diagnostics.below_floor_scenario_ids.join(', ')}); r59 scores full interval along linear slope without inflating strict qualifying count.`;
    } else {
      marginReason = 'The supported margin range crosses 30%; screening remains pending.';
    }
  } else if (isR58 && !outerStructuralReason && scenarios.length > 0) {
    // When nonnegative domestic_freight is the ONLY unconfirmed/deferred cost and every scenario's bare-goods
    // upper-bound margin is already strictly below 30%, no nonnegative domestic freight can rescue eligibility.
    const scIdCounts = new Map();
    for (const sc of scenarios) {
      if (text(sc?.input?.id)) scIdCounts.set(sc.input.id, (scIdCounts.get(sc.input.id) ?? 0) + 1);
    }
    const floorRat = ratFromNumber(floor);
    const bareUpperBounds = [];
    const allBareBelowFloor = scenarios.every(sc => {
      const inp = sc?.input;
      const calc = inp?.calculation;
      const ledger = inp?.cost_ledger;
      if (!inp || !calc || !ledger || !text(inp.id) || scIdCounts.get(inp.id) !== 1) return false;
      if (inp.saleable_unit !== economics.saleable_unit || inp.coherent !== true) return false;
      if (!Array.isArray(inp.assumptions) || inp.assumptions.length === 0 || !inp.assumptions.every(text)) return false;
      if (ledger.sensitivity_only === true || sc.price_anchor_supported === false) return false;
      if (!number(calc.net_revenue_usd) || calc.net_revenue_usd <= 0 || !number(calc.known_cost_usd) || calc.known_cost_usd < 0) return false;
      const lines = Array.isArray(calc.lines) ? calc.lines : [];
      const procLine = lines.find(l => l?.id === 'procurement');
      const domLine = lines.find(l => l?.id === 'domestic_freight');
      if (!procLine || procLine.status === 'pending' || procLine.status === 'deferred' || !number(procLine.amount_usd) || procLine.amount_usd <= 0) return false;
      if (!domLine || (domLine.status !== 'pending' && domLine.status !== 'deferred') || domLine.amount_usd !== null) return false;
      const pend = Array.isArray(calc.pending_lines) ? calc.pending_lines : [];
      if (pend.length !== 1 || pend[0] !== 'domestic_freight' || pend.includes('recovery_credit')) return false;
      const issues = Array.isArray(calc.fee_validation?.issues) ? calc.fee_validation.issues : [];
      if (issues.some(iss => iss?.line !== 'domestic_freight')) return false;
      const netR = ratFromNumber(calc.net_revenue_usd);
      const knownR = ratFromNumber(calc.known_cost_usd);
      if (ratCmp(ratSub(netR, knownR), ratMul(floorRat, netR)) >= 0) return false;
      bareUpperBounds.push((calc.net_revenue_usd - calc.known_cost_usd) / calc.net_revenue_usd);
      return true;
    });
    if (allBareBelowFloor && bareUpperBounds.length === scenarios.length) {
      diagnostics.bare_goods_margin_upper_bounds = span(bareUpperBounds);
      marginStatus = 'fail';
      marginReason = 'Even before adding unconfirmed nonnegative domestic freight, the supported bare-goods margin upper bound is below the existing 30% floor.';
    }
  }
  const completeMargin = marginStatus === 'pass' || marginStatus === 'crossing_pass';
  const completeContribution = completeMargin && scenarios.every(scenario => scenario.contribution.value !== null);
  const marginRange = completeMargin ? span(scenarios.map(scenario => scenario.margin_score)) : null;
  const contributionRange = completeContribution ? span(scenarios.map(scenario => scenario.contribution_score)) : null;
  const marginEvidence = mergeRefs(...scenarios.map(scenario => scenario.input?.margin?.evidence));
  const contributionEvidence = mergeRefs(marginEvidence, ...scenarios.map(scenario => scenario.input?.contribution_usd?.evidence));
  const marginItem = completeMargin ? scored(marginDef, point(marginRange), economics, { score_range: marginRange, evidence: marginEvidence,
    scenario_scores: scenarios.map(s => ({ id: s.id, value: s.margin.value, score: s.margin_score, ...(isR59 ? { margin_eligible: s.margin_eligible } : {}) })),
    ...(diagnostics.crossing_margin_floor ? { crossing_margin_floor: true } : {}) }) :
    missing(marginDef, marginReason, economics, { evidence: marginEvidence, status: marginStatus === 'fail' ? 'ineligible' : 'needs_evidence' });
  const contributionItem = completeContribution ? scored(contributionDef, point(contributionRange), economics,
    { score_range: contributionRange, evidence: contributionEvidence, scenario_scores: scenarios.map(s => ({ id: s.id, value: s.contribution.value, score: s.contribution_score })) }) :
    missing(contributionDef, completeMargin ? 'Every coherent eligible scenario needs supported nonnegative unit contribution.' : marginReason, economics,
      { evidence: contributionEvidence, status: marginStatus === 'fail' ? 'ineligible' : 'needs_evidence' });
  const supportedRange = completeMargin ? span(scenarios.map(s => s.margin_score + (completeContribution ? s.contribution_score : 0))) : [0, 0];
  let conditionalRange = [0, marginDef.weight + contributionDef.weight];
  if (marginStatus === 'fail') conditionalRange = null;
  else if (completeMargin) {
    const ranges = scenarios.map(s => [s.margin_score + (s.contribution_score ?? 0), s.margin_score + (s.contribution_score ?? contributionDef.weight)]);
    conditionalRange = [Math.min(...ranges.map(range => range[0])), Math.max(...ranges.map(range => range[1]))];
  }
  diagnostics.reason = marginReason;
  if (isR58) {
    diagnostics.structural_reason = structuralReason;
    diagnostics.expected_structural_error = outerStructuralReason;
  }
  return { margin: marginItem, contribution: contributionItem, supported_range: supportedRange, conditional_range: conditionalRange,
    screening: { id: 'margin', status: marginStatus, reason: marginReason, range: diagnostics.margin_range }, diagnostics };
}

function screenCandidate(candidate, ctx, profit, items, profile) {
  const priceInput = candidate.screening?.reference_price_usd;
  const isR58 = profile.revision >= 58;
  const r58Anchor = isR58 ? validateR58PriceAnchor(priceInput, ctx) : null;
  const price = isR58 ? { value: r58Anchor.value } : readNumber(priceInput, 'USD', ctx, { min: Number.MIN_VALUE });
  const priceSupported = isR58 ? r58Anchor.supported : (price.value !== null && priceInput.matched_spec === true);
  const priceRule = profile.reference_screening.comparable_reference_price;
  const useInclusivePrice = profile.revision >= 57;
  const pricePass = priceSupported && (useInclusivePrice
    ? price.value >= priceRule.minimum_inclusive
    : price.value > priceRule.strictly_greater_than);
  const date = candidate.screening?.strong_date_dependency;
  const dateSupported = typeof date?.value === 'boolean' && date.unit === 'boolean' && hasEvidence(date.evidence, ctx) &&
    date.supported !== false && date.material_conflict !== true;
  const rights = items.find(item => item.id === 'specific_design_rights');
  const conditions = [
    { id: 'reference_price', status: priceSupported ? pricePass ? 'pass' : 'fail' : 'pending', input: priceInput ?? null,
      reason: priceSupported
        ? (useInclusivePrice
          ? (pricePass ? `Supported matched-spec reference price is at least USD ${priceRule.minimum_inclusive}.` : `Supported matched-spec reference price is below USD ${priceRule.minimum_inclusive}.`)
          : (pricePass ? 'Supported matched-spec reference price is above USD 30.' : 'Supported matched-spec reference price does not exceed USD 30.'))
        : (isR58 ? r58Anchor.reason : null) ?? priceInput?.reason ?? 'A supported positive matched-spec reference price is required.' },
    profit.screening,
    { id: 'specific_form_rights', status: rights.status === 'scored' ? rights.score === 0 ? 'fail' : 'pass' : 'pending',
      reason: rights.reason, evidence: rights.evidence },
    { id: 'strong_date_dependency', status: dateSupported ? date.value ? 'defer' : 'pass' : 'pending', input: date ?? null,
      reason: dateSupported ? date.value ? 'The supported strong holiday/date dependency is deferred in this reference profile.' : 'No strong holiday/date dependency is identified in the supported initial check.' :
        date?.reason ?? 'Strong date dependency has not been assessed with supported evidence.' },
  ];
  const status = conditions.some(condition => condition.status === 'fail') ? 'excluded' :
    conditions.some(condition => condition.status === 'defer') ? 'deferred' :
      conditions.some(condition => condition.status === 'pending') ? 'pending' :
        conditions.some(condition => condition.status === 'crossing_pass') ? 'crossing_eligible' : 'eligible';
  return { status, conditions };
}

function aggregate(items, definitionsByGroup, profit) {
  const supported = items.filter(item => item.status === 'scored');
  const supportedRange = addRanges(supported.filter(item => item.group !== 'profit').reduce((sum, item) => addRanges(sum, item.score_range), [0, 0]), profit.supported_range);
  const covered = supported.reduce((sum, item) => sum + item.weight, 0);
  return {
    supported_range: supportedRange, covered_weight: covered, unscored_weight: 100 - covered,
    groups: definitionsByGroup.map(group => {
      const members = items.filter(item => item.group === group.id);
      const known = members.filter(item => item.status === 'scored');
      const range = group.id === 'profit' ? profit.supported_range : known.reduce((sum, item) => addRanges(sum, item.score_range), [0, 0]);
      const weight = known.reduce((sum, item) => sum + item.weight, 0);
      return { id: group.id, weight: group.weight, supported_range: range, covered_weight: weight,
        unscored_weight: group.weight - weight, score: weight === group.weight ? point(range) : null,
        score_range: weight === group.weight ? range : null };
    }),
  };
}

function validateOperatingPeriods(economics, isR58 = false) {
  const periods = economics.operating_periods;
  if (Object.hasOwn(economics, 'scenarios')) {
    throw new TypeError('Operating-period economics cannot also contain root scenarios; put every scenario in its period.');
  }
  if (!text(economics.saleable_unit) || !Array.isArray(periods) || periods.length === 0) {
    throw new TypeError('Operating-period economics require one common saleable unit and a nonempty operating_periods array.');
  }
  const ids = new Set();
  const months = new Set();
  for (const period of periods) {
    const allowEmptyWithExpected = isR58 && Array.isArray(period?.scenarios) && period.scenarios.length === 0 &&
      (period.expected_primary_scenarios !== undefined || economics.expected_primary_scenarios !== undefined);
    if (!text(period?.id) || ids.has(period.id) || !text(period.label) || !Array.isArray(period.months) ||
      period.months.length === 0 || !Array.isArray(period.scenarios) || (period.scenarios.length === 0 && !allowEmptyWithExpected)) {
      throw new TypeError('Every operating period needs a unique nonempty id, label, explicit months and a nonempty scenarios array.');
    }
    ids.add(period.id);
    for (const month of period.months) {
      if (!Number.isInteger(month) || month < 1 || month > 12 || months.has(month)) {
        throw new TypeError('Operating-period months must be unique integers from 1 to 12, without overlap within or between periods.');
      }
      months.add(month);
    }
    const scenarioIds = new Set();
    for (const scenario of period.scenarios) {
      if (!text(scenario?.id) || scenarioIds.has(scenario.id) || scenario.saleable_unit !== economics.saleable_unit ||
        !Array.isArray(scenario.assumptions) || !scenario.assumptions.length || !scenario.assumptions.every(text)) {
        throw new TypeError('Operating-period scenarios need unique ids, the common saleable unit and explicit assumptions.');
      }
      // The ordinary scorer retains incomplete costs and unsupported coherence as period-level evidence gaps.
      scenarioIds.add(scenario.id);
    }
  }
}

const PRIMARY_OFF_PEAK_MONTHS = [2, 3, 4, 5, 6, 7, 8, 9];
const HOLIDAY_PEAK_MONTHS = [10, 11, 12];

function validIsoWindow(w) {
  return Boolean(w && validDate(w.from) && validDate(w.through) && w.from <= w.through);
}

function monthsInIsoWindow(w) {
  if (!validIsoWindow(w)) return [];
  const res = new Set();
  let y = Number(w.from.slice(0, 4)), m = Number(w.from.slice(5, 7));
  const ly = Number(w.through.slice(0, 4)), lm = Number(w.through.slice(5, 7));
  while (y < ly || (y === ly && m <= lm)) {
    res.add(m);
    if (++m > 12) { m = 1; y++; }
    if (res.size === 12) break;
  }
  return [...res].sort((a, b) => a - b);
}

function coversPrimaryOffPeakScenario(scenario) {
  const ctx = scenario?.input?.cost_ledger?.fee_context;
  const calc = scenario?.input?.calculation;
  if (!ctx || !calc?.scoring_supported || calc.fee_validation?.status !== 'validated') return false;
  return ctx.sales?.from === '2027-02-01' && ctx.sales?.through === '2027-09-30' &&
    ctx.storage?.from === '2027-02-01' && ctx.storage?.through === '2027-09-30' &&
    ctx.inbound?.from >= '2027-01-15' && ctx.inbound?.through <= '2027-09-30';
}

function coversPrimaryOffPeakDates(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return false;
  for (const scenario of scenarios) {
    const ctx = scenario?.input?.cost_ledger?.fee_context;
    if (!ctx || !validIsoWindow(ctx.sales) || !validIsoWindow(ctx.storage) || !validIsoWindow(ctx.inbound)) return false;
    if (ctx.sales.from !== '2027-02-01' || ctx.sales.through !== '2027-09-30' ||
      ctx.storage.from !== '2027-02-01' || ctx.storage.through !== '2027-09-30' ||
      ctx.inbound.from < '2027-01-15' || ctx.inbound.through > '2027-09-30') {
      return false;
    }
  }
  return true;
}

function hasExactPeakMonthsR58(period) {
  if (!period || !Array.isArray(period.months)) return false;
  const sorted = [...period.months].sort((a, b) => a - b);
  return sorted.length === 3 && sorted[0] === 10 && sorted[1] === 11 && sorted[2] === 12;
}

/**
 * Returns null when the period is a valid 2027 companion holiday peak panel, otherwise the first
 * concrete reason (missing/pending cost line, failed binding or date mismatch). Validity rules are
 * identical to the former boolean check; only the diagnostic wording is added.
 */
function diagnoseCompanionPeakPanelR58(period) {
  if (!hasExactPeakMonthsR58(period)) return 'panel does not cover exact months [10, 11, 12]';
  if (period.diagnostics?.economics?.expected_structural_error) return 'expected primary scenario structure is invalid';
  const scenarios = period.diagnostics?.economics?.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return 'panel has no dated cost_ledger scenarios';
  const allowedPeakPending = new Set(['fulfillment', 'collection']);
  const allowedPublishedFulfillmentIssues = new Set(['fee_outside_dates', 'fee_season_mismatch']);
  const scenarioReason = sc => {
    const ledger = sc?.input?.cost_ledger;
    const calc = sc?.input?.calculation;
    const ctx = ledger?.fee_context;
    if (!ledger || !calc || ledger.id !== sc.id || !ctx) return 'cost_ledger, calculation or fee_context is missing or not bound to the scenario id';
    if (!(ledger.sensitivity_only === undefined || ledger.sensitivity_only === false)) return 'ledger is sensitivity-only';
    if (sc?.input?.coherent !== true) return 'scenario is not coherent';
    if (sc.price_anchor_supported === false) return 'price anchor is not supported';
    if (!Array.isArray(ledger.lines)) return 'cost lines are missing';
    const presentIds = new Set(ledger.lines.map(l => l?.id));
    const missingIds = REQUIRED_COSTS.filter(reqId => !presentIds.has(reqId));
    if (missingIds.length) return `required cost lines missing: ${missingIds.join(', ')}`;
    if (ctx.marketplace !== 'US' || ctx.currency !== 'USD' || !text(ctx.package_ref)) return 'fee_context marketplace/currency/package_ref binding is invalid';
    if (!validIsoWindow(ctx.sales) || !validIsoWindow(ctx.storage) || !validIsoWindow(ctx.inbound)) return 'sales/storage/inbound fee windows are invalid';
    if (!ctx.sales.from.startsWith('2027-') || !ctx.sales.through.startsWith('2027-') ||
      !ctx.storage.from.startsWith('2027-') || !ctx.storage.through.startsWith('2027-')) return 'sales/storage windows are not in 2027';
    if (ctx.inbound.from < '2027-01-15' || ctx.inbound.through > ctx.sales.through) return 'inbound window falls outside 2027-01-15..sales end';
    const fulLine = ledger.lines.find(l => l?.id === 'fulfillment');
    const fulBasis = fulLine?.fee_basis;
    if (!fulBasis || typeof fulBasis !== 'object' || !['unavailable', 'published'].includes(fulBasis.status)) return 'fulfillment fee_basis must be published or unavailable';
    const fulIssues = (calc.fee_validation?.issues ?? []).filter(issue => issue.line === 'fulfillment');
    const fulBinding = 'late-2027 peak fulfillment fee_basis binding is invalid';
    if (fulBasis.status === 'unavailable') {
      if (!text(fulBasis.version) || fulLine.status !== 'pending' || fulLine.amount_usd !== null) return `${fulBinding} (unavailable basis needs version, pending status and null amount)`;
      if (fulBasis.marketplace !== undefined && fulBasis.marketplace !== 'US') return `${fulBinding} (marketplace)`;
      if (fulBasis.currency !== undefined && fulBasis.currency !== 'USD') return `${fulBinding} (currency)`;
      if (fulBasis.package_ref !== undefined && fulBasis.package_ref !== ctx.package_ref) return `${fulBinding} (package_ref)`;
      if (fulBasis.year !== undefined && fulBasis.year !== 2027) return `${fulBinding} (year)`;
      if (/\b20(?!27)\d{2}\b/.test(fulBasis.version) && !/\b2027\b/.test(fulBasis.version)) return `${fulBinding} (version year)`;
      if (fulBasis.effective_from !== undefined && fulBasis.effective_from !== null) {
        if (!validDate(fulBasis.effective_from) || fulBasis.effective_from > '2027-12-31') return `${fulBinding} (effective_from)`;
      }
      if (fulBasis.effective_through !== undefined && fulBasis.effective_through !== null) {
        if (!validDate(fulBasis.effective_through) || fulBasis.effective_through < '2027-10-01' || fulBasis.effective_through > '2028-01-14') return `${fulBinding} (effective_through)`;
        if (validDate(fulBasis.effective_from) && fulBasis.effective_through < fulBasis.effective_from) return `${fulBinding} (effective dates reversed)`;
      }
      if (fulBasis.months !== undefined) {
        if (!Array.isArray(fulBasis.months) || !fulBasis.months.length ||
          fulBasis.months.some(m => !Number.isInteger(m) || m < 1 || m > 12) ||
          !fulBasis.months.some(m => m >= 10 && m <= 12)) return `${fulBinding} (months)`;
      }
    } else {
      // Published fulfillment on peak: either complete & valid for 2027 holiday peak (effective_through up to 2028-01-14),
      // OR a genuine 2027 non-peak schedule cutting off at/after Oct 1, 2027.
      if (!validDate(fulBasis.effective_from) || !validDate(fulBasis.effective_through) ||
        fulBasis.effective_through < fulBasis.effective_from ||
        fulBasis.effective_from > '2027-12-31' ||
        fulBasis.effective_through < '2027-10-01' ||
        fulBasis.effective_through > '2028-01-14') return `${fulBinding} (published effective dates)`;
      if (fulBasis.months !== undefined && (!Array.isArray(fulBasis.months) || !fulBasis.months.length ||
        fulBasis.months.some(m => !Number.isInteger(m) || m < 1 || m > 12))) return `${fulBinding} (published months)`;
      const fulIsPending = fulLine.status === 'pending' || fulLine.amount_usd === null;
      if (fulIsPending && fulIssues.length === 0) return 'published covering 2027 peak fulfillment rate is left pending/null'; // Covering 2027 peak rate cannot be left pending/null!
    }
    // Only late-2027 holiday peak fulfillment unavailability/date-cutoff (and payout-dependent collection) may remain pending on the companion peak panel.
    const validFulIssue = issue => issue.line === 'fulfillment' && (
      (fulBasis.status === 'unavailable' && issue.code === 'unpublished_fee') ||
      (fulBasis.status === 'published' && allowedPublishedFulfillmentIssues.has(issue.code))
    );
    const badIssues = (calc.fee_validation?.issues ?? []).filter(issue => !validFulIssue(issue));
    if (badIssues.length) return `fee validation issues: ${[...new Set(badIssues.map(i => `${i.line ?? 'ledger'}:${i.code ?? 'issue'}`))].join(', ')}`;
    const badPending = Array.isArray(calc.pending_lines) ? calc.pending_lines.filter(id => !allowedPeakPending.has(id)) : [];
    if (badPending.length) return `pending cost inputs: ${badPending.join(', ')} (only late-2027 peak fulfillment and collection may remain pending)`;
    const sm = monthsInIsoWindow(ctx.sales);
    const stm = monthsInIsoWindow(ctx.storage);
    const monthsOk = sm.length === 3 && sm[0] === 10 && sm[1] === 11 && sm[2] === 12 &&
      stm.length === 3 && stm[0] === 10 && stm[1] === 11 && stm[2] === 12;
    return monthsOk ? null : 'sales/storage windows do not cover exactly Oct–Dec';
  };
  for (const sc of scenarios) {
    const reason = scenarioReason(sc);
    if (reason !== null) return `scenario ${text(sc?.id) ? sc.id : '(unnamed)'}: ${reason}`;
  }
  return null;
}

function isValidCompanionPeakPanelR58(period) {
  return diagnoseCompanionPeakPanelR58(period) === null;
}

function coversFullCalendarYearDates(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) return false;
  let targetYear = null;
  for (const scenario of scenarios) {
    const ctx = scenario?.input?.cost_ledger?.fee_context;
    if (!ctx || !validIsoWindow(ctx.sales) || !validIsoWindow(ctx.storage) || !validIsoWindow(ctx.inbound)) return false;
    const y = ctx.sales.from.slice(0, 4);
    if (!/^\d{4}$/.test(y)) return false;
    if (targetYear === null) targetYear = y;
    else if (targetYear !== y) return false;
    if (ctx.sales.from !== `${y}-01-01` || ctx.sales.through !== `${y}-12-31` ||
      ctx.storage.from !== `${y}-01-01` || ctx.storage.through !== `${y}-12-31` ||
      ctx.inbound.from > ctx.sales.through) {
      return false;
    }
  }
  return targetYear !== null;
}

function mergeExpectedPrimaryScenarios(rootList, periodList) {
  if (rootList === undefined) return periodList;
  if (periodList === undefined) return rootList;
  if (!Array.isArray(rootList) || !Array.isArray(periodList)) return [];
  const byId = new Map();
  const extras = [];
  for (const entry of rootList) {
    if (entry && typeof entry === 'object' && text(entry.id) &&
      ['active', 'cancelled'].includes(entry.status) && !byId.has(entry.id)) {
      byId.set(entry.id, entry);
    } else {
      extras.push(entry);
    }
  }
  const periodSeen = new Set();
  for (const entry of periodList) {
    if (!entry || typeof entry !== 'object' || !text(entry.id) ||
      !['active', 'cancelled'].includes(entry.status) || periodSeen.has(entry.id)) {
      extras.push(entry);
      continue;
    }
    periodSeen.add(entry.id);
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
    } else if (existing.status === 'active') {
      // Period may keep active or refine an inherited active id into an evidenced cancellation (validated in scoreEconomics).
      byId.set(entry.id, entry);
    } else if (entry.status === 'cancelled' && existing.status === 'cancelled') {
      byId.set(entry.id, entry);
    } else {
      // Contradictory cancelled-vs-active merge: emit both so scoreEconomics rejects regardless of input order.
      extras.push(entry);
    }
  }
  return [...byId.values(), ...extras];
}

function canonicalJsonStable(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(canonicalJsonStable).join(',')}]`;
  const entries = Object.keys(val).sort().filter(k => val[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJsonStable(val[k])}`);
  return `{${entries.join(',')}}`;
}

function mergeStressScenarios(rootList, periodList) {
  if (!Array.isArray(rootList) && !Array.isArray(periodList)) return undefined;
  const dedupLayer = list => {
    const byId = new Map();
    const unnamed = [];
    for (const sc of (Array.isArray(list) ? list : [])) {
      if (text(sc?.id)) {
        const prev = byId.get(sc.id);
        if (!prev) byId.set(sc.id, sc);
        else {
          // Deterministic key-order-independent canonical tie-break for duplicate same-layer IDs.
          const pA = number(prev?.cost_ledger?.price_usd ?? prev?.price_usd) ? (prev.cost_ledger?.price_usd ?? prev.price_usd) : Infinity;
          const pB = number(sc?.cost_ledger?.price_usd ?? sc?.price_usd) ? (sc.cost_ledger?.price_usd ?? sc.price_usd) : Infinity;
          if (pB < pA || (pB === pA && compareText(canonicalJsonStable(sc), canonicalJsonStable(prev)) < 0)) {
            byId.set(sc.id, sc);
          }
        }
      } else {
        unnamed.push(sc);
      }
    }
    return [...byId.entries()].sort((a, b) => compareText(a[0], b[0])).map(([, v]) => v).concat(unnamed);
  };
  const merged = [];
  const seen = new Set();
  for (const sc of dedupLayer(periodList)) {
    if (text(sc?.id)) seen.add(sc.id);
    merged.push(sc);
  }
  for (const sc of dedupLayer(rootList)) {
    if (text(sc?.id) && seen.has(sc.id)) continue;
    if (text(sc?.id)) seen.add(sc.id);
    merged.push(sc);
  }
  return merged;
}

function comparePeriodOrder(a, b) {
  return Math.min(...a.months) - Math.min(...b.months) || compareText(a.id, b.id);
}

function compareRangeDesc(ra, rb) {
  const a0 = Array.isArray(ra) && number(ra[0]) ? ra[0] : -Infinity;
  const b0 = Array.isArray(rb) && number(rb[0]) ? rb[0] : -Infinity;
  if (b0 !== a0) return b0 - a0;
  const a1 = Array.isArray(ra) && number(ra[1]) ? ra[1] : -Infinity;
  const b1 = Array.isArray(rb) && number(rb[1]) ? rb[1] : -Infinity;
  return b1 - a1;
}

function selectDisplayPeriodR58(periods, primaryPeriodId) {
  if (!periods.length) return null;
  if (primaryPeriodId && periods.some(p => p.id === primaryPeriodId)) return primaryPeriodId;
  const offPeakCover = periods
    .filter(p => PRIMARY_OFF_PEAK_MONTHS.every(m => p.months.includes(m)))
    .sort(comparePeriodOrder);
  if (offPeakCover.length) return offPeakCover[0].id;
  const ranked = [...periods].sort((a, b) =>
    ((b.covered_weight ?? -1) - (a.covered_weight ?? -1)) ||
    compareRangeDesc(a.supported_range, b.supported_range) ||
    comparePeriodOrder(a, b));
  return ranked[0].id;
}

function buildSeasonalQualificationR58(periods, isR59 = false, isPrivateMoldReserved = false) {
  if (isR59 && isPrivateMoldReserved) {
    const displayId = selectDisplayPeriodR58(periods, null);
    return {
      counts_toward_target: false,
      mode: 'private_mold_reserved',
      primary_period_id: null,
      display_period_id: displayId,
      reasons: ['Candidate is routed to private_mold_reserved (no open 1688 public mold verified) and never counts toward ready-stock qualifying target.'],
    };
  }
  const hasPeakPanel = periods.some(isValidCompanionPeakPanelR58);
  const offPeakCandidates = periods.filter(period =>
    period.queue === 'comparable' &&
    period.months.length === PRIMARY_OFF_PEAK_MONTHS.length &&
    PRIMARY_OFF_PEAK_MONTHS.every(month => period.months.includes(month)) &&
    period.diagnostics?.economics?.scenarios?.length > 0 &&
    period.diagnostics.economics.scenarios.every(coversPrimaryOffPeakScenario) &&
    period.screening?.conditions?.find(condition => condition.id === 'strong_date_dependency')?.status === 'pass',
  ).sort(comparePeriodOrder);

  if (hasPeakPanel && offPeakCandidates.length > 0) {
    const primary = offPeakCandidates[0];
    return {
      counts_toward_target: true,
      mode: 'seasonal_eligible',
      primary_period_id: primary.id,
      display_period_id: primary.id,
      reasons: ['Primary 2027-02-01..2027-09-30 off-peak period is complete (21/21) and comparable with companion Oct–Dec 2027 peak panel.'],
    };
  }

  if (isR59 && hasPeakPanel) {
    const crossingOffPeak = periods.filter(period =>
      Array.isArray(period.total_range) &&
      period.diagnostics?.economics?.crossing_margin_floor === true &&
      period.months.length === PRIMARY_OFF_PEAK_MONTHS.length &&
      PRIMARY_OFF_PEAK_MONTHS.every(month => period.months.includes(month)) &&
      period.diagnostics?.economics?.scenarios?.length > 0 &&
      period.diagnostics.economics.scenarios.every(coversPrimaryOffPeakScenario) &&
      period.screening?.conditions?.find(condition => condition.id === 'strong_date_dependency')?.status === 'pass',
    ).sort(comparePeriodOrder);
    if (crossingOffPeak.length > 0) {
      const primary = crossingOffPeak[0];
      return {
        counts_toward_target: false,
        crossing_30pct_actionable: true,
        mode: 'crossing_30pct_interval',
        primary_period_id: primary.id,
        display_period_id: primary.id,
        reasons: ['Primary 2027-02-01..2027-09-30 off-peak period is 21/21 scored across a crossing-30% scenario interval with companion Oct–Dec 2027 peak panel (held separate from strict all-scenario qualifying count).'],
      };
    }
  }

  const reasons = [];
  if (!hasPeakPanel) {
    const nominalPeak = periods.filter(hasExactPeakMonthsR58).sort(comparePeriodOrder)[0];
    if (nominalPeak) {
      reasons.push(`Companion 2027 holiday peak panel (${nominalPeak.id}) is present with exact months [10, 11, 12], but its cost/fulfillment inputs are incomplete: ${diagnoseCompanionPeakPanelR58(nominalPeak)}.`);
    } else {
      reasons.push('Missing valid 2027 companion holiday peak operating panel covering exact months [10, 11, 12] with dated cost_ledger.');
    }
  }
  const nominalOffPeak = periods.find(p => p.months.length === PRIMARY_OFF_PEAK_MONTHS.length &&
    PRIMARY_OFF_PEAK_MONTHS.every(m => p.months.includes(m)));
  if (!nominalOffPeak) {
    reasons.push('Missing primary off-peak operating panel covering all months 2 through 9.');
  } else {
    if (nominalOffPeak.queue !== 'comparable') reasons.push(`Primary off-peak panel (${nominalOffPeak.id}) has queue ${nominalOffPeak.queue}, not comparable.`);
    if (!nominalOffPeak.diagnostics?.economics?.scenarios?.length ||
      !nominalOffPeak.diagnostics.economics.scenarios.every(coversPrimaryOffPeakScenario)) {
      reasons.push(`Primary off-peak panel (${nominalOffPeak.id}) does not cover full 2027-02-01..2027-09-30 validated scenarios.`);
    }
    if (nominalOffPeak.screening?.conditions?.find(c => c.id === 'strong_date_dependency')?.status !== 'pass') {
      reasons.push('Strong date dependency did not pass on the primary off-peak panel.');
    }
  }
  const displayId = selectDisplayPeriodR58(periods, null);
  return {
    counts_toward_target: false,
    mode: 'none',
    primary_period_id: null,
    display_period_id: displayId,
    reasons,
  };
}

const SENSITIVE_FREEBIE_PATTERNS = [
  { key: 'oil', pattern: /\b(oils?|lubricants?|grease|liquids?|resins?)\b|润滑油|机油|液体/i, label: '含油脂／液体赠品（需核查危险品／MSDS／清关）' },
  { key: 'glue', pattern: /\b(glues?|adhesives?|epox(?:y|ies)|sealants?|solvents?)\b|胶水|粘合剂|环氧|溶剂/i, label: '含胶水／粘合剂赠品（敏感品／危险品核查）' },
  { key: 'battery', pattern: /\b(batter(?:y|ies)|lithium|li-ion|coin\s*cells?|button\s*cells?|power\s*banks?)\b|锂电|纽扣电池|电池/i, label: '含电池／纽扣电池（需 UN38.3 / UL4200A / 危险品审）' },
  { key: 'magnet', pattern: /\b(strong\s*magnets?|neodymium|magnets?|n52|n35)\b|强磁|钕磁|磁铁/i, label: '含磁铁／强磁件（需磁检或航空限制核查）' },
  { key: 'powder', pattern: /\b(powders?|pastes?|creams?|chemicals?)\b|粉末|膏体|化学/i, label: '含粉末／膏体／化学品（需 MSDS 核查）' },
];
// Clause boundaries for freebie text: sentence punctuation and contrast words ("不含电池，但附带润滑油").
const FREEBIE_CLAUSE_SPLIT = /[。；;!?！？\n]|\b(?:but|however|yet|though|although)\b|但是|但|然而|不过/i;
// Prohibition cues; the last cue before a keyword negates it unless a later unnegated affirmative verb re-opens inclusion.
const FREEBIE_NEGATION_CUE_G = /严禁|禁止|不含|不附带|不附|不带|不得|切勿|勿|排除|剔除|去除|不要|不包括|不包含|不配|无需|拒绝|避免|未附|未含|未配|\bno\b|\bnot\b|\bnever\b|\bnon[- ]|\bwithout\b|\bexclud\w*|\bforbid\w*|\bprohibit\w*|\bfree\s+(?:of|from)\b|\bmust\s+not\b/gi;
const FREEBIE_AFFIRMATIVE_CUE_G = /(?<!严禁|禁止|不得|切勿|不要|拒绝|避免|排除|剔除|[不无免勿未])(?:附带|附送|赠送|含有|内含|包含|配有|随附|自带|另送|加送)|(?<!\b(?:not|never|without|no|forbid|forbids|forbidden|prohibit|prohibits|prohibited)\s+(?:to\s+|be\s+)?)\b(?:includes?|including|comes\s+with|supplied\s+with|packaged\s+with)\b/gi;
const FREEBIE_NEGATION_CUE = { test: prefix => lastMatchIndex(FREEBIE_NEGATION_CUE_G, prefix) > lastMatchIndex(FREEBIE_AFFIRMATIVE_CUE_G, prefix) };
// Waiting / pre-verification cues that prevent a tolerance note from marking packaging status as 'clear'.
const PENDING_TOLERANCE_CUE = /待|尚缺|未核|未经|打样前|下单前|报价前|报价后|报价阶段|询盘|\b(?:waiting|pending|tbd|unverified|awaiting)\b|\bto\s+be\s+(?:verified|checked|confirmed)\b/i;
function lastMatchIndex(re, s) {
  let last = -1;
  for (const m of String(s).matchAll(re)) last = m.index;
  return last;
}

/**
 * Deterministic 6-point operational risk disclosure engine (Revision 58, 04 §5.4).
 * Zero-veto: purely diagnostic disclosures rendered on decision cards without altering 21-item scores.
 */
function buildOperationalDisclosuresR58(candidate, scenarios = []) {
  const ops = candidate?.operations && typeof candidate.operations === 'object' ? candidate.operations : {};
  const firstLedger = scenarios.find(s => s?.input?.cost_ledger)?.input?.cost_ledger ?? null;
  const si = firstLedger?.source_inputs && typeof firstLedger.source_inputs === 'object' ? firstLedger.source_inputs : {};
  const lines = Array.isArray(firstLedger?.lines) ? firstLedger.lines : [];
  const procLine = lines.find(l => l?.id === 'procurement') ?? null;
  const domLine = lines.find(l => l?.id === 'domestic_freight') ?? null;
  const hhLine = lines.find(l => l?.id === 'headhaul') ?? null;
  const procurementQuotePending = (!procLine || procLine.status === 'pending' || !number(procLine.amount_usd)) &&
    !(ops.quote && typeof ops.quote === 'object');

  // (1) Batch cash tie-up + lead_time_days + sku_lines / actual_complete_sets / remainder + MOQ >= 300 alert
  const orderPlan = ops.order_plan && typeof ops.order_plan === 'object' ? ops.order_plan : null;
  const orderUnits = [ops.order_units, orderPlan?.allocated_sets, ops.actual_complete_sets, procLine?.order_units, domLine?.order_units, si.order_units, si.complete_saleable_sets]
    .find(v => Number.isSafeInteger(v) && v > 0) ?? null;
  const skuLines = Array.isArray(ops.sku_lines) ? ops.sku_lines
    : Array.isArray(orderPlan?.sku_lines) ? orderPlan.sku_lines
      : Array.isArray(ops.quote?.sku_lines) ? ops.quote.sku_lines
        : Array.isArray(procLine?.sku_lines) ? procLine.sku_lines
          : Array.isArray(si.sku_lines) ? si.sku_lines : [];
  const hasVerifiedSkuLines = Array.isArray(skuLines) && skuLines.length > 0 &&
    skuLines.every(l => number(l?.ordered_qty) && l.ordered_qty > 0 && number(l?.qty_per_saleable_set) && l.qty_per_saleable_set > 0);
  const hasOrderPlanSets = Number.isSafeInteger(orderPlan?.actual_complete_sets) && orderPlan.actual_complete_sets > 0;
  const actualCompleteSets = hasOrderPlanSets ? orderPlan.actual_complete_sets
    : hasVerifiedSkuLines ? Math.min(...skuLines.map(l => Math.floor(l.ordered_qty / l.qty_per_saleable_set)))
      : procurementQuotePending ? null
        : ([ops.actual_complete_sets, si.actual_complete_sets].find(v => Number.isSafeInteger(v) && v > 0) ?? orderUnits);
  const remainderUnits = (!procurementQuotePending && number(ops.remainder_units) && ops.remainder_units >= 0)
    ? ops.remainder_units
    : number(orderPlan?.total_remainder_pieces) && orderPlan.total_remainder_pieces >= 0
      ? orderPlan.total_remainder_pieces
      : (hasVerifiedSkuLines && actualCompleteSets !== null
        ? skuLines.reduce((sum, l) => {
          const req = number(l?.qty_per_saleable_set) && l.qty_per_saleable_set > 0 ? l.qty_per_saleable_set : 1;
          const ord = number(l?.ordered_qty) && l.ordered_qty >= 0 ? l.ordered_qty : 0;
          return sum + Math.max(0, ord - actualCompleteSets * req);
        }, 0)
        : (procurementQuotePending ? null : 0));
  const leadTimeDays = [ops.lead_time_days, ops.production_lead_time_days, ops.quote?.lead_time_days, si.lead_time_days]
    .find(v => number(v) && v >= 0) ?? null;
  const perUnitCashUsd = [procLine?.amount_usd, domLine?.amount_usd, hhLine?.amount_usd]
    .every(v => number(v) && v >= 0)
    ? (procLine.amount_usd + domLine.amount_usd + hhLine.amount_usd)
    : null;
  const effectiveSetsForCash = actualCompleteSets ?? (procurementQuotePending && perUnitCashUsd === null ? null : orderUnits);
  // Purchase-to-set lineage: purchased pieces / declared purchase SKUs beyond the saleable-set count reveal a
  // multi-piece or multi-SKU combination even when no structured sku_lines were carried (e.g. 200 pcs -> 100 sets).
  const positiveInt = v => Number.isSafeInteger(v) && v > 0;
  const lineageTexts = [
    procLine?.basis,
    ops.quote?.note,
    ...(Array.isArray(firstLedger?.assumptions) ? firstLedger.assumptions : []),
  ].filter(text);
  let textPurchaseUnits = null;
  let textCompleteSets = null;
  let textPurchaseSkus = null;
  for (const lt of lineageTexts) {
    const eqMatch = String(lt).match(/(\d+)\s*采购[只件个]\s*[=＝]\s*([^=＝；;。\n]+?)\s*[=＝]\s*(\d+)\s*(?:完整销售)?套/);
    if (eqMatch) {
      textPurchaseUnits ??= Number(eqMatch[1]);
      textCompleteSets ??= Number(eqMatch[3]);
      const parts = eqMatch[2].split(/[＋+]/).filter(p => /\d+\s*[只件个]/.test(p));
      if (parts.length > 1) textPurchaseSkus ??= parts.length;
    }
    const slashMatch = String(lt).match(/单笔\s*(\d+)\s*[只件个]\s*[/／]\s*(\d+)\s*(?:完整销售)?套/);
    if (slashMatch) {
      textPurchaseUnits ??= Number(slashMatch[1]);
      textCompleteSets ??= Number(slashMatch[2]);
    }
    const skuCntMatch = String(lt).match(/(\d+)\s*个?采购\s*SKU|\b(\d+)\s+purchase\s+SKUs?\b/i);
    if (skuCntMatch) textPurchaseSkus ??= Number(skuCntMatch[1] ?? skuCntMatch[2]);
  }
  const purchaseUnits = [ops.purchase_units, ops.purchased_units, ops.purchased_pieces, orderPlan?.purchase_units,
    ops.quote?.purchase_units, ops.quote?.purchased_pieces, procLine?.purchase_units, procLine?.purchased_pieces,
    si.purchase_units, si.purchased_units, si.purchased_pieces, textPurchaseUnits]
    .find(positiveInt) ?? null;
  const declaredSkuList = [ops.purchase_skus, orderPlan?.purchase_skus, ops.quote?.purchase_skus, procLine?.purchase_skus, si.purchase_skus]
    .find(v => Array.isArray(v) && v.length > 0) ?? null;
  const declaredPurchaseSkuCount = [ops.purchase_sku_count, orderPlan?.purchase_sku_count, ops.quote?.purchase_sku_count,
    procLine?.purchase_sku_count, si.purchase_sku_count, declaredSkuList?.length, textPurchaseSkus]
    .find(positiveInt) ?? null;
  const setsBasisForPurchase = [si.complete_saleable_sets, actualCompleteSets, orderUnits, textCompleteSets].find(positiveInt) ?? null;
  const purchaseUnitsPerSet = purchaseUnits !== null && setsBasisForPurchase !== null
    ? Math.round((purchaseUnits / setsBasisForPurchase) * 1000) / 1000 : null;
  const purchaseExceedsSets = purchaseUnits !== null && setsBasisForPurchase !== null && purchaseUnits > setsBasisForPurchase;
  const purchaseLineageNote = purchaseExceedsSets
    ? `（采购 ${purchaseUnits} 件组成 ${setsBasisForPurchase} 套，每套 ${purchaseUnitsPerSet} 件${declaredPurchaseSkuCount !== null && declaredPurchaseSkuCount > 1 ? `，${declaredPurchaseSkuCount} 个采购 SKU` : ''}）`
    : (declaredPurchaseSkuCount !== null && declaredPurchaseSkuCount > 1 ? `（${declaredPurchaseSkuCount} 个采购 SKU 组合）` : '');
  const batchCashUsd = number(ops.batch_cash_tie_up_usd) ? ops.batch_cash_tie_up_usd
    : (effectiveSetsForCash !== null && perUnitCashUsd !== null ? Math.round(effectiveSetsForCash * perUnitCashUsd * 100) / 100 : null);
  const fx = [ops.fx_cny_per_usd, procLine?.fx_cny_per_usd, firstLedger?.fx_cny_per_usd, si.fx_cny_per_usd]
    .find(v => number(v) && v > 0) ?? null;
  const batchCashCny = number(ops.batch_cash_tie_up_cny) ? ops.batch_cash_tie_up_cny
    : (batchCashUsd !== null && fx !== null ? Math.round(batchCashUsd * fx * 100) / 100 : null);
  const moqCapitalAlert = (effectiveSetsForCash !== null && effectiveSetsForCash >= 300) || (orderUnits !== null && orderUnits >= 300);
  const cashStatus = moqCapitalAlert || (number(remainderUnits) && remainderUnits > 0) ? 'alert'
    : ((!procurementQuotePending && orderUnits !== null) || actualCompleteSets !== null || batchCashUsd !== null || leadTimeDays !== null) ? 'disclosed' : 'unverified';
  const batchCashDisclosure = {
    id: 'batch_cash_and_moq',
    label: '首批占资、交期与齐套余料',
    status: cashStatus,
    order_units: orderUnits,
    actual_complete_sets: actualCompleteSets,
    sku_line_count: skuLines.length,
    purchase_units: purchaseUnits,
    purchase_units_per_set: purchaseUnitsPerSet,
    declared_purchase_sku_count: declaredPurchaseSkuCount,
    remainder_units: remainderUnits,
    lead_time_days: leadTimeDays,
    batch_cash_tie_up_usd: batchCashUsd,
    batch_cash_tie_up_cny: batchCashCny,
    moq_capital_alert: moqCapitalAlert,
    note: moqCapitalAlert
      ? `起订批次数 ${effectiveSetsForCash ?? orderUnits} 齐套（≥300 套 MOQ 占资预警）${purchaseLineageNote}${batchCashCny !== null ? `，首批货款+头程占资约 ¥${batchCashCny}` : ''}${batchCashUsd !== null ? `（US$ ${batchCashUsd}）` : ''}${leadTimeDays !== null ? `，交期 ${leadTimeDays} 天` : ''}${number(remainderUnits) && remainderUnits > 0 ? `，齐套后余料 ${remainderUnits} 件` : ''}。`
      : effectiveSetsForCash !== null
        ? `首批 ${actualCompleteSets ?? effectiveSetsForCash} 齐套${orderUnits !== null && actualCompleteSets !== null && orderUnits !== actualCompleteSets ? `（分摊口径 ${orderUnits} 套）` : ''}${purchaseLineageNote}${batchCashCny !== null ? `，货款+头程占资约 ¥${batchCashCny}` : ''}${batchCashUsd !== null ? `（US$ ${batchCashUsd}）` : ''}${leadTimeDays !== null ? `，交期 ${leadTimeDays} 天` : ''}${number(remainderUnits) && remainderUnits > 0 ? `；存在齐套余料 ${remainderUnits} 件` : remainderUnits === 0 ? '；完全齐套无余料' : ''}。`
        : '尚缺完整的首批套数、交期或占资明细（不影响主分，下单前核实）。',
  };

  // (2) Offer-bound Amazon 1P presence
  const offersList = Array.isArray(ops.amazon_1p_offers) ? ops.amazon_1p_offers
    : Array.isArray(ops.offers) ? ops.offers
    : Array.isArray(candidate?.market?.offers) ? candidate.market.offers : [];
  const amz1pOffers = offersList.filter(o =>
    o && (
      String(o.seller_type ?? o.seller?.type ?? o.seller?.seller_type ?? '').toUpperCase() === 'AMZ' ||
      o.sold_by_amazon === true ||
      o.is_amazon_1p === true ||
      o.seller?.sold_by_amazon === true
    ),
  );
  const amz1pPresent = ops.amazon_1p_present === true || amz1pOffers.length > 0;
  const amz1pExplicitClear = ops.amazon_1p_present === false || (offersList.length > 0 && amz1pOffers.length === 0);
  const amz1pDisclosure = {
    id: 'amazon_1p_presence',
    label: 'Amazon 1P（自营 Offer 核查）',
    status: amz1pPresent ? 'alert' : amz1pExplicitClear ? 'clear' : 'unverified',
    amazon_1p_present: amz1pPresent ? true : amz1pExplicitClear ? false : null,
    matched_offers: amz1pOffers.map(o => ({ asin: o.asin ?? null, buybox_share: o.buybox_share ?? null, seller_type: o.seller_type ?? o.seller?.type ?? 'AMZ' })),
    note: amz1pPresent
      ? `检测到基于 Offer 实证的 Amazon 1P（Sold by Amazon）在售记录（${amz1pOffers.length || 1} 条）；仅按 Offer 事实提示竞争压力，不作硬否决。`
      : amz1pExplicitClear
        ? '已按具体 Offer 核对，未发现 Amazon 1P（Sold by Amazon）直接占坑。'
        : '尚未提供基于具体 Offer 的 Amazon 1P 核查记录（严禁仅凭品牌名推断自营）。',
  };

  // (3) Parameterized freight billing-weight rules (ZERO private numeric carrier tariff rates hardcoded!)
  const ship = ops.shipment && typeof ops.shipment === 'object' ? ops.shipment : {};
  const actualKg = number(ship.actual_weight_kg) && ship.actual_weight_kg > 0 ? ship.actual_weight_kg : null;
  const cartonCm = Array.isArray(ship.carton_cm) && ship.carton_cm.length === 3 && ship.carton_cm.every(v => number(v) && v > 0)
    ? ship.carton_cm : null;
  const divisor = number(ship.volumetric_divisor) && ship.volumetric_divisor > 0 ? ship.volumetric_divisor : 6000;
  const cartonCount = Number.isSafeInteger(ship.carton_count) && ship.carton_count > 0 ? ship.carton_count : null;
  const volWeightPerCartonKg = cartonCm ? (cartonCm[0] * cartonCm[1] * cartonCm[2]) / divisor : null;
  const totalVolKg = volWeightPerCartonKg !== null ? volWeightPerCartonKg * (cartonCount ?? 1) : null;
  const totalChargeableKg = number(ship.total_chargeable_kg) && ship.total_chargeable_kg > 0
    ? ship.total_chargeable_kg
    : (actualKg !== null || totalVolKg !== null ? Math.max(actualKg ?? 0, totalVolKg ?? 0) : null);
  const weightPerCartonKg = number(ship.weight_per_carton_kg) && ship.weight_per_carton_kg > 0
    ? ship.weight_per_carton_kg
    : (actualKg !== null && cartonCount !== null ? actualKg / cartonCount : null);
  const below10kg = totalChargeableKg !== null && totalChargeableKg < 10;
  const below50kg = totalChargeableKg !== null && totalChargeableKg < 50;
  const volumetricExceedsActual = actualKg !== null && totalVolKg !== null && totalVolKg > actualKg;
  const below8kgCarton = weightPerCartonKg !== null && weightPerCartonKg < 8;
  const freightFlags = [];
  if (below10kg) freightFlags.push(`总计费重 ${totalChargeableKg.toFixed(2)} kg < 10 kg 起运门槛（按最低 10 kg 计费）`);
  if (below50kg) {
    const rateTxt = number(ship.small_shipment_surcharge_cny_per_kg)
      ? `按输入私密价目表附加 +¥${ship.small_shipment_surcharge_cny_per_kg}/kg`
      : '附加费金额待按私密货代价目表填入';
    freightFlags.push(`整票计费重 ${totalChargeableKg.toFixed(2)} kg < 50 kg（触发小票附加档，${rateTxt}）`);
  }
  if (volumetricExceedsActual) freightFlags.push(`泡重 ${totalVolKg.toFixed(2)} kg（cm³/${divisor}）高于实重 ${actualKg.toFixed(2)} kg，按泡重计费`);
  if (below8kgCarton) {
    const cartonTxt = number(ship.small_carton_surcharge_cny_per_carton)
      ? `按输入私密价目表附加 +¥${ship.small_carton_surcharge_cny_per_carton}/箱`
      : '附加费金额待按私密货代价目表填入';
    freightFlags.push(`单外箱重 ${weightPerCartonKg.toFixed(2)} kg < 8 kg（触发小箱附加档，${cartonTxt}）`);
  }
  const freightDisclosure = {
    id: 'freight_a4_rules',
    label: '头程装柜与计费重规则（10kg/50kg/泡重/8kg外箱）',
    status: freightFlags.length > 0 ? 'alert' : totalChargeableKg !== null ? 'clear' : 'unverified',
    total_chargeable_kg: totalChargeableKg !== null ? Math.round(totalChargeableKg * 1000) / 1000 : null,
    volumetric_divisor: divisor,
    below_10kg_min_bill: below10kg,
    below_50kg_small_shipment: below50kg,
    volumetric_exceeds_actual: volumetricExceedsActual,
    below_8kg_outer_carton: below8kgCarton,
    flags: freightFlags,
    note: freightFlags.length > 0
      ? freightFlags.join('；') + '。'
      : totalChargeableKg !== null
        ? `整票计费重 ${totalChargeableKg.toFixed(2)} kg（≥50 kg）${weightPerCartonKg !== null ? `、单箱 ${weightPerCartonKg.toFixed(2)} kg（≥8 kg）` : ''}，未触发小票/小箱/泡重附加规则。`
        : '尚缺整票实重/外箱尺寸参数；发运前按私密货代最新价目表核对 10 kg 起运、50 kg 阶梯、cm³/除数泡重及 <8 kg 外箱附加规则。',
  };

  // (4) 1688 sensitive freebie flags (oil/glue/battery/strong magnet/powder)
  // Clause-scoped negation: a keyword preceded in the same clause by a prohibition cue (严禁/禁止/不含/排除/no/without/...)
  // is a procurement requirement, not an included accessory, and never raises a positive alert.
  const rawFlags = Array.isArray(ops.sensitive_freebie_flags) ? ops.sensitive_freebie_flags.filter(text) : [];
  const freeTexts = [
    ...(Array.isArray(ops.included_accessories) ? ops.included_accessories.filter(text) : []),
    ...(text(ops.freebie_notes) ? [ops.freebie_notes] : []),
  ];
  const classifyFreebieText = t => {
    const affirmative = new Set();
    const prohibited = new Set();
    for (const clause of String(t).split(FREEBIE_CLAUSE_SPLIT)) {
      if (!text(clause)) continue;
      for (const pat of SENSITIVE_FREEBIE_PATTERNS) {
        const re = new RegExp(pat.pattern.source, pat.pattern.flags.includes('g') ? pat.pattern.flags : `${pat.pattern.flags}g`);
        for (const m of clause.matchAll(re)) {
          const prefix = clause.slice(0, m.index);
          const suffix = clause.slice(m.index + m[0].length);
          if (FREEBIE_NEGATION_CUE.test(prefix) || /(?:无|免)$/.test(prefix) ||
            /^[^，,、]{0,16}?(?:\bnot\s+included\b|\bexcluded\b|除外)/i.test(suffix)) prohibited.add(pat.key);
          else affirmative.add(pat.key);
        }
      }
    }
    return { affirmative, prohibited };
  };
  const affirmativeKeys = new Set();
  const prohibitedKeys = new Set();
  for (const t of freeTexts) {
    const { affirmative, prohibited } = classifyFreebieText(t);
    affirmative.forEach(k => affirmativeKeys.add(k));
    prohibited.forEach(k => prohibitedKeys.add(k));
  }
  // An explicit flag stays an alert unless its wording is purely a prohibition (only negated matches).
  const alertFlags = rawFlags.filter(t => {
    const { affirmative, prohibited } = classifyFreebieText(t);
    affirmative.forEach(k => affirmativeKeys.add(k));
    if (affirmative.size === 0 && prohibited.size > 0) {
      prohibited.forEach(k => prohibitedKeys.add(k));
      return false;
    }
    return true;
  });
  const matchedSensitive = SENSITIVE_FREEBIE_PATTERNS.filter(p => affirmativeKeys.has(p.key)).map(p => ({ key: p.key, label: p.label }));
  const prohibitedSensitive = SENSITIVE_FREEBIE_PATTERNS.filter(p => prohibitedKeys.has(p.key) && !affirmativeKeys.has(p.key)).map(p => ({ key: p.key, label: p.label }));
  const hasSensitiveFreebies = alertFlags.length > 0 || matchedSensitive.length > 0;
  // A packing list cannot have been checked while the procurement line is still awaiting a 1688 quote.
  const packingListChecked = ops.sensitive_freebie_checked === true && !hasSensitiveFreebies && !procurementQuotePending;
  const freebieNeedsEvidence = !hasSensitiveFreebies && procurementQuotePending &&
    (ops.sensitive_freebie_checked === true || prohibitedSensitive.length > 0);
  const FREEBIE_SHORT = { oil: '润滑油／液体', glue: '胶水', battery: '电池', magnet: '强磁', powder: '粉末／化学品' };
  const prohibitedText = prohibitedSensitive.length ? prohibitedSensitive.map(m => FREEBIE_SHORT[m.key] ?? m.key).join('、') : '';
  const freebieDisclosure = {
    id: 'sensitive_freebie_flags',
    label: '1688 随箱赠品／敏感配件排雷',
    status: hasSensitiveFreebies ? 'alert' : packingListChecked ? 'clear' : freebieNeedsEvidence ? 'needs_check' : 'unverified',
    flags: rawFlags,
    matched_categories: matchedSensitive,
    prohibited_categories: prohibitedSensitive,
    packing_list_checked: packingListChecked,
    procurement_quote_pending: procurementQuotePending,
    ...(freebieNeedsEvidence ? { evidence_state: 'needs_evidence' } : {}),
    note: hasSensitiveFreebies
      ? `识别到敏感赠品或配件风险：${(matchedSensitive.length ? matchedSensitive.map(m => m.label) : alertFlags).join('；')}（建议发运前要求工厂剔除或补齐合规文件）。`
      : packingListChecked
        ? `已核对 1688 装箱清单，无油／胶水／电池／强磁／粉末类敏感赠品${prohibitedText ? `（采购要求已明确排除 ${prohibitedText}）` : ''}。`
        : freebieNeedsEvidence
          ? `1688 报价尚未取得，装箱清单未经实测核对${prohibitedText ? `；已记录的排除要求（${prohibitedText}）仅为采购规格，不是已核清单` : ''}，报价时须向工厂确认不附带润滑油、胶水、电池、强磁等敏感赠品。`
          : `下单前须向 1688 工厂确认是否默认附带润滑油、胶水、电池、强磁等敏感赠品${prohibitedText ? `（采购要求已明确排除 ${prohibitedText}）` : ''}。`,
  };

  // (5) US ADD/CVD HS clues
  const hsCode = text(ops.hs_code) ? ops.hs_code.trim() : null;
  const addCvdStatus = text(ops.add_cvd_status) ? ops.add_cvd_status.trim().toLowerCase() : null;
  const addCvdFlagged = ops.us_add_cvd_risk === true || ['flagged', 'high', 'applicable', 'risk'].includes(addCvdStatus ?? '');
  const addCvdClear = ops.us_add_cvd_risk === false || ['clear', 'none', 'not_applicable'].includes(addCvdStatus ?? '');
  const addCvdDisclosure = {
    id: 'us_add_cvd_hs_clues',
    label: '美国反倾销／反补贴（ADD/CVD）与 HS 归类线索',
    status: addCvdFlagged ? 'alert' : addCvdClear ? 'clear' : 'unverified',
    hs_code: hsCode,
    note: addCvdFlagged
      ? `HS 归类${hsCode ? `（${hsCode}）` : ''}存在美国 ADD/CVD 倾销／补贴税风险提示${text(ops.add_cvd_note) ? `：${ops.add_cvd_note.trim()}` : '，发货前必须由报关行确认税号与范围豁免'}。`
      : addCvdClear
        ? `HS 归类${hsCode ? `（${hsCode}）` : ''}初查未命中美国 ADD/CVD 范围${text(ops.add_cvd_note) ? `（${ops.add_cvd_note.trim()}）` : ''}；以清关行最终归类为准。`
        : `尚缺美国 HS 归类${hsCode ? `（已记录 ${hsCode}）` : ''}与 USITC ADD/CVD 核查记录（头程出货前确认）。`,
  };

  // (6) Package compatibility / micron tolerance + Amazon 2027-01-11 multi-SKU original-packaging bundle check
  const pkgOps = ops.packaging && typeof ops.packaging === 'object' ? ops.packaging : {};
  const bundleBasis = pkgOps.is_multi_sku_bundle === true ? 'declared'
    : skuLines.length > 1 ? 'sku_lines'
      : declaredPurchaseSkuCount !== null && declaredPurchaseSkuCount > 1 ? 'declared_purchase_skus'
        : purchaseExceedsSets ? 'purchase_units_exceed_sets' : null;
  const isMultiSkuBundle = bundleBasis !== null;
  const origMfrPkg = pkgOps.original_manufacturer_packaging;
  const bundle2027Compliant = pkgOps.fba_2027_01_11_bundle_compliant;
  const toleranceNote = text(pkgOps.tolerance_note) ? pkgOps.tolerance_note.trim()
    : (number(pkgOps.micron_tolerance) ? `公差 ±${pkgOps.micron_tolerance} μm` : number(pkgOps.tolerance_mm) ? `公差 ±${pkgOps.tolerance_mm} mm` : null);
  const toleranceNotePending = toleranceNote !== null && PENDING_TOLERANCE_CUE.test(toleranceNote);
  const bundleRisk = isMultiSkuBundle && (origMfrPkg === false || bundle2027Compliant === false);
  const bundleVerifiedCompliant = isMultiSkuBundle && !procurementQuotePending && !toleranceNotePending &&
    origMfrPkg === true && bundle2027Compliant === true;
  const bundleNeedsCheck = isMultiSkuBundle && !bundleRisk && !bundleVerifiedCompliant;
  const compatFlag = pkgOps.compatible_inner_pack === false;
  const canClearPackaging = !procurementQuotePending && !toleranceNotePending &&
    (bundleVerifiedCompliant || pkgOps.compatible_inner_pack === true || toleranceNote !== null);
  const pkgIssues = [];
  if (compatFlag) pkgIssues.push('内包装／配件接口兼容性存在冲突，需工厂打样确认');
  if (bundleRisk) pkgIssues.push('多 SKU 组合套装不满足 Amazon 2027-01-11 原厂原始包装（original manufacturer packaging）新规');
  else if (bundleNeedsCheck) pkgIssues.push(`多 SKU 组合套装${purchaseLineageNote}须核实 original_manufacturer_packaging 与 Amazon 2027-01-11 组合套装包装合规（当前尚缺两项显式确认，严禁非原厂简单混装）`);
  const packagingDisclosure = {
    id: 'packaging_and_2027_bundle_check',
    label: '包装公差兼容性与 Amazon 2027-01-11 组合套装包装核查',
    status: (compatFlag || bundleRisk) ? 'alert' : bundleNeedsCheck ? 'needs_check' : canClearPackaging ? 'clear' : 'unverified',
    is_multi_sku_bundle: isMultiSkuBundle,
    bundle_basis: bundleBasis,
    original_manufacturer_packaging: typeof origMfrPkg === 'boolean' ? origMfrPkg : null,
    fba_2027_01_11_bundle_compliant: typeof bundle2027Compliant === 'boolean' ? bundle2027Compliant : null,
    tolerance_note: toleranceNote,
    note: pkgIssues.length > 0
      ? `${pkgIssues.join('；')}${toleranceNote ? `；${toleranceNote}` : ''}。`
      : bundleVerifiedCompliant
        ? `多 SKU 组合套装已显式确认满足原厂原始包装与 Amazon 2027-01-11 组合套装合规要求${toleranceNote ? `（${toleranceNote}）` : ''}。`
        : toleranceNote || (pkgOps.compatible_inner_pack === true && !procurementQuotePending
          ? '单品内包装与配件公差兼容性已核查。'
          : '打样前须核对配件接口公差与内包装兼容性；如涉及多 SKU 组合须遵守 Amazon 2027-01-11 原厂原始包装规则。'),
  };

  return [
    batchCashDisclosure,
    amz1pDisclosure,
    freightDisclosure,
    freebieDisclosure,
    addCvdDisclosure,
    packagingDisclosure,
  ];
}

export function scoreCandidate(candidate, profile, internal = null) {
  const defs = definitions(profile);
  const ctx = context(candidate);
  const isR58 = profile.revision >= 58;
  const isR59 = profile.revision >= 59;
  const isOperatingPeriod = internal === INTERNAL_PERIOD_TOKEN;
  if (!isOperatingPeriod && candidate.economics && Object.hasOwn(candidate.economics, 'operating_periods')) {
    validateOperatingPeriods(candidate.economics, isR58);
    const {
      operating_periods: rawPeriods,
      expected_primary_scenarios: rootExpected,
      stress_scenarios: rootStress,
      ...economics
    } = candidate.economics;
    const orderedPeriods = isR58 ? [...rawPeriods].sort(comparePeriodOrder) : rawPeriods;
    const evaluatedPeriods = orderedPeriods.map(period => {
      const mergedExpected = isR58 ? mergeExpectedPrimaryScenarios(rootExpected, period.expected_primary_scenarios) : period.expected_primary_scenarios;
      const mergedStress = isR58 ? mergeStressScenarios(rootStress, period.stress_scenarios) : period.stress_scenarios;
      return {
        ...scoreCandidate({
          ...candidate,
          economics: {
            ...economics,
            scenarios: period.scenarios,
            operating_months: period.months,
            ...(mergedExpected !== undefined ? { expected_primary_scenarios: mergedExpected } : {}),
            ...(mergedStress !== undefined ? { stress_scenarios: mergedStress } : {}),
          },
        }, profile, INTERNAL_PERIOD_TOKEN),
        id: period.id, label: period.label, months: period.months,
      };
    });
    const isPrivateMoldReserved = isR59 && candidate.sourcing_disposition === 'private_mold_reserved';
    const qualR58 = isR58 ? buildSeasonalQualificationR58(evaluatedPeriods, isR59, isPrivateMoldReserved) : null;
    const displayPeriodForOps = isR58
      ? (evaluatedPeriods.find(p => p.id === qualR58?.display_period_id) ?? evaluatedPeriods[0] ?? null)
      : null;
    const seasonalOps = isR58
      ? buildOperationalDisclosuresR58(candidate, displayPeriodForOps?.diagnostics?.economics?.scenarios ?? [])
      : null;
    const primaryOffPeak = evaluatedPeriods.find(p =>
      p.months.length === PRIMARY_OFF_PEAK_MONTHS.length && PRIMARY_OFF_PEAK_MONTHS.every(m => p.months.includes(m)));
    const seasonalDispR59 = !isR59 ? undefined
      : isPrivateMoldReserved ? 'private_mold_reserved'
        : qualR58?.counts_toward_target === true ? 'seasonal_off_peak_qualifying'
          : qualR58?.mode === 'crossing_30pct_interval' || primaryOffPeak?.diagnostics?.economics?.crossing_margin_floor === true ? 'crossing_30pct_interval'
            : primaryOffPeak?.queue === 'excluded' ? 'hard_excluded'
              : primaryOffPeak?.queue === 'deferred' ? 'deferred'
                : 'pending_evidence';
    const allowShortlistSeasonal = !isR59 || seasonalDispR59 === 'hard_excluded';
    return {
      candidate_id: candidate.id, label: candidate.label ?? candidate.id, form: candidate.form ?? null,
      profile_revision: profile.revision, total_budget: 100, evidence: candidate.evidence ?? [],
      operating_periods: evaluatedPeriods,
      total: null, total_range: null, conditional_total_range: null, supported_score: null, supported_range: null,
      covered_weight: null, unscored_weight: null, scoring_complete: null, queue: 'seasonal_review',
      ...(isR59 ? { effective_disposition: seasonalDispR59 } : {}),
      ...(isR58 ? { qualification: qualR58, diagnostics: { operational_disclosures: seasonalOps } } : {}),
      ...(isR58 && Array.isArray(candidate.review_notes) && candidate.review_notes.length > 0 ? { review_notes: candidate.review_notes } : {}),
      ...(isR58 && allowShortlistSeasonal && candidate.negotiation_shortlist ? { negotiation_shortlist: candidate.negotiation_shortlist } : {}),
    };
  }
  const economicsInput = isR58 && !isOperatingPeriod && candidate.economics && Object.hasOwn(candidate.economics, 'operating_months')
    ? (() => { const { operating_months: _ignored, ...rest } = candidate.economics; return rest; })()
    : candidate.economics;
  const priceRefR58 = isR58 ? validateR58PriceAnchor(candidate.screening?.reference_price_usd, ctx) : null;
  const newcomers = scoreNewcomers(candidate.newcomer_cohort, ctx, profile, defs);
  const profit = scoreEconomics(economicsInput, ctx, profile, defs, priceRefR58);
  const items = defs.map(item => {
    if (item.id === 'refund_adjusted_pre_ad_margin') return profit.margin;
    if (item.id === 'unit_contribution') return profit.contribution;
    if (item.id === 'low_rating_sales_performance') return newcomers.low;
    if (item.id === 'natural_visibility_development') return newcomers.natural;
    if (item.id === 'relevant_purchase_entry_bid') return scoreBids(item, candidate.bids, ctx, profile);
    if (['purchase_demand_scale', 'low_return_preference'].includes(item.id)) return scoreMetric(item, candidate.metrics?.[item.id], ctx, profile);
    if (item.mapping.anchors?.some(anchor => !Array.isArray(anchor))) return scoreJudgment(item, candidate.judgments?.[item.id], ctx);
    if (['market_entry', 'normal_newcomer'].includes(item.group) &&
      !['low_rating_sales_performance', 'natural_visibility_development'].includes(item.id)) return scoreMarket(item, candidate.market, ctx);
    return missing(item, 'Required evidence has not been supplied.');
  });
  const bidsItem = items.find(item => item.id === 'relevant_purchase_entry_bid');
  if (isR58) {
    const refBidUsd = number(bidsItem?.reference_bid_usd) && bidsItem.reference_bid_usd > 0 ? bidsItem.reference_bid_usd : null;
    profit.diagnostics.break_even_click_cvr = refBidUsd === null ? null : {
      reference_bid_usd: refBidUsd,
      denominator_basis: 'ad_orders / ad_clicks (clickConvRate — never compare against search purchaseRate)',
      scenarios: profit.diagnostics.scenarios.map(sc => {
        const calc = sc.input?.calculation;
        const contrib = calc?.status === 'sensitivity_only' ? calc?.contribution_usd : sc.input?.contribution_usd?.value;
        return {
          id: sc.id,
          contribution_usd: number(contrib) ? contrib : null,
          break_even_click_cvr: number(contrib) && contrib > 0 ? Math.round((refBidUsd / contrib) * 1e6) / 1e6 : null,
        };
      }),
    };
  }
  const totals = aggregate(items, profile.group_budgets, profit);
  const screening = screenCandidate(candidate, ctx, profit, items, profile);

  const isTopLevelFlatR58 = isR58 && !isOperatingPeriod;
  const isPrimaryOffPeakPeriodR58 = isR58 && isOperatingPeriod && Array.isArray(economicsInput?.operating_months) &&
    economicsInput.operating_months.length === PRIMARY_OFF_PEAK_MONTHS.length &&
    PRIMARY_OFF_PEAK_MONTHS.every(m => economicsInput.operating_months.includes(m));
  const fullYearDatesOk = !isTopLevelFlatR58 || coversFullCalendarYearDates(profit.diagnostics.scenarios);
  const offPeakDatesOk = !isPrimaryOffPeakPeriodR58 || coversPrimaryOffPeakDates(profit.diagnostics.scenarios);
  const periodCoverageOk = fullYearDatesOk && offPeakDatesOk;
  const isPrivateMoldFlatR59 = isR59 && !isOperatingPeriod && candidate.sourcing_disposition === 'private_mold_reserved';
  const strictComplete = !isPrivateMoldFlatR59 && totals.covered_weight === 100 && screening.status === 'eligible' && periodCoverageOk;
  const crossingCompleteR59 = !isPrivateMoldFlatR59 && isR59 && totals.covered_weight === 100 && screening.status === 'crossing_eligible' && periodCoverageOk;
  const hasFullTotalRange = strictComplete || crossingCompleteR59;
  const queue = ['excluded', 'deferred'].includes(screening.status) ? screening.status : strictComplete ? 'comparable' : 'pending';
  const conditional = queue === 'pending' && !crossingCompleteR59 && periodCoverageOk ? addRanges(items.filter(item => item.group !== 'profit')
    .reduce((sum, item) => addRanges(sum, item.score_range ?? item.conditional_range ?? [0, item.weight]), [0, 0]), profit.conditional_range ?? [0, 30]) : null;

  let qualification = null;
  if (isTopLevelFlatR58) {
    if (isPrivateMoldFlatR59) {
      qualification = {
        counts_toward_target: false,
        mode: 'private_mold_reserved',
        primary_period_id: null,
        display_period_id: null,
        reasons: ['Candidate is routed to private_mold_reserved (no open 1688 public mold verified) and never counts toward ready-stock qualifying target.'],
      };
    } else if (strictComplete) {
      qualification = {
        counts_toward_target: true,
        mode: 'comparable',
        primary_period_id: null,
        display_period_id: null,
        reasons: ['All 21 items supported and full 12-month target-year calendar coverage verified.'],
      };
    } else if (crossingCompleteR59) {
      qualification = {
        counts_toward_target: false,
        crossing_30pct_actionable: true,
        mode: 'crossing_30pct_interval',
        primary_period_id: null,
        display_period_id: null,
        reasons: ['All 21 items scored across a crossing-30% scenario interval (held separate from strict all-scenario qualifying count).'],
      };
    } else {
      const reasons = [];
      if (!fullYearDatesOk) reasons.push('Flat annual mode requires every primary scenario to cover all 12 calendar months and all days of one target year (YYYY-01-01..YYYY-12-31).');
      if (screening.status !== 'eligible') reasons.push(`Initial screening status is ${screening.status}.`);
      if (totals.covered_weight < 100) reasons.push(`Scored weight coverage is ${totals.covered_weight}/100.`);
      qualification = {
        counts_toward_target: false,
        mode: 'none',
        primary_period_id: null,
        display_period_id: null,
        reasons,
      };
    }
  }

  const flatDispR59 = !isR59 || isOperatingPeriod ? undefined
    : candidate.sourcing_disposition === 'private_mold_reserved' ? 'private_mold_reserved'
      : strictComplete ? 'full_annual_qualifying'
        : crossingCompleteR59 || profit.diagnostics.crossing_margin_floor === true ? 'crossing_30pct_interval'
          : queue === 'excluded' ? 'hard_excluded'
            : queue === 'deferred' ? 'deferred'
              : 'pending_evidence';

  const allowShortlistFlat = !isR59 || flatDispR59 === 'hard_excluded';
  return {
    candidate_id: candidate.id, label: candidate.label ?? candidate.id, form: candidate.form ?? null,
    profile_revision: profile.revision, total_budget: 100, evidence: candidate.evidence ?? [], items, ...totals,
    supported_score: point(totals.supported_range), scoring_complete: totals.covered_weight === 100,
    total: hasFullTotalRange ? point(totals.supported_range) : null, total_range: hasFullTotalRange ? totals.supported_range : null,
    conditional_total_range: conditional, queue, screening,
    ...(flatDispR59 ? { effective_disposition: flatDispR59 } : {}),
    ...(qualification ? { qualification } : {}),
    ...(isR58 && !isOperatingPeriod && Array.isArray(candidate.review_notes) && candidate.review_notes.length > 0 ? { review_notes: candidate.review_notes } : {}),
    ...(isR58 && !isOperatingPeriod && allowShortlistFlat && candidate.negotiation_shortlist ? { negotiation_shortlist: candidate.negotiation_shortlist } : {}),
    diagnostics: {
      bids: bidsItem,
      newcomers: newcomers.diagnostics,
      economics: profit.diagnostics,
      ...(isR58 && !isOperatingPeriod ? { operational_disclosures: buildOperationalDisclosuresR58(candidate, profit.diagnostics.scenarios) } : {}),
    },
  };
}

export function scoreBatch(batch, profile) {
  definitions(profile);
  if (batch?.schema_version !== 1 || batch.profile_revision !== profile.revision || !Array.isArray(batch.candidates)) {
    throw new TypeError('A version-1 batch with matching profile_revision and a candidates array is required.');
  }
  const isR58 = profile.revision >= 58;
  const ids = new Set();
  const results = batch.candidates.map(candidate => {
    if (ids.has(candidate?.id)) throw new TypeError('Candidate IDs must be unique within a batch.');
    ids.add(candidate?.id);
    return scoreCandidate(candidate, profile);
  });

  const periodById = (result, periodId) => result.operating_periods?.find(p => p.id === periodId) ?? result.operating_periods?.[0] ?? null;

  const comparable = results.filter(result => result.queue === 'comparable')
    .sort((a, b) => isR58
      ? (compareRangeDesc(a.total_range, b.total_range) || compareText(a.candidate_id, b.candidate_id))
      : (b.total_range[0] - a.total_range[0]));
  const pending = results.filter(result => result.queue === 'pending')
    .sort((a, b) => isR58
      ? (compareRangeDesc(a.supported_range, b.supported_range) || (b.covered_weight - a.covered_weight) || compareText(a.candidate_id, b.candidate_id))
      : (b.supported_range[0] - a.supported_range[0] || b.covered_weight - a.covered_weight));
  const deferred = results.filter(result => result.queue === 'deferred');
  const excluded = results.filter(result => result.queue === 'excluded');
  if (isR58) {
    const tieSort = (a, b) => compareRangeDesc(a.supported_range, b.supported_range) ||
      ((b.covered_weight ?? -1) - (a.covered_weight ?? -1)) || compareText(a.candidate_id, b.candidate_id);
    deferred.sort(tieSort);
    excluded.sort(tieSort);
  }

  const isSeasonalEligible = result => isR58
    ? result.qualification?.counts_toward_target === true
    : profile.revision >= 57
      ? result.operating_periods.some(period => HOLIDAY_PEAK_MONTHS.every(month => period.months.includes(month))) &&
        result.operating_periods.some(period => period.queue === 'comparable' &&
          period.months.length === PRIMARY_OFF_PEAK_MONTHS.length &&
          PRIMARY_OFF_PEAK_MONTHS.every(month => period.months.includes(month)) &&
          period.diagnostics?.economics?.scenarios?.length > 0 &&
          period.diagnostics.economics.scenarios.every(coversPrimaryOffPeakScenario) &&
          period.screening?.conditions?.find(condition => condition.id === 'strong_date_dependency')?.status === 'pass')
      : result.operating_periods.some(period => period.queue === 'comparable');

  const rawSeasonalReview = results.filter(result => result.queue === 'seasonal_review');
  const seasonalEligible = rawSeasonalReview.filter(isSeasonalEligible);
  const seasonalRemaining = rawSeasonalReview.filter(result => !isSeasonalEligible(result));
  if (isR58) {
    seasonalEligible.sort((a, b) => {
      const pa = periodById(a, a.qualification.primary_period_id);
      const pb = periodById(b, b.qualification.primary_period_id);
      return compareRangeDesc(pa?.total_range, pb?.total_range) || compareText(a.candidate_id, b.candidate_id);
    });
    seasonalRemaining.sort((a, b) => {
      const pa = periodById(a, a.qualification.display_period_id);
      const pb = periodById(b, b.qualification.display_period_id);
      return compareRangeDesc(pa?.supported_range, pb?.supported_range) ||
        ((pb?.covered_weight ?? -1) - (pa?.covered_weight ?? -1)) || compareText(a.candidate_id, b.candidate_id);
    });
  }

  const seasonalReview = profile.revision >= 57 ? [...seasonalEligible, ...seasonalRemaining] : rawSeasonalReview;
  const leader = comparable[0];
  for (const result of pending) {
    result.may_exceed_comparable_leader = leader && result.conditional_total_range ? result.conditional_total_range[1] > leader.total_range[0] : null;
  }
  const queues = { comparable, pending, deferred, excluded, ...(seasonalReview.length ? { seasonal_review: seasonalReview } : {}) };
  const orderedCandidates = profile.revision >= 57
    ? [...comparable, ...seasonalEligible, ...pending, ...seasonalRemaining, ...deferred, ...excluded]
    : Object.values(queues).flat();
  const dispositionByCandId = new Map(orderedCandidates.map(c => [c.candidate_id, c.effective_disposition]));
  const filteredNegotiationShortlist = isR58 && Array.isArray(batch.negotiation_shortlist)
    ? (profile.revision >= 59
        ? batch.negotiation_shortlist.filter(row => {
            const fid = row?.form_id ?? row?.candidate_id ?? row?.id ?? null;
            if (!fid || !dispositionByCandId.has(fid)) return true;
            return dispositionByCandId.get(fid) === 'hard_excluded';
          })
        : batch.negotiation_shortlist)
    : [];
  return {
    schema_version: 1, profile_revision: profile.revision, total_budget: 100,
    candidates: orderedCandidates,
    order: Object.fromEntries(Object.entries(queues).map(([key, values]) => [key, values.map(result => result.candidate_id)])),
    comparable_leader: leader ? { candidate_id: leader.candidate_id, total_range: leader.total_range, conservative_score: leader.total_range[0] } : null,
    ...(filteredNegotiationShortlist.length > 0 ? { negotiation_shortlist: filteredNegotiationShortlist } : {}),
    summary: {
      candidates: results.length, complete: comparable.length,
      complete_points: comparable.filter(result => result.total !== null).length,
      complete_ranges: comparable.filter(result => result.total === null).length,
      all_items_supported: results.filter(result => result.scoring_complete).length,
      partial: results.filter(result => result.queue !== 'seasonal_review' && !result.scoring_complete).length,
      pending: pending.length, deferred: deferred.length, excluded: excluded.length,
      ...(seasonalReview.length ? { seasonal_review: seasonalReview.length,
        seasonal_eligible: seasonalEligible.length } : {}),
      ...(isR58 ? { qualifying: comparable.length + seasonalEligible.length } : {}),
      ...(profile.revision >= 59 ? {
        dispositions: {
          full_annual_qualifying: results.filter(r => r.effective_disposition === 'full_annual_qualifying').length,
          seasonal_off_peak_qualifying: results.filter(r => r.effective_disposition === 'seasonal_off_peak_qualifying').length,
          crossing_30pct_interval: results.filter(r => r.effective_disposition === 'crossing_30pct_interval').length,
          pending_evidence: results.filter(r => r.effective_disposition === 'pending_evidence').length,
          private_mold_reserved: results.filter(r => r.effective_disposition === 'private_mold_reserved').length,
          deferred: results.filter(r => r.effective_disposition === 'deferred').length,
          hard_excluded: results.filter(r => r.effective_disposition === 'hard_excluded').length,
        },
      } : {}),
    },
  };
}
