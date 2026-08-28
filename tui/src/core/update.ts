import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomBytes} from 'node:crypto';
import {atomicWrite, readJsonFile} from './fs-utils.js';
import {claudeDir, claudeJsonPath, ccqDir, resolveHome, settingsPath, skillsDir} from './paths.js';
import {execCommand, formatCommandInstruction, type ProgressCallback} from './exec.js';
import {refreshNpmGlobalBinPath} from './npm-path.js';
import {hasUpdate} from './semver.js';
import {installTool, TOOL_DEFINITIONS} from './tools-install.js';
import {
	DSH_PACKAGE_NAME,
	DSH_TOOL_ID,
	detectDshLifecycle,
	dshCanUpdate,
	dshHasUpdate,
	updateDsh,
	type DshDetectionDeps,
	type DshLifecycleProjection
} from './dsh-lifecycle.js';
import {codeGraphInstallCommands, gitNexusSetupCommands, gitNexusFailureDiagnostic} from './tools-lifecycle.js';
import {
	hasCodeGraphIntegration,
	installedCodeGraphContexts,
	hasClaudeCcgWorkflowMode,
	hasCodexCcgWorkflowMode
} from './tools-integrations.js';
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
	readonly lifecycle?: DshLifecycleProjection;
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

	let result: Awaited<ReturnType<typeof execCommand>>;
	try {
		result = await execCommand('npm', ['outdated', '-g', '--json'], {timeout: 30000});
	} catch {
		return {};
	}
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

async function execVersionCommand(
	command: string,
	args: readonly string[]
): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> {
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
	latestByPackage: NpmViewCache,
	dshLifecycle?: DshLifecycleProjection
): Promise<UpdateComponent> {
	if (id === DSH_TOOL_ID) {
		return buildDshComponentStatus(packageName, outdated, latestByPackage, dshLifecycle);
	}

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

async function buildDshComponentStatus(
	packageName: string,
	outdated: NpmOutdated,
	latestByPackage: NpmViewCache,
	dshLifecycle?: DshLifecycleProjection
): Promise<UpdateComponent> {
	const lifecycle = dshLifecycle ?? (await detectDshLifecycle());
	const remote = outdated[packageName];
	const latestVersion = remote?.latest || latestByPackage[packageName] || lifecycle.packageVersion || lifecycle.commandVersion;
	const currentVersion = lifecycle.packageVersion || lifecycle.commandVersion;
	const repairable = lifecycle.repairRequired;
	const installed = lifecycle.state === 'managed' || repairable;
	const hasUpdate = repairable
		? true
		: lifecycle.state === 'managed'
			? latestVersion
				? (dshHasUpdate(currentVersion, latestVersion) ?? false)
				: false
			: null;
	const detail = lifecycle.state === 'managed' || lifecycle.state === 'not-installed' ? '' : lifecycle.diagnostic;
	const warnings = [detail, lifecycle.prereleaseWarning].filter(Boolean).join(' ');
	return {
		id: DSH_TOOL_ID,
		name: 'DeepSeek Harness',
		type: 'npm',
		package: DSH_PACKAGE_NAME,
		installed,
		currentVersion,
		latestVersion,
		hasUpdate,
		...(warnings ? {statusHint: warnings} : {}),
		lifecycle
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

// export 供 tools-manage.ts 的 detectComponents 复用：返回 10 个 CLI 组件
// （ClaudeCode/Ccline/CcgWorkflow/OpenSpec/Trellis/CodeGraph/GitNexus/CodexCli + AntigravityCli + DeepSeekHarness），不含 Skills/MCP。
export async function checkCliToolUpdates(outdated: NpmOutdated, forceRefresh = false): Promise<UpdateComponent[]> {
	// 保留调用方进入检测时的 PATH：refreshNpmGlobalBinPath 会前置 npm bin，
	// 但 DSH 必须按用户原始 PATH 判断外部命令遮蔽，不能被检测准备动作掩盖。
	const dshLifecycle = await detectDshLifecycle({env: {...process.env}});
	await refreshNpmGlobalBinPath();
	const latestByPackage = await resolveNpmViewLatest(Object.values(NPM_COMPONENT_MAP), forceRefresh);
	const components: UpdateComponent[] = [];
	for (const [id, packageName] of Object.entries(NPM_COMPONENT_MAP)) {
		if (id === 'CcgWorkflow') {
			// 非全局包：config.toml 本地版本 + npm view 远程版本（不依赖 outdated 全局列表）
			components.push(await buildCcgWorkflowStatus(latestByPackage));
		} else {
			components.push(
				await buildNpmComponentStatus(id, packageName, outdated, latestByPackage, id === DSH_TOOL_ID ? dshLifecycle : undefined)
			);
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
	return [...(await checkCliToolUpdates(outdated)), ...(await checkSkillsUpdates(outdated)), ...checkMcpServerUpdates()];
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
	const files = [settingsPath(), claudeJsonPath(), join(claudeDir(), 'CLAUDE.md'), join(ccqDir(), 'mcp-meta.json')];

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
	readonly dshLifecycle?: DshLifecycleProjection;
};

// 可选依赖注入：默认指向真实 createSnapshot / execCommand，仅供测试断言
// snapshot-before-write 不变量（design P8）时注入失败点与调用记录。
export type ApplyUpdatesDeps = {
	readonly createSnapshotFn?: () => string;
	readonly exec?: typeof execCommand;
	readonly agentContext?: AgentContext;
	readonly dshDetect?: (deps?: DshDetectionDeps) => Promise<DshLifecycleProjection>;
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

		onProgress?.({
			level: 'info',
			message: `${command.cmd} ${command.args.join(' ')}`,
			componentId: 'CodeGraph',
			instruction: formatCommandInstruction(command.cmd, command.args)
		});
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
 * GitNexus 更新后重放官方 setup（npm 更新只换 CLI，编辑器接入需重新写入）。
 * setup 失败即抛错，由 applyUpdates 记为该 item 的 failed，不影响其他组件。
 */
async function reapplyGitNexusSetup(exec: typeof execCommand, onProgress?: ProgressCallback): Promise<void> {
	const [command] = gitNexusSetupCommands();
	if (!command) {
		return;
	}

	onProgress?.({
		level: 'info',
		message: `${command.cmd} ${command.args.join(' ')}`,
		componentId: 'GitNexus',
		instruction: formatCommandInstruction(command.cmd, command.args)
	});
	const result = await exec(command.cmd, [...command.args], {timeout: 300000});
	if (result.code !== 0) {
		// 与安装路径同源：保留 setup 阶段 exit code 与上游 Node.js / 原生依赖诊断（R10）。
		throw new Error(gitNexusFailureDiagnostic('GitNexus 编辑器接入刷新失败', result.code, result.stderr, result.stdout));
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
	const detectDsh = deps.dshDetect ?? detectDshLifecycle;
	let dshPreflight: DshLifecycleProjection | undefined;
	for (const component of components) {
		if (component.id !== DSH_TOOL_ID) continue;
		const lifecycle = await detectDsh({exec});
		if (!dshCanUpdate(lifecycle)) {
			if (components.length === 1) {
				// 单项竞态拒绝也要返回最终 ownership projection，供 TUI 收敛卡片；
				// 此时没有 mutation，不创建 snapshot，也不执行 npm 写命令。
				return {
					snapshotPath: '',
					updatedItems: [`failed::${DSH_TOOL_ID}::${lifecycle.diagnostic}`],
					dshLifecycle: lifecycle
				};
			}
			dshPreflight = lifecycle;
		}
	}
	const snapshotPath = makeSnapshot();
	onProgress?.({level: 'success', message: `更新快照已创建（${snapshotPath}）`});

	const updatedItems: string[] = [];
	let dshLifecycle: DshLifecycleProjection | undefined;

	for (const component of components) {
		onProgress?.({level: 'info', message: `更新: ${component.name}`, componentId: component.id});

		try {
			if (component.id === DSH_TOOL_ID) {
				if (dshPreflight && !dshCanUpdate(dshPreflight)) {
					const message = dshPreflight.diagnostic;
					dshLifecycle = dshPreflight;
					onProgress?.({level: 'danger', message: `更新失败: ${message}`, componentId: component.id});
					updatedItems.push(`failed::${component.id}::${message}`);
					continue;
				}
				const outcome = await updateDsh(onProgress, {exec, detect: detectDsh});
				dshLifecycle = outcome.lifecycle;
				if (!outcome.success) {
					throw new Error(outcome.error ?? 'DeepSeek Harness 更新失败');
				}
				dshLifecycle = outcome.lifecycle;
				onProgress?.({level: 'success', message: `${component.name} 已更新`, componentId: component.id});
				if (outcome.warning) {
					onProgress?.({level: 'warning', message: outcome.warning, componentId: component.id});
				}
				updatedItems.push(
					`updated::${component.id}::${component.currentVersion || 'none'}->${outcome.version || component.latestVersion || 'latest'}`
				);
			} else if (component.id === 'CcgWorkflow') {
				const contexts = ccgWorkflowUpdateContexts(deps.agentContext);
				for (const context of contexts) {
					await installTool('CcgWorkflow', onProgress, context);
				}
				onProgress?.({level: 'success', message: `${component.name} 已更新`, componentId: component.id});
				updatedItems.push(
					`updated::${component.id}::${component.currentVersion || 'none'}->${component.latestVersion || 'latest'}`
				);
			} else if (component.type === 'npm' || component.type === 'skill') {
				const packageSpec =
					component.latestVersion && component.latestVersion !== component.currentVersion
						? `${component.package}@${component.latestVersion}`
						: component.package!;
				const args = ['install', '-g', packageSpec];
				onProgress?.({
					level: 'info',
					message: formatCommandInstruction('npm', args),
					componentId: component.id,
					instruction: formatCommandInstruction('npm', args)
				});
				const result = await exec('npm', args, {timeout: 120000});
				if (result.code !== 0) {
					// GitNexus 的 Node engine / 原生依赖失败只出现在上游 stderr 里（R10），其余组件保持既有简洁信息。
					throw new Error(
						component.id === 'GitNexus'
							? gitNexusFailureDiagnostic('npm install 失败', result.code, result.stderr, result.stdout)
							: `npm install 失败 (exit ${result.code})`
					);
				}

				if (component.id === 'CodeGraph') {
					await reinstallCodeGraphIntegrations(exec, onProgress);
				}

				if (component.id === 'GitNexus') {
					await reapplyGitNexusSetup(exec, onProgress);
				}

				onProgress?.({level: 'success', message: `${component.name} 已更新`, componentId: component.id});
				updatedItems.push(
					`updated::${component.id}::${component.currentVersion || 'none'}->${component.latestVersion || 'latest'}`
				);
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

	return {snapshotPath, updatedItems, ...(dshLifecycle ? {dshLifecycle} : {})};
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
export * from './self-update.js';
