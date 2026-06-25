import {
	computeStatus,
	disableServer,
	enableServer,
	getServerDetail,
	persistMcpServer,
	removeServer,
	syncCredentials,
	type McpActionResult,
	type McpServerDetail,
	type McpStatusRow
} from '../core/mcp.js';
import {
	buildCustomHttpConfig,
	buildCustomStdioConfig,
	buildMcpConfig,
	type BuildMcpConfigResult
} from '../core/mcp-config-builder.js';
import {buildMcpFormFields, type McpFormMode, type McpFormModel} from '../core/mcp-form.js';
import {loadMcpContract, type McpServerDefinition} from '../core/mcp-contract.js';
import type {KeyValueEntry} from '../components/form/field-types.js';

// MCP service：TUI 视图唯一入口。enable/disable/remove 后统一落盘（HC-MCP-RULES-OFF：不再同步 rules 文件）。

export type McpServiceResult = {readonly ok: true; readonly status: string} | {readonly ok: false; readonly error: string};

export function loadMcpStatus(): McpStatusRow[] {
	return computeStatus();
}

export function loadMcpDetail(serverId: string): McpServerDetail {
	return getServerDetail(serverId);
}

export function getDefinition(serverId: string): McpServerDefinition | null {
	return loadMcpContract().servers[serverId] ?? null;
}

export function syncMcpCredentials(): void {
	syncCredentials();
}

function settle(result: McpActionResult): McpServiceResult {
	if (!result.Success) {
		return {ok: false, error: `${result.ServerId}: ${result.Status}`};
	}

	return {ok: true, status: result.Status};
}

export function enableMcpServer(serverId: string): McpServiceResult {
	try {
		return settle(enableServer(serverId));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function disableMcpServer(serverId: string): McpServiceResult {
	try {
		return settle(disableServer(serverId));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function removeMcpServer(serverId: string, confirmed: boolean): McpServiceResult {
	try {
		const result = removeServer(serverId, confirmed);
		if (!result.Success && result.Status === 'NeedConfirmation') {
			return {ok: false, error: '需要确认删除'};
		}

		return settle(result);
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function buildMcpForm(
	serverId: string,
	definition: McpServerDefinition,
	existingConfig: Parameters<typeof buildMcpFormFields>[2],
	mode: McpFormMode
): McpFormModel {
	return buildMcpFormFields(serverId, definition, existingConfig, mode);
}

/** 校验并生成 MCP config。env-file / Server ID 改名等非法场景由 builder/此处拒绝。 */
export function buildMcpServerConfig(
	serverId: string,
	definition: McpServerDefinition,
	values: Record<string, string>,
	originalId?: string
): BuildMcpConfigResult {
	if (originalId !== undefined && originalId !== '' && originalId !== serverId) {
		return {ok: false, error: 'MCP Server ID 不可修改'};
	}

	return buildMcpConfig(serverId, definition, values);
}

// ── 保存（编辑内置 / 新增自定义） ──────────────────────────────────────────

export type SaveMcpInput = {
	readonly model: McpFormModel;
	// 表单字段值，key 对齐 buildMcpFormFields 产出的 field.id（含 __serverId/__command/...）。
	readonly values: Readonly<Record<string, string>>;
	// 自定义 stdio 的环境变量（key-value 字段，与 values 分开收集）。
	readonly envEntries?: readonly KeyValueEntry[];
};

/**
 * 保存 MCP 表单：按 mode 分流。
 * - edit-builtin / edit-custom：走契约 buildMcpConfig，Server ID 取 model.serverId（只读，天然不可改名）。
 * - add-custom-stdio / add-custom-http：走自定义 builder，Server ID 取表单值（新建可填）。
 * env-file / software / 缺失凭据等由 builder 拒绝。落盘统一走 persistMcpServer。
 */
export function saveMcpServer(input: SaveMcpInput): McpServiceResult {
	const {model, values} = input;

	if (!model.editable) {
		return {ok: false, error: '该 MCP 由安装链管理，不支持编辑保存'};
	}

	try {
		if (model.mode === 'add-custom-stdio') {
			const serverId = (values.__serverId ?? '').trim();
			const env: Record<string, string> = {};
			for (const entry of input.envEntries ?? []) {
				if (entry.key.trim() !== '') {
					env[entry.key.trim()] = entry.value;
				}
			}

			const built = buildCustomStdioConfig(serverId, values.__command ?? '', values.__args ?? '', env);
			if (!built.ok) {
				return {ok: false, error: built.error};
			}

			return settle(persistMcpServer(built.serverId, built.config, env, ''));
		}

		if (model.mode === 'add-custom-http') {
			const serverId = (values.__serverId ?? '').trim();
			const built = buildCustomHttpConfig(serverId, values.__url ?? '');
			if (!built.ok) {
				return {ok: false, error: built.error};
			}

			return settle(persistMcpServer(built.serverId, built.config, {}, ''));
		}

		// 编辑内置 / 已存在自定义：Server ID 只读，凭据由契约字段投影。
		const definition = getDefinition(model.serverId);
		if (!definition) {
			return {ok: false, error: `未找到 MCP 契约定义: ${model.serverId}`};
		}

		const built = buildMcpServerConfig(model.serverId, definition, values, model.serverId);
		if (!built.ok) {
			return {ok: false, error: built.error};
		}

		return settle(persistMcpServer(model.serverId, built.config, built.credentials, built.definitionHash));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
