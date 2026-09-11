import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ccq-mcp-pi-'));
process.env.CCQ_HOME = home;
process.env.HOME = home;

const {
	detectPiMcpAdapter,
	hasPiMcpAdapterPackage,
	parsePiPackageNames,
	readLocalPiMcpAdapterFact,
	readPiMcpAdapterOverride,
	resetPiMcpAdapterFact
} = await import('../src/core/pi-mcp-adapter.ts');
const {computeSharedStatus, computeSharedStatusAsync, enableServer, disableServer, getServerDetail, removeSharedServer, syncSharedDefinition} =
	await import('../src/core/mcp.ts');
const {claudeJsonPath, piAgentDir, piMcpAdapterOverridesPath, piMcpConfigPath, settingsPath, vaultPath, codexConfigPath} = await import(
	'../src/core/paths.ts'
);

function writeJson(path, value) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(path, value) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, value, 'utf8');
}

try {
	assert.deepEqual(parsePiPackageNames(JSON.stringify({packages: ['npm:pi-mcp-adapter@latest', {name: '@scope/other'}]})), [
		'pi-mcp-adapter',
		'@scope/other'
	]);
	assert.deepEqual(
		parsePiPackageNames(
			'User packages:\n  npm:pi-mcp-adapter@1.2.3\n    C:\\Users\\test\\.pi\\agent\\npm\\node_modules\\pi-mcp-adapter\n'
		),
		['pi-mcp-adapter'],
		'Pi list 分组文本应只解析 package source，并去掉 npm 版本后缀'
	);
	assert.equal(hasPiMcpAdapterPackage(JSON.stringify(['pi-mcp-adapter'])), true);
	assert.equal(hasPiMcpAdapterPackage(JSON.stringify(['@scope/other'])), false);

	resetPiMcpAdapterFact();
	assert.equal(readLocalPiMcpAdapterFact().reason, 'pi-not-installed', '没有 Pi agent 目录时必须显示 Pi 未安装');

	mkdirSync(piAgentDir(), {recursive: true});
	resetPiMcpAdapterFact();
	assert.equal(readLocalPiMcpAdapterFact().reason, 'adapter-not-installed', '没有 adapter marker 时必须显示 adapter 未安装');

	mkdirSync(join(piAgentDir(), 'extensions'), {recursive: true});
	writeFileSync(join(piAgentDir(), 'extensions', 'pi-mcp-adapter'), 'marker', 'utf8');
	resetPiMcpAdapterFact();
	assert.equal(readLocalPiMcpAdapterFact().supported, true, 'Pi 与 adapter 都存在时应支持投影');

	const detectedCalls = [];
	const detected = await detectPiMcpAdapter(async (command, args) => {
		if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.1.0', stderr: ''};
		if (command === 'pi' && args[0] === 'list') {
			detectedCalls.push([...args]);
			return {
				code: 0,
				stdout: 'User packages:\n  npm:pi-mcp-adapter@1.2.3\n    C:\\Users\\test\\.pi\\agent\\npm\\node_modules\\pi-mcp-adapter\n',
				stderr: ''
			};
		}
		return {code: 1, stdout: '', stderr: 'unexpected command'};
	});
	assert.deepEqual(detectedCalls, [['list', '--no-approve']], 'Pi adapter 异步检测必须使用当前 Pi 支持的 list 参数');
	assert.deepEqual(
		{piInstalled: detected.piInstalled, adapterInstalled: detected.adapterInstalled, supported: detected.supported},
		{piInstalled: true, adapterInstalled: true, supported: true},
		'Pi adapter 异步检测必须以 pi --version + pi list --no-approve 事实为准'
	);
	resetPiMcpAdapterFact();

	writeJson(piMcpConfigPath(), {
		mcpServers: {
			'pi-native': {
				command: 'native-pi-server',
				args: ['--keep'],
				env: {PI_NATIVE_KEY: 'native-secret'},
				headers: {'x-native-token': 'header-secret'},
				customField: 'preserve'
			}
		}
	});
	const nativeOnlyRow = computeSharedStatus().find(item => item.Id === 'pi-native');
	assert.ok(nativeOnlyRow, '共享 MCP 列表必须包含 Pi 原生 MCP');
	assert.equal(nativeOnlyRow?.hasDefinition, true, 'Pi 原生 MCP 必须回灌为共享 vault 定义');
	assert.equal(nativeOnlyRow?.McpType, 'stdio', 'Pi 原生 command MCP 必须推导为 stdio 类型');
	assert.equal(nativeOnlyRow?.HasCredentials, true, 'Pi 原生 env 凭据必须只显示存在性');
	assert.equal(nativeOnlyRow?.injectByAgent.cc.active, false, 'Pi 原生独有 MCP 不得伪装成 Claude 已开启');
	assert.equal(nativeOnlyRow?.injectByAgent.cx.active, false, 'Pi 原生独有 MCP 不得伪装成 Codex 已开启');
	assert.equal(nativeOnlyRow?.injectByAgent.pi.active, true, 'Pi 原生独有 MCP 必须反映 native mcp.json 的开启状态');
	const nativeOnlyVault = JSON.parse(readFileSync(vaultPath(), 'utf8')).servers['pi-native'];
	assert.deepEqual(
		nativeOnlyVault?.config,
		{
			command: 'native-pi-server',
			args: ['--keep'],
			env: {PI_NATIVE_KEY: 'native-secret'},
			headers: {'x-native-token': 'header-secret'},
			customField: 'preserve'
		},
		'Pi 原生配置必须完整回灌 vault 定义'
	);
	assert.deepEqual(
		nativeOnlyVault?.credentials,
		{values: {PI_NATIVE_KEY: 'native-secret', 'x-native-token': 'header-secret'}},
		'Pi 原生 env/headers 凭据必须同步到 vault credentials'
	);
	assert.equal(getServerDetail('pi-native').config?.command, 'native-pi-server', '编辑 Pi 原生独有 MCP 时必须回显 native 配置');

	writeJson(piMcpConfigPath(), {
		mcpServers: {
			'pi-native': {...nativeOnlyVault.config, disabled: true}
		}
	});
	resetPiMcpAdapterFact();
	const manuallyDisabledNative = computeSharedStatus().find(item => item.Id === 'pi-native');
	assert.equal(manuallyDisabledNative?.injectByAgent.pi.active, false, 'Pi native disabled=true 必须同步后仍保持禁用事实');
	const disabledNativeVault = JSON.parse(readFileSync(vaultPath(), 'utf8')).servers['pi-native'];
	assert.equal(disabledNativeVault?.config?.disabled, undefined, 'Pi disabled 状态不得污染 vault 共享定义');

	writeJson(piMcpConfigPath(), {mcpServers: {'pi-native': nativeOnlyVault.config}});
	resetPiMcpAdapterFact();

	const nativeOnlyDisabled = disableServer('pi-native', 'pi');
	assert.equal(nativeOnlyDisabled.Success, true, 'Pi 原生独有 MCP 应可单侧禁用');
	const nativeOnlyAfterDisable = JSON.parse(readFileSync(piMcpConfigPath(), 'utf8')).mcpServers['pi-native'];
	assert.deepEqual(
		nativeOnlyAfterDisable,
		{
			command: 'native-pi-server',
			args: ['--keep'],
			env: {PI_NATIVE_KEY: 'native-secret'},
			headers: {'x-native-token': 'header-secret'},
			customField: 'preserve',
			disabled: true
		},
		'Pi 原生独有 MCP 禁用时必须保留用户字段和凭据'
	);
	const nativeOnlyEnabled = enableServer('pi-native', 'pi');
	assert.equal(nativeOnlyEnabled.Success, true, 'Pi 原生独有 MCP 应可单侧重新启用');
	const nativeOnlyAfterEnable = JSON.parse(readFileSync(piMcpConfigPath(), 'utf8')).mcpServers['pi-native'];
	assert.deepEqual(
		nativeOnlyAfterEnable,
		{
			command: 'native-pi-server',
			args: ['--keep'],
			env: {PI_NATIVE_KEY: 'native-secret'},
			headers: {'x-native-token': 'header-secret'},
			customField: 'preserve'
		},
		'Pi 原生独有 MCP 重新启用时必须清理 disabled 且保留用户字段'
	);

	writeJson(piMcpConfigPath(), {
		mcpServers: {
			'pi-native': nativeOnlyAfterEnable,
			'pi-external': {command: 'external-pi-server', customField: 'do-not-delete'}
		}
	});
	resetPiMcpAdapterFact();
	const removedUnowned = removeSharedServer('pi-external', true);
	assert.equal(removedUnowned.Success, true, '共享删除应完成 CCQ 侧清理');
	const nativeConfigAfterUnownedRemove = JSON.parse(readFileSync(piMcpConfigPath(), 'utf8'));
	assert.deepEqual(
		nativeConfigAfterUnownedRemove.mcpServers['pi-external'],
		{command: 'external-pi-server', customField: 'do-not-delete'},
		'共享删除不得误删未被 CCQ 接管的 Pi 原生 MCP'
	);

	writeJson(vaultPath(), {
		schemaVersion: 1,
		createdAt: '2026-09-07T00:00:00.000Z',
		updatedAt: '2026-09-07T00:00:00.000Z',
		servers: {'pi-test': {config: {command: 'pi-test'}, credentials: {values: {API_KEY: 'secret-value'}}}}
	});
	writeJson(claudeJsonPath(), {mcpServers: {'pi-test': {command: 'claude-runtime'}}});
	writeText(codexConfigPath(), '[mcp_servers.pi-test]\ncommand = "codex-runtime"\n');
	writeJson(settingsPath(), {permissions: {allow: ['mcp__pi-test', 'Bash']}});

	const claudeBefore = readFileSync(claudeJsonPath(), 'utf8');
	const codexBefore = readFileSync(codexConfigPath(), 'utf8');
	const enabled = enableServer('pi-test', 'pi');
	assert.equal(enabled.Success, true, 'Pi enable 应成功');
	const overrideAfterEnable = readPiMcpAdapterOverride();
	assert.equal(overrideAfterEnable.ok, true);
	if (overrideAfterEnable.ok) assert.equal(overrideAfterEnable.document.servers['pi-test']?.enabled, true);
	const piMcpConfigFile = piMcpConfigPath();
	assert.equal(existsSync(piMcpConfigFile), true, 'Pi enable 必须写入 adapter 读取的标准 mcp.json');
	const nativeConfigAfterEnable = JSON.parse(readFileSync(piMcpConfigFile, 'utf8'));
	assert.deepEqual(
		nativeConfigAfterEnable.mcpServers['pi-test'],
		{command: 'pi-test', env: {API_KEY: 'secret-value'}},
		'Pi 标准配置必须包含共享定义和 vault 凭据'
	);
	assert.equal(readFileSync(claudeJsonPath(), 'utf8'), claudeBefore, 'Pi enable 不得改写 Claude runtime');
	assert.equal(readFileSync(codexConfigPath(), 'utf8'), codexBefore, 'Pi enable 不得改写 Codex runtime');
	assert.doesNotMatch(readFileSync(piMcpAdapterOverridesPath(), 'utf8'), /do-not-copy|API_KEY/, 'Pi override 不得复制 MCP 凭据');

	const disabled = disableServer('pi-test', 'pi');
	assert.equal(disabled.Success, true, 'Pi disable 应成功');
	const overrideAfterDisable = readPiMcpAdapterOverride();
	assert.equal(overrideAfterDisable.ok, true);
	if (overrideAfterDisable.ok) assert.equal(overrideAfterDisable.document.servers['pi-test']?.enabled, false);
	const nativeConfigAfterDisable = JSON.parse(readFileSync(piMcpConfigFile, 'utf8'));
	assert.equal(nativeConfigAfterDisable.mcpServers['pi-test']?.disabled, true, 'Pi disable 必须写入标准 disabled 标记');

	const reenabled = enableServer('pi-test', 'pi');
	assert.equal(reenabled.Success, true, 'Pi re-enable 应成功');
	const nativeConfigAfterReenable = JSON.parse(readFileSync(piMcpConfigFile, 'utf8'));
	assert.equal(nativeConfigAfterReenable.mcpServers['pi-test']?.disabled, undefined, 'Pi re-enable 必须清理标准 disabled 标记');

	writeJson(piMcpAdapterOverridesPath(), {schemaVersion: 1, servers: {}});
	writeJson(piMcpConfigFile, {mcpServers: {'pi-test': {command: 'pi-test', disabled: true}}});
	resetPiMcpAdapterFact();
	const manuallyDisabled = computeSharedStatus().find(item => item.Id === 'pi-test');
	assert.equal(manuallyDisabled?.injectByAgent.pi.active, false, 'Pi 状态必须识别 native mcp.json 的 disabled=true');

	writeJson(piMcpAdapterOverridesPath(), {schemaVersion: 1, servers: {'pi-test': {enabled: true}}, managedServers: ['pi-test']});
	writeJson(piMcpConfigFile, {mcpServers: {'pi-test': {command: 'pi-test'}}});
	resetPiMcpAdapterFact();
	const edited = syncSharedDefinition('pi-test', {command: 'pi-test-updated'}, {API_KEY: 'secret-value'}, '');
	assert.equal(edited.Success, true, 'Pi active MCP 编辑应成功');
	const nativeConfigAfterEdit = JSON.parse(readFileSync(piMcpConfigFile, 'utf8'));
	assert.equal(nativeConfigAfterEdit.mcpServers['pi-test']?.command, 'pi-test-updated', 'Pi active MCP 编辑必须同步标准配置');

	writeFileSync(piMcpAdapterOverridesPath(), '{broken override', 'utf8');
	resetPiMcpAdapterFact();
	assert.equal(readLocalPiMcpAdapterFact().reason, 'override-read-failed', '损坏 override 必须显示读取失败');
	const blocked = enableServer('pi-test', 'pi');
	assert.equal(blocked.Success, false, '损坏 override 时不得报告 Pi enable 成功');
	assert.match(blocked.Status, /Unsupported/);

	writeJson(piMcpAdapterOverridesPath(), {
		schemaVersion: 1,
		userField: 'preserve',
		servers: {
			'pi-test': {enabled: false, removed: true},
			'other-server': {enabled: true}
		}
	});
	writeJson(piMcpConfigFile, {
		mcpServers: {
			'pi-test': {command: 'pi-test', env: {API_KEY: 'secret-value'}, disabled: true},
			'other-server': {command: 'keep'}
		},
		userField: 'preserve'
	});
	writeJson(claudeJsonPath(), {mcpServers: {'pi-test': {command: 'claude-runtime'}, 'other-server': {command: 'keep'}}});
	writeText(codexConfigPath(), '[mcp_servers.pi-test]\ncommand = "codex-runtime"\n\n[mcp_servers.other-server]\ncommand = "keep"\n');
	writeJson(settingsPath(), {permissions: {allow: ['mcp__pi-test', 'mcp__other-server']}});

	const removed = removeSharedServer('pi-test', true);
	assert.equal(removed.Success, true, '共享全量删除应成功');
	const overrideAfterRemove = readPiMcpAdapterOverride();
	assert.equal(overrideAfterRemove.ok, true);
	if (overrideAfterRemove.ok) {
		assert.equal(overrideAfterRemove.document.servers['pi-test'], undefined, '共享删除必须清理 Pi override 记录');
		assert.equal(overrideAfterRemove.document.servers['other-server']?.enabled, true, '共享删除不得影响其他 Pi override');
		assert.equal(overrideAfterRemove.document.userField, 'preserve', 'Pi override 未知字段必须保留');
	}
	const nativeConfigAfterRemove = JSON.parse(readFileSync(piMcpConfigFile, 'utf8'));
	assert.equal(nativeConfigAfterRemove.mcpServers['pi-test'], undefined, '共享删除必须清理 Pi 标准配置');
	assert.deepEqual(nativeConfigAfterRemove.mcpServers['other-server'], {command: 'keep'}, '共享删除不得影响其他 Pi MCP');
	assert.equal(nativeConfigAfterRemove.userField, 'preserve', 'Pi 标准配置未知字段必须保留');
	assert.doesNotMatch(readFileSync(claudeJsonPath(), 'utf8'), /pi-test/, '共享删除必须清理 Claude runtime');
	assert.doesNotMatch(readFileSync(codexConfigPath(), 'utf8'), /mcp_servers\.pi-test/, '共享删除必须清理 Codex runtime');
	assert.doesNotMatch(readFileSync(settingsPath(), 'utf8'), /mcp__pi-test/, '共享删除必须清理 MCP permission');
	assert.doesNotMatch(readFileSync(vaultPath(), 'utf8'), /pi-test/, '共享删除必须清理 vault 定义');

	writeFileSync(piMcpConfigFile, '{broken native config', 'utf8');
	resetPiMcpAdapterFact();
	assert.equal(readLocalPiMcpAdapterFact().reason, 'config-read-failed', '损坏标准 mcp.json 必须显示读取失败');
	writeJson(piMcpConfigFile, {mcpServers: {'other-server': {command: 'keep'}}, userField: 'preserve'});

	writeJson(vaultPath(), {
		schemaVersion: 1,
		createdAt: '2026-09-07T00:00:00.000Z',
		updatedAt: '2026-09-07T00:00:00.000Z',
		servers: {'pi-existing': {config: {command: 'pi-existing'}, credentials: {values: {PI_KEY: 'existing-secret'}}}}
	});
	await computeSharedStatusAsync(async (command, args) => {
		if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.1.0', stderr: ''};
		if (command === 'pi' && args[0] === 'list') {
			return {code: 0, stdout: 'User packages:\n  npm:pi-mcp-adapter@2.32.1\n', stderr: ''};
		}
		return {code: 1, stdout: '', stderr: 'unexpected command'};
	});
	const nativeConfigAfterDiscovery = JSON.parse(readFileSync(piMcpConfigFile, 'utf8'));
	assert.deepEqual(
		nativeConfigAfterDiscovery.mcpServers['pi-existing'],
		{command: 'pi-existing', env: {PI_KEY: 'existing-secret'}, disabled: true},
		'Pi adapter 安装后刷新共享列表必须自动投影既有 vault MCP'
	);
	const piExistingRow = (await computeSharedStatusAsync(async (command, args) => {
		if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.1.0', stderr: ''};
		if (command === 'pi' && args[0] === 'list') return {code: 0, stdout: 'User packages:\n  npm:pi-mcp-adapter@2.32.1\n', stderr: ''};
		return {code: 1, stdout: '', stderr: 'unexpected command'};
	})).find(item => item.Id === 'pi-existing');
	assert.equal(piExistingRow?.injectByAgent.pi.active, false, 'Pi vault-only MCP 不得默认变成 Active');

	console.log('[PASS] Pi MCP Adapter：检测、标准配置投影、unsupported、override 边界、凭据隔离、单侧启停与共享全量删除门禁全部通过');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.HOME;
	rmSync(home, {recursive: true, force: true});
}
