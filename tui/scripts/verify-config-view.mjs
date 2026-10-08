import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ccq-config-test-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
try {
	mkdirSync(join(home, '.claude'), {recursive: true});
	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	const {getConfigPath, readCurrentConfigText, saveConfigText} = await import('../src/services/config-service.ts');
	writeFileSync(getConfigPath('cc'), JSON.stringify({model: 'keep-me', env: {ANTHROPIC_AUTH_TOKEN: 'sk-x'}}, null, 2), 'utf8');
	assert.equal(saveConfigText('{"language":"简体中文"}', 'cc').ok, true);
	const claude = JSON.parse(readFileSync(getConfigPath('cc'), 'utf8'));
	assert.equal(claude.model, 'keep-me');
	assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, 'sk-x');
	assert.doesNotMatch(readCurrentConfigText('cc'), /ANTHROPIC_AUTH_TOKEN/);

	const codexPath = getConfigPath('cx');
	writeFileSync(
		codexPath,
		[
			'model = "custom-model"',
			'',
			'[model_providers.deepseek]',
			'name = "deepseek"',
			'',
			'[mcp_servers.context7]',
			'command = "npx"',
			'',
			'[hooks]'
		].join('\n'),
		'utf8'
	);
	const before = readFileSync(codexPath, 'utf8');
	const invalid = saveConfigText('model = "broken', 'cx');
	assert.equal(invalid.ok, false);
	assert.equal(readFileSync(codexPath, 'utf8'), before);
	const visible = readCurrentConfigText('cx');
	assert.doesNotMatch(visible, /custom-model|model_providers\.deepseek|mcp_servers\.context7/);
	assert.match(visible, /\[hooks\]/);
	assert.equal(saveConfigText(`${visible}\nfile_opener = "vscode"`, 'cx').ok, true);
	const after = readFileSync(codexPath, 'utf8');
	assert.match(after, /custom-model|model_providers\.deepseek|mcp_servers\.context7/);
	assert.match(after, /file_opener\s*=\s*"vscode"/);
	assert.equal(existsSync(join(home, '.claude', 'settings.json')), true);
	console.log('[PASS] Config 普通编辑、owner 保护、损坏拒写与路径隔离');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}
