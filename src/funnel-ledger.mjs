import { classifyBillingLane, extractDomainTokens } from './store.mjs';
import { inspectWebSearchUsage } from './openai/client.mjs';
import { microsToCeilingCents } from './openai/pricing.mjs';

function normalize(text) {
  return typeof text === 'string' ? text.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ') : '';
}

function identity(row) {
  const name = normalize(row.label || row.phrase_or_title || row.title || row.keyword || row.normalized_key);
  const task = normalize(row.buyer_task);
  const keywords = Array.isArray(row.keywords) ? row.keywords.map(normalize) : [normalize(row.keywords)];
  const { latin, cjk } = extractDomainTokens([name, task, ...keywords].join(' '));
  return { name, task, tokens: new Set([...latin, ...cjk]) };
}

export function checkFormDuplicates(db, payload) {
  const proposed = Array.isArray(payload) ? payload : [
    ...(payload?.leads ?? []), ...(payload?.forms ?? []), ...(payload?.candidates ?? []),
  ];
  if (!proposed.length) throw new TypeError('Supply a nonempty array of leads or candidates.');
  const records = [
    ...db.prepare("SELECT 'form' AS kind, form_id AS id, label, buyer_task FROM candidate_forms").all(),
    ...db.prepare(`SELECT 'lead' AS kind, lead_id AS id, phrase_or_title, normalized_key, event_dedup_key,
        json_extract(metadata_json, '$.buyer_task') AS buyer_task FROM raw_leads`).all(),
  ].map(row => ({ ...row, ...identity(row) }));
  return proposed.map((proposal, index) => {
    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new TypeError('Expected a lead or form object.');
    const { name, task, tokens } = identity(proposal);
    const id = proposal.form_id || proposal.lead_id || proposal.candidate_id || proposal.id || null;
    const eventKey = normalize(proposal.event_dedup_key);
    if (!id && !eventKey && !name && !task && !tokens.size) throw new TypeError('Each proposal requires identity or comparison text.');
    const matches = [];
    for (const row of records) {
      const sameId = Boolean(id && row.id === id);
      const sameEvent = Boolean(eventKey && eventKey === normalize(row.event_dedup_key));
      const sameTitle = Boolean(name && name === row.name);
      const sameTask = Boolean(task && task === row.task);
      const shared = [...tokens].filter(t => row.tokens.has(t)).sort();
      const overlap = shared.length / Math.max(1, Math.min(tokens.size, row.tokens.size));
      if (sameId || sameEvent || sameTitle || sameTask || (shared.length >= 2 && overlap >= 0.5)) {
        matches.push({ kind: row.kind, id: row.id, same_id: sameId, same_event: sameEvent,
          same_title: sameTitle, same_buyer_task: sameTask, shared_tokens: shared, overlap });
      }
    }
    matches.sort((a, b) => Number(b.same_id || b.same_event) - Number(a.same_id || a.same_event)
      || Number(b.same_title) - Number(a.same_title) || b.overlap - a.overlap || a.id.localeCompare(b.id));
    return { index, proposed_id: id, matches };
  });
}

function utcCutoff(value) {
  if (value == null) return null;
  const day = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i)?.[1];
  if (!day || !Number.isFinite(Date.parse(value)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new TypeError('--since requires a valid ISO timestamp including its time zone.');
  }
  return new Date(value).toISOString();
}

function readJson(value) {
  try {
    return JSON.parse(value ?? 'null');
  } catch {
    return null;
  }
}

function observedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tableColumns(db, table) {
  return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name));
}

function compatibleColumn(columns, name) {
  return columns.has(name) ? name : 'NULL';
}

// The time filter uses request completion time. Outstanding holds are an as-of snapshot.
function openAiTotals(db, since) {
  const columns = tableColumns(db, 'openai_request_ledger');
  if (!columns.size) return { available: false };
  const column = (name) => compatibleColumn(columns, name);
  const posted = column('posted_billed_cents');
  const legacyPosted = column('settled_cents');
  const raw = column('raw_receipt_json');
  const occurredAt = `coalesce(${column('finished_at')}, ${column('updated_at')}, ${column('created_at')})`;
  const rows = db.prepare(`WITH compatible AS (
      SELECT status, ${column('endpoint')} AS endpoint, ${column('reserved_cents')} AS reserved_cents,
        ${column('usage_cost_micros')} AS usage_cost_micros,
        ${column('provisional_usage_cost_micros')} AS provisional_usage_cost_micros,
        ${column('background_usage_floor_micros')} AS background_usage_floor_micros,
        coalesce(max(${posted}, ${legacyPosted}), ${posted}, ${legacyPosted}) AS posted_billed_cents,
        ${column('usage_json')} AS usage_json, ${column('confirmed_zero_charge')} AS confirmed_zero_charge,
        ${column('cleanup_required')} AS cleanup_required, ${column('cleanup_status')} AS cleanup_status,
        CASE WHEN json_valid(${raw}) THEN ${raw} END AS receipt,
        (? IS NULL OR julianday(${occurredAt}) >= julianday(?)) AS in_window
      FROM openai_request_ledger WHERE status IN ('in_progress','pending_recovery','completed','failed_known','rejected')
    )
    SELECT status, endpoint, reserved_cents, usage_cost_micros, provisional_usage_cost_micros, background_usage_floor_micros,
      posted_billed_cents, usage_json, confirmed_zero_charge, cleanup_required, cleanup_status, in_window,
      (json_type(receipt, '$.output') = 'array' OR json_type(receipt, '$.error.output') = 'array') AS has_output,
      (SELECT json_group_array(json_object('type', json_extract(item.value, '$.type'), 'id', json_extract(item.value, '$.id'),
          'action', json_object('type', json_extract(item.value, '$.action.type'))))
        FROM (SELECT type, value FROM json_each(receipt, '$.output')
          UNION ALL SELECT type, value FROM json_each(receipt, '$.error.output')) item
        WHERE item.type='object' AND json_extract(item.value, '$.type') IN ('web_search_call','web_search')) AS search_actions,
      json_extract(receipt, '$.usage.web_search_calls') AS reported_searches,
      json_extract(receipt, '$.error.usage.web_search_calls') AS reported_error_searches
      FROM compatible
      WHERE in_window OR status IN ('in_progress','pending_recovery','rejected') OR cleanup_required = 1
        OR cleanup_status IN ('pending_cleanup', 'delete_failed')`).iterate(since, since);
  const summary = { available: true, settled_attempts: 0, completed_attempts: 0,
    completed_usage_cost_micros: 0, completed_posted_billed_cents: 0,
    settled_usage_cost_micros: 0, settled_posted_billed_cents: 0,
    missing_cost_attempts: 0, completed_missing_cost_attempts: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
    missing_token_attempts: 0, missing_reasoning_token_attempts: 0, web_search_calls: 0, missing_search_attempts: 0,
    in_progress: { attempts: 0, reserved_cents: 0, effective_hold_cents: 0 },
    unconfirmed_rejections: { attempts: 0, reserved_cents: 0, effective_hold_cents: 0 },
    pending_recovery: { attempts: 0, reserved_cents: 0, effective_hold_cents: 0 } };
  let settledUnpostedUsageMicros = 0;
  let completedUnpostedUsageMicros = 0;
  for (const row of rows) {
    const micros = observedCounter(row.usage_cost_micros);
    const postedCents = observedCounter(row.posted_billed_cents);
    const awaitingCleanup = row.status !== 'rejected' && row.cleanup_status !== 'deleted_verified_404' &&
      (row.cleanup_required === 1 || ['pending_cleanup', 'delete_failed'].includes(row.cleanup_status));
    const unconfirmedRejection = row.status === 'rejected' && micros === null && !(postedCents > 0) && row.confirmed_zero_charge !== 1;
    if (row.status === 'in_progress' || row.status === 'pending_recovery' || awaitingCleanup || unconfirmedRejection) {
      const hold = row.status === 'in_progress' ? summary.in_progress :
        unconfirmedRejection ? summary.unconfirmed_rejections : summary.pending_recovery;
      const reserved = observedCounter(row.reserved_cents) ?? 0;
      const provisional = observedCounter(row.provisional_usage_cost_micros) ?? 0;
      hold.attempts++;
      hold.reserved_cents += reserved;
      hold.effective_hold_cents += Math.max(
        reserved, postedCents ?? 0, microsToCeilingCents(Math.max(micros ?? 0, provisional, row.background_usage_floor_micros ?? 0)),
      );
      continue;
    }
    if (!row.in_window) continue;
    const costKnown = postedCents !== null || micros !== null || row.confirmed_zero_charge === 1;
    if (row.status === 'rejected' && !costKnown) continue;
    summary.settled_attempts++;
    if (!costKnown) summary.missing_cost_attempts++;
    summary.settled_usage_cost_micros += micros ?? 0;
    summary.settled_posted_billed_cents += postedCents ?? 0;
    if (postedCents === null) settledUnpostedUsageMicros += micros ?? 0;
    if (row.status === 'completed') {
      summary.completed_attempts++;
      if (!costKnown) summary.completed_missing_cost_attempts++;
      summary.completed_usage_cost_micros += micros ?? 0;
      summary.completed_posted_billed_cents += postedCents ?? 0;
      if (postedCents === null) completedUnpostedUsageMicros += micros ?? 0;
    }
    const usage = readJson(row.usage_json);
    const inputTokens = observedCounter(usage?.input_tokens);
    const outputTokens = observedCounter(usage?.output_tokens);
    const reasoningTokens = observedCounter(usage?.output_tokens_details?.reasoning_tokens);
    summary.input_tokens += inputTokens ?? 0;
    summary.output_tokens += outputTokens ?? 0;
    summary.reasoning_tokens += reasoningTokens ?? 0;
    if (inputTokens === null || outputTokens === null) summary.missing_token_attempts++;
    if (reasoningTokens === null) summary.missing_reasoning_token_attempts++;
    const reported = [usage?.web_search_calls, row.reported_searches, row.reported_error_searches]
      .map(observedCounter).filter(value => value !== null);
    if (reported.length || row.has_output) {
      const search = inspectWebSearchUsage({
        output: readJson(row.search_actions),
        usage: reported.length ? { web_search_calls: Math.max(...reported) } : null,
      });
      summary.web_search_calls += search.calls;
      if (search.uncertain) summary.missing_search_attempts++;
    } else if (['/v1/responses', '/v1/batches'].includes(row.endpoint)) {
      summary.missing_search_attempts++;
    }
  }
  summary.completed_usage_cost_cents = summary.completed_usage_cost_micros / 10_000;
  summary.completed_known_cost_cents = summary.completed_posted_billed_cents + completedUnpostedUsageMicros / 10_000;
  summary.settled_known_cost_cents = summary.settled_posted_billed_cents + settledUnpostedUsageMicros / 10_000;
  summary.completed_cost_cents = summary.completed_missing_cost_attempts ? null : summary.completed_known_cost_cents;
  summary.settled_cost_cents = summary.missing_cost_attempts ? null : summary.settled_known_cost_cents;
  return summary;
}

function providerQuotaTotals(db, since) {
  const columns = { ss_mcp: 'ss_mcp_units', ss_web: 'ss_web_realtime_tasks', sif: 'sif_units', exa: 'exa_calls' };
  const quota = Object.fromEntries(Object.keys(columns).map(lane => [lane,
    { attempts: 0, known_units: 0, active_reserved_units: 0, unknown_reserved_units: 0, unknown_billing_attempts: 0 }]));
  const availableColumns = tableColumns(db, 'api_request_ledger');
  const column = (name) => compatibleColumn(availableColumns, name);
  const counters = Object.values(columns).flatMap(c => [c, 'unknown_reserved_' + c, 'estimated_' + c]);
  const projections = counters.map(name => `${column(name)} AS ${name}`);
  const occurredAt = `coalesce(${column('finished_at')}, ${column('updated_at')}, ${column('created_at')})`;
  const rows = availableColumns.size
    ? db.prepare(`SELECT provider, coalesce(${column('canonical_tool')}, ${column('tool_name')}) AS tool,
        status, ${column('billing_status')} AS billing_status, ${projections.join(', ')},
        (? IS NULL OR julianday(${occurredAt}) >= julianday(?)) AS in_window
        FROM api_request_ledger`).iterate(since, since)
    : [];
  for (const row of rows) {
    const lane = classifyBillingLane(row.provider, row.tool, row);
    if (row.in_window && lane) quota[lane].attempts++;
    for (const [name, column] of Object.entries(columns)) {
      if (row.in_window) quota[name].known_units += row[column] ?? 0;
      quota[name].unknown_reserved_units += row['unknown_reserved_' + column] ?? 0;
      if (['reserved','in_flight'].includes(row.status)) quota[name].active_reserved_units += row['estimated_' + column] ?? 0;
    }
    if (lane && (row.billing_status !== 'known' || ['unknown_needs_reconciliation','permanently_locked'].includes(row.status))) {
      quota[lane].unknown_billing_attempts++;
    }
  }
  for (const [lane, column] of Object.entries(columns)) {
    if (!availableColumns.has(column)) quota[lane].known_units = null;
    if (!availableColumns.has('unknown_reserved_' + column)) quota[lane].unknown_reserved_units = null;
    if (!availableColumns.has('estimated_' + column)) quota[lane].active_reserved_units = null;
  }
  return quota;
}

function candidateFunnel(db, since) {
  const funnel = {
    discovered: 0, gate1a_passed: 0, gate1b_passed: 0, gate1b_admitted: 0, evaluated: 0, crossing_overrides: 0,
    private_mold_reserved: 0, gate1a_rejected: 0, gate1b_rejected: 0, deferred: 0,
    gate1a_unverified: 0, gate1b_unverified: 0, evaluated_unverified: 0,
  };
  const evalColumns = tableColumns(db, 'evaluations');
  const evalSpecs = evalColumns.size
    ? db.prepare(`SELECT form_id, ${compatibleColumn(evalColumns, 'receipt_json')} AS receipt_json,
        ${compatibleColumn(evalColumns, 'evidence_review_json')} AS evidence_review_json FROM evaluations`).iterate()
    : [];
  const evaluatedSpecsByForm = new Map();
  for (const row of evalSpecs) {
    const receipt = readJson(row.receipt_json);
    const review = readJson(row.evidence_review_json);
    const spec = receipt?.form_spec_sha256 || review?.form_spec_sha256 || null;
    if (!evaluatedSpecsByForm.has(row.form_id)) evaluatedSpecsByForm.set(row.form_id, new Set());
    evaluatedSpecsByForm.get(row.form_id).add(spec);
  }
  const formCols = tableColumns(db, 'candidate_forms');
  const sourcingDispCol = compatibleColumn(formCols, 'sourcing_disposition');
  // The denominator is the discovery cohort; current evidence is bound to the form's current specification.
  const forms = db.prepare(`SELECT form_id, spec_version, spec_sha256, lifecycle_status, ${sourcingDispCol} AS sourcing_disposition, gate1a_result_json, gate1b_result_json
      FROM candidate_forms WHERE ? IS NULL OR julianday(created_at) >= julianday(?)`).iterate(since, since);
  let admittedAmongGate1a = 0;
  let evaluatedAmongAdmitted = 0;
  for (const form of forms) {
    funnel.discovered++;
    const a = readJson(form.gate1a_result_json);
    const b = readJson(form.gate1b_result_json);
    const isCurrentSpec = (spec) => spec ? spec === form.spec_sha256 : form.spec_version === 1;
    const isPrivateMold = form.lifecycle_status === 'private_mold_reserved' ||
      form.sourcing_disposition === 'private_mold_reserved' ||
      (b?.status === 'private_mold_reserved' && isCurrentSpec(b?.spec_sha256));
    if (isPrivateMold) funnel.private_mold_reserved++;
    else if (form.lifecycle_status === 'gate1a_rejected') funnel.gate1a_rejected++;
    else if (form.lifecycle_status === 'gate1b_rejected') funnel.gate1b_rejected++;
    else if (form.lifecycle_status === 'deferred') funnel.deferred++;
    const passedA = a?.proceed_to_gate1b === true;
    const passedB = b?.status === 'gate1b_passed';
    const crossing = b?.owner_crossing_override === true;
    const admittedB = (passedB || crossing) && isCurrentSpec(b?.spec_sha256);
    const currentPassedA = passedA && isCurrentSpec(a.spec_sha256);
    const evalSpecs = evaluatedSpecsByForm.get(form.form_id);
    const currentEval = evalSpecs?.has(form.spec_sha256) || (form.spec_version === 1 && evalSpecs?.has(null));
    if (currentPassedA) funnel.gate1a_passed++;
    else if (passedA && !a.spec_sha256) funnel.gate1a_unverified++;
    if (admittedB) {
      funnel.gate1b_admitted++;
      if (passedB) funnel.gate1b_passed++;
      if (crossing) funnel.crossing_overrides++;
      if (currentPassedA) admittedAmongGate1a++;
      if (currentEval) evaluatedAmongAdmitted++;
    } else if ((passedB || crossing) && !b.spec_sha256) {
      funnel.gate1b_unverified++;
    }
    if (currentEval) funnel.evaluated++;
    else if (evalSpecs?.has(null) || (!evalSpecs && form.lifecycle_status === 'evaluated')) funnel.evaluated_unverified++;
  }
  funnel.conversion_rates = {
    gate1a_passed_per_discovered: funnel.discovered ? funnel.gate1a_passed / funnel.discovered : null,
    gate1b_admitted_per_gate1a_passed: funnel.gate1a_passed ? admittedAmongGate1a / funnel.gate1a_passed : null,
    evaluated_per_gate1b_admitted: funnel.gate1b_admitted ? evaluatedAmongAdmitted / funnel.gate1b_admitted : null,
  };
  return funnel;
}

export function buildFunnelLedger(db, rawSince) {
  const since = utcCutoff(rawSince);
  return {
    since,
    spend_window: 'attempt_finished_at_or_updated_at',
    hold_window: 'all_outstanding',
    candidate_window: 'forms_created_since',
    candidates: candidateFunnel(db, since),
    quota: providerQuotaTotals(db, since),
    openai: openAiTotals(db, since),
  };
}
