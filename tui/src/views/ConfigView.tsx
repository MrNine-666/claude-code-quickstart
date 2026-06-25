import React, { useEffect, useMemo, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { colors, borderColors } from '../theme/index.js';
import { ConfirmModal, ErrorPanel, ProgressLog, StatusLabel, TextareaEditor } from '../components/index.js';
import { truncateToWidth } from '../core/text-utils.js';
import type { ProgressEvent } from '../core/exec.js';
import type { ConfigEntry, ConfigRecommendation } from '../core/config-recommend.js';
import {
	checkClipboardSupport,
	copyRecommendationToClipboard,
	getSettingsPath,
	importFillMissingWithProgress,
	loadRecommendationForPreview,
	readCurrentSettings,
	saveSettings
} from '../services/config-service.js';

// 配置文件菜单视图（Phase 4）：查看推荐 settings.json 配置（含介绍）/ fill-missing 补全 / 复制 / 内嵌编辑器。
// 导入为非破坏性 fill-missing（仅补缺失，不覆盖供应商/模型/用户已有配置），经 ConfirmModal 确认。
// Update 检测已收缩（HC-FU-08），导入不写指纹种子。剪贴板不可用时对应入口禁用并提示。
// OpenTUI 适配：useKeyboard 替代 useInput，<box>/<text> 小写元素，内嵌编辑器替代外部编辑器。

type ConfigScreen =
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

export type ConfigViewProps = {
	readonly active: boolean;
	readonly viewportHeight?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly syntaxStyle?: import('@opentui/core').SyntaxStyle | null;
};

export function ConfigView({ active, viewportHeight = 16, onSubModeChange, onExitToNav, syntaxStyle = null }: ConfigViewProps) {
	const recommendation = useMemo(() => loadRecommendationForPreview(), []);
	const clipboardSupported = useMemo(() => checkClipboardSupport(), []);
	const settingsPath = useMemo(() => getSettingsPath(), []);

	const [screen, setScreen] = useState<ConfigScreen>({ kind: 'list' });
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
		const result = await importFillMissingWithProgress(appendLog);
		setBanner(
			result.ok
				? {
						kind: 'success',
						message: result.changed === 0 ? '配置已是最新，无需补全' : `已补全 ${result.changed} 项缺失配置到 ${settingsPath}`
					}
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
		setBanner(result.ok ? { kind: 'success', message: '推荐配置已复制到剪贴板' } : { kind: 'error', message: result.error });
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
				const current = readCurrentSettings();
				const json = current ? JSON.stringify(current, null, 2) : '{}';
				setScreen({ kind: 'editor', content: json });
			}
		}
	});

	if (screen.kind === 'editor') {
		return (
			<TextareaEditor
				title={`编辑 ${settingsPath}`}
				initialContent={screen.content}
				active={active}
				isJson
				filetype="json"
				syntaxStyle={syntaxStyle}
				onModeChange={(m) => onSubModeChange?.(m === 'preview' ? 'preview' : 'editor')}
				onSave={(content) => {
					const result = saveSettings(content);
					if (result.ok) {
						setBanner({ kind: 'success', message: `已保存到 ${settingsPath}` });
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
			<box flexDirection="column">
				<text attributes={TextAttributes.BOLD}>配置文件管理</text>
				<box marginTop={1}>
					<ProgressLog title="执行进度" messages={logs} />
				</box>
			</box>
		);
	}

	return (
		<box flexDirection="column">
			<box marginBottom={1}>
				<text attributes={TextAttributes.BOLD}>配置文件管理</text>
				<text attributes={TextAttributes.DIM}>  {settingsPath}</text>
			</box>

			{recommendation.available ? (
				<RecommendationPreview recommendation={recommendation} viewportHeight={viewportHeight} />
			) : (
				<box marginBottom={1}>
					<ErrorPanel message="推荐配置契约不可用（contracts/claude-config.json 缺失）" />
				</box>
			)}

			<box flexDirection="column" marginTop={1}>
				<ActionHint hotkey="I" label="按缺失项补全配置（不覆盖已有 ~/.claude/settings.json）" enabled={recommendation.available} />
				<ActionHint
					hotkey="C"
					label="复制推荐配置 JSON 到剪贴板"
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
						title="确认补全配置"
						message={`将按缺失项补全 ${settingsPath}（仅添加缺失的语言/环境变量/权限，不覆盖 model、供应商与 statusLine 等已有配置）。`}
						confirmLabel="Enter 确认补全"
						cancelLabel="Esc 取消"
					/>
				</box>
			) : null}
		</box>
	);
}

// ── 推荐配置预览（顶层 / env / permissions 三段，附 description） ───────────────

function RecommendationPreview({
	recommendation,
	viewportHeight
}: {
	readonly recommendation: ConfigRecommendation;
	readonly viewportHeight: number;
}) {
	const { topLevel, env, permissions } = recommendation;
	const budget = Math.max(6, Math.min(PREVIEW_LINES + 6, viewportHeight - 6));
	const rows = buildPreviewRows(topLevel, env, permissions);
	const visible = rows.slice(0, budget);
	const hidden = rows.length - visible.length;

	return (
		<box flexDirection="column" borderStyle="rounded" borderColor={borderColors.inactive} paddingX={1}>
			<text attributes={TextAttributes.DIM}>
				推荐配置预览（顶层 {topLevel.length} / 环境变量 {env.length} / 权限 {permissions.items.length} 项）
			</text>
			{visible.map((row, index) =>
				row.kind === 'header' ? (
					<text key={index} fg={colors.primary}>
						{truncateToWidth(row.text, PREVIEW_WIDTH)}
					</text>
				) : (
					<text key={index} attributes={(row.kind === 'note') ? TextAttributes.DIM : 0}>
						{truncateToWidth(row.text, PREVIEW_WIDTH)}
					</text>
				)
			)}
			{hidden > 0 ? <text attributes={TextAttributes.DIM}>… 余 {hidden} 行（导入后可在编辑器查看完整配置）</text> : null}
		</box>
	);
}

type PreviewRow = { readonly kind: 'header' | 'entry' | 'note'; readonly text: string };

function buildPreviewRows(
	topLevel: readonly ConfigEntry[],
	env: readonly ConfigEntry[],
	permissions: ConfigRecommendation['permissions']
): PreviewRow[] {
	const rows: PreviewRow[] = [];

	const pushEntries = (title: string, entries: readonly ConfigEntry[]): void => {
		if (entries.length === 0) {
			return;
		}

		rows.push({ kind: 'header', text: `─ ${title} ─` });
		for (const entry of entries) {
			const desc = entry.description ? `  ${entry.description}` : '';
			rows.push({ kind: 'entry', text: `${entry.key} = ${entry.value}${desc}` });
		}
	};

	pushEntries('顶层默认值', topLevel);
	pushEntries('环境变量', env);

	if (permissions.items.length > 0) {
		rows.push({ kind: 'header', text: `─ 权限白名单（${permissions.items.length} 项）─` });
		if (permissions.description) {
			rows.push({ kind: 'note', text: permissions.description });
		}

		rows.push({ kind: 'entry', text: permissions.items.join(', ') });
	}

	return rows;
}

function ActionHint({
	hotkey,
	label,
	enabled,
	disabledHint = ''
}: {
	readonly hotkey: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly disabledHint?: string;
}) {
	return (
		<box>
			<text fg={enabled ? colors.primary : undefined} attributes={(enabled ? TextAttributes.BOLD : 0) | (!enabled ? TextAttributes.DIM : 0)}>
				[{hotkey}]
			</text>
			<text attributes={(!enabled) ? TextAttributes.DIM : 0}> {label}</text>
			{!enabled && disabledHint ? <text attributes={TextAttributes.DIM}> {disabledHint}</text> : null}
		</box>
	);
}
