import React, { useEffect, useMemo, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { borderColors } from '../theme/index.js';
import { ConfirmModal, ErrorPanel, ProgressLog, StatusLabel, TextareaEditor, ActionHint, ViewHeader } from '../components/index.js';
import { truncateToWidth } from '../core/text-utils.js';
import type { ProgressEvent } from '../core/exec.js';
import {
	checkClipboardSupport,
	copyRecommendationToClipboard,
	getClaudeMdPath,
	importRecommendationWithProgress,
	loadRecommendationForPreview,
	readCurrentClaudeMd,
	saveClaudeMd
} from '../services/prompts-service.js';

// 全局规则菜单视图（Phase 4）：查看推荐 CLAUDE.md / 一键导入（整文件覆盖）/ 复制 / 内嵌编辑器。
// 导入是破坏性动作（整文件覆盖），经 ConfirmModal 二次确认。Update 检测已收缩（HC-FU-08），
// 导入不写指纹种子。剪贴板不可用时（缺命令 / 非 TTY）对应入口禁用并提示。
// OpenTUI 适配：useKeyboard 替代 useInput，<box>/<text> 小写元素，内嵌 textarea 替代外部编辑器。

type PromptsScreen =
	| { readonly kind: 'list' }
	| { readonly kind: 'confirm-import' }
	| { readonly kind: 'busy' }
	| { readonly kind: 'editor'; readonly content: string };

type Banner =
	| { readonly kind: 'none' }
	| { readonly kind: 'success'; readonly message: string }
	| { readonly kind: 'error'; readonly message: string };

const PREVIEW_LINES = 8;
const PREVIEW_WIDTH = 64;

export type PromptsViewProps = {
	readonly active: boolean;
	readonly viewportHeight?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly syntaxStyle?: import('@opentui/core').SyntaxStyle | null;
};

export function PromptsView({ active, viewportHeight = 16, onSubModeChange, onExitToNav, syntaxStyle = null }: PromptsViewProps) {
	const recommendation = useMemo(() => loadRecommendationForPreview(), []);
	const clipboardSupported = useMemo(() => checkClipboardSupport(), []);
	const claudeMdPath = useMemo(() => getClaudeMdPath(), []);

	const [screen, setScreen] = useState<PromptsScreen>({ kind: 'list' });
	const [banner, setBanner] = useState<Banner>({ kind: 'none' });
	const [logs, setLogs] = useState<readonly string[]>([]);

	useEffect(() => {
		if (!active) {
			return;
		}

		onSubModeChange?.(screen.kind);
	}, [active, screen.kind, onSubModeChange]);

	const appendLog = (event: ProgressEvent): void => {
		setLogs((prev) => [...prev, event.message].slice(-PREVIEW_LINES));
	};

	const runImport = async (): Promise<void> => {
		setLogs([]);
		setScreen({ kind: 'busy' });
		const result = await importRecommendationWithProgress(appendLog);
		setBanner(
			result.ok
				? { kind: 'success', message: `已导入推荐全局规则（${result.lineCount} 行）到 ${claudeMdPath}` }
				: { kind: 'error', message: result.error }
		);
		setScreen({ kind: 'list' });
	};

	const runCopy = async (): Promise<void> => {
		if (!clipboardSupported) {
			setBanner({ kind: 'error', message: '当前平台不支持剪贴板写入' });
			return;
		}

		setLogs([]);
		setScreen({ kind: 'busy' });
		const result = await copyRecommendationToClipboard(appendLog);
		setBanner(result.ok ? { kind: 'success', message: '推荐全局规则已复制到剪贴板' } : { kind: 'error', message: result.error });
		setScreen({ kind: 'list' });
	};

	// 键盘输入处理（OpenTUI useKeyboard 回调参数是 KeyEvent 对象，键名取 .name）
	useKeyboard((keyEvent) => {
		if (!active) return;

		const key = keyEvent.name;

		if (screen.kind === 'confirm-import') {
			if (key === 'escape') {
				setScreen({ kind: 'list' });
				return;
			}
			if (key === 'enter' || key === 'return') {
				void runImport();
				return;
			}
			return;
		}

		if (screen.kind === 'list') {
			if (key === 'escape' || key === 'left' || key === 'arrowleft') {
				onExitToNav();
				return;
			}

			const ch = key.toLowerCase();
			if (ch === 'i' && recommendation.available) {
				setBanner({ kind: 'none' });
				setScreen({ kind: 'confirm-import' });
			} else if (ch === 'c' && recommendation.available && clipboardSupported) {
				setBanner({ kind: 'none' });
				void runCopy();
			} else if (ch === 'e') {
				setBanner({ kind: 'none' });
				setScreen({ kind: 'editor', content: readCurrentClaudeMd() ?? '' });
			}
		}
	});

	if (screen.kind === 'editor') {
		return (
			<TextareaEditor
				title={`编辑 ${claudeMdPath}`}
				initialContent={screen.content}
				active={active}
				filetype="markdown"
				syntaxStyle={syntaxStyle}
				onModeChange={(m) => onSubModeChange?.(m === 'preview' ? 'preview' : 'editor')}
				onSave={(content) => {
					const result = saveClaudeMd(content);
					if (result.ok) {
						setBanner({ kind: 'success', message: `已保存到 ${claudeMdPath}` });
						setScreen({ kind: 'list' });
					}
					return result;
				}}
				onCancel={() => setScreen({ kind: 'list' })}
			/>
		);
	}

	if (screen.kind === 'busy') {
		return (
			<box flexDirection="column" flexGrow={1}>
				<ViewHeader title="全局规则管理" />
				<box marginTop={1}>
					<ProgressLog title="执行进度" messages={logs} />
				</box>
			</box>
		);
	}

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="全局规则管理" subtitle={claudeMdPath} />

			{recommendation.available ? (
				<RecommendationPreview content={recommendation.content} lineCount={recommendation.lineCount} viewportHeight={viewportHeight} />
			) : (
				<box marginBottom={1}>
					<ErrorPanel message="推荐全局规则模板不可用（contracts/templates 缺失）" />
				</box>
			)}

			<box flexDirection="column" marginTop={1}>
				<ActionHint label="一键导入（整文件覆盖 ~/.claude/CLAUDE.md）" enabled={recommendation.available} />
				<ActionHint
					label="复制推荐全局规则到剪贴板"
					enabled={recommendation.available && clipboardSupported}
					disabledHint={clipboardSupported ? '' : '（剪贴板不可用）'}
				/>
			</box>

			{banner.kind === 'success' ? (
				<box marginTop={1}>
					<StatusLabel kind="pass" label={banner.message} />
				</box>
			) : null}
			{banner.kind === 'error' ? (
				<box marginTop={1}>
					<ErrorPanel message={banner.message} />
				</box>
			) : null}

			{screen.kind === 'confirm-import' ? (
				<box marginTop={1}>
					<ConfirmModal
						title="确认导入推荐全局规则"
						message={`将整文件覆盖 ${claudeMdPath}，当前内容会被替换，此操作不可撤销。`}
						confirmLabel="Enter 确认导入"
						cancelLabel="Esc 取消"
					/>
				</box>
			) : null}
		</box>
	);
}

// ── 推荐预览（前 N 行，截断防溢出） ──────────────────────────────────────────

function RecommendationPreview({
	content,
	lineCount,
	viewportHeight
}: {
	readonly content: string;
	readonly lineCount: number;
	readonly viewportHeight: number;
}) {
	const maxLines = Math.max(3, Math.min(PREVIEW_LINES, viewportHeight - 6));
	const lines = content.split('\n').slice(0, maxLines);

	return (
		<box flexDirection="column" borderStyle="rounded" borderColor={borderColors.inactive} paddingX={1}>
			<text attributes={TextAttributes.DIM}>推荐全局规则预览（共 {lineCount} 行）</text>
			{lines.map((line, index) => (
				<text key={index}>{truncateToWidth(line || ' ', PREVIEW_WIDTH)}</text>
			))}
			{lineCount > maxLines ? <text attributes={TextAttributes.DIM}>… 余 {lineCount - maxLines} 行（导入后可在编辑器查看完整内容）</text> : null}
		</box>
	);
}

