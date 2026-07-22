import React, {useEffect, useState} from 'react';
import {toast} from '../../components/index.js';
import {clampMove} from '../../core/list-utils.js';
import {AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {McpFormView} from './McpFormView.js';
import {McpHomeView} from './McpHomeView.js';
import {
	applyMcpToggleAction,
	createMcpAddFormModel,
	createMcpEditFormModel,
	loadMcpRowsAction,
	removeMcpServerAction,
	submitMcpFormAction,
	validateMcpJsonAction,
	type McpFormModel,
	type McpToggleDraft,
	type McpViewActionResult
} from './mcp-view-actions.js';

export type McpViewProps = {
	readonly active: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
};

type McpScreen =
	| {readonly kind: 'list'}
	| {readonly kind: 'add' | 'edit'; readonly form: McpFormModel}
	| {readonly kind: 'select-toggle-target'; readonly serverId: string}
	| {readonly kind: 'confirm-remove'; readonly serverId: string};

export default function McpView({active, onSubModeChange, onExitToNav}: McpViewProps) {
	const [rows, setRows] = useState(loadMcpRowsAction);
	const [selected, setSelected] = useState(0);
	const [screen, setScreen] = useState<McpScreen>({kind: 'list'});
	const [toggleDraft, setToggleDraft] = useState<McpToggleDraft>({cc: false, cx: false});
	const [toggleIndex, setToggleIndex] = useState(0);
	const safeSelected = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);
	const current = rows[safeSelected] ?? null;

	useEffect(() => {
		if (!active) return;
		const subMode = screen.kind === 'add' || screen.kind === 'edit'
			? 'form'
			: screen.kind === 'list' && rows.length === 0
				? 'empty'
				: screen.kind;
		onSubModeChange?.(subMode);
	}, [active, onSubModeChange, rows.length, screen.kind]);

	function refresh(): void {
		const next = loadMcpRowsAction();
		setRows(next);
		setSelected(previous => Math.min(previous, Math.max(0, next.length - 1)));
	}

	function settleAction(result: McpViewActionResult): void {
		if (result.ok) toast.success(result.message);
		else toast.error(result.error);
	}

	function returnToList(): void {
		setScreen({kind: 'list'});
	}

	if (screen.kind === 'add' || screen.kind === 'edit') {
		return (
			<McpFormView
				model={screen.form}
				active={active}
				validateJson={validateMcpJsonAction}
				onSubmit={submitMcpFormAction}
				onCancel={returnToList}
				onSaved={message => {
					refresh();
					toast.success(message);
					returnToList();
				}}
			/>
		);
	}

	return (
		<McpHomeView
			rows={rows}
			selectedIndex={safeSelected}
			current={current}
			mode={screen.kind}
			active={active}
			toggleDraft={toggleDraft}
			toggleIndex={toggleIndex}
			onMove={delta => setSelected(previous => clampMove(previous, delta, rows.length))}
			onOpenToggle={() => {
				if (!current) return;
				setToggleDraft({cc: current.injectByAgent.cc.active, cx: current.injectByAgent.cx.active});
				setToggleIndex(0);
				setScreen({kind: 'select-toggle-target', serverId: current.Id});
			}}
			onAdd={() => setScreen({kind: 'add', form: createMcpAddFormModel()})}
			onEdit={() => {
				if (current) setScreen({kind: 'edit', form: createMcpEditFormModel(current.Id)});
			}}
			onDelete={() => {
				if (current) setScreen({kind: 'confirm-remove', serverId: current.Id});
			}}
			onExit={onExitToNav}
			onMoveToggle={delta => setToggleIndex(previous => (previous + delta + AGENT_CONTEXT_ORDER.length) % AGENT_CONTEXT_ORDER.length)}
			onToggleDraft={() => {
				const context: AgentContext = AGENT_CONTEXT_ORDER[toggleIndex] ?? 'cc';
				setToggleDraft(previous => ({...previous, [context]: !previous[context]}));
			}}
			onApplyToggle={() => {
				if (screen.kind !== 'select-toggle-target') return;
				const result = applyMcpToggleAction(screen.serverId, toggleDraft);
				refresh();
				returnToList();
				settleAction(result);
			}}
			onCancelModal={returnToList}
			onConfirmRemove={() => {
				if (screen.kind !== 'confirm-remove') return;
				const result = removeMcpServerAction(screen.serverId);
				refresh();
				returnToList();
				settleAction(result);
			}}
		/>
	);
}
