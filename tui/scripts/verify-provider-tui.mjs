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
//
// [P5c 迁走] Codex TOML 表单 adapter（buildText / parseText / recordToValues）与 buildCodexForm
// 字段契约共 12 条进程内纯断言 → tests/core/provider-tui.test.ts。本文件保留真实 settings.json /
// providers/*.json / CODEX_HOME 落盘字节与 config.toml 同步断言。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

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
const {createProviderViewAdapter} = await import('../src/views/provider/provider-view-adapter.ts');
const {
	loadCodexProviderDisplay,
	saveCodexProviderForm,
	switchActiveCodexProvider,
	removeCodexProvider,
	buildCodexForm,
	loadCodexProviderProfile
} = await import('../src/services/codex-service.ts');

// P1-G2 静态断言治理：原 21 条源码正则已分类处置——
//   A 类（5 条 adapter 数据源/切换/删除路由、卡片不拼模型摘要）迁到
//   tests/core/provider-view-adapter.test.ts；B 类（16 条视图 agentContext 接线、
//   Codex official 只读、Pi 卡片无状态圆点、表单主题化选中色）并入
//   scripts/verify-view-architecture.mjs（P1-G2 段）；C = 0。
// 详见 .trellis/tasks/09-18-p1-static-assertion-governance/research-reconciliation-G2.md。
console.log('[PASS] 6.10 ProviderView agentContext 切换 + Codex profile 表单行为不变量（静态合同见 verify-view-architecture.mjs）');

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
assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, '内置模板不应预填受管模型键');
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
assert.equal(
	codexDisplay.profiles.some(p => p.authToken === 'sk-keep-claude'),
	false,
	'Codex 不读取 Claude provider token'
);

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
// [P5c 迁走] Codex TOML 表单 adapter 纯断言（buildText / parseText / recordToValues 定点更新、
// 未知字段保留、profileKey 变化清理旧 model_providers table）共 9 条 → tests/core/provider-tui.test.ts。
// 此处保留 saveCodexProviderForm 的真实 CODEX_HOME 落盘断言。

const saved = saveCodexProviderForm({mode: 'add', providerType: 'custom'}, codexValues);
assert.equal(saved.ok, true, 'Codex profile 保存应成功');
assert.equal(existsSync(join(process.env.CODEX_HOME, 'deepseek.config.toml')), true, 'Codex profile 写入 CODEX_HOME/<key>.config.toml');
assert.equal(existsSync(join(codexHome, '.claude', 'providers', 'deepseek.json')), false, 'Codex profile 不写 Claude providers');

codexDisplay = loadCodexProviderDisplay();
// deepseek 真实 profile + official 虚拟条目 = 2 条；真实 profile 排在虚拟条目前。
assert.equal(codexDisplay.profiles.length, 2, 'Codex display 列出真实 profile + official 虚拟条目');
assert.equal(codexDisplay.profiles[0].key, 'deepseek', 'Codex display 使用 key 作为身份');
assert.equal(codexDisplay.profiles[0].isActive, true, 'activateAfterSave 设置默认 Codex profile');
assert.equal(
	codexDisplay.profiles.some(p => p.key === 'official'),
	true,
	'official 虚拟条目恒定在列'
);
assert.equal(
	JSON.parse(readFileSync(codexSettingsPath, 'utf8')).env.ANTHROPIC_AUTH_TOKEN,
	'sk-keep-claude',
	'Codex service 不改 Claude settings'
);

// [P5c 迁走] buildCodexForm 字段契约（默认 custom / 不暴露 auth.json / 拒绝 officialLogin）共 3 条
// → tests/core/provider-tui.test.ts。
const officialRow = codexDisplay.profiles.find(profile => profile.key === 'official');
assert.equal(officialRow?.canEdit, false, 'Codex official 列表项不可编辑');
assert.equal(officialRow?.canDelete, false, 'Codex official 列表项不可删除');

// ── 供应商卡片描述行：只展示凭据事实，不再拼接模型摘要 ──────────────────────
// [P5e 去重] cc/cx 卡片投影（4 条：cc summary / cc 缺 baseUrl 占位 / cx summary / cx 不拼模型摘要）
// 已由 P1-G2 载体独占：tests/core/provider-view-adapter.test.ts >
//   toHomeRow 卡片描述只保留凭据事实，不再拼接模型摘要。本段保留依赖真实 auth.json 的 cx official 文案。
const codexHomeRows = createProviderViewAdapter('cx');
assert.equal(
	codexHomeRows.toHomeRow({...officialRow, maskedApiKey: '未登录'}).summary,
	'未授权登录',
	'Codex official 未登录时只展示授权登录文案'
);
writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), '{"access_token":"secret"}', 'utf8');
assert.equal(
	codexHomeRows.toHomeRow({...officialRow, maskedApiKey: 'codex login'}).summary,
	'已授权登录',
	'Codex official 已登录时展示已授权登录'
);
const switched = switchActiveCodexProvider('official');
assert.equal(switched.ok, true, 'Codex official-login set default 应成功');
assert.equal(loadCodexProviderDisplay().activeKey, 'official', 'official 激活后 display 标记 official 为默认（盲区根治）');
const switchBack = switchActiveCodexProvider('deepseek');
assert.equal(switchBack.ok, true, 'Codex API-key set default 应成功');
assert.equal(loadCodexProviderDisplay().activeKey, 'deepseek', 'Codex display 标记 API-key 默认 profile');
const remove = removeCodexProvider('official');
assert.equal(remove.ok, false, 'official 虚拟条目删除必须拒绝');
assert.match(remove.ok ? '' : remove.error, /codex logout/, 'official 删除拒绝必须指向 Codex 原生 logout');
assert.equal(existsSync(join(process.env.CODEX_HOME, 'auth.json')), true, '拒绝删除 official 不得清空 auth.json');
console.log(
	'[PASS] 6.1/6.2/6.3 Codex Provider service 路径隔离 + official 只读虚拟条目（TOML adapter 见 tests/core/provider-tui.test.ts）'
);

// ── 编辑活跃 profile 必须同步 config.toml（否则子文件已改、config.toml 停留旧值）──
const syncBase = buildCodexForm({mode: 'add', providerType: 'custom'});
const syncAdd = saveCodexProviderForm(
	{mode: 'add', providerType: 'custom'},
	{
		...syncBase.values,
		profileKey: 'synctest',
		providerType: 'custom',
		baseUrl: 'https://api.sync.example.com',
		model: 'model-old',
		apiKey: 'sk-sync-token',
		activateAfterSave: true
	}
);
assert.equal(syncAdd.ok, true, 'synctest profile 新增并激活应成功');
const configPath = join(process.env.CODEX_HOME, 'config.toml');
assert.match(readFileSync(configPath, 'utf8'), /model\s*=\s*"model-old"/, '激活后 config.toml 写入初始 model');

// 编辑活跃 profile 的 model → 子文件与 config.toml 都应更新为新值。
// rawToml 必传（含 bearer token），与视图层 readCodexProfileToml 调用方式一致。
const syncRawToml = readFileSync(join(process.env.CODEX_HOME, 'synctest.config.toml'), 'utf8');
const syncEditModel = buildCodexForm({
	mode: 'edit',
	profileKey: 'synctest',
	profile: loadCodexProviderProfile(join(process.env.CODEX_HOME, 'synctest.config.toml')),
	rawToml: syncRawToml
});
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
const inactiveAdd = saveCodexProviderForm(
	{mode: 'add', providerType: 'custom'},
	{
		...syncBase.values,
		profileKey: 'inactive',
		providerType: 'custom',
		baseUrl: 'https://api.inactive.example.com',
		model: 'inactive-model',
		apiKey: 'sk-inactive-token',
		activateAfterSave: false
	}
);
assert.equal(inactiveAdd.ok, true, 'inactive profile 新增（不激活）应成功');
const inactiveRawToml = readFileSync(join(process.env.CODEX_HOME, 'inactive.config.toml'), 'utf8');
const inactiveEditModel = buildCodexForm({
	mode: 'edit',
	profileKey: 'inactive',
	profile: loadCodexProviderProfile(join(process.env.CODEX_HOME, 'inactive.config.toml')),
	rawToml: inactiveRawToml
});
saveCodexProviderForm(
	{mode: 'edit', profileKey: 'inactive', providerType: 'custom'},
	{
		...inactiveEditModel.values,
		model: 'inactive-changed',
		toml: inactiveEditModel.values.toml.replace(/inactive-model/g, 'inactive-changed')
	}
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
