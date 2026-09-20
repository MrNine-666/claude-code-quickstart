import {expect, test} from 'bun:test';

import {
	buildCodexProfileToml,
	codexIdentityFromKey,
	codexProfileKeyFromPath,
	deleteCodexProfile,
	isOfficialLoginKey,
	parseCodexProfileToml,
	redactCodexTomlForOutput,
	saveCodexProfile,
	saveCodexProfileToml,
	testCodexProfileKey
} from '../../src/core/codex.js';

// P5b 迁移自 scripts/verify-codex-profile.mjs 的纯段（22 条静态断言）：
//   - 官方 profile 文件机制：<key>.config.toml + 安全 key + official 保留字（6）
//   - provider 单一身份 codexIdentityFromKey（1）
//   - 字段 → TOML / TOML → 字段 双向同步（10）
//   - official login 虚拟条目不可落盘（1）
//   - raw TOML 保存前 key/model_provider 一致性校验（1）
//   - official 删除只读保护（2）
//   - API key 输出脱敏（1）
// 真实 fs 段（codexProfileExists 落盘判定、saveCodexProfile/saveCodexProfileToml 原子写与
// 回读字节、setDefaultCodexProfile 合并写 config.toml、isOfficialLoginActive / listCodexProfiles
// 默认态、deleteCodexProfile 真实删除、migrateLegacyOfficialLoginFile 存量迁移）仍留在
// scripts/verify-codex-profile.mjs。载体对账见 research-reconciliation-P5b.md §4。

const key = 'deepseek';
const rawKey = 'sk-secret-should-never-leak';

test('1.9 Codex 官方 profile 机制：<key>.config.toml + 安全 key + official 保留字', () => {
	expect(codexProfileKeyFromPath('/home/u/.codex/deepseek.config.toml'), 'profile 文件为 ~/.codex/<key>.config.toml').toBe(key);
	expect(
		codexProfileKeyFromPath('/home/u/.codex/provider/deepseek.config.toml'),
		'路径解析只取 basename，存储位置由 codexProfilePath/saveCodexProfile 负责限制在 ~/.codex 根'
	).toBe(key);
	expect(testCodexProfileKey('../bad'), '拒绝路径穿越 key').toBe(false);
	expect(testCodexProfileKey('-bad'), '拒绝 - 开头 key').toBe(false);
	expect(testCodexProfileKey('official'), '拒绝保留字 official（official login 虚拟条目专用）').toBe(false);
	expect(isOfficialLoginKey('official'), 'official 被识别为 official login 虚拟条目 key').toBe(true);
});

test('1.10 Codex provider 单一身份：仅 key，无独立 profileName/providerId/displayName', () => {
	const identity = codexIdentityFromKey(key);
	expect(identity, 'Codex key 同时派生文件名/profile/provider id/table id/默认显示名').toEqual({
		filenameStem: key,
		profileName: key,
		providerId: key,
		modelProvidersTableId: key,
		defaultDisplayName: key
	});
});

test('5.5/5.6 Codex Provider 字段/TOML 双向同步 + API key 字段策略', () => {
	const toml = buildCodexProfileToml({
		key,
		providerType: 'apiKey',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: rawKey
	});
	expect(toml, 'profile TOML 写 model_provider').toMatch(/model_provider\s*=\s*"deepseek"/);
	expect(toml, 'ccq 生成的 profile 省略 Codex 默认 wire_api').not.toMatch(/wire_api\s*=/);
	expect(toml, 'API key 写入 experimental_bearer_token').toMatch(/experimental_bearer_token\s*=\s*"sk-secret-should-never-leak"/);
	expect(
		/env_key\s*=|requires_openai_auth\s*=|\[model_providers\.deepseek\.auth\]/.test(toml),
		'API-key provider table 不得含 env_key/auth/requires_openai_auth'
	).toBe(false);
	expect(/profile\s*=\s*"deepseek"|\[profiles\.deepseek\]/.test(toml), 'profile TOML 不写 legacy selector').toBe(false);

	const parsed = parseCodexProfileToml(key, toml);
	expect(parsed.key).toBe(key);
	expect(parsed.providerType).toBe('apiKey');
	expect(parsed.baseUrl).toBe('https://api.deepseek.com');
	expect(parsed.model).toBe('deepseek-chat');
	expect(parsed.hasApiKey).toBe(true);
});

test('5.7 official login 为虚拟条目，不落盘', () => {
	expect(() => saveCodexProfile({key: 'official', providerType: 'officialLogin'}), 'official 保留字不可落盘为真实 profile').toThrow(
		/非法供应商名称/
	);
});

test('5.8 raw TOML 保存必须校验文件 key 与 model_provider 一致', () => {
	const toml = buildCodexProfileToml({
		key,
		providerType: 'apiKey',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: rawKey
	});
	expect(() => saveCodexProfileToml('other', toml), 'raw TOML 保存必须校验文件 key 与 model_provider 一致').toThrow(
		/model_provider 不一致/
	);
});

test('5.9 official 删除必须指向 Codex 原生 logout（只读身份）', () => {
	expect(() => deleteCodexProfile('official'), 'official 删除必须指向 Codex 原生 logout').toThrow(/只读身份.*codex logout/);
	expect(() => deleteCodexProfile('official'), '非激活态 official 也必须保持只读').toThrow(/只读身份.*codex logout/);
});

test('1.11 Codex API key 输出脱敏', () => {
	const toml = buildCodexProfileToml({
		key,
		providerType: 'apiKey',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: rawKey
	});
	expect(redactCodexTomlForOutput(toml).includes(rawKey), '展示用 TOML 必须脱敏 raw key').toBe(false);
});
