#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { doctor } from './doctor.js';
import { coverage, validateSnapshot } from './snapshot.js';
import { diffSnapshots, unifiedTextDiff } from './diff.js';
import { appendEvent, batchStatus, prepareBatch, renderBatchReport, validateBatch, type BatchEvent } from './batch.js';
import { readJson, updateJson, writeNewJson } from './io.js';
import { captureSnapshot } from './capture.js';
import { BridgeClient } from './bridge-client.js';

const HELP = `CODESYS AI 工程助手 v0.1（SP20实验适配器 / SP22官方MCP工作流）

doctor [--ide-root DIR] [--bridge EXE] [--out FILE]
bridge status --config BOOTSTRAP
snapshot capture --config BOOTSTRAP [--application PATH] --out SNAPSHOT
snapshot validate --input SNAPSHOT [--out NORMALIZED]
diff --before SNAPSHOT --after SNAPSHOT [--out FILE]
diff --batch BATCH [--out FILE]
batch prepare --snapshot SNAPSHOT --changes CHANGES --out BATCH
batch record --batch BATCH --event EVENT
batch verify --batch BATCH [--phase readback|compile|reopened --evidence JSON]
report --snapshot SNAPSHOT [--out FILE]
report --batch BATCH [--out FILE]

批次事件 approve/start/result/readback/compile/reopened 的格式见 docs/data-format.md。
所有新输出文件默认拒绝覆盖；batch record 用本地锁更新执行日志。
退出码：0=成功；1=输入或流程错误；2=doctor前置缺失/快照覆盖不全/批次待完成。
fixture 是离线演示，永远不能算作真实 CODESYS 验收。
`;

function parse(args: string[]): { command: string[]; options: Record<string, string> } {
  const command: string[] = [], options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key in options) throw new Error(`重复参数: --${key}`);
      if (['help', 'version'].includes(key)) options[key] = 'true';
      else {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error(`--${key} 缺少值`);
        options[key] = value;
      }
    } else command.push(arg);
  }
  return { command, options };
}

async function main(): Promise<void> {
  const { command, options: o } = parse(process.argv.slice(2));
  if (o.version) { console.log('0.1.0'); return; }
  if (o.help || command.length === 0) { process.stdout.write(HELP); return; }
  const required = (key: string) => { if (!o[key]) throw new Error(`缺少 --${key}`); return o[key]; };
  const accept = (...keys: string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`未知参数: --${k}`);
  };
  const output = async (value: unknown, markdown = false) => {
    const content = markdown ? String(value) : JSON.stringify(value, null, 2) + '\n';
    if (o.out) {
      await mkdir(dirname(resolve(o.out)), { recursive: true });
      await writeFile(o.out, content, { encoding: 'utf8', flag: 'wx' });
      console.log(`已写入: ${resolve(o.out)}`);
    } else process.stdout.write(content);
  };
  const route = command.join(' ');
  if (route === 'doctor') {
    accept('ide-root', 'bridge', 'out');
    const result = await doctor({ ideRoot: o['ide-root'], bridge: o.bridge });
    await output(result);
    if (!result.ready) process.exitCode = 2;
  } else if (route === 'bridge status') {
    accept('config', 'out');
    const client = await BridgeClient.load(required('config'));
    const response = await client.call('ping');
    await output({ready: response.ok && response.result?.pong === true, adapter: 'experimental-sp20-scriptengine', officialMcp: false, pid: client.ready.pid, projectIdentity: client.ready.projectIdentity});
    if (!response.ok) process.exitCode = 2;
  } else if (route === 'snapshot capture') {
    accept('config', 'application', 'out');
    const out = required('out');
    const snapshot = await captureSnapshot(required('config'), o.application);
    await writeNewJson(out, snapshot);
    console.log(JSON.stringify({path: resolve(out), ...coverage(snapshot)}, null, 2));
  } else if (route === 'snapshot validate') {
    accept('input', 'out');
    const snapshot = validateSnapshot(await readJson(required('input')));
    if (o.out) await writeNewJson(o.out, snapshot);
    const result = coverage(snapshot);
    console.log(JSON.stringify(result, null, 2));
    if (!result.fullyCovered) process.exitCode = 2;
  } else if (route === 'diff') {
    accept('before', 'after', 'batch', 'out');
    if (o.batch) {
      if (o.before || o.after) throw new Error('--batch 与 --before/--after 互斥');
      const batch = validateBatch(await readJson(o.batch));
      const patch = batch.plan.operations.map(op => unifiedTextDiff(op.before ?? undefined, op.text, op.path)).join('\n');
      await output(`# 批次 ${batch.plan.id}\n# 计划哈希 ${batch.plan.planHash}\n${patch}`, true);
    } else {
      const diff = diffSnapshots(validateSnapshot(await readJson(required('before'))), validateSnapshot(await readJson(required('after'))));
      await output(diff);
    }
  } else if (route === 'batch prepare') {
    accept('snapshot', 'changes', 'out');
    const batch = prepareBatch(await readJson(required('snapshot')), await readJson(required('changes')));
    await writeNewJson(required('out'), batch);
    console.log(JSON.stringify({ path: resolve(o.out), plan: batch.plan, status: batchStatus(batch) }, null, 2));
  } else if (route === 'batch record') {
    accept('batch', 'event');
    const event = await readJson(required('event')) as BatchEvent;
    const batch = await updateJson(required('batch'), value => appendEvent(value, event));
    console.log(JSON.stringify(batchStatus(batch), null, 2));
  } else if (route === 'batch verify') {
    accept('batch', 'phase', 'evidence');
    const path = required('batch');
    let batch;
    if (o.phase) {
      if (!['readback', 'compile', 'reopened'].includes(o.phase)) throw new Error('phase 必须是 readback / compile / reopened');
      const event = await readJson(required('evidence')) as BatchEvent;
      if (event?.type !== o.phase) throw new Error('phase 与事件类型不一致');
      batch = await updateJson(path, value => appendEvent(value, event));
    } else {
      if (o.evidence) throw new Error('--evidence 需要 --phase');
      batch = validateBatch(await readJson(path));
    }
    const status = batchStatus(batch);
    console.log(JSON.stringify({ origin: batch.plan.origin, ...status }, null, 2));
    if (status.persistence !== 'verified' || batch.plan.origin === 'fixture') process.exitCode = 2;
  } else if (route === 'report') {
    accept('snapshot', 'batch', 'out');
    if (Boolean(o.snapshot) === Boolean(o.batch)) throw new Error('请选择 --snapshot 或 --batch');
    if (o.batch) await output(renderBatchReport(await readJson(o.batch)), true);
    else {
      const snapshot = validateSnapshot(await readJson(o.snapshot));
      const c = coverage(snapshot);
      const text = ['# CODESYS 工程读取覆盖报告', '', `来源：${snapshot.origin === 'fixture' ? '离线演示，非 IDE 验收' : 'IDE 工具采集'}`,
        `工程：${snapshot.identity.projectPath}`, `Application：${snapshot.identity.applicationPath}`, '',
        `已知对象：${c.inventoryCount}；完整读取：${c.readCompleteCount}；整体覆盖率：${c.percent === null ? '未知（工程树不完整）' : c.percent + '%'}`,
        `全部覆盖：${c.fullyCovered}`, '', '## 未覆盖及异常', '', ...c.issues.map(issue => `- ${typeof issue === 'string' ? issue : JSON.stringify(issue)}`), '',
        '## 参考资料', '', ...(snapshot.references ?? []).map(ref => `- ${ref.path}（${ref.role}，SHA256 ${ref.sha256}）`), '',
        '覆盖表示读取范围，不代表已证明逻辑正确。AI 分析应另附对象路径、源码证据、影响与验证场景。', ''].join('\n');
      await output(text, true);
    }
  } else throw new Error(`未知命令: ${route}\n使用 --help 查看帮助`);
}

main().catch(error => { console.error(`错误: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
