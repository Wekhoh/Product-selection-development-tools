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
  const hasActiveSignal = reviewDelta > 0 || leafRank !== null || sifChildKeywords > 0 || (parentUnits !== null && parentUnits > 0 && input?.is_primary_spec_variant === true);

  if (hasActiveSignal) {
    const cap = parentUnits !== null && parentUnits > 0 ? Math.min(49, parentUnits) : 49;
    const highLeafRankAdvisory = leafRank !== null && leafRank > 200;
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
      ...(highLeafRankAdvisory ? {
        high_leaf_rank_advisory: true,
        advisory_note: `细分类目 BSR 排名 #${leafRank}（>200），按 <50/月非阻断起步区间保留，建议结合评论增量或词流复核动销。`,
      } : {}),
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
 * Extract objective Keepa review-curve facts and attach qualitative review-trajectory tags
 * without unapproved hardcoded step-jump/drop numeric cutoffs.
 */
export function classifyKeepaReviewTrajectory(points = [], {
  vine_tier = null,
  variant_split_detected = false,
  ai_review_anomaly = false,
  qualitative_tag = null,
} = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return {
      classification: 'unobserved',
      tag: 'Keepa评论历史未取得',
      max_step_delta: null,
      observed_facts: null,
    };
  }
  const sorted = points
    .filter(p => p && typeof p.date === 'string' && finite(p.reviews) && p.reviews >= 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) {
    return { classification: 'unobserved', tag: 'Keepa评论历史未取得', max_step_delta: null, observed_facts: null };
  }
  let maxJump = 0;
  let maxDrop = 0;
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i].reviews - sorted[i - 1].reviews;
    if (delta > maxJump) maxJump = delta;
    if (delta < 0 && Math.abs(delta) > maxDrop) maxDrop = Math.abs(delta);
  }
  const startReviews = sorted[0].reviews;
  const endReviews = sorted[sorted.length - 1].reviews;
  const observedFacts = {
    point_count: sorted.length,
    start_date: sorted[0].date.slice(0, 10),
    end_date: sorted[sorted.length - 1].date.slice(0, 10),
    start_reviews: startReviews,
    end_reviews: endReviews,
    net_delta: endReviews - startReviews,
    max_positive_step: maxJump,
    max_negative_step: maxDrop,
  };
  if (ai_review_anomaly === true) {
    return {
      classification: 'qualitative_review_anomaly_watch',
      tag: typeof qualitative_tag === 'string' && qualitative_tag.trim()
        ? qualitative_tag.trim()
        : `Keepa评论曲线异常提醒（期初 ${startReviews} -> 期末 ${endReviews}，最大单次变动 +${maxJump}/-${maxDrop}）`,
      max_step_delta: maxJump,
      observed_facts: observedFacts,
    };
  }
  if (variant_split_detected === true) {
    return {
      classification: 'variant_split_drop',
      tag: typeof qualitative_tag === 'string' && qualitative_tag.trim()
        ? qualitative_tag.trim()
        : `拆变体评数变动（最大单次掉评 -${maxDrop} 条）`,
      max_step_delta: -maxDrop,
      observed_facts: observedFacts,
    };
  }
  if ([2, 10, 30].includes(vine_tier)) {
    return {
      classification: 'vine_gradual_ramp',
      tag: `Vine ${vine_tier}档回评爬坡`,
      max_step_delta: maxJump,
      observed_facts: observedFacts,
    };
  }
  return {
    classification: 'steady_organic_accumulation',
    tag: typeof qualitative_tag === 'string' && qualitative_tag.trim() ? qualitative_tag.trim() : null,
    max_step_delta: maxJump,
    observed_facts: observedFacts,
  };
}

const WRITTEN_REVIEW_TEXT_KEYS = Object.freeze([
  'content',
  'body',
  'text',
  'review_text',
  'reviewText',
  'comment',
  'title',
  'headline',
]);

function hasUpstreamReviewFailure(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.isError === true) return true;
  if (obj.error !== undefined && obj.error !== null && obj.error !== false && obj.error !== '') return true;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return true;
  if (obj.status === 'failed' || obj.status === 'error') return true;
  if (obj.dataStatus === 'NO_DATA') return true;
  if (obj.code !== undefined && obj.code !== null && !['OK', '0', 0, 200].includes(obj.code)) return true;
  return false;
}

function extractRawReviewRows(source, depth = 0) {
  if (!source || depth > 4) return { hasRawArray: false, rows: null, failed: false };
  if (Array.isArray(source)) return { hasRawArray: true, rows: source, failed: false };
  if (typeof source !== 'object') return { hasRawArray: false, rows: null, failed: false };
  if (hasUpstreamReviewFailure(source)) return { hasRawArray: false, rows: null, failed: true };

  if (source.reviews_raw !== undefined && source.reviews_raw !== null) {
    return extractRawReviewRows(source.reviews_raw, depth + 1);
  }
  if (Array.isArray(source.content)) {
    for (const block of source.content) {
      if (!block) continue;
      if (block.isError === true) return { hasRawArray: false, rows: null, failed: true };
      if (typeof block.text !== 'string') continue;
      const trimmed = block.text.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        if (hasUpstreamReviewFailure(JSON.parse(trimmed))) {
          return { hasRawArray: false, rows: null, failed: true };
        }
      } catch {
        // Ignore non-JSON text blocks.
      }
    }
  }
  if (Array.isArray(source.reviews_list)) return { hasRawArray: true, rows: source.reviews_list, failed: false };
  if (Array.isArray(source.reviews)) return { hasRawArray: true, rows: source.reviews, failed: false };
  if (source.data && typeof source.data === 'object') {
    const nested = extractRawReviewRows(source.data, depth + 1);
    if (nested.failed || nested.hasRawArray) return nested;
  }
  if (source.structuredContent && typeof source.structuredContent === 'object') {
    const nested = extractRawReviewRows(source.structuredContent, depth + 1);
    if (nested.failed || nested.hasRawArray) return nested;
  }
  if (Array.isArray(source.content)) {
    for (const block of source.content) {
      if (!block || typeof block.text !== 'string') continue;
      const trimmed = block.text.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const nested = extractRawReviewRows(parsed, depth + 1);
        if (nested.failed || nested.hasRawArray) return nested;
      } catch {
        // Ignore non-JSON text blocks.
      }
    }
  }
  return { hasRawArray: false, rows: null, failed: false };
}

function isWrittenReviewRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (
    row.star_only === true ||
    row.rating_only === true ||
    row.is_rating_only === true ||
    row.has_text === false ||
    /^(?:star|rating)[-_ ]?only$/i.test(String(row.review_type ?? row.type ?? '').trim())
  ) {
    return false;
  }
  return WRITTEN_REVIEW_TEXT_KEYS.some(key => typeof row[key] === 'string' && row[key].trim().length > 0);
}

function tallyReviewSample(rows) {
  if (!Array.isArray(rows)) return null;
  const sample = { size: 0, vine_count: 0, vp_count: 0, direct_count: 0, unknown_count: 0 };
  for (const row of rows) {
    if (!isWrittenReviewRow(row)) continue;
    sample.size++;
    const explicitNotVine = row.vine === false || row.is_vine === false;
    const badgeOrigin = [row.badge, row.origin].filter(v => typeof v === 'string' && v.trim().length > 0).join(' ');
    const badgeIsVine = !explicitNotVine && /vine/i.test(badgeOrigin) && !/non[-_ ]?vine/i.test(badgeOrigin);
    if (row.is_vine === true || row.vine === true || badgeIsVine) {
      sample.vine_count++;
    } else if (row.purchased === true || row.verified_purchase === true || row.is_vp === true || row.vp === true) {
      sample.vp_count++;
    } else if (
      row.direct === true ||
      row.verified_purchase === false ||
      row.is_vp === false ||
      row.vp === false ||
      (row.purchased === false && explicitNotVine)
    ) {
      sample.direct_count++;
    } else {
      sample.unknown_count++;
    }
  }
  return sample.size > 0 ? sample : null;
}

function isValidTalliedSample(sample) {
  return Boolean(
    sample &&
    typeof sample === 'object' &&
    !Array.isArray(sample) &&
    Number.isInteger(sample.size) && sample.size > 0 &&
    Number.isInteger(sample.vine_count) && sample.vine_count >= 0 &&
    Number.isInteger(sample.vp_count) && sample.vp_count >= 0 &&
    Number.isInteger(sample.direct_count) && sample.direct_count >= 0 &&
    Number.isInteger(sample.unknown_count) && sample.unknown_count >= 0 &&
    sample.vine_count + sample.vp_count + sample.direct_count + sample.unknown_count === sample.size,
  );
}

function extractIndependentReviewSummaryFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { vine: null, vp: null, direct: null, vineShare: null, vpShare: null, directShare: null };
  }
  const pickNonNeg = (...vals) => {
    for (const v of vals) {
      if (finite(v) && v >= 0) return v;
    }
    return null;
  };
  const vine = pickNonNeg(obj.vine_count, obj.vineCount, obj.vine_reviews, obj.vineReviews);
  const vp = pickNonNeg(obj.vp_count, obj.vpCount, obj.vp_reviews, obj.verified_purchase_count, obj.verifiedPurchaseCount, obj.vpReviews);
  const direct = pickNonNeg(
    obj.direct_count,
    obj.directCount,
    obj.direct_review_count,
    obj.directReviewCount,
    obj.non_vp_direct_reviews,
    obj.direct_reviews,
    obj.unverified_review_count,
    obj.unverifiedReviewCount,
    obj.directReviews,
  );
  const vineShare = finite(obj.vine_share) && obj.vine_share >= 0 && obj.vine_share <= 1 ? obj.vine_share : null;
  const vpShare = finite(obj.vp_share) && obj.vp_share >= 0 && obj.vp_share <= 1 ? obj.vp_share : null;
  const directShare = finite(obj.direct_share) && obj.direct_share >= 0 && obj.direct_share <= 1 ? obj.direct_share : null;
  return { vine, vp, direct, vineShare, vpShare, directShare };
}

function extractExternalSummaryFields(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const top = extractIndependentReviewSummaryFields(source);
  const nested = source.data && typeof source.data === 'object' && !Array.isArray(source.data)
    ? extractIndependentReviewSummaryFields(source.data)
    : null;
  if (!nested) return top;
  return {
    vine: top.vine ?? nested.vine,
    vp: top.vp ?? nested.vp,
    direct: top.direct ?? nested.direct,
    vineShare: top.vineShare ?? nested.vineShare,
    vpShare: top.vpShare ?? nested.vpShare,
    directShare: top.directShare ?? nested.directShare,
  };
}

/**
 * Summarize reported totals and inspected written-review samples at their respective scopes.
 * Counts written text reviews only (excluding star-only / empty-text ratings), classifies complete rows strictly
 * into Vine / VP / 直评, reserves `来源字段缺失` for omitted upstream origin flags, and never resurrects a stale
 * cached breakdown when a raw review array or fresh `reviews_raw` payload is supplied.
 */
export function extractNewcomerReviewOriginBreakdown(raw = {}) {
  if (!raw || typeof raw !== 'object' || hasUpstreamReviewFailure(raw)) return null;
  const hasFreshReviewsRaw = raw.reviews_raw !== undefined && raw.reviews_raw !== null;
  const { hasRawArray, rows, failed } = extractRawReviewRows(raw);
  let sample = hasRawArray && !failed ? tallyReviewSample(rows) : null;
  const cached = raw.review_origin_breakdown;
  const rawFields = extractIndependentReviewSummaryFields(raw);
  const extSummary = !failed && hasFreshReviewsRaw ? extractExternalSummaryFields(raw.reviews_raw) : null;
  let vine = rawFields.vine ?? extSummary?.vine ?? null;
  let vp = rawFields.vp ?? extSummary?.vp ?? null;
  let direct = rawFields.direct ?? extSummary?.direct ?? null;
  let vineShare = rawFields.vineShare ?? extSummary?.vineShare ?? null;
  let vpShare = rawFields.vpShare ?? extSummary?.vpShare ?? null;
  let directShare = rawFields.directShare ?? extSummary?.directShare ?? null;

  const hasIndependent = vine !== null || vp !== null || direct !== null || vineShare !== null || vpShare !== null || directShare !== null;
  if (!hasRawArray && !hasFreshReviewsRaw && !failed && cached && typeof cached === 'object' && !Array.isArray(cached)) {
    if (!hasIndependent) {
      if ((typeof cached.display_zh === 'string' && cached.display_zh.trim()) ||
        (typeof cached.summary_zh === 'string' && cached.summary_zh.trim())) {
        return cached;
      }
      if (isValidTalliedSample(cached.sample)) {
        sample = cached.sample;
      } else {
        const cachedFields = extractIndependentReviewSummaryFields(cached);
        vine = cachedFields.vine;
        vp = cachedFields.vp;
        direct = cachedFields.direct;
        vineShare = cachedFields.vineShare;
        vpShare = cachedFields.vpShare;
        directShare = cachedFields.directShare;
      }
    } else if (!sample && isValidTalliedSample(cached.sample)) {
      sample = cached.sample;
    }
  }

  const parts = [];
  if (vine !== null) parts.push(`Vine ${vine}`);
  else if (vineShare !== null) parts.push(`Vine ${(vineShare * 100).toFixed(0)}%`);
  if (vp !== null) parts.push(`VP ${vp}`);
  else if (vpShare !== null) parts.push(`VP ${(vpShare * 100).toFixed(0)}%`);
  if (direct !== null) parts.push(`直评 ${direct}`);
  else if (directShare !== null) parts.push(`直评 ${(directShare * 100).toFixed(0)}%`);

  if (!parts.length && !sample) return null;
  let summaryText = parts.join(' · ');
  if (sample) {
    let sampleText;
    if (sample.unknown_count === 0) {
      sampleText = `抽查 ${sample.size} 篇文字评：Vine ${sample.vine_count} · VP ${sample.vp_count} · 直评 ${sample.direct_count}`;
    } else {
      const observed = [
        ['Vine', sample.vine_count],
        ['VP', sample.vp_count],
        ['直评', sample.direct_count],
        ['来源字段缺失', sample.unknown_count],
      ].filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
      sampleText = `抽查 ${sample.size} 篇文字评：${observed.join(' · ')}`;
    }
    summaryText = summaryText ? `来源汇总 ${summaryText}。${sampleText}` : sampleText;
  }
  // A zero among identified rows cannot establish absence when other rows lack origin flags.
  const sampleCount = key => (sample && (sample[key] > 0 || sample.unknown_count === 0) ? sample[key] : null);
  return {
    vine_count: vine ?? sampleCount('vine_count'),
    vp_count: vp ?? sampleCount('vp_count'),
    direct_count: direct ?? sampleCount('direct_count'),
    vine_share: vineShare,
    vp_share: vpShare,
    direct_share: directShare,
    ...(sample ? { sample } : {}),
    summary_zh: summaryText,
    display_zh: summaryText,
  };
}

function hasDirectRawReviewFields(obj) {
  return Boolean(
    obj && typeof obj === 'object' && (
      Array.isArray(obj) ||
      (obj.reviews_raw !== undefined && obj.reviews_raw !== null) ||
      Array.isArray(obj.reviews_list) ||
      Array.isArray(obj.reviews) ||
      Array.isArray(obj.content) ||
      (obj.structuredContent && typeof obj.structuredContent === 'object')
    ),
  );
}

/**
 * Derive a sanitized `review_origin_breakdown` and strip raw reviewer payloads (author names / review text)
 * from a shallow copy of a newcomer cohort member without mutating the caller's object or deleting non-array
 * scalar fields (e.g., numeric `reviews: 84` or plain string `content`).
 */
export function sanitizeNewcomerMemberReviews(member) {
  if (!member || typeof member !== 'object' || Array.isArray(member)) return member;
  const hasDirect = hasDirectRawReviewFields(member);
  const hasNestedData = Boolean(
    member.data && typeof member.data === 'object' && (
      hasDirectRawReviewFields(member.data) ||
      hasDirectRawReviewFields(member.data.data)
    ),
  );
  if (!hasDirect && !hasNestedData) return member;

  const originBreakdown = extractNewcomerReviewOriginBreakdown(member);
  const sanitized = { ...member };
  delete sanitized.reviews_raw;
  if (Array.isArray(sanitized.reviews_list)) delete sanitized.reviews_list;
  if (Array.isArray(sanitized.reviews)) delete sanitized.reviews;
  if (Array.isArray(sanitized.content)) delete sanitized.content;
  if (sanitized.structuredContent && typeof sanitized.structuredContent === 'object') delete sanitized.structuredContent;
  if (hasNestedData) delete sanitized.data;
  if (originBreakdown) {
    sanitized.review_origin_breakdown = originBreakdown;
  } else {
    delete sanitized.review_origin_breakdown;
  }
  return sanitized;
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
