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

function scanBrokenRelativeMdLinks(docsDir) {
  const mdFiles = walkFiles(docsDir, (_, name) => name.endsWith('.md'));
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
          from: toPosixRel(docsDir, mdFile),
          target: rawTarget,
        });
      }
    }
  }
  return { mdFilesCount: mdFiles.length, checkedCount, broken };
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
