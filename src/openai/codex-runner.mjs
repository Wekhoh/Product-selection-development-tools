/**
 * Subscription-backed local `Codex CLI` (`codex exec`) adapter ($0 OpenAI API credit spend).
 * Used for Gate 4 Hostile Red-Team Card Audit (`evidence-review-draft-v1`) and Gate 2 Finalist Deep Review.
 *
 * Security & Isolation Invariants:
 *  - Spawns `codex` directly via `node:child_process.spawn` (`shell: false`, `windowsHide: true`); NEVER interpolates shell strings.
 *  - Strictly separates `testMode === true` (requiring an explicit in-process `mockExecutor` or test `spawnImpl !== spawn`,
 *    NEVER launching real OS processes) from `testMode === false` (forbidding `mockExecutor`/`spawnImpl` overrides and
 *    requiring `$CODEX_HOME/auth.json` OAuth readiness + narrow approved installation root resolution on every spawn).
 *  - Resolves Windows `.exe` / npm `.cmd` entrypoints safely from filtered absolute `PATH` directories with `realpathSync`
 *    containment checks on BOTH the shim AND the final entrypoint AND any `where.exe` fallback hit.
 *  - Enforces mandatory PII/secret guards on BOTH `prompt` and `schema`, rejects unsupported JSON Schema keywords upfront
 *    (`UNSUPPORTED_JSON_SCHEMA_KEYWORD`), and executes closed-evidence `runCodexEvidenceReview` inside a `0o700` temp sandbox
 *    with shell/exec/filesystem/network/MCP tools explicitly disabled.
 *  - Publishes atomic, readback-verified private execution receipts (`wx` temp + link/rename + SHA-256 readback) storing
 *    exact untrimmed `raw_output_original_base64` + `raw_output_sha256` and `execution_provenance`, verified by
 *    `verifySavedCodexReceipt`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix as pathPosix,
  relative,
  resolve,
  win32 as pathWin32,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoRawPii,
  containsSecretToken,
  detectRawPii,
  sanitizeDiagnosticText,
} from '../contracts.mjs';
import { canonicalJson, sha256Hex } from '../store.mjs';
import { generatePiiSafeUuid, isPlainObject } from '../utils/objects.mjs';
import {
  ALLOWED_GATE4_EFFORTS,
  MAX_RECEIPT_FILE_BYTES,
  formatReviewerLabel,
  getDefaultTestReceiptStoreDir,
  verifySavedCodexReceipt,
} from '../receipt-verifier.mjs';
import {
  assertSupportedStrictJsonSchema,
  validateJsonAgainstStrictSchema,
} from '../utils/json-schema.mjs';
import {
  EVIDENCE_REVIEW_JSON_SCHEMA,
  SCHEMA_VERSION,
  buildEvidenceReviewPrompt,
  freezeEvidenceReviewPacket,
  validateEvidenceReviewOutput,
} from './evidence-review.mjs';
import { BUSINESS_THRESHOLDS } from '../business-thresholds.mjs';

export const DEFAULT_CODEX_MODEL = 'gpt-6.2-astra';
export const DEFAULT_CODEX_SERVICE_TIER = BUSINESS_THRESHOLDS.codex_default_service_tier;
export const DEFAULT_CODEX_REASONING_EFFORT = BUSINESS_THRESHOLDS.codex_default_reasoning_effort;
export const ALLOWED_CODEX_EFFORTS = Object.freeze(['high', 'xhigh', 'max']);
export const ALLOWED_CODEX_WEB_SEARCH = Object.freeze(['disabled', 'live']);
export const ALLOWED_CODEX_SERVICE_TIERS = Object.freeze(['default', 'standard', 'fast', 'ultrafast']);
export const ALLOWED_CODEX_IMAGE_EXTS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_ENTITLEMENT_STDERR_CHARS = 2048;
const MODULE_WORKSPACE_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const ULTRAFAST_ENTITLEMENT_ERROR_RE =
  /\b(?:service[_ -]?tier|tier)\b[^\r\n]{0,80}\b(?:not\s+(?:supported|allowed|available|enabled|entitled)|unsupported|invalid_value|requires\s+pro(?:-?500)?)/i;
const CODEX_USER_PROMPT_ECHO_BLOCK_RE =
  /^-{4,}\nuser\n[\s\S]*?(?=^(?:warning:|mcp(?:\s+startup)?:|hook:\s*SessionStart\b|ERROR\b|error:|codex$|thinking$|assistant$|exec$|tool_call\b|hook:\s*PreToolUse\b|turn\/start|tokens\s+used\b))/im;
const CODEX_STARTUP_BANNER_LINE_RE =
  /^\s*(?:OpenAI\s+Codex\b.*|-{4,}|(?:workdir|model|provider|approval|sandbox|reasoning\s+effort|reasoning\s+summaries|session\s+id|mcp(?:\s+startup)?)\s*:.*|warning:\s*(?:Codex\s+is\s+ignoring|Under-development\s+features\s+enabled).*|user\s*\([^\r\n]*is\s+ignored\.|hook:\s*SessionStart(?:\s+Completed)?\s*)$/gim;
const TRANSPORT_OR_TURN_STARTED_STDERR_RE =
  /\b(?:connection|connect|network|socket|dns|tls|ssl|timeout|timed\s+out|reset|econn\w*|etimedout|enotfound|ehostunreach|epipe|(?:http[\/\s]*\d*(?:\.\d+)?\s+|status(?:\s+code)?[:=\s]+)50[0234]|5\d\d\s+(?:bad|service|gateway|internal)|turn\/start(?:ed)?|turn\/complet(?:ed)?|stream(?:ing)?|disconnected|aborted|hang\s*up|rate[_ -]?limit|429)\b/i;
const GENERATION_PROGRESS_MARKER_RE =
  /(?:^\s*(?:codex|thinking|assistant|exec)\s*$|\b(?:thinking|assistant|tool_call|exec_command|hook:\s*PreToolUse|turn\/completed|turn\/started|turn\/start|tokens\s+used)\b)/im;

function extractPostEchoCodexDiagnosticStderr(stderrText, promptText = '') {
  if (typeof stderrText !== 'string' || !stderrText) return '';
  let norm = stderrText.replace(/\r\n/g, '\n');
  norm = norm.replace(CODEX_USER_PROMPT_ECHO_BLOCK_RE, '');
  if (typeof promptText === 'string' && promptText.trim().length > 0) {
    const normPrompt = promptText.replace(/\r\n/g, '\n').trim();
    if (normPrompt.length > 0) {
      const userEchoNeedle = `\nuser\n${normPrompt}`;
      const idx = norm.indexOf(userEchoNeedle);
      if (idx !== -1) {
        norm = norm.slice(0, idx) + norm.slice(idx + userEchoNeedle.length);
      }
    }
  }
  return norm.replace(CODEX_STARTUP_BANNER_LINE_RE, '').trim();
}

export class CodexRunnerError extends Error {
  constructor(message, {
    code = 'CODEX_EXEC_ERROR',
    exitCode = null,
    signal = null,
    timedOut = false,
    terminationUncertain = false,
    tierFallbackUsed = false,
    rawOutputSha256 = null,
    receiptSha256 = null,
    executionProvenance = null,
    privateReceiptRef = null,
    privateRetainedRef = null,
    firstAttemptReceiptSha256 = null,
    stderr = '',
    retainedArtifactDir = null,
    retainedOutputPath = null,
  } = {}) {
    super(sanitizeDiagnosticText(message));
    this.name = 'CodexRunnerError';
    this.code = code;
    this.exitCode = exitCode;
    this.signal = signal;
    this.timedOut = Boolean(timedOut);
    this.terminationUncertain = Boolean(terminationUncertain);
    this.tierFallbackUsed = Boolean(tierFallbackUsed);
    this.rawOutputSha256 = rawOutputSha256 ?? null;
    this.receiptSha256 = receiptSha256 ?? null;
    this.executionProvenance = executionProvenance ?? null;
    this.privateReceiptRef = privateReceiptRef ?? null;
    this.privateRetainedRef = privateRetainedRef ?? null;
    this.firstAttemptReceiptSha256 = firstAttemptReceiptSha256 ?? null;
    this.stderr = sanitizeDiagnosticText(stderr);
    this.retainedArtifactDir = retainedArtifactDir ?? null;
    this.retainedOutputPath = retainedOutputPath ?? null;
  }
}

function isTrustedAbsolutePath(candidatePath, platform = process.platform) {
  if (typeof candidatePath !== 'string') return false;
  const trimmed = candidatePath.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) return false;
  if (platform === 'win32') {
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\[^\\/?*]+\\[^\\/?*]+/.test(trimmed)) {
      return true;
    }
    if (process.platform !== 'win32' && pathPosix.isAbsolute(trimmed)) {
      return true;
    }
    return false;
  }
  return pathPosix.isAbsolute(trimmed);
}

function isWinStylePath(p) {
  return typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p));
}

function isInsideDirectory(parentDir, candidatePath, platform = process.platform) {
  const parentWin = isWinStylePath(parentDir);
  const candWin = isWinStylePath(candidatePath);
  if (parentWin !== candWin) return false;
  if (parentWin) {
    const rel = pathWin32.relative(pathWin32.resolve(parentDir).toLowerCase(), pathWin32.resolve(candidatePath).toLowerCase());
    return Boolean(rel) && rel !== '.' && !rel.startsWith('..') && !pathWin32.isAbsolute(rel);
  }
  if (platform !== 'win32' || (typeof parentDir === 'string' && parentDir.startsWith('/'))) {
    const rel = pathPosix.relative(pathPosix.resolve(parentDir), pathPosix.resolve(candidatePath));
    return Boolean(rel) && rel !== '.' && !rel.startsWith('..') && !pathPosix.isAbsolute(rel);
  }
  const rel = relative(resolve(parentDir), resolve(candidatePath));
  return Boolean(rel) && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel);
}

function isSameDirectory(dirA, dirB, platform = process.platform) {
  const aWin = isWinStylePath(dirA);
  const bWin = isWinStylePath(dirB);
  if (aWin !== bWin) return false;
  if (aWin) {
    return pathWin32.resolve(dirA).toLowerCase() === pathWin32.resolve(dirB).toLowerCase();
  }
  if (platform !== 'win32' || (typeof dirA === 'string' && dirA.startsWith('/'))) {
    return pathPosix.resolve(dirA) === pathPosix.resolve(dirB);
  }
  return resolve(dirA) === resolve(dirB);
}

function isSameOrInsideDirectory(parentDir, candidatePath, platform = process.platform) {
  return isSameDirectory(parentDir, candidatePath, platform) || isInsideDirectory(parentDir, candidatePath, platform);
}

function joinForPlatform(platform, ...segments) {
  if (isWinStylePath(segments[0])) {
    return pathWin32.join(...segments);
  }
  if (platform !== 'win32' || (typeof segments[0] === 'string' && segments[0].startsWith('/'))) {
    return pathPosix.join(...segments);
  }
  return join(...segments);
}

function resolveForPlatform(platform, ...segments) {
  if (isWinStylePath(segments[0])) {
    return pathWin32.resolve(...segments);
  }
  if (platform !== 'win32' || (typeof segments[0] === 'string' && segments[0].startsWith('/'))) {
    return pathPosix.resolve(...segments);
  }
  return resolve(...segments);
}

function dirnameForPlatform(platform, p) {
  if (isWinStylePath(p)) {
    return pathWin32.dirname(p);
  }
  if (platform !== 'win32' || (typeof p === 'string' && p.startsWith('/'))) {
    return pathPosix.dirname(p);
  }
  return dirname(p);
}

function resolveVendorExeUnderDir(shimDir, arch, fsImpl, platform = 'win32') {
  const winTarget = arch === 'arm64'
    ? { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
    : { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' };
  const directVendorExe = joinForPlatform(
    platform,
    shimDir,
    'node_modules',
    ...winTarget.pkg.split('/'),
    'vendor',
    winTarget.triple,
    'bin',
    'codex.exe',
  );
  if (fsImpl.existsSync(directVendorExe)) return directVendorExe;

  const nestedVendorExe = joinForPlatform(
    platform,
    shimDir,
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    ...winTarget.pkg.split('/'),
    'vendor',
    winTarget.triple,
    'bin',
    'codex.exe',
  );
  if (fsImpl.existsSync(nestedVendorExe)) return nestedVendorExe;
  return null;
}

function safeResolveRealOrLexical(candidatePath, realpathFn, platform) {
  const lexical = resolveForPlatform(platform, candidatePath);
  try {
    return realpathFn(lexical);
  } catch {
    return lexical;
  }
}


function resolveNpmCmdShimTarget(cmdPath, {
  arch = process.arch,
  execPath = process.execPath,
  fsImpl = { existsSync, readFileSync, realpathSync },
  platform = 'win32',
} = {}) {
  const realpathFn = typeof fsImpl.realpathSync === 'function'
    ? fsImpl.realpathSync.bind(fsImpl)
    : realpathSync;

  let realShimPath;
  try {
    realShimPath = realpathFn(resolveForPlatform(platform, cmdPath));
  } catch {
    throw new CodexRunnerError(
      'Refusing to execute Windows .cmd/.bat shim: unable to resolve realpath of shim file.',
      { code: 'CODEX_UNSAFE_SHIM' },
    );
  }

  const lexicalShimDir = dirnameForPlatform(platform, resolveForPlatform(platform, cmdPath));
  let realShimDir;
  try {
    realShimDir = realpathFn(lexicalShimDir);
  } catch {
    throw new CodexRunnerError(
      'Refusing to execute Windows .cmd/.bat shim: unable to resolve realpath of shim directory.',
      { code: 'CODEX_UNSAFE_SHIM' },
    );
  }

  if (!isSameDirectory(dirnameForPlatform(platform, realShimPath), realShimDir, platform)) {
    throw new CodexRunnerError(
      'Refusing to execute Windows .cmd/.bat shim: shim file escapes shim directory via symlink.',
      { code: 'CODEX_UNSAFE_SHIM' },
    );
  }

  const verifyContainedRealTarget = (targetPath) => {
    let realTarget;
    try {
      realTarget = realpathFn(targetPath);
    } catch {
      throw new CodexRunnerError(
        'Refusing to execute Windows .cmd/.bat shim: unable to resolve target realpath.',
        { code: 'CODEX_UNSAFE_SHIM' },
      );
    }
    if (!isInsideDirectory(realShimDir, realTarget, platform)) {
      throw new CodexRunnerError(
        'Refusing to execute Windows .cmd/.bat shim: resolved target escapes shim directory via junction or symlink.',
        { code: 'CODEX_UNSAFE_SHIM' },
      );
    }
    return realTarget;
  };

  const vendorExe = resolveVendorExeUnderDir(lexicalShimDir, arch, fsImpl, platform);
  if (vendorExe) {
    const realVendorExe = verifyContainedRealTarget(vendorExe);
    return {
      command: realVendorExe,
      prefixArgs: [],
      resolvedShimPath: realShimPath,
      resolvedTargetPath: realVendorExe,
    };
  }

  const standardCodexJs = joinForPlatform(platform, lexicalShimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fsImpl.existsSync(standardCodexJs)) {
    const realStandardJs = verifyContainedRealTarget(standardCodexJs);
    return {
      command: execPath,
      prefixArgs: [realStandardJs],
      resolvedShimPath: realShimPath,
      resolvedTargetPath: realStandardJs,
    };
  }

  let shimText = null;
  try {
    shimText = fsImpl.readFileSync(cmdPath, 'utf8');
  } catch {
    shimText = null;
  }

  if (typeof shimText === 'string') {
    const match = shimText.match(/"%dp0%[\\/]([^"\r\n]+?\.(?:m?js|cjs))"/i);
    if (match) {
      const candidateJs = resolveForPlatform(platform, lexicalShimDir, match[1]);
      if (!isInsideDirectory(lexicalShimDir, candidateJs, platform)) {
        throw new CodexRunnerError(
          'Refusing to execute Windows .cmd/.bat shim: %dp0% script reference escapes shim directory.',
          { code: 'CODEX_UNSAFE_SHIM' },
        );
      }
      if (fsImpl.existsSync(candidateJs)) {
        const realCandidateJs = verifyContainedRealTarget(candidateJs);
        return {
          command: execPath,
          prefixArgs: [realCandidateJs],
          resolvedShimPath: realShimPath,
          resolvedTargetPath: realCandidateJs,
        };
      }
    }
  }

  throw new CodexRunnerError(
    'Refusing to execute Windows .cmd/.bat shim via shell=true; no safe .exe or Node .js entrypoint found.',
    { code: 'CODEX_UNSAFE_SHIM' },
  );
}

/**
 * Safely resolve `codex` executable from trusted absolute paths without `shell: true` or relative/CWD fallback.
 * When `testMode !== true`, resolves `realpathSync` on EVERY candidate (BOTH shim AND final entrypoint) and enforces
 * narrow approved installation root containment + `pathDirs` membership on `where.exe` fallback hits.
 */
export function resolveCodexCommand(codexBin = 'codex', {
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  execPath = process.execPath,
  fsImpl = { existsSync, readFileSync, realpathSync },
  whereLookup = null,
  testMode = false,
  cwd = process.cwd(),
  tempDirRoot = tmpdir(),
} = {}) {
  if (typeof testMode !== 'boolean') {
    throw new TypeError('testMode must be a boolean.');
  }
  const effectiveBinInput =
    (codexBin === undefined || codexBin === null || codexBin === 'codex') &&
    typeof env?.CODEX_BIN === 'string' &&
    env.CODEX_BIN.trim()
      ? env.CODEX_BIN
      : codexBin;
  if (typeof effectiveBinInput !== 'string' || !effectiveBinInput.trim() || /[\0\r\n]/.test(effectiveBinInput)) {
    throw new TypeError('codexBin must be a nonempty single-line executable name or path.');
  }
  const realpathFn = typeof fsImpl.realpathSync === 'function'
    ? fsImpl.realpathSync.bind(fsImpl)
    : realpathSync;

  const requireCandidateRealpath = (candidatePath) => {
    try {
      return realpathFn(candidatePath);
    } catch {
      throw new CodexRunnerError(
        'Unable to resolve realpath of Codex executable candidate.',
        { code: 'CODEX_BIN_NOT_FOUND' },
      );
    }
  };

  const finalizeResolved = ({ command, prefixArgs, resolvedShimPath = null, resolvedTargetPath }) => {
    if (testMode !== true && typeof cwd === 'string' && isTrustedAbsolutePath(cwd, platform)) {
      const realCwd = safeResolveRealOrLexical(cwd.trim(), realpathFn, platform);
      if (isSameOrInsideDirectory(realCwd, resolvedTargetPath, platform)) {
        throw new CodexRunnerError('Refusing to execute Codex binary directly from current working directory.', {
          code: 'CODEX_BIN_NOT_FOUND',
        });
      }
    }
    const protectedPaths = [];
    for (const p of [resolvedShimPath, resolvedTargetPath, command]) {
      if (typeof p === 'string' && p.trim() && !protectedPaths.includes(p)) {
        protectedPaths.push(p);
      }
    }
    return {
      command,
      prefixArgs,
      resolvedShimPath,
      resolvedTargetPath,
      protectedPaths,
    };
  };

  const trimmed = effectiveBinInput.trim();
  const lowerExt = extname(trimmed).toLowerCase();
  const hasPathSep = trimmed.includes('\\') || trimmed.includes('/');
  const hasExplicitExt = ['.exe', '.cmd', '.bat', '.js', '.mjs', '.cjs'].includes(lowerExt);

  if (hasPathSep || hasExplicitExt) {
    if (!isTrustedAbsolutePath(trimmed, platform)) {
      throw new CodexRunnerError(
        `Refusing relative codexBin "${trimmed}"; provide an absolute executable path or bare binary name.`,
        { code: 'CODEX_BIN_NOT_FOUND' },
      );
    }

    if (platform !== 'win32') {
      if (!fsImpl.existsSync(trimmed)) {
        throw new CodexRunnerError('Explicit Codex binary was not found on disk.', {
          code: 'CODEX_BIN_NOT_FOUND',
        });
      }
      const realTarget = requireCandidateRealpath(trimmed);
      if (lowerExt === '.js' || lowerExt === '.mjs' || lowerExt === '.cjs') {
        return finalizeResolved({ command: execPath, prefixArgs: [realTarget], resolvedTargetPath: realTarget });
      }
      return finalizeResolved({ command: realTarget, prefixArgs: [], resolvedTargetPath: realTarget });
    }

    if (lowerExt === '.cmd' || lowerExt === '.bat') {
      if (!fsImpl.existsSync(trimmed)) {
        throw new CodexRunnerError('Explicit Windows Codex .cmd/.bat shim does not exist.', {
          code: 'CODEX_BIN_NOT_FOUND',
        });
      }
      return finalizeResolved(resolveNpmCmdShimTarget(trimmed, { arch, execPath, fsImpl, platform }));
    }
    if (lowerExt === '.js' || lowerExt === '.mjs' || lowerExt === '.cjs') {
      if (!fsImpl.existsSync(trimmed)) {
        throw new CodexRunnerError('Explicit Codex Node entrypoint script does not exist.', {
          code: 'CODEX_BIN_NOT_FOUND',
        });
      }
      const realTarget = requireCandidateRealpath(trimmed);
      return finalizeResolved({ command: execPath, prefixArgs: [realTarget], resolvedTargetPath: realTarget });
    }
    if (lowerExt === '.exe') {
      if (!fsImpl.existsSync(trimmed)) {
        throw new CodexRunnerError('Explicit Windows Codex .exe binary does not exist.', {
          code: 'CODEX_BIN_NOT_FOUND',
        });
      }
      const realTarget = requireCandidateRealpath(trimmed);
      return finalizeResolved({ command: realTarget, prefixArgs: [], resolvedTargetPath: realTarget });
    }

    if (fsImpl.existsSync(`${trimmed}.exe`)) {
      const realTarget = requireCandidateRealpath(`${trimmed}.exe`);
      return finalizeResolved({ command: realTarget, prefixArgs: [], resolvedTargetPath: realTarget });
    }
    if (fsImpl.existsSync(`${trimmed}.cmd`)) {
      return finalizeResolved(resolveNpmCmdShimTarget(`${trimmed}.cmd`, { arch, execPath, fsImpl, platform }));
    }
    if (fsImpl.existsSync(trimmed)) {
      const realTarget = requireCandidateRealpath(trimmed);
      return finalizeResolved({ command: realTarget, prefixArgs: [], resolvedTargetPath: realTarget });
    }
    throw new CodexRunnerError('Explicit Codex executable path does not exist.', {
      code: 'CODEX_BIN_NOT_FOUND',
    });
  }

  const rawPath = env?.PATH ?? env?.Path ?? env?.path ?? '';
  const pathSep = platform === 'win32'
    ? (String(rawPath).includes(';') ? ';' : (process.platform === 'win32' ? ';' : ':'))
    : ':';
  const pathDirs = String(rawPath)
    .split(pathSep)
    .map(p => p.trim().replace(/^"+|"+$/g, ''))
    .filter(p => Boolean(p) && isTrustedAbsolutePath(p, platform));

  if (platform !== 'win32') {
    for (const dir of pathDirs) {
      const candidate = pathPosix.join(dir, trimmed);
      if (fsImpl.existsSync(candidate)) {
        const realTarget = requireCandidateRealpath(candidate);
        return finalizeResolved({
          command: realTarget,
          prefixArgs: [],
          resolvedShimPath: pathPosix.resolve(candidate),
          resolvedTargetPath: realTarget,
        });
      }
    }
    throw new CodexRunnerError(
      `Unable to find "${trimmed}" in any trusted absolute PATH directory.`,
      { code: 'CODEX_BIN_NOT_FOUND' },
    );
  }

  for (const dir of pathDirs) {
    const exeCandidate = joinForPlatform('win32', dir, `${trimmed}.exe`);
    if (fsImpl.existsSync(exeCandidate)) {
      const realTarget = requireCandidateRealpath(exeCandidate);
      return finalizeResolved({
        command: realTarget,
        prefixArgs: [],
        resolvedShimPath: realTarget,
        resolvedTargetPath: realTarget,
      });
    }
    const cmdCandidate = joinForPlatform('win32', dir, `${trimmed}.cmd`);
    if (fsImpl.existsSync(cmdCandidate)) {
      return finalizeResolved(resolveNpmCmdShimTarget(cmdCandidate, { arch, execPath, fsImpl, platform: 'win32' }));
    }
  }

  const resolvedAllowedPathDirs = [];
  for (const dir of pathDirs) {
    const lexDir = resolveForPlatform('win32', dir);
    resolvedAllowedPathDirs.push(lexDir);
    const realDir = safeResolveRealOrLexical(dir, realpathFn, 'win32');
    if (!isSameDirectory(lexDir, realDir, 'win32')) {
      resolvedAllowedPathDirs.push(realDir);
    }
  }
  const belongsToFilteredPathDirs = (hitPath) => {
    const hitParentLex = dirnameForPlatform('win32', resolveForPlatform('win32', hitPath));
    const hitParentReal = dirnameForPlatform('win32', safeResolveRealOrLexical(hitPath, realpathFn, 'win32'));
    return resolvedAllowedPathDirs.some(
      allowedDir =>
        isSameDirectory(allowedDir, hitParentLex, 'win32') ||
        isSameDirectory(allowedDir, hitParentReal, 'win32'),
    );
  };

  const sanitizedWhereEnv = buildAllowlistedChildEnv(env);
  sanitizedWhereEnv.PATH = pathDirs.join(';');
  const rawSysRoot = sanitizedWhereEnv.SystemRoot || sanitizedWhereEnv.SYSTEMROOT || 'C:\\Windows';
  const safeSysRoot = isTrustedAbsolutePath(rawSysRoot, 'win32') ? rawSysRoot.trim() : 'C:\\Windows';
  const whereExe = joinForPlatform('win32', safeSysRoot, 'System32', 'where.exe');

  if (pathDirs.length > 0 && (typeof whereLookup === 'function' || fsImpl.existsSync(whereExe))) {
    const lookupFn = whereLookup ?? ((binName, lookupEnv) => execFileSync(whereExe, [`$PATH:${binName}`], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 3000,
      env: lookupEnv,
    }));
    let lines = [];
    try {
      lines = String(lookupFn(trimmed, sanitizedWhereEnv) || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l =>
          Boolean(l) &&
          isTrustedAbsolutePath(l, 'win32') &&
          fsImpl.existsSync(l) &&
          belongsToFilteredPathDirs(l),
        );
    } catch {
      lines = [];
    }
    const exeHit = lines.find(l => l.toLowerCase().endsWith('.exe'));
    if (exeHit) {
      const realTarget = requireCandidateRealpath(exeHit);
      if (!belongsToFilteredPathDirs(realTarget)) {
        throw new CodexRunnerError(
          'where.exe fallback resolved outside filtered PATH directories.',
          { code: 'CODEX_BIN_NOT_FOUND' },
        );
      }
      return finalizeResolved({
        command: realTarget,
        prefixArgs: [],
        resolvedShimPath: realTarget,
        resolvedTargetPath: realTarget,
      });
    }
    const cmdHit = lines.find(l => l.toLowerCase().endsWith('.cmd') || l.toLowerCase().endsWith('.bat'));
    if (cmdHit) {
      const resolvedShim = resolveNpmCmdShimTarget(cmdHit, { arch, execPath, fsImpl, platform: 'win32' });
      if (!belongsToFilteredPathDirs(resolvedShim.resolvedShimPath)) {
        throw new CodexRunnerError(
          'where.exe shim fallback resolved outside filtered PATH directories.',
          { code: 'CODEX_BIN_NOT_FOUND' },
        );
      }
      return finalizeResolved(resolvedShim);
    }
  }

  throw new CodexRunnerError(
    `Unable to locate verified absolute Windows executable for "${trimmed}" in trusted PATH.`,
    { code: 'CODEX_BIN_NOT_FOUND' },
  );
}

const OPENAI_PAID_BILLING_ENV_RE = /^(?:OPENAI_(?:API_KEY|BASE_URL|ORG_ID|PROJECT_ID|API_BASE)|CODEX_API_KEY)$/i;

function buildAllowlistedChildEnv(sourceEnv) {
  const out = {};
  if (!sourceEnv || typeof sourceEnv !== 'object') return out;

  // Inherit full host process.env (preserving proxies incl. ALL_PROXY, Windows env, and all non-OpenAI MCP configs),
  // stripping ONLY OpenAI/Codex paid API billing variables (incl. CODEX_API_KEY) so `codex exec` strictly uses local subscription OAuth ($0 API spend).
  for (const [rawKey, rawVal] of Object.entries(sourceEnv)) {
    if (rawVal === undefined || rawVal === null) continue;
    if (OPENAI_PAID_BILLING_ENV_RE.test(rawKey)) continue;
    const strVal = String(rawVal);
    if (strVal.includes('\0')) continue;
    out[rawKey] = strVal;
  }

  return out;
}

export function verifyCodexSubscriptionReady(childEnv, fsImpl = { existsSync, readFileSync, statSync }) {
  const homeBase = childEnv?.CODEX_HOME || (
    (childEnv?.USERPROFILE || childEnv?.HOME)
      ? join(childEnv.USERPROFILE || childEnv.HOME, '.codex')
      : ''
  );
  if (typeof homeBase !== 'string' || !homeBase.trim()) {
    throw new CodexRunnerError(
      'Codex CLI subscription authentication requires CODEX_HOME (or USERPROFILE/HOME) pointing to a valid .codex directory.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }

  const authPath = join(homeBase.trim(), 'auth.json');
  if (!fsImpl.existsSync(authPath)) {
    throw new CodexRunnerError(
      'Codex CLI subscription auth.json was not found under CODEX_HOME; sign in with subscription OAuth before execution.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }

  let rawText;
  try {
    if (typeof fsImpl.statSync === 'function') {
      const st = fsImpl.statSync(authPath);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_AUTH_FILE_BYTES) {
        throw new Error('Invalid auth.json file stats.');
      }
    }
    rawText = fsImpl.readFileSync(authPath, 'utf8');
  } catch {
    throw new CodexRunnerError(
      'Codex CLI subscription auth.json is unreadable or invalid.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new CodexRunnerError(
      'Codex CLI auth.json is not valid JSON.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexRunnerError(
      'Codex CLI auth.json root must be a JSON object.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }

  if (typeof parsed.auth_mode === 'string' && /^api[_-]?key$/i.test(parsed.auth_mode.trim())) {
    throw new CodexRunnerError(
      'Codex CLI auth.json is configured for API-key mode; subscription/OAuth mode is required for $0 API spend.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }

  for (const apiKeyField of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'api_key', 'apiKey']) {
    if (typeof parsed[apiKeyField] === 'string' && parsed[apiKeyField].trim().length > 0) {
      throw new CodexRunnerError(
        'Codex CLI auth.json contains an explicit API key; clear API keys and use subscription/OAuth auth.',
        { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
      );
    }
  }

  const tokensObj = parsed.tokens && typeof parsed.tokens === 'object' && !Array.isArray(parsed.tokens)
    ? parsed.tokens
    : null;
  const candidateTokenValues = [
    tokensObj?.access_token,
    tokensObj?.refresh_token,
    tokensObj?.id_token,
    parsed.access_token,
    parsed.refresh_token,
    parsed.id_token,
    parsed.oauth_token,
    parsed.subscription_token,
  ];
  const hasSubscriptionToken = candidateTokenValues.some(
    v => typeof v === 'string' && v.trim().length > 0,
  );

  if (!hasSubscriptionToken) {
    throw new CodexRunnerError(
      'Codex CLI auth.json lacks subscription/OAuth token fields; sign in with subscription OAuth before running.',
      { code: 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' },
    );
  }
}

function hasValidRasterMagicBytes(buf, lowerExt) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  if (lowerExt === '.png') {
    return (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (lowerExt === '.jpg' || lowerExt === '.jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (lowerExt === '.webp') {
    return (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

/**
 * Validate raster image attachments (extension, regular file bounds, PNG/JPEG/WEBP magic bytes)
 * and hash the exact read `Buffer` so downstream sandbox staging uses immutable verified bytes.
 */
export function validateImageAttachments(imagePaths) {
  if (imagePaths === undefined || imagePaths === null) return [];
  if (!Array.isArray(imagePaths)) {
    throw new TypeError('imagePaths must be an array of local image file paths.');
  }
  const attachments = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const rawPath = imagePaths[i];
    if (typeof rawPath !== 'string' || !rawPath.trim() || /[\0\r\n]/.test(rawPath)) {
      throw new TypeError(`imagePaths[${i}] must be a nonempty file path string.`);
    }
    const ext = extname(rawPath.trim()).toLowerCase();
    if (!ALLOWED_CODEX_IMAGE_EXTS.includes(ext)) {
      throw new TypeError(
        `imagePaths[${i}] has unsupported extension "${ext}"; allowed extensions: ${ALLOWED_CODEX_IMAGE_EXTS.join(', ')}.`,
      );
    }
    const absPath = resolve(rawPath.trim());
    let st;
    try {
      st = statSync(absPath);
    } catch {
      throw new CodexRunnerError(`Image attachment imagePaths[${i}] does not exist.`, {
        code: 'CODEX_IMAGE_NOT_FOUND',
      });
    }
    if (!st.isFile() || st.size <= 0) {
      throw new CodexRunnerError(`Image attachment imagePaths[${i}] must be a non-empty regular file.`, {
        code: 'CODEX_IMAGE_INVALID',
      });
    }
    if (st.size > MAX_IMAGE_BYTES) {
      throw new RangeError(`Image attachment imagePaths[${i}] exceeds 25 MiB limit.`);
    }
    const bytesBuffer = readFileSync(absPath);
    if (bytesBuffer.length <= 0) {
      throw new CodexRunnerError(`Image attachment imagePaths[${i}] is empty.`, {
        code: 'CODEX_IMAGE_INVALID',
      });
    }
    if (bytesBuffer.length > MAX_IMAGE_BYTES) {
      throw new RangeError(`Image attachment imagePaths[${i}] exceeds 25 MiB limit.`);
    }
    if (!hasValidRasterMagicBytes(bytesBuffer, ext)) {
      throw new CodexRunnerError(
        `Image attachment imagePaths[${i}] failed raster magic-byte verification for "${ext}".`,
        { code: 'CODEX_IMAGE_INVALID' },
      );
    }
    const sha256 = sha256Hex(bytesBuffer);
    attachments.push({
      originalPath: absPath,
      ext,
      bytesBuffer,
      sha256,
      byteSize: bytesBuffer.length,
    });
  }
  return attachments;
}

/**
 * Shared raster admission & immutable staging routine (`P1-07`) used across Codex CLI,
 * injected `reviewExecutor`, and `attachCandidateEvidenceReview`.
 */
export function stageAndHashReviewAttachments(imagePaths = [], {
  stageDir = null,
  expectedSha256s = undefined,
} = {}) {
  const validated = validateImageAttachments(imagePaths);
  const attachmentSha256s = validated.map(a => a.sha256);

  if (expectedSha256s !== undefined && expectedSha256s !== null) {
    if (!Array.isArray(expectedSha256s)) {
      throw new TypeError('expectedSha256s must be an array of SHA-256 digests when provided.');
    }
    const mismatch =
      expectedSha256s.length !== attachmentSha256s.length ||
      expectedSha256s.some((expectedSha, idx) => expectedSha !== attachmentSha256s[idx]);
    if (mismatch) {
      throw new TypeError(
        `Packet attachment_sha256s (${expectedSha256s.length}) does not match the SHA-256 digests of the supplied imagePaths (${attachmentSha256s.length}).`,
      );
    }
  }

  const stagedPaths = [];
  if (stageDir !== null && stageDir !== undefined) {
    if (typeof stageDir !== 'string' || !stageDir.trim() || /[\0\r\n]/.test(stageDir)) {
      throw new TypeError('stageDir must be a nonempty directory path string when provided.');
    }
    const absStageDir = resolve(stageDir.trim());
    mkdirSync(absStageDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(absStageDir, 0o700);
    } catch {
      // Best-effort on Windows NTFS ACLs.
    }
    for (let i = 0; i < validated.length; i++) {
      const att = validated[i];
      const stagedPath = join(absStageDir, `attachment-${i + 1}${att.ext}`);
      writeAtomicExclusiveBytes(stagedPath, att.bytesBuffer);
      stagedPaths.push(stagedPath);
    }
  }

  const buffers = validated.map(a => Buffer.from(a.bytesBuffer));
  const safeDescriptors = validated.map((a, idx) => Object.freeze({
    index: idx,
    ext: a.ext,
    sha256: a.sha256,
    byteSize: a.byteSize,
    stagedPath: stagedPaths[idx] ?? null,
    bytes: Buffer.from(a.bytesBuffer),
  }));

  return Object.freeze({
    attachmentSha256s: Object.freeze(attachmentSha256s),
    stagedPaths: Object.freeze(stagedPaths),
    buffers: Object.freeze(buffers),
    attachments: Object.freeze(safeDescriptors),
    originalPaths: Object.freeze(validated.map(a => a.originalPath)),
  });
}

function createSandboxedArtifactReader(sandboxDir) {
  const realRoot = realpathSync(resolve(sandboxDir));
  return function readSandboxedArtifact(requestedPath, encoding = null) {
    if (typeof requestedPath !== 'string' || !requestedPath.trim() || /[\0\r\n]/.test(requestedPath)) {
      throw new CodexRunnerError('Invalid sandbox artifact path.', { code: 'SANDBOX_OUTSIDE_READ_DENIED' });
    }
    const candidateAbs = isAbsolute(requestedPath.trim())
      ? resolve(requestedPath.trim())
      : resolve(realRoot, requestedPath.trim());
    let realCandidate;
    try {
      realCandidate = realpathSync(candidateAbs);
    } catch {
      if (!isInsideDirectory(realRoot, candidateAbs)) {
        throw new CodexRunnerError(
          'Closed-evidence sandbox denied file access outside sandboxDir.',
          { code: 'SANDBOX_OUTSIDE_READ_DENIED' },
        );
      }
      throw new CodexRunnerError('Requested sandbox artifact does not exist.', {
        code: 'SANDBOX_ARTIFACT_NOT_FOUND',
      });
    }
    if (!isInsideDirectory(realRoot, realCandidate)) {
      throw new CodexRunnerError(
        'Closed-evidence sandbox denied file access outside sandboxDir.',
        { code: 'SANDBOX_OUTSIDE_READ_DENIED' },
      );
    }
    return encoding ? readFileSync(realCandidate, encoding) : readFileSync(realCandidate);
  };
}

function resolveValidatedCwd(cwd) {
  if (cwd === null || cwd === undefined) return null;
  if (typeof cwd !== 'string' || !cwd.trim() || /[\0\r\n]/.test(cwd)) {
    throw new TypeError('cwd must be a valid directory path string.');
  }
  return resolve(cwd.trim());
}

/**
 * Build exact deterministic `codex exec` CLI arguments (without shell interpolation).
 */
export function buildCodexExecArgs({
  model = DEFAULT_CODEX_MODEL,
  reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
  webSearch = 'live',
  serviceTier = DEFAULT_CODEX_SERVICE_TIER,
  imagePaths = [],
  cwd = null,
  skipGitRepoCheck = false,
  sandboxMode = null,
  schemaPath = null,
  outputPath,
}) {
  if (model !== null && model !== undefined && (typeof model !== 'string' || !SAFE_MODEL_ID_RE.test(model.trim()))) {
    throw new TypeError(`Invalid Codex model identifier "${String(model)}".`);
  }
  if (reasoningEffort !== null && reasoningEffort !== undefined && !ALLOWED_CODEX_EFFORTS.includes(reasoningEffort)) {
    throw new TypeError(
      `Unsupported reasoningEffort "${String(reasoningEffort)}"; must be one of ${ALLOWED_CODEX_EFFORTS.join(', ')}.`,
    );
  }
  if (webSearch !== null && webSearch !== undefined && !ALLOWED_CODEX_WEB_SEARCH.includes(webSearch)) {
    throw new TypeError(
      `Unsupported webSearch "${String(webSearch)}"; must be one of ${ALLOWED_CODEX_WEB_SEARCH.join(', ')}.`,
    );
  }
  if (serviceTier !== null && serviceTier !== undefined) {
    if (!ALLOWED_CODEX_SERVICE_TIERS.includes(serviceTier)) {
      throw new TypeError(
        `Unsupported serviceTier "${String(serviceTier)}\"; must be one of ${ALLOWED_CODEX_SERVICE_TIERS.join(', ')}.`,
      );
    }
  }
  if (schemaPath !== null && schemaPath !== undefined && (typeof schemaPath !== 'string' || !schemaPath.trim())) {
    throw new TypeError('schemaPath must be a nonempty string or null.');
  }
  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new TypeError('outputPath is required.');
  }

  // Inherit host ~/.codex/config.toml & configured tools/MCPs directly; keep --ephemeral for clean context isolation.
  const args = [
    'exec',
    '--ephemeral',
  ];
  if (typeof sandboxMode === 'string' && sandboxMode.trim()) {
    args.push('-s', sandboxMode.trim());
  }
  if (typeof model === 'string' && model.trim()) {
    args.push('-m', model.trim());
  }
  if (reasoningEffort !== null && reasoningEffort !== undefined) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  if (webSearch !== null && webSearch !== undefined) {
    args.push('-c', `web_search=${JSON.stringify(webSearch)}`);
  }

  if (serviceTier) {
    const cliServiceTier = serviceTier === 'standard' ? 'default' : serviceTier;
    args.push('-c', `service_tier=${JSON.stringify(cliServiceTier)}`);
  }

  if (cwd !== null && cwd !== undefined) {
    if (typeof cwd !== 'string' || !cwd.trim() || /[\0\r\n]/.test(cwd)) {
      throw new TypeError('cwd must be a valid directory path string.');
    }
    const trimmedCwd = cwd.trim();
    const normalizedCwd = trimmedCwd.startsWith('<') && trimmedCwd.endsWith('>')
      ? trimmedCwd
      : resolve(trimmedCwd);
    args.push('-C', normalizedCwd);
  }

  if (skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }

  for (const imgPath of imagePaths) {
    args.push('-i', imgPath);
  }

  if (typeof schemaPath === 'string' && schemaPath.trim()) {
    args.push('--output-schema', schemaPath);
  }
  args.push('-o', outputPath, '-');
  return args;
}

function redactArgsForReceipt(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const prev = i > 0 ? args[i - 1] : '';
    if (prev === '--output-schema') {
      out.push('<temp_schema_json>');
    } else if (prev === '-o') {
      out.push('<temp_output_json>');
    } else if (prev === '-i') {
      out.push(`<image_attachment_${extname(args[i]).toLowerCase() || '.img'}>`);
    } else if (prev === '-C') {
      out.push('<working_dir>');
    } else {
      out.push(sanitizeDiagnosticText(String(args[i])));
    }
  }
  return out;
}

function defaultQueryWinDescendants(rootPid, env = process.env) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return { verified: false, survivingPids: [] };
  }
  const rawSysRoot = env?.SystemRoot || env?.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows';
  const safeSysRoot = isTrustedAbsolutePath(rawSysRoot, 'win32') ? rawSysRoot.trim() : 'C:\\Windows';
  const psExe = joinForPlatform('win32', safeSysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const filterExpr = `ProcessId = ${rootPid} OR ParentProcessId = ${rootPid}`;
  try {
    const res = spawnSync(
      psExe,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter '${filterExpr}' | Select-Object -ExpandProperty ProcessId) -join ','`,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        timeout: 4000,
        env,
      },
    );
    if (res.error || res.status !== 0) {
      return { verified: false, survivingPids: [] };
    }
    const pids = String(res.stdout || '')
      .split(',')
      .map(s => Number.parseInt(s.trim(), 10))
      .filter(n => Number.isInteger(n) && n > 0);
    return { verified: true, survivingPids: pids };
  } catch {
    return { verified: false, survivingPids: [] };
  }
}

function runMockExecutorOnce({
  mockExecutor,
  args,
  codexArgs,
  prompt,
  schemaJson,
  stagedImagePaths,
  outputFilePath,
  cwd,
  env,
  timeoutMs,
  attemptNumber,
  activeServiceTier,
  fsImpl,
}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(res);
    };

    if (Number.isInteger(timeoutMs) && timeoutMs >= 50) {
      timer = setTimeout(() => {
        finish({
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          terminationUncertain: false,
          spawnError: null,
          stdoutBytes: 0,
          totalStderrBytes: 0,
          stdout: '',
          stderr: '',
        });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    const readArtifact = cwd && existsSync(cwd) ? createSandboxedArtifactReader(cwd) : null;

    Promise.resolve()
      .then(() => mockExecutor({
        args,
        codexArgs,
        promptUtf8: prompt,
        prompt,
        schemaJson,
        stagedImagePaths: [...stagedImagePaths],
        outputFilePath,
        outputPath: outputFilePath,
        cwd,
        env: { ...env },
        attemptNumber,
        serviceTier: activeServiceTier ?? null,
        readSandboxedArtifact: readArtifact,
      }))
      .then((res) => {
        if (settled) return;
        if (isPlainObject(res) && (
          Object.hasOwn(res, 'exitCode') ||
          Object.hasOwn(res, 'stderr') ||
          Object.hasOwn(res, 'stdout') ||
          Object.hasOwn(res, 'timedOut') ||
          Object.hasOwn(res, 'signal') ||
          Object.hasOwn(res, 'terminationUncertain') ||
          Object.hasOwn(res, 'outputText') ||
          Object.hasOwn(res, 'outputBytes')
        )) {
          if (!fsImpl.existsSync(outputFilePath)) {
            if (Buffer.isBuffer(res.outputBytes)) {
              writeFileSync(outputFilePath, res.outputBytes, { mode: 0o600 });
            } else if (typeof res.outputText === 'string') {
              writeFileSync(outputFilePath, res.outputText, { encoding: 'utf8', mode: 0o600 });
            }
          }
          const stdoutStr = typeof res.stdout === 'string' ? res.stdout : '';
          const stderrStr = typeof res.stderr === 'string' ? res.stderr : '';
          finish({
            exitCode: res.exitCode === undefined ? 0 : res.exitCode,
            signal: res.signal ?? null,
            timedOut: Boolean(res.timedOut),
            terminationUncertain: Boolean(res.terminationUncertain),
            spawnError: res.spawnError ?? null,
            stdoutBytes: Buffer.byteLength(stdoutStr, 'utf8'),
            totalStderrBytes: Buffer.byteLength(stderrStr, 'utf8'),
            stdout: stdoutStr.slice(0, MAX_CAPTURE_BYTES),
            stderr: stderrStr.slice(0, MAX_CAPTURE_BYTES),
          });
          return;
        }
        if (!fsImpl.existsSync(outputFilePath)) {
          if (typeof res === 'string') {
            writeFileSync(outputFilePath, res, { encoding: 'utf8', mode: 0o600 });
          } else if (res && typeof res === 'object') {
            writeFileSync(outputFilePath, JSON.stringify(res), { encoding: 'utf8', mode: 0o600 });
          }
        }
        finish({
          exitCode: 0,
          signal: null,
          timedOut: false,
          terminationUncertain: false,
          spawnError: null,
          stdoutBytes: 0,
          totalStderrBytes: 0,
          stdout: '',
          stderr: '',
        });
      })
      .catch((err) => {
        finish({
          exitCode: null,
          signal: null,
          timedOut: false,
          terminationUncertain: false,
          spawnError: err,
          stdoutBytes: 0,
          totalStderrBytes: 0,
          stdout: '',
          stderr: String(err?.message || err),
        });
      });
  });
}

function spawnOnce({
  command,
  args,
  prompt,
  cwd,
  env,
  timeoutMs,
  spawnImpl,
  testMode = false,
  platform = process.platform,
  taskkillImpl = spawnSync,
  killProcessGroupImpl = null,
  winDescendantCheckImpl = null,
}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let childClosed = false;
    let timedOut = false;
    let treeKillUncertain = false;
    let taskkillFailed = false;
    let parentAlreadyExitedAtTimeout = false;
    let spawnErr = null;
    let timer = null;
    let killEscalationTimer = null;
    let postKillGraceTimer = null;
    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedStdoutBytes = 0;
    let totalStdoutBytes = 0;
    let capturedStderrBytes = 0;
    let totalStderrBytes = 0;

    const usePosixProcessGroup =
      platform !== 'win32' && (testMode !== true || typeof killProcessGroupImpl === 'function');
    const useWin32TaskkillTree =
      platform === 'win32' && (testMode !== true || taskkillImpl !== spawnSync || typeof winDescendantCheckImpl === 'function');
    const killGroupFn = killProcessGroupImpl ?? ((negPid, sig) => process.kill(negPid, sig));

    const getTaskkillExePath = () => {
      const rawSysRoot = env?.SystemRoot || env?.SYSTEMROOT || process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
      const safeSysRoot = isTrustedAbsolutePath(rawSysRoot, 'win32') ? rawSysRoot.trim() : 'C:\\Windows';
      return joinForPlatform('win32', safeSysRoot, 'System32', 'taskkill.exe');
    };

    const runWinTaskkillForPid = (targetPid) => {
      const taskkillExe = getTaskkillExePath();
      try {
        const tk = taskkillImpl(taskkillExe, ['/PID', String(targetPid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'pipe',
          timeout: 5000,
          env,
        });
        return Boolean(!tk?.error && tk?.status === 0);
      } catch {
        return false;
      }
    };

    const escalateAndVerifyPosixGroup = (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) {
        treeKillUncertain = true;
        return;
      }
      let groupAlive = false;
      try {
        killGroupFn(-pid, 0);
        groupAlive = true;
      } catch (probeErr) {
        if (probeErr?.code !== 'ESRCH') {
          treeKillUncertain = true;
          groupAlive = true;
        }
      }
      if (!groupAlive) return;

      // Immediate group SIGKILL escalation + re-probe BEFORE resolving!
      try {
        killGroupFn(-pid, 'SIGKILL');
      } catch (killErr) {
        if (killErr?.code !== 'ESRCH') {
          treeKillUncertain = true;
        }
      }
      try {
        killGroupFn(-pid, 0);
        // Process group member STILL alive after SIGKILL!
        treeKillUncertain = true;
      } catch (reprobeErr) {
        if (reprobeErr?.code !== 'ESRCH') {
          treeKillUncertain = true;
        }
      }
    };

    const verifyAndKillWinDescendants = (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) {
        treeKillUncertain = true;
        return;
      }
      const canQueryWinDescendants = typeof winDescendantCheckImpl === 'function' || testMode !== true;
      if (!canQueryWinDescendants) {
        if (taskkillFailed || parentAlreadyExitedAtTimeout) {
          treeKillUncertain = true;
        }
        return;
      }

      const queryFn = winDescendantCheckImpl ?? ((targetPid) => defaultQueryWinDescendants(targetPid, env));
      let check1;
      try {
        check1 = queryFn(pid);
      } catch {
        check1 = { verified: false, survivingPids: [] };
      }
      if (!check1 || check1.verified !== true || !Array.isArray(check1.survivingPids)) {
        treeKillUncertain = true;
        return;
      }
      if (check1.survivingPids.length > 0) {
        for (const survPid of check1.survivingPids) {
          if (Number.isInteger(survPid) && survPid > 0) {
            runWinTaskkillForPid(survPid);
          }
        }
        let check2;
        try {
          check2 = queryFn(pid);
        } catch {
          check2 = { verified: false, survivingPids: [] };
        }
        if (!check2 || check2.verified !== true || !Array.isArray(check2.survivingPids) || check2.survivingPids.length > 0) {
          treeKillUncertain = true;
          return;
        }
      }
      if (
        (taskkillFailed && !parentAlreadyExitedAtTimeout) ||
        (parentAlreadyExitedAtTimeout && typeof winDescendantCheckImpl !== 'function')
      ) {
        treeKillUncertain = true;
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killEscalationTimer) clearTimeout(killEscalationTimer);
      if (postKillGraceTimer) clearTimeout(postKillGraceTimer);
      resolvePromise(result);
    };

    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env,
      ...(usePosixProcessGroup ? { detached: true } : {}),
      ...(cwd ? { cwd } : {}),
    };

    let child;
    try {
      child = spawnImpl(command, args, spawnOpts);
    } catch (err) {
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        terminationUncertain: false,
        spawnError: err,
        stdoutBytes: 0,
        totalStderrBytes: 0,
        stdout: '',
        stderr: String(err?.message || err),
      });
      return;
    }

    if (Number.isInteger(timeoutMs) && timeoutMs >= 50) {
      timer = setTimeout(() => {
        timedOut = true;
        parentAlreadyExitedAtTimeout =
          childClosed ||
          (child.exitCode !== null && child.exitCode !== undefined) ||
          (child.signalCode !== null && child.signalCode !== undefined);
        const hasValidPid = Number.isInteger(child.pid) && child.pid > 0;

        if (useWin32TaskkillTree) {
          if (!hasValidPid) {
            treeKillUncertain = true;
          } else {
            // ALWAYS run `taskkill /T /F /PID <child.pid>` EVEN IF the direct parent already exited!
            const okKill = runWinTaskkillForPid(child.pid);
            if (!okKill) {
              taskkillFailed = true;
              if (!parentAlreadyExitedAtTimeout || (typeof winDescendantCheckImpl !== 'function' && testMode === true)) {
                treeKillUncertain = true;
              }
            }
          }
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        } else if (usePosixProcessGroup) {
          if (!hasValidPid) {
            treeKillUncertain = true;
          } else {
            try {
              killGroupFn(-child.pid, 'SIGTERM');
            } catch (killErr) {
              if (killErr?.code !== 'ESRCH') {
                treeKillUncertain = true;
              }
            }
          }
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        } else {
          if (parentAlreadyExitedAtTimeout) {
            treeKillUncertain = true;
          }
          try { child.kill('SIGTERM'); } catch { /* ignore */ }
        }

        const escalationWaitMs = testMode === true ? 200 : 1500;
        killEscalationTimer = setTimeout(() => {
          if (settled) return;
          if (usePosixProcessGroup) {
            escalateAndVerifyPosixGroup(child.pid);
          } else if (useWin32TaskkillTree) {
            if (hasValidPid) runWinTaskkillForPid(child.pid);
            verifyAndKillWinDescendants(child.pid);
          }
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          postKillGraceTimer = setTimeout(() => {
            finish({
              exitCode: null,
              signal: 'SIGKILL',
              timedOut: true,
              terminationUncertain: true,
              spawnError: null,
              stdoutBytes: totalStdoutBytes,
              totalStderrBytes,
              stdout: Buffer.concat(stdoutChunks).toString('utf8'),
              stderr: Buffer.concat(stderrChunks).toString('utf8'),
            });
          }, 50);
          if (typeof postKillGraceTimer.unref === 'function') postKillGraceTimer.unref();
        }, escalationWaitMs);
        if (typeof killEscalationTimer.unref === 'function') killEscalationTimer.unref();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        totalStdoutBytes += buf.length;
        if (capturedStdoutBytes < MAX_CAPTURE_BYTES) {
          const slice = buf.subarray(0, MAX_CAPTURE_BYTES - capturedStdoutBytes);
          stdoutChunks.push(slice);
          capturedStdoutBytes += slice.length;
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        totalStderrBytes += buf.length;
        if (capturedStderrBytes < MAX_CAPTURE_BYTES) {
          const slice = buf.subarray(0, MAX_CAPTURE_BYTES - capturedStderrBytes);
          stderrChunks.push(slice);
          capturedStderrBytes += slice.length;
        }
      });
    }

    child.on('error', (err) => {
      spawnErr = err;
      if (timedOut) {
        if (usePosixProcessGroup) {
          escalateAndVerifyPosixGroup(child.pid);
        } else if (useWin32TaskkillTree) {
          verifyAndKillWinDescendants(child.pid);
        }
      }
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        terminationUncertain: Boolean(timedOut && treeKillUncertain),
        spawnError: err,
        stdoutBytes: totalStdoutBytes,
        totalStderrBytes,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}\n${String(err?.message || err)}`.trim(),
      });
    });

    child.on('close', (code, signal) => {
      childClosed = true;
      if (timedOut) {
        if (usePosixProcessGroup) {
          escalateAndVerifyPosixGroup(child.pid);
        } else if (useWin32TaskkillTree) {
          verifyAndKillWinDescendants(child.pid);
        }
      }
      finish({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        terminationUncertain: Boolean(timedOut && treeKillUncertain),
        spawnError: spawnErr,
        stdoutBytes: totalStdoutBytes,
        totalStderrBytes,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      try {
        child.stdin.end(prompt, 'utf8');
      } catch {
        // Handled by close/error listeners.
      }
    }
  });
}

function readBoundedOutputFile(outputPath, fsImpl = { existsSync, statSync, readFileSync }) {
  if (!fsImpl.existsSync(outputPath)) {
    return {
      exists: false,
      rawBytes: null,
      rawUntrimmedUtf8: null,
      trimmedText: '',
      outputReadError: null,
    };
  }
  try {
    const st = fsImpl.statSync(outputPath);
    if (!st.isFile()) {
      return {
        exists: true,
        rawBytes: null,
        rawUntrimmedUtf8: null,
        trimmedText: '',
        outputReadError: 'OUTPUT_NOT_REGULAR_FILE',
      };
    }
    if (st.size > MAX_CAPTURE_BYTES) {
      return {
        exists: true,
        rawBytes: null,
        rawUntrimmedUtf8: null,
        trimmedText: '',
        outputReadError: 'OUTPUT_TOO_LARGE',
      };
    }
    const rawBytes = fsImpl.readFileSync(outputPath);
    if (rawBytes.length > MAX_CAPTURE_BYTES) {
      return {
        exists: true,
        rawBytes: null,
        rawUntrimmedUtf8: null,
        trimmedText: '',
        outputReadError: 'OUTPUT_TOO_LARGE',
      };
    }
    const rawUntrimmedUtf8 = rawBytes.toString('utf8');
    return {
      exists: true,
      rawBytes,
      rawUntrimmedUtf8,
      trimmedText: rawUntrimmedUtf8.trim(),
      outputReadError: null,
    };
  } catch {
    return {
      exists: true,
      rawBytes: null,
      rawUntrimmedUtf8: null,
      trimmedText: '',
      outputReadError: 'OUTPUT_READ_FAILED',
    };
  }
}

function normalizePathForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function findNearestExistingAncestor(targetPath) {
  let curr = resolve(targetPath);
  while (true) {
    try {
      const lst = lstatSync(curr);
      return { path: curr, lstat: lst };
    } catch {
      const parent = dirname(curr);
      if (parent === curr) return null;
      curr = parent;
    }
  }
}

function preflightPrivateReceiptDestination({
  receiptPath = null,
  receiptDir = null,
  protectedPaths = [],
}) {
  const protectedEntries = [];
  for (const rawProt of protectedPaths) {
    if (typeof rawProt !== 'string' || !rawProt.trim()) continue;
    const absProt = resolve(rawProt.trim());
    let realProt = absProt;
    try {
      realProt = realpathSync(absProt);
    } catch {
      realProt = absProt;
    }
    protectedEntries.push({
      absPath: absProt,
      realPath: realProt,
      normReal: normalizePathForCompare(realProt),
      normAbs: normalizePathForCompare(absProt),
    });
  }

  const collidesWithProtected = (candidateAbs, candidateReal = null) => {
    const normAbs = normalizePathForCompare(candidateAbs);
    const normReal = candidateReal ? normalizePathForCompare(candidateReal) : normAbs;
    return protectedEntries.some(entry => entry.normAbs === normAbs || entry.normReal === normReal || entry.normReal === normAbs);
  };

  if (receiptPath !== null && receiptPath !== undefined) {
    if (typeof receiptPath !== 'string' || !receiptPath.trim() || /[\0\r\n]/.test(receiptPath)) {
      throw new TypeError('receiptPath must be a nonempty file path string when provided.');
    }
    const absReceipt = resolve(receiptPath.trim());
    let existingLstat = null;
    try {
      existingLstat = lstatSync(absReceipt);
    } catch {
      existingLstat = null;
    }

    if (existingLstat !== null) {
      if (existingLstat.isSymbolicLink()) {
        throw new TypeError('receiptPath must not point to an existing symlink or file alias.');
      }
      let realRec = absReceipt;
      try {
        realRec = realpathSync(absReceipt);
      } catch {
        realRec = absReceipt;
      }
      if (existingLstat.isDirectory()) {
        throw new TypeError('receiptPath points to an existing directory; supply a new receipt file path or receiptDir.');
      }
      if (!existingLstat.isFile()) {
        throw new TypeError('receiptPath points to an existing special/non-regular file.');
      }
      if (collidesWithProtected(absReceipt, realRec)) {
        throw new TypeError('receiptPath must not overwrite or alias a protected input or executable file.');
      }
      throw new TypeError('receiptPath already exists; refusing to truncate or overwrite an existing receipt file.');
    }

    const ancestor = findNearestExistingAncestor(dirname(absReceipt));
    if (ancestor) {
      const ancStat = statSync(ancestor.path, { bigint: true });
      if (!ancStat.isDirectory()) {
        throw new TypeError('receiptPath parent ancestor is not a directory.');
      }
      const realAnc = realpathSync(ancestor.path);
      const projectedRealReceipt = resolve(realAnc, relative(ancestor.path, absReceipt));
      if (collidesWithProtected(absReceipt, projectedRealReceipt)) {
        throw new TypeError('receiptPath resolves via directory alias to a protected input or executable file.');
      }
    }
  }

  if (receiptDir !== null && receiptDir !== undefined) {
    if (typeof receiptDir !== 'string' || !receiptDir.trim() || /[\0\r\n]/.test(receiptDir)) {
      throw new TypeError('receiptDir must be a nonempty directory path string when provided.');
    }
    const absDir = resolve(receiptDir.trim());
    let dirLstat = null;
    try {
      dirLstat = lstatSync(absDir);
    } catch {
      dirLstat = null;
    }

    if (dirLstat !== null) {
      if (dirLstat.isSymbolicLink()) {
        throw new TypeError('receiptDir must not be a symlink or alias.');
      }
      if (!dirLstat.isDirectory()) {
        throw new TypeError('receiptDir points to an existing non-directory file.');
      }
      const realDir = realpathSync(absDir);
      if (collidesWithProtected(absDir, realDir)) {
        throw new TypeError('receiptDir must not collide with a protected input or executable file.');
      }
    } else {
      const ancestor = findNearestExistingAncestor(absDir);
      if (ancestor) {
        const ancStat = statSync(ancestor.path, { bigint: true });
        const realAnc = realpathSync(ancestor.path);
        if (collidesWithProtected(ancestor.path, realAnc) || !ancStat.isDirectory()) {
          throw new TypeError('receiptDir ancestor is not a valid directory or collides with a protected file.');
        }
      }
    }
  }
}

function writeAtomicExclusiveBytes(targetPath, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const fd = openSync(targetPath, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    try {
      fsyncSync(fd);
    } catch {
      // Ignore fsync unsupported on virtualized tmpfs.
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically publish `receiptBytes` via exclusive `.part` temp file + non-overwriting link/rename +
 * readback SHA-256 verification so partial writes are NEVER visible at `targetPath` and existing files
 * are NEVER overwritten (`P0-24`, `P2-receipt-gap`).
 */
function publishVerifiedReceiptBytesAtomically(targetPath, receiptBytes, expectedSha256, {
  allowIdenticalContentAddressedExisting = false,
} = {}) {
  const absTarget = resolve(targetPath);
  const parentDir = dirname(absTarget);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const parentLstat = lstatSync(parentDir);
  if (parentLstat.isSymbolicLink() || !parentLstat.isDirectory()) {
    throw new Error('Receipt parent path must be a real directory (not a symlink).');
  }

  let existingLstat = null;
  try {
    existingLstat = lstatSync(absTarget);
  } catch {
    existingLstat = null;
  }
  if (existingLstat !== null) {
    if (
      allowIdenticalContentAddressedExisting === true &&
      !existingLstat.isSymbolicLink() &&
      existingLstat.isFile()
    ) {
      const existingBytes = readFileSync(absTarget);
      if (sha256Hex(existingBytes) === expectedSha256) {
        return absTarget;
      }
    }
    const existErr = new Error(`Refusing to overwrite existing receipt file "${ basename(absTarget) }".`);
    existErr.code = 'EEXIST';
    throw existErr;
  }

  const tempPartPath = join(parentDir, `.tmp-receipt-${generatePiiSafeUuid()}.part`);
  writeAtomicExclusiveBytes(tempPartPath, receiptBytes);

  try {
    try {
      linkSync(tempPartPath, absTarget);
      unlinkSync(tempPartPath);
    } catch (linkErr) {
      if (linkErr?.code === 'EEXIST') {
        throw linkErr;
      }
      // Fallback for filesystems that disallow hardlinks: COPYFILE_EXCL guarantees O_CREAT|O_EXCL no-overwrite!
      copyFileSync(tempPartPath, absTarget, fsConstants.COPYFILE_EXCL);
      unlinkSync(tempPartPath);
    }
  } finally {
    if (existsSync(tempPartPath)) {
      try { unlinkSync(tempPartPath); } catch { /* ignore */ }
    }
  }

  const readbackLstat = lstatSync(absTarget);
  if (readbackLstat.isSymbolicLink() || !readbackLstat.isFile()) {
    throw new Error('Published receipt failed regular-file lstat verification.');
  }
  const readbackBytes = readFileSync(absTarget);
  if (sha256Hex(readbackBytes) !== expectedSha256) {
    throw new Error('Published receipt failed readback SHA-256 verification.');
  }
  return absTarget;
}

function retainUnverifiedOutputArtifact({
  tempOutputPath,
  outputInfo,
  retainBaseDir,
  exitCode,
  timedOut,
}) {
  if (!retainBaseDir) return null;
  try {
    const retainedDir = join(resolve(retainBaseDir), 'retained');
    mkdirSync(retainedDir, { recursive: true, mode: 0o700 });
    const retainId = generatePiiSafeUuid();
    const retainedMetaPath = join(retainedDir, `retained-${retainId}.meta.json`);
    let retainedBinPath = null;

    if (tempOutputPath) {
      try {
        const srcStat = lstatSync(tempOutputPath);
        if (srcStat && srcStat.isFile() && !srcStat.isSymbolicLink()) {
          const tmpBin = join(retainedDir, `.tmp-retained-${retainId}.part`);
          const finalBin = join(retainedDir, `retained-${retainId}.bin`);
          copyFileSync(tempOutputPath, tmpBin, fsConstants.COPYFILE_EXCL);
          renameSync(tmpBin, finalBin);
          retainedBinPath = finalBin;
        }
      } catch {
        retainedBinPath = null;
      }
    }

    const hasBinaryCopy = Boolean(retainedBinPath);
    const metaBytes = Buffer.from(`${JSON.stringify({
      schema_version: 1,
      retain_id: retainId,
      recorded_at: new Date().toISOString(),
      output_exists: Boolean(outputInfo?.exists),
      output_read_error: outputInfo?.outputReadError ?? null,
      has_binary_copy: hasBinaryCopy,
      temp_artifact_preserved: Boolean(outputInfo?.exists) && !hasBinaryCopy,
      retained_file: retainedBinPath ? basename(retainedBinPath) : null,
      exit_code: exitCode ?? null,
      timed_out: Boolean(timedOut),
    }, null, 2)}\n`, 'utf8');
    publishVerifiedReceiptBytesAtomically(retainedMetaPath, metaBytes, sha256Hex(metaBytes));
    return {
      retainId,
      privateRetainedRef: `codex-retained:${retainId}`,
      retainedFilePath: retainedBinPath ?? retainedMetaPath,
      hasBinaryCopy,
    };
  } catch {
    return null;
  }
}

function writePrivateCodexReceipt({
  receiptPath = null,
  receiptDir = null,
  receiptStoreDir = null,
  useContentAddressedFilename = false,
  filenamePrefix = 'receipt',
  receiptLabel = 'exec',
  executionProvenance,
  reviewId = null,
  packetSha256 = null,
  candidateSubjectId = null,
  candidateSpecSha256 = null,
  boundCandidateId = null,
  boundFormSpecSha256 = null,
  attachmentSha256s = [],
  payloadSha256,
  rawOutputSha256,
  rawOutputBytes = null,
  rawOutputUntrimmedUtf8 = null,
  stderrText = '',
  firstAttemptDiagnostics = null,
  privateRetainedRef = null,
  status,
  errorCode = null,
  validationError = null,
  terminationUncertain = false,
  cliArgsRedacted = [],
  model,
  reasoningEffort,
  effectiveServiceTier,
  tierFallbackUsed,
}) {
  const effectiveDir = receiptStoreDir ?? receiptDir;
  if (!receiptPath && !effectiveDir) return null;

  const hasRawBytes = Buffer.isBuffer(rawOutputBytes) && rawOutputBytes.length > 0 && rawOutputBytes.length <= MAX_CAPTURE_BYTES;
  const rawOriginalBase64 = hasRawBytes ? rawOutputBytes.toString('base64') : null;
  const untrimmedUtf8 = hasRawBytes
    ? rawOutputBytes.toString('utf8')
    : (typeof rawOutputUntrimmedUtf8 === 'string' && rawOutputUntrimmedUtf8.length > 0
      ? rawOutputUntrimmedUtf8.slice(0, MAX_CAPTURE_BYTES)
      : null);

  // For private `.local/` Codex receipts, check ONLY real credential/secret tokens (`containsSecretToken`) —
  // never wipe `raw_output_original_base64` merely because local review text cites `<local-user-path>` paths or public web/patent contacts!
  const originalSafeToPersistUtf8 = untrimmedUtf8 !== null && !containsSecretToken(untrimmedUtf8);
  let scrubbedRaw = untrimmedUtf8 !== null
    ? sanitizeDiagnosticText(untrimmedUtf8)
    : null;
  if (scrubbedRaw !== null && containsSecretToken(scrubbedRaw)) {
    scrubbedRaw = '[REDACTED_SECRET_OUTPUT]';
  }
  let scrubbedStderr = typeof stderrText === 'string' && stderrText.length > 0
    ? sanitizeDiagnosticText(stderrText.slice(0, 8192))
    : null;
  if (scrubbedStderr !== null && containsSecretToken(scrubbedStderr)) {
    scrubbedStderr = '[REDACTED_SECRET_STDERR]';
  }

  const receiptBody = {
    schema_version: 1,
    kind: 'codex_exec_receipt',
    recorded_at: new Date().toISOString(),
    receipt_nonce: generatePiiSafeUuid(),
    execution_provenance: executionProvenance,
    review_id: reviewId ?? null,
    packet_sha256: packetSha256 ?? null,
    candidate_subject_id: candidateSubjectId ?? null,
    candidate_spec_sha256: candidateSpecSha256 ?? null,
    bound_candidate_id: boundCandidateId ?? null,
    bound_form_spec_sha256: boundFormSpecSha256 ?? null,
    attachment_sha256s: Array.isArray(attachmentSha256s) ? [...attachmentSha256s] : [],
    status,
    error_code: errorCode,
    termination_uncertain: Boolean(terminationUncertain),
    model,
    reasoning_effort: reasoningEffort,
    effective_service_tier: effectiveServiceTier,
    tier_fallback_used: Boolean(tierFallbackUsed),
    payload_sha256: payloadSha256,
    raw_output_sha256: rawOutputSha256 ?? null,
    raw_output_original_base64: originalSafeToPersistUtf8 ? rawOriginalBase64 : null,
    raw_output_original_utf8: originalSafeToPersistUtf8 ? untrimmedUtf8 : null,
    raw_output_redacted_for_privacy: untrimmedUtf8 !== null && !originalSafeToPersistUtf8,
    raw_output_scrubbed: scrubbedRaw,
    stderr_scrubbed: scrubbedStderr,
    ...(firstAttemptDiagnostics ? { first_attempt_diagnostics: firstAttemptDiagnostics } : {}),
    ...(privateRetainedRef ? { private_retained_ref: privateRetainedRef } : {}),
    validation_error: validationError ? sanitizeDiagnosticText(String(validationError)) : null,
    cli_args_redacted: cliArgsRedacted,
  };

  const receiptBytes = Buffer.from(`${JSON.stringify(receiptBody, null, 2)}\n`, 'utf8');
  const receiptSha256 = sha256Hex(receiptBytes);

  let savedPrimaryPath = null;
  let savedStorePath = null;

  if (receiptPath !== null && receiptPath !== undefined) {
    if (typeof receiptPath !== 'string' || !receiptPath.trim() || /[\0\r\n]/.test(receiptPath)) {
      throw new TypeError('receiptPath must be a nonempty file path string when provided.');
    }
    const absReceiptPath = resolve(receiptPath.trim());
    savedPrimaryPath = publishVerifiedReceiptBytesAtomically(absReceiptPath, receiptBytes, receiptSha256);
  }

  if (effectiveDir !== null && effectiveDir !== undefined) {
    if (typeof effectiveDir !== 'string' || !effectiveDir.trim() || /[\0\r\n]/.test(effectiveDir)) {
      throw new TypeError('receiptDir / receiptStoreDir must be a nonempty directory path string when provided.');
    }
    const absStoreDir = resolve(effectiveDir.trim());
    let dirFilePath;
    if (useContentAddressedFilename === true) {
      dirFilePath = join(absStoreDir, `${filenamePrefix}-${receiptSha256}.json`);
    } else {
      const safeLabel = String(receiptLabel || 'exec').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'exec';
      dirFilePath = join(absStoreDir, `${filenamePrefix}-${safeLabel}-${receiptSha256.slice(0, 12)}.json`);
    }
    if (!savedPrimaryPath || normalizePathForCompare(savedPrimaryPath) !== normalizePathForCompare(dirFilePath)) {
      savedStorePath = publishVerifiedReceiptBytesAtomically(dirFilePath, receiptBytes, receiptSha256, {
        allowIdenticalContentAddressedExisting: useContentAddressedFilename === true,
      });
    } else {
      savedStorePath = savedPrimaryPath;
    }
  }

  return {
    receiptPath: savedPrimaryPath ?? savedStorePath,
    storeReceiptPath: savedStorePath ?? savedPrimaryPath,
    receiptSha256,
    privateReceiptRef: `codex-receipt:${receiptSha256}`,
    recordedAt: receiptBody.recorded_at,
  };
}

/**
 * Verify a saved private Codex Gate-4 execution receipt on disk (`P1-16`):
 *  - Locates `receipt-${envelope.receipt_sha256}.json` in `receiptStoreDir` (or default live store;
 *    also checks the process-scoped test store ONLY when `allowTestDouble === true`).
 *  - Verifies receipt file SHA-256, untrimmed `raw_output_original_base64` SHA-256, parsed review JSON
 *    parity against `envelope.review`, `review_id`, `packet_sha256`, candidate/spec bindings, `attachment_sha256s`,
 *    `gpt-6.2-astra`, `['xhigh', 'max']` effort, and `execution_provenance` (`live_subscription_codex` unless `allowTestDouble === true`).
 *  - Never throws; returns `{ verified: true, ... }` or `{ verified: false, reason }`.
 */
function snapshotSchemaOnce(node, label = 'codex_schema', depth = 0, seen = new Set()) {
  if (depth > 64) {
    throw new RangeError(`${label} exceeds maximum JSON Schema nesting depth.`);
  }
  if (node === null || typeof node === 'boolean' || typeof node === 'string') {
    return node;
  }
  if (typeof node === 'number') {
    if (!Number.isFinite(node)) {
      throw new TypeError(`${label} cannot contain NaN or Infinity.`);
    }
    return node;
  }
  if (typeof node !== 'object') {
    throw new TypeError(`${label} contains unsupported JSON Schema value type (${typeof node}).`);
  }
  if (seen.has(node)) {
    throw new TypeError(`${label} contains a circular reference.`);
  }
  seen.add(node);
  try {
    if (Array.isArray(node)) {
      const arr = [];
      for (let i = 0; i < node.length; i++) {
        arr.push(snapshotSchemaOnce(node[i], `${label}[${i}]`, depth + 1, seen));
      }
      return Object.freeze(arr);
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${label} must be a plain JSON Schema object.`);
    }
    const out = {};
    for (const key of Object.keys(node)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new TypeError(`${label} contains forbidden property key "${key}".`);
      }
      const val = node[key];
      if (val !== undefined) {
        out[key] = snapshotSchemaOnce(val, `${label}.${key}`, depth + 1, seen);
      }
    }
    return Object.freeze(out);
  } finally {
    seen.delete(node);
  }
}

function assertSafeSchemaDeep(node, label = 'codex_schema', depth = 0, seen = new Set()) {
  if (node === null || node === undefined) return;
  if (depth > 64) {
    throw new RangeError(`${label} exceeds maximum JSON Schema nesting depth.`);
  }
  if (typeof node === 'string' || typeof node === 'number') {
    assertNoRawPii(node, label);
    if (typeof node === 'string' && containsSecretToken(node)) {
      throw new TypeError(`${label} contains a secret or credential token; redact before invoking Codex CLI.`);
    }
    return;
  }
  if (typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      assertSafeSchemaDeep(node[i], `${label}[${i}]`, depth + 1, seen);
    }
    return;
  }

  for (const [key, val] of Object.entries(node)) {
    assertNoRawPii({ [key]: typeof val === 'object' ? 'nested' : val }, label);
    if (containsSecretToken({ [key]: typeof val === 'object' ? 'nested' : val })) {
      throw new TypeError(`${label}.${key} contains a secret or credential token; redact before invoking Codex CLI.`);
    }
    assertSafeSchemaDeep(val, `${label}.${key}`, depth + 1, seen);
  }
}

/**
 * Validate upfront that a snapshotted JSON Schema uses ONLY keywords supported by
 * `validateJsonAgainstStrictSchema`, rejecting `$ref`, `oneOf`, `allOf`, `not`, `patternProperties`,
 * `if`/`then`/`else`, boolean `false` root schemas, or unknown keywords (`UNSUPPORTED_JSON_SCHEMA_KEYWORD`)
 * BEFORE spawning `codex` (`P2-schema`).
 */

/**
 * Execute `codex exec` in a fresh stateless read-only sandbox with a strict `--output-schema`,
 * returning validated parsed JSON, verified execution provenance, and atomic receipt metadata.
 */
export async function runCodexExecJson({
  prompt,
  schema = null,
  outputFormat = undefined,
  model = null,
  reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
  webSearch = 'live',
  serviceTier = DEFAULT_CODEX_SERVICE_TIER,
  allowStandardTierFallback = true,
  allowTierFallback = undefined,
  imagePaths = [],
  protectedInputPaths = [],
  timeoutMs = null,
  cwd = null,
  skipGitRepoCheck = false,
  sandboxMode = null,
  codexBin = 'codex',
  env = process.env,
  stripApiKeyEnv = true,
  mockExecutor = null,
  spawnImpl = undefined,
  testMode = false,
  resolveWindowsBin = null,
  enforcePiiGuard = true,
  receiptPath = null,
  receiptDir = null,
  receiptStoreDir = null,
  useContentAddressedReceipt = false,
  receiptLabel = 'exec',
  reviewId = null,
  packetSha256 = null,
  candidateSubjectId = null,
  candidateSpecSha256 = null,
  boundCandidateId = null,
  boundFormSpecSha256 = null,
  postValidate = null,
  fsImpl = { existsSync, readFileSync, realpathSync, statSync },
  platform = process.platform,
  taskkillImpl = spawnSync,
  killProcessGroupImpl = null,
  winDescendantCheckImpl = null,
  _preStagedAttachments = null,
} = {}) {
  if (typeof testMode !== 'boolean') {
    throw new TypeError('testMode must be a boolean.');
  }
  if (stripApiKeyEnv !== true || enforcePiiGuard !== true) {
    throw new CodexRunnerError(
      'Disabling API-key environment stripping or PII/secret input guards on Codex CLI is strictly forbidden.',
      { code: 'CODEX_GUARD_BYPASS_FORBIDDEN' },
    );
  }
  if (resolveWindowsBin !== null && resolveWindowsBin !== undefined && typeof resolveWindowsBin !== 'boolean') {
    throw new TypeError('resolveWindowsBin must be a boolean when provided.');
  }
  if (mockExecutor !== null && mockExecutor !== undefined && typeof mockExecutor !== 'function') {
    throw new TypeError('mockExecutor must be a function when provided.');
  }

  // P0-26: Strict test-double vs live OS spawn separation!
  if (testMode === true) {
    if (spawnImpl !== undefined && (typeof spawnImpl !== 'function' || spawnImpl === spawn)) {
      throw new CodexRunnerError(
        'testMode forbids invoking real OS child_process.spawn; supply an in-process mockExecutor or test spawnImpl double.',
        { code: 'TEST_MODE_REQUIRES_IN_PROCESS_DOUBLE' },
      );
    }
    if (typeof mockExecutor !== 'function' && typeof spawnImpl !== 'function') {
      throw new CodexRunnerError(
        'testMode requires an explicit in-process mockExecutor or test spawnImpl double; real OS spawn is forbidden.',
        { code: 'TEST_MODE_REQUIRES_IN_PROCESS_DOUBLE' },
      );
    }
  } else {
    if (mockExecutor !== null && mockExecutor !== undefined) {
      throw new CodexRunnerError(
        'mockExecutor is forbidden outside testMode.',
        { code: 'CODEX_GUARD_BYPASS_FORBIDDEN' },
      );
    }
    if (spawnImpl !== undefined) {
      throw new CodexRunnerError(
        'Custom spawnImpl is forbidden in production (testMode=false); live execution requires verified OS spawn.',
        { code: 'CODEX_GUARD_BYPASS_FORBIDDEN' },
      );
    }
    if (
      resolveWindowsBin === false ||
      taskkillImpl !== spawnSync ||
      killProcessGroupImpl !== null ||
      winDescendantCheckImpl !== null
    ) {
      throw new CodexRunnerError(
        'Bypassing executable resolution or process-tree termination controls outside testMode is forbidden.',
        { code: 'CODEX_GUARD_BYPASS_FORBIDDEN' },
      );
    }
  }

  const effectiveAllowFallback = allowTierFallback !== undefined ? allowTierFallback : allowStandardTierFallback;
  if (typeof effectiveAllowFallback !== 'boolean') {
    throw new TypeError('allowStandardTierFallback / allowTierFallback must be a boolean.');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('prompt must be a nonempty string.');
  }
  const isMarkdownMode = outputFormat === 'markdown' || schema === null || schema === undefined;
  if (!isMarkdownMode) {
    if (schema === false) {
      throw new CodexRunnerError(
        'codex_schema is boolean false and rejects all values.',
        { code: 'UNSUPPORTED_JSON_SCHEMA_KEYWORD' },
      );
    }
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError('schema must be a JSON Schema object or null (for free-form Markdown review).');
    }
  }
  if (timeoutMs !== null && timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 50)) {
    throw new RangeError('timeoutMs must be null or an integer >= 50.');
  }

  const executionProvenance = testMode === true ? 'synthetic_test_double' : 'live_subscription_codex';

  // Snapshot `schema` ONCE into an immutable plain tree and single canonical JSON string when in JSON mode.
  const frozenSchema = isMarkdownMode ? null : snapshotSchemaOnce(schema, 'codex_schema');
  const schemaJson = isMarkdownMode ? 'null' : canonicalJson(frozenSchema);

  // Local `.local/` Codex prompts & schemas check ONLY real credential/secret tokens (`containsSecretToken`),
  // never false-rejecting local repository paths (<local-workspace-path>) or public web/patent text.
  if (containsSecretToken(prompt)) {
    throw new TypeError('codex_prompt contains a secret or credential token; redact before invoking Codex CLI.');
  }
  if (!isMarkdownMode) {
    if (containsSecretToken(frozenSchema) || containsSecretToken(schemaJson)) {
      throw new TypeError('codex_schema contains a secret or credential token; redact before invoking Codex CLI.');
    }
    assertSafeSchemaDeep(frozenSchema, 'codex_schema');
    assertSupportedStrictJsonSchema(frozenSchema, 'codex_schema', { ErrorClass: CodexRunnerError });
  }

  const resolvedCwd = resolveValidatedCwd(cwd);
  const childEnv = buildAllowlistedChildEnv(env);

  if (testMode !== true) {
    verifyCodexSubscriptionReady(childEnv, fsImpl);
  }

  const preStaged = _preStagedAttachments ?? null;
  const validatedAttachments = preStaged ? null : validateImageAttachments(imagePaths);
  const originalAttachmentPaths = preStaged
    ? [...preStaged.originalPaths]
    : validatedAttachments.map(a => a.originalPath);
  const attachmentSha256s = preStaged
    ? [...preStaged.attachmentSha256s]
    : validatedAttachments.map(a => a.sha256);

  // Resolve command BEFORE preflight so resolved shim + script/binary entrypoint are protected (`P2-11`).
  const shouldResolveBin = testMode !== true
    ? true
    : resolveWindowsBin === true;
  const resolvedCmd = shouldResolveBin
    ? resolveCodexCommand(codexBin, {
      platform,
      env: childEnv,
      fsImpl,
      testMode,
      cwd: resolvedCwd ?? process.cwd(),
    })
    : { command: codexBin, prefixArgs: [], protectedPaths: [] };

  preflightPrivateReceiptDestination({
    receiptPath,
    receiptDir: receiptStoreDir ?? receiptDir,
    protectedPaths: [
      ...protectedInputPaths,
      ...originalAttachmentPaths,
      ...(resolvedCmd.protectedPaths || []),
    ],
  });

  const explicitModel = typeof model === 'string' && model.trim() ? model.trim() : null;
  const effectiveModelName = explicitModel ?? DEFAULT_CODEX_MODEL;
  const payloadSha256 = sha256Hex(canonicalJson({
    runner: 'codex_exec_v1',
    model: explicitModel ?? 'inherited_config',
    reasoning_effort: reasoningEffort ?? 'inherited_config',
    web_search: webSearch ?? 'live',
    requested_service_tier: serviceTier ?? 'inherited_config',
    prompt_sha256: sha256Hex(prompt),
    schema_sha256: sha256Hex(schemaJson),
    image_sha256s: attachmentSha256s,
  }));

  const tempDir = mkdtempSync(join(tmpdir(), 'codex-exec-'));
  try {
    chmodSync(tempDir, 0o700);
  } catch {
    // Best-effort on Windows NTFS ACLs.
  }
  let retainTempArtifactOnExit = false;
  const startMs = Date.now();

  try {
    const tempSchemaPath = isMarkdownMode ? null : join(tempDir, 'output-schema.json');
    if (tempSchemaPath) {
      writeFileSync(tempSchemaPath, schemaJson, { encoding: 'utf8', mode: 0o600 });
    }

    // P1-07: Stage immutable copies of `imagePaths` inside `0o700` temp subdir so child NEVER receives original mutable paths!
    let stagedImagePaths = [];
    if (preStaged) {
      stagedImagePaths = [...preStaged.stagedPaths];
    } else if (validatedAttachments.length > 0) {
      const stageImgDir = join(tempDir, 'staged-attachments');
      mkdirSync(stageImgDir, { recursive: true, mode: 0o700 });
      try { chmodSync(stageImgDir, 0o700); } catch { /* ignore */ }
      stagedImagePaths = validatedAttachments.map((att, idx) => {
        const dst = join(stageImgDir, `attachment-${idx + 1}${att.ext}`);
        writeAtomicExclusiveBytes(dst, att.bytesBuffer);
        return dst;
      });
    }

    const runAttempt = async (attemptNumber, activeServiceTier) => {
      const tempOutputPath = join(tempDir, `last-message-${attemptNumber}.${isMarkdownMode ? 'md' : 'json'}`);
      const codexArgs = buildCodexExecArgs({
        model,
        reasoningEffort,
        webSearch,
        serviceTier: activeServiceTier,
        imagePaths: stagedImagePaths,
        cwd: resolvedCwd,
        skipGitRepoCheck,
        sandboxMode,
        schemaPath: tempSchemaPath,
        outputPath: tempOutputPath,
      });
      const fullArgs = [...resolvedCmd.prefixArgs, ...codexArgs];
      const procRes = typeof mockExecutor === 'function'
        ? await runMockExecutorOnce({
          mockExecutor,
          args: fullArgs,
          codexArgs,
          prompt,
          schemaJson,
          stagedImagePaths,
          outputFilePath: tempOutputPath,
          cwd: resolvedCwd,
          env: childEnv,
          timeoutMs,
          attemptNumber,
          activeServiceTier,
          fsImpl,
        })
        : await spawnOnce({
          command: resolvedCmd.command,
          args: fullArgs,
          prompt,
          cwd: resolvedCwd,
          env: childEnv,
          timeoutMs,
          spawnImpl: testMode === true ? spawnImpl : spawn,
          testMode,
          platform,
          taskkillImpl,
          killProcessGroupImpl,
          winDescendantCheckImpl,
        });
      const outputInfo = readBoundedOutputFile(tempOutputPath, fsImpl);
      return { procRes, outputInfo, tempOutputPath, codexArgs };
    };

    let tierFallbackUsed = false;
    let effectiveServiceTier = serviceTier ?? null;
    const firstRun = await runAttempt(1, serviceTier);
    let attempt = firstRun;
    let firstAttemptDiagnostics = null;
    let firstAttemptReceiptSha256 = null;

    const fallbackReceiptBaseDir =
      receiptStoreDir ??
      receiptDir ??
      (receiptPath ? dirname(resolve(receiptPath.trim())) : (testMode === true ? getDefaultTestReceiptStoreDir() : resolve(process.cwd(), '.local', 'receipts', 'codex-evidence-review')));

    const firstStderr = firstRun.procRes.stderr;
    const firstStderrWithoutBanner = extractPostEchoCodexDiagnosticStderr(firstStderr, prompt);
    const canFallbackToStandard =
      serviceTier === 'ultrafast' &&
      effectiveAllowFallback === true &&
      firstRun.procRes.exitCode !== null &&
      firstRun.procRes.exitCode !== 0 &&
      firstRun.procRes.signal === null &&
      firstRun.procRes.timedOut === false &&
      firstRun.procRes.spawnError === null &&
      firstRun.procRes.stdoutBytes === 0 &&
      !fsImpl.existsSync(firstRun.tempOutputPath) &&
      firstRun.outputInfo.outputReadError === null &&
      firstRun.procRes.totalStderrBytes > 0 &&
      firstRun.procRes.totalStderrBytes <= MAX_CAPTURE_BYTES &&
      firstStderrWithoutBanner.length > 0 &&
      firstStderrWithoutBanner.length <= MAX_ENTITLEMENT_STDERR_CHARS &&
      !GENERATION_PROGRESS_MARKER_RE.test(firstStderrWithoutBanner) &&
      !TRANSPORT_OR_TURN_STARTED_STDERR_RE.test(firstStderrWithoutBanner) &&
      ULTRAFAST_ENTITLEMENT_ERROR_RE.test(firstStderrWithoutBanner);

    if (canFallbackToStandard) {
      // P0-27: Persist distinct first-attempt failure receipt BEFORE launching standard-tier fallback!
      try {
        const firstAttemptDir = join(resolve(fallbackReceiptBaseDir), 'first-attempts');
        const firstRec = writePrivateCodexReceipt({
          receiptStoreDir: firstAttemptDir,
          useContentAddressedFilename: true,
          filenamePrefix: 'attempt1-receipt',
          receiptLabel: `${receiptLabel}-attempt1`,
          executionProvenance,
          reviewId,
          packetSha256,
          candidateSubjectId,
          attachmentSha256s,
          payloadSha256,
          rawOutputSha256: null,
          rawOutputBytes: null,
          stderrText: firstStderr,
          status: 'failed_known',
          errorCode: 'CODEX_ULTRAFAST_ENTITLEMENT_REJECTED',
          validationError: null,
          terminationUncertain: false,
          cliArgsRedacted: redactArgsForReceipt(firstRun.codexArgs),
          model: explicitModel,
          reasoningEffort: reasoningEffort ?? null,
          effectiveServiceTier: 'ultrafast',
          tierFallbackUsed: false,
        });
        firstAttemptReceiptSha256 = firstRec?.receiptSha256 ?? null;
      } catch (firstRecErr) {
        retainTempArtifactOnExit = true;
        throw new CodexRunnerError(
          `Failed to persist first-attempt tier-rejection receipt before fallback: ${String(firstRecErr?.message || firstRecErr)}`,
          {
            code: 'CODEX_RECEIPT_PERSISTENCE_FAILED',
            exitCode: firstRun.procRes.exitCode,
            stderr: firstStderr,
            executionProvenance,
            retainedArtifactDir: tempDir,
          },
        );
      }

      let scrubbedFirstStderr = sanitizeDiagnosticText(firstStderr);
      if (containsSecretToken(scrubbedFirstStderr)) {
        scrubbedFirstStderr = '[REDACTED_SECRET_STDERR]';
      }
      firstAttemptDiagnostics = {
        attempt: 1,
        requested_service_tier: 'ultrafast',
        exit_code: firstRun.procRes.exitCode,
        first_attempt_receipt_sha256: firstAttemptReceiptSha256,
        stderr_scrubbed: scrubbedFirstStderr,
      };
      tierFallbackUsed = true;
      effectiveServiceTier = 'standard';
      attempt = await runAttempt(2, 'standard');
    }

    const { procRes, outputInfo, codexArgs, tempOutputPath } = attempt;
    if (procRes.terminationUncertain) {
      retainTempArtifactOnExit = true;
    }
    const redactedArgs = redactArgsForReceipt(codexArgs);

    // Preserve exact untrimmed raw bytes for `raw_output_sha256` & `raw_output_original_base64`;
    // trim ONLY a separate string copy (`trimmedJsonText`) for JSON.parse!
    let rawBytes = outputInfo.rawBytes && outputInfo.rawBytes.length > 0 ? outputInfo.rawBytes : null;
    let rawUntrimmedUtf8 = outputInfo.rawUntrimmedUtf8;
    let trimmedJsonText = outputInfo.trimmedText;
    if (!trimmedJsonText && outputInfo.outputReadError === null && testMode === true && procRes.stdout.trim().startsWith('{')) {
      rawBytes = Buffer.from(procRes.stdout, 'utf8');
      rawUntrimmedUtf8 = procRes.stdout;
      trimmedJsonText = procRes.stdout.trim();
    }
    let rawOutputSha256 = rawBytes ? sha256Hex(rawBytes) : null;

    const effectiveRetainBaseDir =
      receiptStoreDir ??
      receiptDir ??
      (receiptPath ? dirname(resolve(receiptPath.trim())) : fallbackReceiptBaseDir);

    let retainedArtifactInfo = null;
    const ensureRetainedWhenOriginalMissing = () => {
      if (retainedArtifactInfo) return retainedArtifactInfo;
      retainedArtifactInfo = retainUnverifiedOutputArtifact({
        tempOutputPath,
        outputInfo,
        retainBaseDir: effectiveRetainBaseDir,
        exitCode: procRes.exitCode,
        timedOut: procRes.timedOut,
      });
      if (outputInfo.exists && !retainedArtifactInfo?.hasBinaryCopy) {
        retainTempArtifactOnExit = true;
      }
      return retainedArtifactInfo;
    };

    const persistReceiptOrThrow = (status, errorCode, validationError, privateRetainedRef = null) => {
      try {
        return writePrivateCodexReceipt({
          receiptPath,
          receiptDir,
          receiptStoreDir,
          useContentAddressedFilename: useContentAddressedReceipt,
          receiptLabel,
          executionProvenance,
          reviewId,
          packetSha256,
          candidateSubjectId,
          candidateSpecSha256,
          boundCandidateId,
          boundFormSpecSha256,
          attachmentSha256s,
          payloadSha256,
          rawOutputSha256,
          rawOutputBytes: rawBytes,
          rawOutputUntrimmedUtf8: rawUntrimmedUtf8,
          stderrText: procRes.stderr,
          firstAttemptDiagnostics,
          privateRetainedRef,
          status,
          errorCode,
          validationError,
          terminationUncertain: procRes.terminationUncertain,
          cliArgsRedacted: redactedArgs,
          model: explicitModel,
          reasoningEffort: reasoningEffort ?? null,
          effectiveServiceTier,
          tierFallbackUsed,
        });
      } catch (recErr) {
        retainTempArtifactOnExit = true;
        const retainedOnFail = ensureRetainedWhenOriginalMissing();
        throw new CodexRunnerError(
          `Private receipt persistence failed: ${String(recErr?.message || recErr)}`,
          {
            code: 'CODEX_RECEIPT_PERSISTENCE_FAILED',
            exitCode: procRes.exitCode,
            signal: procRes.signal,
            timedOut: procRes.timedOut,
            terminationUncertain: procRes.terminationUncertain,
            tierFallbackUsed,
            rawOutputSha256,
            executionProvenance,
            privateRetainedRef: retainedOnFail?.privateRetainedRef ?? null,
            firstAttemptReceiptSha256,
            stderr: procRes.stderr,
            retainedArtifactDir: tempDir,
            retainedOutputPath: tempOutputPath,
          },
        );
      }
    };

    const throwWithReceipt = (msg, { status, code, exitCode = procRes.exitCode, signal = procRes.signal, timedOut = false, retainOutput = false }) => {
      const retained = retainOutput ? ensureRetainedWhenOriginalMissing() : null;
      const saved = persistReceiptOrThrow(status, code, msg, retained?.privateRetainedRef ?? null);
      throw new CodexRunnerError(msg, {
        code,
        exitCode,
        signal,
        timedOut,
        terminationUncertain: procRes.terminationUncertain,
        tierFallbackUsed,
        rawOutputSha256,
        receiptSha256: saved?.receiptSha256 ?? null,
        executionProvenance,
        privateReceiptRef: saved?.privateReceiptRef ?? null,
        privateRetainedRef: retained?.privateRetainedRef ?? null,
        firstAttemptReceiptSha256,
        stderr: procRes.stderr,
        retainedOutputPath: retained?.retainedFilePath ?? null,
      });
    };

    if (procRes.timedOut) {
      throwWithReceipt(`Codex CLI timed out after ${timeoutMs}ms.`, {
        status: 'pending_recovery',
        code: 'CODEX_TIMEOUT',
        timedOut: true,
        retainOutput: rawOutputSha256 === null || procRes.terminationUncertain,
      });
    }

    if (procRes.spawnError) {
      if (procRes.spawnError instanceof CodexRunnerError && procRes.spawnError.code === 'SANDBOX_OUTSIDE_READ_DENIED') {
        throwWithReceipt(procRes.spawnError.message, {
          status: 'failed_known',
          code: 'SANDBOX_OUTSIDE_READ_DENIED',
          retainOutput: false,
        });
      }
      throwWithReceipt(`Failed to spawn Codex CLI: ${procRes.spawnError.message}`, {
        status: 'failed_known',
        code: 'CODEX_SPAWN_FAILED',
        retainOutput: false,
      });
    }

    if (outputInfo.outputReadError === 'OUTPUT_TOO_LARGE') {
      throwWithReceipt(`Codex CLI output file exceeded ${MAX_CAPTURE_BYTES}-byte capture limit.`, {
        status: 'pending_recovery',
        code: 'CODEX_OUTPUT_TOO_LARGE',
        retainOutput: true,
      });
    }

    if (outputInfo.outputReadError !== null) {
      throwWithReceipt(`Codex CLI output file could not be read (${outputInfo.outputReadError}).`, {
        status: 'pending_recovery',
        code: 'CODEX_OUTPUT_READ_ERROR',
        retainOutput: true,
      });
    }

    if (procRes.exitCode !== 0) {
      const detail = sanitizeDiagnosticText(procRes.stderr || procRes.stdout || 'Unknown Codex CLI error').slice(0, 500);
      throwWithReceipt(`Codex CLI exited with code ${String(procRes.exitCode)}: ${detail}`, {
        status: 'failed_known',
        code: 'CODEX_NONZERO_EXIT',
        retainOutput: outputInfo.exists && rawOutputSha256 === null,
      });
    }

    if (!trimmedJsonText && isMarkdownMode && outputInfo.outputReadError === null && procRes.stdout.trim()) {
      if ((procRes.stdoutBytes ?? 0) > MAX_CAPTURE_BYTES) {
        throwWithReceipt(`Codex CLI stdout Markdown output (${procRes.stdoutBytes} bytes) exceeded ${MAX_CAPTURE_BYTES}-byte capture limit.`, {
          status: 'pending_recovery',
          code: 'CODEX_OUTPUT_TOO_LARGE',
          exitCode: procRes.exitCode,
          retainOutput: false,
        });
      }
      rawBytes = Buffer.from(procRes.stdout, 'utf8');
      rawUntrimmedUtf8 = procRes.stdout;
      trimmedJsonText = procRes.stdout.trim();
      rawOutputSha256 = sha256Hex(rawBytes);
    }
    if (containsSecretToken(rawUntrimmedUtf8 ?? trimmedJsonText)) {
      throwWithReceipt('Codex CLI output contained a secret token or credential; refusing to return raw secret output.', {
        status: 'failed_known',
        code: 'CODEX_OUTPUT_SECRET_BLOCKED',
        exitCode: procRes.exitCode,
        retainOutput: false,
      });
    }
    if (!trimmedJsonText || rawOutputSha256 === null) {
      const effectiveRawSha = rawBytes ? sha256Hex(rawBytes) : rawOutputSha256;
      if (!trimmedJsonText || effectiveRawSha === null) {
        throwWithReceipt(
          isMarkdownMode ? 'Codex CLI exited 0 without writing Markdown review output.' : 'Codex CLI exited 0 without writing structured JSON output.',
          {
            status: 'pending_recovery',
            code: 'CODEX_EMPTY_OUTPUT',
            exitCode: 0,
            retainOutput: true,
          },
        );
      }
    }

    if (isMarkdownMode) {
      const finalRawSha = rawBytes ? sha256Hex(rawBytes) : rawOutputSha256;
      let postValidatedMd = null;
      if (typeof postValidate === 'function') {
        postValidatedMd = postValidate(trimmedJsonText);
      }
      const savedReceipt = persistReceiptOrThrow('completed', null, null, null);
      return {
        data: trimmedJsonText,
        output: trimmedJsonText,
        markdown: trimmedJsonText,
        post_validated: postValidatedMd,
        raw_text: trimmedJsonText,
        raw_output_sha256: finalRawSha,
        attachment_sha256s: attachmentSha256s,
        execution_provenance: executionProvenance,
        receipt_persisted: Boolean(savedReceipt?.receiptPath),
        receipt_sha256: savedReceipt?.receiptSha256 ?? null,
        private_receipt_ref: savedReceipt?.privateReceiptRef ?? null,
        recorded_at: savedReceipt?.recordedAt ?? new Date().toISOString(),
        ...(firstAttemptReceiptSha256 ? { first_attempt_receipt_sha256: firstAttemptReceiptSha256 } : {}),
        model: explicitModel,
        reasoning_effort: reasoningEffort ?? null,
        web_search: webSearch,
        requested_service_tier: serviceTier ?? null,
        effective_service_tier: effectiveServiceTier,
        tier_fallback_used: tierFallbackUsed,
        payload_sha256: payloadSha256,
        duration_ms: Math.max(0, Date.now() - startMs),
        cli_args_redacted: redactedArgs,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmedJsonText);
    } catch (err) {
      throwWithReceipt(`Codex CLI output is not valid JSON: ${err.message}`, {
        status: 'completed',
        code: 'CODEX_INVALID_JSON',
        exitCode: 0,
      });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throwWithReceipt('Codex CLI output root must be a JSON object.', {
        status: 'completed',
        code: 'CODEX_INVALID_JSON_ROOT',
        exitCode: 0,
      });
    }

    try {
      validateJsonAgainstStrictSchema(parsed, frozenSchema, '$', { ErrorClass: CodexRunnerError });
    } catch (schemaErr) {
      const cleanSchemaReason = sanitizeDiagnosticText(
        `JSON Schema validation rejected Codex output: ${String(schemaErr?.message || schemaErr)}`,
      );
      throwWithReceipt(cleanSchemaReason, {
        status: 'completed',
        code: 'CODEX_SCHEMA_VALIDATION_FAILED',
        exitCode: 0,
      });
    }

    let postValidated = null;
    if (typeof postValidate === 'function') {
      try {
        postValidated = postValidate(parsed);
      } catch (valErr) {
        const cleanReason = sanitizeDiagnosticText(
          `Semantic validation rejected Codex review output: ${String(valErr?.message || valErr)}`,
        );
        throwWithReceipt(cleanReason, {
          status: 'completed',
          code: 'EVIDENCE_REVIEW_VALIDATION_FAILED',
          exitCode: 0,
        });
      }
    }

    const savedReceipt = persistReceiptOrThrow('completed', null, null, null);

    return {
      data: parsed,
      output: parsed,
      post_validated: postValidated,
      raw_text: trimmedJsonText,
      raw_output_sha256: rawOutputSha256,
      attachment_sha256s: attachmentSha256s,
      execution_provenance: executionProvenance,
      receipt_persisted: Boolean(savedReceipt?.receiptPath),
      receipt_sha256: savedReceipt?.receiptSha256 ?? null,
      private_receipt_ref: savedReceipt?.privateReceiptRef ?? null,
      recorded_at: savedReceipt?.recordedAt ?? new Date().toISOString(),
      ...(firstAttemptReceiptSha256 ? { first_attempt_receipt_sha256: firstAttemptReceiptSha256 } : {}),
      model: explicitModel,
      reasoning_effort: reasoningEffort ?? null,
      web_search: webSearch ?? 'live',
      requested_service_tier: serviceTier ?? null,
      effective_service_tier: effectiveServiceTier,
      tier_fallback_used: tierFallbackUsed,
      payload_sha256: payloadSha256,
      duration_ms: Math.max(0, Date.now() - startMs),
      cli_args_redacted: redactedArgs,
    };
  } finally {
    if (!retainTempArtifactOnExit) {
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
      } catch {
        // Ignore cleanup race on Windows AV locks; temp files contain no secrets/PII.
      }
    }
  }
}


export async function runCodexExecMarkdown(options = {}) {
  return runCodexExecJson({
    ...options,
    schema: null,
    outputFormat: 'markdown',
  });
}

/**
 * Freeze an `evidence-review-draft-v1` packet, stage immutable hashed packet + raster copies, run subscription
 * `codex exec` with full repository/tool/web inspection autonomy, atomically persist +
 * verify a content-addressed receipt, and return a sanitized advisory execution envelope.
 */
export async function runCodexEvidenceReview(packetInput, {
  model = null,
  reasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
  webSearch = 'live',
  serviceTier = DEFAULT_CODEX_SERVICE_TIER,
  allowStandardTierFallback = true,
  allowTierFallback = undefined,
  imagePaths = [],
  timeoutMs = null,
  cwd = null,
  codexBin = 'codex',
  env = process.env,
  stripApiKeyEnv = true,
  enforcePiiGuard = true,
  mockExecutor = null,
  spawnImpl = undefined,
  testMode = false,
  enabled = false,
  dryRun = false,
  disabledReason = null,
  throwOnFailure = false,
  receiptPath = null,
  receiptDir = null,
  receiptStoreDir = null,
  candidateId = null,
  formSpecSha256 = null,
  fsImpl = undefined,
  platform = process.platform,
  taskkillImpl = spawnSync,
  killProcessGroupImpl = null,
  winDescendantCheckImpl = null,
} = {}) {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('enabled must be a boolean.');
  }
  if (typeof dryRun !== 'boolean') {
    throw new TypeError('dryRun must be a boolean.');
  }
  if (typeof testMode !== 'boolean') {
    throw new TypeError('testMode must be a boolean.');
  }
  if (typeof throwOnFailure !== 'boolean') {
    throw new TypeError('throwOnFailure must be a boolean.');
  }
  if (stripApiKeyEnv !== true || enforcePiiGuard !== true) {
    throw new CodexRunnerError(
      'Disabling API-key environment stripping or PII/secret guards in runCodexEvidenceReview is forbidden.',
      { code: 'CODEX_GUARD_BYPASS_FORBIDDEN' },
    );
  }
  if (!ALLOWED_CODEX_WEB_SEARCH.includes(webSearch)) {
    throw new TypeError(
      `Unsupported webSearch "${String(webSearch)}"; must be one of ${ALLOWED_CODEX_WEB_SEARCH.join(', ')}.`,
    );
  }

  const explicitGateModel = model === null || model === undefined
    ? null
    : (typeof model === 'string' ? model.trim() : String(model));
  const explicitGateEffort = reasoningEffort === null || reasoningEffort === undefined
    ? null
    : (typeof reasoningEffort === 'string' ? reasoningEffort.trim() : String(reasoningEffort));
  const normalizedModel = explicitGateModel;
  reasoningEffort = explicitGateEffort;
  if ((explicitGateModel !== null && !SAFE_MODEL_ID_RE.test(explicitGateModel)) ||
    (explicitGateEffort !== null && !ALLOWED_GATE4_EFFORTS.includes(explicitGateEffort))) {
    throw new CodexRunnerError(
      `Gate-4 evidence review requires a valid model identifier (or null/omitted to inherit config) and reasoningEffort in [xhigh, max, null] (got model="${String(model)}", reasoningEffort="${String(explicitGateEffort)}").`,
      { code: 'INVALID_GATE4_MODEL_OR_EFFORT' },
    );
  }

  const executionProvenance = testMode === true ? 'synthetic_test_double' : 'live_subscription_codex';
  const reviewerLabel = formatReviewerLabel(normalizedModel, reasoningEffort, executionProvenance);
  const pktDeclaredSha = typeof packetInput?.form_spec_sha256 === 'string' && packetInput.form_spec_sha256.trim()
    ? packetInput.form_spec_sha256.trim()
    : (typeof packetInput?.candidate?.form_spec_sha256 === 'string' && packetInput.candidate.form_spec_sha256.trim()
      ? packetInput.candidate.form_spec_sha256.trim()
      : (typeof packetInput?.candidate?.spec_sha256 === 'string' && packetInput.candidate.spec_sha256.trim()
        ? packetInput.candidate.spec_sha256.trim()
        : null));
  const reqFormSpecSha = typeof formSpecSha256 === 'string' && formSpecSha256.trim() ? formSpecSha256.trim() : null;
  if (pktDeclaredSha && reqFormSpecSha && pktDeclaredSha !== reqFormSpecSha) {
    const mismatchMsg = `Review packet declared form_spec_sha256 (${pktDeclaredSha}) does not match target formSpecSha256 (${reqFormSpecSha}).`;
    if (throwOnFailure) {
      throw new CodexRunnerError(mismatchMsg, { code: 'PACKET_FORM_SPEC_MISMATCH' });
    }
    return Object.freeze({
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      dry_run: Boolean(dryRun),
      advisory_only: true,
      execution_provenance: executionProvenance,
      receipt_sha256: null,
      private_receipt_ref: null,
      schema_version: SCHEMA_VERSION,
      review_id: typeof packetInput?.review_id === 'string' ? packetInput.review_id : null,
      packet_sha256: null,
      payload_sha256: null,
      attachment_sha256s: Object.freeze([]),
      raw_output_sha256: null,
      reviewer_label: reviewerLabel,
      model: normalizedModel,
      reasoning_effort: reasoningEffort,
      error_code: 'PACKET_FORM_SPEC_MISMATCH',
      tier_fallback_used: false,
      disposition_counts: null,
      review: null,
      subjects: Object.freeze([]),
      answers: Object.freeze([]),
      contradictions: Object.freeze([]),
      gaps: Object.freeze([]),
      conclusion: null,
      reason: sanitizeDiagnosticText(mismatchMsg),
    });
  }
  const hasSuppliedImages = Array.isArray(imagePaths) && imagePaths.length > 0;
  const frozenPacket = freezeEvidenceReviewPacket(packetInput);
  const prompt = buildEvidenceReviewPrompt(frozenPacket);
  const admittedAttachments = stageAndHashReviewAttachments(imagePaths, {
    stageDir: null,
    expectedSha256s: frozenPacket.attachment_sha256s,
  });
  const originalAttachmentPaths = admittedAttachments.originalPaths;
  const attachmentSha256s = admittedAttachments.attachmentSha256s;

  const previewArgs = buildCodexExecArgs({
    model: explicitGateModel,
    reasoningEffort,
    webSearch,
    serviceTier,
    imagePaths: admittedAttachments.attachments.map((att, i) => `<sandbox>/attachment-${i + 1}${att.ext}`),
    cwd: '<workspace_read_only_dir>',
    skipGitRepoCheck: true,
    closedEvidenceOnly: false,
    schemaPath: '<temp_schema_json>',
    outputPath: '<temp_output_json>',
  });

  const payloadSha256 = sha256Hex(canonicalJson({
    runner: 'codex_exec_v1',
    model: explicitGateModel ?? 'inherited_config',
    reasoning_effort: reasoningEffort ?? 'inherited_config',
    web_search: webSearch,
    requested_service_tier: serviceTier ?? 'inherited_config',
    prompt_sha256: sha256Hex(prompt),
    schema_sha256: sha256Hex(canonicalJson(EVIDENCE_REVIEW_JSON_SCHEMA)),
    image_sha256s: attachmentSha256s,
  }));

  if (!enabled || dryRun) {
    return Object.freeze({
      status: 'unavailable',
      execution_status: 'not_submitted',
      content_status: null,
      dry_run: Boolean(dryRun),
      advisory_only: true,
      execution_provenance: executionProvenance,
      receipt_sha256: null,
      private_receipt_ref: null,
      schema_version: SCHEMA_VERSION,
      review_id: frozenPacket.review_id,
      packet_sha256: frozenPacket.packet_sha256,
      payload_sha256: payloadSha256,
      attachment_sha256s: attachmentSha256s,
      raw_output_sha256: null,
      reviewer_label: formatReviewerLabel(normalizedModel, reasoningEffort, 'live_subscription_codex'),
      model: normalizedModel,
      reasoning_effort: reasoningEffort,
      tier_fallback_used: false,
      cli_args_preview: redactArgsForReceipt(previewArgs),
      frozen_packet: frozenPacket,
      disposition_counts: null,
      review: null,
      subjects: Object.freeze([]),
      answers: Object.freeze([]),
      contradictions: Object.freeze([]),
      gaps: Object.freeze([]),
      conclusion: null,
      reason: dryRun
        ? 'Dry-run validation completed; Codex CLI was not invoked.'
        : (typeof disabledReason === 'string' && disabledReason.trim()
          ? sanitizeDiagnosticText(disabledReason.trim())
          : 'Evidence review is disabled by caller policy.'),
    });
  }

  // Validate P0-26 test-mode double requirement BEFORE claiming `review_id` so invalid test setups leave no stale claims!
  if (testMode === true) {
    if (spawnImpl !== undefined && (typeof spawnImpl !== 'function' || spawnImpl === spawn)) {
      throw new CodexRunnerError(
        'testMode forbids invoking real OS child_process.spawn; supply an in-process mockExecutor or test spawnImpl double.',
        { code: 'TEST_MODE_REQUIRES_IN_PROCESS_DOUBLE' },
      );
    }
    if (typeof mockExecutor !== 'function' && typeof spawnImpl !== 'function') {
      throw new CodexRunnerError(
        'testMode requires an explicit in-process mockExecutor or test spawnImpl double; real OS spawn is forbidden.',
        { code: 'TEST_MODE_REQUIRES_IN_PROCESS_DOUBLE' },
      );
    }
  } else if (mockExecutor !== null && mockExecutor !== undefined) {
    throw new CodexRunnerError('mockExecutor is forbidden outside testMode.', {
      code: 'CODEX_GUARD_BYPASS_FORBIDDEN',
    });
  } else if (spawnImpl !== undefined) {
    throw new CodexRunnerError('Custom spawnImpl is forbidden in production (testMode=false).', {
      code: 'CODEX_GUARD_BYPASS_FORBIDDEN',
    });
  }

  const defaultReceiptDir = testMode === true
    ? getDefaultTestReceiptStoreDir()
    : resolve(process.cwd(), '.local', 'receipts', 'codex-evidence-review');
  const effectiveReceiptStoreDir = receiptStoreDir
    ? resolve(receiptStoreDir.trim())
    : (receiptDir ? resolve(receiptDir.trim()) : defaultReceiptDir);

  // P1-02: Default `claimsDir` to `<effectiveReceiptStoreDir>/claims` EVEN when caller supplies ONLY `receiptPath`!
  const claimsBaseDir = receiptStoreDir
    ? resolve(receiptStoreDir.trim())
    : (receiptDir ? resolve(receiptDir.trim()) : defaultReceiptDir);
  const claimsDir = join(claimsBaseDir, 'claims');

  // Preflight BOTH `receiptPath` and `effectiveReceiptStoreDir` against ALL original `imagePaths` BEFORE claiming or staging!
  preflightPrivateReceiptDestination({
    receiptPath,
    receiptDir: effectiveReceiptStoreDir,
    protectedPaths: originalAttachmentPaths,
  });

  mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  if (!statSync(claimsDir).isDirectory()) {
    throw new CodexRunnerError('Evidence review claims path is not a directory.', {
      code: 'CODEX_RECEIPT_PERSISTENCE_FAILED',
    });
  }

  const claimFilePath = join(claimsDir, `claim-${sha256Hex(frozenPacket.review_id)}.json`);
  const initialClaimRecord = {
    schema_version: 1,
    kind: 'codex_evidence_review_claim',
    review_id: frozenPacket.review_id,
    packet_sha256: frozenPacket.packet_sha256,
    attachment_sha256s: [...attachmentSha256s],
    payload_sha256: payloadSha256,
    execution_provenance: executionProvenance,
    model: normalizedModel,
    reasoning_effort: reasoningEffort,
    status: 'in_progress',
    claimed_at: new Date().toISOString(),
    envelope: null,
  };

  let activeClaimPath = null;
  let claimedFresh = false;
  try {
    writeAtomicExclusiveBytes(claimFilePath, `${JSON.stringify(initialClaimRecord, null, 2)}\n`);
    claimedFresh = true;
    activeClaimPath = claimFilePath;
  } catch (claimErr) {
    if (claimErr?.code !== 'EEXIST') {
      throw new CodexRunnerError(
        `Failed to persist pre-spawn review_id claim: ${String(claimErr?.message || claimErr)}`,
        { code: 'CODEX_RECEIPT_PERSISTENCE_FAILED' },
      );
    }
  }

  if (!claimedFresh) {
    let existingClaim = null;
    try {
      existingClaim = JSON.parse(readFileSync(claimFilePath, 'utf8'));
    } catch {
      existingClaim = null;
    }
    if (!existingClaim || typeof existingClaim !== 'object' || Array.isArray(existingClaim)) {
      const corruptMsg = `Existing claim for review_id "${frozenPacket.review_id}" is unreadable or corrupt; manual reconciliation required.`;
      if (throwOnFailure) {
        throw new CodexRunnerError(corruptMsg, { code: 'REVIEW_CLAIM_CORRUPT' });
      }
      return Object.freeze({
        status: 'pending_recovery',
        execution_status: 'pending_recovery',
        content_status: null,
        advisory_only: true,
        execution_provenance: executionProvenance,
        receipt_sha256: null,
        private_receipt_ref: null,
        schema_version: SCHEMA_VERSION,
        review_id: frozenPacket.review_id,
        packet_sha256: frozenPacket.packet_sha256,
        payload_sha256: payloadSha256,
        attachment_sha256s: attachmentSha256s,
        raw_output_sha256: null,
        reviewer_label: reviewerLabel,
        model: normalizedModel,
        reasoning_effort: reasoningEffort,
        tier_fallback_used: false,
        error_code: 'REVIEW_CLAIM_CORRUPT',
        disposition_counts: null,
        review: null,
        subjects: Object.freeze([]),
        answers: Object.freeze([]),
        contradictions: Object.freeze([]),
        gaps: Object.freeze([]),
        conclusion: null,
        reason: sanitizeDiagnosticText(corruptMsg),
      });
    }

    const existingAtts = Array.isArray(existingClaim.attachment_sha256s) ? existingClaim.attachment_sha256s : [];
    const sameDigests =
      existingClaim.review_id === frozenPacket.review_id &&
      existingClaim.packet_sha256 === frozenPacket.packet_sha256 &&
      existingClaim.payload_sha256 === payloadSha256 &&
      existingAtts.length === attachmentSha256s.length &&
      existingAtts.every((h, idx) => h === attachmentSha256s[idx]);

    if (!sameDigests) {
      const conflictMsg =
        `review_id "${frozenPacket.review_id}" is already claimed with a different packet, attachment, or payload digest; refusing duplicate generation.`;
      if (throwOnFailure) {
        throw new CodexRunnerError(conflictMsg, { code: 'REVIEW_ID_CONFLICT' });
      }
      return Object.freeze({
        status: 'unavailable',
        execution_status: 'not_submitted',
        content_status: null,
        advisory_only: true,
        execution_provenance: executionProvenance,
        receipt_sha256: null,
        private_receipt_ref: null,
        schema_version: SCHEMA_VERSION,
        review_id: frozenPacket.review_id,
        packet_sha256: frozenPacket.packet_sha256,
        payload_sha256: payloadSha256,
        attachment_sha256s: attachmentSha256s,
        raw_output_sha256: null,
        reviewer_label: reviewerLabel,
        model: normalizedModel,
        reasoning_effort: reasoningEffort,
        tier_fallback_used: false,
        error_code: 'REVIEW_ID_CONFLICT',
        disposition_counts: null,
        review: null,
        subjects: Object.freeze([]),
        answers: Object.freeze([]),
        contradictions: Object.freeze([]),
        gaps: Object.freeze([]),
        conclusion: null,
        reason: sanitizeDiagnosticText(conflictMsg),
      });
    }

    if (existingClaim.status === 'ready' && existingClaim.envelope?.review) {
      // P1-16: On claim replay, OPEN AND VERIFY the referenced receipt file on disk BEFORE setting `receipt_persisted: true`!
      const verifiedOnDisk = verifySavedCodexReceipt(existingClaim.envelope, {
        receiptStoreDir: effectiveReceiptStoreDir,
        allowTestDouble: testMode === true,
      });
      if (!verifiedOnDisk.verified) {
        const failMsg = `Saved receipt verification failed during review_id "${frozenPacket.review_id}" replay: ${verifiedOnDisk.reason}`;
        if (throwOnFailure) {
          throw new CodexRunnerError(failMsg, { code: 'REVIEW_RECEIPT_VERIFICATION_FAILED' });
        }
        return Object.freeze({
          status: 'pending_recovery',
          execution_status: 'pending_recovery',
          content_status: null,
          replayed: true,
          receipt_persisted: false,
          advisory_only: true,
          execution_provenance: existingClaim.envelope?.execution_provenance ?? executionProvenance,
          receipt_sha256: existingClaim.envelope?.receipt_sha256 ?? null,
          private_receipt_ref: existingClaim.envelope?.private_receipt_ref ?? null,
          schema_version: SCHEMA_VERSION,
          review_id: frozenPacket.review_id,
          packet_sha256: frozenPacket.packet_sha256,
          payload_sha256: payloadSha256,
          attachment_sha256s: attachmentSha256s,
          raw_output_sha256: existingClaim.envelope?.raw_output_sha256 ?? null,
          reviewer_label: reviewerLabel,
          model: normalizedModel,
          reasoning_effort: reasoningEffort,
          tier_fallback_used: Boolean(existingClaim.envelope?.tier_fallback_used),
          error_code: 'REVIEW_RECEIPT_VERIFICATION_FAILED',
          disposition_counts: null,
          review: null,
          subjects: Object.freeze([]),
          answers: Object.freeze([]),
          contradictions: Object.freeze([]),
          gaps: Object.freeze([]),
          conclusion: null,
          reason: sanitizeDiagnosticText(failMsg),
        });
      }

      const revalidated = validateEvidenceReviewOutput(frozenPacket, verifiedOnDisk.raw_review);
      const cleanReplayedSpecSha = verifiedOnDisk.bound_form_spec_sha256 ?? existingClaim.envelope.form_spec_sha256 ?? null;
      return Object.freeze({
        status: 'ready',
        execution_status: 'completed',
        content_status: 'usable',
        replayed: true,
        advisory_only: true,
        validated_envelope: true,
        execution_provenance: verifiedOnDisk.execution_provenance,
        receipt_sha256: verifiedOnDisk.receipt_sha256,
        private_receipt_ref: `codex-receipt:${verifiedOnDisk.receipt_sha256}`,
        reviewed_at: verifiedOnDisk.reviewed_at ?? existingClaim.envelope.reviewed_at ?? null,
        ...(verifiedOnDisk.bound_candidate_id ? { candidate_id: verifiedOnDisk.bound_candidate_id } : {}),
        ...(cleanReplayedSpecSha ? { form_spec_sha256: cleanReplayedSpecSha, spec_sha256: cleanReplayedSpecSha } : {}),
        schema_version: SCHEMA_VERSION,
        review_id: frozenPacket.review_id,
        packet_sha256: frozenPacket.packet_sha256,
        payload_sha256: payloadSha256,
        attachment_sha256s: attachmentSha256s,
        raw_output_sha256: existingClaim.envelope.raw_output_sha256 ?? null,
        receipt_persisted: true,
        reviewer_label: verifiedOnDisk.reviewer_label,
        model: verifiedOnDisk.model,
        reasoning_effort: verifiedOnDisk.reasoning_effort,
        effective_service_tier: existingClaim.envelope.effective_service_tier ?? (serviceTier ?? null),
        tier_fallback_used: Boolean(existingClaim.envelope.tier_fallback_used),
        duration_ms: existingClaim.envelope.duration_ms ?? 0,
        disposition_counts: revalidated.disposition_counts,
        review: revalidated.review,
        subjects: revalidated.subjects,
        answers: revalidated.answers,
        contradictions: revalidated.contradictions,
        gaps: revalidated.gaps,
        conclusion: revalidated.conclusion,
        reason: null,
      });
    }

    if (existingClaim.status === 'unavailable' && existingClaim.envelope) {
      return Object.freeze({
        ...existingClaim.envelope,
        replayed: true,
        attachment_sha256s: attachmentSha256s,
        subjects: Object.freeze([]),
        answers: Object.freeze([]),
        contradictions: Object.freeze([]),
        gaps: Object.freeze([]),
      });
    }

    const pendingMsg = `review_id "${frozenPacket.review_id}" already has an in_progress or pending_recovery attempt; refusing duplicate generation.`;
    if (throwOnFailure) {
      throw new CodexRunnerError(pendingMsg, { code: 'REVIEW_ID_PENDING_RECOVERY' });
    }
    return Object.freeze({
      status: 'pending_recovery',
      execution_status: 'pending_recovery',
      content_status: null,
      replayed: true,
      advisory_only: true,
      execution_provenance: existingClaim.envelope?.execution_provenance ?? executionProvenance,
      receipt_sha256: existingClaim.envelope?.receipt_sha256 ?? null,
      private_receipt_ref: existingClaim.envelope?.private_receipt_ref ?? null,
      ...(existingClaim.envelope?.private_retained_ref ? { private_retained_ref: existingClaim.envelope.private_retained_ref } : {}),
      schema_version: SCHEMA_VERSION,
      review_id: frozenPacket.review_id,
      packet_sha256: frozenPacket.packet_sha256,
      payload_sha256: payloadSha256,
      attachment_sha256s: attachmentSha256s,
      raw_output_sha256: existingClaim.envelope?.raw_output_sha256 ?? null,
      reviewer_label: reviewerLabel,
      model: normalizedModel,
      reasoning_effort: reasoningEffort,
      tier_fallback_used: Boolean(existingClaim.envelope?.tier_fallback_used),
      error_code: existingClaim.envelope?.error_code ?? 'REVIEW_ID_PENDING_RECOVERY',
      disposition_counts: null,
      review: null,
      subjects: Object.freeze([]),
      answers: Object.freeze([]),
      contradictions: Object.freeze([]),
      gaps: Object.freeze([]),
      conclusion: null,
      reason: sanitizeDiagnosticText(existingClaim.envelope?.reason || pendingMsg),
    });
  }

  const persistClaimOutcome = (finalEnvelope) => {
    if (!activeClaimPath) return;
    const tmpClaimPath = `${activeClaimPath}.${generatePiiSafeUuid()}.tmp`;
    const updatedRecord = {
      ...initialClaimRecord,
      status: finalEnvelope.status,
      updated_at: new Date().toISOString(),
      envelope: finalEnvelope,
    };
    const claimBytes = Buffer.from(`${JSON.stringify(updatedRecord, null, 2)}\n`, 'utf8');
    writeAtomicExclusiveBytes(tmpClaimPath, claimBytes);
    renameSync(tmpClaimPath, activeClaimPath);
    if (sha256Hex(readFileSync(activeClaimPath)) !== sha256Hex(claimBytes)) {
      throw new Error('Claim update readback SHA-256 verification failed.');
    }
  };

  const releaseClaimIfPreSpawn = (errCode) => {
    if (!activeClaimPath) return false;
    const isPreSpawnError =
      errCode === 'CODEX_SUBSCRIPTION_AUTH_REQUIRED' ||
      errCode === 'CODEX_BIN_NOT_FOUND' ||
      errCode === 'CODEX_UNSAFE_SHIM' ||
      errCode === 'CODEX_GUARD_BYPASS_FORBIDDEN' ||
      errCode === 'TEST_MODE_REQUIRES_IN_PROCESS_DOUBLE' ||
      errCode === 'UNSUPPORTED_JSON_SCHEMA_KEYWORD' ||
      errCode === 'CODEX_SPAWN_FAILED';
    if (isPreSpawnError) {
      try {
        unlinkSync(activeClaimPath);
      } catch {
        // Best-effort cleanup of pre-spawn claim.
      }
      activeClaimPath = null;
      return true;
    }
    return false;
  };

  const sandboxDir = mkdtempSync(join(tmpdir(), 'codex-evrev-sandbox-'));
  try {
    chmodSync(sandboxDir, 0o700);
  } catch {
    // Best-effort on Windows NTFS ACLs.
  }
  let retainSandboxOnExit = false;
  let execResult;

  try {
    const stagedPacketPath = join(sandboxDir, 'packet.json');
    writeFileSync(stagedPacketPath, canonicalJson(frozenPacket), { encoding: 'utf8', mode: 0o600 });

    const stagedBundle = stageAndHashReviewAttachments(imagePaths, {
      stageDir: sandboxDir,
      expectedSha256s: frozenPacket.attachment_sha256s,
    });

    const boundCand = typeof candidateId === 'string' && candidateId.trim() ? candidateId.trim() : null;
    const boundSpec = typeof formSpecSha256 === 'string' && formSpecSha256.trim() ? formSpecSha256.trim() : null;
    execResult = await runCodexExecJson({
      prompt,
      schema: EVIDENCE_REVIEW_JSON_SCHEMA,
      model: explicitGateModel,
      reasoningEffort,
      webSearch,
      serviceTier,
      allowStandardTierFallback: allowTierFallback !== undefined ? allowTierFallback : allowStandardTierFallback,
      imagePaths: stagedBundle.stagedPaths,
      protectedInputPaths: originalAttachmentPaths,
      timeoutMs,
      cwd: cwd ?? (testMode ? sandboxDir : process.cwd()),
      skipGitRepoCheck: true,
      closedEvidenceOnly: false,
      codexBin,
      env,
      mockExecutor,
      spawnImpl,
      testMode,
      receiptPath,
      receiptStoreDir: effectiveReceiptStoreDir,
      useContentAddressedReceipt: true,
      receiptLabel: frozenPacket.review_id,
      reviewId: frozenPacket.review_id,
      packetSha256: frozenPacket.packet_sha256,
      candidateSubjectId: frozenPacket.candidate.subject_id,
      candidateSpecSha256: sha256Hex(canonicalJson(frozenPacket.candidate.spec)),
      boundCandidateId: boundCand,
      boundFormSpecSha256: boundSpec,
      postValidate: (parsed) => validateEvidenceReviewOutput(frozenPacket, parsed),
      platform,
      taskkillImpl,
      killProcessGroupImpl,
      winDescendantCheckImpl,
      _preStagedAttachments: stagedBundle,
      ...(fsImpl ? { fsImpl } : {}),
    });
  } catch (err) {
    if (err?.terminationUncertain && testMode !== true) {
      retainSandboxOnExit = true;
    }
    const releasedPreSpawn = releaseClaimIfPreSpawn(err?.code);

    const errReceiptSha = err?.receiptSha256 ?? null;
    const errPrivateReceiptRef = err?.privateReceiptRef ?? (errReceiptSha ? `codex-receipt:${errReceiptSha}` : null);
    const errPrivateRetainedRef = err?.privateRetainedRef ?? null;

    const isPendingRecoveryErr =
      err?.code === 'CODEX_RECEIPT_PERSISTENCE_FAILED' ||
      err?.timedOut === true ||
      err?.code === 'CODEX_TIMEOUT' ||
      err?.code === 'CODEX_OUTPUT_TOO_LARGE' ||
      err?.code === 'CODEX_OUTPUT_READ_ERROR' ||
      err?.code === 'CODEX_EMPTY_OUTPUT';

    let errEnvelope;
    if (isPendingRecoveryErr) {
      const safeReason = err?.code === 'CODEX_RECEIPT_PERSISTENCE_FAILED'
        ? 'Private receipt persistence failed.'
        : sanitizeDiagnosticText(String(err?.message || err));
      errEnvelope = Object.freeze({
        status: 'pending_recovery',
        execution_status: 'pending_recovery',
        content_status: null,
        termination_uncertain: Boolean(err?.terminationUncertain),
        retained_output_available: Boolean(err?.retainedOutputPath || errPrivateRetainedRef),
        advisory_only: true,
        execution_provenance: executionProvenance,
        receipt_sha256: errReceiptSha,
        private_receipt_ref: errPrivateReceiptRef,
        ...(errPrivateRetainedRef ? { private_retained_ref: errPrivateRetainedRef } : {}),
        schema_version: SCHEMA_VERSION,
        review_id: frozenPacket.review_id,
        packet_sha256: frozenPacket.packet_sha256,
        payload_sha256: payloadSha256,
        attachment_sha256s: attachmentSha256s,
        raw_output_sha256: err?.rawOutputSha256 ?? null,
        reviewer_label: reviewerLabel,
        model: normalizedModel,
        reasoning_effort: reasoningEffort,
        tier_fallback_used: Boolean(err?.tierFallbackUsed),
        error_code: err?.code ?? 'CODEX_RECOVERY_REQUIRED',
        disposition_counts: null,
        review: null,
        subjects: Object.freeze([]),
        answers: Object.freeze([]),
        contradictions: Object.freeze([]),
        gaps: Object.freeze([]),
        conclusion: null,
        reason: safeReason,
      });
    } else {
      const isInvalidContent =
        err?.code === 'CODEX_INVALID_JSON' ||
        err?.code === 'CODEX_INVALID_JSON_ROOT' ||
        err?.code === 'CODEX_SCHEMA_VALIDATION_FAILED' ||
        err?.code === 'EVIDENCE_REVIEW_VALIDATION_FAILED';

      errEnvelope = Object.freeze({
        status: 'unavailable',
        execution_status: isInvalidContent ? 'completed' : (releasedPreSpawn ? 'not_submitted' : 'failed_known'),
        content_status: isInvalidContent ? 'invalid' : null,
        advisory_only: true,
        execution_provenance: executionProvenance,
        receipt_sha256: errReceiptSha,
        private_receipt_ref: errPrivateReceiptRef,
        ...(errPrivateRetainedRef ? { private_retained_ref: errPrivateRetainedRef } : {}),
        schema_version: SCHEMA_VERSION,
        review_id: frozenPacket.review_id,
        packet_sha256: frozenPacket.packet_sha256,
        payload_sha256: payloadSha256,
        attachment_sha256s: attachmentSha256s,
        raw_output_sha256: err?.rawOutputSha256 ?? null,
        reviewer_label: reviewerLabel,
        model: normalizedModel,
        reasoning_effort: reasoningEffort,
        tier_fallback_used: Boolean(err?.tierFallbackUsed),
        error_code: err?.code ?? 'CODEX_EXEC_ERROR',
        disposition_counts: null,
        review: null,
        subjects: Object.freeze([]),
        answers: Object.freeze([]),
        contradictions: Object.freeze([]),
        gaps: Object.freeze([]),
        conclusion: null,
        reason: sanitizeDiagnosticText(String(err?.message || err)),
      });
    }

    if (!releasedPreSpawn) {
      try {
        persistClaimOutcome(errEnvelope);
      } catch {
        retainSandboxOnExit = true;
      }
    }

    if (throwOnFailure) throw err;
    return errEnvelope;
  } finally {
    if (!retainSandboxOnExit) {
      try {
        rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 });
      } catch {
        // Ignore cleanup race on Windows AV locks; sandbox contains only admitted copies.
      }
    }
  }

  const validated = execResult.post_validated;
  const finalCandId = typeof candidateId === 'string' && candidateId.trim() ? candidateId.trim() : null;
  const finalSpecSha = typeof formSpecSha256 === 'string' && formSpecSha256.trim() ? formSpecSha256.trim() : null;

  const readyEnvelope = Object.freeze({
    status: 'ready',
    execution_status: 'completed',
    content_status: 'usable',
    advisory_only: true,
    validated_envelope: Boolean(execResult.receipt_persisted),
    execution_provenance: execResult.execution_provenance,
    receipt_sha256: execResult.receipt_sha256,
    private_receipt_ref: execResult.private_receipt_ref,
    reviewed_at: execResult.recorded_at ?? null,
    ...(finalCandId ? { candidate_id: finalCandId } : {}),
    ...(finalSpecSha ? { form_spec_sha256: finalSpecSha, spec_sha256: finalSpecSha } : {}),
    ...(execResult.first_attempt_receipt_sha256 ? { first_attempt_receipt_sha256: execResult.first_attempt_receipt_sha256 } : {}),
    schema_version: SCHEMA_VERSION,
    review_id: frozenPacket.review_id,
    packet_sha256: frozenPacket.packet_sha256,
    payload_sha256: execResult.payload_sha256,
    attachment_sha256s: attachmentSha256s,
    raw_output_sha256: execResult.raw_output_sha256,
    receipt_persisted: Boolean(execResult.receipt_persisted),
    reviewer_label: reviewerLabel,
    model: execResult.model,
    reasoning_effort: execResult.reasoning_effort,
    effective_service_tier: execResult.effective_service_tier,
    tier_fallback_used: execResult.tier_fallback_used,
    duration_ms: execResult.duration_ms,
    disposition_counts: validated.disposition_counts,
    review: validated.review,
    subjects: validated.subjects,
    answers: validated.answers,
    contradictions: validated.contradictions,
    gaps: validated.gaps,
    conclusion: validated.conclusion,
    reason: null,
  });

  try {
    persistClaimOutcome(readyEnvelope);
  } catch (claimPersistErr) {
    if (throwOnFailure) {
      throw new CodexRunnerError(
        `Failed to persist completed review_id claim: ${String(claimPersistErr?.message || claimPersistErr)}`,
        {
          code: 'CODEX_RECEIPT_PERSISTENCE_FAILED',
          rawOutputSha256: execResult.raw_output_sha256,
          receiptSha256: execResult.receipt_sha256,
          executionProvenance: execResult.execution_provenance,
          privateReceiptRef: execResult.private_receipt_ref,
        },
      );
    }
    return Object.freeze({
      status: 'pending_recovery',
      execution_status: 'pending_recovery',
      content_status: null,
      advisory_only: true,
      execution_provenance: execResult.execution_provenance,
      receipt_sha256: execResult.receipt_sha256,
      private_receipt_ref: execResult.private_receipt_ref,
      schema_version: SCHEMA_VERSION,
      review_id: frozenPacket.review_id,
      packet_sha256: frozenPacket.packet_sha256,
      payload_sha256: execResult.payload_sha256,
      attachment_sha256s: attachmentSha256s,
      raw_output_sha256: execResult.raw_output_sha256,
      reviewer_label: reviewerLabel,
      model: normalizedModel,
      reasoning_effort: reasoningEffort,
      tier_fallback_used: execResult.tier_fallback_used,
      error_code: 'CODEX_RECEIPT_PERSISTENCE_FAILED',
      disposition_counts: null,
      review: null,
      subjects: Object.freeze([]),
      answers: Object.freeze([]),
      contradictions: Object.freeze([]),
      gaps: Object.freeze([]),
      conclusion: null,
      reason: 'Private receipt persistence failed.',
    });
  }

  return readyEnvelope;
}

export { ALLOWED_GATE4_EFFORTS, verifySavedCodexReceipt, validateJsonAgainstStrictSchema };
