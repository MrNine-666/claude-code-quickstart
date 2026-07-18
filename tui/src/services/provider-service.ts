import {
	addProvider,
	deleteProvider,
	editProvider,
	getDisplayData,
	getManagedModelSummary,
	getProviderList,
	migrateLegacyProfiles,
	switchProvider,
	type AddProviderOptions,
	type AddProviderResult,
	type EditProviderUpdates,
	type MigrationResult,
	type ProviderDisplayData,
	type ProviderProfile
} from '../core/provider.js';
import {
	buildProviderFormModel,
	toProviderSavePayload,
	validateProviderForm,
	type ProviderFormInput,
	type ProviderFormModel,
	type ProviderFormValues,
	type ProviderSavePayload
} from '../core/provider-form.js';
import {readJsonFile} from '../core/fs-utils.js';

// Provider service：TUI 视图唯一入口，封装 core 调用为结构化结果，组件不直接读写文件。

export type ProviderServiceResult<T> =
	| {readonly ok: true; readonly data: T; readonly warning?: string}
	| {readonly ok: false; readonly error: string; readonly errorKind?: 'conflict'};

// 迁移 preflight 结果缓存（§2.4）：进入 Provider 视图执行一次，view 读取缓存决定首屏。
let migrationCache: MigrationResult | null = null;

/**
 * 迁移 preflight：进入 Provider 管理时执行一次旧格式迁移（§2.4 时序保证）。
 * 在 loadProviderDisplay() 的 getDisplayData() 之前同步执行，确保列表渲染时旧文件已迁移。
 */
export function runMigrationPreflight(): MigrationResult {
	if (!migrationCache) {
		migrationCache = migrateLegacyProfiles();
	}

	return migrationCache;
}

/** 读取 preflight 结果（view 首屏使用，不重复触发迁移）。 */
export function getMigrationResult(): MigrationResult | null {
	return migrationCache;
}

/** 重置迁移缓存（仅供测试与视图卸载后重置）。 */
export function resetMigrationCache(): void {
	migrationCache = null;
}

export function loadProviderDisplay(): ProviderDisplayData {
	runMigrationPreflight();
	return getDisplayData();
}

export function loadProviderProfile(profilePath: string): ProviderProfile | null {
	return readJsonFile<ProviderProfile | null>(profilePath, null);
}

export function modelSummary(profile: ProviderProfile | null): string {
	return getManagedModelSummary(profile);
}

export function buildForm(input: ProviderFormInput): ProviderFormModel {
	return buildProviderFormModel(input);
}

/** 保存 Provider 表单：先校验，再分流 add/edit core 调用。 */
export function saveProviderForm(input: ProviderFormInput, values: ProviderFormValues): ProviderServiceResult<AddProviderResult | {key: string; renamed: boolean}> {
	const mode = input.mode;
	const errors = validateProviderForm(mode, values);
	if (errors.length > 0) {
		return {ok: false, error: errors.join('；')};
	}

	const payload: ProviderSavePayload = toProviderSavePayload(input, values);

	try {
		if (payload.action === 'add') {
			const opts: AddProviderOptions = {
				builtinKey: payload.builtinKey,
				profileKey: payload.profileKey,
				baseUrl: payload.baseUrl,
				apiKey: payload.apiKey,
				modelEnv: payload.modelEnv,
				env: payload.env,
				activate: payload.activate,
				conflictStrategy: 'error'
			};
			const result = addProvider(opts);
			if (!result.success) {
				const error = result.error ?? '添加供应商失败';
				return {
					ok: false,
					error,
					...(error.includes('已存在') ? {errorKind: 'conflict' as const} : {})
				};
			}

			const warnings: string[] = [];
			if (result.onboardingWarning) {
				warnings.push(result.onboardingWarning);
			}
			if (payload.activate && !result.activated) {
				warnings.push(`供应商 ${result.key} 已保存，但激活失败：${result.activateError ?? '请修复配置后在列表中重试'}`);
			}

			return {
				ok: true,
				data: result,
				...(warnings.length > 0 ? {warning: warnings.join('；')} : {})
			};
		}

		const updates: EditProviderUpdates = {
			apiKey: payload.apiKey,
			baseUrl: payload.baseUrl,
			profileKey: payload.profileKey,
			modelEnv: payload.modelEnv,
			env: payload.env
		};
		const result = editProvider(payload.key, updates);
		return {ok: true, data: result};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function switchActiveProvider(key: string): ProviderServiceResult<{providerName: string}> {
	try {
		const result = switchProvider(key);
		return {ok: true, data: {providerName: result.providerName}};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/** 删除 Provider：禁止删除当前 active（core 已保护，这里转结构化错误）。 */
export function removeProvider(key: string): ProviderServiceResult<{clearedSettings: boolean}> {
	try {
		const result = deleteProvider(key);
		return {ok: true, data: {clearedSettings: result.clearedSettings}};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export {getProviderList};
