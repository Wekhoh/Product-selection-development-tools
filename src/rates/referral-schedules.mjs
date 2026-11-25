/**
 * Layer 1: Referral fee schedules, tiered referral configuration slots, payout collection math,
 * and verified out-of-table official rule registry. Zero calculator or ledger dependencies.
 */
import { validIsoDate } from '../utils/dates.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round((value + Number.EPSILON) * 1e10) / 1e10;
const isoDate = validIsoDate;

export function fraction(n, name) {
  if (!finite(n) || n < 0 || n >= 1) throw new TypeError(`${name} must be a fraction in [0,1)`);
}

export function netReferral(input) {
  const { price_usd: p, refund_fraction: r, referral_fraction: f,
    refund_admin_fraction: a, refund_admin_cap_usd: cap, minimum_referral_usd: minFee = 0 } = input;
  if (!finite(p) || p <= 0 || !finite(cap) || cap < 0 || !finite(minFee) || minFee < 0) {
    throw new TypeError('Invalid price, minimum referral or refund administration cap');
  }
  fraction(r, 'refund_fraction'); fraction(f, 'referral_fraction'); fraction(a, 'refund_admin_fraction');
  const gross = Math.max(minFee, p * f), credit = gross * r, admin = Math.min(cap, gross * a) * r;
  return { gross_usd: round(gross), refund_credit_usd: round(credit),
    administration_usd: round(admin), net_usd: round(gross - credit + admin) };
}

/** Per-unit estimate of collection on Amazon payout, never on revenue or profit. */
export function collectionFromDisbursement({ net_revenue_usd, amazon_deductions_usd, rate }) {
  if (!finite(net_revenue_usd) || net_revenue_usd < 0 || !Array.isArray(amazon_deductions_usd) ||
    amazon_deductions_usd.some(n => !finite(n) || n < 0)) throw new TypeError('Known nonnegative Amazon payout components required');
  fraction(rate, 'collection rate');
  const deductions = amazon_deductions_usd.reduce((sum, n) => sum + n, 0);
  if (!finite(deductions)) throw new TypeError('Amazon deductions exceed finite numeric range');
  const base = Math.max(0, net_revenue_usd - deductions);
  return { estimated_disbursement_usd: round(base), collection_usd: round(base * rate), rate,
    basis: 'Per-unit payout estimate before collection; excludes off-Amazon procurement, freight and noncash inventory recoveries. Actual account disbursement requires settlement reconciliation.' };
}


/**
 * Out-of-table fallback directive: whenever a candidate hits an unlisted new fee category,
 * tiered referral rule, or future fee schedule announcement, enforce the 3-step verified lookup-and-persist protocol.
 */
export function buildOutOfTableLookupDirective({ reason = '', fee_category = null, asin = null } = {}) {
  return {
    protocol_id: 'spapi_then_official_seller_central_persist_v1',
    fee_category: fee_category ?? null,
    comparable_asin: asin ?? null,
    reason,
    required_steps: [
      '1. Query read-only SP-API (catalogItems_getCatalogItem + productFees_getMyFeesEstimateForASIN + listingsRestrictions) on comparable ASIN(s) for official packaged dimensions, referral percentage, and live FBA baseline.',
      '2. Search official Amazon Seller Central help pages / 2027+ fee announcements to verify the exact published rate card and effective dates, recording explicit source URLs.',
      '3. Calculate using the verified official schedule with source attribution and persist the verified table/rule back into src/rates/.',
    ],
  };
}

const SUPPLEMENTAL_OUT_OF_TABLE_RULES_2027 = new Map();
const OFFICIAL_AMAZON_SOURCE_RE = /^https:\/\/(?:[a-z0-9-]+\.)?(?:sellercentral|sell|advertising|developer-docs)\.amazon\.[a-z.]+\/\S+/i;

export function validateAndComputeOutOfTableRule2027(ruleRecord, { test_price_usd = null } = {}) {
  if (!ruleRecord || typeof ruleRecord !== 'object' || Array.isArray(ruleRecord)) {
    throw new TypeError('Out-of-table rule record must be an object.');
  }
  const feeCategory = typeof ruleRecord.fee_category === 'string' && ruleRecord.fee_category.trim()
    ? ruleRecord.fee_category.trim()
    : null;
  if (!feeCategory) throw new TypeError('Out-of-table rule requires a nonempty fee_category.');
  const sourceUrl = typeof ruleRecord.official_source_url === 'string' ? ruleRecord.official_source_url.trim() : '';
  if (!OFFICIAL_AMAZON_SOURCE_RE.test(sourceUrl)) {
    throw new TypeError(
      'Out-of-table rule requires an official Amazon Seller Central / Sell / Developer Docs HTTPS URL (official_source_url).',
    );
  }
  if (!isoDate(ruleRecord.effective_from)) {
    throw new TypeError('Out-of-table rule requires a valid effective_from date (YYYY-MM-DD).');
  }
  if (ruleRecord.effective_through !== undefined && ruleRecord.effective_through !== null && !isoDate(ruleRecord.effective_through)) {
    throw new TypeError('effective_through must be a valid YYYY-MM-DD date or null.');
  }
  if (isoDate(ruleRecord.effective_through) && ruleRecord.effective_through < ruleRecord.effective_from) {
    throw new TypeError('effective_through cannot precede effective_from.');
  }
  const spApiVerified = ruleRecord.sp_api_verified === true;
  const spApiPendingReason = typeof ruleRecord.sp_api_pending_reason === 'string' ? ruleRecord.sp_api_pending_reason.trim() : '';
  if (!spApiVerified && !spApiPendingReason) {
    throw new TypeError('Out-of-table rule requires sp_api_verified: true (with comparable_asin) or explicit sp_api_pending_reason.');
  }

  let normalizedReferral = null;
  if (ruleRecord.referral_schedule && typeof ruleRecord.referral_schedule === 'object') {
    const sched = ruleRecord.referral_schedule;
    const minRefUsd = finite(sched.minimum_fee_usd) && sched.minimum_fee_usd >= 0 ? sched.minimum_fee_usd : 0.30;
    if (sched.type === 'flat') {
      if (!finite(sched.rate) || sched.rate <= 0 || sched.rate >= 1) {
        throw new TypeError('Flat referral_schedule requires 0 < rate < 1.');
      }
      normalizedReferral = { type: 'flat', rate: sched.rate, minimum_fee_usd: minRefUsd };
    } else if (sched.type === 'tiered') {
      if (!Array.isArray(sched.tiers) || sched.tiers.length < 2) {
        throw new TypeError('Tiered referral_schedule requires at least 2 tiers.');
      }
      let prevCap = 0;
      const tiers = sched.tiers.map((t, idx) => {
        if (!finite(t?.rate) || t.rate <= 0 || t.rate >= 1) {
          throw new TypeError(`Tier #${idx + 1} requires 0 < rate < 1.`);
        }
        const isLast = idx === sched.tiers.length - 1;
        if (!isLast) {
          if (!finite(t.up_to_usd) || t.up_to_usd <= prevCap) {
            throw new TypeError(`Tier #${idx + 1} requires strictly increasing up_to_usd > ${prevCap}.`);
          }
          prevCap = t.up_to_usd;
          return { up_to_usd: t.up_to_usd, rate: t.rate };
        }
        return { up_to_usd: null, rate: t.rate };
      });
      normalizedReferral = { type: 'tiered', tiers, minimum_fee_usd: minRefUsd };
    } else {
      throw new TypeError('referral_schedule.type must be "flat" or "tiered".');
    }
  }

  const returnThreshold = ruleRecord.return_threshold_fraction !== undefined && ruleRecord.return_threshold_fraction !== null
    ? Number(ruleRecord.return_threshold_fraction)
    : null;
  if (returnThreshold !== null && (!finite(returnThreshold) || returnThreshold < 0 || returnThreshold >= 1)) {
    throw new TypeError('return_threshold_fraction must satisfy 0 <= value < 1.');
  }
  if (!normalizedReferral && returnThreshold === null) {
    throw new TypeError('Out-of-table rule must supply referral_schedule and/or return_threshold_fraction.');
  }

  let sampleReferralAtTestPrice = null;
  if (normalizedReferral && finite(test_price_usd) && test_price_usd > 0) {
    if (normalizedReferral.type === 'flat') {
      const feeUsd = Math.max(normalizedReferral.minimum_fee_usd, Math.round(test_price_usd * normalizedReferral.rate * 100) / 100);
      sampleReferralAtTestPrice = {
        price_usd: test_price_usd,
        referral_fee_usd: feeUsd,
        effective_rate: Math.round((feeUsd / test_price_usd) * 1e6) / 1e6,
      };
    } else {
      let remaining = test_price_usd;
      let prev = 0;
      let rawFee = 0;
      for (const tier of normalizedReferral.tiers) {
        if (remaining <= 0) break;
        const slice = tier.up_to_usd === null ? remaining : Math.max(0, Math.min(test_price_usd, tier.up_to_usd) - prev);
        rawFee += slice * tier.rate;
        if (tier.up_to_usd !== null) prev = tier.up_to_usd;
        remaining = Math.max(0, test_price_usd - prev);
      }
      const feeUsd = Math.max(normalizedReferral.minimum_fee_usd, Math.round(rawFee * 100) / 100);
      sampleReferralAtTestPrice = {
        price_usd: test_price_usd,
        referral_fee_usd: feeUsd,
        effective_rate: Math.round((feeUsd / test_price_usd) * 1e6) / 1e6,
      };
    }
  }

  const normalized = {
    fee_category: feeCategory,
    canonical_key: feeCategory.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    official_source_url: sourceUrl,
    official_help_page_id: typeof ruleRecord.official_help_page_id === 'string' ? ruleRecord.official_help_page_id.trim() : null,
    effective_from: ruleRecord.effective_from,
    effective_through: ruleRecord.effective_through ?? null,
    sp_api_verified: spApiVerified,
    comparable_asin: typeof ruleRecord.comparable_asin === 'string' ? ruleRecord.comparable_asin.trim().toUpperCase() : null,
    ...(spApiPendingReason ? { sp_api_pending_reason: spApiPendingReason } : {}),
    ...(normalizedReferral ? { referral_schedule: normalizedReferral } : {}),
    ...(returnThreshold !== null ? { return_threshold_fraction: returnThreshold } : {}),
    verified_at: typeof ruleRecord.verified_at === 'string' && isoDate(ruleRecord.verified_at)
      ? ruleRecord.verified_at
      : '2026-11-25',
  };

  return {
    rule: normalized,
    ...(sampleReferralAtTestPrice ? { sample_referral_calculation: sampleReferralAtTestPrice } : {}),
    code_snippet: `// Verified ${normalized.verified_at} from ${normalized.official_source_url}\n${JSON.stringify({ [normalized.canonical_key]: normalized }, null, 2)}`,
  };
}

export function registerSupplementalOutOfTableRule2027(ruleRecord, options = {}) {
  const validated = validateAndComputeOutOfTableRule2027(ruleRecord, options);
  SUPPLEMENTAL_OUT_OF_TABLE_RULES_2027.set(validated.rule.canonical_key, validated.rule);
  return validated;
}

export function listSupplementalOutOfTableRules2027() {
  return [...SUPPLEMENTAL_OUT_OF_TABLE_RULES_2027.values()];
}

