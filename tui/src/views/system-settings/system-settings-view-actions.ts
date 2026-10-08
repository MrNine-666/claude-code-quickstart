import type {ConfigTransferProgress, ConfigTransferService} from '../../services/config-transfer-service.js';
import type {SystemSettingsAction, SystemSettingsBusyState} from '../../state/system-settings-state.js';

// 系统设置 service 编排：busy 状态是唯一执行入口；完成/失败只回填 typed action。
// 不接触 React state，不渲染 toast；调用方（View）负责 cancellation 与 overlay 投影。

export type SystemSettingsSettle = (action: SystemSettingsAction) => void;

export async function executeSystemSettingsOperation(
	busy: SystemSettingsBusyState,
	service: ConfigTransferService,
	onProgress: ConfigTransferProgress,
	settle: SystemSettingsSettle,
	signal?: AbortSignal
): Promise<void> {
	switch (busy.retry.stage) {
		case 'prepare-export': {
			const result = await service.prepareExport({categories: busy.retry.categories}, onProgress, {signal});
			settle(
				result.ok ? {type: 'export-prepared', summary: result.data} : {type: 'failed', kind: result.kind, message: result.error}
			);
			return;
		}

		case 'write-export': {
			const result = await service.writeExport(
				{
					targetPath: busy.retry.targetPath,
					categories: busy.retry.categories,
					password: busy.retry.password,
					encrypt: busy.retry.encrypt
				},
				onProgress,
				{signal}
			);
			settle(result.ok ? {type: 'export-written', result: result.data} : {type: 'failed', kind: result.kind, message: result.error});
			return;
		}

		case 'load-import': {
			const result = await service.loadImport({bundlePath: busy.retry.bundlePath, password: busy.retry.password}, onProgress, {
				signal
			});
			settle(result.ok ? {type: 'import-loaded', summary: result.data} : {type: 'failed', kind: result.kind, message: result.error});
			return;
		}

		case 'apply-import': {
			const result = await service.applyImport(busy.retry.decisions, onProgress, {signal});
			settle(result.ok ? {type: 'import-applied', outcome: result.data} : {type: 'failed', kind: result.kind, message: result.error});
			return;
		}
	}
}
