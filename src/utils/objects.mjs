/**
 * Shared plain-object, deep-freeze, canonical JSON, PII-safe UUID, and SHA-256 helpers.
 */
import { createHash, randomUUID } from 'node:crypto';

export const finite = v => typeof v === 'number' && Number.isFinite(v);
export const nonemptyStr = v => typeof v === 'string' && v.trim().length > 0;

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function assertPlainObject(value, label, ErrorClass = TypeError) {
  if (!isPlainObject(value)) {
    throw new ErrorClass(`${label} must be a plain object.`);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new ErrorClass(`${label} contains forbidden key "${key}".`);
    }
  }
  return value;
}

export function generatePiiSafeUuid() {
  return randomUUID();
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

export function canonicalJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter(k => value[k] !== undefined)
    .sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function sha256Hex(input) {
  const bytes = (Buffer.isBuffer(input) || ArrayBuffer.isView(input))
    ? input
    : (input instanceof ArrayBuffer ? new Uint8Array(input) : Buffer.from(String(input), 'utf8'));
  return createHash('sha256').update(bytes).digest('hex');
}
