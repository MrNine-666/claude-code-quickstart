import {expect, test} from 'bun:test';

import {applyFillMissing, loadConfigContract, mergeProviderEnvOnSave, stripProviderEnvFromText} from '../../src/core/config-recommend.js';
import {fillMissingIntoText, loadRecommendationAnnotated} from '../../src/services/config-service.js';

// P5b 迁移自 scripts/verify-config-view.mjs 的纯段（33 条静态断言）：
//   - fill-missing 幂等性 P-1（2）
//   - DoNotManage 保护 P-2（9）
//   - ConfigView Claude ownership 过滤展示 + 保存合并保护（11）
//   - Codex 推荐配置契约内容（6）+ Codex fill-missing 空缓冲补齐（4）
// 真实 fs 段（importFillMissing 端到端幂等、损坏 settings.json 拒绝覆盖、Codex config.toml
// 结构化保存 / 过滤展示 / 路径隔离 / 错误脱敏）仍留在 scripts/verify-config-view.mjs。
// createConfigDocumentAdapter('cx').openExternal / openSuccessMessage（2）已由 P1-G2 载体
// tests/core/config-document-adapter.test.ts 覆盖，按 R9 不重复迁移，保留在 verify（P5e 去重）。

const contract = loadConfigContract();
if (!contract) throw new Error('claude-config.json 契约不可用');

test('fill-missing 幂等性 (P-1)', () => {
	expect(contract, 'claude-config.json 契约应可加载').toBeTruthy();
	const source = {language: '简体中文', env: {MAX_THINKING_TOKENS: '31999'}, permissions: {allow: ['CustomTool']}};
	const first = applyFillMissing(contract, source);
	const second = applyFillMissing(contract, first.settings);
	expect(second.updatedItems, '第二次 fill-missing 应无变更项').toEqual([]);
	expect(second.settings, '幂等：两次合并结果一致').toEqual(first.settings);
});

test('DoNotManage 保护 (P-2)', () => {
	const protectedSource = {
		model: 'my-model',
		statusLine: {type: 'command', command: 'ccline'},
		hooks: {Stop: [{matcher: ''}]},
		env: {ANTHROPIC_AUTH_TOKEN: 'sk-secret', ANTHROPIC_BASE_URL: 'https://x.com'},
		permissions: {allow: ['CustomTool']}
	};
	const guarded = applyFillMissing(contract, protectedSource);
	const settings = guarded.settings as {
		model?: unknown;
		statusLine?: unknown;
		hooks?: unknown;
		env: Record<string, string>;
		language?: unknown;
		permissions: {allow: string[]};
	};
	expect(settings.model, 'model 不被触碰').toBe('my-model');
	expect(settings.statusLine, 'statusLine 不被触碰').toEqual({type: 'command', command: 'ccline'});
	expect(settings.hooks, 'hooks 不被触碰').toEqual({Stop: [{matcher: ''}]});
	expect(settings.env.ANTHROPIC_AUTH_TOKEN, '供应商 token 不被触碰').toBe('sk-secret');
	expect(settings.env.ANTHROPIC_BASE_URL, '供应商 baseUrl 不被触碰').toBe('https://x.com');
	expect(settings.language, '缺失 language 被补充').toBe('简体中文');
	expect(settings.env.MAX_THINKING_TOKENS, '缺失受管 env 被补充').toBe('31999');
	expect(settings.permissions.allow.includes('CustomTool'), '用户已有权限保留').toBe(true);
	expect(settings.permissions.allow.includes('Bash'), '基础权限追加').toBe(true);
});

test('ConfigView Claude ownership 过滤展示 + 保存合并保护', () => {
	// DoNotManageTopLevelKeys 仅剩 model：hooks/statusLine/outputStyle 等孤儿字段已在配置文件页放开（可见可编辑），
	// mcpServers 不在 settings.json（归 ~/.claude.json + MCP 视图）但即便误入也随编辑器走。
	const claudeOriginal = JSON.stringify(
		{
			model: 'keep-model',
			statusLine: {type: 'command', command: 'ccline'},
			hooks: {Stop: [{matcher: ''}]},
			mcpServers: {context7: {command: 'npx'}},
			env: {ANTHROPIC_AUTH_TOKEN: 'sk-secret', MAX_THINKING_TOKENS: '123'},
			language: '简体中文'
		},
		null,
		2
	);
	const strippedClaude = stripProviderEnvFromText(claudeOriginal);
	expect(strippedClaude.ok, 'Claude Config 展示过滤应成功').toBe(true);
	if (!strippedClaude.ok) throw new Error('Claude Config 展示过滤失败');
	expect(strippedClaude.text.includes('keep-model'), 'Claude Config 展示必须过滤 model').toBe(false);
	expect(strippedClaude.text.includes('statusLine'), 'Claude Config 展示 statusLine（孤儿字段已放开）').toBe(true);
	expect(strippedClaude.text.includes('hooks'), 'Claude Config 展示 hooks（孤儿字段已放开）').toBe(true);
	expect(strippedClaude.text.includes('mcpServers'), 'Claude Config 展示 mcpServers（不再过滤，正常不在 settings.json）').toBe(true);
	expect(strippedClaude.text.includes('ANTHROPIC_AUTH_TOKEN'), 'Claude Config 展示必须过滤供应商 env').toBe(false);
	const mergedClaude = mergeProviderEnvOnSave(strippedClaude.text, claudeOriginal);
	expect(mergedClaude.ok, 'Claude Config 保存合并应成功').toBe(true);
	if (!mergedClaude.ok) throw new Error('Claude Config 保存合并失败');
	const mergedClaudeJson = JSON.parse(mergedClaude.text);
	expect(mergedClaudeJson.model, 'Claude Config 保存必须保留原 model（唯一仍过滤项）').toBe('keep-model');
	// statusLine/hooks/mcpServers 已由编辑器持有（未改动则保留原值），不再从原文恢复
	expect(mergedClaudeJson.statusLine, 'Claude Config 保存保留 statusLine（编辑器持有）').toEqual({type: 'command', command: 'ccline'});
	expect(mergedClaudeJson.hooks, 'Claude Config 保存保留 hooks（编辑器持有）').toEqual({Stop: [{matcher: ''}]});
	expect(mergedClaudeJson.env.ANTHROPIC_AUTH_TOKEN, 'Claude Config 保存必须保留原供应商 env').toBe('sk-secret');
});

test('6.10 Codex 推荐配置契约内容（xhigh / features / memories / 无 notify）', () => {
	const annotatedRecommendation = loadRecommendationAnnotated('cx');
	expect(annotatedRecommendation ?? '', 'Codex 推荐配置应使用 xhigh 推理等级').toMatch(/model_reasoning_effort\s*=\s*"xhigh"/);
	expect(annotatedRecommendation ?? '', '推荐配置应展示联网增强项').toMatch(/#\s*\[sandbox_workspace_write\]/);
	expect(annotatedRecommendation ?? '', '推荐配置应启用 features 表').toMatch(/^\[features\]$/m);
	expect(annotatedRecommendation ?? '', '推荐配置应启用 memories feature').toMatch(/^memories\s*=\s*true$/m);
	expect(annotatedRecommendation ?? '', '推荐配置应展示 memories 子选项').toMatch(/^\[memories\]$/m);
	expect(annotatedRecommendation ?? '', '推荐配置不得写入本机通知配置').not.toMatch(/notify\s*=/);
});

test('6.10 Codex fill-missing 对空配置只补托管项，不自动开启网络 / memories', () => {
	const recommendedFill = fillMissingIntoText('', 'cx');
	expect(recommendedFill.ok, 'Codex fill-missing 应接受空配置').toBe(true);
	if (recommendedFill.ok) {
		expect(recommendedFill.text, 'fill-missing 应补 xhigh 推理等级').toMatch(/model_reasoning_effort\s*=\s*"xhigh"/);
		expect(recommendedFill.text, 'fill-missing 不得自动开启网络访问').not.toMatch(/\[sandbox_workspace_write\]/);
		expect(recommendedFill.text, 'fill-missing 不得自动开启 memories').not.toMatch(/\[features\]/);
	}
});
