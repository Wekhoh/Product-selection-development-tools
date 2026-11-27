/**
 * Zero-dependency Node.js >= 24 OpenAI HTTP transport & lifecycle client.
 *
 * Enforces:
 *  - Explicit credential loading ONLY (`credentialFile` or `apiKeyEnvVar` when `allowEnvKey: true`)
 *  - Canonical credential-to-ledger/scope binding (`sha256Hex(apiKey)`) & cross-process registry
 *  - Explicit `testMode` vs production mode (completely independent of `fetchImpl` function identity)
 *  - Strict `maxRetries = 0`, `redirect: 'error'`, and locked `baseOrigin` + credential on all HTTP calls
 *  - Atomic pre-dispatch SQLite reservation & `pending_recovery` cross-month fencing
 *  - `POST /v1/decisions` (`gpt-6-luna` only, zero `reasoning` keys, `1..400` questions, cumulative `<= 256 KiB` `input_json`, strict ID & answer-type validation)
 *  - `POST /v1/responses` (Terra xhigh by default, web search only, optional background polling and optional remote DELETE)
 *  - Origin- and credential-bound `recoverPendingResponse` via `GET /v1/responses/{id}`
 *  - 50%-discount Batch `.jsonl` builder/parser & durable upload-bound submission (`/v1/responses`)
 */
import { readFileSync } from 'node:fs';
import {
  assertNoRawPii,
  containsRawEmail,
  containsSecretToken,
  detectRawPii,
  redactRawEmails,
  sanitizeDiagnosticText,
} from '../contracts.mjs';
import { canonicalJson, sha256Hex } from '../store.mjs';
import {
  assertPlainObject as assertPlainObjectBase,
  generatePiiSafeUuid,
  isPlainObject,
} from '../utils/objects.mjs';
import {
  assertSupportedStrictJsonSchema,
  validateJsonAgainstStrictSchema,
} from '../utils/json-schema.mjs';
import {
  DEFAULT_TERRA_MAX_OUTPUT_TOKENS,
  DEFAULT_UNCAPPED_WEB_SEARCH_RESERVATION_CALLS,
  OpenAiError,
  OpenAiPolicyError,
  OpenAiValidationError,
  WEB_SEARCH_CALL_MICROS,
  computeUsageCostMicros,
  estimateCostBreakdown,
  estimateReservationCents,
  isAstraModel,
  microsToCeilingCents,
  resolveModelPricing,
  resolveUncappedWebSearchReservationCalls,
  safeMicrosToNumber,
} from './pricing.mjs';
import {
  OpenAiBudgetError,
  OpenAiBudgetLedger,
  areSamePhysicalSqliteFile,
} from './budget-ledger.mjs';
import {
  createBackgroundProgress,
  delayBackgroundPoll,
  getBackgroundResponseWithinWait,
  getWebSearchActions,
  hasPersistedBackgroundTerminal,
  preflightBackgroundProgressFile,
  readReportedWebSearchCalls,
  validateBackgroundOptions,
} from './background.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com';
export const DEFAULT_SYNC_TIMEOUT_MS = 480_000;
const DEFAULT_TIMEOUT_MS = DEFAULT_SYNC_TIMEOUT_MS;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MiB bounded HTTP response stream ceiling
const DEFAULT_MAX_BATCH_JSONL_BYTES = 64 * 1024 * 1024; // 64 MiB bounded Batch output .jsonl ceiling
const MAX_DECISION_QUESTIONS = 400;
const MAX_DECISION_CHOICES_PER_QUESTION = 32;
const MAX_DECISION_INPUT_JSON_BYTES = 256 * 1024; // 256 KiB cumulative across input_json blocks
const DECISION_OUTPUT_TOKENS_PER_QUESTION = 256;
const MIN_XHIGH_OUTPUT_TOKENS = 4_096;
const IMAGE_LOW_DETAIL_TOKEN_BOUND = 2_048;
const IMAGE_HIGH_DETAIL_TOKEN_BOUND = 8_192;
const IMAGE_ORIGINAL_DETAIL_TOKEN_BOUND = 16_384;
const WEB_SEARCH_CONTEXT_TOKEN_BOUND = 16_384;
const MAX_BATCH_LINES = 50_000;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;
const INLINE_DATA_IMAGE_URI_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i;
const VALID_IMAGE_DETAILS = new Set(['low', 'high', 'auto', 'original']);
const VALID_DECISION_QUESTION_TYPES = new Set(['predicate', 'choice', 'score']);
const ALLOWED_BATCH_ENDPOINTS = new Set(['/v1/responses']);
const ALLOWED_INTERACTIVE_SERVICE_TIERS = new Set(['auto', 'default', 'standard', 'flex', 'fast', 'priority']);
const KNOWN_RESPONSE_STATUSES = new Set([
  'completed',
  'incomplete',
  'failed',
  'cancelled',
  'in_progress',
  'queued',
]);
const TERMINAL_RESPONSE_STATUSES = new Set([
  'completed',
  'incomplete',
  'failed',
  'cancelled',
]);
const MAX_CONSECUTIVE_BACKGROUND_GET_ERRORS = 5;
const KNOWN_DECISION_ENVELOPE_STATUSES = new Set([
  'completed',
  'incomplete',
  'failed',
  'cancelled',
  'in_progress',
  'queued',
]);
const ALLOWED_WEB_SEARCH_TOOL_KEYS = new Set([
  'type',
  'max_tool_calls',
  'user_location',
  'search_context_size',
  'filters',
]);

const LOCAL_ONLY_REQUEST_KEYS = new Set([
  'logical_request_id',
  'logicalRequestId',
  'packet_sha256',
  'packetSha256',
  '_offline_draft_only',
  'offline_draft_only',
  '_locked_logical_request_id',
]);

const SENSITIVE_KEY_NAME_RE =
  /^(?:api[_-]?key|apikey|authorization|secret[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password)$/i;


export class OpenAiHttpError extends OpenAiError {
  constructor(message, {
    httpStatus,
    code = 'OPENAI_HTTP_ERROR',
    attemptId = null,
    logicalRequestId = null,
    errorType = null,
    errorCode = null,
  } = {}) {
    super(sanitizeDiagnosticText(message), {
      code,
      notDispatched: false,
      details: {
        status: 'rejected',
        http_status: httpStatus,
        attempt_id: attemptId,
        logical_request_id: logicalRequestId,
        provider_error_type: errorType,
        provider_error_code: errorCode,
      },
    });
  }
}

export class OpenAiAmbiguousOutcomeError extends OpenAiError {
  constructor(message, {
    code = 'PENDING_RECOVERY',
    attemptId = null,
    logicalRequestId = null,
    providerResponseId = null,
    httpStatus = null,
    reservedCents = null,
  } = {}) {
    super(sanitizeDiagnosticText(message), {
      code,
      notDispatched: false,
      details: {
        status: 'pending_recovery',
        fenced: true,
        attempt_id: attemptId,
        logical_request_id: logicalRequestId,
        provider_response_id: providerResponseId,
        http_status: httpStatus,
        reserved_cents: reservedCents,
      },
    });
  }
}

function defineSafeProp(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return obj;
}

function cloneSafeMapRecord(sourceObj) {
  const out = Object.create(null);
  if (!sourceObj || typeof sourceObj !== 'object') return out;
  for (const key of Object.keys(sourceObj)) {
    if (Object.hasOwn(sourceObj, key)) {
      defineSafeProp(out, key, sourceObj[key]);
    }
  }
  return out;
}

const requirePlainObject = (value, label) =>
  assertPlainObjectBase(value, label, OpenAiValidationError);

function assertOptionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new OpenAiValidationError(`${label} must be a boolean when provided.`);
  }
  return value;
}

function snapshotPlainValue(value, label = 'input', seen = new Set(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OpenAiValidationError(`${label} cannot contain NaN or Infinity.`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new OpenAiValidationError(`${label} contains unsupported ${typeof value} value.`);
  }
  if (depth > 48) {
    throw new OpenAiValidationError(`${label} exceeds maximum nesting depth.`);
  }
  if (seen.has(value)) {
    throw new OpenAiValidationError(`${label} contains a circular reference.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, idx) => snapshotPlainValue(item, `${label}[${idx}]`, seen, depth + 1));
    }
    requirePlainObject(value, label);
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(value, key)) continue;
      const v = value[key];
      if (v !== undefined) {
        defineSafeProp(out, key, snapshotPlainValue(v, `${label}.${key}`, seen, depth + 1));
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function utf8ByteLength(str) {
  return Buffer.byteLength(String(str), 'utf8');
}

function assertSafeResourceId(id, label = 'resourceId') {
  if (typeof id !== 'string' || !SAFE_RESOURCE_ID_RE.test(id.trim())) {
    throw new OpenAiValidationError(
      `${label} must be a safe alphanumeric resource identifier (no path separators or query strings).`,
    );
  }
  return id.trim();
}

function extractSafeProviderId(rawId, literalSecret = null) {
  if (typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (!trimmed || !SAFE_RESOURCE_ID_RE.test(trimmed)) return null;
  if (literalSecret && typeof literalSecret === 'string' && literalSecret.length >= 4 && trimmed.includes(literalSecret)) {
    return null;
  }
  if (containsSecretToken(trimmed) || scrubTextForReceipt(trimmed, literalSecret) !== trimmed) {
    return null;
  }
  return trimmed;
}

function normalizeBaseUrl(baseUrl, { allowInsecureLocalBaseUrl = false } = {}) {
  assertOptionalBoolean(allowInsecureLocalBaseUrl, 'allowInsecureLocalBaseUrl');
  const raw = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OpenAiValidationError('baseUrl must be a valid absolute URL.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OpenAiValidationError('baseUrl must not include URL credentials, query parameters, or fragments.');
  }
  if (parsed.protocol !== 'https:') {
    const isLoopback = parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]');
    if (allowInsecureLocalBaseUrl !== true || !isLoopback) {
      throw new OpenAiPolicyError('OpenAI baseUrl must use https: protocol.', {
        code: 'INSECURE_BASE_URL',
      });
    }
  }
  return raw.replace(/\/+$/, '');
}

function formatAuthHeader(apiKey) {
  return ['Bearer', apiKey].join(' ');
}

function isAmbiguousHttpStatus(status) {
  return (status >= 300 && status < 400) || status === 408 || status === 409 || status >= 500;
}

function isTransientBackgroundGetError(err) {
  if (err instanceof OpenAiHttpError) {
    const status = err.http_status;
    return status < 300 || status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return !(err instanceof OpenAiError);
}

function isActiveResponseStatus(status) {
  return status === 'queued' || status === 'in_progress';
}

function isSettledResponseAttempt(attempt) {
  return Boolean(attempt) && !['in_progress', 'pending_recovery'].includes(attempt.status) &&
    (!attempt.cleanup_required || attempt.status === 'rejected' ||
      ['deleted_verified_404', 'delete_failed', 'not_requested'].includes(attempt.cleanup_status));
}

async function withBackgroundProgressResult(emitProgress, operation) {
  try {
    const result = await operation();
    return emitProgress.progressError ? { ...result, progress_error: emitProgress.progressError } : result;
  } catch (err) {
    if (emitProgress.progressError) err.progress_error = emitProgress.progressError;
    throw err;
  }
}

function stripLocalKeys(params) {
  const wire = Object.create(null);
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(params, key)) continue;
    const v = params[key];
    if (LOCAL_ONLY_REQUEST_KEYS.has(key) || v === undefined) continue;
    defineSafeProp(wire, key, v);
  }
  return wire;
}

function validateInteractiveServiceTier(rawTier, endpointLabel) {
  if (rawTier === undefined || rawTier === null) {
    return {
      wireTier: undefined,
      reservationTier: undefined,
      ledgerTier: 'auto',
      requestedStandardCap: false,
    };
  }
  if (typeof rawTier !== 'string' || !rawTier.trim()) {
    throw new OpenAiValidationError(`${endpointLabel} service_tier must be a nonempty string when provided.`);
  }
  const lowered = rawTier.trim().toLowerCase();
  if (lowered === 'batch') {
    throw new OpenAiValidationError(
      `${endpointLabel} forbids service_tier="batch" on synchronous HTTP requests; use submitBatch for 50%-discount Batch execution.`,
      { code: 'BATCH_TIER_FORBIDDEN_ON_INTERACTIVE' },
    );
  }
  if (!ALLOWED_INTERACTIVE_SERVICE_TIERS.has(lowered)) {
    throw new OpenAiValidationError(`Unsupported ${endpointLabel} service_tier "${rawTier}".`);
  }
  if (lowered === 'standard' || lowered === 'default') {
    // P0-15: Transmit 'default' on wire so OpenAI caps execution to 1x standard tier!
    return {
      wireTier: 'default',
      reservationTier: 'standard',
      ledgerTier: 'standard',
      requestedStandardCap: true,
    };
  }
  return {
    wireTier: lowered,
    reservationTier: lowered === 'priority' ? 'fast' : lowered,
    ledgerTier: lowered === 'priority' ? 'fast' : lowered,
    requestedStandardCap: false,
  };
}

/**
 * Compute deterministic SHA-256 digest of exact outgoing UTF-8 wire payload (`P1-02`).
 * When `wireBodyOrJson` is the exact serialized UTF-8 JSON string transmitted in `fetchImpl`,
 * hashes those exact wire bytes directly so key-order differences produce distinct digests.
 */
export function computeRequestPayloadSha256(endpoint, wireBodyOrJson) {
  if (typeof wireBodyOrJson === 'string') {
    return sha256Hex(Buffer.from(`${endpoint}\n${wireBodyOrJson}`, 'utf8'));
  }
  if (Buffer.isBuffer(wireBodyOrJson)) {
    return sha256Hex(Buffer.concat([Buffer.from(`${endpoint}\n`, 'utf8'), wireBodyOrJson]));
  }
  const serialized = JSON.stringify(wireBodyOrJson);
  return sha256Hex(Buffer.from(`${endpoint}\n${serialized}`, 'utf8'));
}

function assertCleanOutgoingPayload(wireBody, label = 'openai_request') {
  assertNoRawPii(wireBody, label);
  if (containsRawEmail(wireBody)) {
    throw new OpenAiPolicyError(
      `${label} contains a raw email address; redact PII before sending to OpenAI.`,
      { code: 'OUTGOING_PII_BLOCKED', notDispatched: true },
    );
  }
  if (containsSecretToken(wireBody)) {
    throw new OpenAiPolicyError(
      `${label} contains a secret token or credential; strip secrets before sending to OpenAI.`,
      { code: 'OUTGOING_SECRET_BLOCKED' },
    );
  }
}

function scrubTextForReceipt(text, literalSecret = null) {
  let s = String(text ?? '');
  if (literalSecret && typeof literalSecret === 'string' && literalSecret.length >= 4) {
    s = s.replaceAll(literalSecret, '[REDACTED_TOKEN]');
  }
  s = sanitizeDiagnosticText(s);
  s = s.replace(/\bBearer\s+\S+/gi, '[REDACTED_BEARER]');
  s = redactRawEmails(s);
  return s;
}

/**
 * P0-22 & P2-04: Sanitize arbitrary JSON values into `Object.create(null)` maps via `defineSafeProp`
 * WITHOUT dropping legitimate `"__proto__"`, `"constructor"`, `"toString"`, or `"valueOf"` data keys!
 */
function sanitizeReceiptValue(value, depth = 0, literalSecret = null) {
  if (value === null || value === undefined) return value;
  if (depth > 64) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') {
    return scrubTextForReceipt(value, literalSecret);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeReceiptValue(item, depth + 1, literalSecret));
  }
  if (typeof value === 'object') {
    const out = Object.create(null);
    for (const rawKey of Object.keys(value)) {
      if (!Object.hasOwn(value, rawKey)) continue;
      const v = value[rawKey];
      if (v === undefined) continue;
      const safeKey = scrubTextForReceipt(rawKey, literalSecret);
      if (SENSITIVE_KEY_NAME_RE.test(rawKey) || SENSITIVE_KEY_NAME_RE.test(safeKey)) {
        defineSafeProp(out, safeKey, null);
      } else {
        defineSafeProp(out, safeKey, sanitizeReceiptValue(v, depth + 1, literalSecret));
      }
    }
    return out;
  }
  return scrubTextForReceipt(String(value), literalSecret);
}

/**
 * P2-09: Bounded streaming HTTP byte reader.
 * On live transport (`requireStreamingOrContentLength === true`), rejects non-streaming responses
 * lacking a valid integer `Content-Length <= maxBytes`, and checks `byteLength` BEFORE `Buffer.from`.
 */
async function readBoundedBytesResponse(res, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, {
  requireStreamingOrContentLength = false,
} = {}) {
  const contentLenHeader = res?.headers && typeof res.headers.get === 'function'
    ? res.headers.get('content-length')
    : null;
  let hasVerifiedContentLength = false;
  if (contentLenHeader !== null && contentLenHeader !== undefined && /^\d+$/.test(String(contentLenHeader).trim())) {
    const declaredBytes = Number(String(contentLenHeader).trim());
    if (Number.isSafeInteger(declaredBytes) && declaredBytes >= 0) {
      if (declaredBytes > maxBytes) {
        try { await res.body?.cancel?.(); } catch { /* ignore */ }
        throw new OpenAiError(`HTTP response Content-Length (${declaredBytes} bytes) exceeds ${maxBytes}-byte ceiling.`, {
          code: 'RESPONSE_BODY_TOO_LARGE',
        });
      }
      hasVerifiedContentLength = true;
    }
  }

  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        total += buf.length;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new OpenAiError(`HTTP response stream exceeded ${maxBytes}-byte safety ceiling.`, {
            code: 'RESPONSE_BODY_TOO_LARGE',
          });
        }
        chunks.push(buf);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    return Buffer.concat(chunks, total);
  }

  if (res?.body && typeof res.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        try { res.body.destroy?.(); } catch { /* ignore */ }
        throw new OpenAiError(`HTTP response stream exceeded ${maxBytes}-byte safety ceiling.`, {
          code: 'RESPONSE_BODY_TOO_LARGE',
        });
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, total);
  }

  if (requireStreamingOrContentLength && !hasVerifiedContentLength) {
    throw new OpenAiError(
      `HTTP response lacked a readable stream and valid Content-Length <= ${maxBytes}; refusing unbounded full-body buffering.`,
      { code: 'UNBOUNDED_NON_STREAMING_RESPONSE' },
    );
  }

  if (typeof res?.arrayBuffer === 'function') {
    const ab = await res.arrayBuffer();
    const rawLen = ab && typeof ab.byteLength === 'number' ? ab.byteLength : 0;
    if (rawLen > maxBytes) {
      throw new OpenAiError(`HTTP response body (${rawLen} bytes) exceeds ${maxBytes}-byte safety ceiling.`, {
        code: 'RESPONSE_BODY_TOO_LARGE',
      });
    }
    const buf = Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
    if (buf.length > maxBytes) {
      throw new OpenAiError(`HTTP response body (${buf.length} bytes) exceeds ${maxBytes}-byte safety ceiling.`, {
        code: 'RESPONSE_BODY_TOO_LARGE',
      });
    }
    return buf;
  }

  if (typeof res?.text === 'function') {
    const txt = String((await res.text()) ?? '');
    if (txt.length > maxBytes) {
      throw new OpenAiError(`HTTP response text (${txt.length} chars) exceeds ${maxBytes}-byte safety ceiling.`, {
        code: 'RESPONSE_BODY_TOO_LARGE',
      });
    }
    const buf = Buffer.from(txt, 'utf8');
    if (buf.length > maxBytes) {
      throw new OpenAiError(`HTTP response text (${buf.length} bytes) exceeds ${maxBytes}-byte safety ceiling.`, {
        code: 'RESPONSE_BODY_TOO_LARGE',
      });
    }
    return buf;
  }

  return Buffer.alloc(0);
}

async function readBoundedUtf8Response(res, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, options = {}) {
  const buf = await readBoundedBytesResponse(res, maxBytes, options);
  return buf.toString('utf8');
}

/**
 * Load an OpenAI API key STRICTLY from an explicit `credentialFile` OR an explicit
 * `apiKeyEnvVar` when `allowEnvKey === true`. Never reads ambient env variables implicitly,
 * and never echoes file paths or key bytes in errors.
 */
export function loadOpenAiApiKey({
  credentialFile = null,
  apiKeyEnvVar = null,
  allowEnvKey = false,
  env = process.env,
} = {}) {
  assertOptionalBoolean(allowEnvKey, 'allowEnvKey');
  if (credentialFile !== null && credentialFile !== undefined && String(credentialFile).trim() !== '') {
    let rawText;
    try {
      rawText = readFileSync(String(credentialFile).trim(), 'utf8');
    } catch (err) {
      const ioCode = typeof err?.code === 'string' ? err.code : 'READ_ERROR';
      throw new OpenAiPolicyError(
        `Unable to read explicit OpenAI credentialFile (${ioCode}).`,
        { code: 'CREDENTIAL_FILE_UNREADABLE' },
      );
    }
    const trimmed = rawText.trim();
    let candidate = trimmed;
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new OpenAiPolicyError('Explicit OpenAI credentialFile contains malformed JSON.', {
          code: 'CREDENTIAL_FILE_INVALID',
        });
      }
      candidate = String(
        parsed.api_key ?? parsed.apiKey ?? parsed.OPENAI_API_KEY ?? '',
      ).trim();
    }
    if (!candidate || /[\r\n\0\s]/.test(candidate)) {
      throw new OpenAiPolicyError(
        'Explicit OpenAI credentialFile did not yield a valid single-token API key.',
        { code: 'CREDENTIAL_FILE_INVALID' },
      );
    }
    return candidate;
  }

  if (allowEnvKey === true) {
    if (typeof apiKeyEnvVar !== 'string' || !/^[A-Z_][A-Z0-9_]{1,63}$/.test(apiKeyEnvVar.trim())) {
      throw new OpenAiPolicyError(
        'allowEnvKey: true requires an explicit uppercase apiKeyEnvVar name.',
        { code: 'MISSING_API_KEY_ENV_VAR_NAME' },
      );
    }
    const envName = apiKeyEnvVar.trim();
    const rawVal = env && typeof env === 'object' ? env[envName] : undefined;
    const trimmed = typeof rawVal === 'string' ? rawVal.trim() : '';
    if (!trimmed || /[\r\n\0\s]/.test(trimmed)) {
      throw new OpenAiPolicyError(
        `Configured OpenAI credential env var "${envName}" is unset or invalid.`,
        { code: 'CREDENTIAL_ENV_MISSING' },
      );
    }
    return trimmed;
  }

  throw new OpenAiPolicyError(
    'No explicit OpenAI credential source configured; supply credentialFile or { allowEnvKey: true, apiKeyEnvVar }.',
    { code: 'CREDENTIAL_SOURCE_REQUIRED' },
  );
}

function buildTimeoutSignal(timeoutMs, externalSignal = null) {
  const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) {
    throw new OpenAiValidationError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  if (externalSignal !== null && externalSignal !== undefined) {
    if (typeof externalSignal !== 'object' || typeof externalSignal.aborted !== 'boolean') {
      throw new OpenAiValidationError('signal must be an AbortSignal when provided.');
    }
    if (externalSignal.aborted) {
      throw new OpenAiValidationError('Request signal was already aborted before dispatch.', {
        code: 'SIGNAL_ALREADY_ABORTED',
      });
    }
    return AbortSignal.any([externalSignal, AbortSignal.timeout(ms)]);
  }
  return AbortSignal.timeout(ms);
}

function hasForbiddenReasoningKey(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = hasForbiddenReasoningKey(item, seen);
      if (found) return found;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const kl = k.toLowerCase();
    if (kl === 'reasoning' || kl === 'reasoning_effort' || kl === 'reasoningeffort') {
      return k;
    }
    if (k !== 'json' && k !== 'data' && k !== 'value' && k !== 'input_json') {
      const nested = hasForbiddenReasoningKey(v, seen);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * P0-15: Validate inline `data:image/*;base64` URI, decode real raster `(width, height)`,
 * enforce `1 <= width, height <= 8192`, and compute conservative tile/patch-aware vision token bound!
 */
function validateInlineInputImage(part, pathLabel) {
  if (part.file_id !== undefined || part.fileId !== undefined) {
    throw new OpenAiValidationError(
      `${pathLabel} cannot reference unbounded server-side file_id; supply an inline data:image/*;base64 URI.`,
      { code: 'UNBOUNDED_CONTEXT_REF_FORBIDDEN' },
    );
  }
  const imageUrlVal = typeof part.image_url === 'string'
    ? part.image_url
    : (part.image_url && typeof part.image_url === 'object' ? part.image_url.url : null);
  if (typeof imageUrlVal !== 'string' || !imageUrlVal.trim()) {
    throw new OpenAiValidationError(`${pathLabel} requires an inline data:image/*;base64 image_url.`);
  }
  const trimmedUrl = imageUrlVal.trim();
  const match = INLINE_DATA_IMAGE_URI_RE.exec(trimmedUrl);
  if (!match) {
    throw new OpenAiValidationError(
      `${pathLabel}.image_url must be an inline base64 data:image/(png|jpeg|webp|gif) URI (remote HTTP URLs have unbounded token cost).`,
      { code: 'REMOTE_IMAGE_URL_FORBIDDEN' },
    );
  }
  const cleanedB64 = match[2].replace(/\s+/g, '');
  if (!cleanedB64 || cleanedB64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleanedB64)) {
    throw new OpenAiValidationError(
      `${pathLabel}.image_url contains malformed base64 data.`,
      { code: 'INVALID_INLINE_IMAGE_RASTER' },
    );
  }

  const detail = part.detail ?? (typeof part.image_url === 'object' ? part.image_url?.detail : undefined) ?? 'auto';
  if (typeof detail !== 'string' || !VALID_IMAGE_DETAILS.has(detail)) {
    throw new OpenAiValidationError(
      `${pathLabel}.detail must be one of low, high, auto, original (got "${String(detail)}").`,
    );
  }

  if (detail === 'low') return IMAGE_LOW_DETAIL_TOKEN_BOUND;
  if (detail === 'original') return IMAGE_ORIGINAL_DETAIL_TOKEN_BOUND;
  return IMAGE_HIGH_DETAIL_TOKEN_BOUND;
}

/**
 * P0-15: Strip base64 image bytes ONLY on validated `{ type: 'input_image', image_url }` wire nodes
 * inside `wire.input`. Count ALL plain text strings (even if starting with `'data:image/'`) verbatim!
 */
function replaceValidatedInputImageNodes(inputNode) {
  if (typeof inputNode === 'string' || inputNode === null || inputNode === undefined) {
    return inputNode;
  }
  if (Array.isArray(inputNode)) {
    return inputNode.map(item => replaceValidatedInputImageNodes(item));
  }
  if (typeof inputNode === 'object') {
    if (inputNode.type === 'input_image') {
      const cloned = cloneSafeMapRecord(inputNode);
      if (typeof cloned.image_url === 'string') {
        defineSafeProp(cloned, 'image_url', '[INLINE_IMAGE_DATA_URI]');
      } else if (cloned.image_url && typeof cloned.image_url === 'object') {
        const innerUrl = cloneSafeMapRecord(cloned.image_url);
        defineSafeProp(innerUrl, 'url', '[INLINE_IMAGE_DATA_URI]');
        defineSafeProp(cloned, 'image_url', innerUrl);
      }
      return cloned;
    }
    if (Array.isArray(inputNode.content)) {
      const cloned = cloneSafeMapRecord(inputNode);
      defineSafeProp(cloned, 'content', inputNode.content.map(child => replaceValidatedInputImageNodes(child)));
      return cloned;
    }
  }
  return inputNode;
}

function computeWireJsonUtf8BytesWithoutImageBase64(wire) {
  const shallowWire = cloneSafeMapRecord(wire);
  defineSafeProp(shallowWire, 'input', replaceValidatedInputImageNodes(wire.input));
  return utf8ByteLength(JSON.stringify(shallowWire));
}

/**
 * Validate AND normalize `/v1/decisions` `input` (`P2-input-cap`):
 *  - Requires AT MOST ONE payload key (`json`, `data`, or `value`) and no extra keys on `input_json` blocks!
 *  - Normalizes every `input_json` block to `{ type: 'input_json', json }` BEFORE measuring `<= 256 KiB` and sending!
 */
function validateAndNormalizeDecisionInput(input) {
  if (typeof input === 'string') {
    if (!input.trim()) {
      throw new OpenAiValidationError('Decision input string must be nonempty.');
    }
    return { normalizedInput: input, imageTokens: 0, totalInputJsonBytes: 0 };
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new OpenAiValidationError('Decision input must be a nonempty string or nonempty array of content items.');
  }

  let imageTokens = 0;
  let totalInputJsonBytes = 0;

  const normalizePart = (part, pathLabel) => {
    requirePlainObject(part, pathLabel);
    if (part.file_id !== undefined || part.fileId !== undefined) {
      throw new OpenAiValidationError(`${pathLabel} cannot reference file_id.`, {
        code: 'UNBOUNDED_CONTEXT_REF_FORBIDDEN',
      });
    }
    if (Array.isArray(part.content)) {
      if (part.content.length === 0) {
        throw new OpenAiValidationError(`${pathLabel}.content must be nonempty.`);
      }
      const normParent = cloneSafeMapRecord(part);
      defineSafeProp(
        normParent,
        'content',
        part.content.map((inner, idx) => normalizePart(inner, `${pathLabel}.content[${idx}]`)),
      );
      return normParent;
    }

    const type = part.type;
    if (type === 'input_text' || type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0) {
        throw new OpenAiValidationError(`${pathLabel}.text must be a nonempty string.`);
      }
      return part;
    }

    if (type === 'input_image') {
      imageTokens += validateInlineInputImage(part, pathLabel);
      return part;
    }

    if (type === 'input_json') {
      const payloadKeysPresent = ['json', 'data', 'value'].filter(k => Object.hasOwn(part, k) && part[k] !== undefined);
      if (payloadKeysPresent.length === 0) {
        throw new OpenAiValidationError(`${pathLabel} (input_json) requires a json, data, or value property.`);
      }
      if (payloadKeysPresent.length > 1) {
        throw new OpenAiValidationError(
          `${pathLabel} (input_json) must supply exactly one payload key (json, data, or value); multiple aliases (${payloadKeysPresent.join(', ')}) are forbidden.`,
          { code: 'MULTIPLE_INPUT_JSON_ALIASES_FORBIDDEN' },
        );
      }
      const extraKeys = Object.keys(part).filter(k => k !== 'type' && k !== payloadKeysPresent[0] && part[k] !== undefined);
      if (extraKeys.length > 0) {
        throw new OpenAiValidationError(
          `${pathLabel} (input_json) contains unexpected sibling properties (${extraKeys.join(', ')}); put payload fields inside json.`,
          { code: 'MULTIPLE_INPUT_JSON_ALIASES_FORBIDDEN' },
        );
      }
      const jsonVal = part[payloadKeysPresent[0]];
      const serialized = JSON.stringify(jsonVal);
      if (serialized === undefined) {
        throw new OpenAiValidationError(`${pathLabel} (input_json) must be JSON-serializable.`);
      }
      const bytes = utf8ByteLength(serialized);
      totalInputJsonBytes += bytes;
      if (totalInputJsonBytes > MAX_DECISION_INPUT_JSON_BYTES) {
        throw new OpenAiValidationError(
          `Cumulative /v1/decisions input_json UTF-8 size (${totalInputJsonBytes} bytes) exceeds 256 KiB (${MAX_DECISION_INPUT_JSON_BYTES} bytes) limit.`,
          { code: 'INPUT_JSON_TOO_LARGE' },
        );
      }
      const normJsonPart = Object.create(null);
      defineSafeProp(normJsonPart, 'type', 'input_json');
      defineSafeProp(normJsonPart, 'data', jsonVal);
      return normJsonPart;
    }

    throw new OpenAiValidationError(
      `${pathLabel}.type "${String(type)}" is not supported by /v1/decisions (expected input_text, input_image, or input_json).`,
      { code: 'UNSUPPORTED_DECISION_INPUT_TYPE' },
    );
  };

  const normalizedInput = input.map((item, i) => normalizePart(item, `input[${i}]`));
  return { normalizedInput, imageTokens, totalInputJsonBytes };
}

function validateDecisionQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_DECISION_QUESTIONS) {
    throw new OpenAiValidationError(
      `/v1/decisions requires between 1 and ${MAX_DECISION_QUESTIONS} questions (got ${Array.isArray(questions) ? questions.length : 'non-array'}).`,
      { code: 'INVALID_DECISION_QUESTION_COUNT' },
    );
  }
  const aliasToEntry = Object.create(null);
  const questionEntries = [];
  const normalizedQuestions = [];

  for (let i = 0; i < questions.length; i++) {
    const q = requirePlainObject(questions[i], `questions[${i}]`);
    if (!VALID_DECISION_QUESTION_TYPES.has(q.type)) {
      throw new OpenAiValidationError(
        `questions[${i}].type must be predicate, choice, or score (got "${String(q.type)}").`,
        { code: 'INVALID_DECISION_QUESTION_TYPE' },
      );
    }

    const rawAliases = [q.id, q.question_id, q.name].filter(v => v !== undefined && v !== null);
    if (rawAliases.length === 0) {
      throw new OpenAiValidationError(
        `questions[${i}] requires an explicit nonempty id, question_id, or name so answers never rely on positional matching.`,
        { code: 'DECISION_QUESTION_ID_REQUIRED' },
      );
    }
    const cleanAliases = [];
    for (const rawAlias of rawAliases) {
      if (typeof rawAlias !== 'string' || !rawAlias.trim()) {
        throw new OpenAiValidationError(`questions[${i}] id/question_id/name must be a nonempty string.`);
      }
      const trimmed = rawAlias.trim();
      if (!cleanAliases.includes(trimmed)) {
        cleanAliases.push(trimmed);
      }
    }

    const promptText = q.instructions ?? q.question ?? q.prompt ?? q.text ?? q.rubric ?? '';
    if (typeof promptText !== 'string' || !promptText.trim()) {
      throw new OpenAiValidationError(`questions[${i}] requires a nonempty question/prompt string.`);
    }

    let allowedChoices = null;
    let wireChoices = null;
    if (q.type === 'choice') {
      const choices = q.choices ?? q.options ?? q.values;
      if (!Array.isArray(choices) || choices.length < 2) {
        throw new OpenAiValidationError(`questions[${i}] (type="choice") requires at least 2 options/choices.`);
      }
      if (choices.length > MAX_DECISION_CHOICES_PER_QUESTION) {
        throw new OpenAiValidationError(
          `questions[${i}] (type="choice") exceeds maximum ${MAX_DECISION_CHOICES_PER_QUESTION} choices (got ${choices.length}).`,
          { code: 'DECISION_CHOICES_LIMIT_EXCEEDED' },
        );
      }
      allowedChoices = new Set();
      wireChoices = [];
      for (let j = 0; j < choices.length; j++) {
        const opt = choices[j];
        const key = typeof opt === 'string'
          ? opt.trim()
          : (opt && typeof opt === 'object' ? String(opt.value ?? opt.id ?? '').trim() : '');
        if (!key) {
          throw new OpenAiValidationError(`questions[${i}].options[${j}] must be a nonempty string or option object.`);
        }
        if (allowedChoices.has(key)) {
          throw new OpenAiValidationError(`questions[${i}] has duplicate choice option "${key}".`);
        }
        allowedChoices.add(key);
        const choiceObj = Object.create(null);
        defineSafeProp(choiceObj, 'value', key);
        if (opt && typeof opt === 'object' && typeof opt.description === 'string' && opt.description.trim()) {
          defineSafeProp(choiceObj, 'description', opt.description.trim());
        }
        wireChoices.push(choiceObj);
      }
    }

    let scoreMin = null;
    let scoreMax = null;
    if (q.type === 'score') {
      if (q.min !== undefined) {
        if (typeof q.min !== 'number' || !Number.isFinite(q.min)) {
          throw new OpenAiValidationError(`questions[${i}].min must be a finite number.`);
        }
        scoreMin = q.min;
      }
      if (q.max !== undefined) {
        if (typeof q.max !== 'number' || !Number.isFinite(q.max)) {
          throw new OpenAiValidationError(`questions[${i}].max must be a finite number.`);
        }
        scoreMax = q.max;
      }
      if (scoreMin !== null && scoreMax !== null && scoreMin >= scoreMax) {
        throw new OpenAiValidationError(`questions[${i}] (type="score") requires finite min < max.`);
      }
    }

    const canonicalId = (typeof q.id === 'string' && q.id.trim())
      ? q.id.trim()
      : ((typeof q.question_id === 'string' && q.question_id.trim()) ? q.question_id.trim() : cleanAliases[0]);
    const canonicalName = (typeof q.name === 'string' && q.name.trim()) ? q.name.trim() : canonicalId;
    const entry = {
      index: i,
      canonicalId,
      canonicalName,
      aliases: cleanAliases,
      questionType: q.type,
      allowedChoices,
      scoreMin,
      scoreMax,
    };

    for (const alias of cleanAliases) {
      if (Object.hasOwn(aliasToEntry, alias)) {
        throw new OpenAiValidationError(`Duplicate question id/name "${alias}" in /v1/decisions request.`);
      }
      defineSafeProp(aliasToEntry, alias, entry);
    }
    questionEntries.push(entry);

    const wireQuestion = Object.create(null);
    defineSafeProp(wireQuestion, 'type', q.type);
    defineSafeProp(wireQuestion, 'name', canonicalName);
    defineSafeProp(wireQuestion, 'instructions', promptText.trim());
    if (q.type === 'choice') {
      defineSafeProp(wireQuestion, 'choices', wireChoices);
    } else if (q.type === 'score') {
      if (Array.isArray(q.levels)) {
        defineSafeProp(wireQuestion, 'levels', q.levels);
      }
      if (scoreMin !== null) defineSafeProp(wireQuestion, 'min', scoreMin);
      if (scoreMax !== null) defineSafeProp(wireQuestion, 'max', scoreMax);
    }
    normalizedQuestions.push(wireQuestion);
  }

  return { aliasToEntry, questionEntries, normalizedQuestions };
}

function validateDecisionAnswerAgainstQuestion(item, matchedEntry) {
  if (item.type !== matchedEntry.questionType) {
    return `Decision answer "${matchedEntry.canonicalId}" returned type="${String(item.type)}", expected "${matchedEntry.questionType}".`;
  }

  if (item.probability !== undefined && item.probability !== null) {
    if (typeof item.probability !== 'number' || !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1) {
      return `Decision answer "${matchedEntry.canonicalId}" has invalid probability (${String(item.probability)}); expected [0, 1].`;
    }
  }

  if (matchedEntry.questionType === 'predicate') {
    if (item.choice_probabilities !== undefined || item.probabilities !== undefined) {
      return `Predicate answer "${matchedEntry.canonicalId}" must not include choice_probabilities.`;
    }
    if (item.value !== undefined && item.value !== null && typeof item.value !== 'boolean') {
      return `Predicate answer "${matchedEntry.canonicalId}" value must be boolean (got ${typeof item.value}).`;
    }
    const hasBool = typeof item.value === 'boolean';
    const hasProb = typeof item.probability === 'number';
    if (!hasBool && !hasProb) {
      return `Predicate answer "${matchedEntry.canonicalId}" requires boolean value or [0, 1] probability.`;
    }
    return null;
  }

  if (matchedEntry.questionType === 'choice') {
    const checkProbCollection = (probCollection, fieldName) => {
      if (Array.isArray(probCollection)) {
        const seenChoices = new Set();
        let sum = 0;
        for (let idx = 0; idx < probCollection.length; idx++) {
          const entry = probCollection[idx];
          if (!isPlainObject(entry)) {
            return `Choice answer "${matchedEntry.canonicalId}" ${fieldName}[${idx}] must be an object.`;
          }
          const choiceVal = typeof entry.value === 'string'
            ? entry.value.trim()
            : (typeof entry.choice === 'string' ? entry.choice.trim() : '');
          if (!choiceVal || !matchedEntry.allowedChoices.has(choiceVal)) {
            return `Choice answer "${matchedEntry.canonicalId}" ${fieldName}[${idx}] contains unrequested choice "${sanitizeDiagnosticText(choiceVal)}".`;
          }
          if (seenChoices.has(choiceVal)) {
            return `Choice answer "${matchedEntry.canonicalId}" ${fieldName} contains duplicate choice "${sanitizeDiagnosticText(choiceVal)}".`;
          }
          seenChoices.add(choiceVal);
          const pv = entry.probability;
          if (typeof pv !== 'number' || !Number.isFinite(pv) || pv < 0 || pv > 1) {
            return `Choice answer "${matchedEntry.canonicalId}" ${fieldName}["${sanitizeDiagnosticText(choiceVal)}"] is out of [0, 1].`;
          }
          sum += pv;
        }
        if (sum > 1.05) {
          return `Choice answer "${matchedEntry.canonicalId}" ${fieldName} probabilities sum to ${sum} (> 1.05).`;
        }
        return { count: seenChoices.size, error: null };
      }
      if (!isPlainObject(probCollection)) {
        return { count: 0, error: `Choice answer "${matchedEntry.canonicalId}" ${fieldName} must be an array or object.` };
      }
      const keys = Object.keys(probCollection);
      let sum = 0;
      for (const k of keys) {
        if (!matchedEntry.allowedChoices.has(k)) {
          return { count: 0, error: `Choice answer "${matchedEntry.canonicalId}" ${fieldName} contains unrequested choice "${sanitizeDiagnosticText(k)}".` };
        }
        const pv = probCollection[k];
        if (typeof pv !== 'number' || !Number.isFinite(pv) || pv < 0 || pv > 1) {
          return { count: 0, error: `Choice answer "${matchedEntry.canonicalId}" ${fieldName}["${sanitizeDiagnosticText(k)}"] is out of [0, 1].` };
        }
        sum += pv;
      }
      if (sum > 1.05) {
        return { count: 0, error: `Choice answer "${matchedEntry.canonicalId}" ${fieldName} probabilities sum to ${sum} (> 1.05).` };
      }
      return { count: keys.length, error: null };
    };

    let hasAnyChoiceProb = false;
    if (item.choice_probabilities !== undefined && item.choice_probabilities !== null) {
      const resCheck = checkProbCollection(item.choice_probabilities, 'choice_probabilities');
      if (typeof resCheck === 'string') return resCheck;
      if (resCheck.error) return resCheck.error;
      hasAnyChoiceProb = resCheck.count > 0;
    }
    if (item.probabilities !== undefined && item.probabilities !== null) {
      const resCheck = checkProbCollection(item.probabilities, 'probabilities');
      if (typeof resCheck === 'string') return resCheck;
      if (resCheck.error) return resCheck.error;
      hasAnyChoiceProb = hasAnyChoiceProb || resCheck.count > 0;
    }

    const selected = item.value ?? item.choice ?? null;
    if (selected !== null) {
      if (typeof selected !== 'string' || !matchedEntry.allowedChoices.has(selected.trim())) {
        return `Choice answer "${matchedEntry.canonicalId}" selected invalid option "${sanitizeDiagnosticText(String(selected))}".`;
      }
    } else if (!hasAnyChoiceProb) {
      return `Choice answer "${matchedEntry.canonicalId}" omitted both value and choice_probabilities.`;
    }
    return null;
  }

  if (matchedEntry.questionType === 'score') {
    const numVal = item.value ?? item.score;
    if (typeof numVal !== 'number' || !Number.isFinite(numVal)) {
      return `Score answer "${matchedEntry.canonicalId}" requires a finite numeric value.`;
    }
    if (matchedEntry.scoreMin !== null && numVal < matchedEntry.scoreMin) {
      return `Score answer "${matchedEntry.canonicalId}" (${numVal}) is below min (${matchedEntry.scoreMin}).`;
    }
    if (matchedEntry.scoreMax !== null && numVal > matchedEntry.scoreMax) {
      return `Score answer "${matchedEntry.canonicalId}" (${numVal}) exceeds max (${matchedEntry.scoreMax}).`;
    }
    return null;
  }

  return null;
}

/**
 * Validate that a JSON Schema uses only supported recursive keywords (`P1-01`).
 * Rejects `$ref` or unknown keywords explicitly rather than silently marking unvalidated output `usable: true`.
 */
export function validateSupportedJsonSchemaDialect(schema, pathLabel = 'schema') {
  assertSupportedStrictJsonSchema(schema, pathLabel, {
    ErrorClass: OpenAiValidationError,
    strictCodexDialect: false,
    maxDepth: 48,
  });
}

export function validateValueAgainstJsonSchema(value, schema, pathLabel = '$') {
  try {
    validateJsonAgainstStrictSchema(value, schema, pathLabel, {
      ErrorClass: OpenAiValidationError,
      strictCodexDialect: false,
      maxDepth: 48,
    });
    return null;
  } catch (err) {
    if (err instanceof OpenAiValidationError && err.code === 'UNSUPPORTED_JSON_SCHEMA_KEYWORD') {
      throw err;
    }
    if (err instanceof OpenAiValidationError && /maximum JSON Schema/.test(err.message)) {
      throw err;
    }
    return sanitizeDiagnosticText(err?.message ?? String(err));
  }
}

function validateAndBoundResponsesInputTree(input) {
  if (typeof input === 'string') {
    if (!input.trim()) {
      throw new OpenAiValidationError('Responses input string must be nonempty.');
    }
    return { imageTokens: 0 };
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new OpenAiValidationError('Responses request requires a nonempty input string or content array.');
  }

  let imageTokens = 0;
  const walk = (node, pathLabel) => {
    if (typeof node === 'string') return;
    requirePlainObject(node, pathLabel);

    for (const forbiddenRef of ['file_id', 'fileId', 'file_url', 'fileUrl', 'previous_response_id', 'conversation']) {
      if (node[forbiddenRef] !== undefined && node[forbiddenRef] !== null) {
        throw new OpenAiValidationError(
          `${pathLabel}.${forbiddenRef} is forbidden because remote/server-side context cannot be bounded conservatively.`,
          { code: 'UNBOUNDED_CONTEXT_REF_FORBIDDEN' },
        );
      }
    }

    if (node.type === 'input_file' || node.type === 'file' || node.type === 'item_reference') {
      throw new OpenAiValidationError(
        `${pathLabel}.type="${node.type}" is forbidden because server-side files/references have unbounded token length.`,
        { code: 'UNBOUNDED_CONTEXT_REF_FORBIDDEN' },
      );
    }

    if (node.type === 'input_image') {
      imageTokens += validateInlineInputImage(node, pathLabel);
      return;
    }

    if (Array.isArray(node.content)) {
      if (node.content.length === 0) {
        throw new OpenAiValidationError(`${pathLabel}.content must be nonempty.`);
      }
      node.content.forEach((child, idx) => walk(child, `${pathLabel}.content[${idx}]`));
    }
  };

  input.forEach((item, idx) => walk(item, `input[${idx}]`));
  return { imageTokens };
}

export function estimateResponsesInputTokens(wire, maxWebSearchCalls = 0) {
  const { imageTokens } = validateAndBoundResponsesInputTree(wire.input);
  const wireTextBytes = computeWireJsonUtf8BytesWithoutImageBase64(wire);
  const totalBig =
    BigInt(Math.max(1, wireTextBytes)) +
    BigInt(imageTokens) +
    (BigInt(maxWebSearchCalls) * BigInt(WEB_SEARCH_CONTEXT_TOKEN_BOUND));
  return safeMicrosToNumber(totalBig);
}

const VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function validateAndNormalizeResponsesBody(rawParams, {
  allowAstraApi = false,
  deleteAfterPersist = false,
  uncappedWebSearchReservationCalls = DEFAULT_UNCAPPED_WEB_SEARCH_RESERVATION_CALLS,
  background = undefined,
  batch = false,
} = {}) {
  if (
    rawParams &&
    typeof rawParams === 'object' &&
    (rawParams._offline_draft_only === true || rawParams.offline_draft_only === true)
  ) {
    throw new OpenAiPolicyError(
      'Offline draft request (_offline_draft_only) was constructed without an authorized execution policy and cannot be dispatched or serialized into Batch.',
      { code: 'OFFLINE_DRAFT_NOT_DISPATCHABLE', notDispatched: true },
    );
  }
  const lockedLogicalRequestId =
    rawParams && typeof rawParams === 'object' && typeof rawParams._locked_logical_request_id === 'string' && rawParams._locked_logical_request_id.trim()
      ? rawParams._locked_logical_request_id.trim()
      : null;

  const params = snapshotPlainValue(rawParams, 'Responses params');
  requirePlainObject(params, 'Responses params');
  if (params._offline_draft_only === true || params.offline_draft_only === true) {
    throw new OpenAiPolicyError(
      'Offline draft request (_offline_draft_only) cannot be dispatched or serialized into Batch.',
      { code: 'OFFLINE_DRAFT_NOT_DISPATCHABLE', notDispatched: true },
    );
  }
  if (Object.hasOwn(params, 'reasoning_effort') || Object.hasOwn(params, 'reasoningEffort')) {
    throw new OpenAiValidationError(
      'Use structured reasoning: { effort: "..." } on /v1/responses rather than top-level reasoning_effort.',
      { code: 'LEGACY_REASONING_EFFORT_PARAM' },
    );
  }
  if (params.stream !== undefined && params.stream !== false) {
    throw new OpenAiValidationError(
      '/v1/responses streaming (stream: true) is unsupported; only complete JSON responses are permitted.',
      { code: 'STREAMING_UNSUPPORTED' },
    );
  }
  if (params.store !== undefined && typeof params.store !== 'boolean') {
    throw new OpenAiValidationError('Responses store parameter must be a boolean when provided.');
  }
  assertOptionalBoolean(params.background, 'Responses background');
  if (batch && params.background === true) {
    throw new OpenAiValidationError('Batch requests already run asynchronously and may not use Responses background mode.');
  }
  if (background === true || params.background === true) {
    params.background = true;
    params.store = true;
  } else if (batch) {
    delete params.background;
  }
  const storeMode = params.store === false ? 0 : 1;
  if (storeMode === 0 && deleteAfterPersist === true) {
    throw new OpenAiValidationError(
      'Cannot combine store: false with deleteAfterPersist: true on /v1/responses.',
      { code: 'INCOMPATIBLE_STORE_CLEANUP_MODE' },
    );
  }

  for (const unboundedKey of [
    'previous_response_id',
    'previousResponseId',
    'conversation',
    'conversation_id',
    'conversationId',
    'prompt',
  ]) {
    if (params[unboundedKey] !== undefined && params[unboundedKey] !== null) {
      throw new OpenAiValidationError(
        `Responses parameter "${unboundedKey}" is forbidden because server-side context cannot be bounded before reservation.`,
        { code: 'UNBOUNDED_CONTEXT_REF_FORBIDDEN' },
      );
    }
  }

  const wire = stripLocalKeys(params);

  // P0-15: Omitted service_tier stays omitted on wire (and reserves at 2x 'fast' on Terra/Sol);
  // explicit 'standard'/'default' transmits wire.service_tier = 'default' and caps to 1x!
  const tierInfo = validateInteractiveServiceTier(wire.service_tier, '/v1/responses');
  if (tierInfo.wireTier === undefined) {
    delete wire.service_tier;
  } else {
    defineSafeProp(wire, 'service_tier', tierInfo.wireTier);
  }

  defineSafeProp(wire, 'model', wire.model ?? 'gpt-6.1-terra');
  const modelSpec = resolveModelPricing(wire.model, { allowAstraApi, endpoint: '/v1/responses' });
  if (modelSpec.family !== 'text') {
    throw new OpenAiValidationError(`/v1/responses requires a text/multimodal reasoning model (got "${wire.model}").`);
  }

  defineSafeProp(wire, 'reasoning', wire.reasoning !== undefined ? wire.reasoning : { effort: 'xhigh' });
  defineSafeProp(wire, 'max_output_tokens', wire.max_output_tokens ?? DEFAULT_TERRA_MAX_OUTPUT_TOKENS);

  if (!Number.isSafeInteger(wire.max_output_tokens) || wire.max_output_tokens < 1) {
    throw new OpenAiValidationError('Responses max_output_tokens must be a positive safe integer.');
  }

  let effort = null;
  if (wire.reasoning !== null) {
    requirePlainObject(wire.reasoning, 'reasoning');
    if (wire.reasoning.effort !== undefined) {
      if (typeof wire.reasoning.effort !== 'string' || !VALID_REASONING_EFFORTS.has(wire.reasoning.effort)) {
        throw new OpenAiValidationError(
          `Unsupported reasoning.effort "${String(wire.reasoning.effort)}".`,
          { code: 'INVALID_REASONING_EFFORT' },
        );
      }
      effort = wire.reasoning.effort;
    }
  }

  if ((effort === 'xhigh' || effort === 'max') && wire.max_output_tokens < MIN_XHIGH_OUTPUT_TOKENS) {
    throw new OpenAiValidationError(
      `Responses with reasoning.effort="${effort}" requires max_output_tokens >= ${MIN_XHIGH_OUTPUT_TOKENS} (got ${wire.max_output_tokens}).`,
      { code: 'XHIGH_MIN_OUTPUT_TOKENS' },
    );
  }

  if (wire.input === undefined || wire.input === null) {
    throw new OpenAiValidationError('Responses request requires a nonempty input string or content array.');
  }

  // The API cap is optional. An uncapped request reserves estimated search costs locally.
  let maxWebSearchCalls = 0;
  if (wire.tools !== undefined && wire.tools !== null) {
    if (!Array.isArray(wire.tools)) {
      throw new OpenAiValidationError('Responses tools must be an array when provided.');
    }
    if (wire.tools.length > 1) {
      throw new OpenAiValidationError(
        'Responses tools may contain at most one { type: "web_search" } entry; other hosted tools are forbidden.',
        { code: 'UNSUPPORTED_RESPONSES_TOOL' },
      );
    }
    if (wire.tools.length === 1) {
      const rawTool = requirePlainObject(wire.tools[0], 'tools[0]');
      if (rawTool.type !== 'web_search') {
        throw new OpenAiValidationError(
          `Responses tool "${String(rawTool.type)}" is forbidden; only { type: "web_search" } is permitted.`,
          { code: 'UNSUPPORTED_RESPONSES_TOOL' },
        );
      }
      for (const k of Object.keys(rawTool)) {
        if (!ALLOWED_WEB_SEARCH_TOOL_KEYS.has(k)) {
          throw new OpenAiValidationError(`Unsupported property "${k}" on web_search tool.`, {
            code: 'UNSUPPORTED_RESPONSES_TOOL',
          });
        }
      }
      if (
        rawTool.search_context_size !== undefined &&
        !['low', 'medium', 'high'].includes(rawTool.search_context_size)
      ) {
        throw new OpenAiValidationError('web_search.search_context_size must be low, medium, or high.');
      }

      const topLevelCap = wire.max_tool_calls;
      const toolLevelCap = rawTool.max_tool_calls;
      if (topLevelCap !== undefined && toolLevelCap !== undefined && topLevelCap !== toolLevelCap) {
        throw new OpenAiValidationError('Conflicting max_tool_calls between top-level request and tools[0].');
      }
      const effectiveCap = topLevelCap ?? toolLevelCap;
      if (effectiveCap != null && (!Number.isSafeInteger(effectiveCap) || effectiveCap < 1)) {
        throw new OpenAiValidationError(
          'Responses max_tool_calls must be a positive safe integer, null, or omitted.',
          { code: 'INVALID_WEB_SEARCH_MAX_TOOL_CALLS' },
        );
      }

      const cleanTool = cloneSafeMapRecord(rawTool);
      delete cleanTool.max_tool_calls;
      defineSafeProp(wire, 'tools', [cleanTool]);
      if (effectiveCap == null) delete wire.max_tool_calls;
      else defineSafeProp(wire, 'max_tool_calls', effectiveCap);
      maxWebSearchCalls = effectiveCap ?? uncappedWebSearchReservationCalls;
    } else if (wire.max_tool_calls != null) {
      throw new OpenAiValidationError('max_tool_calls requires tools: [{ type: "web_search" }].');
    }
  } else if (wire.max_tool_calls != null) {
    throw new OpenAiValidationError('max_tool_calls requires tools: [{ type: "web_search" }].');
  }
  if (wire.max_tool_calls === null) delete wire.max_tool_calls;

  const formatObj = isPlainObject(wire.text?.format) ? wire.text.format : null;
  const formatType = formatObj?.type;
  const expectsJsonObject = formatType === 'json_schema' || formatType === 'json_object';
  let jsonSchema = null;
  if (formatType === 'json_schema') {
    if (!isPlainObject(formatObj?.schema) && typeof formatObj?.schema !== 'boolean') {
      throw new OpenAiValidationError('text.format.type="json_schema" requires a valid text.format.schema.');
    }
    validateSupportedJsonSchemaDialect(formatObj.schema, 'text.format.schema');
    jsonSchema = formatObj.schema;
  }

  assertCleanOutgoingPayload(wire, 'responses_request');
  const inferredInputTokens = estimateResponsesInputTokens(wire, maxWebSearchCalls);

  return {
    wire,
    canonicalModel: modelSpec.canonicalModel,
    inferredInputTokens,
    maxWebSearchCalls,
    storeMode,
    expectsJsonObject,
    jsonSchema,
    responseFormat: formatObj,
    tierInfo,
    lockedLogicalRequestId,
  };
}

export function extractWebSearchCallsFromOutput(sanitizedRaw) {
  return inspectWebSearchUsage(sanitizedRaw).calls;
}

export function inspectWebSearchUsage(response) {
  const reported = readReportedWebSearchCalls(response);
  if (reported !== null) return { calls: reported, uncertain: false };
  let calls = 0;
  let uncertain = false;
  for (const { type, legacy } of getWebSearchActions(response)) {
    // Historical receipts omit action.type and were billed as search calls.
    if (type === 'search' || legacy) calls++;
    else if (type === 'unknown') uncertain = true;
  }
  return { calls, uncertain };
}

function extractResponsesContent(sanitizedRaw, { expectsJsonObject = false, jsonSchema = null } = {}) {
  const outputArr = Array.isArray(sanitizedRaw?.output) ? sanitizedRaw.output : [];
  const textChunks = [];
  const refusals = [];
  const { calls: webSearchCalls, uncertain: webSearchUsageUncertain } = inspectWebSearchUsage(sanitizedRaw);
  let hasInnerError = sanitizedRaw?.error !== null && sanitizedRaw?.error !== undefined;
  let hasInnerIncomplete = false;

  for (const item of outputArr) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'error' || (item.error !== null && item.error !== undefined)) {
      hasInnerError = true;
      continue;
    }
    if (item.status === 'failed' || item.status === 'cancelled') {
      hasInnerError = true;
    }
    if (item.type === 'web_search_call' || item.type === 'web_search') {
      const isCompletedSearch = item.status === undefined || item.status === null || item.status === 'completed';
      const isCapHaltedSearch =
        item.status === 'searching' &&
        sanitizedRaw?.status === 'completed' &&
        (item.incomplete_details === null || item.incomplete_details === undefined);
      if (!isCompletedSearch && !isCapHaltedSearch && item.status !== 'failed' && item.status !== 'cancelled') {
        hasInnerIncomplete = true;
      }
      if (item.incomplete_details !== null && item.incomplete_details !== undefined) {
        hasInnerIncomplete = true;
      }
      continue;
    }
    if (
      (item.status !== undefined && item.status !== null && item.status !== 'completed') ||
      (item.incomplete_details !== null && item.incomplete_details !== undefined)
    ) {
      // P1-01: Treat in_progress / queued / incomplete / unknown message/reasoning item statuses as non-usable!
      hasInnerIncomplete = true;
    }
    if (item.type === 'refusal') {
      refusals.push(typeof item.refusal === 'string' && item.refusal ? item.refusal : 'Model refused output.');
      continue;
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part || typeof part !== 'object') continue;
        if (
          part.type === 'error' ||
          (part.error !== null && part.error !== undefined) ||
          part.status === 'failed' ||
          part.status === 'cancelled'
        ) {
          hasInnerError = true;
          continue;
        }
        if (part.status !== undefined && part.status !== null && part.status !== 'completed') {
          hasInnerIncomplete = true;
        }
        if (part.type === 'refusal' || typeof part.refusal === 'string') {
          refusals.push(typeof part.refusal === 'string' && part.refusal ? part.refusal : 'Model refused output.');
        } else if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
          textChunks.push(part.text);
        }
      }
    }
  }

  const outputText = textChunks.length > 0
    ? textChunks.join('')
    : (typeof sanitizedRaw?.output_text === 'string' ? sanitizedRaw.output_text : '');

  if (typeof sanitizedRaw?.refusal === 'string' && sanitizedRaw.refusal.trim()) {
    refusals.push(sanitizedRaw.refusal.trim());
  }

  const refusal = refusals.length > 0 ? refusals.join('\n') : null;
  const incompleteDetails = sanitizedRaw?.incomplete_details ?? null;
  const responseStatus = typeof sanitizedRaw?.status === 'string' ? sanitizedRaw.status : 'unknown';

  const echoedFormatType = sanitizedRaw?.text?.format?.type;
  const effectiveExpectsJsonObject = Boolean(
    expectsJsonObject || jsonSchema !== null || echoedFormatType === 'json_schema' || echoedFormatType === 'json_object',
  );
  const effectiveSchema = jsonSchema ?? (echoedFormatType === 'json_schema' ? sanitizedRaw?.text?.format?.schema ?? null : null);

  let contentStatus;
  let invalidDetailReason = null;
  if (refusal !== null) {
    contentStatus = 'refused';
  } else if (responseStatus === 'failed' || responseStatus === 'cancelled' || hasInnerError) {
    contentStatus = 'invalid';
    if (hasInnerError) invalidDetailReason = 'Response output contained an inner error item or part.';
  } else if (responseStatus === 'incomplete' || incompleteDetails !== null) {
    contentStatus = 'incomplete';
  } else if (hasInnerIncomplete) {
    contentStatus = 'invalid';
    invalidDetailReason = 'Completed response envelope contained a non-completed output item or part.';
  } else if (responseStatus === 'completed') {
    if (!outputText || outputText.trim().length === 0) {
      contentStatus = 'invalid';
      invalidDetailReason = 'Completed response contained empty output content.';
    } else if (effectiveExpectsJsonObject) {
      try {
        const parsed = JSON.parse(outputText);
        const sanitizedParsed = sanitizeReceiptValue(parsed, 0, null);
        if (!isPlainObject(sanitizedParsed)) {
          contentStatus = 'invalid';
          invalidDetailReason = 'Structured json_schema/json_object response output was not a JSON object.';
        } else if (effectiveSchema !== null && effectiveSchema !== undefined) {
          const schemaErr = validateValueAgainstJsonSchema(sanitizedParsed, effectiveSchema);
          if (schemaErr) {
            contentStatus = 'invalid';
            invalidDetailReason = `Structured json_schema validation failed: ${schemaErr}`;
          } else {
            contentStatus = 'usable';
          }
        } else {
          contentStatus = 'usable';
        }
      } catch {
        contentStatus = 'invalid';
        invalidDetailReason = 'Structured json_schema response output was malformed JSON.';
      }
    } else {
      contentStatus = 'usable';
    }
  } else {
    contentStatus = 'invalid';
  }

  return {
    responseStatus,
    contentStatus,
    invalidDetailReason,
    outputText,
    refusal,
    refusals,
    incompleteDetails,
    webSearchCalls,
    webSearchUsageUncertain,
  };
}

// -----------------------------------------------------------------------------
// Offline / Online 50%-Discount Batch JSONL Builders & Parsers
// -----------------------------------------------------------------------------

/**
 * Parse a Batch input `.jsonl` string (e.g. produced by `openai-batch-build` or `buildBatchJsonl`)
 * into validated structured `requests[]` accepted by `buildBatchJsonl` / `uploadBatchFile` / `submitBatch`.
 */
export function parseBatchInputJsonl(jsonlText, {
  defaultEndpoint = '/v1/responses',
  maxBytes = DEFAULT_MAX_BATCH_JSONL_BYTES,
  maxLines = MAX_BATCH_LINES,
} = {}) {
  if (typeof jsonlText !== 'string') {
    throw new OpenAiValidationError('Batch input jsonlText must be a UTF-8 string.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new OpenAiValidationError('maxBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new OpenAiValidationError('maxLines must be a positive safe integer.');
  }
  const byteLen = utf8ByteLength(jsonlText);
  if (byteLen > maxBytes) {
    throw new OpenAiError(
      `Batch input JSONL size (${byteLen} bytes) exceeds ${maxBytes}-byte safety ceiling.`,
      { code: 'REQUEST_BODY_TOO_LARGE' },
    );
  }

  const requests = [];
  let uniformEndpoint = null;
  let cursor = 0;
  const totalChars = jsonlText.length;
  let lineNo = 0;
  while (cursor < totalChars) {
    let nlIdx = jsonlText.indexOf('\n', cursor);
    if (nlIdx === -1) nlIdx = totalChars;
    let sliceEnd = nlIdx;
    if (sliceEnd > cursor && jsonlText.charCodeAt(sliceEnd - 1) === 13) {
      sliceEnd--;
    }
    const lineStr = jsonlText.slice(cursor, sliceEnd);
    lineNo++;
    if (lineStr.trim().length > 0) {
      if (requests.length >= maxLines) {
        throw new OpenAiValidationError(
          `Batch input JSONL exceeds maximum allowed line count (${maxLines}).`,
          { code: 'BATCH_INPUT_TOO_MANY_LINES' },
        );
      }
      let parsedLine;
      try {
        parsedLine = JSON.parse(lineStr);
      } catch {
        throw new OpenAiValidationError(`Batch input JSONL line ${lineNo} is not valid JSON.`);
      }
      if (!isPlainObject(parsedLine)) {
        throw new OpenAiValidationError(`Batch input JSONL line ${lineNo} must be a JSON object.`);
      }
      const lineUrl = String(parsedLine.url ?? parsedLine.endpoint ?? defaultEndpoint).trim();
      if (!ALLOWED_BATCH_ENDPOINTS.has(lineUrl)) {
        throw new OpenAiValidationError(
          `Batch input JSONL line ${lineNo} url "${lineUrl}" is not supported for Batch (allowed: /v1/responses).`,
        );
      }
      if (uniformEndpoint === null) {
        uniformEndpoint = lineUrl;
      } else if (uniformEndpoint !== lineUrl) {
        throw new OpenAiValidationError('A single OpenAI Batch submission must target one uniform endpoint.');
      }
      requests.push(parsedLine);
    }
    cursor = nlIdx + 1;
  }

  if (requests.length === 0) {
    throw new OpenAiValidationError('Batch input JSONL is empty.');
  }

  return {
    requests,
    endpoint: uniformEndpoint ?? defaultEndpoint,
    line_count: requests.length,
  };
}

/**
 * Reconcile parsed Batch `output_file` and `error_file` results by `custom_id`, preserving
 * submitted manifest order (preventing out-of-order misalignment), surfacing partial successes,
 * error lines, missing/expired items, duplicates, unexpected IDs, and known vs unknown spend.
 */
export function reconcileBatchFilesByCustomId({
  parsedOutput = null,
  parsedError = null,
  manifestCustomIds = null,
  batchStatus = null,
  outputFileError = null,
  errorFileError = null,
} = {}) {
  const outputById = parsedOutput?.by_custom_id ?? Object.create(null);
  const errorById = parsedError?.by_custom_id ?? Object.create(null);
  const outputIds = Object.keys(outputById);
  const errorIds = Object.keys(errorById);
  const hasManifest = Array.isArray(manifestCustomIds) && manifestCustomIds.length > 0;
  const manifestSet = hasManifest ? new Set(manifestCustomIds) : null;

  const duplicateCustomIds = [];
  const unexpectedCustomIds = [];
  const missingCustomIds = [];
  const succeededCustomIds = [];
  const failedCustomIds = [];
  const items = [];
  const byCustomId = Object.create(null);

  const observedUnion = [...new Set([...outputIds, ...errorIds])];
  for (const cid of observedUnion) {
    if (Object.hasOwn(outputById, cid) && Object.hasOwn(errorById, cid)) {
      duplicateCustomIds.push(cid);
    }
    if (manifestSet && !manifestSet.has(cid)) {
      unexpectedCustomIds.push(cid);
    }
  }

  const orderedIds = hasManifest ? manifestCustomIds : observedUnion;
  let nonConflictKnownMicrosBig = 0n;
  for (const cid of orderedIds) {
    const inOut = Object.hasOwn(outputById, cid);
    const inErr = Object.hasOwn(errorById, cid);
    let entry;
    if (inOut && inErr) {
      entry = {
        custom_id: cid,
        ok: false,
        usable: false,
        status: 'duplicate_conflict',
        source_file: 'both',
        http_status: outputById[cid].http_status ?? errorById[cid].http_status ?? null,
        content_status: 'invalid',
        error: `Duplicate custom_id "${cid}" appeared in both output_file and error_file.`,
        output_entry: outputById[cid],
        error_entry: errorById[cid],
        usage: null,
        usage_cost_micros: null,
      };
      failedCustomIds.push(cid);
    } else if (inOut) {
      entry = { ...outputById[cid], source_file: 'output_file' };
      if (Number.isSafeInteger(entry.usage_cost_micros) && entry.usage_cost_micros > 0) {
        nonConflictKnownMicrosBig += BigInt(entry.usage_cost_micros);
      }
      if (entry.usable === true) {
        succeededCustomIds.push(cid);
      } else {
        failedCustomIds.push(cid);
      }
    } else if (inErr) {
      entry = { ...errorById[cid], source_file: 'error_file' };
      if (Number.isSafeInteger(entry.usage_cost_micros) && entry.usage_cost_micros > 0) {
        nonConflictKnownMicrosBig += BigInt(entry.usage_cost_micros);
      }
      failedCustomIds.push(cid);
    } else {
      missingCustomIds.push(cid);
      const missingStatus = batchStatus === 'expired'
        ? 'expired'
        : (batchStatus === 'cancelled' ? 'cancelled' : 'missing');
      entry = {
        custom_id: cid,
        ok: false,
        usable: false,
        status: missingStatus,
        source_file: null,
        http_status: null,
        content_status: 'missing',
        error: missingStatus === 'expired'
          ? 'Batch item did not complete before batch expiry.'
          : (missingStatus === 'cancelled'
            ? 'Batch item did not complete before batch cancellation.'
            : 'Batch item missing from both output_file and error_file.'),
        usage: null,
        usage_cost_micros: null,
      };
    }
    items.push(entry);
    defineSafeProp(byCustomId, cid, entry);
  }

  // Exclude duplicate_conflict & unexpected lines from known_usage_cost_micros to prevent
  // double-counting the same response across output_file + error_file (which would trip USAGE_REDUCTION_FORBIDDEN).
  const knownUsageMicrosBig = (duplicateCustomIds.length === 0 && unexpectedCustomIds.length === 0)
    ? BigInt(parsedOutput?.known_usage_cost_micros ?? 0) + BigInt(parsedError?.known_usage_cost_micros ?? 0)
    : nonConflictKnownMicrosBig;
  const knownUsageCostMicros = safeMicrosToNumber(knownUsageMicrosBig);
  const hasUnknownUsage = Boolean(
    outputFileError ||
    errorFileError ||
    parsedOutput?.has_unknown_usage ||
    parsedError?.has_unknown_usage ||
    missingCustomIds.length > 0 ||
    duplicateCustomIds.length > 0 ||
    unexpectedCustomIds.length > 0 ||
    (!parsedOutput && !parsedError && orderedIds.length > 0),
  );
  const partialSuccess =
    succeededCustomIds.length > 0 &&
    (failedCustomIds.length > 0 || missingCustomIds.length > 0 || Boolean(parsedError) || Boolean(errorFileError));

  return {
    total_expected: hasManifest ? manifestCustomIds.length : items.length,
    output_line_count: parsedOutput?.total_lines ?? 0,
    error_line_count: parsedError?.total_lines ?? 0,
    succeeded_count: succeededCustomIds.length,
    failed_count: failedCustomIds.length,
    missing_count: missingCustomIds.length,
    partial_success: partialSuccess,
    known_usage_cost_micros: knownUsageCostMicros,
    total_usage_cost_micros: hasUnknownUsage ? null : knownUsageCostMicros,
    has_unknown_usage: hasUnknownUsage,
    ...(outputFileError ? { output_file_error: outputFileError } : {}),
    ...(errorFileError ? { error_file_error: errorFileError } : {}),
    succeeded_custom_ids: succeededCustomIds,
    failed_custom_ids: failedCustomIds,
    missing_custom_ids: missingCustomIds,
    duplicate_custom_ids: duplicateCustomIds,
    unexpected_custom_ids: unexpectedCustomIds,
    items,
    by_custom_id: byCustomId,
  };
}

/**
 * Build validated `.jsonl` payload + cryptographic manifest for OpenAI Batch API
 * (`/v1/responses` or `/v1/images/generations`) with 50%-off conservative cent reservation.
 */
export function buildBatchJsonl(rawRequests, options = {}) {
  if (!Array.isArray(rawRequests) || rawRequests.length < 1 || rawRequests.length > MAX_BATCH_LINES) {
    throw new OpenAiValidationError(`Batch requests must be an array of 1..${MAX_BATCH_LINES} items.`);
  }
  // Check raw request bodies BEFORE snapshotPlainValue for _offline_draft_only / _locked_logical_request_id!
  for (let idx = 0; idx < rawRequests.length; idx++) {
    const rawBodyCandidate = rawRequests[idx]?.body ?? rawRequests[idx]?.request;
    if (
      rawBodyCandidate &&
      typeof rawBodyCandidate === 'object' &&
      (rawBodyCandidate._offline_draft_only === true || rawBodyCandidate.offline_draft_only === true)
    ) {
      throw new OpenAiPolicyError(
        `Batch requests[${idx}].body is an offline draft (_offline_draft_only) and cannot be serialized for Batch execution.`,
        { code: 'OFFLINE_DRAFT_NOT_DISPATCHABLE', notDispatched: true },
      );
    }
  }

  const requests = snapshotPlainValue(rawRequests, 'Batch requests');
  assertOptionalBoolean(options.allowAstraApi, 'allowAstraApi');
  const allowAstraApi = options.allowAstraApi === true;
  const uncappedWebSearchReservationCalls = resolveUncappedWebSearchReservationCalls(
    options.uncappedWebSearchReservationCalls,
  );
  const defaultUrl = options.endpoint ?? '/v1/responses';
  const seenCustomIds = new Set();
  const seenLockedIds = new Set();
  const lockedLogicalIds = [];
  const serializedLines = [];
  const customIds = [];
  const endpointCounts = Object.create(null);
  const lineModels = Object.create(null);
  const lineSpecs = Object.create(null);
  let totalEstimatedMicrosBig = 0n;

  for (let i = 0; i < requests.length; i++) {
    const item = requirePlainObject(requests[i], `requests[${i}]`);
    const customId = item.custom_id ?? item.customId;
    if (typeof customId !== 'string' || !customId.trim() || customId.length > 512 || /[\r\n\0]/.test(customId)) {
      throw new OpenAiValidationError(`requests[${i}].custom_id must be a nonempty single-line string (<= 512 chars).`);
    }
    const cleanCustomId = customId.trim();
    if (seenCustomIds.has(cleanCustomId)) {
      throw new OpenAiValidationError(
        `Duplicate custom_id "${cleanCustomId}" in Batch requests.`,
        { code: 'DUPLICATE_BATCH_CUSTOM_ID' },
      );
    }
    seenCustomIds.add(cleanCustomId);

    const method = item.method !== undefined ? String(item.method).toUpperCase() : 'POST';
    if (method !== 'POST') {
      throw new OpenAiValidationError(`requests[${i}].method must be "POST" (got "${method}").`);
    }

    const url = String(item.url ?? item.endpoint ?? defaultUrl).trim();
    if (!ALLOWED_BATCH_ENDPOINTS.has(url)) {
      throw new OpenAiValidationError(
        `requests[${i}].url "${url}" is not supported for Batch (allowed: /v1/responses).`,
      );
    }
    defineSafeProp(endpointCounts, url, (Object.hasOwn(endpointCounts, url) ? endpointCounts[url] : 0) + 1);

    const origBodyRef = rawRequests[i]?.body ?? rawRequests[i]?.request;
    const rawBody = item.body ?? item.request;
    requirePlainObject(rawBody, `requests[${i}].body`);

    const {
      wire,
      canonicalModel,
      inferredInputTokens,
      maxWebSearchCalls,
      expectsJsonObject,
      jsonSchema,
      lockedLogicalRequestId,
    } = validateAndNormalizeResponsesBody(origBodyRef ?? rawBody, {
      allowAstraApi,
      batch: true,
      uncappedWebSearchReservationCalls,
    });
    if (lockedLogicalRequestId !== null) {
      if (cleanCustomId !== lockedLogicalRequestId) {
        throw new OpenAiPolicyError(
          `Batch requests[${i}].custom_id ("${cleanCustomId}") must match locked logical request ID "${lockedLogicalRequestId}".`,
          { code: 'LOCKED_LOGICAL_REQUEST_ID_MISMATCH', notDispatched: true },
        );
      }
      if (seenLockedIds.has(lockedLogicalRequestId)) {
        throw new OpenAiValidationError(
          `Duplicate locked logical request ID "${lockedLogicalRequestId}" in Batch requests.`,
          { code: 'DUPLICATE_BATCH_CUSTOM_ID' },
        );
      }
      seenLockedIds.add(lockedLogicalRequestId);
      lockedLogicalIds.push(lockedLogicalRequestId);
    }
    delete wire.service_tier;
    const normalizedBody = wire;
    const canonicalLineModel = canonicalModel;
    const lineSpecObj = {
      endpoint: '/v1/responses',
      model: canonicalModel,
      expects_json_object: expectsJsonObject,
      schema_json: jsonSchema ?? null,
    };
    const explicitIn = Number.isSafeInteger(item.estimatedInputTokens) && item.estimatedInputTokens >= 0
      ? Math.max(inferredInputTokens, item.estimatedInputTokens)
      : inferredInputTokens;
    const breakdown = estimateCostBreakdown({
      endpoint: '/v1/responses',
      model: wire.model,
      serviceTier: 'batch',
      estimatedInputTokens: explicitIn,
      maxOutputTokens: wire.max_output_tokens,
      maxWebSearchCalls,
      allowAstraApi,
    });
    const lineEstimatedMicros = breakdown.estimated_micros;

    const lineRecord = Object.create(null);
    defineSafeProp(lineRecord, 'custom_id', cleanCustomId);
    defineSafeProp(lineRecord, 'method', 'POST');
    defineSafeProp(lineRecord, 'url', url);
    defineSafeProp(lineRecord, 'body', normalizedBody);
    assertCleanOutgoingPayload(lineRecord, `batch_line[${i}]`);
    serializedLines.push(JSON.stringify(lineRecord));
    customIds.push(cleanCustomId);
    defineSafeProp(lineModels, cleanCustomId, canonicalLineModel);
    defineSafeProp(lineSpecs, cleanCustomId, lineSpecObj);
    totalEstimatedMicrosBig += BigInt(lineEstimatedMicros);
  }

  const totalEstimatedMicros = safeMicrosToNumber(totalEstimatedMicrosBig);
  const jsonl = `${serializedLines.join('\n')}\n`;
  const jsonlSha256 = sha256Hex(jsonl);
  const estimatedReservationCents = microsToCeilingCents(totalEstimatedMicros, { minBillableCents: 1 });
  const endpointKeys = Object.keys(endpointCounts);

  const plainEndpointCounts = cloneSafeMapRecord(endpointCounts);
  const plainLineModels = cloneSafeMapRecord(lineModels);
  const plainLineSpecs = cloneSafeMapRecord(lineSpecs);

  const batchManifest = {
    endpoint: endpointKeys.length === 1 ? endpointKeys[0] : null,
    jsonl_sha256: jsonlSha256,
    line_count: serializedLines.length,
    custom_ids: [...customIds],
    locked_logical_ids: [...lockedLogicalIds],
    line_models: plainLineModels,
    line_specs: plainLineSpecs,
    estimated_micros: totalEstimatedMicros,
    estimated_reservation_cents: estimatedReservationCents,
  };

  return {
    jsonl,
    line_count: serializedLines.length,
    custom_ids: customIds,
    locked_logical_ids: lockedLogicalIds,
    line_models: plainLineModels,
    line_specs: plainLineSpecs,
    endpoint_counts: plainEndpointCounts,
    jsonl_sha256: jsonlSha256,
    estimated_micros: totalEstimatedMicros,
    estimated_reservation_cents: estimatedReservationCents,
    batch_manifest: batchManifest,
  };
}

/**
 * Parse OpenAI Batch output `.jsonl` text, enforcing byte/line caps BEFORE splitting (`P2-09`),
 * scrubbing/rejecting secret tokens in `custom_id` & IDs (`P0-22`), validating terminal line
 * statuses (`P0-02`), recursive JSON schemas (`P1-01`), & per-line specs (`P1-04`),
 * and computing exact 50%-discounted microdollar usage.
 */
export function parseBatchOutputJsonl(jsonlText, {
  allowAstraApi = true,
  lineModels = null,
  lineSpecs = null,
  expectedEndpoint = null,
  literalSecret = null,
  maxBytes = DEFAULT_MAX_BATCH_JSONL_BYTES,
  maxLines = MAX_BATCH_LINES,
} = {}) {
  assertOptionalBoolean(allowAstraApi, 'allowAstraApi');
  if (typeof jsonlText !== 'string') {
    throw new OpenAiValidationError('jsonlText must be a UTF-8 string.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new OpenAiValidationError('maxBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new OpenAiValidationError('maxLines must be a positive safe integer.');
  }
  const byteLen = utf8ByteLength(jsonlText);
  if (byteLen > maxBytes) {
    throw new OpenAiError(
      `Batch output JSONL size (${byteLen} bytes) exceeds ${maxBytes}-byte safety ceiling.`,
      { code: 'RESPONSE_BODY_TOO_LARGE' },
    );
  }

  const rawLines = [];
  let cursor = 0;
  const totalChars = jsonlText.length;
  while (cursor < totalChars) {
    let nlIdx = jsonlText.indexOf('\n', cursor);
    if (nlIdx === -1) nlIdx = totalChars;
    let sliceEnd = nlIdx;
    if (sliceEnd > cursor && jsonlText.charCodeAt(sliceEnd - 1) === 13) {
      sliceEnd--;
    }
    const lineStr = jsonlText.slice(cursor, sliceEnd);
    if (lineStr.trim().length > 0) {
      if (rawLines.length >= maxLines) {
        throw new OpenAiValidationError(
          `Batch output JSONL exceeds maximum allowed line count (${maxLines}).`,
          { code: 'BATCH_OUTPUT_TOO_MANY_LINES' },
        );
      }
      rawLines.push(lineStr);
    }
    cursor = nlIdx + 1;
  }

  if (rawLines.length === 0) {
    throw new OpenAiValidationError('Batch output JSONL is empty.');
  }
  if (lineModels !== null && lineModels !== undefined) {
    requirePlainObject(lineModels, 'lineModels');
  }
  if (lineSpecs !== null && lineSpecs !== undefined) {
    requirePlainObject(lineSpecs, 'lineSpecs');
  }

  const seenCustomIds = new Set();
  const results = [];
  const byCustomId = Object.create(null);
  let http200Count = 0;
  let errorLineCount = 0;
  let succeededCount = 0;
  let usableCount = 0;
  let refusedCount = 0;
  let incompleteCount = 0;
  let failedCount = 0;
  let knownUsageCostMicrosBig = 0n;
  let hasUnknownUsage = false;

  for (let i = 0; i < rawLines.length; i++) {
    let rawParsed;
    try {
      rawParsed = JSON.parse(rawLines[i]);
    } catch {
      throw new OpenAiValidationError(`Batch output line ${i + 1} is not valid JSON.`);
    }
    if (!isPlainObject(rawParsed)) {
      throw new OpenAiValidationError(`batch_output[${i}] must be a plain object.`);
    }
    const customId = rawParsed.custom_id;
    if (typeof customId !== 'string' || !customId.trim()) {
      throw new OpenAiValidationError(`Batch output line ${i + 1} is missing custom_id.`);
    }
    const cleanId = customId.trim();
    // P0-22: Reject secret tokens echoed inside protocol custom_id!
    if (
      (literalSecret && typeof literalSecret === 'string' && literalSecret.length >= 4 && cleanId.includes(literalSecret)) ||
      containsSecretToken(cleanId) ||
      scrubTextForReceipt(cleanId, literalSecret) !== cleanId
    ) {
      throw new OpenAiPolicyError(
        `Batch output line ${i + 1} custom_id contains a credential or secret token; refusing unsafe protocol identifier.`,
        { code: 'SECRET_IN_PROTOCOL_IDENTIFIER' },
      );
    }
    if (seenCustomIds.has(cleanId)) {
      throw new OpenAiValidationError(`Duplicate custom_id "${cleanId}" in Batch output JSONL.`);
    }
    seenCustomIds.add(cleanId);

    const lineSpec = lineSpecs && Object.hasOwn(lineSpecs, cleanId) ? lineSpecs[cleanId] : null;
    const expectedLineModel = (lineModels && Object.hasOwn(lineModels, cleanId) ? lineModels[cleanId] : null) ?? lineSpec?.model ?? null;
    const expectedLineEndpoint = lineSpec?.endpoint ?? expectedEndpoint ?? null;

    const safeBatchReqId = extractSafeProviderId(rawParsed.id, literalSecret);
    const sanitizedLine = sanitizeReceiptValue(rawParsed, 0, literalSecret);
    const statusCode = sanitizedLine.response?.status_code ?? null;
    const body = sanitizedLine.response?.body ?? null;

    if (sanitizedLine.error || statusCode !== 200 || !body || typeof body !== 'object') {
      errorLineCount++;
      failedCount++;
      let errUsageMicros = null;
      const errModel = (typeof body?.model === 'string' && body.model.trim()) ? body.model.trim() : expectedLineModel;
      // P0-02: Never treat interim usage on an error line with non-terminal inner status ('in_progress'/'queued') as final!
      const innerErrStatusTerminal = body?.status === undefined || TERMINAL_RESPONSE_STATUSES.has(body.status);
      const errUsageObj = body?.usage ?? body?.error?.usage ?? null;
      const { calls: errWsCalls, uncertain: errWsUsageUncertain } = inspectWebSearchUsage(body);
      if (errUsageObj && errModel) {
        try {
          const computed = computeUsageCostMicros({
            model: errModel,
            serviceTier: 'batch',
            usage: errUsageObj,
            webSearchCalls: errWsCalls,
            allowAstraApi: true,
          });
          knownUsageCostMicrosBig += BigInt(computed);
          if (innerErrStatusTerminal && !errWsUsageUncertain) {
            errUsageMicros = computed;
          } else {
            errUsageMicros = null;
            hasUnknownUsage = true;
          }
        } catch {
          errUsageMicros = null;
          hasUnknownUsage = true;
        }
      } else {
        hasUnknownUsage = true;
      }
      const entry = {
        custom_id: cleanId,
        batch_request_id: safeBatchReqId,
        ok: false,
        usable: false,
        status: 'failed',
        http_status: statusCode,
        content_status: 'invalid',
        error: scrubTextForReceipt(
          sanitizedLine.error?.message ?? body?.error?.message ?? `Batch item failed (HTTP ${String(statusCode)})`,
          literalSecret,
        ),
        usage: errUsageObj,
        web_search_calls: errWsCalls,
        usage_cost_micros: errUsageMicros,
        body,
      };
      results.push(entry);
      defineSafeProp(byCustomId, cleanId, entry);
      continue;
    }

    http200Count++;
    const looksLikeImageBody = Array.isArray(body.data) && !Object.hasOwn(body, 'output');
    if (looksLikeImageBody || (expectedLineEndpoint && expectedLineEndpoint !== '/v1/responses')) {
      failedCount++;
      hasUnknownUsage = true;
      const entry = {
        custom_id: cleanId,
        batch_request_id: safeBatchReqId,
        ok: false,
        usable: false,
        status: 'failed',
        http_status: 200,
        content_status: 'invalid',
        error: `Batch item "${cleanId}" body shape contradicted expected endpoint "${expectedLineEndpoint ?? '/v1/responses'}".`,
        usage_cost_micros: null,
        body,
      };
      results.push(entry);
      defineSafeProp(byCustomId, cleanId, entry);
      continue;
    }

    const extracted = extractResponsesContent(body, {
      expectsJsonObject: Boolean(lineSpec?.expects_json_object),
      jsonSchema: lineSpec?.schema_json ?? null,
    });
    // P0-02: Require TERMINAL response status (reject 'in_progress' / 'queued' interim usage!).
    const hasTerminalRespStatus = TERMINAL_RESPONSE_STATUSES.has(extracted.responseStatus);
    const returnedRespModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;

    let modelMismatch = false;
    let unexpectedAstra = false;
    if (returnedRespModel) {
      try {
        const retSpec = resolveModelPricing(returnedRespModel, { allowAstraApi: true, endpoint: '/v1/responses' });
        if (!allowAstraApi && retSpec.astraRestricted) unexpectedAstra = true;
        if (expectedLineModel) {
          const expSpec = resolveModelPricing(expectedLineModel, { allowAstraApi: true, endpoint: '/v1/responses' });
          if (retSpec.canonicalModel !== expSpec.canonicalModel) modelMismatch = true;
        }
      } catch {
        modelMismatch = true;
      }
    } else {
      modelMismatch = true;
    }

    let usageMicros = null;
    if (body.usage && returnedRespModel && hasTerminalRespStatus && !extracted.webSearchUsageUncertain) {
      try {
        usageMicros = computeUsageCostMicros({
          model: returnedRespModel,
          serviceTier: 'batch',
          usage: body.usage,
          webSearchCalls: extracted.webSearchCalls,
          allowAstraApi: true,
        });
        knownUsageCostMicrosBig += BigInt(usageMicros);
      } catch {
        usageMicros = null;
        hasUnknownUsage = true;
      }
    } else {
      if (body.usage && returnedRespModel) {
        try {
          const provLineMicros = computeUsageCostMicros({
            model: returnedRespModel,
            serviceTier: 'batch',
            usage: body.usage,
            webSearchCalls: extracted.webSearchCalls,
            allowAstraApi: true,
          });
          knownUsageCostMicrosBig += BigInt(provLineMicros);
        } catch { /* ignore */ }
      }
      hasUnknownUsage = true;
    }

    const rawLineContentStatus = (!hasTerminalRespStatus || modelMismatch || unexpectedAstra)
      ? 'invalid'
      : extracted.contentStatus;
    const isLineUsable = rawLineContentStatus === 'usable' && usageMicros !== null;
    const finalLineContentStatus = usageMicros === null && rawLineContentStatus === 'usable'
      ? 'invalid'
      : rawLineContentStatus;

    // P1-04: Derive aggregate counters STRICTLY from final per-line disposition!
    if (usageMicros === null) {
      failedCount++;
    } else if (isLineUsable) {
      succeededCount++;
      usableCount++;
    } else if (finalLineContentStatus === 'refused') {
      succeededCount++;
      refusedCount++;
    } else if (finalLineContentStatus === 'incomplete') {
      succeededCount++;
      incompleteCount++;
    } else {
      failedCount++;
    }

    const safeRespId = extractSafeProviderId(rawParsed.response?.body?.id, literalSecret);
    const entry = {
      custom_id: cleanId,
      batch_request_id: safeBatchReqId,
      provider_response_id: safeRespId,
      ok: isLineUsable,
      usable: isLineUsable,
      status: finalLineContentStatus === 'invalid' || usageMicros === null ? 'failed' : 'completed',
      response_status: extracted.responseStatus,
      http_status: 200,
      content_status: finalLineContentStatus,
      output_text: extracted.outputText,
      refusal: extracted.refusal,
      incomplete_details: extracted.incompleteDetails,
      web_search_calls: extracted.webSearchCalls,
      usage: body.usage ?? null,
      usage_cost_micros: usageMicros,
      body,
    };
    results.push(entry);
    defineSafeProp(byCustomId, cleanId, entry);
  }

  let overallContentStatus;
  if (usableCount === results.length) {
    overallContentStatus = 'usable';
  } else if (refusedCount === results.length) {
    overallContentStatus = 'refused';
  } else if (failedCount === results.length) {
    overallContentStatus = 'invalid';
  } else {
    overallContentStatus = 'incomplete';
  }

  const knownUsageCostMicros = safeMicrosToNumber(knownUsageCostMicrosBig);

  return {
    total_lines: results.length,
    http_200_count: http200Count,
    error_line_count: errorLineCount,
    succeeded_count: succeededCount,
    usable_count: usableCount,
    refused_count: refusedCount,
    incomplete_count: incompleteCount,
    failed_count: failedCount,
    content_status: overallContentStatus,
    known_usage_cost_micros: knownUsageCostMicros,
    total_usage_cost_micros: hasUnknownUsage ? null : knownUsageCostMicros,
    has_unknown_usage: hasUnknownUsage,
    results,
    by_custom_id: byCustomId,
  };
}

function summarizeSettledBatchUsage(results) {
  const sum = select => {
    let total = 0;
    for (const line of results) {
      const value = select(line);
      if (!Number.isSafeInteger(value) || value < 0) return null;
      total += value;
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  };
  return {
    input_tokens: sum(line => line.usage?.input_tokens),
    output_tokens: sum(line => line.usage?.output_tokens),
    input_tokens_details: {
      cached_tokens: sum(line => line.usage?.input_tokens_details?.cached_tokens),
      cache_write_tokens: sum(line => line.usage?.input_tokens_details?.cache_write_tokens ??
        line.usage?.input_tokens_details?.cached_creation_tokens),
    },
    output_tokens_details: {
      reasoning_tokens: sum(line => line.usage?.output_tokens_details?.reasoning_tokens),
    },
    web_search_calls: sum(line => line.web_search_calls),
  };
}

function validateExternalBatchManifest(rawManifest, { endpoint, allowAstraApi, explicitReservationCents }) {
  requirePlainObject(rawManifest, 'batchManifest');
  if (rawManifest.endpoint !== endpoint) {
    throw new OpenAiValidationError(
      `batchManifest.endpoint ("${String(rawManifest.endpoint)}") must match endpoint "${endpoint}".`,
      { code: 'BATCH_MANIFEST_INVALID' },
    );
  }
  if (typeof rawManifest.jsonl_sha256 !== 'string' || !HEX_SHA256_RE.test(rawManifest.jsonl_sha256)) {
    throw new OpenAiValidationError(
      'batchManifest.jsonl_sha256 must be a 64-character lowercase hex SHA-256 digest.',
      { code: 'BATCH_MANIFEST_INVALID' },
    );
  }
  if (typeof rawManifest.jsonl === 'string' && sha256Hex(rawManifest.jsonl) !== rawManifest.jsonl_sha256) {
    throw new OpenAiValidationError(
      'batchManifest.jsonl content does not match batchManifest.jsonl_sha256.',
      { code: 'BATCH_MANIFEST_INVALID' },
    );
  }
  if (!Array.isArray(rawManifest.custom_ids) || rawManifest.custom_ids.length < 1 || rawManifest.custom_ids.length > MAX_BATCH_LINES) {
    throw new OpenAiValidationError(
      `batchManifest.custom_ids must be a nonempty array of 1..${MAX_BATCH_LINES} unique custom_ids.`,
      { code: 'BATCH_MANIFEST_INVALID' },
    );
  }
  if (rawManifest.line_count !== undefined && rawManifest.line_count !== rawManifest.custom_ids.length) {
    throw new OpenAiValidationError(
      'batchManifest.line_count does not match batchManifest.custom_ids.length.',
      { code: 'BATCH_MANIFEST_INVALID' },
    );
  }
  requirePlainObject(rawManifest.line_models, 'batchManifest.line_models');

  const seenIds = new Set();
  const cleanCustomIds = [];
  const cleanLineModels = Object.create(null);
  let minFloorMicrosBig = 0n;

  for (let i = 0; i < rawManifest.custom_ids.length; i++) {
    const cid = rawManifest.custom_ids[i];
    if (typeof cid !== 'string' || !cid.trim() || cid.length > 512 || /[\r\n\0]/.test(cid)) {
      throw new OpenAiValidationError(`batchManifest.custom_ids[${i}] must be a nonempty single-line string.`, {
        code: 'BATCH_MANIFEST_INVALID',
      });
    }
    const trimmedId = cid.trim();
    if (seenIds.has(trimmedId)) {
      throw new OpenAiValidationError(`Duplicate custom_id "${trimmedId}" in batchManifest.custom_ids.`, {
        code: 'BATCH_MANIFEST_INVALID',
      });
    }
    seenIds.add(trimmedId);
    if (!Object.hasOwn(rawManifest.line_models, trimmedId)) {
      throw new OpenAiValidationError(
        `batchManifest.line_models is missing model mapping for custom_id "${trimmedId}".`,
        { code: 'BATCH_MANIFEST_INVALID' },
      );
    }
    const lineModel = rawManifest.line_models[trimmedId];
    const spec = resolveModelPricing(lineModel, { allowAstraApi });
    if (spec.family !== 'text') {
      throw new OpenAiValidationError(`batchManifest.line_models["${trimmedId}"] must be a text/responses model.`);
    }
    cleanCustomIds.push(trimmedId);
    defineSafeProp(cleanLineModels, trimmedId, spec.canonicalModel);

    const floorBreakdown = estimateCostBreakdown({
      endpoint: '/v1/responses',
      model: spec.canonicalModel,
      serviceTier: 'batch',
      estimatedInputTokens: 1,
      maxOutputTokens: 1,
      allowAstraApi,
    });
    minFloorMicrosBig += BigInt(floorBreakdown.estimated_micros);
  }

  for (const extraKey of Object.keys(rawManifest.line_models)) {
    if (!seenIds.has(extraKey)) {
      throw new OpenAiValidationError(
        `batchManifest.line_models contains unknown custom_id "${extraKey}".`,
        { code: 'BATCH_MANIFEST_INVALID' },
      );
    }
  }

  const minFloorCents = microsToCeilingCents(safeMicrosToNumber(minFloorMicrosBig), { minBillableCents: 1 });
  const manifestCents = rawManifest.estimated_reservation_cents;
  if (!Number.isSafeInteger(manifestCents) || manifestCents < minFloorCents) {
    throw new OpenAiValidationError(
      `batchManifest.estimated_reservation_cents (${String(manifestCents)}) must be a safe integer >= ${minFloorCents}.`,
      { code: 'BATCH_MANIFEST_INVALID' },
    );
  }
  if (
    explicitReservationCents !== undefined &&
    explicitReservationCents !== null &&
    explicitReservationCents !== manifestCents
  ) {
    throw new OpenAiValidationError(
      `estimated_reservation_cents (${String(explicitReservationCents)}) does not match batchManifest.estimated_reservation_cents (${manifestCents}).`,
      { code: 'BATCH_MANIFEST_MISMATCH' },
    );
  }

  return {
    endpoint,
    jsonl_sha256: rawManifest.jsonl_sha256,
    line_count: cleanCustomIds.length,
    custom_ids: cleanCustomIds,
    line_models: cleanLineModels,
    estimated_reservation_cents: manifestCents,
  };
}

// -----------------------------------------------------------------------------
// OpenAiClient Class
// -----------------------------------------------------------------------------

export class OpenAiClient {
  constructor(options = {}) {
    const {
      baseUrl = DEFAULT_BASE_URL,
      allowInsecureLocalBaseUrl = false,
      testMode = undefined,
      fetchImpl = globalThis.fetch,
      ledger = null,
      credentialFile = null,
      apiKeyEnvVar = null,
      allowEnvKey = false,
      env = process.env,
      defaultTimeoutMs = undefined,
      timeoutMs = undefined,
      pollIntervalMs = undefined,
      uncappedWebSearchReservationCalls = DEFAULT_UNCAPPED_WEB_SEARCH_RESERVATION_CALLS,
      defaultAccountScope = 'openai-default',
      nowFn = () => new Date(),
    } = options ?? {};

    if (typeof fetchImpl !== 'function') {
      throw new OpenAiValidationError('fetchImpl must be a function.');
    }
    assertOptionalBoolean(allowInsecureLocalBaseUrl, 'allowInsecureLocalBaseUrl');
    assertOptionalBoolean(testMode, 'testMode');
    assertOptionalBoolean(allowEnvKey, 'allowEnvKey');

    this._hasExplicitFetchImpl = Boolean(options && Object.hasOwn(options, 'fetchImpl') && options.fetchImpl !== undefined);
    this._explicitTestMode = testMode;
    const ledgerIsTest = ledger instanceof OpenAiBudgetLedger && Boolean(ledger.isTestLedger === true || ledger.isMemoryDatabase());

    if (testMode === false && ledgerIsTest) {
      throw new OpenAiPolicyError(
        'Live OpenAiClient (testMode: false) cannot bind a testMode or in-memory OpenAiBudgetLedger.',
        { code: 'TEST_LEDGER_FORBIDDEN_ON_LIVE_CLIENT', notDispatched: true },
      );
    }

    const resolvedTestMode = testMode !== undefined ? testMode : ledgerIsTest;
    if ((resolvedTestMode === true || ledgerIsTest) && (!this._hasExplicitFetchImpl || fetchImpl === globalThis.fetch)) {
      throw new OpenAiPolicyError(
        'Test-mode OpenAiClient or testMode OpenAiBudgetLedger forbids real globalThis.fetch; supply an explicit mock fetchImpl.',
        { code: 'TEST_MODE_FORBIDS_LIVE_NETWORK_FETCH', notDispatched: true },
      );
    }

    this.allowInsecureLocalBaseUrl = allowInsecureLocalBaseUrl === true;
    this.testMode = resolvedTestMode === true;
    this.baseUrl = normalizeBaseUrl(baseUrl, { allowInsecureLocalBaseUrl: this.allowInsecureLocalBaseUrl });
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.fetchImpl = fetchImpl;
    this.ledger = ledger;
    this.credentialFile = credentialFile;
    this.apiKeyEnvVar = apiKeyEnvVar;
    this.allowEnvKey = allowEnvKey === true;
    this.env = env;
    this.defaultTimeoutMs = defaultTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultPollIntervalMs = validateBackgroundOptions({ pollIntervalMs }).pollIntervalMs;
    this.uncappedWebSearchReservationCalls = resolveUncappedWebSearchReservationCalls(uncappedWebSearchReservationCalls);
    this.defaultAccountScope = defaultAccountScope;
    this._nowFn = typeof nowFn === 'function' ? nowFn : () => new Date();
  }

  _resolveEffectivePolicy(policy = {}) {
    if (policy !== undefined && policy !== null) {
      requirePlainObject(policy, 'policy');
    }
    const p = policy ?? {};
    if (p.maxRetries !== undefined && p.maxRetries !== 0) {
      throw new OpenAiPolicyError(
        `maxRetries must be strictly 0 on billable OpenAI requests (got ${String(p.maxRetries)}).`,
        { code: 'NONZERO_RETRIES_FORBIDDEN' },
      );
    }

    assertOptionalBoolean(p.allowInsecureLocalBaseUrl, 'allowInsecureLocalBaseUrl');
    assertOptionalBoolean(p.testMode, 'testMode');
    assertOptionalBoolean(p.allowAstraApi, 'allowAstraApi');
    assertOptionalBoolean(p.allowEnvKey, 'allowEnvKey');
    assertOptionalBoolean(p.deleteAfterPersist, 'deleteAfterPersist');
    assertOptionalBoolean(p.cleanupAfterPersist, 'cleanupAfterPersist');
    assertOptionalBoolean(p.verify404Readback, 'verify404Readback');
    assertOptionalBoolean(p.downloadOutput, 'downloadOutput');
    assertOptionalBoolean(p.allowCustomTariffForTests, 'allowCustomTariffForTests');
    assertOptionalBoolean(p.allowTestClockOverride, 'allowTestClockOverride');
    assertOptionalBoolean(p.allowEstimatedSpeechSettlementInTests, 'allowEstimatedSpeechSettlementInTests');
    assertOptionalBoolean(p.background, 'background');

    const ledger = p.ledger ?? this.ledger;
    const hasExplicitFetch = (Object.hasOwn(p, 'fetchImpl') && p.fetchImpl !== undefined) || this._hasExplicitFetchImpl;
    const fetchImpl = p.fetchImpl ?? this.fetchImpl;
    if (typeof fetchImpl !== 'function') {
      throw new OpenAiValidationError('fetchImpl must be a function.');
    }

    const ledgerIsTest = ledger instanceof OpenAiBudgetLedger && Boolean(ledger.isTestLedger === true || ledger.isMemoryDatabase());
    const explicitMode = p.testMode !== undefined ? p.testMode : this._explicitTestMode;
    if (explicitMode === false && ledgerIsTest) {
      throw new OpenAiPolicyError(
        'Live OpenAI HTTP calls (testMode: false) cannot use a testMode or in-memory OpenAiBudgetLedger.',
        { code: 'TEST_LEDGER_FORBIDDEN_ON_LIVE_CLIENT', notDispatched: true },
      );
    }

    const effectiveTestMode = explicitMode !== undefined ? explicitMode : (this.testMode || ledgerIsTest);
    if ((effectiveTestMode === true || ledgerIsTest) && (!hasExplicitFetch || fetchImpl === globalThis.fetch)) {
      throw new OpenAiPolicyError(
        'Test-mode OpenAiClient or testMode OpenAiBudgetLedger forbids real globalThis.fetch; supply an explicit mock fetchImpl.',
        { code: 'TEST_MODE_FORBIDS_LIVE_NETWORK_FETCH', notDispatched: true },
      );
    }
    const isLiveTransport = !effectiveTestMode;

    let baseUrl = this.baseUrl;
    if (p.baseUrl !== undefined && p.baseUrl !== null) {
      const candidateBaseUrl = normalizeBaseUrl(p.baseUrl, {
        allowInsecureLocalBaseUrl: p.allowInsecureLocalBaseUrl ?? this.allowInsecureLocalBaseUrl,
      });
      const candidateOrigin = new URL(candidateBaseUrl).origin;
      if (candidateOrigin !== this.baseOrigin) {
        throw new OpenAiPolicyError(
          `Per-call policy.baseUrl origin ("${candidateOrigin}") does not match OpenAiClient.baseOrigin ("${this.baseOrigin}").`,
          { code: 'BASE_ORIGIN_MISMATCH', notDispatched: true },
        );
      }
      if (candidateBaseUrl !== this.baseUrl) {
        throw new OpenAiPolicyError(
          `Per-call policy.baseUrl ("${candidateBaseUrl}") does not match OpenAiClient.baseUrl ("${this.baseUrl}"); route prefix overrides are forbidden.`,
          { code: 'API_BASE_URL_MISMATCH', notDispatched: true },
        );
      }
      baseUrl = candidateBaseUrl;
    }

    if (isLiveTransport && p.allowCustomTariffForTests === true) {
      throw new OpenAiPolicyError(
        'allowCustomTariffForTests is forbidden outside explicit testMode.',
        { code: 'CUSTOM_TARIFF_FORBIDDEN_ON_LIVE' },
      );
    }
    if (isLiveTransport && p.allowTestClockOverride === true) {
      throw new OpenAiPolicyError(
        'allowTestClockOverride is forbidden outside explicit testMode.',
        { code: 'CLOCK_OVERRIDE_FORBIDDEN_ON_LIVE' },
      );
    }
    if (isLiveTransport && p.allowEstimatedSpeechSettlementInTests === true) {
      throw new OpenAiPolicyError(
        'allowEstimatedSpeechSettlementInTests is forbidden outside explicit testMode.',
        { code: 'ESTIMATED_SPEECH_SETTLEMENT_FORBIDDEN_ON_LIVE' },
      );
    }

    const accountScope = p.accountScope ?? p.account_scope ?? this.defaultAccountScope;
    const explicitMonthUtc = p.monthUtc ?? p.month_utc;
    const timeoutMs = p.timeoutMs ?? this.defaultTimeoutMs;

    return {
      ledger,
      fetchImpl,
      testMode: effectiveTestMode,
      isLiveTransport,
      baseUrl,
      accountScope,
      monthUtc: explicitMonthUtc,
      allowTestClockOverride: !isLiveTransport && p.allowTestClockOverride === true,
      timeoutMs,
      background: p.background,
      uncappedWebSearchReservationCalls: resolveUncappedWebSearchReservationCalls(
        p.uncappedWebSearchReservationCalls === undefined
          ? this.uncappedWebSearchReservationCalls
          : p.uncappedWebSearchReservationCalls,
      ),
      signal: p.signal ?? null,
      credentialFile: p.credentialFile ?? this.credentialFile,
      apiKeyEnvVar: p.apiKeyEnvVar ?? this.apiKeyEnvVar,
      allowEnvKey: p.allowEnvKey !== undefined ? p.allowEnvKey : this.allowEnvKey,
      env: p.env ?? this.env,
      allowAstraApi: p.allowAstraApi === true,
      deleteAfterPersist: Boolean(p.deleteAfterPersist === true || p.cleanupAfterPersist === true),
      verify404Readback: p.verify404Readback,
      downloadOutput: p.downloadOutput === true,
      allowCustomTariffForTests: !isLiveTransport && p.allowCustomTariffForTests === true,
      allowEstimatedSpeechSettlementInTests: !isLiveTransport && p.allowEstimatedSpeechSettlementInTests === true,
      estimatedInputTokens: p.estimatedInputTokens,
      maxOutputTokens: p.maxOutputTokens,
      ttsMicrosPer1kChars: p.ttsMicrosPer1kChars ?? null,
      attemptId: p.attemptId ?? p.attempt_id ?? null,
      logicalRequestId: p.logicalRequestId ?? p.logical_request_id ?? null,
      packetSha256: p.packetSha256 ?? p.packet_sha256 ?? null,
    };
  }

  _requireBillableLedger(eff) {
    if (!(eff.ledger instanceof OpenAiBudgetLedger)) {
      throw new OpenAiPolicyError(
        'An OpenAiBudgetLedger instance is required for all billable OpenAI API requests.',
        { code: 'LEDGER_REQUIRED', notDispatched: true },
      );
    }
    if (!eff.testMode && (eff.ledger.isMemoryDatabase() || eff.ledger.isTestLedger === true)) {
      throw new OpenAiPolicyError(
        'In-memory or testMode SQLite ledgers are forbidden in production mode; use a verified file-backed ledger.',
        { code: 'TEST_LEDGER_FORBIDDEN_ON_LIVE_CLIENT', notDispatched: true },
      );
    }
    return eff.ledger;
  }

  _assertBoundAttemptConnection(boundAttempt, eff, credentialFingerprintSha256) {
    if (!boundAttempt) return;
    // P0-03 & P0-18: Quarantine legacy/migrated attempts missing connection bindings until verified!
    if (!boundAttempt.origin || !boundAttempt.api_base_url || !boundAttempt.credential_fingerprint_sha256) {
      throw new OpenAiPolicyError(
        `Bound attempt "${boundAttempt.attempt_id}" lacks verified origin, api_base_url, or credential_fingerprint_sha256; run verifyLegacyAttemptConnectionBinding before recovery or cleanup.`,
        { code: 'LEGACY_UNBOUND_CONNECTION_QUARANTINED' },
      );
    }
    if (boundAttempt.origin !== this.baseOrigin) {
      throw new OpenAiPolicyError(
        `Bound attempt "${boundAttempt.attempt_id}" was admitted for origin "${boundAttempt.origin}", not "${this.baseOrigin}".`,
        { code: 'ORIGIN_MISMATCH_ON_RECOVERY' },
      );
    }
    if (boundAttempt.api_base_url !== eff.baseUrl) {
      throw new OpenAiPolicyError(
        `Bound attempt "${boundAttempt.attempt_id}" was admitted for api_base_url "${boundAttempt.api_base_url}", not "${eff.baseUrl}".`,
        { code: 'API_BASE_URL_MISMATCH_ON_RECOVERY' },
      );
    }
    if (
      !credentialFingerprintSha256 ||
      boundAttempt.credential_fingerprint_sha256 !== credentialFingerprintSha256
    ) {
      throw new OpenAiPolicyError(
        `Bound attempt "${boundAttempt.attempt_id}" is bound to a different API credential fingerprint; cross-credential recovery or cleanup is forbidden.`,
        { code: 'CREDENTIAL_MISMATCH_ON_RECOVERY' },
      );
    }
  }

  _resolveApiKeyAndFingerprint(eff) {
    const apiKey = loadOpenAiApiKey({
      credentialFile: eff.credentialFile,
      apiKeyEnvVar: eff.apiKeyEnvVar,
      allowEnvKey: eff.allowEnvKey,
      env: eff.env,
    });
    return {
      apiKey,
      credentialFingerprintSha256: sha256Hex(apiKey),
    };
  }

  _handlePostDispatchUnexpectedError(err, ledger, attempt, apiKey, httpStatus = null) {
    if (err instanceof OpenAiAmbiguousOutcomeError || err instanceof OpenAiHttpError) {
      throw err;
    }
    const reason = `Post-dispatch settlement/persistence error (${scrubTextForReceipt(err?.message || 'post_dispatch_error', apiKey)}); holding attempt in pending_recovery.`;
    try {
      const latest = ledger.getAttemptById(attempt.attempt_id);
      if (latest && (latest.status === 'in_progress' || latest.status === 'pending_recovery')) {
        ledger.markPendingRecovery(attempt.attempt_id, {
          httpStatus,
          reason,
        });
      }
    } catch { /* preserve outer error reporting */ }
    throw new OpenAiAmbiguousOutcomeError(reason, {
      code: typeof err?.code === 'string' ? err.code : 'PENDING_RECOVERY',
      attemptId: attempt.attempt_id,
      logicalRequestId: attempt.logical_request_id,
      httpStatus,
      reservedCents: attempt.reserved_cents,
    });
  }

  async _readJsonResponseSafe(res, literalSecret = null, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, {
    requireStreamingOrContentLength = false,
  } = {}) {
    const rawBytes = await readBoundedBytesResponse(res, maxBytes, { requireStreamingOrContentLength });
    const originalBodySha256 = rawBytes.length > 0 ? sha256Hex(rawBytes) : null;
    const rawText = rawBytes.toString('utf8');
    const scrubbedRawText = rawText ? scrubTextForReceipt(rawText, literalSecret) : null;
    const scrubbedRawSha256 = scrubbedRawText !== null ? sha256Hex(scrubbedRawText) : null;
    if (!rawText || !rawText.trim()) {
      return {
        okJson: false,
        body: null,
        sanitizedBody: null,
        rawBytes,
        rawText: '',
        originalBodySha256,
        scrubbedRawText: null,
        scrubbedRawSha256: null,
      };
    }
    try {
      const parsed = JSON.parse(rawText);
      const sanitizedBody = sanitizeReceiptValue(parsed, 0, literalSecret);
      return {
        okJson: true,
        body: parsed,
        sanitizedBody,
        rawBytes,
        rawText,
        originalBodySha256,
        scrubbedRawText,
        scrubbedRawSha256,
      };
    } catch {
      return {
        okJson: false,
        body: null,
        sanitizedBody: null,
        rawBytes,
        rawText,
        originalBodySha256,
        scrubbedRawText,
        scrubbedRawSha256,
      };
    }
  }

  /**
   * POST /v1/decisions — Strictly `gpt-6-luna`, zero `reasoning` parameters,
   * `1..400` questions (`predicate | choice | score`, `<= 32` choices), cumulative `<= 256 KiB` `input_json`.
   */
  async createDecision(rawParams, policy = {}) {
    if (
      rawParams &&
      typeof rawParams === 'object' &&
      (rawParams._offline_draft_only === true || rawParams.offline_draft_only === true)
    ) {
      throw new OpenAiPolicyError(
        'Offline draft request (_offline_draft_only) cannot be dispatched to /v1/decisions.',
        { code: 'OFFLINE_DRAFT_NOT_DISPATCHABLE', notDispatched: true },
      );
    }
    const params = snapshotPlainValue(rawParams, 'Decision params');
    requirePlainObject(params, 'Decision params');
    const eff = this._resolveEffectivePolicy(policy);
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);

    if (params.stream !== undefined && params.stream !== false) {
      throw new OpenAiValidationError('/v1/decisions streaming (stream: true) is unsupported.', {
        code: 'STREAMING_UNSUPPORTED',
      });
    }

    const forbiddenKey = hasForbiddenReasoningKey(params);
    if (forbiddenKey) {
      throw new OpenAiPolicyError(
        `/v1/decisions forbids any "${forbiddenKey}" parameter; gpt-6-luna Decisions does not accept reasoning settings.`,
        { code: 'DECISIONS_REASONING_FORBIDDEN' },
      );
    }

    const wire = stripLocalKeys(params);
    if (wire.tools !== undefined) {
      throw new OpenAiValidationError('/v1/decisions does not support tools; use /v1/responses for bounded web_search.');
    }

    const tierInfo = validateInteractiveServiceTier(wire.service_tier, '/v1/decisions');
    if (tierInfo.wireTier === undefined) {
      delete wire.service_tier;
    } else {
      defineSafeProp(wire, 'service_tier', tierInfo.wireTier);
    }

    defineSafeProp(wire, 'model', wire.model ?? 'gpt-6-luna');
    if (isAstraModel(wire.model)) {
      throw new OpenAiPolicyError(
        `Model "${wire.model}" is blocked on /v1/decisions; /v1/decisions supports only gpt-6-luna.`,
        { code: 'ASTRA_API_BLOCKED' },
      );
    }
    if (wire.model !== 'gpt-6-luna') {
      throw new OpenAiPolicyError(
        `/v1/decisions requires model === "gpt-6-luna" (got "${String(wire.model)}").`,
        { code: 'DECISIONS_MODEL_MUST_BE_LUNA' },
      );
    }

    const { aliasToEntry, questionEntries, normalizedQuestions } = validateDecisionQuestions(wire.questions);
    const { normalizedInput, imageTokens } = validateAndNormalizeDecisionInput(wire.input);
    defineSafeProp(wire, 'input', normalizedInput);
    defineSafeProp(wire, 'questions', normalizedQuestions);

    if (wire.prompt_cache_key !== undefined && (typeof wire.prompt_cache_key !== 'string' || !wire.prompt_cache_key.trim())) {
      throw new OpenAiValidationError('prompt_cache_key must be a nonempty string when provided.');
    }
    if (wire.prompt_cache_options !== undefined) {
      requirePlainObject(wire.prompt_cache_options, 'prompt_cache_options');
    }
    if (wire.max_output_tokens !== undefined && (!Number.isSafeInteger(wire.max_output_tokens) || wire.max_output_tokens < 1)) {
      throw new OpenAiValidationError('max_output_tokens must be a positive safe integer when provided.');
    }
    if (eff.maxOutputTokens !== undefined && (!Number.isSafeInteger(eff.maxOutputTokens) || eff.maxOutputTokens < 1)) {
      throw new OpenAiValidationError('policy.maxOutputTokens must be a positive safe integer when provided.');
    }

    // OpenAI /v1/decisions returns typed probabilities/choices (not free-form prose) and rejects
    // top-level max_output_tokens on the wire; strip any local hint while keeping conservative reservation sizing.
    const localOutputTokenBound = wire.max_output_tokens ?? Math.max(
      eff.maxOutputTokens ?? 0,
      normalizedQuestions.length * DECISION_OUTPUT_TOKENS_PER_QUESTION,
    );
    delete wire.max_output_tokens;

    assertCleanOutgoingPayload(wire, 'decisions_request');

    const serializedWire = JSON.stringify(wire);
    const payloadSha256 = computeRequestPayloadSha256('/v1/decisions', serializedWire);
    const logicalRequestId = eff.logicalRequestId ?? params.logical_request_id ?? params.logicalRequestId ?? `dec-${generatePiiSafeUuid()}`;
    const packetSha256 = eff.packetSha256 ?? params.packet_sha256 ?? params.packetSha256 ?? null;

    const totalWireTextBytes = computeWireJsonUtf8BytesWithoutImageBase64(wire);
    const inferredInputTokens = safeMicrosToNumber(
      BigInt(Math.max(1, totalWireTextBytes)) + BigInt(imageTokens),
    );
    const estInputTokens = Number.isSafeInteger(eff.estimatedInputTokens) && eff.estimatedInputTokens >= 0
      ? Math.max(inferredInputTokens, eff.estimatedInputTokens)
      : inferredInputTokens;
    const estMaxOutputTokens = Math.max(
      eff.maxOutputTokens ?? 0,
      localOutputTokenBound,
      normalizedQuestions.length * DECISION_OUTPUT_TOKENS_PER_QUESTION,
    );

    estimateReservationCents({
      endpoint: '/v1/decisions',
      model: 'gpt-6-luna',
      serviceTier: tierInfo.reservationTier,
      estimatedInputTokens: estInputTokens,
      maxOutputTokens: estMaxOutputTokens,
      allowAstraApi: false,
    });
    const reservedCents = 0;

    const ledger = this._requireBillableLedger(eff);
    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);

    const attempt = ledger.reserveBillableRequest({
      logicalRequestId,
      accountScope: eff.accountScope,
      monthUtc: eff.monthUtc,
      allowTestClockOverride: eff.allowTestClockOverride,
      endpoint: '/v1/decisions',
      model: 'gpt-6-luna',
      serviceTier: tierInfo.ledgerTier,
      origin: this.baseOrigin,
      apiBaseUrl: eff.baseUrl,
      payloadSha256,
      packetSha256,
      reservedCents,
      estimatedInputTokens: estInputTokens,
      maxOutputTokens: estMaxOutputTokens,
      maxWebSearchCalls: 0,
      credentialFingerprintSha256,
      isLiveTransport: eff.isLiveTransport,
    });

    let res;
    try {
      res = await eff.fetchImpl(`${eff.baseUrl}/v1/decisions`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: formatAuthHeader(apiKey),
          'Content-Type': 'application/json',
        },
        body: serializedWire,
        signal: requestSignal,
      });
    } catch (err) {
      const reason = `Transport error/timeout/redirect on POST /v1/decisions (${scrubTextForReceipt(err?.message || 'network_error', apiKey)}); maxRetries=0.`;
      ledger.markPendingRecovery(attempt.attempt_id, { reason });
      throw new OpenAiAmbiguousOutcomeError(reason, {
        attemptId: attempt.attempt_id,
        logicalRequestId: attempt.logical_request_id,
        reservedCents: attempt.reserved_cents,
      });
    }

    try {
      const { okJson, body, sanitizedBody, rawBytes, originalBodySha256, scrubbedRawText, scrubbedRawSha256 } =
        await this._readJsonResponseSafe(res, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
          requireStreamingOrContentLength: eff.isLiveTransport,
        }).catch(err => {
          const reason = `Body stream error on POST /v1/decisions (${scrubTextForReceipt(err?.message || 'stream_error', apiKey)}).`;
          ledger.markPendingRecovery(attempt.attempt_id, { httpStatus: res.status, reason });
          throw new OpenAiAmbiguousOutcomeError(reason, {
            attemptId: attempt.attempt_id,
            logicalRequestId: attempt.logical_request_id,
            httpStatus: res.status,
            reservedCents: attempt.reserved_cents,
          });
        });

      if (rawBytes && rawBytes.length > 0) {
        ledger.savePrivatePayload(attempt.attempt_id, 'decision_post', rawBytes, { literalSecret: apiKey });
      }

      const providerId = extractSafeProviderId(body?.id, apiKey);
      const rawErrOrTopUsage = sanitizedBody?.usage ?? sanitizedBody?.error?.usage ?? null;
      let provisionalMicros = null;
      if (rawErrOrTopUsage && typeof rawErrOrTopUsage === 'object') {
        try {
          provisionalMicros = computeUsageCostMicros({
            model: 'gpt-6-luna',
            serviceTier: sanitizedBody?.service_tier || tierInfo.reservationTier || 'standard',
            usage: rawErrOrTopUsage,
            allowAstraApi: false,
          });
        } catch {
          provisionalMicros = null;
        }
      }

      if (isAmbiguousHttpStatus(res.status)) {
        const reason = `Ambiguous HTTP ${res.status} on POST /v1/decisions; retaining reservation and fencing account.`;
        ledger.markPendingRecovery(attempt.attempt_id, {
          providerResponseId: providerId,
          httpStatus: res.status,
          provisionalUsage: rawErrOrTopUsage,
          provisionalUsageCostMicros: provisionalMicros,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          providerResponseId: providerId,
          httpStatus: res.status,
          reservedCents: attempt.reserved_cents,
        });
      }

      if (res.status >= 400) {
        const errMsg = sanitizedBody?.error?.message ?? `OpenAI /v1/decisions rejected with HTTP ${res.status}.`;
        ledger.recordTerminalOutcome(attempt.attempt_id, {
          status: 'rejected',
          httpStatus: res.status,
          providerResponseId: providerId,
          usageCostMicros: provisionalMicros,
          usage: rawErrOrTopUsage,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          diagnosticReason: errMsg,
        });
        throw new OpenAiHttpError(errMsg, {
          httpStatus: res.status,
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          errorType: sanitizedBody?.error?.type ?? null,
          errorCode: sanitizedBody?.error?.code ?? null,
        });
      }

      if (!okJson || !sanitizedBody || typeof sanitizedBody !== 'object') {
        const reason = 'POST /v1/decisions returned HTTP 200 with corrupt/non-JSON body.';
        ledger.markPendingRecovery(attempt.attempt_id, {
          httpStatus: res.status,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          httpStatus: res.status,
          reservedCents: attempt.reserved_cents,
        });
      }

      // P1-12: Honor explicit provider status, error, and incomplete_details on /v1/decisions envelopes!
      const rawEnvelopeStatus = sanitizedBody.status !== undefined && sanitizedBody.status !== null
        ? String(sanitizedBody.status).trim()
        : 'completed';
      if (!KNOWN_DECISION_ENVELOPE_STATUSES.has(rawEnvelopeStatus)) {
        const reason = `POST /v1/decisions returned unrecognized envelope status "${sanitizeDiagnosticText(rawEnvelopeStatus)}"; holding in pending_recovery.`;
        ledger.markPendingRecovery(attempt.attempt_id, {
          providerResponseId: providerId,
          contentStatus: 'invalid',
          httpStatus: res.status,
          provisionalUsage: rawErrOrTopUsage,
          provisionalUsageCostMicros: provisionalMicros,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        return {
          ok: false,
          usable: false,
          status: 'pending_recovery',
          content_status: 'invalid',
          attempt_id: attempt.attempt_id,
          logical_request_id: attempt.logical_request_id,
          provider_response_id: providerId,
          model: sanitizedBody.model ?? 'gpt-6-luna',
          decisions: [],
          by_question_id: Object.create(null),
          refusal_count: 0,
          usage: rawErrOrTopUsage,
          provisional_usage_cost_micros: provisionalMicros,
          usage_cost_micros: null,
          reserved_cents: attempt.reserved_cents,
          raw_response: sanitizedBody,
        };
      }

      if (rawEnvelopeStatus === 'in_progress' || rawEnvelopeStatus === 'queued') {
        const reason = `POST /v1/decisions returned non-terminal status "${rawEnvelopeStatus}"; holding in pending_recovery.`;
        ledger.markPendingRecovery(attempt.attempt_id, {
          providerResponseId: providerId,
          httpStatus: res.status,
          provisionalUsage: rawErrOrTopUsage,
          provisionalUsageCostMicros: provisionalMicros,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        return {
          ok: false,
          usable: false,
          status: 'pending_recovery',
          content_status: null,
          attempt_id: attempt.attempt_id,
          logical_request_id: attempt.logical_request_id,
          provider_response_id: providerId,
          model: sanitizedBody.model ?? 'gpt-6-luna',
          decisions: [],
          by_question_id: Object.create(null),
          refusal_count: 0,
          usage: rawErrOrTopUsage,
          provisional_usage_cost_micros: provisionalMicros,
          usage_cost_micros: null,
          reserved_cents: attempt.reserved_cents,
          raw_response: sanitizedBody,
        };
      }

      const hasTopLevelError = sanitizedBody.error !== undefined && sanitizedBody.error !== null;
      const hasTopLevelIncomplete =
        rawEnvelopeStatus === 'incomplete' ||
        (sanitizedBody.incomplete_details !== undefined && sanitizedBody.incomplete_details !== null);
      const isEnvelopeFailedOrCancelled =
        rawEnvelopeStatus === 'failed' || rawEnvelopeStatus === 'cancelled' || hasTopLevelError;

      const rawItems = Array.isArray(sanitizedBody.decisions)
        ? sanitizedBody.decisions
        : (Array.isArray(sanitizedBody.answers)
          ? sanitizedBody.answers
          : (Array.isArray(sanitizedBody.output) ? sanitizedBody.output : []));

      let refusalCount = 0;
      let mappingInvalidReason = null;
      const seenCanonicalIds = new Set();
      let byQuestionId = Object.create(null);
      let decisions = [];

      if (!isEnvelopeFailedOrCancelled && !hasTopLevelIncomplete) {
        for (let idx = 0; idx < rawItems.length; idx++) {
          const item = rawItems[idx];
          if (!item || typeof item !== 'object') {
            mappingInvalidReason = `Decision answer[${idx}] is not an object.`;
            break;
          }
          const itemAliases = [item.id, item.question_id, item.name]
            .filter(v => typeof v === 'string' && v.trim().length > 0)
            .map(v => v.trim());
          if (itemAliases.length === 0) {
            mappingInvalidReason = `Decision answer[${idx}] is missing explicit id/question_id/name.`;
            break;
          }

          let matchedEntry = null;
          for (const alias of itemAliases) {
            if (!Object.hasOwn(aliasToEntry, alias)) {
              mappingInvalidReason = `Decision response contained foreign question identifier "${sanitizeDiagnosticText(alias)}".`;
              break;
            }
            const candidateEntry = aliasToEntry[alias];
            if (matchedEntry && matchedEntry.canonicalId !== candidateEntry.canonicalId) {
              mappingInvalidReason = `Decision answer[${idx}] carried conflicting question identifiers.`;
              break;
            }
            matchedEntry = candidateEntry;
          }
          if (mappingInvalidReason || !matchedEntry) break;

          if (seenCanonicalIds.has(matchedEntry.canonicalId)) {
            mappingInvalidReason = `Decision response contained duplicate answer for question "${matchedEntry.canonicalId}".`;
            break;
          }
          seenCanonicalIds.add(matchedEntry.canonicalId);

          const isRefusal = item.type === 'refusal' || item.status === 'refused' ||
            (typeof item.refusal === 'string' && item.refusal.length > 0);
          const normalizedDecision = cloneSafeMapRecord(item);
          defineSafeProp(normalizedDecision, 'id', matchedEntry.canonicalId);
          defineSafeProp(normalizedDecision, 'name', matchedEntry.canonicalName);
          if (isRefusal) {
            refusalCount++;
            defineSafeProp(normalizedDecision, 'type', 'refusal');
            defineSafeProp(
              normalizedDecision,
              'refusal',
              scrubTextForReceipt(item.refusal ?? item.reason ?? 'Question refused by model.', apiKey),
            );
          } else {
            const ansErr = validateDecisionAnswerAgainstQuestion(item, matchedEntry);
            if (ansErr) {
              mappingInvalidReason = ansErr;
              break;
            }
          }

          decisions.push(normalizedDecision);
          defineSafeProp(byQuestionId, matchedEntry.canonicalId, normalizedDecision);
          if (matchedEntry.canonicalName !== matchedEntry.canonicalId) {
            defineSafeProp(byQuestionId, matchedEntry.canonicalName, normalizedDecision);
          }
        }

        if (!mappingInvalidReason && seenCanonicalIds.size !== questionEntries.length) {
          mappingInvalidReason = `Decision response answered ${seenCanonicalIds.size} of ${questionEntries.length} requested questions.`;
        }
      }

      let modelMismatchReason = null;
      if (typeof sanitizedBody.model === 'string' && sanitizedBody.model.trim()) {
        try {
          const retSpec = resolveModelPricing(sanitizedBody.model, { allowAstraApi: true, endpoint: '/v1/decisions' });
          if (retSpec.canonicalModel !== 'gpt-6-luna') {
            modelMismatchReason = `Decision response returned unexpected model "${sanitizedBody.model}".`;
          }
        } catch {
          modelMismatchReason = `Decision response returned unpriced model "${sanitizedBody.model}".`;
        }
      } else {
        modelMismatchReason = 'Decision response omitted model identifier.';
      }

      let usageCostMicros = null;
      let decisionUsageWarning = null;
      if (rawErrOrTopUsage && typeof rawErrOrTopUsage === 'object' && !modelMismatchReason) {
        try {
          usageCostMicros = computeUsageCostMicros({
            model: 'gpt-6-luna',
            serviceTier: sanitizedBody.service_tier || tierInfo.reservationTier || 'standard',
            usage: rawErrOrTopUsage,
            allowAstraApi: false,
          });
        } catch (uErr) {
          usageCostMicros = null;
          decisionUsageWarning = scrubTextForReceipt(uErr?.message || 'Malformed usage object.', apiKey);
        }
      }

      let contentStatus;
      if (isEnvelopeFailedOrCancelled || mappingInvalidReason || modelMismatchReason) {
        contentStatus = 'invalid';
        decisions = [];
        byQuestionId = Object.create(null);
      } else if (hasTopLevelIncomplete) {
        contentStatus = 'incomplete';
        decisions = [];
        byQuestionId = Object.create(null);
      } else if (decisions.length > 0 && refusalCount === decisions.length) {
        contentStatus = 'refused';
      } else {
        contentStatus = 'usable';
      }

      let ledgerStatus;
      if (usageCostMicros === null) {
        ledgerStatus = 'pending_recovery';
      } else if (isEnvelopeFailedOrCancelled) {
        ledgerStatus = usageCostMicros > 0 ? 'failed_known' : 'pending_recovery';
      } else {
        ledgerStatus = 'completed';
      }

      const diagReason = ledgerStatus === 'pending_recovery'
        ? (modelMismatchReason || decisionUsageWarning || sanitizedBody.error?.message || 'Unverified or zero-token failed /v1/decisions response; retaining hold.')
        : (sanitizedBody.error?.message || mappingInvalidReason || modelMismatchReason || (hasTopLevelIncomplete ? 'Incomplete /v1/decisions response.' : null));

      ledger.recordTerminalOutcome(attempt.attempt_id, {
        status: ledgerStatus,
        contentStatus,
        usageCostMicros: ledgerStatus === 'pending_recovery' ? null : usageCostMicros,
        usage: ledgerStatus === 'pending_recovery' ? null : (rawErrOrTopUsage ?? null),
        provisionalUsage: ledgerStatus === 'pending_recovery' ? rawErrOrTopUsage : null,
        provisionalUsageCostMicros: ledgerStatus === 'pending_recovery' ? (usageCostMicros ?? provisionalMicros) : null,
        providerResponseId: providerId,
        providerModel: sanitizedBody.model ?? 'gpt-6-luna',
        httpStatus: res.status,
        rawReceipt: sanitizedBody,
        originalBodySha256,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        diagnosticReason: diagReason,
      });

      const isUsable = ledgerStatus === 'completed' && contentStatus === 'usable';
      return {
        ok: isUsable,
        usable: isUsable,
        status: ledgerStatus,
        content_status: contentStatus,
        attempt_id: attempt.attempt_id,
        logical_request_id: attempt.logical_request_id,
        provider_response_id: providerId,
        model: sanitizedBody.model ?? 'gpt-6-luna',
        decisions,
        by_question_id: byQuestionId,
        refusal_count: refusalCount,
        usage: rawErrOrTopUsage ?? null,
        usage_cost_micros: ledgerStatus === 'pending_recovery' ? null : usageCostMicros,
        reserved_cents: attempt.reserved_cents,
        raw_response: sanitizedBody,
      };
    } catch (err) {
      this._handlePostDispatchUnexpectedError(err, ledger, attempt, apiKey, res?.status ?? null);
    }
  }

  /**
   * POST /v1/responses — Defaults to `gpt-6.1-terra`, `reasoning: { effort: 'xhigh' }`,
   * `max_output_tokens: 24576`. Blocks Astra, forbids `stream`, enforces `web_search` `1..5` allowlist,
   * and keeps `pending_recovery` when `deleteAfterPersist` is requested until `DELETE 200` + `GET 404` complete.
   */
  async createResponse(rawParams, policy = {}) {
    const eff = this._resolveEffectivePolicy(policy);
    const backgroundOptions = validateBackgroundOptions(policy ?? {}, this.defaultPollIntervalMs);

    const {
      wire,
      canonicalModel,
      inferredInputTokens,
      maxWebSearchCalls,
      storeMode,
      expectsJsonObject,
      jsonSchema,
      responseFormat,
      tierInfo,
      lockedLogicalRequestId,
    } = validateAndNormalizeResponsesBody(rawParams, {
      allowAstraApi: eff.allowAstraApi,
      deleteAfterPersist: eff.deleteAfterPersist,
      background: eff.background,
      uncappedWebSearchReservationCalls: eff.uncappedWebSearchReservationCalls,
    });
    const backgroundMode = wire.background === true;

    const params = snapshotPlainValue(rawParams, 'Responses params');
    const callerSuppliedLogicalId = eff.logicalRequestId ?? params.logical_request_id ?? params.logicalRequestId ?? null;
    if (lockedLogicalRequestId !== null && callerSuppliedLogicalId !== null && callerSuppliedLogicalId !== lockedLogicalRequestId) {
      throw new OpenAiPolicyError(
        `logicalRequestId ("${callerSuppliedLogicalId}") cannot override locked review logical_request_id ("${lockedLogicalRequestId}").`,
        { code: 'LOCKED_LOGICAL_REQUEST_ID_MISMATCH', notDispatched: true },
      );
    }

    const serializedWire = JSON.stringify(wire);
    const payloadSha256 = computeRequestPayloadSha256('/v1/responses', serializedWire);
    const logicalRequestId = lockedLogicalRequestId ?? callerSuppliedLogicalId ?? `resp-req-${generatePiiSafeUuid()}`;
    const packetSha256 = eff.packetSha256 ?? params.packet_sha256 ?? params.packetSha256 ?? null;

    const estInputTokens = Number.isSafeInteger(eff.estimatedInputTokens) && eff.estimatedInputTokens >= 0
      ? Math.max(inferredInputTokens, eff.estimatedInputTokens)
      : inferredInputTokens;

    estimateReservationCents({
      endpoint: '/v1/responses',
      model: wire.model,
      serviceTier: tierInfo.reservationTier,
      estimatedInputTokens: estInputTokens,
      maxOutputTokens: wire.max_output_tokens,
      maxWebSearchCalls,
      allowAstraApi: eff.allowAstraApi,
    });
    const reservedCents = 0;

    const ledger = this._requireBillableLedger(eff);
    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);
    if (backgroundMode) await this._preflightBackgroundProgress(backgroundOptions, eff);
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);

    const attempt = ledger.reserveBillableRequest({
      logicalRequestId,
      accountScope: eff.accountScope,
      monthUtc: eff.monthUtc,
      allowTestClockOverride: eff.allowTestClockOverride,
      endpoint: '/v1/responses',
      model: wire.model,
      serviceTier: tierInfo.ledgerTier,
      origin: this.baseOrigin,
      apiBaseUrl: eff.baseUrl,
      storeMode,
      backgroundMode,
      payloadSha256,
      packetSha256,
      reservedCents,
      estimatedInputTokens: estInputTokens,
      maxOutputTokens: wire.max_output_tokens,
      maxWebSearchCalls,
      cleanupRequired: eff.deleteAfterPersist,
      responseFormat,
      lockedLogicalIds: lockedLogicalRequestId ? [lockedLogicalRequestId] : null,
      credentialFingerprintSha256,
      isLiveTransport: eff.isLiveTransport,
    });

    let res;
    try {
      res = await eff.fetchImpl(`${eff.baseUrl}/v1/responses`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: formatAuthHeader(apiKey),
          'Content-Type': 'application/json',
        },
        body: serializedWire,
        signal: requestSignal,
      });
    } catch (err) {
      const reason = `Transport error/timeout/redirect on POST /v1/responses (${scrubTextForReceipt(err?.message || 'network_error', apiKey)}); maxRetries=0.`;
      ledger.markPendingRecovery(attempt.attempt_id, { reason });
      throw new OpenAiAmbiguousOutcomeError(reason, {
        attemptId: attempt.attempt_id,
        logicalRequestId: attempt.logical_request_id,
        reservedCents: attempt.reserved_cents,
      });
    }

    try {
      const { okJson, body, sanitizedBody, rawBytes, originalBodySha256, scrubbedRawText, scrubbedRawSha256 } =
        await this._readJsonResponseSafe(res, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
          requireStreamingOrContentLength: eff.isLiveTransport,
        }).catch(err => {
          const reason = `Body stream error on POST /v1/responses (${scrubTextForReceipt(err?.message || 'stream_error', apiKey)}).`;
          ledger.markPendingRecovery(attempt.attempt_id, { httpStatus: res.status, reason });
          throw new OpenAiAmbiguousOutcomeError(reason, {
            attemptId: attempt.attempt_id,
            logicalRequestId: attempt.logical_request_id,
            httpStatus: res.status,
            reservedCents: attempt.reserved_cents,
          });
        });

      const providerResponseId = extractSafeProviderId(body?.id, apiKey);
      const activeBackground = backgroundMode && res.status >= 200 && res.status < 300 &&
        providerResponseId && isActiveResponseStatus(body?.status);
      const boundAttempt = activeBackground
        ? ledger.recordBackgroundResponseId({
          attemptId: attempt.attempt_id,
          providerResponseId,
          accountScope: eff.accountScope,
          ...this._backgroundCostFloors(sanitizedBody, wire.model, tierInfo.ledgerTier),
        })
        : attempt;

      if (rawBytes && rawBytes.length > 0) {
        ledger.savePrivatePayload(attempt.attempt_id, 'response_post', rawBytes, { literalSecret: apiKey });
      }

      if (isAmbiguousHttpStatus(res.status)) {
        const provisional = this._computeProvisionalResponsesUsage(sanitizedBody, wire.model, tierInfo.ledgerTier);
        const reason = `Ambiguous HTTP ${res.status} on POST /v1/responses; retaining reservation and fencing account.`;
        ledger.markPendingRecovery(attempt.attempt_id, {
          providerResponseId,
          httpStatus: res.status,
          provisionalUsage: provisional.usage,
          provisionalUsageCostMicros: provisional.micros,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          providerResponseId,
          httpStatus: res.status,
          reservedCents: attempt.reserved_cents,
        });
      }

      if (res.status >= 400) {
        const errMsg = sanitizedBody?.error?.message ?? `OpenAI /v1/responses rejected with HTTP ${res.status}.`;
        const { calls: errWebSearchCalls, uncertain: errWsUsageUncertain } = inspectWebSearchUsage(sanitizedBody);
        let usageMicros = null;
        const errUsageObj = sanitizedBody?.usage ?? sanitizedBody?.error?.usage ?? null;
        if (errUsageObj && typeof errUsageObj === 'object' && !errWsUsageUncertain) {
          try {
            usageMicros = computeUsageCostMicros({
              model: sanitizedBody.model || wire.model,
              serviceTier: sanitizedBody.service_tier || tierInfo.reservationTier || 'standard',
              usage: errUsageObj,
              webSearchCalls: errWebSearchCalls,
              allowAstraApi: true,
            });
          } catch {
            usageMicros = null;
          }
        }
        if (errWsUsageUncertain || (errWebSearchCalls > 0 && usageMicros === null)) {
          const provMicros = errWebSearchCalls > 0
            ? safeMicrosToNumber(BigInt(errWebSearchCalls) * BigInt(WEB_SEARCH_CALL_MICROS))
            : null;
          const holdMsg = errWsUsageUncertain
            ? `POST /v1/responses returned HTTP ${res.status} with unrecognized web search actions; holding until billing is verified.`
            : `POST /v1/responses returned HTTP ${res.status} with ${errWebSearchCalls} web_search call(s) and incomplete token usage; holding in pending_recovery.`;
          ledger.markPendingRecovery(attempt.attempt_id, {
            providerResponseId,
            httpStatus: res.status,
            provisionalUsage: { web_search_calls: errWebSearchCalls },
            provisionalUsageCostMicros: provMicros,
            rawReceipt: sanitizedBody,
            originalBodySha256,
            rawBodyText: scrubbedRawText,
            rawBodySha256: scrubbedRawSha256,
            reason: holdMsg,
          });
          throw new OpenAiAmbiguousOutcomeError(holdMsg, {
            attemptId: attempt.attempt_id,
            logicalRequestId: attempt.logical_request_id,
            providerResponseId,
            httpStatus: res.status,
            reservedCents: attempt.reserved_cents,
          });
        }
        ledger.recordTerminalOutcome(attempt.attempt_id, {
          status: 'rejected',
          httpStatus: res.status,
          providerResponseId,
          usageCostMicros: usageMicros,
          usage: errUsageObj,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          diagnosticReason: errMsg,
        });
        throw new OpenAiHttpError(errMsg, {
          httpStatus: res.status,
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          errorType: sanitizedBody?.error?.type ?? null,
          errorCode: sanitizedBody?.error?.code ?? null,
        });
      }

      if (!okJson || !sanitizedBody || typeof sanitizedBody !== 'object') {
        const reason = 'POST /v1/responses returned HTTP 200 with corrupt/non-JSON body.';
        ledger.markPendingRecovery(attempt.attempt_id, {
          httpStatus: res.status,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          httpStatus: res.status,
          reservedCents: attempt.reserved_cents,
        });
      }

      const emitProgress = backgroundMode
        ? this._createBackgroundProgress({ ...boundAttempt, provider_response_id: providerResponseId }, backgroundOptions, apiKey)
        : null;
      if (activeBackground) {
        return await withBackgroundProgressResult(emitProgress, async () => {
          await emitProgress(sanitizedBody.status, 0, sanitizedBody);
          if (!backgroundOptions.waitForCompletion) return this._backgroundActiveEnvelope(boundAttempt, sanitizedBody);
          return this._pollBoundBackgroundResponse(
            boundAttempt, eff, apiKey, backgroundOptions, emitProgress, sanitizedBody,
          );
        });
      }

      const envelope = await this._settleResponsesPayload(attempt, sanitizedBody, {
        rawParsedBody: body,
        eff,
        apiKey,
        canonicalModel,
        requestedModel: wire.model,
        requestedServiceTier: tierInfo.ledgerTier,
        expectsJsonObject,
        jsonSchema,
        expectedResponseId: null,
        httpStatus: res.status,
        originalBodySha256,
        scrubbedRawText,
        scrubbedRawSha256,
      });
      if (emitProgress) {
        const status = KNOWN_RESPONSE_STATUSES.has(envelope.response_status) ? envelope.response_status : envelope.status;
        await emitProgress(status, 0, sanitizedBody);
        if (emitProgress.progressError) return { ...envelope, progress_error: emitProgress.progressError };
      }
      return envelope;
    } catch (err) {
      this._handlePostDispatchUnexpectedError(err, ledger, attempt, apiKey, res?.status ?? null);
    }
  }

  async _preflightBackgroundProgress(options, eff, attemptId = null) {
    const file = options.progressFile;
    if (!file) return;
    const sqliteFiles = [eff.ledger.dbPath, eff.ledger._effectiveRegistryPath]
      .filter(path => path && path !== ':memory:');
    const protectedPaths = [
      ...sqliteFiles.flatMap(path => ['', '-wal', '-shm', '-journal'].map(suffix => path + suffix)),
      eff.credentialFile ? String(eff.credentialFile).trim() : null,
    ];
    if (protectedPaths.some(path => path && areSamePhysicalSqliteFile(file, path))) {
      throw new OpenAiValidationError('progressFile conflicts with a credential, ledger, registry, or SQLite sidecar.', {
        code: 'BACKGROUND_PROGRESS_FILE_CONFLICT',
      });
    }
    await preflightBackgroundProgressFile(file, attemptId);
  }

  _createBackgroundProgress(attempt, options, apiKey) {
    return createBackgroundProgress(
      {
        ...attempt,
        logical_request_id: scrubTextForReceipt(attempt.logical_request_id, apiKey),
        model: scrubTextForReceipt(attempt.model, apiKey),
      },
      options,
      this._nowFn,
    );
  }

  _backgroundActiveEnvelope(attempt, response = null) {
    const rawResponse = response ?? attempt.raw_receipt ?? null;
    const extracted = extractResponsesContent(rawResponse, {
      expectsJsonObject: ['json_object', 'json_schema'].includes(attempt.response_format?.type),
      jsonSchema: attempt.response_format?.schema ?? null,
    });
    const settled = isSettledResponseAttempt(attempt);
    const hasTerminalReceipt = settled || hasPersistedBackgroundTerminal(attempt);
    const usable = settled && attempt.status === 'completed' && attempt.content_status === 'usable';
    return {
      ok: usable,
      usable,
      status: attempt.status,
      response_status: rawResponse?.status ?? (settled ? attempt.status : 'in_progress'),
      content_status: attempt.content_status ?? null,
      attempt_id: attempt.attempt_id,
      logical_request_id: attempt.logical_request_id,
      provider_response_id: attempt.provider_response_id,
      model: attempt.provider_model ?? attempt.model,
      output: hasTerminalReceipt ? rawResponse?.output ?? [] : [],
      output_text: hasTerminalReceipt ? extracted.outputText : '',
      refusal: hasTerminalReceipt ? extracted.refusal : null,
      refusals: hasTerminalReceipt ? extracted.refusals : [],
      incomplete_details: rawResponse?.incomplete_details ?? null,
      web_search_calls: attempt.usage?.web_search_calls ?? extracted.webSearchCalls,
      usage: attempt.usage ?? null,
      usage_cost_micros: attempt.usage_cost_micros ?? null,
      reserved_cents: attempt.reserved_cents,
      cleanup: {
        requested: attempt.cleanup_required === true,
        status: attempt.cleanup_status ?? 'not_requested',
        verified_404: attempt.cleanup_status === 'deleted_verified_404',
      },
      raw_response: rawResponse,
      ...(settled ? { already_settled: true } : {}),
    };
  }

  _getBoundBackgroundAttempt(selector, eff, fingerprint, { allowProviderId = false } = {}) {
    const ledger = this._requireBillableLedger(eff);
    const scope = { accountScope: eff.accountScope };
    const attempt = eff.attemptId
      ? ledger.getAttemptById(eff.attemptId, scope)
      : (ledger.getAttemptById(selector, scope) ??
        (allowProviderId && selector ? ledger.getAttemptByProviderResponseId(selector, scope) : null));
    if (!attempt || (eff.attemptId && selector && selector !== attempt.attempt_id && selector !== attempt.provider_response_id)) {
      throw new OpenAiBudgetError('No matching locally bound background attempt was found.', { code: 'ATTEMPT_NOT_FOUND' });
    }
    if (attempt.endpoint !== '/v1/responses' || attempt.background_mode !== true ||
      attempt.store_mode !== 1 || !attempt.provider_response_id) {
      throw new OpenAiPolicyError('Background operations require a stored Responses attempt with a verified response ID.', {
        code: 'BACKGROUND_RESPONSE_ID_REQUIRED',
      });
    }
    if (extractSafeProviderId(attempt.provider_response_id) !== attempt.provider_response_id) {
      throw new OpenAiPolicyError('The stored background response ID is invalid.', { code: 'BACKGROUND_RESPONSE_ID_REQUIRED' });
    }
    this._assertBoundAttemptConnection(attempt, eff, fingerprint);
    return attempt;
  }

  _holdBackgroundAttempt(attempt, eff, reason, httpStatus = null, code = 'PENDING_RECOVERY') {
    const current = eff.ledger.getAttemptById(attempt.attempt_id);
    if (isSettledResponseAttempt(current) || hasPersistedBackgroundTerminal(current)) {
      return this._backgroundActiveEnvelope(current);
    }
    try {
      eff.ledger.markPendingRecovery(attempt.attempt_id, { httpStatus, reason });
    } catch (err) {
      const refreshed = eff.ledger.getAttemptById(attempt.attempt_id);
      if (err?.code === 'INVALID_STATE_TRANSITION' &&
        (isSettledResponseAttempt(refreshed) || hasPersistedBackgroundTerminal(refreshed))) {
        return this._backgroundActiveEnvelope(refreshed);
      }
      throw err;
    }
    throw new OpenAiAmbiguousOutcomeError(reason, {
      code,
      attemptId: attempt.attempt_id,
      logicalRequestId: attempt.logical_request_id,
      providerResponseId: attempt.provider_response_id,
      httpStatus,
      reservedCents: attempt.reserved_cents,
    });
  }

  async _settleBoundResponse(attempt, receipt, eff, apiKey) {
    const current = eff.ledger.getAttemptById(attempt.attempt_id);
    if (isSettledResponseAttempt(current)) return this._backgroundActiveEnvelope(current);
    if (hasPersistedBackgroundTerminal(current)) return this._resumeBackgroundCleanup(current, eff, apiKey);
    try {
      return await this._settleResponsesPayload(current, receipt.response, {
        eff,
        apiKey,
        requestedModel: current.model,
        requestedServiceTier: current.service_tier,
        expectsJsonObject: ['json_object', 'json_schema'].includes(current.response_format?.type),
        jsonSchema: current.response_format?.schema ?? null,
        expectedResponseId: current.provider_response_id,
        httpStatus: receipt.http_status,
        originalBodySha256: receipt.original_body_sha256,
        scrubbedRawText: receipt.scrubbed_raw_text,
        scrubbedRawSha256: receipt.scrubbed_raw_sha256,
      });
    } catch (err) {
      const refreshed = eff.ledger.getAttemptById(attempt.attempt_id);
      if (err?.code === 'INVALID_STATE_TRANSITION') {
        if (isSettledResponseAttempt(refreshed)) return this._backgroundActiveEnvelope(refreshed);
        if (hasPersistedBackgroundTerminal(refreshed)) return this._resumeBackgroundCleanup(refreshed, eff, apiKey);
      }
      throw err;
    }
  }

  async _resumeBackgroundCleanup(attempt, eff, apiKey) {
    if (attempt.background_delete_dispatched_at && !attempt.delete_ack_at) {
      return this._backgroundActiveEnvelope(attempt);
    }
    try {
      await this.deleteResponse(attempt.provider_response_id, { ...eff, attemptId: attempt.attempt_id });
    } catch (err) {
      if (err?.code !== 'BACKGROUND_DELETE_OUTCOME_UNKNOWN') {
        eff.ledger.updateCleanupStatus(attempt.attempt_id, {
          cleanupStatus: 'delete_failed',
          diagnosticReason: `Cleanup error after receipt persistence: ${scrubTextForReceipt(err?.message || 'delete_error', apiKey)}`,
        });
      }
    }
    return this._backgroundActiveEnvelope(eff.ledger.getAttemptById(attempt.attempt_id));
  }

  async _pollBoundBackgroundResponse(attempt, eff, apiKey, options, emitProgress, lastResponse = null) {
    let pollCount = 0;
    let consecutiveErrors = 0;
    let lastStatus = isActiveResponseStatus(lastResponse?.status) ? lastResponse.status : 'in_progress';
    // The wait window applies after the POST acknowledgment has bound the provider ID.
    const deadline = options.maxWaitMs === null ? null : performance.now() + options.maxWaitMs;
    const remainingMs = () => deadline === null ? null : deadline - performance.now();
    const detach = () => {
      const current = eff.ledger.getAttemptById(attempt.attempt_id);
      if (isSettledResponseAttempt(current) || hasPersistedBackgroundTerminal(current)) {
        return this._backgroundActiveEnvelope(current);
      }
      return { ...this._backgroundActiveEnvelope(current, lastResponse), local_wait_timed_out: true };
    };
    while (true) {
      const delayBudget = remainingMs();
      if (delayBudget !== null && delayBudget <= 0) return detach();
      let getRes;
      try {
        const delayOutcome = await delayBackgroundPoll(options.pollIntervalMs, consecutiveErrors, eff.signal, delayBudget);
        const getBudget = remainingMs();
        if (delayOutcome?.truncatedByDeadline || (getBudget !== null && getBudget <= 0)) return detach();
        const current = eff.ledger.getAttemptById(attempt.attempt_id);
        if (isSettledResponseAttempt(current)) {
          const envelope = this._backgroundActiveEnvelope(current);
          await emitProgress(envelope.response_status, pollCount, envelope.raw_response);
          return envelope;
        }
        if (hasPersistedBackgroundTerminal(current)) {
          const envelope = await this._resumeBackgroundCleanup(current, eff, apiKey);
          await emitProgress(envelope.response_status, pollCount, envelope.raw_response);
          return envelope;
        }
        pollCount++;
        getRes = await getBackgroundResponseWithinWait(signal => this.retrieveResponse(attempt.provider_response_id, {
          ...eff,
          attemptId: attempt.attempt_id,
          signal,
        }), eff.signal, getBudget);
        if (getRes === null) return detach();
      } catch (err) {
        consecutiveErrors++;
        if (eff.signal?.aborted || !isTransientBackgroundGetError(err) ||
          consecutiveErrors >= MAX_CONSECUTIVE_BACKGROUND_GET_ERRORS) {
          await emitProgress('pending_recovery', pollCount);
          const code = err instanceof OpenAiAmbiguousOutcomeError ? err.code : 'BACKGROUND_POLL_INTERRUPTED';
          return this._holdBackgroundAttempt(
            attempt,
            eff,
            'Background GET polling stopped before verified settlement. The known response ID remains bound for recovery.',
            err?.http_status ?? null,
            code,
          );
        }
        await emitProgress(lastStatus, pollCount);
        continue;
      }

      const current = eff.ledger.getAttemptById(attempt.attempt_id);
      if (isSettledResponseAttempt(current)) {
        const envelope = this._backgroundActiveEnvelope(current);
        await emitProgress(envelope.response_status, pollCount, envelope.raw_response);
        return envelope;
      }
      if (hasPersistedBackgroundTerminal(current)) {
        const envelope = await this._resumeBackgroundCleanup(current, eff, apiKey);
        await emitProgress(envelope.response_status, pollCount, envelope.raw_response);
        return envelope;
      }
      if (!getRes.found) {
        const recovery = this._recoverResponse404(current, getRes, eff);
        await emitProgress(recovery.status, pollCount, recovery.attempt.raw_receipt);
        return this._backgroundActiveEnvelope(recovery.attempt);
      }
      consecutiveErrors = 0;
      lastStatus = getRes.response?.status;
      if (isActiveResponseStatus(lastStatus)) {
        lastResponse = getRes.response;
        await emitProgress(lastStatus, pollCount, getRes.response);
        if (!options.waitForCompletion) return this._backgroundActiveEnvelope(current, getRes.response);
        continue;
      }
      try {
        const envelope = await this._settleBoundResponse(current, getRes, eff, apiKey);
        const status = KNOWN_RESPONSE_STATUSES.has(envelope.response_status) ? envelope.response_status : envelope.status;
        await emitProgress(status, pollCount, envelope.raw_response);
        return envelope;
      } catch (err) {
        await emitProgress('pending_recovery', pollCount);
        return this._holdBackgroundAttempt(
          attempt, eff, 'Background response settlement failed. The known response ID remains bound for recovery.',
          getRes.http_status,
        );
      }
    }
  }

  async pollBackgroundResponse(attemptIdOrOptions, policy = {}) {
    const optionsArg = isPlainObject(attemptIdOrOptions) ? attemptIdOrOptions : policy;
    const eff = this._resolveEffectivePolicy(optionsArg);
    buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const options = validateBackgroundOptions(optionsArg ?? {}, this.defaultPollIntervalMs);
    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);
    const selector = typeof attemptIdOrOptions === 'string' ? attemptIdOrOptions : null;
    const attempt = this._getBoundBackgroundAttempt(selector, eff, credentialFingerprintSha256);
    await this._preflightBackgroundProgress(options, eff, attempt.attempt_id);
    const emitProgress = this._createBackgroundProgress(attempt, options, apiKey);
    const envelope = this._backgroundActiveEnvelope(attempt);
    const status = KNOWN_RESPONSE_STATUSES.has(envelope.response_status) ? envelope.response_status : envelope.status;
    return withBackgroundProgressResult(emitProgress, async () => {
      await emitProgress(status, 0, envelope.raw_response);
      if (isSettledResponseAttempt(attempt)) return envelope;
      return this._pollBoundBackgroundResponse(attempt, eff, apiKey, options, emitProgress, envelope.raw_response);
    });
  }

  async cancelResponse(attemptIdOrResponseId, policy = {}) {
    const optionsArg = isPlainObject(attemptIdOrResponseId) ? attemptIdOrResponseId : policy;
    const eff = this._resolveEffectivePolicy(optionsArg);
    const options = validateBackgroundOptions(optionsArg ?? {}, this.defaultPollIntervalMs);
    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);
    const selector = isPlainObject(attemptIdOrResponseId)
      ? optionsArg.responseId ?? optionsArg.providerResponseId ?? null
      : attemptIdOrResponseId;
    const attempt = this._getBoundBackgroundAttempt(selector, eff, credentialFingerprintSha256, {
      allowProviderId: true,
    });
    await this._preflightBackgroundProgress(options, eff, attempt.attempt_id);
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const emitProgress = this._createBackgroundProgress(attempt, options, apiKey);
    if (isSettledResponseAttempt(attempt) || hasPersistedBackgroundTerminal(attempt)) {
      const envelope = this._backgroundActiveEnvelope(attempt);
      await emitProgress(envelope.response_status, 0, envelope.raw_response);
      return emitProgress.progressError ? { ...envelope, progress_error: emitProgress.progressError } : envelope;
    }
    const responseId = attempt.provider_response_id;
    try {
      eff.ledger.recordBackgroundCancellationDispatch({
        attemptId: attempt.attempt_id,
        providerResponseId: responseId,
        accountScope: eff.accountScope,
      });
    } catch (err) {
      const current = eff.ledger.getAttemptById(attempt.attempt_id);
      if (err?.code !== 'INVALID_STATE_TRANSITION' ||
        (!isSettledResponseAttempt(current) && !hasPersistedBackgroundTerminal(current))) throw err;
      const envelope = this._backgroundActiveEnvelope(current);
      return withBackgroundProgressResult(emitProgress, async () => {
        await emitProgress(envelope.response_status, 0, envelope.raw_response);
        return envelope;
      });
    }
    let httpStatus = null;
    try {
      const res = await eff.fetchImpl(`${eff.baseUrl}/v1/responses/${encodeURIComponent(responseId)}/cancel`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: formatAuthHeader(apiKey) },
        signal: requestSignal,
      });
      httpStatus = res.status;
      const receipt = await this._readJsonResponseSafe(res, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
        requireStreamingOrContentLength: eff.isLiveTransport,
      });
      if (res.status >= 200 && res.status < 300 && receipt.okJson &&
        extractSafeProviderId(receipt.body?.id, apiKey) === responseId) {
        if (TERMINAL_RESPONSE_STATUSES.has(receipt.sanitizedBody.status) && receipt.rawBytes.length > 0) {
          eff.ledger.savePrivatePayload(attempt.attempt_id, 'response_cancel', receipt.rawBytes, { literalSecret: apiKey });
        }
        const envelope = await this._settleBoundResponse(attempt, {
          response: receipt.sanitizedBody,
          http_status: res.status,
          original_body_sha256: receipt.originalBodySha256,
          scrubbed_raw_text: receipt.scrubbedRawText,
          scrubbed_raw_sha256: receipt.scrubbedRawSha256,
        }, eff, apiKey);
        const status = KNOWN_RESPONSE_STATUSES.has(envelope.response_status) ? envelope.response_status : envelope.status;
        await emitProgress(status, 0, envelope.raw_response);
        return emitProgress.progressError ? { ...envelope, progress_error: emitProgress.progressError } : envelope;
      }
    } catch { /* The cancel POST may have reached the provider. Recover with GET only. */ }
    await emitProgress('pending_recovery', 0);
    return withBackgroundProgressResult(emitProgress, () => this._holdBackgroundAttempt(
      attempt,
      eff,
      'Background cancellation returned no verified outcome. The known response ID remains bound for GET recovery.',
      httpStatus,
      'BACKGROUND_CANCEL_OUTCOME_UNKNOWN',
    ));
  }

  _backgroundCostFloors(response, model, tier) {
    const { micros } = this._computeProvisionalResponsesUsage(response, model, tier, { boundedFloor: true });
    const searchFloorMicros = Math.min(Number.MAX_SAFE_INTEGER, extractWebSearchCallsFromOutput(response) * WEB_SEARCH_CALL_MICROS);
    return {
      usageFloorMicros: micros,
      searchFloorMicros,
      tokenFloorMicros: Math.max(0, (micros ?? 0) - searchFloorMicros),
    };
  }

  _computeProvisionalResponsesUsage(sanitizedBody, fallbackModel, fallbackTier = 'standard', { boundedFloor = false } = {}) {
    if (!sanitizedBody || typeof sanitizedBody !== 'object') {
      return { usage: null, micros: null };
    }
    const wsCalls = extractWebSearchCallsFromOutput(sanitizedBody);
    const usageObj = (sanitizedBody.usage && typeof sanitizedBody.usage === 'object')
      ? sanitizedBody.usage
      : ((sanitizedBody.error?.usage && typeof sanitizedBody.error.usage === 'object') ? sanitizedBody.error.usage : null);
    const modelStr = (typeof sanitizedBody.model === 'string' && sanitizedBody.model.trim())
      ? sanitizedBody.model.trim()
      : fallbackModel;
    const tierStr = sanitizedBody.service_tier || (fallbackTier === 'auto' ? 'standard' : fallbackTier) || 'standard';
    if (usageObj && modelStr) {
      try {
        const micros = computeUsageCostMicros({
          model: modelStr,
          serviceTier: tierStr,
          usage: usageObj,
          webSearchCalls: wsCalls,
          allowAstraApi: true,
        });
        return { usage: usageObj, micros };
      } catch (err) {
        if (boundedFloor && err?.code === 'COST_OVERFLOW_UNSAFE_INTEGER') {
          return { usage: usageObj, micros: Number.MAX_SAFE_INTEGER };
        }
        // Fall through to web_search floor if present.
      }
    }
    if (wsCalls > 0) {
      const searchMicros = BigInt(wsCalls) * BigInt(WEB_SEARCH_CALL_MICROS);
      return {
        usage: usageObj ?? { web_search_calls: wsCalls },
        micros: boundedFloor && searchMicros > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : safeMicrosToNumber(searchMicros),
      };
    }
    return { usage: usageObj, micros: null };
  }

  async _settleResponsesPayload(attempt, sanitizedBody, {
    rawParsedBody = null,
    eff,
    apiKey = null,
    canonicalModel = null,
    requestedModel,
    requestedServiceTier,
    expectsJsonObject = false,
    jsonSchema = null,
    expectedResponseId = null,
    httpStatus = 200,
    originalBodySha256 = null,
    scrubbedRawText = null,
    scrubbedRawSha256 = null,
  }) {
    const ledger = eff.ledger;
    const cleanupRequired = Boolean(attempt.cleanup_required === true || eff.deleteAfterPersist === true);
    const expectedCanonical = canonicalModel ?? resolveModelPricing(requestedModel, { allowAstraApi: true, endpoint: '/v1/responses' }).canonicalModel;

    const rawIdCandidate = rawParsedBody && typeof rawParsedBody === 'object' ? rawParsedBody.id : sanitizedBody.id;
    const returnedId = extractSafeProviderId(rawIdCandidate, apiKey);

    // P1: Verify expectedResponseId BEFORE attributing any provisional usage so foreign payloads never pollute usage floor!
    if (expectedResponseId && returnedId !== expectedResponseId) {
      const reason = `GET/POST /v1/responses returned foreign response id "${String(sanitizedBody.id ?? 'missing')}" (expected "${expectedResponseId}"); quarantining without usage attribution.`;
      ledger.markPendingRecovery(attempt.attempt_id, {
        httpStatus,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        reason,
      });
      throw new OpenAiAmbiguousOutcomeError(reason, {
        code: 'PROVIDER_RESPONSE_ID_MISMATCH',
        attemptId: attempt.attempt_id,
        logicalRequestId: attempt.logical_request_id,
        providerResponseId: expectedResponseId,
        httpStatus,
        reservedCents: attempt.reserved_cents,
      });
    }

    const provisional = this._computeProvisionalResponsesUsage(sanitizedBody, requestedModel, requestedServiceTier);

    if (!returnedId) {
      const reason = 'OpenAI /v1/responses payload omitted a valid response id; holding in pending_recovery.';
      ledger.markPendingRecovery(attempt.attempt_id, {
        httpStatus,
        provisionalUsage: provisional.usage,
        provisionalUsageCostMicros: provisional.micros,
        rawReceipt: sanitizedBody,
        originalBodySha256,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        reason,
      });
      return {
        ok: false,
        usable: false,
        status: 'pending_recovery',
        response_status: typeof sanitizedBody.status === 'string' ? sanitizedBody.status : 'unknown',
        content_status: 'invalid',
        attempt_id: attempt.attempt_id,
        logical_request_id: attempt.logical_request_id,
        provider_response_id: attempt.provider_response_id ?? null,
        model: sanitizedBody.model ?? requestedModel,
        output: [],
        output_text: '',
        refusal: null,
        refusals: [],
        incomplete_details: null,
        web_search_calls: provisional.usage ? extractWebSearchCallsFromOutput(sanitizedBody) : 0,
        usage: provisional.usage,
        provisional_usage_cost_micros: provisional.micros,
        usage_cost_micros: null,
        reserved_cents: attempt.reserved_cents,
        cleanup: {
          requested: cleanupRequired,
          status: cleanupRequired ? 'pending_cleanup' : 'not_requested',
          verified_404: false,
        },
        raw_response: sanitizedBody,
      };
    }

    const pendingResponse = (responseStatus, contentStatus) => ({
      ok: false,
      usable: false,
      status: 'pending_recovery',
      response_status: responseStatus,
      content_status: contentStatus,
      attempt_id: attempt.attempt_id,
      logical_request_id: attempt.logical_request_id,
      provider_response_id: returnedId,
      model: sanitizedBody.model ?? requestedModel,
      output: [],
      output_text: '',
      refusal: null,
      refusals: [],
      incomplete_details: null,
      web_search_calls: extractWebSearchCallsFromOutput(sanitizedBody),
      usage: provisional.usage,
      provisional_usage_cost_micros: provisional.micros,
      usage_cost_micros: null,
      reserved_cents: attempt.reserved_cents,
      cleanup: {
        requested: cleanupRequired,
        status: cleanupRequired ? 'pending_cleanup' : 'not_requested',
        verified_404: false,
      },
      raw_response: sanitizedBody,
    });

    // P0-15: If caller requested 1x standard/default cap and provider returned 2x fast/priority tier, hold in pending_recovery!
    const returnedTierNorm = typeof sanitizedBody.service_tier === 'string'
      ? sanitizedBody.service_tier.trim().toLowerCase()
      : '';
    if (
      (requestedServiceTier === 'standard' || requestedServiceTier === 'default') &&
      (returnedTierNorm === 'fast' || returnedTierNorm === 'priority')
    ) {
      const reason = `Requested 1x service_tier="default" ("standard"), but provider billed 2x service_tier="${returnedTierNorm}"; holding in pending_recovery.`;
      ledger.markPendingRecovery(attempt.attempt_id, {
        providerResponseId: returnedId,
        contentStatus: 'invalid',
        httpStatus,
        provisionalUsage: provisional.usage,
        provisionalUsageCostMicros: provisional.micros,
        rawReceipt: sanitizedBody,
        originalBodySha256,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        reason,
      });
      return pendingResponse(typeof sanitizedBody.status === 'string' ? sanitizedBody.status : 'completed', 'invalid');
    }

    const rawStatus = typeof sanitizedBody.status === 'string' ? sanitizedBody.status : '';
    if (!KNOWN_RESPONSE_STATUSES.has(rawStatus)) {
      const reason = `OpenAI response "${returnedId}" returned unrecognized status "${String(sanitizedBody.status)}"; holding reservation and fence.`;
      ledger.markPendingRecovery(attempt.attempt_id, {
        providerResponseId: returnedId,
        httpStatus,
        provisionalUsage: provisional.usage,
        provisionalUsageCostMicros: provisional.micros,
        rawReceipt: sanitizedBody,
        originalBodySha256,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        reason,
      });
      return pendingResponse(rawStatus || 'unknown', 'invalid');
    }

    if (rawStatus === 'in_progress' || rawStatus === 'queued') {
      ledger.markPendingRecovery(attempt.attempt_id, {
        providerResponseId: returnedId,
        httpStatus,
        provisionalUsage: provisional.usage,
        provisionalUsageCostMicros: provisional.micros,
        rawReceipt: sanitizedBody,
        originalBodySha256,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        reason: `OpenAI response "${returnedId}" is still "${rawStatus}"; retaining reservation and fence.`,
      });
      return pendingResponse(rawStatus, null);
    }

    const extracted = extractResponsesContent(sanitizedBody, { expectsJsonObject, jsonSchema });
    const returnedModelStr = typeof sanitizedBody.model === 'string' && sanitizedBody.model.trim()
      ? sanitizedBody.model.trim()
      : null;

    let returnedSpec = null;
    let modelValidationError = null;
    if (!returnedModelStr) {
      modelValidationError = 'Response payload omitted model string.';
    } else {
      try {
        returnedSpec = resolveModelPricing(returnedModelStr, { allowAstraApi: true, endpoint: '/v1/responses' });
      } catch (mErr) {
        modelValidationError = scrubTextForReceipt(mErr?.message || 'Unknown response model.', apiKey);
      }
    }

    const fallbackPricingTier = requestedServiceTier === 'auto' ? 'standard' : (requestedServiceTier || 'standard');
    const effectiveTier = sanitizedBody.service_tier || fallbackPricingTier;
    let usageCostMicros = null;
    let usageValidationWarning = modelValidationError ?? (extracted.webSearchUsageUncertain
      ? 'unrecognized web search actions without a provider-reported search count'
      : null);

    if (!usageValidationWarning && sanitizedBody.usage && typeof sanitizedBody.usage === 'object') {
      try {
        usageCostMicros = computeUsageCostMicros({
          model: returnedModelStr,
          serviceTier: effectiveTier,
          usage: sanitizedBody.usage,
          webSearchCalls: extracted.webSearchCalls,
          allowAstraApi: true,
        });
      } catch (usageErr) {
        usageCostMicros = null;
        usageValidationWarning = scrubTextForReceipt(usageErr?.message || 'Malformed usage payload.', apiKey);
      }
    }

    const canonicalModelMismatch = returnedSpec !== null && returnedSpec.canonicalModel !== expectedCanonical;
    const unexpectedAstraModel = !eff.allowAstraApi && returnedSpec !== null && returnedSpec.astraRestricted;
    const finalContentStatus = (modelValidationError || canonicalModelMismatch || unexpectedAstraModel)
      ? 'invalid'
      : extracted.contentStatus;

    const alreadyFinanciallySettled =
      ['completed', 'failed_known'].includes(attempt.status) &&
      (attempt.posted_billed_cents !== null || Boolean(attempt.confirmed_zero_charge));
    if (alreadyFinanciallySettled && usageCostMicros !== null && attempt.usage_cost_micros === null) {
      const enrichedUsageObj = isPlainObject(sanitizedBody.usage)
        ? { ...sanitizedBody.usage, web_search_calls: extracted.webSearchCalls }
        : null;
      ledger.db.prepare(`
        UPDATE openai_request_ledger
        SET usage_cost_micros = ?,
            usage_json = COALESCE(usage_json, ?),
            updated_at = ?
        WHERE attempt_id = ?
      `).run(
        usageCostMicros,
        enrichedUsageObj ? JSON.stringify(enrichedUsageObj) : null,
        ledger._nowIso(),
        attempt.attempt_id,
      );
    }

    let desiredTerminalStatus;
    let diagReason = null;
    if (usageCostMicros === null) {
      if (alreadyFinanciallySettled) {
        desiredTerminalStatus = attempt.status;
        diagReason = attempt.diagnostic_reason ?? null;
      } else {
        desiredTerminalStatus = 'pending_recovery';
        diagReason = usageValidationWarning
          ? `Terminal response "${extracted.responseStatus}" had unverifiable model/usage (${usageValidationWarning}); holding reservation until reconciled.`
          : `Terminal response "${extracted.responseStatus}" missing usage object; holding reservation until reconciled.`;
      }
    } else if (extracted.responseStatus === 'failed' || extracted.responseStatus === 'cancelled') {
      if (usageCostMicros > 0) {
        desiredTerminalStatus = 'failed_known';
        diagReason = sanitizedBody.error?.message ?? `Provider response ended with status="${extracted.responseStatus}".`;
      } else {
        desiredTerminalStatus = 'pending_recovery';
        diagReason = `Provider response ended with status="${extracted.responseStatus}" and 0 reported tokens; holding until zero-charge is confirmed.`;
      }
    } else {
      desiredTerminalStatus = 'completed';
      if (unexpectedAstraModel) {
        diagReason = `Provider returned blocked Astra model "${returnedModelStr}".`;
      } else if (canonicalModelMismatch) {
        diagReason = `Provider returned model "${returnedModelStr}" (canonical "${returnedSpec.canonicalModel}") instead of requested "${expectedCanonical}".`;
      } else if (extracted.refusal) {
        diagReason = `Model refused output: ${extracted.refusal}`;
      } else if (extracted.contentStatus === 'incomplete') {
        diagReason = `Response incomplete (${extracted.incompleteDetails?.reason ?? extracted.responseStatus}).`;
      } else if (finalContentStatus === 'invalid') {
        diagReason = extracted.invalidDetailReason ?? 'Completed response contained invalid or empty output content.';
      }
    }

    const wantCleanup = Boolean(cleanupRequired && desiredTerminalStatus !== 'pending_recovery');

    const hasEnrichedUsageForSettled =
      alreadyFinanciallySettled &&
      usageCostMicros !== null &&
      !attempt.confirmed_zero_charge &&
      (attempt.usage_cost_micros === null || usageCostMicros > attempt.usage_cost_micros);

    // Persist sanitized raw receipt, original_body_sha256, & terminal usage BEFORE optional DELETE + 404 readback!
    const persistedBeforeDelete = (alreadyFinanciallySettled && !hasEnrichedUsageForSettled)
      ? ledger.getAttemptById(attempt.attempt_id)
      : ledger.recordTerminalOutcome(attempt.attempt_id, {
        status: alreadyFinanciallySettled ? attempt.status : desiredTerminalStatus,
        contentStatus: finalContentStatus,
        usageCostMicros,
        usage: isPlainObject(sanitizedBody.usage)
          ? { ...sanitizedBody.usage, web_search_calls: extracted.webSearchCalls }
          : null,
        provisionalUsage: usageCostMicros === null ? provisional.usage : null,
        provisionalUsageCostMicros: usageCostMicros === null ? provisional.micros : null,
        providerResponseId: returnedId,
        providerModel: returnedModelStr ?? requestedModel,
        httpStatus,
        cleanupStatus: cleanupRequired ? 'pending_cleanup' : 'not_requested',
        rawReceipt: sanitizedBody,
        originalBodySha256,
        rawBodyText: scrubbedRawText,
        rawBodySha256: scrubbedRawSha256,
        diagnosticReason: alreadyFinanciallySettled ? (attempt.diagnostic_reason ?? diagReason) : diagReason,
      });

    let ledgerStatus = persistedBeforeDelete.status;
    let cleanupSummary = {
      requested: cleanupRequired,
      status: persistedBeforeDelete.cleanup_status ?? (cleanupRequired ? 'pending_cleanup' : 'not_requested'),
      verified_404: persistedBeforeDelete.cleanup_status === 'deleted_verified_404',
    };

    if (wantCleanup) {
      const hasVerifiedOriginalBytes = ledger._hasVerifiedOriginalBytesForAttempt(persistedBeforeDelete);
      if (
        !persistedBeforeDelete.raw_receipt_json ||
        !persistedBeforeDelete.raw_receipt_sha256 ||
        !hasVerifiedOriginalBytes
      ) {
        ledger.updateCleanupStatus(attempt.attempt_id, {
          cleanupStatus: 'delete_failed',
          diagnosticReason: !hasVerifiedOriginalBytes
            ? 'Blocked DELETE because full original raw payload bytes could not be persisted and verified locally.'
            : 'Blocked DELETE because raw receipt persistence verification failed.',
        });
        cleanupSummary = { requested: true, status: 'delete_failed', verified_404: false };
      } else {
        try {
          const delResult = await this.deleteResponse(returnedId, {
            ledger: eff.ledger,
            fetchImpl: eff.fetchImpl,
            testMode: eff.testMode,
            baseUrl: eff.baseUrl,
            accountScope: eff.accountScope,
            timeoutMs: eff.timeoutMs,
            signal: eff.signal,
            credentialFile: eff.credentialFile,
            apiKeyEnvVar: eff.apiKeyEnvVar,
            allowEnvKey: eff.allowEnvKey,
            env: eff.env,
            attemptId: attempt.attempt_id,
            verify404Readback: true,
          });
          const postCleanupRow = ledger.getAttemptById(attempt.attempt_id);
          ledgerStatus = postCleanupRow.status;
          cleanupSummary = {
            requested: true,
            status: postCleanupRow.cleanup_status,
            verified_404: Boolean(delResult.deleted && delResult.verified_404 && postCleanupRow.cleanup_status === 'deleted_verified_404'),
          };
        } catch (err) {
          ledger.updateCleanupStatus(attempt.attempt_id, {
            cleanupStatus: 'delete_failed',
            diagnosticReason: `Cleanup error after receipt persistence: ${scrubTextForReceipt(err?.message || 'delete_error', apiKey)}`,
          });
          cleanupSummary = {
            requested: true,
            status: 'delete_failed',
            verified_404: false,
          };
        }
      }
    }

    const isUsable = ledgerStatus === 'completed' && finalContentStatus === 'usable';
    return {
      ok: isUsable,
      usable: isUsable,
      status: ledgerStatus,
      response_status: extracted.responseStatus,
      content_status: finalContentStatus,
      attempt_id: attempt.attempt_id,
      logical_request_id: attempt.logical_request_id,
      provider_response_id: returnedId,
      model: returnedModelStr ?? requestedModel,
      output: sanitizedBody.output ?? [],
      output_text: extracted.outputText,
      refusal: extracted.refusal,
      refusals: extracted.refusals,
      incomplete_details: extracted.incompleteDetails,
      web_search_calls: extracted.webSearchCalls,
      usage: sanitizedBody.usage ?? null,
      usage_cost_micros: usageCostMicros,
      reserved_cents: attempt.reserved_cents,
      cleanup: cleanupSummary,
      raw_response: sanitizedBody,
    };
  }

  /**
   * GET /v1/responses/{responseId} — Read-only status/content retrieval.
   * Origin-, `api_base_url`-, credential-, and ID-bound when `attemptId` or `logicalRequestId` supplied.
   * Never returns unredacted `raw_parsed_body` (`P0-22`, `P0-24`).
   */
  async retrieveResponse(responseId, policy = {}) {
    const safeId = assertSafeResourceId(responseId, 'responseId');
    const eff = this._resolveEffectivePolicy(policy);
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);

    let boundAttempt = null;
    if (eff.attemptId || eff.logicalRequestId) {
      const ledger = this._requireBillableLedger(eff);
      // P2-03: Use typed getAttemptById / getAttemptByLogicalId!
      boundAttempt = eff.attemptId
        ? ledger.getAttemptById(eff.attemptId, { accountScope: eff.accountScope })
        : ledger.getAttemptByLogicalId(eff.logicalRequestId, { accountScope: eff.accountScope });
      if (!boundAttempt) {
        throw new OpenAiBudgetError(`Bound attempt "${sanitizeDiagnosticText(eff.attemptId ?? eff.logicalRequestId)}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (boundAttempt.endpoint !== '/v1/responses') {
        throw new OpenAiValidationError('retrieveResponse bound attempt must have endpoint="/v1/responses".');
      }
      if (!boundAttempt.provider_response_id || boundAttempt.provider_response_id !== safeId) {
        throw new OpenAiBudgetError(
          `retrieveResponse responseId "${safeId}" does not match bound attempt provider_response_id "${String(boundAttempt.provider_response_id)}".`,
          { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' },
        );
      }
      this._assertBoundAttemptConnection(boundAttempt, eff, credentialFingerprintSha256);
    }

    const res = await eff.fetchImpl(`${eff.baseUrl}/v1/responses/${encodeURIComponent(safeId)}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: formatAuthHeader(apiKey),
      },
      signal: requestSignal,
    });
    if (boundAttempt?.background_mode) requestSignal.throwIfAborted();

    const { okJson, body, sanitizedBody, rawBytes, originalBodySha256, scrubbedRawText, scrubbedRawSha256 } =
      await this._readJsonResponseSafe(res, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
        requireStreamingOrContentLength: eff.isLiveTransport,
      });
    if (boundAttempt?.background_mode) requestSignal.throwIfAborted();

    const observedAt = this._nowFn().toISOString();
    const emptyOrBodySha = sha256Hex(rawBytes ?? Buffer.alloc(0));

    if (res.status === 404) {
      return {
        ok: false,
        found: false,
        http_status: 404,
        response: null,
        original_body_sha256: originalBodySha256,
        scrubbed_raw_text: scrubbedRawText,
        scrubbed_raw_sha256: scrubbedRawSha256,
        transport_receipt: {
          method: 'GET',
          httpStatus: 404,
          apiBaseUrl: eff.baseUrl,
          credentialFingerprintSha256,
          bodySha256: emptyOrBodySha,
          observedAt,
        },
      };
    }

    if ((res.status >= 300 && res.status < 400) || res.status >= 400 || !okJson || !sanitizedBody) {
      throw new OpenAiHttpError(
        sanitizedBody?.error?.message ?? `GET /v1/responses/${safeId} failed with HTTP ${res.status}.`,
        { httpStatus: res.status },
      );
    }

    // P1: Verify returned payload ID === requested safeId BEFORE saving or attributing anything!
    const returnedSafeId = extractSafeProviderId(body?.id, apiKey);
    if (boundAttempt?.background_mode) {
      boundAttempt = eff.ledger.getAttemptById(boundAttempt.attempt_id, { accountScope: eff.accountScope });
    }
    if (returnedSafeId !== safeId) {
      const mismatchMsg = `GET /v1/responses/${safeId} returned foreign response id "${sanitizeDiagnosticText(String(sanitizedBody.id ?? 'missing'))}".`;
      if (boundAttempt && !hasPersistedBackgroundTerminal(boundAttempt) &&
        (boundAttempt.status === 'in_progress' || boundAttempt.status === 'pending_recovery')) {
        eff.ledger.markPendingRecovery(boundAttempt.attempt_id, {
          httpStatus: res.status,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason: `${mismatchMsg} Quarantining without usage attribution.`,
        });
        throw new OpenAiAmbiguousOutcomeError(mismatchMsg, {
          code: 'PROVIDER_RESPONSE_ID_MISMATCH',
          attemptId: boundAttempt.attempt_id,
          logicalRequestId: boundAttempt.logical_request_id,
          providerResponseId: safeId,
          httpStatus: res.status,
          reservedCents: boundAttempt.reserved_cents,
        });
      }
      throw new OpenAiHttpError(mismatchMsg, {
        httpStatus: res.status,
        code: 'PROVIDER_RESPONSE_ID_MISMATCH',
      });
    }

    let privateReceiptRef = null;
    const activeBackground = boundAttempt?.background_mode === true &&
      (sanitizedBody.status === 'queued' || sanitizedBody.status === 'in_progress');
    if (activeBackground && !hasPersistedBackgroundTerminal(boundAttempt)) {
      const observed = this._backgroundCostFloors(sanitizedBody, boundAttempt.model, boundAttempt.service_tier);
      if (observed.usageFloorMicros > 0) {
        eff.ledger.recordBackgroundUsageFloor({
          attemptId: boundAttempt.attempt_id,
          providerResponseId: safeId,
          accountScope: eff.accountScope,
          ...observed,
        });
      }
    } else if (boundAttempt && !activeBackground && !hasPersistedBackgroundTerminal(boundAttempt) &&
      rawBytes && rawBytes.length > 0) {
      const stage = `response_get_${originalBodySha256.slice(0, 32)}`;
      const saved = eff.ledger.savePrivatePayload(boundAttempt.attempt_id, stage, rawBytes, {
        literalSecret: apiKey,
      });
      if (saved.stored && saved.raw_sha256 === originalBodySha256) {
        privateReceiptRef = saved.private_receipt_ref;
      }
    }

    return {
      ok: true,
      found: true,
      http_status: res.status,
      response: sanitizedBody,
      private_receipt_ref: privateReceiptRef,
      original_body_sha256: originalBodySha256,
      scrubbed_raw_text: scrubbedRawText,
      scrubbed_raw_sha256: scrubbedRawSha256,
    };
  }

  /**
   * DELETE /v1/responses/{responseId} followed by mandatory independent GET 404 readback verification.
   * Atomically establishes durable cleanup obligation & fence BEFORE issuing DELETE (`P0-05`),
   * verifies identical `origin` + `apiBaseUrl` + `credentialFingerprintSha256` (`P0-03`, `P0-18`),
   * and requires verified original raw payload bytes (`P0-24`)!
   */
  async deleteResponse(responseId, policy = {}) {
    const safeId = assertSafeResourceId(responseId, 'responseId');
    const eff = this._resolveEffectivePolicy(policy);
    if (eff.verify404Readback === false) {
      throw new OpenAiPolicyError(
        'deleteResponse forbids verify404Readback: false; independent GET 404 verification is mandatory.',
        { code: 'UNVERIFIED_DELETE_FORBIDDEN' },
      );
    }
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const ledger = this._requireBillableLedger(eff);
    if (!eff.attemptId) {
      throw new OpenAiPolicyError(
        'deleteResponse requires a bound policy.attemptId with persisted receipt and usage.',
        { code: 'DELETE_BOUND_ATTEMPT_REQUIRED' },
      );
    }

    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);

    const cleanupClaim = ledger.beginBoundResponseCleanup(eff.attemptId, {
      accountScope: eff.accountScope,
      providerResponseId: safeId,
      apiBaseUrl: eff.baseUrl,
      origin: this.baseOrigin,
      credentialFingerprintSha256,
    });
    if (cleanupClaim.alreadyCleanedUp) {
      return {
        response_id: safeId,
        deleted: true,
        already_deleted: true,
        delete_http_status: 200,
        readback_http_status: 404,
        verified_404: true,
      };
    }
    const boundAttempt = cleanupClaim.attempt;

    if (cleanupClaim.readbackOnly) {
      return this._verifyResponseCleanupReadback(safeId, boundAttempt, eff, boundAttempt.delete_ack_receipt?.http_status ?? 200);
    }

    const delRes = await eff.fetchImpl(`${eff.baseUrl}/v1/responses/${encodeURIComponent(safeId)}`, {
      method: 'DELETE',
      redirect: 'error',
      headers: {
        Authorization: formatAuthHeader(apiKey),
      },
      signal: requestSignal,
    });

    const { okJson, sanitizedBody, rawBytes: delRawBytes } =
      await this._readJsonResponseSafe(delRes, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
        requireStreamingOrContentLength: eff.isLiveTransport,
      });

    if ((delRes.status >= 300 && delRes.status < 400) || (delRes.status >= 400 && delRes.status !== 404)) {
      ledger.updateCleanupStatus(boundAttempt.attempt_id, {
        cleanupStatus: 'delete_failed',
        diagnosticReason: sanitizedBody?.error?.message ?? `DELETE /v1/responses/${safeId} failed with HTTP ${delRes.status}.`,
      });
      throw new OpenAiHttpError(
        sanitizedBody?.error?.message ?? `DELETE /v1/responses/${safeId} failed with HTTP ${delRes.status}.`,
        { httpStatus: delRes.status, attemptId: boundAttempt.attempt_id, logicalRequestId: boundAttempt.logical_request_id },
      );
    }

    let deletedAck = false;
    if (delRes.status === 200 && okJson && sanitizedBody?.deleted === true && sanitizedBody?.id === safeId) {
      ledger.recordDeleteAcknowledged(boundAttempt.attempt_id, {
        providerResponseId: safeId,
        transportReceipt: {
          method: 'DELETE',
          httpStatus: delRes.status,
          apiBaseUrl: eff.baseUrl,
          credentialFingerprintSha256,
          bodySha256: sha256Hex(delRawBytes ?? Buffer.alloc(0)),
          observedAt: this._nowFn().toISOString(),
          deletedConfirmed: true,
        },
      });
      deletedAck = true;
    } else if (delRes.status === 404 && Boolean(boundAttempt.delete_ack_at && boundAttempt.delete_ack_receipt_json)) {
      deletedAck = true;
    }

    if (!deletedAck) {
      ledger.updateCleanupStatus(boundAttempt.attempt_id, {
        cleanupStatus: 'delete_failed',
        diagnosticReason: delRes.status === 404
          ? `Initial DELETE /v1/responses/${safeId} returned 404 without prior DELETE 200 acknowledgment.`
          : `DELETE /v1/responses/${safeId} did not return verified { id: "${safeId}", deleted: true }.`,
      });
      return {
        response_id: safeId,
        deleted: false,
        delete_http_status: delRes.status,
        readback_http_status: null,
        verified_404: false,
      };
    }

    return this._verifyResponseCleanupReadback(safeId, boundAttempt, eff, delRes.status);
  }

  async _verifyResponseCleanupReadback(safeId, boundAttempt, eff, deleteHttpStatus) {
    const ledger = eff.ledger;
    const readback = await this.retrieveResponse(safeId, {
      ...eff,
      attemptId: boundAttempt.attempt_id,
    });
    const readbackHttpStatus = readback.http_status;
    const verified404 = readback.http_status === 404 && readback.found === false;

    if (verified404) {
      ledger.recordCleanupVerified404(boundAttempt.attempt_id, {
        providerResponseId: safeId,
        transportReceipt: readback.transport_receipt,
      });
    } else {
      ledger.updateCleanupStatus(boundAttempt.attempt_id, {
        cleanupStatus: 'delete_failed',
        diagnosticReason: `GET /v1/responses/${safeId} readback after DELETE returned HTTP ${readbackHttpStatus} instead of 404.`,
      });
    }

    return {
      response_id: safeId,
      deleted: true,
      delete_http_status: deleteHttpStatus,
      readback_http_status: readbackHttpStatus,
      verified_404: verified404,
    };
  }

  /**
   * Recover an ambiguous `pending_recovery` / `in_progress` `/v1/responses` attempt.
   */
  async recoverPendingResponse(attemptIdOrLogicalId, policy = {}) {
    const eff = this._resolveEffectivePolicy(policy);
    buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const ledger = this._requireBillableLedger(eff);

    const existing = ledger.getAttempt(attemptIdOrLogicalId, { accountScope: eff.accountScope });

    if (!existing) {
      throw new OpenAiBudgetError(`Attempt "${sanitizeDiagnosticText(attemptIdOrLogicalId)}" not found in OpenAiBudgetLedger.`, {
        code: 'ATTEMPT_NOT_FOUND',
      });
    }
    if (existing.endpoint !== '/v1/responses') {
      throw new OpenAiValidationError(
        `recoverPendingResponse only supports /v1/responses attempts (got endpoint="${existing.endpoint}").`,
        { code: 'RECOVERY_ENDPOINT_MISMATCH' },
      );
    }

    const unfinishedCleanup = existing.cleanup_required === true && existing.cleanup_status !== 'deleted_verified_404';
    const unconfirmedRejected =
      existing.status === 'rejected' &&
      existing.confirmed_zero_charge !== true &&
      existing.usage_cost_micros === null &&
      !(existing.posted_billed_cents > 0);
    if (
      (existing.status === 'completed' || existing.status === 'failed_known' || (existing.status === 'rejected' && !unconfirmedRejected)) &&
      !unfinishedCleanup
    ) {
      return {
        recovered: true,
        already_settled: true,
        status: existing.status,
        fenced: false,
        attempt: existing,
      };
    }

    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);
    this._assertBoundAttemptConnection(existing, eff, credentialFingerprintSha256);

    if (hasPersistedBackgroundTerminal(existing)) {
      const response = await this._resumeBackgroundCleanup(existing, eff, apiKey);
      const attempt = ledger.getAttemptById(existing.attempt_id);
      return {
        recovered: isSettledResponseAttempt(attempt),
        status: attempt.status,
        fenced: !isSettledResponseAttempt(attempt),
        response,
        attempt,
      };
    }

    if (!existing.provider_response_id) {
      if (existing.status === 'in_progress') {
        ledger.markPendingRecovery(existing.attempt_id, {
          reason: 'Cannot auto-recover request without a known provider_response_id; retain hold and fence.',
        });
      }
      const updated = ledger.getAttemptById(existing.attempt_id);
      return {
        recovered: false,
        status: updated.status,
        reason: 'missing_provider_response_id',
        fenced: true,
        attempt: updated,
      };
    }

    if (existing.store_mode === 0 && !unfinishedCleanup) {
      ledger.markPendingRecovery(existing.attempt_id, {
        reason: 'Attempt used store: false and cannot be retrieved via GET /v1/responses/{id}; operator reconciliation required.',
      });
      return {
        recovered: false,
        status: 'pending_recovery',
        reason: 'unstored_response_unrecoverable_via_get',
        fenced: true,
        attempt: ledger.getAttemptById(existing.attempt_id),
      };
    }

    const expectedRespId = assertSafeResourceId(existing.provider_response_id, 'existing.provider_response_id');
    const getRes = await this.retrieveResponse(expectedRespId, {
      ...policy,
      attemptId: existing.attempt_id,
    });

    if (!getRes.found && getRes.http_status === 404) return this._recoverResponse404(existing, getRes, eff);

    if (existing.background_mode && isActiveResponseStatus(getRes.response?.status)) {
      const attempt = ledger.getAttemptById(existing.attempt_id);
      const settled = isSettledResponseAttempt(attempt);
      return {
        recovered: settled,
        status: attempt.status,
        fenced: !settled,
        response: this._backgroundActiveEnvelope(attempt, settled ? null : getRes.response),
        attempt,
      };
    }

    const effectiveRecoverPolicy = {
      ...eff,
      deleteAfterPersist: Boolean(existing.cleanup_required === true || eff.deleteAfterPersist === true),
    };

    const persistedRespFormat = existing.response_format;
    const expectsJsonObject = Boolean(
      persistedRespFormat?.type === 'json_schema' || persistedRespFormat?.type === 'json_object',
    );
    const jsonSchema = persistedRespFormat?.type === 'json_schema' ? (persistedRespFormat.schema ?? null) : null;

    const settledEnvelope = existing.background_mode
      ? await this._settleBoundResponse(existing, getRes, effectiveRecoverPolicy, apiKey)
      : await this._settleResponsesPayload(existing, getRes.response, {
        rawParsedBody: getRes.response,
        eff: effectiveRecoverPolicy,
        apiKey,
        requestedModel: existing.model,
        requestedServiceTier: existing.service_tier,
        expectsJsonObject,
        jsonSchema,
        expectedResponseId: expectedRespId,
        httpStatus: getRes.http_status,
        originalBodySha256: getRes.original_body_sha256,
        scrubbedRawText: getRes.scrubbed_raw_text,
        scrubbedRawSha256: getRes.scrubbed_raw_sha256,
      });

    const refreshed = ledger.getAttemptById(existing.attempt_id);
    const stillFenced =
      refreshed.status === 'pending_recovery' ||
      refreshed.status === 'in_progress';

    return {
      recovered: !stillFenced,
      status: refreshed.status,
      fenced: stillFenced,
      response: settledEnvelope,
      attempt: refreshed,
    };
  }

  _recoverResponse404(existing, receipt, eff) {
    const ledger = eff.ledger;
    if (
      existing.raw_receipt_json !== null &&
      (existing.usage_cost_micros !== null || existing.posted_billed_cents !== null || Boolean(existing.confirmed_zero_charge)) &&
      Boolean(existing.delete_ack_at && existing.delete_ack_receipt_json) &&
      ledger._hasVerifiedOriginalBytesForAttempt(existing) &&
      (existing.cleanup_required === true || existing.cleanup_status === 'pending_cleanup' || existing.cleanup_status === 'delete_failed')
    ) {
      const settled = ledger.recordCleanupVerified404(existing.attempt_id, {
        providerResponseId: existing.provider_response_id,
        transportReceipt: receipt.transport_receipt,
      });
      return {
        recovered: true,
        status: settled.status,
        reason: 'verified_404_after_persisted_receipt_and_delete_ack',
        fenced: false,
        attempt: settled,
      };
    }

    const priorReceipt = existing.raw_receipt_json !== null;
    if (!hasPersistedBackgroundTerminal(existing)) {
      try {
        ledger.markPendingRecovery(existing.attempt_id, {
          providerResponseId: existing.provider_response_id,
          httpStatus: 404,
          originalBodySha256: receipt.original_body_sha256,
          rawBodyText: receipt.scrubbed_raw_text,
          rawBodySha256: receipt.scrubbed_raw_sha256,
          reason: priorReceipt
            ? 'GET /v1/responses/{id} returned 404 without a prior persisted DELETE 200 acknowledgment; retaining fence.'
            : 'GET /v1/responses/{id} returned 404 without prior persisted terminal receipt/usage; never infer completion or zero cost from 404 alone.',
        });
      } catch (err) {
        if (!existing.background_mode || err?.code !== 'INVALID_STATE_TRANSITION') throw err;
        const current = ledger.getAttemptById(existing.attempt_id);
        if (isSettledResponseAttempt(current)) {
          return { recovered: true, already_settled: true, status: current.status, fenced: false, attempt: current };
        }
        if (!hasPersistedBackgroundTerminal(current)) throw err;
      }
    }
    return {
      recovered: false,
      status: 'pending_recovery',
      reason: priorReceipt ? 'response_404_without_delete_ack' : 'response_404_without_prior_terminal_receipt',
      fenced: true,
      attempt: ledger.getAttemptById(existing.attempt_id),
    };
  }

  /**
   * Upload a validated Batch `.jsonl` via `POST /v1/files` after pre-upload ledger admission,
   * and durably bind the returned `input_file_id` via `_commitVerifiedBatchUploadReceipt` (`P0-01`).
   */
  async uploadBatchFile(rawParams, policy = {}) {
    if (!isPlainObject(rawParams)) {
      throw new OpenAiValidationError('Batch upload params must be a plain object.');
    }
    const eff = this._resolveEffectivePolicy(policy);
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const ledger = this._requireBillableLedger(eff);

    const builtBatch = buildBatchJsonl(rawParams.requests, {
      endpoint: rawParams.endpoint ?? '/v1/responses',
      allowAstraApi: eff.allowAstraApi,
      uncappedWebSearchReservationCalls: eff.uncappedWebSearchReservationCalls,
    });
    const params = snapshotPlainValue(rawParams, 'Batch upload params');
    const endpointsUsed = Object.keys(builtBatch.endpoint_counts);
    if (endpointsUsed.length !== 1) {
      throw new OpenAiValidationError('A single OpenAI Batch upload must target one uniform endpoint.');
    }
    const endpoint = endpointsUsed[0];

    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);
    const uploadModel = 'gpt-6.1-terra';
    const uploadPayloadSha = computeRequestPayloadSha256('/v1/files', {
      target_endpoint: endpoint,
      jsonl_sha256: builtBatch.jsonl_sha256,
    });
    const uploadLogicalId = eff.logicalRequestId ?? params.logical_request_id ?? params.logicalRequestId ?? `upload-req-${generatePiiSafeUuid()}`;

    const uploadAttempt = ledger.reserveBillableRequest({
      logicalRequestId: uploadLogicalId,
      accountScope: eff.accountScope,
      monthUtc: eff.monthUtc,
      allowTestClockOverride: eff.allowTestClockOverride,
      endpoint: '/v1/files',
      model: uploadModel,
      serviceTier: 'batch',
      origin: this.baseOrigin,
      apiBaseUrl: eff.baseUrl,
      payloadSha256: uploadPayloadSha,
      reservedCents: 0,
      batchManifest: builtBatch.batch_manifest,
      lockedLogicalIds: builtBatch.locked_logical_ids,
      credentialFingerprintSha256,
      isLiveTransport: eff.isLiveTransport,
    });

    let fileRes;
    try {
      const form = new FormData();
      form.append('purpose', 'batch');
      form.append('file', new Blob([builtBatch.jsonl], { type: 'application/jsonl' }), 'batch.jsonl');

      fileRes = await eff.fetchImpl(`${eff.baseUrl}/v1/files`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: formatAuthHeader(apiKey) },
        body: form,
        signal: requestSignal,
      });
    } catch (err) {
      const reason = `Transport error/timeout/redirect on POST /v1/files (${scrubTextForReceipt(err?.message || 'network_error', apiKey)}).`;
      ledger.markPendingRecovery(uploadAttempt.attempt_id, { reason });
      throw new OpenAiAmbiguousOutcomeError(reason, {
        attemptId: uploadAttempt.attempt_id,
        logicalRequestId: uploadAttempt.logical_request_id,
        reservedCents: uploadAttempt.reserved_cents,
      });
    }

    try {
      const { okJson, body, sanitizedBody, rawBytes: fileRawBytes, originalBodySha256, scrubbedRawText, scrubbedRawSha256 } =
        await this._readJsonResponseSafe(fileRes, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
          requireStreamingOrContentLength: eff.isLiveTransport,
        });

      if (isAmbiguousHttpStatus(fileRes.status)) {
        const reason = `Ambiguous HTTP ${fileRes.status} on POST /v1/files during uploadBatchFile.`;
        ledger.markPendingRecovery(uploadAttempt.attempt_id, {
          httpStatus: fileRes.status,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: uploadAttempt.attempt_id,
          logicalRequestId: uploadAttempt.logical_request_id,
          httpStatus: fileRes.status,
          reservedCents: uploadAttempt.reserved_cents,
        });
      }

      if (fileRes.status >= 400) {
        const msg = sanitizedBody?.error?.message ?? `POST /v1/files failed with HTTP ${fileRes.status}.`;
        ledger.recordTerminalOutcome(uploadAttempt.attempt_id, {
          status: 'rejected',
          confirmedZeroCharge: true,
          httpStatus: fileRes.status,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          diagnosticReason: msg,
        });
        throw new OpenAiHttpError(msg, {
          httpStatus: fileRes.status,
          attemptId: uploadAttempt.attempt_id,
          logicalRequestId: uploadAttempt.logical_request_id,
        });
      }

      const uploadedFileId = okJson ? extractSafeProviderId(body?.id, apiKey) : null;
      if (!okJson || !sanitizedBody || !uploadedFileId) {
        const reason = 'POST /v1/files returned HTTP 200 without a safe file id; holding upload attempt in pending_recovery.';
        ledger.markPendingRecovery(uploadAttempt.attempt_id, {
          httpStatus: fileRes.status,
          rawReceipt: sanitizedBody,
          originalBodySha256,
          rawBodyText: scrubbedRawText,
          rawBodySha256: scrubbedRawSha256,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: uploadAttempt.attempt_id,
          logicalRequestId: uploadAttempt.logical_request_id,
          httpStatus: fileRes.status,
          reservedCents: uploadAttempt.reserved_cents,
        });
      }

      const committedUpload = ledger._commitVerifiedBatchUploadReceipt({
        accountScope: eff.accountScope,
        sourceAttemptId: uploadAttempt.attempt_id,
        uploadedFileId,
        apiBaseUrl: eff.baseUrl,
        origin: this.baseOrigin,
        credentialFingerprintSha256,
        transportReceipt: {
          method: 'POST',
          httpStatus: fileRes.status,
          fileId: uploadedFileId,
          bodySha256: originalBodySha256 ?? sha256Hex(fileRawBytes ?? Buffer.alloc(0)),
        },
      });

      return {
        ok: true,
        attempt_id: uploadAttempt.attempt_id,
        logical_request_id: uploadAttempt.logical_request_id,
        input_file_id: uploadedFileId,
        endpoint,
        jsonl_sha256: builtBatch.jsonl_sha256,
        estimated_reservation_cents: builtBatch.estimated_reservation_cents,
        batch_manifest: committedUpload.manifest,
      };
    } catch (err) {
      this._handlePostDispatchUnexpectedError(err, ledger, uploadAttempt, apiKey, fileRes?.status ?? null);
    }
  }

  /**
   * Submit a 50%-discounted OpenAI Batch (`POST /v1/batches`, uploading `/v1/files` or verifying a durably bound `input_file_id`).
   */
  async submitBatch(rawParams, policy = {}) {
    if (!isPlainObject(rawParams)) {
      throw new OpenAiValidationError('Batch params must be a plain object.');
    }
    const eff = this._resolveEffectivePolicy(policy);
    buildTimeoutSignal(eff.timeoutMs, eff.signal);

    const hasRequests = rawParams.requests !== undefined && rawParams.requests !== null;
    const hasInputFileParam = Object.hasOwn(rawParams, 'input_file_id') || Object.hasOwn(rawParams, 'inputFileId');
    const rawInputFileId = Object.hasOwn(rawParams, 'input_file_id') ? rawParams.input_file_id : rawParams.inputFileId;

    if (hasRequests && hasInputFileParam && rawInputFileId !== undefined && rawInputFileId !== null) {
      throw new OpenAiValidationError(
        'submitBatch forbids supplying both requests[] and input_file_id; pass exactly one.',
        { code: 'BATCH_CONFLICTING_INPUTS' },
      );
    }
    if (!hasRequests && (!hasInputFileParam || rawInputFileId === undefined || rawInputFileId === null)) {
      throw new OpenAiValidationError('submitBatch requires either requests[] or input_file_id.');
    }

    let inputFileId = !hasRequests ? assertSafeResourceId(rawInputFileId, 'input_file_id') : null;

    let endpoint = rawParams.endpoint ?? '/v1/responses';
    let builtBatch = null;
    if (hasRequests) {
      builtBatch = buildBatchJsonl(rawParams.requests, {
        endpoint,
        allowAstraApi: eff.allowAstraApi,
        uncappedWebSearchReservationCalls: eff.uncappedWebSearchReservationCalls,
      });
      const endpointsUsed = Object.keys(builtBatch.endpoint_counts);
      if (endpointsUsed.length !== 1) {
        throw new OpenAiValidationError('A single OpenAI Batch submission must target one uniform endpoint.');
      }
      endpoint = endpointsUsed[0];
    }
    const params = snapshotPlainValue(rawParams, 'Batch params');

    if (!ALLOWED_BATCH_ENDPOINTS.has(endpoint)) {
      throw new OpenAiValidationError(`Unsupported Batch endpoint "${String(endpoint)}".`);
    }

    const ledger = this._requireBillableLedger(eff);

    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);

    let verifiedManifest;
    let reservedCents;

    if (builtBatch) {
      reservedCents = builtBatch.estimated_reservation_cents;
      verifiedManifest = {
        endpoint,
        jsonl_sha256: builtBatch.jsonl_sha256,
        line_count: builtBatch.line_count,
        custom_ids: [...builtBatch.custom_ids],
        locked_logical_ids: [...builtBatch.locked_logical_ids],
        line_models: cloneSafeMapRecord(builtBatch.line_models),
        line_specs: cloneSafeMapRecord(builtBatch.line_specs),
        estimated_reservation_cents: reservedCents,
        input_file_id: null,
        uploaded_file_id: null,
      };
    } else {
      // P0-01: Require a durable local upload receipt in openai_batch_uploads binding (accountScope, input_file_id)!
      const rawManifest = params.batchManifest ?? params.batch_manifest;
      if (rawManifest !== undefined && rawManifest !== null) {
        validateExternalBatchManifest(rawManifest, {
          endpoint,
          allowAstraApi: eff.allowAstraApi,
          explicitReservationCents: params.estimated_reservation_cents ?? params.estimatedReservationCents,
        });
      }
      const durableUpload = ledger.getVerifiedBatchUpload(eff.accountScope, inputFileId);
      if (!durableUpload || !durableUpload.manifest) {
        throw new OpenAiPolicyError(
          `Batch input_file_id "${inputFileId}" has no durable local upload receipt in openai_batch_uploads for "${eff.accountScope}"; upload validated requests[] via submitBatch or uploadBatchFile first.`,
          { code: 'UNBOUND_BATCH_INPUT_FILE', notDispatched: true },
        );
      }
      if (durableUpload.endpoint !== endpoint) {
        throw new OpenAiValidationError(
          `Batch input_file_id "${inputFileId}" was uploaded for endpoint "${durableUpload.endpoint}", not "${endpoint}".`,
          { code: 'BATCH_MANIFEST_MISMATCH' },
        );
      }
      if (!durableUpload.origin || !durableUpload.api_base_url || !durableUpload.credential_fingerprint_sha256) {
        throw new OpenAiPolicyError(
          `Batch input_file_id "${inputFileId}" lacks bound origin, api_base_url, or credential_fingerprint_sha256.`,
          { code: 'LEGACY_UNBOUND_CONNECTION_QUARANTINED', notDispatched: true },
        );
      }
      if (durableUpload.origin !== this.baseOrigin) {
        throw new OpenAiPolicyError(
          `Batch input_file_id "${inputFileId}" was uploaded to origin "${durableUpload.origin}", not "${this.baseOrigin}".`,
          { code: 'ORIGIN_MISMATCH_ON_RECOVERY', notDispatched: true },
        );
      }
      if (durableUpload.api_base_url !== eff.baseUrl) {
        throw new OpenAiPolicyError(
          `Batch input_file_id "${inputFileId}" was uploaded to api_base_url "${durableUpload.api_base_url}", not "${eff.baseUrl}".`,
          { code: 'API_BASE_URL_MISMATCH_ON_RECOVERY', notDispatched: true },
        );
      }
      if (durableUpload.credential_fingerprint_sha256 !== credentialFingerprintSha256) {
        throw new OpenAiPolicyError(
          `Batch input_file_id "${inputFileId}" belongs to a different credential fingerprint.`,
          { code: 'CREDENTIAL_MISMATCH_ON_RECOVERY', notDispatched: true },
        );
      }

      // P0-01: Re-verify EVERY saved line's model against current policy (e.g., blocking Astra when allowAstraApi: false)!
      const savedLineModels = durableUpload.manifest.line_models;
      if (!isPlainObject(savedLineModels)) {
        throw new OpenAiValidationError('Durable upload manifest is missing valid line_models.', {
          code: 'BATCH_MANIFEST_INVALID',
        });
      }
      for (const cid of durableUpload.manifest.custom_ids ?? []) {
        const savedModel = Object.hasOwn(savedLineModels, cid) ? savedLineModels[cid] : null;
        if (!savedModel) {
          throw new OpenAiValidationError(`Durable upload manifest is missing model for custom_id "${cid}".`, {
            code: 'BATCH_MANIFEST_INVALID',
          });
        }
        resolveModelPricing(savedModel, { allowAstraApi: eff.allowAstraApi, endpoint });
      }

      if (rawManifest !== undefined && rawManifest !== null) {
        if (
          rawManifest.jsonl_sha256 !== durableUpload.jsonl_sha256 ||
          canonicalJson(rawManifest.custom_ids) !== canonicalJson(durableUpload.manifest.custom_ids) ||
          rawManifest.estimated_reservation_cents < durableUpload.estimated_reservation_cents
        ) {
          throw new OpenAiValidationError(
            `Supplied batchManifest does not match durable upload receipt for "${inputFileId}".`,
            { code: 'BATCH_MANIFEST_MISMATCH' },
          );
        }
      }
      const explicitRes = params.estimated_reservation_cents ?? params.estimatedReservationCents;
      if (explicitRes !== undefined && explicitRes !== null) {
        if (!Number.isSafeInteger(explicitRes) || explicitRes < durableUpload.estimated_reservation_cents) {
          throw new OpenAiValidationError(
            `estimated_reservation_cents (${String(explicitRes)}) is below verified upload reservation (${durableUpload.estimated_reservation_cents}).`,
            { code: 'BATCH_MANIFEST_MISMATCH' },
          );
        }
      }
      reservedCents = Math.max(durableUpload.estimated_reservation_cents, explicitRes ?? 0);
      verifiedManifest = {
        ...durableUpload.manifest,
        endpoint,
        line_models: cloneSafeMapRecord(durableUpload.manifest.line_models),
        line_specs: cloneSafeMapRecord(durableUpload.manifest.line_specs),
        estimated_reservation_cents: reservedCents,
        input_file_id: inputFileId,
        uploaded_file_id: inputFileId,
      };
    }

    const batchModel = params.model ?? 'gpt-6.1-terra';
    resolveModelPricing(batchModel, { allowAstraApi: eff.allowAstraApi });

    const completionWindow = params.completion_window ?? '24h';
    if (completionWindow !== '24h') {
      throw new OpenAiValidationError('OpenAI Batch completion_window must be "24h".');
    }

    let clonedMetadata = null;
    if (params.metadata !== undefined && params.metadata !== null) {
      requirePlainObject(params.metadata, 'metadata');
      assertCleanOutgoingPayload(params.metadata, 'batch_metadata');
      clonedMetadata = snapshotPlainValue(params.metadata, 'metadata');
    }

    const payloadIdentity = {
      endpoint,
      completion_window: completionWindow,
      input_file_id: inputFileId,
      jsonl_sha256: verifiedManifest.jsonl_sha256,
      custom_ids: verifiedManifest.custom_ids,
      metadata: clonedMetadata,
    };
    const payloadSha256 = computeRequestPayloadSha256('/v1/batches', JSON.stringify(payloadIdentity));
    const logicalRequestId = eff.logicalRequestId ?? params.logical_request_id ?? params.logicalRequestId ?? `batch-req-${generatePiiSafeUuid()}`;

    const attempt = ledger.reserveBillableRequest({
      logicalRequestId,
      accountScope: eff.accountScope,
      monthUtc: eff.monthUtc,
      allowTestClockOverride: eff.allowTestClockOverride,
      endpoint: '/v1/batches',
      model: batchModel,
      serviceTier: 'batch',
      origin: this.baseOrigin,
      apiBaseUrl: eff.baseUrl,
      payloadSha256,
      reservedCents: 0,
      batchManifest: verifiedManifest,
      lockedLogicalIds: Array.isArray(verifiedManifest.locked_logical_ids) ? verifiedManifest.locked_logical_ids : null,
      credentialFingerprintSha256,
      isLiveTransport: eff.isLiveTransport,
    });

    try {
      if (!inputFileId && builtBatch) {
        const form = new FormData();
        form.append('purpose', 'batch');
        form.append('file', new Blob([builtBatch.jsonl], { type: 'application/jsonl' }), 'batch.jsonl');

        const fileRes = await eff.fetchImpl(`${eff.baseUrl}/v1/files`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: formatAuthHeader(apiKey),
          },
          body: form,
          signal: buildTimeoutSignal(eff.timeoutMs, eff.signal),
        });
        const {
          okJson: fileOk,
          body: rawFileBody,
          sanitizedBody: sanitizedFile,
          rawBytes: fileRawBytes,
          originalBodySha256: fileOrigSha,
          scrubbedRawText: fileRawText,
          scrubbedRawSha256: fileRawSha,
        } = await this._readJsonResponseSafe(fileRes, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
          requireStreamingOrContentLength: eff.isLiveTransport,
        });

        if (isAmbiguousHttpStatus(fileRes.status)) {
          const reason = `Ambiguous HTTP ${fileRes.status} on POST /v1/files during submitBatch.`;
          ledger.markPendingRecovery(attempt.attempt_id, {
            httpStatus: fileRes.status,
            rawReceipt: sanitizedFile,
            originalBodySha256: fileOrigSha,
            rawBodyText: fileRawText,
            rawBodySha256: fileRawSha,
            reason,
          });
          throw new OpenAiAmbiguousOutcomeError(reason, {
            attemptId: attempt.attempt_id,
            logicalRequestId: attempt.logical_request_id,
            httpStatus: fileRes.status,
            reservedCents: attempt.reserved_cents,
          });
        }
        if (fileRes.status >= 400) {
          const msg = sanitizedFile?.error?.message ?? `POST /v1/files rejected with HTTP ${fileRes.status}.`;
          ledger.recordTerminalOutcome(attempt.attempt_id, {
            status: 'rejected',
            confirmedZeroCharge: true,
            httpStatus: fileRes.status,
            rawReceipt: sanitizedFile,
            originalBodySha256: fileOrigSha,
            rawBodyText: fileRawText,
            rawBodySha256: fileRawSha,
            diagnosticReason: msg,
          });
          throw new OpenAiHttpError(msg, {
            httpStatus: fileRes.status,
            attemptId: attempt.attempt_id,
            logicalRequestId: attempt.logical_request_id,
          });
        }

        const safeUploadedId = fileOk ? extractSafeProviderId(rawFileBody?.id, apiKey) : null;
        if (!fileOk || !safeUploadedId) {
          const reason = 'POST /v1/files returned HTTP 200 without a valid safe file JSON/id; holding in pending_recovery.';
          ledger.markPendingRecovery(attempt.attempt_id, {
            httpStatus: fileRes.status,
            rawReceipt: sanitizedFile,
            originalBodySha256: fileOrigSha,
            rawBodyText: fileRawText,
            rawBodySha256: fileRawSha,
            reason,
          });
          throw new OpenAiAmbiguousOutcomeError(reason, {
            attemptId: attempt.attempt_id,
            logicalRequestId: attempt.logical_request_id,
            httpStatus: fileRes.status,
            reservedCents: attempt.reserved_cents,
          });
        }
        inputFileId = safeUploadedId;

        ledger._commitVerifiedBatchUploadReceipt({
          accountScope: eff.accountScope,
          sourceAttemptId: attempt.attempt_id,
          uploadedFileId: inputFileId,
          apiBaseUrl: eff.baseUrl,
          origin: this.baseOrigin,
          credentialFingerprintSha256,
          transportReceipt: {
            method: 'POST',
            httpStatus: fileRes.status,
            fileId: inputFileId,
            bodySha256: fileOrigSha ?? sha256Hex(fileRawBytes ?? Buffer.alloc(0)),
          },
        });
      }

      const batchWire = {
        input_file_id: inputFileId,
        endpoint,
        completion_window: '24h',
        ...(clonedMetadata ? { metadata: clonedMetadata } : {}),
      };
      const serializedBatchWire = JSON.stringify(batchWire);
      const batchPostSha256 = sha256Hex(Buffer.from(serializedBatchWire, 'utf8'));

      ledger.claimBatchCreationStage(attempt.attempt_id, {
        accountScope: eff.accountScope,
        uploadedFileId: inputFileId,
        batchPostSha256,
        monthUtc: eff.monthUtc,
        allowTestClockOverride: eff.allowTestClockOverride,
      });

      const batchRes = await eff.fetchImpl(`${eff.baseUrl}/v1/batches`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: formatAuthHeader(apiKey),
          'Content-Type': 'application/json',
        },
        body: serializedBatchWire,
        signal: buildTimeoutSignal(eff.timeoutMs, eff.signal),
      });

      const {
        okJson,
        body: rawBatchBody,
        sanitizedBody: sanitizedBatch,
        originalBodySha256: batchOrigSha,
        scrubbedRawText: batchRawText,
        scrubbedRawSha256: batchRawSha,
      } = await this._readJsonResponseSafe(batchRes, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
        requireStreamingOrContentLength: eff.isLiveTransport,
      });
      const batchId = extractSafeProviderId(rawBatchBody?.id, apiKey);

      if (isAmbiguousHttpStatus(batchRes.status)) {
        const reason = `Ambiguous HTTP ${batchRes.status} on POST /v1/batches.`;
        ledger.markPendingRecovery(attempt.attempt_id, {
          providerResponseId: batchId,
          httpStatus: batchRes.status,
          rawReceipt: sanitizedBatch,
          originalBodySha256: batchOrigSha,
          rawBodyText: batchRawText,
          rawBodySha256: batchRawSha,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          providerResponseId: batchId,
          httpStatus: batchRes.status,
          reservedCents: attempt.reserved_cents,
        });
      }

      if (batchRes.status >= 400) {
        const msg = sanitizedBatch?.error?.message ?? `POST /v1/batches rejected with HTTP ${batchRes.status}.`;
        ledger.recordTerminalOutcome(attempt.attempt_id, {
          status: 'rejected',
          httpStatus: batchRes.status,
          providerResponseId: batchId,
          rawReceipt: sanitizedBatch,
          originalBodySha256: batchOrigSha,
          rawBodyText: batchRawText,
          rawBodySha256: batchRawSha,
          diagnosticReason: msg,
        });
        throw new OpenAiHttpError(msg, {
          httpStatus: batchRes.status,
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
        });
      }

      if (!okJson || !sanitizedBatch || !batchId) {
        const reason = 'POST /v1/batches returned HTTP 200 without valid batch JSON/id.';
        ledger.markPendingRecovery(attempt.attempt_id, {
          httpStatus: batchRes.status,
          originalBodySha256: batchOrigSha,
          rawBodyText: batchRawText,
          rawBodySha256: batchRawSha,
          reason,
        });
        throw new OpenAiAmbiguousOutcomeError(reason, {
          attemptId: attempt.attempt_id,
          logicalRequestId: attempt.logical_request_id,
          httpStatus: batchRes.status,
          reservedCents: attempt.reserved_cents,
        });
      }

      ledger.markPendingRecovery(attempt.attempt_id, {
        providerResponseId: batchId,
        httpStatus: batchRes.status,
        rawReceipt: sanitizedBatch,
        originalBodySha256: batchOrigSha,
        rawBodyText: batchRawText,
        rawBodySha256: batchRawSha,
        reason: `Async Batch "${batchId}" submitted (status=${sanitizedBatch.status ?? 'validating'}); retain reservation until batch completes and output usage is reconciled.`,
      });

      return {
        ok: true,
        status: 'pending_recovery',
        batch_id: batchId,
        batch_status: sanitizedBatch.status ?? 'validating',
        input_file_id: inputFileId,
        attempt_id: attempt.attempt_id,
        logical_request_id: attempt.logical_request_id,
        reserved_cents: attempt.reserved_cents,
        batch_manifest: ledger.getAttemptById(attempt.attempt_id).batch_manifest,
        batch: sanitizedBatch,
      };
    } catch (err) {
      if (err instanceof OpenAiAmbiguousOutcomeError || err instanceof OpenAiHttpError) {
        throw err;
      }
      if (
        (err instanceof OpenAiBudgetError || err instanceof OpenAiPolicyError) &&
        err.not_dispatched === false &&
        [
          'BATCH_ATTEMPT_NO_LONGER_ACTIVE',
          'BATCH_MONTH_ROLLOVER_ABORTED',
          'BUDGET_DISABLED',
          'ACCOUNT_FENCED_PENDING_RECOVERY',
          'MONTHLY_BUDGET_EXCEEDED',
          'PLATFORM_BILLING_CONTROLS_UNVERIFIED',
          'MONTH_CLOCK_OVERRIDE_FORBIDDEN',
        ].includes(err.code)
      ) {
        throw err;
      }
      const reason = `Post-dispatch failure during submitBatch (${scrubTextForReceipt(err?.message || 'batch_error', apiKey)}).`;
      const currentRow = ledger.getAttemptById(attempt.attempt_id);
      if (currentRow && (currentRow.status === 'in_progress' || currentRow.status === 'pending_recovery')) {
        ledger.markPendingRecovery(attempt.attempt_id, { reason });
      }
      throw new OpenAiAmbiguousOutcomeError(reason, {
        code: typeof err?.code === 'string' ? err.code : 'PENDING_RECOVERY',
        attemptId: attempt.attempt_id,
        logicalRequestId: attempt.logical_request_id,
        reservedCents: attempt.reserved_cents,
      });
    }
  }

  /**
   * GET /v1/batches/{batchId} — Retrieve batch status and optionally verify/settle output JSONL.
   */
  async retrieveBatch(batchId, policy = {}) {
    const safeId = assertSafeResourceId(batchId, 'batchId');
    const eff = this._resolveEffectivePolicy(policy);
    const requestSignal = buildTimeoutSignal(eff.timeoutMs, eff.signal);
    const { apiKey, credentialFingerprintSha256 } = this._resolveApiKeyAndFingerprint(eff);

    let boundAttempt = null;
    if (eff.attemptId || eff.logicalRequestId) {
      const ledger = this._requireBillableLedger(eff);
      // P2-03: Use typed getAttemptById / getAttemptByLogicalId!
      boundAttempt = eff.attemptId
        ? ledger.getAttemptById(eff.attemptId, { accountScope: eff.accountScope })
        : ledger.getAttemptByLogicalId(eff.logicalRequestId, { accountScope: eff.accountScope });
      if (!boundAttempt) {
        throw new OpenAiBudgetError(`Batch attempt "${sanitizeDiagnosticText(eff.attemptId ?? eff.logicalRequestId)}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (boundAttempt.endpoint !== '/v1/batches') {
        throw new OpenAiValidationError(
          `Attempt "${boundAttempt.attempt_id}" is endpoint="${boundAttempt.endpoint}", not "/v1/batches".`,
          { code: 'BATCH_ATTEMPT_ENDPOINT_MISMATCH' },
        );
      }
      const canBindMissingBatchIdOnRecovery =
        boundAttempt.provider_response_id === null &&
        boundAttempt.status === 'pending_recovery';
      if (!canBindMissingBatchIdOnRecovery && boundAttempt.provider_response_id !== safeId) {
        throw new OpenAiBudgetError(
          `Batch attempt "${boundAttempt.attempt_id}" is bound to batch "${String(boundAttempt.provider_response_id)}", not "${safeId}".`,
          { code: 'BATCH_ID_MISMATCH' },
        );
      }
      this._assertBoundAttemptConnection(boundAttempt, eff, credentialFingerprintSha256);

      if (boundAttempt.status === 'completed' && !eff.downloadOutput) {
        return {
          ok: true,
          status: 'completed',
          fenced: false,
          already_settled: true,
          http_status: 200,
          batch_id: safeId,
          batch_status: 'completed',
          batch: boundAttempt.raw_receipt,
          parsed_output: null,
        };
      }
    }

    const res = await eff.fetchImpl(`${eff.baseUrl}/v1/batches/${encodeURIComponent(safeId)}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Authorization: formatAuthHeader(apiKey),
      },
      signal: requestSignal,
    });

    const { okJson, sanitizedBody: sanitized, originalBodySha256: batchGetOrigSha } =
      await this._readJsonResponseSafe(res, apiKey, DEFAULT_MAX_RESPONSE_BYTES, {
        requireStreamingOrContentLength: eff.isLiveTransport,
      });
    if ((res.status >= 300 && res.status < 400) || res.status >= 400 || !okJson || !sanitized) {
      throw new OpenAiHttpError(
        sanitized?.error?.message ?? `GET /v1/batches/${safeId} failed with HTTP ${res.status}.`,
        { httpStatus: res.status },
      );
    }
    if (sanitized.id !== safeId) {
      throw new OpenAiHttpError(
        `GET /v1/batches/${safeId} returned mismatched batch id "${String(sanitized.id)}".`,
        { httpStatus: res.status, code: 'BATCH_ID_MISMATCH' },
      );
    }

    // Auto-match a unique unbound pending_recovery /v1/batches attempt by manifest endpoint + uploaded_file_id
    // + connection binding when polling by --batch-id alone after a submit disconnect.
    if (!boundAttempt && eff.ledger && policy?.bindPendingRecoveryByManifest === true) {
      const candidateFences = eff.ledger.getActiveFences(eff.accountScope)
        .filter(a => a.endpoint === '/v1/batches' && a.status === 'pending_recovery' && a.provider_response_id === null)
        .map(a => eff.ledger.getAttemptById(a.attempt_id, { accountScope: eff.accountScope }))
        .filter(a => {
          if (!a || a.endpoint !== '/v1/batches' || a.status !== 'pending_recovery' || a.provider_response_id !== null) {
            return false;
          }
          const m = a.batch_manifest ?? null;
          const mEndpoint = m?.endpoint ?? null;
          const mFileId = m?.uploaded_file_id ?? m?.input_file_id ?? null;
          if (!mEndpoint || !mFileId || mEndpoint !== sanitized.endpoint || mFileId !== sanitized.input_file_id) {
            return false;
          }
          if (a.api_base_url && a.api_base_url !== eff.baseUrl) return false;
          if (a.credential_fingerprint_sha256 && a.credential_fingerprint_sha256 !== credentialFingerprintSha256) return false;
          return true;
        });
      if (candidateFences.length === 1) {
        boundAttempt = candidateFences[0];
      }
    }

    // Bind recovered batch_id onto a pending_recovery attempt whose POST /v1/batches disconnected
    // before returning an id, STRICTLY AFTER verifying manifest endpoint & uploaded_file_id parity!
    if (boundAttempt && boundAttempt.provider_response_id === null && boundAttempt.status === 'pending_recovery') {
      const bindManifest = boundAttempt.batch_manifest ?? null;
      const expectedBindEndpoint = bindManifest?.endpoint ?? null;
      const expectedBindInputFileId = bindManifest?.uploaded_file_id ?? bindManifest?.input_file_id ?? null;
      if (
        !expectedBindEndpoint ||
        !expectedBindInputFileId ||
        sanitized.endpoint !== expectedBindEndpoint ||
        sanitized.input_file_id !== expectedBindInputFileId
      ) {
        throw new OpenAiPolicyError(
          `Recovered Batch "${safeId}" (endpoint=${String(sanitized.endpoint)}, input_file_id=${String(sanitized.input_file_id)}) does not match attempt "${boundAttempt.attempt_id}" manifest (endpoint=${String(expectedBindEndpoint)}, uploaded_file_id=${String(expectedBindInputFileId)}); refusing to bind.`,
          { code: 'BATCH_MANIFEST_MISMATCH' },
        );
      }
      eff.ledger.markPendingRecovery(boundAttempt.attempt_id, {
        providerResponseId: safeId,
        httpStatus: res.status,
        rawReceipt: sanitized,
        originalBodySha256: batchGetOrigSha,
        reason: `Bound recovered Batch "${safeId}" (status=${sanitized.status ?? 'unknown'}) onto pending_recovery attempt after verified endpoint & uploaded_file_id match.`,
      });
      boundAttempt = eff.ledger.getAttemptById(boundAttempt.attempt_id);
    }

    let parsedOutput = null;
    let parsedError = null;
    let outputFileError = null;
    let errorFileError = null;
    let reconciliation = null;
    const wasAlreadyCompletedBefore = Boolean(boundAttempt && boundAttempt.status === 'completed');
    const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);
    const isTerminalBatchStatus = TERMINAL_BATCH_STATUSES.has(sanitized.status);
    const hasDownloadableArtifact = Boolean(sanitized.output_file_id || sanitized.error_file_id);

    if (eff.downloadOutput === true && isTerminalBatchStatus && hasDownloadableArtifact) {
      const manifest = boundAttempt?.batch_manifest ?? null;
      if (boundAttempt) {
        // P0-02 & P1: Validate endpoint and input_file_id BEFORE fetching output_file_id / error_file_id!
        const expectedEndpoint = manifest?.endpoint ?? null;
        const expectedInputFileId = manifest?.uploaded_file_id ?? manifest?.input_file_id ?? null;
        const endpointMatches = Boolean(expectedEndpoint && sanitized.endpoint === expectedEndpoint);
        const inputFileMatches = Boolean(expectedInputFileId && sanitized.input_file_id === expectedInputFileId);

        if (!endpointMatches || !inputFileMatches) {
          const mismatchReason = !endpointMatches
            ? `Batch "${safeId}" returned endpoint "${String(sanitized.endpoint)}" instead of manifest endpoint "${String(expectedEndpoint)}"; refusing artifact download.`
            : `Batch "${safeId}" returned input_file_id "${String(sanitized.input_file_id)}" instead of manifest uploaded_file_id "${String(expectedInputFileId)}"; refusing artifact download.`;
          if (wasAlreadyCompletedBefore) {
            throw new OpenAiPolicyError(mismatchReason, { code: 'BATCH_MANIFEST_MISMATCH' });
          }
          const latestRow = eff.ledger.getAttemptById(boundAttempt.attempt_id);
          if (latestRow && (latestRow.status === 'in_progress' || latestRow.status === 'pending_recovery')) {
            eff.ledger.markPendingRecovery(boundAttempt.attempt_id, {
              providerResponseId: safeId,
              httpStatus: 200,
              rawReceipt: sanitized,
              originalBodySha256: batchGetOrigSha,
              reason: mismatchReason,
            });
          }
          return {
            ok: false,
            status: 'pending_recovery',
            fenced: true,
            http_status: res.status,
            batch_id: safeId,
            batch_status: sanitized.status,
            output_file_id: sanitized.output_file_id ?? null,
            error_file_id: sanitized.error_file_id ?? null,
            batch: sanitized,
            ...(Array.isArray(sanitized.errors?.data) && sanitized.errors.data.length > 0 ? { batch_errors: sanitized.errors.data } : {}),
            parsed_output: null,
            parsed_error: null,
            reconciliation: null,
          };
        }
      }

      const downloadBatchFileContent = async (rawFileId, label) => {
        const safeFileId = assertSafeResourceId(rawFileId, label);
        const contentRes = await eff.fetchImpl(`${eff.baseUrl}/v1/files/${encodeURIComponent(safeFileId)}/content`, {
          method: 'GET',
          redirect: 'error',
          headers: { Authorization: formatAuthHeader(apiKey) },
          signal: buildTimeoutSignal(eff.timeoutMs, eff.signal),
        });
        if ((contentRes.status >= 300 && contentRes.status < 400) || contentRes.status >= 400) {
          throw new OpenAiHttpError(`GET /v1/files/${safeFileId}/content failed with HTTP ${contentRes.status}.`, {
            httpStatus: contentRes.status,
          });
        }
        const jsonlText = await readBoundedUtf8Response(contentRes, DEFAULT_MAX_BATCH_JSONL_BYTES, {
          requireStreamingOrContentLength: eff.isLiveTransport,
        });
        return { safeFileId, jsonlText, fileSha256: sha256Hex(Buffer.from(jsonlText, 'utf8')) };
      };

      let outId = null;
      let outputSha256 = null;
      if (sanitized.output_file_id) {
        const checkedOutId = assertSafeResourceId(sanitized.output_file_id, 'output_file_id');
        if (wasAlreadyCompletedBefore && manifest?.accepted_output_file_id && checkedOutId !== manifest.accepted_output_file_id) {
          throw new OpenAiBudgetError(
            `Settled Batch "${safeId}" output_file_id changed from "${manifest.accepted_output_file_id}" to "${checkedOutId}".`,
            { code: 'BATCH_OUTPUT_DIGEST_MISMATCH' },
          );
        }
        try {
          const downloadedOut = await downloadBatchFileContent(checkedOutId, 'output_file_id');
          outId = downloadedOut.safeFileId;
          outputSha256 = downloadedOut.fileSha256;

          // P1: Verify redownloaded Batch output matches the immutable accepted_output_sha256 recorded at settlement!
          if (wasAlreadyCompletedBefore && manifest?.accepted_output_sha256 && outputSha256 !== manifest.accepted_output_sha256) {
            throw new OpenAiBudgetError(
              `Settled Batch "${safeId}" redownloaded output SHA-256 (${outputSha256}) does not match accepted_output_sha256 (${manifest.accepted_output_sha256}).`,
              { code: 'BATCH_OUTPUT_DIGEST_MISMATCH' },
            );
          }

          parsedOutput = parseBatchOutputJsonl(downloadedOut.jsonlText, {
            allowAstraApi: eff.allowAstraApi,
            lineModels: manifest?.line_models ?? null,
            lineSpecs: manifest?.line_specs ?? null,
            expectedEndpoint: manifest?.endpoint ?? null,
            literalSecret: apiKey,
          });
        } catch (err) {
          if (err instanceof OpenAiBudgetError && err.code === 'BATCH_OUTPUT_DIGEST_MISMATCH') {
            throw err;
          }
          outputFileError = scrubTextForReceipt(err?.message || 'output_file_download_or_parse_error', apiKey);
          parsedOutput = null;
        }
      }

      if (sanitized.error_file_id) {
        try {
          const downloadedErr = await downloadBatchFileContent(sanitized.error_file_id, 'error_file_id');
          if (downloadedErr.jsonlText.trim().length > 0) {
            parsedError = parseBatchOutputJsonl(downloadedErr.jsonlText, {
              allowAstraApi: eff.allowAstraApi,
              lineModels: manifest?.line_models ?? null,
              lineSpecs: manifest?.line_specs ?? null,
              expectedEndpoint: manifest?.endpoint ?? null,
              literalSecret: apiKey,
            });
          }
        } catch (err) {
          errorFileError = scrubTextForReceipt(err?.message || 'error_file_download_or_parse_error', apiKey);
          parsedError = null;
        }
      }

      reconciliation = reconcileBatchFilesByCustomId({
        parsedOutput,
        parsedError,
        manifestCustomIds: Array.isArray(manifest?.custom_ids) ? manifest.custom_ids : null,
        batchStatus: sanitized.status,
        outputFileError,
        errorFileError,
      });

      if (boundAttempt) {
        const manifestIds = Array.isArray(manifest?.custom_ids) ? manifest.custom_ids : null;
        const rcTotal = sanitized.request_counts?.total;
        const rcCompleted = sanitized.request_counts?.completed;
        const rcFailed = sanitized.request_counts?.failed;
        const observedTotalLines = (parsedOutput?.total_lines ?? 0) + (parsedError?.total_lines ?? 0);
        const observedHttp200 = (parsedOutput?.http_200_count ?? 0) + (parsedError?.http_200_count ?? 0);
        const observedErrorLines = (parsedOutput?.error_line_count ?? 0) + (parsedError?.error_line_count ?? 0);

        const countMatches =
          Number.isSafeInteger(rcTotal) &&
          rcTotal === observedTotalLines &&
          manifestIds !== null &&
          manifestIds.length === observedTotalLines;

        // P0-02: Verify request_counts.completed + failed === total and match observed HTTP 200 / error line counts!
        const requestCountsParityOk =
          countMatches &&
          (
            (rcCompleted === undefined && rcFailed === undefined) ||
            (
              Number.isSafeInteger(rcCompleted) &&
              Number.isSafeInteger(rcFailed ?? 0) &&
              rcCompleted + (rcFailed ?? 0) === rcTotal &&
              rcCompleted === observedHttp200 &&
              (rcFailed ?? 0) === observedErrorLines
            )
          );

        const exactCustomIdSetMatch =
          countMatches &&
          reconciliation.duplicate_custom_ids.length === 0 &&
          reconciliation.unexpected_custom_ids.length === 0 &&
          reconciliation.missing_custom_ids.length === 0;

        if (wasAlreadyCompletedBefore) {
          if (outputFileError || errorFileError || !countMatches || !requestCountsParityOk || !exactCustomIdSetMatch) {
            throw new OpenAiBudgetError(
              `Settled Batch "${safeId}" redownloaded output failed manifest custom_ids or request_counts parity verification.`,
              { code: 'BATCH_OUTPUT_DIGEST_MISMATCH' },
            );
          }
        } else if (
          sanitized.status === 'completed' &&
          !outputFileError &&
          !errorFileError &&
          (parsedOutput !== null || parsedError !== null) &&
          countMatches &&
          requestCountsParityOk &&
          exactCustomIdSetMatch &&
          !reconciliation.has_unknown_usage &&
          reconciliation.total_usage_cost_micros !== null
        ) {
          const combinedResults = [
            ...(parsedOutput?.results ?? []),
            ...(parsedError?.results ?? []),
          ];
          const combinedContentStatus =
            parsedError === null && parsedOutput !== null
              ? parsedOutput.content_status
              : (reconciliation.succeeded_count === reconciliation.total_expected
                ? 'usable'
                : (reconciliation.succeeded_count === 0 ? 'invalid' : 'incomplete'));
          eff.ledger.recordTerminalOutcome(boundAttempt.attempt_id, {
            status: 'completed',
            contentStatus: combinedContentStatus,
            usageCostMicros: reconciliation.total_usage_cost_micros,
            usage: summarizeSettledBatchUsage(combinedResults),
            providerResponseId: safeId,
            httpStatus: 200,
            rawReceipt: sanitized,
            originalBodySha256: batchGetOrigSha,
            ...(outputSha256 ? { acceptedOutputSha256: outputSha256 } : {}),
            ...(outId ? { acceptedOutputFileId: outId } : {}),
          });
        } else {
          let holdReason;
          if (outputFileError || errorFileError) {
            const parts = [
              outputFileError ? `output_file error: ${outputFileError}` : null,
              errorFileError ? `error_file error: ${errorFileError}` : null,
            ].filter(Boolean);
            holdReason = `Batch "${safeId}" encountered artifact retrieval/parse failure (${parts.join('; ')}); preserved any valid partial results/spend and retained pending_recovery fence.`;
          } else if (sanitized.status !== 'completed') {
            holdReason = `Batch "${safeId}" ended with status "${sanitized.status}" (succeeded=${reconciliation.succeeded_count}, failed=${reconciliation.failed_count}, missing=${reconciliation.missing_count}); preserved partial outputs/errors and retained pending_recovery fence until reconciled.`;
          } else if (reconciliation.duplicate_custom_ids.length > 0) {
            holdReason = `Batch "${safeId}" had duplicate custom_ids across output and error files (${reconciliation.duplicate_custom_ids.length}); retaining pending_recovery fence.`;
          } else if (sanitized.error_file_id && reconciliation.has_unknown_usage) {
            holdReason = `Batch "${safeId}" includes error_file_id "${String(sanitized.error_file_id)}" with unknown error-line usage (succeeded=${reconciliation.succeeded_count}, failed=${reconciliation.failed_count}); reconciled partial output & error items and retained pending_recovery fence until settled.`;
          } else if (!countMatches || !exactCustomIdSetMatch) {
            holdReason = `Batch "${safeId}" output lines (${observedTotalLines}) or custom_ids did not match manifest/request_counts.total (${String(rcTotal)}); retaining pending_recovery fence.`;
          } else if (!requestCountsParityOk) {
            holdReason = `Batch "${safeId}" request_counts (completed=${String(rcCompleted)}, failed=${String(rcFailed)}, total=${String(rcTotal)}) contradicted observed output lines (http_200=${observedHttp200}, errors=${observedErrorLines}); retaining pending_recovery fence.`;
          } else {
            holdReason = `Batch "${safeId}" output contained nonterminal or unknown per-line usage; retaining pending_recovery fence.`;
          }

          const latestRow = eff.ledger.getAttemptById(boundAttempt.attempt_id);
          if (latestRow && (latestRow.status === 'in_progress' || latestRow.status === 'pending_recovery')) {
            eff.ledger.markPendingRecovery(boundAttempt.attempt_id, {
              providerResponseId: safeId,
              httpStatus: 200,
              provisionalUsageCostMicros: reconciliation.known_usage_cost_micros > 0 ? reconciliation.known_usage_cost_micros : null,
              rawReceipt: sanitized,
              originalBodySha256: batchGetOrigSha,
              reason: holdReason,
            });
          }
        }
      }
    } else if (eff.downloadOutput === true && isTerminalBatchStatus && !hasDownloadableArtifact) {
      const manifest = boundAttempt?.batch_manifest ?? null;
      if (Array.isArray(manifest?.custom_ids) && manifest.custom_ids.length > 0) {
        reconciliation = reconcileBatchFilesByCustomId({
          parsedOutput: null,
          parsedError: null,
          manifestCustomIds: manifest.custom_ids,
          batchStatus: sanitized.status,
        });
      }
      if (boundAttempt && !wasAlreadyCompletedBefore) {
        const latestRow = eff.ledger.getAttemptById(boundAttempt.attempt_id);
        if (latestRow && (latestRow.status === 'in_progress' || latestRow.status === 'pending_recovery')) {
          eff.ledger.markPendingRecovery(boundAttempt.attempt_id, {
            providerResponseId: safeId,
            httpStatus: 200,
            rawReceipt: sanitized,
            originalBodySha256: batchGetOrigSha,
            reason: `Terminal Batch "${safeId}" (status=${sanitized.status}) omitted both output_file_id and error_file_id; retaining pending_recovery fence.`,
          });
        }
      }
    }

    const refreshedAttempt = boundAttempt ? eff.ledger.getAttemptById(boundAttempt.attempt_id) : null;
    const effectiveLedgerStatus = refreshedAttempt
      ? refreshedAttempt.status
      : (sanitized.status === 'completed' && !outputFileError && !errorFileError ? 'completed' : 'pending_recovery');
    const isFenced = refreshedAttempt
      ? (refreshedAttempt.status === 'pending_recovery' || refreshedAttempt.status === 'in_progress')
      : Boolean(outputFileError || errorFileError);

    return {
      ok: refreshedAttempt
        ? refreshedAttempt.status === 'completed'
        : (!outputFileError && !errorFileError),
      status: effectiveLedgerStatus,
      fenced: isFenced,
      ...(wasAlreadyCompletedBefore ? { already_settled: true } : {}),
      http_status: res.status,
      ...(boundAttempt ? { attempt_id: boundAttempt.attempt_id } : {}),
      batch_id: safeId,
      batch_status: sanitized.status,
      output_file_id: sanitized.output_file_id ?? null,
      error_file_id: sanitized.error_file_id ?? null,
      batch: sanitized,
      ...(Array.isArray(sanitized.errors?.data) && sanitized.errors.data.length > 0 ? { batch_errors: sanitized.errors.data } : {}),
      ...(outputFileError ? { output_file_error: outputFileError } : {}),
      ...(errorFileError ? { error_file_error: errorFileError } : {}),
      parsed_output: parsedOutput,
      parsed_error: parsedError,
      reconciliation,
    };
  }
}

// -----------------------------------------------------------------------------
// Convenience Standalone Wrappers
// -----------------------------------------------------------------------------

export async function createDecision(params, policy = {}) {
  return new OpenAiClient(policy).createDecision(params, policy);
}

export async function createResponse(params, policy = {}) {
  return new OpenAiClient(policy).createResponse(params, policy);
}

export async function pollBackgroundResponse(attemptIdOrOptions, policy = {}) {
  const options = isPlainObject(attemptIdOrOptions) ? attemptIdOrOptions : policy;
  return new OpenAiClient(options).pollBackgroundResponse(attemptIdOrOptions, policy);
}

export async function cancelResponse(attemptIdOrResponseId, policy = {}) {
  const options = isPlainObject(attemptIdOrResponseId) ? attemptIdOrResponseId : policy;
  return new OpenAiClient(options).cancelResponse(attemptIdOrResponseId, policy);
}

export async function retrieveResponse(responseId, policy = {}) {
  return new OpenAiClient(policy).retrieveResponse(responseId, policy);
}

export async function deleteResponse(responseId, policy = {}) {
  return new OpenAiClient(policy).deleteResponse(responseId, policy);
}

export async function recoverPendingResponse(attemptIdOrLogicalId, policy = {}) {
  return new OpenAiClient(policy).recoverPendingResponse(attemptIdOrLogicalId, policy);
}

export async function uploadBatchFile(params, policy = {}) {
  return new OpenAiClient(policy).uploadBatchFile(params, policy);
}

export async function submitBatch(params, policy = {}) {
  return new OpenAiClient(policy).submitBatch(params, policy);
}

export async function retrieveBatch(batchId, policy = {}) {
  return new OpenAiClient(policy).retrieveBatch(batchId, policy);
}
