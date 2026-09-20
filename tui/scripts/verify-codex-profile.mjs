import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildCodexProfileToml,
	codexProfileExists,
	deleteCodexProfile,
	isOfficialLoginActive,
	listCodexProfiles,
	migrateLegacyOfficialLoginFile,
	resolveDefaultCodexProfileKey,
	saveCodexProfile,
	saveCodexProfileToml,
	setDefaultCodexProfile,
	CODEX_OFFICIAL_LOGIN_KEY
} from '../src/core/codex.ts';

// [P5b 迁走] 官方 profile key 机制 / 单一身份 / 字段↔TOML 双向同步 / official 虚拟条目不可落盘 /
// raw TOML 一致性校验 / official 删除只读 / 输出脱敏（22 条静态断言）→ tests/core/codex-profile.test.ts。
// 本文件保留真实 fs 段：原子保存 + 回读字节、默认 profile 合并写 config.toml、删除保护与
// official 默认态、official.config.toml 存量迁移。

const home = mkdtempSync(join(tmpdir(), 'ccq-codex-profile-'));
process.env.CCQ_HOME = home;
// ccq 的 codexDir() 硬编码 ~/.codex（不认 CODEX_HOME，对齐上游 ccg-workflow）；
// 测试经 CCQ_HOME 注入临时 home，Codex 目录即 home/.codex。
const codexHome = join(home, '.codex');

try {
	const key = 'deepseek';
	const rawKey = 'sk-secret-should-never-leak';

	// ── 1.9 official 虚拟条目无磁盘文件（真实 fs 存在性判定；key/路径语义已迁 tests）──
	assert.equal(codexProfileExists('official'), false, 'official 虚拟条目无磁盘文件');
	console.log('[PASS] 1.9 Codex 官方 profile 机制：official 虚拟条目无磁盘文件');

	// ── 5.5/5.6 profile TOML 事实源：buildCodexProfileToml 产物供后续真实落盘断言使用 ──
	const toml = buildCodexProfileToml({
		key,
		providerType: 'apiKey',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: rawKey
	});

	// ── 5.8 保存 profile：写 ~/.codex 根目录，不写 ccq vault/Claude provider ──
	const saved = saveCodexProfile({
		key,
		providerType: 'apiKey',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: rawKey
	});
	assert.equal(saved.profilePath, join(codexHome, `${key}.config.toml`));
	assert.equal(codexProfileExists(key), true, '保存后 profile 文件存在');
	assert.equal(readFileSync(saved.profilePath, 'utf8').includes(rawKey), true,
		'profile TOML 是 direct bearer token 事实源');
	const rawWithUnknown = `${toml}\napproval_policy = "on-request"\n`;
	const rawSaved = saveCodexProfileToml(key, rawWithUnknown);
	assert.equal(rawSaved.hasApiKey, true, 'raw TOML 保存后仍识别 API key');
	assert.equal(readFileSync(rawSaved.profilePath, 'utf8'), rawWithUnknown, 'raw TOML 保存应保留未知字段与原文');
	console.log('[PASS] 5.8 Codex profile 原子保存到 ~/.codex/<key>.config.toml + raw TOML 边界');

	// ── 5.10 默认设置：合并写供应商键，保留 mcp_servers/approval_policy，删除 legacy selector ──
	const baseConfigPath = join(codexHome, 'config.toml');
	writeFileSync(baseConfigPath, 'approval_policy = "on-request"\nprofile = "old"\n[profiles.old]\nmodel = "old"\n[mcp_servers.context7]\ncommand = "context7"\n', 'utf8');
	setDefaultCodexProfile(key);
	const baseConfig = readFileSync(baseConfigPath, 'utf8');
	assert.match(baseConfig, /approval_policy\s*=\s*"on-request"/, '默认切换保留非供应商配置 approval_policy');
	assert.match(baseConfig, /\[mcp_servers\.context7\]/, '默认切换保留 MCP table，不整体覆盖 config.toml');
	assert.match(baseConfig, /model_provider\s*=\s*"deepseek"/, '写入默认 model_provider');
	assert.doesNotMatch(baseConfig, /wire_api\s*=/, '默认切换不写入可省略的 wire_api');
	assert.match(baseConfig, /experimental_bearer_token\s*=\s*"sk-secret-should-never-leak"/, '导入新 provider table 到 base config');
	assert.equal(/profile\s*=\s*"|\[profiles\./.test(baseConfig), false, 'base config 清理 legacy profile selector');
	assert.equal(/model\s*=\s*"old"/.test(baseConfig), false, '删除旧 profile 的残留 model 值');
	setDefaultCodexProfile(key);
	assert.equal(readFileSync(baseConfigPath, 'utf8'), baseConfig, '重复设置默认应幂等');
	assert.equal(listCodexProfiles().find(item => item.key === key)?.isDefault, true, 'list 标记当前默认');
	console.log('[PASS] 5.10 Codex 默认 profile 合并写 + 保留 MCP/其他配置 + 禁 legacy selector + 幂等');

	// ── 5.9 删除 profile：当前默认拒绝删除，切换默认后可删除非默认 ──
	assert.throws(() => deleteCodexProfile(key), /默认供应商/, '默认 profile 删除前拒绝');
	// official login 虚拟条目激活：不落盘，清空 config.toml 供应商键；auth.json 存在即视为登录态。
	writeFileSync(join(codexHome, 'auth.json'), '{"access_token":"secret"}', 'utf8');
	setDefaultCodexProfile('official');
	const officialBaseConfig = readFileSync(baseConfigPath, 'utf8');
	assert.equal(officialBaseConfig.includes('[model_providers.deepseek]'), false, 'official 激活清理上一 provider table');
	assert.equal(officialBaseConfig.includes(rawKey), false, 'official 激活清理上一 provider token');
	assert.equal(existsSync(join(codexHome, 'official.config.toml')), false, 'official 激活不落盘 profile 文件');
	// 默认态判定根治：official 激活后 isDefault/list 标记正确，旧版盲区已消除。
	assert.equal(isOfficialLoginActive(), true, 'official 激活 + auth.json 存在 → isOfficialLoginActive=true');
	assert.equal(resolveDefaultCodexProfileKey(), CODEX_OFFICIAL_LOGIN_KEY, '默认 key 解析为 official sentinel');
	assert.equal(listCodexProfiles().find(item => item.key === 'official')?.isDefault, true, 'list 标记 official 为当前默认');
	// official 虚拟条目只读：登录/注销均由 Codex 原生命令管理，ccq 不得删除 auth.json。
	assert.equal(existsSync(join(codexHome, 'auth.json')), true, '拒绝删除 official 不得清空 auth.json');
	// 非默认真实 profile 删除不影响 auth.json（恢复 auth.json 后验证）。
	writeFileSync(join(codexHome, 'auth.json'), '{"access_token":"secret2"}', 'utf8');
	deleteCodexProfile(key);
	assert.equal(codexProfileExists(key), false, '非默认 profile 可删除');
	assert.equal(existsSync(join(codexHome, 'auth.json')), true, '删除 API-key profile 不应清空 auth.json');
	saveCodexProfile({key: 'other', providerType: 'apiKey', baseUrl: 'https://api.example.com', apiKey: 'sk-other-token'});
	setDefaultCodexProfile('other');
	// official 未激活（auth.json 存在但默认指向 other）仍保持只读，不能绕过原生命令注销。
	assert.equal(existsSync(join(codexHome, 'auth.json')), true, '非激活态拒绝删除 official 不得清空 auth.json');
	console.log('[PASS] 5.9 Codex profile 删除保护 + official 虚拟条目默认态根治（isDefault/list/只读）');

	// ── 5.11 存量迁移：清理历史遗留 official.config.toml 空壳，保留真实供应商数据 ──
	// 空壳（无 model_provider / model_providers）→ 清理。
	writeFileSync(join(codexHome, 'official.config.toml'), '\n', 'utf8');
	assert.equal(migrateLegacyOfficialLoginFile().removed, true, '空壳 official.config.toml 被清理');
	assert.equal(existsSync(join(codexHome, 'official.config.toml')), false, '空壳文件已删除');
	// 真实供应商数据（撞名为 official 的 apiKey profile）→ 保留不动。
	writeFileSync(join(codexHome, 'official.config.toml'),
		'model_provider = "official"\n[model_providers.official]\nname = "official"\nbase_url = "https://x"\n', 'utf8');
	assert.equal(migrateLegacyOfficialLoginFile().removed, false, '撞名真实供应商 profile 不被误删');
	assert.equal(existsSync(join(codexHome, 'official.config.toml')), true, '撞名 profile 文件保留');
	console.log('[PASS] 5.11 official.config.toml 存量迁移：空壳清理 + 真实数据保留');
} finally {
	rmSync(home, {recursive: true, force: true});
}
