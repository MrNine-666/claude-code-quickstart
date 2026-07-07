import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// ccq CLI 子命令回归门禁：argv 解析、provider/profile 列表展示、cc/cx 无效路径与透传。
// 重点守住「无参进 TUI」「cc/cx 透传」「-- 分隔」「--tool 为管理类自有 flag」等不变量。

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-cli-'));
process.env.CCQ_HOME = tempHome;
process.env.CODEX_HOME = join(tempHome, '.codex');

try {
	const {parseCli} = await import('../src/cli/argv.ts');
	const {listProvidersForDisplay, listCodexProfilesForDisplay} = await import('../src/cli/commands/ls.ts');
	const {runCc} = await import('../src/cli/commands/cc.ts');
	const {runCx} = await import('../src/cli/commands/cx.ts');
	const {runUse} = await import('../src/cli/commands/use.ts');
	const {saveCodexProfile} = await import('../src/core/codex.ts');

	// ── argv 解析 ───────────────────────────────────────────────────────────────
	assert.deepEqual(parseCli([]), {kind: 'tui'});
	assert.deepEqual(parseCli(['--version']), {kind: 'version'});
	assert.deepEqual(parseCli(['-v']), {kind: 'version'});
	assert.deepEqual(parseCli(['--help']), {kind: 'help'});
	assert.deepEqual(parseCli(['help', 'cc']), {kind: 'help', verb: 'cc'});
	assert.deepEqual(parseCli(['help', 'cx']), {kind: 'help', verb: 'cx'});
	assert.deepEqual(parseCli(['ls']), {kind: 'ls', tool: 'claude'});
	assert.deepEqual(parseCli(['ls', '--tool', 'claude']), {kind: 'ls', tool: 'claude'});
	assert.deepEqual(parseCli(['ls', '--tool', 'codex']), {kind: 'ls', tool: 'codex'});
	assert.deepEqual(parseCli(['ls', '--tool', 'bad']), {kind: 'unknown', verb: 'ls', args: ['--tool', 'bad']});
	assert.deepEqual(parseCli(['use', 'glm']), {kind: 'use', name: 'glm', tool: 'claude'});
	assert.deepEqual(parseCli(['use', 'glm', '--tool', 'claude']), {kind: 'use', name: 'glm', tool: 'claude'});
	assert.deepEqual(parseCli(['use', 'dev', '--tool', 'codex']), {kind: 'use', name: 'dev', tool: 'codex'});
	assert.deepEqual(parseCli(['use', 'dev', '--tool', 'bad']), {kind: 'unknown', verb: 'use', args: ['dev', '--tool', 'bad']});
	assert.deepEqual(parseCli(['update']), {kind: 'update', checkOnly: false});
	assert.deepEqual(parseCli(['update', '--check']), {kind: 'update', checkOnly: true});
	assert.deepEqual(parseCli(['tools', 'update']), {kind: 'tools', action: 'update', name: undefined, assumedYes: false});
	assert.deepEqual(parseCli(['tools', 'update', 'CodeGraph']), {kind: 'tools', action: 'update', name: 'CodeGraph', assumedYes: false});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph']), {kind: 'tools', action: 'uninstall', name: 'CodeGraph', assumedYes: false});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph', '--yes']), {kind: 'tools', action: 'uninstall', name: 'CodeGraph', assumedYes: true});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph', '-y']), {kind: 'tools', action: 'uninstall', name: 'CodeGraph', assumedYes: true});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph', 'yes']), {kind: 'unknown', verb: 'tools', args: ['uninstall', 'CodeGraph', 'yes']});
	assert.deepEqual(parseCli(['uninstall']), {kind: 'uninstall', assumedYes: false});
	assert.deepEqual(parseCli(['uninstall', '--yes']), {kind: 'uninstall', assumedYes: true});
	assert.deepEqual(parseCli(['uninstall', '-y']), {kind: 'uninstall', assumedYes: true});
	assert.deepEqual(parseCli(['uninstall', 'yes']), {kind: 'unknown', verb: 'uninstall', args: ['yes']});
	assert.deepEqual(parseCli(['cc', 'glm']), {kind: 'cc', name: 'glm', passthrough: []});
	assert.deepEqual(parseCli(['cc', 'glm', '-p', 'hi']), {kind: 'cc', name: 'glm', passthrough: ['-p', 'hi']});
	assert.deepEqual(parseCli(['cc', 'glm', '--', '-p', 'hi', '--verbose']), {
		kind: 'cc',
		name: 'glm',
		passthrough: ['-p', 'hi', '--verbose']
	});
	assert.deepEqual(parseCli(['cx']), {kind: 'cx', passthrough: []});
	assert.deepEqual(parseCli(['cx', '--', '-m', 'gpt-5']), {kind: 'cx', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', '-m', 'gpt-5']), {kind: 'cx', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', 'dev']), {kind: 'cx', name: 'dev', passthrough: []});
	assert.deepEqual(parseCli(['cx', 'dev', '-m', 'gpt-5']), {kind: 'cx', name: 'dev', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', 'dev', '--', '-m', 'gpt-5']), {kind: 'cx', name: 'dev', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cc']), {kind: 'unknown', verb: 'cc', args: []});
	assert.deepEqual(parseCli(['cc', '-p', 'hi']), {kind: 'unknown', verb: 'cc', args: ['-p', 'hi']});
	assert.deepEqual(parseCli(['unknown']), {kind: 'unknown', verb: 'unknown', args: []});
	console.log('[PASS] ccq CLI argv 解析');

	// ── provider/profile 展示 ───────────────────────────────────────────────────
	const lines = listProvidersForDisplay([
		{key: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic', hasManagedModelConfig: true, authToken: 'sk-a', profilePath: '/tmp/glm.json'},
		{key: 'kimi', baseUrl: '', hasManagedModelConfig: false, authToken: 'sk-b', profilePath: '/tmp/kimi.json'}
	], 'glm');
	assert.equal(lines[0].startsWith('* glm'), true);
	assert.equal(lines[0].includes('https://open.bigmodel.cn/api/anthropic'), true);
	assert.equal(lines[1].startsWith('  kimi'), true);
	assert.equal(lines[1].includes('(未配置 BaseUrl)'), true);

	const codexLines = listCodexProfilesForDisplay([
		{key: 'dev', providerType: 'apiKey', baseUrl: 'https://api.example.com', hasApiKey: true, isDefault: true, profilePath: '/tmp/dev.config.toml'},
		{key: 'official', providerType: 'officialLogin', baseUrl: '', hasApiKey: false, isDefault: false, profilePath: '/tmp/official.config.toml'}
	]);
	assert.equal(codexLines[0].startsWith('* dev'), true);
	assert.equal(codexLines[0].includes('api key'), true);
	assert.equal(codexLines[1].includes('official login'), true);
	console.log('[PASS] provider/profile 列表展示');

	// ── cc 无效路径：不得 spawn claude ───────────────────────────────────────────
	assert.equal(await runCc('../evil', []), 1);

	const providers = join(tempHome, '.claude', 'providers');
	mkdirSync(providers, {recursive: true});
	writeFileSync(join(providers, 'broken.json'), JSON.stringify({env: {ANTHROPIC_BASE_URL: 'https://example.com'}}), 'utf8');
	assert.equal(await runCc('broken', []), 1, '缺少 ANTHROPIC_AUTH_TOKEN 的 profile 不应被当作可用 provider');

	// ── cc 正向路径：注入 fake runner 捕获 args，不触发真实 claude ────────────────
	writeFileSync(join(providers, 'glm.json'), JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'https://example.com'}}), 'utf8');
	let capturedArgs = null;
	const code = await runCc('glm', ['-p', 'hi'], async args => {
		capturedArgs = [...args];
		return 7;
	});
	assert.equal(code, 7, 'cc 应透传 claude 退出码');
	assert.deepEqual(capturedArgs, ['--settings', join(providers, 'glm.json'), '-p', 'hi']);
	console.log('[PASS] cc 子命令无效输入防护 + 正向透传');

	// ── cx 正向/反向路径：不注入 env，依赖 Codex profile TOML ────────────────────
	assert.equal(await runCx('../evil', [], async () => 0), 1, 'cx 拒绝路径穿越 profile key');
	assert.equal(await runCx('missing', [], async () => 0), 1, 'cx explicit profile 缺失时不得 spawn codex');
	let codexArgs = null;
	assert.equal(await runCx(undefined, ['--help'], async args => {
		codexArgs = [...args];
		return 0;
	}), 0, 'plain cx 应直接启动 codex');
	assert.deepEqual(codexArgs, ['--help']);

	saveCodexProfile({key: 'dev', providerType: 'apiKey', baseUrl: 'https://api.example.com', model: 'gpt-5', apiKey: 'sk-secret-should-not-print'});
	assert.equal(await runCx('dev', ['-m', 'gpt-5'], async args => {
		codexArgs = [...args];
		return 9;
	}), 9, 'cx 应透传 codex 退出码');
	assert.deepEqual(codexArgs, ['--profile', 'dev', '-m', 'gpt-5']);
	console.log('[PASS] cx 子命令 plain/profile 透传 + 不读 ccq vault/env');

	// ── use --tool codex：结构化写 base config，不写 legacy selector ─────────────
	assert.equal(runUse('dev', 'codex'), 0, 'use --tool codex 应设置默认 Codex profile');
	const baseConfig = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
	assert.match(baseConfig, /model_provider\s*=\s*"dev"/, 'Codex base config 写 model_provider');
	assert.equal(/profile\s*=\s*"dev"|\[profiles\.dev\]/.test(baseConfig), false, 'use --tool codex 不写 legacy selector');
	assert.equal(runUse('missing', 'codex'), 1, 'use --tool codex 缺 profile 时失败');
	console.log('[PASS] use --tool codex 默认切换');
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
