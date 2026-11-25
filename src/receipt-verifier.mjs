/**
 * Standalone cryptographic receipt verifier for Gate-4 Codex CLI evidence reviews.
 * Extracted from `src/openai/codex-runner.mjs` so `src/report.mjs` and `src/pipeline.mjs`
 * verify receipts without depending on the subprocess runner (`src/report.mjs -x-> src/openai/codex-runner.mjs`).
 */
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EVIDENCE_REVIEW_JSON_SCHEMA } from './openai/evidence-review.mjs';
import { canonicalJson, isPlainObject, sha256Hex } from './utils/objects.mjs';
import { validateJsonAgainstStrictSchema } from './utils/json-schema.mjs';

const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_RECEIPT_FILE_BYTES = 16 * 1024 * 1024;
export const ALLOWED_GATE4_EFFORTS = Object.freeze(['xhigh', 'max']);

const DEFAULT_TEST_RECEIPT_STORE_DIR = join(
  tmpdir(),
  `codex-test-receipt-store-${process.pid}-${randomUUID()}`,
);
let registeredTestStoreCleanup = false;

export function getDefaultTestReceiptStoreDir() {
  if (!registeredTestStoreCleanup) {
    registeredTestStoreCleanup = true;
    process.once('exit', () => {
      try {
        rmSync(DEFAULT_TEST_RECEIPT_STORE_DIR, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of process-scoped synthetic test receipt store.
      }
    });
  }
  return DEFAULT_TEST_RECEIPT_STORE_DIR;
}

export function formatReviewerLabel(model, effort, executionProvenance = 'live_subscription_codex') {
  const effDisp = effort || 'inherited';
  if (executionProvenance === 'synthetic_test_double') {
    return `Synthetic Test Double · ${effDisp}`;
  }
  const rawModel = String(model || '').trim();
  const m = rawModel.toLowerCase();
  const displayModel = !rawModel ? 'Codex CLI' : (m === 'gpt-6.2-astra' ? 'GPT-6.2 Astra' : rawModel);
  return `${displayModel} · ${effDisp}`;
}

export function verifySavedCodexReceipt(envelope, {
  receiptStoreDir = null,
  allowTestDouble = false,
  expectedCandidateId = null,
  expectedFormSpecSha256 = null,
  allowStaleSpec = false,
  expectedPacketSha256 = null,
  expectedAttachmentSha256s = null,
} = {}) {
  try {
    if (typeof allowTestDouble !== 'boolean') {
      return Object.freeze({ verified: false, reason: 'allowTestDouble must be a boolean.' });
    }
    if (!isPlainObject(envelope)) {
      return Object.freeze({ verified: false, reason: 'Review envelope must be a plain object.' });
    }
    const expectedReceiptSha = typeof envelope.receipt_sha256 === 'string' ? envelope.receipt_sha256.trim() : '';
    if (!HEX_SHA256_RE.test(expectedReceiptSha)) {
      return Object.freeze({ verified: false, reason: 'Missing or invalid envelope.receipt_sha256.' });
    }
    if (
      envelope.private_receipt_ref !== undefined &&
      envelope.private_receipt_ref !== null &&
      envelope.private_receipt_ref !== `codex-receipt:${expectedReceiptSha}`
    ) {
      return Object.freeze({ verified: false, reason: 'envelope.private_receipt_ref does not match receipt_sha256.' });
    }

    const candidateDirs = [];
    if (receiptStoreDir !== null && receiptStoreDir !== undefined) {
      if (typeof receiptStoreDir !== 'string' || !receiptStoreDir.trim() || /[\0\r\n]/.test(receiptStoreDir)) {
        return Object.freeze({ verified: false, reason: 'Invalid receiptStoreDir option.' });
      }
      candidateDirs.push(resolve(receiptStoreDir.trim()));
    } else {
      candidateDirs.push(resolve(process.cwd(), '.local', 'receipts', 'codex-evidence-review'));
      if (allowTestDouble === true) {
        candidateDirs.push(getDefaultTestReceiptStoreDir());
      }
    }

    let receiptBytes = null;
    for (const dir of candidateDirs) {
      const candidateFile = join(dir, `receipt-${expectedReceiptSha}.json`);
      let lst = null;
      try {
        lst = lstatSync(candidateFile);
      } catch {
        lst = null;
      }
      if (!lst || lst.isSymbolicLink() || !lst.isFile() || lst.size <= 0 || lst.size > MAX_RECEIPT_FILE_BYTES) {
        continue;
      }
      receiptBytes = readFileSync(candidateFile);
      break;
    }

    if (!receiptBytes) {
      return Object.freeze({ verified: false, reason: 'Saved Codex execution receipt file was not found in receipt store.' });
    }
    if (sha256Hex(receiptBytes) !== expectedReceiptSha) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt file SHA-256 does not match envelope.receipt_sha256.' });
    }

    const rec = JSON.parse(receiptBytes.toString('utf8'));
    if (!isPlainObject(rec) || rec.kind !== 'codex_exec_receipt') {
      return Object.freeze({ verified: false, reason: 'Saved receipt JSON is not a valid codex_exec_receipt object.' });
    }
    if (rec.status !== 'completed' || rec.error_code !== null || rec.validation_error !== null || rec.termination_uncertain !== false) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt does not record a clean completed validation.' });
    }
    if (typeof rec.raw_output_sha256 !== 'string' || !HEX_SHA256_RE.test(rec.raw_output_sha256)) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt lacks a valid raw_output_sha256.' });
    }
    if (envelope.raw_output_sha256 !== undefined && envelope.raw_output_sha256 !== rec.raw_output_sha256) {
      return Object.freeze({ verified: false, reason: 'Envelope raw_output_sha256 does not match saved receipt.' });
    }
    if (typeof rec.raw_output_original_base64 !== 'string' || rec.raw_output_original_base64.length === 0) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt lacks raw_output_original_base64.' });
    }

    const decodedRawBytes = Buffer.from(rec.raw_output_original_base64, 'base64');
    if (decodedRawBytes.length === 0 || decodedRawBytes.toString('base64') !== rec.raw_output_original_base64) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt raw_output_original_base64 is corrupt.' });
    }
    if (sha256Hex(decodedRawBytes) !== rec.raw_output_sha256) {
      return Object.freeze({ verified: false, reason: 'Decoded raw_output_original_base64 SHA-256 does not match raw_output_sha256.' });
    }

    const parsedRawReview = JSON.parse(decodedRawBytes.toString('utf8').trim());
    validateJsonAgainstStrictSchema(parsedRawReview, EVIDENCE_REVIEW_JSON_SCHEMA, '$');

    if (typeof envelope.review_id !== 'string' || rec.review_id !== envelope.review_id || parsedRawReview.review_id !== rec.review_id) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt review_id does not match envelope.' });
    }
    if (typeof envelope.packet_sha256 !== 'string' || rec.packet_sha256 !== envelope.packet_sha256 || parsedRawReview.packet_sha256 !== rec.packet_sha256) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt packet_sha256 does not match envelope.' });
    }
    if (expectedPacketSha256 !== null && expectedPacketSha256 !== undefined && rec.packet_sha256 !== String(expectedPacketSha256).trim()) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt packet_sha256 does not match expectedPacketSha256.' });
    }

    const envAtts = Array.isArray(envelope.attachment_sha256s) ? envelope.attachment_sha256s : [];
    if (
      !Array.isArray(rec.attachment_sha256s) ||
      rec.attachment_sha256s.length !== envAtts.length ||
      rec.attachment_sha256s.some((sha, idx) => sha !== envAtts[idx])
    ) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt attachment_sha256s does not match envelope.' });
    }
    if (Array.isArray(expectedAttachmentSha256s)) {
      if (
        rec.attachment_sha256s.length !== expectedAttachmentSha256s.length ||
        rec.attachment_sha256s.some((sha, idx) => sha !== expectedAttachmentSha256s[idx])
      ) {
        return Object.freeze({ verified: false, reason: 'Saved Codex receipt attachment_sha256s does not match expectedAttachmentSha256s.' });
      }
    }

    if (typeof rec.bound_candidate_id === 'string' && rec.bound_candidate_id.trim()) {
      const boundCand = rec.bound_candidate_id.trim();
      if (typeof envelope.candidate_id === 'string' && envelope.candidate_id.trim() && envelope.candidate_id.trim() !== boundCand) {
        return Object.freeze({ verified: false, reason: 'Envelope candidate_id does not match receipt bound_candidate_id.' });
      }
      if (typeof expectedCandidateId === 'string' && expectedCandidateId.trim() && expectedCandidateId.trim() !== boundCand) {
        return Object.freeze({ verified: false, reason: 'Receipt bound_candidate_id does not match expectedCandidateId.' });
      }
    } else if (typeof expectedCandidateId === 'string' && expectedCandidateId.trim()) {
      const wantCand = expectedCandidateId.trim();
      const envCand = typeof envelope.candidate_id === 'string' && envelope.candidate_id.trim() ? envelope.candidate_id.trim() : null;
      const subjCand = typeof rec.candidate_subject_id === 'string' && rec.candidate_subject_id.trim() ? rec.candidate_subject_id.trim() : null;
      if ((envCand && envCand !== wantCand) || (!envCand && subjCand && subjCand !== wantCand)) {
        return Object.freeze({ verified: false, reason: 'Candidate identity does not match expectedCandidateId.' });
      }
    }

    let staleSpec = false;
    let actualReviewedSpec = null;
    if (typeof rec.bound_form_spec_sha256 === 'string' && rec.bound_form_spec_sha256.trim()) {
      const boundSpec = rec.bound_form_spec_sha256.trim();
      actualReviewedSpec = boundSpec;
      if (typeof envelope.form_spec_sha256 === 'string' && envelope.form_spec_sha256.trim() && envelope.form_spec_sha256.trim() !== boundSpec) {
        return Object.freeze({ verified: false, reason: 'Envelope form_spec_sha256 does not match receipt bound_form_spec_sha256.' });
      }
      if (typeof expectedFormSpecSha256 === 'string' && expectedFormSpecSha256.trim() && expectedFormSpecSha256.trim() !== boundSpec) {
        if (allowStaleSpec === true && HEX_SHA256_RE.test(boundSpec)) {
          staleSpec = true;
        } else {
          return Object.freeze({ verified: false, reason: 'Receipt bound_form_spec_sha256 does not match expectedFormSpecSha256.' });
        }
      }
    } else if (typeof expectedFormSpecSha256 === 'string' && expectedFormSpecSha256.trim()) {
      const wantSpec = expectedFormSpecSha256.trim();
      const envSpec = typeof envelope.form_spec_sha256 === 'string' && envelope.form_spec_sha256.trim() ? envelope.form_spec_sha256.trim() : null;
      actualReviewedSpec = envSpec;
      if (envSpec && envSpec !== wantSpec) {
        if (allowStaleSpec === true && HEX_SHA256_RE.test(envSpec)) {
          staleSpec = true;
        } else {
          return Object.freeze({ verified: false, reason: 'Envelope form_spec_sha256 does not match expectedFormSpecSha256.' });
        }
      }
    } else if (typeof envelope.form_spec_sha256 === 'string' && envelope.form_spec_sha256.trim()) {
      actualReviewedSpec = envelope.form_spec_sha256.trim();
    }

    if (!isPlainObject(envelope.review) || canonicalJson(parsedRawReview) !== canonicalJson(envelope.review)) {
      return Object.freeze({ verified: false, reason: 'Envelope review body is missing or differs from verified receipt original output.' });
    }

    const resolvedRecModel = rec.model === null
      ? null
      : (typeof rec.model === 'string' ? rec.model.trim() : '');
    if (
      (resolvedRecModel !== null && !SAFE_MODEL_ID_RE.test(resolvedRecModel)) ||
      (envelope.model !== undefined && (
        resolvedRecModel === null
          ? envelope.model !== null
          : (envelope.model === null || String(envelope.model).trim() !== resolvedRecModel)
      ))
    ) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt lacks a valid matching model identifier.' });
    }
    const resolvedRecEffort = rec.reasoning_effort === null || rec.reasoning_effort === 'default'
      ? null
      : rec.reasoning_effort;
    const envEffortNorm = envelope.reasoning_effort === undefined
      ? undefined
      : (envelope.reasoning_effort === null || envelope.reasoning_effort === 'default' ? null : envelope.reasoning_effort);
    if (
      (resolvedRecEffort !== null && !ALLOWED_GATE4_EFFORTS.includes(resolvedRecEffort)) ||
      (envEffortNorm !== undefined && envEffortNorm !== resolvedRecEffort)
    ) {
      return Object.freeze({ verified: false, reason: 'Saved Codex receipt reasoning_effort must be xhigh, max, or null (inherited config).' });
    }

    const prov = rec.execution_provenance;
    if (envelope.execution_provenance !== undefined && envelope.execution_provenance !== prov) {
      return Object.freeze({ verified: false, reason: 'Envelope execution_provenance does not match saved receipt.' });
    }
    const provenanceAllowed =
      prov === 'live_subscription_codex' ||
      (allowTestDouble === true && prov === 'synthetic_test_double');
    if (!provenanceAllowed) {
      return Object.freeze({
        verified: false,
        reason: prov === 'synthetic_test_double'
          ? 'Receipt provenance is synthetic_test_double, which is rejected when allowTestDouble=false.'
          : `Unrecognized receipt execution_provenance "${String(prov)}".`,
      });
    }

    const reviewerLabel = formatReviewerLabel(resolvedRecModel, resolvedRecEffort, prov);

    return Object.freeze({
      verified: true,
      stale_spec: staleSpec,
      reviewed_at: typeof rec.recorded_at === 'string' && rec.recorded_at.trim() ? rec.recorded_at.trim() : null,
      reviewed_spec_sha256: actualReviewedSpec,
      receipt_sha256: expectedReceiptSha,
      execution_provenance: prov,
      model: resolvedRecModel,
      reasoning_effort: resolvedRecEffort,
      reviewer_label: reviewerLabel,
      review_id: rec.review_id,
      packet_sha256: rec.packet_sha256,
      candidate_subject_id: rec.candidate_subject_id ?? null,
      candidate_spec_sha256: rec.candidate_spec_sha256 ?? null,
      bound_candidate_id: rec.bound_candidate_id ?? null,
      bound_form_spec_sha256: rec.bound_form_spec_sha256 ?? null,
      attachment_sha256s: [...rec.attachment_sha256s],
      raw_review: parsedRawReview,
    });
  } catch (err) {
    return Object.freeze({
      verified: false,
      reason: `Receipt verification failed: ${err?.message ?? String(err)}`,
    });
  }
}
