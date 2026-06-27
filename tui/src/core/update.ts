import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, rmSync} from 'node:fs';
import {join, dirname, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {atomicWrite, readJsonFile} from './fs-utils.js';
import {claudeDir, claudeJsonPath, ccqDir, resolveHome, settingsPath, skillsDir} from './paths.js';
import {execCommand, type ProgressCallback} from './exec.js';
import {hasUpdate} from './semver.js';
import {installTool} from './tools-install.js';

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

const NPM_COMPONENT_MAP: Record<string, string> = {
	ClaudeCode: '@anthropic-ai/claude-code',
	Ccline: '@cometix/ccline',
	CcgWorkflow: 'ccg-workflow',
	CodexCli: '@openai/codex',
	OpenSpec: '@fission-ai/openspec'
};

// CcgWorkflow 包名单一真理源（检测与 applyUpdates 特判共用），守卫锁定 package='ccg-workflow'
const CCG_NPM_PACKAGE = 'ccg-workflow';

const COMMAND_COMPONENTS: Record<string, {command: string; versionArgs: string[]}> = {
	ClaudeCode: {command: 'claude', versionArgs: ['--version']},
	Ccline: {command: 'ccline', versionArgs: ['--version']},
	CodexCli: {command: 'codex', versionArgs: ['--version']},
	OpenSpec: {command: 'openspec', versionArgs: ['--version']},
	AntigravityCli: {command: 'agy', versionArgs: ['--version']}
};

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

async function getCommandVersion(command: string, args: string[]): Promise<{installed: boolean; version: string}> {
	try {
		const result = await execCommand(command, args, {timeout: 5000});
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

/**
 * 查询 npm 包最新版本（`npm view <pkg> version`），带 1h 缓存。
 * 缓存命中（文件存在且未过期）时不发网络请求，返回缓存值（无该包则空串），
 * 对齐 getNpmOutdatedGlobal 的整文件 TTL 语义，便于测试预置空缓存规避网络。
 */
async function getNpmViewLatest(packageName: string, forceRefresh = false): Promise<string> {
	if (!forceRefresh) {
		const cached = readNpmViewCache();
		if (cached !== null) {
			return cached[packageName] || '';
		}
	}

	let latest = '';
	try {
		const result = await execCommand('npm', ['view', packageName, 'version'], {timeout: 30000});
		if (result.code === 0) {
			latest = result.stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
		}
	} catch {
		// 查询失败不阻塞，latest 保持空串
	}

	writeNpmViewCache(latest ? {[packageName]: latest} : {});
	return latest;
}

/**
 * 构建 CcgWorkflow 更新状态（config.toml 本地版本 vs npm view 远程版本）。
 * 对齐 buildNpmComponentStatus 的字段语义：installed/current/latest/hasUpdate。
 */
async function buildCcgWorkflowStatus(): Promise<UpdateComponent> {
	const local = readCcgLocalVersion();
	const latest = await getNpmViewLatest(CCG_NPM_PACKAGE);
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

async function buildNpmComponentStatus(id: string, packageName: string, outdated: NpmOutdated): Promise<UpdateComponent> {
	const commandInfo = COMMAND_COMPONENTS[id];
	const versionInfo = commandInfo
		? await getCommandVersion(commandInfo.command, commandInfo.versionArgs)
		: {installed: false, version: ''};
	const remote = outdated[packageName];

	return {
		id,
		name: id,
		type: 'npm',
		package: packageName,
		installed: versionInfo.installed,
		currentVersion: versionInfo.version,
		latestVersion: remote?.latest || versionInfo.version,
		hasUpdate: versionInfo.installed ? (remote ? hasUpdate(versionInfo.version, remote.latest || '') : false) : null
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

// export 供 tools-manage.ts 的 detectComponents 复用：返回 6 个 CLI 组件
// （ClaudeCode/Ccline/CcgWorkflow/CodexCli/OpenSpec + AntigravityCli），不含 Skills/MCP。
export async function checkCliToolUpdates(outdated: NpmOutdated): Promise<UpdateComponent[]> {
	const components: UpdateComponent[] = [];
	for (const [id, packageName] of Object.entries(NPM_COMPONENT_MAP)) {
		if (id === 'CcgWorkflow') {
			// 非全局包：config.toml 本地版本 + npm view 远程版本（不依赖 outdated 全局列表）
			components.push(await buildCcgWorkflowStatus());
		} else {
			components.push(await buildNpmComponentStatus(id, packageName, outdated));
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
};

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
				// CcgWorkflow 是 npx init 装入 ~/.claude 的非全局包，不能用 npm install -g：
				// 复用 tools-install.installTool 走 npx ccg-workflow@latest init
				// （含 mcpServers 快照保护 + env 补缺失），与安装路径完全一致。
				await installTool('CcgWorkflow', onProgress);
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
// 整可执行文件热更新（Phase 7.5-7.8）
// ============================================================================

import { CCQ_VERSION } from '../version.js';

// GitHub Release API 端点
const GITHUB_REPO = "MrNine-666/claude-code-quickstart";
const RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

// 平台检测
function getPlatform(): string {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === 'win32') {
		return arch === 'arm64' ? 'windows-arm64' : 'windows-x64';
	} else if (platform === 'darwin') {
		return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
	} else {
		throw new Error(`Unsupported platform: ${platform}-${arch}`);
	}
}

// 获取可执行文件路径
function getExecutablePath(): string {
	const homeDir = resolveHome();
	const platform = process.platform;

	if (platform === 'win32') {
		return join(homeDir, '.local', 'bin', 'ccq.exe');
	} else {
		return join(homeDir, '.local', 'bin', 'ccq');
	}
}

// 获取临时更新文件路径
function getTempUpdatePath(): string {
	const execPath = getExecutablePath();
	const dir = dirname(execPath);
	return join(dir, '.ccq-update.tmp');
}

// 检查最新版本
export async function checkLatestVersion(): Promise<{ version: string; downloadUrl: string } | null> {
	try {
		const response = await fetch(RELEASE_API_URL, {
			headers: {
				'User-Agent': 'ccq-update-checker',
			},
		});

		if (!response.ok) {
			throw new Error(`GitHub API error: ${response.status}`);
		}

		const data = await response.json() as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
		const latestVersion = data.tag_name.replace(/^v/, ''); // 移除 'v' 前缀

		// 版本相同则跳过（P-6 零网络写）
		if (latestVersion === CCQ_VERSION) {
			return null;
		}

		// 查找对应平台的可执行文件
		const platform = getPlatform();
		const assetName = `ccq-${platform}${platform.startsWith('windows') ? '.exe' : ''}`;
		const asset = data.assets.find(a => a.name === assetName);

		if (!asset) {
			throw new Error(`No asset found for platform: ${platform}`);
		}

		return {
			version: latestVersion,
			downloadUrl: asset.browser_download_url,
		};
	} catch {
		return null;
	}
}

// 下载更新到临时文件
export async function downloadUpdate(downloadUrl: string): Promise<boolean> {
	try {
		const tempPath = getTempUpdatePath();

		// 确保目录存在
		const dir = dirname(tempPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// 下载文件
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`Download failed: ${response.status}`);
		}

		const buffer = await response.arrayBuffer();
		writeFileSync(tempPath, Buffer.from(buffer));

		// 设置可执行权限（macOS/Linux）
		if (process.platform !== 'win32') {
			try {
				await execCommand('chmod', ['755', tempPath]);
			} catch {
				// 忽略 chmod 失败
			}
		}

		return true;
	} catch {
		return false;
	}
}

// 原子替换可执行文件
export async function applyUpdate(): Promise<boolean> {
	try {
		const execPath = getExecutablePath();
		const tempPath = getTempUpdatePath();

		// 检查临时文件是否存在
		if (!existsSync(tempPath)) {
			throw new Error('Update file not found');
		}

		// Windows: 无法直接替换运行中的 exe，需要退出后下次启动替换
		if (process.platform === 'win32') {
			// 只检查临时文件存在即可，实际替换留给下次启动
			return true;
		}

		// macOS/Linux: 直接 rename 原子替换
		rmSync(execPath, { force: true });
		copyFileSync(tempPath, execPath);
		rmSync(tempPath, { force: true });

		// 设置可执行权限
		try {
			await execCommand('chmod', ['755', execPath]);
		} catch {
			// 忽略 chmod 失败
		}

		return true;
	} catch {
		return false;
	}
}

// 清理临时更新文件
export async function cleanupTempUpdate(): Promise<void> {
	try {
		const tempPath = getTempUpdatePath();
		rmSync(tempPath, { force: true });
	} catch {
		// 忽略清理失败
	}
}

// Windows 启动时检查并应用待替换的更新
export async function applyPendingUpdateOnStartup(): Promise<boolean> {
	if (process.platform !== 'win32') {
		return false;
	}

	try {
		const execPath = getExecutablePath();
		const tempPath = getTempUpdatePath();

		// 检查临时文件是否存在
		if (!existsSync(tempPath)) {
			return false; // 没有待替换的更新
		}

		// 备份当前可执行文件
		const backupPath = `${execPath}.bak`;
		try {
			copyFileSync(execPath, backupPath);
		} catch {
			// 备份失败则跳过
		}

		// 替换可执行文件
		rmSync(execPath, { force: true });
		copyFileSync(tempPath, execPath);
		rmSync(tempPath, { force: true });

		// 删除备份
		try {
			rmSync(backupPath, { force: true });
		} catch {
			// 忽略备份删除失败
		}

		return true;
	} catch {
		return false;
	}
}

// 后台自动检查更新（启动时触发但不阻塞，P-5 失败不阻断）
export function startBackgroundUpdateCheck(): void {
	// 延迟 5 秒启动，避免阻塞主流程
	setTimeout(async () => {
		try {
			const updateInfo = await checkLatestVersion();
			if (updateInfo) {
				// 静默下载，不弹窗打断用户
				await downloadUpdate(updateInfo.downloadUrl);
				// 下载完成后不提示，等待下次启动或用户手动检查
			}
		} catch {
			// P-5: 失败不阻断当前运行，静默忽略
		}
	}, 5000);
}

// 重启 ccq 可执行文件：spawn 一个 detached 新进程（继承终端 stdio），再退出当前进程。
// 供热更新完成后「立即重启」调用。新进程启动时：
//   - macOS/Linux：applyUpdate 已原子替换磁盘文件，直接加载新版
//   - Windows：走 applyPendingUpdateOnStartup 收尾待替换的 .ccq-update.tmp
// spawn 失败则不退出，保持当前进程运行，由用户手动重启。
// 注意：调用方应先 renderer.destroy() 恢复终端 raw mode，再调本函数。
export function restartExecutable(): void {
	try {
		const child = spawn(process.execPath, [], {
			detached: true,
			stdio: 'inherit',
			cwd: process.cwd()
		});
		child.unref();
	} catch {
		// spawn 失败则保持当前进程运行，让用户手动重启
		return;
	}

	process.exit(0);
}
