import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Provider TUI 视图层不变量门禁（tasks 5.7 / 5.8）：
// - 5.7 字段所有权：add/edit/switch 后 settings.json 只改受管 env 键，
//   绝不触碰 model / language / permissions / hooks / statusLine / mcpServers。
// - 5.8 幂等性：相同 payload 重复保存，最终 provider profile 与 active settings 等价。
//
// 用 CCQ_HOME 把 ~/.claude 隔离到临时目录，跑真实 core（provider.ts）。
// 同时用独立锁文件避免污染真实 ~/.tmp。

const home = mkdtempSync(join(tmpdir(), 'ccq-provider-tui-'));
process.env.CCQ_HOME = home;
const claudeDir = join(home, '.claude');
const providersDir = join(claudeDir, 'providers');
const settingsPath = join(claudeDir, 'settings.json');
mkdirSync(providersDir, {recursive: true});

// 预置一份含「用户私有字段」的 settings.json，验证字段所有权保护。
const USER_OWNED = {
	model: 'claude-opus-4-8',
	language: 'zh-CN',
	permissions: {allow: ['Read', 'Edit'], deny: []},
	hooks: {PreToolUse: [{matcher: 'Bash', hooks: []}]},
	statusLine: {type: 'command', command: 'echo hi'},
	mcpServers: {context7: {command: 'npx', args: ['-y', '@upstash/context7-mcp']}}
};
writeFileSync(settingsPath, JSON.stringify({...USER_OWNED, env: {EXISTING: 'keep-me'}}, null, 2), 'utf8');

const {addProvider, editProvider, switchProvider, getDisplayData} = await import('../src/core/provider.ts');
const {
	loadCodexProviderDisplay,
	saveCodexProviderForm,
	switchActiveCodexProvider,
	removeCodexProvider,
	buildCodexForm,
	codexProviderFormAdapter,
	loadCodexProviderProfile
} = await import('../src/services/codex-service.ts');

const providerViewSource = readFileSync(new URL('../src/views/provider/ProviderView.tsx', import.meta.url), 'utf8');
const providerAdapterSource = readFileSync(new URL('../src/views/provider/provider-view-adapter.ts', import.meta.url), 'utf8');
assert.match(providerViewSource, /agentContext:\s*AgentContext/, 'ProviderView props 必须接收 agentContext');
assert.match(providerViewSource, /createProviderViewAdapter\(agentContext\)/, 'ProviderView 必须由 agentContext 构造领域 adapter');
assert.match(providerAdapterSource, /const isCodex = agentContext === 'cx'/, 'Provider adapter 必须由 agentContext 切换 Codex 模式');
assert.match(providerAdapterSource, /loadDisplay: isCodex \? loadCodexProviderDisplay : loadProviderDisplay/, 'Provider adapter 列表必须按 agentContext 切换数据源');
assert.match(providerViewSource, /setScreen\(\{kind: 'list'\}\);\r?\n\t\}, \[adapter\]\);/, '切换 agentContext 时必须重置列表屏，避免表单脏状态写入错误目标');
assert.match(providerViewSource, /adapter=\{codexProviderFormAdapter\}/, 'Codex Provider 表单必须保留真实 TOML textarea adapter');
assert.match(providerViewSource, /save=\{saveCodexProviderForm\}/, 'Codex Provider 新增必须走 Codex service/core，不得复用 Claude provider');
assert.match(providerAdapterSource, /switchActive: isCodex \? switchActiveCodexProvider : switchActiveProvider/, '设置默认必须按 agentContext 路由');
assert.match(providerAdapterSource, /remove: isCodex \? removeCodexProvider : removeProvider/, '删除必须按 agentContext 路由');
console.log('[PASS] 6.10 ProviderView agentContext 切换 + Codex profile 表单源码不变量');

function readSettings() {
	return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function assertUserFieldsIntact(label) {
	const s = readSettings();
	assert.deepEqual(s.model, USER_OWNED.model, `${label}: model 被改动`);
	assert.deepEqual(s.language, USER_OWNED.language, `${label}: language 被改动`);
	assert.deepEqual(s.permissions, USER_OWNED.permissions, `${label}: permissions 被改动`);
	assert.deepEqual(s.hooks, USER_OWNED.hooks, `${label}: hooks 被改动`);
	assert.deepEqual(s.statusLine, USER_OWNED.statusLine, `${label}: statusLine 被改动`);
	assert.deepEqual(s.mcpServers, USER_OWNED.mcpServers, `${label}: mcpServers 被改动`);
}

// ── 5.7 字段所有权：add（含激活） ───────────────────────────────────────────
const addResult = addProvider({
	builtinKey: 'glm',
	apiKey: 'sk-glm-aaaaaaaaaaaa',
	activate: true
});
assert.equal(addResult.success, true, 'addProvider 应成功');
assert.equal(addResult.activated, true, 'addProvider 激活应成功');
assertUserFieldsIntact('add+activate');

let settings = readSettings();
assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-glm-aaaaaaaaaaaa', 'AUTH_TOKEN 应写入');
assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic', 'BASE_URL 应写入');
assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2', '受管模型键应写入');
assert.equal(settings.env.EXISTING, 'keep-me', '已有非受管 env 键应保留');
console.log('[PASS] 5.7 add+activate 字段所有权');

// ── 5.7 字段所有权：switch ───────────────────────────────────────────────────
const addCustom = addProvider({
	baseUrl: 'https://api.custom.test/anthropic',
	name: '自定义测试',
	apiKey: 'sk-custom-bbbbbbbbbbbb',
	activate: false
});
assert.equal(addCustom.success, true, 'addProvider custom 应成功');

const switchResult = switchProvider(addCustom.key);
assert.equal(switchResult.success, true, 'switchProvider 应成功');
assertUserFieldsIntact('switch');
settings = readSettings();
assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://api.custom.test/anthropic', 'switch 后 BASE_URL 应更新');
// 自定义供应商无模型配置 → 受管模型键应被清理
assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, 'switch 到无模型供应商应清理受管模型键');
console.log('[PASS] 5.7 switch 字段所有权');

// ── 5.7 字段所有权：edit ─────────────────────────────────────────────────────
const editResult = editProvider(addResult.key, {apiKey: 'sk-glm-cccccccccccc'});
assert.equal(editResult.success, true, 'editProvider 应成功');
assertUserFieldsIntact('edit');
console.log('[PASS] 5.7 edit 字段所有权');

// ── 5.8 幂等性：相同 add payload 重复保存（overwrite）最终态等价 ─────────────
const idemHome = mkdtempSync(join(tmpdir(), 'ccq-provider-idem-'));
process.env.CCQ_HOME = idemHome;
mkdirSync(join(idemHome, '.claude', 'providers'), {recursive: true});
const idemSettings = join(idemHome, '.claude', 'settings.json');
writeFileSync(idemSettings, JSON.stringify({env: {}}, null, 2), 'utf8');

// 重置契约缓存不需要（同一份 contracts）；provider.ts 内 paths 实时读 CCQ_HOME。
const payload = {
	builtinKey: 'deepseek',
	apiKey: 'sk-deepseek-dddddddddddd',
	activate: true,
	conflictStrategy: 'overwrite'
};

addProvider({...payload});
const after1 = snapshot(idemHome);
addProvider({...payload});
const after2 = snapshot(idemHome);

assert.deepEqual(after2.settingsEnv, after1.settingsEnv, '5.8: 重复 add 后 settings.env 应等价');
assert.deepEqual(after2.activeKey, after1.activeKey, '5.8: 重复 add 后 activeKey 应等价');
assert.deepEqual(after2.profile, after1.profile, '5.8: 重复 add 后 profile 内容应等价');
console.log('[PASS] 5.8 add 幂等性');

// ── 5.8 幂等性：相同 edit payload 重复保存最终态等价 ─────────────────────────
const editPayload = {apiKey: 'sk-deepseek-eeeeeeeeeeee', baseUrl: 'https://api.deepseek.com/anthropic'};
const editKey = getDisplayData().profiles[0].key;
editProvider(editKey, {...editPayload});
const edit1 = snapshot(idemHome);
editProvider(editKey, {...editPayload});
const edit2 = snapshot(idemHome);
assert.deepEqual(edit2.settingsEnv, edit1.settingsEnv, '5.8: 重复 edit 后 settings.env 应等价');
assert.deepEqual(edit2.profile, edit1.profile, '5.8: 重复 edit 后 profile 应等价');
console.log('[PASS] 5.8 edit 幂等性');

// ── 6.1/6.2/6.3 Codex Provider service：路径隔离 + TOML 表单 adapter ─────────────
const codexHome = mkdtempSync(join(tmpdir(), 'ccq-provider-codex-'));
process.env.CCQ_HOME = codexHome;
process.env.CODEX_HOME = join(codexHome, '.codex');
const codexClaudeDir = join(codexHome, '.claude');
const codexSettingsPath = join(codexClaudeDir, 'settings.json');
mkdirSync(process.env.CODEX_HOME, {recursive: true});
mkdirSync(codexClaudeDir, {recursive: true});
writeFileSync(codexSettingsPath, JSON.stringify({...USER_OWNED, env: {ANTHROPIC_AUTH_TOKEN: 'sk-keep-claude'}}, null, 2), 'utf8');

let codexDisplay = loadCodexProviderDisplay();
// official login 虚拟条目恒定存在（不落盘）；初始无真实 profile → 仅这一个虚拟条目，且不读 Claude provider。
assert.equal(codexDisplay.profiles.length, 1, 'Codex 初始仅含 official login 虚拟条目');
assert.equal(codexDisplay.profiles[0].key, 'official', 'Codex 初始条目为 official 虚拟条目');
assert.equal(codexDisplay.profiles.some(p => p.authToken === 'sk-keep-claude'), false, 'Codex 不读取 Claude provider token');

const codexModel = buildCodexForm({mode: 'add', providerType: 'custom'});
const codexValues = {
	...codexModel.values,
	profileKey: 'deepseek',
	providerType: 'custom',
	baseUrl: 'https://api.deepseek.com',
	model: 'deepseek-chat',
	apiKey: 'sk-codex-secret-never-log',
	activateAfterSave: true
};
const toml = codexProviderFormAdapter.buildText(codexValues);
assert.match(toml, /experimental_bearer_token\s*=\s*"sk-codex-secret-never-log"/, 'Codex adapter 生成真实 TOML');
const parsed = codexProviderFormAdapter.parseText(codexValues, toml);
assert.equal(parsed.ok, true, 'Codex adapter 可从 TOML 回填字段');
const preservedValues = codexProviderFormAdapter.recordToValues(
	{...codexProviderFormAdapter.valuesToRecord({...codexValues, toml}), model: 'deepseek-reasoner', apiKey: ''},
	{...codexValues, toml: `${toml}\napproval_policy = "on-request"\n`}
);
assert.match(preservedValues.toml, /experimental_bearer_token\s*=\s*"sk-codex-secret-never-log"/, '字段变化且 API Key 留空时必须保留 textarea 既有 token');
assert.match(preservedValues.toml, /approval_policy\s*=\s*"on-request"/, '字段变化必须保留 textarea 未知字段');
assert.match(preservedValues.toml, /model\s*=\s*"deepseek-reasoner"/, '字段变化应定点更新 model');

// 文件名逐字符输入（1 → 12）时，旧 model_providers.<旧key> 不得残留累加（Codex key = 唯一身份）。
const keyStepValues = codexProviderFormAdapter.recordToValues(
	{...codexProviderFormAdapter.valuesToRecord(codexValues), profileKey: '12'},
	{...codexValues, toml: 'model_provider = "1"\n\n[model_providers.1]\nname = "1"\n'}
);
assert.equal(/\[model_providers\.1\]/.test(keyStepValues.toml), false, '文件名变化后旧 model_providers.<旧key> table 必须清除');
assert.match(keyStepValues.toml, /\[model_providers\.12\]/, '文件名变化后只保留当前 key 的 provider table');
assert.match(keyStepValues.toml, /model_provider\s*=\s*"12"/, 'model_provider 应指向当前 key');

const saved = saveCodexProviderForm({mode: 'add', providerType: 'custom'}, codexValues);
assert.equal(saved.ok, true, 'Codex profile 保存应成功');
assert.equal(existsSync(join(process.env.CODEX_HOME, 'deepseek.config.toml')), true, 'Codex profile 写入 CODEX_HOME/<key>.config.toml');
assert.equal(existsSync(join(codexHome, '.claude', 'providers', 'deepseek.json')), false, 'Codex profile 不写 Claude providers');

codexDisplay = loadCodexProviderDisplay();
// deepseek 真实 profile + official 虚拟条目 = 2 条；真实 profile 排在虚拟条目前。
assert.equal(codexDisplay.profiles.length, 2, 'Codex display 列出真实 profile + official 虚拟条目');
assert.equal(codexDisplay.profiles[0].key, 'deepseek', 'Codex display 使用 key 作为身份');
assert.equal(codexDisplay.profiles[0].isActive, true, 'activateAfterSave 设置默认 Codex profile');
assert.equal(codexDisplay.profiles.some(p => p.key === 'official'), true, 'official 虚拟条目恒定在列');
assert.equal(JSON.parse(readFileSync(codexSettingsPath, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'sk-keep-claude', 'Codex service 不改 Claude settings');

// official login 是虚拟条目：保存不落盘，activateAfterSave=false 时纯 no-op（仅返回虚拟形态）。
const official = saveCodexProviderForm({mode: 'add', providerType: 'officialLogin'}, {
	...buildCodexForm({mode: 'add', providerType: 'officialLogin'}).values,
	activateAfterSave: false
});
assert.equal(official.ok, true, 'official login 保存成功（虚拟条目，不落盘）');
assert.equal(official.ok ? official.data.key : '', 'official', 'official login 返回 sentinel key');
assert.equal(existsSync(join(process.env.CODEX_HOME, 'official.config.toml')), false, 'official login 保存不落盘 profile 文件');
// 结构性单例：无需重复守卫，再次保存幂等成功（不再产生 official2 之类真实文件）。
const officialAgain = saveCodexProviderForm({mode: 'add', providerType: 'officialLogin'}, {
	...buildCodexForm({mode: 'add', providerType: 'officialLogin'}).values,
	activateAfterSave: false
});
assert.equal(officialAgain.ok, true, 'official login 再次保存幂等成功（结构性单例，无重复守卫）');
writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), '{"access_token":"secret"}', 'utf8');
const switched = switchActiveCodexProvider('official');
assert.equal(switched.ok, true, 'Codex official-login set default 应成功');
assert.equal(loadCodexProviderDisplay().activeKey, 'official', 'official 激活后 display 标记 official 为默认（盲区根治）');
const switchBack = switchActiveCodexProvider('deepseek');
assert.equal(switchBack.ok, true, 'Codex API-key set default 应成功');
assert.equal(loadCodexProviderDisplay().activeKey, 'deepseek', 'Codex display 标记 API-key 默认 profile');
const remove = removeCodexProvider('official');
assert.equal(remove.ok, true, 'official 虚拟条目删除 = 登出，返回成功');
assert.equal(existsSync(join(process.env.CODEX_HOME, 'auth.json')), false, '删除 official 虚拟条目应清空 auth.json（登出）');
console.log('[PASS] 6.1/6.2/6.3 Codex Provider service 路径隔离 + TOML adapter + official 虚拟条目激活/登出');

// ── 编辑活跃 profile 必须同步 config.toml（否则子文件已改、config.toml 停留旧值）──
const syncBase = buildCodexForm({mode: 'add', providerType: 'custom'});
const syncAdd = saveCodexProviderForm({mode: 'add', providerType: 'custom'}, {
	...syncBase.values,
	profileKey: 'synctest',
	providerType: 'custom',
	baseUrl: 'https://api.sync.example.com',
	model: 'model-old',
	apiKey: 'sk-sync-token',
	activateAfterSave: true
});
assert.equal(syncAdd.ok, true, 'synctest profile 新增并激活应成功');
const configPath = join(process.env.CODEX_HOME, 'config.toml');
assert.match(readFileSync(configPath, 'utf8'), /model\s*=\s*"model-old"/, '激活后 config.toml 写入初始 model');

// 编辑活跃 profile 的 model → 子文件与 config.toml 都应更新为新值。
// rawToml 必传（含 bearer token），与视图层 readCodexProfileToml 调用方式一致。
const syncRawToml = readFileSync(join(process.env.CODEX_HOME, 'synctest.config.toml'), 'utf8');
const syncEditModel = buildCodexForm({mode: 'edit', profileKey: 'synctest', profile: loadCodexProviderProfile(join(process.env.CODEX_HOME, 'synctest.config.toml')), rawToml: syncRawToml});
const editedToml = syncEditModel.values.toml.replace(/model-old/g, 'model-new');
const syncEdit = saveCodexProviderForm(
	{mode: 'edit', profileKey: 'synctest', providerType: 'custom'},
	{...syncEditModel.values, model: 'model-new', toml: editedToml}
);
assert.equal(syncEdit.ok, true, '编辑活跃 profile 应成功');
assert.match(readFileSync(join(process.env.CODEX_HOME, 'synctest.config.toml'), 'utf8'), /model\s*=\s*"model-new"/, '子文件 model 已更新');
assert.match(readFileSync(configPath, 'utf8'), /model\s*=\s*"model-new"/, '编辑活跃 profile 必须同步刷新 config.toml 的 model');
assert.equal(/model-old/.test(readFileSync(configPath, 'utf8')), false, 'config.toml 不得残留旧 model 值');

// 编辑非活跃 profile 不应触碰 config.toml（仍指向活跃 provider）。
const inactiveAdd = saveCodexProviderForm({mode: 'add', providerType: 'custom'}, {
	...syncBase.values,
	profileKey: 'inactive',
	providerType: 'custom',
	baseUrl: 'https://api.inactive.example.com',
	model: 'inactive-model',
	apiKey: 'sk-inactive-token',
	activateAfterSave: false
});
assert.equal(inactiveAdd.ok, true, 'inactive profile 新增（不激活）应成功');
const inactiveRawToml = readFileSync(join(process.env.CODEX_HOME, 'inactive.config.toml'), 'utf8');
const inactiveEditModel = buildCodexForm({mode: 'edit', profileKey: 'inactive', profile: loadCodexProviderProfile(join(process.env.CODEX_HOME, 'inactive.config.toml')), rawToml: inactiveRawToml});
saveCodexProviderForm(
	{mode: 'edit', profileKey: 'inactive', providerType: 'custom'},
	{...inactiveEditModel.values, model: 'inactive-changed', toml: inactiveEditModel.values.toml.replace(/inactive-model/g, 'inactive-changed')}
);
assert.match(readFileSync(configPath, 'utf8'), /model\s*=\s*"model-new"/, '编辑非活跃 profile 不改 config.toml（仍指向活跃 synctest）');
assert.equal(/inactive-changed/.test(readFileSync(configPath, 'utf8')), false, 'config.toml 不得被非活跃 profile 编辑污染');
console.log('[PASS] 6.1b 编辑活跃 Codex profile 同步 config.toml（非活跃不污染）');

delete process.env.CODEX_HOME;

// 清理临时目录
rmSync(home, {recursive: true, force: true});
rmSync(idemHome, {recursive: true, force: true});
rmSync(codexHome, {recursive: true, force: true});

console.log('[PASS] Provider TUI 视图层不变量门禁通过（字段所有权 + 幂等性）');

// ── 工具 ──────────────────────────────────────────────────────────────────────

function snapshot(homeDir) {
	const settingsFile = join(homeDir, '.claude', 'settings.json');
	const s = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
	const data = getDisplayData();
	const activeProfile = data.profiles.find(p => p.isActive) ?? data.profiles[0];
	const profile = activeProfile ? JSON.parse(readFileSync(activeProfile.profilePath, 'utf8')) : null;
	return {settingsEnv: s.env ?? {}, activeKey: data.activeKey, profile};
}
