import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {useKeyboard} from '@opentui/react';
import {Modal, toast, type BusyOverlayState} from '../../components/index.js';
import {readCcqSystemSettings, writeCcqSystemSettings, type CcqSystemSettings} from '../../core/system-settings.js';
import {piPackageOutcomeMessage} from '../../core/config-transfer-pi-packages.js';
import {createConfigTransferService, type ConfigTransferService} from '../../services/config-transfer-service.js';
import {
	createInitialSystemSettingsState,
	reduceSystemSettingsState,
	systemSettingsBusyTitle,
	systemSettingsExportValidation,
	systemSettingsSubMode,
	type SystemSettingsAction,
	type SystemSettingsBusyState
} from '../../state/system-settings-state.js';
import {executeSystemSettingsOperation} from './system-settings-view-actions.js';
import {mapSystemSettingsKey} from './system-settings-view-input.js';
import {SystemSettingsPageView} from './SystemSettingsPageView.js';
import {SystemSettingsExportModal, SystemSettingsImportModal} from './SystemSettingsModals.js';

// 系统设置模块 root：单页 wiring、键盘路由、busy overlay 投影与原生 picker 编排。
// 页面组件只 dispatch 纯 action；service 只由本层与 view-actions 调用。
// 三项偏好先留在草稿，Ctrl+S 原子保存后通知 App 更新自动更新运行态。

export type SystemSettingsPreferencesStore = {
	readonly load: typeof readCcqSystemSettings;
	readonly save: typeof writeCcqSystemSettings;
};
const DEFAULT_PREFERENCES_STORE: SystemSettingsPreferencesStore = {load: readCcqSystemSettings, save: writeCcqSystemSettings};

export type SystemSettingsViewProps = {
	readonly active: boolean;
	/** 测试注入点；默认使用真实 core/service。 */
	readonly service?: ConfigTransferService;
	readonly settingsStore?: SystemSettingsPreferencesStore;
	readonly autoUpdate: boolean;
	readonly autoUpdateError: string | null;
	/** 仅在系统设置文件成功保存后同步 App 中的运行态。 */
	readonly onAutoUpdateChange?: (value: boolean) => void;
	readonly onSettingsImported?: () => void;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav: () => void;
};

export function SystemSettingsView({
	active,
	service: injectedService,
	settingsStore = DEFAULT_PREFERENCES_STORE,
	autoUpdate,
	autoUpdateError,
	onAutoUpdateChange,
	onSettingsImported,
	onSubModeChange,
	onBusyStateChange,
	onExitToNav
}: SystemSettingsViewProps) {
	const service = useMemo(() => injectedService ?? createConfigTransferService(), [injectedService]);
	const [state, dispatch] = useReducer(reduceSystemSettingsState, undefined, createInitialSystemSettingsState);
	const [draftAutoUpdate, setDraftAutoUpdate] = useState(autoUpdate);
	const [savedSettings, setSavedSettings] = useState<CcqSystemSettings>({autoUpdate, backupEncryption: false, backupPassword: ''});
	const [discardConfirm, setDiscardConfirm] = useState(false);
	const loadPreferences = useCallback(() => {
		const settings = settingsStore.load();
		if (settings.status === 'invalid') {
			dispatch({type: 'show-error', message: settings.error});
			return;
		}
		setSavedSettings(settings.value);
		setDraftAutoUpdate(settings.value.autoUpdate);
		dispatch({type: 'load-backup-preferences', encryption: settings.value.backupEncryption, password: settings.value.backupPassword});
	}, [settingsStore]);
	useEffect(() => loadPreferences(), [loadPreferences]);
	const [progress, setProgress] = useState<string | undefined>(undefined);
	const cancelledRef = useRef(false);
	const importingRef = useRef(false);
	const abortRef = useRef<AbortController | null>(null);
	const toastedRef = useRef<unknown>(null);

	const subMode = discardConfirm ? 'discard-confirm' : systemSettingsSubMode(state);
	useEffect(() => {
		if (active) onSubModeChange?.(subMode);
	}, [active, onSubModeChange, subMode]);

	const cancelBusy = useCallback(() => {
		cancelledRef.current = true;
		// 让 service 在下一个 mutating 步骤前停下：取消不能只隐藏进度而继续写盘。
		abortRef.current?.abort();
		dispatch({type: 'cancel-busy'});
		if (!importingRef.current) toast.info('已取消配置迁移操作');
	}, []);

	const runBusy = useCallback(
		(busy: SystemSettingsBusyState) => {
			cancelledRef.current = false;
			importingRef.current = busy.operation === 'apply-import';
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;
			setProgress(undefined);
			void executeSystemSettingsOperation(
				busy,
				service,
				message => {
					if (!cancelledRef.current) setProgress(message);
				},
				action => {
					if (controller.signal.aborted) {
						// Import cancellation still carries external landing facts. Never discard this report.
						if (busy.operation === 'apply-import' && action.type === 'import-applied') {
							toast.warning(
								action.outcome.packages ? piPackageOutcomeMessage(action.outcome.packages) : '已取消配置迁移操作'
							);
						}
					} else if (abortRef.current === controller && !cancelledRef.current) dispatch(action);
				},
				controller.signal
			);
		},
		[service]
	);

	// 唯一执行入口：reducer 进入 busy 后由 effect 启动，避免 picker 异步回调持有过期 state。
	useEffect(() => {
		if (state.mode === 'busy') runBusy(state);
	}, [state, runBusy]);

	const busyTitle = state.mode === 'busy' ? systemSettingsBusyTitle(state.operation) : null;
	const busyMessage = state.mode === 'busy' ? progress : undefined;
	useEffect(() => {
		if (busyTitle === null) {
			onBusyStateChange?.(null);
			return;
		}

		onBusyStateChange?.({title: busyTitle, ...(busyMessage === undefined ? {} : {message: busyMessage}), onCancel: cancelBusy});
	}, [busyTitle, busyMessage, cancelBusy, onBusyStateChange]);
	useEffect(() => () => onBusyStateChange?.(null), [onBusyStateChange]);

	// 操作结果只提示一次，不在页面重复渲染状态行。
	useEffect(() => {
		const lastResult = state.mode === 'page' ? state.lastResult : null;
		if (!lastResult || toastedRef.current === lastResult) {
			return;
		}

		toastedRef.current = lastResult;
		if (
			lastResult.kind === 'import' &&
			lastResult.outcome.completed.some(item => item.tool === 'ccq' && item.category === 'system-settings')
		) {
			onSettingsImported?.();
			loadPreferences();
		}
		if (lastResult.kind === 'export') {
			toast.success('配置导出完成');
			return;
		}

		if (
			lastResult.outcome.packages &&
			(lastResult.outcome.packages.completed.length ||
				lastResult.outcome.packages.failed.length ||
				lastResult.outcome.packages.notExecuted.length)
		) {
			const message = piPackageOutcomeMessage(lastResult.outcome.packages);
			if (lastResult.outcome.status === 'complete') toast.success(message);
			else toast.warning(`${message}；分类文件${lastResult.outcome.failed.every(item => item.restored) ? '已恢复' : '恢复未确认'}`);
		} else if (lastResult.outcome.status === 'complete') {
			toast.success('配置导入完成');
		} else if (lastResult.outcome.status === 'partial') {
			toast.warning('配置导入部分完成');
		} else {
			toast.error('配置导入失败');
		}
	}, [state, onSettingsImported, loadPreferences]);

	const lastPageFeedback = useRef<string | null>(null);
	useEffect(() => {
		if (!active) return;
		if (state.mode !== 'page') {
			lastPageFeedback.current = null;
			return;
		}
		const message = state.error ?? state.notice;
		if (message && message !== lastPageFeedback.current) {
			if (state.error) toast.error(message);
			else toast.warning(message);
		}
		lastPageFeedback.current = message;
	}, [active, state]);

	const savePreferences = useCallback((): void => {
		if (state.mode !== 'page' || state.exportModal || state.importModal) return;
		const next = {autoUpdate: draftAutoUpdate, backupEncryption: state.encryption, backupPassword: state.password};
		const written = settingsStore.save(next);
		if (!written.ok) {
			toast.error(written.error);
			return;
		}
		setSavedSettings(next);
		onAutoUpdateChange?.(next.autoUpdate);
		toast.success('系统设置已保存');
	}, [draftAutoUpdate, onAutoUpdateChange, settingsStore, state]);

	// Ctrl+O：先采集内容摘要，再打开导出明细弹窗；勾选与确认都在弹窗内完成。
	const requestExport = useCallback((): void => {
		dispatch({type: 'request-export'});
	}, []);

	// 导出弹窗 Enter：校验本地选择；通过后才调起系统另存为。
	const confirmExport = useCallback(async (): Promise<void> => {
		if (state.mode !== 'page' || state.exportModal === null) {
			return;
		}

		const validation = systemSettingsExportValidation(state.exportModal, state.encryption, state.password);
		if (!validation.ok) {
			dispatch({type: 'export-modal-error', message: validation.error});
			return;
		}

		const outcome = await service.pickExportPath();
		if (outcome.kind === 'selected') {
			dispatch({type: 'export-path-picked', path: outcome.path});
			return;
		}

		if (outcome.kind === 'unavailable') {
			toast.warning(outcome.reason);
		}
		// cancelled：留在弹窗，可重试。
	}, [service, state]);

	// Ctrl+I：先系统打开文件对话框；取消不报错。
	const requestImport = useCallback(async (): Promise<void> => {
		if (state.mode !== 'page' || state.exportModal !== null || state.importModal !== null) {
			return;
		}

		const outcome = await service.pickImportPath();
		if (outcome.kind === 'selected') {
			dispatch({type: 'import-picked', path: outcome.path, savedPassword: savedSettings.backupPassword});
			return;
		}

		if (outcome.kind === 'unavailable') {
			toast.warning(outcome.reason);
		}
		// cancelled：静默返回本页，不报失败。
	}, [state, service, savedSettings.backupPassword]);

	const pageState = state.mode === 'page' ? state : state.restore;
	const dirty =
		draftAutoUpdate !== savedSettings.autoUpdate ||
		pageState.encryption !== savedSettings.backupEncryption ||
		pageState.password !== savedSettings.backupPassword;

	useKeyboard(keyEvent => {
		if (!active) {
			return;
		}

		if (discardConfirm) {
			keyEvent.preventDefault?.();
			const key = keyEvent.name.toLowerCase();
			if (key === 'escape') setDiscardConfirm(false);
			else if (key === 'enter' || key === 'return') {
				setDiscardConfirm(false);
				setDraftAutoUpdate(savedSettings.autoUpdate);
				dispatch({
					type: 'load-backup-preferences',
					encryption: savedSettings.backupEncryption,
					password: savedSettings.backupPassword
				});
				onExitToNav();
			}
			return;
		}

		const intent = mapSystemSettingsKey(state, keyEvent);
		if (intent.kind === 'exit') {
			keyEvent.preventDefault?.();
			if (dirty) {
				setDiscardConfirm(true);
				return;
			}
			onExitToNav();
			return;
		}

		if (intent.kind === 'save') {
			keyEvent.preventDefault?.();
			savePreferences();
			return;
		}

		if (intent.kind === 'toggle-auto-update') {
			keyEvent.preventDefault?.();
			setDraftAutoUpdate(value => !value);
			return;
		}

		if (intent.kind === 'clear-saved-password') {
			keyEvent.preventDefault?.();
			dispatch({type: 'password-input', value: ''});
			toast.info('已清除密码草稿；按 Ctrl+S 保存');
			return;
		}

		if (intent.kind === 'open-export') {
			keyEvent.preventDefault?.();
			requestExport();
			return;
		}

		if (intent.kind === 'confirm-export') {
			keyEvent.preventDefault?.();
			void confirmExport();
			return;
		}

		if (intent.kind === 'pick-import') {
			keyEvent.preventDefault?.();
			void requestImport();
			return;
		}

		if (intent.kind === 'action') {
			keyEvent.preventDefault?.();
			dispatch(intent.action);
		}
	});

	const modalActive = state.mode === 'page' && (state.exportModal !== null || state.importModal !== null || discardConfirm);
	const pageActive = active && state.mode === 'page' && !modalActive;
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<SystemSettingsPageView
				state={pageState}
				active={pageActive}
				autoUpdate={draftAutoUpdate}
				autoUpdateError={autoUpdateError}
				onAutoUpdateChange={setDraftAutoUpdate}
				onEncryptionChange={value => dispatch({type: 'set-encryption', value})}
				onPasswordChange={value => dispatch({type: 'password-input', value})}
			/>
			{state.mode === 'page' && state.exportModal ? (
				<SystemSettingsExportModal active modal={state.exportModal} encryption={state.encryption} />
			) : null}
			{state.mode === 'page' && state.importModal ? (
				<SystemSettingsImportModal active modal={state.importModal} dispatch={action => dispatch(action as SystemSettingsAction)} />
			) : null}
			<Modal active={discardConfirm} title="放弃未保存的系统设置？" hint="Enter 放弃修改  Esc 继续编辑" tone="warning">
				<text>自动更新、加密选项和密码的修改尚未保存。</text>
			</Modal>
		</box>
	);
}
