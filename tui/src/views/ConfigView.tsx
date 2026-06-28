import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TextAttributes, type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { borderColors, colors, PRIMARY } from '../theme/index.js';
import {
	TextareaEditor,
	ViewHeader,
	toast,
	type TextEditorHandle
} from '../components/index.js';
import {
	fillMissingIntoText,
	getSettingsPath,
	loadRecommendationAnnotated,
	readCurrentSettingsTextStripped,
	saveSettingsMerged
} from '../services/config-service.js';

// 配置文件页（view-first，对齐 PromptsView）+ 字段级（settings.json 多页共享）：
// view 态只读渲染当前 settings.json（手动 JSON 着色：key/string/数字/布尔/标点分色；opentui 未内置 json grammar）。
// 字段所有权（HC-12）：供应商 env（token/base_url/model 等，DoNotManageEnvKeys）从展示中剥离，归供应商页管；
// 保存时自动从原文件恢复供应商 env，绝不丢失。标题标注「已排除供应商配置」。
// e（编辑现有；空时 a 新建 {}）进入编辑器；Ctrl+T 开推荐边栏（带注释 JSONC 只读对照，注释行分色）；
// Ctrl+O fill-missing 灌缓冲（仅补缺失，保留已有配置，可 Ctrl+Z 撤销）；Ctrl+S 保存后回只读展示；
// Esc 取消编辑直接回 view（放弃未保存改动，toast 提示）。
// HC-SHORTCUT-SINGLE-SOURCE：键位处理用 keyEvent.name，footer 文案由 shortcuts.ts 按 subMode 解析。

type Mode = 'view' | 'edit';
type Panel = 'editor' | 'split';
type Focus = 'editor' | 'recommend';

export type ConfigViewProps = {
	readonly active: boolean;
	readonly viewportHeight?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly syntaxStyle?: import('@opentui/core').SyntaxStyle | null;
};

export function ConfigView({ active, viewportHeight = 16, onSubModeChange, onExitToNav, syntaxStyle = null }: ConfigViewProps) {
	const recommendationContent = useMemo(() => loadRecommendationAnnotated() ?? '', []);
	const recommendationAvailable = recommendationContent !== '';
	const settingsPath = useMemo(() => getSettingsPath(), []);

	// view 态展示内容（已剥离供应商 env；保存 / 取消后重新读盘刷新，保证展示最新）
	const [viewContent, setViewContent] = useState<string>(() => readCurrentSettingsTextStripped());
	const hasContent = viewContent.trim().length > 0;

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
		if (!active) return;
		onSubModeChange?.(subMode);
	}, [active, subMode, onSubModeChange]);

	// split 态焦点在边栏时编辑区失活（边框变灰），与边栏 active 同步
	const editorActive = mode === 'edit' && active && (panel === 'editor' || focus === 'editor');
	const textareaFocused = mode === 'edit' && focus === 'editor';
	const tabMode = panel === 'split' ? 'cycle-focus' : 'indent';
	// 编辑态保留全局 ViewHeader：右侧内容区固定高，先扣除标题行，避免编辑器 flex 抢占导致标题被裁剪。
	const bodyViewportHeight = Math.max(1, viewportHeight - 2);
	const editorViewportHeight = bodyViewportHeight;

	// ── 操作 ──
	const refreshView = (): void => {
		setViewContent(readCurrentSettingsTextStripped());
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

	// fill-missing 灌缓冲：对当前编辑缓冲执行合并（仅补缺失，保留用户已有配置），结果写回编辑器，可 Ctrl+Z 撤销。
	// 与全局规则页 replaceText(全文) 的差异：配置文件必须保留供应商/model/权限等已有项（HC-12 fill-missing-only）。
	const doImport = (): void => {
		if (!recommendationAvailable) {
			toast.error('推荐配置契约不可用');
			return;
		}
		const result = fillMissingIntoText(editorRef.current?.getText() ?? '');
		if (!result.ok) {
			toast.error(result.error);
			return;
		}
		editorRef.current?.replaceText(result.text);
		setDirty(true);
		toast.success(result.changed === 0
			? '配置已是最新，无需补全（Ctrl+Z 撤销 · Ctrl+S 保存）'
			: `已补全 ${result.changed} 项缺失配置到编辑器（Ctrl+Z 撤销 · Ctrl+S 保存）`);
	};

	const handleSave = (content: string): { ok: boolean; error?: string } => {
		const result = saveSettingsMerged(content);
		if (result.ok) {
			setDirty(false);
			refreshView();
			toast.success(`已保存到 ${settingsPath}（供应商配置已原样保留）`);
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
		const mod = keyEvent.ctrl || keyEvent.super === true;

		// ── view 态 ──
		if (mode === 'view') {
			if (name === 'escape') { onExitToNav(); return; }
			if (name === 'e' && hasContent) { enterEdit(readCurrentSettingsTextStripped() || '{}'); return; }
			if (name === 'a' && !hasContent) { enterEdit('{}'); return; }
			// ↑/↓ 滚动展示区（scrollbox 需主动驱动，否则默认不响应键盘）
			if (name === 'up') { viewScrollRef.current?.scrollBy(-1); return; }
			if (name === 'down') { viewScrollRef.current?.scrollBy(1); return; }
			return;
		}

		// ── edit 态 ──
		// Esc：取消编辑直接回 view
		if (name === 'escape') { cancelEdit(); return; }

		// 主操作：编辑器获焦时 Ctrl+S 由 TextareaEditor 自管；边栏获焦时由页面兜底保存。
		if (mod && name === 's' && panel === 'split' && focus === 'recommend') {
			handleSave(editorRef.current?.getText() ?? '');
			return;
		}
		if (mod && name === 't') { togglePanel(); return; }
		// Ctrl+I 在终端等同 Tab（ASCII 0x09），改用 Ctrl+O 触发 fill-missing 灌缓冲
		if (mod && name === 'o') { doImport(); return; }

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
					title="配置文件管理"
					subtitle="查看、补全与编辑 Claude Code settings.json"
					right={<text fg={colors.warning} attributes={TextAttributes.DIM}>已排除供应商配置</text>}
				/>
				{hasContent ? (
					<box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={borderColors.active} paddingX={1}>
						<scrollbox ref={viewScrollRef} style={{flexGrow: 1}} scrollY>
							<ColoredCodeLines content={viewContent} />
						</scrollbox>
					</box>
				) : (
					<box
						flexGrow={1}
						flexDirection="column"
						borderStyle="single"
						borderColor={borderColors.inactive}
						justifyContent="center"
						alignItems="center"
					>
						<text fg={colors.primary} attributes={TextAttributes.BOLD}>尚无配置文件</text>
						<box marginTop={1} flexDirection="row">
							<text fg={colors.muted}>按 </text>
							<text fg={PRIMARY} attributes={TextAttributes.BOLD}>a</text>
							<text fg={colors.muted}> 新建 ~/.claude/settings.json</text>
						</box>
						<box marginTop={1}>
							<text attributes={TextAttributes.DIM}>{settingsPath}</text>
						</box>
					</box>
				)}
			</box>
		);
	}

	// ── edit 态渲染 ──
	const editorEl = (
		<TextareaEditor
			ref={editorRef}
			title="当前配置（已排除供应商）"
			initialContent={editInitial}
			active={editorActive}
			isJson
			filetype="json"
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
			<ViewHeader
				title="配置文件管理"
				subtitle="查看、补全与编辑 Claude Code settings.json"
				right={<text fg={colors.warning} attributes={TextAttributes.DIM}>已排除供应商配置</text>}
			/>
			{panel === 'split' && recommendationAvailable ? (
				<box flexDirection="row" flexGrow={1} height={bodyViewportHeight}>
					<box flexDirection="column" width="50%" height={editorViewportHeight}>
						<box marginBottom={1}>
							<text fg={colors.primary} attributes={TextAttributes.BOLD}>推荐配置</text>
						</box>
						<box
							flexGrow={1}
							borderStyle="rounded"
							borderColor={focus === 'recommend' ? borderColors.active : borderColors.inactive}
							paddingX={1}
						>
							<scrollbox ref={recommendScrollRef} style={{flexGrow: 1}} scrollY>
								<ColoredCodeLines content={recommendationContent} jsonc />
							</scrollbox>
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

// ── JSON 手动着色（opentui 未内置 json grammar，回退：纯前端 token 分色）──

type JsonTokenType = 'key' | 'string' | 'number' | 'boolean' | 'punct' | 'space';
type JsonToken = {readonly type: JsonTokenType; readonly text: string};

/** 按行 tokenize JSON：key（后跟冒号的字符串）/ string / number / boolean·null / 标点 / 空白。 */
function tokenizeJsonLine(line: string): readonly JsonToken[] {
	const tokens: JsonToken[] = [];
	let i = 0;
	while (i < line.length) {
		const ch = line[i]!;
		if (/\s/.test(ch)) {
			let j = i + 1;
			while (j < line.length && /\s/.test(line[j]!)) j++;
			tokens.push({type: 'space', text: line.slice(i, j)});
			i = j;
		} else if (ch === '"') {
			let j = i + 1;
			while (j < line.length) {
				if (line[j] === '\\') { j += 2; continue; }
				if (line[j] === '"') { j++; break; }
				j++;
			}
			const text = line.slice(i, j);
			let k = j;
			while (k < line.length && /\s/.test(line[k]!)) k++;
			tokens.push({type: line[k] === ':' ? 'key' : 'string', text});
			i = j;
		} else if (ch === '{' || ch === '}' || ch === '[' || ch === ']' || ch === ':' || ch === ',') {
			tokens.push({type: 'punct', text: ch});
			i++;
		} else if (ch === '-' || (ch >= '0' && ch <= '9')) {
			let j = i + 1;
			while (j < line.length && /[-+.eE0-9]/.test(line[j]!)) j++;
			tokens.push({type: 'number', text: line.slice(i, j)});
			i = j;
		} else if (ch >= 'a' && ch <= 'z') {
			let j = i + 1;
			while (j < line.length && /[a-z]/.test(line[j]!)) j++;
			tokens.push({type: 'boolean', text: line.slice(i, j)});
			i = j;
		} else {
			tokens.push({type: 'string', text: ch});
			i++;
		}
	}
	return tokens;
}

/** token → 颜色（对齐 app.tsx GitHub Dark 主题）。 */
function jsonTokenColor(type: JsonTokenType): string {
	switch (type) {
		case 'key': return '#FFA657';       // 橙：键名突出
		case 'string': return '#A5D6FF';    // 浅蓝：字符串值
		case 'number': return '#79C0FF';    // 蓝：数字
		case 'boolean': return '#FF7B72';   // 红：true/false/null
		case 'punct': return colors.muted;  // 灰：标点柔和
		case 'space': return colors.info;   // 空白（占位，颜色无关）
	}
}

/**
 * 多行 JSON/JSONC 着色渲染（view 态纯 JSON + 边栏 JSONC 共用）。
 * 每行按 token 分色（key/string/number/boolean/punct）；jsonc=true 时 // 注释行用 muted+DIM 柔和区分。
 */
function ColoredCodeLines({ content, jsonc = false }: { readonly content: string; readonly jsonc?: boolean }) {
	return (
		<box flexDirection="column">
			{content.split('\n').map((line, i) => {
				const isComment = jsonc && line.trimStart().startsWith('//');
				if (isComment) {
					return (
						<text key={i} fg={colors.muted} attributes={TextAttributes.DIM}>
							{line.length > 0 ? line : ' '}
						</text>
					);
				}
				return (
					<box key={i} flexDirection="row">
						{line.length === 0
							? <text>{' '}</text>
							: tokenizeJsonLine(line).map((tok, j) => (
								<text key={j} fg={jsonTokenColor(tok.type)}>
									{tok.text.length > 0 ? tok.text : ' '}
								</text>
							))}
					</box>
				);
			})}
		</box>
	);
}
