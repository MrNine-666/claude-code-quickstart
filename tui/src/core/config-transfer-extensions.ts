import {
	collectPortableTreeEntries,
	excludedTransferAuthFile,
	excludedTransferAuthSymlink,
	materializePortableTreeEntries,
	portableTargetSafe
} from './config-transfer-sections.js';
import {
	createPortableTreeValidationState,
	type PortableTreeEntry,
	parsePortableTreeEntries,
	type SectionMergeReport,
	type TransferResult,
	transferFail,
	transferOk
} from './config-transfer.js';
import {atomicWrite, readJsonFileStrict, SECRET_FILE_MODE} from './fs-utils.js';
import {piAgentDir, piExtensionsDir, piSettingsPath} from './paths.js';
import {
	inspectPiPackageInstallation,
	isLocalPiPackageSource,
	parsePiPackageDeclarations,
	parsePiPackageSource,
	piPackageSource,
	type PiPackageDeclaration
} from './pi-package-source.js';

// Pi Extensions 的受管全局文件树 + settings.json 中指向该树内文件的相对显式入口。
// settings 通用分类仍不拥有 extensions/packages；只迁移安全 npm/Git 声明，不携带安装产物。
export type ExtensionsSection = {
	readonly entries: readonly PortableTreeEntry[];
	readonly explicitEntries?: readonly string[];
	readonly packages?: readonly PiPackageDeclaration[];
};
type JsonObject = Record<string, unknown>;
const comparableDeclaration = (value: unknown): string =>
	JSON.stringify(isObject(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 唯一允许恢复的声明：Pi agentDir 下 extensions/<file>，路径和文件均在包内。 */
function safeExplicitEntry(path: unknown, files: ReadonlySet<string>): path is string {
	if (typeof path !== 'string' || !path.startsWith('extensions/') || path.includes('\\') || path.includes('\0')) return false;
	const relative = path.slice('extensions/'.length);
	return (
		relative.split('/').every(part => part !== '' && part !== '.' && part !== '..') &&
		!excludedTransferAuthFile(relative) &&
		files.has(relative)
	);
}

/** 快照深层自建扩展文件和安全的 settings.json.extensions 相对入口。 */
export function snapshotExtensionsSection(): TransferResult<ExtensionsSection> {
	if (!portableTargetSafe(piAgentDir(), piExtensionsDir())) {
		return transferFail('conflict', '本机 Pi 扩展目录越过受管目录，已停止快照');
	}
	const collected = collectPortableTreeEntries({
		root: 'pi-agent',
		baseDir: piExtensionsDir(),
		files: [],
		dirs: [],
		all: true,
		exclude: excludedTransferAuthFile
	});
	if (!collected.ok) return collected;
	const warnings = [...collected.data.warnings];
	const files = new Set(collected.data.entries.filter(entry => entry.kind === 'file').map(entry => entry.path));
	const settings = readJsonFileStrict<unknown>(piSettingsPath());
	const explicitEntries: string[] = [];
	let packages: readonly PiPackageDeclaration[] | undefined;
	if (settings.status === 'invalid' || (settings.status === 'valid' && !isObject(settings.value))) {
		return transferFail('conflict', 'Pi settings.json 损坏，已停止 Extensions 快照');
	} else if (settings.status === 'valid' && isObject(settings.value)) {
		if (settings.value.packages !== undefined) {
			if (!Array.isArray(settings.value.packages)) return transferFail('validation', 'Pi packages 结构无效');
			const remote = settings.value.packages.filter(entry => {
				const source = typeof entry === 'string' ? entry : isObject(entry) ? entry.source : undefined;
				if (isLocalPiPackageSource(source)) {
					warnings.push('已排除本机路径 Pi package（不迁移本地源码）');
					return false;
				}
				return true;
			});
			const parsed = parsePiPackageDeclarations(remote);
			if (!parsed.ok) return transferFail('validation', parsed.error);
			packages = parsed.data;
		}
		const configured = settings.value.extensions;
		if (configured !== undefined && !Array.isArray(configured)) warnings.push('Pi 显式扩展入口结构无效，未收录');
		else if (Array.isArray(configured)) {
			for (const value of configured) {
				if (safeExplicitEntry(value, files)) {
					if (!explicitEntries.includes(value)) explicitEntries.push(value);
				} else {
					warnings.push('已排除不受管或无文件的显式扩展入口');
				}
			}
		}
	}
	return transferOk({entries: collected.data.entries, explicitEntries, ...(packages === undefined ? {} : {packages})}, warnings);
}

/** 校验包中的 Pi Extensions 分类；旧版仅含 entries 的 v1 包仍可导入。 */
export function parseExtensionsSection(value: unknown): TransferResult<ExtensionsSection> {
	if (!isObject(value) || !Array.isArray(value.entries)) return transferFail('validation', 'Pi Extensions 分类内容无效');
	const parsed = parsePortableTreeEntries(value.entries, createPortableTreeValidationState());
	if (!parsed.ok) return parsed;
	for (const entry of parsed.data) {
		if (entry.root !== 'pi-agent' || excludedTransferAuthFile(entry.path) || excludedTransferAuthSymlink(entry)) {
			return transferFail('validation', 'Pi Extensions 分类包含不受支持的路径或认证文件');
		}
	}
	const files = new Set(parsed.data.filter(entry => entry.kind === 'file').map(entry => entry.path));
	const explicitEntries = value.explicitEntries ?? [];
	if (
		!Array.isArray(explicitEntries) ||
		explicitEntries.some(entry => !safeExplicitEntry(entry, files)) ||
		new Set(explicitEntries).size !== explicitEntries.length
	) {
		return transferFail('validation', 'Pi Extensions 显式入口不安全或没有对应文件');
	}
	const packages = value.packages === undefined ? undefined : parsePiPackageDeclarations(value.packages);
	if (packages && !packages.ok) return transferFail('validation', packages.error);
	return transferOk({
		entries: parsed.data,
		explicitEntries: explicitEntries as string[],
		...(packages?.ok ? {packages: packages.data} : {})
	});
}

/** 本机未知字段和包外入口保留；损坏 settings 在预览阶段阻断。 */
export function importExtensionsSection(
	data: unknown,
	options: {readonly dryRun?: boolean; readonly packageInstalled?: (source: string) => boolean} = {}
): TransferResult<SectionMergeReport> {
	const parsed = parseExtensionsSection(data);
	if (!parsed.ok) return parsed;
	const paths = parsed.data.explicitEntries ?? [];
	if (!portableTargetSafe(piAgentDir(), piSettingsPath())) {
		return transferFail('conflict', '本机 Pi settings.json 路径越过受管目录');
	}
	const settings = readJsonFileStrict<unknown>(piSettingsPath());
	if (settings.status === 'invalid' || (settings.status === 'valid' && !isObject(settings.value))) {
		return transferFail('conflict', '本机 Pi settings.json 损坏，已停止导入 Extensions');
	}
	const local = settings.status === 'valid' ? (settings.value as JsonObject) : {};
	if (
		paths.length > 0 &&
		local.extensions !== undefined &&
		(!Array.isArray(local.extensions) || !local.extensions.every(entry => typeof entry === 'string'))
	) {
		return transferFail('conflict', '本机 Pi 显式扩展入口损坏，已停止导入 Extensions');
	}
	const packageReport: SectionMergeReport = {added: [], replaced: [], unchanged: [], skipped: [], warnings: []};
	let mergedPackages: unknown[] | undefined;
	if (parsed.data.packages?.length) {
		if (
			local.packages !== undefined &&
			(!Array.isArray(local.packages) ||
				local.packages.some(v => typeof v !== 'string' && (!isObject(v) || typeof v.source !== 'string')))
		)
			return transferFail('conflict', '本机 Pi packages 损坏');
		mergedPackages = [...(Array.isArray(local.packages) ? local.packages : [])];
		for (const declaration of parsed.data.packages) {
			const source = piPackageSource(declaration);
			const remote = parsePiPackageSource(source);
			if (!remote.ok) return transferFail('validation', remote.error);
			const index = mergedPackages.findIndex(v => {
				const r = parsePiPackageSource(typeof v === 'string' ? v : isObject(v) ? v.source : undefined);
				return r.ok && r.data.identity === remote.data.identity;
			});
			const current = index < 0 ? undefined : mergedPackages[index];
			// Retain unknown local object fields for this identity; replace only native owned filters.
			const unknown = isObject(current)
				? Object.fromEntries(
						Object.entries(current).filter(
							([k]) => !['source', 'autoload', 'extensions', 'skills', 'prompts', 'themes'].includes(k)
						)
					)
				: {};
			const desired = Object.keys(unknown).length
				? {...unknown, ...(typeof declaration === 'string' ? {source: declaration} : declaration)}
				: declaration;
			const installed = (options.packageInstalled ?? inspectPiPackageInstallation)(source);
			const same = comparableDeclaration(current) === comparableDeclaration(desired);
			const identity = `package:${source}`;
			(packageReport[index < 0 ? 'added' : same && installed ? 'unchanged' : 'replaced'] as string[]).push(identity);
			if (!same || !installed)
				(packageReport.warnings as string[]).push(`待安装来源：${source}；确认后下载/安装第三方代码，可能执行依赖脚本`);
			if (!options.dryRun && !installed) return transferFail('conflict', 'Pi package 尚未确认安装，请通过导入确认执行');
			if (index < 0) mergedPackages.push(desired);
			else mergedPackages[index] = desired;
		}
	}
	const existing = Array.isArray(local.extensions) ? (local.extensions as string[]) : [];
	const additional = paths.filter(
		path =>
			!existing.includes(path) && !existing.includes(`+${path}`) && !existing.includes(`-${path}`) && !existing.includes(`!${path}`)
	);
	const tree = materializePortableTreeEntries(piExtensionsDir(), parsed.data.entries, options.dryRun ?? false);
	if (!tree.ok) return tree;
	const packageChanged = packageReport.added.length + packageReport.replaced.length > 0;
	if (!options.dryRun && (additional.length > 0 || packageChanged)) {
		try {
			// 两个文件事实由调用方同一分类 transaction 快照/回滚。
			atomicWrite(
				piSettingsPath(),
				JSON.stringify(
					{
						...local,
						...(additional.length ? {extensions: [...existing, ...additional]} : {}),
						...(packageChanged ? {packages: mergedPackages} : {})
					},
					null,
					2
				),
				{
					mode: SECRET_FILE_MODE
				}
			);
		} catch {
			return transferFail('io', 'Pi 显式扩展入口写入失败');
		}
	}
	return transferOk({
		...tree.data,
		added: [
			...tree.data.added,
			...packageReport.added,
			...(additional.length && settings.status === 'missing' ? ['settings.extensions'] : [])
		],
		replaced: [
			...tree.data.replaced,
			...packageReport.replaced,
			...(additional.length && settings.status === 'valid' ? ['settings.extensions'] : [])
		],
		unchanged: [...tree.data.unchanged, ...packageReport.unchanged],
		warnings: [...tree.data.warnings, ...packageReport.warnings]
	});
}
