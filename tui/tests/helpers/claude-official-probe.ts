import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {
	CLAUDE_OFFICIAL_KEY,
	getDisplayData,
	getProviderList,
	switchProvider,
	addProvider,
	editProvider,
	deleteProvider,
	migrateLegacyProfiles,
	snapshotClaudeProvidersSection,
	importClaudeProvidersSection
} from '../../src/core/provider.js';
import {snapshotSettingsSection, importSettingsSection} from '../../src/core/config-transfer-sections.js';
import {planConfigTransferExport, planConfigTransferImport, applyConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {createBundlePayload} from '../../src/core/config-transfer.js';
import {
	refreshClaudeProviderDisplay,
	switchActiveProvider,
	loadProviderProfile,
	saveProviderForm,
	buildForm
} from '../../src/services/provider-service.js';
import {createProviderViewAdapter} from '../../src/views/provider/provider-view-adapter.js';
import {scanCodexProfiles, saveCodexProfile, setDefaultCodexProfile, isCodexOfficialLoggedIn} from '../../src/core/codex.js';
import {loadCodexProviderDisplay, removeCodexProvider, switchActiveCodexProvider} from '../../src/services/codex-service.js';
import {runLs} from '../../src/cli/commands/ls.js';
import {runUse} from '../../src/cli/commands/use.js';
import {CLAUDE_OAUTH_ENV_KEYS} from '../../src/core/claude-auth.js';
import type {execCommand} from '../../src/core/exec.js';

const home = process.env.CCQ_HOME!;
assert(home && process.env.HOME === home && process.env.TEMP?.startsWith(home));
for (const key of [
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_API_KEY',
	...CLAUDE_OAUTH_ENV_KEYS,
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY'
])
	delete process.env[key];
const dir = join(home, '.claude');
const profiles = join(dir, 'providers');
const settings = join(dir, 'settings.json');
mkdirSync(profiles, {recursive: true});
const seed = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const fake =
	(authMethod: string, code: number): typeof execCommand =>
	async (command, args) => {
		assert.equal(command, 'claude');
		assert.deepEqual(args, ['auth', 'status']);
		return {code, stdout: JSON.stringify({authMethod, configDirectory: dir}), stderr: ''};
	};
const oauth = {exec: fake('claude.ai', 0)};
const missing = {exec: fake('none', 1)};
assert.equal(getProviderList().length, 0);
assert.deepEqual(getDisplayData().profiles, []);
assert.equal(getDisplayData().hasProviders, false);
assert.equal(getDisplayData().officialAuth?.status, 'unknown');
assert.equal(getDisplayData().activeKey, '');
switchProvider(CLAUDE_OFFICIAL_KEY);
assert(!existsSync(settings), 'no-op must not create settings');
assert.equal((await refreshClaudeProviderDisplay(oauth)).activeKey, CLAUDE_OFFICIAL_KEY);
for (const options of [missing, {exec: fake('api_key', 0)}, {exec: async () => ({code: 0, stdout: '{bad', stderr: ''})}]) {
	const display = await refreshClaudeProviderDisplay(options);
	assert.deepEqual(display.profiles, []);
	assert.equal(display.hasProviders, false);
	assert.equal(display.activeKey, '');
}
assert.equal((await refreshClaudeProviderDisplay(missing)).officialAuth?.status, 'missing');
const adapter = createProviderViewAdapter('cc');
const official = (await refreshClaudeProviderDisplay(oauth)).profiles[0]!;
assert(adapter.isOfficial(official));
assert.equal(adapter.toHomeRow(official).title, '官方账号');
assert.equal(adapter.toHomeRow(official).summary, '已授权登录');
assert.equal(official.baseUrl + official.authToken + official.maskedApiKey + official.profilePath, '');
assert.equal(official.canEdit, false);
assert.equal(official.canDelete, false);
assert.equal(loadProviderProfile(''), null);
assert.throws(() => editProvider(CLAUDE_OFFICIAL_KEY, {}), /claude auth login/);
assert.throws(() => deleteProvider(CLAUDE_OFFICIAL_KEY), /claude auth logout/);
const form = buildForm({mode: 'edit', profileKey: CLAUDE_OFFICIAL_KEY});
assert.equal(saveProviderForm({mode: 'edit', profileKey: CLAUDE_OFFICIAL_KEY}, form.values).ok, false);

const profilePath = join(profiles, 'official.json');
const env = {
	ANTHROPIC_BASE_URL: 'https://example.test',
	ANTHROPIC_AUTH_TOKEN: 'TEST-KEY',
	ANTHROPIC_DEFAULT_OPUS_MODEL: 'test-model',
	ANTHROPIC_DEFAULT_SONNET_MODEL: 'test-model',
	ANTHROPIC_DEFAULT_HAIKU_MODEL: 'test-model',
	API_TIMEOUT_MS: '1000'
};
seed(profilePath, {env});
const bytes = readFileSync(profilePath, 'utf8');
seed(settings, {
	env: {UNRELATED: 'keep'},
	language: 'zh',
	model: 'keep',
	permissions: {allow: ['keep']},
	hooks: {},
	statusLine: {type: 'keep'},
	unknown: {keep: true}
});
switchProvider('official');
assert.equal(getDisplayData().activeKey, 'official');
seed(settings, {...read(settings), modelMapping: {opus: 'legacy-model'}});
switchProvider(CLAUDE_OFFICIAL_KEY);
assert.equal(read(settings).modelMapping, undefined);
assert.deepEqual(read(settings).env, {UNRELATED: 'keep'});
assert.equal(read(settings).model, 'keep');
assert.equal(read(settings).unknown.keep, true);
assert.equal(readFileSync(profilePath, 'utf8'), bytes);
assert.equal((await refreshClaudeProviderDisplay(oauth)).activeKey, CLAUDE_OFFICIAL_KEY);
switchProvider('official');
assert.equal(getDisplayData().activeKey, 'official');

const refuse = () => {
	const before = readFileSync(settings, 'utf8');
	assert.throws(() => switchProvider(CLAUDE_OFFICIAL_KEY));
	assert.equal(readFileSync(settings, 'utf8'), before);
	assert.notEqual(getDisplayData({status: 'configured'}).activeKey, CLAUDE_OFFICIAL_KEY);
};
seed(join(profiles, 'duplicate.json'), {env});
assert.equal(getDisplayData().activeKey, '');
refuse();
rmSync(join(profiles, 'duplicate.json'));
seed(settings, {env: {...env, API_TIMEOUT_MS: 'changed'}});
refuse();
for (const malformed of ['{bad', '[]', '{"env":[]}', '{"env":{"bad":123}}']) {
	writeFileSync(settings, malformed);
	refuse();
}
seed(settings, {env});
for (const malformed of ['{bad', '[]', '{"env":[]}', '{"env":{"bad":123}}']) {
	writeFileSync(join(profiles, 'bad.json'), malformed);
	refuse();
	const settingsBeforeSwitch = readFileSync(settings, 'utf8');
	assert.throws(() => switchProvider('bad'));
	assert.equal(readFileSync(settings, 'utf8'), settingsBeforeSwitch);
	assert.throws(() => editProvider('bad', {apiKey: 'new'}));
	assert.throws(() => deleteProvider('bad', {force: true}));
	assert.equal(
		addProvider({profileKey: 'bad', baseUrl: 'https://example.test', apiKey: 'new', conflictStrategy: 'overwrite'}).success,
		false
	);
	migrateLegacyProfiles();
	assert.equal(readFileSync(join(profiles, 'bad.json'), 'utf8'), malformed);
}
rmSync(join(profiles, 'bad.json'));
seed(join(profiles, '@official.json'), {env});
refuse();
assert.equal(getDisplayData().profiles.filter(p => p.key === CLAUDE_OFFICIAL_KEY).length, 0);
rmSync(join(profiles, '@official.json'));
seed(settings, {env: {ANTHROPIC_AUTH_TOKEN: 'unmatched'}});
refuse();
rmSync(profiles, {recursive: true});
writeFileSync(profiles, 'directory-unreadable-sentinel');
refuse();
assert.equal(readFileSync(profiles, 'utf8'), 'directory-unreadable-sentinel');
rmSync(profiles);
mkdirSync(profiles);
seed(profilePath, {env});
seed(settings, {apiKeyHelper: 'keep', env: {UNRELATED: 'keep'}});
assert.equal((await refreshClaudeProviderDisplay(oauth)).activeKey, '');
assert.equal((await refreshClaudeProviderDisplay(oauth)).profiles.some(p => p.key === CLAUDE_OFFICIAL_KEY), false);
const blocked = await switchActiveProvider(CLAUDE_OFFICIAL_KEY, oauth);
assert(blocked.ok && blocked.warning?.includes('apiKeyHelper'), 'hidden official must preserve effective status reason');
assert.equal(read(settings).apiKeyHelper, 'keep');
seed(settings, {env: {UNRELATED: 'keep'}});
assert.equal((await switchActiveProvider(CLAUDE_OFFICIAL_KEY, missing)).ok, true);
const warned = await switchActiveProvider(CLAUDE_OFFICIAL_KEY, missing);
assert(warned.ok && warned.warning?.includes('claude auth login'));

for (const credentials of [true, false]) {
	const oauthEnv = Object.fromEntries(CLAUDE_OAUTH_ENV_KEYS.map(key => [key, 'LOCAL-OAUTH-SENTINEL']));
	seed(profilePath, {env: {...env, ...oauthEnv}, unknown: 'keep'});
	seed(settings, {env: {...env, ...oauthEnv, UNRELATED: 'keep'}, unknown: 'keep'});
	const providerSnapshot = snapshotClaudeProvidersSection({includeCredentials: credentials});
	const settingsSnapshot = snapshotSettingsSection('cc', {includeCredentials: credentials});
	assert(providerSnapshot.ok && settingsSnapshot.ok);
	assert(!JSON.stringify(providerSnapshot).includes('LOCAL-OAUTH-SENTINEL'));
	assert(!JSON.stringify(settingsSnapshot).includes('LOCAL-OAUTH-SENTINEL'));
	assert(!JSON.stringify(providerSnapshot).includes('@official'));
	const incoming = Object.fromEntries(CLAUDE_OAUTH_ENV_KEYS.map(key => [key, 'INCOMING-OAUTH-SENTINEL']));
	assert(
		importClaudeProvidersSection(
			{profiles: [{key: 'official', profile: {env: {...env, ...incoming}}}], settingsEnv: incoming},
			{containsCredentials: credentials}
		).ok
	);
	assert(importSettingsSection('cc', {text: JSON.stringify({env: {...incoming, NEW: 'ok'}})}, {containsCredentials: credentials}).ok);
	for (const key of CLAUDE_OAUTH_ENV_KEYS) {
		assert.equal(read(settings).env[key], 'LOCAL-OAUTH-SENTINEL');
		assert.equal(read(profilePath).env[key], 'LOCAL-OAUTH-SENTINEL');
	}
	assert.equal(read(settings).env.UNRELATED, 'keep');
	assert.equal(read(settings).env.NEW, 'ok');
	assert.equal(read(profilePath).unknown, 'keep');
	assert(!readFileSync(settings, 'utf8').includes('INCOMING-OAUTH-SENTINEL'));
	const exported = await planConfigTransferExport({
		categories: [
			{tool: 'cc', category: 'providers'},
			{tool: 'cc', category: 'settings'}
		],
		includeCredentials: credentials
	});
	assert(exported.ok);
	assert(!JSON.stringify(exported.data.sections).includes('LOCAL-OAUTH-SENTINEL'));
	const payload = createBundlePayload({
		sections: [
			{
				tool: 'cc',
				category: 'providers',
				data: {profiles: [{key: 'official', profile: {env: {...env, ...incoming}}}], settingsEnv: incoming}
			},
			{tool: 'cc', category: 'settings', data: {text: JSON.stringify({env: {...incoming, PLANNER: 'keep'}})}}
		],
		containsCredentials: credentials,
		version: 'test',
		platform: process.platform
	});
	assert(payload.ok);
	const settingsBeforePreview = readFileSync(settings, 'utf8');
	const profileBeforePreview = readFileSync(profilePath, 'utf8');
	const preview = await planConfigTransferImport(payload.data);
	assert(preview.ok);
	assert.equal(readFileSync(settings, 'utf8'), settingsBeforePreview);
	assert.equal(readFileSync(profilePath, 'utf8'), profileBeforePreview);
	const applied = await applyConfigTransferImport(payload.data, preview.data);
	assert(applied.ok && applied.data.status === 'complete', JSON.stringify(applied));
	assert.equal(read(settings).env.PLANNER, 'keep');
	for (const key of CLAUDE_OAUTH_ENV_KEYS) {
		assert.equal(read(settings).env[key], 'LOCAL-OAUTH-SENTINEL');
		assert.equal(read(profilePath).env[key], 'LOCAL-OAUTH-SENTINEL');
	}
}
seed(profilePath, {env});
seed(settings, {env: {UNRELATED: 'keep'}});
const added = addProvider({profileKey: 'crud', baseUrl: 'https://crud.test', apiKey: 'TEST-CRUD'});
assert(added.success);
assert(editProvider('crud', {apiKey: 'TEST-EDIT'}).success);
assert(deleteProvider('crud').success);
assert.deepEqual(read(settings).env, {UNRELATED: 'keep'});
const before = readFileSync(settings, 'utf8');
const lines: string[] = [];
const errors: string[] = [];
const log = console.log;
const error = console.error;
console.log = (...args) => {
	lines.push(args.join(' '));
};
console.error = (...args) => {
	errors.push(args.join(' '));
};
try {
	assert.equal(await runLs('claude', oauth), 0);
	assert.equal(readFileSync(settings, 'utf8'), before);
	assert.deepEqual(read(profilePath), {env});
	assert(lines.some(line => line.includes('* @official') && line.includes('官方账号 · 已授权登录')));
	for (const options of [missing, {exec: fake('third_party', 0)}, {exec: async () => ({code: 0, stdout: '{bad', stderr: ''})}]) {
		lines.length = 0;
		assert.equal(await runLs('claude', options), 0);
		assert(!lines.some(line => line.includes('@official')));
		assert(!lines.some(line => line.includes('已授权登录')));
		assert.equal(readFileSync(settings, 'utf8'), before);
	}
	assert.equal(await runUse('official', 'claude', oauth), 0);
	assert.equal(getDisplayData().activeKey, 'official');
	assert.equal(await runUse(CLAUDE_OFFICIAL_KEY, 'claude', missing), 0);
	assert(errors.some(line => line.includes('claude auth login')));
	assert.deepEqual(read(settings).env, {UNRELATED: 'keep'});
	const cliReadOnlyBytes = readFileSync(settings, 'utf8');
	for (const legacy of ['{}', '{bad']) {
		writeFileSync(profilePath, legacy);
		assert.equal(await runLs('claude', oauth), 0);
		assert.equal(readFileSync(profilePath, 'utf8'), legacy);
		if (legacy === '{bad') assert.equal(await runUse(CLAUDE_OFFICIAL_KEY, 'claude', oauth), 1);
		assert.equal(readFileSync(settings, 'utf8'), cliReadOnlyBytes);
	}
	rmSync(profilePath);
	lines.length = 0;
	assert.equal(await runLs('claude', oauth), 0);
	assert(lines.some(line => line.includes('* @official')));
	assert.equal(readFileSync(settings, 'utf8'), cliReadOnlyBytes);
	lines.length = 0;
	assert.equal(await runLs('claude', missing), 0);
	assert(lines.includes('当前没有任何供应商。'));
	assert.equal(await runUse(CLAUDE_OFFICIAL_KEY, 'claude', {exec: fake('third_party', 0)}), 0);
	assert(errors.some(line => line.includes('当前认证不是已确认的官方账号 OAuth')));

	const codexDir = join(home, '.codex');
	mkdirSync(codexDir, {recursive: true});
	const authPath = join(codexDir, 'auth.json');
	assert(!isCodexOfficialLoggedIn());
	assert.deepEqual(scanCodexProfiles().profiles, []);
	assert.equal(loadCodexProviderDisplay().hasProviders, false);
	lines.length = 0;
	assert.equal(await runLs('codex'), 0);
	assert(lines.includes('当前没有任何供应商。'));
	assert(!existsSync(join(codexDir, 'config.toml')));
	assert.equal(await runUse('official', 'codex'), 0, 'hidden selector remains usable');
	assert(errors.some(line => line.includes('官方身份尚未确认') && line.includes('codex login')));
	assert(!loadCodexProviderDisplay().hasProviders);
	const config = join(codexDir, 'config.toml');
	writeFileSync(config, 'approval_policy = "on-request"\n');
	saveCodexProfile({key: 'test', providerType: 'apiKey', baseUrl: 'https://codex.test', apiKey: 'FAKE-KEY'});
	setDefaultCodexProfile('test');
	assert.deepEqual(scanCodexProfiles().profiles.map(p => p.key), ['test']);
	const cx = createProviderViewAdapter('cx');
	seed(authPath, {}); // Existing criterion checks existence only; fixture is not a token.
	const authBytes = readFileSync(authPath, 'utf8');
	assert(isCodexOfficialLoggedIn());
	const cxDisplay = loadCodexProviderDisplay();
	const cxOfficial = cxDisplay.profiles.find(p => p.key === 'official')!;
	assert.equal(cxOfficial.displayName, '官方账号');
	assert.equal(cxOfficial.authKind, 'oauth');
	assert.equal(cxOfficial.authStatus, 'configured');
	assert.equal(cxOfficial.isActive, false);
	assert.equal(cxOfficial.canEdit, false);
	assert.equal(cxOfficial.canDelete, false);
	assert.equal(cxOfficial.canSwitch, true);
	assert.equal(cxOfficial.baseUrl + cxOfficial.authToken + cxOfficial.maskedApiKey + cxOfficial.profilePath, '');
	assert(cx.isOfficial(cxOfficial));
	assert.equal(cx.toHomeRow(cxOfficial).title, adapter.toHomeRow(official).title);
	assert.equal(cx.toHomeRow(cxOfficial).summary, adapter.toHomeRow(official).summary);
	const legacyPath = join(codexDir, 'official.config.toml');
	writeFileSync(legacyPath, 'legacy-sentinel');
	const cxConfigBytes = readFileSync(config, 'utf8');
	lines.length = 0;
	assert.equal(await runLs('codex'), 0);
	assert(lines.some(line => line.includes('official') && line.includes('官方账号 · 已授权登录')));
	assert(!lines.some(line => line.includes('(official/default)')));
	assert.equal(readFileSync(config, 'utf8'), cxConfigBytes);
	assert.equal(readFileSync(legacyPath, 'utf8'), 'legacy-sentinel', 'CLI must not run migration');
	assert.equal(readFileSync(authPath, 'utf8'), authBytes);
	assert.equal(removeCodexProvider('official').ok, false);
	assert.equal(await runUse('official', 'codex'), 0);
	assert.equal(loadCodexProviderDisplay().activeKey, 'official');
	assert.equal(await runUse('test', 'codex'), 0);
	assert.equal(loadCodexProviderDisplay().activeKey, 'test');
	assert(readFileSync(config, 'utf8').includes('approval_policy'));
	rmSync(authPath);
	assert.equal(cx.toHomeRow(cxOfficial).summary, '已授权登录', 'row uses captured auth snapshot, not disk');
	assert.deepEqual(scanCodexProfiles().profiles.map(p => p.key), ['test']);
	const cxWarning = switchActiveCodexProvider('official');
	assert(cxWarning.ok && cxWarning.warning?.includes('codex login'));
	assert.equal(loadCodexProviderDisplay().activeKey, '');
	assert.equal(loadCodexProviderDisplay().profiles.some(p => p.key === 'official'), false);
} finally {
	console.log = log;
	console.error = error;
}
console.log('Claude official isolated probe passed');
