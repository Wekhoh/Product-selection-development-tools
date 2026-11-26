/**
 * Phase 2 operational CLI for the local SQLite store (Core 5 business objects),
 * multi-channel discovery planning & anti-convergence coverage audit, Stage-1 price-band
 * denoising, Stage-2 contact-sheet rendering, Gate 1A/1B local evaluation, unknown-attempt
 * reconciliation, historical ledger/lock import, frozen replay & report export, queue resume,
 * and lineage trace.
 * Read-only inspection commands (status, trace, coverage, plan-discovery) open SQLite strictly
 * read-only without mutating active in-flight requests. Leaves legacy src/cli.mjs untouched.
 */
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, computeEvidenceBundleHash, openSelectionStore, sha256Hex } from './store.mjs';
import {
  buildOutOfTableLookupDirective,
  computeHeadhaulWithA4Rules,
  computeOrderPlan,
  getFba2027RateTableSnapshot,
  registerSupplementalOutOfTableRule2027,
  solveMinPriceForMargin2027,
} from './fba-calculator.mjs';
import { buildFunnelLedger, checkFormDuplicates } from './funnel-ledger.mjs';
import {
  importRecoveryLockFile,
  importRequestLedgerFile,
  importRetainedAssetsManifest,
  replayBatchIntoStore,
} from './history-import.mjs';
import {
  attachGate1APriceCliffStress,
  buildAutoEarlyScreenScenariosFromGate1A,
  doesReviewPacketMatchDbFormSpec,
  runFastProfitHealthcheck2027,
  runGate1AForForm,
  runGate1BForForm,
  runOptionalStage12LunaTriage,
  runOptionalTerraWorkflowTask,
  runPhase2Batch,
} from './pipeline.mjs';
import {
  evaluateGate0CategoryBoundary,
  analyzeMainstreamPriceBand,
  tightenClusterBands,
} from './price-band.mjs';
import {
  auditDiscoveryCoverage,
  planDiscoveryBatch,
} from './discovery-channels.mjs';
import { attachDiscovery, attachStoreDiscoveryProvenance, prepareDiscovery } from './discovery.mjs';
import { scoreBatch } from './scoring.mjs';
import { renderReport } from './report.mjs';
import { extractSpApiFinalistCalibration, ingestTrialSpecification, mergeKeepaPayloadsIntoPeerListings } from './raw-ingest.mjs';
import { assertNoRawPii, containsSecretToken, sanitizeDiagnosticText } from './contracts.mjs';
import {
  DEFAULT_CODEX_SERVICE_TIER,
  WORKFLOW_RESPONSES_TASKS,
  OpenAiClient,
  assertAuthorizedReviewExecutionPolicy,
  assertSafeOpenAiAccountScope,
  assertValidMonthUtc,
  buildBatchJsonl,
  buildWorkflowTaskRequest,
  currentMonthUtc,
  inspectLegacyAutopilotBudget,
  openOpenAiBudgetLedger,
  resolveCodexCommand,
  runCodexEvidenceReview,
} from './openai/index.mjs';
import { verifySavedCodexReceipt } from './receipt-verifier.mjs';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_CANONICAL_BUDGET_DB = resolve(THIS_DIR, '..', '.local', 'state', 'selection.sqlite');
const CONTACT_SHEET_SCRIPT = resolve(THIS_DIR, '..', 'scripts', 'render_contact_sheet.py');
const stringifyCliJson = value => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const ioCode = error => (typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'IO_ERROR');
const pathKey = value => (process.platform === 'win32' ? value.toLowerCase() : value);

const USAGE = [
  '用法：node src/phase2-cli.mjs <command> [options]',
  '命令：',
  '  init            --db <sqlite-path> [--reconcile-crashed]',
  '  import-history  --db <sqlite-path> [--recovery <file>...] [--ledger <file>...] [--assets <manifest.json>]',
  '  replay          --db <sqlite-path> --batch <batch.json> --profile <profile.json> [--profile-revision <n>] [--discovery <bundle.json>] [--verify-result <sha256>] [--verify-html <sha256>] [--output <dir>]',
  '  export-report   --db <sqlite-path> --batch <batch.json> --profile <profile.json> --output <dir> [--profile-revision <n>] [--discovery <bundle.json>]',
  '  status          --db <sqlite-path>  (只读，不干扰在途请求)',
  '  trace           --db <sqlite-path> --form <form-id>  (只读，不干扰在途请求)',
  '  coverage        --db <sqlite-path>  (只读，输出多通道反同质化覆盖审计)',
  '  plan-discovery  --db <sqlite-path> [--budget <n>]  (只读，按 5 路径配额生成下一批挖掘任务)',
  '  gate1a          --db <sqlite-path> --input <gate1a-spec.json>',
  '  gate1b          --db <sqlite-path> --input <gate1b-spec.json> [--as-of <YYYY-MM-DD>]',
  '  reconcile       --db <sqlite-path> --attempt <id> --status <completed|failed|permanently_locked> [--note <text>] [--sif-units <n>] [--ss-mcp-units <n>] [--ss-web-units <n>] [--exa-calls <n>] [--confirmed-zero-charge]',
  '  resume-1688     --db <sqlite-path> --login-verified --city <city> --quantity <n> --sku <sku> --validity <YYYY-MM-DD> [--form <paused-form-id>] [--as-of <YYYY-MM-DD>]',
  '  price-band         --input <listings.json> [--output <out.json>]  (无状态，执行 Gate-0 边界 + Stage-1 主流价位带去噪)',
  '  contact-sheet      --input <items.json> --output <sheet.png> [--manifest-out <out.json>] [--title <text>] [--offline]',
  '  openai-status      --db <sqlite> [--legacy-budget <sqlite>] [--account-scope <scope>] [--month <YYYY-MM>]  (只读)',
  '  openai-reconcile   --db <sqlite> [--legacy-budget <sqlite>] [--enable --confirm-auto-recharge-off --confirm-hard-limit | --disable] [--monthly-limit-cents <0..20000>] [--same-month-pending-buffer-cents <0..2000>] [--account-scope <scope>] [--attempt <id> --status <completed|failed_known|pending_recovery> --note <text> (--usage-cost-micros <n> | --posted-billed-cents <n> | --confirmed-zero-charge)]',
  '  luna-triage        --db <sqlite> --credential-file <json> --listings <listings.json> [--contact-sheet <png>] [--detail <low|high|auto>] --output <out.json>',
  '  openai-task        --db <sqlite> --credential-file <json> --task <social-bridge|spec-matcher|1688-vision|review-judge|rights-prescreen> --input <task.json> --output <out.json> [--background] [--progress-file <progress.json>] [--max-tool-calls <n>] [--delete-after]',
  '  openai-cancel      --db <sqlite> --credential-file <json> --attempt <id> [--output <out.json>]',
  '  solve-min-price    --input <spec.json> [--output <out.json>]',
  '  dedupe-forms       --db <sqlite> --input <leads-or-forms.json> [--output <out.json>]',
  '  funnel-ledger      --db <sqlite> [--since <ISO-timestamp>] [--output <out.json>]',
  '  openai-batch-build --task <social-bridge|spec-matcher|1688-vision|review-judge|rights-prescreen> --input <items.json> --output <batch.jsonl> [--max-tool-calls <n>]',
  '  ingest-trial       --input <spec.json> --profile <profile.json> [--output <out.batch.json>]  (无状态，校验原始回执 ASIN 溯源并生成 r59 双季批次)',
  '  sp-api-calibrate   --input <sp-api-bundle.json> [--output <out.json>]  (无状态，从只读 SP-API 终审回执提取官方包装尺寸、佣金比例与限售状态)',
  '  serve-report       --dir <report-dir> [--port <port>] [--check | --once]  (无状态，在 127.0.0.1 启动本地 HTML 报告渲染预览服务)',
  '  redteam-review     --packet <packet.json> --output <review.json> [--effort <xhigh|max>] [--image <file>...] [--dry-run | --offline]  (未传 --dry-run/--offline 时调用本地订阅 codex exec)',
  '  daily-batch        --db <sqlite> --input <daily-batch.json> [--profile <profile.json>] [--output <out.json>] [--as-of <YYYY-MM-DD>]  (日常 80% 站内 + 20% 站外 + 1688 源头厂小批入口，支持滑块暂停续跑)',
  '  single-product     --db <sqlite> --input <asin-or-post.json> [--profile <profile.json>] [--report-dir <dir>] [--output <out.json>] [--as-of <YYYY-MM-DD>]  (单品种子登记、Gate1A/1B/21项评分与 V4 报告导出；兼容别名 single-dive)',
  '  reverse-1688       --db <sqlite> --input <1688-spec.json> [--profile <profile.json>] [--output <out.json>] [--as-of <YYYY-MM-DD>]  (1688 源头厂反向测美亚 30% 保底零售价与深挖)',
  '  profit-check       --input <profit-spec.json> [--output <out.json>]  (无状态，快速 2027 淡季利润体检 + 非 SIPP 合并费 + <=10mm 改盒可救检测)',
  '  openai-recover     --db <sqlite> --credential-file <json> --attempt <id> [--output <out.json>]  (零重复 POST 读取 GET /v1/responses/{id} 断点恢复并补记新用量)',
  '  openai-batch-poll  --db <sqlite> --credential-file <json> (--batch-id <id> | --submit-jsonl <batch.jsonl>) [--attempt <id>] [--download-output] [--output <out.json>]  (Batch API 提交/轮询)',
  '  rate-lookup        --input <rate-spec.json> [--persist-file <supplemental-rates.json>] [--output <out.json>]  (无状态，表外官网费率查证指令与落库助手)',
  '  calibration-track  --db <sqlite> [--input <tracking.json>] [--list] [--batch-id <id>] [--form <form-id>] [--output <out.json>]  (记录/查询四项校准追踪)',
  '',
].join('\n');

const STATELESS_COMMANDS = new Set([
  'price-band',
  'solve-min-price',
  'profit-check',
  'rate-lookup',
  'contact-sheet',
  'openai-batch-build',
  'ingest-trial',
  'sp-api-calibrate',
  'serve-report',
  'redteam-review',
]);
const LIVE_COMMANDS = new Set(['luna-triage', 'openai-task', 'openai-cancel', 'openai-recover', 'openai-batch-poll']);
const OPENAI_DB_COMMANDS = new Set(['openai-status', 'openai-reconcile', ...LIVE_COMMANDS]);
const READ_ONLY_DB_COMMANDS = new Set(['status', 'trace', 'coverage', 'plan-discovery', 'openai-status', 'dedupe-forms', 'funnel-ledger']);

class Phase2CliError extends Error {}

function requireOption(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Phase2CliError(`缺少必填参数 --${label}。`);
  }
  return value.trim();
}

function parseOptionalNonNegNumber(value, label) {
  if (value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Phase2CliError(`参数 --${label} 必须为非负数字。`);
  }
  return n;
}

function parseOptionalNonNegSafeInt(value, label) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(String(value).trim())) {
    throw new Phase2CliError(`参数 --${label} 必须为非负整数。`);
  }
  const n = Number(String(value).trim());
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Phase2CliError(`参数 --${label} 必须为安全非负整数。`);
  }
  return n;
}

function sanitizeCliDisplayPath(rawPath) {
  if (!rawPath || rawPath === ':memory:') return ':memory:';
  const abs = resolve(String(rawPath));
  const rel = relative(resolve(process.cwd()), abs).replace(/\\/g, '/');
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return sanitizeDiagnosticText(rel);
  }
  return `[REDACTED_PATH]/${sanitizeDiagnosticText(basename(abs))}`;
}

function isSamePhysicalFileCli(pathA, pathB) {
  if (!pathA || !pathB || pathA === ':memory:' || pathB === ':memory:') return false;
  const absA = resolve(String(pathA));
  const absB = resolve(String(pathB));
  if (pathKey(absA) === pathKey(absB)) return true;

  const resolveExistingOrParent = p => {
    try { return realpathSync(p); }
    catch {
      try { return join(realpathSync(dirname(p)), basename(p)); }
      catch { return p; }
    }
  };
  const realA = resolveExistingOrParent(absA);
  const realB = resolveExistingOrParent(absB);
  if (pathKey(realA) === pathKey(realB)) return true;

  try {
    if (existsSync(absA) && existsSync(absB)) {
      const stA = statSync(absA, { bigint: true });
      const stB = statSync(absB, { bigint: true });
      if (stA.ino !== 0n && stA.dev === stB.dev && stA.ino === stB.ino) {
        return true;
      }
    }
  } catch { /* ignore stat errors on missing paths */ }
  return false;
}

async function preflightSingleFileDestination(outputPath, protectedPaths = []) {
  const absOut = resolve(outputPath);
  if (existsSync(absOut)) {
    let lstOut;
    let stOut;
    try {
      lstOut = lstatSync(absOut);
      stOut = statSync(absOut);
    } catch (error) {
      throw new Phase2CliError(`无法检查输出路径状态（${ioCode(error)}）。`);
    }
    if (lstOut.isDirectory() || stOut.isDirectory()) {
      throw new Phase2CliError('输出路径指向已存在的目录；请指定具体输出文件路径。');
    }
    if (!stOut.isFile()) {
      throw new Phase2CliError('输出路径不能指向特殊设备、管道或非普通文件。');
    }
  }
  const outDir = dirname(absOut);
  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    throw new Phase2CliError(`无法创建输出目录（${ioCode(error)}）。`);
  }
  const canonicalOutDir = await realpath(outDir);
  let targetKey = pathKey(join(canonicalOutDir, basename(absOut)));
  try {
    targetKey = pathKey(await realpath(absOut));
  } catch { /* file may not exist yet */ }

  for (const p of protectedPaths) {
    if (!p || p === ':memory:') continue;
    if (isSamePhysicalFileCli(absOut, p)) {
      throw new Phase2CliError('输出路径不能覆盖输入、数据包、可执行脚本或图片文件；请选择不同的 --output 路径。');
    }
    let pKey;
    try { pKey = pathKey(await realpath(p)); }
    catch { pKey = pathKey(resolve(p)); }
    if (pKey === targetKey) {
      throw new Phase2CliError('输出路径不能覆盖输入、数据包、可执行脚本或图片文件；请选择不同的 --output 路径。');
    }
  }

  const tmp = join(canonicalOutDir, `.${basename(absOut)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
  } catch (error) {
    throw new Phase2CliError(`无法创建受保护的临时输出文件（${ioCode(error)}）。`);
  }
  return { absOut, tmp, handle, closed: false, cleaned: false };
}

async function cleanupStagedSingleFile(stageState) {
  if (!stageState || stageState.cleaned) return;
  stageState.cleaned = true;
  if (stageState.handle && !stageState.closed) {
    stageState.closed = true;
    try { await stageState.handle.close(); } catch { /* ignore */ }
  }
  if (stageState.tmp) {
    try { await unlink(stageState.tmp); } catch { /* ignore */ }
  }
}

async function commitStagedSingleFile(stageState, bytes) {
  const expectedSha = sha256Hex(bytes);
  try {
    try {
      await stageState.handle.writeFile(bytes);
    } finally {
      if (!stageState.closed) {
        stageState.closed = true;
        await stageState.handle.close();
      }
    }
    await rename(stageState.tmp, stageState.absOut);
    stageState.cleaned = true;
    const readback = await readFile(stageState.absOut);
    const actualSha = sha256Hex(readback);
    if (actualSha !== expectedSha) {
      throw new Error('Output readback SHA-256 mismatch.');
    }
    return actualSha;
  } catch (error) {
    await cleanupStagedSingleFile({ ...stageState, cleaned: false });
    throw new Phase2CliError(`写入输出文件失败（${ioCode(error)}）。`);
  }
}

async function writeSingleFileSafe(outputPath, bytes, protectedPaths = []) {
  const stageState = await preflightSingleFileDestination(outputPath, protectedPaths);
  return commitStagedSingleFile(stageState, bytes);
}

/**
 * Safely read and parse a UTF-8 JSON file without EVER echoing raw file bytes/content in error messages.
 */
async function readJsonFileSafe(absPath, label) {
  let bytes;
  try {
    bytes = await readFile(absPath);
  } catch (error) {
    throw new Phase2CliError(`${label}无法读取（${ioCode(error)}，文件：${basename(absPath)}）。`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Phase2CliError(`${label}不是有效的 UTF-8 编码文件（文件：${basename(absPath)}）。`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Phase2CliError(`${label}不是有效的 JSON 格式（文件：${basename(absPath)}）；请修正后重新运行。`);
  }
}

/**
 * Collision-safe, staged publication matching src/cli.mjs:
 *  - Verifies no output file collides with any input/profile/discovery/db file.
 *  - Stages temp files with 'wx', invalidates older receipt via status:'writing',
 *    atomically renames, verifies readback SHA-256 of both result.json and index.html,
 *    and writes a failure receipt if publication fails mid-way.
 */
async function writeReportArtifacts(outputDir, {
  resultBytes,
  htmlBytes,
  resultSha,
  htmlSha,
  summary,
  profileRevision,
  protectedInputPaths = [],
}) {
  const absOut = resolve(outputDir);
  try {
    await mkdir(absOut, { recursive: true });
  } catch (error) {
    throw new Phase2CliError(`无法创建输出目录（${ioCode(error)}）。`);
  }
  const canonicalOut = await realpath(absOut);
  const protectedKeys = new Set();
  for (const p of protectedInputPaths) {
    if (!p || p === ':memory:') continue;
    try {
      protectedKeys.add(pathKey(await realpath(p)));
    } catch {
      protectedKeys.add(pathKey(resolve(p)));
    }
  }
  for (const name of ['result.json', 'index.html', 'receipt.json']) {
    if (protectedKeys.has(pathKey(join(canonicalOut, name)))) {
      throw new Phase2CliError('输出文件会覆盖输入、评分配置、发现记录或数据库文件；请选择另一个输出目录。');
    }
  }

  const runId = randomUUID();
  const pending = new Set();
  const published = [];
  const files = { 'result.json': resultBytes, 'index.html': htmlBytes };
  const expected = {
    'result.json': { sha256: resultSha, bytes: resultBytes.length },
    'index.html': { sha256: htmlSha, bytes: htmlBytes.length },
  };
  const baseReceipt = {
    schema_version: 1,
    kind: 'phase2_report_export',
    run_id: runId,
    started_at: new Date().toISOString(),
    profile_revision: profileRevision,
    result_sha256: resultSha,
    html_sha256: htmlSha,
    summary,
  };

  const stage = async (name, bytes) => {
    const tmp = join(canonicalOut, `.${name}.${runId}.tmp`);
    const handle = await open(tmp, 'wx');
    pending.add(tmp);
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    return tmp;
  };
  const commit = async (tmp, name) => {
    await rename(tmp, join(canonicalOut, name));
    pending.delete(tmp);
  };
  const writeReceipt = async value => {
    const tmp = await stage('receipt.json', Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    await commit(tmp, 'receipt.json');
  };
  const cleanup = async () => {
    for (const tmp of [...pending]) {
      try { await unlink(tmp); pending.delete(tmp); }
      catch (err) { if (err.code === 'ENOENT') pending.delete(tmp); }
    }
  };

  try {
    const staged = [];
    for (const [name, bytes] of Object.entries(files)) {
      staged.push([name, await stage(name, bytes)]);
    }
    await writeReceipt({ ...baseReceipt, status: 'writing', expected_outputs: expected });
    for (const [name, tmp] of staged) {
      await commit(tmp, name);
      published.push(name);
    }
    const outputs = {};
    for (const name of Object.keys(files)) {
      const actual = await readFile(join(canonicalOut, name));
      outputs[name] = { sha256: sha256Hex(actual), bytes: actual.length };
      if (outputs[name].sha256 !== expected[name].sha256) {
        throw new Error('Output readback SHA-256 does not match staged bytes.');
      }
    }
    await writeReceipt({
      ...baseReceipt,
      status: 'complete',
      completed_at: new Date().toISOString(),
      outputs,
    });
    return {
      output_dir: sanitizeDiagnosticText(canonicalOut),
      result_sha256: resultSha,
      html_sha256: htmlSha,
    };
  } catch (error) {
    await cleanup();
    let failedReceiptWritten = false;
    try {
      await writeReceipt({
        ...baseReceipt,
        status: 'failed',
        failed_at: new Date().toISOString(),
        error_code: ioCode(error),
        published_outputs: published,
        expected_outputs: expected,
        temporary_files_remaining: [...pending].map(p => basename(p)),
      });
      failedReceiptWritten = true;
    } catch {
      await cleanup();
    }
    throw new Phase2CliError(
      `输出未完整写入（${ioCode(error)}）。已发布：${published.join('、') || '无'}；${failedReceiptWritten ? 'receipt.json 已记录失败状态' : '失败收据未能写入，请核对输出目录'}。`,
    );
  }
}

const PUBLIC_LEGACY_STATUS_LABELS = new Set([
  'complete',
  'completed',
  'failed',
  'failed_known',
  'rejected',
  'cancelled',
  'in_progress',
  'pending',
  'pending_recovery',
  'unknown_needs_reconciliation',
  'error',
  'expired',
  'not_submitted',
]);

function sanitizePublicStatusHistogram(rawCounts) {
  const safe = Object.create(null);
  if (!rawCounts || typeof rawCounts !== 'object') return safe;
  for (const [k, v] of Object.entries(rawCounts)) {
    const count = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    if (count === 0) continue;
    const normKey = String(k).trim().toLowerCase();
    const bucket = PUBLIC_LEGACY_STATUS_LABELS.has(normKey) ? normKey : 'unknown';
    safe[bucket] = (safe[bucket] ?? 0) + count;
  }
  return safe;
}

function formatNarrowLegacySummary(leg) {
  if (!leg || typeof leg !== 'object') return null;
  return {
    recognized_schema: Boolean(leg.recognized_schema),
    month_utc: leg.month_utc,
    total_rows: leg.total_rows,
    status_counts: sanitizePublicStatusHistogram(leg.status_counts),
    unresolved_count: leg.unresolved_count,
    has_unresolved_holds: Boolean(leg.has_unresolved_holds),
    same_month_reserved_cents: leg.same_month_reserved_cents,
    total_reserved_cents_all_months: leg.total_reserved_cents_all_months,
  };
}

function formatNarrowLedgerStatus(st) {
  if (!st || typeof st !== 'object') return st;
  const pol = st.policy ?? {};
  const mon = st.monthly ?? {};
  const activeFences = Array.isArray(st.active_fences) ? st.active_fences : [];
  const computedCrossMonthCents = activeFences
    .filter(f => f && f.month_utc && mon.month_utc && f.month_utc !== mon.month_utc)
    .reduce((sum, f) => sum + (Number.isSafeInteger(f.reserved_cents) && f.reserved_cents > 0 ? f.reserved_cents : 0), 0);
  const crossMonthFencedCents = mon.cross_month_fenced_cents ?? mon.prior_month_fenced_cents ?? computedCrossMonthCents;
  const currentMonthCommitted = mon.current_month_committed_cents ?? mon.committed_cents ?? 0;
  const blockingCount = Array.isArray(mon.blocking_attempt_ids)
    ? mon.blocking_attempt_ids.length
    : activeFences.length;

  return {
    read_only: Boolean(st.read_only),
    policy: {
      account_scope: pol.account_scope,
      enabled: Boolean(pol.enabled),
      monthly_limit_cents: pol.monthly_limit_cents,
      same_month_pending_buffer_cents: pol.same_month_pending_buffer_cents ?? 0,
      allow_stage4_media: Boolean(pol.allow_stage4_media),
      auto_recharge_off_confirmed: Boolean(pol.auto_recharge_off_confirmed),
      hard_monthly_limit_confirmed: Boolean(pol.hard_monthly_limit_confirmed),
      legacy_reconciled: Boolean(pol.legacy_reconciled),
      legacy_carryover_cents: pol.legacy_carryover_cents ?? 0,
      legacy_carryover_month: pol.legacy_carryover_month ?? pol.reconciled_snapshot_month_utc ?? null,
      updated_at: pol.updated_at ?? null,
    },
    monthly: {
      account_scope: mon.account_scope,
      month_utc: mon.month_utc,
      monthly_limit_cents: mon.monthly_limit_cents,
      legacy_carryover_cents: mon.legacy_carryover_cents ?? 0,
      current_month_committed_cents: currentMonthCommitted,
      cross_month_fenced_cents: crossMonthFencedCents,
      effective_committed_cents: mon.effective_committed_cents ?? 0,
      same_month_pending_recovery_cents: mon.same_month_pending_recovery_cents ?? 0,
      remaining_cents: mon.remaining_cents ?? 0,
      active_attempt_count: mon.active_attempt_count ?? activeFences.length,
      fenced: Boolean(mon.fenced ?? (activeFences.length > 0)),
      blocking_attempt_count: blockingCount,
    },
  };
}

function enrichBatchAndResultFromStore(boundBatch, store, options = {}) {
  const {
    profileRevision = null,
    profile = null,
    manifest = null,
    feeTableSnapshot = null,
    expectedHtmlSha256 = null,
    currentAttachmentSha256s = null,
    attachmentShasByCandidateId = null,
    verifyReceiptFn = null,
  } = typeof options === 'number' ? { profileRevision: options } : (options ?? {});
  const effectiveRevForSnap = Number(profile?.revision ?? profileRevision ?? boundBatch?.profile_revision ?? 59);
  const effectiveFeeSnapshot = feeTableSnapshot ?? (profile ? getFba2027RateTableSnapshot({ profileRevision: effectiveRevForSnap }) : null);

  const notesByFormId = new Map();
  if (Array.isArray(boundBatch?.candidates)) {
    for (const cand of boundBatch.candidates) {
      if (!cand?.id) continue;
      const form = store.getCandidateForm(cand.id);
      if (form?.lifecycle_status === 'deferred' && !expectedHtmlSha256 && effectiveRevForSnap >= 59) {
        if (!Array.isArray(cand.evidence) || cand.evidence.length === 0) {
          cand.evidence = [{
            id: 'sqlite-lifecycle-deferred',
            source: 'SQLite candidate_forms lifecycle',
            observed_at: (form.updated_at ?? '2026-11-25').slice(0, 10),
          }];
        }
        cand.screening = {
          ...(cand.screening && typeof cand.screening === 'object' ? cand.screening : {}),
          strong_date_dependency: {
            value: true,
            unit: 'boolean',
            evidence: [cand.evidence[0].id],
            reason: 'Synchronized from SQLite lifecycle_status: deferred.',
          },
        };
      }
      if (form?.gate1a_result_json) {
        try {
          attachGate1APriceCliffStress(cand, JSON.parse(form.gate1a_result_json));
        } catch { /* ignore malformed historical JSON */ }
      }
      const evals = store.getEvaluationsForForm(cand.id);

      let expectedBundleSha = null;
      if (form?.spec_sha256 && profile && effectiveFeeSnapshot) {
        try {
          const deterministicCandInput = Object.hasOwn(cand, 'evidence_review')
            ? (() => { const { evidence_review: _adv, ...rest } = cand; return rest; })()
            : cand;
          expectedBundleSha = computeEvidenceBundleHash({
            form_spec_sha256: form.spec_sha256,
            candidate_input: deterministicCandInput,
            discovery_manifest: manifest,
            profile_snapshot: profile,
            fee_table_snapshot: effectiveFeeSnapshot,
          });
        } catch {
          expectedBundleSha = null;
        }
      }

      const matchingBundleEvals = expectedBundleSha
        ? evals.filter(ev => ev.evidence_bundle_sha256 === expectedBundleSha)
        : evals;
      // P1-17: Never fall back to unrelated evidence bundles' review notes when expectedBundleSha was computed!
      const noteSourceEvals = expectedBundleSha ? matchingBundleEvals : evals;

      const seen = new Set();
      const notes = [];
      for (const n of Array.isArray(cand.review_notes) ? cand.review_notes : []) {
        const key = JSON.stringify(n);
        if (!seen.has(key)) { seen.add(key); notes.push(n); }
      }
      for (const ev of noteSourceEvals) {
        if (!ev.review_notes_json) continue;
        try {
          for (const n of JSON.parse(ev.review_notes_json)) {
            const key = JSON.stringify(n);
            if (!seen.has(key)) { seen.add(key); notes.push(n); }
          }
        } catch { /* ignore */ }
      }
      if (notes.length > 0) {
        cand.review_notes = notes;
        notesByFormId.set(cand.id, notes);
      }

      const perCandSuppliedShas = attachmentShasByCandidateId instanceof Map && attachmentShasByCandidateId.has(cand.id)
        ? attachmentShasByCandidateId.get(cand.id)
        : (Array.isArray(currentAttachmentSha256s) ? currentAttachmentSha256s : null);

      const allowStaleSpecR59 = (profileRevision ?? 59) >= 59;
      const verifyAndSanitizeCandidateReview = (parsedEvRev, { fromHistoricalBundle = false } = {}) => {
        if (!parsedEvRev || typeof parsedEvRev !== 'object' || Array.isArray(parsedEvRev)) return null;
        const reviewedSpecSha = typeof parsedEvRev.form_spec_sha256 === 'string' && parsedEvRev.form_spec_sha256.trim()
          ? parsedEvRev.form_spec_sha256.trim()
          : (typeof parsedEvRev.spec_sha256 === 'string' && parsedEvRev.spec_sha256.trim() ? parsedEvRev.spec_sha256.trim() : null);
        const specChanged = Boolean(form?.spec_sha256 && (!reviewedSpecSha || reviewedSpecSha !== form.spec_sha256));
        if (
          parsedEvRev.candidate_id !== cand.id ||
          (specChanged && (!allowStaleSpecR59 || !reviewedSpecSha))
        ) {
          return {
            status: 'unavailable',
            execution_status: 'stale_packet_mismatch',
            advisory_only: true,
            validated_envelope: false,
            candidate_id: cand.id,
            reason: 'Evidence review candidate_id or form_spec_sha256 does not match current candidate specification.',
          };
        }
        const boundShas = Array.isArray(parsedEvRev.attachment_sha256s) ? parsedEvRev.attachment_sha256s : [];
        const attachmentMismatch = boundShas.length > 0
          ? (!perCandSuppliedShas || perCandSuppliedShas.length !== boundShas.length || boundShas.some((h, idx) => h !== perCandSuppliedShas[idx]))
          : (perCandSuppliedShas !== null && perCandSuppliedShas.length > 0);
        if (attachmentMismatch) {
          return {
            status: 'unavailable',
            execution_status: 'stale_packet_mismatch',
            advisory_only: true,
            validated_envelope: false,
            candidate_id: cand.id,
            reason: 'Evidence review requires matching current per-candidate attachment digests on export.',
          };
        }
        let recCheck = null;
        if (typeof verifyReceiptFn === 'function' && parsedEvRev.status === 'ready') {
          recCheck = verifyReceiptFn(parsedEvRev, {
            allowStaleSpec: allowStaleSpecR59,
            currentFormSpecSha256: form?.spec_sha256 ?? null,
            expectedCandidateId: cand.id,
          });
          if (!recCheck || recCheck.verified !== true) {
            return {
              status: 'unavailable',
              execution_status: 'unverified_execution_provenance',
              advisory_only: true,
              validated_envelope: false,
              candidate_id: cand.id,
              reason: sanitizeDiagnosticText(recCheck?.reason || 'Evidence review lacks a verified saved execution receipt.'),
            };
          }
        }
        const stampValidated = recCheck?.verified === true ? { validated_envelope: true } : {};
        if (allowStaleSpecR59 && (specChanged || fromHistoricalBundle || recCheck?.stale_spec || parsedEvRev.stale_spec === true)) {
          return {
            ...parsedEvRev,
            ...stampValidated,
            stale_spec: true,
            reviewed_spec_sha256: recCheck?.reviewed_spec_sha256 ?? reviewedSpecSha,
            ...(reviewedSpecSha ? { spec_sha256: reviewedSpecSha } : {}),
            ...(recCheck?.reviewed_at || parsedEvRev.reviewed_at
              ? { reviewed_at: recCheck?.reviewed_at ?? parsedEvRev.reviewed_at }
              : {}),
          };
        }
        return recCheck?.verified === true ? { ...parsedEvRev, ...stampValidated } : parsedEvRev;
      };

      if (cand.evidence_review !== undefined && cand.evidence_review !== null) {
        // P1-17: Inline `evidence_review` already present in batch.json MUST undergo the exact same binding, attachment, and receipt checks!
        cand.evidence_review = verifyAndSanitizeCandidateReview(cand.evidence_review);
      } else {
        const pickReviewFromEvals = (evalRows) => {
          let foundJson = undefined;
          for (const ev of evalRows) {
            if (expectedHtmlSha256 && ev.receipt_json) {
              try {
                const rec = JSON.parse(ev.receipt_json);
                const matchedReceipt = Array.isArray(rec.batch_receipts)
                  ? rec.batch_receipts.find(b => b.batch_html_sha256 === expectedHtmlSha256)
                  : null;
                if (matchedReceipt && Object.hasOwn(matchedReceipt, 'evidence_review_json')) {
                  foundJson = matchedReceipt.evidence_review_json;
                  continue;
                }
              } catch { /* ignore */ }
            }
            if (ev.evidence_review_json) {
              foundJson = ev.evidence_review_json;
            }
          }
          return foundJson;
        };

        const candidateEvals = (expectedBundleSha ? matchingBundleEvals : evals).filter(
          ev => profileRevision === null || profileRevision === undefined || ev.profile_revision === profileRevision,
        );
        let selectedReviewJson = pickReviewFromEvals(candidateEvals);
        let fromHistoricalBundle = false;
        if (!selectedReviewJson && allowStaleSpecR59 && !expectedHtmlSha256 && evals.length > 0) {
          selectedReviewJson = pickReviewFromEvals(evals);
          if (selectedReviewJson) fromHistoricalBundle = true;
        }

        if (selectedReviewJson) {
          try {
            const parsedEvRev = JSON.parse(selectedReviewJson);
            const verified = verifyAndSanitizeCandidateReview(parsedEvRev, { fromHistoricalBundle });
            if (verified) cand.evidence_review = verified;
          } catch { /* ignore */ }
        }
      }
    }
  }
  const shortlistForms = store.db.prepare(`
    SELECT form_id, lifecycle_status, spec_sha256, label, gate1a_result_json, gate1b_result_json, negotiation_shortlist_json
    FROM candidate_forms
    WHERE negotiation_shortlist_json IS NOT NULL
    ORDER BY form_id ASC
  `).all();
  const storedShortlist = [];
  for (const row of shortlistForms) {
    // Only Gate 1B economically rejected forms where all scenarios fell below 30% may enter negotiation_shortlist;
    // 30%-crossing / gate1b_pending forms never enter the shortlist.
    if (row.lifecycle_status !== 'gate1b_rejected') continue;
    let g1b = null;
    try {
      g1b = row.gate1b_result_json ? JSON.parse(row.gate1b_result_json) : null;
    } catch { g1b = null; }
    if (!g1b || g1b.margin_interval_verdict !== 'all_below_30pct') continue;
    if (g1b.spec_sha256 && g1b.spec_sha256 !== row.spec_sha256) continue;
    let hasRights = false;
    for (const raw of [row.gate1a_result_json, row.gate1b_result_json]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.specific_rights_conflict_proven === true && (!parsed.spec_sha256 || parsed.spec_sha256 === row.spec_sha256)) {
          hasRights = true;
        }
      } catch { /* ignore */ }
    }
    if (hasRights) continue;
    try {
      const neg = JSON.parse(row.negotiation_shortlist_json);
      const disc = neg?.required_discount_fraction ?? neg?.required_reduction_fraction;
      if (neg && neg.eligible === true && typeof disc === 'number' && Number.isFinite(disc) && disc > 0 && disc <= 0.12) {
        storedShortlist.push({
          ...neg,
          form_id: row.form_id,
          label: row.label,
        });
      }
    } catch { /* ignore */ }
  }
  const packagingForms = store.db.prepare(`
    SELECT form_id, lifecycle_status, spec_sha256, label, gate1a_result_json, gate1b_result_json, packaging_redesign_shortlist_json
    FROM candidate_forms
    WHERE packaging_redesign_shortlist_json IS NOT NULL
    ORDER BY form_id ASC
  `).all();
  const storedPackagingShortlist = [];
  for (const row of packagingForms) {
    if (row.lifecycle_status !== 'gate1b_rejected') continue;
    let g1b = null;
    try {
      g1b = row.gate1b_result_json ? JSON.parse(row.gate1b_result_json) : null;
    } catch { g1b = null; }
    if (!g1b || g1b.margin_interval_verdict !== 'all_below_30pct') continue;
    if (g1b.spec_sha256 && g1b.spec_sha256 !== row.spec_sha256) continue;
    let hasRights = false;
    for (const raw of [row.gate1a_result_json, row.gate1b_result_json]) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.specific_rights_conflict_proven === true && (!parsed.spec_sha256 || parsed.spec_sha256 === row.spec_sha256)) {
          hasRights = true;
        }
      } catch { /* ignore */ }
    }
    if (hasRights) continue;
    try {
      const pkg = JSON.parse(row.packaging_redesign_shortlist_json);
      const trimM = pkg?.redesigned_margin ?? pkg?.trimmed_margin;
      if (
        pkg &&
        pkg.eligible === true &&
        typeof pkg.overshoot_mm === 'number' &&
        Number.isFinite(pkg.overshoot_mm) &&
        pkg.overshoot_mm > 0 &&
        pkg.overshoot_mm <= 10.0001 &&
        typeof trimM === 'number' &&
        Number.isFinite(trimM) &&
        trimM >= 0.30
      ) {
        storedPackagingShortlist.push({
          ...pkg,
          redesigned_margin: trimM,
          trimmed_margin: trimM,
          form_id: row.form_id,
          label: row.label,
        });
      }
    } catch { /* ignore */ }
  }
  return { notesByFormId, storedShortlist, storedPackagingShortlist };
}

function runPythonContactSheet({ inputPath, outputPath, manifestOut, title, offline }) {
  const pyArgs = [
    CONTACT_SHEET_SCRIPT,
    '--input', resolve(inputPath),
    '--output', resolve(outputPath),
  ];
  if (manifestOut) pyArgs.push('--manifest-out', resolve(manifestOut));
  if (title) pyArgs.push('--title', title);
  if (offline) pyArgs.push('--offline');

  const env = { ...process.env, PYTHONUTF8: '1' };
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  let lastRes = null;
  for (const bin of candidates) {
    const res = spawnSync(bin, pyArgs, { encoding: 'utf8', env });
    if (!res.error || res.error.code !== 'ENOENT') {
      lastRes = res;
      break;
    }
  }
  if (!lastRes) {
    throw new Phase2CliError('未找到可用的 Python 3 解释器（python / python3）。');
  }
  if (lastRes.status !== 0) {
    const detail = sanitizeDiagnosticText((lastRes.stderr || lastRes.stdout || 'contact-sheet 脚本执行失败').trim());
    throw new Phase2CliError(`contact-sheet 渲染失败：${detail}`);
  }
  const stdoutText = (lastRes.stdout || '').trim();
  try {
    return JSON.parse(stdoutText);
  } catch {
    return { ok: true, raw_output: sanitizeDiagnosticText(stdoutText) };
  }
}

function sqlitePaths(path) {
  return path && path !== ':memory:' ? [path, path + '-wal', path + '-shm', path + '-journal'] : [];
}

function checkOperatorPayload(value) {
  if (containsSecretToken(value)) throw new Phase2CliError('输入或回执含有凭据标记，请使用已脱敏的数据。');
  assertNoRawPii(value, 'operator data');
}

function workflowSearchOptions(task, rawCap) {
  const maxToolCalls = parseOptionalNonNegSafeInt(rawCap, 'max-tool-calls');
  if (maxToolCalls === undefined) return {};
  if (maxToolCalls < 1 || task !== 'rights-prescreen') throw new Phase2CliError('--max-tool-calls 仅适用于权利预筛，且必须大于零。');
  return { maxToolCalls };
}

function spendReceipt(ledger, attemptId, accountScope) {
  const row = ledger.getAttemptById(attemptId, { accountScope });
  if (!row) return null;
  return {
    attempt_id: row.attempt_id, logical_request_id: row.logical_request_id, provider_response_id: row.provider_response_id,
    model: row.model, status: row.status, content_status: row.content_status, cleanup_status: row.cleanup_status,
    reserved_cents: row.reserved_cents, usage_cost_micros: row.usage_cost_micros, posted_billed_cents: row.posted_billed_cents,
    input_tokens: row.usage?.input_tokens ?? null, output_tokens: row.usage?.output_tokens ?? null,
    reasoning_tokens: row.usage?.output_tokens_details?.reasoning_tokens ?? null,
    web_search_calls: row.usage?.web_search_calls ?? (row.endpoint === '/v1/decisions' ? 0 : null),
  };
}

async function runLiveCommand(command, values, streams, dbPath, budgetDbPath, accountScope, testHooks) {
  if (values.offline || values['dry-run']) throw new Phase2CliError('该命令执行实时请求，不能与离线参数一起使用。');
  const isTestRun = Boolean(
    testHooks?.testLedgerOptions?.testMode === true ||
    testHooks?.openAiClientOptions?.testMode === true,
  );
  if (!isTestRun && process.env.OPENAI_ALLOW_CUSTOM_BUDGET_DB_FOR_TESTS !== '1') {
    if (budgetDbPath === ':memory:') {
      throw new Phase2CliError('实时付费 OpenAI 命令禁止使用 :memory: 临时预算账本；请绑定仓库唯一持久化主账本 .local/state/selection.sqlite。');
    }
    if (pathKey(budgetDbPath) !== pathKey(REPO_CANONICAL_BUDGET_DB)) {
      throw new Phase2CliError(
        `实时付费 OpenAI 命令必须绑定账户唯一主预算账本（${sanitizeDiagnosticText(REPO_CANONICAL_BUDGET_DB)}），禁止使用其他目录或副账本重置 $200 自然月累计额度；如需将选品结果写入独立候选库，请同时传入 --budget-db 指向上述主预算账本。`,
      );
    }
  }
  const credentialFile = resolve(requireOption(values['credential-file'], 'credential-file'));
  const submitJsonlPath = command === 'openai-batch-poll' && values['submit-jsonl']
    ? resolve(values['submit-jsonl'])
    : null;
  const inputPath = (command === 'openai-cancel' || command === 'openai-recover' || command === 'openai-batch-poll')
    ? null
    : command === 'luna-triage'
      ? resolve(requireOption(values.listings, 'listings'))
      : resolve(requireOption(values.input, 'input'));
  const output = (command === 'openai-cancel' || command === 'openai-recover' || command === 'openai-batch-poll')
    ? values.output
    : requireOption(values.output, 'output');
  const sheet = values['contact-sheet'] && resolve(values['contact-sheet']);
  const progress = values['progress-file'] && resolve(values['progress-file']);
  const inputs = [credentialFile, inputPath, submitJsonlPath, sheet].filter(Boolean);
  const allProtectedSqlitePaths = [...new Set([...sqlitePaths(dbPath), ...sqlitePaths(budgetDbPath)])];
  if (inputs.some(p => allProtectedSqlitePaths.some(s => isSamePhysicalFileCli(p, s))) ||
      [inputPath, submitJsonlPath, sheet].some(p => isSamePhysicalFileCli(p, credentialFile))) throw new Phase2CliError('凭据、输入与数据库需要各自独立的路径。');
  const input = inputPath && await readJsonFileSafe(inputPath, '任务输入文件');
  if (input) checkOperatorPayload(input);
  const ledger = openOpenAiBudgetLedger(budgetDbPath, testHooks?.testLedgerOptions);
  let stage;
  try {
    const protectedPaths = [...allProtectedSqlitePaths, ...sqlitePaths(ledger._effectiveRegistryPath), ...inputs];
    if (output) stage = await preflightSingleFileDestination(output, [...protectedPaths, progress]);
    if (progress) {
      const progressStage = await preflightSingleFileDestination(progress, [...protectedPaths, output]);
      await cleanupStagedSingleFile(progressStage);
    }
    const client = new OpenAiClient({ ...testHooks?.openAiClientOptions, ledger, credentialFile });
    const policy = { accountScope, maxRetries: 0 };
    let result, receipts, ok;
    if (command === 'openai-recover') {
      const attemptRef = requireOption(values.attempt, 'attempt');
      const recovered = await client.recoverPendingResponse(attemptRef, policy);
      const resolvedAttemptId = recovered?.attempt?.attempt_id ?? attemptRef;
      const receipt = spendReceipt(ledger, resolvedAttemptId, accountScope);
      result = {
        recovered: recovered.recovered === true,
        already_settled: recovered.already_settled === true,
        fenced: recovered.fenced === true,
        response_status: recovered.status ?? receipt?.status ?? null,
        receipt,
      };
      ok = recovered.recovered === true && ['completed', 'failed_known', 'rejected'].includes(receipt?.status ?? recovered.status);
    } else if (command === 'openai-batch-poll') {
      if (submitJsonlPath) {
        const jsonlText = await readFile(submitJsonlPath, 'utf8');
        checkOperatorPayload(jsonlText);
        const uploaded = await client.uploadBatchFile({ jsonlText }, policy);
        const logicalId = 'cli-batch-' + sha256Hex(canonicalJson([accountScope, uploaded.file_id, sha256Hex(jsonlText)]));
        const submitted = await client.submitBatch({
          input_file_id: uploaded.file_id,
          endpoint: '/v1/responses',
          completion_window: '24h',
          jsonlText,
        }, { ...policy, logicalRequestId: logicalId });
        const attempt = ledger.getAttemptByLogicalId(logicalId, { accountScope });
        const receipt = attempt ? spendReceipt(ledger, attempt.attempt_id, accountScope) : null;
        result = {
          mode: 'submitted',
          file_id: uploaded.file_id,
          batch_id: submitted.batch_id ?? submitted.id ?? null,
          batch_status: submitted.batch_status ?? submitted.status ?? null,
          receipt,
        };
        ok = Boolean(result.batch_id);
      } else {
        const batchId = requireOption(values['batch-id'], 'batch-id');
        const pollPolicy = {
          ...policy,
          ...(values.attempt ? { attemptId: values.attempt.trim() } : {}),
          downloadOutput: values['download-output'] === true,
        };
        const polled = await client.retrieveBatch(batchId, pollPolicy);
        const receipt = values.attempt ? spendReceipt(ledger, values.attempt.trim(), accountScope) : null;
        result = {
          mode: 'polled',
          batch_id: polled.batch_id ?? batchId,
          batch_status: polled.batch_status ?? polled.status ?? null,
          already_settled: polled.already_settled === true,
          ...(polled.parsed_output ? { parsed_output_count: Array.isArray(polled.parsed_output.items) ? polled.parsed_output.items.length : null, parsed_output: polled.parsed_output } : {}),
          ...(receipt ? { receipt } : {}),
        };
        ok = polled.ok !== false;
      }
    } else if (command === 'openai-cancel') {
      const attemptId = requireOption(values.attempt, 'attempt');
      let response;
      try {
        response = await client.cancelResponse(attemptId, policy);
      } catch (error) {
        if (error.attempt_id !== attemptId || error.not_dispatched ||
            ledger.getAttemptById(attemptId, { accountScope })?.status !== 'pending_recovery') throw error;
        response = { status: 'pending_recovery', error_code: error.code };
      }
      const receipt = spendReceipt(ledger, attemptId, accountScope);
      result = { response_status: response.response_status ?? response.status, receipt,
        ...(response.error_code ? { error_code: response.error_code } : {}) };
      ok = ['completed','failed_known'].includes(receipt?.status);
    } else if (command === 'openai-task') {
      const task = requireOption(values.task, 'task');
      if (!Object.hasOwn(WORKFLOW_RESPONSES_TASKS, task)) throw new Phase2CliError('未知 Terra 任务。');
      const requestOptions = workflowSearchOptions(task, values['max-tool-calls']);
      const background = task === 'rights-prescreen' || values.background === true;
      if (progress && !background) throw new Phase2CliError('--progress-file 需要后台任务。');
      Object.assign(policy, { background, deleteAfterPersist: values['delete-after'] === true,
        ...(progress ? { progressFile: progress } : {}) });
      const taskResult = await runOptionalTerraWorkflowTask(task, input, {
        enabled: true, requestOptions,
        responseExecutor: async request => {
          policy.logicalRequestId = 'cli-task-' + sha256Hex(canonicalJson([accountScope, task, request, background, policy.deleteAfterPersist]));
          const prior = ledger.getAttemptByLogicalId(policy.logicalRequestId, { accountScope });
          if (background && prior?.provider_response_id) {
            return client.pollBackgroundResponse({ ...policy, attemptId: prior.attempt_id });
          }
          return client.createResponse(request, policy);
        },
      });
      const attempt = policy.logicalRequestId && ledger.getAttemptByLogicalId(policy.logicalRequestId, { accountScope });
      result = { ...taskResult, receipt: attempt ? spendReceipt(ledger, attempt.attempt_id, accountScope) : null };
      ok = taskResult.status === 'ready';
    } else {
      const listings = Array.isArray(input) ? input : input?.listings ?? input?.candidates ?? input?.items;
      if (!Array.isArray(listings) || !listings.length || listings.length > (sheet ? 16 : 200)) {
        throw new Phase2CliError('Luna 需要 1 至 200 行候选；单张 4×4 联系表最多 16 行。');
      }
      const detail = values.detail ?? 'high';
      if (!['low','high','auto'].includes(detail)) throw new Phase2CliError('--detail 必须为 low、high 或 auto。');
      const sheetBytes = sheet ? await readFile(sheet) : null;
      const candidates = listings.map((row, i) => ({ ...row, candidate_id: row.candidate_id ?? row.asin ?? row.id,
        ...(sheet ? { tile_index: row.tile_index ?? row.idx ?? i + 1 } : {}) }));
      policy.logicalRequestId = 'cli-triage-' + sha256Hex(canonicalJson([accountScope, candidates, input.target_spec ?? null,
        sheetBytes && sha256Hex(sheetBytes), detail, input.gate0_options ?? {}]));
      const triage = await runOptionalStage12LunaTriage({ enabled: true, client, policy, candidates,
        contactSheetDataUrl: sheetBytes ? 'data:image/png;base64,' + sheetBytes.toString('base64') : null,
        imageDetail: detail, targetSpec: input.target_spec, gate0Config: input.gate0_options });
      const peerIds = new Set(triage.triage?.items.filter(r => r.gate0_status === 'allowed' && r.visual_cluster === 'exact_peer')
        .map(r => r.candidate_id));
      const peers = candidates.filter(r => peerIds.has(r.candidate_id)).map(r => ({ ...r, asin: r.asin ?? r.candidate_id }));
      const bandOptions = { ...input.options, gate0_config: input.gate0_options ?? input.options?.gate0_config };
      const analysis = analyzeMainstreamPriceBand(peers, bandOptions);
      const tightened_clusters = peers.length ? tightenClusterBands(analysis, [{ cluster_id: 'exact_peer', asins: peers.map(p => p.asin) }], bandOptions) : null;
      receipts = [];
      for (let i = 0; i < triage.request_count; i++) {
        const row = ledger.getAttemptByLogicalId(policy.logicalRequestId + '-chunk-' + (i + 1), { accountScope });
        if (row) receipts.push(spendReceipt(ledger, row.attempt_id, accountScope));
      }
      result = { ...triage, analysis, tightened_clusters, receipts };
      ok = triage.status === 'ready';
    }
    const out = { ok, command, ...result };
    checkOperatorPayload(out);
    if (stage) await commitStagedSingleFile(stage, Buffer.from(JSON.stringify(out, null, 2) + '\n'));
    streams.stdout.write(JSON.stringify(output ? { ok, command, output: sanitizeCliDisplayPath(output),
      ...(result.receipt ? { receipt: result.receipt } : {}), ...(receipts ? { receipts } : {}),
      ...(result.progress_error ? { progress_error: result.progress_error } : {}),
      ...(result.reason ? { reason: result.reason } : {}) } : out, null, 2) + '\n');
    return ok ? 0 : 2;
  } finally {
    await cleanupStagedSingleFile(stage);
    ledger.close();
  }
}

export async function runPhase2Cli(
  args = process.argv.slice(2),
  streams = { stdout: process.stdout, stderr: process.stderr },
  testHooks = null,
) {
  try {
    const command = args[0];
    if (!command || command === '--help' || command === '-h') {
      streams.stdout.write(USAGE);
      return 0;
    }

    const rest = args.slice(1);
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: false,
        options: {
          db: { type: 'string' },
          input: { type: 'string' },
          output: { type: 'string' },
          'manifest-out': { type: 'string' },
          title: { type: 'string' },
          offline: { type: 'boolean' },
          budget: { type: 'string' },
          recovery: { type: 'string', multiple: true },
          ledger: { type: 'string', multiple: true },
          assets: { type: 'string' },
          batch: { type: 'string' },
          profile: { type: 'string' },
          discovery: { type: 'string' },
          'verify-result': { type: 'string' },
          'verify-html': { type: 'string' },
          'login-verified': { type: 'boolean' },
          'reconcile-crashed': { type: 'boolean' },
          city: { type: 'string' },
          quantity: { type: 'string' },
          sku: { type: 'string' },
          validity: { type: 'string' },
          'as-of': { type: 'string' },
          form: { type: 'string' },
          'profile-revision': { type: 'string' },
          attempt: { type: 'string' },
          status: { type: 'string' },
          note: { type: 'string' },
          'sif-units': { type: 'string' },
          'ss-mcp-units': { type: 'string' },
          'ss-web-units': { type: 'string' },
          'exa-calls': { type: 'string' },
          'exa-units': { type: 'string' },
          'confirmed-zero-charge': { type: 'boolean' },
          'legacy-budget': { type: 'string' },
          enable: { type: 'boolean' },
          disable: { type: 'boolean' },
          'confirm-auto-recharge-off': { type: 'boolean' },
          'confirm-hard-limit': { type: 'boolean' },
          'monthly-limit-cents': { type: 'string' },
          'same-month-pending-buffer-cents': { type: 'string' },
          'credential-file': { type: 'string' },
          'contact-sheet': { type: 'string' },
          'progress-file': { type: 'string' },
          'max-tool-calls': { type: 'string' },
          'delete-after': { type: 'boolean' },
          background: { type: 'boolean' },
          detail: { type: 'string' },
          listings: { type: 'string' },
          since: { type: 'string' },
          'account-scope': { type: 'string' },
          month: { type: 'string' },
          'usage-cost-micros': { type: 'string' },
          'posted-billed-cents': { type: 'string' },
          'provider-response-id': { type: 'string' },
          'allow-stage4-media': { type: 'boolean' },
          'disallow-stage4-media': { type: 'boolean' },
          task: { type: 'string' },
          packet: { type: 'string' },
          model: { type: 'string' },
          effort: { type: 'string' },
          'service-tier': { type: 'string' },
          'form-spec-sha256': { type: 'string' },
          image: { type: 'string', multiple: true },
          'dry-run': { type: 'boolean' },
          'allow-synthetic': { type: 'boolean' },
          'codex-bin': { type: 'string' },
          'budget-db': { type: 'string' },
          force: { type: 'boolean' },
          dir: { type: 'string' },
          port: { type: 'string' },
          once: { type: 'boolean' },
          check: { type: 'boolean' },
          'batch-id': { type: 'string' },
          'submit-jsonl': { type: 'string' },
          'download-output': { type: 'boolean' },
          'persist-file': { type: 'string' },
          'report-dir': { type: 'string' },
          list: { type: 'boolean' },
        },
      });
    } catch {
      throw new Phase2CliError(`参数无效。\n${USAGE.trim()}`);
    }

    const { values } = parsed;

    // Stateless commands that do not require SQLite.
    if (STATELESS_COMMANDS.has(command)) {
      if (command === 'profit-check') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(inputPath, '快速利润体检输入文件');
        checkOperatorPayload(spec);
        const healthcheck = runFastProfitHealthcheck2027(spec);
        const out = { ok: true, command, healthcheck };
        checkOperatorPayload(out);
        const json = `${stringifyCliJson(out)}\n`;
        if (values.output) {
          await writeSingleFileSafe(resolve(values.output), Buffer.from(json, 'utf8'), [inputPath]);
        }
        streams.stdout.write(json);
        return 0;
      }

      if (command === 'rate-lookup') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(inputPath, '表外官网费率查证输入文件');
        checkOperatorPayload(spec);
        const persistPath = values['persist-file'] ? resolve(values['persist-file']) : null;
        let out;
        if (typeof spec?.official_source_url === 'string' && spec.official_source_url.trim()) {
          const registered = registerSupplementalOutOfTableRule2027(spec, {
            test_price_usd: spec.test_price_usd ?? null,
          });
          let persistedFileSha = null;
          if (persistPath) {
            let existingRegistry = { schema_version: 1, rules: {} };
            if (existsSync(persistPath)) {
              const rawPrev = await readJsonFileSafe(persistPath, '表外费率沉淀文件');
              if (rawPrev && typeof rawPrev === 'object' && !Array.isArray(rawPrev)) {
                existingRegistry = {
                  schema_version: 1,
                  rules: rawPrev.rules && typeof rawPrev.rules === 'object' ? { ...rawPrev.rules } : {},
                };
              }
            }
            existingRegistry.rules[registered.rule.canonical_key] = registered.rule;
            persistedFileSha = await writeSingleFileSafe(
              persistPath,
              Buffer.from(`${JSON.stringify(existingRegistry, null, 2)}\n`, 'utf8'),
              [inputPath],
            );
          }
          out = {
            ok: true,
            command,
            mode: 'verified_rule_registered',
            rule: registered.rule,
            ...(registered.sample_referral_calculation ? { sample_referral_calculation: registered.sample_referral_calculation } : {}),
            ...(persistPath ? {
              persisted_file: sanitizeCliDisplayPath(persistPath),
              persisted_sha256: persistedFileSha,
            } : {}),
          };
        } else {
          out = {
            ok: true,
            command,
            mode: 'lookup_directive',
            directive: buildOutOfTableLookupDirective({
              reason: spec?.reason ?? 'Category or tiered referral schedule not yet in local 2027 rate table.',
              fee_category: spec?.fee_category ?? null,
              asin: spec?.asin ?? spec?.comparable_asin ?? null,
            }),
          };
        }
        checkOperatorPayload(out);
        const json = `${JSON.stringify(out, null, 2)}\n`;
        if (values.output) {
          await writeSingleFileSafe(
            resolve(values.output),
            Buffer.from(json, 'utf8'),
            [inputPath, ...(persistPath ? [persistPath] : [])],
          );
        }
        streams.stdout.write(json);
        return 0;
      }
      if (command === 'ingest-trial') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const profilePath = resolve(requireOption(values.profile, 'profile'));
        const spec = await readJsonFileSafe(inputPath, '试跑摄入规格文件');
        const profile = await readJsonFileSafe(profilePath, '评分配置文件');
        const {
          raw_receipt_files: _rf,
          expected_raw_sha256s: _er,
          non_ledger_auxiliary_files: _na,
          ledger_db_path: _ld,
          ...specBodyRaw
        } = spec ?? {};
        const sanitizedCandidates = Array.isArray(specBodyRaw.candidates)
          ? specBodyRaw.candidates.map(entry => {
              if (!entry || typeof entry !== 'object') return entry;
              const { raw_receipt_files: _crf, ...restEntry } = entry;
              return restEntry;
            })
          : specBodyRaw.candidates;
        checkOperatorPayload({ ...specBodyRaw, candidates: sanitizedCandidates });
        const rawReceiptPaths = Array.isArray(spec?.raw_receipt_files)
          ? spec.raw_receipt_files.map(fp => resolve(dirname(inputPath), String(fp)))
          : [];
        const optLedgerDb = values.db && values.db !== ':memory:' ? resolve(values.db) : null;
        const {
          batch,
          scored,
          verified_raw_asin_count,
          per_candidate_verified_asin_counts,
          verified_receipt_sha256s,
          isolated_candidates,
        } = ingestTrialSpecification(
          spec,
          profile,
          {
            baseDir: dirname(inputPath),
            allowSyntheticWithoutReceipts: values['allow-synthetic'] === true,
            ledgerDbPath: optLedgerDb,
          },
        );
        checkOperatorPayload(batch);
        let outSha = null;
        if (values.output) {
          const outPath = resolve(values.output);
          outSha = await writeSingleFileSafe(
            outPath,
            Buffer.from(`${JSON.stringify(batch, null, 2)}\n`, 'utf8'),
            [inputPath, profilePath, ...(optLedgerDb ? [optLedgerDb] : []), ...rawReceiptPaths],
          );
        }
        const out = {
          ok: true,
          command,
          profile_revision: scored.profile_revision,
          verified_raw_asin_count,
          per_candidate_verified_asin_counts,
          verified_receipt_count: Object.keys(verified_receipt_sha256s ?? {}).length,
          isolated_candidates: Array.isArray(isolated_candidates) ? isolated_candidates : [],
          summary: scored.summary,
          ...(values.output ? {
            output_path: sanitizeCliDisplayPath(values.output),
            output_sha256: outSha,
          } : {}),
        };
        streams.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return 0;
      }

      if (command === 'solve-min-price') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(inputPath, '定价输入文件');
        const { quote, mature_price_band, ...assumptions } = spec;
        if (quote && assumptions.fx_cny_per_usd != null && quote.fx_cny_per_usd != null &&
            assumptions.fx_cny_per_usd !== quote.fx_cny_per_usd) throw new Phase2CliError('场景汇率与报价汇率不一致。');
        const solution = solveMinPriceForMargin2027({ ...assumptions,
          min_retail_price_usd: Math.max(29.99, assumptions.min_retail_price_usd ?? 29.99),
          ...(quote ? { landed_domestic_quote: quote, fx_cny_per_usd: quote.fx_cny_per_usd ?? assumptions.fx_cny_per_usd } : {}),
        });
        const price = solution.feasible_min_price_usd ?? null;
        const band = mature_price_band?.regular_band_reference ?? mature_price_band?.band ?? mature_price_band;
        const comparable = Number.isFinite(price) && Number.isFinite(band?.p25_usd) &&
          Number.isFinite(band?.p75_usd) && band.p25_usd > 0 && band.p25_usd <= band.p75_usd;
        const comparison = comparable ? (price < band.p25_usd ? 'below_band' : price > band.p75_usd ? 'above_band' : 'within_band') : null;
        const out = { ok: true, command, solution, min_retail_price_for_30pct_usd: solution.margin_floor === 0.30 ? price : null,
          mature_band_comparison: comparison };
        const json = JSON.stringify(out, null, 2) + '\n';
        if (values.output) await writeSingleFileSafe(values.output, Buffer.from(json), [inputPath]);
        streams.stdout.write(json);
        return 0;
      }
      if (command === 'price-band') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const payload = await readJsonFileSafe(inputPath, '价位带输入文件');
        const rawListings = Array.isArray(payload) ? payload : payload.listings;
        let extraKeepaPayloads = Array.isArray(payload?.keepa_receipts) ? [...payload.keepa_receipts] : [];
        if (Array.isArray(payload?.raw_receipt_files)) {
          for (const relFp of payload.raw_receipt_files) {
            extraKeepaPayloads.push(await readJsonFileSafe(resolve(dirname(inputPath), String(relFp)), 'Keepa 原始回执'));
          }
        }
        const listings = extraKeepaPayloads.length > 0
          ? mergeKeepaPayloadsIntoPeerListings(rawListings, extraKeepaPayloads, { as_of_date: payload?.options?.as_of_date ?? null })
          : rawListings;
        const pbRev = values['profile-revision'] !== undefined
          ? Number(values['profile-revision'])
          : (payload?.profile_revision ?? payload?.options?.profile_revision);
        if (pbRev !== undefined && (!Number.isInteger(pbRev) || pbRev < 59)) {
          throw new Phase2CliError('--profile-revision 必须为 >= 59 的整数（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
        }
        const gate0Opts = {
          ...(payload?.gate0_options ?? payload?.options?.gate0_config ?? {}),
          ...(pbRev !== undefined ? { profile_revision: pbRev } : {}),
        };
        const bandOpts = {
          ...(payload?.options ?? {}),
          ...(pbRev !== undefined ? { profile_revision: pbRev } : {}),
        };
        const gate0 = payload?.category_check
          ? evaluateGate0CategoryBoundary(payload.category_check, gate0Opts)
          : null;
        const analysis = analyzeMainstreamPriceBand(listings, bandOpts);
        const tightened = Array.isArray(payload?.clusters) && payload.clusters.length > 0
          ? tightenClusterBands(analysis, payload.clusters, bandOpts)
          : null;
        const out = {
          ok: true,
          command,
          ...(gate0 ? { gate0 } : {}),
          analysis,
          ...(tightened ? { tightened_clusters: tightened } : {}),
        };
        if (values.output) {
          const outPath = resolve(values.output);
          await writeSingleFileSafe(outPath, Buffer.from(`${JSON.stringify(out, null, 2)}\n`, 'utf8'), [inputPath]);
        }
        streams.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return 0;
      }

      if (command === 'contact-sheet') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const outputPath = resolve(requireOption(values.output, 'output'));
        const manifestOut = values['manifest-out'] ? resolve(values['manifest-out']) : null;
        if (pathKey(outputPath) === pathKey(inputPath) || (manifestOut && pathKey(manifestOut) === pathKey(inputPath))) {
          throw new Phase2CliError('联系表输出或清单路径不能覆盖输入文件；请选择不同的输出路径。');
        }
        const rendered = runPythonContactSheet({
          inputPath,
          outputPath,
          manifestOut,
          title: values.title ?? null,
          offline: values.offline === true,
        });
        streams.stdout.write(`${JSON.stringify({ ok: true, command, rendered }, null, 2)}\n`);
        return 0;
      }

      if (command === 'sp-api-calibrate') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(inputPath, 'SP-API 终审校参输入文件');
        const calibration = extractSpApiFinalistCalibration({
          asin: spec.asin ?? null,
          marketplace_id: spec.marketplace_id ?? spec.marketplaceId ?? 'ATVPDKIKX0DER',
          currency: spec.currency ?? 'USD',
          catalogItemRaw: spec.catalogItemRaw ?? spec.catalog_item ?? spec.catalogItem ?? null,
          feesEstimateRaw: spec.feesEstimateRaw ?? spec.fees_estimate ?? spec.feesEstimate ?? null,
          restrictionsRaw: spec.restrictionsRaw ?? spec.listings_restrictions ?? spec.listingsRestrictions ?? null,
          sellerSpriteCachedRow: spec.sellerSpriteCachedRow ?? spec.seller_sprite_pkg ?? spec.sellerSpritePkg ?? null,
          price_usd: spec.price_usd ?? spec.priceUsd ?? null,
          target_is_own_white_label: spec.target_is_own_white_label !== false,
        });
        const out = { ok: true, command, calibration };
        const json = `${JSON.stringify(out, null, 2)}\n`;
        if (values.output) {
          await writeSingleFileSafe(resolve(values.output), Buffer.from(json, 'utf8'), [inputPath]);
        }
        streams.stdout.write(json);
        return 0;
      }

      if (command === 'serve-report') {
        const rawDir = values.dir ?? values.input;
        const rootDir = resolve(requireOption(rawDir, 'dir'));
        let rootReal;
        try {
          const st = statSync(rootDir);
          if (!st.isDirectory()) throw new Phase2CliError('--dir 必须指向已导出的报告目录。');
          rootReal = realpathSync(rootDir);
        } catch (err) {
          if (err instanceof Phase2CliError) throw err;
          throw new Phase2CliError(`无法读取报告目录（${ioCode(err)}）。`);
        }
        const requestedPort = values.port !== undefined
          ? Number(values.port)
          : (values.check === true || values.once === true ? 0 : 4178);
        if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
          throw new Phase2CliError('--port 必须为 0..65535 的整数。');
        }
        const mimeByExt = {
          '.html': 'text/html; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.css': 'text/css; charset=utf-8',
        };
        let servedCount = 0;
        const server = createServer((req, res) => {
          try {
            const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
            const relPath = decodeURIComponent(urlObj.pathname === '/' ? '/index.html' : urlObj.pathname).replace(/^\/+/, '');
            const candidatePath = resolve(rootReal, relPath || 'index.html');
            const realTarget = realpathSync(candidatePath);
            const relCheck = relative(rootReal, realTarget);
            if (relCheck.startsWith('..') || isAbsolute(relCheck) || !statSync(realTarget).isFile()) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Not Found');
              return;
            }
            const ext = extname(realTarget).toLowerCase();
            const body = readFileSync(realTarget);
            res.writeHead(200, {
              'Content-Type': mimeByExt[ext] ?? 'application/octet-stream',
              'Cache-Control': 'no-store',
            });
            res.end(body);
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
          } finally {
            servedCount += 1;
            if (values.once === true && servedCount >= 1) {
              setImmediate(() => server.close());
            }
          }
        });
        await new Promise((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(requestedPort, '127.0.0.1', () => {
            server.removeListener('error', rejectListen);
            resolveListen();
          });
        });
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
        const previewUrl = `http://127.0.0.1:${actualPort}/index.html`;
        if (values.check === true) {
          try {
            const resp = await fetch(previewUrl);
            const textBody = await resp.text();
            if (resp.status !== 200 || !textBody.includes('<html')) {
              throw new Phase2CliError(`本地预览自检失败（HTTP ${resp.status}）。`);
            }
            streams.stdout.write(`${JSON.stringify({
              ok: true,
              command,
              url: previewUrl,
              port: actualPort,
              verified_http_status: resp.status,
              byte_length: Buffer.byteLength(textBody, 'utf8'),
            }, null, 2)}\n`);
            return 0;
          } finally {
            await new Promise(r => server.close(() => r()));
          }
        }
        streams.stdout.write(`${JSON.stringify({
          ok: true,
          command,
          url: previewUrl,
          port: actualPort,
          root_dir: sanitizeCliDisplayPath(rootDir),
        }, null, 2)}\n`);
        await new Promise(resolveClose => {
          const shutdown = () => server.close(() => resolveClose());
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
          server.once('close', resolveClose);
        });
        return 0;
      }

      if (command === 'openai-batch-build') {
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

      if (command === 'redteam-review') {
        const packetPath = resolve(requireOption(values.packet, 'packet'));
        const outputPath = resolve(requireOption(values.output, 'output'));
        const effort = values.effort ? values.effort.trim() : 'max';
        if (effort !== null && !['xhigh', 'max'].includes(effort)) {
          throw new Phase2CliError('--effort 必须为 xhigh 或 max。');
        }
        const imagePaths = (values.image ?? []).map(p => resolve(p));
        const isOffline = values.offline === true;
        const isDryRun = values['dry-run'] === true || isOffline;
        const mockExecutor = typeof testHooks?.codexMockExecutor === 'function' ? testHooks.codexMockExecutor : null;
        const testReceiptDir = typeof testHooks?.codexReceiptDir === 'string' ? resolve(testHooks.codexReceiptDir) : undefined;
        const codexBin = values['codex-bin'] ? values['codex-bin'].trim() : undefined;
        const protectedCodexPaths = [];
        if (codexBin && (codexBin.includes('/') || codexBin.includes('\\') || existsSync(resolve(codexBin)))) {
          protectedCodexPaths.push(resolve(codexBin));
        }
        if (!isDryRun && !mockExecutor) {
          try {
            const resolvedTarget = resolveCodexCommand(codexBin ?? 'codex', { env: process.env, testMode: false });
            if (resolvedTarget?.command) protectedCodexPaths.push(resolvedTarget.command);
            if (resolvedTarget?.resolvedShimPath) protectedCodexPaths.push(resolvedTarget.resolvedShimPath);
            if (resolvedTarget?.resolvedTargetPath) protectedCodexPaths.push(resolvedTarget.resolvedTargetPath);
            for (const arg of resolvedTarget?.prefixArgs ?? []) {
              if (typeof arg === 'string' && existsSync(arg)) protectedCodexPaths.push(resolve(arg));
            }
          } catch {
            // Let runCodexEvidenceReview produce the canonical resolution/install diagnostic if binary is missing/untrusted.
          }
        }

        const packet = await readJsonFileSafe(packetPath, '红队复核数据包');
        if (!isDryRun) {
          try {
            assertAuthorizedReviewExecutionPolicy(packet);
          } catch {
            throw new Phase2CliError(
              '数据包缺少已授权的 execution_policy_ref（或为 null / disabled，禁止本地实时执行）；请传入 --dry-run 或 --offline 进行离线校验。',
            );
          }
        }

        const packetSubjectId = typeof packet?.candidate?.subject_id === 'string' && packet.candidate.subject_id.trim()
          ? packet.candidate.subject_id.trim()
          : undefined;
        const explicitFormArg = typeof values.form === 'string' && values.form.trim() ? values.form.trim() : undefined;
        if (explicitFormArg && packetSubjectId && explicitFormArg !== packetSubjectId) {
          throw new Phase2CliError(
            `--form ("${sanitizeDiagnosticText(explicitFormArg)}") 与数据包 candidate.subject_id ("${sanitizeDiagnosticText(packetSubjectId)}") 不一致。`,
          );
        }
        const boundCandidateId = packetSubjectId ?? explicitFormArg;
        let boundFormSpecSha256 = values['form-spec-sha256'] ? values['form-spec-sha256'].trim() : undefined;
        let skipNonQualifyingReason = null;
        const optDbPaths = [];
        if (values.db === ':memory:') {
          if (!isDryRun && values.force !== true) {
            skipNonQualifyingReason = '指定了空内存库 (--db :memory:)，无法核实候选形态当前规格已入围；按 Gate-4 仅复核入围卡片规则自动跳过（如需强制复核请传入 --force）。';
          }
        } else if (!values.db && !mockExecutor && !isDryRun && values.force !== true) {
          skipNonQualifyingReason = '真实 Gate-4 复核必须绑定 --db 数据库核实当前规格已入围（如需无库强制复核请显式传入 --force）。';
        } else if (values.db && values.db !== ':memory:') {
          const absDb = resolve(values.db);
          optDbPaths.push(absDb);
          if (!existsSync(absDb)) {
            if (!isDryRun && values.force !== true) {
              skipNonQualifyingReason = `指定的数据库不存在，无法核实候选形态 "${boundCandidateId ?? 'unknown'}" 当前规格已入围；按 Gate-4 仅复核入围卡片规则自动跳过（如需强制复核请传入 --force）。`;
            }
          } else if (!boundCandidateId) {
            if (!isDryRun && values.force !== true) {
              skipNonQualifyingReason = '未提供候选形态 ID（candidate.subject_id 或 --form），无法在数据库中核实入围资格；按 Gate-4 规则自动跳过（如需强制复核请传入 --force）。';
            }
          } else {
            const roStore = openSelectionStore(absDb, { readOnly: true });
            try {
              const dbForm = roStore.getCandidateForm(boundCandidateId);
              if (!dbForm) {
                if (!isDryRun && values.force !== true) {
                  skipNonQualifyingReason = `数据库中不存在候选形态 "${boundCandidateId}" 的记录，按 Gate-4 仅复核入围卡片规则自动跳过；如需强制复核请传入 --force。`;
                }
              } else {
                if (dbForm.spec_sha256 && boundFormSpecSha256 && boundFormSpecSha256 !== dbForm.spec_sha256) {
                  throw new Phase2CliError(
                    `--form-spec-sha256 与数据库中候选形态 "${sanitizeDiagnosticText(boundCandidateId)}" 的当前 spec_sha256 不一致。`,
                  );
                }
                const specMatch = doesReviewPacketMatchDbFormSpec(packet, dbForm);
                const pktDeclaredSha = specMatch.pktDeclaredSha;
                const packetIsStaleVsDb = !specMatch.matches;
                if (!isDryRun && values.force !== true) {
                  const effLifecycle = dbForm.effective_lifecycle_status ?? dbForm.lifecycle_status;
                  const NON_QUALIFYING_LIFECYCLES = new Set([
                    'discovered',
                    'gate1a_rejected',
                    'gate1b_rejected',
                    'gate1a_needs_verification',
                    'gate1b_needs_verification',
                    'gate1b_queued',
                    'gate1b_pending',
                    'gate1b_passed',
                    'deferred',
                    'private_mold_reserved',
                  ]);
                  if (NON_QUALIFYING_LIFECYCLES.has(effLifecycle)) {
                    skipNonQualifyingReason = `候选形态 "${boundCandidateId}" 当前状态为 ${effLifecycle}（尚未完成终审入围），按 Gate-4 仅复核入围卡片规则自动跳过；如需强制复核请传入 --force。`;
                  } else if (packetIsStaleVsDb) {
                    skipNonQualifyingReason = `候选形态 "${boundCandidateId}" 的复核数据包与当前库规格不一致（原因=${specMatch.reason}，数据包件数=${specMatch.pktQty ?? '未知'}/材质=${specMatch.pktMaterial ?? '未知'} vs 当前库件数=${specMatch.dbQty ?? '未知'}/材质=${specMatch.dbMaterial ?? '未知'}），拒绝将当前 spec_sha256 加盖到旧版数据包；请按当前规格重新生成复核包。`;
                  } else {
                    const evalRows = roStore.getEvaluationsForForm(boundCandidateId);
                    const matchingSpecEvalRows = evalRows.filter(r => {
                      let rec = {};
                      try { rec = JSON.parse(r.receipt_json || '{}'); } catch { rec = {}; }
                      if (typeof rec.form_spec_sha256 === 'string' && rec.form_spec_sha256) {
                        return rec.form_spec_sha256 === dbForm.spec_sha256;
                      }
                      if ((dbForm.spec_version ?? 1) > 1 && r.created_at && dbForm.updated_at && r.created_at < dbForm.updated_at) {
                        return false;
                      }
                      return (dbForm.spec_version ?? 1) === 1;
                    });
                    if (matchingSpecEvalRows.length === 0) {
                      skipNonQualifyingReason = `候选形态 "${boundCandidateId}" 当前规格（v${dbForm.spec_version ?? 1}）尚无终审评估记录，按 Gate-4 仅复核入围卡片规则自动跳过；如需强制复核请传入 --force。`;
                    } else {
                      const latestBundleSha = matchingSpecEvalRows[matchingSpecEvalRows.length - 1].evidence_bundle_sha256;
                      const latestRows = matchingSpecEvalRows.filter(r => r.evidence_bundle_sha256 === latestBundleSha);
                      const parsedQuals = latestRows.map(r => {
                        try { return JSON.parse(r.qualification_json || '{}'); } catch { return {}; }
                      });
                      const anyQualifying = parsedQuals.some(q => q?.counts_toward_target === true);
                      if (!anyQualifying) {
                        const modeStr = parsedQuals[0]?.mode ?? 'non_qualifying';
                        skipNonQualifyingReason = `候选形态 "${boundCandidateId}" 当前规格最新评估未入围（counts_toward_target=false, mode=${modeStr}），按 Gate-4 仅复核入围卡片规则自动跳过；如需强制复核请传入 --force。`;
                      } else if (dbForm.spec_sha256) {
                        boundFormSpecSha256 = dbForm.spec_sha256;
                      }
                    }
                  }
                } else if (dbForm.spec_sha256 && !packetIsStaleVsDb) {
                  boundFormSpecSha256 = dbForm.spec_sha256;
                } else if (packetIsStaleVsDb && pktDeclaredSha) {
                  boundFormSpecSha256 = pktDeclaredSha;
                }
              }
            } finally {
              roStore.close();
            }
          }
        }
        const serviceTier = values['service-tier']?.trim() || DEFAULT_CODEX_SERVICE_TIER;
        const skippedForNonQualifying = Boolean(skipNonQualifyingReason);

        // P2-11: Preflight and stage protected destination (including directory, special-file, PATH/shim/JS target & --codex-bin checks) BEFORE invoking Codex CLI!
        const stageState = await preflightSingleFileDestination(outputPath, [
          packetPath,
          ...imagePaths,
          ...protectedCodexPaths,
          ...optDbPaths,
        ]);
        let reviewEnvelope;
        let outSha;
        try {
          reviewEnvelope = await runCodexEvidenceReview(packet, {
            ...(values.model ? { model: values.model.trim() } : {}),
            reasoningEffort: effort,
            ...(serviceTier ? { serviceTier } : {}),
            ...(boundCandidateId ? { candidateId: boundCandidateId } : {}),
            ...(boundFormSpecSha256 ? { formSpecSha256: boundFormSpecSha256 } : {}),
            imagePaths,
            dryRun: isDryRun,
            enabled: !isDryRun && !skippedForNonQualifying,
            ...(skippedForNonQualifying ? { disabledReason: skipNonQualifyingReason } : {}),
            ...(mockExecutor ? { testMode: true, mockExecutor } : {}),
            ...(testReceiptDir ? { receiptDir: testReceiptDir } : {}),
            ...(codexBin ? { codexBin } : {}),
          });

          const serialized = Buffer.from(`${JSON.stringify(reviewEnvelope, null, 2)}\n`, 'utf8');
          outSha = await commitStagedSingleFile(stageState, serialized);
        } finally {
          await cleanupStagedSingleFile(stageState);
        }

        const summary = {
          ok: isDryRun || skippedForNonQualifying || reviewEnvelope.status === 'ready',
          command,
          dry_run: isDryRun,
          ...(skippedForNonQualifying ? { skipped_non_qualifying: true } : {}),
          ...(isOffline ? { offline: true } : {}),
          status: reviewEnvelope.status,
          execution_status: reviewEnvelope.execution_status,
          content_status: reviewEnvelope.content_status,
          review_id: reviewEnvelope.review_id,
          packet_sha256: reviewEnvelope.packet_sha256,
          payload_sha256: reviewEnvelope.payload_sha256,
          ...(Array.isArray(reviewEnvelope.attachment_sha256s) ? { attachment_sha256s: reviewEnvelope.attachment_sha256s } : {}),
          ...(reviewEnvelope.execution_provenance ? { execution_provenance: reviewEnvelope.execution_provenance } : {}),
          ...(reviewEnvelope.private_receipt_ref ? { private_receipt_ref: reviewEnvelope.private_receipt_ref } : {}),
          reviewer_label: reviewEnvelope.reviewer_label,
          disposition_counts: reviewEnvelope.disposition_counts,
          output_path: sanitizeCliDisplayPath(outputPath),
          output_sha256: outSha,
          ...(reviewEnvelope.reason ? { reason: reviewEnvelope.reason } : {}),
        };

        if (!isDryRun && !skippedForNonQualifying && reviewEnvelope.status !== 'ready') {
          streams.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
          streams.stderr.write(
            `Phase 2 CLI 失败：红队复核未生成可用结果（${sanitizeDiagnosticText(reviewEnvelope.reason || reviewEnvelope.status)}）；已将不可用回执保存至输出文件。\n`,
          );
          return 2;
        }
        streams.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        return 0;
      }
    }

    if (OPENAI_DB_COMMANDS.has(command)) {
      const rawPrimaryDb = values.db ?? values['budget-db'];
      if (!rawPrimaryDb) requireOption(values.db, 'db');
      const dbPath = rawPrimaryDb === ':memory:' ? ':memory:' : resolve(rawPrimaryDb);
      const rawBudgetDb = values['budget-db'] ?? process.env.OPENAI_BUDGET_LEDGER_DB ?? rawPrimaryDb;
      const budgetDbPath = rawBudgetDb === ':memory:' ? ':memory:' : resolve(rawBudgetDb);
      const accountScope = assertSafeOpenAiAccountScope(
        values['account-scope'] ? values['account-scope'].trim() : 'openai-default',
      );
      const monthUtc = assertValidMonthUtc(
        values.month ? values.month.trim() : currentMonthUtc(),
      );
      const legacyPath = values['legacy-budget'] ? resolve(values['legacy-budget']) : null;
      const testLedgerOpts = testHooks?.testLedgerOptions && typeof testHooks.testLedgerOptions === 'object'
        ? testHooks.testLedgerOptions
        : {};

      if (LIVE_COMMANDS.has(command)) return await runLiveCommand(command, values, streams, dbPath, budgetDbPath, accountScope, testHooks);

      if (command === 'openai-status') {
        const ledger = openOpenAiBudgetLedger(budgetDbPath, { readOnly: true, ...testLedgerOpts });
        try {
          const status = ledger.getStatus({ accountScope, monthUtc });
          const legacySummary = legacyPath
            ? inspectLegacyAutopilotBudget(legacyPath, { monthUtc })
            : null;
          streams.stdout.write(`${JSON.stringify({
            ok: true,
            command,
            private_receipt_ref: `sqlite:${sanitizeCliDisplayPath(budgetDbPath)}#scope:${accountScope}`,
            status: formatNarrowLedgerStatus(status),
            ...(legacySummary ? { legacy_budget: formatNarrowLegacySummary(legacySummary) } : {}),
          }, null, 2)}\n`);
          return 0;
        } finally {
          ledger.close();
        }
      }

      if (command === 'openai-reconcile') {
        if (values.enable === true && values.disable === true) {
          throw new Phase2CliError('--enable 与 --disable 不能同时传入。');
        }
        if (values['allow-stage4-media'] === true && values['disallow-stage4-media'] === true) {
          throw new Phase2CliError('--allow-stage4-media 与 --disallow-stage4-media 不能同时传入。');
        }
        // P0-11: Physical file-identity collision check (resolving junctions, symlinks, and hard links) BEFORE writable open!
        if (legacyPath && budgetDbPath !== ':memory:' && isSamePhysicalFileCli(legacyPath, budgetDbPath)) {
          throw new Phase2CliError('--legacy-budget 不能与目标可写 --db 指向同一物理数据库文件（含软硬链接/目录联接）。');
        }

        const enableFlag = values.enable === true ? true : (values.disable === true ? false : undefined);
        const confirmAutoRechargeOff = values['confirm-auto-recharge-off'] === true ? true : undefined;
        const confirmHardLimit = values['confirm-hard-limit'] === true ? true : undefined;
        const allowStage4Media = values['allow-stage4-media'] === true
          ? true
          : (values['disallow-stage4-media'] === true ? false : undefined);
        const monthlyLimitCents = parseOptionalNonNegSafeInt(values['monthly-limit-cents'], 'monthly-limit-cents');
        const sameMonthPendingBufferCents = parseOptionalNonNegSafeInt(values['same-month-pending-buffer-cents'], 'same-month-pending-buffer-cents');
        if (sameMonthPendingBufferCents > 2000) throw new Phase2CliError('--same-month-pending-buffer-cents 不能超过 2000。');
        if (monthlyLimitCents !== undefined && monthlyLimitCents > 20_000) {
          throw new Phase2CliError('--monthly-limit-cents 不能超过 20000（$200.00/月封顶）。');
        }
        const usageCostMicros = parseOptionalNonNegSafeInt(values['usage-cost-micros'], 'usage-cost-micros');
        const postedBilledCents = parseOptionalNonNegSafeInt(values['posted-billed-cents'], 'posted-billed-cents');
        const attemptId = values.attempt ? values.attempt.trim() : null;
        const noteText = values.note ? values.note.trim() : undefined;

        let targetStatus = null;
        let reqNote = null;
        if (attemptId) {
          targetStatus = requireOption(values.status, 'status');
          if (!['completed', 'failed_known', 'pending_recovery'].includes(targetStatus)) {
            throw new Phase2CliError('--status 必须为 completed、failed_known 或 pending_recovery。');
          }
          reqNote = requireOption(values.note, 'note');
        }

        const hasPolicyAction = Boolean(
          legacyPath ||
          enableFlag !== undefined ||
          confirmAutoRechargeOff !== undefined ||
          confirmHardLimit !== undefined ||
          monthlyLimitCents !== undefined ||
          sameMonthPendingBufferCents !== undefined,
        );
        if (!hasPolicyAction && !attemptId) {
          throw new Phase2CliError(
            'openai-reconcile 需要提供 --legacy-budget、策略开关（--enable / --disable / --monthly-limit-cents）或请求核销参数（--attempt --status --note）。',
          );
        }

        // Inspect legacy DB BEFORE opening target DB writable so unrecognized/missing legacy DB never creates/mutates target DB!
        const legacySummary = legacyPath
          ? inspectLegacyAutopilotBudget(legacyPath, { monthUtc })
          : null;

        const ledger = openOpenAiBudgetLedger(budgetDbPath, { readOnly: false, ...testLedgerOpts });
        try {
          let reconciledAttempt = null;
          const hasLegacyHolds = Boolean(
            legacySummary && (legacySummary.unresolved_count > 0 || legacySummary.has_unresolved_holds === true),
          );

          if (hasLegacyHolds) {
            // P0-09: Persist discovered legacy hold & durably revoke enabled/legacy_reconciled BEFORE any unrelated attempt validation can exit!
            ledger.reconcileLegacySummary(legacySummary, {
              accountScope,
              enable: enableFlag,
              autoRechargeOffConfirmed: confirmAutoRechargeOff,
              hardMonthlyLimitConfirmed: confirmHardLimit,
              monthlyLimitCents,
              sameMonthPendingBufferCents,
              note: !attemptId ? (noteText ?? null) : null,
            });
          } else {
            // P1-05: Validate attempt ownership and execute combined policy + attempt mutation atomically in ONE transaction!
            ledger._withImmediateTx(() => {
              if (attemptId) {
                const existingAttempt = typeof ledger.getAttemptById === 'function'
                  ? ledger.getAttemptById(attemptId)
                  : ledger.getAttempt(attemptId);
                if (!existingAttempt) {
                  throw new Phase2CliError(`未找到待核销请求记录 "${sanitizeDiagnosticText(attemptId)}"。`);
                }
                if (existingAttempt.account_scope !== accountScope) {
                  throw new Phase2CliError(
                    `请求 "${sanitizeDiagnosticText(attemptId)}" 归属作用域 "${sanitizeDiagnosticText(existingAttempt.account_scope)}"，与所选 --account-scope "${sanitizeDiagnosticText(accountScope)}" 不一致。`,
                  );
                }
              }

              if (legacySummary) {
                ledger.reconcileLegacySummary(legacySummary, {
                  accountScope,
                  enable: enableFlag,
                  autoRechargeOffConfirmed: confirmAutoRechargeOff,
                  hardMonthlyLimitConfirmed: confirmHardLimit,
                  monthlyLimitCents,
                  sameMonthPendingBufferCents,
                      note: !attemptId ? (noteText ?? null) : null,
                });
              } else if (hasPolicyAction) {
                ledger.configurePolicy({
                  accountScope,
                  enabled: enableFlag,
                  autoRechargeOffConfirmed: confirmAutoRechargeOff,
                  hardMonthlyLimitConfirmed: confirmHardLimit,
                  monthlyLimitCents,
                  sameMonthPendingBufferCents,
                      note: !attemptId ? noteText : undefined,
                });
              }

              if (attemptId) {
                reconciledAttempt = ledger.reconcileAttempt(attemptId, {
                  accountScope,
                  status: targetStatus,
                  note: reqNote,
                  confirmedZeroCharge: values['confirmed-zero-charge'] === true,
                  usageCostMicros,
                  postedBilledCents,
                  providerResponseId: values['provider-response-id'] ? values['provider-response-id'].trim() : undefined,
                });
              }
            });
          }

          // P1-20: Project ENTIRE CLI response onto narrow operator fields + private receipt reference (omitting source fingerprints, unrelated row IDs, and raw receipts).
          const narrowAttemptSummary = reconciledAttempt
            ? {
                attempt_id: reconciledAttempt.attempt_id,
                logical_request_id: reconciledAttempt.logical_request_id,
                account_scope: reconciledAttempt.account_scope,
                month_utc: reconciledAttempt.month_utc,
                endpoint: reconciledAttempt.endpoint,
                model: reconciledAttempt.model,
                status: reconciledAttempt.status,
                cleanup_status: reconciledAttempt.cleanup_status,
                reserved_cents: reconciledAttempt.reserved_cents,
                usage_cost_micros: reconciledAttempt.usage_cost_micros,
                posted_billed_cents: reconciledAttempt.posted_billed_cents,
                confirmed_zero_charge: reconciledAttempt.confirmed_zero_charge,
                reconciliation_note: reconciledAttempt.reconciliation_note,
                updated_at: reconciledAttempt.updated_at,
                private_receipt_ref: `sqlite:${sanitizeCliDisplayPath(budgetDbPath)}#attempt:${reconciledAttempt.attempt_id}`,
              }
            : null;

          streams.stdout.write(`${JSON.stringify({
            ok: true,
            command,
            private_receipt_ref: `sqlite:${sanitizeCliDisplayPath(budgetDbPath)}#scope:${accountScope}`,
            ...(legacySummary ? { legacy_budget: formatNarrowLegacySummary(legacySummary) } : {}),
            ...(narrowAttemptSummary ? { reconciled_attempt: narrowAttemptSummary } : {}),
            status: formatNarrowLedgerStatus(ledger.getStatus({ accountScope, monthUtc })),
          }, null, 2)}\n`);
          return 0;
        } finally {
          ledger.close();
        }
      }
    }

    const rawDb = requireOption(values.db, 'db');
    const dbPath = rawDb === ':memory:' ? ':memory:' : resolve(rawDb);
    if (values['profile-revision'] !== undefined) {
      const preRev = Number(values['profile-revision']);
      if (!Number.isInteger(preRev) || preRev < 59) {
        throw new Phase2CliError('--profile-revision 必须为 >= 59 的整数（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
      }
    }
    if (values.profile && ['replay', 'export-report', 'daily-batch', 'single-product', 'single-dive', 'reverse-1688'].includes(command)) {
      const preProf = await readJsonFileSafe(resolve(values.profile), '评分配置文件');
      const effPreRev = values['profile-revision'] !== undefined ? Number(values['profile-revision']) : (preProf?.revision ?? 59);
      if (!Number.isInteger(effPreRev) || effPreRev < 59) {
        throw new Phase2CliError('当前主线仅运行 Revision 59+（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
      }
    }
    if (values.input && ['gate1a', 'gate1b', 'daily-batch', 'single-product', 'single-dive', 'reverse-1688'].includes(command)) {
      const preSpec = await readJsonFileSafe(resolve(values.input), `${command} 输入文件`);
      if (preSpec && typeof preSpec === 'object' && !Array.isArray(preSpec) && preSpec.profile_revision !== undefined && values['profile-revision'] === undefined) {
        const specRev = Number(preSpec.profile_revision);
        if (!Number.isInteger(specRev) || specRev < 59) {
          throw new Phase2CliError('--profile-revision 必须为 >= 59 的整数（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
        }
      }
    }
    const isReadOnlyCmd = READ_ONLY_DB_COMMANDS.has(command) ||
      (command === 'calibration-track' && values.list === true && !values.input);
    const openReadOnly = (isReadOnlyCmd || (command === 'export-report' && existsSync(dbPath))) && dbPath !== ':memory:';
    const reconcileOnOpen = command === 'init' && values['reconcile-crashed'] === true;

    const store = openSelectionStore(dbPath, {
      readOnly: openReadOnly,
      reconcileOnOpen,
    });
    try {
      if (command === 'dedupe-forms' || command === 'funnel-ledger') {
        const inputPath = command === 'dedupe-forms' ? resolve(requireOption(values.input, 'input')) : null;
        const input = inputPath && await readJsonFileSafe(inputPath, '去重输入文件');
        if (input) checkOperatorPayload(input);
        // All counts and comparisons use a single read snapshot, including in WAL mode.
        store.db.exec('BEGIN');
        let out;
        try {
          out = inputPath ? { ok: true, command, proposals: checkFormDuplicates(store.db, input) }
            : { ok: true, command, ...buildFunnelLedger(store.db, values.since) };
        } finally {
          store.db.exec('ROLLBACK');
        }
        checkOperatorPayload(out);
        const json = JSON.stringify(out, null, 2) + '\n';
        if (values.output) await writeSingleFileSafe(values.output, Buffer.from(json), [...sqlitePaths(dbPath), inputPath]);
        streams.stdout.write(json);
        return 0;
      }
      if (command === 'init') {
        streams.stdout.write(`${JSON.stringify({ ok: true, command, summary: store.getSummary() }, null, 2)}\n`);
        return 0;
      }

      if (command === 'status') {
        streams.stdout.write(`${JSON.stringify({ ok: true, command, summary: store.getSummary() }, null, 2)}\n`);
        return 0;
      }

      if (command === 'coverage') {
        const covProfileRev = values['profile-revision'] !== undefined ? Number(values['profile-revision']) : 59;
        const audit = auditDiscoveryCoverage(store, { profile_revision: covProfileRev });
        streams.stdout.write(`${JSON.stringify({ ok: true, command, audit }, null, 2)}\n`);
        return 0;
      }

      if (command === 'plan-discovery') {
        const budget = values.budget !== undefined ? Number(values.budget) : 6;
        if (!Number.isInteger(budget) || budget < 1) {
          throw new Phase2CliError('--budget 必须为正整数。');
        }
        const plan = planDiscoveryBatch(store, { max_channels: budget, task_slots: budget, enforce_80_20_mix: true });
        streams.stdout.write(`${JSON.stringify({ ok: true, command, plan }, null, 2)}\n`);
        return 0;
      }

      if (command === 'import-history') {
        const imported = { recovery: [], ledgers: [], assets: null };
        for (const recFile of values.recovery ?? []) {
          imported.recovery.push(importRecoveryLockFile(store, resolve(recFile)));
        }
        for (const ledFile of values.ledger ?? []) {
          imported.ledgers.push(importRequestLedgerFile(store, resolve(ledFile)));
        }
        if (values.assets) {
          const manifest = await readJsonFileSafe(resolve(values.assets), '资产清单文件');
          imported.assets = importRetainedAssetsManifest(store, manifest);
        }
        streams.stdout.write(`${JSON.stringify({ ok: true, command, imported, summary: store.getSummary() }, null, 2)}\n`);
        return 0;
      }

      if (command === 'replay') {
        const batchPath = resolve(requireOption(values.batch, 'batch'));
        const profilePath = resolve(requireOption(values.profile, 'profile'));
        const discoveryPath = values.discovery ? resolve(values.discovery) : null;
        const batch = await readJsonFileSafe(batchPath, '批次输入文件');
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
        const discovery = discoveryPath ? await readJsonFileSafe(discoveryPath, '发现记录文件') : null;
        const out = replayBatchIntoStore(store, {
          batch,
          profile,
          discovery,
          expected_result_sha256: values['verify-result'] ?? null,
          expected_html_sha256: values['verify-html'] ?? null,
        });
        let exported = null;
        if (values.output) {
          exported = await writeReportArtifacts(values.output, {
            resultBytes: out.result_bytes,
            htmlBytes: out.html_bytes,
            resultSha: out.result_sha256,
            htmlSha: out.html_sha256,
            summary: out.summary,
            profileRevision: profile.revision,
            protectedInputPaths: [batchPath, profilePath, discoveryPath, dbPath],
          });
        }
        streams.stdout.write(`${JSON.stringify({
          ok: true,
          command,
          result_sha256: out.result_sha256,
          html_sha256: out.html_sha256,
          evaluations_recorded: out.evaluations_recorded,
          summary: out.summary,
          ...(exported ? { exported } : {}),
        }, null, 2)}\n`);
        return 0;
      }

      if (command === 'export-report') {
        const batchPath = resolve(requireOption(values.batch, 'batch'));
        const profilePath = resolve(requireOption(values.profile, 'profile'));
        const discoveryPath = values.discovery ? resolve(values.discovery) : null;
        const outputDir = requireOption(values.output, 'output');
        const batch = await readJsonFileSafe(batchPath, '批次输入文件');
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
        const discoveryBundle = discoveryPath ? await readJsonFileSafe(discoveryPath, '发现记录文件') : null;
        const manifest = discoveryBundle ? prepareDiscovery(discoveryBundle.pool, discoveryBundle.decisions) : null;
        const withManifest = manifest ? attachDiscovery(batch, manifest) : structuredClone(batch);
        const rawImageArgs = values.image ?? [];
        const candCount = Array.isArray(withManifest?.candidates) ? withManifest.candidates.length : 0;
        const exportImagePaths = [];
        const attachmentShasByCandidateId = new Map();
        let singleCandShas = null;
        for (const rawArg of rawImageArgs) {
          const kvMatch = /^([A-Za-z0-9._-]+)=(.+)$/.exec(String(rawArg));
          if (kvMatch) {
            const cid = kvMatch[1];
            const absImg = resolve(kvMatch[2]);
            exportImagePaths.push(absImg);
            const list = attachmentShasByCandidateId.get(cid) ?? [];
            list.push(sha256Hex(readFileSync(absImg)));
            attachmentShasByCandidateId.set(cid, list);
          } else {
            if (candCount > 1) {
              throw new Phase2CliError('多候选批次导出时，--image 必须采用 <candidate_id>=<文件路径> 逐卡绑定附件。');
            }
            const absImg = resolve(rawArg);
            exportImagePaths.push(absImg);
            singleCandShas = singleCandShas ?? [];
            singleCandShas.push(sha256Hex(readFileSync(absImg)));
          }
        }
        const boundBatch = attachStoreDiscoveryProvenance(withManifest, store);
        const testReceiptStoreDir = typeof testHooks?.codexReceiptDir === 'string'
          ? resolve(testHooks.codexReceiptDir)
          : (typeof testHooks?.reportOptions?.receiptStoreDir === 'string' ? resolve(testHooks.reportOptions.receiptStoreDir) : null);
        const allowTestDoubleReceipts = Boolean(
          testHooks?.allowTestDoubleReceipts === true || testHooks?.reportOptions?.allowTestDoubleReceipts === true,
        );
        const reportRenderOpts = {
          ...(testHooks?.reportOptions && typeof testHooks.reportOptions === 'object' ? testHooks.reportOptions : {}),
          ...(testReceiptStoreDir ? { receiptStoreDir: testReceiptStoreDir } : {}),
          ...(allowTestDoubleReceipts ? { allowTestDoubleReceipts: true } : {}),
        };
        const defaultVerifyReceiptFn = (ev, opts = {}) => verifySavedCodexReceipt(ev, {
          receiptStoreDir: testReceiptStoreDir,
          allowTestDouble: allowTestDoubleReceipts,
          allowStaleSpec: Boolean(opts?.allowStaleSpec),
          expectedFormSpecSha256: opts?.currentFormSpecSha256 ?? null,
          expectedCandidateId: opts?.expectedCandidateId ?? null,
        });
        const { notesByFormId, storedShortlist, storedPackagingShortlist } = enrichBatchAndResultFromStore(boundBatch, store, {
          profileRevision: profile.revision,
          profile,
          manifest,
          expectedHtmlSha256: values['verify-html'] ?? null,
          currentAttachmentSha256s: singleCandShas,
          attachmentShasByCandidateId: attachmentShasByCandidateId.size > 0 ? attachmentShasByCandidateId : null,
          verifyReceiptFn: typeof testHooks?.verifyReceiptFn === 'function' ? testHooks.verifyReceiptFn : defaultVerifyReceiptFn,
        });
        const scoredResult = scoreBatch(boundBatch, profile);
        if (manifest) scoredResult.discovery = { ...manifest, summary: boundBatch.discovery_summary };
        if (notesByFormId.size > 0 && Array.isArray(scoredResult.candidates)) {
          for (const sc of scoredResult.candidates) {
            const notes = notesByFormId.get(sc.candidate_id || sc.id);
            if (notes && notes.length > 0) sc.review_notes = notes;
          }
        }
        if ((profile.revision ?? 59) < 59 && storedShortlist.length > 0) {
          const existingList = Array.isArray(scoredResult.negotiation_shortlist) ? scoredResult.negotiation_shortlist : [];
          const seenIds = new Set(existingList.map(x => x?.form_id || x?.id).filter(Boolean));
          const mergedShortlist = [...existingList];
          for (const item of storedShortlist) {
            if (!seenIds.has(item.form_id)) {
              seenIds.add(item.form_id);
              mergedShortlist.push(item);
            }
          }
          scoredResult.negotiation_shortlist = mergedShortlist;
        }
        if ((profile.revision ?? 59) >= 59 && Array.isArray(storedPackagingShortlist) && storedPackagingShortlist.length > 0) {
          const existingPkgList = Array.isArray(scoredResult.packaging_redesign_shortlist) ? scoredResult.packaging_redesign_shortlist : [];
          const seenPkgIds = new Set(existingPkgList.map(x => x?.form_id || x?.candidate_id || x?.id).filter(Boolean));
          const mergedPkgShortlist = [...existingPkgList];
          for (const item of storedPackagingShortlist) {
            if (!seenPkgIds.has(item.form_id)) {
              seenPkgIds.add(item.form_id);
              mergedPkgShortlist.push(item);
            }
          }
          scoredResult.packaging_redesign_shortlist = mergedPkgShortlist;
        }

        const resultBytes = Buffer.from(`${JSON.stringify(scoredResult, null, 2)}\n`, 'utf8');
        const htmlBytes = Buffer.from(renderReport(scoredResult, boundBatch, reportRenderOpts), 'utf8');
        const resultSha = sha256Hex(resultBytes);
        const htmlSha = sha256Hex(htmlBytes);
        if (values['verify-result'] && resultSha !== values['verify-result']) {
          throw new Phase2CliError(`导出结果摘要不匹配：期望 ${values['verify-result']}，实际 ${resultSha}。`);
        }
        if (values['verify-html'] && htmlSha !== values['verify-html']) {
          throw new Phase2CliError(`导出 HTML 摘要不匹配：期望 ${values['verify-html']}，实际 ${htmlSha}。`);
        }
        const exported = await writeReportArtifacts(outputDir, {
          resultBytes,
          htmlBytes,
          resultSha,
          htmlSha,
          summary: scoredResult.summary,
          profileRevision: profile.revision,
          protectedInputPaths: [batchPath, profilePath, discoveryPath, dbPath, ...exportImagePaths],
        });
        streams.stdout.write(`${JSON.stringify({
          ok: true,
          command,
          exported,
          summary: scoredResult.summary,
        }, null, 2)}\n`);
        return 0;
      }

      if (command === 'gate1a') {
        const specPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(specPath, 'Gate 1A 输入文件');
        const g1aProfileRev = values['profile-revision'] !== undefined
          ? Number(values['profile-revision'])
          : (spec.profile_revision ?? 59);
        if (!Number.isInteger(g1aProfileRev) || g1aProfileRev < 59) {
          throw new Phase2CliError('--profile-revision 必须为 >= 59 的整数（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
        }
        if (g1aProfileRev >= 59 && spec.disallow_pre1688_cost_guess_kill === false) {
          throw new Phase2CliError('Revision 59 严禁启用 Gate 1A 倒推价前置砍品（disallow_pre1688_cost_guess_kill 不可为 false）。');
        }
        let formId = spec.form_id;
        if (spec.form && typeof spec.form === 'object') {
          const { form } = store.upsertCandidateForm(spec.form);
          formId = form.form_id;
        }
        for (const leadSpec of spec.leads ?? []) {
          if (leadSpec && leadSpec.social_bridge) {
            store.ingestSocialBridgeLead(leadSpec.social_bridge, {
              ...leadSpec,
              form_id: formId,
              link_role: leadSpec.link_role ?? 'primary_discovery',
              link_note: leadSpec.link_note ?? null,
            });
          } else {
            const { lead } = store.upsertRawLead(leadSpec);
            store.linkLeadToForm({
              lead_id: lead.lead_id,
              form_id: formId,
              link_role: leadSpec.link_role ?? 'primary_discovery',
              note: leadSpec.link_note ?? null,
            });
          }
        }
        let g1aPriceBandAnalysis = spec.price_band_analysis ?? null;
        if (!g1aPriceBandAnalysis && Array.isArray(spec.peer_listings) && spec.peer_listings.length > 0) {
          const g1aKeepaPayloads = Array.isArray(spec.keepa_receipts) ? [...spec.keepa_receipts] : [];
          if (Array.isArray(spec.raw_receipt_files)) {
            for (const relFp of spec.raw_receipt_files) {
              g1aKeepaPayloads.push(await readJsonFileSafe(resolve(dirname(specPath), String(relFp)), 'Gate 1A Keepa 原始回执'));
            }
          }
          const mergedPeers = g1aKeepaPayloads.length > 0
            ? mergeKeepaPayloadsIntoPeerListings(spec.peer_listings, g1aKeepaPayloads, { as_of_date: spec.as_of_date ?? null })
            : spec.peer_listings;
          g1aPriceBandAnalysis = analyzeMainstreamPriceBand(mergedPeers, {
            ...(spec.as_of_date ? { as_of_date: spec.as_of_date } : {}),
            ...(spec.price_band_options ?? {}),
          });
        }
        const result = runGate1AForForm(store, {
          form_id: formId,
          scenarios: spec.scenarios ?? spec.gate1a_scenarios,
          minimum_price_usd: spec.minimum_price_usd ?? 29.99,
          specific_rights_conflict: spec.specific_rights_conflict ?? 'unknown',
          strong_date_dependency: spec.strong_date_dependency ?? 'unknown',
          category_check: spec.category_check ?? null,
          gate0_options: spec.gate0_options ?? {},
          price_band_analysis: g1aPriceBandAnalysis,
          cluster_bands: spec.cluster_bands ?? null,
          profile_revision: g1aProfileRev,
          allow_forward_price_discovery: spec.allow_forward_price_discovery,
          disallow_pre1688_cost_guess_kill: spec.disallow_pre1688_cost_guess_kill,
        });
        streams.stdout.write(`${stringifyCliJson({ ok: true, command, form_id: formId, result })}\n`);
        return 0;
      }

      if (command === 'gate1b') {
        const specPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(specPath, 'Gate 1B 输入文件');
        const formId = spec.form_id;
        if (typeof formId !== 'string' || !formId.trim()) {
          throw new Phase2CliError('gate1b 输入 JSON 必须包含非空 form_id。');
        }
        const g1bProfileRev = values['profile-revision'] !== undefined
          ? Number(values['profile-revision'])
          : (spec.profile_revision ?? 59);
        if (!Number.isInteger(g1bProfileRev) || g1bProfileRev < 59) {
          throw new Phase2CliError('--profile-revision 必须为 >= 59 的整数（r50–r58 已冻结归档至 Git 标签 archive/r50-r58-frozen-replay-20261125）。');
        }
        if (g1bProfileRev >= 59 && spec.require_ui_readback === false) {
          throw new Phase2CliError('Revision 59 严禁关闭 1688 ui_readback 核验门禁。');
        }
        const form = store.getCandidateForm(formId);
        if (!form) throw new Phase2CliError(`未找到候选形态：${formId}`);
        if (Array.isArray(spec.quotes) && spec.quotes.length > 0) {
          store.recordSourcingQuotesBatch1688(spec.quotes.map(qObj => {
            if (g1bProfileRev >= 59 && qObj?.require_ui_readback === false) {
              throw new Phase2CliError('Revision 59 严禁关闭 1688 ui_readback 核验门禁。');
            }
            return {
              ...qObj,
              ...(g1bProfileRev >= 59 ? { require_ui_readback: true } : {}),
              form_id: formId,
              spec_version: form.spec_version,
            };
          }));
        } else if (spec.quote && typeof spec.quote === 'object') {
          if (g1bProfileRev >= 59 && spec.quote.require_ui_readback === false) {
            throw new Phase2CliError('Revision 59 严禁关闭 1688 ui_readback 核验门禁。');
          }
          store.recordSourcingQuote1688({
            ...spec.quote,
            ...(g1bProfileRev >= 59 ? { require_ui_readback: true } : {}),
            form_id: formId,
            spec_version: form.spec_version,
          });
        }
        const existingQuotes = store.getQuotesForForm(formId).filter(
          q => q.quote_status === 'verified' && q.spec_version === form.spec_version,
        );
        const scenarios = Array.isArray(spec.early_screen_scenarios)
          ? spec.early_screen_scenarios
          : (spec.early_screen_scenario ? [spec.early_screen_scenario] : null);
        const result = await runGate1BForForm(store, {
          form_id: formId,
          existing_quote: existingQuotes[0] ?? null,
          existing_quotes: existingQuotes,
          profile_revision: g1bProfileRev,
          early_screen_builder: scenarios ? () => scenarios : undefined,
          as_of_date: values['as-of'] ? values['as-of'].trim() : (spec.as_of_date ?? new Date().toISOString().slice(0, 10)),
          allow_crossing_to_gate2_3: spec.allow_crossing_to_gate2_3 === true,
        });
        streams.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
        return 0;
      }

      if (command === 'reconcile') {
        const attemptId = requireOption(values.attempt, 'attempt');
        const rawStatus = requireOption(values.status, 'status');
        const resolvedStatus = rawStatus === 'succeeded' ? 'completed' : rawStatus;
        const hasExplicitChargeFlag =
          values['sif-units'] !== undefined ||
          values['ss-mcp-units'] !== undefined ||
          values['ss-web-units'] !== undefined ||
          values['exa-calls'] !== undefined ||
          values['exa-units'] !== undefined ||
          values['confirmed-zero-charge'] === true;
        if (resolvedStatus === 'failed' && !hasExplicitChargeFlag) {
          throw new Phase2CliError(
            '核销为 failed 时必须显式提供扣费结算参数（--sif-units / --ss-mcp-units / --ss-web-units / --exa-calls）或明确传入 --confirmed-zero-charge，防止省略参数误解锁重复扣费请求。',
          );
        }
        const out = store.reconcileUnknownAttempt(attemptId, {
          resolved_status: resolvedStatus,
          note: values.note ? values.note.trim() : `CLI reconciled as ${resolvedStatus}`,
          sif_units: parseOptionalNonNegNumber(values['sif-units'], 'sif-units'),
          ss_mcp_units: parseOptionalNonNegNumber(values['ss-mcp-units'], 'ss-mcp-units'),
          ss_web_realtime_tasks: parseOptionalNonNegNumber(values['ss-web-units'], 'ss-web-units'),
          exa_calls: parseOptionalNonNegNumber(values['exa-calls'] ?? values['exa-units'], 'exa-calls'),
        });
        streams.stdout.write(`${JSON.stringify({ ok: true, command, reconciled: out, quota_summary: store.getQuotaSummary() }, null, 2)}\n`);
        return 0;
      }

      if (command === 'resume-1688') {
        const qty = Number(requireOption(values.quantity, 'quantity'));
        const state = store.resumeQueue('gate1b_1688_queue', {
          login_verified: values['login-verified'] === true,
          form_id: values.form ? values.form.trim() : undefined,
          destination_city: requireOption(values.city, 'city'),
          quantity: qty,
          sku_id: requireOption(values.sku, 'sku'),
          quote_validity: requireOption(values.validity, 'validity'),
        }, values['as-of'] ? { as_of_date: values['as-of'].trim() } : {});
        streams.stdout.write(`${JSON.stringify({ ok: true, command, queue_state: state }, null, 2)}\n`);
        return 0;
      }

      if (command === 'trace') {
        const formId = requireOption(values.form, 'form');
        const lineage = store.traceFormLineage(formId);
        if (!lineage) throw new Phase2CliError(`未找到候选形态：${formId}`);
        streams.stdout.write(`${JSON.stringify({ ok: true, command, lineage }, null, 2)}\n`);
        return 0;
      }

      if (command === 'calibration-track') {
        const inputPath = values.input ? resolve(values.input) : null;
        if (!inputPath && values.list !== true) {
          throw new Phase2CliError('calibration-track 需要传入 --input <tracking.json> 写入，或传入 --list 查询。');
        }
        let saved = [];
        if (inputPath) {
          const payload = await readJsonFileSafe(inputPath, '校准追踪输入文件');
          checkOperatorPayload(payload);
          const rawRows = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.records) ? payload.records : [payload]);
          for (const rawRow of rawRows) {
            if (!rawRow || typeof rawRow !== 'object') continue;
            let computedMargin = rawRow.recalculated_margin;
            if (computedMargin === undefined && rawRow.sample_measured_pkg && rawRow.recalculate_profit_spec) {
              const hc = runFastProfitHealthcheck2027({
                ...rawRow.recalculate_profit_spec,
                pkg: rawRow.sample_measured_pkg,
              });
              computedMargin = {
                margin: hc.realized_2027_off_peak?.margin ?? null,
                margin_pct: hc.realized_2027_off_peak?.margin_pct ?? null,
                meets_30pct_floor: hc.realized_2027_off_peak?.meets_30pct_floor ?? null,
                size_tier: hc.size_tier_2027?.size_tier ?? null,
                fulfillment_usd: hc.advisory_gate1a_cap?.fulfillment_usd ?? null,
                recalculated_at: values['as-of'] ? values['as-of'].trim() : new Date().toISOString().slice(0, 10),
              };
            }
            const { recalculate_profit_spec: _ignoredSpec, ...cleanRow } = rawRow;
            saved.push(store.upsertCalibrationTracking({
              ...cleanRow,
              ...(values['batch-id'] && cleanRow.batch_id === undefined ? { batch_id: values['batch-id'].trim() } : {}),
              ...(computedMargin !== undefined ? { recalculated_margin: computedMargin } : {}),
            }));
          }
        }
        const listed = values.list === true || !inputPath
          ? store.listCalibrationTracking({
              batch_id: values['batch-id'] ? values['batch-id'].trim() : null,
              form_id: values.form ? values.form.trim() : null,
            })
          : null;
        const out = {
          ok: true,
          command,
          ...(saved.length > 0 ? { saved_count: saved.length, saved } : {}),
          ...(listed ? { count: listed.length, records: listed } : {}),
        };
        checkOperatorPayload(out);
        const json = `${JSON.stringify(out, null, 2)}\n`;
        if (values.output) {
          await writeSingleFileSafe(
            resolve(values.output),
            Buffer.from(json, 'utf8'),
            [...sqlitePaths(dbPath), ...(inputPath ? [inputPath] : [])],
          );
        }
        streams.stdout.write(json);
        return 0;
      }

      if (command === 'daily-batch' || command === 'single-product' || command === 'single-dive' || command === 'reverse-1688') {
        const inputPath = resolve(requireOption(values.input, 'input'));
        const spec = await readJsonFileSafe(inputPath, `${command} 输入文件`);
        checkOperatorPayload(spec);
        const defaultR59ProfilePath = resolve(THIS_DIR, '..', 'docs', 'design', 'reference-profile.r59.draft.json');
        const profilePath = values.profile ? resolve(values.profile) : defaultR59ProfilePath;
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
          let resolvedRevHeadhaulUsd = !missingTopRevBond && Number.isFinite(spec.headhaul_usd) && spec.headhaul_usd >= 0
            ? spec.headhaul_usd + (spec.bond_included === false ? Number(spec.bond_usd_per_unit ?? qObj.bond_usd_per_unit) : 0)
            : (!missingTopRevBond && Number.isFinite(qObj.headhaul_usd) && qObj.headhaul_usd >= 0
              ? qObj.headhaul_usd + (qObj.bond_included === false ? Number(qObj.bond_usd_per_unit ?? spec.bond_usd_per_unit) : 0)
              : undefined);
          const rawRevHeadhaulObj = spec.headhaul ?? qObj.headhaul ?? null;
          if (resolvedRevHeadhaulUsd === undefined && rawRevHeadhaulObj && typeof rawRevHeadhaulObj === 'object') {
            if (
              Number.isFinite(rawRevHeadhaulObj.usd_per_unit) &&
              rawRevHeadhaulObj.usd_per_unit >= 0 &&
              (rawRevHeadhaulObj.bond_included === true || Number.isFinite(rawRevHeadhaulObj.bond_usd_per_unit))
            ) {
              resolvedRevHeadhaulUsd = rawRevHeadhaulObj.usd_per_unit + (rawRevHeadhaulObj.bond_included === true ? 0 : rawRevHeadhaulObj.bond_usd_per_unit);
            } else if (!Number.isFinite(rawRevHeadhaulObj.usd_per_unit)) {
              const a4Rev = computeHeadhaulWithA4Rules(rawRevHeadhaulObj, fxVal, orderUnits, {
                isR58: true,
                isR59: true,
              });
              if (!a4Rev?.missing_surcharge_quote && Number.isFinite(a4Rev?.amount_usd)) {
                resolvedRevHeadhaulUsd = a4Rev.amount_usd;
              }
            }
          }
          if (!hasGoodsTotal || !hasDomFreight || !Number.isFinite(resolvedRevHeadhaulUsd)) {
            const pendingReason = !hasGoodsTotal
              ? 'Missing goods_cny_total on 1688 quote.'
              : (!hasDomFreight
                ? 'Missing domestic_freight_cny_total to 广东深圳; domestic freight is never assumed ¥0.'
                : 'Missing verified headhaul_usd or complete structured A4 headhaul inputs; headhaul is never assumed $2.20.');
            reverseSolution = {
              actual_complete_sets_used: orderUnits,
              min_retail_price_for_30pct_usd: null,
              mature_band_comparison: 'pending_freight_or_headhaul_verification',
              solution: {
                status: !hasDomFreight ? 'pending_domestic_freight' : 'needs_calculator_verification',
                reason: pendingReason,
                feasible_min_price_usd: null,
              },
            };
          } else {
            const landedCnyPerUnit = (Number(qObj.goods_cny_total) + Number(qObj.domestic_freight_cny_total)) / orderUnits;
            const solved = solveMinPriceForMargin2027({
              pkg: pkgObj,
              landed_domestic_cny: landedCnyPerUnit,
              headhaul_usd: resolvedRevHeadhaulUsd,
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
            const boundSingleBatch = attachStoreDiscoveryProvenance(structuredClone(singleBatchSrc), store);
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

      throw new Phase2CliError(`未知命令：${command}\n${USAGE.trim()}`);
    } finally {
      store.close();
    }
  } catch (error) {
    const rawMsg = error instanceof Phase2CliError || error instanceof TypeError || error instanceof Error
      ? error.message
      : '执行失败。';
    const message = sanitizeDiagnosticText(rawMsg);
    streams.stderr.write(`Phase 2 CLI 失败：${message}\n`);
    return 2;
  }
}

const isDirectPhase2CliEntry = (() => {
  if (!process.argv[1]) return false;
  const selfPath = fileURLToPath(import.meta.url);
  if (resolve(process.argv[1]) === selfPath) return true;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(selfPath);
  } catch {
    return false;
  }
})();
if (isDirectPhase2CliEntry) {
  process.exitCode = await runPhase2Cli();
}
