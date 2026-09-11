import React, {useCallback, useEffect, useMemo, useReducer, useRef} from 'react';
import {TextAttributes, type ScrollBoxRenderable} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {
	Card,
	ListEmptyState,
	ListLoadingState,
	Modal,
	SingleLineInput,
	ThemedScrollbox,
	ViewHeader,
	toast,
	type BusyOverlayState
} from '../../components/index.js';
import {piPackageDetailsUrl, piResourceLabel, type PiExtensionPackage} from '../../core/extensions.js';
import {openExternalFile} from '../../core/open-file.js';
import {createExtensionsService, type ExtensionsService} from '../../services/extensions-service.js';
import {AGENT_CONTEXT_LABELS, type AgentContext} from '../../state/manage-state.js';
import {useTaskCancellation} from '../../hooks/use-task-cancellation.js';
import {
	createInitialExtensionsViewState,
	extensionsSubMode,
	isExtensionInstalled,
	reduceExtensionsViewState,
	visibleExtensions,
	type ExtensionsViewAction,
	type ExtensionsViewState,
	type PendingExtensionAction
} from '../../state/extensions-view-state.js';
import {colors} from '../../theme/index.js';
import {handleExtensionsKey} from './extensions-view-input.js';

export type ExtensionsViewProps = {
	readonly active: boolean;
	readonly agentContext: AgentContext;
	readonly contentWidth: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange: (state: BusyOverlayState | null) => void;
	readonly onExitToNav: () => void;
};

export function ExtensionsView({active, agentContext, contentWidth, onSubModeChange, onBusyStateChange, onExitToNav}: ExtensionsViewProps) {
	const service = useMemo(() => createExtensionsService(), []);
	const isPi = agentContext === 'pi';
	const [view, dispatch] = useReducer(reduceExtensionsViewState, undefined, createInitialExtensionsViewState);
	const requestId = useRef(0);
	const taskCancellation = useTaskCancellation();

	const reloadInstalled = useCallback(
		async (query: string, page: number): Promise<void> => {
			const currentRequest = ++requestId.current;
			try {
				const installed = await service.loadInstalled();
				if (currentRequest !== requestId.current) return;
				dispatch({type: 'installed-loaded', items: installed});
				if (!query) return;

				dispatch({type: 'search-start', page});
				const result = await service.search(query, page);
				if (currentRequest !== requestId.current) return;
				dispatch({type: 'search-done', result});
			} catch (reason) {
				if (currentRequest !== requestId.current) return;
				const detail = errorMessage(reason);
				console.error(`[extensions] ${query ? '搜索' : '读取已安装包'}失败`, detail);
				dispatch({type: query ? 'search-failed' : 'installed-failed', error: detail});
				toast.error(`${query ? '扩展搜索' : '扩展读取'}失败，请查看控制台`);
			}
		},
		[service]
	);

	const search = useCallback(
		(page: number, submittedQuery?: string): void => {
			const query = (submittedQuery ?? view.query).trim();
			if (!query) {
				dispatch({type: 'focus-grid'});
				return;
			}
			const currentRequest = ++requestId.current;
			dispatch({type: 'search-start', page});
			void service.search(query, page).then(
				result => {
					if (currentRequest === requestId.current) dispatch({type: 'search-done', result});
				},
				reason => {
					if (currentRequest !== requestId.current) return;
					const detail = errorMessage(reason);
					console.error('[extensions] 搜索失败', detail);
					dispatch({type: 'search-failed', error: detail});
					toast.error('扩展搜索失败，请查看控制台');
				}
			);
		},
		[service, view.query]
	);
	const focusSearch = useCallback((): void => {
		dispatch({type: 'focus-search'});
	}, []);

	useEffect(() => {
		if (!isPi) {
			taskCancellation.cancel();
			onBusyStateChange(null);
			requestId.current += 1;
			return;
		}
		void reloadInstalled('', 0);
	}, [isPi, onBusyStateChange, reloadInstalled, taskCancellation]);

	useEffect(() => () => onBusyStateChange(null), [onBusyStateChange]);

	useEffect(() => {
		if (active) onSubModeChange?.(isPi ? extensionsSubMode(view) : 'empty');
	}, [active, isPi, onSubModeChange, view]);

	useKeyboard(keyEvent => {
		if (!active) return;
		if (!isPi) {
			if (keyEvent.name.toLowerCase() === 'escape') {
				keyEvent.preventDefault?.();
				onExitToNav();
			}
			return;
		}
		handleExtensionsKey(
			keyEvent,
			view,
			{
				dispatch,
				onSearch: search,
				onOpenExternal: item => {
					const url = extensionDetailsUrl(item);
					void openExternalFile(url)
						.then(result => {
							if (result.ok) {
								toast.info('已打开扩展详情');
								return;
							}
							console.error(`[extensions] 打开详情失败 ${url}`, result.error);
							toast.error('打开扩展详情失败，请查看控制台');
						})
						.catch(reason => {
							console.error(`[extensions] 打开详情失败 ${url}`, reason);
							toast.error('打开扩展详情失败，请查看控制台');
						});
				},
				onOpenConfirm: action => dispatch({type: 'open-confirm', action}),
				onRunConfirm: action => {
					const signal = taskCancellation.start();
					if (!signal) return;
					dispatch({type: 'mutation-start'});
					onBusyStateChange({
						title: extensionBusyTitle(action),
						message: extensionCommand(action),
						onCancel: () => {
							if (!taskCancellation.cancel()) return;
							dispatch({type: 'cancel-confirm'});
							toast.info('已取消扩展操作');
						}
					});
					void runConfirmed(service, action, dispatch, reloadInstalled, view.query.trim(), view.page, signal).finally(() => {
						taskCancellation.finish(signal);
						onBusyStateChange(null);
					});
				},
				onExitToNav
			},
			view.installed
		);
	});

	if (!isPi) {
		return (
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<ViewHeader title="扩展管理" subtitle="扩展管理当前仅适用于 Pi" />
				<ListEmptyState message={`${AGENT_CONTEXT_LABELS[agentContext]} 当前没有可管理的扩展`} />
			</box>
		);
	}

	const items = visibleExtensions(view);
	const gridWidth = Math.max(contentWidth, 49);
	const cardWidth = Math.max(24, Math.floor((gridWidth - 1) / 2));
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="扩展管理" subtitle="仅管理 Pi 扩展；搜索框 Enter 后查询官方 Pi package 商店" />
			<SingleLineInput
				label="搜索"
				value={view.query}
				focused={active && view.focus === 'search' && view.mode !== 'confirm'}
				placeholder="输入关键词，按 Enter 搜索 Pi 官方扩展商店"
				onChange={value => dispatch({type: 'query-input', value})}
				onFocus={focusSearch}
				onSubmit={value => {
					dispatch({type: 'query-input', value});
					search(0, value);
				}}
			/>
			{view.loading ? <ListLoadingState message="正在读取已安装的 Pi 扩展..." /> : null}
			{!view.loading && view.searching ? <ListLoadingState message="正在查询 Pi 官方扩展商店..." /> : null}
			{!view.loading && !view.searching && items.length > 0 ? (
				<ExtensionGrid
					items={items}
					installed={view.installed}
					cursor={view.cursor}
					active={active && view.focus === 'grid' && view.mode !== 'confirm'}
					cardWidth={cardWidth}
					page={view.query.trim() ? view.page : undefined}
					total={view.query.trim() ? view.total : undefined}
				/>
			) : null}
			{!view.loading && !view.searching && items.length === 0 ? (
				<ListEmptyState message={view.query.trim() ? '未找到包含 Pi extension 的 package' : '暂无已安装的 Pi 扩展'} />
			) : null}
			{view.mode === 'confirm' && view.pendingAction && !view.mutating ? <ExtensionConfirmModal view={view} /> : null}
		</box>
	);
}

function ExtensionGrid({
	items,
	installed,
	cursor,
	active,
	cardWidth,
	page,
	total
}: {
	readonly items: readonly PiExtensionPackage[];
	readonly installed: readonly PiExtensionPackage[];
	readonly cursor: number;
	readonly active: boolean;
	readonly cardWidth: number;
	readonly page?: number;
	readonly total?: number;
}) {
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const selectedId = items[cursor] ? extensionCardId(items[cursor]!, cursor) : undefined;
	useEffect(() => {
		if (selectedId) scrollRef.current?.scrollChildIntoView(selectedId);
	}, [selectedId]);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			{page === undefined || total === undefined ? null : (
				<text flexShrink={0} fg={colors.muted}>
					{`第 ${page + 1} 页 · 共 ${total} 个目录结果（PageUp/PageDown 翻页）`}
				</text>
			)}
			<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, minHeight: 0}} viewportCulling scrollY scrollX={false}>
				<box flexDirection="row" flexWrap="wrap" width="100%" flexGrow={1} minWidth={0}>
					{items.map((item, index) => (
						<box
							key={`${item.source}:${item.name}`}
							id={extensionCardId(item, index)}
							width={cardWidth}
							marginRight={index % 2 === 0 ? 1 : 0}
							flexShrink={0}
						>
							<ExtensionCard
								item={item}
								installed={isExtensionInstalled(item, installed)}
								focused={active && index === cursor}
								width={cardWidth}
							/>
						</box>
					))}
				</box>
			</ThemedScrollbox>
		</box>
	);
}

export function ExtensionCard({
	item,
	installed,
	focused,
	width
}: {
	readonly item: PiExtensionPackage;
	readonly installed: boolean;
	readonly focused: boolean;
	readonly width: number;
}) {
	return (
		<Card
			title={item.name}
			titleRight={<text fg={installed ? colors.success : colors.muted}>{installed ? '● 已安装' : '○ 未安装'}</text>}
			focused={focused}
			width={width}
			multiLine
		>
			<box flexDirection="column" height={5} maxHeight={5} overflow="hidden">
				<box height={3} maxHeight={3} overflow="hidden" flexShrink={0}>
					<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="word">
						{item.description || '无描述'}
					</text>
				</box>
				<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="none" truncate>
					<span fg={colors.primary}>{item.author || '未知作者'}</span>
					<span fg={colors.muted}>{' · '}</span>
					<span fg={colors.success}>{`${formatMonthlyDownloads(item.monthlyDownloads)}/月`}</span>
					<span fg={colors.muted}>{' · '}</span>
					<span fg={colors.muted} attributes={TextAttributes.DIM}>
						{formatPublishedAge(item.publishedAt)}
					</span>
				</text>
				<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} wrapMode="none" truncate>
					<span fg={colors.warning}>{piResourceLabel(item.resourceTypes)}</span>
					{item.version ? (
						<>
							<span fg={colors.muted}>{' · '}</span>
							<span fg={colors.primaryBright}>{`v${item.version}`}</span>
						</>
					) : null}
				</text>
			</box>
		</Card>
	);
}

function ExtensionConfirmModal({view}: {readonly view: ExtensionsViewState}) {
	const action = view.pendingAction!;
	const actionLabel = extensionActionLabel(action);
	const command = extensionCommand(action);
	return (
		<Modal
			active
			title={`${actionLabel} Pi 扩展`}
			hint={view.mutating ? '正在执行...' : 'Enter 确认  Esc 取消'}
			tone={action.kind === 'remove' ? 'danger' : 'default'}
			width={68}
		>
			<text fg={colors.text}>{`即将执行 ${command}`}</text>
		</Modal>
	);
}

async function runConfirmed(
	service: ExtensionsService,
	action: PendingExtensionAction,
	dispatch: React.Dispatch<ExtensionsViewAction>,
	reloadInstalled: (query: string, page: number) => Promise<void>,
	query: string,
	page: number,
	signal: AbortSignal
): Promise<void> {
	try {
		if (action.kind === 'install') {
			const result = await service.install(action.source, signal);
			if (signal.aborted) return;
			if (!result.ok) throw new Error(result.error);
		} else if (action.kind === 'update') {
			await service.update(action.source, signal);
		} else if (action.kind === 'update-all') {
			for (const target of action.targets) {
				if (signal.aborted) return;
				await service.update(target.source, signal);
			}
		} else {
			await service.remove(action.source, signal);
		}
		if (signal.aborted) return;
		dispatch({type: 'mutation-done'});
		toast.success(extensionSuccessMessage(action));
		await reloadInstalled(query, page);
	} catch (reason) {
		if (signal.aborted) return;
		const message = errorMessage(reason);
		console.error(`[extensions] ${extensionDiagnosticSubject(action)} 失败`, message);
		dispatch({type: 'mutation-failed', error: message});
		toast.error(`${extensionToastSubject(action)} ${extensionActionLabel(action)}失败，请查看控制台`);
	}
}

function extensionActionLabel(action: PendingExtensionAction): string {
	return action.kind === 'remove' ? '卸载' : action.kind === 'update' ? '更新' : action.kind === 'update-all' ? '全部更新' : '安装';
}

function extensionBusyTitle(action: PendingExtensionAction): string {
	return action.kind === 'update-all'
		? `正在更新 ${action.targets.length} 个 Pi 扩展`
		: `${action.name} 正在${extensionActionLabel(action)}`;
}

function extensionCommand(action: PendingExtensionAction): string {
	if (action.kind === 'update-all') {
		return `pi update --extension <每个已安装扩展>（共 ${action.targets.length} 个）`;
	}
	const source = action.source.startsWith('npm:') ? action.source : `npm:${action.source}`;
	return action.kind === 'install'
		? `pi install ${source}`
		: action.kind === 'update'
			? `pi update --extension ${action.source}`
			: `pi remove ${action.source.replace(/^npm:/, '')}`;
}

function extensionSuccessMessage(action: PendingExtensionAction): string {
	return action.kind === 'update-all' ? `已更新 ${action.targets.length} 个 Pi 扩展` : `${action.name} 已${extensionActionLabel(action)}`;
}

function extensionToastSubject(action: PendingExtensionAction): string {
	return action.kind === 'update-all' ? `${action.targets.length} 个 Pi 扩展` : action.name;
}

function extensionDiagnosticSubject(action: PendingExtensionAction): string {
	return action.kind === 'update-all'
		? `update-all ${action.targets.map(target => target.source).join(', ')}`
		: `${action.kind} ${action.source}`;
}

function extensionCardId(item: PiExtensionPackage, index: number): string {
	return `extensions-grid-item-${index}-${item.name}`;
}

function extensionDetailsUrl(item: PiExtensionPackage): string {
	if (item.catalogListed) return piPackageDetailsUrl(item.name);
	return /^https?:\/\//i.test(item.repository) ? item.repository : item.npmUrl;
}

function formatMonthlyDownloads(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return '未知';
	if (value >= 1_000_000) return `${formatCompactNumber(value / 1_000_000)}M`;
	if (value >= 1_000) return `${formatCompactNumber(value / 1_000)}K`;
	return String(Math.max(0, Math.floor(value)));
}

function formatCompactNumber(value: number): string {
	return value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, '');
}

function formatPublishedAge(value: string | undefined): string {
	const timestamp = parsePublishedAt(value);
	if (timestamp === undefined) return '发布时间未知';
	const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
	if (days === 0) return '今天发布';
	if (days < 30) return `${days}天前发布`;
	if (days < 365) return `${Math.floor(days / 30)}个月前发布`;
	return `${Math.floor(days / 365)}年前发布`;
}

function parsePublishedAt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function errorMessage(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}
