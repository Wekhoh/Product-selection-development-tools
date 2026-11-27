/**
 * Structured short-context output validators and PII redaction guards for Phase 2.
 * LLM outputs judge purpose/relevance; deterministic code validates currency, dates,
 * quantities, sets, component coverage, SKU-level review provenance, and PII boundaries.
 */
import { crc32, inflateSync } from 'node:zlib';
import { BARE_GOODS_DISCLOSURE_ZH } from './business-thresholds.mjs';
import { validEvidenceDate } from './observations.mjs';
import { computeOrderPlan } from './fba-calculator.mjs';
import { toBigRat, addBigRat, mulBigRat, roundBigRat, ratCmp } from './fba-calculator.mjs';

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
const NON_PHONE_MACHINE_TOKEN_RE = /\b(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{96}|[0-9a-f]{128}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b|\bdata:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/gi;

const CHINESE_NON_FLOOR_LAYER_SUFFIX = '硬盒|纸箱|瓦楞|纸板|实木|木板|胶合|板|搁板|架|收纳|抽屉|托盘|隔板|漆|涂装|刀片|防护|过滤|海绵|泡棉|内衬|缓冲|包装|结构|工艺|材料|材质|卡|滑|裂|坏|松|紧|弯|断|薄|厚|高|低|宽|窄|深|浅|空|满|装|放|摆|叠';
const CHINESE_BUILDING_UNIT_RE = new RegExp(
  `(?:栋|幢|单元|室|号楼|楼层)\\s*[零一二三四五六七八九十百千\\d]+|[零一二三四五六七八九十百千\\d]+\\s*(?:栋|幢|单元|室|号楼)|(?<!第)[零一二三四五六七八九十百千\\d]+\\s*层(?!${CHINESE_NON_FLOOR_LAYER_SUFFIX})`,
);
const CHINESE_BUILDING_UNIT_GLOBAL_RE = new RegExp(CHINESE_BUILDING_UNIT_RE.source, 'g');

const PII_PATTERNS = [
  { name: 'cn_mobile_number', re: /(?<!\d)1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/, maskMachineTokens: true },
  { name: 'cn_landline_number', re: /(?<!\d)0\d{2,3}[\s-]\d{7,8}(?!\d)/, maskMachineTokens: true },
  { name: 'receiver_contact_label', re: /(收货人|收件人|联系人)\s*[:：]\s*[^\s,，;；]+/ },
  { name: 'detailed_street_address', re: new RegExp(`(?:路|大道|街|巷|弄)\\s*[零一二三四五六七八九十百千\\d]+\\s*号|${CHINESE_BUILDING_UNIT_RE.source}`) },
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

export function assertNonemptyString(value, label, { maxLength = 8192 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new RangeError(`${label} exceeds maximum length (${maxLength}).`);
  }
  return trimmed;
}

const RAW_EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const RAW_EMAIL_GLOBAL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const STRICT_EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DATA_IMAGE_URI_PREFIX_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i;

function scanRawEmailValue(value, re, skipDataImageUri, maxDepth, seen, depth) {
  if (value === null || value === undefined || depth > maxDepth) return false;
  if (typeof value === 'string') {
    if (skipDataImageUri && DATA_IMAGE_URI_PREFIX_RE.test(value)) return false;
    return re.test(value);
  }
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some(item => scanRawEmailValue(item, re, skipDataImageUri, maxDepth, seen, depth + 1));
  }
  for (const k of Object.keys(value)) {
    if (scanRawEmailValue(k, re, skipDataImageUri, maxDepth, seen, depth + 1) ||
      scanRawEmailValue(value[k], re, skipDataImageUri, maxDepth, seen, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function containsRawEmail(value, { strict = false, skipDataImageUri = true, maxDepth = 64 } = {}) {
  const re = strict ? STRICT_EMAIL_RE : RAW_EMAIL_RE;
  return scanRawEmailValue(value, re, skipDataImageUri, maxDepth, new Set(), 0);
}

function scrubRawEmailValue(value, maxDepth, seen, depth) {
  if (value === null || value === undefined || depth > maxDepth) return value;
  if (typeof value === 'string') {
    if (DATA_IMAGE_URI_PREFIX_RE.test(value)) return value;
    return value.replace(RAW_EMAIL_GLOBAL_RE, '[REDACTED_EMAIL]');
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map(item => scrubRawEmailValue(item, maxDepth, seen, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = scrubRawEmailValue(v, maxDepth, seen, depth + 1);
  }
  return out;
}

export function redactRawEmails(value, maxDepth = 64) {
  return scrubRawEmailValue(value, maxDepth, new Set(), 0);
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
  let phoneScrubbed = null;
  for (const { name, re, maskMachineTokens } of PII_PATTERNS) {
    const candidate = maskMachineTokens
      ? (phoneScrubbed ??= value.replace(NON_PHONE_MACHINE_TOKEN_RE, '_'))
      : value;
    if (re.test(candidate)) return name;
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
  const machineSpans = [];
  for (const m of out.matchAll(NON_PHONE_MACHINE_TOKEN_RE)) {
    machineSpans.push([m.index, m.index + m[0].length]);
  }
  out = out.replace(
    /(?<!\d)(?:1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}|0\d{2,3}[\s-]\d{7,8})(?!\d)/g,
    (match, offset) => (
      machineSpans.some(([start, end]) => offset >= start && offset + match.length <= end)
        ? match
        : '[REDACTED_PHONE]'
    ),
  );
  out = out.replace(
    /(?<![A-Za-z0-9.])(?:\+\d{1,3}[-.\s]?(?:\(\d{1,4}\)[-.\s]?)?(?:\d[-.\s]?){6,13}\d|\b(?:tel|telephone|phone|mobile|cell|fax)\s*[:=]?\s*\+?\d[\d\s().-]{6,18}\d)(?!(?:\.\d|[A-Za-z0-9]))/gi,
    '[REDACTED_PHONE]',
  );
  out = out.replace(/(收货人|收件人|联系人)\s*[:：]\s*[^\n\r,，;；"'}]+/g, '$1:[REDACTED_NAME]');
  out = out.replace(
    /(?:"(receiver_name|recipient_name|contact_name|registrant_name)"\s*:\s*"[^"]*"|\b(receiver_name|recipient_name|contact_name|registrant_name)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\n\r,，;；"'}]+))/gi,
    (_, qk, bk) => (qk ? `"${qk}":"[REDACTED_NAME]"` : `${bk}=[REDACTED_NAME]`),
  );
  out = out.replace(/(?:路|大道|街|巷|弄)\s*[零一二三四五六七八九十百千\d]+\s*号/g, '[REDACTED_STREET]');
  out = out.replace(CHINESE_BUILDING_UNIT_GLOBAL_RE, '[REDACTED_UNIT]');
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)*/gi, '[REDACTED_PATH]');
  out = out.replace(/(?:file:\/\/\/|(?<![A-Za-z0-9._-])\/|(?<![A-Za-z0-9._/-]))(?:Users|home)\/[^/\s"'<>]+(?:\/[^\s"'<>]*)*/gi, '[REDACTED_PATH]');
  out = out.replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|xox[bpas]-[A-Za-z0-9-]{6,}|pk_live_[A-Za-z0-9_-]{6,}|rk_live_[A-Za-z0-9_-]{6,}|ya29\.[A-Za-z0-9._-]{8,}|1\/\/[0-9A-Za-z_-]{12,}|oauth_[A-Za-z0-9._-]{8,}|AIza[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{6,})/g, '[REDACTED_TOKEN]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED_TOKEN]');
  out = out.replace(
    /(\\+)"(api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|id[_-]?token|secret[_-]?key|token|authorization|cookie|set-cookie|password)\1"\s*:\s*\1"[\s\S]*?\1"/gi,
    (_, bs, qk) => `${bs}"${qk}${bs}":${bs}"[REDACTED_SECRET]${bs}"`,
  );
  out = out.replace(
    /"(api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|id[_-]?token|secret[_-]?key|token|authorization|cookie|set-cookie|password)"\s*:\s*"(?:\\.|[^"\\])*"/gi,
    (_, qk) => `"${qk}":"[REDACTED_SECRET]"`,
  );
  out = out.replace(/\b((?:Proxy-)?Authorization)\s*:\s*(?!\[REDACTED_SECRET\])(?:Bearer|Basic|Digest|Token|AWS4-HMAC-SHA256)?\s*[^\r\n]+/gi, '$1: [REDACTED_SECRET]');
  out = out.replace(/\b(Set-Cookie|Cookie)\s*:\s*(?!\[REDACTED_SECRET\])[^\r\n]+/gi, '$1: [REDACTED_SECRET]');
  out = out.replace(/(?:__Host-|__Secure-)?[A-Za-z0-9_.-]*(?:session|session_id|sessionid|sid|phpsessid|jsessionid|connect\.sid|auth_token|csrf_token)[A-Za-z0-9_.-]*\s*=\s*[^\s,;"'}]+/gi, '[REDACTED_COOKIE]=[REDACTED_SECRET]');
  out = out.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|id[_-]?token|secret[_-]?key|token|authorization|cookie|password)\s*[:=]\s*(?!\[REDACTED_SECRET\])(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    (_, bk) => `${bk}=[REDACTED_SECRET]`,
  );
  out = out.replace(RAW_EMAIL_GLOBAL_RE, '[REDACTED_EMAIL]');
  return out;
}

const DEDICATED_RASTER_DATA_URI_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i;
const DEDICATED_RASTER_IMAGE_KEYS = new Set([
  'image_url',
  'image_urls',
  'image_data_uri',
  'image_data_uris',
  'contact_sheet_data_uri',
  'hero_image_data_uri',
  'sheet_data_uri',
  'screenshot_data_uri',
  'screenshot_data_uris',
]);
const SAFE_PNG_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'pHYs', 'sBIT', 'bKGD',
]);

function pngBytesPerPixelBits(colorType, bitDepth) {
  const validDepths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  }[colorType];
  if (!validDepths || !validDepths.includes(bitDepth)) return 0;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
  return channels * bitDepth;
}

function isDecodedValidPng(buf) {
  if (buf.length < 57) return false;
  if (
    buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
    buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a
  ) {
    return false;
  }
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;
  let width = 0;
  let height = 0;
  let bppBits = 0;
  let interlace = 0;
  const idatParts = [];
  while (offset < buf.length) {
    if (sawIend || offset + 12 > buf.length) return false;
    const len = buf.readUInt32BE(offset);
    if (len > 64 * 1024 * 1024 || offset + 12 + len > buf.length) return false;
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (!SAFE_PNG_CHUNKS.has(type)) return false;
    const expectedCrc = buf.readUInt32BE(offset + 8 + len);
    const actualCrc = crc32(buf.subarray(offset + 4, offset + 8 + len)) >>> 0;
    if (actualCrc !== expectedCrc) return false;
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (!sawIhdr) {
      if (type !== 'IHDR' || len !== 13) return false;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      interlace = data[12];
      bppBits = pngBytesPerPixelBits(colorType, bitDepth);
      if (
        width < 1 || height < 1 || width > 16384 || height > 16384 ||
        bppBits === 0 || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)
      ) {
        return false;
      }
      sawIhdr = true;
    } else if (type === 'IHDR') {
      return false;
    } else if (type === 'IDAT') {
      if (len === 0) return false;
      idatParts.push(data);
    } else if (type === 'IEND') {
      if (len !== 0) return false;
      sawIend = true;
    }
    offset += 12 + len;
  }
  if (!sawIhdr || !sawIend || idatParts.length === 0 || offset !== buf.length) return false;
  try {
    const rawPixels = inflateSync(Buffer.concat(idatParts), { maxOutputLength: 128 * 1024 * 1024 });
    if (interlace === 0) {
      const expectedBytes = height * (1 + Math.ceil((width * bppBits) / 8));
      return rawPixels.length === expectedBytes;
    }
    return rawPixels.length >= height;
  } catch {
    return false;
  }
}

function isDecodedValidJpeg(buf) {
  if (buf.length < 20 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    return false;
  }
  let offset = 2;
  let sawSof = false;
  let sawSos = false;
  while (offset < buf.length - 2) {
    if (buf[offset] !== 0xff) return false;
    while (offset < buf.length - 2 && buf[offset] === 0xff) offset++;
    const marker = buf[offset++];
    if (marker === 0xd9 || marker === 0x00) return false;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    // Reject comment (COM = 0xFE) and metadata APP1..APP15 (0xE1..0xEF) segments from secret-scan exemption; allow JFIF APP0 (0xE0).
    if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)) return false;
    if (offset + 2 > buf.length - 2) return false;
    const segLen = buf.readUInt16BE(offset);
    if (segLen < 2 || offset + segLen > buf.length - 2) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (segLen < 8) return false;
      const h = buf.readUInt16BE(offset + 3);
      const w = buf.readUInt16BE(offset + 5);
      if (w < 1 || h < 1) return false;
      sawSof = true;
    }
    offset += segLen;
    if (marker === 0xda) {
      sawSos = true;
      while (offset < buf.length - 2) {
        if (buf[offset] === 0xff) {
          const next = buf[offset + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
            offset += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        offset++;
      }
    }
  }
  return sawSof && sawSos && offset === buf.length - 2;
}

function isDecodedValidWebp(buf) {
  if (buf.length < 20) return false;
  if (
    buf.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buf.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    buf.readUInt32LE(4) + 8 !== buf.length
  ) {
    return false;
  }
  let offset = 12;
  let sawImageChunk = false;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) return false;
    const fourcc = buf.subarray(offset, offset + 4).toString('ascii');
    const sz = buf.readUInt32LE(offset + 4);
    const padded = sz + (sz % 2);
    if (offset + 8 + padded > buf.length) return false;
    if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
      if (sz < 5) return false;
      sawImageChunk = true;
    } else if (fourcc !== 'VP8X' && fourcc !== 'ALPH') {
      // Reject EXIF / XMP / arbitrary RIFF metadata chunks from secret-scan exemption.
      return false;
    }
    offset += 8 + padded;
  }
  return sawImageChunk && offset === buf.length;
}

function isVerifiedDedicatedRasterDataUri(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  const match = DEDICATED_RASTER_DATA_URI_RE.exec(trimmed);
  if (!match) return false;
  const [, rawSubtype, b64] = match;
  if (b64.length < 32 || b64.length % 4 !== 0) return false;
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('base64') !== b64) return false;
  const fmt = rawSubtype.toLowerCase();
  if (fmt === 'png') return isDecodedValidPng(buf);
  if (fmt === 'jpeg' || fmt === 'jpg') return isDecodedValidJpeg(buf);
  if (fmt === 'webp') return isDecodedValidWebp(buf);
  return false;
}

const SECRET_CASE_INSENSITIVE_RE = /\b(?:sk-[a-z0-9_-]{6,}|gh[pousr]_[a-z0-9_]{6,}|github_pat_[a-z0-9_]{6,}|xox[bpas]-[a-z0-9-]{6,}|pk_live_[a-z0-9_-]{6,}|rk_live_[a-z0-9_-]{6,}|ya29\.[a-z0-9._-]{8,}|1\/\/[0-9a-z_-]{12,}|oauth_[a-z0-9._-]{8,}|eyj[a-z0-9_-]{10,}\.[a-z0-9._-]{6,})|\bbearer\s+(?!\[redacted)[a-z0-9._~+/=-]{6,}|\b(?:proxy-)?authorization\s*:\s*(?:bearer|basic|digest|token)\s+(?!\[redacted)[a-z0-9._~+/=-]{6,}|\b(?:set-cookie|cookie)\s*:\s*(?!\[redacted)[^\r\n]{6,}|\b(?:session|session_id|sessionid|connect\.sid|phpsessid|jsessionid|auth_token|csrf_token)\s*=\s*(?!\[redacted)[a-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?token|client[_-]?secret|id[_-]?token|secret[_-]?key|password|cookie)\b(?:\\*["'])?\s*[:=]\s*(?:\\*["'])?(?!\[redacted)[a-z0-9._~+/=-]{8,}/i;
const SECRET_CASE_EXACT_RE = /\b(?:(?:AKIA|ASIA)[0-9A-Z]{10,}|AIza[0-9A-Za-z_-]{10,})/;
const SENSITIVE_SECRET_KEYS = new Set([
  'api_key', 'apikey', 'access_token', 'refresh_token', 'oauth_token', 'client_secret', 'id_token', 'secret_key', 'authorization', 'cookie', 'password',
]);

function matchesSecretText(text) {
  return SECRET_CASE_INSENSITIVE_RE.test(text) || SECRET_CASE_EXACT_RE.test(text);
}

export function containsSecretToken(value, seen = new Set(), depth = 0, inDedicatedImageField = false) {
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === 'string') {
    if (inDedicatedImageField && isVerifiedDedicatedRasterDataUri(value)) {
      return false;
    }
    const s = value.trim();
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
      try {
        return containsSecretToken(JSON.parse(s), seen, depth + 1, false);
      } catch { /* fall through to line/plain-text scan on invalid or multi-line JSON */ }
    }
    if (s.includes('\n')) {
      for (const rawLine of s.split(/\r?\n/)) {
        const ln = rawLine.trim();
        if (!ln) continue;
        if ((ln.startsWith('{') && ln.endsWith('}')) || (ln.startsWith('[') && ln.endsWith(']'))) {
          try {
            if (containsSecretToken(JSON.parse(ln), seen, depth + 1, false)) return true;
            continue;
          } catch { /* fall through */ }
        }
        if (matchesSecretText(ln)) return true;
      }
    }
    return matchesSecretText(value);
  }
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some(item => containsSecretToken(item, seen, depth + 1, inDedicatedImageField));
  }
  for (const [k, v] of Object.entries(value)) {
    const kl = k.toLowerCase();
    if (SENSITIVE_SECRET_KEYS.has(kl) && v !== null && v !== undefined && String(v).trim() !== '') {
      return true;
    }
    const isImageKey = DEDICATED_RASTER_IMAGE_KEYS.has(kl);
    if (containsSecretToken(v, seen, depth + 1, isImageKey)) return true;
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
  const trimmed = dest.trim();
  if (!trimmed) return false;

  const ORIGIN_MARKER_RE = /(?:发货地|始发地|产地|发自|发出地|发货|origin|\bfrom\b)/i;
  const DEST_MARKER_RE = /(?:收货地|收货|目的地|送至|发往|寄往|配送至|destination|\bto\b)\s*[:：]?\s*/i;

  // 1) Explicit destination marker: allow province+city commas (e.g. "收货地：广东省，深圳市" or "To: Guangdong, Shenzhen")
  //    while stopping at semicolons, newlines, or an origin marker.
  const destMatch = trimmed.match(new RegExp(`${DEST_MARKER_RE.source}([^;；\\n]+)`, 'i'));
  if (destMatch) {
    let destSegment = destMatch[1].split(ORIGIN_MARKER_RE)[0].trim();
    // Strip trailing comma left before an origin marker like "To: Shanghai, From: Shenzhen"
    destSegment = destSegment.replace(/[,，\s]+$/, '');
    return /深圳|shenzhen/i.test(destSegment);
  }

  // 2) Explicit arrow / directional separator (origin -> destination, or "从X发Y" / "X发货，Y").
  const arrowParts = trimmed.split(/(?:->|=>|→|至)/);
  if (arrowParts.length >= 2) {
    const tail = arrowParts[arrowParts.length - 1].split(ORIGIN_MARKER_RE)[0].trim();
    return /深圳|shenzhen/i.test(tail);
  }
  const congFaMatch = trimmed.match(/^从\s*([^发]+?)发\s*(.+)$/);
  if (congFaMatch) {
    return /深圳|shenzhen/i.test(congFaMatch[2]);
  }

  // 3) Origin marker without explicit destination marker:
  //    - "发货地：深圳" / "From: Guangdong Shenzhen" -> false (origin-only)
  //    - "上海 发货地：深圳" -> evaluate only prefix before origin marker (false)
  //    - "广东深圳发货，上海" -> origin precedes "发货"; only text after delimiter could be destination (false unless Shenzhen!)
  const originMatch = trimmed.match(ORIGIN_MARKER_RE);
  if (originMatch) {
    const matchedToken = originMatch[0];
    if (matchedToken === '发货') {
      const afterShip = trimmed.slice(originMatch.index + matchedToken.length).replace(/^[\s:：,，;；]+/, '').trim();
      if (!afterShip) return false;
      return /深圳|shenzhen/i.test(afterShip);
    }
    const beforeOrigin = trimmed.slice(0, originMatch.index).trim();
    if (!beforeOrigin) return false;
    return /深圳|shenzhen/i.test(beforeOrigin);
  }

  // 4) Plain destination-only province/city string (e.g. "广东深圳", "Guangdong, Shenzhen")
  if (/发$/.test(trimmed)) return false;
  return /深圳|shenzhen/i.test(trimmed);
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

  const hasDomesticFreight = output.domestic_freight_cny_total !== undefined && output.domestic_freight_cny_total !== null;
  const hasAdvisoryDomesticFreight = output.domestic_freight_advisory_cny_total !== undefined && output.domestic_freight_advisory_cny_total !== null;
  if (hasAdvisoryDomesticFreight && (!finite(output.domestic_freight_advisory_cny_total) || output.domestic_freight_advisory_cny_total < 0)) {
    throw new TypeError('domestic_freight_advisory_cny_total must be a nonnegative finite number or null.');
  }
  const isBareGoodsQuote = output.pricing_basis === 'bare_goods_1688' ||
    output.bare_goods_screening === true ||
    !hasDomesticFreight;
  const goodsPromo = assertBoolean(output.goods_first_order_promotion, 'goods_first_order_promotion');
  const freightPromo = (isBareGoodsQuote && (output.freight_first_order_promotion === undefined || output.freight_first_order_promotion === null))
    ? false
    : assertBoolean(output.freight_first_order_promotion, 'freight_first_order_promotion');
  const isStage1Initial = output.stage === 'stage1_initial' || output.allow_default_pack_multiple === true;

  if (output.status === 'verified') {
    if (!isBareGoodsQuote && output.includes_platform_subsidy_in_freight === true) {
      throw new TypeError('Verified regular 1688 quote cannot deduct temporary platform_subsidy (可再减) from domestic_freight_cny_total; record full regular Shenzhen freight.');
    }
    const requiresUiReadback = output.require_ui_readback === true || isStage1Initial;
    if (requiresUiReadback && (output.ui_readback === undefined || output.ui_readback === null)) {
      throw new TypeError('Verified Stage-1 / Revision-59 1688 quote requires a populated ui_readback object.');
    }
    if (output.ui_readback !== undefined && output.ui_readback !== null) {
      const ui = assertObject(output.ui_readback, 'ui_readback');
      if (ui.logged_in !== true) {
        throw new TypeError('Verified 1688 quote requires ui_readback.logged_in === true (logged-out or empty 1688 readbacks cannot establish verified repeat-order quotes).');
      }
      if (ui.selected_sku_row_visible !== true) {
        throw new TypeError('Verified 1688 quote requires ui_readback.selected_sku_row_visible === true so the selected SKU row matches the saleable set.');
      }
      if (ui.settlement_bar_visible !== true) {
        throw new TypeError('Verified 1688 quote requires ui_readback.settlement_bar_visible === true (wide >=1440px viewport without cropped Shenzhen freight bar).');
      }
      if (!finite(ui.viewport_width_px) || ui.viewport_width_px < 1440) {
        throw new TypeError('Verified 1688 quote requires ui_readback.viewport_width_px >= 1440 so the right-side Shenzhen freight bar is uncropped.');
      }
      if (ui.applied_quantity_confirmed === false || ui.applied_qty_confirmed === false ||
        (requiresUiReadback && ui.applied_quantity_confirmed !== true && ui.applied_qty_confirmed !== true)) {
        throw new TypeError('Verified 1688 quote requires applied_quantity_confirmed === true after quantity field blur.');
      }
    }
  }

  let cartonPackUnverifiedStage1 = false;
  const normalizedInputSkuLines = Array.isArray(output.sku_lines)
    ? output.sku_lines.map(line => {
      if (isStage1Initial && line && typeof line === 'object' && (line.pack_multiple === undefined || line.pack_multiple === null)) {
        cartonPackUnverifiedStage1 = true;
        return { ...line, pack_multiple: 1, pack_multiple_unverified_stage1: true };
      }
      return line;
    })
    : output.sku_lines;

  if (output.status === 'unknown') {
    // Pending/unknown quotes may omit goods_cny_total or domestic_freight_cny_total while keeping strict validation if supplied.
    if (output.goods_cny_total !== undefined && output.goods_cny_total !== null && (!finite(output.goods_cny_total) || output.goods_cny_total <= 0)) {
      throw new TypeError('goods_cny_total must be a positive finite number or null when pending.');
    }
    if (output.domestic_freight_cny_total !== undefined && output.domestic_freight_cny_total !== null && (!finite(output.domestic_freight_cny_total) || output.domestic_freight_cny_total < 0)) {
      throw new TypeError('domestic_freight_cny_total must be a nonnegative finite number or null when pending.');
    }
    let pendingPlan = null;
    if (Array.isArray(normalizedInputSkuLines) && normalizedInputSkuLines.length > 0) {
      pendingPlan = computeOrderPlan({
        sku_lines: normalizedInputSkuLines,
        allow_remainder: Boolean(output.allow_remainder ?? false),
        target_sets: output.target_sets ?? 100,
        lcm_cap: output.lcm_cap,
        profile_revision: output.profile_revision ?? 59,
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
      ...(cartonPackUnverifiedStage1 ? {
        carton_pack_unverified_stage1: true,
        stage2_sample_check_tag: '整箱装箱率待向客服核实',
      } : {}),
    };
  }

  if (!Array.isArray(normalizedInputSkuLines) || normalizedInputSkuLines.length === 0) {
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
      const matched = normalizedInputSkuLines.filter(l => (l.component_id ?? l.sku_id) === compId);
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
    sku_lines: normalizedInputSkuLines,
    allow_remainder: allowRemainder,
    target_sets: targetSets,
    lcm_cap: output.lcm_cap,
    profile_revision: output.profile_revision ?? 59,
  });
  if (cartonPackUnverifiedStage1) {
    orderPlan.carton_pack_unverified_stage1 = true;
    orderPlan.carton_verification_tag = '整箱装箱率待向客服核实';
  }

  if (output.actual_sets !== undefined && output.actual_sets !== orderPlan.allocated_sets) {
    throw new TypeError(`Declared actual_sets (${output.actual_sets}) does not match computed carton/MOQ plan (${orderPlan.allocated_sets}).`);
  }
  if (output.actual_complete_sets !== undefined && output.actual_complete_sets !== orderPlan.actual_complete_sets) {
    throw new TypeError(`Declared actual_complete_sets (${output.actual_complete_sets}) does not match computed complete sets (${orderPlan.actual_complete_sets}).`);
  }

  let exactGoodsCny = toBigRat(0);
  for (let i = 0; i < normalizedInputSkuLines.length; i++) {
    const line = normalizedInputSkuLines[i];
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
  if (hasDomesticFreight && (!finite(output.domestic_freight_cny_total) || output.domestic_freight_cny_total < 0)) {
    throw new TypeError('domestic_freight_cny_total must be a nonnegative finite number or null.');
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
    if (goodsPromo !== false || (!isBareGoodsQuote && freightPromo !== false)) {
      throw new TypeError('Verified regular 1688 quote requires goods_first_order_promotion: false (and freight_first_order_promotion: false for explicit landed-freight quotes).');
    }
    if (orderPlan.allocated_sets < 100 || orderPlan.actual_complete_sets < 100) {
      throw new TypeError('Verified quote must cover at least 100 complete saleable sets.');
    }
  }

  return {
    valid: true,
    contract: 'SourcingVerifier1688',
    status: output.status,
    pricing_basis: isBareGoodsQuote ? 'bare_goods_1688' : 'landed_domestic_explicit',
    ...(isBareGoodsQuote ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
    domestic_freight_advisory_cny_total: isBareGoodsQuote
      ? (hasAdvisoryDomesticFreight ? output.domestic_freight_advisory_cny_total : (hasDomesticFreight ? output.domestic_freight_cny_total : null))
      : null,
    redacted_destination: redactedDestination,
    sensitive_freebie_flags: normalizedFlags,
    order_plan: orderPlan,
    normalized_sku_lines: normalizedInputSkuLines,
    exact_goods_cny_total: roundBigRat(exactGoodsCny.n, exactGoodsCny.d, 4),
    goods_first_order_promotion: goodsPromo,
    freight_first_order_promotion: freightPromo,
    ...(cartonPackUnverifiedStage1 ? {
      carton_pack_unverified_stage1: true,
      stage2_sample_check_tag: '整箱装箱率待向客服核实',
    } : {}),
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
