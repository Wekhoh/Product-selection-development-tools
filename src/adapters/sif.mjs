/**
 * SIF adapter: 3-Tier Progressive Suggested Bid plan extraction & long-tail opportunistic routing.
 */
import { BUSINESS_THRESHOLDS } from '../business-thresholds.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;

/**
Build a Revision 59 3-Tier Progressive Bid payload from raw SIF & SellerSprite rows:
 *  - Tier 1: keeps 1–3 searched mid-core purchase terms in `entries`; moves unbid 5+-word ultra-long-tail terms to `long_tail_opportunistic_terms[]`.
 *  - Tier 2: prefers SIF `cpc_fixed_exact`, automatically falling back to SIF `cpc_raise_exact` (`up_and_down`) when fixed exact is absent.
 *  - Tier 3: supports `entry_scope: 'parent_functional_proxy'` or `unbid_after_all_tiers: true`.
 */
export function extractSifThreeTierBidPlan({
  queries = [],
  evidence = [],
  marketplace = 'US',
  currency = 'USD',
  volume_period = null,
  selection_reason = '3-Tier Progressive Suggested Bid auto-extracted from raw receipts.',
  entry_scope = null,
  proxy_reason = null,
  unbid_after_all_tiers = null,
  unbid_reason = null,
} = {}) {
  const entries = [];
  const opportunistic = [];
  const mainQueriesMeta = [];
  const validQueries = Array.isArray(queries) ? queries.filter(q => q && nonemptyStr(q.query)) : [];
  const queryHasAnyBid = q => {
    const ssExact = finite(q.ss_row?.exactPpc) ? q.ss_row.exactPpc
      : finite(q.ss_row?.ppc?.exact?.value) ? q.ss_row.ppc.exact.value
        : finite(q.ss_exact_usd) ? q.ss_exact_usd : null;
    const sig = q.sif_row?.supporting_signals ?? q.sif_row ?? {};
    const hasSif = finite(sig.cpc_fixed_exact) || finite(sig.cpc_raise_exact);
    const effSs = (q.ss_channel === 'ss_web' && hasSif) ? null : ssExact;
    return effSs !== null || hasSif;
  };
  const nonOpportunisticMainCount = validQueries.filter(q => {
    const wc = q.query.trim().split(/\s+/).length;
    return queryHasAnyBid(q) || (wc < BUSINESS_THRESHOLDS.cpc_opportunistic_min_words && q.is_long_tail_opportunistic !== true);
  }).length;

  for (const q of validQueries) {
    const queryText = q.query.trim();
    const wordCount = queryText.split(/\s+/).length;
    const ssExact = finite(q.ss_row?.exactPpc) ? q.ss_row.exactPpc
      : finite(q.ss_row?.ppc?.exact?.value) ? q.ss_row.ppc.exact.value
        : finite(q.ss_exact_usd) ? q.ss_exact_usd : null;
    const ssLow = finite(q.ss_row?.minExactPpc) ? q.ss_row.minExactPpc : null;
    const ssHigh = finite(q.ss_row?.maxExactPpc) ? q.ss_row.maxExactPpc : null;
    const ssStrategy = q.ss_strategy ?? 'unspecified';

    const sig = q.sif_row?.supporting_signals ?? q.sif_row ?? {};
    const sifFixed = finite(sig.cpc_fixed_exact) ? sig.cpc_fixed_exact : null;
    const sifFixedLow = finite(sig.cpc_fixed_exact_low) ? sig.cpc_fixed_exact_low : null;
    const sifFixedHigh = finite(sig.cpc_fixed_exact_high) ? sig.cpc_fixed_exact_high : null;
    const sifRaise = finite(sig.cpc_raise_exact) ? sig.cpc_raise_exact : null;
    const sifRaiseLow = finite(sig.cpc_raise_exact_low) ? sig.cpc_raise_exact_low : null;
    const sifRaiseHigh = finite(sig.cpc_raise_exact_high) ? sig.cpc_raise_exact_high : null;

    const hasSifTier1Or2 = sifFixed !== null || sifRaise !== null;
    // Tier 3a (`ss_web`) is strictly a fallback when Tier 1/2 lack exact bids; ignore ss_web when SIF Tier 1/2 already returned an exact point!
    const effectiveSsExact = (q.ss_channel === 'ss_web' && hasSifTier1Or2) ? null : ssExact;
    const hasAnyExactBid = effectiveSsExact !== null || hasSifTier1Or2;

    // Tier 1: unbid 5+-word ultra-long-tail queries move to opportunistic list ONLY when >=1 other main entry remains
    // (if the sole 5-word main query is unbid across all tiers, keep it in entries so scoring resolves 0/15 honestly).
    if (!hasAnyExactBid && (wordCount >= BUSINESS_THRESHOLDS.cpc_opportunistic_min_words || q.is_long_tail_opportunistic === true) && nonOpportunisticMainCount >= 1) {
      opportunistic.push({
        query: queryText,
        volume: finite(q.monthly_searches) ? q.monthly_searches : null,
        note: '超长尾蓝海捡漏词（同行未单独建精准词组，不锁死主词竞价 15 分）',
      });
      continue;
    }

    const entry = {
      query: queryText,
      ...(finite(q.monthly_searches) && volume_period ? {
        volume: {
          value: q.monthly_searches,
          unit: 'searches_per_month',
          period: volume_period,
          evidence,
        },
      } : {}),
      sellersprite: effectiveSsExact !== null ? {
        value: effectiveSsExact,
        ...(ssLow !== null && ssHigh !== null ? { low: ssLow, high: ssHigh } : {}),
        unit: 'USD',
        match_type: 'exact',
        strategy: ssStrategy,
        ...(q.ss_channel ? { channel: q.ss_channel } : {}),
        evidence,
      } : null,
      sif: sifFixed !== null ? {
        value: sifFixed,
        ...(sifFixedLow !== null && sifFixedHigh !== null ? { low: sifFixedLow, high: sifFixedHigh } : {}),
        unit: 'USD',
        match_type: 'exact',
        strategy: 'fixed',
        evidence,
      } : sifRaise !== null ? {
        value: null,
        cpc_raise_exact: sifRaise,
        ...(sifRaiseLow !== null && sifRaiseHigh !== null ? {
          cpc_raise_exact_low: sifRaiseLow,
          cpc_raise_exact_high: sifRaiseHigh,
        } : {}),
        unit: 'USD',
        match_type: 'exact',
        strategy: 'up_and_down',
        evidence,
      } : null,
      ...(q.unbid_after_all_tiers === true || q.all_tiers_exhausted === true ? { all_tiers_exhausted: true } : {}),
    };
    entries.push(entry);
    mainQueriesMeta.push({
      hasAnyExactBid,
      exhausted: q.unbid_after_all_tiers === true || q.all_tiers_exhausted === true,
    });
  }

  const allMainQueriesExhausted = mainQueriesMeta.length > 0 &&
    mainQueriesMeta.every(m => !m.hasAnyExactBid && m.exhausted);
  const anyContradictoryExhausted = mainQueriesMeta.some(m => m.hasAnyExactBid && m.exhausted);
  const resolvedUnbidAfterAllTiers = unbid_after_all_tiers === true || allMainQueriesExhausted || anyContradictoryExhausted;

  return {
    marketplace,
    currency,
    match_type: 'exact',
    ...(volume_period ? { volume_period } : {}),
    selection_reason,
    evidence,
    ...(entry_scope ? { entry_scope } : {}),
    ...(proxy_reason ? { proxy_reason } : {}),
    ...(resolvedUnbidAfterAllTiers ? { unbid_after_all_tiers: true } : {}),
    ...(unbid_reason ? { unbid_reason } : {}),
    entries,
    ...(opportunistic.length > 0 ? { long_tail_opportunistic_terms: opportunistic } : {}),
  };
}

