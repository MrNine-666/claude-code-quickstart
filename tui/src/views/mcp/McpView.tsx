import React, { useEffect, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import {
	ConfirmModal,
	DetailPanel,
	DetailScreen,
	ErrorPanel,
	ScrollList,
	StatusDot,
	type StatusDotKind,
	type ScrollListItem
} from '../../components/index.js';
import { colors } from '../../theme/index.js';
import { truncateToWidth } from '../../core/text-utils.js';
import {
	disableMcpServer,
	enableMcpServer,
	loadMcpDetail,
	loadMcpStatus,
	removeMcpServer,
	buildMcpForm,
	type McpServiceResult
} from '../../services/mcp-service.js';
import type { McpServerDetail, McpStatusRow } from '../../core/mcp.js';
import type { McpFormModel } from '../../core/mcp-form.js';
import { McpFormView } from './McpFormView.js';
import { clampIndex } from './mcp-view-model.js';

// MCP TUI 视图（OpenTUI 适配 - Phase 4 基础实现）：
// - 列表屏：状态卡片（Active/Disabled/Missing/Custom + 圆点）
// - 详情屏：Server 详细信息 + 操作（T 启用/禁用、X 删除）
// - Phase 5 实现：表单屏（E 编辑，含字段↔JSON 双向联动）

export type McpViewProps = {
	// 本视图是否获得右侧内容区焦点（focus === 'view'）。
	readonly active: boolean;
	// content 区可视行数（焦点驱动滚动）。
	readonly viewportHeight?: number;
	// 上报当前子模式给 App footer。
	readonly onSubModeChange?: (subMode: string) => void;
	// 在列表屏按 Esc 时请求退回左侧导航。
	readonly onExitToNav: () => void;
};

function statusKind(status: McpStatusRow['Status']): StatusDotKind {
	switch (status) {
		case 'Active':
		case 'Custom':
			return 'latest';
		case 'Disabled':
		case 'Missing':
			return 'notInstalled';
		default:
			return 'unknown';
	}
}

// 详情屏右上角操作提示（与 shortcutsFor detail 一致，纯展示）。
function detailActionsHint(detail: McpServerDetail): string {
	const parts: string[] = [];
	if (!detail.isEnvFile && detail.definition) {
		parts.push('E 编辑');
	}

	if (detail.status === 'Active' || detail.status === 'Disabled') {
		parts.push(detail.status === 'Active' ? 'T 禁用' : 'T 启用');
	}

	if (detail.status !== 'Missing') {
		parts.push('X 删除');
	}

	parts.push('Esc 返回');
	return parts.join(' · ');
}

function detailItems(detail: McpServerDetail): { label: string; value: React.ReactNode }[] {
	const def = detail.definition;
	const config = detail.config as
		| { command?: string; args?: string[]; url?: string; env?: Record<string, string> }
		| null;
	const items: { label: string; value: React.ReactNode }[] = [
		{ label: 'ID', value: detail.id },
		{ label: '名称', value: def?.Name ?? detail.id },
		{ label: '描述', value: def?.Description ?? '-' },
		{ label: '类型', value: def?.McpType ?? (config?.url ? 'http' : 'stdio') },
		{ label: '状态', value: detail.status }
	];

	if (config?.command) {
		items.push({ label: 'command', value: config.command });
	}

	if (config?.args && config.args.length > 0) {
		items.push({ label: 'args', value: config.args.join(' ') });
	}

	if (config?.url) {
		items.push({ label: 'url', value: config.url });
	}

	if (config?.env && Object.keys(config.env).length > 0) {
		items.push({ label: 'env', value: Object.keys(config.env).join(', ') });
	}

	items.push({ label: 'permissions', value: detail.permissions.length > 0 ? detail.permissions.join(', ') : '无' });
	items.push({
		label: 'vault',
		value: detail.vaultEntry ? `已记录（disabled=${detail.vaultEntry.disabled ?? false}）` : '无'
	});

	if (detail.isEnvFile) {
		items.push({ label: '提示', value: '该 MCP 使用 env-file 凭据，由安装链管理，本面板只读' });
	}

	return items;
}

type ViewMessage = { readonly text: string; readonly isError: boolean };

export default function McpView({ active, viewportHeight = 16, onSubModeChange, onExitToNav }: McpViewProps) {
	const [mode, setMode] = useState<'list' | 'detail' | 'confirm-remove' | 'message' | 'form'>('list');
	const [rows, setRows] = useState<McpStatusRow[]>(() => loadMcpStatus());
	const [listIndex, setListIndex] = useState(0);
	const [detail, setDetail] = useState<McpServerDetail | null>(null);
	const [formModel, setFormModel] = useState<McpFormModel | null>(null);
	const [message, setMessage] = useState<ViewMessage | null>(null);

	// 进入视图时刷新状态表并复位到列表。
	useEffect(() => {
		if (active) {
			setRows(loadMcpStatus());
			setMode('list');
			setListIndex((current) => clampIndex(current, rows.length));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	// 上报当前子模式给 App footer。
	useEffect(() => {
		if (active) {
			onSubModeChange?.(mode);
		}
	}, [active, mode, onSubModeChange]);

	function refreshList(): void {
		const next = loadMcpStatus();
		setRows(next);
		setListIndex((current) => clampIndex(current, next.length));
	}

	function reportResult(result: McpServiceResult, successText: string): void {
		setMessage(result.ok ? { text: successText, isError: false } : { text: result.error, isError: true });
		setMode('message');
	}

	// Phase 5 TODO: 实现表单屏（含字段↔JSON 双向联动）
	// 表单屏（E 编辑，复用通用 FormPanel，本期基础字段编辑，字段↔JSON 联动分两步走）
	if (mode === 'form' && formModel) {
		return (
			<McpFormView
				model={formModel}
				active={active}
				onSaved={(msg) => {
					setMessage({ text: msg, isError: false });
					setMode('message');
				}}
				onError={(err) => {
					setMessage({ text: err, isError: true });
					setMode('message');
				}}
				onCancel={() => setMode('detail')}
			/>
		);
	}

	if (mode === 'message') {
		return (
			<box flexDirection="column">
				<text attributes={TextAttributes.BOLD}>操作结果</text>
				<box marginTop={1}>
					{message?.isError ? <ErrorPanel message={message.text} /> : <text fg={colors.primary}>{message?.text}</text>}
				</box>
				<box marginTop={1}>
					<text attributes={TextAttributes.DIM}>按任意键返回列表</text>
				</box>
				<MessageInput
					active={active}
					onDismiss={() => {
						refreshList();
						setMode('list');
					}}
				/>
			</box>
		);
	}

	if (mode === 'detail' && detail) {
		return (
			<DetailScreen title={detail.id} actionsHint={detailActionsHint(detail)}>
				<DetailPanel items={detailItems(detail)} />
				<DetailInput
					active={active}
					detail={detail}
					onBack={() => {
						refreshList();
						setMode('list');
					}}
					onEdit={() => {
						if (!detail.definition) {
							reportResult({ ok: false, error: '该 MCP 无契约定义，暂不支持编辑' }, '');
							return;
						}

						const config = detail.config as Parameters<typeof buildMcpForm>[2];
						const model = buildMcpForm(detail.id, detail.definition, config, 'edit-builtin');
						if (!model.editable) {
							reportResult({ ok: false, error: model.note ?? '该 MCP 不支持编辑保存' }, '');
							return;
						}

						setFormModel(model);
						setMode('form');
					}}
					onToggle={() => {
						const result = detail.status === 'Active' ? disableMcpServer(detail.id) : enableMcpServer(detail.id);
						reportResult(result, detail.status === 'Active' ? `已禁用 ${detail.id}` : `已启用 ${detail.id}`);
					}}
					onRemove={() => {
						setMode('confirm-remove');
					}}
				/>
			</DetailScreen>
		);
	}

	// 列表屏
	const items: ScrollListItem[] = rows.map((row) => ({
		key: row.Id,
		title: row.Id,
		leading: <StatusDot kind={statusKind(row.Status)} />,
		body: (
			<text attributes={TextAttributes.DIM}>
				{truncateToWidth(
					`${row.Name} · ${row.Status}${row.McpType ? ` · ${row.McpType}` : ''}`,
					64
				)}
			</text>
		)
	}));

	return (
		<box flexDirection="column">
			<box marginBottom={1}>
				<text attributes={TextAttributes.BOLD}>MCP Server 管理</text>
				<text attributes={TextAttributes.DIM}>  共 {rows.length} 个</text>
			</box>

			{rows.length === 0 ? (
				<text attributes={TextAttributes.DIM}>暂无 MCP Server 配置。</text>
			) : (
				<ScrollList items={items} cursor={listIndex} viewportHeight={viewportHeight} reservedRows={2} />
			)}

			{mode === 'confirm-remove' && detail ? (
				<box marginTop={1}>
					<ConfirmModal
						title="确认删除 MCP Server"
						message={`即将删除 MCP Server ${detail.id}，此操作不可撤销。`}
						confirmLabel="Enter 确认删除"
						cancelLabel="Esc 取消"
					/>
				</box>
			) : null}

			<ListInput
				active={active && mode === 'list'}
				hasRows={rows.length > 0}
				onMove={(delta) => setListIndex((prev) => clampMove(prev, delta, rows.length))}
				onSelect={() => {
					const current = rows[listIndex];
					if (current) {
						setDetail(loadMcpDetail(current.Id));
						setMode('detail');
					}
				}}
				onExit={onExitToNav}
			/>

			<RemoveInput
				active={active && mode === 'confirm-remove'}
				onCancel={() => setMode('detail')}
				onConfirm={() => {
					if (detail) {
						const result = removeMcpServer(detail.id, true);
						reportResult(result, `已删除 MCP Server ${detail.id}`);
					}
				}}
			/>
		</box>
	);
}

// ── 键盘输入订阅（OpenTUI useKeyboard） ────────────────────────────────────

function ListInput({
	active,
	hasRows,
	onMove,
	onSelect,
	onExit
}: {
	readonly active: boolean;
	readonly hasRows: boolean;
	readonly onMove: (delta: number) => void;
	readonly onSelect: () => void;
	readonly onExit: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) return;

		switch (keyEvent.name.toLowerCase()) {
			case 'up':
			case 'arrowup':
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
				if (hasRows) {
					onSelect();
				}
				break;
		}
	});

	return null;
}

function DetailInput({
	active,
	detail,
	onBack,
	onEdit,
	onToggle,
	onRemove
}: {
	readonly active: boolean;
	readonly detail: McpServerDetail;
	readonly onBack: () => void;
	readonly onEdit: () => void;
	readonly onToggle: () => void;
	readonly onRemove: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) return;

		const k = keyEvent.name.toLowerCase();
		if (k === 'escape' || k === 'left' || k === 'arrowleft') {
			onBack();
		} else if (k === 'e') {
			onEdit();
		} else if (k === 't' && (detail.status === 'Active' || detail.status === 'Disabled')) {
			onToggle();
		} else if (k === 'x' && detail.status !== 'Missing') {
			onRemove();
		}
	});

	return null;
}

function RemoveInput({
	active,
	onCancel,
	onConfirm
}: {
	readonly active: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) return;

		const k = keyEvent.name.toLowerCase();
		if (k === 'escape') {
			onCancel();
		} else if (k === 'enter' || k === 'return') {
			onConfirm();
		}
	});

	return null;
}

function MessageInput({ active, onDismiss }: { readonly active: boolean; readonly onDismiss: () => void }) {
	useKeyboard((keyEvent) => {
		if (!active) return;
		if (keyEvent.name) {
			onDismiss();
		}
	});

	return null;
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function clampMove(prev: number, delta: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	const next = prev + delta;
	if (next < 0) {
		return length - 1;
	}

	if (next >= length) {
		return 0;
	}

	return next;
}
