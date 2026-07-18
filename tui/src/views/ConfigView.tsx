import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TextAttributes, type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { borderColors, colors, PRIMARY } from '../theme/index.js';
import { isAppModifier, isEditingModifier } from '../utils/keyboard.js';
import {
	TextareaEditor,
	ViewHeader,
	ListEmptyState,
	toast,
	ThemedScrollbox,
	CodePreview,
	type TextEditorHandle
} from '../components/index.js';
import {
	configFileExists,
	fillMissingIntoText,
	getConfigPath,
	loadRecommendationAnnotated,
	readCurrentConfigText,
	saveConfigText,
	type ConfigTarget
} from '../services/config-service.js';
import type {AgentContext} from '../state/manage-state.js';

// 配置文件页（view-first，对齐 PromptsView）+ 字段级（settings.json 多页共享）：
// view 态只读渲染当前配置文件（手动 JSON/TOML 着色；opentui 未内置 json grammar）。
// 字段所有权（HC-12）：供应商 env（token/base_url/model 等，DoNotManageEnvKeys）从展示中剥离，归供应商页管；
// 保存时自动从原文件恢复供应商 env，绝不丢失。标题标注「已排除供应商配置」。
// 编辑、推荐边栏、fill-missing 与保存等键位只在 keybindings/shortcuts 单一数据源维护。
// 取消编辑直接回 view（放弃未保存改动，toast 提示）。
// HC-SHORTCUT-SINGLE-SOURCE：键位处理用 command 映射，footer 文案由 shortcuts.ts 按 subMode 解析。

type Mode = 'view' | 'edit';
type Panel = 'editor' | 'split';
type Focus = 'editor' | 'recommend';

export type ConfigViewProps = {
	readonly agentContext: AgentContext;
	readonly active: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly onExitToHeader?: () => void;
	readonly syntaxStyle?: import('@opentui/core').SyntaxStyle | null;
};

export function ConfigView({ agentContext, active, onSubModeChange, onExitToNav, onExitToHeader, syntaxStyle = null }: ConfigViewProps) {
	const target: ConfigTarget = agentContext;
	const isCodex = target === 'cx';
	const recommendationContent = useMemo(() => loadRecommendationAnnotated(target) ?? '', [target]);
	const recommendationAvailable = recommendationContent !== '';
	const configPath = useMemo(() => getConfigPath(target), [target]);

	// view 态展示内容（过滤非 Config 页管辖字段；文件存在但过滤后为空也应进入预览态）
	const [viewContent, setViewContent] = useState<string>(() => readCurrentConfigText(target));
	const [fileExists, setFileExists] = useState<boolean>(() => configFileExists(target));
	const hasContent = fileExists || viewContent.trim().length > 0;
	const previewContent = viewContent.trim().length > 0 ? viewContent : (isCodex ? '' : '{\n}');

	// edit 态
	const [mode, setMode] = useState<Mode>('view');
	const [editInitial, setEditInitial] = useState<string>('');
	const [panel, setPanel] = useState<Panel>('editor');
	const [focus, setFocus] = useState<Focus>('editor');
	const [dirty, setDirty] = useState(false);

	const editorRef = useRef<TextEditorHandle>(null);
	// scrollbox 默认不响应键盘 ↑/↓（需鼠标点击获焦），这里持 ref 主动 scrollBy 驱动滚动
	const viewScrollRef = useRef<ScrollBoxRenderable>(null);
	const recommendScrollRef = useRef<ScrollBoxRenderable>(null);

	// subMode → footer 解析（view / edit / split 细分）
	const subMode = mode === 'view'
		? (hasContent ? 'view-render' : 'view-empty')
		: panel === 'split'
			? (focus === 'recommend' ? 'edit-split-recommend' : 'edit-split-editor')
			: 'edit';

	useEffect(() => {
		setViewContent(readCurrentConfigText(target));
		setFileExists(configFileExists(target));
		setEditInitial('');
		setMode('view');
		setPanel('editor');
		setFocus('editor');
		setDirty(false);
	}, [target]);

	useEffect(() => {
		if (!active) return;
		onSubModeChange?.(subMode);
	}, [active, subMode, onSubModeChange]);

	// split 态焦点在边栏时编辑区失活（边框变灰），与边栏 active 同步
	const editorActive = mode === 'edit' && active && (panel === 'editor' || focus === 'editor');
	const textareaFocused = mode === 'edit' && focus === 'editor';
	const tabMode = panel === 'split' ? 'cycle-focus' : 'indent';

	// ── 操作 ──
	const refreshView = (): void => {
		setViewContent(readCurrentConfigText(target));
		setFileExists(configFileExists(target));
	};

	// 进入编辑器：initial = '{}' (a 新建·仅空状态) | 现有磁盘内容（已剥离供应商 env）(e 编辑)
	const enterEdit = (initial: string): void => {
		setEditInitial(initial);
		setDirty(false);
		setPanel('editor');
		setFocus('editor');
		setMode('edit');
	};

	const togglePanel = (): void => {
		if (panel === 'editor') {
			if (!recommendationAvailable) {
				toast.error('推荐配置契约不可用');
				return;
			}
			setPanel('split');
			setFocus('recommend');
		} else {
			setPanel('editor');
			setFocus('editor');
		}
	};

	const cycleFocus = (): void => {
		setFocus(f => (f === 'editor' ? 'recommend' : 'editor'));
	};

	// fill-missing 灌缓冲：对当前编辑缓冲执行合并（仅补缺失，保留用户已有配置），结果写回编辑器，可用编辑器撤销。
	// 与全局规则页 replaceText(全文) 的差异：配置文件必须保留供应商/model/权限等已有项（HC-12 fill-missing-only）。
	const doImport = (): void => {
		if (!recommendationAvailable) {
			toast.error('推荐配置契约不可用');
			return;
		}
		const result = fillMissingIntoText(editorRef.current?.getText() ?? '', target);
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		editorRef.current?.replaceText(result.text);
		setDirty(true);
		toast.success(result.changed === 0
			? '配置已是最新，无需补全（可撤销，保存后生效）'
			: `已补全 ${result.changed} 项缺失配置到编辑器（可撤销，保存后生效）`);
	};

	const handleSave = (content: string): { ok: boolean; error?: string; warning?: string } => {
		const result = saveConfigText(content, target);
		if (result.ok) {
			setDirty(false);
			refreshView();
			toast.success(isCodex ? `已保存到 ${configPath}` : `已保存到 ${configPath}（供应商配置已原样保留）`);
			if (result.warning) {
				toast.info(result.warning);
			}
			// 保存后回只读展示（编辑器作为临时态，无需停留）
			setMode('view');
			setPanel('editor');
			setFocus('editor');
		}
		return result;
	};

	const handleContentChange = (): void => {
		setDirty(true);
	};

	// 取消编辑：直接回只读展示；有未保存改动时 toast 提示（不弹确认浮层，避免遮挡卡住）
	const cancelEdit = (): void => {
		if (dirty) toast.info('已放弃未保存的编辑');
		refreshView();
		setMode('view');
		setPanel('editor');
		setFocus('editor');
		setDirty(false);
	};

	// onCancel 防御兜底：escapeMode='bubble' 时编辑态 Esc 不走这里（由 useKeyboard 单一处理）。
	const handleEditorCancel = (): void => {
		cancelEdit();
	};

	// ── 键盘（单一入口，按 mode / panel / focus 分流）──
	useKeyboard((keyEvent) => {
		if (!active) return;
		const name = keyEvent.name;
		const appMod = isAppModifier(keyEvent);
		const editingMod = isEditingModifier(keyEvent);

		// ── view 态 ──
		if (mode === 'view') {
			// Esc/← 返回左侧导航（对齐 ProviderView/McpView/SkillsView 列表态返回键）
			if (name === 'escape' || name === 'left' || name === 'arrowleft') { onExitToNav(); return; }
			if (name === 'e' && hasContent) { enterEdit(readCurrentConfigText(target) || (isCodex ? '' : '{}')); return; }
			if (name === 'a' && !hasContent) { enterEdit(isCodex ? '' : '{}'); return; }
			// ↑/↓ 滚动展示区（scrollbox 需主动驱动，否则默认不响应键盘）
			if (name === 'up') {
				const atTop = (viewScrollRef.current?.scrollTop ?? 0) <= 0;
				if (atTop && onExitToHeader) { onExitToHeader(); return; }
				viewScrollRef.current?.scrollBy(-1);
				return;
			}
			if (name === 'down') { viewScrollRef.current?.scrollBy(1); return; }
			return;
		}

		// ── edit 态 ──
		// Esc：取消编辑直接回 view
		if (name === 'escape') { cancelEdit(); return; }

		// 主操作：编辑器获焦时保存由 TextareaEditor 自管；边栏获焦时由页面兜底保存。
		if (editingMod && name === 's' && panel === 'split' && focus === 'recommend') {
			handleSave(editorRef.current?.getText() ?? '');
			return;
		}
		if (appMod && name === 't') { togglePanel(); return; }
		// 导入快捷键避开终端 Tab 冲突，触发 fill-missing 灌缓冲
		if (appMod && name === 'o') { doImport(); return; }

		// 边栏焦点：↑/↓ 滚动推荐；Tab 切回编辑器
		if (panel === 'split' && focus === 'recommend') {
			if (name === 'up') { recommendScrollRef.current?.scrollBy(-1); return; }
			if (name === 'down') { recommendScrollRef.current?.scrollBy(1); return; }
			if (name === 'tab') { cycleFocus(); return; }
		}
	});

	// ── view 态渲染（手动 JSON 着色，opentui 无 json grammar 的回退方案）──
	if (mode === 'view') {
		return (
			<box flexDirection="column" flexGrow={1}>
				<ViewHeader
					title='配置文件管理'
					subtitle={isCodex ? '查看、补全与编辑 ~/.codex/config.toml' : '查看、补全与编辑 ~/.claude/settings.json'}
					right={<text fg={colors.warning} attributes={TextAttributes.DIM}>{isCodex ? '已排除供应商/MCP配置' : '已排除供应商配置'}</text>}
				/>
				{hasContent ? (
					<box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={borderColors.active}>
						<ThemedScrollbox ref={viewScrollRef} style={{flexGrow: 1}}>
							<CodePreview content={previewContent} filetype={isCodex ? 'toml' : 'json'} />
						</ThemedScrollbox>
					</box>
				) : (
					<ListEmptyState
						message={isCodex ? '尚无 Codex 配置文件' : '尚无配置文件'}
						hint={{label: isCodex ? `新建 ${configPath}` : '新建 ~/.claude/settings.json', enabled: true}}
					/>
				)}
			</box>
		);
	}

	// ── edit 态渲染 ──
	// 关键：editor 容器在树中的父路径必须恒定，否则 split↔editor 切换时 React 卸载重挂
	// TextareaEditor，<textarea initialValue> 用 editInitial 重新初始化、丢失用户编辑。
	// 做法：始终渲染 row 容器 + 固定位置的 editor 面板（key='editor-panel'），推荐边栏作为
	// 带 key 的兄弟条件插入/移除。React 按 key 匹配，editor 面板不 remount，textarea 状态保留。
	const showRecommend = panel === 'split' && recommendationAvailable;
	const editorEl = (
		<TextareaEditor
			ref={editorRef}
			title='当前配置'
			initialContent={editInitial}
			active={editorActive}
			isJson={!isCodex}
			filetype={isCodex ? 'text' : 'json'}
			syntaxStyle={syntaxStyle}
			tabMode={tabMode}
			textareaFocused={textareaFocused}
			escapeMode="bubble"
			previewEnabled={false}
			onContentChange={handleContentChange}
			onCycleFocus={() => cycleFocus()}
			onSave={handleSave}
			onCancel={handleEditorCancel}
		/>
	);

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader
				title='配置文件管理'
				subtitle={isCodex ? '查看、补全与编辑 ~/.codex/config.toml' : '查看、补全与编辑 ~/.claude/settings.json'}
				right={<text fg={colors.warning} attributes={TextAttributes.DIM}>{isCodex ? '已排除供应商/MCP配置' : '已排除供应商配置'}</text>}
			/>
			<box flexDirection="row" flexGrow={1} minHeight={0} border={false} gap={1} marginTop={1}>
				{showRecommend ? (
					<box key='recommend-panel' flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
						<text flexShrink={0} fg={colors.primary} attributes={TextAttributes.BOLD}>推荐配置</text>
						<box
							flexGrow={1}
							minWidth={0}
							minHeight={0}
							borderStyle="rounded"
							borderColor={focus === 'recommend' ? borderColors.active : borderColors.inactive}
						>
							<ThemedScrollbox ref={recommendScrollRef} style={{flexGrow: 1, minWidth: 0, minHeight: 0}}>
								<CodePreview content={recommendationContent} filetype={isCodex ? 'toml' : 'jsonc'} />
							</ThemedScrollbox>
						</box>
					</box>
				) : null}
				<box key='editor-panel' flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
					{editorEl}
				</box>
			</box>
		</box>
	);
}
