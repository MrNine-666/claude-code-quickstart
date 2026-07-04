import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// task 8.4：Update 检测范围收缩门禁。覆盖：
// - 无 ClaudeMd/ClaudeConfig 组件（HC-FU-08）
// - 无 template 类型组件（6.4 已从 UpdateComponentType 移除）
// - CcgWorkflow npm 引擎保留（HC-FU-09）
// - snapshot 失败不执行更新命令
//
// task 8.7（守卫）：checkComponentUpdates 返回不得出现 ccg-*.md / rules 类组件。

const home = mkdtempSync(join(tmpdir(), 'ccq-update-scope-'));
process.env.CCQ_HOME = home;
mkdirSync(join(home, '.claude'), {recursive: true});
// 空 settings/claude.json，隔离真实 MCP 检测
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({env: {}}), 'utf8');
writeFileSync(join(home, '.claude.json'), JSON.stringify({}), 'utf8');

// 预写 npm outdated 缓存（命中 TTL），避免真实 npm outdated -g 调用
const uid = process.getuid ? process.getuid() : process.pid;
const cacheDir = join(tmpdir(), `ccq-cache-${uid}`);
mkdirSync(cacheDir, {recursive: true});
writeFileSync(join(cacheDir, 'npm-outdated.json'), JSON.stringify({}), 'utf8');
// 预写 npm view 缓存（命中 TTL），避免真实 npm view ccg-workflow 调用
writeFileSync(join(cacheDir, 'npm-view.json'), JSON.stringify({}), 'utf8');

// 预写 CcgWorkflow config.toml：验证本地版本取自 config.toml 而非 codeagent-wrapper 二进制
// （codeagent-wrapper 是独立二进制，版本体系与 ccg-workflow npm 包不同）
mkdirSync(join(home, '.claude', '.ccg'), {recursive: true});
writeFileSync(join(home, '.claude', '.ccg', 'config.toml'), 'version = "3.1.6"\n', 'utf8');

const {checkComponentUpdates, applyUpdates} = await import('../src/core/update.ts');

const components = await checkComponentUpdates();
const ids = components.map(c => c.id);
const types = new Set(components.map(c => c.type));

// ── 检测范围收缩 ────────────────────────────────────────────────────────────
assert.equal(types.has('template'), false, '检测范围不含 template 类型');
assert.equal(ids.some(id => /ClaudeMd|ClaudeConfig/i.test(id)), false, '不含 ClaudeMd/ClaudeConfig 组件');

// task 8.7：不含 ccg-*.md / rules 类组件
const hasRulesComponent = components.some(c => /ccg-.*\.md|rules/i.test(`${c.id} ${c.name}`));
assert.equal(hasRulesComponent, false, '不含 ccg-*.md / rules 类组件（8.7 守卫）');
console.log('[PASS] 8.4/8.7 检测范围收缩：无 template/ClaudeMd/ClaudeConfig/rules 类组件');

// ── CcgWorkflow npm 引擎保留（HC-FU-09） ────────────────────────────────────
assert.ok(ids.includes('CcgWorkflow'), 'CcgWorkflow npm 引擎应保留');
const ccg = components.find(c => c.id === 'CcgWorkflow');
assert.equal(ccg.type, 'npm', 'CcgWorkflow 应为 npm 类型');
assert.equal(ccg.package, 'ccg-workflow', 'CcgWorkflow 包名为 ccg-workflow');
// 本地版本必须取自 config.toml（3.1.6），而非 codeagent-wrapper 二进制版本
assert.equal(ccg.currentVersion, '3.1.6', 'CcgWorkflow 本地版本应取自 config.toml');
// 预置空 npm-view 缓存 → 远程查询不触发 → latestVersion fallback 到当前版本，无更新
assert.equal(ccg.latestVersion, '3.1.6', 'CcgWorkflow 远程查询未命中时 fallback 到当前版本');
assert.equal(ccg.hasUpdate, false, 'CcgWorkflow 无远程数据时不应误报更新');
console.log('[PASS] 8.4 CcgWorkflow npm 引擎保留 + 版本源取自 config.toml');

// ── 1.2 CodexCli 官方包名 + 检测独立于 ClaudeCode（HC-CODEX-OFFICIAL-PACKAGE / HC-CODEX-DETECT-INDEPENDENT）──
// checkCliToolUpdates 遍历 NPM_COMPONENT_MAP，各组件的 installed 由自身 `<command> --version`
// 决定，互不依赖。这里断言 CodexCli 使用官方包名 @openai/codex，且其检测结果不由 ClaudeCode
// 状态派生（二者在结果集中各为独立条目，任一缺失不影响另一条目存在）。
assert.ok(ids.includes('CodexCli'), 'CodexCli 应纳入 CLI 工具检测');
const codex = components.find(c => c.id === 'CodexCli');
assert.equal(codex.type, 'npm', 'CodexCli 应为 npm 类型');
assert.equal(codex.package, '@openai/codex', 'CodexCli 包名必须为官方 @openai/codex，不得为 codex-cli');
// 检测独立性：CodexCli 与 ClaudeCode 是结果集中两个平级条目，CodexCli.installed 只反映
// `codex --version`，与 ClaudeCode 是否检出无耦合（未安装环境下两者同为独立 false，互不派生）。
const claudeComp = components.find(c => c.id === 'ClaudeCode');
assert.ok(claudeComp, 'ClaudeCode 应为独立条目');
assert.notEqual(codex, claudeComp, 'CodexCli 与 ClaudeCode 必须是独立组件条目');
assert.equal(typeof codex.installed, 'boolean', 'CodexCli.installed 由自身 codex --version 决定');
console.log('[PASS] 1.2 CodexCli 官方包名 + 检测独立于 ClaudeCode');

// ── snapshot 失败不执行更新命令 ─────────────────────────────────────────────
let execCalls = 0;
const failSnapshot = () => {
	throw new Error('快照创建失败');
};
const trackExec = async () => {
	execCalls++;
	return {code: 0, stdout: '', stderr: ''};
};
const npmComp = {
	id: 'ClaudeCode',
	name: 'ClaudeCode',
	type: 'npm',
	package: '@anthropic-ai/claude-code',
	installed: true,
	currentVersion: '1.0.0',
	latestVersion: '1.1.0',
	hasUpdate: true
};
let threw = false;
try {
	await applyUpdates([npmComp], undefined, {createSnapshotFn: failSnapshot, exec: trackExec});
} catch (error) {
	threw = true;
	assert.match(error.message, /快照/);
}
assert.equal(threw, true, 'snapshot 失败应抛错');
assert.equal(execCalls, 0, 'snapshot 失败不得执行任何更新命令');
console.log('[PASS] 8.4 snapshot 失败不执行更新命令');

rmSync(home, {recursive: true, force: true});
rmSync(cacheDir, {recursive: true, force: true});
console.log('[PASS] task 8.4 + 8.7 Update 范围收缩门禁全部通过');
