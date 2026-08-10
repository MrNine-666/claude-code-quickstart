import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	gitNexusSetupCommands,
	gitNexusIntegrationCleanupCommands,
	gitNexusFailureDiagnostic,
	GITNEXUS_INSTALL_PACKAGE_SPEC
} from '../src/core/tools-lifecycle.ts';

// GitNexus 领域门禁（implement.md §1/§3/§4）：断言真实 resolver + install/update/uninstall 命令顺序与失败短路。
// 不变量：
// - setup 固定 `gitnexus setup --coding-agent claude,codex`；integration cleanup 固定 `gitnexus uninstall --force`。
// - 首装包 spec 带 dist-tag，registry npmPackage 不带（供 npm outdated/view 复用）。
// - 任何生命周期 argv 都不得含 analyze/clean/serve/wiki 或仓库路径（工具本体 ≠ 仓库索引）。
// - npm install 失败不 setup；setup 失败不报告完整成功；卸载第一步失败不 npm uninstall。

// ── §1 纯 resolver 命令事实 ───────────────────────────────────────────────────
const setup = gitNexusSetupCommands();
assert.equal(setup.length, 1, 'setup 只解析出一条命令');
assert.deepEqual(
	setup[0],
	{cmd: 'gitnexus', args: ['setup', '--coding-agent', 'claude,codex']},
	'setup = gitnexus setup --coding-agent claude,codex（一次接入两侧）'
);

const cleanup = gitNexusIntegrationCleanupCommands();
assert.equal(cleanup.length, 1, 'integration cleanup 只解析出一条命令');
assert.deepEqual(
	cleanup[0],
	{cmd: 'gitnexus', args: ['uninstall', '--force']},
	'integration cleanup = gitnexus uninstall --force（上游无 target 筛选）'
);

// resolver 层不得自带 npm 生命周期：包卸载由 registry 驱动的通用 helper 负责。
assert.equal(
	[...setup, ...cleanup].some(command => command.cmd === 'npm'),
	false,
	'resolver 层不得内联 npm 命令（包名事实仅存于 registry）'
);

// 首装 dist-tag 与 registry 包名分离。
const {TOOL_DEFINITIONS} = await import('../src/core/tools-install.ts');
const gitnexusDefinition = TOOL_DEFINITIONS.find(definition => definition.id === 'GitNexus');
assert.ok(gitnexusDefinition, 'GitNexus 在 registry 中');
assert.equal(GITNEXUS_INSTALL_PACKAGE_SPEC, 'gitnexus@latest', '首装 spec 带 latest dist-tag');
assert.equal(gitnexusDefinition.npmPackage, 'gitnexus', 'registry 包名不带 dist-tag（不污染 npm outdated/view 映射）');

// ── 反例：生命周期 argv 绝不越界到仓库索引域 ──────────────────────────────────
const FORBIDDEN_SUBCOMMANDS = ['analyze', 'clean', 'serve', 'wiki', 'index'];
function assertNoIndexScope(calls, label) {
	for (const call of calls) {
		for (const arg of call.args) {
			assert.equal(
				FORBIDDEN_SUBCOMMANDS.includes(arg),
				false,
				`${label}: argv 不得含仓库索引命令 ${arg}`
			);
			assert.equal(/\.gitnexus/.test(arg), false, `${label}: argv 不得含 .gitnexus/ 仓库路径`);
		}
	}
}

assertNoIndexScope([...setup, ...cleanup], 'resolver');
console.log('[PASS] GitNexus resolver：setup/cleanup argv 固定，包 spec 与 registry 包名分离，无仓库索引命令');

// ── setup 失败诊断（R10）：阶段 + exit code + 上游原文，不吞 engine/native 事实 ──
{
	const engine = gitNexusFailureDiagnostic('GitNexus 编辑器接入失败', 2, 'Unsupported engine: required node ^22.18.0 || >=24.11.0');
	assert.match(engine, /GitNexus 编辑器接入失败 \(exit 2\)/, '保留阶段与 exit code');
	assert.match(engine, /Unsupported engine/, '保留上游 Node.js engine 诊断');
	assert.match(engine, /\^22\.18\.0 \|\| >=24\.11\.0/, '保留具体 engine 区间，便于用户处置');

	const native = gitNexusFailureDiagnostic('GitNexus 编辑器接入刷新失败', 3, '', 'libssl.so.3: cannot open shared object file');
	assert.match(native, /GitNexus 编辑器接入刷新失败 \(exit 3\)/, 'stderr 为空时回落 stdout 但仍带阶段');
	assert.match(native, /libssl\.so\.3/, '保留原生依赖诊断');

	assert.equal(
		gitNexusFailureDiagnostic('GitNexus 编辑器接入失败', 1, '   \n\t  '),
		'GitNexus 编辑器接入失败 (exit 1)',
		'空白诊断不产生悬空冒号'
	);

	const long = gitNexusFailureDiagnostic('GitNexus 编辑器接入失败', 1, `${'x'.repeat(2000)}FINAL_CAUSE`);
	assert.ok(long.length < 500, '超长诊断截断，避免淹没进度日志');
	assert.match(long, /FINAL_CAUSE$/, '截断保留最有价值的尾部原因');

	assert.equal(/\n/.test(gitNexusFailureDiagnostic('stage', 1, 'a\nb\nc')), false, '诊断折叠为单行，不破坏 item 记录格式');
}
console.log('[PASS] GitNexus setup 失败诊断：阶段 + exit code + 上游原文（engine/native 不被吞）');

// ── §3 安装：npm install(gitnexus@latest) → setup → gitnexus -V ───────────────
const {installTool} = await import('../src/core/tools-install.ts');

function makeMockExec(handlers) {
	const calls = [];
	const exec = async (cmd, args) => {
		calls.push({cmd, args: [...args]});
		const result = handlers(cmd, args);
		return result ?? {code: 0, stdout: '', stderr: ''};
	};
	return {calls, exec};
}

{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'npm' && args[0] === 'prefix') {
			return {code: 0, stdout: '/tmp/fake-npm-prefix\n', stderr: ''};
		}

		if (cmd === 'gitnexus' && args[0] === '-V') {
			return {code: 0, stdout: '0.9.4\n', stderr: ''};
		}

		return {code: 0, stdout: '', stderr: ''};
	});

	const outcome = await installTool('GitNexus', undefined, 'cc', {exec});
	assert.equal(outcome.success, true, 'GitNexus 安装成功');
	assert.equal(outcome.version, '0.9.4', '安装后版本收敛为 gitnexus -V 的实际输出');

	const npmInstallIndex = calls.findIndex(call => call.cmd === 'npm' && call.args.includes('install'));
	const setupIndex = calls.findIndex(call => call.cmd === 'gitnexus' && call.args[0] === 'setup');
	const versionIndex = calls.findIndex(call => call.cmd === 'gitnexus' && call.args[0] === '-V');
	assert.ok(npmInstallIndex >= 0, '安装先执行 npm install');
	assert.deepEqual(
		calls[npmInstallIndex],
		{cmd: 'npm', args: ['install', '-g', 'gitnexus@latest']},
		'npm install 使用 gitnexus@latest'
	);
	assert.ok(setupIndex > npmInstallIndex, 'setup 在 npm install 之后执行');
	assert.deepEqual(calls[setupIndex].args, ['setup', '--coding-agent', 'claude,codex'], '安装阶段 setup 一次接入两侧');
	assert.ok(versionIndex > setupIndex, 'setup 之后才做 gitnexus -V postflight');
	assertNoIndexScope(calls, 'install');
}
console.log('[PASS] GitNexus 安装顺序：npm install gitnexus@latest → setup → -V postflight');

// npm install 失败 → setup 绝不执行
{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'npm' && args.includes('install')) {
			return {code: 1, stdout: '', stderr: 'npm ERR! Unsupported engine node@20'};
		}

		return {code: 0, stdout: '', stderr: ''};
	});

	const outcome = await installTool('GitNexus', undefined, 'cc', {exec});
	assert.equal(outcome.success, false, 'npm install 失败则安装失败');
	assert.match(outcome.error, /npm install 失败 \(exit 1\)/, '保留 npm 阶段与 exit code 诊断');
	// R10：Node engine 不满足是 GitNexus 最常见的安装失败原因，且只出现在 npm stderr 中。
	// 通用 friendlyError 只识别网络/权限模式，会把它压成无信息的 fallback。
	assert.match(outcome.error, /Unsupported engine node@20/, 'npm 阶段保留上游 Node engine 原文，不被通用 fallback 吞掉');
	assert.equal(calls.some(call => call.cmd === 'gitnexus'), false, 'npm install 失败后绝不执行 setup');
	assertNoIndexScope(calls, 'install-npm-failed');
}
console.log('[PASS] GitNexus npm install 失败 → setup 零调用');

// setup 失败 → 报告失败（不得因 CLI 已安装而误报完整成功）
{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'gitnexus' && args[0] === 'setup') {
			return {code: 2, stdout: '', stderr: 'GitNexus setup failed: missing OpenSSL 3'};
		}

		if (cmd === 'gitnexus' && args[0] === '-V') {
			return {code: 0, stdout: '0.9.4\n', stderr: ''};
		}

		return {code: 0, stdout: '', stderr: ''};
	});

	const outcome = await installTool('GitNexus', undefined, 'cc', {exec});
	assert.equal(outcome.success, false, 'setup 失败则整体安装失败');
	assert.match(outcome.error, /GitNexus 编辑器接入失败 \(exit 2\)/, '保留 setup 阶段与 exit code 诊断');
	assert.match(outcome.error, /missing OpenSSL 3/, 'setup 失败保留上游原生依赖诊断，不被通用消息覆盖');
	assert.equal(
		calls.some(call => call.cmd === 'gitnexus' && call.args[0] === '-V'),
		false,
		'setup 失败后不继续 postflight（部分状态由后续 detection refresh 如实呈现）'
	);
	assertNoIndexScope(calls, 'install-setup-failed');
}
console.log('[PASS] GitNexus setup 失败 → 安装报告失败，不误报完整成功');

// ── §3 更新：npm 目标版本 → setup 重放；setup 失败仅影响该 item ───────────────
const updateHome = mkdtempSync(join(tmpdir(), 'ccq-gitnexus-update-'));
const originalCcqHome = process.env.CCQ_HOME;
process.env.CCQ_HOME = updateHome;
mkdirSync(join(updateHome, '.claude'), {recursive: true});
writeFileSync(join(updateHome, '.claude.json'), JSON.stringify({}), 'utf8');

const {COMPONENT_DEFINITIONS, updateComponents, uninstallComponent} = await import('../src/core/tools-manage.ts');
const gitnexusComponent = {
	...COMPONENT_DEFINITIONS.find(component => component.id === 'GitNexus'),
	installed: true,
	currentVersion: '0.9.3',
	latestVersion: '0.9.4',
	hasUpdate: true
};
const openspecComponent = {
	...COMPONENT_DEFINITIONS.find(component => component.id === 'OpenSpec'),
	installed: true,
	currentVersion: '1.0.0',
	latestVersion: '2.0.0',
	hasUpdate: true
};

{
	const {calls, exec} = makeMockExec(() => ({code: 0, stdout: '', stderr: ''}));
	const result = await updateComponents([gitnexusComponent], undefined, {
		exec,
		createSnapshotFn: () => join(updateHome, 'snapshot')
	});
	const npmIndex = calls.findIndex(call => call.cmd === 'npm' && call.args.includes('gitnexus@0.9.4'));
	const setupIndex = calls.findIndex(call => call.cmd === 'gitnexus' && call.args[0] === 'setup');
	assert.ok(npmIndex >= 0, '更新先安装目标 npm 版本（registry 包名 + 目标版本）');
	assert.ok(setupIndex > npmIndex, 'npm 安装成功后重放 setup');
	assert.deepEqual(calls[setupIndex].args, ['setup', '--coding-agent', 'claude,codex'], '更新后 setup 仍接入两侧');
	assert.ok(
		result.updatedItems.some(item => item.startsWith('updated::GitNexus::')),
		'setup 成功后该 item 记为 updated'
	);
	assertNoIndexScope(calls, 'update');
}
console.log('[PASS] GitNexus 更新：npm 目标版本 → setup 重放');

{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'gitnexus' && args[0] === 'setup') {
			return {code: 3, stdout: '', stderr: 'setup failed'};
		}

		return {code: 0, stdout: '', stderr: ''};
	});
	const result = await updateComponents([gitnexusComponent, openspecComponent], undefined, {
		exec,
		createSnapshotFn: () => join(updateHome, 'snapshot')
	});
	assert.ok(
		result.updatedItems.some(item => item.startsWith('failed::GitNexus::') && /exit 3/.test(item) && /setup failed/.test(item)),
		'setup 失败时该 item 记为 failed 并保留 exit code 与上游诊断原文'
	);
	assert.ok(
		result.updatedItems.some(item => item.startsWith('updated::OpenSpec::')),
		'GitNexus setup 失败不污染其他组件的更新结果（失败隔离）'
	);
	assert.ok(
		calls.some(call => call.cmd === 'npm' && call.args.includes('@fission-ai/openspec@2.0.0')),
		'其他组件继续执行自己的 npm 更新'
	);
	assertNoIndexScope(calls, 'update-setup-failed');
}
console.log('[PASS] GitNexus 更新 setup 失败 → 仅该 item failed，其他组件继续');

// 更新阶段 npm 失败 → 不重放 setup，且保留上游诊断（R10）
{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'npm' && args.includes('gitnexus@0.9.4')) {
			return {code: 1, stdout: '', stderr: 'npm ERR! gyp ERR! node-pre-gyp prebuilt binary missing'};
		}

		return {code: 0, stdout: '', stderr: ''};
	});
	const result = await updateComponents([gitnexusComponent, openspecComponent], undefined, {
		exec,
		createSnapshotFn: () => join(updateHome, 'snapshot')
	});
	assert.ok(
		result.updatedItems.some(item => item.startsWith('failed::GitNexus::') && /node-pre-gyp prebuilt binary missing/.test(item)),
		'更新阶段 npm 失败保留上游原生依赖诊断'
	);
	assert.equal(
		calls.some(call => call.cmd === 'gitnexus' && call.args[0] === 'setup'),
		false,
		'更新阶段 npm 失败后绝不重放 setup'
	);
	assert.ok(
		result.updatedItems.some(item => item.startsWith('updated::OpenSpec::')),
		'GitNexus npm 更新失败不影响其他组件'
	);
	assertNoIndexScope(calls, 'update-npm-failed');
}
console.log('[PASS] GitNexus 更新 npm 失败 → 不重放 setup，保留原生依赖诊断');

// ── §4 卸载：gitnexus uninstall --force → npm uninstall -g gitnexus ───────────
{
	const {calls, exec} = makeMockExec(() => ({code: 0, stdout: '', stderr: ''}));
	const outcome = await uninstallComponent('GitNexus', undefined, {
		exec,
		createSnapshotFn: () => join(updateHome, 'snapshot')
	});
	assert.equal(outcome.success, true, 'GitNexus 整体卸载成功');
	const cleanupIndex = calls.findIndex(call => call.cmd === 'gitnexus' && call.args[0] === 'uninstall');
	const npmIndex = calls.findIndex(call => call.cmd === 'npm' && call.args.includes('uninstall'));
	assert.ok(cleanupIndex >= 0, '先执行官方编辑器接入清理');
	assert.deepEqual(calls[cleanupIndex].args, ['uninstall', '--force'], '接入清理使用 --force（非 dry run）');
	assert.ok(npmIndex > cleanupIndex, '接入清理成功后才卸载全局 CLI');
	assert.deepEqual(calls[npmIndex].args, ['uninstall', '-g', 'gitnexus'], 'npm 卸载包名派生自 registry（无 dist-tag）');
	assertNoIndexScope(calls, 'uninstall');
}
console.log('[PASS] GitNexus 卸载顺序：接入清理 → 全局 CLI 卸载');

// 第一步失败 → npm uninstall 绝不执行（保留 CLI 便于修复重试）
{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'gitnexus' && args[0] === 'uninstall') {
			return {code: 1, stdout: '', stderr: 'failed to remove editor integration'};
		}

		return {code: 0, stdout: '', stderr: ''};
	});
	const outcome = await uninstallComponent('GitNexus', undefined, {
		exec,
		createSnapshotFn: () => join(updateHome, 'snapshot')
	});
	assert.equal(outcome.success, false, '接入清理失败则卸载失败');
	assert.match(outcome.error, /GitNexus 命令失败 \(exit 1\)/, '保留清理阶段 exit code');
	assert.equal(
		calls.some(call => call.cmd === 'npm' && call.args.includes('uninstall')),
		false,
		'接入清理失败后绝不 npm uninstall（CLI 保留）'
	);
	assertNoIndexScope(calls, 'uninstall-cleanup-failed');
}
console.log('[PASS] GitNexus 接入清理失败 → npm uninstall 零调用');

// 第二步失败 → 报告真实部分状态
{
	const {calls, exec} = makeMockExec((cmd, args) => {
		if (cmd === 'npm' && args.includes('uninstall')) {
			return {code: 1, stdout: '', stderr: 'npm ERR! EACCES'};
		}

		return {code: 0, stdout: '', stderr: ''};
	});
	const outcome = await uninstallComponent('GitNexus', undefined, {
		exec,
		createSnapshotFn: () => join(updateHome, 'snapshot')
	});
	assert.equal(outcome.success, false, 'CLI 卸载失败则整体失败');
	assert.match(outcome.error, /编辑器接入已清理，但全局 gitnexus CLI 卸载失败/, '明确报告部分状态');
	assertNoIndexScope(calls, 'uninstall-npm-failed');
}
console.log('[PASS] GitNexus CLI 卸载失败 → 报告接入已清理的部分状态');

// snapshot 失败 → exec 零调用（snapshot-before-write）
{
	const {calls, exec} = makeMockExec(() => ({code: 0, stdout: '', stderr: ''}));
	const outcome = await uninstallComponent('GitNexus', undefined, {
		exec,
		createSnapshotFn: () => {
			throw new Error('snapshot boom');
		}
	});
	assert.equal(outcome.success, false, 'snapshot 失败中止卸载');
	assert.equal(calls.length, 0, 'snapshot 失败后 exec 零调用');
}
console.log('[PASS] GitNexus 卸载 snapshot-before-write');

// ── 卸载影响提示：全编辑器风险 + 仓库索引保留边界（R6/AC6）────────────────────
const {uninstallImpactNotice} = await import('../src/core/tools-manage.ts');
const notice = uninstallImpactNotice('GitNexus');
assert.match(notice, /所有检测到的编辑器接入/, '提示明确会清理所有检测到的编辑器接入');
assert.match(notice, /Cursor/, '提示点名非 ccq 安装的编辑器接入也会被清理');
assert.match(notice, /\.gitnexus\/ 索引会保留/, '提示明确仓库 .gitnexus/ 索引保留');
console.log('[PASS] GitNexus 卸载影响提示：全编辑器清理 + 仓库索引保留');

// ── CLI 与 TUI 共用同一 core 卸载入口（AC5）──────────────────────────────────
const cliToolsSource = readFileSync(new URL('../src/cli/commands/tools.ts', import.meta.url), 'utf8');
assert.match(cliToolsSource, /uninstallComponent[\s\S]{0,200}from '\.\.\/\.\.\/core\/tools-manage\.js'/, 'CLI 卸载走 core/tools-manage 的 uninstallComponent');
assert.doesNotMatch(cliToolsSource, /gitnexus/i, 'CLI 层不得出现 GitNexus 特判（命令序列由 core 拥有）');
const toolsServicesSource = readFileSync(new URL('../src/views/tools/tools-view-services.ts', import.meta.url), 'utf8');
assert.match(toolsServicesSource, /uninstallComponent\(id, onProgress/, 'TUI service 同样调用 core uninstallComponent');
assert.doesNotMatch(toolsServicesSource, /gitnexus/i, 'TUI service 层不得出现 GitNexus 特判');
console.log('[PASS] GitNexus 卸载 CLI/TUI 共用 core 入口，无层外特判');

if (originalCcqHome === undefined) {
	delete process.env.CCQ_HOME;
} else {
	process.env.CCQ_HOME = originalCcqHome;
}
rmSync(updateHome, {recursive: true, force: true});
console.log('[PASS] GitNexus 生命周期门禁全部通过');
