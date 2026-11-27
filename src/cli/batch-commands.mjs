/**
 * Surgically extracted Batch API (`openai-batch-build`, `openai-batch-poll`) and
 * daily workflow batch (`daily-batch`, `single-product`, `single-dive`, `reverse-1688`)
 * command handlers for `src/phase2-cli.mjs`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BARE_GOODS_DISCLOSURE_ZH, CALCULATOR_1688_FLOOR_PRICE_NAME_ZH } from '../business-thresholds.mjs';
import { canonicalJson, sha256Hex } from '../store.mjs';
import {
  computeHeadhaulWithA4Rules,
  computeOrderPlan,
  isStructuredHeadhaulSpec,
  solveMinPriceForMargin2027,
} from '../fba-calculator.mjs';
import { replayBatchIntoStore } from '../history-import.mjs';
import {
  applyPeerComparabilityRulings,
  attachGate1APriceCliffStress,
  buildAutoEarlyScreenScenariosFromGate1A,
  runPhase2Batch,
} from '../pipeline.mjs';
import {
  auditDiscoveryCoverage,
  planDiscoveryBatch,
} from '../discovery-channels.mjs';
import { attachStoreDiscoveryProvenance } from '../discovery.mjs';
import { scoreBatch } from '../scoring.mjs';
import { renderReport } from '../report.mjs';
import { ingestTrialSpecification } from '../raw-ingest.mjs';
import {
  WORKFLOW_RESPONSES_TASKS,
  buildBatchJsonl,
  buildWorkflowTaskRequest,
  parseBatchInputJsonl,
} from '../openai/index.mjs';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_R59_PROFILE_PATH = resolve(CLI_DIR, '..', '..', 'docs', 'design', 'reference-profile.r59.draft.json');

function summarizeBatchPollOutput(polled, {
  mode = 'polled',
  batchId,
  attemptId = null,
  receipt = null,
  downloadRequested = false,
  extra = {},
} = {}) {
  const parsedOutput = polled?.parsed_output ?? null;
  const parsedError = polled?.parsed_error ?? null;
  const reconciliation = polled?.reconciliation ?? null;
  const parsedOutputCount = parsedOutput
    ? (Number.isSafeInteger(parsedOutput.total_lines)
      ? parsedOutput.total_lines
      : (Array.isArray(parsedOutput.results) ? parsedOutput.results.length : 0))
    : (downloadRequested ? 0 : undefined);
  const parsedErrorCount = parsedError
    ? (Number.isSafeInteger(parsedError.total_lines)
      ? parsedError.total_lines
      : (Array.isArray(parsedError.results) ? parsedError.results.length : 0))
    : (downloadRequested ? 0 : undefined);
  const inputFileId = polled?.batch?.input_file_id ?? null;

  const batchErrors = Array.isArray(polled?.batch_errors) && polled.batch_errors.length > 0
    ? polled.batch_errors
    : (Array.isArray(polled?.batch?.errors?.data) && polled.batch.errors.data.length > 0 ? polled.batch.errors.data : null);

  return {
    mode,
    batch_id: polled?.batch_id ?? batchId ?? null,
    batch_status: polled?.batch_status ?? polled?.status ?? null,
    already_settled: polled?.already_settled === true,
    fenced: polled?.fenced === true,
    ...(attemptId ? { attempt_id: attemptId } : {}),
    ...(inputFileId ? { input_file_id: inputFileId, file_id: inputFileId } : {}),
    ...(polled?.output_file_id !== undefined ? { output_file_id: polled.output_file_id } : {}),
    ...(polled?.error_file_id !== undefined ? { error_file_id: polled.error_file_id } : {}),
    ...(batchErrors ? { batch_errors: batchErrors } : {}),
    ...(polled?.output_file_error ? { output_file_error: polled.output_file_error } : {}),
    ...(polled?.error_file_error ? { error_file_error: polled.error_file_error } : {}),
    ...(parsedOutputCount !== undefined ? { parsed_output_count: parsedOutputCount } : {}),
    ...(parsedErrorCount !== undefined ? { parsed_error_count: parsedErrorCount } : {}),
    ...(parsedOutput ? { parsed_output: parsedOutput } : {}),
    ...(parsedError ? { parsed_error: parsedError } : {}),
    ...(reconciliation ? {
      reconciliation,
      known_usage_cost_micros: reconciliation.known_usage_cost_micros,
      has_unknown_usage: reconciliation.has_unknown_usage,
    } : {}),
    ...(receipt ? { receipt } : {}),
    ...extra,
  };
}

/**
 * Stateless `openai-batch-build` handler.
 */
export async function runOpenAiBatchBuildCommand({ values, streams, helpers }) {
  const {
    Phase2CliError,
    requireOption,
    readJsonFileSafe,
    writeSingleFileSafe,
    sanitizeCliDisplayPath,
    workflowSearchOptions,
  } = helpers;
  const command = 'openai-batch-build';
  const task = requireOption(values.task, 'task');
  if (!Object.hasOwn(WORKFLOW_RESPONSES_TASKS, task)) {
    throw new Phase2CliError(
      `不支持的 --task "${task}"；可选值：${Object.keys(WORKFLOW_RESPONSES_TASKS).join(' | ')}。`,
    );
  }
  const inputPath = resolve(requireOption(values.input, 'input'));
  const outputPath = resolve(requireOption(values.output, 'output'));
  const rawPayload = await readJsonFileSafe(inputPath, 'OpenAI Batch 任务输入文件');
  const rawItems = Array.isArray(rawPayload)
    ? rawPayload
    : (Array.isArray(rawPayload?.items)
      ? rawPayload.items
      : (Array.isArray(rawPayload?.requests) ? rawPayload.requests : null));
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Phase2CliError('Batch 输入 JSON 必须为非空数组，或包含非空 items[] 数组的对象。');
  }

  const batchRequests = rawItems.map((rawItem, idx) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      throw new Phase2CliError(`Batch 第 ${idx + 1} 项必须为 JSON 对象。`);
    }
    const customId = typeof rawItem.custom_id === 'string' && rawItem.custom_id.trim()
      ? rawItem.custom_id.trim()
      : (typeof rawItem.customId === 'string' && rawItem.customId.trim()
        ? rawItem.customId.trim()
        : `${task}-${idx + 1}`);
    const taskPayload = rawItem.input && typeof rawItem.input === 'object' && !Array.isArray(rawItem.input)
      ? rawItem.input
      : (() => {
        const { custom_id: _c1, customId: _c2, ...rest } = rawItem;
        return rest;
      })();
    const body = buildWorkflowTaskRequest(task, taskPayload, {
      model: 'gpt-6.1-terra',
      reasoningEffort: 'xhigh',
      ...workflowSearchOptions(task, values['max-tool-calls']),
    });
    return {
      custom_id: customId,
      method: 'POST',
      url: '/v1/responses',
      body,
    };
  });

  const built = buildBatchJsonl(batchRequests, {
    endpoint: '/v1/responses',
    allowAstraApi: false,
  });
  await writeSingleFileSafe(outputPath, Buffer.from(built.jsonl, 'utf8'), [inputPath]);

  const out = {
    ok: true,
    command,
    task,
    endpoint: '/v1/responses',
    model: 'gpt-6.1-terra',
    reasoning_effort: 'xhigh',
    service_tier: 'batch',
    output_path: sanitizeCliDisplayPath(outputPath),
    line_count: built.line_count,
    custom_ids: built.custom_ids,
    jsonl_sha256: built.jsonl_sha256,
    estimated_micros: built.estimated_micros,
    estimated_reservation_cents: built.estimated_reservation_cents,
  };
  streams.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return 0;
}

/**
 * Live `openai-batch-poll` handler (submit JSONL via structured `requests[]`, read-only GET
 * recovery on existing/known batch IDs, zero duplicate POSTs on unknown submissions, and
 * full output/error file reconciliation by `custom_id`).
 */
export async function runOpenAiBatchPollCommand({
  values,
  accountScope,
  client,
  ledger,
  policy,
  submitJsonlPath,
  helpers,
}) {
  const { Phase2CliError, requireOption, checkOperatorPayload, spendReceipt } = helpers;
  const downloadOutput = values['download-output'] === true;

  if (submitJsonlPath && values['batch-id']) {
    throw new Phase2CliError('--submit-jsonl 与 --batch-id 不能同时传入；请二选一。');
  }

  if (submitJsonlPath) {
    const jsonlText = await readFile(submitJsonlPath, 'utf8');
    checkOperatorPayload(jsonlText);
    const parsedInput = parseBatchInputJsonl(jsonlText, { defaultEndpoint: '/v1/responses' });
    const built = buildBatchJsonl(parsedInput.requests, {
      endpoint: parsedInput.endpoint,
      allowAstraApi: false,
    });
    // Order-insensitive logicalRequestId over normalized JSONL lines sorted by custom_id so
    // swapping two lines in batch.jsonl never triggers a duplicate billable POST.
    const normalizedLines = built.jsonl.trim().split('\n');
    const orderInsensitiveLines = normalizedLines
      .map((line, idx) => ({ customId: built.custom_ids[idx], line }))
      .sort((a, b) => a.customId.localeCompare(b.customId))
      .map(entry => entry.line);
    const orderInsensitiveSha = sha256Hex(`${orderInsensitiveLines.join('\n')}\n`);
    const baseLogicalId = 'cli-batch-' + sha256Hex(canonicalJson([
      accountScope,
      parsedInput.endpoint,
      orderInsensitiveSha,
    ]));

    // Check existing ledger attempt BEFORE any billable POST to guarantee 0 duplicate POSTs!
    // Allow a fresh retry slot ONLY when a prior attempt is provably pre-batch zero-charge terminal
    // (rejected/failed_known with confirmed_zero_charge=true, no batch_id, and no batch_post_sha256).
    let logicalId = baseLogicalId;
    let prior = ledger.getAttemptByLogicalId(logicalId, { accountScope });
    let retryIdx = 0;
    while (prior) {
      const isPreBatchZeroChargeTerminal = Boolean(
        (prior.status === 'rejected' || prior.status === 'failed_known') &&
        prior.confirmed_zero_charge === true &&
        !prior.provider_response_id &&
        !prior.batch_manifest?.batch_post_sha256,
      );
      if (!isPreBatchZeroChargeTerminal) break;
      retryIdx += 1;
      logicalId = `${baseLogicalId}-r${retryIdx}`;
      prior = ledger.getAttemptByLogicalId(logicalId, { accountScope });
    }
    if (prior) {
      if (prior.provider_response_id) {
        const polled = await client.retrieveBatch(prior.provider_response_id, {
          ...policy,
          maxRetries: 0,
          attemptId: prior.attempt_id,
          downloadOutput,
        });
        const receipt = spendReceipt(ledger, prior.attempt_id, accountScope);
        const result = summarizeBatchPollOutput(polled, {
          mode: 'recovered_existing_batch',
          batchId: prior.provider_response_id,
          attemptId: prior.attempt_id,
          receipt,
          downloadRequested: downloadOutput,
          extra: {
            reused_existing_attempt: true,
            duplicate_post_prevented: true,
            logical_request_id: logicalId,
            request_count: built.line_count,
            custom_ids: built.custom_ids,
          },
        });
        return { result, ok: polled.ok !== false };
      }

      const uploadedFileId = prior.batch_manifest?.uploaded_file_id ?? prior.batch_manifest?.input_file_id ?? null;
      const receipt = spendReceipt(ledger, prior.attempt_id, accountScope);
      const isRejected = prior.status === 'rejected';
      const result = {
        mode: isRejected ? 'prior_attempt_rejected' : 'pending_recovery_blocked',
        reused_existing_attempt: true,
        duplicate_post_prevented: true,
        fenced: prior.status === 'pending_recovery' || prior.status === 'in_progress',
        attempt_id: prior.attempt_id,
        logical_request_id: logicalId,
        input_file_id: uploadedFileId,
        file_id: uploadedFileId,
        batch_id: null,
        batch_status: prior.status,
        request_count: built.line_count,
        custom_ids: built.custom_ids,
        reason: isRejected
          ? 'Existing Batch submission attempt was previously rejected; fix input before submitting a new batch.'
          : 'Existing Batch submission attempt has no confirmed batch_id; refusing duplicate POST. Reconcile or inspect provider state before retrying.',
        receipt,
      };
      return { result, ok: false };
    }

    const submitted = await client.submitBatch({
      requests: parsedInput.requests,
      endpoint: parsedInput.endpoint,
      completion_window: '24h',
    }, { ...policy, maxRetries: 0, logicalRequestId: logicalId });
    const resolvedAttemptId = submitted.attempt_id ?? ledger.getAttemptByLogicalId(logicalId, { accountScope })?.attempt_id ?? null;
    const receipt = resolvedAttemptId ? spendReceipt(ledger, resolvedAttemptId, accountScope) : null;
    const inputFileId = submitted.input_file_id ?? null;
    const result = {
      mode: 'submitted',
      input_file_id: inputFileId,
      file_id: inputFileId,
      batch_id: submitted.batch_id ?? null,
      batch_status: submitted.batch_status ?? submitted.status ?? null,
      attempt_id: resolvedAttemptId,
      logical_request_id: submitted.logical_request_id ?? logicalId,
      request_count: built.line_count,
      custom_ids: built.custom_ids,
      receipt,
    };
    return { result, ok: Boolean(result.batch_id) };
  }

  const batchId = requireOption(values['batch-id'], 'batch-id');
  const explicitAttemptId = typeof values.attempt === 'string' && values.attempt.trim()
    ? values.attempt.trim()
    : null;
  const autoBoundAttempt = explicitAttemptId
    ? null
    : ledger.getAttemptByProviderResponseId(batchId, { accountScope, endpoint: '/v1/batches' });
  const resolvedAttemptId = explicitAttemptId ?? autoBoundAttempt?.attempt_id ?? null;

  const pollPolicy = {
    ...policy,
    maxRetries: 0,
    ...(resolvedAttemptId ? { attemptId: resolvedAttemptId } : { bindPendingRecoveryByManifest: true }),
    downloadOutput,
  };
  const polled = await client.retrieveBatch(batchId, pollPolicy);
  const finalAttemptId = resolvedAttemptId ?? polled?.attempt_id ?? null;
  const receipt = finalAttemptId ? spendReceipt(ledger, finalAttemptId, accountScope) : null;
  const result = summarizeBatchPollOutput(polled, {
    mode: 'polled',
    batchId,
    attemptId: finalAttemptId,
    receipt,
    downloadRequested: downloadOutput,
  });
  return { result, ok: polled.ok !== false };
}

/**
 * Stateful `daily-batch`, `single-product`, `single-dive`, and `reverse-1688` handler.
 */
export async function runDailyWorkflowBatchCommand({
  command,
  values,
  streams,
  store,
  dbPath,
  testHooks,
  helpers,
}) {
  const {
    Phase2CliError,
    requireOption,
    readJsonFileSafe,
    writeSingleFileSafe,
    writeReportArtifacts,
    enrichBatchAndResultFromStore,
    checkOperatorPayload,
    stringifyCliJson,
    sqlitePaths,
  } = helpers;

  const inputPath = resolve(requireOption(values.input, 'input'));
  const spec = await readJsonFileSafe(inputPath, `${command} 输入文件`);
  checkOperatorPayload(spec);
  const profilePath = values.profile ? resolve(values.profile) : DEFAULT_R59_PROFILE_PATH;
  const profile = await readJsonFileSafe(profilePath, '评分配置文件');
  if (values['profile-revision']) {
    const rev = Number(values['profile-revision']);
    if (!Number.isInteger(rev) || rev < 59) throw new Phase2CliError('--profile-revision 必须为 >= 59 的整数（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
    profile.revision = rev;
    if (profile.workflow?.scoring_and_ordering) profile.workflow.scoring_and_ordering.revision = rev;
  }
  if ((profile.revision ?? 59) < 59) {
    throw new Phase2CliError('当前主线仅运行 Revision 59+（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
  }
  const asOfDate = values['as-of'] ? values['as-of'].trim() : (spec.as_of_date ?? new Date().toISOString().slice(0, 10));
  const requestedReportDir = values['report-dir']
    ? resolve(values['report-dir'])
    : (typeof spec.report_dir === 'string' && spec.report_dir.trim() ? resolve(dirname(inputPath), spec.report_dir.trim()) : null);

  // Support raw-receipt trial specs directly in `single-product` (`ingest-trial -> replayBatchIntoStore -> V4 HTML report`)!
  if ((command === 'single-product' || command === 'single-dive') && Array.isArray(spec.raw_receipt_files) && Array.isArray(spec.candidates)) {
    if (spec.candidates.length !== 1) {
      throw new Phase2CliError(`${command} 原始回执模式每次仅支持 1 个候选（当前 ${spec.candidates.length} 个）。`);
    }
    const ingestedOut = ingestTrialSpecification(spec, profile, {
      baseDir: dirname(inputPath),
      ledgerDbPath: dbPath !== ':memory:' ? dbPath : null,
      allowSyntheticIds: values['allow-synthetic'] === true,
    });
    const ingestedBatch = ingestedOut.batch;
    const replayOut = replayBatchIntoStore(store, { batch: ingestedBatch, profile });
    let exported = null;
    if (requestedReportDir) {
      exported = await writeReportArtifacts(requestedReportDir, {
        resultBytes: replayOut.result_bytes,
        htmlBytes: replayOut.html_bytes,
        resultSha: replayOut.result_sha256,
        htmlSha: replayOut.html_sha256,
        summary: replayOut.summary,
        profileRevision: profile.revision,
        protectedInputPaths: [inputPath, profilePath, dbPath],
      });
    }
    const outIngest = {
      ok: true,
      command,
      mode: 'ingested_and_scored',
      candidate_id: ingestedBatch.candidates[0]?.id ?? null,
      result_sha256: replayOut.result_sha256,
      html_sha256: replayOut.html_sha256,
      evaluations_recorded: replayOut.evaluations_recorded,
      summary: replayOut.summary,
      ...(exported ? { exported } : {}),
    };
    checkOperatorPayload(outIngest);
    const jsonIngest = `${stringifyCliJson(outIngest)}\n`;
    if (values.output) {
      await writeSingleFileSafe(resolve(values.output), Buffer.from(jsonIngest, 'utf8'), [...sqlitePaths(dbPath), inputPath, profilePath]);
    }
    streams.stdout.write(jsonIngest);
    return 0;
  }

  const deriveFallbackFormId = rawItem => {
    if (typeof rawItem?.asin === 'string' && rawItem.asin.trim()) {
      return `form-${rawItem.asin.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')}`;
    }
    if (typeof rawItem?.keyword === 'string' && rawItem.keyword.trim()) {
      const slug = rawItem.keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      return `form-kw-${slug || sha256Hex(rawItem.keyword).slice(0, 10)}`;
    }
    if (typeof rawItem?.post_url === 'string' && rawItem.post_url.trim()) {
      return `form-post-${sha256Hex(rawItem.post_url.trim()).slice(0, 10)}`;
    }
    if (typeof rawItem?.offer_id === 'string' && rawItem.offer_id.trim()) {
      return `form-1688-${rawItem.offer_id.trim().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    }
    if (rawItem?.quote && typeof rawItem.quote === 'object') {
      const oId = rawItem.quote.sku_lines?.[0]?.offer_id ?? rawItem.quote.quote_id ?? null;
      if (typeof oId === 'string' && oId.trim()) {
        return `form-1688-${oId.trim().replace(/[^a-zA-Z0-9_-]/g, '')}`;
      }
    }
    return null;
  };

  const hydrateWorkflowItem = rawItem => {
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Phase2CliError(`${command} 每个候选条目必须为对象。`);
    }
    if ((profile.revision ?? 59) >= 59 && rawItem.disallow_pre1688_cost_guess_kill === false) {
      throw new Phase2CliError('Revision 59 严禁启用 Gate 1A 倒推价前置砍品（disallow_pre1688_cost_guess_kill 不可为 false）。');
    }
    const autoFormId = command !== 'daily-batch' ? deriveFallbackFormId(rawItem) : null;
    const targetFormId = rawItem.form && typeof rawItem.form === 'object'
      ? requireOption(rawItem.form.form_id ?? autoFormId, 'form_id')
      : requireOption(rawItem.form_id ?? autoFormId, 'form_id');
    const existingDbForm = store.getCandidateForm(targetFormId);
    let existingDbComp = existingDbForm?.saleable_set_composition ?? null;
    if (!existingDbComp && typeof existingDbForm?.saleable_set_composition_json === 'string') {
      try { existingDbComp = JSON.parse(existingDbForm.saleable_set_composition_json); } catch { existingDbComp = null; }
    }
    const hasExplicitFormSpec = Boolean(
      (rawItem.form && typeof rawItem.form === 'object') ||
      rawItem.saleable_set_composition ||
      rawItem.buyer_task ||
      rawItem.grade_or_material !== undefined,
    );
    const normAsinUpper = typeof rawItem.asin === 'string' && /^B0[A-Z0-9]{8}$/i.test(rawItem.asin.trim())
      ? rawItem.asin.trim().toUpperCase()
      : null;
    const formObj = rawItem.form && typeof rawItem.form === 'object'
      ? {
          ...rawItem.form,
          form_id: targetFormId,
          saleable_set_composition: rawItem.form.saleable_set_composition ?? existingDbComp ?? [{ component_id: 'unit', qty_per_saleable_set: 1 }],
        }
      : {
          form_id: targetFormId,
          product_family_key: rawItem.product_family_key ?? existingDbForm?.product_family_key ?? targetFormId,
          label: rawItem.label ?? existingDbForm?.label ?? (normAsinUpper ? `Single-ASIN candidate ${normAsinUpper}` : targetFormId),
          buyer_task: rawItem.buyer_task ?? existingDbForm?.buyer_task ?? rawItem.label ?? rawItem.keyword ?? targetFormId,
          saleable_set_composition: rawItem.saleable_set_composition ?? existingDbComp ?? [{ component_id: 'unit', qty_per_saleable_set: 1 }],
          grade_or_material: rawItem.grade_or_material ?? existingDbForm?.grade_or_material ?? null,
          target_child_asin: rawItem.target_child_asin ?? normAsinUpper ?? existingDbForm?.target_child_asin ?? null,
          leaf_node_path: rawItem.leaf_node_path ?? existingDbForm?.leaf_node_path ?? null,
        };
    let leads = Array.isArray(rawItem.leads) ? [...rawItem.leads] : [];
    if (leads.length === 0) {
      if (command === 'reverse-1688') {
        leads = [{
          lead_id: rawItem.lead_id ?? `ld-rev1688-${formObj.form_id}`,
          source_channel: '1688_factory_cold_start',
          source_ref: rawItem.source_ref ?? `1688://factory-cold-start/${formObj.form_id}`,
          phrase_or_title: rawItem.phrase_or_title ?? formObj.label ?? formObj.form_id,
          observed_at: asOfDate,
          disposition: 'product',
        }];
      } else if (rawItem.asin || rawItem.keyword || rawItem.post_url || rawItem.social_bridge) {
        leads = [rawItem.social_bridge
          ? {
              lead_id: rawItem.lead_id ?? `ld-dive-${formObj.form_id}`,
              source_channel: rawItem.source_channel ?? 'reddit',
              source_ref: rawItem.post_url ?? rawItem.source_ref ?? `https://example.com/${formObj.form_id}`,
              observed_at: asOfDate,
              social_bridge: rawItem.social_bridge,
            }
          : {
              lead_id: rawItem.lead_id ?? `ld-dive-${formObj.form_id}`,
              source_channel: rawItem.post_url ? (rawItem.source_channel ?? 'reddit') : (rawItem.source_channel ?? 'sellersprite_supply_gap'),
              source_ref: rawItem.post_url ?? rawItem.source_ref ?? (normAsinUpper ? `https://www.amazon.com/dp/${normAsinUpper}` : `search://keyword/${formObj.form_id}`),
              phrase_or_title: rawItem.phrase_or_title ?? rawItem.keyword ?? formObj.label ?? String(rawItem.asin || formObj.form_id),
              observed_at: asOfDate,
              disposition: 'product',
            }];
      }
    }

    // Pre-register form & any supplied verified 1688 quotes so runPhase2Batch reuses them cleanly without bumping spec_version on existing forms.
    const { form: upsertedForm } = store.upsertCandidateForm(formObj, {
      preserveExisting: Boolean(existingDbForm && !hasExplicitFormSpec),
    });
    const quoteList = (Array.isArray(rawItem.quotes)
      ? rawItem.quotes
      : (rawItem.quote && typeof rawItem.quote === 'object' ? [rawItem.quote] : [])
    ).filter(qObj => {
      if (!qObj || typeof qObj !== 'object') return false;
      if ((profile.revision ?? 59) >= 59 && qObj.require_ui_readback === false) {
        throw new Phase2CliError('Revision 59 严禁关闭 1688 ui_readback 核验门禁。');
      }
      if (typeof qObj.quote_id === 'string' && qObj.quote_id.trim()) {
        const existingQ = store.getQuoteById(qObj.quote_id.trim());
        if (existingQ && existingQ.form_id === upsertedForm.form_id && existingQ.spec_version === upsertedForm.spec_version) {
          const sameGoods = !Number.isFinite(qObj.goods_cny_total) ||
            Math.abs(Number(qObj.goods_cny_total) - Number(existingQ.goods_cny_total)) <= 1e-6;
          const sameDom = qObj.domestic_freight_cny_total === undefined ||
            (qObj.domestic_freight_cny_total === null
              ? existingQ.domestic_freight_cny_total === null
              : (existingQ.domestic_freight_cny_total !== null &&
                Math.abs(Number(qObj.domestic_freight_cny_total) - Number(existingQ.domestic_freight_cny_total)) <= 1e-6));
          const incomingFactory = typeof qObj.factory_id === 'string' && qObj.factory_id.trim()
            ? qObj.factory_id.trim()
            : null;
          const sameFactory = incomingFactory === null ||
            existingQ.factory_id === null ||
            incomingFactory === existingQ.factory_id;
          if (!sameGoods || !sameDom || !sameFactory) {
            throw new Phase2CliError(
              `报价 ID "${existingQ.quote_id}" 已存在但价格或工厂与已存记录冲突；请使用新的 quote_id 录入变更后的报价。`,
            );
          }
          return false;
        }
      }
      return true;
    });
    if (quoteList.length > 0) {
      store.recordSourcingQuotesBatch1688(quoteList.map(qObj => ({
        ...qObj,
        ...((profile.revision ?? 59) >= 59 ? { require_ui_readback: true } : {}),
        form_id: upsertedForm.form_id,
        spec_version: upsertedForm.spec_version,
      })));
    }

    const resolvedG1aScenarios = Array.isArray(rawItem.gate1a_scenarios) && rawItem.gate1a_scenarios.length > 0
      ? rawItem.gate1a_scenarios
      : (Array.isArray(rawItem.scenarios) && rawItem.scenarios.length > 0 ? rawItem.scenarios : null);
    const earlyScens = Array.isArray(rawItem.early_screen_scenarios)
      ? rawItem.early_screen_scenarios
      : (rawItem.early_screen_scenario
          ? [rawItem.early_screen_scenario]
          : (resolvedG1aScenarios
              ? buildAutoEarlyScreenScenariosFromGate1A(resolvedG1aScenarios, {
                  saleable_unit: rawItem.saleable_unit ?? formObj.label ?? '1 complete saleable set',
                  profile_revision: profile.revision ?? 59,
                  specific_rights_conflict: rawItem.specific_rights_conflict ?? 'unknown',
                  strong_date_dependency: rawItem.strong_date_dependency === true ? true : false,
                })
              : null));
    const researchPayload = rawItem.research_out ?? (rawItem.scored_batch ? { batch: rawItem.scored_batch } : null);
    const simCaptcha = rawItem.simulate_1688_captcha === true;

    return {
      ...rawItem,
      form: formObj,
      leads,
      ...(resolvedG1aScenarios && !rawItem.gate1a_scenarios ? { gate1a_scenarios: resolvedG1aScenarios } : {}),
      disallow_pre1688_cost_guess_kill: true,
      ...(earlyScens && !rawItem.early_screen_builder ? { early_screen_builder: () => earlyScens } : {}),
      ...(simCaptcha && !rawItem.sourcing_executor
        ? { sourcing_executor: async () => ({ status: 'captcha_triggered', reason: rawItem.captcha_reason ?? '1688 slider verification appeared' }) }
        : {}),
      ...(researchPayload && !rawItem.deep_research_executor
        ? { deep_research_executor: async () => researchPayload }
        : {}),
    };
  };

  let reverseSolution = null;
  if (command === 'reverse-1688') {
    const qObj = spec.quote ?? (Array.isArray(spec.quotes) ? spec.quotes[0] : null);
    if (!qObj || typeof qObj !== 'object') {
      throw new Phase2CliError('reverse-1688 必须包含 1688 源头厂整套报价 quote（或 quotes[0]）。');
    }
    const fxVal = spec.fx_cny_per_usd ?? qObj.fx_cny_per_usd;
    const pkgObj = spec.pkg ?? qObj.pkg ?? null;
    if (!pkgObj || !Number.isFinite(fxVal) || fxVal <= 0) {
      throw new Phase2CliError('reverse-1688 需要提供外箱尺寸重量 pkg 与正数汇率 fx_cny_per_usd。');
    }
    let derivedCompleteSets = null;
    if (
      !Number.isInteger(qObj.actual_complete_sets) &&
      Array.isArray(qObj.sku_lines) &&
      qObj.sku_lines.length > 0
    ) {
      if (qObj.sku_lines.every(sl => Number.isInteger(sl?.ordered_qty) && sl.ordered_qty >= 1)) {
        derivedCompleteSets = Math.min(
          ...qObj.sku_lines.map(sl => {
            const qPerSet = Number.isInteger(sl?.qty_per_saleable_set) && sl.qty_per_saleable_set >= 1 ? sl.qty_per_saleable_set : 1;
            return Math.floor(sl.ordered_qty / qPerSet);
          }),
        );
      } else {
        const comp = Array.isArray(spec.saleable_set_composition) && spec.saleable_set_composition.length > 0
          ? spec.saleable_set_composition
          : (Array.isArray(spec.form?.saleable_set_composition) && spec.form.saleable_set_composition.length > 0
            ? spec.form.saleable_set_composition
            : qObj.sku_lines.map(sl => ({
                component_id: sl.component_id ?? 'unit',
                qty_per_saleable_set: Number.isInteger(sl.qty_per_saleable_set) && sl.qty_per_saleable_set >= 1 ? sl.qty_per_saleable_set : 1,
              })));
        const plan = computeOrderPlan({
          saleable_set_composition: comp,
          sku_lines: qObj.sku_lines,
          allow_remainder: qObj.allow_remainder ?? spec.allow_remainder ?? false,
          target_sets: qObj.target_sets ?? spec.target_sets ?? null,
          profile_revision: 59,
        });
        if (Number.isInteger(plan?.actual_complete_sets) && plan.actual_complete_sets > 0) {
          derivedCompleteSets = plan.actual_complete_sets;
        }
      }
    }
    const orderUnits = Number.isInteger(qObj.actual_complete_sets) && qObj.actual_complete_sets > 0
      ? qObj.actual_complete_sets
      : (derivedCompleteSets ?? (Number.isInteger(qObj.order_units) && qObj.order_units > 0 ? qObj.order_units : 100));
    const hasGoodsTotal = Number.isFinite(qObj.goods_cny_total) && qObj.goods_cny_total >= 0;
    const hasDomFreight = Number.isFinite(qObj.domestic_freight_cny_total) && qObj.domestic_freight_cny_total >= 0;
    const missingTopRevBond = (spec.bond_included === false || qObj.bond_included === false) &&
      !Number.isFinite(spec.bond_usd_per_unit ?? qObj.bond_usd_per_unit);
    const scalarRevHeadhaulUsd = !missingTopRevBond && Number.isFinite(spec.headhaul_usd) && spec.headhaul_usd >= 0
      ? spec.headhaul_usd + (spec.bond_included === false ? Number(spec.bond_usd_per_unit ?? qObj.bond_usd_per_unit) : 0)
      : (!missingTopRevBond && Number.isFinite(qObj.headhaul_usd) && qObj.headhaul_usd >= 0
        ? qObj.headhaul_usd + (qObj.bond_included === false ? Number(qObj.bond_usd_per_unit ?? spec.bond_usd_per_unit) : 0)
        : undefined);
    const rawRevHeadhaulObj = spec.headhaul ?? qObj.headhaul ?? null;
    const revHeadhaulObj = rawRevHeadhaulObj && typeof rawRevHeadhaulObj === 'object' && !Array.isArray(rawRevHeadhaulObj) ? rawRevHeadhaulObj : null;
    const hasStructuredRevHeadhaul = isStructuredHeadhaulSpec(revHeadhaulObj);
    let resolvedRevHeadhaulUsd;
    let revHeadhaulErrorReason = null;
    let revHeadhaulAdvisoryNote = null;
    if (revHeadhaulObj) {
      const innerRevScopePre = String(revHeadhaulObj.destination_scope ?? revHeadhaulObj.headhaul_destination_scope ?? '').trim().toLowerCase();
      const outerRevScopePre = String(spec.headhaul_destination_scope ?? '').trim().toLowerCase();
      if (outerRevScopePre && innerRevScopePre && outerRevScopePre !== innerRevScopePre) {
        revHeadhaulErrorReason = `Conflicting outer headhaul_destination_scope (${outerRevScopePre}) vs headhaul.destination_scope (${innerRevScopePre}).`;
      } else if (Number.isFinite(spec.headhaul_rate_cny_per_kg) && Number.isFinite(revHeadhaulObj.rate_cny_per_kg) &&
        Math.abs(spec.headhaul_rate_cny_per_kg - revHeadhaulObj.rate_cny_per_kg) > 1e-6) {
        revHeadhaulErrorReason = `Conflicting outer headhaul_rate_cny_per_kg (${spec.headhaul_rate_cny_per_kg}) vs headhaul.rate_cny_per_kg (${revHeadhaulObj.rate_cny_per_kg}).`;
      }
    }
    if (revHeadhaulErrorReason === null && hasStructuredRevHeadhaul) {
      const a4Rev = computeHeadhaulWithA4Rules(revHeadhaulObj, fxVal, orderUnits, {
        isR58: true,
        isR59: true,
        steadyStateReplenishment: spec.steady_state_replenishment,
      });
      if (a4Rev?.advisory_replenishment_note || a4Rev?.a4_applied?.advisory_replenishment_note) {
        revHeadhaulAdvisoryNote = a4Rev.advisory_replenishment_note ?? a4Rev.a4_applied.advisory_replenishment_note;
      }
      const innerRevRate = Number.isFinite(revHeadhaulObj.rate_cny_per_kg) ? revHeadhaulObj.rate_cny_per_kg : a4Rev?.cny_derivation?.rate_cny_per_kg;
      if (Number.isFinite(spec.headhaul_rate_cny_per_kg) && Number.isFinite(innerRevRate) && Math.abs(spec.headhaul_rate_cny_per_kg - innerRevRate) > 1e-6) {
        revHeadhaulErrorReason = `Conflicting outer headhaul_rate_cny_per_kg (${spec.headhaul_rate_cny_per_kg}) vs headhaul.rate_cny_per_kg (${innerRevRate}).`;
      } else if (a4Rev?.weight_conflict) {
        revHeadhaulErrorReason = a4Rev.conflict_reason ?? 'Conflicting carton weight and total actual weight in headhaul inputs.';
      } else if (a4Rev?.missing_surcharge_quote) {
        revHeadhaulErrorReason = `Headhaul Freight A4 requires ${a4Rev.a4_applied?.missing_surcharge_quote ?? 'surcharge quote'}.`;
      } else if (Number.isFinite(a4Rev?.amount_usd)) {
        if (scalarRevHeadhaulUsd !== undefined && Math.abs(scalarRevHeadhaulUsd - a4Rev.amount_usd) > 0.005) {
          revHeadhaulErrorReason = `Supplied headhaul_usd ($${scalarRevHeadhaulUsd}) conflicts with recomputed structured headhaul ($${a4Rev.amount_usd}).`;
        } else {
          resolvedRevHeadhaulUsd = a4Rev.amount_usd;
        }
      }
    } else if (revHeadhaulErrorReason === null && scalarRevHeadhaulUsd !== undefined) {
      resolvedRevHeadhaulUsd = scalarRevHeadhaulUsd;
    } else if (revHeadhaulErrorReason === null && revHeadhaulObj) {
      if (
        Number.isFinite(revHeadhaulObj.usd_per_unit) &&
        revHeadhaulObj.usd_per_unit >= 0 &&
        (revHeadhaulObj.bond_included === true || Number.isFinite(revHeadhaulObj.bond_usd_per_unit))
      ) {
        resolvedRevHeadhaulUsd = revHeadhaulObj.usd_per_unit + (revHeadhaulObj.bond_included === true ? 0 : revHeadhaulObj.bond_usd_per_unit);
      }
    }
    const bareGoodsScreening = spec.bare_goods_screening === true ||
      qObj.bare_goods_screening === true ||
      qObj.pricing_basis === 'bare_goods_1688' ||
      (!hasDomFreight && spec.bare_goods_screening !== false && qObj.bare_goods_screening !== false);
    const advisoryDomFreightCny = Number.isFinite(qObj.domestic_freight_advisory_cny_total) && qObj.domestic_freight_advisory_cny_total >= 0
      ? qObj.domestic_freight_advisory_cny_total
      : (bareGoodsScreening && hasDomFreight ? Number(qObj.domestic_freight_cny_total) : null);
    const revExplicitLandedMissingFreight = !bareGoodsScreening && !hasDomFreight;
    const revInvalidSets = !Number.isSafeInteger(orderUnits) || orderUnits < 100;
    const revPromoOrRejected = qObj.goods_first_order_promotion === true ||
      qObj.goods_first_order_promotion === 1 ||
      (!bareGoodsScreening && (qObj.freight_first_order_promotion === true || qObj.freight_first_order_promotion === 1)) ||
      (typeof qObj.quote_status === 'string' && qObj.quote_status !== 'verified' && qObj.quote_status !== 'superseded_uncompetitive');
    if (!hasGoodsTotal || !Number.isFinite(resolvedRevHeadhaulUsd) || revHeadhaulErrorReason !== null ||
      revExplicitLandedMissingFreight || revInvalidSets || revPromoOrRejected) {
      const pendingReason = !hasGoodsTotal
        ? 'Missing goods_cny_total on 1688 quote.'
        : revExplicitLandedMissingFreight
          ? 'Explicit landed-freight reverse-1688 (bare_goods_screening: false) requires domestic_freight_cny_total.'
          : revInvalidSets
            ? `1688 quote must cover at least 100 complete sets (received ${orderUnits}).`
            : revPromoOrRejected
              ? 'Promotional, rejected, expired, or incomplete 1688 quote cannot produce a verified repeat-order floor price.'
              : (revHeadhaulErrorReason ?? 'Missing verified headhaul_usd or complete structured A4 headhaul inputs; headhaul is never assumed $2.20.');
      reverseSolution = {
        calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
        cost_basis: bareGoodsScreening ? 'bare_goods_1688' : 'landed_domestic_explicit',
        ...(bareGoodsScreening ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
        ...(advisoryDomFreightCny !== null ? { domestic_freight_advisory_cny_total: advisoryDomFreightCny } : {}),
        ...(revHeadhaulAdvisoryNote ? { advisory_replenishment_note: revHeadhaulAdvisoryNote } : {}),
        actual_complete_sets_used: orderUnits,
        min_retail_price_for_30pct_usd: null,
        mature_band_comparison: 'pending_freight_or_headhaul_verification',
        solution: {
          status: revExplicitLandedMissingFreight ? 'pending_domestic_freight' : 'needs_calculator_verification',
          calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
          cost_basis: bareGoodsScreening ? 'bare_goods_1688' : 'landed_domestic_explicit',
          ...(bareGoodsScreening ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
          reason: pendingReason,
          feasible_min_price_usd: null,
        },
      };
    } else {
      const costCnyPerUnit = bareGoodsScreening
        ? Number(qObj.goods_cny_total) / orderUnits
        : (Number(qObj.goods_cny_total) + Number(qObj.domestic_freight_cny_total)) / orderUnits;
      const solved = solveMinPriceForMargin2027({
        pkg: pkgObj,
        order_units: orderUnits,
        ...(bareGoodsScreening
          ? { bare_goods_cny: costCnyPerUnit, bare_goods_screening: true, domestic_freight_advisory_cny_total: advisoryDomFreightCny }
          : { landed_domestic_cny: costCnyPerUnit }),
        headhaul_usd: resolvedRevHeadhaulUsd,
        headhaul_rate_cny_per_kg: (rawRevHeadhaulObj && typeof rawRevHeadhaulObj === 'object' && Number.isFinite(rawRevHeadhaulObj.rate_cny_per_kg))
          ? rawRevHeadhaulObj.rate_cny_per_kg
          : (spec.headhaul_rate_cny_per_kg ?? null),
        headhaul_destination_scope: (rawRevHeadhaulObj && typeof rawRevHeadhaulObj === 'object' && (rawRevHeadhaulObj.destination_scope ?? rawRevHeadhaulObj.headhaul_destination_scope))
          ? (rawRevHeadhaulObj.destination_scope ?? rawRevHeadhaulObj.headhaul_destination_scope)
          : (spec.headhaul_destination_scope ?? null),
        steady_state_replenishment: spec.steady_state_replenishment ??
          (rawRevHeadhaulObj && typeof rawRevHeadhaulObj === 'object' ? rawRevHeadhaulObj.steady_state_replenishment : undefined),
        placement_split_option: spec.placement_split_option,
        identical_cartons_count: spec.identical_cartons_count,
        multi_destination_headhaul_verified: spec.multi_destination_headhaul_verified,
        fee_category: spec.fee_category ?? 'Home and Kitchen',
        referral_terms: spec.referral_terms ?? { referral_fraction: 0.15, minimum_referral_usd: 0.30, minimum_referral_fee_usd: 0.30, refund_admin_fraction: 0.20, refund_admin_cap_usd: 5.00 },
        refund_fraction: spec.refund_fraction ?? 0.04,
        physical_return_fraction: spec.physical_return_fraction ?? spec.refund_fraction ?? 0.04,
        collection_rate: spec.collection_rate ?? 0.006,
        fx_cny_per_usd: fxVal,
        margin_floor: 0.30,
        min_retail_price_usd: Math.max(29.99, spec.minimum_price_usd ?? 29.99),
      });
      const band = spec.mature_price_band?.mature_regular_band ?? spec.mature_price_band?.regular_band_reference ?? spec.mature_price_band?.band ?? spec.mature_price_band ?? null;
      const minPrice = solved.feasible_min_price_usd ?? null;
      const bandVerdict = Number.isFinite(minPrice) && Number.isFinite(band?.p25_usd) && Number.isFinite(band?.p75_usd)
        ? (minPrice < band.p25_usd ? 'below_band_strong_headroom' : (minPrice <= band.p75_usd ? 'within_mature_band_viable' : 'above_mature_band_p75_uncompetitive'))
        : 'forward_price_only_awaiting_us_band';
      reverseSolution = {
        calculator_name_zh: CALCULATOR_1688_FLOOR_PRICE_NAME_ZH,
        cost_basis: bareGoodsScreening ? 'bare_goods_1688' : 'landed_domestic_explicit',
        ...(bareGoodsScreening ? { bare_goods_disclosure: BARE_GOODS_DISCLOSURE_ZH } : {}),
        ...(advisoryDomFreightCny !== null ? { domestic_freight_advisory_cny_total: advisoryDomFreightCny } : {}),
        ...(revHeadhaulAdvisoryNote ? { advisory_replenishment_note: revHeadhaulAdvisoryNote } : {}),
        actual_complete_sets_used: orderUnits,
        min_retail_price_for_30pct_usd: minPrice,
        mature_band_comparison: bandVerdict,
        solution: solved,
      };
    }
    if (!Array.isArray(spec.gate1a_scenarios) || spec.gate1a_scenarios.length === 0) {
      const outOnly = { ok: true, command, reverse_1688: reverseSolution };
      checkOperatorPayload(outOnly);
      const jsonOnly = `${stringifyCliJson(outOnly)}\n`;
      if (values.output) {
        await writeSingleFileSafe(resolve(values.output), Buffer.from(jsonOnly, 'utf8'), [...sqlitePaths(dbPath), inputPath]);
      }
      streams.stdout.write(jsonOnly);
      return 0;
    }
  }

  const rawItems = command === 'daily-batch'
    ? (Array.isArray(spec.items) ? spec.items : (Array.isArray(spec) ? spec : [spec]))
    : [spec.item && typeof spec.item === 'object' ? spec.item : spec];
  if (command !== 'daily-batch' && rawItems.length !== 1) {
    throw new Phase2CliError(`${command} 每次仅执行单个候选深挖。`);
  }
  const hydratedItems = rawItems.map(hydrateWorkflowItem);

  // Bare seed registration mode on `single-product` (e.g. `{"asin":"B0SYNV400D"}` before SP-API/SellerSprite Gate 1A scenarios are attached):
  if (
    (command === 'single-product' || command === 'single-dive') &&
    !Array.isArray(hydratedItems[0].gate1a_scenarios) &&
    !hydratedItems[0].deep_research_executor &&
    !store.getCandidateForm(hydratedItems[0].form.form_id)?.gate1a_result_json
  ) {
    const seedItem = hydratedItems[0];
    const registeredLeads = [];
    for (const leadSpec of seedItem.leads ?? []) {
      if (leadSpec?.social_bridge) {
        const res = store.ingestSocialBridgeLead(leadSpec.social_bridge, {
          ...leadSpec,
          form_id: seedItem.form.form_id,
          link_role: leadSpec.link_role ?? 'primary_discovery',
          link_note: leadSpec.link_note ?? null,
        });
        registeredLeads.push(res.lead.lead_id);
      } else {
        const { lead } = store.upsertRawLead(leadSpec);
        store.linkLeadToForm({
          lead_id: lead.lead_id,
          form_id: seedItem.form.form_id,
          link_role: leadSpec.link_role ?? 'primary_discovery',
          note: leadSpec.link_note ?? null,
        });
        registeredLeads.push(lead.lead_id);
      }
    }
    const outSeed = {
      ok: true,
      command,
      mode: 'seed_registered_awaiting_gate1a',
      form_id: seedItem.form.form_id,
      leads_registered: registeredLeads,
      lifecycle_status: store.getCandidateForm(seedItem.form.form_id)?.lifecycle_status ?? 'discovered',
      next_step: 'Attach verified SP-API/SellerSprite Gate 1A scenarios (or raw_receipt_files + candidate spec) to advance through Gate 1A -> Gate 1B -> 21-item V4 HTML report.',
    };
    checkOperatorPayload(outSeed);
    const jsonSeed = `${stringifyCliJson(outSeed)}\n`;
    if (values.output) {
      await writeSingleFileSafe(resolve(values.output), Buffer.from(jsonSeed, 'utf8'), [...sqlitePaths(dbPath), inputPath, profilePath]);
    }
    streams.stdout.write(jsonSeed);
    return 0;
  }

  const discoveryPlan = command === 'daily-batch'
    ? planDiscoveryBatch(store, {
        max_channels: Math.max(5, hydratedItems.length),
        task_slots: Math.max(5, hydratedItems.length),
        enforce_80_20_mix: true,
      })
    : null;
  const batchReport = await runPhase2Batch(store, {
    items: hydratedItems,
    profile,
    as_of_date: asOfDate,
    sourcing_executor: testHooks?.sourcingExecutor ?? null,
    deep_research_executor: testHooks?.deepResearchExecutor ?? null,
    openai_hooks: testHooks?.openaiHooks ?? null,
    resume_skip_completed: spec.resume_skip_completed !== false,
  });
  let singleExportedReport = null;
  if ((command === 'single-product' || command === 'single-dive') && requestedReportDir) {
    const singleBatchSrc = hydratedItems[0]?.scored_batch ?? hydratedItems[0]?.research_out?.batch ?? null;
    if (singleBatchSrc && Array.isArray(singleBatchSrc.candidates) && singleBatchSrc.candidates.length > 0) {
      const exportBatch = structuredClone(singleBatchSrc);
      const singleFormId = hydratedItems[0]?.form?.form_id ?? null;
      const singleFormRow = singleFormId ? store.getCandidateForm(singleFormId) : null;
      const singleGate1a = singleFormRow?.gate1a_result_json ? JSON.parse(singleFormRow.gate1a_result_json) : null;
      if (singleFormRow) {
        const cIdx = exportBatch.candidates.findIndex(c => c?.id === singleFormId);
        if (cIdx >= 0) {
          let cObj = exportBatch.candidates[cIdx];
          attachGate1APriceCliffStress(cObj, singleGate1a);
          if (singleFormRow.spec_sha256) cObj.spec_sha256 = singleFormRow.spec_sha256;
          if (Number.isInteger(singleFormRow.spec_version) && singleFormRow.spec_version > 0) {
            cObj.spec_version = singleFormRow.spec_version;
          }
          if (Array.isArray(hydratedItems[0]?.peer_comparability_rulings) && hydratedItems[0].peer_comparability_rulings.length > 0) {
            cObj = applyPeerComparabilityRulings(cObj, hydratedItems[0].peer_comparability_rulings, {
              currentSpecSha: singleFormRow.spec_sha256,
              currentSpecVersion: singleFormRow.spec_version,
            });
            exportBatch.candidates[cIdx] = cObj;
          }
        }
      }
      const boundSingleBatch = attachStoreDiscoveryProvenance(exportBatch, store);
      const { notesByFormId, storedPackagingShortlist } = enrichBatchAndResultFromStore(boundSingleBatch, store, {
        profileRevision: profile.revision,
        profile,
      });
      const scoredSingle = scoreBatch(boundSingleBatch, profile);
      if (notesByFormId.size > 0 && Array.isArray(scoredSingle.candidates)) {
        for (const sc of scoredSingle.candidates) {
          const notes = notesByFormId.get(sc.candidate_id || sc.id);
          if (notes && notes.length > 0) sc.review_notes = notes;
        }
      }
      if (Array.isArray(storedPackagingShortlist) && storedPackagingShortlist.length > 0) {
        scoredSingle.packaging_redesign_shortlist = storedPackagingShortlist;
      }
      const resBytes = Buffer.from(`${JSON.stringify(scoredSingle, null, 2)}\n`, 'utf8');
      const htmBytes = Buffer.from(renderReport(scoredSingle, boundSingleBatch), 'utf8');
      singleExportedReport = await writeReportArtifacts(requestedReportDir, {
        resultBytes: resBytes,
        htmlBytes: htmBytes,
        resultSha: sha256Hex(resBytes),
        htmlSha: sha256Hex(htmBytes),
        summary: scoredSingle.summary,
        profileRevision: profile.revision,
        protectedInputPaths: [inputPath, profilePath, dbPath],
      });
    }
  }
  const coverageAudit = command === 'daily-batch'
    ? auditDiscoveryCoverage(store, { profile_revision: profile.revision })
    : null;
  const out = {
    ok: true,
    command,
    ...(discoveryPlan ? { discovery_plan_80_20: discoveryPlan } : {}),
    ...(coverageAudit ? { coverage_audit: coverageAudit } : {}),
    ...(reverseSolution ? { reverse_1688: reverseSolution } : {}),
    ...(singleExportedReport ? { exported: singleExportedReport } : {}),
    batch_report: batchReport,
  };
  checkOperatorPayload(out);
  const json = `${stringifyCliJson(out)}\n`;
  if (values.output) {
    await writeSingleFileSafe(
      resolve(values.output),
      Buffer.from(json, 'utf8'),
      [...sqlitePaths(dbPath), inputPath, profilePath],
    );
  }
  streams.stdout.write(json);
  return 0;
}
