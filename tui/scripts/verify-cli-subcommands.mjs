import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// [P5a 迁走] argv 解析 / help 文本 / 工具 registry 投影 / provider-profile 列表展示 →
//            tests/core/cli-subcommands.test.ts。
// 本脚本只保留真实落盘段：`use --tool codex` 写 CODEX_HOME/config.toml 与 `ls --tool pi` 读 ~/.pi 字节。
// ccq CLI 子命令回归门禁：argv 解析、help、provider/profile 列表展示与管理命令。
// 重点守住「无参进 TUI」「cc/cx 不再是命令」「--tool 为管理类自有 flag」等不变量。

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-cli-'));
process.env.CCQ_HOME = tempHome;
process.env.CODEX_HOME = join(tempHome, '.codex');

try {
	const {parseCli} = await import('../src/cli/argv.ts');
	const {runCli} = await import('../src/cli/index.ts');
	const {runLs} = await import('../src/cli/commands/ls.ts');
	const {runUse} = await import('../src/cli/commands/use.ts');
	const {saveCodexProfile} = await import('../src/core/codex.ts');
	const {piAuthJsonPath, piModelsJsonPath, piSettingsPath} = await import('../src/core/paths.ts');

	// ── use --tool codex：结构化写 base config，不写 legacy selector ─────────────
	saveCodexProfile({
		key: 'dev',
		providerType: 'apiKey',
		baseUrl: 'https://api.example.com',
		model: 'gpt-5',
		apiKey: 'sk-secret-should-not-print'
	});
	assert.equal(runUse('dev', 'codex'), 0, 'use --tool codex 应设置默认 Codex profile');
	const baseConfig = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
	assert.match(baseConfig, /model_provider\s*=\s*"dev"/, 'Codex base config 写 model_provider');
	assert.equal(/profile\s*=\s*"dev"|\[profiles\.dev\]/.test(baseConfig), false, 'use --tool codex 不写 legacy selector');
	assert.equal(runUse('missing', 'codex'), 1, 'use --tool codex 缺 profile 时失败');

	// use official --tool codex：激活 official 虚拟条目 = 清空 config.toml 供应商键（不校验文件存在）。
	assert.equal(runUse('official', 'codex'), 0, 'use official --tool codex 激活官方登录态');
	const officialConfig = readFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
	assert.equal(/model_provider\s*=/.test(officialConfig), false, 'official 激活清空 model_provider');
	console.log('[PASS] use --tool codex 默认切换 + official 虚拟条目激活');

	// ── ls --tool pi 保持只读；use --tool pi 已移除 ────────────────────────────
	mkdirSync(join(tempHome, '.pi', 'agent'), {recursive: true});
	writeFileSync(piModelsJsonPath(), JSON.stringify({providers: {openai: {models: ['gpt-4o']}}}, null, 2), 'utf8');
	writeFileSync(piAuthJsonPath(), JSON.stringify({openai: 'sk-pi-secret'}, null, 2), 'utf8');
	writeFileSync(piSettingsPath(), JSON.stringify({defaultProvider: 'anthropic', defaultModel: 'claude-sonnet'}, null, 2), 'utf8');
	const piSettingsBeforeUse = readFileSync(piSettingsPath(), 'utf8');
	const piOutput = [];
	const piErrors = [];
	const originalLog = console.log;
	const originalPiError = console.error;
	console.log = (...args) => piOutput.push(args.join(' '));
	console.error = (...args) => piErrors.push(args.join(' '));
	try {
		assert.equal(runLs('pi'), 0, 'ls --tool pi 应成功');
		assert.equal(await runCli(parseCli(['use', 'openai', '--tool', 'pi'])), 1, '实际 CLI 路径必须拒绝 use --tool pi');
		assert.equal(runUse('openai', 'pi'), 1, 'defensive handler 必须拒绝 use --tool pi');
	} finally {
		console.log = originalLog;
		console.error = originalPiError;
	}
	assert.equal(
		piOutput.some(line => line.includes('openai') && line.includes('models')),
		true,
		'ls --tool pi 应按 provider 展示模型数量'
	);
	assert.equal(
		piErrors.some(line => line.includes('Pi 配置页') && line.includes('defaultProvider')),
		true,
		'实际 CLI 与 defensive handler 都必须指向 Pi Config'
	);
	assert.equal(
		piErrors.some(line => line.includes('用法: ccq use <name> [--tool claude|codex|pi]')),
		false,
		'被拒绝的 CLI 用法不得继续宣传 Pi target'
	);
	assert.equal(readFileSync(piSettingsPath(), 'utf8'), piSettingsBeforeUse, '被拒绝的 use --tool pi 不得写 settings.json');
	console.log('[PASS] ls --tool pi 只读展示；use --tool pi 已移除且不写 defaultProvider');
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
