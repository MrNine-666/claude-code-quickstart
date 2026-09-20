import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// task 8.2：Provider 表单门禁（真实副作用段）。
//
// 试点批（09-18-pilot-verify-migration）把本脚本的纯校验/纯解析段迁到
// tests/core/provider-form.test.ts；此处只保留必须在真实文件系统里成立的断言：
// - 用户文件名落盘 + 单层 env + 底部 JSON 区原样写入
// - 空 key/value 条目不落盘
// - 内置模板 ExtraEnv 通过 addProvider 写入真实 profile
// 主题对账见 .trellis/tasks/09-18-pilot-verify-migration/implement.md 附录 A。

const home = mkdtempSync(join(tmpdir(), 'ccq-provider-form-'));
process.env.CCQ_HOME = home;
const providersDir = join(home, '.claude', 'providers');
mkdirSync(providersDir, {recursive: true});

const {buildProviderFormModel, toProviderSavePayload} = await import('../src/core/provider-form.ts');
const {addProvider} = await import('../src/core/provider.ts');

// ── 端到端：addProvider 后用户文件名落盘 + env 区写入 env ──────────────────
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
console.log('[PASS] 8.2 端到端：用户文件名落盘 + env 区写入 env（空条目丢弃）');

// ── 端到端：内置模板 ExtraEnv 预填后写入真实 profile 字节 ──────────────────
const deepseekForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'deepseek'});
const deepseekAdd = addProvider({
	builtinKey: 'deepseek',
	profileKey: deepseekForm.values.profileKey,
	baseUrl: deepseekForm.values.baseUrl,
	apiKey: 'sk-deepseek-xxxxxxxx',
	activate: false
});
assert.equal(deepseekAdd.success, true, 'deepseek 模板 addProvider 应成功');
const deepseekSaved = JSON.parse(readFileSync(join(providersDir, `${deepseekAdd.key}.json`), 'utf8'));
assert.equal(deepseekSaved.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '786432', '模板 ExtraEnv 必须随落盘写入 profile');
assert.equal(deepseekSaved.env.CLAUDE_CODE_EFFORT_LEVEL, 'max', '模板 ExtraEnv 的非窗口键同样必须落盘');
console.log('[PASS] 8.2 端到端：内置模板 ExtraEnv 落盘字节');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] task 8.2 Provider 表单门禁（真实副作用段）全部通过');
