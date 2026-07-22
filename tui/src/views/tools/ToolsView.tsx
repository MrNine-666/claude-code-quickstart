import React, {useCallback, useEffect, useMemo, useReducer, useRef} from 'react';
import {useKeyboard} from '@opentui/react';
import {toast, type BusyOverlayState} from '../../components/index.js';
import type {DetectionState} from '../../services/async-detection.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import {useTaskCancellation} from '../../hooks/use-task-cancellation.js';
import {createInitialToolsViewState, reduceToolsViewState, computeColumns, type ToolsViewAction} from '../../state/tools-view-state.js';
import {
	projectToolsComponentsAction,
	createToolsBusyOverlayState,
	isToolsInjectable,
	openCurrentDocsAction,
	runPrimaryAction,
	updateAll,
	updateInjectableCurrent,
	applyInjectDraft,
	runUninstall
} from './tools-view-actions.js';
import {resolveToolsGridIntent, resolveToolsInjectIntent} from './tools-view-input.js';
import {ToolsHomeView, toolCardId} from './ToolsHomeView.js';
import {ToolsInjectTargetModal, ToolsUninstallConfirm} from './ToolsModals.js';
import type {ManagedComponent, ToolsViewProps} from './tools-view-types.js';

export type {ToolsViewProps} from './tools-view-types.js';
export type {InjectChangesResult, ToolsViewServices, UninstallOptions} from './tools-view-types.js';
export {
	applyInjectDraft,
	groupToolsForHome,
	injectChangesAction,
	runInjectChanges,
	settleBatchUpdateComponents,
	successfulInstallPatch,
	successfulUpdatePatch,
	toolStatusDot,
	uninstallSuccessPatch
} from './tools-view-actions.js';

type Dispatch = React.Dispatch<ToolsViewAction>;

export function ToolsView({services, cache, active = true, contentWidth, onSubModeChange, onBusyStateChange, onExitToNav}: ToolsViewProps) {
	const [view, dispatch] = useReducer(reduceToolsViewState, undefined, createInitialToolsViewState);
	const detection = cache.state;
	const taskCancellation = useTaskCancellation();
	const columns = useMemo(() => computeColumns(contentWidth ?? 52), [contentWidth]);
	const scrollRef = useRef<import('@opentui/core').ScrollBoxRenderable>(null);

	const cancelBusyTask = useCallback(() => {
		if (!taskCancellation.cancel()) return;
		dispatch({type: 'cancel-busy'});
		toast.info('已取消任务，正在刷新状态');
		cache.refresh({forceRefresh: true});
	}, [cache, taskCancellation]);

	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({type: 'components-loaded', components: projectToolsComponentsAction(detection.result ?? [])});
		}
		if (detection.status === 'error') {
			dispatch({type: 'detection-error', error: detection.error ?? '检测失败'});
		}
	}, [detection.error, detection.result, detection.status]);

	useEffect(() => {
		if (detection.status === 'error') toast.error('检测失败，可按 r 重试', 6000);
	}, [detection.status]);

	const cursorCard = view.components[view.cursor];
	const activeCardId = cursorCard ? toolCardId(cursorCard, view.cursor) : null;
	const busyOverlayState = useMemo(() => createToolsBusyOverlayState(view, cancelBusyTask), [cancelBusyTask, view]);
	const cursorInjectable = cursorCard ? isToolsInjectable(cursorCard.id) : false;

	useEffect(() => {
		if (!active) return;
		const subMode =
			view.mode === 'busy'
				? 'busy'
				: view.mode === 'confirm-uninstall'
					? 'confirm-uninstall'
					: view.mode === 'select-inject-target'
						? 'select-inject-target'
						: cursorInjectable
							? 'grid-inject'
							: 'grid';
		onSubModeChange?.(subMode);
	}, [active, cursorInjectable, onSubModeChange, view.mode]);

	useEffect(() => {
		onBusyStateChange?.(busyOverlayState);
	}, [busyOverlayState, onBusyStateChange]);

	useEffect(() => () => onBusyStateChange?.(null), [onBusyStateChange]);

	useEffect(() => {
		if (scrollRef.current && activeCardId) scrollRef.current.scrollChildIntoView(activeCardId);
	}, [activeCardId]);

	useKeyboard(keyEvent => {
		if (!active) return;
		const key = keyEvent.name;
		if (view.mode === 'confirm-uninstall' || view.mode === 'busy') return;
		if (view.mode === 'select-inject-target') {
			const intent = resolveToolsInjectIntent(key);
			switch (intent.kind) {
				case 'nav':
					dispatch({type: 'inject-target-nav', delta: intent.delta});
					break;
				case 'toggle':
					dispatch({type: 'inject-target-toggle'});
					break;
				case 'cancel':
					dispatch({type: 'cancel'});
					break;
				case 'apply':
					applyInjectDraft(view, services, dispatch, cache, taskCancellation);
					break;
			}
			return;
		}

		const intent = resolveToolsGridIntent(key, view, columns);
		switch (intent.kind) {
			case 'exit':
				onExitToNav?.();
				break;
			case 'nav':
				dispatch({type: 'nav', delta: intent.delta});
				break;
			case 'primary':
				runPrimaryAction(view, services, dispatch, cache, taskCancellation);
				break;
			case 'update-one':
				updateInjectableCurrent(view, services, dispatch, cache, taskCancellation);
				break;
			case 'update-all':
				updateAll(view, services, dispatch, cache, taskCancellation);
				break;
			case 'request-uninstall':
				dispatch({type: 'request-uninstall'});
				break;
			case 'refresh':
				cache.refresh({forceRefresh: true});
				break;
			case 'open-docs':
				openCurrentDocsAction(view);
				break;
		}
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<ToolsHomeView
				view={view}
				detectionStatus={detection.status as DetectionState<ManagedComponent[]>['status']}
				scrollRef={scrollRef}
				active={active && view.mode === 'grid'}
			/>
			{view.mode === 'confirm-uninstall' ? (
				<ToolsUninstallConfirm
					view={view}
					active={active}
					onCancel={() => dispatch({type: 'cancel'})}
					onConfirm={(component, fullUninstall) =>
						runUninstall(component, services, dispatch, cache, fullUninstall, taskCancellation)
					}
				/>
			) : null}
			{view.mode === 'select-inject-target' ? <ToolsInjectTargetModal view={view} /> : null}
		</box>
	);
}
