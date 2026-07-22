import React from 'react';
import {TextAttributes} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {Modal} from '../../components/index.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER} from '../../state/manage-state.js';
import {cursorComponent, injectTargetContext, type ToolsViewState} from '../../state/tools-view-state.js';
import {colors} from '../../theme/index.js';
import {isToolsInjectable, toolsUninstallImpactNotice} from './tools-view-actions.js';
import type {ManagedComponent, SharedManagedComponent} from './tools-view-types.js';

const TOOLS_MODAL_WIDTH = 56;

export function ToolsUninstallConfirm({
	view,
	active,
	onCancel,
	onConfirm
}: {
	readonly view: ToolsViewState;
	readonly active: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: (component: ManagedComponent, fullUninstall: boolean) => void;
}) {
	const target = view.components.find(item => item.id === view.uninstallTarget);
	const fullUninstall = target ? isToolsInjectable(target.id) : false;
	useKeyboard(keyEvent => {
		if (!active || !target) return;
		const key = keyEvent.name.toLowerCase();
		if (key === 'escape') onCancel();
		else if (key === 'enter' || key === 'return') onConfirm(target, fullUninstall);
	});
	if (!target) return null;
	return (
		<Modal active title={`卸载确认：${target.name}`} hint="Enter 确认  Esc 取消" tone="danger" width={TOOLS_MODAL_WIDTH}>
			<box flexDirection="column">
				<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{toolsUninstallImpactNotice(target.id, fullUninstall)}
				</text>
			</box>
		</Modal>
	);
}

export function ToolsInjectTargetModal({view}: {readonly view: ToolsViewState}) {
	const shared = cursorComponent(view) as SharedManagedComponent | undefined;
	const selected = injectTargetContext(view);
	const draft = view.injectDraft;
	return (
		<Modal
			active
			title={`管理开关：${shared?.name ?? ''}`}
			hint="↑/↓ 选择  空格 切换装/卸  Enter 应用  Esc 取消"
			width={TOOLS_MODAL_WIDTH}
		>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map(ctx => {
					const enabled = Boolean(draft?.[ctx]);
					const focused = ctx === selected;
					const version = shared?.injectByAgent?.[ctx]?.version;
					const stateLabel = enabled ? (version ? `● 已安装 ${version}` : '● 已安装') : '○ 卸载';
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
								{stateLabel}
							</text>
						</box>
					);
				})}
			</box>
		</Modal>
	);
}
