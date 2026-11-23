/**
 * 2026-11-19 front-end calibrations:
 *  1. Cross-category Gate-0 exclusion / boundary filter (exclude children's products;
 *     configurable red-ocean avoid defaults; allow low-risk powered non-3C with explicit compliance/cost items).
 *  2. Stage-1 mainstream price-band denoising + width guardrail (exclude FBM, <10/mo zombies, children's items,
 *     optional FBA size-tier mismatches; isolate <90-180d launch-spiral & heavy-coupon outliers into spiral_watch[];
 *     compute sales-weighted P25-P75; trigger width alarm when P75/P25 > 1.35 or margin spread > 12-15pp).
 *  3. Stage-2 visual cluster band tightening (tightenClusterBands).
 * Pure deterministic module; performs zero I/O or network calls.
 */
import { classifyStandardSize2027, estimateGate1A2027 } from './fba-rates-2027.mjs';
import { toBigRat } from './fee-basis.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const round = (v, digits = 4) => Math.round((v + Number.EPSILON) * (10 ** digits)) / (10 ** digits);
const isoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

const CHILDRENS_RE = /\b(baby|babies|toddler|infant|newborn|kids?|children|child's|childrens|nursery|stroller|crib|pacifier|teether|diaper|onesie|playpen|sippy|car\s+seat|booster\s+seat|toys?\s+for\s+(?:ages?|boys?|girls?)|montessori|plush\s+toy|baby\s+monitor)\b|(?:婴童|母婴|婴儿|儿童|宝宝|幼儿|童装|儿童玩具|奶瓶|安全座椅)/i;

const RED_OCEAN_RULES = Object.freeze({
  apparel: {
    re: /\b(t-?shirt|hoodie|jeans|leggings|dress(?:es)?|sneakers?|boots?|sandals?|jacket|coat|sweater|socks|underwear|lingerie|swimwear|bikini|pajamas|apparel|clothing|footwear|shoes)\b|(?:服装|鞋靴|鞋帽|连衣裙|卫衣|牛仔裤|内衣|睡衣)/i,
    rootCategories: ['clothing, shoes & jewelry', 'clothing, shoes and jewelry', 'apparel', 'shoes', 'fashion'],
    label: 'red_ocean_apparel',
  },
  consumer_electronics_3c: {
    re: /\b(iphone\s+case|phone\s+case|screen\s+protector|earbuds?|airpods|bluetooth\s+headphones?|power\s+bank|usb-?c\s+cable|lightning\s+cable|phone\s+charger|wall\s+charger|laptop\s+stand|tablet\s+case|smartwatch|webcam|gaming\s+mouse|mechanical\s+keyboard|router\s+wifi|cell\s+phones?)\b|(?:手机壳|钢化膜|蓝牙耳机|充电宝|数据线|快充头|3c数码|消费电子)/i,
    rootCategories: ['cell phones & accessories', 'cell phones and accessories', 'computers & accessories', 'electronics > cell phones'],
    label: 'red_ocean_3c_electronics',
  },
  red_ocean_furniture: {
    re: /\b(sofa|couch|sectional|mattress|bed\s+frame|wardrobe|armoire|dining\s+table|coffee\s+table|office\s+chair|gaming\s+chair|computer\s+desk|standing\s+desk|bookshelf|dresser|recliner|nightstand)\b|(?:沙发|床垫|床架|衣柜|餐桌|办公椅|电竞椅|电脑桌|书柜|大件家具)/i,
    rootCategories: ['furniture', 'home & kitchen > furniture', 'office furniture'],
    label: 'red_ocean_furniture',
  },
  fda_ingestible_topical: {
    re: /\b(supplement|vitamin|probiotic|gummies|protein\s+powder|capsule|tablet|serum|moisturizer|sunscreen|shampoo|lotion|lipstick|mascara|essential\s+oil\s+ingest|snack|coffee\s+beans?|tea\s+bags?|pet\s+food|dog\s+treats?)\b|(?:保健品|食品|护肤品|化妆品|涂抹美妆|宠物食品)/i,
    rootCategories: ['grocery & gourmet food', 'health & household > vitamins & dietary supplements', 'beauty & personal care > skin care'],
    label: 'fda_ingestible_topical',
  },
});

const POWERED_RE = /\b(led|rechargeable|cordless|battery\s+powered|usb\s+powered|electric|motorized|110v|120v|12v|24v|ip68|solar\s+powered|pump|heater|heated|ultrasonic|digital\s+display|smart\s+timer|adapter|plug-in)\b|(?:带电|插电|充电|锂电|电机|电动|led灯|数显|恒温)/i;

const DEFAULT_GATE0_CONFIG = Object.freeze({
  exclude_childrens_products: true,
  avoid_red_ocean: Object.freeze({
    apparel: true,
    consumer_electronics_3c: true,
    red_ocean_furniture: true,
    fda_ingestible_topical: false,
  }),
  allow_low_risk_powered_non_3c: true,
});

function gatherSearchText(item) {
  return [
    item?.title,
    item?.label,
    item?.keyword,
    item?.phrase_or_title,
    item?.buyer_task,
    item?.category_path,
    item?.root_category,
    item?.fee_category,
    item?.description,
    ...(Array.isArray(item?.tags) ? item.tags : []),
  ].filter(v => typeof v === 'string' && v.trim()).join(' | ');
}

function matchesCategoryRoot(item, roots) {
  const catText = [item?.root_category, item?.category_path, item?.fee_category]
    .filter(v => typeof v === 'string' && v.trim())
    .join(' > ')
    .toLowerCase();
  if (!catText) return false;
  return roots.some(r => catText.includes(r));
}

/**
 * Cross-category Gate-0 boundary filter (DECISIONS.md 2026-11-19):
 * - Hard-excludes children's products (CPC / safety liability).
 * - Applies configurable quota-saving avoid defaults for red-ocean apparel, 3C electronics, and furniture.
 * - Explicitly permits low-risk powered non-3C items with required compliance/battery/freight cost disclosures.
 */
export function evaluateGate0CategoryBoundary(item, config = {}) {
  // Children's/baby/CPC safety exclusion is a fixed non-overridable boundary; only red-ocean avoidance is configurable.
  const avoidCfg = {
    ...DEFAULT_GATE0_CONFIG.avoid_red_ocean,
    ...(config.avoid_red_ocean && typeof config.avoid_red_ocean === 'object' ? config.avoid_red_ocean : {}),
  };
  const allowPoweredNon3c = config.allow_low_risk_powered_non_3c ?? DEFAULT_GATE0_CONFIG.allow_low_risk_powered_non_3c;
  const textBlob = gatherSearchText(item);

  const isKids = Boolean(
    item?.is_childrens_product === true ||
    item?.is_children_product === true ||
    item?.cpc_required === true ||
    ['kids', 'child', 'children', 'baby', 'toddler', 'infant'].includes(String(item?.age_group || '').trim().toLowerCase()) ||
    CHILDRENS_RE.test(textBlob),
  );
  if (isKids) {
    return {
      passed: false,
      verdict: 'excluded_childrens_product',
      hard_exclusion: true,
      reasons: ['Excluded under fixed Gate-0 children/baby/CPC safety-compliance boundary (non-overridable).'],
      powered_non_3c: false,
      required_cost_and_compliance_items: [],
    };
  }

  const redOceanHits = [];
  for (const [key, rule] of Object.entries(RED_OCEAN_RULES)) {
    if (!avoidCfg[key]) continue;
    const explicitFlag =
      (key === 'apparel' && (item?.is_apparel === true || item?.is_apparel_or_shoes === true)) ||
      (key === 'consumer_electronics_3c' && item?.is_3c_electronics === true) ||
      (key === 'red_ocean_furniture' && item?.is_red_ocean_furniture === true) ||
      (key === 'fda_ingestible_topical' && item?.is_fda_ingestible_topical === true);
    if (explicitFlag || matchesCategoryRoot(item, rule.rootCategories) || rule.re.test(textBlob)) {
      redOceanHits.push(rule.label);
    }
  }
  if (redOceanHits.length > 0) {
    return {
      passed: false,
      verdict: 'skipped_red_ocean_default',
      hard_exclusion: false,
      configurable_skip: true,
      matched_filters: redOceanHits,
      reasons: [`Skipped by configurable Gate-0 red-ocean filter (${redOceanHits.join(', ')}); owner may disable filter to inspect.`],
      powered_non_3c: false,
      required_cost_and_compliance_items: [],
    };
  }

  const isPowered = Boolean(
    item?.is_powered === true ||
    item?.has_battery === true ||
    ['builtin', 'included'].includes(String(item?.battery_type || '').toLowerCase()) ||
    POWERED_RE.test(textBlob),
  );

  if (isPowered && !allowPoweredNon3c) {
    return {
      passed: false,
      verdict: 'skipped_powered_disabled',
      hard_exclusion: false,
      configurable_skip: true,
      reasons: ['Powered products disabled by caller Gate-0 configuration.'],
      powered_non_3c: true,
      required_cost_and_compliance_items: [],
    };
  }

  const requiredItems = [];
  if (isPowered) {
    requiredItems.push(
      'certification_compliance_check (FCC / UL / ETL / DOE as applicable)',
      'battery_and_hazmat_freight_surcharge (UN38.3 / MSDS / DG sea-freight tariff if battery-equipped)',
      'powered_product_return_and_warranty_rate_check',
    );
  }

  return {
    passed: true,
    verdict: isPowered ? 'allowed_powered_non_3c' : 'allowed',
    hard_exclusion: false,
    reasons: isPowered
      ? ['Low-risk powered non-3C item permitted under Gate-0; explicitly include certification, battery, and freight costs in Gate 1A/1B.']
      : ['Passed cross-category Gate-0 boundary.'],
    powered_non_3c: isPowered,
    required_cost_and_compliance_items: requiredItems,
  };
}

const MULTI_UNIT_COUPON_RE = /\b(?:buy|purchase|order|get)\s*(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:on|with(?:\s+purchase\s+of)?|for|any)\s+(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:or\s+more\b|(?:select|qualifying|eligible)?\s*(?:items?|units?|pcs?|packs?|sets?|bottles?|boxes?)\b)|\b(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\+|or\s+more)\s*(?:items?|units?|pcs?|packs?|sets?)?\b|\bwhen\s+(?:you\s+)?(?:buy(?:ing)?|purchas(?:e|ing)|order(?:ing)?|spend(?:ing)?\s+on)\s+(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten)\b|买\s*[2-9二两三四五六七八九十]\d*\s*(?:件|个|套|盒)?\s*(?:送|减|立减|折|享)|满\s*[2-9二两三四五六七八九十]\d*\s*件|[2-9二两三四五六七八九十]\s*件(?:及以上|起|立减|折)|第\s*[2二两]\s*件|多件/i;
const FOREIGN_CURRENCY_COUPON_RE = /(?:€|£|¥|￥|\b(?:EUR|GBP|CAD|AUD|CNY|RMB|JPY|MXN|INR|SEK|PLN|CHF|SGD|HKD)\b|(?:CA|C|A|HK|NT|SG|NZ|MX)\$)/i;

/**
 * Parse a single-unit US-dollar or percentage coupon token without mistaking foreign-currency
 * coupons (`€5`, `CA$5`, `£5`, `¥20`) or multi-unit conditional promos (`Buy 2, save $10`,
 * `Save 10% on 2 or more items`) for single-unit USD checkout discounts.
 */
export function parseSingleUnitUsdCoupon(rawCoupon) {
  if (rawCoupon === null || rawCoupon === undefined || rawCoupon === '' || rawCoupon === 0) {
    return { type: 'none', pct: null, usd: null };
  }
  if (finite(rawCoupon) && rawCoupon > 0) {
    return { type: 'usd', pct: null, usd: rawCoupon };
  }
  if (typeof rawCoupon !== 'string') {
    return { type: 'none', pct: null, usd: null };
  }
  const s = rawCoupon.trim();
  if (!s || MULTI_UNIT_COUPON_RE.test(s) || FOREIGN_CURRENCY_COUPON_RE.test(s)) {
    return { type: 'none', pct: null, usd: null };
  }
  const pctMatch = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) {
    const pct = round(Number(pctMatch[1]) / 100, 6);
    if (finite(pct) && pct > 0 && pct < 1) {
      return { type: 'pct', pct, usd: null };
    }
    return { type: 'none', pct: null, usd: null };
  }
  const explicitUsdMatch = s.match(/(?:US\$\s*|\$\s*|\bUSD\s*)(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*USD\b/i);
  if (explicitUsdMatch) {
    const val = Number(explicitUsdMatch[1] ?? explicitUsdMatch[2]);
    if (finite(val) && val > 0) return { type: 'usd', pct: null, usd: val };
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const val = Number(s);
    if (finite(val) && val > 0) return { type: 'usd', pct: null, usd: val };
  }
  return { type: 'none', pct: null, usd: null };
}

function parseCouponValue(rawCoupon, listPrice) {
  const parsed = parseSingleUnitUsdCoupon(rawCoupon);
  if (parsed.type === 'pct' && finite(listPrice) && listPrice > 0) {
    return round(listPrice * parsed.pct, 4);
  }
  if (parsed.type === 'usd') return parsed.usd;
  return 0;
}

function resolveListingNetPrice(raw) {
  const listPrice = finite(raw?.list_price_usd) && raw.list_price_usd > 0
    ? raw.list_price_usd
    : (finite(raw?.price_usd) && raw.price_usd > 0 ? raw.price_usd : (finite(raw?.price) && raw.price > 0 ? raw.price : null));

  const explicitNet = raw?.net_effective_price_usd ?? raw?.net_price_usd;
  if (finite(explicitNet) && explicitNet > 0) {
    const discFrac = listPrice > explicitNet ? round((listPrice - explicitNet) / listPrice, 6) : 0;
    return { valid: true, list_price_usd: listPrice, net_price_usd: explicitNet, discount_fraction: discFrac };
  }
  if (listPrice === null) return { valid: false, list_price_usd: null, net_price_usd: null, discount_fraction: 0 };
  if (finite(raw?.promo_price_usd) && raw.promo_price_usd > 0 && raw.promo_price_usd < listPrice) {
    const net = raw.promo_price_usd;
    return { valid: true, list_price_usd: listPrice, net_price_usd: net, discount_fraction: round((listPrice - net) / listPrice, 6) };
  }

  let discountUsd = 0;
  const hasExplicitCouponUsd = (finite(raw?.ongoing_coupon_usd) && raw.ongoing_coupon_usd > 0) ||
    (finite(raw?.coupon_usd) && raw.coupon_usd > 0);
  const hasExplicitCouponPct = (finite(raw?.ongoing_coupon_pct) && raw.ongoing_coupon_pct > 0 && raw.ongoing_coupon_pct < 1) ||
    (finite(raw?.coupon_pct) && raw.coupon_pct > 0 && raw.coupon_pct < 1);

  if (finite(raw?.ongoing_coupon_usd) && raw.ongoing_coupon_usd > 0) discountUsd += raw.ongoing_coupon_usd;
  else if (finite(raw?.coupon_usd) && raw.coupon_usd > 0) discountUsd += raw.coupon_usd;

  if (finite(raw?.ongoing_coupon_pct) && raw.ongoing_coupon_pct > 0 && raw.ongoing_coupon_pct < 1) {
    discountUsd += listPrice * raw.ongoing_coupon_pct;
  } else if (finite(raw?.coupon_pct) && raw.coupon_pct > 0 && raw.coupon_pct < 1) {
    discountUsd += listPrice * raw.coupon_pct;
  } else if (!hasExplicitCouponUsd && !hasExplicitCouponPct && raw?.coupon !== undefined) {
    discountUsd += parseCouponValue(raw.coupon, listPrice);
  }
  if (finite(raw?.prime_exclusive_discount_usd) && raw.prime_exclusive_discount_usd > 0) {
    discountUsd += raw.prime_exclusive_discount_usd;
  }
  if (finite(raw?.prime_exclusive_discount_pct) && raw.prime_exclusive_discount_pct > 0 && raw.prime_exclusive_discount_pct < 1) {
    discountUsd += listPrice * raw.prime_exclusive_discount_pct;
  }

  // Settle discounted US checkout prices in whole cents (matching fee-basis.mjs resolveEffectivePricing across $10/$50 FBA cliffs).
  const net = discountUsd > 0 ? round(listPrice - discountUsd, 2) : round(listPrice, 4);
  if (net <= 0) return { valid: false, list_price_usd: listPrice, net_price_usd: null, discount_fraction: 1 };
  return {
    valid: true,
    list_price_usd: listPrice,
    net_price_usd: net,
    discount_fraction: discountUsd > 0 ? round((listPrice - net) / listPrice, 6) : 0,
  };
}

export function resolveAgeDays(raw, asOfDate) {
  if (finite(raw?.age_days) && raw.age_days >= 0) return Math.floor(raw.age_days);
  const launch = raw?.launch_date ?? raw?.available_date ?? raw?.availableDate ?? raw?.first_available_day ?? null;
  if (isoDate(launch) && isoDate(asOfDate)) {
    const t0 = Date.parse(`${launch.slice(0, 10)}T00:00:00Z`);
    const t1 = Date.parse(`${asOfDate.slice(0, 10)}T00:00:00Z`);
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
      return Math.floor((t1 - t0) / 86400000);
    }
  }
  return null;
}

function parseRawDimensionString(dimStr) {
  if (typeof dimStr !== 'string' || !dimStr.trim()) return null;
  const nums = [...dimStr.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
  if (nums.length < 3 || nums.some(n => !finite(n) || n <= 0)) return null;
  const isCm = /\bcm\b|厘米/i.test(dimStr);
  const factor = isCm ? 1 / 2.54 : 1;
  return {
    length_in: round(nums[0] * factor, 4),
    width_in: round(nums[1] * factor, 4),
    height_in: round(nums[2] * factor, 4),
  };
}

function parseRawWeightLb(wtVal) {
  if (finite(wtVal) && wtVal > 0) return wtVal;
  if (typeof wtVal !== 'string' || !wtVal.trim()) return null;
  const m = wtVal.match(/(\d+(?:\.\d+)?)\s*(pounds?|lbs?|ounces?|oz|kg|kilograms?|g|grams?)?/i);
  if (!m) return null;
  const num = Number(m[1]);
  if (!finite(num) || num <= 0) return null;
  const unit = (m[2] || 'lb').toLowerCase();
  if (unit.startsWith('oz') || unit.startsWith('ounce')) return round(num / 16, 4);
  if (unit === 'kg' || unit.startsWith('kilogram')) return round(num / 0.45359237, 4);
  if (unit === 'g' || unit.startsWith('gram')) return round(num / 453.59237, 4);
  return num;
}

/**
 * Scan 100% of search-page listings WITHOUT `.slice(0, 16)` truncation, preserve `coupon`, `pkgDimensions`,
 * `pkgWeight`, `parent`, and `availableDate`, and split into distinct physical sub-forms BEFORE applying `$29.99` gate.
 */
export function splitSearchPageSubForms(rawItems = [], subFormDefinitions = []) {
  if (!Array.isArray(rawItems)) throw new TypeError('rawItems must be an array.');
  if (!Array.isArray(subFormDefinitions) || subFormDefinitions.length === 0) {
    throw new TypeError('subFormDefinitions must be a nonempty array.');
  }
  const normalizedItems = rawItems.map((raw, idx) => {
    const parsedDims = raw?.pkg ?? parseRawDimensionString(raw?.pkgDimensions ?? raw?.pkg_dimensions);
    const parsedWt = raw?.weight_lb ?? raw?.unit_weight_lb ?? parseRawWeightLb(raw?.pkgWeight ?? raw?.pkg_weight);
    const listPrice = finite(raw?.list_price_usd) ? raw.list_price_usd
      : (finite(raw?.price_usd) ? raw.price_usd : (finite(raw?.price) ? raw.price : null));
    let ongoingCouponPct = finite(raw?.ongoing_coupon_pct) ? raw.ongoing_coupon_pct : null;
    let ongoingCouponUsd = finite(raw?.ongoing_coupon_usd) ? raw.ongoing_coupon_usd : null;
    if (raw?.coupon !== undefined && raw?.coupon !== null) {
      const parsedCoupon = parseSingleUnitUsdCoupon(raw.coupon);
      if (parsedCoupon.type === 'pct') ongoingCouponPct = round(parsedCoupon.pct, 4);
      else if (parsedCoupon.type === 'usd') ongoingCouponUsd = parsedCoupon.usd;
    }
    return {
      ...raw,
      asin: typeof raw?.asin === 'string' && raw.asin.trim() ? raw.asin.trim().toUpperCase() : `ROW-${idx + 1}`,
      parent_asin: typeof (raw?.parent_asin ?? raw?.parent) === 'string' && (raw.parent_asin ?? raw.parent).trim()
        ? (raw.parent_asin ?? raw.parent).trim().toUpperCase()
        : null,
      available_date: raw?.available_date ?? raw?.availableDate ?? raw?.launch_date ?? null,
      list_price_usd: listPrice,
      ...(ongoingCouponPct !== null ? { ongoing_coupon_pct: ongoingCouponPct } : {}),
      ...(ongoingCouponUsd !== null ? { ongoing_coupon_usd: ongoingCouponUsd } : {}),
      ...(parsedDims ? {
        pkg: {
          ...parsedDims,
          ...(parsedWt !== null ? { unit_weight_lb: parsedWt } : {}),
        },
      } : {}),
    };
  });

  const unmatched = [];
  const buckets = new Map(subFormDefinitions.map(def => [def.sub_form_id, []]));
  for (const item of normalizedItems) {
    const matchedDef = subFormDefinitions.find(def => typeof def?.match === 'function' && def.match(item));
    if (matchedDef) buckets.get(matchedDef.sub_form_id).push(item);
    else unmatched.push(item);
  }

  const subForms = subFormDefinitions.map(def => {
    const items = buckets.get(def.sub_form_id) ?? [];
    const weights = items.map(it => it.pkg?.unit_weight_lb).filter(v => finite(v) && v > 0);
    const volumes = items
      .map(it => (it.pkg ? it.pkg.length_in * it.pkg.width_in * it.pkg.height_in : null))
      .filter(v => finite(v) && v > 0);
    const weightSpread = weights.length >= 2 ? round(Math.max(...weights) / Math.min(...weights), 2) : null;
    const volumeSpread = volumes.length >= 2 ? round(Math.max(...volumes) / Math.min(...volumes), 2) : null;
    return {
      sub_form_id: def.sub_form_id,
      label: def.label ?? def.sub_form_id,
      item_count: items.length,
      items,
      scale_divergence_warning: Boolean((weightSpread !== null && weightSpread > 2.0) || (volumeSpread !== null && volumeSpread > 2.0)),
      weight_ratio_max_min: weightSpread,
      volume_ratio_max_min: volumeSpread,
    };
  });

  return {
    scanned_total: normalizedItems.length,
    truncated: false,
    sub_forms: subForms,
    unmatched_count: unmatched.length,
    unmatched,
  };
}

function historicalPrices(raw) {
  return ['keepa_90d_median_usd', 'historical_regular_price_usd']
    .filter(source => finite(raw?.[source]) && raw[source] > 0)
    .map(source => ({ price_usd: raw[source], source }));
}

export function resolveHolidayPromoReference(raw, netPrice, {
  as_of_date = new Date().toISOString().slice(0, 10),
  spiral_max_age_days = 120,
} = {}) {
  const age = resolveAgeDays(raw, as_of_date);
  if (age === null || age < spiral_max_age_days || !finite(netPrice) || netPrice <= 0) return null;
  const net = toBigRat(netPrice);
  for (const reference of historicalPrices(raw)) {
    const regular = toBigRat(reference.price_usd);
    if (net.n * regular.d * 100n <= regular.n * net.d * 85n) {
      return reference;
    }
  }
  return null;
}

function resolveFulfillment(raw) {
  const f = String(raw?.fulfillment_channel ?? raw?.fulfillment ?? raw?.fulfillment_type ?? '').trim().toUpperCase();
  if (!f) return 'UNKNOWN';
  if (f === 'AFN' || f === 'FBA') return 'FBA';
  if (f === 'MFN' || f === 'FBM') return 'FBM';
  if (f === 'AMZ' || f === 'AMAZON' || f === '1P') return 'AMZ';
  return f;
}

function resolveSizeTier(raw) {
  if (typeof raw?.size_tier === 'string' && raw.size_tier.trim()) {
    return raw.size_tier.trim().toLowerCase().replace(/\s+/g, '_');
  }
  if (raw?.pkg && typeof raw.pkg === 'object') {
    const cls = classifyStandardSize2027(raw.pkg);
    if (cls.size_tier) return cls.size_tier;
  }
  return null;
}

function resolveMonthlyUnits(raw) {
  for (const key of ['monthly_units', 'monthlySales', 'parent_units', 'units_30d', 'units', 'sales']) {
    if (finite(raw?.[key]) && raw[key] >= 0) return raw[key];
  }
  return null;
}

/**
 * Deterministic sales-weighted quantile over rows sorted by (net_price_usd ASC, asin ASC).
 * Uses cumulative weight midpoint interpolation for smooth, permutation-invariant P25/P50/P75.
 */
export function weightedQuantile(rows, q) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.net_price_usd - b.net_price_usd || String(a.asin || '').localeCompare(String(b.asin || '')));
  if (sorted.length === 1) return sorted[0].net_price_usd;
  const weights = sorted.map(r => (finite(r.monthly_units) && r.monthly_units > 0 ? r.monthly_units : 1));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const target = q * totalWeight;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    const prevCum = cum;
    const mid = prevCum + weights[i] / 2;
    if (target <= mid) {
      if (i === 0) return sorted[0].net_price_usd;
      const prevMid = prevCum - weights[i - 1] / 2;
      const frac = (target - prevMid) / (mid - prevMid);
      return round(sorted[i - 1].net_price_usd + frac * (sorted[i].net_price_usd - sorted[i - 1].net_price_usd), 4);
    }
    cum += weights[i];
  }
  return sorted[sorted.length - 1].net_price_usd;
}

function unweightedMedian(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : round((s[mid - 1] + s[mid]) / 2, 4);
}

function computeImpliedMarginSpreadPp(p25, p75, options) {
  if (!finite(p25) || !finite(p75) || p25 <= 0 || p75 <= 0) return null;
  if (typeof options.margin_estimator === 'function') {
    const m25 = options.margin_estimator(p25);
    const m75 = options.margin_estimator(p75);
    if (finite(m25) && finite(m75)) return round((m75 - m25) * 100, 2);
  }
  if (options.gate1a_base_params && finite(options.reference_landed_domestic_usd) && options.reference_landed_domestic_usd >= 0) {
    const est25 = estimateGate1A2027({ ...options.gate1a_base_params, price_usd: p25 });
    const est75 = estimateGate1A2027({ ...options.gate1a_base_params, price_usd: p75 });
    if (est25.status === 'verified' && est75.status === 'verified') {
      const m25 = (est25.net_revenue_usd - (est25.non_domestic_cost_a_usd + options.reference_landed_domestic_usd)) / est25.net_revenue_usd;
      const m75 = (est75.net_revenue_usd - (est75.non_domestic_cost_a_usd + options.reference_landed_domestic_usd)) / est75.net_revenue_usd;
      return round((m75 - m25) * 100, 2);
    }
  }
  return null;
}

/**
 * Stage-1 mainstream price-band denoising + width guardrail (DECISIONS.md 2026-11-19):
 *  - Excludes FBM, low-sales zombies (<min_monthly_units, default 10), children's products, and optional size-tier mismatches.
 *  - Isolates young (<90-180d, default 120d) launch-spiral low-price listings and heavy-coupon outliers into spiral_watch[].
 *  - Computes sales-weighted P25-P75 mainstream price band.
 *  - Triggers width alarm when P75/P25 > max_width_ratio (1.35) or implied margin spread > max_margin_spread_pp (12pp).
 */
export function analyzeMainstreamPriceBand(listings, options = {}) {
  if (!Array.isArray(listings)) throw new TypeError('listings must be an array.');
  const {
    observation_date = null,
    as_of_date = observation_date ?? new Date().toISOString().slice(0, 10),
    min_monthly_units = 10,
    spiral_max_age_days = 120,
    spiral_discount_vs_median = 0.20,
    heavy_coupon_threshold = 0.15,
    mature_heavy_coupon_threshold = 0.20,
    isolate_heavy_coupon_outliers = true,
    include_amz_1p = true,
    target_size_tier = null,
    target_pkg = null,
    max_width_ratio = 1.35,
    max_margin_spread_pp = 12,
    minimum_price_floor_usd = 29.99,
    strict_mature_only = false,
    gate0_config = {},
  } = options;

  let resolvedTargetTier = typeof target_size_tier === 'string' && target_size_tier.trim()
    ? target_size_tier.trim().toLowerCase().replace(/\s+/g, '_')
    : null;
  if (!resolvedTargetTier && target_pkg && typeof target_pkg === 'object') {
    const cls = classifyStandardSize2027(target_pkg);
    if (cls.size_tier) resolvedTargetTier = cls.size_tier;
  }

  // Deterministic permutation-invariant deduplication by ASIN:
  // prefer latest observed_at DESC -> highest monthly_units DESC -> lowest net_price_usd ASC -> canonical JSON ASC.
  const byAsin = new Map();
  const duplicateAsins = [];
  for (let i = 0; i < listings.length; i++) {
    const raw = listings[i];
    const asin = typeof raw?.asin === 'string' && raw.asin.trim() ? raw.asin.trim().toUpperCase() : `ROW-${i + 1}`;
    const entry = {
      raw,
      asin,
      obs: isoDate(raw?.observed_at) ? raw.observed_at.slice(0, 10) : '',
      units: resolveMonthlyUnits(raw) ?? -1,
      price: resolveListingNetPrice(raw).net_price_usd ?? Infinity,
      sig: JSON.stringify(raw ?? {}),
    };
    const prev = byAsin.get(asin);
    if (!prev) {
      byAsin.set(asin, entry);
    } else {
      duplicateAsins.push(asin);
      const cmp = (entry.obs > prev.obs ? -1 : entry.obs < prev.obs ? 1 : 0) ||
        (entry.units > prev.units ? -1 : entry.units < prev.units ? 1 : 0) ||
        (entry.price < prev.price ? -1 : entry.price > prev.price ? 1 : 0) ||
        (entry.sig < prev.sig ? -1 : entry.sig > prev.sig ? 1 : 0);
      if (cmp < 0) byAsin.set(asin, entry);
    }
  }
  const deduped = [...byAsin.values()]
    .sort((a, b) => a.asin.localeCompare(b.asin))
    .map(({ raw, asin }) => ({ raw, asin }));

  const excluded = [];
  const candidates = [];
  const historicalPeers = [];
  const amazon1pOffers = [];

  for (const { raw, asin } of deduped) {
    const priceRes = resolveListingNetPrice(raw);
    if (!priceRes.valid) {
      excluded.push({ asin, reason_code: 'invalid_price', reason: 'Missing or non-positive price.' });
      continue;
    }
    const fulfillment = resolveFulfillment(raw);
    if (fulfillment === 'AMZ') {
      amazon1pOffers.push({ asin, price_usd: priceRes.net_price_usd, title: raw?.title ?? null });
    }
    if (fulfillment === 'FBM' || (fulfillment !== 'FBA' && !(include_amz_1p && fulfillment === 'AMZ'))) {
      excluded.push({
        asin,
        price_usd: priceRes.net_price_usd,
        fulfillment,
        reason_code: fulfillment === 'FBM' ? 'excluded_fbm' : 'excluded_non_fba',
        reason: `Excluded non-FBA fulfillment (${fulfillment}).`,
      });
      continue;
    }

    const monthlyUnits = resolveMonthlyUnits(raw);
    if (monthlyUnits !== null && monthlyUnits < min_monthly_units) {
      excluded.push({
        asin,
        price_usd: priceRes.net_price_usd,
        monthly_units: monthlyUnits,
        reason_code: 'excluded_low_sales_zombie',
        reason: `Monthly sales (${monthlyUnits}) below denoising floor (${min_monthly_units}/mo).`,
      });
      continue;
    }

    const gate0 = evaluateGate0CategoryBoundary(raw, {
      ...gate0_config,
      avoid_red_ocean: gate0_config.avoid_red_ocean ?? { apparel: false, consumer_electronics_3c: false, red_ocean_furniture: false, fda_ingestible_topical: false },
    });
    if (!gate0.passed && gate0.verdict === 'excluded_childrens_product') {
      excluded.push({
        asin,
        price_usd: priceRes.net_price_usd,
        reason_code: 'excluded_childrens_product',
        reason: gate0.reasons[0],
      });
      continue;
    }

    const sizeTier = resolveSizeTier(raw);
    if (resolvedTargetTier && sizeTier && sizeTier !== resolvedTargetTier) {
      excluded.push({
        asin,
        price_usd: priceRes.net_price_usd,
        size_tier: sizeTier,
        target_size_tier: resolvedTargetTier,
        reason_code: 'excluded_size_tier_mismatch',
        reason: `FBA size tier (${sizeTier}) differs from target (${resolvedTargetTier}).`,
      });
      continue;
    }

    const regularReference = resolveHolidayPromoReference(raw, priceRes.net_price_usd, { as_of_date, spiral_max_age_days });
    const ageDays = resolveAgeDays(raw, as_of_date);
    const seedMergedUnverified = Boolean(
      (raw?.old_reviews_predate_launch === true || raw?.seed_merged_reviews === true) &&
      raw?.current_form_sustained_regular_price_verified !== true,
    );
    if (ageDays !== null && ageDays >= spiral_max_age_days && !seedMergedUnverified) {
      // Each eligible mature peer contributes one historical/regular price, including peers discounted today.
      const reference = regularReference ?? historicalPrices(raw)[0];
      if (reference) historicalPeers.push({ asin, net_price_usd: reference.price_usd, monthly_units: monthlyUnits, source: reference.source });
    }
    candidates.push({
      asin,
      title: raw?.title ?? null,
      brand: raw?.brand ?? null,
      fulfillment,
      is_amazon_1p: fulfillment === 'AMZ',
      list_price_usd: priceRes.list_price_usd,
      net_price_usd: priceRes.net_price_usd,
      discount_fraction: priceRes.discount_fraction,
      ...(regularReference ? { regular_price_reference: regularReference } : {}),
      ...(seedMergedUnverified ? { seed_merged_unverified_price: true } : {}),
      monthly_units: monthlyUnits,
      age_days: ageDays,
      size_tier: sizeTier,
      rating: finite(raw?.rating) ? raw.rating : null,
      reviews: finite(raw?.reviews) ? raw.reviews : (finite(raw?.ratings) ? raw.ratings : null),
      image_url: raw?.image_url ?? null,
    });
  }

  // Keep temporary mature promotions out of the comparison baseline used to detect launch spirals.
  const maturePeers = candidates.filter(c =>
    !c.seed_merged_unverified_price &&
    (strict_mature_only ? (c.age_days !== null && c.age_days >= spiral_max_age_days) : (c.age_days === null || c.age_days >= spiral_max_age_days)),
  );
  const referencePeers = (maturePeers.length > 0 ? maturePeers : candidates)
    .filter(c => !c.regular_price_reference && !c.seed_merged_unverified_price);
  const referenceMedian = unweightedMedian(
    referencePeers.map(c => c.net_price_usd),
  );

  const spiralWatch = [];
  let mainstreamPool = [];
  const allYoungNiche = candidates.length > 0 && maturePeers.length === 0;

  for (const item of candidates) {
    const watchReasons = [];
    if (item.regular_price_reference) watchReasons.push('holiday_or_event_promo_outlier');
    if (item.seed_merged_unverified_price) watchReasons.push('seed_merged_unverified_regular_price');
    const isYoung = item.age_days !== null && item.age_days < spiral_max_age_days;
    if (strict_mature_only && (isYoung || item.age_days === null)) {
      watchReasons.push(isYoung ? 'young_newcomer_launch_band_only' : 'unknown_age_excluded_from_mature_band');
    }
    const isBelowMedianSpiral = referenceMedian !== null &&
      item.net_price_usd < referenceMedian * (1 - spiral_discount_vs_median);
    if (isYoung && isBelowMedianSpiral && !allYoungNiche) {
      watchReasons.push('launch_spiral_low_price');
    }
    if (isYoung && item.discount_fraction >= heavy_coupon_threshold) {
      watchReasons.push('young_heavy_coupon_outlier');
    } else if (!isYoung && isolate_heavy_coupon_outliers && item.discount_fraction >= mature_heavy_coupon_threshold) {
      watchReasons.push('heavy_coupon_outlier');
    }

    if (watchReasons.length > 0) {
      spiralWatch.push({ ...item, watch_reasons: watchReasons });
    } else {
      mainstreamPool.push(item);
    }
  }

  // Keep spiral_watch outliers strictly outside the authoritative mainstream price band.
  const spiralFallbackUsed = false;

  // Dual price bands:
  // 1) Mature Regular Price Band (>=120d peers, using Keepa/regular non-promo price when mature peer is currently on promo)
  const matureRegularRows = candidates
    .filter(c => c.age_days !== null && c.age_days >= spiral_max_age_days && !c.seed_merged_unverified_price)
    .map(c => ({
      asin: c.asin,
      net_price_usd: c.regular_price_reference ? c.regular_price_reference.price_usd : c.net_price_usd,
      monthly_units: c.monthly_units,
    }));
  const matureRegularBand = matureRegularRows.length > 0 ? {
    basis: 'mature_peers_ge_120d_regular_net',
    peer_count: matureRegularRows.length,
    p25_usd: weightedQuantile(matureRegularRows, 0.25),
    p50_usd: weightedQuantile(matureRegularRows, 0.50),
    p75_usd: weightedQuantile(matureRegularRows, 0.75),
    min_usd: Math.min(...matureRegularRows.map(r => r.net_price_usd)),
    max_usd: Math.max(...matureRegularRows.map(r => r.net_price_usd)),
  } : null;

  // 2) Newcomer Launch Price Band (<120d true non-seed-merged newcomers; advisory launch reference only, never eliminates)
  const newcomerLaunchRows = candidates
    .filter(c => c.age_days !== null && c.age_days < spiral_max_age_days && !c.seed_merged_unverified_price);
  const newcomerLaunchBand = {
    basis: 'true_newcomers_lt_120d_advisory_only',
    advisory_only: true,
    never_triggers_elimination: true,
    peer_count: newcomerLaunchRows.length,
    p25_usd: weightedQuantile(newcomerLaunchRows, 0.25),
    p50_usd: weightedQuantile(newcomerLaunchRows, 0.50),
    p75_usd: weightedQuantile(newcomerLaunchRows, 0.75),
    min_usd: newcomerLaunchRows.length ? Math.min(...newcomerLaunchRows.map(r => r.net_price_usd)) : null,
    max_usd: newcomerLaunchRows.length ? Math.max(...newcomerLaunchRows.map(r => r.net_price_usd)) : null,
  };

  const prices = mainstreamPool.map(r => r.net_price_usd);
  const p25 = weightedQuantile(mainstreamPool, 0.25);
  const p50 = weightedQuantile(mainstreamPool, 0.50);
  const p75 = weightedQuantile(mainstreamPool, 0.75);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const widthRatio = p25 !== null && p25 > 0 && p75 !== null ? round(p75 / p25, 4) : null;
  const impliedMarginSpreadPp = computeImpliedMarginSpreadPp(p25, p75, options);

  const alarmReasons = [];
  if (widthRatio !== null && widthRatio > max_width_ratio) {
    alarmReasons.push(`P75/P25 ratio (${widthRatio}x) exceeds ${max_width_ratio}x guardrail; pool likely mixes disparate sub-forms.`);
  }
  if (impliedMarginSpreadPp !== null && impliedMarginSpreadPp > max_margin_spread_pp) {
    alarmReasons.push(`Implied margin spread (${impliedMarginSpreadPp}pp) exceeds ${max_margin_spread_pp}pp guardrail.`);
  }
  if (mainstreamPool.length < 2) {
    alarmReasons.push(`Mainstream pool has only ${mainstreamPool.length} peer(s); insufficient distribution breadth.`);
  }

  const widthAlarm = (widthRatio !== null && widthRatio > max_width_ratio) ||
    (impliedMarginSpreadPp !== null && impliedMarginSpreadPp > max_margin_spread_pp);
  const band = {
    p25_usd: p25,
    p50_usd: p50,
    p75_usd: p75,
    min_usd: minPrice,
    max_usd: maxPrice,
    width_ratio: widthRatio,
    implied_margin_spread_pp: impliedMarginSpreadPp,
    below_floor_warning: p75 !== null && p75 < minimum_price_floor_usd,
  };

  return {
    input_count: deduped.length,
    excluded_count: excluded.length,
    spiral_watch_count: spiralWatch.length,
    mainstream_count: mainstreamPool.length,
    all_young_niche: allYoungNiche,
    strict_mature_only: Boolean(strict_mature_only),
    spiral_fallback_used: spiralFallbackUsed,
    amazon_1p_offers: amazon1pOffers,
    band,
    mature_regular_band: matureRegularBand,
    newcomer_launch_band: newcomerLaunchBand,
    regular_band_reference: historicalPeers.length ? {
      basis: 'observed_historical_regular_prices',
      peer_count: historicalPeers.length,
      p25_usd: weightedQuantile(historicalPeers, 0.25),
      p50_usd: weightedQuantile(historicalPeers, 0.50),
      p75_usd: weightedQuantile(historicalPeers, 0.75),
      min_usd: Math.min(...historicalPeers.map(p => p.net_price_usd)),
      max_usd: Math.max(...historicalPeers.map(p => p.net_price_usd)),
      sources: Object.fromEntries(['keepa_90d_median_usd', 'historical_regular_price_usd']
        .map(source => [source, historicalPeers.filter(p => p.source === source).length])),
    } : (matureRegularBand ?? { ...band, basis: 'current_mainstream_prices', peer_count: mainstreamPool.length }),
    guardrail: {
      max_width_ratio,
      max_margin_spread_pp,
      width_alarm: widthAlarm,
      requires_visual_clustering: widthAlarm,
      low_peer_count: mainstreamPool.length < 2,
      reasons: alarmReasons,
    },
    mainstream_pool: mainstreamPool,
    spiral_watch: spiralWatch,
    excluded,
  };
}

/**
 * Stage-2 visual cluster band tightening:
 * Re-computes sales-weighted P25-P75 and width guardrail per visually homogeneous cluster,
 * comparing raw pool width vs tightened per-cluster width.
 */
export function tightenClusterBands(analysisOrListings, clusters, options = {}) {
  if (!Array.isArray(clusters) || clusters.length === 0) {
    throw new TypeError('clusters must be a nonempty array of { cluster_id, label, asins[] }.');
  }
  const baseAnalysis = Array.isArray(analysisOrListings)
    ? analyzeMainstreamPriceBand(analysisOrListings, options)
    : analysisOrListings;
  if (!baseAnalysis || typeof baseAnalysis !== 'object' || !Array.isArray(baseAnalysis.mainstream_pool)) {
    throw new TypeError('analysisOrListings must be a listings array or output from analyzeMainstreamPriceBand().');
  }

  // Keep spiral_watch rows strictly outside authoritative cluster price bands; report them separately!
  const mainstreamByAsin = new Map();
  for (const row of baseAnalysis.mainstream_pool) {
    mainstreamByAsin.set(String(row.asin).toUpperCase(), row);
  }
  const spiralByAsin = new Map();
  for (const row of (baseAnalysis.spiral_watch ?? [])) {
    spiralByAsin.set(String(row.asin).toUpperCase(), row);
  }

  const clusterResults = clusters.map((cluster, idx) => {
    const clusterId = typeof cluster?.cluster_id === 'string' && cluster.cluster_id.trim()
      ? cluster.cluster_id.trim()
      : `C${idx + 1}`;
    const label = typeof cluster?.label === 'string' && cluster.label.trim() ? cluster.label.trim() : clusterId;
    const asins = Array.isArray(cluster?.asins)
      ? [...new Set(cluster.asins.map(a => String(a).trim().toUpperCase()).filter(Boolean))]
      : [];
    const matchedRows = asins.map(a => mainstreamByAsin.get(a)).filter(Boolean);
    const spiralAsins = asins.filter(a => !mainstreamByAsin.has(a) && spiralByAsin.has(a));
    const missingAsins = asins.filter(a => !mainstreamByAsin.has(a) && !spiralByAsin.has(a));

    const p25 = weightedQuantile(matchedRows, 0.25);
    const p50 = weightedQuantile(matchedRows, 0.50);
    const p75 = weightedQuantile(matchedRows, 0.75);
    const widthRatio = p25 !== null && p25 > 0 && p75 !== null ? round(p75 / p25, 4) : null;
    const marginSpreadPp = computeImpliedMarginSpreadPp(p25, p75, options);
    const maxWidthRatio = options.max_width_ratio ?? baseAnalysis.guardrail?.max_width_ratio ?? 1.35;
    const maxSpreadPp = options.max_margin_spread_pp ?? baseAnalysis.guardrail?.max_margin_spread_pp ?? 12;
    const tightenedOk = matchedRows.length >= 2 &&
      missingAsins.length === 0 &&
      (widthRatio !== null && widthRatio <= maxWidthRatio) &&
      (marginSpreadPp === null || marginSpreadPp <= maxSpreadPp);

    return {
      cluster_id: clusterId,
      label,
      member_count: matchedRows.length,
      asins: matchedRows.map(r => r.asin),
      spiral_watch_asins: spiralAsins,
      missing_asins: missingAsins,
      incomplete_membership: missingAsins.length > 0 || matchedRows.length < 2,
      band: {
        p25_usd: p25,
        p50_usd: p50,
        p75_usd: p75,
        min_usd: matchedRows.length ? Math.min(...matchedRows.map(r => r.net_price_usd)) : null,
        max_usd: matchedRows.length ? Math.max(...matchedRows.map(r => r.net_price_usd)) : null,
        width_ratio: widthRatio,
        implied_margin_spread_pp: marginSpreadPp,
      },
      tightened_pass: tightenedOk,
      width_reduction_vs_raw: baseAnalysis.band?.width_ratio !== null && widthRatio !== null
        ? round(baseAnalysis.band.width_ratio - widthRatio, 4)
        : null,
      margin_spread_reduction_pp: baseAnalysis.band?.implied_margin_spread_pp !== null && marginSpreadPp !== null
        ? round(baseAnalysis.band.implied_margin_spread_pp - marginSpreadPp, 2)
        : null,
    };
  });

  return {
    raw_band: baseAnalysis.band,
    raw_guardrail: baseAnalysis.guardrail,
    clusters: clusterResults,
    all_clusters_tightened: clusterResults.every(c => c.tightened_pass),
  };
}
