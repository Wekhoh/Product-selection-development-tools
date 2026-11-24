/**
 * SQLite-backed OpenAI API natural-month spend ledger, zero-auto-retry duplicate
 * guard, and strictly read-only legacy budget.sqlite3 inspector.
 *
 * Uses Node.js >= 24 built-in `node:sqlite` (`DatabaseSync`) with WAL mode,
 * `busy_timeout = 5000`, and `BEGIN IMMEDIATE` transactions. Can share
 * `.local/state/selection.sqlite` alongside `SelectionStore` or run standalone.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertNoRawPii,
  containsSecretToken,
  detectRawPii,
  sanitizeDiagnosticText,
} from '../contracts.mjs';
import { canonicalJson, sha256Hex } from '../store.mjs';
import { hasPersistedBackgroundTerminal } from './background.mjs';
import {
  OpenAiError,
  OpenAiPolicyError,
  OpenAiValidationError,
  microsToCeilingCents,
} from './pricing.mjs';

export const MAX_MONTHLY_LIMIT_CENTS = 20_000; // Hard $200.00 / month non-rollover ceiling
export const DEFAULT_MONTHLY_LIMIT_CENTS = MAX_MONTHLY_LIMIT_CENTS;
export const MAX_SAME_MONTH_PENDING_BUFFER_CENTS = 2_000;
export const MAX_PERSISTED_RAW_BODY_BYTES = 262_144; // 256 KiB bounded UTF-8 body in SQLite
export const MAX_LEGACY_INSPECT_ROWS = 250_000; // Hard streaming row cap for legacy SQLite inspection

export const OPENAI_LEDGER_STATUSES = Object.freeze([
  'not_submitted',
  'in_progress',
  'completed',
  'rejected',
  'failed_known',
  'pending_recovery',
]);

export const OPENAI_CONTENT_STATUSES = Object.freeze([
  'usable',
  'incomplete',
  'invalid',
  'refused',
]);

export const OPENAI_BASELINE_MODES = Object.freeze([
  'unreconciled',
  'synthetic_test_only',
  'verified_production',
]);

const CLEANUP_STATUSES = Object.freeze([
  'not_requested',
  'pending_cleanup',
  'deleted_verified_404',
  'delete_failed',
]);

const MONTH_UTC_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_ONLY_UTC_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const STRICT_ISO_TIMESTAMP_RE =
  /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/;
const SQLITE_NAIVE_UTC_TIMESTAMP_RE =
  /^(\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const ACCOUNT_SCOPE_ALLOWLIST_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
const SAFE_SHORT_LABEL_RE = /^[A-Za-z0-9_/][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_RESOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/;
const SAFE_ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._:\-[\]]{1,255}$/i;
const SAFE_API_BASE_URL_RE = /^https?:\/\/[A-Za-z0-9._:\-[\]]{1,255}(?:\/[A-Za-z0-9._~:@!$&'()*+,;=-]+)*$/i;
const TOKEN_PREFIX_RE = /^(?:s[k]-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[bpas]-|AIza|AKIA|ASIA|eyJ|pk_live_|rk_live_)/i;
const SECRET_LIKE_RE = /(?:bearer\s+\S+|api[_-]?key\s*=|authorization\s*:|cookie\s*=|password\s*=|token\s*=\s*\S+)/i;
const SAFE_SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Module-private cryptographic brand recording verified legacy inspections.
const VERIFIED_INSPECTIONS = new WeakMap();
let lastInspectionStampMs = 0;
let registeredClientUploadAuthority = null;

export function _bindInternalUploadLifecycleAuthority(authorityToken) {
  if (typeof authorityToken !== 'symbol') {
    throw new OpenAiValidationError('authorityToken must be a private Symbol.');
  }
  if (registeredClientUploadAuthority !== null) {
    throw new OpenAiPolicyError('Internal upload lifecycle authority is already bound.');
  }
  registeredClientUploadAuthority = authorityToken;
}

function nextInspectionStampMs() {
  const now = Date.now();
  lastInspectionStampMs = now > lastInspectionStampMs ? now : lastInspectionStampMs + 1;
  return lastInspectionStampMs;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      deepFreeze(value[i], seen);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(value[key], seen);
    }
  }
  return Object.freeze(value);
}

function incrementHistogramCount(map, key, delta = 1) {
  const prev = Object.hasOwn(map, key) ? map[key] : 0;
  Object.defineProperty(map, key, {
    value: prev + delta,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function setNullProtoProp(map, key, value) {
  Object.defineProperty(map, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return map;
}

export class OpenAiBudgetError extends OpenAiError {
  constructor(message, { code = 'OPENAI_BUDGET_ERROR', notDispatched = true, details = null } = {}) {
    super(message, { code, notDispatched, details });
  }
}

export function currentMonthUtc(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new OpenAiValidationError('Invalid date supplied to currentMonthUtc.');
  }
  return d.toISOString().slice(0, 7);
}

export function assertValidMonthUtc(monthUtc, label = 'month_utc') {
  if (typeof monthUtc !== 'string' || !MONTH_UTC_RE.test(monthUtc.trim())) {
    throw new OpenAiValidationError(`${label} must be a valid UTC month in YYYY-MM format.`);
  }
  return monthUtc.trim();
}

function isRealCalendarDateYmd(ymd) {
  if (!DATE_ONLY_UTC_RE.test(ymd)) return false;
  const check = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === ymd;
}

/**
 * Timezone-aware UTC month extractor (`YYYY-MM`).
 *  - Direct slice `0..7` ONLY when `rawValue` is strict `YYYY-MM` or strict calendar `YYYY-MM-DD` without time/offset.
 *  - Any timestamp with time (`T` or space) is parsed as an exact UTC instant (`new Date(...)`, appending `'Z'`
 *    only when SQLite `'YYYY-MM-DD HH:MM:SS'` lacks `'Z'`/`+/-HH:MM`), so `'2026-11-01T00:30:00+02:00'` -> `'2026-10'`.
 *  - Returns `null` when unparseable or empty.
 */
export function extractMonthPrefix(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue) || rawValue <= 946684800) return null;
    const ms = rawValue > 1e11 ? rawValue : rawValue * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
  }
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (MONTH_UTC_RE.test(trimmed)) {
    return trimmed;
  }
  if (DATE_ONLY_UTC_RE.test(trimmed)) {
    return isRealCalendarDateYmd(trimmed) ? trimmed.slice(0, 7) : null;
  }

  if (!/^\d{4}-\d{2}-\d{2}[Tt\s]/.test(trimmed)) {
    return null;
  }

  let iso = trimmed.replace(/^(\d{4}-\d{2}-\d{2})[t\s]+/, '$1T');
  if (/[+-](?:[01]\d|2[0-3])$/.test(iso)) {
    iso = `${iso}:00`;
  } else if (/[+-](?:[01]\d|2[0-3])[0-5]\d$/.test(iso)) {
    iso = iso.replace(/([+-](?:[01]\d|2[0-3]))([0-5]\d)$/, '$1:$2');
  } else if (SQLITE_NAIVE_UTC_TIMESTAMP_RE.test(iso)) {
    iso = `${iso}Z`;
  }

  const m = iso.match(STRICT_ISO_TIMESTAMP_RE);
  if (!m) return null;
  const ymdPart = m[1];
  if (!isRealCalendarDateYmd(ymdPart)) return null;

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 7);
}

export function assertSafeOpenAiAccountScope(scope) {
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new OpenAiValidationError('account_scope must be a nonempty non-sensitive scope label.');
  }
  const trimmed = scope.trim();
  if (!ACCOUNT_SCOPE_ALLOWLIST_RE.test(trimmed) || TOKEN_PREFIX_RE.test(trimmed) || SECRET_LIKE_RE.test(trimmed)) {
    throw new OpenAiPolicyError(
      'account_scope must be a short non-sensitive scope identifier, never a credential or token.',
      { code: 'UNSAFE_ACCOUNT_SCOPE' },
    );
  }
  if (trimmed.length >= 24 && /[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed) && /\d/.test(trimmed) && !trimmed.includes('-')) {
    throw new OpenAiPolicyError(
      'account_scope appears to contain a raw token; use a non-sensitive scope label.',
      { code: 'UNSAFE_ACCOUNT_SCOPE' },
    );
  }
  assertNoRawPii(trimmed, 'account_scope');
  if (containsSecretToken(trimmed)) {
    throw new OpenAiPolicyError('account_scope must not contain secret tokens.', { code: 'UNSAFE_ACCOUNT_SCOPE' });
  }
  return trimmed;
}

export function assertSafeShortLabel(value, label = 'label', maxLength = 128) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OpenAiValidationError(`${label} must be a nonempty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength || /[\r\n\0\s]/.test(trimmed) || !SAFE_SHORT_LABEL_RE.test(trimmed)) {
    throw new OpenAiValidationError(`${label} must be a compact safe identifier (<= ${maxLength} chars, no whitespace or control characters).`);
  }
  if (TOKEN_PREFIX_RE.test(trimmed) || SECRET_LIKE_RE.test(trimmed)) {
    throw new OpenAiPolicyError(`${label} must not contain credentials or secret tokens.`, {
      code: 'SECRET_TOKEN_DETECTED',
    });
  }
  assertSafeStoredValue(trimmed, label);
  return trimmed;
}

function assertSafeOrigin(origin) {
  if (origin === null || origin === undefined) return null;
  if (typeof origin !== 'string' || !SAFE_ORIGIN_RE.test(origin.trim())) {
    throw new OpenAiValidationError('origin must be a valid HTTP(S) origin string.');
  }
  const clean = origin.trim();
  assertSafeStoredValue(clean, 'origin');
  return clean;
}

function assertSafeApiBaseUrl(apiBaseUrl) {
  if (apiBaseUrl === null || apiBaseUrl === undefined) return null;
  if (typeof apiBaseUrl !== 'string' || !apiBaseUrl.trim()) {
    throw new OpenAiValidationError('apiBaseUrl must be a nonempty HTTP(S) base URL string.');
  }
  const clean = apiBaseUrl.trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(clean);
  } catch {
    throw new OpenAiValidationError('apiBaseUrl must be a valid absolute HTTP(S) URL.');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !SAFE_API_BASE_URL_RE.test(clean)
  ) {
    throw new OpenAiValidationError('apiBaseUrl must be a clean HTTP(S) base route without credentials, query, or hash.');
  }
  assertSafeStoredValue(clean, 'apiBaseUrl');
  return clean;
}

function generatePiiSafeUuid() {
  for (let i = 0; i < 64; i++) {
    const id = randomUUID();
    if (!detectRawPii(id)) return id;
  }
  throw new OpenAiError('Unable to generate PII-safe UUID after 64 attempts.');
}

const SHA256_HEX_WORD_RE = /\b[0-9a-f]{64}\b/gi;
const UUID_HEX_WORD_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function maskHexIdsForPiiScan(value, seen = new Map(), depth = 0) {
  if (value === null || value === undefined || depth > 6) return value;
  if (typeof value === 'string') {
    return value
      .replace(SHA256_HEX_WORD_RE, '0'.repeat(64))
      .replace(UUID_HEX_WORD_RE, '00000000-0000-0000-0000-000000000000');
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const arr = [];
    seen.set(value, arr);
    for (let i = 0; i < value.length; i++) {
      arr.push(maskHexIdsForPiiScan(value[i], seen, depth + 1));
    }
    return arr;
  }
  const copy = Object.create(null);
  seen.set(value, copy);
  for (const [k, v] of Object.entries(value)) {
    Object.defineProperty(copy, k, {
      value: maskHexIdsForPiiScan(v, seen, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function assertSafeStoredValue(value, label) {
  if (value === null || value === undefined) return;
  assertNoRawPii(maskHexIdsForPiiScan(value), label);
  if (containsSecretToken(value)) {
    throw new OpenAiPolicyError(
      `${label} contains a credential or secret token; redact before persisting to SQLite.`,
      { code: 'SECRET_TOKEN_DETECTED' },
    );
  }
}

function sanitizeSafeNote(text, label = 'note') {
  if (text === null || text === undefined) return null;
  let cleaned = sanitizeDiagnosticText(String(text));
  cleaned = cleaned.replace(/\bBearer\s+\S+/gi, '[REDACTED_BEARER]').trim();
  if (!cleaned) return null;
  assertSafeStoredValue(cleaned, label);
  return cleaned;
}

function truncateUtf8Safe(text, maxBytes = MAX_PERSISTED_RAW_BODY_BYTES) {
  if (typeof text !== 'string') return null;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

function sanitizeBoundedRawBody(rawBodyText) {
  if (rawBodyText === null || rawBodyText === undefined) return null;
  let cleaned = sanitizeDiagnosticText(String(rawBodyText));
  cleaned = cleaned.replace(/\bBearer\s+\S+/gi, '[REDACTED_BEARER]');
  cleaned = truncateUtf8Safe(cleaned, MAX_PERSISTED_RAW_BODY_BYTES);
  assertSafeStoredValue(cleaned, 'rawBodyText');
  return cleaned;
}

function sanitizeDisplayPath(rawPath) {
  if (!rawPath || rawPath === ':memory:' || rawPath === ':borrowed:') return rawPath || ':memory:';
  const str = String(rawPath);
  const cwd = resolve(process.cwd());
  if (isAbsolute(str)) {
    const rel = relative(cwd, resolve(str)).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      const cleanedRel = sanitizeDiagnosticText(rel);
      assertSafeStoredValue(cleanedRel, 'db_path');
      return cleanedRel;
    }
    const safeBase = sanitizeDiagnosticText(basename(str));
    return `[REDACTED_PATH]/${safeBase}`;
  }
  const norm = sanitizeDiagnosticText(str.replace(/\\/g, '/'));
  if (containsSecretToken(norm)) return '[REDACTED_PATH]';
  try {
    assertNoRawPii(norm, 'db_path');
    return norm;
  } catch {
    return `[REDACTED_PATH]/${sanitizeDiagnosticText(basename(str))}`;
  }
}

function normalizeFilesystemPathInput(rawPath) {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === ':memory:' || trimmed === ':borrowed:') return null;
  if (trimmed.startsWith('file:')) {
    try {
      const u = new URL(trimmed);
      u.search = '';
      u.hash = '';
      return resolve(fileURLToPath(u));
    } catch {
      return null;
    }
  }
  return resolve(trimmed);
}

function realpathNativeSafe(p) {
  return typeof realpathSync.native === 'function' ? realpathSync.native(p) : realpathSync(p);
}

function resolveCanonicalFileOrAncestorPath(absPath) {
  try {
    return realpathNativeSafe(absPath);
  } catch {
    const parts = [];
    let cur = absPath;
    while (true) {
      const parent = dirname(cur);
      if (parent === cur) {
        return absPath;
      }
      parts.unshift(basename(cur));
      cur = parent;
      try {
        const realParent = realpathNativeSafe(cur);
        return resolve(realParent, ...parts);
      } catch {
        // Continue climbing.
      }
    }
  }
}

/**
 * Determine whether two SQLite file paths resolve to the same physical file,
 * catching relative segments, symlinks, NTFS directory junctions, AND hard links (`dev` + `ino`).
 */
export function areSamePhysicalSqliteFile(pathA, pathB) {
  const absA = normalizeFilesystemPathInput(pathA);
  const absB = normalizeFilesystemPathInput(pathB);
  if (!absA || !absB) return false;

  const canonA = resolveCanonicalFileOrAncestorPath(absA);
  const canonB = resolveCanonicalFileOrAncestorPath(absB);
  const keyA = process.platform === 'win32' ? canonA.toLowerCase() : canonA;
  const keyB = process.platform === 'win32' ? canonB.toLowerCase() : canonB;
  if (keyA === keyB) return true;

  try {
    const stA = statSync(absA, { bigint: true });
    const stB = statSync(absB, { bigint: true });
    if (stA.ino !== 0n && stB.ino !== 0n && stA.dev === stB.dev && stA.ino === stB.ino) {
      return true;
    }
  } catch {
    // One or both paths do not exist yet; canonical path check above is authoritative.
  }
  return false;
}

function queryMainFileFromDatabaseSync(db) {
  const rows = db.prepare('PRAGMA database_list').all();
  const mainRow = rows.find(r => String(r?.name) === 'main');
  const rawFile = typeof mainRow?.file === 'string' ? mainRow.file.trim() : '';
  if (!rawFile) return '';
  return normalizeFilesystemPathInput(rawFile) ?? rawFile;
}

function assertSha256Hex(hash, label = 'sha256') {
  if (typeof hash !== 'string' || !HEX_SHA256_RE.test(hash)) {
    throw new OpenAiValidationError(`${label} must be a 64-character lowercase hex SHA-256 digest.`);
  }
  return hash;
}

function assertNonNegInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OpenAiValidationError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function assertPositiveInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpenAiValidationError(`${label} must be a positive safe integer (>= 1).`);
  }
  return value;
}

function validateMonthlyLimitCents(value, label = 'monthlyLimitCents') {
  assertNonNegInt(value, label);
  if (value > MAX_MONTHLY_LIMIT_CENTS) {
    throw new OpenAiPolicyError(
      `${label} (${value}) exceeds MAX_MONTHLY_LIMIT_CENTS (${MAX_MONTHLY_LIMIT_CENTS} = $200.00/month ceiling).`,
      { code: 'MONTHLY_LIMIT_EXCEEDS_CEILING' },
    );
  }
  return value;
}

function isValidSameMonthPendingBuffer(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAME_MONTH_PENDING_BUFFER_CENTS;
}

function validateSameMonthPendingBuffer(value, label = 'sameMonthPendingBufferCents') {
  if (!isValidSameMonthPendingBuffer(value)) {
    throw new OpenAiValidationError(
      `${label} must be an integer from 0 to ${MAX_SAME_MONTH_PENDING_BUFFER_CENTS} cents.`,
      { code: 'INVALID_SAME_MONTH_PENDING_BUFFER' },
    );
  }
  return value;
}

function resolveSameMonthPendingBufferOverride(buffer, maxRecovery) {
  if (buffer !== undefined) validateSameMonthPendingBuffer(buffer);
  if (maxRecovery !== undefined) validateSameMonthPendingBuffer(maxRecovery, 'maxSameMonthPendingRecoveryCents');
  if (buffer !== undefined && maxRecovery !== undefined && buffer !== maxRecovery) {
    throw new OpenAiValidationError('sameMonthPendingBufferCents and maxSameMonthPendingRecoveryCents must agree.');
  }
  return buffer ?? maxRecovery;
}

function assertSafeProviderResourceId(value) {
  if (typeof value !== 'string' || !SAFE_RESOURCE_ID_RE.test(value.trim())) {
    throw new OpenAiValidationError('providerResponseId must be a safe resource identifier.');
  }
  return assertSafeShortLabel(value, 'providerResponseId');
}

function isTransientSqliteOpenContention(error) {
  const code = Number(error?.errcode);
  if (!Number.isFinite(code)) return false;
  const base = code & 0xff;
  if (base === 5 || base === 6) return true;
  return code === 1546 || code === 3850 || code === 4874 || code === 5130 || code === 5386 || code === 5642;
}

function sleepSyncMs(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(1, Math.trunc(ms)));
}

const SAME_MONTH_PENDING_BUFFER_SQL = `INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(same_month_pending_buffer_cents) = 'integer'
    AND same_month_pending_buffer_cents BETWEEN 0 AND ${MAX_SAME_MONTH_PENDING_BUFFER_CENTS})`;
const BACKGROUND_MODE_SQL = 'INTEGER NOT NULL DEFAULT 0 CHECK(background_mode IN (0, 1))';

const OPENAI_LEDGER_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS openai_ledger_identity (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  ledger_instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS openai_budget_policy (
  account_scope TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  monthly_limit_cents INTEGER NOT NULL DEFAULT 20000 CHECK(monthly_limit_cents >= 0 AND monthly_limit_cents <= 20000),
  same_month_pending_buffer_cents ${SAME_MONTH_PENDING_BUFFER_SQL},
  auto_recharge_off_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(auto_recharge_off_confirmed IN (0, 1)),
  hard_monthly_limit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(hard_monthly_limit_confirmed IN (0, 1)),
  credential_fingerprint_sha256 TEXT,
  baseline_mode TEXT NOT NULL DEFAULT 'unreconciled' CHECK(baseline_mode IN ('unreconciled', 'synthetic_test_only', 'verified_production')),
  legacy_reconciled INTEGER NOT NULL DEFAULT 0 CHECK(legacy_reconciled IN (0, 1)),
  legacy_reconciled_month_utc TEXT,
  reconciled_snapshot_month_utc TEXT,
  legacy_carryover_cents INTEGER NOT NULL DEFAULT 0 CHECK(legacy_carryover_cents >= 0),
  legacy_source_sha256 TEXT,
  legacy_budget_sha256 TEXT,
  legacy_source_path_sha256 TEXT,
  legacy_source_dev TEXT,
  legacy_source_ino TEXT,
  legacy_all_months_complete INTEGER NOT NULL DEFAULT 0 CHECK(legacy_all_months_complete IN (0, 1)),
  legacy_inspected_at_ms INTEGER,
  legacy_summary_json TEXT,
  legacy_reconciled_at TEXT,
  allow_stage4_media INTEGER NOT NULL DEFAULT 0 CHECK(allow_stage4_media IN (0, 1)),
  policy_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS openai_legacy_carryover (
  account_scope TEXT NOT NULL,
  month_utc TEXT NOT NULL,
  carryover_cents INTEGER NOT NULL CHECK(carryover_cents >= 0),
  source_sha256 TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, month_utc)
);

CREATE TABLE IF NOT EXISTS openai_batch_uploads (
  account_scope TEXT NOT NULL,
  uploaded_file_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  origin TEXT NOT NULL,
  api_base_url TEXT,
  credential_fingerprint_sha256 TEXT,
  jsonl_sha256 TEXT NOT NULL,
  line_count INTEGER NOT NULL CHECK(line_count >= 1),
  estimated_reservation_cents INTEGER NOT NULL CHECK(estimated_reservation_cents >= 1),
  manifest_json TEXT NOT NULL,
  source_attempt_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, uploaded_file_id)
);

CREATE TABLE IF NOT EXISTS openai_private_payloads (
  attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  raw_bytes BLOB NOT NULL,
  raw_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, stage)
);

CREATE TABLE IF NOT EXISTS openai_request_ledger (
  attempt_id TEXT PRIMARY KEY,
  logical_request_id TEXT NOT NULL UNIQUE,
  account_scope TEXT NOT NULL,
  month_utc TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  service_tier TEXT NOT NULL DEFAULT 'standard',
  origin TEXT,
  api_base_url TEXT,
  credential_fingerprint_sha256 TEXT,
  store_mode INTEGER NOT NULL DEFAULT 1 CHECK(store_mode IN (0, 1)),
  background_mode ${BACKGROUND_MODE_SQL},
  background_cancel_dispatched_at TEXT,
  background_delete_dispatched_at TEXT,
  background_usage_floor_micros INTEGER CHECK(background_usage_floor_micros IS NULL OR background_usage_floor_micros >= 0),
  background_search_floor_micros INTEGER NOT NULL DEFAULT 0 CHECK(background_search_floor_micros >= 0),
  background_token_floor_micros INTEGER NOT NULL DEFAULT 0 CHECK(background_token_floor_micros >= 0),
  response_format_json TEXT,
  payload_sha256 TEXT NOT NULL,
  packet_sha256 TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'not_submitted',
    'in_progress',
    'completed',
    'rejected',
    'failed_known',
    'pending_recovery'
  )),
  content_status TEXT CHECK(content_status IS NULL OR content_status IN (
    'usable',
    'incomplete',
    'invalid',
    'refused'
  )),
  reserved_cents INTEGER NOT NULL CHECK(reserved_cents >= 0),
  estimated_input_tokens INTEGER CHECK(estimated_input_tokens IS NULL OR estimated_input_tokens >= 0),
  max_output_tokens INTEGER CHECK(max_output_tokens IS NULL OR max_output_tokens >= 0),
  max_web_search_calls INTEGER NOT NULL DEFAULT 0 CHECK(max_web_search_calls >= 0),
  usage_cost_micros INTEGER CHECK(usage_cost_micros IS NULL OR usage_cost_micros >= 0),
  provisional_usage_cost_micros INTEGER CHECK(provisional_usage_cost_micros IS NULL OR provisional_usage_cost_micros >= 0),
  posted_billed_cents INTEGER CHECK(posted_billed_cents IS NULL OR posted_billed_cents >= 0),
  confirmed_zero_charge INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_zero_charge IN (0, 1)),
  confirmed_not_created_remotely INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_not_created_remotely IN (0, 1)),
  usage_json TEXT,
  provisional_usage_json TEXT,
  provider_response_id TEXT,
  provider_model TEXT,
  http_status INTEGER,
  cleanup_required INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_required IN (0, 1)),
  cleanup_status TEXT CHECK(cleanup_status IS NULL OR cleanup_status IN (
    'not_requested',
    'pending_cleanup',
    'deleted_verified_404',
    'delete_failed'
  )),
  terminal_outcome_status TEXT CHECK(terminal_outcome_status IS NULL OR terminal_outcome_status IN (
    'completed',
    'failed_known'
  )),
  delete_ack_at TEXT,
  delete_ack_receipt_json TEXT,
  cleanup_404_receipt_json TEXT,
  batch_manifest_json TEXT,
  raw_receipt_json TEXT,
  raw_receipt_sha256 TEXT,
  original_body_sha256 TEXT,
  raw_body_text TEXT,
  raw_body_sha256 TEXT,
  recovery_history_json TEXT,
  diagnostic_reason TEXT,
  reconciliation_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK(status NOT IN ('in_progress', 'pending_recovery') OR reserved_cents >= 0)
);
`;

const OPENAI_LEDGER_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_openai_ledger_scope_status
  ON openai_request_ledger(account_scope, status);
CREATE INDEX IF NOT EXISTS idx_openai_ledger_scope_month
  ON openai_request_ledger(account_scope, month_utc);
CREATE INDEX IF NOT EXISTS idx_openai_ledger_provider_resp
  ON openai_request_ledger(provider_response_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_openai_ledger_unique_endpoint_resp
  ON openai_request_ledger(endpoint, provider_response_id)
  WHERE provider_response_id IS NOT NULL;
`;

const COMPAT_SUMMARY_COLUMN_DEFAULTS = Object.freeze([
  ['attempt_id', 'NULL'],
  ['logical_request_id', 'NULL'],
  ['account_scope', 'NULL'],
  ['month_utc', 'NULL'],
  ['endpoint', 'NULL'],
  ['model', 'NULL'],
  ['service_tier', "'standard'"],
  ['origin', 'NULL'],
  ['api_base_url', 'NULL'],
  ['credential_fingerprint_sha256', 'NULL'],
  ['store_mode', '1'],
  ['background_mode', '0'],
  ['background_cancel_dispatched_at', 'NULL'],
  ['background_delete_dispatched_at', 'NULL'],
  ['response_format_json', 'NULL'],
  ['payload_sha256', 'NULL'],
  ['packet_sha256', 'NULL'],
  ['status', 'NULL'],
  ['content_status', 'NULL'],
  ['reserved_cents', '0'],
  ['estimated_input_tokens', 'NULL'],
  ['max_output_tokens', 'NULL'],
  ['max_web_search_calls', '0'],
  ['usage_cost_micros', 'NULL'],
  ['provisional_usage_cost_micros', 'NULL'],
  ['background_usage_floor_micros', 'NULL'],
  ['posted_billed_cents', 'NULL'],
  ['confirmed_zero_charge', '0'],
  ['confirmed_not_created_remotely', '0'],
  ['provider_response_id', 'NULL'],
  ['provider_model', 'NULL'],
  ['http_status', 'NULL'],
  ['cleanup_status', 'NULL'],
  ['terminal_outcome_status', 'NULL'],
  ['delete_ack_at', 'NULL'],
  ['raw_receipt_sha256', 'NULL'],
  ['original_body_sha256', 'NULL'],
  ['raw_body_sha256', 'NULL'],
  ['diagnostic_reason', 'NULL'],
  ['reconciliation_note', 'NULL'],
  ['created_at', 'NULL'],
  ['updated_at', 'NULL'],
  ['finished_at', 'NULL'],
]);

// -----------------------------------------------------------------------------
// Legacy Autopilot budget.sqlite3 Strictly Read-Only Inspector & Reconciler
// -----------------------------------------------------------------------------

const LEGACY_COMPLETED_STATUSES = new Set([
  'complete',
  'completed',
  'succeeded',
  'settled',
]);

const LEGACY_UNSUBMITTED_ZERO_STATUSES = new Set([
  'not_submitted',
  'released',
  'voided',
]);

const LEGACY_FAILED_OR_CANCELLED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'failed',
  'error',
  'expired',
  'rejected',
  'failed_known',
]);

const PUBLIC_KNOWN_LEGACY_STATUS_LABELS = new Set([
  ...OPENAI_LEDGER_STATUSES,
  ...LEGACY_COMPLETED_STATUSES,
  ...LEGACY_UNSUBMITTED_ZERO_STATUSES,
  ...LEGACY_FAILED_OR_CANCELLED_STATUSES,
  'pending',
  'queued',
  'running',
  'validating',
  'finalizing',
  'cancelling',
  'unknown_needs_reconciliation',
  'active_lock',
  'released_lock',
  'unknown',
]);

function computeCanonicalPathSha256(absOrCanonicalPath) {
  const canon = resolveCanonicalFileOrAncestorPath(resolve(absOrCanonicalPath));
  const key = process.platform === 'win32' ? canon.toLowerCase() : canon;
  return {
    canonicalPath: canon,
    normPathKey: key,
    pathSha256: sha256Hex(key),
  };
}

function computePhysicalIdentityRecord(filePath) {
  const { canonicalPath, normPathKey, pathSha256 } = computeCanonicalPathSha256(filePath);
  let devStr = null;
  let inoStr = null;
  try {
    const st = statSync(canonicalPath, { bigint: true });
    if (st.ino !== 0n) {
      devStr = String(st.dev);
      inoStr = String(st.ino);
    }
  } catch {
    // File may not exist yet.
  }
  return { canonicalPath, normPathKey, pathSha256, devStr, inoStr };
}

function reverifyLegacySnapshotUnchanged(verified) {
  if (!verified) return;
  let st;
  try {
    st = statSync(verified.canonicalRealPath, { bigint: true });
  } catch {
    throw new OpenAiBudgetError(
      'Legacy budget SQLite file disappeared or became unreadable before reconciliation.',
      { code: 'STALE_LEGACY_SNAPSHOT_CHANGED', notDispatched: true },
    );
  }
  if (!st.isFile() || Number(st.nlink) > 1) {
    throw new OpenAiBudgetError(
      'Legacy budget SQLite file physical link/type changed before reconciliation.',
      { code: 'STALE_LEGACY_SNAPSHOT_CHANGED', notDispatched: true },
    );
  }
  let realNow;
  try {
    realNow = realpathNativeSafe(verified.canonicalRealPath);
  } catch {
    throw new OpenAiBudgetError(
      'Legacy budget SQLite canonical path could not be re-resolved at activation.',
      { code: 'STALE_LEGACY_SNAPSHOT_CHANGED', notDispatched: true },
    );
  }
  if (realNow !== verified.canonicalRealPath) {
    throw new OpenAiBudgetError(
      'Legacy budget SQLite canonical path changed since inspection.',
      { code: 'STALE_LEGACY_SNAPSHOT_CHANGED', notDispatched: true },
    );
  }
  if (
    verified.sourceIno !== null &&
    st.ino !== 0n &&
    (String(st.dev) !== verified.sourceDev || String(st.ino) !== verified.sourceIno)
  ) {
    throw new OpenAiBudgetError(
      'Legacy budget SQLite file inode/device changed on disk since inspectLegacyAutopilotBudget ran.',
      { code: 'STALE_LEGACY_SNAPSHOT_CHANGED', notDispatched: true },
    );
  }

  const walPath = `${verified.canonicalRealPath}-wal`;
  const journalPath = `${verified.canonicalRealPath}-journal`;
  const mainNow = readFileSync(verified.canonicalRealPath);
  const walNow = existsSync(walPath) ? readFileSync(walPath) : null;
  const journalNow = existsSync(journalPath) ? readFileSync(journalPath) : null;

  const currentSnapshotSha256 = sha256Hex(
    canonicalJson({
      main_sha256: sha256Hex(mainNow),
      wal_sha256: walNow ? sha256Hex(walNow) : null,
      journal_sha256: journalNow ? sha256Hex(journalNow) : null,
    }),
  );
  if (currentSnapshotSha256 !== verified.snapshotSha256) {
    throw new OpenAiBudgetError(
      'Legacy budget SQLite snapshot mutated on disk after inspectLegacyAutopilotBudget ran; re-run inspection on current state.',
      { code: 'STALE_LEGACY_SNAPSHOT_CHANGED', notDispatched: true },
    );
  }
}

function extractLegacyRowMonthInfo(row, monthColumns) {
  let sawNonEmpty = false;
  let sawInvalid = false;
  for (const col of monthColumns) {
    const val = row[col];
    if (val === null || val === undefined) continue;
    if (typeof val === 'string' && val.trim() === '') continue;
    sawNonEmpty = true;
    const parsedMonth = extractMonthPrefix(val);
    if (parsedMonth !== null) {
      return { monthUtc: parsedMonth, hasUnparseableTimestamp: sawInvalid, hasAnyTimestamp: true };
    }
    sawInvalid = true;
  }
  return { monthUtc: null, hasUnparseableTimestamp: sawInvalid, hasAnyTimestamp: sawNonEmpty };
}

function parseStrictNonNegIntCell(raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { present: false, valid: true, value: 0 };
  }
  if (typeof raw === 'boolean') {
    return { present: true, valid: false, value: 0 };
  }
  const n = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  if (!Number.isSafeInteger(n) || n < 0) {
    const fallback = Number.isFinite(n) && n > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(n)) : 0;
    return { present: true, valid: false, value: fallback };
  }
  return { present: true, valid: true, value: n };
}

function parseStrictUsdCell(raw) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { present: false, valid: true, cents: 0, micros: 0 };
  }
  if (typeof raw === 'boolean') {
    return { present: true, valid: false, cents: 0, micros: 0 };
  }
  const n = typeof raw === 'number'
    ? raw
    : (typeof raw === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);
  if (!Number.isFinite(n) || n < 0) {
    return { present: true, valid: false, cents: 0, micros: 0 };
  }
  if (n === 0) return { present: true, valid: true, cents: 0, micros: 0 };
  const ceilMicros = Math.ceil(n * 1_000_000 - 1e-9);
  const ceilCents = Math.ceil(n * 100 - 1e-9);
  if (!Number.isSafeInteger(ceilCents) || ceilCents < 0 || !Number.isSafeInteger(ceilMicros) || ceilMicros < 0) {
    return { present: true, valid: false, cents: Number.MAX_SAFE_INTEGER, micros: Number.MAX_SAFE_INTEGER };
  }
  return { present: true, valid: true, cents: ceilCents, micros: ceilMicros };
}

function extractLegacyRowMonetary(row, {
  reservedCols,
  reservedMicrosCols,
  reservedUsdCols,
  provisionalMicrosCols,
  postedBilledCols,
  usageMicrosCols,
  usageUsdCols,
}) {
  let hasInvalidMonetary = false;
  let hasAnyPresentMonetary = false;

  let hasReservation = false;
  let reservationMaxCents = 0;

  let hasProvisionalUsage = false;
  let provisionalUsageMaxMicros = 0;
  let provisionalUsageMaxCents = 0;

  let hasPostedBilled = false;
  let postedBilledMaxCents = 0;

  let hasUsage = false;
  let usageMaxMicros = 0;
  let usageMaxCents = 0;

  let maxPresentCents = 0;

  for (const col of reservedCols) {
    const p = parseStrictNonNegIntCell(row[col]);
    if (!p.present) continue;
    hasReservation = true;
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    reservationMaxCents = Math.max(reservationMaxCents, p.value);
    maxPresentCents = Math.max(maxPresentCents, p.value);
  }

  for (const col of reservedMicrosCols) {
    const p = parseStrictNonNegIntCell(row[col]);
    if (!p.present) continue;
    hasReservation = true;
    const cents = Math.ceil(p.value / 10_000);
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    reservationMaxCents = Math.max(reservationMaxCents, cents);
    maxPresentCents = Math.max(maxPresentCents, cents);
  }

  for (const col of reservedUsdCols) {
    const p = parseStrictUsdCell(row[col]);
    if (!p.present) continue;
    hasReservation = true;
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    reservationMaxCents = Math.max(reservationMaxCents, p.cents);
    maxPresentCents = Math.max(maxPresentCents, p.cents);
  }

  for (const col of provisionalMicrosCols) {
    const p = parseStrictNonNegIntCell(row[col]);
    if (!p.present) continue;
    hasProvisionalUsage = true;
    const cents = Math.ceil(p.value / 10_000);
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    provisionalUsageMaxMicros = Math.max(provisionalUsageMaxMicros, p.value);
    provisionalUsageMaxCents = Math.max(provisionalUsageMaxCents, cents);
    maxPresentCents = Math.max(maxPresentCents, cents);
  }

  for (const col of postedBilledCols) {
    const p = parseStrictNonNegIntCell(row[col]);
    if (!p.present) continue;
    hasPostedBilled = true;
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    postedBilledMaxCents = Math.max(postedBilledMaxCents, p.value);
    maxPresentCents = Math.max(maxPresentCents, p.value);
  }

  for (const col of usageMicrosCols) {
    const p = parseStrictNonNegIntCell(row[col]);
    if (!p.present) continue;
    hasUsage = true;
    const cents = Math.ceil(p.value / 10_000);
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    usageMaxMicros = Math.max(usageMaxMicros, p.value);
    usageMaxCents = Math.max(usageMaxCents, cents);
    maxPresentCents = Math.max(maxPresentCents, cents);
  }

  for (const col of usageUsdCols) {
    const p = parseStrictUsdCell(row[col]);
    if (!p.present) continue;
    hasUsage = true;
    if (!p.valid) {
      hasInvalidMonetary = true;
    } else {
      hasAnyPresentMonetary = true;
    }
    usageMaxMicros = Math.max(usageMaxMicros, p.micros);
    usageMaxCents = Math.max(usageMaxCents, p.cents);
    maxPresentCents = Math.max(maxPresentCents, p.cents);
  }

  return {
    hasInvalidMonetary,
    hasAnyPresentMonetary,
    hasReservation,
    reservationCents: hasReservation ? reservationMaxCents : null,
    hasProvisionalUsage,
    provisionalUsageMicros: hasProvisionalUsage ? provisionalUsageMaxMicros : null,
    provisionalUsageCentsCeiling: hasProvisionalUsage ? provisionalUsageMaxCents : null,
    hasPostedBilled,
    postedBilledCents: hasPostedBilled ? postedBilledMaxCents : null,
    hasUsage,
    usageMicros: hasUsage ? usageMaxMicros : null,
    usageCentsCeiling: hasUsage ? usageMaxCents : null,
    allPresentMonetaryAreZero:
      hasAnyPresentMonetary &&
      !hasInvalidMonetary &&
      maxPresentCents === 0 &&
      usageMaxMicros === 0 &&
      provisionalUsageMaxMicros === 0,
    conservativeCents: Math.max(
      reservationMaxCents,
      provisionalUsageMaxCents,
      postedBilledMaxCents,
      usageMaxCents,
      maxPresentCents,
    ),
  };
}

function quoteIdent(name) {
  if (!SAFE_SQL_IDENT_RE.test(name)) {
    throw new OpenAiValidationError(`Unsafe SQLite identifier in legacy database: "${sanitizeDiagnosticText(name)}".`);
  }
  return `"${name}"`;
}

function inspectSnapshotDatabase(db, {
  targetMonth,
  displayPath,
  fileSha256,
  fileBytes,
  walPresent,
  snapshotSha256,
  maxRows = MAX_LEGACY_INSPECT_ROWS,
}) {
  try {
    db.exec('PRAGMA query_only = ON;');
  } catch {
    // Ignore on immutable URI connections where query_only is already enforced.
  }

  db.exec('BEGIN DEFERRED');
  try {
    const rawTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all();

    const tableSummaries = [];
    const aggregateStatusCounts = Object.create(null);
    const requestTablesByMonth = Object.create(null);
    const summaryTablesByMonth = Object.create(null);
    const unresolvedRows = [];
    const blockingReasonsSet = new Set();
    let recognizedTableCount = 0;
    let totalLedgerRows = 0;
    let totalDbRows = 0;
    let unresolvedCount = 0;
    let requestTablesSameMonthCents = 0;
    let summaryTablesSameMonthCents = 0;
    let totalReservedAllMonthsCents = 0;

    for (const t of rawTables) {
      const tableName = String(t.name);
      const qTable = quoteIdent(tableName);
      const colInfos = db.prepare(`PRAGMA table_info(${qTable})`).all();
      const columns = colInfos.map(c => String(c.name));
      const colLowerMap = new Map(columns.map(c => [c.toLowerCase(), c]));
      const findCols = candidates => candidates.map(c => colLowerMap.get(c)).filter(Boolean);

      const statusCol = findCols([
        'status', 'state', 'phase', 'lifecycle_status', 'submission_state', 'outcome',
      ])[0] ?? null;
      const idCol = findCols([
        'logical_request_id', 'request_id', 'reservation_id', 'attempt_id', 'operation_id', 'id',
      ])[0] ?? null;
      const reservedCols = findCols([
        'reserved_cents', 'reservation_cents', 'cents', 'amount_cents', 'estimated_cents',
        'max_cost_cents', 'cost_cents', 'usd_cents', 'carryover_cents',
      ]);
      const reservedMicrosCols = findCols([
        'reserved_micros', 'estimated_micros',
      ]);
      const reservedUsdCols = findCols([
        'reserved_usd', 'estimated_cost_usd', 'amount_usd',
      ]);
      const provisionalMicrosCols = findCols([
        'provisional_usage_cost_micros', 'provisional_micros', 'interim_usage_micros',
      ]);
      const postedBilledCols = findCols([
        'posted_billed_cents', 'billed_cents', 'settled_cents', 'final_cents', 'spent_cents', 'consumed_cents',
      ]);
      const usageMicrosCols = findCols([
        'usage_cost_micros', 'actual_micros', 'cost_micros', 'spent_micros',
      ]);
      const usageUsdCols = findCols([
        'cost_usd', 'actual_cost_usd', 'usage_usd',
      ]);
      const monthCols = findCols([
        'month_utc', 'billing_month', 'period_month', 'year_month', 'month',
        'created_at', 'reserved_at', 'submitted_at', 'started_at', 'ended_at', 'updated_at', 'timestamp',
      ]);
      const holdFlagCols = findCols([
        'unresolved', 'needs_recovery', 'pending_recovery', 'fenced', 'is_unknown',
      ]);
      const confirmedZeroCols = findCols([
        'confirmed_zero_charge', 'zero_charge_confirmed',
      ]);
      const cleanupReqCol = colLowerMap.get('cleanup_required') ?? null;
      const cleanupStatusCol = colLowerMap.get('cleanup_status') ?? null;
      const releasedAtCol = colLowerMap.get('released_at') ?? null;
      const boolLockCol = findCols(['is_locked', 'locked', 'active', 'fenced'])[0] ?? null;
      const holderCol = findCols(['holder', 'owner', 'owner_id', 'active_request_id', 'pending_request_id', 'request_id'])[0] ?? null;

      const hasReservationSchema = reservedCols.length > 0 || reservedMicrosCols.length > 0 || reservedUsdCols.length > 0;
      const hasProvisionalSchema = provisionalMicrosCols.length > 0;
      const hasPostedSchema = postedBilledCols.length > 0;
      const hasUsageSchema = usageMicrosCols.length > 0 || usageUsdCols.length > 0;
      const hasMonetaryCols = hasReservationSchema || hasProvisionalSchema || hasPostedSchema || hasUsageSchema;

      const isLockTable = /(?:lock|fence)/i.test(tableName) && !/(?:request|reservation|ledger)/i.test(tableName);
      const isMetaOrConfigTable = /^(?:meta|metadata|config|settings|schema_version|schema_migrations|alembic_version|openai_ledger_identity|openai_budget_policy|budget_policy|openai_batch_uploads|openai_private_payloads)$/i.test(tableName);

      const isCanonicalNamedLedger = /^(?:requests|reservations|openai_request_ledger|budget_reservations|budget_requests|request_ledger)$/i.test(tableName);
      if (isCanonicalNamedLedger && (!statusCol || !hasMonetaryCols)) {
        throw new OpenAiBudgetError(
          `Legacy table "${sanitizeDiagnosticText(tableName)}" is missing required status or monetary columns.`,
          { code: 'UNRECOGNIZED_LEGACY_BUDGET_SCHEMA', notDispatched: true },
        );
      }

      const isAggregateSummaryTable = !statusCol && !idCol && !isLockTable && !isMetaOrConfigTable &&
        hasMonetaryCols &&
        /(?:summary|monthly|spend|budget|total|usage|carryover)/i.test(tableName);
      const isLedgerTable = !isLockTable && !isMetaOrConfigTable && !isAggregateSummaryTable &&
        statusCol !== null &&
        hasMonetaryCols &&
        (isCanonicalNamedLedger || /(?:reservation|request|ledger|attempt|submission)/i.test(tableName));

      if (isLedgerTable || isAggregateSummaryTable) {
        recognizedTableCount++;
      }

      const tableStatusCounts = Object.create(null);
      let tableUnresolvedCount = 0;
      let tableSameMonthCents = 0;
      let rowCount = 0;

      if (!isLockTable && !isAggregateSummaryTable && !isLedgerTable) {
        rowCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${qTable}`).get()?.c ?? 0);
        totalDbRows += rowCount;
        if (totalDbRows > maxRows) {
          throw new OpenAiBudgetError(
            `Legacy budget SQLite row count exceeds maximum inspectable ceiling (${maxRows}).`,
            { code: 'LEGACY_DB_TOO_MANY_ROWS', notDispatched: true },
          );
        }
      } else {
        const neededColsSet = new Set([
          statusCol,
          idCol,
          ...reservedCols,
          ...reservedMicrosCols,
          ...reservedUsdCols,
          ...provisionalMicrosCols,
          ...postedBilledCols,
          ...usageMicrosCols,
          ...usageUsdCols,
          ...monthCols,
          ...holdFlagCols,
          ...confirmedZeroCols,
          cleanupReqCol,
          cleanupStatusCol,
          releasedAtCol,
          boolLockCol,
          holderCol,
        ].filter(Boolean));
        const selectExpr = neededColsSet.size > 0
          ? [...neededColsSet].map(quoteIdent).join(', ')
          : '1 AS _present';
        const rowIter = db.prepare(`SELECT ${selectExpr} FROM ${qTable}`).iterate();

        for (const row of rowIter) {
          const idx = rowCount;
          rowCount++;
          totalDbRows++;
          if (totalDbRows > maxRows) {
            throw new OpenAiBudgetError(
              `Legacy budget SQLite row count exceeds maximum inspectable ceiling (${maxRows}).`,
              { code: 'LEGACY_DB_TOO_MANY_ROWS', notDispatched: true },
            );
          }

          if (isLockTable) {
            let activeLock = false;
            if (releasedAtCol && row[releasedAtCol] !== null && row[releasedAtCol] !== undefined && String(row[releasedAtCol]).trim() !== '') {
              activeLock = false;
            } else if (boolLockCol) {
              const v = row[boolLockCol];
              activeLock = v === 1 || v === true || /^(?:1|true|locked|active|held)$/i.test(String(v ?? '').trim());
            } else if (statusCol) {
              const s = String(row[statusCol] ?? '').trim().toLowerCase();
              activeLock = !['released', 'unlocked', 'clear', 'idle', 'inactive', 'none', 'closed', '0', 'false'].includes(s);
            } else if (holderCol) {
              activeLock = row[holderCol] !== null && row[holderCol] !== undefined && String(row[holderCol]).trim() !== '';
            } else {
              activeLock = true;
            }

            const label = activeLock ? 'active_lock' : 'released_lock';
            incrementHistogramCount(tableStatusCounts, label, 1);
            if (activeLock) {
              tableUnresolvedCount++;
              unresolvedCount++;
              blockingReasonsSet.add('active_legacy_lock');
              if (unresolvedRows.length < 50) {
                unresolvedRows.push({
                  table: tableName,
                  row_id: `lock_row_${idx}`,
                  status: 'active_lock',
                  reserved_cents: 0,
                  month_utc: extractLegacyRowMonthInfo(row, monthCols).monthUtc,
                });
              }
            }
          } else if (isAggregateSummaryTable) {
            const monthInfo = extractLegacyRowMonthInfo(row, monthCols);
            const mon = extractLegacyRowMonetary(row, {
              reservedCols,
              reservedMicrosCols,
              reservedUsdCols,
              provisionalMicrosCols,
              postedBilledCols,
              usageMicrosCols,
              usageUsdCols,
            });
            const badSummaryRow =
              mon.hasInvalidMonetary ||
              !mon.hasAnyPresentMonetary ||
              ((monthInfo.hasUnparseableTimestamp || monthInfo.monthUtc === null) && !mon.allPresentMonetaryAreZero);
            if (badSummaryRow) {
              tableUnresolvedCount++;
              unresolvedCount++;
              blockingReasonsSet.add('invalid_or_undated_summary_row');
              if (unresolvedRows.length < 50) {
                unresolvedRows.push({
                  table: tableName,
                  row_id: `summary_row_${idx}`,
                  status: 'invalid_summary',
                  reserved_cents: mon.conservativeCents,
                  month_utc: monthInfo.monthUtc,
                });
              }
            }
            if (monthInfo.monthUtc !== null) {
              incrementHistogramCount(summaryTablesByMonth, monthInfo.monthUtc, mon.conservativeCents);
            }
            if (monthInfo.monthUtc === targetMonth || monthInfo.monthUtc === null) {
              tableSameMonthCents += mon.conservativeCents;
              summaryTablesSameMonthCents += mon.conservativeCents;
            }
          } else if (isLedgerTable) {
            totalLedgerRows++;
            const rawStatus = statusCol ? row[statusCol] : null;
            const normStatus = rawStatus === null || rawStatus === undefined || String(rawStatus).trim() === ''
              ? 'unknown'
              : sanitizeDiagnosticText(String(rawStatus).trim().toLowerCase()).slice(0, 64);
            const publicStatusLabel = PUBLIC_KNOWN_LEGACY_STATUS_LABELS.has(normStatus) ? normStatus : 'unknown';

            incrementHistogramCount(tableStatusCounts, publicStatusLabel, 1);
            incrementHistogramCount(aggregateStatusCounts, publicStatusLabel, 1);

            const explicitHoldFlag = holdFlagCols.some(col => {
              const v = row[col];
              return v === 1 || v === true || /^(?:1|true|yes)$/i.test(String(v ?? '').trim());
            });

            const unfinishedCleanup =
              ((cleanupReqCol !== null &&
                (row[cleanupReqCol] === 1 || row[cleanupReqCol] === true) &&
                (!cleanupStatusCol || row[cleanupStatusCol] !== 'deleted_verified_404')) ||
                (cleanupStatusCol !== null &&
                  (row[cleanupStatusCol] === 'pending_cleanup' || row[cleanupStatusCol] === 'delete_failed'))) &&
              normStatus !== 'not_submitted' &&
              normStatus !== 'rejected';

            const monthInfo = extractLegacyRowMonthInfo(row, monthCols);
            const mon = extractLegacyRowMonetary(row, {
              reservedCols,
              reservedMicrosCols,
              reservedUsdCols,
              provisionalMicrosCols,
              postedBilledCols,
              usageMicrosCols,
              usageUsdCols,
            });

            const rawConfirmedZero = confirmedZeroCols.some(col => {
              const v = row[col];
              return v === 1 || v === true || /^(?:1|true|yes)$/i.test(String(v ?? '').trim());
            });
            const hasPositiveObservedConsumption =
              (mon.postedBilledCents !== null && mon.postedBilledCents > 0) ||
              (mon.usageMicros !== null && mon.usageMicros > 0) ||
              (mon.provisionalUsageMicros !== null && mon.provisionalUsageMicros > 0);
            const contradictoryZeroFlag = rawConfirmedZero && hasPositiveObservedConsumption;
            const confirmedZero = rawConfirmedZero && !hasPositiveObservedConsumption;

            // P0-10 & P0-13: Promo-credit / posted-only zero mask check:
            // ANY completed or failed row with posted_billed_cents === 0 and no verified usage (unless confirmedZero on non-completed) is held!
            const promoZeroMaskingUnknownUsage =
              mon.hasPostedBilled &&
              mon.postedBilledCents === 0 &&
              !mon.hasUsage &&
              (LEGACY_COMPLETED_STATUSES.has(normStatus) || !confirmedZero);

            // Unfinalized interim provisional consumption without final usage or positive posted bill exceeding it is unresolved!
            const unfinalizedProvisionalConsumption =
              mon.hasProvisionalUsage &&
              mon.provisionalUsageMicros > 0 &&
              !mon.hasUsage &&
              !(mon.hasPostedBilled && mon.postedBilledCents >= mon.provisionalUsageCentsCeiling);

            let isUnresolved = false;
            let effectiveRowCents = mon.conservativeCents;

            if (
              explicitHoldFlag ||
              mon.hasInvalidMonetary ||
              contradictoryZeroFlag ||
              promoZeroMaskingUnknownUsage ||
              unfinalizedProvisionalConsumption
            ) {
              isUnresolved = true;
            } else if (LEGACY_COMPLETED_STATUSES.has(normStatus)) {
              if (!mon.hasAnyPresentMonetary) {
                isUnresolved = true;
              } else if (hasUsageSchema && !mon.hasUsage && !confirmedZero) {
                isUnresolved = true;
              } else if (hasPostedSchema && hasReservationSchema && !mon.hasPostedBilled && !mon.hasUsage && !confirmedZero) {
                isUnresolved = true;
              } else if ((monthInfo.hasUnparseableTimestamp || monthInfo.monthUtc === null) && !mon.allPresentMonetaryAreZero) {
                isUnresolved = true;
              } else if (mon.hasUsage) {
                effectiveRowCents = Math.max(
                  mon.usageCentsCeiling,
                  mon.provisionalUsageCentsCeiling ?? 0,
                  mon.postedBilledCents ?? 0,
                );
              } else if (mon.hasPostedBilled) {
                effectiveRowCents = Math.max(mon.postedBilledCents, mon.provisionalUsageCentsCeiling ?? 0);
              } else {
                effectiveRowCents = mon.reservationCents ?? mon.conservativeCents;
              }
            } else if (LEGACY_UNSUBMITTED_ZERO_STATUSES.has(normStatus)) {
              if (!hasPositiveObservedConsumption && (confirmedZero || mon.allPresentMonetaryAreZero)) {
                effectiveRowCents = 0;
              } else {
                isUnresolved = true;
              }
            } else if (LEGACY_FAILED_OR_CANCELLED_STATUSES.has(normStatus)) {
              // P0-10: failed / cancelled / error / expired WITHOUT confirmedZero or verified usage is ALWAYS unresolved even if reservationCents === 0!
              if (confirmedZero) {
                effectiveRowCents = 0;
              } else if (mon.hasUsage) {
                const settledFailCents = Math.max(
                  mon.usageCentsCeiling,
                  mon.provisionalUsageCentsCeiling ?? 0,
                  mon.postedBilledCents ?? 0,
                );
                if ((monthInfo.hasUnparseableTimestamp || monthInfo.monthUtc === null) && settledFailCents > 0) {
                  isUnresolved = true;
                } else {
                  effectiveRowCents = settledFailCents;
                }
              } else {
                isUnresolved = true;
              }
            } else {
              isUnresolved = true;
            }

            if (!isUnresolved && monthInfo.hasUnparseableTimestamp && effectiveRowCents > 0) {
              isUnresolved = true;
            }

            totalReservedAllMonthsCents += effectiveRowCents;
            if (monthInfo.monthUtc !== null) {
              incrementHistogramCount(requestTablesByMonth, monthInfo.monthUtc, effectiveRowCents);
            }
            if (monthInfo.monthUtc === targetMonth || monthInfo.monthUtc === null) {
              tableSameMonthCents += effectiveRowCents;
              requestTablesSameMonthCents += effectiveRowCents;
            }

            if (isUnresolved) {
              tableUnresolvedCount++;
              unresolvedCount++;
              blockingReasonsSet.add(`unresolved_row:${tableName}:${publicStatusLabel}`);
              if (unresolvedRows.length < 50) {
                const rawRowId = idCol ? row[idCol] : `row_${idx}`;
                unresolvedRows.push({
                  table: tableName,
                  row_id: sanitizeDiagnosticText(String(rawRowId ?? `row_${idx}`)).slice(0, 96),
                  status: publicStatusLabel,
                  reserved_cents: effectiveRowCents,
                  month_utc: monthInfo.monthUtc,
                });
              }
            }
          }
        }
      }

      tableSummaries.push({
        name: tableName,
        kind: isLockTable
          ? 'lock'
          : (isLedgerTable ? 'ledger' : (isAggregateSummaryTable ? 'summary' : 'metadata')),
        columns,
        row_count: rowCount,
        status_counts: tableStatusCounts,
        unresolved_count: tableUnresolvedCount,
        same_month_reserved_cents: tableSameMonthCents,
      });
    }

    if (recognizedTableCount === 0) {
      throw new OpenAiBudgetError(
        `SQLite file "${displayPath}" does not contain any recognized legacy OpenAI budget ledger or summary table.`,
        { code: 'UNRECOGNIZED_LEGACY_BUDGET_SCHEMA', notDispatched: true },
      );
    }

    const blockingReasons = [...blockingReasonsSet];
    const hasHolds = unresolvedCount > 0 || blockingReasons.length > 0;
    const sameMonthReservedCents = Math.max(requestTablesSameMonthCents, summaryTablesSameMonthCents);

    const observedMonths = new Set([
      ...Object.keys(requestTablesByMonth),
      ...Object.keys(summaryTablesByMonth),
      targetMonth,
    ]);
    const monthlyReservedCentsByMonth = Object.create(null);
    let maxSumAcrossObservedMonths = 0;
    for (const m of [...observedMonths].sort()) {
      const mCents = Math.max(
        Object.hasOwn(requestTablesByMonth, m) ? requestTablesByMonth[m] : 0,
        Object.hasOwn(summaryTablesByMonth, m) ? summaryTablesByMonth[m] : 0,
        m === targetMonth ? sameMonthReservedCents : 0,
      );
      setNullProtoProp(monthlyReservedCentsByMonth, m, mCents);
      maxSumAcrossObservedMonths += mCents;
    }

    const summary = {
      recognized_schema: true,
      all_months_complete: true,
      month_utc: targetMonth,
      db_path: displayPath,
      file_sha256: fileSha256,
      snapshot_sha256: snapshotSha256,
      wal_present: walPresent,
      file_bytes: fileBytes,
      total_rows: totalLedgerRows,
      total_db_rows: totalDbRows,
      status_counts: aggregateStatusCounts,
      unresolved_count: unresolvedCount,
      unresolved_rows: unresolvedRows,
      blocking_reasons: blockingReasons,
      has_unresolved_holds: hasHolds,
      same_month_reserved_cents: sameMonthReservedCents,
      monthly_reserved_cents_by_month: monthlyReservedCentsByMonth,
      total_reserved_cents_all_months: Math.max(totalReservedAllMonthsCents, sameMonthReservedCents, maxSumAcrossObservedMonths),
      safe_to_reconcile: !hasHolds,
      tables: tableSummaries,
    };
    assertSafeStoredValue(summary, 'legacy_budget_summary');
    return summary;
  } finally {
    try { db.exec('COMMIT'); } catch { /* ignore */ }
  }
}

/**
 * Open a legacy autopilot OpenAI budget SQLite file STRICTLY READ-ONLY, never creating
 * directories, files, or WAL/SHM sidecars in the original directory, and summarize its
 * rows, statuses, unresolved/unknown holds, and per-month reserved_cents.
 */
export function inspectLegacyAutopilotBudget(
  legacySqlitePath,
  { monthUtc = currentMonthUtc(), maxRows = MAX_LEGACY_INSPECT_ROWS } = {},
) {
  if (typeof legacySqlitePath !== 'string' || !legacySqlitePath.trim()) {
    throw new OpenAiValidationError('legacySqlitePath must be a nonempty file path string.');
  }
  assertPositiveInt(maxRows, 'maxRows');
  const targetMonth = assertValidMonthUtc(monthUtc, 'monthUtc');
  const resolvedPath = resolve(legacySqlitePath.trim());
  const displayPath = sanitizeDisplayPath(resolvedPath);

  let st;
  try {
    st = statSync(resolvedPath);
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : 'ENOENT';
    throw new OpenAiBudgetError(
      `Legacy budget SQLite file cannot be opened read-only (${code}: ${displayPath}).`,
      { code: 'LEGACY_DB_UNREADABLE', notDispatched: true },
    );
  }
  if (!st.isFile()) {
    throw new OpenAiBudgetError(
      `Legacy budget SQLite path is not a regular file (${displayPath}).`,
      { code: 'LEGACY_DB_NOT_FILE', notDispatched: true },
    );
  }
  if (typeof st.nlink === 'number' && st.nlink > 1) {
    throw new OpenAiBudgetError(
      `Legacy budget SQLite path has multiple hard links (nlink=${st.nlink}); inspect the canonical unaliased SQLite file so sibling WAL/journal sidecars cannot be hidden (${displayPath}).`,
      { code: 'LEGACY_HARDLINK_ALIAS_FORBIDDEN', notDispatched: true },
    );
  }

  const canonicalRealPath = realpathNativeSafe(resolvedPath);
  const canonSt = statSync(canonicalRealPath, { bigint: true });
  if (Number(canonSt.nlink) > 1) {
    throw new OpenAiBudgetError(
      `Canonical legacy budget SQLite file has multiple hard links (nlink=${String(canonSt.nlink)}); hard-link aliases are forbidden (${displayPath}).`,
      { code: 'LEGACY_HARDLINK_ALIAS_FORBIDDEN', notDispatched: true },
    );
  }
  const sourcePathSha256 = sha256Hex(
    process.platform === 'win32' ? canonicalRealPath.toLowerCase() : canonicalRealPath,
  );
  const sourceDev = canonSt.ino !== 0n ? String(canonSt.dev) : null;
  const sourceIno = canonSt.ino !== 0n ? String(canonSt.ino) : null;

  const walPath = `${canonicalRealPath}-wal`;
  const journalPath = `${canonicalRealPath}-journal`;
  const shmPath = `${canonicalRealPath}-shm`;
  const aliasWalPath = `${resolvedPath}-wal`;
  const aliasJournalPath = `${resolvedPath}-journal`;
  const hadWal = existsSync(walPath) || existsSync(aliasWalPath);
  const hadJournal = existsSync(journalPath) || existsSync(aliasJournalPath);
  const hadShm = existsSync(shmPath);

  if (canonicalRealPath !== resolvedPath && (existsSync(aliasWalPath) || existsSync(aliasJournalPath))) {
    throw new OpenAiBudgetError(
      `Symlinked legacy budget path has ambiguous sidecar files (${displayPath}); inspect the canonical path directly.`,
      { code: 'LEGACY_HARDLINK_ALIAS_FORBIDDEN', notDispatched: true },
    );
  }

  if (!hadWal && !hadJournal) {
    const bytesBefore = readFileSync(canonicalRealPath);
    const fileSha256 = sha256Hex(bytesBefore);
    const snapshotSha256 = sha256Hex(
      canonicalJson({
        main_sha256: fileSha256,
        wal_sha256: null,
        journal_sha256: null,
      }),
    );
    const immutableUri = `${pathToFileURL(canonicalRealPath).href}?immutable=1`;

    let db;
    try {
      db = new DatabaseSync(immutableUri, { open: true, readOnly: true });
    } catch (err) {
      throw new OpenAiBudgetError(
        `Legacy budget SQLite file could not be opened in immutable read-only mode (${sanitizeDiagnosticText(err?.message || 'open_failed')}).`,
        { code: 'LEGACY_DB_UNREADABLE', notDispatched: true },
      );
    }

    let summary;
    try {
      summary = inspectSnapshotDatabase(db, {
        targetMonth,
        displayPath,
        fileSha256,
        fileBytes: bytesBefore.length,
        walPresent: false,
        snapshotSha256,
        maxRows,
      });
    } finally {
      db.close();
    }

    if (existsSync(walPath) || existsSync(journalPath) || (!hadShm && existsSync(shmPath))) {
      throw new OpenAiBudgetError(
        `Concurrent sidecar appeared on legacy budget SQLite during read-only inspection (${displayPath}).`,
        { code: 'LEGACY_DB_CONCURRENT_WRITE', notDispatched: true },
      );
    }
    const bytesAfter = readFileSync(canonicalRealPath);
    if (sha256Hex(bytesAfter) !== fileSha256) {
      throw new OpenAiBudgetError(
        `Legacy budget SQLite file changed concurrently during read-only inspection (${displayPath}).`,
        { code: 'LEGACY_DB_CONCURRENT_WRITE', notDispatched: true },
      );
    }

    const inspectedAtMs = nextInspectionStampMs();
    deepFreeze(summary);
    VERIFIED_INSPECTIONS.set(summary, {
      canonicalRealPath,
      sourcePathSha256,
      sourceDev,
      sourceIno,
      fileSha256,
      snapshotSha256,
      inspectedAtMs,
    });
    return summary;
  }

  // Live -wal or -journal sidecar exists: capture coherent private snapshot in mkdtempSync
  // without opening or creating -shm in the original directory!
  const mainBefore = readFileSync(canonicalRealPath);
  const walBefore = existsSync(walPath) ? readFileSync(walPath) : null;
  const journalBefore = existsSync(journalPath) ? readFileSync(journalPath) : null;

  const mainShaBefore = sha256Hex(mainBefore);
  const walShaBefore = walBefore ? sha256Hex(walBefore) : null;
  const journalShaBefore = journalBefore ? sha256Hex(journalBefore) : null;

  const mainAfter = readFileSync(canonicalRealPath);
  const walAfter = existsSync(walPath) ? readFileSync(walPath) : null;
  const journalAfter = existsSync(journalPath) ? readFileSync(journalPath) : null;

  if (
    sha256Hex(mainAfter) !== mainShaBefore ||
    (walAfter ? sha256Hex(walAfter) : null) !== walShaBefore ||
    (journalAfter ? sha256Hex(journalAfter) : null) !== journalShaBefore
  ) {
    throw new OpenAiBudgetError(
      `Concurrent write detected on legacy budget SQLite/WAL while capturing read-only snapshot (${displayPath}).`,
      { code: 'LEGACY_DB_CONCURRENT_WRITE', notDispatched: true },
    );
  }

  const snapshotSha256 = sha256Hex(
    canonicalJson({
      main_sha256: mainShaBefore,
      wal_sha256: walShaBefore,
      journal_sha256: journalShaBefore,
    }),
  );

  const tempDir = mkdtempSync(join(tmpdir(), 'openai-legacy-ro-'));
  try {
    const snapDbPath = join(tempDir, 'snapshot.sqlite3');
    writeFileSync(snapDbPath, mainBefore, { mode: 0o600 });
    if (walBefore) {
      writeFileSync(`${snapDbPath}-wal`, walBefore, { mode: 0o600 });
    }
    if (journalBefore) {
      writeFileSync(`${snapDbPath}-journal`, journalBefore, { mode: 0o600 });
    }

    const db = new DatabaseSync(snapDbPath, { open: true });
    let summary;
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
      summary = inspectSnapshotDatabase(db, {
        targetMonth,
        displayPath,
        fileSha256: mainShaBefore,
        fileBytes: mainBefore.length,
        walPresent: Boolean(walBefore),
        snapshotSha256,
        maxRows,
      });
    } finally {
      db.close();
    }

    if (!hadShm && existsSync(shmPath)) {
      throw new OpenAiBudgetError(
        `Unexpected -shm sidecar appeared in legacy directory during inspection (${displayPath}).`,
        { code: 'LEGACY_DB_CONCURRENT_WRITE', notDispatched: true },
      );
    }

    const inspectedAtMs = nextInspectionStampMs();
    deepFreeze(summary);
    VERIFIED_INSPECTIONS.set(summary, {
      canonicalRealPath,
      sourcePathSha256,
      sourceDev,
      sourceIno,
      fileSha256: mainShaBefore,
      snapshotSha256,
      inspectedAtMs,
    });
    return summary;
  } finally {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 20 });
  }
}

export class OpenAiBudgetLedger {
  /**
   * @param {string | DatabaseSync | { db: DatabaseSync, readOnly?: boolean, dbPath?: string }} dbOrPath
   * @param {{ readOnly?: boolean, reconcileOnOpen?: boolean, testMode?: boolean, nowFn?: (() => Date) | null }} [options]
   */
  constructor(dbOrPath = ':memory:', {
    readOnly = false,
    reconcileOnOpen = false,
    testMode = undefined,
    nowFn = null,
  } = {}) {
    if (testMode !== undefined && typeof testMode !== 'boolean') {
      throw new OpenAiValidationError('testMode must be a boolean when provided.');
    }
    this.testMode = testMode !== undefined ? testMode : (dbOrPath === ':memory:');
    this.isTestLedger = Boolean(this.testMode);

    this._nowFn = typeof nowFn === 'function' ? nowFn : () => new Date();
    this._inTx = false;
    this._readOnlyTempDir = null;
    this._mainFile = '';

    if (dbOrPath instanceof DatabaseSync) {
      this.db = dbOrPath;
      this._ownsDb = false;
      this.readOnly = Boolean(readOnly);
      if (this.db.isTransaction) {
        throw new OpenAiBudgetError(
          'Cannot construct OpenAiBudgetLedger inside an active outer SQLite transaction.',
          { code: 'LEDGER_OUTER_TRANSACTION_FORBIDDEN', notDispatched: true },
        );
      }
      this._mainFile = queryMainFileFromDatabaseSync(this.db);
      this.dbPath = this._mainFile || ':memory:';
      if (!this.readOnly) {
        this._withImmediateTx(() => {
          if (this._hasTable('openai_budget_policy')) {
            this._assertNoPinnedLegacySourceCollision();
          }
          this.db.exec(OPENAI_LEDGER_TABLES_SQL);
          this._migrateSchema();
          this.db.exec(OPENAI_LEDGER_INDEXES_SQL);
          this._assertNoPinnedLegacySourceCollision();
        });
      }
      this.startup_reconciled_attempts = (!this.readOnly && reconcileOnOpen)
        ? this.markInterruptedAsPendingRecovery()
        : [];
      return;
    }

    if (dbOrPath && typeof dbOrPath === 'object' && dbOrPath.db instanceof DatabaseSync) {
      this.db = dbOrPath.db;
      this._ownsDb = false;
      this.readOnly = Boolean(readOnly || dbOrPath.readOnly);
      if (this.db.isTransaction) {
        throw new OpenAiBudgetError(
          'Cannot construct OpenAiBudgetLedger inside an active outer SQLite transaction.',
          { code: 'LEDGER_OUTER_TRANSACTION_FORBIDDEN', notDispatched: true },
        );
      }
      this._mainFile = queryMainFileFromDatabaseSync(this.db);
      const callerPathHint = typeof dbOrPath.dbPath === 'string' ? dbOrPath.dbPath.trim() : '';
      if (
        this._mainFile === '' &&
        callerPathHint &&
        callerPathHint !== ':memory:' &&
        callerPathHint !== ':borrowed:'
      ) {
        throw new OpenAiPolicyError(
          'Borrowed DatabaseSync is in-memory according to PRAGMA database_list, contradicting caller-supplied file dbPath.',
          { code: 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE', notDispatched: true },
        );
      }
      this.dbPath = this._mainFile || ':memory:';
      if (!this.readOnly) {
        this._withImmediateTx(() => {
          if (this._hasTable('openai_budget_policy')) {
            this._assertNoPinnedLegacySourceCollision();
          }
          this.db.exec(OPENAI_LEDGER_TABLES_SQL);
          this._migrateSchema();
          this.db.exec(OPENAI_LEDGER_INDEXES_SQL);
          this._assertNoPinnedLegacySourceCollision();
        });
      }
      this.startup_reconciled_attempts = (!this.readOnly && reconcileOnOpen)
        ? this.markInterruptedAsPendingRecovery()
        : [];
      return;
    }

    if (typeof dbOrPath !== 'string' || !dbOrPath.trim()) {
      throw new OpenAiValidationError('dbOrPath must be a file path string, ":memory:", DatabaseSync, or SelectionStore.');
    }

    this.dbPath = dbOrPath.trim();
    this._ownsDb = true;
    this.readOnly = Boolean(readOnly);

    if (this.readOnly) {
      if (this.dbPath !== ':memory:') {
        const resolved = resolve(this.dbPath);
        const displayResolved = sanitizeDisplayPath(resolved);
        let st;
        try {
          st = statSync(resolved);
        } catch (err) {
          const code = typeof err?.code === 'string' ? err.code : 'ENOENT';
          throw new OpenAiBudgetError(
            `SQLite database cannot be opened read-only (${code}: ${displayResolved}).`,
            { code: 'DB_OPEN_READONLY_FAILED', notDispatched: true },
          );
        }
        if (!st.isFile()) {
          throw new OpenAiBudgetError(`SQLite path is not a regular file (${displayResolved}).`);
        }
        if (typeof st.nlink === 'number' && st.nlink > 1) {
          throw new OpenAiBudgetError(
            `SQLite path has multiple hard links (nlink=${st.nlink}); inspect the canonical unaliased SQLite file (${displayResolved}).`,
            { code: 'LEDGER_HARDLINK_ALIAS_FORBIDDEN', notDispatched: true },
          );
        }
        const realResolved = realpathNativeSafe(resolved);
        const canonSt = statSync(realResolved);
        if (typeof canonSt.nlink === 'number' && canonSt.nlink > 1) {
          throw new OpenAiBudgetError(
            `Canonical SQLite file has multiple hard links (nlink=${canonSt.nlink}); hard-link aliases are forbidden (${displayResolved}).`,
            { code: 'LEDGER_HARDLINK_ALIAS_FORBIDDEN', notDispatched: true },
          );
        }
        const aliasWalPath = `${resolved}-wal`;
        const aliasJournalPath = `${resolved}-journal`;
        if (realResolved !== resolved && (existsSync(aliasWalPath) || existsSync(aliasJournalPath))) {
          throw new OpenAiBudgetError(
            `Symlinked SQLite path has ambiguous sidecar files (${displayResolved}); open the canonical path directly.`,
            { code: 'LEDGER_HARDLINK_ALIAS_FORBIDDEN', notDispatched: true },
          );
        }
        this._mainFile = realResolved;
        const walPath = `${realResolved}-wal`;
        const journalPath = `${realResolved}-journal`;
        if (!existsSync(walPath) && !existsSync(journalPath)) {
          const immutableTarget = `${pathToFileURL(realResolved).href}?immutable=1`;
          this.db = new DatabaseSync(immutableTarget, { open: true, readOnly: true });
          if (existsSync(walPath) || existsSync(journalPath)) {
            try { this.db.close(); } catch { /* ignore */ }
            throw new OpenAiBudgetError('SQLite sidecar appeared concurrently during read-only open.', {
              code: 'DB_OPEN_READONLY_FAILED',
              notDispatched: true,
            });
          }
        } else {
          const mainBuf = readFileSync(realResolved);
          const walBuf = existsSync(walPath) ? readFileSync(walPath) : null;
          const journalBuf = existsSync(journalPath) ? readFileSync(journalPath) : null;
          if (
            sha256Hex(readFileSync(realResolved)) !== sha256Hex(mainBuf) ||
            (existsSync(walPath) ? sha256Hex(readFileSync(walPath)) : null) !== (walBuf ? sha256Hex(walBuf) : null) ||
            (existsSync(journalPath) ? sha256Hex(readFileSync(journalPath)) : null) !== (journalBuf ? sha256Hex(journalBuf) : null)
          ) {
            throw new OpenAiBudgetError('SQLite database changed concurrently during read-only snapshot open.', {
              code: 'DB_OPEN_READONLY_FAILED',
              notDispatched: true,
            });
          }
          const roDir = mkdtempSync(join(tmpdir(), 'openai-ledger-ro-'));
          this._readOnlyTempDir = roDir;
          try {
            const snapFile = join(roDir, 'ledger.sqlite3');
            writeFileSync(snapFile, mainBuf, { mode: 0o600 });
            if (walBuf) writeFileSync(`${snapFile}-wal`, walBuf, { mode: 0o600 });
            if (journalBuf) writeFileSync(`${snapFile}-journal`, journalBuf, { mode: 0o600 });
            this.db = new DatabaseSync(snapFile, { open: true });
          } catch (snapErr) {
            try {
              rmSync(roDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 20 });
            } catch {
              // Ignore cleanup failure while rethrowing primary error.
            }
            this._readOnlyTempDir = null;
            throw snapErr;
          }
        }
      } else {
        this._mainFile = '';
        this.db = new DatabaseSync(':memory:');
      }
      try {
        this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');
      } catch {
        // Ignore on immutable connections.
      }
      this.startup_reconciled_attempts = [];
      return;
    }

    if (!this.testMode && this.dbPath === ':memory:') {
      throw new OpenAiPolicyError(
        'In-memory SQLite ledgers are forbidden when testMode is false.',
        { code: 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE', notDispatched: true },
      );
    }

    if (this.dbPath !== ':memory:') {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    const maxAttempts = this.dbPath === ':memory:' ? 1 : 12;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.db = new DatabaseSync(this.dbPath);
      try {
        this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
        this._mainFile = queryMainFileFromDatabaseSync(this.db);
        if (this._hasTable('openai_budget_policy')) {
          this._assertNoPinnedLegacySourceCollision();
        }
        if (this._mainFile !== '') {
          const curMode = String(this.db.prepare('PRAGMA journal_mode').get()?.journal_mode || '').toLowerCase();
          if (curMode !== 'wal') {
            this.db.exec('PRAGMA journal_mode = WAL;');
          }
          this.db.exec('PRAGMA synchronous = FULL;');
        }
        this._withImmediateTx(() => {
          this.db.exec(OPENAI_LEDGER_TABLES_SQL);
          this._migrateSchema();
          this.db.exec(OPENAI_LEDGER_INDEXES_SQL);
          this._assertNoPinnedLegacySourceCollision();
        });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        try { this.db.close(); } catch { /* ignore */ }
        if (err instanceof OpenAiError) throw err;
        if (attempt < maxAttempts && isTransientSqliteOpenContention(err)) {
          sleepSyncMs(20 + attempt * 15);
          continue;
        }
        throw err;
      }
    }
    if (lastError) throw lastError;
    this.startup_reconciled_attempts = reconcileOnOpen ? this.markInterruptedAsPendingRecovery() : [];
  }

  isMemoryDatabase() {
    return this._mainFile === '';
  }

  _matchesPinnedLegacySourceRow(filePath, row) {
    if (!filePath || !row) return false;
    const id = computePhysicalIdentityRecord(filePath);
    if (row.legacy_source_path_sha256 && row.legacy_source_path_sha256 === id.pathSha256) {
      return true;
    }
    if (
      id.devStr !== null &&
      id.inoStr !== null &&
      row.legacy_source_dev !== null &&
      row.legacy_source_dev !== undefined &&
      row.legacy_source_ino !== null &&
      row.legacy_source_ino !== undefined &&
      row.legacy_source_dev === id.devStr &&
      row.legacy_source_ino === id.inoStr
    ) {
      return true;
    }
    return false;
  }

  _assertPathNotPinnedLegacySource(candidatePath) {
    if (!candidatePath || !this._hasTable('openai_budget_policy')) return;
    const cols = new Set(
      this.db.prepare('PRAGMA table_info("openai_budget_policy")').all().map(c => String(c.name)),
    );
    if (!cols.has('legacy_source_path_sha256')) return;
    const rows = this.db.prepare(`
      SELECT legacy_source_path_sha256, legacy_source_dev, legacy_source_ino
      FROM openai_budget_policy
      WHERE legacy_source_path_sha256 IS NOT NULL OR legacy_source_ino IS NOT NULL
    `).all();
    for (const r of rows) {
      if (this._matchesPinnedLegacySourceRow(candidatePath, r)) {
        throw new OpenAiBudgetError(
          'Writable SQLite target collides with the pinned legacy budget SQLite source.',
          { code: 'LEGACY_SOURCE_DESTINATION_COLLISION', notDispatched: true },
        );
      }
    }
  }

  _assertNoPinnedLegacySourceCollision() {
    if (this._mainFile !== '') {
      this._assertPathNotPinnedLegacySource(this._mainFile);
    }
  }

  _migrateSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openai_ledger_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        ledger_instance_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS openai_legacy_carryover (
        account_scope TEXT NOT NULL,
        month_utc TEXT NOT NULL,
        carryover_cents INTEGER NOT NULL CHECK(carryover_cents >= 0),
        source_sha256 TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        reconciled_at TEXT NOT NULL,
        PRIMARY KEY (account_scope, month_utc)
      );
      CREATE TABLE IF NOT EXISTS openai_batch_uploads (
        account_scope TEXT NOT NULL,
        uploaded_file_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        origin TEXT NOT NULL,
        api_base_url TEXT,
        credential_fingerprint_sha256 TEXT,
        jsonl_sha256 TEXT NOT NULL,
        line_count INTEGER NOT NULL CHECK(line_count >= 1),
        estimated_reservation_cents INTEGER NOT NULL CHECK(estimated_reservation_cents >= 1),
        manifest_json TEXT NOT NULL,
        source_attempt_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_scope, uploaded_file_id)
      );
      CREATE TABLE IF NOT EXISTS openai_private_payloads (
        attempt_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        raw_bytes BLOB NOT NULL,
        raw_sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
        created_at TEXT NOT NULL,
        PRIMARY KEY (attempt_id, stage)
      );
    `);
    const existingIdentity = this.db.prepare(
      'SELECT ledger_instance_id FROM openai_ledger_identity WHERE singleton = 1',
    ).get();
    if (!existingIdentity) {
      this.db.prepare(
        'INSERT INTO openai_ledger_identity (singleton, ledger_instance_id, created_at) VALUES (1, ?, ?)',
      ).run(generatePiiSafeUuid(), this._nowIso());
    }

    // 1. Add ALL missing openai_budget_policy columns BEFORE selecting policy rows!
    const policyCols = new Set(
      this.db.prepare('PRAGMA table_info("openai_budget_policy")').all().map(c => String(c.name)),
    );
    const policyAlterDefs = [
      ['same_month_pending_buffer_cents', SAME_MONTH_PENDING_BUFFER_SQL],
      ['auto_recharge_off_confirmed', 'INTEGER NOT NULL DEFAULT 0 CHECK(auto_recharge_off_confirmed IN (0, 1))'],
      ['hard_monthly_limit_confirmed', 'INTEGER NOT NULL DEFAULT 0 CHECK(hard_monthly_limit_confirmed IN (0, 1))'],
      ['credential_fingerprint_sha256', 'TEXT'],
      ['baseline_mode', "TEXT NOT NULL DEFAULT 'unreconciled'"],
      ['legacy_reconciled', 'INTEGER NOT NULL DEFAULT 0'],
      ['legacy_reconciled_month_utc', 'TEXT'],
      ['reconciled_snapshot_month_utc', 'TEXT'],
      ['legacy_carryover_cents', 'INTEGER NOT NULL DEFAULT 0'],
      ['legacy_source_sha256', 'TEXT'],
      ['legacy_budget_sha256', 'TEXT'],
      ['legacy_source_path_sha256', 'TEXT'],
      ['legacy_source_dev', 'TEXT'],
      ['legacy_source_ino', 'TEXT'],
      ['legacy_all_months_complete', 'INTEGER NOT NULL DEFAULT 0 CHECK(legacy_all_months_complete IN (0, 1))'],
      ['legacy_inspected_at_ms', 'INTEGER'],
      ['legacy_summary_json', 'TEXT'],
      ['legacy_reconciled_at', 'TEXT'],
      ['allow_stage4_media', 'INTEGER NOT NULL DEFAULT 0'],
      ['policy_note', 'TEXT'],
      ['created_at', "TEXT NOT NULL DEFAULT ''"],
      ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [colName, colDef] of policyAlterDefs) {
      if (!policyCols.has(colName)) {
        this.db.exec(`ALTER TABLE openai_budget_policy ADD COLUMN ${colName} ${colDef}`);
      }
    }

    // 2. Add missing openai_batch_uploads columns.
    const uploadCols = new Set(
      this.db.prepare('PRAGMA table_info("openai_batch_uploads")').all().map(c => String(c.name)),
    );
    for (const [colName, colDef] of [
      ['api_base_url', 'TEXT'],
      ['credential_fingerprint_sha256', 'TEXT'],
      ['source_attempt_id', 'TEXT'],
    ]) {
      if (!uploadCols.has(colName)) {
        this.db.exec(`ALTER TABLE openai_batch_uploads ADD COLUMN ${colName} ${colDef}`);
      }
    }

    // 3. Add ALL missing openai_request_ledger columns BEFORE indexes or backfills!
    const ledgerCols = new Set(
      this.db.prepare('PRAGMA table_info("openai_request_ledger")').all().map(c => String(c.name)),
    );
    const ledgerAlterDefs = [
      ['service_tier', "TEXT NOT NULL DEFAULT 'standard'"],
      ['origin', 'TEXT'],
      ['api_base_url', 'TEXT'],
      ['credential_fingerprint_sha256', 'TEXT'],
      ['store_mode', 'INTEGER NOT NULL DEFAULT 1 CHECK(store_mode IN (0, 1))'],
      ['background_mode', BACKGROUND_MODE_SQL],
      ['background_cancel_dispatched_at', 'TEXT'],
      ['background_delete_dispatched_at', 'TEXT'],
      ['background_usage_floor_micros', 'INTEGER CHECK(background_usage_floor_micros IS NULL OR background_usage_floor_micros >= 0)'],
      ['background_search_floor_micros', 'INTEGER NOT NULL DEFAULT 0 CHECK(background_search_floor_micros >= 0)'],
      ['background_token_floor_micros', 'INTEGER NOT NULL DEFAULT 0 CHECK(background_token_floor_micros >= 0)'],
      ['response_format_json', 'TEXT'],
      ['packet_sha256', 'TEXT'],
      ['content_status', 'TEXT'],
      ['estimated_input_tokens', 'INTEGER'],
      ['max_output_tokens', 'INTEGER'],
      ['max_web_search_calls', 'INTEGER NOT NULL DEFAULT 0'],
      ['usage_cost_micros', 'INTEGER'],
      ['provisional_usage_cost_micros', 'INTEGER CHECK(provisional_usage_cost_micros IS NULL OR provisional_usage_cost_micros >= 0)'],
      ['posted_billed_cents', 'INTEGER'],
      ['confirmed_zero_charge', 'INTEGER NOT NULL DEFAULT 0'],
      ['confirmed_not_created_remotely', 'INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_not_created_remotely IN (0, 1))'],
      ['usage_json', 'TEXT'],
      ['provisional_usage_json', 'TEXT'],
      ['provider_response_id', 'TEXT'],
      ['provider_model', 'TEXT'],
      ['http_status', 'INTEGER'],
      ['cleanup_required', 'INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_required IN (0, 1))'],
      ['cleanup_status', "TEXT DEFAULT 'not_requested'"],
      ['terminal_outcome_status', "TEXT CHECK(terminal_outcome_status IS NULL OR terminal_outcome_status IN ('completed', 'failed_known'))"],
      ['delete_ack_at', 'TEXT'],
      ['delete_ack_receipt_json', 'TEXT'],
      ['cleanup_404_receipt_json', 'TEXT'],
      ['batch_manifest_json', 'TEXT'],
      ['raw_receipt_json', 'TEXT'],
      ['raw_receipt_sha256', 'TEXT'],
      ['original_body_sha256', 'TEXT'],
      ['raw_body_text', 'TEXT'],
      ['raw_body_sha256', 'TEXT'],
      ['recovery_history_json', 'TEXT'],
      ['diagnostic_reason', 'TEXT'],
      ['reconciliation_note', 'TEXT'],
      ['finished_at', 'TEXT'],
      ['created_at', "TEXT NOT NULL DEFAULT ''"],
      ['updated_at', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [colName, colDef] of ledgerAlterDefs) {
      if (!ledgerCols.has(colName)) {
        this.db.exec(`ALTER TABLE openai_request_ledger ADD COLUMN ${colName} ${colDef}`);
      }
    }

    // P0-10 / P0-13: Map legacy settled_cents into posted_billed_cents so settled bills never disappear!
    if (ledgerCols.has('settled_cents')) {
      this.db.exec(`
        UPDATE openai_request_ledger
        SET posted_billed_cents = CASE
          WHEN posted_billed_cents IS NULL THEN settled_cents
          WHEN settled_cents IS NOT NULL AND settled_cents > posted_billed_cents THEN settled_cents
          ELSE posted_billed_cents
        END
        WHERE settled_cents IS NOT NULL
      `);
    }

    // Backfill raw_receipt_sha256 on legacy rows that stored raw_receipt_json before sha256 column existed
    const missingReceiptShaRows = this.db.prepare(
      'SELECT attempt_id, raw_receipt_json FROM openai_request_ledger WHERE raw_receipt_json IS NOT NULL AND raw_receipt_sha256 IS NULL',
    ).all();
    if (missingReceiptShaRows.length > 0) {
      const updSha = this.db.prepare('UPDATE openai_request_ledger SET raw_receipt_sha256 = ? WHERE attempt_id = ?');
      for (const r of missingReceiptShaRows) {
        updSha.run(sha256Hex(String(r.raw_receipt_json)), r.attempt_id);
      }
    }

    // Restore any terminal completed/failed_known rows that were previously demoted to pending_recovery
    // solely due to unfinished remote DELETE cleanup (DELETE failure never locks out or demotes terminal receipts).
    this.db.exec(`
      UPDATE openai_request_ledger
      SET status = terminal_outcome_status
      WHERE status = 'pending_recovery'
        AND terminal_outcome_status IN ('completed', 'failed_known')
        AND usage_cost_micros IS NOT NULL
        AND cleanup_status IN ('pending_cleanup', 'delete_failed')
    `);

    // Migrate legacy openai_request_ledger CHECK constraint (`reserved_cents >= 1` -> `reserved_cents >= 0`)
    // so slimmed zero-upfront-freeze requests (`reserved_cents = 0`) commit cleanly on existing databases.
    const reqMaster = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'openai_request_ledger'",
    ).get();
    if (reqMaster?.sql && reqMaster.sql.includes('reserved_cents >= 1')) {
      const migratedSql = reqMaster.sql
        .replace(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?openai_request_ledger["`]?/i, 'CREATE TABLE openai_request_ledger_v2')
        .replace(/reserved_cents\s*>=\s*1/g, 'reserved_cents >= 0');
      const cols = this.db.prepare('PRAGMA table_info("openai_request_ledger")').all().map(c => `"${String(c.name)}"`).join(', ');
      this.db.exec(`
        ${migratedSql};
        INSERT INTO openai_request_ledger_v2 (${cols}) SELECT ${cols} FROM openai_request_ledger;
        DROP TABLE openai_request_ledger;
        ALTER TABLE openai_request_ledger_v2 RENAME TO openai_request_ledger;
      `);
    }

    // Backfill per-month carryover table from legacy single-month policy columns if needed.
    const legacyPolicyRows = this.db.prepare(`
      SELECT account_scope, legacy_reconciled_month_utc, legacy_carryover_cents,
             legacy_source_sha256, legacy_summary_json, legacy_reconciled_at, created_at, updated_at
      FROM openai_budget_policy
      WHERE legacy_reconciled = 1 AND legacy_reconciled_month_utc IS NOT NULL
    `).all();
    const insCarryover = this.db.prepare(`
      INSERT OR IGNORE INTO openai_legacy_carryover (
        account_scope, month_utc, carryover_cents, source_sha256, summary_json, reconciled_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const r of legacyPolicyRows) {
      if (MONTH_UTC_RE.test(String(r.legacy_reconciled_month_utc))) {
        insCarryover.run(
          r.account_scope,
          r.legacy_reconciled_month_utc,
          Math.max(0, Number(r.legacy_carryover_cents ?? 0)),
          HEX_SHA256_RE.test(String(r.legacy_source_sha256 || '')) ? r.legacy_source_sha256 : '0'.repeat(64),
          r.legacy_summary_json ?? '{}',
          r.legacy_reconciled_at || r.updated_at || r.created_at || new Date().toISOString(),
        );
      }
    }
  }

  _nowDate() {
    return this.testMode ? this._nowFn() : new Date();
  }

  _nowIso() {
    return this._nowDate().toISOString();
  }

  _assertWritable() {
    if (this.readOnly) {
      throw new OpenAiBudgetError('OpenAiBudgetLedger is opened in strictly read-only mode.', {
        code: 'LEDGER_READ_ONLY',
      });
    }
  }

  _assertNoOuterTransaction(methodLabel = 'OpenAiBudgetLedger operation') {
    if (this._inTx || this.db.isTransaction) {
      throw new OpenAiBudgetError(
        `${methodLabel} cannot execute inside an active outer SQLite transaction; state must commit independently.`,
        { code: 'LEDGER_OUTER_TRANSACTION_FORBIDDEN', notDispatched: true },
      );
    }
  }

  _hasTable(tableName) {
    const row = this.db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ).get(tableName);
    return Boolean(row?.present);
  }

  _buildCompatLedgerProjection() {
    const colSet = new Set(
      this.db.prepare('PRAGMA table_info("openai_request_ledger")').all().map(c => String(c.name)),
    );
    const hasPostedCol = colSet.has('posted_billed_cents');
    const hasSettledCol = colSet.has('settled_cents');
    let postedValueSql = 'NULL';
    if (hasPostedCol && hasSettledCol) {
      postedValueSql =
        'CASE WHEN posted_billed_cents IS NOT NULL AND settled_cents IS NOT NULL THEN MAX(posted_billed_cents, settled_cents) ELSE COALESCE(posted_billed_cents, settled_cents) END';
    } else if (hasPostedCol) {
      postedValueSql = 'posted_billed_cents';
    } else if (hasSettledCol) {
      postedValueSql = 'settled_cents';
    }

    const selectParts = [];
    for (const [colName, fallbackSql] of COMPAT_SUMMARY_COLUMN_DEFAULTS) {
      if (colName === 'posted_billed_cents') {
        selectParts.push(postedValueSql === 'posted_billed_cents' ? 'posted_billed_cents' : `${postedValueSql} AS posted_billed_cents`);
      } else if (colSet.has(colName)) {
        selectParts.push(colName);
      } else {
        selectParts.push(`${fallbackSql} AS ${colName}`);
      }
    }
    const hasCleanupReq = colSet.has('cleanup_required');
    const hasCleanupStatus = colSet.has('cleanup_status');

    let cleanupReqSelect;
    let unfinishedCleanupWhere;
    if (hasCleanupReq && hasCleanupStatus) {
      cleanupReqSelect =
        "CASE WHEN cleanup_required = 1 OR cleanup_status IN ('pending_cleanup', 'delete_failed') THEN 1 ELSE 0 END AS cleanup_required";
      unfinishedCleanupWhere =
        "(((cleanup_required = 1 AND COALESCE(cleanup_status, 'pending_cleanup') != 'deleted_verified_404') OR cleanup_status IN ('pending_cleanup', 'delete_failed')) AND status NOT IN ('not_submitted', 'rejected'))";
    } else if (hasCleanupReq) {
      cleanupReqSelect = 'cleanup_required';
      unfinishedCleanupWhere = "(cleanup_required = 1 AND status NOT IN ('not_submitted', 'rejected'))";
    } else if (hasCleanupStatus) {
      cleanupReqSelect =
        "CASE WHEN cleanup_status IN ('pending_cleanup', 'delete_failed') THEN 1 ELSE 0 END AS cleanup_required";
      unfinishedCleanupWhere =
        "(cleanup_status IN ('pending_cleanup', 'delete_failed') AND status NOT IN ('not_submitted', 'rejected'))";
    } else {
      cleanupReqSelect = '0 AS cleanup_required';
      unfinishedCleanupWhere = '(0 = 1)';
    }

    const zeroColSql = colSet.has('confirmed_zero_charge') ? 'COALESCE(confirmed_zero_charge, 0)' : '0';
    const usageColSql = colSet.has('usage_cost_micros') ? 'usage_cost_micros' : 'NULL';
    const unconfirmedRejectedWhere =
      `(status = 'rejected' AND ${zeroColSql} = 0 AND ${usageColSql} IS NULL AND COALESCE(${postedValueSql}, 0) <= 0)`;

    selectParts.push(cleanupReqSelect);
    return {
      selectSql: selectParts.join(', '),
      unfinishedCleanupWhere,
      unconfirmedRejectedWhere,
    };
  }

  _withImmediateTx(fn) {
    this._assertWritable();
    if (this.db.isTransaction && !this._inTx) {
      throw new OpenAiBudgetError(
        'OpenAiBudgetLedger mutations cannot execute inside an external SQLite transaction.',
        { code: 'LEDGER_OUTER_TRANSACTION_FORBIDDEN', notDispatched: true },
      );
    }
    if (this._inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this._inTx = true;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      this._inTx = false;
    }
  }

  close() {
    if (this._ownsDb && this.db) {
      try {
        this.db.close();
      } finally {
        if (this._readOnlyTempDir) {
          rmSync(this._readOnlyTempDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 20 });
          this._readOnlyTempDir = null;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-Process Persistent Canonical Ledger Registry & Policy Management
  // ---------------------------------------------------------------------------

  _getLedgerInstanceId() {
    if (!this._hasTable('openai_ledger_identity')) return null;
    const row = this.db.prepare(
      'SELECT ledger_instance_id FROM openai_ledger_identity WHERE singleton = 1',
    ).get();
    return typeof row?.ledger_instance_id === 'string' && row.ledger_instance_id.trim()
      ? row.ledger_instance_id.trim()
      : null;
  }

  /**
   * Evidenced operator API key rotation or note update for a ledger scope.
   * Requires a nonempty operator `note` and a reconciled file-backed ledger.
   */
  rotateOrRelocateCanonicalBinding({
    accountScope = 'openai-default',
    newCredentialFingerprintSha256 = undefined,
    note,
  } = {}) {
    this._assertWritable();
    this._assertNoOuterTransaction('rotateOrRelocateCanonicalBinding');
    if (this._mainFile === '') {
      throw new OpenAiPolicyError(
        'rotateOrRelocateCanonicalBinding requires a file-backed SQLite ledger.',
        { code: 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE', notDispatched: true },
      );
    }
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const cleanNote = sanitizeSafeNote(note, 'operator_note');
    if (!cleanNote) {
      throw new OpenAiValidationError('rotateOrRelocateCanonicalBinding requires a nonempty operator note.');
    }
    const nextFp = newCredentialFingerprintSha256 !== undefined && newCredentialFingerprintSha256 !== null
      ? assertSha256Hex(newCredentialFingerprintSha256, 'newCredentialFingerprintSha256')
      : null;

    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existingPolicy = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
      if (!existingPolicy || existingPolicy.legacy_reconciled !== 1) {
        throw new OpenAiBudgetError(
          `Cannot rotate or relocate canonical binding for "${scope}" before legacy reconciliation (legacy_reconciled=false).`,
          { code: 'LEGACY_NOT_RECONCILED', notDispatched: true },
        );
      }
      if (!this.testMode && existingPolicy.baseline_mode !== 'verified_production') {
        throw new OpenAiPolicyError(
          `Cannot update production policy binding for "${scope}" without a verified_production baseline.`,
          { code: 'UNVERIFIED_SYNTHETIC_BASELINE', notDispatched: true },
        );
      }
      if (nextFp !== null) {
        const otherScopeRow = this.db.prepare(`
          SELECT account_scope FROM openai_budget_policy
          WHERE credential_fingerprint_sha256 = ? AND account_scope != ?
          LIMIT 1
        `).get(nextFp, scope);
        if (otherScopeRow) {
          throw new OpenAiPolicyError(
            `Credential fingerprint is already bound to account_scope "${otherScopeRow.account_scope}".`,
            { code: 'CREDENTIAL_SCOPE_SPLIT_FORBIDDEN', notDispatched: true },
          );
        }
      }

      const effectiveFp = nextFp ?? existingPolicy.credential_fingerprint_sha256 ?? null;

      this.db.prepare(`
        UPDATE openai_budget_policy
        SET credential_fingerprint_sha256 = ?,
            policy_note = ?,
            updated_at = ?
        WHERE account_scope = ?
      `).run(effectiveFp, cleanNote, now, scope);

      return this.getPolicy(scope);
    });
  }

  _defaultPolicyView(accountScope = 'openai-default') {
    const scope = assertSafeOpenAiAccountScope(accountScope);
    return {
      account_scope: scope,
      enabled: false,
      monthly_limit_cents: DEFAULT_MONTHLY_LIMIT_CENTS,
      same_month_pending_buffer_cents: 0,
      auto_recharge_off_confirmed: false,
      hard_monthly_limit_confirmed: false,
      credential_fingerprint_sha256: null,
      baseline_mode: 'unreconciled',
      legacy_reconciled: false,
      legacy_reconciled_month_utc: null,
      legacy_carryover_month: null,
      reconciled_snapshot_month_utc: null,
      legacy_carryover_cents: 0,
      legacy_source_sha256: null,
      legacy_budget_sha256: null,
      legacy_source_pinned: false,
      legacy_all_months_complete: false,
      legacy_summary: null,
      legacy_reconciled_at: null,
      allow_stage4_media: false,
      policy_note: null,
      schema_initialized: false,
    };
  }

  _hydratePolicyRow(row) {
    if (!row) return null;
    let parsedSummary = null;
    if (row.legacy_summary_json) {
      try { parsedSummary = JSON.parse(row.legacy_summary_json); } catch { parsedSummary = null; }
    }
    const reconciledMonth = row.legacy_reconciled_month_utc ?? null;
    return {
      account_scope: row.account_scope,
      enabled: row.enabled === 1,
      monthly_limit_cents: row.monthly_limit_cents,
      same_month_pending_buffer_cents: row.same_month_pending_buffer_cents ?? 0,
      auto_recharge_off_confirmed: Boolean(row.auto_recharge_off_confirmed === 1),
      hard_monthly_limit_confirmed: Boolean(row.hard_monthly_limit_confirmed === 1),
      credential_fingerprint_sha256: row.credential_fingerprint_sha256 ?? null,
      baseline_mode: OPENAI_BASELINE_MODES.includes(row.baseline_mode) ? row.baseline_mode : 'unreconciled',
      legacy_reconciled: row.legacy_reconciled === 1,
      legacy_reconciled_month_utc: reconciledMonth,
      legacy_carryover_month: reconciledMonth,
      reconciled_snapshot_month_utc: row.reconciled_snapshot_month_utc ?? reconciledMonth,
      legacy_carryover_cents: row.legacy_carryover_cents ?? 0,
      legacy_source_sha256: row.legacy_source_sha256 ?? null,
      legacy_budget_sha256: row.legacy_budget_sha256 ?? row.legacy_source_sha256 ?? null,
      legacy_source_pinned: Boolean(row.legacy_source_path_sha256 || row.legacy_source_ino),
      legacy_all_months_complete: Boolean(row.legacy_all_months_complete === 1),
      legacy_summary: parsedSummary,
      legacy_reconciled_at: row.legacy_reconciled_at ?? null,
      allow_stage4_media: row.allow_stage4_media === 1,
      policy_note: row.policy_note ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
      schema_initialized: true,
    };
  }

  getPolicy(accountScope = 'openai-default') {
    const scope = assertSafeOpenAiAccountScope(accountScope);
    if (!this._hasTable('openai_budget_policy')) {
      return this._defaultPolicyView(scope);
    }
    const row = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
    return row ? this._hydratePolicyRow(row) : { ...this._defaultPolicyView(scope), schema_initialized: true };
  }

  _assertLocalCredentialCompatibleInTx(scope, fp) {
    const otherScopeRow = this.db.prepare(`
      SELECT account_scope FROM openai_budget_policy
      WHERE credential_fingerprint_sha256 = ? AND account_scope != ?
      LIMIT 1
    `).get(fp, scope);
    if (otherScopeRow) {
      throw new OpenAiPolicyError(
        `Credential fingerprint is already bound to account_scope "${otherScopeRow.account_scope}"; splitting one credential across multiple scopes is forbidden.`,
        { code: 'CREDENTIAL_SCOPE_SPLIT_FORBIDDEN', notDispatched: true },
      );
    }
    const existing = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
    if (
      existing &&
      existing.credential_fingerprint_sha256 !== null &&
      existing.credential_fingerprint_sha256 !== undefined &&
      existing.credential_fingerprint_sha256 !== fp
    ) {
      throw new OpenAiPolicyError(
        `account_scope "${scope}" is already bound to a different credential fingerprint; use rotateOrRelocateCanonicalBinding with an operator note for key rotation.`,
        { code: 'CREDENTIAL_SCOPE_MISMATCH', notDispatched: true },
      );
    }
    return existing;
  }

  _bindCredentialInTx(scope, fp, now) {
    const existing = this._assertLocalCredentialCompatibleInTx(scope, fp);
    if (!existing) {
      this.db.prepare(`
        INSERT INTO openai_budget_policy (
          account_scope, enabled, monthly_limit_cents,
          auto_recharge_off_confirmed, hard_monthly_limit_confirmed,
          credential_fingerprint_sha256, baseline_mode, legacy_reconciled,
          allow_stage4_media, created_at, updated_at
        ) VALUES (?, 0, ?, 0, 0, ?, 'unreconciled', 0, 0, ?, ?)
      `).run(scope, DEFAULT_MONTHLY_LIMIT_CENTS, fp, now, now);
      return;
    }

    if (existing.credential_fingerprint_sha256 !== fp) {
      this.db.prepare(`
        UPDATE openai_budget_policy
        SET credential_fingerprint_sha256 = ?,
            updated_at = ?
        WHERE account_scope = ?
      `).run(fp, now, scope);
    }
  }

  bindCredentialFingerprint(accountScope, credentialFingerprintSha256, { isLiveTransport = false } = {}) {
    this._assertWritable();
    if (typeof isLiveTransport !== 'boolean') {
      throw new OpenAiValidationError('isLiveTransport must be a boolean.');
    }
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const fp = assertSha256Hex(credentialFingerprintSha256, 'credentialFingerprintSha256');
    if ((isLiveTransport || !this.testMode) && this._mainFile === '') {
      throw new OpenAiPolicyError(
        'In-memory or unbacked SQLite ledgers are forbidden on live/production OpenAI HTTP transport; use a persistent file-backed ledger.',
        { code: 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE', notDispatched: true },
      );
    }
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      this._bindCredentialInTx(scope, fp, now);
      return this.getPolicy(scope);
    });
  }

  configurePolicy({
    accountScope = 'openai-default',
    enabled = undefined,
    monthlyLimitCents = undefined,
    sameMonthPendingBufferCents = undefined,
    maxSameMonthPendingRecoveryCents = undefined,
    autoRechargeOffConfirmed = undefined,
    hardMonthlyLimitConfirmed = undefined,
    allowStage4Media = undefined,
    expectedLegacySourcePath = undefined,
    note = undefined,
  } = {}) {
    this._assertWritable();
    const scope = assertSafeOpenAiAccountScope(accountScope);
    if (monthlyLimitCents !== undefined) {
      validateMonthlyLimitCents(monthlyLimitCents, 'monthlyLimitCents');
    }
    const pendingBufferOverride = resolveSameMonthPendingBufferOverride(
      sameMonthPendingBufferCents, maxSameMonthPendingRecoveryCents,
    );
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new OpenAiValidationError('enabled must be a boolean when provided.');
    }
    if (autoRechargeOffConfirmed !== undefined && typeof autoRechargeOffConfirmed !== 'boolean') {
      throw new OpenAiValidationError('autoRechargeOffConfirmed must be a boolean when provided.');
    }
    if (hardMonthlyLimitConfirmed !== undefined && typeof hardMonthlyLimitConfirmed !== 'boolean') {
      throw new OpenAiValidationError('hardMonthlyLimitConfirmed must be a boolean when provided.');
    }
    if (allowStage4Media !== undefined && typeof allowStage4Media !== 'boolean') {
      throw new OpenAiValidationError('allowStage4Media must be a boolean when provided.');
    }
    let pinnedSourceSpec = null;
    if (expectedLegacySourcePath !== undefined && expectedLegacySourcePath !== null) {
      if (typeof expectedLegacySourcePath !== 'string' || !expectedLegacySourcePath.trim()) {
        throw new OpenAiValidationError('expectedLegacySourcePath must be a nonempty path string when provided.');
      }
      const normExpected = normalizeFilesystemPathInput(expectedLegacySourcePath);
      if (!normExpected) {
        throw new OpenAiValidationError('expectedLegacySourcePath must be a valid filesystem path.');
      }
      if (this._mainFile !== '' && areSamePhysicalSqliteFile(normExpected, this._mainFile)) {
        throw new OpenAiBudgetError(
          'expectedLegacySourcePath and destination ledger resolve to the same physical file.',
          { code: 'LEGACY_SOURCE_DESTINATION_COLLISION', notDispatched: true },
        );
      }
      pinnedSourceSpec = computePhysicalIdentityRecord(normExpected);
    }
    const safeNote = note !== undefined ? sanitizeSafeNote(note, 'policy_note') : undefined;
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
      const nextLegacyReconciled = existing ? existing.legacy_reconciled === 1 : false;
      const nextEnabled = enabled !== undefined ? enabled : (existing ? existing.enabled === 1 : false);
      const nextLimit = monthlyLimitCents !== undefined
        ? monthlyLimitCents
        : (existing ? existing.monthly_limit_cents : DEFAULT_MONTHLY_LIMIT_CENTS);
      validateMonthlyLimitCents(nextLimit, 'monthlyLimitCents');
      const nextPendingBuffer = validateSameMonthPendingBuffer(
        pendingBufferOverride ?? existing?.same_month_pending_buffer_cents ?? 0,
      );

      const nextAutoRechargeOff = autoRechargeOffConfirmed !== undefined
        ? autoRechargeOffConfirmed
        : (existing ? existing.auto_recharge_off_confirmed === 1 : false);
      const nextHardMonthlyLimit = hardMonthlyLimitConfirmed !== undefined
        ? hardMonthlyLimitConfirmed
        : (existing ? existing.hard_monthly_limit_confirmed === 1 : false);

      if (nextEnabled && !nextLegacyReconciled) {
        throw new OpenAiBudgetError(
          `Cannot enable OpenAI budget policy for "${scope}" before legacy budget reconciliation (legacy_reconciled=false).`,
          { code: 'LEGACY_NOT_RECONCILED' },
        );
      }

      if (nextEnabled && !this.testMode && existing?.baseline_mode !== 'verified_production') {
        throw new OpenAiPolicyError(
          `Cannot enable production OpenAI budget policy for "${scope}" when baseline_mode="${String(existing?.baseline_mode ?? 'unreconciled')}"; reconcile an authentic production legacy budget file first.`,
          { code: 'UNVERIFIED_SYNTHETIC_BASELINE', notDispatched: true },
        );
      }

      if (nextEnabled && (!nextAutoRechargeOff || !nextHardMonthlyLimit)) {
        throw new OpenAiPolicyError(
          `Enabling OpenAI budget policy for "${scope}" requires autoRechargeOffConfirmed: true and hardMonthlyLimitConfirmed: true.`,
          { code: 'PLATFORM_BILLING_CONTROLS_UNVERIFIED' },
        );
      }

      if (pinnedSourceSpec && existing?.legacy_source_path_sha256 && existing.legacy_source_path_sha256 !== pinnedSourceSpec.pathSha256) {
        throw new OpenAiBudgetError(
          `account_scope "${scope}" is already pinned to a different legacy budget source.`,
          { code: 'LEGACY_SOURCE_MISMATCH', notDispatched: true },
        );
      }

      const nextStage4 = allowStage4Media !== undefined
        ? allowStage4Media
        : (existing ? existing.allow_stage4_media === 1 : false);
      const nextNote = safeNote !== undefined ? safeNote : (existing ? existing.policy_note : null);
      const nextSrcSha = pinnedSourceSpec ? pinnedSourceSpec.pathSha256 : (existing?.legacy_source_path_sha256 ?? null);
      const nextSrcDev = pinnedSourceSpec ? pinnedSourceSpec.devStr : (existing?.legacy_source_dev ?? null);
      const nextSrcIno = pinnedSourceSpec ? pinnedSourceSpec.inoStr : (existing?.legacy_source_ino ?? null);

      if (!existing) {
        this.db.prepare(`
          INSERT INTO openai_budget_policy (
            account_scope, enabled, monthly_limit_cents, same_month_pending_buffer_cents,
            auto_recharge_off_confirmed, hard_monthly_limit_confirmed,
            baseline_mode, legacy_reconciled,
            legacy_source_path_sha256, legacy_source_dev, legacy_source_ino,
            allow_stage4_media, policy_note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'unreconciled', 0, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          scope,
          nextEnabled ? 1 : 0,
          nextLimit,
          nextPendingBuffer,
          nextAutoRechargeOff ? 1 : 0,
          nextHardMonthlyLimit ? 1 : 0,
          nextSrcSha,
          nextSrcDev,
          nextSrcIno,
          nextStage4 ? 1 : 0,
          nextNote,
          now,
          now,
        );
      } else {
        this.db.prepare(`
          UPDATE openai_budget_policy
          SET enabled = ?,
              monthly_limit_cents = ?,
              same_month_pending_buffer_cents = ?,
              auto_recharge_off_confirmed = ?,
              hard_monthly_limit_confirmed = ?,
              legacy_source_path_sha256 = ?,
              legacy_source_dev = ?,
              legacy_source_ino = ?,
              allow_stage4_media = ?,
              policy_note = ?,
              updated_at = ?
          WHERE account_scope = ?
        `).run(
          nextEnabled ? 1 : 0,
          nextLimit,
          nextPendingBuffer,
          nextAutoRechargeOff ? 1 : 0,
          nextHardMonthlyLimit ? 1 : 0,
          nextSrcSha,
          nextSrcDev,
          nextSrcIno,
          nextStage4 ? 1 : 0,
          nextNote,
          now,
          scope,
        );
      }

      return this.getPolicy(scope);
    });
  }

  reconcileLegacySummary(legacySummary, {
    accountScope = 'openai-default',
    enable = undefined,
    monthlyLimitCents = undefined,
    sameMonthPendingBufferCents = undefined,
    maxSameMonthPendingRecoveryCents = undefined,
    autoRechargeOffConfirmed = undefined,
    hardMonthlyLimitConfirmed = undefined,
    allowStage4Media = undefined,
    allowSyntheticSummaryForTests = false,
    expectedLegacySourcePath = undefined,
    allowLegacySourceSwitch = false,
    note = null,
  } = {}) {
    this._assertWritable();
    if (this.db.isTransaction && !this._inTx) {
      throw new OpenAiBudgetError(
        'reconcileLegacySummary cannot execute inside an external SQLite transaction; state must commit independently.',
        { code: 'LEDGER_OUTER_TRANSACTION_FORBIDDEN', notDispatched: true },
      );
    }

    if (typeof allowSyntheticSummaryForTests !== 'boolean') {
      throw new OpenAiValidationError('allowSyntheticSummaryForTests must be a boolean.');
    }
    if (typeof allowLegacySourceSwitch !== 'boolean') {
      throw new OpenAiValidationError('allowLegacySourceSwitch must be a boolean.');
    }
    if (!legacySummary || typeof legacySummary !== 'object' || Array.isArray(legacySummary)) {
      throw new OpenAiValidationError('legacySummary must be an object produced by inspectLegacyAutopilotBudget.');
    }

    if (allowSyntheticSummaryForTests === true && !this.isTestLedger) {
      throw new OpenAiPolicyError(
        'allowSyntheticSummaryForTests is forbidden on production ledgers (testMode: false).',
        { code: 'UNVERIFIED_SYNTHETIC_BASELINE', notDispatched: true },
      );
    }

    const verified = VERIFIED_INSPECTIONS.get(legacySummary) ?? null;
    const syntheticPermitted =
      this.isTestLedger &&
      (this._mainFile === '' || allowSyntheticSummaryForTests === true);

    if (!verified && !syntheticPermitted) {
      throw new OpenAiBudgetError(
        'File-backed OpenAI budget ledgers require an authentic immutable inspection summary returned by inspectLegacyAutopilotBudget.',
        { code: 'UNVERIFIED_LEGACY_SUMMARY_OBJECT', notDispatched: true },
      );
    }

    if (verified && this._mainFile !== '') {
      if (areSamePhysicalSqliteFile(verified.canonicalRealPath, this._mainFile)) {
        throw new OpenAiBudgetError(
          'Legacy budget SQLite source and destination ledger resolve to the same physical file.',
          { code: 'LEGACY_SOURCE_DESTINATION_COLLISION', notDispatched: true },
        );
      }
    }

    let explicitExpectedSourceIdentity = null;
    if (expectedLegacySourcePath !== undefined && expectedLegacySourcePath !== null) {
      if (typeof expectedLegacySourcePath !== 'string' || !expectedLegacySourcePath.trim()) {
        throw new OpenAiValidationError('expectedLegacySourcePath must be a nonempty path string when provided.');
      }
      const normExp = normalizeFilesystemPathInput(expectedLegacySourcePath);
      if (!normExp || !verified || !areSamePhysicalSqliteFile(normExp, verified.canonicalRealPath)) {
        throw new OpenAiBudgetError(
          'legacySummary does not match expectedLegacySourcePath.',
          { code: 'LEGACY_SOURCE_MISMATCH', notDispatched: true },
        );
      }
      explicitExpectedSourceIdentity = computePhysicalIdentityRecord(normExp);
    }

    // P0-09: Re-stat and re-hash legacy source (main, -wal, -journal) at activation time!
    if (verified) {
      reverifyLegacySnapshotUnchanged(verified);
    }

    const scope = assertSafeOpenAiAccountScope(accountScope);
    if (legacySummary.recognized_schema !== true) {
      throw new OpenAiBudgetError(
        'legacySummary must carry recognized_schema: true from inspectLegacyAutopilotBudget.',
        { code: 'UNRECOGNIZED_LEGACY_BUDGET_SCHEMA', notDispatched: true },
      );
    }
    const fileSha = assertSha256Hex(legacySummary.file_sha256, 'legacySummary.file_sha256');
    const snapshotSha = verified
      ? verified.snapshotSha256
      : (legacySummary.snapshot_sha256
        ? assertSha256Hex(legacySummary.snapshot_sha256, 'legacySummary.snapshot_sha256')
        : fileSha);
    const monthUtc = assertValidMonthUtc(legacySummary.month_utc, 'legacySummary.month_utc');
    const unresolvedCount = assertNonNegInt(legacySummary.unresolved_count, 'legacySummary.unresolved_count');
    const sameMonthCents = assertNonNegInt(
      legacySummary.same_month_reserved_cents,
      'legacySummary.same_month_reserved_cents',
    );
    if (legacySummary.blocking_reasons !== undefined && !Array.isArray(legacySummary.blocking_reasons)) {
      throw new OpenAiValidationError('legacySummary.blocking_reasons must be an array when provided.');
    }
    const blockingReasons = Array.isArray(legacySummary.blocking_reasons)
      ? legacySummary.blocking_reasons.map(r => sanitizeDiagnosticText(String(r)))
      : [];
    const hasHolds = Boolean(legacySummary.has_unresolved_holds) || unresolvedCount > 0 || blockingReasons.length > 0;
    const allMonthsComplete = Boolean(verified || legacySummary.all_months_complete === true);
    const nextBaselineMode = verified ? 'verified_production' : 'synthetic_test_only';

    const perMonthEntries = new Map();
    perMonthEntries.set(monthUtc, sameMonthCents);
    if (
      legacySummary.monthly_reserved_cents_by_month &&
      typeof legacySummary.monthly_reserved_cents_by_month === 'object' &&
      !Array.isArray(legacySummary.monthly_reserved_cents_by_month)
    ) {
      for (const mKey of Object.keys(legacySummary.monthly_reserved_cents_by_month)) {
        const cleanM = assertValidMonthUtc(mKey, `monthly_reserved_cents_by_month["${mKey}"]`);
        const mVal = assertNonNegInt(
          legacySummary.monthly_reserved_cents_by_month[mKey],
          `monthly_reserved_cents_by_month["${cleanM}"]`,
        );
        perMonthEntries.set(cleanM, Math.max(perMonthEntries.get(cleanM) ?? 0, mVal));
      }
    }

    const safeNote = sanitizeSafeNote(note, 'policy_note');
    const now = this._nowIso();

    if (hasHolds) {
      // P0-09: Reject ANY active outer transaction (including _withImmediateTx) so hold revocations
      // commit durably and can never be rolled back when LEGACY_UNRESOLVED_HOLD is thrown!
      this._assertNoOuterTransaction('reconcileLegacySummary');
      this._withImmediateTx(() => {
        const existing = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
        if (
          verified &&
          existing?.legacy_inspected_at_ms !== null &&
          existing?.legacy_inspected_at_ms !== undefined &&
          verified.inspectedAtMs <= existing.legacy_inspected_at_ms
        ) {
          throw new OpenAiBudgetError(
            `Refusing stale or replayed legacy budget summary for "${scope}" (inspectedAtMs=${verified.inspectedAtMs} <= ${existing.legacy_inspected_at_ms}).`,
            { code: 'STALE_LEGACY_SUMMARY_REPLAY', notDispatched: true },
          );
        }
        const nextStamp = verified ? verified.inspectedAtMs : (existing?.legacy_inspected_at_ms ?? null);
        const pinnedPathSha = existing?.legacy_source_path_sha256 ?? (verified ? verified.sourcePathSha256 : null);
        const pinnedDev = existing?.legacy_source_path_sha256 ? existing.legacy_source_dev : (verified ? verified.sourceDev : null);
        const pinnedIno = existing?.legacy_source_path_sha256 ? existing.legacy_source_ino : (verified ? verified.sourceIno : null);

        if (!existing) {
          this.db.prepare(`
            INSERT INTO openai_budget_policy (
              account_scope, enabled, monthly_limit_cents,
              auto_recharge_off_confirmed, hard_monthly_limit_confirmed,
              baseline_mode, legacy_reconciled, legacy_budget_sha256,
              legacy_source_path_sha256, legacy_source_dev, legacy_source_ino,
              legacy_inspected_at_ms, allow_stage4_media, created_at, updated_at
            ) VALUES (?, 0, ?, 0, 0, 'unreconciled', 0, ?, ?, ?, ?, ?, 0, ?, ?)
          `).run(
            scope,
            DEFAULT_MONTHLY_LIMIT_CENTS,
            snapshotSha,
            pinnedPathSha,
            pinnedDev,
            pinnedIno,
            nextStamp,
            now,
            now,
          );
        } else {
          this.db.prepare(`
            UPDATE openai_budget_policy
            SET enabled = 0,
                baseline_mode = 'unreconciled',
                legacy_reconciled = 0,
                legacy_budget_sha256 = ?,
                legacy_source_path_sha256 = COALESCE(legacy_source_path_sha256, ?),
                legacy_source_dev = CASE WHEN legacy_source_path_sha256 IS NULL THEN ? ELSE legacy_source_dev END,
                legacy_source_ino = CASE WHEN legacy_source_path_sha256 IS NULL THEN ? ELSE legacy_source_ino END,
                legacy_inspected_at_ms = ?,
                updated_at = ?
            WHERE account_scope = ?
          `).run(
            snapshotSha,
            pinnedPathSha,
            pinnedDev,
            pinnedIno,
            nextStamp,
            now,
            scope,
          );
        }
      });

      throw new OpenAiBudgetError(
        `Refusing OpenAI budget activation for "${scope}": legacy budget database contains ${unresolvedCount} unresolved/unknown hold(s) that must be reconciled first.`,
        {
          code: 'LEGACY_UNRESOLVED_HOLD',
          notDispatched: true,
          details: {
            unresolved_count: unresolvedCount,
            blocking_reasons: blockingReasons,
            month_utc: monthUtc,
          },
        },
      );
    }

    if (monthlyLimitCents !== undefined) {
      validateMonthlyLimitCents(monthlyLimitCents, 'monthlyLimitCents');
    }
    const pendingBufferOverride = resolveSameMonthPendingBufferOverride(
      sameMonthPendingBufferCents, maxSameMonthPendingRecoveryCents,
    );
    if (enable !== undefined && typeof enable !== 'boolean') {
      throw new OpenAiValidationError('enable must be a boolean when provided.');
    }
    if (autoRechargeOffConfirmed !== undefined && typeof autoRechargeOffConfirmed !== 'boolean') {
      throw new OpenAiValidationError('autoRechargeOffConfirmed must be a boolean when provided.');
    }
    if (hardMonthlyLimitConfirmed !== undefined && typeof hardMonthlyLimitConfirmed !== 'boolean') {
      throw new OpenAiValidationError('hardMonthlyLimitConfirmed must be a boolean when provided.');
    }
    if (allowStage4Media !== undefined && typeof allowStage4Media !== 'boolean') {
      throw new OpenAiValidationError('allowStage4Media must be a boolean when provided.');
    }

    const storedSummaryObj = {
      recognized_schema: true,
      all_months_complete: allMonthsComplete,
      month_utc: monthUtc,
      total_rows: legacySummary.total_rows ?? 0,
      status_counts: legacySummary.status_counts ?? {},
      unresolved_count: 0,
      same_month_reserved_cents: sameMonthCents,
      file_sha256: fileSha,
      snapshot_sha256: snapshotSha,
    };
    assertSafeStoredValue(storedSummaryObj, 'legacySummary');
    const summaryJson = canonicalJson(storedSummaryObj);

    return this._withImmediateTx(() => {
      if (verified) {
        reverifyLegacySnapshotUnchanged(verified);
      }
      const existing = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
      if (
        verified &&
        existing?.legacy_inspected_at_ms !== null &&
        existing?.legacy_inspected_at_ms !== undefined &&
        verified.inspectedAtMs <= existing.legacy_inspected_at_ms
      ) {
        throw new OpenAiBudgetError(
          `Refusing stale or replayed legacy budget summary for "${scope}" (inspectedAtMs=${verified.inspectedAtMs} <= ${existing.legacy_inspected_at_ms}); run a fresh inspectLegacyAutopilotBudget.`,
          { code: 'STALE_LEGACY_SUMMARY_REPLAY', notDispatched: true },
        );
      }

      let nextSrcPathSha = existing?.legacy_source_path_sha256 ?? null;
      let nextSrcDev = existing?.legacy_source_dev ?? null;
      let nextSrcIno = existing?.legacy_source_ino ?? null;

      if (verified) {
        if (!existing || !existing.legacy_source_path_sha256) {
          nextSrcPathSha = verified.sourcePathSha256;
          nextSrcDev = verified.sourceDev;
          nextSrcIno = verified.sourceIno;
        } else {
          const samePath = existing.legacy_source_path_sha256 === verified.sourcePathSha256;
          const sameInode =
            existing.legacy_source_ino === null ||
            existing.legacy_source_ino === undefined ||
            verified.sourceIno === null ||
            (existing.legacy_source_dev === verified.sourceDev && existing.legacy_source_ino === verified.sourceIno);

          if (!samePath) {
            if (!allowLegacySourceSwitch || !explicitExpectedSourceIdentity || !safeNote) {
              throw new OpenAiBudgetError(
                `Inspected legacy budget source for "${scope}" does not match the pinned legacy source; switching requires allowLegacySourceSwitch: true, matching expectedLegacySourcePath, and an operator note.`,
                { code: 'LEGACY_SOURCE_MISMATCH', notDispatched: true },
              );
            }
            nextSrcPathSha = verified.sourcePathSha256;
            nextSrcDev = verified.sourceDev;
            nextSrcIno = verified.sourceIno;
          } else if (!sameInode) {
            if (!explicitExpectedSourceIdentity || !safeNote) {
              throw new OpenAiBudgetError(
                `Pinned legacy budget file for "${scope}" changed physical device/inode at its pathname; supply matching expectedLegacySourcePath and an operator note.`,
                { code: 'LEGACY_SOURCE_MISMATCH', notDispatched: true },
              );
            }
            nextSrcDev = verified.sourceDev;
            nextSrcIno = verified.sourceIno;
          }
        }
      }

      const nextEnabled = enable !== undefined ? enable : (existing ? existing.enabled === 1 : false);
      const nextLimit = monthlyLimitCents !== undefined
        ? monthlyLimitCents
        : (existing ? existing.monthly_limit_cents : DEFAULT_MONTHLY_LIMIT_CENTS);
      validateMonthlyLimitCents(nextLimit, 'monthlyLimitCents');
      const nextPendingBuffer = validateSameMonthPendingBuffer(
        pendingBufferOverride ?? existing?.same_month_pending_buffer_cents ?? 0,
      );

      const nextAutoRechargeOff = autoRechargeOffConfirmed !== undefined
        ? autoRechargeOffConfirmed
        : (existing ? existing.auto_recharge_off_confirmed === 1 : false);
      const nextHardMonthlyLimit = hardMonthlyLimitConfirmed !== undefined
        ? hardMonthlyLimitConfirmed
        : (existing ? existing.hard_monthly_limit_confirmed === 1 : false);

      if (nextEnabled && !this.testMode && nextBaselineMode !== 'verified_production') {
        throw new OpenAiPolicyError(
          `Production OpenAI budget policy for "${scope}" requires a verified_production legacy baseline.`,
          { code: 'UNVERIFIED_SYNTHETIC_BASELINE', notDispatched: true },
        );
      }

      if (nextEnabled && (!nextAutoRechargeOff || !nextHardMonthlyLimit)) {
        throw new OpenAiPolicyError(
          `Enabling OpenAI budget policy for "${scope}" requires autoRechargeOffConfirmed: true and hardMonthlyLimitConfirmed: true.`,
          { code: 'PLATFORM_BILLING_CONTROLS_UNVERIFIED' },
        );
      }

      const nextStage4 = allowStage4Media !== undefined
        ? allowStage4Media
        : (existing ? existing.allow_stage4_media === 1 : false);

      const upsertCarryoverStmt = this.db.prepare(`
        INSERT INTO openai_legacy_carryover (
          account_scope, month_utc, carryover_cents, source_sha256, summary_json, reconciled_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_scope, month_utc) DO UPDATE SET
          carryover_cents = MAX(openai_legacy_carryover.carryover_cents, excluded.carryover_cents),
          source_sha256 = excluded.source_sha256,
          summary_json = excluded.summary_json,
          reconciled_at = excluded.reconciled_at
      `);
      const selPrevCarryStmt = this.db.prepare(`
        SELECT carryover_cents FROM openai_legacy_carryover
        WHERE account_scope = ? AND month_utc = ?
      `);

      let effectiveSnapshotMonthCarryover = sameMonthCents;
      for (const [entryMonth, entryCents] of perMonthEntries.entries()) {
        const prevRow = selPrevCarryStmt.get(scope, entryMonth);
        const colFallback = (existing && existing.legacy_reconciled_month_utc === entryMonth)
          ? (existing.legacy_carryover_cents ?? 0)
          : 0;
        const mergedCents = Math.max(prevRow ? prevRow.carryover_cents : 0, colFallback, entryCents);
        upsertCarryoverStmt.run(scope, entryMonth, mergedCents, snapshotSha, summaryJson, now);
        if (entryMonth === monthUtc) {
          effectiveSnapshotMonthCarryover = mergedCents;
        }
      }

      const mergedNote = safeNote ?? (existing ? existing.policy_note : null);
      const nextAllMonthsComplete = allMonthsComplete || Boolean(existing?.legacy_all_months_complete === 1);
      const nextInspectedStamp = verified ? verified.inspectedAtMs : (existing?.legacy_inspected_at_ms ?? null);

      if (!existing) {
        this.db.prepare(`
          INSERT INTO openai_budget_policy (
            account_scope, enabled, monthly_limit_cents, same_month_pending_buffer_cents,
            auto_recharge_off_confirmed, hard_monthly_limit_confirmed,
            baseline_mode, legacy_reconciled, legacy_reconciled_month_utc, reconciled_snapshot_month_utc,
            legacy_carryover_cents, legacy_source_sha256, legacy_budget_sha256,
            legacy_source_path_sha256, legacy_source_dev, legacy_source_ino,
            legacy_all_months_complete, legacy_inspected_at_ms,
            legacy_summary_json, legacy_reconciled_at,
            allow_stage4_media, policy_note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          scope,
          nextEnabled ? 1 : 0,
          nextLimit,
          nextPendingBuffer,
          nextAutoRechargeOff ? 1 : 0,
          nextHardMonthlyLimit ? 1 : 0,
          nextBaselineMode,
          monthUtc,
          monthUtc,
          effectiveSnapshotMonthCarryover,
          snapshotSha,
          snapshotSha,
          nextSrcPathSha,
          nextSrcDev,
          nextSrcIno,
          nextAllMonthsComplete ? 1 : 0,
          nextInspectedStamp,
          summaryJson,
          now,
          nextStage4 ? 1 : 0,
          mergedNote,
          now,
          now,
        );
      } else {
        this.db.prepare(`
          UPDATE openai_budget_policy
          SET enabled = ?,
              monthly_limit_cents = ?,
              same_month_pending_buffer_cents = ?,
              auto_recharge_off_confirmed = ?,
              hard_monthly_limit_confirmed = ?,
              baseline_mode = ?,
              legacy_reconciled = 1,
              legacy_reconciled_month_utc = ?,
              reconciled_snapshot_month_utc = ?,
              legacy_carryover_cents = ?,
              legacy_source_sha256 = ?,
              legacy_budget_sha256 = ?,
              legacy_source_path_sha256 = ?,
              legacy_source_dev = ?,
              legacy_source_ino = ?,
              legacy_all_months_complete = ?,
              legacy_inspected_at_ms = ?,
              legacy_summary_json = ?,
              legacy_reconciled_at = ?,
              allow_stage4_media = ?,
              policy_note = ?,
              updated_at = ?
          WHERE account_scope = ?
        `).run(
          nextEnabled ? 1 : 0,
          nextLimit,
          nextPendingBuffer,
          nextAutoRechargeOff ? 1 : 0,
          nextHardMonthlyLimit ? 1 : 0,
          nextBaselineMode,
          monthUtc,
          monthUtc,
          effectiveSnapshotMonthCarryover,
          snapshotSha,
          snapshotSha,
          nextSrcPathSha,
          nextSrcDev,
          nextSrcIno,
          nextAllMonthsComplete ? 1 : 0,
          nextInspectedStamp,
          summaryJson,
          now,
          nextStage4 ? 1 : 0,
          mergedNote,
          now,
          scope,
        );
      }

      return this.getPolicy(scope);
    });
  }

  // ---------------------------------------------------------------------------
  // Durable Batch Upload Receipts (`openai_batch_uploads`) & Private Payloads
  // ---------------------------------------------------------------------------

  /**
   * Direct caller-asserted upload receipts are forbidden (`P0-01`).
   * Reusable upload receipts can only be created inside the verified upload lifecycle
   * from an admitted pre-upload attempt and observed HTTP 200 transport evidence.
   */
  recordBatchUploadReceipt() {
    throw new OpenAiPolicyError(
      'Direct recordBatchUploadReceipt is forbidden; upload receipts can only be minted inside the verified OpenAiClient upload lifecycle from admitted bytes and an observed /v1/files response.',
      { code: 'UNVERIFIED_BATCH_UPLOAD_RECEIPT_FORBIDDEN', notDispatched: true },
    );
  }

  _commitVerifiedBatchUploadReceipt(authorityToken, {
    sourceAttemptId,
    accountScope = 'openai-default',
    uploadedFileId,
    apiBaseUrl,
    origin,
    credentialFingerprintSha256,
    transportReceipt,
  }) {
    if (
      registeredClientUploadAuthority === null ||
      authorityToken !== registeredClientUploadAuthority
    ) {
      throw new OpenAiPolicyError(
        'Unverified batch upload receipt call rejected.',
        { code: 'UNVERIFIED_BATCH_UPLOAD_RECEIPT_FORBIDDEN', notDispatched: true },
      );
    }
    this._assertWritable();
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const cleanFileId = assertSafeShortLabel(uploadedFileId, 'uploadedFileId', 128);
    const cleanApiBaseUrl = assertSafeApiBaseUrl(apiBaseUrl);
    const cleanOrigin = assertSafeOrigin(origin);
    if (!cleanApiBaseUrl || !cleanOrigin) {
      throw new OpenAiValidationError('apiBaseUrl and origin are required when committing a verified batch upload receipt.');
    }
    const cleanFp = assertSha256Hex(credentialFingerprintSha256, 'credentialFingerprintSha256');
    if (!sourceAttemptId || typeof sourceAttemptId !== 'string' || !sourceAttemptId.trim()) {
      throw new OpenAiValidationError('sourceAttemptId is required for a verified batch upload receipt.');
    }
    const cleanSourceAttempt = sourceAttemptId.trim();
    assertSafeStoredValue(cleanSourceAttempt, 'sourceAttemptId');

    if (
      !transportReceipt ||
      typeof transportReceipt !== 'object' ||
      transportReceipt.method !== 'POST' ||
      transportReceipt.httpStatus !== 200 ||
      transportReceipt.fileId !== cleanFileId ||
      !HEX_SHA256_RE.test(String(transportReceipt.bodySha256 || ''))
    ) {
      throw new OpenAiPolicyError(
        'Verified batch upload receipt requires an observed POST /v1/files HTTP 200 transportReceipt.',
        { code: 'UNVERIFIED_BATCH_UPLOAD_RECEIPT_FORBIDDEN' },
      );
    }

    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const attempt = this.getAttemptById(cleanSourceAttempt, { accountScope: scope });
      if (!attempt) {
        throw new OpenAiBudgetError(`OpenAI upload/batch attempt "${cleanSourceAttempt}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (attempt.status !== 'in_progress') {
        throw new OpenAiBudgetError(
          `Upload source attempt "${attempt.attempt_id}" is not in_progress (status="${attempt.status}").`,
          { code: 'INVALID_STATE_TRANSITION' },
        );
      }
      if (attempt.endpoint !== '/v1/files' && attempt.endpoint !== '/v1/batches') {
        throw new OpenAiValidationError('Verified batch upload source attempt must be /v1/files or /v1/batches.');
      }
      if (attempt.api_base_url !== cleanApiBaseUrl || attempt.credential_fingerprint_sha256 !== cleanFp) {
        throw new OpenAiPolicyError(
          'Upload source attempt connection binding does not match current API route or credential.',
          { code: 'CREDENTIAL_MISMATCH_ON_RECOVERY' },
        );
      }

      const admittedManifest = attempt.batch_manifest;
      if (
        !admittedManifest ||
        typeof admittedManifest !== 'object' ||
        typeof admittedManifest.endpoint !== 'string' ||
        !HEX_SHA256_RE.test(String(admittedManifest.jsonl_sha256 || '')) ||
        !Array.isArray(admittedManifest.custom_ids) ||
        admittedManifest.custom_ids.length < 1 ||
        !admittedManifest.line_models ||
        !admittedManifest.line_specs ||
        !Number.isSafeInteger(admittedManifest.estimated_reservation_cents) ||
        admittedManifest.estimated_reservation_cents < 1
      ) {
        throw new OpenAiValidationError('Admitted upload attempt is missing a complete batch_manifest.');
      }

      if (admittedManifest.uploaded_file_id && admittedManifest.uploaded_file_id !== cleanFileId) {
        throw new OpenAiBudgetError(
          `Attempt "${attempt.attempt_id}" already recorded uploaded_file_id "${admittedManifest.uploaded_file_id}".`,
          { code: 'BATCH_UPLOADED_FILE_ID_IMMUTABLE' },
        );
      }

      const mergedManifest = {
        ...admittedManifest,
        input_file_id: cleanFileId,
        uploaded_file_id: cleanFileId,
      };
      assertSafeStoredValue(mergedManifest, 'batchManifest');
      const manifestJson = canonicalJson(mergedManifest);

      const existing = this.db.prepare(`
        SELECT * FROM openai_batch_uploads
        WHERE account_scope = ? AND uploaded_file_id = ?
      `).get(scope, cleanFileId);
      if (existing) {
        if (
          existing.jsonl_sha256 !== admittedManifest.jsonl_sha256 ||
          existing.endpoint !== admittedManifest.endpoint ||
          existing.api_base_url !== cleanApiBaseUrl ||
          existing.credential_fingerprint_sha256 !== cleanFp
        ) {
          throw new OpenAiBudgetError(
            `Batch uploaded_file_id "${cleanFileId}" is already bound to a different jsonl_sha256, endpoint, route, or credential.`,
            { code: 'BATCH_UPLOADED_FILE_ID_IMMUTABLE' },
          );
        }
      } else {
        this.db.prepare(`
          INSERT INTO openai_batch_uploads (
            account_scope, uploaded_file_id, endpoint, origin, api_base_url,
            credential_fingerprint_sha256, jsonl_sha256, line_count,
            estimated_reservation_cents, manifest_json, source_attempt_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          scope,
          cleanFileId,
          admittedManifest.endpoint,
          cleanOrigin,
          cleanApiBaseUrl,
          cleanFp,
          admittedManifest.jsonl_sha256,
          admittedManifest.custom_ids.length,
          admittedManifest.estimated_reservation_cents,
          manifestJson,
          attempt.attempt_id,
          now,
        );
      }

      if (attempt.endpoint === '/v1/files') {
        const safeReceiptJson = canonicalJson({
          id: cleanFileId,
          object: 'file',
          purpose: 'batch',
          jsonl_sha256: admittedManifest.jsonl_sha256,
          body_sha256: transportReceipt.bodySha256,
        });
        this.db.prepare(`
          UPDATE openai_request_ledger
          SET status = 'completed',
              content_status = 'usable',
              usage_cost_micros = 0,
              provider_response_id = ?,
              http_status = 200,
              batch_manifest_json = ?,
              raw_receipt_json = ?,
              raw_receipt_sha256 = ?,
              original_body_sha256 = ?,
              updated_at = ?,
              finished_at = COALESCE(finished_at, ?)
          WHERE attempt_id = ?
        `).run(
          cleanFileId,
          manifestJson,
          safeReceiptJson,
          sha256Hex(safeReceiptJson),
          transportReceipt.bodySha256,
          now,
          now,
          attempt.attempt_id,
        );
      } else {
        this.db.prepare(`
          UPDATE openai_request_ledger
          SET batch_manifest_json = ?,
              updated_at = ?
          WHERE attempt_id = ?
        `).run(manifestJson, now, attempt.attempt_id);
      }

      return this.getVerifiedBatchUpload(scope, cleanFileId);
    });
  }

  getVerifiedBatchUpload(accountScope, uploadedFileId) {
    const scope = assertSafeOpenAiAccountScope(accountScope);
    if (typeof uploadedFileId !== 'string' || !uploadedFileId.trim()) return null;
    if (!this._hasTable('openai_batch_uploads')) return null;
    const row = this.db.prepare(`
      SELECT * FROM openai_batch_uploads
      WHERE account_scope = ? AND uploaded_file_id = ?
    `).get(scope, uploadedFileId.trim());
    if (!row) return null;
    let parsedManifest = null;
    try { parsedManifest = JSON.parse(row.manifest_json); } catch { parsedManifest = null; }
    return {
      ...row,
      manifest: parsedManifest,
    };
  }

  /**
   * Persist exact original response bytes in `openai_private_payloads` and immediately
   * readback-verify `sha256Hex(raw_bytes) === raw_sha256` (`P0-24`).
   * Refuses storage (returning `{ stored: false }`) if raw bytes contain unredacted secrets/PII.
   */
  savePrivatePayload(attemptId, stage, rawBytes, { literalSecret = null } = {}) {
    this._assertWritable();
    if (typeof attemptId !== 'string' || !attemptId.trim()) {
      throw new OpenAiValidationError('attemptId must be a nonempty string.');
    }
    const cleanAttemptId = attemptId.trim();
    const cleanStage = assertSafeShortLabel(stage, 'stage', 64);
    const buf = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes ?? '');
    const utf8View = buf.toString('utf8');

    if (literalSecret && typeof literalSecret === 'string' && literalSecret.length >= 4 && utf8View.includes(literalSecret)) {
      return { stored: false, reason: 'literal_secret_detected', raw_sha256: sha256Hex(buf) };
    }
    if (detectRawPii(utf8View) !== null || containsSecretToken(utf8View)) {
      return { stored: false, reason: 'pii_or_secret_token_detected', raw_sha256: sha256Hex(buf) };
    }

    const expectedSha = sha256Hex(buf);
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      this.db.prepare(`
        INSERT INTO openai_private_payloads (
          attempt_id, stage, raw_bytes, raw_sha256, byte_length, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, stage) DO NOTHING
      `).run(cleanAttemptId, cleanStage, buf, expectedSha, buf.length, now);

      const readback = this.db.prepare(`
        SELECT raw_bytes, raw_sha256, byte_length
        FROM openai_private_payloads
        WHERE attempt_id = ? AND stage = ?
      `).get(cleanAttemptId, cleanStage);

      if (!readback || readback.raw_bytes === null || readback.raw_bytes === undefined) {
        return { stored: false, reason: 'readback_missing', raw_sha256: expectedSha };
      }
      const rbBuf = Buffer.isBuffer(readback.raw_bytes)
        ? readback.raw_bytes
        : Buffer.from(readback.raw_bytes);
      const actualSha = sha256Hex(rbBuf);
      if (actualSha !== readback.raw_sha256 || rbBuf.length !== Number(readback.byte_length)) {
        return { stored: false, reason: 'readback_sha256_mismatch', raw_sha256: expectedSha };
      }
      return {
        stored: true,
        attempt_id: cleanAttemptId,
        stage: cleanStage,
        raw_sha256: String(readback.raw_sha256),
        byte_length: rbBuf.length,
        private_receipt_ref: `openai-private:${cleanAttemptId}:${cleanStage}`,
      };
    });
  }

  getVerifiedPrivatePayload(attemptId, stage = 'response_post', { accountScope = null } = {}) {
    if (typeof attemptId !== 'string' || !attemptId.trim()) return null;
    const cleanAttemptId = attemptId.trim();
    const cleanStage = assertSafeShortLabel(stage, 'stage', 64);
    if (accountScope !== null && accountScope !== undefined) {
      const attempt = this.getAttemptById(cleanAttemptId, { accountScope });
      if (!attempt) return null;
    }
    if (!this._hasTable('openai_private_payloads')) return null;
    const row = this.db.prepare(`
      SELECT attempt_id, stage, raw_bytes, raw_sha256, byte_length, created_at
      FROM openai_private_payloads
      WHERE attempt_id = ? AND stage = ?
    `).get(cleanAttemptId, cleanStage);
    if (!row || row.raw_bytes === null || row.raw_bytes === undefined) return null;
    const buf = Buffer.isBuffer(row.raw_bytes) ? Buffer.from(row.raw_bytes) : Buffer.from(row.raw_bytes);
    if (sha256Hex(buf) !== row.raw_sha256) {
      throw new OpenAiBudgetError(
        `Stored private payload for attempt "${cleanAttemptId}" stage "${cleanStage}" failed SHA-256 readback verification.`,
        { code: 'PRIVATE_PAYLOAD_CORRUPTED' },
      );
    }
    return {
      attempt_id: row.attempt_id,
      stage: row.stage,
      raw_bytes: buf,
      raw_sha256: row.raw_sha256,
      byte_length: buf.length,
      created_at: row.created_at,
    };
  }

  _hasVerifiedOriginalBytesForAttempt(existing) {
    if (!existing || !existing.original_body_sha256) return false;
    if (!this._hasTable('openai_private_payloads')) return false;
    const rows = this.db.prepare(`
      SELECT stage, raw_bytes, raw_sha256
      FROM openai_private_payloads
      WHERE attempt_id = ?
    `).all(existing.attempt_id);
    for (const r of rows) {
      if (!r || r.raw_bytes === null || r.raw_bytes === undefined) continue;
      const buf = Buffer.isBuffer(r.raw_bytes) ? r.raw_bytes : Buffer.from(r.raw_bytes);
      const sha = sha256Hex(buf);
      if (sha === r.raw_sha256 && sha === existing.original_body_sha256) {
        return true;
      }
    }
    return false;
  }

  /**
   * Explicit operator verification to bind `api_base_url` and `credential_fingerprint_sha256`
   * onto a quarantined migrated legacy attempt (`P0-03`, `P0-18`).
   */
  verifyLegacyAttemptConnectionBinding(attemptId, {
    accountScope = 'openai-default',
    apiBaseUrl,
    credentialFingerprintSha256,
    note,
  } = {}) {
    this._assertWritable();
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const cleanApiBaseUrl = assertSafeApiBaseUrl(apiBaseUrl);
    if (!cleanApiBaseUrl) {
      throw new OpenAiValidationError('apiBaseUrl is required to verify legacy attempt connection binding.');
    }
    const cleanOrigin = assertSafeOrigin(new URL(cleanApiBaseUrl).origin);
    const cleanFp = assertSha256Hex(credentialFingerprintSha256, 'credentialFingerprintSha256');
    const cleanNote = sanitizeSafeNote(note, 'reconciliation_note');
    if (!cleanNote) {
      throw new OpenAiValidationError('A nonempty operator note is required.');
    }
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttemptById(attemptId, { accountScope: scope });
      if (!existing) {
        throw new OpenAiBudgetError(`Attempt "${attemptId}" not found.`, { code: 'ATTEMPT_NOT_FOUND' });
      }
      if (existing.api_base_url && existing.api_base_url !== cleanApiBaseUrl) {
        throw new OpenAiPolicyError('Attempt already has a bound api_base_url that cannot be overwritten.', {
          code: 'API_BASE_URL_MISMATCH_ON_RECOVERY',
        });
      }
      if (existing.origin && existing.origin !== cleanOrigin) {
        throw new OpenAiPolicyError('Attempt already has a bound origin that cannot be overwritten.', {
          code: 'ORIGIN_MISMATCH_ON_RECOVERY',
        });
      }
      if (existing.credential_fingerprint_sha256 && existing.credential_fingerprint_sha256 !== cleanFp) {
        throw new OpenAiPolicyError('Attempt already has a bound credential_fingerprint_sha256 that cannot be overwritten.', {
          code: 'CREDENTIAL_MISMATCH_ON_RECOVERY',
        });
      }
      this.db.prepare(`
        UPDATE openai_request_ledger
        SET origin = ?,
            api_base_url = ?,
            credential_fingerprint_sha256 = ?,
            reconciliation_note = COALESCE(reconciliation_note || ' | ', '') || ?,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(cleanOrigin, cleanApiBaseUrl, cleanFp, cleanNote, now, existing.attempt_id);
      return this.getAttemptById(existing.attempt_id);
    });
  }

  // ---------------------------------------------------------------------------
  // Atomic Reservation, Submission Fence & Lifecycle Transitions
  // ---------------------------------------------------------------------------

  _hydrateAttemptRow(row) {
    if (!row) return null;
    let usage = null;
    let provisionalUsage = null;
    let rawReceipt = null;
    let batchManifest = null;
    let responseFormat = null;
    let deleteAckReceipt = null;
    let cleanup404Receipt = null;
    let recoveryHistory = [];
    if (row.usage_json !== undefined && row.usage_json !== null) {
      try { usage = JSON.parse(row.usage_json); } catch { usage = null; }
    }
    if (row.provisional_usage_json !== undefined && row.provisional_usage_json !== null) {
      try { provisionalUsage = JSON.parse(row.provisional_usage_json); } catch { provisionalUsage = null; }
    }
    if (row.raw_receipt_json !== undefined && row.raw_receipt_json !== null) {
      try { rawReceipt = JSON.parse(row.raw_receipt_json); } catch { rawReceipt = null; }
    }
    if (row.batch_manifest_json !== undefined && row.batch_manifest_json !== null) {
      try { batchManifest = JSON.parse(row.batch_manifest_json); } catch { batchManifest = null; }
    }
    if (row.response_format_json !== undefined && row.response_format_json !== null) {
      try { responseFormat = JSON.parse(row.response_format_json); } catch { responseFormat = null; }
    }
    if (row.delete_ack_receipt_json !== undefined && row.delete_ack_receipt_json !== null) {
      try { deleteAckReceipt = JSON.parse(row.delete_ack_receipt_json); } catch { deleteAckReceipt = null; }
    }
    if (row.cleanup_404_receipt_json !== undefined && row.cleanup_404_receipt_json !== null) {
      try { cleanup404Receipt = JSON.parse(row.cleanup_404_receipt_json); } catch { cleanup404Receipt = null; }
    }
    if (row.recovery_history_json !== undefined && row.recovery_history_json !== null) {
      try {
        const parsed = JSON.parse(row.recovery_history_json);
        if (Array.isArray(parsed)) recoveryHistory = parsed;
      } catch {
        recoveryHistory = [];
      }
    }
    const inferredCleanupReq =
      row.cleanup_required === 1 ||
      ((row.cleanup_status === 'pending_cleanup' || row.cleanup_status === 'delete_failed') &&
        row.status !== 'not_submitted' &&
        row.status !== 'rejected');
    return {
      ...row,
      store_mode: row.store_mode !== undefined && row.store_mode !== null ? Number(row.store_mode) : 1,
      background_mode: row.background_mode === 1,
      background_cancel_dispatched_at: row.background_cancel_dispatched_at ?? null,
      background_delete_dispatched_at: row.background_delete_dispatched_at ?? null,
      background_usage_floor_micros: row.background_usage_floor_micros ?? null,
      cleanup_required: Boolean(inferredCleanupReq),
      confirmed_zero_charge: row.confirmed_zero_charge === 1,
      confirmed_not_created_remotely: row.confirmed_not_created_remotely === 1,
      usage,
      provisional_usage: provisionalUsage,
      raw_receipt: rawReceipt,
      batch_manifest: batchManifest,
      response_format: responseFormat,
      delete_ack_receipt: deleteAckReceipt,
      cleanup_404_receipt: cleanup404Receipt,
      recovery_history: recoveryHistory,
    };
  }

  getAttemptById(attemptId, { accountScope = null } = {}) {
    if (typeof attemptId !== 'string' || !attemptId.trim()) {
      return null;
    }
    if (!this._hasTable('openai_request_ledger')) return null;
    const key = attemptId.trim();
    const row = this.db.prepare('SELECT * FROM openai_request_ledger WHERE attempt_id = ?').get(key);
    if (!row) return null;
    if (accountScope !== null && accountScope !== undefined) {
      const scope = assertSafeOpenAiAccountScope(accountScope);
      if (row.account_scope !== scope) {
        throw new OpenAiBudgetError(
          `Attempt "${sanitizeDiagnosticText(key)}" is not accessible under account_scope "${scope}".`,
          { code: 'ATTEMPT_SCOPE_MISMATCH' },
        );
      }
    }
    return this._hydrateAttemptRow(row);
  }

  getAttemptByLogicalId(logicalRequestId, scopeOrOptions = null) {
    if (typeof logicalRequestId !== 'string' || !logicalRequestId.trim()) {
      return null;
    }
    if (!this._hasTable('openai_request_ledger')) return null;
    const key = logicalRequestId.trim();
    const rawScope =
      scopeOrOptions && typeof scopeOrOptions === 'object' && !Array.isArray(scopeOrOptions)
        ? (scopeOrOptions.accountScope ?? null)
        : scopeOrOptions;
    const row = this.db.prepare('SELECT * FROM openai_request_ledger WHERE logical_request_id = ?').get(key);
    if (!row) return null;
    if (rawScope !== null && rawScope !== undefined) {
      const scope = assertSafeOpenAiAccountScope(rawScope);
      if (row.account_scope !== scope) {
        throw new OpenAiBudgetError(
          `Logical request "${sanitizeDiagnosticText(key)}" is not accessible under account_scope "${scope}".`,
          { code: 'ATTEMPT_SCOPE_MISMATCH' },
        );
      }
    }
    return this._hydrateAttemptRow(row);
  }

  getAttemptByProviderResponseId(providerResponseId, {
    accountScope = 'openai-default',
    endpoint = '/v1/responses',
  } = {}) {
    const id = assertSafeProviderResourceId(providerResponseId);
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const cleanEndpoint = assertSafeShortLabel(endpoint, 'endpoint');
    if (!this._hasTable('openai_request_ledger')) return null;
    if (this.readOnly && !this.db.prepare('PRAGMA table_info("openai_request_ledger")').all()
      .some(column => column.name === 'provider_response_id')) {
      return null;
    }
    const row = this.db.prepare(`
      SELECT * FROM openai_request_ledger
      WHERE endpoint = ? AND provider_response_id = ? AND account_scope = ?
    `).get(cleanEndpoint, id, scope);
    return this._hydrateAttemptRow(row);
  }

  getAttempt(selector, { accountScope = null } = {}) {
    if (typeof selector !== 'string' || !selector.trim()) {
      return null;
    }
    if (!this._hasTable('openai_request_ledger')) return null;
    const key = selector.trim();
    const byId = this.db.prepare('SELECT * FROM openai_request_ledger WHERE attempt_id = ?').get(key);
    const byLogical = this.db.prepare('SELECT * FROM openai_request_ledger WHERE logical_request_id = ?').get(key);
    if (byId && byLogical && byId.attempt_id !== byLogical.attempt_id) {
      throw new OpenAiBudgetError(
        `Ambiguous selector "${sanitizeDiagnosticText(key)}" matches both an attempt_id and a logical_request_id.`,
        { code: 'AMBIGUOUS_ATTEMPT_SELECTOR' },
      );
    }
    const row = byId ?? byLogical ?? null;
    if (!row) return null;
    if (accountScope !== null && accountScope !== undefined) {
      const scope = assertSafeOpenAiAccountScope(accountScope);
      if (row.account_scope !== scope) {
        throw new OpenAiBudgetError(
          `Attempt "${sanitizeDiagnosticText(key)}" is not accessible under account_scope "${scope}".`,
          { code: 'ATTEMPT_SCOPE_MISMATCH' },
        );
      }
    }
    return this._hydrateAttemptRow(row);
  }

  _assertNoCrossColumnIdCollision(attemptId, logicalRequestId) {
    if (attemptId === logicalRequestId) {
      throw new OpenAiValidationError(
        'attempt_id and logical_request_id must be distinct identifiers.',
        { code: 'ATTEMPT_LOGICAL_ID_COLLISION' },
      );
    }
    const dupAttempt = this.db.prepare(
      'SELECT 1 AS hit FROM openai_request_ledger WHERE attempt_id = ? LIMIT 1',
    ).get(attemptId);
    if (dupAttempt) {
      throw new OpenAiBudgetError(
        `attempt_id "${attemptId}" already exists in openai_request_ledger.`,
        { code: 'DUPLICATE_ATTEMPT_ID' },
      );
    }
    const attemptMatchesExistingLogical = this.db.prepare(
      'SELECT 1 AS hit FROM openai_request_ledger WHERE logical_request_id = ? LIMIT 1',
    ).get(attemptId);
    if (attemptMatchesExistingLogical) {
      throw new OpenAiBudgetError(
        `attempt_id "${attemptId}" collides with an existing logical_request_id.`,
        { code: 'ATTEMPT_LOGICAL_ID_COLLISION' },
      );
    }
    const logicalMatchesExistingAttempt = this.db.prepare(
      'SELECT 1 AS hit FROM openai_request_ledger WHERE attempt_id = ? LIMIT 1',
    ).get(logicalRequestId);
    if (logicalMatchesExistingAttempt) {
      throw new OpenAiBudgetError(
        `logical_request_id "${logicalRequestId}" collides with an existing attempt_id.`,
        { code: 'ATTEMPT_LOGICAL_ID_COLLISION' },
      );
    }
  }

  getActiveFences(accountScope = null) {
    if (!this._hasTable('openai_request_ledger')) return [];
    const { selectSql, unconfirmedRejectedWhere } = this._buildCompatLedgerProjection();
    const fenceWhere = `(status IN ('in_progress', 'pending_recovery') OR ${unconfirmedRejectedWhere})`;
    if (accountScope !== null && accountScope !== undefined) {
      const scope = assertSafeOpenAiAccountScope(accountScope);
      return this.db.prepare(`
        SELECT ${selectSql}
        FROM openai_request_ledger
        WHERE account_scope = ? AND ${fenceWhere}
        ORDER BY created_at ASC, attempt_id ASC
      `).all(scope).map(r => this._hydrateAttemptRow(r));
    }
    return this.db.prepare(`
      SELECT ${selectSql}
      FROM openai_request_ledger
      WHERE ${fenceWhere}
      ORDER BY created_at ASC, attempt_id ASC
    `).all().map(r => this._hydrateAttemptRow(r));
  }

  _lookupMonthCarryoverInfo(scope, targetMonth, policy) {
    if (this._hasTable('openai_legacy_carryover')) {
      const row = this.db.prepare(`
        SELECT carryover_cents FROM openai_legacy_carryover
        WHERE account_scope = ? AND month_utc = ?
      `).get(scope, targetMonth);
      if (row && Number.isSafeInteger(row.carryover_cents) && row.carryover_cents >= 0) {
        return { foundExplicitMonth: true, cents: row.carryover_cents };
      }
    }
    if (policy.legacy_reconciled_month_utc === targetMonth) {
      return { foundExplicitMonth: true, cents: policy.legacy_carryover_cents };
    }
    return { foundExplicitMonth: false, cents: 0 };
  }

  /**
   * Compute monthly reservation/spend summary for an account_scope and monthUtc.
   * Retains `reserved_cents` from ANY prior-month `in_progress`, `pending_recovery`,
   * unverified `cleanup_required`, or unconfirmed `rejected` hold (`P0-13`)!
   */
  getMonthlySummary({ accountScope = 'openai-default', monthUtc = currentMonthUtc(this._nowDate()) } = {}) {
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const targetMonth = assertValidMonthUtc(monthUtc, 'monthUtc');
    const policy = this.getPolicy(scope);
    const cappedMonthlyLimitCents = Math.min(
      MAX_MONTHLY_LIMIT_CENTS,
      Math.max(0, Number.isSafeInteger(policy.monthly_limit_cents) ? policy.monthly_limit_cents : 0),
    );
    const sameMonthPendingBufferCents = isValidSameMonthPendingBuffer(policy.same_month_pending_buffer_cents)
      ? policy.same_month_pending_buffer_cents
      : 0;
    const { cents: legacyCarryoverCents } = this._lookupMonthCarryoverInfo(scope, targetMonth, policy);

    if (!this._hasTable('openai_request_ledger')) {
      return {
        account_scope: scope,
        month_utc: targetMonth,
        enabled: policy.enabled,
        legacy_reconciled: policy.legacy_reconciled,
        monthly_limit_cents: cappedMonthlyLimitCents,
        same_month_pending_buffer_cents: sameMonthPendingBufferCents,
        legacy_carryover_cents: legacyCarryoverCents,
        prior_months_unresolved_reserved_cents: 0,
        cross_month_fenced_cents: 0,
        same_month_active_reserved_cents: 0,
        same_month_pending_recovery_cents: 0,
        same_month_unconfirmed_failure_reserved_cents: 0,
        same_month_known_usage_micros: 0,
        same_month_known_usage_cents_ceiling: 0,
        same_month_posted_billed_cents: 0,
        current_month_committed_cents: 0,
        effective_committed_cents: legacyCarryoverCents,
        remaining_cents: Math.max(0, cappedMonthlyLimitCents - legacyCarryoverCents),
        fenced: false,
        active_attempt_count: 0,
        blocking_attempt_ids: [],
        fencing_attempts: [],
        archived_prior_month_timeouts: [],
        status_counts: Object.create(null),
      };
    }

    const { selectSql, unconfirmedRejectedWhere } = this._buildCompatLedgerProjection();
    // Query targetMonth rows plus prior-month unresolved/timeout rows (auto-archived without locking out the new month).
    const relevantRows = this.db.prepare(`
      SELECT ${selectSql}
      FROM openai_request_ledger
      WHERE account_scope = ?
        AND (
          month_utc = ?
          OR status IN ('in_progress', 'pending_recovery')
          OR ${unconfirmedRejectedWhere}
        )
      ORDER BY created_at ASC, attempt_id ASC
    `).all(scope, targetMonth);

    const priorMonthsUnresolvedCents = 0;
    let sameMonthActiveReservedCents = 0;
    let sameMonthPendingRecoveryCents = 0;
    let sameMonthUnconfirmedFailureCents = 0;
    let sameMonthKnownUsageMicros = 0;
    let sameMonthUnbilledUsageMicros = 0;
    let sameMonthPostedBilledCents = 0;
    let sameMonthPostedEffectiveCents = 0;
    const fencingAttempts = [];
    const archivedPriorMonthTimeouts = [];
    const statusCounts = Object.create(null);

    for (const row of relevantRows) {
      if (row.month_utc === targetMonth) {
        incrementHistogramCount(statusCounts, row.status, 1);
      }

      const unconfirmedRejectedFence =
        row.status === 'rejected' &&
        row.confirmed_zero_charge !== 1 &&
        (row.usage_cost_micros === null || row.usage_cost_micros === undefined) &&
        !(row.posted_billed_cents !== null && row.posted_billed_cents !== undefined && row.posted_billed_cents > 0);

      if (
        row.status === 'in_progress' ||
        row.status === 'pending_recovery' ||
        unconfirmedRejectedFence
      ) {
        const usageCeil = row.usage_cost_micros !== null && row.usage_cost_micros !== undefined
          ? microsToCeilingCents(row.usage_cost_micros)
          : 0;
        const provCeil = row.provisional_usage_cost_micros !== null && row.provisional_usage_cost_micros !== undefined
          ? microsToCeilingCents(row.provisional_usage_cost_micros)
          : 0;
        const posted = row.posted_billed_cents !== null && row.posted_billed_cents !== undefined
          ? row.posted_billed_cents
          : 0;
        const backgroundUsageCeil = microsToCeilingCents(row.background_usage_floor_micros ?? 0);
        // Slimmed local budget policy: count ONLY actual observed/billed spend, never speculative upfront reserved_cents.
        const realizedHoldCents = Math.max(usageCeil, provCeil, posted, backgroundUsageCeil);

        if (row.month_utc !== targetMonth) {
          // Auto-archive historical prior-month timeouts/unresolved attempts without locking out or charging the new month.
          archivedPriorMonthTimeouts.push({
            attempt_id: row.attempt_id,
            logical_request_id: row.logical_request_id,
            status: row.status,
            month_utc: row.month_utc,
            realized_cents: realizedHoldCents,
            provider_response_id: row.provider_response_id ?? null,
            diagnostic_reason: row.diagnostic_reason ?? null,
          });
          continue;
        }

        fencingAttempts.push({
          attempt_id: row.attempt_id,
          logical_request_id: row.logical_request_id,
          status: row.status,
          cleanup_required: Boolean(
            row.cleanup_required === 1 ||
            row.cleanup_status === 'pending_cleanup' ||
            row.cleanup_status === 'delete_failed',
          ),
          cleanup_status: row.cleanup_status ?? null,
          month_utc: row.month_utc,
          reserved_cents: realizedHoldCents,
          provider_response_id: row.provider_response_id ?? null,
          diagnostic_reason: row.diagnostic_reason ?? null,
        });
        if (row.status === 'pending_recovery') sameMonthPendingRecoveryCents += realizedHoldCents;
        if (unconfirmedRejectedFence) {
          sameMonthUnconfirmedFailureCents += realizedHoldCents;
        } else {
          sameMonthActiveReservedCents += realizedHoldCents;
        }
        const knownOrProv = Math.max(
          row.usage_cost_micros ?? 0,
          row.provisional_usage_cost_micros ?? 0,
          row.background_usage_floor_micros ?? 0,
        );
        if (
          row.usage_cost_micros !== null ||
          row.provisional_usage_cost_micros !== null ||
          (row.background_usage_floor_micros ?? 0) > 0
        ) {
          sameMonthKnownUsageMicros += knownOrProv;
        }
        if (row.posted_billed_cents !== null && row.posted_billed_cents !== undefined) {
          sameMonthPostedBilledCents += row.posted_billed_cents;
          sameMonthPostedEffectiveCents += Math.max(row.posted_billed_cents, usageCeil, provCeil, backgroundUsageCeil);
        } else if (knownOrProv > 0) {
          sameMonthUnbilledUsageMicros += knownOrProv;
        }
        continue;
      }

      if (row.month_utc !== targetMonth) continue;
      if (row.status === 'not_submitted') continue;

      const hasAuthoritativeUsage = row.usage_cost_micros !== null && row.usage_cost_micros !== undefined;
      const rowKnownOrProvMicros = hasAuthoritativeUsage
        ? row.usage_cost_micros
        : Math.max(
            row.provisional_usage_cost_micros ?? 0,
            row.background_usage_floor_micros ?? 0,
          );
      if (
        hasAuthoritativeUsage ||
        row.provisional_usage_cost_micros !== null ||
        (row.background_usage_floor_micros ?? 0) > 0
      ) {
        sameMonthKnownUsageMicros += rowKnownOrProvMicros;
      }
      if (row.posted_billed_cents !== null && row.posted_billed_cents !== undefined) {
        sameMonthPostedBilledCents += row.posted_billed_cents;
      }

      const rowEffectiveCeil = microsToCeilingCents(rowKnownOrProvMicros);

      if (row.status === 'completed') {
        if (row.posted_billed_cents !== null && row.posted_billed_cents !== undefined) {
          sameMonthPostedEffectiveCents += Math.max(row.posted_billed_cents, rowEffectiveCeil);
        } else if (rowKnownOrProvMicros > 0) {
          sameMonthUnbilledUsageMicros += rowKnownOrProvMicros;
        }
        continue;
      }

      if (row.status === 'rejected' || row.status === 'failed_known') {
        if (
          row.confirmed_zero_charge === 1 &&
          !(row.posted_billed_cents > 0) &&
          !(row.usage_cost_micros > 0) &&
          !(row.provisional_usage_cost_micros > 0) &&
          !(hasAuthoritativeUsage ? false : (row.background_usage_floor_micros ?? 0) > 0)
        ) {
          continue;
        }
        if (row.posted_billed_cents !== null && row.posted_billed_cents !== undefined && row.posted_billed_cents > 0) {
          sameMonthPostedEffectiveCents += Math.max(row.posted_billed_cents, rowEffectiveCeil);
        } else if (rowKnownOrProvMicros > 0) {
          sameMonthUnbilledUsageMicros += rowKnownOrProvMicros;
        }
      }
    }

    const sameMonthKnownUsageCentsCeiling = microsToCeilingCents(sameMonthKnownUsageMicros);
    const sameMonthUnbilledUsageCentsCeiling = microsToCeilingCents(sameMonthUnbilledUsageMicros);
    const currentMonthCommittedCents =
      sameMonthPostedEffectiveCents +
      sameMonthUnbilledUsageCentsCeiling;
    const effectiveCommittedCents =
      legacyCarryoverCents +
      currentMonthCommittedCents;
    // Slimmed local budget policy: never globally lock out the entire account on a timeout or cross-month hold;
    // duplicate retries remain blocked per-request via DUPLICATE_LOGICAL_REQUEST and DUPLICATE_PENDING_PAYLOAD.
    const blockingAttemptIds = [];

    return {
      account_scope: scope,
      month_utc: targetMonth,
      enabled: policy.enabled,
      legacy_reconciled: policy.legacy_reconciled,
      monthly_limit_cents: cappedMonthlyLimitCents,
      same_month_pending_buffer_cents: sameMonthPendingBufferCents,
      legacy_carryover_cents: legacyCarryoverCents,
      prior_months_unresolved_reserved_cents: priorMonthsUnresolvedCents,
      cross_month_fenced_cents: priorMonthsUnresolvedCents,
      same_month_active_reserved_cents: sameMonthActiveReservedCents,
      same_month_pending_recovery_cents: sameMonthPendingRecoveryCents,
      same_month_unconfirmed_failure_reserved_cents: sameMonthUnconfirmedFailureCents,
      same_month_known_usage_micros: sameMonthKnownUsageMicros,
      same_month_known_usage_cents_ceiling: sameMonthKnownUsageCentsCeiling,
      same_month_posted_billed_cents: sameMonthPostedBilledCents,
      current_month_committed_cents: currentMonthCommittedCents,
      effective_committed_cents: effectiveCommittedCents,
      remaining_cents: Math.max(0, cappedMonthlyLimitCents - effectiveCommittedCents),
      fenced: false,
      active_attempt_count: fencingAttempts.length,
      blocking_attempt_ids: blockingAttemptIds,
      fencing_attempts: fencingAttempts,
      archived_prior_month_timeouts: archivedPriorMonthTimeouts,
      status_counts: statusCounts,
    };
  }

  getStatus({ accountScope = 'openai-default', monthUtc = currentMonthUtc(this._nowDate()) } = {}) {
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const policy = this.getPolicy(scope);
    const monthly = this.getMonthlySummary({ accountScope: scope, monthUtc });
    const totalRequests = this._hasTable('openai_request_ledger')
      ? this.db.prepare('SELECT COUNT(*) AS c FROM openai_request_ledger WHERE account_scope = ?').get(scope).c
      : 0;
    return {
      db_path: sanitizeDisplayPath(this.dbPath),
      read_only: this.readOnly,
      test_mode: this.testMode,
      schema_initialized: policy.schema_initialized,
      policy,
      monthly,
      total_requests: totalRequests,
      active_fences: monthly.fencing_attempts,
    };
  }

  /**
   * Record a local `not_submitted` audit row (0 cents reserved) without dispatching.
   */
  recordNotSubmitted({
    logicalRequestId,
    accountScope = 'openai-default',
    monthUtc = currentMonthUtc(this._nowDate()),
    endpoint,
    model,
    serviceTier = 'standard',
    payloadSha256,
    packetSha256 = null,
    reason = 'Request rejected locally before submission.',
  }) {
    this._assertWritable();
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const month = assertValidMonthUtc(monthUtc, 'monthUtc');
    if (typeof logicalRequestId !== 'string' || !logicalRequestId.trim()) {
      throw new OpenAiValidationError('logicalRequestId must be a nonempty string.');
    }
    const cleanLogicalId = logicalRequestId.trim();
    assertSafeStoredValue(cleanLogicalId, 'logicalRequestId');
    const cleanEndpoint = assertSafeShortLabel(endpoint, 'endpoint');
    const cleanModel = assertSafeShortLabel(model, 'model');
    const cleanTier = assertSafeShortLabel(serviceTier ?? 'standard', 'serviceTier', 32);
    const pSha = assertSha256Hex(payloadSha256, 'payloadSha256');
    const pktSha = packetSha256 ? assertSha256Hex(packetSha256, 'packetSha256') : null;
    const cleanReason = sanitizeSafeNote(reason, 'diagnostic_reason');
    const attemptId = generatePiiSafeUuid();
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.db.prepare(
        'SELECT * FROM openai_request_ledger WHERE logical_request_id = ?',
      ).get(cleanLogicalId);
      if (existing) {
        if (existing.account_scope !== scope) {
          throw new OpenAiBudgetError(
            `logical_request_id "${sanitizeDiagnosticText(cleanLogicalId)}" is not accessible under account_scope "${scope}".`,
            { code: 'ATTEMPT_SCOPE_MISMATCH' },
          );
        }
        if (existing.payload_sha256 !== pSha) {
          throw new OpenAiBudgetError(
            `logical_request_id "${cleanLogicalId}" cannot be reused with a different payload_sha256.`,
            { code: 'PAYLOAD_HASH_MISMATCH' },
          );
        }
        return this._hydrateAttemptRow(existing);
      }
      this._assertNoCrossColumnIdCollision(attemptId, cleanLogicalId);

      this.db.prepare(`
        INSERT INTO openai_request_ledger (
          attempt_id, logical_request_id, account_scope, month_utc,
          endpoint, model, service_tier, payload_sha256, packet_sha256,
          status, reserved_cents, confirmed_zero_charge,
          cleanup_required, cleanup_status, diagnostic_reason,
          created_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_submitted', 0, 1, 0, 'not_requested', ?, ?, ?, ?)
      `).run(
        attemptId,
        cleanLogicalId,
        scope,
        month,
        cleanEndpoint,
        cleanModel,
        cleanTier,
        pSha,
        pktSha,
        cleanReason,
        now,
        now,
        now,
      );
      return this.getAttemptById(attemptId);
    });
  }

  _checkLockedLogicalIdCollisionsInTx(scope, cleanLogicalId, lockedLogicalIds) {
    const checkSet = new Set([cleanLogicalId]);
    if (Array.isArray(lockedLogicalIds)) {
      for (const id of lockedLogicalIds) {
        if (typeof id === 'string' && id.trim()) {
          checkSet.add(id.trim());
        }
      }
    }

    for (const candidateId of checkSet) {
      if (candidateId !== cleanLogicalId) {
        const directRow = this.db.prepare(
          'SELECT account_scope, attempt_id, status FROM openai_request_ledger WHERE logical_request_id = ?',
        ).get(candidateId);
        if (directRow && directRow.status !== 'not_submitted') {
          if (directRow.account_scope !== scope) {
            throw new OpenAiBudgetError(
              `Locked logical request "${sanitizeDiagnosticText(candidateId)}" is not accessible under account_scope "${scope}".`,
              { code: 'ATTEMPT_SCOPE_MISMATCH', notDispatched: true },
            );
          }
          throw new OpenAiBudgetError(
            `Locked logical request "${candidateId}" already has a recorded attempt (${directRow.attempt_id}, status=${directRow.status}); cross-endpoint re-submission is forbidden.`,
            { code: 'DUPLICATE_LOGICAL_REQUEST', notDispatched: true },
          );
        }
      }
    }

    const batchRows = this.db.prepare(`
      SELECT attempt_id, account_scope, status, batch_manifest_json
      FROM openai_request_ledger
      WHERE endpoint = '/v1/batches' AND batch_manifest_json IS NOT NULL AND status != 'not_submitted'
    `).all();
    for (const bRow of batchRows) {
      let manifest = null;
      try { manifest = JSON.parse(bRow.batch_manifest_json); } catch { manifest = null; }
      if (!manifest || !Array.isArray(manifest.locked_logical_ids)) continue;
      for (const lockedId of manifest.locked_logical_ids) {
        if (typeof lockedId === 'string' && checkSet.has(lockedId)) {
          if (bRow.account_scope !== scope) {
            throw new OpenAiBudgetError(
              `Locked logical request "${sanitizeDiagnosticText(lockedId)}" is not accessible under account_scope "${scope}".`,
              { code: 'ATTEMPT_SCOPE_MISMATCH', notDispatched: true },
            );
          }
          throw new OpenAiBudgetError(
            `Logical request "${lockedId}" is already bound inside batch attempt "${bRow.attempt_id}" (status=${bRow.status}); duplicate submission is forbidden.`,
            { code: 'DUPLICATE_LOGICAL_REQUEST', notDispatched: true },
          );
        }
      }
    }
  }

  /**
   * Atomically admit and reserve a billable OpenAI request inside `BEGIN IMMEDIATE`
   * BEFORE network dispatch. Rejects ANY active outer transaction (`P2-10` -> `P0`).
   */
  reserveBillableRequest({
    attemptId = null,
    logicalRequestId,
    accountScope = 'openai-default',
    monthUtc = undefined,
    allowTestClockOverride = false,
    endpoint,
    model,
    serviceTier = 'standard',
    origin = null,
    apiBaseUrl = null,
    storeMode = 1,
    backgroundMode = false,
    payloadSha256,
    packetSha256 = null,
    reservedCents,
    estimatedInputTokens = null,
    maxOutputTokens = null,
    maxWebSearchCalls = 0,
    cleanupRequired = false,
    batchManifest = null,
    responseFormat = null,
    lockedLogicalIds = null,
    requireStage4Media = false,
    credentialFingerprintSha256 = null,
    isLiveTransport = false,
  }) {
    this._assertWritable();
    this._assertNoOuterTransaction('reserveBillableRequest');
    if (typeof isLiveTransport !== 'boolean') {
      throw new OpenAiValidationError('isLiveTransport must be a boolean.');
    }
    if (typeof allowTestClockOverride !== 'boolean') {
      throw new OpenAiValidationError('allowTestClockOverride must be a boolean.');
    }
    if (typeof cleanupRequired !== 'boolean') {
      throw new OpenAiValidationError('cleanupRequired must be a boolean.');
    }
    if (typeof requireStage4Media !== 'boolean') {
      throw new OpenAiValidationError('requireStage4Media must be a boolean.');
    }
    if ((isLiveTransport || !this.testMode) && allowTestClockOverride) {
      throw new OpenAiPolicyError(
        'allowTestClockOverride is forbidden on live/production OpenAI HTTP transport.',
        { code: 'CLOCK_OVERRIDE_FORBIDDEN_ON_LIVE', notDispatched: true },
      );
    }
    if ((isLiveTransport || !this.testMode) && this._mainFile === '') {
      throw new OpenAiPolicyError(
        'In-memory or unbacked SQLite ledgers are forbidden on live/production OpenAI HTTP transport; use a persistent file-backed ledger.',
        { code: 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE', notDispatched: true },
      );
    }
    if (storeMode !== 0 && storeMode !== 1 && typeof storeMode !== 'boolean') {
      throw new OpenAiValidationError('storeMode must be 0, 1, or boolean.');
    }
    if (typeof backgroundMode !== 'boolean') {
      throw new OpenAiValidationError('backgroundMode must be a boolean.');
    }
    const cleanStoreMode = storeMode === 0 || storeMode === false ? 0 : 1;
    if (cleanStoreMode === 0 && cleanupRequired) {
      throw new OpenAiValidationError('cleanupRequired cannot be true when storeMode is 0 (store: false).');
    }

    const scope = assertSafeOpenAiAccountScope(accountScope);
    const cleanApiBaseUrl = assertSafeApiBaseUrl(apiBaseUrl);
    const cleanOrigin = assertSafeOrigin(origin ?? (cleanApiBaseUrl ? new URL(cleanApiBaseUrl).origin : null));

    if (isLiveTransport && !cleanApiBaseUrl) {
      throw new OpenAiPolicyError(
        'Live OpenAI HTTP transport requires apiBaseUrl binding.',
        { code: 'API_BASE_URL_REQUIRED', notDispatched: true },
      );
    }

    let cleanFp = null;
    if (isLiveTransport) {
      if (!credentialFingerprintSha256) {
        throw new OpenAiPolicyError(
          'Live OpenAI HTTP transport requires credentialFingerprintSha256 binding.',
          { code: 'CREDENTIAL_FINGERPRINT_REQUIRED', notDispatched: true },
        );
      }
      cleanFp = assertSha256Hex(credentialFingerprintSha256, 'credentialFingerprintSha256');
    } else if (credentialFingerprintSha256 !== null && credentialFingerprintSha256 !== undefined) {
      cleanFp = assertSha256Hex(credentialFingerprintSha256, 'credentialFingerprintSha256');
    }

    if (typeof logicalRequestId !== 'string' || !logicalRequestId.trim()) {
      throw new OpenAiValidationError('logicalRequestId must be a nonempty string.');
    }
    const cleanLogicalId = logicalRequestId.trim();
    assertSafeStoredValue(cleanLogicalId, 'logicalRequestId');

    const cleanEndpoint = assertSafeShortLabel(endpoint, 'endpoint');
    if (backgroundMode && (cleanEndpoint !== '/v1/responses' || cleanStoreMode !== 1)) {
      throw new OpenAiValidationError('backgroundMode requires a stored /v1/responses request.');
    }
    const cleanModel = assertSafeShortLabel(model, 'model');
    const cleanTier = assertSafeShortLabel(serviceTier ?? 'standard', 'serviceTier', 32);

    const pSha = assertSha256Hex(payloadSha256, 'payloadSha256');
    const pktSha = packetSha256 ? assertSha256Hex(packetSha256, 'packetSha256') : null;
    const cents = reservedCents === undefined || reservedCents === null
      ? 0
      : assertNonNegInt(reservedCents, 'reservedCents');
    const estIn = estimatedInputTokens !== null && estimatedInputTokens !== undefined
      ? assertNonNegInt(estimatedInputTokens, 'estimatedInputTokens')
      : null;
    const maxOut = maxOutputTokens !== null && maxOutputTokens !== undefined
      ? assertNonNegInt(maxOutputTokens, 'maxOutputTokens')
      : null;
    const maxSearch = assertNonNegInt(maxWebSearchCalls ?? 0, 'maxWebSearchCalls');

    let manifestJson = null;
    if (batchManifest !== null && batchManifest !== undefined) {
      if (typeof batchManifest !== 'object' || Array.isArray(batchManifest)) {
        throw new OpenAiValidationError('batchManifest must be a plain object when provided.');
      }
      assertSafeStoredValue(batchManifest, 'batchManifest');
      manifestJson = canonicalJson(batchManifest);
    }

    let responseFormatJson = null;
    if (responseFormat !== null && responseFormat !== undefined) {
      if (typeof responseFormat !== 'object' || Array.isArray(responseFormat)) {
        throw new OpenAiValidationError('responseFormat must be a plain object when provided.');
      }
      assertSafeStoredValue(responseFormat, 'responseFormat');
      responseFormatJson = canonicalJson(responseFormat);
    }

    const resolvedAttemptId = attemptId && typeof attemptId === 'string' && attemptId.trim()
      ? attemptId.trim()
      : generatePiiSafeUuid();
    assertSafeStoredValue(resolvedAttemptId, 'attemptId');

    return this._withImmediateTx(() => {
      // P0-08: Sample authoritative UTC clock INSIDE BEGIN IMMEDIATE!
      const nowDate = this.testMode ? this._nowFn() : new Date();
      const now = nowDate.toISOString();
      const clockMonth = currentMonthUtc(nowDate);
      let month = clockMonth;
      if (monthUtc !== undefined && monthUtc !== null) {
        const requestedMonth = assertValidMonthUtc(monthUtc, 'monthUtc');
        if (requestedMonth !== clockMonth) {
          if (!this.testMode || !allowTestClockOverride) {
            throw new OpenAiPolicyError(
              `monthUtc ("${requestedMonth}") cannot override the ledger UTC clock ("${clockMonth}") unless testMode and allowTestClockOverride are true.`,
              { code: 'MONTH_CLOCK_OVERRIDE_FORBIDDEN', notDispatched: true },
            );
          }
          month = requestedMonth;
        }
      }

      // 1. P2-03: Check logical_request_id uniqueness & account_scope isolation FIRST (before revealing payload_sha256 or status!).
      const existing = this.db.prepare(
        'SELECT * FROM openai_request_ledger WHERE logical_request_id = ?',
      ).get(cleanLogicalId);
      if (existing) {
        if (existing.account_scope !== scope) {
          throw new OpenAiBudgetError(
            `logical_request_id "${sanitizeDiagnosticText(cleanLogicalId)}" is not accessible under account_scope "${scope}".`,
            { code: 'ATTEMPT_SCOPE_MISMATCH', notDispatched: true },
          );
        }
        if (existing.payload_sha256 !== pSha) {
          throw new OpenAiBudgetError(
            `logical_request_id "${cleanLogicalId}" is already bound to payload_sha256 ${existing.payload_sha256} and cannot be reused with ${pSha}.`,
            {
              code: 'PAYLOAD_HASH_MISMATCH',
              notDispatched: true,
              details: {
                logical_request_id: cleanLogicalId,
                existing_payload_sha256: existing.payload_sha256,
                incoming_payload_sha256: pSha,
              },
            },
          );
        }
        throw new OpenAiBudgetError(
          `logical_request_id "${cleanLogicalId}" already has a recorded attempt (${existing.attempt_id}, status=${existing.status}); automatic re-submission is forbidden.`,
          {
            code: 'DUPLICATE_LOGICAL_REQUEST',
            notDispatched: true,
            details: {
              existing_attempt_id: existing.attempt_id,
              existing_status: existing.status,
              logical_request_id: cleanLogicalId,
            },
          },
        );
      }

      // 2. P1-02: Enforce cross-endpoint locked logical request ID uniqueness (direct <-> Batch).
      const effectiveLockedIds = Array.isArray(lockedLogicalIds)
        ? lockedLogicalIds
        : (Array.isArray(batchManifest?.locked_logical_ids) ? batchManifest.locked_logical_ids : null);
      this._checkLockedLogicalIdCollisionsInTx(scope, cleanLogicalId, effectiveLockedIds);

      this._assertNoCrossColumnIdCollision(resolvedAttemptId, cleanLogicalId);

      // 3. P1-36: Enforce budget policy enablement, baseline_mode, legacy reconciliation, billing controls,
      // Stage-4 media gate, AND local credential compatibility BEFORE registering in the canonical registry!
      const rawPolicyRow = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
      if (!rawPolicyRow || rawPolicyRow.enabled !== 1) {
        throw new OpenAiBudgetError(
          `OpenAI budget ledger for "${scope}" is disabled (enabled=false). Reconcile legacy budget and explicitly enable before live API calls.`,
          { code: 'BUDGET_DISABLED', notDispatched: true },
        );
      }
      if (!this.testMode && rawPolicyRow.baseline_mode !== 'verified_production') {
        throw new OpenAiPolicyError(
          `OpenAI budget ledger for "${scope}" has baseline_mode="${String(rawPolicyRow.baseline_mode)}" rather than "verified_production"; synthetic baselines cannot authorize live spend.`,
          { code: 'UNVERIFIED_SYNTHETIC_BASELINE', notDispatched: true },
        );
      }
      if (rawPolicyRow.legacy_reconciled !== 1) {
        throw new OpenAiBudgetError(
          `OpenAI budget ledger for "${scope}" has not reconciled legacy budget state (legacy_reconciled=false).`,
          { code: 'LEGACY_NOT_RECONCILED', notDispatched: true },
        );
      }
      if (!this.testMode && rawPolicyRow.legacy_all_months_complete !== 1) {
        const carryInfo = this._lookupMonthCarryoverInfo(scope, month, this._hydratePolicyRow(rawPolicyRow));
        if (!carryInfo.foundExplicitMonth) {
          throw new OpenAiBudgetError(
            `OpenAI budget ledger for "${scope}" lacks an all-months or ${month} carryover baseline; re-run legacy reconciliation with inspectLegacyAutopilotBudget.`,
            { code: 'LEGACY_MONTH_NOT_RECONCILED', notDispatched: true },
          );
        }
      }
      if (rawPolicyRow.auto_recharge_off_confirmed !== 1 || rawPolicyRow.hard_monthly_limit_confirmed !== 1) {
        throw new OpenAiPolicyError(
          `OpenAI platform billing controls (Auto-recharge OFF + hard monthly limit) are not confirmed for "${scope}".`,
          { code: 'PLATFORM_BILLING_CONTROLS_UNVERIFIED', notDispatched: true },
        );
      }
      if (
        !Number.isSafeInteger(rawPolicyRow.monthly_limit_cents) ||
        rawPolicyRow.monthly_limit_cents < 0 ||
        rawPolicyRow.monthly_limit_cents > MAX_MONTHLY_LIMIT_CENTS
      ) {
        throw new OpenAiPolicyError(
          `OpenAI monthly_limit_cents (${String(rawPolicyRow.monthly_limit_cents)}) for "${scope}" exceeds MAX_MONTHLY_LIMIT_CENTS (${MAX_MONTHLY_LIMIT_CENTS}).`,
          { code: 'MONTHLY_LIMIT_EXCEEDS_CEILING', notDispatched: true },
        );
      }
      validateSameMonthPendingBuffer(rawPolicyRow.same_month_pending_buffer_cents);
      if (requireStage4Media && rawPolicyRow.allow_stage4_media !== 1) {
        throw new OpenAiPolicyError(
          `Stage-4 media generation is disabled in ledger policy for "${scope}" (allow_stage4_media=false).`,
          { code: 'STAGE4_MEDIA_DISABLED', notDispatched: true },
        );
      }
      if (
        rawPolicyRow.credential_fingerprint_sha256 !== null &&
        rawPolicyRow.credential_fingerprint_sha256 !== undefined &&
        rawPolicyRow.credential_fingerprint_sha256 !== cleanFp
      ) {
        throw new OpenAiPolicyError(
          `account_scope "${scope}" is bound to a credential fingerprint; matching credentialFingerprintSha256 is required.`,
          { code: 'CREDENTIAL_SCOPE_MISMATCH', notDispatched: true },
        );
      }
      if (cleanFp !== null) {
        this._bindCredentialInTx(scope, cleanFp, now);
      }

      // 4. Prevent duplicate automatic retries of an identical in-flight or timed-out payload (POST 0 auto-retry),
      // including across month rollover so an unresolved attempt is recovered via GET rather than POSTed twice,
      // while never locking out distinct new jobs in a new month.
      const summary = this.getMonthlySummary({ accountScope: scope, monthUtc: month });
      const matchingHold = this.db.prepare(`
        SELECT attempt_id, logical_request_id
        FROM openai_request_ledger
        WHERE account_scope = ? AND endpoint = ?
          AND payload_sha256 = ? AND status IN ('in_progress', 'pending_recovery')
        ORDER BY created_at ASC, attempt_id ASC
        LIMIT 1
      `).get(scope, cleanEndpoint, pSha);
      if (matchingHold) {
        throw new OpenAiBudgetError(
          'The same OpenAI payload already has an unresolved attempt. Recover or reconcile it before resubmitting.',
          {
            code: 'DUPLICATE_PENDING_PAYLOAD',
            notDispatched: true,
            details: {
              blocking_attempt_id: matchingHold.attempt_id,
              blocking_logical_request_id: matchingHold.logical_request_id,
            },
          },
        );
      }

      // 5. Enforce natural-month realized spend ceiling ($200/month max; zero upfront speculative per-call cap freeze).
      const effectiveLimitCents = Math.min(MAX_MONTHLY_LIMIT_CENTS, rawPolicyRow.monthly_limit_cents);
      if (
        effectiveLimitCents <= 0 ||
        summary.effective_committed_cents >= effectiveLimitCents ||
        (cents > 0 && summary.effective_committed_cents + cents > effectiveLimitCents)
      ) {
        throw new OpenAiBudgetError(
          `OpenAI monthly budget exceeded for "${scope}" in ${month}: committed=${summary.effective_committed_cents}c + requested=${cents}c >= limit=${effectiveLimitCents}c.`,
          {
            code: 'MONTHLY_BUDGET_EXCEEDED',
            notDispatched: true,
            details: {
              month_utc: month,
              committed_cents: summary.effective_committed_cents,
              requested_cents: cents,
              monthly_limit_cents: effectiveLimitCents,
            },
          },
        );
      }

      this.db.prepare(`
        INSERT INTO openai_request_ledger (
          attempt_id, logical_request_id, account_scope, month_utc,
          endpoint, model, service_tier, origin, api_base_url, credential_fingerprint_sha256, store_mode, background_mode,
          payload_sha256, packet_sha256,
          status, reserved_cents, estimated_input_tokens, max_output_tokens, max_web_search_calls,
          usage_cost_micros, posted_billed_cents, confirmed_zero_charge,
          cleanup_required, cleanup_status, batch_manifest_json, response_format_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        resolvedAttemptId,
        cleanLogicalId,
        scope,
        month,
        cleanEndpoint,
        cleanModel,
        cleanTier,
        cleanOrigin,
        cleanApiBaseUrl,
        cleanFp,
        cleanStoreMode,
        backgroundMode ? 1 : 0,
        pSha,
        pktSha,
        cents,
        estIn,
        maxOut,
        maxSearch,
        cleanupRequired ? 1 : 0,
        cleanupRequired ? 'pending_cleanup' : 'not_requested',
        manifestJson,
        responseFormatJson,
        now,
        now,
      );

      return this.getAttemptById(resolvedAttemptId);
    });
  }

  _assertImmutableAndUniqueProviderId(existing, incomingRespId) {
    if (incomingRespId === null || incomingRespId === undefined) return;
    if (!incomingRespId) {
      throw new OpenAiValidationError('providerResponseId cannot be empty when provided.');
    }
    if (
      existing.provider_response_id !== null &&
      existing.provider_response_id !== undefined &&
      existing.provider_response_id !== incomingRespId
    ) {
      throw new OpenAiBudgetError(
        `Attempt "${existing.attempt_id}" is already bound to provider_response_id "${existing.provider_response_id}"; overwriting with "${incomingRespId}" is forbidden.`,
        { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' },
      );
    }
    const otherAttempt = this.db.prepare(`
      SELECT attempt_id FROM openai_request_ledger
      WHERE endpoint = ? AND provider_response_id = ? AND attempt_id != ?
      LIMIT 1
    `).get(existing.endpoint, incomingRespId, existing.attempt_id);
    if (otherAttempt) {
      throw new OpenAiBudgetError(
        `provider_response_id "${incomingRespId}" on "${existing.endpoint}" is already bound to attempt "${otherAttempt.attempt_id}".`,
        { code: 'DUPLICATE_PROVIDER_RESPONSE_ID' },
      );
    }
  }

  _assertVerifiedFirstProviderIdEvidence(existing, cleanRespId, operatorEvidence) {
    if (existing.provider_response_id !== null && existing.provider_response_id !== undefined) {
      return;
    }
    if (!operatorEvidence || typeof operatorEvidence !== 'object' || Array.isArray(operatorEvidence)) {
      throw new OpenAiPolicyError(
        `First-time provider_response_id assignment ("${cleanRespId}") onto attempt "${existing.attempt_id}" requires verified operatorEvidence ({ matchedPayloadSha256, source, note }).`,
        { code: 'UNVERIFIED_FIRST_PROVIDER_ID_ASSIGNMENT' },
      );
    }
    const matchedSha = typeof operatorEvidence.matchedPayloadSha256 === 'string'
      ? operatorEvidence.matchedPayloadSha256.trim().toLowerCase()
      : '';
    const source = typeof operatorEvidence.source === 'string' ? operatorEvidence.source.trim() : '';
    if (matchedSha !== existing.payload_sha256 || !source) {
      throw new OpenAiPolicyError(
        `First-time provider_response_id assignment ("${cleanRespId}") onto attempt "${existing.attempt_id}" failed payload digest or source verification.`,
        { code: 'UNVERIFIED_FIRST_PROVIDER_ID_ASSIGNMENT' },
      );
    }
  }

  recordProviderResponseId(attemptId, providerResponseId, {
    accountScope = null,
    operatorEvidence = null,
  } = {}) {
    this._assertWritable();
    if (typeof providerResponseId !== 'string' || !providerResponseId.trim()) {
      throw new OpenAiValidationError('providerResponseId must be a nonempty string.');
    }
    const cleanRespId = providerResponseId.trim();
    assertSafeStoredValue(cleanRespId, 'providerResponseId');
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttemptById(attemptId, { accountScope });
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI request attempt "${sanitizeDiagnosticText(attemptId)}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (existing.provider_response_id === null || existing.provider_response_id === undefined) {
        if (existing.status !== 'in_progress') {
          this._assertVerifiedFirstProviderIdEvidence(existing, cleanRespId, operatorEvidence);
        }
      }
      this._assertImmutableAndUniqueProviderId(existing, cleanRespId);
      this.db.prepare(`
        UPDATE openai_request_ledger
        SET provider_response_id = ?,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(cleanRespId, now, existing.attempt_id);
      return this.getAttemptById(existing.attempt_id);
    });
  }

  _requireActiveBackgroundResponse(attemptId, accountScope) {
    const existing = this.getAttemptById(attemptId, { accountScope });
    if (!existing) {
      throw new OpenAiBudgetError('OpenAI background response attempt was not found.', { code: 'ATTEMPT_NOT_FOUND' });
    }
    if (existing.endpoint !== '/v1/responses' || !existing.background_mode || existing.store_mode !== 1) {
      throw new OpenAiPolicyError('Operation requires a stored background Responses attempt.', {
        code: 'BACKGROUND_RESPONSE_ATTEMPT_REQUIRED',
      });
    }
    if ((existing.status !== 'in_progress' && existing.status !== 'pending_recovery') ||
      hasPersistedBackgroundTerminal(existing)) {
      throw new OpenAiBudgetError('Background response attempt is already settled.', {
        code: 'INVALID_STATE_TRANSITION',
      });
    }
    return existing;
  }

  /** Persist the known response ID before poll, cancel, or terminal parsing can fail. */
  recordBackgroundResponseId({
    attemptId, providerResponseId, accountScope = 'openai-default', usageFloorMicros = null,
    searchFloorMicros = 0, tokenFloorMicros = 0,
  } = {}) {
    this._assertNoOuterTransaction('recordBackgroundResponseId');
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const id = assertSafeProviderResourceId(providerResponseId);
    if (usageFloorMicros !== null) assertNonNegInt(usageFloorMicros, 'usageFloorMicros');
    return this._withImmediateTx(() => {
      const existing = this._requireActiveBackgroundResponse(attemptId, scope);
      this._assertImmutableAndUniqueProviderId(existing, id);
      if (existing.provider_response_id === null && existing.status !== 'in_progress') {
        this._assertVerifiedFirstProviderIdEvidence(existing, id, null);
      }
      if (existing.provider_response_id !== id) this.db.prepare(`
        UPDATE openai_request_ledger
        SET provider_response_id = ?, updated_at = ?
        WHERE attempt_id = ?
      `).run(id, this._nowIso(), existing.attempt_id);
      this._raiseBackgroundUsageFloor(existing.attempt_id, scope, id, usageFloorMicros, searchFloorMicros, tokenFloorMicros);
      return this.getAttemptById(existing.attempt_id);
    });
  }

  /** An active receipt can raise the unresolved hold without changing lifecycle or settling usage. */
  recordBackgroundUsageFloor({ attemptId, providerResponseId, accountScope, usageFloorMicros, searchFloorMicros = 0, tokenFloorMicros = 0 }) {
    this._assertWritable();
    this._assertNoOuterTransaction('recordBackgroundUsageFloor');
    const id = assertSafeProviderResourceId(providerResponseId);
    const scope = assertSafeOpenAiAccountScope(accountScope);
    this._raiseBackgroundUsageFloor(attemptId, scope, id, usageFloorMicros, searchFloorMicros, tokenFloorMicros);
  }

  _raiseBackgroundUsageFloor(attemptId, scope, id, usageFloorMicros, searchFloorMicros, tokenFloorMicros) {
    const floor = assertNonNegInt(usageFloorMicros ?? 0, 'usageFloorMicros');
    const search = assertNonNegInt(searchFloorMicros, 'searchFloorMicros');
    const tokens = assertNonNegInt(tokenFloorMicros, 'tokenFloorMicros');
    // A later poll may omit previously reported searches or usage. Keep each component
    // independently in SQLite so reconnects and concurrent readers see the combined hold.
    this.db.prepare(`
      UPDATE openai_request_ledger
      SET background_search_floor_micros = max(background_search_floor_micros, $search),
          background_token_floor_micros = max(background_token_floor_micros, $tokens),
          background_usage_floor_micros = max(coalesce(background_usage_floor_micros, 0), $floor,
            min($ceiling, max(background_search_floor_micros, $search) + max(background_token_floor_micros, $tokens))),
          updated_at = $now
      WHERE attempt_id = $attemptId AND account_scope = $scope AND provider_response_id = $id
        AND endpoint = '/v1/responses' AND background_mode = 1 AND store_mode = 1
        AND status IN ('in_progress', 'pending_recovery') AND terminal_outcome_status IS NULL
        AND (coalesce(background_usage_floor_micros, 0) < $floor OR
          background_search_floor_micros < $search OR background_token_floor_micros < $tokens)
    `).run({ search, tokens, floor, ceiling: Number.MAX_SAFE_INTEGER, now: this._nowIso(), attemptId, scope, id });
  }

  /** Claim one bound cancellation dispatch under the ledger lock. Recovery after the claim uses GET. */
  recordBackgroundCancellationDispatch({ attemptId, providerResponseId, accountScope = 'openai-default' } = {}) {
    this._assertNoOuterTransaction('recordBackgroundCancellationDispatch');
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const id = assertSafeProviderResourceId(providerResponseId);
    return this._withImmediateTx(() => {
      const existing = this._requireActiveBackgroundResponse(attemptId, scope);
      if (existing.provider_response_id !== id) {
        throw new OpenAiBudgetError('Cancellation must use the background response ID bound to this attempt.', {
          code: 'PROVIDER_RESPONSE_ID_IMMUTABLE',
        });
      }
      if (existing.background_cancel_dispatched_at !== null) {
        throw new OpenAiBudgetError('Background response cancellation has already been claimed. Recover its status with GET.', {
          code: 'BACKGROUND_CANCEL_ALREADY_DISPATCHED',
        });
      }
      const now = this._nowIso();
      this.db.prepare(`
        UPDATE openai_request_ledger
        SET background_cancel_dispatched_at = ?, updated_at = ?
        WHERE attempt_id = ?
      `).run(now, now, existing.attempt_id);
      return this.getAttemptById(existing.attempt_id);
    });
  }

  recordBatchUploadedFileId(attemptId, uploadedFileId) {
    this._assertWritable();
    const cleanFileId = assertSafeShortLabel(uploadedFileId, 'uploadedFileId', 128);
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttemptById(attemptId);
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI batch attempt "${attemptId}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (existing.endpoint !== '/v1/batches') {
        throw new OpenAiValidationError('recordBatchUploadedFileId is only valid on /v1/batches attempts.');
      }
      const prevManifest = existing.batch_manifest && typeof existing.batch_manifest === 'object'
        ? existing.batch_manifest
        : {};
      if (prevManifest.uploaded_file_id && prevManifest.uploaded_file_id !== cleanFileId) {
        throw new OpenAiBudgetError(
          `Batch attempt "${existing.attempt_id}" already recorded uploaded_file_id "${prevManifest.uploaded_file_id}".`,
          { code: 'BATCH_UPLOADED_FILE_ID_IMMUTABLE' },
        );
      }
      const nextManifest = {
        ...prevManifest,
        input_file_id: cleanFileId,
        uploaded_file_id: cleanFileId,
      };
      assertSafeStoredValue(nextManifest, 'batchManifest');
      this.db.prepare(`
        UPDATE openai_request_ledger
        SET batch_manifest_json = ?,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(canonicalJson(nextManifest), now, existing.attempt_id);
      return this.getAttemptById(existing.attempt_id);
    });
  }

  /**
   * Atomically claim the `POST /v1/batches` creation stage AFTER `/v1/files` upload (`P0-19`, `P1-02`).
   * Re-verifies inside `BEGIN IMMEDIATE`:
   *   - UTC month has not rolled over since reservation (`BATCH_MONTH_ROLLOVER_ABORTED`)
   *   - `enabled === 1`, `legacy_reconciled === 1`, billing controls, `allow_stage4_media`
   *   - no other fencing attempt appeared concurrently
   *   - current `effective_committed_cents <= monthly_limit_cents` (in case `monthly_limit_cents` was lowered during upload)
   */
  claimBatchCreationStage(attemptId, {
    accountScope = 'openai-default',
    uploadedFileId,
    batchPostSha256,
    requireStage4Media = false,
    monthUtc = undefined,
    allowTestClockOverride = false,
  }) {
    this._assertWritable();
    this._assertNoOuterTransaction('claimBatchCreationStage');
    const scope = assertSafeOpenAiAccountScope(accountScope);
    const cleanFileId = assertSafeShortLabel(uploadedFileId, 'uploadedFileId', 128);
    const postSha = assertSha256Hex(batchPostSha256, 'batchPostSha256');
    if (typeof requireStage4Media !== 'boolean') {
      throw new OpenAiValidationError('requireStage4Media must be a boolean.');
    }
    if (typeof allowTestClockOverride !== 'boolean') {
      throw new OpenAiValidationError('allowTestClockOverride must be a boolean.');
    }

    let postCommitError = null;
    const updatedRow = this._withImmediateTx(() => {
      const nowDate = this.testMode ? this._nowFn() : new Date();
      const now = nowDate.toISOString();
      const clockMonth = currentMonthUtc(nowDate);
      let effectiveMonth = clockMonth;
      if (monthUtc !== undefined && monthUtc !== null) {
        const reqMonth = assertValidMonthUtc(monthUtc, 'monthUtc');
        if (reqMonth !== clockMonth) {
          if (this.testMode && allowTestClockOverride) {
            effectiveMonth = reqMonth;
          } else {
            throw new OpenAiPolicyError(
              `monthUtc ("${reqMonth}") cannot override the ledger UTC clock ("${clockMonth}") during claimBatchCreationStage.`,
              { code: 'MONTH_CLOCK_OVERRIDE_FORBIDDEN', notDispatched: false },
            );
          }
        }
      }

      const existing = this.getAttemptById(attemptId, { accountScope: scope });
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI batch attempt "${attemptId}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (existing.endpoint !== '/v1/batches') {
        throw new OpenAiValidationError('claimBatchCreationStage is only valid on /v1/batches attempts.');
      }
      if (existing.status !== 'in_progress') {
        throw new OpenAiBudgetError(
          `Batch attempt "${existing.attempt_id}" is no longer in_progress (status="${existing.status}"); aborting POST /v1/batches.`,
          {
            code: 'BATCH_ATTEMPT_NO_LONGER_ACTIVE',
            notDispatched: false,
            details: { attempt_id: existing.attempt_id, status: existing.status },
          },
        );
      }

      const abortAndRejectAttempt = (reason, errInstance) => {
        this.db.prepare(`
          UPDATE openai_request_ledger
          SET status = 'rejected',
              confirmed_zero_charge = 1,
              usage_cost_micros = 0,
              diagnostic_reason = ?,
              updated_at = ?,
              finished_at = COALESCE(finished_at, ?)
          WHERE attempt_id = ?
        `).run(reason, now, now, existing.attempt_id);
        postCommitError = errInstance;
        return null;
      };

      if (effectiveMonth !== existing.month_utc) {
        const reason = `UTC month rolled over during /v1/files upload (reserved in ${existing.month_utc}, now ${effectiveMonth}); aborting POST /v1/batches before batch creation.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiBudgetError(reason, {
            code: 'BATCH_MONTH_ROLLOVER_ABORTED',
            notDispatched: false,
            details: {
              attempt_id: existing.attempt_id,
              reserved_month_utc: existing.month_utc,
              current_month_utc: effectiveMonth,
              uploaded_file_id: cleanFileId,
            },
          }),
        );
      }

      const policyRow = this.db.prepare('SELECT * FROM openai_budget_policy WHERE account_scope = ?').get(scope);
      if (!policyRow || policyRow.enabled !== 1) {
        const reason = `OpenAI budget policy for "${scope}" was disabled before POST /v1/batches; aborting batch creation with 0 batch spend.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiBudgetError(reason, {
            code: 'BUDGET_DISABLED',
            notDispatched: false,
            details: { attempt_id: existing.attempt_id, uploaded_file_id: cleanFileId },
          }),
        );
      }
      if (!this.testMode && policyRow.baseline_mode !== 'verified_production') {
        const reason = `OpenAI budget baseline_mode for "${scope}" is not verified_production before POST /v1/batches; aborting batch creation.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiPolicyError(reason, {
            code: 'UNVERIFIED_SYNTHETIC_BASELINE',
            notDispatched: false,
            details: { attempt_id: existing.attempt_id, uploaded_file_id: cleanFileId },
          }),
        );
      }
      if (policyRow.legacy_reconciled !== 1) {
        const reason = `OpenAI legacy reconciliation for "${scope}" was revoked before POST /v1/batches; aborting batch creation.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiBudgetError(reason, {
            code: 'LEGACY_NOT_RECONCILED',
            notDispatched: false,
            details: { attempt_id: existing.attempt_id, uploaded_file_id: cleanFileId },
          }),
        );
      }
      if (policyRow.auto_recharge_off_confirmed !== 1 || policyRow.hard_monthly_limit_confirmed !== 1) {
        const reason = `OpenAI platform billing controls for "${scope}" were unconfirmed before POST /v1/batches; aborting batch creation.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiPolicyError(reason, {
            code: 'PLATFORM_BILLING_CONTROLS_UNVERIFIED',
            notDispatched: false,
            details: { attempt_id: existing.attempt_id, uploaded_file_id: cleanFileId },
          }),
        );
      }
      if (requireStage4Media && policyRow.allow_stage4_media !== 1) {
        const reason = `Stage-4 media policy for "${scope}" was revoked before POST /v1/batches; aborting image batch creation with 0 batch spend.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiPolicyError(reason, {
            code: 'STAGE4_MEDIA_DISABLED',
            notDispatched: false,
            details: { attempt_id: existing.attempt_id, uploaded_file_id: cleanFileId },
          }),
        );
      }

      const summary = this.getMonthlySummary({ accountScope: scope, monthUtc: existing.month_utc });
      const effectiveLimitCents = Math.min(MAX_MONTHLY_LIMIT_CENTS, policyRow.monthly_limit_cents);
      if (effectiveLimitCents <= 0 || summary.effective_committed_cents >= effectiveLimitCents) {
        const reason = `OpenAI monthly_limit_cents (${effectiveLimitCents}c) was lowered to or below committed spend (${summary.effective_committed_cents}c) before POST /v1/batches; aborting batch creation.`;
        return abortAndRejectAttempt(
          reason,
          new OpenAiBudgetError(reason, {
            code: 'MONTHLY_BUDGET_EXCEEDED',
            notDispatched: false,
            details: {
              attempt_id: existing.attempt_id,
              committed_cents: summary.effective_committed_cents,
              monthly_limit_cents: effectiveLimitCents,
              uploaded_file_id: cleanFileId,
            },
          }),
        );
      }

      const prevManifest = existing.batch_manifest && typeof existing.batch_manifest === 'object'
        ? existing.batch_manifest
        : {};
      if (prevManifest.uploaded_file_id && prevManifest.uploaded_file_id !== cleanFileId) {
        throw new OpenAiBudgetError(
          `Batch attempt "${existing.attempt_id}" uploaded_file_id mismatch ("${prevManifest.uploaded_file_id}" vs "${cleanFileId}").`,
          { code: 'BATCH_UPLOADED_FILE_ID_IMMUTABLE', notDispatched: false },
        );
      }

      const nextManifest = {
        ...prevManifest,
        input_file_id: cleanFileId,
        uploaded_file_id: cleanFileId,
        batch_post_sha256: postSha,
        dispatch_stage: 'batch_post_claimed',
      };
      assertSafeStoredValue(nextManifest, 'batchManifest');

      this.db.prepare(`
        UPDATE openai_request_ledger
        SET batch_manifest_json = ?,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(canonicalJson(nextManifest), now, existing.attempt_id);

      return this.getAttemptById(existing.attempt_id);
    });
    if (postCommitError) throw postCommitError;
    return updatedRow;
  }

  /**
   * Atomically establish a durable cleanup obligation & fence BEFORE issuing a public
   * `DELETE /v1/responses/{id}` (`P0-05`, `P0-03`, `P0-18`, `P0-24`).
   */
  beginBoundResponseCleanup(attemptId, {
    accountScope = 'openai-default',
    providerResponseId,
    apiBaseUrl = null,
    origin = null,
    credentialFingerprintSha256 = null,
  }) {
    this._assertWritable();
    this._assertNoOuterTransaction('beginBoundResponseCleanup');
    const scope = assertSafeOpenAiAccountScope(accountScope);
    if (typeof providerResponseId !== 'string' || !providerResponseId.trim()) {
      throw new OpenAiValidationError('providerResponseId must be a nonempty string.');
    }
    const cleanRespId = providerResponseId.trim();
    assertSafeStoredValue(cleanRespId, 'providerResponseId');
    const cleanApiBaseUrl = assertSafeApiBaseUrl(apiBaseUrl);
    const cleanOrigin = assertSafeOrigin(origin ?? (cleanApiBaseUrl ? new URL(cleanApiBaseUrl).origin : null));
    const cleanFp = credentialFingerprintSha256
      ? assertSha256Hex(credentialFingerprintSha256, 'credentialFingerprintSha256')
      : null;
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttemptById(attemptId, { accountScope: scope });
      if (!existing) {
        throw new OpenAiBudgetError(`Bound attempt "${attemptId}" not found for deleteResponse.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (existing.endpoint !== '/v1/responses') {
        throw new OpenAiValidationError('deleteResponse is only valid for /v1/responses attempts.');
      }
      if (existing.store_mode === 0) {
        throw new OpenAiPolicyError(
          `Attempt "${existing.attempt_id}" was created with store: false and cannot undergo remote deletion.`,
          { code: 'DELETE_UNSTORED_RESPONSE_FORBIDDEN' },
        );
      }
      if (existing.provider_response_id !== cleanRespId) {
        throw new OpenAiBudgetError(
          `deleteResponse responseId "${cleanRespId}" does not match bound attempt provider_response_id "${String(existing.provider_response_id)}".`,
          { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' },
        );
      }
      // P0-03 & P0-18: Quarantine legacy/migrated attempts missing connection bindings until verified!
      if (!existing.origin || !existing.api_base_url || !existing.credential_fingerprint_sha256) {
        throw new OpenAiPolicyError(
          `Attempt "${existing.attempt_id}" lacks bound origin, api_base_url, or credential_fingerprint_sha256; run verifyLegacyAttemptConnectionBinding before remote DELETE.`,
          { code: 'LEGACY_UNBOUND_CONNECTION_QUARANTINED' },
        );
      }
      if (!cleanOrigin || existing.origin !== cleanOrigin) {
        throw new OpenAiPolicyError(
          `Bound attempt "${existing.attempt_id}" was admitted for origin "${existing.origin}", not "${String(cleanOrigin)}".`,
          { code: 'ORIGIN_MISMATCH_ON_RECOVERY' },
        );
      }
      if (!cleanApiBaseUrl || existing.api_base_url !== cleanApiBaseUrl) {
        throw new OpenAiPolicyError(
          `Bound attempt "${existing.attempt_id}" was admitted for api_base_url "${existing.api_base_url}", not "${String(cleanApiBaseUrl)}".`,
          { code: 'API_BASE_URL_MISMATCH_ON_RECOVERY' },
        );
      }
      if (!cleanFp || existing.credential_fingerprint_sha256 !== cleanFp) {
        throw new OpenAiPolicyError(
          `Bound attempt "${existing.attempt_id}" is bound to a different API credential fingerprint; cross-credential cleanup is forbidden.`,
          { code: 'CREDENTIAL_MISMATCH_ON_RECOVERY' },
        );
      }
      if (
        existing.raw_receipt_json === null ||
        existing.raw_receipt_sha256 === null ||
        (existing.usage_cost_micros === null && existing.posted_billed_cents === null && !existing.confirmed_zero_charge) ||
        (!existing.terminal_outcome_status &&
          existing.status !== 'completed' &&
          existing.status !== 'failed_known' &&
          existing.posted_billed_cents === null &&
          !existing.confirmed_zero_charge)
      ) {
        throw new OpenAiPolicyError(
          `Refusing DELETE /v1/responses/${cleanRespId} before receipt and usage are persisted on attempt "${existing.attempt_id}".`,
          { code: 'DELETE_BEFORE_PERSIST_FORBIDDEN' },
        );
      }
      // P0-24: Require verified original raw payload bytes matching original_body_sha256 before remote DELETE!
      if (!this._hasVerifiedOriginalBytesForAttempt(existing)) {
        throw new OpenAiPolicyError(
          `Refusing DELETE /v1/responses/${cleanRespId} on attempt "${existing.attempt_id}": verified original raw payload bytes matching original_body_sha256 are not persisted locally.`,
          { code: 'DELETE_WITHOUT_VERIFIED_ORIGINAL_BYTES_FORBIDDEN' },
        );
      }

      if (
        existing.cleanup_status === 'deleted_verified_404' &&
        (existing.status === 'completed' || existing.status === 'failed_known')
      ) {
        return {
          alreadyCleanedUp: true,
          attempt: existing,
        };
      }

      if (existing.background_mode && existing.delete_ack_at && existing.delete_ack_receipt_json) {
        return { alreadyCleanedUp: false, readbackOnly: true, attempt: existing };
      }
      if (existing.background_mode && existing.background_delete_dispatched_at) {
        throw new OpenAiBudgetError(
          'A background DELETE was already claimed without a verified acknowledgment. Preserve the receipt and reconcile the existing cleanup.',
          { code: 'BACKGROUND_DELETE_OUTCOME_UNKNOWN' },
        );
      }

      const preservedTerminal = existing.terminal_outcome_status ?? (
        ['completed', 'failed_known'].includes(existing.status) ? existing.status : null
      );

      this.db.prepare(`
        UPDATE openai_request_ledger
        SET cleanup_required = 1,
            cleanup_status = CASE WHEN cleanup_status = 'deleted_verified_404' THEN cleanup_status ELSE 'pending_cleanup' END,
            terminal_outcome_status = ?,
            background_delete_dispatched_at = CASE WHEN background_mode = 1 THEN ? ELSE NULL END,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(preservedTerminal, now, now, existing.attempt_id);

      return {
        alreadyCleanedUp: false,
        attempt: this.getAttemptById(existing.attempt_id),
      };
    });
  }

  /**
   * Persist terminal receipt and transition an `in_progress` or `pending_recovery`
   * attempt to `completed`, `rejected`, `failed_known`, or `pending_recovery`.
   */
  recordTerminalOutcome(attemptIdOrLogicalId, {
    status,
    contentStatus = null,
    usageCostMicros = null,
    usage = null,
    provisionalUsageCostMicros = null,
    provisionalUsage = null,
    confirmedZeroCharge = false,
    providerResponseId = null,
    providerModel = null,
    httpStatus = null,
    cleanupStatus = undefined,
    rawReceipt = null,
    rawReceiptSha256 = null,
    originalBodySha256 = null,
    rawBodyText = null,
    rawBodySha256 = null,
    acceptedOutputSha256 = null,
    acceptedOutputFileId = null,
    diagnosticReason = null,
  } = {}) {
    this._assertWritable();
    if (!['completed', 'rejected', 'failed_known', 'pending_recovery'].includes(status)) {
      throw new OpenAiValidationError(`Invalid terminal status "${status}".`);
    }
    if (typeof confirmedZeroCharge !== 'boolean') {
      throw new OpenAiValidationError('confirmedZeroCharge must be a boolean.');
    }
    if (contentStatus !== null && !OPENAI_CONTENT_STATUSES.includes(contentStatus)) {
      throw new OpenAiValidationError(`Invalid contentStatus "${contentStatus}".`);
    }
    if (cleanupStatus !== undefined && cleanupStatus !== null && !CLEANUP_STATUSES.includes(cleanupStatus)) {
      throw new OpenAiValidationError(`Invalid cleanupStatus "${cleanupStatus}".`);
    }
    if (usageCostMicros !== null && usageCostMicros !== undefined) {
      assertNonNegInt(usageCostMicros, 'usageCostMicros');
    }
    if (provisionalUsageCostMicros !== null && provisionalUsageCostMicros !== undefined) {
      assertNonNegInt(provisionalUsageCostMicros, 'provisionalUsageCostMicros');
    }
    if (status === 'pending_recovery' && usageCostMicros === 0 && !confirmedZeroCharge && usage === null) {
      throw new OpenAiValidationError('Never record usageCostMicros=0 for an unknown pending_recovery outcome.');
    }
    if (status === 'completed' && confirmedZeroCharge === true) {
      throw new OpenAiValidationError('confirmedZeroCharge cannot be true when status is "completed".');
    }

    const cleanRespId = providerResponseId !== null && providerResponseId !== undefined
      ? String(providerResponseId).trim()
      : null;
    if (providerResponseId !== null && providerResponseId !== undefined && !cleanRespId) {
      throw new OpenAiValidationError('providerResponseId cannot be empty when provided.');
    }
    const cleanProvModel = providerModel ? String(providerModel).trim() : null;
    assertSafeStoredValue(cleanRespId, 'providerResponseId');
    assertSafeStoredValue(cleanProvModel, 'providerModel');

    const cleanAcceptedOutputSha = acceptedOutputSha256 !== null && acceptedOutputSha256 !== undefined
      ? assertSha256Hex(acceptedOutputSha256, 'acceptedOutputSha256')
      : null;
    const cleanAcceptedOutputFileId = acceptedOutputFileId !== null && acceptedOutputFileId !== undefined
      ? assertSafeShortLabel(acceptedOutputFileId, 'acceptedOutputFileId', 128)
      : null;

    let usageJson = null;
    if (usage !== null && usage !== undefined) {
      assertSafeStoredValue(usage, 'usage');
      usageJson = canonicalJson(usage);
    }

    let provUsageJson = null;
    if (provisionalUsage !== null && provisionalUsage !== undefined) {
      assertSafeStoredValue(provisionalUsage, 'provisionalUsage');
      provUsageJson = canonicalJson(provisionalUsage);
    }

    let receiptJson = null;
    let effectiveReceiptSha = rawReceiptSha256 ? assertSha256Hex(rawReceiptSha256, 'rawReceiptSha256') : null;
    if (rawReceipt !== null && rawReceipt !== undefined) {
      assertSafeStoredValue(rawReceipt, 'rawReceipt');
      receiptJson = canonicalJson(rawReceipt);
      if (!effectiveReceiptSha) {
        effectiveReceiptSha = sha256Hex(receiptJson);
      }
    }

    const effectiveOrigBodySha = originalBodySha256
      ? assertSha256Hex(originalBodySha256, 'originalBodySha256')
      : null;
    const cleanedRawBodyText = sanitizeBoundedRawBody(rawBodyText);
    if (rawBodySha256 !== null && rawBodySha256 !== undefined) {
      assertSha256Hex(rawBodySha256, 'rawBodySha256');
    }
    // P0-24: Always hash AFTER truncation so raw_body_sha256 matches stored raw_body_text!
    const effectiveRawBodySha = cleanedRawBodyText !== null
      ? sha256Hex(cleanedRawBodyText)
      : (rawBodySha256 ? assertSha256Hex(rawBodySha256, 'rawBodySha256') : null);

    const cleanReason = sanitizeSafeNote(diagnosticReason, 'diagnosticReason');
    const safeHttpStatus = httpStatus !== null && httpStatus !== undefined
      ? assertNonNegInt(httpStatus, 'httpStatus')
      : null;
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttempt(attemptIdOrLogicalId);
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI request attempt "${attemptIdOrLogicalId}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }

      if (hasPersistedBackgroundTerminal(existing)) {
        throw new OpenAiBudgetError('The background response has a persisted terminal receipt.', {
          code: 'INVALID_STATE_TRANSITION',
        });
      }

      // Idempotent concurrent settlement when attempt is ALREADY completed with identical ID, usage & output digest!
      if (
        existing.status === 'completed' &&
        status === 'completed' &&
        !existing.cleanup_required &&
        (cleanRespId === null || existing.provider_response_id === cleanRespId) &&
        existing.usage_cost_micros === usageCostMicros
      ) {
        const prevAcceptedSha = existing.batch_manifest?.accepted_output_sha256 ?? null;
        if (cleanAcceptedOutputSha && prevAcceptedSha && cleanAcceptedOutputSha !== prevAcceptedSha) {
          throw new OpenAiBudgetError(
            `Batch attempt "${existing.attempt_id}" accepted_output_sha256 mismatch on concurrent settlement (${prevAcceptedSha} vs ${cleanAcceptedOutputSha}).`,
            { code: 'BATCH_OUTPUT_DIGEST_MISMATCH' },
          );
        }
        return existing;
      }

      if (!['in_progress', 'pending_recovery'].includes(existing.status)) {
        throw new OpenAiBudgetError(
          `Cannot transition attempt "${existing.attempt_id}" from terminal state "${existing.status}" to "${status}".`,
          { code: 'INVALID_STATE_TRANSITION' },
        );
      }

      if (status === 'rejected' && (existing.terminal_outcome_status !== null || existing.delete_ack_at !== null)) {
        throw new OpenAiBudgetError(
          `Cannot transition evidenced attempt "${existing.attempt_id}" to "rejected".`,
          { code: 'INVALID_STATE_TRANSITION' },
        );
      }

      this._assertImmutableAndUniqueProviderId(existing, cleanRespId);

      const minPriorUsageMicros = Math.max(
        existing.usage_cost_micros ?? 0,
        existing.provisional_usage_cost_micros ?? 0,
      );

      if (
        usageCostMicros !== null &&
        usageCostMicros !== undefined &&
        ((existing.usage_cost_micros !== null && usageCostMicros < existing.usage_cost_micros) ||
          (minPriorUsageMicros > 0 && usageCostMicros < minPriorUsageMicros))
      ) {
        throw new OpenAiBudgetError(
          `Cannot reduce usage_cost_micros on attempt "${existing.attempt_id}" from ${minPriorUsageMicros} to ${usageCostMicros}.`,
          { code: 'USAGE_REDUCTION_FORBIDDEN' },
        );
      }

      const candidateUsageMicros = usageCostMicros !== null && usageCostMicros !== undefined
        ? usageCostMicros
        : (confirmedZeroCharge === true && status !== 'pending_recovery' && existing.usage_cost_micros === null && minPriorUsageMicros === 0
          ? 0
          : null);

      const mergedUsageCost = candidateUsageMicros !== null ? candidateUsageMicros : existing.usage_cost_micros;
      const mergedProvMicros = provisionalUsageCostMicros !== null && provisionalUsageCostMicros !== undefined
        ? Math.max(existing.provisional_usage_cost_micros ?? 0, provisionalUsageCostMicros)
        : existing.provisional_usage_cost_micros;
      const mergedReceiptJson = receiptJson !== null ? receiptJson : existing.raw_receipt_json;
      const mergedReceiptObj = rawReceipt !== null && rawReceipt !== undefined ? rawReceipt : existing.raw_receipt;
      const mergedHttpStatus = safeHttpStatus !== null ? safeHttpStatus : existing.http_status;
      const mergedRespId = cleanRespId ?? existing.provider_response_id;

      if (
        confirmedZeroCharge === true &&
        ((mergedUsageCost !== null && mergedUsageCost > 0) ||
          (mergedProvMicros !== null && mergedProvMicros > 0) ||
          (existing.posted_billed_cents !== null && existing.posted_billed_cents > 0))
      ) {
        throw new OpenAiValidationError('confirmedZeroCharge cannot be true when positive usage or billed cost exists.');
      }

      if (status === 'completed') {
        if (mergedUsageCost === null || mergedUsageCost === undefined) {
          throw new OpenAiBudgetError(
            `Cannot mark attempt "${existing.attempt_id}" completed without non-null usageCostMicros.`,
            { code: 'MISSING_COMPLETED_USAGE_COST' },
          );
        }
        if (mergedReceiptJson === null || mergedReceiptJson === undefined) {
          throw new OpenAiBudgetError(
            `Cannot mark attempt "${existing.attempt_id}" completed without a persisted sanitized receipt.`,
            { code: 'MISSING_COMPLETED_RECEIPT' },
          );
        }
        // P0-13: Block completed with usageCostMicros === 0 on non-/v1/files attempts unless receipt is a clean 200 zero-token completion!
        if (mergedUsageCost === 0 && existing.endpoint !== '/v1/files') {
          const receiptHasError =
            (mergedHttpStatus !== null && mergedHttpStatus !== undefined && mergedHttpStatus >= 400) ||
            (mergedReceiptObj && typeof mergedReceiptObj === 'object' && (
              mergedReceiptObj.error != null ||
              (typeof mergedReceiptObj.http_status === 'number' && mergedReceiptObj.http_status >= 400) ||
              (typeof mergedReceiptObj.status === 'string' && mergedReceiptObj.status !== 'completed')
            ));
          const mergedUsageObj = usage ?? existing.usage ?? mergedReceiptObj?.usage ?? null;
          const hasExplicitZeroUsage =
            mergedUsageObj !== null &&
            typeof mergedUsageObj === 'object' &&
            (mergedUsageObj.input_tokens ?? 0) === 0 &&
            (mergedUsageObj.output_tokens ?? 0) === 0 &&
            (mergedUsageObj.total_tokens ?? 0) === 0 &&
            (mergedUsageObj.characters ?? 0) === 0 &&
            (mergedUsageObj.images ?? 0) === 0 &&
            ('input_tokens' in mergedUsageObj || 'total_tokens' in mergedUsageObj || 'characters' in mergedUsageObj || 'images' in mergedUsageObj);
          if (receiptHasError || !hasExplicitZeroUsage) {
            throw new OpenAiBudgetError(
              `Cannot mark attempt "${existing.attempt_id}" completed with usageCostMicros=0 without an error-free explicit zero-usage completion receipt.`,
              { code: 'MISSING_RECONCILIATION_CHARGE_EVIDENCE' },
            );
          }
        }
      }

      if (status === 'failed_known') {
        const hasVerifiedPositiveCharge =
          (mergedUsageCost !== null && mergedUsageCost > 0) ||
          (existing.posted_billed_cents !== null && existing.posted_billed_cents > 0);
        if (!confirmedZeroCharge && !hasVerifiedPositiveCharge) {
          throw new OpenAiBudgetError(
            `Cannot mark attempt "${existing.attempt_id}" failed_known without confirmedZeroCharge: true or positive verified charge evidence.`,
            { code: 'MISSING_RECONCILIATION_CHARGE_EVIDENCE' },
          );
        }
      }

      const alreadyVerified404 = existing.cleanup_status === 'deleted_verified_404';
      const effectiveCleanupReq = existing.cleanup_required === true ||
        cleanupStatus === 'pending_cleanup' ||
        cleanupStatus === 'delete_failed';

      if (cleanupStatus === 'deleted_verified_404' && !alreadyVerified404) {
        throw new OpenAiBudgetError(
          `Cannot set cleanup_status="deleted_verified_404" via recordTerminalOutcome on "${existing.attempt_id}"; use recordCleanupVerified404 with a verified GET 404 transportReceipt.`,
          { code: 'CLEANUP_DELETE_ACK_REQUIRED' },
        );
      }

      let persistedStatus = status;
      // Monotonic deleted_verified_404 — never regress cleanup_status away from deleted_verified_404;
      // remote DELETE cleanup status is tracked advisory-only without demoting terminal status or locking the account.
      let persistedCleanupStatus = alreadyVerified404
        ? 'deleted_verified_404'
        : (cleanupStatus !== undefined
          ? cleanupStatus
          : (existing.cleanup_status ?? (effectiveCleanupReq ? 'pending_cleanup' : 'not_requested')));
      let nextTerminalOutcomeStatus = existing.terminal_outcome_status ?? (
        (status === 'completed' || status === 'failed_known') ? status : null
      );
      if (effectiveCleanupReq && !alreadyVerified404 && (!persistedCleanupStatus || persistedCleanupStatus === 'not_requested')) {
        persistedCleanupStatus = 'pending_cleanup';
      }

      let nextManifestJson = existing.batch_manifest_json ?? null;
      if (cleanAcceptedOutputSha || cleanAcceptedOutputFileId) {
        const prevManifest = existing.batch_manifest && typeof existing.batch_manifest === 'object'
          ? existing.batch_manifest
          : {};
        if (
          prevManifest.accepted_output_sha256 &&
          cleanAcceptedOutputSha &&
          prevManifest.accepted_output_sha256 !== cleanAcceptedOutputSha
        ) {
          throw new OpenAiBudgetError(
            `Batch attempt "${existing.attempt_id}" accepted_output_sha256 is immutable once recorded.`,
            { code: 'BATCH_OUTPUT_DIGEST_MISMATCH' },
          );
        }
        const nextManifest = {
          ...prevManifest,
          ...(cleanAcceptedOutputSha ? { accepted_output_sha256: cleanAcceptedOutputSha } : {}),
          ...(cleanAcceptedOutputFileId ? { accepted_output_file_id: cleanAcceptedOutputFileId } : {}),
        };
        assertSafeStoredValue(nextManifest, 'batchManifest');
        nextManifestJson = canonicalJson(nextManifest);
      }

      // P0-24: Preserve prior body/receipt audit trail in recovery_history_json before overwriting!
      let nextHistoryJson = existing.recovery_history_json ?? null;
      const incomingHasNewBodyOrReceipt =
        (effectiveOrigBodySha !== null && existing.original_body_sha256 && effectiveOrigBodySha !== existing.original_body_sha256) ||
        (effectiveRawBodySha !== null && existing.raw_body_sha256 && effectiveRawBodySha !== existing.raw_body_sha256) ||
        (effectiveReceiptSha !== null && existing.raw_receipt_sha256 && effectiveReceiptSha !== existing.raw_receipt_sha256);

      if (incomingHasNewBodyOrReceipt) {
        const priorHistory = Array.isArray(existing.recovery_history) ? [...existing.recovery_history] : [];
        priorHistory.push({
          recorded_at: existing.updated_at,
          status: existing.status,
          http_status: existing.http_status ?? null,
          original_body_sha256: existing.original_body_sha256 ?? null,
          raw_body_sha256: existing.raw_body_sha256 ?? null,
          raw_receipt_sha256: existing.raw_receipt_sha256 ?? null,
          diagnostic_reason: existing.diagnostic_reason ?? null,
        });
        while (priorHistory.length > 32) priorHistory.shift();
        assertSafeStoredValue(priorHistory, 'recovery_history');
        nextHistoryJson = canonicalJson(priorHistory);
      }

      const isTerminal = persistedStatus !== 'pending_recovery' && persistedStatus !== 'in_progress';
      const nextConfirmedZero = (confirmedZeroCharge === true && isTerminal)
        ? 1
        : (existing.confirmed_zero_charge ? 1 : 0);

      this.db.prepare(`
        UPDATE openai_request_ledger
        SET status = ?,
            content_status = COALESCE(?, content_status),
            usage_cost_micros = COALESCE(?, usage_cost_micros),
            provisional_usage_cost_micros = COALESCE(?, provisional_usage_cost_micros),
            confirmed_zero_charge = ?,
            usage_json = COALESCE(?, usage_json),
            provisional_usage_json = COALESCE(?, provisional_usage_json),
            provider_response_id = COALESCE(?, provider_response_id),
            provider_model = COALESCE(?, provider_model),
            http_status = COALESCE(?, http_status),
            cleanup_required = ?,
            cleanup_status = COALESCE(?, cleanup_status),
            terminal_outcome_status = ?,
            batch_manifest_json = COALESCE(?, batch_manifest_json),
            raw_receipt_json = COALESCE(?, raw_receipt_json),
            raw_receipt_sha256 = COALESCE(?, raw_receipt_sha256),
            original_body_sha256 = COALESCE(?, original_body_sha256),
            raw_body_text = COALESCE(?, raw_body_text),
            raw_body_sha256 = COALESCE(?, raw_body_sha256),
            recovery_history_json = COALESCE(?, recovery_history_json),
            diagnostic_reason = COALESCE(?, diagnostic_reason),
            updated_at = ?,
            finished_at = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END
        WHERE attempt_id = ?
      `).run(
        persistedStatus,
        contentStatus,
        candidateUsageMicros,
        mergedProvMicros,
        nextConfirmedZero,
        usageJson,
        provUsageJson,
        cleanRespId,
        cleanProvModel,
        safeHttpStatus,
        effectiveCleanupReq ? 1 : 0,
        persistedCleanupStatus,
        nextTerminalOutcomeStatus,
        nextManifestJson,
        receiptJson,
        effectiveReceiptSha,
        effectiveOrigBodySha,
        cleanedRawBodyText,
        effectiveRawBodySha,
        nextHistoryJson,
        cleanReason,
        now,
        isTerminal ? 1 : 0,
        now,
        existing.attempt_id,
      );

      return this.getAttemptById(existing.attempt_id);
    });
  }

  markPendingRecovery(attemptIdOrLogicalId, {
    reason = 'Ambiguous transport outcome after dispatch; retain reservation and fence until recovered.',
    contentStatus = null,
    providerResponseId = null,
    httpStatus = null,
    cleanupStatus = undefined,
    provisionalUsageCostMicros = null,
    provisionalUsage = null,
    usageCostMicros = null,
    usage = null,
    rawReceipt = null,
    rawReceiptSha256 = null,
    originalBodySha256 = null,
    rawBodyText = null,
    rawBodySha256 = null,
  } = {}) {
    const effProvMicros = provisionalUsageCostMicros ?? usageCostMicros ?? null;
    const effProvUsage = provisionalUsage ?? usage ?? null;
    return this.recordTerminalOutcome(attemptIdOrLogicalId, {
      status: 'pending_recovery',
      contentStatus,
      usageCostMicros: null,
      provisionalUsageCostMicros: effProvMicros,
      provisionalUsage: effProvUsage,
      confirmedZeroCharge: false,
      providerResponseId,
      httpStatus,
      cleanupStatus,
      rawReceipt,
      rawReceiptSha256,
      originalBodySha256,
      rawBodyText,
      rawBodySha256,
      diagnosticReason: reason,
    });
  }

  _validateCleanupTransportReceipt(existing, transportReceipt, expectedMethod, allowedStatuses) {
    if (!transportReceipt || typeof transportReceipt !== 'object' || Array.isArray(transportReceipt)) {
      throw new OpenAiPolicyError(
        `Cleanup verification on attempt "${existing.attempt_id}" requires an observed HTTP ${expectedMethod} transportReceipt.`,
        { code: 'CLEANUP_TRANSPORT_RECEIPT_REQUIRED' },
      );
    }
    const method = typeof transportReceipt.method === 'string' ? transportReceipt.method.toUpperCase() : '';
    const status = transportReceipt.httpStatus;
    if (method !== expectedMethod || !allowedStatuses.includes(status)) {
      throw new OpenAiPolicyError(
        `Cleanup transportReceipt for "${existing.attempt_id}" must carry method="${expectedMethod}" and status in [${allowedStatuses.join(', ')}].`,
        { code: 'CLEANUP_TRANSPORT_RECEIPT_INVALID' },
      );
    }
    const receiptBaseUrl = assertSafeApiBaseUrl(transportReceipt.apiBaseUrl);
    if (!receiptBaseUrl || (existing.api_base_url && receiptBaseUrl !== existing.api_base_url)) {
      throw new OpenAiPolicyError(
        `Cleanup transportReceipt apiBaseUrl mismatch on attempt "${existing.attempt_id}".`,
        { code: 'API_BASE_URL_MISMATCH_ON_RECOVERY' },
      );
    }
    const receiptFp = transportReceipt.credentialFingerprintSha256
      ? assertSha256Hex(transportReceipt.credentialFingerprintSha256, 'transportReceipt.credentialFingerprintSha256')
      : null;
    if (existing.credential_fingerprint_sha256 && receiptFp !== existing.credential_fingerprint_sha256) {
      throw new OpenAiPolicyError(
        `Cleanup transportReceipt credentialFingerprintSha256 mismatch on attempt "${existing.attempt_id}".`,
        { code: 'CREDENTIAL_MISMATCH_ON_RECOVERY' },
      );
    }
    const bodySha = assertSha256Hex(transportReceipt.bodySha256, 'transportReceipt.bodySha256');
    const observedAt = typeof transportReceipt.observedAt === 'string' && transportReceipt.observedAt.trim()
      ? transportReceipt.observedAt.trim()
      : null;
    if (!observedAt || !Number.isFinite(Date.parse(observedAt))) {
      throw new OpenAiPolicyError(
        `Cleanup transportReceipt observedAt must be a valid ISO timestamp.`,
        { code: 'CLEANUP_TRANSPORT_RECEIPT_INVALID' },
      );
    }
    if (expectedMethod === 'DELETE' && transportReceipt.deletedConfirmed !== true) {
      throw new OpenAiPolicyError(
        `DELETE transportReceipt on "${existing.attempt_id}" must confirm deletedConfirmed: true.`,
        { code: 'CLEANUP_TRANSPORT_RECEIPT_INVALID' },
      );
    }
    const normalized = {
      method,
      http_status: status,
      api_base_url: receiptBaseUrl,
      credential_fingerprint_sha256: receiptFp,
      body_sha256: bodySha,
      observed_at: observedAt,
      ...(expectedMethod === 'DELETE' ? { deleted_confirmed: true } : {}),
    };
    assertSafeStoredValue(normalized, 'cleanupTransportReceipt');
    return normalized;
  }

  recordDeleteAcknowledged(attemptId, {
    providerResponseId = null,
    transportReceipt = null,
  } = {}) {
    this._assertWritable();
    if (typeof providerResponseId !== 'string' || !providerResponseId.trim()) {
      throw new OpenAiValidationError('recordDeleteAcknowledged requires a nonempty providerResponseId.');
    }
    const cleanRespId = providerResponseId.trim();
    assertSafeStoredValue(cleanRespId, 'providerResponseId');
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttemptById(attemptId);
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI request attempt "${attemptId}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (!existing.provider_response_id || existing.provider_response_id !== cleanRespId) {
        throw new OpenAiBudgetError(
          `recordDeleteAcknowledged providerResponseId "${cleanRespId}" does not match bound attempt provider_response_id "${String(existing.provider_response_id)}".`,
          { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' },
        );
      }
      if (!existing.origin || !existing.api_base_url || !existing.credential_fingerprint_sha256) {
        throw new OpenAiPolicyError(
          `Attempt "${existing.attempt_id}" lacks verified connection binding; run verifyLegacyAttemptConnectionBinding before acknowledging remote DELETE.`,
          { code: 'LEGACY_UNBOUND_CONNECTION_QUARANTINED' },
        );
      }
      if (
        existing.raw_receipt_json === null ||
        existing.raw_receipt_sha256 === null ||
        (existing.usage_cost_micros === null && existing.posted_billed_cents === null && !existing.confirmed_zero_charge) ||
        (!existing.terminal_outcome_status && existing.status !== 'completed' && existing.status !== 'failed_known')
      ) {
        throw new OpenAiPolicyError(
          `Cannot acknowledge DELETE on attempt "${existing.attempt_id}" before persisting receipt and terminal outcome.`,
          { code: 'DELETE_BEFORE_PERSIST_FORBIDDEN' },
        );
      }
      if (!this._hasVerifiedOriginalBytesForAttempt(existing)) {
        throw new OpenAiPolicyError(
          `Cannot acknowledge DELETE on attempt "${existing.attempt_id}" without verified original raw payload bytes.`,
          { code: 'DELETE_WITHOUT_VERIFIED_ORIGINAL_BYTES_FORBIDDEN' },
        );
      }
      const verifiedReceipt = this._validateCleanupTransportReceipt(existing, transportReceipt, 'DELETE', [200, 204]);

      const preservedTerminal = existing.terminal_outcome_status ?? (
        ['completed', 'failed_known'].includes(existing.status) ? existing.status : null
      );

      this.db.prepare(`
        UPDATE openai_request_ledger
        SET cleanup_required = 1,
            delete_ack_at = COALESCE(delete_ack_at, ?),
            delete_ack_receipt_json = COALESCE(delete_ack_receipt_json, ?),
            terminal_outcome_status = COALESCE(terminal_outcome_status, ?),
            cleanup_status = CASE WHEN cleanup_status = 'deleted_verified_404' THEN cleanup_status ELSE 'pending_cleanup' END,
            updated_at = ?
        WHERE attempt_id = ?
      `).run(now, canonicalJson(verifiedReceipt), preservedTerminal, now, existing.attempt_id);

      return this.getAttemptById(existing.attempt_id);
    });
  }

  recordCleanupVerified404(attemptId, {
    providerResponseId = null,
    transportReceipt = null,
  } = {}) {
    this._assertWritable();
    if (typeof providerResponseId !== 'string' || !providerResponseId.trim()) {
      throw new OpenAiValidationError('recordCleanupVerified404 requires a nonempty providerResponseId.');
    }
    const cleanRespId = providerResponseId.trim();
    assertSafeStoredValue(cleanRespId, 'providerResponseId');
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttemptById(attemptId);
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI request attempt "${attemptId}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      if (!existing.provider_response_id || existing.provider_response_id !== cleanRespId) {
        throw new OpenAiBudgetError(
          `recordCleanupVerified404 providerResponseId "${cleanRespId}" does not match bound attempt provider_response_id "${String(existing.provider_response_id)}".`,
          { code: 'PROVIDER_RESPONSE_ID_IMMUTABLE' },
        );
      }
      if (!existing.origin || !existing.api_base_url || !existing.credential_fingerprint_sha256) {
        throw new OpenAiPolicyError(
          `Attempt "${existing.attempt_id}" lacks verified connection binding; run verifyLegacyAttemptConnectionBinding before finalizing 404 cleanup.`,
          { code: 'LEGACY_UNBOUND_CONNECTION_QUARANTINED' },
        );
      }
      if (!existing.delete_ack_at || !existing.delete_ack_receipt_json) {
        throw new OpenAiBudgetError(
          `Cannot verify 404 cleanup on attempt "${existing.attempt_id}" without a prior persisted DELETE 200 transport receipt.`,
          { code: 'CLEANUP_DELETE_ACK_REQUIRED' },
        );
      }
      if (!this._hasVerifiedOriginalBytesForAttempt(existing)) {
        throw new OpenAiPolicyError(
          `Cannot finalize 404 cleanup on attempt "${existing.attempt_id}" without verified original raw payload bytes.`,
          { code: 'DELETE_WITHOUT_VERIFIED_ORIGINAL_BYTES_FORBIDDEN' },
        );
      }
      if (
        existing.raw_receipt_json === null ||
        (existing.usage_cost_micros === null && existing.posted_billed_cents === null && !existing.confirmed_zero_charge)
      ) {
        throw new OpenAiBudgetError(
          `Cannot finalize cleanup on attempt "${existing.attempt_id}" without persisted receipt and usage_cost_micros.`,
          { code: 'MISSING_COMPLETED_RECEIPT' },
        );
      }
      const verified404Receipt = this._validateCleanupTransportReceipt(existing, transportReceipt, 'GET', [404]);
      const finalStatus = existing.terminal_outcome_status ?? (
        ['completed', 'failed_known'].includes(existing.status) ? existing.status : null
      );
      if (!finalStatus) {
        throw new OpenAiBudgetError(
          `Attempt "${existing.attempt_id}" has no persisted terminal_outcome_status to finalize after 404 readback.`,
          { code: 'INVALID_STATE_TRANSITION' },
        );
      }

      this.db.prepare(`
        UPDATE openai_request_ledger
        SET status = ?,
            cleanup_status = 'deleted_verified_404',
            cleanup_404_receipt_json = COALESCE(cleanup_404_receipt_json, ?),
            updated_at = ?,
            finished_at = COALESCE(finished_at, ?)
        WHERE attempt_id = ?
      `).run(finalStatus, canonicalJson(verified404Receipt), now, now, existing.attempt_id);

      return this.getAttemptById(existing.attempt_id);
    });
  }

  updateCleanupStatus(attemptIdOrLogicalId, { cleanupStatus, diagnosticReason = null } = {}) {
    this._assertWritable();
    if (!CLEANUP_STATUSES.includes(cleanupStatus)) {
      throw new OpenAiValidationError(`Invalid cleanupStatus "${cleanupStatus}".`);
    }
    if (cleanupStatus === 'deleted_verified_404') {
      throw new OpenAiPolicyError(
        'Cannot set cleanup_status="deleted_verified_404" via updateCleanupStatus; use recordCleanupVerified404 with a verified GET 404 transportReceipt.',
        { code: 'CLEANUP_TRANSPORT_RECEIPT_REQUIRED' },
      );
    }
    const cleanReason = sanitizeSafeNote(diagnosticReason, 'diagnosticReason');
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttempt(attemptIdOrLogicalId);
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI request attempt "${attemptIdOrLogicalId}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }
      // P0-05: Monotonic deleted_verified_404 — never overwrite verified deletion with delete_failed/pending_cleanup!
      if (existing.cleanup_status === 'deleted_verified_404') {
        return existing;
      }
      const isFailureOrPending = cleanupStatus === 'delete_failed' || cleanupStatus === 'pending_cleanup';
      const preservedTerminal = existing.terminal_outcome_status ?? (
        isFailureOrPending && ['completed', 'failed_known'].includes(existing.status)
          ? existing.status
          : null
      );
      this.db.prepare(`
        UPDATE openai_request_ledger
        SET cleanup_required = CASE WHEN ? = 1 THEN 1 ELSE cleanup_required END,
            cleanup_status = ?,
            terminal_outcome_status = COALESCE(terminal_outcome_status, ?),
            diagnostic_reason = COALESCE(?, diagnostic_reason),
            updated_at = ?
        WHERE attempt_id = ?
      `).run(
        isFailureOrPending ? 1 : 0,
        cleanupStatus,
        preservedTerminal,
        cleanReason,
        now,
        existing.attempt_id,
      );
      return this.getAttemptById(existing.attempt_id);
    });
  }

  /**
   * Transition dangling `in_progress` attempts (e.g. after a hard process crash)
   * into `pending_recovery`, preserving `reserved_cents` and keeping the fence active.
   */
  markInterruptedAsPendingRecovery({ accountScope = null } = {}) {
    this._assertWritable();
    if (!this._hasTable('openai_request_ledger')) return [];
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const rows = accountScope
        ? this.db.prepare(
            "SELECT attempt_id FROM openai_request_ledger WHERE account_scope = ? AND status = 'in_progress'",
          ).all(assertSafeOpenAiAccountScope(accountScope))
        : this.db.prepare(
            "SELECT attempt_id FROM openai_request_ledger WHERE status = 'in_progress'",
          ).all();

      const stmt = this.db.prepare(`
        UPDATE openai_request_ledger
        SET status = 'pending_recovery',
            diagnostic_reason = COALESCE(diagnostic_reason || ' | ', '') || 'Interrupted in_progress request moved to pending_recovery; retain reservation and fence.',
            updated_at = ?
        WHERE attempt_id = ?
      `);
      for (const r of rows) {
        stmt.run(now, r.attempt_id);
      }
      return rows.map(r => r.attempt_id);
    });
  }

  /**
   * Operator reconciliation for `pending_recovery` / `in_progress` / unconfirmed `rejected` attempts OR
   * posted billing reconciliation (`posted_billed_cents`).
   */
  reconcileAttempt(attemptIdOrLogicalId, {
    status = undefined,
    note,
    confirmedZeroCharge = false,
    confirmedNotCreatedRemotely = false,
    cleanupConfirmedDeleted = false,
    usageCostMicros = undefined,
    postedBilledCents = undefined,
    providerResponseId = undefined,
    providerIdEvidence = null,
    accountScope = null,
  } = {}) {
    this._assertWritable();
    if (typeof confirmedZeroCharge !== 'boolean') {
      throw new OpenAiValidationError('confirmedZeroCharge must be a boolean.');
    }
    if (typeof confirmedNotCreatedRemotely !== 'boolean') {
      throw new OpenAiValidationError('confirmedNotCreatedRemotely must be a boolean.');
    }
    if (typeof cleanupConfirmedDeleted !== 'boolean') {
      throw new OpenAiValidationError('cleanupConfirmedDeleted must be a boolean.');
    }
    if (cleanupConfirmedDeleted) {
      throw new OpenAiPolicyError(
        'Operator boolean cleanupConfirmedDeleted is forbidden; remote cleanup must be verified via bound DELETE 200 acknowledgment and GET 404 readback.',
        { code: 'CLEANUP_NOT_VERIFIED' },
      );
    }
    const cleanNote = sanitizeSafeNote(note, 'reconciliation_note');
    if (!cleanNote) {
      throw new OpenAiValidationError('A nonempty reconciliation note is required.');
    }
    if (status === 'rejected') {
      throw new OpenAiValidationError(
        'Operator reconciliation forbids status="rejected" once a request was reserved/dispatched; use "completed", "failed_known", or "pending_recovery".',
      );
    }
    if (status !== undefined && !['completed', 'failed_known', 'pending_recovery'].includes(status)) {
      throw new OpenAiValidationError(
        'status must be completed, failed_known, or pending_recovery when provided.',
      );
    }
    if (usageCostMicros !== undefined && usageCostMicros !== null) {
      assertNonNegInt(usageCostMicros, 'usageCostMicros');
    }
    if (postedBilledCents !== undefined && postedBilledCents !== null) {
      assertNonNegInt(postedBilledCents, 'postedBilledCents');
    }
    let cleanRespId;
    if (providerResponseId !== undefined) {
      if (providerResponseId === null || !String(providerResponseId).trim()) {
        throw new OpenAiValidationError('providerResponseId cannot be null or empty when provided.');
      }
      cleanRespId = String(providerResponseId).trim();
      assertSafeStoredValue(cleanRespId, 'providerResponseId');
    }
    const now = this._nowIso();

    return this._withImmediateTx(() => {
      const existing = this.getAttempt(attemptIdOrLogicalId, { accountScope });
      if (!existing) {
        throw new OpenAiBudgetError(`OpenAI request attempt "${sanitizeDiagnosticText(attemptIdOrLogicalId)}" not found.`, {
          code: 'ATTEMPT_NOT_FOUND',
        });
      }

      if (usageCostMicros === null && (existing.usage_cost_micros !== null || existing.provisional_usage_cost_micros !== null)) {
        throw new OpenAiValidationError('Cannot overwrite existing non-null usage_cost_micros with null.');
      }
      if (postedBilledCents === null && existing.posted_billed_cents !== null) {
        throw new OpenAiValidationError('Cannot overwrite existing non-null posted_billed_cents with null.');
      }

      const minObservedUsageFloor = Math.max(
        existing.usage_cost_micros ?? 0,
        existing.provisional_usage_cost_micros ?? 0,
      );
      if (
        usageCostMicros !== undefined &&
        usageCostMicros !== null &&
        ((existing.usage_cost_micros !== null && usageCostMicros < existing.usage_cost_micros) ||
          (minObservedUsageFloor > 0 && usageCostMicros < minObservedUsageFloor))
      ) {
        throw new OpenAiBudgetError(
          `Cannot reduce observed usage cost on attempt "${existing.attempt_id}" from ${minObservedUsageFloor} micros to ${usageCostMicros} micros.`,
          { code: 'USAGE_REDUCTION_FORBIDDEN' },
        );
      }
      if (
        postedBilledCents !== undefined &&
        postedBilledCents !== null &&
        existing.posted_billed_cents !== null &&
        postedBilledCents < existing.posted_billed_cents
      ) {
        throw new OpenAiBudgetError(
          `Cannot reduce posted_billed_cents on attempt "${existing.attempt_id}" from ${existing.posted_billed_cents}c to ${postedBilledCents}c.`,
          { code: 'BILLED_REDUCTION_FORBIDDEN' },
        );
      }
      if (
        postedBilledCents !== undefined &&
        postedBilledCents !== null &&
        usageCostMicros === undefined &&
        existing.usage_cost_micros === null &&
        minObservedUsageFloor > 0 &&
        postedBilledCents < microsToCeilingCents(minObservedUsageFloor)
      ) {
        throw new OpenAiBudgetError(
          `postedBilledCents (${postedBilledCents}c) on attempt "${existing.attempt_id}" cannot be lower than observed provisional usage floor (${microsToCeilingCents(minObservedUsageFloor)}c).`,
          { code: 'USAGE_REDUCTION_FORBIDDEN' },
        );
      }

      if (cleanRespId !== undefined) {
        // P0-03: Require verified providerIdEvidence matching payload_sha256 when binding a first-time providerResponseId!
        this._assertVerifiedFirstProviderIdEvidence(existing, cleanRespId, providerIdEvidence);
        this._assertImmutableAndUniqueProviderId(existing, cleanRespId);
      }

      const targetStatus = status ?? existing.status;
      if (targetStatus === 'completed' && confirmedZeroCharge) {
        throw new OpenAiValidationError('confirmedZeroCharge cannot be true when settling status="completed".');
      }

      // P0-13: NEVER auto-promote interim provisional_usage_cost_micros as final settled usage!
      const mergedUsageMicros = usageCostMicros !== undefined
        ? usageCostMicros
        : existing.usage_cost_micros;
      const mergedPostedCents = postedBilledCents !== undefined ? postedBilledCents : existing.posted_billed_cents;

      if (
        confirmedZeroCharge &&
        (minObservedUsageFloor > 0 ||
          (mergedUsageMicros !== null && mergedUsageMicros > 0) ||
          (mergedPostedCents !== null && mergedPostedCents > 0))
      ) {
        throw new OpenAiValidationError('confirmedZeroCharge cannot be true when positive usage, provisional usage, or billed cost is present.');
      }

      const hasStrictlyPositiveVerifiedCharge =
        (mergedUsageMicros !== null && mergedUsageMicros !== undefined && mergedUsageMicros > 0) ||
        (mergedPostedCents !== null && mergedPostedCents !== undefined && mergedPostedCents > 0);

      if (targetStatus === 'failed_known' && !confirmedZeroCharge && !hasStrictlyPositiveVerifiedCharge) {
        throw new OpenAiBudgetError(
          `Settling attempt "${existing.attempt_id}" to "failed_known" requires confirmedZeroCharge: true or strictly positive verified usageCostMicros / postedBilledCents evidence (interim provisional usage alone cannot settle).`,
          { code: 'MISSING_RECONCILIATION_CHARGE_EVIDENCE' },
        );
      }

      if (targetStatus === 'completed') {
        const hasVerifiedZeroCompletionReceipt =
          mergedUsageMicros === 0 &&
          (existing.endpoint === '/v1/files' || (
            !(existing.http_status >= 400) &&
            existing.raw_receipt !== null &&
            typeof existing.raw_receipt === 'object' &&
            existing.raw_receipt.error == null &&
            !(typeof existing.raw_receipt.http_status === 'number' && existing.raw_receipt.http_status >= 400) &&
            (existing.raw_receipt.status === undefined || existing.raw_receipt.status === 'completed') &&
            existing.raw_receipt.usage !== null &&
            typeof existing.raw_receipt.usage === 'object' &&
            Number.isSafeInteger(existing.raw_receipt.usage.input_tokens) &&
            existing.raw_receipt.usage.input_tokens === 0 &&
            Number.isSafeInteger(existing.raw_receipt.usage.output_tokens) &&
            existing.raw_receipt.usage.output_tokens === 0
          ));
        const hasVerifiedCompletedEvidence =
          hasStrictlyPositiveVerifiedCharge || hasVerifiedZeroCompletionReceipt;
        if (!hasVerifiedCompletedEvidence) {
          throw new OpenAiBudgetError(
            `Settling attempt "${existing.attempt_id}" to "completed" requires strictly positive verified usageCostMicros / postedBilledCents (interim provisional usage or error receipts with 0 usage cannot settle as completed).`,
            { code: 'MISSING_RECONCILIATION_CHARGE_EVIDENCE' },
          );
        }
      }

      let nextCleanupReq = existing.cleanup_required ? 1 : 0;
      let nextCleanupStatus = existing.cleanup_status;
      let nextConfirmedNotCreated = existing.confirmed_not_created_remotely ? 1 : 0;
      if (
        nextCleanupReq === 1 &&
        nextCleanupStatus !== 'deleted_verified_404' &&
        targetStatus !== 'pending_recovery'
      ) {
        // P0-04 & P0-05: Require explicit confirmedNotCreatedRemotely: true (not confirmedZeroCharge alone!)
        // AND zero remote response evidence before clearing a cleanup_required hold!
        const neverCreatedRemoteObject =
          confirmedZeroCharge &&
          confirmedNotCreatedRemotely &&
          !existing.provider_response_id &&
          cleanRespId === undefined &&
          existing.raw_receipt_json === null &&
          existing.terminal_outcome_status === null &&
          existing.delete_ack_at === null &&
          minObservedUsageFloor === 0 &&
          targetStatus === 'failed_known';
        if (neverCreatedRemoteObject) {
          nextCleanupReq = 0;
          nextCleanupStatus = 'not_requested';
          nextConfirmedNotCreated = 1;
        } else if (
          existing.raw_receipt_json !== null &&
          (hasStrictlyPositiveVerifiedCharge ||
            (targetStatus === 'failed_known' && confirmedZeroCharge))
        ) {
          // Allow accounting terminal state to settle independently when charge evidence and local receipt
          // are persisted, keeping remote cleanup tracked explicitly as pending_cleanup without deadlocking.
          nextCleanupReq = 1;
          nextCleanupStatus = (nextCleanupStatus && nextCleanupStatus !== 'not_requested')
            ? nextCleanupStatus
            : 'pending_cleanup';
        } else {
          throw new OpenAiBudgetError(
            `Attempt "${existing.attempt_id}" requires remote cleanup verification via bound DELETE 200 + GET 404 readback (or confirmedZeroCharge: true + confirmedNotCreatedRemotely: true when never created remotely) before settling to "${targetStatus}".`,
            { code: 'CLEANUP_NOT_VERIFIED' },
          );
        }
      }

      const nextUsageMicros = usageCostMicros !== undefined
        ? usageCostMicros
        : (confirmedZeroCharge && targetStatus !== 'pending_recovery' && existing.usage_cost_micros === null && minObservedUsageFloor === 0
          ? 0
          : existing.usage_cost_micros);
      const nextPostedCents = postedBilledCents !== undefined
        ? postedBilledCents
        : existing.posted_billed_cents;
      const isTerminal = targetStatus !== 'pending_recovery' && targetStatus !== 'in_progress';
      const nextConfirmedZero = confirmedZeroCharge && isTerminal
        ? 1
        : (existing.confirmed_zero_charge ? 1 : 0);
      const nextRespId = cleanRespId !== undefined ? cleanRespId : existing.provider_response_id;

      this.db.prepare(`
        UPDATE openai_request_ledger
        SET status = ?,
            usage_cost_micros = ?,
            posted_billed_cents = ?,
            confirmed_zero_charge = ?,
            confirmed_not_created_remotely = ?,
            provider_response_id = ?,
            cleanup_required = ?,
            cleanup_status = ?,
            reconciliation_note = ?,
            updated_at = ?,
            finished_at = CASE WHEN ? = 1 THEN COALESCE(finished_at, ?) ELSE finished_at END
        WHERE attempt_id = ?
      `).run(
        targetStatus,
        nextUsageMicros,
        nextPostedCents,
        nextConfirmedZero,
        nextConfirmedNotCreated,
        nextRespId,
        nextCleanupReq,
        nextCleanupStatus,
        cleanNote,
        now,
        isTerminal ? 1 : 0,
        now,
        existing.attempt_id,
      );

      return this.getAttemptById(existing.attempt_id);
    });
  }
}

export function openOpenAiBudgetLedger(dbOrPath = ':memory:', options = {}) {
  return new OpenAiBudgetLedger(dbOrPath, options);
}

function extractSqliteMainFileFromDbOrTarget(dbOrLedger) {
  if (typeof dbOrLedger === 'string') {
    const trimmed = dbOrLedger.trim();
    if (!trimmed) {
      throw new OpenAiValidationError('dbOrLedger path must be a nonempty string.');
    }
    if (trimmed === ':memory:') {
      return { isMemory: true, mainFile: '' };
    }
    const norm = normalizeFilesystemPathInput(trimmed);
    if (!norm) {
      throw new OpenAiBudgetError('Unverifiable destination SQLite path.', {
        code: 'UNVERIFIABLE_SQLITE_IDENTITY',
        notDispatched: true,
      });
    }
    return { isMemory: false, mainFile: norm };
  }

  if (dbOrLedger instanceof OpenAiBudgetLedger) {
    return {
      isMemory: dbOrLedger.isMemoryDatabase(),
      mainFile: dbOrLedger._mainFile,
    };
  }

  if (dbOrLedger instanceof DatabaseSync) {
    const mainFile = queryMainFileFromDatabaseSync(dbOrLedger);
    return { isMemory: mainFile === '', mainFile };
  }

  if (dbOrLedger && typeof dbOrLedger === 'object' && dbOrLedger.db instanceof DatabaseSync) {
    const mainFile = queryMainFileFromDatabaseSync(dbOrLedger.db);
    const hint = typeof dbOrLedger.dbPath === 'string' ? dbOrLedger.dbPath.trim() : '';
    if (mainFile === '' && hint && hint !== ':memory:' && hint !== ':borrowed:') {
      throw new OpenAiPolicyError(
        'Destination store wraps an in-memory SQLite connection while claiming a file dbPath.',
        { code: 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE', notDispatched: true },
      );
    }
    return { isMemory: mainFile === '', mainFile };
  }

  throw new OpenAiValidationError(
    'dbOrLedger must be a file path string, ":memory:", OpenAiBudgetLedger, DatabaseSync, or SelectionStore.',
  );
}

/**
 * Reconcile an inspected legacy budget summary (or legacy DB path) into a target store/DB/ledger.
 * Checks physical file-identity collision against destination ledger BEFORE opening any writable store/ledger or running DDL.
 */
export function reconcileLegacyBudgetIntoStore(dbOrLedger, legacySummaryOrPath, options = {}) {
  const destInfo = extractSqliteMainFileFromDbOrTarget(dbOrLedger);
  let srcPath = null;
  if (typeof legacySummaryOrPath === 'string') {
    srcPath = normalizeFilesystemPathInput(legacySummaryOrPath);
    if (!srcPath) {
      throw new OpenAiValidationError('legacySqlitePath must be a valid filesystem path.');
    }
  } else if (legacySummaryOrPath && typeof legacySummaryOrPath === 'object' && !Array.isArray(legacySummaryOrPath)) {
    const verified = VERIFIED_INSPECTIONS.get(legacySummaryOrPath) ?? null;
    srcPath = verified ? verified.canonicalRealPath : null;
    const allowSynth = Boolean(options.testMode === true && options.allowSyntheticSummaryForTests === true);
    if (!destInfo.isMemory && !srcPath && !allowSynth) {
      throw new OpenAiBudgetError(
        'File-backed OpenAI budget ledgers require an authentic immutable inspection summary returned by inspectLegacyAutopilotBudget.',
        { code: 'UNVERIFIED_LEGACY_SUMMARY_OBJECT', notDispatched: true },
      );
    }
  } else {
    throw new OpenAiValidationError('legacySummaryOrPath must be a file path string or inspected summary object.');
  }

  if (srcPath) {
    if (!destInfo.isMemory) {
      if (!destInfo.mainFile) {
        throw new OpenAiBudgetError(
          'Cannot verify destination SQLite file identity before legacy reconciliation.',
          { code: 'UNVERIFIABLE_SQLITE_IDENTITY', notDispatched: true },
        );
      }
      if (areSamePhysicalSqliteFile(srcPath, destInfo.mainFile)) {
        throw new OpenAiBudgetError(
          'Legacy budget SQLite source and destination ledger resolve to the same physical file.',
          { code: 'LEGACY_SOURCE_DESTINATION_COLLISION', notDispatched: true },
        );
      }
    }
  }

  const summary = typeof legacySummaryOrPath === 'string'
    ? inspectLegacyAutopilotBudget(legacySummaryOrPath, { monthUtc: options.monthUtc })
    : legacySummaryOrPath;

  if (dbOrLedger instanceof OpenAiBudgetLedger) {
    return dbOrLedger.reconcileLegacySummary(summary, options);
  }
  const ledger = new OpenAiBudgetLedger(dbOrLedger, {
    testMode: Boolean(options.testMode === true),
  });
  try {
    return ledger.reconcileLegacySummary(summary, options);
  } finally {
    ledger.close();
  }
}
