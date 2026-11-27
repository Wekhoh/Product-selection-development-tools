import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { scoreBatch, isUsableActivePricingScenario } from '../src/scoring.mjs';
import { applyPeerComparabilityRulings } from '../src/pipeline.mjs';
import { renderReport } from '../src/report.mjs';
import { makeStage4OrganizerTrayCandidate } from './helpers/stage4-fixtures.mjs';

const r59Profile = JSON.parse(
  readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'),
);
const syntheticFixture = JSON.parse(
  readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'),
);

const SPEC_SHA_V1 = '1'.repeat(64);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeSyntheticPngDataUri(width, height, seedByte = 0x2a) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[off + 1 + x * 3] = (seedByte + x * 7 + y * 13) & 0xff;
      raw[off + 2 + x * 3] = (seedByte * 3 + x * 11 + y * 5) & 0xff;
      raw[off + 3 + x * 3] = (seedByte * 5 + x * 3 + y * 17) & 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 0 });
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function makeSyntheticJpegDataUri(width, height, padBytes = 1200) {
  // Valid JPEG SOI + APP0 + SOF0 (with exact width/height) + COM padding + EOI
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  const sof0 = Buffer.alloc(13);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(11, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1;
  sof0[10] = 1;
  sof0[11] = 0x11;
  sof0[12] = 0;
  const com = Buffer.alloc(4 + padBytes, 0x41);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(padBytes + 2, 2);
  const eoi = Buffer.from([0xff, 0xd9]);
  return `data:image/jpeg;base64,${Buffer.concat([soi, app0, sof0, com, eoi]).toString('base64')}`;
}

function makeSyntheticWebpDataUri(width, height, padBytes = 1200) {
  // Valid RIFF/WEBP with VP8X extended header carrying exact 24-bit width/height + dummy chunk padding
  const vp8x = Buffer.alloc(18);
  vp8x.write('VP8X', 0, 4, 'ascii');
  vp8x.writeUInt32LE(10, 4);
  const w1 = width - 1;
  const h1 = height - 1;
  vp8x[12] = w1 & 0xff;
  vp8x[13] = (w1 >>> 8) & 0xff;
  vp8x[14] = (w1 >>> 16) & 0xff;
  vp8x[15] = h1 & 0xff;
  vp8x[16] = (h1 >>> 8) & 0xff;
  vp8x[17] = (h1 >>> 16) & 0xff;
  const pad = Buffer.alloc(8 + padBytes, 0x42);
  pad.write('JUNK', 0, 4, 'ascii');
  pad.writeUInt32LE(padBytes, 4);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(4 + vp8x.length + pad.length, 4);
  riff.write('WEBP', 8, 4, 'ascii');
  return `data:image/webp;base64,${Buffer.concat([riff, vp8x, pad]).toString('base64')}`;
}

test('Batch A2.1: post-ruling break_even_click_cvr and scenario status labels block excluded/pending/sensitivity scenarios and qualify crossing-30% copy', () => {
  const baseCand = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
    specSha256: SPEC_SHA_V1,
    specVersion: 1,
  });

  // 1. Undisputed baseline preserves normal CVR and "已纳入" pre-declared status
  const baseBatch = { schema_version: 1, profile_revision: 59, candidates: [baseCand] };
  const baseScored = scoreBatch(baseBatch, r59Profile);
  assert.equal(baseScored.candidates[0].diagnostics.economics.scenarios.every(isUsableActivePricingScenario), true);
  assert.ok(baseScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios.every(s => s.break_even_click_cvr > 0));
  const baseHtml = renderReport(baseScored, baseBatch);
  assert.match(baseHtml, /sc-low-no-tray（已纳入）/);
  assert.match(baseHtml, /sc-high-parts-unknown（已纳入）/);

  // 2. Formal ruling: low excluded + high pending_evidence -> zero leaked CVR % & zero stale "已纳入"
  const ruledCand = applyPeerComparabilityRulings(structuredClone(baseCand), [
    {
      peer_asin: 'B0SYN8LOW1',
      status: 'confirmed_excluded',
      source: 'owner_catalog_check',
      reason: '低价对标缺少可拆托盘，排除同套售价。',
      evidence: [baseCand.evidence[0].id],
    },
    {
      peer_asin: 'B0SYN8HIG2',
      status: 'pending_evidence',
      source: 'owner_catalog_check',
      reason: '高价对标同箱配件清单待补证。',
      evidence: [baseCand.evidence[0].id],
    },
  ]);
  const ruledBatch = { schema_version: 1, profile_revision: 59, candidates: [ruledCand] };
  const ruledScored = scoreBatch(ruledBatch, r59Profile);
  const ruledEcon = ruledScored.candidates[0].diagnostics.economics;
  assert.equal(ruledEcon.scenarios.some(isUsableActivePricingScenario), false);
  const beLow = ruledEcon.break_even_click_cvr.scenarios.find(s => s.id === 'sc-low-no-tray');
  const beHigh = ruledEcon.break_even_click_cvr.scenarios.find(s => s.id === 'sc-high-parts-unknown');
  assert.equal(beLow.contribution_usd, null);
  assert.equal(beLow.break_even_click_cvr, null);
  assert.equal(beLow.excluded_from_active_pricing, true);
  assert.equal(beHigh.contribution_usd, null, 'pending_evidence scenario must never expose active contribution_usd in break_even_click_cvr');
  assert.equal(beHigh.break_even_click_cvr, null, 'pending_evidence scenario must never compute a misleading break_even_click_cvr');

  const ruledHtml = renderReport(ruledScored, ruledBatch);
  const adRowMatch = ruledHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/);
  assert.ok(adRowMatch, 'expected ad breakeven row in waterfall table');
  assert.match(adRowMatch[0], /证据已排除/);
  assert.match(adRowMatch[0], /待补证/);
  assert.doesNotMatch(adRowMatch[0], /\d+(?:\.\d+)?%/, 'ruled card with no confirmed active scenario must not display any CVR %');

  const expRowMatch = ruledHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/);
  assert.ok(expRowMatch, 'expected expected_primary_scenarios verification line');
  assert.doesNotMatch(expRowMatch[0], /已纳入/, 'excluded/pending ruled scenarios must never display stale 已纳入');
  assert.match(expRowMatch[0], /sc-low-no-tray（[^）]*排除[^）]*）/);
  assert.match(expRowMatch[0], /sc-high-parts-unknown（[^）]*待补证[^）]*）/);

  // 3. Re-pricing: confirming high scenario restores CVR ONLY on high scenario; low stays excluded
  const repricedCand = applyPeerComparabilityRulings(structuredClone(ruledCand), [
    {
      peer_asin: 'B0SYN8HIG2',
      status: 'confirmed_comparable',
      source: 'owner_parts_verified',
      reason: '已核实同箱配件一致，确认可比。',
      evidence: [baseCand.evidence[0].id],
    },
  ]);
  const repricedBatch = { schema_version: 1, profile_revision: 59, candidates: [repricedCand] };
  const repricedScored = scoreBatch(repricedBatch, r59Profile);
  const repBeLow = repricedScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios.find(s => s.id === 'sc-low-no-tray');
  const repBeHigh = repricedScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios.find(s => s.id === 'sc-high-parts-unknown');
  assert.equal(repBeLow.break_even_click_cvr, null);
  assert.ok(repBeHigh.break_even_click_cvr > 0);
  const repricedHtml = renderReport(repricedScored, repricedBatch);
  const repAdRow = repricedHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(repAdRow, /证据已排除/);
  assert.match(repAdRow, /\d+(?:\.\d+)?%/);
  const repExpRow = repricedHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.doesNotMatch(repExpRow, /sc-low-no-tray（已纳入）/);
  assert.match(repExpRow, /sc-low-no-tray（[^）]*排除[^）]*）/);

  // 4. Unconfirmed sensitivity_only scenario must also NOT produce an actionable break_even_click_cvr
  const sensCand = structuredClone(baseCand);
  sensCand.economics.scenarios = [structuredClone(baseCand.economics.scenarios[0])];
  sensCand.economics.expected_primary_scenarios = [{ id: sensCand.economics.scenarios[0].id, status: 'active' }];
  sensCand.economics.scenarios[0].cost_ledger.sensitivity_only = true;
  const sensBatch = { schema_version: 1, profile_revision: 59, candidates: [sensCand] };
  const sensScored = scoreBatch(sensBatch, r59Profile);
  assert.equal(sensScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios[0].break_even_click_cvr, null);
  const sensHtml = renderReport(sensScored, sensBatch);
  const sensAdRow = sensHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(sensAdRow, /待补证/);
  assert.doesNotMatch(sensAdRow, /\d+(?:\.\d+)?%/);

  // 5. Crossing-30% card (counts_toward_target: false) qualifies scenario copy with explicit non-qualifying context
  const crossCand = structuredClone(syntheticFixture.candidates[0]);
  crossCand.id = 'cand-a2-crossing-honest';
  const scPass = structuredClone(crossCand.economics.scenarios[0]);
  scPass.id = scPass.cost_ledger.id = 'sc-cross-pass';
  scPass.quote_id = 'q-factory-pass';
  const scFail = structuredClone(scPass);
  scFail.id = scFail.cost_ledger.id = 'sc-cross-fail';
  scFail.quote_id = 'q-factory-fail';
  delete scFail.margin;
  delete scFail.contribution_usd;
  scFail.cost_ledger.lines.find(l => l.id === 'procurement').amount_usd = 21.0;
  const r = scFail.cost_ledger.refund_fraction;
  const ref = scFail.cost_ledger.lines.find(l => l.id === 'referral').amount_usd;
  const payout = 40 * (1 - r) - (ref - r * (ref - Math.min(5, 0.2 * ref))) - 4.86 - 0.54 - 0.2925;
  scFail.cost_ledger.lines.find(l => l.id === 'collection').amount_usd = Number((payout * scFail.cost_ledger.collection_rate).toFixed(10));
  crossCand.economics.expected_primary_scenarios = [{ id: 'sc-cross-pass', status: 'active' }, { id: 'sc-cross-fail', status: 'active' }];
  crossCand.economics.scenarios = [scPass, scFail];
  const crossBatch = { schema_version: 1, profile_revision: 59, candidates: [crossCand] };
  const crossScored = scoreBatch(crossBatch, r59Profile);
  assert.equal(crossScored.candidates[0].qualification.counts_toward_target, false);
  const crossHtml = renderReport(crossScored, crossBatch);
  assert.match(crossHtml, /跨 30% 红线（整卡未达标，不计入入围目标）/);
  assert.doesNotMatch(crossHtml, /<span class="ink-pass">达标可做：/, 'crossing card must not render bare standalone 达标可做 without crossing/non-qualifying context');
  assert.doesNotMatch(crossHtml, /—/, 'must emit zero em-dashes');
});

test('Batch A2.2: single-file standalone HTML deduplicates repeated raster data URIs once and slashes output bytes without <script>', () => {
  const pngA = makeSyntheticPngDataUri(80, 60, 0x31); // ~19 KB base64 payload
  const jpegB = makeSyntheticJpegDataUri(240, 180, 9000); // ~12 KB base64 payload
  const webpC = makeSyntheticWebpDataUri(160, 120, 4500); // ~6 KB base64 payload
  const pngSingle = makeSyntheticPngDataUri(32, 24, 0x77); // single-use image

  const b64A = pngA.split(',')[1];
  const b64B = jpegB.split(',')[1];
  const b64C = webpC.split(',')[1];
  assert.ok(b64A.length > 10_000);
  assert.ok(b64B.length > 10_000);
  assert.ok(b64C.length > 5_000);

  const batch = structuredClone(syntheticFixture);
  // Reference pngA across hero plinth, contact sheet (thumb+lightbox), ref image (thumb+lightbox), and concept (thumb+lightbox) on cand 0,
  // PLUS hero & ref image on cand 1 (total 10 rendered image references for the same payload!).
  batch.candidates[0].presentation.hero_image_data_uri = pngA;
  batch.candidates[0].presentation.contact_sheet_data_uri = pngA;
  batch.candidates[0].presentation.image_data_uri = pngA;
  batch.candidates[0].concept_images = [
    { data_uri: pngA, title: '重复概念图 A', caption: '复用同一图像载荷' },
    { data_uri: jpegB, title: '概念图 B', caption: '缩略图与灯箱共享同一 JPEG' },
    { data_uri: webpC, title: '概念图 C', caption: '缩略图与灯箱共享同一 WebP' },
  ];
  batch.candidates[1].presentation.hero_image_data_uri = pngA;
  batch.candidates[1].presentation.image_data_uri = jpegB;
  batch.candidates[2].presentation.hero_image_data_uri = pngSingle;

  const scored = scoreBatch(batch, r59Profile);
  const html = renderReport(scored, batch);
  const htmlRepeat = renderReport(scored, batch);

  // Deterministic across runs
  assert.equal(html, htmlRepeat, 'deduplicated HTML must be deterministic');

  // Strict single-file script-free CSP invariants
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /script-src 'none'; connect-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(html, /—/);

  // Each repeated base64 payload appears STRICTLY ONCE in the entire standalone HTML
  const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;
  assert.equal(countOccurrences(html, b64A), 1, 'repeated PNG base64 payload must be embedded strictly once');
  assert.equal(countOccurrences(html, b64B), 1, 'repeated JPEG base64 payload must be embedded strictly once');
  assert.equal(countOccurrences(html, b64C), 1, 'repeated WebP base64 payload must be embedded strictly once');
  assert.equal(countOccurrences(html, pngSingle.split(',')[1]), 1, 'single-use PNG payload appears once');

  // Quantitative byte reduction: naive would be 8*pngA + 4*jpegB + 2*webpC + 1*pngSingle;
  // deduplicated holds only 1*pngA + 1*jpegB + 1*webpC + 1*pngSingle!
  const naiveDupBytes = 8 * pngA.length + 4 * jpegB.length + 2 * webpC.length;
  const savedFloorBytes = 7 * pngA.length + 3 * jpegB.length + 1 * webpC.length;
  const strippedBaseLen = html.length - pngA.length - jpegB.length - webpC.length - pngSingle.length;
  assert.ok(
    html.length < strippedBaseLen + naiveDupBytes - savedFloorBytes * 0.95,
    `expected HTML byte savings >= 95% of duplicate payload (${savedFloorBytes}B)`,
  );

  // Inline SVG defs sprite + <use href="#img-asset-..."> references with preserved aspect viewBox
  assert.match(html, /<svg\b[^>]*class="img-defs-sprite"[^>]*><defs>/);
  assert.match(html, /<image\b[^>]*id="img-asset-1"[^>]*width="80"[^>]*height="60"/);
  assert.match(html, /<image\b[^>]*id="img-asset-2"[^>]*width="240"[^>]*height="180"/);
  assert.match(html, /<image\b[^>]*id="img-asset-3"[^>]*width="160"[^>]*height="120"/);
  assert.ok((html.match(/<use href="#img-asset-1"\/>/g) ?? []).length >= 7);
  assert.ok((html.match(/<use href="#img-asset-2"\/>/g) ?? []).length >= 4);
  assert.equal((html.match(/<use href="#img-asset-3"\/>/g) ?? []).length, 2);
});

test('Batch A2.3: honest 2027 Q4 unpublished peak copy and Coupon $5/100 + 2.5% redemption-order amortization note', () => {
  // 1. Evergreen qualifying card on 2027-02-01..2027-10-14 off-peak window (Q4 peak unpublished)
  const evgCand = structuredClone(syntheticFixture.candidates[0]);
  evgCand.id = 'cand-a2-evergreen-q4-honest';
  evgCand.product_seasonality = 'evergreen';
  const sc0 = evgCand.economics.scenarios[0];
  sc0.cost_ledger.fee_context = {
    ...sc0.cost_ledger.fee_context,
    sales: { from: '2027-02-01', through: '2027-10-14' },
    storage: { from: '2027-02-01', through: '2027-09-30' },
    inbound: { from: '2027-01-15', through: '2027-10-14' },
  };
  for (const line of sc0.cost_ledger.lines) {
    if (line.fee_basis) {
      line.fee_basis.effective_from = '2027-01-15';
      line.fee_basis.effective_through = line.id === 'storage' ? '2027-09-30' : '2027-10-14';
    }
  }
  const evgBatch = { schema_version: 1, profile_revision: 59, candidates: [evgCand] };
  const evgScored = scoreBatch(evgBatch, r59Profile);
  // Machine field remains backwards-compatible
  assert.equal(evgScored.candidates[0].effective_disposition, 'full_annual_qualifying');
  assert.ok(evgScored.candidates[0].unpublished_2027_q4_peak_note);
  const evgHtml = renderReport(evgScored, evgBatch);
  assert.match(evgHtml, /非旺季达标 · 2027 Q4 旺季费率待公布/);
  assert.doesNotMatch(evgHtml, /完整达标 · 可推进/, 'unpublished 2027 Q4 peak card must not claim full-year 完整达标');
  assert.doesNotMatch(evgHtml, /—/);

  // Non-coupon baseline must NOT emit coupon amortization note
  assert.doesNotMatch(evgHtml, /实际核券/);

  // 2. Ongoing coupon scenario ($5/100 + 2.5%) surfaces honest fixed-fee amortization denominator note
  const cpnCand = structuredClone(evgCand);
  cpnCand.id = 'cand-a2-coupon-honest';
  const cpnSc = cpnCand.economics.scenarios[0];
  cpnSc.cost_ledger.list_price_usd = 44.0;
  cpnSc.cost_ledger.ongoing_coupon_usd = 4.0;
  cpnSc.cost_ledger.net_effective_price_usd = 40.0;
  cpnSc.cost_ledger.price_usd = 40.0;
  cpnSc.cost_ledger.promo_basis_already_net = true;
  cpnSc.cost_ledger.coupon_campaign_units = 100;
  cpnSc.price_anchor = {
    value: 40.0,
    unit: 'USD',
    matched_spec: true,
    target_variant_asin: 'B0SYNCPN01',
    fulfillment_channel: 'FBA',
    sales_history_supported: true,
    list_price_usd: 44.0,
    ongoing_coupon_usd: 4.0,
    net_effective_price_usd: 40.0,
    promo_basis_already_net: true,
    evidence: [cpnCand.evidence[0].id],
  };
  cpnCand.screening.reference_price_usd = structuredClone(cpnSc.price_anchor);
  delete cpnSc.margin;
  delete cpnSc.contribution_usd;
  const cpnBatch = { schema_version: 1, profile_revision: 59, candidates: [cpnCand] };
  const cpnScored = scoreBatch(cpnBatch, r59Profile);
  const cpnHtml = renderReport(cpnScored, cpnBatch);
  assert.match(cpnHtml, /\$5\/100 \+ 2\.5%|单场 \$5 固定/);
  assert.match(cpnHtml, /实际核券/);
  assert.match(cpnHtml, /不与 100 套采购量挂钩/);
  assert.doesNotMatch(cpnHtml, /—/);
});

test('Batch A2.4: Keepa newcomer review-jump (+N) and drop (-N) hints flow through scoring with zero score penalty and render concrete date + count deltas in HTML', () => {
  const cleanCand = structuredClone(syntheticFixture.candidates[0]);
  cleanCand.id = 'cand-a2-keepa-review-control';
  const cleanScored = scoreBatch({ schema_version: 1, profile_revision: 59, candidates: [cleanCand] }, r59Profile);

  const anomCand = structuredClone(cleanCand);
  const m0 = anomCand.newcomer_cohort.members[0];
  const m1 = anomCand.newcomer_cohort.members[1];
  m0.keepa_review_jump_detected = true;
  m0.keepa_review_drop_detected = true;
  m0.keepa_review_anomaly_events = [
    {
      direction: 'jump',
      delta: 32,
      from_count: 3,
      to_count: 35,
      date_from: '2026-11-10',
      date_to: '2026-11-12',
      asin: m0.asin,
    },
    {
      direction: 'drop',
      delta: -5,
      from_count: 35,
      to_count: 30,
      date_from: '2026-11-18',
      date_to: '2026-11-19',
      asin: m0.asin,
    },
  ];
  m0.keepa_review_anomaly_summary = {
    asin: m0.asin,
    parent_asin: 'P0SYNPARENT1',
    has_jump: true,
    has_drop: true,
    event_count: 2,
    max_jump_delta: 32,
    max_drop_delta: -5,
    largest_jump: m0.keepa_review_anomaly_events[0],
    largest_drop: m0.keepa_review_anomaly_events[1],
    note_zh: `${m0.asin} 2026-11-10→2026-11-12 评论跃升 +32（3→35），2026-11-18→2026-11-19 评论骤降 -5（35→30）。`,
  };
  // Second member: jump-only without drop
  m1.keepa_review_jump_detected = true;
  m1.keepa_review_anomaly_events = [
    {
      direction: 'jump',
      delta: 14,
      from_count: 6,
      to_count: 20,
      date_from: '2026-11-05',
      date_to: '2026-11-07',
      asin: m1.asin,
    },
  ];

  const anomBatch = { schema_version: 1, profile_revision: 59, candidates: [anomCand] };
  const anomScored = scoreBatch(anomBatch, r59Profile);

  // Zero score penalty & non-blocking
  const cClean = cleanScored.candidates[0];
  const cAnom = anomScored.candidates[0];
  assert.deepEqual(cAnom.total_range, cClean.total_range);
  assert.deepEqual(cAnom.core_85_range, cClean.core_85_range);
  assert.deepEqual(cAnom.supported_range, cClean.supported_range);
  assert.equal(cAnom.qualification.counts_toward_target, cClean.qualification.counts_toward_target);
  assert.deepEqual(
    cAnom.items.find(i => i.id === 'low_rating_sales_performance').score_range,
    cClean.items.find(i => i.id === 'low_rating_sales_performance').score_range,
  );
  assert.deepEqual(
    cAnom.items.find(i => i.id === 'natural_visibility_development').score_range,
    cClean.items.find(i => i.id === 'natural_visibility_development').score_range,
  );

  // Scoring diagnostics preserve both jump and drop advisories with concrete events
  const advisories = cAnom.diagnostics.newcomers.review_anomaly_advisories;
  assert.ok(Array.isArray(advisories) && advisories.length === 2);
  const adv0 = advisories.find(a => a.asin === m0.asin);
  const adv1 = advisories.find(a => a.asin === m1.asin);
  assert.equal(adv0.has_jump, true);
  assert.equal(adv0.has_drop, true);
  assert.equal(adv0.events.length, 2);
  assert.equal(adv1.has_jump, true);
  assert.equal(adv1.has_drop, false);

  // HTML renders concrete dates, before/after counts, signed deltas (+32, -5, +14), and zero em-dashes
  const html = renderReport(anomScored, anomBatch);
  assert.match(html, /Keepa 评论变动提示/);
  assert.match(html, /2026-11-10→2026-11-12/);
  assert.match(html, /\+32/);
  assert.match(html, /3 → 35|3→35/);
  assert.match(html, /2026-11-18→2026-11-19/);
  assert.match(html, /-5/);
  assert.match(html, /35 → 30|35→30/);
  assert.match(html, /2026-11-05→2026-11-07/);
  assert.match(html, /\+14/);
  assert.match(html, /6 → 20|6→20/);
  assert.doesNotMatch(html, /—/);

  // Boolean-only keepa_review_drop_detected + PII/path scrubbing in note_zh
  const boolCand = structuredClone(cleanCand);
  boolCand.newcomer_cohort.members[0].keepa_review_drop_detected = true;
  boolCand.newcomer_cohort.members[0].keepa_review_anomaly_note = 'Keepa 骤降见 C:\\Users\\PrivateUser\\keepa.json 或 contact ops@example.com';
  const boolBatch = { schema_version: 1, profile_revision: 59, candidates: [boolCand] };
  const boolScored = scoreBatch(boolBatch, r59Profile);
  assert.equal(boolScored.candidates[0].diagnostics.newcomers.review_anomaly_advisories.length, 1);
  assert.equal(boolScored.candidates[0].diagnostics.newcomers.review_anomaly_advisories[0].has_drop, true);
  assert.deepEqual(boolScored.candidates[0].total_range, cClean.total_range);
  const boolHtml = renderReport(boolScored, boolBatch);
  assert.match(boolHtml, /Keepa 评论变动提示/);
  assert.doesNotMatch(boolHtml, /PrivateUser|ops@example\.com/i);
});
