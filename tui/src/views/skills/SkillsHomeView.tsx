import React from 'react';
import {TextAttributes} from '@opentui/core';
import {Checkbox, ListEmptyState, RadioField, ScrollList, SingleLineInput} from '../../components/index.js';
import {isSafeHttpUrl} from '../../core/open-url.js';
import {itemAvailableOn} from '../../core/skills-installed.js';
import {AGENT_CONTEXT_LABELS} from '../../state/manage-state.js';
import {
	filteredInstalled,
	installedSourceLabel,
	skillsHomeRows,
	type SkillsHomeRow,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import {colors} from '../../theme/index.js';
import type {InstalledSkillItem, SkillsViewDispatch} from './skills-view-types.js';

const HOME_LAYOUT_OPTIONS = [
	{label: '平铺', value: 'flat'},
	{label: '分组', value: 'grouped'}
] as const;

export type SkillsHomeViewProps = {
	readonly view: SkillsViewState;
	readonly active: boolean;
	readonly dispatch: SkillsViewDispatch;
};

export function SkillsHomeView({view, active, dispatch}: SkillsHomeViewProps) {
	const filtered = filteredInstalled(view);
	const rows = skillsHomeRows(view);
	const picked = new Set(view.pickedInstalledIds);
	const items = rows.map((row, index) => homeListItem(row, index, view, picked, active));
	const summary = (
		<box flexDirection="row" flexShrink={0} justifyContent="space-between" paddingRight={2} marginBottom={0}>
			<RadioField label="布局：" value={view.homeLayout} options={HOME_LAYOUT_OPTIONS} focused={false} compact />
			<text fg={view.pickedInstalledIds.length > 0 ? colors.primary : colors.muted}>
				{`已选 ${view.pickedInstalledIds.length}`}
			</text>
		</box>
	);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<SingleLineInput
				label="过滤"
				value={view.filterText}
				focused={active && view.filterFocused}
				placeholder="输入关键词模糊筛选已装 skill"
				onChange={value => dispatch({type: 'filter-input', value})}
			/>
			{summary}
			{filtered.length === 0 ? (
				<ListEmptyState
					message={view.installed.length === 0 ? '暂无已安装 skill' : '没有匹配的已装 skill'}
					hint={view.installed.length === 0 ? {label: '进入安装页搜索安装', enabled: true} : undefined}
				/>
			) : (
				<box flexGrow={1} minHeight={0} flexDirection="column">
					<ScrollList items={items} cursor={view.installedIndex} active={active} focusIndicator="leading" />
				</box>
			)}
		</box>
	);
}

function homeListItem(
	row: SkillsHomeRow,
	index: number,
	view: SkillsViewState,
	picked: ReadonlySet<string>,
	active: boolean
) {
	const focused = active && index === view.installedIndex;
	if (row.kind === 'group') {
		const collapsed = view.collapsedSourceKeys.includes(row.group.key);
		const selectedCount = row.group.items.filter(item => picked.has(item.id)).length;
		return {
			key: row.key,
			title: row.group.label,
			titleColor: focused ? colors.primary : colors.text,
			titleAttrs: TextAttributes.BOLD,
				titleRight: (
				<text fg={selectedCount > 0 ? colors.primary : colors.muted}>
					{selectedCount > 0 ? `${selectedCount}/${row.group.items.length} 已选` : `${row.group.items.length} 项`}
				</text>
				),
				leading: <text fg={focused ? colors.primary : colors.muted}>{collapsed ? '▸' : '▾'}</text>,
				bordered: false
		};
	}

	const selected = picked.has(row.item.id);
	return {
		key: row.key,
		title: view.homeLayout === 'flat' ? `${row.item.name}（${installedSourceLabel(row.item)}）` : row.item.name,
		titleColor: focused ? colors.primary : colors.text,
		titleAttrs: TextAttributes.BOLD,
		leading: <Checkbox checked={selected} focused={focused} />,
		body: <InstalledSkillBody skill={row.item} />,
		multiLine: true
	};
}

function InstalledSkillBody({skill}: {readonly skill: InstalledSkillItem}) {
	return (
		<box flexDirection="column">
			<SourceUrlRow skill={skill} />
			<box flexDirection="row" height={1} overflow="hidden">
				<StateBadge label={AGENT_CONTEXT_LABELS.cc} installed={itemAvailableOn(skill, 'cc')} />
				<text fg={colors.muted}>{'  '}</text>
				<StateBadge label={AGENT_CONTEXT_LABELS.cx} installed={itemAvailableOn(skill, 'cx')} />
			</box>
		</box>
	);
}

function SourceUrlRow({skill}: {readonly skill: InstalledSkillItem}) {
	const url = skill.provenance.kind === 'known' ? skill.provenance.sourceUrl : undefined;
	if (!url || !isSafeHttpUrl(url)) {
		return (
			<text fg={colors.muted} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				无来源链接
			</text>
		);
	}

	return (
		<text selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				<a href={url} fg={colors.muted} attributes={TextAttributes.DIM | TextAttributes.UNDERLINE}>
				{url}
			</a>
		</text>
	);
}

function StateBadge({label, installed}: {readonly label: string; readonly installed: boolean}) {
	return (
		<text fg={installed ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${installed ? '●' : '○'} ${label}`}
		</text>
	);
}
