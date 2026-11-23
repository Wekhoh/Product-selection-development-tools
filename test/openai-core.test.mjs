import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelectionStore, sha256Hex } from '../src/store.mjs';
import {
  DEFAULT_TTS_MICROS_PER_1K_CHARS,
  MICROS_PER_CENT,
  MICROS_PER_DOLLAR,
  MIN_VERIFIED_TTS_MICROS_PER_1K_CHARS,
  OPENAI_MODEL_PRICING,
  OpenAiError,
  OpenAiPolicyError,
  OpenAiValidationError,
  computeTtsCostMicros,
  computeUsageCostMicros,
  estimateCostBreakdown,
  estimateReservationCents,
  resolveEffectiveServiceTier,
  resolveTtsMicrosPer1kChars,
  safeMicrosToNumber,
} from '../src/openai/pricing.mjs';
import {
  MAX_MONTHLY_LIMIT_CENTS,
  OpenAiBudgetError,
  OpenAiBudgetLedger,
  areSamePhysicalSqliteFile,
  extractMonthPrefix,
  inspectLegacyAutopilotBudget,
  openOpenAiBudgetLedger,
  reconcileLegacyBudgetIntoStore,
} from '../src/openai/budget-ledger.mjs';
import {
  OpenAiAmbiguousOutcomeError,
  OpenAiClient,
  OpenAiHttpError,
  buildBatchJsonl,
  computeRequestPayloadSha256,
  estimateResponsesInputTokens,
  extractWebSearchCallsFromOutput,
  loadOpenAiApiKey,
  parseBatchOutputJsonl,
  parseInlineRasterDimensions,
  validateAudioFramingAndMagicBytes,
  validateSupportedJsonSchemaDialect,
  validateValueAgainstJsonSchema,
} from '../src/openai/client.mjs';

// Construct synthetic credential/PII tokens at runtime so tracked source contains zero literal secrets or paths.
const SYNTHETIC_API_KEY = ['s' + 'k', 'proj', 'unitTestMockCredential000001'].join('-');
const SYNTHETIC_API_KEY_ALT = ['s' + 'k', 'proj', 'unitTestMockCredential000002'].join('-');
const SYNTHETIC_CUSTOM_SECRET = ['custom', 'opaque', 'secret', 'token987654'].join('_');
const SYNTHETIC_WIN_PATH = ['C:', 'Users', 'synthetic_operator', 'private', 'notes.txt'].join('\\');
const SYNTHETIC_CN_MOBILE = ['138', '0013', '8000'].join('');
const VALID_1X1_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
// Genuine 1x1 JPEG with SOI + APP0 JFIF + SOF0 (height=1, width=1) + EOI
const VALID_JPEG_B64 = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]).toString('base64');
// Genuine ID3v2 header (16 bytes) + complete 417-byte MPEG1 Layer III 128kbps 44.1kHz frame
const VALID_20B_MP3_BYTES = Buffer.concat([
  Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06,
    0x54, 0x49, 0x54, 0x32, 0x00, 0x00,
    0xff, 0xfb, 0x90, 0x64,
  ]),
  Buffer.alloc(413, 0x55),
]);

function buildPaddedValidPngBase64(width = 1, height = 1, padBytes = 16_000) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  let textChunk = Buffer.alloc(0);
  if (padBytes > 0) {
    textChunk = Buffer.alloc(12 + padBytes, 0x78);
    textChunk.writeUInt32BE(padBytes, 0);
    textChunk.write('tEXt', 4, 'ascii');
  }
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([sig, ihdr, textChunk, iend]).toString('base64');
}

function buildValidOggOpusBytes({ includeAudioPage = true } = {}) {
  const opusHeadPayload = Buffer.alloc(19);
  opusHeadPayload.write('OpusHead', 0, 'ascii');
  opusHeadPayload[8] = 1; // version
  opusHeadPayload[9] = 1; // 1 channel
  opusHeadPayload.writeUInt32LE(48000, 12);

  const page1Hdr = Buffer.alloc(28);
  page1Hdr.write('OggS', 0, 'ascii');
  page1Hdr[4] = 0;    // version 0
  page1Hdr[5] = 0x02; // BOS
  page1Hdr[26] = 1;   // 1 segment
  page1Hdr[27] = opusHeadPayload.length;
  const page1 = Buffer.concat([page1Hdr, opusHeadPayload]);
  if (!includeAudioPage) return page1;

  const audioPacket = Buffer.from([0xf8, 0xff, 0xfe, 0x00, 0x11, 0x22, 0x33, 0x44]);
  const page2Hdr = Buffer.alloc(28);
  page2Hdr.write('OggS', 0, 'ascii');
  page2Hdr[4] = 0;
  page2Hdr[5] = 0x04; // EOS
  page2Hdr[14] = 1;   // page seq 1
  page2Hdr[26] = 1;
  page2Hdr[27] = audioPacket.length;
  return Buffer.concat([page1, page2Hdr, audioPacket]);
}

async function withTempDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'openai-core-test-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 25 });
  }
}

function createActivatedMemoryLedger({
  accountScope = 'openai-default',
  monthUtc = '2026-11',
  monthlyLimitCents = 20_000,
  carryoverCents = 0,
  allowStage4Media = false,
  nowFn = null,
} = {}) {
  const ledger = new OpenAiBudgetLedger(':memory:', {
    nowFn: nowFn ?? (() => new Date(`${monthUtc}-15T12:00:00Z`)),
  });
  reconcileLegacyBudgetIntoStore(
    ledger,
    {
      recognized_schema: true,
      file_sha256: '0'.repeat(64),
      month_utc: monthUtc,
      total_rows: 0,
      status_counts: {},
      unresolved_count: 0,
      blocking_reasons: [],
      has_unresolved_holds: false,
      same_month_reserved_cents: carryoverCents,
    },
    {
      accountScope,
      enable: true,
      monthlyLimitCents,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
      allowStage4Media,
    },
  );
  return ledger;
}

function makeJsonFetchResponse(status, payload, headersObj = { 'content-type': 'application/json' }) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headersObj),
    async text() {
      return text;
    },
    async arrayBuffer() {
      return Buffer.from(text, 'utf8');
    },
  };
}

function makeBinaryFetchResponse(status, bytesOrText, contentType = 'audio/mpeg', extraHeaders = {}) {
  const buf = Buffer.isBuffer(bytesOrText) ? bytesOrText : Buffer.from(String(bytesOrText), 'utf8');
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ ...(contentType ? { 'content-type': contentType } : {}), ...extraHeaders }),
    async text() {
      return buf.toString('utf8');
    },
    async arrayBuffer() {
      return buf;
    },
  };
}

// -----------------------------------------------------------------------------
// 1. Pricing Math, Cache-Write Ceiling (P0-14), TTS Floor (P0-17), BigInt Guard (P2-12) & Astra Block
// -----------------------------------------------------------------------------

test('pricing.mjs: exact microdollar math, P0-14 cache-write reservation ceiling, P0-17 TTS floor, and P2-12 BigInt range guard', () => {
  assert.equal(MICROS_PER_DOLLAR, 1_000_000);
  assert.equal(MICROS_PER_CENT, 10_000);
  assert.equal(MIN_VERIFIED_TTS_MICROS_PER_1K_CHARS, 15_000);
  assert.equal(DEFAULT_TTS_MICROS_PER_1K_CHARS, 30_000);

  // gpt-6-luna: $0.10/1M in, $0.01/1M cached, $0.125/1M cache_write, $0.50/1M out
  const lunaMicros = computeUsageCostMicros({
    model: 'gpt-6-luna',
    serviceTier: 'standard',
    usage: {
      input_tokens: 10_000,
      input_tokens_details: {
        cached_tokens: 4_000,
        cache_write_tokens: 2_000,
      },
      output_tokens: 1_000,
    },
  });
  assert.equal(lunaMicros, 1_190);

  // Sub-micro exact BigInt ceiling: 1 cache_write token on gpt-6-luna batch -> ceil to 1 micro
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6-luna',
      serviceTier: 'batch',
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 },
        output_tokens: 0,
      },
    }),
    1,
  );

  // gpt-6.1-terra: output_tokens ALREADY includes reasoning_tokens!
  const terraWithReasoning = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    usage: {
      input_tokens: 50_000,
      output_tokens: 20_000,
      output_tokens_details: { reasoning_tokens: 16_000 },
    },
  });
  const terraWithoutReasoning = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    usage: {
      input_tokens: 50_000,
      output_tokens: 20_000,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
  assert.equal(terraWithReasoning, 150_000);
  assert.equal(terraWithReasoning, terraWithoutReasoning);

  // Adding 3 web_search calls ($0.01/call = 30_000 micros) -> 180_000 micros
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra-2026-11-01',
      serviceTier: 'default',
      usage: {
        input_tokens: 50_000,
        output_tokens: 20_000,
        output_tokens_details: { reasoning_tokens: 16_000 },
      },
      webSearchCalls: 3,
    }),
    180_000,
  );

  // Batch / flex 50% off on token rates, while web_search stays flat 10_000 micros/call
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      serviceTier: 'batch',
      usage: { input_tokens: 50_000, output_tokens: 20_000, output_tokens_details: { reasoning_tokens: 18_000 } },
      webSearchCalls: 3,
    }),
    105_000,
  );
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      serviceTier: 'flex',
      usage: { input_tokens: 50_000, output_tokens: 20_000 },
    }),
    75_000,
  );

  // >272K long-context (2x in/cache, 1.5x out) + fast tier (2x) on gpt-6.1-terra
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      serviceTier: 'fast',
      usage: { input_tokens: 300_000, output_tokens: 10_000 },
    }),
    1_350_000,
  );

  // P0-14: Cache-write reservation ceiling covers 100% cache-write input across standard, batch, flex, fast, and >272K!
  // 100k Terra input ($1.25/1M = 125_000 micros) + 4_096 output ($5/1M = 20_480 micros) = 145_480 micros -> 15 cents!
  const terraCacheWriteSettledMicros = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    usage: {
      input_tokens: 100_000,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 },
      output_tokens: 4_096,
    },
  });
  assert.equal(terraCacheWriteSettledMicros, 145_480);

  // Omitted serviceTier on /v1/responses reserves at 2x ('fast' ceiling) on Terra (290_960 micros -> 30 cents);
  // explicit serviceTier: 'standard' reserves at 1x (145_480 micros -> 15 cents)
  const terraReservedOmitted = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 4_096,
  });
  assert.equal(terraReservedOmitted.estimated_micros, 290_960);
  assert.equal(terraReservedOmitted.reservation_cents, 30);

  const terraReservedDefault = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 4_096,
  });
  assert.equal(terraReservedDefault.estimated_micros, 145_480);
  assert.equal(terraReservedDefault.reservation_cents, 15);
  assert.ok(terraReservedDefault.reservation_cents * MICROS_PER_CENT >= terraCacheWriteSettledMicros);

  // Explicit cacheWritePossible: false + serviceTier: 'standard' uses 1x standard inputMicrosPer1M (120_480 micros -> 13 cents)
  const terraNoCacheWrite = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    serviceTier: 'standard',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 4_096,
    cacheWritePossible: false,
  });
  assert.equal(terraNoCacheWrite.estimated_micros, 120_480);
  assert.equal(terraNoCacheWrite.reservation_cents, 13);

  // >272K + fast tier with 100% cache_write_tokens: reservation >= settled!
  const longFastSettled = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'fast',
    usage: {
      input_tokens: 300_000,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 300_000 },
      output_tokens: 10_000,
    },
  });
  const longFastReserved = estimateReservationCents({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    serviceTier: 'fast',
    estimatedInputTokens: 300_000,
    maxOutputTokens: 10_000,
  });
  assert.ok(longFastReserved * MICROS_PER_CENT >= longFastSettled);

  // gpt-6.2-sol & Image models
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-6.2-sol',
      usage: {
        input_tokens: 100_000,
        input_tokens_details: { cached_tokens: 50_000, cache_write_tokens: 10_000 },
        output_tokens: 5_000,
      },
    }),
    160_000,
  );
  assert.equal(
    computeUsageCostMicros({
      model: 'gpt-image-2.6-sunburst',
      usage: {
        input_tokens: 3_000,
        input_tokens_details: { text_tokens: 1_000, image_tokens: 2_000 },
        output_tokens: 4_000,
      },
    }),
    141_000,
  );

  // P0-17: TTS zero/negative/non-integer/below-minimum tariff rejection
  assert.equal(computeTtsCostMicros({ model: 'tts', inputChars: 1_500, ttsMicrosPer1kChars: 30_000 }), 45_000);
  assert.equal(computeTtsCostMicros({ model: 'tts-1', inputChars: 1_000 }), 15_000);
  for (const badRate of [0, -1, 12.5, Number.NaN]) {
    assert.throws(
      () => computeTtsCostMicros({ model: 'tts', inputChars: 1_000, ttsMicrosPer1kChars: badRate }),
      err => err instanceof OpenAiValidationError && err.code === 'INVALID_TTS_TARIFF',
    );
    assert.throws(
      () => estimateCostBreakdown({ endpoint: '/v1/audio/speech', model: 'tts', inputChars: 1_000, ttsMicrosPer1kChars: badRate }),
      err => err instanceof OpenAiValidationError && err.code === 'INVALID_TTS_TARIFF',
    );
  }
  assert.throws(
    () => computeTtsCostMicros({ model: 'tts', inputChars: 1_000, ttsMicrosPer1kChars: 14_999 }),
    err => err instanceof OpenAiValidationError && err.code === 'TTS_TARIFF_BELOW_MINIMUM',
  );
  assert.equal(
    computeTtsCostMicros({
      model: 'tts',
      inputChars: 1_000,
      ttsMicrosPer1kChars: 5_000,
      allowCustomTariffForTests: true,
    }),
    5_000,
  );

  // P2-12: Exact BigInt range check via safeMicrosToNumber
  assert.equal(safeMicrosToNumber(0n), 0);
  assert.equal(safeMicrosToNumber(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => safeMicrosToNumber(-1n),
    err => err instanceof OpenAiValidationError && err.code === 'COST_OVERFLOW_UNSAFE_INTEGER',
  );
  assert.throws(
    () => safeMicrosToNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    err => err instanceof OpenAiValidationError && err.code === 'COST_OVERFLOW_UNSAFE_INTEGER',
  );
  assert.throws(
    () => computeUsageCostMicros({
      model: 'gpt-6-astra',
      serviceTier: 'fast',
      usage: { input_tokens: 1_000, output_tokens: Number.MAX_SAFE_INTEGER },
      webSearchCalls: Number.MAX_SAFE_INTEGER,
      allowAstraApi: true,
    }),
    err => err instanceof OpenAiValidationError && err.code === 'COST_OVERFLOW_UNSAFE_INTEGER',
  );
  assert.throws(
    () => estimateCostBreakdown({
      endpoint: '/v1/responses',
      model: 'gpt-6-astra',
      serviceTier: 'fast',
      estimatedInputTokens: 1_000,
      maxOutputTokens: Number.MAX_SAFE_INTEGER,
      maxWebSearchCalls: Number.MAX_SAFE_INTEGER,
      allowAstraApi: true,
    }),
    err => err instanceof OpenAiValidationError && err.code === 'COST_OVERFLOW_UNSAFE_INTEGER',
  );

  // Inconsistent usage rejections
  assert.throws(
    () => computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      usage: { input_tokens: 100, output_tokens: 50, output_tokens_details: { reasoning_tokens: 51 } },
    }),
    OpenAiValidationError,
  );
  assert.throws(
    () => computeUsageCostMicros({
      model: 'gpt-6.1-terra',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 30 }, output_tokens: 50 },
    }),
    OpenAiValidationError,
  );
  assert.throws(
    () => computeUsageCostMicros({ model: 'gpt-6.1-terra', usage: {} }),
    OpenAiValidationError,
  );
});

test('pricing.mjs & client.mjs: gpt-6.2-astra and gpt-6-astra are hard-blocked by default with OpenAiPolicyError', async () => {
  for (const astraModel of ['gpt-6.2-astra', 'gpt-6-astra', 'gpt-6.2-astra-2026-11-01']) {
    assert.throws(
      () => estimateReservationCents({
        endpoint: '/v1/responses',
        model: astraModel,
        estimatedInputTokens: 1_000,
        maxOutputTokens: 4_096,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'ASTRA_API_BLOCKED' && err.not_dispatched === true,
    );
  }

  // Explicit override permits estimation:
  // Omitted serviceTier reserves at 2x ('fast'): (100_000 + 200_000) * 2 = 600_000 micros = 60c;
  // explicit serviceTier: 'standard' reserves at 1x = 300_000 micros = 30c
  assert.equal(
    estimateReservationCents({
      endpoint: '/v1/responses',
      model: 'gpt-6.2-astra',
      estimatedInputTokens: 10_000,
      maxOutputTokens: 5_000,
      allowAstraApi: true,
    }),
    60,
  );
  assert.equal(
    estimateReservationCents({
      endpoint: '/v1/responses',
      model: 'gpt-6.2-astra',
      serviceTier: 'standard',
      estimatedInputTokens: 10_000,
      maxOutputTokens: 5_000,
      allowAstraApi: true,
    }),
    30,
  );
  assert.equal(
    estimateReservationCents({
      endpoint: '/v1/responses',
      model: 'gpt-6.2-astra',
      serviceTier: 'standard',
      estimatedInputTokens: 10_000,
      maxOutputTokens: 5_000,
      allowAstraApi: true,
      cacheWritePossible: false,
    }),
    28,
  );

  // Client blocks Astra BEFORE touching network or reserving budget
  const ledger = createActivatedMemoryLedger();
  let fetchCount = 0;
  const client = new OpenAiClient({
    ledger,
    allowEnvKey: true,
    apiKeyEnvVar: 'MOCK_OPENAI_KEY',
    env: { MOCK_OPENAI_KEY: SYNTHETIC_API_KEY },
    fetchImpl: async () => {
      fetchCount++;
      throw new Error('Should not be called');
    },
  });

  await assert.rejects(
    () => client.createResponse({ model: 'gpt-6.2-astra', input: 'Audit this packet.' }),
    err => err instanceof OpenAiPolicyError && err.code === 'ASTRA_API_BLOCKED',
  );
  assert.equal(fetchCount, 0);
  assert.equal(ledger.getStatus({ monthUtc: '2026-11' }).total_requests, 0);
  ledger.close();
});

// -----------------------------------------------------------------------------
// 2. Legacy SQLite Inspection, Coherent WAL Snapshot (P0-12), Collision Guard (P0-11),
//    Strict Row/Schema Validation (P0-09/P0-10), Timezone Month (P0-08), & $200 Ceiling (P0-06)
// -----------------------------------------------------------------------------

test('budget-ledger.mjs: strictly read-only inspection (immutable + private WAL snapshot), collision guards, strict legacy rules, and fail-closed revocation', async () => {
  await withTempDirAsync(async dir => {
    // Missing path never creates directories or empty SQLite files
    const missingDir = join(dir, 'nested-missing');
    const missingDb = join(missingDir, 'budget.sqlite3');
    assert.throws(
      () => inspectLegacyAutopilotBudget(missingDb, { monthUtc: '2026-11' }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_DB_UNREADABLE',
    );
    assert.equal(existsSync(missingDir), false);

    // P0-09: Empty SQLite file or non-monetary table fails closed with UNRECOGNIZED_LEGACY_BUDGET_SCHEMA
    const emptyDbPath = join(dir, 'empty-unrelated.sqlite3');
    const emptyDb = new DatabaseSync(emptyDbPath);
    emptyDb.exec('CREATE TABLE ledger_attempts (attempt_id TEXT PRIMARY KEY, status TEXT, cost_units INTEGER);');
    emptyDb.close();
    assert.throws(
      () => inspectLegacyAutopilotBudget(emptyDbPath, { monthUtc: '2026-11' }),
      err => err instanceof OpenAiBudgetError && err.code === 'UNRECOGNIZED_LEGACY_BUDGET_SCHEMA' && err.not_dispatched === true,
    );

    // 1) Clean quiescent legacy fixture (including timezone-offset timestamp '2026-11-01T00:30:00+02:00' -> '2026-10'!)
    const subDir = join(dir, 'legacy autopilot dir');
    mkdirSync(subDir, { recursive: true });
    const cleanLegacyPath = join(subDir, 'budget.sqlite3');

    const setupClean = new DatabaseSync(cleanLegacyPath);
    try {
      setupClean.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE reservations (
          request_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          reserved_cents INTEGER NOT NULL,
          confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE operation_locks (
          lock_name TEXT PRIMARY KEY,
          is_locked INTEGER NOT NULL,
          released_at TEXT
        );
      `);
      const ins = setupClean.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)');
      // '2026-11-01T00:30:00+02:00' is '2026-10-31T22:30:00Z' -> MUST map to '2026-10', NOT '2026-11'!
      ins.run('leg-oct-tz', 'completed', 45, 0, '2026-11-01T00:30:00+02:00');
      ins.run('leg-nov-1', 'completed', 120, 0, '2026-11-04T09:00:00Z');
      ins.run('leg-nov-2', 'settled', 80, 0, '2026-11-12 14:30:00');
      ins.run('leg-nov-3', 'released', 30, 1, '2026-11-13T08:00:00Z');
      setupClean.prepare('INSERT INTO operation_locks VALUES (?, ?, ?)').run('global', 0, '2026-11-12T14:31:00Z');
    } finally {
      setupClean.close();
    }

    assert.equal(extractMonthPrefix('2026-11-01T00:30:00+02:00'), '2026-10');
    assert.equal(extractMonthPrefix('2026-10-31T23:30:00-02:00'), '2026-11');
    assert.equal(extractMonthPrefix('2026-11-01 00:30:00'), '2026-11');
    assert.equal(extractMonthPrefix('2026-02-31'), null);

    const filesBefore = readdirSync(subDir).sort();
    const bytesBefore = readFileSync(cleanLegacyPath);
    const shaBefore = sha256Hex(bytesBefore);

    const summary = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-11' });

    const filesAfter = readdirSync(subDir).sort();
    const bytesAfter = readFileSync(cleanLegacyPath);
    const shaAfter = sha256Hex(bytesAfter);

    assert.equal(shaAfter, shaBefore);
    assert.equal(Buffer.compare(bytesBefore, bytesAfter), 0);
    assert.deepEqual(filesAfter, filesBefore);
    assert.equal(summary.recognized_schema, true);
    assert.equal(summary.file_sha256, shaBefore);
    assert.equal(summary.total_rows, 4);
    assert.equal(summary.unresolved_count, 0);
    assert.equal(summary.has_unresolved_holds, false);
    assert.equal(summary.safe_to_reconcile, true);
    assert.equal(summary.same_month_reserved_cents, 200); // 120 + 80 (Oct +02:00 and confirmed-zero released excluded)

    // P0-11: Physical file-identity collision guard catches direct path, hard links, AND NTFS junctions BEFORE opening writable store!
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(cleanLegacyPath, cleanLegacyPath, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );
    assert.equal(sha256Hex(readFileSync(cleanLegacyPath)), shaBefore);

    const hardlinkPath = join(dir, 'hardlinked-legacy.sqlite3');
    linkSync(cleanLegacyPath, hardlinkPath);
    assert.equal(areSamePhysicalSqliteFile(cleanLegacyPath, hardlinkPath), true);
    // P0-12: Hard-linked legacy file (nlink > 1) is forbidden on inspection so WAL sidecars can never be hidden!
    assert.throws(
      () => inspectLegacyAutopilotBudget(hardlinkPath, { monthUtc: '2026-11' }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_HARDLINK_ALIAS_FORBIDDEN',
    );
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(hardlinkPath, summary, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );
    rmSync(hardlinkPath, { force: true });
    assert.equal(sha256Hex(readFileSync(cleanLegacyPath)), shaBefore);

    const junctionDir = join(dir, 'junction-alias');
    symlinkSync(subDir, junctionDir, process.platform === 'win32' ? 'junction' : 'dir');
    const junctionDbPath = join(junctionDir, 'budget.sqlite3');
    assert.equal(areSamePhysicalSqliteFile(cleanLegacyPath, junctionDbPath), true);
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(junctionDbPath, cleanLegacyPath),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );

    // P0-12: Live active WAL sidecar inspection via private temp snapshot (reads uncheckpointed WAL frames, creates ZERO -shm in source dir!)
    const liveWalDir = join(dir, 'live-wal-dir');
    mkdirSync(liveWalDir, { recursive: true });
    const liveWalDbPath = join(liveWalDir, 'live.sqlite3');
    const writerConn = new DatabaseSync(liveWalDbPath);
    try {
      writerConn.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY,
          cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL
        );
      `);
      writerConn.prepare('INSERT INTO requests VALUES (?, ?, ?, ?)').run(
        'uncheckpointed-wal-row-1',
        333,
        'complete',
        '2026-11-18T10:00:00Z',
      );
      assert.equal(existsSync(`${liveWalDbPath}-wal`), true);
      const mainBytesBefore = readFileSync(liveWalDbPath);
      const walBytesBefore = readFileSync(`${liveWalDbPath}-wal`);

      const walSummary = inspectLegacyAutopilotBudget(liveWalDbPath, { monthUtc: '2026-11' });
      assert.equal(walSummary.wal_present, true);
      assert.equal(walSummary.total_rows, 1);
      assert.equal(walSummary.same_month_reserved_cents, 333);
      assert.equal(Buffer.compare(readFileSync(liveWalDbPath), mainBytesBefore), 0);
      assert.equal(Buffer.compare(readFileSync(`${liveWalDbPath}-wal`), walBytesBefore), 0);
    } finally {
      writerConn.close();
    }

    // Reconcile into shared SelectionStore SQLite database & verify P0-06 + P0-08 per-month carryover isolation!
    const sharedDbPath = join(dir, 'selection.sqlite');
    const selStore = openSelectionStore(sharedDbPath);
    selStore.close();
    const selShaBeforeRo = sha256Hex(readFileSync(sharedDbPath));

    const roLedgerBeforeInit = new OpenAiBudgetLedger(sharedDbPath, { readOnly: true });
    const preStatus = roLedgerBeforeInit.getStatus({ monthUtc: '2026-11' });
    roLedgerBeforeInit.close();
    assert.equal(preStatus.schema_initialized, false);
    assert.equal(preStatus.policy.enabled, false);
    assert.equal(sha256Hex(readFileSync(sharedDbPath)), selShaBeforeRo);

    // P0-06: Enabling WITHOUT autoRechargeOffConfirmed & hardMonthlyLimitConfirmed is blocked!
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(sharedDbPath, summary, {
        accountScope: 'openai-default',
        enable: true,
        monthlyLimitCents: 250,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'PLATFORM_BILLING_CONTROLS_UNVERIFIED',
    );

    // P0-06: monthlyLimitCents > 20000 ($200 ceiling) is blocked!
    assert.equal(MAX_MONTHLY_LIMIT_CENTS, 20_000);
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(sharedDbPath, summary, {
        accountScope: 'openai-default',
        enable: true,
        monthlyLimitCents: 20_001,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'MONTHLY_LIMIT_EXCEEDS_CEILING',
    );

    const reconciledPolicy = reconcileLegacyBudgetIntoStore(sharedDbPath, summary, {
      accountScope: 'openai-default',
      enable: true,
      monthlyLimitCents: 250,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    });
    assert.equal(reconciledPolicy.enabled, true);
    assert.equal(reconciledPolicy.auto_recharge_off_confirmed, true);
    assert.equal(reconciledPolicy.hard_monthly_limit_confirmed, true);
    assert.equal(reconciledPolicy.legacy_reconciled, true);

    // P0-08: Reconciling October ('2026-10', 45c) NEVER displaces November ('2026-11', 200c) carryover!
    const octSummary = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-10' });
    assert.equal(octSummary.same_month_reserved_cents, 45);
    reconcileLegacyBudgetIntoStore(sharedDbPath, octSummary, {
      accountScope: 'openai-default',
    });

    const writableLedger = new OpenAiBudgetLedger(sharedDbPath, {
      testMode: true,
      canonicalRegistryPath: join(dir, 'shared-registry.sqlite'),
      nowFn: () => new Date('2026-11-21T12:00:00Z'),
    });
    try {
      const novSummary = writableLedger.getMonthlySummary({ monthUtc: '2026-11' });
      const octMonthly = writableLedger.getMonthlySummary({ monthUtc: '2026-10' });
      assert.equal(novSummary.legacy_carryover_cents, 200);
      assert.equal(novSummary.remaining_cents, 50);
      assert.equal(octMonthly.legacy_carryover_cents, 45);

      assert.throws(
        () => writableLedger.reserveBillableRequest({
          logicalRequestId: 'over-limit-req',
          endpoint: '/v1/responses',
          model: 'gpt-6.1-terra',
          payloadSha256: 'a'.repeat(64),
          reservedCents: 51,
        }),
        err => err instanceof OpenAiBudgetError && err.code === 'MONTHLY_BUDGET_EXCEEDED',
      );
    } finally {
      writableLedger.close();
    }

    // P0-09 & P0-10: Strict cancelled/failed >0 without zero-charge confirmation + fail-closed revocation of ALREADY-enabled policy!
    const cancelledPositivePath = join(dir, 'cancelled-positive.sqlite3');
    const setupCancelled = new DatabaseSync(cancelledPositivePath);
    try {
      setupCancelled.exec(`
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY,
          cents INTEGER,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL
        );
      `);
      setupCancelled.prepare('INSERT INTO requests VALUES (?, ?, ?, ?)').run(
        'canc-no-zero-proof',
        50,
        'cancelled',
        '2026-11-10T00:00:00Z',
      );
      setupCancelled.prepare('INSERT INTO requests VALUES (?, ?, ?, ?)').run(
        'comp-null-cents',
        null,
        'complete',
        '2026-11-10T01:00:00Z',
      );
    } finally {
      setupCancelled.close();
    }

    const dirtySummary = inspectLegacyAutopilotBudget(cancelledPositivePath, { monthUtc: '2026-11' });
    assert.equal(dirtySummary.has_unresolved_holds, true);
    assert.equal(dirtySummary.unresolved_count, 2);

    // Calling reconcileLegacyBudgetIntoStore with dirtySummary on ALREADY-enabled sharedDbPath MUST revoke enabled=0 & legacy_reconciled=0!
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(sharedDbPath, dirtySummary, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_UNRESOLVED_HOLD',
    );

    const revokedCheck = new OpenAiBudgetLedger(sharedDbPath, { readOnly: true });
    try {
      const polAfterDirty = revokedCheck.getPolicy('openai-default');
      assert.equal(polAfterDirty.enabled, false);
      assert.equal(polAfterDirty.legacy_reconciled, false);
    } finally {
      revokedCheck.close();
    }
  });
});

// -----------------------------------------------------------------------------
// 3. Cross-Month Fence, Clock Lock (P0-08), Credential Binding (P0-07), Outer-Tx Guard (P2-10),
//    Selector Disambiguation (P2-03), Schema Migration, & Settlement Evidence (P0-13)
// -----------------------------------------------------------------------------

test('budget-ledger.mjs: cross-month fencing, UTC clock lock, credential binding, outer-tx rejection, and strict settlement invariants', async () => {
  let currentClock = new Date('2026-10-15T12:00:00Z');
  const ledger = createActivatedMemoryLedger({
    monthUtc: '2026-10',
    monthlyLimitCents: 20_000,
    nowFn: () => currentClock,
  });

  try {
    assert.throws(
      () => ledger.configurePolicy({
        accountScope: 'second-scope',
        enabled: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_NOT_RECONCILED',
    );

    // P0-08: Spoofing monthUtc to '2026-12' while clock is '2026-10' is blocked unless allowTestClockOverride: true
    assert.throws(
      () => ledger.reserveBillableRequest({
        logicalRequestId: 'spoof-month-req',
        monthUtc: '2026-12',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: '9'.repeat(64),
        reservedCents: 5,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'MONTH_CLOCK_OVERRIDE_FORBIDDEN',
    );

    // P0-22: recordNotSubmitted validates serviceTier with assertSafeShortLabel
    assert.throws(
      () => ledger.recordNotSubmitted({
        logicalRequestId: 'bad-tier-req',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        serviceTier: 'invalid tier with spaces!',
        payloadSha256: '8'.repeat(64),
      }),
      OpenAiValidationError,
    );

    const octAttempt = ledger.reserveBillableRequest({
      logicalRequestId: 'oct-ambiguous-1',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: '1'.repeat(64),
      reservedCents: 42,
    });
    assert.equal(octAttempt.status, 'in_progress');
    assert.equal(octAttempt.month_utc, '2026-10');

    // P2-03: Cross-column collision between attempt_id and logical_request_id is forbidden
    assert.throws(
      () => ledger.reserveBillableRequest({
        attemptId: 'oct-ambiguous-1',
        logicalRequestId: 'brand-new-logical',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: '7'.repeat(64),
        reservedCents: 5,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'ATTEMPT_LOGICAL_ID_COLLISION',
    );
    assert.throws(
      () => ledger.getAttemptById(octAttempt.attempt_id, { accountScope: 'other-scope' }),
      err => err instanceof OpenAiBudgetError && err.code === 'ATTEMPT_SCOPE_MISMATCH',
    );

    // P0-04 / P0-13: Immutable provider_response_id
    ledger.recordProviderResponseId(octAttempt.attempt_id, 'resp_oct_001');
    assert.throws(
      () => ledger.recordProviderResponseId(octAttempt.attempt_id, 'resp_oct_DIFFERENT'),
      err => err instanceof OpenAiBudgetError && err.code === 'PROVIDER_RESPONSE_ID_IMMUTABLE',
    );

    // Transition October attempt to pending_recovery
    const pendingOct = ledger.markPendingRecovery(octAttempt.attempt_id, {
      reason: 'Gateway timeout in October.',
    });
    assert.equal(pendingOct.status, 'pending_recovery');
    assert.equal(pendingOct.usage_cost_micros, null);

    // Advance clock to November 2026: prior-month pending_recovery fences November calls!
    currentClock = new Date('2026-11-02T00:05:00Z');
    const novSummaryFenced = ledger.getMonthlySummary({ monthUtc: '2026-11' });
    assert.equal(novSummaryFenced.fenced, true);
    assert.equal(novSummaryFenced.prior_months_unresolved_reserved_cents, 42);

    assert.throws(
      () => ledger.reserveBillableRequest({
        logicalRequestId: 'nov-blocked-req',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: '3'.repeat(64),
        reservedCents: 10,
      }),
      err => err instanceof OpenAiBudgetError &&
        err.code === 'ACCOUNT_FENCED_PENDING_RECOVERY' &&
        err.blocking_month_utc === '2026-10',
    );

    // P0-13: postedBilledCents: 0 alone (without usageCostMicros or confirmedZeroCharge: true) is REJECTED!
    assert.throws(
      () => ledger.reconcileAttempt(octAttempt.attempt_id, {
        status: 'failed_known',
        postedBilledCents: 0,
        note: 'Invoice shows $0 due to promo credit, but usage is unknown!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'MISSING_RECONCILIATION_CHARGE_EVIDENCE',
    );
    assert.throws(
      () => ledger.reconcileAttempt(octAttempt.attempt_id, {
        status: 'completed',
        postedBilledCents: 0,
        note: 'Trying to mark completed with $0 posted and null usage!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'MISSING_RECONCILIATION_CHARGE_EVIDENCE',
    );

    // Reconcile with explicit confirmedZeroCharge: true -> lifts fence cleanly
    const settledOct = ledger.reconcileAttempt(octAttempt.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Verified OpenAI dashboard billing log for 2026-10: 0 requests billed.',
    });
    assert.equal(settledOct.status, 'failed_known');
    assert.equal(settledOct.usage_cost_micros, 0);

    // P0-13: Cannot overwrite non-null usage_cost_micros with null
    assert.throws(
      () => ledger.reconcileAttempt(octAttempt.attempt_id, {
        usageCostMicros: null,
        note: 'Attempt to erase recorded usage_cost_micros.',
      }),
      OpenAiValidationError,
    );

    // P0-07: Credential-to-scope and live-ledger binding
    const fpA = sha256Hex('cred-alpha');
    const fpB = sha256Hex('cred-beta');
    ledger.bindCredentialFingerprint('openai-default', fpA, { isLiveTransport: false });
    assert.equal(ledger.getPolicy('openai-default').credential_fingerprint_sha256, fpA);
    assert.throws(
      () => ledger.bindCredentialFingerprint('second-scope', fpA, { isLiveTransport: false }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_SCOPE_SPLIT_FORBIDDEN',
    );
    assert.throws(
      () => ledger.bindCredentialFingerprint('openai-default', fpB, { isLiveTransport: false }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_SCOPE_MISMATCH',
    );
    assert.throws(
      () => ledger.bindCredentialFingerprint('openai-default', fpA, { isLiveTransport: true }),
      err => err instanceof OpenAiPolicyError && err.code === 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE',
    );

    // P2-10: External SQLite transaction around ledger construction or mutation is forbidden
    const rawMemDb = new DatabaseSync(':memory:');
    try {
      rawMemDb.exec('BEGIN');
      assert.throws(
        () => new OpenAiBudgetLedger(rawMemDb),
        err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_OUTER_TRANSACTION_FORBIDDEN',
      );
      rawMemDb.exec('ROLLBACK');

      const borrowedLedger = new OpenAiBudgetLedger(rawMemDb);
      rawMemDb.exec('BEGIN');
      assert.throws(
        () => borrowedLedger.configurePolicy({ monthlyLimitCents: 1000 }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_OUTER_TRANSACTION_FORBIDDEN',
      );
      rawMemDb.exec('ROLLBACK');
    } finally {
      rawMemDb.close();
    }

    // Live file-backed credential split across two ledger files is blocked across instances via persistent SQLite registry (CREDENTIAL_LEDGER_SPLIT_FORBIDDEN)
    await withTempDirAsync(async dir => {
      const regPath = join(dir, 'canonical-registry.sqlite');
      const db1 = join(dir, 'live1.sqlite');
      const db2 = join(dir, 'live2.sqlite');
      const liveFp = sha256Hex(`live-cred-${randomUUID()}`);
      const l1 = new OpenAiBudgetLedger(db1, { testMode: true, canonicalRegistryPath: regPath });
      const l2 = new OpenAiBudgetLedger(db2, { testMode: true, canonicalRegistryPath: regPath });
      try {
        l1.bindCredentialFingerprint('openai-default', liveFp, { isLiveTransport: true });
        assert.throws(
          () => l2.bindCredentialFingerprint('openai-default', liveFp, { isLiveTransport: true }),
          err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_LEDGER_SPLIT_FORBIDDEN',
        );
      } finally {
        l1.close();
        l2.close();
      }
    });
  } finally {
    ledger.close();
  }
});

// -----------------------------------------------------------------------------
// 4. POST /v1/decisions (gpt-6-luna): Cumulative 256KiB Cap (P2-06) & Strict ID Matching (P1-12)
// -----------------------------------------------------------------------------

test('client.mjs: createDecision enforces cumulative <=256KiB input_json, strict non-positional ID matching, and usable=false on all-refusal', async () => {
  const ledger = createActivatedMemoryLedger();
  let fetchCalls = 0;
  let mockDecisionPayload = null;

  try {
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        fetchCalls++;
        assert.equal(url, 'https://api.openai.com/v1/decisions');
        assert.equal(init.redirect, 'error');
        return makeJsonFetchResponse(200, mockDecisionPayload);
      },
    });

    // P2-06: Cumulative input_json across two 140 KiB blocks (280 KiB > 256 KiB) rejected locally!
    await assert.rejects(
      () => client.createDecision({
        input: [
          { type: 'input_json', json: { part1: 'a'.repeat(145_000) } },
          { type: 'input_json', json: { part2: 'b'.repeat(145_000) } },
        ],
        questions: [{ id: 'q1', type: 'predicate', question: 'Valid?' }],
      }),
      err => err instanceof OpenAiValidationError && err.code === 'INPUT_JSON_TOO_LARGE',
    );

    // P0-15: Reject remote HTTP image_url on /v1/decisions
    await assert.rejects(
      () => client.createDecision({
        input: [{ type: 'input_image', image_url: 'https://example.com/remote.png' }],
        questions: [{ id: 'q1', type: 'predicate', question: 'Valid?' }],
      }),
      err => err instanceof OpenAiValidationError && err.code === 'REMOTE_IMAGE_URL_FORBIDDEN',
    );
    assert.equal(fetchCalls, 0);

    // P1-12: Out-of-order answers matched strictly by explicit ID (never positionally!)
    mockDecisionPayload = {
      id: 'dec_001',
      model: 'gpt-6-luna-2026-11-01',
      decisions: [
        { id: 'q_ambiguous', type: 'refusal', refusal: 'Occluded contact-sheet tile cannot be classified.' },
        { id: 'q_cluster', type: 'choice', value: 'exact_peer' },
        { id: 'q_prohibited', type: 'predicate', value: false },
      ],
      usage: {
        input_tokens: 2_000,
        input_tokens_details: { cached_tokens: 1_000, cache_write_tokens: 0 },
        output_tokens: 120,
      },
    };

    const result = await client.createDecision({
      logical_request_id: 'stage1-dec-batch-1',
      prompt_cache_key: 'stage1-triage-v1',
      prompt_cache_options: { ttl: '30m' },
      input: [
        { type: 'input_text', text: 'Classify tile #01.' },
        { type: 'input_image', image_url: `data:image/png;base64,${VALID_1X1_PNG_B64}`, detail: 'high' },
        { type: 'input_json', json: { candidate_id: 'cand-01', price_usd: 44.99 } },
      ],
      questions: [
        { id: 'q_prohibited', type: 'predicate', question: 'Is children or medical?' },
        { id: 'q_cluster', type: 'choice', question: 'Visual cluster?', options: ['exact_peer', 'unclear_needs_zoom'] },
        { id: 'q_ambiguous', type: 'score', question: 'Confidence 0..1?', min: 0, max: 1 },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.usable, true);
    assert.equal(result.refusal_count, 1);
    assert.equal(result.by_question_id.q_prohibited.value, false);
    assert.equal(result.by_question_id.q_cluster.value, 'exact_peer');
    assert.equal(result.by_question_id.q_ambiguous.type, 'refusal');
    assert.equal(Object.getPrototypeOf(result.by_question_id), null);
    assert.equal(result.usage_cost_micros, 170);

    // P1-12: Foreign / missing-ID answer marks content_status='invalid' & usable=false!
    mockDecisionPayload = {
      id: 'dec_002',
      model: 'gpt-6-luna',
      decisions: [{ type: 'predicate', value: false }], // missing explicit id!
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    const noIdRes = await client.createDecision({
      logical_request_id: 'stage1-dec-noid',
      input: 'Check candidate.',
      questions: [{ id: 'q_only', type: 'predicate', question: 'Is prohibited?' }],
    });
    assert.equal(noIdRes.usable, false);
    assert.equal(noIdRes.ok, false);
    assert.equal(noIdRes.content_status, 'invalid');

    // P1-12: All-refusal marks content_status='refused' & usable=false!
    mockDecisionPayload = {
      id: 'dec_003',
      model: 'gpt-6-luna',
      decisions: [{ id: 'q_only', type: 'refusal', refusal: 'Refused' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    };
    const allRefusedRes = await client.createDecision({
      logical_request_id: 'stage1-dec-allrefused',
      input: 'Check candidate.',
      questions: [{ id: 'q_only', type: 'predicate', question: 'Is prohibited?' }],
    });
    assert.equal(allRefusedRes.content_status, 'refused');
    assert.equal(allRefusedRes.usable, false);
    assert.equal(allRefusedRes.ok, false);
  } finally {
    ledger.close();
  }
});

// -----------------------------------------------------------------------------
// 5. POST /v1/responses: Tool Allowlist (P0-16), Input Bounds (P0-15), Model/Status Validation (P1-01),
//    and Crash-Safe Cleanup Fencing (P0-05)
// -----------------------------------------------------------------------------

test('client.mjs: Terra xhigh guards, web_search allowlist, model/empty-output checks, and crash-safe pending_recovery cleanup lifecycle', async () => {
  await withTempDirAsync(async dir => {
    const credPath = join(dir, 'openai-cred.json');
    writeFileSync(credPath, JSON.stringify({ api_key: SYNTHETIC_API_KEY }), 'utf8');
    assert.equal(loadOpenAiApiKey({ credentialFile: credPath }), SYNTHETIC_API_KEY);

    // P0-15: Conservative 1-token-per-UTF8-byte + 8192 image + 16384 web_search triggers >272K long-context!
    const largeText = 'x'.repeat(230_000);
    const estTokens = estimateResponsesInputTokens(
      {
        model: 'gpt-6.1-terra',
        input: [
          { type: 'input_text', text: largeText },
          { type: 'input_image', image_url: `data:image/png;base64,${VALID_1X1_PNG_B64}`, detail: 'high' },
        ],
        tools: [{ type: 'web_search' }],
        max_tool_calls: 3,
      },
      3,
    );
    assert.ok(estTokens > 272_000);

    const ledger = createActivatedMemoryLedger();
    const callLog = [];

    try {
      const client = new OpenAiClient({
        ledger,
        credentialFile: credPath,
        fetchImpl: async (url, init) => {
          assert.equal(init.redirect, 'error');
          callLog.push({ method: init.method, url });

          if (init.method === 'POST' && url.endsWith('/v1/responses')) {
            const wire = JSON.parse(init.body);
            if (wire.input === 'TRIGGER_REFUSAL') {
              return makeJsonFetchResponse(200, {
                id: 'resp_refused_1',
                status: 'completed',
                model: 'gpt-6.1-terra',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'refusal', refusal: 'Cannot verify illegible spec label.' }],
                  },
                ],
                usage: { input_tokens: 1_000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 450 } },
              });
            }
            if (wire.input === 'TRIGGER_MODEL_SWAP') {
              return makeJsonFetchResponse(200, {
                id: 'resp_swap_1',
                status: 'completed',
                model: 'gpt-6-luna',
                output: [{ type: 'message', content: [{ type: 'output_text', text: '{"verdict":"exact_match"}' }] }],
                usage: { input_tokens: 1_000, output_tokens: 500 },
              });
            }
            if (wire.input === 'TRIGGER_EMPTY_OUTPUT') {
              return makeJsonFetchResponse(200, {
                id: 'resp_empty_1',
                status: 'completed',
                model: 'gpt-6.1-terra',
                output: [],
                usage: { input_tokens: 1_000, output_tokens: 500 },
              });
            }
            if (wire.input === 'TRIGGER_BARE_DELETE_404') {
              return makeJsonFetchResponse(200, {
                id: 'resp_bare_404',
                status: 'completed',
                model: 'gpt-6.1-terra',
                output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
                usage: { input_tokens: 1_000, output_tokens: 500 },
              });
            }

            return makeJsonFetchResponse(200, {
              id: 'resp_clean_del_1',
              status: 'completed',
              model: 'gpt-6.1-terra',
              output: [
                { type: 'web_search_call', id: 'ws_1', status: 'completed' },
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: '{"verdict":"exact_match"}' }],
                },
              ],
              usage: {
                input_tokens: 4_000,
                output_tokens: 2_000,
                output_tokens_details: { reasoning_tokens: 1_800 },
              },
            });
          }

          if (init.method === 'DELETE' && url.endsWith('/v1/responses/resp_bare_404')) {
            // Initial bare DELETE 404 without prior DELETE 200 ack MUST NOT satisfy cleanup!
            return makeJsonFetchResponse(404, { error: { message: 'Not found' } });
          }

          if (init.method === 'DELETE' && url.endsWith('/v1/responses/resp_clean_del_1')) {
            // P0-05: While DELETE is in flight, SQLite row MUST STILL be 'pending_recovery' (fenced!)
            // with terminal_outcome_status='completed', raw_receipt_json, and usage_cost_micros persisted!
            const savedBeforeDelete = ledger.getAttempt('req-clean-with-delete');
            assert.equal(savedBeforeDelete.status, 'pending_recovery');
            assert.equal(savedBeforeDelete.terminal_outcome_status, 'completed');
            assert.equal(savedBeforeDelete.cleanup_required, true);
            assert.equal(savedBeforeDelete.cleanup_status, 'pending_cleanup');
            assert.ok(savedBeforeDelete.raw_receipt_json !== null);
            assert.equal(savedBeforeDelete.usage_cost_micros, 24_000);
            return makeJsonFetchResponse(200, { id: 'resp_clean_del_1', deleted: true });
          }

          if (init.method === 'GET' && url.endsWith('/v1/responses/resp_clean_del_1')) {
            // After DELETE 200 ack, delete_ack_at is persisted while status is STILL pending_recovery until 404 readback!
            const savedBeforeGet = ledger.getAttempt('req-clean-with-delete');
            assert.equal(savedBeforeGet.status, 'pending_recovery');
            assert.ok(savedBeforeGet.delete_ack_at !== null);
            return makeJsonFetchResponse(404, { error: { message: 'Response not found' } });
          }

          throw new Error(`Unexpected mock call: ${init.method} ${url}`);
        },
      });

      // Reject non-allowlisted tools and invalid explicit caps.
      for (const badTools of [
        { tools: [{ type: 'code_interpreter' }] },
        { tools: [{ type: 'file_search' }] },
        { tools: [{ type: 'image_generation' }] },
        { tools: [{ type: 'mcp' }] },
        { tools: [{ type: 'web_search' }], max_tool_calls: 0 },
      ]) {
        await assert.rejects(
          () => client.createResponse({ input: 'Test tools', ...badTools }),
          OpenAiValidationError,
        );
      }

      // P0-15: Reject unbounded previous_response_id / file_id / remote image_url
      await assert.rejects(
        () => client.createResponse({ input: 'Follow up', previous_response_id: 'resp_old_1' }),
        err => err instanceof OpenAiValidationError && err.code === 'UNBOUNDED_CONTEXT_REF_FORBIDDEN',
      );

      // P0-05: Direct deleteResponse without bound attemptId or with verify404Readback: false is blocked!
      await assert.rejects(
        () => client.deleteResponse('resp_clean_del_1'),
        err => err instanceof OpenAiPolicyError && err.code === 'DELETE_BOUND_ATTEMPT_REQUIRED',
      );
      await assert.rejects(
        () => client.deleteResponse('resp_clean_del_1', { attemptId: 'any', verify404Readback: false }),
        err => err instanceof OpenAiPolicyError && err.code === 'UNVERIFIED_DELETE_FORBIDDEN',
      );
      assert.equal(callLog.length, 0);

      // P1-01: Model swap & empty output marked content_status='invalid', usable=false
      const swappedRes = await client.createResponse({ logical_request_id: 'req-swap', input: 'TRIGGER_MODEL_SWAP' });
      assert.equal(swappedRes.usable, false);
      assert.equal(swappedRes.content_status, 'invalid');

      const emptyRes = await client.createResponse({ logical_request_id: 'req-empty', input: 'TRIGGER_EMPTY_OUTPUT' });
      assert.equal(emptyRes.usable, false);
      assert.equal(emptyRes.content_status, 'invalid');

      // Refusal surfaced cleanly
      const refusedRes = await client.createResponse({ logical_request_id: 'req-refused', input: 'TRIGGER_REFUSAL' });
      assert.equal(refusedRes.usable, false);
      assert.equal(refusedRes.content_status, 'refused');

      // Clean response + deleteAfterPersist: pending_recovery during DELETE -> completed ONLY after DELETE 200 + GET 404!
      const cleanRes = await client.createResponse(
        {
          logical_request_id: 'req-clean-with-delete',
          input: 'Verify peer spec.',
          tools: [{ type: 'web_search' }],
          max_tool_calls: 2,
        },
        { deleteAfterPersist: true },
      );
      assert.equal(cleanRes.ok, true);
      assert.equal(cleanRes.usable, true);
      assert.equal(cleanRes.status, 'completed');
      assert.equal(cleanRes.cleanup.status, 'deleted_verified_404');
      assert.equal(cleanRes.cleanup.verified_404, true);
      assert.equal(ledger.getAttempt('req-clean-with-delete').status, 'completed');

      // Bare initial DELETE 404 keeps attempt fenced in pending_recovery!
      const bare404Res = await client.createResponse(
        { logical_request_id: 'req-bare-del-404', input: 'TRIGGER_BARE_DELETE_404' },
        { deleteAfterPersist: true },
      );
      assert.equal(bare404Res.ok, false);
      assert.equal(bare404Res.status, 'pending_recovery');
      assert.equal(bare404Res.cleanup.status, 'delete_failed');
      assert.equal(ledger.getMonthlySummary({ monthUtc: '2026-11' }).fenced, true);
    } finally {
      ledger.close();
    }
  });
});

// -----------------------------------------------------------------------------
// 6. Timeout/409 Fencing (P0-20), Corrupt JSON Raw Body Persistence (P0-24),
//    Bounded Stream Ceiling (P0-22), Origin Lock (P0-18), Pre-Aborted Signal (P2-01), & Recovery (P0-03/04)
// -----------------------------------------------------------------------------

test('client.mjs: origin lock, boolean validation, pre-aborted signal, bounded streams, corrupt JSON rawBody persistence, and strict recovery', async () => {
  const ledger = createActivatedMemoryLedger();
  const networkCalls = [];

  try {
    let mode = 'corrupt_200_json_with_secret';
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_CUSTOM_SECRET },
      fetchImpl: async (url, init) => {
        networkCalls.push({ method: init.method, url });
        if (mode === 'corrupt_200_json_with_secret') {
          return makeJsonFetchResponse(200, `<<<CORRUPT_BODY key=${SYNTHETIC_CUSTOM_SECRET}>>>`);
        }
        if (mode === 'oversized_stream') {
          let chunksSent = 0;
          const chunk = new Uint8Array(5 * 1024 * 1024); // 5 MiB chunks -> > 16 MiB on 4th chunk
          const stream = new ReadableStream({
            pull(controller) {
              chunksSent++;
              if (chunksSent > 5) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (mode === '502_with_known_id' && init.method === 'POST') {
          return makeJsonFetchResponse(502, { id: 'resp_known_777', error: { message: 'Upstream gateway error' } });
        }
        if (mode === 'recover_wrong_id' && init.method === 'GET') {
          return makeJsonFetchResponse(200, {
            id: 'resp_SPOOFED_OTHER',
            status: 'completed',
            model: 'gpt-6.1-terra',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
            usage: { input_tokens: 100, output_tokens: 100 },
          });
        }
        if (mode === 'recover_200_completed' && init.method === 'GET') {
          return makeJsonFetchResponse(200, {
            id: 'resp_known_777',
            status: 'completed',
            model: 'gpt-6.1-terra',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
            usage: { input_tokens: 1_000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 300 } },
          });
        }
        throw new Error(`Unexpected call in mode=${mode}: ${init.method} ${url}`);
      },
    });

    // P0-18: Per-call baseUrl with different origin is blocked before reservation!
    await assert.rejects(
      () => client.createResponse({ input: 'Hello' }, { baseUrl: 'https://evil-collector.example.com' }),
      err => err instanceof OpenAiPolicyError && err.code === 'BASE_ORIGIN_MISMATCH',
    );

    // P0-19: Non-boolean flag values ("false", 1, {}) are rejected!
    for (const badFlag of [{ allowAstraApi: 'false' }, { enableStage4Media: 1 }, { deleteAfterPersist: 'true' }]) {
      await assert.rejects(
        () => client.createResponse({ input: 'Hello' }, badFlag),
        OpenAiValidationError,
      );
    }

    // P2-01: Invalid timeoutMs or pre-aborted AbortSignal fails with ZERO reservations!
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(
      () => client.createResponse({ input: 'Hello' }, { signal: preAborted.signal }),
      err => err instanceof OpenAiValidationError && err.code === 'SIGNAL_ALREADY_ABORTED' && err.not_dispatched === true,
    );
    await assert.rejects(
      () => client.createResponse({ input: 'Hello' }, { timeoutMs: 0 }),
      err => err instanceof OpenAiValidationError && err.not_dispatched === true,
    );
    assert.equal(ledger.getStatus({ monthUtc: '2026-11' }).total_requests, 0);

    // P0-24: Corrupt HTTP 200 JSON persists bounded scrubbed raw_body_text + raw_body_sha256 without literal apiKey!
    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'req-corrupt-200', input: 'Spec check 1' }),
      OpenAiAmbiguousOutcomeError,
    );
    const corruptRow = ledger.getAttempt('req-corrupt-200');
    assert.equal(corruptRow.status, 'pending_recovery');
    assert.ok(corruptRow.raw_body_text.includes('[REDACTED_TOKEN]'));
    assert.equal(corruptRow.raw_body_text.includes(SYNTHETIC_CUSTOM_SECRET), false);
    assert.equal(corruptRow.raw_body_sha256, sha256Hex(corruptRow.raw_body_text));

    ledger.reconcileAttempt(corruptRow.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared corrupt 200 test attempt.',
    });

    // P0-22: Oversized (>16 MiB) stream is aborted and fenced in pending_recovery!
    mode = 'oversized_stream';
    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'req-oversized-stream', input: 'Spec check 2' }),
      OpenAiAmbiguousOutcomeError,
    );
    assert.equal(ledger.getAttempt('req-oversized-stream').status, 'pending_recovery');
    ledger.reconcileAttempt('req-oversized-stream', {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared oversized stream test attempt.',
    });

    // P0-03 & P0-04: Known-ID recovery verifies endpoint, scope, and returned body id === expected id!
    mode = '502_with_known_id';
    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'req-known-502', input: 'Spec check 3' }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.provider_response_id === 'resp_known_777',
    );

    await assert.rejects(
      () => client.recoverPendingResponse('req-known-502', { accountScope: 'wrong-scope' }),
      err => err instanceof OpenAiBudgetError && err.code === 'ATTEMPT_SCOPE_MISMATCH',
    );

    mode = 'recover_wrong_id';
    await assert.rejects(
      () => client.recoverPendingResponse('req-known-502'),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.code === 'PROVIDER_RESPONSE_ID_MISMATCH',
    );
    assert.equal(ledger.getAttempt('req-known-502').provider_response_id, 'resp_known_777');

    mode = 'recover_200_completed';
    const rec200 = await client.recoverPendingResponse('req-known-502');
    assert.equal(rec200.recovered, true);
    assert.equal(rec200.status, 'completed');
    assert.equal(rec200.fenced, false);
    assert.equal(rec200.attempt.usage_cost_micros, 3_500);
  } finally {
    ledger.close();
  }
});

// -----------------------------------------------------------------------------
// 7. Batch Manifest Admission & Verification (P0-01/P0-02/P0-21/P0-23/P1-02/P1-04) & Stage-4 Gates (P0-19/P0-20/P1-03)
// -----------------------------------------------------------------------------

test('client.mjs: Batch manifest admission, /v1/files uploaded_file_id persistence, custom_id/model verification, 409 fencing, and Stage-4 media validation', async () => {
  const built = buildBatchJsonl([
    {
      custom_id: 'social-lead-01',
      url: '/v1/responses',
      body: { input: 'Extract product form from Reddit post.' },
      estimatedInputTokens: 2_000,
    },
    {
      custom_id: 'social-lead-02',
      url: '/v1/responses',
      body: { input: 'Extract product form from Pinterest pin.' },
      estimatedInputTokens: 2_000,
    },
  ]);

  assert.equal(built.line_count, 2);
  // Each line at 50% off uses the 65,536-token Terra output reservation.
  assert.equal(built.estimated_micros, 330_180);
  assert.equal(built.estimated_reservation_cents, 34);

  // P0-21: parseBatchOutputJsonl returns total_usage_cost_micros: null + known_usage_cost_micros when unknown usage exists,
  // and includes web_search calls on failed lines with usage!
  const mixedBatchOut = parseBatchOutputJsonl([
    JSON.stringify({
      id: 'br_err_ws',
      custom_id: 'err-with-ws',
      response: {
        status_code: 500,
        body: {
          model: 'gpt-6.1-terra',
          output: [{ type: 'web_search_call', id: 'ws_err_1' }],
          usage: { input_tokens: 2_000, output_tokens: 1_000 }, // (2000 + 5000)/2 + 10_000 = 13_500 micros
        },
      },
      error: { message: 'Failed after tool call' },
    }),
    JSON.stringify({
      id: 'br_unknown',
      custom_id: 'err-no-usage',
      response: { status_code: 500, body: {} },
      error: { message: 'Gateway timeout' },
    }),
  ].join('\n'));
  assert.equal(mixedBatchOut.has_unknown_usage, true);
  assert.equal(mixedBatchOut.total_usage_cost_micros, null);
  assert.equal(mixedBatchOut.known_usage_cost_micros, 13_500);
  assert.equal(mixedBatchOut.content_status, 'invalid');

  const ledger = createActivatedMemoryLedger({ allowStage4Media: false });
  try {
    let batchStepMode = 'normal';
    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        if (init.method === 'POST' && url.endsWith('/v1/files')) {
          if (batchStepMode === 'files_409') {
            return makeJsonFetchResponse(409, { error: { message: 'Conflict on file upload' } });
          }
          if (batchStepMode === 'batches_timeout_after_upload') {
            return makeJsonFetchResponse(200, { id: 'file_uploaded_timeout_1' });
          }
          return makeJsonFetchResponse(200, { id: 'file_uploaded_999' });
        }
        if (init.method === 'POST' && url.endsWith('/v1/batches')) {
          if (batchStepMode === 'batches_timeout_after_upload') {
            throw new Error('POST /v1/batches network timeout after file upload');
          }
          return makeJsonFetchResponse(200, { id: 'batch_img_1', status: 'validating', input_file_id: 'file_uploaded_999' });
        }
        if (init.method === 'GET' && url.endsWith('/v1/batches/batch_img_1')) {
          return makeJsonFetchResponse(200, {
            id: 'batch_img_1',
            endpoint: '/v1/images/generations',
            input_file_id: 'file_uploaded_999',
            status: 'completed',
            output_file_id: 'file_img_out_1',
            request_counts: { total: batchStepMode === 'wrong_custom_id' ? 1 : 1, completed: 1, failed: 0 },
          });
        }
        if (init.method === 'GET' && url.endsWith('/v1/files/file_img_out_1/content')) {
          const cid = batchStepMode === 'wrong_custom_id' ? 'foreign-cid' : 'img-c1';
          // Notice body omits `model` — P1-04 prices from batch_manifest.line_models['img-c1']!
          return makeJsonFetchResponse(
            200,
            `${JSON.stringify({
              id: 'br_img_1',
              custom_id: cid,
              response: {
                status_code: 200,
                body: {
                  created: 1795200000,
                  data: [{ b64_json: VALID_1X1_PNG_B64 }],
                  usage: {
                    input_tokens: 1_000,
                    input_tokens_details: { text_tokens: 1_000, image_tokens: 0 },
                    output_tokens: 4_000,
                  },
                },
              },
              error: null,
            })}\n`,
          );
        }
        if (url.endsWith('/v1/images/generations')) {
          if (batchStepMode === 'img_bad_magic') {
            return makeJsonFetchResponse(200, {
              created: 1795200000,
              data: [{ b64_json: Buffer.from('NOT_A_PNG_FILE').toString('base64') }],
              usage: { input_tokens: 500, input_tokens_details: { text_tokens: 500, image_tokens: 0 }, output_tokens: 1_000 },
            });
          }
          return makeJsonFetchResponse(200, {
            created: 1795200000,
            data: [{ b64_json: VALID_1X1_PNG_B64 }],
            usage: { input_tokens: 500, input_tokens_details: { text_tokens: 500, image_tokens: 0 }, output_tokens: 1_000 },
          });
        }
        if (url.endsWith('/v1/audio/speech')) {
          if (batchStepMode === 'tts_json_200') {
            return makeJsonFetchResponse(200, { error: 'proxy returned 200 JSON error' }, { 'content-type': 'application/json' });
          }
          if (batchStepMode === 'tts_with_usage_header') {
            return makeBinaryFetchResponse(200, VALID_20B_MP3_BYTES, 'audio/mpeg', { 'x-usage-characters': '12' });
          }
          return makeBinaryFetchResponse(200, VALID_20B_MP3_BYTES, 'audio/mpeg');
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    // P0-01: Reject supplying BOTH requests and input_file_id, or an unbound input_file_id lacking a durable upload receipt!
    await assert.rejects(
      () => client.submitBatch({
        requests: [{ custom_id: 'c1', url: '/v1/responses', body: { input: 'Hi' } }],
        input_file_id: 'file_123',
      }),
      err => err instanceof OpenAiValidationError && err.code === 'BATCH_CONFLICTING_INPUTS',
    );
    await assert.rejects(
      () => client.submitBatch({ input_file_id: 'file_123', estimated_reservation_cents: 5 }),
      err => err instanceof OpenAiPolicyError && err.code === 'UNBOUND_BATCH_INPUT_FILE' && err.not_dispatched === true,
    );

    // P0-19: Stage-4 media blocked when policyRow.allow_stage4_media === false EVEN IF policy.enableStage4Media: true!
    await assert.rejects(
      () => client.createConceptImage({ prompt: 'Concept image' }, { enableStage4Media: true }),
      err => err instanceof OpenAiPolicyError && err.code === 'STAGE4_MEDIA_DISABLED',
    );
    ledger.configurePolicy({ allowStage4Media: true });

    // P0-20: HTTP 409 on /v1/files fences in pending_recovery (NEVER confirmedZeroCharge: true!)
    batchStepMode = 'files_409';
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'batch-files-409',
        requests: [{ custom_id: 'c1', url: '/v1/responses', body: { input: 'Item 1' } }],
      }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.http_status === 409,
    );
    assert.equal(ledger.getAttempt('batch-files-409').status, 'pending_recovery');
    assert.equal(ledger.getAttempt('batch-files-409').confirmed_zero_charge, false);
    ledger.reconcileAttempt('batch-files-409', {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared 409 file upload test.',
    });

    // P1-02: uploaded_file_id is persisted into batch_manifest BEFORE POST /v1/batches!
    batchStepMode = 'batches_timeout_after_upload';
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'batch-upload-saved',
        requests: [{ custom_id: 'c1', url: '/v1/responses', body: { input: 'Item 1' } }],
      }),
      OpenAiAmbiguousOutcomeError,
    );
    assert.equal(ledger.getAttempt('batch-upload-saved').batch_manifest.uploaded_file_id, 'file_uploaded_timeout_1');
    ledger.reconcileAttempt('batch-upload-saved', {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared batch timeout test.',
    });

    // P0-02 & P1-04: Image batch submission -> custom_id mismatch holds pending_recovery -> matching custom_id settles + idempotent retrieveBatch!
    batchStepMode = 'normal';
    const imgBatchSub = await client.submitBatch(
      {
        logical_request_id: 'batch-img-live-1',
        endpoint: '/v1/images/generations',
        requests: [{ custom_id: 'img-c1', url: '/v1/images/generations', body: { model: 'gpt-image-2.6-flare', prompt: ' Studio tray ' } }],
      },
      { enableStage4Media: true },
    );
    assert.equal(imgBatchSub.status, 'pending_recovery');

    batchStepMode = 'wrong_custom_id';
    await client.retrieveBatch('batch_img_1', {
      downloadOutput: true,
      attemptId: imgBatchSub.attempt_id,
    });
    // Foreign custom_id MUST keep attempt in pending_recovery!
    assert.equal(ledger.getAttempt(imgBatchSub.attempt_id).status, 'pending_recovery');

    batchStepMode = 'normal';
    const settledBatch = await client.retrieveBatch('batch_img_1', {
      downloadOutput: true,
      attemptId: imgBatchSub.attempt_id,
    });
    // Priced accurately from batch_manifest.line_models['img-c1'] = 'gpt-image-2.6-flare' at 50% batch discount:
    // (1_000 * $5 + 4_000 * $30) / 2 = (5_000 + 120_000) / 2 = 62_500 micros!
    assert.equal(settledBatch.parsed_output.total_usage_cost_micros, 62_500);
    assert.equal(ledger.getAttempt(imgBatchSub.attempt_id).status, 'completed');

    // P0-02: Calling retrieveBatch again on already-completed attempt is idempotent (never throws INVALID_STATE_TRANSITION!)
    const idempotentBatch = await client.retrieveBatch('batch_img_1', {
      downloadOutput: true,
      attemptId: imgBatchSub.attempt_id,
    });
    assert.equal(idempotentBatch.already_settled, true);

    // P1-03: Malformed PNG magic bytes after POST settles as failed_known (content_status='invalid'), NEVER not_dispatched: true!
    batchStepMode = 'img_bad_magic';
    const badImgRes = await client.createConceptImage(
      { logical_request_id: 'img-bad-magic', prompt: 'Concept tray' },
      { enableStage4Media: true },
    );
    assert.equal(badImgRes.ok, false);
    assert.equal(badImgRes.usable, false);
    assert.equal(badImgRes.status, 'failed_known');
    assert.equal(badImgRes.content_status, 'invalid');
    assert.equal(ledger.getAttempt('img-bad-magic').status, 'failed_known');

    batchStepMode = 'normal';
    const goodImgRes = await client.createConceptImage(
      { logical_request_id: 'img-good-magic', prompt: 'Concept tray' },
      { enableStage4Media: true },
    );
    assert.equal(goodImgRes.ok, true);
    assert.equal(goodImgRes.usage_cost_micros, 32_500);

    // P1-03 & P0-17: TTS 200 with application/json Content-Type fences as pending_recovery (recording provisional usage);
    // valid MP3 without usage header holds as SPEECH_USAGE_UNVERIFIED_HOLD unless x-usage-characters or allowEstimatedSpeechSettlementInTests!
    batchStepMode = 'tts_json_200';
    await assert.rejects(
      () => client.createSpeechBriefing({ logical_request_id: 'tts-bad-ct', input: 'Hello owner.' }, { enableStage4Media: true }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.code === 'INVALID_AUDIO_CONTENT_TYPE' && err.not_dispatched === false,
    );
    ledger.reconcileAttempt('tts-bad-ct', {
      status: 'failed_known',
      usageCostMicros: 180,
      note: 'Reconciled invalid Content-Type TTS test at provisional usage.',
    });

    batchStepMode = 'normal';
    const ttsUnverifiedHold = await client.createSpeechBriefing(
      { logical_request_id: 'tts-unverified-hold', input: 'Hello owner.' },
      { enableStage4Media: true, ttsMicrosPer1kChars: 30_000, allowCustomTariffForTests: true },
    );
    assert.equal(ttsUnverifiedHold.ok, false);
    assert.equal(ttsUnverifiedHold.status, 'pending_recovery');
    assert.equal(ttsUnverifiedHold.hold_code, 'SPEECH_USAGE_UNVERIFIED_HOLD');
    assert.equal(ttsUnverifiedHold.provisional_char_count, 12);
    assert.equal(ttsUnverifiedHold.provisional_usage_cost_micros, 360);
    ledger.reconcileAttempt('tts-unverified-hold', {
      status: 'completed',
      usageCostMicros: 360,
      note: 'Confirmed 12 chars billed on provider dashboard.',
    });

    batchStepMode = 'tts_with_usage_header';
    const ttsRes = await client.createSpeechBriefing(
      { logical_request_id: 'tts-good', input: 'Hello owner.' },
      { enableStage4Media: true, ttsMicrosPer1kChars: 30_000, allowCustomTariffForTests: true },
    );
    assert.equal(ttsRes.ok, true);
    assert.equal(ttsRes.status, 'completed');
    assert.equal(ttsRes.estimated_char_count, 12);
    assert.deepEqual(ttsRes.usage, { characters: 12 });
    assert.equal(ttsRes.usage_cost_micros, 360);
  } finally {
    ledger.close();
  }
});

test('budget-ledger.mjs: _migrateSchema upgrades pre-remediation tables seamlessly and preserves posted_billed_cents vs usage_cost_micros', () => {
  const rawDb = new DatabaseSync(':memory:');
  try {
    // Seed old pre-migration schema without new columns or openai_legacy_carryover table
    rawDb.exec(`
      CREATE TABLE openai_budget_policy (
        account_scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        monthly_limit_cents INTEGER NOT NULL DEFAULT 20000,
        legacy_reconciled INTEGER NOT NULL DEFAULT 0,
        legacy_reconciled_month_utc TEXT,
        legacy_carryover_cents INTEGER NOT NULL DEFAULT 0,
        legacy_source_sha256 TEXT,
        legacy_summary_json TEXT,
        legacy_reconciled_at TEXT,
        allow_stage4_media INTEGER NOT NULL DEFAULT 0,
        policy_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_budget_policy VALUES (
        'openai-default', 0, 20000, 1, '2026-11', 620,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '{}', '2026-11-21T00:00:00Z', 0, NULL, '2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z'
      );
      CREATE TABLE openai_request_ledger (
        attempt_id TEXT PRIMARY KEY,
        logical_request_id TEXT NOT NULL UNIQUE,
        account_scope TEXT NOT NULL,
        month_utc TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        service_tier TEXT NOT NULL DEFAULT 'standard',
        payload_sha256 TEXT NOT NULL,
        packet_sha256 TEXT,
        status TEXT NOT NULL,
        content_status TEXT,
        reserved_cents INTEGER NOT NULL,
        estimated_input_tokens INTEGER,
        max_output_tokens INTEGER,
        max_web_search_calls INTEGER NOT NULL DEFAULT 0,
        usage_cost_micros INTEGER,
        posted_billed_cents INTEGER,
        confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT,
        provider_response_id TEXT,
        provider_model TEXT,
        http_status INTEGER,
        cleanup_status TEXT,
        raw_receipt_json TEXT,
        raw_receipt_sha256 TEXT,
        diagnostic_reason TEXT,
        reconciliation_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);

    const migrated = new OpenAiBudgetLedger(rawDb, {
      testMode: true,
      nowFn: () => new Date('2026-11-21T12:00:00Z'),
    });
    // Backfilled carryover preserved!
    assert.equal(migrated.getMonthlySummary({ monthUtc: '2026-11' }).legacy_carryover_cents, 620);
    assert.equal(migrated.getPolicy().auto_recharge_off_confirmed, false);
    assert.equal(migrated.getPolicy().hard_monthly_limit_confirmed, false);

    migrated.configurePolicy({
      enabled: true,
      autoRechargeOffConfirmed: true,
      hardMonthlyLimitConfirmed: true,
    });
    const att = migrated.reserveBillableRequest({
      logicalRequestId: 'post-mig-req-1',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: 'b'.repeat(64),
      reservedCents: 10,
    });
    migrated.recordTerminalOutcome(att.attempt_id, {
      status: 'completed',
      contentStatus: 'usable',
      usageCostMicros: 30_000,
      providerResponseId: 'resp_mig_1',
      rawReceipt: { id: 'resp_mig_1', status: 'completed' },
    });
    const reconciled = migrated.reconcileAttempt(att.attempt_id, {
      postedBilledCents: 0,
      note: 'Covered by promotional credit; usage still counts toward $200 allowance.',
    });
    assert.equal(reconciled.usage_cost_micros, 30_000);
    assert.equal(reconciled.posted_billed_cents, 0);
    // 620c carryover + max(posted=0c, ceil(30_000 micros)=3c) = 623c!
    assert.equal(migrated.getMonthlySummary({ monthUtc: '2026-11' }).effective_committed_cents, 623);
  } finally {
    rawDb.close();
  }
});

test('hostile regression suite: tampered DB ceiling, strict legacy monetary/timestamp edge cases, unknown status/missing-id holds, retry DELETE 404 after ack, batchManifest & mutation guards, stream errors, and prototype safety', async () => {
  // 1) P0-06: Tampered DB row with monthly_limit_cents > 20000 on pre-migration table is capped in summary & rejected at admission!
  const rawDb = new DatabaseSync(':memory:');
  try {
    rawDb.exec(`
      CREATE TABLE openai_budget_policy (
        account_scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        monthly_limit_cents INTEGER NOT NULL DEFAULT 50000,
        legacy_reconciled INTEGER NOT NULL DEFAULT 1,
        legacy_reconciled_month_utc TEXT,
        legacy_carryover_cents INTEGER NOT NULL DEFAULT 0,
        legacy_source_sha256 TEXT,
        legacy_summary_json TEXT,
        legacy_reconciled_at TEXT,
        allow_stage4_media INTEGER NOT NULL DEFAULT 0,
        policy_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_budget_policy VALUES (
        'openai-default', 1, 50000, 1, '2026-11', 0,
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        '{}', '2026-11-21T00:00:00Z', 0, NULL, '2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z'
      );
    `);
    const tamperedLedger = new OpenAiBudgetLedger(rawDb, {
      testMode: true,
      nowFn: () => new Date('2026-11-21T12:00:00Z'),
    });
    rawDb.exec('UPDATE openai_budget_policy SET auto_recharge_off_confirmed = 1, hard_monthly_limit_confirmed = 1');
    assert.equal(tamperedLedger.getMonthlySummary({ monthUtc: '2026-11' }).monthly_limit_cents, 20_000);
    assert.throws(
      () => tamperedLedger.reserveBillableRequest({
        logicalRequestId: 'tampered-limit-req',
        endpoint: '/v1/responses',
        model: 'gpt-6.1-terra',
        payloadSha256: 'd'.repeat(64),
        reservedCents: 1,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'MONTHLY_LIMIT_EXCEEDS_CEILING',
    );
  } finally {
    rawDb.close();
  }

  // 2) P0-08, P0-09 & P0-10: Fractional cents, negative cents, NaN text, failed/error/expired (even with 0 reservation without confirmed_zero_charge!), and unparseable timestamp -> ALL increment unresolved_count!
  await withTempDirAsync(async dir => {
    const edgeLegacyPath = join(dir, 'edge-legacy.sqlite3');
    const edgeDb = new DatabaseSync(edgeLegacyPath);
    try {
      edgeDb.exec(`
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY,
          cents ANY,
          status TEXT,
          started_at TEXT
        );
      `);
      const ins = edgeDb.prepare('INSERT INTO requests VALUES (?, ?, ?, ?)');
      ins.run('r-frac', 12.5, 'complete', '2026-11-10T00:00:00Z');
      ins.run('r-neg', -5, 'complete', '2026-11-10T00:00:00Z');
      ins.run('r-nan', 'NaN', 'complete', '2026-11-10T00:00:00Z');
      ins.run('r-failed', 20, 'failed', '2026-11-10T00:00:00Z');
      ins.run('r-error', 20, 'error', '2026-11-10T00:00:00Z');
      ins.run('r-expired', 20, 'expired', '2026-11-10T00:00:00Z');
      ins.run('r-baddate', 20, 'complete', 'not-a-valid-date');
      ins.run('r-zero-failed', 0, 'failed', '2026-11-10T00:00:00Z'); // P0-10: failed without confirmedZero/usage -> UNRESOLVED!
      ins.run('r-zero-not-submitted', 0, 'not_submitted', '2026-11-10T00:00:00Z'); // not_submitted with 0 -> clean!
    } finally {
      edgeDb.close();
    }
    const edgeSummary = inspectLegacyAutopilotBudget(edgeLegacyPath, { monthUtc: '2026-11' });
    assert.equal(edgeSummary.total_rows, 9);
    assert.equal(edgeSummary.unresolved_count, 8);
    assert.equal(edgeSummary.safe_to_reconcile, false);
  });

  // 3) P1-04: parseBatchOutputJsonl overall content_status across usable, refused, incomplete, invalid + P2-04 null prototype
  const allRefusedBatch = parseBatchOutputJsonl(JSON.stringify({
    id: 'br_ref_1',
    custom_id: 'cid-ref',
    response: {
      status_code: 200,
      body: {
        id: 'resp_r1',
        status: 'completed',
        model: 'gpt-6.1-terra',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Refused item' }] }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  }));
  assert.equal(allRefusedBatch.content_status, 'refused');
  assert.equal(Object.getPrototypeOf(allRefusedBatch.by_custom_id), null);

  const allIncompleteBatch = parseBatchOutputJsonl(JSON.stringify({
    id: 'br_inc_1',
    custom_id: 'cid-inc',
    response: {
      status_code: 200,
      body: {
        id: 'resp_i1',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'gpt-6.1-terra',
        output: [],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    },
  }));
  assert.equal(allIncompleteBatch.content_status, 'incomplete');

  // 4) Unknown response status (preserving provisional usage!), retry DELETE 404 after persisted delete_ack_at,
  //    durable upload-bound batchManifest validation, mid-upload mutation immunity, and image count/stream errors!
  const ledger = createActivatedMemoryLedger({ allowStage4Media: true });
  try {
    let stage = 'unknown_status';
    let capturedBatchBody = null;
    let uploadCounter = 0;

    const client = new OpenAiClient({
      ledger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        if (init.method === 'POST' && url.endsWith('/v1/responses')) {
          if (stage === 'unknown_status') {
            return makeJsonFetchResponse(200, {
              id: 'resp_weird_1',
              status: 'mystery_future_state',
              model: 'gpt-6.1-terra',
              output: [{ type: 'message', content: [{ type: 'output_text', text: '{"x":1}' }] }],
              usage: { input_tokens: 100, output_tokens: 50 },
            });
          }
          if (stage === 'missing_id') {
            return makeJsonFetchResponse(200, {
              status: 'completed',
              model: 'gpt-6.1-terra',
              output: [{ type: 'message', content: [{ type: 'output_text', text: '{"x":1}' }] }],
              usage: { input_tokens: 100, output_tokens: 50 },
            });
          }
          if (stage === 'delete_ack_then_get_200') {
            return makeJsonFetchResponse(200, {
              id: 'resp_ack_retry_1',
              status: 'completed',
              model: 'gpt-6.1-terra',
              output: [{ type: 'message', content: [{ type: 'output_text', text: '{"clean":1}' }] }],
              usage: { input_tokens: 1_000, output_tokens: 500 },
            });
          }
        }
        if (init.method === 'DELETE' && url.endsWith('/v1/responses/resp_ack_retry_1')) {
          if (stage === 'delete_ack_then_get_200') {
            return makeJsonFetchResponse(200, { id: 'resp_ack_retry_1', deleted: true });
          }
          return makeJsonFetchResponse(404, { error: { message: 'Already deleted' } });
        }
        if (init.method === 'GET' && url.endsWith('/v1/responses/resp_ack_retry_1')) {
          if (stage === 'delete_ack_then_get_200') {
            return makeJsonFetchResponse(200, { id: 'resp_ack_retry_1', status: 'completed' });
          }
          return makeJsonFetchResponse(404, { error: { message: 'Not found' } });
        }
        if (init.method === 'POST' && url.endsWith('/v1/files')) {
          if (callerMutableBatchParams?.metadata) {
            callerMutableBatchParams.metadata.tag = 'TAMPERED_DURING_UPLOAD';
          }
          uploadCounter++;
          return makeJsonFetchResponse(200, { id: `file_mut_check_${uploadCounter}` });
        }
        if (init.method === 'POST' && url.endsWith('/v1/batches')) {
          capturedBatchBody = JSON.parse(init.body);
          return makeJsonFetchResponse(200, { id: `batch_mut_${uploadCounter}`, status: 'validating', input_file_id: capturedBatchBody.input_file_id });
        }
        if (init.method === 'POST' && url.endsWith('/v1/images/generations')) {
          if (stage === 'img_count_mismatch') {
            return makeJsonFetchResponse(200, {
              created: 1795200000,
              data: [{ b64_json: VALID_1X1_PNG_B64 }],
              usage: { input_tokens: 500, input_tokens_details: { text_tokens: 500, image_tokens: 0 }, output_tokens: 1_000 },
            });
          }
          if (stage === 'img_stream_throw') {
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() { throw new Error('Mid-body TCP reset'); },
              async arrayBuffer() { throw new Error('Mid-body TCP reset'); },
            };
          }
        }
        throw new Error(`Unexpected request in stage=${stage}: ${init.method} ${url}`);
      },
    });

    // P0-13: Unknown response status -> pending_recovery AND retains positive provisional_usage_cost_micros (350 micros),
    // rejecting confirmedZeroCharge: true or 0-micro reductions!
    const weirdStatusRes = await client.createResponse({ logical_request_id: 'req-weird-status', input: 'Check' });
    assert.equal(weirdStatusRes.status, 'pending_recovery');
    assert.equal(weirdStatusRes.usable, false);
    assert.equal(weirdStatusRes.provisional_usage_cost_micros, 350);
    assert.throws(
      () => ledger.reconcileAttempt('req-weird-status', { status: 'failed_known', confirmedZeroCharge: true, note: 'Try erasing 350 micros.' }),
      OpenAiValidationError,
    );
    assert.throws(
      () => ledger.reconcileAttempt('req-weird-status', { status: 'failed_known', usageCostMicros: 100, note: 'Try reducing 350 micros.' }),
      err => err instanceof OpenAiBudgetError && err.code === 'USAGE_REDUCTION_FORBIDDEN',
    );
    ledger.reconcileAttempt('req-weird-status', { status: 'failed_known', usageCostMicros: 350, note: 'Settled at observed 350 micros.' });

    // DELETE 200 ack persisted -> GET 200 fails 404 check -> retry deleteResponse (DELETE 404 + GET 404) finalizes 'completed'!
    stage = 'delete_ack_then_get_200';
    const unverifiedCleanup = await client.createResponse(
      { logical_request_id: 'req-ack-retry', input: 'Check' },
      { deleteAfterPersist: true },
    );
    assert.equal(unverifiedCleanup.status, 'pending_recovery');
    const ackRow = ledger.getAttempt('req-ack-retry');
    assert.ok(ackRow.delete_ack_at !== null);

    stage = 'retry_delete_404_then_get_404';
    const retryDel = await client.deleteResponse('resp_ack_retry_1', { attemptId: ackRow.attempt_id });
    assert.equal(retryDel.deleted, true);
    assert.equal(retryDel.verified_404, true);
    assert.equal(ledger.getAttempt(ackRow.attempt_id).status, 'completed');
    assert.equal(ledger.getAttempt(ackRow.attempt_id).cleanup_status, 'deleted_verified_404');

    // P0-23: Mid-upload caller mutation does NOT alter /v1/batches wire payload!
    const callerMutableBatchParams = {
      logical_request_id: 'batch-mut-test',
      metadata: { tag: 'ORIGINAL_IMMUTABLE_TAG' },
      requests: [{ custom_id: 'm1', url: '/v1/responses', body: { input: 'Original prompt' } }],
    };
    await client.submitBatch(callerMutableBatchParams);
    assert.equal(capturedBatchBody.metadata.tag, 'ORIGINAL_IMMUTABLE_TAG');
    ledger.reconcileAttempt('batch-mut-test', { status: 'failed_known', confirmedZeroCharge: true, note: 'Clear mut batch.' });

    // P0-01: Unbound input_file_id is REJECTED; uploadBatchFile -> submitBatch with bound input_file_id SUCCEEDS!
    const prebuilt = buildBatchJsonl([{ custom_id: 'ext-1', url: '/v1/responses', body: { input: 'Prebuilt line' } }]);
    await assert.rejects(
      () => client.submitBatch({
        input_file_id: 'file_ext_unbound',
        batchManifest: prebuilt.batch_manifest,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'UNBOUND_BATCH_INPUT_FILE' && err.not_dispatched === true,
    );
    const uploadedReceipt = await client.uploadBatchFile({
      requests: [{ custom_id: 'ext-1', url: '/v1/responses', body: { input: 'Prebuilt line' } }],
    });
    await assert.rejects(
      () => client.submitBatch({
        input_file_id: uploadedReceipt.input_file_id,
        batchManifest: { ...uploadedReceipt.batch_manifest, endpoint: '/v1/images/generations' },
      }),
      err => err instanceof OpenAiValidationError && err.code === 'BATCH_MANIFEST_INVALID',
    );
    const extBatch = await client.submitBatch({
      logical_request_id: 'batch-ext-ok',
      input_file_id: uploadedReceipt.input_file_id,
      batchManifest: uploadedReceipt.batch_manifest,
    });
    assert.equal(extBatch.status, 'pending_recovery');
    assert.deepEqual(extBatch.batch_manifest.custom_ids, ['ext-1']);
    ledger.reconcileAttempt('batch-ext-ok', { status: 'failed_known', confirmedZeroCharge: true, note: 'Clear ext batch.' });

    // P1-03: createConceptImage count mismatch (n=2, 1 returned) settles as failed_known without throwing not_dispatched: true!
    stage = 'img_count_mismatch';
    const mismatchImg = await client.createConceptImage(
      { logical_request_id: 'img-n-mismatch', prompt: 'Tray', n: 2 },
      { enableStage4Media: true },
    );
    assert.equal(mismatchImg.status, 'failed_known');
    assert.equal(mismatchImg.content_status, 'invalid');
    assert.equal(mismatchImg.usable, false);

    // P0-04 & P0-13: Missing response id with deleteAfterPersist: true & positive usage stays fenced and forbids boolean cleanup bypass!
    stage = 'missing_id';
    const missingIdRes = await client.createResponse({ logical_request_id: 'req-missing-id', input: 'Check' }, { deleteAfterPersist: true });
    assert.equal(missingIdRes.status, 'pending_recovery');
    assert.equal(missingIdRes.usable, false);
    assert.equal(missingIdRes.provisional_usage_cost_micros, 350);
    assert.throws(
      () => ledger.reconcileAttempt('req-missing-id', { status: 'completed', usageCostMicros: 350, cleanupConfirmedDeleted: true, note: 'Try boolean cleanup bypass.' }),
      err => err instanceof OpenAiPolicyError && err.code === 'CLEANUP_NOT_VERIFIED',
    );
    assert.throws(
      () => ledger.reconcileAttempt('req-missing-id', { status: 'completed', usageCostMicros: 350, note: 'Try settling without 404 verification.' }),
      err => err instanceof OpenAiBudgetError && err.code === 'CLEANUP_NOT_VERIFIED',
    );
  } finally {
    ledger.close();
  }

  // Separate clean ledger for img_stream_throw after missing_id permanent fence test
  const streamLedger = createActivatedMemoryLedger({ allowStage4Media: true });
  try {
    const streamClient = new OpenAiClient({
      ledger: streamLedger,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        async text() { throw new Error('Mid-body TCP reset'); },
        async arrayBuffer() { throw new Error('Mid-body TCP reset'); },
      }),
    });
    await assert.rejects(
      () => streamClient.createConceptImage({ logical_request_id: 'img-stream-err', prompt: 'Tray' }, { enableStage4Media: true }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.not_dispatched === false,
    );
    assert.equal(streamLedger.getAttempt('img-stream-err').status, 'pending_recovery');
  } finally {
    streamLedger.close();
  }
});

// =============================================================================
// 11. Round 2 pricing.mjs & Speech/Audio guards (service_tier: 'auto' 2x ceiling,
//     model-verified TTS tariff floor, container framing/magic bytes, and x-usage-characters)
// =============================================================================

test('Round 2 pricing & audio: service_tier auto 2x ceiling, TTS model tariff floor, audio magic bytes, and speech usage hold', async () => {
  // P0-New: serviceTier 'auto' reserves at 'fast' (2x) on models supporting 'fast' (gpt-6.1-terra),
  // and 'standard' (1x) on models without 'fast' (gpt-6-luna).
  const terraAutoCents = estimateReservationCents({
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    serviceTier: 'auto',
    estimatedInputTokens: 10_000,
    maxOutputTokens: 2_000,
  });
  // 10k * $1.25/1M * 2 = 25,000 micros; 2k * $5.00/1M * 2 = 20,000 micros -> 45,000 micros -> ceil = 5 cents
  assert.equal(terraAutoCents, 5);
  const terraFastSettledMicros = computeUsageCostMicros({
    model: 'gpt-6.1-terra',
    serviceTier: 'fast',
    usage: { input_tokens: 10_000, output_tokens: 2_000 },
  });
  assert.equal(terraFastSettledMicros, 40_000);
  assert.equal(terraAutoCents * MICROS_PER_CENT >= terraFastSettledMicros, true);

  const lunaAutoBreak = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6-luna',
    serviceTier: 'auto',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 10_000,
  });
  const lunaStdBreak = estimateCostBreakdown({
    endpoint: '/v1/responses',
    model: 'gpt-6-luna',
    serviceTier: 'standard',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 10_000,
  });
  assert.equal(lunaAutoBreak.service_tier, 'auto');
  assert.equal(lunaAutoBreak.estimated_micros, lunaStdBreak.estimated_micros);

  // P0-17: OPENAI_MODEL_PRICING exposes ttsMicrosPer1kChars; outside allowCustomTariffForTests, canonical rate is enforced
  assert.equal(OPENAI_MODEL_PRICING['tts-1-hd'].ttsMicrosPer1kChars, 30_000n);
  assert.equal(OPENAI_MODEL_PRICING['gpt-4o-mini-tts'].ttsMicrosPer1kChars, 15_000n);
  assert.equal(resolveTtsMicrosPer1kChars('tts-1-hd'), 30_000);
  assert.equal(resolveTtsMicrosPer1kChars('tts-1-hd', 35_000), 30_000);
  assert.equal(resolveTtsMicrosPer1kChars('tts-1-hd', 35_000, { allowCustomTariffForTests: true }), 35_000);
  assert.throws(
    () => resolveTtsMicrosPer1kChars('tts-1-hd', 15_000),
    err => err instanceof OpenAiValidationError && err.code === 'TTS_TARIFF_BELOW_MINIMUM',
  );
  assert.equal(resolveTtsMicrosPer1kChars('tts-1-hd', 5_000, { allowCustomTariffForTests: true }), 5_000);

  // P1-03: validateAudioFramingAndMagicBytes checks complete audio frames & container packets
  assert.equal(validateAudioFramingAndMagicBytes(VALID_20B_MP3_BYTES, 'mp3'), true);
  assert.equal(validateAudioFramingAndMagicBytes(Buffer.from('ID3\x04\x00'), 'mp3'), false);
  assert.equal(validateAudioFramingAndMagicBytes(Buffer.from('{"error":"upstream gateway fault"}', 'utf8'), 'mp3'), false);

  const validWav = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x28, 0x00, 0x00, 0x00]),
    Buffer.from('WAVEfmt ', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00]),
    Buffer.from('data', 'ascii'),
    Buffer.from([0x04, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]),
  ]);
  assert.equal(validateAudioFramingAndMagicBytes(validWav, 'wav'), true);
  assert.equal(validateAudioFramingAndMagicBytes(Buffer.from('RIFF0000AVI list0000', 'ascii'), 'wav'), false);

  const validOpus = buildValidOggOpusBytes({ includeAudioPage: true });
  assert.equal(validateAudioFramingAndMagicBytes(validOpus, 'opus'), true);
  const validFlac = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    Buffer.from([0x80, 0x00, 0x00, 0x22]),
    Buffer.alloc(34, 0x11),
    Buffer.from([0xff, 0xf8, 0x69, 0x0c, 0x00, 0x01]),
  ]);
  assert.equal(validateAudioFramingAndMagicBytes(validFlac, 'flac'), true);
  const validAac = Buffer.concat([
    Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x9f, 0xfc]),
    Buffer.alloc(16, 1),
  ]);
  assert.equal(validateAudioFramingAndMagicBytes(validAac, 'aac'), true);
  assert.equal(validateAudioFramingAndMagicBytes(Buffer.alloc(4, 0), 'pcm'), true);
  assert.equal(validateAudioFramingAndMagicBytes(Buffer.alloc(3, 0), 'pcm'), false);

  // Client wire behavior for omitted vs 'auto' vs 'batch' service_tier & Speech settlement modes
  const wireBodies = [];
  const ledger = createActivatedMemoryLedger({ allowStage4Media: true });
  try {
    let speechMode = 'no_header';
    const client = new OpenAiClient({
      ledger,
      testMode: true,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/v1/responses')) {
          const parsed = JSON.parse(String(init.body));
          wireBodies.push(parsed);
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              return JSON.stringify({
                id: `resp_r2_${wireBodies.length}`,
                model: 'gpt-6.1-terra-2026-10-01',
                service_tier: parsed.service_tier === 'auto' ? 'fast' : 'standard',
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
                usage: { input_tokens: 10_000, output_tokens: 2_000 },
              });
            },
          };
        }
        if (String(url).endsWith('/v1/audio/speech')) {
          if (speechMode === 'octet_json_error') {
            const fakeErr = Buffer.from('{"error":"gateway proxy html/json masked as octet-stream"}', 'utf8');
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/octet-stream' }),
              async arrayBuffer() {
                return fakeErr.buffer.slice(fakeErr.byteOffset, fakeErr.byteOffset + fakeErr.byteLength);
              },
            };
          }
          const hdrs = new Headers({ 'content-type': 'audio/mpeg' });
          if (speechMode === 'with_header') {
            hdrs.set('x-usage-characters', '11');
          }
          return {
            status: 200,
            ok: true,
            headers: hdrs,
            async arrayBuffer() {
              return VALID_20B_MP3_BYTES.buffer.slice(
                VALID_20B_MP3_BYTES.byteOffset,
                VALID_20B_MP3_BYTES.byteOffset + VALID_20B_MP3_BYTES.byteLength,
              );
            },
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    });

    // Interactive 'batch' service_tier is forbidden on /v1/responses and /v1/decisions
    await assert.rejects(
      () => client.createResponse({
        logical_request_id: 'r2-batch-tier-resp',
        model: 'gpt-6.1-terra',
        service_tier: 'batch',
        reasoning: { effort: 'xhigh' },
        input: 'Test',
        max_output_tokens: 128,
      }),
      err => err instanceof OpenAiValidationError && err.code === 'BATCH_TIER_FORBIDDEN_ON_INTERACTIVE',
    );
    await assert.rejects(
      () => client.createDecision({
        logical_request_id: 'r2-batch-tier-dec',
        service_tier: 'batch',
        questions: [{ id: 'q1', type: 'predicate', question: 'Pass?' }],
        input: 'Check tier',
      }),
      err => err instanceof OpenAiValidationError && err.code === 'BATCH_TIER_FORBIDDEN_ON_INTERACTIVE',
    );

    // Omitted service_tier stays omitted on wire; explicit 'auto' stays 'auto' on wire and reserves 7c >= 60_000 micros ('fast')
    await client.createResponse({
      logical_request_id: 'r2-omit-tier',
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'xhigh' },
      input: 'Check omitted tier',
      max_output_tokens: 4_096,
    }, { estimatedInputTokens: 10_000 });
    assert.equal(Object.hasOwn(wireBodies[0], 'service_tier'), false);

    const autoRes = await client.createResponse({
      logical_request_id: 'r2-auto-tier',
      model: 'gpt-6.1-terra',
      service_tier: 'auto',
      reasoning: { effort: 'xhigh' },
      input: 'Check auto tier settling at fast',
      max_output_tokens: 4_096,
    }, { estimatedInputTokens: 10_000 });
    assert.equal(wireBodies[1].service_tier, 'auto');
    // 10k * $1.25/1M * 2 = 25,000 micros; 4096 * $5.00/1M * 2 = 40,960 micros -> 65,960 micros -> ceil = 7c >= 40,000 micros ('fast')
    assert.equal(autoRes.reserved_cents, 7);
    assert.equal(autoRes.usage_cost_micros, 40_000);
    assert.equal(autoRes.status, 'completed');

    // TTS under-floor custom rate rejected pre-dispatch
    await assert.rejects(
      () => client.createSpeechBriefing(
        { logical_request_id: 'tts-under-floor', model: 'tts-1-hd', input: 'Briefing text' },
        { enableStage4Media: true, ttsMicrosPer1kChars: 15_000 },
      ),
      err => err instanceof OpenAiValidationError && err.code === 'TTS_TARIFF_BELOW_MINIMUM',
    );
    assert.equal(ledger.getAttempt('tts-under-floor'), null);

    // Speech without x-usage-characters header holds in pending_recovery (SPEECH_USAGE_UNVERIFIED_HOLD)
    speechMode = 'no_header';
    const heldSpeech = await client.createSpeechBriefing(
      { logical_request_id: 'tts-held-1', model: 'tts-1-hd', input: 'Hello world' },
      { enableStage4Media: true },
    );
    assert.equal(heldSpeech.ok, false);
    assert.equal(heldSpeech.usable, true);
    assert.equal(heldSpeech.status, 'pending_recovery');
    assert.equal(heldSpeech.hold_code, 'SPEECH_USAGE_UNVERIFIED_HOLD');
    assert.equal(heldSpeech.usage_cost_micros, null);
    assert.equal(heldSpeech.provisional_usage_cost_micros > 0, true);
    // Clear fence via operator reconcileAttempt so subsequent speech tests can run
    ledger.reconcileAttempt('tts-held-1', {
      status: 'completed',
      usageCostMicros: heldSpeech.provisional_usage_cost_micros,
      note: 'Verified TTS billing from provider dashboard.',
    });

    // Speech with matching verified x-usage-characters header (11 chars === 'Hello world') settles completed
    speechMode = 'with_header';
    const verifiedSpeech = await client.createSpeechBriefing(
      { logical_request_id: 'tts-verified-hdr', model: 'tts-1-hd', input: 'Hello world' },
      { enableStage4Media: true },
    );
    assert.equal(verifiedSpeech.ok, true);
    assert.equal(verifiedSpeech.status, 'completed');
    assert.equal(verifiedSpeech.usage_cost_micros, 330); // ceil(11 * 30_000 / 1000) = 330 micros

    // Speech in testMode with allowEstimatedSpeechSettlementInTests: true settles completed without header
    speechMode = 'no_header';
    const testOptInSpeech = await client.createSpeechBriefing(
      { logical_request_id: 'tts-test-optin', model: 'gpt-4o-mini-tts', input: 'Hello world' },
      { enableStage4Media: true, allowEstimatedSpeechSettlementInTests: true },
    );
    assert.equal(testOptInSpeech.ok, true);
    assert.equal(testOptInSpeech.status, 'completed');

    // JSON error masked as application/octet-stream fails audio magic-byte validation -> INVALID_AUDIO_FRAMING
    speechMode = 'octet_json_error';
    await assert.rejects(
      () => client.createSpeechBriefing(
        { logical_request_id: 'tts-bad-framing', model: 'gpt-4o-mini-tts', input: 'Hello world' },
        { enableStage4Media: true },
      ),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.code === 'INVALID_AUDIO_FRAMING',
    );
    assert.equal(ledger.getAttempt('tts-bad-framing').status, 'pending_recovery');
  } finally {
    ledger.close();
  }
});

// =============================================================================
// 12. Round 2 budget-ledger.mjs: persistent canonical registry, PRAGMA database_list,
//     branded deep-frozen legacy summary, multi-month carryover, P0-10/11/12, and RO compat
// =============================================================================

test('Round 2 budget-ledger: canonical registry split-ledger block, branded summary, multi-month carryover, promo-zero/0c-failed holds, and RO pre-migration compat', async () => {
  await withTempDirAsync(async dir => {
    const registryPath = join(dir, 'canonical-registry.sqlite');
    const cleanLegacyPath = join(dir, 'legacy-multi-month.sqlite3');

    // Build clean multi-month legacy DB with 2026-10 (300c) and 2026-11 (950c)
    const legDb = new DatabaseSync(cleanLegacyPath);
    legDb.exec(`
      CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL,
        posted_billed_cents INTEGER NOT NULL,
        usage_cost_micros INTEGER NOT NULL,
        month_utc TEXT NOT NULL
      );
      INSERT INTO requests VALUES
        ('oct-1', 'completed', 300, 300, 3000000, '2026-10'),
        ('nov-1', 'completed', 950, 950, 9500000, '2026-11');
    `);
    legDb.close();

    // P0-11: Bare DatabaseSync pointing to legacyPath is caught BEFORE any DDL creates openai_* tables!
    const bareCollidingDb = new DatabaseSync(cleanLegacyPath);
    try {
      assert.throws(
        () => reconcileLegacyBudgetIntoStore(bareCollidingDb, cleanLegacyPath, { monthUtc: '2026-10' }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
      );
      const tablesAfterCollision = bareCollidingDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'openai_%'")
        .all();
      assert.equal(tablesAfterCollision.length, 0);
    } finally {
      bareCollidingDb.close();
    }

    // P0-12: Hardlink alias (nlink > 1) is rejected with LEGACY_HARDLINK_ALIAS_FORBIDDEN
    const hardAlias = join(dir, 'legacy-hardlink.sqlite3');
    let hardlinked = false;
    try {
      linkSync(cleanLegacyPath, hardAlias);
      hardlinked = true;
    } catch {
      hardlinked = false;
    }
    if (hardlinked) {
      assert.throws(
        () => inspectLegacyAutopilotBudget(hardAlias, { monthUtc: '2026-10' }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_HARDLINK_ALIAS_FORBIDDEN',
      );
      rmSync(hardAlias, { force: true });
    }

    // P0-09: Summary returned by inspectLegacyAutopilotBudget is deeply frozen & branded
    const summary1 = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-10' });
    assert.equal(Object.isFrozen(summary1), true);
    assert.equal(Object.isFrozen(summary1.tables), true);
    assert.equal(Object.isFrozen(summary1.monthly_reserved_cents_by_month), true);
    assert.equal(summary1.all_months_complete, true);
    assert.equal(summary1.same_month_reserved_cents, 300);
    assert.equal(summary1.monthly_reserved_cents_by_month['2026-10'], 300);
    assert.equal(summary1.monthly_reserved_cents_by_month['2026-11'], 950);
    assert.throws(() => { summary1.unresolved_count = 99; }, TypeError);

    const ledgerAPath = join(dir, 'ledger-a.sqlite');
    const ledgerBPath = join(dir, 'ledger-b.sqlite');
    const ledgerA = new OpenAiBudgetLedger(ledgerAPath, { testMode: true, canonicalRegistryPath: registryPath });
    const ledgerB = new OpenAiBudgetLedger(ledgerBPath, { testMode: true, canonicalRegistryPath: registryPath });
    try {
      // P0-09: Unbranded synthetic clone is rejected on file-backed ledger!
      assert.throws(
        () => ledgerA.reconcileLegacySummary({ ...summary1 }),
        err => err instanceof OpenAiBudgetError && err.code === 'UNVERIFIED_LEGACY_SUMMARY_OBJECT',
      );

      // P0-08: Reconciling summary1 (inspected for '2026-10') imports ALL observed months ('2026-10' AND '2026-11')!
      ledgerA.reconcileLegacySummary(summary1, {
        enable: true,
        monthlyLimitCents: 20_000,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });
      const polA = ledgerA.getPolicy();
      assert.equal(polA.reconciled_snapshot_month_utc, '2026-10');
      assert.equal(polA.legacy_all_months_complete, true);
      assert.equal(polA.legacy_budget_sha256, summary1.snapshot_sha256);

      const novSummaryA = ledgerA.getMonthlySummary({ monthUtc: '2026-11' });
      assert.equal(novSummaryA.legacy_carryover_cents, 950);
      assert.equal(novSummaryA.remaining_cents, 20_000 - 950);

      // P0-09: Fresh inspection advances stamp; replaying older summary1 throws STALE_LEGACY_SUMMARY_REPLAY!
      const summary2 = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-11' });
      ledgerA.reconcileLegacySummary(summary2, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });
      assert.throws(
        () => ledgerA.reconcileLegacySummary(summary1),
        err => err instanceof OpenAiBudgetError && err.code === 'STALE_LEGACY_SUMMARY_REPLAY',
      );

      // P0-07 & P0-08: Non-testMode file-backed ledger forbids custom canonicalRegistryPath AND ignores injected nowFn!
      assert.throws(
        () => new OpenAiBudgetLedger(ledgerAPath, { testMode: false, canonicalRegistryPath: registryPath }),
        err => err instanceof OpenAiPolicyError && err.code === 'CUSTOM_CANONICAL_REGISTRY_FORBIDDEN',
      );
      const spoofedClockLedger = new OpenAiBudgetLedger(ledgerAPath, {
        testMode: false,
        nowFn: () => new Date('2099-01-15T00:00:00Z'),
      });
      try {
        const realSystemYear = new Date().toISOString().slice(0, 4);
        assert.equal(spoofedClockLedger._nowDate().toISOString().slice(0, 4), realSystemYear);
        assert.throws(
          () => spoofedClockLedger.reserveBillableRequest({
            logicalRequestId: 'r2-real-clock-lock',
            monthUtc: '2099-01',
            allowTestClockOverride: true,
            endpoint: '/v1/responses',
            model: 'gpt-6-luna',
            payloadSha256: sha256Hex('clock-lock'),
            reservedCents: 1,
            credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
          }),
          err => err instanceof OpenAiPolicyError && err.code === 'CLOCK_OVERRIDE_FORBIDDEN_ON_LIVE',
        );
      } finally {
        spoofedClockLedger.close();
      }

      // Bind ledgerA into isolated temp registryPath without touching $HOME
      ledgerA.bindCredentialFingerprint('openai-default', sha256Hex(SYNTHETIC_API_KEY));

      // P0-07: Separate ledgerB is blocked from binding EITHER the same credential OR a rotated key on the already-bound account_scope!
      const summaryForB = inspectLegacyAutopilotBudget(cleanLegacyPath, { monthUtc: '2026-11' });
      ledgerB.reconcileLegacySummary(summaryForB, {
        enable: true,
        monthlyLimitCents: 20_000,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });

      const wrappedFetch = async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        async text() { return '{}'; },
      });
      const clientB = new OpenAiClient({
        ledger: ledgerB,
        testMode: true,
        allowEnvKey: true,
        apiKeyEnvVar: 'TEST_OPENAI_KEY',
        env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
        fetchImpl: wrappedFetch,
      });
      await assert.rejects(
        () => clientB.createDecision({
          logical_request_id: 'split-same-key',
          questions: [{ id: 'q1', type: 'predicate', question: 'Split?' }],
          input: 'Check split',
        }),
        err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_LEDGER_SPLIT_FORBIDDEN',
      );

      // Rotated API key on the SAME account_scope ('openai-default') across a second SQLite file is ALSO blocked!
      const clientBRotated = new OpenAiClient({
        ledger: ledgerB,
        testMode: true,
        allowEnvKey: true,
        apiKeyEnvVar: 'TEST_OPENAI_KEY',
        env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY_ALT },
        fetchImpl: wrappedFetch,
      });
      await assert.rejects(
        () => clientBRotated.createDecision({
          logical_request_id: 'split-rotated-key',
          questions: [{ id: 'q1', type: 'predicate', question: 'Rotated split?' }],
          input: 'Check rotated split',
        }),
        err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_LEDGER_SPLIT_FORBIDDEN',
      );
    } finally {
      ledgerA.close();
      ledgerB.close();
    }

    // P0-07: Borrowed :memory: DatabaseSync (bare OR spoofing a file dbPath) is caught via PRAGMA database_list!
    const memDb = new DatabaseSync(':memory:');
    try {
      assert.throws(
        () => new OpenAiBudgetLedger({ db: memDb, dbPath: join(dir, 'spoofed-file.sqlite') }),
        err => err instanceof OpenAiPolicyError && err.code === 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE',
      );
      const bareBorrowedLedger = new OpenAiBudgetLedger(memDb);
      assert.equal(bareBorrowedLedger.testMode, false);
      assert.throws(
        () => bareBorrowedLedger.bindCredentialFingerprint('openai-default', sha256Hex(SYNTHETIC_API_KEY)),
        err => err instanceof OpenAiPolicyError && err.code === 'IN_MEMORY_LEDGER_FORBIDDEN_ON_LIVE',
      );
    } finally {
      memDb.close();
    }

    // P0-10: Promo-zero (posted_billed_cents=0, usage_cost_micros=NULL, reserved_cents=500) AND
    // 0-cent failed/cancelled without confirmed_zero_charge are BOTH flagged unresolved!
    const promoDbPath = join(dir, 'legacy-promo-and-zero-failed.sqlite3');
    const promoDb = new DatabaseSync(promoDbPath);
    promoDb.exec(`
      CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL,
        posted_billed_cents INTEGER,
        usage_cost_micros INTEGER,
        confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
        month_utc TEXT NOT NULL
      );
      INSERT INTO requests VALUES
        ('promo-zero-mask', 'completed', 500, 0, NULL, 0, '2026-11'),
        ('zero-failed-unconfirmed', 'failed', 0, NULL, NULL, 0, '2026-11'),
        ('zero-failed-confirmed', 'failed', 0, 0, 0, 1, '2026-11');
    `);
    promoDb.close();
    const promoInspect = inspectLegacyAutopilotBudget(promoDbPath, { monthUtc: '2026-11' });
    assert.equal(promoInspect.safe_to_reconcile, false);
    assert.equal(promoInspect.unresolved_count, 2);
    assert.deepEqual(
      promoInspect.unresolved_rows.map(r => r.row_id).sort(),
      ['promo-zero-mask', 'zero-failed-unconfirmed'],
    );

    // P0-12: Distinct WAL frames produce distinct composite snapshot_sha256 even before checkpointing main DB
    const walTestPath = join(dir, 'legacy-wal-hash.sqlite3');
    const wDb = new DatabaseSync(walTestPath);
    wDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE requests (id TEXT PRIMARY KEY, status TEXT, reserved_cents INTEGER, month_utc TEXT);
      INSERT INTO requests VALUES ('w1', 'completed', 10, '2026-11');
    `);
    const snapWal1 = inspectLegacyAutopilotBudget(walTestPath, { monthUtc: '2026-11' });
    wDb.exec("INSERT INTO requests VALUES ('w2', 'completed', 25, '2026-11');");
    const snapWal2 = inspectLegacyAutopilotBudget(walTestPath, { monthUtc: '2026-11' });
    wDb.close();
    assert.notEqual(snapWal1.snapshot_sha256, snapWal2.snapshot_sha256);
    assert.equal(snapWal2.same_month_reserved_cents, 35);

    // P1-New: Read-only OpenAiBudgetLedger on a pre-remediation DB lacking cleanup_required /
    // terminal_outcome_status / auto_recharge_off_confirmed succeeds and fences old pending_cleanup rows!
    const oldSchemaDbPath = join(dir, 'pre-migration-readonly.sqlite');
    const oldDb = new DatabaseSync(oldSchemaDbPath);
    oldDb.exec(`
      CREATE TABLE openai_budget_policy (
        account_scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        monthly_limit_cents INTEGER NOT NULL DEFAULT 20000,
        legacy_reconciled INTEGER NOT NULL DEFAULT 1,
        legacy_reconciled_month_utc TEXT,
        legacy_carryover_cents INTEGER NOT NULL DEFAULT 0,
        allow_stage4_media INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE openai_request_ledger (
        attempt_id TEXT PRIMARY KEY,
        logical_request_id TEXT NOT NULL UNIQUE,
        account_scope TEXT NOT NULL,
        month_utc TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        service_tier TEXT NOT NULL DEFAULT 'standard',
        status TEXT NOT NULL,
        cleanup_status TEXT NOT NULL DEFAULT 'not_requested',
        payload_sha256 TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL,
        settled_cents INTEGER,
        usage_cost_micros INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_budget_policy VALUES (
        'openai-default', 1, 20000, 1, '2026-11', 0, 0, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'
      );
      INSERT INTO openai_request_ledger VALUES (
        'att-old-cleanup', 'req-old-cleanup', 'openai-default', '2026-11',
        '/v1/responses', 'gpt-6.1-terra', 'standard', 'completed', 'pending_cleanup',
        '${sha256Hex('old-row')}', 12, 12, 110000, '2026-11-10T00:00:00Z', '2026-11-10T00:00:00Z'
      );
    `);
    oldDb.close();

    const roCompatLedger = openOpenAiBudgetLedger(oldSchemaDbPath, { readOnly: true });
    try {
      const roSummary = roCompatLedger.getMonthlySummary({ monthUtc: '2026-11' });
      assert.equal(roSummary.fenced, true);
      assert.equal(roSummary.fencing_attempts.length, 1);
      assert.equal(roSummary.fencing_attempts[0].cleanup_required, true);
      const roAttempt = roCompatLedger.getAttempt('req-old-cleanup');
      assert.equal(roAttempt.cleanup_required, true);
    } finally {
      roCompatLedger.close();
    }
  });
});

// =============================================================================
// 13. Round 2 ledger & client state-machine invariants, outer-tx lock, bound
//     connection verification (P0-03/P0-18), deleteResponse fencing (P0-05), and 4xx tool cost
// =============================================================================

test('Round 2 state-machine: _migrateSchema cleanup backfill, outer-tx rejection, bound connection lock, public deleteResponse fencing, and 4xx web_search settlement', async () => {
  // P0-04: _migrateSchema backfills old { status: 'completed', cleanup_status: 'pending_cleanup' }
  // to cleanup_required=1, terminal_outcome_status='completed', status='pending_recovery'!
  await withTempDirAsync(async dir => {
    const migPath = join(dir, 'migrate-cleanup-backfill.sqlite');
    const rawDb = new DatabaseSync(migPath);
    rawDb.exec(`
      CREATE TABLE openai_request_ledger (
        attempt_id TEXT PRIMARY KEY,
        logical_request_id TEXT NOT NULL UNIQUE,
        account_scope TEXT NOT NULL,
        month_utc TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        service_tier TEXT NOT NULL DEFAULT 'standard',
        status TEXT NOT NULL,
        cleanup_status TEXT NOT NULL DEFAULT 'not_requested',
        provider_response_id TEXT,
        payload_sha256 TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL,
        settled_cents INTEGER,
        usage_cost_micros INTEGER,
        raw_receipt_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_request_ledger VALUES (
        'att-mig-1', 'req-mig-1', 'openai-default', '2026-11',
        '/v1/responses', 'gpt-6.1-terra', 'standard', 'completed', 'pending_cleanup',
        'resp_mig_1', '${sha256Hex('mig-1')}', 5, 1, 4200, '{"id":"resp_mig_1"}',
        '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z'
      );
    `);
    rawDb.close();

    const migLedger = new OpenAiBudgetLedger(migPath, {
      testMode: true,
      canonicalRegistryPath: join(dir, 'reg.sqlite'),
    });
    try {
      const migrated = migLedger.getAttemptById('att-mig-1');
      assert.equal(migrated.cleanup_required, true);
      assert.equal(migrated.terminal_outcome_status, 'completed');
      assert.equal(migrated.status, 'pending_recovery');
      assert.equal(migLedger.getActiveFences().length, 1);

      const migFp = sha256Hex(SYNTHETIC_API_KEY);
      migLedger.verifyLegacyAttemptConnectionBinding('att-mig-1', {
        apiBaseUrl: 'https://api.openai.com',
        credentialFingerprintSha256: migFp,
        note: 'Verified migrated attempt connection binding.',
      });
      const migRawBytes = Buffer.from('{"id":"resp_mig_1"}', 'utf8');
      migLedger.db.prepare('UPDATE openai_request_ledger SET original_body_sha256 = ?, raw_receipt_sha256 = ? WHERE attempt_id = ?').run(
        sha256Hex(migRawBytes),
        sha256Hex('{"id":"resp_mig_1"}'),
        'att-mig-1',
      );
      migLedger.savePrivatePayload('att-mig-1', 'response_post', migRawBytes);

      migLedger.recordDeleteAcknowledged('att-mig-1', {
        providerResponseId: 'resp_mig_1',
        transportReceipt: {
          method: 'DELETE',
          httpStatus: 200,
          apiBaseUrl: 'https://api.openai.com',
          credentialFingerprintSha256: migFp,
          bodySha256: sha256Hex('{"id":"resp_mig_1","deleted":true}'),
          observedAt: '2026-11-12T00:01:00Z',
          deletedConfirmed: true,
        },
      });
      const restored = migLedger.recordCleanupVerified404('att-mig-1', {
        providerResponseId: 'resp_mig_1',
        transportReceipt: {
          method: 'GET',
          httpStatus: 404,
          apiBaseUrl: 'https://api.openai.com',
          credentialFingerprintSha256: migFp,
          bodySha256: sha256Hex('{"error":{"code":"not_found"}}'),
          observedAt: '2026-11-12T00:01:05Z',
        },
      });
      assert.equal(restored.status, 'completed');
      assert.equal(restored.cleanup_status, 'deleted_verified_404');
      assert.equal(migLedger.getActiveFences().length, 0);
    } finally {
      migLedger.close();
    }
  });

  const ledger = createActivatedMemoryLedger();
  try {
    // P2-10 -> P0: Outer transaction around reserveBillableRequest (both raw BEGIN and nested _withImmediateTx) is rejected!
    assert.throws(
      () => ledger._withImmediateTx(() => ledger.reserveBillableRequest({
        logicalRequestId: 'nested-tx-1',
        endpoint: '/v1/responses',
        model: 'gpt-6-luna',
        payloadSha256: sha256Hex('nested-tx-1'),
        reservedCents: 1,
      })),
      err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_OUTER_TRANSACTION_FORBIDDEN',
    );
    assert.equal(ledger.getAttempt('nested-tx-1'), null);

    // Unique (endpoint, provider_response_id) prevents duplicate response binding across two attempts
    const a1 = ledger.reserveBillableRequest({
      logicalRequestId: 'dup-resp-1',
      endpoint: '/v1/responses',
      model: 'gpt-6-luna',
      payloadSha256: sha256Hex('dup-1'),
      reservedCents: 1,
    });
    ledger.recordTerminalOutcome(a1.attempt_id, {
      status: 'completed',
      providerResponseId: 'resp_unique_shared',
      usageCostMicros: 500,
      rawReceipt: { id: 'resp_unique_shared' },
    });
    const a2 = ledger.reserveBillableRequest({
      logicalRequestId: 'dup-resp-2',
      endpoint: '/v1/responses',
      model: 'gpt-6-luna',
      payloadSha256: sha256Hex('dup-2'),
      reservedCents: 1,
    });
    assert.throws(
      () => ledger.recordTerminalOutcome(a2.attempt_id, {
        status: 'completed',
        providerResponseId: 'resp_unique_shared',
        usageCostMicros: 500,
        rawReceipt: { id: 'resp_unique_shared' },
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'DUPLICATE_PROVIDER_RESPONSE_ID',
    );
    ledger.reconcileAttempt(a2.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'cleanup dup test',
    });

    // P0-13: reconcileAttempt forbids reducing positive usage, status='rejected', and bare failed_known
    const a3 = ledger.reserveBillableRequest({
      logicalRequestId: 'reconcile-guard-1',
      endpoint: '/v1/responses',
      model: 'gpt-6-luna',
      payloadSha256: sha256Hex('rec-guard-1'),
      reservedCents: 3,
    });
    ledger.markPendingRecovery(a3.attempt_id, {
      providerResponseId: 'resp_rec_guard_1',
      provisionalUsageCostMicros: 15_000,
      reason: 'provisional cost recorded',
    });
    assert.throws(
      () => ledger.reconcileAttempt(a3.attempt_id, {
        status: 'completed',
        usageCostMicros: 5_000,
        note: 'Attempt to lower observed provisional usage',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'USAGE_REDUCTION_FORBIDDEN',
    );
    assert.throws(
      () => ledger.reconcileAttempt(a3.attempt_id, {
        status: 'rejected',
        confirmedZeroCharge: true,
        note: 'Forbidden status in reconcileAttempt',
      }),
      err => err instanceof OpenAiValidationError,
    );
    ledger.reconcileAttempt(a3.attempt_id, {
      status: 'completed',
      usageCostMicros: 15_000,
      note: 'Settled at full provisional usage',
    });

    // Bare failed_known without positive usage, provisional usage, or confirmedZeroCharge is rejected!
    const aBare = ledger.reserveBillableRequest({
      logicalRequestId: 'reconcile-bare-failed-known',
      endpoint: '/v1/responses',
      model: 'gpt-6-luna',
      payloadSha256: sha256Hex('rec-bare-fk'),
      reservedCents: 2,
    });
    ledger.markPendingRecovery(aBare.attempt_id, { reason: 'timeout before usage known' });
    assert.throws(
      () => ledger.reconcileAttempt(aBare.attempt_id, {
        status: 'failed_known',
        note: 'Bare failed_known without positive usage or confirmedZeroCharge',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'MISSING_RECONCILIATION_CHARGE_EVIDENCE',
    );
    ledger.reconcileAttempt(aBare.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Verified zero charge on dashboard',
    });

    // P2-03 & PII-safe UUID stress check: recordNotSubmitted enforces accountScope match & generates 250 PII-clean UUIDs
    ledger.recordNotSubmitted({
      logicalRequestId: 'scope-mismatch-ns',
      accountScope: 'openai-default',
      endpoint: '/v1/responses',
      model: 'gpt-6-luna',
      payloadSha256: sha256Hex('scope-ns'),
      reason: 'local preflight rejection',
    });
    assert.throws(
      () => ledger.recordNotSubmitted({
        logicalRequestId: 'scope-mismatch-ns',
        accountScope: 'other-scope',
        endpoint: '/v1/responses',
        model: 'gpt-6-luna',
        payloadSha256: sha256Hex('scope-ns'),
        reason: 'wrong scope replay',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'ATTEMPT_SCOPE_MISMATCH',
    );
    for (let uIdx = 0; uIdx < 250; uIdx++) {
      const nsRow = ledger.recordNotSubmitted({
        logicalRequestId: `uuid-pii-safe-${uIdx}`,
        accountScope: 'openai-default',
        endpoint: '/v1/decisions',
        model: 'gpt-6-luna',
        payloadSha256: sha256Hex(`uuid-${uIdx}`),
        reason: 'uuid check',
      });
      assert.equal(nsRow.status, 'not_submitted');
    }

    // P2-04: getMonthlySummary handles "constructor" status via Object.create(null) on un-CHECKed pre-migration table
    const ctorDb = new DatabaseSync(':memory:');
    try {
      ctorDb.exec(`
        CREATE TABLE openai_request_ledger (
          attempt_id TEXT PRIMARY KEY,
          logical_request_id TEXT NOT NULL UNIQUE,
          account_scope TEXT NOT NULL,
          month_utc TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          model TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_sha256 TEXT NOT NULL,
          reserved_cents INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO openai_request_ledger VALUES (
          'att-ctor-status', 'req-ctor-status', 'openai-default', '2026-11', '/v1/decisions', 'gpt-6-luna',
          'constructor', '${sha256Hex('ctor-st')}', 1, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z'
        );
      `);
      const ctorRoLedger = new OpenAiBudgetLedger(ctorDb, { readOnly: true, testMode: true });
      const ctorSummary = ctorRoLedger.getMonthlySummary({ monthUtc: '2026-11' });
      assert.equal(Object.getPrototypeOf(ctorSummary.status_counts), null);
      assert.equal(ctorSummary.status_counts.constructor, 1);
    } finally {
      ctorDb.close();
    }

    // Simulate legacy cross-column collision where row X has attempt_id === 'shared-token' and row Y has logical_request_id === 'shared-token'
    ledger.db.prepare(`
      INSERT INTO openai_request_ledger (
        attempt_id, logical_request_id, account_scope, month_utc, endpoint, model,
        service_tier, status, payload_sha256, reserved_cents, posted_billed_cents,
        confirmed_zero_charge, created_at, updated_at
      ) VALUES
        ('shared-token', 'logical-other-a', 'openai-default', '2026-11', '/v1/decisions', 'gpt-6-luna', 'standard', 'not_submitted', '${sha256Hex('c1')}', 0, 0, 1, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z'),
        ('att-other-b', 'shared-token', 'openai-default', '2026-11', '/v1/decisions', 'gpt-6-luna', 'standard', 'not_submitted', '${sha256Hex('c2')}', 0, 0, 1, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z')
    `).run();
    assert.throws(
      () => ledger.getAttempt('shared-token'),
      err => err instanceof OpenAiBudgetError && err.code === 'AMBIGUOUS_ATTEMPT_SELECTOR',
    );

    // P0-05, P0-03, P0-18, P0-New, P1-New: Client connection binding, pre-reservation stream/store checks,
    // public deleteResponse fencing, and 4xx web_search settlement
    let readback404 = false;
    let fetchCalls = 0;
    const client = new OpenAiClient({
      ledger,
      testMode: true,
      baseUrl: 'https://api.openai.com',
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        fetchCalls++;
        const u = String(url);
        const method = init?.method ?? 'GET';
        if (method === 'POST' && u.endsWith('/v1/responses')) {
          const parsed = JSON.parse(String(init.body));
          if (parsed.input === 'trigger_400_with_web_search') {
            return {
              status: 400,
              ok: false,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() {
                return JSON.stringify({
                  id: 'resp_err_ws_400',
                  model: 'gpt-6.1-terra',
                  output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }],
                  usage: { input_tokens: 1_000, output_tokens: 100 },
                  error: { message: 'Post-tool policy guard rejected output', type: 'invalid_request_error' },
                });
              },
            };
          }
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              return JSON.stringify({
                id: 'resp_public_del_1',
                model: 'gpt-6.1-terra',
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'Stored response' }] }],
                usage: { input_tokens: 500, output_tokens: 100 },
              });
            },
          };
        }
        if (method === 'DELETE' && u.endsWith('/v1/responses/resp_public_del_1')) {
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() { return JSON.stringify({ id: 'resp_public_del_1', deleted: true }); },
          };
        }
        if (method === 'GET' && u.endsWith('/v1/responses/resp_public_del_1')) {
          if (!readback404) {
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() {
                return JSON.stringify({
                  id: 'resp_public_del_1',
                  model: 'gpt-6.1-terra',
                  status: 'completed',
                  output: [{ type: 'message', content: [{ type: 'output_text', text: 'Still lingering' }] }],
                  usage: { input_tokens: 500, output_tokens: 100 },
                });
              },
            };
          }
          return {
            status: 404,
            ok: false,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() { return JSON.stringify({ error: { message: 'Not found' } }); },
          };
        }
        throw new Error(`Unexpected request: ${method} ${u}`);
      },
    });

    // P1-New: stream: true and { store: false } + { deleteAfterPersist: true } rejected pre-reservation
    await assert.rejects(
      () => client.createResponse({
        logical_request_id: 'stream-blocked',
        model: 'gpt-6.1-terra',
        reasoning: { effort: 'xhigh' },
        stream: true,
        input: 'No SSE',
        max_output_tokens: 128,
      }),
      err => err instanceof OpenAiValidationError && err.code === 'STREAMING_UNSUPPORTED',
    );
    await assert.rejects(
      () => client.createResponse(
        {
          logical_request_id: 'store-false-del-conflict',
          model: 'gpt-6.1-terra',
          reasoning: { effort: 'xhigh' },
          store: false,
          input: 'Conflict',
          max_output_tokens: 128,
        },
        { deleteAfterPersist: true },
      ),
      err => err instanceof OpenAiValidationError && err.code === 'INCOMPATIBLE_STORE_CLEANUP_MODE',
    );
    assert.equal(ledger.getAttempt('stream-blocked'), null);
    assert.equal(ledger.getAttempt('store-false-del-conflict'), null);

    // P0-New: 400 error carrying usage + web_search_call charges the $0.01 (10_000 micros) tool fee!
    const sumBefore400 = ledger.getMonthlySummary({ monthUtc: '2026-11' });
    await assert.rejects(
      () => client.createResponse({
        logical_request_id: 'err-400-ws-fee',
        model: 'gpt-6.1-terra',
        reasoning: { effort: 'xhigh' },
        tools: [{ type: 'web_search', max_tool_calls: 2 }],
        input: 'trigger_400_with_web_search',
        max_output_tokens: 4_096,
      }),
      err => err instanceof OpenAiHttpError && err.http_status === 400,
    );
    const wsErrRow = ledger.getAttempt('err-400-ws-fee');
    assert.equal(wsErrRow.status, 'rejected');
    // 1000 in ($0.001 = 1000 micros) + 100 out ($0.0005 = 500 micros) + 1 web_search ($0.01 = 10000 micros) = 11_500 micros!
    assert.equal(wsErrRow.usage_cost_micros, 11_500);
    assert.equal(wsErrRow.confirmed_zero_charge, false);
    const sumAfter400 = ledger.getMonthlySummary({ monthUtc: '2026-11' });
    assert.equal(sumAfter400.same_month_known_usage_micros, sumBefore400.same_month_known_usage_micros + 11_500);
    assert.equal(sumAfter400.effective_committed_cents > sumBefore400.effective_committed_cents, true);

    // P0-05: Public deleteResponse on an initially completed attempt transitions to pending_recovery BEFORE DELETE!
    const createdPub = await client.createResponse({
      logical_request_id: 'pub-del-test',
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'xhigh' },
      input: 'Create stored response',
      max_output_tokens: 4_096,
    });
    assert.equal(createdPub.status, 'completed');

    // P0-03 & P0-18: Wrong credential or wrong origin is blocked BEFORE any network call on deleteResponse / retrieveResponse / recoverPendingResponse!
    const callsBeforeMismatch = fetchCalls;
    await assert.rejects(
      () => client.deleteResponse('resp_public_del_1', {
        attemptId: createdPub.attempt_id,
        env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY_ALT },
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_MISMATCH_ON_RECOVERY',
    );
    const altOriginClient = new OpenAiClient({
      ledger,
      testMode: true,
      baseUrl: 'http://127.0.0.1:18080',
      allowCustomBaseUrl: true,
      allowInsecureLocalBaseUrl: true,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async () => { throw new Error('Must not dispatch on origin mismatch'); },
    });
    await assert.rejects(
      () => altOriginClient.retrieveResponse('resp_public_del_1', { attemptId: createdPub.attempt_id }),
      err => err instanceof OpenAiPolicyError && err.code === 'ORIGIN_MISMATCH_ON_RECOVERY',
    );
    assert.equal(fetchCalls, callsBeforeMismatch);

    // First deleteResponse: DELETE 200, readback GET 200 -> row MUST be fenced in pending_recovery with cleanup_required=true!
    readback404 = false;
    const del1 = await client.deleteResponse('resp_public_del_1', { attemptId: createdPub.attempt_id });
    assert.equal(del1.verified_404, false);
    const afterFailedDel = ledger.getAttemptById(createdPub.attempt_id);
    assert.equal(afterFailedDel.status, 'pending_recovery');
    assert.equal(afterFailedDel.cleanup_required, true);
    assert.equal(afterFailedDel.terminal_outcome_status, 'completed');
    assert.equal(afterFailedDel.cleanup_status, 'delete_failed');

    // Also verify recoverPendingResponse rejects wrong credential with 0 network calls
    const callsBeforeRecoverMismatch = fetchCalls;
    await assert.rejects(
      () => client.recoverPendingResponse(createdPub.attempt_id, {
        env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY_ALT },
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_MISMATCH_ON_RECOVERY',
    );
    assert.equal(fetchCalls, callsBeforeRecoverMismatch);

    // Retry recoverPendingResponse when GET returns 404 -> verifies 404 after prior DELETE ack and restores 'completed'!
    readback404 = true;
    const recAfter404 = await client.recoverPendingResponse(createdPub.attempt_id);
    assert.equal(recAfter404.recovered, true);
    assert.equal(recAfter404.status, 'completed');
    assert.equal(recAfter404.fenced, false);
    assert.equal(ledger.getAttemptById(createdPub.attempt_id).cleanup_status, 'deleted_verified_404');
  } finally {
    ledger.close();
  }
});

// =============================================================================
// 14. Round 2 Batch upload receipts, mid-upload revocation, line_specs validation,
//     plain-text base64 token accounting, Decisions/Responses schema strictness, and forensic digests
// =============================================================================

test('Round 2 Batch, Decisions, Responses, & Forensics: upload receipts, mid-upload revocation, lineSpecs, verbatim text accounting, inner error/schema guards, and recovery_history', async () => {
  // P0-15: Plain input_text starting with 'data:image/png;base64,...' is counted verbatim as text bytes,
  // whereas an { type: 'input_image' } block strips base64 bytes and uses IMAGE_LOW_DETAIL_TOKEN_BOUND (2_048)!
  const longBase64Payload = buildPaddedValidPngBase64(1, 1, 16_000);
  const longBase64LikeText = `data:image/png;base64,${longBase64Payload}`;
  const textTokens = estimateResponsesInputTokens({
    model: 'gpt-6.1-terra',
    input: [{ role: 'user', content: [{ type: 'input_text', text: longBase64LikeText }] }],
  });
  assert.equal(textTokens > 20_000, true);

  const imageNodeTokens = estimateResponsesInputTokens({
    model: 'gpt-6.1-terra',
    input: [{
      role: 'user',
      content: [{ type: 'input_image', detail: 'low', image_url: `data:image/png;base64,${longBase64Payload}` }],
    }],
  });
  assert.equal(imageNodeTokens < 3_000, true);

  // P0-15: /v1/decisions reserves 256 output tokens per question when maxOutputTokens is omitted
  const decBreak = estimateCostBreakdown({
    endpoint: '/v1/decisions',
    model: 'gpt-6-luna',
    estimatedInputTokens: 1_000,
    questionCount: 4,
  });
  // 1000 * $0.125/1M = 125 micros; (4 * 256 = 1024) * $0.50/1M = 512 micros -> 637 micros
  assert.equal(decBreak.estimated_micros, 637);

  // P0-22 & P2-04: parseBatchOutputJsonl rejects secret in custom_id, preserves 'constructor' custom_id,
  // validates lineSpecs image count & PNG vs JPEG magic bytes, and derives usable_count strictly from usable===true!
  assert.throws(
    () => parseBatchOutputJsonl(JSON.stringify({
      custom_id: `item-${SYNTHETIC_API_KEY}`,
      response: { status_code: 200, body: { id: 'r1', model: 'gpt-6.1-terra', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    })),
    err => err instanceof OpenAiPolicyError && err.code === 'SECRET_IN_PROTOCOL_IDENTIFIER',
  );

  const builtImgBatch = buildBatchJsonl([
    {
      custom_id: 'constructor',
      url: '/v1/images/generations',
      body: { model: 'gpt-image-2.6-sunburst', prompt: 'Bamboo organizer', n: 2, output_format: 'png' },
    },
    {
      custom_id: 'img-wrong-magic',
      url: '/v1/images/generations',
      body: { model: 'gpt-image-2.6-sunburst', prompt: 'Silicone mat', n: 1, output_format: 'png' },
    },
  ], { endpoint: '/v1/images/generations' });

  const imgBatchOutJsonl = [
    // Line 1 ('constructor'): expected n=2 PNGs, got only 1 PNG -> usable: false, content_status: 'invalid'
    JSON.stringify({
      custom_id: 'constructor',
      response: {
        status_code: 200,
        body: {
          data: [{ b64_json: VALID_1X1_PNG_B64 }],
          usage: { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } },
        },
      },
    }),
    // Line 2 ('img-wrong-magic'): expected PNG, got JPEG bytes -> usable: false, content_status: 'invalid'
    JSON.stringify({
      custom_id: 'img-wrong-magic',
      response: {
        status_code: 200,
        body: {
          data: [{ b64_json: VALID_JPEG_B64 }],
          usage: { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } },
        },
      },
    }),
  ].join('\n');

  const parsedImgBatch = parseBatchOutputJsonl(imgBatchOutJsonl, {
    expectedEndpoint: '/v1/images/generations',
    lineModels: builtImgBatch.line_models,
    lineSpecs: builtImgBatch.line_specs,
  });
  assert.equal(Object.getPrototypeOf(parsedImgBatch.by_custom_id), null);
  assert.equal(parsedImgBatch.by_custom_id.constructor.usable, false);
  assert.equal(parsedImgBatch.by_custom_id['img-wrong-magic'].usable, false);
  assert.equal(parsedImgBatch.usable_count, 0);
  assert.equal(parsedImgBatch.content_status, 'invalid');
  assert.equal(parsedImgBatch.has_unknown_usage, false);

  // Batch upload receipts (P0-01), mid-upload Stage-4 revocation (P0-19/P1-02), post-upload error catch (P1-New),
  // retrieveBatch endpoint/input_file_id/in_progress checks (P0-02), concurrent retrieveBatch (P2-New),
  // Responses/Decisions strictness (P1-01/P2-New), secret key scrubbing (P0-22), and forensic digests (P0-24)
  const ledger = createActivatedMemoryLedger({ allowStage4Media: true });
  try {
    let stage = 'upload_and_submit';
    let revokeStage4OnUpload = false;
    let batchesPostCount = 0;

    const client = new OpenAiClient({
      ledger,
      testMode: true,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        const u = String(url);
        const method = init?.method ?? 'GET';

        if (method === 'POST' && u.endsWith('/v1/files')) {
          if (revokeStage4OnUpload) {
            ledger.configurePolicy({ allowStage4Media: false });
          }
          if (stage === 'upload_oversize_error') {
            const hugeChunk = Buffer.alloc(17 * 1024 * 1024, 0x61);
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              body: {
                async *[Symbol.asyncIterator]() {
                  yield hugeChunk;
                },
              },
            };
          }
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              const id = stage === 'revoke_stage4' ? 'file_revoked_s4' : 'file_bound_r2_1';
              return JSON.stringify({ id, object: 'file', purpose: 'batch' });
            },
          };
        }

        if (method === 'POST' && u.endsWith('/v1/batches')) {
          batchesPostCount++;
          const wire = JSON.parse(String(init.body));
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              return JSON.stringify({
                id: 'batch_r2_1',
                object: 'batch',
                endpoint: wire.endpoint,
                input_file_id: wire.input_file_id,
                status: 'validating',
              });
            },
          };
        }

        if (method === 'GET' && u.endsWith('/v1/batches/batch_r2_1')) {
          if (stage === 'batch_wrong_endpoint') {
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() {
                return JSON.stringify({
                  id: 'batch_r2_1',
                  endpoint: '/v1/images/generations',
                  input_file_id: 'file_bound_r2_1',
                  status: 'completed',
                  output_file_id: 'file_out_r2_1',
                  request_counts: { total: 1, completed: 1, failed: 0 },
                });
              },
            };
          }
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              return JSON.stringify({
                id: 'batch_r2_1',
                endpoint: '/v1/responses',
                input_file_id: 'file_bound_r2_1',
                status: 'completed',
                output_file_id: 'file_out_r2_1',
                request_counts: { total: 1, completed: 1, failed: 0 },
              });
            },
          };
        }

        if (method === 'GET' && u.endsWith('/v1/files/file_out_r2_1/content')) {
          if (stage === 'batch_line_in_progress') {
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/jsonl' }),
              async text() {
                return JSON.stringify({
                  custom_id: 'c1',
                  response: {
                    status_code: 200,
                    body: {
                      id: 'resp_b_1',
                      model: 'gpt-6.1-terra',
                      status: 'in_progress',
                      output: [],
                      usage: { input_tokens: 100, output_tokens: 0 },
                    },
                  },
                });
              },
            };
          }
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/jsonl' }),
            async text() {
              return JSON.stringify({
                custom_id: 'c1',
                response: {
                  status_code: 200,
                  body: {
                    id: 'resp_b_1',
                    model: 'gpt-6.1-terra',
                    status: 'completed',
                    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
                    usage: { input_tokens: 100, output_tokens: 20 },
                  },
                },
              });
            },
          };
        }

        if (method === 'POST' && u.endsWith('/v1/decisions')) {
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              if (stage === 'decisions_constructor_key') {
                return JSON.stringify({
                  id: 'dec_ctor_1',
                  model: 'gpt-6-luna',
                  decisions: [
                    { id: 'constructor', type: 'predicate', value: true, probability: 0.9 },
                    { id: 'toString', type: 'score', value: 80 },
                  ],
                  usage: { input_tokens: 100, output_tokens: 20 },
                });
              }
              return JSON.stringify({
                id: 'dec_invalid_ans',
                model: 'gpt-6-luna',
                decisions: [
                  { id: 'q_choice', type: 'choice', value: 'invented_option', choice_probabilities: { pass: 0.5, reject: 0.5 } },
                ],
                usage: { input_tokens: 100, output_tokens: 20 },
              });
            },
          };
        }

        if (method === 'POST' && u.endsWith('/v1/responses')) {
          if (stage === 'resp_502_with_secret_key') {
            return {
              status: 502,
              ok: false,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() {
                return JSON.stringify({
                  id: 'resp_forensic_1',
                  [SYNTHETIC_API_KEY]: 'leaked_in_key',
                  error: { message: `Upstream error with ${SYNTHETIC_API_KEY}` },
                });
              },
            };
          }
          if (stage === 'resp_inner_part_error') {
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() {
                return JSON.stringify({
                  id: 'resp_inner_err_1',
                  model: 'gpt-6.1-terra',
                  status: 'completed',
                  output: [{
                    type: 'message',
                    content: [
                      { type: 'output_text', text: '{"verdict":"good"}' },
                      { type: 'error', error: { message: 'stream truncated' } },
                    ],
                  }],
                  usage: { input_tokens: 100, output_tokens: 20 },
                });
              },
            };
          }
          if (stage === 'resp_bad_json_schema') {
            return {
              status: 200,
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              async text() {
                return JSON.stringify({
                  id: 'resp_bad_schema_1',
                  model: 'gpt-6.1-terra',
                  status: 'completed',
                  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"wrong_key":1}' }] }],
                  usage: { input_tokens: 100, output_tokens: 20 },
                });
              },
            };
          }
        }

        if (method === 'GET' && u.endsWith('/v1/responses/resp_forensic_1')) {
          return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            async text() {
              return JSON.stringify({
                id: 'resp_forensic_1',
                model: 'gpt-6.1-terra',
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'Recovered cleanly' }] }],
                usage: { input_tokens: 100, output_tokens: 20 },
              });
            },
          };
        }

        throw new Error(`Unexpected request in Test 14: ${method} ${u} (stage=${stage})`);
      },
    });

    // P2-New & P0-01: Empty input_file_id rejected pre-reservation; unbound input_file_id rejected with UNBOUND_BATCH_INPUT_FILE
    await assert.rejects(
      () => client.submitBatch({ logical_request_id: 'b-empty-id', input_file_id: '' }),
      err => err instanceof OpenAiValidationError,
    );
    assert.equal(ledger.getAttempt('b-empty-id'), null);

    await assert.rejects(
      () => client.submitBatch({ logical_request_id: 'b-unbound-id', input_file_id: 'file_unbound_999' }),
      err => err instanceof OpenAiPolicyError && err.code === 'UNBOUND_BATCH_INPUT_FILE',
    );
    assert.equal(ledger.getAttempt('b-unbound-id'), null);

    // P0-01: uploadBatchFile records durable receipt in openai_batch_uploads so submitBatch({ input_file_id }) succeeds!
    stage = 'upload_and_submit';
    const uploaded = await client.uploadBatchFile({
      endpoint: '/v1/responses',
      requests: [{
        custom_id: 'c1',
        url: '/v1/responses',
        body: {
          model: 'gpt-6.1-terra',
          reasoning: { effort: 'xhigh' },
          input: 'Verify batch upload binding',
          max_output_tokens: 4_096,
          text: {
            format: {
              type: 'json_schema',
              name: 'res',
              strict: true,
              schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
            },
          },
        },
      }],
    });
    assert.equal(uploaded.input_file_id, 'file_bound_r2_1');

    const submitted = await client.submitBatch({
      logical_request_id: 'b-bound-submit',
      input_file_id: 'file_bound_r2_1',
      endpoint: '/v1/responses',
    });
    assert.equal(submitted.batch_id, 'batch_r2_1');
    assert.equal(typeof submitted.batch_manifest.batch_post_sha256, 'string');
    assert.equal(submitted.batch_manifest.batch_post_sha256.length, 64);

    // P0-03 & P0-18: retrieveBatch blocks mismatched credential before network call
    await assert.rejects(
      () => client.retrieveBatch('batch_r2_1', {
        attemptId: submitted.attempt_id,
        env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY_ALT },
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'CREDENTIAL_MISMATCH_ON_RECOVERY',
    );

    // P0-02: retrieveBatch holds in pending_recovery when provider endpoint mismatches manifest OR line is in_progress
    stage = 'batch_wrong_endpoint';
    const wrongEpRes = await client.retrieveBatch('batch_r2_1', {
      attemptId: submitted.attempt_id,
      downloadOutput: true,
    });
    assert.equal(wrongEpRes.ok, false);
    assert.equal(wrongEpRes.status, 'pending_recovery');
    assert.equal(wrongEpRes.fenced, true);

    stage = 'batch_line_in_progress';
    const inProgLineRes = await client.retrieveBatch('batch_r2_1', {
      attemptId: submitted.attempt_id,
      downloadOutput: true,
    });
    assert.equal(inProgLineRes.ok, false);
    assert.equal(inProgLineRes.status, 'pending_recovery');
    assert.equal(inProgLineRes.fenced, true);

    // P2-New: Concurrent retrieveBatch({ downloadOutput: true }) calls settle idempotently without throwing!
    stage = 'batch_complete_ok';
    const [conc1, conc2] = await Promise.all([
      client.retrieveBatch('batch_r2_1', { attemptId: submitted.attempt_id, downloadOutput: true }),
      client.retrieveBatch('batch_r2_1', { attemptId: submitted.attempt_id, downloadOutput: true }),
    ]);
    assert.equal(conc1.ok, true);
    assert.equal(conc2.ok, true);
    assert.equal(conc1.status, 'completed');
    assert.equal(conc2.status, 'completed');
    assert.equal(conc1.fenced, false);

    // P0-19 & P1-02: Revoking allowStage4Media mid-upload aborts POST /v1/batches via claimBatchCreationStage!
    stage = 'revoke_stage4';
    revokeStage4OnUpload = true;
    const postCountBeforeRevoke = batchesPostCount;
    await assert.rejects(
      () => client.submitBatch(
        {
          logical_request_id: 'b-revoke-mid-upload',
          endpoint: '/v1/images/generations',
          requests: [{
            custom_id: 'img-1',
            url: '/v1/images/generations',
            body: { model: 'gpt-image-2.6-sunburst', prompt: 'Desk lamp', n: 1 },
          }],
        },
        { enableStage4Media: true },
      ),
      err => err instanceof OpenAiPolicyError && err.code === 'STAGE4_MEDIA_DISABLED' && err.not_dispatched === false,
    );
    assert.equal(batchesPostCount, postCountBeforeRevoke);
    const revokedRow = ledger.getAttempt('b-revoke-mid-upload');
    assert.equal(revokedRow.status, 'rejected');
    assert.equal(revokedRow.confirmed_zero_charge, true);
    revokeStage4OnUpload = false;
    ledger.configurePolicy({ allowStage4Media: true });

    // P1-New & P2-09: Async-iterable oversized response during submitBatch moves attempt out of in_progress to pending_recovery with attempt_id!
    stage = 'upload_oversize_error';
    let caughtOversize = null;
    await assert.rejects(
      async () => {
        try {
          await client.submitBatch({
            logical_request_id: 'b-oversize-upload',
            endpoint: '/v1/responses',
            requests: [{
              custom_id: 'c-over',
              url: '/v1/responses',
              body: { model: 'gpt-6.1-terra', reasoning: { effort: 'xhigh' }, input: 'Test', max_output_tokens: 4_096 },
            }],
          });
        } catch (err) {
          caughtOversize = err;
          throw err;
        }
      },
      err => err instanceof OpenAiAmbiguousOutcomeError && err.code === 'RESPONSE_BODY_TOO_LARGE',
    );
    assert.equal(typeof caughtOversize?.attempt_id, 'string');
    assert.equal(ledger.getAttempt('b-oversize-upload').status, 'pending_recovery');
    ledger.reconcileAttempt('b-oversize-upload', {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared oversized upload mock fence.',
    });

    // P2-New & P2-04: Decisions validates answer choice domain & preserves 'constructor'/'toString' question IDs
    stage = 'decisions_bad_choice';
    const badDec = await client.createDecision({
      logical_request_id: 'dec-bad-choice',
      questions: [{ id: 'q_choice', type: 'choice', options: ['pass', 'reject'], question: 'Select' }],
      input: 'Check choice domain',
    });
    assert.equal(badDec.usable, false);
    assert.equal(badDec.content_status, 'invalid');

    stage = 'decisions_constructor_key';
    const ctorDec = await client.createDecision({
      logical_request_id: 'dec-ctor-keys',
      questions: [
        { id: 'constructor', type: 'predicate', question: 'Predicate?' },
        { id: 'toString', type: 'score', min: 0, max: 100, question: 'Score?' },
      ],
      input: 'Check prototype-named IDs',
    });
    assert.equal(ctorDec.usable, true);
    assert.equal(Object.getPrototypeOf(ctorDec.by_question_id), null);
    assert.equal(ctorDec.by_question_id.constructor.value, true);
    assert.equal(ctorDec.by_question_id.toString.value, 80);

    // P1-01: Responses completed envelope with inner part.error OR json_schema missing required field -> usable: false, content_status: 'invalid'
    stage = 'resp_inner_part_error';
    const innerErrResp = await client.createResponse({
      logical_request_id: 'resp-inner-err',
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'xhigh' },
      input: 'Check inner error part',
      max_output_tokens: 4_096,
    });
    assert.equal(innerErrResp.usable, false);
    assert.equal(innerErrResp.content_status, 'invalid');

    stage = 'resp_bad_json_schema';
    const badSchemaResp = await client.createResponse({
      logical_request_id: 'resp-bad-schema',
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'xhigh' },
      input: 'Check schema required field',
      max_output_tokens: 4_096,
      text: {
        format: {
          type: 'json_schema',
          name: 'verdict_obj',
          strict: true,
          schema: {
            type: 'object',
            properties: { verdict: { type: 'string' } },
            required: ['verdict'],
            additionalProperties: false,
          },
        },
      },
    });
    assert.equal(badSchemaResp.usable, false);
    assert.equal(badSchemaResp.content_status, 'invalid');

    // P0-22 & P0-24: Secret in JSON property key is scrubbed before SQLite storage; original_body_sha256
    // records pre-scrub wire digest, and recovery_history preserves prior 502 digest after GET 200 recovery!
    stage = 'resp_502_with_secret_key';
    await assert.rejects(
      () => client.createResponse({
        logical_request_id: 'resp-forensic-502',
        model: 'gpt-6.1-terra',
        reasoning: { effort: 'xhigh' },
        input: 'Trigger 502 with secret in property key',
        max_output_tokens: 4_096,
      }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.http_status === 502,
    );
    const row502 = ledger.getAttempt('resp-forensic-502');
    assert.equal(row502.status, 'pending_recovery');
    assert.equal(typeof row502.original_body_sha256, 'string');
    assert.equal(typeof row502.raw_body_sha256, 'string');
    assert.notEqual(row502.original_body_sha256, row502.raw_body_sha256);
    assert.equal(JSON.stringify(row502.raw_receipt).includes(SYNTHETIC_API_KEY), false);

    const first502OriginalSha = row502.original_body_sha256;
    const recoveredForensic = await client.recoverPendingResponse('resp-forensic-502');
    assert.equal(recoveredForensic.recovered, true);
    assert.equal(recoveredForensic.status, 'completed');
    const rowAfterRecover = ledger.getAttempt('resp-forensic-502');
    assert.equal(Array.isArray(rowAfterRecover.recovery_history), true);
    assert.equal(rowAfterRecover.recovery_history.length >= 1, true);
    assert.equal(rowAfterRecover.recovery_history[0].original_body_sha256, first502OriginalSha);
  } finally {
    ledger.close();
  }
});

// =============================================================================
// 15. Round 3 Verification: Test/Live Isolation, Canonical Registry Inode/Relocation/Non-Pollution,
//     Legacy Source Pinning, Snapshot Re-Verification, Pre-Migration settled_cents, & Streaming Cap
// =============================================================================

test('Round 3 ledger & isolation: live/test separation, canonical inode replacement, rotateOrRelocate, non-pollution, legacy pinning, snapshot re-verify, and pre-migration settled_cents', async () => {
  await withTempDirAsync(async dir => {
    const regPath = join(dir, 'r3-canonical-reg.sqlite');
    const legacyPath1 = join(dir, 'legacy-src-1.sqlite3');
    const legacyPath2 = join(dir, 'legacy-src-2.sqlite3');

    // Seed legacyPath1 and legacyPath2
    for (const [p, cents] of [[legacyPath1, 400], [legacyPath2, 100]]) {
      const db = new DatabaseSync(p);
      db.exec(`
        CREATE TABLE requests (
          request_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          reserved_cents INTEGER NOT NULL,
          posted_billed_cents INTEGER NOT NULL,
          usage_cost_micros INTEGER NOT NULL,
          month_utc TEXT NOT NULL
        );
        INSERT INTO requests VALUES ('r1', 'completed', ${cents}, ${cents}, ${cents * 10_000}, '2026-11');
      `);
      db.close();
    }

    // 1) P0-07 / P0-08: Test-mode ledger or client forbids real globalThis.fetch; live client forbids test ledger!
    const memLedger = createActivatedMemoryLedger();
    try {
      assert.throws(
        () => new OpenAiClient({ ledger: memLedger }),
        err => err instanceof OpenAiPolicyError && err.code === 'TEST_MODE_FORBIDS_LIVE_NETWORK_FETCH',
      );
      assert.throws(
        () => new OpenAiClient({ testMode: true }),
        err => err instanceof OpenAiPolicyError && err.code === 'TEST_MODE_FORBIDS_LIVE_NETWORK_FETCH',
      );
      assert.throws(
        () => new OpenAiClient({
          ledger: memLedger,
          testMode: false,
          fetchImpl: async () => makeJsonFetchResponse(200, {}),
        }),
        err => err instanceof OpenAiPolicyError && err.code === 'TEST_LEDGER_FORBIDDEN_ON_LIVE_CLIENT',
      );
    } finally {
      memLedger.close();
    }

    // 2) P0-07 / P0-08: UNVERIFIED_SYNTHETIC_BASELINE on production file-backed ledger & CUSTOM_CANONICAL_REGISTRY_FORBIDDEN
    const prodLikePath = join(dir, 'prod-baseline-check.sqlite');
    assert.throws(
      () => reconcileLegacyBudgetIntoStore(prodLikePath, legacyPath1, {
        testMode: false,
        canonicalRegistryPath: regPath,
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'CUSTOM_CANONICAL_REGISTRY_FORBIDDEN',
    );
    const prodLedger = new OpenAiBudgetLedger(prodLikePath, { testMode: false });
    try {
      assert.throws(
        () => prodLedger.reconcileLegacySummary({
          recognized_schema: true,
          file_sha256: '1'.repeat(64),
          month_utc: '2026-11',
          total_rows: 0,
          status_counts: {},
          unresolved_count: 0,
          blocking_reasons: [],
          has_unresolved_holds: false,
          same_month_reserved_cents: 0,
        }, { allowSyntheticSummaryForTests: true }),
        err => err instanceof OpenAiPolicyError && err.code === 'UNVERIFIED_SYNTHETIC_BASELINE',
      );
      assert.throws(
        () => prodLedger.configurePolicy({
          enabled: true,
          autoRechargeOffConfirmed: true,
          hardMonthlyLimitConfirmed: true,
        }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_NOT_RECONCILED',
      );
      // Defense-in-depth: even if a DB row has legacy_reconciled=1 with synthetic_test_only/unreconciled baseline_mode,
      // production configurePolicy(enabled: true) rejects it with UNVERIFIED_SYNTHETIC_BASELINE!
      prodLedger.db.prepare(`
        INSERT INTO openai_budget_policy (
          account_scope, enabled, monthly_limit_cents, auto_recharge_off_confirmed,
          hard_monthly_limit_confirmed, allow_stage4_media, legacy_reconciled,
          baseline_mode, created_at, updated_at
        ) VALUES ('openai-default', 0, 20000, 1, 1, 0, 1, 'synthetic_test_only', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')
      `).run();
      assert.throws(
        () => prodLedger.configurePolicy({
          enabled: true,
          autoRechargeOffConfirmed: true,
          hardMonthlyLimitConfirmed: true,
        }),
        err => err instanceof OpenAiPolicyError && err.code === 'UNVERIFIED_SYNTHETIC_BASELINE',
      );
    } finally {
      prodLedger.close();
    }

    // 3) P0-11 & P0-12: canonicalRegistryPath colliding with legacy source, ledger DB, or non-registry SQLite DB is blocked BEFORE mutation!
    const existingAppDbPath = join(dir, 'existing-app-data.sqlite');
    const appDb = new DatabaseSync(existingAppDbPath);
    appDb.exec('CREATE TABLE precious_items (id TEXT PRIMARY KEY); INSERT INTO precious_items VALUES (\'keep-me\');');
    appDb.close();
    const beforeAppSha = sha256Hex(readFileSync(existingAppDbPath));

    assert.throws(
      () => reconcileLegacyBudgetIntoStore(join(dir, 'dest-col.sqlite'), legacyPath1, {
        testMode: true,
        canonicalRegistryPath: legacyPath1,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );
    assert.throws(
      () => new OpenAiBudgetLedger(join(dir, 'dest-col-2.sqlite'), {
        testMode: true,
        canonicalRegistryPath: join(dir, 'dest-col-2.sqlite'),
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
    );
    const nonRegLedger = new OpenAiBudgetLedger(join(dir, 'dest-col-3.sqlite'), {
      testMode: true,
      canonicalRegistryPath: existingAppDbPath,
    });
    try {
      assert.throws(
        () => nonRegLedger.bindCredentialFingerprint('openai-default', sha256Hex(SYNTHETIC_API_KEY)),
        err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_DESTINATION_COLLISION',
      );
      assert.equal(sha256Hex(readFileSync(existingAppDbPath)), beforeAppSha);
    } finally {
      nonRegLedger.close();
    }

    // Read-only constructor rejects nlink > 1 hardlink alias (LEDGER_HARDLINK_ALIAS_FORBIDDEN)
    const roTargetPath = join(dir, 'ro-target.sqlite');
    const roInit = new OpenAiBudgetLedger(roTargetPath, { testMode: true, canonicalRegistryPath: regPath });
    roInit.close();
    const roHardlink = join(dir, 'ro-hardlink.sqlite');
    let linkedRo = false;
    try {
      linkSync(roTargetPath, roHardlink);
      linkedRo = true;
    } catch {
      linkedRo = false;
    }
    if (linkedRo) {
      assert.throws(
        () => new OpenAiBudgetLedger(roHardlink, { readOnly: true }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_HARDLINK_ALIAS_FORBIDDEN',
      );
      rmSync(roHardlink, { force: true });
    }

    // 4) P1-36: Disabled ledger or credential-mismatch rejection does NOT pollute canonical registry!
    const unauthPath = join(dir, 'unauth-ledger.sqlite');
    const unauthLedger = new OpenAiBudgetLedger(unauthPath, {
      testMode: true,
      canonicalRegistryPath: regPath,
      nowFn: () => new Date('2026-11-15T12:00:00Z'),
    });
    try {
      const sum1 = inspectLegacyAutopilotBudget(legacyPath1, { monthUtc: '2026-11' });
      unauthLedger.reconcileLegacySummary(sum1, {
        enable: false,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });
      assert.throws(
        () => unauthLedger.reserveBillableRequest({
          logicalRequestId: 'disabled-no-reg-pollute',
          endpoint: '/v1/decisions',
          model: 'gpt-6-luna',
          payloadSha256: sha256Hex('disabled-1'),
          reservedCents: 1,
          credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
        }),
        err => err instanceof OpenAiBudgetError && err.code === 'BUDGET_DISABLED',
      );
      assert.equal(existsSync(regPath), false);
    } finally {
      unauthLedger.close();
    }

    // 5) P0-09: Post-inspection legacy file mutation before activation throws STALE_LEGACY_SNAPSHOT_CHANGED;
    //    legacy source pinning blocks unapproved switch to legacyPath2 (LEGACY_SOURCE_MISMATCH);
    //    outer _withImmediateTx around dirty summary throws LEDGER_OUTER_TRANSACTION_FORBIDDEN!
    const mutLegacyPath = join(dir, 'legacy-mutated-after-inspect.sqlite3');
    writeFileSync(mutLegacyPath, readFileSync(legacyPath1));
    const preMutSummary = inspectLegacyAutopilotBudget(mutLegacyPath, { monthUtc: '2026-11' });
    const mutDb = new DatabaseSync(mutLegacyPath);
    mutDb.exec("INSERT INTO requests VALUES ('r2', 'in_progress', 5000, 0, 0, '2026-11')");
    mutDb.close();

    const canonPath = join(dir, 'canon-main.sqlite');
    let canonLedger = new OpenAiBudgetLedger(canonPath, {
      testMode: true,
      canonicalRegistryPath: regPath,
      nowFn: () => new Date('2026-11-15T12:00:00Z'),
    });
    try {
      assert.throws(
        () => canonLedger.reconcileLegacySummary(preMutSummary, {
          enable: true,
          autoRechargeOffConfirmed: true,
          hardMonthlyLimitConfirmed: true,
        }),
        err => err instanceof OpenAiBudgetError && err.code === 'STALE_LEGACY_SNAPSHOT_CHANGED',
      );

      const freshSummary1 = inspectLegacyAutopilotBudget(legacyPath1, { monthUtc: '2026-11' });
      canonLedger.reconcileLegacySummary(freshSummary1, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });
      assert.equal(canonLedger.getPolicy().baseline_mode, 'verified_production');
      assert.equal(canonLedger.getPolicy().legacy_source_pinned, true);

      // Attempt to switch to smaller legacyPath2 without allowLegacySourceSwitch + expectedLegacySourcePath + note -> LEGACY_SOURCE_MISMATCH!
      const sneakySummary2 = inspectLegacyAutopilotBudget(legacyPath2, { monthUtc: '2026-11' });
      assert.throws(
        () => canonLedger.reconcileLegacySummary(sneakySummary2, {
          enable: true,
          autoRechargeOffConfirmed: true,
          hardMonthlyLimitConfirmed: true,
        }),
        err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_SOURCE_MISMATCH',
      );

      // Outer _withImmediateTx around a hold-bearing summary is rejected so revocations cannot be rolled back!
      const dirtySummary = inspectLegacyAutopilotBudget(mutLegacyPath, { monthUtc: '2026-11' });
      assert.equal(dirtySummary.has_unresolved_holds, true);
      assert.throws(
        () => canonLedger._withImmediateTx(() => canonLedger.reconcileLegacySummary(dirtySummary)),
        err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_OUTER_TRANSACTION_FORBIDDEN',
      );

      // Bind credential into regPath on canonLedger
      const fp1 = sha256Hex(SYNTHETIC_API_KEY);
      const fp2 = sha256Hex(SYNTHETIC_API_KEY_ALT);
      canonLedger.bindCredentialFingerprint('openai-default', fp1);
    } finally {
      canonLedger.close();
    }

    // 6) P0-07: Delete canonPath and recreate a brand-new SQLite file at the SAME pathname ->
    //    (dev_id, ino_id) check catches replacement (CANONICAL_LEDGER_REPLACED_AT_PATH),
    //    and rotateOrRelocateCanonicalBinding with operator note updates binding & audit table!
    const fp1 = sha256Hex(SYNTHETIC_API_KEY);
    const fp2 = sha256Hex(SYNTHETIC_API_KEY_ALT);
    const movedBackup = join(dir, 'canon-keep-old-inode-alive.sqlite');
    writeFileSync(movedBackup, readFileSync(canonPath));
    // Keep old file at another path or unlink canonPath and create a fresh file after creating filler inode
    rmSync(canonPath, { force: true });
    rmSync(`${canonPath}-wal`, { force: true });
    rmSync(`${canonPath}-shm`, { force: true });
    const fillerPath = join(dir, 'inode-filler.tmp');
    writeFileSync(fillerPath, 'occupy-old-file-index');

    const replacedLedger = new OpenAiBudgetLedger(canonPath, {
      testMode: true,
      canonicalRegistryPath: regPath,
      nowFn: () => new Date('2026-11-15T12:05:00Z'),
    });
    try {
      const freshSum = inspectLegacyAutopilotBudget(legacyPath1, { monthUtc: '2026-11' });
      replacedLedger.reconcileLegacySummary(freshSum, {
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      });

      const regVerifyDb = new DatabaseSync(regPath, { readOnly: true });
      const prevBoundRow = regVerifyDb.prepare("SELECT dev_id, ino_id FROM canonical_scope_bindings WHERE account_scope = 'openai-default'").get();
      regVerifyDb.close();

      // Only assert inode mismatch if OS assigned a distinct file index (guaranteed on POSIX & NTFS when filler occupies old slot)
      let threwReplaced = false;
      try {
        replacedLedger.bindCredentialFingerprint('openai-default', fp1);
      } catch (e) {
        if (e instanceof OpenAiPolicyError && e.code === 'CANONICAL_LEDGER_REPLACED_AT_PATH') {
          threwReplaced = true;
        } else {
          throw e;
        }
      }
      if (prevBoundRow?.ino_id !== null) {
        assert.equal(threwReplaced, true);
      }

      // Evidenced operator relocation + key rotation succeeds and writes canonical_binding_audit
      const rotatedPol = replacedLedger.rotateOrRelocateCanonicalBinding({
        accountScope: 'openai-default',
        newCredentialFingerprintSha256: fp2,
        note: 'Recreated ledger after backup verification and rotated API key.',
      });
      assert.equal(rotatedPol.credential_fingerprint_sha256, fp2);

      const regAuditDb = new DatabaseSync(regPath, { readOnly: true });
      const auditCount = regAuditDb.prepare("SELECT COUNT(*) AS c FROM canonical_binding_audit WHERE account_scope = 'openai-default'").get().c;
      regAuditDb.close();
      assert.equal(auditCount >= 1, true);
    } finally {
      replacedLedger.close();
    }

    // 6b) Same-inode reuse simulation (e.g. Linux ext4 LIFO inode allocator reusing freed inode on unlink+recreate)
    //     + pre-upgrade registry migration without ledger_instance_id column:
    const sameInodeLedgerPath = join(dir, 'canon-same-inode-sim.sqlite');
    const preUpgradeRegPath = join(dir, 'pre-upgrade-canon-reg.sqlite');
    const preRegDb = new DatabaseSync(preUpgradeRegPath);
    preRegDb.exec(`
      CREATE TABLE canonical_scope_bindings (
        account_scope TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL,
        norm_path_key TEXT NOT NULL,
        dev_id TEXT,
        ino_id TEXT,
        bound_at TEXT NOT NULL
      );
      CREATE TABLE canonical_credential_bindings (
        credential_fingerprint_sha256 TEXT PRIMARY KEY,
        account_scope TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        norm_path_key TEXT NOT NULL,
        dev_id TEXT,
        ino_id TEXT,
        bound_at TEXT NOT NULL
      );
      CREATE TABLE canonical_binding_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_scope TEXT NOT NULL,
        action TEXT NOT NULL,
        old_canonical_path TEXT,
        new_canonical_path TEXT NOT NULL,
        old_dev_id TEXT,
        old_ino_id TEXT,
        new_dev_id TEXT,
        new_ino_id TEXT,
        old_credential_fp TEXT,
        new_credential_fp TEXT,
        operator_note TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `);
    preRegDb.close();

    const firstSameInodeLedger = new OpenAiBudgetLedger(sameInodeLedgerPath, {
      testMode: true,
      canonicalRegistryPath: preUpgradeRegPath,
    });
    try {
      firstSameInodeLedger.bindCredentialFingerprint('openai-default', fp1);
    } finally {
      firstSameInodeLedger.close();
    }
    rmSync(sameInodeLedgerPath, { force: true });
    rmSync(`${sameInodeLedgerPath}-wal`, { force: true });
    rmSync(`${sameInodeLedgerPath}-shm`, { force: true });

    const recreatedSameInodeLedger = new OpenAiBudgetLedger(sameInodeLedgerPath, {
      testMode: true,
      canonicalRegistryPath: preUpgradeRegPath,
    });
    try {
      // Force stored (dev_id, ino_id) in preUpgradeRegPath to match recreatedSameInodeLedger's exact physical (dev, ino)
      const newSt = statSync(sameInodeLedgerPath, { bigint: true });
      const forceRegDb = new DatabaseSync(preUpgradeRegPath);
      forceRegDb.prepare(
        "UPDATE canonical_scope_bindings SET dev_id = ?, ino_id = ? WHERE account_scope = 'openai-default'",
      ).run(String(newSt.dev), String(newSt.ino));
      forceRegDb.prepare(
        "UPDATE canonical_credential_bindings SET dev_id = ?, ino_id = ? WHERE account_scope = 'openai-default'",
      ).run(String(newSt.dev), String(newSt.ino));
      forceRegDb.close();

      assert.throws(
        () => recreatedSameInodeLedger.bindCredentialFingerprint('openai-default', fp1),
        err => err instanceof OpenAiPolicyError && err.code === 'CANONICAL_LEDGER_REPLACED_AT_PATH',
      );
    } finally {
      recreatedSameInodeLedger.close();
    }

    // 7) P1: Pre-migration SQLite DB with settled_cents=12 & missing provider_response_id column:
    //    readOnly: true projection counts 12c, and readOnly: false _migrateSchema upgrades BEFORE indexes!
    const preMigPath = join(dir, 'pre-mig-settled-cents.sqlite');
    const preDb = new DatabaseSync(preMigPath);
    preDb.exec(`
      CREATE TABLE openai_budget_policy (
        account_scope TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        monthly_limit_cents INTEGER NOT NULL DEFAULT 20000,
        legacy_reconciled INTEGER NOT NULL DEFAULT 1,
        legacy_reconciled_month_utc TEXT,
        legacy_carryover_cents INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_budget_policy VALUES ('openai-default', 0, 20000, 1, '2026-11', 0, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z');
      CREATE TABLE openai_request_ledger (
        attempt_id TEXT PRIMARY KEY,
        logical_request_id TEXT NOT NULL UNIQUE,
        account_scope TEXT NOT NULL,
        month_utc TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL,
        settled_cents INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO openai_request_ledger VALUES (
        'att-old-settled', 'req-old-settled', 'openai-default', '2026-11',
        '/v1/responses', 'gpt-6.1-terra', 'completed', '${sha256Hex('old-settled')}',
        20, 12, '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z'
      );
    `);
    preDb.close();

    const roPreLedger = new OpenAiBudgetLedger(preMigPath, { readOnly: true });
    try {
      const roSum = roPreLedger.getMonthlySummary({ monthUtc: '2026-11' });
      assert.equal(roSum.same_month_posted_billed_cents, 12);
      assert.equal(roSum.effective_committed_cents, 12);
    } finally {
      roPreLedger.close();
    }

    const rwPreLedger = new OpenAiBudgetLedger(preMigPath, { testMode: true, canonicalRegistryPath: regPath });
    try {
      const rwSum = rwPreLedger.getMonthlySummary({ monthUtc: '2026-11' });
      assert.equal(rwSum.same_month_posted_billed_cents, 12);
      assert.equal(rwSum.effective_committed_cents, 12);
      assert.equal(rwPreLedger.getAttemptById('att-old-settled').posted_billed_cents, 12);
    } finally {
      rwPreLedger.close();
    }

    // 8) P0-10 & P2-09: Legacy provisional_usage_cost_micros > 0 with confirmed_zero_charge=1 is flagged contradictory,
    //    status_counts sanitizes arbitrary status labels to 'unknown', and maxRows streaming cap throws LEGACY_BUDGET_ROW_LIMIT_EXCEEDED!
    const provLegPath = join(dir, 'legacy-provisional-contradiction.sqlite3');
    const provDb = new DatabaseSync(provLegPath);
    provDb.exec(`
      CREATE TABLE requests (
        request_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reserved_cents INTEGER NOT NULL,
        provisional_usage_cost_micros INTEGER,
        confirmed_zero_charge INTEGER NOT NULL DEFAULT 0,
        month_utc TEXT NOT NULL
      );
      INSERT INTO requests VALUES
        ('p1', 'failed', 10, 25000, 1, '2026-11'),
        ('p2', 'custom_secret_status_xyz', 5, NULL, 0, '2026-11');
    `);
    provDb.close();

    const provInspect = inspectLegacyAutopilotBudget(provLegPath, { monthUtc: '2026-11' });
    assert.equal(provInspect.has_unresolved_holds, true);
    assert.equal(provInspect.unresolved_count, 2);
    assert.equal(Object.hasOwn(provInspect.status_counts, 'custom_secret_status_xyz'), false);
    assert.equal(provInspect.status_counts.unknown, 1);

    assert.throws(
      () => inspectLegacyAutopilotBudget(provLegPath, { monthUtc: '2026-11', maxRows: 1 }),
      err => err instanceof OpenAiBudgetError && err.code === 'LEGACY_DB_TOO_MANY_ROWS',
    );
  });
});

// =============================================================================
// 16. Round 3 Verification: Settlement & Cross-Month Rejected Fence (P0-13), Connection/Cleanup
//     Verification (P0-03, P0-04, P0-05, P0-18), Private Payloads (P0-22, P0-24), & __proto__/Scope (P2-03, P2-04, P2-09)
// =============================================================================

test('Round 3 settlement, cleanup, private payloads, foreign ID quarantine, scope privacy, and __proto__ preservation', async () => {
  const ledger = createActivatedMemoryLedger({ monthUtc: '2026-11' });
  try {
    // 1) P0-13: reconcileAttempt NEVER auto-promotes interim provisional_usage_cost_micros as final settled usage!
    const provAtt = ledger.reserveBillableRequest({
      logicalRequestId: 'r3-prov-no-autopromote',
      monthUtc: '2026-11',
      allowTestClockOverride: true,
      endpoint: '/v1/responses',
      model: 'gpt-6-luna',
      payloadSha256: sha256Hex('r3-prov-1'),
      reservedCents: 10,
    });
    ledger.markPendingRecovery(provAtt.attempt_id, {
      provisionalUsageCostMicros: 45_000,
      reason: 'Interim in_progress usage observed before stream drop.',
    });
    assert.throws(
      () => ledger.reconcileAttempt(provAtt.attempt_id, {
        status: 'completed',
        note: 'Trying to settle without explicit verified usageCostMicros or postedBilledCents!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'MISSING_RECONCILIATION_CHARGE_EVIDENCE',
    );
    assert.throws(
      () => ledger.reconcileAttempt(provAtt.attempt_id, {
        status: 'failed_known',
        confirmedZeroCharge: true,
        note: 'Trying to claim zero charge despite 45,000 provisional micros!',
      }),
      OpenAiValidationError,
    );
    assert.throws(
      () => ledger.reconcileAttempt(provAtt.attempt_id, {
        status: 'completed',
        postedBilledCents: 2, // 2c < ceil(45_000 micros) = 5c!
        note: 'Trying to settle posted cents below provisional floor!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'USAGE_REDUCTION_FORBIDDEN',
    );
    ledger.reconcileAttempt(provAtt.attempt_id, {
      status: 'completed',
      usageCostMicros: 45_000,
      note: 'Verified 45,000 micros on provider usage export.',
    });

    // 2) P0-13: Unconfirmed `rejected` row stays fenced across months (2026-11 -> 2026-12)!
    const unconfRej = ledger.reserveBillableRequest({
      logicalRequestId: 'r3-unconfirmed-rejected-oct',
      monthUtc: '2026-10',
      allowTestClockOverride: true,
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: sha256Hex('r3-unconf-rej'),
      reservedCents: 25,
    });
    ledger.recordTerminalOutcome(unconfRej.attempt_id, {
      status: 'rejected',
      confirmedZeroCharge: false,
      httpStatus: 422,
      diagnosticReason: 'HTTP 422 without verified zero-charge flag.',
    });
    const novSummaryWhileRej = ledger.getMonthlySummary({ monthUtc: '2026-11' });
    assert.equal(novSummaryWhileRej.fenced, true);
    assert.equal(novSummaryWhileRej.prior_months_unresolved_reserved_cents, 25);
    assert.throws(
      () => ledger.reserveBillableRequest({
        logicalRequestId: 'r3-blocked-by-unconf-rej',
        monthUtc: '2026-11',
        allowTestClockOverride: true,
        endpoint: '/v1/responses',
        model: 'gpt-6-luna',
        payloadSha256: sha256Hex('r3-blocked'),
        reservedCents: 1,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'ACCOUNT_FENCED_PENDING_RECOVERY',
    );
    // Non-boolean confirmedZeroCharge rejected; error receipt with usageCostMicros=0 rejected on completed!
    assert.throws(
      () => ledger.reconcileAttempt(unconfRej.attempt_id, {
        status: 'failed_known',
        confirmedZeroCharge: 'yes',
        note: 'Non-boolean confirmedZeroCharge',
      }),
      OpenAiValidationError,
    );
    assert.throws(
      () => ledger.reconcileAttempt(unconfRej.attempt_id, {
        status: 'completed',
        usageCostMicros: 0,
        note: 'Cannot mark 422 error row completed with 0 usage!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'MISSING_RECONCILIATION_CHARGE_EVIDENCE',
    );
    ledger.reconcileAttempt(unconfRej.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Verified 0 charge for 422 rejection.',
    });
    assert.equal(ledger.getMonthlySummary({ monthUtc: '2026-11' }).fenced, false);

    // 3) P0-03, P0-04 & P0-05: cleanup_required requires confirmedNotCreatedRemotely: true alongside confirmedZeroCharge: true,
    //    and first-time providerResponseId requires verified providerIdEvidence matching payload_sha256!
    const cleanHoldAtt = ledger.reserveBillableRequest({
      logicalRequestId: 'r3-cleanup-never-created',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      payloadSha256: sha256Hex('r3-clean-nc'),
      reservedCents: 15,
      cleanupRequired: true,
    });
    ledger.markPendingRecovery(cleanHoldAtt.attempt_id, { reason: 'Local DNS failure before socket connect.' });
    assert.throws(
      () => ledger.reconcileAttempt(cleanHoldAtt.attempt_id, {
        status: 'failed_known',
        confirmedZeroCharge: true,
        note: 'confirmedZeroCharge alone must NOT clear cleanup_required!',
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'CLEANUP_NOT_VERIFIED',
    );
    assert.throws(
      () => ledger.reconcileAttempt(cleanHoldAtt.attempt_id, {
        status: 'pending_recovery',
        providerResponseId: 'resp_unverified_guess',
        note: 'Guessing response ID without payload digest proof!',
      }),
      err => err instanceof OpenAiPolicyError && err.code === 'UNVERIFIED_FIRST_PROVIDER_ID_ASSIGNMENT',
    );
    const clearedNeverCreated = ledger.reconcileAttempt(cleanHoldAtt.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      confirmedNotCreatedRemotely: true,
      note: 'Verified zero remote requests created during DNS outage.',
    });
    assert.equal(clearedNeverCreated.cleanup_required, false);
    assert.equal(clearedNeverCreated.confirmed_not_created_remotely, true);
    assert.equal(ledger.getActiveFences().length, 0);

    // 4) P2-03: Cross-scope duplicate logical_request_id throws ATTEMPT_SCOPE_MISMATCH without leaking payload_sha256 or attempt_id!
    reconcileLegacyBudgetIntoStore(
      ledger,
      {
        recognized_schema: true,
        file_sha256: '2'.repeat(64),
        month_utc: '2026-11',
        total_rows: 0,
        status_counts: {},
        unresolved_count: 0,
        blocking_reasons: [],
        has_unresolved_holds: false,
        same_month_reserved_cents: 0,
      },
      {
        accountScope: 'scope-beta',
        enable: true,
        autoRechargeOffConfirmed: true,
        hardMonthlyLimitConfirmed: true,
      },
    );
    assert.throws(
      () => ledger.reserveBillableRequest({
        logicalRequestId: 'r3-prov-no-autopromote',
        accountScope: 'scope-beta',
        endpoint: '/v1/responses',
        model: 'gpt-6-luna',
        payloadSha256: sha256Hex('different-payload'),
        reservedCents: 1,
      }),
      err => (
        err instanceof OpenAiBudgetError &&
        err.code === 'ATTEMPT_SCOPE_MISMATCH' &&
        !String(err.message).includes('openai-default') &&
        err.existing_payload_sha256 === undefined &&
        err.existing_attempt_id === undefined
      ),
    );
    assert.equal(
      ledger.getAttemptByLogicalId('r3-prov-no-autopromote', { accountScope: 'openai-default' }).attempt_id,
      provAtt.attempt_id,
    );

    // 5) P0-24 (>256 KiB exact raw payload preservation before DELETE), monotonic deleted_verified_404,
    //    api_base_url route prefix mismatch, foreign response ID quarantine, post-dispatch DUPLICATE_PROVIDER_RESPONSE_ID,
    //    and "__proto__" own-property preservation!
    let mode = 'large_300kb_cleanup';
    let deleteHttpCount = 0;
    const large300kPadding = 'Z'.repeat(300_000);
    let capturedLargeResponseBytes = null;

    const client = new OpenAiClient({
      ledger,
      testMode: true,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        const u = String(url);
        const method = init?.method ?? 'GET';

        if (method === 'POST' && u.endsWith('/v1/responses')) {
          if (mode === 'large_300kb_cleanup') {
            const bodyObj = JSON.parse(`{"id":"resp_300kb_1","model":"gpt-6.1-terra","status":"completed","__proto__":{"preserved_proto_val":42},"output":[{"type":"message","status":"completed","content":[{"type":"output_text","text":${JSON.stringify(large300kPadding)}}]}],"usage":{"input_tokens":100,"output_tokens":500}}`);
            const rawJson = JSON.stringify(bodyObj);
            capturedLargeResponseBytes = Buffer.from(rawJson, 'utf8');
            return makeJsonFetchResponse(200, rawJson);
          }
          if (mode === 'dup_provider_id_after_fetch') {
            return makeJsonFetchResponse(200, {
              id: 'resp_300kb_1', // Already bound to previous attempt!
              model: 'gpt-6.1-terra',
              status: 'completed',
              output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'dup' }] }],
              usage: { input_tokens: 100, output_tokens: 50 },
            });
          }
          if (mode === 'foreign_502') {
            return makeJsonFetchResponse(502, { id: 'resp_expected_foreign_test', status: 'in_progress' });
          }
        }

        if (method === 'DELETE' && u.endsWith('/v1/responses/resp_300kb_1')) {
          deleteHttpCount++;
          return makeJsonFetchResponse(200, { id: 'resp_300kb_1', object: 'response.deleted', deleted: true });
        }

        if (method === 'GET' && u.endsWith('/v1/responses/resp_300kb_1')) {
          return makeJsonFetchResponse(404, { error: { message: 'Not found', code: 'not_found' } });
        }

        if (method === 'GET' && u.endsWith('/v1/responses/resp_expected_foreign_test')) {
          // Malicious/faulty proxy returns a DIFFERENT response's massive usage!
          return makeJsonFetchResponse(200, {
            id: 'resp_FOREIGN_OTHER',
            model: 'gpt-6.1-terra',
            status: 'completed',
            output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'foreign' }] }],
            usage: { input_tokens: 900_000, output_tokens: 200_000 },
          });
        }

        throw new Error(`Unexpected ${method} ${u}`);
      },
    });

    // Per-call policy.baseUrl with route prefix mismatch throws API_BASE_URL_MISMATCH
    await assert.rejects(
      () => client.createResponse(
        { logical_request_id: 'r3-prefix-mismatch', input: 'hi' },
        { baseUrl: 'https://api.openai.com/v1-evil-proxy' },
      ),
      err => err instanceof OpenAiPolicyError && err.code === 'API_BASE_URL_MISMATCH',
    );

    // >256 KiB (300 KiB) response with deleteAfterPersist: true saves exact raw bytes in openai_private_payloads,
    // verifies SHA-256 readback, completes DELETE + 404, and preserves "__proto__" own property!
    const largeRes = await client.createResponse(
      { logical_request_id: 'r3-300kb-del', input: 'Generate 300KB output' },
      { deleteAfterPersist: true },
    );
    assert.equal(largeRes.ok, true);
    assert.equal(largeRes.status, 'completed');
    assert.equal(largeRes.cleanup.verified_404, true);
    assert.equal(deleteHttpCount, 1);
    assert.equal(largeRes.raw_response['__proto__'].preserved_proto_val, 42);
    assert.equal(Object.getPrototypeOf(largeRes.raw_response['__proto__']), null);
    assert.equal(Object.getPrototypeOf(largeRes.raw_response), null);

    const savedPriv = ledger.getVerifiedPrivatePayload(largeRes.attempt_id, 'response_post');
    assert.ok(savedPriv !== null);
    assert.equal(savedPriv.byte_length, capturedLargeResponseBytes.length);
    assert.equal(savedPriv.raw_sha256, ledger.getAttemptById(largeRes.attempt_id).original_body_sha256);
    assert.equal(Buffer.compare(savedPriv.raw_bytes, capturedLargeResponseBytes), 0);

    // Monotonic deleted_verified_404: updateCleanupStatus('delete_failed') cannot regress verified deletion,
    // and outer _withImmediateTx around beginBoundResponseCleanup is rejected!
    const afterRegressTry = ledger.updateCleanupStatus(largeRes.attempt_id, {
      cleanupStatus: 'delete_failed',
      diagnosticReason: 'Stale error callback',
    });
    assert.equal(afterRegressTry.cleanup_status, 'deleted_verified_404');
    assert.equal(afterRegressTry.status, 'completed');
    assert.throws(
      () => ledger._withImmediateTx(() => ledger.beginBoundResponseCleanup(largeRes.attempt_id, {
        providerResponseId: 'resp_300kb_1',
        apiBaseUrl: 'https://api.openai.com',
        origin: 'https://api.openai.com',
        credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
      })),
      err => err instanceof OpenAiBudgetError && err.code === 'LEDGER_OUTER_TRANSACTION_FORBIDDEN',
    );

    // P0-24: Attempt missing verified raw payload bytes in openai_private_payloads blocks remote DELETE!
    const noBytesAtt = ledger.reserveBillableRequest({
      logicalRequestId: 'r3-missing-raw-bytes-blocks-del',
      endpoint: '/v1/responses',
      model: 'gpt-6.1-terra',
      origin: 'https://api.openai.com',
      apiBaseUrl: 'https://api.openai.com',
      credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
      payloadSha256: sha256Hex('no-bytes'),
      reservedCents: 5,
      cleanupRequired: true,
    });
    ledger.recordTerminalOutcome(noBytesAtt.attempt_id, {
      status: 'completed',
      contentStatus: 'usable',
      usageCostMicros: 1_000,
      providerResponseId: 'resp_no_raw_bytes',
      originalBodySha256: sha256Hex('missing-bytes'),
      rawReceipt: { id: 'resp_no_raw_bytes', status: 'completed', usage: { input_tokens: 10, output_tokens: 10 } },
    });
    await assert.rejects(
      () => client.deleteResponse('resp_no_raw_bytes', { attemptId: noBytesAtt.attempt_id }),
      err => err instanceof OpenAiPolicyError && err.code === 'DELETE_WITHOUT_VERIFIED_ORIGINAL_BYTES_FORBIDDEN',
    );
    // Deposit exact verified bytes -> now cleanup can proceed; settle fence for next tests
    const exactMissingBytes = Buffer.from('missing-bytes', 'utf8');
    ledger.savePrivatePayload(noBytesAtt.attempt_id, 'response_post', exactMissingBytes);
    const claimOk = ledger.beginBoundResponseCleanup(noBytesAtt.attempt_id, {
      providerResponseId: 'resp_no_raw_bytes',
      apiBaseUrl: 'https://api.openai.com',
      origin: 'https://api.openai.com',
      credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
    });
    assert.equal(claimOk.alreadyCleanedUp, false);
    ledger.recordDeleteAcknowledged(noBytesAtt.attempt_id, {
      providerResponseId: 'resp_no_raw_bytes',
      transportReceipt: {
        method: 'DELETE',
        httpStatus: 200,
        apiBaseUrl: 'https://api.openai.com',
        credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
        bodySha256: sha256Hex('del-ok'),
        observedAt: '2026-11-15T12:10:00Z',
        deletedConfirmed: true,
      },
    });
    ledger.recordCleanupVerified404(noBytesAtt.attempt_id, {
      providerResponseId: 'resp_no_raw_bytes',
      transportReceipt: {
        method: 'GET',
        httpStatus: 404,
        apiBaseUrl: 'https://api.openai.com',
        credentialFingerprintSha256: sha256Hex(SYNTHETIC_API_KEY),
        bodySha256: sha256Hex('404-ok'),
        observedAt: '2026-11-15T12:10:02Z',
      },
    });

    // Foreign response ID on retrieveResponse / recoverPendingResponse is quarantined WITHOUT polluting provisional_usage_cost_micros!
    mode = 'foreign_502';
    await assert.rejects(
      () => client.createResponse({ logical_request_id: 'r3-foreign-id-quarantine', input: 'test' }),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.provider_response_id === 'resp_expected_foreign_test',
    );
    await assert.rejects(
      () => client.recoverPendingResponse('r3-foreign-id-quarantine'),
      err => err instanceof OpenAiAmbiguousOutcomeError && err.code === 'PROVIDER_RESPONSE_ID_MISMATCH',
    );
    const quarantinedRow = ledger.getAttempt('r3-foreign-id-quarantine');
    assert.equal(quarantinedRow.provisional_usage_cost_micros, null);
    ledger.reconcileAttempt(quarantinedRow.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared foreign ID test attempt.',
    });

    // Post-fetchImpl DUPLICATE_PROVIDER_RESPONSE_ID transitions attempt to pending_recovery with not_dispatched: false & attempt_id!
    mode = 'dup_provider_id_after_fetch';
    let dupErr = null;
    try {
      await client.createResponse({ logical_request_id: 'r3-post-fetch-dup-id', input: 'test dup' });
    } catch (e) {
      dupErr = e;
    }
    assert.ok(dupErr instanceof OpenAiAmbiguousOutcomeError);
    assert.equal(dupErr.code, 'DUPLICATE_PROVIDER_RESPONSE_ID');
    assert.equal(dupErr.not_dispatched, false);
    assert.equal(typeof dupErr.attempt_id, 'string');
    const dupRow = ledger.getAttemptById(dupErr.attempt_id);
    assert.equal(dupRow.status, 'pending_recovery');
    assert.equal(dupRow.provider_response_id, null);
    ledger.reconcileAttempt(dupRow.attempt_id, {
      status: 'failed_known',
      confirmedZeroCharge: true,
      note: 'Cleared post-dispatch duplicate response ID test.',
    });
  } finally {
    ledger.close();
  }
});

// =============================================================================
// 17. Round 3 Verification: Batch Admission/Rollover/Redownload (P0-01, P0-02, P0-19),
//     Tier/Vision/Audio/Speech (P0-15, P0-17, P1-03), Decisions (P1-12), & Schema/Offline-Draft/Locked-ID (P0-25, P1-01, P1-02)
// =============================================================================

test('Round 3 Batch, Decisions, Responses, Vision, & Audio: upload authority, rollover abort, pre-download binding, tier cap, raster dims, MP3/Opus framing, recursive schema, and offline draft block', async () => {
  // 1) P0-15: Inline raster dimension parser (PNG, JPEG, WebP VP8/VP8L/VP8X) & >8192px rejection + high-res token scaling
  const pngDims = parseInlineRasterDimensions(Buffer.from(VALID_1X1_PNG_B64, 'base64'), 'png');
  assert.deepEqual(pngDims, { format: 'png', width: 1, height: 1 });
  const jpegDims = parseInlineRasterDimensions(Buffer.from(VALID_JPEG_B64, 'base64'), 'jpeg');
  assert.deepEqual(jpegDims, { format: 'jpeg', width: 1, height: 1 });

  // WebP VP8X 2048x1024 header
  const webpVp8x = Buffer.alloc(30);
  webpVp8x.write('RIFF', 0, 'ascii');
  webpVp8x.writeUInt32LE(22, 4);
  webpVp8x.write('WEBP', 8, 'ascii');
  webpVp8x.write('VP8X', 12, 'ascii');
  webpVp8x.writeUInt32LE(10, 16);
  // width - 1 = 2047 (0x0007ff), height - 1 = 1023 (0x0003ff)
  webpVp8x[24] = 0xff; webpVp8x[25] = 0x07; webpVp8x[26] = 0x00;
  webpVp8x[27] = 0xff; webpVp8x[28] = 0x03; webpVp8x[29] = 0x00;
  assert.deepEqual(parseInlineRasterDimensions(webpVp8x, 'webp'), { format: 'webp', width: 2048, height: 1024 });

  // >8192x8192 PNG rejected with INVALID_INLINE_IMAGE_RASTER
  const oversize9000PngB64 = buildPaddedValidPngBase64(9000, 100, 0);
  assert.throws(
    () => estimateResponsesInputTokens({
      model: 'gpt-6.1-terra',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${oversize9000PngB64}` }] }],
    }),
    err => err instanceof OpenAiValidationError && err.code === 'INVALID_INLINE_IMAGE_RASTER',
  );

  // 4096x4096 detail: 'original' reserves >> 16,384 tokens based on actual dimensions!
  const hiRes4096PngB64 = buildPaddedValidPngBase64(4096, 4096, 0);
  const hiResTokens = estimateResponsesInputTokens({
    model: 'gpt-6.1-terra',
    input: [{ role: 'user', content: [{ type: 'input_image', detail: 'original', image_url: `data:image/png;base64,${hiRes4096PngB64}` }] }],
  });
  assert.equal(hiResTokens > 32_000, true);

  // 2) P1-03: Truncated 20-byte MP3 frame header and header-only Ogg OpusHead stub are REJECTED!
  const truncated20ByteMp3 = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06,
    0x54, 0x49, 0x54, 0x32, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64,
  ]);
  assert.equal(validateAudioFramingAndMagicBytes(truncated20ByteMp3, 'mp3'), false);
  const headerOnlyOpus = buildValidOggOpusBytes({ includeAudioPage: false });
  assert.equal(validateAudioFramingAndMagicBytes(headerOnlyOpus, 'opus'), false);

  // 3) P1-02: computeRequestPayloadSha256 hashes exact serialized wire JSON bytes (key-order sensitive)
  const shaOrder1 = computeRequestPayloadSha256('/v1/responses', JSON.stringify({ a: 1, b: 2 }));
  const shaOrder2 = computeRequestPayloadSha256('/v1/responses', JSON.stringify({ b: 2, a: 1 }));
  assert.notEqual(shaOrder1, shaOrder2);

  // 4) P2: extractWebSearchCallsFromOutput deduplicates same item.id across output and error.output
  assert.equal(
    extractWebSearchCallsFromOutput({
      output: [{ id: 'ws_dup_1', type: 'web_search_call' }, { id: 'ws_2', type: 'web_search_call' }],
      error: { output: [{ id: 'ws_dup_1', type: 'web_search_call' }] },
    }),
    2,
  );

  // 5) P1-01: Recursive JSON schema validator & unsupported keyword ($ref) rejection
  assert.throws(
    () => validateSupportedJsonSchemaDialect({ type: 'object', $ref: '#/$defs/item' }),
    err => err instanceof OpenAiValidationError && err.code === 'UNSUPPORTED_JSON_SCHEMA_KEYWORD',
  );
  const complexSchema = {
    type: 'object',
    required: ['verdict', 'items', 'detail'],
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['code'],
          additionalProperties: false,
          properties: { code: { type: 'string', maxLength: 8 } },
        },
      },
      detail: {
        anyOf: [
          { type: 'null' },
          { type: 'integer', minimum: 1, maximum: 10 },
        ],
      },
    },
  };
  assert.equal(
    validateValueAgainstJsonSchema({ verdict: 'pass', items: [{ code: 'OK1' }], detail: null }, complexSchema),
    null,
  );
  assert.notEqual(
    validateValueAgainstJsonSchema({ verdict: 'maybe', items: [{ code: 'OK1' }], detail: null }, complexSchema),
    null,
  );
  assert.notEqual(
    validateValueAgainstJsonSchema({ verdict: 'pass', items: [{ code: 'OK1', extra: 1 }], detail: 5 }, complexSchema),
    null,
  );
  assert.notEqual(
    validateValueAgainstJsonSchema({ verdict: 'pass', items: [{ code: 'TOO_LONG_CODE' }], detail: 5 }, complexSchema),
    null,
  );

  // 6) P2-04: "__proto__" custom_id in Batch JSONL & legacy image manifest missing expected_image_count
  const protoBatch = buildBatchJsonl([
    { custom_id: '__proto__', url: '/v1/responses', body: { input: 'Proto custom_id check' } },
  ]);
  assert.deepEqual(protoBatch.custom_ids, ['__proto__']);
  assert.equal(protoBatch.line_models['__proto__'], 'gpt-6.1-terra');

  const protoBatchParsed = parseBatchOutputJsonl(
    JSON.stringify({
      custom_id: '__proto__',
      response: {
        status_code: 200,
        body: {
          id: 'resp_proto_batch_1',
          model: 'gpt-6.1-terra',
          status: 'completed',
          output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 50, output_tokens: 10 },
        },
      },
    }),
    { expectedEndpoint: '/v1/responses', lineModels: protoBatch.line_models, lineSpecs: protoBatch.line_specs },
  );
  assert.equal(Object.getPrototypeOf(protoBatchParsed.by_custom_id), null);
  assert.equal(protoBatchParsed.by_custom_id['__proto__'].usable, true);

  // Error line with inner status: 'in_progress' keeps has_unknown_usage === true!
  const interimErrBatch = parseBatchOutputJsonl(
    JSON.stringify({
      custom_id: 'err-interim-1',
      response: {
        status_code: 500,
        body: {
          id: 'resp_interim_err',
          model: 'gpt-6.1-terra',
          status: 'in_progress',
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      },
    }),
    { expectedEndpoint: '/v1/responses' },
  );
  assert.equal(interimErrBatch.has_unknown_usage, true);
  assert.equal(interimErrBatch.total_usage_cost_micros, null);
  assert.equal(interimErrBatch.known_usage_cost_micros > 0, true);

  // Legacy image manifest missing expected_image_count / expected_output_format marks line usable: false!
  const legacyImgSpecMap = Object.create(null);
  Object.defineProperty(legacyImgSpecMap, 'leg-img-1', {
    value: { endpoint: '/v1/images/generations', model: 'gpt-image-2.6-sunburst' },
    enumerable: true,
  });
  const parsedLegacyImg = parseBatchOutputJsonl(
    JSON.stringify({
      custom_id: 'leg-img-1',
      response: {
        status_code: 200,
        body: {
          model: 'gpt-image-2.6-sunburst',
          data: [{ b64_json: VALID_1X1_PNG_B64 }],
          usage: { input_tokens: 100, output_tokens: 1000, input_tokens_details: { text_tokens: 100, image_tokens: 0 } },
        },
      },
    }),
    { expectedEndpoint: '/v1/images/generations', lineSpecs: legacyImgSpecMap },
  );
  assert.equal(parsedLegacyImg.usable_count, 0);
  assert.equal(parsedLegacyImg.by_custom_id['leg-img-1'].usable, false);
  assert.equal(parsedLegacyImg.by_custom_id['leg-img-1'].error, 'unverified_legacy_image_manifest');

  // 7) End-to-end client checks: forged recordBatchUploadReceipt block, Astra recheck on submitBatch(input_file_id),
  //    UTC month rollover abort, retrieveBatch pre-download binding + request_counts parity + redownload SHA-256 check,
  //    standard->default wire tier rejecting fast, Decisions >32 choices / wire max_output_tokens / aliases / envelope statuses,
  //    Speech mismatch hold & header scrubbing, _offline_draft_only block, _locked_logical_request_id cross-endpoint dedup,
  //    and item.status='in_progress' / nested schema checks!
  let currentClockIso = '2026-11-30T23:59:50Z';
  const ledger = createActivatedMemoryLedger({
    monthUtc: '2026-11',
    allowStage4Media: true,
    nowFn: () => new Date(currentClockIso),
  });

  try {
    // Public recordBatchUploadReceipt is hard-blocked!
    assert.throws(
      () => ledger.recordBatchUploadReceipt({ uploadedFileId: 'file_forged_999' }),
      err => err instanceof OpenAiPolicyError && err.code === 'UNVERIFIED_BATCH_UPLOAD_RECEIPT_FORBIDDEN',
    );

    let step = 'normal';
    let fileContentDownloads = 0;
    let batchOutputLineText = '{"verdict":"pass"}';
    let batchRequestCounts = { total: 1, completed: 1, failed: 0 };
    let batchEndpointReturned = '/v1/responses';
    const capturedDecisionWires = [];
    const capturedResponseWires = [];

    const client = new OpenAiClient({
      ledger,
      testMode: true,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (url, init) => {
        const u = String(url);
        const method = init?.method ?? 'GET';

        if (method === 'POST' && u.endsWith('/v1/files')) {
          if (step === 'rollover_during_upload') {
            currentClockIso = '2026-12-01T00:00:05Z';
            return makeJsonFetchResponse(200, { id: 'file_rollover_dec_1', object: 'file', purpose: 'batch' });
          }
          if (step === 'lower_limit_during_upload') {
            ledger.configurePolicy({ monthlyLimitCents: 0 });
            return makeJsonFetchResponse(200, { id: 'file_limit_lowered_1', object: 'file', purpose: 'batch' });
          }
          const fid = step === 'astra_upload' ? 'file_astra_line_1' : 'file_ok_r3_1';
          return makeJsonFetchResponse(200, { id: fid, object: 'file', purpose: 'batch' });
        }

        if (method === 'POST' && u.endsWith('/v1/batches')) {
          return makeJsonFetchResponse(200, {
            id: 'batch_r3_1',
            status: 'validating',
            endpoint: '/v1/responses',
            input_file_id: 'file_ok_r3_1',
          });
        }

        if (method === 'GET' && u.endsWith('/v1/batches/batch_r3_1')) {
          return makeJsonFetchResponse(200, {
            id: 'batch_r3_1',
            status: 'completed',
            endpoint: batchEndpointReturned,
            input_file_id: 'file_ok_r3_1',
            output_file_id: 'file_out_r3_1',
            request_counts: batchRequestCounts,
          });
        }

        if (method === 'GET' && u.endsWith('/v1/files/file_out_r3_1/content')) {
          fileContentDownloads++;
          return makeJsonFetchResponse(
            200,
            `${JSON.stringify({
              id: 'br_r3_1',
              custom_id: 'evrev-locked-batch-1',
              response: {
                status_code: 200,
                body: {
                  id: 'resp_in_batch_1',
                  model: 'gpt-6.1-terra',
                  status: 'completed',
                  output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: batchOutputLineText }] }],
                  usage: { input_tokens: 200, output_tokens: 50 },
                },
              },
            })}\n`,
          );
        }

        if (method === 'POST' && u.endsWith('/v1/decisions')) {
          const parsed = JSON.parse(String(init.body));
          capturedDecisionWires.push(parsed);
          if (step === 'dec_in_progress') {
            return makeJsonFetchResponse(200, {
              id: 'dec_ip_1',
              model: 'gpt-6-luna',
              status: 'in_progress',
              decisions: [{ id: 'q1', type: 'predicate', value: true }],
              usage: { input_tokens: 100, output_tokens: 20 },
            });
          }
          if (step === 'dec_failed_env') {
            return makeJsonFetchResponse(200, {
              id: 'dec_fail_1',
              model: 'gpt-6-luna',
              status: 'failed',
              error: { message: 'Server aborted decision' },
              decisions: [{ id: 'q1', type: 'predicate', value: true }],
              usage: { input_tokens: 100, output_tokens: 20 },
            });
          }
          return makeJsonFetchResponse(200, {
            id: 'dec_norm_1',
            model: 'gpt-6-luna',
            status: 'completed',
            decisions: [{ id: 'q1', type: 'predicate', value: true }],
            usage: { input_tokens: 100, output_tokens: 20 },
          });
        }

        if (method === 'POST' && u.endsWith('/v1/responses')) {
          const parsed = JSON.parse(String(init.body));
          capturedResponseWires.push(parsed);
          if (step === 'std_gets_fast') {
            return makeJsonFetchResponse(200, {
              id: 'resp_std_fast_1',
              model: 'gpt-6.1-terra',
              service_tier: 'fast',
              status: 'completed',
              output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'fast surprise' }] }],
              usage: { input_tokens: 1_000, output_tokens: 500 },
            });
          }
          if (step === 'inner_item_in_progress') {
            return makeJsonFetchResponse(200, {
              id: 'resp_item_ip_1',
              model: 'gpt-6.1-terra',
              status: 'completed',
              output: [{ type: 'message', status: 'in_progress', content: [{ type: 'output_text', text: '{"verdict":"pass"}' }] }],
              usage: { input_tokens: 100, output_tokens: 50 },
            });
          }
          return makeJsonFetchResponse(200, {
            id: `resp_gen_${capturedResponseWires.length}`,
            model: 'gpt-6.1-terra',
            service_tier: 'default',
            status: 'completed',
            output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: '{"verdict":"pass"}' }] }],
            usage: { input_tokens: 100, output_tokens: 50 },
          });
        }

        if (method === 'POST' && u.endsWith('/v1/audio/speech')) {
          if (step === 'speech_secret_header') {
            return makeBinaryFetchResponse(
              200,
              VALID_20B_MP3_BYTES,
              `audio/mpeg; token=${SYNTHETIC_API_KEY}`,
              { 'x-usage-characters': `bad-${SYNTHETIC_API_KEY}` },
            );
          }
          // Return mismatched x-usage-characters ('1000' for 11-char input)
          return makeBinaryFetchResponse(200, VALID_20B_MP3_BYTES, 'audio/mpeg', {
            'x-usage-characters': step === 'speech_under_chars' ? '5' : '1000',
          });
        }

        throw new Error(`Unexpected ${method} ${u}`);
      },
    });

    // P0-25: _offline_draft_only request is blocked across createResponse, buildBatchJsonl, uploadBatchFile, and submitBatch!
    const offlineDraftReq = {
      model: 'gpt-6.1-terra',
      input: 'Offline draft packet',
      _offline_draft_only: true,
    };
    await assert.rejects(
      () => client.createResponse(offlineDraftReq),
      err => err instanceof OpenAiPolicyError && err.code === 'OFFLINE_DRAFT_NOT_DISPATCHABLE',
    );
    assert.throws(
      () => buildBatchJsonl([{ custom_id: 'd1', url: '/v1/responses', body: offlineDraftReq }]),
      err => err instanceof OpenAiPolicyError && err.code === 'OFFLINE_DRAFT_NOT_DISPATCHABLE',
    );
    await assert.rejects(
      () => client.uploadBatchFile({ requests: [{ custom_id: 'd1', url: '/v1/responses', body: offlineDraftReq }] }),
      err => err instanceof OpenAiPolicyError && err.code === 'OFFLINE_DRAFT_NOT_DISPATCHABLE',
    );

    // P0-01: uploadBatchFile with allowAstraApi: true -> submitBatch WITHOUT allowAstraApi: true blocks Astra line!
    step = 'astra_upload';
    const astraUp = await client.uploadBatchFile(
      {
        logical_request_id: 'r3-astra-upload-1',
        requests: [{ custom_id: 'astra-c1', url: '/v1/responses', body: { model: 'gpt-6.2-astra', input: 'Audit' } }],
      },
      { allowAstraApi: true },
    );
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'r3-astra-submit-blocked',
        input_file_id: astraUp.input_file_id,
      }), // allowAstraApi defaults to false!
      err => err instanceof OpenAiPolicyError && err.code === 'ASTRA_API_BLOCKED' && err.not_dispatched === true,
    );

    // P0-19: UTC month rollover during /v1/files upload aborts POST /v1/batches with BATCH_MONTH_ROLLOVER_ABORTED!
    step = 'rollover_during_upload';
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'r3-batch-rollover-1',
        requests: [{ custom_id: 'roll-1', url: '/v1/responses', body: { input: 'Rollover check' } }],
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'BATCH_MONTH_ROLLOVER_ABORTED' && err.not_dispatched === false,
    );
    assert.equal(ledger.getAttempt('r3-batch-rollover-1').status, 'rejected');
    currentClockIso = '2026-11-30T12:00:00Z';

    // P0-19: Lowering monthly_limit_cents during /v1/files upload aborts POST /v1/batches with MONTHLY_BUDGET_EXCEEDED!
    step = 'lower_limit_during_upload';
    await assert.rejects(
      () => client.submitBatch({
        logical_request_id: 'r3-batch-lower-limit-1',
        requests: [{ custom_id: 'low-1', url: '/v1/responses', body: { input: 'Limit check' } }],
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'MONTHLY_BUDGET_EXCEEDED' && err.not_dispatched === false,
    );
    assert.equal(ledger.getAttempt('r3-batch-lower-limit-1').status, 'rejected');
    ledger.configurePolicy({ monthlyLimitCents: 20_000 });

    // P1-02 & P0-02: Locked review logical ID in Batch + pre-download binding check + request_counts parity + redownload SHA-256 check!
    step = 'normal';
    const lockedBody = {
      model: 'gpt-6.1-terra',
      input: 'Evidence review in batch',
      _locked_logical_request_id: 'evrev-locked-batch-1',
      text: {
        format: {
          type: 'json_schema',
          name: 'rev_out',
          schema: {
            type: 'object',
            required: ['verdict'],
            additionalProperties: false,
            properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } },
          },
        },
      },
    };
    assert.throws(
      () => buildBatchJsonl([{ custom_id: 'wrong-cid', url: '/v1/responses', body: lockedBody }]),
      err => err instanceof OpenAiPolicyError && err.code === 'LOCKED_LOGICAL_REQUEST_ID_MISMATCH',
    );
    const subLockedBatch = await client.submitBatch({
      logical_request_id: 'r3-locked-batch-sub',
      requests: [{ custom_id: 'evrev-locked-batch-1', url: '/v1/responses', body: lockedBody }],
    });
    assert.equal(subLockedBatch.status, 'pending_recovery');

    // Direct createResponse with the SAME locked review ID is blocked across endpoints!
    await assert.rejects(
      () => client.createResponse(lockedBody),
      err => err instanceof OpenAiBudgetError && err.code === 'DUPLICATE_LOGICAL_REQUEST',
    );

    // Pre-download endpoint mismatch refuses to fetch /v1/files/{outId}/content (fileContentDownloads stays 0!)
    batchEndpointReturned = '/v1/images/generations';
    const preDlBlocked = await client.retrieveBatch('batch_r3_1', {
      attemptId: subLockedBatch.attempt_id,
      downloadOutput: true,
    });
    assert.equal(preDlBlocked.status, 'pending_recovery');
    assert.equal(fileContentDownloads, 0);

    // request_counts parity mismatch (completed: 0, failed: 1 vs observed HTTP 200 line) holds pending_recovery!
    batchEndpointReturned = '/v1/responses';
    batchRequestCounts = { total: 1, completed: 0, failed: 1 };
    const parityHeld = await client.retrieveBatch('batch_r3_1', {
      attemptId: subLockedBatch.attempt_id,
      downloadOutput: true,
    });
    assert.equal(parityHeld.status, 'pending_recovery');
    assert.equal(fileContentDownloads, 1);

    // Valid request_counts + schema-valid output settles completed and records accepted_output_sha256
    batchRequestCounts = { total: 1, completed: 1, failed: 0 };
    const settledBatch = await client.retrieveBatch('batch_r3_1', {
      logicalRequestId: 'r3-locked-batch-sub',
      downloadOutput: true,
    });
    assert.equal(settledBatch.ok, true);
    assert.equal(settledBatch.status, 'completed');
    assert.equal(settledBatch.parsed_output.usable_count, 1);

    // Mutating remote file content on subsequent retrieveBatch(downloadOutput: true) throws BATCH_OUTPUT_DIGEST_MISMATCH!
    batchOutputLineText = '{"verdict":"fail"}';
    await assert.rejects(
      () => client.retrieveBatch('batch_r3_1', {
        attemptId: subLockedBatch.attempt_id,
        downloadOutput: true,
      }),
      err => err instanceof OpenAiBudgetError && err.code === 'BATCH_OUTPUT_DIGEST_MISMATCH',
    );

    // P0-15: Explicit service_tier: 'standard' transmits wire.service_tier='default', reserves 1x,
    //        and holds pending_recovery (usable: false) if provider returns 'fast'!
    step = 'std_gets_fast';
    const stdGotFast = await client.createResponse({
      logical_request_id: 'r3-std-got-fast',
      service_tier: 'standard',
      input: 'Requesting standard 1x cap',
    });
    assert.equal(capturedResponseWires.at(-1).service_tier, 'default');
    assert.equal(stdGotFast.ok, false);
    assert.equal(stdGotFast.usable, false);
    assert.equal(stdGotFast.status, 'pending_recovery');
    assert.equal(stdGotFast.provisional_usage_cost_micros, 7_000); // 2x fast floor recorded (1000*$2/M + 500*$10/M = 7000 micros vs 3500 standard)!
    ledger.reconcileAttempt(stdGotFast.attempt_id, {
      status: 'failed_known',
      usageCostMicros: 7_000,
      note: 'Settled unexpected fast tier response.',
    });

    // P1-01: Completed response envelope containing output item with status: 'in_progress' is marked usable: false!
    step = 'inner_item_in_progress';
    const itemIpRes = await client.createResponse({
      logical_request_id: 'r3-item-in-progress',
      input: 'Check inner item status',
    });
    assert.equal(itemIpRes.status, 'completed');
    assert.equal(itemIpRes.usable, false);
    assert.equal(itemIpRes.content_status, 'invalid');

    // P0-15, P1-12, P2-input-cap (/v1/decisions): >32 choices rejected, multiple input_json aliases rejected,
    // data alias normalized to wire json + explicit wire max_output_tokens, and in_progress / failed envelopes honored!
    const thirtyThreeChoices = Array.from({ length: 33 }, (_, idx) => `opt_${idx}`);
    await assert.rejects(
      () => client.createDecision({
        input: 'Too many choices',
        questions: [{ id: 'q_big', type: 'choice', question: 'Pick?', options: thirtyThreeChoices }],
      }),
      err => err instanceof OpenAiValidationError && err.code === 'DECISION_CHOICES_LIMIT_EXCEEDED',
    );
    await assert.rejects(
      () => client.createDecision({
        input: [{ type: 'input_json', json: { a: 1 }, data: { b: 2 } }],
        questions: [{ id: 'q1', type: 'predicate', question: 'Ok?' }],
      }),
      err => err instanceof OpenAiValidationError && err.code === 'MULTIPLE_INPUT_JSON_ALIASES_FORBIDDEN',
    );

    step = 'normal';
    const normDec = await client.createDecision({
      logical_request_id: 'r3-dec-norm-alias',
      input: [{ type: 'input_json', json: { normalized_to_data: true } }],
      questions: [{ id: 'q1', type: 'predicate', question: 'Ok?' }],
    });
    assert.equal(normDec.usable, true);
    assert.deepEqual(capturedDecisionWires.at(-1).input, [{ type: 'input_json', data: { normalized_to_data: true } }]);
    assert.deepEqual(capturedDecisionWires.at(-1).questions, [
      { type: 'predicate', name: 'q1', instructions: 'Ok?' },
    ]);
    assert.equal('max_output_tokens' in capturedDecisionWires.at(-1), false);

    step = 'dec_in_progress';
    const ipDec = await client.createDecision({
      logical_request_id: 'r3-dec-ip',
      input: 'Check unfinished decision',
      questions: [{ id: 'q1', type: 'predicate', question: 'Ok?' }],
    });
    assert.equal(ipDec.usable, false);
    assert.equal(ipDec.status, 'pending_recovery');
    assert.equal(ipDec.decisions.length, 0);
    ledger.reconcileAttempt(ipDec.attempt_id, {
      status: 'failed_known',
      usageCostMicros: ipDec.provisional_usage_cost_micros,
      note: 'Cleared in_progress decision test.',
    });

    step = 'dec_failed_env';
    const failDec = await client.createDecision({
      logical_request_id: 'r3-dec-failed-env',
      input: 'Check failed decision envelope',
      questions: [{ id: 'q1', type: 'predicate', question: 'Ok?' }],
    });
    assert.equal(failDec.usable, false);
    assert.equal(failDec.status, 'failed_known');
    assert.equal(failDec.content_status, 'invalid');
    assert.equal(failDec.decisions.length, 0);

    // P0-17 & P0-22 Speech: x-usage-characters !== inputChars holds as SPEECH_USAGE_MISMATCH_HOLD (usable: false),
    // and literal API key in Content-Type / x-usage-characters headers is scrubbed!
    step = 'speech_over_chars';
    const overCharsSpeech = await client.createSpeechBriefing(
      { logical_request_id: 'r3-tts-mismatch-high', model: 'tts-1-hd', input: 'Hello world' },
      { enableStage4Media: true },
    );
    assert.equal(overCharsSpeech.ok, false);
    assert.equal(overCharsSpeech.usable, false);
    assert.equal(overCharsSpeech.status, 'pending_recovery');
    assert.equal(overCharsSpeech.hold_code, 'SPEECH_USAGE_MISMATCH_HOLD');
    assert.equal(overCharsSpeech.provisional_usage_cost_micros, 30_000); // max(330, 30_000)
    ledger.reconcileAttempt(overCharsSpeech.attempt_id, {
      status: 'failed_known',
      usageCostMicros: 30_000,
      note: 'Settled speech mismatch high test.',
    });

    step = 'speech_under_chars';
    const underCharsSpeech = await client.createSpeechBriefing(
      { logical_request_id: 'r3-tts-mismatch-low', model: 'tts-1-hd', input: 'Hello world' },
      { enableStage4Media: true },
    );
    assert.equal(underCharsSpeech.usable, false);
    assert.equal(underCharsSpeech.hold_code, 'SPEECH_USAGE_MISMATCH_HOLD');
    assert.equal(underCharsSpeech.provisional_usage_cost_micros, 330); // max(330, 150)
    ledger.reconcileAttempt(underCharsSpeech.attempt_id, {
      status: 'failed_known',
      usageCostMicros: 330,
      note: 'Settled speech mismatch low test.',
    });

    step = 'speech_secret_header';
    await assert.rejects(
      () => client.createSpeechBriefing(
        { logical_request_id: 'r3-tts-secret-hdr', model: 'tts-1-hd', input: 'Hello world' },
        { enableStage4Media: true },
      ),
      err => (
        err instanceof OpenAiAmbiguousOutcomeError &&
        err.code === 'INVALID_AUDIO_CONTENT_TYPE' &&
        !String(err.message).includes(SYNTHETIC_API_KEY)
      ),
    );
    const secHdrAttempt = ledger.getAttempt('r3-tts-secret-hdr');
    assert.equal(JSON.stringify(secHdrAttempt).includes(SYNTHETIC_API_KEY), false);
  } finally {
    ledger.close();
  }
});

test('Live-API parity: /v1/decisions accepts answers[] with array probabilities, normalizes wire schema, and honors constructor timeoutMs', async () => {
  const ledger = createActivatedMemoryLedger();
  let capturedWire = null;
  try {
    const client = new OpenAiClient({
      ledger,
      timeoutMs: 360_000,
      allowEnvKey: true,
      apiKeyEnvVar: 'TEST_OPENAI_KEY',
      env: { TEST_OPENAI_KEY: SYNTHETIC_API_KEY },
      fetchImpl: async (_url, init) => {
        capturedWire = JSON.parse(init.body);
        return makeJsonFetchResponse(200, {
          model: 'gpt-6-luna',
          answers: [
            { name: 'gate0_prohibited_SYNTH-PEER-001', type: 'predicate', probability: 0 },
            {
              name: 'visual_peer_SYNTH-PEER-001',
              type: 'choice',
              choice: 'exact_peer',
              confidence: 0.65,
              probabilities: [
                { value: 'exact_peer', probability: 0.65 },
                { value: 'different_mechanism', probability: 0.30 },
                { value: 'accessory_or_consumable_decoy', probability: 0.03 },
                { value: 'unclear_needs_zoom', probability: 0.02 },
              ],
            },
          ],
          usage: {
            input_tokens: 10_000,
            input_tokens_details: {
              cached_tokens: 4_000,
              cache_write_tokens: 0,
            },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 10_000,
          },
        });
      },
    });
    assert.equal(client.defaultTimeoutMs, 360_000);

    const res = await client.createDecision({
      logical_request_id: 'live-parity-luna-array-probs',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Triage synthetic fixtures.' },
            { type: 'input_json', data: { candidates: [{ candidate_id: 'SYNTH-PEER-001' }] } },
          ],
        },
      ],
      questions: [
        { id: 'gate0_prohibited_SYNTH-PEER-001', name: 'gate0_prohibited_SYNTH-PEER-001', type: 'predicate', instructions: 'Prohibited?' },
        {
          id: 'visual_peer_SYNTH-PEER-001',
          name: 'visual_peer_SYNTH-PEER-001',
          type: 'choice',
          instructions: 'Peer cluster?',
          choices: [
            { value: 'exact_peer', description: 'Same mechanism' },
            { value: 'different_mechanism', description: 'Different mechanism' },
            { value: 'accessory_or_consumable_decoy', description: 'Decoy' },
            { value: 'unclear_needs_zoom', description: 'Needs zoom' },
          ],
        },
      ],
    });

    assert.equal(res.ok, true);
    assert.equal(res.usable, true);
    assert.equal(res.usage_cost_micros, 640);
    assert.equal('max_output_tokens' in capturedWire, false);
    assert.deepEqual(capturedWire.input[0].content[1], {
      type: 'input_json',
      data: { candidates: [{ candidate_id: 'SYNTH-PEER-001' }] },
    });
    assert.equal('id' in capturedWire.questions[0], false);
    assert.equal(capturedWire.questions[0].name, 'gate0_prohibited_SYNTH-PEER-001');
  } finally {
    ledger.close();
  }
});
