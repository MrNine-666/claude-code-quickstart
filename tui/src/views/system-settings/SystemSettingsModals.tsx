import {TextAttributes} from '@opentui/core';
import {useRenderer} from '@opentui/react';
import {Checkbox, Modal, ScrollList, TextField} from '../../components/index.js';
import {
	bundleBasename,
	systemSettingsCategoryKey,
	systemSettingsCategoryLabel,
	systemSettingsDecisionOf,
	systemSettingsImportRows,
	systemSettingsItemCount,
	systemSettingsSelectedCategories,
	systemSettingsToolCategories,
	systemSettingsToolFullySelected,
	systemSettingsToolLabel,
	systemSettingsToolSelectedCount,
	systemSettingsVisibleRows,
	type SystemSettingsExportModal as SystemSettingsExportModalState,
	type SystemSettingsImportModal as SystemSettingsImportModalState
} from '../../state/system-settings-state.js';
import {colors} from '../../theme/index.js';
import {systemSettingsHint} from './system-settings-view-input.js';

// 导出明细 / 导入明细两个树形弹窗：只展示 identity/计数/basename，不展示凭据值与绝对路径。
// 弹窗期间背景页面失活；Enter 永远执行主操作，Esc 关闭返回。

const EXPORT_MODAL_WIDTH = 72;
const EXPORT_MODAL_HEIGHT = 18;
const IMPORT_MODAL_WIDTH = 68;
const IMPORT_MODAL_HEIGHT = 18;

export type SystemSettingsExportModalProps = {
	readonly active: boolean;
	readonly modal: SystemSettingsExportModalState;
	readonly encryption: boolean;
};

export function SystemSettingsExportModal({active, modal, encryption}: SystemSettingsExportModalProps) {
	const renderer = useRenderer();
	const rows = systemSettingsVisibleRows(modal.collapsed);
	const selectedCount = systemSettingsSelectedCategories(modal.selected).length;
	const items = rows.map((row, index) => {
		const focused = active && index === modal.cursor;
		// 只隐藏已知的常规排除；warning 也承载损坏/无法读取/无效凭据，未知问题默认保留。
		const warnings =
			row.kind === 'category'
				? (modal.summary.categories.find(item => item.tool === row.tool && item.category === row.category)?.warnings ?? []).filter(
						warning =>
							!/^已排除(?:本机绑定配置：|本机路径 Pi package（| OAuth 供应商：|认证\/会话文件$|指向认证\/会话文件的链接$|不受管或无文件的显式扩展入口$)|^已移除凭据字段：/u.test(
								warning
							)
					)
				: [];
		return {
			...treeRowItem(row, focused, {
				checked:
					row.kind === 'tool'
						? systemSettingsToolFullySelected(modal.selected, row.tool)
						: modal.selected.has(systemSettingsCategoryKey(row.tool, row.category)),
				titleRight:
					row.kind === 'tool'
						? `${systemSettingsToolSelectedCount(modal.selected, row.tool)}/${systemSettingsToolCategories(row.tool).length} 已选`
						: undefined,
				collapsed: modal.collapsed.has(row.tool)
			}),
			...(warnings.length
				? {
						body: (
							<box flexDirection="column">
								{warnings.map((warning, i) => (
									<text key={i} fg={colors.warning} wrapMode="word">
										{warning}
									</text>
								))}
							</box>
						),
						multiLine: true
					}
				: {})
		};
	});

	return (
		<Modal
			active={active}
			title="导出配置"
			hint={systemSettingsHint('export-modal')}
			width={Math.min(EXPORT_MODAL_WIDTH, Math.max(24, renderer.width - 2))}
			height={EXPORT_MODAL_HEIGHT}
		>
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<text fg={colors.text} flexShrink={0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{`已选 ${selectedCount} 个分类 · 条目 ${systemSettingsItemCount(modal.summary)} 条`}
				</text>
				<text fg={colors.muted} flexShrink={0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
					{encryption ? '导出包将使用密码加密写入' : '未选择加密：将生成明文导出包，可能包含 API Key/源码中的密钥'}
				</text>
				<box flexGrow={1} minHeight={0} flexDirection="column" marginTop={1} overflow="hidden">
					<ScrollList items={items} cursor={modal.cursor} active={active} showPosition={false} />
				</box>
				{modal.error ? (
					<text
						fg={colors.danger}
						flexShrink={0}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
						wrapMode="word"
					>
						{modal.error}
					</text>
				) : null}
			</box>
		</Modal>
	);
}

export type SystemSettingsImportModalProps = {
	readonly active: boolean;
	readonly modal: SystemSettingsImportModalState;
	readonly dispatch: (action: {readonly type: 'import-password-input'; readonly value: string}) => void;
};

export function SystemSettingsImportModal({active, modal, dispatch}: SystemSettingsImportModalProps) {
	const renderer = useRenderer();
	if (modal.kind === 'password') {
		return (
			<Modal
				active={active}
				title={`导入 · ${bundleBasename(modal.bundlePath)}`}
				hint={systemSettingsHint('import-password')}
				width={Math.min(IMPORT_MODAL_WIDTH, Math.max(24, renderer.width - 2))}
			>
				<box flexDirection="column">
					<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
						该导出包已加密，请输入密码后解析
					</text>
					<TextField
						label="密码"
						value={modal.password}
						secret
						active={active}
						focused={active}
						onChange={value => dispatch({type: 'import-password-input', value})}
						helpText="密码错误或包损坏会在此弹窗内提示"
					/>
					{modal.error ? (
						<text fg={colors.danger} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
							{modal.error}
						</text>
					) : null}
				</box>
			</Modal>
		);
	}

	if (modal.kind === 'confirm') {
		return <SystemSettingsImportConfirm active modal={modal} />;
	}

	return <SystemSettingsImportPreview active={active} modal={modal} />;
}

function SystemSettingsImportPreview({
	active,
	modal
}: {
	readonly active: boolean;
	readonly modal: Exclude<SystemSettingsImportModalState, {kind: 'password'}>;
}) {
	const renderer = useRenderer();
	const rows = systemSettingsImportRows(modal.summary.items, modal.collapsed);
	const actionCounts = modal.summary.items.reduce(
		(counts, item) => {
			if (item.status === 'blocked') return counts;
			counts[systemSettingsDecisionOf(modal.decisions, item)] += 1;
			return counts;
		},
		{merge: 0, replace: 0, skip: 0}
	);
	const items = rows.map((row, index) => {
		const focused = active && index === modal.cursor;
		if (row.kind === 'tool') {
			const toolItems = modal.summary.items.filter(item => item.tool === row.tool);
			const actionCounts = toolItems.reduce(
				(counts, item) => {
					if (item.status === 'blocked') return counts;
					counts[systemSettingsDecisionOf(modal.decisions, item)] += 1;
					return counts;
				},
				{merge: 0, replace: 0, skip: 0}
			);
			const allMerge = actionCounts.merge === toolItems.filter(item => item.status !== 'blocked').length && actionCounts.merge > 0;
			return treeRowItem(row, focused, {
				checked: allMerge,
				titleRight: `${actionCounts.merge}/${toolItems.length} 合并 · ${actionCounts.replace} 覆盖`,
				collapsed: modal.collapsed.has(row.tool)
			});
		}

		const item = modal.summary.items.find(
			candidate => systemSettingsCategoryKey(candidate.tool, candidate.category) === systemSettingsCategoryKey(row.tool, row.category)
		);
		const blocked = item?.status === 'blocked';
		const action = item ? systemSettingsDecisionOf(modal.decisions, item) : 'skip';
		return {
			key: row.key,
			title: `    ${systemSettingsCategoryLabel(row.tool, row.category)}`,
			titleColor: focused ? colors.primary : colors.text,
			titleRight: (
				<text
					fg={
						blocked ? colors.danger : action === 'replace' ? colors.warning : action === 'merge' ? colors.success : colors.muted
					}
				>
					{blocked ? '已阻断' : action === 'replace' ? '[覆盖]' : action === 'merge' ? '[合并]' : '[跳过]'}
				</text>
			),
			leading: <Checkbox checked={action !== 'skip' && !blocked} disabled={blocked} focused={focused} />,
			body: (
				<box flexDirection="column">
					<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						{`新增 ${item?.counts.added ?? 0} · 覆盖 ${item?.counts.replaced ?? 0} · 删除 ${item?.replace?.counts.removed ?? 0} · 跳过 ${item?.counts.unchanged ?? 0} · 阻断 ${item?.counts.blocked ?? 0}`}
					</text>
					{item?.reason ? (
						<text fg={colors.danger} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							{item.reason}
						</text>
					) : null}
					{item?.warnings.map((warning, i) => (
						<text key={i} fg={colors.warning} wrapMode="word">
							{warning}
						</text>
					))}
				</box>
			),
			multiLine: true,
			bordered: false
		};
	});

	return (
		<Modal
			active={active}
			title={`导入 · ${bundleBasename(modal.bundlePath)}`}
			hint={systemSettingsHint('import-preview')}
			width={Math.min(IMPORT_MODAL_WIDTH, Math.max(24, renderer.width - 2))}
			height={IMPORT_MODAL_HEIGHT}
		>
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<text fg={colors.text} flexShrink={0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{`合并 ${actionCounts.merge} · 覆盖 ${actionCounts.replace} · 跳过 ${actionCounts.skip} 个分类${modal.summary.containsCredentials ? ' · 含凭据' : ''}`}
				</text>
				<box flexGrow={1} minHeight={0} flexDirection="column" marginTop={1} overflow="hidden">
					<ScrollList items={items} cursor={modal.cursor} active={active} showPosition={false} />
				</box>
				<text fg={colors.muted} flexShrink={0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
					阻断分类只能跳过；合并不删除本机多余内容
				</text>
			</box>
		</Modal>
	);
}

function SystemSettingsImportConfirm({
	active,
	modal
}: {
	readonly active: boolean;
	readonly modal: Exclude<SystemSettingsImportModalState, {kind: 'password'}>;
}) {
	const renderer = useRenderer();
	const replacements = modal.summary.items.filter(
		item => item.status !== 'blocked' && systemSettingsDecisionOf(modal.decisions, item) === 'replace'
	);
	const removed = replacements.reduce((total, item) => total + (item.replace?.counts.removed ?? 0), 0);
	const identities = replacements.flatMap(item =>
		(item.replace?.identities.removed ?? []).map(identity => `${systemSettingsCategoryLabel(item.tool, item.category)}：${identity}`)
	);

	return (
		<Modal
			active={active}
			title="确认覆盖导入"
			hint={systemSettingsHint('import-confirm')}
			tone="danger"
			width={Math.min(IMPORT_MODAL_WIDTH, Math.max(24, renderer.width - 2))}
			height={IMPORT_MODAL_HEIGHT}
		>
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<text fg={colors.warning} wrapMode="word">
					覆盖会删除包内不存在的受管条目；未选分类、未知字段、凭据和登录态不受影响。
				</text>
				<text fg={colors.danger}>{`将覆盖 ${replacements.length} 个分类，删除 ${removed} 个条目。`}</text>
				<box flexGrow={1} minHeight={0} marginTop={1} overflow="hidden">
					<ScrollList
						items={
							identities.length
								? identities.map(identity => ({key: identity, title: `  ${identity}`}))
								: [{key: 'none', title: '  无需删除条目'}]
						}
						cursor={0}
						active={false}
						showPosition={false}
					/>
				</box>
				<text fg={colors.muted} wrapMode="word">
					Enter 确认覆盖并导入；Esc 返回分类明细。
				</text>
			</box>
		</Modal>
	);
}

type TreeRow = ReturnType<typeof systemSettingsVisibleRows>[number];

function treeRowItem(
	row: TreeRow,
	focused: boolean,
	options: {
		readonly checked: boolean;
		readonly titleRight?: string;
		readonly collapsed: boolean;
	}
) {
	if (row.kind === 'tool') {
		return {
			key: row.key,
			title: `${options.collapsed ? '▶' : '▼'} ${systemSettingsToolLabel(row.tool)}`,
			titleColor: focused ? colors.primary : colors.text,
			titleAttrs: TextAttributes.BOLD,
			titleRight: options.titleRight ? (
				<text fg={options.checked ? colors.primary : colors.muted}>{options.titleRight}</text>
			) : undefined,
			leading: <Checkbox checked={options.checked} focused={focused} />,
			bordered: false
		};
	}

	return {
		key: row.key,
		title: `    ${systemSettingsCategoryLabel(row.tool, row.category)}`,
		titleColor: focused ? colors.primary : colors.text,
		leading: <Checkbox checked={options.checked} focused={focused} />,
		bordered: false
	};
}
