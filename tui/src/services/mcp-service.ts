import {AGENT_CONTEXT_ORDER, type AgentContext} from '../state/manage-state.js';
import {
	computeSharedStatus,
	computeStatus,
	disableServer,
	enableServer,
	getServerDetail,
	persistMcpServer,
	persistSharedDefinition,
	removeServer,
	removeSharedServer,
	syncCredentials,
	syncSharedDefinition,
	type McpActionResult,
	type McpServerDetail,
	type McpSharedRow,
	type McpStatusRow
} from '../core/mcp.js';
import {definitionHash} from '../core/mcp-vault.js';
import {type McpConfigEntry} from '../core/mcp-config-builder.js';
import {parseMcpFormInput} from '../core/mcp-form.js';
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
 * 从表单文本解析配置并落盘（统一 JSON 方言）。
 * credentials 取自 config.env / headers / http_headers（vault 备份用）。
 * agentContext 仅决定落盘侧（cc 写 .claude.json，cx 经 toCodexMcpConfig 降级写 config.toml）。
 */
export function saveMcpServer(serverId: string, text: string, agentContext: AgentContext = 'cc'): McpServiceResult {
	const parsed = parseMcpFormInput(serverId, text);
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

// ── 共享双侧投影 / 开关（shared-resource-injection-ui Section 9-11） ────────────

/** 双侧聚合列表：每次实时读 runtime 文件派生，禁止塌缩单上下文。 */
export function loadSharedMcpStatus(): readonly McpSharedRow[] {
	return computeSharedStatus();
}

/**
 * 批量开关（Section 9.1）：按目标与当前实时态差异，对两侧做开启/禁用；未变侧不写。
 * targets 为草稿态（true=开启 / false=禁用）；实时态从 computeSharedStatus 派生。
 */
export function applyMcpToggleTargets(serverId: string, targets: Readonly<Record<AgentContext, boolean>>): McpServiceResult {
	try {
		const row = computeSharedStatus().find(item => item.Id === serverId);
		if (!row) {
			return {ok: false, error: `${serverId}: NotFound`};
		}

		for (const ctx of AGENT_CONTEXT_ORDER) {
			const desired = targets[ctx];
			const current = row.injectByAgent[ctx].active;
			if (desired === current) {
				continue;
			}

			const result = desired ? enableServer(serverId, ctx) : disableServer(serverId, ctx);
			if (!result.Success) {
				return {ok: false, error: `${serverId} · ${ctx}: ${result.Status}`};
			}
		}

		return {ok: true, status: 'Applied'};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/**
 * add 保存（Section 11.2）：仅写 vault 共享定义，不开启任何侧。
 * 统一 JSON 方言解析（c 语义：type + headers），落盘只进 vault。
 */
export function addSharedMcpServer(serverId: string, text: string): McpServiceResult {
	return persistParsed(serverId, text, persistSharedDefinition);
}

/**
 * edit 保存（Section 9.3）：写 vault 共享定义 + 同步所有当前已开启侧；未开启侧不开启。
 */
export function saveEditedMcpServer(serverId: string, text: string): McpServiceResult {
	return persistParsed(serverId, text, syncSharedDefinition);
}

/** 解析表单文本（统一 JSON）→ 调用给定落盘函数（persistSharedDefinition / syncSharedDefinition）。 */
function persistParsed(
	serverId: string,
	text: string,
	persist: (id: string, config: Record<string, unknown>, credentials: Record<string, string>, hash: string) => McpActionResult
): McpServiceResult {
	const parsed = parseMcpFormInput(serverId, text);
	if (!parsed.ok) {
		return {ok: false, error: parsed.error};
	}

	const {serverId: id, config} = parsed.payload;
	const credentials = extractEnvCredentials(config);
	const definitionHashValue = getBuiltinDefinitionHash(id);

	try {
		return settle(persist(id, config as Record<string, unknown>, credentials, definitionHashValue));
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/** 全量删除（Section 11.3 / d 键）：两侧 runtime + vault 定义 + settings permission。 */
export function removeSharedMcpServer(serverId: string, confirmed: boolean): McpServiceResult {
	try {
		const result = removeSharedServer(serverId, confirmed);
		if (!result.Success && result.Status === 'NeedConfirmation') {
			return {ok: false, error: '需要确认删除'};
		}

		return settle(result);
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
