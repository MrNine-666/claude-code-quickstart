import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

// ccq CLI 子命令回归门禁：argv 解析、provider/profile 列表展示、cc/cx 无效路径与透传。
// 重点守住「无参进 TUI」「cc/cx 透传」「-- 分隔」「--tool 为管理类自有 flag」等不变量。

const tempHome = mkdtempSync(join(tmpdir(), 'ccq-cli-'));
process.env.CCQ_HOME = tempHome;
process.env.CODEX_HOME = join(tempHome, '.codex');

try {
	const {parseCli} = await import('../src/cli/argv.ts');
	const {runCli} = await import('../src/cli/index.ts');
	const {HELP_GENERAL, HELP_TOOLS} = await import('../src/cli/help.ts');
	const {TOOL_DEFINITIONS} = await import('../src/core/tools-install.ts');
	const {resolveToolId, availableToolIds, runToolsUpdate} = await import('../src/cli/commands/tools.ts');
	const {listProvidersForDisplay, listCodexProfilesForDisplay} = await import('../src/cli/commands/ls.ts');
	const {runCc} = await import('../src/cli/commands/cc.ts');
	const {runCx} = await import('../src/cli/commands/cx.ts');
	const {runWithInheritedTty} = await import('../src/cli/process-runner.ts');
	const {runUse} = await import('../src/cli/commands/use.ts');
	const {saveCodexProfile} = await import('../src/core/codex.ts');

	// ── process runner：POSIX execve + fallback + Windows spawn ───────────────────
	const execveMarker = 'ccq-execve-env-marker';
	const previousExecveMarker = process.env.CCQ_EXECVE_TEST;
	process.env.CCQ_EXECVE_TEST = execveMarker;
	try {
		const posixCalls = {which: [], execve: [], spawn: []};
		const posixRuntime = {
			platform: 'darwin',
			which(command) {
				posixCalls.which.push(command);
				return `/usr/local/bin/${command}`;
			},
			execve(file, args, env) {
				posixCalls.execve.push({file, args: [...args], env: {...env}});
				throw new Error('execve unavailable');
			},
			spawn(argv, options) {
				posixCalls.spawn.push({argv: [...argv], options});
				return {exited: Promise.resolve(13)};
			}
		};

		assert.equal(
			await runWithInheritedTty('claude', ['--settings', 'profile.json', '--help'], posixRuntime),
			13,
			'POSIX execve fallback 应透传 spawn 退出码'
		);
		assert.deepEqual(posixCalls.which, ['claude']);
		assert.equal(posixCalls.execve.length, 1);
		assert.equal(posixCalls.execve[0].file, '/usr/local/bin/claude');
		assert.deepEqual(posixCalls.execve[0].args, ['claude', '--settings', 'profile.json', '--help']);
		assert.equal(posixCalls.execve[0].env.CCQ_EXECVE_TEST, execveMarker, 'execve 必须接收完整环境');
		assert.deepEqual(posixCalls.spawn[0].argv, ['claude', '--settings', 'profile.json', '--help']);
		assert.deepEqual(posixCalls.spawn[0].options, {stdio: ['inherit', 'inherit', 'inherit']});

		const windowsCalls = {which: [], execve: 0, spawn: [], unref: 0};
		const windowsRuntime = {
			platform: 'win32',
			which(command) {
				windowsCalls.which.push(command);
				return 'C:\\Tools\\codex.exe';
			},
			fileExists: () => true,
			execve() {
				windowsCalls.execve += 1;
				throw new Error('Windows fallback must not call execve');
			},
			spawn(argv, options) {
				windowsCalls.spawn.push({argv: [...argv], options});
				return {
					exited: new Promise(() => {}),
					unref() {
						windowsCalls.unref += 1;
					}
				};
			}
		};

		const windowsCode = await Promise.race([
			runWithInheritedTty('codex', ['--help'], windowsRuntime),
			new Promise((_, reject) => setTimeout(() => reject(new Error('Windows detached runner waited for child exit')), 250))
		]);
		assert.equal(windowsCode, 0);
		assert.deepEqual(windowsCalls.which, ['codex']);
		assert.equal(windowsCalls.execve, 0);
		assert.deepEqual(windowsCalls.spawn[0].argv, ['C:\\Tools\\codex.exe', '--help']);
		assert.deepEqual(windowsCalls.spawn[0].options, {
			stdio: ['inherit', 'inherit', 'inherit'],
			detached: true
		});
		assert.equal(windowsCalls.unref, 1);

		const directRuntime = {
			...windowsRuntime,
			which: () => 'C:\\Tools\\claude.exe',
			fileExists: () => true,
			spawn(argv, options) {
				windowsCalls.spawn.push({argv: [...argv], options});
				return {exited: new Promise(() => {}), unref: () => { windowsCalls.unref += 1; }};
			}
		};
		assert.equal(await runWithInheritedTty('claude', ['--version'], directRuntime), 0);
		assert.deepEqual(windowsCalls.spawn.at(-1).argv, ['C:\\Tools\\claude.exe', '--version']);

		const wrapperRuntime = {
			...directRuntime,
			which: () => 'C:\\node\\claude.cmd',
			readFile: () => '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
			fileExists: path => path === 'C:\\node\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
		};
		assert.equal(await runWithInheritedTty('claude', [], wrapperRuntime), 0);
		assert.deepEqual(windowsCalls.spawn.at(-1).argv, ['C:\\node\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe']);

		const escapedWrapperRuntime = {
			...directRuntime,
			which: () => 'C:\\node\\claude.cmd',
			readFile: () => '"%dp0%\\..\\outside\\claude.exe" %*',
			fileExists: () => true,
			spawn() {
				throw new Error('wrapper traversal must fail closed before spawn');
			}
		};
		await assert.rejects(
			() => runWithInheritedTty('claude', [], escapedWrapperRuntime),
			/Executable not found: claude/
		);

		const codexFallbackRuntime = {
			...directRuntime,
			which: () => 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe',
			localAppData: 'C:\\Users\\tester\\AppData\\Local',
			listDirectory: () => ['old', 'new'],
			fileExists: path => path === 'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe'
		};
		assert.equal(await runWithInheritedTty('codex', [], codexFallbackRuntime), 0);
		assert.deepEqual(windowsCalls.spawn.at(-1).argv, ['C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe']);

		const codexWhichFailureRuntime = {
			...directRuntime,
			which() {
				throw new Error('PATH probe failed');
			},
			localAppData: 'C:\\Users\\tester\\AppData\\Local',
			listDirectory: () => ['..', 'valid'],
			fileExists: path => path === 'C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\valid\\codex.exe'
		};
		assert.equal(await runWithInheritedTty('codex', [], codexWhichFailureRuntime), 0);
		assert.deepEqual(windowsCalls.spawn.at(-1).argv, ['C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\valid\\codex.exe']);

		const unavailableCodexRuntime = {
			...directRuntime,
			which: () => 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\codex.exe',
			localAppData: 'C:\\Users\\tester\\AppData\\Local',
			listDirectory: () => ['v1'],
			fileExists: () => false,
			spawn() {
				throw new Error('unavailable Codex must fail closed before spawn');
			}
		};
		await assert.rejects(
			() => runWithInheritedTty('codex', [], unavailableCodexRuntime),
			/Executable not found: codex/
		);

		const missingRuntime = {
			...directRuntime,
			which: () => 'C:\\Tools\\missing.exe',
			fileExists: () => false,
			listDirectory: () => [],
			spawn() {
				throw new Error('must not spawn when no direct executable exists');
			}
		};
		await assert.rejects(
			() => runWithInheritedTty('claude', [], missingRuntime),
			/Executable not found: claude/
		);

		const whichFailureRuntime = {
			...directRuntime,
			which() {
				throw new Error('PATH probe failed');
			},
			localAppData: 'C:\\Users\\tester\\AppData\\Local',
			listDirectory: () => [],
			spawn() {
				throw new Error('which failure must fail closed before spawn');
			}
		};
		await assert.rejects(
			() => runWithInheritedTty('claude', [], whichFailureRuntime),
			/Executable not found: claude/
		);

		const spawnFailureRuntime = {
			...directRuntime,
			which: () => 'C:\\Tools\\claude.exe',
			spawn() {
				throw new Error('EPERM: operation not permitted');
			}
		};
		await assert.rejects(() => runWithInheritedTty('claude', [], spawnFailureRuntime), /EPERM/);
		console.log('[PASS] process runner POSIX execve/fallback + Windows direct detached launch');
	} finally {
		if (previousExecveMarker === undefined) delete process.env.CCQ_EXECVE_TEST;
		else process.env.CCQ_EXECVE_TEST = previousExecveMarker;
	}

	if (process.platform === 'win32') {
		console.log('[PASS] process runner real POSIX replacement probe skipped on Windows');
	} else {
		const probeRoot = mkdtempSync(join(tmpdir(), 'ccq-execve-probe-'));
		const fixturePath = join(probeRoot, 'fixture.sh');
		const probePath = join(probeRoot, 'probe.mjs');
		const pidPath = join(probeRoot, 'pid.txt');
		const argsPath = join(probeRoot, 'args.txt');
		const envPath = join(probeRoot, 'env.txt');
		try {
			writeFileSync(
				fixturePath,
				'#!/bin/sh\n' +
					'printf "%s\\n" "$$" > "$CCQ_EXECVE_PID_FILE"\n' +
					'printf "%s|%s\\n" "$1" "$2" > "$CCQ_EXECVE_ARGS_FILE"\n' +
					'printf "%s\\n" "$CCQ_EXECVE_PARENT_PID" > "$CCQ_EXECVE_ENV_FILE"\n' +
					'exit 23\n',
				'utf8'
			);
			chmodSync(fixturePath, 0o755);

			const runnerUrl = pathToFileURL(join(import.meta.dir, '..', 'src', 'cli', 'process-runner.ts')).href;
			writeFileSync(
				probePath,
				`import {runWithInheritedTty} from ${JSON.stringify(runnerUrl)};\n` +
					`const fixture = process.env.CCQ_EXECVE_FIXTURE;\n` +
					`process.env.CCQ_EXECVE_PARENT_PID = String(process.pid);\n` +
					`const code = await runWithInheritedTty('fixture', ['first', 'second'], {\n` +
					`  platform: process.platform,\n` +
					`  which: () => fixture ?? null,\n` +
					`  execve: process.execve?.bind(process),\n` +
					`  spawn: (argv, options) => Bun.spawn(argv, options)\n` +
					`});\n` +
					`process.exit(code);\n`,
				'utf8'
			);

			const probe = spawnSync(process.execPath, [probePath], {
				env: {
					...process.env,
					CCQ_EXECVE_FIXTURE: fixturePath,
					CCQ_EXECVE_PID_FILE: pidPath,
					CCQ_EXECVE_ARGS_FILE: argsPath,
					CCQ_EXECVE_ENV_FILE: envPath
				},
				encoding: 'utf8'
			});
			assert.equal(probe.status, 23, '真实 POSIX execve 应透传 fixture 退出码');
			assert.doesNotMatch(probe.stderr ?? '', /ExperimentalWarning: process\.execve/, 'execve warning 不得泄漏');
			assert.equal(readFileSync(pidPath, 'utf8').trim(), readFileSync(envPath, 'utf8').trim(), 'execve 应保留原 PID');
			assert.equal(readFileSync(argsPath, 'utf8').trim(), 'first|second', 'execve argv 应保持顺序');
			console.log('[PASS] process runner 真实 POSIX execve 替换 probe');
		} finally {
			rmSync(probeRoot, {recursive: true, force: true});
		}
	}

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
	assert.deepEqual(parseCli(['cc', 'glm']), {kind: 'cc', name: 'glm', passthrough: []});
	assert.deepEqual(parseCli(['cc', 'glm', '-p', 'hi']), {kind: 'cc', name: 'glm', passthrough: ['-p', 'hi']});
	assert.deepEqual(parseCli(['cc', 'glm', '--', '-p', 'hi', '--verbose']), {
		kind: 'cc',
		name: 'glm',
		passthrough: ['-p', 'hi', '--verbose']
	});
	assert.deepEqual(parseCli(['cc', 'glm', '-p', 'hi', '--', '--verbose', '--', 'tail']), {
		kind: 'cc',
		name: 'glm',
		passthrough: ['-p', 'hi', '--verbose', '--', 'tail']
	});
	assert.deepEqual(parseCli(['cx']), {kind: 'cx', passthrough: []});
	assert.deepEqual(parseCli(['cx', '--', '-m', 'gpt-5']), {kind: 'cx', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', '-m', 'gpt-5']), {kind: 'cx', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', 'dev']), {kind: 'cx', name: 'dev', passthrough: []});
	assert.deepEqual(parseCli(['cx', 'dev', '-m', 'gpt-5']), {kind: 'cx', name: 'dev', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', 'dev', '--', '-m', 'gpt-5']), {kind: 'cx', name: 'dev', passthrough: ['-m', 'gpt-5']});
	assert.deepEqual(parseCli(['cx', 'dev', '-m', 'gpt-5', '--', '--help']), {
		kind: 'cx',
		name: 'dev',
		passthrough: ['-m', 'gpt-5', '--help']
	});
	assert.deepEqual(parseCli(['cc']), {kind: 'unknown', verb: 'cc', args: []});
	assert.deepEqual(parseCli(['cc', '-p', 'hi']), {kind: 'unknown', verb: 'cc', args: ['-p', 'hi']});
	assert.deepEqual(parseCli(['unknown']), {kind: 'unknown', verb: 'unknown', args: []});
	console.log('[PASS] ccq CLI argv 解析');

	// ── help 错误语义 ────────────────────────────────────────────────────────────
	const capturedErrors = [];
	const originalConsoleError = console.error;
	console.error = (...args) => capturedErrors.push(args.join(' '));
	try {
		assert.equal(await runCli(parseCli(['help', 'nope'])), 1, '未知 help 动词必须返回非零');
	} finally {
		console.error = originalConsoleError;
	}
	assert.equal(
		capturedErrors.some(line => line.includes('未知子命令: nope')),
		true
	);
	assert.equal(
		capturedErrors.some(line => line.includes(HELP_GENERAL.split('\n')[0])),
		true
	);
	console.log('[PASS] help 未知动词错误语义');

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

	// ── cc 无效路径：不得 spawn claude ───────────────────────────────────────────
	assert.equal(await runCc('../evil', []), 1);

	const providers = join(tempHome, '.claude', 'providers');
	mkdirSync(providers, {recursive: true});
	writeFileSync(join(providers, 'broken.json'), JSON.stringify({env: {ANTHROPIC_BASE_URL: 'https://example.com'}}), 'utf8');
	assert.equal(await runCc('broken', []), 1, '缺少 ANTHROPIC_AUTH_TOKEN 的 profile 不应被当作可用 provider');

	// ── cc 正向路径：注入 fake runner 捕获 args，不触发真实 claude ────────────────
	writeFileSync(
		join(providers, 'glm.json'),
		JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'token', ANTHROPIC_BASE_URL: 'https://example.com'}}),
		'utf8'
	);
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
	assert.equal(
		await runCx(undefined, ['--help'], async args => {
			codexArgs = [...args];
			return 0;
		}),
		0,
		'plain cx 应直接启动 codex'
	);
	assert.deepEqual(codexArgs, ['--help']);

	saveCodexProfile({
		key: 'dev',
		providerType: 'apiKey',
		baseUrl: 'https://api.example.com',
		model: 'gpt-5',
		apiKey: 'sk-secret-should-not-print'
	});
	assert.equal(
		await runCx('dev', ['-m', 'gpt-5'], async args => {
			codexArgs = [...args];
			return 9;
		}),
		9,
		'cx 应透传 codex 退出码'
	);
	assert.deepEqual(codexArgs, ['--profile', 'dev', '-m', 'gpt-5']);

	// official login 虚拟条目：cx official 不拼 --profile，等价 plain codex 读 base config。
	codexArgs = null;
	assert.equal(
		await runCx('official', ['--help'], async args => {
			codexArgs = [...args];
			return 0;
		}),
		0,
		'cx official 应等价 plain codex 启动'
	);
	assert.deepEqual(codexArgs, ['--help'], 'cx official 不注入 --profile official');
	console.log('[PASS] cx 子命令 plain/profile/official 透传 + 不读 ccq vault/env');

	// ── use --tool codex：结构化写 base config，不写 legacy selector ─────────────
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
