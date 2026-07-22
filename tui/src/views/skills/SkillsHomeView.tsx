import React, {useEffect, useRef} from 'react';
import {Card, ListEmptyState, SingleLineInput, ThemedScrollbox} from '../../components/index.js';
import type {ScrollBoxRenderable} from '@opentui/core';
import {AGENT_CONTEXT_LABELS} from '../../state/manage-state.js';
import {filteredInstalled, SKILLS_GRID_COLUMNS, type SkillsViewState} from '../../state/skills-view-state.js';
import {colors} from '../../theme/index.js';
import type {SkillSharedRow, SkillsViewDispatch} from './skills-view-types.js';

export type SkillsHomeViewProps = {
	readonly view: SkillsViewState;
	readonly active: boolean;
	readonly dispatch: SkillsViewDispatch;
};

export function SkillsHomeView({view, active, dispatch}: SkillsHomeViewProps) {
	const filtered = filteredInstalled(view);
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<SingleLineInput
				label="过滤"
				value={view.filterText}
				focused={active && view.filterFocused}
				placeholder="输入关键词模糊筛选已装 skill"
				onChange={value => dispatch({type: 'filter-input', value})}
			/>
			{filtered.length === 0 ? (
				<ListEmptyState
					message={view.installed.length === 0 ? '暂无已安装 skill' : '没有匹配的已装 skill'}
					hint={view.installed.length === 0 ? {label: '进入安装页搜索安装', enabled: true} : undefined}
				/>
			) : (
				<InstalledSkillsGrid skills={filtered} cursor={view.installedIndex} active={active} />
			)}
		</box>
	);
}

function InstalledSkillsGrid({
	skills,
	cursor,
	active
}: {
	readonly skills: readonly SkillSharedRow[];
	readonly cursor: number;
	readonly active: boolean;
}) {
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const safeCursor = skills.length === 0 ? 0 : Math.min(Math.max(cursor, 0), skills.length - 1);
	const activeCardId = skills[safeCursor] ? installedSkillCardId(safeCursor) : null;
	const rows = Array.from({length: Math.ceil(skills.length / SKILLS_GRID_COLUMNS)}, (_, rowIndex) => {
		const start = rowIndex * SKILLS_GRID_COLUMNS;
		return skills.slice(start, start + SKILLS_GRID_COLUMNS).map((skill, offset) => ({skill, index: start + offset}));
	});

	useEffect(() => {
		if (scrollRef.current && activeCardId) scrollRef.current.scrollChildIntoView(activeCardId);
	}, [activeCardId]);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, minHeight: 0}} viewportCulling scrollY scrollX={false}>
				<box flexDirection="column">
					{rows.map((row, rowIndex) => (
						<box key={`skills-grid-row-${rowIndex}`} flexDirection="row" alignItems="stretch">
							{row.map(({skill, index}) => (
								<box
									key={skill.name}
									id={installedSkillCardId(index)}
									flexBasis={0}
									flexGrow={1}
									minWidth={0}
									marginRight={index % SKILLS_GRID_COLUMNS === 0 ? 1 : 0}
								>
									<Card title={skill.name} focused={active && index === safeCursor} minHeight={3} multiLine>
										<InstalledSkillBody skill={skill} />
									</Card>
								</box>
							))}
							{row.length < SKILLS_GRID_COLUMNS ? <box flexBasis={0} flexGrow={1} minWidth={0} /> : null}
						</box>
					))}
				</box>
			</ThemedScrollbox>
			<text
				flexShrink={0}
				fg={colors.muted}
				selectionBg={colors.selectionBg}
				selectionFg={colors.selectionFg}
			>{`(${safeCursor + 1}/${skills.length})`}</text>
		</box>
	);
}

function installedSkillCardId(index: number): string {
	return `skills-grid-item-${index}`;
}

function InstalledSkillBody({skill}: {readonly skill: SkillSharedRow}) {
	const warning = storageWarning(skill);
	const claudeLabel = skill.storage?.kind === 'shared-copy' ? `${AGENT_CONTEXT_LABELS.cc}（独立副本）` : AGENT_CONTEXT_LABELS.cc;
	return (
		<box flexDirection="column">
			<box flexDirection="row" height={1} overflow="hidden">
				<StateBadge label={claudeLabel} installed={skill.claudeInjected} />
				<text fg={colors.muted}>{'  '}</text>
				<StateBadge label={AGENT_CONTEXT_LABELS.cx} installed={skill.codexAvailable} />
			</box>
			{warning ? <text fg={colors.warning}>{warning}</text> : null}
		</box>
	);
}

function storageWarning(skill: SkillSharedRow): string | undefined {
	switch (skill.storage?.kind) {
		case 'shared-copy':
			return '部分完成：Claude Code 使用独立副本，可在管理安装中重试共享链接';
		case 'invalid-link':
		case 'conflict':
		case 'invalid':
			return skill.storage.error ?? 'Skill 存储状态异常，自动操作已阻止';
		default:
			return undefined;
	}
}

function StateBadge({label, installed}: {readonly label: string; readonly installed: boolean}) {
	return (
		<text fg={installed ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${installed ? '●' : '○'} ${label}`}
		</text>
	);
}
