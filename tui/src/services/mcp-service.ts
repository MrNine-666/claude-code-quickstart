import type {AgentContext} from '../state/manage-state.js';
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
import {parseMcpFormInput, parseMcpFormInputToml} from '../core/mcp-form.js';
import {loadMcpContract, type McpServerDefinition} from '../core/mcp-contract.js';

// MCP service：TUI 视图唯一入口。enable/disable/remove 后统一落盘（HC-MCP-RULES-OFF：不再同步 rules 文件）。
// 保存链：表单 JSON → parseMcpFormInput 校验 → persistMcpServer 落盘（JSON 即真源，统一内置/自定义路径）。

export type McpServiceResult = {readonly ok: true; readonly status: string} | {readonly ok: false; readonly error: string};

export function loadMcpStatus(agentContext: AgentContext = 'cc'): McpStatusRow[] {
	return computeStatus(agentContext);
}

export function loadMcpDetail(serverId: string, agentContext: AgentContext = 'cc'): McpServerDetail {
	return getServerDetail(serverId, agentContext);
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

export function enableMcpServer(serverId: string, agentContext: AgentContext = 'cc'): McpServiceResult {
	try {
		return settle(enableServer(serverId, agentContext));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function disableMcpServer(serverId: string, agentContext: AgentContext = 'cc'): McpServiceResult {
	try {
		return settle(disableServer(serverId, agentContext));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

export function removeMcpServer(serverId: string, confirmed: boolean, agentContext: AgentContext = 'cc'): McpServiceResult {
	try {
		const result = removeServer(serverId, confirmed, agentContext);
		if (!result.Success && result.Status === 'NeedConfirmation') {
			return {ok: false, error: '需要确认删除'};
		}

		return settle(result);
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

// ── 保存（JSON 即真源，统一落盘） ──────────────────────────────────────────────

/**
 * 从表单文本解析配置并落盘。cc 用 JSON 解析器，cx 用 TOML 解析器（Codex 心智）。
 * credentials 取自 config.env / headers / http_headers（vault 备份用）。
 */
export function saveMcpServer(serverId: string, text: string, agentContext: AgentContext = 'cc'): McpServiceResult {
	const parsed = agentContext === 'cx' ? parseMcpFormInputToml(serverId, text) : parseMcpFormInput(serverId, text);
	if (!parsed.ok) {
		return {ok: false, error: parsed.error};
	}

	const {serverId: id, config} = parsed.payload;
	const credentials = extractEnvCredentials(config);
	const definitionHashValue = getBuiltinDefinitionHash(id);

	try {
		return settle(persistMcpServer(id, config, credentials, definitionHashValue, agentContext));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/** 收集需备份到 vault 的凭据：env（stdio）+ headers（cc http）+ http_headers（cx http）。 */
function extractEnvCredentials(config: McpConfigEntry): Record<string, string> {
	return {...config.env, ...config.headers, ...config.http_headers};
}

/** 编辑内置 MCP 时保留 definitionHash 以维持 drift 检测；自定义 MCP 返回空串。 */
function getBuiltinDefinitionHash(serverId: string): string {
	const def = loadMcpContract().servers[serverId];
	return def ? definitionHash(def) : '';
}
