import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'ccq-config-rules-reuse-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');
mkdirSync(join(home, '.claude'), {recursive: true});
mkdirSync(process.env.CODEX_HOME, {recursive: true});

try {
	const {getConfigPath, readCurrentConfigText, saveConfigText} = await import('../src/services/config-service.ts');
	const {readCurrentRules, saveRules} = await import('../src/services/prompts-service.ts');
	const {codexConfigPath, claudeDir} = await import('../src/core/paths.ts');

	writeFileSync(getConfigPath('cc'), JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'sk-claude', KEEP: 'yes'}}, null, 2), 'utf8');
	assert.equal(readCurrentConfigText('cc').includes('ANTHROPIC_AUTH_TOKEN'), false, 'Claude Config 隐藏 provider token');
	assert.equal(saveConfigText('{"env":{"KEEP":"changed"}}', 'cc').ok, true, 'Claude settings 保存成功');
	assert.equal(JSON.parse(readFileSync(getConfigPath('cc'), 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'sk-claude');

	writeFileSync(
		codexConfigPath(),
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
	const visible = readCurrentConfigText('cx');
	assert.doesNotMatch(visible, /model\s*=\s*"custom-model"/);
	assert.doesNotMatch(visible, /\[model_providers\.deepseek\]/);
	assert.doesNotMatch(visible, /\[mcp_servers\.context7\]/);
	assert.match(visible, /\[hooks\]/);
	assert.equal(saveConfigText(`${visible}\nfile_opener = "vscode"`, 'cx').ok, true, 'Codex Config 普通编辑保存成功');
	const after = readFileSync(codexConfigPath(), 'utf8');
	assert.match(after, /model\s*=\s*"custom-model"/);
	assert.match(after, /\[model_providers\.deepseek\]/);
	assert.match(after, /\[mcp_servers\.context7\]/);
	assert.match(after, /file_opener\s*=\s*"vscode"/);
	assert.equal(existsSync(getConfigPath('cc')), true);
	console.log('[PASS] Config 普通编辑 + owner 保护 + 路径隔离');

	assert.equal(saveRules('claude rules', 'cc').ok, true);
	assert.equal(saveRules('codex agents', 'cx').ok, true);
	assert.equal(readCurrentRules('cc'), 'claude rules');
	assert.equal(readCurrentRules('cx'), 'codex agents');
	assert.equal(readFileSync(join(claudeDir(), 'CLAUDE.md'), 'utf8'), 'claude rules');
	console.log('[PASS] Rules 路径隔离');
} finally {
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
	rmSync(home, {recursive: true, force: true});
}
