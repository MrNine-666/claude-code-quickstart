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
import {definitionHash} from '../core/mcp-vault.js';
import {type McpConfigEntry} from '../core/mcp-config-builder.js';
import {parseMcpFormInput} from '../core/mcp-form.js';
import {loadMcpContract, type McpServerDefinition} from '../core/mcp-contract.js';

// MCP service：TUI 视图唯一入口。enable/disable/remove 后统一落盘（HC-MCP-RULES-OFF：不再同步 rules 文件）。
// 保存链：表单 JSON → parseMcpFormInput 校验 → persistMcpServer 落盘（JSON 即真源，统一内置/自定义路径）。

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

// ── 保存（JSON 即真源，统一落盘） ──────────────────────────────────────────────

/** 从表单 JSON 解析配置并落盘。credentials 取自 config.env（vault 备份用）。 */
export function saveMcpServer(serverId: string, json: string): McpServiceResult {
	const parsed = parseMcpFormInput(serverId, json);
	if (!parsed.ok) {
		return {ok: false, error: parsed.error};
	}

	const {serverId: id, config} = parsed.payload;
	const credentials = extractEnvCredentials(config);
	const definitionHashValue = getBuiltinDefinitionHash(id);

	try {
		return settle(persistMcpServer(id, config, credentials, definitionHashValue));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

function extractEnvCredentials(config: McpConfigEntry): Record<string, string> {
	return config.env ?? {};
}

/** 编辑内置 MCP 时保留 definitionHash 以维持 drift 检测；自定义 MCP 返回空串。 */
function getBuiltinDefinitionHash(serverId: string): string {
	const def = loadMcpContract().servers[serverId];
	return def ? definitionHash(def) : '';
}
