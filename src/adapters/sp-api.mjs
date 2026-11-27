/**
 * Read-only Amazon SP-API adapter: official CatalogItems packaged dimensions/weight,
 * ProductFees referral & live FBA calibration, and ListingsRestrictions white-label classification.
 */
import {
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  classifySizeTier2027,
  lookupUnifiedFulfillmentFee2027,
} from '../fba-calculator.mjs';
import {
  hasEnvelopeFailureMarkers,
  hasUpstreamErrorMarkers,
  isFailedOrEmptyRawReceipt,
  isFailedUnwrappedBody,
  isPayloadUpstreamFailure,
  unwrapMcpEnvelope,
} from './mcp-envelope.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;
const round2 = v => Number(v.toFixed(2));

/**
 * Classify SP-API getListingsRestrictions reasons so competitor brand-gating on a peer ASIN
 * is never mistaken for a category ban on a new own-brand white-label listing.
 */
export function classifySpApiRestrictionReasons(reasons = [], { target_is_own_white_label = true } = {}) {
  const entries = (Array.isArray(reasons) ? reasons : []).filter(r => r && typeof r === 'object');
  let hasBrandGate = false;
  let hasCategoryOrProductApproval = false;
  let hasSingleAsinRecall = false;
  let hardBan = false;

  for (const r of entries) {
    const m = String(r.message || '').trim();
    const code = String(r.reasonCode || r.code || '').trim().toUpperCase();
    const isRecallMsg = /\brecalled\b|safety\s+recall/i.test(m);
    const isBrandMsg = /approval to list in this brand|brand owner contribution/i.test(m);
    const isHardBanMsg = !isRecallMsg && /prohibited|banned|not permitted for sale/i.test(m);
    const isCatApprovalMsg = !isBrandMsg && !isRecallMsg && (
      /approval to list this product|other listing limitations|toys|topical|dietary|medical|hazmat/i.test(m) ||
      code === 'NOT_ELIGIBLE' ||
      code === 'APPROVAL_REQUIRED'
    );
    if (isRecallMsg) hasSingleAsinRecall = true;
    if (isBrandMsg) hasBrandGate = true;
    if (isHardBanMsg) hardBan = true;
    if (isCatApprovalMsg) hasCategoryOrProductApproval = true;
  }

  const restrictionScope = hardBan
    ? 'hard_category_ban'
    : hasSingleAsinRecall
      ? 'single_asin_recall_scope_check'
      : hasCategoryOrProductApproval
        ? 'category_or_product_approval'
        : hasBrandGate
          ? 'competitor_brand_only'
          : 'clear';
  return {
    hard_category_ban: hardBan,
    has_competitor_brand_gate: hasBrandGate,
    has_category_or_product_approval_note: hasCategoryOrProductApproval,
    has_single_asin_recall_note: hasSingleAsinRecall,
    restriction_scope: restrictionScope,
    white_label_note: hardBan
      ? 'SP-API 命中禁止销售限制，须确认适用范围后再评估。'
      : hasSingleAsinRecall
        ? 'SP-API 竞品单 ASIN 存在召回记录（recalled），须核实属于该品牌单批次缺陷还是品类通病安全风险，不可混同为全类目封禁或直接忽略。'
        : target_is_own_white_label && hasBrandGate
          ? 'SP-API 竞品 ASIN 限制含「竞品品牌锁（approval to list in this brand）」，对自有白牌新建链接不构成品牌封锁；类目准入按自有 productType 预检核实。'
          : hasCategoryOrProductApproval
            ? 'SP-API 竞品 ASIN 含产品/类目准入或销售限制，须结合自有白牌 productType 预检核实。'
            : '已按 SP-API 准入原因分类核对。',
  };
}

function spApiMeasureToInches(measure) {
  if (!measure || typeof measure !== 'object' || !finite(measure.value) || measure.value <= 0) return null;
  const u = String(measure.unit ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (u === 'inches' || u === 'inch' || u === 'in') return Number(measure.value.toFixed(6));
  if (u === 'hundredths-inches' || u === 'hundredths-inch') return Number((measure.value / 100).toFixed(6));
  if (u === 'centimeters' || u === 'centimeter' || u === 'cm') return Number((measure.value / 2.54).toFixed(6));
  if (u === 'millimeters' || u === 'millimeter' || u === 'mm') return Number((measure.value / 25.4).toFixed(6));
  if (u === 'meters' || u === 'meter' || u === 'm') return Number((measure.value * 39.3700787).toFixed(6));
  if (u === 'feet' || u === 'foot' || u === 'ft') return Number((measure.value * 12).toFixed(6));
  return null;
}

function spApiWeightToPounds(measure) {
  if (!measure || typeof measure !== 'object' || !finite(measure.value) || measure.value <= 0) return null;
  const u = String(measure.unit ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (u === 'pounds' || u === 'pound' || u === 'lbs' || u === 'lb') return Number(measure.value.toFixed(6));
  if (u === 'hundredths-pounds' || u === 'hundredths-pound') return Number((measure.value / 100).toFixed(6));
  if (u === 'ounces' || u === 'ounce' || u === 'oz') return Number((measure.value / 16).toFixed(6));
  if (u === 'kilograms' || u === 'kilogram' || u === 'kg') return Number((measure.value / 0.45359237).toFixed(6));
  if (u === 'grams' || u === 'gram' || u === 'g') return Number((measure.value / 453.59237).toFixed(6));
  return null;
}

export function collectCatalogItemNodes(rawBody, depth = 0) {
  if (!rawBody || typeof rawBody !== 'object' || depth > 5) return [];
  if (Array.isArray(rawBody)) {
    return rawBody.flatMap(el => collectCatalogItemNodes(el, depth + 1));
  }
  const hasDirectCatalogShape =
    Array.isArray(rawBody.dimensions) ||
    Boolean(rawBody.attributes?.item_package_dimensions) ||
    Boolean(rawBody.attributes?.item_package_weight);
  if (hasDirectCatalogShape) return [rawBody];
  const collected = [];
  for (const listKey of ['items', 'catalogItems', 'catalog_items']) {
    const val = rawBody[listKey];
    if (Array.isArray(val)) {
      collected.push(...val.flatMap(el => collectCatalogItemNodes(el, depth + 1)));
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        if (v && typeof v === 'object') {
          collected.push(...collectCatalogItemNodes(nonemptyStr(v.asin) ? v : { asin: k, ...v }, depth + 1));
        }
      }
    }
  }
  if (collected.length > 0) return collected;
  for (const wrapKey of ['payload', 'data', 'result', 'response', 'catalogItem', 'catalog_item']) {
    if (rawBody[wrapKey] && typeof rawBody[wrapKey] === 'object') {
      const nested = collectCatalogItemNodes(rawBody[wrapKey], depth + 1);
      if (nested.length > 0) return nested;
    }
  }
  if (nonemptyStr(rawBody.asin)) return [rawBody];
  return [];
}

function isCatalogListEnvelope(rawBody) {
  if (!rawBody || typeof rawBody !== 'object') return false;
  if (Array.isArray(rawBody)) return true;
  if (Array.isArray(rawBody.items) || Array.isArray(rawBody.catalogItems) || Array.isArray(rawBody.catalog_items)) return true;
  if (rawBody.catalog_items && typeof rawBody.catalog_items === 'object') return true;
  for (const wrapKey of ['payload', 'data', 'result', 'response']) {
    if (rawBody[wrapKey] && typeof rawBody[wrapKey] === 'object' && isCatalogListEnvelope(rawBody[wrapKey])) return true;
  }
  return false;
}

function catalogNodeMatchesMarketplace(node, targetMkt) {
  if (!node || typeof node !== 'object') return false;
  const dimArr = Array.isArray(node.dimensions) ? node.dimensions : [];
  if (dimArr.some(d => !d?.marketplaceId || d.marketplaceId === targetMkt)) return true;
  const attrDim = Array.isArray(node.attributes?.item_package_dimensions) ? node.attributes.item_package_dimensions : [];
  if (attrDim.some(d => !d?.marketplace_id || d.marketplace_id === targetMkt)) return true;
  const attrWt = Array.isArray(node.attributes?.item_package_weight) ? node.attributes.item_package_weight : [];
  if (attrWt.some(w => !w?.marketplace_id || w.marketplace_id === targetMkt)) return true;
  return false;
}

function normalizeArchivedFeeEstimateRows(feesBody, defaultMkt = 'ATVPDKIKX0DER', defaultCur = 'USD') {
  const rows = Array.isArray(feesBody?.fees_estimates) ? feesBody.fees_estimates : null;
  if (!rows) return null;
  const mkt = nonemptyStr(feesBody.marketplace_id) ? feesBody.marketplace_id.trim() : defaultMkt;
  const cur = nonemptyStr(feesBody.currency) ? feesBody.currency.trim().toUpperCase() : defaultCur;
  return rows
    .filter(r => r && typeof r === 'object')
    .map(r => {
      const idVal = nonemptyStr(r.reference_asin ?? r.asin) ? String(r.reference_asin ?? r.asin).trim().toUpperCase() : null;
      const priceAmt = finite(r.price_usd) ? r.price_usd : null;
      const refAmt = finite(r.referral_fee_usd) ? r.referral_fee_usd : null;
      const fbaAmt = finite(r.fba_pick_and_pack_usd ?? r.fba_fee_usd ?? r.live_fba_fulfillment_usd)
        ? (r.fba_pick_and_pack_usd ?? r.fba_fee_usd ?? r.live_fba_fulfillment_usd)
        : null;
      const totalAmt = finite(r.total_fees_usd) ? r.total_fees_usd : (refAmt !== null && fbaAmt !== null ? round2(refAmt + fbaAmt) : null);
      const feeDetails = [];
      if (refAmt !== null) feeDetails.push({ FeeType: 'ReferralFee', FinalFee: { CurrencyCode: cur, Amount: refAmt } });
      if (fbaAmt !== null) feeDetails.push({ FeeType: 'FBAFees', FinalFee: { CurrencyCode: cur, Amount: fbaAmt } });
      return {
        Status: 'Success',
        FeesEstimateIdentifier: {
          MarketplaceId: nonemptyStr(r.marketplace_id) ? r.marketplace_id.trim() : mkt,
          IdType: 'ASIN',
          ...(idVal ? { IdValue: idVal } : {}),
          IsAmazonFulfilled: r.is_amazon_fulfilled !== false,
          ...(priceAmt !== null ? { PriceToEstimateFees: { ListingPrice: { CurrencyCode: cur, Amount: priceAmt } } } : {}),
        },
        FeesEstimate: {
          ...(totalAmt !== null ? { TotalFeesEstimate: { CurrencyCode: cur, Amount: totalAmt } } : {}),
          FeeDetailList: feeDetails,
        },
      };
    });
}

function extractCatalogPackageQuantity(catNode, targetMkt) {
  const pickPositiveInt = list => {
    if (!Array.isArray(list)) return null;
    const matched = list.find(e => !e?.marketplace_id || e.marketplace_id === targetMkt) ?? null;
    const rawVal = matched?.value ?? matched?.packageQuantity;
    const n = typeof rawVal === 'number' ? rawVal : (typeof rawVal === 'string' && /^\d+$/.test(rawVal.trim()) ? Number(rawVal.trim()) : NaN);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const fromSummary = Array.isArray(catNode?.summaries)
    ? (() => {
      const m = catNode.summaries.find(s => !s?.marketplaceId || s.marketplaceId === targetMkt);
      return Number.isSafeInteger(m?.packageQuantity) && m.packageQuantity > 0 ? m.packageQuantity : null;
    })()
    : null;
  return fromSummary ??
    pickPositiveInt(catNode?.attributes?.item_package_quantity) ??
    pickPositiveInt(catNode?.attributes?.number_of_items) ??
    null;
}

/**
 * Extract official Amazon packaged dimensions/weight, exact category referral rate, real-time FBA fee calibration,
 * and listing restriction status from read-only SP-API finalist receipts (`catalogItems_getCatalogItem`,
 * `productFees_getMyFeesEstimateForASIN/Estimates`, `listingsRestrictions_getListingsRestrictions`).
 * Automatically detects and overrides stale SellerSprite cached dimensions/weights.
 */
export function extractSpApiFinalistCalibration({
  asin: requestedAsin = null,
  marketplace_id = 'ATVPDKIKX0DER',
  currency = 'USD',
  catalogItemRaw = null,
  feesEstimateRaw = null,
  restrictionsRaw = null,
  sellerSpriteCachedRow = null,
  price_usd = null,
  expected_package_quantity = null,
  target_is_own_white_label = true,
  is_apparel = undefined,
  is_shoes = undefined,
  is_apparel_or_shoes = undefined,
  is_dangerous_goods = undefined,
  is_sipp = undefined,
  fee_category = null,
} = {}) {
  if (catalogItemRaw && isPayloadUpstreamFailure(catalogItemRaw)) {
    throw new TypeError('SP-API catalogItems_getCatalogItem receipt contains an upstream error.');
  }
  if (feesEstimateRaw && isPayloadUpstreamFailure(feesEstimateRaw)) {
    throw new TypeError('SP-API productFees receipt contains an upstream error.');
  }
  if (restrictionsRaw && isPayloadUpstreamFailure(restrictionsRaw)) {
    throw new TypeError('SP-API listingsRestrictions receipt contains an upstream error.');
  }

  const reqAsin = nonemptyStr(requestedAsin) ? requestedAsin.trim().toUpperCase() : null;
  const targetMkt = nonemptyStr(marketplace_id) ? marketplace_id.trim() : 'ATVPDKIKX0DER';
  const targetCur = nonemptyStr(currency) ? currency.trim().toUpperCase() : 'USD';
  const expectedPkgQty = Number.isSafeInteger(expected_package_quantity) && expected_package_quantity > 0
    ? expected_package_quantity
    : null;

  const catBody = catalogItemRaw ? unwrapMcpEnvelope(catalogItemRaw) : null;
  const feesBody = feesEstimateRaw ? unwrapMcpEnvelope(feesEstimateRaw) : null;
  const restBody = restrictionsRaw ? unwrapMcpEnvelope(restrictionsRaw) : null;

  let asin = reqAsin;
  let officialPkg = null;
  let packageCalibrationStatus = catalogItemRaw ? 'incomplete_package_dimensions' : 'missing_catalog_items';
  let missingPackageFields = [];
  let observedPackageQuantity = null;
  if (catBody && typeof catBody === 'object') {
    const catNodes = collectCatalogItemNodes(catBody);
    const fromListEnvelope = isCatalogListEnvelope(catBody);
    let selectedCatNode = null;
    if (catNodes.length === 1 && !fromListEnvelope) {
      const single = catNodes[0];
      const catAsin = nonemptyStr(single.asin) ? single.asin.trim().toUpperCase() : null;
      if (reqAsin && catAsin && catAsin !== reqAsin) {
        throw new TypeError(`SP-API catalogItems ASIN ("${catAsin}") conflicts with requested ASIN ("${reqAsin}").`);
      }
      selectedCatNode = single;
    } else if (catNodes.length > 0) {
      const asinMatches = reqAsin
        ? catNodes.filter(n => nonemptyStr(n.asin) && n.asin.trim().toUpperCase() === reqAsin)
        : (catNodes.length === 1 ? catNodes : []);
      selectedCatNode = asinMatches.find(n => catalogNodeMatchesMarketplace(n, targetMkt)) ?? asinMatches[0] ?? null;
      if (!selectedCatNode) {
        packageCalibrationStatus = 'asin_not_found_in_catalog_items';
      }
    }

    if (selectedCatNode) {
      const catAsin = nonemptyStr(selectedCatNode.asin) ? selectedCatNode.asin.trim().toUpperCase() : null;
      if (catAsin) asin = catAsin;
      const dimArr = Array.isArray(selectedCatNode.dimensions) ? selectedCatNode.dimensions : [];
      const matchedDimRow = dimArr.find(d => !d?.marketplaceId || d.marketplaceId === targetMkt)
        ?? (dimArr.length === 1 && !dimArr[0]?.marketplaceId ? dimArr[0] : null);
      const dimEntry = matchedDimRow?.package ?? null;
      const attrPkgDimArr = Array.isArray(selectedCatNode.attributes?.item_package_dimensions)
        ? selectedCatNode.attributes.item_package_dimensions
        : [];
      const attrPkgDim = attrPkgDimArr.find(d => !d?.marketplace_id || d.marketplace_id === targetMkt) ?? null;
      const attrPkgWtArr = Array.isArray(selectedCatNode.attributes?.item_package_weight)
        ? selectedCatNode.attributes.item_package_weight
        : [];
      const attrPkgWt = attrPkgWtArr.find(w => !w?.marketplace_id || w.marketplace_id === targetMkt) ?? null;
      const hasAnyMktRows = dimArr.length > 0 || attrPkgDimArr.length > 0 || attrPkgWtArr.length > 0;
      const hasAnyMatchedMktRow = Boolean(matchedDimRow || attrPkgDim || attrPkgWt);
      observedPackageQuantity = extractCatalogPackageQuantity(selectedCatNode, targetMkt);

      if (hasAnyMktRows && !hasAnyMatchedMktRow) {
        packageCalibrationStatus = 'marketplace_mismatch';
      } else {
        const lengthIn = spApiMeasureToInches(dimEntry?.length ?? attrPkgDim?.length);
        const widthIn = spApiMeasureToInches(dimEntry?.width ?? attrPkgDim?.width);
        const heightIn = spApiMeasureToInches(dimEntry?.height ?? attrPkgDim?.height);
        const weightLb = spApiWeightToPounds(dimEntry?.weight ?? attrPkgWt);
        if (lengthIn === null) missingPackageFields.push('length');
        if (widthIn === null) missingPackageFields.push('width');
        if (heightIn === null) missingPackageFields.push('height');
        if (weightLb === null) missingPackageFields.push('weight');
        if (missingPackageFields.length === 0) {
          if (expectedPkgQty !== null && observedPackageQuantity !== null && observedPackageQuantity !== expectedPkgQty) {
            packageCalibrationStatus = 'saleable_unit_mismatch';
          } else if (expectedPkgQty !== null && observedPackageQuantity === null) {
            packageCalibrationStatus = 'unverified_package_quantity';
          } else {
            packageCalibrationStatus = 'verified';
            officialPkg = {
              ...(asin ? { asin } : {}),
              length_in: lengthIn,
              width_in: widthIn,
              height_in: heightIn,
              unit_weight_lb: weightLb,
              ...(observedPackageQuantity !== null ? { package_quantity: observedPackageQuantity } : {}),
              marketplace_id: targetMkt,
              is_sp_api_official: true,
              source: 'sp_api_catalog_items',
            };
          }
        }
      }
    }
  }

  let feeCalibration = null;
  let feeCalibrationStatus = null;
  if (feesBody && typeof feesBody === 'object') {
    const archivedRows = normalizeArchivedFeeEstimateRows(feesBody, targetMkt, targetCur);
    const rawList = archivedRows ?? (Array.isArray(feesBody)
      ? feesBody
      : (Array.isArray(feesBody.FeesEstimateResultList)
        ? feesBody.FeesEstimateResultList
        : (Array.isArray(feesBody.payload?.FeesEstimateResultList)
          ? feesBody.payload.FeesEstimateResultList
          : (Array.isArray(feesBody.payload)
            ? feesBody.payload
            : [feesBody.FeesEstimateResult ?? feesBody.payload?.FeesEstimateResult ?? feesBody]))));
    const candidateNodes = rawList
      .map(n => (n && typeof n === 'object' ? (n.FeesEstimateResult ?? n) : null))
      .filter(Boolean);

    const hasRealErrorObj = errObj => Boolean(
      errObj && typeof errObj === 'object' && (
        nonemptyStr(errObj.Code) || nonemptyStr(errObj.Message) ||
        nonemptyStr(errObj.code) || nonemptyStr(errObj.message)
      ),
    );
    const asinScopedNodes = candidateNodes.filter(node => {
      const ident = node?.FeesEstimateIdentifier ?? node?.feesEstimateIdentifier ?? null;
      const idType = nonemptyStr(ident?.IdType) ? ident.IdType.trim().toUpperCase() : null;
      const idVal = nonemptyStr(ident?.IdValue) ? ident.IdValue.trim().toUpperCase() : null;
      const mktId = nonemptyStr(ident?.MarketplaceId) ? ident.MarketplaceId.trim() : null;
      const curCode = nonemptyStr(ident?.PriceToEstimateFees?.ListingPrice?.CurrencyCode)
        ? ident.PriceToEstimateFees.ListingPrice.CurrencyCode.trim().toUpperCase()
        : null;
      const isFba = ident?.IsAmazonFulfilled;
      const lp = ident?.PriceToEstimateFees?.ListingPrice?.Amount;
      const shipAmt = finite(ident?.PriceToEstimateFees?.Shipping?.Amount)
        ? ident.PriceToEstimateFees.Shipping.Amount
        : 0;
      const totalInputPrice = finite(lp) ? lp + shipAmt : null;
      if ((asin || finite(price_usd)) && !ident) return false;
      if (asin && idType && idType !== 'ASIN') return false;
      if (asin && idVal && idVal !== asin) return false;
      if (asin && !idVal && candidateNodes.length > 1) return false;
      if (!asin && candidateNodes.length > 1) return false;
      if (mktId && mktId !== targetMkt) return false;
      if (curCode && curCode !== targetCur) return false;
      if (isFba === false) return false;
      if (finite(price_usd) && price_usd > 0 && finite(totalInputPrice) && Math.round(totalInputPrice * 100) !== Math.round(price_usd * 100)) return false;
      const est = node?.FeesEstimate ?? node?.feesEstimate ?? null;
      if (est && typeof est === 'object') {
        const totalCur = nonemptyStr(est.TotalFeesEstimate?.CurrencyCode) ? est.TotalFeesEstimate.CurrencyCode.trim().toUpperCase() : null;
        if (totalCur && totalCur !== targetCur) return false;
        const details = Array.isArray(est.FeeDetailList) ? est.FeeDetailList : [];
        for (const d of details) {
          const fc = nonemptyStr(d?.FinalFee?.CurrencyCode) ? d.FinalFee.CurrencyCode.trim().toUpperCase()
            : (nonemptyStr(d?.FeeAmount?.CurrencyCode) ? d.FeeAmount.CurrencyCode.trim().toUpperCase() : null);
          if (fc && fc !== targetCur) return false;
        }
      }
      return true;
    });

    for (const node of asinScopedNodes) {
      const st = nonemptyStr(node?.Status) ? node.Status.trim().toLowerCase() : null;
      if ((st && st !== 'success') || hasRealErrorObj(node?.Error ?? node?.error)) {
        throw new TypeError(`SP-API productFees FeesEstimateResult failed (${node?.Error?.Code ?? node?.Status ?? 'error'}).`);
      }
    }

    const rawMatchedNodes = asinScopedNodes.filter(node => {
      const est = node?.FeesEstimate ?? node?.feesEstimate ?? null;
      return Boolean(est && typeof est === 'object');
    });
    const dedupedBySignature = new Map();
    for (const node of rawMatchedNodes) {
      const est = node?.FeesEstimate ?? node?.feesEstimate ?? null;
      const ident = node?.FeesEstimateIdentifier ?? node?.feesEstimateIdentifier ?? null;
      const idVal = nonemptyStr(ident?.IdValue) ? ident.IdValue.trim().toUpperCase() : '';
      const lpCents = finite(ident?.PriceToEstimateFees?.ListingPrice?.Amount)
        ? Math.round(ident.PriceToEstimateFees.ListingPrice.Amount * 100)
        : '';
      const shipCents = finite(ident?.PriceToEstimateFees?.Shipping?.Amount)
        ? Math.round(ident.PriceToEstimateFees.Shipping.Amount * 100)
        : 0;
      const details = Array.isArray(est?.FeeDetailList) ? est.FeeDetailList : [];
      const refRow = details.find(d => String(d?.FeeType || '').toLowerCase() === 'referralfee');
      const fbaRow = details.find(d => String(d?.FeeType || '').toLowerCase() === 'fbafees');
      const refAmt = refRow?.FinalFee?.Amount ?? refRow?.FeeAmount?.Amount ?? '';
      const fbaAmt = fbaRow?.FinalFee?.Amount ?? fbaRow?.FeeAmount?.Amount ?? '';
      const sig = `${idVal}::${lpCents}::${shipCents}::${refAmt}::${fbaAmt}`;
      if (!dedupedBySignature.has(sig)) dedupedBySignature.set(sig, node);
    }
    const matchedNodes = [...dedupedBySignature.values()];

    if (matchedNodes.length === 1) {
      const resNode = matchedNodes[0];
      const est = resNode?.FeesEstimate ?? resNode?.feesEstimate ?? null;
      const ident = resNode?.FeesEstimateIdentifier ?? resNode?.feesEstimateIdentifier ?? null;
      if (!asin && nonemptyStr(ident?.IdValue)) asin = ident.IdValue.trim().toUpperCase();
      const rawListingAmt = finite(ident?.PriceToEstimateFees?.ListingPrice?.Amount)
        ? ident.PriceToEstimateFees.ListingPrice.Amount
        : null;
      const shippingAmt = finite(ident?.PriceToEstimateFees?.Shipping?.Amount)
        ? ident.PriceToEstimateFees.Shipping.Amount
        : 0;
      const totalPriceAmt = rawListingAmt !== null
        ? Number((rawListingAmt + shippingAmt).toFixed(2))
        : (finite(price_usd) && price_usd > 0 ? Number(price_usd.toFixed(2)) : null);
      const listingPriceAmt = rawListingAmt ?? totalPriceAmt;
      const details = Array.isArray(est.FeeDetailList) ? est.FeeDetailList : [];
      const findFee = type => details.find(d => String(d?.FeeType || '').toLowerCase() === type.toLowerCase());
      const refRow = findFee('ReferralFee');
      const fbaRow = findFee('FBAFees');
      const vcfRow = findFee('VariableClosingFee');
      const referralUsd = finite(refRow?.FinalFee?.Amount) ? refRow.FinalFee.Amount : (finite(refRow?.FeeAmount?.Amount) ? refRow.FeeAmount.Amount : null);
      const fbaLiveUsd = finite(fbaRow?.FinalFee?.Amount) ? fbaRow.FinalFee.Amount : (finite(fbaRow?.FeeAmount?.Amount) ? fbaRow.FeeAmount.Amount : null);
      const vcfUsd = finite(vcfRow?.FinalFee?.Amount) ? vcfRow.FinalFee.Amount : 0;
      const totalFeesUsd = finite(est.TotalFeesEstimate?.Amount) ? est.TotalFeesEstimate.Amount : null;
      const referralFraction = (referralUsd !== null && finite(totalPriceAmt) && totalPriceAmt > 0)
        ? Number((referralUsd / totalPriceAmt).toFixed(6))
        : null;
      const hasCompleteFeeDetails = referralFraction !== null && fbaLiveUsd !== null;
      feeCalibration = {
        listing_price_usd: listingPriceAmt,
        shipping_usd: shippingAmt,
        total_price_usd: totalPriceAmt,
        referral_fee_usd: referralUsd,
        referral_fraction: referralFraction,
        live_fba_fulfillment_usd: fbaLiveUsd,
        variable_closing_fee_usd: vcfUsd,
        total_fees_estimate_usd: totalFeesUsd,
        source: 'sp_api_product_fees',
      };
      feeCalibrationStatus = hasCompleteFeeDetails ? 'verified' : 'incomplete_fee_details';
    } else {
      feeCalibrationStatus = matchedNodes.length === 0 ? 'unmatched' : 'ambiguous_multiple_estimates';
    }
  }

  let restrictions = null;
  let restrictionsStatus = null;
  if (restBody !== null) {
    const isArchivedMultiAsinRestrictions = Array.isArray(restBody?.listings_restrictions);
    const resolvedRestArr = Array.isArray(restBody?.restrictions)
      ? restBody.restrictions
      : (isArchivedMultiAsinRestrictions
        ? restBody.listings_restrictions
        : (Array.isArray(restBody) ? restBody : null));
    if (!restBody || typeof restBody !== 'object' || !resolvedRestArr) {
      throw new TypeError('SP-API listingsRestrictions payload is missing a valid restrictions[] array.');
    }
    if (asin && nonemptyStr(restBody.asin) && restBody.asin.trim().toUpperCase() !== asin) {
      throw new TypeError(`SP-API listingsRestrictions ASIN ("${restBody.asin.trim().toUpperCase()}") conflicts with target ASIN ("${asin}").`);
    }
    const restArr = resolvedRestArr;
    const rowsHaveExplicitAsin = restArr.length > 0 && restArr.some(r => nonemptyStr(r?.asin));
    const asinMatchedInMultiList = !asin || !rowsHaveExplicitAsin ||
      restArr.some(r => nonemptyStr(r?.asin) && r.asin.trim().toUpperCase() === asin);
    if (!asinMatchedInMultiList || (isArchivedMultiAsinRestrictions && asin && restArr.length === 0)) {
      restrictionsStatus = 'asin_not_found_in_listings_restrictions';
    } else {
      const asinFilteredRest = restArr.filter(r => {
        if (asin && nonemptyStr(r?.asin) && r.asin.trim().toUpperCase() !== asin) return false;
        if (nonemptyStr(r?.marketplaceId) && r.marketplaceId.trim() !== targetMkt) return false;
        if (nonemptyStr(r?.conditionType) && r.conditionType.trim().toLowerCase() !== 'new_new') return false;
        return true;
      });
      const allReasons = asinFilteredRest.flatMap(r => Array.isArray(r?.reasons) ? r.reasons : []);
      restrictions = {
        restriction_count: asinFilteredRest.length,
        ...classifySpApiRestrictionReasons(allReasons, { target_is_own_white_label }),
      };
      restrictionsStatus = 'verified';
    }
  }

  const calDefaultEvalPrice = finite(feeCalibration?.total_price_usd) && feeCalibration.total_price_usd > 0
    ? feeCalibration.total_price_usd
    : feeCalibration?.listing_price_usd;
  const evalPrice = finite(price_usd) && price_usd > 0
    ? price_usd
    : (finite(calDefaultEvalPrice) && calDefaultEvalPrice > 0 ? calDefaultEvalPrice : 39.99);
  const local2027 = officialPkg
    ? lookupUnifiedFulfillmentFee2027({
      pkg: officialPkg,
      price_usd: evalPrice,
      sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
      is_apparel,
      is_shoes,
      is_apparel_or_shoes,
      is_dangerous_goods,
      is_sipp,
      fee_category,
    })
    : null;

  let staleCacheAudit = null;
  if (officialPkg && sellerSpriteCachedRow && typeof sellerSpriteCachedRow === 'object') {
    const ssPkg = {
      length_in: sellerSpriteCachedRow.length_in ?? sellerSpriteCachedRow.pkgLength,
      width_in: sellerSpriteCachedRow.width_in ?? sellerSpriteCachedRow.pkgWidth,
      height_in: sellerSpriteCachedRow.height_in ?? sellerSpriteCachedRow.pkgHeight,
      unit_weight_lb: sellerSpriteCachedRow.unit_weight_lb ?? sellerSpriteCachedRow.weight_lb ?? sellerSpriteCachedRow.pkgWeight,
      length_cm: sellerSpriteCachedRow.length_cm,
      width_cm: sellerSpriteCachedRow.width_cm,
      height_cm: sellerSpriteCachedRow.height_cm,
      unit_weight_kg: sellerSpriteCachedRow.unit_weight_kg ?? sellerSpriteCachedRow.weight_kg,
    };
    const ssTier = classifySizeTier2027(ssPkg);
    if (ssTier.status === 'verified') {
      const ssFul2027 = lookupUnifiedFulfillmentFee2027({
        pkg: ssPkg,
        price_usd: evalPrice,
        sales_window: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
        is_apparel,
        is_shoes,
        is_apparel_or_shoes,
        is_dangerous_goods,
        is_sipp,
        fee_category,
      });
      const weightDeltaLb = Number((officialPkg.unit_weight_lb - ssTier.unit_weight_lb).toFixed(4));
      const fbaDeltaUsd = (local2027?.status === 'verified' && ssFul2027.status === 'verified')
        ? Number((local2027.total_usd - ssFul2027.total_usd).toFixed(4))
        : null;
      staleCacheAudit = {
        stale_sellersprite_cache_corrected:
          Math.abs(weightDeltaLb) >= 0.05 ||
          ssTier.size_tier !== local2027?.size_tier ||
          (fbaDeltaUsd !== null && Math.abs(fbaDeltaUsd) >= 0.05),
        sellersprite_cached_size_tier: ssTier.size_tier,
        sp_api_official_size_tier: local2027?.size_tier ?? null,
        sellersprite_cached_weight_lb: ssTier.unit_weight_lb,
        sp_api_official_weight_lb: officialPkg.unit_weight_lb,
        weight_delta_lb: weightDeltaLb,
        sellersprite_cached_fba_2027_usd: ssFul2027.status === 'verified' ? ssFul2027.total_usd : null,
        sp_api_official_fba_2027_usd: local2027?.status === 'verified' ? local2027.total_usd : null,
        fba_2027_delta_usd: fbaDeltaUsd,
      };
    }
  }

  const missingComponents = [];
  if (packageCalibrationStatus !== 'verified') missingComponents.push('catalog_items_package');
  if (feeCalibrationStatus !== 'verified') missingComponents.push('product_fees_estimate');
  if (restrictions === null) missingComponents.push('listings_restrictions');

  return {
    asin,
    marketplace_id: targetMkt,
    package_calibration_status: packageCalibrationStatus,
    ...(missingPackageFields.length > 0 ? { missing_package_fields: missingPackageFields } : {}),
    ...(observedPackageQuantity !== null ? { observed_package_quantity: observedPackageQuantity } : {}),
    ...(expectedPkgQty !== null ? { expected_package_quantity: expectedPkgQty } : {}),
    official_pkg: officialPkg,
    local_2027_off_peak_fulfillment: local2027?.status === 'verified' ? local2027 : null,
    fee_calibration: feeCalibration,
    ...(feeCalibrationStatus ? { fee_calibration_status: feeCalibrationStatus } : {}),
    restrictions,
    ...(restrictionsStatus && restrictionsStatus !== 'verified' ? { restrictions_status: restrictionsStatus } : {}),
    stale_sellersprite_audit: staleCacheAudit,
    missing_components: missingComponents,
    finalist_calibration_complete: missingComponents.length === 0,
    calibration_source: 'sp_api_readonly_finalist',
  };
}

/**
 * Scan raw payloads for SP-API `catalogItems_getCatalogItem` receipts (single or wrapped `payload`/`items[]`/`catalog_items`)
 * and return official peer package specs.
 */
export function extractSpApiPeerPackagesFromRawPayloads(rawPayloads = [], {
  marketplace_id = 'ATVPDKIKX0DER',
  expected_package_quantity = null,
} = {}) {
  const peers = [];
  const seenAsins = new Set();
  for (const entry of rawPayloads) {
    const raw = entry?.payload ?? entry;
    if (isFailedOrEmptyRawReceipt(raw)) continue;
    const unwrapped = unwrapMcpEnvelope(raw);
    const nodes = collectCatalogItemNodes(unwrapped);
    for (const node of nodes) {
      try {
        const cal = extractSpApiFinalistCalibration({
          catalogItemRaw: node,
          marketplace_id,
          ...(expected_package_quantity !== null ? { expected_package_quantity } : {}),
        });
        if (cal.official_pkg) {
          const key = cal.official_pkg.asin ?? '';
          if (!key || !seenAsins.has(key)) {
            if (key) seenAsins.add(key);
            peers.push(cal.official_pkg);
          }
        }
      } catch { /* ignore non-catalog payloads */ }
    }
  }
  return peers;
}

