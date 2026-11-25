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
  const msgs = (Array.isArray(reasons) ? reasons : []).map(r => String(r?.message || '')).filter(Boolean);
  const hasBrandGate = msgs.some(m => /approval to list in this brand|brand owner contribution/i.test(m));
  const hasCategoryOrProductApproval = msgs.some(m =>
    /approval to list this product|other listing limitations|toys|topical|dietary|medical|hazmat/i.test(m) &&
    !/in this brand/i.test(m),
  );
  const hardBan = msgs.some(m => /prohibited|recalled|banned|not permitted for sale/i.test(m));
  return {
    hard_category_ban: hardBan,
    has_competitor_brand_gate: hasBrandGate,
    has_category_or_product_approval_note: hasCategoryOrProductApproval,
    white_label_note: target_is_own_white_label && hasBrandGate
      ? 'SP-API 竞品 ASIN 限制含「竞品品牌锁（approval to list in this brand）」，对自有白牌新建链接不构成品牌封锁；类目准入按自有 productType 预检核实。'
      : '已按 SP-API 准入原因分类核对。',
  };
}

function spApiMeasureToInches(measure) {
  if (!measure || typeof measure !== 'object' || !finite(measure.value) || measure.value <= 0) return null;
  const u = String(measure.unit ?? '').trim().toLowerCase();
  if (u === 'inches' || u === 'inch' || u === 'in') return Number(measure.value.toFixed(6));
  if (u === 'centimeters' || u === 'centimeter' || u === 'cm') return Number((measure.value / 2.54).toFixed(6));
  if (u === 'millimeters' || u === 'millimeter' || u === 'mm') return Number((measure.value / 25.4).toFixed(6));
  if (u === 'feet' || u === 'foot' || u === 'ft') return Number((measure.value * 12).toFixed(6));
  return null;
}

function spApiWeightToPounds(measure) {
  if (!measure || typeof measure !== 'object' || !finite(measure.value) || measure.value <= 0) return null;
  const u = String(measure.unit ?? '').trim().toLowerCase();
  if (u === 'pounds' || u === 'pound' || u === 'lbs' || u === 'lb') return Number(measure.value.toFixed(6));
  if (u === 'ounces' || u === 'ounce' || u === 'oz') return Number((measure.value / 16).toFixed(6));
  if (u === 'kilograms' || u === 'kilogram' || u === 'kg') return Number((measure.value / 0.45359237).toFixed(6));
  if (u === 'grams' || u === 'gram' || u === 'g') return Number((measure.value / 453.59237).toFixed(6));
  return null;
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

  const catBody = catalogItemRaw ? unwrapMcpEnvelope(catalogItemRaw) : null;
  const feesBody = feesEstimateRaw ? unwrapMcpEnvelope(feesEstimateRaw) : null;
  const restBody = restrictionsRaw ? unwrapMcpEnvelope(restrictionsRaw) : null;

  let asin = reqAsin;
  let officialPkg = null;
  if (catBody && typeof catBody === 'object') {
    const catAsin = nonemptyStr(catBody.asin) ? catBody.asin.trim().toUpperCase() : null;
    if (reqAsin && catAsin && catAsin !== reqAsin) {
      throw new TypeError(`SP-API catalogItems ASIN ("${catAsin}") conflicts with requested ASIN ("${reqAsin}").`);
    }
    if (catAsin) asin = catAsin;
    const dimArr = Array.isArray(catBody.dimensions) ? catBody.dimensions : [];
    const matchedDimRow = dimArr.find(d => !d?.marketplaceId || d.marketplaceId === targetMkt)
      ?? (dimArr.length === 1 && !dimArr[0]?.marketplaceId ? dimArr[0] : null);
    const dimEntry = matchedDimRow?.package ?? null;
    const attrPkgDimArr = Array.isArray(catBody.attributes?.item_package_dimensions)
      ? catBody.attributes.item_package_dimensions
      : [];
    const attrPkgDim = attrPkgDimArr.find(d => !d?.marketplace_id || d.marketplace_id === targetMkt) ?? null;
    const attrPkgWtArr = Array.isArray(catBody.attributes?.item_package_weight)
      ? catBody.attributes.item_package_weight
      : [];
    const attrPkgWt = attrPkgWtArr.find(w => !w?.marketplace_id || w.marketplace_id === targetMkt) ?? null;
    const lengthIn = spApiMeasureToInches(dimEntry?.length ?? attrPkgDim?.length);
    const widthIn = spApiMeasureToInches(dimEntry?.width ?? attrPkgDim?.width);
    const heightIn = spApiMeasureToInches(dimEntry?.height ?? attrPkgDim?.height);
    const weightLb = spApiWeightToPounds(dimEntry?.weight ?? attrPkgWt);
    if (lengthIn !== null && widthIn !== null && heightIn !== null && weightLb !== null) {
      officialPkg = {
        ...(asin ? { asin } : {}),
        length_in: lengthIn,
        width_in: widthIn,
        height_in: heightIn,
        unit_weight_lb: weightLb,
        is_sp_api_official: true,
        source: 'sp_api_catalog_items',
      };
    }
  }

  let feeCalibration = null;
  let feeCalibrationStatus = null;
  if (feesBody && typeof feesBody === 'object') {
    const rawList = Array.isArray(feesBody)
      ? feesBody
      : (Array.isArray(feesBody.FeesEstimateResultList)
        ? feesBody.FeesEstimateResultList
        : (Array.isArray(feesBody.payload?.FeesEstimateResultList)
          ? feesBody.payload.FeesEstimateResultList
          : (Array.isArray(feesBody.payload)
            ? feesBody.payload
            : [feesBody.FeesEstimateResult ?? feesBody.payload?.FeesEstimateResult ?? feesBody])));
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
      feeCalibrationStatus = 'verified';
    } else {
      feeCalibrationStatus = matchedNodes.length === 0 ? 'unmatched' : 'ambiguous_multiple_estimates';
    }
  }

  let restrictions = null;
  if (restBody !== null) {
    if (!restBody || typeof restBody !== 'object' || (!Array.isArray(restBody.restrictions) && !Array.isArray(restBody))) {
      throw new TypeError('SP-API listingsRestrictions payload is missing a valid restrictions[] array.');
    }
    if (asin && nonemptyStr(restBody.asin) && restBody.asin.trim().toUpperCase() !== asin) {
      throw new TypeError(`SP-API listingsRestrictions ASIN ("${restBody.asin.trim().toUpperCase()}") conflicts with target ASIN ("${asin}").`);
    }
    const restArr = Array.isArray(restBody.restrictions) ? restBody.restrictions : restBody;
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

  return {
    asin,
    official_pkg: officialPkg,
    local_2027_off_peak_fulfillment: local2027?.status === 'verified' ? local2027 : null,
    fee_calibration: feeCalibration,
    ...(feeCalibrationStatus ? { fee_calibration_status: feeCalibrationStatus } : {}),
    restrictions,
    stale_sellersprite_audit: staleCacheAudit,
    calibration_source: 'sp_api_readonly_finalist',
  };
}

/**
 * Scan raw payloads for SP-API `catalogItems_getCatalogItem` receipts and return official peer package specs.
 */
export function extractSpApiPeerPackagesFromRawPayloads(rawPayloads = []) {
  const peers = [];
  for (const entry of rawPayloads) {
    const raw = entry?.payload ?? entry;
    if (isFailedOrEmptyRawReceipt(raw)) continue;
    try {
      const cal = extractSpApiFinalistCalibration({ catalogItemRaw: raw });
      if (cal.official_pkg) peers.push(cal.official_pkg);
    } catch { /* ignore non-catalog payloads */ }
  }
  return peers;
}

