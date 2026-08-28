import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// ccq CLI 子命令回归门禁：argv 解析、help、provider/profile 列表展示与管理命令。
// 重点守住「无参进 TUI」「cc/cx 不再是命令」「--tool 为管理类自有 flag」等不变量。

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-cli-'));
process.env.CCQ_HOME = tempHome;
process.env.CODEX_HOME = join(tempHome, '.codex');

try {
	const {parseCli} = await import('../src/cli/argv.ts');
	const {runCli} = await import('../src/cli/index.ts');
	const {helpFor, HELP_GENERAL, HELP_TOOLS} = await import('../src/cli/help.ts');
	const {TOOL_DEFINITIONS} = await import('../src/core/tools-install.ts');
	const {resolveToolId, availableToolIds, runToolsUpdate} = await import('../src/cli/commands/tools.ts');
	const {listProvidersForDisplay, listCodexProfilesForDisplay} = await import('../src/cli/commands/ls.ts');
	const {runUse} = await import('../src/cli/commands/use.ts');
	const {saveCodexProfile} = await import('../src/core/codex.ts');

	// ── argv 解析 ───────────────────────────────────────────────────────────────
	assert.deepEqual(parseCli([]), {kind: 'tui'});
	assert.deepEqual(parseCli(['--version']), {kind: 'version'});
	assert.deepEqual(parseCli(['-v']), {kind: 'version'});
	assert.deepEqual(parseCli(['--help']), {kind: 'help'});
	assert.deepEqual(parseCli(['help', 'cc']), {kind: 'help', verb: 'cc'});
	assert.deepEqual(parseCli(['help', 'cx']), {kind: 'help', verb: 'cx'});
	assert.deepEqual(parseCli(['help', 'nope']), {kind: 'help', verb: 'nope'});
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
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph']), {
		kind: 'tools',
		action: 'uninstall',
		name: 'CodeGraph',
		assumedYes: false
	});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph', '--yes']), {
		kind: 'tools',
		action: 'uninstall',
		name: 'CodeGraph',
		assumedYes: true
	});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph', '-y']), {
		kind: 'tools',
		action: 'uninstall',
		name: 'CodeGraph',
		assumedYes: true
	});
	assert.deepEqual(parseCli(['tools', 'uninstall', 'CodeGraph', 'yes']), {
		kind: 'unknown',
		verb: 'tools',
		args: ['uninstall', 'CodeGraph', 'yes']
	});
	assert.deepEqual(parseCli(['uninstall']), {kind: 'uninstall', assumedYes: false});
	assert.deepEqual(parseCli(['uninstall', '--yes']), {kind: 'uninstall', assumedYes: true});
	assert.deepEqual(parseCli(['uninstall', '-y']), {kind: 'uninstall', assumedYes: true});
	assert.deepEqual(parseCli(['uninstall', 'yes']), {kind: 'unknown', verb: 'uninstall', args: ['yes']});
	assert.deepEqual(parseCli(['cc', 'aether']), {kind: 'unknown', verb: 'cc', args: ['aether']});
	assert.deepEqual(parseCli(['cx']), {kind: 'unknown', verb: 'cx', args: []});
	assert.deepEqual(parseCli(['unknown']), {kind: 'unknown', verb: 'unknown', args: []});
	console.log('[PASS] ccq CLI argv 解析');

	// ── help 与已移除命令的错误语义 ──────────────────────────────────────────────
	assert.equal(helpFor('cc'), null, 'cc 不得再有专用帮助');
	assert.equal(helpFor('cx'), null, 'cx 不得再有专用帮助');
	assert.doesNotMatch(HELP_GENERAL, /^\s+(?:cc|cx)\b/m, '通用帮助不得列出 cc/cx');

	const capturedErrors = [];
	const originalConsoleError = console.error;
	console.error = (...args) => capturedErrors.push(args.join(' '));
	try {
		assert.equal(await runCli(parseCli(['help', 'nope'])), 1, '未知 help 动词必须返回非零');
		assert.equal(await runCli(parseCli(['help', 'cc'])), 1, 'cc help 必须按未知子命令处理');
		assert.equal(await runCli(parseCli(['help', 'cx'])), 1, 'cx help 必须按未知子命令处理');
		assert.equal(await runCli(parseCli(['cc', 'aether'])), 1, 'cc 必须按未知命令处理');
		assert.equal(await runCli(parseCli(['cx'])), 1, 'cx 必须按未知命令处理');
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(
		capturedErrors.some(line => line.includes('未知子命令: nope')),
		true
	);
	assert.equal(
		capturedErrors.some(line => line.includes('未知子命令: cc')),
		true
	);
	assert.equal(
		capturedErrors.some(line => line.includes('未知子命令: cx')),
		true
	);
	assert.equal(
		capturedErrors.some(line => line.includes('未知命令: cc')),
		true
	);
	assert.equal(
		capturedErrors.some(line => line.includes('未知命令: cx')),
		true
	);
	assert.equal(
		capturedErrors.some(line => line.includes('cc 缺少供应商名称')),
		false
	);
	assert.equal(
		capturedErrors.some(line => line.includes(HELP_GENERAL.split('\n')[0])),
		true
	);
	console.log('[PASS] help 与已移除 cc/cx 命令的错误语义');

	// ── 工具 registry/别名 + 显式更新 force refresh ───────────────────────────────
	const registryIds = TOOL_DEFINITIONS.map(definition => definition.id);
	assert.deepEqual(availableToolIds(), registryIds, 'CLI 可用工具必须直接派生自 registry');
	for (const id of registryIds) {
		assert.equal(resolveToolId(id), id, `canonical id 应可解析: ${id}`);
		assert.equal(HELP_TOOLS.includes(id), true, `帮助应列出 registry 工具: ${id}`);
	}
	assert.equal(resolveToolId('trellis'), 'Trellis', 'Trellis 别名不得遗漏');
	assert.equal(resolveToolId('claude-code'), 'ClaudeCode');
	assert.equal(resolveToolId('code-graph'), 'CodeGraph');
	assert.equal(resolveToolId('gitnexus'), 'GitNexus', 'GitNexus canonical 小写别名可解析');
	assert.equal(resolveToolId('git-nexus'), 'GitNexus', 'GitNexus 连字符别名可解析');
	assert.equal(resolveToolId('dsh'), 'DeepSeekHarness', 'DeepSeek Harness 短别名可解析');
	assert.equal(resolveToolId('deepseek-harness'), 'DeepSeekHarness', 'DeepSeek Harness 长别名可解析');

	let forceRefreshSeen = null;
	const updateExitCode = await runToolsUpdate(undefined, {
		detect: async (_onProgress, forceRefresh) => {
			forceRefreshSeen = forceRefresh;
			return [];
		},
		update: async () => {
			throw new Error('没有目标时不应执行更新');
		}
	});
	assert.equal(updateExitCode, 0);
	assert.equal(forceRefreshSeen, true, '显式 tools update 必须绕过远程缓存');
	const updateErrors = [];
	const originalUpdateError = console.error;
	console.error = (...args) => updateErrors.push(args.join(' '));
	try {
		const failedDshUpdateExitCode = await runToolsUpdate('dsh', {
			detect: async () => [
				{
					id: 'DeepSeekHarness',
					name: 'DeepSeek Harness',
					type: 'npm',
					package: '@deepseek-ai/dsh',
					installed: true,
					currentVersion: '1.2.3',
					latestVersion: '1.2.4',
					hasUpdate: true
				}
			],
			update: async () => ({
				snapshotPath: '',
				updatedItems: ['failed::DeepSeekHarness::fixture DSH postflight ownership diagnostic']
			})
		});
		assert.equal(failedDshUpdateExitCode, 1, 'DSH 更新失败必须返回非零');
	} finally {
		console.error = originalUpdateError;
	}
	assert.equal(
		updateErrors.some(line => line.includes('fixture DSH postflight ownership diagnostic')),
		true,
		'CLI 必须输出 DSH 更新失败的保留诊断'
	);
	console.log('[PASS] 工具 registry 单一事实源 + 显式更新强制刷新');

	// ── provider/profile 展示 ───────────────────────────────────────────────────
	const lines = listProvidersForDisplay(
		[
			{
				key: 'glm',
				baseUrl: 'https://open.bigmodel.cn/api/anthropic',
				hasManagedModelConfig: true,
				authToken: 'sk-a',
				profilePath: '/tmp/glm.json'
			},
			{key: 'kimi', baseUrl: '', hasManagedModelConfig: false, authToken: 'sk-b', profilePath: '/tmp/kimi.json'}
		],
		'glm'
	);
	assert.equal(lines[0].startsWith('* glm'), true);
	assert.equal(lines[0].includes('https://open.bigmodel.cn/api/anthropic'), true);
	assert.equal(lines[1].startsWith('  kimi'), true);
	assert.equal(lines[1].includes('(未配置 BaseUrl)'), true);

	const codexLines = listCodexProfilesForDisplay([
		{
			key: 'dev',
			providerType: 'apiKey',
			baseUrl: 'https://api.example.com',
			hasApiKey: true,
			isDefault: true,
			profilePath: '/tmp/dev.config.toml'
		},
		{
			key: 'official',
			providerType: 'officialLogin',
			baseUrl: '',
			hasApiKey: false,
			isDefault: false,
			profilePath: '/tmp/official.config.toml'
		}
	]);
	assert.equal(codexLines[0].startsWith('* dev'), true);
	assert.equal(codexLines[0].includes('api key'), true);
	assert.equal(codexLines[1].includes('official login'), true);
	console.log('[PASS] provider/profile 列表展示');

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
} finally {
	rmSync(tempHome, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
