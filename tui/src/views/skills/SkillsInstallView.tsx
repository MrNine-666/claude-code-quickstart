import React from 'react';
import {TextAttributes} from '@opentui/core';
import {Checkbox, ListEmptyState, ListLoadingState, ScrollList, SingleLineInput} from '../../components/index.js';
import type {DetectionState} from '../../services/async-detection.js';
import {displaySkillName, searchInstallItems, type SkillsViewState} from '../../state/skills-view-state.js';
import {colors} from '../../theme/index.js';
import type {InstalledSkill, SkillsViewDispatch} from './skills-view-types.js';

export type SkillsInstallViewProps = {
	readonly view: SkillsViewState;
	readonly detection: DetectionState<InstalledSkill[]>;
	readonly active: boolean;
	readonly dispatch: SkillsViewDispatch;
};

export function SkillsInstallView({view, detection, active, dispatch}: SkillsInstallViewProps) {
	const detectionReady = detection.status === 'success';
	const projected = searchInstallItems(view);
	const items = projected.map((item, index) => {
		const {skillName = displaySkillName(item.result.name)} = item.identity ?? {};
		const skill = item.result;
		const installCountText = skill.installCount ? formatInstallCount(skill.installCount) : '';
		const titleText = `${skillName} (${skill.source})`;
		const statusLabel = searchStatusLabel(item, detectionReady);
		const bodyParts = [skill.description, skill.url].filter(Boolean);
		return {
			key: item.identity?.key ?? `${index}:${skill.name}`,
			title: titleText,
			titleColor: active && index === view.resultIndex ? colors.primary : colors.text,
			titleAttrs: TextAttributes.BOLD,
			titleRight:
				statusLabel || installCountText ? (
					<box flexDirection="row">
						{statusLabel ? (
							<text
								fg={
									item.status === 'source-replacement'
										? colors.warning
										: item.status === 'installed'
											? colors.success
											: colors.muted
								}
							>
								{statusLabel}
							</text>
						) : null}
						{statusLabel && installCountText ? <text fg={colors.muted}>{'  '}</text> : null}
						{installCountText ? <text fg={colors.muted}>{installCountText}</text> : null}
					</box>
				) : undefined,
			leading: (
				<Checkbox
					checked={item.selected}
					disabled={!detectionReady || !item.selectable}
					focused={active && index === view.resultIndex}
				/>
			),
			body:
				bodyParts.length > 0 ? (
					<box flexDirection="column">
						{bodyParts.map((part, partIndex) => (
							<text
								key={`${item.identity?.key ?? skill.name}:${partIndex}`}
								fg={colors.muted}
								attributes={TextAttributes.DIM}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
							>
								{part}
							</text>
						))}
					</box>
				) : undefined,
			multiLine: true
		};
	});
	const header =
		items.length > 0 ? (
			<box flexDirection="row" justifyContent="space-between" paddingX={2} marginBottom={0}>
				<text fg={colors.muted} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					名称
				</text>
				<text fg={colors.muted} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					状态 / 下载量
				</text>
			</box>
		) : undefined;

	return (
		<box flexDirection="column" flexGrow={1}>
			<SingleLineInput
				label="搜索"
				value={view.query}
				focused={active && view.queryFocused}
				placeholder="输入关键词搜索 skills.sh"
				onChange={value => dispatch({type: 'query-input', value})}
			/>
			{view.searching ? (
				<ListLoadingState message="正在搜索..." />
			) : items.length > 0 ? (
				<box marginTop={1} flexGrow={1} flexDirection="column">
					<ScrollList items={items} cursor={view.resultIndex} header={header} active={active} focusIndicator="leading" />
				</box>
			) : (
				<ListEmptyState message="输入关键词开始搜索" />
			)}
		</box>
	);
}

function searchStatusLabel(item: ReturnType<typeof searchInstallItems>[number], detectionReady: boolean): string {
	if (!detectionReady) return '○ 等待检测';
	if (!item.identity) return '○ 来源不可用';
	const labels: Partial<Record<typeof item.status, string>> = {
		installed: '● 已安装',
		'claude-only': '● 仅 Claude Code',
		'codex-only': '● 仅 Codex',
		'shared-copy': '● Claude 独立副本',
		'source-replacement': '已有同名',
		'name-occupied': '● 同名来源未知',
		'selection-conflict': '○ 同名冲突'
	};
	return labels[item.status] ?? '';
}

function formatInstallCount(count: number): string {
	if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
	if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
	return String(count);
}
