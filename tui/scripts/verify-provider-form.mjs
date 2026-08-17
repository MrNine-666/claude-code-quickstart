import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// task 8.2：Provider 表单门禁。覆盖：
// - 英文文件名校验（testProviderKey；add 校验、edit 豁免）
// - 底部 env JSON 区原样写入 env
// - 空 key/value 条目丢弃
// - 新建文件名 = 用户填的文件名
// - 内置模板 ExtraEnv 预填进 env 区

const home = mkdtempSync(join(tmpdir(), 'ccq-provider-form-'));
process.env.CCQ_HOME = home;
const providersDir = join(home, '.claude', 'providers');
mkdirSync(providersDir, {recursive: true});

const {buildProviderFormModel, validateProviderForm, toProviderSavePayload} = await import('../src/core/provider-form.ts');
const {loadProviderContract} = await import('../src/core/provider-contract.ts');

const MODEL_KEYS = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL'];
const {addProvider} = await import('../src/core/provider.ts');

// ── 文件名校验 ──────────────────────────────────────────────────────────────
assert.deepEqual(
	validateProviderForm('add-builtin', {profileKey: 'my-zhipu', baseUrl: 'https://x', apiKey: 'sk-x', modelEnv: {}, env: {}, activateAfterSave: false}),
	[],
	'合法英文文件名应通过'
);

const badName = validateProviderForm('add-custom', {
	profileKey: '../evil',
	baseUrl: 'https://api.x/anthropic',
	apiKey: 'sk-x',
	modelEnv: {},
	env: {},
	activateAfterSave: false
});
assert.ok(badName.some(e => /英文文件名/.test(e)), '非法文件名应提示英文文件名');

const emptyName = validateProviderForm('add-builtin', {profileKey: '', baseUrl: 'https://x', apiKey: 'sk-x', modelEnv: {}, env: {}, activateAfterSave: false});
assert.ok(emptyName.some(e => /文件名不能为空/.test(e)), '空文件名应报错');

assert.deepEqual(
	validateProviderForm('edit', {profileKey: '', baseUrl: 'https://x', apiKey: 'sk-x', modelEnv: {}, env: {}, activateAfterSave: false}),
	[],
	'edit 模式 readonly 文件名不校验'
);
console.log('[PASS] 8.2 文件名校验（testProviderKey / 空 / edit 豁免）');

// ── 底部 env JSON 区原样 + 空条目丢弃 + 新建文件名 ───────────────────────
const input = {mode: 'add-custom'};
const values = {
	profileKey: 'my-custom',
	baseUrl: 'https://api.custom.test/anthropic',
	apiKey: 'sk-custom-xxxxxxxx',
	modelEnv: {},
	env: {FOO: 'bar', EMPTY_VAL: '', '': 'orphan-key', API_TIMEOUT_MS: '3000000'},
	activateAfterSave: false
};
const payload = toProviderSavePayload(input, values);
assert.equal(payload.action, 'add');
assert.equal(payload.profileKey, 'my-custom', '新建文件名 = 用户填的文件名');
assert.deepEqual(payload.env, {FOO: 'bar', API_TIMEOUT_MS: '3000000'}, '空 key/value 条目丢弃，其余原样');
console.log('[PASS] 8.2 env JSON 区原样 + 空条目丢弃 + 用户文件名');

// ── 端到端：addProvider 后用户文件名落盘 + env 区写入 env ──────────────────
const addResult = addProvider({
	profileKey: payload.profileKey,
	baseUrl: payload.baseUrl,
	apiKey: payload.apiKey,
	env: payload.env,
	activate: false
});
assert.equal(addResult.success, true, 'addProvider 应成功');
assert.equal(addResult.key, 'my-custom', '落盘 key = 用户填的文件名');
assert.ok(existsSync(join(providersDir, 'my-custom.json')), '应按用户文件名落盘');

const saved = JSON.parse(readFileSync(join(providersDir, 'my-custom.json'), 'utf8'));
assert.deepEqual(Object.keys(saved), ['env'], '单层 env，无顶层 _meta');
assert.equal(saved.env.FOO, 'bar', 'env 区原样写入 env');
assert.equal(saved.env.API_TIMEOUT_MS, '3000000');
assert.equal('EMPTY_VAL' in saved.env, false, '空值条目未写入');
console.log('[PASS] 8.2 端到端：用户文件名落盘 + env 区写入 env');

// ── 内置模板表单结构（HC-12 单层 env：env 区走底部 JSON，不再是表单字段） ──
const builtinForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'deepseek'});
assert.equal(builtinForm.mode, 'add-builtin');
assert.equal(builtinForm.values.modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
assert.equal(builtinForm.values.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro');
assert.equal(builtinForm.values.modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro');
assert.ok(Array.isArray(builtinForm.fields), '应返回 fields 数组');
// add 模式首字段为供应商类型 radio
assert.equal(builtinForm.fields[0].id, 'providerType', 'add 模式首字段为供应商类型');
assert.equal(builtinForm.fields[0].type, 'radio');
// 核心可编辑字段存在
assert.ok(builtinForm.fields.some(f => f.id === 'profileKey' && f.type === 'text'), '文件名字段可编辑');
assert.ok(builtinForm.fields.some(f => f.id === 'baseUrl'), '含 baseUrl 字段');
assert.ok(builtinForm.fields.some(f => f.id === 'apiKey'), '含 apiKey 字段');
// env 在 values 维护（底部 JSON 区），不再是表单字段
assert.equal(builtinForm.fields.find(f => f.id === 'env'), undefined, 'env 不再是表单字段');
assert.ok(typeof builtinForm.values.env === 'object', 'values.env 存在');
assert.equal(builtinForm.values.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '786432', '内置模板 ExtraEnv 预填进 env 区');
assert.equal('ANTHROPIC_MODEL' in builtinForm.values.env, false, '模板不再含 ANTHROPIC_MODEL');
assert.equal('API_TIMEOUT_MS' in builtinForm.values.env, false, '模板不再含 API_TIMEOUT_MS');
console.log('[PASS] 8.2 内置模板表单结构（env 走 values 不走 fields）');

// ── Kimi 双档模板：同端点同 Key，仅上下文档位不同（1M / 256K 各自自洽） ──
const kimi1m = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'moonshot'}).values;
const kimi256k = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'moonshot-256k'}).values;
assert.equal(kimi1m.baseUrl, kimi256k.baseUrl, 'Kimi 双档共用同一 Coding Plan 端点');
assert.equal(kimi1m.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'k3[1m]');
assert.equal(kimi256k.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'k3-256k');
// 窗口值必须与模型档位一致：调小会过早压缩丢上下文，调大会触发上下文超限报错。
assert.equal(kimi1m.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576');
assert.equal(kimi1m.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1048576');
assert.equal(kimi256k.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '262144');
assert.equal(kimi256k.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '262144');
// 三个受管模型槽位须同档（该端点只有一个模型，无强弱分层可言）。
for (const values of [kimi1m, kimi256k]) {
	const expected = values.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL;
	assert.equal(values.modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, expected);
	assert.equal(values.modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, expected);
}
// profileKey 默认取契约 key，两档互不覆盖同一落盘文件。
assert.equal(kimi1m.profileKey, 'moonshot');
assert.equal(kimi256k.profileKey, 'moonshot-256k');
console.log('[PASS] Kimi 1M / 256K 双档模板：端点一致 + 模型与窗口同档 + 文件名互不冲突');

// ── providerType 选项唯一事实源为契约（含 custom 占位条目，代码内不得硬编码追加） ──
const contractProviders = loadProviderContract().builtinProviders;
const contractKeys = Object.keys(contractProviders);
const typeField = builtinForm.fields[0];
assert.deepEqual(
	typeField.options.map(o => o.value),
	contractKeys,
	'providerType 选项集与顺序须逐项等于契约 BuiltinProviders（custom 亦来自契约，不在代码中追加）'
);
for (const option of typeField.options) {
	assert.equal(option.label, contractProviders[option.value].name, `${option.value} label 须取契约 Name，不得硬编码`);
}
// custom 是契约内的占位条目：末位、空 BaseUrl、无模型配置 —— 选中后不预填任何字段。
assert.equal(contractKeys[contractKeys.length - 1], 'custom', 'custom 须位于契约末尾以天然排在选项最后');
assert.equal(contractProviders.custom.baseUrl, '', 'custom 占位条目 BaseUrl 须为空');
assert.equal(contractProviders.custom.modelEnv, undefined, 'custom 占位条目不得有 ModelEnv');
const customForm = buildProviderFormModel({mode: 'add-custom'}).values;
assert.equal(customForm.providerType, 'custom');
assert.equal(customForm.baseUrl, '', 'custom 不预填 baseUrl');
assert.equal(customForm.profileKey, '', 'custom 不预填文件名（强制用户命名，避免多个自定义供应商互相覆盖）');
assert.deepEqual(customForm.modelEnv, {}, 'custom 无受管模型键');
assert.deepEqual(customForm.env, {}, 'custom 无 ExtraEnv');
console.log('[PASS] providerType 选项全部由契约派生（含 custom 占位条目，无代码内硬编码）');

// ── 字段提示（helpText）：每个可见字段都须有说明，与 Codex 侧对齐 ──
const kimiForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'moonshot'});
for (const field of kimiForm.fields) {
	assert.ok(field.helpText && field.helpText.trim().length > 0, `${field.id} 须有 helpText（Claude 侧字段提示不得缺失）`);
}
const profileKeyHelp = kimiForm.fields.find(f => f.id === 'profileKey').helpText;
assert.match(profileKeyHelp, /同名.*拒绝|已存在.*更换文件名/, '文件名提示须说明同名 target 会被拒绝并要求更名');
assert.doesNotMatch(profileKeyHelp, /自动.*后缀/, '文件名提示不得再宣称同名时自动生成后缀');
// providerType 提示取契约 Note，无 Note 时回退 Description。
assert.equal(kimiForm.fields[0].helpText, contractProviders.moonshot.note, 'providerType helpText 取契约 Note');
assert.equal(
	buildProviderFormModel({mode: 'add-custom'}).fields[0].helpText,
	contractProviders.custom.description,
	'无 Note 的供应商回退 Description'
);
// API Key 提示内联契约 PlatformUrl（此前该字段全项目无人消费）。
const kimiApiKeyHelp = kimiForm.fields.find(f => f.id === 'apiKey').helpText;
assert.ok(kimiApiKeyHelp.includes(contractProviders.moonshot.platformUrl), 'apiKey helpText 须含契约 PlatformUrl');
// 三个模型键各有独立说明：留空的档位会静默失败（无报错无提示），故须逐个点明归属别名。
// 只断言「各自点到自己的别名且互不相同」，不锁具体文案长度，便于后续精简措辞。
for (const key of MODEL_KEYS) {
	const alias = key.replace('ANTHROPIC_DEFAULT_', '').replace('_MODEL', '').toLowerCase();
	const help = kimiForm.fields.find(f => f.id === key).helpText;
	assert.ok(help.includes(alias), `${key} 说明须点明其归属别名 ${alias}`);
}
const modelHelps = MODEL_KEYS.map(k => kimiForm.fields.find(f => f.id === k).helpText);
assert.equal(new Set(modelHelps).size, MODEL_KEYS.length, '三个模型键说明须各不相同（分别点明归属别名）');
// Claude 侧 note 与 Codex 侧 note 互不回退：分别描述两侧接入限制。
assert.notEqual(contractProviders.deepseek.note, contractProviders.deepseek.codex.note, 'Claude 侧 Note 与 Codex 侧 Note 各自独立');
console.log('[PASS] Claude 侧字段提示齐备（契约 Note/Description/PlatformUrl 均已消费）');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] task 8.2 Provider 表单门禁全部通过');
