import type {ManagedDocumentAdapter, ManagedDocumentSnapshot} from '../../components/managed-document/document-types.js';
import {getRulesPath, openRulesFile, type PromptsTarget, readCurrentRules, saveRules} from '../../services/prompts-service.js';

function loadRulesSnapshot(target: PromptsTarget): ManagedDocumentSnapshot {
	const content = readCurrentRules(target) ?? '';
	return {content, hasContent: content.trim().length > 0, previewContent: content};
}

export function createPromptsDocumentAdapter(target: PromptsTarget): ManagedDocumentAdapter {
	const rulesPath = getRulesPath(target);

	return {
		key: target,
		title: '全局规则管理',
		subtitle: rulesPath,
		emptyMessage: '尚无全局规则文件',
		emptyHintLabel: `新建 ${rulesPath}`,
		editorTitle: '',
		previewFiletype: 'markdown',
		editorFiletype: 'markdown',
			saveSuccessMessage: `已保存到 ${rulesPath}`,
			openSuccessMessage: `已在外部应用中打开 ${rulesPath}`,
			load: () => loadRulesSnapshot(target),
			createInitial: () => readCurrentRules(target) ?? '',
			openExternal: () => openRulesFile(target),
			save: content => saveRules(content, target)
	};
}
