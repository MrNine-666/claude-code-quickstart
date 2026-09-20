import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execCommand} from '../src/core/exec.ts';

// Phase 2 核心纯函数回归门禁。P5e 跨载体去重后，本脚本只保留**真实子进程**段
// （超时主动收敛 / AbortSignal 响应），纯函数段全部由 bun:test 载体独占。
//
// [P5d 迁走] 未被 P0–P4 既有载体覆盖的纯段（14 条）→ tests/core/core-functions.test.ts：
//   semver v 前缀 / prerelease、maskApiKey('') / testProviderKey、skills find 真实块状与 ANSI 输出。
// [P5e 去重] semver 主矩阵 / text-utils / provider 表单 / buildMcpConfig parity / skills find JSON+表格
//   已由既有载体独占（tools-lifecycle / text-utils / provider-form / mcp-parity / skills-view 测试），
//   verify 侧副本已删除。删除前逐条回读载体，发现 12 条「声称已覆盖、实际未覆盖」的缺口
//   （semver 等值 1、provider 表单 5、buildMcpConfig http/none 3 + 两条错误文案、skills installCount 1），
//   已按「先迁后删」补入对应载体（逐条证据见 research-reconciliation-P5e.md §2）。

// ── 外部命令超时必须主动收敛 ───────────────────────────────────────────────
// 子进程忽略 SIGTERM 并继续持有 stdio；Windows shell:true 下这也模拟 npx 子进程树
// 未随 shell 退出的情况。Promise 必须在 timeout 到达时拒绝，不能等待 close 事件。
const timeoutStartedAt = Date.now();
await assert.rejects(
	execCommand(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},900)"], {timeout: 25}),
	/命令超时 \(25ms\)/
);
assert.ok(Date.now() - timeoutStartedAt < 500, '命令超时应立即拒绝，不等待子进程 close');
const execSource = readFileSync(new URL('../src/core/exec.ts', import.meta.url), 'utf8');
const timeoutHandlerIndex = execSource.indexOf('timer = setTimeout(() => {');
const timeoutRejectIndex = execSource.indexOf('settleReject(new Error(`命令超时', timeoutHandlerIndex);
const closeHandlerIndex = execSource.indexOf("proc.on('close'", timeoutHandlerIndex);
assert.ok(
	timeoutHandlerIndex >= 0 && timeoutRejectIndex > timeoutHandlerIndex && timeoutRejectIndex < closeHandlerIndex,
	'超时回调必须直接拒绝 Promise，不能依赖后续 close 事件'
);
console.log('[PASS] 外部命令超时主动收敛');

// 父组件传入 AbortSignal 后，exec 只负责终止子进程树并快速拒绝；业务状态由调用方收敛。
const preAbortedController = new AbortController();
preAbortedController.abort();
await assert.rejects(
	execCommand(process.execPath, ['-e', 'throw new Error("must not spawn")'], {signal: preAbortedController.signal}),
	error => error instanceof Error && error.name === 'AbortError',
	'已取消 signal 不应启动外部命令'
);
const abortController = new AbortController();
const abortStartedAt = Date.now();
const abortedCommand = execCommand(process.execPath, ['-e', 'setTimeout(()=>{},900)'], {timeout: 5000, signal: abortController.signal});
setTimeout(() => abortController.abort(), 25);
await assert.rejects(
	abortedCommand,
	error => error instanceof Error && error.name === 'AbortError' && /操作已取消/.test(error.message),
	'AbortSignal 应以 AbortError 拒绝外部命令'
);
assert.ok(Date.now() - abortStartedAt < 500, '取消应立即收敛 Promise，不等待子进程 close');
console.log('[PASS] 外部命令响应父级 AbortSignal');

console.log('[PASS] Phase 2 核心纯函数回归门禁通过（纯函数段见 tests/core/core-functions.test.ts 等载体）');
