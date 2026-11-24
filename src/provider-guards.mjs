/**
 * Pure connector parameter-alignment guards for SellerSprite (28 tools) x SIF (37 tools)
 * per 04-refactoring-plan-v2.1-revised.md section 4 (lines 174-200).
 * Zero I/O, zero network calls; throws descriptive TypeErrors or returns structured violation lists.
 */

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;
const ASIN_RE = /^[A-Z0-9]{10}$/i;
const COLON_CATEGORY_PATH_RE = /^\d+(?::\d+)+$/;
const SINGLE_NODE_ID_RE = /^\d+$/;

const SS_DEEP_CATEGORY_TOOLS = new Set([
  'category_stats_list',
  'category_report_detail',
  'category_top_list',
  'category_trend',
  'category_demand_report',
  'category_demand_trend',
  'category_ai_feature_list',
]);

const SIF_LATELY_DAY_30_TOOLS = new Set([
  'ops_get_listing_traffic_overview',
  'ops_get_listing_traffic_structure',
  'ops_get_listing_keyword_distribution',
]);

export function canonicalizeConnectorToolName(toolName) {
  if (!nonemptyStr(toolName)) throw new TypeError('toolName must be a nonempty string.');
  let bare = toolName.trim();
  bare = bare.replace(/^mcp__codex_apps__[a-z0-9]+_mcp_/i, '');
  bare = bare.replace(/^mcp__codex_apps__(?:sellersprite|sif|exa|sp_api|sp-api|amz_spapi|amazon_sp_api)_/i, '');
  bare = bare.replace(/^mcp__codex_apps__/i, '');
  bare = bare.replace(/^mcp__[a-z0-9_-]+__/i, '');
  bare = bare.replace(/^(?:sellersprite|sif|exa|sp_api|sp-api|amz_spapi|amazon_sp_api)[:.]/i, '');
  bare = bare.replace(/^(?:amz_spapi|amazon_sp_api)_/i, '');
  bare = bare.replace(/_[0-9-a-f]{8}$/i, '');
  return bare.trim().toLowerCase();
}

function unwrapParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  return params.request && typeof params.request === 'object' && !Array.isArray(params.request)
    ? params.request
    : params;
}

/**
 * Validate SellerSprite MCP / Codex connector parameters before dispatch:
 *  - Bans root-category bsr: 1..100 filter on leaf-node asin_list calls.
 *  - Enforces full colon-delimited categoryId path on deep category tools (and bsr_prediction_sales single root ID).
 *  - Enforces filterSub: "Y" and plural nodeIdPaths[] (banning singular nodeIdPath) on product_research.
 *  - Flags asin_review_list for mandatory skus[] variant ownership verification.
 */
export function validateSellerSpriteCall(toolName, rawParams = {}, options = {}) {
  const canonical = canonicalizeConnectorToolName(toolName);
  const p = unwrapParams(rawParams);
  const issues = [];
  const notices = [];
  const add = (code, message) => issues.push({ code, message });

  if (canonical === 'asin_list') {
    const catId = p.categoryId;
    const isDeepLeaf = typeof catId === 'string' && catId.includes(':');
    const isExactLeaf = p.categoryIdExact === true;
    const hasBsrFilter = Boolean(
      (p.bsr && typeof p.bsr === 'object' && (finite(p.bsr.min) || finite(p.bsr.max))) ||
      finite(p.minBsr) || finite(p.maxBsr) || finite(p.bsrMin) || finite(p.bsrMax),
    );
    if ((isDeepLeaf || isExactLeaf) && hasBsrFilter) {
      add(
        'leaf_asin_list_bsr_forbidden',
        'SellerSprite asin_list.bsr filters root-category BSR, NOT leaf sub-BSR; never pass bsr: 1..100 on a leaf category query.',
      );
    }
    if (isExactLeaf && typeof catId === 'string' && !COLON_CATEGORY_PATH_RE.test(catId.trim())) {
      add(
        'missing_full_colon_category_path',
        `SellerSprite asin_list with categoryIdExact: true requires full colon-delimited categoryId path (got "${catId}").`,
      );
    }
    if (typeof catId === 'string' && catId.trim() && !COLON_CATEGORY_PATH_RE.test(catId.trim()) && options.allow_root_category !== true) {
      if (SINGLE_NODE_ID_RE.test(catId.trim()) && catId.trim().length >= 9) {
        add(
          'short_leaf_category_id_forbidden',
          `categoryId "${catId}" appears to be a bare leaf node ID; resolve the full colon-delimited path via category_search first (or pass allow_root_category: true for top-level roots).`,
        );
      }
    }
  }

  if (SS_DEEP_CATEGORY_TOOLS.has(canonical)) {
    const catId = p.categoryId;
    if (!nonemptyStr(catId)) {
      add('missing_category_id', `${canonical} requires a full colon-delimited categoryId path.`);
    } else if (!COLON_CATEGORY_PATH_RE.test(catId.trim()) && options.allow_root_category !== true) {
      add(
        'missing_full_colon_category_path',
        `${canonical} requires a full colon-delimited categoryId path resolved via category_search (got "${catId}").`,
      );
    }
  }

  if (canonical === 'category_search' && p.categoryId !== undefined && p.categoryId !== null) {
    if (!nonemptyStr(p.categoryId) || (!COLON_CATEGORY_PATH_RE.test(String(p.categoryId).trim()) && options.allow_root_category !== true)) {
      add(
        'missing_full_colon_category_path',
        `category_search drill-down categoryId must be a full colon-delimited path (got "${p.categoryId}").`,
      );
    }
  }

  if (canonical === 'bsr_prediction_sales') {
    const rootId = p.categoryId ?? p.rootCategoryId;
    if (typeof rootId === 'string' && rootId.includes(':')) {
      add('bsr_prediction_requires_root_id', 'bsr_prediction_sales takes a single-segment root category ID, not a colon path.');
    }
  }

  if (canonical === 'product_research') {
    if (Object.hasOwn(p, 'nodeIdPath')) {
      add('singular_node_id_path_forbidden', 'product_research requires plural nodeIdPaths[] array; singular nodeIdPath is silently ignored.');
    }
    if (!Array.isArray(p.nodeIdPaths) || p.nodeIdPaths.length === 0 || !p.nodeIdPaths.every(v => typeof v === 'string' && COLON_CATEGORY_PATH_RE.test(v.trim()))) {
      add('invalid_node_id_paths', 'product_research requires nonempty plural nodeIdPaths[] of full colon-delimited paths.');
    }
    if (p.filterSub !== 'Y') {
      add('missing_filter_sub_y', 'product_research requires filterSub: "Y" to match exact leaf sub-category BSR.');
    }
  }

  if (canonical === 'asin_review_list') {
    if (!nonemptyStr(p.asin) || !ASIN_RE.test(p.asin.trim())) {
      add('invalid_asin', 'asin_review_list requires a valid 10-character ASIN.');
    }
    notices.push(
      'asin_review_list normalizes to parent ASIN on server; verify every returned review via verifyReviewVariantOwnership() using skus[] before attributing pain points (Group 6) or old-review conflicts (Q31).',
    );
  }

  const result = {
    valid: issues.length === 0,
    provider: 'sellersprite',
    canonical_tool: canonical,
    requires_sku_verification: canonical === 'asin_review_list',
    issues,
    notices,
  };
  if (options.throwOnError && !result.valid) {
    throw new TypeError(`SellerSprite guard violation (${canonical}): ${issues.map(i => i.message).join(' ')}`);
  }
  return result;
}

/**
 * Compute SIF market_assess_keyword_promotion own_margin = G / P (contribution / retail price),
 * NEVER refund-adjusted margin G / R.
 */
export function computeSifOwnMargin(contributionUsd, priceUsd) {
  if (!finite(contributionUsd) || !finite(priceUsd) || priceUsd <= 0) {
    throw new TypeError('computeSifOwnMargin requires finite contributionUsd and positive priceUsd.');
  }
  return Math.round(((contributionUsd / priceUsd) + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Validate SIF MCP tool parameters before dispatch:
 *  - Enforces timePieceType: "latelyDay" and timePieceValue: "30" on listing traffic/keyword tools (blocking default 7-day drift).
 *  - Enforces explicit boolean isListingSearch on ops_get_listing_traffic_overview.
 *  - Enforces listingSearch (not isListingSearch), granularity: "day", lastDays: 30 on ops_get_asin_traffic_trend.
 *  - Enforces own_margin = G / P (never G / R) on market_assess_keyword_promotion.
 */
export function validateSifCall(toolName, rawParams = {}, options = {}) {
  const canonical = canonicalizeConnectorToolName(toolName);
  const p = unwrapParams(rawParams);
  const issues = [];
  const add = (code, message) => issues.push({ code, message });

  if (SIF_LATELY_DAY_30_TOOLS.has(canonical)) {
    if (typeof p.timePieceType !== 'string' || p.timePieceType.trim() !== 'latelyDay' ||
      typeof p.timePieceValue !== 'string' || p.timePieceValue.trim() !== '30') {
      add(
        'sif_window_must_be_30_days',
        `${canonical} defaults to 7 days on server; explicit string timePieceType: "latelyDay" and string timePieceValue: "30" are required to align with SellerSprite LAST_30_DAYS.`,
      );
    }
    if (p.country !== undefined && (!nonemptyStr(p.country) || p.country.trim().length > 6)) {
      add('sif_invalid_country', `${canonical} requires a valid string country code (e.g. "US").`);
    }
    if (p.asin !== undefined && (!nonemptyStr(p.asin) || !ASIN_RE.test(p.asin.trim()))) {
      add('sif_invalid_asin', `${canonical} requires a valid 10-character ASIN.`);
    }
    if (canonical === 'ops_get_listing_traffic_overview' && typeof p.isListingSearch !== 'boolean') {
      add(
        'sif_missing_is_listing_search',
        'ops_get_listing_traffic_overview requires explicit boolean isListingSearch (true = parent view, false = single child ASIN).',
      );
    }
  }

  if (canonical === 'ops_get_asin_traffic_trend') {
    if (Object.hasOwn(p, 'isListingSearch')) {
      add(
        'sif_trend_wrong_listing_param',
        'ops_get_asin_traffic_trend uses parameter name "listingSearch", NOT "isListingSearch".',
      );
    }
    if (typeof p.listingSearch !== 'boolean') {
      add('sif_trend_missing_listing_search', 'ops_get_asin_traffic_trend requires explicit boolean listingSearch.');
    }
    if (!Number.isInteger(p.lastDays) || p.lastDays !== 30) {
      add('sif_trend_must_be_30_days', `ops_get_asin_traffic_trend requires integer lastDays: 30 (got ${JSON.stringify(p.lastDays)}).`);
    }
    if (p.granularity !== undefined && p.granularity !== 'day') {
      add('sif_trend_granularity', `ops_get_asin_traffic_trend expects granularity: "day" (got "${p.granularity}").`);
    }
  }

  if (canonical === 'market_assess_keyword_promotion') {
    const ownPrice = p.own_price ?? p.ownPrice;
    const ownMargin = p.own_margin ?? p.ownMargin;
    if (!finite(ownPrice) || ownPrice <= 0) {
      add('sif_missing_own_price', 'market_assess_keyword_promotion requires positive own_price.');
    } else if (finite(options.price_usd) && Math.abs(ownPrice - options.price_usd) > 0.01) {
      add('sif_own_price_mismatch', `market_assess_keyword_promotion own_price (${ownPrice}) conflicts with accepted payable retail price (${options.price_usd}).`);
    }
    if (!finite(ownMargin) || ownMargin <= 0 || ownMargin >= 1) {
      add('sif_invalid_own_margin', 'market_assess_keyword_promotion requires own_margin in (0, 1).');
    } else if (finite(options.contribution_usd) && finite(options.price_usd) && options.price_usd > 0) {
      const expectedGP = options.contribution_usd / options.price_usd;
      const wrongGR = finite(options.refund_adjusted_margin)
        ? options.refund_adjusted_margin
        : (finite(options.refund_fraction) && options.refund_fraction > 0
          ? options.contribution_usd / (options.price_usd * (1 - options.refund_fraction))
          : null);
      if (wrongGR !== null && Math.abs(ownMargin - wrongGR) < 1e-3 && Math.abs(ownMargin - expectedGP) > 1e-3) {
        add(
          'sif_own_margin_must_be_G_over_P',
          `market_assess_keyword_promotion received refund-adjusted margin G/R (${ownMargin}) instead of price-based G/P (${expectedGP.toFixed(6)}); SIF multiplies own_price * own_margin to reconstruct unit contribution.`,
        );
      } else if (Math.abs(ownMargin - expectedGP) > 1e-3) {
        add(
          'sif_own_margin_mismatch',
          `Supplied own_margin (${ownMargin}) disagrees with contribution_usd / price_usd = G/P (${expectedGP.toFixed(6)}).`,
        );
      }
    }
  }

  const result = {
    valid: issues.length === 0,
    provider: 'sif',
    canonical_tool: canonical,
    issues,
  };
  if (options.throwOnError && !result.valid) {
    throw new TypeError(`SIF guard violation (${canonical}): ${issues.map(i => i.message).join(' ')}`);
  }
  return result;
}

const SP_API_READ_ONLY_TOOLS = new Set([
  'catalogitems_getcatalogitem',
  'catalogitems_searchcatalogitems',
  'getcatalogitem',
  'searchcatalogitems',
  'productfees_getmyfeesestimateforasin',
  'productfees_getmyfeesestimateforsku',
  'productfees_getmyfeesestimates',
  'getmyfeesestimateforasin',
  'getmyfeesestimateforsku',
  'getmyfeesestimates',
  'listingsrestrictions_getlistingsrestrictions',
  'getlistingsrestrictions',
  'definitionsproducttypes_getdefinitionsproducttype',
  'definitionsproducttypes_searchdefinitionsproducttypes',
  'getdefinitionsproducttype',
  'searchdefinitionsproducttypes',
  'productpricing_getcompetitivepricing',
  'productpricing_getitemoffers',
  'productpricing_getitemoffersbatch',
  'sp_api_explore_catalog',
  'sp_api_reference',
  'sp_api_generate_code_sample',
  'sp_api_migration_assistant',
  'sp_api_optimize',
  'zp_director_ok',
]);

const SP_API_WRITE_PATTERN_RE = /(?:putlistingsitem|patchlistingsitem|deletelistingsitem|createfeed|submitfeed|cancelFeed|createinbound|updateinventory|confirmshipment|submitinvoice|createreturn|updateoffer|createcampaign|updatecampaign|updatebid)/i;

/**
 * Validate SP-API MCP calls for finalist dimension/fee/restriction calibration:
 *  - Permits read-only catalog, fee-estimate, restriction, and schema-definition lookups.
 *  - Permits `putListingsItem` ONLY when `mode === "VALIDATION_PREVIEW"` AND `options.allow_validation_preview === true`.
 *  - Strictly blocks all live store/listing/price/inventory/feed write operations unless explicit per-item owner approval is supplied outside selection automation.
 */
export function validateSpApiCall(toolName, rawParams = {}, options = {}) {
  const canonical = canonicalizeConnectorToolName(toolName);
  const p = unwrapParams(rawParams);
  const issues = [];
  const notices = [];
  const add = (code, message) => issues.push({ code, message });

  const method = String(p.method ?? p.httpMethod ?? '').trim().toUpperCase();
  const pathStr = String(p.path ?? p.endpoint ?? p.url ?? '').trim();
  const opStr = String(p.operation ?? p.operationId ?? canonical).trim();
  const queryMode = String(p.mode ?? p.query?.mode ?? p.queryParams?.mode ?? '').trim().toUpperCase();

  const isFeeEstimatePost =
    method === 'POST' &&
    /\/products\/fees\/v0\/(?:items\/[^/]+\/feesEstimate|feesEstimate)/i.test(pathStr);
  const isOffersBatchPost =
    method === 'POST' &&
    /\/batches\/products\/pricing\/v0\/(?:itemOffers|listingOffers)/i.test(pathStr);
  const isValidationPreviewPut =
    (/putlistingsitem/i.test(opStr) || (method === 'PUT' && /\/listings\/\d{4}-\d{2}-\d{2}\/items\//i.test(pathStr))) &&
    queryMode === 'VALIDATION_PREVIEW' &&
    options.allow_validation_preview === true;

  if (canonical === 'sp_api_execute') {
    if (!method && !pathStr && !p.operation) {
      add('sp_api_missing_operation', 'sp_api_execute requires an explicit method/path or operation.');
    } else if (method && !['GET', 'POST', 'PUT'].includes(method)) {
      add(
        'sp_api_store_write_forbidden',
        `SP-API HTTP method "${method}" (${pathStr || opStr}) is blocked: all store write operations are strictly prohibited without explicit per-item owner approval.`,
      );
    } else if (method === 'POST' && !isFeeEstimatePost && !isOffersBatchPost) {
      add(
        'sp_api_store_write_forbidden',
        `SP-API POST "${pathStr || opStr}" is blocked: only read-only fee-estimate / pricing-batch POST endpoints are allowed in product selection.`,
      );
    } else if (method === 'PUT' && !isValidationPreviewPut) {
      add(
        'sp_api_store_write_forbidden',
        `SP-API PUT "${pathStr || opStr}" is blocked: live listing writes are strictly prohibited without explicit per-item owner approval.`,
      );
    } else if (!method && SP_API_WRITE_PATTERN_RE.test(`${opStr} ${pathStr}`) && !isValidationPreviewPut) {
      add(
        'sp_api_store_write_forbidden',
        `SP-API write operation "${opStr || pathStr}" is strictly prohibited in product selection.`,
      );
    }
  } else if (!SP_API_READ_ONLY_TOOLS.has(canonical)) {
    if (isValidationPreviewPut) {
      notices.push('VALIDATION_PREVIEW dry-run permitted without mutating store listings.');
    } else if (SP_API_WRITE_PATTERN_RE.test(canonical) || /^(?:post|put|patch|delete)_/i.test(canonical)) {
      add(
        'sp_api_store_write_forbidden',
        `SP-API write tool "${canonical}" is strictly prohibited: all store writes require explicit per-item owner approval.`,
      );
    } else {
      add(
        'sp_api_unlisted_tool_requires_review',
        `Unlisted SP-API tool "${canonical}"; product-selection automation permits only read-only catalogItems, productFees, listingsRestrictions, and productType definition lookups.`,
      );
    }
  }

  if ((/listingsrestrictions/i.test(canonical) || /\/listings\/\d{4}-\d{2}-\d{2}\/restrictions/i.test(pathStr)) &&
    options.is_competitor_branded_asin === true) {
    notices.push(
      'Passing a branded competitor ASIN to getListingsRestrictions may surface competitor brand-gating; classify via classifySpApiRestrictionReasons() so competitor brand locks are not mistaken for category gating.',
    );
  }

  const result = {
    valid: issues.length === 0,
    provider: 'sp_api',
    canonical_tool: canonical,
    read_only_verified: issues.length === 0,
    issues,
    notices,
  };
  if (options.throwOnError && !result.valid) {
    throw new TypeError(`SP-API guard violation (${canonical}): ${issues.map(i => i.message).join(' ')}`);
  }
  return result;
}

/**
 * Unified connector guard entry point for SellerSprite, SIF, and SP-API.
 */
export function validateProviderCall(provider, toolName, params = {}, options = {}) {
  const norm = String(provider || '').trim().toLowerCase();
  if (norm === 'sellersprite') return validateSellerSpriteCall(toolName, params, options);
  if (norm === 'sif') return validateSifCall(toolName, params, options);
  if (norm === 'sp_api' || norm === 'sp-api' || norm === 'amazon_sp_api' || norm === 'amz_spapi') {
    return validateSpApiCall(toolName, params, options);
  }
  return { valid: true, provider: norm, canonical_tool: canonicalizeConnectorToolName(toolName), issues: [] };
}

/**
 * Parse SIF ops_get_listing_traffic_structure parallel arrays while enforcing exact field semantics:
 *  - ratio = vertical variant share (how one traffic channel splits across child variants; identifies main traffic driver)
 *  - dist  = horizontal channel mix (natural vs ad breakdown inside a single child variant)
 * Preserves null channel arrays as null (unknown), NEVER converts null to 0.
 */
export function parseSifTrafficStructure(payload) {
  const chars = payload?.chars ?? payload?.data?.chars ?? payload;
  if (!chars || typeof chars !== 'object' || !Array.isArray(chars.dims)) {
    throw new TypeError('Invalid ops_get_listing_traffic_structure payload: chars.dims array is required.');
  }
  const dims = chars.dims;
  const channelKeys = ['nfs', 'sps', 'sbs', 'sds', 'hrs', 'ers', 'ads', 'total'].filter(k => Object.hasOwn(chars, k));
  const readMetric = (arr, i, field) => {
    if (!Array.isArray(arr) || arr[i] === null || arr[i] === undefined) return null;
    const cell = arr[i];
    if (typeof cell !== 'object') return null;
    return finite(cell[field]) ? cell[field] : null;
  };

  const variants = dims.map((dim, i) => {
    const verticalVariantShare = {};
    const horizontalChannelMix = {};
    for (const ch of channelKeys) {
      verticalVariantShare[ch] = readMetric(chars[ch], i, 'ratio');
      horizontalChannelMix[ch] = readMetric(chars[ch], i, 'dist');
    }
    return {
      dim,
      asin: typeof dim === 'string' ? dim : (dim?.asin ?? dim?.name ?? String(i)),
      vertical_variant_share_ratio: verticalVariantShare,
      horizontal_channel_mix_dist: horizontalChannelMix,
    };
  });

  // Identify primary traffic-driving variant from vertical ratio (preferring total -> nfs -> sps).
  const leadChannel = channelKeys.includes('total') ? 'total' : (channelKeys.includes('nfs') ? 'nfs' : channelKeys[0] ?? null);
  let primaryVariant = null;
  if (leadChannel) {
    const ranked = variants
      .filter(v => finite(v.vertical_variant_share_ratio[leadChannel]))
      .sort((a, b) => b.vertical_variant_share_ratio[leadChannel] - a.vertical_variant_share_ratio[leadChannel]);
    primaryVariant = ranked[0]?.asin ?? null;
  }

  return {
    channels_present: channelKeys,
    primary_traffic_variant: primaryVariant,
    semantics_note: 'ratio = vertical variant share across siblings within one channel; dist = horizontal channel mix within one child variant; null = missing data (never 0).',
    variants,
  };
}

/**
 * Compute click conversion rate strictly as clickConvRate = purchaseVolume / clicks.
 * Explicitly rejects mixing purchaseRate / searchConvRate (purchases / searches) or typos like "purchases".
 */
export function computeClickConversionRate(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('computeClickConversionRate requires an input object.');
  }
  if ((input.purchaseRate !== undefined || input.searchConvRate !== undefined) &&
    input.purchaseVolume === undefined && input.clicks === undefined && input.clickConvRate === undefined) {
    throw new TypeError(
      'Forbidden denominator mixup: purchaseRate / searchConvRate (purchases / searches) CANNOT be substituted for clickConvRate (purchaseVolume / clicks).',
    );
  }
  if (Object.hasOwn(input, 'purchases') && input.purchaseVolume === undefined) {
    throw new TypeError(
      'SellerSprite field name is "purchaseVolume", NOT "purchases"; supply purchaseVolume and clicks explicitly.',
    );
  }
  if (finite(input.clickConvRate) && input.purchaseVolume === undefined && input.clicks === undefined) {
    if (input.clickConvRate < 0) throw new TypeError('clickConvRate must be nonnegative.');
    return {
      click_conv_rate: input.clickConvRate,
      source: 'direct_clickConvRate',
      formula: 'orders / clicks',
      anomaly_over_100pct: input.clickConvRate > 1,
    };
  }
  if (!finite(input.purchaseVolume) || input.purchaseVolume < 0 || !finite(input.clicks) || input.clicks <= 0) {
    throw new TypeError('Valid nonnegative purchaseVolume and positive clicks are required to compute clickConvRate.');
  }
  const rate = Math.round(((input.purchaseVolume / input.clicks) + Number.EPSILON) * 1e6) / 1e6;
  return {
    click_conv_rate: rate,
    purchase_volume: input.purchaseVolume,
    clicks: input.clicks,
    source: 'derived_purchaseVolume_over_clicks',
    formula: 'purchaseVolume / clicks',
    anomaly_over_100pct: rate > 1,
  };
}

/**
 * Verify target child-variant ownership of reviews returned by SellerSprite asin_review_list
 * (which normalizes child ASIN queries to parent ASIN on the server).
 * Used for both Group 6 pain-point extraction and Q31 old-review / seed-merge checks.
 */
export function verifyReviewVariantOwnership(reviews, {
  target_asin = null,
  target_sku_tokens = [],
  allow_untagged_single_variant = false,
} = {}) {
  if (!Array.isArray(reviews)) throw new TypeError('reviews must be an array.');
  const normAsin = nonemptyStr(target_asin) ? target_asin.trim().toUpperCase() : null;
  const normTokens = (Array.isArray(target_sku_tokens) ? target_sku_tokens : [])
    .filter(nonemptyStr)
    .map(t => t.trim().toLowerCase());
  if (!normAsin && normTokens.length === 0) {
    throw new TypeError('target_asin or nonempty target_sku_tokens[] is required to verify review variant ownership.');
  }

  const verifiedReviews = [];
  const excludedOtherVariant = [];
  const unverifiedMissingSku = [];

  for (const rev of reviews) {
    if (!rev || typeof rev !== 'object') continue;
    const rawSkus = Array.isArray(rev.skus)
      ? rev.skus
      : (typeof rev.sku === 'string' && rev.sku.trim() ? [rev.sku] : []);
    const skuStrings = rawSkus.map(s => String(s || '').trim()).filter(Boolean);
    const revChildAsin = nonemptyStr(rev.childAsin ?? rev.asin) ? String(rev.childAsin ?? rev.asin).trim().toUpperCase() : null;

    if (skuStrings.length === 0 && (!revChildAsin || revChildAsin === String(rev.parentAsin || '').trim().toUpperCase())) {
      if (allow_untagged_single_variant) {
        verifiedReviews.push({ ...rev, sku_verified: true, sku_verification_basis: 'single_variant_untagged_allowed' });
      } else {
        unverifiedMissingSku.push({ ...rev, sku_verified: 'unknown', reason: 'Review lacks skus[] variant metadata on parent-normalized response.' });
      }
      continue;
    }

    const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenBoundMatch = (haystack, tok) => {
      const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(tok)}(?![A-Za-z0-9])`, 'i');
      return re.test(haystack);
    };
    const explicitChildAsin = nonemptyStr(rev.childAsin) ? String(rev.childAsin).trim().toUpperCase() : null;
    const parentAsin = nonemptyStr(rev.parentAsin) ? String(rev.parentAsin).trim().toUpperCase() : null;
    const asinInSkus = normAsin !== null && skuStrings.some(s => tokenBoundMatch(s.toUpperCase(), normAsin));
    const tokenMatch = normTokens.length > 0 && skuStrings.some(s => normTokens.every(tok => tokenBoundMatch(s, tok)));
    // When target_sku_tokens[] AND skus[] are both present, never let a parent-echoed rev.asin override contradicting skus[]!
    const hasConflictingSkuTokens = normTokens.length > 0 && skuStrings.length > 0 && !tokenMatch && !asinInSkus;
    const asinMatch = !hasConflictingSkuTokens && normAsin !== null && (
      asinInSkus ||
      (explicitChildAsin !== null && explicitChildAsin === normAsin && explicitChildAsin !== parentAsin) ||
      (normTokens.length === 0 && revChildAsin === normAsin && revChildAsin !== parentAsin)
    );

    if (asinMatch || tokenMatch) {
      verifiedReviews.push({
        ...rev,
        sku_verified: true,
        matched_skus: skuStrings,
        sku_verification_basis: asinMatch ? 'asin_match' : 'sku_token_match',
      });
    } else {
      excludedOtherVariant.push({
        ...rev,
        sku_verified: false,
        observed_skus: skuStrings,
        reason: 'Review belongs to a different sibling variant under the same parent listing.',
      });
    }
  }

  return {
    total_input_reviews: reviews.length,
    verified_reviews: verifiedReviews,
    excluded_other_variant: excludedOtherVariant,
    unverified_missing_sku: unverifiedMissingSku,
  };
}
