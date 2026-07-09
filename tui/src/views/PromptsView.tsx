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
import { assembleRulesRecommendation, mergeRecommendationPreservingManagedBlocks } from '../core/prompts.js';
import {
	getRulesPath,
	readCurrentRules,
	saveRules,
	type PromptsTarget
} from '../services/prompts-service.js';
import type {AgentContext} from '../state/manage-state.js';

// 全局规则页（view-first）：
// 进入先渲染只读本地规则文件；无内容则展示创建动作说明。
// 编辑、推荐边栏、导入推荐与保存等键位只在 keybindings/shortcuts 单一数据源维护。
// 取消编辑直接回 view（放弃未保存改动，toast 提示）。
// HC-SHORTCUT-SINGLE-SOURCE：键位处理用 command 映射，footer 文案由 shortcuts.ts 按 subMode 解析。

type Mode = 'view' | 'edit';
type Panel = 'editor' | 'split';
type Focus = 'editor' | 'recommend';
type Confirm = 'none';

export type PromptsViewProps = {
	readonly agentContext: AgentContext;
	readonly active: boolean;
	readonly viewportHeight?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly onExitToHeader?: () => void;
	readonly syntaxStyle?: import('@opentui/core').SyntaxStyle | null;
};

export function PromptsView({ agentContext, active, viewportHeight = 16, onSubModeChange, onExitToNav, onExitToHeader, syntaxStyle = null }: PromptsViewProps) {
	const target: PromptsTarget = agentContext;
	const isCodex = target === 'cx';
	const recommendationContent = useMemo(() => assembleRulesRecommendation(target) ?? '', [target]);
	const recommendationAvailable = recommendationContent !== '';
	const rulesPath = useMemo(() => getRulesPath(target), [target]);

	// view 态展示内容（保存 / 取消后重新读盘刷新，保证展示最新）
	const [viewContent, setViewContent] = useState<string>(() => readCurrentRules(target) ?? '');
	const hasContent = viewContent.trim().length > 0;

	// edit 态
	const [mode, setMode] = useState<Mode>('view');
	const [editInitial, setEditInitial] = useState<string>('');
	const [panel, setPanel] = useState<Panel>('editor');
	const [focus, setFocus] = useState<Focus>('editor');
	const [confirm, setConfirm] = useState<Confirm>('none');
	const [dirty, setDirty] = useState(false);

	const editorRef = useRef<TextEditorHandle>(null);
	// scrollbox 默认不响应键盘 ↑/↓（需鼠标点击获焦），这里持 ref 主动 scrollBy 驱动滚动
	const viewScrollRef = useRef<ScrollBoxRenderable>(null);
	const recommendScrollRef = useRef<ScrollBoxRenderable>(null);

	// subMode → footer 解析（view / edit / confirm / split 细分）
	const subMode = mode === 'view'
		? (hasContent ? 'view-render' : 'view-empty')
		: confirm !== 'none'
			? `confirm-${confirm}`
			: panel === 'split'
				? (focus === 'recommend' ? 'edit-split-recommend' : 'edit-split-editor')
				: 'edit';

	useEffect(() => {
		setViewContent(readCurrentRules(target) ?? '');
		setEditInitial('');
		setMode('view');
		setPanel('editor');
		setFocus('editor');
		setConfirm('none');
		setDirty(false);
	}, [target]);

	useEffect(() => {
		if (!active) return;
		onSubModeChange?.(subMode);
	}, [active, subMode, onSubModeChange]);

	// split 态焦点在边栏时编辑区失活（边框变灰），与边栏 active 同步
	const editorActive = mode === 'edit' && active && confirm === 'none' && (panel === 'editor' || focus === 'editor');
	const textareaFocused = mode === 'edit' && confirm === 'none' && focus === 'editor';
	const tabMode = panel === 'split' ? 'cycle-focus' : 'indent';
	// 编辑态保留全局 ViewHeader：右侧内容区固定高，先扣除标题行，避免编辑器 flex 抢占导致标题被裁剪。
	const bodyViewportHeight = Math.max(1, viewportHeight - 2);
	const editorViewportHeight = bodyViewportHeight;

	// ── 操作 ──
	const refreshView = (): void => {
		setViewContent(readCurrentRules(target) ?? '');
	};

	// 进入编辑器：initial = '' (a 新建·仅空状态) | 现有磁盘内容 (e 编辑)
	const enterEdit = (initial: string): void => {
		setEditInitial(initial);
		setDirty(false);
		setPanel('editor');
		setFocus('editor');
		setConfirm('none');
		setMode('edit');
	};

	const togglePanel = (): void => {
		setConfirm('none');
		if (panel === 'editor') {
			if (!recommendationAvailable) {
				toast.error('推荐模板不可用');
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

	const requestImport = (): void => {
		doImport();
	};

	const doImport = (): void => {
		if (!recommendationAvailable) {
			toast.error('推荐模板不可用');
			setConfirm('none');
			return;
		}
		// 保留 CodeGraph / ccg-workflow 注入到已安装规则文件的注释块：以磁盘文件为权威来源
		// （不依赖 textarea 编辑缓冲的 plainText 时序），只覆盖块以外的推荐正文（cc/cx 同源处理）。
		const installed = readCurrentRules(target) ?? '';
		const merged = mergeRecommendationPreservingManagedBlocks(recommendationContent, installed);
		editorRef.current?.replaceText(merged);
		setDirty(true);
		setConfirm('none');
		toast.success('已导入推荐到编辑器（保留注入块，可撤销，保存后生效）');
	};

	const handleSave = (content: string): { ok: boolean; error?: string } => {
		const result = saveRules(content, target);
		if (result.ok) {
			setDirty(false);
			refreshView();
			toast.success(`已保存到 ${rulesPath}`);
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
		setConfirm('none');
	};

	// onCancel 防御兜底：escapeMode='bubble' 时编辑态 Esc 不走这里（由 useKeyboard 单一处理）。
	const handleEditorCancel = (): void => {
		cancelEdit();
	};

	// ── 键盘（单一入口，按 mode / confirm / panel / focus 分流）──
	useKeyboard((keyEvent) => {
		if (!active) return;
		const name = keyEvent.name;
		const appMod = isAppModifier(keyEvent);
		const editingMod = isEditingModifier(keyEvent);

		// 导入推荐不再弹确认浮层：导入只写入编辑缓冲，不落盘，可用编辑器撤销。
		// ── view 态 ──
		if (mode === 'view') {
			// Esc/← 返回左侧导航（对齐 ProviderView/McpView/SkillsView 列表态返回键）
			if (name === 'escape' || name === 'left' || name === 'arrowleft') { onExitToNav(); return; }
			if (name === 'e' && hasContent) { enterEdit(readCurrentRules(target) ?? ''); return; }
			if (name === 'a' && !hasContent) { enterEdit(''); return; }
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
		// 导入快捷键避开终端 Tab 冲突，用于触发导入
		if (appMod && name === 'o') { requestImport(); return; }

		// 边栏焦点：↑/↓ 滚动推荐；Tab 切回编辑器
		if (panel === 'split' && focus === 'recommend') {
			if (name === 'up') { recommendScrollRef.current?.scrollBy(-1); return; }
			if (name === 'down') { recommendScrollRef.current?.scrollBy(1); return; }
			if (name === 'tab') { cycleFocus(); return; }
		}
	});

	// ── view 态渲染 ──
	if (mode === 'view') {
		return (
			<box flexDirection="column" flexGrow={1}>
				<ViewHeader title={isCodex ? 'Codex 全局规则管理' : '全局规则管理'} subtitle={isCodex ? '查看、导入与编辑 CODEX_HOME/AGENTS.md' : '查看、导入、复制与编辑全局 CLAUDE.md'} />
				{hasContent ? (
					<box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={borderColors.active} paddingX={1}>
						<ThemedScrollbox ref={viewScrollRef} style={{flexGrow: 1}}>
							<CodePreview content={viewContent} filetype="markdown" />
						</ThemedScrollbox>
					</box>
				) : (
					<ListEmptyState
						message={isCodex ? '尚无 Codex 全局规则文件' : '尚无全局规则文件'}
						hint={{label: `新建 ${rulesPath}`, enabled: true}}
					/>
				)}
			</box>
		);
	}

	// ── edit 态渲染 ──
	const editorEl = (
		<TextareaEditor
			ref={editorRef}
			title="当前规则"
			initialContent={editInitial}
			active={editorActive}
			filetype="markdown"
			syntaxStyle={syntaxStyle}
			tabMode={tabMode}
			textareaFocused={textareaFocused}
			escapeMode="bubble"
			previewEnabled={false}
			viewportHeight={editorViewportHeight}
			onContentChange={handleContentChange}
			onCycleFocus={() => cycleFocus()}
			onSave={handleSave}
			onCancel={handleEditorCancel}
		/>
	);

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title={isCodex ? 'Codex 全局规则管理' : '全局规则管理'} subtitle={isCodex ? '查看、导入与编辑 CODEX_HOME/AGENTS.md' : '查看、导入、复制与编辑全局 CLAUDE.md'} />
			{panel === 'split' && recommendationAvailable ? (
				<box flexDirection="row" flexGrow={1} height={bodyViewportHeight}>
					<box flexDirection="column" width="50%" height={editorViewportHeight}>
						<box marginBottom={1}>
							<text fg={colors.primary} attributes={TextAttributes.BOLD}>推荐规则</text>
						</box>
						<box
							flexGrow={1}
							borderStyle="rounded"
							borderColor={focus === 'recommend' ? borderColors.active : borderColors.inactive}
							paddingX={1}
						>
							<ThemedScrollbox ref={recommendScrollRef} style={{flexGrow: 1}}>
								<CodePreview content={recommendationContent} filetype="markdown" />
							</ThemedScrollbox>
						</box>
					</box>
					<box flexDirection="column" width="50%" marginLeft={1}>
						{editorEl}
					</box>
				</box>
			) : (
				editorEl
			)}
		</box>
	);
}
