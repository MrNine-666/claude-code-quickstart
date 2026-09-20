import {describe, expect, test} from 'bun:test';
import {hasUpdate, parseSemver, semverCompare} from '../../src/core/semver.js';
import {
	agentTarget,
	ccgWorkflowInstallCommands,
	ccgWorkflowUninstallCommands,
	codeGraphInstallCommands,
	codeGraphRemoveCliCommands,
	codeGraphUninstallCommands,
	GITNEXUS_INSTALL_PACKAGE_SPEC,
	gitNexusFailureDiagnostic,
	gitNexusIntegrationCleanupCommands,
	gitNexusSetupCommands
} from '../../src/core/tools-lifecycle.js';

// A 类改写（P1-G3）：tools 生命周期纯 resolver + semver 判定。
// 覆盖 verify-tools-manage.mjs / verify-tools-shared-projection.mjs 依赖的命令派生与版本比较。

describe('tools 生命周期 resolver', () => {
	test('CodeGraph 安装/卸载按 agentContext 派生 --target，Pi 无命令', () => {
		expect(codeGraphInstallCommands('cc')).toEqual([
			{cmd: 'codegraph', args: ['install', '--target=claude', '--location=global', '--yes']}
		]);
		expect(codeGraphInstallCommands('cx')).toEqual([
			{cmd: 'codegraph', args: ['install', '--target=codex', '--location=global', '--yes']}
		]);
		expect(codeGraphInstallCommands('pi')).toEqual([]);
		expect(codeGraphUninstallCommands('cx')).toEqual([{cmd: 'codegraph', args: ['uninstall', '--target=codex', '--yes']}]);
		expect(codeGraphRemoveCliCommands()).toEqual([{cmd: 'npm', args: ['uninstall', '-g', '@colbymchenry/codegraph']}]);
		expect(agentTarget('cc')).toBe('claude');
		expect(agentTarget('cx')).toBe('codex');
		expect(() => agentTarget('pi')).toThrow();
	});

	test('CcgWorkflow Claude/Codex/Pi 走各自官方命令', () => {
		const claude = ccgWorkflowInstallCommands('cc', '/home/.claude');
		expect(claude.some(command => command.args.some(arg => arg.startsWith('ccg-workflow')))).toBe(true);
		expect(claude.every(command => !command.args.includes('codex-mode'))).toBe(true);
		expect(ccgWorkflowInstallCommands('cx', '/home/.claude')).toEqual([
			{cmd: 'npx', args: ['--yes', 'ccg-workflow', 'codex-mode', 'install']}
		]);
		expect(ccgWorkflowUninstallCommands('cx')).toEqual([{cmd: 'npx', args: ['--yes', 'ccg-workflow', 'codex-mode', 'uninstall']}]);
		// P5e 去重补迁（verify-ccgworkflow-codex.mjs）：Claude 侧完整 argv 与单命令事实。
		expect(ccgWorkflowInstallCommands('cc', '/home/.claude')).toEqual([
			{
				cmd: 'npx',
				args: [
					'--yes',
					'ccg-workflow@latest',
					'init',
					'--skip-prompt',
					'--skip-mcp',
					'--lang',
					'zh-CN',
					'--install-dir',
					'/home/.claude'
				]
			}
		]);
		expect(ccgWorkflowUninstallCommands('cc')).toEqual([{cmd: 'npx', args: ['--yes', 'ccg-workflow', 'uninstall']}]);
		expect(ccgWorkflowInstallCommands('pi', '/home/.claude')).toEqual([]);
	});

	test('GitNexus 整体接入/卸载与失败诊断', () => {
		expect(GITNEXUS_INSTALL_PACKAGE_SPEC).toBe('gitnexus@latest');
		expect(gitNexusSetupCommands().some(command => command.args.includes('claude,codex'))).toBe(true);
		expect(gitNexusIntegrationCleanupCommands().length).toBeGreaterThan(0);
		const diagnostic = gitNexusFailureDiagnostic('npm', 1, 'glibc missing', '');
		expect(diagnostic).toMatch(/npm/);
		expect(diagnostic).toMatch(/glibc missing/);
	});
});

describe('semver 判定', () => {
	test('parseSemver / semverCompare / hasUpdate', () => {
		expect(parseSemver('1.2.3')).toMatchObject({major: 1, minor: 2, patch: 3});
		expect(parseSemver('not-a-version')).toBeNull();
		expect(semverCompare('1.2.3', '1.2.4')).toBeLessThan(0);
		expect(semverCompare('2.0.0', '1.9.9')).toBeGreaterThan(0);
		expect(semverCompare('1.2.3', '1.2.3')).toBe(0);
		expect(hasUpdate('1.0.0', '1.0.1')).toBe(true);
		expect(hasUpdate('1.0.1', '1.0.0')).toBe(false);
		expect(hasUpdate('1.2.3', '1.2.3')).toBe(false);
		expect(hasUpdate(undefined, '1.0.0')).toBeNull();
	});
});
