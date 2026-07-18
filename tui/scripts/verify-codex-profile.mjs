import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildCodexProfileToml,
	codexIdentityFromKey,
	codexProfileExists,
	codexProfileKeyFromPath,
	deleteCodexProfile,
	isOfficialLoginActive,
	isOfficialLoginKey,
	listCodexProfiles,
	migrateLegacyOfficialLoginFile,
	parseCodexProfileToml,
	redactCodexTomlForOutput,
	resolveDefaultCodexProfileKey,
	saveCodexProfile,
	saveCodexProfileToml,
	setDefaultCodexProfile,
	testCodexProfileKey,
	CODEX_OFFICIAL_LOGIN_KEY
} from '../src/core/codex.ts';

const home = mkdtempSync(join(tmpdir(), 'ccq-codex-profile-'));
process.env.CCQ_HOME = home;
// ccq 的 codexDir() 硬编码 ~/.codex（不认 CODEX_HOME，对齐上游 ccg-workflow）；
// 测试经 CCQ_HOME 注入临时 home，Codex 目录即 home/.codex。
const codexHome = join(home, '.codex');

try {
	const key = 'deepseek';
	const rawKey = 'sk-secret-should-never-leak';

	// ── 1.9 官方 profile 文件机制：--profile <key> ↔ ~/.codex/<key>.config.toml ──
	assert.equal(codexProfileKeyFromPath(join(codexHome, `${key}.config.toml`)), key,
		'profile 文件为 ~/.codex/<key>.config.toml');
	assert.equal(codexProfileKeyFromPath(join(codexHome, 'provider', `${key}.config.toml`)), key,
		'路径解析只取 basename，存储位置由 codexProfilePath/saveCodexProfile 负责限制在 ~/.codex 根');
	assert.equal(testCodexProfileKey('../bad'), false, '拒绝路径穿越 key');
	assert.equal(testCodexProfileKey('-bad'), false, '拒绝 - 开头 key');
	assert.equal(testCodexProfileKey('official'), false, '拒绝保留字 official（official login 虚拟条目专用）');
	assert.equal(isOfficialLoginKey('official'), true, 'official 被识别为 official login 虚拟条目 key');
	assert.equal(codexProfileExists('official'), false, 'official 虚拟条目无磁盘文件');
	console.log('[PASS] 1.9 Codex 官方 profile 机制：<key>.config.toml + 安全 key + official 保留字');

	// ── 1.10 provider 单一身份：只允许 key，禁独立 profileName/providerId/displayName ──
	const identity = codexIdentityFromKey(key);
	assert.deepEqual(identity, {
		filenameStem: key,
		profileName: key,
		providerId: key,
		modelProvidersTableId: key,
		defaultDisplayName: key
	}, 'Codex key 同时派生文件名/profile/provider id/table id/默认显示名');
	console.log('[PASS] 1.10 Codex provider 单一身份：仅 key，无独立 profileName/providerId/displayName');

	// ── 5.5/5.6 字段 → TOML：API key 写 experimental_bearer_token，且认证字段互斥 ──
	const toml = buildCodexProfileToml({
		key,
		providerType: 'apiKey',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: rawKey
	});
	assert.match(toml, /model_provider\s*=\s*"deepseek"/, 'profile TOML 写 model_provider');
	assert.match(toml, /experimental_bearer_token\s*=\s*"sk-secret-should-never-leak"/, 'API key 写入 experimental_bearer_token');
	assert.equal(/env_key\s*=|requires_openai_auth\s*=|\[model_providers\.deepseek\.auth\]/.test(toml), false,
		'API-key provider table 不得含 env_key/auth/requires_openai_auth');
	assert.equal(/profile\s*=\s*"deepseek"|\[profiles\.deepseek\]/.test(toml), false,
		'profile TOML 不写 legacy selector');

	// ── 5.5 TOML → 字段：textarea 内容可回填支持字段 ──
	const parsed = parseCodexProfileToml(key, toml);
	assert.equal(parsed.key, key);
	assert.equal(parsed.providerType, 'apiKey');
	assert.equal(parsed.baseUrl, 'https://api.deepseek.com');
	assert.equal(parsed.model, 'deepseek-chat');
	assert.equal(parsed.hasApiKey, true);
	console.log('[PASS] 5.5/5.6 Codex Provider 字段/TOML 双向同步 + API key 字段策略');

	// ── 5.7 official login：虚拟条目，不落盘，不接受 saveCodexProfile ──
	assert.throws(() => saveCodexProfile({key: 'official', providerType: 'officialLogin'}),
		/非法供应商名称/, 'official 保留字不可落盘为真实 profile');
	console.log('[PASS] 5.7 official login 为虚拟条目，不落盘');

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
	assert.throws(
		() => saveCodexProfileToml('other', toml),
		/model_provider 不一致/,
		'raw TOML 保存必须校验文件 key 与 model_provider 一致'
	);
	console.log('[PASS] 5.8 Codex profile 原子保存到 ~/.codex/<key>.config.toml + raw TOML 边界');

	// ── 5.10 默认设置：合并写供应商键，保留 mcp_servers/approval_policy，删除 legacy selector ──
	const baseConfigPath = join(codexHome, 'config.toml');
	writeFileSync(baseConfigPath, 'approval_policy = "on-request"\nprofile = "old"\n[profiles.old]\nmodel = "old"\n[mcp_servers.context7]\ncommand = "context7"\n', 'utf8');
	setDefaultCodexProfile(key);
	const baseConfig = readFileSync(baseConfigPath, 'utf8');
	assert.match(baseConfig, /approval_policy\s*=\s*"on-request"/, '默认切换保留非供应商配置 approval_policy');
	assert.match(baseConfig, /\[mcp_servers\.context7\]/, '默认切换保留 MCP table，不整体覆盖 config.toml');
	assert.match(baseConfig, /model_provider\s*=\s*"deepseek"/, '写入默认 model_provider');
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
	// 删除 official 虚拟条目 = 登出（清空 auth.json），不被「当前默认」保护拦截（登出即其本意）。
	deleteCodexProfile('official');
	assert.equal(existsSync(join(codexHome, 'auth.json')), false, '删除 official 虚拟条目 = 登出，清空 auth.json');
	// 非默认真实 profile 删除不影响 auth.json（恢复 auth.json 后验证）。
	writeFileSync(join(codexHome, 'auth.json'), '{"access_token":"secret2"}', 'utf8');
	deleteCodexProfile(key);
	assert.equal(codexProfileExists(key), false, '非默认 profile 可删除');
	assert.equal(existsSync(join(codexHome, 'auth.json')), true, '删除 API-key profile 不应清空 auth.json');
	saveCodexProfile({key: 'other', providerType: 'apiKey', baseUrl: 'https://api.example.com', apiKey: 'sk-other-token'});
	setDefaultCodexProfile('other');
	// official 未激活（auth.json 存在但默认指向 other）仍可被删除登出。
	deleteCodexProfile('official');
	assert.equal(existsSync(join(codexHome, 'auth.json')), false, '非激活态删除 official 仍登出清空 auth.json');
	console.log('[PASS] 5.9 Codex profile 删除保护 + official 虚拟条目默认态根治（isDefault/list/登出）');

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

	// ── 1.11 输出脱敏：raw key 不得出现在展示用文本 ──
	assert.equal(redactCodexTomlForOutput(toml).includes(rawKey), false, '展示用 TOML 必须脱敏 raw key');
	console.log('[PASS] 1.11 Codex API key 输出脱敏');
} finally {
	rmSync(home, {recursive: true, force: true});
}
