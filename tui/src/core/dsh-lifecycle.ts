import {existsSync, lstatSync, readFileSync, realpathSync, statSync} from 'node:fs';
import {posix, win32} from 'node:path';
import {execCommand, formatCommandInstruction, type ExecResult, type ProgressCallback} from './exec.js';
import {environmentPath, pathDelimiter, refreshNpmGlobalBinPath, withEnvironmentPath} from './npm-path.js';
import {parseSemver, semverCompare} from './semver.js';

export const DSH_TOOL_ID = 'DeepSeekHarness' as const;
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh' as const;
export const DSH_COMMAND = 'dsh' as const;
export const DSH_INSTALL_ARGS = ['install', '-g', `${DSH_PACKAGE_NAME}@latest`] as const;
export const DSH_UNINSTALL_ARGS = ['uninstall', '-g', DSH_PACKAGE_NAME] as const;
export const DSH_VERSION_ARGS = ['--version'] as const;
export const DSH_PRERELEASE_WARNING = '当前为预发布版本，可能存在 breaking changes。';

export type DshLifecycleState =
	| 'not-installed'
	| 'managed'
	| 'broken'
	| 'version-mismatch'
	| 'external'
	| 'path-conflict'
	| 'npm-unavailable'
	// 仅 mutation postflight 检测抛异常时使用；普通 detectDshLifecycle 永不返回此状态。
	| 'verification-unknown';

export type DshLifecycleProjection = {
	readonly owner: typeof DSH_TOOL_ID;
	readonly state: DshLifecycleState;
	readonly packageName: typeof DSH_PACKAGE_NAME;
	readonly packageVersion: string;
	readonly commandVersion: string;
	readonly commandPath?: string;
	readonly prefix?: string;
	readonly packageRoot?: string;
	readonly packagePresent: boolean;
	readonly commandPresent: boolean;
	readonly canInstall: boolean;
	readonly canUpdate: boolean;
	readonly canUninstall: boolean;
	readonly repairRequired: boolean;
	readonly diagnostic: string;
	readonly prereleaseWarning?: string;
};

export type DshDetectionDeps = {
	readonly exec?: typeof execCommand;
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
};

export type DshOperationDeps = DshDetectionDeps & {
	readonly detect?: (deps?: DshDetectionDeps) => Promise<DshLifecycleProjection>;
};

export type DshOperationResult = {
	readonly id: typeof DSH_TOOL_ID;
	readonly success: boolean;
	readonly version?: string;
	readonly lifecycle?: DshLifecycleProjection;
	readonly warning?: string;
	readonly error?: string;
	readonly state?: DshLifecycleState;
};

type PathApi = typeof posix;

type DshPackageFacts = {
	readonly present: boolean;
	readonly valid: boolean;
	readonly version: string;
	readonly binTarget: string;
};

type PathCommand = {readonly path: string};

const DETECT_TIMEOUT_MS = 5000;
const OPERATION_TIMEOUT_MS = 300000;

function pathApi(platform: NodeJS.Platform): PathApi {
	return platform === 'win32' ? win32 : posix;
}

function pathEquals(left: string, right: string, platform: NodeJS.Platform): boolean {
	const api = pathApi(platform);
	const first = api.normalize(left);
	const second = api.normalize(right);
	return platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function trimCommandOutput(value: string): string {
	return value.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

function parseVersion(value: string): string {
	const match = value.match(/\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/);
	return match?.[0]?.replace(/^v/i, '') ?? '';
}

function isPrerelease(version: string): boolean {
	return Boolean(parseSemver(version)?.prerelease);
}

function npmUnavailable(result: ExecResult): boolean {
	return /(?:not recognized|not found|command not found|no such file|enoent|spawn npm)/i.test(`${result.stderr}\n${result.stdout}`);
}

function npmUnavailableError(error: unknown): boolean {
	return error instanceof Error && /(?:enoent|not found|not recognized|spawn npm)/i.test(error.message);
}

function pathEntries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	return environmentPath(env, platform)
		.split(pathDelimiter(platform))
		.map(entry => entry.trim())
		.filter(Boolean);
}

function commandCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	if (platform !== 'win32') return [DSH_COMMAND];

	const pathext = typeof env.PATHEXT === 'string' ? env.PATHEXT.split(';') : [];
	const extensions = [...pathext, '.cmd', '.exe', '.bat', '.com', '.ps1']
		.map(extension => (extension.startsWith('.') ? extension : `.${extension}`))
		.map(extension => extension.toLowerCase())
		.filter((extension, index, all) => all.indexOf(extension) === index);
	return [DSH_COMMAND, ...extensions.map(extension => `${DSH_COMMAND}${extension}`)];
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolvePath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function pathWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
	const api = pathApi(platform);
	const relative = api.relative(resolvePath(parent), resolvePath(child));
	return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packagePaths(prefix: string, platform: NodeJS.Platform): {packageRoot: string; manifestPath: string; binDir: string} {
	const api = pathApi(platform);
	const packageRoot = api.join(prefix, ...(platform === 'win32' ? ['node_modules'] : ['lib', 'node_modules']), '@deepseek-ai', 'dsh');
	return {
		packageRoot,
		manifestPath: api.join(packageRoot, 'package.json'),
		binDir: platform === 'win32' ? prefix : api.join(prefix, 'bin')
	};
}

function readPackageFacts(prefix: string, platform: NodeJS.Platform): DshPackageFacts {
	const paths = packagePaths(prefix, platform);
	if (!existsSync(paths.manifestPath)) {
		return {present: false, valid: false, version: '', binTarget: ''};
	}

	try {
		const parsed: unknown = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
		if (!isRecord(parsed)) {
			return {present: true, valid: false, version: '', binTarget: ''};
		}

		const name = typeof parsed.name === 'string' ? parsed.name : '';
		const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
		const bin = parsed.bin;
		const binTarget = typeof bin === 'string' ? bin : isRecord(bin) && typeof bin.dsh === 'string' ? bin.dsh : '';
		return {
			present: true,
			valid: name === DSH_PACKAGE_NAME && Boolean(version) && Boolean(binTarget),
			version,
			binTarget
		};
	} catch {
		return {present: true, valid: false, version: '', binTarget: ''};
	}
}

function findPathCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): PathCommand | undefined {
	const api = pathApi(platform);
	const candidates = commandCandidates(env, platform);
	for (const directory of pathEntries(env, platform)) {
		for (const candidate of candidates) {
			const commandPath = api.join(directory, candidate);
			if (!isFile(commandPath)) continue;
			return {path: commandPath};
		}
	}

	return undefined;
}

function shimReferencesPackage(
	commandPath: string,
	binDir: string,
	packageRoot: string,
	binTarget: string,
	platform: NodeJS.Platform
): boolean {
	const api = pathApi(platform);
	const expectedTarget = api.join(packageRoot, binTarget);
	if (platform !== 'win32') {
		try {
			if (lstatSync(commandPath).isSymbolicLink()) {
				return pathWithin(commandPath, packageRoot, platform);
			}
		} catch {
			return false;
		}

		try {
			const content = readFileSync(commandPath, 'utf8').replaceAll('\\', '/').toLowerCase();
			const expected = expectedTarget.replaceAll('\\', '/').toLowerCase();
			return content.includes(expected) || content.includes('node_modules/@deepseek-ai/dsh/');
		} catch {
			return false;
		}
	}

	try {
		if (lstatSync(commandPath).isSymbolicLink()) {
			return pathWithin(commandPath, packageRoot, platform);
		}
	} catch {
		return false;
	}

	const extension = win32.extname(commandPath).toLowerCase();
	if (!['', '.cmd', '.bat', '.ps1', '.exe'].includes(extension)) return false;
	try {
		const content = readFileSync(commandPath).toString('utf8');
		if (!content.trim()) return false;
		const normalized = content.replaceAll('\\', '/').toLowerCase();
		const relativeTarget = win32.relative(binDir, expectedTarget).replaceAll('\\', '/').toLowerCase();
		return normalized.includes(relativeTarget) || normalized.includes('node_modules/@deepseek-ai/dsh/');
	} catch {
		return false;
	}
}

function commandIsOwned(
	commandPath: string | undefined,
	packageRoot: string,
	binDir: string,
	binTarget: string,
	platform: NodeJS.Platform
): boolean {
	if (!commandPath) return false;
	const api = pathApi(platform);
	if (!pathEquals(api.dirname(commandPath), api.normalize(binDir), platform)) return false;
	return shimReferencesPackage(commandPath, binDir, packageRoot, binTarget, platform);
}

function diagnosticFor(state: DshLifecycleState, packageVersion: string, commandVersion: string): string {
	switch (state) {
		case 'not-installed':
			return 'DeepSeek Harness 未安装。';
		case 'managed':
			return 'DeepSeek Harness 已由 ccq 管理。';
		case 'broken':
			return '检测到受管 DeepSeek Harness npm 包，但 dsh --version 不可用，可执行修复。';
		case 'version-mismatch':
			return `DeepSeek Harness 包版本 ${packageVersion || '-'} 与命令版本 ${commandVersion || '-'} 不一致，可执行修复。`;
		case 'external':
			return '检测到 PATH 中的 dsh 来自外部安装，ccq 不会接管、更新或卸载它。';
		case 'path-conflict':
			return '检测到受管 DeepSeek Harness npm 包，但 PATH 首个 dsh 不是该安装，生命周期操作已禁用。';
		case 'npm-unavailable':
			return 'npm 不可用，无法检测或修改 DeepSeek Harness。请先安装 npm。';
		case 'verification-unknown':
			return 'DeepSeek Harness 操作后无法确认最终状态，所有生命周期操作已禁用，请重新检测后再试。';
	}
}

function projection(
	state: DshLifecycleState,
	values: Omit<
		DshLifecycleProjection,
		| 'owner'
		| 'state'
		| 'packageName'
		| 'canInstall'
		| 'canUpdate'
		| 'canUninstall'
		| 'repairRequired'
		| 'diagnostic'
		| 'prereleaseWarning'
	> & {
		readonly packageVersion: string;
		readonly commandVersion: string;
	}
): DshLifecycleProjection {
	const canInstall = state === 'not-installed';
	const canUpdate = state === 'managed' || state === 'broken' || state === 'version-mismatch';
	const canUninstall = canUpdate;
	const repairRequired = state === 'broken' || state === 'version-mismatch';
	const warning = isPrerelease(values.packageVersion) || isPrerelease(values.commandVersion) ? DSH_PRERELEASE_WARNING : undefined;
	return {
		owner: DSH_TOOL_ID,
		state,
		packageName: DSH_PACKAGE_NAME,
		...values,
		canInstall,
		canUpdate,
		canUninstall,
		repairRequired,
		diagnostic: diagnosticFor(state, values.packageVersion, values.commandVersion),
		...(warning ? {prereleaseWarning: warning} : {})
	};
}

function npmUnavailableProjection(): DshLifecycleProjection {
	return projection('npm-unavailable', {
		packageVersion: '',
		commandVersion: '',
		packagePresent: false,
		commandPresent: false
	});
}

/** mutation 后检测自身失败时不能复用 mutation 前的可操作事实。 */
function verificationUnknownProjection(): DshLifecycleProjection {
	return projection('verification-unknown', {
		packageVersion: '',
		commandVersion: '',
		packagePresent: false,
		commandPresent: false
	});
}

/** Detect npm ownership, PATH precedence, command health, and package/command version parity. */
export async function detectDshLifecycle(deps: DshDetectionDeps = {}): Promise<DshLifecycleProjection> {
	const exec = deps.exec ?? execCommand;
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	let prefixResult: ExecResult;
	try {
		prefixResult = await exec('npm', ['prefix', '-g'], {timeout: DETECT_TIMEOUT_MS});
	} catch (error) {
		if (npmUnavailableError(error)) return npmUnavailableProjection();
		return npmUnavailableProjection();
	}

	if (prefixResult.code !== 0 || npmUnavailable(prefixResult)) return npmUnavailableProjection();
	const prefix = trimCommandOutput(prefixResult.stdout || prefixResult.stderr);
	if (!prefix) return npmUnavailableProjection();

	const paths = packagePaths(prefix, platform);
	const packageFacts = readPackageFacts(prefix, platform);
	const found = findPathCommand(env, platform);
	const commandInNpmBin = Boolean(found && pathEquals(pathApi(platform).dirname(found.path), paths.binDir, platform));
	const commandOwned =
		packageFacts.present && commandIsOwned(found?.path, paths.packageRoot, paths.binDir, packageFacts.binTarget, platform);
	const commandPresent = Boolean(found);

	let commandResult: ExecResult | undefined;
	let commandVersion = '';
	if (commandPresent) {
		try {
			commandResult = await exec(DSH_COMMAND, [...DSH_VERSION_ARGS], {
				timeout: DETECT_TIMEOUT_MS,
				env: withEnvironmentPath(env, environmentPath(env, platform), platform)
			});
			commandVersion = parseVersion(commandResult.stdout || commandResult.stderr);
		} catch {
			commandResult = undefined;
		}
	}

	let state: DshLifecycleState;
	if (!packageFacts.present) {
		state = commandPresent ? 'external' : 'not-installed';
	} else if (!commandPresent || !commandInNpmBin || !commandOwned) {
		state = commandPresent && !commandInNpmBin ? 'path-conflict' : 'broken';
	} else if (!packageFacts.valid || !commandResult || commandResult.code !== 0 || !commandVersion) {
		state = 'broken';
	} else if (commandVersion !== packageFacts.version) {
		state = 'version-mismatch';
	} else {
		state = 'managed';
	}

	return projection(state, {
		prefix,
		packageRoot: paths.packageRoot,
		packageVersion: packageFacts.version,
		commandVersion,
		...(found?.path ? {commandPath: found.path} : {}),
		packagePresent: packageFacts.present,
		commandPresent
	});
}

export function dshCanInstall(state: DshLifecycleProjection): boolean {
	return state.canInstall;
}

export function dshCanUpdate(state: DshLifecycleProjection): boolean {
	return state.canUpdate;
}

export function dshCanUninstall(state: DshLifecycleProjection): boolean {
	return state.canUninstall;
}

export function dshHasUpdate(current: string, latest: string): boolean | null {
	if (!current || !latest || !parseSemver(current) || !parseSemver(latest)) return null;
	return semverCompare(latest, current) > 0;
}

function operationError(result: ExecResult): string {
	const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
	return detail ? `npm 命令失败 (exit ${result.code}): ${detail}` : `npm 命令失败 (exit ${result.code})`;
}

function prependPathForDetection(env: NodeJS.ProcessEnv | undefined, binDir: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const source = env ?? process.env;
	const delimiter = pathDelimiter(platform);
	const entries = environmentPath(source, platform)
		.split(delimiter)
		.map(entry => entry.trim())
		.filter(Boolean)
		.filter(entry => !pathEquals(entry, binDir, platform));
	return withEnvironmentPath(source, [binDir, ...entries].join(delimiter), platform);
}

async function runNpmMutation(
	args: readonly string[],
	onProgress: ProgressCallback | undefined,
	exec: typeof execCommand
): Promise<ExecResult> {
	onProgress?.({
		level: 'info',
		message: formatCommandInstruction('npm', args),
		componentId: DSH_TOOL_ID,
		instruction: formatCommandInstruction('npm', args)
	});
	return exec('npm', [...args], {timeout: OPERATION_TIMEOUT_MS});
}

async function operateDsh(
	action: 'install' | 'update' | 'uninstall',
	onProgress?: ProgressCallback,
	deps: DshOperationDeps = {}
): Promise<DshOperationResult> {
	const exec = deps.exec ?? execCommand;
	const detect = deps.detect ?? detectDshLifecycle;
	let before: DshLifecycleProjection;
	try {
		before = await detect({exec, env: deps.env, platform: deps.platform});
	} catch (error) {
		return {id: DSH_TOOL_ID, success: false, error: error instanceof Error ? error.message : String(error)};
	}

	const allowed = action === 'install' ? dshCanInstall(before) : action === 'update' ? dshCanUpdate(before) : dshCanUninstall(before);
	if (!allowed) {
		return {id: DSH_TOOL_ID, success: false, state: before.state, lifecycle: before, error: before.diagnostic};
	}

	let mutationError: string | undefined;
	try {
		const result = await runNpmMutation(action === 'uninstall' ? DSH_UNINSTALL_ARGS : DSH_INSTALL_ARGS, onProgress, exec);
		if (result.code !== 0) {
			mutationError = operationError(result);
		}
	} catch (error) {
		mutationError = error instanceof Error ? error.message : String(error);
	}

	let postflightEnv = deps.env;
	if (action !== 'uninstall') {
		const platform = deps.platform ?? process.platform;
		const refreshedBinDir = await refreshNpmGlobalBinPath(onProgress, DSH_TOOL_ID, exec, platform);
		if (refreshedBinDir) {
			postflightEnv = prependPathForDetection(deps.env, refreshedBinDir, platform);
		} else if (!deps.env) {
			postflightEnv = process.env;
		}
	}

	let after: DshLifecycleProjection;
	try {
		after = await detect({exec, env: postflightEnv, platform: deps.platform});
	} catch (error) {
		const postflightError = error instanceof Error ? error.message : String(error);
		after = verificationUnknownProjection();
		return {
			id: DSH_TOOL_ID,
			success: false,
			state: after.state,
			lifecycle: after,
			error: [mutationError, `postflight 检测失败: ${postflightError}`].filter(Boolean).join('; ')
		};
	}

	if (mutationError) {
		return {id: DSH_TOOL_ID, success: false, state: after.state, lifecycle: after, error: mutationError};
	}

	if (action === 'uninstall') {
		if (after.state === 'npm-unavailable') {
			return {
				id: DSH_TOOL_ID,
				success: false,
				state: after.state,
				lifecycle: after,
				error: `卸载后无法确认 ${DSH_PACKAGE_NAME} 已移除：${after.diagnostic}`
			};
		}
		if (after.packagePresent) {
			return {
				id: DSH_TOOL_ID,
				success: false,
				state: after.state,
				lifecycle: after,
				error: `卸载后仍检测到 ${DSH_PACKAGE_NAME}。`
			};
		}
		return {
			id: DSH_TOOL_ID,
			success: true,
			state: after.state,
			lifecycle: after,
			...(after.state === 'external' ? {warning: after.diagnostic} : {})
		};
	}

	if (after.state !== 'managed') {
		return {
			id: DSH_TOOL_ID,
			success: false,
			state: after.state,
			lifecycle: after,
			error: `操作完成但 postflight 未达到受管状态：${after.diagnostic}`
		};
	}
	return {
		id: DSH_TOOL_ID,
		success: true,
		state: after.state,
		lifecycle: after,
		version: after.packageVersion || after.commandVersion,
		...(after.prereleaseWarning ? {warning: after.prereleaseWarning} : {})
	};
}

export function installDsh(onProgress?: ProgressCallback, deps: DshOperationDeps = {}): Promise<DshOperationResult> {
	return operateDsh('install', onProgress, deps);
}

export function updateDsh(onProgress?: ProgressCallback, deps: DshOperationDeps = {}): Promise<DshOperationResult> {
	return operateDsh('update', onProgress, deps);
}

export function uninstallDsh(onProgress?: ProgressCallback, deps: DshOperationDeps = {}): Promise<DshOperationResult> {
	return operateDsh('uninstall', onProgress, deps);
}
