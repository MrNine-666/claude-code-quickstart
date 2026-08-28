import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// task 8.3：设置默认（switch）门禁。覆盖：
// - 设置默认后 settings.env 仅含当前 profile 受管键
// - 不残留旧供应商 env
// - ClaudeConfig 非 provider env 保留（如 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE）
// - onboarding 标记首次新增时写入
// - 用户私有字段保护（model / permissions / ...）
//
// task 8.8（守卫）：主安装 steps.json / Registry.ps1 不含 ApiKey 步骤；
// provider profile 落盘路径为 ~/.claude/providers/<文件名>.json（claude --settings 目标）。

const home = mkdtempSync(join(tmpdir(), 'ccq-provider-switch-'));
process.env.CCQ_HOME = home;
const providersDir = join(home, '.claude', 'providers');
const settingsPath = join(home, '.claude', 'settings.json');
const claudeJsonPath = join(home, '.claude.json');
mkdirSync(providersDir, {recursive: true});

// 预置 settings：含 ClaudeConfig 非 provider env + 用户私有字段
const USER_OWNED = {model: 'claude-opus-4-8', permissions: {allow: ['Read'], deny: []}};
writeFileSync(settingsPath, JSON.stringify({...USER_OWNED, env: {CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80'}}, null, 2), 'utf8');

const {
	addProvider,
	deleteProvider,
	editProvider,
	getActiveProvider,
	getDisplayData,
	switchProvider
} = await import('../src/core/provider.ts');
const {runLs} = await import('../src/cli/commands/ls.ts');

function readSettings() {
	return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

function writeSettings(settings) {
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
}

function resetProviderFixture() {
	rmSync(providersDir, {recursive: true, force: true});
	mkdirSync(providersDir, {recursive: true});
	writeSettings({...USER_OWNED, env: {CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80'}});
}

function addCollisionProvider(key, {apiKey = 'same-token', baseUrl = 'https://same.test/anthropic', model, env = {}} = {}) {
	const result = addProvider({
		profileKey: key,
		name: key,
		baseUrl,
		apiKey,
		modelEnv: model === undefined ? {} : {ANTHROPIC_DEFAULT_OPUS_MODEL: model},
		env,
		activate: false,
		conflictStrategy: 'error'
	});
	assert.equal(result.success, true, `新增碰撞供应商 ${key} 应成功`);
	return result;
}

function assertSoleActive(key, message) {
	assert.equal(getActiveProvider()?.key, key, `${message}: getActiveProvider 应返回目标 key`);
	const display = getDisplayData();
	assert.equal(display.activeKey, key, `${message}: display.activeKey 应返回目标 key`);
	const activeRows = display.profiles.filter(profile => profile.isActive);
	assert.equal(activeRows.length, 1, `${message}: 应恰有一行 active`);
	assert.equal(activeRows[0]?.key, key, `${message}: active 行应为目标 key`);
}

function assertNoActive(message) {
	assert.equal(getActiveProvider(), null, `${message}: getActiveProvider 应返回 null`);
	const display = getDisplayData();
	assert.equal(display.activeKey, '', `${message}: display.activeKey 应为空`);
	assert.equal(display.profiles.some(profile => profile.isActive), false, `${message}: 不应标记任何 active 行`);
}

function assertClaudeLsHasNoActiveMarker(message) {
	const output = [];
	const previousLog = console.log;
	console.log = (...values) => output.push(values.join(' '));
	try {
		assert.equal(runLs('claude'), 0, `${message}: ccq ls 应成功返回`);
	} finally {
		console.log = previousLog;
	}

	assert.equal(output.some(line => /^ {2}\*/.test(line)), false, `${message}: ccq ls 不应显示 active 星号`);
}

// 新增 A（deepseek：模型键 + CLAUDE_CODE_EFFORT_LEVEL extra env）、B（moonshot：模型键 + 上下文窗口 extra env，无 EFFORT_LEVEL），均不激活
const a = addProvider({builtinKey: 'deepseek', apiKey: 'sk-ds-aaaaaaaa', activate: false});
assert.equal(a.success, true, '新增 A 应成功');
const b = addProvider({builtinKey: 'moonshot', apiKey: 'sk-kimi-bbbbbbbb', activate: false});
assert.equal(b.success, true, '新增 B 应成功');

// ── onboarding 标记首次新增时写入 ───────────────────────────────────────────
assert.ok(existsSync(claudeJsonPath), '首次新增应创建 ~/.claude.json');
assert.equal(JSON.parse(readFileSync(claudeJsonPath, 'utf8')).hasCompletedOnboarding, true, 'onboarding 标记应写入');
console.log('[PASS] 8.3 onboarding 标记首次新增时写入');

// ── 设置默认 A：模型键 + extra env + ClaudeConfig env 保留 ──────────────────
switchProvider(a.key);
let env = readSettings().env;
assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-ds-aaaaaaaa');
assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro', 'A 模型键写入');
assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max', 'A extra env 写入');
assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80', 'ClaudeConfig 非 provider env 保留');
console.log('[PASS] 8.3 设置默认 A：模型键 + extra env + ClaudeConfig env 保留');

// ── 设置默认 B：清理 A 独有 env、写入 B、ClaudeConfig 仍保留 ─────────────────
switchProvider(b.key);
env = readSettings().env;
assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-kimi-bbbbbbbb', '切到 B token');
assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.kimi.com/coding');
assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'k3[1m]', 'B 模型键写入');
assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576', 'B extra env 写入（K3 1M 上下文）');
assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576', 'B extra env 写入（K3 上下文上限）');
assert.equal('CLAUDE_CODE_EFFORT_LEVEL' in env, false, '不残留旧供应商 A 的 extra env');
assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80', '切换后 ClaudeConfig env 仍保留');
console.log('[PASS] 8.3 切换 B：不残留旧供应商 env + ClaudeConfig 保留');

// ── settings.env 仅含 B 受管键 + ClaudeConfig 键 ────────────────────────────
const allowed = new Set([
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL',
	'ANTHROPIC_DEFAULT_OPUS_MODEL',
	'ANTHROPIC_DEFAULT_SONNET_MODEL',
	'CLAUDE_CODE_EFFORT_LEVEL',
	'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
	'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
	'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
]);
for (const k of Object.keys(env)) {
	assert.ok(allowed.has(k), `settings.env 不应含意外键: ${k}`);
}
console.log('[PASS] 8.3 settings.env 仅当前 profile 受管键 + ClaudeConfig');

// ── 用户私有字段保护 ────────────────────────────────────────────────────────
const finalSettings = readSettings();
assert.deepEqual(finalSettings.model, USER_OWNED.model, 'model 不被改');
assert.deepEqual(finalSettings.permissions, USER_OWNED.permissions, 'permissions 不被改');
console.log('[PASS] 8.3 用户私有字段保护');

// ── task 8.8：provider profile 落盘路径 = ~/.claude/providers/<文件名>.json ──
const profilePathA = join(providersDir, `${a.key}.json`);
assert.ok(existsSync(profilePathA), 'profile 应落盘于 providers 目录');
assert.ok(/[/\\]\.claude[/\\]providers[/\\][^/\\]+\.json$/.test(profilePathA), 'claude --settings 目标路径形如 ~/.claude/providers/<文件名>.json');
console.log('[PASS] 8.8 provider profile 落盘路径符合 claude --settings 约定');

// ── task 8.8：主安装 steps.json 不含 ApiKey 步骤 ────────────────────────────
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const stepsJson = JSON.parse(readFileSync(join(repoRoot, 'installer', 'contracts', 'steps.json'), 'utf8'));
assert.ok(Array.isArray(stepsJson.Steps), 'steps.json 应有 Steps 数组');
assert.equal(stepsJson.Steps.some(s => s.StepId === 'ApiKey'), false, 'Steps 不得含 ApiKey 步骤');
for (const group of Object.values(stepsJson.Groups ?? {})) {
	assert.equal((group.StepIds ?? []).includes('ApiKey'), false, `分组 StepIds 不得含 ApiKey: ${group.Label}`);
}
console.log('[PASS] 8.8 steps.json 主安装不含 ApiKey 步骤');

// ── task 8.8：Registry.ps1 无 ApiKey 步骤注册 ───────────────────────────────
const registry = readFileSync(join(repoRoot, 'installer', 'windows', 'core', 'Registry.ps1'), 'utf8');
assert.equal(/["']ApiKey["']/.test(registry), false, 'Registry.ps1 不得注册 ApiKey 步骤');
console.log('[PASS] 8.8 Registry.ps1 无 ApiKey 步骤注册');

// ── active identity: 同 URL/Token 的完整 provider-owned env 投影 ────────────

// 模型映射不同：实际切换到 B 后，B 必须是唯一 active；无关用户 env 必须保留且不参与身份判定。
resetProviderFixture();
const collisionSettings = readSettings();
collisionSettings.env.USER_MANAGED_RUNTIME_FLAG = 'retain';
writeSettings(collisionSettings);
addCollisionProvider('mapping-a', {model: 'model-a'});
const mappingB = addCollisionProvider('mapping-b', {model: 'model-b'});
switchProvider(mappingB.key);
env = readSettings().env;
assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'model-b', '同 URL/Token 切换 B 应写入 B 的模型映射');
assert.equal(env.USER_MANAGED_RUNTIME_FLAG, 'retain', '切换不得删除无关用户 env');
assertSoleActive(mappingB.key, '同 URL/Token、不同模型映射');
console.log('[PASS] active identity 同 URL/Token、不同模型映射 + 无关 env 保留');

// extra env 不同也属于 provider-owned 投影，不能只比较 URL/Token/模型键。
resetProviderFixture();
addCollisionProvider('extra-a', {model: 'shared-model', env: {PROVIDER_ROUTE: 'a'}});
const extraB = addCollisionProvider('extra-b', {model: 'shared-model', env: {PROVIDER_ROUTE: 'b'}});
switchProvider(extraB.key);
assert.equal(readSettings().env.PROVIDER_ROUTE, 'b', '切换 B 应写入 B 的 extra env');
assertSoleActive(extraB.key, '同 URL/Token、不同 extra env');
console.log('[PASS] active identity 同 URL/Token、不同 extra env');

// 一个 profile 是另一个的 env 子集时，比较候选 owned-key 并集，两个方向都不可误匹配。
resetProviderFixture();
const subset = addCollisionProvider('subset', {model: 'shared-model', env: {PROVIDER_SCOPE: 'shared'}});
const superset = addCollisionProvider('superset', {
	model: 'shared-model',
	env: {PROVIDER_SCOPE: 'shared', PROVIDER_REGION: 'cn'}
});
switchProvider(subset.key);
assert.equal('PROVIDER_REGION' in readSettings().env, false, '切换子集应清理超集独有 env');
assertSoleActive(subset.key, '子集 profile');
switchProvider(superset.key);
assert.equal(readSettings().env.PROVIDER_REGION, 'cn', '切换超集应写入超集独有 env');
assertSoleActive(superset.key, '超集 profile');
console.log('[PASS] active identity 子集/超集 env 双向匹配');

// 完全相同的 runtime 投影没有可验证身份，必须保持 ambiguous，而非按目录顺序取首项。
resetProviderFixture();
const duplicateA = addCollisionProvider('duplicate-a', {model: 'same-model', env: {PROVIDER_MODE: 'same'}});
const duplicateB = addCollisionProvider('duplicate-b', {model: 'same-model', env: {PROVIDER_MODE: 'same'}});
switchProvider(duplicateB.key);
assertNoActive('完全相同 runtime 投影');
assertClaudeLsHasNoActiveMarker('完全相同 runtime 投影');
const settingsBeforeAmbiguousDelete = readFileSync(settingsPath, 'utf8');
const ambiguousDelete = deleteProvider(duplicateA.key);
assert.equal(ambiguousDelete.clearedSettings, false, '歧义 profile 删除不得猜测清理 settings');
assert.equal(readFileSync(settingsPath, 'utf8'), settingsBeforeAmbiguousDelete, '歧义删除不得改写 settings');
assertSoleActive(duplicateB.key, '删除一个完全相同 profile 后的剩余 profile');
console.log('[PASS] active identity 完全相同投影歧义 + 删除不清理 settings');

// 旧 settings 可缺失 provider-owned 字段；但任何已存在的冲突值都不能触发回退。
resetProviderFixture();
const legacy = addCollisionProvider('legacy', {apiKey: 'legacy-token', model: 'legacy-model', env: {PROVIDER_REGION: 'legacy'}});
writeSettings({
	...USER_OWNED,
	env: {
		ANTHROPIC_BASE_URL: 'https://same.test/anthropic/',
		CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80'
	}
});
assertSoleActive(legacy.key, '唯一旧式半配置');
writeSettings({
	...USER_OWNED,
	env: {
		ANTHROPIC_AUTH_TOKEN: 'legacy-token',
		ANTHROPIC_BASE_URL: 'https://same.test/anthropic',
		ANTHROPIC_DEFAULT_OPUS_MODEL: 'conflicting-model',
		CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80'
	}
});
assertNoActive('旧式半配置中的已存在冲突模型值');
console.log('[PASS] active identity 旧式缺失字段回退 + 已存在冲突拒绝回退');

// 旧式回退自身也必须唯一，不能在同 URL 的多个候选中按扫描顺序选择首项。
resetProviderFixture();
addCollisionProvider('legacy-ambiguous-a', {apiKey: 'legacy-token-a', model: 'legacy-model-a'});
addCollisionProvider('legacy-ambiguous-b', {apiKey: 'legacy-token-b', model: 'legacy-model-b'});
writeSettings({
	...USER_OWNED,
	env: {
		ANTHROPIC_BASE_URL: 'https://same.test/anthropic',
		CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80'
	}
});
assertNoActive('旧式半配置的多个回退候选');
console.log('[PASS] active identity 旧式多候选回退保持歧义');

// 编辑/删除必须只基于唯一解析出的真实 active，不可把同 URL/Token 的另一项当作 active。
resetProviderFixture();
const editInactive = addCollisionProvider('edit-inactive', {model: 'inactive-model'});
const editActive = addCollisionProvider('edit-active', {model: 'active-model'});
switchProvider(editActive.key);
assertSoleActive(editActive.key, '编辑前真实 active');
editProvider(editActive.key, {modelEnv: {ANTHROPIC_DEFAULT_OPUS_MODEL: 'active-model-edited'}});
assert.equal(readSettings().env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'active-model-edited', '编辑真实 active 应重同步 settings');
assertSoleActive(editActive.key, '编辑真实 active 后');
const settingsBeforeInactiveEdit = readFileSync(settingsPath, 'utf8');
editProvider(editInactive.key, {modelEnv: {ANTHROPIC_DEFAULT_OPUS_MODEL: 'inactive-model-edited'}});
assert.equal(readFileSync(settingsPath, 'utf8'), settingsBeforeInactiveEdit, '编辑非 active 不得改写 settings');
assertSoleActive(editActive.key, '编辑非 active 后');
assert.throws(() => deleteProvider(editActive.key), /无法删除当前活跃的供应商/, '删除真实 active 应被拒绝');
const settingsBeforeInactiveDelete = readFileSync(settingsPath, 'utf8');
const inactiveDelete = deleteProvider(editInactive.key);
assert.equal(inactiveDelete.clearedSettings, false, '删除非 active 不得清理 settings');
assert.equal(readFileSync(settingsPath, 'utf8'), settingsBeforeInactiveDelete, '删除非 active 不得改写 settings');
assertSoleActive(editActive.key, '删除非 active 后');
console.log('[PASS] active identity 编辑/删除只作用于真实 active');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] provider switch/active identity 门禁全部通过');
