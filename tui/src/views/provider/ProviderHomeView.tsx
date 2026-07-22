import React from 'react';
import {useKeyboard} from '@opentui/react';
import {ErrorPanel, ListEmptyState, Modal, ScrollList, StatusDot, ViewHeader, type ScrollListItem} from '../../components/index.js';
import {colors} from '../../theme/index.js';
import type {ProviderHomeRow} from './provider-view-adapter.js';

const HOME_MODAL_WIDTH = 56;

export type ProviderHomeViewProps = {
	readonly rows: readonly ProviderHomeRow[];
	readonly selectedIndex: number;
	readonly active: boolean;
	readonly isCodex: boolean;
	readonly migrationFailures: readonly {readonly key: string; readonly reason?: string}[];
	readonly loadFailures: readonly {readonly key: string; readonly reason: string}[];
	readonly currentKey?: string;
	readonly currentIsActive: boolean;
	readonly currentIsOfficial: boolean;
	readonly confirmingDelete: boolean;
	readonly onMove: (delta: number) => void;
	readonly onSwitch: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
	readonly onExitToHeader?: () => void;
	readonly onCancelDelete: () => void;
	readonly onConfirmDelete: () => void;
};

export function ProviderHomeView({
	rows,
	selectedIndex,
	active,
	isCodex,
	migrationFailures,
	loadFailures,
	currentKey,
	currentIsActive,
	currentIsOfficial,
	confirmingDelete,
	onMove,
	onSwitch,
	onAdd,
	onEdit,
	onDelete,
	onExit,
	onExitToHeader,
	onCancelDelete,
	onConfirmDelete
}: ProviderHomeViewProps) {
	const items: ScrollListItem[] = rows.map(row => ({
		key: row.key,
		title: row.key,
		leading: row.isActive ? <StatusDot kind="latest" /> : <text fg={colors.muted}>●</text>,
		body: <text fg={colors.muted}>{row.summary}</text>
	}));

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="供应商管理" subtitle="管理 API 供应商、密钥与模型环境变量" />
			{migrationFailures.length > 0 ? (
				<box marginBottom={1}>
					<ErrorPanel
						message={`${migrationFailures.length} 个供应商迁移失败，可恢复（旧文件已保留）：${migrationFailures.map(failure => failure.key).join('、')}`}
					/>
				</box>
			) : null}
			{loadFailures.length > 0 ? (
				<box marginBottom={1}>
					<ErrorPanel
						message={`${loadFailures.length} 个供应商配置无法读取，已跳过：${loadFailures.map(failure => `${failure.key}（${failure.reason}）`).join('、')}`}
					/>
				</box>
			) : null}
			{rows.length === 0 ? (
				<ListEmptyState
					message="暂无供应商配置"
					hint={{
						label: isCodex
							? '添加第一个供应商（可在表单内选择类型，支持 official login / 自定义）'
							: '添加第一个供应商（可在表单内选择类型，含自定义）',
						enabled: true
					}}
				/>
			) : (
				<ScrollList items={items} cursor={selectedIndex} active={active && !confirmingDelete} />
			)}
			{confirmingDelete && currentKey ? (
				<Modal
					active
					title={currentIsOfficial ? '确认登出官方账号' : currentIsActive ? '禁止删除活跃供应商' : '确认删除供应商'}
					hint="Enter 确认  Esc 取消"
					tone="danger"
					width={HOME_MODAL_WIDTH}
				>
					<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						{currentIsOfficial
							? '将清空 ~/.codex/auth.json 登出 Codex 官方账号，此操作不可撤销。'
							: currentIsActive
								? `${currentKey} 是当前活跃供应商，删除前请先切换到其他供应商。`
								: `即将删除供应商 ${currentKey}，此操作不可撤销。`}
					</text>
				</Modal>
			) : null}
			<ProviderListInput
				active={active && !confirmingDelete}
				hasCurrent={currentKey !== undefined}
				atTop={selectedIndex === 0}
				onMove={onMove}
				onSwitch={onSwitch}
				onAdd={onAdd}
				onEdit={onEdit}
				onDelete={onDelete}
				onExit={onExit}
				onExitToHeader={onExitToHeader}
			/>
			<ProviderDeleteInput active={active && confirmingDelete} onCancel={onCancelDelete} onConfirm={onConfirmDelete} />
		</box>
	);
}

function ProviderListInput({
	active,
	hasCurrent,
	atTop,
	onMove,
	onSwitch,
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
	readonly onSwitch: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
	readonly onExitToHeader?: () => void;
}) {
	useKeyboard(keyEvent => {
		if (!active) return;
		switch (keyEvent.name.toLowerCase()) {
			case 'up':
			case 'arrowup':
				if (atTop && onExitToHeader) onExitToHeader();
				else onMove(-1);
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
				if (hasCurrent) onSwitch();
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

function ProviderDeleteInput({
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
		const name = keyEvent.name.toLowerCase();
		if (name === 'escape') onCancel();
		if (name === 'enter' || name === 'return') onConfirm();
	});
	return null;
}
