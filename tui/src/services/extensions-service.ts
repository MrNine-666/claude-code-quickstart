import {execCommand} from '../core/exec.js';
import {readInstalledPiPackageManifest} from '../core/pi-package-source.js';
import {parseSemver} from '../core/semver.js';
import {
	PI_MCP_ADAPTER_ID,
	PI_MCP_ADAPTER_SPEC,
	fetchPiPackageMonthlyDownloads,
	installPiMcpAdapter,
	installPiPackage,
	installedPiPackagePlaceholder,
	inspectPiPackage,
	listPiPackages,
	packageFromManifest,
	removePiPackage,
	requestPiPackageCatalog,
	searchPiPackageCatalogPage,
	updatePiPackage,
	type ExtensionCommandDeps,
	type PiExtensionPackage,
	type PiExtensionResult,
	type PiExtensionSearchPage
} from '../core/extensions.js';

export type ExtensionsService = {
	readonly loadInstalled: () => Promise<readonly PiExtensionPackage[]>;
	readonly search: (query: string, page?: number) => Promise<PiExtensionSearchPage>;
	readonly inspect: (name: string) => Promise<PiExtensionPackage | null>;
	readonly install: (name: string, signal?: AbortSignal) => Promise<PiExtensionResult>;
	readonly update: (name: string, signal?: AbortSignal) => Promise<void>;
	readonly remove: (name: string, signal?: AbortSignal) => Promise<void>;
	readonly installMcpAdapter: (signal?: AbortSignal) => Promise<PiExtensionResult>;
};

export function createExtensionsService(deps: ExtensionCommandDeps = {}): ExtensionsService {
	const exec = deps.exec ?? execCommand;
	// 注入 exec 的测试/嵌入环境不应因为读取本地列表而偷偷访问网络；正式服务仍使用
	// npm 官方请求，测试若要覆盖下载统计则显式注入 request。
	const metadataRequest = deps.request ?? (exec === execCommand ? requestPiPackageCatalog : undefined);
	return {
		loadInstalled: async () => {
			const sources = await listPiPackages(exec);
			const packages = await Promise.all(
				sources.map(async (source): Promise<PiExtensionPackage | null> => {
					const packageSource = packageSourceFromListEntry(source);
					const manifest = readInstalledPiPackageManifest(packageSource);
					const installedVersion = typeof manifest?.version === 'string' && parseSemver(manifest.version) ? manifest.version : '';
					const localInfo = manifest ? packageFromManifest(manifest, {installed: true, source: packageSource}) : null;
					if (manifest && !localInfo?.resourceTypes.includes('extension')) return null;
					let registryInfo: PiExtensionPackage | null = null;
					if (packageSource.startsWith('npm:')) {
						try {
							registryInfo = await inspectPiPackage(packageSource, exec);
						} catch (error) {
							// Keep local versions/resources usable when the registry is offline/private.
							console.error('[extensions] npm 元数据读取失败', packageSource, error);
						}
					}
					if (!localInfo && registryInfo && !registryInfo.resourceTypes.includes('extension')) return null;
					const packageInfo = localInfo ?? registryInfo ?? installedPiPackagePlaceholder(packageSource);
					const monthlyDownloads =
						metadataRequest && packageSource.startsWith('npm:')
							? await fetchPiPackageMonthlyDownloads(packageSource, metadataRequest)
							: undefined;
					return {
						...packageInfo,
						...(registryInfo ?? {}),
						// Local resources/identity and current version stay independent of latest metadata.
						name: packageInfo.name,
						type: packageInfo.type,
						resourceTypes: packageInfo.resourceTypes,
						author: registryInfo?.author && registryInfo.author !== '未知作者' ? registryInfo.author : packageInfo.author,
						version: registryInfo?.version ?? '',
						installed: true,
						source: packageSource,
						installedVersion,
						...(monthlyDownloads === undefined ? {} : {monthlyDownloads})
					};
				})
			);
			return packages.filter((item): item is PiExtensionPackage => item !== null);
		},
		search: (query, page = 0) =>
			deps.request
				? searchPiPackageCatalogPage(query, page, {exec, request: deps.request})
				: searchPiPackageCatalogPage(query, page, {exec}),
		inspect: name => inspectPiPackage(name, exec, metadataRequest),
		install: (name, signal) => installPiPackage(name, signal ? {...deps, signal} : deps),
		update: async (name, signal) => {
			await updatePiPackage(name, signal ? {...deps, signal} : deps);
		},
		remove: async (name, signal) => {
			await removePiPackage(name, signal ? {...deps, signal} : deps);
		},
		installMcpAdapter: signal => installPiMcpAdapter(signal ? {...deps, signal} : deps)
	};
}

export {PI_MCP_ADAPTER_ID, PI_MCP_ADAPTER_SPEC};

function packageSourceFromListEntry(source: string): string {
	return /^(?:npm:|git:|https?:\/\/|file:|~|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(source) ? source : `npm:${source}`;
}
