import {readCcqSystemSettings, writeCcqSystemSettings} from './system-settings.js';
import {transferFail, transferOk, type SectionMergeReport, type TransferResult} from './config-transfer.js';

// CCQ 自有偏好：包只携带明确归 CCQ 管理的字段，不复制未知本机字段或系统凭据。
export type CcqSettingsSection = {readonly autoUpdate: boolean};

export function snapshotCcqSettingsSection(): TransferResult<CcqSettingsSection> {
	const current = readCcqSystemSettings();
	if (current.status === 'invalid') return transferFail('validation', '本机 CCQ 系统设置损坏，无法导出');
	return transferOk({autoUpdate: current.value.autoUpdate});
}

export function importCcqSettingsSection(data: unknown, options: {readonly dryRun?: boolean} = {}): TransferResult<SectionMergeReport> {
	if (
		typeof data !== 'object' ||
		data === null ||
		Array.isArray(data) ||
		Object.keys(data).length !== 1 ||
		typeof (data as Record<string, unknown>).autoUpdate !== 'boolean'
	) {
		return transferFail('validation', '导出包内 CCQ 系统设置格式无效');
	}
	const incoming = (data as CcqSettingsSection).autoUpdate;
	const current = readCcqSystemSettings();
	if (current.status === 'invalid') return transferFail('conflict', '本机 CCQ 系统设置损坏，已阻止导入');
	const report: SectionMergeReport = {
		added: current.status === 'missing' ? ['autoUpdate'] : [],
		replaced: current.status === 'valid' && current.value.autoUpdate !== incoming ? ['autoUpdate'] : [],
		unchanged: current.status === 'valid' && current.value.autoUpdate === incoming ? ['autoUpdate'] : [],
		skipped: [],
		warnings: []
	};
	if (!options.dryRun && (report.added.length > 0 || report.replaced.length > 0)) {
		const written = writeCcqSystemSettings({autoUpdate: incoming});
		if (!written.ok) return transferFail('io', 'CCQ 系统设置写入失败');
	}
	return transferOk(report);
}
