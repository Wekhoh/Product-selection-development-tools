import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUSINESS_THRESHOLDS } from '../src/business-thresholds.mjs';
import { validateSourcingVerifier1688Output } from '../src/contracts.mjs';
import { openSelectionStore } from '../src/store.mjs';
import { scoreBatch, scoreCandidate } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import {
  runFastProfitHealthcheck2027,
  runGate1AForForm,
  runGate1BForForm,
  runPhase2Batch,
} from '../src/pipeline.mjs';
import { calculateEconomics, evaluateEarlyScreen } from '../src/economics.mjs';
import {
  FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
  FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
  computeHeadhaulWithA4Rules,
  computeOrderPlan,
  estimateGate1A2027,
  evaluateSingleFactoryCompleteKit,
  lookupBulkyPlacementFee2027,
  resolveVerifiedFactoryKey,
  solveMinPriceForMargin2027,
} from '../src/fba-calculator.mjs';
import { analyzeMainstreamPriceBand } from '../src/price-band.mjs';
import { ingestTrialSpecification } from '../src/raw-ingest.mjs';
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
import {
  DEFAULT_R59_UI_READBACK,
  REPO_ROOT,
  STAGE4_AS_OF_DATE,
  TINY_PNG_B64,
  TINY_PNG_DATA_URI,
  loadR59Profile,
  loadSyntheticBatch,
  makeDatedKeepaReceipt,
  runCliMem,
  withTempDir,
  withTempDirAsync,
} from './helpers/test-fixtures.mjs';

const CLI_PATH = join(REPO_ROOT, 'src', 'phase2-cli.mjs');
const r59Profile = loadR59Profile();
const synthBatch = loadSyntheticBatch();

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
  const qText = reqs[0].questions[0].instructions;
  assert.match(qText, /powered|electronic/i);
  assert.match(qText, /patent|IP/i);
  assert.match(qText, /holiday|date/i);

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

  for (const protectedId of ['C-PWR', 'C-PAT', 'C-UNC', 'C-PIANO', 'C-POTS', 'C-PET', 'C-APP']) {
    const it = byId[protectedId];
    assert.equal(it.gate0_status, 'allowed');
    assert.equal(it.gate0_review_watch, true);
    assert.equal(it.triage_disposition, 'amber_manual_review');
    assert.equal(it.needs_review, true);
    assert.equal(it.luna_non_overreach_clamped, true);
    assert.ok(Array.isArray(it.luna_non_overreach_reasons) && it.luna_non_overreach_reasons.length >= 1);
  }
  assert.equal(parsed.summary.luna_non_overreach_clamped_count, 7);

  assert.equal(byId['C-CHILD'].gate0_status, 'prohibited');
  assert.equal(byId['C-CHILD'].triage_disposition, 'prohibited_auto_excluded');
  assert.equal(byId['C-CHILD'].luna_non_overreach_clamped, false);

  assert.equal(byId['C-HOLIDAY'].gate0_status, 'prohibited');
  assert.equal(byId['C-HOLIDAY'].triage_disposition, 'prohibited_auto_excluded');
  assert.equal(byId['C-HOLIDAY'].luna_non_overreach_clamped, false);
});

test('Issue #28 (1688 20-40 contact sheet): render_contact_sheet.py & phase2-cli render 25 and 40 1688 offers with CNY price, MOQ, offer_id while preserving Amazon 4x4 defaults', () => {
  withTempDir('issue28-stage3b-', dir => {
    const imgPath = join(dir, 'offer.png');
    writeFileSync(imgPath, Buffer.from(TINY_PNG_B64, 'base64'));

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
      CLI_PATH, 'contact-sheet', '--input', in25, '--output', png25, '--manifest-out', man25, '--offline',
    ], { encoding: 'utf8' });
    assert.equal(res25.status, 0, res25.stderr);
    const out25 = JSON.parse(res25.stdout);
    assert.equal(out25.ok, true);
    assert.equal(out25.rendered.mode, '1688');
    assert.equal(out25.rendered.items_total, 25);
    assert.equal(out25.rendered.items_rendered, 25);
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
      CLI_PATH, 'contact-sheet', '--input', in40, '--output', png40, '--mode', '1688', '--cols', '5', '--rows', '8', '--offline',
    ], { encoding: 'utf8' });
    assert.equal(res40.status, 0, res40.stderr);
    const out40 = JSON.parse(res40.stdout);
    assert.equal(out40.rendered.mode, '1688');
    assert.equal(out40.rendered.items_rendered, 40);
    assert.equal(out40.rendered.rows[39].tile_index, 40);

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
      CLI_PATH, 'contact-sheet', '--input', inAmz, '--output', pngAmz, '--offline',
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

  const offers30 = Array.from({ length: 30 }, (_, i) => ({
    offer_id: `OFF-${String(i + 1).padStart(3, '0')}`,
    title: `实木胡桃木收纳架含布袋整套 #${i + 1}`,
    price_cny: Number((35 + (i % 7) * 4.5).toFixed(2)),
    moq: i % 3 === 0 ? 50 : 100,
    factory_id: i === 1 ? 'FAC-01' : `FAC-${String(i + 1).padStart(2, '0')}`,
    factory_badge: i < 6 ? '源头工厂' : '贸易商',
    province: '广东深圳',
  }));

  const reqs = build1688SearchRankingDecisionsRequests({
    offers: offers30, targetSpec, contactSheetDataUrl: TINY_PNG_DATA_URI, imageDetail: 'high', promptCacheKey: 'sourcing-1688-rank-v1',
  });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].model, 'gpt-6-luna');
  assert.equal('reasoning' in reqs[0], false);
  assert.equal('reasoning_effort' in reqs[0], false);
  assert.equal(reqs[0].questions.length, 60);
  assert.equal(reqs[0].questions.some(q => /gate0_prohibited|exclude_product|reject_candidate/i.test(q.id)), false);

  assert.throws(
    () => build1688SearchRankingDecisionsRequests({
      offers: Array.from({ length: 41 }, (_, i) => ({ offer_id: `O-${i}`, price_cny: 30, moq: 100 })),
      targetSpec, contactSheetDataUrl: TINY_PNG_DATA_URI,
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

  const offers45 = Array.from({ length: 45 }, (_, i) => ({
    offer_id: `M-${String(i + 1).padStart(3, '0')}`, price_cny: 40 + i, moq: 100, factory_id: `MF-${i + 1}`,
  }));
  const multiReqs = build1688SearchRankingDecisionsRequests({
    offers: offers45, targetSpec, contactSheetDataUrls: [TINY_PNG_DATA_URI, TINY_PNG_DATA_URI],
  });
  assert.equal(multiReqs.length, 2);
  assert.equal(multiReqs[0].questions.length, 80);
  assert.equal(multiReqs[1].questions.length, 10);

  const answers = offers30.flatMap((o, idx) => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    if (idx === 0) return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.90, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' }];
    if (idx === 1) return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.95, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' }];
    if (idx === 2) return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.88, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' }];
    if (idx === 3) return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.82, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' }];
    if (idx === 4) return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.78, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' }];
    if (idx === 5) return [{ id: q.completeKitPredicateId, type: 'refusal' }, { id: q.rankChoiceId, type: 'refusal' }];
    const demoteTier = idx % 3 === 0 ? 'demote_bare_part_or_incomplete' : (idx % 3 === 1 ? 'demote_wrong_spec_or_material' : 'demote_trading_or_low_fit');
    return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.12, value: false }, { id: q.rankChoiceId, type: 'choice', value: demoteTier }];
  });

  const ranked = parse1688SearchRankingDecisionsResponses(offers30, [{ answers }], { requests: reqs });
  assert.equal(ranked.candidate_eliminated, false);
  assert.equal(ranked.product_status, 'retained_for_sourcing');
  assert.equal(ranked.next_step, 'open_detail_pages_for_terra_hd_verification');
  assert.equal(ranked.ranked_offers.length, 30);
  assert.equal(ranked.shortlist_to_open.length, BUSINESS_THRESHOLDS.max_1688_factories_to_check);
  assert.deepEqual(ranked.shortlist_to_open.map(o => o.offer_id), ['OFF-002', 'OFF-003', 'OFF-004']);
  assert.equal(ranked.demoted_offers.length, 24);
  const refusedOffer = ranked.ranked_offers.find(o => o.offer_id === 'OFF-006');
  assert.equal(refusedOffer.rank_tier, 'plausible_needs_detail_check');
  assert.equal(refusedOffer.complete_kit_likely, 'unknown');

  const allDemotedAnswers = offers30.flatMap(o => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.05, value: false }, { id: q.rankChoiceId, type: 'choice', value: 'demote_bare_part_or_incomplete' }];
  });
  const allDemotedRes = parse1688SearchRankingDecisionsResponses(offers30, [{ answers: allDemotedAnswers }], { requests: reqs });
  assert.equal(allDemotedRes.candidate_eliminated, false);
  assert.equal(allDemotedRes.product_status, 'retained_for_sourcing');
  assert.equal(allDemotedRes.shortlist_to_open.length, 0);
  assert.equal(allDemotedRes.next_step, 'refine_1688_search_or_manual_review');

  const handoff = prepare1688DetailVerificationHandoff({
    rankingResult: ranked, targetSpec,
    openedDetailsByOfferId: {
      'OFF-002': { sku_label: '胡桃木整套+麻布袋', images: [TINY_PNG_DATA_URI], listing_attributes: { material: 'ABS 仿胡桃木纹', weight_g: 420 } },
    },
    imageDetail: 'high',
  });
  assert.equal(handoff.requests.length, 1);
  assert.equal(handoff.requests[0].offer_id, 'OFF-002');
  assert.equal(handoff.requests[0].request.model, 'gpt-6.1-terra');
  assert.equal(handoff.requests[0].request.reasoning.effort, 'xhigh');
  assert.equal(handoff.requests[0].request.input[1].content[1].detail, 'high');
  assert.deepEqual(handoff.deferred_shortlist_offer_ids, ['OFF-003', 'OFF-004']);

  assert.throws(
    () => prepare1688DetailVerificationHandoff({
      rankingResult: ranked, targetSpec, openedDetailsByOfferId: { 'OFF-002': { images: [TINY_PNG_DATA_URI] } }, imageDetail: 'low',
    }),
    /high.*original/i,
  );

  const terraParsed = parse1688VisionInspectResult({
    schema_version: 1, contract: 'VisionInspector1688', spec_match_verdict: 'mismatch',
    dimension_weight_findings: {
      product_dimensions_mm: '240x180x85', package_dimensions_mm: null, unit_weight_g: 420, package_weight_g: null,
      carton_pack_qty: 20, evidence_notes: 'Detail-page closeup shows molded ABS faux-walnut grain.',
    },
    sensitive_freebie_flags: { oil_or_glue: 'none', battery_type: 'none', strong_magnet: 'none', notes: 'No freebies.' },
    component_gaps: ['Material mismatch: ABS', 'Missing linen storage pouch', 'Slot diameter 16 mm'],
    wangwang_questions: ['请问该款是否有真黑胡桃实木现货版本，100套裸货单价和交期是多少？', '请问是否可以同一工厂齐套配齐麻布收纳袋及22mm孔径规格？'],
  });
  assert.equal(terraParsed.valid, true);
  assert.equal(terraParsed.spec_match_verdict, 'mismatch');
  assert.equal(terraParsed.component_gaps.length, 3);
  assert.equal(terraParsed.wangwang_questions.length, 2);
});

test('Issue #28 Astra review regressions (1688 & Luna): low-prob needs_review, probabilities/multi-sheet/seller-dedup/all-refused/replay/chunk/PII/bad-port', () => {
  const lowProbCands = [
    { candidate_id: 'LP-PAT', title: 'Magnetic Workshop Clamp', suspected_patent: true, price_usd: 39.99 },
    { candidate_id: 'LP-PWR', title: 'Cordless Ultrasonic Cleaner', is_powered: true, price_usd: 44.99 },
    { candidate_id: 'LP-ZOOM', title: 'Specialty Doweling Jig', price_usd: 49.99 },
    { candidate_id: 'LP-APP', title: 'Cotton Crew T-Shirt', root_category: 'Clothing, Shoes & Jewelry', price_usd: 32.99 },
  ];
  const lpAnswers = lowProbCands.flatMap(c => {
    const q = getStage1DecisionQuestionIds(c.candidate_id);
    return [{ id: q.predicateId, type: 'predicate', probability: 0.05, value: false }, { id: q.choiceId, type: 'choice', value: c.candidate_id === 'LP-ZOOM' ? 'unclear_needs_zoom' : 'exact_peer' }];
  });
  const lpParsed = parseStage1DecisionsResponses(lowProbCands, [{ answers: lpAnswers }], { gate0Config: { enforce_red_ocean_skip: true } });
  const lpById = Object.fromEntries(lpParsed.items.map(it => [it.candidate_id, it]));
  assert.equal(lpById['LP-PAT'].needs_review, true);
  assert.equal(lpById['LP-PWR'].needs_review, true);
  assert.equal(lpById['LP-ZOOM'].needs_review, true);
  assert.equal(lpById['LP-APP'].gate0_status, 'skipped_red_ocean');
  assert.equal(lpById['LP-APP'].triage_disposition, 'skipped_red_ocean_default');

  const targetSpec = { form_id: 'form-reg', saleable_unit: '1 kit' };
  const sellerOffers = [
    { offer_id: 'SO-1', title: '整套胡桃木架A1', price_cny: 31, moq: 100, seller_member_id: 'MEM-A' },
    { offer_id: 'SO-2', title: '整套胡桃木架A2', price_cny: 32, moq: 100, seller_member_id: 'MEM-A' },
    { offer_id: 'SO-3', title: '整套胡桃木架A3', price_cny: 33, moq: 100, seller_member_id: 'MEM-A' },
    { offer_id: 'SO-4', title: '整套胡桃木架B1', price_cny: 34, moq: 100, seller_member_id: 'MEM-B' },
  ];
  const sellerReqs = build1688SearchRankingDecisionsRequests({ offers: sellerOffers, targetSpec, contactSheetDataUrl: TINY_PNG_DATA_URI });
  const sellerAnswers = sellerOffers.flatMap((o, idx) => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    if (idx === 0) {
      return [
        { id: q.completeKitPredicateId, type: 'predicate', probability: 0.92, value: true },
        { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory', choice_probabilities: { priority_complete_kit_factory: 0.91, plausible_needs_detail_check: 0.09 } },
      ];
    }
    return [
      { id: q.completeKitPredicateId, type: 'predicate', probability: 0.90 - idx * 0.02, value: true },
      { id: q.rankChoiceId, type: 'choice', probabilities: [{ value: 'priority_complete_kit_factory', probability: 0.88 }, { value: 'plausible_needs_detail_check', probability: 0.12 }] },
    ];
  });

  const jsonReplayedReqs = JSON.parse(JSON.stringify(sellerReqs));
  const tamperedOffers = sellerOffers.map(o => ({ ...o, price_cny: 999, seller_member_id: 'TAMPERED' }));
  const sellerParsed = parse1688SearchRankingDecisionsResponses(tamperedOffers, [{ answers: sellerAnswers }], { requests: jsonReplayedReqs });
  assert.deepEqual(sellerParsed.shortlist_to_open.map(o => o.offer_id), ['SO-1', 'SO-4']);
  assert.equal(sellerParsed.shortlist_to_open[0].price_cny, 31);
  assert.equal(sellerParsed.shortlist_to_open[0].sheet_index, 1);
  assert.equal(sellerParsed.shortlist_to_open[0].tile_index, 1);

  assert.throws(
    () => parse1688SearchRankingDecisionsResponses(sellerOffers, [{ answers: sellerAnswers }], {
      requests: jsonReplayedReqs, tileBindings: { 'SO-1': { sheet_index: 5, tile_index: 39 } },
    }),
    /Conflicting tileBindings/i,
  );
  assert.throws(
    () => build1688SearchRankingDecisionsRequests({ offers: [{ offer_id: 'EM-1', title: 'Contact boss@factory.cn for quote', price_cny: 30, moq: 100 }], targetSpec }),
    /email/i,
  );
  assert.throws(
    () => build1688SearchRankingDecisionsRequests({ offers: [{ offer_id: 'EM-2', title: 'Valid title', factory_badge: 'sales@shop.cn', price_cny: 30, moq: 100 }], targetSpec }),
    /email/i,
  );
  assert.throws(
    () => parse1688SearchRankingDecisionsResponses(sellerOffers, [{ answers: [{ id: 'foreign_secret@supplier.cn', type: 'predicate', value: false }] }]),
    err => err instanceof TypeError && !String(err.message).includes('secret@supplier.cn'),
  );

  const allRefusedAnswers = sellerOffers.flatMap(o => {
    const q = get1688OfferRankDecisionQuestionIds(o.offer_id);
    return [{ id: q.completeKitPredicateId, type: 'refusal' }, { id: q.rankChoiceId, type: 'refusal' }];
  });
  const refusedRes = parse1688SearchRankingDecisionsResponses(sellerOffers, [{ answers: allRefusedAnswers }], { requests: sellerReqs });
  assert.equal(refusedRes.candidate_eliminated, false);
  assert.equal(refusedRes.product_status, 'retained_for_sourcing');
  assert.equal(refusedRes.summary.all_refused, true);
  assert.equal(refusedRes.shortlist_to_open.length, 0);
  assert.equal(refusedRes.next_step, 'refine_1688_search_or_manual_review');
  assert.equal(refusedRes.fallback_price_order_offers.length, 4);
  assert.equal(refusedRes.fallback_price_order_offers[0].offer_id, 'SO-1');

  const make25 = prefix => Array.from({ length: 25 }, (_, i) => ({
    offer_id: `${prefix}-${i + 1}`, tile_index: i + 1, price_cny: 30 + i, moq: 100, factory_id: `${prefix}-F-${i + 1}`,
  }));
  const sheetA = make25('SA');
  const sheetB = make25('SB');
  const twoSheetReqs = build1688SearchRankingDecisionsRequests({
    sheets: [{ contactSheetDataUrl: TINY_PNG_DATA_URI, offers: sheetA }, { contactSheetDataUrl: TINY_PNG_DATA_URI, offers: sheetB }],
    targetSpec,
  });
  assert.equal(twoSheetReqs.length, 2);
  const ansA = sheetA.flatMap(o => { const q = get1688OfferRankDecisionQuestionIds(o.offer_id); return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.7, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'priority_complete_kit_factory' }]; });
  const ansB = sheetB.flatMap(o => { const q = get1688OfferRankDecisionQuestionIds(o.offer_id); return [{ id: q.completeKitPredicateId, type: 'predicate', probability: 0.6, value: true }, { id: q.rankChoiceId, type: 'choice', value: 'plausible_needs_detail_check' }]; });
  assert.throws(
    () => parse1688SearchRankingDecisionsResponses([...sheetA, ...sheetB], [{ answers: [...ansA, ...ansB] }], { requests: twoSheetReqs }),
    /must match requests length/i,
  );
  const twoSheetParsed = parse1688SearchRankingDecisionsResponses([...sheetA, ...sheetB], [{ answers: ansA }, { answers: ansB }], { requests: twoSheetReqs });
  assert.equal(twoSheetParsed.ranked_offers.find(o => o.offer_id === 'SB-1').sheet_index, 2);
  assert.equal(twoSheetParsed.ranked_offers.find(o => o.offer_id === 'SB-1').tile_index, 1);

  withTempDir('issue28-cap45-', dir => {
    const imgPath = join(dir, 'ok.png');
    writeFileSync(imgPath, Buffer.from(TINY_PNG_B64, 'base64'));
    const offers45 = Array.from({ length: 45 }, (_, i) => ({
      offer_id: `CAP-${i + 1}`, title: `整套木架 ${i + 1}`, price_cny: 35 + i,
      moq: i === 0 ? 'leak@supplier.cn' : 100,
      image_url: i === 0 ? 'https://example.com:abc/bad-port.png' : undefined,
      image_path: i === 0 ? undefined : imgPath,
    }));
    const inCap = join(dir, 'cap45.json');
    const outCap = join(dir, 'cap45.png');
    writeFileSync(inCap, JSON.stringify({ title: 'Contact owner@factory.cn Sheet', offers: offers45 }), 'utf8');
    const resCap = spawnSync(process.execPath, [CLI_PATH, 'contact-sheet', '--input', inCap, '--output', outCap, '--mode', '1688', '--cols', '6', '--rows', '7'], { encoding: 'utf8' });
    assert.equal(resCap.status, 0, resCap.stderr);
    const outCapJson = JSON.parse(resCap.stdout);
    assert.equal(outCapJson.rendered.items_rendered, 40);
    assert.equal(outCapJson.rendered.title, '[REDACTED]');
    assert.equal(outCapJson.rendered.rows[0].moq, null);
    assert.equal(outCapJson.rendered.rows[0].image_status, 'http_blocked');

    const inAmzCompat = join(dir, 'amz-compat.json');
    const outAmzCompat = join(dir, 'amz-compat.png');
    writeFileSync(inAmzCompat, JSON.stringify({ listings: [{ idx: 'A7', candidate_id: 'CAND-1', price_usd: 49.99, moq: 100, image_path: imgPath }] }), 'utf8');
    const resAmzCompat = spawnSync(process.execPath, [CLI_PATH, 'contact-sheet', '--input', inAmzCompat, '--output', outAmzCompat, '--offline'], { encoding: 'utf8' });
    assert.equal(resAmzCompat.status, 0, resAmzCompat.stderr);
    const outAmzCompatJson = JSON.parse(resAmzCompat.stdout);
    assert.equal(outAmzCompatJson.rendered.mode, 'amazon');
    assert.equal(outAmzCompatJson.rendered.rows[0].rendered_tile_label, '#A7');
  });
});

test('Stage 3B independent audit hardening (1688 & Luna): patent-pending Luna clamp, metadata-only >40 offers, cross-field dedup, multi-sheet same-URI replay, all-choices-refused, CJK wrapping', () => {
  const s1Cands = [
    { candidate_id: 'PAT-TITLE', title: 'Magnetic Mahjong Rack Patent Pending Design', price_usd: 59.99 },
    { candidate_id: 'PWR-DISABLED', title: 'Cordless Heated Espresso Cup Warmer', price_usd: 42.99 },
  ];
  const s1Res = parseStage1DecisionsResponses(s1Cands, [{
    answers: [
      { id: getStage1DecisionQuestionIds('PAT-TITLE').predicateId, type: 'predicate', probability: 0.92, value: true },
      { id: getStage1DecisionQuestionIds('PAT-TITLE').choiceId, type: 'choice', value: 'exact_peer' },
      { id: getStage1DecisionQuestionIds('PWR-DISABLED').predicateId, type: 'predicate', probability: 0.10, value: false },
      { id: getStage1DecisionQuestionIds('PWR-DISABLED').choiceId, type: 'choice', value: 'exact_peer' },
    ],
  }], { gate0Config: { allow_low_risk_powered_non_3c: false, enforce_red_ocean_skip: true } });
  const patItem = s1Res.items.find(i => i.candidate_id === 'PAT-TITLE');
  assert.equal(patItem.gate0_status, 'allowed');
  assert.equal(patItem.triage_disposition, 'amber_manual_review');
  assert.equal(patItem.needs_review, true);
  assert.equal(patItem.luna_non_overreach_clamped, true);
  assert.notEqual(s1Res.items.find(i => i.candidate_id === 'PWR-DISABLED').triage_disposition, 'skipped_red_ocean_default');
  assert.equal(s1Res.summary.gate0_skipped_red_ocean_count, 0);

  const offers42 = Array.from({ length: 42 }, (_, i) => ({
    offer_id: `META-${i + 1}`, tile_index: i + 1, factory_id: `MF-${i + 1}`, price_cny: 40 + i, moq: 100, title: 'Solid Wood Rack',
  }));
  const metaReqs = build1688SearchRankingDecisionsRequests({ offers: offers42, targetSpec: 'Solid Wood Rack' });
  const metaResps = metaReqs.map(r => ({
    answers: r.questions.map(q => q.type === 'predicate' ? { id: q.id, type: 'predicate', value: true, probability: 0.85 } : { id: q.id, type: 'choice', value: 'priority_complete_kit_factory' }),
  }));
  const metaParsed = parse1688SearchRankingDecisionsResponses(offers42, metaResps, { requests: metaReqs });
  assert.equal(metaParsed.candidate_eliminated, false);
  assert.equal(metaParsed.shortlist_to_open.length, 3);
  assert.equal(metaParsed.ranked_offers[0].sheet_index, null);
  assert.equal(metaParsed.ranked_offers[0].tile_index, null);

  const crossFieldOffers = [
    { offer_id: 'CF-1', factory_id: 'fac-A', seller_member_id: 'seller-A', price_cny: 30, moq: 100, title: 'Kit 1' },
    { offer_id: 'CF-2', seller_member_id: 'seller-A', price_cny: 31, moq: 100, title: 'Kit 2 (same seller)' },
    { offer_id: 'CF-3', factory_id: 'fac-B', price_cny: 35, moq: 100, title: 'Kit 3' },
    { offer_id: 'CF-4', factory_id: 'fac-C', price_cny: 36, moq: 100, title: 'Kit 4' },
  ];
  const cfReqs = build1688SearchRankingDecisionsRequests({ offers: crossFieldOffers, targetSpec: 'Kit' });
  const cfResps = cfReqs.map(r => ({
    answers: r.questions.map(q => q.type === 'predicate' ? { id: q.id, type: 'predicate', value: true, probability: 0.9 } : { id: q.id, type: 'choice', value: 'priority_complete_kit_factory' }),
  }));
  const cfParsed = parse1688SearchRankingDecisionsResponses(crossFieldOffers, cfResps, { requests: cfReqs });
  assert.deepEqual(cfParsed.shortlist_to_open.map(o => o.offer_id), ['CF-1', 'CF-3', 'CF-4']);

  const dupImgReqs = build1688SearchRankingDecisionsRequests({
    sheets: [
      { contactSheetDataUrl: TINY_PNG_DATA_URI, offers: [{ offer_id: 'S1-1', tile_index: 1, price_cny: 30, moq: 100, title: 'A' }] },
      { contactSheetDataUrl: TINY_PNG_DATA_URI, offers: [{ offer_id: 'S2-1', tile_index: 1, price_cny: 32, moq: 100, title: 'B' }] },
    ],
    targetSpec: 'Kit',
  });
  const dupImgJson = JSON.parse(JSON.stringify(dupImgReqs));
  const dupImgResps = dupImgJson.map(r => ({
    answers: r.questions.map(q => q.type === 'predicate' ? { id: q.id, type: 'predicate', value: true, probability: 0.9 } : { id: q.id, type: 'choice', value: 'priority_complete_kit_factory' }),
  }));
  const dupImgParsed = parse1688SearchRankingDecisionsResponses(null, dupImgResps, { requests: dupImgJson });
  assert.equal(dupImgParsed.ranked_offers.find(o => o.offer_id === 'S1-1').sheet_index, 1);
  assert.equal(dupImgParsed.ranked_offers.find(o => o.offer_id === 'S2-1').sheet_index, 2);

  const partialRefOffers = [
    { offer_id: 'PR-1', factory_id: 'pf-1', price_cny: 20, moq: 100, title: 'Bare' },
    { offer_id: 'PR-2', factory_id: 'pf-2', price_cny: 25, moq: 100, title: 'Bare 2' },
  ];
  const prReqs = build1688SearchRankingDecisionsRequests({ offers: partialRefOffers, targetSpec: 'Kit' });
  const prResps = prReqs.map(r => ({
    answers: r.questions.map(q => q.type === 'predicate' ? { id: q.id, type: 'predicate', value: false, probability: 0.02 } : { id: q.id, type: 'refusal' }),
  }));
  const prParsed = parse1688SearchRankingDecisionsResponses(partialRefOffers, prResps, { requests: prReqs });
  assert.equal(prParsed.candidate_eliminated, false);
  assert.equal(prParsed.shortlist_to_open.length, 0);
  assert.equal(prParsed.next_step, 'refine_1688_search_or_manual_review');
  assert.equal(prParsed.fallback_price_order_offers.length, 2);

  assert.throws(() => prepare1688DetailVerificationHandoff({ rankingResult: cfParsed, targetSpec: '   ' }), /targetSpec/i);

  withTempDir('issue28-cjk-', dir => {
    const inCjk = join(dir, 'cjk-offers.json');
    const outCjk = join(dir, 'cjk-sheet.png');
    writeFileSync(inCjk, JSON.stringify({
      title: '1688 搜索页中文长标题防溢出回归',
      offers: [{
        offer_id: '795289482960', price_cny: 38.5, price_cny_max: 45.5, moq: 100,
        title: '实木微缩模型颜料架98孔工作台桌面收纳架带抽屉亚马逊跨境热销工厂直销批发',
        factory_badge: '超级工厂·实力商家', province: '山东菏泽曹县',
      }],
    }), 'utf8');
    const cjkRes = spawnSync(process.execPath, [CLI_PATH, 'contact-sheet', '--input', inCjk, '--output', outCjk, '--mode', '1688', '--offline'], { encoding: 'utf8' });
    assert.equal(cjkRes.status, 0, cjkRes.stderr);
    const cjkOut = JSON.parse(cjkRes.stdout);
    assert.equal(cjkOut.rendered.mode, '1688');
    assert.equal(cjkOut.rendered.items_rendered, 1);
    assert.equal(cjkOut.rendered.rows[0].rendered_price_label, '¥38.50-¥45.50');
  });
});

function buildMultiSkuCandidate({
  id = 'cand-kit-synth',
  skuLines,
  samplePending = false,
  seasonal = false,
  topLevelFactoryId = undefined,
}) {
  const cand = structuredClone(synthBatch.candidates[0]);
  cand.id = id;
  cand.label = `Synthetic Kit (${id})`;
  const evId = cand.evidence[0].id;
  const sc = cand.economics.scenarios[0];
  sc.id = 'sc-kit-50pct';
  sc.cost_ledger.id = sc.id;
  sc.cost_ledger.price_usd = 50.00;
  sc.cost_ledger.fx_cny_per_usd = 7.2;
  if (topLevelFactoryId !== undefined) {
    sc.factory_id = topLevelFactoryId;
    sc.cost_ledger.factory_id = topLevelFactoryId;
  }
  cand.screening.reference_price_usd.value = 50.00;
  cand.screening.reference_price_usd.supported_price_range = [45.00, 55.00];

  const totalGoodsCny = skuLines.reduce((sum, l) => sum + l.ordered_qty * l.unit_price_cny, 0);
  const procUsd = Number((totalGoodsCny / (100 * 7.2)).toFixed(10));
  const procLine = sc.cost_ledger.lines.find(l => l.id === 'procurement');
  procLine.amount_usd = procUsd;
  procLine.order_units = 100;
  procLine.first_order_promotion = false;
  procLine.fx_cny_per_usd = 7.2;
  procLine.sku_lines = structuredClone(skuLines);

  sc.cost_ledger.cost_basis = 'bare_goods_1688';
  sc.cost_ledger.bare_goods_screening = true;
  const domLine = sc.cost_ledger.lines.find(l => l.id === 'domestic_freight');
  domLine.status = 'not_applicable';
  domLine.amount_usd = 0;
  domLine.bare_goods_screening = true;
  delete domLine.order_units;
  delete domLine.first_order_promotion;

  sc.cost_ledger.fee_context.sales = { from: '2027-02-01', through: '2027-10-14' };
  sc.cost_ledger.fee_context.storage = { from: '2027-02-01', through: '2027-09-30' };
  sc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
  for (const l of sc.cost_ledger.lines) {
    if (l.fee_basis) {
      if (l.id === 'fulfillment' || l.id === 'referral' || l.id === 'returns_processing') {
        l.fee_basis.effective_from = '2027-02-01';
        l.fee_basis.effective_through = '2027-10-14';
        if (l.id === 'fulfillment') l.fee_basis.price_band = '10_to_50';
      } else if (l.id === 'storage') {
        l.fee_basis.effective_from = '2027-02-01';
        l.fee_basis.effective_through = '2027-09-30';
        l.fee_basis.months = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      } else if (l.id === 'placement') {
        l.fee_basis.effective_from = '2027-01-01';
        l.fee_basis.effective_through = '2027-12-31';
      }
    }
  }
  const headLine = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
  headLine.amount_usd = 2.00;
  headLine.components = ['ocean_freight', 'carrier_bond'];
  delete headLine.cny_derivation;
  const placeLine = sc.cost_ledger.lines.find(l => l.id === 'placement');
  placeLine.amount_usd = 0;
  placeLine.status = 'not_applicable';
  placeLine.fee_basis = {
    ...placeLine.fee_basis,
    split_option: 'amazon_optimized',
    steady_state_replenishment: true,
    multi_destination_headhaul_verified: true,
  };
  sc.cost_ledger.steady_state_replenishment = true;
  sc.cost_ledger.multi_destination_headhaul_verified = true;

  delete sc.margin;
  delete sc.contribution_usd;
  cand.economics.expected_primary_scenarios = [{ id: sc.id, status: 'active' }];

  if (samplePending) {
    cand.judgments.existing_solution_fit = {
      anchor: null,
      complete_set_verified: true,
      sample_check_required: true,
      reason: '1688 现货齐套已核实，细节公差待拿样核验',
      evidence: [evId],
    };
  }

  if (seasonal) {
    cand.product_seasonality = 'seasonal';
    const peakSc = structuredClone(sc);
    peakSc.id = 'sc-kit-peak-unpub';
    peakSc.cost_ledger.id = peakSc.id;
    peakSc.cost_ledger.fee_context.sales = { from: '2027-10-15', through: '2028-01-14' };
    peakSc.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
    peakSc.cost_ledger.fee_context.inbound = { from: '2027-09-15', through: '2027-12-31' };
    const pkgRef = peakSc.cost_ledger.fee_context.package_ref;
    for (const l of peakSc.cost_ledger.lines) {
      if (l.fee_basis && (l.id === 'referral' || l.id === 'returns_processing' || l.id === 'other_applicable')) {
        l.fee_basis.effective_from = '2027-02-01';
        l.fee_basis.effective_through = '2028-01-14';
      }
    }
    const peakFul = peakSc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    peakFul.status = 'pending';
    peakFul.amount_usd = null;
    peakFul.fee_basis = {
      status: 'unavailable',
      version: 'US-FBA-2027-Q4-UNPUBLISHED',
      marketplace: 'US',
      currency: 'USD',
      package_ref: pkgRef,
      year: 2027,
      evidence: [evId],
      note: '待亚马逊公布 2027 旺季费率后补充',
    };
    const peakCol = peakSc.cost_ledger.lines.find(l => l.id === 'collection');
    if (peakCol) {
      peakCol.status = 'pending';
      peakCol.amount_usd = null;
    }
    const peakStor = peakSc.cost_ledger.lines.find(l => l.id === 'storage');
    peakStor.amount_usd = Number((peakStor.amount_usd * (2.40 / 0.78)).toFixed(4));
    if (peakStor.rate_usd_per_cuft_month !== undefined) peakStor.rate_usd_per_cuft_month = 2.40;
    if (peakStor.fee_basis) {
      peakStor.fee_basis.effective_from = '2027-10-01';
      peakStor.fee_basis.effective_through = '2027-12-31';
      peakStor.fee_basis.months = [10, 11, 12];
      if (peakStor.fee_basis.rate_usd_per_cuft_month !== undefined) peakStor.fee_basis.rate_usd_per_cuft_month = 2.40;
    }
    const offSc = cand.economics.scenarios[0];
    delete cand.economics.scenarios;
    delete cand.economics.expected_primary_scenarios;
    cand.economics.operating_periods = [
      {
        id: 'off_peak',
        label: '2027 淡季（2–10月）',
        months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        expected_primary_scenarios: [{ id: offSc.id, status: 'active' }],
        scenarios: [offSc],
      },
      {
        id: 'peak',
        label: '2027 旺季（10–12月）',
        months: [10, 11, 12],
        expected_primary_scenarios: [{ id: peakSc.id, status: 'active' }],
        scenarios: [peakSc],
      },
    ];
  }
  return cand;
}

test('Issue #6: unified single-factory complete-kit adjudication across store, scoreBatch (complete & sample_pending_qualifying & seasonal), and report with order-invariance', () => {
  const rackA = {
    component_id: 'rack',
    offer_id: 'off-rack-a',
    sku_id: 'sku-rack',
    factory_id: 'A',
    qty_per_saleable_set: 1,
    pack_multiple: 1,
    moq_qty: 100,
    ordered_qty: 100,
    unit_price_cny: 42,
    regular_goods_promo_false: true,
  };
  const bagA = {
    component_id: 'bag',
    offer_id: 'off-bag-a',
    sku_id: 'sku-bag',
    factory_id: 'A',
    qty_per_saleable_set: 1,
    pack_multiple: 1,
    moq_qty: 100,
    ordered_qty: 100,
    unit_price_cny: 18,
    regular_goods_promo_false: true,
  };
  const bagB = {
    ...bagA,
    offer_id: 'off-bag-b',
    factory_id: 'B',
  };

  const sameAB = evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, bagA] });
  const sameBA = evaluateSingleFactoryCompleteKit({ sku_lines: [bagA, rackA] });
  assert.equal(sameAB.is_single_factory_complete_kit, true);
  assert.equal(sameAB.status, 'single_factory_complete_kit');
  assert.deepEqual(sameAB, sameBA, 'Same-factory helper verdict must be order-invariant');

  const crossAB = evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, bagB] });
  const crossBA = evaluateSingleFactoryCompleteKit({ sku_lines: [bagB, rackA] });
  assert.equal(crossAB.is_single_factory_complete_kit, false);
  assert.equal(crossAB.status, 'incomplete_cross_factory_kit');
  assert.deepEqual(crossAB.distinct_factory_ids, ['a', 'b']);
  assert.deepEqual(crossAB, crossBA, 'Cross-factory helper verdict must be order-invariant');

  assert.equal(
    evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, { ...bagA, factory_id: 'a' }] }).status,
    'single_factory_complete_kit',
  );
  assert.equal(
    evaluateSingleFactoryCompleteKit({ factory_id: 'A', sku_lines: [bagB] }).status,
    'incomplete_cross_factory_kit',
  );
  const bagNoFac = { ...bagA };
  delete bagNoFac.factory_id;
  assert.equal(
    evaluateSingleFactoryCompleteKit({ sku_lines: [rackA, bagNoFac] }).status,
    'incomplete_cross_factory_kit',
  );

  // 1) Store adjudication parity
  const store = openSelectionStore(':memory:');
  try {
    store.upsertCandidateForm({
      form_id: 'form-issue6-kit',
      product_family_key: 'issue6-kit',
      label: 'Issue 6 Synthetic Rack + Bag Kit',
      buyer_task: 'Store desktop rack with carrying bag',
      saleable_set_composition: [
        { component_id: 'rack', qty_per_saleable_set: 1 },
        { component_id: 'bag', qty_per_saleable_set: 1 },
      ],
    });
    const baseQuoteFields = {
      form_id: 'form-issue6-kit',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-kit-1',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg: { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 },
      ui_readback: DEFAULT_R59_UI_READBACK,
      goods_cny_total: 6000,
      domestic_freight_cny_total: null,
    };
    const qSame = store.recordSourcingQuote1688({
      ...baseQuoteFields,
      quote_id: 'q-same-a',
      sku_lines: [rackA, bagA],
    }).quote;
    assert.equal(qSame.quote_status, 'verified');
    assert.equal(qSame.factory_id, 'A');

    const qCross = store.recordSourcingQuote1688({
      ...baseQuoteFields,
      quote_id: 'q-cross-ab',
      sku_lines: [rackA, bagB],
    }).quote;
    assert.equal(qCross.quote_status, 'incomplete_cross_factory_kit');
    assert.equal(qCross.factory_id, null);
    assert.match(qCross.kit_note, /单一工厂/);
  } finally {
    store.close();
  }

  // 2) Standalone scoreBatch: same-factory multi-SKU qualifies cleanly and is order-invariant
  const sameCand1 = buildMultiSkuCandidate({ id: 'cand-same-1', skuLines: [rackA, bagA] });
  const sameCand2 = buildMultiSkuCandidate({ id: 'cand-same-1', skuLines: [bagA, rackA] });
  const resSame1 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameCand1] }, r59Profile);
  const resSame2 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameCand2] }, r59Profile);
  const cSame1 = resSame1.candidates[0];
  const cSame2 = resSame2.candidates[0];
  assert.equal(cSame1.queue, 'comparable');
  assert.equal(cSame1.qualification.counts_toward_target, true);
  assert.equal(cSame1.qualification.mode, 'comparable');
  assert.ok(cSame1.diagnostics.economics.margin_range[0] >= 0.45, 'Expected ~50% margin on synthetic kit');
  assert.deepEqual(cSame1.qualification, cSame2.qualification);
  assert.deepEqual(cSame1.total_range, cSame2.total_range);
  assert.deepEqual(cSame1.core_85_range, cSame2.core_85_range);
  assert.deepEqual(cSame1.diagnostics.economics.margin_range, cSame2.diagnostics.economics.margin_range);
  assert.deepEqual(
    cSame1.diagnostics.economics.scenarios[0].single_factory_complete_kit,
    cSame2.diagnostics.economics.scenarios[0].single_factory_complete_kit,
  );

  const sameSample1 = buildMultiSkuCandidate({ id: 'cand-same-sp', skuLines: [rackA, bagA], samplePending: true });
  const sameSample2 = buildMultiSkuCandidate({ id: 'cand-same-sp', skuLines: [bagA, rackA], samplePending: true });
  const spSame1 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSample1] }, r59Profile).candidates[0];
  const spSame2 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSample2] }, r59Profile).candidates[0];
  assert.equal(spSame1.qualification.counts_toward_target, true);
  assert.equal(spSame1.qualification.mode, 'sample_pending_qualifying');
  assert.deepEqual(spSame1.qualification, spSame2.qualification);
  assert.deepEqual(spSame1.core_85_range, spSame2.core_85_range);

  // 3) Standalone scoreBatch: cross-factory kit preserves scenario but NEVER counts toward target
  const crossCand1 = buildMultiSkuCandidate({ id: 'cand-cross-full', skuLines: [rackA, bagB] });
  const crossCand2 = buildMultiSkuCandidate({ id: 'cand-cross-full', skuLines: [bagB, rackA] });
  const resCross1 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossCand1] }, r59Profile);
  const resCross2 = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossCand2] }, r59Profile);
  const cCross1 = resCross1.candidates[0];
  const cCross2 = resCross2.candidates[0];

  assert.equal(cCross1.diagnostics.economics.scenarios.length, 1, 'Cross-factory procurement scenario must be preserved for inspection');
  assert.equal(cCross1.diagnostics.economics.scenarios[0].single_factory_complete_kit.status, 'incomplete_cross_factory_kit');
  assert.deepEqual(cCross1.diagnostics.economics.scenarios[0].single_factory_complete_kit.distinct_factory_ids, ['a', 'b']);
  assert.equal(cCross1.queue, 'pending', 'Cross-factory kit must NEVER return comparable');
  assert.equal(cCross1.qualification.counts_toward_target, false, 'Cross-factory kit must return counts_toward_target: false');
  assert.equal(resCross1.summary.qualifying, 0);
  assert.deepEqual(cCross1.qualification, cCross2.qualification, 'Cross-factory qualification must be order-invariant');
  assert.deepEqual(
    cCross1.diagnostics.economics.scenarios[0].single_factory_complete_kit,
    cCross2.diagnostics.economics.scenarios[0].single_factory_complete_kit,
  );

  const crossSample = buildMultiSkuCandidate({ id: 'cand-cross-sp', skuLines: [rackA, bagB], samplePending: true });
  const cCrossSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossSample] }, r59Profile).candidates[0];
  assert.equal(cCrossSp.diagnostics.economics.scenarios.length, 1, 'Scenario preserved in sample-pending cross-factory mode');
  assert.equal(cCrossSp.qualification.counts_toward_target, false, 'Cross-factory kit must NEVER qualify via sample_pending_qualifying');
  assert.notEqual(cCrossSp.qualification.mode, 'sample_pending_qualifying');

  const sameSeasFull = buildMultiSkuCandidate({ id: 'cand-same-seas-full', skuLines: [rackA, bagA], seasonal: true });
  const cSameSeasFull = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSeasFull] }, r59Profile).candidates[0];
  assert.equal(cSameSeasFull.qualification.counts_toward_target, true);
  assert.equal(cSameSeasFull.qualification.mode, 'seasonal_eligible');

  const sameSeasSp = buildMultiSkuCandidate({ id: 'cand-same-seas-sp', skuLines: [rackA, bagA], seasonal: true, samplePending: true });
  const cSameSeasSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [sameSeasSp] }, r59Profile).candidates[0];
  assert.equal(cSameSeasSp.qualification.counts_toward_target, true);
  assert.equal(cSameSeasSp.qualification.mode, 'seasonal_sample_pending_qualifying');

  const crossSeasFull = buildMultiSkuCandidate({ id: 'cand-cross-seas-full', skuLines: [rackA, bagB], seasonal: true });
  const cCrossSeasFull = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossSeasFull] }, r59Profile).candidates[0];
  assert.equal(cCrossSeasFull.qualification.counts_toward_target, false);
  assert.equal(cCrossSeasFull.operating_periods[0].diagnostics.economics.scenarios.length, 1);

  const crossSeasSp = buildMultiSkuCandidate({ id: 'cand-cross-seas-sp', skuLines: [rackA, bagB], seasonal: true, samplePending: true });
  const cCrossSeasSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [crossSeasSp] }, r59Profile).candidates[0];
  assert.equal(cCrossSeasSp.qualification.counts_toward_target, false);

  const peakBareFull = buildMultiSkuCandidate({ id: 'cand-peak-bare-full', skuLines: [rackA, bagA], seasonal: true });
  peakBareFull.economics.operating_periods[1].scenarios[0].bare_part_only = true;
  const cPeakBareFull = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [peakBareFull] }, r59Profile).candidates[0];
  assert.equal(cPeakBareFull.qualification.counts_toward_target, false);

  const peakBareSp = buildMultiSkuCandidate({ id: 'cand-peak-bare-sp', skuLines: [rackA, bagA], seasonal: true, samplePending: true });
  peakBareSp.economics.operating_periods[1].scenarios[0].bare_part_only = true;
  const cPeakBareSp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [peakBareSp] }, r59Profile).candidates[0];
  assert.equal(cPeakBareSp.qualification.counts_toward_target, false);

  const directCalc = calculateEconomics(crossCand1.economics.scenarios[0].cost_ledger);
  assert.equal(directCalc.scoring_supported, false);
  assert.equal(directCalc.single_factory_complete_kit.status, 'incomplete_cross_factory_kit');

  // 4) Report preserves the procurement scenario, renders cross-factory count ONLY, and reports 0 qualifying
  const piiCrossCand = buildMultiSkuCandidate({
    id: 'cand-cross-pii-safe',
    skuLines: [
      { ...rackA, factory_id: undefined, seller_member_id: 'factory-alpha-secret-token' },
      { ...bagB, factory_id: undefined, seller_member_id: 'factory-beta-secret-token' },
    ],
  });
  const resPiiCross = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [piiCrossCand] }, r59Profile);
  const html = renderReport(resPiiCross, { schema_version: 1, profile_revision: 59, candidates: [piiCrossCand] });
  assert.match(html, /单件利润与费用拆解/, 'Report must still render the preserved procurement scenario waterfall');
  assert.match(html, /检测到 2 家不同工厂拼套/, 'Report must show safe count of distinct factories');
  assert.doesNotMatch(html, /factory-alpha-secret-token|factory-beta-secret-token/, 'Report must NEVER leak raw factory/seller identifiers into shareable HTML');
  assert.doesNotMatch(html, /完整可比 1|入围 1/);
});

test('Stage 3A: r59 crosses_30pct never auto-sets owner_crossing_override:true and requires explicit allow_crossing_to_gate2_3:true before Gate 2/3 spend', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const cuFt = (12 * 8 * 4) / 1728;
    const baseSc = {
      id: 'sc-cross-44',
      price_usd: 44.00,
      available_date: '2025-05-01',
      pkg,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 2.0,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    store.upsertCandidateForm({
      form_id: 'form-cross-auth',
      product_family_key: 'cross-auth',
      label: 'Crossing 30pct Auth Guard',
      buyer_task: 'Organize modular tools',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1a = runGate1AForForm(store, { form_id: 'form-cross-auth', scenarios: [baseSc] });
    assert.equal(g1a.proceed_to_gate1b, true);

    const mkQuote = (qid, facId, cny) => store.recordSourcingQuote1688({
      quote_id: qid,
      form_id: 'form-cross-auth',
      factory_id: facId,
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: `off-${qid}`, sku_id: `sku-${qid}`, factory_id: facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: cny, regular_goods_promo_false: true }],
      goods_cny_total: cny * 100,
      domestic_freight_cny_total: null,
    }).quote;

    const qWin = mkQuote('q-cross-win', 'fac-win', 35);
    const qLose = mkQuote('q-cross-lose', 'fac-lose', 130);
    const decl = g1a.declared_scenarios[0];
    const esBuilder = () => ({
      profile_revision: 59,
      id: decl.id,
      saleable_unit: '1 unit',
      price_usd: decl.price_usd,
      fx_cny_per_usd: decl.fx_cny_per_usd,
      pkg,
      headhaul: { usd_per_unit: decl.headhaul_usd, bond_included: true },
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: baseSc.referral_terms,
      fulfillment_usd: decl.fulfillment_usd,
      placement_usd: decl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    });

    const g1bNoAuth = await runGate1BForForm(store, {
      form_id: 'form-cross-auth',
      existing_quotes: [qWin, qLose],
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: esBuilder,
    });
    assert.equal(g1bNoAuth.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bNoAuth.owner_crossing_override, false, 'Must NEVER auto-set owner_crossing_override: true');
    assert.equal(g1bNoAuth.owner_review_required, true, 'Crossing interval must require explicit owner review');
    assert.equal(g1bNoAuth.proceed_to_gate2_3, false, 'Crossing interval must stop before Gate 2/3 spend without explicit owner auth');

    const storedG1b = JSON.parse(store.getCandidateForm('form-cross-auth').gate1b_result_json);
    assert.equal(storedG1b.owner_crossing_override, false);

    let deepCalls = 0;
    const batchNoAuth = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-26',
      items: [{
        form: {
          form_id: 'form-cross-auth',
          product_family_key: 'cross-auth',
          label: 'Crossing 30pct Auth Guard',
          buyer_task: 'Organize modular tools',
          saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
        },
        leads: [{
          lead_id: 'lead-cross-auth',
          phrase_or_title: 'modular tool organizer',
          source_channel: 'keyword_research',
          source_ref: 'https://www.sellersprite.com/cross-auth',
          observed_at: '2026-11-26',
          disposition: 'product',
          link_role: 'primary_discovery',
        }],
        gate1a_scenarios: [baseSc],
        existing_quotes: [qWin, qLose],
        early_screen_builder: esBuilder,
        deep_research_executor: async () => {
          deepCalls += 1;
          return { batch: { schema_version: 1, profile_revision: 59, candidates: [] } };
        },
      }],
    });
    assert.equal(batchNoAuth.gate1b[0].owner_crossing_override, false);
    assert.equal(batchNoAuth.gate1b[0].proceed_to_gate2_3, false);
    assert.equal(deepCalls, 0, 'Gate 2/3 deep_research_executor must NOT run without explicit allow_crossing_to_gate2_3: true');

    const g1bAuth = await runGate1BForForm(store, {
      form_id: 'form-cross-auth',
      existing_quotes: [qWin, qLose],
      allow_crossing_to_gate2_3: true,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: esBuilder,
    });
    assert.equal(g1bAuth.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bAuth.owner_crossing_override, true);
    assert.equal(g1bAuth.proceed_to_gate2_3, true);
  } finally {
    store.close();
  }
});

test('Stage 3A: empty historical factory_id is never miscounted via quote_id, AI 1-3 factory cap holds, and manual_owner_entry:true allows 4th+ complete-kit factories', async () => {
  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const cuFt = (12 * 8 * 4) / 1728;
    const baseSc = {
      id: 'sc-cap-44',
      price_usd: 44.00,
      available_date: '2025-05-01',
      pkg,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 2.0,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };

    store.upsertCandidateForm({
      form_id: 'form-hist-empty-fac',
      product_family_key: 'hist-empty-fac',
      label: 'Historical Empty Factory ID Test',
      buyer_task: 'Hold accessories',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aHist = runGate1AForForm(store, { form_id: 'form-hist-empty-fac', scenarios: [baseSc] });
    const declHist = g1aHist.declared_scenarios[0];
    const mkHistNoFac = (qid, offerId, cny) => store.recordSourcingQuote1688({
      quote_id: qid,
      form_id: 'form-hist-empty-fac',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: offerId, sku_id: `sku-${qid}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: cny, regular_goods_promo_false: true }],
      goods_cny_total: cny * 100,
      domestic_freight_cny_total: null,
    }).quote;
    const h1 = mkHistNoFac('q-hist-1', 'off-h1', 35);
    const h2 = mkHistNoFac('q-hist-2', 'off-h2', 128);
    const h3 = mkHistNoFac('q-hist-3', 'off-h3', 132);
    assert.equal(h1.factory_id, null);

    const g1bHistCross = await runGate1BForForm(store, {
      form_id: 'form-hist-empty-fac',
      existing_quotes: [h1, h2, h3],
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: () => ({
        profile_revision: 59,
        id: declHist.id,
        saleable_unit: '1 unit',
        price_usd: declHist.price_usd,
        fx_cny_per_usd: declHist.fx_cny_per_usd,
        pkg,
        headhaul: { usd_per_unit: declHist.headhaul_usd, bond_included: true },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: baseSc.referral_terms,
        fulfillment_usd: declHist.fulfillment_usd,
        placement_usd: declHist.placement_range_usd[1],
        storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
        collection_rate: 0.005,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      }),
    });
    assert.equal(g1bHistCross.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bHistCross.checked_factory_quotes_count, 0, 'Historical quotes without factory_id must NOT be miscounted via quote_id/offer_id');
    assert.equal(g1bHistCross.second_factory_quote_needed, true);

    const threePriceCand = structuredClone(synthBatch.candidates[0]);
    threePriceCand.id = 'cand-3-sc-no-fac';
    const baseScScoring = structuredClone(threePriceCand.economics.scenarios[0]);
    delete baseScScoring.margin;
    delete baseScScoring.contribution_usd;
    baseScScoring.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 21.0;
    const sA = structuredClone(baseScScoring); sA.id = sA.cost_ledger.id = 'sc-1'; sA.quote_id = 'q-1';
    const sB = structuredClone(baseScScoring); sB.id = sB.cost_ledger.id = 'sc-2'; sB.quote_id = 'q-2';
    const sC = structuredClone(baseScScoring); sC.id = sC.cost_ledger.id = 'sc-3'; sC.quote_id = 'q-3';
    threePriceCand.economics.scenarios = [sA, sB, sC];
    threePriceCand.economics.expected_primary_scenarios = [
      { id: 'sc-1', status: 'active' },
      { id: 'sc-2', status: 'active' },
      { id: 'sc-3', status: 'active' },
    ];
    const scoredNoFac = scoreCandidate(threePriceCand, r59Profile);
    assert.equal(scoredNoFac.diagnostics.economics.second_factory_quote_needed, true, '3 scenarios without factory_id must NOT count as 3 checked factories');

    store.upsertCandidateForm({
      form_id: 'form-manual-4th',
      product_family_key: 'manual-4th',
      label: 'Manual Owner 4th Factory Override Test',
      buyer_task: 'Hold hardware parts',
      saleable_set_composition: [
        { component_id: 'rack', qty_per_saleable_set: 1 },
        { component_id: 'bag', qty_per_saleable_set: 1 },
      ],
    });
    const mkKitQuote = (qid, facId, rackCny, bagCny, extra = {}) => ({
      quote_id: qid,
      form_id: 'form-manual-4th',
      factory_id: facId,
      spec_variant_key: 'std-kit-v1',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [
        { component_id: 'rack', offer_id: `off-r-${qid}`, sku_id: `sr-${qid}`, factory_id: facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: rackCny, regular_goods_promo_false: true },
        { component_id: 'bag', offer_id: `off-b-${qid}`, sku_id: `sb-${qid}`, factory_id: extra.bagFactoryId ?? facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: bagCny, regular_goods_promo_false: true },
      ],
      goods_cny_total: (rackCny + bagCny) * 100,
      domestic_freight_cny_total: null,
      ...extra,
    });

    store.recordSourcingQuote1688(mkKitQuote('q-rej', 'fac-rej', 20, 10, { quote_status: 'rejected_spec' }));
    store.recordSourcingQuote1688(mkKitQuote('q-xkit', 'fac-x1', 20, 10, { bagFactoryId: 'fac-x2' }));
    store.recordSourcingQuote1688(mkKitQuote('q-ai-1', 'fac-1', 100, 30));
    store.recordSourcingQuote1688(mkKitQuote('q-ai-2', 'fac-2', 95, 25));
    store.recordSourcingQuote1688(mkKitQuote('q-ai-3', 'fac-3', 90, 20));

    assert.throws(
      () => store.recordSourcingQuote1688(mkKitQuote('q-ai-4-blocked', 'fac-4', 60, 15)),
      /caps distinct verified factories at 3/i,
    );

    const qOwner4 = store.recordSourcingQuote1688(
      mkKitQuote('q-owner-4', 'fac-4', 45, 10, { manual_owner_entry: true }),
    ).quote;
    assert.equal(qOwner4.quote_status, 'verified');
    assert.equal(qOwner4.manual_owner_entry, true);
    assert.equal(store.getQuoteById('q-ai-3').quote_status, 'superseded_uncompetitive');

    assert.throws(
      () => store.recordSourcingQuote1688(mkKitQuote('q-ai-5-blocked', 'fac-5', 40, 10)),
      /caps distinct verified factories at 3/i,
    );

    const qOwner5Cross = store.recordSourcingQuote1688(
      mkKitQuote('q-owner-5-cross', 'fac-5a', 30, 5, { manual_owner_entry: true, bagFactoryId: 'fac-5b' }),
    ).quote;
    assert.equal(qOwner5Cross.quote_status, 'incomplete_cross_factory_kit');

    const qOwner5Batch = store.recordSourcingQuotesBatch1688([
      mkKitQuote('q-owner-5-ok', 'fac-5', 40, 10, { manual_owner_entry: true }),
    ]);
    assert.equal(qOwner5Batch[0].quote.quote_status, 'verified');
    assert.equal(qOwner5Batch[0].quote.manual_owner_entry, true);
  } finally {
    store.close();
  }
});

test('Stage 3A Astra review regressions: identity normalization, conflict/component/fit guards, pending crossing block, iterative quota & manual reopen/ui_readback/email PII guard', async () => {
  const numSame = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 101, qty_per_saleable_set: 1 },
      { component_id: 'bag', factory_id: 101, qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(numSame.is_single_factory_complete_kit, true);
  assert.equal(numSame.resolved_factory_id, '101');

  const numCross = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 101, qty_per_saleable_set: 1 },
      { component_id: 'bag', factory_id: 202, qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(numCross.is_cross_factory_or_incomplete, true);
  assert.deepEqual(numCross.distinct_factory_ids, ['101', '202']);

  const aliasSame = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 'FAC-1', supplier_id: 'SUP-ALIAS-1', qty_per_saleable_set: 1 },
      { component_id: 'bag', factory_id: 'FAC-1', supplier_id: 'SUP-ALIAS-1', qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(aliasSame.is_single_factory_complete_kit, true);
  assert.equal(aliasSame.resolved_factory_id, 'FAC-1');

  const disjointFields = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', factory_id: 'FAC-1', qty_per_saleable_set: 1 },
      { component_id: 'bag', supplier_id: 'SUP-2', qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(disjointFields.is_cross_factory_or_incomplete, true);

  const shopSame = evaluateSingleFactoryCompleteKit({
    sku_lines: [
      { component_id: 'rack', shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=a1', qty_per_saleable_set: 1 },
      { component_id: 'bag', shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=b2', qty_per_saleable_set: 1 },
    ],
  });
  assert.equal(shopSame.is_single_factory_complete_kit, true);
  assert.equal(
    resolveVerifiedFactoryKey({ shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=a1' }),
    resolveVerifiedFactoryKey({ shop_url: 'https://shop123.1688.com/page/offerlist.htm?spm=b2' }),
  );

  const rackA = { component_id: 'rack', offer_id: 'o1', sku_id: 's1', factory_id: 'A', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true };
  const bagA = { component_id: 'bag', offer_id: 'o2', sku_id: 's2', factory_id: 'A', qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 18, regular_goods_promo_false: true };
  const bagB = { ...bagA, factory_id: 'B' };

  const conflictCand = buildMultiSkuCandidate({ id: 'cand-conflict-sku', skuLines: [rackA, bagA] });
  conflictCand.economics.scenarios[0].sku_lines = [rackA, bagB];
  const resConflict = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [conflictCand] }, r59Profile).candidates[0];
  assert.equal(resConflict.qualification.counts_toward_target, false);

  const missingCompCand = buildMultiSkuCandidate({ id: 'cand-missing-comp', skuLines: [rackA] });
  missingCompCand.saleable_set_composition = [
    { component_id: 'rack', qty_per_saleable_set: 1 },
    { component_id: 'bag', qty_per_saleable_set: 1 },
  ];
  const resMissingComp = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [missingCompCand] }, r59Profile).candidates[0];
  assert.equal(resMissingComp.qualification.counts_toward_target, false);

  const fitFalseCand = buildMultiSkuCandidate({ id: 'cand-fit-false', skuLines: [rackA, bagA] });
  fitFalseCand.judgments.existing_solution_fit = {
    ...fitFalseCand.judgments.existing_solution_fit,
    complete_set_verified: false,
  };
  const resFitFalse = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [fitFalseCand] }, r59Profile).candidates[0];
  assert.equal(resFitFalse.qualification.counts_toward_target, false);

  const rejectedSpecCand = buildMultiSkuCandidate({ id: 'cand-rej-spec', skuLines: [rackA, bagA] });
  rejectedSpecCand.economics.scenarios[0].quote_status = 'rejected_spec';
  const resRejSpec = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [rejectedSpecCand] }, r59Profile).candidates[0];
  assert.equal(resRejSpec.qualification.counts_toward_target, false);

  const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
  const cuFt = (12 * 8 * 4) / 1728;
  const bareEarly = evaluateEarlyScreen({
    profile_revision: 59,
    id: 'early-bare-part',
    saleable_unit: '1 kit',
    price_usd: 50.0,
    fx_cny_per_usd: 7.2,
    pkg,
    order_units: 100,
    goods_cny_per_unit: 50,
    bare_goods_screening: true,
    goods_first_order_promotion: false,
    first_order_promotion: false,
    bare_part_only: true,
    headhaul: { usd_per_unit: 2.0, bond_included: true },
    refund_fraction: 0.04,
    physical_return_fraction: 0.04,
    return_threshold: 0.081,
    returns_processing_usd: 0,
    is_apparel_or_shoes: false,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
    fulfillment_usd: 4.5,
    placement_usd: 0,
    storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
    operating_period: 'off_peak',
    operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
    collection_rate: 0.005,
    other_applicable_usd: 0,
    specific_rights_conflict: false,
    strong_date_dependency: false,
  }, { profileRevision: 59 });
  assert.equal(bareEarly.gate_status, 'pending');
  assert.equal(bareEarly.ledger.single_factory_complete_kit.status, 'incomplete_cross_factory_kit');

  const store = openSelectionStore(':memory:');
  try {
    const baseSc = {
      id: 'sc-reg-44',
      price_usd: 44.00,
      available_date: '2025-05-01',
      pkg,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 2.0,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    const mkEsBuilder = (decl, extra = {}) => ({ quote }) => ({
      profile_revision: 59,
      id: decl.id,
      saleable_unit: '1 unit',
      price_usd: decl.price_usd,
      fx_cny_per_usd: decl.fx_cny_per_usd,
      pkg,
      headhaul: { usd_per_unit: decl.headhaul_usd, bond_included: true },
      refund_fraction: 0.04,
      physical_return_fraction: 0.04,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: baseSc.referral_terms,
      fulfillment_usd: decl.fulfillment_usd,
      placement_usd: decl.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
      ...(typeof extra === 'function' ? extra(quote) : extra),
    });

    const mkSingleQ = (formId, qid, facId, cny, extra = {}) => ({
      quote_id: qid,
      form_id: formId,
      factory_id: facId,
      spec_variant_key: 'v1',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: `off-${qid}`, sku_id: `s-${qid}`, factory_id: facId, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: cny, regular_goods_promo_false: true }],
      goods_cny_total: cny * 100,
      domestic_freight_cny_total: null,
      ...extra,
    });

    store.upsertCandidateForm({
      form_id: 'form-reg-a',
      product_family_key: 'reg-a',
      label: 'Regression Form A',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aA = runGate1AForForm(store, { form_id: 'form-reg-a', scenarios: [baseSc] });
    const declA = g1aA.declared_scenarios[0];

    const qRejStored = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-rej', 'f-rej', 20, { quote_status: 'rejected_spec' })).quote;
    assert.equal(qRejStored.quote_status, 'rejected_spec', 'rejected_spec must NOT be overwritten to incomplete_cross_factory_kit');

    assert.throws(
      () => store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-email', 'sales@supplier-example.cn', 40)),
      /email/i,
    );

    store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-1', 'fa-1', 140));
    store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-2', 'fa-2', 135));
    store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-3', 'fa-3', 130));

    const qA2Rev = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-2-rev', 'fa-2', 132)).quote;
    assert.equal(qA2Rev.quote_status, 'superseded_uncompetitive');

    const badManual = mkSingleQ('form-reg-a', 'qa-man-noui', 'fa-4', 35, { manual_owner_entry: true });
    delete badManual.ui_readback;
    assert.throws(() => store.recordSourcingQuote1688(badManual), /ui_readback/i);
    assert.equal(store.getQuoteById('qa-3').quote_status, 'verified', 'Failed manual quote must NOT supersede older verified quote');

    let autoExecCalls = 0;
    const g1bRej = await runGate1BForForm(store, {
      form_id: 'form-reg-a',
      profile_revision: 59,
      as_of_date: '2026-11-26',
      sourcing_executor: async () => { autoExecCalls += 1; return { status: 'no_matched_offer' }; },
      early_screen_builder: mkEsBuilder(declA),
    });
    assert.equal(g1bRej.status, 'gate1b_rejected');
    assert.equal(autoExecCalls, 0, 'Automated sourcing_executor must NOT run when >= 3 distinct verified factories already exist');

    const qMan4 = store.recordSourcingQuote1688(mkSingleQ('form-reg-a', 'qa-man-4', 'fa-4', 35, { manual_owner_entry: true })).quote;
    assert.equal(qMan4.quote_status, 'verified');
    const g1bReopen = await runGate1BForForm(store, {
      form_id: 'form-reg-a',
      existing_quote: qMan4,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: mkEsBuilder(declA),
    });
    assert.equal(g1bReopen.status, 'gate1b_passed');
    assert.equal(g1bReopen.proceed_to_gate2_3, true);

    const g1bMan5 = await runGate1BForForm(store, {
      form_id: 'form-reg-a',
      manual_owner_entry: true,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      sourcing_executor: async () => ({
        status: 'quoted',
        quote: mkSingleQ('form-reg-a', 'qa-man-5', 'fa-5', 32, { manual_owner_entry: true }),
      }),
      early_screen_builder: mkEsBuilder(declA),
    });
    assert.equal(g1bMan5.status, 'gate1b_passed');

    store.upsertCandidateForm({
      form_id: 'form-reg-b',
      product_family_key: 'reg-b',
      label: 'Regression Form B',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aB = runGate1AForForm(store, { form_id: 'form-reg-b', scenarios: [baseSc] });
    const declB = g1aB.declared_scenarios[0];
    let iterCalls = 0;
    const g1bIter = await runGate1BForForm(store, {
      form_id: 'form-reg-b',
      profile_revision: 59,
      as_of_date: '2026-11-26',
      sourcing_executor: async () => {
        iterCalls += 1;
        if (iterCalls === 1) return { status: 'quoted', has_more_factories: true, quote: mkSingleQ('form-reg-b', 'qb-rej1', 'fb-r1', 20, { quote_status: 'rejected_spec' }) };
        if (iterCalls === 2) return { status: 'quoted', has_more_factories: true, quote: mkSingleQ('form-reg-b', 'qb-x1', 'fb-x1', 20, { bare_part_only: true }) };
        if (iterCalls === 3) return { status: 'quoted', has_more_factories: true, quote: mkSingleQ('form-reg-b', 'qb-f1', 'fb-1', 140) };
        if (iterCalls === 4) {
          return {
            status: 'quoted',
            has_more_factories: true,
            quotes: [
              mkSingleQ('form-reg-b', 'qb-rej2', 'fb-r2', 20, { quote_status: 'rejected_spec' }),
              mkSingleQ('form-reg-b', 'qb-f2', 'fb-2', 35),
            ],
          };
        }
        return { status: 'quoted', has_more_factories: false, quote: mkSingleQ('form-reg-b', 'qb-f3', 'fb-3', 30) };
      },
      early_screen_builder: mkEsBuilder(declB),
    });
    assert.equal(iterCalls, 4, 'Iterative loop must skip non-quota rejected/incomplete rows AND stop immediately once mixed batch passing factory clears >= 30%');
    assert.equal(g1bIter.status, 'gate1b_passed');

    store.upsertCandidateForm({
      form_id: 'form-reg-c',
      product_family_key: 'reg-c',
      label: 'Regression Form C',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aC = runGate1AForForm(store, { form_id: 'form-reg-c', scenarios: [baseSc] });
    const declC = g1aC.declared_scenarios[0];
    const qC1 = store.recordSourcingQuote1688(mkSingleQ('form-reg-c', 'qc-pass', 'fc-1', 35, { spec_variant_key: null, keep_parallel_spec: true })).quote;
    const qC2 = store.recordSourcingQuote1688(mkSingleQ('form-reg-c', 'qc-fail', 'fc-2', 135, { spec_variant_key: null, keep_parallel_spec: true })).quote;
    const qC3 = store.recordSourcingQuote1688(mkSingleQ('form-reg-c', 'qc-pend', 'fc-3', 45, { spec_variant_key: null, keep_parallel_spec: true })).quote;
    const g1bPendCross = await runGate1BForForm(store, {
      form_id: 'form-reg-c',
      existing_quotes: [qC1, qC2, qC3],
      allow_crossing_to_gate2_3: true,
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: mkEsBuilder(declC, q => (q.quote_id === 'qc-pend' ? { headhaul: null } : {})),
    });
    assert.equal(g1bPendCross.margin_interval_verdict, 'crosses_30pct');
    assert.equal(g1bPendCross.owner_crossing_override, false, 'Pending 3rd active quote must block owner_crossing_override');
    assert.equal(g1bPendCross.proceed_to_gate2_3, false, 'Pending 3rd active quote must block proceed_to_gate2_3 even with allow_crossing_to_gate2_3: true');

    store.db.prepare('UPDATE sourcing_quotes_1688 SET factory_id = ? WHERE quote_id = ?').run('fc-mismatch', 'qc-pass');
    const g1bLegacy = await runGate1BForForm(store, {
      form_id: 'form-reg-c',
      existing_quote: { quote_id: 'qc-pass' },
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: mkEsBuilder(declC),
    });
    assert.equal(g1bLegacy.status, 'gate1b_pending');
    assert.equal(g1bLegacy.proceed_to_gate2_3, false);
  } finally {
    store.close();
  }
});

test('Stage 3A independent audit hardening: evergreen Q4 peak missing kit component, embedded email PII in factory/company fields, and manual_owner_entry forwarding via runPhase2Batch & CLI gate1b', async () => {
  const rackA = {
    component_id: 'rack', offer_id: 'off-r1', sku_id: 'sku-r1', factory_id: 'FAC-EVG-A',
    qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true,
  };
  const bagA = {
    component_id: 'bag', offer_id: 'off-b1', sku_id: 'sku-b1', factory_id: 'FAC-EVG-A',
    qty_per_saleable_set: 1, pack_multiple: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 18, regular_goods_promo_false: true,
  };
  const evgMissingPeakComp = buildMultiSkuCandidate({ id: 'cand-evg-peak-missing-bag', skuLines: [rackA, bagA], seasonal: true });
  evgMissingPeakComp.product_seasonality = 'evergreen';
  evgMissingPeakComp.saleable_set_composition = [
    { component_id: 'rack', qty_per_saleable_set: 1 },
    { component_id: 'bag', qty_per_saleable_set: 1 },
  ];
  const peakPeriod = evgMissingPeakComp.economics.operating_periods.find(p => p.id === 'peak');
  const peakProc = peakPeriod.scenarios[0].cost_ledger.lines.find(l => l.id === 'procurement');
  peakProc.sku_lines = [rackA];
  peakProc.amount_usd = Number(((42 * 100) / (100 * 7.2)).toFixed(10));
  const evgRes = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [evgMissingPeakComp] }, r59Profile).candidates[0];
  assert.equal(evgRes.qualification.counts_toward_target, false, 'Evergreen Q4 companion peak omitting a required kit component must NEVER unwrap or qualify');

  const store = openSelectionStore(':memory:');
  try {
    store.upsertCandidateForm({
      form_id: 'form-embed-email',
      product_family_key: 'embed-email',
      label: 'Embedded Email PII Form',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const baseQuote = extra => ({
      quote_id: `q-em-${Math.random().toString(36).slice(2, 8)}`,
      form_id: 'form-embed-email',
      observed_at: '2026-11-26',
      redacted_destination: '广东深圳',
      raw_readback_ref: 'ev-em',
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{
        component_id: 'unit', offer_id: 'off-1', sku_id: 'sku-1', pack_multiple: 1,
        qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 35, regular_goods_promo_false: true,
      }],
      goods_cny_total: 3500,
      ...extra,
    });
    assert.throws(
      () => store.recordSourcingQuote1688(baseQuote({ factory_id: 'Caoxian Mill (sales@example.com)' })),
      /email/i,
      'Embedded email inside factory_id must be rejected',
    );
    assert.throws(
      () => store.recordSourcingQuote1688(baseQuote({ company_name: 'Wood Workshop contact@factory.cn' })),
      /email/i,
      'Embedded email inside company_name must be rejected',
    );

    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const cuFt = Number(((pkg.length_in * pkg.width_in * pkg.height_in) / 1728).toFixed(6));
    const baseSc = {
      id: 'sc-batch-man',
      price_usd: 45,
      available_date: '2025-05-01',
      pkg,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.05,
      physical_return_fraction: 0.05,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 1.8,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    const formSpecM = {
      form_id: 'form-batch-man4',
      product_family_key: 'batch-man4',
      label: 'Batch Manual 4th Factory Form',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    };
    store.upsertCandidateForm(formSpecM);
    const g1aM = runGate1AForForm(store, { form_id: 'form-batch-man4', scenarios: [baseSc] });
    const declM = g1aM.declared_scenarios[0];
    const mkFailQ = (qid, fid, priceCny) => ({
      quote_id: qid,
      form_id: 'form-batch-man4',
      factory_id: fid,
      spec_variant_key: 'std-v1',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{
        component_id: 'unit', offer_id: `off-${qid}`, sku_id: `sku-${qid}`, factory_id: fid,
        pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100,
        unit_price_cny: priceCny, regular_goods_promo_false: true,
      }],
      goods_cny_total: priceCny * 100,
      domestic_freight_cny_total: null,
    });
    const esBuilderM = () => ({
      profile_revision: 59,
      id: declM.id,
      saleable_unit: '1 unit',
      price_usd: declM.price_usd,
      fx_cny_per_usd: declM.fx_cny_per_usd,
      pkg,
      headhaul: { usd_per_unit: declM.headhaul_usd, bond_included: true },
      refund_fraction: 0.05,
      physical_return_fraction: 0.05,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: baseSc.referral_terms,
      fulfillment_usd: declM.fulfillment_usd,
      placement_usd: declM.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    });
    store.recordSourcingQuotesBatch1688([
      mkFailQ('qm-1', 'fm-1', 150),
      mkFailQ('qm-2', 'fm-2', 148),
      mkFailQ('qm-3', 'fm-3', 145),
    ]);
    const rej3 = await runGate1BForForm(store, {
      form_id: 'form-batch-man4',
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: esBuilderM,
    });
    assert.equal(rej3.status, 'gate1b_rejected');
    assert.equal(rej3.second_factory_quote_needed, false);

    let batchManCalls = 0;
    const batchOut = await runPhase2Batch(store, {
      profile: r59Profile,
      as_of_date: '2026-11-26',
      items: [{
        form: formSpecM,
        gate1a_scenarios: [baseSc],
        manual_owner_entry: true,
        sourcing_executor: async () => {
          batchManCalls += 1;
          return {
            status: 'quoted',
            quote: { ...mkFailQ('qm-4-manual', 'fm-4-owner', 35), manual_owner_entry: true },
          };
        },
        early_screen_builder: esBuilderM,
      }],
    });
    assert.equal(batchManCalls, 1, 'runPhase2Batch must forward manual_owner_entry: true and dispatch manual 4th factory');
    assert.equal(batchOut.gate1b[0].status, 'gate1b_passed');
  } finally {
    store.close();
  }

  await withTempDirAsync('stage3a-cli-man4-', async tmpDir => {
    const dbPath = join(tmpDir, 'sel.sqlite');
    const cliStore = openSelectionStore(dbPath);
    const pkg = { length_in: 12, width_in: 8, height_in: 4, unit_weight_lb: 1.5 };
    const cuFt = Number(((pkg.length_in * pkg.width_in * pkg.height_in) / 1728).toFixed(6));
    const baseSc = {
      id: 'sc-cli-man',
      price_usd: 45,
      available_date: '2025-05-01',
      pkg,
      fx_cny_per_usd: 7.2,
      refund_fraction: 0.05,
      physical_return_fraction: 0.05,
      fee_category: 'Home and Kitchen',
      referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.3 },
      headhaul_usd: 1.8,
      collection_rate: 0.005,
      other_applicable_usd: 0,
      sales_window: { from: '2027-02-01', through: '2027-10-14' },
      storage_window: { from: '2027-02-01', through: '2027-09-30' },
      inbound_window: { from: '2027-01-15', through: '2027-10-14' },
    };
    cliStore.upsertCandidateForm({
      form_id: 'form-cli-man4',
      product_family_key: 'cli-man4',
      label: 'CLI Manual 4th Factory Form',
      buyer_task: 'Hold items',
      saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
    });
    const g1aC = runGate1AForForm(cliStore, { form_id: 'form-cli-man4', scenarios: [baseSc] });
    const declC = g1aC.declared_scenarios[0];
    const mkCliQ = (qid, fid, priceCny) => ({
      quote_id: qid,
      form_id: 'form-cli-man4',
      factory_id: fid,
      spec_variant_key: 'std-cli',
      observed_at: '2026-11-26T10:00:00Z',
      redacted_destination: '广东深圳',
      raw_readback_ref: `ev-${qid}`,
      goods_first_order_promotion: false,
      freight_first_order_promotion: false,
      pricing_basis: 'bare_goods_1688',
      bare_goods_screening: true,
      fx_cny_per_usd: 7.2,
      pkg,
      ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{
        component_id: 'unit', offer_id: `off-${qid}`, sku_id: `sku-${qid}`, factory_id: fid,
        pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100,
        unit_price_cny: priceCny, regular_goods_promo_false: true,
      }],
      goods_cny_total: priceCny * 100,
      domestic_freight_cny_total: null,
    });
    const esSc = {
      profile_revision: 59,
      id: declC.id,
      saleable_unit: '1 unit',
      price_usd: declC.price_usd,
      fx_cny_per_usd: declC.fx_cny_per_usd,
      pkg,
      headhaul: { usd_per_unit: declC.headhaul_usd, bond_included: true },
      refund_fraction: 0.05,
      physical_return_fraction: 0.05,
      return_threshold: 0.081,
      returns_processing_usd: 0,
      is_apparel_or_shoes: false,
      referral_terms: baseSc.referral_terms,
      fulfillment_usd: declC.fulfillment_usd,
      placement_usd: declC.placement_range_usd[1],
      storage: { cubic_feet_per_unit: cuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak',
      operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: baseSc.sales_window, storage: baseSc.storage_window, inbound: baseSc.inbound_window },
      collection_rate: 0.005,
      other_applicable_usd: 0,
      specific_rights_conflict: 'unknown',
      strong_date_dependency: false,
    };
    cliStore.recordSourcingQuotesBatch1688([
      mkCliQ('qc-1', 'fc-1', 150),
      mkCliQ('qc-2', 'fc-2', 148),
      mkCliQ('qc-3', 'fc-3', 145),
    ]);
    const rejCli = await runGate1BForForm(cliStore, {
      form_id: 'form-cli-man4',
      profile_revision: 59,
      as_of_date: '2026-11-26',
      early_screen_builder: () => esSc,
    });
    assert.equal(rejCli.status, 'gate1b_rejected');
    cliStore.close();

    const g1bInputPath = join(tmpDir, 'g1b-man4.json');
    writeFileSync(g1bInputPath, JSON.stringify({
      form_id: 'form-cli-man4',
      manual_owner_entry: true,
      as_of_date: '2026-11-26',
      quote: mkCliQ('qc-4-cli-man', 'fc-4-owner', 35),
      early_screen_scenario: esSc,
    }), 'utf8');
    const cliRun = await runCliMem(['gate1b', '--db', dbPath, '--input', g1bInputPath]);
    assert.equal(cliRun.code, 0, `CLI gate1b manual 4th factory failed: ${cliRun.stderr}`);
    const parsedCli = JSON.parse(cliRun.stdout);
    assert.equal(parsedCli.ok, true);
    assert.equal(parsedCli.result.status, 'gate1b_passed');
  });
});

const ISSUE23_EXPECTED_DISCLOSURE = '当前按 1688 裸货价算，未含国内到深圳运费（常规约占 0.5%～1.5%，超大超重抛货拿样下单前实询）';
const ISSUE23_STD_PKG = { id: 'pkg-std', length_in: 10, width_in: 8, height_in: 3, weight_lb: 1.0 };
const ISSUE23_REF_TERMS = {
  referral_fraction: 0.15,
  refund_admin_fraction: 0.20,
  refund_admin_cap_usd: 5.00,
  minimum_referral_usd: 0.30,
};
const ISSUE23_WIN_2027 = {
  sales: { from: '2027-02-01', through: '2027-10-14' },
  storage: { from: '2027-02-01', through: '2027-09-30' },
  inbound: { from: '2027-01-15', through: '2027-10-14' },
};

test('Issue #23 (ADR-0002): SQLite CHECK migration allows null domestic_freight_cny_total on verified bare-goods quotes, preserves factory_id, and ranks superseded_uncompetitive on bare-goods price', () => {
  withTempDir('issue23-sqlite-', dir => {
    const dbPath = join(dir, 'legacy-check.sqlite');
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      CREATE TABLE candidate_forms (
        form_id TEXT PRIMARY KEY,
        product_family_key TEXT NOT NULL,
        label TEXT NOT NULL,
        buyer_task TEXT NOT NULL,
        saleable_set_composition_json TEXT NOT NULL,
        spec_version INTEGER NOT NULL DEFAULT 1,
        spec_sha256 TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sourcing_quotes_1688 (
        quote_id TEXT PRIMARY KEY,
        form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
        spec_version INTEGER NOT NULL CHECK(spec_version >= 1),
        sku_lines_json TEXT NOT NULL,
        order_plan_json TEXT,
        pack_multiple INTEGER NOT NULL CHECK(pack_multiple >= 1),
        moq_sets INTEGER NOT NULL CHECK(moq_sets >= 1),
        actual_sets INTEGER NOT NULL CHECK(actual_sets >= 1),
        actual_complete_sets INTEGER NOT NULL CHECK(actual_complete_sets >= 1),
        goods_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (goods_cny_total IS NULL OR goods_cny_total > 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND goods_cny_total IS NOT NULL AND goods_cny_total > 0)),
        domestic_freight_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
        pkg_json TEXT,
        fx_cny_per_usd REAL CHECK(fx_cny_per_usd > 0),
        factory_id TEXT,
        spec_variant_key TEXT,
        kit_note TEXT,
        goods_first_order_promotion INTEGER NOT NULL CHECK(goods_first_order_promotion IN (0, 1)),
        freight_first_order_promotion INTEGER NOT NULL CHECK(freight_first_order_promotion IN (0, 1)),
        lead_time_days INTEGER CHECK(lead_time_days IS NULL OR lead_time_days >= 0),
        sensitive_freebie_flags_json TEXT NOT NULL,
        redacted_destination TEXT NOT NULL,
        redacted_screenshot_path TEXT,
        redacted_webp_sha256 TEXT,
        raw_readback_ref TEXT,
        observed_at TEXT NOT NULL,
        expires_at TEXT,
        quote_status TEXT NOT NULL CHECK(quote_status IN ('verified', 'superseded_uncompetitive', 'incomplete_cross_factory_kit', 'rejected_promo', 'rejected_spec', 'expired', 'pending')),
        created_at TEXT NOT NULL
      );
      INSERT INTO candidate_forms VALUES ('f-mig', 'fam-mig', 'Mig Test', 'Task', '[{"component_id":"unit","qty_per_saleable_set":1}]', 1, 'sha1', 'gate1a_passed', '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z');
      INSERT INTO sourcing_quotes_1688 VALUES (
        'q-old-fac', 'f-mig', 1, '[]', NULL, 1, 100, 100, 100, 4500, 120, NULL, 7.2, 'fac-legacy-1', 'std-v1', NULL,
        0, 0, 7, '{}', '广东深圳', NULL, NULL, NULL, '2026-11-26T00:00:00Z', NULL, 'verified', '2026-11-26T00:00:00Z'
      );
    `);
    rawDb.close();

    const store = openSelectionStore(dbPath);
    try {
      const preserved = store.getQuoteById('q-old-fac');
      assert.equal(preserved.factory_id, 'fac-legacy-1', 'Migration must preserve existing factory_id column');

      const qBare = store.recordSourcingQuote1688({
        quote_id: 'q-bare-cheaper',
        form_id: 'f-mig',
        factory_id: 'fac-bare-2',
        spec_variant_key: 'std-v1',
        observed_at: '2026-11-26T10:00:00Z',
        redacted_destination: '广东深圳',
        goods_first_order_promotion: false,
        quote_status: 'verified',
        goods_cny_total: 4000,
        domestic_freight_cny_total: null,
        fx_cny_per_usd: 7.2,
        raw_readback_ref: 'readback://1688/offer-2',
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{
          component_id: 'unit',
          offer_id: 'offer-2',
          sku_id: 'sku-2',
          factory_id: 'fac-bare-2',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 100,
          ordered_qty: 100,
          unit_price_cny: 40,
          regular_goods_promo_false: true,
        }],
      });
      assert.equal(qBare.quote.quote_status, 'verified');
      assert.equal(qBare.quote.domestic_freight_cny_total, null);
      assert.equal(store.getQuoteById('q-old-fac').quote_status, 'superseded_uncompetitive');

      const qBareWithAdvisory = store.recordSourcingQuote1688({
        quote_id: 'q-bare-advisory',
        form_id: 'f-mig',
        factory_id: 'fac-bare-3',
        spec_variant_key: 'std-v1',
        observed_at: '2026-11-26T11:00:00Z',
        redacted_destination: '广东深圳',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        quote_status: 'verified',
        goods_cny_total: 3800,
        domestic_freight_cny_total: 500,
        fx_cny_per_usd: 7.2,
        raw_readback_ref: 'readback://1688/offer-3',
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{
          component_id: 'unit',
          offer_id: 'offer-3',
          sku_id: 'sku-3',
          factory_id: 'fac-bare-3',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 100,
          ordered_qty: 100,
          unit_price_cny: 38,
          regular_goods_promo_false: true,
        }],
      });
      assert.equal(qBareWithAdvisory.quote.quote_status, 'verified');
      assert.equal(store.getQuoteById('q-bare-cheaper').quote_status, 'superseded_uncompetitive');
    } finally {
      store.close();
    }
  });
});

test('Issue #23 (ADR-0001 + ADR-0002): end-to-end Gate 1A -> Gate 1B -> solveMinPrice -> CLI reverse-1688 -> profit-check -> scoreBatch -> HTML report bare-goods screening & disclosure', async () => {
  await withTempDirAsync('issue23-e2e-', async dir => {
    const dbPath = join(dir, 'e2e.sqlite');
    const store = openSelectionStore(dbPath);
    try {
      store.upsertCandidateForm({
        form_id: 'form-bare-e2e',
        product_family_key: 'form-bare-e2e',
        label: 'Synthetic Bare-Goods Tray',
        buyer_task: 'Organize desk accessories',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      const kaiqiHh = {
        carton_count: 2,
        weight_per_carton_kg: 12,
        carton_cm: [35, 30, 25],
        rate_cny_per_kg: 10.0,
        surcharge_cny_per_kg: 0,
        bond_cny_per_kg: 1.0,
      };
      const g1a = runGate1AForForm(store, {
        form_id: 'form-bare-e2e',
        profile_revision: 59,
        scenarios: [{
          id: 'sc-bare-1',
          price_usd: 45.00,
          pkg: ISSUE23_STD_PKG,
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: ISSUE23_REF_TERMS,
          headhaul: kaiqiHh,
          collection_rate: 0.006,
          other_applicable_usd: 0,
        }],
      });
      assert.equal(g1a.gate_status, 'gate1a_passed');
      assert.equal(g1a.scenarios[0].estimate.components.placement.selected_usd, 0);

      const qRec = store.recordSourcingQuote1688({
        quote_id: 'q-bare-e2e',
        form_id: 'form-bare-e2e',
        factory_id: 'fac-e2e-1',
        observed_at: '2026-11-26T10:00:00Z',
        redacted_destination: '广东深圳',
        goods_first_order_promotion: false,
        quote_status: 'verified',
        goods_cny_total: 4200,
        domestic_freight_cny_total: null,
        fx_cny_per_usd: 7.2,
        pkg: ISSUE23_STD_PKG,
        raw_readback_ref: 'readback://1688/off-e2e',
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{
          component_id: 'unit',
          offer_id: 'off-e2e',
          sku_id: 'sku-e2e',
          factory_id: 'fac-e2e-1',
          pack_multiple: 1,
          qty_per_saleable_set: 1,
          moq_qty: 100,
          ordered_qty: 100,
          unit_price_cny: 42,
          regular_goods_promo_false: true,
        }],
      });
      assert.equal(qRec.quote.quote_status, 'verified');

      const g1b = await runGate1BForForm(store, {
        form_id: 'form-bare-e2e',
        profile_revision: 59,
        as_of_date: '2026-11-26',
        existing_quote: qRec.quote,
        early_screen_builder: () => [{
          id: 'sc-bare-1',
          saleable_unit: '1 synthetic tray',
          price_usd: 45.00,
          pkg: ISSUE23_STD_PKG,
          fx_cny_per_usd: 7.2,
          headhaul: kaiqiHh,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          return_threshold: 0.081,
          returns_processing_usd: 0,
          fee_category: 'Home and Kitchen',
          referral_terms: ISSUE23_REF_TERMS,
          fulfillment_usd: g1a.scenarios[0].estimate.components.fulfillment.total_usd,
          placement_usd: 0,
          placement_split_option: 'amazon_optimized',
          storage: {
            cubic_feet_per_unit: g1a.scenarios[0].estimate.components.storage.cubic_feet,
            rate_usd_per_cuft_month: 0.78,
            average_inventory_days: 45,
          },
          operating_period: 'off_peak',
          operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
          fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...ISSUE23_WIN_2027 },
          collection_rate: 0.006,
          other_applicable_usd: 0,
          specific_rights_conflict: false,
          strong_date_dependency: false,
        }],
      });
      assert.equal(g1b.status, 'gate1b_passed');
      assert.equal(g1b.proceed_to_gate2_3, true);
      assert.equal(g1b.forward_pricing.status, 'verified');
      assert.equal(g1b.forward_pricing.calculator_name_zh, '按 1688 成本算保底定价');
      assert.equal(g1b.forward_pricing.bare_goods_disclosure, ISSUE23_EXPECTED_DISCLOSURE);
      assert.equal(g1b.early_screen.cost_basis, 'bare_goods_1688');
      assert.equal(g1b.early_screen.bare_goods_disclosure, ISSUE23_EXPECTED_DISCLOSURE);
    } finally {
      store.close();
    }

    const bareSolved = solveMinPriceForMargin2027({
      pkg: ISSUE23_STD_PKG,
      bare_goods_quote: { goods_cny_total: 4200, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG },
      headhaul: { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
      refund_fraction: 0.04,
      fee_category: 'Home and Kitchen',
      referral_terms: ISSUE23_REF_TERMS,
      collection_rate: 0.006,
    });
    assert.equal(bareSolved.status, 'verified');
    assert.equal(bareSolved.cost_basis, 'bare_goods_1688');
    assert.equal(bareSolved.calculator_name_zh, '按 1688 成本算保底定价');
    assert.equal(bareSolved.bare_goods_disclosure, ISSUE23_EXPECTED_DISCLOSURE);

    const hcBare = runFastProfitHealthcheck2027({
      pkg: ISSUE23_STD_PKG,
      price_usd: 45.00,
      fx_cny_per_usd: 7.2,
      order_units: 100,
      goods_cny_total: 4200,
      headhaul: { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
    });
    assert.equal(hcBare.cost_basis, 'bare_goods_1688');
    assert.equal(hcBare.bare_goods_disclosure, ISSUE23_EXPECTED_DISCLOSURE);
    assert.equal(hcBare.realized_2027_off_peak.status, 'verified');
    assert.equal(hcBare.forward_breakeven_30pct.status, 'verified');
    assert.equal(hcBare.forward_breakeven_30pct.calculator_name_zh, '按 1688 成本算保底定价');

    const revSpecPath = join(dir, 'rev-bare.json');
    writeFileSync(revSpecPath, JSON.stringify({
      fx_cny_per_usd: 7.2,
      pkg: ISSUE23_STD_PKG,
      headhaul: { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
      quote: { goods_cny_total: 4200, order_units: 100 },
    }), 'utf8');
    const revOut = await runCliMem(['reverse-1688', '--db', dbPath, '--input', revSpecPath]);
    assert.equal(revOut.code, 0, revOut.stderr);
    const revJson = JSON.parse(revOut.stdout);
    assert.equal(revJson.reverse_1688.calculator_name_zh, '按 1688 成本算保底定价');
    assert.equal(revJson.reverse_1688.cost_basis, 'bare_goods_1688');
    assert.equal(revJson.reverse_1688.bare_goods_disclosure, ISSUE23_EXPECTED_DISCLOSURE);
    assert.equal(revJson.reverse_1688.solution.status, 'verified');
    assert.ok(Number.isFinite(revJson.reverse_1688.min_retail_price_for_30pct_usd));

    const batchCopy = structuredClone(synthBatch);
    const cand0 = batchCopy.candidates[0];
    for (const sc of cand0.economics.scenarios) {
      const dom = sc.cost_ledger.lines.find(l => l.id === 'domestic_freight');
      dom.amount_usd = 0;
      dom.status = 'not_applicable';
      dom.bare_goods_screening = true;
      dom.basis = ISSUE23_EXPECTED_DISCLOSURE;
      delete dom.components;
      if (sc.cost_ledger.source_inputs) {
        delete sc.cost_ledger.source_inputs.domestic_per_unit_cny;
        sc.cost_ledger.source_inputs.domestic_freight_advisory_note = '页面显示包邮（参考）';
      }
      const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
      plc.amount_usd = 0;
      plc.split_option = 'amazon_optimized';
      plc.fee_basis.split_option = 'amazon_optimized';
      sc.cost_ledger.multi_destination_headhaul_verified = true;
    }
    const scored = scoreBatch(batchCopy, r59Profile);
    const candRes = scored.candidates.find(c => c.candidate_id === cand0.id);
    assert.ok(candRes, 'Target candidate must be present by candidate_id');
    assert.equal(candRes.qualification.counts_toward_target, true, 'Bare-goods + steady-state $0 placement card must qualify');

    const html = renderReport(scored, batchCopy, r59Profile);
    assert.ok(html.includes(ISSUE23_EXPECTED_DISCLOSURE), 'HTML report must render mandatory bare-goods disclosure');
    assert.ok(html.includes('1688 裸货 + 头程'), 'HTML report must render bare-goods + headhaul reference capital row cleanly');
    assert.equal(
      /单件参考本金（1688 裸货 \+ 头程）[\s\S]{0,200}待补证/.test(html),
      false,
      'Bare-goods reference capital row must NOT show 待补证',
    );
  });
});

test('Issue #23 Astra audit regressions (P1-1..P1-5 & P2-1..P2-5): advisory freight never kills, US-West cannot spoof via outer label, steady-state parity, 200-set order_units, omitted domestic_freight bare-goods card, Kaiqi default ¥10/kg, legacy migration re-rank, and advisory 50kg/dest note', async () => {
  await withTempDirAsync('issue23-astra-', async dir => {
    const db1 = join(dir, 'p1-1.sqlite');
    const store1 = openSelectionStore(db1);
    try {
      const kaiqi10 = { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
      const runSameBareQuote = async (formId, quotePatch) => {
        store1.upsertCandidateForm({
          form_id: formId,
          product_family_key: formId,
          label: `Form ${formId}`,
          buyer_task: 'Desk organizer',
          saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
        });
        const g1a = runGate1AForForm(store1, {
          form_id: formId,
          profile_revision: 59,
          scenarios: [{
            id: 'sc-1',
            price_usd: 45.00,
            pkg: ISSUE23_STD_PKG,
            fx_cny_per_usd: 7.2,
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            fee_category: 'Home and Kitchen',
            referral_terms: ISSUE23_REF_TERMS,
            headhaul: kaiqi10,
            collection_rate: 0.006,
            other_applicable_usd: 0,
          }],
        });
        const q = store1.recordSourcingQuote1688({
          quote_id: `q-${formId}`,
          form_id: formId,
          factory_id: 'fac-1',
          observed_at: '2026-11-26T10:00:00Z',
          redacted_destination: '广东深圳',
          goods_first_order_promotion: false,
          quote_status: 'verified',
          goods_cny_total: 11700,
          fx_cny_per_usd: 7.2,
          pkg: ISSUE23_STD_PKG,
          raw_readback_ref: `rb://${formId}`,
          ui_readback: DEFAULT_R59_UI_READBACK,
          sku_lines: [{
            component_id: 'unit', offer_id: 'o1', sku_id: 's1', factory_id: 'fac-1',
            pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100,
            unit_price_cny: 117, regular_goods_promo_false: true,
          }],
          ...quotePatch,
        });
        return runGate1BForForm(store1, {
          form_id: formId,
          profile_revision: 59,
          as_of_date: '2026-11-26',
          existing_quote: q.quote,
          early_screen_builder: () => [{
            id: 'sc-1',
            saleable_unit: '1 organizer',
            price_usd: 45.00,
            pkg: ISSUE23_STD_PKG,
            fx_cny_per_usd: 7.2,
            headhaul: kaiqi10,
            refund_fraction: 0.04,
            physical_return_fraction: 0.04,
            return_threshold: 0.081,
            returns_processing_usd: 0,
            fee_category: 'Home and Kitchen',
            referral_terms: ISSUE23_REF_TERMS,
            fulfillment_usd: g1a.scenarios[0].estimate.components.fulfillment.total_usd,
            placement_usd: 0,
            placement_split_option: 'amazon_optimized',
            storage: { cubic_feet_per_unit: g1a.scenarios[0].estimate.components.storage.cubic_feet, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak',
            operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...ISSUE23_WIN_2027 },
            collection_rate: 0.006,
            other_applicable_usd: 0,
            specific_rights_conflict: false,
            strong_date_dependency: false,
          }],
        });
      };
      const resNull = await runSameBareQuote('f-bare-null', { domestic_freight_cny_total: null, freight_first_order_promotion: true });
      const resAdv500 = await runSameBareQuote('f-bare-adv500', { bare_goods_screening: true, domestic_freight_cny_total: 500, freight_first_order_promotion: true });
      assert.equal(resNull.status, 'gate1b_passed');
      assert.equal(resAdv500.status, 'gate1b_passed');
      assert.equal(resNull.early_screen.metrics.margin, resAdv500.early_screen.metrics.margin);
      assert.equal(resNull.forward_pricing.feasible_min_price_usd, resAdv500.forward_pricing.feasible_min_price_usd);
      assert.equal(resAdv500.quote.pricing_basis, 'bare_goods_1688');
      assert.equal(resAdv500.quote.domestic_freight_advisory_cny_total, 500);
    } finally {
      store1.close();
    }

    const usWestInner = { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 8.48, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0, destination_scope: 'us_west_single' };
    assert.equal(lookupBulkyPlacementFee2027({
      pkg: ISSUE23_STD_PKG, inbound_window: ISSUE23_WIN_2027.inbound, split_option: 'amazon_optimized',
      headhaul: usWestInner, headhaul_rate_cny_per_kg: 10.0, headhaul_destination_scope: 'nationwide', multi_destination_headhaul_verified: true,
    }).status, 'sensitivity_only');
    assert.notEqual(estimateGate1A2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006, order_units: 100,
      headhaul: usWestInner, headhaul_rate_cny_per_kg: 10.0, headhaul_destination_scope: 'nationwide', placement_split_option: 'amazon_optimized',
    }).status, 'verified');
    const hcSpoof = runFastProfitHealthcheck2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_total: 4000,
      headhaul: usWestInner, headhaul_rate_cny_per_kg: 10.0, headhaul_destination_scope: 'nationwide', placement_split_option: 'amazon_optimized',
    });
    assert.notEqual(hcSpoof.realized_2027_off_peak.status, 'verified');

    const light4x5 = { carton_count: 4, weight_per_carton_kg: 5, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
    assert.equal(estimateGate1A2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
      referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006, order_units: 100,
      steady_state_replenishment: false, headhaul: light4x5,
    }).status, 'needs_calculator_verification');
    const steadyWithRateTableMeta = computeHeadhaulWithA4Rules({
      ...light4x5,
      steady_state_replenishment: true,
      small_shipment_threshold_kg: 50,
      small_shipment_surcharge_cny_per_kg: 3,
      small_carton_threshold_kg: 8,
      small_carton_surcharge_cny_per_carton: 20,
    }, 7.2, 100, { isR58: true, isR59: true });
    assert.equal(steadyWithRateTableMeta.a4_applied.steady_state_replenishment, true);
    assert.equal(steadyWithRateTableMeta.a4_applied.below_50kg_small_shipment, false);
    assert.equal(steadyWithRateTableMeta.a4_applied.below_8kg_outer_carton, false);
    assert.ok(Math.abs(steadyWithRateTableMeta.amount_usd - ((20 * 11) / 100 / 7.2)) < 1e-6);

    const db200 = join(dir, 'p1-4.sqlite');
    const store200 = openSelectionStore(db200);
    try {
      store200.upsertCandidateForm({
        form_id: 'f-200', product_family_key: 'f-200', label: '200-set MOQ', buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      const hh80 = { actual_weight_kg_total: 80, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
      const g1a200 = runGate1AForForm(store200, {
        form_id: 'f-200', profile_revision: 59,
        scenarios: [{
          id: 'sc-200', price_usd: 45, pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2, order_units: 200,
          refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
          referral_terms: ISSUE23_REF_TERMS, headhaul: hh80, collection_rate: 0.006, other_applicable_usd: 0,
        }],
      });
      assert.equal(g1a200.gate_status, 'gate1a_passed');
      const q200 = store200.recordSourcingQuote1688({
        quote_id: 'q-200', form_id: 'f-200', factory_id: 'fac-200', observed_at: '2026-11-26T10:00:00Z',
        redacted_destination: '广东深圳', goods_first_order_promotion: false, quote_status: 'verified',
        goods_cny_total: 18000, domestic_freight_cny_total: null, fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG,
        raw_readback_ref: 'rb://200', ui_readback: DEFAULT_R59_UI_READBACK, target_sets: 200,
        sku_lines: [{ component_id: 'unit', offer_id: 'o200', sku_id: 's200', factory_id: 'fac-200', pack_multiple: 200, qty_per_saleable_set: 1, moq_qty: 200, ordered_qty: 200, unit_price_cny: 90, regular_goods_promo_false: true }],
      });
      const direct200 = solveMinPriceForMargin2027({
        pkg: ISSUE23_STD_PKG, bare_goods_quote: q200.quote, fx_cny_per_usd: 7.2, order_units: 200,
        headhaul: { ...hh80, order_units: 200 }, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
        referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      });
      const inferred200 = solveMinPriceForMargin2027({
        pkg: ISSUE23_STD_PKG, bare_goods_quote: q200.quote, fx_cny_per_usd: 7.2,
        headhaul: hh80, refund_fraction: 0.04, fee_category: 'Home and Kitchen',
        referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      });
      assert.equal(inferred200.feasible_min_price_usd, direct200.feasible_min_price_usd);
    } finally {
      store200.close();
    }

    const bareOmitBatch = structuredClone(synthBatch);
    const singleCand = bareOmitBatch.candidates[0];
    bareOmitBatch.candidates = [singleCand];
    for (const sc of singleCand.economics.scenarios) {
      sc.cost_ledger.cost_basis = 'bare_goods_1688';
      sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
      if (sc.cost_ledger.source_inputs) delete sc.cost_ledger.source_inputs.domestic_per_unit_cny;
    }
    const scoredOmit = scoreBatch(bareOmitBatch, r59Profile);
    const omitRes = scoredOmit.candidates.find(c => c.candidate_id === singleCand.id);
    assert.equal(omitRes.qualification.counts_toward_target, true);
    const htmlOmit = renderReport(scoredOmit, bareOmitBatch, r59Profile);
    assert.ok(htmlOmit.includes('1688百套裸货'), 'Overview matrix must display 1688百套裸货 when all cards are bare-goods');
    assert.ok(htmlOmit.includes(ISSUE23_EXPECTED_DISCLOSURE));

    const hcNeedFreight = runFastProfitHealthcheck2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_total: 4000,
      bare_goods_screening: false, headhaul_usd: 1.5,
    });
    assert.equal(hcNeedFreight.realized_2027_off_peak.status, 'pending_domestic_freight');
    const hc1Set = runFastProfitHealthcheck2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 1, goods_cny_total: 40, headhaul_usd: 1.5,
    });
    assert.equal(hc1Set.realized_2027_off_peak.status, 'needs_calculator_verification');
    const promoSolve = solveMinPriceForMargin2027({
      pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2, headhaul_usd: 1.5, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      bare_goods_quote: { goods_cny_total: 4000, actual_sets: 100, goods_first_order_promotion: true, quote_status: 'rejected_promo', fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG },
    });
    assert.equal(promoSolve.status, 'needs_calculator_verification');
    const infeasibleBare = solveMinPriceForMargin2027({
      pkg: ISSUE23_STD_PKG, bare_goods_cny: 4000, fx_cny_per_usd: 7.2, headhaul_usd: 1.5, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006, max_search_price_usd: 40,
    });
    assert.equal(infeasibleBare.status, 'infeasible');
    assert.equal(infeasibleBare.calculator_name_zh, '按 1688 成本算保底定价');
    assert.equal(infeasibleBare.cost_basis, 'bare_goods_1688');
    assert.equal(infeasibleBare.bare_goods_disclosure, ISSUE23_EXPECTED_DISCLOSURE);

    const hcKaiqiDefault = runFastProfitHealthcheck2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_total: 4200,
      headhaul: { carton_count: 5, weight_per_carton_kg: 12, destination_scope: 'nationwide_multi_warehouse', bond_cny_per_kg: 1.0 },
    });
    assert.equal(hcKaiqiDefault.realized_2027_off_peak.status, 'verified');
    assert.match(hcKaiqiDefault.advisory_replenishment_note ?? '', /50 kg/, '60 kg / 5 warehouses (<50 kg/dest) must surface replenishment note in profit-check');

    const legacyRankDb = join(dir, 'legacy-rerank.sqlite');
    const rawR = new DatabaseSync(legacyRankDb);
    try {
      rawR.exec(`
        CREATE TABLE candidate_forms (
          form_id TEXT PRIMARY KEY, product_family_key TEXT NOT NULL, spec_version INTEGER NOT NULL DEFAULT 1,
          spec_sha256 TEXT NOT NULL, label TEXT NOT NULL, buyer_task TEXT NOT NULL,
          saleable_set_composition_json TEXT NOT NULL, lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE sourcing_quotes_1688 (
          quote_id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
          spec_version INTEGER NOT NULL, sku_lines_json TEXT NOT NULL, order_plan_json TEXT,
          pack_multiple INTEGER NOT NULL, moq_sets INTEGER NOT NULL, actual_sets INTEGER NOT NULL, actual_complete_sets INTEGER NOT NULL,
          goods_cny_total REAL CHECK(goods_cny_total > 0),
          domestic_freight_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
          pkg_json TEXT, fx_cny_per_usd REAL, factory_id TEXT, spec_variant_key TEXT, kit_note TEXT,
          goods_first_order_promotion INTEGER NOT NULL, freight_first_order_promotion INTEGER NOT NULL,
          lead_time_days INTEGER, sensitive_freebie_flags_json TEXT NOT NULL, redacted_destination TEXT NOT NULL,
          redacted_screenshot_path TEXT, redacted_webp_sha256 TEXT, raw_readback_ref TEXT,
          observed_at TEXT NOT NULL, expires_at TEXT, quote_status TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO candidate_forms VALUES ('f-rank','f-rank',1,'abc','L','T','[]','discovered','2026-11-20T00:00:00Z','2026-11-20T00:00:00Z');
        INSERT INTO sourcing_quotes_1688 VALUES
          ('q-a-38','f-rank',1,'[]',NULL,1,100,100,100,3800,500,NULL,7.2,'fac-a','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://a','2026-11-20T00:00:00Z',NULL,'superseded_uncompetitive','2026-11-20T00:00:00Z'),
          ('q-b-40','f-rank',1,'[]',NULL,1,100,100,100,4000,0,NULL,7.2,'fac-b','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://b','2026-11-20T01:00:00Z',NULL,'verified','2026-11-20T01:00:00Z');
      `);
    } finally {
      rawR.close();
    }
    const migratedRankStore = openSelectionStore(legacyRankDb);
    try {
      assert.equal(migratedRankStore.getQuoteById('q-a-38').quote_status, 'verified', 'Migration must promote cheaper bare-goods quote A (¥38)');
      assert.equal(migratedRankStore.getQuoteById('q-b-40').quote_status, 'superseded_uncompetitive', 'Migration must supersede pricier bare-goods quote B (¥40)');
    } finally {
      migratedRankStore.close();
    }
  });
});

test('Issue #23 adversarial review regressions: Kaiqi default ¥10/kg parity, usd_per_unit us_west_single block, bare-goods freight-only promo, explicit non-bare solveMinPrice & replenishment note, and expired-quote immunity', async () => {
  await withTempDirAsync('issue23-adv-core-', async dir => {
    const kaiqiDefaultChg = { destination_scope: 'nationwide_multi_warehouse', chargeable_kg_per_unit: 0.60, bond_cny_per_kg: 1.0 };
    const hhDef = computeHeadhaulWithA4Rules(kaiqiDefaultChg, 7.2, 100, { isR58: true, isR59: true });
    assert.ok(Math.abs(hhDef.amount_usd - (0.60 * 11 / 7.2)) < 1e-6);

    const g1aDef = estimateGate1A2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      order_units: 100, headhaul: kaiqiDefaultChg, profile_revision: 59,
    });
    assert.equal(g1aDef.status, 'verified');
    assert.equal(g1aDef.components.placement.selected_usd, 0);
    assert.equal(g1aDef.components.headhaul.amount_usd, hhDef.amount_usd);

    const hcDef = runFastProfitHealthcheck2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100,
      goods_cny_total: 4200, headhaul: kaiqiDefaultChg,
    });
    assert.equal(hcDef.realized_2027_off_peak.status, 'verified');

    const revDefPath = join(dir, 'rev-kaiqi-default.json');
    writeFileSync(revDefPath, JSON.stringify({
      fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG, headhaul: kaiqiDefaultChg,
      quote: { goods_cny_total: 4200, order_units: 100 },
    }), 'utf8');
    const revDefRes = await runCliMem(['reverse-1688', '--db', join(dir, 'rev.sqlite'), '--input', revDefPath]);
    assert.equal(revDefRes.code, 0);
    const revDefOut = JSON.parse(revDefRes.stdout);
    assert.equal(revDefOut.reverse_1688.solution.status, 'verified');

    const usWestUsdHh = { usd_per_unit: 0.70, bond_included: true, destination_scope: 'us_west_single' };
    const g1aUsWestUsd = estimateGate1A2027({
      pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      order_units: 100, headhaul: usWestUsdHh, placement_split_option: 'amazon_optimized',
      identical_cartons_count: 5, multi_destination_headhaul_verified: true, profile_revision: 59,
    });
    assert.equal(g1aUsWestUsd.status, 'sensitivity_only');

    const econUsWestLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    econUsWestLedger.headhaul = usWestUsdHh;
    const plcLn = econUsWestLedger.lines.find(l => l.id === 'placement');
    plcLn.amount_usd = 0;
    plcLn.split_option = 'amazon_optimized';
    plcLn.fee_basis = { ...(plcLn.fee_basis ?? {}), split_option: 'amazon_optimized' };
    econUsWestLedger.multi_destination_headhaul_verified = true;
    const econUsWestRes = calculateEconomics(econUsWestLedger, { profileRevision: 59, requireFeeBasis: false });
    assert.equal(econUsWestRes.margin, null, 'calculateEconomics must hold pending when usd_per_unit us_west_single pairs with $0 placement');
    assert.ok(econUsWestRes.pending_lines.includes('placement'));

    const esBase = {
      profile_revision: 59, id: 'es-bare-promo', saleable_unit: '1 organizer',
      price_usd: 45, fx_cny_per_usd: 7.2, order_units: 100, goods_cny_per_unit: 42,
      headhaul: { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 },
      refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0,
      fee_category: 'Home and Kitchen', pkg: ISSUE23_STD_PKG, is_apparel_or_shoes: false, referral_terms: ISSUE23_REF_TERMS,
      fulfillment_usd: 4.50, placement_usd: 0, placement_split_option: 'amazon_optimized',
      storage: { cubic_feet_per_unit: 0.1389, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
      operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
      fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...ISSUE23_WIN_2027 },
      collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
    };
    const esFreightOnlyPromo = evaluateEarlyScreen({
      ...esBase, bare_goods_screening: true, goods_first_order_promotion: false, first_order_promotion: true,
    });
    assert.equal(esFreightOnlyPromo.gate_status, 'pass');
    assert.equal(esFreightOnlyPromo.cost_basis, 'bare_goods_1688');
    const esAmbigPromo = evaluateEarlyScreen({ ...esBase, bare_goods_screening: true, first_order_promotion: true });
    assert.equal(esAmbigPromo.gate_status, 'pending');

    const solveNeedFreight = solveMinPriceForMargin2027({
      pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2, headhaul_usd: 1.5, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      bare_goods_screening: false,
      landed_domestic_quote: { goods_cny_total: 4200, domestic_freight_cny_total: null, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG },
    });
    assert.equal(solveNeedFreight.status, 'pending_domestic_freight');
    assert.equal(solveNeedFreight.cost_basis, 'landed_domestic_explicit');

    const lightHh = { carton_count: 2, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
    const solveWithNote = solveMinPriceForMargin2027({
      pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2, headhaul: lightHh, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      bare_goods_quote: { goods_cny_total: 4200, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG },
    });
    assert.equal(solveWithNote.status, 'verified');
    assert.match(solveWithNote.advisory_replenishment_note ?? '', /50 kg/);

    const solveCliPath = join(dir, 'solve-min.json');
    writeFileSync(solveCliPath, JSON.stringify({
      pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2, headhaul: lightHh, refund_fraction: 0.04,
      fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
      bare_goods_quote: { goods_cny_total: 4200, actual_sets: 100, fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG },
    }), 'utf8');
    const solveRes = await runCliMem(['solve-min-price', '--db', join(dir, 'solve.sqlite'), '--input', solveCliPath]);
    assert.equal(solveRes.code, 0);
    const solveCliOut = JSON.parse(solveRes.stdout);
    assert.match(solveCliOut.advisory_replenishment_note ?? '', /50 kg/);

    const expDbPath = join(dir, 'expired-immunity.sqlite');
    const rawExp = new DatabaseSync(expDbPath);
    try {
      rawExp.exec(`
        CREATE TABLE candidate_forms (
          form_id TEXT PRIMARY KEY, product_family_key TEXT NOT NULL, spec_version INTEGER NOT NULL DEFAULT 1,
          spec_sha256 TEXT NOT NULL, label TEXT NOT NULL, buyer_task TEXT NOT NULL,
          saleable_set_composition_json TEXT NOT NULL, lifecycle_status TEXT NOT NULL DEFAULT 'discovered',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE sourcing_quotes_1688 (
          quote_id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES candidate_forms(form_id),
          spec_version INTEGER NOT NULL, sku_lines_json TEXT NOT NULL, order_plan_json TEXT,
          pack_multiple INTEGER NOT NULL, moq_sets INTEGER NOT NULL, actual_sets INTEGER NOT NULL, actual_complete_sets INTEGER NOT NULL,
          goods_cny_total REAL CHECK(goods_cny_total > 0),
          domestic_freight_cny_total REAL CHECK((quote_status IN ('pending', 'incomplete_cross_factory_kit') AND (domestic_freight_cny_total IS NULL OR domestic_freight_cny_total >= 0)) OR (quote_status NOT IN ('pending', 'incomplete_cross_factory_kit') AND domestic_freight_cny_total IS NOT NULL AND domestic_freight_cny_total >= 0)),
          pkg_json TEXT, fx_cny_per_usd REAL, factory_id TEXT, spec_variant_key TEXT, kit_note TEXT,
          goods_first_order_promotion INTEGER NOT NULL, freight_first_order_promotion INTEGER NOT NULL,
          lead_time_days INTEGER, sensitive_freebie_flags_json TEXT NOT NULL, redacted_destination TEXT NOT NULL,
          redacted_screenshot_path TEXT, redacted_webp_sha256 TEXT, raw_readback_ref TEXT,
          observed_at TEXT NOT NULL, expires_at TEXT, quote_status TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO candidate_forms VALUES ('f-exp','f-exp',1,'sha','Exp Test','Task','[{"component_id":"unit","qty_per_saleable_set":1}]','discovered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        INSERT INTO sourcing_quotes_1688 VALUES
          ('q-expired-cheap','f-exp',1,'[]',NULL,1,100,100,100,3500,500,NULL,7.2,'fac-old','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://old','2026-01-01T00:00:00Z','2026-02-01','superseded_uncompetitive','2026-01-01T00:00:00Z'),
          ('q-active-cur','f-exp',1,'[]',NULL,1,100,100,100,4000,0,NULL,7.2,'fac-cur','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://cur','2026-11-20T00:00:00Z',NULL,'verified','2026-11-20T00:00:00Z');
      `);
    } finally {
      rawExp.close();
    }
    const expStore = openSelectionStore(expDbPath);
    try {
      assert.equal(expStore.getQuoteById('q-expired-cheap').quote_status, 'superseded_uncompetitive', 'Expired quote must NOT be resurrected by migration rerank');
      assert.equal(expStore.getQuoteById('q-active-cur').quote_status, 'verified', 'Active quote must stay verified when only cheaper peer is expired');
    } finally {
      expStore.close();
    }

    const expRecStore = openSelectionStore(join(dir, 'expired-rec.sqlite'));
    try {
      expRecStore.upsertCandidateForm({
        form_id: 'f-exp-rec', product_family_key: 'f-exp-rec', label: 'Exp Rec', buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      expRecStore.db.prepare(`
        INSERT INTO sourcing_quotes_1688 (
          quote_id, form_id, spec_version, sku_lines_json, order_plan_json, pack_multiple, moq_sets, actual_sets, actual_complete_sets,
          goods_cny_total, domestic_freight_cny_total, pkg_json, fx_cny_per_usd, factory_id, spec_variant_key, kit_note,
          goods_first_order_promotion, freight_first_order_promotion, lead_time_days, sensitive_freebie_flags_json,
          redacted_destination, redacted_screenshot_path, redacted_webp_sha256, raw_readback_ref, observed_at, expires_at, quote_status, created_at
        ) VALUES ('q-exp-ver','f-exp-rec',1,'[]',NULL,1,100,100,100,3500,NULL,NULL,7.2,'fac-exp','v1',NULL,0,0,7,'{}','广东深圳',NULL,NULL,'rb://e','2026-01-01T00:00:00Z','2026-02-01','verified','2026-01-01T00:00:00Z')
      `).run();
      const freshRec = expRecStore.recordSourcingQuote1688({
        quote_id: 'q-fresh-40', form_id: 'f-exp-rec', factory_id: 'fac-new', spec_variant_key: 'v1',
        observed_at: '2026-11-26T10:00:00Z', redacted_destination: '广东深圳',
        goods_first_order_promotion: false, quote_status: 'verified',
        goods_cny_total: 4000, domestic_freight_cny_total: null, fx_cny_per_usd: 7.2,
        raw_readback_ref: 'rb://fresh',
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{ component_id: 'unit', offer_id: 'o-f', sku_id: 's-f', factory_id: 'fac-new', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 40, regular_goods_promo_false: true }],
      });
      assert.equal(freshRec.quote.quote_status, 'verified', 'Fresh quote must NOT be superseded by an expired verified quote');
    } finally {
      expRecStore.close();
    }
  });
});

test('Issue #23 adversarial review regressions: raw-ingest SP-API calibration preserves $0 placement & recalibrates carton headhaul, Stage 3 rejects [0,0]+us_west_single, and report renders pending bare-goods + mobile CSS cleanly', async () => {
  await withTempDirAsync('issue23-adv-e2e-', async dir => {
    const spDb = join(dir, 'sp-bare.sqlite');
    const spStore = openSelectionStore(spDb);
    try {
      spStore.upsertCandidateForm({
        form_id: 'form-sp-bare', product_family_key: 'form-sp-bare', label: 'SP Bare', buyer_task: 'Task',
        saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }],
      });
      spStore.recordSourcingQuote1688({
        quote_id: 'q-sp-bare', form_id: 'form-sp-bare', factory_id: 'fac-sp',
        observed_at: '2026-11-26T10:00:00Z', redacted_destination: '广东深圳',
        goods_first_order_promotion: false, freight_first_order_promotion: true,
        bare_goods_screening: true, quote_status: 'verified',
        goods_cny_total: 4200, domestic_freight_cny_total: 500, fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG,
        raw_readback_ref: 'rb://sp-bare',
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{ component_id: 'unit', offer_id: 'o-sp', sku_id: 's-sp', factory_id: 'fac-sp', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true }],
      });

      const makeSpCand = (id, cartonWtKg) => {
        const c = structuredClone(synthBatch.candidates[0]);
        c.id = id;
        c.form_id = 'form-sp-bare';
        c.screening.reference_price_usd = {
          value: 45, unit: 'USD', matched_spec: true, target_variant_asin: 'B0SYNSP001',
          fulfillment_channel: 'FBA', sales_history_supported: true, evidence: ['synthetic-evidence'],
        };
        for (const sc of c.economics.scenarios) {
          sc.quote_id = 'q-sp-bare';
          sc.cost_ledger.cost_basis = 'bare_goods_1688';
          sc.cost_ledger.fx_cny_per_usd = 7.2;
          sc.cost_ledger.order_units = 100;
          sc.cost_ledger.multi_destination_headhaul_verified = true;
          sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
          const proc = sc.cost_ledger.lines.find(l => l.id === 'procurement');
          proc.amount_usd = Number((42 / 7.2).toFixed(6));
          proc.order_units = 100;
          proc.first_order_promotion = false;
          const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
          plc.amount_usd = 0;
          plc.split_option = 'amazon_optimized';
          plc.fee_basis = { ...(plc.fee_basis ?? {}), split_option: 'amazon_optimized' };
          const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
          hh.cny_derivation = {
            carton_count: 4, weight_per_carton_kg: cartonWtKg, carton_cm: [30, 30, 30],
            rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0,
          };
          hh.amount_usd = Number(((4 * cartonWtKg * 11) / 100 / 7.2).toFixed(6));
        }
        return c;
      };

      const ingHeavier = ingestTrialSpecification({
        profile_revision: 59, allow_synthetic_without_receipts: true, evidence: synthBatch.evidence,
        candidates: [{
          candidate: makeSpCand('cand-sp-heavier', 15),
          sp_api_calibration_inputs: {
            asin: 'B0SYNSP001', price_usd: 45,
            catalogItemRaw: {
              asin: 'B0SYNSP001',
              dimensions: [{ marketplaceId: 'ATVPDKIKX0DER', package: { length: { value: 10, unit: 'inches' }, width: { value: 8, unit: 'inches' }, height: { value: 3, unit: 'inches' }, weight: { value: 2.0, unit: 'pounds' } } }],
            },
          },
        }],
      }, r59Profile, { store: spStore });
      const lHeavier = ingHeavier.batch.candidates[0].economics.scenarios[0].cost_ledger;
      assert.equal(lHeavier.lines.find(l => l.id === 'placement').amount_usd, 0, 'SP-API calibration must preserve steady-state $0 amazon_optimized placement');
      const hhHeavierAmt = lHeavier.lines.find(l => l.id === 'headhaul').amount_usd;
      assert.ok(hhHeavierAmt > 1.35 && hhHeavierAmt < 1.42, `Expected SP-API 2.0 lb headhaul ~$1.386, got ${hhHeavierAmt}`);

      const ingLighter = ingestTrialSpecification({
        profile_revision: 59, allow_synthetic_without_receipts: true, evidence: synthBatch.evidence,
        candidates: [{
          candidate: makeSpCand('cand-sp-lighter', 15),
          sp_api_calibration_inputs: {
            asin: 'B0SYNSP001', price_usd: 45,
            catalogItemRaw: {
              asin: 'B0SYNSP001',
              dimensions: [{ marketplaceId: 'ATVPDKIKX0DER', package: { length: { value: 8, unit: 'inches' }, width: { value: 6, unit: 'inches' }, height: { value: 2, unit: 'inches' }, weight: { value: 1.0, unit: 'pounds' } } }],
            },
          },
        }],
      }, r59Profile, { store: spStore });
      const lLighter = ingLighter.batch.candidates[0].economics.scenarios[0].cost_ledger;
      assert.equal(lLighter.lines.find(l => l.id === 'placement').amount_usd, 0);
      const hhLighterAmt = lLighter.lines.find(l => l.id === 'headhaul').amount_usd;
      assert.ok(Math.abs(hhLighterAmt - ((60 * 11) / 100 / 7.2)) < 1e-6, `Lighter SP-API unit weight must not underbill 60 kg master carton ($0.9167), got ${hhLighterAmt}`);
    } finally {
      spStore.close();
    }

    const st3Db = join(dir, 'stage3-uswest.sqlite');
    const st3Store = openSelectionStore(st3Db);
    try {
      const kaiqiHh = { carton_count: 5, weight_per_carton_kg: 12, rate_cny_per_kg: 10.0, surcharge_cny_per_kg: 0, bond_cny_per_kg: 1.0 };
      const st3Est = estimateGate1A2027({
        pkg: ISSUE23_STD_PKG, price_usd: 45, fx_cny_per_usd: 7.2, refund_fraction: 0.04,
        fee_category: 'Home and Kitchen', referral_terms: ISSUE23_REF_TERMS, collection_rate: 0.006,
        order_units: 100, headhaul: kaiqiHh, profile_revision: 59,
      });
      const st3FulUsd = st3Est.components.fulfillment.total_usd;
      const st3HhUsd = st3Est.components.headhaul.amount_usd;
      const st3Out = await runPhase2Batch(st3Store, {
        profile: r59Profile,
        as_of_date: '2026-11-26',
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-st3-usw', factory_id: 'fac-st3', observed_at: '2026-11-26T10:00:00Z',
            redacted_destination: '广东深圳', raw_readback_ref: 'rb://st3',
            goods_first_order_promotion: false, freight_first_order_promotion: false,
            fx_cny_per_usd: 7.2, pkg: ISSUE23_STD_PKG,
            ui_readback: DEFAULT_R59_UI_READBACK,
            sku_lines: [{ component_id: 'unit', offer_id: 'o-s3', sku_id: 's-s3', factory_id: 'fac-st3', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 100, ordered_qty: 100, unit_price_cny: 42, regular_goods_promo_false: true }],
            goods_cny_total: 4200, domestic_freight_cny_total: null,
          },
        }),
        deep_research_executor: async ({ form }) => {
          const batchCopy = structuredClone(synthBatch);
          const c = batchCopy.candidates[0];
          c.id = form.form_id;
          c.form_id = form.form_id;
          const sc = c.economics.scenarios[0];
          sc.id = 'sc-st3-usw';
          sc.quote_id = 'q-st3-usw';
          sc.cost_ledger.price_usd = 45;
          sc.cost_ledger.fx_cny_per_usd = 7.2;
          sc.cost_ledger.order_units = 100;
          sc.cost_ledger.cost_basis = 'bare_goods_1688';
          sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
          sc.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = Number((42 / 7.2).toFixed(6));
          sc.cost_ledger.lines.find(l => l.id === 'fulfillment').amount_usd = st3FulUsd;
          const plc = sc.cost_ledger.lines.find(l => l.id === 'placement');
          plc.amount_usd = 0;
          plc.split_option = 'amazon_optimized';
          plc.fee_basis = { ...(plc.fee_basis ?? {}), split_option: 'amazon_optimized' };
          const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
          hh.amount_usd = st3HhUsd;
          hh.cny_derivation = { ...kaiqiHh, destination_scope: 'us_west_single' };
          c.economics.scenarios = [sc];
          batchCopy.candidates = [c];
          return { batch: batchCopy };
        },
        items: [{
          leads: [{
            lead_id: 'lead-st3-usw', source_channel: 'reddit',
            source_ref: 'https://www.reddit.com/r/tools/comments/st3usw/',
            phrase_or_title: 'synthetic organizer', observed_at: '2026-11-26', disposition: 'product',
          }],
          form: { form_id: 'form-st3-usw', label: 'Stage 3 USW Guard', buyer_task: 'Task', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] },
          gate1a_scenarios: [{
            id: 'sc-st3-usw', price_usd: 45, pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2, order_units: 100,
            refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen',
            referral_terms: ISSUE23_REF_TERMS, headhaul: kaiqiHh, collection_rate: 0.006, other_applicable_usd: 0,
          }],
          early_screen_builder: () => [{
            profile_revision: 59, id: 'sc-st3-usw', saleable_unit: '1 organizer',
            price_usd: 45, pkg: ISSUE23_STD_PKG, fx_cny_per_usd: 7.2,
            order_units: 100, headhaul: kaiqiHh, refund_fraction: 0.04, physical_return_fraction: 0.04,
            return_threshold: 0.081, returns_processing_usd: 0, fee_category: 'Home and Kitchen',
            referral_terms: ISSUE23_REF_TERMS, fulfillment_usd: st3FulUsd, placement_usd: 0,
            placement_split_option: 'amazon_optimized',
            storage: { cubic_feet_per_unit: (10 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'pkg-std', ...ISSUE23_WIN_2027 },
            collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: false, strong_date_dependency: false,
          }],
        }],
      });
      const st3Entry = st3Out.gate2_3.find(x => x.form_id === 'form-st3-usw');
      assert.equal(st3Entry.status, 'gate2_3_error');
      assert.match(st3Entry.error, /US-West single-warehouse|us_west_single/i);
    } finally {
      st3Store.close();
    }

    const pendingBareBatch = structuredClone(synthBatch);
    const pCand = pendingBareBatch.candidates[0];
    pendingBareBatch.candidates = [pCand];
    for (const sc of pCand.economics.scenarios) {
      sc.cost_ledger.cost_basis = 'bare_goods_1688';
      sc.cost_ledger.lines = sc.cost_ledger.lines.filter(l => l.id !== 'domestic_freight');
      if (sc.cost_ledger.source_inputs) delete sc.cost_ledger.source_inputs.domestic_per_unit_cny;
      const hh = sc.cost_ledger.lines.find(l => l.id === 'headhaul');
      hh.status = 'pending';
      hh.amount_usd = null;
    }
    const stBareLedger = structuredClone(synthBatch.candidates[0].economics.scenarios[0].cost_ledger);
    stBareLedger.id = 'st-bare-1';
    stBareLedger.cost_basis = 'bare_goods_1688';
    stBareLedger.lines = stBareLedger.lines.filter(l => l.id !== 'domestic_freight');
    pCand.economics.stress_scenarios = [
      { id: 'st-bare-1', label: 'Promo Stress', cost_ledger: stBareLedger },
    ];

    const pScored = scoreBatch(pendingBareBatch, r59Profile);
    const pHtml = renderReport(pScored, pendingBareBatch, r59Profile);
    assert.ok(pHtml.includes('1688百套裸货'), 'Pending bare-goods card must render 1688百套裸货');
    assert.ok(pHtml.includes('保 30% 裸货封顶'), 'Pending bare-goods card hero must render 保 30% 裸货封顶');
    assert.ok(pHtml.includes('保30%裸货上限'), 'Stress scenario on bare-goods card must render 保30%裸货上限');
    assert.ok(pHtml.includes(ISSUE23_EXPECTED_DISCLOSURE), 'Pending bare-goods card must render mandatory bare-goods disclosure');
    assert.ok(pHtml.includes('--m4:"1688百套裸货"'), 'Mobile CSS @container override must match bare-goods overview header');
  });
});

test('Step 4 Sign-Off (#7 & #8): r59 17x13=221 order plan + ¥20.20 per-complete-set math, unverified offer_ids quota, >3 quotes block, and sequential stop at >=30%', async () => {
  const baseTwoSkuLines = [
    { component_id: 'part-a', offer_id: 'off-1', sku_id: 's-17', pack_multiple: 17, qty_per_saleable_set: 1, moq_qty: 1, unit_price_cny: 10, regular_goods_promo_false: true },
    { component_id: 'part-b', offer_id: 'off-1', sku_id: 's-13', pack_multiple: 13, qty_per_saleable_set: 1, moq_qty: 1, unit_price_cny: 10, regular_goods_promo_false: true },
  ];
  assert.throws(() => validateSourcingVerifier1688Output({
    schema_version: 1, contract: 'SourcingVerifier1688', status: 'verified', observed_at: '2026-11-24',
    redacted_destination: '广东深圳', raw_readback_ref: 'synth-readback-102',
    goods_first_order_promotion: false, freight_first_order_promotion: false, allow_remainder: false,
    sku_lines: [{ ...baseTwoSkuLines[0], ordered_qty: 102 }, { ...baseTwoSkuLines[1], ordered_qty: 104 }],
    goods_cny_total: 2060, domestic_freight_cny_total: 100,
  }), /221/);

  const verified221 = validateSourcingVerifier1688Output({
    schema_version: 1, contract: 'SourcingVerifier1688', status: 'verified', observed_at: '2026-11-24',
    redacted_destination: '广东深圳', raw_readback_ref: 'synth-readback-221',
    goods_first_order_promotion: false, freight_first_order_promotion: false, allow_remainder: false,
    sku_lines: [{ ...baseTwoSkuLines[0], ordered_qty: 221 }, { ...baseTwoSkuLines[1], ordered_qty: 221 }],
    goods_cny_total: 4420, domestic_freight_cny_total: 150,
  });
  assert.equal(verified221.order_plan.allocated_sets, 221);
  assert.equal(verified221.order_plan.per_complete_set_goods_cny, 20);

  const remPlan = computeOrderPlan({ sku_lines: baseTwoSkuLines, allow_remainder: true });
  assert.equal(remPlan.actual_complete_sets, 102);
  assert.equal(remPlan.total_goods_cny, 2060);
  assert.ok(Math.abs(remPlan.per_complete_set_goods_cny - (2060 / 102)) < 1e-9);

  const store = openSelectionStore(':memory:');
  try {
    const pkg = { length_in: 12, width_in: 8, height_in: 3, unit_weight_lb: 1.5 };
    store.upsertCandidateForm({ form_id: 'form-unverified-offers', label: 'Unverified Offer IDs Test', buyer_task: 'Hold cables', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] });
    const g1a = runGate1AForForm(store, {
      form_id: 'form-unverified-offers',
      scenarios: [{ id: 'sc-40', price_usd: 40.00, pkg, fx_cny_per_usd: 7.20, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 }, headhaul_usd: 1.80, collection_rate: 0.006 }],
    });
    assert.equal(g1a.proceed_to_gate1b, true);

    const makeQuoteObj = (idx, unitCny, factoryId = undefined) => ({
      quote_id: `q-off-${idx}`, ...(factoryId ? { factory_id: factoryId } : {}),
      observed_at: '2026-11-24', redacted_destination: '广东深圳', raw_readback_ref: `ref-${idx}`,
      fx_cny_per_usd: 7.20, pkg, goods_first_order_promotion: false, freight_first_order_promotion: false, ui_readback: DEFAULT_R59_UI_READBACK,
      sku_lines: [{ component_id: 'unit', offer_id: `distinct-offer-link-${idx}`, sku_id: `sku-${idx}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: unitCny, regular_goods_promo_false: true }],
      goods_cny_total: unitCny * 100, domestic_freight_cny_total: 150,
    });
    const esBuilder = ({ form }) => {
      const d = JSON.parse(form.gate1a_result_json).declared_scenarios[0];
      return [{
        id: d.id, saleable_unit: '1 unit', price_usd: 40.00, fx_cny_per_usd: 7.20, pkg,
        headhaul: { usd_per_unit: 1.80, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04,
        return_threshold: 0.081, returns_processing_usd: 0, is_apparel_or_shoes: false,
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        fulfillment_usd: d.fulfillment_usd, placement_usd: d.placement_range_usd[1],
        storage: { cubic_feet_per_unit: (12 * 8 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9],
        fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
        collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
      }];
    };

    const overCap = await runGate1BForForm(store, {
      form_id: 'form-unverified-offers',
      sourcing_executor: async () => ({ status: 'quoted', quotes: [makeQuoteObj(1, 140, 'f1'), makeQuoteObj(2, 139, 'f2'), makeQuoteObj(3, 138, 'f3'), makeQuoteObj(4, 137, 'f4')] }),
      early_screen_builder: esBuilder,
    });
    assert.equal(overCap.status, 'gate1b_pending');
    assert.equal(store.getQuotesForForm('form-unverified-offers').length, 0);

    const unverifiedRes = await runGate1BForForm(store, {
      form_id: 'form-unverified-offers',
      sourcing_executor: async () => ({ status: 'quoted', quotes: [makeQuoteObj(10, 145), makeQuoteObj(11, 142), makeQuoteObj(12, 140)] }),
      early_screen_builder: esBuilder,
    });
    assert.equal(unverifiedRes.status, 'gate1b_rejected');
    assert.equal(unverifiedRes.checked_factory_quotes_count, 0);
    assert.equal(unverifiedRes.second_factory_quote_needed, true);

    store.upsertCandidateForm({ form_id: 'form-stop-at-1', label: 'Stop At First Passing Factory', buyer_task: 'Hold cables', saleable_set_composition: [{ component_id: 'unit', qty_per_saleable_set: 1 }] });
    runGate1AForForm(store, {
      form_id: 'form-stop-at-1',
      scenarios: [{ id: 'sc-40', price_usd: 40.00, pkg, fx_cny_per_usd: 7.20, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 }, headhaul_usd: 1.80, collection_rate: 0.006 }],
    });
    let executorCalls = 0;
    const stopRes = await runGate1BForForm(store, {
      form_id: 'form-stop-at-1',
      sourcing_executor: async () => {
        executorCalls += 1;
        return { status: 'quoted', has_more_factories: true, quote: makeQuoteObj(executorCalls, 45, `fac-pass-${executorCalls}`) };
      },
      early_screen_builder: esBuilder,
    });
    assert.equal(stopRes.status, 'gate1b_passed');
    assert.equal(executorCalls, 1, 'Must stop immediately after 1st factory clears >= 30%');
    assert.equal(stopRes.second_factory_quote_needed, false);
  } finally {
    store.close();
  }
});

test('1688 superseded_uncompetitive archival, expires_at:null, incomplete_cross_factory_kit, same-factory SKU deduplication, and sequential batch stop/CAPTCHA_PAUSED', async () => {
  await withTempDirAsync('sourcing-r1-r3-', async dir => {
    const gateDb = openSelectionStore(':memory:');
    try {
      gateDb.upsertCandidateForm({ form_id: 'form-1688-supersede', label: 'Walnut Tray', buyer_task: 'Serve espresso', saleable_set_composition: [{ component_id: 'tray', qty_per_saleable_set: 1 }] });
      runGate1AForForm(gateDb, {
        form_id: 'form-1688-supersede',
        scenarios: [{
          id: 'sc-tray',
          price_usd: 49.99,
          pkg: { length_in: 12, width_in: 8, height_in: 2, weight_lb: 1.5 },
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          headhaul_usd: 2.2,
          collection_rate: 0.006,
        }],
      });
      const qExpensive = gateDb.recordSourcingQuote1688({
        quote_id: 'q-expensive-first',
        form_id: 'form-1688-supersede',
        spec_variant_key: 'walnut-24cm-fullkit',
        observed_at: '2026-11-24',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-q-exp',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{ component_id: 'tray', offer_id: 'off-expensive', sku_id: 's1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 165, regular_goods_promo_false: true }],
        goods_cny_total: 16500,
        domestic_freight_cny_total: 200,
      }).quote;
      assert.equal(qExpensive.expires_at, null, 'Quotes keep expires_at: null with zero 30-day expiry nag');

      gateDb.recordSourcingQuote1688({
        quote_id: 'q-cheaper-second',
        form_id: 'form-1688-supersede',
        spec_variant_key: 'walnut-24cm-fullkit',
        observed_at: '2026-11-24',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-q-cheap',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [{ component_id: 'tray', offer_id: 'off-cheaper', sku_id: 's2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 72, regular_goods_promo_false: true }],
        goods_cny_total: 7200,
        domestic_freight_cny_total: 180,
      });
      const allQuotes = gateDb.getQuotesForForm('form-1688-supersede');
      assert.equal(allQuotes.find(q => q.quote_id === 'q-expensive-first').quote_status, 'superseded_uncompetitive');
      assert.equal(allQuotes.find(q => q.quote_id === 'q-cheaper-second').quote_status, 'verified');

      gateDb.upsertCandidateForm({
        form_id: 'form-cross-factory',
        label: '2-Part Set',
        buyer_task: 'Hold rack',
        saleable_set_composition: [
          { component_id: 'rack', qty_per_saleable_set: 1 },
          { component_id: 'velvet_bag', qty_per_saleable_set: 1 },
        ],
      });
      const crossKit = gateDb.recordSourcingQuote1688({
        quote_id: 'q-cross-factory',
        form_id: 'form-cross-factory',
        observed_at: '2026-11-24',
        redacted_destination: '广东深圳',
        raw_readback_ref: 'ev-cross',
        goods_first_order_promotion: false,
        freight_first_order_promotion: false,
        ui_readback: DEFAULT_R59_UI_READBACK,
        sku_lines: [
          { component_id: 'rack', factory_id: 'factory-A', offer_id: 'offer-A', sku_id: 'sA', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 50, regular_goods_promo_false: true },
          { component_id: 'velvet_bag', factory_id: 'factory-B', offer_id: 'offer-B', sku_id: 'sB', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 10, regular_goods_promo_false: true },
        ],
        goods_cny_total: 6000,
        domestic_freight_cny_total: 200,
      }).quote;
      assert.equal(crossKit.quote_status, 'incomplete_cross_factory_kit');

      gateDb.upsertCandidateForm({ form_id: 'form-h5-oob', label: 'Out of band check', buyer_task: 'Hold plates', saleable_set_composition: [{ component_id: 'stand', qty_per_saleable_set: 1 }] });
      const datedOob = (asin, priceUsd) => makeDatedKeepaReceipt({ asin, startDate: '2026-08-30', days: 90, priceUsd }).keepa_trend;
      const pbOob = analyzeMainstreamPriceBand([
        { asin: 'B0SYNVET01', title: 'Veteran 1', price_usd: 27.99, monthly_units: 120, fulfillment: 'FBA', age_days: 420, keepa_trend: datedOob('B0SYNVET01', 27.99) },
        { asin: 'B0SYNVET02', title: 'Veteran 2', price_usd: 28.99, monthly_units: 110, fulfillment: 'FBA', age_days: 400, keepa_trend: datedOob('B0SYNVET02', 28.99) },
        { asin: 'B0SYNNEW45', title: 'Newcomer 45', price_usd: 45.00, monthly_units: 60, fulfillment: 'FBA', age_days: 30 },
      ], { profile_revision: 59, as_of_date: STAGE4_AS_OF_DATE });
      const g1aOob = runGate1AForForm(gateDb, {
        form_id: 'form-h5-oob',
        profile_revision: 59,
        price_band_analysis: pbOob,
        scenarios: [
          { id: 'sc-vet-28', asin: 'B0SYNVET02', price_usd: 28.99, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 },
          { id: 'sc-new-45', asin: 'B0SYNNEW45', price_usd: 45.00, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 },
        ],
      });
      assert.equal(g1aOob.gate_status, 'gate1a_rejected');

      const seqPkg = { length_in: 12, width_in: 8, height_in: 3, weight_lb: 1.5 };
      gateDb.upsertCandidateForm({ form_id: 'form-h2-seq', label: 'Sequential 2nd factory', buyer_task: 'Hold mugs', saleable_set_composition: [{ component_id: 'rack', qty_per_saleable_set: 1 }] });
      const g1aSeq = runGate1AForForm(gateDb, {
        form_id: 'form-h2-seq',
        profile_revision: 59,
        strong_date_dependency: false,
        scenarios: [{ id: 'sc-45', price_usd: 45.00, pkg: seqPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 2.0, collection_rate: 0.006 }],
      });
      const seqDecl = g1aSeq.declared_scenarios[0];
      const seqCuFt = (12 * 8 * 3) / 1728;
      const seqEarlyBuilder = () => ({
        profile_revision: 59,
        id: seqDecl.id,
        saleable_unit: '1 mug rack',
        price_usd: seqDecl.price_usd,
        fx_cny_per_usd: seqDecl.fx_cny_per_usd,
        pkg: seqPkg,
        headhaul: { chargeable_kg_per_unit: 0.68, rate_cny_per_kg: 12, bond_cny_per_shipment: 624 },
        refund_fraction: 0.04,
        physical_return_fraction: 0.04,
        return_threshold: 0.081,
        returns_processing_usd: 0,
        is_apparel_or_shoes: false,
        referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
        fulfillment_usd: seqDecl.fulfillment_usd,
        placement_usd: seqDecl.placement_range_usd[1],
        storage: { cubic_feet_per_unit: seqCuFt, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
        operating_period: 'off_peak',
        fee_context: {
          marketplace: 'US',
          currency: 'USD',
          package_ref: 'pack-mug',
          sales: FBA_2027_DEFAULT_OFF_PEAK_WINDOW,
          storage: FBA_2027_DEFAULT_OFF_PEAK_STORAGE_WINDOW,
          inbound: { from: '2027-01-15', through: '2027-02-01' },
        },
        collection_rate: 0.006,
        other_applicable_usd: 0,
        specific_rights_conflict: 'unknown',
        strong_date_dependency: false,
      });
      const g1bFirstFail = await runGate1BForForm(gateDb, {
        form_id: 'form-h2-seq',
        profile_revision: 59,
        as_of_date: '2026-11-24',
        early_screen_builder: seqEarlyBuilder,
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-seq-1-exp',
            spec_variant_key: 'mug-rack-std',
            observed_at: '2026-11-24',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-seq-1',
            fx_cny_per_usd: 7.2,
            pkg: seqPkg,
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            ui_readback: DEFAULT_R59_UI_READBACK,
            sku_lines: [{ component_id: 'rack', offer_id: 'off-1', sku_id: 'sk-1', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 155, regular_goods_promo_false: true }],
            goods_cny_total: 15500,
            domestic_freight_cny_total: 200,
          },
        }),
      });
      assert.equal(g1bFirstFail.status, 'gate1b_rejected');
      assert.equal(g1bFirstFail.second_factory_quote_needed, true);

      const g1bSecondPass = await runGate1BForForm(gateDb, {
        form_id: 'form-h2-seq',
        profile_revision: 59,
        as_of_date: '2026-11-24',
        early_screen_builder: seqEarlyBuilder,
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-seq-2-cheap',
            spec_variant_key: 'mug-rack-std',
            observed_at: '2026-11-24',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-seq-2',
            fx_cny_per_usd: 7.2,
            pkg: seqPkg,
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            ui_readback: DEFAULT_R59_UI_READBACK,
            sku_lines: [{ component_id: 'rack', offer_id: 'off-2', sku_id: 'sk-2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 62, regular_goods_promo_false: true }],
            goods_cny_total: 6200,
            domestic_freight_cny_total: 180,
          },
        }),
      });
      assert.equal(g1bSecondPass.status, 'gate1b_passed');
      assert.equal(g1bSecondPass.second_factory_quote_needed, false);

      let secondCandidate1688Called = false;
      const batchPauseOut = await runPhase2Batch(gateDb, {
        profile: r59Profile,
        as_of_date: '2026-11-24',
        items: [
          {
            form: { form_id: 'form-cap-1', label: 'Cap 1', buyer_task: 'Task 1', saleable_set_composition: [{ component_id: 'c1', qty_per_saleable_set: 1 }] },
            leads: [{ lead_id: 'ld-cap-1', source_channel: 'reddit', source_ref: 'https://www.reddit.com/r/synth/1', phrase_or_title: 'Synth 1', observed_at: '2026-11-24', disposition: 'product' }],
            gate1a_scenarios: [{ id: 'sc-c1', price_usd: 45.00, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
            sourcing_executor: async () => ({ status: 'captcha_triggered', reason: '1688 slider verification appeared' }),
          },
          {
            form: { form_id: 'form-cap-2', label: 'Cap 2', buyer_task: 'Task 2', saleable_set_composition: [{ component_id: 'c2', qty_per_saleable_set: 1 }] },
            leads: [{ lead_id: 'ld-cap-2', source_channel: 'reddit', source_ref: 'https://www.reddit.com/r/synth/2', phrase_or_title: 'Synth 2', observed_at: '2026-11-24', disposition: 'product' }],
            gate1a_scenarios: [{ id: 'sc-c2', price_usd: 45.00, pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.2 }, fx_cny_per_usd: 7.2, refund_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
            sourcing_executor: async () => { secondCandidate1688Called = true; throw new Error('Must not run after CAPTCHA_PAUSED'); },
          },
        ],
      });
      assert.equal(batchPauseOut.batch_paused, true);
      assert.equal(batchPauseOut.resumable, true);
      assert.equal(secondCandidate1688Called, false);
    } finally {
      gateDb.close();
    }

    const r2DbPath = join(dir, 'r2-gate.sqlite');
    const r2Store = openSelectionStore(r2DbPath);
    try {
      const stdPkg = { length_in: 14, width_in: 10, height_in: 3, unit_weight_lb: 1.4 };
      let batchFactoryCalls = 0;
      const seqBatchItem = {
        form: { form_id: 'form-r2-h2-batch', label: 'Batch Seq', buyer_task: 'Hold mugs', saleable_set_composition: [{ component_id: 'rack', qty_per_saleable_set: 1 }] },
        leads: [{ lead_id: 'ld-r2-h2', source_channel: 'reddit', source_ref: 'https://www.reddit.com/r/synth/h2', phrase_or_title: 'Mug rack', observed_at: '2026-11-24', disposition: 'product' }],
        gate1a_scenarios: [{ id: 'sc-b1', price_usd: 45.00, pkg: stdPkg, fx_cny_per_usd: 7.2, refund_fraction: 0.04, physical_return_fraction: 0.04, fee_category: 'Home and Kitchen', referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 }, headhaul_usd: 1.8, collection_rate: 0.006 }],
        early_screen_builder: ({ form }) => {
          const ds = JSON.parse(form.gate1a_result_json).declared_scenarios;
          return [{
            id: ds[0].id, saleable_unit: '1 unit', price_usd: 45.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
            headhaul: { usd_per_unit: 1.8, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0,
            is_apparel_or_shoes: false, referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            fulfillment_usd: ds[0].fulfillment_usd, placement_usd: ds[0].placement_range_usd[1],
            storage: { cubic_feet_per_unit: (14 * 10 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
            collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
          }];
        },
        sourcing_executor: async () => {
          batchFactoryCalls += 1;
          const unitCny = batchFactoryCalls === 1 ? 150 : 42;
          return {
            status: 'quoted',
            quote: {
              quote_id: `q-r2-b-${batchFactoryCalls}`,
              spec_variant_key: 'mug-rack-v1',
              observed_at: '2026-11-24',
              redacted_destination: '广东深圳',
              raw_readback_ref: `ev-b-${batchFactoryCalls}`,
              fx_cny_per_usd: 7.2,
              pkg: stdPkg,
              goods_first_order_promotion: false,
              freight_first_order_promotion: false,
              ui_readback: DEFAULT_R59_UI_READBACK,
              sku_lines: [{ component_id: 'rack', offer_id: `ob-${batchFactoryCalls}`, sku_id: `sb-${batchFactoryCalls}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: unitCny, regular_goods_promo_false: true }],
              goods_cny_total: unitCny * 100,
              domestic_freight_cny_total: 150,
            },
          };
        },
      };
      const bRun1 = await runPhase2Batch(r2Store, { profile: r59Profile, as_of_date: '2026-11-24', items: [seqBatchItem] });
      assert.equal(bRun1.gate1b[0].status, 'gate1b_rejected');
      assert.equal(bRun1.gate1b[0].second_factory_quote_needed, true);
      assert.equal(batchFactoryCalls, 1);

      const bRun2 = await runPhase2Batch(r2Store, { profile: r59Profile, as_of_date: '2026-11-24', items: [seqBatchItem] });
      assert.equal(batchFactoryCalls, 2);
      assert.equal(bRun2.gate1b[0].status, 'gate1b_passed');

      r2Store.pauseQueue('gate1b_1688_queue', 'Persistent slider', { paused_form_id: 'form-r2-h2-batch' });
      let deepCalledWhilePaused = false;
      const bPaused = await runPhase2Batch(r2Store, {
        profile: r59Profile,
        as_of_date: '2026-11-24',
        items: [seqBatchItem],
        deep_research_executor: async () => { deepCalledWhilePaused = true; throw new Error('Must not run while CAPTCHA_PAUSED'); },
      });
      assert.equal(bPaused.batch_paused, true);
      assert.equal(deepCalledWhilePaused, false);

      const spAtt1 = r2Store.reserveRequestAttempt({
        account_scope: 'sp-test',
        provider: 'sp_api',
        tool_name: 'sp_api_execute',
        observation_cutoff_date: '2026-11-24',
        params: { method: 'GET', path: '/catalog/2022-04-01/items/B000000001' },
      });
      const spAtt2 = r2Store.reserveRequestAttempt({
        account_scope: 'sp-test',
        provider: 'sp_api',
        tool_name: 'mcp__codex_apps__amz_spapi_sp_api_execute',
        observation_cutoff_date: '2026-11-24',
        params: { method: 'GET', path: '/catalog/2022-04-01/items/B000000001' },
      });
      assert.equal(spAtt1.logical_request_key, spAtt2.logical_request_key);
    } finally {
      r2Store.close();
    }

    const r3Store = openSelectionStore(join(dir, 'r3-store.sqlite'));
    try {
      const stdPkg = { length_in: 14, width_in: 10, height_in: 3, unit_weight_lb: 1.4 };
      r3Store.upsertCandidateForm({
        form_id: 'form-r3-same-fac',
        label: 'Same Factory Multi-SKU',
        buyer_task: 'Hold plates',
        saleable_set_composition: [{ component_id: 'stand', qty_per_saleable_set: 1 }],
      });
      await runGate1AForForm(r3Store, {
        form_id: 'form-r3-same-fac',
        profile_revision: 59,
        scenarios: [{
          id: 'sc-sf1',
          price_usd: 42.00,
          pkg: stdPkg,
          fx_cny_per_usd: 7.2,
          refund_fraction: 0.04,
          physical_return_fraction: 0.04,
          fee_category: 'Home and Kitchen',
          referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
          headhaul_usd: 1.8,
          collection_rate: 0.006,
        }],
      });
      for (const idx of [1, 2]) {
        r3Store.recordSourcingQuote1688({
          quote_id: `q-samefac-${idx}`,
          form_id: 'form-r3-same-fac',
          factory_id: 'fac-1',
          spec_variant_key: `sku-var-${idx}`,
          observed_at: '2026-11-24',
          redacted_destination: '广东深圳',
          raw_readback_ref: `ev-sf-${idx}`,
          fx_cny_per_usd: 7.2,
          pkg: stdPkg,
          goods_first_order_promotion: false,
          freight_first_order_promotion: false,
          ui_readback: DEFAULT_R59_UI_READBACK,
          sku_lines: [{ component_id: 'stand', offer_id: 'offer-same-factory-1', sku_id: `sku-${idx}`, pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 155 + idx, regular_goods_promo_false: true }],
          goods_cny_total: (155 + idx) * 100,
          domestic_freight_cny_total: 180,
        });
      }
      const g1bSameFac = await runGate1BForForm(r3Store, {
        form_id: 'form-r3-same-fac',
        profile_revision: 59,
        as_of_date: '2026-11-24',
        sourcing_executor: async () => ({
          status: 'quoted',
          quote: {
            quote_id: 'q-fac2-fail',
            factory_id: 'fac-2',
            spec_variant_key: 'sku-var-fac2',
            observed_at: '2026-11-24',
            redacted_destination: '广东深圳',
            raw_readback_ref: 'ev-sf-3',
            fx_cny_per_usd: 7.2,
            pkg: stdPkg,
            goods_first_order_promotion: false,
            freight_first_order_promotion: false,
            ui_readback: DEFAULT_R59_UI_READBACK,
            sku_lines: [{ component_id: 'stand', offer_id: 'offer-second-factory-2', sku_id: 'sku-f2', pack_multiple: 1, qty_per_saleable_set: 1, moq_qty: 10, ordered_qty: 100, unit_price_cny: 150, regular_goods_promo_false: true }],
            goods_cny_total: 15000,
            domestic_freight_cny_total: 180,
          },
        }),
        early_screen_builder: ({ form }) => {
          const ds = JSON.parse(form.gate1a_result_json).declared_scenarios;
          return [{
            id: ds[0].id, saleable_unit: '1 unit', price_usd: 42.00, fx_cny_per_usd: 7.2, pkg: stdPkg,
            headhaul: { usd_per_unit: 1.8, bond_included: true }, refund_fraction: 0.04, physical_return_fraction: 0.04, return_threshold: 0.081, returns_processing_usd: 0,
            is_apparel_or_shoes: false, referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5 },
            fulfillment_usd: ds[0].fulfillment_usd, placement_usd: ds[0].placement_range_usd[1],
            storage: { cubic_feet_per_unit: (14 * 10 * 3) / 1728, rate_usd_per_cuft_month: 0.78, average_inventory_days: 45 },
            operating_period: 'off_peak', operating_months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
            fee_context: { marketplace: 'US', currency: 'USD', package_ref: 'p1', sales: { from: '2027-02-01', through: '2027-10-14' }, storage: { from: '2027-02-01', through: '2027-09-30' }, inbound: { from: '2027-01-15', through: '2027-10-14' } },
            collection_rate: 0.006, other_applicable_usd: 0, specific_rights_conflict: 'unknown', strong_date_dependency: false,
          }];
        },
      });
      assert.equal(g1bSameFac.checked_factory_quotes_count, 2);
      assert.equal(g1bSameFac.second_factory_quote_needed, true);
    } finally {
      r3Store.close();
    }
  });
});
