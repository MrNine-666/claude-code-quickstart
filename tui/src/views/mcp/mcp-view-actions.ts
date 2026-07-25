import type {McpSharedRow} from '../../core/mcp.js';
import {configToJson, getMcpTemplateJson, listBuiltinMcpOptions, parseMcpJsonFormat} from '../../core/mcp-form.js';
import type {AgentContext} from '../../state/manage-state.js';
import {
	addSharedMcpServer,
	applyMcpToggleTargets,
	getDefinition,
	loadMcpDetail,
	loadSharedMcpStatus,
	removeSharedMcpServer,
	saveEditedMcpServer
} from '../../services/mcp-service.js';

export type McpViewRow = McpSharedRow;
export type McpToggleDraft = Readonly<Record<AgentContext, boolean>>;

export const MCP_GRID_COLUMNS = 2;
export type McpGridDirection = 'up' | 'down' | 'left' | 'right';

/** 两列 MCP 网格导航；上下保持列位置，并在首尾行循环。 */
export function moveMcpGridCursor(index: number, length: number, direction: McpGridDirection, columns = MCP_GRID_COLUMNS): number {
	if (length <= 0) {
		return 0;
	}

	const columnCount = Math.max(1, columns);
	const cursor = Math.min(Math.max(index, 0), length - 1);
	if (direction === 'left') {
		return Math.max(0, cursor - 1);
	}

	if (direction === 'right') {
		return Math.min(length - 1, cursor + 1);
	}

	const column = cursor % columnCount;
	const lastRowStart = Math.floor((length - 1) / columnCount) * columnCount;
	if (direction === 'up') {
		const previousRow = cursor - columnCount;
		return previousRow >= 0 ? previousRow : Math.min(lastRowStart + column, length - 1);
	}

	const nextRow = cursor + columnCount;
	if (nextRow < length) {
		return nextRow;
	}

	return cursor < lastRowStart ? length - 1 : Math.min(column, length - 1);
}

export type McpFormTemplate = {
	readonly value: string;
	readonly label: string;
	readonly json: string;
	readonly credHint?: string;
};

export type McpFormModel = {
	readonly mode: 'add' | 'edit';
	readonly serverId: string;
	readonly initialJson: string;
	readonly credHint?: string;
	readonly templates: readonly McpFormTemplate[];
};

export type McpFormSubmitInput = {
	readonly mode: 'add' | 'edit';
	readonly serverId: string;
	readonly jsonText: string;
};

export type McpViewActionResult = {readonly ok: true; readonly message: string} | {readonly ok: false; readonly error: string};

export function loadMcpRowsAction(): readonly McpViewRow[] {
	return loadSharedMcpStatus();
}

export function createMcpAddFormModel(): McpFormModel {
	return {
		mode: 'add',
		serverId: '',
		initialJson: configToJson(null),
		templates: listBuiltinMcpOptions().map(option => {
			const template = getMcpTemplateJson(option.value);
			return {
				value: option.value,
				label: option.label,
				json: template?.json ?? configToJson(null),
				...(template?.credHint ? {credHint: template.credHint} : {})
			};
		})
	};
}

export function createMcpEditFormModel(serverId: string): McpFormModel {
	const detail = loadMcpDetail(serverId);
	const definition = getDefinition(serverId);
	return {
		mode: 'edit',
		serverId,
		initialJson: configToJson(detail.config),
		...(definition?.CredentialType === 'env-file' ? {credHint: '该 MCP 原由安装链用 env-file 管理，此处修改直接写入 config.env'} : {}),
		templates: []
	};
}

export function validateMcpJsonAction(text: string): string | undefined {
	const result = parseMcpJsonFormat(text);
	return result.ok ? undefined : result.error;
}

export function submitMcpFormAction(input: McpFormSubmitInput): McpViewActionResult {
	const result =
		input.mode === 'add' ? addSharedMcpServer(input.serverId, input.jsonText) : saveEditedMcpServer(input.serverId, input.jsonText);
	return result.ok ? {ok: true, message: `已保存 MCP Server ${input.serverId}`} : {ok: false, error: result.error};
}

export function applyMcpToggleAction(serverId: string, targets: McpToggleDraft): McpViewActionResult {
	const result = applyMcpToggleTargets(serverId, targets);
	return result.ok ? {ok: true, message: `已更新 ${serverId} 开关`} : {ok: false, error: result.error};
}

export function removeMcpServerAction(serverId: string): McpViewActionResult {
	const result = removeSharedMcpServer(serverId, true);
	return result.ok ? {ok: true, message: `已删除 MCP Server ${serverId}`} : {ok: false, error: result.error};
}
