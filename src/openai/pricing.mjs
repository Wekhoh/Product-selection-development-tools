/**
 * Verified November 2026 OpenAI API pricing table, conservative integer-cent
 * reservation estimator, and exact BigInt microdollar usage calculator.
 *
 * Units:
 *  - $1.00 = 1_000_000 microdollars (micros)
 *  - $0.01 (1 cent) = 10_000 microdollars (micros)
 *  - Internal per-token math uses exact BigInt picodollars ($1.00 = 10^12 picos;
 *    1 microdollar = 1_000_000 picos) so rates such as $0.125/1M or 50% Batch/Flex
 *    discounts ($0.0625/1M = 62_500 picos/token) never suffer IEEE-754 drift.
 */

export const MICROS_PER_DOLLAR = 1_000_000;
export const MICROS_PER_CENT = 10_000;
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;
export const WEB_SEARCH_CALL_MICROS = 10_000; // $10.00 / 1,000 calls = $0.01/call
export const DEFAULT_UNCAPPED_WEB_SEARCH_RESERVATION_CALLS = 25;
export const DEFAULT_TERRA_MAX_OUTPUT_TOKENS = 65_536;

const PICOS_PER_MICRO = 1_000_000n;
const MICROS_PER_CENT_BIG = 10_000n;
const WEB_SEARCH_CALL_MICROS_BIG = BigInt(WEB_SEARCH_CALL_MICROS);
const MAX_SAFE_INTEGER_BIG = BigInt(Number.MAX_SAFE_INTEGER);

export class OpenAiError extends Error {
  constructor(message, { code = 'OPENAI_ERROR', notDispatched = false, details = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.not_dispatched = Boolean(notDispatched);
    if (details && typeof details === 'object') {
      Object.assign(this, details);
    }
  }
}

export class OpenAiPolicyError extends OpenAiError {
  constructor(message, options = {}) {
    super(message, { code: 'OPENAI_POLICY_BLOCKED', notDispatched: true, ...options });
  }
}

export class OpenAiValidationError extends OpenAiError {
  constructor(message, options = {}) {
    super(message, { code: 'OPENAI_VALIDATION_ERROR', notDispatched: true, ...options });
  }
}

/**
 * Rates are expressed in microdollars per 1,000,000 tokens (= picodollars per 1 token).
 */
export const OPENAI_MODEL_PRICING = Object.freeze({
  'gpt-6-luna': Object.freeze({
    canonicalModel: 'gpt-6-luna',
    family: 'text',
    astraRestricted: false,
    inputMicrosPer1M: 100_000n,       // $0.10 / 1M
    cachedInputMicrosPer1M: 10_000n,  // $0.01 / 1M
    cacheWriteMicrosPer1M: 125_000n,  // $0.125 / 1M (30m cache write)
    outputMicrosPer1M: 500_000n,      // $0.50 / 1M
    supportsLongContextSurcharge: true,
    supportedTiers: Object.freeze(['standard', 'batch', 'flex']),
  }),
  'gpt-6.1-terra': Object.freeze({
    canonicalModel: 'gpt-6.1-terra',
    family: 'text',
    astraRestricted: false,
    inputMicrosPer1M: 1_000_000n,       // $1.00 / 1M
    cachedInputMicrosPer1M: 50_000n,    // $0.05 / 1M
    cacheWriteMicrosPer1M: 1_250_000n,  // $1.25 / 1M (30m cache write)
    outputMicrosPer1M: 5_000_000n,      // $5.00 / 1M
    supportsLongContextSurcharge: true,
    supportedTiers: Object.freeze(['standard', 'batch', 'flex', 'fast']),
  }),
  'gpt-6.1-sol': Object.freeze({
    canonicalModel: 'gpt-6.1-sol',
    family: 'text',
    astraRestricted: false,
    inputMicrosPer1M: 2_000_000n,       // $2.00 / 1M
    cachedInputMicrosPer1M: 100_000n,   // $0.10 / 1M
    cacheWriteMicrosPer1M: 2_500_000n,  // $2.50 / 1M (30m cache write)
    outputMicrosPer1M: 10_000_000n,     // $10.00 / 1M
    supportsLongContextSurcharge: true,
    supportedTiers: Object.freeze(['standard', 'batch', 'flex', 'fast']),
  }),
  'gpt-6.2-sol': Object.freeze({
    canonicalModel: 'gpt-6.2-sol',
    family: 'text',
    astraRestricted: false,
    inputMicrosPer1M: 2_000_000n,       // $2.00 / 1M
    cachedInputMicrosPer1M: 100_000n,   // $0.10 / 1M
    cacheWriteMicrosPer1M: 2_500_000n,  // $2.50 / 1M (30m cache write)
    outputMicrosPer1M: 10_000_000n,     // $10.00 / 1M
    supportsLongContextSurcharge: true,
    supportedTiers: Object.freeze(['standard', 'batch', 'flex', 'fast']),
  }),
  'gpt-6.2-astra': Object.freeze({
    canonicalModel: 'gpt-6.2-astra',
    family: 'text',
    astraRestricted: true,
    inputMicrosPer1M: 8_000_000n,       // $8.00 / 1M
    cachedInputMicrosPer1M: 400_000n,   // $0.40 / 1M
    cacheWriteMicrosPer1M: 10_000_000n, // $10.00 / 1M
    outputMicrosPer1M: 40_000_000n,     // $40.00 / 1M
    supportsLongContextSurcharge: true,
    supportedTiers: Object.freeze(['standard', 'batch', 'flex', 'fast']),
  }),
  'gpt-6-astra': Object.freeze({
    canonicalModel: 'gpt-6-astra',
    family: 'text',
    astraRestricted: true,
    inputMicrosPer1M: 10_000_000n,      // $10.00 / 1M
    cachedInputMicrosPer1M: 1_000_000n, // $1.00 / 1M
    cacheWriteMicrosPer1M: 12_500_000n, // $12.50 / 1M
    outputMicrosPer1M: 50_000_000n,     // $50.00 / 1M
    supportsLongContextSurcharge: true,
    supportedTiers: Object.freeze(['standard', 'batch', 'flex', 'fast']),
  }),
});

function ceilDivBigInt(numerator, denominator) {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

function assertNonNegSafeInt(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OpenAiValidationError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

export function resolveUncappedWebSearchReservationCalls(value = DEFAULT_UNCAPPED_WEB_SEARCH_RESERVATION_CALLS) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpenAiValidationError('uncappedWebSearchReservationCalls must be a positive safe integer.');
  }
  return value;
}

function estimateWebSearchCalls(tools, maxWebSearchCalls, maxToolCalls, uncappedWebSearchReservationCalls) {
  if (tools != null && (!Array.isArray(tools) ||
    tools.length > 1 || (tools.length === 1 && tools[0]?.type !== 'web_search'))) {
    throw new OpenAiValidationError('Reservation estimation supports one web_search tool.');
  }
  const uncappedCalls = resolveUncappedWebSearchReservationCalls(uncappedWebSearchReservationCalls);
  const caps = [maxWebSearchCalls, maxToolCalls, tools?.[0]?.max_tool_calls]
    .filter(cap => cap !== undefined);
  if (caps.some(cap => cap !== caps[0])) {
    throw new OpenAiValidationError('Conflicting web search caps in reservation estimate.');
  }
  if (tools?.length === 1) {
    const calls = caps[0] ?? uncappedCalls;
    if (!Number.isSafeInteger(calls) || calls < 1) {
      throw new OpenAiValidationError('A web search cap must be a positive safe integer, null, or omitted.');
    }
    return calls;
  }
  if (maxToolCalls != null) throw new OpenAiValidationError('max_tool_calls requires tools: [{ type: "web_search" }].');
  return assertNonNegSafeInt(maxWebSearchCalls ?? 0, 'maxWebSearchCalls');
}

function assertOptionalBooleanFlag(value, label) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new OpenAiValidationError(`${label} must be a boolean when provided.`);
  }
  return value;
}

export function safeMicrosToNumber(bigMicros) {
  if (typeof bigMicros !== 'bigint') {
    throw new OpenAiValidationError('bigMicros must be a BigInt.');
  }
  if (bigMicros < 0n || bigMicros > MAX_SAFE_INTEGER_BIG) {
    throw new OpenAiValidationError(
      'Computed microdollar cost exceeds Number.MAX_SAFE_INTEGER or is negative.',
      { code: 'COST_OVERFLOW_UNSAFE_INTEGER' },
    );
  }
  return Number(bigMicros);
}

export function resolveEffectiveServiceTier(rawTier, spec, { isBatch = false, treatOmittedAsAuto = false } = {}) {
  if (rawTier === undefined || rawTier === null || rawTier === '') {
    if (isBatch) {
      return { reportedTier: 'batch', pricingTier: 'batch' };
    }
    if (treatOmittedAsAuto) {
      const pricingTier = spec.supportedTiers.includes('fast') ? 'fast' : 'standard';
      return { reportedTier: 'auto', pricingTier };
    }
    return { reportedTier: 'standard', pricingTier: 'standard' };
  }
  if (typeof rawTier !== 'string') {
    throw new OpenAiValidationError('serviceTier must be a string.');
  }
  const lowered = rawTier.trim().toLowerCase();
  if (lowered === 'default') {
    return { reportedTier: 'standard', pricingTier: 'standard' };
  }
  if (lowered === 'auto') {
    // Automatic routing may settle at Priority ('fast', 2x) on models supporting 'fast';
    // reserve and price unresolved 'auto' conservatively at the highest reachable tier!
    const pricingTier = spec.supportedTiers.includes('fast') ? 'fast' : 'standard';
    return { reportedTier: 'auto', pricingTier };
  }
  if (lowered === 'priority') {
    return { reportedTier: 'fast', pricingTier: 'fast' };
  }
  if (!['standard', 'batch', 'flex', 'fast'].includes(lowered)) {
    throw new OpenAiValidationError(`Unsupported OpenAI serviceTier "${rawTier}".`);
  }
  return { reportedTier: lowered, pricingTier: lowered };
}

export function isAstraModel(model) {
  return typeof model === 'string' && /(?:^|[-_./])astra(?:$|[-_./\d])/i.test(model.trim());
}

export function resolveModelPricing(model, { allowAstraApi = false } = {}) {
  assertOptionalBooleanFlag(allowAstraApi, 'allowAstraApi');
  const raw = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!raw) {
    throw new OpenAiValidationError('model must be a nonempty string.');
  }

  if (isAstraModel(raw) && allowAstraApi !== true) {
    throw new OpenAiPolicyError(
      `Model "${model}" is blocked on paid OpenAI HTTP APIs by default; run GPT-6.2 Astra via local subscription Codex CLI ($0 API spend) or pass allowAstraApi: true explicitly.`,
      { code: 'ASTRA_API_BLOCKED' },
    );
  }

  if (Object.hasOwn(OPENAI_MODEL_PRICING, raw)) {
    const spec = OPENAI_MODEL_PRICING[raw];
    if (spec.astraRestricted && allowAstraApi !== true) {
      throw new OpenAiPolicyError(
        `Model "${model}" is blocked on paid OpenAI HTTP APIs by default; run Astra via local subscription Codex CLI.`,
        { code: 'ASTRA_API_BLOCKED' },
      );
    }
    return spec;
  }

  // Match dated canonical snapshot aliases such as gpt-6.1-terra-2026-11-01.
  const dateSuffixMatch = raw.match(/^(.+)-\d{4}-\d{2}-\d{2}$/);
  if (dateSuffixMatch && Object.hasOwn(OPENAI_MODEL_PRICING, dateSuffixMatch[1])) {
    const spec = OPENAI_MODEL_PRICING[dateSuffixMatch[1]];
    if (spec.astraRestricted && allowAstraApi !== true) {
      throw new OpenAiPolicyError(
        `Model "${model}" is blocked on paid OpenAI HTTP APIs by default; run Astra via local subscription Codex CLI.`,
        { code: 'ASTRA_API_BLOCKED' },
      );
    }
    return spec;
  }

  throw new OpenAiValidationError(`Unknown or unpriced OpenAI model "${model}".`, {
    code: 'UNKNOWN_OPENAI_MODEL',
  });
}

function tierFraction(serviceTier, spec) {
  if (!spec.supportedTiers.includes(serviceTier)) {
    throw new OpenAiValidationError(
      `Model "${spec.canonicalModel}" does not support serviceTier "${serviceTier}" (supported: ${spec.supportedTiers.join(', ')}).`,
    );
  }
  if (serviceTier === 'batch' || serviceTier === 'flex') {
    return { num: 1n, den: 2n };
  }
  if (serviceTier === 'fast') {
    return { num: 2n, den: 1n };
  }
  return { num: 1n, den: 1n };
}

export function microsToCeilingCents(micros, { minBillableCents = 0 } = {}) {
  const safeMicros = assertNonNegSafeInt(micros, 'micros');
  const minCents = assertNonNegSafeInt(minBillableCents, 'minBillableCents');
  const cents = safeMicrosToNumber(ceilDivBigInt(BigInt(safeMicros), MICROS_PER_CENT_BIG));
  return Math.max(minCents, cents);
}

/**
 * Compute conservative worst-case microdollar and integer-cent cost estimate
 * (used for informational Batch JSONL cost previews).
 */
export function estimateCostBreakdown({
  endpoint = '/v1/responses',
  model,
  serviceTier = undefined,
  estimatedInputTokens,
  maxOutputTokens = 0,
  questionCount = 0,
  maxWebSearchCalls,
  max_tool_calls: maxToolCalls,
  tools = null,
  uncappedWebSearchReservationCalls,
  allowAstraApi = false,
  cacheWritePossible = true,
} = {}) {
  assertOptionalBooleanFlag(cacheWritePossible, 'cacheWritePossible');
  const normEndpoint = typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : '/v1/responses';
  const spec = resolveModelPricing(model, { allowAstraApi });
  const isBatchEndpoint = normEndpoint === '/v1/batches';
  const { reportedTier: tier, pricingTier } = resolveEffectiveServiceTier(serviceTier, spec, {
    isBatch: isBatchEndpoint,
    treatOmittedAsAuto: !isBatchEndpoint,
  });
  const { num: tierNum, den: tierDen } = tierFraction(pricingTier, spec);
  const searchCalls = estimateWebSearchCalls(tools, maxWebSearchCalls, maxToolCalls, uncappedWebSearchReservationCalls);

  const inTokens = assertNonNegSafeInt(estimatedInputTokens, 'estimatedInputTokens');
  const qCount = assertNonNegSafeInt(questionCount ?? 0, 'questionCount');
  const rawOutTokens = assertNonNegSafeInt(maxOutputTokens, 'maxOutputTokens');
  const outTokens = normEndpoint === '/v1/decisions' && qCount > 0
    ? Math.max(rawOutTokens, safeMicrosToNumber(BigInt(qCount) * 256n))
    : rawOutTokens;
  const longContext = spec.supportsLongContextSurcharge && inTokens > LONG_CONTEXT_THRESHOLD_TOKENS;

  const baseInputMicrosPer1M =
    cacheWritePossible !== false &&
    spec.cacheWriteMicrosPer1M !== undefined &&
    spec.cacheWriteMicrosPer1M > spec.inputMicrosPer1M
      ? spec.cacheWriteMicrosPer1M
      : spec.inputMicrosPer1M;

  const inRatePicos = longContext ? baseInputMicrosPer1M * 2n : baseInputMicrosPer1M;
  // Output multiplier on >272K context is 1.5x (3/2)
  const outRateNum = longContext ? spec.outputMicrosPer1M * 3n : spec.outputMicrosPer1M;
  const outRateDen = longContext ? 2n : 1n;

  const inPicos = BigInt(inTokens) * inRatePicos;
  const outPicos = ceilDivBigInt(BigInt(outTokens) * outRateNum, outRateDen);
  const combinedTokenPicos = ceilDivBigInt((inPicos + outPicos) * tierNum, tierDen);
  const tokenMicrosBig = ceilDivBigInt(combinedTokenPicos, PICOS_PER_MICRO);
  const totalMicrosBig = tokenMicrosBig + (BigInt(searchCalls) * WEB_SEARCH_CALL_MICROS_BIG);
  const totalMicros = safeMicrosToNumber(totalMicrosBig);
  const reservationCents = microsToCeilingCents(totalMicros, { minBillableCents: 1 });

  return {
    endpoint: normEndpoint,
    model: spec.canonicalModel,
    service_tier: tier,
    long_context_applied: longContext,
    estimated_micros: totalMicros,
    reservation_cents: reservationCents,
  };
}

export function estimateReservationCents(params = {}) {
  return estimateCostBreakdown(params).reservation_cents;
}

/**
 * Compute exact integer microdollar usage cost from an OpenAI API `usage` payload.
 *
 * CRITICAL INVARIANT:
 * OpenAI `usage.output_tokens` ALREADY includes `usage.output_tokens_details.reasoning_tokens`.
 * We validate `output_tokens >= reasoning_tokens` and NEVER double-charge `reasoning_tokens`.
 */
export function computeUsageCostMicros({
  model,
  serviceTier = 'standard',
  usage,
  webSearchCalls = 0,
  allowAstraApi = true,
} = {}) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new OpenAiValidationError('usage must be a non-null object.');
  }
  const spec = resolveModelPricing(model, { allowAstraApi });
  const { pricingTier } = resolveEffectiveServiceTier(serviceTier, spec);
  const { num: tierNum, den: tierDen } = tierFraction(pricingTier, spec);
  const searchCalls = assertNonNegSafeInt(webSearchCalls, 'webSearchCalls');

  if (usage.input_tokens === undefined || usage.input_tokens === null) {
    throw new OpenAiValidationError('usage.input_tokens is required (missing usage is never treated as zero).');
  }
  if (usage.output_tokens === undefined || usage.output_tokens === null) {
    throw new OpenAiValidationError('usage.output_tokens is required (missing usage is never treated as zero).');
  }
  const inputTokens = assertNonNegSafeInt(usage.input_tokens, 'usage.input_tokens');
  const outputTokens = assertNonNegSafeInt(usage.output_tokens, 'usage.output_tokens');

  const inDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details
    : {};
  const cachedTokens = assertNonNegSafeInt(inDetails.cached_tokens ?? 0, 'usage.input_tokens_details.cached_tokens');
  const cacheWriteTokens = assertNonNegSafeInt(
    inDetails.cache_write_tokens ?? inDetails.cached_creation_tokens ?? 0,
    'usage.input_tokens_details.cache_write_tokens',
  );
  if (cachedTokens + cacheWriteTokens > inputTokens) {
    throw new OpenAiValidationError(
      `Invalid OpenAI usage: cached_tokens (${cachedTokens}) + cache_write_tokens (${cacheWriteTokens}) exceeds input_tokens (${inputTokens}).`,
    );
  }

  const outDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details
    : {};
  const reasoningTokens = assertNonNegSafeInt(
    outDetails.reasoning_tokens ?? 0,
    'usage.output_tokens_details.reasoning_tokens',
  );
  if (reasoningTokens > outputTokens) {
    throw new OpenAiValidationError(
      `Invalid OpenAI usage: reasoning_tokens (${reasoningTokens}) exceeds output_tokens (${outputTokens}).`,
    );
  }

  const uncachedInputTokens = inputTokens - cachedTokens - cacheWriteTokens;
  const longContext = spec.supportsLongContextSurcharge && inputTokens > LONG_CONTEXT_THRESHOLD_TOKENS;
  const inMult = longContext ? 2n : 1n;

  const inputPicos =
    (BigInt(uncachedInputTokens) * spec.inputMicrosPer1M * inMult) +
    (BigInt(cachedTokens) * spec.cachedInputMicrosPer1M * inMult) +
    (BigInt(cacheWriteTokens) * spec.cacheWriteMicrosPer1M * inMult);

  // Charge outputTokens ONCE (never outputTokens + reasoningTokens!).
  const outputPicos = longContext
    ? ceilDivBigInt(BigInt(outputTokens) * spec.outputMicrosPer1M * 3n, 2n)
    : BigInt(outputTokens) * spec.outputMicrosPer1M;

  const combinedTokenPicos = ceilDivBigInt((inputPicos + outputPicos) * tierNum, tierDen);
  const tokenMicrosBig = ceilDivBigInt(combinedTokenPicos, PICOS_PER_MICRO);
  const totalMicrosBig = tokenMicrosBig + (BigInt(searchCalls) * WEB_SEARCH_CALL_MICROS_BIG);
  return safeMicrosToNumber(totalMicrosBig);
}
