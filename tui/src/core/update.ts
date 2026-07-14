import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync, renameSync} from 'node:fs';
import {basename, join, dirname, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {atomicWrite, readJsonFile} from './fs-utils.js';
import {claudeDir, claudeJsonPath, ccqDir, resolveHome, settingsPath, skillsDir} from './paths.js';
import {execCommand, type ProgressCallback} from './exec.js';
import {refreshNpmGlobalBinPath} from './npm-path.js';
import {hasUpdate} from './semver.js';
import {installTool, TOOL_DEFINITIONS} from './tools-install.js';
import {codeGraphInstallCommands} from './tools-lifecycle.js';
import {hasCodeGraphIntegration, installedCodeGraphContexts, hasClaudeCcgWorkflowMode, hasCodexCcgWorkflowMode} from './tools-integrations.js';
import type {AgentContext} from '../state/manage-state.js';

// Update core：版本检测、快照、应用、汇总。检测返回 Promise 支持后台并发（design D12/D13）。
// 进度通过 onProgress(event) 上报，不直接 console.log。

const NPM_OUTDATED_CACHE_TTL_MS = 60 * 60 * 1000;
const SNAPSHOT_DIR = join(tmpdir(), 'ClaudeEnvInstaller');

function tmpCacheDir(): string {
	const uid = process.getuid ? process.getuid() : process.pid;
	return join(tmpdir(), `ccq-cache-${uid}`);
}

function npmOutdatedCachePath(): string {
	return join(tmpCacheDir(), 'npm-outdated.json');
}

export type UpdateComponentType = 'npm' | 'cli' | 'skill' | 'mcp';

export type UpdateComponent = {
	readonly id: string;
	readonly name: string;
	readonly type: UpdateComponentType;
	readonly package?: string;
	readonly installed: boolean;
	readonly currentVersion: string;
	readonly latestVersion: string;
	readonly hasUpdate: boolean | null;
	readonly statusHint?: string;
};

type NpmOutdated = Record<string, {latest?: string}>;

// id → npm 包名映射，派生自 registry（DRY，单一真理源 tools-install.TOOL_DEFINITIONS）：
// 取所有标注 npmPackage 的组件（含 CcgWorkflow 的 ccg-workflow 引擎包；Antigravity 无 npmPackage 故排除）。
const NPM_COMPONENT_MAP: Record<string, string> = Object.fromEntries(
	TOOL_DEFINITIONS.filter(def => def.npmPackage).map(def => [def.id, def.npmPackage as string])
);

// CcgWorkflow 包名单一真理源（检测与 applyUpdates 特判共用），派生自 registry，守卫锁定 package='ccg-workflow'
const CCG_NPM_PACKAGE = NPM_COMPONENT_MAP['CcgWorkflow'] ?? 'ccg-workflow';

// id → 检测命令映射，派生自 registry：全 registry 组件均含 command/versionArgs。
const COMMAND_COMPONENTS: Record<string, {command: string; versionArgs: string[]}> = Object.fromEntries(
	TOOL_DEFINITIONS.map(def => [def.id, {command: def.command, versionArgs: [...def.versionArgs]}])
);

function ensureDir(dirPath: string): void {
	if (!existsSync(dirPath)) {
		mkdirSync(dirPath, {recursive: true, mode: 0o700});
	}
}

function readNpmOutdatedCache(): NpmOutdated | null {
	const cachePath = npmOutdatedCachePath();
	if (!existsSync(cachePath)) {
		return null;
	}

	try {
		const stat = statSync(cachePath);
		if (Date.now() - stat.mtimeMs > NPM_OUTDATED_CACHE_TTL_MS) {
			return null;
		}

		const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
		if (!cached || typeof cached !== 'object' || Array.isArray(cached)) {
			return null;
		}

		return cached as NpmOutdated;
	} catch {
		return null;
	}
}

function writeNpmOutdatedCache(outdated: NpmOutdated): void {
	ensureDir(tmpCacheDir());
	atomicWrite(npmOutdatedCachePath(), JSON.stringify(outdated || {}, null, 2));
}

// export 供 tools-manage.ts 的 detectComponents 复用（DRY：CLI 组件检测单一真理源）。
// checkComponentUpdates 仍聚合 Skills/MCP；tools-manage.detectComponents 只取 CLI 部分。
export async function getNpmOutdatedGlobal(forceRefresh = false): Promise<NpmOutdated> {
	if (!forceRefresh) {
		const cached = readNpmOutdatedCache();
		if (cached) {
			return cached;
		}
	}

	const result = await execCommand('npm', ['outdated', '-g', '--json'], {timeout: 30000});
	let outdated: NpmOutdated = {};
	if (result.stdout && result.stdout.trim()) {
		try {
			outdated = JSON.parse(result.stdout) as NpmOutdated;
		} catch {
			outdated = {};
		}
	}

	writeNpmOutdatedCache(outdated);
	return outdated;
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && /命令超时|timed out|timeout/i.test(error.message);
}

async function execVersionCommand(command: string, args: readonly string[]): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> {
	try {
		return await execCommand(command, args, {timeout: 5000});
	} catch (error) {
		if (isTimeoutError(error)) {
			return execCommand(command, args, {timeout: 5000});
		}

		throw error;
	}
}

async function getCommandVersion(command: string, args: string[]): Promise<{installed: boolean; version: string}> {
	try {
		const result = await execVersionCommand(command, args);
		if (result.code !== 0) {
			return {installed: false, version: ''};
		}

		const text = (result.stdout || result.stderr || '').trim();
		const version = (text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/) || [text])[0] || '';
		return {installed: true, version};
	} catch {
		return {installed: false, version: ''};
	}
}

// ── CcgWorkflow 专用检测 ───────────────────────────────────────────────────
// ccg-workflow 是经 `npx ccg-workflow@latest init` 装入 ~/.claude 的非全局包，
// 与其它 npm 全局包不同：
//   1. 本地版本不在 `codeagent-wrapper --version`（那是独立二进制，版本体系不同），
//      而在 ~/.claude/.ccg/config.toml 的 version = "..."（ccg-workflow 引擎版本单一真理源）。
//   2. 远程最新版本不在 `npm outdated -g`（非全局包查不到），需 `npm view` 单包查询。
// CcgWorkflow 已从安装步骤降级为 TUI 工具项，其安装/更新统一在 manage TUI 维护。
// 守卫 verify-update-scope.mjs 锁定 type='npm' / package='ccg-workflow'，故二者保持不变，
// 仅检测来源与更新动作（applyUpdates）走专用分支。

/** 读取 CcgWorkflow 本地版本：从 ~/.claude/.ccg/config.toml 提取 version。 */
function readCcgLocalVersion(): {installed: boolean; version: string} {
	const configPath = join(claudeDir(), '.ccg', 'config.toml');
	if (!existsSync(configPath)) {
		return {installed: false, version: ''};
	}

	try {
		const content = readFileSync(configPath, 'utf8');
		const match = content.match(/version\s*=\s*"([^"]+)"/);
		const version = match?.[1]?.trim();
		if (version) {
			return {installed: true, version};
		}

		// config.toml 存在但 version 不可读 → 已安装但版本未知
		return {installed: true, version: ''};
	} catch {
		return {installed: false, version: ''};
	}
}

type NpmViewCache = Record<string, string>;

function npmViewCachePath(): string {
	return join(tmpCacheDir(), 'npm-view.json');
}

function readNpmViewCache(): NpmViewCache | null {
	const cachePath = npmViewCachePath();
	if (!existsSync(cachePath)) {
		return null;
	}

	try {
		const stat = statSync(cachePath);
		if (Date.now() - stat.mtimeMs > NPM_OUTDATED_CACHE_TTL_MS) {
			return null;
		}

		const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
		if (!cached || typeof cached !== 'object' || Array.isArray(cached)) {
			return null;
		}

		return cached as NpmViewCache;
	} catch {
		return null;
	}
}

function writeNpmViewCache(cache: NpmViewCache): void {
	ensureDir(tmpCacheDir());
	atomicWrite(npmViewCachePath(), JSON.stringify(cache || {}, null, 2));
}

/** 纯查询单包最新版本（`npm view <pkg> version`，不读写缓存）。 */
async function npmViewLatestUncached(packageName: string): Promise<string> {
	try {
		const result = await execCommand('npm', ['view', packageName, 'version'], {timeout: 30000});
		if (result.code === 0) {
			return result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
		}
	} catch {
		// 查询失败不阻塞，返回空串
	}

	return '';
}

/**
 * 批量解析多个 npm 包的最新版本，带整文件 TTL 缓存（对齐 getNpmOutdatedGlobal 语义）。
 * 缓存完整命中时直接返回；缓存缺包（兼容旧单包缓存）时只补查缺失包并一次性写回，
 * 避免逐包写入相互覆盖导致后续组件读到不完整缓存。
 */
async function resolveNpmViewLatest(packageNames: readonly string[], forceRefresh = false): Promise<NpmViewCache> {
	const cached = forceRefresh ? null : readNpmViewCache();
	if (cached && packageNames.every(packageName => Object.prototype.hasOwnProperty.call(cached, packageName))) {
		return cached;
	}

	const resolved: NpmViewCache = {...(cached ?? {})};
	for (const packageName of packageNames) {
		if (!forceRefresh && Object.prototype.hasOwnProperty.call(resolved, packageName)) {
			continue;
		}

		// eslint-disable-next-line no-await-in-loop -- 串行查询，包数量少（≤6），避免并发 npm view 抖动
		resolved[packageName] = await npmViewLatestUncached(packageName);
	}

	writeNpmViewCache(resolved);
	return resolved;
}

/**
 * 构建 CcgWorkflow 更新状态（config.toml 本地版本 vs npm view 远程版本）。
 * 对齐 buildNpmComponentStatus 的字段语义：installed/current/latest/hasUpdate。
 */
async function buildCcgWorkflowStatus(latestByPackage: NpmViewCache): Promise<UpdateComponent> {
	const local = readCcgLocalVersion();
	const latest = latestByPackage[CCG_NPM_PACKAGE] || '';
	const currentVersion = local.version;

	return {
		id: 'CcgWorkflow',
		name: 'CcgWorkflow',
		type: 'npm', // 守卫锁定，applyUpdates 按 package 特判走 npx init
		package: CCG_NPM_PACKAGE,
		installed: local.installed,
		currentVersion,
		latestVersion: latest || currentVersion,
		hasUpdate: local.installed ? (latest ? hasUpdate(currentVersion, latest) : false) : null
	};
}

async function buildNpmComponentStatus(
	id: string,
	packageName: string,
	outdated: NpmOutdated,
	latestByPackage: NpmViewCache
): Promise<UpdateComponent> {
	const commandInfo = COMMAND_COMPONENTS[id];
	const versionInfo = commandInfo
		? await getCommandVersion(commandInfo.command, commandInfo.versionArgs)
		: {installed: false, version: ''};
	const remote = outdated[packageName];
	const latestVersion = remote?.latest || latestByPackage[packageName] || versionInfo.version;

	return {
		id,
		name: id,
		type: 'npm',
		package: packageName,
		installed: versionInfo.installed,
		currentVersion: versionInfo.version,
		latestVersion,
		hasUpdate: versionInfo.installed ? (latestVersion ? hasUpdate(versionInfo.version, latestVersion) : false) : null
	};
}

async function buildAntigravityStatus(): Promise<UpdateComponent> {
	const versionInfo = await getCommandVersion('agy', ['--version']);
	return {
		id: 'AntigravityCli',
		name: 'AntigravityCli',
		type: 'cli',
		installed: versionInfo.installed,
		currentVersion: versionInfo.version,
		latestVersion: '',
		hasUpdate: null,
		statusHint: '无法获取更新状态，执行 agy update 更新'
	};
}

// export 供 tools-manage.ts 的 detectComponents 复用：返回 8 个 CLI 组件
// （ClaudeCode/Ccline/CcgWorkflow/OpenSpec/Trellis/CodeGraph/CodexCli + AntigravityCli），不含 Skills/MCP。
export async function checkCliToolUpdates(outdated: NpmOutdated, forceRefresh = false): Promise<UpdateComponent[]> {
	await refreshNpmGlobalBinPath();
	const latestByPackage = await resolveNpmViewLatest(Object.values(NPM_COMPONENT_MAP), forceRefresh);
	const components: UpdateComponent[] = [];
	for (const [id, packageName] of Object.entries(NPM_COMPONENT_MAP)) {
		if (id === 'CcgWorkflow') {
			// 非全局包：config.toml 本地版本 + npm view 远程版本（不依赖 outdated 全局列表）
			components.push(await buildCcgWorkflowStatus(latestByPackage));
		} else {
			components.push(await buildNpmComponentStatus(id, packageName, outdated, latestByPackage));
		}
	}

	components.push(await buildAntigravityStatus());
	return components;
}

async function checkSkillsUpdates(outdated: NpmOutdated): Promise<UpdateComponent[]> {
	const dir = skillsDir();
	if (!existsSync(dir)) {
		return [];
	}

	const entries = readdirSync(dir, {withFileTypes: true}).filter(entry => entry.isDirectory());
	const skills: UpdateComponent[] = [];

	for (const entry of entries) {
		const pkg = readJsonFile<{name?: string; version?: string} | null>(join(dir, entry.name, 'package.json'), null);
		if (!pkg) {
			continue;
		}

		const packageName = pkg.name || entry.name;
		const currentVersion = pkg.version || '';
		const remote = outdated[packageName];
		skills.push({
			id: `Skill:${entry.name}`,
			name: entry.name,
			type: 'skill',
			package: packageName,
			installed: true,
			currentVersion,
			latestVersion: remote?.latest || currentVersion,
			hasUpdate: remote ? hasUpdate(currentVersion, remote.latest || '') : false
		});
	}

	return skills;
}

function extractNpmPackageFromArgs(args: unknown): string {
	if (!Array.isArray(args)) {
		return '';
	}

	for (const arg of args) {
		if (typeof arg !== 'string' || arg.startsWith('-') || arg.includes('://')) {
			continue;
		}

		if (/^(?:@[^/\s]+\/[^@\s]+|[a-z0-9._-]+)(?:@[^\s]+)?$/i.test(arg)) {
			return arg;
		}
	}

	return '';
}

function checkMcpServerUpdates(): UpdateComponent[] {
	const servers: UpdateComponent[] = [];
	const seen = new Set<string>();
	const configFiles = [settingsPath(), claudeJsonPath()];

	for (const configPath of configFiles) {
		const cfg = readJsonFile<Record<string, unknown> | null>(configPath, null);
		if (!cfg) {
			continue;
		}

		const candidates: unknown[] = [cfg.mcpServers];
		const projects = cfg.projects as Record<string, {mcpServers?: unknown}> | undefined;
		if (projects && typeof projects === 'object') {
			for (const project of Object.values(projects)) {
				candidates.push(project?.mcpServers);
			}
		}

		for (const mcpServers of candidates) {
			if (!mcpServers || typeof mcpServers !== 'object') {
				continue;
			}

			for (const [name, server] of Object.entries(mcpServers as Record<string, {args?: unknown}>)) {
				const packageName = extractNpmPackageFromArgs(server?.args);
				if (!packageName) {
					continue;
				}

				const key = `${name}:${packageName}`;
				if (seen.has(key)) {
					continue;
				}

				seen.add(key);
				servers.push({
					id: `Mcp:${name}`,
					name: `MCP ${name}`,
					type: 'mcp',
					package: packageName,
					installed: true,
					currentVersion: 'configured',
					latestVersion: '',
					hasUpdate: null,
					statusHint: 'npx/远程 MCP 无稳定本地版本，按 registry 配置展示'
				});
			}
		}
	}

	return servers;
}

/**
 * 检测全部组件更新状态（CLI / Skills / MCP），返回 Promise 支持后台并发执行。
 * 检测范围收缩（HC-FU-08）：不再检测 ClaudeConfig 漂移、ClaudeMd 指纹、CcgWorkflow rules
 * 等用户配置/规则类项；ccg-workflow npm 引擎更新经 checkCliToolUpdates 保留（HC-FU-09）。
 */
export async function checkComponentUpdates(onProgress?: ProgressCallback): Promise<UpdateComponent[]> {
	onProgress?.({level: 'info', message: '正在检测组件状态与远程版本...'});
	const outdated = await getNpmOutdatedGlobal(false);
	return [
		...(await checkCliToolUpdates(outdated)),
		...(await checkSkillsUpdates(outdated)),
		...checkMcpServerUpdates()
	];
}

// ── 快照层 ─────────────────────────────────────────────────────────────────

function sha256File(filePath: string): string | null {
	if (!existsSync(filePath)) {
		return null;
	}

	return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 收集需要快照的文件（settings/CLAUDE.md/.claude.json/vault + ccq-/ccg- rules）。 */
export function getSnapshotFiles(): string[] {
	const files = [
		settingsPath(),
		claudeJsonPath(),
		join(claudeDir(), 'CLAUDE.md'),
		join(ccqDir(), 'mcp-meta.json')
	];

	const rules = join(claudeDir(), 'rules');
	if (existsSync(rules)) {
		for (const file of readdirSync(rules)) {
			if ((file.startsWith('ccq-') || file.startsWith('ccg-')) && file.endsWith('.md')) {
				files.push(join(rules, file));
			}
		}
	}

	return files.filter(file => existsSync(file));
}

/** 创建更新快照（带 canary 探针 + manifest，对齐旧 createSnapshot）。 */
export function createSnapshot(): string {
	ensureDir(SNAPSHOT_DIR);
	const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
	const suffix = randomBytes(4).toString('hex');
	const snapshotPath = join(SNAPSHOT_DIR, `update_${timestamp}_${process.pid}_${suffix}`);
	ensureDir(snapshotPath);

	const canaryPath = join(snapshotPath, '_canary.tmp');
	writeFileSync(canaryPath, 'canary\n');
	rmSync(canaryPath);

	const home = resolveHome();
	const manifest = {createdAt: new Date().toISOString(), files: [] as Array<{source: string; relative: string; hash: string | null}>};
	for (const sourcePath of getSnapshotFiles()) {
		const rel = relative(home, sourcePath);
		const destPath = join(snapshotPath, rel);
		ensureDir(dirname(destPath));
		copyFileSync(sourcePath, destPath);
		manifest.files.push({source: sourcePath, relative: rel, hash: sha256File(sourcePath)});
	}

	atomicWrite(join(snapshotPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
	return snapshotPath;
}

/** 从快照恢复（校验 hash，对齐旧 rollbackFromSnapshot）。 */
export function rollbackFromSnapshot(snapshotPath: string): void {
	if (!existsSync(snapshotPath)) {
		throw new Error(`快照不存在: ${snapshotPath}`);
	}

	const manifest = readJsonFile<{files?: Array<{source: string; relative: string; hash: string}>} | null>(
		join(snapshotPath, 'manifest.json'),
		null
	);
	if (!manifest || !Array.isArray(manifest.files)) {
		throw new Error('快照 manifest.json 缺失或损坏');
	}

	for (const fileInfo of manifest.files) {
		const srcPath = join(snapshotPath, fileInfo.relative);
		if (!existsSync(srcPath)) {
			throw new Error(`快照文件缺失: ${fileInfo.relative}`);
		}

		if (sha256File(srcPath) !== fileInfo.hash) {
			throw new Error(`快照文件校验失败: ${fileInfo.relative}`);
		}

		ensureDir(dirname(fileInfo.source));
		copyFileSync(srcPath, fileInfo.source);
	}
}

// ── 应用层 ─────────────────────────────────────────────────────────────────

export type ApplyUpdatesResult = {
	readonly snapshotPath: string;
	readonly updatedItems: readonly string[];
};

// 可选依赖注入：默认指向真实 createSnapshot / execCommand，仅供测试断言
// snapshot-before-write 不变量（design P8）时注入失败点与调用记录。
export type ApplyUpdatesDeps = {
	readonly createSnapshotFn?: () => string;
	readonly exec?: typeof execCommand;
	readonly agentContext?: AgentContext;
};

function ccgWorkflowUpdateContexts(activeContext: AgentContext = 'cc'): AgentContext[] {
	const contexts: AgentContext[] = [];
	if (hasClaudeCcgWorkflowMode()) {
		contexts.push('cc');
	}

	if (hasCodexCcgWorkflowMode()) {
		contexts.push('cx');
	}

	return contexts.length > 0 ? contexts : [activeContext];
}

async function reinstallCodeGraphIntegrations(exec: typeof execCommand, onProgress?: ProgressCallback): Promise<void> {
	for (const context of installedCodeGraphContexts()) {
		const [command] = codeGraphInstallCommands(context);
		if (!command) {
			continue;
		}

		onProgress?.({level: 'info', message: `${command.cmd} ${command.args.join(' ')}`, componentId: 'CodeGraph'});
		const result = await exec(command.cmd, [...command.args], {timeout: 300000});
		if (result.code !== 0) {
			throw new Error(`CodeGraph 接入刷新失败 (exit ${result.code})`);
		}

		if (!hasCodeGraphIntegration(context)) {
			const label = context === 'cx' ? 'Codex' : 'Claude Code';
			throw new Error(`CodeGraph ${label} MCP 写入失败`);
		}
	}
}

/**
 * 应用选中组件更新。先 createSnapshot 再执行更新命令（snapshot-before-write，design D12）。
 * snapshot 失败直接抛错，不执行任何更新命令。
 */
export async function applyUpdates(
	components: readonly UpdateComponent[],
	onProgress?: ProgressCallback,
	deps: ApplyUpdatesDeps = {}
): Promise<ApplyUpdatesResult> {
	const makeSnapshot = deps.createSnapshotFn ?? createSnapshot;
	const exec = deps.exec ?? execCommand;
	const snapshotPath = makeSnapshot();
	onProgress?.({level: 'success', message: `更新快照已创建（${snapshotPath}）`});

	const updatedItems: string[] = [];

	for (const component of components) {
		onProgress?.({level: 'info', message: `更新: ${component.name}`, componentId: component.id});

		try {
			if (component.id === 'CcgWorkflow') {
				const contexts = ccgWorkflowUpdateContexts(deps.agentContext);
				for (const context of contexts) {
					await installTool('CcgWorkflow', onProgress, context);
				}
				onProgress?.({level: 'success', message: `${component.name} 已更新`, componentId: component.id});
				updatedItems.push(`updated::${component.id}::${component.currentVersion || 'none'}->${component.latestVersion || 'latest'}`);
			} else if (component.type === 'npm' || component.type === 'skill') {
				const packageSpec =
					component.latestVersion && component.latestVersion !== component.currentVersion
						? `${component.package}@${component.latestVersion}`
						: component.package!;
				const result = await exec('npm', ['install', '-g', packageSpec], {timeout: 120000});
				if (result.code !== 0) {
					throw new Error(`npm install 失败 (exit ${result.code})`);
				}

				if (component.id === 'CodeGraph') {
					await reinstallCodeGraphIntegrations(exec, onProgress);
				}

				onProgress?.({level: 'success', message: `${component.name} 已更新`, componentId: component.id});
				updatedItems.push(`updated::${component.id}::${component.currentVersion || 'none'}->${component.latestVersion || 'latest'}`);
			} else if (component.type === 'cli') {
				onProgress?.({level: 'warning', message: '无法自动检测远程版本，请运行 agy update', componentId: component.id});
				updatedItems.push(`noop::${component.id}::manual-update-required`);
			} else if (component.type === 'mcp') {
				onProgress?.({level: 'info', message: 'MCP Server 通过 npx/远程 registry 解析，无需本地包更新', componentId: component.id});
				updatedItems.push(`noop::${component.id}::registry-managed`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onProgress?.({level: 'danger', message: `更新失败: ${message}`, componentId: component.id});
			updatedItems.push(`failed::${component.id}::${message}`);
		}
	}

	return {snapshotPath, updatedItems};
}

/** 生成更新汇总（对齐旧 generateUpdateSummary）。 */
export function generateUpdateSummary(updatedItems: readonly string[]): string {
	if (!updatedItems || updatedItems.length === 0) {
		return '✓ All components up to date';
	}

	return updatedItems
		.map(item => {
			const parts = String(item).split('::');
			return parts.length >= 3 ? item : `updated::unknown::${item}`;
		})
		.join('\n');
}

// ============================================================================
// 整可执行文件热更新（确认式下载 + 结构化错误）
// ============================================================================

import { CCQ_VERSION } from '../version.js';

const GITHUB_REPO = 'MrNine-666/claude-code-quickstart';
const RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

type ReleaseAsset = { readonly name: string; readonly browser_download_url: string };
type LatestReleaseResponse = { readonly tag_name?: string; readonly assets?: readonly ReleaseAsset[] };

export type SelfUpdateStage = 'check' | 'download' | 'apply';

export type SelfUpdateError = {
	readonly stage: SelfUpdateStage;
	readonly message: string;
	readonly cause?: string;
	readonly status?: number;
	readonly targetPath?: string;
	readonly tempPath?: string;
};

export type CheckLatestVersionResult =
	| { readonly ok: true; readonly hasUpdate: false; readonly currentVersion: string; readonly latestVersion: string }
	| { readonly ok: true; readonly hasUpdate: true; readonly currentVersion: string; readonly latestVersion: string; readonly version: string; readonly downloadUrl: string; readonly assetName: string }
	| { readonly ok: false; readonly error: SelfUpdateError };

export type DownloadUpdateResult =
	| { readonly ok: true; readonly tempPath: string; readonly targetPath: string }
	| { readonly ok: false; readonly error: SelfUpdateError };

export type ApplySelfUpdateResult =
	| { readonly ok: true; readonly targetPath: string; readonly restartStarted: boolean; readonly helperPath?: string }
	| { readonly ok: false; readonly error: SelfUpdateError };

function errorCause(error: unknown): string | undefined {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	const text = String(error ?? '').trim();
	return text || undefined;
}

function makeSelfUpdateError(
	stage: SelfUpdateStage,
	message: string,
	options: Omit<SelfUpdateError, 'stage' | 'message'> = {}
): SelfUpdateError {
	return {stage, message, ...options};
}

export function formatSelfUpdateError(error: SelfUpdateError): string {
	const stageLabel: Record<SelfUpdateStage, string> = {
		check: '检查更新',
		download: '下载更新',
		apply: '应用更新'
	};
	const details: string[] = [];
	if (error.status !== undefined) {
		details.push(`HTTP ${error.status}`);
	}
	if (error.targetPath) {
		details.push(`目标: ${error.targetPath}`);
	}
	if (error.tempPath) {
		details.push(`临时文件: ${error.tempPath}`);
	}
	if (error.cause && error.cause !== error.message) {
		details.push(error.cause);
	}

	return details.length > 0
		? `${stageLabel[error.stage]}失败：${error.message}（${details.join('；')}）`
		: `${stageLabel[error.stage]}失败：${error.message}`;
}

// 平台检测
function getPlatform(): string {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === 'win32') {
		return arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
	}
	if (platform === 'darwin') {
		return arch === 'arm64' ? 'macos-arm64' : 'macos-x64';
	}

	throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

// 获取 ccq 可执行文件路径（安装目标路径，供热更新与 CLI 自卸载共用）。
export function getCcqExecutablePath(): string {
	const homeDir = resolveHome();
	const platform = process.platform;

	if (platform === 'win32') {
		return join(homeDir, '.local', 'bin', 'ccq.exe');
	}
	return join(homeDir, '.local', 'bin', 'ccq');
}

function isLikelyCcqExecutablePath(filePath: string): boolean {
	const name = basename(filePath).toLowerCase();
	return name === 'ccq' || name === 'ccq.exe' || /^ccq-.+(?:\.exe)?$/.test(name);
}

export function getSelfUpdateTargetPath(): string {
	const currentExecutable = process.execPath;
	return isLikelyCcqExecutablePath(currentExecutable) ? currentExecutable : getCcqExecutablePath();
}

function getTempUpdatePath(targetPath = getSelfUpdateTargetPath()): string {
	return join(dirname(targetPath), '.ccq-update.tmp');
}

// 检查最新版本：只查询 Release，不下载任何文件。
export async function checkLatestVersion(): Promise<CheckLatestVersionResult> {
	try {
		const response = await fetch(RELEASE_API_URL, {
			headers: {'User-Agent': 'ccq-update-checker'}
		});
		if (!response.ok) {
			return {ok: false, error: makeSelfUpdateError('check', 'GitHub Release API 请求失败', {status: response.status})};
		}

		const data = await response.json() as LatestReleaseResponse;
		const latestVersion = data.tag_name?.replace(/^v/, '').trim();
		if (!latestVersion) {
			return {ok: false, error: makeSelfUpdateError('check', 'GitHub Release 响应缺少 tag_name')};
		}

		if (latestVersion === CCQ_VERSION) {
			return {ok: true, hasUpdate: false, currentVersion: CCQ_VERSION, latestVersion};
		}

		const platform = getPlatform();
		const assetName = `ccq-${platform}${platform.startsWith('windows') ? '.exe' : ''}`;
		const asset = (data.assets ?? []).find(item => item.name === assetName);
		if (!asset?.browser_download_url) {
			return {ok: false, error: makeSelfUpdateError('check', `Release 缺少当前平台产物 ${assetName}`)};
		}

		return {
			ok: true,
			hasUpdate: true,
			currentVersion: CCQ_VERSION,
			latestVersion,
			version: latestVersion,
			downloadUrl: asset.browser_download_url,
			assetName
		};
	} catch (error) {
		return {ok: false, error: makeSelfUpdateError('check', '无法连接 GitHub Release', {cause: errorCause(error)})};
	}
}

// 下载更新到临时文件；调用方必须在用户确认后才调用。
export async function downloadUpdate(downloadUrl: string, signal?: AbortSignal): Promise<DownloadUpdateResult> {
	const targetPath = getSelfUpdateTargetPath();
	const tempPath = getTempUpdatePath(targetPath);
	try {
		const dir = dirname(tempPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, {recursive: true});
		}

		const response = await fetch(downloadUrl, {signal});
		if (!response.ok) {
			return {ok: false, error: makeSelfUpdateError('download', '下载 Release asset 失败', {status: response.status, targetPath, tempPath})};
		}

		const buffer = await response.arrayBuffer();
		writeFileSync(tempPath, Buffer.from(buffer));

		if (process.platform !== 'win32') {
			const chmod = await execCommand('chmod', ['755', tempPath]);
			if (chmod.code !== 0) {
				return {ok: false, error: makeSelfUpdateError('download', '设置临时文件可执行权限失败', {cause: chmod.stderr || chmod.stdout, targetPath, tempPath})};
			}
		}

		return {ok: true, tempPath, targetPath};
	} catch (error) {
		const isAbort = error instanceof Error && error.name === 'AbortError';
		return {
			ok: false,
			error: makeSelfUpdateError('download', isAbort ? '下载已取消' : '下载或写入更新文件失败', {
				cause: errorCause(error),
				targetPath,
				tempPath
			})
		};
	}
}

function windowsUpdateHelperPath(targetPath: string): string {
	return join(dirname(targetPath), `.ccq-update-${process.pid}.ps1`);
}

// Windows 更新 helper 脚本模板（单一真理源，运行时与 test-windows-helper 共用，DRY）。
// 脚本内容全静态：所有可变参数（ParentPid/TempPath/TargetPath/WorkingDirectory）均由 spawn
// 以 -Param 形式注入，脚本体内不做字符串插值，故无注入面。
// 重试次数与间隔提为常量，供测试断言与运行时共用。
export const WINDOWS_HELPER_COPY_MAX_ATTEMPTS = 20;
export const WINDOWS_HELPER_COPY_INTERVAL_MS = 250;

export function buildWindowsUpdateHelperScript(): string {
	return [
		'param(',
		'  [int]$ParentPid,',
		'  [string]$TempPath,',
		'  [string]$TargetPath,',
		'  [string]$WorkingDirectory',
		')',
		'$ErrorActionPreference = "Stop"',
		// 诊断日志：Windows 自替换失败时（Copy-Item 撞镜像文件句柄）此前完全静默，
		// 现落盘到 %TEMP%\ccq-update.log 以便定位。写日志本身 best-effort，不因日志失败中断更新。
		'$logPath = Join-Path $env:TEMP "ccq-update.log"',
		'function Write-UpdateLog($msg) {',
		'  try { Add-Content -LiteralPath $logPath -Value ("[{0}] [pid {1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $PID, $msg) -ErrorAction SilentlyContinue } catch {}',
		'}',
		'Write-UpdateLog "helper start: parent=$ParentPid temp=$TempPath target=$TargetPath"',
		'Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue',
		'Write-UpdateLog "parent process exited"',
		'$targetDir = Split-Path -Parent $TargetPath',
		'if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }',
		// Copy-Item 重试循环：Wait-Process 返回后 Windows 加载器对旧 exe 镜像句柄的释放会滞后，
		// 立即 Copy-Item -Force 会撞“文件正被占用”。最多重试 20 次 × 250ms（~5s）等锁释放。
		'$copied = $false',
		`for ($i = 1; $i -le ${WINDOWS_HELPER_COPY_MAX_ATTEMPTS}; $i++) {`,
		'  try {',
		'    Copy-Item -LiteralPath $TempPath -Destination $TargetPath -Force',
		'    $copied = $true',
		'    Write-UpdateLog "copy succeeded on attempt $i"',
		'    break',
		'  } catch {',
		'    Write-UpdateLog "copy attempt $i failed: $($_.Exception.Message)"',
		`    Start-Sleep -Milliseconds ${WINDOWS_HELPER_COPY_INTERVAL_MS}`,
		'  }',
		'}',
		// 拷贝失败：保留 TempPath 供后续重试（不删），仅清理 helper 自身后退出。
		'if (-not $copied) {',
		'  Write-UpdateLog "copy failed after all attempts, keeping temp file for retry"',
		'  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
		'  exit 1',
		'}',
		// 大小校验：确认覆盖完整（避免拷了半截就重启旧/坏版本）。不一致则保留 tmp 退出。
		'$tempSize = (Get-Item -LiteralPath $TempPath).Length',
		'$targetSize = (Get-Item -LiteralPath $TargetPath).Length',
		'if ($tempSize -ne $targetSize) {',
		'  Write-UpdateLog "size mismatch temp=$tempSize target=$targetSize, keeping temp file"',
		'  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
		'  exit 1',
		'}',
		'Write-UpdateLog "size verified: $targetSize bytes"',
		'Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue',
		'if ($WorkingDirectory -and (Test-Path -LiteralPath $WorkingDirectory)) {',
		'  Start-Process -FilePath $TargetPath -WorkingDirectory $WorkingDirectory',
		'} else {',
		'  Start-Process -FilePath $TargetPath',
		'}',
		'Write-UpdateLog "restarted ccq, cleaning up helper"',
		'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
		''
	].join('\r\n');
}

function startWindowsUpdateHelper(targetPath: string, tempPath: string): ApplySelfUpdateResult {
	const helperPath = windowsUpdateHelperPath(targetPath);
	try {
		const script = buildWindowsUpdateHelperScript();
		writeFileSync(helperPath, script, 'utf8');

		const child = spawn('powershell.exe', [
			'-NoProfile',
			'-ExecutionPolicy',
			'Bypass',
			'-File',
			helperPath,
			'-ParentPid',
			String(process.pid),
			'-TempPath',
			tempPath,
			'-TargetPath',
			targetPath,
			'-WorkingDirectory',
			process.cwd()
		], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true
		});
		child.unref();
		return {ok: true, targetPath, restartStarted: true, helperPath};
	} catch (error) {
		return {ok: false, error: makeSelfUpdateError('apply', '启动 Windows 更新 helper 失败', {cause: errorCause(error), targetPath, tempPath})};
	}
}

// 应用已下载的更新。Windows 启动 helper，当前进程退出后由 helper 替换并重启。
export async function applyUpdate(): Promise<ApplySelfUpdateResult> {
	const targetPath = getSelfUpdateTargetPath();
	const tempPath = getTempUpdatePath(targetPath);
	if (!existsSync(tempPath)) {
		return {ok: false, error: makeSelfUpdateError('apply', '更新临时文件不存在，请重新下载', {targetPath, tempPath})};
	}

	if (process.platform === 'win32') {
		return startWindowsUpdateHelper(targetPath, tempPath);
	}

	try {
		renameSync(tempPath, targetPath);
		const chmod = await execCommand('chmod', ['755', targetPath]);
		if (chmod.code !== 0) {
			return {ok: false, error: makeSelfUpdateError('apply', '设置新可执行文件权限失败', {cause: chmod.stderr || chmod.stdout, targetPath, tempPath})};
		}

		return {ok: true, targetPath, restartStarted: false};
	} catch (error) {
		return {ok: false, error: makeSelfUpdateError('apply', '替换 ccq 可执行文件失败', {cause: errorCause(error), targetPath, tempPath})};
	}
}

// 清理临时更新文件
export async function cleanupTempUpdate(): Promise<void> {
	const tempPath = getTempUpdatePath();
	try {
		rmSync(tempPath, {force: true});
	} catch {
		// 清理仅作 best-effort；下载/应用路径会返回结构化错误。
	}
}

// 重启 ccq 可执行文件：调用方应先 renderer.destroy() 恢复终端 raw mode。
export function restartExecutable(): ApplySelfUpdateResult {
	const targetPath = getSelfUpdateTargetPath();
	try {
		const child = spawn(targetPath, [], {
			detached: true,
			stdio: 'inherit',
			cwd: process.cwd()
		});
		child.unref();
		return {ok: true, targetPath, restartStarted: true};
	} catch (error) {
		return {ok: false, error: makeSelfUpdateError('apply', '重启 ccq 失败，请手动重新运行 ccq', {cause: errorCause(error), targetPath})};
	}
}
