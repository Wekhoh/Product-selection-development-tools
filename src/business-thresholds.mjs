/**
 * Single audited source of truth for ALL owner-approved business thresholds & operating cutoffs.
 *
 * IRON RULE (AGENTS.md):
 *   Never invent, alter, or add any business threshold number (day counts, percentages, multiples,
 *   millimeters, dollar/CNY cutoffs, etc.) without explicit owner (`主人`) confirmation and a
 *   recorded `confirmed_at` ISO date + `provenance` entry below.
 *   Guarded deterministically by `test/business-thresholds.test.mjs`.
 */
import { deepFreeze } from './utils/objects.mjs';

export const BUSINESS_THRESHOLD_AUDIT_REGISTRY = deepFreeze({
  // ---------------------------------------------------------------------------
  // 1. Four Hard Kill Lines (铁底线只留 4 条)
  // ---------------------------------------------------------------------------
  minimum_reference_price_usd: {
    value: 29.99,
    unit: 'USD',
    confirmed_at: '2026-11-24',
    provenance: 'DECISIONS.md + 2026-11-24 4-hard-kill-lines closure (matched-spec price >= $29.99)',
  },
  pre_ad_margin_floor: {
    value: 0.30,
    unit: 'fraction',
    confirmed_at: '2026-11-24',
    provenance: 'DECISIONS.md + 2026-11-12/2026-11-24 single-factory complete-kit refund-adjusted pre-ad margin >= 30%',
  },
  children_statutory_max_age_years: {
    value: 12,
    unit: 'years',
    confirmed_at: '2026-11-24',
    provenance: 'CPSC/CPSIA statutory <= 12y children product hard exclusion (with adult/caregiver/nursery-storage exemptions)',
  },
  allow_strong_date_dependency: {
    value: false,
    unit: 'boolean',
    confirmed_at: '2026-11-24',
    provenance: 'Evergreen-first scope; holiday/year/event-dated products deferred',
  },

  // ---------------------------------------------------------------------------
  // 2. Sourcing, Inventory, Advertising Sensitivity & Package Rescue
  // ---------------------------------------------------------------------------
  min_order_units: {
    value: 100,
    unit: 'saleable_sets',
    confirmed_at: '2026-11-16',
    provenance: 'DECISIONS.md >= 100 complete saleable sets regular non-first-order repeat quote to Shenzhen',
  },
  average_inventory_days: {
    value: 45,
    unit: 'days',
    confirmed_at: '2026-11-12',
    provenance: 'DECISIONS.md 45-day average FBA stock / 30-day monthly sales (1.5 months)',
  },
  monthly_sales_days_basis: {
    value: 30,
    unit: 'days',
    confirmed_at: '2026-11-12',
    provenance: 'DECISIONS.md 30-day monthly sales denominator for storage turnover',
  },
  ad_sensitivity_fraction: {
    value: 0.15,
    unit: 'fraction',
    confirmed_at: '2026-11-12',
    provenance: 'DECISIONS.md visible 15% of selling price ad sensitivity view (never folded into primary pre-ad margin)',
  },
  min_1688_viewport_width_px: {
    value: 1440,
    unit: 'px',
    confirmed_at: '2026-11-23',
    provenance: 'AGENTS.md >= 1440 px CSS viewport required for 1688 SKU + regular settlement bar readback',
  },
  max_1688_factories_to_check: {
    value: 3,
    unit: 'factories',
    confirmed_at: '2026-11-24',
    provenance: '1688 stop rule: 1st reliable complete-kit factory >= 30% stops; crossing/<30% checks 2nd, at most 3rd distinct factory_id',
  },
  amazon_optimized_min_cartons: {
    value: 5,
    unit: 'cartons',
    confirmed_at: '2026-11-24',
    provenance: 'US FBA 2027 Amazon-optimized $0 inbound placement requires >= 5 identical cartons + multi-warehouse headhaul basis',
  },
  borderline_package_rescue_max_mm: {
    value: 10,
    unit: 'mm',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 item #5: single-side compression > 0 mm && <= 10 mm (1 cm) crossing FBA tier to >= 30% margin',
  },

  // ---------------------------------------------------------------------------
  // 3. 2027 US FBA Windows, Cliffs, Coupons & Freight A4 Rules
  // ---------------------------------------------------------------------------
  fba_2027_off_peak_sales_window: {
    value: { from: '2027-02-01', through: '2027-10-14' },
    unit: 'iso_date_window',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 item #1: sole default 2027 off-peak fulfillment/sales window',
  },
  fba_2027_off_peak_storage_window: {
    value: { from: '2027-02-01', through: '2027-09-30' },
    unit: 'iso_date_window',
    confirmed_at: '2026-11-24',
    provenance: 'Official Amazon 2027 off-peak monthly storage schedule (Feb–Sep $0.78/$0.56; Oct–Dec peak storage)',
  },
  fba_2027_unpublished_q4_peak_window: {
    value: { from: '2027-10-15', through: '2028-01-14' },
    unit: 'iso_date_window',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 item #3: 2027 Q4 peak fulfillment margin left blank until Amazon publishes official rates',
  },
  fba_2027_fuel_multiplier: {
    value: 1.035,
    unit: 'multiplier',
    confirmed_at: '2026-11-24',
    provenance: 'Official 2027 US FBA +3.5% fuel surcharge applied to base fulfillment rate only (never to non-SIPP packaging fee)',
  },
  fba_2027_price_band_low_max_usd: {
    value: 10.00,
    unit: 'USD',
    confirmed_at: '2026-11-18',
    provenance: 'Official US FBA <$10 Low-Price FBA boundary',
  },
  fba_2027_price_band_mid_max_usd: {
    value: 50.00,
    unit: 'USD',
    confirmed_at: '2026-11-24',
    provenance: 'Official US FBA $10-$50 vs >$50 tier boundary (evaluated on list_price_usd when ongoing coupon is active)',
  },
  coupon_2027_campaign_flat_usd_per_100: {
    value: 5.00,
    unit: 'USD_per_100_units',
    confirmed_at: '2026-11-24',
    provenance: 'Official Amazon ongoing coupon fee $5 per campaign / 100 units ($0.05/unit default) + 2.5% of net sales',
  },
  coupon_2027_redemption_variable_fraction: {
    value: 0.025,
    unit: 'fraction',
    confirmed_at: '2026-11-24',
    provenance: 'Official Amazon ongoing coupon variable redemption fee 2.5% of coupon-attributed sales',
  },
  freight_a4_min_shipment_billable_kg: {
    value: 10,
    unit: 'kg',
    confirmed_at: '2026-11-24',
    provenance: 'Audited Kaiqi US West A4 tariff: < 10 kg shipment billed at 10 kg minimum',
  },
  freight_a4_small_shipment_threshold_kg: {
    value: 50,
    unit: 'kg',
    confirmed_at: '2026-11-24',
    provenance: 'Audited Kaiqi US West A4 tariff: < 50 kg small-shipment surcharge threshold',
  },
  freight_a4_min_carton_weight_kg: {
    value: 8,
    unit: 'kg',
    confirmed_at: '2026-11-24',
    provenance: 'Audited Kaiqi US West A4 tariff: < 8 kg outer carton surcharge threshold',
  },
  freight_a4_volumetric_divisor: {
    value: 6000,
    unit: 'cm3_per_kg',
    confirmed_at: '2026-11-20',
    provenance: 'Audited Kaiqi US West A4 tariff: volumetric weight = L_cm * W_cm * H_cm / 6000',
  },

  // ---------------------------------------------------------------------------
  // 4. 3-Tier Listing-Age Priority, Price-Band Denoising & Market Callouts
  // ---------------------------------------------------------------------------
  newcomer_max_age_days: {
    value: 90,
    unit: 'days',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 3-tier listing-age rule: <= 90d (3 months, unified with Q31) isolated into newcomer_launch_band',
  },
  veteran_min_age_days: {
    value: 365,
    unit: 'days',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 3-tier listing-age rule: >= 365d Keepa-steady 1st-priority mature_regular_band',
  },
  min_veterans_before_growth_supplement: {
    value: 2,
    unit: 'listings',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 3-tier listing-age rule: 91-364d steady growth supplements ONLY when >= 365d steady veterans < 2',
  },
  zombie_min_monthly_sales: {
    value: 10,
    unit: 'units_per_month',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 denoising rule: < 10/mo listings excluded from price-band quantiles only',
  },
  heavy_single_coupon_pct_threshold: {
    value: 0.20,
    unit: 'fraction',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 coupon rule: single coupon >= 20% OFF flagged heavy promo; < 20% OFF routine uses net price',
  },
  advisory_band_spread_ratio: {
    value: 1.35,
    unit: 'ratio',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 spread rule: P75/P25 > 1.35x emits advisory visual reminder only (never blocks Gate 1A)',
  },
  bundle_price_high_multiple: {
    value: 2.50,
    unit: 'multiple',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 AMBER_BUNDLE_PRICE_CHECK advisory multiple vs peer median',
  },
  bundle_price_mid_multiple: {
    value: 2.25,
    unit: 'multiple',
    confirmed_at: '2026-11-24',
    provenance: 'Owner 2026-11-24 AMBER_BUNDLE_PRICE_CHECK secondary advisory multiple',
  },
  blue_ocean_max_sellers: {
    value: 15,
    unit: 'sellers',
    confirmed_at: '2026-11-24',
    provenance: 'Competition callout: < 15 observable sellers displays blue-ocean note',
  },
  review_barrier_green_lt: {
    value: 100,
    unit: 'reviews',
    confirmed_at: '2026-11-24',
    provenance: 'Competition Top-10 median reviews: < 100 green, 100-500 amber, > 500 red',
  },
  review_barrier_amber_max: {
    value: 500,
    unit: 'reviews',
    confirmed_at: '2026-11-24',
    provenance: 'Step-1 Round-3 fix: exactly 500 reviews stays amber (100-500), > 500 red',
  },
  oligopoly_patent_alert_max_sellers: {
    value: 3,
    unit: 'sellers',
    confirmed_at: '2026-11-24',
    provenance: '1-3 steady sellers at >= $45 triggers non-blocking Stage-2 deep IP warning',
  },
  oligopoly_patent_alert_min_price_usd: {
    value: 45,
    unit: 'USD',
    confirmed_at: '2026-11-24',
    provenance: '1-3 steady sellers at >= $45 triggers non-blocking Stage-2 deep IP warning',
  },

  // ---------------------------------------------------------------------------
  // 5. Immutable 21-Item Scoring Core, 3-Tier USD CPC & Q31 Newcomer Rules
  // ---------------------------------------------------------------------------
  scoring_item_count: {
    value: 21,
    unit: 'items',
    confirmed_at: '2026-11-24',
    provenance: 'Iron boundary: 21 scoring items locked',
  },
  scoring_total_weight: {
    value: 100,
    unit: 'points',
    confirmed_at: '2026-11-24',
    provenance: 'Iron boundary: 100 total points locked',
  },
  scoring_objective_core_weight: {
    value: 85,
    unit: 'points',
    confirmed_at: '2026-11-24',
    provenance: 'Step-2 unified 85-pt objective core ranking across all qualifying cards',
  },
  scoring_remaining_post_sample_weight: {
    value: 15,
    unit: 'points',
    confirmed_at: '2026-11-24',
    provenance: 'Step-2 remaining 15-pt post-sample/inquiry items (#16/#17/#18/#19/#20/#21)',
  },
  cpc_tier1_max_core_entries: {
    value: 3,
    unit: 'keywords',
    confirmed_at: '2026-11-23',
    provenance: 'Iron boundary: 1-3 mid-core purchase entries in Tier 1',
  },
  cpc_opportunistic_min_words: {
    value: 5,
    unit: 'words',
    confirmed_at: '2026-11-24',
    provenance: 'Unbid >= 5-word peripheral long-tail terms routed to opportunistic pool when core entries remain',
  },
  cpc_absolute_usd_anchors: {
    value: [
      { max_bid_usd: 0.50, points: 15 },
      { bid_usd: 1.00, points: 12 },
      { bid_usd: 1.50, points: 9 },
      { bid_usd: 2.00, points: 6 },
      { bid_usd: 2.50, points: 3 },
      { min_bid_usd: 3.00, points: 0 },
    ],
    unit: 'USD_to_points',
    confirmed_at: '2026-11-24',
    provenance: 'DECISIONS.md:601 & reference-profile.r59.draft.json locked 15-pt USD CPC curve (0.50->15, 3.00->0)',
  },
  q31_ramp_up_zero_sales_max_days: {
    value: 30,
    unit: 'days',
    confirmed_at: '2026-11-18',
    provenance: 'DECISIONS.md < 30-day zero-sales ramp-up pre-exclusion in Q31',
  },
  q31_min_effective_all_age_median_units: {
    value: 10,
    unit: 'units_per_month',
    confirmed_at: '2026-11-18',
    provenance: 'DECISIONS.md T_eff = max(T, 10) for verified non-empty T >= 0',
  },
  q31_auxiliary_leaf_rank_cap: {
    value: 200,
    unit: 'rank',
    confirmed_at: '2026-11-24',
    provenance: 'Step-1 Round-3: leafRank <= 200 and lcm_cap = 200 kept as non-blocking auxiliary diagnostics',
  },

  // ---------------------------------------------------------------------------
  // 6. Discovery 80/20 Split, OpenAI Budget & Luna Triage
  // ---------------------------------------------------------------------------
  discovery_in_site_share: {
    value: 0.80,
    unit: 'fraction',
    confirmed_at: '2026-11-23',
    provenance: '80% station-internal (SellerSprite + SIF) / 20% external discovery batch split',
  },
  openai_monthly_limit_cents: {
    value: 20_000,
    unit: 'USD_cents',
    confirmed_at: '2026-11-24',
    provenance: 'AGENTS.md <= $200/month (20,000 cents) natural-month realized spend cap',
  },
  openai_billable_post_max_retries: {
    value: 0,
    unit: 'retries',
    confirmed_at: '2026-11-21',
    provenance: 'AGENTS.md maxRetries = 0 on all billable HTTP POST requests',
  },
  luna_prohibited_threshold: {
    value: 0.70,
    unit: 'probability',
    confirmed_at: '2026-11-24',
    provenance: 'AGENTS.md Luna prohibitedThreshold = 0.70 (0.50-0.70 routed to amber_manual_review)',
  },
  luna_amber_manual_review_min: {
    value: 0.50,
    unit: 'probability',
    confirmed_at: '2026-11-24',
    provenance: 'AGENTS.md Luna [0.50, 0.70) amber_manual_review band',
  },
  codex_default_service_tier: {
    value: 'default',
    unit: 'service_tier',
    confirmed_at: '2026-11-26',
    provenance: 'Owner 2026-11-26 21:12 +08:00 explicit override: pass -c service_tier="default" (+ max reasoning) so normal speed explicitly overrides any host ~/.codex/config.toml ultrafast setting unless explicitly opted in',
  },
  codex_default_reasoning_effort: {
    value: 'max',
    unit: 'reasoning_effort',
    confirmed_at: '2026-11-25',
    provenance: 'AGENTS.md + Owner 2026-11-25: max reasoning effort for GPT-6.2 Astra reviews',
  },
});

export const BUSINESS_THRESHOLDS = deepFreeze(
  Object.fromEntries(
    Object.entries(BUSINESS_THRESHOLD_AUDIT_REGISTRY).map(([k, entry]) => [k, entry.value]),
  ),
);
