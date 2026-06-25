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

const {addProvider, editProvider, switchProvider, getDisplayData} = await import('../dist/core/provider.js');

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
	builtinKey: 'zhipu',
	apiKey: 'sk-zhipu-aaaaaaaaaaaa',
	activate: true
});
assert.equal(addResult.success, true, 'addProvider 应成功');
assert.equal(addResult.activated, true, 'addProvider 激活应成功');
assertUserFieldsIntact('add+activate');

let settings = readSettings();
assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'sk-zhipu-aaaaaaaaaaaa', 'AUTH_TOKEN 应写入');
assert.equal(settings.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic', 'BASE_URL 应写入');
assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.1', '受管模型键应写入');
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
const editResult = editProvider(addResult.key, {apiKey: 'sk-zhipu-cccccccccccc'});
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

// 清理临时目录
rmSync(home, {recursive: true, force: true});
rmSync(idemHome, {recursive: true, force: true});

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
