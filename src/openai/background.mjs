import { randomUUID } from 'node:crypto';
import { link, lstat, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { containsRawEmail, containsSecretToken, detectRawPii } from '../contracts.mjs';
import { OpenAiValidationError } from './pricing.mjs';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const ACTION_TYPES = new Set(['search', 'open_page', 'find_in_page']);
const MAX_RECENT_QUERIES = 8;
const MAX_QUERY_LENGTH = 240;
const MAX_BACKOFF_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;

export function hasPersistedBackgroundTerminal(attempt) {
  return Boolean(attempt?.background_mode && attempt.terminal_outcome_status && attempt.raw_receipt_json &&
    attempt.raw_receipt_sha256 && Number.isSafeInteger(attempt.usage_cost_micros));
}

export function getWebSearchActions(response) {
  const seen = new Set();
  const actions = [];
  const output = Array.isArray(response?.output) ? response.output : [];
  const errorOutput = Array.isArray(response?.error?.output) && response.error.output !== response.output
    ? response.error.output
    : [];
  for (const item of [...output, ...errorOutput]) {
    if (item?.type !== 'web_search_call' && item?.type !== 'web_search') continue;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const action = item.action;
    const type = ACTION_TYPES.has(action?.type) ? action.type : 'unknown';
    const queries = type === 'search'
      ? (Array.isArray(action.queries) && action.queries.length ? action.queries : [action.query])
      : [];
    actions.push({
      id,
      type,
      legacy: action?.type == null,
      queries: queries.filter(query => typeof query === 'string' && query.trim()),
    });
  }
  return actions;
}

export function readReportedWebSearchCalls(response) {
  for (const usage of [response?.usage, response?.error?.usage]) {
    if (Number.isSafeInteger(usage?.web_search_calls) && usage.web_search_calls >= 0) return usage.web_search_calls;
  }
  return null;
}

export function validateBackgroundOptions(options = {}, defaultPollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > MAX_TIMER_MS) {
    throw new OpenAiValidationError('pollIntervalMs must be a nonnegative integer supported by a Node timer.');
  }
  const maxWaitMs = options.maxWaitMs ?? null;
  if (maxWaitMs !== null && (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > MAX_TIMER_MS)) {
    throw new OpenAiValidationError('maxWaitMs must be null or a nonnegative integer supported by a Node timer.');
  }
  if (options.waitForCompletion !== undefined && typeof options.waitForCompletion !== 'boolean') {
    throw new OpenAiValidationError('waitForCompletion must be a boolean when provided.');
  }
  if (options.onProgress != null && typeof options.onProgress !== 'function') {
    throw new OpenAiValidationError('onProgress must be a function when provided.');
  }
  if (options.progressFile != null &&
    (typeof options.progressFile !== 'string' || !options.progressFile.trim() || options.progressFile.includes('\0'))) {
    throw new OpenAiValidationError('progressFile must be a nonempty filesystem path when provided.');
  }
  return {
    pollIntervalMs,
    maxWaitMs,
    waitForCompletion: options.waitForCompletion !== false,
    onProgress: options.onProgress ?? null,
    progressFile: options.progressFile == null ? null : resolve(options.progressFile),
  };
}

export async function delayBackgroundPoll(interval, consecutiveErrors, signal, remainingMs = null) {
  const backoff = Math.min(MAX_BACKOFF_MS, interval * (2 ** consecutiveErrors));
  const wait = Math.max(interval, backoff);
  const truncatedByDeadline = remainingMs !== null && remainingMs <= wait;
  await delay(remainingMs === null ? wait : Math.min(wait, Math.ceil(remainingMs)), undefined, {
    signal: signal ?? undefined,
  });
  return { truncatedByDeadline };
}

export async function getBackgroundResponseWithinWait(retrieve, signal, remainingMs) {
  if (remainingMs === null) return retrieve(signal);
  const controller = new AbortController();
  const getSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  try {
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve(null);
        controller.abort();
      }, Math.ceil(remainingMs));
    });
    return await Promise.race([deadline, retrieve(getSignal)]);
  } finally {
    clearTimeout(timer);
  }
}

function cleanQuery(query) {
  // The input was already scrubbed by the client. Omit values still carrying private markers,
  // contact patterns or a URL whose path or query string could contain identifiers.
  if (/\[REDACTED_|\bhttps?:\/\/|\bwww\.|(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/i.test(query) ||
    containsRawEmail(query, { strict: true, skipDataImageUri: false }) ||
    detectRawPii(query) || containsSecretToken(query)) return null;
  const clean = query.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return clean ? clean.slice(0, MAX_QUERY_LENGTH) : null;
}

async function isExistingProgressFile(file, attemptId) {
  try {
    const info = await lstat(file);
    if (attemptId && info.isFile() && info.size <= 16_384) {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed?.attempt_id === attemptId && Number.isSafeInteger(parsed.poll_count) &&
        typeof parsed.started_at === 'string' && typeof parsed.updated_at === 'string' &&
        Array.isArray(parsed.recent_queries)) return true;
    }
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
  }
  throw new OpenAiValidationError('progressFile already exists and is not a progress snapshot for this attempt.', {
    code: 'BACKGROUND_PROGRESS_FILE_CONFLICT',
  });
}

export async function preflightBackgroundProgressFile(file, attemptId = null) {
  if (!file) return;
  await isExistingProgressFile(file, attemptId);
  const parent = await stat(dirname(file)).catch(() => null);
  if (!parent?.isDirectory()) {
    throw new OpenAiValidationError('The progressFile parent directory is unavailable.', {
      code: 'BACKGROUND_PROGRESS_DIRECTORY_MISSING',
    });
  }
}

async function writeProgressAtomically(file, snapshot) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temp, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    created = true;
    if (!(await isExistingProgressFile(file, snapshot.attempt_id))) {
      try {
        await link(temp, file);
        return;
      } catch (err) {
        if (err?.code !== 'EEXIST' || !(await isExistingProgressFile(file, snapshot.attempt_id))) throw err;
      }
    }
    await rename(temp, file);
  } finally {
    if (created) await unlink(temp).catch(() => {});
  }
}

export function createBackgroundProgress(attempt, options, now) {
  const startedAt = attempt.created_at ?? now().toISOString();
  const observed = new Map();
  const queryCounts = new Map();
  const recentQueries = [];
  let reportedSearchCalls = 0;
  let repeatedQuery = false;

  const emit = async (status, pollCount, response) => {
    if (!options.onProgress && !options.progressFile) return;
    const anonymousOccurrences = new Map();
    for (const action of getWebSearchActions(response)) {
      const queries = action.queries.map(cleanQuery).filter(Boolean);
      const anonymousKey = JSON.stringify([action.type, queries]);
      const sequence = anonymousOccurrences.get(anonymousKey) ?? 0;
      if (!action.id) anonymousOccurrences.set(anonymousKey, sequence + 1);
      const key = action.id ? `id:${action.id}` : `anonymous:${anonymousKey}:${sequence}`;
      const previous = observed.get(key);
      if (!previous || previous.type === 'unknown') {
        observed.set(key, { type: action.type, legacy: action.legacy, queries: previous?.queries ?? new Set() });
      }
      const seen = observed.get(key).queries;
      for (const query of queries) {
        const normalized = query.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const count = (queryCounts.get(normalized) ?? 0) + 1;
        queryCounts.set(normalized, count);
        repeatedQuery ||= count >= 4;
        recentQueries.push(query);
        if (recentQueries.length > MAX_RECENT_QUERIES) recentQueries.shift();
      }
    }
    const actionCounts = { search: 0, open_page: 0, find_in_page: 0, unknown: 0 };
    let legacySearchCalls = 0;
    for (const { type, legacy } of observed.values()) {
      actionCounts[type]++;
      if (legacy) legacySearchCalls++;
    }
    const currentReportedSearchCalls = readReportedWebSearchCalls(response);
    reportedSearchCalls = Math.max(reportedSearchCalls, currentReportedSearchCalls ?? 0);
    const billedSearchCalls = currentReportedSearchCalls ?? Math.max(reportedSearchCalls, actionCounts.search + legacySearchCalls);
    const searchCalls = Math.max(reportedSearchCalls, Object.values(actionCounts).reduce((sum, count) => sum + count, 0));
    const updatedAt = now().toISOString();
    const snapshot = Object.freeze({
      attempt_id: attempt.attempt_id,
      logical_request_id: attempt.logical_request_id,
      provider_response_id: attempt.provider_response_id ?? null,
      model: attempt.model,
      status,
      started_at: startedAt,
      updated_at: updatedAt,
      elapsed_ms: Math.max(0, Date.parse(updatedAt) - Date.parse(startedAt)),
      poll_count: pollCount,
      observed_web_search_calls: searchCalls,
      billable_web_search_calls_observed: billedSearchCalls,
      action_counts: Object.freeze(actionCounts),
      recent_queries: Object.freeze([...recentQueries]),
      repeated_query_loop_warning: repeatedQuery || searchCalls >= 30,
    });
    // Optional observers cannot interrupt settlement or alter the provider lifecycle.
    if (options.progressFile) {
      try {
        await writeProgressAtomically(options.progressFile, snapshot);
      } catch (err) {
        emit.progressError = Object.freeze({
          code: 'BACKGROUND_PROGRESS_FILE_WRITE_FAILED',
          io_code: ['EACCES', 'EPERM', 'ENOSPC', 'ENOENT', 'EIO', 'EMFILE', 'EBUSY',
            'BACKGROUND_PROGRESS_FILE_CONFLICT'].includes(err?.code) ? err.code : null,
        });
      }
    }
    if (options.onProgress) {
      const event = emit.progressError ? Object.freeze({ ...snapshot, progress_error: emit.progressError }) : snapshot;
      try { Promise.resolve(options.onProgress(event)).catch(() => {}); } catch { /* observer failed */ }
    }
  };
  return emit;
}
