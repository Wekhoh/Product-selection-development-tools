import { BUSINESS_THRESHOLDS } from './business-thresholds.mjs';
/**
 * Multi-channel anti-convergence discovery registry, Track A/B/C promotion classifier,
 * discovery batch planner, and coverage auditor (docs/PRODUCT.md & 04 section 2.6 / 6.1).
 * Purely diagnostic anti-convergence reporting — NEVER imposes artificial category or source quotas.
 */
import { validEvidenceDate } from './observations.mjs';

export const OPPORTUNITY_TYPES = Object.freeze([
  'growth',
  'steady',
  'supply_gap',
  'unclassified',
]);

export const PROMOTION_TRACKS = Object.freeze([
  'track_a_resonance',
  'track_b_breakout',
  'track_c_steady_sample',
]);

export const DISCOVERY_ROUTES = Object.freeze([
  'social_cross_platform',
  'demand_signals_trends',
  'supply_factory_cold_start',
  'in_site_product_market',
  'competitor_keyword_expansion',
]);

export const DISCOVERY_CHANNELS = Object.freeze({
  reddit: Object.freeze({
    channel_id: 'reddit',
    label: 'Reddit Niche Communities',
    route: 'social_cross_platform',
    entry_group: 'social',
    provider: 'exa',
    tool_hint: 'web_search_exa (site:reddit.com)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['supply_gap', 'growth', 'steady']),
  }),
  pinterest: Object.freeze({
    channel_id: 'pinterest',
    label: 'Pinterest Visual & DIY Trends',
    route: 'social_cross_platform',
    entry_group: 'social',
    provider: 'exa',
    tool_hint: 'web_search_exa (site:pinterest.com)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'steady']),
  }),
  x_twitter: Object.freeze({
    channel_id: 'x_twitter',
    label: 'X (Twitter) Product Requests & Threads (Deferred)',
    route: 'social_cross_platform',
    entry_group: 'social',
    provider: 'none',
    tool_hint: 'Deferred: X login wall & crawler restriction; Exa MCP lacks tweet search index (re-enable only if paid X Search API is added)',
    active: false,
    status: 'deferred_blocked',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'supply_gap']),
  }),
  etsy: Object.freeze({
    channel_id: 'etsy',
    label: 'Etsy Specialty & Handmade Demand',
    route: 'social_cross_platform',
    entry_group: 'social',
    provider: 'exa',
    tool_hint: 'web_search_exa (site:etsy.com)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['supply_gap', 'steady', 'growth']),
  }),
  youtube: Object.freeze({
    channel_id: 'youtube',
    label: 'YouTube Gear, Workflow & DIY Reviews',
    route: 'social_cross_platform',
    entry_group: 'social',
    provider: 'exa',
    tool_hint: 'web_search_exa (site:youtube.com)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'supply_gap']),
  }),
  specialist_forums_catalogs: Object.freeze({
    channel_id: 'specialist_forums_catalogs',
    label: 'Specialist Vertical Forums & Catalogs',
    route: 'social_cross_platform',
    entry_group: 'social',
    provider: 'exa',
    tool_hint: 'web_search_exa (hobbyist forums / trade catalogs)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['steady', 'supply_gap']),
  }),
  google_trends: Object.freeze({
    channel_id: 'google_trends',
    label: 'Google Trends (Web + Shopping 5-Yr)',
    route: 'demand_signals_trends',
    entry_group: 'trends',
    provider: 'sellersprite',
    tool_hint: 'keyword_google_trend_4965528d (WEB + SHOPPING 5yr)',
    non_keyword_origin: false,
    default_opportunity_types: Object.freeze(['growth', 'steady']),
  }),
  '1688_factory_cold_start': Object.freeze({
    channel_id: '1688_factory_cold_start',
    label: '1688 Source Factory Cold Start',
    route: 'supply_factory_cold_start',
    entry_group: 'factory_catalog',
    provider: '1688_browser',
    tool_hint: '1688 read-only factory catalog sweep',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['supply_gap', 'steady']),
  }),
  ss_supply_gap_low_rating: Object.freeze({
    channel_id: 'ss_supply_gap_low_rating',
    label: 'SellerSprite Low-Rating High-Sales Pain-Point Screen',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'asin_list (rating 3.2-4.1, steady organic sales, price >= $29.99)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['supply_gap']),
  }),
  ss_supply_gap_fbm_low_lqs: Object.freeze({
    channel_id: 'ss_supply_gap_fbm_low_lqs',
    label: 'SellerSprite FBM High-Sales / Low-LQS Mismatch Screen',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'asin_list (fulfillment=FBM or low LQS with steady sales, price >= $30)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['supply_gap']),
  }),
  amz_opportunity_explorer: Object.freeze({
    channel_id: 'amz_opportunity_explorer',
    label: 'Amazon Opportunity Explorer / Category Demand Report',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'category_demand_report_aa94816b',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'steady', 'supply_gap']),
  }),
  ss_category_steady: Object.freeze({
    channel_id: 'ss_category_steady',
    label: 'SellerSprite Steady Category / Leaf BSR Sweep',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'category_stats_list / category_top_list',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['steady']),
  }),
  ss_related_expansion: Object.freeze({
    channel_id: 'ss_related_expansion',
    label: 'SellerSprite Sourced Competitor & Related Expansion',
    route: 'competitor_keyword_expansion',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'keyword_related_list / keyword_asin_list',
    non_keyword_origin: false,
    default_opportunity_types: Object.freeze(['steady', 'growth']),
  }),
  sif_root_opportunities: Object.freeze({
    channel_id: 'sif_root_opportunities',
    label: 'SIF Root & Keyword Opportunity Screen',
    route: 'competitor_keyword_expansion',
    entry_group: 'in_site',
    provider: 'sif',
    tool_hint: 'market_screen_keyword_opportunities',
    non_keyword_origin: false,
    default_opportunity_types: Object.freeze(['growth', 'steady', 'supply_gap']),
  }),
  keyword_library: Object.freeze({
    channel_id: 'keyword_library',
    label: 'Keyword Libraries & Demand Records',
    route: 'competitor_keyword_expansion',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'keyword_research / keyword_mining',
    non_keyword_origin: false,
    default_opportunity_types: Object.freeze(['growth', 'steady']),
  }),
  ss_aba_six_modes: Object.freeze({
    channel_id: 'ss_aba_six_modes',
    label: 'SellerSprite ABA 6-Mode Rank/Surge/Longtail Screen',
    route: 'demand_signals_trends',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'aba_research (popular / surge / sustained_growth / potential / longtail)',
    non_keyword_origin: false,
    default_opportunity_types: Object.freeze(['growth', 'steady', 'supply_gap']),
  }),
  ss_title_density_gap: Object.freeze({
    channel_id: 'ss_title_density_gap',
    label: 'SellerSprite Keyword Title-Density Supply Gap',
    route: 'competitor_keyword_expansion',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'keyword_research (low title density + real buyer search demand)',
    non_keyword_origin: false,
    default_opportunity_types: Object.freeze(['supply_gap', 'growth']),
  }),
  ss_newcomer_low_review: Object.freeze({
    channel_id: 'ss_newcomer_low_review',
    label: 'SellerSprite <90d Low-Review High-Sales Newcomer Screen',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'asin_list (<90d launch, low reviews, organic sales traction, price >= $30)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'supply_gap']),
  }),
  ss_us_seller_high_ticket: Object.freeze({
    channel_id: 'ss_us_seller_high_ticket',
    label: 'SellerSprite US-Seller High-Ticket Arbitrage Screen',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'asin_list (sellerNation=US, steady sales, price >= $29.99)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['steady', 'supply_gap']),
  }),
  ss_whitehat_launchpad_storefront: Object.freeze({
    channel_id: 'ss_whitehat_launchpad_storefront',
    label: 'White-Hat Successful Newcomer Seller Storefront Mining',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'asin_list (last 180d >=$30 successful launches -> seller storefront + SIF ops_get_asin_traffic_trend listingSearch:false)',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'steady']),
  }),
  ss_vine_sustained_traction: Object.freeze({
    channel_id: 'ss_vine_sustained_traction',
    label: 'Vine 2/10/30-Tier Post-Review Month-2 Sustained Traction',
    route: 'in_site_product_market',
    entry_group: 'in_site',
    provider: 'sellersprite',
    tool_hint: 'asin_list + SIF ops_get_asin_traffic_trend(listingSearch:false) verifying sustained post-Vine organic velocity',
    non_keyword_origin: true,
    default_opportunity_types: Object.freeze(['growth', 'steady']),
  }),
});

const CHANNEL_ALIASES = Object.freeze({
  x: 'x_twitter',
  twitter: 'x_twitter',
  'x/twitter': 'x_twitter',
  'x-twitter': 'x_twitter',
  '1688': '1688_factory_cold_start',
  '1688_catalog': '1688_factory_cold_start',
  '1688_factory': '1688_factory_cold_start',
  factory_catalog: '1688_factory_cold_start',
  forum: 'specialist_forums_catalogs',
  forums: 'specialist_forums_catalogs',
  specialist_forum: 'specialist_forums_catalogs',
  specialist_forums: 'specialist_forums_catalogs',
  catalog: 'specialist_forums_catalogs',
  google_trend: 'google_trends',
  keyword_google_trend: 'google_trends',
  ss_google_trend: 'google_trends',
  ss_low_rating: 'ss_supply_gap_low_rating',
  low_rating_pain_point: 'ss_supply_gap_low_rating',
  ss_fbm_low_lqs: 'ss_supply_gap_fbm_low_lqs',
  fbm_low_lqs: 'ss_supply_gap_fbm_low_lqs',
  opportunity_explorer: 'amz_opportunity_explorer',
  category_demand_report: 'amz_opportunity_explorer',
  category_stats_list: 'ss_category_steady',
  category_top_list: 'ss_category_steady',
  ss_category: 'ss_category_steady',
  keyword_related_list: 'ss_related_expansion',
  competitor_expansion: 'ss_related_expansion',
  sif_keywords: 'sif_root_opportunities',
  sif_keyword_opportunity: 'sif_root_opportunities',
  market_screen_keyword_opportunities: 'sif_root_opportunities',
  sellersprite_keywords: 'keyword_library',
  keyword_research: 'keyword_library',
  keyword_mining: 'keyword_library',
  aba_research: 'ss_aba_six_modes',
  title_density_gap: 'ss_title_density_gap',
  whitehat_storefront: 'ss_whitehat_launchpad_storefront',
  vine_traction: 'ss_vine_sustained_traction',
});

/**
 * Resolve any raw source_channel string into canonical { channel_id, route, entry_group, non_keyword_origin }.
 * Eliminates hardcoded 'in_site' defaults across store/import/pipeline.
 */
export function resolveChannelMeta(sourceChannel, explicitRoute = null, explicitEntryGroup = null) {
  const raw = String(sourceChannel || '').trim();
  const norm = raw.toLowerCase().replace(/\s+/g, '_');
  const directKey = Object.hasOwn(DISCOVERY_CHANNELS, norm)
    ? norm
    : (CHANNEL_ALIASES[norm] ?? null);

  if (directKey) {
    const ch = DISCOVERY_CHANNELS[directKey];
    return {
      channel_id: ch.channel_id,
      route: explicitRoute && DISCOVERY_ROUTES.includes(explicitRoute) ? explicitRoute : ch.route,
      entry_group: explicitEntryGroup && String(explicitEntryGroup).trim() ? String(explicitEntryGroup).trim() : ch.entry_group,
      provider: ch.provider,
      non_keyword_origin: ch.non_keyword_origin,
      known_channel: true,
    };
  }

  // Heuristic fallback for legacy / custom source IDs (never crashes legacy r57 discovery imports).
  if (/reddit|pinterest|etsy|youtube|twitter|\bx_post\b|forum|social/i.test(norm)) {
    return {
      channel_id: norm || 'social_other',
      route: explicitRoute && DISCOVERY_ROUTES.includes(explicitRoute) ? explicitRoute : 'social_cross_platform',
      entry_group: explicitEntryGroup || 'social',
      provider: 'exa',
      non_keyword_origin: true,
      known_channel: false,
    };
  }
  if (/1688|factory|supplier/i.test(norm)) {
    return {
      channel_id: norm || '1688_factory_cold_start',
      route: explicitRoute && DISCOVERY_ROUTES.includes(explicitRoute) ? explicitRoute : 'supply_factory_cold_start',
      entry_group: explicitEntryGroup || 'factory_catalog',
      provider: '1688_browser',
      non_keyword_origin: true,
      known_channel: false,
    };
  }
  if (/google_trend|trend/i.test(norm)) {
    return {
      channel_id: norm || 'google_trends',
      route: explicitRoute && DISCOVERY_ROUTES.includes(explicitRoute) ? explicitRoute : 'demand_signals_trends',
      entry_group: explicitEntryGroup || 'trends',
      provider: 'sellersprite',
      non_keyword_origin: false,
      known_channel: false,
    };
  }
  if (/asin|bsr|category|opportunity_explorer|supply_gap|fbm|lqs/i.test(norm)) {
    return {
      channel_id: norm || 'ss_category_steady',
      route: explicitRoute && DISCOVERY_ROUTES.includes(explicitRoute) ? explicitRoute : 'in_site_product_market',
      entry_group: explicitEntryGroup || 'in_site',
      provider: 'sellersprite',
      non_keyword_origin: true,
      known_channel: false,
    };
  }
  return {
    channel_id: norm || 'keyword_library',
    route: explicitRoute && DISCOVERY_ROUTES.includes(explicitRoute) ? explicitRoute : 'competitor_keyword_expansion',
    entry_group: explicitEntryGroup || 'in_site',
    provider: 'sellersprite',
    non_keyword_origin: false,
    known_channel: false,
  };
}

/**
 * Classify a candidate form into Track A (multi-entry resonance), Track B (single breakout),
 * or Track C (single-signal steady niche sample — prevents starving steady low-hype niches).
 */
export function classifyPromotionTrack({
  leads = [],
  opportunity_type = 'unclassified',
  is_breakout_signal = false,
} = {}) {
  const channels = new Set();
  const routes = new Set();
  for (const lead of leads) {
    const meta = resolveChannelMeta(lead?.source_channel ?? lead?.channel_id, lead?.route, lead?.entry_group);
    channels.add(meta.channel_id);
    routes.add(meta.route);
  }
  if (routes.size >= 2 || channels.size >= 2) {
    return {
      promotion_track: 'track_a_resonance',
      distinct_routes: routes.size,
      distinct_channels: channels.size,
      reason: `Multi-entry resonance across ${channels.size} channel(s) and ${routes.size} route(s).`,
    };
  }
  if (is_breakout_signal === true || opportunity_type === 'growth' || opportunity_type === 'supply_gap') {
    return {
      promotion_track: 'track_b_breakout',
      distinct_routes: routes.size,
      distinct_channels: channels.size,
      reason: `Single-source high-signal breakout (${opportunity_type}).`,
    };
  }
  return {
    promotion_track: 'track_c_steady_sample',
    distinct_routes: routes.size,
    distinct_channels: channels.size,
    reason: 'Single-signal steady niche sample preserved under Track C so steady markets are not starved.',
  };
}

function readTableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name));
}

/**
 * Audit actual discovery coverage across routes, channels, opportunity types, promotion tracks,
 * and non-keyword origins from the SQLite store (strictly read-only).
 * Reports anti-convergence alerts as diagnostics — NEVER imposes forced quotas.
 */
export function auditDiscoveryCoverage(store, {
  as_of_date = new Date().toISOString().slice(0, 10),
  profile_revision = 59,
} = {}) {
  if (!store || !store.db) throw new TypeError('A SelectionStore instance is required.');
  const leadCols = readTableColumns(store.db, 'raw_leads');
  const formCols = readTableColumns(store.db, 'candidate_forms');

  const leads = store.db.prepare('SELECT * FROM raw_leads ORDER BY created_at ASC').all();
  const forms = store.db.prepare('SELECT * FROM candidate_forms ORDER BY created_at ASC').all();
  const links = store.db.prepare('SELECT * FROM lead_form_links').all();

  const byChannel = {};
  const byRoute = Object.fromEntries(DISCOVERY_ROUTES.map(r => [r, { leads: 0, forms: new Set(), channels: new Set() }]));
  const byEntryGroup = {};
  const byOpportunityType = Object.fromEntries(OPPORTUNITY_TYPES.map(t => [t, 0]));
  const byDisposition = {};
  let nonKeywordLeadCount = 0;

  const leadMetaById = new Map();
  for (const row of leads) {
    const meta = resolveChannelMeta(
      row.source_channel,
      leadCols.has('route') ? row.route : null,
      row.entry_group,
    );
    const oppType = leadCols.has('opportunity_type') && OPPORTUNITY_TYPES.includes(row.opportunity_type)
      ? row.opportunity_type
      : 'unclassified';
    leadMetaById.set(row.lead_id, { ...meta, opportunity_type: oppType });

    if (meta.non_keyword_origin) nonKeywordLeadCount++;
    byChannel[meta.channel_id] = (byChannel[meta.channel_id] ?? 0) + 1;
    if (!byRoute[meta.route]) byRoute[meta.route] = { leads: 0, forms: new Set(), channels: new Set() };
    byRoute[meta.route].leads++;
    byRoute[meta.route].channels.add(meta.channel_id);
    byEntryGroup[meta.entry_group] = (byEntryGroup[meta.entry_group] ?? 0) + 1;
    byOpportunityType[oppType] = (byOpportunityType[oppType] ?? 0) + 1;
    byDisposition[row.disposition] = (byDisposition[row.disposition] ?? 0) + 1;
  }

  for (const link of links) {
    const meta = leadMetaById.get(link.lead_id);
    if (meta && byRoute[meta.route]) {
      byRoute[meta.route].forms.add(link.form_id);
    }
  }

  const byPromotionTrack = Object.fromEntries([...PROMOTION_TRACKS, 'unassigned'].map(t => [t, 0]));
  const activeCooldowns = [];
  const formStatuses = {};
  const byLeafCategory = {};
  let categorizedLeadsOrForms = 0;

  // Extract leaf/category identifiers from lead metadata and candidate_forms (including leaf_node_path)
  // to detect cross-channel single-leaf convergence.
  const extractLeafTag = obj => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of ['leaf_node_path', 'leaf_node_id', 'leaf_category', 'node_id', 'category_id', 'category_path', 'category']) {
      if (typeof obj[k] === 'string' && obj[k].trim().length > 0) return obj[k].trim();
    }
    return null;
  };
  const leafByFormId = new Map();
  for (const f of forms) {
    formStatuses[f.lifecycle_status] = (formStatuses[f.lifecycle_status] ?? 0) + 1;
    const track = formCols.has('promotion_track') && PROMOTION_TRACKS.includes(f.promotion_track)
      ? f.promotion_track
      : 'unassigned';
    byPromotionTrack[track]++;
    if (formCols.has('cooldown_until') && f.cooldown_until && validEvidenceDate(f.cooldown_until) && f.cooldown_until >= as_of_date) {
      activeCooldowns.push({
        form_id: f.form_id,
        cooldown_until: f.cooldown_until,
        cooldown_reason: formCols.has('cooldown_reason') ? f.cooldown_reason : null,
      });
    }
    let leafTag = extractLeafTag(f);
    if (!leafTag && f.notes) {
      const m = String(f.notes).match(/\bleaf[_-]?category[:=]\s*([^\s,;]+)/i);
      if (m) leafTag = m[1];
    }
    if (leafTag) {
      leafByFormId.set(f.form_id, leafTag);
    }
  }
  const leadLeafRows = store.db.prepare('SELECT lead_id, metadata_json FROM raw_leads').all();
  const formsTaggedByLeads = new Set();
  const formsByLeadId = new Map();
  for (const lk of links) {
    if (!formsByLeadId.has(lk.lead_id)) formsByLeadId.set(lk.lead_id, []);
    formsByLeadId.get(lk.lead_id).push(lk.form_id);
  }
  for (const r of leadLeafRows) {
    let metaObj = null;
    try { metaObj = r.metadata_json ? JSON.parse(r.metadata_json) : null; } catch { /* ignore */ }
    const leafTag = extractLeafTag(metaObj);
    if (leafTag) {
      byLeafCategory[leafTag] = (byLeafCategory[leafTag] ?? 0) + 1;
      categorizedLeadsOrForms++;
      for (const fid of formsByLeadId.get(r.lead_id) ?? []) formsTaggedByLeads.add(fid);
    }
  }
  for (const [fid, leafTag] of leafByFormId.entries()) {
    if (formsTaggedByLeads.has(fid)) continue;
    byLeafCategory[leafTag] = (byLeafCategory[leafTag] ?? 0) + 1;
    categorizedLeadsOrForms++;
  }

  const investigatedChannels = Object.keys(byChannel).filter(id => Object.hasOwn(DISCOVERY_CHANNELS, id)).sort();
  const deferredChannels = Object.keys(DISCOVERY_CHANNELS).filter(id => DISCOVERY_CHANNELS[id].active === false).sort();
  const availableUntestedChannels = Object.keys(DISCOVERY_CHANNELS)
    .filter(id => DISCOVERY_CHANNELS[id].active !== false && !byChannel[id])
    .sort();
  const totalLeads = leads.length;
  const nonKeywordShare = totalLeads > 0 ? Math.round(((nonKeywordLeadCount / totalLeads) + Number.EPSILON) * 10000) / 10000 : 0;

  // Anti-convergence diagnostics (advisory only; never blocks or enforces quotas).
  const alerts = [];
  if (totalLeads === 0) {
    alerts.push({ code: 'empty_lead_pool', message: 'No raw_leads persisted yet; sweep multiple non-Amazon and in-site routes.' });
  } else {
    const sortedChannels = Object.entries(byChannel).sort((a, b) => b[1] - a[1]);
    const [topChannel, topCount] = sortedChannels[0];
    if (totalLeads >= 3 && (topCount / totalLeads) > 0.70) {
      alerts.push({
        code: 'single_channel_concentration',
        message: `${topCount}/${totalLeads} (${((topCount / totalLeads) * 100).toFixed(1)}%) leads originate from "${topChannel}"; broaden across neglected channels.`,
      });
    }
    const activeRoutes = DISCOVERY_ROUTES.filter(r => byRoute[r].leads > 0);
    if (totalLeads >= 3 && activeRoutes.length < 2) {
      alerts.push({
        code: 'single_route_concentration',
        message: `All ${totalLeads} leads come from only 1 route (${activeRoutes.join(', ')}); add cross-platform social, supply-gap, or trend discovery.`,
      });
    }
    if ((byEntryGroup.social ?? 0) === 0) {
      alerts.push({
        code: 'missing_non_amazon_social',
        message: 'Zero non-Amazon social/community leads recorded (Reddit/Pinterest/Etsy/YouTube/forums).',
      });
    }
    if ((byOpportunityType.supply_gap ?? 0) === 0) {
      alerts.push({
        code: 'missing_supply_gap_signals',
        message: 'Zero supply_gap leads tagged (low-rating high-sales or FBM/low-LQS mismatch).',
      });
    }
  }

  return {
    as_of_date,
    totals: {
      raw_leads: totalLeads,
      candidate_forms: forms.length,
      lead_form_links: links.length,
      non_keyword_origin_leads: nonKeywordLeadCount,
      non_keyword_origin_share: nonKeywordShare,
      active_cooldowns: activeCooldowns.length,
    },
    routes: Object.fromEntries(
      Object.entries(byRoute).map(([r, info]) => [r, {
        leads: info.leads,
        forms: info.forms.size,
        channels: [...info.channels].sort(),
      }]),
    ),
    channels: byChannel,
    leaf_categories: byLeafCategory,
    entry_groups: byEntryGroup,
    opportunity_types: byOpportunityType,
    promotion_tracks: byPromotionTrack,
    dispositions: byDisposition,
    form_lifecycle_statuses: formStatuses,
    investigated_channels: investigatedChannels,
    available_untested_channels: availableUntestedChannels,
    deferred_channels: deferredChannels,
    active_cooldowns: activeCooldowns,
    anti_convergence_alerts: alerts,
  };
}

/**
 * Build a concrete anti-convergence next-batch discovery plan from current SQLite coverage,
 * prioritizing untested routes/channels, balancing growth/steady/supply_gap hypotheses,
 * and preserving Track C steady-niche slots without enforcing artificial quotas.
 */
export function planDiscoveryBatch(store, {
  as_of_date = new Date().toISOString().slice(0, 10),
  max_channels = 6,
  task_slots = null,
  enforce_80_20_mix = false,
  include_1688_cold_start = true,
  include_deferred = false,
} = {}) {
  const coverage = auditDiscoveryCoverage(store, { as_of_date });
  const totalSlots = Number.isInteger(task_slots) && task_slots > 0 ? task_slots : max_channels;
  const isStationOrigin = ch => ch.entry_group === 'in_site' || ch.entry_group === 'trends';
  const allChannels = Object.values(DISCOVERY_CHANNELS)
    .filter(ch => (include_deferred || ch.active !== false) && (include_1688_cold_start || ch.channel_id !== '1688_factory_cold_start'));

  // Count independent primary-discovery leads only (excluding station_verification links used to verify off-site leads,
  // including legacy migrated databases where station_verification lives in verification_subrole).
  const linkCols = new Set(store.db.prepare("PRAGMA table_info('lead_form_links')").all().map(r => r.name));
  const stationSql = linkCols.has('verification_subrole')
    ? "SELECT lead_id FROM lead_form_links WHERE link_role = 'station_verification' OR verification_subrole = 'station_verification'"
    : "SELECT lead_id FROM lead_form_links WHERE link_role = 'station_verification'";
  const stationVerificationLeadIds = new Set(
    store.db.prepare(stationSql).all().map(r => r.lead_id),
  );
  const primaryDiscoveryLeadIds = new Set(
    store.db.prepare("SELECT lead_id FROM lead_form_links WHERE link_role = 'primary_discovery'").all().map(r => r.lead_id),
  );
  const primaryCountByChannel = {};
  for (const row of store.db.prepare('SELECT lead_id, source_channel FROM raw_leads').all()) {
    if (stationVerificationLeadIds.has(row.lead_id) && !primaryDiscoveryLeadIds.has(row.lead_id)) continue;
    const m = resolveChannelMeta(row.source_channel);
    primaryCountByChannel[m.channel_id] = (primaryCountByChannel[m.channel_id] ?? 0) + 1;
  }

  // Score channels by neglect: untested routes & untested channels first, preferring non-keyword & supply-gap diversity.
  const ranked = allChannels.map(ch => {
    const chCount = enforce_80_20_mix ? (primaryCountByChannel[ch.channel_id] ?? 0) : (coverage.channels[ch.channel_id] ?? 0);
    const routeCount = coverage.routes[ch.route]?.leads ?? 0;
    const priority = (routeCount === 0 ? 100 : 0) +
      (chCount === 0 ? 50 : Math.max(0, 20 - chCount * 5)) +
      (ch.non_keyword_origin ? 10 : 0) +
      (ch.default_opportunity_types.includes('supply_gap') ? 5 : 0);
    return {
      ...ch,
      station_origin: isStationOrigin(ch) ? 'in_site' : 'off_site',
      observed_leads: chCount,
      route_observed_leads: routeCount,
      priority,
    };
  }).sort((a, b) => b.priority - a.priority || a.channel_id.localeCompare(b.channel_id));

  let selected = [];
  if (enforce_80_20_mix) {
    const targetOffSite = Math.max(0, Math.round(totalSlots * 0.20));
    const targetInSite = Math.max(0, totalSlots - targetOffSite);
    const inSitePool = ranked.filter(ch => ch.station_origin === 'in_site');
    const offSitePool = ranked.filter(ch => ch.station_origin === 'off_site');
    const pickCycle = (pool, count) => {
      const out = [];
      if (pool.length === 0 || count <= 0) return out;
      for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
      return out;
    };
    selected = [...pickCycle(inSitePool, targetInSite), ...pickCycle(offSitePool, targetOffSite)];
  } else {
    // Pick up to totalSlots ensuring multi-route spread first, then filling remaining slots.
    const pickedRoutes = new Set();
    for (const ch of ranked) {
      if (selected.length >= totalSlots) break;
      if (!pickedRoutes.has(ch.route)) {
        selected.push(ch);
        pickedRoutes.add(ch.route);
      }
    }
    for (const ch of ranked) {
      if (selected.length >= totalSlots) break;
      if (!selected.some(s => s.channel_id === ch.channel_id)) {
        selected.push(ch);
      }
    }
  }

  return {
    as_of_date,
    policy_note: enforce_80_20_mix
      ? '80% station-internal (SellerSprite + SIF) / 20% off-site auxiliary independent discovery task split; station_verification calls on off-site leads do not consume primary 80% slots.'
      : 'Anti-convergence planning guide (no forced category/source quotas; cooldown on one form never suspends other sources).',
    gate0_defaults: {
      exclude_childrens_products: true,
      avoid_red_ocean: { apparel: true, consumer_electronics_3c: true, red_ocean_furniture: true },
      allow_low_risk_powered_non_3c: true,
    },
    recommended_tracks: {
      track_a_resonance: 'Promote forms corroborated across >=2 routes/channels.',
      track_b_breakout: 'Promote single-source breakout growth or acute supply-gap leads.',
      track_c_steady_sample: 'Reserve steady low-hype niche slots so stable profitable forms are never starved.',
    },
    recommended_channels: selected.map(ch => ({
      channel_id: ch.channel_id,
      label: ch.label,
      route: ch.route,
      entry_group: ch.entry_group,
      station_origin: ch.station_origin,
      provider: ch.provider,
      tool_hint: ch.tool_hint,
      non_keyword_origin: ch.non_keyword_origin,
      target_opportunity_types: [...ch.default_opportunity_types],
      observed_leads: ch.observed_leads,
    })),
    primary_discovery_counts_by_channel: { ...primaryCountByChannel },
    deferred_channels: coverage.deferred_channels,
    active_cooldown_forms: coverage.active_cooldowns,
    anti_convergence_alerts: coverage.anti_convergence_alerts,
  };
}
