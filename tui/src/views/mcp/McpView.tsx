import React, {useEffect, useMemo, useState} from 'react';
import {useKeyboard} from '@opentui/react';
import {
	Modal,
	ScrollList,
	StatusDot,
	ViewHeader,
	ListEmptyState,
	toast,
	type ScrollListItem,
	type StatusDotKind
} from '../../components/index.js';
import {colors} from '../../theme/index.js';
import {AGENT_CONTEXT_LABELS, type AgentContext} from '../../state/manage-state.js';
import {clampMove} from '../../core/list-utils.js';
import {
	disableMcpServer,
	enableMcpServer,
	loadMcpDetail,
	loadMcpStatus,
	removeMcpServer
} from '../../services/mcp-service.js';
import type {McpServerStatus, McpStatusRow} from '../../core/mcp.js';
import {configToJson} from '../../core/mcp-form.js';
import {McpFormView} from './McpFormView.js';

// MCP TUI 视图（OpenTUI 适配）：
// - 列表屏：仅展示已安装（过滤 Missing），行只留状态圆点 + Id
// - Enter 切换状态（Active/Custom↔Disabled），A 新增，E 编辑，D 删除（无独立详情屏）
// - 表单屏：复用 McpFormView（模板 + Server ID + JSON 编辑）
// - 操作结果统一走 banner，不离开列表（除表单屏）

export type McpViewProps = {
	// 当前 Agent 上下文；Phase 7 会据此切换 MCP 文件事实源。
	readonly agentContext?: AgentContext;
	// 本视图是否获得右侧内容区焦点（focus === 'view'）。
	readonly active: boolean;
	// content 区可视行数（焦点驱动滚动）。
	readonly viewportHeight?: number;
	readonly viewportWidth?: number;
	// 上报当前子模式给 App footer。
	readonly onSubModeChange?: (subMode: string) => void;
	// 在列表屏按 Esc/← 时请求退回左侧导航。
	readonly onExitToNav: () => void;
	// 在列表顶部按 ↑ 时请求进入 Agent Header。
	readonly onExitToHeader?: () => void;
};

type McpScreen =
	| {readonly kind: 'list'}
	| {readonly kind: 'add'}
	| {readonly kind: 'edit'; readonly serverId: string; readonly initialJson: string}
	| {readonly kind: 'confirm-remove'; readonly serverId: string};

function statusKind(status: McpServerStatus): StatusDotKind {
	switch (status) {
		case 'Active':
		case 'Custom':
			return 'latest';
		case 'Disabled':
			return 'notInstalled';
		default:
			return 'unknown';
	}
}

export default function McpView({agentContext = 'cc', active, viewportHeight = 16, viewportWidth = 52, onSubModeChange, onExitToNav, onExitToHeader}: McpViewProps) {
	const [rows, setRows] = useState<McpStatusRow[]>(() => loadMcpStatus(agentContext));
	const [selected, setSelected] = useState(0);
	const [screen, setScreen] = useState<McpScreen>({kind: 'list'});

	// 仅展示已安装过的（过滤 Missing：契约里有但用户从未配置的）。
	const visibleRows = useMemo(() => rows.filter((row) => row.Status !== 'Missing'), [rows]);
	const safeSelected = visibleRows.length === 0 ? 0 : Math.min(selected, visibleRows.length - 1);
	const current = visibleRows[safeSelected] ?? null;

	// 进入视图时刷新状态表并复位到列表。
	useEffect(() => {
		if (active) {
			setRows(loadMcpStatus(agentContext));
			setSelected(0);
			setScreen({kind: 'list'});
		}
	}, [active, agentContext]);

	// 上报当前子模式给 App footer：表单屏统一 'form'，空列表 'empty'，否则用 screen.kind。
	useEffect(() => {
		if (!active) {
			return;
		}

		const subMode =
			screen.kind === 'add' || screen.kind === 'edit'
				? 'form'
				: screen.kind === 'list' && visibleRows.length === 0
					? 'empty'
					: screen.kind;
		onSubModeChange?.(subMode);
	}, [active, screen.kind, visibleRows.length, onSubModeChange]);

	function refresh(): void {
		const next = loadMcpStatus(agentContext);
		const visibleCount = next.filter((row) => row.Status !== 'Missing').length;
		setRows(next);
		setSelected((prev) => Math.min(prev, Math.max(0, visibleCount - 1)));
	}

	function toggleCurrent(): void {
		if (!current) {
			return;
		}

		const willDisable = current.Status !== 'Disabled';
		const result = willDisable ? disableMcpServer(current.Id, agentContext) : enableMcpServer(current.Id, agentContext);
		refresh();
		if (result.ok) {
			toast.success(`已${willDisable ? '禁用' : '启用'} ${current.Id}`);
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
				agentContext={agentContext}
				active={active}
				contentHeight={viewportHeight - 2}
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
				agentContext={agentContext}
				active={active}
				contentHeight={viewportHeight - 2}
				onCancel={() => setScreen({kind: 'list'})}
				onSaved={(message) => {
					refresh();
					toast.success(message);
					setScreen({kind: 'list'});
				}}
			/>
		);
	}

	// 列表屏
	const items: ScrollListItem[] = visibleRows.map((row) => ({
		key: row.Id,
		title: row.Id,
		leading: <StatusDot kind={statusKind(row.Status)} />
	}));

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="MCP Server 管理" subtitle={`维护 ${AGENT_CONTEXT_LABELS[agentContext]} 可用的 MCP Server 连接`} />

			{visibleRows.length === 0 ? (
				<ListEmptyState message="暂无 MCP Server" />
			) : (
				<ScrollList items={items} cursor={safeSelected} viewportHeight={viewportHeight} reservedRows={3} stretch />
			)}

			{screen.kind === 'confirm-remove' && current ? (
				<Modal
					active
					title="确认删除 MCP Server"
					hint="Enter 确认  Esc 取消"
					tone="danger"
					viewportWidth={viewportWidth}
					viewportHeight={viewportHeight}
				>
					<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`即将删除 MCP Server ${current.Id}，此操作不可撤销。`}</text>
				</Modal>
			) : null}

			<ListInput
				active={active && screen.kind === 'list'}
				hasCurrent={current !== null}
				atTop={safeSelected === 0}
				onMove={(delta) => setSelected((prev) => clampMove(prev, delta, visibleRows.length))}
				onToggle={toggleCurrent}
				onAdd={() => {
					setScreen({kind: 'add'});
				}}
				onEdit={() => {
					if (!current) {
						return;
					}

					const detail = loadMcpDetail(current.Id, agentContext);
					setScreen({kind: 'edit', serverId: current.Id, initialJson: configToJson(detail.config)});
				}}
				onDelete={() => {
					if (current) {
						setScreen({kind: 'confirm-remove', serverId: current.Id});
					}
				}}
				onExit={onExitToNav}
				onExitToHeader={onExitToHeader}
			/>

			<ConfirmInput
				active={active && screen.kind === 'confirm-remove'}
				onCancel={() => setScreen({kind: 'list'})}
				onConfirm={() => {
					if (!current) {
						setScreen({kind: 'list'});
						return;
					}

					const result = removeMcpServer(current.Id, true, agentContext);
					refresh();
					if (result.ok) {
						toast.success(`已删除 MCP Server ${current.Id}`);
					} else {
						toast.error(result.error);
					}
					setScreen({kind: 'list'});
				}}
			/>
		</box>
	);
}

// ── 键盘输入订阅（OpenTUI useKeyboard） ────────────────────────────────────

function ListInput({
	active,
	hasCurrent,
	atTop,
	onMove,
	onToggle,
	onAdd,
	onEdit,
	onDelete,
	onExit,
	onExitToHeader
}: {
	readonly active: boolean;
	readonly hasCurrent: boolean;
	readonly atTop: boolean;
	readonly onMove: (delta: number) => void;
	readonly onToggle: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
	readonly onExitToHeader?: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		switch (keyEvent.name.toLowerCase()) {
			case 'up':
			case 'arrowup':
				if (atTop && onExitToHeader) {
					onExitToHeader();
				} else {
					onMove(-1);
				}
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
