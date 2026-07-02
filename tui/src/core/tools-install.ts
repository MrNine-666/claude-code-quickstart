import {readFileSync, existsSync} from 'node:fs';
import {execCommand, type ProgressCallback} from './exec.js';
import {atomicWrite} from './fs-utils.js';
import {claudeDir, claudeJsonPath, settingsPath} from './paths.js';

// 工具安装 core：检测 + 安装 6 个进阶工具（Ccline / CcgWorkflow / OpenSpec / CodeGraph / CodexCli / AntigravityCli）。
// 全部经 core/exec.ts 的 execCommand spawn 外部命令（HC-TUI-NODE-ONLY），不调 PS/zsh 步骤函数。
// 安装命令矩阵对齐 installer 步骤（design TDR-5）：
//   Ccline       npm install -g @cometix/ccline + settings.json statusLine（仅补缺失）
//   CcgWorkflow  npx ccg-workflow@latest init --skip-prompt --skip-mcp + mcpServers 快照保护
//   OpenSpec/CodexCli  npm install -g
//   AntigravityCli     平台 shell 脚本（Win irm|iex / mac curl|bash）
// Update 检测已收缩（HC-FU-08）：CcgWorkflow 不再写指纹种子，仅以命令可用性判定安装状态。
// CcgWorkflow env 推荐项已迁移至 ClaudeConfig 推荐配置（contracts/claude-config.json），本模块不再写 env。

type JsonObject = Record<string, unknown>;

export type ToolId = 'Ccline' | 'CcgWorkflow' | 'OpenSpec' | 'CodeGraph' | 'CodexCli' | 'AntigravityCli';

export type ToolInstallKind = 'npm' | 'ccg-init' | 'shell-script';

/** 单个工具静态定义。 */
export type ToolDefinition = {
	readonly id: ToolId;
	readonly name: string;
	readonly description: string;
	readonly kind: ToolInstallKind;
	readonly command: string; // 检测用命令
	readonly versionArgs: readonly string[];
	readonly npmPackage?: string; // kind === 'npm'
	readonly optional: boolean;
};

/** 工具检测状态（供列表展示）。 */
export type ToolStatus = {
	readonly id: ToolId;
	readonly installed: boolean;
	readonly version: string;
};

/** 单个工具安装结果。 */
export type ToolInstallOutcome = {
	readonly id: ToolId;
	readonly success: boolean;
	readonly error?: string;
};

const INSTALL_TIMEOUT_MS = 300000;
const DETECT_TIMEOUT_MS = 5000;

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		id: 'Ccline',
		name: 'CCometixLine',
		description: 'Claude Code 状态栏增强（npm + patch + statusLine）',
		kind: 'npm',
		command: 'ccline',
		versionArgs: ['--version'],
		npmPackage: '@cometix/ccline',
		optional: false
	},
	{
		id: 'CcgWorkflow',
		name: 'CCG Workflow',
		description: 'Commands / Agents / Hooks 工作流（npx init 全套）',
		kind: 'ccg-init',
		command: 'codeagent-wrapper',
		versionArgs: ['--version'],
		optional: false
	},
	{
		id: 'OpenSpec',
		name: 'OpenSpec CLI',
		description: '规范驱动开发工具（npm 全局）',
		kind: 'npm',
		command: 'openspec',
		versionArgs: ['--version'],
		npmPackage: '@fission-ai/openspec',
		optional: false
	},
	{
		id: 'CodeGraph',
		name: 'CodeGraph',
		description: '本地代码知识图谱（调用链/影响范围检索，npm 全局）',
		kind: 'npm',
		command: 'codegraph',
		versionArgs: ['--version'],
		npmPackage: '@colbymchenry/codegraph',
		optional: false
	},
	{
		id: 'CodexCli',
		name: 'Codex CLI',
		description: 'OpenAI Codex CLI（可选，多模型协作）',
		kind: 'npm',
		command: 'codex',
		versionArgs: ['--version'],
		npmPackage: '@openai/codex',
		optional: true
	},
	{
		id: 'AntigravityCli',
		name: 'Antigravity CLI',
		description: 'Google Antigravity CLI（可选，平台 shell 脚本）',
		kind: 'shell-script',
		command: 'agy',
		versionArgs: ['--version'],
		optional: true
	}
];

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析版本号（取首个 x.y.z）。 */
function parseVersion(text: string): string {
	const match = text.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
	return match ? match[0] : text.trim();
}

/** 检测单个工具（命令可用性 + 版本）。 */
export async function detectTool(definition: ToolDefinition): Promise<ToolStatus> {
	try {
		const result = await execCommand(definition.command, definition.versionArgs, {timeout: DETECT_TIMEOUT_MS});
		if (result.code !== 0) {
			return {id: definition.id, installed: false, version: ''};
		}

		return {id: definition.id, installed: true, version: parseVersion(result.stdout || result.stderr || '')};
	} catch {
		return {id: definition.id, installed: false, version: ''};
	}
}

/** 并发检测全部工具状态。 */
export async function detectAllTools(): Promise<ToolStatus[]> {
	return Promise.all(TOOL_DEFINITIONS.map(detectTool));
}

/** 友好错误信息（对齐 skills-actions getFriendlyError）。 */
function friendlyError(text: string, fallback: string): string {
	if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(text)) {
		return '无法访问 npm 仓库，请检查网络连接或代理镜像';
	}

	if (/EACCES|EPERM|permission/i.test(text)) {
		return '文件权限不足，请检查目录权限或以管理员身份重试';
	}

	return fallback;
}

/** npm install -g <package>。 */
async function installNpmPackage(definition: ToolDefinition, onProgress?: ProgressCallback): Promise<void> {
	if (!definition.npmPackage) {
		throw new Error(`${definition.id} 缺少 npm 包名`);
	}

	onProgress?.({level: 'info', message: `npm install -g ${definition.npmPackage}`, componentId: definition.id});
	const result = await execCommand('npm', ['install', '-g', definition.npmPackage], {timeout: INSTALL_TIMEOUT_MS});
	if (result.code !== 0) {
		throw new Error(friendlyError(result.stderr || result.stdout, `npm install 失败 (exit ${result.code})`));
	}
}

/** CodeGraph 后置：非交互接入 Claude Code MCP（只配置 Claude，避免误改其它 agent）。 */
async function postInstallCodeGraph(onProgress?: ProgressCallback): Promise<void> {
	onProgress?.({level: 'info', message: 'codegraph install --target=claude --location=global --yes', componentId: 'CodeGraph'});
	const result = await execCommand('codegraph', ['install', '--target=claude', '--location=global', '--yes'], {timeout: INSTALL_TIMEOUT_MS});
	if (result.code !== 0) {
		throw new Error(friendlyError(result.stderr || result.stdout, `CodeGraph Claude Code 接入失败 (exit ${result.code})`));
	}
}

/** Ccline 后置：写 statusLine（仅补缺失，保护用户配置）。 */
async function postInstallCcline(onProgress?: ProgressCallback): Promise<void> {
	// settings.json statusLine（fill-missing：已有 statusLine 则不覆盖，保护用户配置）
	const path = settingsPath();
	let settings: JsonObject = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
			settings = isObject(parsed) ? parsed : {};
		} catch {
			onProgress?.({level: 'warning', message: 'settings.json 解析失败，跳过 statusLine 写入', componentId: 'Ccline'});
			settings = {__skip__: true};
		}
	}

	if (!settings['__skip__'] && !isObject(settings['statusLine'])) {
		settings['statusLine'] = {type: 'command', command: 'ccline', padding: 0};
		try {
			atomicWrite(path, JSON.stringify(settings, null, 2));
			onProgress?.({level: 'success', message: '已写入 statusLine 配置', componentId: 'Ccline'});
		} catch (error) {
			onProgress?.({level: 'warning', message: `statusLine 写入失败: ${error instanceof Error ? error.message : String(error)}`, componentId: 'Ccline'});
		}
	}
}

/** 读取 .claude.json mcpServers 快照（紧凑 JSON 字符串，便于比对）。 */
export function readMcpSnapshot(): string | null {
	const path = claudeJsonPath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		if (isObject(parsed) && isObject(parsed['mcpServers'])) {
			return JSON.stringify(parsed['mcpServers']);
		}
	} catch {
		return null;
	}

	return null;
}

/** CcgWorkflow 安装：npx init（--skip-mcp）+ mcpServers 快照保护。
 *  env 推荐项已迁移至 ClaudeConfig 推荐配置（contracts/claude-config.json），此处不再写 env。 */
async function installCcgWorkflow(onProgress?: ProgressCallback): Promise<void> {
	// mcpServers 快照（安装前）
	const mcpBefore = readMcpSnapshot();

	onProgress?.({level: 'info', message: 'npx ccg-workflow@latest init（远程下载，请稍候）', componentId: 'CcgWorkflow'});
	const result = await execCommand(
		'npx',
		['--yes', 'ccg-workflow@latest', 'init', '--skip-prompt', '--skip-mcp', '--lang', 'zh-CN', '--install-dir', claudeDir()],
		{timeout: INSTALL_TIMEOUT_MS}
	);
	if (result.code !== 0) {
		throw new Error(friendlyError(result.stderr || result.stdout, `CCG Workflow 初始化失败 (exit ${result.code})`));
	}

	// mcpServers 快照比对（安装后）：被覆盖则恢复
	const mcpAfter = readMcpSnapshot();
	if (mcpBefore !== null && mcpBefore !== mcpAfter) {
		restoreMcpSnapshot(mcpBefore, onProgress);
	}
}

/** 恢复被 init 覆盖的 mcpServers 快照（保护用户 MCP 配置）。 */
export function restoreMcpSnapshot(snapshot: string, onProgress?: ProgressCallback): void {
	const path = claudeJsonPath();
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		if (isObject(parsed)) {
			parsed['mcpServers'] = JSON.parse(snapshot);
			atomicWrite(path, JSON.stringify(parsed, null, 2));
			onProgress?.({level: 'warning', message: '检测到 mcpServers 被修改，已恢复安装前快照', componentId: 'CcgWorkflow'});
		}
	} catch {
		onProgress?.({level: 'warning', message: 'mcpServers 快照恢复失败，请手动检查 .claude.json', componentId: 'CcgWorkflow'});
	}
}

/** AntigravityCli 安装：平台 shell 脚本（Win irm|iex / mac curl|bash）。 */
async function installAntigravity(onProgress?: ProgressCallback): Promise<void> {
	onProgress?.({level: 'info', message: '执行 Antigravity 官方安装脚本（远程下载）', componentId: 'AntigravityCli'});

	if (process.platform === 'win32') {
		const result = await execCommand(
			'powershell',
			['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex'],
			{timeout: INSTALL_TIMEOUT_MS}
		);
		if (result.code !== 0) {
			throw new Error(friendlyError(result.stderr || result.stdout, `Antigravity 安装失败 (exit ${result.code})`));
		}

		return;
	}

	const result = await execCommand('bash', ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'], {timeout: INSTALL_TIMEOUT_MS});
	if (result.code !== 0) {
		throw new Error(friendlyError(result.stderr || result.stdout, `Antigravity 安装失败 (exit ${result.code})`));
	}
}

/** 安装单个工具（按 kind 分发 + 后置处理 + 检测确认）。 */
export async function installTool(id: ToolId, onProgress?: ProgressCallback): Promise<ToolInstallOutcome> {
	const definition = TOOL_DEFINITIONS.find(item => item.id === id);
	if (!definition) {
		return {id, success: false, error: '未知工具'};
	}

	try {
		switch (definition.kind) {
			case 'npm':
				await installNpmPackage(definition, onProgress);
				if (definition.id === 'Ccline') {
					await postInstallCcline(onProgress);
				}

				if (definition.id === 'CodeGraph') {
					await postInstallCodeGraph(onProgress);
				}

				break;
			case 'ccg-init':
				await installCcgWorkflow(onProgress);
				break;
			case 'shell-script':
				await installAntigravity(onProgress);
				break;
		}

		// CCG Workflow 和 shell-script 类型需要 PATH 更新，安装后立即检测会失败（环境变量未生效）
		// 信任安装命令的 exit code，成功后直接返回 success（下次刷新检测时自然会识别到）
		if (definition.kind === 'ccg-init' || definition.kind === 'shell-script') {
			onProgress?.({level: 'success', message: `${definition.name} 安装成功（重启终端后生效）`, componentId: id});
			return {id, success: true};
		}

		const status = await detectTool(definition);
		if (status.installed) {
			onProgress?.({level: 'success', message: `${definition.name} 安装成功${status.version ? ` (${status.version})` : ''}`, componentId: id});
			return {id, success: true};
		}

		onProgress?.({level: 'warning', message: `${definition.name} 安装完成但命令暂不可用（可能需重启终端）`, componentId: id});
		return {id, success: false, error: '安装后命令不可用'};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onProgress?.({level: 'danger', message: `${definition.name} 安装失败: ${message}`, componentId: id});
		return {id, success: false, error: message};
	}
}

/** 批量安装（串行 + 失败隔离 P-6）：单个失败不阻止后续。
 * installOne 缝仅供测试注入（验证失败隔离），生产默认走 installTool。 */
export async function installMultipleTools(
	ids: readonly ToolId[],
	onProgress?: ProgressCallback,
	installOne: (id: ToolId, onProgress?: ProgressCallback) => Promise<ToolInstallOutcome> = installTool
): Promise<ToolInstallOutcome[]> {
	const outcomes: ToolInstallOutcome[] = [];
	for (const id of ids) {
		// eslint-disable-next-line no-await-in-loop -- 串行避免 npm 全局锁冲突
		outcomes.push(await installOne(id, onProgress));
	}

	return outcomes;
}
