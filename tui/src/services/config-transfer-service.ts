import {
	type BundleEnvelope,
	type BundlePayload,
	CONFIG_BUNDLE_FORMAT,
	CONFIG_BUNDLE_VERSION,
	createBundlePayload,
	decryptBundlePayload,
	encryptBundlePayload,
	ensureBundleExtension,
	readConfigBundle,
	TRANSFER_EXECUTION_ORDER,
	type TransferCategoryIdentity,
	type TransferResult,
	transferFail,
	transferOk,
	writeConfigBundle
} from '../core/config-transfer.js';
import {
	applyConfigTransferImport,
	type ConfigTransferApplyOptions,
	type ConfigTransferApplyOutcome,
	type ConfigTransferCategoryDecision,
	type ConfigTransferExportCategorySummary,
	type ConfigTransferExportOptions,
	type ConfigTransferExportPlan,
	planConfigTransferExport,
	type ConfigTransferImportOptions,
	type ConfigTransferImportPlan,
	planConfigTransferImport
} from '../core/config-transfer-plan.js';
import {type FileDialogOutcome, pickExportBundle, pickImportBundle} from '../core/native-file-dialog.js';
import {
	systemSettingsExcludedIdentities,
	type ConfigTransferExportResult,
	type ConfigTransferExportSummary,
	type ConfigTransferImportSummary
} from '../state/system-settings-state.js';
import {CCQ_VERSION} from '../version.js';

// 配置导入导出 service（Phase 4）：把 UI 选择翻译成 core 请求，编排异步 crypto/读写，
// 并把原生 picker 的 cancelled/unavailable 原样交给 view 决定是否安静回退。
// 不接触 React state、不渲染 toast；progress 只发静态脱敏阶段文案。

export type ConfigTransferProgress = (message: string) => void;

/** 取消通道：view 的 busy overlay 取消会 abort，mutating 步骤前必须重新检查。 */
export type ConfigTransferOperationOptions = {readonly signal?: AbortSignal};

function cancelled(): TransferResult<never> {
	return transferFail('cancelled', '操作已取消');
}

export type ConfigTransferServiceDeps = {
	readonly pickExportPath?: () => Promise<FileDialogOutcome>;
	readonly pickImportPath?: () => Promise<FileDialogOutcome>;
	readonly exportOptions?: ConfigTransferExportOptions;
	readonly importOptions?: ConfigTransferImportOptions;
	readonly applyOptions?: ConfigTransferApplyOptions;
	readonly version?: string;
	readonly platform?: string;
};

export type ConfigTransferService = {
	readonly pickExportPath: () => Promise<FileDialogOutcome>;
	readonly pickImportPath: () => Promise<FileDialogOutcome>;
	/** 只读本机清单快照：系统设置页展示工具/分类条目计数，零写盘。 */
	readonly inventory: (
		onProgress?: ConfigTransferProgress,
		options?: ConfigTransferOperationOptions
	) => Promise<TransferResult<readonly ConfigTransferExportCategorySummary[]>>;
	/** 采集导出内容摘要；始终包含文件型凭据（是否加密由用户单独选择）。 */
	readonly prepareExport: (
		request: {readonly categories: readonly TransferCategoryIdentity[]},
		onProgress?: ConfigTransferProgress,
		options?: ConfigTransferOperationOptions
	) => Promise<TransferResult<ConfigTransferExportSummary>>;
	readonly writeExport: (
		request: {
			readonly targetPath: string;
			readonly categories: readonly TransferCategoryIdentity[];
			readonly password: string;
			readonly encrypt: boolean;
		},
		onProgress?: ConfigTransferProgress,
		options?: ConfigTransferOperationOptions
	) => Promise<TransferResult<ConfigTransferExportResult>>;
	readonly loadImport: (
		request: {readonly bundlePath: string; readonly password: string},
		onProgress?: ConfigTransferProgress,
		options?: ConfigTransferOperationOptions
	) => Promise<TransferResult<ConfigTransferImportSummary>>;
	readonly applyImport: (
		decisions: readonly ConfigTransferCategoryDecision[],
		onProgress?: ConfigTransferProgress,
		options?: ConfigTransferOperationOptions
	) => Promise<TransferResult<ConfigTransferApplyOutcome>>;
};

export function createConfigTransferService(deps: ConfigTransferServiceDeps = {}): ConfigTransferService {
	// 单次迁移会话的待写入计划/待应用包：只驻留内存，不落日志、不序列化。
	// ponytail: 只保留最近一次 pending 计划/包；需要并行多包会话时改为显式 handle 参数。
	let pendingExport: ConfigTransferExportPlan | null = null;
	let pendingCategories: readonly TransferCategoryIdentity[] = [];
	let pendingImport: {readonly payload: BundlePayload; readonly plan: ConfigTransferImportPlan} | null = null;
	let applyingImport = false;

	const pickExportPath = deps.pickExportPath ?? ((): Promise<FileDialogOutcome> => pickExportBundle());
	const pickImportPath = deps.pickImportPath ?? ((): Promise<FileDialogOutcome> => pickImportBundle());

	const inventory: ConfigTransferService['inventory'] = async (onProgress, options) => {
		onProgress?.('正在读取本机配置清单...');
		const plan = await planConfigTransferExport({categories: TRANSFER_EXECUTION_ORDER, includeCredentials: true}, deps.exportOptions);
		if (!plan.ok) {
			return plan;
		}

		if (options?.signal?.aborted) {
			return cancelled();
		}

		return transferOk(plan.data.summaries, plan.data.warnings);
	};

	const prepareExport: ConfigTransferService['prepareExport'] = async (request, onProgress, options) => {
		onProgress?.('正在收集所选配置...');
		const plan = await planConfigTransferExport({categories: request.categories, includeCredentials: true}, deps.exportOptions);
		if (!plan.ok) {
			return plan;
		}

		if (options?.signal?.aborted) {
			return cancelled();
		}

		if (plan.data.sections.length === 0) {
			return transferFail('validation', '没有可导出的配置内容');
		}

		pendingExport = plan.data;
		pendingCategories = request.categories;
		const summary: ConfigTransferExportSummary = {
			categories: plan.data.summaries,
			containsCredentials: plan.data.containsCredentials,
			warnings: plan.data.warnings
		};
		return transferOk(summary, plan.data.warnings);
	};

	const writeExport: ConfigTransferService['writeExport'] = async (request, onProgress, options) => {
		if (!pendingExport) {
			return transferFail('validation', '导出计划已失效，请重新选择导出内容');
		}

		const prepared = pendingExport;
		const allowed = new Set(pendingCategories.map(identity => `${identity.tool}:${identity.category}`));
		const selectedKeys = request.categories.map(identity => `${identity.tool}:${identity.category}`);
		if (
			selectedKeys.length === 0 ||
			new Set(selectedKeys).size !== selectedKeys.length ||
			selectedKeys.some(key => !allowed.has(key))
		) {
			return transferFail('validation', '导出分类选择已失效，请重新选择导出内容');
		}

		// 加密只由用户的「是否加密」选择控制：默认不加密，即使包含文件型凭据也尊重显式明文选择。
		const encrypt = request.encrypt === true;
		if (encrypt && request.password.length === 0) {
			return transferFail('validation', '选择加密时必须设置导出密码');
		}

		const current = await planConfigTransferExport({categories: pendingCategories, includeCredentials: true}, deps.exportOptions);
		if (!current.ok) return current;
		if (JSON.stringify(current.data.sections) !== JSON.stringify(prepared.sections)) {
			return transferFail('conflict', '本机配置已变化，请重新选择导出内容');
		}
		// Skills 会随目标 Agent 重新物化拓扑，不能直接从全选的 sections 里按首个工具过滤。
		const selected = await planConfigTransferExport({categories: request.categories, includeCredentials: true}, deps.exportOptions);
		if (!selected.ok) return selected;
		if (selected.data.sections.length === 0) return transferFail('validation', '没有可导出的配置内容');
		if (options?.signal?.aborted) return cancelled();
		const plan = selected.data;
		const targetPath = ensureBundleExtension(request.targetPath);

		onProgress?.('正在生成导出包...');
		const created = createBundlePayload({
			sections: plan.sections,
			containsCredentials: plan.containsCredentials,
			version: deps.version ?? CCQ_VERSION,
			platform: deps.platform ?? process.platform
		});
		if (!created.ok) {
			return created;
		}

		let envelope: BundleEnvelope;
		if (encrypt) {
			const encrypted = await encryptBundlePayload(created.data, request.password);
			if (!encrypted.ok) {
				return encrypted;
			}

			envelope = encrypted.data;
		} else {
			envelope = {format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload: created.data};
		}

		onProgress?.('正在写入导出包...');
		if (options?.signal?.aborted) {
			// 加密/派生是异步的：取消可能落在写盘前，此时不得创建任何包文件。
			return cancelled();
		}

		const written = writeConfigBundle(targetPath, envelope);
		if (!written.ok) {
			return written;
		}

		pendingExport = null;
		pendingCategories = [];
		const summary: ConfigTransferExportSummary = {
			categories: plan.summaries,
			containsCredentials: plan.containsCredentials,
			warnings: plan.warnings
		};
		const result: ConfigTransferExportResult = {
			bundlePath: targetPath,
			categoryCount: plan.sections.length,
			itemCount: plan.summaries.reduce((total, category) => total + category.itemCount, 0),
			containsCredentials: plan.containsCredentials,
			encrypted: encrypt,
			excluded: systemSettingsExcludedIdentities(summary)
		};
		return transferOk(result, plan.warnings);
	};

	const loadImport: ConfigTransferService['loadImport'] = async (request, onProgress, options) => {
		if (applyingImport) return transferFail('conflict', '上一导入仍在停止/对账，请稍后重试');
		onProgress?.('正在读取导出包...');
		const loaded = readConfigBundle(request.bundlePath);
		if (!loaded.ok) {
			return loaded;
		}

		const decrypted = await decryptBundlePayload(loaded.data, request.password);
		if (!decrypted.ok) {
			return decrypted;
		}

		if (options?.signal?.aborted) {
			return cancelled();
		}

		onProgress?.('正在校验包内容与本机配置...');
		const plan = await planConfigTransferImport(decrypted.data, deps.importOptions);
		if (!plan.ok) {
			return plan;
		}

		pendingImport = {payload: decrypted.data, plan: plan.data};
		const summary: ConfigTransferImportSummary = {
			containsCredentials: plan.data.containsCredentials,
			items: plan.data.items,
			warnings: plan.data.warnings
		};
		return transferOk(summary, plan.data.warnings);
	};

	const applyImport: ConfigTransferService['applyImport'] = async (decisions, onProgress, options) => {
		if (!pendingImport) {
			return transferFail('validation', '导入预览已失效，请重新选择导出包');
		}

		if (applyingImport) return transferFail('conflict', '上一导入仍在停止/对账，请稍后重试');
		applyingImport = true;
		try {
			onProgress?.('正在执行导入...');
			const outcome = await applyConfigTransferImport(pendingImport.payload, pendingImport.plan, decisions, {
				...deps.applyOptions,
				piPackages: deps.applyOptions?.piPackages ?? deps.importOptions?.piPackages,
				signal: options?.signal
			});
			if (outcome.ok && outcome.data.status === 'complete') pendingImport = null;
			return outcome;
		} finally {
			applyingImport = false;
		}
	};

	return {pickExportPath, pickImportPath, inventory, prepareExport, writeExport, loadImport, applyImport};
}
