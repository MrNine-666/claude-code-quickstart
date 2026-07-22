import React from 'react';
import {TextAttributes} from '@opentui/core';
import {Modal, ThemedScrollbox} from '../../components/index.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {
	pendingInstallResults,
	pendingSourceReplacements,
	selectedInstalled,
	uninstallTargets,
	type SkillsViewMode,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import {viewShortcuts} from '../../state/shortcuts.js';
import {colors} from '../../theme/index.js';
import {targetTopologyOfInstallDraft, topologyLabel, topologyOfStorage} from './skills-view-actions.js';

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
	const names = uninstallTargets(view);
	return (
		<Modal active title="确认卸载 Skill" hint={skillsModalHint('confirm-uninstall')} tone="danger" width={SKILLS_MODAL_WIDTH}>
			<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{names.length > 0
					? `将在所有 Agent 中卸载 ${names.join(', ')}：移除 Claude Code symlink 与共享本体，此操作不可撤销。`
					: '无卸载目标'}
			</text>
		</Modal>
	);
}

export function SkillsTopologyConfirmModal({view}: {readonly view: SkillsViewState}) {
	const current = selectedInstalled(view);
	const storage = current?.storage;
	const currentTopology = topologyOfStorage(storage);
	const target = targetTopologyOfInstallDraft(view.installDraft);
	const otherAgents = current?.otherAgents ?? [];
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
				<text fg={colors.muted}>{`Claude 路径：${storage?.claudePath ?? '未知'}`}</text>
				<text fg={colors.muted}>{`Codex 本体：${storage?.canonicalPath ?? '未知'}`}</text>
				<text fg={colors.warning}>
					内容会先快照；目标树删除、物化和投影均由官方 Skills CLI 完成。targeted remove 可能移除远程 lock，使结果转为本地来源。
				</text>
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
					新来源将直接覆盖同名共享本体与 lock 来源；只有 postflight 成功后才清理未选择的旧 Claude 投影。
				</text>
				<text fg={colors.text}>{`最终安装目标：${targets}`}</text>
				<box height={height} minHeight={0} marginTop={1}>
					<ThemedScrollbox style={{flexGrow: 1, minHeight: 0}} scrollY scrollX={false}>
						{replacements.map(item => (
							<box key={item.identity.key} flexDirection="column" marginBottom={1}>
								<text fg={colors.text} attributes={TextAttributes.BOLD}>
									{item.identity.skillName}
								</text>
								<text fg={colors.muted}>{`当前来源：${item.installed.source}`}</text>
								<text fg={colors.primary}>{`新来源：${item.identity.source}`}</text>
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
	const managed = selectedInstalled(view);
	const name = managed?.name ?? '';
	const title = isManage ? `管理安装：${name}` : `选择安装目标：${pendingInstallResults(view).length} 个 Skill`;
	const selected = AGENT_CONTEXT_ORDER[view.targetIndex] ?? 'cc';
	return (
		<Modal active title={title} hint={skillsModalHint(view.mode)} width={SKILLS_MODAL_WIDTH}>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map(ctx => {
					const checked = Boolean(view.installDraft[ctx]);
					const focused = ctx === selected;
					const readonly = isManage ? managedTargetReadonly(managed, ctx) : ctx === 'cx';
					const stateLabel = isManage
						? managedTargetLabel(managed, ctx, checked)
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
				{isManage && managed?.storage?.kind === 'shared-copy' ? (
					<text fg={colors.warning}>当前为独立副本；直接应用将重试共享链接。</text>
				) : null}
				{isManage && managed?.storage?.error ? <text fg={colors.danger}>{managed.storage.error}</text> : null}
			</box>
		</Modal>
	);
}

function managedTargetReadonly(skill: ReturnType<typeof selectedInstalled>, context: AgentContext): boolean {
	if (!skill) return true;
	if (!skill.storage) return context === 'cx';
	return ['invalid', 'invalid-link', 'conflict', 'missing'].includes(skill.storage.kind);
}

function managedTargetLabel(skill: ReturnType<typeof selectedInstalled>, context: AgentContext, checked: boolean): string {
	if (skill?.storage?.kind === 'shared-copy' && checked) return context === 'cc' ? '● 独立副本（选择双侧将修复）' : '● canonical 本体';
	return checked ? '● 目标安装' : '○ 目标不安装';
}
