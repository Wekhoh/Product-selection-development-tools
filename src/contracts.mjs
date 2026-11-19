/**
 * Structured short-context output validators and PII redaction guards for Phase 2.
 * LLM outputs judge purpose/relevance; deterministic code validates currency, dates,
 * quantities, sets, component coverage, SKU-level review provenance, and PII boundaries.
 */
import { validEvidenceDate } from './observations.mjs';
import { computeOrderPlan } from './fba-rates-2027.mjs';
import { toBigRat, addBigRat, mulBigRat, roundBigRat, ratCmp } from './fee-basis.mjs';

export const ALLOWED_DISPOSITIONS = Object.freeze([
  'product',
  'context',
  'brand_specific',
  'promotion_only',
  'delivery_only',
  'seasonal_deferred',
  'needs_context',
  'unreviewed',
]);

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

const PII_PATTERNS = [
  { name: 'cn_mobile_number', re: /(?<!\d)1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/ },
  { name: 'cn_landline_number', re: /(?<!\d)0\d{2,3}[\s-]\d{7,8}(?!\d)/ },
  { name: 'receiver_contact_label', re: /(收货人|收件人|联系人)\s*[:：]\s*[^\s,，;；]+/ },
  { name: 'detailed_street_address', re: /(?:路|大道|街|巷|弄)\s*[零一二三四五六七八九十百千\d]+\s*号|(?:栋|幢|单元|室|号楼|楼层)\s*[零一二三四五六七八九十百千\d]+|[零一二三四五六七八九十百千\d]+\s*(?:栋|幢|单元|室|号楼|层)/ },
  { name: 'windows_user_path', re: /[A-Za-z]:\\Users\\[^\\\s"'<>]+/i },
  { name: 'posix_user_path', re: /(?:^|[\s"'(=/])(?:file:\/\/\/)?(?:Users|home)\/[^/\s"'<>]+/i },
];

const SENSITIVE_PII_KEYS = new Set([
  'receiver_name',
  'recipient_name',
  'contact_name',
  'receiver_phone',
  'recipient_phone',
  'contact_phone',
  'mobile',
  'mobile_phone',
  'phone',
  'phone_number',
  'tel',
  'telephone',
  'street_address',
  'full_address',
  'detailed_address',
]);

const finite = v => typeof v === 'number' && Number.isFinite(v);
const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertNonemptyString(value, label) {
  if (!nonemptyStr(value)) throw new TypeError(`${label} must be a nonempty string.`);
  return value.trim();
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function assertTriState(value, label) {
  if (value !== true && value !== false && value !== 'unknown') {
    throw new TypeError(`${label} must be true, false, or 'unknown'.`);
  }
  return value;
}

function assertHttpUrl(value, label) {
  const raw = assertNonemptyString(value, label);
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new TypeError(`${label} must be a valid absolute HTTP/HTTPS URL.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`${label} must use http: or https: protocol.`);
  }
  return raw;
}

/**
 * Check whether a string or numeric value contains raw PII
 * (phone numbers, receiver names, street addresses, or local user paths).
 */
export function detectRawPii(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const asStr = String(value);
    if (/^1[3-9]\d{9}$/.test(asStr)) return 'cn_mobile_number';
    return null;
  }
  if (typeof value !== 'string' || !value) return null;
  for (const { name, re } of PII_PATTERNS) {
    if (re.test(value)) return name;
  }
  return null;
}

export function containsRawPii(value) {
  return detectRawPii(value) !== null;
}

/**
 * Scrub PII and credential/token patterns from diagnostic/error strings before recording them into ledger or form notes.
 */
export function sanitizeDiagnosticText(text) {
  if (typeof text !== 'string' || !text) return '';
  let out = text;
  out = out.replace(/(?<!\d)1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, '[REDACTED_PHONE]');
  out = out.replace(/(?<!\d)0\d{2,3}[\s-]\d{7,8}(?!\d)/g, '[REDACTED_PHONE]');
  out = out.replace(/(收货人|收件人|联系人)\s*[:：]\s*[^\s,，;；]+/g, '$1:[REDACTED_NAME]');
  out = out.replace(/\b(receiver_name|recipient_name|contact_name)\s*[:=]\s*[^\s,，;；]+/gi, '$1=[REDACTED_NAME]');
  out = out.replace(/(?:路|大道|街|巷|弄)\s*[零一二三四五六七八九十百千\d]+\s*号/g, '[REDACTED_STREET]');
  out = out.replace(/(?:栋|幢|单元|室|号楼|楼层)\s*[零一二三四五六七八九十百千\d]+|[零一二三四五六七八九十百千\d]+\s*(?:栋|幢|单元|室|号楼|层)/g, '[REDACTED_UNIT]');
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)*/gi, '[REDACTED_PATH]');
  out = out.replace(/(?:file:\/\/\/)?\/?(?:Users|home)\/[^/\s"'<>]+(?:\/[^\s"'<>]*)*/gi, '[REDACTED_PATH]');
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|xox[bpas]-[A-Za-z0-9-]{6,}|AIza[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{6,})/g, '[REDACTED_TOKEN]');
  out = out.replace(/\b(Bearer\s+)[^\s,;"']+/gi, '$1[REDACTED_TOKEN]');
  out = out.replace(/\b(api[_-]?key|access[_-]?token|secret[_-]?key|token|authorization|cookie|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED_SECRET]');
  return out;
}

const SECRET_VALUE_RE = /\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|xox[bpas]-[A-Za-z0-9-]{6,}|AIza[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{6,})|\bBearer\s+\S+/i;
const SENSITIVE_SECRET_KEYS = new Set([
  'api_key', 'apikey', 'access_token', 'refresh_token', 'secret_key', 'authorization', 'cookie', 'password',
]);

export function containsSecretToken(value, seen = new Set(), depth = 0) {
  if (value === null || value === undefined || depth > 6) return false;
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) return true;
    const s = value.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try { return containsSecretToken(JSON.parse(s), seen, depth + 1); } catch { /* ignore */ }
    }
    return false;
  }
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsSecretToken(item, seen, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_SECRET_KEYS.has(k.toLowerCase()) && v !== null && v !== undefined && String(v).trim() !== '') {
      return true;
    }
    if (containsSecretToken(v, seen, depth + 1)) return true;
  }
  return false;
}

/**
 * Recursively assert that no string, JSON-encoded MCP text block, number, or dedicated PII field
 * inside value contains raw PII. Never echoes the offending PII value in the error message.
 */
export function assertNoRawPii(value, label = 'payload', seen = new Set(), depth = 0) {
  if (value === null || value === undefined || depth > 6) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const match = detectRawPii(value);
    if (match) {
      throw new TypeError(`${label} contains unredacted PII or local user path (${match}); redact before persisting.`);
    }
    if (typeof value === 'string') {
      const s = value.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try { assertNoRawPii(JSON.parse(s), `${label}<json>`, seen, depth + 1); } catch (e) {
          if (e instanceof TypeError && /unredacted PII/i.test(e.message)) throw e;
        }
      }
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoRawPii(value[i], `${label}[${i}]`, seen, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const keyLower = key.toLowerCase();
    if (SENSITIVE_PII_KEYS.has(keyLower) && entry !== null && entry !== undefined && String(entry).trim() !== '') {
      throw new TypeError(`${label}.${key} carries unredacted PII field (${keyLower}); remove or redact before persisting.`);
    }
    assertNoRawPii(entry, `${label}.${key}`, seen, depth + 1);
  }
}

export function isShenzhenDestination(dest) {
  if (typeof dest !== 'string') return false;
  return /深圳|shenzhen/i.test(dest);
}

/**
 * Validate province/city-only shipping destination (e.g., "广东深圳", "Guangdong Shenzhen").
 */
export function validateRedactedDestination(dest, label = 'redacted_destination', { requireShenzhen = false } = {}) {
  const trimmed = assertNonemptyString(dest, label);
  if (trimmed.length > 48) {
    throw new TypeError(`${label} is too long for a province/city-only destination.`);
  }
  assertNoRawPii(trimmed, label);
  if (/\d{5,}/.test(trimmed)) {
    throw new TypeError(`${label} must not contain long numeric sequences (postal/phone/building numbers).`);
  }
  if (requireShenzhen && !isShenzhenDestination(trimmed)) {
    throw new TypeError(`${label} must specify Shenzhen (深圳/Shenzhen) freight destination for verified domestic landed-cost quotes.`);
  }
  return trimmed;
}

/**
 * Contract 1: SocialBridgeExtractor
 */
export function validateSocialBridgeOutput(output) {
  assertObject(output, 'SocialBridgeExtractor output');
  if (output.schema_version !== 1 || output.contract !== 'SocialBridgeExtractor') {
    throw new TypeError('SocialBridgeExtractor output requires schema_version: 1 and contract: "SocialBridgeExtractor".');
  }
  const allowedStatus = ['extracted', 'no_buyable_product', 'unknown'];
  if (!allowedStatus.includes(output.status)) {
    throw new TypeError(`SocialBridgeExtractor status must be one of ${allowedStatus.join(', ')}.`);
  }
  const platform = assertNonemptyString(output.platform, 'platform');
  if (output.source_url !== undefined && output.source_url !== null) {
    assertHttpUrl(output.source_url, 'source_url');
  } else if (!nonemptyStr(output.source_ref)) {
    throw new TypeError('SocialBridgeExtractor requires an inspectable source_url or source_ref.');
  }
  if (!validEvidenceDate(output.observed_at)) {
    throw new TypeError('SocialBridgeExtractor observed_at must be a valid ISO date or timestamp with timezone.');
  }
  const eventDedupKey = assertNonemptyString(output.event_dedup_key, 'event_dedup_key');
  if (!Array.isArray(output.candidate_phrases)) {
    throw new TypeError('SocialBridgeExtractor candidate_phrases must be an array.');
  }
  const phrases = output.candidate_phrases.map((p, idx) => assertNonemptyString(p, `candidate_phrases[${idx}]`));

  if (output.status === 'extracted') {
    assertNonemptyString(output.verbatim_excerpt, 'verbatim_excerpt');
    assertNonemptyString(output.buyer_task, 'buyer_task');
    if (phrases.length === 0) {
      throw new TypeError('SocialBridgeExtractor with status "extracted" requires at least one candidate_phrase.');
    }
  } else if (output.status === 'no_buyable_product') {
    assertNonemptyString(output.verbatim_excerpt, 'verbatim_excerpt');
  } else if (output.verbatim_excerpt !== null && output.verbatim_excerpt !== undefined) {
    assertNonemptyString(output.verbatim_excerpt, 'verbatim_excerpt');
  }

  assertNoRawPii(output, 'SocialBridgeExtractor');
  return {
    valid: true,
    contract: 'SocialBridgeExtractor',
    status: output.status,
    platform,
    event_dedup_key: eventDedupKey,
    candidate_phrases: [...new Set(phrases)],
  };
}

/**
 * Contract 2: SpecMatcher
 */
export function validateSpecMatcherOutput(output) {
  assertObject(output, 'SpecMatcher output');
  if (output.schema_version !== 1 || output.contract !== 'SpecMatcher') {
    throw new TypeError('SpecMatcher output requires schema_version: 1 and contract: "SpecMatcher".');
  }
  const allowedVerdicts = ['exact_match', 'approximate_match', 'mismatch', 'unknown'];
  if (!allowedVerdicts.includes(output.verdict)) {
    throw new TypeError(`SpecMatcher verdict must be one of ${allowedVerdicts.join(', ')}.`);
  }
  const comparable = assertTriState(output.comparable_for_q31, 'comparable_for_q31');
  const scope = assertNonemptyString(output.scope, 'scope');
  const buyerTask = assertNonemptyString(output.buyer_task, 'buyer_task');
  const reason = assertNonemptyString(output.reason, 'reason');
  if (!Array.isArray(output.evidence_refs)) {
    throw new TypeError('SpecMatcher evidence_refs must be an array.');
  }
  const refs = output.evidence_refs.map((r, idx) => assertNonemptyString(r, `evidence_refs[${idx}]`));
  if (output.verdict !== 'unknown' && refs.length === 0) {
    throw new TypeError('SpecMatcher requires at least one evidence_ref when verdict is not "unknown".');
  }
  if (output.verdict === 'mismatch' && comparable === true) {
    throw new TypeError('SpecMatcher cannot mark verdict "mismatch" with comparable_for_q31: true.');
  }
  if (output.verdict === 'unknown' && comparable !== 'unknown') {
    throw new TypeError('SpecMatcher with verdict "unknown" must keep comparable_for_q31 as "unknown".');
  }
  assertNoRawPii(output, 'SpecMatcher');
  return {
    valid: true,
    contract: 'SpecMatcher',
    verdict: output.verdict,
    comparable_for_q31: comparable,
    scope,
    buyer_task: buyerTask,
    reason,
    evidence_refs: [...new Set(refs)],
  };
}

/**
 * Contract 3: SourcingVerifier1688
 * Machine-verifies 1688 SKU lines, required component completeness, carton/MOQ arithmetic via
 * computeOrderPlan, exact CNY total parity, non-promo regular quotes, freebie flags, and PII redaction.
 */
export function validateSourcingVerifier1688Output(output, { expected_components = null } = {}) {
  assertObject(output, 'SourcingVerifier1688 output');
  if (output.schema_version !== 1 || output.contract !== 'SourcingVerifier1688') {
    throw new TypeError('SourcingVerifier1688 output requires schema_version: 1 and contract: "SourcingVerifier1688".');
  }
  const allowedStatus = ['verified', 'rejected', 'unknown'];
  if (!allowedStatus.includes(output.status)) {
    throw new TypeError(`SourcingVerifier1688 status must be one of ${allowedStatus.join(', ')}.`);
  }
  if (!validEvidenceDate(output.observed_at)) {
    throw new TypeError('SourcingVerifier1688 observed_at must be a valid ISO date or timestamp with timezone.');
  }
  if (output.expires_at !== undefined && output.expires_at !== null) {
    if (!validEvidenceDate(output.expires_at)) {
      throw new TypeError('SourcingVerifier1688 expires_at must be a valid ISO date or timestamp with timezone.');
    }
    if (Date.parse(output.expires_at) < Date.parse(output.observed_at)) {
      throw new TypeError('SourcingVerifier1688 expires_at cannot precede observed_at.');
    }
  }

  // Enforce PII redaction across the entire sourcing payload before any persistence.
  assertNoRawPii(output, 'SourcingVerifier1688');
  const redactedDestination = validateRedactedDestination(output.redacted_destination, 'redacted_destination', {
    requireShenzhen: output.status === 'verified',
  });

  if (output.redacted_webp_sha256 !== undefined && output.redacted_webp_sha256 !== null) {
    if (typeof output.redacted_webp_sha256 !== 'string' || !HEX_SHA256_RE.test(output.redacted_webp_sha256)) {
      throw new TypeError('redacted_webp_sha256 must be a 64-char lowercase hex SHA-256 string.');
    }
  }

  if (output.status === 'verified') {
    const hasReadbackProof = nonemptyStr(output.raw_readback_ref) ||
      nonemptyStr(output.redacted_webp_sha256) ||
      nonemptyStr(output.redacted_screenshot_path);
    if (!hasReadbackProof) {
      throw new TypeError('Verified 1688 quote requires at least one readback or redacted screenshot reference (raw_readback_ref, redacted_webp_sha256, or redacted_screenshot_path).');
    }
  }

  const flags = assertObject(output.sensitive_freebie_flags ?? {}, 'sensitive_freebie_flags');
  const allowedPresence = ['none', 'present', 'unknown'];
  const allowedBattery = ['none', 'builtin', 'included', 'unknown'];
  const normalizedFlags = {
    oil_or_glue: flags.oil_or_glue ?? 'unknown',
    battery_type: flags.battery_type ?? 'unknown',
    strong_magnet: flags.strong_magnet ?? 'unknown',
    notes: flags.notes ?? null,
  };
  if (!allowedPresence.includes(normalizedFlags.oil_or_glue)) {
    throw new TypeError('sensitive_freebie_flags.oil_or_glue must be none, present, or unknown.');
  }
  if (!allowedBattery.includes(normalizedFlags.battery_type)) {
    throw new TypeError('sensitive_freebie_flags.battery_type must be none, builtin, included, or unknown.');
  }
  if (!allowedPresence.includes(normalizedFlags.strong_magnet)) {
    throw new TypeError('sensitive_freebie_flags.strong_magnet must be none, present, or unknown.');
  }

  if (output.lead_time_days !== undefined && output.lead_time_days !== null) {
    if (!Number.isInteger(output.lead_time_days) || output.lead_time_days < 0) {
      throw new TypeError('lead_time_days must be a nonnegative integer when provided.');
    }
  }

  const goodsPromo = assertBoolean(output.goods_first_order_promotion, 'goods_first_order_promotion');
  const freightPromo = assertBoolean(output.freight_first_order_promotion, 'freight_first_order_promotion');

  if (output.status === 'unknown') {
    // Pending/unknown quotes may omit goods_cny_total or domestic_freight_cny_total while keeping strict validation if supplied.
    if (output.goods_cny_total !== undefined && output.goods_cny_total !== null && (!finite(output.goods_cny_total) || output.goods_cny_total <= 0)) {
      throw new TypeError('goods_cny_total must be a positive finite number or null when pending.');
    }
    if (output.domestic_freight_cny_total !== undefined && output.domestic_freight_cny_total !== null && (!finite(output.domestic_freight_cny_total) || output.domestic_freight_cny_total < 0)) {
      throw new TypeError('domestic_freight_cny_total must be a nonnegative finite number or null when pending.');
    }
    let pendingPlan = null;
    if (Array.isArray(output.sku_lines) && output.sku_lines.length > 0) {
      pendingPlan = computeOrderPlan({
        sku_lines: output.sku_lines,
        allow_remainder: Boolean(output.allow_remainder ?? false),
        target_sets: output.target_sets ?? 100,
      });
    }
    return {
      valid: true,
      contract: 'SourcingVerifier1688',
      status: 'unknown',
      redacted_destination: redactedDestination,
      sensitive_freebie_flags: normalizedFlags,
      order_plan: pendingPlan,
      goods_first_order_promotion: goodsPromo,
      freight_first_order_promotion: freightPromo,
    };
  }

  if (!Array.isArray(output.sku_lines) || output.sku_lines.length === 0) {
    throw new TypeError('SourcingVerifier1688 requires a nonempty sku_lines array.');
  }

  // Enforce complete saleable-set component coverage when form.saleable_set_composition declares components.
  const requiredComponents = expected_components ?? output.expected_components ?? null;
  if (Array.isArray(requiredComponents) && requiredComponents.length > 0 && output.status === 'verified') {
    for (const comp of requiredComponents) {
      const compId = assertNonemptyString(comp.component_id ?? comp.id, 'expected_component.component_id');
      const reqQty = comp.qty_per_saleable_set;
      if (!Number.isSafeInteger(reqQty) || reqQty < 1) {
        throw new TypeError(`expected_component ${compId} requires positive integer qty_per_saleable_set.`);
      }
      const matched = output.sku_lines.filter(l => (l.component_id ?? l.sku_id) === compId);
      const coveredQty = matched.reduce((sum, l) => sum + (Number.isSafeInteger(l.qty_per_saleable_set) ? l.qty_per_saleable_set : 0), 0);
      if (coveredQty < reqQty) {
        throw new TypeError(
          `Verified 1688 quote is missing required saleable-set component "${compId}" (needs qty_per_saleable_set=${reqQty}, got ${coveredQty}).`,
        );
      }
    }
  }

  const allowRemainder = Boolean(output.allow_remainder ?? false);
  const targetSets = output.target_sets ?? 100;
  const orderPlan = computeOrderPlan({
    sku_lines: output.sku_lines,
    allow_remainder: allowRemainder,
    target_sets: targetSets,
  });

  if (output.actual_sets !== undefined && output.actual_sets !== orderPlan.allocated_sets) {
    throw new TypeError(`Declared actual_sets (${output.actual_sets}) does not match computed carton/MOQ plan (${orderPlan.allocated_sets}).`);
  }
  if (output.actual_complete_sets !== undefined && output.actual_complete_sets !== orderPlan.actual_complete_sets) {
    throw new TypeError(`Declared actual_complete_sets (${output.actual_complete_sets}) does not match computed complete sets (${orderPlan.actual_complete_sets}).`);
  }

  let exactGoodsCny = toBigRat(0);
  for (let i = 0; i < output.sku_lines.length; i++) {
    const line = output.sku_lines[i];
    const planned = orderPlan.sku_lines[i];
    if (output.status === 'verified') {
      assertNonemptyString(line.offer_id, `sku_lines[${i}].offer_id`);
      assertNonemptyString(line.sku_id, `sku_lines[${i}].sku_id`);
      if (!Number.isSafeInteger(line.ordered_qty)) {
        throw new TypeError(`sku_lines[${i}].ordered_qty is required for verified 1688 quotes.`);
      }
    }
    if (!finite(line.unit_price_cny) || line.unit_price_cny <= 0) {
      throw new TypeError(`sku_lines[${i}].unit_price_cny must be a positive finite number.`);
    }
    if (line.ordered_qty !== undefined && line.ordered_qty !== planned.ordered_qty) {
      throw new TypeError(`sku_lines[${i}].ordered_qty (${line.ordered_qty}) does not match carton/MOQ required quantity (${planned.ordered_qty}).`);
    }
    if (output.status === 'verified' && line.regular_goods_promo_false !== true) {
      throw new TypeError(`sku_lines[${i}].regular_goods_promo_false must be true for a verified regular quote.`);
    }
    exactGoodsCny = addBigRat(exactGoodsCny, mulBigRat(toBigRat(planned.ordered_qty), toBigRat(line.unit_price_cny)));
  }

  if (!finite(output.goods_cny_total) || output.goods_cny_total <= 0) {
    throw new TypeError('goods_cny_total must be a positive finite number.');
  }
  if (!finite(output.domestic_freight_cny_total) || output.domestic_freight_cny_total < 0) {
    throw new TypeError('domestic_freight_cny_total must be a nonnegative finite number.');
  }

  // Exact BigInt parity: must equal either exact sum OR standard 2-dp rounded sum (rejects 199.99 when exact sum is 200.00).
  const declaredGoodsRat = toBigRat(output.goods_cny_total);
  const exactRounded2dpRat = toBigRat(roundBigRat(exactGoodsCny.n, exactGoodsCny.d, 2));
  const exactRounded4dpRat = toBigRat(roundBigRat(exactGoodsCny.n, exactGoodsCny.d, 4));
  const matchesExact = ratCmp(declaredGoodsRat, exactGoodsCny) === 0 ||
    ratCmp(declaredGoodsRat, exactRounded2dpRat) === 0 ||
    ratCmp(declaredGoodsRat, exactRounded4dpRat) === 0;
  if (!matchesExact) {
    throw new TypeError(
      `Declared goods_cny_total (${output.goods_cny_total}) disagrees with exact sku_lines sum (${roundBigRat(exactGoodsCny.n, exactGoodsCny.d, 4)}).`,
    );
  }

  if (output.status === 'verified') {
    if (goodsPromo !== false || freightPromo !== false) {
      throw new TypeError('Verified regular 1688 quote requires both goods_first_order_promotion: false and freight_first_order_promotion: false.');
    }
    if (orderPlan.allocated_sets < 100 || orderPlan.actual_complete_sets < 100) {
      throw new TypeError('Verified quote must cover at least 100 complete saleable sets.');
    }
  }

  return {
    valid: true,
    contract: 'SourcingVerifier1688',
    status: output.status,
    redacted_destination: redactedDestination,
    sensitive_freebie_flags: normalizedFlags,
    order_plan: orderPlan,
    exact_goods_cny_total: roundBigRat(exactGoodsCny.n, exactGoodsCny.d, 4),
    goods_first_order_promotion: goodsPromo,
    freight_first_order_promotion: freightPromo,
  };
}

/**
 * Contract 4: PainPointAndRubricJudge
 */
export function validatePainPointAndRubricJudgeOutput(output) {
  assertObject(output, 'PainPointAndRubricJudge output');
  if (output.schema_version !== 1 || output.contract !== 'PainPointAndRubricJudge') {
    throw new TypeError('PainPointAndRubricJudge output requires schema_version: 1 and contract: "PainPointAndRubricJudge".');
  }
  const allowedStatus = ['supported', 'not_supported', 'unknown'];
  if (!allowedStatus.includes(output.status)) {
    throw new TypeError(`PainPointAndRubricJudge status must be one of ${allowedStatus.join(', ')}.`);
  }
  const itemId = assertNonemptyString(output.item_id, 'item_id');
  if (!Array.isArray(output.evidence_refs)) {
    throw new TypeError('PainPointAndRubricJudge evidence_refs must be an array.');
  }
  if (!Array.isArray(output.counter_evidence)) {
    throw new TypeError('PainPointAndRubricJudge counter_evidence must be an array (may be empty when none observed).');
  }
  const evidenceRefs = output.evidence_refs.map((r, idx) => assertNonemptyString(r, `evidence_refs[${idx}]`));
  const counterEvidence = output.counter_evidence.map((r, idx) => assertNonemptyString(r, `counter_evidence[${idx}]`));

  if (output.status !== 'unknown' && evidenceRefs.length === 0) {
    throw new TypeError('PainPointAndRubricJudge requires at least one evidence_ref when status is not "unknown".');
  }

  const citations = output.review_citations === undefined ? [] : output.review_citations;
  if (!Array.isArray(citations)) {
    throw new TypeError('PainPointAndRubricJudge review_citations must be an array.');
  }
  const normalizedCitations = citations.map((c, idx) => {
    assertObject(c, `review_citations[${idx}]`);
    return {
      review_id: assertNonemptyString(c.review_id, `review_citations[${idx}].review_id`),
      sku_verified: assertTriState(c.sku_verified, `review_citations[${idx}].sku_verified`),
      variant_sku: c.variant_sku === undefined || c.variant_sku === null ? null : assertNonemptyString(c.variant_sku, `review_citations[${idx}].variant_sku`),
      excerpt: assertNonemptyString(c.excerpt, `review_citations[${idx}].excerpt`),
    };
  });

  if (output.proposed_score !== undefined && output.proposed_score !== null) {
    if (!finite(output.proposed_score) || output.proposed_score < 0) {
      throw new TypeError('proposed_score must be a nonnegative finite number or null.');
    }
  }

  if (itemId === 'feasible_light_differentiation' && (output.status === 'supported' || (finite(output.proposed_score) && output.proposed_score > 0))) {
    const hasVerifiedSkuReview = normalizedCitations.some(c => c.sku_verified === true);
    if (!hasVerifiedSkuReview) {
      throw new TypeError(
        'feasible_light_differentiation cannot be marked supported or awarded >0 points without at least one review_citation with sku_verified: true.',
      );
    }
  }

  assertNoRawPii(output, 'PainPointAndRubricJudge');
  return {
    valid: true,
    contract: 'PainPointAndRubricJudge',
    item_id: itemId,
    status: output.status,
    evidence_refs: [...new Set(evidenceRefs)],
    counter_evidence: counterEvidence,
    review_citations: normalizedCitations,
  };
}
