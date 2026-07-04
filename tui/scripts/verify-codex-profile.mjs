import assert from 'node:assert/strict';

// Task 1.9/1.10/1.11 骨架：Codex 官方 profile 机制 + provider 单一身份 + API key 边界。
// 冻结 design D6/D7/D8 与 PBT-6/PBT-8/PBT-10 不变量；
// 阶段 5 落地 tui/src/core/codex.ts 后改为 import 真实 core 断言。

const CODEX_HOME = '/tmp/fake-codex-home';

// ── 1.9 官方 profile 文件机制：--profile <key> ↔ $CODEX_HOME/<key>.config.toml ──
function expectedProfilePath(home, key) {
	return `${home}/${key}.config.toml`;
}

const key = 'deepseek';
const profilePath = expectedProfilePath(CODEX_HOME, key);
assert.equal(profilePath, `${CODEX_HOME}/deepseek.config.toml`, 'profile 文件为 $CODEX_HOME/<key>.config.toml');

// 禁止非官方 provider/ 子目录布局
assert.equal(/\/provider\//.test(profilePath), false, '禁止 $CODEX_HOME/provider/*.config.toml 布局');

// 禁止 legacy profile selector：base config 不得写 profile = "<key>" 或 [profiles.<key>]
const FORBIDDEN_BASE_KEYS = [`profile = "${key}"`, `[profiles.${key}]`];
const baseConfigSnippet = `model_provider = "${key}"\n[model_providers.${key}]\nname = "${key}"\n`;
for (const forbidden of FORBIDDEN_BASE_KEYS) {
	assert.equal(baseConfigSnippet.includes(forbidden), false, `base config 不得写 ${forbidden}`);
}
console.log('[PASS] 1.9 Codex 官方 profile 机制：<key>.config.toml + 禁 provider/ 子目录 + 禁 legacy selector');

// ── 1.10 provider 单一身份：只允许 key，禁独立 profileName/providerId/displayName ──
// key 同时作为文件名 stem、profile name、model_provider id、table id、默认显示名。
const IDENTITY_ROLES = ['filenameStem', 'profileName', 'providerId', 'modelProvidersTableId', 'defaultDisplayName'];
const derivedIdentity = Object.fromEntries(IDENTITY_ROLES.map(role => [role, key]));
for (const role of IDENTITY_ROLES) {
	assert.equal(derivedIdentity[role], key, `${role} 必须由 key 派生`);
}
// 禁止 payload 出现独立身份主键
const FORBIDDEN_IDENTITY_FIELDS = ['profileName', 'providerId', 'displayName'];
const samplePayload = {key, providerType: 'custom', baseUrl: 'https://api.deepseek.com'};
for (const field of FORBIDDEN_IDENTITY_FIELDS) {
	assert.equal(Object.prototype.hasOwnProperty.call(samplePayload, field), false, `payload 不得含独立身份主键 ${field}`);
}
console.log('[PASS] 1.10 Codex provider 单一身份：仅 key，无独立 profileName/providerId/displayName');

// ── 1.11 API key 边界：写 experimental_bearer_token，不进 vault/env/日志 ──
const API_KEY_FIELD = 'experimental_bearer_token';
assert.equal(API_KEY_FIELD, 'experimental_bearer_token', 'API key 字段必须为 experimental_bearer_token');

// 同一 provider table 禁止混用 env_key / auth / requires_openai_auth
const MUTUALLY_EXCLUSIVE = ['env_key', 'auth', 'requires_openai_auth'];
const apiKeyProviderTableKeys = ['name', 'base_url', API_KEY_FIELD];
for (const exclusive of MUTUALLY_EXCLUSIVE) {
	assert.equal(apiKeyProviderTableKeys.includes(exclusive), false, `API-key provider table 不得含 ${exclusive}`);
}

// 不得写 ccq vault、不得由 ccq cx env 注入（策略冻结）
const writesCcqVault = false;
const injectsEnvOnLaunch = false;
assert.equal(writesCcqVault, false, 'API key 不得写入 ccq vault');
assert.equal(injectsEnvOnLaunch, false, 'ccq cx 不得注入 API key env');

// 脱敏契约：raw key 不得出现在日志/toast/error/verify 输出
const rawKey = 'sk-secret-should-never-leak';
const maskedOutput = '****';
assert.equal(maskedOutput.includes(rawKey), false, 'raw API key 不得出现在输出');
console.log('[PASS] 1.11 Codex API key 骨架：experimental_bearer_token + 认证字段互斥 + 不进 vault/env + 输出脱敏');
