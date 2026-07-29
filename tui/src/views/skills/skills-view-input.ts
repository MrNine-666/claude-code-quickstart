import type {KeyEvent} from '@opentui/core';
import {toast} from '../../components/index.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../hooks/use-task-cancellation.js';
import {
	pendingSourceReplacements,
	selectedHomeRow,
	selectedInstalled,
	shouldRunSearch,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import {
	runConfirmedUninstallAction,
	runInstallToTargetsAction,
	openCurrentSkillSourceAction,
	runSearchAction,
	runTopologyTransitionAction,
	runUpdateSelectedIfReadyAction
} from './skills-view-actions.js';
import type {SkillsDetection, SkillsViewDispatch, SkillsViewServices} from './skills-view-types.js';

export function handleSkillsKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: SkillsViewDispatch,
	services: SkillsViewServices,
	cache: DetectionCache<SkillsDetection>,
	onExitToNav: (() => void) | undefined,
	taskCancellation: TaskCancellation
): void {
	if (view.mode === 'busy') return;
	if (view.mode === 'select-install-target' || view.mode === 'manage-inject') {
		handleTargetModalKey(keyEvent, view, dispatch, services, cache, taskCancellation);
		return;
	}
	if (view.mode === 'confirm-topology-change' || view.mode === 'confirm-source-replacement') {
		handleLifecycleConfirmKey(keyEvent, view, dispatch, services, cache, taskCancellation);
		return;
	}
	if (view.mode === 'confirm-uninstall') {
		const mapped = mapActionKey(keyEvent.name);
		if (mapped === 'enter') {
			dispatch({type: 'confirm'});
			runConfirmedUninstallAction(view, services, dispatch, cache, taskCancellation);
		} else if (mapped === 'escape') dispatch({type: 'cancel'});
		return;
	}
	if (view.mode === 'install') {
		handleInstallKey(keyEvent, view, dispatch, services, cache);
		return;
	}
	handleListKey(keyEvent, view, dispatch, services, cache, onExitToNav, taskCancellation);
}

function handleTargetModalKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: SkillsViewDispatch,
	services: SkillsViewServices,
	cache: DetectionCache<SkillsDetection>,
	taskCancellation: TaskCancellation
): void {
	const key = keyEvent.name.toLowerCase();
	if (key === 'up' || key === 'arrowup') {
		dispatch({type: 'install-target-nav', delta: -1});
		return;
	}
	if (key === 'down' || key === 'arrowdown') {
		dispatch({type: 'install-target-nav', delta: 1});
		return;
	}
	if (key === 'space' || keyEvent.name === ' ') {
		dispatch({type: 'install-target-toggle'});
		return;
	}
	if (key === 'escape') {
		dispatch({type: 'cancel'});
		return;
	}
	if (key === 'enter' || key === 'return') {
		if (view.mode === 'select-install-target') {
			if (pendingSourceReplacements(view).length > 0) dispatch({type: 'request-source-replacement'});
			else runInstallToTargetsAction(view, services, dispatch, cache, taskCancellation);
		} else dispatch({type: 'request-topology-change'});
	}
}

function handleLifecycleConfirmKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: SkillsViewDispatch,
	services: SkillsViewServices,
	cache: DetectionCache<SkillsDetection>,
	taskCancellation: TaskCancellation
): void {
	const mapped = mapActionKey(keyEvent.name);
	if (mapped === 'escape') {
		dispatch({type: 'cancel'});
		return;
	}
	if (mapped !== 'enter') return;
	if (view.mode === 'confirm-topology-change') {
		runTopologyTransitionAction(view, services, dispatch, cache, taskCancellation);
	} else {
		runInstallToTargetsAction(view, services, dispatch, cache, taskCancellation);
	}
}

function handleListKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: SkillsViewDispatch,
	services: SkillsViewServices,
	cache: DetectionCache<SkillsDetection>,
	onExitToNav: (() => void) | undefined,
	taskCancellation: TaskCancellation
): void {
	const name = keyEvent.name;
	if (view.filterFocused) {
		if (name === 'escape') {
			keyEvent.preventDefault?.();
			dispatch({type: 'filter-clear'});
			return;
		}
		if (name === 'tab') {
			keyEvent.preventDefault?.();
			dispatch({type: 'filter-blur'});
			return;
		}
		const nav = mapNavKey(name);
		if (nav) {
			keyEvent.preventDefault?.();
			dispatch({type: nav === 'up' ? 'nav-up' : 'nav-down'});
			return;
		}
		if (name === 'enter' || name === 'return') keyEvent.preventDefault?.();
		return;
	}

	if (name === 'escape' || name === 'left' || name === 'arrowleft') {
		onExitToNav?.();
		return;
	}

	switch (mapActionKey(name)) {
		case 'up':
			dispatch({type: 'nav-up'});
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'tab':
			dispatch({type: 'filter-focus'});
			return;
		case 'enter':
			if (selectedHomeRow(view)?.kind === 'group') dispatch({type: 'toggle-source-group'});
			else if (selectedInstalled(view)) dispatch({type: 'manage-inject'});
			return;
		case 'toggle-selection':
			if (selectedHomeRow(view)?.kind === 'group') dispatch({type: 'toggle-source-group'});
			else dispatch({type: 'toggle-installed-selection'});
			return;
		case 'select-all':
			dispatch({type: 'select-all-installed'});
			return;
		case 'install':
			dispatch({type: 'open-install'});
			return;
		case 'update':
			dispatch({type: 'request-update'});
			runUpdateSelectedIfReadyAction(view, services, dispatch, cache, taskCancellation);
			return;
		case 'uninstall':
			dispatch({type: 'request-uninstall'});
			return;
		case 'refresh':
			cache.refresh();
			return;
		case 'toggle-layout':
			dispatch({type: 'toggle-home-layout'});
			return;
		case 'toggle-all-groups':
			dispatch({type: 'toggle-all-source-groups'});
			return;
		case 'open-source':
			openCurrentSkillSourceAction(view);
			return;
	}
}

function handleInstallKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: SkillsViewDispatch,
	services: SkillsViewServices,
	cache: DetectionCache<SkillsDetection>
): void {
	const name = keyEvent.name;
	if (view.queryFocused) {
		if (name === 'enter' || name === 'return') {
			keyEvent.preventDefault?.();
			dispatch({type: 'submit-search'});
			if (shouldRunSearch(view)) runSearchAction(view.query, services, dispatch);
			return;
		}
		if (name === 'escape') {
			keyEvent.preventDefault?.();
			dispatch({type: 'cancel'});
			return;
		}
		if (name === 'tab') {
			keyEvent.preventDefault?.();
			dispatch({type: 'query-blur'});
			return;
		}
		const nav = mapNavKey(name);
		if (nav) {
			keyEvent.preventDefault?.();
			dispatch({type: nav === 'up' ? 'nav-up' : 'nav-down'});
		}
		return;
	}

	const lowerName = name.toLowerCase();
	if (lowerName === 'space' || name === ' ') {
		if (cache.state.status === 'success') dispatch({type: 'toggle-result'});
		else showDetectionPending(cache);
		return;
	}
	if (lowerName === 'a') {
		if (cache.state.status === 'success') dispatch({type: 'select-all-results'});
		else showDetectionPending(cache);
		return;
	}
	if (lowerName === 'r') {
		cache.refresh();
		return;
	}

	switch (mapActionKey(name)) {
		case 'up':
			if (view.resultIndex > 0) dispatch({type: 'nav-up'});
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'tab':
			dispatch({type: 'query-focus'});
			return;
		case 'enter':
			if (cache.state.status === 'success' && view.results.length > 0) dispatch({type: 'select-skill'});
			else if (cache.state.status !== 'success') showDetectionPending(cache);
			return;
		case 'escape':
			dispatch({type: 'cancel'});
			return;
	}
}

function showDetectionPending(cache: DetectionCache<SkillsDetection>): void {
	toast.info(cache.state.status === 'error' ? '安装状态检测失败，请刷新后重试' : '正在检测安装状态，请稍候');
}

export function mapSkillsActionKey(key: string): string | null {
	return mapActionKey(key);
}

function mapActionKey(key: string): string | null {
	const normalized = key.toLowerCase();
	if (normalized === 'up' || normalized === 'arrowup') return 'up';
	if (normalized === 'down' || normalized === 'arrowdown') return 'down';
	if (normalized === 'enter' || normalized === 'return') return 'enter';
	if (normalized === 'escape') return 'escape';
	if (normalized === 'tab') return 'tab';
	if (normalized === 'space' || key === ' ') return 'toggle-selection';
	if (normalized === 'a') return 'select-all';
	if (normalized === 'i') return 'install';
	if (normalized === 'u') return 'update';
	if (normalized === 'd') return 'uninstall';
	if (normalized === 'r') return 'refresh';
	if (normalized === 'v') return 'toggle-layout';
	if (normalized === 'e') return 'toggle-all-groups';
	if (normalized === 'o') return 'open-source';
	return null;
}

function mapNavKey(key: string): 'up' | 'down' | null {
	const normalized = key.toLowerCase();
	if (normalized === 'up' || normalized === 'arrowup') return 'up';
	if (normalized === 'down' || normalized === 'arrowdown') return 'down';
	return null;
}
