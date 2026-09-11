import React from 'react';
import {TextAttributes} from '@opentui/core';
import {Modal, ThemedScrollbox} from '../../components/index.js';
import {AGENT_CONTEXT_LABELS} from '../../state/manage-state.js';
import {storageRootsOf, type InstalledSkillItem} from '../../core/skills-installed.js';
import {
	agentTargetsOfDraft,
	managedAgentTargetsOfItem,
	pendingInstallResults,
	pendingInstance,
	pendingSourceReplacements,
	selectedInstalled,
	SKILLS_INSTALL_TARGET_ORDER,
	SKILLS_MANAGE_TARGET_ORDER,
	uninstallTargets,
	type SkillsViewMode,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import {viewShortcuts} from '../../state/shortcuts.js';
import {colors} from '../../theme/index.js';
import {agentTargetsLabel, provenanceLabel, storageRootLabel} from './skills-view-actions.js';

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
	const currentTargets = current ? managedAgentTargetsOfItem(current) : {cc: false, cx: false, pi: false};
	const target = agentTargetsOfDraft(view.installDraft);
	const addedTargets = {
		cc: target.cc && !currentTargets.cc,
		cx: target.cx && !currentTargets.cx,
		pi: target.pi && !currentTargets.pi
	};
	const removedTargets = {
		cc: currentTargets.cc && !target.cc,
		cx: currentTargets.cx && !target.cx,
		pi: currentTargets.pi && !target.pi
	};
	const migrating = Boolean(current && storageRootsOf(current).includes('codex') && (target.cc || target.cx));
	return (
		<Modal
			active
			title={`确认更新安装范围：${current?.name ?? ''}`}
			hint={skillsModalHint('confirm-topology-change')}
			tone="warning"
			width={SKILLS_MODAL_WIDTH}
		>
			<box flexDirection="column">
				<text fg={colors.text}>{`当前安装到：${agentTargetsLabel(currentTargets)}`}</text>
				<text fg={colors.primary}>{`变更为：${agentTargetsLabel(target)}`}</text>
				{agentTargetsLabel(addedTargets) !== '无目标' ? (
					<text fg={colors.success}>{`本次新增：${agentTargetsLabel(addedTargets)}`}</text>
				) : null}
				{agentTargetsLabel(removedTargets) !== '无目标' ? (
					<text fg={colors.warning}>{`本次移除：${agentTargetsLabel(removedTargets)}`}</text>
				) : null}
				<text fg={colors.warning}>
					已有内容会先安全备份；新目标验证成功后才替换，失败时会保留或恢复原安装。
				</text>
				{migrating ? (
					<text fg={colors.warning}>检测到旧版安装，应用后会迁移到当前支持的位置。</text>
				) : null}
			</box>
		</Modal>
	);
}

export function SkillsSourceReplacementConfirmModal({view}: {readonly view: SkillsViewState}) {
	const replacements = pendingSourceReplacements(view);
	const targets = SKILLS_INSTALL_TARGET_ORDER.filter(target => view.installDraft[target])
		.map(target => skillsInstallTargetLabel(target))
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
	const targetOrder = isManage ? SKILLS_MANAGE_TARGET_ORDER : SKILLS_INSTALL_TARGET_ORDER;
	const selected = targetOrder[view.targetIndex] ?? targetOrder[0] ?? 'cc';
	return (
		<Modal active title={title} hint={skillsModalHint(view.mode)} width={SKILLS_MODAL_WIDTH}>
			<box flexDirection="column">
				{targetOrder.map(target => {
					const checked = Boolean(view.installDraft[target]);
					const focused = target === selected;
					const readonly = isManage ? managedTargetReadonly(managed) : target === 'cx';
					const stateLabel = isManage
						? managedTargetLabel(checked)
						: readonly
							? '● 安装'
							: checked
								? '● 安装'
								: '○ 不安装';
					return (
						<box key={target} flexDirection="row">
							<text
								fg={focused ? colors.primary : colors.muted}
								attributes={focused ? TextAttributes.BOLD : 0}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexGrow={1}
							>
								{`${focused ? '›' : ' '} ${skillsInstallTargetLabel(target)}${readonly ? '（只读）' : ''} `}
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
					<text fg={colors.warning}>当前实例位于旧的 .codex/skills；应用后将按选定 Agent 重建受管目标。</text>
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

function skillsInstallTargetLabel(target: (typeof SKILLS_INSTALL_TARGET_ORDER)[number]): string {
	if (target === 'cc') return AGENT_CONTEXT_LABELS.cc;
	return AGENT_CONTEXT_LABELS[target];
}
