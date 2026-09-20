import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 6.1 门禁：Tools 共享投影不变量（design D2/D6，shared-resource-injection-ui）。
//   - 列表 agentContext 不变性（投影全集顺序 / Ccline 常显 / 重复投影稳定）→ 已迁
//     tests/core/tools-context.test.ts（本脚本不再重复）；
//   - 双态独立：CodeGraph 仅注入 Claude Code 时，cc=已注入 / cx=未注入 同时成立，对侧不塌缩；
//   - 非 inject 类无 injectByAgent；
//   - 显式 target 解析：inject/eject lifecycle 命令随传入 target，不依赖全局上下文。
//
// [P4b 切分] 纯段（Enter 主操作分派 / DSH lifecycle 收敛 / inject 草稿状态机 /
// runInjectChanges 部分成功 / patch 派生 / 批量结算 / CLI 不可用状态点）已迁
// tests/core/tools-shared-projection.test.ts。本脚本保留需要真实落盘信号的段：
//   - CodeGraph 仅 cc 注入的双态快照（~/.claude.json）
//   - Codex-only CCG 的共享投影聚合（~/.codex/.ccg-version）
// R9：投影全集顺序/Ccline 常显（P4a tools-context.test.ts）、CodeGraph `sharingKind` 与
// 显式 target 命令（P1 tools-lifecycle/tools-shared-projection）已覆盖，不重复迁移。
// [P4c 去重] 投影全集顺序/Ccline 常显/重复投影稳定性已删除并改由 tools-context.test.ts 独占承载；
// 同时删除 HEAD 遗留的同义反复断言 `codeGraphUninstallCommands('cx') === 自身`（永远为真，无护栏价值）。

// CCQ_HOME 隔离：投影读取 ~/.claude.json / ~/.codex 真实落盘信号。
const home = mkdtempSync(join(tmpdir(), 'ccq-shared-proj-'));
process.env.CCQ_HOME = home;

const {projectSharedToolComponents, COMPONENT_DEFINITIONS} = await import('../src/core/tools-manage.ts');
const {codeGraphInstallCommands, codeGraphUninstallCommands} = await import('../src/core/tools-lifecycle.ts');

// detected 全集（模拟检测结果）。projectSharedToolComponents 不按 context 过滤。
const detected = COMPONENT_DEFINITIONS.map(def => ({
	...def,
	installed: def.id === 'CodeGraph',
	currentVersion: def.id === 'CodeGraph' ? '1.2.3' : '',
	latestVersion: '',
	hasUpdate: null
}));

// ── 列表 agentContext 不变性：投影不接受 context 参数，结果对 cc/cx 都相同 ──────
// [P4c 去重] 投影全集顺序 + Ccline 常显 + 重复投影稳定性三条已迁
// tests/core/tools-context.test.ts「shared list 全集按分组展示顺序排列（含 Pi CLI / Pi Web）」
// 与「shared list 常显 Ccline 且展示组件全集」；本段无独立断言，不再保留 [PASS] 行。

// ── 双态独立：仅 Claude Code 注入 CodeGraph ────────────────────────────────────
mkdirSync(join(home, '.claude'), {recursive: true});
writeFileSync(
	join(home, '.claude.json'),
	JSON.stringify({mcpServers: {codegraph: {command: 'codegraph', args: ['mcp']}}, projects: {}}, null, 2),
	'utf8'
);
// 不写 ~/.codex/config.toml → Codex 未注入。
const dualProjected = projectSharedToolComponents(detected);
const codegraph = dualProjected.find(c => c.id === 'CodeGraph');
assert.ok(codegraph, 'CodeGraph 在投影中存在');
assert.equal(codegraph.sharingKind, 'shared-cli-per-agent-inject', 'CodeGraph 为 inject 类');
assert.equal(codegraph.injectByAgent.cc.integrated, true, 'Claude Code 侧已注入');
assert.equal(codegraph.injectByAgent.cx.integrated, false, 'Codex 侧未注入（对侧不塌缩）');
console.log('[PASS] 6.1 双态独立：CodeGraph 仅注入 Claude Code 时 cc=已注入/cx=未注入');

// ── 显式 target 解析：inject/eject 命令随传入 target，不依赖全局上下文 ──────────
// 注：本段四条已由 P1 tests/core/tools-lifecycle.test.ts 覆盖，保留不重复迁移。
assert.deepEqual(
	codeGraphInstallCommands('cx'),
	[{cmd: 'codegraph', args: ['install', '--target=codex', '--location=global', '--yes']}],
	'inject Codex 目标解析为 --target=codex'
);
const cxUninstall = codeGraphUninstallCommands('cx');
assert.ok(
	cxUninstall.some(cmd => cmd.args.includes('--target=codex')),
	'eject Codex 目标解析为 --target=codex'
);
const ccInstall = codeGraphInstallCommands('cc');
assert.ok(
	ccInstall.some(cmd => cmd.args.includes('--target=claude')),
	'inject Claude Code 目标解析为 --target=claude'
);
console.log('[PASS] 6.1 显式 target 解析：inject/eject 命令随 target 而非全局上下文');

// ── Codex-only CCG：共享投影必须派生 installed/hasUpdate，允许 u 更新 ──────────
mkdirSync(join(home, '.codex'), {recursive: true});
writeFileSync(join(home, '.codex', '.ccg-version'), '3.1.0\n', 'utf8');
const codexOnlyDetected = detected.map(component =>
	component.id === 'CcgWorkflow'
		? {...component, installed: false, currentVersion: '', latestVersion: '3.2.0', hasUpdate: null}
		: component
);
const codexOnlyCcg = projectSharedToolComponents(codexOnlyDetected).find(component => component.id === 'CcgWorkflow');
assert.equal(codexOnlyCcg.injectByAgent.cc.integrated, false, 'Codex-only CCG 的 Claude Code 侧未安装');
assert.equal(codexOnlyCcg.injectByAgent.cx.integrated, true, 'Codex-only CCG 的 Codex 侧已安装');
assert.equal(codexOnlyCcg.installed, true, 'Codex-only CCG 聚合 installed=true');
assert.equal(codexOnlyCcg.currentVersion, '3.1.0', 'Codex-only CCG 聚合当前版本来自 Codex');
assert.equal(codexOnlyCcg.hasUpdate, true, 'Codex-only CCG 根据 Codex 版本判定可更新');
console.log('[PASS] Codex-only CCG 在共享列表中可检测并更新');

delete process.env.CCQ_HOME;
console.log('[PASS] Tools 共享投影不变量门禁全部通过');
