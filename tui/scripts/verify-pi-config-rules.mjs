import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ccq-pi-config-rules-'));
const project = mkdtempSync(join(tmpdir(), 'ccq-pi-project-'));
const previousCwd = process.cwd();
process.env.CCQ_HOME = home;
process.env.HOME = home;
process.chdir(project);
try {
	const {readCurrentConfigText, saveConfigText} = await import('../src/services/config-service.ts');
	const {getRulesPath, readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {piAgentsPath, piProjectSettingsPath, piSettingsPath} = await import('../src/core/paths.ts');
	mkdirSync(join(home, '.pi', 'agent'), {recursive: true});
	mkdirSync(join(project, '.pi'), {recursive: true});
	const settings = {
		deviceId: 'local-device',
		theme: 'light',
		defaultProvider: 'openai',
		auth: {openai: 'secret'},
		userUnknown: {keep: true}
	};
	const projectSettings = {theme: 'project-only'};
	writeFileSync(piSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
	writeFileSync(piProjectSettingsPath(), JSON.stringify(projectSettings, null, 2), 'utf8');
	const visible = JSON.parse(readCurrentConfigText('pi'));
	assert.equal(visible.defaultProvider, 'openai');
	const edited = {...visible, theme: 'dark', deviceId: 'foreign-device', auth: {evil: true}, newUnknown: true};
	assert.equal(saveConfigText(JSON.stringify(edited), 'pi').ok, true);
	const saved = JSON.parse(readFileSync(piSettingsPath(), 'utf8'));
	assert.equal(saved.deviceId, 'local-device');
	assert.deepEqual(saved.auth, settings.auth);
	assert.equal(saved.theme, 'dark');
	assert.equal(saved.newUnknown, true);
	assert.equal(readFileSync(piProjectSettingsPath(), 'utf8'), JSON.stringify(projectSettings, null, 2));
	assert.equal(saveRules('pi rules', 'pi').ok, true);
	assert.equal(readCurrentRules('pi'), 'pi rules');
	assert.equal(readFileSync(join(piAgentsPath()), 'utf8'), 'pi rules');
	assert.equal(getRulesPath('pi'), piAgentsPath());
	console.log('[PASS] Pi Config 普通编辑、deviceId 本机保护与 Rules 隔离');
} finally {
	process.chdir(previousCwd);
	delete process.env.CCQ_HOME;
	delete process.env.HOME;
	rmSync(home, {recursive: true, force: true});
	rmSync(project, {recursive: true, force: true});
}
