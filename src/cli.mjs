import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { scoreBatch } from './scoring.mjs';
import { renderReport } from './report.mjs';

const USAGE = '用法：node src/cli.mjs --input <batch.json> --profile <profile.json> --output <directory>\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const milliseconds = value => Math.round(value * 1000) / 1000;
const ioCode = error => typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'IO_ERROR';
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

class CliError extends Error {}

async function readJson(path, label) {
  let bytes;
  try { bytes = await readFile(path); }
  catch (error) { throw new CliError(`${label}无法读取（${ioCode(error)}）。`); }
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CliError(`${label}不是有效UTF-8文件。`); }
  try { return { value: JSON.parse(content), bytes }; }
  catch { throw new CliError(`${label}不是有效JSON；请修正后重新运行。`); }
}

async function writeOutputs(output, resultBytes, htmlBytes, baseReceipt, start, stages) {
  const runId = baseReceipt.run_id;
  const pending = new Set();
  const published = [];
  const files = { 'result.json': resultBytes, 'index.html': htmlBytes };
  const expected = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: sha256(bytes), bytes: bytes.length }]));
  const stage = async (name, bytes) => {
    const temporary = join(output, `.${name}.${runId}.tmp`);
    const handle = await open(temporary, 'wx');
    pending.add(temporary);
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    return temporary;
  };
  const commit = async (temporary, name) => {
    await rename(temporary, join(output, name));
    pending.delete(temporary);
  };
  const receipt = async value => {
    const temporary = await stage('receipt.json', Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
    await commit(temporary, 'receipt.json');
  };
  const cleanup = async () => {
    for (const temporary of [...pending]) {
      try { await unlink(temporary); pending.delete(temporary); }
      catch (error) { if (error.code === 'ENOENT') pending.delete(temporary); }
    }
  };
  const writeStart = performance.now();
  try {
    const staged = [];
    for (const [name, bytes] of Object.entries(files)) staged.push([name, await stage(name, bytes)]);
    // Invalidate an older success receipt before publishing any replacement file.
    await receipt({ ...baseReceipt, status: 'writing', expected_outputs: expected });
    for (const [name, temporary] of staged) {
      await commit(temporary, name);
      published.push(name);
    }
    const outputs = {};
    for (const name of Object.keys(files)) {
      const actual = await readFile(join(output, name));
      outputs[name] = { sha256: sha256(actual), bytes: actual.length };
      if (outputs[name].sha256 !== expected[name].sha256) throw new Error('Output readback does not match staged bytes.');
    }
    stages.write_outputs = milliseconds(performance.now() - writeStart);
    const completed = { ...baseReceipt, status: 'complete', completed_primary_outputs_at: new Date().toISOString(),
      elapsed_ms: milliseconds(performance.now() - start), measured_through: 'primary_output_readback_before_final_receipt',
      stages_ms: stages, outputs };
    await receipt(completed);
    return completed;
  } catch (error) {
    await cleanup();
    let failedReceiptWritten = false;
    try {
      await receipt({ ...baseReceipt, status: 'failed', failed_at: new Date().toISOString(), error_code: ioCode(error),
        published_outputs: published, expected_outputs: expected, temporary_files_remaining: [...pending].map(path => basename(path)) });
      failedReceiptWritten = true;
    } catch { await cleanup(); }
    throw new CliError(`输出未完整写入（${ioCode(error)}）。已发布：${published.join('、') || '无'}；${failedReceiptWritten ? 'receipt.json已记录失败状态' : '失败收据未能写入，请核对输出目录'}${pending.size ? `；仍有${pending.size}个本次临时文件需核对` : ''}。`);
  }
}

export async function runCli(args = process.argv.slice(2), streams = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    let values;
    try {
      ({ values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
        input: { type: 'string' }, profile: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
      } }));
    } catch { throw new CliError(`参数无效。${USAGE.trim()}`); }
    if (values.help) { streams.stdout.write(USAGE); return 0; }
    if (![values.input, values.profile, values.output].every(value => typeof value === 'string' && value.trim())) {
      throw new CliError(`必须提供输入、评分配置和输出目录。${USAGE.trim()}`);
    }
    const start = performance.now();
    const startedAt = new Date().toISOString();
    const stages = {};
    const batchPath = resolve(values.input);
    const profilePath = resolve(values.profile);
    const inputStart = performance.now();
    const batch = await readJson(batchPath, '输入文件');
    const profile = await readJson(profilePath, '评分配置');
    stages.read_inputs = milliseconds(performance.now() - inputStart);
    const scoreStart = performance.now();
    const result = scoreBatch(batch.value, profile.value);
    stages.score = milliseconds(performance.now() - scoreStart);
    const renderStart = performance.now();
    const htmlBytes = Buffer.from(renderReport(result, batch.value), 'utf8');
    const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8');
    stages.render = milliseconds(performance.now() - renderStart);
    const output = resolve(values.output);
    try { await mkdir(output, { recursive: true }); }
    catch (error) { throw new CliError(`无法创建输出目录（${ioCode(error)}）。`); }
    const canonicalOutput = await realpath(output);
    const protectedPaths = new Set((await Promise.all([realpath(batchPath), realpath(profilePath)])).map(pathKey));
    if (['result.json', 'index.html', 'receipt.json'].some(name => protectedPaths.has(pathKey(join(canonicalOutput, name))))) {
      throw new CliError('输出文件会覆盖输入或评分配置；请选择另一个输出目录。');
    }
    const baseReceipt = {
      schema_version: 1, kind: 'offline_trial_execution', run_id: randomUUID(), started_at: startedAt,
      node_version: process.version, profile_revision: profile.value.revision,
      inputs: { batch: { name: basename(batchPath), sha256: sha256(batch.bytes), bytes: batch.bytes.length },
        profile: { name: basename(profilePath), sha256: sha256(profile.bytes), bytes: profile.bytes.length } },
      summary: result.summary, provider_requests: 0, model_requests: 0, network_requests: 0,
    };
    await writeOutputs(canonicalOutput, resultBytes, htmlBytes, baseReceipt, start, stages);
    streams.stdout.write(`已生成离线试评：${result.summary.candidates}个候选，完整可比${result.summary.complete}个，待补证${result.summary.pending}个。\n结果目录：${output}\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof CliError || error instanceof TypeError ? error.message : `本地处理失败（${ioCode(error)}）。`;
    streams.stderr.write(`离线试评失败：${reason}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli();
