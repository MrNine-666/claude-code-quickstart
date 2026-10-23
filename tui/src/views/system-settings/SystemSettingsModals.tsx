import {TextAttributes} from '@opentui/core';
import {useRenderer} from '@opentui/react';
import {Checkbox, Modal, ScrollList, SingleLineInput, TextField} from '../../components/index.js';
import {TRANSFER_EXECUTION_ORDER} from '../../core/config-transfer.js';
import {piPackageOutcomeMessage} from '../../core/config-transfer-pi-packages.js';
import type {ConfigTransferApplyOutcome} from '../../core/config-transfer-plan.js';
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
	type SystemSettingsImportModal as SystemSettingsImportModalState,
	type SystemSettingsPathInput
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

export type SystemSettingsPathInputModalProps = {
	readonly active: boolean;
	readonly pathInput: SystemSettingsPathInput;
	readonly onChange: (value: string) => void;
	readonly onSubmit: (value: string) => void;
};

/** 系统文件对话框不可用时的手动路径输入；校验错误留在弹窗内。 */
export function SystemSettingsPathInputModal({active, pathInput, onChange, onSubmit}: SystemSettingsPathInputModalProps) {
	const renderer = useRenderer();
	const exporting = pathInput.kind === 'export';
	return (
		<Modal
			active={active}
			title={exporting ? '导出到路径' : '从路径导入'}
			hint={systemSettingsHint('path-input')}
			width={Math.min(EXPORT_MODAL_WIDTH, Math.max(24, renderer.width - 2))}
		>
			<box flexDirection="column">
				<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
					{exporting
						? '系统文件对话框不可用：输入导出包保存路径（支持 ~，目标已存在时不会覆盖）'
						: '系统文件对话框不可用：输入要导入的 .ccq-backup 文件路径（支持 ~）'}
				</text>
				<SingleLineInput
					label="路径"
					value={pathInput.value}
					focused={active}
					placeholder="~/ccq-config.ccq-backup"
					onChange={onChange}
					onSubmit={onSubmit}
				/>
				{pathInput.error ? (
					<text fg={colors.danger} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
						{pathInput.error}
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
			const selected = actionCounts.merge + actionCounts.replace;
			return treeRowItem(row, focused, {
				checked: selected > 0 && selected === toolItems.filter(item => item.status !== 'blocked').length,
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
					阻断分类只能跳过；合并不删除本机多余内容；MCP 只能按 id 整体覆盖或跳过
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
	const identities = replacements.flatMap(item => {
		const label = systemSettingsCategoryLabel(item.tool, item.category);
		// MCP 覆盖不删除包外 id，危险在于整体替换同 id 并清除包未携带的本机凭据。
		const replaced = item.mergeUnavailable ? (item.replace?.identities.replaced ?? []) : [];
		return [
			...(item.replace?.identities.removed ?? []).map(identity => `${label}：删除 ${identity}`),
			...replaced.map(identity => `${label}：整体覆盖 ${identity}`),
			...(item.mergeUnavailable ? (item.replace?.warnings ?? []) : []).map(warning => `${label}：${warning}`)
		];
	});

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
					覆盖会删除包内不存在的受管条目；MCP 只整体替换包内 id（包未携带的本机凭据会被清除），不删除包外
					id。未选分类与登录态不受影响。
				</text>
				<text fg={colors.danger}>{`将覆盖 ${replacements.length} 个分类，删除 ${removed} 个条目。`}</text>
				<box flexGrow={1} minHeight={0} marginTop={1} overflow="hidden">
					<ScrollList
						items={
							identities.length
								? identities.map(identity => ({key: identity, title: `  ${identity}`}))
								: [{key: 'none', title: '  无需删除或覆盖条目'}]
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

export type SystemSettingsImportResultEntry = {
	readonly key: string;
	readonly title: string;
	readonly status: string;
	readonly color: string;
	readonly details: readonly string[];
};

/** 导入结果明细：按执行顺序列出每个分类的落地状态，再附 Pi packages 与汇总提示。 */
export function systemSettingsImportResultEntries(outcome: ConfigTransferApplyOutcome): readonly SystemSettingsImportResultEntry[] {
	const keyOf = (item: {readonly tool: string; readonly category: string}): string => `${item.tool}:${item.category}`;
	const completed = new Set(outcome.completed.map(keyOf));
	const skipped = new Set(outcome.skipped.map(keyOf));
	const notExecuted = new Set(outcome.notExecuted.map(keyOf));
	const failed = new Map(outcome.failed.map(item => [keyOf(item), item]));
	const blocked = new Map(outcome.blocked.map(item => [keyOf(item), item]));
	const entries: SystemSettingsImportResultEntry[] = [];
	for (const identity of TRANSFER_EXECUTION_ORDER) {
		const key = keyOf(identity);
		const title = `${systemSettingsToolLabel(identity.tool)} · ${systemSettingsCategoryLabel(identity.tool, identity.category)}`;
		const failure = failed.get(key);
		const block = blocked.get(key);
		if (failure) {
			const restored = failure.restored ? '已恢复导入前文件' : '恢复未确认，请检查本机文件';
			entries.push({key, title, status: '失败', color: colors.danger, details: [failure.error, restored]});
		} else if (block) entries.push({key, title, status: '未导入', color: colors.danger, details: [block.reason]});
		else if (completed.has(key)) entries.push({key, title, status: '已导入', color: colors.success, details: []});
		else if (notExecuted.has(key)) entries.push({key, title, status: '未执行', color: colors.warning, details: []});
		else if (skipped.has(key)) entries.push({key, title, status: '已跳过', color: colors.muted, details: []});
	}

	const packages = outcome.packages;
	if (packages && (packages.completed.length || packages.failed.length || packages.notExecuted.length)) {
		const color = packages.failed.length || packages.notExecuted.length ? colors.warning : colors.success;
		entries.push({key: 'packages', title: 'Pi packages', status: '', color, details: [piPackageOutcomeMessage(packages)]});
	}

	if (outcome.warnings.length > 0) {
		entries.push({key: 'warnings', title: '提示', status: '', color: colors.warning, details: [...new Set(outcome.warnings)]});
	}

	return entries;
}

export type SystemSettingsImportResultModalProps = {
	readonly active: boolean;
	readonly outcome: ConfigTransferApplyOutcome;
	readonly entries: readonly SystemSettingsImportResultEntry[];
	readonly cursor: number;
};

export function SystemSettingsImportResultModal({active, outcome, entries, cursor}: SystemSettingsImportResultModalProps) {
	const renderer = useRenderer();
	const title = outcome.cancelled
		? '导入已取消'
		: outcome.status === 'complete'
			? '导入完成'
			: outcome.status === 'partial'
				? '导入部分完成'
				: '导入失败';
	const skipped = outcome.skipped.length - outcome.blocked.length;
	const items = entries.map(entry => ({
		key: entry.key,
		title: `  ${entry.title}`,
		titleColor: entry.status ? colors.text : entry.color,
		titleRight: entry.status ? <text fg={entry.color}>{entry.status}</text> : undefined,
		...(entry.details.length
			? {
					body: (
						<box flexDirection="column">
							{entry.details.map((detail, i) => (
								<text
									key={i}
									fg={entry.status ? entry.color : colors.muted}
									selectionBg={colors.selectionBg}
									selectionFg={colors.selectionFg}
									wrapMode="word"
								>
									{`    ${detail}`}
								</text>
							))}
						</box>
					),
					multiLine: true
				}
			: {}),
		bordered: false
	}));

	return (
		<Modal
			active={active}
			title={title}
			hint={systemSettingsHint('import-result')}
			tone={outcome.status === 'complete' ? 'default' : outcome.status === 'partial' ? 'warning' : 'danger'}
			width={Math.min(IMPORT_MODAL_WIDTH, Math.max(24, renderer.width - 2))}
			height={IMPORT_MODAL_HEIGHT}
		>
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<text fg={colors.text} flexShrink={0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{`已导入 ${outcome.completed.length} · 跳过 ${skipped} · 未导入 ${outcome.blocked.length} · 失败 ${outcome.failed.length} · 未执行 ${outcome.notExecuted.length} 个分类`}
				</text>
				<box flexGrow={1} minHeight={0} flexDirection="column" marginTop={1} overflow="hidden">
					<ScrollList items={items} cursor={cursor} active={active} showPosition={false} />
				</box>
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
