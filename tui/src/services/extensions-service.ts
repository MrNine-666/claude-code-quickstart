import {execCommand} from '../core/exec.js';
import {
	PI_MCP_ADAPTER_ID,
	PI_MCP_ADAPTER_SPEC,
	fetchPiPackageMonthlyDownloads,
	installPiMcpAdapter,
	installPiPackage,
	installedPiPackagePlaceholder,
	inspectPiPackage,
	listPiPackages,
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
				sources.map(async source => {
					const packageSource = packageSourceFromListEntry(source);
					try {
						const packageInfo = await inspectPiPackage(packageSource, exec, metadataRequest);
						return packageInfo?.resourceTypes.includes('extension')
							? {...packageInfo, installed: true, source: packageSource}
							: null;
					} catch {
						// Git/local packages and private registry entries may not be readable by
						// `npm view`; keep the installed Pi source visible with a safe fallback.
						const placeholder = installedPiPackagePlaceholder(packageSource);
						if (!metadataRequest) return placeholder;
						const monthlyDownloads = await fetchPiPackageMonthlyDownloads(packageSource, metadataRequest);
						return monthlyDownloads === undefined ? placeholder : {...placeholder, monthlyDownloads};
					}
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
	return /^(?:npm:|git:|https?:\/\/|file:|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(source) ? source : `npm:${source}`;
}
