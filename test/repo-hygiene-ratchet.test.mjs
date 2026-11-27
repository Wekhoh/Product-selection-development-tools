import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Baseline count of residual r50-r58 dead branches/fallbacks in src/ as of PR #40 merge.
// Ratchet rule: this ceiling may only decrease (prune dead branches), never increase.
const RESIDUAL_R50_R58_MAX = 56;

// Baseline allowlist of chronicle test files in test/ (M1 PR A1).
// Ratchet rule: new issue-*/batch-*/stage*/r59-* files are forbidden; M3 shrinks this list as tests consolidate.
const CHRONICLE_TEST_ALLOWLIST = new Set([
  'batch-a1-pricing-keepa-channel-fixes.test.mjs',
  'batch-a2-report-ad-dedup-fixes.test.mjs',
  'batch-a3-batch-cli-resume-fixes.test.mjs',
  'issue-11-price-band-veteran-threshold.test.mjs',
  'issue-23-steady-state-bare-goods.test.mjs',
  'issue-28-1688-luna-ranking-anti-false-kill.test.mjs',
  'issue-33-dated-keepa-sp-api-calibration.test.mjs',
  'issue-5-carton-weight-headhaul.test.mjs',
  'issue-6-sourcing-parity-and-guardrails.test.mjs',
  'issue-8-review-dispute-scenario-linkage.test.mjs',
  'issue-9-calibration-tracking-separation.test.mjs',
  'r59-round1-round2-upgrades.test.mjs',
  'r59-round3-closure.test.mjs',
  'r59-step2-ranking-evergreen.test.mjs',
  'r59-step3-daily-entrypoints.test.mjs',
  'r59-step4-signoff-regressions.test.mjs',
  'stage5a-return-inquiry.test.mjs',
]);

// Baseline allowlist of duplicate utility declarations in src/ outside src/utils/ (and src/contracts.mjs for assertNonemptyString).
// Ratchet rule: zero new duplicates allowed; M2 shrinks this allowlist to empty.
const DUPLICATE_UTIL_ALLOWLIST = new Set([
  'openai/budget-ledger.mjs:generatePiiSafeUuid',
  'openai/client.mjs:assertPlainObject',
  'openai/client.mjs:generatePiiSafeUuid',
  'openai/client.mjs:isPlainObject',
  'openai/codex-runner.mjs:generatePiiSafeUuid',
  'openai/codex-runner.mjs:isPlainObject',
  'openai/evidence-review.mjs:assertNonemptyString',
  'openai/evidence-review.mjs:assertPlainObject',
  'openai/evidence-review.mjs:deepFreeze',
  'openai/evidence-review.mjs:isPlainObject',
  'openai/response-envelope.mjs:assertPlainObject',
  'openai/response-envelope.mjs:isPlainObject',
  'openai/stage5-return-inquiry.mjs:assertNonemptyString',
  'openai/stage5-return-inquiry.mjs:assertPlainObject',
  'openai/stage5-return-inquiry.mjs:deepFreeze',
  'openai/stage5-return-inquiry.mjs:isPlainObject',
  'openai/workflow-tasks.mjs:assertNonemptyString',
  'openai/workflow-tasks.mjs:assertPlainObject',
  'openai/workflow-tasks.mjs:deepFreeze',
  'openai/workflow-tasks.mjs:isPlainObject',
  'store.mjs:canonicalJson',
  'store.mjs:sha256Hex',
]);

// Baseline per-file ceiling of duplicate email redaction regexes in src/ outside src/contracts.mjs (7 across 6 files).
const DUPLICATE_EMAIL_REGEX_ALLOWLIST = Object.freeze({
  'openai/background.mjs': 1,
  'openai/client.mjs': 1,
  'openai/stage5-return-inquiry.mjs': 1,
  'openai/workflow-tasks.mjs': 1,
  'report.mjs': 1,
  'store.mjs': 2,
});

const R1_GOVERNANCE_FILES = Object.freeze([
  'AGENTS.md',
  'docs/DEVELOPMENT.md',
  'docs/SPEC.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'docs/API-MIGRATION.md',
]);

// Frozen SHA-256 + byte-length manifest of all 22 files under docs/archive/ (PR #40 merged main).
// Embedded directly so immutability is enforced even under shallow CI checkouts (fetch-depth: 1).
const FROZEN_ARCHIVE_MANIFEST = Object.freeze({
  'DECISIONS.md': Object.freeze({
    bytes: 215614,
    sha256: '253b93678c10747c45b92ce92e0041dd028964c213fd51587563c16ebb784960',
  }),
  'MIGRATION.md': Object.freeze({
    bytes: 3018,
    sha256: '00c337a824885801bba71114b4a65dd5741faad2cb94b061f2d9d5e50e1547a1',
  }),
  'PRODUCT.md': Object.freeze({
    bytes: 98156,
    sha256: '3a238705d242881f1c96d6e7e9beb34182b83f59494596a0860cf6f819449a4c',
  }),
  'api/EVIDENCE-REVIEW-CONTRACT.draft.md': Object.freeze({
    bytes: 20776,
    sha256: 'd5099b08b850cea9633765acda1d2ad40012548b007aed22e2aeb22de6e95eb9',
  }),
  'api/OFFICIAL-OPENAI-OPTIONS.2026-11-14.md': Object.freeze({
    bytes: 13722,
    sha256: 'e69aad72b1a8d1fb33694b9c848ca066d5b819aa8da1c90fdc75cbeabd6b04f5',
  }),
  'design/COMPETITION.draft.md': Object.freeze({
    bytes: 13679,
    sha256: 'c99a56de6314cd40563cd9d2a979503f25649be805312a060c2770bd5ba7b72e',
  }),
  'design/DEMAND.draft.md': Object.freeze({
    bytes: 9808,
    sha256: '2a820bce0a030e397ca50082b0b844ae6d72086b4918bb87fb3bf325ff90ed4e',
  }),
  'design/FIRST-RELEASE.draft.md': Object.freeze({
    bytes: 76512,
    sha256: '28422ca12e701eb8795741d1d23855c9a33d4442b01bbba714fc6c215be961f7',
  }),
  'design/PROFITABILITY.draft.md': Object.freeze({
    bytes: 56922,
    sha256: '2e79be3e0aeeafe0229f3ee00fcf8dff09fe1bf54715ba2b0c512716d06eebe7',
  }),
  'design/Q31-NORMAL-NEWCOMER.draft.md': Object.freeze({
    bytes: 143158,
    sha256: '93dd41ccc94d2014974f6dd0e223e7fe852a163ca5c51e2072d8b1571de6bb4f',
  }),
  'design/SUGGESTED-BID.draft.md': Object.freeze({
    bytes: 11471,
    sha256: '2c54dd0dd294f92a9009e033481cb9d270a7c3abb057dc6132ede72c3ad93cf1',
  }),
  'design/TRIAL-INPUT.md': Object.freeze({
    bytes: 40650,
    sha256: '35bd58f272ec4cf87db84ea9216e68dd532134cbbb99eca2e1dd7596b6c1fe28',
  }),
  'design/reference-profile.r58.archived.json': Object.freeze({
    bytes: 100134,
    sha256: '801192a2840288fe016935a0cff089887c2c793327724fbb587ff62ae8d3ceef',
  }),
  'research/20261113-1688-mcp-cli-research.zh-CN.md': Object.freeze({
    bytes: 11581,
    sha256: '73f7927a4f1a6673ece76f6da0763eabafb0410bf1db21d2bb3c2771d72056f9',
  }),
  'research/20261114-discovery-methods-reuse.md': Object.freeze({
    bytes: 7090,
    sha256: '4e7c7cde07e329a28db452af325bc92f287985567f8321832f6e47b77fa4306c',
  }),
  'research/20261114-discovery-opportunity-brainstorm.md': Object.freeze({
    bytes: 17115,
    sha256: 'ca4191976b7a8a8ef745637a357fdd4afd942095506e3e9e1d235a23ce8fcfca',
  }),
  'research/newcomer-brand-support-evidence-20261111.md': Object.freeze({
    bytes: 46276,
    sha256: '4e1c8e63b6a05f7a89290036a8e00c3d72b7b93ef0358450128b2ed7d75cca91',
  }),
  'research/reuse-and-workbench-20261111.md': Object.freeze({
    bytes: 24196,
    sha256: '647791088c1ca4dbae69041554d1474b236927544db048954ec202befec663e0',
  }),
  'research/us-fba-fee-basis-20261114.md': Object.freeze({
    bytes: 17169,
    sha256: '54c37a74abc10c914c3086794f982e59bb306abde9c409edc18bd9a96f55d9fe',
  }),
  'reviews/20261113-scoring-overlap.md': Object.freeze({
    bytes: 18055,
    sha256: 'af8f1c5964ae558ce3211487d340510365d2f2ccdf8bfb5d59a1de23fe1e6944',
  }),
  'reviews/20261113-scoring-pretrial.md': Object.freeze({
    bytes: 14566,
    sha256: 'c5d8831f2cad9f28f516967bd811c6f547f8a1ce2d57c7216127fc3cf6ef6df2',
  }),
  'reviews/design-continuity-20261111.md': Object.freeze({
    bytes: 5097,
    sha256: '70e5d82290dd3f9bee2aefca292b989fa1385c2717d5d8ab0bd8582d3d6d6b43',
  }),
});

function walkFiles(dir, predicate = () => true) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, predicate));
    } else if (entry.isFile() && predicate(full, entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function toPosixRel(rootDir, filePath) {
  return relative(rootDir, filePath).replace(/\\/g, '/');
}

function stripSingleAndDoubleStrings(line) {
  return line
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function scanResidualR50ToR58(srcDir) {
  const files = walkFiles(srcDir, (_, name) => name.endsWith('.mjs'));
  const hits = [];
  for (const file of files) {
    const rel = toPosixRel(srcDir, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (!trimmed || trimmed.startsWith('//')) continue;
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith('*')) continue;

      // Preserve SQLite schema >= 50 / < 50 backwards-compatibility checks in store.mjs
      if (rel === 'store.mjs' && /(?:CHECK\(profile_revision\s*>=\s*50\)|ev\.profile_revision\s*<\s*50)/.test(trimmed)) {
        continue;
      }

      const code = stripSingleAndDoubleStrings(trimmed);

      const hasR50To58ComparisonOrDefault =
        /(?:\b(?:rev|revision|profileRevision|profile_revision|effectiveRev|pbRev|preRev|effPreRev|specRev|g1aProfileRev|g1bProfileRev)\b(?:\s*\?\?\s*\d+)?\)?\s*(?:[<>]=?|[!=]==?)\s*5[0-8]\b|\b(?:profile_revision|profileRevision|revision|rev)\s*\?\?\s*5[0-8]\b|\bisR5[0-8]\s*=\s*false\b)/.test(code);

      const hasLt59Check =
        /(?:\b(?:rev|revision|profileRevision|profile_revision|effectiveRev|pbRev|preRev|effPreRev|specRev|g1aProfileRev|g1bProfileRev)\b(?:\s*\?\?\s*59)?\)?\s*<\s*59\b|\bprofile\.revision\b(?:\s*\?\?\s*59)?\)?\s*<\s*59\b)/.test(code);

      let matched = hasR50To58ComparisonOrDefault;
      if (!matched && hasLt59Check) {
        // Legitimate retirement validation guards throw an Error within the next few lines
        const lookahead = lines.slice(i, Math.min(lines.length, i + 7)).join('\n');
        const isThrowingGuard = /\bthrow\s+new\s+[A-Za-z0-9_]*Error\b/.test(lookahead);
        if (!isThrowingGuard) matched = true;
      }

      if (matched) {
        hits.push({ file: rel, line: i + 1, text: trimmed });
      }
    }
  }
  return hits;
}

function assertResidualR50ToR58Ratchet(srcDir, maxAllowed = RESIDUAL_R50_R58_MAX) {
  const hits = scanResidualR50ToR58(srcDir);
  assert.ok(
    hits.length <= maxAllowed,
    `src/ residual r50-r58 dead-branch count ${hits.length} exceeds ratchet ceiling ${maxAllowed}:\n` +
      hits.map(h => `  - ${h.file}:${h.line}: ${h.text}`).join('\n'),
  );
  return hits;
}

function stripFencedCodeBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let fenceChar = null;
  let fenceLen = 0;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const m = /^(`{3,}|~{3,})/.exec(trimmed);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (!fenceChar) {
        fenceChar = ch;
        fenceLen = len;
        out.push('');
        continue;
      }
      if (ch === fenceChar && len >= fenceLen && trimmed.slice(len).trim() === '') {
        fenceChar = null;
        fenceLen = 0;
        out.push('');
        continue;
      }
    }
    out.push(fenceChar ? '' : line);
  }
  return out.join('\n');
}

function scanBrokenRelativeMdLinksForFiles(mdFiles, baseRoot) {
  const broken = [];
  let checkedCount = 0;
  const inlineLinkRe = /\[([^\]]+)\]\(([^)\n]+)\)/g;
  for (const mdFile of mdFiles) {
    const raw = readFileSync(mdFile, 'utf8');
    const cleaned = stripFencedCodeBlocks(raw).replace(/`[^`\n]+`/g, '');
    let match;
    while ((match = inlineLinkRe.exec(cleaned)) !== null) {
      const rawTarget = match[2].replace(/\s+"[^"]*"$/, '').trim();
      if (!rawTarget || /^(?:https?:\/\/|mailto:|file:\/\/|#)/i.test(rawTarget)) continue;
      const hashIdx = rawTarget.indexOf('#');
      const withoutHash = hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget;
      const queryIdx = withoutHash.indexOf('?');
      const filePart = queryIdx >= 0 ? withoutHash.slice(0, queryIdx) : withoutHash;
      if (!filePart.toLowerCase().endsWith('.md')) continue;
      checkedCount++;
      const resolved = resolve(dirname(mdFile), filePart);
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        broken.push({
          from: toPosixRel(baseRoot, mdFile),
          target: rawTarget,
        });
      }
    }
  }
  return { mdFilesCount: mdFiles.length, checkedCount, broken };
}

function scanBrokenRelativeMdLinks(docsDir) {
  const mdFiles = walkFiles(docsDir, (_, name) => name.endsWith('.md'));
  return scanBrokenRelativeMdLinksForFiles(mdFiles, docsDir);
}

function assertNoBrokenRelativeMdLinks(docsDir) {
  const result = scanBrokenRelativeMdLinks(docsDir);
  assert.deepEqual(
    result.broken,
    [],
    `Broken relative .md links under docs/: ${result.broken.map(b => `${b.from} -> ${b.target}`).join('; ')}`,
  );
  return result;
}

function assertNoBrokenRelativeMdLinksInFiles(mdFiles, baseRoot) {
  const result = scanBrokenRelativeMdLinksForFiles(mdFiles, baseRoot);
  assert.deepEqual(
    result.broken,
    [],
    `Broken relative .md links in root docs: ${result.broken.map(b => `${b.from} -> ${b.target}`).join('; ')}`,
  );
  return result;
}

function verifyFrozenArchive(archiveDir, manifest = FROZEN_ARCHIVE_MANIFEST) {
  const actualFiles = walkFiles(archiveDir);
  const actualByRel = new Map();
  for (const file of actualFiles) {
    const rel = toPosixRel(archiveDir, file);
    const buf = readFileSync(file);
    actualByRel.set(rel, {
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    });
  }

  const unexpected = [];
  const missing = [];
  const modified = [];

  for (const rel of actualByRel.keys()) {
    if (!(rel in manifest)) unexpected.push(rel);
  }
  for (const [rel, expected] of Object.entries(manifest)) {
    const actual = actualByRel.get(rel);
    if (!actual) {
      missing.push(rel);
      continue;
    }
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      modified.push({ rel, expected, actual });
    }
  }

  assert.deepEqual(unexpected, [], `Unexpected new file(s) added to frozen archive: ${unexpected.join(', ')}`);
  assert.deepEqual(missing, [], `Frozen archive file(s) missing: ${missing.join(', ')}`);
  assert.deepEqual(
    modified,
    [],
    `Frozen archive file(s) modified or appended: ${modified.map(m => `${m.rel} (${m.actual.bytes}B != ${m.expected.bytes}B)`).join(', ')}`,
  );
  return actualByRel.size;
}

test('hygiene rule 1 (live): src/ residual r50-r58 dead-branch count stays at or below ratchet ceiling without false-positiving on <59 guards, store compat, or domain constants', () => {
  const hits = assertResidualR50ToR58Ratchet(join(REPO_ROOT, 'src'), RESIDUAL_R50_R58_MAX);
  assert.equal(hits.length, RESIDUAL_R50_R58_MAX);
});

test('hygiene rule 1 (negative & boundary): synthetic r50-r58 fallback fails while <59 throwing guard, store.mjs >=50 compat, and unrelated 50..58 constants pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r1-'));
  try {
    writeFileSync(
      join(dir, 'store.mjs'),
      [
        'const ddl = "CHECK(profile_revision >= 50)";',
        'if (!Number.isInteger(ev.profile_revision) || ev.profile_revision < 50) throw new TypeError("compat");',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dir, 'clean.mjs'),
      [
        '// if (revision <= 58) return legacy;',
        '/* if (profileRevision >= 57) {} */',
        'export function validateRevision(revision) {',
        '  if (revision < 59) {',
        '    throw new RangeError("r50-r58 retired");',
        '  }',
        '  return revision;',
        '}',
        'export function unrelatedConstants(status, badgeNum, timeoutMs, maxEvaluatedPrice) {',
        '  return status >= 500 || badgeNum >= 50 || timeoutMs >= 50 || maxEvaluatedPrice >= 50.00;',
        '}',
      ].join('\n'),
      'utf8',
    );

    // Boundary: legitimate throwing < 59 guard + store.mjs compat + unrelated 50..58 constants -> 0 hits
    assert.equal(assertResidualR50ToR58Ratchet(dir, 0).length, 0);

    // Negative 1: adding a synthetic if (revision <= 58) fallback triggers ratchet failure
    writeFileSync(
      join(dir, 'legacy-fallback.mjs'),
      'export function legacyBranch(revision) { if (revision <= 58) return 1; return 2; }\n',
      'utf8',
    );
    assert.throws(
      () => assertResidualR50ToR58Ratchet(dir, 0),
      /exceeds ratchet ceiling 0/,
    );

    // Negative 2: non-throwing < 59 branch also triggers ratchet failure
    rmSync(join(dir, 'legacy-fallback.mjs'));
    writeFileSync(
      join(dir, 'silent-lt59.mjs'),
      'export function silentBranch(revision) { if (revision < 59) return null; return 59; }\n',
      'utf8',
    );
    assert.throws(
      () => assertResidualR50ToR58Ratchet(dir, 0),
      /exceeds ratchet ceiling 0/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hygiene rule 2 (live): docs/ contains zero broken relative .md links', () => {
  const res = assertNoBrokenRelativeMdLinks(join(REPO_ROOT, 'docs'));
  assert.ok(res.mdFilesCount >= 30);
  assert.ok(res.checkedCount >= 150);
});

test('hygiene rule 2 (negative & boundary): catches broken relative .md link while accepting .md#section and skipping URLs, mailto, and fenced code blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r2-'));
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'target.md'), '# Section One\n', 'utf8');
    writeFileSync(
      join(dir, 'index.md'),
      [
        '# Index',
        '',
        '- Valid anchor link: [Target](sub/target.md#section-one)',
        '- External URL: [OpenAI](https://example.com/missing.md)',
        '- Mailto: [Owner](mailto:owner@example.com)',
        '- Same-file anchor: [Top](#index)',
        '- Inline code: `[ignored](no-such-inline.md)`',
        '',
        '```markdown',
        '[Ignored fenced](no-such-fenced.md)',
        '```',
      ].join('\n'),
      'utf8',
    );

    const ok = assertNoBrokenRelativeMdLinks(dir);
    assert.equal(ok.checkedCount, 1);

    writeFileSync(
      join(dir, 'broken.md'),
      'See [Missing](sub/does-not-exist.md#intro) for details.\n',
      'utf8',
    );
    assert.throws(
      () => assertNoBrokenRelativeMdLinks(dir),
      /Broken relative \.md links under docs\/: broken\.md -> sub\/does-not-exist\.md#intro/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hygiene rule 3 (live): docs/archive/ matches exact 22-file frozen SHA-256 and byte-length manifest', () => {
  const count = verifyFrozenArchive(join(REPO_ROOT, 'docs', 'archive'));
  assert.equal(count, 22);
});

test('hygiene rule 3 (negative & boundary): appending body text or adding an unexpected file to frozen archive fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r3-'));
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const aBuf = Buffer.from('# Frozen Doc A\n\nBody.\n', 'utf8');
    const bBuf = Buffer.from('# Frozen Doc B\n', 'utf8');
    writeFileSync(join(dir, 'A.md'), aBuf);
    writeFileSync(join(dir, 'sub', 'B.md'), bBuf);

    const manifest = {
      'A.md': { bytes: aBuf.length, sha256: createHash('sha256').update(aBuf).digest('hex') },
      'sub/B.md': { bytes: bBuf.length, sha256: createHash('sha256').update(bBuf).digest('hex') },
    };

    assert.equal(verifyFrozenArchive(dir, manifest), 2);

    // Negative 1: appending body text fails
    writeFileSync(join(dir, 'A.md'), Buffer.concat([aBuf, Buffer.from('\nAppended line\n', 'utf8')]));
    assert.throws(
      () => verifyFrozenArchive(dir, manifest),
      /Frozen archive file\(s\) modified or appended: A\.md/,
    );

    // Restore A.md, then Negative 2: adding an unexpected new file fails
    writeFileSync(join(dir, 'A.md'), aBuf);
    writeFileSync(join(dir, 'unexpected.md'), 'new file\n', 'utf8');
    assert.throws(
      () => verifyFrozenArchive(dir, manifest),
      /Unexpected new file\(s\) added to frozen archive: unexpected\.md/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Rule 2 extension: root README.md, AGENTS.md, GLOSSARY.md relative .md link check ---

test('hygiene rule 2b (live): root README.md, AGENTS.md, and GLOSSARY.md contain zero broken relative .md links', () => {
  const rootFiles = ['README.md', 'AGENTS.md', 'GLOSSARY.md'].map(f => join(REPO_ROOT, f));
  const res = assertNoBrokenRelativeMdLinksInFiles(rootFiles, REPO_ROOT);
  assert.equal(res.mdFilesCount, 3);
  assert.ok(res.checkedCount >= 20);
});

test('hygiene rule 2b (negative & boundary): catches broken relative .md links in root docs without false-positiving on valid links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r2b-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'SPEC.md'), '# Spec\n', 'utf8');
    const readme = join(dir, 'README.md');
    const agents = join(dir, 'AGENTS.md');
    const glossary = join(dir, 'GLOSSARY.md');
    writeFileSync(readme, 'See [Spec](docs/SPEC.md#top) and [Site](https://example.com/a.md).\n', 'utf8');
    writeFileSync(agents, 'Read [Glossary](GLOSSARY.md).\n', 'utf8');
    writeFileSync(glossary, '# Glossary\n', 'utf8');

    const ok = assertNoBrokenRelativeMdLinksInFiles([readme, agents, glossary], dir);
    assert.equal(ok.checkedCount, 2);

    writeFileSync(agents, 'Broken [Missing](docs/NOPE.md).\n', 'utf8');
    assert.throws(
      () => assertNoBrokenRelativeMdLinksInFiles([readme, agents, glossary], dir),
      /Broken relative \.md links in root docs: AGENTS\.md -> docs\/NOPE\.md/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Rule 4: Chronicle test anti-fragmentation ratchet ---

const CHRONICLE_TEST_NAME_RE = /^(?:issue-|batch-|stage|r59-).*\.test\.mjs$/i;

function assertChronicleTestAllowlist(testDir, allowlist = CHRONICLE_TEST_ALLOWLIST) {
  const matching = readdirSync(testDir, { withFileTypes: true })
    .filter(e => e.isFile() && CHRONICLE_TEST_NAME_RE.test(e.name))
    .map(e => e.name)
    .sort();
  const matchingSet = new Set(matching);

  const unexpected = matching.filter(name => !allowlist.has(name));
  const stale = [...allowlist].filter(name => !matchingSet.has(name)).sort();

  assert.deepEqual(
    unexpected,
    [],
    `Unexpected new chronicle test file(s) detected (consolidate into domain test files instead): ${unexpected.join(', ')}`,
  );
  assert.deepEqual(
    stale,
    [],
    `Stale entry(ies) in CHRONICLE_TEST_ALLOWLIST (remove retired files to ratchet debt down): ${stale.join(', ')}`,
  );
  return matching.length;
}

test('hygiene rule 4 (live): test/ contains only the exact 17 allowlisted chronicle test files', () => {
  const count = assertChronicleTestAllowlist(join(REPO_ROOT, 'test'));
  assert.equal(count, 17);
});

test('hygiene rule 4 (negative & boundary): forbids new issue-/batch-/stage/r59- test files and catches stale allowlist entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r4-'));
  try {
    writeFileSync(join(dir, 'scoring.test.mjs'), '// domain test\n', 'utf8');
    writeFileSync(join(dir, 'issue-5-carton-weight-headhaul.test.mjs'), '// allowlisted\n', 'utf8');
    const allowlist = new Set(['issue-5-carton-weight-headhaul.test.mjs']);

    assert.equal(assertChronicleTestAllowlist(dir, allowlist), 1);

    for (const badName of ['issue-99-new.test.mjs', 'batch-b1-new.test.mjs', 'stage6-new.test.mjs', 'r59-extra.test.mjs']) {
      const badPath = join(dir, badName);
      writeFileSync(badPath, '// fragmented test\n', 'utf8');
      assert.throws(
        () => assertChronicleTestAllowlist(dir, allowlist),
        new RegExp(`Unexpected new chronicle test file\\(s\\) detected.*${badName.replace('.', '\\.')}`),
      );
      rmSync(badPath);
    }

    rmSync(join(dir, 'issue-5-carton-weight-headhaul.test.mjs'));
    assert.throws(
      () => assertChronicleTestAllowlist(dir, allowlist),
      /Stale entry\(ies\) in CHRONICLE_TEST_ALLOWLIST.*issue-5-carton-weight-headhaul\.test\.mjs/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Rule 5: Duplicate utility definitions & email regex ratchets in src/ ---

const DUPLICATE_UTIL_DECL_RE =
  /\b(?:function|const|let|var)\s+(isPlainObject|assertPlainObject|assertNonemptyString|deepFreeze|generatePiiSafeUuid|canonicalJson|sha256Hex)\b/g;

const REGEX_PREV_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'delete', 'void', 'await', 'yield', 'else',
]);
const EMAIL_REGEX_BODY_RE = /(?:\[[^\]]*\]|[^\s@])+\+?@[^\r\n]*\\\./;

function scanJsLexical(source) {
  let codeWithoutCommentsOrStrings = '';
  const regexLiterals = [];
  let i = 0;
  let line = 1;
  let prevSig = '';
  let prevWord = '';
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      codeWithoutCommentsOrStrings += '\n';
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      codeWithoutCommentsOrStrings += ch;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') {
          codeWithoutCommentsOrStrings += '\n';
          line++;
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const q = ch;
      codeWithoutCommentsOrStrings += q;
      i++;
      while (i < n && source[i] !== q) {
        if (source[i] === '\\') {
          if (source[i + 1] === '\n') {
            codeWithoutCommentsOrStrings += '\n';
            line++;
          }
          i += 2;
        } else {
          if (source[i] === '\n') {
            codeWithoutCommentsOrStrings += '\n';
            line++;
          }
          i++;
        }
      }
      if (i < n) i++;
      codeWithoutCommentsOrStrings += q;
      prevSig = q;
      prevWord = '';
      continue;
    }
    if (
      ch === '/' &&
      (!prevSig || '=(,[!&|?:;{}~^+-*%<>!'.includes(prevSig) || REGEX_PREV_KEYWORDS.has(prevWord))
    ) {
      const startLine = line;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n' && source[j] !== '\r') {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed && j > i + 1) {
        const body = source.slice(i + 1, j);
        regexLiterals.push({ line: startLine, body });
        codeWithoutCommentsOrStrings += '//';
        i = j + 1;
        while (i < n && /[gimsuvy]/.test(source[i])) i++;
        prevSig = '/';
        prevWord = '';
        continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let k = i;
      while (k < n && /[A-Za-z0-9_$]/.test(source[k])) k++;
      prevWord = source.slice(i, k);
      codeWithoutCommentsOrStrings += prevWord;
      prevSig = source[k - 1];
      i = k;
      continue;
    }
    codeWithoutCommentsOrStrings += ch;
    prevSig = ch;
    prevWord = '';
    i++;
  }
  return { codeWithoutCommentsOrStrings, regexLiterals };
}

function scanDuplicateUtils(srcDir) {
  const files = walkFiles(srcDir, (_, name) => name.endsWith('.mjs'));
  const pairs = [];
  for (const file of files) {
    const rel = toPosixRel(srcDir, file);
    if (rel.startsWith('utils/')) continue;
    const { codeWithoutCommentsOrStrings } = scanJsLexical(readFileSync(file, 'utf8'));
    for (const match of codeWithoutCommentsOrStrings.matchAll(DUPLICATE_UTIL_DECL_RE)) {
      const symbol = match[1];
      if (rel === 'contracts.mjs' && symbol === 'assertNonemptyString') continue;
      pairs.push(`${rel}:${symbol}`);
    }
  }
  return pairs.sort();
}

function assertDuplicateUtilsRatchet(srcDir, allowlist = DUPLICATE_UTIL_ALLOWLIST) {
  const found = scanDuplicateUtils(srcDir);
  const foundSet = new Set(found);
  const unexpected = found.filter(pair => !allowlist.has(pair));
  const stale = [...allowlist].filter(pair => !foundSet.has(pair)).sort();

  assert.deepEqual(
    unexpected,
    [],
    `Unexpected duplicate utility declaration(s) outside src/utils/ (import shared helpers instead): ${unexpected.join(', ')}`,
  );
  assert.deepEqual(
    stale,
    [],
    `Stale entry(ies) in DUPLICATE_UTIL_ALLOWLIST (remove consolidated entries to ratchet debt down): ${stale.join(', ')}`,
  );
  return found;
}

function scanDuplicateEmailRegexes(srcDir) {
  const files = walkFiles(srcDir, (_, name) => name.endsWith('.mjs'));
  const counts = {};
  const hits = [];
  for (const file of files) {
    const rel = toPosixRel(srcDir, file);
    if (rel === 'contracts.mjs') continue;
    const { regexLiterals } = scanJsLexical(readFileSync(file, 'utf8'));
    for (const r of regexLiterals) {
      if (EMAIL_REGEX_BODY_RE.test(r.body)) {
        counts[rel] = (counts[rel] ?? 0) + 1;
        hits.push({ file: rel, line: r.line, body: r.body });
      }
    }
  }
  return { counts, hits };
}

function assertDuplicateEmailRegexesRatchet(srcDir, allowlist = DUPLICATE_EMAIL_REGEX_ALLOWLIST) {
  const { counts, hits } = scanDuplicateEmailRegexes(srcDir);
  const violations = [];
  for (const [file, actualCount] of Object.entries(counts)) {
    const allowed = allowlist[file] ?? 0;
    if (actualCount > allowed) {
      violations.push(`${file}: ${actualCount} > allowed ${allowed}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Unexpected duplicate email regex(es) outside src/contracts.mjs (use canonical redaction helper): ${violations.join('; ')}`,
  );
  return { counts, hits };
}

test('hygiene rule 5 (live): duplicate utility definitions (22) and email regexes (7) stay within exact allowlists without false-positiving on SAFE_API_BASE_URL_RE or NEAR_30_DAYS', () => {
  const utilsFound = assertDuplicateUtilsRatchet(join(REPO_ROOT, 'src'));
  assert.equal(utilsFound.length, 22);

  const emailRes = assertDuplicateEmailRegexesRatchet(join(REPO_ROOT, 'src'));
  assert.equal(emailRes.hits.length, 7);
  assert.equal(emailRes.counts['budget-ledger.mjs'] ?? 0, 0);
  assert.equal(emailRes.counts['scoring.mjs'] ?? 0, 0);
});

test('hygiene rule 5 (negative & boundary): catches new duplicate utils and email regexes while ignoring canonical homes, comments, SAFE_API_BASE_URL_RE, and NEAR_30_DAYS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r5-'));
  try {
    mkdirSync(join(dir, 'utils'), { recursive: true });
    writeFileSync(
      join(dir, 'utils', 'objects.mjs'),
      'export function isPlainObject(v) { return Boolean(v); }\nexport function deepFreeze(v) { return v; }\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'contracts.mjs'),
      'export function assertNonemptyString(v) { return v; }\nexport const EMAIL_RE = /\\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}\\b/gi;\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'clean.mjs'),
      [
        '// function isPlainObject() {}',
        'const SAFE_API_BASE_URL_RE = /^https?:\\/\\/[A-Za-z0-9._:\\-[\\]]{1,255}(?:\\/[A-Za-z0-9._~:@!$&\'()*+,;=-]+)*$/i;',
        'const NEAR_30 = /^NEAR_30_DAYS(?:@\\d{4}-\\d{2}-\\d{2})?$/i;',
        'const str = "function assertPlainObject() {} foo@bar.com";',
        'export function ok(a, b) { return a / b; }',
      ].join('\n'),
      'utf8',
    );

    assert.equal(assertDuplicateUtilsRatchet(dir, new Set()).length, 0);
    assert.equal(assertDuplicateEmailRegexesRatchet(dir, {}).hits.length, 0);

    // Negative 1: duplicate utility outside src/utils/ and contracts.mjs
    const badUtil = join(dir, 'bad-util.mjs');
    writeFileSync(badUtil, 'function isPlainObject(x) { return !!x; }\n', 'utf8');
    assert.throws(
      () => assertDuplicateUtilsRatchet(dir, new Set()),
      /Unexpected duplicate utility declaration.*bad-util\.mjs:isPlainObject/,
    );
    rmSync(badUtil);

    const badStr = join(dir, 'bad-str.mjs');
    writeFileSync(badStr, 'const assertNonemptyString = v => v;\n', 'utf8');
    assert.throws(
      () => assertDuplicateUtilsRatchet(dir, new Set()),
      /Unexpected duplicate utility declaration.*bad-str\.mjs:assertNonemptyString/,
    );
    rmSync(badStr);

    // Negative 2: stale allowlist entry
    assert.throws(
      () => assertDuplicateUtilsRatchet(dir, new Set(['missing.mjs:isPlainObject'])),
      /Stale entry\(ies\) in DUPLICATE_UTIL_ALLOWLIST/,
    );

    // Negative 3: duplicate email regex (including return /.../ form)
    const badEmail = join(dir, 'bad-email.mjs');
    writeFileSync(badEmail, 'export function hasEmail(s) { return /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/.test(s); }\n', 'utf8');
    assert.throws(
      () => assertDuplicateEmailRegexesRatchet(dir, {}),
      /Unexpected duplicate email regex.*bad-email\.mjs: 1 > allowed 0/,
    );
    rmSync(badEmail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Rule 6: R1 governance docs ratchet ---

const R1_BANNED_PATTERNS = [
  { label: '自由发挥', re: /自由发挥/ },
  { label: '3 rounds / 3轮', re: /\b3\s*rounds?\b|3\s*轮/i },
  { label: '<= 2 calls', re: /<=\s*2\s*calls/i },
];

function assertR1GovernanceDocs(repoRoot, files = R1_GOVERNANCE_FILES) {
  const failures = [];
  for (const rel of files) {
    const content = readFileSync(join(repoRoot, rel), 'utf8');
    for (const { label, re } of R1_BANNED_PATTERNS) {
      if (re.test(content)) {
        failures.push(`${rel}: contains banned R1 pattern (${label})`);
      }
    }
    if (!/(?:1-round|1\s+round|1\s*轮)/i.test(content)) {
      failures.push(`${rel}: missing strict 1-round GPT cap`);
    }
    if (!/strictly\s+ZERO\s+(?:post-review\s+)?code\s+edits/i.test(content)) {
      failures.push(`${rel}: missing strictly ZERO code edits gate`);
    }
    if (!/桶\s*A/.test(content) || !/桶\s*B/.test(content)) {
      failures.push(`${rel}: missing Chinese two-bucket approval summary (桶 A / 桶 B)`);
    }
    if (rel === 'docs/DEVELOPMENT.md' && !content.includes('目标 + 验收标准 + 两条边界')) {
      failures.push(`${rel}: missing SSOT prompt template "目标 + 验收标准 + 两条边界"`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `R1 governance doc invariant failure(s):\n${failures.map(f => `  - ${f}`).join('\n')}`,
  );
  return files.length;
}

test('hygiene rule 6 (live): 5 governance/template files enforce strict 1-round GPT cap + zero-edit owner two-bucket gate and ban nitpick/multi-round rules', () => {
  assert.equal(assertR1GovernanceDocs(REPO_ROOT), 5);
});

test('hygiene rule 6 (negative & boundary): detects banned 自由发挥 / 3 rounds / <= 2 calls or missing R1 two-bucket gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hygiene-r6-'));
  try {
    const docPath = join(dir, 'GOV.md');
    const validText = [
      'Strict 1-round cap on ALL GPT reviews.',
      'Strictly ZERO code edits after ANY GPT review until owner approves.',
      'Present 桶 A: 真问题·建议修 / 桶 B: 过度防御·建议驳回 in plain Chinese.',
    ].join('\n');
    writeFileSync(docPath, validText, 'utf8');
    assert.equal(assertR1GovernanceDocs(dir, ['GOV.md']), 1);

    for (const badLine of ['Add + 自由发挥', 'Max 3 rounds allowed', 'Capped at <= 2 calls']) {
      writeFileSync(docPath, `${validText}\n${badLine}\n`, 'utf8');
      assert.throws(
        () => assertR1GovernanceDocs(dir, ['GOV.md']),
        /R1 governance doc invariant failure/,
      );
    }

    writeFileSync(docPath, 'Strict 1-round cap only.\n', 'utf8');
    assert.throws(
      () => assertR1GovernanceDocs(dir, ['GOV.md']),
      /missing strictly ZERO code edits gate/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
