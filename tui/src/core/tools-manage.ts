import {existsSync, readdirSync, readFileSync, rmSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {execCommand, type ProgressCallback} from './exec.js';
import {
	getNpmOutdatedGlobal,
	checkCliToolUpdates,
	applyUpdates,
	createSnapshot,
	type UpdateComponent,
	type ApplyUpdatesDeps,
	type ApplyUpdatesResult
} from './update.js';
import {installTool, TOOL_DEFINITIONS, type ToolId} from './tools-install.js';
import {atomicWrite} from './fs-utils.js';
import {claudeDir, resolveHome, rulesDir, settingsPath} from './paths.js';

// tools-manage core：工具管理单一真理源（design TDR-11）。
// 融合 tools-install.ts（5 工具安装定义）与 update.ts（CLI 组件检测/快照/应用），
// 新增 ClaudeCode 纳入受管（isBase=true），消除 TOOL_DEFINITIONS 与 NPM_COMPONENT_MAP/COMMAND_COMPONENTS 重复。
// 检测不聚合 Skills/MCP（11.7）—— Skills/MCP 更新各归各家视图。
// 安装路径复用 tools-install.installTool（11.8），更新路径复用 update.applyUpdates（11.9）。

export type ComponentId = 'ClaudeCode' | ToolId;

export type ComponentKind = 'npm' | 'ccg-init' | 'shell-script';

/** 受管组件静态定义（融合 ToolDefinition + isBase + UpdateComponent 静态字段）。 */
export type ComponentDefinition = {
	readonly id: ComponentId;
	readonly name: string;
	readonly description: string;
	readonly kind: ComponentKind;
	readonly command: string; // 检测用命令
	readonly versionArgs: readonly string[];
	readonly npmPackage?: string; // kind === 'npm' 远程版本查询用
	readonly isBase: boolean; // ClaudeCode=true（卸载附危险警告）
	readonly optional: boolean;
};

/** 受管组件运行时状态（检测填充静态定义 + 版本/更新字段）。 */
export type ManagedComponent = ComponentDefinition & {
	readonly installed: boolean;
	readonly currentVersion: string;
	readonly latestVersion: string;
	readonly hasUpdate: boolean | null;
	readonly statusHint?: string;
};

/** 单组件安装结果（对齐 ToolInstallOutcome 结构，id 扩展为 ComponentId）。 */
export type ComponentInstallOutcome = {
	readonly id: ComponentId;
	readonly success: boolean;
	readonly error?: string;
};

/** 安装依赖注入（仅 ClaudeCode 分支生效，供测试 mock exec；5 工具经 installTool 不支持注入）。 */
export type InstallComponentDeps = {
	readonly exec?: typeof execCommand;
};

const INSTALL_TIMEOUT_MS = 300000;
const DETECT_TIMEOUT_MS = 5000;

// ClaudeCode 定义（Phase 6 的 TOOL_DEFINITIONS 不含，tools-manage 新增）。
const CLAUDE_CODE_DEFINITION: ComponentDefinition = {
	id: 'ClaudeCode',
	name: 'Claude Code',
	description: 'Anthropic 官方 Claude Code CLI（基础组件，npm 全局）',
	kind: 'npm',
	command: 'claude',
	versionArgs: ['--version'],
	npmPackage: '@anthropic-ai/claude-code',
	isBase: true,
	optional: false
};

/**
 * 全部受管组件定义（6 项）：ClaudeCode + 5 工具。
 * 5 工具复用 tools-install.TOOL_DEFINITIONS（DRY，单一真理源），叠加 isBase=false。
 */
export const COMPONENT_DEFINITIONS: readonly ComponentDefinition[] = [
	CLAUDE_CODE_DEFINITION,
	...TOOL_DEFINITIONS.map(tool => ({...tool, isBase: false}))
];

function friendlyError(text: string, fallback: string): string {
	if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(text)) {
		return '无法访问 npm 仓库，请检查网络连接或代理镜像';
	}

	if (/EACCES|EPERM|permission/i.test(text)) {
		return '文件权限不足，请检查目录权限或以管理员身份重试';
	}

	return fallback;
}

function parseVersion(text: string): string {
	return text.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? text.trim();
}

/**
 * 检测全部受管组件（6 项），不聚合 Skills/MCP（11.7）。
 * 复用 update.checkCliToolUpdates（返回正好 6 个 CLI 组件：ClaudeCode/Ccline/CcgWorkflow/CodexCli/OpenSpec + AntigravityCli），
 * join COMPONENT_DEFINITIONS 静态字段（description/kind/command/isBase 等）。
 */
export async function detectComponents(onProgress?: ProgressCallback): Promise<ManagedComponent[]> {
	onProgress?.({level: 'info', message: '正在检测组件状态与远程版本...'});
	const outdated = await getNpmOutdatedGlobal(false);
	const detected = await checkCliToolUpdates(outdated);

	return COMPONENT_DEFINITIONS.map(def => {
		const match = detected.find((component: UpdateComponent) => component.id === def.id);
		if (!match) {
			return {...def, installed: false, currentVersion: '', latestVersion: '', hasUpdate: null};
		}

		return {
			...def,
			installed: match.installed,
			currentVersion: match.currentVersion,
			latestVersion: match.latestVersion,
			hasUpdate: match.hasUpdate,
			statusHint: match.statusHint
		};
	});
}

/**
 * 安装单个组件（11.6 ClaudeCode 新增 / 11.8 五工具复用 installTool）。
 * ClaudeCode 走 npm install -g + 检测确认，支持 deps.exec 注入供测试；
 * 5 工具复用 tools-install.installTool（含 CcgWorkflow npx init / Antigravity shell 脚本），不重写。
 */
export async function installComponent(
	id: ComponentId,
	onProgress?: ProgressCallback,
	deps: InstallComponentDeps = {}
): Promise<ComponentInstallOutcome> {
	const definition = COMPONENT_DEFINITIONS.find(item => item.id === id);
	if (!definition) {
		return {id, success: false, error: '未知组件'};
	}

	try {
		if (id === 'ClaudeCode') {
			const exec = deps.exec ?? execCommand;
			onProgress?.({level: 'info', message: 'npm install -g @anthropic-ai/claude-code', componentId: 'ClaudeCode'});
			const result = await exec('npm', ['install', '-g', '@anthropic-ai/claude-code'], {timeout: INSTALL_TIMEOUT_MS});
			if (result.code !== 0) {
				throw new Error(friendlyError(result.stderr || result.stdout, `npm install 失败 (exit ${result.code})`));
			}

			const check = await exec('claude', ['--version'], {timeout: DETECT_TIMEOUT_MS});
			if (check.code === 0) {
				const version = parseVersion(check.stdout || check.stderr || '');
				onProgress?.({level: 'success', message: `Claude Code 安装成功${version ? ` (${version})` : ''}`, componentId: 'ClaudeCode'});
				return {id: 'ClaudeCode', success: true};
			}

			onProgress?.({level: 'warning', message: 'Claude Code 安装完成但命令暂不可用（可能需重启终端）', componentId: 'ClaudeCode'});
			return {id: 'ClaudeCode', success: false, error: '安装后命令不可用'};
		}

		// 5 工具复用 tools-install.installTool（11.8，不重写 Phase 6 已实现逻辑）
		return installTool(id, onProgress);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onProgress?.({level: 'danger', message: `${definition.name} 安装失败: ${message}`, componentId: id});
		return {id, success: false, error: message};
	}
}

/** ManagedComponent → UpdateComponent 映射（applyUpdates 按 type 分发）。
 *  kind→type: npm/ccg-init → 'npm'（applyUpdates 对 id==='CcgWorkflow' 特判 npx init）；
 *  shell-script → 'cli'（applyUpdates 对 cli 走 agy update 提示 noop）。 */
function toUpdateComponent(component: ManagedComponent): UpdateComponent {
	const type = component.kind === 'shell-script' ? 'cli' : 'npm';
	return {
		id: component.id,
		name: component.name,
		type,
		package: component.npmPackage,
		installed: component.installed,
		currentVersion: component.currentVersion,
		latestVersion: component.latestVersion,
		hasUpdate: component.hasUpdate,
		statusHint: component.statusHint
	};
}

/**
 * 更新选中组件（11.9 复用 applyUpdates：CcgWorkflow npx init 特判、npm install -g 保留）。
 * snapshot-before-write 由 applyUpdates 内部 createSnapshot 保证（P-13）。
 */
export async function updateComponents(
	components: readonly ManagedComponent[],
	onProgress?: ProgressCallback,
	deps: ApplyUpdatesDeps = {}
): Promise<ApplyUpdatesResult> {
	return applyUpdates(components.map(toUpdateComponent), onProgress, deps);
}

// ── 卸载层（Phase 11C）────────────────────────────────────────────────────────
// 全部卸载经统一入口 uninstallComponent，破坏性写前 snapshot-before-write（11.15，P-13）。
// 深度卸载只动 ccg 受管路径，保留用户自定义 hooks/statusLine（HC-UNINSTALL-DEEP，P-12）。

/**
 * CcgWorkflow 受管删除清单（相对 ~/.claude）。
 * 对齐 contracts/ccg-workflow.json 的 verifyItems（commands/ccg、agents/ccg、.ccg、bin/codeagent-wrapper）
 * + 官方 uninstallWorkflows 补充（skills/ccg、hooks/ccg）。
 * 注：ccg-workflow.json 当前处于 9B contracts 拆分迁移中（磁盘暂缺），故内联为常量保持鲁棒与单一真理源；
 * 9B 落地后可改为读取契约。
 */
const CCG_MANAGED_PATHS: readonly string[] = [
	'commands/ccg',
	'agents/ccg',
	'skills/ccg',
	'hooks/ccg',
	'.ccg',
	'bin/codeagent-wrapper'
];

/**
 * CcgWorkflow 受管 rules 文件清单（~/.claude/rules/ 下）。
 * 对齐 contracts/ccg-workflow.json 的 managedRuleFiles（ccq- 前缀，ccg-workflow 安装时写入）。
 * 注：ccq- 前缀中仅这 4 个属 CcgWorkflow 受管，其余 ccq-*（如 install 写入的 ccq-mcp-*.md）
 * 为本项目 rules，不删——故用显式清单而非前缀通配。
 */
const CCG_MANAGED_RULE_FILES: readonly string[] = [
	'ccq-ccgworkflow.md',
	'ccq-multimodel.md',
	'ccq-tools.md',
	'ccq-workflow.md'
];

/** 单组件卸载结果（manualHint 保留字段；Antigravity 已改为 fs 直删，当前不再产出 manualHint）。 */
export type ComponentUninstallOutcome = {
	readonly id: ComponentId;
	readonly success: boolean;
	readonly error?: string;
	readonly manualHint?: string;
};

/** 卸载依赖注入（供测试 mock exec / 注入快照失败点验证 P-13）。 */
export type UninstallComponentDeps = {
	readonly exec?: typeof execCommand;
	readonly createSnapshotFn?: () => string;
};

/**
 * 卸载单个组件（统一入口）。
 * 11.15 snapshot-before-write：任何破坏性写前先 createSnapshot，快照失败立即中止（exec 零调用，P-13）。
 * 按 kind 分发：npm → npm uninstall -g（Ccline 附 statusLine 还原）；ccg-init → 深度 fs 清理；shell-script → agy 探测。
 */
export async function uninstallComponent(
	id: ComponentId,
	onProgress?: ProgressCallback,
	deps: UninstallComponentDeps = {}
): Promise<ComponentUninstallOutcome> {
	const definition = COMPONENT_DEFINITIONS.find(item => item.id === id);
	if (!definition) {
		return {id, success: false, error: '未知组件'};
	}

	// 11.15 snapshot-before-write：快照失败则中止，不执行任何卸载命令/删除
	const makeSnapshot = deps.createSnapshotFn ?? createSnapshot;
	try {
		const snapshotPath = makeSnapshot();
		onProgress?.({level: 'success', message: `卸载快照已创建（${snapshotPath}）`, componentId: id});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onProgress?.({level: 'danger', message: `卸载快照创建失败，已中止: ${message}`, componentId: id});
		return {id, success: false, error: `快照失败: ${message}`};
	}

	const exec = deps.exec ?? execCommand;
	try {
		switch (definition.kind) {
			case 'npm':
				await uninstallNpmPackage(definition, exec, onProgress);
				if (definition.id === 'Ccline') {
					restoreCclineStatusLine(onProgress);
				}

				break;
			case 'ccg-init':
				await uninstallCcgWorkflow(exec, onProgress);
				break;
			case 'shell-script':
				await uninstallAntigravity(onProgress);
				break;
		}

		onProgress?.({level: 'success', message: `${definition.name} 已卸载`, componentId: id});
		return {id, success: true};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onProgress?.({level: 'danger', message: `${definition.name} 卸载失败: ${message}`, componentId: id});
		return {id, success: false, error: message};
	}
}

/** 11.10 npm 全局卸载（ClaudeCode / OpenSpec / CodexCli / Ccline）。 */
async function uninstallNpmPackage(
	definition: ComponentDefinition,
	exec: typeof execCommand,
	onProgress?: ProgressCallback
): Promise<void> {
	if (!definition.npmPackage) {
		throw new Error(`${definition.id} 缺少 npm 包名`);
	}

	onProgress?.({level: 'info', message: `npm uninstall -g ${definition.npmPackage}`, componentId: definition.id});
	const result = await exec('npm', ['uninstall', '-g', definition.npmPackage], {timeout: INSTALL_TIMEOUT_MS});
	if (result.code !== 0) {
		throw new Error(friendlyError(result.stderr || result.stdout, `npm uninstall 失败 (exit ${result.code})`));
	}
}

/** statusLine 是否恰好等于本工具写入的受管值（键集合也相等，用户任何修改都视为自定义并保护）。 */
function isManagedCclineStatusLine(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const sl = value as Record<string, unknown>;
	return Object.keys(sl).length === 3 && sl['type'] === 'command' && sl['command'] === 'ccline' && sl['padding'] === 0;
}

/** 11.11 Ccline 卸载后还原 statusLine：仅当值等于受管值时移除（保护用户自定义），atomicWrite。 */
function restoreCclineStatusLine(onProgress?: ProgressCallback): void {
	const path = settingsPath();
	if (!existsSync(path)) {
		return;
	}

	let settings: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			return;
		}

		settings = parsed as Record<string, unknown>;
	} catch {
		onProgress?.({level: 'warning', message: 'settings.json 解析失败，跳过 statusLine 还原', componentId: 'Ccline'});
		return;
	}

	if (!isManagedCclineStatusLine(settings['statusLine'])) {
		return;
	}

	delete settings['statusLine'];
	try {
		atomicWrite(path, JSON.stringify(settings, null, 2));
		onProgress?.({level: 'success', message: '已移除受管 statusLine 配置', componentId: 'Ccline'});
	} catch (error) {
		onProgress?.({level: 'warning', message: `statusLine 还原失败: ${error instanceof Error ? error.message : String(error)}`, componentId: 'Ccline'});
	}
}

/** hook 条目的 command 字段（非对象返回 undefined）。 */
function hookCommandOf(entry: unknown): unknown {
	if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
		return (entry as Record<string, unknown>)['command'];
	}

	return undefined;
}

/** command 是否为 ccg 受管 hook（codeagent-wrapper 或 .ccg/ccg 路径）。 */
function isCcgHookCommand(command: unknown): boolean {
	return typeof command === 'string' && /codeagent-wrapper|[\\/]\.?ccg[\\/]/i.test(command);
}

/**
 * 从 settings.hooks 注销 ccg 受管 hook（保留用户自定义）。返回是否有改动。
 * 结构：hooks[event] = [{matcher, hooks:[{type,command}]}]；仅移除 command 命中 ccg 的内层条目，
 * 组内全为 ccg 则丢弃该组，事件下无组则删事件键。
 */
function pruneCcgHooks(settings: Record<string, unknown>): boolean {
	const hooks = settings['hooks'];
	if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
		return false;
	}

	const hooksObj = hooks as Record<string, unknown>;
	let changed = false;

	for (const event of Object.keys(hooksObj)) {
		const groups = hooksObj[event];
		if (!Array.isArray(groups)) {
			continue;
		}

		const keptGroups: unknown[] = [];
		for (const group of groups) {
			if (typeof group !== 'object' || group === null || Array.isArray(group)) {
				keptGroups.push(group);
				continue;
			}

			const groupObj = group as Record<string, unknown>;
			const inner = groupObj['hooks'];
			if (Array.isArray(inner)) {
				const keptInner = inner.filter(entry => !isCcgHookCommand(hookCommandOf(entry)));
				if (keptInner.length !== inner.length) {
					changed = true;
				}

				if (inner.length > 0 && keptInner.length === 0) {
					continue; // 组内 hooks 全为 ccg → 丢弃整组
				}

				groupObj['hooks'] = keptInner;
			}

			keptGroups.push(groupObj);
		}

		if (keptGroups.length === 0) {
			delete hooksObj[event];
		} else {
			hooksObj[event] = keptGroups;
		}
	}

	return changed;
}

/**
 * 11.12 CcgWorkflow 深度卸载（Node fs 复刻官方清单，不调起 npx 交互菜单，HC-TUI-NODE-ONLY）。
 * 删受管目录/二进制 + 受管 rules + 注销 ccg hooks（保留用户自定义）；
 * 11.13 探测全局 npm 包 ccg-workflow，存在则一并 npm uninstall -g。
 */
async function uninstallCcgWorkflow(exec: typeof execCommand, onProgress?: ProgressCallback): Promise<void> {
	const base = claudeDir();

	// 1. 删除受管目录/文件（仅 ccg 受管路径）
	for (const rel of CCG_MANAGED_PATHS) {
		const target = join(base, rel);
		if (!existsSync(target)) {
			continue;
		}

		try {
			rmSync(target, {recursive: true, force: true});
			onProgress?.({level: 'success', message: `已删除 ${rel}`, componentId: 'CcgWorkflow'});
		} catch (error) {
			onProgress?.({level: 'warning', message: `删除 ${rel} 失败: ${error instanceof Error ? error.message : String(error)}`, componentId: 'CcgWorkflow'});
		}
	}

	// 2. 清理 CcgWorkflow 受管 rules 文件（对齐 contracts/ccg-workflow.json managedRuleFiles）。
	//    删清单内 ccq- 文件（CcgWorkflow 安装写入）+ 兼容旧版官方 ccg-*.md；
	//    保留其余 ccq-*（本项目 install rules）与用户自定义。
	const rules = rulesDir();
	const ruleFiles = new Set<string>();
	try {
		for (const file of readdirSync(rules)) {
			ruleFiles.add(file);
		}
	} catch {
		/* rules 目录不存在或读取失败，跳过 */
	}

	const legacyCcgRules = [...ruleFiles].filter(file => file.startsWith('ccg-') && file.endsWith('.md'));
	for (const file of [...CCG_MANAGED_RULE_FILES, ...legacyCcgRules]) {
		if (!ruleFiles.has(file)) {
			continue;
		}

		try {
			unlinkSync(join(rules, file));
			onProgress?.({level: 'success', message: `已删除 rules/${file}`, componentId: 'CcgWorkflow'});
		} catch {
			/* 单个 rules 删除失败不阻塞 */
		}
	}

	// 3. 从 settings.json 注销 ccg hooks（保留用户自定义）
	const sPath = settingsPath();
	if (existsSync(sPath)) {
		try {
			const parsed = JSON.parse(readFileSync(sPath, 'utf8')) as unknown;
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				const settings = parsed as Record<string, unknown>;
				if (pruneCcgHooks(settings)) {
					atomicWrite(sPath, JSON.stringify(settings, null, 2));
					onProgress?.({level: 'success', message: '已从 settings.json 注销 ccg hooks', componentId: 'CcgWorkflow'});
				}
			}
		} catch {
			onProgress?.({level: 'warning', message: 'settings.json 解析失败，跳过 hooks 注销', componentId: 'CcgWorkflow'});
		}
	}

	// 4. 全局 npm 包探测（11.13）：ccg-workflow 若装为全局包则一并卸载
	try {
		const ls = await exec('npm', ['ls', '-g', 'ccg-workflow', '--depth=0'], {timeout: 30000});
		if (ls.code === 0 && /ccg-workflow@/.test(ls.stdout)) {
			onProgress?.({level: 'info', message: 'npm uninstall -g ccg-workflow', componentId: 'CcgWorkflow'});
			await exec('npm', ['uninstall', '-g', 'ccg-workflow'], {timeout: INSTALL_TIMEOUT_MS});
		}
	} catch {
		/* 探测失败不阻塞（ccg-workflow 通常为 npx init 非全局包） */
	}
}

/**
 * 11.14 Antigravity 卸载：agy 无官方 uninstall 子命令，按官方文档直接删除安装文件。
 * macOS/Linux：~/.local/bin/agy + update-antigravity-cli + ~/.cache/antigravity；
 * Windows：%LOCALAPPDATA%\agy\bin 整目录。文件不存在则跳过（可能未装或已手动清理）。
 */
async function uninstallAntigravity(onProgress?: ProgressCallback): Promise<void> {
	const targets: string[] = [];
	if (process.platform === 'win32') {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData) {
			targets.push(join(localAppData, 'agy', 'bin'));
		}
	} else {
		const home = resolveHome();
		targets.push(join(home, '.local', 'bin', 'agy'));
		targets.push(join(home, '.local', 'bin', 'update-antigravity-cli'));
		targets.push(join(home, '.cache', 'antigravity'));
	}

	let removed = false;
	for (const target of targets) {
		if (!existsSync(target)) {
			continue;
		}

		try {
			rmSync(target, {recursive: true, force: true});
			onProgress?.({level: 'success', message: `已删除 ${target}`, componentId: 'AntigravityCli'});
			removed = true;
		} catch (error) {
			onProgress?.({
				level: 'warning',
				message: `删除 ${target} 失败: ${error instanceof Error ? error.message : String(error)}`,
				componentId: 'AntigravityCli'
			});
		}
	}

	if (!removed) {
		onProgress?.({level: 'warning', message: '未找到 Antigravity 安装文件（可能未安装或路径已变更）', componentId: 'AntigravityCli'});
	}
}

export type {ApplyUpdatesDeps, ApplyUpdatesResult};
