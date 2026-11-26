import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BUSINESS_THRESHOLDS } from '../src/business-thresholds.mjs';
import { evaluateGate0CategoryBoundary } from '../src/price-band.mjs';
import { planDiscoveryBatch } from '../src/discovery-channels.mjs';
import { openSelectionStore } from '../src/store.mjs';
import {
  buildStage1DecisionsRequests,
  parseStage1DecisionsResponses,
  getStage1DecisionQuestionIds,
  get1688OfferRankDecisionQuestionIds,
  build1688SearchRankingDecisionsRequests,
  parse1688SearchRankingDecisionsResponses,
  prepare1688DetailVerificationHandoff,
  parse1688VisionInspectResult,
  MAX_1688_SEARCH_SHEET_TILES,
  OFFER_1688_RANK_CHOICES,
} from '../src/openai/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI_PATH = join(REPO_ROOT, 'src', 'phase2-cli.mjs');

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=';
const TINY_PNG_DATA_URI = `data:image/png;base64,${TINY_PNG_BASE64}`;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'issue28-stage3b-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Issue #28 (Gate-0 anti-false-kill & furniture default): adult/horticulture/musical/studio/pet/automotive phrases pass while real <=12y child items stay hard-excluded, and furniture is not default-blocked', () => {
  // 1) Adult / non-child false-kill regressions MUST pass with adult_exemption_applied: true
  const adultFalseKillCases = [
    { title: 'Baby Grand Piano Cover Waterproof Velvet Dust Protector', root_category: 'Musical Instruments' },
    { title: 'Nursery Plant Pots 50 Pack 4 Inch Plastic Seedling Containers', root_category: 'Patio, Lawn & Garden' },
    { title: 'Plastic Plant Nursery Trays & Seedling Grow Bags with Drainage', root_category: 'Patio, Lawn & Garden' },
    { title: 'Tree Nursery Grafting Stakes & Plant Labels 200 Pack', root_category: 'Patio, Lawn & Garden' },
    { title: '5/8 Inch Baby Pin Studio Grip Wall Plate for Lighting Stand', root_category: 'Camera & Photo' },
    { title: 'Dog Booster Car Seat for Medium Pets with Safety Tether', root_category: 'Pet Supplies' },
    { title: 'Foldable Cat Stroller 4-Wheel Mesh Pet Carrier', root_category: 'Pet Supplies' },
    { title: 'Heavy Duty Puppy Playpen Outdoor Exercise Fence', root_category: 'Pet Supplies' },
    { title: "Baby's Breath Dried Flowers Bouquet for Vase Decor", root_category: 'Home & Kitchen' },
    { title: 'Leather Car Seat Cover Protector Set for Front Seats', root_category: 'Automotive' },
    { title: 'Car Seat Gap Filler Organizer with Cup Holder', root_category: 'Automotive' },
    { title: 'Waterproof Diaper Bag Backpack for Parents with Changing Pad', root_category: 'Baby Products' },
  ];
  for (const item of adultFalseKillCases) {
    const res = evaluateGate0CategoryBoundary(item);
    assert.equal(res.hard_exclusion, false, `Expected non-child adult item NOT to hard-exclude: "${item.title}"`);
    assert.equal(res.passed, true, `Expected adult item to pass Gate-0: "${item.title}" (got ${res.verdict})`);
    assert.equal(res.adult_exemption_applied, true, `Expected adult_exemption_applied: true for "${item.title}"`);
  }

  // 2) Real statutory <=12y children's items (including compound attack titles) MUST still hard-exclude!
  const realChildCases = [
    { title: 'Baby Grand Piano Toy for Toddlers Ages 1-3 with Lights' },
    { title: 'Nursery Plant Pot Kids Gardening Toy Set for Ages 3-6' },
    { title: 'Montessori Toddler Wooden Climbing Arch' },
    { title: 'Silicone Baby Teether Toy BPA Free' },
    { title: 'Baby Crib Mattress Dual Sided Waterproof' },
    { title: 'Infant Car Seat with Stay-in-Car Base' },
    { title: 'Toddler Booster Seat for Dining Table' },
    { title: 'Toddler Sippy Cup Spill Proof Straw' },
    { title: 'Baby Playpen for Infants and Toddlers' },
  ];
  for (const item of realChildCases) {
    const res = evaluateGate0CategoryBoundary(item);
    assert.equal(res.hard_exclusion, true, `Expected real <=12y child item to hard-exclude: "${item.title}"`);
    assert.equal(res.passed, false);
    assert.equal(res.verdict, 'excluded_childrens_product');
  }

  // 3) Unconfirmed red_ocean_furniture is REMOVED from default Gate-0 avoid blocks (opt-in still works)
  for (const furn of [
    { title: 'Solid Oak Standing Desk Frame', root_category: 'Office Furniture' },
    { title: '5-Tier Solid Wood Bookshelf', root_category: 'Furniture' },
    { title: 'Walnut Bedside Nightstand with Drawer', root_category: 'Home & Kitchen > Furniture' },
  ]) {
    const defRes = evaluateGate0CategoryBoundary(furn);
    assert.equal(defRes.passed, true, `Default Gate-0 must NOT block furniture: "${furn.title}"`);
    assert.equal(defRes.hard_exclusion, false);

    const optInRes = evaluateGate0CategoryBoundary(furn, { avoid_red_ocean: { red_ocean_furniture: true } });
    assert.equal(optInRes.passed, false);
    assert.equal(optInRes.hard_exclusion, false);
    assert.equal(optInRes.verdict, 'skipped_red_ocean_default');
  }

  // 4) Discovery planner defaults also set red_ocean_furniture: false, while keeping apparel & 3C skip defaults
  const store = openSelectionStore(':memory:');
  try {
    const plan = planDiscoveryBatch(store, { as_of_date: '2026-11-26' });
    assert.equal(plan.gate0_defaults.avoid_red_ocean.red_ocean_furniture, false);
    assert.equal(plan.gate0_defaults.avoid_red_ocean.apparel, true);
    assert.equal(plan.gate0_defaults.avoid_red_ocean.consumer_electronics_3c, true);
  } finally {
    store.close();
  }

  // Confirmed ordinary apparel and commodity 3C phone-case/cable keep discovery-intake skip behavior (non-hard)
  const apparelRes = evaluateGate0CategoryBoundary({ title: 'Men Cotton T-Shirt Crew Neck', root_category: 'Clothing, Shoes & Jewelry' });
  assert.equal(apparelRes.passed, false);
  assert.equal(apparelRes.hard_exclusion, false);
  assert.equal(apparelRes.verdict, 'skipped_red_ocean_default');
  assert.equal(apparelRes.configurable_skip, true);

  const commodity3cRes = evaluateGate0CategoryBoundary({ title: 'MagSafe iPhone Case with USB-C Cable', root_category: 'Cell Phones & Accessories' });
  assert.equal(commodity3cRes.passed, false);
  assert.equal(commodity3cRes.hard_exclusion, false);
  assert.equal(commodity3cRes.verdict, 'skipped_red_ocean_default');
  assert.equal(commodity3cRes.configurable_skip, true);
});

test('Issue #28 (Luna red-line-only non-overreach): Luna never auto-excludes powered items, suspected patents, uncertain niches, adult exemptions, or soft-avoid items', () => {
  const candidates = [
    { candidate_id: 'C-PWR', title: 'Cordless Ultrasonic Eyeglass Cleaner', is_powered: true, price_usd: 42.99 },
    { candidate_id: 'C-PAT', title: 'Modular Magnetic Workshop Tool Rail', suspected_patent: true, price_usd: 39.99 },
    { candidate_id: 'C-UNC', title: 'Precision Woodwork Doweling Jig', price_usd: 49.99 },
    { candidate_id: 'C-PIANO', title: 'Baby Grand Piano Cover Waterproof Velvet', price_usd: 54.99 },
    { candidate_id: 'C-POTS', title: 'Nursery Plant Pots 50 Pack Seedling Containers', price_usd: 32.99 },
    { candidate_id: 'C-PET', title: 'Dog Booster Car Seat for Medium Pets', price_usd: 45.99 },
    { candidate_id: 'C-APP', title: 'Merino Wool Hiking Socks 3 Pack', root_category: 'Clothing, Shoes & Jewelry', price_usd: 34.99 },
    { candidate_id: 'C-CHILD', title: 'Silicone Baby Teether Toy BPA Free', price_usd: 31.99 },
    { candidate_id: 'C-HOLIDAY', title: '2027 New Year Eve Disposable Party Glasses 24 Pack', strict_holiday_disposable: true, price_usd: 30.99 },
  ];

  const reqs = buildStage1DecisionsRequests({ candidates, targetSpec: { buyer_task: 'General stage-1 triage' } });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].model, 'gpt-6-luna');
  assert.equal('reasoning' in reqs[0], false);
  assert.equal(reqs[0].questions.length, candidates.length * 2);
  // Prompt text must state Luna red-line-only non-overreach boundary explicitly
  const qText = reqs[0].questions[0].instructions;
  assert.match(qText, /powered|electronic/i);
  assert.match(qText, /patent|IP/i);
  assert.match(qText, /holiday|date/i);

  // Even when Luna aggressively predicts probability 0.92 across ALL candidates, non-overreach guard clamps every protected category!
  const answers = [];
  for (const c of candidates) {
    const q = getStage1DecisionQuestionIds(c.candidate_id);
    answers.push({ id: q.predicateId, type: 'predicate', probability: 0.92, value: true });
    answers.push({
      id: q.choiceId,
      type: 'choice',
      value: c.candidate_id === 'C-UNC' ? 'unclear_needs_zoom' : 'exact_peer',
    });
  }

  const parsed = parseStage1DecisionsResponses(candidates, [{ answers }], { requests: reqs });
  const byId = Object.fromEntries(parsed.items.map(it => [it.candidate_id, it]));

  // Protected items MUST NEVER be auto-excluded by Luna -> routed to amber_manual_review / needs_review: true
  for (const protectedId of ['C-PWR', 'C-PAT', 'C-UNC', 'C-PIANO', 'C-POTS', 'C-PET', 'C-APP']) {
    const it = byId[protectedId];
    assert.equal(it.gate0_status, 'allowed', `Luna must NOT auto-exclude ${protectedId}`);
    assert.equal(it.gate0_review_watch, true);
    assert.equal(it.triage_disposition, 'amber_manual_review', `${protectedId} must route to amber_manual_review`);
    assert.equal(it.needs_review, true, `${protectedId} must set needs_review: true`);
    assert.equal(it.luna_non_overreach_clamped, true, `${protectedId} must record luna_non_overreach_clamped: true`);
    assert.ok(Array.isArray(it.luna_non_overreach_reasons) && it.luna_non_overreach_reasons.length >= 1);
  }
  assert.equal(parsed.summary.luna_non_overreach_clamped_count, 7);

  // Undisputed statutory <=12y children's item and strict date/holiday disposable STILL auto-exclude
  assert.equal(byId['C-CHILD'].gate0_status, 'prohibited');
  assert.equal(byId['C-CHILD'].triage_disposition, 'prohibited_auto_excluded');
  assert.equal(byId['C-CHILD'].luna_non_overreach_clamped, false);

  assert.equal(byId['C-HOLIDAY'].gate0_status, 'prohibited');
  assert.equal(byId['C-HOLIDAY'].triage_disposition, 'prohibited_auto_excluded');
  assert.equal(byId['C-HOLIDAY'].luna_non_overreach_clamped, false);
});

test('Issue #28 (1688 20-40 contact sheet): render_contact_sheet.py & phase2-cli render 25 and 40 1688 offers with CNY price, MOQ, offer_id while preserving Amazon 4x4 defaults', () => {
  withTempDir(dir => {
    const imgPath = join(dir, 'offer.png');
    writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    // 1) 25 1688 offers using { offers: [...] } auto-detects 1688 mode (5x8 cap=40, actual_rows=5, NOT truncated at 16!)
    const offers25 = Array.from({ length: 25 }, (_, i) => ({
      offer_id: `SYNTH-1688-${String(i + 1).padStart(3, '0')}`,
      title: `胡桃木桌面收纳盒 工厂直供 #${i + 1}`,
      price_cny: Number((32.5 + i * 1.2).toFixed(2)),
      moq: i % 2 === 0 ? 100 : 50,
      factory_id: `FAC-${String((i % 10) + 1).padStart(2, '0')}`,
      factory_badge: i < 5 ? '源头工厂' : '实力商家',
      province: '广东深圳',
      image_path: i < 20 ? imgPath : join(dir, 'missing-thumb.png'),
    }));
    const in25 = join(dir, 'offers-25.json');
    const png25 = join(dir, 'sheet-25.png');
    const man25 = join(dir, 'manifest-25.json');
    writeFileSync(in25, JSON.stringify({ title: '1688 Search Top 25', offers: offers25 }), 'utf8');

    const res25 = spawnSync(process.execPath, [
      CLI_PATH, 'contact-sheet',
      '--input', in25,
      '--output', png25,
      '--manifest-out', man25,
      '--offline',
    ], { encoding: 'utf8' });
    assert.equal(res25.status, 0, `1688 25-offer contact-sheet failed: ${res25.stderr}`);
    const out25 = JSON.parse(res25.stdout);
    assert.equal(out25.ok, true);
    assert.equal(out25.rendered.mode, '1688');
    assert.equal(out25.rendered.items_total, 25);
    assert.equal(out25.rendered.items_rendered, 25, '25 1688 offers must NOT be truncated at 16');
    assert.equal(out25.rendered.images_loaded, 20);
    assert.equal(out25.rendered.images_missing, 5);
    assert.equal(out25.rendered.cols, 5);
    assert.equal(out25.rendered.rows.length, 25);
    assert.equal(out25.rendered.rows[0].offer_id, 'SYNTH-1688-001');
    assert.equal(out25.rendered.rows[0].price_cny, 32.5);
    assert.equal(out25.rendered.rows[0].moq, 100);
    assert.equal(out25.rendered.rows[0].tile_index, 1);
    assert.equal(out25.rendered.rows[24].tile_index, 25);
    assert.equal(existsSync(png25), true);
    assert.deepEqual(readFileSync(png25).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    // 2) 40 1688 offers with explicit --mode 1688 --cols 5 --rows 8 renders all 40 tiles
    const offers40 = Array.from({ length: 40 }, (_, i) => ({
      offer_id: `SYNTH-40-${String(i + 1).padStart(3, '0')}`,
      title: `整套铝合金收纳架 现货 #${i + 1}`,
      price_cny: 40 + i,
      moq: 100,
      image_path: imgPath,
    }));
    const in40 = join(dir, 'offers-40.json');
    const png40 = join(dir, 'sheet-40.png');
    writeFileSync(in40, JSON.stringify(offers40), 'utf8');

    const res40 = spawnSync(process.execPath, [
      CLI_PATH, 'contact-sheet',
      '--input', in40,
      '--output', png40,
      '--mode', '1688',
      '--cols', '5',
      '--rows', '8',
      '--offline',
    ], { encoding: 'utf8' });
    assert.equal(res40.status, 0, `1688 40-offer contact-sheet failed: ${res40.stderr}`);
    const out40 = JSON.parse(res40.stdout);
    assert.equal(out40.rendered.mode, '1688');
    assert.equal(out40.rendered.items_rendered, 40);
    assert.equal(out40.rendered.rows[39].tile_index, 40);

    // 3) Amazon 4x4 default stays 100% backwards-compatible (caps at 16 tiles on default 4x4 grid)
    const amz18 = Array.from({ length: 18 }, (_, i) => ({
      asin: `SYNTHAMZ${String(i + 1).padStart(2, '0')}`,
      price_usd: 39.99 + i,
      sales_30d: 120,
      image_path: imgPath,
    }));
    const inAmz = join(dir, 'amz-18.json');
    const pngAmz = join(dir, 'amz-18.png');
    writeFileSync(inAmz, JSON.stringify(amz18), 'utf8');
    const resAmz = spawnSync(process.execPath, [
      CLI_PATH, 'contact-sheet',
      '--input', inAmz,
      '--output', pngAmz,
      '--offline',
    ], { encoding: 'utf8' });
    assert.equal(resAmz.status, 0, resAmz.stderr);
    const outAmz = JSON.parse(resAmz.stdout);
    assert.equal(outAmz.rendered.mode, 'amazon');
    assert.equal(outAmz.rendered.cols, 4);
    assert.equal(outAmz.rendered.items_rendered, 16);
  });
});

test('Issue #28 (1688 Luna offer-ranking contract + Terra detail HD handoff): ranks 30 offers in 1 call, shortlists <=3 distinct factories, NEVER eliminates product even when all offers demoted, and bridges cleanly to Terra HD vision', () => {
  assert.equal(MAX_1688_SEARCH_SHEET_TILES, 40);
  assert.ok(OFFER_1688_RANK_CHOICES.includes('priority_complete_kit_factory'));
  assert.ok(OFFER_1688_RANK_CHOICES.includes('plausible_needs_detail_check'));

  const targetSpec = {
    form_id: 'form-synth-walnut-rack',
    saleable_unit: '1 complete walnut organizer rack + 1 linen storage pouch',
    material: 'solid walnut wood + stainless steel pins + linen pouch',
    key_dimensions_mm: '240x180x85 mm, slot diameter 22 mm',
  };

  // Build 30 realistic synthetic 1688 search-page offers (including duplicate factory_id to test deduplication!)
  const offers30 = Array.from({ length: 30 }, (_, i) => ({
    offer_id: `OFF-${String(i + 1).padStart(3, '0')}`,
    title: `实木胡桃木收纳架含布袋整套 #${i + 1}`,
    price_cny: Number((35 + (i % 7) * 4.5).toFixed(2)),
    moq: i % 3 === 0 ? 50 : 100,
    factory_id: i === 1 ? 'FAC-01' : `FAC-${String(i + 1).padStart(2, '0')}`, // OFF-001 and OFF-002 share FAC-01
    factory_badge: i < 6 ? '源头工厂' : '贸易商',
    province: '广东深圳',
  }));

  // Single 1688 search contact sheet fits all 30 offers in ONE Luna /v1/decisions call (zero reasoning params!)
  const reqs = build1688SearchRankingDecisionsRequests({
    offers: offers30,
    targetSpec,
    contactSheetDataUrl: TINY_PNG_DATA_URI,
    imageDetail: 'high',
    promptCacheKey: 'sourcing-1688-rank-v1',
  });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].model, 'gpt-6-luna');
  assert.equal('reasoning' in reqs[0], false);
  assert.equal('reasoning_effort' in reqs[0], false);
  assert.equal(reqs[0].questions.length, 60, '30 offers -> 60 offer-level questions');
  // Structurally ZERO product-exclusion questions exist in the 1688 search-ranking contract!
  assert.equal(
    reqs[0].questions.some(q => /gate0_prohibited|exclude_product|reject_candidate/i.test(q.id)),
    false,
    '1688 search ranking must structurally contain ZERO product-exclusion questions',
  );

  // Reject > 40 offers on single contactSheetDataUrl, reject email PII in factory_id
  assert.throws(
    () => build1688SearchRankingDecisionsRequests({
      offers: Array.from({ length: 41 }, (_, i) => ({ offer_id: `O-${i}`, price_cny: 30, moq: 100 })),
      targetSpec,
      contactSheetDataUrl: TINY_PNG_DATA_URI,
    }),
    /40/,
  );
  assert.throws(
    () => build1688SearchRankingDecisionsRequests({
      offers: [{ offer_id: 'O-EMAIL', price_cny: 30, moq: 100, factory_id: 'sales@factory-example.cn' }],
      targetSpec,
    }),
    /email/i,
  );

  // Multi-sheet (45 offers across 2 sheets of <=40) works cleanly
  const offers45 = Array.from({ length: 45 }, (_, i) => ({
    offer_id: `M-${String(i + 1).padStart(3, '0')}`,
    price_cny: 40 + i,
    moq: 100,
    factory_id: `MF-${i + 1}`,
  }));
  const multiReqs = build1688SearchRankingDecisionsRequests({
    offers: offers45,
    targetSpec,
    contactSheetDataUrls: [TINY_PNG_DATA_URI, TINY_PNG_DATA_URI],
  });
  assert.equal(multiReqs.length, 2);
  assert.equal(multiReqs[0].questions.length, 80);
  assert.equal(multiReqs[1].questions.length, 10);

  // Simulate Luna answers:
  // OFF-001 (FAC-01, ¥35, prob 0.90) -> priority
  // OFF-002 (FAC-01 duplicate factory, ¥39.5, prob 0.95) -> priority (higher prob, SAME factory FAC-01 -> dedup!)
  // OFF-003 (FAC-03, ¥44, prob 0.88) -> priority
  // OFF-004 (FAC-04, ¥48.5, prob 0.82) -> priority
  // OFF-005 (FAC-05, ¥53, prob 0.78) -> priority (4th distinct factory -> excluded from top-3 shortlist)
  // OFF-006 (FAC-06) -> refusal -> safely becomes plausible_needs_detail_check (never silently demoted)
  // OFF-007..OFF-030 -> demoted tiers
  const answers = offers30.flatMap((o, idx) => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    if (idx === 0) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.90, value: true },
        { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' },
      ];
    }
    if (idx === 1) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.95, value: true },
        { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' },
      ];
    }
    if (idx === 2) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.88, value: true },
        { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' },
      ];
    }
    if (idx === 3) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.82, value: true },
        { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' },
      ];
    }
    if (idx === 4) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.78, value: true },
        { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' },
      ];
    }
    if (idx === 5) {
      return [
        { id: q.completeKitPredicateId, type: 'refusal' },
        { id: q.rankChoiceId, type: 'refusal' },
      ];
    }
    const demoteTier = idx % 3 === 0
      ? 'demote_bare_part_or_incomplete'
      : (idx % 3 === 1 ? 'demote_wrong_spec_or_material' : 'demote_trading_or_low_fit');
    return [
      { id: q.completeKitPredicateId, type: 'predicate', probability: 0.12, value: false },
      { id: q.rankChoiceId, type: 'choice', value: demoteTier },
    ];
  });

  const ranked = parse1688SearchRankingDecisionsResponses(offers30, [{ answers }], { requests: reqs });
  assert.equal(ranked.candidate_eliminated, false);
  assert.equal(ranked.product_status, 'retained_for_sourcing');
  assert.equal(ranked.next_step, 'open_detail_pages_for_terra_hd_verification');
  assert.equal(ranked.ranked_offers.length, 30);
  assert.equal(ranked.shortlist_to_open.length, BUSINESS_THRESHOLDS.max_1688_factories_to_check, 'Shortlist capped at 3 distinct factories');
  // OFF-002 (prob 0.95, FAC-01) wins FAC-01 slot, OFF-001 (same FAC-01) is deduped, then OFF-003 (FAC-03) and OFF-004 (FAC-04)!
  assert.deepEqual(
    ranked.shortlist_to_open.map(o => o.offer_id),
    ['OFF-002', 'OFF-003', 'OFF-004'],
  );
  assert.equal(ranked.demoted_offers.length, 24);
  const refusedOffer = ranked.ranked_offers.find(o => o.offer_id === 'OFF-006');
  assert.equal(refusedOffer.rank_tier, 'plausible_needs_detail_check');
  assert.equal(refusedOffer.complete_kit_likely, 'unknown');

  // CRITICAL NON-OVERREACH INVARIANT: Even if ALL 30 offers are demoted, candidate_eliminated stays FALSE!
  const allDemotedAnswers = offers30.flatMap(o => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    return [
      { id: q.completeKitPredicateId, type: 'predicate', probability: 0.05, value: false },
      { id: q.rankChoiceId, type: 'choice', value: 'demote_bare_part_or_incomplete' },
    ];
  });
  const allDemotedRes = parse1688SearchRankingDecisionsResponses(offers30, [{ answers: allDemotedAnswers }], { requests: reqs });
  assert.equal(allDemotedRes.candidate_eliminated, false, 'Luna MUST NEVER eliminate candidate product even when all 30 1688 offers are demoted');
  assert.equal(allDemotedRes.product_status, 'retained_for_sourcing');
  assert.equal(allDemotedRes.shortlist_to_open.length, 0);
  assert.equal(allDemotedRes.next_step, 'refine_1688_search_or_manual_review');

  // Handoff to Terra detail HD spec verification (open Factory #1 first; Factory #2 & #3 stay deferred!)
  const handoff = prepare1688DetailVerificationHandoff({
    rankingResult: ranked,
    targetSpec,
    openedDetailsByOfferId: {
      'OFF-002': {
        sku_label: '胡桃木整套+麻布袋',
        images: [TINY_PNG_DATA_URI],
        listing_attributes: { material: 'ABS 仿胡桃木纹', weight_g: 420 },
      },
    },
    imageDetail: 'high',
  });
  assert.equal(handoff.requests.length, 1);
  assert.equal(handoff.requests[0].offer_id, 'OFF-002');
  assert.equal(handoff.requests[0].request.model, 'gpt-6.1-terra');
  assert.equal(handoff.requests[0].request.reasoning.effort, 'xhigh');
  assert.equal(handoff.requests[0].request.input[1].content[1].detail, 'high');
  assert.deepEqual(handoff.deferred_shortlist_offer_ids, ['OFF-003', 'OFF-004']);

  // Terra detail HD verification rejects imageDetail: 'low'
  assert.throws(
    () => prepare1688DetailVerificationHandoff({
      rankingResult: ranked,
      targetSpec,
      openedDetailsByOfferId: { 'OFF-002': { images: [TINY_PNG_DATA_URI] } },
      imageDetail: 'low',
    }),
    /high.*original/i,
  );

  // Terra HD verification result cleanly captures material mismatch, missing pouch, slot diameter gap, and Chinese inquiry questions
  const terraParsed = parse1688VisionInspectResult({
    schema_version: 1,
    contract: 'VisionInspector1688',
    spec_match_verdict: 'mismatch',
    dimension_weight_findings: {
      product_dimensions_mm: '240x180x85',
      package_dimensions_mm: null,
      unit_weight_g: 420,
      package_weight_g: null,
      carton_pack_qty: 20,
      evidence_notes: 'Detail-page closeup shows molded ABS faux-walnut grain (not solid walnut), slot diameter 16 mm (< 22 mm target), and no linen storage pouch in SKU breakdown.',
    },
    sensitive_freebie_flags: {
      oil_or_glue: 'none',
      battery_type: 'none',
      strong_magnet: 'none',
      notes: 'No freebies or accessories included.',
    },
    component_gaps: [
      'Material mismatch: ABS plastic faux wood grain instead of solid walnut wood',
      'Missing linen storage pouch in SKU complete set',
      'Slot diameter 16 mm conflicts with required 22 mm fit',
    ],
    wangwang_questions: [
      '请问该款是否有真黑胡桃实木现货版本，100套裸货单价和交期是多少？',
      '请问是否可以同一工厂齐套配齐麻布收纳袋及22mm孔径规格？',
    ],
  });
  assert.equal(terraParsed.valid, true);
  assert.equal(terraParsed.spec_match_verdict, 'mismatch');
  assert.equal(terraParsed.component_gaps.length, 3);
  assert.equal(terraParsed.wangwang_questions.length, 2);
});

test('Issue #28 Astra review regressions: Gate-0 baby-plate/ages/pins/pet-word-order, low-prob needs_review & red-ocean skip, 1688 probabilities/multi-sheet/seller-dedup/all-refused/replay/chunk/PII/bad-port', () => {
  // 1) Spec-2 Gate-0 counterexamples (both false negatives and false positives fixed!)
  for (const childItem of [
    { title: 'Silicone Baby Plate with Suction Base' },
    { title: 'Baby Grand Piano Musical Toy, Ages 3 to 5' },
  ]) {
    const res = evaluateGate0CategoryBoundary(childItem);
    assert.equal(res.hard_exclusion, true, `Must hard-exclude child item: "${childItem.title}"`);
    assert.equal(res.passed, false);
  }
  for (const adultItem of [
    { title: '5/8 Inch Baby Pins for Studio Lighting' },
    { title: 'Dog Car Booster Seat' },
  ]) {
    const res = evaluateGate0CategoryBoundary(adultItem);
    assert.equal(res.hard_exclusion, false, `Must NOT hard-exclude adult item: "${adultItem.title}"`);
    assert.equal(res.passed, true);
    assert.equal(res.adult_exemption_applied, true);
  }

  // 2) Spec-1: low-prob (0.05) patent-suspect / powered / unclear_needs_zoom still set needs_review: true;
  //    enforce_red_ocean_skip: true routes apparel to skipped_red_ocean_default (NOT prohibited!)
  const lowProbCands = [
    { candidate_id: 'LP-PAT', title: 'Magnetic Workshop Clamp', suspected_patent: true, price_usd: 39.99 },
    { candidate_id: 'LP-PWR', title: 'Cordless Ultrasonic Cleaner', is_powered: true, price_usd: 44.99 },
    { candidate_id: 'LP-ZOOM', title: 'Specialty Doweling Jig', price_usd: 49.99 },
    { candidate_id: 'LP-APP', title: 'Cotton Crew T-Shirt', root_category: 'Clothing, Shoes & Jewelry', price_usd: 32.99 },
  ];
  const lpAnswers = lowProbCands.flatMap(c => {
    const q = getStage1DecisionQuestionIds(c.candidate_id);
    return [
      { id: q.predicateId, type: 'predicate', probability: 0.05, value: false },
      { id: q.choiceId, type: 'choice', value: c.candidate_id === 'LP-ZOOM' ? 'unclear_needs_zoom' : 'exact_peer' },
    ];
  });
  const lpParsed = parseStage1DecisionsResponses(lowProbCands, [{ answers: lpAnswers }], {
    gate0Config: { enforce_red_ocean_skip: true },
  });
  const lpById = Object.fromEntries(lpParsed.items.map(it => [it.candidate_id, it]));
  assert.equal(lpById['LP-PAT'].needs_review, true);
  assert.equal(lpById['LP-PWR'].needs_review, true);
  assert.equal(lpById['LP-ZOOM'].needs_review, true);
  assert.equal(lpById['LP-APP'].gate0_status, 'skipped_red_ocean');
  assert.equal(lpById['LP-APP'].triage_disposition, 'skipped_red_ocean_default');

  // 3) Spec-3 + Spec-5 + Standards-1 + Standards-3: 1688 probabilities (object + array), seller_member_id dedup, JSON replay, conflicting tileBindings, no email echo
  const targetSpec = { form_id: 'form-reg', saleable_unit: '1 kit' };
  const sellerOffers = [
    { offer_id: 'SO-1', title: '整套胡桃木架A1', price_cny: 31, moq: 100, seller_member_id: 'MEM-A' },
    { offer_id: 'SO-2', title: '整套胡桃木架A2', price_cny: 32, moq: 100, seller_member_id: 'MEM-A' },
    { offer_id: 'SO-3', title: '整套胡桃木架A3', price_cny: 33, moq: 100, seller_member_id: 'MEM-A' },
    { offer_id: 'SO-4', title: '整套胡桃木架B1', price_cny: 34, moq: 100, seller_member_id: 'MEM-B' },
  ];
  const sellerReqs = build1688SearchRankingDecisionsRequests({
    offers: sellerOffers,
    targetSpec,
    contactSheetDataUrl: TINY_PNG_DATA_URI,
  });
  const sellerAnswers = sellerOffers.flatMap((o, idx) => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    if (idx === 0) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.92, value: true },
        {
          id: q.rankChoiceId,
          type: 'choice',
          value: 'priority_complete_kit_factory',
          choice_probabilities: { priority_complete_kit_factory: 0.91, plausible_needs_detail_check: 0.09 },
        },
      ];
    }
    return [
      { id: q.completeKitPredicateId, type: 'predicate', probability: 0.90 - idx * 0.02, value: true },
      {
        id: q.rankChoiceId,
        type: 'choice',
        probabilities: [
          { value: 'priority_complete_kit_factory', probability: 0.88 },
          { value: 'plausible_needs_detail_check', probability: 0.12 },
        ],
      },
    ];
  });

  // Replay using JSON-serialized requests + mutated caller offers MUST preserve original sent offers & tile bindings!
  const jsonReplayedReqs = JSON.parse(JSON.stringify(sellerReqs));
  const tamperedOffers = sellerOffers.map(o => ({ ...o, price_cny: 999, seller_member_id: 'TAMPERED' }));
  const sellerParsed = parse1688SearchRankingDecisionsResponses(tamperedOffers, [{ answers: sellerAnswers }], {
    requests: jsonReplayedReqs,
  });
  assert.deepEqual(
    sellerParsed.shortlist_to_open.map(o => o.offer_id),
    ['SO-1', 'SO-4'],
    'seller_member_id dedup must pick MEM-A once and include MEM-B without crowding out distinct factories',
  );
  assert.equal(sellerParsed.shortlist_to_open[0].price_cny, 31, 'JSON-replayed requests must recover sent offer prices');
  assert.equal(sellerParsed.shortlist_to_open[0].sheet_index, 1);
  assert.equal(sellerParsed.shortlist_to_open[0].tile_index, 1);

  // Conflicting tileBindings against recorded requests MUST throw
  assert.throws(
    () => parse1688SearchRankingDecisionsResponses(sellerOffers, [{ answers: sellerAnswers }], {
      requests: jsonReplayedReqs,
      tileBindings: { 'SO-1': { sheet_index: 5, tile_index: 39 } },
    }),
    /Conflicting tileBindings/i,
  );

  // Email in title/factory_badge rejected; email in foreign answer key NEVER echoed in error message
  assert.throws(
    () => build1688SearchRankingDecisionsRequests({
      offers: [{ offer_id: 'EM-1', title: 'Contact boss@factory.cn for quote', price_cny: 30, moq: 100 }],
      targetSpec,
    }),
    /email/i,
  );
  assert.throws(
    () => build1688SearchRankingDecisionsRequests({
      offers: [{ offer_id: 'EM-2', title: 'Valid title', factory_badge: 'sales@shop.cn', price_cny: 30, moq: 100 }],
      targetSpec,
    }),
    /email/i,
  );
  assert.throws(
    () => parse1688SearchRankingDecisionsResponses(sellerOffers, [{
      answers: [{ id: 'foreign_secret@supplier.cn', type: 'predicate', value: false }],
    }]),
    err => err instanceof TypeError && !String(err.message).includes('secret@supplier.cn'),
  );

  // 4) Spec-6: all_refused returns empty shortlist_to_open + manual review + price-ordered fallback
  const allRefusedAnswers = sellerOffers.flatMap(o => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    return [
      { id: q.completeKitPredicateId, type: 'refusal' },
      { id: q.rankChoiceId, type: 'refusal' },
    ];
  });
  const refusedRes = parse1688SearchRankingDecisionsResponses(sellerOffers, [{ answers: allRefusedAnswers }], {
    requests: sellerReqs,
  });
  assert.equal(refusedRes.candidate_eliminated, false);
  assert.equal(refusedRes.product_status, 'retained_for_sourcing');
  assert.equal(refusedRes.summary.all_refused, true);
  assert.equal(refusedRes.shortlist_to_open.length, 0, 'all_refused must NOT emit model-backed opening recommendations');
  assert.equal(refusedRes.next_step, 'refine_1688_search_or_manual_review');
  assert.equal(refusedRes.fallback_price_order_offers.length, 4);
  assert.equal(refusedRes.fallback_price_order_offers[0].offer_id, 'SO-1');

  // 5) Spec-4 + Standards-4: explicit 2x25 sheets[] with per-sheet tile_index 1..25, AND per-chunk response validation!
  const make25 = prefix => Array.from({ length: 25 }, (_, i) => ({
    offer_id: `${prefix}-${i + 1}`,
    tile_index: i + 1,
    price_cny: 30 + i,
    moq: 100,
    factory_id: `${prefix}-F-${i + 1}`,
  }));
  const sheetA = make25('SA');
  const sheetB = make25('SB');
  const twoSheetReqs = build1688SearchRankingDecisionsRequests({
    sheets: [
      { contactSheetDataUrl: TINY_PNG_DATA_URI, offers: sheetA },
      { contactSheetDataUrl: TINY_PNG_DATA_URI, offers: sheetB },
    ],
    targetSpec,
  });
  assert.equal(twoSheetReqs.length, 2);
  const ansA = sheetA.flatMap(o => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    return [
      { id: q.completeKitPredicateId, type: 'predicate', probability: 0.7, value: true },
      { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' },
    ];
  });
  const ansB = sheetB.flatMap(o => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    return [
      { id: q.completeKitPredicateId, type: 'predicate', probability: 0.6, value: true },
      { id: q.rankChoiceId, type: 'choice', value: 'plausible_needs_detail_check' },
    ];
  });
  // Merged 1-response for 2 requests MUST throw (Standards-4!)
  assert.throws(
    () => parse1688SearchRankingDecisionsResponses([...sheetA, ...sheetB], [{ answers: [...ansA, ...ansB] }], {
      requests: twoSheetReqs,
    }),
    /must match requests length/i,
  );
  // Proper 2-chunk responses parse cleanly with exact (sheet_index, tile_index)
  const twoSheetParsed = parse1688SearchRankingDecisionsResponses([...sheetA, ...sheetB], [{ answers: ansA }, { answers: ansB }], {
    requests: twoSheetReqs,
  });
  const sb1 = twoSheetParsed.ranked_offers.find(o => o.offer_id === 'SB-1');
  assert.equal(sb1.sheet_index, 2);
  assert.equal(sb1.tile_index, 1);

  // 6) Spec-4 + Spec-7 + Standards-2 + Standards-5 (Python contact sheet):
  //    40-offer cap on 6x7, Amazon auto-detect + idx:"A7", header/moq email PII scrub, and malformed port URL fallback
  withTempDir(dir => {
    const imgPath = join(dir, 'ok.png');
    writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    // 6a) 6x7 (42 grid cells) in 1688 mode MUST cap at 40 tiles + scrub PII from title & non-numeric moq + survive bad URL port!
    const offers45 = Array.from({ length: 45 }, (_, i) => ({
      offer_id: `CAP-${i + 1}`,
      title: `整套木架 ${i + 1}`,
      price_cny: 35 + i,
      moq: i === 0 ? 'leak@supplier.cn' : 100,
      image_url: i === 0 ? 'https://example.com:abc/bad-port.png' : undefined,
      image_path: i === 0 ? undefined : imgPath,
    }));
    const inCap = join(dir, 'cap45.json');
    const outCap = join(dir, 'cap45.png');
    writeFileSync(inCap, JSON.stringify({ title: 'Contact owner@factory.cn Sheet', offers: offers45 }), 'utf8');
    const resCap = spawnSync(process.execPath, [
      CLI_PATH, 'contact-sheet',
      '--input', inCap,
      '--output', outCap,
      '--mode', '1688',
      '--cols', '6',
      '--rows', '7',
    ], { encoding: 'utf8' });
    assert.equal(resCap.status, 0, `1688 6x7 bad-port/PII test failed: ${resCap.stderr}`);
    const outCapJson = JSON.parse(resCap.stdout);
    assert.equal(outCapJson.rendered.items_rendered, 40, '1688 single contact sheet must cap at 40 tiles even on 6x7');
    assert.equal(outCapJson.rendered.title, '[REDACTED]', 'Header title with email PII must be scrubbed');
    assert.equal(outCapJson.rendered.rows[0].moq, null, 'Non-numeric string in moq must never leak into manifest');
    assert.equal(outCapJson.rendered.rows[0].image_status, 'http_blocked', 'Bad URL port must degrade to missing image without crashing');

    // 6b) Amazon backwards compatibility: listings[] with candidate_id + price_usd + moq (no asin) + idx:"A7" stays Amazon mode & preserves "#A7"
    const inAmzCompat = join(dir, 'amz-compat.json');
    const outAmzCompat = join(dir, 'amz-compat.png');
    writeFileSync(inAmzCompat, JSON.stringify({
      listings: [{ idx: 'A7', candidate_id: 'CAND-1', price_usd: 49.99, moq: 100, image_path: imgPath }],
    }), 'utf8');
    const resAmzCompat = spawnSync(process.execPath, [
      CLI_PATH, 'contact-sheet',
      '--input', inAmzCompat,
      '--output', outAmzCompat,
      '--offline',
    ], { encoding: 'utf8' });
    assert.equal(resAmzCompat.status, 0, resAmzCompat.stderr);
    const outAmzCompatJson = JSON.parse(resAmzCompat.stdout);
    assert.equal(outAmzCompatJson.rendered.mode, 'amazon', 'listings[] with price_usd + moq must auto-detect amazon, not 1688');
    assert.equal(outAmzCompatJson.rendered.rows[0].rendered_tile_label, '#A7', 'Amazon non-integer idx "A7" must keep "#A7" badge');
  });
});
