import React, {useEffect, useRef} from 'react';
import {TextAttributes, type ScrollBoxRenderable} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {Card, ListEmptyState, Modal, ThemedScrollbox, ViewHeader} from '../../components/index.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {colors} from '../../theme/index.js';
import {MCP_GRID_COLUMNS, type McpGridDirection, type McpToggleDraft, type McpViewRow} from './mcp-view-actions.js';

const TOGGLE_MODAL_WIDTH = 56;

export type McpHomeMode = 'list' | 'select-toggle-target' | 'confirm-remove';

export type McpHomeViewProps = {
	readonly rows: readonly McpViewRow[];
	readonly selectedIndex: number;
	readonly current: McpViewRow | null;
	readonly mode: McpHomeMode;
	readonly active: boolean;
	readonly toggleDraft: McpToggleDraft;
	readonly toggleIndex: number;
	readonly onMove: (delta: number) => void;
	readonly onMoveHorizontal: (direction: McpGridDirection) => void;
	readonly onOpenToggle: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
	readonly onMoveToggle: (delta: number) => void;
	readonly onToggleDraft: () => void;
	readonly onApplyToggle: () => void;
	readonly onCancelModal: () => void;
	readonly onConfirmRemove: () => void;
};

export function McpHomeView({
	rows,
	selectedIndex,
	current,
	mode,
	active,
	toggleDraft,
	toggleIndex,
	onMove,
	onMoveHorizontal,
	onOpenToggle,
	onAdd,
	onEdit,
	onDelete,
	onExit,
	onMoveToggle,
	onToggleDraft,
	onApplyToggle,
	onCancelModal,
	onConfirmRemove
}: McpHomeViewProps) {
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="MCP Server 管理" subtitle="共享维护 Claude Code 与 Codex 两侧的 MCP Server 连接" />
			{rows.length === 0 ? (
				<ListEmptyState message="暂无 MCP Server" />
			) : (
				<McpGrid rows={rows} cursor={selectedIndex} active={active && mode === 'list'} />
			)}
			{mode === 'select-toggle-target' && current ? (
				<ToggleTargetModal name={current.Id} draft={toggleDraft} focusedIndex={toggleIndex} />
			) : null}
			{mode === 'confirm-remove' && current ? (
				<Modal active title="全量删除 MCP Server" hint="Enter 确认  Esc 取消" tone="danger" width={TOGGLE_MODAL_WIDTH}>
					<text
						fg={colors.text}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
					>{`即将删除 ${current.Id}：移除 Claude Code 与 Codex 两侧配置及共享定义，此操作不可撤销。`}</text>
				</Modal>
			) : null}
			<McpListInput
				active={active && mode === 'list'}
				hasCurrent={current !== null}
				atFirst={selectedIndex === 0}
				onMove={onMove}
				onMoveHorizontal={onMoveHorizontal}
				onToggle={onOpenToggle}
				onAdd={onAdd}
				onEdit={onEdit}
				onDelete={onDelete}
				onExit={onExit}
			/>
			<ToggleModalInput
				active={active && mode === 'select-toggle-target'}
				onNav={onMoveToggle}
				onToggle={onToggleDraft}
				onApply={onApplyToggle}
				onCancel={onCancelModal}
			/>
			<ConfirmInput active={active && mode === 'confirm-remove'} onCancel={onCancelModal} onConfirm={onConfirmRemove} />
		</box>
	);
}

function McpGrid({
	rows,
	cursor,
	active
}: {
	readonly rows: readonly McpViewRow[];
	readonly cursor: number;
	readonly active: boolean;
}) {
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const safeCursor = rows.length === 0 ? 0 : Math.min(Math.max(cursor, 0), rows.length - 1);
	const activeCardId = rows[safeCursor] ? mcpCardId(safeCursor) : null;
	const gridRows = Array.from({length: Math.ceil(rows.length / MCP_GRID_COLUMNS)}, (_, rowIndex) => {
		const start = rowIndex * MCP_GRID_COLUMNS;
		return rows.slice(start, start + MCP_GRID_COLUMNS).map((row, offset) => ({row, index: start + offset}));
	});

	useEffect(() => {
		if (scrollRef.current && activeCardId) scrollRef.current.scrollChildIntoView(activeCardId);
	}, [activeCardId]);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, minHeight: 0}} viewportCulling scrollY scrollX={false}>
				<box flexDirection="column">
					{gridRows.map((row, rowIndex) => (
						<box key={`mcp-grid-row-${rowIndex}`} flexDirection="row" alignItems="stretch">
							{row.map(({row: server, index}) => (
								<box
									key={server.Id}
									id={mcpCardId(index)}
									flexBasis={0}
									flexGrow={1}
									minWidth={0}
									marginRight={index % MCP_GRID_COLUMNS === 0 ? 1 : 0}
								>
									<Card title={server.Id} focused={active && index === safeCursor} minHeight={3} multiLine>
										<DualStateBadges cc={server.injectByAgent.cc} cx={server.injectByAgent.cx} />
									</Card>
								</box>
							))}
							{row.length < MCP_GRID_COLUMNS ? <box flexBasis={0} flexGrow={1} minWidth={0} /> : null}
						</box>
					))}
				</box>
			</ThemedScrollbox>
			<text
				flexShrink={0}
				fg={colors.muted}
				selectionBg={colors.selectionBg}
				selectionFg={colors.selectionFg}
			>{`(${safeCursor + 1}/${rows.length})`}</text>
		</box>
	);
}

function mcpCardId(index: number): string {
	return `mcp-grid-item-${index}`;
}

function DualStateBadges({cc, cx}: {readonly cc: McpViewRow['injectByAgent']['cc']; readonly cx: McpViewRow['injectByAgent']['cx']}) {
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

function ToggleTargetModal({
	name,
	draft,
	focusedIndex
}: {
	readonly name: string;
	readonly draft: McpToggleDraft;
	readonly focusedIndex: number;
}) {
	const selected = AGENT_CONTEXT_ORDER[focusedIndex] ?? 'cc';
	return (
		<Modal active title={`管理开关：${name}`} hint="↑/↓ 选择  空格 切换开/关  Enter 应用  Esc 取消" width={TOGGLE_MODAL_WIDTH}>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map(ctx => {
					const enabled = Boolean(draft[ctx]);
					const focused = ctx === selected;
					return (
						<box key={ctx} flexDirection="row">
							<text
								fg={focused ? colors.primary : colors.muted}
								attributes={focused ? TextAttributes.BOLD : 0}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexGrow={1}
							>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]} `}
							</text>
							<text
								fg={enabled ? colors.success : colors.muted}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexShrink={0}
							>
								{enabled ? '● 已开启' : '○ 已禁用'}
							</text>
						</box>
					);
				})}
			</box>
		</Modal>
	);
}

function McpListInput({
	active,
	hasCurrent,
	atFirst,
	onMove,
	onMoveHorizontal,
	onToggle,
	onAdd,
	onEdit,
	onDelete,
	onExit
}: {
	readonly active: boolean;
	readonly hasCurrent: boolean;
	readonly atFirst: boolean;
	readonly onMove: (delta: number) => void;
	readonly onMoveHorizontal: (direction: McpGridDirection) => void;
	readonly onToggle: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
}) {
	useKeyboard(keyEvent => {
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
			case 'right':
			case 'arrowright':
				onMoveHorizontal('right');
				break;
			case 'escape':
			case 'left':
			case 'arrowleft':
				if (keyEvent.name.toLowerCase() === 'escape' || atFirst) onExit();
				else onMoveHorizontal('left');
				break;
			case 'enter':
			case 'return':
				if (hasCurrent) onToggle();
				break;
			case 'a':
				onAdd();
				break;
			case 'e':
				if (hasCurrent) onEdit();
				break;
			case 'd':
				if (hasCurrent) onDelete();
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
	useKeyboard(keyEvent => {
		if (!active) return;
		const key = keyEvent.name.toLowerCase();
		if (key === 'up' || key === 'arrowup') onNav(-1);
		else if (key === 'down' || key === 'arrowdown') onNav(1);
		else if (key === 'space' || keyEvent.name === ' ') onToggle();
		else if (key === 'enter' || key === 'return') onApply();
		else if (key === 'escape') onCancel();
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
	useKeyboard(keyEvent => {
		if (!active) return;
		const key = keyEvent.name.toLowerCase();
		if (key === 'escape') onCancel();
		else if (key === 'enter' || key === 'return') onConfirm();
	});
	return null;
}
