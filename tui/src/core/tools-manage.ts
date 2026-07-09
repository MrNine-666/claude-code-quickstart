import {existsSync, readFileSync, rmSync} from 'node:fs';
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
import {refreshNpmGlobalBinPath} from './npm-path.js';
import {atomicWrite} from './fs-utils.js';
import {resolveHome, settingsPath} from './paths.js';
import type {AgentContext} from '../state/manage-state.js';
import {
	codeGraphRemoveCliCommands,
	codeGraphUninstallCommands,
	ccgWorkflowUninstallCommands,
	type LifecycleCommand
} from './tools-lifecycle.js';
import {hasUpdate} from './semver.js';
import {hasCodeGraphIntegration, hasCodexCcgWorkflowMode, readCodexCcgWorkflowVersion} from './tools-integrations.js';

// tools-manage core：工具管理单一真理源（design TDR-11）。
// 融合 tools-install.ts（6 工具安装定义）与 update.ts（CLI 组件检测/快照/应用），
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
	readonly version?: string;
	readonly error?: string;
};

/** 安装依赖注入（仅 ClaudeCode 分支生效，供测试 mock exec；6 工具经 installTool 不支持注入）。 */
export type InstallComponentDeps = {
	readonly exec?: typeof execCommand;
	// 当前 Agent 上下文（design D4/D5）：CodeGraph 接入目标与 CcgWorkflow Codex 引导按此分支，默认 Claude Code。
	readonly agentContext?: AgentContext;
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
 * 全部受管组件定义（7 项）：ClaudeCode + 6 工具。
 * 6 工具复用 tools-install.TOOL_DEFINITIONS（DRY，单一真理源），叠加 isBase=false。
 */
export const COMPONENT_DEFINITIONS: readonly ComponentDefinition[] = [
	CLAUDE_CODE_DEFINITION,
	...TOOL_DEFINITIONS.map(tool => ({...tool, isBase: false}))
];

// ── 分组与可见性（Phase 3，design D3 / spec codex-tool-lifecycle）─────────────────
// group: agent = 主 Agent（Claude Code / Codex 两上下文常显）；
//        companion = 仅 Claude Code（Ccline）；tool = 两上下文通用（OpenSpec/CcgWorkflow/CodeGraph）。
// 可见性矩阵冻结于 verify-tools-context.mjs（PBT-3），此处为唯一真理源。

export type ToolGroup = 'agent' | 'companion' | 'tool';

export type ToolGroupDisplayMeta = {
	readonly label: string;
	readonly description: string;
};

/** 组件分组 + 可见上下文元数据（可见性 resolver 单一真理源；key 顺序即组内展示顺序）。 */
export type ComponentMeta = {
	readonly group: ToolGroup;
	readonly contexts: readonly AgentContext[];
};

const BOTH_CONTEXTS: readonly AgentContext[] = ['cc', 'cx'];

export const COMPONENT_META: Readonly<Record<ComponentId, ComponentMeta>> = {
	ClaudeCode: {group: 'agent', contexts: BOTH_CONTEXTS},
	CodexCli: {group: 'agent', contexts: BOTH_CONTEXTS},
	AntigravityCli: {group: 'agent', contexts: BOTH_CONTEXTS},
	Ccline: {group: 'companion', contexts: ['cc']},
	OpenSpec: {group: 'tool', contexts: BOTH_CONTEXTS},
	CcgWorkflow: {group: 'tool', contexts: BOTH_CONTEXTS},
	CodeGraph: {group: 'tool', contexts: BOTH_CONTEXTS}
};

/** 分组展示顺序（agent → companion → tool）。 */
export const TOOL_GROUP_ORDER: readonly ToolGroup[] = ['agent', 'companion', 'tool'];

export const TOOL_GROUP_META: Readonly<Record<ToolGroup, ToolGroupDisplayMeta>> = {
	agent: {label: 'Agent', description: 'Claude Code / Codex / Antigravity 等主入口 CLI'},
	companion: {label: 'statusLine', description: '状态栏与伴随增强'},
	tool: {label: '三方工具', description: 'OpenSpec / CCG Workflow / CodeGraph 等通用工具'}
};

export type ToolGroupSection<T extends {readonly id: ComponentId}> = {
	readonly group: ToolGroup;
	readonly label: string;
	readonly components: readonly T[];
};

const COMPONENT_DISPLAY_ORDER = Object.keys(COMPONENT_META) as ComponentId[];
const COMPONENT_DISPLAY_INDEX = new Map<ComponentId, number>(COMPONENT_DISPLAY_ORDER.map((id, index) => [id, index]));

function groupOrderIndex(group: ToolGroup): number {
	const index = TOOL_GROUP_ORDER.indexOf(group);
	return index === -1 ? TOOL_GROUP_ORDER.length : index;
}

function componentDisplayIndex(id: ComponentId): number {
	return COMPONENT_DISPLAY_INDEX.get(id) ?? COMPONENT_DISPLAY_INDEX.size;
}

/** 按 group 顺序 + 组内展示顺序排序，供 UI 和可见定义共用。 */
export function sortComponentsByToolGroup<T extends {readonly id: ComponentId}>(components: readonly T[]): readonly T[] {
	return [...components].sort((left, right) => {
		const leftMeta = COMPONENT_META[left.id];
		const rightMeta = COMPONENT_META[right.id];
		const groupDelta = groupOrderIndex(leftMeta.group) - groupOrderIndex(rightMeta.group);
		if (groupDelta !== 0) {
			return groupDelta;
		}

		return componentDisplayIndex(left.id) - componentDisplayIndex(right.id);
	});
}

/** 将组件整理为“分组 label + grid”视图结构，空组自动隐藏。 */
export function groupComponentsByToolGroup<T extends {readonly id: ComponentId}>(components: readonly T[]): readonly ToolGroupSection<T>[] {
	const sorted = sortComponentsByToolGroup(components);
	return TOOL_GROUP_ORDER
		.map(group => ({
			group,
			label: TOOL_GROUP_META[group].label,
			components: sorted.filter(component => COMPONENT_META[component.id].group === group)
		}))
		.filter(section => section.components.length > 0);
}

/** 某组件是否在给定 agentContext 下可见。 */
export function isComponentVisible(id: ComponentId, context: AgentContext): boolean {
	return COMPONENT_META[id].contexts.includes(context);
}

/** 按 agentContext 过滤可见组件定义，并按工具管理分组展示顺序排序。 */
export function visibleComponentDefinitions(context: AgentContext): readonly ComponentDefinition[] {
	return sortComponentsByToolGroup(COMPONENT_DEFINITIONS.filter(def => isComponentVisible(def.id, context)));
}

/** 按 agentContext 过滤可见运行时组件（供 ToolsView 消费），并对齐分组展示顺序。 */
export function filterVisibleComponents(
	components: readonly ManagedComponent[],
	context: AgentContext
): readonly ManagedComponent[] {
	return sortComponentsByToolGroup(
		components
			.filter(component => isComponentVisible(component.id, context))
			.map(component => withContextInstallState(component, context))
	);
}

/**
 * Tools 组在两个 Header 下都可见，但 CcgWorkflow / CodeGraph 的“已安装”语义是 per-Agent 集成。
 * Codex 下必须看 CODEX_HOME 的真实落盘信号，不能把 Claude Code 或全局 CLI 状态直接复用过来。
 */
function withContextInstallState(component: ManagedComponent, context: AgentContext): ManagedComponent {
	if (component.id === 'CodeGraph') {
		const label = context === 'cx' ? 'Codex 未接入 CodeGraph' : 'Claude Code 未接入 CodeGraph';
		return withAgentIntegration(component, hasCodeGraphIntegration(context), label);
	}

	if (context === 'cx' && component.id === 'CcgWorkflow') {
		return withCodexCcgWorkflowState(component);
	}

	return component;
}

function withCodexCcgWorkflowState(component: ManagedComponent): ManagedComponent {
	if (!hasCodexCcgWorkflowMode()) {
		return withAgentIntegration(component, false, 'Codex Mode 未安装');
	}

	const currentVersion = readCodexCcgWorkflowVersion();
	const latestVersion = component.latestVersion || currentVersion;
	return {
		...component,
		installed: true,
		currentVersion,
		latestVersion,
		hasUpdate: latestVersion ? hasUpdate(currentVersion, latestVersion) : false,
		statusHint: currentVersion ? component.statusHint : 'Codex Mode 已安装，版本文件不可读'
	};
}

function withAgentIntegration(component: ManagedComponent, integrated: boolean, missingHint: string): ManagedComponent {
	if (integrated) {
		return component;
	}

	return {
		...component,
		installed: false,
		hasUpdate: null,
		statusHint: component.installed ? missingHint : component.statusHint
	};
}

/**
 * 卸载影响说明（3.11）：按组件 + agentContext 返回真实影响范围文案，供确认弹窗展示。
 * CodeGraph 默认卸载只解除当前 Agent 集成（不卸 npm、不删 .codegraph/）；
 * CcgWorkflow Codex 只删 CCG-managed 文件（不删 config.toml）；CodexCli 卸载后 `ccq cx` 不可用。
 */
export function uninstallImpactNotice(id: ComponentId, context: AgentContext): string {
	const agentLabel = context === 'cx' ? 'Codex' : 'Claude Code';
	switch (id) {
		case 'ClaudeCode':
			return '将 npm 全局卸载 Claude Code，破坏整个 Claude Code 环境。';
		case 'CodexCli':
			return '将 npm 全局卸载 Codex CLI；卸载后 `ccq cx` 在重新安装前不可用。';
		case 'CodeGraph':
			return `仅解除 ${agentLabel} 的 CodeGraph 集成（codegraph uninstall），不卸载 npm CLI、不删除项目 .codegraph/ 索引。`;
		case 'CcgWorkflow':
			return context === 'cx'
				? '将通过官方命令 `npx ccg-workflow codex-mode uninstall` 卸载 Codex Mode；CODEX_HOME/config.toml 由官方命令处理，ccq 不直接删除。'
				: '将通过官方命令 `npx ccg-workflow uninstall` 卸载 CCG Workflow；CCG-managed 文件/hooks 由官方命令清理。';
		default:
			return '确认卸载此组件？此操作不可撤销。';
	}
}

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
 * 检测全部受管组件（7 项），不聚合 Skills/MCP（11.7）。
 * 复用 update.checkCliToolUpdates（返回正好 7 个 CLI 组件：ClaudeCode/Ccline/CcgWorkflow/CodexCli/OpenSpec/CodeGraph + AntigravityCli），
 * join COMPONENT_DEFINITIONS 静态字段（description/kind/command/isBase 等）。
 */
export async function detectComponents(onProgress?: ProgressCallback, forceRefresh = false): Promise<ManagedComponent[]> {
	onProgress?.({level: 'info', message: '正在检测组件状态与远程版本...'});
	const outdated = await getNpmOutdatedGlobal(forceRefresh);
	const detected = await checkCliToolUpdates(outdated, forceRefresh);

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
 * 6 工具复用 tools-install.installTool（含 CcgWorkflow npx init / Antigravity shell 脚本），不重写。
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

			await refreshNpmGlobalBinPath(onProgress, 'ClaudeCode', exec);
			const check = await exec('claude', ['--version'], {timeout: DETECT_TIMEOUT_MS});
			if (check.code === 0) {
				const version = parseVersion(check.stdout || check.stderr || '');
				onProgress?.({level: 'success', message: `Claude Code 安装成功${version ? ` (${version})` : ''}`, componentId: 'ClaudeCode'});
				return {id: 'ClaudeCode', success: true, version};
			}

			onProgress?.({level: 'warning', message: 'Claude Code 安装完成但命令暂不可用（可能需重启终端）', componentId: 'ClaudeCode'});
			return {id: 'ClaudeCode', success: false, error: '安装后命令不可用'};
		}

		// 6 工具复用 tools-install.installTool（11.8，不重写 Phase 6 已实现逻辑）
		// agentContext 决定 CodeGraph 接入目标（claude|codex）与 CcgWorkflow Codex 引导分支。
		return installTool(id, onProgress, deps.agentContext ?? 'cc');
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
	// 当前 Agent 上下文（design D4/D5）：CodeGraph 默认卸载只解除当前 Agent 集成；
	// CcgWorkflow Codex 卸载只删 CCG-managed 文件、绝不删 config.toml。默认 Claude Code。
	readonly agentContext?: AgentContext;
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
	const context: AgentContext = deps.agentContext ?? 'cc';
	try {
		switch (definition.kind) {
			case 'npm':
				if (definition.id === 'CodeGraph') {
					await uninstallCodeGraph(context, exec, onProgress);
					break;
				}

				await uninstallNpmPackage(definition, exec, onProgress);
				if (definition.id === 'Ccline') {
					restoreCclineStatusLine(onProgress);
				}

				break;
			case 'ccg-init':
				// design D5：CcgWorkflow 安装/卸载统一走官方非交互命令。
				// Claude Code → `npx ccg-workflow uninstall`；Codex → `npx ccg-workflow codex-mode uninstall`。
				// config.toml/AGENTS.md 等文件边界由官方命令负责，ccq 不再手写 fs 删除。
				await runLifecycleCommands(ccgWorkflowUninstallCommands(context), exec, 'CcgWorkflow', onProgress);
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

async function uninstallCodeGraph(
	context: AgentContext,
	exec: typeof execCommand,
	onProgress?: ProgressCallback
): Promise<void> {
	await runLifecycleCommands(codeGraphUninstallCommands(context), exec, 'CodeGraph', onProgress);
	if (hasCodeGraphIntegration('cc') || hasCodeGraphIntegration('cx')) {
		onProgress?.({level: 'info', message: '仍有 Agent 接入 CodeGraph，保留共享 CLI', componentId: 'CodeGraph'});
		return;
	}

	await runLifecycleCommands(codeGraphRemoveCliCommands(), exec, 'CodeGraph', onProgress);
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

/** 顺序执行 lifecycle 解析器产出的命令（CodeGraph 等），任一失败即抛错中止。 */
async function runLifecycleCommands(
	commands: readonly LifecycleCommand[],
	exec: typeof execCommand,
	componentId: ComponentId,
	onProgress?: ProgressCallback
): Promise<void> {
	for (const command of commands) {
		onProgress?.({level: 'info', message: `${command.cmd} ${command.args.join(' ')}`, componentId});
		const result = await exec(command.cmd, [...command.args], {timeout: INSTALL_TIMEOUT_MS});
		if (result.code !== 0) {
			throw new Error(friendlyError(result.stderr || result.stdout, `${componentId} 命令失败 (exit ${result.code})`));
		}
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
