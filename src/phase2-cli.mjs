/**
 * Phase 2 operational CLI for the local SQLite store (Core 5 business objects),
 * historical ledger/lock import, frozen replay verification, queue resume, and lineage trace.
 * Read-only inspection commands (status, trace) open SQLite strictly read-only without mutating
 * active in-flight requests. Leaves legacy src/cli.mjs completely untouched.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openSelectionStore } from './store.mjs';
import {
  importRecoveryLockFile,
  importRequestLedgerFile,
  importRetainedAssetsManifest,
  replayBatchIntoStore,
} from './history-import.mjs';

const USAGE = [
  '用法：node src/phase2-cli.mjs <command> [options]',
  '命令：',
  '  init            --db <sqlite-path> [--reconcile-crashed]',
  '  import-history  --db <sqlite-path> [--recovery <file>...] [--ledger <file>...] [--assets <manifest.json>]',
  '  replay          --db <sqlite-path> --batch <batch.json> --profile <profile.json> [--profile-revision <n>] [--discovery <bundle.json>] [--verify-result <sha256>] [--verify-html <sha256>]',
  '  status          --db <sqlite-path>  (只读，不干扰在途请求)',
  '  resume-1688     --db <sqlite-path> --login-verified --city <city> --quantity <n> --sku <sku> --validity <YYYY-MM-DD> [--form <paused-form-id>] [--as-of <YYYY-MM-DD>]',
  '  trace           --db <sqlite-path> --form <form-id>  (只读，不干扰在途请求)',
  '',
].join('\n');

class Phase2CliError extends Error {}

function requireOption(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Phase2CliError(`缺少必填参数 --${label}。`);
  }
  return value.trim();
}

export async function runPhase2Cli(args = process.argv.slice(2), streams = { stdout: process.stdout, stderr: process.stderr }) {
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
        },
      });
    } catch {
      throw new Phase2CliError(`参数无效。\n${USAGE.trim()}`);
    }

    const { values } = parsed;
    const rawDb = requireOption(values.db, 'db');
    const dbPath = rawDb === ':memory:' ? ':memory:' : resolve(rawDb);
    const isReadOnlyCmd = command === 'status' || command === 'trace';
    // Read-only commands NEVER mutate SQLite or trigger crash reconciliation on active requests.
    const reconcileOnOpen = command === 'init' && values['reconcile-crashed'] === true;

    const store = openSelectionStore(dbPath, {
      readOnly: isReadOnlyCmd && dbPath !== ':memory:',
      reconcileOnOpen,
    });
    try {
      if (command === 'init') {
        streams.stdout.write(`${JSON.stringify({ ok: true, command, summary: store.getSummary() }, null, 2)}\n`);
        return 0;
      }

      if (command === 'status') {
        streams.stdout.write(`${JSON.stringify({ ok: true, command, summary: store.getSummary() }, null, 2)}\n`);
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
          const manifest = JSON.parse(readFileSync(resolve(values.assets), 'utf8'));
          imported.assets = importRetainedAssetsManifest(store, manifest);
        }
        streams.stdout.write(`${JSON.stringify({ ok: true, command, imported, summary: store.getSummary() }, null, 2)}\n`);
        return 0;
      }

      if (command === 'replay') {
        const batchPath = resolve(requireOption(values.batch, 'batch'));
        const profilePath = resolve(requireOption(values.profile, 'profile'));
        const batch = JSON.parse(readFileSync(batchPath, 'utf8'));
        const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
        if (values['profile-revision']) {
          const rev = Number(values['profile-revision']);
          if (!Number.isInteger(rev) || rev < 50) throw new Phase2CliError('--profile-revision 必须为 >= 50 的整数。');
          profile.revision = rev;
          if (profile.workflow?.scoring_and_ordering) profile.workflow.scoring_and_ordering.revision = rev;
        }
        const discovery = values.discovery ? JSON.parse(readFileSync(resolve(values.discovery), 'utf8')) : null;
        const out = replayBatchIntoStore(store, {
          batch,
          profile,
          discovery,
          expected_result_sha256: values['verify-result'] ?? null,
          expected_html_sha256: values['verify-html'] ?? null,
        });
        streams.stdout.write(`${JSON.stringify({
          ok: true,
          command,
          result_sha256: out.result_sha256,
          html_sha256: out.html_sha256,
          evaluations_recorded: out.evaluations_recorded,
          summary: out.summary,
        }, null, 2)}\n`);
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

      throw new Phase2CliError(`未知命令：${command}\n${USAGE.trim()}`);
    } finally {
      store.close();
    }
  } catch (error) {
    const message = error instanceof Phase2CliError || error instanceof TypeError || error instanceof Error
      ? error.message
      : '执行失败。';
    streams.stderr.write(`Phase 2 CLI 失败：${message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPhase2Cli();
}
