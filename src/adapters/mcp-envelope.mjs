/**
 * Shared MCP envelope unwrapping & upstream error/empty-receipt guards across SellerSprite, SIF, and SP-API.
 */
export function hasUpstreamErrorMarkers(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.isError === true) return true;
  if (obj.error !== undefined && obj.error !== null && obj.error !== false && obj.error !== '') return true;
  if (Array.isArray(obj.errors) && obj.errors.length > 0) return true;
  if (obj.status === 'failed' || obj.status === 'error') return true;
  if (obj.code !== undefined && obj.code !== null && !['OK', '0', 0, 200].includes(obj.code)) {
    return true;
  }
  return false;
}

export function isPayloadUpstreamFailure(rawPayload, depth = 0, seen = new Set()) {
  if (!rawPayload || typeof rawPayload !== 'object' || depth > 5 || seen.has(rawPayload)) return false;
  seen.add(rawPayload);
  if (hasUpstreamErrorMarkers(rawPayload)) return true;
  for (const key of ['structuredContent', 'data', 'result', 'response', 'payload']) {
    const child = rawPayload[key];
    if (child && typeof child === 'object' && isPayloadUpstreamFailure(child, depth + 1, seen)) {
      return true;
    }
  }
  if (Array.isArray(rawPayload.content)) {
    for (const block of rawPayload.content) {
      if (block?.isError === true) return true;
      if (typeof block?.text === 'string') {
        const s = block.text.trim();
        if (s.startsWith('{') && s.endsWith('}')) {
          try {
            const parsed = JSON.parse(s);
            if (isPayloadUpstreamFailure(parsed, depth + 1, seen)) return true;
          } catch { /* ignore */ }
        }
      }
    }
  }
  return false;
}

export function hasEnvelopeFailureMarkers(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (hasUpstreamErrorMarkers(obj)) return true;
  if (obj.dataStatus === 'NO_DATA') return true;
  return false;
}

export function isFailedOrEmptyRawReceipt(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return true;
  if (isPayloadUpstreamFailure(rawPayload)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload.structuredContent)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload.structuredContent?.data)) return true;
  if (hasEnvelopeFailureMarkers(rawPayload.data)) return true;
  return false;
}

export function unwrapMcpEnvelope(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return rawPayload;
  if (isFailedOrEmptyRawReceipt(rawPayload)) return null;
  if (rawPayload.structuredContent?.data !== undefined) return rawPayload.structuredContent.data;
  if (rawPayload.data !== undefined && typeof rawPayload.data === 'object') return rawPayload.data;
  if (Array.isArray(rawPayload.content)) {
    for (const block of rawPayload.content) {
      if (typeof block?.text === 'string') {
        const s = block.text.trim();
        if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
          try {
            const parsed = JSON.parse(s);
            if (hasEnvelopeFailureMarkers(parsed)) return null;
            if (parsed?.data !== undefined && typeof parsed.data === 'object') {
              return hasEnvelopeFailureMarkers(parsed.data) ? null : parsed.data;
            }
            return parsed;
          } catch { /* ignore */ }
        }
      }
    }
  }
  return rawPayload;
}

export function isFailedUnwrappedBody(unwrapped) {
  if (!unwrapped || typeof unwrapped !== 'object') return true;
  if (Array.isArray(unwrapped)) return unwrapped.length === 0;
  if (hasEnvelopeFailureMarkers(unwrapped)) return true;
  return false;
}

