import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runCli } from '../src/cli.mjs';
import { scoreBatch } from '../src/scoring.mjs';
import { renderReport } from '../src/report.mjs';
import { prepareDiscovery, attachDiscovery } from '../src/discovery.mjs';

const path = name => fileURLToPath(new URL(name, import.meta.url));
const batchPath = path('../fixtures/synthetic-batch.json');
const profilePath = path('../docs/design/reference-profile.draft.json');
const discoveryPath = path('../fixtures/synthetic-discovery.json');
const load = async name => JSON.parse(await readFile(name, 'utf8'));

test('the real CLI binds sourced forms, preserves scores and receipts all three inputs', async () => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'selection-discovery-'));
  const messages = [];
  const streams = { stdout: { write: text => messages.push(text) }, stderr: { write: text => messages.push(text) } };
  try {
    const status = await runCli(['--input', batchPath, '--profile', profilePath, '--discovery', discoveryPath, '--output', directory], streams);
    assert.equal(status, 0, messages.join(''));
    const [result, receipt, batch, profile] = await Promise.all([load(join(directory, 'result.json')), load(join(directory, 'receipt.json')), load(batchPath), load(profilePath)]);
    assert.deepEqual(result.candidates, scoreBatch(batch, profile).candidates);
    assert.equal(result.discovery.summary.bound_candidates, 1);
    assert.equal(result.discovery.leads.length, 9);
    assert.equal(receipt.inputs.discovery.sha256, createHash('sha256').update(await readFile(discoveryPath)).digest('hex'));
    assert.equal(receipt.status, 'complete');
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    assert.match(html, /如何发现这款/);
    assert.match(html, /synthetic-monthly-source/);
    assert.match(html, /不同来源的搜索量不相加/);
    assert.match(html, /来源词 9 个/);
    assert.equal((html.match(/data-item-id=/g) ?? []).length, 63);
    assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
  } finally {
    assert.equal(dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true });
  }
});

test('broken form references and an output collision stop before publishing', async () => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, 'selection-discovery-'));
  const messages = [];
  const streams = { stdout: { write: text => messages.push(text) }, stderr: { write: text => messages.push(text) } };
  try {
    const bundle = await load(discoveryPath);
    bundle.decisions.forms[0].offer_evidence = ['missing-offer'];
    const localInput = join(directory, 'result.json');
    await writeFile(localInput, JSON.stringify(bundle));
    const args = ['--input', batchPath, '--profile', profilePath, '--discovery', localInput, '--output', directory];
    assert.equal(await runCli(args, streams), 2);
    assert.match(messages.join(''), /unknown candidate evidence/);
    assert.deepEqual(await readdir(directory), ['result.json']);
    const original = await readFile(discoveryPath);
    await writeFile(localInput, original);
    messages.length = 0;
    assert.equal(await runCli(args, streams), 2);
    assert.match(messages.join(''), /覆盖.*发现记录/);
    assert.deepEqual(await readFile(localInput), original);
    assert.deepEqual(await readdir(directory), ['result.json']);
  } finally {
    assert.equal(dirname(await realpath(directory)), parent);
    await rm(directory, { recursive: true });
  }
});

test('discovery is optional and untrusted provenance stays escaped in the existing report', async () => {
  const batch = await load(batchPath);
  const profile = await load(profilePath);
  assert.doesNotMatch(renderReport(scoreBatch(batch, profile), batch), /如何发现这款/);
  const bundle = await load(discoveryPath);
  bundle.pool.keywords[0].provenance[0].source_id = '<script>source()</script>';
  bundle.pool.keywords[0].provenance[0].source_path = 'javascript:alert(1)';
  bundle.decisions.forms[0].description = '<img src=x onerror=alert(1)>';
  const attached = attachDiscovery(batch, prepareDiscovery(bundle.pool, bundle.decisions));
  const html = renderReport(scoreBatch(attached, profile), attached);
  assert.match(html, /&lt;script&gt;source\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b|<img src=x|href="javascript:/);
  assert.match(html, /合成双件收纳架/);
});

test('replacing a discovery manifest removes obsolete generated trails and preserves legacy origins', async () => {
  const batch = await load(batchPath);
  const profile = await load(profilePath);
  const bundle = await load(discoveryPath);
  const origin = { route: 'synthetic-social', evidence: ['synthetic-evidence'] };
  batch.candidates[0].discovery = origin;
  const linked = attachDiscovery(batch, prepareDiscovery(bundle.pool, bundle.decisions));
  assert.deepEqual(linked.candidates[0].discovery_context, origin);
  const replacement = structuredClone(bundle);
  replacement.decisions.forms = [];
  replacement.decisions.assessments[0].disposition = 'brand_specific';
  const updated = attachDiscovery(linked, prepareDiscovery(replacement.pool, replacement.decisions));
  assert.equal(updated.discovery_summary.bound_candidates, 0);
  assert.equal(updated.candidates[0].discovery, undefined);
  assert.deepEqual(updated.candidates[0].discovery_context, origin);
  assert.doesNotMatch(renderReport(scoreBatch(updated, profile), updated), /如何发现这款/);
  assert.deepEqual(batch.candidates[0].discovery, origin);
});

test('a form cannot use malformed or impossible observation dates as its sole offer evidence', async () => {
  const batch = await load(batchPath);
  const bundle = await load(discoveryPath);
  const offer = { id: 'new-offer', source: 'Synthetic physical offer', url: 'https://example.com/offer' };
  batch.candidates[0].evidence.push(offer);
  bundle.decisions.forms[0].offer_evidence = [offer.id];
  const manifest = prepareDiscovery(bundle.pool, bundle.decisions);
  for (const date of ['not a date', '2026-02-30', '2026-11-15T10:00:00', '2026-11-15T25:00:00Z']) {
    offer.observed_at = date;
    assert.throws(() => attachDiscovery(batch, manifest), /valid ISO/);
  }
  for (const date of ['2026-11-15', '2026-11-15T10:00:00+08:00']) {
    offer.observed_at = date;
    assert.equal(attachDiscovery(batch, manifest).discovery_summary.bound_candidates, 1);
  }
});
