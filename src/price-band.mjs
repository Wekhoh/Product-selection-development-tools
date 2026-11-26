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
import { BUSINESS_THRESHOLDS } from './business-thresholds.mjs';
import { classifySizeTier2027, estimateGate1A2027, toBigRat } from './fba-calculator.mjs';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const round = (v, digits = 4) => Math.round((v + Number.EPSILON) * (10 ** digits)) / (10 ** digits);
const isoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

const CHILDRENS_RE = /\b(baby|babies|toddler|infant|newborn|kids?|children|child's|childrens|nursery|stroller|crib|pacifier|teether|diaper|onesie|playpen|sippy|car\s+seat|booster\s+seat|toys?\s+for\s+(?:ages?|boys?|girls?)|musical\s+toy|montessori|plush\s+toy|baby\s+monitor|ages?\s*(?:1[0-2]|[0-9])(?!\d))\b|(?:婴童|母婴|婴儿|儿童|宝宝|幼儿|童装|儿童玩具|奶瓶|安全座椅)/i;
const STRICT_CHILD_USE_ITEM_RE = /\b(toddler\s+(?:toy|bed|cup|fork|spoon|plate|bowl|seat|bike|scooter|shoes?|apparel|dress|learning\s+tower|step\s+stool)|infant\s+(?:toy|bath\s+tub|bathtub|lounger|carrier|swaddle)|newborn\s+(?:swaddle|bath\s+tub|bathtub|lounger|clothes?)|musical\s+toy|baby\s+(?:plate|bowl|spoon|fork|bib|feeding\s+set|suction\s+plate|high\s*chair|walker|bouncer|swing|bath\s+tub|bathtub|play\s*mat|crawling\s+mat|lounger|swaddle)|bassinet|pacifier|teether|crib|onesie|playpen|sippy|car\s+seat|booster\s+seat|toys?\s+for\s+(?:ages?|boys?|girls?|kids?|toddlers?|babies)|ages?\s*(?:1[0-2]|[0-9])(?!\d)|plush\s+toy|montessori\s+toy)\b|(?:儿童玩具|婴儿玩具|牙胶|安抚奶嘴|奶瓶|安全座椅|童装)/i;
const HOUSEHOLD_CONTAINER_CONTENT_RE = /\b(?:pockets?|compartments?|bags?|pouches?|shelves|shelf|shelving|racks?|baskets?|hampers?|bins?|drawers?|organizers?|caddies|caddy|hooks?|sorters?|cabinets?|closets?|storage|holds?|fits?|stores?|storing)\s+(?:for\s+)?(?:storing\s+)?(?:baby|babies|infant|toddler|newborn|kids?|children(?:'s)?|nursery|linens?|bedding)\s*(?:clothes?|clothing|bedding|linens?|blankets?|towels?|wipes?|diapers?|bottles?|laundry|supplies|essentials|items?|gear)?\b/gi;
const ADULT_CAREGIVER_PRODUCT_RE = /\b(?:diaper\s+(?:bag|backpack|tote|caddy|organizer|pouch)|stroller\s+(?:organizer|cup\s+holder|hook|hooks|caddy|bag|phone\s+mount)|baby\s+monitor\s+(?:(?:wall|floor|crib|table|shelf|clamp|clip|flexible|gooseneck|universal|adjustable)\s+)*(?:mount|stand|holder|shelf|shelving|bracket)|(?:newborn\s+)?nursery\s+(?:(?:adjustable|modular|heavy(?:-|\s+)duty|wall(?:-|\s+)mounted|wall|floating|hanging|wooden|metal|wire|bamboo|acrylic|corner|tiered|multi(?:-|\s+)tier|foldable|portable|rolling|closet|laundry|linen|bedding|storage|over(?:-|\s+)the(?:-|\s+)door)\s+)*(?:shelf|shelves|shelving|organizer|organizers|caddy|caddies|hamper|hampers|basket|baskets|storage|bin|bins|sorter|sorters|rack|racks|stand|mount|hook|hooks|bracket|rod|drawer|drawers|cabinet)|nursing\s+(?:cover|pillow\s+for\s+mom|bag)|breast\s+pump\s+bag)\b|(?:妈咪包|尿布收纳包|推车挂包|推车杯架|育婴室(?:置物架|收纳架|壁挂架|脏衣篓)|宝妈包)/gi;
const ADULT_AUDIENCE_PHRASE_RE = /\b(?:for|designed\s+for|used\s+by|operated\s+by|intended\s+for|carried\s+by|worn\s+by)\s+(?:new\s+)?(?:parents?|moms?|dads?|mothers?|fathers?|caregivers?|adults?)\b|(?:父母用|家长用|成人收纳)/gi;

const CHILDRENS_BENIGN_COLOR_OR_MATERIAL_RE = /\b(?:baby(?:'s|’s)?\s+(?:blue|pink|breath|greens?|spinach|corn|carrots?|potatoes?|back\s+ribs?|oil|powder\s+scent|alpaca|goat|lock\s+(?:sewing|serger|overlock|embroidery|quilting))|kid\s+(?:leather|skin|gloves?|suede)|child[- ]?(?:resistant|proof|lock\w*))\b/gi;
const NON_CHILD_DOMAIN_EXEMPTION_RE = new RegExp(
  [
    // Musical instruments (e.g. "Baby Grand Piano Cover", "Baby Taylor Guitar")
    String.raw`\bbaby\s+grand(?:\s+piano(?:\s+(?:cover|covers|bench|caster|cups?|lamp|mat|pad|protector|dust\s+cover))?)?\b`,
    String.raw`\bbaby\s+taylor(?:\s+guitar)?\b`,
    // Horticulture / plant / garden / tree nursery supplies:
    // (a) Unambiguously horticultural nursery nouns ("Nursery Pots", "Nursery Grow Bags", "Nursery Planters", "Nursery Grafting Tape")
    String.raw`\b(?:(?:plant|tree|garden|greenhouse|seedling|propagat(?:ing|ion)|planting|plastic|biodegradable|peat|black|fabric|gallon|inch|potting|flower|herb|succulent)\s+)*nursery\s+(?:(?:plant|seedling|grafting|planting|garden|tree)\s+)*(?:pots?|grow\s+bags?|planters?|flats?|cell\s+trays?|stakes?|greenhouses?|grafting\s+(?:tape|wax|clips?|knives?|tools?|supplies))\b`,
    // (b) Generic nouns ("mats", "cups", "supplies", "bags", "trays", etc.) REQUIRE an explicit horticulture modifier before or after "nursery"
    String.raw`\b(?:plant|tree|garden|greenhouse|seedling|propagat(?:ing|ion)|planting|peat|biodegradable|gallon|grafting|horticultur\w*|potting|flower|herb|succulent)\s+(?:(?:plastic|black|fabric|inch|heavy[- ]duty)\s+)*nursery\s+(?:(?:plant|seedling|grafting|planting|garden|tree)\s+)*(?:trays?|bags?|containers?|cups?|labels?|tags?|mesh|mats?|supplies|tape)\b`,
    String.raw`\bnursery\s+(?:plant|seedling|grafting|planting|garden|tree)\s+(?:trays?|bags?|containers?|cups?|labels?|tags?|mesh|mats?|supplies|tape)\b`,
    String.raw`\b(?:plant|tree|garden|greenhouse|seedling|horticultur\w*)\s+nursery\b`,
    // Photography / film / studio grip 5/8" baby pin/plate hardware (requires 5/8" or explicit studio/lighting/grip context so "Baby Plate" feeding dishes are NEVER exempted!)
    String.raw`\b5\/8(?:\s*-?\s*inch|")?\s+baby\s+(?:pins?|plates?|wall\s+plates?|receivers?|studs?|spigots?|adapters?|clamps?|grips?)\b`,
    String.raw`\bbaby\s+(?:pins?|wall\s+plates?|receivers?|studs?|spigots?|c-?stands?|light\s+stands?)\s+(?:for\s+)?(?:studio|lighting|grip|camera|photo|photography|cinema|film|video|flash|softbox|strobe|monolight)\b`,
    String.raw`\b(?:studio|lighting|grip|camera|photo|photography|cinema|film)\s+(?:(?:wall|mounting|heavy[- ]duty|metal|steel|aluminum)\s+)*baby\s+(?:pins?|plates?|wall\s+plates?|receivers?|studs?|spigots?|adapters?|clamps?|grips?)\b`,
    // Pet / animal gear (dogs, cats, puppies, kittens, pets — supports both "booster car seat" and "car booster seat")
    String.raw`\b(?:(?:dog|dogs|puppy|puppies|cat|cats|kitten|kittens|pet|pets|rabbit|bunny|guinea\s+pig|ferret|hamster|chicken|poultry)\s+)+(?:(?:foldable|collapsible|portable|heavy[- ]duty|outdoor|indoor|mesh|elevated|console|travel|waterproof|washable|disposable|reusable|male|female|4-?wheel|3-?wheel|double|twin|small|medium|large)\s+)*(?:(?:booster\s+)?car\s+seat|car\s+booster\s+seat|booster\s+seat|stroller|playpen|play\s+pen|diaper|diapers|crib|bib|bibs|carrier|wagon)\b`,
    String.raw`\b(?:(?:booster\s+)?car\s+seat|car\s+booster\s+seat|booster\s+seat|stroller|playpen|play\s+pen|diaper|diapers)\s+for\s+(?:(?:small|medium|large|extra[- ]large)\s+)?(?:dogs?|pupp(?:y|ies)|cats?|kittens?|pets?|animals?)\b`,
    // Adult automotive car seat accessories & explicit adult driving/office booster cushions (never child/infant safety car seats)
    String.raw`\b(?:(?:leather|neoprene|waterproof|heated|cooling|cooled|ventilated|universal|front|rear|back|bucket|bench|automotive|auto|truck|suv|sedan|van|mesh|linen|memory\s+foam|orthopedic|lumbar)\s+)*car\s+seat\s+(?:cover|covers|protector|protectors|gap\s+filler|gap\s+fillers|gap\s+organizer|organizer|organizers|cushion|cushions|pad|pads|mat|mats|headrest|pillow|hook|hooks|storage|pocket|caddy|back\s+organizer|kick\s+mat|belt\s+cover|belt\s+pad|heater|warmer|cooler|massager)\b`,
    String.raw`\badult\s+(?:car\s+)?booster\s+seat\s+(?:cushion|cushions|pad|pads|pillow|mat)\b`,
    String.raw`\b(?:car\s+)?booster\s+seat\s+(?:cushion|cushions|pad|pads|pillow)\s+for\s+(?:short\s+drivers?|adults?|driving|office\s+chairs?|car\s+seats?)\b`,
  ].join('|'),
  'gi',
);
const CHILDRENS_NEGATION_OR_WARNING_RE = /\b(?:not\s+(?:for|intended\s+for|suitable\s+for|designed\s+for|a\s+toy\s+for)|keep\s+(?:away\s+from|out\s+of\s+(?:the\s+)?reach\s+of)|out\s+of\s+(?:the\s+)?reach\s+of|for\s+adults?\s+only[^.;,|]*not\s+for)\s+(?:all\s+|young\s+|small\s+)?(?:children|kids?|babies|infants?|toddlers?|minors?)(?:\s+and\s+(?:pets?|animals?|children|kids?))?\b|(?:非儿童(?:用品|玩具|产品)?|不适合儿童|勿让儿童(?:接触|触碰|玩耍)?|请勿让儿童(?:接触|触碰|使用)?|儿童勿[用近触碰]|远离儿童|放在儿童接触不到的地方|仅供成人)/gi;

function assertActiveRevision59(rev, fnName) {
  if (rev !== undefined && rev !== null && (!Number.isInteger(rev) || rev < 59)) {
    throw new TypeError(`${fnName}: profile_revision ${rev} (< 59) is retired; use Git tag archive/r50-r58-frozen-replay-20261125 for historical replay.`);
  }
}

function evaluateChildrensStatutoryBoundary(item, textBlob, { profileRevision = 59 } = {}) {
  assertActiveRevision59(profileRevision, 'evaluateGate0CategoryBoundary');
  if (item?.is_childrens_product === true || item?.is_children_product === true || item?.cpc_required === true) {
    return { isChildrens: true, adultExemptionApplied: false, exemptionReason: null };
  }
  const ageGroup = String(item?.age_group || '').trim().toLowerCase();
  if (['kids', 'child', 'children', 'baby', 'toddler', 'infant'].includes(ageGroup)) {
    return { isChildrens: true, adultExemptionApplied: false, exemptionReason: null };
  }
  if (['adult', 'adults', 'parent', 'parents', 'caregiver'].includes(ageGroup)) {
    return { isChildrens: false, adultExemptionApplied: true, exemptionReason: 'explicit_adult_metadata' };
  }
  // US CPSC / CPC statutory boundary: <= 12 years of age.
  if (finite(item?.max_target_age_years) && item.max_target_age_years > 0 && item.max_target_age_years <= BUSINESS_THRESHOLDS.children_statutory_max_age_years) {
    return { isChildrens: true, adultExemptionApplied: false, exemptionReason: null };
  }
  if (item?.is_childrens_product === false && item?.cpc_required === false) {
    return { isChildrens: false, adultExemptionApplied: true, exemptionReason: 'explicit_non_child_flags' };
  }
  if (finite(item?.min_age_years) && item.min_age_years > BUSINESS_THRESHOLDS.children_statutory_max_age_years) {
    return { isChildrens: false, adultExemptionApplied: true, exemptionReason: 'explicit_age_gt_12' };
  }
  if (!textBlob) {
    return { isChildrens: false, adultExemptionApplied: false, exemptionReason: null };
  }
  const rawMatchedChildToken = CHILDRENS_RE.test(textBlob) || STRICT_CHILD_USE_ITEM_RE.test(textBlob);
  let scrubbed = textBlob
    .replace(CHILDRENS_NEGATION_OR_WARNING_RE, ' ')
    .replace(CHILDRENS_BENIGN_COLOR_OR_MATERIAL_RE, ' ')
    .replace(NON_CHILD_DOMAIN_EXEMPTION_RE, ' ');
  const domainOrBenignScrubbed = scrubbed !== textBlob;
  let caregiverScrubbed = false;
  if (!STRICT_CHILD_USE_ITEM_RE.test(scrubbed)) {
    const beforeCaregiver = scrubbed;
    scrubbed = scrubbed.replace(ADULT_CAREGIVER_PRODUCT_RE, ' ');
    if (scrubbed !== beforeCaregiver) {
      caregiverScrubbed = true;
      scrubbed = scrubbed.replace(/\b(?:baby|babies|toddler|infant|newborn|diaper|stroller|nursery)\b/gi, ' ');
    }
    const beforeContainer = scrubbed;
    scrubbed = scrubbed.replace(HOUSEHOLD_CONTAINER_CONTENT_RE, ' ');
    if (scrubbed !== beforeContainer) caregiverScrubbed = true;
    scrubbed = scrubbed.replace(ADULT_AUDIENCE_PHRASE_RE, ' ');
  }
  const stillChildrens = CHILDRENS_RE.test(scrubbed) || STRICT_CHILD_USE_ITEM_RE.test(scrubbed);
  return {
    isChildrens: stillChildrens,
    adultExemptionApplied: !stillChildrens && (domainOrBenignScrubbed || caregiverScrubbed || rawMatchedChildToken),
    exemptionReason: !stillChildrens
      ? (domainOrBenignScrubbed ? 'non_child_domain_or_benign_phrase' : (caregiverScrubbed ? 'adult_caregiver_or_storage' : null))
      : null,
  };
}

function matchesChildrensStatutoryBoundary(item, textBlob, options = {}) {
  return evaluateChildrensStatutoryBoundary(item, textBlob, options).isChildrens;
}

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
    red_ocean_furniture: false,
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
 * Cross-category Gate-0 boundary filter (`docs/SPEC.md`):
 * - Hard-excludes statutory <=12y US CPSC/CPC children's products (preserving adult/horticulture/musical/studio/pet/automotive exemptions).
 * - Applies configurable discovery-intake skip defaults for confirmed ordinary apparel & commodity 3C phone-case/cable leads (furniture is NOT blocked by default).
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

  const childEval = evaluateChildrensStatutoryBoundary(item, textBlob, { profileRevision: config.profile_revision ?? 59 });
  if (childEval.isChildrens) {
    return {
      passed: false,
      verdict: 'excluded_childrens_product',
      hard_exclusion: true,
      adult_exemption_applied: false,
      reasons: ['Excluded under fixed Gate-0 US CPSC/CPC statutory children/baby boundary (<=12 years, non-overridable).'],
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
      adult_exemption_applied: childEval.adultExemptionApplied,
      ...(childEval.exemptionReason ? { adult_exemption_reason: childEval.exemptionReason } : {}),
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
      adult_exemption_applied: childEval.adultExemptionApplied,
      ...(childEval.exemptionReason ? { adult_exemption_reason: childEval.exemptionReason } : {}),
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
    adult_exemption_applied: childEval.adultExemptionApplied,
    ...(childEval.exemptionReason ? { adult_exemption_reason: childEval.exemptionReason } : {}),
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
    let singleCouponFrac = discFrac;
    const hasPrime = (finite(raw?.prime_exclusive_discount_usd) && raw.prime_exclusive_discount_usd > 0) ||
      (finite(raw?.prime_exclusive_discount_pct) && raw.prime_exclusive_discount_pct > 0 && raw.prime_exclusive_discount_pct < 1);
    if (hasPrime && listPrice > 0) {
      let cUsd = 0;
      if (finite(raw?.ongoing_coupon_usd) && raw.ongoing_coupon_usd > 0) cUsd += raw.ongoing_coupon_usd;
      else if (finite(raw?.coupon_usd) && raw.coupon_usd > 0) cUsd += raw.coupon_usd;
      if (finite(raw?.ongoing_coupon_pct) && raw.ongoing_coupon_pct > 0 && raw.ongoing_coupon_pct < 1) cUsd += listPrice * raw.ongoing_coupon_pct;
      else if (finite(raw?.coupon_pct) && raw.coupon_pct > 0 && raw.coupon_pct < 1) cUsd += listPrice * raw.coupon_pct;
      else if (raw?.coupon !== undefined) cUsd += parseCouponValue(raw.coupon, listPrice);
      singleCouponFrac = cUsd > 0 ? round(Math.min(listPrice, cUsd) / listPrice, 6) : 0;
    }
    return { valid: true, list_price_usd: listPrice, net_price_usd: explicitNet, discount_fraction: discFrac, single_coupon_fraction: singleCouponFrac };
  }
  if (listPrice === null) return { valid: false, list_price_usd: null, net_price_usd: null, discount_fraction: 0, single_coupon_fraction: 0 };
  if (finite(raw?.promo_price_usd) && raw.promo_price_usd > 0 && raw.promo_price_usd < listPrice) {
    const net = raw.promo_price_usd;
    const discFrac = round((listPrice - net) / listPrice, 6);
    return { valid: true, list_price_usd: listPrice, net_price_usd: net, discount_fraction: discFrac, single_coupon_fraction: discFrac };
  }

  let couponDiscountUsd = 0;
  let primeDiscountUsd = 0;
  const hasExplicitCouponUsd = (finite(raw?.ongoing_coupon_usd) && raw.ongoing_coupon_usd > 0) ||
    (finite(raw?.coupon_usd) && raw.coupon_usd > 0);
  const hasExplicitCouponPct = (finite(raw?.ongoing_coupon_pct) && raw.ongoing_coupon_pct > 0 && raw.ongoing_coupon_pct < 1) ||
    (finite(raw?.coupon_pct) && raw.coupon_pct > 0 && raw.coupon_pct < 1);

  if (finite(raw?.ongoing_coupon_usd) && raw.ongoing_coupon_usd > 0) couponDiscountUsd += raw.ongoing_coupon_usd;
  else if (finite(raw?.coupon_usd) && raw.coupon_usd > 0) couponDiscountUsd += raw.coupon_usd;

  if (finite(raw?.ongoing_coupon_pct) && raw.ongoing_coupon_pct > 0 && raw.ongoing_coupon_pct < 1) {
    couponDiscountUsd += listPrice * raw.ongoing_coupon_pct;
  } else if (finite(raw?.coupon_pct) && raw.coupon_pct > 0 && raw.coupon_pct < 1) {
    couponDiscountUsd += listPrice * raw.coupon_pct;
  } else if (!hasExplicitCouponUsd && !hasExplicitCouponPct && raw?.coupon !== undefined) {
    couponDiscountUsd += parseCouponValue(raw.coupon, listPrice);
  }
  if (finite(raw?.prime_exclusive_discount_usd) && raw.prime_exclusive_discount_usd > 0) {
    primeDiscountUsd += raw.prime_exclusive_discount_usd;
  }
  if (finite(raw?.prime_exclusive_discount_pct) && raw.prime_exclusive_discount_pct > 0 && raw.prime_exclusive_discount_pct < 1) {
    primeDiscountUsd += listPrice * raw.prime_exclusive_discount_pct;
  }
  const discountUsd = couponDiscountUsd + primeDiscountUsd;

  // Settle discounted US checkout prices in whole cents (matching fee-basis.mjs resolveEffectivePricing across $10/$50 FBA cliffs).
  const net = discountUsd > 0 ? round(listPrice - discountUsd, 2) : round(listPrice, 4);
  if (net <= 0) return { valid: false, list_price_usd: listPrice, net_price_usd: null, discount_fraction: 1, single_coupon_fraction: 1 };
  const couponNet = couponDiscountUsd > 0 ? Math.max(0, round(listPrice - couponDiscountUsd, 2)) : listPrice;
  return {
    valid: true,
    list_price_usd: listPrice,
    net_price_usd: net,
    discount_fraction: discountUsd > 0 ? round((listPrice - net) / listPrice, 6) : 0,
    single_coupon_fraction: couponDiscountUsd > 0 ? round((listPrice - couponNet) / listPrice, 6) : 0,
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

const DEFAULT_NEWCOMER_MAX_AGE_DAYS = BUSINESS_THRESHOLDS.newcomer_max_age_days;
const DEFAULT_HEAVY_COUPON_THRESHOLD = BUSINESS_THRESHOLDS.heavy_single_coupon_pct_threshold;

function historicalPrices(raw) {
  return ['keepa_90d_median_usd', 'historical_regular_price_usd']
    .filter(source => finite(raw?.[source]) && raw[source] > 0)
    .map(source => ({ price_usd: raw[source], source }));
}

const DEFAULT_VETERAN_MATURE_MIN_AGE_DAYS = BUSINESS_THRESHOLDS.veteran_min_age_days;

/**
 * Qualitative/structured flag check for veteran clearance / price-war volatility ("老品清仓／恶战波动").
 * Strictly driven by verified AI qualitative observation buckets (`MarketObservationJudge`) or explicit
 * trajectory labels — zero unapproved hardcoded day/ratio cutoffs.
 */
export function detectKeepaVeteranClearanceOrWar(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (
    raw.keepa_sustained_drop === true ||
    raw.sustained_drop_or_clearance_watch === true ||
    raw.keepa?.sustained_drop_or_clearance_watch === true ||
    raw.keepa_clearance === true ||
    raw.keepa_price_war === true ||
    raw.keepa_90d_unstable === true ||
    raw.veteran_clearance_or_war_watch === true ||
    raw.ai_qualitative_bucket === 'veteran_clearance_or_war'
  ) {
    return true;
  }
  const traj = String(raw.keepa_trajectory ?? raw.keepa_90d_stability ?? '').trim().toLowerCase();
  if (['sustained_drop', 'clearance', 'clearance_volatility', 'clearance_or_war', 'price_war', 'volatile'].includes(traj)) {
    return true;
  }
  return false;
}

export function resolveHolidayPromoReference(raw, netPrice, {
  as_of_date = new Date().toISOString().slice(0, 10),
  spiral_max_age_days = DEFAULT_NEWCOMER_MAX_AGE_DAYS,
  heavy_coupon_threshold = DEFAULT_HEAVY_COUPON_THRESHOLD,
  profile_revision = 59,
} = {}) {
  assertActiveRevision59(profile_revision, 'resolveHolidayPromoReference');
  const age = resolveAgeDays(raw, as_of_date);
  if (age === null || age < spiral_max_age_days + 1 || !finite(netPrice) || netPrice <= 0) return null;
  if (detectKeepaVeteranClearanceOrWar(raw)) return null;
  if (raw?.ai_qualitative_bucket === 'temporary_event_promo' || raw?.temporary_event_promo === true) {
    return historicalPrices(raw)[0] ?? null;
  }
  const priceRes = resolveListingNetPrice(raw);
  const hasExplicitCouponToken =
    (finite(raw?.ongoing_coupon_usd) && raw.ongoing_coupon_usd > 0) ||
    (finite(raw?.coupon_usd) && raw.coupon_usd > 0) ||
    (finite(raw?.ongoing_coupon_pct) && raw.ongoing_coupon_pct > 0) ||
    (finite(raw?.coupon_pct) && raw.coupon_pct > 0) ||
    (raw?.coupon !== undefined && parseSingleUnitUsdCoupon(raw.coupon).type !== 'none');
  const isRoutineSmallCoupon = hasExplicitCouponToken &&
    priceRes.valid &&
    priceRes.discount_fraction > 0 &&
    priceRes.discount_fraction < heavy_coupon_threshold;
  const net = toBigRat(netPrice);
  const listRat = priceRes.valid && finite(priceRes.list_price_usd) && priceRes.list_price_usd > 0
    ? toBigRat(priceRes.list_price_usd)
    : null;
  const promoKeepRatioPct = BigInt(Math.round((1 - heavy_coupon_threshold) * 100));
  for (const reference of historicalPrices(raw)) {
    const regular = toBigRat(reference.price_usd);
    if (isRoutineSmallCoupon && listRat && listRat.n * regular.d * 100n > regular.n * listRat.d * promoKeepRatioPct) {
      continue;
    }
    if (net.n * regular.d * 100n <= regular.n * net.d * promoKeepRatioPct) {
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
    const cls = classifySizeTier2027(raw.pkg);
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

function resolveParentAsinKey(raw) {
  const p = raw?.parent_asin ?? raw?.parentAsin ?? raw?.parent ?? null;
  if (typeof p === 'string' && p.trim()) return p.trim().toUpperCase();
  return null;
}

/**
 * Deterministic sales-weighted quantile over distinct net_price_usd levels.
 * Under profileRevision >= 59, aggregates monthly_units across tied net prices first and
 * uses first-passage empirical quantile (never inventing untraded midpoint prices).
 * Under profileRevision < 59, preserves exact legacy midpoint interpolation for frozen replay.
 */
export function weightedQuantile(rows, q, { profileRevision = 59 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.net_price_usd - b.net_price_usd || String(a.asin || '').localeCompare(String(b.asin || '')));
  if ((profileRevision ?? 59) < 59) {
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
  const grouped = [];
  for (const r of sorted) {
    const w = finite(r.monthly_units) && r.monthly_units > 0 ? r.monthly_units : 1;
    const last = grouped[grouped.length - 1];
    if (last && Math.abs(last.net_price_usd - r.net_price_usd) <= 1e-9) {
      last.weight += w;
    } else {
      grouped.push({ net_price_usd: r.net_price_usd, weight: w });
    }
  }
  if (grouped.length === 1) return grouped[0].net_price_usd;
  const totalWeight = grouped.reduce((s, g) => s + g.weight, 0);
  const target = q * totalWeight;
  let cum = 0;
  for (let i = 0; i < grouped.length; i++) {
    cum += grouped[i].weight;
    if (cum >= target - 1e-9) {
      return grouped[i].net_price_usd;
    }
  }
  return grouped[grouped.length - 1].net_price_usd;
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
 * Stage-1 mainstream price-band denoising + 3-tier listing age priority (r59):
 *  - Excludes FBM, <10/mo low-sales zombies, CPSC <=12y children's products, and optional size-tier mismatches.
 *  - Deduplicates sibling color/variant ASINs sharing the same `parent_asin` before P25-P75 weighting (`r59`).
 *  - Three-tier listing age priority (`r59`):
 *      1. `<= 90` days = Newcomer ("新品起盘参考价") -> serves Q31 newcomer performance, never drags primary margin;
 *      2. `>= 365` days = Mature Veteran -> 1st-priority primary price band (`mature_regular_band`);
 *      3. `91–364` days = Growth Stage -> automatically supplements primary band ONLY when `>= 365d` veterans < 2;
 *      4. Ultra-new `< 90d` (`<= 90d`) Blue Ocean -> never errors/blocks; computes a reference band from regular prices
 *         excluding >=20% heavy coupons and attaches top amber banner `"全员 90 天内新品蓝海，暂无一年期老品稳态价"`.
 *  - Every peer moved out of the primary band is preserved in `observed_out_of_band_peers[]` with original price & Chinese reason.
 *  - Advisory non-blocking reference indicators ONLY: `<10/mo` zombie, `>=20%` heavy coupon, `>1.35x` spread (`max_margin_spread_pp` retired in `r59`).
 */
export function analyzeMainstreamPriceBand(listings, options = {}) {
  if (!Array.isArray(listings)) throw new TypeError('listings must be an array.');
  const {
    profile_revision = 59,
    observation_date = null,
    as_of_date = observation_date ?? new Date().toISOString().slice(0, 10),
    min_monthly_units = BUSINESS_THRESHOLDS.zombie_min_monthly_sales,
    veteran_min_age_days = DEFAULT_VETERAN_MATURE_MIN_AGE_DAYS,
    isolate_heavy_coupon_outliers = true,
    include_amz_1p = true,
    target_size_tier = null,
    target_pkg = null,
    max_width_ratio = BUSINESS_THRESHOLDS.advisory_band_spread_ratio,
    minimum_price_floor_usd = BUSINESS_THRESHOLDS.minimum_reference_price_usd,
    gate0_config = {},
    market_observation_result = null,
  } = options;
  assertActiveRevision59(profile_revision, 'analyzeMainstreamPriceBand');
  const isR59 = true;
  const hasAnyKnownAge = Array.isArray(listings) && listings.some(r => r && resolveAgeDays(r, as_of_date) !== null);
  const strict_mature_only = options.strict_mature_only !== undefined
    ? Boolean(options.strict_mature_only)
    : Boolean(hasAnyKnownAge);
  const spiral_max_age_days = options.spiral_max_age_days ?? DEFAULT_NEWCOMER_MAX_AGE_DAYS;
  const heavy_coupon_threshold = options.heavy_coupon_threshold ?? DEFAULT_HEAVY_COUPON_THRESHOLD;

  const marketJudgeByAsin = new Map();
  if (market_observation_result && Array.isArray(market_observation_result.peer_observations)) {
    for (const obs of market_observation_result.peer_observations) {
      const k = typeof obs?.asin === 'string' && obs.asin.trim() ? obs.asin.trim().toUpperCase() : null;
      if (k && obs?.qualitative_judgment && typeof obs.qualitative_judgment === 'object') {
        marketJudgeByAsin.set(k, obs.qualitative_judgment);
      }
    }
  }

  let resolvedTargetTier = typeof target_size_tier === 'string' && target_size_tier.trim()
    ? target_size_tier.trim().toLowerCase().replace(/\s+/g, '_')
    : null;
  if (!resolvedTargetTier && target_pkg && typeof target_pkg === 'object') {
    const cls = classifySizeTier2027(target_pkg);
    if (cls.size_tier) resolvedTargetTier = cls.size_tier;
  }

  // Step 1: Deterministic permutation-invariant deduplication by ASIN
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
  const asinDeduped = [...byAsin.values()]
    .sort((a, b) => a.asin.localeCompare(b.asin))
    .map(({ raw, asin }) => ({ raw, asin }));

  const deduplicatedParentSiblings = [];
  const observedOutOfBandPeers = [];
  const excluded = [];
  const preParentDedupCandidates = [];
  const historicalPeers = [];
  const amazon1pOffers = [];

  // Step 2: Filter spec mismatch / FBM / zombies / CPSC children / size tier FIRST so an ineligible sibling
  // (e.g. FBM or bare accessory part) never evicts a valid FBA complete-kit sibling under the same parent_asin!
  for (const { raw, asin } of asinDeduped) {
    const priceRes = resolveListingNetPrice(raw);
    if (!priceRes.valid) {
      excluded.push({ asin, reason_code: 'invalid_price', reason: 'Missing or non-positive price.' });
      continue;
    }
    const ageDays = resolveAgeDays(raw, as_of_date);
    const fulfillment = resolveFulfillment(raw);
    if (fulfillment === 'AMZ') {
      amazon1pOffers.push({ asin, price_usd: priceRes.net_price_usd, title: raw?.title ?? null });
    }
    const judgeEntry = marketJudgeByAsin.get(asin) ??
      (raw?.qualitative_judgment && typeof raw.qualitative_judgment === 'object' ? raw.qualitative_judgment : null);
    const rawAiBucket = typeof judgeEntry?.bucket === 'string' && judgeEntry.bucket.trim()
      ? judgeEntry.bucket.trim()
      : (typeof raw?.ai_qualitative_bucket === 'string' && raw.ai_qualitative_bucket.trim() ? raw.ai_qualitative_bucket.trim() : null);
    const rawAiReasonZh = typeof judgeEntry?.reason_zh === 'string' && judgeEntry.reason_zh.trim()
      ? judgeEntry.reason_zh.trim()
      : (typeof raw?.ai_reason_zh === 'string' && raw.ai_reason_zh.trim() ? raw.ai_reason_zh.trim() : null);

    const isExplicitSpecMismatch = isR59 && (
      raw?.spec_matched === false ||
      raw?.matched_spec === false ||
      raw?.is_bare_part === true ||
      raw?.is_accessory_only === true ||
      rawAiBucket === 'spec_mismatch_or_accessory' ||
      rawAiBucket === 'bare_part_or_different_spec' ||
      rawAiBucket === 'multi_pack_or_bundle_variant'
    );
    if (isExplicitSpecMismatch) {
      const reasonZh = rawAiReasonZh ?? '裸件／非齐套配件或规格不匹配，移出同规格主价位带留底';
      excluded.push({
        asin,
        price_usd: priceRes.net_price_usd,
        reason_code: 'excluded_spec_mismatch_or_bare_part',
        reason: 'Excluded bare part / unmatched specification.',
      });
      observedOutOfBandPeers.push({
        asin,
        title: raw?.title ?? null,
        original_price_usd: priceRes.list_price_usd,
        net_price_usd: priceRes.net_price_usd,
        age_days: ageDays,
        reason_code: 'excluded_spec_mismatch_or_bare_part',
        reason_zh: reasonZh,
      });
      continue;
    }

    if (fulfillment === 'FBM' || (fulfillment !== 'FBA' && !(include_amz_1p && fulfillment === 'AMZ'))) {
      const exRow = {
        asin,
        price_usd: priceRes.net_price_usd,
        fulfillment,
        reason_code: fulfillment === 'FBM' ? 'excluded_fbm' : 'excluded_non_fba',
        reason: `Excluded non-FBA fulfillment (${fulfillment}).`,
      };
      excluded.push(exRow);
      if (isR59) {
        observedOutOfBandPeers.push({
          asin,
          title: raw?.title ?? null,
          original_price_usd: priceRes.list_price_usd,
          net_price_usd: priceRes.net_price_usd,
          age_days: ageDays,
          reason_code: exRow.reason_code,
          reason_zh: `非 FBA 履约（${fulfillment}），不计入 FBA 主力参考价位带`,
        });
      }
      continue;
    }

    const monthlyUnits = resolveMonthlyUnits(raw);
    if (monthlyUnits !== null && monthlyUnits < min_monthly_units) {
      const exRow = {
        asin,
        price_usd: priceRes.net_price_usd,
        monthly_units: monthlyUnits,
        reason_code: 'excluded_low_sales_zombie',
        reason: `Monthly sales (${monthlyUnits}) below denoising floor (${min_monthly_units}/mo).`,
      };
      excluded.push(exRow);
      if (isR59) {
        observedOutOfBandPeers.push({
          asin,
          title: raw?.title ?? null,
          original_price_usd: priceRes.list_price_usd,
          net_price_usd: priceRes.net_price_usd,
          age_days: ageDays,
          reason_code: 'excluded_low_sales_zombie',
          reason_zh: `月销 ${monthlyUnits} < ${min_monthly_units}（低销僵尸链接噪点，仅移出主价位带留底）`,
        });
      }
      continue;
    }

    const gate0 = evaluateGate0CategoryBoundary(raw, {
      ...gate0_config,
      profile_revision: gate0_config.profile_revision ?? profile_revision,
      avoid_red_ocean: gate0_config.avoid_red_ocean ?? { apparel: false, consumer_electronics_3c: false, red_ocean_furniture: false, fda_ingestible_topical: false },
    });
    if (!gate0.passed && gate0.verdict === 'excluded_childrens_product') {
      excluded.push({
        asin,
        price_usd: priceRes.net_price_usd,
        reason_code: 'excluded_childrens_product',
        reason: gate0.reasons[0],
      });
      if (isR59) {
        observedOutOfBandPeers.push({
          asin,
          title: raw?.title ?? null,
          original_price_usd: priceRes.list_price_usd,
          net_price_usd: priceRes.net_price_usd,
          age_days: ageDays,
          reason_code: 'excluded_childrens_product',
          reason_zh: '命中美国 CPSC/CPC 法定儿童品（≤12岁）红线排除',
        });
      }
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
      if (isR59) {
        observedOutOfBandPeers.push({
          asin,
          title: raw?.title ?? null,
          original_price_usd: priceRes.list_price_usd,
          net_price_usd: priceRes.net_price_usd,
          age_days: ageDays,
          reason_code: 'excluded_size_tier_mismatch',
          reason_zh: `FBA 尺寸档位（${sizeTier}）与目标档位（${resolvedTargetTier}）不同，单列观察`,
        });
      }
      continue;
    }

    const aiBucket = rawAiBucket;
    const aiReasonZh = rawAiReasonZh;

    const regularReference = resolveHolidayPromoReference(raw, priceRes.net_price_usd, {
      as_of_date,
      spiral_max_age_days,
      heavy_coupon_threshold,
      profile_revision,
    });
    const explicitKeepaUnsteady = Boolean(
      raw?.keepa_price_steady === false ||
      raw?.keepa_90d_steady === false ||
      raw?.keepa?.price_steady === false ||
      raw?.keepa?.keepa_90d_steady === false,
    );
    const steadyKeepaRef = (!isR59 || (!detectKeepaVeteranClearanceOrWar(raw) && !explicitKeepaUnsteady))
      ? (regularReference ?? historicalPrices(raw)[0] ?? null)
      : null;
    const isAiNewcomerRef = rawAiBucket !== null && ['newcomer_reference', 'newcomer_launch_reference', 'newcomer_le_90d_launch_ref'].includes(rawAiBucket);
    const isNewcomerR59 = isR59
      ? ((ageDays !== null && ageDays <= spiral_max_age_days) || (ageDays === null && isAiNewcomerRef))
      : (ageDays !== null && ageDays < spiral_max_age_days);
    const isVeteranClearanceOrWar = isR59 && ageDays !== null && !isNewcomerR59 && (
      detectKeepaVeteranClearanceOrWar(raw) || aiBucket === 'veteran_clearance_or_war'
    );
    const hasExplicitKeepaSteady = Boolean(
      !isVeteranClearanceOrWar &&
      !explicitKeepaUnsteady &&
      (
        raw?.keepa_price_steady === true ||
        raw?.keepa_90d_steady === true ||
        raw?.keepa?.price_steady === true ||
        raw?.keepa?.keepa_90d_steady === true ||
        aiBucket === 'primary_comparable' ||
        steadyKeepaRef !== null ||
        ['steady', 'stable', 'flat'].includes(
          String(raw?.keepa_trajectory ?? raw?.keepa_90d_stability ?? raw?.keepa?.trajectory ?? raw?.keepa?.stability ?? '')
            .trim()
            .toLowerCase(),
        )
      ),
    );
    const seedMergedUnverified = Boolean(
      (raw?.old_reviews_predate_launch === true || raw?.seed_merged_reviews === true) &&
      raw?.current_form_sustained_regular_price_verified !== true,
    );
    preParentDedupCandidates.push({
      raw,
      cand: {
        asin,
        parent_asin: resolveParentAsinKey(raw),
        title: raw?.title ?? null,
        brand: raw?.brand ?? null,
        fulfillment,
        is_amazon_1p: fulfillment === 'AMZ',
        list_price_usd: priceRes.list_price_usd,
        net_price_usd: priceRes.net_price_usd,
        discount_fraction: priceRes.discount_fraction,
        single_coupon_fraction: priceRes.single_coupon_fraction ?? priceRes.discount_fraction,
        ...(regularReference ? { regular_price_reference: regularReference } : {}),
        ...(steadyKeepaRef ? { keepa_steady_reference: steadyKeepaRef } : {}),
        ...(hasExplicitKeepaSteady ? { keepa_steady_verified: true } : {}),
        ...(isVeteranClearanceOrWar ? { veteran_clearance_or_war_watch: true, watch_label_zh: aiReasonZh ?? '老品清仓／恶战波动' } : {}),
        ...(aiBucket ? { ai_qualitative_bucket: aiBucket, ...(aiReasonZh ? { ai_reason_zh: aiReasonZh } : {}) } : {}),
        ...(explicitKeepaUnsteady ? { keepa_price_unsteady: true } : {}),
        ...(seedMergedUnverified ? { seed_merged_unverified_price: true } : {}),
        monthly_units: monthlyUnits,
        age_days: ageDays,
        size_tier: sizeTier,
        rating: finite(raw?.rating) ? raw.rating : null,
        reviews: finite(raw?.reviews) ? raw.reviews : (finite(raw?.ratings) ? raw.ratings : null),
        image_url: raw?.image_url ?? null,
      },
      isNewcomerR59,
      isVeteranClearanceOrWar,
      hasExplicitKeepaSteady,
      seedMergedUnverified,
      steadyKeepaRef,
    });
  }

  const poolHasKeepaEvidence = Boolean(
    isR59 && (
      options.require_keepa_steady_evidence === true ||
      market_observation_result !== null ||
      preParentDedupCandidates.some(e =>
        e.hasExplicitKeepaSteady ||
        e.cand.keepa_price_unsteady === true ||
        e.isVeteranClearanceOrWar === true ||
        e.raw?.keepa_package_only === true ||
        e.raw?.keepa !== undefined ||
        e.raw?.keepa_trend !== undefined ||
        e.raw?.keepa_price_steady !== undefined ||
        e.raw?.keepa_90d_steady !== undefined ||
        e.raw?.keepa_trajectory !== undefined ||
        e.raw?.keepa_90d_stability !== undefined,
      )
    ),
  );

  // Step 3 (r59): Parent-ASIN deduplication over eligible FBA complete-kit candidates
  let keptCandidateEntries = preParentDedupCandidates;
  if (isR59) {
    const byParent = new Map();
    const standalone = [];
    for (const entry of preParentDedupCandidates) {
      const parentKey = entry.cand.parent_asin;
      if (!parentKey) {
        standalone.push(entry);
        continue;
      }
      if (!byParent.has(parentKey)) byParent.set(parentKey, []);
      byParent.get(parentKey).push(entry);
    }
    const parentWinners = [];
    for (const [parentKey, group] of [...byParent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (group.length === 1) {
        parentWinners.push(group[0]);
        continue;
      }
      const singleCouponFrac = e => e.cand.single_coupon_fraction ?? e.cand.discount_fraction;
      const isPrimarySteady = e =>
        !e.isNewcomerR59 &&
        !e.cand.veteran_clearance_or_war_watch &&
        !e.cand.seed_merged_unverified_price &&
        !e.cand.keepa_price_unsteady &&
        !(poolHasKeepaEvidence && e.cand.age_days !== null && e.cand.age_days >= veteran_min_age_days && !e.hasExplicitKeepaSteady) &&
        !(isolate_heavy_coupon_outliers && singleCouponFrac(e) >= heavy_coupon_threshold && !e.cand.keepa_steady_reference) &&
        (!e.cand.ai_qualitative_bucket || e.cand.ai_qualitative_bucket === 'primary_comparable');
      const ageTierRank = e => {
        if (!isPrimarySteady(e)) return 0;
        if (e.cand.age_days !== null && e.cand.age_days >= veteran_min_age_days) return 3;
        if (e.cand.age_days !== null && e.cand.age_days > spiral_max_age_days) return 2;
        return 1;
      };
      const sortedGroup = [...group].sort((a, b) => {
        const aRank = ageTierRank(a);
        const bRank = ageTierRank(b);
        if (bRank !== aRank) return bRank - aRank;
        const aHeavyCoupon = isolate_heavy_coupon_outliers && singleCouponFrac(a) >= heavy_coupon_threshold && !a.cand.keepa_steady_reference ? 1 : 0;
        const bHeavyCoupon = isolate_heavy_coupon_outliers && singleCouponFrac(b) >= heavy_coupon_threshold && !b.cand.keepa_steady_reference ? 1 : 0;
        if (aHeavyCoupon !== bHeavyCoupon) return aHeavyCoupon - bHeavyCoupon;
        const aBest = a.raw?.is_best_selling_variant === true || a.raw?.bestSellingVariant === true ? 1 : 0;
        const bBest = b.raw?.is_best_selling_variant === true || b.raw?.bestSellingVariant === true ? 1 : 0;
        if (bBest !== aBest) return bBest - aBest;
        const aU = a.cand.monthly_units ?? -1;
        const bU = b.cand.monthly_units ?? -1;
        if (bU !== aU) return bU - aU;
        return a.cand.asin.localeCompare(b.cand.asin);
      });
      const winner = sortedGroup[0];
      parentWinners.push(winner);
      for (const sib of sortedGroup.slice(1)) {
        const sibRecord = {
          asin: sib.cand.asin,
          parent_asin: parentKey,
          kept_representative_asin: winner.cand.asin,
          title: sib.cand.title,
          original_price_usd: sib.cand.list_price_usd ?? sib.cand.net_price_usd ?? null,
          net_price_usd: sib.cand.net_price_usd ?? null,
          age_days: sib.cand.age_days,
          reason_code: 'deduplicated_same_parent_variant',
          reason_zh: `同父体（${parentKey}）变体去重，已保留代表子体 ${winner.cand.asin}，避免多变体重复加权父体月销`,
        };
        deduplicatedParentSiblings.push(sibRecord);
        observedOutOfBandPeers.push(sibRecord);
      }
    }
    keptCandidateEntries = [...standalone, ...parentWinners].sort((a, b) => a.cand.asin.localeCompare(b.cand.asin));
  }

  const candidates = [];
  for (const entry of keptCandidateEntries) {
    if (!entry.isNewcomerR59 && entry.cand.age_days !== null && !entry.seedMergedUnverified && !entry.isVeteranClearanceOrWar && !entry.cand.keepa_price_unsteady) {
      if (entry.steadyKeepaRef) {
        historicalPeers.push({
          asin: entry.cand.asin,
          net_price_usd: entry.steadyKeepaRef.price_usd,
          monthly_units: entry.cand.monthly_units,
          source: entry.steadyKeepaRef.source,
        });
      }
    }
    candidates.push(entry.cand);
  }


  // =========================================================================
  // Revision 59 Three-Tier Listing Age Priority + Ultra-New <90d Blue Ocean
  // =========================================================================
  const spiralWatch = [];
  const veteranClearanceWatch = [];
  const veteranEligible = [];
  const growthSteadyEligible = [];
  const newcomerCandidates = [];

  const isQualitativeExcluded = c =>
    c.veteran_clearance_or_war_watch === true ||
    c.seed_merged_unverified_price === true ||
    c.keepa_price_unsteady === true ||
    (c.ai_qualitative_bucket && c.ai_qualitative_bucket !== 'primary_comparable');

  const singleCouponFractionOf = c => c.single_coupon_fraction ?? c.discount_fraction;

  const resolveEffectiveRegularBandPrice = c => {
    if (c.regular_price_reference) return c.regular_price_reference.price_usd;
    if (singleCouponFractionOf(c) >= heavy_coupon_threshold && c.keepa_steady_reference) {
      return c.keepa_steady_reference.price_usd;
    }
    return c.net_price_usd;
  };

  for (const item of candidates) {
    const isAiNewcomerBucket = Boolean(
      item.ai_qualitative_bucket &&
      ['newcomer_reference', 'newcomer_launch_reference', 'newcomer_le_90d_launch_ref'].includes(item.ai_qualitative_bucket),
    );
    const isNewcomer = (item.age_days !== null && item.age_days <= spiral_max_age_days) ||
      (item.age_days === null && isAiNewcomerBucket);
    const isVeteran = !isNewcomer && (item.age_days !== null
      ? item.age_days >= veteran_min_age_days
      : !strict_mature_only);
    const isGrowth = item.age_days !== null && item.age_days > spiral_max_age_days && item.age_days < veteran_min_age_days;
    const itemSingleCouponFrac = singleCouponFractionOf(item);

    if (isNewcomer) {
      const newcomerAiExcluded = Boolean(
        item.ai_qualitative_bucket &&
        !['primary_comparable', 'newcomer_reference', 'newcomer_launch_reference', 'newcomer_le_90d_launch_ref'].includes(item.ai_qualitative_bucket),
      );
      if (!item.seed_merged_unverified_price && !newcomerAiExcluded) {
        newcomerCandidates.push(item);
      }
      const watchReasons = [
        item.seed_merged_unverified_price
          ? 'seed_merged_unverified_regular_price'
          : (newcomerAiExcluded ? item.ai_qualitative_bucket : 'newcomer_le_90d_launch_ref'),
        ...(itemSingleCouponFrac >= heavy_coupon_threshold ? ['young_heavy_coupon_outlier'] : []),
      ];
      const reasonZh = item.seed_merged_unverified_price
        ? '90天内链接携带合并老评，稳态原价未核实，单列观察栏'
        : (item.ai_reason_zh ?? '≤90天新品（负责Q31新人表现），售价仅作新品起盘参考价，不拉垮主毛利');
      const watchedRow = { ...item, watch_reasons: watchReasons, watch_reason_zh: reasonZh };
      spiralWatch.push(watchedRow);
      observedOutOfBandPeers.push({
        asin: item.asin,
        title: item.title,
        original_price_usd: item.list_price_usd,
        net_price_usd: item.net_price_usd,
        age_days: item.age_days,
        reason_code: watchReasons[0],
        reason_zh: reasonZh,
      });
      continue;
    }

    // Check qualitative/AI exclusions, unsteady/missing Keepa curves, or >=20% single heavy coupon without Keepa steady reference
    const veteranMissingKeepaSteady = Boolean(poolHasKeepaEvidence && isVeteran && !item.keepa_steady_verified);
    const growthMissingKeepaSteady = Boolean(poolHasKeepaEvidence && isGrowth && !item.keepa_steady_verified);
    const heavyCouponWithoutKeepa = isolate_heavy_coupon_outliers &&
      itemSingleCouponFrac >= heavy_coupon_threshold &&
      !item.keepa_steady_reference;
    const hasEventPromoDrop = Boolean(item.regular_price_reference);

    if (isQualitativeExcluded(item) || veteranMissingKeepaSteady || growthMissingKeepaSteady || heavyCouponWithoutKeepa || (strict_mature_only && item.age_days === null)) {
      const watchReasons = [];
      if (item.veteran_clearance_or_war_watch) watchReasons.push('veteran_clearance_or_war_watch');
      if (item.keepa_price_unsteady && !item.veteran_clearance_or_war_watch) {
        watchReasons.push(isVeteran ? 'veteran_keepa_price_unsteady' : 'growth_stage_price_unsteady');
      }
      if (veteranMissingKeepaSteady && !item.keepa_price_unsteady && !item.veteran_clearance_or_war_watch) {
        watchReasons.push('veteran_missing_keepa_steady_evidence');
      }
      if (growthMissingKeepaSteady && !item.keepa_price_unsteady) {
        watchReasons.push('growth_missing_keepa_steady_evidence');
      }
      if (item.ai_qualitative_bucket && item.ai_qualitative_bucket !== 'primary_comparable') {
        watchReasons.push(item.ai_qualitative_bucket);
      }
      if (item.seed_merged_unverified_price) watchReasons.push('seed_merged_unverified_regular_price');
      if (heavyCouponWithoutKeepa) watchReasons.push('heavy_coupon_outlier');
      if (strict_mature_only && item.age_days === null) watchReasons.push('unknown_age_excluded_from_mature_band');

      const reasonZh = item.ai_reason_zh ?? (
        item.veteran_clearance_or_war_watch ? '老品清仓／价格战异常波动，单列观察栏不拉垮主毛利'
          : item.keepa_price_unsteady ? (isVeteran ? '满365天老品近期Keepa价格曲线不稳，单列观察栏并允许稳态成长期递补' : '91–364天成长期链接近期价格尚未走稳，列于观察栏参考')
            : veteranMissingKeepaSteady ? '满365天老品缺Keepa稳态证据，单列观察栏并允许已证稳态成长期递补'
              : growthMissingKeepaSteady ? '91–364天成长期链接缺Keepa稳态证据，单列观察栏待核'
                : item.seed_merged_unverified_price ? '合并老评稳态价未核实，单列观察栏'
                  : heavyCouponWithoutKeepa ? `单张大额券（≥${Math.round(heavy_coupon_threshold * 100)}% OFF）且缺Keepa常态价，单列观察栏`
                    : 'AI定性核验移出主价位带，保留原价列于观察栏'
      );
      const watchedRow = { ...item, watch_reasons: watchReasons, watch_reason_zh: reasonZh };
      spiralWatch.push(watchedRow);
      if (item.veteran_clearance_or_war_watch) veteranClearanceWatch.push(watchedRow);
      observedOutOfBandPeers.push({
        asin: item.asin,
        title: item.title,
        original_price_usd: item.list_price_usd,
        net_price_usd: item.net_price_usd,
        age_days: item.age_days,
        reason_code: watchReasons[0] ?? 'qualitative_watch',
        reason_zh: reasonZh,
      });
      continue;
    }

    const adjustedRow = {
      ...item,
      observed_checkout_net_price_usd: item.net_price_usd,
      net_price_usd: resolveEffectiveRegularBandPrice(item),
      ...(hasEventPromoDrop || itemSingleCouponFrac >= heavy_coupon_threshold ? {
        advisory_promo_indicator: true,
        advisory_promo_note_zh: `当前单券折扣 ≥${Math.round(heavy_coupon_threshold * 100)}%，已采用 Keepa 平时稳态价 $${resolveEffectiveRegularBandPrice(item)} 计入主价位带`,
      } : {}),
    };

    if (isVeteran) {
      veteranEligible.push(adjustedRow);
    } else if (isGrowth) {
      growthSteadyEligible.push(adjustedRow);
    }
  }

  // Apply 3-Tier Priority:
  // 1) >= 365d steady veterans first;
  // 2) Supplement with steady 91-364d growth peers ONLY when steady >= 365d veterans < 2;
  // 3) If both steady >= 365d and steady 91-364d are empty and <= 90d newcomers exist -> reference band (marking
  //    `allUnder90dBlueOcean: true` ONLY when zero >90d matched peers exist!).
  const hasAnyOver90dMatchedPeer = preParentDedupCandidates.some(
    e => !e.isNewcomerR59 && ((e.cand.age_days !== null && e.cand.age_days > spiral_max_age_days) || e.cand.age_days === null),
  );
  const hasOlderPeerMissingKeepaSteady = spiralWatch.some(
    w => Array.isArray(w.watch_reasons) && (
      w.watch_reasons.includes('veteran_missing_keepa_steady_evidence') ||
      w.watch_reasons.includes('growth_missing_keepa_steady_evidence')
    ),
  );
  let mainstreamPool = [];
  let growthSupplementUsed = false;
  let allUnder90dBlueOcean = false;
  let topAmberBannerZh = null;
  let primaryBandBasis = 'veteran_ge_365d_keepa_steady';
  let primaryBandLabelZh = '成熟老品主价位带（≥365天）';

  if (veteranEligible.length >= 2) {
    mainstreamPool = [...veteranEligible];
    // Hold 91-364d growth peers visibly in the observation bar since >=2 veterans already anchor the band
    for (const g of growthSteadyEligible) {
      const reasonZh = `已有 ${veteranEligible.length} 个满 365 天成熟老品坐镇主价位带，91–364 天成长期链接列于观察栏留底`;
      observedOutOfBandPeers.push({
        asin: g.asin,
        title: g.title,
        original_price_usd: g.list_price_usd,
        net_price_usd: g.observed_checkout_net_price_usd ?? g.net_price_usd,
        age_days: g.age_days,
        reason_code: 'growth_stage_held_veterans_sufficient',
        reason_zh: reasonZh,
      });
    }
  } else if (veteranEligible.length > 0 || growthSteadyEligible.length > 0) {
    mainstreamPool = [...veteranEligible, ...growthSteadyEligible];
    growthSupplementUsed = growthSteadyEligible.length > 0;
    if (growthSupplementUsed) {
      primaryBandBasis = 'veteran_ge_365d_plus_steady_growth_91_364d_supplement';
      primaryBandLabelZh = `主价位带（≥365天老品 ${veteranEligible.length} 款 + 价格走稳 91–364 天成长期补位 ${growthSteadyEligible.length} 款）`;
    }
  } else if (newcomerCandidates.length > 0 && !hasOlderPeerMissingKeepaSteady) {
    allUnder90dBlueOcean = !hasAnyOver90dMatchedPeer;
    topAmberBannerZh = allUnder90dBlueOcean
      ? '全员 90 天内新品蓝海，暂无一年期老品稳态价'
      : '在售老品当前处于清仓或波动观察期，暂以 ≤90 天同款新品常规价参考';
    primaryBandBasis = allUnder90dBlueOcean
      ? 'all_under_90d_blue_ocean_ex_heavy_coupon'
      : 'newcomer_fallback_older_peers_unsteady';
    primaryBandLabelZh = allUnder90dBlueOcean
      ? '超新蓝海参考价位带（全员≤90天新品·剔除≥20%大额券常规价）'
      : '临时参考价位带（老品波动观察期·暂取≤90天新品常规价）';
    const exHeavy = newcomerCandidates.filter(c => singleCouponFractionOf(c) < heavy_coupon_threshold);
    const keepaBacked = exHeavy.length > 0 ? exHeavy : newcomerCandidates.filter(c => Boolean(c.keepa_steady_reference));
    mainstreamPool = (keepaBacked.length > 0 ? keepaBacked : newcomerCandidates).map(c => ({
      ...c,
      net_price_usd: singleCouponFractionOf(c) >= heavy_coupon_threshold
        ? (c.keepa_steady_reference?.price_usd ?? c.net_price_usd)
        : c.net_price_usd,
      ...(allUnder90dBlueOcean ? { blue_ocean_under_90d_reference: true } : {}),
    }));
  }

  const allYoungNiche = allUnder90dBlueOcean;

  const matureRegularBand = mainstreamPool.length > 0 ? {
    basis: primaryBandBasis,
    label_zh: primaryBandLabelZh,
    newcomer_cutoff_days: spiral_max_age_days,
    veteran_cutoff_days: veteran_min_age_days,
    growth_supplement_used: growthSupplementUsed,
    all_under_90d_blue_ocean: allUnder90dBlueOcean,
    ...(topAmberBannerZh ? { top_amber_banner_zh: topAmberBannerZh } : {}),
    peer_count: mainstreamPool.length,
    p25_usd: weightedQuantile(mainstreamPool, 0.25),
    p50_usd: weightedQuantile(mainstreamPool, 0.50),
    p75_usd: weightedQuantile(mainstreamPool, 0.75),
    min_usd: Math.min(...mainstreamPool.map(r => r.net_price_usd)),
    max_usd: Math.max(...mainstreamPool.map(r => r.net_price_usd)),
  } : null;

  const newcomerLaunchBand = {
    basis: 'true_newcomers_le_90d_advisory_only',
    label_zh: '新品起盘参考价（≤90天）',
    newcomer_cutoff_days: spiral_max_age_days,
    advisory_only: true,
    never_triggers_elimination: true,
    peer_count: newcomerCandidates.length,
    p25_usd: weightedQuantile(newcomerCandidates, 0.25),
    p50_usd: weightedQuantile(newcomerCandidates, 0.50),
    p75_usd: weightedQuantile(newcomerCandidates, 0.75),
    min_usd: newcomerCandidates.length ? Math.min(...newcomerCandidates.map(r => r.net_price_usd)) : null,
    max_usd: newcomerCandidates.length ? Math.max(...newcomerCandidates.map(r => r.net_price_usd)) : null,
  };

  const prices = mainstreamPool.map(r => r.net_price_usd);
  const p25 = weightedQuantile(mainstreamPool, 0.25);
  const p50 = weightedQuantile(mainstreamPool, 0.50);
  const p75 = weightedQuantile(mainstreamPool, 0.75);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const widthRatio = p25 !== null && p25 > 0 && p75 !== null ? round(p75 / p25, 4) : null;
  const impliedMarginSpreadPp = computeImpliedMarginSpreadPp(p25, p75, options);

  // Revision 59 keeps ONLY the 3 confirmed non-blocking advisory lights (<10/mo zombie, >=20% coupon, >1.35x spread).
  const alarmReasons = [];
  if (widthRatio !== null && widthRatio > max_width_ratio) {
    alarmReasons.push(`P75/P25 价差比 (${widthRatio}x) > ${max_width_ratio}x（纯提醒参考灯，建议核对是否混入不同规格/套装，不直接拦路）。`);
  }
  if (allUnder90dBlueOcean) {
    alarmReasons.push(topAmberBannerZh);
  } else if (mainstreamPool.length < 2) {
    alarmReasons.push(`主价位带当前仅 ${mainstreamPool.length} 款可比链接（带提醒放行，不硬拦 Gate 1A）。`);
  }

  const widthAlarm = widthRatio !== null && widthRatio > max_width_ratio;
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
    profile_revision,
    input_count: asinDeduped.length,
    deduplicated_parent_count: candidates.length,
    deduplicated_parent_siblings: deduplicatedParentSiblings,
    excluded_count: excluded.length,
    spiral_watch_count: spiralWatch.length,
    mainstream_count: mainstreamPool.length,
    all_young_niche: allYoungNiche,
    all_under_90d_blue_ocean: allUnder90dBlueOcean,
    growth_supplement_used: growthSupplementUsed,
    ...(topAmberBannerZh ? { top_amber_banner_zh: topAmberBannerZh } : {}),
    age_tier_counts: {
      veteran_ge_365d: veteranEligible.length,
      growth_91_364d_steady: growthSteadyEligible.length,
      newcomer_le_90d: newcomerCandidates.length,
    },
    strict_mature_only: Boolean(strict_mature_only),
    spiral_fallback_used: false,
    amazon_1p_offers: amazon1pOffers,
    band,
    mature_regular_band: matureRegularBand,
    newcomer_launch_band: newcomerLaunchBand,
    regular_band_reference: matureRegularBand ?? (historicalPeers.length ? {
      basis: 'observed_historical_regular_prices',
      peer_count: historicalPeers.length,
      p25_usd: weightedQuantile(historicalPeers, 0.25),
      p50_usd: weightedQuantile(historicalPeers, 0.50),
      p75_usd: weightedQuantile(historicalPeers, 0.75),
      min_usd: Math.min(...historicalPeers.map(p => p.net_price_usd)),
      max_usd: Math.max(...historicalPeers.map(p => p.net_price_usd)),
      sources: Object.fromEntries(['keepa_90d_median_usd', 'historical_regular_price_usd']
        .map(source => [source, historicalPeers.filter(p => p.source === source).length])),
    } : { ...band, basis: 'current_mainstream_prices', peer_count: mainstreamPool.length }),
    guardrail: {
      max_width_ratio,
      width_alarm: widthAlarm,
      requires_visual_clustering: false,
      advisory_only: true,
      never_triggers_elimination: true,
      low_peer_count: mainstreamPool.length < 2,
      low_peer_blocks_gate1a: false,
      reasons: alarmReasons,
    },
    mainstream_pool: mainstreamPool,
    spiral_watch: spiralWatch,
    observed_out_of_band_peers: observedOutOfBandPeers,
    ...(veteranClearanceWatch.length > 0 ? { veteran_clearance_watch: veteranClearanceWatch } : {}),
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
  const effectiveRev = options.profile_revision ?? baseAnalysis.profile_revision ?? 59;
  assertActiveRevision59(effectiveRev, 'tightenClusterBands');
  const isR59 = true;

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

    const p25 = weightedQuantile(matchedRows, 0.25, { profileRevision: options.profile_revision ?? baseAnalysis?.profile_revision ?? 58 });
    const p50 = weightedQuantile(matchedRows, 0.50, { profileRevision: options.profile_revision ?? baseAnalysis?.profile_revision ?? 58 });
    const p75 = weightedQuantile(matchedRows, 0.75, { profileRevision: options.profile_revision ?? baseAnalysis?.profile_revision ?? 58 });
    const widthRatio = p25 !== null && p25 > 0 && p75 !== null ? round(p75 / p25, 4) : null;
    const marginSpreadPp = computeImpliedMarginSpreadPp(p25, p75, options);
    const maxWidthRatio = options.max_width_ratio ?? baseAnalysis.guardrail?.max_width_ratio ?? 1.35;
    const maxSpreadPp = options.max_margin_spread_pp ?? baseAnalysis.guardrail?.max_margin_spread_pp ?? 12;
    const tightenedOk = isR59
      ? (matchedRows.length >= 1 && missingAsins.length === 0 && (widthRatio === null || widthRatio <= maxWidthRatio))
      : (matchedRows.length >= 2 && missingAsins.length === 0 && (widthRatio !== null && widthRatio <= maxWidthRatio) && (marginSpreadPp === null || marginSpreadPp <= maxSpreadPp));

    return {
      cluster_id: clusterId,
      label,
      member_count: matchedRows.length,
      asins: matchedRows.map(r => r.asin),
      spiral_watch_asins: spiralAsins,
      missing_asins: missingAsins,
      incomplete_membership: missingAsins.length > 0 || (!isR59 && matchedRows.length < 2),
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
