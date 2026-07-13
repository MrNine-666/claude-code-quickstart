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
import {installTool, TOOL_DEFINITIONS, type ToolId, type ToolDefinition} from './tools-install.js';
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
import {hasCodeGraphIntegration, hasClaudeCodeGraphIntegration, hasCodexCodeGraphIntegration, hasClaudeCcgWorkflowMode, hasCodexCcgWorkflowMode, readCodexCcgWorkflowVersion} from './tools-integrations.js';


// tools-manage core：tools 域的门面/编排层（design TDR-11）。
// 与 tools-install.ts（registry + 安装原语）同属一个逻辑模块「tools 域」，仅按体量分文件。
// registry 单一真理源在 tools-install.TOOL_DEFINITIONS（已收编 ClaudeCode，与其余 agent 平权），
// 本层直接复用，不再单独硬编码 ClaudeCode。
// 检测不聚合 Skills/MCP（11.7）—— Skills/MCP 更新各归各家视图。
// 安装路径复用 tools-install.installTool（11.8），更新路径复用 update.applyUpdates（11.9）。

// ComponentId / ComponentDefinition = registry 类型别名（下游 20+ 处引用零改动）。
export type ComponentId = ToolId;

export type ComponentKind = ToolDefinition['kind'];

/** 受管组件静态定义（= registry ToolDefinition）。 */
export type ComponentDefinition = ToolDefinition;

/** 受管组件运行时状态（检测填充静态定义 + 版本/更新字段）。 */
export type ManagedComponent = ComponentDefinition & {
	readonly installed: boolean;
	readonly currentVersion: string;
	readonly latestVersion: string;
	readonly hasUpdate: boolean | null;
	readonly statusHint?: string;
};

/** 单组件安装结果（对齐 ToolInstallOutcome 结构）。 */
export type ComponentInstallOutcome = {
	readonly id: ComponentId;
	readonly success: boolean;
	readonly version?: string;
	readonly error?: string;
};

/** 安装依赖注入（供测试 mock exec；统一透传 installTool，含 ClaudeCode）。 */
export type InstallComponentDeps = {
	readonly exec?: typeof execCommand;
	// 当前 Agent 上下文（design D4/D5）：CodeGraph 接入目标与 CcgWorkflow Codex 引导按此分支，默认 Claude Code。
	readonly agentContext?: AgentContext;
};

const INSTALL_TIMEOUT_MS = 300000;

/**
 * 全部受管组件定义（7 项）：ClaudeCode + 6 工具，直接复用 registry（DRY，单一真理源）。
 * 顺序即 TOOL_DEFINITIONS 顺序（ClaudeCode 首位）；分组展示顺序由 sortComponentsByToolGroup 决定。
 */
export const COMPONENT_DEFINITIONS: readonly ComponentDefinition[] = TOOL_DEFINITIONS;

// ── 分组与可见性 / 共享投影（shared-resource-injection-ui）────────────────────
// group: agent = 主 Agent（Claude Code / Codex 两上下文常显）；
//        companion = 仅 Claude Code（Ccline）；tool = 两上下文通用（OpenSpec/CcgWorkflow/CodeGraph）。
// sharingKind: Tools 共享列表呈现分类（inject 双态 / 全局 CLI / Agent 独占）。
// Tools UI 主路径 = projectSharedToolComponents；filterVisibleComponents 仅兼容 legacy 门禁。

export type ToolGroup = 'agent' | 'companion' | 'tool';

/** 共享列表呈现分类（COMPONENT_META 单一事实源）。 */
export type ResourceSharingKind =
	| 'shared-cli-per-agent-inject'
	| 'fully-shared-no-inject'
	| 'agent-exclusive';

export type ToolGroupDisplayMeta = {
	readonly label: string;
	readonly description: string;
};

/** 组件分组 + 可见上下文 + 共享分类（key 顺序即组内展示顺序）。 */
export type ComponentMeta = {
	readonly group: ToolGroup;
	readonly contexts: readonly AgentContext[];
	readonly sharingKind: ResourceSharingKind;
};

const BOTH_CONTEXTS: readonly AgentContext[] = ['cc', 'cx'];

export const COMPONENT_META: Readonly<Record<ComponentId, ComponentMeta>> = {
	ClaudeCode: {group: 'agent', contexts: BOTH_CONTEXTS, sharingKind: 'agent-exclusive'},
	CodexCli: {group: 'agent', contexts: BOTH_CONTEXTS, sharingKind: 'agent-exclusive'},
	AntigravityCli: {group: 'agent', contexts: BOTH_CONTEXTS, sharingKind: 'fully-shared-no-inject'},
	Ccline: {group: 'companion', contexts: ['cc'], sharingKind: 'agent-exclusive'},
	OpenSpec: {group: 'tool', contexts: BOTH_CONTEXTS, sharingKind: 'fully-shared-no-inject'},
	CcgWorkflow: {group: 'tool', contexts: BOTH_CONTEXTS, sharingKind: 'shared-cli-per-agent-inject'},
	CodeGraph: {group: 'tool', contexts: BOTH_CONTEXTS, sharingKind: 'shared-cli-per-agent-inject'}
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

/** 单侧 inject 快照（仅 shared-cli-per-agent-inject）。 */
export type AgentInjectSnapshot = {
	readonly context: AgentContext;
	readonly integrated: boolean;
	readonly version?: string;
	readonly statusHint?: string;
};

/**
 * Tools 共享列表投影项：在 ManagedComponent 上叠加 sharingKind + 双侧 inject。
 * CcgWorkflow 不伪造全局 sharedInstalled（无真·共享 CLI）；CodeGraph sharedInstalled = CLI 可用。
 */
export type SharedManagedComponent = ManagedComponent & {
	readonly sharingKind: ResourceSharingKind;
	readonly applicableContexts: readonly AgentContext[];
	readonly sharedInstalled: boolean;
	readonly sharedVersion: string;
	readonly injectByAgent?: Readonly<Record<AgentContext, AgentInjectSnapshot>>;
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

/**
 * @deprecated Tools UI 主路径请用 projectSharedToolComponents。
 * 保留供 verify-tools-context / verify-tools-manage 等 legacy 门禁与 CLI 兼容路径。
 * 按 agentContext 过滤可见运行时组件，并对齐分组展示顺序。
 */
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
 * Tools 共享列表投影：不按 Header agentContext 过滤；始终返回 COMPONENT_DEFINITIONS 全集顺序。
 * inject 类附 injectByAgent 双侧快照；对侧状态互不塌缩。
 */
export function projectSharedToolComponents(
	detected: readonly ManagedComponent[]
): readonly SharedManagedComponent[] {
	const byId = new Map(detected.map(component => [component.id, component]));
	const projected = COMPONENT_DEFINITIONS.map(def => {
		const base = byId.get(def.id) ?? {
			...def,
			installed: false,
			currentVersion: '',
			latestVersion: '',
			hasUpdate: null as boolean | null
		};
		return projectOneSharedComponent(base);
	});
	return sortComponentsByToolGroup(projected);
}

function projectOneSharedComponent(component: ManagedComponent): SharedManagedComponent {
	const meta = COMPONENT_META[component.id];
	const sharingKind = meta.sharingKind;
	const applicableContexts = meta.contexts;

	if (sharingKind === 'shared-cli-per-agent-inject') {
		if (component.id === 'CodeGraph') {
			const injectByAgent = {
				cc: {
					context: 'cc' as const,
					integrated: hasClaudeCodeGraphIntegration()
				},
				cx: {
					context: 'cx' as const,
					integrated: hasCodexCodeGraphIntegration()
				}
			};
			return {
				...component,
				sharingKind,
				applicableContexts,
				// CodeGraph shared body = CLI 可用（detect 的 installed 来自 codegraph --version）
				sharedInstalled: component.installed,
				sharedVersion: component.currentVersion,
				injectByAgent
			};
		}

		// CcgWorkflow：不伪造全局 sharedInstalled；双侧 Mode 即 inject 快照
		const ccIntegrated = hasClaudeCcgWorkflowMode();
		const cxVersion = readCodexCcgWorkflowVersion();
		const cxIntegrated = hasCodexCcgWorkflowMode();
		const injectByAgent = {
			cc: {
				context: 'cc' as const,
				integrated: ccIntegrated,
				version: ccIntegrated ? component.currentVersion || undefined : undefined
			},
			cx: {
				context: 'cx' as const,
				integrated: cxIntegrated,
				version: cxIntegrated ? (cxVersion || undefined) : undefined
			}
		};
		return {
			...component,
			sharingKind,
			applicableContexts,
			sharedInstalled: false,
			sharedVersion: '',
			injectByAgent
		};
	}

	return {
		...component,
		sharingKind,
		applicableContexts,
		sharedInstalled: component.installed,
		sharedVersion: component.currentVersion
	};
}

/** 是否为可双侧 inject 的共享组件。 */
export function isInjectableComponent(id: ComponentId): boolean {
	return COMPONENT_META[id].sharingKind === 'shared-cli-per-agent-inject';
}

/**
 * Tools 组在两个 Header 下都可见，但 CcgWorkflow / CodeGraph 的“已安装”语义是 per-Agent 集成。
 * Codex 下必须看 ~/.codex 的真实落盘信号，不能把 Claude Code 或全局 CLI 状态直接复用过来。
 * 仅供 filterVisibleComponents（legacy）使用。
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
 * 卸载影响说明：
 * - inject 类 + fullUninstall：CLI + 全部注入
 * - inject 类 + 单侧 target：仅解除该 Agent 注入（Enter eject 路径）
 * - 其它：全局卸载语义
 */
// 卸载影响提示：inject 类恒全量卸载（fullUninstall=true），走 isInjectableComponent 分支；
// 非 inject 组件走下方 switch（按 id 定制，无 per-Agent 语义，不需要 agentContext）。
export function uninstallImpactNotice(
	id: ComponentId,
	options: {readonly fullUninstall?: boolean} = {}
): string {
	if (options.fullUninstall && isInjectableComponent(id)) {
		switch (id) {
			case 'CodeGraph':
				return '将从 Claude Code 与 Codex 卸载 CodeGraph，并卸载共享 codegraph CLI。';
			case 'CcgWorkflow':
				return '将卸载已安装的 Claude Code / Codex Mode。';
			default:
				return '将卸载该组件及其在全部 Agent 的安装。';
		}
	}

	switch (id) {
		case 'ClaudeCode':
			return '将卸载 Claude Code，相关配置和数据不会删除。';
		case 'CodexCli':
			return '将卸载 Codex CLI，相关配置和数据不会删除。';
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

/**
 * 检测全部受管组件（7 项），不聚合 Skills/MCP（11.7）。
 * 复用 update.checkCliToolUpdates（返回正好 7 个 CLI 组件：ClaudeCode/Ccline/CcgWorkflow/CodexCli/OpenSpec/CodeGraph + AntigravityCli），
 * join COMPONENT_DEFINITIONS 静态字段（description/kind/command 等）。
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
 * 安装单个组件：统一委派 registry 的 installTool（ClaudeCode 与其余 agent 平权，无特判）。
 * agentContext 决定 CodeGraph 接入目标（claude|codex）与 CcgWorkflow Codex 引导分支；
 * deps.exec 下沉为 installTool 通用注入缝（供测试 mock，含 ClaudeCode npm install + 检测确认）。
 */
export async function installComponent(
	id: ComponentId,
	onProgress?: ProgressCallback,
	deps: InstallComponentDeps = {}
): Promise<ComponentInstallOutcome> {
	if (!COMPONENT_DEFINITIONS.some(item => item.id === id)) {
		return {id, success: false, error: '未知组件'};
	}

	return installTool(id, onProgress, deps.agentContext ?? 'cc', {exec: deps.exec});
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
	// 单侧 eject 目标（Enter 路径）：CodeGraph/CcgWorkflow 默认只解除该 Agent 集成。
	readonly agentContext?: AgentContext;
	// d 全量卸载：inject 类解除两侧注入 + 共享 CLI/包；与 agentContext 互斥优先 fullUninstall。
	readonly fullUninstall?: boolean;
};

/**
 * 卸载单个组件（统一入口）。
 * 11.15 snapshot-before-write：任何破坏性写前先 createSnapshot，快照失败立即中止（exec 零调用，P-13）。
 * inject 类：
 *   - fullUninstall=true → 两侧 eject + 卸共享体（d 路径）
 *   - 否则 → 仅解除 deps.agentContext 一侧（Enter eject）
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
		if (deps.fullUninstall && isInjectableComponent(id)) {
			await fullUninstallInjectable(id, exec, onProgress);
		} else {
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
		}

		onProgress?.({level: 'success', message: `${definition.name} 已卸载`, componentId: id});
		return {id, success: true};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onProgress?.({level: 'danger', message: `${definition.name} 卸载失败: ${message}`, componentId: id});
		return {id, success: false, error: message};
	}
}

/** inject 类全量卸载：两侧注入 + 共享体。 */
async function fullUninstallInjectable(
	id: ComponentId,
	exec: typeof execCommand,
	onProgress?: ProgressCallback
): Promise<void> {
	if (id === 'CodeGraph') {
		// 全量：尽量解除两侧注入（已注入才跑；探测失败时仍继续卸 CLI）
		if (hasCodeGraphIntegration('cc')) {
			await runLifecycleCommands(codeGraphUninstallCommands('cc'), exec, 'CodeGraph', onProgress);
		}
		if (hasCodeGraphIntegration('cx')) {
			await runLifecycleCommands(codeGraphUninstallCommands('cx'), exec, 'CodeGraph', onProgress);
		}
		await runLifecycleCommands(codeGraphRemoveCliCommands(), exec, 'CodeGraph', onProgress);
		return;
	}

	if (id === 'CcgWorkflow') {
		if (hasClaudeCcgWorkflowMode()) {
			await runLifecycleCommands(ccgWorkflowUninstallCommands('cc'), exec, 'CcgWorkflow', onProgress);
		}
		if (hasCodexCcgWorkflowMode()) {
			await runLifecycleCommands(ccgWorkflowUninstallCommands('cx'), exec, 'CcgWorkflow', onProgress);
		}
	}
}

/** 单侧 inject：显式 target，禁止依赖 Header。 */
export async function injectComponent(
	id: ComponentId,
	target: AgentContext,
	onProgress?: ProgressCallback,
	deps: InstallComponentDeps = {}
): Promise<ComponentInstallOutcome> {
	if (!isInjectableComponent(id)) {
		return {id, success: false, error: `${id} 不支持 per-agent 安装`};
	}

	return installComponent(id, onProgress, {...deps, agentContext: target});
}

/** 单侧 eject：显式 target。 */
export async function ejectComponent(
	id: ComponentId,
	target: AgentContext,
	onProgress?: ProgressCallback,
	deps: UninstallComponentDeps = {}
): Promise<ComponentUninstallOutcome> {
	if (!isInjectableComponent(id)) {
		return {id, success: false, error: `${id} 不支持 per-agent 卸载`};
	}

	return uninstallComponent(id, onProgress, {...deps, agentContext: target, fullUninstall: false});
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
