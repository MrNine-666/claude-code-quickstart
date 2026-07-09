import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const updateSource = readFileSync(new URL('../src/core/update.ts', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../src/index.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const cliUpdateSource = readFileSync(new URL('../src/cli/commands/update.ts', import.meta.url), 'utf8');

// ── 后台静默更新链路移除 ─────────────────────────────────────────────────────
assert.equal(/startBackgroundUpdateCheck/.test(indexSource), false, '入口不得启动后台静默检查/下载');
assert.equal(/startBackgroundUpdateCheck/.test(updateSource), false, 'core 不再暴露后台静默检查/下载函数');
assert.equal(/applyPendingUpdateOnStartup/.test(indexSource), false, '入口不得依赖启动时自覆盖 pending 更新');
assert.equal(/applyPendingUpdateOnStartup/.test(updateSource), false, 'Windows 更新不得再由运行中的 ccq 自覆盖自身');
console.log('[PASS] ccq 自更新：后台静默检查与启动时自覆盖链路已移除');

// ── 结构化错误结果 ───────────────────────────────────────────────────────────
assert.match(updateSource, /export type SelfUpdateError/, 'core 应暴露自更新结构化错误类型');
assert.match(updateSource, /export type CheckLatestVersionResult/, 'checkLatestVersion 应返回结构化结果');
assert.match(updateSource, /export type DownloadUpdateResult/, 'downloadUpdate 应返回结构化结果');
assert.match(updateSource, /export type ApplySelfUpdateResult/, 'applyUpdate 应返回结构化结果');
assert.match(updateSource, /export function formatSelfUpdateError/, 'core 应提供统一错误格式化函数');
assert.match(updateSource, /checkLatestVersion\(\): Promise<CheckLatestVersionResult>/, 'checkLatestVersion 不得再返回 null 表示所有错误');
assert.match(updateSource, /downloadUpdate\([^)]*\): Promise<DownloadUpdateResult>/, 'downloadUpdate 不得再返回 boolean 丢失失败原因');
assert.match(updateSource, /applyUpdate\([^)]*\): Promise<ApplySelfUpdateResult>/, 'applyUpdate 不得再返回 boolean 丢失失败原因');
console.log('[PASS] ccq 自更新：检查/下载/应用均使用结构化错误结果');

// ── Windows helper 替换 ──────────────────────────────────────────────────────
assert.match(updateSource, /function startWindowsUpdateHelper/, 'Windows 应使用 helper 进程在当前进程退出后替换 exe');
assert.match(updateSource, /Wait-Process -Id \$ParentPid/, 'Windows helper 应等待当前 ccq 进程退出');
assert.match(updateSource, /Copy-Item -LiteralPath \$TempPath -Destination \$TargetPath -Force/, 'Windows helper 应复制临时文件覆盖目标 exe');
assert.match(updateSource, /Start-Process -FilePath \$TargetPath/, 'Windows helper 应在替换后重启 ccq');
console.log('[PASS] ccq 自更新：Windows helper 替换流程已锁定');

// ── TUI/CLI 行为边界 ────────────────────────────────────────────────────────
assert.match(appSource, /const runUpdateCheck = async \(\): Promise<void> => \{[\s\S]*checkLatestVersion\(\)[\s\S]*\};/, 'TUI 启动检查应只调用 checkLatestVersion 更新状态');
const runUpdateCheckBlock = appSource.match(/const runUpdateCheck = async \(\): Promise<void> => \{[\s\S]*?\r?\n\t\t\};/)?.[0] ?? '';
assert.equal(/downloadUpdate\(/.test(runUpdateCheckBlock), false, 'TUI 启动检查不得下载更新文件');
assert.match(appSource, /downloadUpdate\(downloadUrl, abortController\.signal\)/, 'TUI 仅在用户确认更新后下载');
assert.match(appSource, /formatSelfUpdateError/, 'TUI 下载/应用失败应展示具体错误原因');
assert.match(cliUpdateSource, /formatSelfUpdateError/, 'CLI update 失败应输出具体错误原因');
console.log('[PASS] ccq 自更新：TUI/CLI 确认式下载与错误展示边界已锁定');

console.log('[PASS] ccq 自更新门禁全部通过');
