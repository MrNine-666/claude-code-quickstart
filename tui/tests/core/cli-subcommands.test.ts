import {afterEach, beforeEach, expect, test} from 'bun:test';
import {parseCli} from '../../src/cli/argv.js';
import {listCodexProfilesForDisplay, listProvidersForDisplay} from '../../src/cli/commands/ls.js';
import {availableToolIds, resolveToolId, runToolsUpdate} from '../../src/cli/commands/tools.js';
import {HELP_GENERAL, HELP_LS, HELP_TOOLS, HELP_USE, helpFor} from '../../src/cli/help.js';
import {runCli} from '../../src/cli/index.js';
import type {CodexProfileListItem} from '../../src/core/codex.js';
import type {ProviderListItem} from '../../src/core/provider.js';
import type {ManagedComponent} from '../../src/core/tools-manage.js';
import {TOOL_DEFINITIONS} from '../../src/core/tools-install.js';
import {createTempHome, type TempHome} from '../helpers/temp-home.js';

// P5a 迁移自 scripts/verify-cli-subcommands.mjs 的纯段（76 条静态断言）：
//   - argv 解析（32）
//   - help 与已移除 cc/cx 命令的错误语义（20）
//   - 工具 registry 单一事实源 + 显式更新强制刷新（17）
//   - provider/profile 列表展示（7）
// 真实落盘的 use --tool codex 默认切换与 ls --tool pi 只读段仍留在 verify（写 CODEX_HOME / ~/.pi 字节）。

// 纯段不读写 fs；仍设临时 CCQ_HOME，避免 CLI 模块意外触碰真实用户目录。
let tempHome: TempHome;
beforeEach(() => {
	tempHome = createTempHome('ccq-cli-subcommands-');
});
afterEach(() => {
	tempHome.restore();
	tempHome.cleanup();
});

test('ccq CLI argv 解析', () => {
	expect(parseCli([])).toEqual({kind: 'tui'});
	expect(parseCli(['--version'])).toEqual({kind: 'version'});
	expect(parseCli(['-v'])).toEqual({kind: 'version'});
	expect(parseCli(['--help'])).toEqual({kind: 'help'});
	expect(parseCli(['help', 'cc'])).toEqual({kind: 'help', verb: 'cc'});
	expect(parseCli(['help', 'cx'])).toEqual({kind: 'help', verb: 'cx'});
	expect(parseCli(['help', 'nope'])).toEqual({kind: 'help', verb: 'nope'});
	expect(parseCli(['ls'])).toEqual({kind: 'ls', tool: 'claude'});
	expect(parseCli(['ls', '--tool', 'claude'])).toEqual({kind: 'ls', tool: 'claude'});
	expect(parseCli(['ls', '--tool', 'codex'])).toEqual({kind: 'ls', tool: 'codex'});
	expect(parseCli(['ls', '--tool', 'pi'])).toEqual({kind: 'ls', tool: 'pi'});
	expect(parseCli(['ls', '--tool', 'bad'])).toEqual({kind: 'unknown', verb: 'ls', args: ['--tool', 'bad']});
	expect(parseCli(['use', 'glm'])).toEqual({kind: 'use', name: 'glm', tool: 'claude'});
	expect(parseCli(['use', 'glm', '--tool', 'claude'])).toEqual({kind: 'use', name: 'glm', tool: 'claude'});
	expect(parseCli(['use', 'dev', '--tool', 'codex'])).toEqual({kind: 'use', name: 'dev', tool: 'codex'});
	expect(parseCli(['use', 'openai', '--tool', 'pi'])).toEqual({
		kind: 'unknown',
		verb: 'use',
		args: ['openai', '--tool', 'pi']
	});
	expect(parseCli(['use', 'dev', '--tool', 'bad'])).toEqual({kind: 'unknown', verb: 'use', args: ['dev', '--tool', 'bad']});
	expect(parseCli(['update'])).toEqual({kind: 'update', checkOnly: false});
	expect(parseCli(['update', '--check'])).toEqual({kind: 'update', checkOnly: true});
	expect(parseCli(['tools', 'update'])).toEqual({kind: 'tools', action: 'update', name: undefined, assumedYes: false});
	expect(parseCli(['tools', 'update', 'CodeGraph'])).toEqual({kind: 'tools', action: 'update', name: 'CodeGraph', assumedYes: false});
	expect(parseCli(['tools', 'uninstall', 'CodeGraph'])).toEqual({
		kind: 'tools',
		action: 'uninstall',
		name: 'CodeGraph',
		assumedYes: false
	});
	expect(parseCli(['tools', 'uninstall', 'CodeGraph', '--yes'])).toEqual({
		kind: 'tools',
		action: 'uninstall',
		name: 'CodeGraph',
		assumedYes: true
	});
	expect(parseCli(['tools', 'uninstall', 'CodeGraph', '-y'])).toEqual({
		kind: 'tools',
		action: 'uninstall',
		name: 'CodeGraph',
		assumedYes: true
	});
	expect(parseCli(['tools', 'uninstall', 'CodeGraph', 'yes'])).toEqual({
		kind: 'unknown',
		verb: 'tools',
		args: ['uninstall', 'CodeGraph', 'yes']
	});
	expect(parseCli(['uninstall'])).toEqual({kind: 'uninstall', assumedYes: false});
	expect(parseCli(['uninstall', '--yes'])).toEqual({kind: 'uninstall', assumedYes: true});
	expect(parseCli(['uninstall', '-y'])).toEqual({kind: 'uninstall', assumedYes: true});
	expect(parseCli(['uninstall', 'yes'])).toEqual({kind: 'unknown', verb: 'uninstall', args: ['yes']});
	expect(parseCli(['cc', 'aether'])).toEqual({kind: 'unknown', verb: 'cc', args: ['aether']});
	expect(parseCli(['cx'])).toEqual({kind: 'unknown', verb: 'cx', args: []});
	expect(parseCli(['unknown'])).toEqual({kind: 'unknown', verb: 'unknown', args: []});
});

test('help 与已移除 cc/cx 命令的错误语义', async () => {
	expect(helpFor('cc'), 'cc 不得再有专用帮助').toBeNull();
	expect(helpFor('cx'), 'cx 不得再有专用帮助').toBeNull();
	expect(HELP_GENERAL, '通用帮助不得列出 cc/cx').not.toMatch(/^\s+(?:cc|cx)\b/m);
	expect(HELP_GENERAL, '通用帮助必须列出 Pi tool target').toMatch(/tool=claude\|codex\|pi/);
	expect(HELP_LS, 'ls 帮助必须列出 Pi').toMatch(/ccq ls --tool pi/);
	expect(HELP_USE, 'use 帮助不得再提供 Pi Provider 切换').not.toMatch(/--tool pi/);
	expect(HELP_USE, 'use 帮助必须指向 Pi Config 的 defaultProvider').toMatch(/Pi 配置页.*defaultProvider/s);
	expect(HELP_USE, 'use 帮助不得宣称 provider/model 或 defaultModel 写入').not.toMatch(/<provider\/model>|defaultProvider\/defaultModel/);

	const capturedErrors: string[] = [];
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]) => capturedErrors.push(args.join(' '));
	try {
		expect(await runCli(parseCli(['help', 'nope'])), '未知 help 动词必须返回非零').toBe(1);
		expect(await runCli(parseCli(['help', 'cc'])), 'cc help 必须按未知子命令处理').toBe(1);
		expect(await runCli(parseCli(['help', 'cx'])), 'cx help 必须按未知子命令处理').toBe(1);
		expect(await runCli(parseCli(['cc', 'aether'])), 'cc 必须按未知命令处理').toBe(1);
		expect(await runCli(parseCli(['cx'])), 'cx 必须按未知命令处理').toBe(1);
	} finally {
		console.error = originalConsoleError;
	}
	expect(capturedErrors.some(line => line.includes('未知子命令: nope'))).toBe(true);
	expect(capturedErrors.some(line => line.includes('未知子命令: cc'))).toBe(true);
	expect(capturedErrors.some(line => line.includes('未知子命令: cx'))).toBe(true);
	expect(capturedErrors.some(line => line.includes('未知命令: cc'))).toBe(true);
	expect(capturedErrors.some(line => line.includes('未知命令: cx'))).toBe(true);
	expect(capturedErrors.some(line => line.includes('cc 缺少供应商名称'))).toBe(false);
	expect(capturedErrors.some(line => line.includes(HELP_GENERAL.split('\n')[0]!))).toBe(true);
});

test('工具 registry 单一事实源 + 显式更新强制刷新', async () => {
	const registryIds = TOOL_DEFINITIONS.map(definition => definition.id);
	expect(availableToolIds(), 'CLI 可用工具必须直接派生自 registry').toEqual(registryIds);
	for (const id of registryIds) {
		expect(resolveToolId(id), `canonical id 应可解析: ${id}`).toBe(id);
		expect(HELP_TOOLS.includes(id), `帮助应列出 registry 工具: ${id}`).toBe(true);
	}
	expect(resolveToolId('trellis'), 'Trellis 别名不得遗漏').toBe('Trellis');
	expect(resolveToolId('claude-code')).toBe('ClaudeCode');
	expect(resolveToolId('code-graph')).toBe('CodeGraph');
	expect(resolveToolId('gitnexus'), 'GitNexus canonical 小写别名可解析').toBe('GitNexus');
	expect(resolveToolId('git-nexus'), 'GitNexus 连字符别名可解析').toBe('GitNexus');
	expect(resolveToolId('dsh'), 'DeepSeek Harness 短别名可解析').toBe('DeepSeekHarness');
	expect(resolveToolId('deepseek-harness'), 'DeepSeek Harness 长别名可解析').toBe('DeepSeekHarness');
	expect(resolveToolId('pi'), 'Pi CLI 别名可解析').toBe('PiCli');
	expect(resolveToolId('pi-agent'), 'Pi Agent 别名可解析').toBe('PiCli');
	expect(resolveToolId('pi-web'), 'Pi Web 别名可解析').toBe('PiWeb');

	let forceRefreshSeen: boolean | undefined;
	const updateExitCode = await runToolsUpdate(undefined, {
		detect: async (_onProgress, forceRefresh) => {
			forceRefreshSeen = forceRefresh;
			return [];
		},
		update: async () => {
			throw new Error('没有目标时不应执行更新');
		}
	});
	expect(updateExitCode).toBe(0);
	expect(forceRefreshSeen, '显式 tools update 必须绕过远程缓存').toBe(true);

	const updateErrors: string[] = [];
	const originalUpdateError = console.error;
	console.error = (...args: unknown[]) => updateErrors.push(args.join(' '));
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
				} as unknown as ManagedComponent
			],
			update: async () => ({
				snapshotPath: '',
				updatedItems: ['failed::DeepSeekHarness::fixture DSH postflight ownership diagnostic']
			})
		});
		expect(failedDshUpdateExitCode, 'DSH 更新失败必须返回非零').toBe(1);
	} finally {
		console.error = originalUpdateError;
	}
	expect(
		updateErrors.some(line => line.includes('fixture DSH postflight ownership diagnostic')),
		'CLI 必须输出 DSH 更新失败的保留诊断'
	).toBe(true);
});

test('provider/profile 列表展示', () => {
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
		] satisfies ProviderListItem[],
		'glm'
	);
	expect(lines[0]!.startsWith('* glm')).toBe(true);
	expect(lines[0]!.includes('https://open.bigmodel.cn/api/anthropic')).toBe(true);
	expect(lines[1]!.startsWith('  kimi')).toBe(true);
	expect(lines[1]!.includes('(未配置 BaseUrl)')).toBe(true);

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
	] satisfies CodexProfileListItem[]);
	expect(codexLines[0]!.startsWith('* dev')).toBe(true);
	expect(codexLines[0]!.includes('api key')).toBe(true);
	expect(codexLines[1]!.includes('official login')).toBe(true);
});
