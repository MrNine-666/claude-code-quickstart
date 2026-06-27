import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// task 8.1：旧格式 Profile 迁移器门禁。覆盖：
// - 迁移分类（migrated / skipped / failed / total）
// - 模型键一一对应（modelEnv / modelMapping(legacy) → env 受管模型键）
// - 失败保留旧文件（缺必填字段 → failed，旧文件原样不变）
// - 脱敏（failed.reason 不含 token）
// - 新格式单层 env，无顶层 _meta/modelEnv/modelMapping/extraEnv
// - 全量 extra env 迁移（含 custom 非受管键）
// - 迁移后活跃匹配读 env.ANTHROPIC_BASE_URL
//
// 用 CCQ_HOME 隔离 ~/.claude 到临时目录，跑真实 core（provider.ts）。

const home = mkdtempSync(join(tmpdir(), 'ccq-migration-'));
process.env.CCQ_HOME = home;
const providersDir = join(home, '.claude', 'providers');
const settingsPath = join(home, '.claude', 'settings.json');
mkdirSync(providersDir, {recursive: true});

function writeProfile(key, obj) {
	writeFileSync(join(providersDir, `${key}.json`), JSON.stringify(obj, null, 2), 'utf8');
}

function readProfile(key) {
	return JSON.parse(readFileSync(join(providersDir, `${key}.json`), 'utf8'));
}

// fixture 1：复合旧格式（_meta + modelEnv + extraEnv，含 custom 非受管键）
writeProfile('zhipu', {
	_meta: {provider: 'zhipu', key: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/anthropic', configuredAt: '2026-01-01T00:00:00Z'},
	env: {ANTHROPIC_AUTH_TOKEN: 'sk-zhipu-aaaaaaaa', ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic'},
	modelEnv: {ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1'},
	extraEnv: {API_TIMEOUT_MS: '3000000', CUSTOM_FOO: 'bar'}
});

// fixture 2：legacy modelMapping 别名（无 modelEnv）
writeProfile('deepseek', {
	_meta: {provider: 'deepseek'},
	env: {ANTHROPIC_AUTH_TOKEN: 'sk-ds-bbbbbbbb', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic'},
	modelMapping: {opus: 'deepseek-v4-pro[1m]', sonnet: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash'}
});

// fixture 3：已是新格式单层 env → skipped
writeProfile('already-new', {
	env: {ANTHROPIC_AUTH_TOKEN: 'sk-new-cccccccc', ANTHROPIC_BASE_URL: 'https://api.custom.test/anthropic'}
});

// fixture 4：缺必填字段（缺 token），有顶层 modelEnv 触发迁移判定 → failed，旧文件保留
writeProfile('broken', {
	modelEnv: {ANTHROPIC_DEFAULT_OPUS_MODEL: 'x'},
	env: {ANTHROPIC_BASE_URL: 'https://only-baseurl.test'}
});

const {migrateLegacyProfiles, getActiveProvider} = await import('../src/core/provider.ts');

const result = migrateLegacyProfiles();

// ── 迁移分类 ────────────────────────────────────────────────────────────────
assert.equal(result.total, 4, 'total 应为 4');
assert.deepEqual([...result.migrated].sort(), ['deepseek', 'zhipu'], 'zhipu/deepseek 应迁移');
assert.deepEqual([...result.skipped], ['already-new'], 'already-new 应跳过');
assert.equal(result.failed.length, 1, 'broken 应失败');
assert.equal(result.failed[0].key, 'broken');
console.log('[PASS] 8.1 迁移分类（migrated/skipped/failed/total）');

// ── 复合迁移：单层 env / 无顶层旧字段 / 模型键对应 / 全量 extra env ──────────
const zhipu = readProfile('zhipu');
assert.deepEqual(Object.keys(zhipu), ['env'], '迁移后顶层只剩 env');
assert.equal('_meta' in zhipu, false, '无顶层 _meta');
assert.equal('modelEnv' in zhipu, false, '无顶层 modelEnv');
assert.equal('extraEnv' in zhipu, false, '无顶层 extraEnv');
assert.equal(zhipu.env.ANTHROPIC_AUTH_TOKEN, 'sk-zhipu-aaaaaaaa');
assert.equal(zhipu.env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
assert.equal(zhipu.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.1', 'modelEnv 模型键一一对应');
assert.equal(zhipu.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.1');
assert.equal(zhipu.env.API_TIMEOUT_MS, '3000000', '受管 extra env 迁移');
assert.equal(zhipu.env.CUSTOM_FOO, 'bar', 'custom 非受管 extra env 全量迁移');
console.log('[PASS] 8.1 复合迁移：单层 env / 无顶层旧字段 / 模型键对应 / 全量 extra env');

// ── legacy modelMapping → env 受管模型键 ─────────────────────────────────────
const ds = readProfile('deepseek');
assert.deepEqual(Object.keys(ds), ['env']);
assert.equal('modelMapping' in ds, false, '无顶层 modelMapping');
assert.equal(ds.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro[1m]', 'legacy opus → env');
assert.equal(ds.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro[1m]', 'legacy sonnet → env');
assert.equal(ds.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash', 'legacy haiku → env');
console.log('[PASS] 8.1 legacy modelMapping 别名 → env 受管模型键');

// ── 失败保留旧文件 ──────────────────────────────────────────────────────────
const broken = readProfile('broken');
assert.ok('modelEnv' in broken, '失败文件保留原顶层 modelEnv（未被改写）');
assert.equal(broken.env.ANTHROPIC_BASE_URL, 'https://only-baseurl.test', '失败文件内容不变');
assert.equal('ANTHROPIC_AUTH_TOKEN' in broken.env, false, '失败文件仍缺 token');
console.log('[PASS] 8.1 失败保留旧文件');

// ── 脱敏：failed.reason 不含 token ───────────────────────────────────────────
for (const f of result.failed) {
	assert.equal(/sk-[a-zA-Z0-9_-]+/.test(f.reason || ''), false, 'failed.reason 不得含 token');
}
console.log('[PASS] 8.1 失败原因脱敏');

// ── 幂等：再次迁移已迁移文件全 skipped ───────────────────────────────────────
const result2 = migrateLegacyProfiles();
assert.equal(result2.migrated.length, 0, '第二次迁移无新增 migrated');
assert.ok(result2.skipped.includes('zhipu'), 'zhipu 第二次 skipped');
assert.ok(result2.skipped.includes('deepseek'), 'deepseek 第二次 skipped');
assert.ok(result2.skipped.includes('already-new'), 'already-new 仍 skipped');
console.log('[PASS] 8.1 幂等性');

// ── 迁移后活跃匹配读 env.ANTHROPIC_BASE_URL ─────────────────────────────────
writeFileSync(
	settingsPath,
	JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'sk-zhipu-aaaaaaaa', ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic'}}, null, 2),
	'utf8'
);
const active = getActiveProvider();
assert.ok(active, '应识别活跃供应商');
assert.equal(active.key, 'zhipu', '活跃匹配读 env.ANTHROPIC_BASE_URL + token');
console.log('[PASS] 8.1 迁移后活跃匹配读 env.ANTHROPIC_BASE_URL');

rmSync(home, {recursive: true, force: true});
console.log('[PASS] task 8.1 迁移器门禁全部通过');
