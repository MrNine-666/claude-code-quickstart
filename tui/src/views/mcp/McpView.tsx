import React, {useEffect, useMemo, useState} from 'react';
import {TextAttributes} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {
	Modal,
	ScrollList,
	ViewHeader,
	ListEmptyState,
	toast,
	type ScrollListItem
} from '../../components/index.js';
import {colors} from '../../theme/index.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {clampMove} from '../../core/list-utils.js';
import {
	applyMcpToggleTargets,
	loadMcpDetail,
	loadSharedMcpStatus,
	removeSharedMcpServer
} from '../../services/mcp-service.js';
import type {McpAgentInjectState, McpSharedRow} from '../../core/mcp.js';
import {configToJson} from '../../core/mcp-form.js';
import {McpFormView} from './McpFormView.js';

// MCP TUI 视图（shared-resource-injection-ui Section 10-11）：
// - 共享双侧列表：一行一 Server ID，行内双态徽章（Claude Code ●|○ + Codex ●|○），不按 Header 过滤
// - Enter 打开开关目标 Modal（复用 ToolsView InjectTargetModal 范式）：↑/↓ 选侧、空格切草稿、Enter 应用差异、Esc 取消
// - a 新增（仅写 vault 共享定义，不开启任何侧）；e 编辑（写 vault + 同步已开启侧）；d 全量删除（两侧 + vault 定义）
// - 面向用户文案统一「开启 / 禁用」，不出现「注入」；开关态每次实时读 runtime 文件派生

// 开关目标 Modal 宽度：对齐 ToolsView INJECT_MODAL_WIDTH，容纳 hint 单行不换行。
const TOGGLE_MODAL_WIDTH = 56;

export type McpViewProps = {
	readonly active: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
};

type McpScreen =
	| {readonly kind: 'list'}
	| {readonly kind: 'add'}
	| {readonly kind: 'edit'; readonly serverId: string; readonly initialJson: string}
	| {readonly kind: 'select-toggle-target'; readonly serverId: string}
	| {readonly kind: 'confirm-remove'; readonly serverId: string};

export default function McpView({active, onSubModeChange, onExitToNav}: McpViewProps) {
	const [rows, setRows] = useState<readonly McpSharedRow[]>(() => loadSharedMcpStatus());
	const [selected, setSelected] = useState(0);
	const [screen, setScreen] = useState<McpScreen>({kind: 'list'});
	// 开关 Modal 草稿：进入时以各侧实时开关态预置；空格切换、Enter 应用前不落盘。
	const [toggleDraft, setToggleDraft] = useState<Record<AgentContext, boolean>>({cc: false, cx: false});
	const [toggleIndex, setToggleIndex] = useState(0);

	const safeSelected = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);
	const current = rows[safeSelected] ?? null;

	// 上报当前子模式给 App footer。
	useEffect(() => {
		if (!active) {
			return;
		}

		const subMode =
			screen.kind === 'add' || screen.kind === 'edit'
				? 'form'
				: screen.kind === 'list' && rows.length === 0
					? 'empty'
					: screen.kind;
		onSubModeChange?.(subMode);
	}, [active, screen.kind, rows.length, onSubModeChange]);

	function refresh(): void {
		const next = loadSharedMcpStatus();
		setRows(next);
		setSelected((prev) => Math.min(prev, Math.max(0, next.length - 1)));
	}

	function openToggleModal(): void {
		if (!current) {
			return;
		}

		// 草稿预置各侧当前实时开关态（active=开启）。
		setToggleDraft({cc: current.injectByAgent.cc.active, cx: current.injectByAgent.cx.active});
		setToggleIndex(0);
		setScreen({kind: 'select-toggle-target', serverId: current.Id});
	}

	function applyToggle(): void {
		if (screen.kind !== 'select-toggle-target') {
			return;
		}

		const serverId = screen.serverId;
		const result = applyMcpToggleTargets(serverId, toggleDraft);
		refresh();
		setScreen({kind: 'list'});
		if (result.ok) {
			toast.success(`已更新 ${serverId} 开关`);
		} else {
			toast.error(result.error);
		}
	}

	// 表单屏（add/edit 统一走 McpFormView）。
	if (screen.kind === 'add') {
		return (
			<McpFormView
				mode="add"
				serverId=""
				initialJson={configToJson(null)}
				active={active}
				onCancel={() => setScreen({kind: 'list'})}
				onSaved={(message) => {
					refresh();
					toast.success(message);
					setScreen({kind: 'list'});
				}}
			/>
		);
	}

	if (screen.kind === 'edit') {
		return (
			<McpFormView
				mode="edit"
				serverId={screen.serverId}
				initialJson={screen.initialJson}
				active={active}
				onCancel={() => setScreen({kind: 'list'})}
				onSaved={(message) => {
					refresh();
					toast.success(message);
					setScreen({kind: 'list'});
				}}
			/>
		);
	}

	// 列表屏：一行一 Server ID，行内双态徽章。
	const items: ScrollListItem[] = rows.map((row) => ({
		key: row.Id,
		title: row.Id,
		body: <DualStateBadges cc={row.injectByAgent.cc} cx={row.injectByAgent.cx} />,
		multiLine: true
	}));

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="MCP Server 管理" subtitle="共享维护 Claude Code 与 Codex 两侧的 MCP Server 连接" />

			{rows.length === 0 ? (
				<ListEmptyState message="暂无 MCP Server" />
			) : (
				<ScrollList items={items} cursor={safeSelected} active={active && screen.kind === 'list'} />
			)}

			{screen.kind === 'select-toggle-target' && current ? (
				<ToggleTargetModal
					name={current.Id}
					draft={toggleDraft}
					focusedIndex={toggleIndex}
				/>
			) : null}

			{screen.kind === 'confirm-remove' && current ? (
				<Modal
					active
					title="全量删除 MCP Server"
					hint="Enter 确认  Esc 取消"
					tone="danger"
					width={TOGGLE_MODAL_WIDTH}
				>
					<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`即将删除 ${current.Id}：移除 Claude Code 与 Codex 两侧配置及共享定义，此操作不可撤销。`}</text>
				</Modal>
			) : null}

			{screen.kind === 'list' ? (
				<ListInput
					active={active}
					hasCurrent={current !== null}
					onMove={(delta) => setSelected((prev) => clampMove(prev, delta, rows.length))}
					onToggle={openToggleModal}
					onAdd={() => setScreen({kind: 'add'})}
					onEdit={() => {
						if (!current) {
							return;
						}

						// 编辑回显：统一 c JSON 方言（优先 .claude.json，回落 vault 共享定义体，均为 c 方言）。
						const detail = loadMcpDetail(current.Id);
						setScreen({kind: 'edit', serverId: current.Id, initialJson: configToJson(detail.config)});
					}}
					onDelete={() => {
						if (current) {
							setScreen({kind: 'confirm-remove', serverId: current.Id});
						}
					}}
					onExit={onExitToNav}
				/>
			) : null}

			{screen.kind === 'select-toggle-target' ? (
				<ToggleModalInput
					active={active}
					onNav={(delta) => setToggleIndex((prev) => (prev + delta + AGENT_CONTEXT_ORDER.length) % AGENT_CONTEXT_ORDER.length)}
					onToggle={() => {
						const ctx = AGENT_CONTEXT_ORDER[toggleIndex] ?? 'cc';
						setToggleDraft((prev) => ({...prev, [ctx]: !prev[ctx]}));
					}}
					onApply={applyToggle}
					onCancel={() => setScreen({kind: 'list'})}
				/>
			) : null}

			{screen.kind === 'confirm-remove' ? (
				<ConfirmInput
					active={active}
					onCancel={() => setScreen({kind: 'list'})}
					onConfirm={() => {
						if (!current) {
							setScreen({kind: 'list'});
							return;
						}

						const serverId = current.Id;
						const result = removeSharedMcpServer(serverId, true);
						refresh();
						setScreen({kind: 'list'});
						if (result.ok) {
							toast.success(`已删除 MCP Server ${serverId}`);
						} else {
							toast.error(result.error);
						}
					}}
				/>
			) : null}
		</box>
	);
}

// ── 行内双态徽章：开启=success ●，禁用/未开启=muted ○（全称标签，禁 cc/cx 缩写） ──
function DualStateBadges({cc, cx}: {readonly cc: McpAgentInjectState; readonly cx: McpAgentInjectState}) {
	return (
		<box flexDirection="row" height={1} overflow="hidden">
			<StateBadge label={AGENT_CONTEXT_LABELS.cc} active={cc.active} />
			<text fg={colors.muted}>{'  '}</text>
			<StateBadge label={AGENT_CONTEXT_LABELS.cx} active={cx.active} />
		</box>
	);
}

function StateBadge({label, active}: {readonly label: string; readonly active: boolean}) {
	return (
		<text fg={active ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${active ? '●' : '○'} ${label}`}
		</text>
	);
}

// ── 开关目标 Modal：↑/↓ 选 Claude Code / Codex，空格切草稿开/关，Enter 应用差异，Esc 取消 ──
// 照搬 ToolsView InjectTargetModal 范式（M9）：左 › <Agent 全称> focused 高亮 flexGrow，右状态标签右对齐。
function ToggleTargetModal({
	name,
	draft,
	focusedIndex
}: {
	readonly name: string;
	readonly draft: Record<AgentContext, boolean>;
	readonly focusedIndex: number;
}) {
	const selected = AGENT_CONTEXT_ORDER[focusedIndex] ?? 'cc';
	return (
		<Modal
			active
			title={`管理开关：${name}`}
			hint="↑/↓ 选择  空格 切换开/关  Enter 应用  Esc 取消"
			width={TOGGLE_MODAL_WIDTH}
		>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map((ctx) => {
					const enabled = Boolean(draft[ctx]);
					const focused = ctx === selected;
					const stateLabel = enabled ? '● 已开启' : '○ 已禁用';
					return (
						<box key={ctx} flexDirection="row">
							<text fg={focused ? colors.primary : colors.muted} attributes={focused ? TextAttributes.BOLD : 0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} flexGrow={1}>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]} `}
							</text>
							<text fg={enabled ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} flexShrink={0}>
								{stateLabel}
							</text>
						</box>
					);
				})}
			</box>
		</Modal>
	);
}

// ── 键盘输入订阅（OpenTUI useKeyboard） ────────────────────────────────────

function ListInput({
	active,
	hasCurrent,
	onMove,
	onToggle,
	onAdd,
	onEdit,
	onDelete,
	onExit
}: {
	readonly active: boolean;
	readonly hasCurrent: boolean;
	readonly onMove: (delta: number) => void;
	readonly onToggle: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		switch (keyEvent.name.toLowerCase()) {
			case 'up':
			case 'arrowup':
				// MCP 隐藏 Header：列表 ↑/↓ 首尾循环，不退回 header。
				onMove(-1);
				break;
			case 'down':
			case 'arrowdown':
				onMove(1);
				break;
			case 'escape':
			case 'left':
			case 'arrowleft':
				onExit();
				break;
			case 'enter':
			case 'return':
				if (hasCurrent) {
					onToggle();
				}

				break;
			case 'a':
				onAdd();
				break;
			case 'e':
				if (hasCurrent) {
					onEdit();
				}

				break;
			case 'd':
				if (hasCurrent) {
					onDelete();
				}

				break;
		}
	});

	return null;
}

function ToggleModalInput({
	active,
	onNav,
	onToggle,
	onApply,
	onCancel
}: {
	readonly active: boolean;
	readonly onNav: (delta: number) => void;
	readonly onToggle: () => void;
	readonly onApply: () => void;
	readonly onCancel: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		const k = keyEvent.name.toLowerCase();
		if (k === 'up' || k === 'arrowup') {
			onNav(-1);
		} else if (k === 'down' || k === 'arrowdown') {
			onNav(1);
		} else if (k === 'space' || keyEvent.name === ' ') {
			onToggle();
		} else if (k === 'enter' || k === 'return') {
			onApply();
		} else if (k === 'escape') {
			onCancel();
		}
	});

	return null;
}

function ConfirmInput({
	active,
	onCancel,
	onConfirm
}: {
	readonly active: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		const k = keyEvent.name.toLowerCase();
		if (k === 'escape') {
			onCancel();
		} else if (k === 'enter' || k === 'return') {
			onConfirm();
		}
	});

	return null;
}
