import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// task 8.2：Provider 表单门禁。覆盖：
// - 英文文件名校验（testProviderKey；add 校验、edit 豁免）
// - key-value extra env 原样写入 env
// - 空 key/value 条目丢弃
// - 新建文件名 = 用户填的文件名
// - 内置模板 extraEnv 预填 + key-value 字段

const home = mkdtempSync(join(tmpdir(), 'ccq-provider-form-'));
process.env.CCQ_HOME = home;
const providersDir = join(home, '.claude', 'providers');
mkdirSync(providersDir, {recursive: true});

const {buildProviderFormModel, validateProviderForm, toProviderSavePayload} = await import('../src/core/provider-form.ts');
const {addProvider} = await import('../src/core/provider.ts');

// ── 文件名校验 ──────────────────────────────────────────────────────────────
assert.deepEqual(
	validateProviderForm('add-builtin', {profileKey: 'my-zhipu', baseUrl: 'https://x', apiKey: 'sk-x', modelEnv: {}, extraEnv: {}, activateAfterSave: false}),
	[],
	'合法英文文件名应通过'
);

const badName = validateProviderForm('add-custom', {
	profileKey: '../evil',
	baseUrl: 'https://api.x/anthropic',
	apiKey: 'sk-x',
	modelEnv: {},
	extraEnv: {},
	activateAfterSave: false
});
assert.ok(badName.some(e => /英文文件名/.test(e)), '非法文件名应提示英文文件名');

const emptyName = validateProviderForm('add-builtin', {profileKey: '', baseUrl: 'https://x', apiKey: 'sk-x', modelEnv: {}, extraEnv: {}, activateAfterSave: false});
assert.ok(emptyName.some(e => /文件名不能为空/.test(e)), '空文件名应报错');

assert.deepEqual(
	validateProviderForm('edit', {profileKey: '', baseUrl: 'https://x', apiKey: 'sk-x', modelEnv: {}, extraEnv: {}, activateAfterSave: false}),
	[],
	'edit 模式 readonly 文件名不校验'
);
console.log('[PASS] 8.2 文件名校验（testProviderKey / 空 / edit 豁免）');

// ── key-value extra env 原样 + 空条目丢弃 + 新建文件名 ──────────────────────
const input = {mode: 'add-custom'};
const values = {
	profileKey: 'my-custom',
	baseUrl: 'https://api.custom.test/anthropic',
	apiKey: 'sk-custom-xxxxxxxx',
	modelEnv: {},
	extraEnv: {FOO: 'bar', EMPTY_VAL: '', '': 'orphan-key', API_TIMEOUT_MS: '3000000'},
	activateAfterSave: false
};
const payload = toProviderSavePayload(input, values);
assert.equal(payload.action, 'add');
assert.equal(payload.profileKey, 'my-custom', '新建文件名 = 用户填的文件名');
assert.deepEqual(payload.extraEnv, {FOO: 'bar', API_TIMEOUT_MS: '3000000'}, '空 key/value 条目丢弃，其余原样');
console.log('[PASS] 8.2 key-value extra env 原样 + 空条目丢弃 + 用户文件名');

// ── 端到端：addProvider 后用户文件名落盘 + extra env 写入 env ────────────────
const addResult = addProvider({
	profileKey: payload.profileKey,
	baseUrl: payload.baseUrl,
	apiKey: payload.apiKey,
	extraEnv: payload.extraEnv,
	activate: false
});
assert.equal(addResult.success, true, 'addProvider 应成功');
assert.equal(addResult.key, 'my-custom', '落盘 key = 用户填的文件名');
assert.ok(existsSync(join(providersDir, 'my-custom.json')), '应按用户文件名落盘');

const saved = JSON.parse(readFileSync(join(providersDir, 'my-custom.json'), 'utf8'));
assert.deepEqual(Object.keys(saved), ['env'], '单层 env，无顶层 _meta');
assert.equal(saved.env.FOO, 'bar', 'key-value extra env 原样写入 env');
assert.equal(saved.env.API_TIMEOUT_MS, '3000000');
assert.equal('EMPTY_VAL' in saved.env, false, '空值条目未写入');
console.log('[PASS] 8.2 端到端：用户文件名落盘 + extra env 写入 env');

// ── 内置模板表单结构（HC-12 单层 env：extraEnv 走 values JSON 区，不再是表单字段） ──
const builtinForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'zhipu'});
assert.equal(builtinForm.mode, 'add-builtin');
assert.ok(Array.isArray(builtinForm.fields), '应返回 fields 数组');
// add 模式首字段为供应商类型 radio
assert.equal(builtinForm.fields[0].id, 'providerType', 'add 模式首字段为供应商类型');
assert.equal(builtinForm.fields[0].type, 'radio');
// 核心可编辑字段存在
assert.ok(builtinForm.fields.some(f => f.id === 'profileKey' && f.type === 'text'), '文件名字段可编辑');
assert.ok(builtinForm.fields.some(f => f.id === 'baseUrl'), '含 baseUrl 字段');
assert.ok(builtinForm.fields.some(f => f.id === 'apiKey'), '含 apiKey 字段');
// extraEnv 在 values 维护（JSON 区），不再是表单字段
assert.equal(builtinForm.fields.find(f => f.id === 'extraEnv'), undefined, 'extraEnv 不再是表单字段');
assert.ok(typeof builtinForm.values.extraEnv === 'object', 'values.extraEnv 存在');
console.log('[PASS] 8.2 内置模板表单结构（extraEnv 走 values 不走 fields）');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] task 8.2 Provider 表单门禁全部通过');
