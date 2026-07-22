import {getRulesPath, readCurrentRules, saveRules, type PromptsTarget} from '../../services/prompts-service.js';
import {assembleRulesRecommendation, mergeRecommendationPreservingManagedBlocks} from '../../core/prompts.js';
import type {
	ManagedDocumentAdapter,
	ManagedDocumentImportResult,
	ManagedDocumentSnapshot
} from '../../components/managed-document/document-types.js';

function loadRulesSnapshot(target: PromptsTarget): ManagedDocumentSnapshot {
	const content = readCurrentRules(target) ?? '';
	return {content, hasContent: content.trim().length > 0, previewContent: content};
}

export function createPromptsDocumentAdapter(target: PromptsTarget): ManagedDocumentAdapter {
	const recommendationContent = assembleRulesRecommendation(target) ?? '';
	const rulesPath = getRulesPath(target);

	return {
		key: target,
		title: '全局规则管理',
		subtitle: target === 'cx' ? '查看、导入与编辑 ~/.codex/AGENTS.md' : '查看、导入与编辑 ~/.claude/CLAUDE.md',
		emptyMessage: '尚无全局规则文件',
		emptyHintLabel: `新建 ${rulesPath}`,
		editorTitle: '当前规则',
		recommendationTitle: '推荐规则',
		recommendationUnavailableMessage: '推荐模板不可用',
		recommendationContent,
		previewFiletype: 'markdown',
		recommendationFiletype: 'markdown',
		editorFiletype: 'markdown',
		saveSuccessMessage: `已保存到 ${rulesPath}`,
		load: () => loadRulesSnapshot(target),
		createInitial: () => readCurrentRules(target) ?? '',
		importInto: (): ManagedDocumentImportResult => {
			if (recommendationContent === '') {
				return {ok: false, error: '推荐模板不可用'};
			}

			// 以磁盘文件为受管注释块权威来源，避免依赖编辑缓冲时序。
			const installed = readCurrentRules(target) ?? '';
			return {
				ok: true,
				text: mergeRecommendationPreservingManagedBlocks(recommendationContent, installed),
				message: '已导入推荐到编辑器（保留注入块，可撤销，保存后生效）'
			};
		},
		save: content => saveRules(content, target)
	};
}
