import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// ccq CLI 子命令回归门禁：argv 解析、provider 列表展示、无效 cc 路径。
// 重点守住「无参进 TUI」「cc 透传」「-- 分隔」「provider 名防路径穿越」等新接口不变量。

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-cli-'));
process.env.CCQ_HOME = tempHome;

try {
	const {parseCli} = await import('../src/cli/argv.ts');
	const {listProvidersForDisplay} = await import('../src/cli/commands/ls.ts');
	const {runCc} = await import('../src/cli/commands/cc.ts');

	// ── argv 解析 ───────────────────────────────────────────────────────────────
	assert.deepEqual(parseCli([]), {kind: 'tui'});
	assert.deepEqual(parseCli(['--version']), {kind: 'version'});
	assert.deepEqual(parseCli(['-v']), {kind: 'version'});
	assert.deepEqual(parseCli(['--help']), {kind: 'help'});
	assert.deepEqual(parseCli(['help', 'cc']), {kind: 'help', verb: 'cc'});
	assert.deepEqual(parseCli(['ls']), {kind: 'ls'});
	assert.deepEqual(parseCli(['use', 'glm']), {kind: 'use', name: 'glm'});
	assert.deepEqual(parseCli(['cc', 'glm']), {kind: 'cc', name: 'glm', passthrough: []});
	assert.deepEqual(parseCli(['cc', 'glm', '-p', 'hi']), {kind: 'cc', name: 'glm', passthrough: ['-p', 'hi']});
	assert.deepEqual(parseCli(['cc', 'glm', '--', '-p', 'hi', '--verbose']), {
		kind: 'cc',
		name: 'glm',
		passthrough: ['-p', 'hi', '--verbose']
	});
	assert.deepEqual(parseCli(['cc']), {kind: 'unknown', verb: 'cc', args: []});
	assert.deepEqual(parseCli(['cc', '-p', 'hi']), {kind: 'unknown', verb: 'cc', args: ['-p', 'hi']});
	assert.deepEqual(parseCli(['unknown']), {kind: 'unknown', verb: 'unknown', args: []});
	console.log('[PASS] ccq CLI argv 解析');

	// ── provider 展示 ───────────────────────────────────────────────────────────
	const lines = listProvidersForDisplay([
		{key: 'glm', baseUrl: 'https://open.bigmodel.cn/api/anthropic', hasManagedModelConfig: true, authToken: 'sk-a', profilePath: '/tmp/glm.json'},
		{key: 'kimi', baseUrl: '', hasManagedModelConfig: false, authToken: 'sk-b', profilePath: '/tmp/kimi.json'}
	], 'glm');
	assert.equal(lines[0].startsWith('* glm'), true);
	assert.equal(lines[0].includes('https://open.bigmodel.cn/api/anthropic'), true);
	assert.equal(lines[1].startsWith('  kimi'), true);
	assert.equal(lines[1].includes('(未配置 BaseUrl)'), true);
	console.log('[PASS] provider 列表展示');

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
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
}
