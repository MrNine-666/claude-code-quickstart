import {describe, expect, test} from 'bun:test';
import {TOOL_DEFINITIONS} from '../../src/core/tools-install.js';
import {
	GITNEXUS_INSTALL_PACKAGE_SPEC,
	gitNexusFailureDiagnostic,
	gitNexusIntegrationCleanupCommands,
	gitNexusSetupCommands
} from '../../src/core/tools-lifecycle.js';
import {uninstallImpactNotice} from '../../src/core/tools-manage.js';

// P4b 迁移自 scripts/verify-gitnexus-lifecycle.mjs（20 条静态断言）。
// 迁走段 = 纯 resolver 命令事实（setup/cleanup 精确 argv、包 spec、registry 包名）+
// setup 失败诊断 + 卸载影响提示（去掉真实 fs / 子进程后成立）。
//
// 保守保留（R1「真实 CLI argv」口径 + 本批「7 脚本保留原名」约束）：
// verify-gitnexus-lifecycle.mjs 的 installTool / updateComponents / uninstallComponent 段
// 用注入 exec 捕获真实生命周期 argv 顺序、snapshot-before-write 与 exit-code 失败隔离，
// 作为 gate 保留在 verify，不重复迁入 tests；其中 `assertNoIndexScope` helper（2 条静态）
// 被保留段复用，故随保留段留在 verify。
//
// R9 去重：`gitNexusSetupCommands().some(args.includes('claude,codex'))` 与
// `gitNexusIntegrationCleanupCommands().length > 0` 已由 P1 `tests/core/tools-lifecycle.test.ts`
// 弱形式覆盖；本文件迁移的是**精确 argv 数组**（登记重叠，不丢护栏）。

describe('GitNexus resolver 命令事实', () => {
	test('setup/cleanup argv 固定，包 spec 与 registry 包名分离', () => {
		const setup = gitNexusSetupCommands();
		expect(setup.length, 'setup 只解析出一条命令').toBe(1);
		expect(setup[0], 'setup = gitnexus setup --coding-agent claude,codex（一次接入两侧）').toEqual({
			cmd: 'gitnexus',
			args: ['setup', '--coding-agent', 'claude,codex']
		});

		const cleanup = gitNexusIntegrationCleanupCommands();
		expect(cleanup.length, 'integration cleanup 只解析出一条命令').toBe(1);
		expect(cleanup[0], 'integration cleanup = gitnexus uninstall --force（上游无 target 筛选）').toEqual({
			cmd: 'gitnexus',
			args: ['uninstall', '--force']
		});

		expect(
			[...setup, ...cleanup].some(command => command.cmd === 'npm'),
			'resolver 层不得内联 npm 命令（包名事实仅存于 registry）'
		).toBe(false);

		const gitnexusDefinition = TOOL_DEFINITIONS.find(definition => definition.id === 'GitNexus');
		expect(gitnexusDefinition, 'GitNexus 在 registry 中').toBeDefined();
		expect(GITNEXUS_INSTALL_PACKAGE_SPEC, '首装 spec 带 latest dist-tag').toBe('gitnexus@latest');
		expect(gitnexusDefinition?.npmPackage, 'registry 包名不带 dist-tag（不污染 npm outdated/view 映射）').toBe('gitnexus');
	});
});

describe('GitNexus setup 失败诊断', () => {
	test('阶段 + exit code + 上游原文（engine/native 不被吞），截断保留尾部原因并折叠单行', () => {
		const engine = gitNexusFailureDiagnostic('GitNexus 编辑器接入失败', 2, 'Unsupported engine: required node ^22.18.0 || >=24.11.0');
		expect(engine, '保留阶段与 exit code').toMatch(/GitNexus 编辑器接入失败 \(exit 2\)/);
		expect(engine, '保留上游 Node.js engine 诊断').toMatch(/Unsupported engine/);
		expect(engine, '保留具体 engine 区间，便于用户处置').toMatch(/\^22\.18\.0 \|\| >=24\.11\.0/);

		const native = gitNexusFailureDiagnostic('GitNexus 编辑器接入刷新失败', 3, '', 'libssl.so.3: cannot open shared object file');
		expect(native, 'stderr 为空时回落 stdout 但仍带阶段').toMatch(/GitNexus 编辑器接入刷新失败 \(exit 3\)/);
		expect(native, '保留原生依赖诊断').toMatch(/libssl\.so\.3/);

		expect(gitNexusFailureDiagnostic('GitNexus 编辑器接入失败', 1, '   \n\t  '), '空白诊断不产生悬空冒号').toBe(
			'GitNexus 编辑器接入失败 (exit 1)'
		);

		const long = gitNexusFailureDiagnostic('GitNexus 编辑器接入失败', 1, `${'x'.repeat(2000)}FINAL_CAUSE`);
		expect(long.length < 500, '超长诊断截断，避免淹没进度日志').toBe(true);
		expect(long, '截断保留最有价值的尾部原因').toMatch(/FINAL_CAUSE$/);

		expect(/\n/.test(gitNexusFailureDiagnostic('stage', 1, 'a\nb\nc')), '诊断折叠为单行，不破坏 item 记录格式').toBe(false);
	});
});

describe('GitNexus 卸载影响提示', () => {
	test('全编辑器清理 + 仓库索引保留', () => {
		const notice = uninstallImpactNotice('GitNexus');
		expect(notice, '提示明确会清理所有检测到的编辑器接入').toMatch(/所有检测到的编辑器接入/);
		expect(notice, '提示点名非 ccq 安装的编辑器接入也会被清理').toMatch(/Cursor/);
		expect(notice, '提示明确仓库 .gitnexus/ 索引保留').toMatch(/\.gitnexus\/ 索引会保留/);
	});
});
