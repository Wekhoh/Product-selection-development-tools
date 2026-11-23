import { isDeepStrictEqual } from 'node:util';
import { validEvidenceDate } from './observations.mjs';

const normalizeKeyword = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const dispositions = ['product', 'context', 'brand_specific', 'promotion_only', 'delivery_only', 'seasonal_deferred', 'needs_context'];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
}

function array(value, label, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new TypeError(`${label} must be ${nonempty ? 'a nonempty' : 'an'} array.`);
  return value;
}

// Semantic dispositions and physical-form relevance are supplied judgments, never inferred here.
export function prepareDiscovery(pool, decisions) {
  object(pool, 'pool');
  array(pool.keywords, 'pool.keywords');
  object(decisions, 'decisions');
  array(decisions.assessments, 'decisions.assessments');
  array(decisions.forms, 'decisions.forms');
  const grouped = new Map();
  const sourceRows = new Map();
  for (const entry of pool.keywords) {
    object(entry, 'pool keyword');
    text(entry.keyword, 'keyword');
    const key = normalizeKeyword(entry.keyword);
    if (text(entry.normalized_key, 'normalized_key') !== key) throw new TypeError('normalized_key must match the normalized keyword.');
    array(entry.provenance, 'keyword provenance', true);
    for (const source of entry.provenance) {
      object(source, 'provenance');
      text(source.source_id, 'provenance source_id');
      text(source.source_path, 'provenance source_path');
      if (!Number.isSafeInteger(source.row_index) || source.row_index < 0) throw new TypeError('provenance row_index must be a nonnegative integer.');
      const reference = JSON.stringify([source.source_id, source.source_path, source.row_index]);
      const previous = sourceRows.get(reference);
      if (previous && (previous.key !== key || !isDeepStrictEqual(previous.source, source))) {
        throw new TypeError('Conflicting source row references must be reconciled before discovery.');
      }
      sourceRows.set(reference, { key, source });
    }
    if (!grouped.has(key)) grouped.set(key, {
      keyword: entry.keyword, normalized_key: key, phrases: [], provenance: [],
    });
    const lead = grouped.get(key);
    const phrases = entry.phrases === undefined ? [] : array(entry.phrases, 'keyword phrases', true);
    for (const phrase of [entry.keyword, ...phrases]) {
      if (normalizeKeyword(text(phrase, 'keyword phrase')) !== key) throw new TypeError('Keyword phrases must share their normalized_key.');
      if (!lead.phrases.includes(phrase)) lead.phrases.push(phrase);
    }
    lead.provenance.push(...structuredClone(entry.provenance));
  }
  const assessments = new Map();
  for (const entry of decisions.assessments) {
    object(entry, 'assessment');
    const key = normalizeKeyword(text(entry.keyword, 'assessment keyword'));
    if (!grouped.has(key)) throw new TypeError('Assessment keyword is not sourced.');
    if (!dispositions.includes(entry.disposition)) throw new TypeError('Assessment disposition must name a supported discovery interpretation.');
    const assessment = { disposition: entry.disposition, reason: text(entry.reason, 'assessment reason'),
      ...(entry.direction === undefined ? {} : { direction: text(entry.direction, 'assessment direction') }) };
    if (assessments.has(key) && !isDeepStrictEqual(assessments.get(key), assessment)) {
      throw new TypeError('Conflicting assessments for one normalized keyword must be reconciled.');
    }
    assessments.set(key, assessment);
  }
  const leads = [...grouped.values()].map(lead => {
    const assessment = assessments.get(lead.normalized_key);
    return { ...lead, disposition: assessment?.disposition ?? 'unreviewed', reason: assessment?.reason ?? null,
      ...(assessment?.direction === undefined ? {} : { direction: assessment.direction }) };
  });
  const formIds = new Set();
  const candidateIds = new Set();
  const forms = decisions.forms.map(form => {
    object(form, 'form');
    text(form.id, 'form id');
    text(form.candidate_id, 'form candidate_id');
    text(form.label, 'form label');
    text(form.description, 'form description');
    if (formIds.has(form.id)) throw new TypeError('Discovery form IDs must be unique.');
    if (candidateIds.has(form.candidate_id)) throw new TypeError('A candidate can be bound to only one form.');
    formIds.add(form.id);
    candidateIds.add(form.candidate_id);
    const leadKeywords = [...new Set(array(form.lead_keywords, 'form lead_keywords', true)
      .map(keyword => normalizeKeyword(text(keyword, 'form lead keyword'))))];
    for (const key of leadKeywords) {
      if (!grouped.has(key)) throw new TypeError('Form lead keyword is not sourced.');
      if (!['product', 'context'].includes(assessments.get(key)?.disposition)) {
        throw new TypeError('Form leads must have a reviewed product or context disposition.');
      }
    }
    const offerEvidence = [...new Set(array(form.offer_evidence, 'form offer_evidence', true)
      .map(id => text(id, 'form offer evidence ID')))];
    return { ...structuredClone(form), lead_keywords: leadKeywords, offer_evidence: offerEvidence };
  });
  const counts = Object.fromEntries([...dispositions, 'unreviewed'].map(disposition =>
    [disposition, leads.filter(lead => lead.disposition === disposition).length]));
  const summary = {
    raw_keyword_records: pool.keywords.length,
    source_rows: leads.reduce((count, lead) => count + lead.provenance.length, 0),
    unique_keywords: leads.length, reviewed_keywords: leads.length - counts.unreviewed,
    unreviewed_keywords: counts.unreviewed, supported_keywords: counts.product + counts.context,
    excluded_keywords: counts.brand_specific + counts.promotion_only + counts.delivery_only,
    pending_keywords: counts.needs_context + counts.seasonal_deferred + counts.unreviewed,
    forms: forms.length, dispositions: counts,
  };
  return { schema_version: 1, kind: 'discovery_manifest', leads, forms, summary };
}

function validatedManifest(manifest) {
  object(manifest, 'manifest');
  if (manifest.schema_version !== 1 || manifest.kind !== 'discovery_manifest') throw new TypeError('A version-1 discovery_manifest is required.');
  array(manifest.leads, 'manifest.leads');
  object(manifest.summary, 'manifest.summary');
  for (const lead of manifest.leads) {
    object(lead, 'manifest lead');
    array(lead.phrases, 'manifest lead phrases', true);
    if (lead.disposition === 'unreviewed' && (lead.reason !== null || lead.direction !== undefined)) {
      throw new TypeError('Unreviewed manifest leads cannot claim an assessment reason or direction.');
    }
  }
  const assessments = manifest.leads.filter(lead => lead.disposition !== 'unreviewed').map(lead => ({
    keyword: lead.keyword, disposition: lead.disposition, reason: lead.reason,
    ...(lead.direction === undefined ? {} : { direction: lead.direction }),
  }));
  const checked = prepareDiscovery({ keywords: manifest.leads }, { assessments, forms: manifest.forms });
  if (checked.leads.length !== manifest.leads.length) throw new TypeError('Manifest lead keys must be unique.');
  const rawRecords = manifest.summary.raw_keyword_records;
  if (!Number.isSafeInteger(rawRecords) || rawRecords < checked.summary.unique_keywords || rawRecords > checked.summary.source_rows) {
    throw new TypeError('Manifest raw_keyword_records must match its sourced record bounds.');
  }
  checked.summary.raw_keyword_records = rawRecords;
  if (!isDeepStrictEqual(checked.summary, manifest.summary)) throw new TypeError('Manifest summary must match its leads and forms.');
  return checked;
}

// Bind evidence to existing candidates without altering their research inputs or scoring rules.
export function attachDiscovery(batch, manifest) {
  object(batch, 'batch');
  if (batch.schema_version !== 1) throw new TypeError('A version-1 batch is required for discovery binding.');
  array(batch.candidates, 'batch.candidates');
  const checked = validatedManifest(manifest);
  const result = structuredClone(batch);
  const candidates = new Map();
  for (const candidate of result.candidates) {
    object(candidate, 'candidate');
    text(candidate.id, 'candidate id');
    if (candidates.has(candidate.id)) throw new TypeError('Candidate IDs must be unique within a batch.');
    // A replacement manifest owns all generated trails, including removals.
    if (typeof candidate.discovery?.form_id === 'string' && Array.isArray(candidate.discovery.leads)) delete candidate.discovery;
    candidates.set(candidate.id, candidate);
  }
  const leads = new Map(checked.leads.map(lead => [lead.normalized_key, lead]));
  for (const form of checked.forms) {
    const candidate = candidates.get(form.candidate_id);
    if (!candidate) throw new TypeError('Discovery form references an unknown candidate ID.');
    const evidence = new Map();
    for (const entry of array(candidate.evidence, 'candidate.evidence')) {
      object(entry, 'candidate evidence');
      text(entry.id, 'candidate evidence ID');
      if (evidence.has(entry.id)) throw new TypeError('Candidate evidence IDs must be unique.');
      evidence.set(entry.id, entry);
    }
    for (const id of form.offer_evidence) {
      const source = evidence.get(id);
      if (!source) throw new TypeError('Form offer evidence references an unknown candidate evidence ID.');
      text(source.source, 'offer evidence source');
      if (!validEvidenceDate(source.observed_at)) throw new TypeError('offer evidence observed_at must be a valid ISO date or timestamp with timezone.');
      if (source.path !== undefined && source.path !== null) text(source.path, 'offer evidence path');
      if (source.url !== undefined && source.url !== null) {
        let url;
        try { url = new URL(text(source.url, 'offer evidence URL')); }
        catch { throw new TypeError('Offer evidence URL must be an absolute HTTP or HTTPS URL.'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Offer evidence URL must use HTTP or HTTPS.');
      }
      if (![source.path, source.url].some(value => typeof value === 'string' && value.trim())) {
        throw new TypeError('Offer evidence needs an inspectable path or URL.');
      }
    }
    if (candidate.discovery !== undefined) {
      if (candidate.discovery_context !== undefined && !isDeepStrictEqual(candidate.discovery_context, candidate.discovery)) {
        throw new TypeError('Conflicting legacy discovery origins require reconciliation.');
      }
      candidate.discovery_context = candidate.discovery;
    }
    candidate.discovery = {
      form_id: form.id, label: form.label, description: form.description,
      offer_evidence: [...form.offer_evidence], lead_keywords: [...form.lead_keywords],
      leads: structuredClone(form.lead_keywords.map(key => leads.get(key))),
    };
  }
  result.discovery_summary = { ...checked.summary,
    bound_candidates: checked.forms.length, unbound_candidates: result.candidates.length - checked.forms.length };
  return result;
}

/**
 * Attach non-keyword and multi-channel discovery provenance exported from SQLite
 * (raw_leads + lead_form_links) onto a revision-58+ batch without modifying scoring inputs.
 */
export function attachStoreDiscoveryProvenance(batch, store) {
  object(batch, 'batch');
  if (!store || typeof store.exportFormDiscoveryProvenance !== 'function') {
    throw new TypeError('A SelectionStore instance with exportFormDiscoveryProvenance() is required.');
  }
  const cloned = structuredClone(batch);
  if (!Array.isArray(cloned.candidates)) return cloned;
  for (const cand of cloned.candidates) {
    if (!cand || typeof cand !== 'object' || typeof cand.id !== 'string') continue;
    const formId = cand.discovery?.form_id || cand.id;
    const exported = store.exportFormDiscoveryProvenance(formId);
    if (!exported || !Array.isArray(exported.store_leads) || exported.store_leads.length === 0) continue;
    if (!cand.discovery || typeof cand.discovery !== 'object') {
      cand.discovery = {
        form_id: exported.form_id,
        label: exported.label,
        description: exported.description,
        offer_evidence: [],
        lead_keywords: [],
        leads: [],
      };
    }
    cand.discovery.store_leads = exported.store_leads;
    if (exported.promotion_track) cand.discovery.promotion_track = exported.promotion_track;
    if (exported.cooldown_until) cand.discovery.cooldown_until = exported.cooldown_until;
  }
  return cloned;
}
