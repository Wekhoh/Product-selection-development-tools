/**
 * Deterministic zero-glue raw trial ingestion & candidate provenance verifier.
 * External provider adapters live in `src/adapters/{mcp-envelope,sellersprite,sif,sp-api,keepa}.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  deduplicateParentSalesRows,
  extractNewcomerReviewOriginBreakdown,
  resolveCategoryReturnWithFallback,
  sanitizeNewcomerMemberReviews,
} from './observations.mjs';
import { scoreBatch } from './scoring.mjs';
import { calculateEconomics, netReferral } from './economics.mjs';
import { assertNoRawPii, containsSecretToken } from './contracts.mjs';
import { analyzeMainstreamPriceBand, parseSingleUnitUsdCoupon } from './price-band.mjs';
import { BUSINESS_THRESHOLDS } from './business-thresholds.mjs';
import {
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_INBOUND_WINDOW,
  FBA_2027_UNPUBLISHED_PEAK_WINDOW,
  UNPUBLISHED_2027_PEAK_MARGIN_NOTE,
  classifySizeTier2027,
  priceBand2027,
  lookupUnifiedFulfillmentFee2027,
  lookupUnifiedStorageFee2027,
  lookupUnifiedPlacementFee2027,
  lookupUnifiedReturnsProcessing2027,
  computeMatchedPeerMedianPackage,
  resolveEffectivePricing,
  computeHeadhaulWithA4Rules,
} from './fba-calculator.mjs';
import { canonicalJson, openSelectionStore, sha256Hex } from './store.mjs';
import {
  ASIN_EXACT_RE,
  ASIN_TOKEN_RE,
  hasUpstreamErrorMarkers,
  isPayloadUpstreamFailure,
  hasEnvelopeFailureMarkers,
  isFailedOrEmptyRawReceipt,
  unwrapMcpEnvelope,
  isFailedUnwrappedBody,
  extractItemCategoryRoot,
  extractStructuredPricesFromObject,
  reconcileAsinPriceProvenance,
  extractVerifiedAsinCatalogFromRawPayloads,
  extractVerifiedAsinSetFromRawPayloads,
  extractAllCandidateAsins,
  assertRawAsinProvenance,
  ingestRawCategoryAndDemandMetrics,
  extractSifThreeTierBidPlan,
  classifySpApiRestrictionReasons,
  extractSpApiFinalistCalibration,
  extractSpApiPeerPackagesFromRawPayloads,
  ingestSellerSpriteMonthlyArchiveMarket,
  extractNicheAverageStarReference,
  extractQ31DualSourceKeywordCounts,
  parseSellerSpriteKeepaPayload,
  buildKeepaPeerFactsForMarketJudge,
} from './adapters/index.mjs';

export {
  isFailedOrEmptyRawReceipt,
  unwrapMcpEnvelope,
  extractVerifiedAsinCatalogFromRawPayloads,
  extractVerifiedAsinSetFromRawPayloads,
  extractAllCandidateAsins,
  assertRawAsinProvenance,
  ingestRawCategoryAndDemandMetrics,
  extractSifThreeTierBidPlan,
  classifySpApiRestrictionReasons,
  extractSpApiFinalistCalibration,
  extractSpApiPeerPackagesFromRawPayloads,
  ingestSellerSpriteMonthlyArchiveMarket,
  extractNicheAverageStarReference,
  extractQ31DualSourceKeywordCounts,
  parseSellerSpriteKeepaPayload,
  buildKeepaPeerFactsForMarketJudge,
};

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;
const round2 = v => Number(v.toFixed(2));

export function resolveStage1QualitativeJudgments({
  evidence = [],
  spec_verification = null,
  review_judge = null,
  rights_prescreen = null,
  market_seller_count = null,
  reference_price_usd = null,
  default_target_variant_asin = null,
  default_target_variant_sku = null,
} = {}) {
  const objectiveTags = [];

  // #16 existing_solution_fit (0..4)
  let existingSolutionFit;
  if (spec_verification?.complete_set_verified === true && Number.isInteger(spec_verification.anchor)) {
    existingSolutionFit = {
      anchor: spec_verification.anchor,
      complete_set_verified: true,
      reason: spec_verification.reason || '1688 公开规格与齐套配件覆盖核心买家任务，实物公差留待二阶段拿样核对。',
      evidence,
    };
  } else if (spec_verification?.complete_set_verified === true) {
    existingSolutionFit = {
      anchor: null,
      complete_set_verified: true,
      sample_check_required: true,
      reason: spec_verification.reason || spec_verification.spec_conflict_reason || '1688 齐套现货已核实，英文说明书／配件编码细节留待拿样或向工厂确认。',
      evidence,
    };
  } else {
    existingSolutionFit = {
      anchor: null,
      ...(spec_verification?.complete_set_verified === false ? { complete_set_verified: false } : {}),
      reason: spec_verification?.spec_conflict_reason || '1688 报价存在规格缺件、尺寸矛盾或未入镜，待补核齐套规格后评定。',
      evidence,
    };
  }

  // #17 feasible_light_differentiation (0..1): uninspected reviews MUST remain null (never 0)
  let lightDiff;
  const frozenTargetAsin = nonemptyStr(default_target_variant_asin)
    ? default_target_variant_asin.trim().toUpperCase()
    : null;
  const judgeTargetAsin = nonemptyStr(review_judge?.target_variant_asin)
    ? review_judge.target_variant_asin.trim().toUpperCase()
    : null;
  const targetReviewAsin = frozenTargetAsin ?? judgeTargetAsin;

  const frozenTargetSku = nonemptyStr(spec_verification?.target_variant_sku)
    ? spec_verification.target_variant_sku.trim()
    : (nonemptyStr(default_target_variant_sku) ? default_target_variant_sku.trim() : null);
  const judgeTargetSku = nonemptyStr(review_judge?.target_variant_sku)
    ? review_judge.target_variant_sku.trim()
    : null;
  const targetReviewSku = frozenTargetSku ?? judgeTargetSku;

  const explicitTaskTargetMismatch =
    Boolean(frozenTargetAsin && judgeTargetAsin && frozenTargetAsin !== judgeTargetAsin) ||
    Boolean(frozenTargetSku && judgeTargetSku && frozenTargetSku.toLowerCase() !== judgeTargetSku.toLowerCase());

  const hasSkuVerifiedReview = !explicitTaskTargetMismatch &&
    Array.isArray(review_judge?.review_citations) &&
    review_judge.review_citations.some(
      c =>
        c?.sku_verified === true &&
        (!targetReviewAsin || !nonemptyStr(c?.asin) || c.asin.trim().toUpperCase() === targetReviewAsin) &&
        (!targetReviewSku || (nonemptyStr(c?.variant_sku) && c.variant_sku.trim().toLowerCase() === targetReviewSku.toLowerCase())),
    );
  const hasConflictingSkuReview = explicitTaskTargetMismatch || (
    Array.isArray(review_judge?.review_citations) &&
    review_judge.review_citations.length > 0 &&
    !hasSkuVerifiedReview &&
    review_judge.review_citations.some(c =>
      (targetReviewAsin && nonemptyStr(c?.asin) && c.asin.trim().toUpperCase() !== targetReviewAsin) ||
      (targetReviewSku && nonemptyStr(c?.variant_sku) && c.variant_sku.trim().toLowerCase() !== targetReviewSku.toLowerCase()),
    )
  );
  const reviewsInspected = Boolean(
    review_judge &&
    review_judge.reviews_inspected !== false &&
    ['supported', 'not_supported', 'no_actionable_flaw', 'inspected_none'].includes(review_judge.status),
  );
  const deferLightDiffToSample = Boolean(
    review_judge?.sample_check_required === true || review_judge?.defer_to_sample === true,
  );
  const supportLevel = typeof review_judge?.support_level === 'string'
    ? review_judge.support_level.trim().toLowerCase()
    : null;
  const isStrongSupported = reviewsInspected && review_judge?.status === 'supported' && hasSkuVerifiedReview &&
    (supportLevel === 'strong' || (supportLevel === null && review_judge?.proposed_score === 1));
  const isModerateSupported = reviewsInspected && review_judge?.status === 'supported' && hasSkuVerifiedReview &&
    (supportLevel === 'moderate' || (supportLevel === null && review_judge?.proposed_score === 0.5));
  const preservedCitationMeta = {
    reviews_inspected: reviewsInspected,
    ...(targetReviewAsin ? { target_variant_asin: targetReviewAsin } : {}),
    ...(targetReviewSku ? { target_variant_sku: targetReviewSku } : {}),
    ...(Array.isArray(review_judge?.review_citations) ? { review_citations: structuredClone(review_judge.review_citations) } : {}),
  };

  if (isStrongSupported) {
    lightDiff = {
      anchor: 1,
      ...preservedCitationMeta,
      reason: review_judge.reason || '已验证子体差评痛点可通过低成本现货微改明确解决（strong -> 1/1）。',
      evidence,
    };
  } else if (isModerateSupported) {
    lightDiff = {
      anchor: 0.5,
      ...preservedCitationMeta,
      reason: review_judge.reason || '已验证子体差评存在部分可低成本微改空间（moderate -> 0.5/1）。',
      evidence,
    };
  } else if (reviewsInspected && !hasConflictingSkuReview && (
    review_judge?.status !== 'supported' ||
    supportLevel === 'weak' ||
    supportLevel === 'none' ||
    review_judge?.proposed_score === 0
  )) {
    lightDiff = {
      anchor: 0,
      ...preservedCitationMeta,
      reason: review_judge.reason || '已抽检子体差评，现成公模现货无需额外改模或未见低成本可微改痛点，记 0/1。',
      evidence,
    };
  } else {
    lightDiff = {
      anchor: null,
      ...(review_judge ? preservedCitationMeta : {}),
      ...(deferLightDiffToSample ? { sample_check_required: true } : {}),
      reason: hasConflictingSkuReview
        ? '差评引文归属子体 ASIN／variant_sku 与当前目标规格冲突，保持待定 null 待重新核验对应子体评论。'
        : (review_judge?.reason || '尚未完成 Gate 1B 后子体差评抽检（未查差评须保持待定 null，不得默认记 0）。'),
      evidence,
    };
  }

  const PRESCREEN_ACCESS_FAILURE_RE = /(?:registry\s+unavailable|access\s+failed|connection\s+failed|unreachable|search\s+(?:failed|unavailable|not\s+completed|incomplete)|not\s+yet\s+searched|(?:further|additional)\s+(?:register|registry|official)\s+search|(?:listed\s+goods|goods\s+coverage)[^\r\n]{0,40}require\s+(?:follow[- ]?up|further\s+search)|http\s+[45]\d\d|\b(?:429|500|502|503|504)\b|rate[- ]?limit\w*|too\s+many\s+requests|quota\s*exceeded|throttl\w*|could\s+not\s+(?:access|reach|query|search|verify)|timeout|(?:查询|检索|公开初筛|初查)?未完成|尚未检索|未检索|未返回|须补查|待补查|进一步检索|状态未知|连接失败|访问失败|检索失败|返回\s*(?:429|5\d\d)|限流|频率限制|请求过多|稍后重试|无法(?:访问|连接|查询|查验|核实)|未能(?:查验|查询|访问|检索)|查询失败|暂[时]?不可用|登记库.*不可用|超时)/i;
  const NON_ENFORCEABLE_RIGHTS_TEXT_RE = /\b(?:expired|abandoned|lapsed|invalidated|inactive)\b|(?:已过期|已失效|权利终止|放弃专利)/i;
  const UNKNOWN_RIGHTS_SCOPE_RE = /\b(?:unknown|unclear|unverified|possible\s+match|may\s+match)\b|(?:未知|未明|待核|可能命中|尚未核实)/i;
  const isPrescreenCompletedCleanly = sec => {
    if (!sec || sec.prescreen_completed === false || sec.registry_unavailable === true) return false;
    if (sec.status !== 'no_public_hit_observed' && sec.status !== 'needs_sample_comparison' && sec.status !== 'needs_verification') {
      return false;
    }
    const summaryText = String(sec.summary ?? '');
    if (PRESCREEN_ACCESS_FAILURE_RE.test(summaryText)) return false;
    const noCitations = !Array.isArray(sec.citations) || sec.citations.length === 0;
    if (noCitations && sec.status === 'needs_verification' &&
      /(?:failed|unavailable|unreachable|incomplete|error|timeout|retry|429|5\d\d|失败|不可用|未完成|无法|未能|重试|限流)/i.test(summaryText)) {
      return false;
    }
    return true;
  };

  // #20 specific_design_rights (0..3) (+ target-spec trademark conflict & completion check)
  let specificRights;
  const sdrSec = rights_prescreen?.specific_design_rights;
  const tmSec = rights_prescreen?.trademark_conflicts;
  const sdrStatus = sdrSec?.status ?? 'unknown';
  const tmClean = !tmSec || isPrescreenCompletedCleanly(tmSec);
  const tmNeedsSampleOrVerification = Boolean(
    tmSec && (tmSec.status === 'needs_verification' || tmSec.status === 'needs_sample_comparison'),
  );
  const sectionHasEnforceableTargetHit = sec => {
    if (!sec || sec.applies_to_target_spec === false) return false;
    if (sec.legal_status === 'expired' || sec.legal_status === 'abandoned') return false;
    const secSummary = String(sec.summary ?? '');
    if (Array.isArray(sec.citations) && sec.citations.length > 0) {
      return sec.citations.some(c => {
        if (c?.applies_to_target_spec === false || c?.legal_status === 'expired' || c?.legal_status === 'abandoned') {
          return false;
        }
        if (c && typeof c === 'object' && ('applies_to_target_spec' in c || 'legal_status' in c)) {
          return c.applies_to_target_spec === true && (c.legal_status === 'active' || c.legal_status === 'reexamination');
        }
        const combinedText = `${String(c?.title ?? '')} ${secSummary}`;
        return !NON_ENFORCEABLE_RIGHTS_TEXT_RE.test(combinedText) && !UNKNOWN_RIGHTS_SCOPE_RE.test(combinedText);
      });
    }
    if (NON_ENFORCEABLE_RIGHTS_TEXT_RE.test(secSummary) && sec.legal_status !== 'active') {
      return false;
    }
    return !UNKNOWN_RIGHTS_SCOPE_RE.test(secSummary);
  };
  const sdrProvenTargetConflict = Boolean(
    sdrStatus === 'proven_conflict' && sectionHasEnforceableTargetHit(sdrSec),
  );
  const tmProvenTargetConflict = Boolean(
    tmSec?.status === 'proven_conflict' && sectionHasEnforceableTargetHit(tmSec),
  );
  if (sdrProvenTargetConflict || tmProvenTargetConflict) {
    specificRights = {
      anchor: 0,
      proven_conflict: true,
      applies_to_target_spec: true,
      legal_status: sdrProvenTargetConflict ? (sdrSec?.legal_status ?? 'active') : (tmSec?.legal_status ?? 'active'),
      reason: sdrProvenTargetConflict
        ? (sdrSec.summary || '公开专利检索命中具体外观／结构冲突，直接一票否决。')
        : (tmSec.summary || '公开商标检索命中目标规格／词条冲突，直接一票否决。'),
      evidence,
    };
  } else if (sdrStatus === 'no_public_hit_observed' && isPrescreenCompletedCleanly(sdrSec) && tmClean && !tmNeedsSampleOrVerification) {
    objectiveTags.push('留存后二阶段实物细节专利复核');
    if (finite(market_seller_count) && market_seller_count >= 1 && market_seller_count <= 3 &&
      finite(reference_price_usd) && reference_price_usd >= 45) {
      objectiveTags.push('寡头高利·二阶段专利预警');
    }
    specificRights = {
      anchor: 3,
      prescreen_completed: true,
      reason: `${sdrSec.summary || '有界公开专利初查未见同结构冲突。'}（初筛记 3/3，留存后复核实物细节权利要求）。`,
      evidence,
    };
  } else if (
    (sdrStatus === 'needs_sample_comparison' || sdrStatus === 'needs_verification' || (sdrStatus === 'no_public_hit_observed' && tmNeedsSampleOrVerification)) &&
    isPrescreenCompletedCleanly(sdrSec) &&
    tmClean
  ) {
    objectiveTags.push('留存后拿样比对近似专利结构细节');
    specificRights = {
      anchor: null,
      prescreen_completed: true,
      sample_check_required: true,
      reason: tmNeedsSampleOrVerification && sdrStatus === 'no_public_hit_observed'
        ? (tmSec?.summary || '公开商标检索存在待人工／拿样核对项。')
        : (sdrSec?.summary || '公开专利初筛无实锤侵权冲突；1–2 件近似专利号待拿样与实物结构比对。'),
      evidence,
    };
  } else {
    specificRights = {
      anchor: null,
      prescreen_completed: false,
      ...(!tmClean || !isPrescreenCompletedCleanly(sdrSec) ? { registry_unavailable: true } : {}),
      reason: !tmClean
        ? (tmSec?.summary || '公开商标登记库查询未完成，保持待定。')
        : (sdrSec?.summary || '具体款式公开专利初查尚未完成或存在待排冲突。'),
      evidence,
    };
  }

  // #21 applicable_public_requirements (0..2): needs_verification MUST remain null (never 2/2 or 1/2)
  let publicReq;
  const apr = rights_prescreen?.applicable_public_requirements;
  const fws = Array.isArray(apr?.frameworks_checked)
    ? apr.frameworks_checked.filter(fw => nonemptyStr(fw) && fw !== 'NONE_IDENTIFIED')
    : [];
  if (apr?.status === 'proven_conflict' && sectionHasEnforceableTargetHit(apr)) {
    publicReq = {
      anchor: 0,
      proven_conflict: true,
      hard_ban: true,
      reason: apr.summary || '命中强制禁售或个人卖家不可行的准入限制。',
      evidence,
    };
  } else if (apr?.status === 'needs_verification' && isPrescreenCompletedCleanly(apr)) {
    for (const fw of fws) objectiveTags.push(`合规路径标签:${fw}`);
    publicReq = {
      anchor: null,
      prescreen_completed: true,
      sample_check_required: true,
      reason: apr.summary || '公开合规初筛无禁售冲突；具体材料申报／检测细节（如木头拉丁学名）待拿样问工厂核实。',
      evidence,
    };
  } else if (apr?.status === 'no_public_hit_observed' && isPrescreenCompletedCleanly(apr)) {
    const nonRoutineOnly = fws.length === 0;
    if (!nonRoutineOnly) {
      for (const fw of fws) objectiveTags.push(`合规路径标签:${fw}`);
    }
    publicReq = {
      anchor: nonRoutineOnly ? 2 : 1,
      prescreen_completed: true,
      reason: nonRoutineOnly
        ? (apr.summary || '普通非带电非食品现货，初查无特殊法规认证门槛。')
        : `${apr.summary || '识别到适用常规合规路径（如 Lacey Act / 16 CFR 1262 / TSCA / 食品接触检测）且可常规办理。'}（初筛记 1/2 并挂合规标签）。`,
      evidence,
    };
  } else {
    publicReq = {
      anchor: null,
      prescreen_completed: false,
      reason: apr?.summary || '尚未完成适用公共法规与类目准入路径初查。',
      evidence,
    };
  }

  return {
    judgments: {
      existing_solution_fit: existingSolutionFit,
      feasible_light_differentiation: lightDiff,
      specific_design_rights: specificRights,
      applicable_public_requirements: publicReq,
    },
    objective_tags: [...new Set(objectiveTags)],
  };
}

/**
 * Build paired 2027 `off_peak` + companion `peak` operating periods from verified off-peak ledgers:
 *  - Defaults under `r59+` to the unified 2027 off-peak fulfillment window (`2027-02-01` through `2027-10-14`),
 *    while keeping off-peak monthly storage independently at `2027-02-01..2027-09-30` (`[2..9]`) and companion
 *    peak monthly storage at `2027-10-01..2027-12-31` (`[10..12]`), never mixing Oct 1–14 into Jan–Sep storage!
 *  - Preserves `r58` `2027-02-01..2027-09-30` (`[2..9]`) replay when `profile_revision < 59` or `off_peak_window` is explicitly set.
 *  - Keeps `expected_primary_scenarios` strictly period-scoped (NEVER placed on root `economics` where off-peak IDs would break `peak`!).
 *  - Leaves 2027 Q4 peak margin blank (`null`) with explicit `UNPUBLISHED_2027_PEAK_MARGIN_NOTE` (`"待亚马逊公布 2027 旺季费率后补充"`),
 *    forbidding 2026 peak uplift extrapolation.
 *  - Enforces strict uniqueness on `stress_scenarios[].id`.
 */
export function buildPairedSeasonalOperatingPeriods({
  saleable_unit,
  off_peak_scenarios,
  declared_off_peak_scenario_ids = null,
  required_quote_ids = null,
  required_prices_usd = null,
  strict_declared_completeness = true,
  cubic_feet_per_unit,
  average_inventory_days = 45,
  size_tier = 'large_standard',
  is_dangerous_goods = false,
  storage_evidence = [],
  stress_scenarios = undefined,
  profile_revision = 59,
  off_peak_window = null,
} = {}) {
  if (!nonemptyStr(saleable_unit)) throw new TypeError('saleable_unit is required.');
  if (!Array.isArray(off_peak_scenarios) || off_peak_scenarios.length === 0) {
    throw new TypeError('off_peak_scenarios must be a nonempty array.');
  }
  if (!finite(cubic_feet_per_unit) || cubic_feet_per_unit <= 0) {
    throw new TypeError('cubic_feet_per_unit must be a positive finite number.');
  }

  if (Array.isArray(stress_scenarios)) {
    const seenStress = new Set();
    for (const st of stress_scenarios) {
      if (!nonemptyStr(st?.id)) throw new TypeError('Every stress_scenarios entry requires a nonempty id.');
      const sid = st.id.trim();
      if (seenStress.has(sid)) {
        throw new TypeError(`Duplicate stress_scenarios id "${sid}" is prohibited.`);
      }
      seenStress.add(sid);
    }
  }

  const useLegacyR58Window = Boolean(
    (profile_revision ?? 59) < 59 ||
    (off_peak_window && off_peak_window.from === '2027-02-01' && off_peak_window.through === '2027-09-30'),
  );
  const activeOffPeakSalesWin = useLegacyR58Window
    ? { from: '2027-02-01', through: '2027-09-30' }
    : (off_peak_window ?? FBA_2027_DEFAULT_OFF_PEAK_WINDOW);
  const activeOffPeakStorageWin = { ...FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW };
  const activeOffPeakMonths = [2, 3, 4, 5, 6, 7, 8, 9];

  const isBulkyOrOversize = /(?:bulky|oversize)/i.test(String(size_tier || ''));
  const peakStorageRate = is_dangerous_goods
    ? (isBulkyOrOversize ? 2.43 : 3.63)
    : (isBulkyOrOversize ? 1.40 : 2.40);
  const peakStorageUsd = Number((cubic_feet_per_unit * peakStorageRate * (average_inventory_days / 30)).toFixed(6));

  const normalizedOffPeak = off_peak_scenarios.map(sc => {
    const clone = structuredClone(sc);
    clone.cost_ledger.fee_context.sales = { ...activeOffPeakSalesWin };
    clone.cost_ledger.fee_context.storage = { ...activeOffPeakStorageWin };
    if (!clone.cost_ledger.fee_context.inbound || clone.cost_ledger.fee_context.inbound.from < '2027-01-15') {
      clone.cost_ledger.fee_context.inbound = { ...FBA_2027_DEFAULT_INBOUND_WINDOW };
    }
    if (!useLegacyR58Window && Array.isArray(clone.cost_ledger.lines)) {
      for (const l of clone.cost_ledger.lines) {
        if (l?.fee_basis && typeof l.fee_basis === 'object') {
          if (l.id === 'storage') {
            if (l.fee_basis.effective_through && l.fee_basis.effective_through > '2027-09-30') {
              l.fee_basis.effective_through = '2027-09-30';
            }
            if (Array.isArray(l.fee_basis.months)) {
              l.fee_basis.months = l.fee_basis.months.filter(m => m <= 9);
            }
          } else {
            if (Array.isArray(l.fee_basis.months)) {
              const allowedMaxMonth = l.fee_basis.effective_through
                ? Number(l.fee_basis.effective_through.slice(5, 7))
                : 10;
              l.fee_basis.months = l.fee_basis.months.filter(m => m <= Math.min(10, allowedMaxMonth));
            }
          }
        }
      }
    }
    return clone;
  });

  const suppliedOffPeakIds = new Set(normalizedOffPeak.map(s => String(s?.id || '').trim()).filter(Boolean));
  let offPeakExpectedPrimary;
  if (Array.isArray(declared_off_peak_scenario_ids) && declared_off_peak_scenario_ids.length > 0) {
    offPeakExpectedPrimary = declared_off_peak_scenario_ids.map(item =>
      typeof item === 'string' ? { id: item.trim(), status: 'active' } : structuredClone(item),
    );
    const missingDeclared = offPeakExpectedPrimary
      .filter(exp => exp?.status !== 'cancelled' && nonemptyStr(exp?.id) && !suppliedOffPeakIds.has(exp.id.trim()))
      .map(exp => exp.id.trim());
    if (strict_declared_completeness && missingDeclared.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted active declared off-peak scenario(s) [${missingDeclared.join(', ')}].`,
      );
    }
  } else {
    offPeakExpectedPrimary = normalizedOffPeak.map(s => ({ id: s.id, status: 'active' }));
  }

  const resolveScenarioPriceForMatrix = sc => {
    const ledger = sc?.cost_ledger ?? {};
    const eff = resolveEffectivePricing(ledger);
    if (eff.valid && finite(eff.net_effective_price_usd)) return round2(eff.net_effective_price_usd);
    if (finite(ledger.price_usd)) return round2(ledger.price_usd);
    if (finite(sc?.price_anchor?.value)) return round2(sc.price_anchor.value);
    return null;
  };

  const implicitQuotesInScenarios = [...new Set(
    normalizedOffPeak
      .map(s => s?.quote_id ?? s?.cost_ledger?.source_inputs?.quote_id ?? null)
      .filter(nonemptyStr)
      .map(q => q.trim()),
  )];
  const normReqQuotes = Array.isArray(required_quote_ids) && required_quote_ids.length > 0
    ? [...new Set(required_quote_ids.filter(nonemptyStr).map(q => q.trim()))]
    : implicitQuotesInScenarios;

  const explicitReqPrices = Array.isArray(required_prices_usd)
    ? [...new Set(required_prices_usd.filter(finite).map(round2))]
    : [];
  const observedOffPeakPrices = [...new Set(normalizedOffPeak.map(resolveScenarioPriceForMatrix).filter(finite))];
  if (strict_declared_completeness && explicitReqPrices.length > 0) {
    const missingPrices = explicitReqPrices.filter(rp => !observedOffPeakPrices.some(op => Math.abs(op - rp) <= 0.02));
    if (missingPrices.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted declared Gate 1A off-peak price(s) [${missingPrices.map(p => `$${p.toFixed(2)}`).join(', ')}].`,
      );
    }
  }

  if (normReqQuotes.length > 1) {
    const missingQuotes = normReqQuotes.filter(qid => !implicitQuotesInScenarios.includes(qid));
    if (missingQuotes.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted required Gate 1B quote_id(s) [${missingQuotes.join(', ')}] in off_peak_scenarios.`,
      );
    }
    // Enforce full Cartesian product (price / base_scenario_id × quote_id) so a diagonal 2-cell submission cannot hide a losing (price × factory) cell!
    const distinctPrices = [...new Set([...explicitReqPrices, ...observedOffPeakPrices])];
    const presentPriceQuoteCells = new Set();
    for (const s of normalizedOffPeak) {
      const qid = (s?.quote_id ?? s?.cost_ledger?.source_inputs?.quote_id ?? '').trim();
      const pr = resolveScenarioPriceForMatrix(s);
      if (!qid) {
        throw new TypeError(
          `buildPairedSeasonalOperatingPeriods scenario "${s?.id ?? 'unknown'}" must specify an explicit quote_id when multiple quotes (${normReqQuotes.join(', ')}) participate.`,
        );
      }
      if (pr !== null) presentPriceQuoteCells.add(`${pr.toFixed(2)}::${qid}`);
    }
    const missingCells = [];
    for (const pr of distinctPrices) {
      for (const qid of normReqQuotes) {
        if (!presentPriceQuoteCells.has(`${pr.toFixed(2)}::${qid}`)) {
          missingCells.push(`$${pr.toFixed(2)}×${qid}`);
        }
      }
    }
    if (strict_declared_completeness && missingCells.length > 0) {
      throw new TypeError(
        `buildPairedSeasonalOperatingPeriods omitted Cartesian (price × quote_id) cell(s) [${missingCells.join(', ')}]; diagonal subset submissions are prohibited.`,
      );
    }
  }

  const peakScenarios = normalizedOffPeak.map(offSc => {
    const pk = structuredClone(offSc);
    delete pk.margin;
    delete pk.contribution_usd;
    if (!useLegacyR58Window) {
      pk.unpublished_peak_note = UNPUBLISHED_2027_PEAK_MARGIN_NOTE;
    }
    const pkId = `${offSc.id}-peak`;
    pk.id = pkId;
    pk.label = useLegacyR58Window
      ? `${offSc.label ?? offSc.id}（10–12月旺季伴随面板）`
      : `${offSc.label ?? offSc.id}（${UNPUBLISHED_2027_PEAK_MARGIN_NOTE}）`;
    pk.cost_ledger.id = pkId;
    pk.cost_ledger.fee_context.sales = useLegacyR58Window
      ? { from: '2027-10-01', through: '2027-12-31' }
      : { ...FBA_2027_UNPUBLISHED_PEAK_WINDOW };
    pk.cost_ledger.fee_context.storage = { ...FBA_2027_COMPANION_PEAK_STORAGE_WINDOW };
    pk.cost_ledger.fee_context.inbound = useLegacyR58Window
      ? { from: '2027-09-01', through: '2027-10-01' }
      : { from: '2027-09-15', through: '2027-10-15' };
    if (!useLegacyR58Window) {
      for (const l of pk.cost_ledger.lines ?? []) {
        if (l?.fee_basis && typeof l.fee_basis === 'object' && l.id !== 'fulfillment' && l.id !== 'storage') {
          if (l.fee_basis.effective_through === '2027-12-31') {
            l.fee_basis.effective_through = '2028-01-14';
          }
          const basisCoversPeak = !l.fee_basis.effective_through || l.fee_basis.effective_through >= '2027-12-31';
          if (Array.isArray(l.fee_basis.months) && basisCoversPeak && l.fee_basis.months.includes(10)) {
            l.fee_basis.months = [10, 11, 12, 1];
          }
        }
      }
    }

    const fulLine = pk.cost_ledger.lines.find(l => l?.id === 'fulfillment');
    if (fulLine) {
      fulLine.status = 'pending';
      fulLine.amount_usd = null;
      fulLine.basis = useLegacyR58Window
        ? 'Amazon 2027 US Holiday Peak FBA fulfillment schedule not yet published; held pending per seasonal companion rule.'
        : `${UNPUBLISHED_2027_PEAK_MARGIN_NOTE}（严禁用 2026 旺季涨幅估算替代）`;
      fulLine.fee_basis = {
        status: 'unavailable',
        version: 'Unpublished 2027 US Holiday Peak FBA fulfillment schedule',
        marketplace: 'US',
        currency: 'USD',
        package_ref: pk.cost_ledger.fee_context.package_ref,
        year: 2027,
        months: useLegacyR58Window ? [10, 11, 12] : [10, 11, 12, 1],
      };
    }

    const storLine = pk.cost_ledger.lines.find(l => l?.id === 'storage');
    if (storLine) {
      storLine.status = 'sourced';
      storLine.amount_usd = peakStorageUsd;
      storLine.basis = `2027 Oct–Dec unified peak storage $${peakStorageRate.toFixed(2)}/cu ft (${cubic_feet_per_unit.toFixed(4)} cu ft × ${average_inventory_days}d/30)`;
      if (Array.isArray(storage_evidence) && storage_evidence.length > 0) {
        storLine.evidence = storage_evidence;
      }
      if (storLine.fee_basis && typeof storLine.fee_basis === 'object') {
        storLine.fee_basis = {
          ...storLine.fee_basis,
          status: 'published',
          rate_usd_per_cuft_month: peakStorageRate,
          cubic_feet_per_unit,
          average_inventory_days,
          effective_from: '2027-10-01',
          effective_through: '2027-12-31',
          months: [10, 11, 12],
        };
      }
    }

    const colLine = pk.cost_ledger.lines.find(l => l?.id === 'collection');
    if (colLine) {
      colLine.status = 'pending';
      colLine.amount_usd = null;
      colLine.basis = 'Collection fee depends on Amazon payout after 2027 holiday peak fulfillment deduction; held pending alongside fulfillment.';
    }

    return pk;
  });

  const peakExpectedPrimary = offPeakExpectedPrimary.map(exp => ({
    ...exp,
    id: `${exp.id}-peak`,
  }));

  return {
    saleable_unit,
    ...(Array.isArray(stress_scenarios) && stress_scenarios.length > 0 ? { stress_scenarios } : {}),
    operating_periods: [
      {
        id: 'off_peak',
        label: useLegacyR58Window ? '2027年2–9月主营淡季' : '2027年2月1日–10月14日主营淡季',
        months: activeOffPeakMonths,
        expected_primary_scenarios: offPeakExpectedPrimary,
        scenarios: normalizedOffPeak,
      },
      {
        id: 'peak',
        label: useLegacyR58Window ? '2027年10–12月假日旺季' : `2027年Q4旺季（${UNPUBLISHED_2027_PEAK_MARGIN_NOTE}）`,
        months: useLegacyR58Window ? [10, 11, 12] : [10, 11, 12, 1],
        ...(!useLegacyR58Window ? { unpublished_peak_note: UNPUBLISHED_2027_PEAK_MARGIN_NOTE } : {}),
        expected_primary_scenarios: peakExpectedPrimary,
        scenarios: peakScenarios,
      },
    ],
  };
}

export function buildEvergreen2027OffPeakEconomics({
  saleable_unit,
  off_peak_scenarios = null,
  scenarios = null,
  declared_off_peak_scenario_ids = null,
  required_quote_ids = null,
  required_prices_usd = null,
  strict_declared_completeness = true,
  cubic_feet_per_unit = 0.1,
  average_inventory_days = 45,
  size_tier = 'large_standard',
  is_dangerous_goods = false,
  stress_scenarios = undefined,
  profile_revision = 59,
  off_peak_window = null,
  unpublished_2027_q4_peak_note = '2027 Q4 旺季费率待亚马逊公布',
} = {}) {
  const inputScenarios = Array.isArray(off_peak_scenarios) ? off_peak_scenarios : scenarios;
  const paired = buildPairedSeasonalOperatingPeriods({
    saleable_unit,
    off_peak_scenarios: inputScenarios,
    declared_off_peak_scenario_ids,
    required_quote_ids,
    required_prices_usd,
    strict_declared_completeness,
    cubic_feet_per_unit: finite(cubic_feet_per_unit) && cubic_feet_per_unit > 0 ? cubic_feet_per_unit : 0.1,
    average_inventory_days,
    size_tier,
    is_dangerous_goods,
    stress_scenarios,
    profile_revision,
    off_peak_window,
  });
  const offPeakPeriod = paired.operating_periods.find(p => p.id === 'off_peak') ?? paired.operating_periods[0];
  return {
    saleable_unit: paired.saleable_unit,
    product_seasonality: 'evergreen',
    unpublished_2027_q4_peak_note,
    expected_primary_scenarios: offPeakPeriod.expected_primary_scenarios,
    scenarios: offPeakPeriod.scenarios,
    ...(Array.isArray(paired.stress_scenarios) && paired.stress_scenarios.length > 0
      ? { stress_scenarios: paired.stress_scenarios }
      : {}),
  };
}

export function extractKeepaFactsByAsinFromPayloads(rawPayloads = [], { asOfDate = null } = {}) {
  const byAsin = new Map();
  const considerNode = (node) => {
    if (!node || typeof node !== 'object' || hasEnvelopeFailureMarkers(node)) return;
    const looksKeepa = Boolean(
      node.keepa_trend ||
      node.keepa ||
      node.series ||
      node.pkgDimensionsSize !== undefined ||
      node.pkgWeightGram !== undefined,
    );
    if (!looksKeepa) return;
    const parsed = parseSellerSpriteKeepaPayload(node, { as_of_date: asOfDate });
    if (!parsed?.ok || !nonemptyStr(parsed.asin)) return;
    const prev = byAsin.get(parsed.asin);
    // Prefer full timestamped curves over undated curves, and curves over package-only snapshots.
    const rank = p => (p.status === 'parsed' ? (p.has_timestamps ? 3 : 2) : 1);
    if (!prev || rank(parsed) >= rank(prev)) {
      byAsin.set(parsed.asin, parsed);
    }
  };
  for (const entry of rawPayloads) {
    const raw = entry?.payload ?? entry;
    if (isFailedOrEmptyRawReceipt(raw)) continue;
    const unwrapped = unwrapMcpEnvelope(raw);
    if (!unwrapped || typeof unwrapped !== 'object' || isFailedUnwrappedBody(unwrapped)) continue;
    considerNode(unwrapped);
    if (unwrapped.data && typeof unwrapped.data === 'object') considerNode(unwrapped.data);
    const items = Array.isArray(unwrapped.items)
      ? unwrapped.items
      : (Array.isArray(unwrapped.data?.items) ? unwrapped.data.items : null);
    if (items) {
      for (const it of items) considerNode(it);
    }
  }
  return byAsin;
}

export function mergeKeepaReceiptIntoListingRow(row, parsedKeepa) {
  if (!row || typeof row !== 'object' || !parsedKeepa?.ok) return row;
  const merged = { ...row };
  if (parsedKeepa.status === 'package_snapshot_only') {
    merged.keepa_package_only = true;
    merged.keepa_peer_facts = buildKeepaPeerFactsForMarketJudge(parsedKeepa);
  } else if (parsedKeepa.status === 'parsed') {
    if (merged.keepa_90d_steady === undefined) {
      merged.keepa_90d_steady = parsedKeepa.keepa_90d_steady;
    }
    if (merged.keepa_price_steady === undefined) {
      merged.keepa_price_steady = parsedKeepa.keepa_90d_steady;
    }
    if (merged.sustained_drop_or_clearance_watch === undefined && parsedKeepa.sustained_drop_or_clearance_watch === true) {
      merged.sustained_drop_or_clearance_watch = true;
    }
    if (parsedKeepa.has_timestamps && finite(parsedKeepa.keepa_90d_median_usd) && merged.keepa_90d_median_usd === undefined) {
      merged.keepa_90d_median_usd = parsedKeepa.keepa_90d_median_usd;
    }
    const hasExplicitRowCoupon =
      merged.ongoing_coupon_pct !== undefined ||
      merged.coupon_pct !== undefined ||
      merged.ongoing_coupon_usd !== undefined ||
      merged.coupon_usd !== undefined ||
      merged.coupon !== undefined ||
      merged.net_effective_price_usd !== undefined ||
      merged.net_price_usd !== undefined;
    if (!hasExplicitRowCoupon && finite(parsedKeepa.latest_coupon_fraction) && parsedKeepa.latest_coupon_fraction > 0 && parsedKeepa.latest_coupon_fraction < 1) {
      merged.ongoing_coupon_pct = parsedKeepa.latest_coupon_fraction;
    }
    merged.keepa_peer_facts = buildKeepaPeerFactsForMarketJudge(parsedKeepa);
  }
  if (!merged.pkg && parsedKeepa.package_snapshot?.length_in && parsedKeepa.package_snapshot?.width_in && parsedKeepa.package_snapshot?.height_in) {
    merged.pkg = { ...parsedKeepa.package_snapshot };
  }
  return merged;
}

export function mergeKeepaPayloadsIntoPeerListings(listings = [], rawPayloads = [], { as_of_date = null } = {}) {
  if (!Array.isArray(listings) || listings.length === 0) return [];
  const keepaByAsin = extractKeepaFactsByAsinFromPayloads(rawPayloads, { asOfDate: as_of_date });
  if (keepaByAsin.size === 0) return listings.map(r => ({ ...r }));
  return listings.map(row => {
    const asin = typeof row?.asin === 'string' && row.asin.trim() ? row.asin.trim().toUpperCase() : null;
    const k = asin ? keepaByAsin.get(asin) : null;
    return k ? mergeKeepaReceiptIntoListingRow(row, k) : { ...row };
  });
}

function extractQuantileSupportedPricesFromPayloads(candPayloads = [], {
  asOfDate = null,
  excludedAsins = new Set(),
  targetCategoryRoots = new Set(),
  strictMatureOnly = false,
} = {}) {
  const quantilePrices = new Set();
  const mainstreamMedians = [];
  const rowFloorPrices = [];
  const keepaByAsin = extractKeepaFactsByAsinFromPayloads(candPayloads, { asOfDate });
  for (const entry of candPayloads) {
    const raw = entry?.payload ?? entry;
    if (isFailedOrEmptyRawReceipt(raw)) continue;
    const unwrapped = unwrapMcpEnvelope(raw);
    if (isFailedUnwrappedBody(unwrapped)) continue;
    const rawItems = Array.isArray(unwrapped?.items) ? unwrapped.items : null;
    if (!rawItems || rawItems.length < 2) continue;

    let items = rawItems
      .filter(it => {
        if (!it || typeof it !== 'object' || hasEnvelopeFailureMarkers(it)) return false;
        const a = typeof it.asin === 'string' ? it.asin.trim().toUpperCase() : '';
        return !(a && excludedAsins.has(a));
      })
      .map(it => {
        const a = typeof it.asin === 'string' ? it.asin.trim().toUpperCase() : '';
        const k = a ? keepaByAsin.get(a) : null;
        return k ? mergeKeepaReceiptIntoListingRow(it, k) : it;
      });
    if (items.length < 2) continue;

    // Record low-end page price even on 2-row pages so 2-row ($39.99 + $289.99) bundle hijacking cannot evade median checks.
    for (const it of items) {
      const p = finite(it.price_usd) ? it.price_usd : (finite(it.price) ? it.price : null);
      if (p !== null && p > 0) rowFloorPrices.push(p);
    }

    // Never derive search-page quantiles from heterogeneous cross-category detail batches (e.g. 13-ss-asin-detail-cats.json)!
    const distinctRowCats = new Set(items.map(extractItemCategoryRoot).filter(Boolean));
    if (distinctRowCats.size > 1) {
      if (targetCategoryRoots.size > 0) {
        items = items.filter(it => {
          const c = extractItemCategoryRoot(it);
          return c && targetCategoryRoots.has(c);
        });
      } else {
        continue;
      }
    }
    const hasSalesCensus = items.some(it => finite(it?.monthlySales) || finite(it?.units_30d) || finite(it?.sales));
    if (distinctRowCats.size > 1 && !hasSalesCensus) continue;
    if (items.length < 2) continue;

    const strictModes = strictMatureOnly ? [true] : [false, true];
    for (const strictOpt of strictModes) {
      try {
        const bandRes = analyzeMainstreamPriceBand(items, {
          ...(asOfDate ? { as_of_date: asOfDate } : {}),
          strict_mature_only: strictOpt,
        });
        const hasAnyLaunchAge = items.some(it => nonemptyStr(it?.availableDate ?? it?.available_date ?? it?.launch_date) || finite(it?.age_days));
        const candidateBands = strictOpt && hasAnyLaunchAge
          ? [bandRes?.mature_regular_band]
          : [bandRes?.band, bandRes?.mature_regular_band, bandRes?.regular_band_reference];
        for (const b of candidateBands) {
          if (finite(b?.p50_usd) && b.p50_usd > 0 && items.length >= 2) {
            mainstreamMedians.push(b.p50_usd);
          }
          // Only denoised P25/P50/P75 quantiles qualify as derived band anchors — NEVER raw min_usd/max_usd outliers!
          for (const val of [b?.p25_usd, b?.p50_usd, b?.p75_usd]) {
            if (finite(val) && val > 0) quantilePrices.add(round2(val));
          }
        }
      } catch { /* ignore non-listing item arrays */ }
    }
  }
  return { quantilePrices, mainstreamMedians, rowFloorPrices };
}

const EXCLUDED_VERDICTS = new Set(['excluded_different_task', 'mismatch', 'non_comparable', 'excluded']);

function collectExcludedDifferentTaskAsins(cand) {
  const excluded = new Set();
  const addExcl = val => {
    if (nonemptyStr(val)) {
      const up = val.trim().toUpperCase();
      if (ASIN_EXACT_RE.test(up)) excluded.add(up);
    }
  };
  for (const m of cand?.newcomer_cohort?.members ?? []) {
    if (EXCLUDED_VERDICTS.has(m?.comparability_verdict)) addExcl(m?.asin);
  }
  for (const f of cand?.newcomer_cohort?.market_reference?.families ?? []) {
    if (EXCLUDED_VERDICTS.has(f?.comparability_verdict)) addExcl(f?.asin);
  }
  return excluded;
}

function collectReferencedComparableAsinsForPricing(cand, primaryScenarios = [], excludedAsins = new Set()) {
  const refs = new Set();
  const addAsin = val => {
    if (nonemptyStr(val)) {
      const up = val.trim().toUpperCase();
      if (ASIN_EXACT_RE.test(up) && !excludedAsins.has(up)) refs.add(up);
    }
  };
  // Strictly accept ONLY structured ASIN fields (NEVER free-text prose in refPrice.note or scenario.label)!
  const refPrice = cand?.screening?.reference_price_usd;
  addAsin(refPrice?.target_variant_asin);
  for (const m of cand?.newcomer_cohort?.members ?? []) {
    if (!m?.comparability_verdict || m.comparability_verdict === 'comparable') addAsin(m?.asin);
  }
  for (const f of cand?.newcomer_cohort?.market_reference?.families ?? []) {
    if (!f?.comparability_verdict || f.comparability_verdict === 'comparable') addAsin(f?.asin);
  }
  for (const sc of primaryScenarios) {
    addAsin(sc?.price_anchor?.target_variant_asin);
  }
  return refs;
}

function isCompanionHolidayPeakOnlyPeriod(p) {
  return Array.isArray(p?.months) &&
    p.months.length > 0 &&
    p.months.length <= 4 &&
    [10, 11, 12].every(m => p.months.includes(m)) &&
    p.months.every(m => m === 10 || m === 11 || m === 12 || m === 1);
}

function collectPrimaryContainersForChecks(cand) {
  const econ = cand?.economics;
  if (!econ || typeof econ !== 'object') return [];
  if (Array.isArray(econ.operating_periods) && econ.operating_periods.length > 0) {
    // Identify primary vs companion holiday peak periods strictly by months (matching scoring.mjs), NEVER by p.id === 'peak'!
    const nonHolidayPeriods = econ.operating_periods.filter(p => !isCompanionHolidayPeakOnlyPeriod(p));
    const selectedPeriods = nonHolidayPeriods.length > 0 ? nonHolidayPeriods : econ.operating_periods;
    return selectedPeriods.map(p => ({
      container_id: p?.id ?? 'operating_period',
      scenarios: Array.isArray(p?.scenarios) ? p.scenarios : [],
    }));
  }
  return Array.isArray(econ.scenarios)
    ? [{ container_id: 'annual', scenarios: econ.scenarios }]
    : [];
}

function collectPrimaryScenariosForPriceCheck(cand) {
  const econ = cand?.economics;
  if (!econ || typeof econ !== 'object') return [];
  if (Array.isArray(econ.operating_periods) && econ.operating_periods.length > 0) {
    return econ.operating_periods.flatMap(p => (Array.isArray(p?.scenarios) ? p.scenarios : []));
  }
  return Array.isArray(econ.scenarios) ? econ.scenarios : [];
}

function resolveCandidateReferenceAsOfDate(cand, fallbackDate = null) {
  const observedDates = [];
  const pushIsoDate = raw => {
    if (!nonemptyStr(raw)) return;
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      observedDates.push(trimmed.slice(0, 10));
    }
  };
  pushIsoDate(fallbackDate);
  pushIsoDate(cand?.newcomer_cohort?.observation_date);
  if (Array.isArray(cand?.evidence)) {
    for (const e of cand.evidence) {
      pushIsoDate(e?.observed_at);
    }
  }
  return observedDates.length > 0 ? observedDates.sort().at(-1) : null;
}

function assertCandidateRawProvenanceAndPriceBinding(cand, candCatalog, {
  candPayloads = [],
  extraVerifiedAsins = [],
  allowSyntheticIds = false,
  effectiveRev = 59,
  fallbackAsOfDate = null,
} = {}) {
  const allCandAsins = extractAllCandidateAsins(cand);
  for (const extraAsin of extraVerifiedAsins) {
    if (nonemptyStr(extraAsin)) {
      const norm = extraAsin.trim().toUpperCase();
      if (ASIN_EXACT_RE.test(norm)) allCandAsins.add(norm);
    }
  }
  assertRawAsinProvenance([...allCandAsins], candCatalog);

  const excludedAsins = collectExcludedDifferentTaskAsins(cand);
  const refPrice = cand?.screening?.reference_price_usd;
  const refPriceScalar = finite(refPrice?.value) ? refPrice.value : null;
  const refValueRange = Array.isArray(refPrice?.value_range) &&
    refPrice.value_range.length === 2 &&
    finite(refPrice.value_range[0]) &&
    finite(refPrice.value_range[1])
    ? [refPrice.value_range[0], refPrice.value_range[1]]
    : null;
  const refAnchorBaseline = refPriceScalar ?? (refValueRange ? refValueRange[0] : null);

  if (refPrice && typeof refPrice === 'object' && nonemptyStr(refPrice.target_variant_asin) && refAnchorBaseline !== null) {
    const targetAsin = refPrice.target_variant_asin.trim().toUpperCase();
    if (!ASIN_EXACT_RE.test(targetAsin)) {
      if (!allowSyntheticIds) {
        throw new TypeError(
          `Raw ASIN provenance violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" is not a valid B0xxxxxxxx ASIN.`,
        );
      }
      return allCandAsins;
    }
    if (!allowSyntheticIds && excludedAsins.has(targetAsin)) {
      throw new TypeError(
        `Scenario price provenance violation on candidate "${cand.id}": screening.reference_price_usd.target_variant_asin "${targetAsin}" cannot reference an ASIN marked excluded_different_task / non-comparable.`,
      );
    }
    const obsRecords = candCatalog.get(targetAsin) ?? [];
    if (obsRecords.length === 0) {
      throw new TypeError(
        `Raw ASIN provenance violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" is absent from candidate's verified structured receipts.`,
      );
    }
    const candObsDateForRef = resolveCandidateReferenceAsOfDate(cand, fallbackAsOfDate);
    const reconciledRef = reconcileAsinPriceProvenance(obsRecords, {
      asOfDate: candObsDateForRef,
      newcomerMaxAgeDays: BUSINESS_THRESHOLDS.newcomer_max_age_days,
    });
    const observedPrices = reconciledRef.observed_prices_usd;
    const listOnlyPrices = reconciledRef.list_prices_usd;
    const hasAnyPriceProvenance = observedPrices.length > 0 || listOnlyPrices.length > 0;
    const pricesMatchWithHardBoundaries = (observedUsd, declaredUsd, tol = 0.05) => {
      if (!finite(observedUsd) || !finite(declaredUsd) || Math.abs(observedUsd - declaredUsd) > tol) return false;
      const minFloor = BUSINESS_THRESHOLDS.minimum_reference_price_usd;
      if ((observedUsd < minFloor) !== (declaredUsd < minFloor)) return false;
      if (priceBand2027(observedUsd) !== priceBand2027(declaredUsd)) return false;
      return true;
    };
    if (refPriceScalar !== null && (refPrice.matched_spec === true || (hasAnyPriceProvenance && refPrice.allow_unobserved_derived_price !== true))) {
      const matched = observedPrices.some(p => pricesMatchWithHardBoundaries(p, refPriceScalar));
      if (!matched) {
        const matchedListOnly = listOnlyPrices.some(p => Math.abs(p - refPriceScalar) <= 0.05);
        throw new TypeError(
          matchedListOnly
            ? `Raw ASIN price-binding violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" only shows $${refPriceScalar} as an un-realized pre-coupon list price without independent regular-price evidence; realized/verified price(s) are [${observedPrices.map(p => `$${p.toFixed(2)}`).join(', ') || 'none'}].`
            : `Raw ASIN price-binding violation on candidate "${cand.id}": target_variant_asin "${targetAsin}" observed structured receipt price(s) [${observedPrices.map(p => `$${p.toFixed(2)}`).join(', ') || 'none'}] do not match screening.reference_price_usd.value ($${refPriceScalar}).`,
        );
      }
    }
  }

  // Enforce economics scenario selling-price provenance against candidate's verified receipts across ALL operating periods!
  // Blocks un-evidenced prices ($89.99), value_range / mega-bundle hijacking ($289.99), cross-category detail batch quantiles ($64.69),
  // free-text prose wall-mount notes ($49.99), AND excluded_different_task ASIN hijacking.
  if (!allowSyntheticIds) {
    const pricesMatchWithHardBoundaries = (observedUsd, declaredUsd, tol = 0.05) => {
      if (!finite(observedUsd) || !finite(declaredUsd) || Math.abs(observedUsd - declaredUsd) > tol) return false;
      const minFloor = BUSINESS_THRESHOLDS.minimum_reference_price_usd;
      if ((observedUsd < minFloor) !== (declaredUsd < minFloor)) return false;
      if (priceBand2027(observedUsd) !== priceBand2027(declaredUsd)) return false;
      return true;
    };
    const targetAsinNorm = nonemptyStr(refPrice?.target_variant_asin)
      ? refPrice.target_variant_asin.trim().toUpperCase()
      : null;
    const targetCategoryRoots = new Set(
      targetAsinNorm
        ? (candCatalog.get(targetAsinNorm) ?? []).map(r => r.category_root).filter(Boolean)
        : [],
    );
    const candObsDate = resolveCandidateReferenceAsOfDate(cand, fallbackAsOfDate);
    const { quantilePrices, mainstreamMedians, rowFloorPrices } = extractQuantileSupportedPricesFromPayloads(candPayloads, {
      asOfDate: candObsDate,
      excludedAsins,
      targetCategoryRoots,
      strictMatureOnly: effectiveRev >= 59,
    });
    const primaryScenarios = collectPrimaryScenariosForPriceCheck(cand);
    const rawReferencedAsins = collectReferencedComparableAsinsForPricing(cand, primaryScenarios, excludedAsins);
    const referencedComparableAsins = new Set(
      [...rawReferencedAsins].filter(a => {
        if (targetCategoryRoots.size === 0) return true;
        const aCats = (candCatalog.get(a) ?? []).map(r => r.category_root).filter(Boolean);
        return aCats.length === 0 || aCats.some(c => targetCategoryRoots.has(c));
      }),
    );
    const referencedPeerPrices = [
      ...new Set(
        [...referencedComparableAsins]
          .flatMap(a => reconcileAsinPriceProvenance(candCatalog.get(a) ?? [], {
            asOfDate: candObsDate,
            newcomerMaxAgeDays: BUSINESS_THRESHOLDS.newcomer_max_age_days,
          }).observed_prices_usd),
      ),
    ];
    const allowedScenarioPrices = [...new Set([...referencedPeerPrices, ...quantilePrices])];
    const supportedRange = Array.isArray(refPrice?.supported_price_range) &&
      refPrice.supported_price_range.length === 2 &&
      finite(refPrice.supported_price_range[0]) &&
      finite(refPrice.supported_price_range[1])
      ? [refPrice.supported_price_range[0], refPrice.supported_price_range[1]]
      : null;
    const effectiveRangeBounds = supportedRange ?? refValueRange;
    const maxMainstreamMedian = mainstreamMedians.length > 0 ? Math.max(...mainstreamMedians) : null;
    const minRowFloor = rowFloorPrices.length >= 2 ? Math.min(...rowFloorPrices) : null;

    const recordBundleAmberWarningOrThrow = (hardMessage, amberMessage) => {
      if (effectiveRev >= 59) {
        const currentNotes = Array.isArray(cand.review_notes) ? cand.review_notes : [];
        const alreadyRecorded = currentNotes.some(
          n => (typeof n === 'string' && n === amberMessage) || (n && typeof n === 'object' && n.kind === 'AMBER_BUNDLE_PRICE_CHECK' && n.note === amberMessage),
        );
        if (!alreadyRecorded) {
          cand.review_notes = [...currentNotes, { kind: 'AMBER_BUNDLE_PRICE_CHECK', note: amberMessage }];
        }
      } else {
        throw new TypeError(hardMessage);
      }
    };

    if (refPrice?.matched_spec === true && refAnchorBaseline !== null) {
      if (maxMainstreamMedian !== null && refAnchorBaseline > maxMainstreamMedian * 2.5 + 0.05) {
        recordBundleAmberWarningOrThrow(
          `Scenario price provenance violation on candidate "${cand.id}": reference_price_usd ($${refAnchorBaseline}) exceeds 2.5x denoised search-page median ($${round2(maxMainstreamMedian)}); split distinct sub-forms instead of adopting mega-bundle outliers.`,
          `【琥珀核对提醒 · AMBER_BUNDLE_PRICE_CHECK】参考售价 ($${refAnchorBaseline}) 高于去噪中位价 ($${round2(maxMainstreamMedian)}) 2.5 倍以上，请核对是否属于正经多只装／豪华套装。`,
        );
      }
      if (maxMainstreamMedian === null && minRowFloor !== null && refAnchorBaseline > minRowFloor * 2.5 + 0.05) {
        recordBundleAmberWarningOrThrow(
          `Scenario price provenance violation on candidate "${cand.id}": reference_price_usd ($${refAnchorBaseline}) exceeds 2.5x observed page baseline ($${round2(minRowFloor)}); 2-row mega-bundle hijacking is prohibited.`,
          `【琥珀核对提醒 · AMBER_BUNDLE_PRICE_CHECK】参考售价 ($${refAnchorBaseline}) 高于页面基准低价 ($${round2(minRowFloor)}) 2.5 倍以上，请核对是否属于正经多只装／豪华套装。`,
        );
      }
      if (effectiveRangeBounds && effectiveRangeBounds[1] > refAnchorBaseline * 2.25 + 0.05) {
        recordBundleAmberWarningOrThrow(
          `Scenario price provenance violation on candidate "${cand.id}": reference price upper bound ($${effectiveRangeBounds[1]}) exceeds 2.25x baseline ($${refAnchorBaseline}); split distinct sub-forms instead of pooling unrelated bundle ASINs.`,
          `【琥珀核对提醒 · AMBER_BUNDLE_PRICE_CHECK】参考价区间上限 ($${effectiveRangeBounds[1]}) 高于基准价 ($${refAnchorBaseline}) 2.25 倍以上，请核对单只与多只套装是否混组。`,
        );
      }
    }

    for (const sc of primaryScenarios) {
      const ledger = sc?.cost_ledger ?? {};
      const eff = resolveEffectivePricing(ledger);
      const ledgerPrice = eff.valid && finite(eff.net_effective_price_usd)
        ? eff.net_effective_price_usd
        : (finite(ledger.price_usd) ? ledger.price_usd : null);
      const anchorPrice = finite(sc?.price_anchor?.value) ? sc.price_anchor.value : null;
      if (ledgerPrice !== null && anchorPrice !== null && Math.abs(ledgerPrice - anchorPrice) > 0.02) {
        throw new TypeError(
          `Scenario "${sc?.id ?? 'unknown'}" on candidate "${cand.id}" has conflicting price_anchor ($${anchorPrice}) vs cost_ledger price ($${ledgerPrice}).`,
        );
      }
      const effectiveScPrice = ledgerPrice ?? anchorPrice;
      if (effectiveScPrice === null) continue;

      if (refPrice?.matched_spec === true) {
        if (refAnchorBaseline !== null && effectiveScPrice > refAnchorBaseline * 2.25 + 0.05) {
          recordBundleAmberWarningOrThrow(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) exceeds 2.25x reference_price_usd ($${refAnchorBaseline}); cross-ASIN bundle price hijacking is prohibited.`,
            `【琥珀核对提醒 · AMBER_BUNDLE_PRICE_CHECK】情景 "${sc?.id ?? 'unknown'}" 售价 ($${effectiveScPrice}) 高于基准参考价 ($${refAnchorBaseline}) 2.25 倍以上，请核对是否为正经多只装／豪华套装。`,
          );
        }
        if (maxMainstreamMedian !== null && effectiveScPrice > maxMainstreamMedian * 2.5 + 0.05) {
          recordBundleAmberWarningOrThrow(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) exceeds 2.5x denoised search-page median ($${round2(maxMainstreamMedian)}).`,
            `【琥珀核对提醒 · AMBER_BUNDLE_PRICE_CHECK】情景 "${sc?.id ?? 'unknown'}" 售价 ($${effectiveScPrice}) 高于搜索页去噪中位价 ($${round2(maxMainstreamMedian)}) 2.5 倍以上，请核对是否为正经多只装／豪华套装。`,
          );
        }
        if (maxMainstreamMedian === null && minRowFloor !== null && effectiveScPrice > minRowFloor * 2.5 + 0.05) {
          recordBundleAmberWarningOrThrow(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) exceeds 2.5x observed page baseline ($${round2(minRowFloor)}).`,
            `【琥珀核对提醒 · AMBER_BUNDLE_PRICE_CHECK】情景 "${sc?.id ?? 'unknown'}" 售价 ($${effectiveScPrice}) 高于页面基准低价 ($${round2(minRowFloor)}) 2.5 倍以上，请核对是否为正经多只装／豪华套装。`,
          );
        }
      }

      const scenTargetAsin = nonemptyStr(sc?.price_anchor?.target_variant_asin)
        ? sc.price_anchor.target_variant_asin.trim().toUpperCase()
        : null;
      if (scenTargetAsin && excludedAsins.has(scenTargetAsin)) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" cannot anchor selling price ($${effectiveScPrice}) to ASIN "${scenTargetAsin}" marked excluded_different_task.`,
        );
      }

      // Orthogonally enforce supported_price_range EVEN when scenario target_variant_asin is set!
      // Never allow 5-cent boundary tolerance to cross $10.00, $29.99, or $50.00 FBA / hard-floor cliffs!
      if (supportedRange) {
        const belowMin = effectiveScPrice < supportedRange[0] && !pricesMatchWithHardBoundaries(supportedRange[0], effectiveScPrice);
        const aboveMax = effectiveScPrice > supportedRange[1] && !pricesMatchWithHardBoundaries(supportedRange[1], effectiveScPrice);
        const minFloorForRange = BUSINESS_THRESHOLDS.minimum_reference_price_usd;
        const crossedMinFloorOnRange = supportedRange[1] < minFloorForRange && effectiveScPrice >= minFloorForRange;
        if (belowMin || aboveMax || crossedMinFloorOnRange) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) lies outside supported_price_range [$${supportedRange[0]}, $${supportedRange[1]}].`,
          );
        }
      }

      if (scenTargetAsin) {
        const scenRecs = candCatalog.get(scenTargetAsin) ?? [];
        const scenCats = [...new Set(scenRecs.map(r => r.category_root).filter(Boolean))];
        if (targetCategoryRoots.size > 0 && scenCats.length > 0 && !scenCats.some(c => targetCategoryRoots.has(c))) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" target_variant_asin "${scenTargetAsin}" belongs to category [${scenCats.join(', ')}], disjoint from candidate category [${[...targetCategoryRoots].join(', ')}].`,
          );
        }
        const reconciledScen = reconcileAsinPriceProvenance(scenRecs, {
          asOfDate: candObsDate,
          newcomerMaxAgeDays: BUSINESS_THRESHOLDS.newcomer_max_age_days,
        });
        const scenObsPrices = reconciledScen.observed_prices_usd;
        const scenListPrices = reconciledScen.list_prices_usd;
        if (!scenObsPrices.some(p => pricesMatchWithHardBoundaries(p, effectiveScPrice))) {
          const matchedListOnly = scenListPrices.some(p => Math.abs(p - effectiveScPrice) <= 0.05);
          throw new TypeError(
            matchedListOnly
              ? `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" target_variant_asin "${scenTargetAsin}" cannot use pre-coupon list price ($${effectiveScPrice}) without independent regular-price evidence; realized/verified price(s) are [${scenObsPrices.map(p => `$${p.toFixed(2)}`).join(', ') || 'none'}].`
              : `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" target_variant_asin "${scenTargetAsin}" observed prices [${scenObsPrices.map(p => `$${p.toFixed(2)}`).join(', ') || 'none'}] do not match $${effectiveScPrice}.`,
          );
        }
        if (eff.valid && eff.has_ongoing_discount && finite(eff.list_price_usd) && (scenListPrices.length > 0 || scenObsPrices.length > 0)) {
          const allKnownListOrRegular = [...new Set([...scenListPrices, ...scenObsPrices])];
          if (!allKnownListOrRegular.some(p => pricesMatchWithHardBoundaries(p, eff.list_price_usd))) {
            throw new TypeError(
              `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" target_variant_asin "${scenTargetAsin}" list_price_usd ($${eff.list_price_usd}) is not backed by observed list/regular prices [${allKnownListOrRegular.map(p => `$${p.toFixed(2)}`).join(', ')}].`,
            );
          }
        }
        if (!supportedRange && refPriceScalar !== null && !pricesMatchWithHardBoundaries(refPriceScalar, effectiveScPrice)) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) differs from single-point screening.reference_price_usd.value ($${refPriceScalar}) without declaring supported_price_range.`,
          );
        }
      } else if (supportedRange) {
        if ((refPrice?.matched_spec === true || allowedScenarioPrices.length > 0) &&
          !allowedScenarioPrices.some(p => pricesMatchWithHardBoundaries(p, effectiveScPrice))) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) is not backed by any referenced comparable ASIN or denoised P25/P50/P75 quantile in candidate's verified receipts.`,
          );
        }
      } else if (refPriceScalar !== null) {
        if (!pricesMatchWithHardBoundaries(refPriceScalar, effectiveScPrice)) {
          throw new TypeError(
            `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) differs from single-point screening.reference_price_usd.value ($${refPriceScalar}) without an explicit scenario price_anchor.target_variant_asin or supported_price_range.`,
          );
        }
      } else if (allowedScenarioPrices.length > 0 && !allowedScenarioPrices.some(p => pricesMatchWithHardBoundaries(p, effectiveScPrice))) {
        throw new TypeError(
          `Scenario price provenance violation on candidate "${cand.id}": scenario "${sc?.id ?? 'unknown'}" selling price ($${effectiveScPrice}) is not backed by candidate's verified receipts.`,
        );
      }
    }
  }
  return allCandAsins;
}

function enforceCandidateContainerMatrixAndDbParity(cand, {
  dbConstraints = null,
  effectiveRev = 58,
} = {}) {
  const containers = collectPrimaryContainersForChecks(cand);
  if (containers.length === 0) return { unverifiedUiQuoteUsed: false };

  const resolveScPrice = sc => {
    const ledger = sc?.cost_ledger ?? {};
    const eff = resolveEffectivePricing(ledger);
    if (eff.valid && finite(eff.net_effective_price_usd)) return round2(eff.net_effective_price_usd);
    if (finite(ledger.price_usd)) return round2(ledger.price_usd);
    if (finite(sc?.price_anchor?.value)) return round2(sc.price_anchor.value);
    return null;
  };

  const usableQuotes = dbConstraints?.usableQuotes ?? [];
  const usableQuotesById = new Map(usableQuotes.map(q => [q.quote_id, q]));
  const dbDeclaredPrices = dbConstraints?.declaredPricesUsd ?? [];
  const allImplicitQuotes = [...new Set(
    containers
      .flatMap(c => c.scenarios)
      .map(sc => String(sc?.quote_id ?? sc?.cost_ledger?.source_inputs?.quote_id ?? '').trim())
      .filter(Boolean),
  )];
  const requiredQuoteIds = usableQuotes.length > 0
    ? usableQuotes.map(q => q.quote_id)
    : allImplicitQuotes;

  let unverifiedUiQuoteUsed = false;
  let expiredIsolatedReason = null;

  for (const container of containers) {
    const scens = container.scenarios;
    const obsPrices = [...new Set(scens.map(resolveScPrice).filter(finite))];
    if (dbDeclaredPrices.length > 0) {
      const missingDbPrices = dbDeclaredPrices.filter(dp => !obsPrices.some(op => Math.abs(op - dp) <= 0.02));
      if (missingDbPrices.length > 0) {
        throw new TypeError(
          `Candidate "${cand.id}" (${container.container_id}) omitted SQLite Gate 1A declared price(s) [${missingDbPrices.map(p => `$${p.toFixed(2)}`).join(', ')}].`,
        );
      }
    }

    // Isolate expired quotes per candidate (downgrade sourced 1688 costs to pending) instead of crashing the batch!
    if (usableQuotes.length === 0 && dbConstraints?.dbFormPresent === true) {
      for (const sc of scens) {
        const ledger = sc?.cost_ledger ?? {};
        const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
        const procLine = lines.find(l => l?.id === 'procurement');
        const domLine = lines.find(l => l?.id === 'domestic_freight');
        const colLine = lines.find(l => l?.id === 'collection');
        const hasSourcedProc = Boolean(procLine && procLine.status !== 'pending' && finite(procLine.amount_usd));
        const hasSourcedDom = Boolean(domLine && domLine.status !== 'pending' && domLine.status !== 'deferred' && finite(domLine.amount_usd));
        if (hasSourcedProc || hasSourcedDom) {
          if ((dbConstraints.expiredQuoteIds?.length ?? 0) > 0) {
            if (procLine) { procLine.status = 'pending'; procLine.amount_usd = null; }
            if (domLine) { domLine.status = 'pending'; domLine.amount_usd = null; }
            if (colLine) { colLine.status = 'pending'; colLine.amount_usd = null; }
            expiredIsolatedReason =
              `Candidate "${cand.id}" persisted SQLite 1688 quote(s) [${dbConstraints.expiredQuoteIds.join(', ')}] have expired as of ${dbConstraints.candAsOf}; isolated to pending without aborting batch.`;
          } else if (effectiveRev >= 59) {
            unverifiedUiQuoteUsed = true;
          }
        }
      }
    }

    // Verify authoritative SQLite quote cost, FX, order_units, and r59 ui_readback parity on every primary scenario!
    if (usableQuotes.length > 0) {
      for (const sc of scens) {
        const explicitQid = String(sc?.quote_id ?? sc?.cost_ledger?.source_inputs?.quote_id ?? '').trim();
        if (explicitQid && !usableQuotesById.has(explicitQid)) {
          throw new TypeError(
            `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" references unknown or expired quote_id "${explicitQid}" not in SQLite usable quotes [${usableQuotes.map(q => q.quote_id).join(', ')}].`,
          );
        }
        if (!explicitQid && usableQuotes.length > 1) {
          throw new TypeError(
            `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" must bind quote_id when SQLite holds multiple verified quotes (${usableQuotes.map(q => q.quote_id).join(', ')}).`,
          );
        }
        const activeQuote = explicitQid ? usableQuotesById.get(explicitQid) : usableQuotes[0];
        const ledger = sc?.cost_ledger ?? {};
        const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
        const procLine = lines.find(l => l?.id === 'procurement');
        const domLine = lines.find(l => l?.id === 'domestic_freight');
        const hasSourcedProc = Boolean(procLine && procLine.status !== 'pending' && finite(procLine.amount_usd));
        const hasSourcedDom = Boolean(domLine && domLine.status !== 'pending' && domLine.status !== 'deferred' && finite(domLine.amount_usd));

        if ((hasSourcedProc || hasSourcedDom) && effectiveRev >= 59) {
          if (activeQuote.ui_readback_verified === false) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" cannot score sourced 1688 cost under Revision 59 from quote "${activeQuote.quote_id}" with incomplete ui_readback.`,
            );
          }
          if (activeQuote.ui_readback_verified !== true) {
            unverifiedUiQuoteUsed = true;
          }
        }

        const explicitLedgerFxs = [
          procLine?.fx_cny_per_usd,
          domLine?.fx_cny_per_usd,
          ledger.fx_cny_per_usd,
          ledger.source_inputs?.fx_cny_per_usd,
          ledger.source_inputs?.fx_usdcny,
        ].filter(v => finite(v) && v > 0);
        const quoteFx = (finite(activeQuote.fx_cny_per_usd) && activeQuote.fx_cny_per_usd > 0)
          ? activeQuote.fx_cny_per_usd
          : null;
        const gate1aFx = (finite(dbConstraints?.declaredFxCnyPerUsd) && dbConstraints.declaredFxCnyPerUsd > 0)
          ? dbConstraints.declaredFxCnyPerUsd
          : null;
        if ((hasSourcedProc || hasSourcedDom) && quoteFx !== null && gate1aFx !== null && Math.abs(quoteFx - gate1aFx) > 1e-4) {
          throw new TypeError(
            `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" persisted SQLite 1688 quote "${activeQuote.quote_id}" fx_cny_per_usd (${quoteFx}) conflicts with SQLite Gate 1A accepted fx_cny_per_usd (${gate1aFx}).`,
          );
        }
        const dbAuthoritativeFx = quoteFx ?? gate1aFx;
        if (dbAuthoritativeFx !== null && (hasSourcedProc || hasSourcedDom)) {
          for (const lfx of explicitLedgerFxs) {
            if (Math.abs(lfx - dbAuthoritativeFx) > 1e-4) {
              throw new TypeError(
                `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" fx_cny_per_usd (${lfx}) conflicts with persisted SQLite authoritative fx_cny_per_usd (${dbAuthoritativeFx} on quote "${activeQuote.quote_id}").`,
              );
            }
          }
        }
        const effectiveFx = dbAuthoritativeFx ?? (explicitLedgerFxs[0] ?? null);

        if (hasSourcedProc) {
          if (procLine.order_units !== undefined && procLine.order_units !== activeQuote.actual_sets) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" procurement.order_units (${procLine.order_units}) conflicts with persisted SQLite quote "${activeQuote.quote_id}" actual_sets (${activeQuote.actual_sets}).`,
            );
          }
          if (effectiveFx === null) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" requires fx_cny_per_usd to verify procurement parity against SQLite quote "${activeQuote.quote_id}".`,
            );
          }
          const expectedProcUsd = (activeQuote.goods_cny_total / activeQuote.actual_sets) / effectiveFx;
          if (Math.abs(procLine.amount_usd - expectedProcUsd) > 0.005) {
            throw new TypeError(
              `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" procurement ($${procLine.amount_usd}) disagrees with persisted SQLite 1688 quote "${activeQuote.quote_id}" ($${expectedProcUsd.toFixed(4)} at FX ${effectiveFx}).`,
            );
          }
        }
        if (hasSourcedDom) {
          const activeQuoteIsBareGoods = activeQuote.pricing_basis === 'bare_goods_1688' ||
            activeQuote.bare_goods_screening === true ||
            activeQuote.domestic_freight_cny_total === null ||
            activeQuote.domestic_freight_cny_total === undefined;
          if (activeQuoteIsBareGoods) {
            if (Math.abs(domLine.amount_usd) > 0.005) {
              throw new TypeError(
                `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" domestic_freight ($${domLine.amount_usd}) conflicts with bare-goods SQLite 1688 quote "${activeQuote.quote_id}" (pricing_basis: bare_goods_1688).`,
              );
            }
          } else {
            if (domLine.order_units !== undefined && domLine.order_units !== activeQuote.actual_sets) {
              throw new TypeError(
                `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" domestic_freight.order_units (${domLine.order_units}) conflicts with persisted SQLite quote "${activeQuote.quote_id}" actual_sets (${activeQuote.actual_sets}).`,
              );
            }
            if (effectiveFx === null) {
              throw new TypeError(
                `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" requires fx_cny_per_usd to verify domestic_freight parity against SQLite quote "${activeQuote.quote_id}".`,
              );
            }
            const expectedDomUsd = (activeQuote.domestic_freight_cny_total / activeQuote.actual_sets) / effectiveFx;
            if (Math.abs(domLine.amount_usd - expectedDomUsd) > 0.005) {
              throw new TypeError(
                `Candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}" domestic_freight ($${domLine.amount_usd}) disagrees with persisted SQLite 1688 quote "${activeQuote.quote_id}" ($${expectedDomUsd.toFixed(4)} at FX ${effectiveFx}).`,
              );
            }
          }
        }
      }
    }

    // Enforce full (price × quote_id) Cartesian completeness per primary container whenever >=2 quotes participate (or SQLite holds usable quotes)!
    if (requiredQuoteIds.length > 1 || (usableQuotes.length === 1 && dbDeclaredPrices.length > 0)) {
      const reqPrices = [...new Set([...dbDeclaredPrices, ...obsPrices])];
      const presentCells = new Set();
      for (const sc of scens) {
        const rawQid = String(sc?.quote_id ?? sc?.cost_ledger?.source_inputs?.quote_id ?? '').trim();
        const qid = rawQid || (requiredQuoteIds.length === 1 ? requiredQuoteIds[0] : '');
        const pr = resolveScPrice(sc);
        if (!qid) {
          throw new TypeError(
            `Candidate "${cand.id}" (${container.container_id}) scenario "${sc?.id ?? 'unknown'}" must specify an explicit quote_id when multiple quotes (${requiredQuoteIds.join(', ')}) participate.`,
          );
        }
        if (pr !== null) presentCells.add(`${pr.toFixed(2)}::${qid}`);
      }
      const missingCells = [];
      for (const pr of reqPrices) {
        for (const qid of requiredQuoteIds) {
          if (!presentCells.has(`${pr.toFixed(2)}::${qid}`)) {
            missingCells.push(`$${pr.toFixed(2)}×${qid}`);
          }
        }
      }
      if (missingCells.length > 0) {
        throw new TypeError(
          `Candidate "${cand.id}" (${container.container_id}) omitted Cartesian (price × quote_id) cell(s) [${missingCells.join(', ')}]; diagonal subset submissions are prohibited.`,
        );
      }
    }
  }

  if (expiredIsolatedReason) {
    cand.ingest_isolated_pending = true;
    cand.review_notes = [...new Set([...(Array.isArray(cand.review_notes) ? cand.review_notes : []), expiredIsolatedReason])];
    cand.presentation = {
      ...(cand.presentation ?? {}),
      blockers: [
        ...(Array.isArray(cand.presentation?.blockers) ? cand.presentation.blockers : []),
        { problem: expiredIsolatedReason, next_step: '重新获取最新 1688 齐套现货含运报价后再复算。' },
      ],
    };
  }

  return { unverifiedUiQuoteUsed, isolatedReason: expiredIsolatedReason };
}

function ensureCandidatePendingShellOnMissingFields(cand, reason) {
  cand.ingest_isolated_pending = true;
  cand.review_notes = [...new Set([...(Array.isArray(cand.review_notes) ? cand.review_notes : []), reason])];
  cand.presentation = {
    ...(cand.presentation ?? {}),
    blockers: [
      ...(Array.isArray(cand.presentation?.blockers) ? cand.presentation.blockers : []),
      { problem: reason, next_step: '补齐该候选品缺失字段或有效报价后重新入库评分。' },
    ],
  };
  const hasValidFlat = Array.isArray(cand?.economics?.scenarios) && cand.economics.scenarios.length > 0 && nonemptyStr(cand.economics.saleable_unit);
  const hasValidPeriods = Array.isArray(cand?.economics?.operating_periods) && cand.economics.operating_periods.length > 0 && nonemptyStr(cand.economics.saleable_unit);
  if (!hasValidFlat && !hasValidPeriods) {
    const unit = nonemptyStr(cand?.economics?.saleable_unit) ? cand.economics.saleable_unit : '1 unit';
    cand.economics = {
      saleable_unit: unit,
      scenarios: [
        {
          id: `sc-isolated-pending-${cand.id}`,
          label: '单品缺失字段隔离待补证',
          saleable_unit: unit,
          coherent: false,
          assumptions: [reason],
        },
      ],
    };
  }
}

/**
 * Ingest a structured trial specification + raw receipt files into a provenance-verified batch JSON.
 */
export function ingestTrialSpecification(spec, profile, {
  baseDir = process.cwd(),
  allowSyntheticWithoutReceipts = false,
  ledgerDbPath = null,
} = {}) {
  if (!spec || typeof spec !== 'object') throw new TypeError('Trial specification object is required.');
  const {
    raw_receipt_files: rawFilesField,
    expected_raw_sha256s: expectedRawSha256sField,
    ledger_db_path: specLedgerDbField,
    ...specBodyRaw
  } = spec;
  const sanitizedSpecCandidates = Array.isArray(specBodyRaw.candidates)
    ? specBodyRaw.candidates.map(entry => {
        if (!entry || typeof entry !== 'object') return entry;
        const { raw_receipt_files: _crf, ...restEntry } = entry;
        return restEntry;
      })
    : specBodyRaw.candidates;
  const specBody = { ...specBodyRaw, candidates: sanitizedSpecCandidates };
  assertNoRawPii(specBody, 'ingest_trial_spec');
  if (containsSecretToken(specBody)) {
    throw new TypeError('ingest_trial_spec contains a secret or token; redact before ingesting.');
  }

  const effectiveRev = spec.profile_revision ?? profile?.revision ?? 59;
  const allowSynthetic = allowSyntheticWithoutReceipts === true || spec.allow_synthetic_without_receipts === true;
  const rawFiles = Array.isArray(rawFilesField) ? rawFilesField : [];
  if (!allowSynthetic && rawFiles.length === 0) {
    throw new TypeError(
      'ingestTrialSpecification requires a nonempty raw_receipt_files array (or explicit allow_synthetic_without_receipts: true for synthetic fixtures).',
    );
  }

  const verifiedReceiptSha256s = {};
  const rawPayloadByResolvedPath = new Map();
  const rawPayloads = rawFiles.map(fp => {
    const absPath = resolve(baseDir, String(fp));
    const rawBytes = readFileSync(absPath);
    const rawFileSha = sha256Hex(rawBytes);
    const parsedPayload = JSON.parse(rawBytes.toString('utf8'));
    const canonicalSha = sha256Hex(canonicalJson(parsedPayload));
    if (expectedRawSha256sField && typeof expectedRawSha256sField === 'object') {
      const expSha = expectedRawSha256sField[String(fp)] ?? null;
      if (!nonemptyStr(expSha)) {
        throw new TypeError(`expected_raw_sha256s is missing required SHA-256 entry for receipt "${fp}".`);
      }
      const normExp = expSha.trim().toLowerCase();
      if (normExp !== rawFileSha && normExp !== canonicalSha) {
        throw new TypeError(
          `Raw receipt SHA-256 mismatch for "${fp}": expected ${normExp}, got file=${rawFileSha} / canonical=${canonicalSha}.`,
        );
      }
    }
    verifiedReceiptSha256s[String(fp)] = {
      raw_file_sha256: rawFileSha,
      canonical_payload_sha256: canonicalSha,
    };
    const item = {
      source_id: String(fp),
      source_sha256: rawFileSha,
      canonical_payload_sha256: canonicalSha,
      payload: parsedPayload,
    };
    rawPayloadByResolvedPath.set(absPath, item);
    return item;
  });

  const resolvedLedgerDb = ledgerDbPath ?? (nonemptyStr(specLedgerDbField) ? resolve(baseDir, String(specLedgerDbField)) : null);
  const dbFormConstraintsById = new Map();
  const unmatchedLedgerReceiptFiles = [];
  if (resolvedLedgerDb) {
    if (!existsSync(resolvedLedgerDb)) {
      throw new TypeError(`Specified ledger_db_path does not exist: "${resolvedLedgerDb}".`);
    }
    const roStore = openSelectionStore(resolvedLedgerDb, { readOnly: true });
    try {
      if (rawPayloads.length > 0) {
        const completedRows = roStore.db.prepare(
          "SELECT payload_sha256, raw_artifact_path FROM api_request_ledger WHERE status = 'completed'",
        ).all();
        const completedHashes = new Set(completedRows.map(r => r.payload_sha256).filter(Boolean));
        for (const fp of rawFiles) {
          const absPath = resolve(baseDir, String(fp));
          const item = rawPayloadByResolvedPath.get(absPath);
          const matched = completedHashes.has(item.canonical_payload_sha256) || completedHashes.has(item.source_sha256);
          verifiedReceiptSha256s[String(fp)].ledger_provenance_verified = matched;
          if (!matched) unmatchedLedgerReceiptFiles.push(String(fp));
        }
      }
      for (const entry of Array.isArray(spec.candidates) ? spec.candidates : []) {
        const rawCand = entry?.candidate ?? entry;
        const cid = String(rawCand?.id ?? '').trim();
        if (!cid) continue;
        const dbForm = roStore.getCandidateForm(cid);
        if (!dbForm) continue;
        let declaredPricesUsd = [];
        let declaredFxCnyPerUsd = null;
        try {
          const g1a = dbForm.gate1a_result_json ? JSON.parse(dbForm.gate1a_result_json) : null;
          if (g1a && (!g1a.spec_sha256 || g1a.spec_sha256 === dbForm.spec_sha256) && g1a.proceed_to_gate1b === true) {
            if (Array.isArray(g1a.declared_scenarios)) {
              declaredPricesUsd = [...new Set(g1a.declared_scenarios.map(d => d?.price_usd).filter(finite).map(round2))];
            }
            const g1aFxs = [
              ...(Array.isArray(g1a.declared_scenarios) ? g1a.declared_scenarios.map(d => d?.fx_cny_per_usd) : []),
              ...(Array.isArray(g1a.scenarios) ? g1a.scenarios.map(s => s?.estimate?.fx_cny_per_usd) : []),
            ].filter(v => finite(v) && v > 0);
            if (g1aFxs.length > 0) declaredFxCnyPerUsd = g1aFxs[0];
          }
        } catch { /* ignore malformed json */ }
        const candAsOf = resolveCandidateReferenceAsOfDate(rawCand, entry?.as_of_date ?? spec.as_of_date ?? null) ??
          new Date().toISOString().slice(0, 10);
        const allVerifiedQuotesForSpec = roStore.getQuotesForForm(cid)
          .filter(q => q.quote_status === 'verified' && q.spec_version === dbForm.spec_version);
        const usableQuotes = allVerifiedQuotesForSpec
          .filter(q => !q.expires_at || String(q.expires_at).slice(0, 10) >= candAsOf);
        const expiredQuoteIds = allVerifiedQuotesForSpec
          .filter(q => q.expires_at && String(q.expires_at).slice(0, 10) < candAsOf)
          .map(q => q.quote_id);
        let parsedDbComp = dbForm.saleable_set_composition ?? null;
        if (!parsedDbComp && typeof dbForm.saleable_set_composition_json === 'string') {
          try { parsedDbComp = JSON.parse(dbForm.saleable_set_composition_json); } catch { parsedDbComp = null; }
        }
        dbFormConstraintsById.set(cid, {
          dbFormPresent: true,
          dbFormSpec: {
            spec_sha256: dbForm.spec_sha256 ?? null,
            buyer_task: dbForm.buyer_task ?? null,
            saleable_set_composition: parsedDbComp,
            grade_or_material: dbForm.grade_or_material ?? null,
            target_child_asin: dbForm.target_child_asin ?? null,
            leaf_node_path: dbForm.leaf_node_path ?? null,
          },
          candAsOf,
          declaredPricesUsd,
          declaredFxCnyPerUsd,
          usableQuotes,
          verifiedQuoteIds: usableQuotes.map(q => q.quote_id),
          expiredQuoteIds,
        });
      }
    } finally {
      roStore.close();
    }
  }

  const globalCatalog = extractVerifiedAsinCatalogFromRawPayloads(rawPayloads);
  const perCandidateVerifiedAsinCounts = {};
  const unverifiedUiQuoteCandidateIds = new Set();
  const isolatedCandidates = [];
  const rawCandidateEntries = Array.isArray(spec.candidates) ? spec.candidates : [];

  const isMissingFieldIngestError = (err) => {
    const msg = String(err?.message ?? '');
    return /(?:is required|must be a nonempty array|must be a positive finite number|requires? (?:a )?nonempty|is empty|contains no structured|At least one matched FBA peer with valid positive dimensions|upstream SP-API error)/i.test(msg) &&
      !/(?:provenance|disagrees|conflicts|mismatch|smuggl|ui_readback|Cartesian|omitted|excluded_different_task|disjoint|Duplicate|unknown or expired quote_id|failed category_demand_report)/i.test(msg);
  };

  const applySpApiCalibrationToScenario = (sc, spCal, rawFeesForLookup = null) => {
    if (!sc || typeof sc !== 'object' || !sc.cost_ledger || typeof sc.cost_ledger !== 'object') return;
    const isFactoryPkg = sc.package_source === 'factory_quote';
    const ledger = sc.cost_ledger;
    const lines = Array.isArray(ledger.lines) ? ledger.lines : [];
    const pricing = resolveEffectivePricing(ledger);
    const netP = pricing.valid && finite(pricing.net_effective_price_usd) ? pricing.net_effective_price_usd : ledger.price_usd;
    const listP = pricing.valid && finite(pricing.list_price_usd) ? pricing.list_price_usd : ledger.price_usd;
    if (!finite(netP) || netP <= 0) return;

    let mutated = false;
    let effectiveFeeCal = spCal?.fee_calibration ?? null;
    const initialCalBasePrice = finite(effectiveFeeCal?.total_price_usd)
      ? effectiveFeeCal.total_price_usd
      : effectiveFeeCal?.listing_price_usd;
    if (rawFeesForLookup && (!effectiveFeeCal || !finite(initialCalBasePrice) || Math.round(netP * 100) !== Math.round(initialCalBasePrice * 100))) {
      try {
        const perScCal = extractSpApiFinalistCalibration({
          asin: spCal?.asin ?? null,
          price_usd: netP,
          feesEstimateRaw: rawFeesForLookup,
        });
        if (perScCal.fee_calibration_status === 'verified' && perScCal.fee_calibration) {
          effectiveFeeCal = perScCal.fee_calibration;
        }
      } catch { /* ignore */ }
    }
    const refFrac = effectiveFeeCal?.referral_fraction;
    const calPrice = finite(effectiveFeeCal?.total_price_usd)
      ? effectiveFeeCal.total_price_usd
      : effectiveFeeCal?.listing_price_usd;
    const priceMatchesCalibratedTier = !finite(calPrice) || Math.round(netP * 100) === Math.round(calPrice * 100);
    if (finite(refFrac) && refFrac > 0 && refFrac < 1 && priceMatchesCalibratedTier) {
      ledger.referral_terms = {
        refund_admin_fraction: 0.20,
        refund_admin_cap_usd: 5.00,
        minimum_referral_usd: 0.30,
        ...(ledger.referral_terms ?? {}),
        referral_fraction: refFrac,
      };
      const refLine = lines.find(l => l?.id === 'referral');
      if (refLine && refLine.status !== 'pending') {
        const netRef = netReferral({
          ...ledger.referral_terms,
          price_usd: netP,
          refund_fraction: finite(ledger.refund_fraction) ? ledger.refund_fraction : 0,
        });
        refLine.amount_usd = netRef.net_usd;
        mutated = true;
      }
    }

    const officialPkg = !isFactoryPkg ? spCal?.official_pkg : null;
    if (officialPkg && typeof officialPkg === 'object') {
      ledger.pkg = { ...officialPkg };
      if (Array.isArray(ledger.packages) && ledger.fee_context?.package_ref) {
        for (let pi = 0; pi < ledger.packages.length; pi++) {
          if (ledger.packages[pi]?.id === ledger.fee_context.package_ref) {
            ledger.packages[pi] = { ...ledger.packages[pi], ...officialPkg, id: ledger.fee_context.package_ref };
          }
        }
      }
      if (ledger.unit_weight_lb !== undefined) ledger.unit_weight_lb = officialPkg.unit_weight_lb;
      const salesWin = ledger.fee_context?.sales;
      const storWin = ledger.fee_context?.storage;
      const inbWin = ledger.fee_context?.inbound;
      const isApparel = ledger.is_apparel_or_shoes === true;
      const isDg = ledger.is_dangerous_goods === true;
      const isSipp = ledger.is_sipp === true;

      const fulLine = lines.find(l => l?.id === 'fulfillment');
      if (fulLine && fulLine.status !== 'pending') {
        const effSalesWin = (salesWin?.from >= '2027-01-15' && salesWin?.through <= '2027-10-14')
          ? salesWin
          : FBA_2027_DEFAULT_OFF_PEAK_WINDOW;
        const ful = lookupUnifiedFulfillmentFee2027({
          pkg: officialPkg,
          price_usd: netP,
          list_price_usd: listP,
          has_ongoing_coupon: Boolean((pricing.ongoing_coupon_usd ?? 0) > 0 || (pricing.ongoing_coupon_pct ?? 0) > 0),
          has_prime_discount: Boolean((pricing.prime_exclusive_discount_usd ?? 0) > 0 || (pricing.prime_exclusive_discount_pct ?? 0) > 0),
          is_sipp: isSipp,
          is_apparel: isApparel,
          is_dangerous_goods: isDg,
          fee_category: ledger.fee_category ?? null,
          sales_window: effSalesWin,
        });
        if (ful.status === 'verified') {
          fulLine.amount_usd = ful.total_usd;
          fulLine.basis = `SP-API official pkg (${officialPkg.length_in}x${officialPkg.width_in}x${officialPkg.height_in} in, ${officialPkg.unit_weight_lb} lb) -> 2027 ${ful.size_tier} $${ful.total_usd}`;
          if (fulLine.fee_basis && typeof fulLine.fee_basis === 'object') {
            if (fulLine.fee_basis.price_band !== undefined) fulLine.fee_basis.price_band = ful.price_band;
            if (fulLine.fee_basis.pkg && typeof fulLine.fee_basis.pkg === 'object') fulLine.fee_basis.pkg = { ...officialPkg };
          }
          mutated = true;
        }
      }

      const placeLine = lines.find(l => l?.id === 'placement');
      if (placeLine && placeLine.status !== 'pending') {
        const effInbWin = (inbWin?.from >= '2027-01-15') ? inbWin : FBA_2027_DEFAULT_INBOUND_WINDOW;
        const pl = lookupUnifiedPlacementFee2027({
          pkg: officialPkg,
          inbound_window: effInbWin,
          split_option: placeLine.split_option ?? 'minimal_west_conservative',
          is_apparel: isApparel,
          is_dangerous_goods: isDg,
        });
        if (pl.status === 'verified') {
          placeLine.amount_usd = pl.selected_usd;
          if (placeLine.fee_basis?.pkg && typeof placeLine.fee_basis.pkg === 'object') {
            placeLine.fee_basis.pkg = { ...officialPkg };
          }
          mutated = true;
        }
      }

      const storLine = lines.find(l => l?.id === 'storage');
      if (storLine && storLine.status !== 'pending') {
        const invDays = storLine.fee_basis?.average_inventory_days ?? storLine.average_inventory_days ?? 45;
        const mixesOffAndPeak = Boolean(storWin?.from && storWin?.through && storWin.from <= '2027-09-30' && storWin.through >= '2027-10-01');
        const isPeakStor = !mixesOffAndPeak && (
          (Array.isArray(storLine.fee_basis?.months) && storLine.fee_basis.months.length > 0 && storLine.fee_basis.months.every(m => m >= 10)) ||
          Boolean(storWin?.from && storWin.from >= '2027-10-01')
        );
        const effStorWin = isPeakStor
          ? FBA_2027_COMPANION_PEAK_STORAGE_WINDOW
          : ((storWin?.from >= '2027-02-01' && storWin?.through <= '2027-09-30') ? storWin : FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW);
        const st = lookupUnifiedStorageFee2027({
          pkg: officialPkg,
          storage_window: effStorWin,
          average_inventory_days: invDays,
          is_apparel: isApparel,
          is_dangerous_goods: isDg,
        });
        if (st.status === 'verified') {
          if (mixesOffAndPeak) {
            const stPeak = lookupUnifiedStorageFee2027({
              pkg: officialPkg,
              storage_window: FBA_2027_COMPANION_PEAK_STORAGE_WINDOW,
              average_inventory_days: invDays,
              is_apparel: isApparel,
              is_dangerous_goods: isDg,
            });
            storLine.amount_usd = stPeak.status === 'verified' ? stPeak.per_unit_usd : st.per_unit_usd;
            delete ledger.pkg;
          } else {
            storLine.amount_usd = st.per_unit_usd;
            if (storLine.fee_basis && typeof storLine.fee_basis === 'object') {
              storLine.fee_basis.cubic_feet_per_unit = st.cubic_feet;
              storLine.fee_basis.rate_usd_per_cuft_month = st.rate_usd_per_cuft_month;
              storLine.fee_basis.average_inventory_days = invDays;
              if (storLine.fee_basis.size_tier !== undefined) storLine.fee_basis.size_tier = st.size_tier;
              if (storLine.fee_basis.pkg && typeof storLine.fee_basis.pkg === 'object') storLine.fee_basis.pkg = { ...officialPkg };
            }
          }
          mutated = true;
        }
      }

      const retLine = lines.find(l => l?.id === 'returns_processing');
      if (retLine && retLine.status !== 'pending') {
        const rPhys = finite(ledger.physical_return_fraction) ? ledger.physical_return_fraction : (ledger.refund_fraction ?? 0);
        const catName = retLine.fee_basis?.fee_category ?? retLine.fee_category ?? ledger.fee_category ?? 'Everything Else';
        const ret = lookupUnifiedReturnsProcessing2027({
          pkg: officialPkg,
          physical_return_fraction: rPhys,
          fee_category: catName,
          is_apparel_or_shoes: isApparel,
          is_dangerous_goods: isDg,
        });
        if (ret.status === 'verified') {
          retLine.amount_usd = ret.expected_fee_per_shipped_unit_usd;
          if (ret.return_threshold !== null) {
            retLine.return_threshold = ret.return_threshold;
            if (retLine.fee_basis && typeof retLine.fee_basis === 'object' && retLine.fee_basis.return_threshold !== undefined) {
              retLine.fee_basis.return_threshold = ret.return_threshold;
            }
          }
          if (ret.per_return_fee_usd !== null) {
            if (retLine.per_return_fee_usd !== undefined || ret.expected_fee_per_shipped_unit_usd > 0) {
              retLine.per_return_fee_usd = ret.per_return_fee_usd;
            }
            if (retLine.fee_basis && typeof retLine.fee_basis === 'object') {
              if (retLine.fee_basis.per_return_fee_usd !== undefined || ret.expected_fee_per_shipped_unit_usd > 0) {
                retLine.fee_basis.per_return_fee_usd = ret.per_return_fee_usd;
              }
              if (retLine.fee_basis.pkg && typeof retLine.fee_basis.pkg === 'object') {
                retLine.fee_basis.pkg = { ...officialPkg };
              }
            }
          }
          mutated = true;
        }
      }

      const hhLine = lines.find(l => l?.id === 'headhaul');
      if (hhLine && hhLine.status !== 'pending') {
        const rawHh = hhLine.cny_derivation ?? ledger.headhaul ?? ledger.source_inputs?.headhaul ?? null;
        if (rawHh && typeof rawHh === 'object' && finite(rawHh.rate_cny_per_kg)) {
          const actualKg = Number((officialPkg.unit_weight_lb * 0.45359237).toFixed(6));
          const volKg = Number(((officialPkg.length_in * 2.54 * officialPkg.width_in * 2.54 * officialPkg.height_in * 2.54) / (rawHh.volumetric_divisor ?? 6000)).toFixed(6));
          const updatedHh = {
            ...rawHh,
            actual_weight_kg_per_unit: actualKg,
            chargeable_kg_per_unit: Math.max(rawHh.chargeable_kg_per_unit ?? 0, actualKg, volKg),
          };
          const procLine = lines.find(l => l?.id === 'procurement');
          const effFx = updatedHh.fx ?? updatedHh.fx_cny_per_usd ?? ledger.fx_cny_per_usd ?? ledger.source_inputs?.fx_cny_per_usd ?? procLine?.fx_cny_per_usd;
          const effUnits = updatedHh.order_units ?? ledger.order_units ?? procLine?.order_units ?? 100;
          const hhCalc = computeHeadhaulWithA4Rules(updatedHh, effFx, effUnits, { isR58: true, isR59: effectiveRev >= 59 });
          if (hhCalc.amount_usd !== null && !hhCalc.missing_surcharge_quote) {
            hhLine.amount_usd = hhCalc.amount_usd;
            if (hhLine.cny_derivation) hhLine.cny_derivation = updatedHh;
            if (ledger.headhaul) ledger.headhaul = updatedHh;
            if (ledger.source_inputs?.headhaul) ledger.source_inputs.headhaul = updatedHh;
            mutated = true;
          }
        }
      }
    }

    if (mutated) {
      const colLine = lines.find(l => l?.id === 'collection');
      if (colLine && colLine.status !== 'pending' && finite(ledger.collection_rate) && ledger.collection_rate >= 0) {
        const r = finite(ledger.refund_fraction) ? ledger.refund_fraction : 0;
        const refAmt = lines.find(l => l?.id === 'referral' && l.status !== 'pending')?.amount_usd ?? 0;
        const adminFrac = ledger.referral_terms?.refund_admin_fraction ?? 0.20;
        const adminCap = ledger.referral_terms?.refund_admin_cap_usd ?? 5.00;
        const adminExpected = r * Math.min(adminCap, refAmt * adminFrac);
        const fbaSum = ['fulfillment', 'placement', 'storage', 'returns_processing', 'return_disposition']
          .reduce((acc, k) => {
            const ln = lines.find(x => x?.id === k);
            return (ln && ln.status !== 'pending' && ln.status !== 'deferred' && finite(ln.amount_usd)) ? acc + ln.amount_usd : acc;
          }, 0);
        const otherAmz = lines
          .filter(x => x?.id === 'other_applicable' && x.payee !== 'external' && x.status !== 'pending' && finite(x.amount_usd))
          .reduce((acc, x) => acc + x.amount_usd, 0);
        const payout = netP * (1 - r) - refAmt * (1 - r) - adminExpected - fbaSum - otherAmz;
        colLine.amount_usd = Number((Math.max(0, payout) * ledger.collection_rate).toFixed(6));
      }
      try {
        const recalc = calculateEconomics(ledger, { requireFeeBasis: false, profileRevision: effectiveRev });
        if (recalc.margin !== null && sc.margin && typeof sc.margin === 'object') {
          sc.margin = { ...sc.margin, value: recalc.margin };
        }
        if (recalc.contribution_usd !== null && sc.contribution_usd && typeof sc.contribution_usd === 'object') {
          sc.contribution_usd = { ...sc.contribution_usd, value: recalc.contribution_usd };
        }
      } catch {
        delete sc.margin;
        delete sc.contribution_usd;
      }
    }
  };

  const builtCandidates = rawCandidateEntries.map((entry, idx) => {
    const cand = structuredClone(entry.candidate ?? entry);
    if (!nonemptyStr(cand?.id)) throw new TypeError(`Candidate #${idx + 1} requires a nonempty id.`);

    // Enforce #4 purchase_demand_scale total comparable sales rule (never single-color / single-child / median).
    const demandScaleMetric = cand?.metrics?.purchase_demand_scale;
    if (demandScaleMetric && typeof demandScaleMetric === 'object') {
      const dsTags = [
        demandScaleMetric.grain,
        demandScaleMetric.scope,
        demandScaleMetric.basis,
        demandScaleMetric.statistic,
        demandScaleMetric.aggregation,
      ].filter(v => typeof v === 'string').map(v => v.trim().toLowerCase());
      const hasForbiddenSingleOrMedian = dsTags.some(t =>
        t === 'single_color_child_median' ||
        t === 'single_child' ||
        t === 'single_variant' ||
        t === 'child_median' ||
        t === 'median' ||
        t.includes('single_color') ||
        t.includes('median'),
      );
      if (hasForbiddenSingleOrMedian) {
        throw new TypeError(
          `Candidate "${cand.id}" metrics.purchase_demand_scale cannot use single-variant or median statistics (${dsTags.join(', ')}); #4 purchase_demand_scale requires category comparable total/parent sales.`,
        );
      }
      if (demandScaleMetric.grain === 'target_child_units' && !Array.isArray(demandScaleMetric.value_range)) {
        throw new TypeError(
          `Candidate "${cand.id}" metrics.purchase_demand_scale cannot use point target_child_units without a coherent niche value_range; single-child metrics belong only to Q31.`,
        );
      }
    }

    // Wire niche_average_star_reference (r20), Q31 dual-source keyword_counts (r48/r50), and Q31 Vine/VP/直评 breakdown when raw inputs are supplied.
    if (Array.isArray(entry.niche_comparable_rows) && entry.niche_comparable_rows.length > 0) {
      const starRef = extractNicheAverageStarReference(entry.niche_comparable_rows);
      if (starRef && !cand?.presentation?.niche_average_star_reference) {
        cand.presentation = { ...(cand.presentation ?? {}), niche_average_star_reference: starRef };
      }
    }
    if (Array.isArray(cand?.newcomer_cohort?.members)) {
      const extractBundleAsin = (src, depth = 0) => {
        if (!src || typeof src !== 'object' || Array.isArray(src) || depth > 3) return null;
        if (typeof src.asin === 'string' && src.asin.trim().length > 0) {
          return src.asin.trim().toUpperCase();
        }
        if (src.data && typeof src.data === 'object') {
          const nested = extractBundleAsin(src.data, depth + 1);
          if (nested) return nested;
        }
        if (src.structuredContent && typeof src.structuredContent === 'object') {
          const nested = extractBundleAsin(src.structuredContent, depth + 1);
          if (nested) return nested;
        }
        if (Array.isArray(src.content)) {
          for (const block of src.content) {
            if (!block || block.isError === true || typeof block.text !== 'string') continue;
            const trimmed = block.text.trim();
            if (!trimmed.startsWith('{')) continue;
            try {
              const nested = extractBundleAsin(JSON.parse(trimmed), depth + 1);
              if (nested) return nested;
            } catch {
              // Ignore non-JSON text blocks.
            }
          }
        }
        return null;
      };
      const reviewSourceByAsin = new Map();
      if (entry.q31_review_sources && typeof entry.q31_review_sources === 'object') {
        for (const [k, v] of Object.entries(entry.q31_review_sources)) {
          const normKey = typeof k === 'string' && k.trim().length > 0 ? k.trim().toUpperCase() : null;
          if (normKey && v !== undefined && v !== null) reviewSourceByAsin.set(normKey, v);
        }
      }
      cand.newcomer_cohort.members = cand.newcomer_cohort.members.map(member => {
        if (!member || typeof member !== 'object') return member;
        const memberAsin = typeof member.asin === 'string' && member.asin.trim().length > 0
          ? member.asin.trim().toUpperCase()
          : null;
        const rawMappedSource = entry.q31_review_sources?.[member.asin];
        const reviewSource = rawMappedSource !== undefined && rawMappedSource !== null
          ? rawMappedSource
          : (memberAsin ? reviewSourceByAsin.get(memberAsin) : undefined);
        const hasExternalReviewSource = reviewSource !== undefined && reviewSource !== null;
        const inlineEnvelope = (member.structuredContent || Array.isArray(member.content))
          ? { structuredContent: member.structuredContent, content: member.content }
          : null;
        const bundlesToCheck = hasExternalReviewSource
          ? [reviewSource]
          : [member.reviews_raw, member.data, inlineEnvelope].filter(Boolean);
        for (const bundle of bundlesToCheck) {
          const sourceAsin = extractBundleAsin(bundle);
          if (memberAsin && sourceAsin && sourceAsin !== memberAsin) {
            throw new TypeError(
              `Candidate "${cand.id}" Q31 review source ASIN (${sourceAsin}) does not match newcomer member ASIN (${memberAsin}).`,
            );
          }
        }
        const reviewInput = hasExternalReviewSource
          ? {
            ...sanitizeNewcomerMemberReviews(member),
            reviews_raw: reviewSource,
            review_origin_breakdown: undefined,
          }
          : member;
        const outMember = sanitizeNewcomerMemberReviews(reviewInput);
        if (!outMember.review_origin_breakdown) {
          const fallbackBreakdown = extractNewcomerReviewOriginBreakdown(outMember);
          if (fallbackBreakdown) outMember.review_origin_breakdown = fallbackBreakdown;
        }
        const nat = outMember.natural_visibility ?? outMember.natural;
        if (nat && typeof nat === 'object' && !nat.keyword_counts && entry.q31_keyword_sources?.[outMember.asin]) {
          const kc = extractQ31DualSourceKeywordCounts(entry.q31_keyword_sources[outMember.asin]);
          if (kc) nat.keyword_counts = kc;
        }
        return outMember;
      });
    }
    delete cand.q31_review_sources;

    if (entry.qualitative_inputs) {
      const qual = resolveStage1QualitativeJudgments({
        default_target_variant_asin: cand?.screening?.reference_price_usd?.target_variant_asin ?? cand?.target_variant_asin ?? null,
        default_target_variant_sku: cand?.screening?.reference_price_usd?.target_variant_sku ?? cand?.target_variant_sku ?? cand?.economics?.target_variant_sku ?? null,
        ...entry.qualitative_inputs,
      });
      cand.judgments = { ...(cand.judgments ?? {}), ...qual.judgments };
      if (qual.objective_tags.length > 0) {
        cand.presentation = {
          ...(cand.presentation ?? {}),
          risks: [...(cand.presentation?.risks ?? []), ...qual.objective_tags],
        };
      }
    }

    if (entry.bid_plan_inputs) {
      try {
        cand.bids = extractSifThreeTierBidPlan(entry.bid_plan_inputs);
      } catch (err) {
        if (!isMissingFieldIngestError(err)) throw err;
        const reason = `Candidate "${cand.id}" bid_plan_inputs missing required field (${err.message}); isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
      }
    }

    if (entry.monthly_archive_market_raw) {
      try {
        cand.market = {
          ...(cand.market ?? {}),
          ...ingestSellerSpriteMonthlyArchiveMarket(entry.monthly_archive_market_raw, entry.monthly_archive_market_options ?? {}),
        };
      } catch (err) {
        if (!isMissingFieldIngestError(err)) throw err;
        const reason = `Candidate "${cand.id}" monthly_archive_market_raw missing required field (${err.message}); isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
      }
    }

    const entryCandPayloads = rawPayloads.length > 0
      ? (Array.isArray(entry.raw_receipt_files) && entry.raw_receipt_files.length > 0
        ? entry.raw_receipt_files.map(fp => rawPayloadByResolvedPath.get(resolve(baseDir, String(fp)))).filter(Boolean)
        : rawPayloads)
      : [];
    const entryAsOfDate = resolveCandidateReferenceAsOfDate(cand, entry?.as_of_date ?? spec.as_of_date ?? null);
    const entryKeepaByAsin = entryCandPayloads.length > 0
      ? extractKeepaFactsByAsinFromPayloads(entryCandPayloads, { asOfDate: entryAsOfDate })
      : new Map();
    if (entryKeepaByAsin.size > 0) {
      const keepaPeerFacts = {};
      for (const [kAsin, kParsed] of entryKeepaByAsin.entries()) {
        keepaPeerFacts[kAsin] = buildKeepaPeerFactsForMarketJudge(kParsed);
      }
      cand.keepa_peer_facts_by_asin = keepaPeerFacts;
      if (Array.isArray(cand?.newcomer_cohort?.members)) {
        for (const member of cand.newcomer_cohort.members) {
          const mAsin = nonemptyStr(member?.asin) ? member.asin.trim().toUpperCase() : null;
          const mKeepa = mAsin ? entryKeepaByAsin.get(mAsin) : null;
          if (mKeepa?.review_trajectory?.has_drop_event && member.keepa_review_drop_detected === undefined) {
            member.keepa_review_drop_detected = true;
          }
        }
      }
    }
    if (Array.isArray(entry.peer_listings) && entry.peer_listings.length > 0) {
      const mergedPeers = mergeKeepaPayloadsIntoPeerListings(entry.peer_listings, entryCandPayloads, {
        as_of_date: entryAsOfDate,
      });
      cand.price_band_analysis = analyzeMainstreamPriceBand(mergedPeers, {
        ...(entryAsOfDate ? { as_of_date: entryAsOfDate } : {}),
        ...(entry.price_band_options ?? {}),
      });
    }
    const targetVariantAsin = nonemptyStr(entry.sp_api_calibration_inputs?.asin)
      ? entry.sp_api_calibration_inputs.asin.trim().toUpperCase()
      : (nonemptyStr(cand?.screening?.reference_price_usd?.target_variant_asin)
        ? cand.screening.reference_price_usd.target_variant_asin.trim().toUpperCase()
        : null);
    let autoSpCatalogRaw = null;
    const autoSpFeesCandidates = [];
    let autoSpRestrictionsRaw = null;
    const findSpApiErrorsDeep = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 5) return null;
      if (Array.isArray(obj.errors) && obj.errors.length > 0 &&
        (obj.code === undefined || !['OK', '0', 0, 200].includes(obj.code)) &&
        !Array.isArray(obj.items)) {
        return obj.errors[0];
      }
      for (const k of ['structuredContent', 'data', 'result', 'response', 'payload']) {
        const hit = findSpApiErrorsDeep(obj[k], depth + 1);
        if (hit) return hit;
      }
      if (Array.isArray(obj.content)) {
        for (const blk of obj.content) {
          if (typeof blk?.text === 'string') {
            const st = blk.text.trim();
            if (st.startsWith('{') || st.startsWith('[')) {
              try {
                const hit = findSpApiErrorsDeep(JSON.parse(st), depth + 1);
                if (hit) return hit;
              } catch { /* ignore */ }
            }
          }
        }
      }
      return null;
    };
    let hasUpstreamSpApiError = false;
    if (entryCandPayloads.length > 0) {
      for (const item of entryCandPayloads) {
        const rawP = item?.payload ?? item;
        if (!rawP || typeof rawP !== 'object') continue;
        const spErr = findSpApiErrorsDeep(rawP);
        if (spErr) {
          const reason = `Candidate "${cand.id}" includes an upstream SP-API error receipt (${spErr?.code ?? spErr?.message ?? 'SP_API_ERROR'}); finalist calibration isolated to pending.`;
          ensureCandidatePendingShellOnMissingFields(cand, reason);
          isolatedCandidates.push({ candidate_id: cand.id, reason });
          hasUpstreamSpApiError = true;
          break;
        }
        const unw = unwrapMcpEnvelope(rawP);
        if (!unw || typeof unw !== 'object') continue;
        if (targetVariantAsin) {
          if (!autoSpCatalogRaw && nonemptyStr(unw.asin) && unw.asin.trim().toUpperCase() === targetVariantAsin &&
            (Array.isArray(unw.dimensions) || unw.attributes?.item_package_dimensions || unw.attributes?.item_package_weight)) {
            autoSpCatalogRaw = rawP;
          }
          const isNativeFeesArray = Array.isArray(unw) && unw.some(x => x && typeof x === 'object' && (x.FeesEstimateResult || x.FeesEstimateIdentifier || x.FeesEstimate));
          if (isNativeFeesArray || unw.FeesEstimateResult || unw.FeesEstimateResultList || unw.payload?.FeesEstimateResult || unw.payload?.FeesEstimateResultList) {
            autoSpFeesCandidates.push(rawP);
          }
          if (!autoSpRestrictionsRaw && Array.isArray(unw.restrictions)) {
            if (!nonemptyStr(unw.asin) || unw.asin.trim().toUpperCase() === targetVariantAsin) {
              autoSpRestrictionsRaw = rawP;
            }
          }
        }
      }
    }
    const autoSpFeesRaw = autoSpFeesCandidates.length === 0
      ? null
      : (autoSpFeesCandidates.length === 1
        ? autoSpFeesCandidates[0]
        : {
            FeesEstimateResultList: autoSpFeesCandidates.flatMap(fp => {
              const u = unwrapMcpEnvelope(fp);
              if (Array.isArray(u)) return u;
              if (Array.isArray(u?.FeesEstimateResultList)) return u.FeesEstimateResultList;
              if (Array.isArray(u?.payload?.FeesEstimateResultList)) return u.payload.FeesEstimateResultList;
              return [u?.FeesEstimateResult ?? u?.payload?.FeesEstimateResult ?? u];
            }),
          });
    const mergedSpInputs = (entry.sp_api_calibration_inputs && typeof entry.sp_api_calibration_inputs === 'object')
      ? {
          asin: targetVariantAsin,
          price_usd: cand?.screening?.reference_price_usd?.value ?? null,
          ...(autoSpCatalogRaw ? { catalogItemRaw: autoSpCatalogRaw } : {}),
          ...(autoSpFeesRaw ? { feesEstimateRaw: autoSpFeesRaw } : {}),
          ...(autoSpRestrictionsRaw ? { restrictionsRaw: autoSpRestrictionsRaw } : {}),
          ...entry.sp_api_calibration_inputs,
        }
      : ((autoSpCatalogRaw || autoSpFeesRaw || autoSpRestrictionsRaw)
        ? {
            asin: targetVariantAsin,
            price_usd: cand?.screening?.reference_price_usd?.value ?? null,
            catalogItemRaw: autoSpCatalogRaw,
            feesEstimateRaw: autoSpFeesRaw,
            restrictionsRaw: autoSpRestrictionsRaw,
          }
        : null);

    const wantsEvergreen2027 = effectiveRev >= 59 && Boolean(
      entry.evergreen_2027 ||
      entry.product_seasonality === 'evergreen' ||
      cand.product_seasonality === 'evergreen' ||
      entry.is_evergreen === true ||
      cand.is_evergreen === true,
    );
    let activeEvergreen2027 = entry.evergreen_2027
      ? structuredClone(entry.evergreen_2027)
      : (wantsEvergreen2027 && entry.paired_seasonal ? structuredClone(entry.paired_seasonal) : null);
    let activePairedSeasonal = !activeEvergreen2027 && entry.paired_seasonal
      ? structuredClone(entry.paired_seasonal)
      : null;
    if (mergedSpInputs && !hasUpstreamSpApiError) {
      let spCal = null;
      try {
        spCal = extractSpApiFinalistCalibration(mergedSpInputs);
      } catch (err) {
        if (!isMissingFieldIngestError(err)) throw err;
        const reason = `Candidate "${cand.id}" SP-API calibration error (${err.message}); isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
      }
      if (spCal) {
        cand.sp_api_calibration = spCal;
      if (spCal.stale_sellersprite_audit?.stale_sellersprite_cache_corrected === true) {
        const noteStr = `SP-API 官方包装尺寸纠偏：${spCal.asin ? `${spCal.asin} ` : ''}卖家精灵旧缓存重 ${spCal.stale_sellersprite_audit.sellersprite_cached_weight_lb} lb（2027 FBA $${spCal.stale_sellersprite_audit.sellersprite_cached_fba_2027_usd}），SP-API 官方库实测为 ${spCal.stale_sellersprite_audit.sp_api_official_weight_lb} lb（2027 FBA $${spCal.stale_sellersprite_audit.sp_api_official_fba_2027_usd}）。`;
        cand.review_notes = [...(Array.isArray(cand.review_notes) ? cand.review_notes : []), noteStr];
      }
      if (spCal.restrictions?.hard_category_ban === true) {
        cand.presentation = {
          ...(cand.presentation ?? {}),
          risks: [...new Set([...(cand.presentation?.risks ?? []), 'SP-API 命中强制禁售限制'])],
        };
        const fallbackEv = cand.judgments?.applicable_public_requirements?.evidence
          ?? cand?.screening?.reference_price_usd?.evidence
          ?? [];
        cand.judgments = {
          ...(cand.judgments ?? {}),
          applicable_public_requirements: {
            ...(cand.judgments?.applicable_public_requirements ?? {}),
            anchor: 0,
            proven_conflict: true,
            hard_ban: true,
            reason: 'SP-API listingsRestrictions 命中我方自有白牌强制类目/法规禁售限制。',
            evidence: fallbackEv,
          },
        };
      } else if (spCal.restrictions?.white_label_note) {
        cand.review_notes = [...(Array.isArray(cand.review_notes) ? cand.review_notes : []), spCal.restrictions.white_label_note];
      }

      if (spCal.official_pkg || spCal.fee_calibration?.referral_fraction || mergedSpInputs.feesEstimateRaw) {
        const rawFeesForLookup = mergedSpInputs.feesEstimateRaw ?? null;
        for (const builderObj of [activeEvergreen2027, activePairedSeasonal]) {
          if (!builderObj) continue;
          if (spCal.official_pkg) {
            builderObj.cubic_feet_per_unit = Number(
              ((spCal.official_pkg.length_in * spCal.official_pkg.width_in * spCal.official_pkg.height_in) / 1728).toFixed(6),
            );
            const offTier = spCal.local_2027_off_peak_fulfillment?.size_tier ?? classifySizeTier2027(spCal.official_pkg)?.size_tier;
            if (offTier) builderObj.size_tier = offTier;
          }
          const bScens = Array.isArray(builderObj.off_peak_scenarios) ? builderObj.off_peak_scenarios : builderObj.scenarios;
          if (Array.isArray(bScens)) {
            for (const sc of bScens) {
              applySpApiCalibrationToScenario(sc, spCal, rawFeesForLookup);
            }
          }
        }
        if (Array.isArray(cand?.economics?.scenarios)) {
          for (const sc of cand.economics.scenarios) {
            applySpApiCalibrationToScenario(sc, spCal, rawFeesForLookup);
          }
        }
        if (Array.isArray(cand?.economics?.operating_periods)) {
          for (const op of cand.economics.operating_periods) {
            if (Array.isArray(op?.scenarios)) {
              for (const sc of op.scenarios) {
                applySpApiCalibrationToScenario(sc, spCal, rawFeesForLookup);
              }
            }
          }
        }
      }
      }
    }

    const rawAutoSpPeers = entryCandPayloads.length > 0
      ? extractSpApiPeerPackagesFromRawPayloads(entryCandPayloads)
      : [];
    const combinedPeerList = [
      ...rawAutoSpPeers,
      ...(cand.sp_api_calibration?.official_pkg ? [cand.sp_api_calibration.official_pkg] : []),
      ...(Array.isArray(entry.peer_package_inputs?.peers) ? entry.peer_package_inputs.peers : []),
    ];
    if (combinedPeerList.length > 0 && (entry.peer_package_inputs || rawAutoSpPeers.length > 0 || cand.sp_api_calibration?.official_pkg)) {
      try {
        const peerPkgSummary = computeMatchedPeerMedianPackage(combinedPeerList, {
          supplier_nominal_pkg: entry.peer_package_inputs?.supplier_nominal_pkg ?? null,
        });
        cand.peer_package_calibration = peerPkgSummary;
        if (peerPkgSummary.sample_warning_tag) {
          cand.presentation = {
            ...(cand.presentation ?? {}),
            risks: [...new Set([...(cand.presentation?.risks ?? []), peerPkgSummary.sample_warning_tag])],
          };
        }
      } catch (err) {
        if (!isMissingFieldIngestError(err)) throw err;
        const reason = `Candidate "${cand.id}" peer_package_inputs missing valid package dimensions (${err.message}); isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
      }
    }

    const dbConstraints = dbFormConstraintsById.get(cand.id) ?? null;
    if (effectiveRev >= 59 && dbConstraints?.dbFormSpec) {
      const s = dbConstraints.dbFormSpec;
      if (cand.buyer_task === undefined && s.buyer_task) cand.buyer_task = s.buyer_task;
      if (cand.saleable_set_composition === undefined && s.saleable_set_composition) {
        cand.saleable_set_composition = structuredClone(s.saleable_set_composition);
      }
      if (cand.grade_or_material === undefined && s.grade_or_material !== null) cand.grade_or_material = s.grade_or_material;
      if (cand.target_child_asin === undefined && s.target_child_asin !== null) cand.target_child_asin = s.target_child_asin;
      if (cand.leaf_node_path === undefined && s.leaf_node_path !== null) cand.leaf_node_path = s.leaf_node_path;
      if (cand.spec_sha256 === undefined && s.spec_sha256) cand.spec_sha256 = s.spec_sha256;
    }
    if (activeEvergreen2027) {
      const mergedReqQuotes = [
        ...(Array.isArray(activeEvergreen2027.required_quote_ids) ? activeEvergreen2027.required_quote_ids : []),
        ...((dbConstraints?.verifiedQuoteIds?.length ?? 0) > 1 ? dbConstraints.verifiedQuoteIds : []),
      ];
      const mergedReqPrices = [
        ...(Array.isArray(activeEvergreen2027.required_prices_usd) ? activeEvergreen2027.required_prices_usd : []),
        ...(dbConstraints?.declaredPricesUsd ?? []),
      ];
      try {
        cand.economics = buildEvergreen2027OffPeakEconomics({
          profile_revision: effectiveRev,
          ...activeEvergreen2027,
          ...(mergedReqQuotes.length > 0 ? { required_quote_ids: mergedReqQuotes } : {}),
          ...(mergedReqPrices.length > 0 ? { required_prices_usd: mergedReqPrices } : {}),
        });
        cand.product_seasonality = 'evergreen';
        cand.unpublished_2027_q4_peak_note = cand.economics.unpublished_2027_q4_peak_note;
      } catch (err) {
        if (!isMissingFieldIngestError(err)) throw err;
        const reason = `Candidate "${cand.id}" evergreen_2027 missing required field (${err.message}); isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
      }
    } else if (activePairedSeasonal) {
      const mergedReqQuotes = [
        ...(Array.isArray(activePairedSeasonal.required_quote_ids) ? activePairedSeasonal.required_quote_ids : []),
        ...((dbConstraints?.verifiedQuoteIds?.length ?? 0) > 1 ? dbConstraints.verifiedQuoteIds : []),
      ];
      const mergedReqPrices = [
        ...(Array.isArray(activePairedSeasonal.required_prices_usd) ? activePairedSeasonal.required_prices_usd : []),
        ...(dbConstraints?.declaredPricesUsd ?? []),
      ];
      try {
        cand.economics = buildPairedSeasonalOperatingPeriods({
          profile_revision: effectiveRev,
          ...activePairedSeasonal,
          ...(mergedReqQuotes.length > 0 ? { required_quote_ids: mergedReqQuotes } : {}),
          ...(mergedReqPrices.length > 0 ? { required_prices_usd: mergedReqPrices } : {}),
        });
      } catch (err) {
        if (!isMissingFieldIngestError(err)) throw err;
        const reason = `Candidate "${cand.id}" paired_seasonal missing required field (${err.message}); isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
      }
    }

    if (!cand.economics || (!Array.isArray(cand.economics.scenarios) && !Array.isArray(cand.economics.operating_periods)) ||
      (Array.isArray(cand.economics.scenarios) && cand.economics.scenarios.length === 0 && !cand.economics.expected_primary_scenarios) ||
      !nonemptyStr(cand.economics.saleable_unit)) {
      const reason = `Candidate "${cand.id}" is missing required economics/scenarios fields; isolated to pending without aborting batch.`;
      ensureCandidatePendingShellOnMissingFields(cand, reason);
      isolatedCandidates.push({ candidate_id: cand.id, reason });
    }

    const parityCheck = enforceCandidateContainerMatrixAndDbParity(cand, {
      dbConstraints,
      effectiveRev,
    });
    if (parityCheck.unverifiedUiQuoteUsed) {
      unverifiedUiQuoteCandidateIds.add(cand.id);
    }
    if (parityCheck.isolatedReason) {
      isolatedCandidates.push({ candidate_id: cand.id, reason: parityCheck.isolatedReason });
    }

    if (rawPayloads.length > 0) {
      let candPayloads = rawPayloads;
      if (Array.isArray(entry.raw_receipt_files) && entry.raw_receipt_files.length > 0) {
        candPayloads = entry.raw_receipt_files.map(fp => {
          const absPath = resolve(baseDir, String(fp));
          const found = rawPayloadByResolvedPath.get(absPath);
          if (!found) {
            throw new TypeError(
              `Candidate "${cand.id}" references raw_receipt_files entry "${fp}" that is not declared in top-level raw_receipt_files.`,
            );
          }
          return found;
        });
      } else if (!allowSynthetic && rawCandidateEntries.length > 1) {
        const reason = `Candidate "${cand.id}" is missing per-candidate raw_receipt_files in multi-candidate batch; isolated to pending.`;
        ensureCandidatePendingShellOnMissingFields(cand, reason);
        isolatedCandidates.push({ candidate_id: cand.id, reason });
        perCandidateVerifiedAsinCounts[cand.id] = 0;
        return cand;
      }
      const candCatalog = candPayloads === rawPayloads
        ? globalCatalog
        : extractVerifiedAsinCatalogFromRawPayloads(candPayloads);
      const candAsins = cand.ingest_isolated_pending === true && !cand?.screening?.reference_price_usd
        ? new Set()
        : assertCandidateRawProvenanceAndPriceBinding(cand, candCatalog, {
            candPayloads,
            extraVerifiedAsins: entry.verified_asins ?? [],
            allowSyntheticIds: allowSynthetic,
            effectiveRev,
            fallbackAsOfDate: entry?.as_of_date ?? spec.as_of_date ?? null,
          });
      if (effectiveRev >= 59) {
        const candLeafNodeIds = new Set();
        const rawRelBsr = String(cand?.newcomer_cohort?.relevant_bsr_node ?? '').trim();
        for (const m of rawRelBsr.matchAll(/\b\d{5,15}\b/g)) candLeafNodeIds.add(m[0]);
        const rawCatLabel = String(cand?.metrics?.low_return_preference?.category ?? '');
        const leafTagMatch = rawCatLabel.match(/leaf\s+(\d{5,15})\b/i) ?? rawCatLabel.match(/\((\d{5,15})\)\s*$/);
        if (leafTagMatch) candLeafNodeIds.add(leafTagMatch[1]);

        const validDemandReceipts = [];
        let hasNoDataDemandReceipt = false;
        for (const item of candPayloads) {
          const rawP = item?.payload;
          let parsedTextObj = null;
          if (Array.isArray(rawP?.content)) {
            for (const block of rawP.content) {
              if (typeof block?.text === 'string') {
                const s = block.text.trim();
                if (s.startsWith('{') && s.endsWith('}')) {
                  try {
                    const p = JSON.parse(s);
                    if (p && typeof p === 'object' && ('ratioComparison' in p || 'ratioComparison' in (p.data ?? {}))) {
                      parsedTextObj = p.data ?? p;
                      break;
                    }
                  } catch { /* ignore */ }
                }
              }
            }
          }
          const rawData = rawP?.structuredContent?.data ?? rawP?.structuredContent ?? rawP?.data ?? parsedTextObj ?? rawP;
          const looksLikeDemand = /(?:demand|compass)/i.test(String(item?.source_id ?? '')) ||
            Boolean(rawData && typeof rawData === 'object' && ('ratioComparison' in rawData || ('goodsTrendItems' in rawData && 'popularKeywordItems' in rawData)));
          if (looksLikeDemand && isPayloadUpstreamFailure(rawP)) {
            throw new TypeError(
              `Candidate "${cand.id}" binds a failed category_demand_report receipt ("${item.source_id}"); upstream errors cannot be treated as NO_DATA fallback.`,
            );
          }
          if (looksLikeDemand && (rawP?.dataStatus === 'NO_DATA' || rawData?.dataStatus === 'NO_DATA' || rawData?.ratioComparison === null)) {
            hasNoDataDemandReceipt = true;
          }
          const unw = unwrapMcpEnvelope(rawP);
          const rc = unw?.ratioComparison;
          if (rc && typeof rc === 'object' && (finite(rc.returnRatio) || finite(rc.avgReturnRatio))) {
            const np = String(unw?.nodePath ?? unw?.categoryId ?? '').trim();
            const tailNode = np.match(/(\d{5,15})\s*$/)?.[1] ?? null;
            validDemandReceipts.push({
              source_id: item?.source_id ?? 'unknown',
              rc,
              leafNodeId: tailNode,
            });
          }
        }

        if (validDemandReceipts.length >= 1) {
          const matchingLeafReceipts = validDemandReceipts.filter(r => r.leafNodeId && candLeafNodeIds.has(r.leafNodeId));
          let expectedReturn = null;
          if (matchingLeafReceipts.length >= 1) {
            const leafVals = matchingLeafReceipts
              .map(r => resolveCategoryReturnWithFallback(r.rc, null, { preferLeafReturnRatio: true }).value)
              .filter(finite);
            if (leafVals.some(v => Math.abs(v - leafVals[0]) > 1e-6)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate ambiguity on candidate "${cand.id}": multiple bound leaf category_demand_report receipts disagree (${leafVals.join(', ')}).`,
              );
            }
            expectedReturn = leafVals[0] ?? null;
          } else if (hasNoDataDemandReceipt) {
            const hasDistinctLeafRate = validDemandReceipts.some(
              r => finite(r.rc.returnRatio) && finite(r.rc.avgReturnRatio) && Math.abs(r.rc.returnRatio - r.rc.avgReturnRatio) > 1e-6,
            );
            if (hasDistinctLeafRate && (candLeafNodeIds.size === 0 || validDemandReceipts.some(r => !r.leafNodeId))) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate check on candidate "${cand.id}": department NO_DATA fallback requires explicit candidate leaf node ID (relevant_bsr_node) and receipt nodePath to prove the valid receipt is not the candidate's own leaf.`,
              );
            }
            const deptVals = validDemandReceipts
              .map(r => resolveCategoryReturnWithFallback(null, r.rc, { preferLeafReturnRatio: true }).value)
              .filter(finite);
            if (deptVals.length === 0) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate check on candidate "${cand.id}": NO_DATA fallback receipt lacks department avgReturnRatio.`,
              );
            }
            if (deptVals.some(v => Math.abs(v - deptVals[0]) > 1e-6)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate ambiguity on candidate "${cand.id}": bound fallback category_demand_report receipts have conflicting avgReturnRatio values (${deptVals.join(', ')}).`,
              );
            }
            expectedReturn = deptVals[0];
          } else if (validDemandReceipts.length > 1) {
            throw new TypeError(
              `Revision 59 leaf-first return-rate ambiguity on candidate "${cand.id}": ${validDemandReceipts.length} category_demand_report receipts bound without matching candidate leaf node (${[...candLeafNodeIds].join(',') || 'none'}); set newcomer_cohort.relevant_bsr_node or bind only the candidate's leaf report.`,
            );
          } else {
            const only = validDemandReceipts[0];
            if (only.leafNodeId && candLeafNodeIds.size > 0 && !candLeafNodeIds.has(only.leafNodeId)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate mismatch on candidate "${cand.id}": bound category_demand_report node (${only.leafNodeId}) disagrees with candidate leaf node (${[...candLeafNodeIds].join(',')}) without a NO_DATA leaf receipt.`,
              );
            }
            expectedReturn = resolveCategoryReturnWithFallback(only.rc, null, { preferLeafReturnRatio: true }).value;
          }

          if (expectedReturn !== null) {
            const suppliedPref = cand?.metrics?.low_return_preference?.value;
            if (cand?.metrics?.low_return_preference?.applicable !== false && (!finite(suppliedPref) || Math.abs(suppliedPref - expectedReturn) > 1e-6)) {
              throw new TypeError(
                `Revision 59 leaf-first return-rate parity violation on candidate "${cand.id}": metrics.low_return_preference.value (${suppliedPref}) disagrees with bound category_demand_report (${expectedReturn}); fix low_return_preference to match resolveCategoryReturnWithFallback.`,
              );
            }
            for (const sc of collectPrimaryScenariosForPriceCheck(cand)) {
              const scRef = sc?.cost_ledger?.refund_fraction;
              if (finite(scRef) && Math.abs(scRef - expectedReturn) > 1e-6) {
                throw new TypeError(
                  `Revision 59 leaf-first return-rate parity violation on candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}": refund_fraction (${scRef}) disagrees with bound category_demand_report (${expectedReturn}).`,
                );
              }
              const scPhys = sc?.cost_ledger?.physical_return_fraction;
              if (finite(scPhys) && Math.abs(scPhys - expectedReturn) > 1e-6) {
                throw new TypeError(
                  `Revision 59 leaf-first return-rate parity violation on candidate "${cand.id}" scenario "${sc?.id ?? 'unknown'}": physical_return_fraction (${scPhys}) disagrees with bound category_demand_report (${expectedReturn}).`,
                );
              }
            }
          }
        }
      }
      perCandidateVerifiedAsinCounts[cand.id] = candAsins.size;
    } else {
      perCandidateVerifiedAsinCounts[cand.id] = 0;
    }

    return cand;
  });

  const batch = {
    schema_version: 1,
    profile_revision: spec.profile_revision ?? profile.revision,
    ...(spec.presentation ? { presentation: spec.presentation } : {}),
    ...(effectiveRev < 59 && Array.isArray(spec.negotiation_shortlist) ? { negotiation_shortlist: spec.negotiation_shortlist } : {}),
    ...(Array.isArray(spec.packaging_redesign_shortlist) ? { packaging_redesign_shortlist: spec.packaging_redesign_shortlist } : {}),
    candidates: builtCandidates,
  };

  const scored = scoreBatch(batch, profile);
  if (effectiveRev >= 59 && unverifiedUiQuoteCandidateIds.size > 0) {
    const falselyQualifying = (scored?.candidates ?? []).filter(
      c => unverifiedUiQuoteCandidateIds.has(c?.candidate_id ?? c?.id) && c?.qualification?.counts_toward_target === true,
    );
    if (falselyQualifying.length > 0) {
      throw new TypeError(
        `Revision 59 prohibits counts_toward_target qualification from SQLite 1688 quote(s) lacking verified 5-field ui_readback on [${falselyQualifying.map(c => c.candidate_id ?? c.id).join(', ')}].`,
      );
    }
  }
  return {
    batch,
    scored,
    verified_raw_asin_count: globalCatalog.size,
    per_candidate_verified_asin_counts: perCandidateVerifiedAsinCounts,
    verified_receipt_sha256s: verifiedReceiptSha256s,
    ledger_provenance_verified: resolvedLedgerDb ? unmatchedLedgerReceiptFiles.length === 0 : null,
    unmatched_ledger_receipt_files: unmatchedLedgerReceiptFiles,
    isolated_candidates: isolatedCandidates,
  };
}

