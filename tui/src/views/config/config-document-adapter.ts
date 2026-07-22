import {
	configFileExists,
	fillMissingIntoText,
	getConfigPath,
	loadRecommendationAnnotated,
	readCurrentConfigText,
	saveConfigText,
	type ConfigTarget
} from '../../services/config-service.js';
import type {
	ManagedDocumentAdapter,
	ManagedDocumentImportResult,
	ManagedDocumentSnapshot
} from '../../components/managed-document/document-types.js';

function loadConfigSnapshot(target: ConfigTarget): ManagedDocumentSnapshot {
	const content = readCurrentConfigText(target);
	const fileExists = configFileExists(target);
	return {
		content,
		hasContent: fileExists || content.trim().length > 0,
		previewContent: content.trim().length > 0 ? content : target === 'cx' ? '' : '{\n}'
	};
}

export function createConfigDocumentAdapter(target: ConfigTarget): ManagedDocumentAdapter {
	const isCodex = target === 'cx';
	const configPath = getConfigPath(target);
	const recommendationContent = loadRecommendationAnnotated(target) ?? '';

	return {
		key: target,
		title: '配置文件管理',
		subtitle: isCodex ? '查看、补全与编辑 ~/.codex/config.toml' : '查看、补全与编辑 ~/.claude/settings.json',
		headerNotice: isCodex ? '已排除供应商/MCP配置' : '已排除供应商配置',
		emptyMessage: isCodex ? '尚无 Codex 配置文件' : '尚无配置文件',
		emptyHintLabel: isCodex ? `新建 ${configPath}` : '新建 ~/.claude/settings.json',
		editorTitle: '当前配置',
		recommendationTitle: '推荐配置',
		recommendationUnavailableMessage: '推荐配置契约不可用',
		recommendationContent,
		previewFiletype: isCodex ? 'toml' : 'json',
		recommendationFiletype: isCodex ? 'toml' : 'jsonc',
		editorFiletype: isCodex ? 'text' : 'json',
		editorIsJson: !isCodex,
		saveSuccessMessage: isCodex ? `已保存到 ${configPath}` : `已保存到 ${configPath}（供应商配置已原样保留）`,
		load: () => loadConfigSnapshot(target),
		createInitial: () => readCurrentConfigText(target) || (isCodex ? '' : '{}'),
		importInto: (editorText): ManagedDocumentImportResult => {
			if (recommendationContent === '') {
				return {ok: false, error: '推荐配置契约不可用'};
			}

			const result = fillMissingIntoText(editorText, target);
			if (!result.ok) {
				return {ok: false, error: result.error};
			}

			return {
				ok: true,
				text: result.text,
				message:
					result.changed === 0
						? '配置已是最新，无需补全（可撤销，保存后生效）'
						: `已补全 ${result.changed} 项缺失配置到编辑器（可撤销，保存后生效）`
			};
		},
		save: content => saveConfigText(content, target)
	};
}
