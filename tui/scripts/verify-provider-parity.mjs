import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// task 8.5（决策变更后）：PS/zsh Provider 写函数已删除（5.5/5.6），跨平台对拍对象不存在。
// 降级为纯 TS 迁移结构契约守卫：含 _meta + modelEnv + modelMapping + extraEnv 的复合 fixture，
// 经 TS 迁移后必须产出严格 settings-compatible 单层结构——顶层只有 env，无任何旧格式残留字段，
// 全部应迁移的键齐备，且 env 值均为 string。

const home = mkdtempSync(join(tmpdir(), 'ccq-provider-parity-'));
process.env.CCQ_HOME = home;
const providersDir = join(home, '.claude', 'providers');
mkdirSync(providersDir, {recursive: true});

// 复合 fixture：同时含旧格式全部特征字段（_meta + modelEnv + modelMapping + extraEnv + 原 env 非受管键）
writeFileSync(
	join(providersDir, 'legacy-all.json'),
	JSON.stringify(
		{
			_meta: {provider: 'zhipu', key: 'legacy-all', baseUrl: 'https://open.bigmodel.cn/api/anthropic', configuredAt: '2026-01-01T00:00:00Z'},
			env: {
				ANTHROPIC_AUTH_TOKEN: 'sk-legacy-xxxxxxxx',
				ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
				PRESERVED_ENV: 'keep'
			},
			modelEnv: {ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1'},
			modelMapping: {sonnet: 'glm-5.1', haiku: 'glm-4.5-air'},
			extraEnv: {API_TIMEOUT_MS: '3000000', CUSTOM_KEY: 'custom-val'}
		},
		null,
		2
	),
	'utf8'
);

const {migrateLegacyProfiles} = await import('../src/core/provider.ts');
const result = migrateLegacyProfiles();
assert.deepEqual([...result.migrated], ['legacy-all'], '复合 fixture 应迁移');

const migrated = JSON.parse(readFileSync(join(providersDir, 'legacy-all.json'), 'utf8'));

// 结构契约 1：顶层只有 env
assert.deepEqual(Object.keys(migrated), ['env'], '迁移输出顶层只能有 env');

// 结构契约 2：无任何旧格式残留字段
for (const forbidden of ['_meta', 'modelEnv', 'modelMapping', 'extraEnv']) {
	assert.equal(forbidden in migrated, false, `迁移输出不得含顶层 ${forbidden}`);
}

// 结构契约 3：env 含全部应迁移的键
assert.equal(migrated.env.ANTHROPIC_AUTH_TOKEN, 'sk-legacy-xxxxxxxx');
assert.equal(migrated.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
assert.equal(migrated.env.PRESERVED_ENV, 'keep', '原 env 非受管键保留');
assert.equal(migrated.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.1', 'modelEnv 模型键迁移');
assert.equal(migrated.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.1', 'modelMapping(legacy) sonnet 迁移');
assert.equal(migrated.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.5-air', 'modelMapping(legacy) haiku 迁移');
assert.equal(migrated.env.API_TIMEOUT_MS, '3000000', '受管 extra env 迁移');
assert.equal(migrated.env.CUSTOM_KEY, 'custom-val', '自定义 extra env 全量迁移');

// 结构契约 4：env 所有值均为 string（settings-compatible）
for (const [k, v] of Object.entries(migrated.env)) {
	assert.equal(typeof v, 'string', `env.${k} 必须为 string`);
}
console.log('[PASS] 8.5 复合 fixture 迁移输出符合 settings-compatible 单层结构契约');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] task 8.5 迁移结构契约守卫通过（PS/zsh 已删，对拍降级为 TS 结构断言）');
