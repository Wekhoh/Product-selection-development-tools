import { isPlainObject, assertPlainObject } from '../utils/objects.mjs';
/**
 * Shared acyclic `/v1/responses` & Batch response-envelope extractor.
 *
 * Inspects outer wrappers, nested `raw_response` / `response` / `body` envelopes,
 * and every `output[]` item and `content[]` part for errors, refusals (string or object),
 * non-2xx status codes, and incomplete states BEFORE parsing structured JSON once.
 */

function parseJsonObjectOnce(rawText, taskLabel) {
  const trimmed = rawText.trim();
  if (!trimmed) throw new TypeError(`${taskLabel} response text is empty.`);
  try {
    const parsed = JSON.parse(trimmed);
    assertPlainObject(parsed, `${taskLabel} output`);
    return parsed;
  } catch (err) {
    if (err instanceof TypeError && /plain object|forbidden key/.test(err.message)) throw err;
    throw new TypeError(`${taskLabel} response text is not valid JSON: ${err.message}`);
  }
}

function inspectEnvelopeMetadataAndOutput(envObj, taskLabel, { checkTopStatus = true } = {}) {
  if (envObj.error !== undefined && envObj.error !== null) {
    throw new Error(`${taskLabel} provider error: ${String(envObj.error?.message || JSON.stringify(envObj.error))}`);
  }
  if (envObj.type === 'error') {
    throw new Error(`${taskLabel} provider returned error envelope.`);
  }
  if ((typeof envObj.refusal === 'string' && envObj.refusal.length > 0) || (envObj.refusal && typeof envObj.refusal === 'object')) {
    throw new Error(`${taskLabel} refused by model: ${String(envObj.refusal?.message ?? envObj.refusal)}`);
  }
  if (Array.isArray(envObj.refusals) && envObj.refusals.length > 0) {
    throw new Error(`${taskLabel} refused by model: ${envObj.refusals.map(String).join('; ')}`);
  }
  if (typeof envObj.status_code === 'number' && (envObj.status_code < 200 || envObj.status_code >= 300)) {
    throw new Error(`${taskLabel} batch/HTTP wrapper returned non-2xx status_code=${envObj.status_code}.`);
  }
  if (checkTopStatus && typeof envObj.status === 'string' && envObj.status !== 'completed') {
    const reason = envObj.incomplete_details?.reason || envObj.status;
    throw new Error(`${taskLabel} response incomplete or not completed (status=${envObj.status}, reason=${reason}).`);
  }
  if (typeof envObj.response_status === 'string' && envObj.response_status !== 'completed') {
    const reason = envObj.incomplete_details?.reason || envObj.response_status;
    throw new Error(`${taskLabel} provider response did not complete cleanly (response_status=${envObj.response_status}, reason=${reason}).`);
  }
  if (envObj.incomplete_details !== null && envObj.incomplete_details !== undefined) {
    const reason = envObj.incomplete_details?.reason || 'incomplete';
    throw new Error(`${taskLabel} response was incomplete (reason=${reason}).`);
  }
  if (
    envObj.ok === false ||
    envObj.usable === false ||
    (typeof envObj.content_status === 'string' && envObj.content_status !== 'usable')
  ) {
    const detail = envObj.content_status || envObj.response_status || envObj.status || 'unusable';
    throw new Error(`${taskLabel} response is not usable (${detail}).`);
  }

  if (!Array.isArray(envObj.output)) {
    return null;
  }

  // Pass 1: scan EVERY output item and EVERY content part for any error, refusal, or incomplete/failed state FIRST!
  for (let i = 0; i < envObj.output.length; i++) {
    const item = envObj.output[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`${taskLabel} output[${i}] must be an object.`);
    }
    if (item.error !== undefined && item.error !== null) {
      throw new Error(`${taskLabel} output[${i}] error: ${String(item.error?.message || JSON.stringify(item.error))}`);
    }
    if (item.type === 'error') {
      throw new Error(`${taskLabel} output[${i}] reported type="error".`);
    }
    if (
      item.type === 'refusal' ||
      item.status === 'refused' ||
      (typeof item.refusal === 'string' && item.refusal.length > 0) ||
      (item.refusal && typeof item.refusal === 'object')
    ) {
      throw new Error(`${taskLabel} refused by model in output[${i}]: ${String(item.refusal?.message ?? item.refusal ?? 'refusal')}`);
    }
    if (item.status === 'failed' || item.status === 'cancelled') {
      throw new Error(`${taskLabel} output[${i}] failed or cancelled (status=${item.status}).`);
    }
    if (item.incomplete_details !== null && item.incomplete_details !== undefined) {
      const reason = item.incomplete_details?.reason || 'incomplete';
      throw new Error(`${taskLabel} output[${i}] was incomplete (reason=${reason}).`);
    }
    if (item.type === 'web_search_call' || item.type === 'web_search') {
      const isCapHaltedSearch = item.status === 'searching' && envObj.status === 'completed';
      if (typeof item.status === 'string' && item.status !== 'completed' && !isCapHaltedSearch) {
        throw new Error(`${taskLabel} output[${i}] web_search_call not completed (status=${item.status}).`);
      }
      continue;
    }
    if (typeof item.status === 'string' && item.status !== 'completed') {
      const reason = item.incomplete_details?.reason || item.status;
      throw new Error(`${taskLabel} output[${i}] incomplete or not completed (status=${item.status}, reason=${reason}).`);
    }
    if (Array.isArray(item.content)) {
      for (let j = 0; j < item.content.length; j++) {
        const part = item.content[j];
        if (!part || typeof part !== 'object') {
          throw new Error(`${taskLabel} output[${i}].content[${j}] must be an object.`);
        }
        if (part.error !== undefined && part.error !== null) {
          throw new Error(
            `${taskLabel} output[${i}].content[${j}] error: ${String(part.error?.message || JSON.stringify(part.error))}`,
          );
        }
        if (part.type === 'error') {
          throw new Error(`${taskLabel} output[${i}].content[${j}] reported type="error".`);
        }
        if (
          part.type === 'refusal' ||
          part.status === 'refused' ||
          (typeof part.refusal === 'string' && part.refusal.length > 0) ||
          (part.refusal && typeof part.refusal === 'object')
        ) {
          throw new Error(`${taskLabel} refused by model in output[${i}].content[${j}]: ${String(part.refusal?.message ?? part.refusal ?? 'refusal')}`);
        }
        if (typeof part.status === 'string' && part.status !== 'completed') {
          throw new Error(`${taskLabel} output[${i}].content[${j}] incomplete (status=${part.status}).`);
        }
        if (part.incomplete_details !== null && part.incomplete_details !== undefined) {
          throw new Error(`${taskLabel} output[${i}].content[${j}] was incomplete.`);
        }
      }
    }
  }

  // Pass 2: assemble all output_text parts into a single string so JSON.parse runs strictly once.
  const textParts = [];
  for (const item of envObj.output) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
  }
  return textParts.length > 0 ? textParts.join('') : null;
}

/**
 * Extract structured JSON object from a raw `/v1/responses` payload, client/batch wrapper, JSON string, or plain object.
 * ALWAYS inspects `raw.raw_response ?? raw.response ?? raw` AND every nested item/part in `output` FIRST for
 * `status === 'incomplete'`, `status === 'failed'`, `type === 'error'`, `part.error`, `item.error`, or `refusal`
 * BEFORE using `raw.parsed` or concatenating `output_text`.
 */
export function extractStructuredResponsePayload(rawResponse, taskLabel = 'WorkflowTask') {
  if (typeof rawResponse === 'string') {
    return parseJsonObjectOnce(rawResponse, taskLabel);
  }

  assertPlainObject(rawResponse, `${taskLabel} response`);

  const nestedEnvelopes = [];
  if (isPlainObject(rawResponse.raw_response)) {
    nestedEnvelopes.push(rawResponse.raw_response);
  }
  if (isPlainObject(rawResponse.response)) {
    nestedEnvelopes.push(rawResponse.response);
    if (isPlainObject(rawResponse.response.body)) {
      nestedEnvelopes.push(rawResponse.response.body);
    }
  }
  if (
    isPlainObject(rawResponse.body) &&
    (rawResponse.custom_id !== undefined || rawResponse.http_status !== undefined || rawResponse.status_code !== undefined)
  ) {
    nestedEnvelopes.push(rawResponse.body);
  }

  const WRAPPER_LIFECYCLE_STATUSES = new Set([
    'completed',
    'incomplete',
    'failed',
    'in_progress',
    'cancelled',
    'canceled',
    'queued',
    'refused',
    'pending_recovery',
    'rejected',
  ]);

  const isDomainContractObject =
    nestedEnvelopes.length === 0 &&
    rawResponse.parsed === undefined &&
    rawResponse.contract !== undefined &&
    rawResponse.object !== 'response' &&
    !Array.isArray(rawResponse.output) &&
    rawResponse.output_text === undefined &&
    rawResponse.response_status === undefined &&
    rawResponse.content_status === undefined &&
    rawResponse.usable === undefined &&
    rawResponse.ok === undefined &&
    rawResponse.status_code === undefined &&
    rawResponse.http_status === undefined &&
    rawResponse.incomplete_details === undefined &&
    rawResponse.refusal === undefined &&
    rawResponse.refusals === undefined &&
    rawResponse.error === undefined &&
    rawResponse.type !== 'error' &&
    !(typeof rawResponse.status === 'string' && WRAPPER_LIFECYCLE_STATUSES.has(rawResponse.status));

  if (isDomainContractObject) {
    return rawResponse;
  }

  const looksLikeEnvelope =
    nestedEnvelopes.length > 0 ||
    rawResponse.parsed !== undefined ||
    rawResponse.object === 'response' ||
    Array.isArray(rawResponse.output) ||
    typeof rawResponse.output_text === 'string' ||
    rawResponse.response_status !== undefined ||
    rawResponse.content_status !== undefined ||
    rawResponse.usable !== undefined ||
    rawResponse.ok !== undefined ||
    rawResponse.status_code !== undefined ||
    rawResponse.http_status !== undefined ||
    rawResponse.incomplete_details !== undefined ||
    rawResponse.refusal !== undefined ||
    rawResponse.refusals !== undefined ||
    rawResponse.error !== undefined ||
    rawResponse.type === 'error' ||
    (typeof rawResponse.status === 'string' && WRAPPER_LIFECYCLE_STATUSES.has(rawResponse.status));

  if (looksLikeEnvelope) {
    const outerAssembledText = inspectEnvelopeMetadataAndOutput(rawResponse, taskLabel, {
      checkTopStatus: true,
    });

    let innerAssembledText = null;
    let innerOutputText = null;
    for (const nested of nestedEnvelopes) {
      const candidateText = inspectEnvelopeMetadataAndOutput(nested, taskLabel, { checkTopStatus: true });
      if (candidateText !== null && innerAssembledText === null) {
        innerAssembledText = candidateText;
      }
      if (typeof nested.output_text === 'string' && innerOutputText === null) {
        innerOutputText = nested.output_text;
      }
    }

    if (innerAssembledText !== null) {
      return parseJsonObjectOnce(innerAssembledText, taskLabel);
    }
    if (outerAssembledText !== null) {
      return parseJsonObjectOnce(outerAssembledText, taskLabel);
    }
    if (innerOutputText !== null) {
      return parseJsonObjectOnce(innerOutputText, taskLabel);
    }
    if (typeof rawResponse.output_text === 'string') {
      return parseJsonObjectOnce(rawResponse.output_text, taskLabel);
    }
    if (isPlainObject(rawResponse.parsed)) {
      return rawResponse.parsed;
    }
    throw new TypeError(`${taskLabel} response envelope contained no structured output_text.`);
  }

  return rawResponse;
}

export const extractStructuredPayload = extractStructuredResponsePayload;
