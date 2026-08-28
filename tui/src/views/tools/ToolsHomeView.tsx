import React from 'react';
import {TextAttributes, type ScrollBoxRenderable} from '@opentui/core';
import {
	Card,
	ErrorPanel,
	ListEmptyState,
	ListLoadingState,
	StatusDot,
	ThemedScrollbox,
	ViewHeader,
	type StatusDotKind
} from '../../components/index.js';
import type {DetectionState} from '../../services/async-detection.js';
import {AGENT_CONTEXT_LABELS} from '../../state/manage-state.js';
import {CARD_WIDTH, itemStatusOf, type ComponentItemStatus, type ToolsViewState} from '../../state/tools-view-state.js';
import {colors} from '../../theme/index.js';
import {groupToolsForHome, toolStatusDot} from './tools-view-actions.js';
import type {ComponentId, ManagedComponent, SharedManagedComponent} from './tools-view-types.js';

export type ToolsHomeViewProps = {
	readonly view: ToolsViewState;
	readonly detectionStatus: DetectionState<ManagedComponent[]>['status'];
	readonly scrollRef: React.RefObject<ScrollBoxRenderable | null>;
	readonly active: boolean;
};

export function ToolsHomeView({view, detectionStatus, scrollRef, active}: ToolsHomeViewProps) {
	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="工具管理" subtitle="管理常用 CLI 工具的安装、更新与卸载" />
			{renderDetectionNotice(detectionStatus)}
			{detectionStatus !== 'loading' && detectionStatus !== 'idle' ? renderGrid(view, scrollRef, active) : null}
			{view.errorText ? <ErrorPanel message={view.errorText} /> : null}
		</box>
	);
}

export function toolCardId(component: ManagedComponent, index: number): string {
	return `tools-grid-item-${index}-${component.id}`;
}

function renderDetectionNotice(status: DetectionState<ManagedComponent[]>['status']): React.ReactNode {
	return status === 'loading' || status === 'idle' ? <ListLoadingState message="检测中..." /> : null;
}

function renderGrid(view: ToolsViewState, scrollRef: React.RefObject<ScrollBoxRenderable | null>, active: boolean): React.ReactNode {
	if (view.components.length === 0) {
		return view.loaded ? <ListEmptyState message="未检测到可管理的组件" /> : null;
	}
	const sections = groupToolsForHome(view.components);
	return (
		<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, marginTop: 1}} viewportCulling scrollY scrollX={false}>
			<box flexDirection="column">
				{sections.map(section => (
					<box key={section.group} flexDirection="column" marginBottom={1}>
						<text
							fg={colors.primary}
							attributes={TextAttributes.BOLD}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>
							{section.label}
						</text>
						<box flexDirection="row" flexWrap="wrap">
							{section.components.map(component => {
								const index = view.components.findIndex(item => item.id === component.id);
								return (
									<box
										key={component.id}
										id={toolCardId(component, index)}
										marginRight={1}
										marginBottom={0}
										flexShrink={0}
									>
										<ToolCard
											component={component as SharedManagedComponent}
											focused={active && index === view.cursor}
											status={itemStatusOf(view, component.id)}
										/>
									</box>
								);
							})}
						</box>
					</box>
				))}
			</box>
		</ThemedScrollbox>
	);
}

function ToolCard({
	component,
	focused,
	status
}: {
	readonly component: SharedManagedComponent;
	readonly focused: boolean;
	readonly status: ComponentItemStatus;
}) {
	const titleRight =
		component.id === 'CcgWorkflow' ? (
			component.hasUpdate === true || status !== 'idle' ? (
				<StatusRight dot={toolStatusDot(component, status)} />
			) : undefined
		) : (
			<StatusRight dot={toolStatusDot(component, status)} />
		);
	return (
		<Card title={component.name} titleRight={titleRight} focused={focused} width={CARD_WIDTH} multiLine>
			<CardBody component={component} />
		</Card>
	);
}

function StatusRight({dot}: {readonly dot: {readonly kind: StatusDotKind; readonly label: string}}) {
	return <StatusDot kind={dot.kind} label={dot.label} />;
}

function CardBody({component}: {readonly component: SharedManagedComponent}) {
	if (component.sharingKind === 'shared-cli-per-agent-inject') {
		return (
			<box flexDirection="column">
				<box flexDirection="row" height={1} overflow="hidden">
					<InjectBadge
						label={AGENT_CONTEXT_LABELS.cc}
						injected={Boolean(component.injectByAgent?.cc?.integrated)}
						version={component.injectByAgent?.cc?.version}
					/>
					<text fg={colors.muted}>{'  '}</text>
					<InjectBadge
						label={AGENT_CONTEXT_LABELS.cx}
						injected={Boolean(component.injectByAgent?.cx?.integrated)}
						version={component.injectByAgent?.cx?.version}
					/>
				</box>
				<StatusHint text={component.statusHint} />
				<box height={1} overflow="hidden">
					<DocsLink text={component.description} url={component.docsUrl} />
				</box>
			</box>
		);
	}
	return (
		<box flexDirection="column">
			<box height={1} />
			<StatusHint text={component.statusHint} />
			<box height={1} overflow="hidden">
				<DocsLink text={component.description} url={component.docsUrl} />
			</box>
		</box>
	);
}

function StatusHint({text}: {readonly text?: string}) {
	return (
		<box height={1} overflow="hidden">
			<text fg={colors.warning} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{text ?? ''}
			</text>
		</box>
	);
}

function DocsLink({text, url}: {readonly text: string; readonly url?: string}) {
	if (!url) {
		return (
			<text fg={colors.muted} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{text}
			</text>
		);
	}
	return (
		<text selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			<a href={url} fg={colors.primary} attributes={TextAttributes.UNDERLINE}>
				{text}
			</a>
		</text>
	);
}

function InjectBadge({label, injected, version}: {readonly label: string; readonly injected: boolean; readonly version?: string}) {
	const suffix = injected && version ? ` ${version}` : '';
	return (
		<text fg={injected ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${injected ? '●' : '○'} ${label}${suffix}`}
		</text>
	);
}

export function agentExclusiveScope(id: ComponentId): string {
	switch (id) {
		case 'Ccline':
			return '仅 Claude Code';
		case 'ClaudeCode':
			return 'Claude Code 本体';
		case 'CodexCli':
			return 'Codex 本体';
		default:
			return '';
	}
}
