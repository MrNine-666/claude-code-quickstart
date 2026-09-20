import {afterEach, beforeEach, expect, test} from 'bun:test';
import {join} from 'node:path';

import {claudeDir, codexAgentsPath} from '../../src/core/paths.js';
import {getConfigPath, loadRecommendationAnnotated} from '../../src/services/config-service.js';
import {getRulesPath} from '../../src/services/prompts-service.js';
import {createTempHome, type TempHome} from '../helpers/temp-home.js';

// P5b 迁移自 scripts/verify-config-rules-reuse.mjs 的纯段（7 条静态断言）：
//   - Config 目标文件按 agent 切换：settings.json ↔ config.toml（2）
//   - Rules 目标文件按 agent 切换：CLAUDE.md ↔ AGENTS.md 路径隔离（3）
//   - Codex 推荐配置契约含 sandbox_mode / file_opener（2）
// 真实 fs 段（Claude/Codex settings 字节读写、Codex fill-missing 过滤展示、Rules 落盘）仍留在
// scripts/verify-config-rules-reuse.mjs。
// 「Config UI 复用快捷键」段（8 条运行期）是 `CONFIG_SHORTCUTS.includes(key)` 对自身元素的自指
// 恒真断言，不读任何 src；迁入 tests 会制造假绿，故按判据保留在 verify 并登记（见对账 §5）。

let tempHome: TempHome;
beforeEach(() => {
	tempHome = createTempHome('ccq-config-rules-reuse-');
});
afterEach(() => {
	tempHome.restore();
	tempHome.cleanup();
});

test('1.12b Config 路径隔离：settings.json ↔ config.toml', () => {
	expect(getConfigPath('cc'), 'Claude Config 目标为 settings.json').toBe(join(tempHome.path, '.claude', 'settings.json'));
	expect(getConfigPath('cx'), 'Codex Config 目标为 config.toml').toBe(join(tempHome.path, '.codex', 'config.toml'));
});

test('6.7/6.8/6.9 Rules 路径隔离：CLAUDE.md ↔ AGENTS.md', () => {
	expect(getRulesPath('cc'), 'Claude 全局规则为 CLAUDE.md').toBe(join(claudeDir(), 'CLAUDE.md'));
	expect(getRulesPath('cx'), 'Codex 全局规则为 AGENTS.md').toBe(codexAgentsPath());
	expect(/CLAUDE\.md/.test(getRulesPath('cx')), 'Codex 全局规则不得写 CLAUDE.md').toBe(false);
	// P5d 迁自 scripts/verify-prompts-view.mjs：Pi 规则目标路径隔离（原脚本 3 目标循环，
	// cc/cx 两条已由本文件覆盖，pi 一条为覆盖缺口）。
	expect(getRulesPath('pi'), 'Pi 全局规则为 ~/.pi/agent/AGENTS.md').toBe(join(tempHome.path, '.pi', 'agent', 'AGENTS.md'));
});

test('6.4/6.5 Codex 推荐配置契约可加载且含 file_opener', () => {
	expect(loadRecommendationAnnotated('cx')?.includes('sandbox_mode'), 'Codex 推荐配置契约可加载').toBe(true);
	expect(loadRecommendationAnnotated('cx')?.includes('file_opener'), 'Codex 推荐配置含 file_opener').toBe(true);
});
