import {expect, test} from 'bun:test';

import {piSettingsPath} from '../../src/core/paths.js';
import {getConfigPath, loadRecommendationAnnotated} from '../../src/services/config-service.js';

// P5b 迁移自 scripts/verify-pi-config-rules.mjs 的纯段（11 条静态断言）：
//   - getConfigPath('pi') 路径投影（1）
//   - Pi 推荐配置契约内容（10）
// 真实 fs 段（~/.pi/agent/settings.json 展示隔离 / 保存回填 / 项目 settings.json 只读 /
// 0600 权限 / 损坏拒写 / AGENTS.md 目标隔离）仍留在 scripts/verify-pi-config-rules.mjs。
// 载体对账见 research-reconciliation-P5b.md §3。

test('Pi Config 路径指向 ~/.pi/agent/settings.json', () => {
	expect(getConfigPath('pi'), 'Pi Config 必须指向 ~/.pi/agent/settings.json').toBe(piSettingsPath());
});

test('Pi 推荐配置契约内容：通用项齐备、供应商/扩展/本机状态字段全部排除', () => {
	const recommendation = loadRecommendationAnnotated('pi') ?? '';
	expect(recommendation, 'Pi 推荐配置应包含当前通用工具设置').toMatch(
		/"defaultTools": \[\s*"read",\s*"powershell",\s*"edit",\s*"write"\s*\]/
	);
	expect(recommendation, 'Pi 推荐配置应包含当前主题设置').toMatch(/"theme": "light"/);
	expect(recommendation, 'Pi 推荐配置应包含当前思考块显示设置').toMatch(/"hideThinkingBlock": true/);
	expect(recommendation, 'Pi 推荐配置应包含当前缓存提示设置').toMatch(/"showCacheMissNotices": false/);
	expect(recommendation, 'Pi 推荐配置应包含当前启动设置').toMatch(/"quietStartup": true/);
	expect(recommendation, 'Pi 推荐配置应包含当前 TUI 模式').toMatch(/"tuiMode": "regular"/);
	expect(recommendation, 'Pi 推荐配置应包含当前退出输出设置').toMatch(/"fullscreenExitOutput": "transcript"/);
	expect(recommendation, 'Pi 推荐配置应包含当前 Mermaid 设置').toMatch(/"markdown": \{[\s\S]*"mermaid": "final"/);
	expect(recommendation, 'Pi 推荐配置应以注释说明配置边界').toMatch(/\/\/ .*通用/);
	expect(recommendation, 'Pi 推荐配置不得包含供应商、扩展或本机状态字段').not.toMatch(
		/"(?:defaultProvider|defaultModel|defaultThinkingLevel|modelThinkingLevels|enabledModels|auth|models|mcp|packages|extensions|skills|prompts|themes|enableSkillCommands|npmCommand|lastChangelogVersion|httpProxy)"\s*:/
	);
});
