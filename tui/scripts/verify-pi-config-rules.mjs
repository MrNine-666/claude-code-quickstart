import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ccq-pi-config-rules-'));
const project = mkdtempSync(join(tmpdir(), 'ccq-pi-project-'));
const previousCwd = process.cwd();
process.env.CCQ_HOME = home;
process.env.HOME = home;
process.chdir(project);

try {
	const {
		fillMissingIntoText,
		getConfigPath,
		loadRecommendationAnnotated,
		readCurrentConfigText,
		saveConfigText
	} = await import('../src/services/config-service.ts');
	const {getRulesPath, readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {piAgentsPath, piProjectSettingsPath, piSettingsPath} = await import('../src/core/paths.ts');

	mkdirSync(join(home, '.pi', 'agent'), {recursive: true});
	mkdirSync(join(project, '.pi'), {recursive: true});
	const globalSettings = {
		theme: 'light',
		quietStartup: false,
		defaultProvider: 'openai',
		defaultModel: 'gpt-4o',
		defaultThinkingLevel: 'high',
		auth: {openai: 'secret'},
		mcp: {context7: {command: 'keep'}},
		userUnknown: {keep: true}
	};
	const projectSettings = {theme: 'project-only', projectUnknown: {keep: true}};
	writeFileSync(piSettingsPath(), JSON.stringify(globalSettings, null, 2), 'utf8');
	writeFileSync(piProjectSettingsPath(), JSON.stringify(projectSettings, null, 2), 'utf8');

	assert.equal(getConfigPath('pi'), piSettingsPath(), 'Pi Config 必须指向 ~/.pi/agent/settings.json');
	const visible = readCurrentConfigText('pi');
	const visibleJson = JSON.parse(visible);
	assert.equal(visibleJson.theme, 'light');
	assert.equal(visibleJson.userUnknown.keep, true, '未知字段应可保留在展示数据中');
	assert.equal(visibleJson.defaultProvider, undefined, 'Provider 默认值不得进入 Config 编辑缓冲');
	assert.equal(visibleJson.auth, undefined, '认证字段不得进入 Config 编辑缓冲');
	assert.equal(visibleJson.mcp, undefined, 'MCP 字段不得进入 Config 编辑缓冲');

	const recommendation = loadRecommendationAnnotated('pi') ?? '';
	assert.match(recommendation, /"theme": "dark"/, 'Pi 推荐配置应来自 pi-config contract');
	const filled = fillMissingIntoText(JSON.stringify({...visibleJson, mcp: {evil: true}}, null, 2), 'pi');
	assert.equal(filled.ok, true, 'Pi fill-missing 应接受当前编辑缓冲');
	if (filled.ok) {
		assert.match(filled.text, /"terminalTitle": true/, 'Pi fill-missing 应补齐推荐 defaults');
		assert.equal(JSON.parse(filled.text).mcp, undefined, 'Pi fill-missing 不得把受保护字段留在编辑缓冲');
	}

	const edited = JSON.stringify({
		...visibleJson,
		theme: 'dark',
		defaultProvider: 'evil-provider',
		mcp: {evil: true},
		userUnknown: {changed: true},
		newUnknown: {created: true}
	}, null, 2);
	const saved = saveConfigText(edited, 'pi');
	assert.equal(saved.ok, true, 'Pi Config 保存应成功');
	const afterSave = JSON.parse(readFileSync(piSettingsPath(), 'utf8'));
	assert.equal(afterSave.theme, 'dark', 'owned 字段应可编辑');
	assert.equal(afterSave.defaultProvider, 'openai', 'Provider 默认值必须保留原值');
	assert.deepEqual(afterSave.mcp, globalSettings.mcp, 'MCP 配置必须保留原值');
	assert.deepEqual(afterSave.auth, globalSettings.auth, '认证字段必须保留原值');
	assert.deepEqual(afterSave.userUnknown, {changed: true}, '未知字段应允许编辑');
	assert.deepEqual(afterSave.newUnknown, {created: true}, '未知字段应允许新增');
	assert.equal(readFileSync(piProjectSettingsPath(), 'utf8'), JSON.stringify(projectSettings, null, 2), '项目 .pi/settings.json 必须保持原样');
	// Windows 不提供可移植的 POSIX mode 位；生产写入仍传入 SECRET_FILE_MODE，
	// 但 Node 在 Windows 上的 stat().mode 不能用来验证 ACL。
	if (process.platform !== 'win32') {
		assert.equal(statSync(piSettingsPath()).mode & 0o777, 0o600, 'Pi settings.json 必须使用 0600');
	}

	const malformedBefore = readFileSync(piSettingsPath(), 'utf8');
	writeFileSync(piSettingsPath(), '{broken settings', 'utf8');
	const malformed = saveConfigText('{"theme":"dark"}', 'pi');
	assert.equal(malformed.ok, false, '损坏 Pi settings 必须拒绝写入');
	assert.equal(readFileSync(piSettingsPath(), 'utf8'), '{broken settings', '损坏 Pi settings 不得被覆盖');
	writeFileSync(piSettingsPath(), malformedBefore, 'utf8');

	assert.equal(getRulesPath('pi'), piAgentsPath(), 'Pi 全局规则必须指向 ~/.pi/agent/AGENTS.md');
	assert.equal(readCurrentRules('pi'), null, 'Pi 全局规则缺失时应返回 null');
	const projectAgents = join(project, '.pi', 'AGENTS.md');
	const projectSystem = join(project, '.pi', 'SYSTEM.md');
	const projectAppendSystem = join(project, '.pi', 'APPEND_SYSTEM.md');
	writeFileSync(projectAgents, 'project agents', 'utf8');
	writeFileSync(projectSystem, 'project system', 'utf8');
	writeFileSync(projectAppendSystem, 'project append system', 'utf8');
	const rulesSave = saveRules('global pi agents', 'pi');
	assert.equal(rulesSave.ok, true, 'Pi 全局规则保存应成功');
	assert.equal(readCurrentRules('pi'), 'global pi agents', 'Pi 规则应写入全局 AGENTS.md');
	assert.equal(readFileSync(projectAgents, 'utf8'), 'project agents', '项目 .pi/AGENTS.md 不得被改写');
	assert.equal(readFileSync(projectSystem, 'utf8'), 'project system', '项目 SYSTEM.md 不得被改写');
	assert.equal(readFileSync(projectAppendSystem, 'utf8'), 'project append system', '项目 APPEND_SYSTEM.md 不得被改写');
	assert.equal(readFileSync(piAgentsPath(), 'utf8'), 'global pi agents');

	console.log('[PASS] Pi Config/Rules：受保护字段隔离、未知字段编辑/新增、项目只读、AGENTS.md 目标隔离与损坏拒写门禁全部通过');
} finally {
	process.chdir(previousCwd);
	delete process.env.CCQ_HOME;
	delete process.env.HOME;
	rmSync(home, {recursive: true, force: true});
	rmSync(project, {recursive: true, force: true});
}
