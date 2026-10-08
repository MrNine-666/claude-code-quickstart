import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// 配置导入导出端到端门禁（Phase 3）：
// 四工具多分类 export→import roundtrip、Codex 本机绑定过滤、加密包保密、预览零写、
// merge 保留包外条目、损坏目标阻断、分类回滚与 partial 事实、POSIX 0600、项目/cache sentinel。
// 所有路径在隔离 CCQ_HOME 下，绝不读写真实 HOME。

const root = mkdtempSync(join(tmpdir(), 'ccq-config-transfer-'));
const sourceHome = join(root, 'source');
const targetHome = join(root, 'target');
const credentialHome = join(root, 'credential');
const corruptHome = join(root, 'corrupt');
const partialHome = join(root, 'partial');
const stage = join(root, 'stage');
const projectDir = join(root, 'project');

/** 惰性路径解析：切 HOME 后所有 owner seam 都读写当前 CCQ_HOME。 */
function switchHome(home) {
	process.env.CCQ_HOME = home;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
}

switchHome(sourceHome);

const SENTINEL = 'SENTINEL-SECRET-c0ffee';
const CACHE_SENTINEL = 'CACHE-SENTINEL-do-not-export';
const PROJECT_SENTINEL = 'PROJECT-SENTINEL-do-not-touch';

const {CONFIG_BUNDLE_FORMAT, CONFIG_BUNDLE_PASSWORD_ERROR, CONFIG_BUNDLE_VERSION, createBundlePayload, decryptBundlePayload, encryptBundlePayload, readConfigBundle, serializeConfigBundle, writeConfigBundle} =
	await import('../src/core/config-transfer.ts');
const {applyConfigTransferImport, planConfigTransferExport, planConfigTransferImport} = await import('../src/core/config-transfer-plan.ts');
const {materializePortableTreeEntries} = await import('../src/core/config-transfer-sections.ts');

function homePath(...parts) {
	return join(process.env.CCQ_HOME ?? root, ...parts);
}

function writeText(path, content) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function writeJson(path, value) {
	writeText(path, JSON.stringify(value, null, 2));
}

function readText(path) {
	return readFileSync(path, 'utf8');
}

function walk(dir, prefix = '') {
	const entries = [];
	if (!existsSync(dir)) return entries;
	for (const name of readdirSync(dir).sort()) {
		const full = join(dir, name);
		const relative = prefix ? `${prefix}/${name}` : name;
		const stat = lstatSync(full);
		if (stat.isDirectory()) {
			entries.push(`d:${relative}`, ...walk(full, relative));
		} else if (stat.isSymbolicLink()) {
			entries.push(`l:${relative}:${readlinkSync(full)}`);
		} else {
			const digest = createHash('sha256').update(readFileSync(full)).digest('hex');
			entries.push(`f:${relative}:${stat.mtimeMs}:${digest}`);
		}
	}
	return entries;
}

function fileFacts(paths) {
	return JSON.stringify(
		paths.map(path => {
			try {
				const stat = statSync(path);
				return `${path}:${stat.size}:${stat.mtimeMs}:${readFileSync(path, 'utf8')}`;
			} catch {
				return `${path}:missing`;
			}
		})
	);
}

function must(result) {
	if (!result.ok) {
		throw new Error(`预期成功但失败：${result.error}`);
	}

	return result.data;
}

function treeEntry(rootId, path, content, mode = 0o644) {
	return {kind: 'file', root: rootId, path, contentBase64: Buffer.from(content, 'utf8').toString('base64'), mode};
}

function skillText(name) {
	return `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`;
}

const SOURCE_CATEGORIES = [
	{tool: 'ccq', category: 'mcp-library'},
	{tool: 'cc', category: 'providers'},
	{tool: 'cx', category: 'providers'},
	{tool: 'pi', category: 'providers'},
	{tool: 'cc', category: 'settings'},
	{tool: 'cx', category: 'settings'},
	{tool: 'pi', category: 'settings'},
	{tool: 'cc', category: 'rules'},
	{tool: 'cx', category: 'rules'},
	{tool: 'pi', category: 'rules'},
	{tool: 'cc', category: 'mcp'},
	{tool: 'cx', category: 'mcp'},
	{tool: 'pi', category: 'mcp'},
	{tool: 'cc', category: 'skills'},
	{tool: 'cx', category: 'skills'},
	{tool: 'pi', category: 'skills'},
	{tool: 'pi', category: 'extensions'}
];

function seedSourceHome() {
	writeJson(homePath('.ccq', 'mcp-meta.json'), {
		schemaVersion: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		servers: {
			shared: {config: {url: 'https://shared.example'}, credentials: {values: {TOKEN: SENTINEL}}},
			'ccq-only': {config: {url: 'https://ccq-only.example'}}
		}
	});
	writeText(homePath('.ccq', 'self-update', 'asset.bin'), CACHE_SENTINEL);
	writeJson(homePath('.claude', 'settings.json'), {
		theme: 'dark',
		env: {ANTHROPIC_BASE_URL: 'https://glm.example', ANTHROPIC_API_KEY: SENTINEL, USER_FLAG: 'keep'},
		statusLine: {type: 'source'}
	});
	writeJson(homePath('.claude', 'providers', 'glm.json'), {
		env: {ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: 'https://glm.example'}
	});
	writeText(homePath('.claude', 'CLAUDE.md'), '# source rules\n');
	writeText(homePath('.claude', 'rules', 'team.md'), 'team rule\n');
	writeText(homePath('.claude', 'skills', 'local-skill', 'SKILL.md'), skillText('local-skill'));
	writeText(homePath('.agents', 'skills', 'local-skill', 'SKILL.md'), skillText('local-skill'));
	writeText(homePath('.pi', 'agent', 'skills', 'pi-only', 'SKILL.md'), skillText('pi-only'));
	writeJson(homePath('.claude.json'), {mcpServers: {ctx: {command: 'npx', args: ['-y', 'ctx']}, 'cc-only': {url: 'https://cc-only.example'}}});
	writeText(
		homePath('.codex', 'config.toml'),
		[
			'model = "gpt-5"',
			'model_reasoning_effort = "high"',
			'[projects."C:/machine/bound"]',
			'trust_level = "trusted"',
			'[mcp_servers.ctx]',
			'command = "npx"'
		].join('\n')
	);
	writeText(homePath('.codex', 'glm.config.toml'), `[model_providers.glm]\nexperimental_bearer_token = "${SENTINEL}"\n`);
	writeText(homePath('.codex', 'AGENTS.md'), '# codex rules\n');
	writeJson(homePath('.pi', 'agent', 'settings.json'), {defaultProvider: 'openai', theme: 'dark', extensions: ['extensions/custom/src/main.ts', '/unmanaged.ts']});
	writeJson(homePath('.pi', 'agent', 'models.json'), {providers: {openai: {baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', models: [{id: 'gpt-4o'}]}}});
	writeJson(homePath('.pi', 'agent', 'auth.json'), {
		openai: {type: 'api_key', key: SENTINEL},
		'oauth-provider': {type: 'oauth', access: 'oauth-access-secret', refresh: 'oauth-refresh-secret'}
	});
	writeJson(homePath('.pi', 'agent', 'mcp.json'), {autoEnableCodemode: false, mcpServers: {'pi-ctx': {command: 'npx', args: ['-y', 'pi-ctx'], enabled: false}}});
	writeJson(homePath('.pi', 'agent', 'mcp-adapter-overrides.json'), {dialect: 'pi-native', managedServers: ['pi-ctx'], servers: {'pi-ctx': {enabled: false}}});
	writeText(homePath('.pi', 'agent', 'AGENTS.md'), '# pi rules\n');
	writeText(homePath('.pi', 'agent', 'extensions', 'custom.ts'), 'export const custom = true;\n');
	writeText(homePath('.pi', 'agent', 'extensions', 'custom', 'src', 'main.ts'), 'export default () => {};\n');
	writeText(homePath('.pi', 'agent', 'extensions', 'custom', '.env'), 'OAUTH-EXT-SECRET');
	writeJson(homePath('.pi', 'agent', 'models-store.json'), {cache: CACHE_SENTINEL});
	writeJson(join(projectDir, '.pi', 'settings.json'), {projectSentinel: PROJECT_SENTINEL});
	writeText(join(projectDir, '.pi', 'extensions', 'project-only.ts'), 'project extension\n');
}

function seedTargetHome() {
	writeJson(homePath('.claude', 'settings.json'), {theme: 'light', statusLine: {type: 'x', targetOnly: true}});
	writeJson(homePath('.claude', 'providers', 'local.json'), {env: {ANTHROPIC_BASE_URL: 'https://local.example'}});
	writeText(homePath('.claude', 'CLAUDE.md'), '# target local\n');
	writeText(homePath('.claude', 'rules', 'local-rule.md'), 'local rule\n');
	writeJson(homePath('.claude.json'), {mcpServers: {'local-only': {url: 'https://local.example'}}, otherKey: 'keep'});
	writeText(
		homePath('.codex', 'config.toml'),
		['model = "gpt-4"', 'model_reasoning_effort = "low"', '[mcp_servers.local]', 'command = "npx"'].join('\n')
	);
	writeText(homePath('.codex', 'AGENTS.md'), '# target codex rules\n');
	writeJson(homePath('.pi', 'agent', 'settings.json'), {userSetting: 'keep', theme: 'light', extensions: ['extensions/local-ext.ts']});
	writeJson(homePath('.pi', 'agent', 'models.json'), {providers: {localprovider: {baseUrl: 'https://local.example/v1', api: 'openai-completions', models: [{id: 'local-model'}]}}});
	writeJson(homePath('.pi', 'agent', 'mcp.json'), {mcpServers: {'pi-local': {command: 'npx'}}});
	writeText(homePath('.pi', 'agent', 'mcp-adapter.json'), 'ADAPTER-SENTINEL-do-not-touch');
	writeText(homePath('.pi', 'agent', 'mcp-auth.json'), 'OAUTH-MCP-SENTINEL-do-not-touch');
	writeJson(homePath('.pi', 'agent', 'mcp-adapter-overrides.json'), {servers: {'pi-local': {enabled: true}}, managedServers: ['pi-local']});
	writeText(homePath('.pi', 'agent', 'AGENTS.md'), '# target pi rules\n');
	writeText(homePath('.pi', 'agent', 'extensions', 'local-ext.ts'), 'export const local = true;\n');
	writeJson(homePath('.pi', 'agent', 'models-store.json'), {cache: 'target-cache-sentinel'});
	writeJson(join(projectDir, '.pi', 'settings.json'), {projectSentinel: PROJECT_SENTINEL});
	writeText(join(projectDir, '.pi', 'extensions', 'project-only.ts'), 'project extension\n');
}

/** 从 bundle 的 skills section 构造确定性 lifecycle stub：canonical + 目标投影。 */
function skillsMaterializeFrom(payload) {
	const section = payload.sections.find(item => item.category === 'skills');
	const skills = section ? (section.data.skills ?? []) : [];
	const filesByName = new Map(skills.map(skill => [skill.name, skill.files]));
	return async ({name, targets}) => {
		const files = filesByName.get(name) ?? [];
		const agentsRoot = homePath('.agents', 'skills');
		const canonical = materializePortableTreeEntries(agentsRoot, files, false);
		if (!canonical.ok) return {ok: false, error: `canonical 物化失败：${name}`};
		if (targets.includes('cc')) {
			const claude = materializePortableTreeEntries(homePath('.claude', 'skills'), files, false);
			if (!claude.ok) return {ok: false, error: `cc 物化失败：${name}`};
		}
		if (targets.includes('pi')) {
			const linkPath = homePath('.pi', 'agent', 'skills', name);
			rmSync(linkPath, {recursive: true, force: true});
			mkdirSync(dirname(linkPath), {recursive: true});
			symlinkSync(join(agentsRoot, name), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
		}
		return {ok: true};
	};
}

function importOptions(materialize) {
	return {homeDir: process.env.CCQ_HOME ?? root, tempDir: stage, projectDir, ...(materialize ? {materialize} : {})};
}

try {
	mkdirSync(stage, {recursive: true});
	mkdirSync(projectDir, {recursive: true});
	switchHome(sourceHome);
	seedSourceHome();

	// ── 1. 导出：明文包、Codex 过滤、cache/project 排除 ─────────────────────────
	const plainExport = await planConfigTransferExport({categories: SOURCE_CATEGORIES, includeCredentials: false}, {skills: {homeDir: process.env.CCQ_HOME ?? root, tempDir: stage}});
	assert.equal(plainExport.ok, true, '明文导出计划必须成功');
	const plainSectionsText = JSON.stringify(plainExport.data.sections);
	assert.equal(plainSectionsText.includes(SENTINEL), false, '未选凭据时包内容不得含 sentinel');
	assert.equal(plainSectionsText.includes(CACHE_SENTINEL), false, 'self-update/models-store cache 不得进入包');
	assert.equal(plainSectionsText.includes(PROJECT_SENTINEL), false, '项目 .pi 内容不得进入包');
	assert.equal(plainSectionsText.includes('OAUTH-EXT-SECRET'), false, '已知认证文件不得进入包');
	const extensionsSection = plainExport.data.sections.find(section => section.category === 'extensions');
	assert.deepEqual(extensionsSection?.data.explicitEntries, ['extensions/custom/src/main.ts'], '只允许受管的显式扩展入口');
	assert.equal(plainExport.data.containsCredentials, false, '未选凭据时 union fact 必须为 false');
	assert.equal(plainSectionsText.includes('projects'), false, 'Codex projects trust 必须被过滤');
	assert.equal(plainSectionsText.includes('model_reasoning_effort'), true, 'Codex 可迁移键必须保留');

	const plainCreated = createBundlePayload({sections: plainExport.data.sections, containsCredentials: false, version: 'test', platform: 'test'});
	assert.equal(plainCreated.ok, true, '明文 payload 必须通过校验');
	const plainPayload = plainCreated.data;
	const plainBundlePath = join(root, 'plain.ccq-backup');
	const plainEnvelope = {format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload: plainPayload};
	assert.equal(writeConfigBundle(plainBundlePath, plainEnvelope).ok, true, '明文包必须可写盘');
	assert.equal(readText(plainBundlePath).includes(SENTINEL), false, '明文包字节不得含 sentinel');
	assert.equal(readText(plainBundlePath).includes(CACHE_SENTINEL), false, '明文包字节不得含 cache sentinel');

	// ── 2. 加密导出：包字节保密、错误密码统一失败 ─────────────────────────────
	const credentialExport = await planConfigTransferExport({categories: SOURCE_CATEGORIES, includeCredentials: true}, {skills: {homeDir: process.env.CCQ_HOME ?? root, tempDir: stage}});
	assert.equal(credentialExport.ok, true, '含凭据导出计划必须成功');
	assert.equal(credentialExport.data.containsCredentials, true, '含凭据时 union fact 必须为 true');
	const credentialCreated = createBundlePayload({
		sections: credentialExport.data.sections,
		containsCredentials: true,
		version: 'test',
		platform: 'test'
	});
	assert.equal(credentialCreated.ok, true, '含凭据 payload 必须通过校验');
	const credentialPayload = credentialCreated.data;
	const optOutPath = join(root, 'unencrypted-with-keys.ccq-backup');
	assert.equal(writeConfigBundle(optOutPath, {format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload: credentialPayload}).ok, true, '显式选择不加密仍可导出文件型凭据');
	const optOutBundle = must(readConfigBundle(optOutPath));
	assert.equal(optOutBundle.encryption, null);
	assert.equal(optOutBundle.payload.containsCredentials, true);
	assert.equal(readText(optOutPath).includes('oauth-access-secret'), false, '明文包仍不得携带 OAuth');
	assert.equal(readText(optOutPath).includes('OAUTH-EXT-SECRET'), false, '明文包仍不得携带认证文件');
	const encrypted = await encryptBundlePayload(credentialPayload, 'correct horse battery');
	assert.equal(encrypted.ok, true, '加密必须成功');
	const encryptedPath = join(root, 'encrypted.ccq-backup');
	assert.equal(writeConfigBundle(encryptedPath, encrypted.data).ok, true, '加密包必须可写盘');
	const encryptedBytes = readFileSync(encryptedPath, 'utf8');
	assert.equal(encryptedBytes.includes(SENTINEL), false, '密文不得出现 sentinel 明文');
	assert.equal(encryptedBytes.includes('oauth-access-secret'), false, 'OAuth 令牌不得进入包');

	const loadedEncrypted = readConfigBundle(encryptedPath);
	assert.equal(loadedEncrypted.ok, true, '加密包必须可读回');
	const noPassword = await decryptBundlePayload(loadedEncrypted.data);
	assert.equal(noPassword.ok, false, '无密码必须拒绝解密');
	const wrongPassword = await decryptBundlePayload(loadedEncrypted.data, 'wrong password');
	assert.equal(wrongPassword.ok, false, '错误密码必须失败');
	if (!wrongPassword.ok) assert.equal(wrongPassword.error, CONFIG_BUNDLE_PASSWORD_ERROR, '错误密码必须使用统一文案');
	const decrypted = await decryptBundlePayload(loadedEncrypted.data, 'correct horse battery');
	assert.equal(decrypted.ok, true, '正确密码必须解密');
	const decryptedPayload = must(decrypted);
	assert.equal(JSON.stringify(decryptedPayload.sections).includes(SENTINEL), true, '正确密码下凭据必须可读');

	// ── 3. 明文 roundtrip：预览零写、merge 保留包外条目 ─────────────────────────
	switchHome(targetHome);
	seedTargetHome();
	const projectSettingsPath = join(projectDir, '.pi', 'settings.json');
	const projectExtensionPath = join(projectDir, '.pi', 'extensions', 'project-only.ts');
	const modelsStorePath = homePath('.pi', 'agent', 'models-store.json');
	const selfUpdatePath = homePath('.ccq', 'self-update', 'asset.bin');
	const sentinelPaths = [projectSettingsPath, projectExtensionPath, modelsStorePath, selfUpdatePath, homePath('.pi', 'agent', 'mcp-adapter.json'), homePath('.pi', 'agent', 'mcp-auth.json')];
	const sentinelBefore = fileFacts(sentinelPaths);
	const targetTreeBefore = walk(targetHome);

	const preview = await planConfigTransferImport(plainPayload, {skills: importOptions(null)});
	assert.equal(preview.ok, true, '导入预览必须成功');
	const previewPlan = must(preview);
	const previewTreeAfter = walk(targetHome);
	assert.deepEqual(previewTreeAfter, targetTreeBefore, '预览必须零写盘（字节/mtime/文件集不变）');
	assert.equal(JSON.stringify(previewPlan).includes(SENTINEL), false, '预览不得含凭据值');
	assert.equal(JSON.stringify(previewPlan).includes(root), false, '预览不得含绝对 HOME 路径');
	assert.equal(previewPlan.items.length, plainPayload.sections.length, '预览必须覆盖包内全部分类');
	assert.equal(previewPlan.items.some(item => item.status === 'blocked'), false, '正常目标不应有 blocked 分类');

	const materialize = skillsMaterializeFrom(plainPayload);
	const applied = await applyConfigTransferImport(plainPayload, preview.data, [], {tempDir: stage, skills: importOptions(materialize)});
	assert.equal(applied.ok, true, '导入执行必须返回 typed outcome');
	const appliedOutcome = must(applied);
	assert.equal(appliedOutcome.status, 'complete', `roundtrip 必须完整成功：${JSON.stringify(appliedOutcome.failed)}`);
	assert.equal(appliedOutcome.completed.length, previewPlan.items.length, '全部分类必须完成');
	assert.equal(JSON.stringify(appliedOutcome).includes(SENTINEL), false, '结果不得含凭据值');
	assert.equal(JSON.stringify(appliedOutcome).includes(root), false, '结果不得含绝对 HOME 路径');

	const claudeSettings = JSON.parse(readText(homePath('.claude', 'settings.json')));
	assert.equal(claudeSettings.theme, 'dark', '通用设置必须导入');
	assert.equal(claudeSettings.env.USER_FLAG, 'keep', '非凭据 env 必须迁移');
	assert.equal(claudeSettings.env.ANTHROPIC_API_KEY, undefined, '未选凭据时 settings.json 的 API Key 不得进入包也不得写入目标');
	assert.equal(claudeSettings.statusLine.type, 'source', '同字段必须使用包值');
	assert.equal(claudeSettings.statusLine.targetOnly, true, '未冲突的本机字段必须保留');
	assert.equal(readText(homePath('.claude', 'providers', 'glm.json')).includes('glm.example'), true, '供应商 profile 必须导入');
	assert.equal(readText(homePath('.claude', 'providers', 'glm.json')).includes(SENTINEL), false, '未选凭据时 profile 不得含 sentinel');
	assert.equal(readText(homePath('.claude', 'providers', 'local.json')).includes('local.example'), true, '本机独有供应商必须保留');
	assert.equal(readText(homePath('.claude', 'CLAUDE.md')), '# source rules\n', '规则必须覆盖');
	assert.equal(readText(homePath('.claude', 'rules', 'local-rule.md')), 'local rule\n', '本机独有规则必须保留');
	assert.equal(readText(homePath('.claude', 'rules', 'team.md')), 'team rule\n', '新规则必须新增');
	const claudeJson = JSON.parse(readText(homePath('.claude.json')));
	assert.equal(claudeJson.mcpServers.ctx.command, 'npx', 'MCP server 必须导入');
	assert.equal(claudeJson.mcpServers['local-only'].url, 'https://local.example', '本机独有 MCP server 必须保留');
	assert.equal(claudeJson.otherKey, 'keep', '未冲突本机字段必须保留');
	const codexText = readText(homePath('.codex', 'config.toml'));
	assert.equal(codexText.includes('[mcp_servers.ctx]'), true, 'Codex MCP 必须导入');
	assert.equal(codexText.includes('[mcp_servers.local]'), true, '本机独有 Codex MCP 必须保留');
	assert.equal(codexText.includes('model_reasoning_effort = "high"'), true, 'Codex 可迁移设置必须导入');
	assert.equal(codexText.includes('projects'), false, '包内不得携带 projects，目标也不得新增');
	const piModels = JSON.parse(readText(homePath('.pi', 'agent', 'models.json')));
	assert.equal(Object.hasOwn(piModels.providers, 'openai'), true, 'Pi 供应商必须导入');
	assert.equal(Object.hasOwn(piModels.providers, 'localprovider'), true, '本机独有 Pi 供应商必须保留');
	assert.equal(existsSync(homePath('.pi', 'agent', 'auth.json')), false, '未选凭据时不得创建 auth.json');
	const piMcp = JSON.parse(readText(homePath('.pi', 'agent', 'mcp.json')));
	assert.equal(piMcp.mcpServers['pi-ctx'].enabled, false, 'Native disabled activation must roundtrip');
	assert.equal(piMcp.autoEnableCodemode, false, 'Native root setting must roundtrip');
	assert.equal(Object.hasOwn(piMcp.mcpServers, 'pi-ctx'), true, 'Pi MCP 必须导入');
	assert.equal(Object.hasOwn(piMcp.mcpServers, 'pi-local'), true, '本机独有 Pi MCP 必须保留');
	assert.equal(readText(homePath('.pi', 'agent', 'AGENTS.md')), '# pi rules\n', 'Pi 规则必须覆盖');
	assert.equal(readText(homePath('.pi', 'agent', 'extensions', 'custom.ts')), 'export const custom = true;\n', 'Pi Extension 必须导入');
	assert.equal(readText(homePath('.pi', 'agent', 'extensions', 'custom', 'src', 'main.ts')), 'export default () => {};\n');
	assert.deepEqual(JSON.parse(readText(homePath('.pi', 'agent', 'settings.json'))).extensions, ['extensions/local-ext.ts', 'extensions/custom/src/main.ts'], '深层显式入口与本机独有入口均保留');
	assert.equal(readText(homePath('.pi', 'agent', 'extensions', 'local-ext.ts')), 'export const local = true;\n', '本机独有 Extension 必须保留');
	assert.equal(existsSync(homePath('.agents', 'skills', 'local-skill', 'SKILL.md')), true, 'Skill 内容必须恢复');
	assert.equal(existsSync(homePath('.claude', 'skills', 'local-skill', 'SKILL.md')), true, 'Claude Skill 投影必须恢复');
	assert.equal(lstatSync(homePath('.pi', 'agent', 'skills', 'pi-only')).isSymbolicLink(), true, 'Pi Skill 投影必须恢复');

	assert.equal(fileFacts(sentinelPaths), sentinelBefore, '项目 .pi 与 cache sentinel 必须字节不变');
	assert.equal(readText(modelsStorePath).includes('target-cache-sentinel'), true, 'models-store.json 必须保持本机内容');

	// ── 4. 加密包导入：凭据落盘、OAuth 排除、POSIX 0600 ────────────────────────
	rmSync(homePath('.claude'), {recursive: true, force: true});
	rmSync(homePath('.agents'), {recursive: true, force: true});
	rmSync(homePath('.codex'), {recursive: true, force: true});
	rmSync(homePath('.pi'), {recursive: true, force: true});
	rmSync(homePath('.ccq'), {recursive: true, force: true});
	rmSync(homePath('.claude.json'), {force: true});
	switchHome(credentialHome);
	const credentialPreview = await planConfigTransferImport(decrypted.data, {skills: importOptions(null)});
	assert.equal(credentialPreview.ok, true, '含凭据预览必须成功');
	const credentialPlan = must(credentialPreview);
	const credentialApply = await applyConfigTransferImport(decryptedPayload, credentialPlan, [], {
		tempDir: stage,
		skills: importOptions(skillsMaterializeFrom(decryptedPayload))
	});
	const credentialOutcome = must(credentialApply);
	assert.equal(credentialOutcome.status, 'complete', `含凭据导入必须完整成功：${JSON.stringify(credentialOutcome.failed)}`);
	assert.equal(readText(homePath('.pi', 'agent', 'auth.json')).includes(SENTINEL), true, '选择凭据后 auth.json 必须含 API Key');
	assert.equal(readText(homePath('.pi', 'agent', 'auth.json')).includes('oauth-provider'), false, 'OAuth 条目必须被排除');
	assert.equal(Object.hasOwn(JSON.parse(readText(homePath('.pi', 'agent', 'models.json'))).providers, 'openai'), true, '新目标 Pi 必须使用原生 providers 根');
	assert.equal(readText(homePath('.claude', 'providers', 'glm.json')).includes(SENTINEL), true, '选择凭据后 profile 必须含 token');
	if (process.platform !== 'win32') {
		for (const sensitive of [
			homePath('.claude', 'providers', 'glm.json'),
			homePath('.claude', 'settings.json'),
			homePath('.pi', 'agent', 'auth.json'),
			homePath('.pi', 'agent', 'models.json'),
			homePath('.pi', 'agent', 'mcp.json')
		]) {
			assert.equal(statSync(sensitive).mode & 0o777, 0o600, `敏感文件必须保持 0600：${sensitive}`);
		}

		assert.equal(statSync(plainBundlePath).mode & 0o777, 0o600, '导出包必须使用保守权限');
		assert.equal(statSync(optOutPath).mode & 0o777, 0o600, '含凭据明文包仍为 0600');
	}

	// ── 5. 损坏目标阻断：预览 blocked、apply 跳过且字节不变 ─────────────────────
	rmSync(homePath('.claude'), {recursive: true, force: true});
	switchHome(corruptHome);
	writeText(homePath('.claude', 'settings.json'), '{broken');
	const corruptPayloadCreated = createBundlePayload({
		sections: [{tool: 'cc', category: 'settings', data: {text: '{"theme":"dark"}'}}],
		containsCredentials: false,
		version: 'test',
		platform: 'test'
	});
	assert.equal(corruptPayloadCreated.ok, true, '损坏场景 payload 必须合法');
	const corruptPayload = corruptPayloadCreated.data;
	const corruptPreview = await planConfigTransferImport(corruptPayload, {skills: importOptions(null)});
	assert.equal(corruptPreview.ok, true, '损坏目标预览仍必须返回计划');
	const corruptPlan = must(corruptPreview);
	assert.equal(corruptPlan.items[0]?.status, 'blocked', '损坏本机配置必须阻断对应分类');
	const corruptBytes = readText(homePath('.claude', 'settings.json'));
	const corruptOutcome = await applyConfigTransferImport(corruptPayload, corruptPlan, [], {tempDir: stage, skills: importOptions(null)});
	const corruptResult = must(corruptOutcome);
	assert.equal(corruptResult.status, 'complete', '阻断分类跳过不影响整体完成');
	assert.equal(corruptResult.skipped.length, 1, '阻断分类必须被跳过');
	assert.equal(readText(homePath('.claude', 'settings.json')), corruptBytes, '损坏文件原字节必须保持不变');

	// ── 6. 分类中途失败回滚 + partial 事实 ─────────────────────────────────────
	rmSync(homePath('.claude'), {recursive: true, force: true});
	rmSync(homePath('.pi'), {recursive: true, force: true});
	switchHome(partialHome);
	writeText(homePath('.claude', 'settings.json'), JSON.stringify({theme: 'light'}));
	writeText(homePath('.pi', 'agent', 'extensions', 'good.ts'), 'OLD BYTES');
	writeText(homePath('.pi', 'agent', 'extensions', 'conflict.ts', 'inner.txt'), 'inner');
	const partialPayloadCreated = createBundlePayload({
		sections: [
			{tool: 'cc', category: 'settings', data: {text: '{"theme":"dark"}'}},
			{
				tool: 'pi',
				category: 'extensions',
				data: {entries: [treeEntry('pi-agent', 'good.ts', 'NEW BYTES'), treeEntry('pi-agent', 'conflict.ts', 'x')]}
			}
		],
		containsCredentials: false,
		version: 'test',
		platform: 'test'
	});
	assert.equal(partialPayloadCreated.ok, true, 'partial 场景 payload 必须合法');
	const partialPayload = partialPayloadCreated.data;
	const partialPreview = await planConfigTransferImport(partialPayload, {skills: importOptions(null)});
	assert.equal(partialPreview.ok, true, 'partial 场景预览必须成功');
	const partialPlan = must(partialPreview);
	const partialOutcome = await applyConfigTransferImport(partialPayload, partialPlan, [], {tempDir: stage, skills: importOptions(null)});
	const partialResult = must(partialOutcome);
	assert.equal(partialResult.status, 'partial', '后类失败必须返回 partial');
	assert.deepEqual(partialResult.completed, [{tool: 'cc', category: 'settings'}], 'partial 必须报告真实 completed 集合');
	assert.deepEqual(
		partialResult.failed.map(failure => `${failure.tool}:${failure.category}`),
		['pi:extensions'],
		'partial 必须报告真实 failed 集合'
	);
	assert.equal(partialResult.failed[0]?.restored, true, '失败分类必须完成回滚');
	assert.equal(readText(homePath('.pi', 'agent', 'extensions', 'good.ts')), 'OLD BYTES', '失败分类必须完整恢复原字节');
	assert.equal(readText(homePath('.pi', 'agent', 'extensions', 'conflict.ts', 'inner.txt')), 'inner', '冲突目录必须保持原样');
	assert.equal(JSON.parse(readText(homePath('.claude', 'settings.json'))).theme, 'dark', '已完成分类必须保留结果');

	// ── 7. 已存在本机 symlink 跳出受管 root：预览阻断，旧计划执行也不能越界 ────
	const escapeHome = join(root, 'escape');
	const outside = join(root, 'outside');
	switchHome(escapeHome);
	writeText(join(outside, 'file.ts'), 'OUTSIDE-ORIGINAL');
	mkdirSync(homePath('.pi', 'agent', 'extensions'), {recursive: true});
	const escapePayload = must(createBundlePayload({
		sections: [{tool: 'pi', category: 'extensions', data: {entries: [treeEntry('pi-agent', 'alias/file.ts', 'MALICIOUS')]}}],
		containsCredentials: false, version: 'test', platform: 'test'
	}));
	const stalePlan = must(await planConfigTransferImport(escapePayload));
	symlinkSync(outside, homePath('.pi', 'agent', 'extensions', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
	const blockedPreview = must(await planConfigTransferImport(escapePayload));
	assert.equal(blockedPreview.items[0]?.status, 'blocked', '本机 symlink 越界必须在预览阻断');
	const staleResult = must(await applyConfigTransferImport(escapePayload, stalePlan, [], {tempDir: stage}));
	assert.equal(staleResult.completed.length, 0, '预览后的 symlink 替换不得绕过执行时检查');
	assert.equal(readText(join(outside, 'file.ts')), 'OUTSIDE-ORIGINAL', '受管目录外字节不得改变');

	// ── 8. bundle 序列化与 project/cache 负向断言收尾 ──────────────────────────
	const serialized = serializeConfigBundle(plainEnvelope);
	assert.equal(serialized.ok, true, '明文包必须可序列化');
	if (serialized.ok) {
		assert.equal(serialized.data.includes(SENTINEL), false, '序列化包不得含 sentinel');
		assert.equal(serialized.data.includes(CACHE_SENTINEL), false, '序列化包不得含 cache sentinel');
		assert.equal(serialized.data.includes(PROJECT_SENTINEL), false, '序列化包不得含项目 sentinel');
	}

	console.log(
		'[PASS] Config Transfer：四工具 roundtrip、明文含密钥/密文包、Pi 深层入口、symlink 越界、预览零写、回滚/partial、POSIX 0600 与项目/cache sentinel'
	);
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.HOME;
	delete process.env.USERPROFILE;
	rmSync(root, {recursive: true, force: true});
}