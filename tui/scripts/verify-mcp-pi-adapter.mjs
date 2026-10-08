import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// Historical gate name retained. Native version/schema pure checks live in tests/core/mcp-pi-adapter.test.ts.
const home = mkdtempSync(join(tmpdir(), 'ccq-mcp-pi-native-'));
process.env.CCQ_HOME = home;
const {currentPiMcpNativeFact, detectPiMcpNative, resetPiMcpNativeFact, readPiMcpAdapterOverride, removePiMcpOverrideRecord} = await import(
	'../src/core/pi-mcp-adapter.ts'
);
const {
	computeSharedStatus,
	computeSharedStatusAsync,
	enableServer,
	disableServer,
	getServerDetail,
	removeSharedServer,
	syncSharedDefinition,
	persistSharedDefinition
} = await import('../src/core/mcp.ts');
const {saveEditedMcpServer, saveMcpServer} = await import('../src/services/mcp-service.ts');
const {claudeJsonPath, piAgentDir, piMcpAdapterOverridesPath, piMcpConfigPath, settingsPath, vaultPath, codexConfigPath} = await import(
	'../src/core/paths.ts'
);
const exec = async (command, args) => {
	assert.deepEqual([command, ...args], ['pi', '--version'], 'MCP detection must never list packages/connect servers');
	return {code: 0, stdout: '1.0.0', stderr: ''};
};
function writeJson(path, value) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value, null, 2));
}
function writeText(path, text) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, text);
}
function read(path) {
	return readFileSync(path, 'utf8');
}
function json(path) {
	return JSON.parse(read(path));
}
function row(id) {
	return computeSharedStatus().find(item => item.Id === id);
}

try {
	assert.equal(piMcpConfigPath(), join(piAgentDir(), 'mcp.json'));
	resetPiMcpNativeFact();
	assert.equal(currentPiMcpNativeFact().reason, 'pi-not-detected');
	await detectPiMcpNative(exec);
	assert.equal(currentPiMcpNativeFact().supported, true, 'No adapter or agent dir prerequisite');

	const oldAdapter = join(piAgentDir(), 'mcp-adapter.json');
	const auth = join(piAgentDir(), 'mcp-auth.json');
	const project = join(home, '.pi', 'mcp.json');
	writeText(oldAdapter, '{"mcpServers":{"adapter_only":{"command":"old","disabled":true}}}');
	writeText(auth, '{"token":"AUTH-SENTINEL"}');
	writeText(project, '{"mcpServers":{"project_only":{"command":"project"}}}');
	const protectedPaths = [oldAdapter, auth, project];
	const protectedBefore = protectedPaths.map(read);

	const nativeEntry = {
		command: 'native-pi-server',
		args: ['--keep'],
		env: {PI_KEY: '${TOKEN}'},
		headers: {'x-native-token': '${HEADER_TOKEN}'},
		customField: 'preserve',
		timeout: 12,
		exposure: 'direct',
		toolExposure: {'get_*': 'hidden'}
	};
	writeJson(piMcpConfigPath(), {
		autoEnableCodemode: false,
		userRoot: 'preserve',
		mcpServers: {native: nativeEntry, external: {command: 'external', enabled: false}}
	});
	// Old adapter ownership must not authorize deletion/adoption of a native same-id entry.
	writeJson(piMcpAdapterOverridesPath(), {
		schemaVersion: 1,
		userField: 'keep',
		managedServers: ['external'],
		servers: {external: {enabled: true}}
	});
	persistSharedDefinition('vault_only', {command: 'vault'}, {}, '');
	const beforeRefresh = read(piMcpConfigPath());
	const sidecarBefore = read(piMcpAdapterOverridesPath());
	const rows = await computeSharedStatusAsync(exec);
	assert.ok(rows.find(item => item.Id === 'native'));
	assert.equal(row('native').hasDefinition, true);
	assert.equal(row('native').McpType, 'stdio');
	assert.equal(row('native').HasCredentials, true);
	assert.equal(row('native').injectByAgent.pi.active, true);
	assert.equal(row('native').injectByAgent.cc.active, false);
	assert.equal(row('native').injectByAgent.cx.active, false);
	assert.equal(row('external').injectByAgent.pi.active, false, 'Native false beats old sidecar true');
	assert.equal(row('vault_only').injectByAgent.pi.active, false);
	assert.equal(row('adapter_only'), undefined, 'Do not discover/auto-migrate old adapter config');
	assert.equal(read(piMcpConfigPath()), beforeRefresh, 'Async refresh never materializes vault or adopts native entries');
	assert.equal(read(piMcpAdapterOverridesPath()), sidecarBefore);
	assert.equal(json(piMcpConfigPath()).mcpServers.vault_only.enabled, false, 'Missing native entry materializes disabled');
	assert.deepEqual(json(vaultPath()).servers.native.config, nativeEntry);
	assert.deepEqual(json(vaultPath()).servers.native.credentials, {values: {PI_KEY: '${TOKEN}', 'x-native-token': '${HEADER_TOKEN}'}});
	assert.equal(json(vaultPath()).servers.external.config.enabled, undefined);
	assert.equal(getServerDetail('native').config.command, nativeEntry.command);
	assert.equal(removeSharedServer('external', true).Success, true);
	assert.equal(json(piMcpConfigPath()).mcpServers.external, undefined, 'Full deletion includes external native entry');
	assert.equal(row('external'), undefined, 'Deleted external entry does not revive');
	// Restore unrelated fixture for subsequent single-agent preservation checks.
	writeJson(piMcpConfigPath(), {
		...json(piMcpConfigPath()),
		mcpServers: {...json(piMcpConfigPath()).mcpServers, external: {command: 'external', enabled: false}}
	});
	assert.equal(removePiMcpOverrideRecord('native').Success, true, 'Refresh alone does not grant implicit deletion authority');
	assert.deepEqual(json(piMcpConfigPath()).mcpServers.native, nativeEntry);
	assert.equal(removeSharedServer('native', true).Success, true, 'Confirmed full deletion includes unowned native entries');
	assert.equal(json(piMcpConfigPath()).mcpServers.native, undefined);
	assert.equal(row('native'), undefined, 'Deleted native entry must not revive on refresh');
	writeJson(piMcpConfigPath(), {...json(piMcpConfigPath()), mcpServers: {...json(piMcpConfigPath()).mcpServers, native: nativeEntry}});

	assert.equal(disableServer('native', 'pi').Success, true);
	assert.deepEqual(json(piMcpConfigPath()).mcpServers.native, {...nativeEntry, enabled: false});
	assert.equal(readPiMcpAdapterOverride().document.dialect, 'pi-native');
	assert.deepEqual(
		json(piMcpAdapterOverridesPath()).managedServers,
		['vault_only', 'native'],
		'Preserve explicit native ownership; do not relabel old adapter ownership'
	);
	assert.equal(enableServer('native', 'pi').Success, true);
	assert.deepEqual(json(piMcpConfigPath()).mcpServers.native, nativeEntry);
	assert.equal(json(piMcpConfigPath()).autoEnableCodemode, false);
	assert.equal(json(piMcpConfigPath()).userRoot, 'preserve');
	assert.doesNotMatch(read(piMcpAdapterOverridesPath()), /PI_KEY|TOKEN/);
	const formBefore = read(piMcpConfigPath());
	for (const config of [
		{type: 'sse', url: 'https://example.com/sse'},
		{command: 'npx', args: [1]},
		{command: 'npx', env: {KEY: 1}},
		{command: 'npx', headers: {Key: null}}
	]) {
		assert.equal(
			saveEditedMcpServer('native', JSON.stringify(config)).ok,
			false,
			'Native active edit validates raw form before shared normalization'
		);
		assert.equal(read(piMcpConfigPath()), formBefore);
	}
	assert.equal(
		saveMcpServer(
			'http_native',
			JSON.stringify({type: 'streamable-http', url: 'https://example.com/mcp', oauth: {clientId: 'id', clientSecret: '${SECRET}'}}),
			'pi'
		).ok,
		true
	);
	assert.equal(json(piMcpConfigPath()).mcpServers.http_native.type, 'streamable-http');
	assert.deepEqual(json(piMcpConfigPath()).mcpServers.http_native.oauth, {clientId: 'id', clientSecret: '${SECRET}'});
	assert.equal(row('http_native').HasCredentials, true, 'OAuth secret presence must not be hidden');

	persistSharedDefinition('shared', {command: 'pi-shared'}, {API_KEY: 'secret-value'}, '');
	writeJson(claudeJsonPath(), {mcpServers: {shared: {command: 'claude-runtime'}}});
	writeText(codexConfigPath(), '[mcp_servers.shared]\ncommand = "codex-runtime"\n');
	writeJson(settingsPath(), {permissions: {allow: ['mcp__shared', 'Bash']}});
	const otherBefore = [claudeJsonPath(), codexConfigPath(), settingsPath()].map(read);
	assert.equal(enableServer('shared', 'pi').Success, true);
	assert.deepEqual(json(piMcpConfigPath()).mcpServers.shared, {command: 'pi-shared', env: {API_KEY: 'secret-value'}});
	assert.deepEqual([claudeJsonPath(), codexConfigPath(), settingsPath()].map(read), otherBefore);
	assert.equal(disableServer('shared', 'pi').Success, true);
	assert.equal(json(piMcpConfigPath()).mcpServers.shared.enabled, false);
	assert.equal(enableServer('shared', 'pi').Success, true);
	assert.equal(json(piMcpConfigPath()).mcpServers.shared.enabled, undefined);
	assert.equal(syncSharedDefinition('shared', {command: 'updated'}, {API_KEY: 'new-secret'}, '').Success, true);
	assert.equal(json(piMcpConfigPath()).mcpServers.shared.command, 'updated');
	assert.equal(removeSharedServer('shared', true).Success, true);
	assert.equal(json(piMcpConfigPath()).mcpServers.shared, undefined);
	assert.equal(json(piMcpAdapterOverridesPath()).servers.shared, undefined);
	assert.equal(json(piMcpAdapterOverridesPath()).userField, 'keep');
	assert.doesNotMatch(read(claudeJsonPath()), /shared/);
	assert.doesNotMatch(read(codexConfigPath()), /mcp_servers.shared/);
	assert.doesNotMatch(read(settingsPath()), /mcp__shared/);
	assert.equal(json(vaultPath()).servers.shared, undefined);
	assert.deepEqual(json(piMcpConfigPath()).mcpServers.external, {command: 'external', enabled: false});

	// Ignored legacy flags/SSE/id/schema must not become false success, nor mutate bytes.
	for (const [id, config] of [
		['legacy', {command: 'old', disabled: true}],
		['bad.id', {command: 'bad'}],
		['sse', {type: 'sse', url: 'https://example.com/sse'}],
		['bad_args', {command: 'npx', args: [1]}],
		['alias_url', {httpUrl: 'https://example.com/mcp'}],
		['alias_headers', {url: 'https://example.com/mcp', http_headers: {Authorization: 'SENTINEL-OLD-HEADER'}}]
	]) {
		writeJson(piMcpConfigPath(), {mcpServers: {[id]: config}});
		const before = read(piMcpConfigPath());
		assert.equal(row(id).injectByAgent.pi.supported, false, `Unsupported schema must remain rejected: ${id}`);
		assert.equal(enableServer(id, 'pi').Success, false);
		assert.equal(disableServer(id, 'pi').Success, false);
		assert.equal(read(piMcpConfigPath()), before);
	}
	for (const bad of [
		'{broken SENTINEL-SECRET',
		'{"mcp-servers":{"old":{"command":"npx"}}}',
		'{"mcpServers":null}',
		'{"autoEnableCodemode":"false"}'
	]) {
		writeText(piMcpConfigPath(), bad);
		assert.equal(currentPiMcpNativeFact().reason, 'config-read-failed');
		assert.equal(enableServer('native', 'pi').Success, false);
		assert.equal(read(piMcpConfigPath()), bad);
	}
	writeJson(piMcpConfigPath(), {mcpServers: {native: nativeEntry}});
	writeText(piMcpAdapterOverridesPath(), '{broken override');
	assert.equal(currentPiMcpNativeFact().reason, 'override-read-failed');
	assert.equal(enableServer('native', 'pi').Success, false);
	assert.equal(read(piMcpAdapterOverridesPath()), '{broken override');
	assert.deepEqual(protectedPaths.map(read), protectedBefore, 'Adapter/project/OAuth bytes never touched');
	assert.equal(existsSync(join(piAgentDir(), 'extensions')), false, 'No extensions installed/uninstalled');
	console.log(
		'[PASS] Pi native MCP: version-only detection, enabled/schema, ownership, read-only async refresh, single-agent writes, secrets, shared deletion, corruption and protected files'
	);
} finally {
	resetPiMcpNativeFact();
	delete process.env.CCQ_HOME;
	rmSync(home, {recursive: true, force: true});
}
