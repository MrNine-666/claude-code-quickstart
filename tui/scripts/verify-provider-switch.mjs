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

const {addProvider, switchProvider} = await import('../src/core/provider.ts');

function readSettings() {
	return JSON.parse(readFileSync(settingsPath, 'utf8'));
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
assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-flash', 'A 模型键写入');
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

rmSync(home, {recursive: true, force: true});
console.log('[PASS] task 8.3 + 8.8 设置默认/安装范围门禁全部通过');
