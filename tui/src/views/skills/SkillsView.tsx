import React, {useCallback, useEffect, useMemo, useReducer} from 'react';
import {useKeyboard} from '@opentui/react';
import {ErrorPanel, ListLoadingState, ViewHeader, toast} from '../../components/index.js';
import type {DetectionState} from '../../services/async-detection.js';
import {useTaskCancellation} from '../../hooks/use-task-cancellation.js';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	type SkillsViewAction,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import {handleSkillsKey} from './skills-view-input.js';
import {createSkillsBusyOverlayState, skillsPageOf} from './skills-view-actions.js';
import {SkillsHomeView} from './SkillsHomeView.js';
import {SkillsInstallView} from './SkillsInstallView.js';
import {
	SkillsInstallTargetModal,
	SkillsSourceReplacementConfirmModal,
	SkillsTopologyConfirmModal,
	SkillsUninstallConfirm,
	skillsModalOpen
} from './SkillsModals.js';
import type {SkillsDetection, SkillsViewProps} from './skills-view-types.js';

export type {SkillsViewProps} from './skills-view-types.js';
export type {SkillsViewServices} from './skills-view-types.js';

export function skillsSubModeOf(view: Pick<SkillsViewState, 'mode' | 'homeLayout' | 'busyAction'>): string {
	if (view.busyAction) return 'busy';
	return view.mode === 'list' ? `list-${view.homeLayout}` : view.mode;
}

export function SkillsView({services, cache, active = true, onSubModeChange, onBusyStateChange, onExitToNav}: SkillsViewProps) {
	const [view, dispatch] = useReducer(reduceSkillsViewState, undefined, createInitialSkillsViewState);
	const detection = cache.state;
	const taskCancellation = useTaskCancellation();
	const subMode = skillsSubModeOf(view);
	const cancelBusyTask = useCallback(() => {
		if (!taskCancellation.cancel()) return;
		dispatch({type: 'cancel-busy'});
		toast.info('已取消任务，正在刷新状态');
		cache.refresh();
	}, [cache, taskCancellation]);
	const busyOverlayState = useMemo(() => createSkillsBusyOverlayState(view, cancelBusyTask), [cancelBusyTask, view]);

	useEffect(() => {
		if (detection.status === 'success') dispatch({type: 'installed-loaded', installed: detection.result ?? []});
	}, [detection.result, detection.status]);

	useEffect(() => {
		if (active) onSubModeChange?.(subMode);
	}, [active, onSubModeChange, subMode]);

	useEffect(() => {
		onBusyStateChange?.(busyOverlayState);
	}, [busyOverlayState, onBusyStateChange]);

	useEffect(() => () => onBusyStateChange?.(null), [onBusyStateChange]);

	useKeyboard(keyEvent => {
		if (!active) return;
		handleSkillsKey(keyEvent, view, dispatch, services, cache, onExitToNav, taskCancellation);
	});

	const pageActive = active && !skillsModalOpen(view.mode);
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="Skills 技能管理" subtitle="共享维护 Claude Code 与 Codex 两侧的 Skills（搜索、安装、更新、卸载）" />
			{renderDetectionNotice(detection)}
			{renderPage(view, detection, pageActive, dispatch)}
			{view.errorText ? (
				<box marginTop={1}>
					<ErrorPanel message={view.errorText} />
				</box>
			) : null}
			{view.mode === 'select-install-target' || view.mode === 'manage-inject' ? <SkillsInstallTargetModal view={view} /> : null}
			{view.mode === 'confirm-topology-change' ? <SkillsTopologyConfirmModal view={view} /> : null}
			{view.mode === 'confirm-source-replacement' ? <SkillsSourceReplacementConfirmModal view={view} /> : null}
			{view.mode === 'confirm-uninstall' ? <SkillsUninstallConfirm view={view} /> : null}
		</box>
	);
}

function renderDetectionNotice(detection: DetectionState<SkillsDetection>): React.ReactNode {
	if (detection.status === 'idle' || detection.status === 'loading') return <ListLoadingState message="检测中..." />;
	if (detection.status === 'error')
		return (
			<box marginBottom={1}>
				<ErrorPanel title="检测失败" message={detection.error ?? '无法检测已安装 skill'} />
			</box>
		);
	return null;
}

function renderPage(
	view: SkillsViewState,
	detection: DetectionState<SkillsDetection>,
	active: boolean,
	dispatch: React.Dispatch<SkillsViewAction>
): React.ReactNode {
	if (skillsPageOf(view.mode, view.busyReturnMode) === 'install')
		return <SkillsInstallView view={view} detection={detection} active={active} dispatch={dispatch} />;
	if (detection.status === 'success') return <SkillsHomeView view={view} active={active} dispatch={dispatch} />;
	return null;
}
