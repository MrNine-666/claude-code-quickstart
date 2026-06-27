import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 11B tools-manage core 门禁：工具管理单一真理源（design TDR-11）。
// 覆盖：
// - COMPONENT_DEFINITIONS 6 组件齐备（ClaudeCode + 5 工具）+ 顺序 + isBase 语义（11.4/11.6）
// - detectComponents 返回 6 项且不聚合 Skills/MCP（11.5/11.7）
// - CcgWorkflow 版本取自 config.toml（复用 update.ts 检测，单一真理源）
// - installComponent('ClaudeCode') 走 npm install + 检测确认（11.6/11.8，deps.exec 注入 mock）

const home = mkdtempSync(join(tmpdir(), 'ccq-tools-manage-'));
process.env.CCQ_HOME = home;
mkdirSync(join(home, '.claude'), {recursive: true});
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({env: {}}), 'utf8');
writeFileSync(join(home, '.claude.json'), JSON.stringify({}), 'utf8');

// 预置 npm outdated / view 缓存（命中 TTL），避免真实 npm 调用
const uid = process.getuid ? process.getuid() : process.pid;
const cacheDir = join(tmpdir(), `ccq-cache-${uid}`);
mkdirSync(cacheDir, {recursive: true});
writeFileSync(join(cacheDir, 'npm-outdated.json'), JSON.stringify({}), 'utf8');
writeFileSync(join(cacheDir, 'npm-view.json'), JSON.stringify({}), 'utf8');

// 预写 CcgWorkflow config.toml：验证本地版本取自 config.toml（而非 codeagent-wrapper 二进制）
mkdirSync(join(home, '.claude', '.ccg'), {recursive: true});
writeFileSync(join(home, '.claude', '.ccg', 'config.toml'), 'version = "3.1.6"\n', 'utf8');

const {COMPONENT_DEFINITIONS, detectComponents, installComponent} = await import('../src/core/tools-manage.ts');

// ── COMPONENT_DEFINITIONS 完整性（11.4/11.6）──────────────────────────────────
const ids = COMPONENT_DEFINITIONS.map(c => c.id);
assert.deepEqual(
	ids,
	['ClaudeCode', 'Ccline', 'CcgWorkflow', 'OpenSpec', 'CodexCli', 'AntigravityCli'],
	'6 组件齐备且顺序固定（ClaudeCode + 5 工具）'
);
for (const def of COMPONENT_DEFINITIONS) {
	assert.ok(def.name && def.description, `${def.id} 有 name + description`);
	assert.ok(def.command && def.versionArgs.length > 0, `${def.id} 有检测命令`);
	assert.ok(def.kind, `${def.id} 有 kind`);
	assert.equal(typeof def.isBase, 'boolean', `${def.id} isBase 为布尔`);
}
const claude = COMPONENT_DEFINITIONS.find(c => c.id === 'ClaudeCode');
assert.equal(claude.isBase, true, 'ClaudeCode isBase=true（基础组件，卸载附危险警告）');
assert.equal(claude.npmPackage, '@anthropic-ai/claude-code', 'ClaudeCode npm 包名');
assert.equal(claude.optional, false, 'ClaudeCode 非可选');
assert.equal(COMPONENT_DEFINITIONS.filter(c => c.isBase).length, 1, '仅 ClaudeCode 为 isBase');
console.log('[PASS] COMPONENT_DEFINITIONS 6 组件齐备 + isBase 语义 (11.4/11.6)');

// ── detectComponents 返回 6 项 + 不聚合 Skills/MCP（11.5/11.7）────────────────
const components = await detectComponents();
assert.equal(components.length, 6, 'detectComponents 返回 6 项（不聚合 Skills/MCP）');
const hasSkillsOrMcp = components.some(c => /^Skill:|^Mcp:/.test(c.id));
assert.equal(hasSkillsOrMcp, false, '不含 Skill:/Mcp: 前缀组件（11.7 不聚合 Skills/MCP）');

// CcgWorkflow 版本取自 config.toml（复用 update.ts 检测逻辑，单一真理源）
const ccg = components.find(c => c.id === 'CcgWorkflow');
assert.equal(ccg.installed, true, 'CcgWorkflow installed（config.toml 存在）');
assert.equal(ccg.currentVersion, '3.1.6', 'CcgWorkflow 本地版本取自 config.toml');
assert.equal(ccg.hasUpdate, false, 'CcgWorkflow 无远程数据时不误报更新');

// ClaudeCode 纳入受管检测（11.6）
assert.ok(components.some(c => c.id === 'ClaudeCode'), 'ClaudeCode 纳入受管检测（11.6）');
console.log('[PASS] detectComponents 6 项 + 不聚合 Skills/MCP + CcgWorkflow 版本源 (11.5/11.7)');

// ── installComponent('ClaudeCode') npm install + 检测确认（11.6/11.8）────────
const execCalls = [];
const mockExec = async (cmd, args) => {
	execCalls.push({cmd, args});
	if (cmd === 'npm' && args.includes('install')) {
		return {code: 0, stdout: '', stderr: ''};
	}

	if (cmd === 'claude' && args.includes('--version')) {
		return {code: 0, stdout: '1.2.3\n', stderr: ''};
	}

	return {code: 1, stdout: '', stderr: 'mock unknown'};
};
const outcome = await installComponent('ClaudeCode', undefined, {exec: mockExec});
assert.equal(outcome.success, true, 'ClaudeCode 安装成功');
assert.equal(outcome.id, 'ClaudeCode', '返回 id 为 ClaudeCode');
assert.ok(
	execCalls.some(c => c.cmd === 'npm' && c.args.includes('@anthropic-ai/claude-code')),
	'调起 npm install -g @anthropic-ai/claude-code'
);
assert.ok(
	execCalls.some(c => c.cmd === 'claude' && c.args.includes('--version')),
	'安装后检测 claude --version'
);
console.log('[PASS] installComponent ClaudeCode npm install + 检测确认 (11.6/11.8)');

// ── installComponent 未知组件拒绝 ─────────────────────────────────────────────
const unknown = await installComponent('UnknownId');
assert.equal(unknown.success, false, '未知组件返回失败');
assert.match(unknown.error, /未知组件/, '未知组件错误信息');
console.log('[PASS] installComponent 未知组件拒绝');

// ── Phase 11C 卸载门禁（11.10~11.15）──────────────────────────────────────────
const {uninstallComponent, updateComponents} = await import('../src/core/tools-manage.ts');

// P-13：snapshot 失败 → exec 零调用（11.15 snapshot-before-write 不变量）
{
	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 1, stdout: '', stderr: 'mock'};
	};
	const outcome = await uninstallComponent('OpenSpec', undefined, {
		exec: mockExec,
		createSnapshotFn: () => {
			throw new Error('snapshot boom');
		}
	});
	assert.equal(outcome.success, false, 'P-13 快照失败应中止卸载');
	assert.match(outcome.error, /快照失败/, 'P-13 错误信息含快照失败');
	assert.equal(execCalls.length, 0, 'P-13 快照失败后 exec 零调用（snapshot-before-write）');
}
console.log('[PASS] P-13 snapshot 失败 → exec 零调用 (11.15)');

// P-13 更新路径：updateComponents 注入 createSnapshotFn 抛错 → exec 零调用（applyUpdates snapshot-before-write）
{
	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};
	const definition = COMPONENT_DEFINITIONS.find(c => c.id === 'OpenSpec');
	const updatable = {
		...definition,
		installed: true,
		currentVersion: '1.0.0',
		latestVersion: '2.0.0',
		hasUpdate: true
	};
	const result = updateComponents([updatable], undefined, {
		exec: mockExec,
		createSnapshotFn: () => {
			throw new Error('snapshot boom');
		}
	});
	await assert.rejects(result, /snapshot boom/, 'P-13 更新快照失败应抛错');
	assert.equal(execCalls.length, 0, 'P-13 更新快照失败后 exec 零调用（snapshot-before-write）');
}
console.log('[PASS] P-13 更新路径 snapshot 失败 → exec 零调用 (applyUpdates)');

// P-12：CcgWorkflow 深度卸载只删受管路径，用户自定义 hooks/statusLine/commands/rules 保留
{
	const home2 = mkdtempSync(join(tmpdir(), 'ccq-uninstall-ccg-'));
	process.env.CCQ_HOME = home2;
	const dotClaude = join(home2, '.claude');
	mkdirSync(join(dotClaude, 'commands', 'ccg'), {recursive: true});
	mkdirSync(join(dotClaude, 'commands', 'user'), {recursive: true});
	writeFileSync(join(dotClaude, 'commands', 'ccg', 'a.md'), 'ccg', 'utf8');
	writeFileSync(join(dotClaude, 'commands', 'user', 'b.md'), 'user', 'utf8');
	mkdirSync(join(dotClaude, 'rules'), {recursive: true});
	writeFileSync(join(dotClaude, 'rules', 'ccq-ccgworkflow.md'), 'ccg rule', 'utf8');
	writeFileSync(join(dotClaude, 'rules', 'user-rule.md'), 'user rule', 'utf8');
	writeFileSync(
		join(dotClaude, 'settings.json'),
		JSON.stringify({
			statusLine: {type: 'command', command: 'my-statusline', padding: 0},
			hooks: {
				PreToolUse: [
					{matcher: 'Bash', hooks: [{type: 'command', command: '~/.claude/bin/codeagent-wrapper pre'}]},
					{matcher: 'Edit', hooks: [{type: 'command', command: '/usr/bin/my-user-hook'}]}
				]
			}
		}),
		'utf8'
	);
	writeFileSync(join(home2, '.claude.json'), JSON.stringify({}), 'utf8');

	// mock exec：npm ls 返回非 0（无全局 ccg-workflow），不触发 npm uninstall
	const mockExec = async (cmd, args) => {
		if (cmd === 'npm' && args.includes('ls')) {
			return {code: 1, stdout: '(empty)', stderr: ''};
		}

		return {code: 0, stdout: '', stderr: ''};
	};
	const outcome = await uninstallComponent('CcgWorkflow', undefined, {exec: mockExec});
	assert.equal(outcome.success, true, 'CcgWorkflow 卸载成功');

	assert.equal(existsSync(join(dotClaude, 'commands', 'ccg')), false, 'ccg 受管 commands/ccg 已删');
	assert.equal(existsSync(join(dotClaude, 'rules', 'ccq-ccgworkflow.md')), false, 'ccg 受管 rules 已删');
	assert.equal(existsSync(join(dotClaude, 'commands', 'user', 'b.md')), true, '用户 commands 保留');
	assert.equal(existsSync(join(dotClaude, 'rules', 'user-rule.md')), true, '用户 rules 保留');

	const after = JSON.parse(readFileSync(join(dotClaude, 'settings.json'), 'utf8'));
	assert.deepEqual(after.statusLine, {type: 'command', command: 'my-statusline', padding: 0}, '用户自定义 statusLine 保留');
	const userHookKept = after.hooks.PreToolUse.some(g => (g.hooks || []).some(h => h.command === '/usr/bin/my-user-hook'));
	assert.equal(userHookKept, true, '用户自定义 hook 保留');
	const ccgHookGone = !after.hooks.PreToolUse.some(g => (g.hooks || []).some(h => /codeagent-wrapper/.test(h.command)));
	assert.equal(ccgHookGone, true, 'ccg 受管 hook 已移除');

	rmSync(home2, {recursive: true, force: true});
}
console.log('[PASS] P-12 CcgWorkflow 深度卸载只删受管路径，用户内容保留 (11.12/11.13)');

// 11.10/11.11：npm 卸载命令正确 + Ccline 受管 statusLine 还原
{
	const home3 = mkdtempSync(join(tmpdir(), 'ccq-uninstall-ccline-'));
	process.env.CCQ_HOME = home3;
	const dotClaude = join(home3, '.claude');
	mkdirSync(dotClaude, {recursive: true});
	writeFileSync(
		join(dotClaude, 'settings.json'),
		JSON.stringify({statusLine: {type: 'command', command: 'ccline', padding: 0}}),
		'utf8'
	);
	writeFileSync(join(home3, '.claude.json'), JSON.stringify({}), 'utf8');

	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};
	const outcome = await uninstallComponent('Ccline', undefined, {exec: mockExec});
	assert.equal(outcome.success, true, 'Ccline 卸载成功');
	assert.ok(
		execCalls.some(c => c.cmd === 'npm' && c.args.includes('uninstall') && c.args.includes('@cometix/ccline')),
		'调起 npm uninstall -g @cometix/ccline'
	);
	const after = JSON.parse(readFileSync(join(dotClaude, 'settings.json'), 'utf8'));
	assert.equal(after.statusLine, undefined, '受管 statusLine 已移除');
	rmSync(home3, {recursive: true, force: true});
}
console.log('[PASS] npm 卸载命令 + Ccline 受管 statusLine 还原 (11.10/11.11)');

// 11.11 反例：用户自定义 statusLine（非受管值）卸载 Ccline 后不动
{
	const home4 = mkdtempSync(join(tmpdir(), 'ccq-uninstall-ccline-custom-'));
	process.env.CCQ_HOME = home4;
	const dotClaude = join(home4, '.claude');
	mkdirSync(dotClaude, {recursive: true});
	const custom = {type: 'command', command: 'ccline', padding: 2, extra: 'x'};
	writeFileSync(join(dotClaude, 'settings.json'), JSON.stringify({statusLine: custom}), 'utf8');
	writeFileSync(join(home4, '.claude.json'), JSON.stringify({}), 'utf8');

	const outcome = await uninstallComponent('Ccline', undefined, {exec: async () => ({code: 0, stdout: '', stderr: ''})});
	assert.equal(outcome.success, true, 'Ccline 卸载成功');
	const after = JSON.parse(readFileSync(join(dotClaude, 'settings.json'), 'utf8'));
	assert.deepEqual(after.statusLine, custom, '用户自定义 statusLine 不被移除（保护非受管值）');
	rmSync(home4, {recursive: true, force: true});
}
console.log('[PASS] Ccline 用户自定义 statusLine 保护 (11.11)');

// 11.14：Antigravity 改为 fs 直删（不再走 agy uninstall 子命令），success=true，无 manualHint
{
	const outcome = await uninstallComponent('AntigravityCli', undefined, {exec: async () => ({code: 0, stdout: '', stderr: ''})});
	assert.equal(outcome.success, true, 'Antigravity fs 直删成功（无目标文件也不报错）');
	assert.equal(outcome.manualHint, undefined, '已改为 fs 直删，不再产出 manualHint');
}
console.log('[PASS] Antigravity fs 直删 success=true 无 manualHint (11.14)');

rmSync(home, {recursive: true, force: true});
// 缓存目录可能被其他测试共享，不删
console.log('[PASS] Phase 11B/11C tools-manage core 门禁全部通过');
