import {execCommand, formatCommandInstruction, throwIfAborted, type ExecResult, type ProgressCallback} from './exec.js';
import {detectTool, TOOL_DEFINITIONS} from './tools-install.js';

export const PI_MCP_ADAPTER_ID = 'pi-mcp-adapter';
export const PI_MCP_ADAPTER_SPEC = 'npm:pi-mcp-adapter';
export const PI_PACKAGE_KEYWORD = 'pi-package';
export const PI_EXTENSION_SEARCH_PAGE_SIZE = 20;
export const PI_PACKAGE_CATALOG_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
export const PI_PACKAGE_CATALOG_DETAILS_URL = 'https://pi.dev/packages';
export const PI_PACKAGE_DOWNLOADS_URL = 'https://api.npmjs.org/downloads/point/last-month';

export type PiPackageResourceKind = 'extension' | 'skill' | 'prompt' | 'theme';

export type PiExtensionPackage = {
	readonly name: string;
	/** Exact source used by Pi package commands (for example `npm:foo` or a git URL). */
	readonly source: string;
	readonly version: string;
	readonly description: string;
	readonly type: PiPackageResourceKind;
	readonly resourceTypes: readonly PiPackageResourceKind[];
	readonly author: string;
	readonly monthlyDownloads?: number;
	readonly publishedAt?: string;
	readonly repository: string;
	readonly bugsUrl?: string;
	readonly npmUrl: string;
	readonly catalogListed: boolean;
	readonly piMaintained: boolean;
	readonly installed: boolean;
	readonly installCommand: string;
};

export type PiExtensionManifest = {
	readonly name: string;
	readonly version?: string;
	readonly description?: string;
	readonly author?: unknown;
	readonly repository?: unknown;
	readonly pi?: unknown;
	readonly keywords?: unknown;
	readonly [key: string]: unknown;
};

export type PiExtensionResult =
	| {readonly ok: true; readonly package: PiExtensionPackage; readonly output?: string}
	| {readonly ok: false; readonly error: string; readonly output?: string};

export type PiExtensionSearchPage = {
	readonly items: readonly PiExtensionPackage[];
	readonly page: number;
	readonly pageSize: number;
	readonly total: number;
	readonly hasPrevious: boolean;
	readonly hasNext: boolean;
};

type ExtensionCatalogResponse = {
	readonly ok: boolean;
	readonly status: number;
	readonly json: () => Promise<unknown>;
};

export type ExtensionCatalogRequest = (
	url: string,
	init?: {readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal}
) => Promise<ExtensionCatalogResponse>;

export type ExtensionCommandDeps = {
	readonly exec?: typeof execCommand;
	readonly piInstalled?: () => Promise<boolean>;
	/** 官方 npm Registry 搜索与 Downloads API 的可注入请求边界。 */
	readonly request?: ExtensionCatalogRequest;
	readonly signal?: AbortSignal;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	if (typeof value === 'string') return value;
	if (isObject(value)) return text(value.name) || text(value.username) || text(value.email) || text(value.url);
	return '';
}

function hasResource(value: unknown): boolean {
	return Array.isArray(value) ? value.length > 0 : isObject(value) || typeof value === 'string';
}

export function resourceTypesFromPiManifest(manifest: PiExtensionManifest): readonly PiPackageResourceKind[] {
	const pi = isObject(manifest.pi) ? manifest.pi : {};
	const result: PiPackageResourceKind[] = [];
	if (hasResource(pi.extensions)) result.push('extension');
	if (hasResource(pi.skills)) result.push('skill');
	if (hasResource(pi.prompts)) result.push('prompt');
	if (hasResource(pi.themes)) result.push('theme');
	return result;
}

export function isPiTeamMaintained(manifest: Pick<PiExtensionManifest, 'author' | 'repository'>): boolean {
	const source = `${text(manifest.author)} ${text(manifest.repository)}`.toLowerCase();
	return source.includes('earendil') || source.includes('pi-mono') || source.includes('badlogic');
}

export function piResourceLabel(types: readonly PiPackageResourceKind[]): string {
	const labels: Record<PiPackageResourceKind, string> = {extension: 'extension', skill: 'skill', prompt: 'prompt', theme: 'theme'};
	return types.map(type => labels[type]).join('、');
}

function repositoryUrl(value: unknown): string {
	if (typeof value === 'string') return value;
	if (isObject(value)) return text(value.url) || text(value.directory);
	return '';
}

function issueUrl(value: unknown): string {
	if (typeof value === 'string') return value;
	if (isObject(value)) return text(value.url);
	return '';
}

function latestPublishedAt(manifest: PiExtensionManifest): string {
	const version = text(manifest.version);
	if (!version || !isObject(manifest.time)) return '';
	const publishedAt = manifest.time[version];
	return typeof publishedAt === 'string' ? publishedAt : '';
}

export function packageFromManifest(
	manifest: PiExtensionManifest,
	options: {
		readonly catalogListed?: boolean;
		readonly installed?: boolean;
		readonly source?: string;
		readonly monthlyDownloads?: number;
		readonly publishedAt?: string;
		readonly bugsUrl?: string;
	} = {}
): PiExtensionPackage | null {
	const name = text(manifest.name);
	if (!name) return null;
	const resourceTypes = resourceTypesFromPiManifest(manifest);
	if (resourceTypes.length === 0) return null;
	const type = resourceTypes.includes('extension') ? 'extension' : resourceTypes[0]!;
	const version = text(manifest.version);
	const bugsUrl = options.bugsUrl ?? issueUrl(manifest.bugs);
	const publishedAt = options.publishedAt ?? latestPublishedAt(manifest);
	return {
		name,
		source: options.source ?? `npm:${name}`,
		version,
		description: text(manifest.description),
		type,
		resourceTypes,
		author: text(manifest.author) || '未知作者',
		...(options.monthlyDownloads === undefined ? {} : {monthlyDownloads: options.monthlyDownloads}),
		...(publishedAt ? {publishedAt} : {}),
		repository: repositoryUrl(manifest.repository),
		...(bugsUrl ? {bugsUrl} : {}),
		npmUrl: `https://www.npmjs.com/package/${name}`,
		catalogListed: options.catalogListed ?? false,
		piMaintained: isPiTeamMaintained(manifest),
		installed: options.installed ?? false,
		installCommand: `pi install npm:${name}`
	};
}

export function fixedPiMcpAdapterPackage(installed = false): PiExtensionPackage {
	return {
		name: PI_MCP_ADAPTER_ID,
		source: PI_MCP_ADAPTER_SPEC,
		version: '',
		description: '为 Pi 提供共享 MCP 定义适配与 Pi-owned overrides',
		type: 'extension',
		resourceTypes: ['extension'],
		author: 'Pi package catalog / community',
		repository: 'https://pi.dev/packages/pi-mcp-adapter',
		npmUrl: 'https://www.npmjs.com/package/pi-mcp-adapter',
		catalogListed: true,
		piMaintained: false,
		installed,
		installCommand: `pi install ${PI_MCP_ADAPTER_SPEC}`
	};
}

export function installedPiPackagePlaceholder(source: string): PiExtensionPackage {
	const name = displayPackageName(source);
	return {
		name,
		source,
		version: '',
		description: '已安装的 Pi package；未读取到可公开查询的 manifest',
		type: 'extension',
		resourceTypes: ['extension'],
		author: '未知作者',
		repository: '',
		npmUrl: name.startsWith('@') || /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? `https://www.npmjs.com/package/${name}` : '',
		catalogListed: false,
		piMaintained: false,
		installed: true,
		installCommand: `pi install ${source}`
	};
}

function displayPackageName(source: string): string {
	const normalized = source.replace(/^npm:/, '');
	if (normalized.startsWith('git:') || /^[a-z]+:\/\//i.test(normalized) || normalized.startsWith('.') || normalized.startsWith('/')) {
		return normalized;
	}
	return normalized.replace(/^(@[^/]+\/[^@]+|[^@]+)@[^@]+$/, '$1');
}

export function piPackageDetailsUrl(name: string): string {
	const normalized = displayPackageName(name);
	return `${PI_PACKAGE_CATALOG_DETAILS_URL}/${normalized
		.split('/')
		.map(part => encodeURIComponent(part))
		.join('/')}`;
}

function npmSearchArgs(query: string, limit = PI_EXTENSION_SEARCH_PAGE_SIZE): string[] {
	const terms = query.trim() ? [query.trim(), `keywords:${PI_PACKAGE_KEYWORD}`] : [`keywords:${PI_PACKAGE_KEYWORD}`];
	return ['search', '--json', '--searchlimit', String(limit), ...terms];
}

function parseJson<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

type PiCatalogCandidate = {
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly author: unknown;
	readonly repository: unknown;
	readonly monthlyDownloads?: number;
	readonly publishedAt?: string;
	readonly bugsUrl?: string;
};

function searchItemToCandidate(item: Record<string, unknown>): PiCatalogCandidate | null {
	const packageItem = isObject(item.package) ? item.package : item;
	const keywords = Array.isArray(packageItem.keywords) ? packageItem.keywords.map(keyword => String(keyword)) : [];
	if (!keywords.includes(PI_PACKAGE_KEYWORD)) return null;
	const links = isObject(packageItem.links) ? packageItem.links : undefined;
	const name = text(packageItem.name);
	const downloads = isObject(item.downloads) ? item.downloads.monthly : undefined;
	const monthlyDownloads = typeof downloads === 'number' && Number.isFinite(downloads) ? Math.max(0, Math.floor(downloads)) : undefined;
	const publishedAt = text(packageItem.date);
	return name
		? {
				name,
				description: text(packageItem.description),
				version: text(packageItem.version),
				author: packageItem.author ?? packageItem.publisher ?? packageItem.maintainers,
				repository: links?.repository ?? packageItem.repository,
				...(monthlyDownloads === undefined ? {} : {monthlyDownloads}),
				...(publishedAt ? {publishedAt} : {}),
				...(text(links?.bugs) ? {bugsUrl: text(links?.bugs)} : {})
			}
		: null;
}

type CatalogPagePayload = {
	readonly objects: readonly unknown[];
	readonly total: number;
};

function catalogPageFromPayload(payload: unknown): CatalogPagePayload {
	if (Array.isArray(payload)) return {objects: payload, total: payload.length};
	if (!isObject(payload) || !Array.isArray(payload.objects)) throw new Error('官方 Pi package 目录返回了无效 JSON');
	const total = typeof payload.total === 'number' && Number.isFinite(payload.total) ? Math.max(0, payload.total) : payload.objects.length;
	return {objects: payload.objects, total};
}

async function inspectCatalogCandidates(
	candidates: readonly PiCatalogCandidate[],
	exec: typeof execCommand
): Promise<readonly PiExtensionPackage[]> {
	const inspected = await Promise.all(
		candidates.map(async candidate => {
			try {
				const detail = await exec('npm', ['view', `${candidate.name}@latest`, '--json'], {timeout: 30000});
				if (detail.code !== 0) return null;
				const manifest = parseJson<PiExtensionManifest>(detail.stdout || '');
				const packageInfo = manifest
					? packageFromManifest(manifest, {
							catalogListed: true,
							monthlyDownloads: candidate.monthlyDownloads,
							publishedAt: candidate.publishedAt,
							bugsUrl: candidate.bugsUrl
						})
					: null;
				// A keyword hit alone is not enough: only packages with a real `pi.extensions`
				// resource are installable from the extension list.
				return packageInfo?.resourceTypes.includes('extension') ? packageInfo : null;
			} catch {
				return null;
			}
		})
	);
	return inspected.filter((item): item is PiExtensionPackage => item !== null);
}

export async function requestPiPackageCatalog(
	url: string,
	init?: {readonly headers?: Readonly<Record<string, string>>; readonly signal?: AbortSignal}
): Promise<ExtensionCatalogResponse> {
	const timeoutController = init?.signal ? undefined : new AbortController();
	const timeout = timeoutController ? setTimeout(() => timeoutController.abort(), 30000) : undefined;
	try {
		return await fetch(url, {
			headers: init?.headers,
			signal: init?.signal ?? timeoutController?.signal
		});
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function npmPackageName(value: string): boolean {
	return /^@[^/\s]+\/[^/\s]+$|^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

async function monthlyDownloadsForNpmPackage(name: string, request: ExtensionCatalogRequest): Promise<number | undefined> {
	if (!npmPackageName(name)) return undefined;
	const url = `${PI_PACKAGE_DOWNLOADS_URL}/${encodeURIComponent(name)}`;
	try {
		const response = await request(url, {headers: {accept: 'application/json'}});
		if (!response.ok) {
			console.error(`[extensions] 读取 ${name} 月下载量失败 (HTTP ${response.status})`);
			return undefined;
		}
		const payload = await response.json();
		const downloads = isObject(payload) ? payload.downloads : undefined;
		return typeof downloads === 'number' && Number.isFinite(downloads) ? Math.max(0, Math.floor(downloads)) : undefined;
	} catch (reason) {
		console.error(`[extensions] 读取 ${name} 月下载量失败`, reason);
		return undefined;
	}
}

/** 读取已安装 npm package 的月下载量；manifest 不可读时也可独立使用。 */
export function fetchPiPackageMonthlyDownloads(name: string, request: ExtensionCatalogRequest): Promise<number | undefined> {
	return monthlyDownloadsForNpmPackage(displayPackageName(name), request);
}

function registrySearchUrl(query: string, page: number, pageSize: number): string {
	const url = new URL(PI_PACKAGE_CATALOG_SEARCH_URL);
	url.searchParams.set('text', [query.trim(), `keywords:${PI_PACKAGE_KEYWORD}`].filter(Boolean).join(' '));
	url.searchParams.set('size', String(pageSize));
	url.searchParams.set('from', String(page * pageSize));
	return url.toString();
}

async function searchPiPackageCatalogViaRegistry(
	query: string,
	page: number,
	exec: typeof execCommand,
	request: ExtensionCatalogRequest
): Promise<PiExtensionSearchPage> {
	const response = await request(registrySearchUrl(query, page, PI_EXTENSION_SEARCH_PAGE_SIZE), {
		headers: {accept: 'application/json'}
	});
	if (!response.ok) throw new Error(`官方 Pi package 目录搜索失败 (HTTP ${response.status})`);
	const payload = catalogPageFromPayload(await response.json());
	const candidates = payload.objects
		.filter(isObject)
		.map(searchItemToCandidate)
		.filter((item): item is PiCatalogCandidate => item !== null);
	const items = await inspectCatalogCandidates(candidates, exec);
	return {
		items,
		page,
		pageSize: PI_EXTENSION_SEARCH_PAGE_SIZE,
		total: payload.total,
		hasPrevious: page > 0,
		hasNext: (page + 1) * PI_EXTENSION_SEARCH_PAGE_SIZE < payload.total
	};
}

async function searchPiPackageCatalogViaNpm(query: string, page: number, exec: typeof execCommand): Promise<PiExtensionSearchPage> {
	const limit = Math.min(250, (page + 1) * PI_EXTENSION_SEARCH_PAGE_SIZE);
	const result = await exec('npm', npmSearchArgs(query, limit), {timeout: 30000});
	if (result.code !== 0) throw new Error(result.stderr || `npm package 目录搜索失败 (exit ${result.code})`);
	const parsed = parseJson<unknown>(result.stdout || '[]');
	const payload = catalogPageFromPayload(parsed);
	const candidates = payload.objects
		.slice(page * PI_EXTENSION_SEARCH_PAGE_SIZE, (page + 1) * PI_EXTENSION_SEARCH_PAGE_SIZE)
		.filter(isObject)
		.map(searchItemToCandidate)
		.filter((item): item is PiCatalogCandidate => item !== null);
	const items = await inspectCatalogCandidates(candidates, exec);
	const total = Math.max(payload.total, payload.objects.length);
	return {
		items,
		page,
		pageSize: PI_EXTENSION_SEARCH_PAGE_SIZE,
		total,
		hasPrevious: page > 0,
		hasNext: (page + 1) * PI_EXTENSION_SEARCH_PAGE_SIZE < total || payload.objects.length >= limit
	};
}

export async function searchPiPackageCatalogPage(
	query = '',
	page = 0,
	deps: Pick<ExtensionCommandDeps, 'exec' | 'request'> = {}
): Promise<PiExtensionSearchPage> {
	const normalizedPage = Math.max(0, Math.floor(page));
	const exec = deps.exec ?? execCommand;
	// Tests and embedders that inject only an exec seam retain the npm CLI path. The
	// production default uses the registry's explicit `from`/`size` pagination.
	if (deps.request || exec === execCommand) {
		return searchPiPackageCatalogViaRegistry(query, normalizedPage, exec, deps.request ?? requestPiPackageCatalog);
	}
	return searchPiPackageCatalogViaNpm(query, normalizedPage, exec);
}

export async function searchPiPackageCatalog(query = '', exec: typeof execCommand = execCommand): Promise<readonly PiExtensionPackage[]> {
	const page = await searchPiPackageCatalogPage(query, 0, {exec});
	return page.items;
}

export async function inspectPiPackage(
	name: string,
	exec: typeof execCommand = execCommand,
	request?: ExtensionCatalogRequest
): Promise<PiExtensionPackage | null> {
	const manifestName = displayPackageName(name);
	const result = await exec('npm', ['view', `${manifestName}@latest`, '--json'], {timeout: 30000});
	if (result.code !== 0) throw new Error(result.stderr || `无法读取 ${name} 的 npm manifest (exit ${result.code})`);
	const manifest = parseJson<PiExtensionManifest>(result.stdout || '');
	if (!manifest) return null;
	const packageInfo = packageFromManifest(manifest, {
		catalogListed: true,
		source: name.startsWith('npm:') ? name : `npm:${manifestName}`
	});
	if (!packageInfo || !packageInfo.resourceTypes.includes('extension') || !request) return packageInfo;
	const monthlyDownloads = await fetchPiPackageMonthlyDownloads(manifestName, request);
	return monthlyDownloads === undefined ? packageInfo : {...packageInfo, monthlyDownloads};
}

function packageNameFromRecord(item: unknown): string {
	const raw =
		typeof item === 'string' ? item : isObject(item) ? text(item.name) || text(item.source) || text(item.package) || text(item.id) : '';
	return raw.replace(/^npm:/, '').replace(/@latest$/, '');
}

function packageNameFromListLine(line: string): string {
	const source = line.trim();
	if (!source) return '';
	const indentation = line.match(/^\s*/)?.[0].length ?? 0;
	if (indentation > 2 && /^(?:[A-Za-z]:[\\/]|\/)/.test(source)) return '';
	return /^(?:npm:|git:|https?:\/\/|file:|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(source) ? packageNameFromRecord(source) : '';
}

export async function listPiPackages(exec: typeof execCommand = execCommand): Promise<readonly string[]> {
	const result = await exec('pi', ['list', '--no-approve'], {timeout: 15000});
	if (result.code !== 0) throw new Error(result.stderr || `pi list 失败 (exit ${result.code})`);
	const parsed = parseJson<unknown>(result.stdout || '');
	if (Array.isArray(parsed)) return parsed.map(packageNameFromRecord).filter(Boolean);
	if (isObject(parsed) && Array.isArray(parsed.packages)) return parsed.packages.map(packageNameFromRecord).filter(Boolean);
	return (result.stdout || '').split(/\r?\n/).map(packageNameFromListLine).filter(Boolean);
}

export async function isPiCliInstalled(exec: typeof execCommand = execCommand): Promise<boolean> {
	try {
		return (await detectTool(TOOL_DEFINITIONS.find(definition => definition.id === 'PiCli')!, exec)).installed;
	} catch {
		return false;
	}
}

async function runPiCommand(
	args: readonly string[],
	component: string,
	deps: ExtensionCommandDeps,
	onProgress?: ProgressCallback
): Promise<ExecResult> {
	const exec = deps.exec ?? execCommand;
	const installed = deps.piInstalled ? await deps.piInstalled() : await isPiCliInstalled(exec);
	if (!installed) throw new Error('需要先安装 Pi Agent CLI，才能管理 Pi package 扩展');
	if (deps.signal) throwIfAborted(deps.signal);
	onProgress?.({
		level: 'info',
		message: `pi ${args.join(' ')}`,
		componentId: component,
		instruction: formatCommandInstruction('pi', args)
	});
	const result = await exec('pi', [...args], {timeout: 120000, signal: deps.signal});
	if (deps.signal) throwIfAborted(deps.signal);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `pi 命令失败 (exit ${result.code})`);
	return result;
}

function packageIsNamed(packages: readonly string[], name: string): boolean {
	const normalized = displayPackageName(name);
	return packages.some(item => displayPackageName(item) === normalized);
}

async function reconcilePiPackage(name: string, wanted: boolean, exec: typeof execCommand): Promise<readonly string[]> {
	const packages = await listPiPackages(exec);
	if (packageIsNamed(packages, name) !== wanted) {
		throw new Error(`Pi package 状态对账失败：${name} ${wanted ? '未出现在已安装列表' : '仍出现在已安装列表'}`);
	}
	return packages;
}

export async function installPiPackage(
	nameOrSpec: string,
	deps: ExtensionCommandDeps = {},
	onProgress?: ProgressCallback
): Promise<PiExtensionResult> {
	try {
		const spec = nameOrSpec.startsWith('npm:') ? nameOrSpec : `npm:${nameOrSpec}`;
		const exec = deps.exec ?? execCommand;
		const result = await runPiCommand(['install', spec], nameOrSpec, deps, onProgress);
		await reconcilePiPackage(nameOrSpec, true, exec);
		return {
			ok: true,
			package: packageFromManifest(
				{name: displayPackageName(nameOrSpec), pi: {extensions: ['unknown']}},
				{installed: true, source: nameOrSpec.startsWith('npm:') ? nameOrSpec : `npm:${nameOrSpec}`}
			)!,
			output: result.stdout
		};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export async function updatePiPackage(name: string, deps: ExtensionCommandDeps = {}, onProgress?: ProgressCallback): Promise<ExecResult> {
	const exec = deps.exec ?? execCommand;
	const result = await runPiCommand(['update', '--extension', name], name, deps, onProgress);
	await reconcilePiPackage(name, true, exec);
	return result;
}

export async function removePiPackage(name: string, deps: ExtensionCommandDeps = {}, onProgress?: ProgressCallback): Promise<ExecResult> {
	const exec = deps.exec ?? execCommand;
	const result = await runPiCommand(['remove', name.replace(/^npm:/, '')], name, deps, onProgress);
	await reconcilePiPackage(name, false, exec);
	return result;
}

export async function installPiMcpAdapter(deps: ExtensionCommandDeps = {}, onProgress?: ProgressCallback): Promise<PiExtensionResult> {
	return installPiPackage(PI_MCP_ADAPTER_SPEC, deps, onProgress);
}
