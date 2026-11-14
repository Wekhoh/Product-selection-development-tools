// Offline revision-50 trial calculations. Importing this module performs no I/O.

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
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsedDay = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(parsedDay) && new Date(parsedDay).toISOString().slice(0, 10) === day;
}
const addRanges = (a, b) => [a[0] + b[0], a[1] + b[1]];
const span = values => [Math.min(...values), Math.max(...values)];
const point = range => range[0] === range[1] ? range[0] : null;
const mergeRefs = (...lists) => [...new Set(lists.flatMap(list => Array.isArray(list) ? list.filter(text) : []))];
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compareIdentity = (a, b) => compareText(a.family_id, b.family_id) || compareText(a.asin, b.asin);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
};

function definitions(profile) {
  if (profile?.revision !== 50 || profile.total_budget !== 100 || profile.production_eligible !== false ||
    profile.activate_by_import !== false || !Array.isArray(profile.group_budgets) ||
    profile.group_budgets.length !== EXPECTED_GROUPS.length || profile.group_budgets.some((group, index) =>
      group?.id !== EXPECTED_GROUPS[index] || !Array.isArray(group.items))) {
    throw new TypeError('The frozen revision-50, 100-point trial profile is required.');
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
  if (!number(margin.eligible_margin_floor) || !number(margin.full_score_at) ||
    margin.full_score_at <= margin.eligible_margin_floor || !number(margin.score_at_floor) ||
    margin.eligible_margin_floor !== profile.reference_screening?.margin?.minimum || !profile.measurement ||
    profile.workflow?.scoring_and_ordering?.revision !== 50) {
    throw new TypeError('The profile needs valid adopted margin and shared revision-50 mappings.');
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

function scoreMetric(item, input, ctx) {
  let validScope;
  if (item.id === 'purchase_demand_scale') {
    validScope = input?.window_days === 30 && input.window_basis === 'latest_30_days' &&
      input.coverage_supported === true && input.deduplicated === true &&
      ['niche', 'period', 'grain'].every(key => text(input[key]));
  } else {
    validScope = input?.applicable === true && text(input.category) && text(input.period);
  }
  if (!validScope) return missing(item, input?.reason ?? 'Required metric scope, period or applicability is unsupported.', input);
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

function bidSource(input, source, bids, ctx) {
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

function scoreBids(item, bids, ctx) {
  if (!bids || bids.marketplace !== 'US' || bids.currency !== 'USD' || bids.match_type !== 'exact' ||
    !text(bids.volume_period) || !text(bids.selection_reason) || !hasEvidence(bids.evidence, ctx) ||
    !Array.isArray(bids.entries) || bids.entries.length === 0) {
    return missing(item, bids?.reason ?? 'A supported main-entry set with common monthly volume and US/exact/USD scope is required.', bids);
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
    const sources = Object.fromEntries(['sellersprite', 'sif'].map(source => [source, bidSource(entry?.[source], source, bids, ctx)]));
    const usable = Object.entries(sources).filter(([, value]) => value.point !== null);
    const combined = usable.length ? usable.reduce((sum, [, value]) => sum + value.point / usable.length, 0) : null;
    return { query: entry?.query ?? null, volume: volume.value, volume_reason: volume.reason, sources,
      combined_point: combined, source_label: usable.length === 2 ? 'two_source_mean' : usable.length ? `${usable[0][0]}_only` : 'needs_evidence' };
  });
  const totalVolume = entries.reduce((sum, entry) => sum + (entry.volume ?? 0), 0);
  const validVolumes = entries.every(entry => entry.volume !== null) && number(totalVolume) && totalVolume > 0;
  const rangeScenarios = Object.fromEntries(['sellersprite', 'sif'].map(source => {
    if (duplicate || !validVolumes || entries.some(entry => !entry.sources[source].range)) return [source, null];
    const range = [0, 1].map(i => entries.reduce((sum, entry) => sum + entry.volume / totalVolume * entry.sources[source].range[i], 0));
    return [source, { source, bid_range_usd: range,
      score_range: [numericScore(item, range[1]), numericScore(item, range[0])], interpretation: 'Source-labeled range scenario; not the main score or actual CPC.' }];
  }));
  const extra = { entries, range_scenarios: rangeScenarios, reference_bid_usd: null,
    evidence: mergeRefs(bids.evidence, ...bids.entries.flatMap(entry => [entry?.volume?.evidence, entry?.sellersprite?.evidence, entry?.sif?.evidence])) };
  if (duplicate) return missing(item, 'Main-entry queries must be nonempty and deduplicated before scoring.', bids, extra);
  if (!validVolumes) return missing(item, 'Every selected entry needs supported monthly volume and the total must be positive.', bids, extra);
  if (entries.some(entry => entry.combined_point === null)) return missing(item, 'A required main-entry native exact point is missing from both usable sources.', bids, extra);
  const reference = entries.reduce((sum, entry) => sum + entry.volume / totalVolume * entry.combined_point, 0);
  if (!number(reference)) return missing(item, 'The weighted bid reference is not finite.', bids, extra);
  return scored(item, numericScore(item, reference), bids, { ...extra, reference_bid_usd: reference });
}

function scoreNatural(member, ctx, profile) {
  const input = member.natural;
  if (input?.scope !== 'overall' || !text(input.period) || !hasEvidence(input.relevant_entries_evidence, ctx) ||
    (input.provider && input.provider !== 'sif') || (input.subject && ![member.family_id, member.asin].includes(input.subject))) {
    return { score: null, reason: input?.reason ?? 'A SIF overall share needs identified period, subject and relevant-entry evidence.', input };
  }
  const reading = readNumber(input, 'fraction', ctx, { max: 1 });
  const counts = Object.fromEntries(['sellersprite', 'sif'].map(source => [source,
    Object.fromEntries(['organic', 'ad'].map(channel => [channel,
      readNumber(input.keyword_counts?.[source]?.[channel], 'count', ctx, { integer: true }).value]))]));
  return {
    score: reading.value === null ? null : Math.min(reading.value / profile.measurement.newcomer_natural_visibility_example_score.full_points_at, 1),
    reason: reading.reason, input, keyword_counts: counts,
    source_label: Object.values(counts.sellersprite).some(value => value !== null) ? 'sif_with_sellersprite_corroboration' : 'sif_only',
  };
}

function scoreNewcomers(cohort, ctx, profile, defs) {
  const lowDef = defs.find(item => item.id === 'low_rating_sales_performance');
  const naturalDef = defs.find(item => item.id === 'natural_visibility_development');
  const diagnostics = { members: [], examples: [], selected_pair: [], references: { rating_median: null, sales_median: null } };
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

function scoreEconomics(economics, ctx, profile, defs) {
  const marginDef = defs.find(item => item.id === 'refund_adjusted_pre_ad_margin');
  const contributionDef = defs.find(item => item.id === 'unit_contribution');
  const floor = profile.reference_screening.margin.minimum;
  const diagnostics = { saleable_unit: economics?.saleable_unit ?? null, scenarios: [], margin_range: null };
  const idCounts = new Map();
  let structuralReason = null;
  if (!text(economics?.saleable_unit) || !Array.isArray(economics?.scenarios) || economics.scenarios.length === 0) {
    structuralReason = 'A common saleable unit and nonempty supported economic scenario set are required.';
  } else {
    for (const scenario of economics.scenarios) {
      if (text(scenario?.id)) idCounts.set(scenario.id, (idCounts.get(scenario.id) ?? 0) + 1);
    }
    for (const scenario of economics.scenarios) {
      const validRecord = text(scenario?.id) && idCounts.get(scenario.id) === 1 && scenario.saleable_unit === economics.saleable_unit &&
        scenario.coherent === true && Array.isArray(scenario.assumptions) && scenario.assumptions.length > 0 && scenario.assumptions.every(text);
      let eligibilityReason = validRecord ? null : 'Economic scenarios need unique IDs, the same saleable unit, coherent inputs and explicit assumptions.';
      if (eligibilityReason) structuralReason = eligibilityReason;
      const margin = readNumber(scenario?.margin, 'fraction', ctx, { min: -Infinity, max: 1 });
      const contribution = readNumber(scenario?.contribution_usd, 'USD', ctx, { min: -Infinity });
      const contradictoryTuple = margin.value !== null && contribution.value !== null && Math.sign(margin.value) !== Math.sign(contribution.value);
      if (contradictoryTuple) {
        eligibilityReason = 'Supported margin and contribution have contradictory signs or zero under the required positive net revenue.';
        structuralReason = eligibilityReason;
      }
      const coherenceSupported = validRecord && !contradictoryTuple;
      const eligible = coherenceSupported && margin.value !== null && margin.value >= floor;
      eligibilityReason ??= margin.reason ?? (margin.value < floor ? 'The supported scenario margin is below the existing 30% floor.' : null);
      diagnostics.scenarios.push({ id: scenario?.id ?? null, input: scenario, margin, contribution,
        coherence_supported: coherenceSupported, margin_eligible: eligible, eligibility_reason: eligibilityReason,
        margin_score: eligible ? numericScore(marginDef, margin.value) : null,
        contribution_score: eligible && contribution.value !== null ? numericScore(contributionDef, contribution.value) : null });
    }
  }
  const scenarios = diagnostics.scenarios;
  const marginsComplete = !structuralReason && scenarios.every(scenario => scenario.margin.value !== null);
  if (marginsComplete) diagnostics.margin_range = span(scenarios.map(scenario => scenario.margin.value));
  let marginStatus = 'pending';
  let marginReason = structuralReason ?? 'One or more economic scenarios lacks a supported complete margin; missing costs are not zero.';
  if (marginsComplete) {
    if (diagnostics.margin_range[1] < floor) {
      marginStatus = 'fail';
      marginReason = 'The supported margin upper bound is below the existing 30% floor.';
    } else if (diagnostics.margin_range[0] >= floor) {
      marginStatus = 'pass';
      marginReason = 'All supported coherent scenarios meet the margin condition.';
    } else {
      marginReason = 'The supported margin range crosses 30%; screening remains pending.';
    }
  }
  const completeMargin = marginStatus === 'pass';
  const completeContribution = completeMargin && scenarios.every(scenario => scenario.contribution.value !== null);
  const marginRange = completeMargin ? span(scenarios.map(scenario => scenario.margin_score)) : null;
  const contributionRange = completeContribution ? span(scenarios.map(scenario => scenario.contribution_score)) : null;
  const marginEvidence = mergeRefs(...scenarios.map(scenario => scenario.input?.margin?.evidence));
  const contributionEvidence = mergeRefs(marginEvidence, ...scenarios.map(scenario => scenario.input?.contribution_usd?.evidence));
  const marginItem = completeMargin ? scored(marginDef, point(marginRange), economics, { score_range: marginRange, evidence: marginEvidence,
    scenario_scores: scenarios.map(s => ({ id: s.id, value: s.margin.value, score: s.margin_score })) }) :
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
  return { margin: marginItem, contribution: contributionItem, supported_range: supportedRange, conditional_range: conditionalRange,
    screening: { id: 'margin', status: marginStatus, reason: marginReason, range: diagnostics.margin_range }, diagnostics };
}

function screenCandidate(candidate, ctx, profit, items, profile) {
  const priceInput = candidate.screening?.reference_price_usd;
  const price = readNumber(priceInput, 'USD', ctx, { min: Number.MIN_VALUE });
  const priceSupported = price.value !== null && priceInput.matched_spec === true;
  const pricePass = priceSupported && price.value > profile.reference_screening.comparable_reference_price.strictly_greater_than;
  const date = candidate.screening?.strong_date_dependency;
  const dateSupported = typeof date?.value === 'boolean' && date.unit === 'boolean' && hasEvidence(date.evidence, ctx) &&
    date.supported !== false && date.material_conflict !== true;
  const rights = items.find(item => item.id === 'specific_design_rights');
  const conditions = [
    { id: 'reference_price', status: priceSupported ? pricePass ? 'pass' : 'fail' : 'pending', input: priceInput ?? null,
      reason: priceSupported ? pricePass ? 'Supported matched-spec reference price is above USD 30.' : 'Supported matched-spec reference price does not exceed USD 30.' :
        priceInput?.reason ?? 'A supported positive matched-spec reference price is required.' },
    profit.screening,
    { id: 'specific_form_rights', status: rights.status === 'scored' ? rights.score === 0 ? 'fail' : 'pass' : 'pending',
      reason: rights.reason, evidence: rights.evidence },
    { id: 'strong_date_dependency', status: dateSupported ? date.value ? 'defer' : 'pass' : 'pending', input: date ?? null,
      reason: dateSupported ? date.value ? 'The supported strong holiday/date dependency is deferred in this reference profile.' : 'No strong holiday/date dependency is identified in the supported initial check.' :
        date?.reason ?? 'Strong date dependency has not been assessed with supported evidence.' },
  ];
  const status = conditions.some(condition => condition.status === 'fail') ? 'excluded' :
    conditions.some(condition => condition.status === 'defer') ? 'deferred' :
      conditions.some(condition => condition.status === 'pending') ? 'pending' : 'eligible';
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

export function scoreCandidate(candidate, profile) {
  const defs = definitions(profile);
  const ctx = context(candidate);
  const newcomers = scoreNewcomers(candidate.newcomer_cohort, ctx, profile, defs);
  const profit = scoreEconomics(candidate.economics, ctx, profile, defs);
  const items = defs.map(item => {
    if (item.id === 'refund_adjusted_pre_ad_margin') return profit.margin;
    if (item.id === 'unit_contribution') return profit.contribution;
    if (item.id === 'low_rating_sales_performance') return newcomers.low;
    if (item.id === 'natural_visibility_development') return newcomers.natural;
    if (item.id === 'relevant_purchase_entry_bid') return scoreBids(item, candidate.bids, ctx);
    if (['purchase_demand_scale', 'low_return_preference'].includes(item.id)) return scoreMetric(item, candidate.metrics?.[item.id], ctx);
    if (item.mapping.anchors?.some(anchor => !Array.isArray(anchor))) return scoreJudgment(item, candidate.judgments?.[item.id], ctx);
    if (['market_entry', 'normal_newcomer'].includes(item.group) &&
      !['low_rating_sales_performance', 'natural_visibility_development'].includes(item.id)) return scoreMarket(item, candidate.market, ctx);
    return missing(item, 'Required evidence has not been supplied.');
  });
  const totals = aggregate(items, profile.group_budgets, profit);
  const screening = screenCandidate(candidate, ctx, profit, items, profile);
  const complete = totals.covered_weight === 100 && screening.status === 'eligible';
  const queue = ['excluded', 'deferred'].includes(screening.status) ? screening.status : complete ? 'comparable' : 'pending';
  const conditional = queue === 'pending' ? addRanges(items.filter(item => item.group !== 'profit')
    .reduce((sum, item) => addRanges(sum, item.score_range ?? item.conditional_range ?? [0, item.weight]), [0, 0]), profit.conditional_range ?? [0, 30]) : null;
  return {
    candidate_id: candidate.id, label: candidate.label ?? candidate.id, form: candidate.form ?? null,
    profile_revision: profile.revision, total_budget: 100, evidence: candidate.evidence ?? [], items, ...totals,
    supported_score: point(totals.supported_range), scoring_complete: totals.covered_weight === 100,
    total: complete ? point(totals.supported_range) : null, total_range: complete ? totals.supported_range : null,
    conditional_total_range: conditional, queue, screening,
    diagnostics: { bids: items.find(item => item.id === 'relevant_purchase_entry_bid'), newcomers: newcomers.diagnostics, economics: profit.diagnostics },
  };
}

export function scoreBatch(batch, profile) {
  definitions(profile);
  if (batch?.schema_version !== 1 || batch.profile_revision !== 50 || !Array.isArray(batch.candidates)) {
    throw new TypeError('A version-1 batch with profile_revision 50 and a candidates array is required.');
  }
  const ids = new Set();
  const results = batch.candidates.map(candidate => {
    if (ids.has(candidate?.id)) throw new TypeError('Candidate IDs must be unique within a batch.');
    ids.add(candidate?.id);
    return scoreCandidate(candidate, profile);
  });
  const comparable = results.filter(result => result.queue === 'comparable')
    .sort((a, b) => b.total_range[0] - a.total_range[0]);
  const pending = results.filter(result => result.queue === 'pending')
    .sort((a, b) => b.supported_range[0] - a.supported_range[0] || b.covered_weight - a.covered_weight);
  const deferred = results.filter(result => result.queue === 'deferred');
  const excluded = results.filter(result => result.queue === 'excluded');
  const leader = comparable[0];
  for (const result of pending) {
    result.may_exceed_comparable_leader = leader && result.conditional_total_range ? result.conditional_total_range[1] > leader.total_range[0] : null;
  }
  const queues = { comparable, pending, deferred, excluded };
  return {
    schema_version: 1, profile_revision: 50, total_budget: 100,
    candidates: Object.values(queues).flat(),
    order: Object.fromEntries(Object.entries(queues).map(([key, values]) => [key, values.map(result => result.candidate_id)])),
    comparable_leader: leader ? { candidate_id: leader.candidate_id, total_range: leader.total_range, conservative_score: leader.total_range[0] } : null,
    summary: {
      candidates: results.length, complete: comparable.length,
      complete_points: comparable.filter(result => result.total !== null).length,
      complete_ranges: comparable.filter(result => result.total === null).length,
      all_items_supported: results.filter(result => result.scoring_complete).length,
      partial: results.filter(result => !result.scoring_complete).length,
      pending: pending.length, deferred: deferred.length, excluded: excluded.length,
    },
  };
}
