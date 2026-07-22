import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 11B tools-manage core 门禁：工具管理单一真理源（design TDR-11）。
// 覆盖：
// - COMPONENT_DEFINITIONS 8 组件齐备（ClaudeCode + 7 工具）+ 顺序（11.4/11.6）
// - detectComponents 返回 8 项且不聚合 Skills/MCP（11.5/11.7）
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
writeFileSync(
	join(cacheDir, 'npm-view.json'),
	JSON.stringify({
		'@anthropic-ai/claude-code': '',
		'@cometix/ccline': '',
		'ccg-workflow': '',
		'@fission-ai/openspec': '',
		'@colbymchenry/codegraph': '',
		'@openai/codex': ''
	}),
	'utf8'
);

// 预写 CcgWorkflow config.toml：验证本地版本取自 config.toml（而非 codeagent-wrapper 二进制）
mkdirSync(join(home, '.claude', '.ccg'), {recursive: true});
writeFileSync(join(home, '.claude', '.ccg', 'config.toml'), 'version = "3.1.6"\n', 'utf8');

const {
	COMPONENT_DEFINITIONS,
	COMPONENT_META,
	TOOL_GROUP_META,
	TOOL_GROUP_ORDER,
	detectComponents,
	installComponent,
	filterVisibleComponents,
	groupComponentsByToolGroup,
	uninstallImpactNotice
} = await import('../src/core/tools-manage.ts');

// ── COMPONENT_DEFINITIONS 完整性（11.4/11.6）──────────────────────────────────
const ids = COMPONENT_DEFINITIONS.map(c => c.id);
assert.deepEqual(
	ids,
	['ClaudeCode', 'Ccline', 'CcgWorkflow', 'OpenSpec', 'Trellis', 'CodeGraph', 'CodexCli', 'AntigravityCli'],
	'8 组件齐备且定义顺序固定（ClaudeCode + 7 工具）'
);
for (const def of COMPONENT_DEFINITIONS) {
	assert.ok(def.name && def.description, `${def.id} 有 name + description`);
	assert.ok(def.command && def.versionArgs.length > 0, `${def.id} 有检测命令`);
	assert.ok(def.kind, `${def.id} 有 kind`);
}
const claude = COMPONENT_DEFINITIONS.find(c => c.id === 'ClaudeCode');
assert.equal(claude.npmPackage, '@anthropic-ai/claude-code', 'ClaudeCode npm 包名');
console.log('[PASS] COMPONENT_DEFINITIONS 8 组件齐备 (11.4/11.6)');

// 多 Agent 卸载 Modal 必须明确影响范围；单 Agent 工具不得误提示。
assert.match(uninstallImpactNotice('CodeGraph', {fullUninstall: true}), /将在所有 Agent 中卸载/, 'CodeGraph 共享卸载提示所有 Agent');
assert.match(uninstallImpactNotice('CcgWorkflow', {fullUninstall: true}), /将在所有 Agent 中卸载/, 'CcgWorkflow 共享卸载提示所有 Agent');
assert.doesNotMatch(uninstallImpactNotice('ClaudeCode'), /所有 Agent/, 'Claude Code 单工具卸载不提示所有 Agent');

// ── 工具管理分组事实源：Agent / statusLine / 三方工具 ─────────────────────────
assert.deepEqual(TOOL_GROUP_ORDER, ['agent', 'companion', 'tool'], '工具管理分组顺序为 agent → companion → tool');
assert.equal(TOOL_GROUP_META.agent.label, 'Agent', 'agent 分组 label = Agent');
assert.equal(TOOL_GROUP_META.companion.label, 'statusLine', 'companion 分组 label = statusLine');
assert.equal(TOOL_GROUP_META.tool.label, '三方工具', 'tool 分组 label = 三方工具');
assert.equal(COMPONENT_META.CodexCli.group, 'agent', 'CodexCli 属于 Agent 组');
assert.equal(COMPONENT_META.AntigravityCli.group, 'agent', 'AntigravityCli 属于 Agent 组');
assert.equal(COMPONENT_META.Ccline.group, 'companion', 'Ccline 属于 statusLine 组');
assert.equal(COMPONENT_META.CodeGraph.group, 'tool', 'CodeGraph 属于三方工具组');
const groupedDefinitions = groupComponentsByToolGroup(COMPONENT_DEFINITIONS);
assert.deepEqual(groupedDefinitions.map(section => section.label), ['Agent', 'statusLine', '三方工具'], '分组结构输出 label + grid sections');
assert.deepEqual(groupedDefinitions.flatMap(section => section.components.map(component => component.id)), ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'Ccline', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph'], '分组展示顺序按 Agent/statusLine/三方工具重排');
console.log('[PASS] 工具管理分组事实源与展示顺序');

// ── 1.1 CodexCli 官方包名与命令（HC-CODEX-OFFICIAL-PACKAGE）──────────────────
const codexDef = COMPONENT_DEFINITIONS.find(c => c.id === 'CodexCli');
assert.ok(codexDef, 'CodexCli 在 COMPONENT_DEFINITIONS 中');
assert.equal(codexDef.npmPackage, '@openai/codex', 'CodexCli npm 包名为 @openai/codex');
assert.equal(codexDef.command, 'codex', 'CodexCli 检测命令为 codex');
assert.deepEqual(codexDef.versionArgs, ['--version'], 'CodexCli 版本检测参数为 --version');
assert.equal(codexDef.kind, 'npm', 'CodexCli 安装 kind 为 npm');
// update.ts 的 NPM_COMPONENT_MAP / COMMAND_COMPONENTS 派生自 registry（DRY，单一真理源）：
// 不再硬编码逐条映射，而是从 TOOL_DEFINITIONS 计算，故此处断言其派生表达式而非字面量。
const updateSource = readFileSync(new URL('../src/core/update.ts', import.meta.url), 'utf8');
assert.match(updateSource, /NPM_COMPONENT_MAP[^\n]*=\s*Object\.fromEntries\(\s*\n?\s*TOOL_DEFINITIONS\.filter\(def => def\.npmPackage\)/, 'update.ts NPM_COMPONENT_MAP 派生自 registry 的 npmPackage');
assert.match(updateSource, /COMMAND_COMPONENTS[^\n]*=\s*Object\.fromEntries\(\s*\n?\s*TOOL_DEFINITIONS\.map\(def => \[def\.id, \{command: def\.command/, 'update.ts COMMAND_COMPONENTS 派生自 registry 的 command/versionArgs');
console.log('[PASS] 1.1 CodexCli 使用 @openai/codex 与 codex --version（maps 派生自 registry）');

// ── r 手动刷新必须绕过 npm 远程版本缓存，避免 latest 卡在旧缓存（如 Claude Code 1.0.199）──
const toolsViewSource = readFileSync(new URL('../src/views/tools/ToolsView.tsx', import.meta.url), 'utf8');
const toolsHomeSource = readFileSync(new URL('../src/views/tools/ToolsHomeView.tsx', import.meta.url), 'utf8');
const toolsActionsSource = readFileSync(new URL('../src/views/tools/tools-view-actions.ts', import.meta.url), 'utf8');
const toolsManageSource = readFileSync(new URL('../src/core/tools-manage.ts', import.meta.url), 'utf8');
const viewDetectionSource = readFileSync(new URL('../src/services/view-detection.ts', import.meta.url), 'utf8');
const detectionCacheSource = readFileSync(new URL('../src/hooks/use-detection-cache.ts', import.meta.url), 'utf8');
assert.match(toolsViewSource, /cache\.refresh\(\{forceRefresh:\s*true\}\)/, 'ToolsView r 刷新传 forceRefresh');
assert.match(detectionCacheSource, /if \(services\.refreshDetection\)/, 'useDetectionCache 仅在服务提供 refreshDetection 时消费 refresh options');
assert.match(detectionCacheSource, /services\.runDetection\(runner\)/, '无 refreshDetection 时不把 options 误传给 runDetection');
const toolsServicesSource = readFileSync(new URL('../src/views/tools/tools-view-services.ts', import.meta.url), 'utf8');
assert.match(toolsServicesSource, /refreshDetection:\s*\(runner,\s*options\)\s*=>\s*runToolsDetection\(runner,\s*options\)/, 'Tools service 为手动刷新提供专用 refreshDetection');
assert.match(viewDetectionSource, /detectComponents\(undefined,\s*options\.forceRefresh === true\)/, 'runToolsDetection 透传 forceRefresh');
assert.match(toolsManageSource, /getNpmOutdatedGlobal\(forceRefresh\)/, 'detectComponents 强刷 npm outdated 缓存');
assert.match(updateSource, /resolveNpmViewLatest\(Object\.values\(NPM_COMPONENT_MAP\),\s*forceRefresh\)/, 'checkCliToolUpdates 强刷 npm view 缓存');
assert.match(toolsHomeSource, /groupToolsForHome\(view\.components\)/, 'ToolsHomeView 按领域分组结构渲染 label + grid');
assert.match(toolsHomeSource, /<text[\s\S]{0,500}>\s*\{section\.label\}\s*<\/text>/, 'ToolsHomeView 渲染分组 label');
assert.doesNotMatch(toolsHomeSource, /label:\s*['"]Agent['"]/, 'ToolsHomeView 不硬编码 Agent 分组 label');
console.log('[PASS] r 手动刷新绕过 npm outdated/npm view 缓存');

// 单项 install/update/uninstall 成功后必须同步 App 层检测缓存，否则切换 Header 时
// detection.result 会重新下发旧版本号，覆盖 ToolsView 的局部 patch。
function sourceSection(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(start, -1, `${startMarker} 存在`);
	assert.notEqual(end, -1, `${endMarker} 存在`);
	return source.slice(start, end);
}

assert.match(
	sourceSection(toolsActionsSource, 'function installOne', 'function updateOne'),
	/cache\.refresh\(\)/,
	'单项安装成功后刷新检测缓存，避免切换 Agent 回退版本/安装态'
);
assert.match(
	sourceSection(toolsActionsSource, 'function updateOne', 'export function updateAll'),
	/cache\.refresh\(\)/,
	'单项更新成功后刷新检测缓存，避免切换 Agent 回退到旧版本号'
);
assert.match(
	sourceSection(toolsActionsSource, 'export function runUninstall', 'export function uninstallSuccessPatch'),
	/cache\.refresh\(\)/,
	'单项卸载成功后刷新检测缓存，避免切换 Agent 回退安装态'
);
console.log('[PASS] 工具单项生命周期成功后同步 App 层检测缓存');

// ── detectComponents 返回 8 项 + 不聚合 Skills/MCP（11.5/11.7）────────────────
const components = await detectComponents();
assert.equal(components.length, 8, 'detectComponents 返回 8 项（不聚合 Skills/MCP）');
const hasSkillsOrMcp = components.some(c => /^Skill:|^Mcp:/.test(c.id));
assert.equal(hasSkillsOrMcp, false, '不含 Skill:/Mcp: 前缀组件（11.7 不聚合 Skills/MCP）');

// CcgWorkflow 版本取自 config.toml（复用 update.ts 检测逻辑，单一真理源）
const ccg = components.find(c => c.id === 'CcgWorkflow');
assert.equal(ccg.installed, true, 'CcgWorkflow installed（config.toml 存在）');
assert.equal(ccg.currentVersion, '3.1.6', 'CcgWorkflow 本地版本取自 config.toml');
assert.equal(ccg.hasUpdate, false, 'CcgWorkflow 无远程数据时不误报更新');

// ClaudeCode 纳入受管检测（11.6）
assert.ok(components.some(c => c.id === 'ClaudeCode'), 'ClaudeCode 纳入受管检测（11.6）');
console.log('[PASS] detectComponents 8 项 + 不聚合 Skills/MCP + CcgWorkflow 版本源 (11.5/11.7)');

// ── Codex Header 下工具安装态不得复用 Claude/global 状态 ────────────────────────
{
	const globalInstalled = components.map(component => {
		if (component.id === 'CodeGraph') {
			return {...component, installed: true, currentVersion: '1.2.3', latestVersion: '1.2.3', hasUpdate: false};
		}

		if (component.id === 'CcgWorkflow') {
			return {...component, latestVersion: '3.1.11'};
		}

		return component;
	});
	const claudeVisibleWithoutIntegration = filterVisibleComponents(globalInstalled, 'cc');
	assert.deepEqual(claudeVisibleWithoutIntegration.map(c => c.id), ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'Ccline', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph'], 'Claude Code Header 下可见组件按 Agent/statusLine/三方工具展示');
	const claudeCodeGraph = claudeVisibleWithoutIntegration.find(c => c.id === 'CodeGraph');
	assert.equal(claudeCodeGraph.installed, false, 'Claude Code 未接入 CodeGraph 时不得仅凭全局 codegraph CLI 显示已安装');
	assert.equal(claudeCodeGraph.hasUpdate, null, 'Claude Code 未接入 CodeGraph 时不显示更新态');
	assert.match(claudeCodeGraph.statusHint, /Claude Code 未接入 CodeGraph/, 'Claude Code CodeGraph 缺失提示明确');

	const codexVisibleWithoutIntegration = filterVisibleComponents(globalInstalled, 'cx');
	assert.deepEqual(codexVisibleWithoutIntegration.map(c => c.id), ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph'], 'Codex Header 下隐藏空 statusLine 组并保持分组顺序');
	assert.deepEqual(groupComponentsByToolGroup(codexVisibleWithoutIntegration).map(section => section.label), ['Agent', '三方工具'], 'Codex Header 下空 statusLine 分组不展示');
	const codexCcg = codexVisibleWithoutIntegration.find(c => c.id === 'CcgWorkflow');
	const codexCodeGraph = codexVisibleWithoutIntegration.find(c => c.id === 'CodeGraph');
	assert.equal(codexCcg.installed, false, 'Codex 未安装 Mode 时 CcgWorkflow 不得沿用 ~/.claude/.ccg/config.toml 的 installed=true');
	assert.equal(codexCcg.hasUpdate, null, 'Codex 未安装 Mode 时 CcgWorkflow 不显示更新态');
	assert.match(codexCcg.statusHint, /Codex Mode 未安装/, 'Codex CcgWorkflow 缺失提示明确');
	assert.equal(codexCodeGraph.installed, false, 'Codex 未接入 CodeGraph 时不得仅凭全局 codegraph CLI 显示已安装');
	assert.equal(codexCodeGraph.hasUpdate, null, 'Codex 未接入 CodeGraph 时不显示更新态');
	assert.match(codexCodeGraph.statusHint, /Codex 未接入 CodeGraph/, 'Codex CodeGraph 缺失提示明确');

	writeFileSync(join(home, '.claude.json'), JSON.stringify({mcpServers: {codegraph: {command: 'codegraph', args: ['serve', '--mcp']}}}), 'utf8');
	assert.equal(filterVisibleComponents(globalInstalled, 'cc').find(c => c.id === 'CodeGraph').installed, true, 'Claude Code mcpServers.codegraph 存在时 CodeGraph 显示已安装');

	mkdirSync(join(home, '.codex'), {recursive: true});
	writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.codegraph]\ncommand = "codegraph"\nenabled = false\n', 'utf8');
	assert.equal(filterVisibleComponents(globalInstalled, 'cx').find(c => c.id === 'CodeGraph').installed, false, 'Codex CodeGraph enabled=false 时不得显示已安装');

	writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n', 'utf8');
	writeFileSync(join(home, '.codex', '.ccg-version'), '3.1.10\n', 'utf8');

	const codexVisibleWithIntegration = filterVisibleComponents(globalInstalled, 'cx');
	const codexCcgWithIntegration = codexVisibleWithIntegration.find(c => c.id === 'CcgWorkflow');
	assert.equal(codexCcgWithIntegration.installed, true, 'Codex Mode 版本文件存在时 CcgWorkflow 显示已安装');
	assert.equal(codexCcgWithIntegration.currentVersion, '3.1.10', 'Codex CcgWorkflow 本地版本来自 ~/.codex/.ccg-version');
	assert.equal(codexCcgWithIntegration.hasUpdate, true, 'Codex CcgWorkflow 可基于 .ccg-version 与 latestVersion 判定更新');
	assert.equal(codexVisibleWithIntegration.find(c => c.id === 'CodeGraph').installed, true, 'Codex config.toml 含 [mcp_servers.codegraph] 时 CodeGraph 显示已安装');
}
console.log('[PASS] Codex Header 工具安装态按 ~/.codex 集成信号修正');

// ── installComponent('ClaudeCode') npm install + 检测确认（11.6/11.8）────────
const execCalls = [];
const mockExec = async (cmd, args) => {
	execCalls.push({cmd, args});
	if (cmd === 'npm' && args.includes('install')) {
		return {code: 0, stdout: '', stderr: ''};
	}

	if (cmd === 'npm' && args[0] === 'prefix') {
		return {code: 0, stdout: `${home}\n`, stderr: ''};
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
const npmInstallIndex = execCalls.findIndex(c => c.cmd === 'npm' && c.args.includes('@anthropic-ai/claude-code'));
const npmPrefixIndex = execCalls.findIndex(c => c.cmd === 'npm' && c.args[0] === 'prefix');
const claudeVersionIndex = execCalls.findIndex(c => c.cmd === 'claude' && c.args.includes('--version'));
assert.ok(npmInstallIndex >= 0, '调起 npm install -g @anthropic-ai/claude-code');
assert.ok(npmPrefixIndex > npmInstallIndex, 'ClaudeCode 安装后刷新 npm global bin PATH');
assert.ok(claudeVersionIndex > npmPrefixIndex, '刷新 PATH 后检测 claude --version');
console.log('[PASS] installComponent ClaudeCode npm install + PATH 刷新 + 检测确认 (11.6/11.8)');

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

// CodeGraph 更新后按已接入 Agent 重跑 install，并校验 MCP 仍存在
{
	const homeUpdate = mkdtempSync(join(tmpdir(), 'ccq-update-codegraph-'));
	process.env.CCQ_HOME = homeUpdate;
	process.env.CODEX_HOME = join(homeUpdate, '.codex');
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	writeFileSync(join(homeUpdate, '.claude.json'), JSON.stringify({mcpServers: {codegraph: {command: 'codegraph', args: ['serve', '--mcp']}}}), 'utf8');
	writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), '[mcp_servers.codegraph]\ncommand = "codegraph"\n', 'utf8');

	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};
	const definition = COMPONENT_DEFINITIONS.find(c => c.id === 'CodeGraph');
	await updateComponents([{...definition, installed: true, currentVersion: '1.0.0', latestVersion: '2.0.0', hasUpdate: true}], undefined, {
		exec: mockExec,
		createSnapshotFn: () => join(homeUpdate, 'snapshot')
	});
	assert.ok(execCalls.some(c => c.cmd === 'npm' && c.args.includes('@colbymchenry/codegraph@2.0.0')), 'CodeGraph 更新先 npm install 指定 latest');
	assert.ok(execCalls.some(c => c.cmd === 'codegraph' && c.args.includes('--target=claude')), 'CodeGraph 更新后重接入 Claude Code');
	assert.ok(execCalls.some(c => c.cmd === 'codegraph' && c.args.includes('--target=codex')), 'CodeGraph 更新后重接入 Codex');
	process.env.CCQ_HOME = home;
	delete process.env.CODEX_HOME;
	rmSync(homeUpdate, {recursive: true, force: true});
}
console.log('[PASS] CodeGraph 更新后重接入已安装 Agent');

// P-12：CcgWorkflow 卸载走官方非交互命令（Claude Code → `ccg-workflow uninstall`），
//       ccq 不再 fs 删除用户目录（文件边界交给官方命令负责）。
{
	const home2 = mkdtempSync(join(tmpdir(), 'ccq-uninstall-ccg-'));
	process.env.CCQ_HOME = home2;
	const dotClaude = join(home2, '.claude');
	// 预置用户内容：验证 ccq 卸载路径不再触碰这些文件（不删、不改）。
	mkdirSync(join(dotClaude, 'commands', 'ccg'), {recursive: true});
	writeFileSync(join(dotClaude, 'commands', 'ccg', 'a.md'), 'ccg', 'utf8');
	writeFileSync(join(home2, '.claude.json'), JSON.stringify({}), 'utf8');

	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};
	const outcome = await uninstallComponent('CcgWorkflow', undefined, {exec: mockExec});
	assert.equal(outcome.success, true, 'CcgWorkflow 卸载成功');

	// 断言执行了官方 Claude Code 卸载命令，未走 npm uninstall / fs 删除。
	const officialCall = execCalls.find(c => c.args.includes('ccg-workflow') && c.args.includes('uninstall'));
	assert.ok(officialCall, 'CcgWorkflow 卸载执行官方 ccg-workflow uninstall 命令');
	assert.equal(
		officialCall.args.some(a => a === 'codex-mode'),
		false,
		'Claude Code 卸载不带 codex-mode 子命令'
	);
	assert.equal(
		execCalls.some(c => c.cmd === 'npm' && c.args.includes('uninstall')),
		false,
		'CcgWorkflow 卸载不执行 npm uninstall'
	);

	// ccq 不再 fs 删除用户目录（官方命令负责文件边界）。
	assert.equal(existsSync(join(dotClaude, 'commands', 'ccg', 'a.md')), true, 'ccq 卸载路径不 fs 删除用户目录');

	rmSync(home2, {recursive: true, force: true});
}
console.log('[PASS] P-12 CcgWorkflow 卸载走官方 ccg-workflow uninstall，ccq 不 fs 删除');

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

// ── CodeGraph 卸载：逐 Agent 直改配置（绝不调官方命令、绝不碰 CLI）；整体卸载才移除 CLI ──
// 实测官方 `codegraph uninstall --target=xxx` 会连带卸掉共享 CLI（与文档不符），
// 因此逐 Agent 关闭一律直删配置文件（.claude.json / config.toml / 指令块 / settings.json），
// 只有 fullUninstall 才 npm uninstall -g 移除共享 CLI。
{
	const homeCodeGraph = mkdtempSync(join(tmpdir(), 'ccq-uninstall-codegraph-'));
	process.env.CCQ_HOME = homeCodeGraph;
	mkdirSync(join(homeCodeGraph, '.claude'), {recursive: true});
	mkdirSync(join(homeCodeGraph, '.codex'), {recursive: true});
	const claudeJson = join(homeCodeGraph, '.claude.json');
	const claudeMd = join(homeCodeGraph, '.claude', 'CLAUDE.md');
	const claudeSettings = join(homeCodeGraph, '.claude', 'settings.json');
	const codexToml = join(homeCodeGraph, '.codex', 'config.toml');
	const codexAgents = join(homeCodeGraph, '.codex', 'AGENTS.md');

	const codegraphBlock = '<!-- CODEGRAPH_START -->\n## CodeGraph\n\nuse codegraph.\n<!-- CODEGRAPH_END -->\n';
	const execCalls = [];
	const mockExec = async (cmd, args) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};

	// —— 逐 Agent 关闭 Claude Code：清 .claude.json mcp + CLAUDE.md 块 + settings permissions/hooks，保留 CLI 与用户内容 ——
	writeFileSync(claudeJson, JSON.stringify({mcpServers: {codegraph: {command: 'codegraph'}, deepwiki: {}}}), 'utf8');
	writeFileSync(claudeMd, `# 我的规则\n\n保留我\n\n${codegraphBlock}`, 'utf8');
	writeFileSync(claudeSettings, JSON.stringify({
		permissions: {allow: ['Read', 'mcp__codegraph__*', 'mcp__deepwiki']},
		hooks: {
			UserPromptSubmit: [
				{hooks: [{type: 'command', command: 'node /u/.claude/hooks/ccg/x.js'}]},
				{hooks: [{type: 'command', command: 'codegraph prompt-hook'}]}
			]
		}
	}), 'utf8');
	// codex 仍接入，确保「保留 CLI」不依赖剩余接入判断（逐 Agent 路径本就永不删 CLI）
	writeFileSync(codexToml, '[mcp_servers.codegraph]\ncommand = "codegraph"\n', 'utf8');

	const outcomeCc = await uninstallComponent('CodeGraph', undefined, {exec: mockExec});
	assert.equal(outcomeCc.success, true, 'CodeGraph Claude Code 默认卸载成功');
	assert.equal(execCalls.some(c => c.cmd === 'codegraph'), false, '逐 Agent 关闭绝不调用官方 codegraph 命令');
	assert.equal(execCalls.some(c => c.cmd === 'npm' && c.args.includes('uninstall')), false, '逐 Agent 关闭永不 npm uninstall 共享 CLI');
	const cj = JSON.parse(readFileSync(claudeJson, 'utf8'));
	assert.equal(cj.mcpServers.codegraph, undefined, 'Claude .claude.json 删除 codegraph mcp');
	assert.ok(cj.mcpServers.deepwiki, '保留其它 mcp 条目');
	const md = readFileSync(claudeMd, 'utf8');
	assert.equal(md.includes('CODEGRAPH_START'), false, 'CLAUDE.md 删除 codegraph 指令块');
	assert.ok(md.includes('保留我'), 'CLAUDE.md 保留用户内容');
	const st = JSON.parse(readFileSync(claudeSettings, 'utf8'));
	assert.equal(st.permissions.allow.includes('mcp__codegraph__*'), false, 'settings 删除 codegraph 权限');
	assert.deepEqual(st.permissions.allow, ['Read', 'mcp__deepwiki'], 'settings 保留其它权限');
	assert.equal(st.hooks.UserPromptSubmit.length, 1, 'settings 删除 codegraph hook group');
	assert.ok(st.hooks.UserPromptSubmit[0].hooks[0].command.includes('ccg/x.js'), 'settings 保留用户 hook');

	// —— 逐 Agent 关闭 Codex：清 config.toml 表 + AGENTS.md 块，永不动 CLI ——
	writeFileSync(codexToml, '[mcp_servers.codegraph]\ncommand = "codegraph"\n\n[mcp_servers.other]\ncommand = "x"\n', 'utf8');
	writeFileSync(codexAgents, `# codex 规则\n\n${codegraphBlock}`, 'utf8');
	execCalls.length = 0;
	const outcomeCx = await uninstallComponent('CodeGraph', undefined, {exec: mockExec, agentContext: 'cx'});
	assert.equal(outcomeCx.success, true, 'CodeGraph Codex 默认卸载成功');
	assert.equal(execCalls.some(c => c.cmd === 'codegraph'), false, 'Codex 逐 Agent 关闭不调官方命令');
	assert.equal(execCalls.some(c => c.cmd === 'npm' && c.args.includes('uninstall')), false, 'Codex 逐 Agent 关闭永不 npm uninstall 共享 CLI');
	const toml = readFileSync(codexToml, 'utf8');
	assert.equal(toml.includes('mcp_servers.codegraph'), false, 'Codex config.toml 删除 codegraph 表');
	assert.ok(toml.includes('mcp_servers.other'), 'Codex config.toml 保留其它表');
	assert.equal(readFileSync(codexAgents, 'utf8').includes('CODEGRAPH_START'), false, 'AGENTS.md 删除 codegraph 指令块');

	// —— fullUninstall（整体卸载）：直删两侧配置 + npm uninstall -g 共享 CLI ——
	writeFileSync(claudeJson, JSON.stringify({mcpServers: {codegraph: {command: 'codegraph'}}}), 'utf8');
	writeFileSync(codexToml, '[mcp_servers.codegraph]\ncommand = "codegraph"\n', 'utf8');
	execCalls.length = 0;
	const outcomeFull = await uninstallComponent('CodeGraph', undefined, {exec: mockExec, fullUninstall: true});
	assert.equal(outcomeFull.success, true, 'CodeGraph 整体卸载成功');
	assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.codegraph, undefined, '整体卸载删除 claude mcp');
	assert.equal(readFileSync(codexToml, 'utf8').includes('mcp_servers.codegraph'), false, '整体卸载删除 codex 表');
	assert.equal(execCalls.some(c => c.cmd === 'codegraph'), false, '整体卸载也不调官方命令');
	assert.ok(execCalls.some(c => c.cmd === 'npm' && c.args.includes('uninstall') && c.args.includes('@colbymchenry/codegraph')), '整体卸载 npm uninstall 共享 CLI');
	process.env.CCQ_HOME = home;
	rmSync(homeCodeGraph, {recursive: true, force: true});
}
console.log('[PASS] CodeGraph 逐 Agent 关闭保留共享 CLI，仅整体卸载移除 CLI');

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
