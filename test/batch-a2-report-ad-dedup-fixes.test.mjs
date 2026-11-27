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

// Real Pillow-generated, Pillow-decodable baseline JPEG (64x48, Orientation 1),
// EXIF Orientation 6 JPEG (480x120 raw -> 120x480 displayed), and WebP (160x120 VP8).
const BASE_JPEG_64X48_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDMooor6Q8AKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';

const EXIF6_JPEG_480X120_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAB4AeADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDOooor5s+sCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//9k=';

const BASE_WEBP_160X120_B64 =
  'UklGRngCAABXRUJQVlA4IGwCAADwCwCdASqgAHgAPm02mUmkIqIhIGgAgA2JaG7gMFmIQD//h5wGUI4G81/gH8A/jH5G/IJwDyDdFPgH4F/YrO+wBEAaci1R0uXLcQ9qIwnHIJNoaqk2TEOqpPg9kxDsXYgnHJnGvRlvAAD+5AX/8gUQgv/QrBJHXMa16+W344AsDGTLFIHGzQc4MlWB4MZGpVXEyHownsakELYRcftdmgUfETtxYnKVuV9yEM/Kj4iduNbdX8FmaOzETy6s3Ak11PCAcX5NGwSPASd6ayqhK0aW9irLILiKdlPJP5OmarQtlauTcLvZeVR1OGJtmCFiXzl6hMTHDFi4PY69tix7nTX+7vpH6nKeOQepwYQsNWYag/tlVYz4Ym2YIWJfOYGOzn8MVWiZISVbMNNanjuHqcLIONgxTyasDFLu72vPdKcCY900KsMRrXn0g1lVCVo0t6P3PqfOYGOzn8MVWiZISVbMNNanjuHqcGELDVmGoO4q5Af/GYpsZiZS4lE2UiCTsQYk72uqbeEaRE1Jr/d30j9TlPHIPU4MIWGrMNQf2yqsZ8MTbMELEvnMDHZz+GKrh+h/y7+VGKRVQa159INZVQlaNLej9z6nzmBjs5/DFVomSElWzDTWp47h6nBhCw1ZhqD+2VVjPhibZghYl85eoTExwxYuD2OvbYse501/u76R+pynjkHqcGELDVmGoP7ZVWM+GJtmCFiXzmBjs5/DFVomSElWzDTWp47h6nCyDjYMU8mrAxS7u9rz3SnAmPdNCrDEa159INZVQlaNLej9z6nzmBjs5/DFVomSElWzDTWp47h6nBhCw1ZhqDcAAA==';

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

function makeDecodablePngDataUri(width, height, { seedByte = 0x2a, solid = false, compressionLevel = 0 } = {}) {
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
      raw[off + 1 + x * 3] = solid ? seedByte : ((seedByte + x * 7 + y * 13) & 0xff);
      raw[off + 2 + x * 3] = solid ? ((seedByte + 40) & 0xff) : ((seedByte * 3 + x * 11 + y * 5) & 0xff);
      raw[off + 3 + x * 3] = solid ? ((seedByte + 80) & 0xff) : ((seedByte * 5 + x * 3 + y * 17) & 0xff);
    }
  }
  const idat = deflateSync(raw, { level: compressionLevel });
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function makeDecodableJpegWithComPadding(baseB64, comPadBytes = 3200) {
  const raw = Buffer.from(baseB64, 'base64');
  // Insert a valid JPEG COM segment (0xFF 0xFE) right after SOI (2B) + APP0 (18B) = offset 20.
  const com = Buffer.alloc(4 + comPadBytes, 0x41);
  com[0] = 0xff;
  com[1] = 0xfe;
  com.writeUInt16BE(comPadBytes + 2, 2);
  const combined = Buffer.concat([raw.subarray(0, 20), com, raw.subarray(20)]);
  return `data:image/jpeg;base64,${combined.toString('base64')}`;
}

function makeMalformedExifJpegDataUri(baseB64) {
  const raw = Buffer.from(baseB64, 'base64');
  // Insert a truncated/malformed APP1 "Exif\0\0" segment right after APP0 (offset 20).
  const badApp1Payload = Buffer.from('Exif\0\0BAD!', 'ascii');
  const app1 = Buffer.alloc(4 + badApp1Payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(badApp1Payload.length + 2, 2);
  badApp1Payload.copy(app1, 4);
  const combined = Buffer.concat([raw.subarray(0, 20), app1, raw.subarray(20)]);
  return `data:image/jpeg;base64,${combined.toString('base64')}`;
}

function makeDualPeriodCandidate(seasonality) {
  const base = makeStage4OrganizerTrayCandidate(syntheticFixture.candidates[0], {
    specSha256: SPEC_SHA_V1,
    specVersion: 1,
  });
  base.product_seasonality = seasonality;
  const offScenarios = structuredClone(base.economics.scenarios);
  const peakScenarios = structuredClone(base.economics.scenarios).map(sc => {
    sc.id = `${sc.id}-peak`;
    sc.cost_ledger.id = sc.id;
    sc.cost_ledger.fee_context.sales = { from: '2027-10-15', through: '2027-12-31' };
    sc.cost_ledger.fee_context.storage = { from: '2027-10-01', through: '2027-12-31' };
    sc.cost_ledger.fee_context.inbound = { from: '2027-01-15', through: '2027-10-14' };
    const ful = sc.cost_ledger.lines.find(l => l.id === 'fulfillment');
    ful.status = 'pending';
    ful.amount_usd = null;
    ful.fee_basis = { status: 'unavailable', version: 'US-FBA-2027-peak-unpublished', marketplace: 'US', currency: 'USD', year: 2027 };
    const col = sc.cost_ledger.lines.find(l => l.id === 'collection');
    col.status = 'pending';
    col.amount_usd = null;
    return sc;
  });
  base.economics = {
    saleable_unit: base.economics.saleable_unit,
    operating_periods: [
      {
        id: 'off_peak',
        label: '2027 淡季',
        months: [2, 3, 4, 5, 6, 7, 8, 9, 10],
        expected_primary_scenarios: offScenarios.map(sc => ({ id: sc.id, status: 'active' })),
        scenarios: offScenarios,
      },
      {
        id: 'peak_q4',
        label: '2027 旺季',
        months: [10, 11, 12],
        expected_primary_scenarios: peakScenarios.map(sc => ({ id: sc.id, status: 'active' })),
        scenarios: peakScenarios,
      },
    ],
  };
  return base;
}

test('Batch A2.1: post-ruling break_even_click_cvr, evergreen off_peak ruling parity, non-scorable labels, all-excluded ad summary, and crossing-30% copy', () => {
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

  // 2. Formal ruling: low excluded + high pending_evidence -> zero leaked CVR %, zero stale "已纳入", and card-level ad summary
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
  assert.equal(beHigh.contribution_usd, null);
  assert.equal(beHigh.break_even_click_cvr, null);

  const ruledHtml = renderReport(ruledScored, ruledBatch);
  const adRowMatch = ruledHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/);
  assert.ok(adRowMatch, 'expected ad breakeven row in waterfall table');
  assert.match(adRowMatch[0], /无已确认可用主情景 · 广告盈亏平衡待补证/);
  assert.match(adRowMatch[0], /证据已排除/);
  assert.match(adRowMatch[0], /待补证/);
  assert.doesNotMatch(adRowMatch[0], /\d+(?:\.\d+)?%/, 'ruled card with no confirmed active scenario must not display any CVR %');

  const expRowMatch = ruledHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/);
  assert.ok(expRowMatch);
  assert.doesNotMatch(expRowMatch[0], /已纳入/, 'excluded/pending ruled scenarios must never display stale 已纳入');
  assert.match(expRowMatch[0], /sc-low-no-tray（[^）]*排除[^）]*）/);
  assert.match(expRowMatch[0], /sc-high-parts-unknown（[^）]*待补证[^）]*）/);

  // 3. All-excluded scenarios (both with and without reference bid) keep per-cell exclusion and show card-level ad-breakeven summary
  const allExclCand = applyPeerComparabilityRulings(structuredClone(baseCand), [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_excluded', source: 'owner_check', reason: '排除低价' },
    { peer_asin: 'B0SYN8HIG2', status: 'confirmed_excluded', source: 'owner_check', reason: '排除高价' },
  ]);
  for (const dropBid of [false, true]) {
    const c = structuredClone(allExclCand);
    if (dropBid) delete c.bids;
    const b = { schema_version: 1, profile_revision: 59, candidates: [c] };
    const s = scoreBatch(b, r59Profile);
    const h = renderReport(s, b);
    const row = h.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
    assert.ok(row, `all-excluded card (dropBid=${dropBid}) must still show ad breakeven summary row`);
    assert.match(row, /无已确认可用主情景 · 广告盈亏平衡待补证/);
    assert.equal((row.match(/证据已排除/g) ?? []).length, 2);
    assert.doesNotMatch(row, /\d+(?:\.\d+)?%/);
  }

  // 4. Dual-period evergreen card unwrapped from unpublished Q4 companion MUST preserve off_peak period_id rulings (Astra P1 #1)
  const evgDual = applyPeerComparabilityRulings(makeDualPeriodCandidate('evergreen'), [
    { peer_asin: 'B0SYN8LOW1', period_id: 'off_peak', status: 'confirmed_excluded', source: 'owner_check', reason: '淡季低价无托盘排除' },
    { peer_asin: 'B0SYN8HIG2', period_id: 'off_peak', status: 'pending_evidence', source: 'owner_check', reason: '淡季高价配件待补证' },
  ]);
  const evgDualBatch = { schema_version: 1, profile_revision: 59, candidates: [evgDual] };
  const evgDualScored = scoreBatch(evgDualBatch, r59Profile);
  const evgDualCard = evgDualScored.candidates[0];
  assert.equal(evgDualCard.qualification.counts_toward_target, false, 'evergreen unwrapped card must respect off_peak-scoped rulings');
  assert.equal(evgDualCard.diagnostics.economics.operating_period_id, 'off_peak');
  assert.ok(evgDualCard.diagnostics.economics.break_even_click_cvr.scenarios.every(s => s.break_even_click_cvr === null));
  const evgDualHtml = renderReport(evgDualScored, evgDualBatch);
  const evgDualAdRow = evgDualHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.doesNotMatch(evgDualAdRow, /\d+(?:\.\d+)?%/, 'unwrapped evergreen card must not leak CVR % from excluded/pending off_peak scenarios');
  assert.match(evgDualAdRow, /证据已排除/);
  assert.match(evgDualAdRow, /待补证/);
  const evgDualExpRow = evgDualHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.doesNotMatch(evgDualExpRow, /已纳入/);
  assert.doesNotMatch(evgDualHtml, /非旺季达标/);

  // 5. Re-pricing: confirming high scenario restores CVR ONLY on high scenario; low stays excluded
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

  // 6. confirmed_comparable + sensitivity_only & unpublished Q4 pending scenarios must NEVER say "已纳入" (Astra P2 #8)
  const compSensCand = applyPeerComparabilityRulings(structuredClone(baseCand), [
    { peer_asin: 'B0SYN8LOW1', status: 'confirmed_comparable', source: 'owner_check', reason: '确认可比但仅作试算' },
  ]);
  compSensCand.economics.scenarios = [structuredClone(compSensCand.economics.scenarios[0])];
  compSensCand.economics.expected_primary_scenarios = [{ id: compSensCand.economics.scenarios[0].id, status: 'active' }];
  compSensCand.economics.scenarios[0].cost_ledger.sensitivity_only = true;
  const compSensBatch = { schema_version: 1, profile_revision: 59, candidates: [compSensCand] };
  const compSensScored = scoreBatch(compSensBatch, r59Profile);
  assert.equal(compSensScored.candidates[0].diagnostics.economics.break_even_click_cvr.scenarios[0].break_even_click_cvr, null);
  const compSensHtml = renderReport(compSensScored, compSensBatch);
  const compSensAdRow = compSensHtml.match(/<tr><th scope="row">广告盈亏平衡所需点击转化率[\s\S]*?<\/tr>/)?.[0] ?? '';
  assert.match(compSensAdRow, /待补证/);
  assert.doesNotMatch(compSensAdRow, /\d+(?:\.\d+)?%/);
  const compSensExpRow = compSensHtml.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.match(compSensExpRow, /裁决确认可比 · 条件试算 · 不计分/);
  assert.doesNotMatch(compSensExpRow, /已纳入/);

  // Seasonal Q4 unpublished-fulfillment scenarios must also say 待补证 instead of 已纳入
  const seasDual = makeDualPeriodCandidate('seasonal');
  const seasDualBatch = { schema_version: 1, profile_revision: 59, candidates: [seasDual] };
  const seasDualHtml = renderReport(scoreBatch(seasDualBatch, r59Profile), seasDualBatch);
  const peakSection = seasDualHtml.match(/data-operating-period="peak_q4"[\s\S]*?<\/section>/)?.[0] ?? '';
  const peakExpRow = peakSection.match(/<p class="muted">预声明主情景核验：[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.ok(peakExpRow, 'expected Q4 expected_primary_scenarios line');
  assert.doesNotMatch(peakExpRow, /已纳入/, 'unpublished Q4 scenarios must not claim 已纳入');
  assert.match(peakExpRow, /待补证/);

  // 7. Crossing-30% card (counts_toward_target: false) qualifies scenario copy with explicit non-qualifying context
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
  assert.doesNotMatch(crossHtml, /<span class="ink-pass">达标可做：/);
  assert.doesNotMatch(crossHtml, /—/);
});

test('Batch A2.2: single-file HTML deduplicates decodable PNG/JPEG/WebP, rotates EXIF Orientation 6, guards malformed EXIF & tiny PNG bloat', () => {
  const pngA = makeDecodablePngDataUri(80, 60, { seedByte: 0x31, compressionLevel: 0 }); // ~19 KB real PNG
  const jpegB = makeDecodableJpegWithComPadding(BASE_JPEG_64X48_B64, 3600); // ~5.7 KB real Pillow-decodable JPEG (64x48)
  const exif6Jpeg = `data:image/jpeg;base64,${EXIF6_JPEG_480X120_B64}`; // real 480x120 EXIF-6 -> displayed 120x480
  const webpC = `data:image/webp;base64,${BASE_WEBP_160X120_B64}`; // real Pillow-decodable 160x120 WebP
  const pngSingle = makeDecodablePngDataUri(32, 24, { seedByte: 0x77, compressionLevel: 0 });

  const b64A = pngA.split(',')[1];
  const b64B = jpegB.split(',')[1];
  const b64Exif6 = EXIF6_JPEG_480X120_B64;
  const b64C = BASE_WEBP_160X120_B64;

  // Build independent 1x1-placeholder baseline batch (exact same figure/lightbox/AI-CSS structure, negligible payloads)
  const tiny1x1Png = makeDecodablePngDataUri(1, 1, { seedByte: 0x11, solid: true, compressionLevel: 9 });
  const noImgBatch = structuredClone(syntheticFixture);
  for (const c of noImgBatch.candidates) {
    if (c.presentation) {
      delete c.presentation.hero_image_data_uri;
      delete c.presentation.contact_sheet_data_uri;
      delete c.presentation.image_data_uri;
    }
    delete c.concept_images;
  }
  const placeholderBatch = structuredClone(noImgBatch);
  placeholderBatch.candidates[0].presentation.hero_image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[0].presentation.contact_sheet_data_uri = tiny1x1Png;
  placeholderBatch.candidates[0].presentation.image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[0].concept_images = [
    { data_uri: tiny1x1Png, title: '重复概念图 A', caption: '复用同一 PNG 载荷' },
    { data_uri: tiny1x1Png, title: '概念图 B', caption: '复用真实 JPEG 载荷' },
    { data_uri: tiny1x1Png, title: '概念图 C', caption: '复用真实 WebP 载荷' },
    { data_uri: tiny1x1Png, title: '旋转照片 D', caption: 'EXIF Orientation 6 应按 120x480 展示' },
  ];
  placeholderBatch.candidates[1].presentation.hero_image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[1].presentation.image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[1].presentation.contact_sheet_data_uri = tiny1x1Png;
  placeholderBatch.candidates[2].presentation.hero_image_data_uri = tiny1x1Png;
  placeholderBatch.candidates[2].presentation.image_data_uri = tiny1x1Png;
  const placeholderHtml = renderReport(scoreBatch(placeholderBatch, r59Profile), placeholderBatch);
  const placeholderBytes = Buffer.byteLength(placeholderHtml, 'utf8');

  const batch = structuredClone(noImgBatch);
  batch.candidates[0].presentation.hero_image_data_uri = pngA;
  batch.candidates[0].presentation.contact_sheet_data_uri = pngA;
  batch.candidates[0].presentation.image_data_uri = pngA;
  batch.candidates[0].concept_images = [
    { data_uri: pngA, title: '重复概念图 A', caption: '复用同一 PNG 载荷' },
    { data_uri: jpegB, title: '概念图 B', caption: '复用真实 JPEG 载荷' },
    { data_uri: webpC, title: '概念图 C', caption: '复用真实 WebP 载荷' },
    { data_uri: exif6Jpeg, title: '旋转照片 D', caption: 'EXIF Orientation 6 应按 120x480 展示' },
  ];
  batch.candidates[1].presentation.hero_image_data_uri = pngA;
  batch.candidates[1].presentation.image_data_uri = jpegB;
  batch.candidates[1].presentation.contact_sheet_data_uri = webpC;
  batch.candidates[2].presentation.hero_image_data_uri = pngSingle;
  batch.candidates[2].presentation.image_data_uri = exif6Jpeg;

  const scored = scoreBatch(batch, r59Profile);
  const html = renderReport(scored, batch);
  assert.equal(html, renderReport(scored, batch), 'deduplicated HTML must be deterministic');

  // Strict single-file script-free CSP invariants
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /script-src 'none'; connect-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(html, /—/);

  // Each repeated base64 payload appears STRICTLY ONCE in the entire standalone HTML
  const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;
  assert.equal(countOccurrences(html, b64A), 1, 'repeated PNG must appear once');
  assert.equal(countOccurrences(html, b64B), 1, 'repeated JPEG must appear once');
  assert.equal(countOccurrences(html, b64C), 1, 'repeated WebP must appear once');
  assert.equal(countOccurrences(html, b64Exif6), 1, 'repeated EXIF-6 JPEG must appear once');
  assert.equal(countOccurrences(html, pngSingle.split(',')[1]), 1, 'single-use PNG appears once');

  // Independent byte-savings check against 1x1-placeholder baseline HTML (no algebraic cancellation!)
  // Naive total embedded image payload: 8*pngA + 4*jpegB + 4*webpC + 4*exif6Jpeg + 1*pngSingle
  const uniquePayloadBytes = pngA.length + jpegB.length + webpC.length + exif6Jpeg.length + pngSingle.length;
  const naivePayloadBytes = 8 * pngA.length + 4 * jpegB.length + 4 * webpC.length + 4 * exif6Jpeg.length + pngSingle.length;
  const actualDeltaBytes = Buffer.byteLength(html, 'utf8') - placeholderBytes;
  assert.ok(
    actualDeltaBytes < uniquePayloadBytes + 4_000,
    `expected added bytes (${actualDeltaBytes}) within 4 KB of 1x unique payloads (${uniquePayloadBytes})`,
  );
  assert.ok(
    actualDeltaBytes < naivePayloadBytes * 0.25,
    `expected >75% payload savings vs naive multi-embed (${actualDeltaBytes} vs naive ${naivePayloadBytes})`,
  );

  // EXIF Orientation 6 (480x120 raw) MUST emit swapped display viewBox 120x480 (Astra P2 #4)
  assert.match(html, /<svg\b[^>]*class="img-defs-sprite"[^>]*><defs>/);
  assert.match(html, /<image\b[^>]*width="80"[^>]*height="60"/);
  assert.match(html, /<image\b[^>]*width="64"[^>]*height="48"/);
  assert.match(html, /<image\b[^>]*width="160"[^>]*height="120"/);
  assert.match(html, /<image\b[^>]*width="120"[^>]*height="480"/, 'EXIF Orientation 6 JPEG must swap to 120x480');
  assert.match(html, /viewBox="0 0 120 480"/, 'EXIF Orientation 6 SVG use must have 120x480 viewBox');
  assert.doesNotMatch(html, /viewBox="0 0 480 120"/, 'EXIF Orientation 6 must not use unrotated 480x120 viewBox');

  // Malformed EXIF APP1 must fall back safely to inline <img> (not mis-sized SVG)
  const badExifBatch = structuredClone(noImgBatch);
  badExifBatch.candidates = [badExifBatch.candidates[0]];
  const badExifUri = makeMalformedExifJpegDataUri(BASE_JPEG_64X48_B64);
  badExifBatch.candidates[0].presentation.hero_image_data_uri = badExifUri;
  badExifBatch.candidates[0].presentation.image_data_uri = badExifUri;
  const badExifHtml = renderReport(scoreBatch(badExifBatch, r59Profile), badExifBatch);
  assert.doesNotMatch(badExifHtml, /img-defs-sprite/, 'malformed EXIF JPEG must not hoist into SVG sprite');
  assert.equal(countOccurrences(badExifHtml, badExifUri.split(',')[1]), 3, 'malformed EXIF JPEG stays inline <img>');

  // Small repeated 48x48 PNG (short URI) must NOT hoist and bloat HTML beyond inline baseline (Astra P2 #10)
  const tinyPng = makeDecodablePngDataUri(48, 48, { seedByte: 0x55, solid: true, compressionLevel: 9 });
  assert.ok(tinyPng.length < 350, `expected small compressed 48x48 PNG URI (<350 chars, got ${tinyPng.length})`);
  const tinyBatch = structuredClone(noImgBatch);
  tinyBatch.candidates = [tinyBatch.candidates[0]];
  tinyBatch.candidates[0].presentation.hero_image_data_uri = tinyPng;
  tinyBatch.candidates[0].presentation.image_data_uri = tinyPng;
  const tinyHtml = renderReport(scoreBatch(tinyBatch, r59Profile), tinyBatch);
  assert.doesNotMatch(tinyHtml, /img-defs-sprite/, 'tiny repeated PNG must not incur one-time CSS/sprite overhead');
  assert.doesNotMatch(tinyHtml, /\.img-defs-sprite\{/);
});

test('Batch A2.3: honest 2027 Q4 unpublished peak copy and Coupon flat-fee switch / actual campaign denominator note', () => {
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
  assert.equal(evgScored.candidates[0].effective_disposition, 'full_annual_qualifying');
  assert.ok(evgScored.candidates[0].unpublished_2027_q4_peak_note);
  const evgHtml = renderReport(evgScored, evgBatch);
  assert.match(evgHtml, /非旺季达标 · 2027 Q4 旺季费率待公布/);
  assert.doesNotMatch(evgHtml, /完整达标 · 可推进/);
  assert.doesNotMatch(evgHtml, /实际核券/);
  assert.doesNotMatch(evgHtml, /—/);

  // Helper to attach ongoing coupon fields to evgCand
  const makeCouponCand = ({ id, campaignUnits, includeFlat = true }) => {
    const c = structuredClone(evgCand);
    c.id = id;
    const sc = c.economics.scenarios[0];
    sc.cost_ledger.list_price_usd = 44.0;
    sc.cost_ledger.ongoing_coupon_usd = 4.0;
    sc.cost_ledger.net_effective_price_usd = 40.0;
    sc.cost_ledger.price_usd = 40.0;
    sc.cost_ledger.promo_basis_already_net = true;
    if (campaignUnits !== undefined) sc.cost_ledger.coupon_campaign_units = campaignUnits;
    sc.cost_ledger.include_coupon_campaign_flat = includeFlat;
    sc.price_anchor = {
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
      evidence: [c.evidence[0].id],
    };
    c.screening.reference_price_usd = structuredClone(sc.price_anchor);
    delete sc.margin;
    delete sc.contribution_usd;
    return c;
  };

  // 2. Ongoing coupon ($5/100 + 2.5%) surfaces honest fixed-fee amortization denominator note
  const cpn100 = makeCouponCand({ id: 'cand-a2-coupon-100', campaignUnits: 100, includeFlat: true });
  const cpn100Batch = { schema_version: 1, profile_revision: 59, candidates: [cpn100] };
  const cpn100Html = renderReport(scoreBatch(cpn100Batch, r59Profile), cpn100Batch);
  assert.match(cpn100Html, /\$5\/100 \+ 2\.5%/);
  assert.match(cpn100Html, /100 笔核券单/);
  assert.match(cpn100Html, /不与 100 套采购量挂钩/);
  assert.doesNotMatch(cpn100Html, /—/);

  // 3. Custom coupon_campaign_units = 25 reflects actual denominator (not hardcoded 100) (Astra P1 #2)
  const cpn25 = makeCouponCand({ id: 'cand-a2-coupon-25', campaignUnits: 25, includeFlat: true });
  const cpn25Batch = { schema_version: 1, profile_revision: 59, candidates: [cpn25] };
  const cpn25Html = renderReport(scoreBatch(cpn25Batch, r59Profile), cpn25Batch);
  assert.match(cpn25Html, /\$5\/25 \+ 2\.5%/);
  assert.match(cpn25Html, /25 笔核券单/);
  assert.doesNotMatch(cpn25Html, /100 笔核券单/);

  // 4. Disabled $5 flat fee (include_coupon_campaign_flat: false) must NOT claim $5 flat fee was included (Astra P1 #2)
  const cpnNoFlat = makeCouponCand({ id: 'cand-a2-coupon-no-flat', campaignUnits: 100, includeFlat: false });
  const cpnNoFlatBatch = { schema_version: 1, profile_revision: 59, candidates: [cpnNoFlat] };
  const cpnNoFlatHtml = renderReport(scoreBatch(cpnNoFlatBatch, r59Profile), cpnNoFlatBatch);
  assert.match(cpnNoFlatHtml, /已关闭单场 \$5 固定活动费|未计入单场 \$5 固定活动费/);
  assert.doesNotMatch(cpnNoFlatHtml, /\$5\/100 \+ 2\.5%/);
  assert.doesNotMatch(cpnNoFlatHtml, /—/);

  // 5. Conditional post-coupon banner & single-parent anchor warning (Board #130 addendum)
  const pbCand = structuredClone(evgCand);
  pbCand.id = 'cand-a2-conditional-post-coupon';
  pbCand.price_band_analysis = {
    all_young_niche: true,
    mature_regular_band: {
      all_under_90d_blue_ocean: true,
      conditional_post_coupon_observation: true,
      heavy_coupon_excluded: false,
      top_amber_banner_zh: '全员 90 天内新品蓝海（未剔除大额券，仅作条件观察）',
      single_parent_anchor_note_zh: '高价锚点仅由单一父体 P0SYNANCHOR1 支撑，定价上限存在集中度风险。',
    },
  };
  const pbBatch = { schema_version: 1, profile_revision: 59, candidates: [pbCand] };
  const pbHtml = renderReport(scoreBatch(pbBatch, r59Profile), pbBatch);
  assert.match(pbHtml, /全员 90 天内新品蓝海（未剔除大额券，仅作条件观察）/);
  assert.doesNotMatch(pbHtml, /已按剔除 ≥20% 大额券后的在售常规价核算参考账/, 'conditional post-coupon banner must not append contradictory ex-heavy-coupon suffix');
  assert.match(pbHtml, /高价锚点集中度提醒/);
  assert.match(pbHtml, /P0SYNANCHOR1/);
  assert.doesNotMatch(pbHtml, /—/);
});

test('Batch A2.4: Keepa newcomer review-jump/drop hints gate strictly to active <=90d newcomers and scrub all PII/paths/em-dashes', () => {
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

  // Old (>90d) and excluded (old_reviews_predate_launch) members MUST NOT enter review_anomaly_advisories (Astra P2 #3)
  const gatedCand = structuredClone(cleanCand);
  gatedCand.newcomer_cohort.members.push(
    {
      ...structuredClone(gatedCand.newcomer_cohort.members[0]),
      family_id: 'fam-old-681d',
      asin: 'B0SYNOLD681',
      launch_date: '2025-01-01',
      keepa_review_drop_detected: true,
    },
    {
      ...structuredClone(gatedCand.newcomer_cohort.members[0]),
      family_id: 'fam-predate-excl',
      asin: 'B0SYNEXCL43',
      old_reviews_predate_launch: true,
      keepa_review_jump_detected: true,
    },
  );
  const gatedBatch = { schema_version: 1, profile_revision: 59, candidates: [gatedCand] };
  const gatedScored = scoreBatch(gatedBatch, r59Profile);
  assert.equal(
    gatedScored.candidates[0].diagnostics.newcomers.members.find(m => m.asin === 'B0SYNOLD681')?.age_days,
    681,
  );
  assert.equal(gatedScored.candidates[0].diagnostics.newcomers.review_anomaly_advisories, undefined);
  const gatedHtml = renderReport(gatedScored, gatedBatch);
  assert.doesNotMatch(gatedHtml, /Keepa 评论变动提示/);
  assert.doesNotMatch(gatedHtml, /90天内新品 B0SYNOLD681/);
  assert.doesNotMatch(gatedHtml, /90天内新品 B0SYNEXCL43/);

  // Unified scrubbing on BOTH free-text note AND structured events: D:\ path, email parent_asin, and em-dash (Astra P1 #6)
  const scrubCand = structuredClone(cleanCand);
  scrubCand.newcomer_cohort.members[0].keepa_review_drop_detected = true;
  scrubCand.newcomer_cohort.members[0].keepa_review_anomaly_note =
    'Keepa 骤降见 D:\\fieldwork\\private-folder\\receipt.json — contact ops@example.com';
  scrubCand.newcomer_cohort.members[1].keepa_review_jump_detected = true;
  scrubCand.newcomer_cohort.members[1].keepa_review_anomaly_summary = {
    asin: scrubCand.newcomer_cohort.members[1].asin,
    parent_asin: 'sample@example.invalid',
    has_jump: true,
  };
  scrubCand.newcomer_cohort.members[1].keepa_review_anomaly_events = [
    {
      direction: 'jump',
      delta: 19,
      from_count: 1,
      to_count: 20,
      date_from: '2026-11-01 — D:\\secret\\log.txt',
      date_to: '2026-11-03',
      asin: scrubCand.newcomer_cohort.members[1].asin,
    },
  ];
  const scrubBatch = { schema_version: 1, profile_revision: 59, candidates: [scrubCand] };
  const scrubScored = scoreBatch(scrubBatch, r59Profile);
  assert.equal(scrubScored.candidates[0].diagnostics.newcomers.review_anomaly_advisories.length, 2);
  assert.deepEqual(scrubScored.candidates[0].total_range, cClean.total_range);
  const scrubHtml = renderReport(scrubScored, scrubBatch);
  assert.match(scrubHtml, /Keepa 评论变动提示/);
  assert.doesNotMatch(scrubHtml, /fieldwork|receipt\.json|ops@example\.com|sample@example\.invalid|secret\\log\.txt/i);
  assert.doesNotMatch(scrubHtml, /—/, 'scrubbed Keepa advisories must emit zero em-dashes');
});
