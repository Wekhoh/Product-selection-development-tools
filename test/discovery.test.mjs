import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachDiscovery, prepareDiscovery } from '../src/discovery.mjs';
import { scoreBatch } from '../src/scoring.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-discovery.json', import.meta.url), 'utf8'));
const batchFixture = JSON.parse(readFileSync(new URL('../fixtures/synthetic-batch.json', import.meta.url), 'utf8'));
const profile = JSON.parse(readFileSync(new URL('../docs/design/reference-profile.r59.draft.json', import.meta.url), 'utf8'));

test('exact normalized phrases merge without losing original source metrics or form support', () => {
  const original = structuredClone(fixture);
  const manifest = prepareDiscovery(fixture.pool, fixture.decisions);
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.kind, 'discovery_manifest');
  assert.equal(manifest.leads.length, 9);
  assert.deepEqual(manifest.leads[0].phrases, ['synthetic rack', ' SYNTHETIC   RACK ']);
  assert.deepEqual(manifest.leads[0].provenance, [fixture.pool.keywords[0].provenance[0], fixture.pool.keywords[1].provenance[0]]);
  assert.equal(manifest.leads[0].provenance[1].searches, 0);
  assert.equal(manifest.leads[0].provenance[1].purchases, null);
  assert.equal(Object.hasOwn(manifest.leads[0], 'searches'), false);
  assert.deepEqual(manifest.forms[0].lead_keywords, ['synthetic rack', 'synthetic storage rack', 'synthetic activity']);
  assert.deepEqual(fixture, original);
});

test('unreviewed and unresolved words stay pending separately from explicitly set-aside words', () => {
  const manifest = prepareDiscovery(fixture.pool, fixture.decisions);
  assert.deepEqual(manifest.summary, {
    raw_keyword_records: 10, source_rows: 10, unique_keywords: 9,
    reviewed_keywords: 8, unreviewed_keywords: 1, supported_keywords: 3,
    excluded_keywords: 3, pending_keywords: 3, forms: 1,
    dispositions: { product: 2, context: 1, brand_specific: 1, promotion_only: 1,
      delivery_only: 1, seasonal_deferred: 1, needs_context: 1, unreviewed: 1 },
  });
  const unknown = manifest.leads.find(lead => lead.normalized_key === 'synthetic unreviewed phrase');
  assert.equal(unknown.disposition, 'unreviewed');
  assert.equal(unknown.reason, null);
  assert.equal(manifest.leads.find(lead => lead.normalized_key === 'syntheticbrandzxq compatible holder').disposition, 'needs_context');
  assert.equal(manifest.leads[0].disposition, 'product');
});

test('invalid source identities and conflicting row references cannot become sourced leads', () => {
  const cases = [
    [pool => { delete pool.keywords[0].normalized_key; }, /normalized_key/],
    [pool => { pool.keywords[0].normalized_key = 'another phrase'; }, /normalized_key/],
    [pool => { pool.keywords[0].keyword = ' '; }, /keyword/],
    [pool => { pool.keywords[0].provenance = []; }, /provenance/],
    [pool => { delete pool.keywords[0].provenance[0].source_id; }, /source_id/],
    [pool => { delete pool.keywords[0].provenance[0].source_path; }, /source_path/],
    [pool => { pool.keywords[0].provenance[0].row_index = -1; }, /row_index/],
    [pool => { pool.keywords[0].provenance[0].row_index = 0.5; }, /row_index/],
    [pool => { pool.keywords[2].provenance = structuredClone(pool.keywords[0].provenance); }, /Conflicting source row/],
    [pool => { pool.keywords[1].provenance = structuredClone(pool.keywords[0].provenance); pool.keywords[1].provenance[0].searches = 999; }, /Conflicting source row/],
  ];
  for (const [breakSource, message] of cases) {
    const pool = structuredClone(fixture.pool);
    breakSource(pool);
    assert.throws(() => prepareDiscovery(pool, fixture.decisions), { name: 'TypeError', message });
  }
  assert.throws(() => prepareDiscovery({ keywords: null }, fixture.decisions), { name: 'TypeError', message: /pool.keywords/ });
});

test('assessment references and contradictory duplicate interpretations require explicit reconciliation', () => {
  const cases = [
    [decisions => { decisions.assessments[0].keyword = 'invented unsourced term'; }, /not sourced/],
    [decisions => { decisions.assessments[0].disposition = 'automatically_profitable'; }, /disposition/],
    [decisions => { decisions.assessments[0].disposition = 'unreviewed'; }, /disposition/],
    [decisions => { decisions.assessments[0].reason = ''; }, /reason/],
    [decisions => { decisions.assessments[0].direction = ''; }, /direction/],
    [decisions => { decisions.assessments.push({ ...decisions.assessments[0], keyword: ' SYNTHETIC  RACK ', disposition: 'context' }); }, /Conflicting assessments/],
    [decisions => { decisions.assessments.push({ ...decisions.assessments[0], reason: 'Contradictory replacement rationale.' }); }, /Conflicting assessments/],
  ];
  for (const [breakAssessment, message] of cases) {
    const decisions = structuredClone(fixture.decisions);
    breakAssessment(decisions);
    assert.throws(() => prepareDiscovery(fixture.pool, decisions), { name: 'TypeError', message });
  }
  const decisions = structuredClone(fixture.decisions);
  decisions.assessments.push({ ...decisions.assessments[0], keyword: 'ＳＹＮＴＨＥＴＩＣ　ＲＡＣＫ' });
  const manifest = prepareDiscovery(fixture.pool, decisions);
  assert.equal(manifest.summary.reviewed_keywords, 8);
});

test('a form requires reviewed sourced product or context leads and unambiguous offer references', () => {
  const cases = [
    [decisions => { decisions.forms[0].id = ''; }, /form id/],
    [decisions => { decisions.forms[0].candidate_id = ''; }, /candidate_id/],
    [decisions => { decisions.forms[0].label = ''; }, /label/],
    [decisions => { decisions.forms[0].description = ''; }, /description/],
    [decisions => { decisions.forms[0].lead_keywords = []; }, /lead_keywords/],
    [decisions => { decisions.forms[0].lead_keywords = ['invented unsupported rack']; }, /not sourced/],
    [decisions => { decisions.forms[0].lead_keywords = ['synthetic unreviewed phrase']; }, /product or context/],
    [decisions => { decisions.forms[0].lead_keywords = ['SyntheticBrandZXQ compatible holder']; }, /product or context/],
    [decisions => { decisions.forms[0].lead_keywords = ['synthetic brand store']; }, /product or context/],
    [decisions => { decisions.forms[0].lead_keywords = ['synthetic event ornament']; }, /product or context/],
    [decisions => { decisions.forms[0].offer_evidence = []; }, /offer_evidence/],
    [decisions => { decisions.forms[0].offer_evidence = ['']; }, /offer evidence/],
    [decisions => { decisions.forms.push({ ...decisions.forms[0], candidate_id: 'synthetic-range' }); }, /form IDs.*unique/],
    [decisions => { decisions.forms.push({ ...decisions.forms[0], id: 'synthetic-conflicting-form' }); }, /candidate.*one form/],
  ];
  for (const [breakForm, message] of cases) {
    const decisions = structuredClone(fixture.decisions);
    breakForm(decisions);
    assert.throws(() => prepareDiscovery(fixture.pool, decisions), { name: 'TypeError', message });
  }
  const decisions = structuredClone(fixture.decisions);
  decisions.forms[0].lead_keywords = ['synthetic activity', ' SYNTHETIC  ACTIVITY '];
  assert.deepEqual(prepareDiscovery(fixture.pool, decisions).forms[0].lead_keywords, ['synthetic activity']);
});

test('a persisted manifest binds full provenance to the existing card without changing any of its 21 scores', () => {
  const manifest = JSON.parse(JSON.stringify(prepareDiscovery(fixture.pool, fixture.decisions)));
  const originalManifest = structuredClone(manifest);
  const batch = structuredClone(batchFixture);
  const originalBatch = structuredClone(batch);
  const attached = attachDiscovery(batch, manifest);
  const discovery = attached.candidates[0].discovery;
  assert.equal(discovery.form_id, 'synthetic-rack-form');
  assert.deepEqual(discovery.lead_keywords, ['synthetic rack', 'synthetic storage rack', 'synthetic activity']);
  assert.deepEqual(discovery.leads, manifest.leads.slice(0, 3));
  assert.deepEqual(discovery.offer_evidence, ['synthetic-evidence']);
  assert.deepEqual(attached.discovery_summary, { ...manifest.summary, bound_candidates: 1, unbound_candidates: 2 });
  assert.equal(attached.candidates[1].discovery, undefined);
  assert.deepEqual(scoreBatch(attached, profile), scoreBatch(batch, profile));
  discovery.leads[0].provenance[1].native_detail.purchase_status = 'changed only in returned clone';
  attached.candidates[0].metrics.purchase_demand_scale.value = 1;
  assert.deepEqual(batch, originalBatch);
  assert.deepEqual(manifest, originalManifest);
});

test('one sourced activity can support several independently evidenced physical forms without multiplying its metrics', () => {
  const decisions = structuredClone(fixture.decisions);
  decisions.forms.push({
    id: 'synthetic-fabric-form', candidate_id: 'synthetic-range', label: 'Synthetic fabric organizer',
    description: 'Synthetic foldable fabric compartments; materially different from the rack.',
    lead_keywords: ['synthetic activity'], offer_evidence: ['synthetic-fabric-offer'],
  });
  const batch = structuredClone(batchFixture);
  batch.candidates[1].form = 'Synthetic foldable fabric compartments';
  batch.candidates[1].evidence.push({ id: 'synthetic-fabric-offer', source: 'Synthetic physical-form offer',
    observed_at: '2026-11-13', path: 'synthetic/fabric-offer.json' });
  const manifest = prepareDiscovery(fixture.pool, decisions);
  const attached = attachDiscovery(batch, manifest);
  assert.equal(attached.discovery_summary.forms, 2);
  assert.equal(attached.discovery_summary.source_rows, 10);
  assert.equal(attached.discovery_summary.unique_keywords, 9);
  assert.equal(attached.candidates[0].discovery.form_id, 'synthetic-rack-form');
  assert.equal(attached.candidates[1].discovery.form_id, 'synthetic-fabric-form');
  assert.equal(attached.candidates[1].discovery.leads[0].provenance[0].searches, null);
  assert.equal(Object.hasOwn(attached.candidates[1].discovery, 'searches'), false);
  assert.deepEqual(scoreBatch(attached, profile), scoreBatch(batch, profile));
});

test('binding rejects unknown and duplicate candidate or evidence identities rather than picking the first', () => {
  const cases = [
    [(batch, manifest) => { manifest.forms[0].candidate_id = 'synthetic-missing-candidate'; }, /unknown candidate ID/],
    [batch => { batch.candidates.push(structuredClone(batch.candidates[0])); }, /Candidate IDs.*unique/],
    [batch => { batch.candidates[0].id = ''; }, /candidate id/],
    [(batch, manifest) => { manifest.forms.push({ ...manifest.forms[0], candidate_id: 'synthetic-range' }); }, /form IDs.*unique/],
    [(batch, manifest) => { manifest.forms.push({ ...manifest.forms[0], id: 'synthetic-other-form' }); }, /candidate.*one form/],
    [(batch, manifest) => { manifest.forms[0].offer_evidence = ['synthetic-missing-evidence']; }, /unknown candidate evidence ID/],
    [(batch, manifest) => {
      batch.candidates[1].evidence.push({ id: 'synthetic-other-candidate-offer', source: 'Synthetic other candidate only', observed_at: '2026-11-13', path: 'synthetic/other.json' });
      manifest.forms[0].offer_evidence = ['synthetic-other-candidate-offer'];
    }, /unknown candidate evidence ID/],
    [batch => { batch.candidates[0].evidence.push({ ...batch.candidates[0].evidence[0], source: 'Synthetic conflicting source' }); }, /evidence IDs.*unique/],
    [batch => { delete batch.candidates[0].evidence[0].source; }, /offer evidence source/],
    [batch => { delete batch.candidates[0].evidence[0].observed_at; }, /offer evidence observed_at/],
    [batch => { delete batch.candidates[0].evidence[0].url; }, /inspectable path or URL/],
  ];
  for (const [breakReference, message] of cases) {
    const batch = structuredClone(batchFixture);
    const manifest = prepareDiscovery(fixture.pool, fixture.decisions);
    breakReference(batch, manifest);
    assert.throws(() => attachDiscovery(batch, manifest), { name: 'TypeError', message });
  }
});

test('offer URLs must be inspectable HTTP or HTTPS references', () => {
  const manifest = prepareDiscovery(fixture.pool, fixture.decisions);
  for (const url of ['javascript:alert(1)', 'file:///synthetic/offer.json', 'not a URL']) {
    const batch = structuredClone(batchFixture);
    batch.candidates[0].evidence[0].url = url;
    assert.throws(() => attachDiscovery(batch, manifest), { name: 'TypeError', message: /offer evidence URL/i });
  }
});

test('an unknown optional evidence location does not erase an inspectable alternative', () => {
  const manifest = prepareDiscovery(fixture.pool, fixture.decisions);
  const batch = structuredClone(batchFixture);
  batch.candidates[0].evidence[0].path = 'synthetic/saved-offer.json';
  batch.candidates[0].evidence[0].url = null;
  assert.equal(attachDiscovery(batch, manifest).candidates[0].evidence[0].url, null);
  batch.candidates[0].evidence[0].path = null;
  batch.candidates[0].evidence[0].url = 'https://example.com/synthetic-offer';
  assert.equal(attachDiscovery(batch, manifest).candidates[0].evidence[0].path, null);
  batch.candidates[0].evidence[0].url = null;
  assert.throws(() => attachDiscovery(batch, manifest), { name: 'TypeError', message: /inspectable path or URL/ });
});

test('untouched source words remain pending without implicit product or brand classification', () => {
  const manifest = prepareDiscovery(fixture.pool, { assessments: [], forms: [] });
  assert.equal(manifest.summary.pending_keywords, 9);
  assert.equal(manifest.summary.unreviewed_keywords, 9);
  assert.equal(manifest.summary.excluded_keywords, 0);
  assert.equal(manifest.summary.forms, 0);
  assert.ok(manifest.leads.every(lead => lead.disposition === 'unreviewed' && lead.reason === null));
  const empty = prepareDiscovery({ keywords: [] }, { assessments: [], forms: [] });
  assert.deepEqual(attachDiscovery({ schema_version: 1, candidates: [] }, empty).discovery_summary, {
    raw_keyword_records: 0, source_rows: 0, unique_keywords: 0, reviewed_keywords: 0,
    unreviewed_keywords: 0, supported_keywords: 0, excluded_keywords: 0, pending_keywords: 0, forms: 0,
    dispositions: { product: 0, context: 0, brand_specific: 0, promotion_only: 0,
      delivery_only: 0, seasonal_deferred: 0, needs_context: 0, unreviewed: 0 },
    bound_candidates: 0, unbound_candidates: 0,
  });
});

test('persisted manifests are revalidated rather than trusting edited counts or review state', () => {
  const cases = [
    [manifest => { manifest.kind = 'unsupported_kind'; }, /discovery_manifest/],
    [manifest => { manifest.summary.source_rows = 999; }, /summary/],
    [manifest => { manifest.summary.raw_keyword_records = 1; }, /raw_keyword_records/],
    [manifest => { manifest.leads[0].provenance = []; }, /provenance/],
    [manifest => { manifest.leads[0].phrases[0] = 'invented phrase'; }, /normalized_key/],
    [manifest => { manifest.leads.push(structuredClone(manifest.leads[0])); }, /lead keys.*unique/],
    [manifest => { manifest.leads.push(null); }, /manifest lead/],
    [manifest => { manifest.leads.at(-1).reason = 'Pretend this was reviewed.'; }, /unreviewed/i],
    [manifest => { manifest.leads.at(-1).direction = 'Pretend this was assigned.'; }, /unreviewed/i],
  ];
  for (const [breakManifest, message] of cases) {
    const manifest = prepareDiscovery(fixture.pool, fixture.decisions);
    breakManifest(manifest);
    assert.throws(() => attachDiscovery(batchFixture, manifest), { name: 'TypeError', message });
  }
});
