import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { runPhase2Cli } from '../src/phase2-cli.mjs';
import { containsSecretToken, detectRawPii } from '../src/contracts.mjs';
import { OpenAiClient, openOpenAiBudgetLedger } from '../src/openai/index.mjs';
import { openSelectionStore } from '../src/store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'blueprint-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'selection-fixture.sqlite');
  const credential = join(dir, 'mock-credential.json');
  writeFileSync(credential, JSON.stringify({ api_key: ['mock', 'fixture', 'credential'].join('-') }));
  const opts = { testMode: true, canonicalRegistryPath: join(dir, 'mock-registry.sqlite') };
  const store = openSelectionStore(db);
  store.upsertCandidateForm({ form_id: 'SYNTH-FORM-A', label: 'Steel compass jig',
    buyer_task: 'Mark circles in oak', saleable_set_composition: { jig: 1 } });
  store.upsertRawLead({ lead_id: 'SYNTH-LEAD-A', source_channel: '1688_factory_cold_start',
    source_ref: 'https://example.org/fixture/jig', phrase_or_title: 'Steel compass jig',
    observed_at: '2026-11-22', disposition: 'product' });
  store.close();
  const ledger = openOpenAiBudgetLedger(db, opts);
  ledger.reconcileLegacySummary({ recognized_schema: true, month_utc: new Date().toISOString().slice(0, 7),
    file_sha256: 'a'.repeat(64), total_rows: 0, unresolved_count: 0, same_month_reserved_cents: 0 }, {
    allowSyntheticSummaryForTests: true, enable: true, hardMonthlyLimitConfirmed: true, autoRechargeOffConfirmed: true });
  ledger.close();
  const hooks = { testLedgerOptions: opts, openAiClientOptions: { testMode: true, fetchImpl: () => assert.fail('Unexpected HTTP request') } };
  async function run(command, ...args) {
    let stdout = '', stderr = '';
    const rc = await runPhase2Cli([command, ...args],
      { stdout: { write: s => stdout += s }, stderr: { write: s => stderr += s } }, hooks);
    return { rc, out: stdout ? JSON.parse(stdout) : null, stderr };
  }
  function file(name, payload) {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(payload));
    return path;
  }
  return { dir, db, credential, opts, hooks, run, file, live: ['--db', db, '--credential-file', credential] };
}

test('read-only duplicate and funnel CLI report all source kinds and use a discovery cohort', async t => {
  const f = fixture(t);
  const proposals = f.file('proposals.json', { candidates: [{ title: 'adjustable steel compass jig' }, { title: 'ceramic kiln spacer' }] });
  const out = join(f.dir, 'report.json');
  const dbBytes = readFileSync(f.db);
  const dup = await f.run('dedupe-forms', '--db', f.db, '--input', proposals, '--output', out);
  assert.equal(dup.rc, 0, dup.stderr);
  assert.deepEqual(dup.out.proposals[0].matches.map(r => r.kind).sort(), ['form','lead']);
  assert.equal(dup.out.proposals[1].matches.length, 0);
  const report = await f.run('funnel-ledger', '--db', f.db, '--output', out);
  assert.equal(report.rc, 0, report.stderr);
  assert.equal(report.out.candidates.discovered, 1);
  assert.deepEqual(Object.keys(report.out.quota).sort(), ['exa','sif','ss_mcp','ss_web']);
  assert.equal(report.out.openai.completed_usage_cost_micros, 0);
  assert.equal((await f.run('funnel-ledger', '--db', f.db, '--since', '2099-01-01T00:00:00Z')).out.candidates.discovered, 0);
  assert.equal((await f.run('funnel-ledger', '--db', f.db, '--since', 'yesterday')).rc, 2);
  assert.deepEqual(readFileSync(f.db), dbBytes);
  const policy = await f.run('openai-reconcile', '--db', f.db, '--same-month-pending-buffer-cents', '1000');
  assert.equal(policy.rc, 0, policy.stderr);
  assert.equal(policy.out.status.policy.same_month_pending_buffer_cents, 1000);
  assert.equal((await f.run('openai-reconcile', '--db', f.db, '--same-month-pending-buffer-cents','2001')).rc, 2);
});

test('solve-min-price CLI uses the quoted saleable sets and compares with a mature band', async t => {
  const f = fixture(t);
  const spec = { pkg: { length_in: 10, width_in: 6, height_in: 2, weight_lb: 1.5 }, refund_fraction: 0.04,
    physical_return_fraction: 0.04, fee_category: 'Tools & Home Improvement', headhaul_usd: 2.20, collection_rate: 0.006,
    referral_terms: { referral_fraction: 0.15, refund_admin_fraction: 0.2, refund_admin_cap_usd: 5, minimum_referral_usd: 0.30 },
    sales_window: { from: '2027-02-01', through: '2027-09-30' }, storage_window: { from: '2027-02-01', through: '2027-09-30' },
    inbound_window: { from: '2027-01-20', through: '2027-02-01' }, is_apparel: false, is_sipp: false, is_dangerous_goods: false,
    quote: { goods_cny_total: 7000, domestic_freight_cny_total: 350, actual_sets: 105, fx_cny_per_usd: 7 },
    mature_price_band: { p25_usd: 50, p75_usd: 60 } };
  const solution = await f.run('solve-min-price', '--input', f.file('quote.json', spec));
  assert.equal(solution.rc, 0, solution.stderr);
  assert.equal(solution.out.solution.landed_domestic_usd, 10);
  assert.ok(solution.out.min_retail_price_for_30pct_usd >= 29.99);
  assert.equal(solution.out.mature_band_comparison, 'below_band');
  const historical = await f.run('solve-min-price', '--input', f.file('historical.json', {
    ...spec, mature_price_band: { band: { p25_usd: null, p75_usd: null }, regular_band_reference: spec.mature_price_band },
  }));
  assert.equal(historical.out.mature_band_comparison, 'below_band');
});

test('luna-triage CLI writes exact-peer prices and receipts and rejects output aliases before billing', async t => {
  const f = fixture(t);
  const input = f.file('peers.json', ['001','002','003'].map((n,i) => ({ candidate_id: 'SYNTH-PEER-' + n,
    title: 'Synthetic steel compass jig', fulfillment: 'FBA', price_usd: [40,44,10][i] })));
  let posts = 0;
  f.hooks.openAiClientOptions.fetchImpl = async (url, opts) => {
    posts++;
    assert.equal(opts.method, 'POST');
    assert.ok(url.endsWith('/v1/decisions'));
    const wire = JSON.parse(opts.body);
    return Response.json({ id: 'dec_fixture_triage_' + posts, model: 'gpt-6-luna', usage: { input_tokens: 100, output_tokens: 20 },
      decisions: wire.questions.map(q => ({ name: q.name, type: q.type, value: q.type === 'predicate'
        ? false : q.name.endsWith('003') ? 'accessory_or_consumable_decoy' : 'exact_peer' })) });
  };
  assert.equal((await f.run('luna-triage', ...f.live, '--listings', input, '--output', f.credential)).rc, 2);
  const secret = ['s' + 'k', 'syntheticTokenFixture'].join('-');
  const unsafe = f.file('unsafe.json', [{ candidate_id: 'SYNTH-PEER-A', image_url: 'https://example.org/' + secret }]);
  const refused = await f.run('luna-triage', ...f.live, '--listings', unsafe, '--output', join(f.dir, 'unsafe-out.json'));
  assert.equal(refused.rc, 2);
  assert.ok(!refused.stderr.includes(secret));
  assert.equal(posts, 0);
  const output = join(f.dir, 'triage.json');
  const cli = await f.run('luna-triage', ...f.live, '--listings', input, '--output', output);
  assert.equal(cli.rc, 0, cli.stderr + JSON.stringify(cli.out));
  const out = JSON.parse(readFileSync(output));
  assert.equal(out.receipts.length, 1);
  assert.equal(out.receipts[0].usage_cost_micros, 20);
  assert.equal(out.analysis.mainstream_count, 2);
  assert.equal(out.tightened_clusters.clusters[0].band.min_usd, 40);
  assert.equal(posts, 1);
  const funnel = (await f.run('funnel-ledger', '--db', f.db)).out;
  assert.equal(funnel.openai.completed_usage_cost_micros, 20);
  assert.equal(funnel.openai.input_tokens, 100);
  const visualInput = f.file('sheet-input.json', { listings: JSON.parse(readFileSync(input)).map((r, i) => ({ ...r, idx: 3 - i })) });
  const sheet = join(f.dir, 'sheet.png'), manifest = join(f.dir, 'sheet-manifest.json');
  const render = await f.run('contact-sheet', '--input', visualInput, '--output', sheet, '--manifest-out', manifest, '--offline');
  assert.equal(render.rc, 0, render.stderr);
  const visual = await f.run('luna-triage', ...f.live, '--listings', visualInput, '--contact-sheet', sheet, '--detail', 'low', '--output', output);
  assert.equal(visual.rc, 0, visual.stderr + JSON.stringify(visual.out));
  assert.deepEqual(JSON.parse(readFileSync(output)).triage.items.map(r => r.tile_index), [3,2,1]);
  assert.ok(readFileSync(manifest, 'utf8').includes('SYNTH-PEER-001'));
});

test('rights-prescreen CLI uses uncapped background, stores validated results, and cancels only a bound attempt', async t => {
  const f = fixture(t);
  const input = f.file('rights-input.json', { form_id: 'SYNTH-FORM-A', label: 'Compass jig', buyer_task: 'Mark drill points' });
  const section = { status: 'needs_verification', summary: 'Synthetic review needs source confirmation.',
    citations: [{ title: 'Synthetic public record', url: 'https://example.org/fixture', identifier: null, applies_to_target_spec: null, legal_status: null }] };
  const parsed = { schema_version: 1, contract: 'RightsAndCompliancePreScreener', specific_design_rights: section,
    trademark_conflicts: section, trade_duty_alerts: section, applicable_public_requirements: { ...section, frameworks_checked: ['CPSC'] },
    disclaimer: 'Initial public pre-screen only; this is not final legal clearance or legal advice.' };
  const usage = { input_tokens: 50, output_tokens: 10 };
  let calls = [];
  let id = 'resp_fixture_rights';
  f.hooks.openAiClientOptions.fetchImpl = async (url, opts) => {
    calls.push(opts.method);
    if (url.endsWith('/cancel')) return Response.json({ id, status: 'cancelled', model: 'gpt-6.1-terra', usage, output: [] });
    const wire = JSON.parse(opts.body);
    assert.equal(wire.background, true);
    assert.equal(wire.store, true);
    assert.equal(wire.max_tool_calls, undefined);
    return Response.json({ id, model: 'gpt-6.1-terra', status: id.endsWith('active') ? 'queued' : 'completed', usage,
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(parsed) }] }] });
  };
  const output = join(f.dir, 'rights.json'), progress = join(f.dir, 'progress.json');
  const run = await f.run('openai-task', ...f.live, '--task', 'rights-prescreen', '--input', input, '--progress-file', progress, '--output', output);
  assert.equal(run.rc, 0, run.stderr + JSON.stringify(run.out));
  assert.equal(JSON.parse(readFileSync(progress)).status, 'completed');
  assert.equal(JSON.parse(readFileSync(output)).result.valid, true);
  assert.equal(run.out.receipt.usage_cost_micros, 100);
  id = 'resp_fixture_active';
  const ledger = openOpenAiBudgetLedger(f.db, f.opts);
  let active;
  try {
    const client = new OpenAiClient({ ...f.hooks.openAiClientOptions, ledger, credentialFile: f.credential });
    active = await client.createResponse({ input: 'Synthetic task', background: true }, { waitForCompletion: false });
  } finally { ledger.close(); }
  const cancel = await f.run('openai-cancel', ...f.live, '--attempt', active.attempt_id);
  assert.equal(cancel.rc, 0, cancel.stderr);
  assert.equal(cancel.out.receipt.usage_cost_micros, 100);
  assert.deepEqual(calls, ['POST','POST','POST']);
});

test('containsSecretToken restricts raster exemption to fully decoded dedicated image fields and rejects fake PNGs or ordinary text', () => {
  const pngChunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(20, 0); // width = 20 px (RGB = 60 pixel bytes + 1 filter byte = 61 scanline bytes)
  ihdrData.writeUInt32BE(1, 4);  // height = 1 px
  ihdrData[8] = 8;               // bit depth = 8
  ihdrData[9] = 2;               // color type = RGB
  const ihdr = pngChunk('IHDR', ihdrData);
  const iend = pngChunk('IEND', Buffer.alloc(0));

  const collisionB64 = '+' + ['AI', 'zaSyFakeCollision0123456789'].join('') + '+' + ['AK', 'IA0123456789ABCDEF'].join('') + '+';
  const pixelBytes = Buffer.alloc(60, 0);
  // Align mod-3 byte offset in final PNG buffer (8 sig + 25 IHDR + 8 IDAT hdr + 7 zlib/stored hdr + 1 filter + 2 = 51, 51 % 3 === 0)
  Buffer.from(collisionB64, 'base64').copy(pixelBytes, 2);
  const scanline = Buffer.concat([Buffer.from([0x00]), pixelBytes]); // filter 0 + 60 RGB bytes
  const idat = pngChunk('IDAT', deflateSync(scanline, { level: 0 }));
  const realDecodablePngUri = 'data:image/png;base64,' + Buffer.concat([pngSig, ihdr, idat, iend]).toString('base64');
  assert.equal(realDecodablePngUri.includes(['AI', 'zaSyFakeCollision0123456789'].join('')), true);

  // Allowed ONLY inside dedicated image fields (and JSON wire payloads carrying dedicated image fields)
  assert.equal(containsSecretToken({ image_url: realDecodablePngUri }), false);
  assert.equal(containsSecretToken(JSON.stringify({ type: 'input_image', image_url: realDecodablePngUri })), false);
  // Ordinary non-image fields and bare strings still trigger secret detection
  assert.equal(containsSecretToken(realDecodablePngUri), true);
  assert.equal(containsSecretToken({ note: realDecodablePngUri }), true);

  // Fake PNG lacking valid CRC-32 / decodable IDAT stream is rejected even inside { image_url }
  const fakePngUri = 'data:image/png;base64,' + Buffer.concat([pngSig, ihdr, Buffer.from(collisionB64, 'base64'), iend]).toString('base64');
  assert.equal(containsSecretToken(fakePngUri), true);
  assert.equal(containsSecretToken({ image_url: fakePngUri }), true);

  // Case-insensitive standard prefixes and packaging PII false-positive regression checks
  assert.equal(containsSecretToken(['s' + 'k', 'liveSecretFixture12345'].join('-')), true);
  assert.equal(containsSecretToken(['GH' + 'P', 'UppercasePrefixFixture12345'].join('_')), true);
  assert.equal(detectRawPii('平板叠放发货配四角珍珠棉与五层硬盒即可安全头程入仓'), null);
  assert.equal(detectRawPii('收件地址：科技路88号3栋5层'), 'detailed_street_address');
});
