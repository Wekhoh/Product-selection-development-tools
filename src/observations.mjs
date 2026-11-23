/** Observation validation and small provider adapters. No retrieval or scoring. */
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function validEvidenceDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(value)) return false;
  const day = value.slice(0, 10);
  const parsedDay = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(parsedDay) && new Date(parsedDay).toISOString().slice(0, 10) === day;
}

export function categoryReturnObservation(ratioComparison) {
  const valid = n => finite(n) && n >= 0 && n <= 100;
  const average = ratioComparison?.avgReturnRatio;
  const selected = ratioComparison?.returnRatio;
  return {
    value: valid(average) ? Number((average / 100).toFixed(10)) : null,
    unit: 'fraction',
    source_field: 'ratioComparison.avgReturnRatio',
    selected_market_value: valid(selected) ? Number((selected / 100).toFixed(10)) : null,
    selected_market_field: 'ratioComparison.returnRatio',
    reason: valid(average) ? 'Category-average percentage converted once.'
      : 'Category average is unavailable; selected-market return rate is not substituted.',
  };
}

/**
 * Resolve category return fraction under Revision 59 leaf-first priority (`preferLeafReturnRatio = true` by default):
 *  1. Primary queried leaf sub-category `returnRatio` (`ratioComparison.returnRatio`) when finite in `[0, 100]`.
 *  2. Same-report parent department benchmark `avgReturnRatio` (`ratioComparison.avgReturnRatio`) ONLY when leaf `returnRatio` is missing/null.
 *  3. Verified ancestor/parent report (`parentFallbackComparison`): adopts ancestor sub-category `returnRatio` when
 *     `is_ancestor_subcategory === true`, otherwise adopts parent department `avgReturnRatio` (never substituting an unrelated
 *     sibling leaf's `returnRatio`, `0.05`, or low-star 2x multipliers).
 * Passing `{ preferLeafReturnRatio: false }` preserves legacy `r50–r58` `avgReturnRatio`-only resolution.
 */
export function resolveCategoryReturnWithFallback(primaryRatioComparison, parentFallbackComparison = null, {
  preferLeafReturnRatio = true,
} = {}) {
  const valid = n => finite(n) && n >= 0 && n <= 100;
  const toFrac = n => Number((n / 100).toFixed(10));

  if (!preferLeafReturnRatio) {
    const primary = categoryReturnObservation(primaryRatioComparison);
    if (primary.value !== null) {
      return {
        ...primary,
        fallback_used: false,
        fallback_category_label: null,
        tag: null,
      };
    }
    const fallback = parentFallbackComparison ? categoryReturnObservation(parentFallbackComparison) : null;
    if (fallback && fallback.value !== null) {
      const parentLabel = typeof parentFallbackComparison?.category_label === 'string' && parentFallbackComparison.category_label.trim()
        ? parentFallbackComparison.category_label.trim()
        : '上级类目';
      return {
        ...fallback,
        source_field: 'parent_category.ratioComparison.avgReturnRatio',
        selected_market_value: primary.selected_market_value,
        fallback_used: true,
        fallback_category_label: parentLabel,
        tag: `微叶退货率NO_DATA·回退上级类目均值（${parentLabel}）`,
        reason: `Micro-leaf avgReturnRatio is NO_DATA; adopted verified parent category (${parentLabel}) avgReturnRatio once without selected-market substitution.`,
      };
    }
    return {
      ...primary,
      fallback_used: false,
      fallback_category_label: null,
      tag: '类目退货率NO_DATA·待补上级类目均值',
    };
  }

  const leafReturn = primaryRatioComparison?.returnRatio;
  const deptAvg = primaryRatioComparison?.avgReturnRatio;
  const leafFrac = valid(leafReturn) ? toFrac(leafReturn) : null;
  const deptFrac = valid(deptAvg) ? toFrac(deptAvg) : null;

  // Tier 1: Queried leaf sub-category's own returnRatio
  if (leafFrac !== null) {
    return {
      value: leafFrac,
      unit: 'fraction',
      source_field: 'ratioComparison.returnRatio',
      selected_market_value: leafFrac,
      selected_market_field: 'ratioComparison.returnRatio',
      department_average_value: deptFrac,
      department_average_field: 'ratioComparison.avgReturnRatio',
      fallback_used: false,
      fallback_category_label: null,
      tag: null,
      reason: 'Leaf sub-category returnRatio percentage converted once (r59 leaf-first priority; department avgReturnRatio retained separately).',
    };
  }

  // Tier 2: Same-payload parent department avgReturnRatio when leaf returnRatio is missing/null
  if (deptFrac !== null) {
    return {
      value: deptFrac,
      unit: 'fraction',
      source_field: 'ratioComparison.avgReturnRatio',
      selected_market_value: null,
      selected_market_field: 'ratioComparison.returnRatio',
      department_average_value: deptFrac,
      department_average_field: 'ratioComparison.avgReturnRatio',
      fallback_used: true,
      fallback_category_label: null,
      tag: '小类退货率缺失·回退大类基准均值',
      reason: 'Leaf sub-category returnRatio is unavailable; adopted verified department avgReturnRatio from the same report.',
    };
  }

  // Tier 3: Micro-leaf NO_DATA -> fall back strictly to verified parent/ancestor department avgReturnRatio
  if (parentFallbackComparison && typeof parentFallbackComparison === 'object') {
    const parentLabel = typeof parentFallbackComparison.category_label === 'string' && parentFallbackComparison.category_label.trim()
      ? parentFallbackComparison.category_label.trim()
      : '上级类目';
    const parentDeptFrac = valid(parentFallbackComparison.avgReturnRatio) ? toFrac(parentFallbackComparison.avgReturnRatio) : null;

    if (parentDeptFrac !== null) {
      return {
        value: parentDeptFrac,
        unit: 'fraction',
        source_field: 'parent_category.ratioComparison.avgReturnRatio',
        selected_market_value: null,
        selected_market_field: 'ratioComparison.returnRatio',
        department_average_value: parentDeptFrac,
        department_average_field: 'parent_category.ratioComparison.avgReturnRatio',
        fallback_used: true,
        fallback_category_label: parentLabel,
        tag: `微叶退货率NO_DATA·回退上级大类均值（${parentLabel}）`,
        reason: `Micro-leaf return metrics are NO_DATA; adopted verified parent department (${parentLabel}) avgReturnRatio without sibling-leaf substitution.`,
      };
    }
  }

  return {
    value: null,
    unit: 'fraction',
    source_field: 'ratioComparison.returnRatio',
    selected_market_value: null,
    selected_market_field: 'ratioComparison.returnRatio',
    department_average_value: null,
    department_average_field: 'ratioComparison.avgReturnRatio',
    fallback_used: false,
    fallback_category_label: null,
    tag: '类目退货率NO_DATA·待补上级类目退货率',
    reason: 'Leaf returnRatio and parent fallback return metrics are unavailable.',
  };
}

const BADGE_TIERS = Object.freeze([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);

function nextBadgeCeiling(badgeFloor) {
  const idx = BADGE_TIERS.findIndex(v => v === badgeFloor);
  if (idx >= 0 && idx + 1 < BADGE_TIERS.length) return BADGE_TIERS[idx + 1] - 1;
  if (badgeFloor >= 10000) return badgeFloor * 2 - 1;
  const higher = BADGE_TIERS.find(v => v > badgeFloor);
  return higher ? higher - 1 : badgeFloor + 49;
}

/**
 * 3-tier target child-ASIN sales resolver (`target_child_units`):
 *  - Tier 1 (`single_variant_exact`): single-variant parent exact monthly sales (`1–49/mo` observable).
 *  - Tier 2 (`multi_variant_badge_bound`): multi-variant with `50+ / 100+` badge -> `[B, nextTier - 1]`.
 *  - Tier 3 (`sub_50_active_starter` vs `dormant_zero` vs `missing_observation`): multi-variant returning `0`/empty
 *    is NEVER misclassified as zero sales when child review growth, ranked BSR, or SIF child keyword activity exists.
 *  - When multiple pure color variants share the exact physical spec, uses the median same-spec child as primary.
 */
export function resolveTargetChildSalesObservation(input = {}) {
  const asin = typeof input?.asin === 'string' && input.asin.trim() ? input.asin.trim().toUpperCase() : null;
  if (input?.query_completed === false) {
    return {
      asin,
      grain: 'target_child_units',
      tier: 'missing_observation',
      value: null,
      value_range: null,
      label: '未完成子体销量查询（待补证）',
      reason: 'Target child sales observation has not been queried yet; missing rows cannot be treated as <50 or 0.',
    };
  }

  if (Array.isArray(input?.same_spec_color_variants) && input.same_spec_color_variants.length > 0) {
    const validColors = input.same_spec_color_variants
      .filter(v => v && finite(v.units_30d) && v.units_30d >= 0)
      .sort((a, b) => a.units_30d - b.units_30d || String(a.asin || '').localeCompare(String(b.asin || '')));
    if (validColors.length > 0) {
      const midIdx = Math.floor((validColors.length - 1) / 2);
      const medianVal = validColors.length % 2 === 1
        ? validColors[midIdx].units_30d
        : Math.round(((validColors[midIdx].units_30d + validColors[midIdx + 1].units_30d) / 2) * 100) / 100;
      const topColor = [...validColors].sort((a, b) => b.units_30d - a.units_30d || String(a.asin || '').localeCompare(String(b.asin || '')))[0];
      return {
        asin: validColors[midIdx].asin ?? asin,
        grain: 'target_child_units',
        tier: 'same_spec_color_median',
        value: medianVal,
        bounds: [validColors[0].units_30d, validColors[validColors.length - 1].units_30d],
        top_color_variant: { asin: topColor.asin ?? null, color: topColor.color ?? null, units_30d: topColor.units_30d },
        label: `同规格纯颜色变体中位款 ${medianVal}/月（最畅销色 ${topColor.color ?? topColor.asin ?? '-'} ${topColor.units_30d}/月）`,
        reason: 'Computed median across same-specification pure color variants while preserving top-color note.',
      };
    }
  }

  const variantCount = Number.isInteger(input?.variant_count) && input.variant_count > 0 ? input.variant_count : null;
  const parentUnits = finite(input?.parent_monthly_units) && input.parent_monthly_units >= 0
    ? input.parent_monthly_units
    : (finite(input?.monthlySales) && input.monthlySales >= 0 ? input.monthlySales : null);

  if (variantCount === 1 && parentUnits !== null) {
    return {
      asin,
      grain: 'target_child_units',
      tier: 'single_variant_exact',
      value: parentUnits,
      bounds: [parentUnits, parentUnits],
      label: `${parentUnits}/月（单变体精确值）`,
      reason: 'Single-variant listing: parent monthly unit sales equal exact target child sales.',
    };
  }

  const rawBadge = input?.bought_in_past_month ?? input?.child_badge_units ?? input?.child_sales_units ?? null;
  let badgeNum = null;
  if (finite(rawBadge) && rawBadge >= 0) badgeNum = Math.floor(rawBadge);
  else if (typeof rawBadge === 'string') {
    const m = rawBadge.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([kK])?\s*\+?/);
    if (m) badgeNum = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  }

  if (badgeNum !== null && badgeNum >= 50) {
    const upper = parentUnits !== null && parentUnits >= badgeNum
      ? Math.min(parentUnits, nextBadgeCeiling(badgeNum))
      : nextBadgeCeiling(badgeNum);
    return {
      asin,
      grain: 'target_child_units',
      tier: 'multi_variant_badge_bound',
      value: null,
      value_range: [badgeNum, Math.max(badgeNum, upper)],
      coherent: true,
      range_basis: `Amazon child Past-Month badge ${badgeNum}+ bounded by next badge tier`,
      label: `${badgeNum}–${Math.max(badgeNum, upper)}/月（子体 ${badgeNum}+ 购买档）`,
      reason: 'Multi-variant child ASIN bounded by verified Past-Month purchase badge tier.',
    };
  }

  // Multi-variant returning 0 / null / empty childSales (<50/mo badge threshold):
  const reviewDelta = finite(input?.child_review_delta_30d) ? input.child_review_delta_30d : 0;
  const leafRank = finite(input?.leaf_bsr_rank) && input.leaf_bsr_rank > 0 ? input.leaf_bsr_rank : null;
  const sifChildKeywords = finite(input?.sif_child_keyword_count) ? input.sif_child_keyword_count : 0;
  const hasActiveSignal = reviewDelta > 0 || (leafRank !== null && leafRank <= 200) || sifChildKeywords > 0 || (parentUnits !== null && parentUnits > 0 && input?.is_primary_spec_variant === true);

  if (hasActiveSignal) {
    const cap = parentUnits !== null && parentUnits > 0 ? Math.min(49, parentUnits) : 49;
    return {
      asin,
      grain: 'target_child_units',
      tier: 'sub_50_active_starter',
      value: null,
      value_range: [1, Math.max(1, cap)],
      coherent: true,
      range_basis: 'Multi-variant child below 50+ badge threshold with active review/BSR/keyword traction (<50/mo)',
      label: `<50/月（蓝海起步档/待核 · 1–${Math.max(1, cap)}/月）`,
      reason: 'Tools return 0/empty below the 50+/mo badge floor; active child BSR/review/traffic signals confirm positive starter traction (<50/mo) rather than zero sales.',
    };
  }

  if (badgeNum === 0 && input?.confirmed_dormant_zero === true) {
    return {
      asin,
      grain: 'target_child_units',
      tier: 'dormant_zero',
      value: 0,
      bounds: [0, 0],
      label: '0/月（已核无动销）',
      reason: 'Confirmed dormant child variant with zero sales and zero active BSR/review/traffic signals.',
    };
  }

  if (variantCount !== null && variantCount > 1 && input?.query_completed === true) {
    return {
      asin,
      grain: 'target_child_units',
      tier: 'sub_50_unconfirmed',
      value: null,
      value_range: [0, 49],
      coherent: true,
      range_basis: 'Multi-variant child below 50+ badge floor without disambiguating child activity check',
      label: '<50/月（待核子体活跃度）',
      reason: 'Below 50+/mo badge threshold; check child review growth, child BSR, or SIF child traffic trend.',
    };
  }

  return {
    asin,
    grain: 'target_child_units',
    tier: 'missing_observation',
    value: null,
    label: '未提供有效子体销量观测（待补证）',
    reason: 'Missing target child ASIN sales observation; empty inputs cannot fabricate a [0, 49] sales range.',
  };
}

/**
 * Deduplicate SellerSprite / search rows strictly once per canonical parent family (`parent || parent_asin || asin`)
 * within a single market & 30-day window so sibling child rows never double-count parent `monthlySales`.
 */
export function deduplicateParentSalesRows(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array.');
  const byParent = new Map();
  const duplicateChildAsins = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r !== 'object') continue;
    const asin = typeof r.asin === 'string' && r.asin.trim() ? r.asin.trim().toUpperCase() : `ROW-${i + 1}`;
    const parentKey = String(r.parent_asin ?? r.parent ?? r.family_id ?? asin).trim().toUpperCase() || asin;
    const units = [r.parent_units, r.monthly_units, r.monthlySales, r.units_30d, r.units, r.sales].find(v => finite(v) && v >= 0) ?? null;
    if (!byParent.has(parentKey)) {
      byParent.set(parentKey, { parent_id: parentKey, representative_asin: asin, units_30d: units, member_asins: [asin] });
    } else {
      const prev = byParent.get(parentKey);
      prev.member_asins.push(asin);
      duplicateChildAsins.push(asin);
      if (prev.units_30d === null && units !== null) prev.units_30d = units;
    }
  }
  const families = [...byParent.values()];
  const allSupported = families.length > 0 && families.every(f => f.units_30d !== null);
  return {
    input_row_count: rows.length,
    deduplicated_parent_count: families.length,
    duplicate_sibling_count: duplicateChildAsins.length,
    duplicate_sibling_asins: duplicateChildAsins,
    total_parent_units: allSupported ? families.reduce((s, f) => s + f.units_30d, 0) : null,
    families,
  };
}

/**
 * Validate SellerSprite `keyword_google_trend` by actual deduplicated weekly points, span, and gaps
 * rather than daily-denominator `coverageRate` (where 260 weeks / 1825 days = 14.25%).
 */
export function evaluateGoogleTrendsSeries(rawPayload = {}) {
  const rawProp = String(rawPayload?.googleProp ?? rawPayload?.property ?? 'web').trim();
  const normalizedProp = /^shopping/i.test(rawProp) ? 'shoppingCart' : 'web';
  const rawList = Array.isArray(rawPayload?.series)
    ? rawPayload.series
    : Array.isArray(rawPayload?.series?.interest)
      ? rawPayload.series.interest
      : Array.isArray(rawPayload?.interest)
        ? rawPayload.interest
        : Array.isArray(rawPayload?.points)
          ? rawPayload.points
          : [];
  // Bucket strictly by ISO 7-day week epochs (beginning Monday 1970-01-05 UTC) so daily points inside the same week
  // never inflate `unique_weeks` (e.g., two 52-day daily blocks = ~16 distinct weeks, not 104).
  const EPOCH_MONDAY_MS = Date.parse('1970-01-05T00:00:00Z');
  const byWeekBucket = new Map();
  for (const pt of rawList) {
    const rawDate = typeof pt?.date === 'string' ? pt.date.slice(0, 10)
      : (finite(pt?.timestamp) ? new Date(pt.timestamp * (pt.timestamp < 1e11 ? 1000 : 1)).toISOString().slice(0, 10) : null);
    const val = [pt?.value, pt?.interest, pt?.score].find(v => finite(v) && v >= 0) ?? null;
    if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && val !== null) {
      const ms = Date.parse(`${rawDate}T00:00:00Z`);
      if (!Number.isFinite(ms)) continue;
      const weekIdx = Math.floor((ms - EPOCH_MONDAY_MS) / (7 * 86400000));
      const weekStartIso = new Date(EPOCH_MONDAY_MS + weekIdx * 7 * 86400000).toISOString().slice(0, 10);
      byWeekBucket.set(weekStartIso, val);
    }
  }
  const sortedDates = [...byWeekBucket.keys()].sort();
  let gapCount = 0;
  let maxGapDays = 0;
  for (let i = 1; i < sortedDates.length; i++) {
    const d0 = Date.parse(`${sortedDates[i - 1]}T00:00:00Z`);
    const d1 = Date.parse(`${sortedDates[i]}T00:00:00Z`);
    const diffDays = (d1 - d0) / 86400000;
    if (diffDays > maxGapDays) maxGapDays = diffDays;
    if (diffDays > 14.5) gapCount++;
  }
  const spanDays = sortedDates.length >= 2
    ? (Date.parse(`${sortedDates[sortedDates.length - 1]}T00:00:00Z`) - Date.parse(`${sortedDates[0]}T00:00:00Z`)) / 86400000
    : 0;
  const spanWeeks = Math.round(spanDays / 7);
  const weekDensity = spanWeeks > 0 ? sortedDates.length / (spanWeeks + 1) : 0;
  const sufficientMultiyear = normalizedProp === 'web' &&
    sortedDates.length >= 104 &&
    spanWeeks >= 100 &&
    gapCount <= 6 &&
    maxGapDays <= 35 &&
    weekDensity >= 0.85;
  return {
    normalized_prop: normalizedProp,
    raw_prop: rawProp,
    reported_coverage_rate: finite(rawPayload?.coverageRate) ? rawPayload.coverageRate : null,
    unique_weeks: sortedDates.length,
    first_week: sortedDates[0] ?? null,
    last_week: sortedDates[sortedDates.length - 1] ?? null,
    span_weeks: spanWeeks,
    internal_gap_count: gapCount,
    max_gap_days: maxGapDays,
    is_sufficient_multiyear_weekly: sufficientMultiyear,
    note: sufficientMultiyear
      ? `Google Trends (${normalizedProp}) 含 ${sortedDates.length} 个去重周点（跨 ${spanWeeks} 周），按周序列完整度核验通过（原生 coverageRate 按日历天分母折算属正常现象）。`
      : `Google Trends (${normalizedProp}) 仅 ${sortedDates.length} 个有效周点（跨 ${spanWeeks} 周，断档 ${gapCount} 处），不可夸大为多年长期趋势。`,
  };
}

/**
 * Classify Keepa historical review-count trajectories into objective card tags without hardcoded review-rate kills:
 * distinguishes normal Vine 2/10/30 trickle, variant-split drops, and sharp nonlinear step-jumps.
 */
export function classifyKeepaReviewTrajectory(points = [], { vine_tier = null, variant_split_detected = false } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return {
      classification: 'unobserved',
      tag: 'Keepa评论历史未取得',
      max_step_delta: null,
    };
  }
  const sorted = points
    .filter(p => p && typeof p.date === 'string' && finite(p.reviews) && p.reviews >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) {
    return { classification: 'unobserved', tag: 'Keepa评论历史未取得', max_step_delta: null };
  }
  let maxJump = 0;
  let maxDrop = 0;
  for (let i = 1; i < sorted.length; i++) {
    const d0 = Date.parse(`${sorted[i - 1].date.slice(0, 10)}T00:00:00Z`);
    const d1 = Date.parse(`${sorted[i].date.slice(0, 10)}T00:00:00Z`);
    const days = Math.max(1, (d1 - d0) / 86400000);
    const delta = sorted[i].reviews - sorted[i - 1].reviews;
    if (delta > 0 && days <= 7 && delta > maxJump) maxJump = delta;
    if (delta < 0 && Math.abs(delta) > maxDrop) maxDrop = Math.abs(delta);
  }
  if (maxJump > 35) {
    return {
      classification: 'sharp_nonlinear_step_jump',
      tag: `Keepa评论阶梯骤增预警（7天内骤增 +${maxJump} 条，疑合并变体/异常操控）`,
      max_step_delta: maxJump,
    };
  }
  if (variant_split_detected || maxDrop >= 15) {
    return {
      classification: 'variant_split_drop',
      tag: `拆变体评数变动（单次掉评 -${maxDrop} 条）`,
      max_step_delta: -maxDrop,
    };
  }
  if ([2, 10, 30].includes(vine_tier) || (sorted[0].reviews <= 2 && sorted[sorted.length - 1].reviews <= 35)) {
    return {
      classification: 'vine_gradual_ramp',
      tag: vine_tier ? `Vine ${vine_tier}档常规回评爬坡` : '常规自然/Vine渐进回评',
      max_step_delta: maxJump,
    };
  }
  return {
    classification: 'steady_organic_accumulation',
    tag: null,
    max_step_delta: maxJump,
  };
}

export function observedDailyUnits(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Nonempty declared daily observations required');
  const dates = new Set();
  let observed = 0, missing = 0;
  for (const row of rows) {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      dates.has(row.date)) throw new TypeError('Unique valid daily dates required');
    dates.add(row.date);
    if (row.units === null || row.units === -1) { missing++; continue; }
    if (!finite(row.units) || row.units < 0) throw new TypeError('Units must be nonnegative or the declared null/-1 missing sentinel');
    observed += row.units;
    if (!Number.isFinite(observed)) throw new TypeError('Unit total exceeds finite numeric range');
  }
  return { observed_units: observed, observed_days: rows.length - missing, missing_days: missing,
    declared_days: rows.length, complete_declared_rows: missing === 0,
    // Completeness applies only to supplied rows, not an unobserved calendar window.
    complete_window_units: null };
}
