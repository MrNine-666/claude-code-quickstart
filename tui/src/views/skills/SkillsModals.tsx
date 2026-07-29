import React from 'react';
import {TextAttributes} from '@opentui/core';
import {Modal, ThemedScrollbox} from '../../components/index.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {otherAgentsOf, storageRootsOf, type InstalledSkillItem} from '../../core/skills-installed.js';
import {
	currentTopologyOfItem,
	needsManagedMigration,
	pendingInstallResults,
	pendingInstance,
	pendingSourceReplacements,
	selectedInstalled,
	uninstallTargets,
	type SkillsViewMode,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import {viewShortcuts} from '../../state/shortcuts.js';
import {colors} from '../../theme/index.js';
import {provenanceLabel, storageRootLabel, targetTopologyOfInstallDraft, topologyLabel} from './skills-view-actions.js';

const SKILLS_MODAL_WIDTH = 56;

export function skillsModalHint(mode: SkillsViewMode): string {
	return viewShortcuts('skills', mode)
		.map(shortcut => `${shortcut.key} ${shortcut.label}`)
		.join('  ');
}

export function skillsModalOpen(mode: SkillsViewMode): boolean {
	return (
		mode === 'select-install-target' ||
		mode === 'manage-inject' ||
		mode === 'confirm-topology-change' ||
		mode === 'confirm-source-replacement' ||
		mode === 'confirm-uninstall'
	);
}

export function SkillsUninstallConfirm({view}: {readonly view: SkillsViewState}) {
	const targets = uninstallTargets(view);
	const targetIds = new Set(targets.map(item => item.id));
	const targetNames = new Set(targets.map(item => item.name));
	const sameNameOthers = view.installed.filter(item => targetNames.has(item.name) && !targetIds.has(item.id)).length;
	const height = Math.max(3, Math.min(12, targets.reduce((count, item) => count + item.projections.length + 2, 0)));
	return (
		<Modal active title="确认批量卸载 Skill" hint={skillsModalHint('confirm-uninstall')} tone="danger" width={SKILLS_MODAL_WIDTH}>
			{targets.length > 0 ? (
				<box flexDirection="column">
					<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						{`将卸载 ${targets.length} 个 Skill 的全部 Agent 与存储投影，此操作不可撤销。`}
					</text>
					<box height={height} minHeight={0} marginTop={1}>
						<ThemedScrollbox style={{flexGrow: 1, minHeight: 0}} scrollY scrollX={false}>
							{targets.map(target => (
								<box key={target.id} flexDirection="column" marginBottom={1}>
									<text fg={colors.text} attributes={TextAttributes.BOLD}>
										{`${target.name}（${provenanceLabel(target)}）`}
									</text>
									{target.projections.map(projection => (
										<text key={projection.path} fg={colors.muted}>
											{`${storageRootLabel(projection.root)}：${projection.path}`}
										</text>
									))}
								</box>
							))}
						</ThemedScrollbox>
					</box>
					{sameNameOthers > 0 ? (
						<text fg={colors.warning}>{`同名其它来源的 ${sameNameOthers} 个实例不受影响。`}</text>
					) : null}
				</box>
			) : (
				<text fg={colors.text}>无卸载目标</text>
			)}
		</Modal>
	);
}

export function SkillsTopologyConfirmModal({view}: {readonly view: SkillsViewState}) {
	// 确认态读取快照实例，不按 cursor 重查，避免刷新后打到同名另一来源（R2）。
	const current = pendingInstance(view) ?? selectedInstalled(view);
	const currentTopology = current ? currentTopologyOfItem(current) : undefined;
	const target = targetTopologyOfInstallDraft(view.installDraft);
	const otherAgents = current ? otherAgentsOf(current) : [];
	const migrating = current ? needsManagedMigration(current, target === 'empty' ? 'shared' : target) : false;
	return (
		<Modal
			active
			title={`确认切换安装拓扑：${current?.name ?? ''}`}
			hint={skillsModalHint('confirm-topology-change')}
			tone="warning"
			width={SKILLS_MODAL_WIDTH}
		>
			<box flexDirection="column">
				<text
					fg={colors.text}
				>{`${topologyLabel(currentTopology)} → ${target === 'empty' ? '无目标' : topologyLabel(target)}`}</text>
				<text fg={colors.muted}>{`来源：${provenanceLabel(current)}`}</text>
				{current?.projections.map(projection => (
					<text key={projection.path} fg={colors.muted}>{`${storageRootLabel(projection.root)}：${projection.path}`}</text>
				))}
				<text fg={colors.warning}>
					内容会先快照；先建立并验证目标，成功后才删除原实例，最后以完整 CLI 检测确认最终状态。
				</text>
				{migrating ? (
					<text fg={colors.warning}>当前实例位于 .codex/skills，将被收编到受管拓扑；即使目标侧不变也不是空操作。</text>
				) : null}
				{target === 'claude-only' ? (
					<text fg={colors.warning}>Codex 及直接读取 .agents/skills 的消费者将失去此 Skill。</text>
				) : null}
				{otherAgents.length > 0 ? <text fg={colors.danger}>{`其它 Agent：${otherAgents.join('、')}`}</text> : null}
			</box>
		</Modal>
	);
}

export function SkillsSourceReplacementConfirmModal({view}: {readonly view: SkillsViewState}) {
	const replacements = pendingSourceReplacements(view);
	const targets = AGENT_CONTEXT_ORDER.filter(ctx => view.installDraft[ctx])
		.map(ctx => AGENT_CONTEXT_LABELS[ctx])
		.join('、');
	const height = Math.max(3, Math.min(12, replacements.length * 4));
	return (
		<Modal
			active
			title="确认覆盖同名 Skill"
			hint={skillsModalHint('confirm-source-replacement')}
			tone="danger"
			width={SKILLS_MODAL_WIDTH}
		>
			<box flexDirection="column">
				<text fg={colors.warning}>
					以下目标根中的同名实例将被覆盖；旧内容会先分别快照，操作后以完整 CLI 检测确认最终状态。
				</text>
				<text fg={colors.text}>{`最终安装目标：${targets}`}</text>
				<box height={height} minHeight={0} marginTop={1}>
					<ThemedScrollbox style={{flexGrow: 1, minHeight: 0}} scrollY scrollX={false}>
						{replacements.map(item => (
							<box key={JSON.stringify([item.identity.key, item.installed.id])} flexDirection="column" marginBottom={1}>
								<text fg={colors.text} attributes={TextAttributes.BOLD}>
									{item.identity.skillName}
								</text>
								<text fg={colors.muted}>{`当前来源：${provenanceLabel(item.installed)}`}</text>
								<text fg={colors.primary}>{`新来源：${item.identity.source}`}</text>
								<text fg={colors.muted}>
									{`目标存储：${item.projections.map(p => storageRootLabel(p.root)).join('、') || '未知'}`}
								</text>
							</box>
						))}
					</ThemedScrollbox>
				</box>
			</box>
		</Modal>
	);
}

export function SkillsInstallTargetModal({view}: {readonly view: SkillsViewState}) {
	const isManage = view.mode === 'manage-inject';
	const managed = pendingInstance(view) ?? selectedInstalled(view);
	const name = managed?.name ?? '';
	const title = isManage ? `管理安装：${name}` : `选择安装目标：${pendingInstallResults(view).length} 个 Skill`;
	const selected = AGENT_CONTEXT_ORDER[view.targetIndex] ?? 'cc';
	return (
		<Modal active title={title} hint={skillsModalHint(view.mode)} width={SKILLS_MODAL_WIDTH}>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map(ctx => {
					const checked = Boolean(view.installDraft[ctx]);
					const focused = ctx === selected;
					const readonly = isManage ? managedTargetReadonly(managed) : ctx === 'cx';
					const stateLabel = isManage
						? managedTargetLabel(checked)
						: readonly
							? '● 安装'
							: checked
								? '● 安装'
								: '○ 不安装';
					return (
						<box key={ctx} flexDirection="row">
							<text
								fg={focused ? colors.primary : colors.muted}
								attributes={focused ? TextAttributes.BOLD : 0}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexGrow={1}
							>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]}${readonly ? '（只读）' : ''} `}
							</text>
							<text
								fg={checked ? colors.success : colors.muted}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexShrink={0}
							>
								{stateLabel}
							</text>
						</box>
					);
				})}
				{isManage && managed && storageRootsOf(managed).includes('codex') ? (
					<text fg={colors.warning}>当前实例位于 .codex/skills；应用后将迁移到受管的 .agents/.claude 拓扑。</text>
				) : null}
			</box>
		</Modal>
	);
}

// 只读判定只由 provenance 能力派生（R3）：未知来源不可编辑任一侧，
// 已知来源两侧都可编辑；不再按存储 kind 或物理检查预先屏蔽。
function managedTargetReadonly(item: InstalledSkillItem | undefined): boolean {
	return !item?.capabilities.manageAgents;
}

function managedTargetLabel(checked: boolean): string {
	return checked ? '● 目标安装' : '○ 目标不安装';
}
