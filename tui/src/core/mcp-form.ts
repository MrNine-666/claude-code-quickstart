import type {FormField, KeyValueEntry} from '../components/form/field-types.js';
import type {McpServerDefinition} from './mcp-contract.js';

// buildMcpFormFields：从契约/现有配置派生 MCP 表单字段（design D10）。
// 覆盖 none / single-key / url-embedded / multi-field / args-multi / args-token /
// custom stdio / custom http。env-file 返回只读字段 + 安装链提示。

export type McpFormMode = 'edit-builtin' | 'add-custom-stdio' | 'add-custom-http' | 'edit-custom';

export type McpFormModel = {
	readonly mode: McpFormMode;
	readonly serverId: string;
	readonly fields: readonly FormField[];
	readonly editable: boolean;
	readonly note?: string;
};

type ExistingConfig = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
} | null;

function readonlyIdField(serverId: string): FormField {
	return {id: '__serverId', type: 'readonly', label: 'Server ID', value: serverId};
}

function credentialValueFromConfig(existing: ExistingConfig, envKey: string): string {
	return existing?.env?.[envKey] ?? '';
}

/** 从已有 args 中解析 `ArgName value` 形式的凭据值。 */
function argValueFromConfig(existing: ExistingConfig, argName: string): string {
	const args = existing?.args ?? [];
	const index = args.indexOf(argName);
	if (index >= 0 && index + 1 < args.length) {
		return args[index + 1]!;
	}

	return '';
}

/** 从已有 args 中解析 `TokenArg=value` 形式的 token 值。 */
function tokenValueFromConfig(existing: ExistingConfig, tokenArg: string): string {
	const prefix = `${tokenArg}=`;
	for (const arg of existing?.args ?? []) {
		if (typeof arg === 'string' && arg.startsWith(prefix)) {
			return arg.slice(prefix.length);
		}
	}

	return '';
}

/** 构建内置 MCP Server 的编辑表单（Server ID 只读，字段由契约投影）。 */
export function buildMcpFormFields(
	serverId: string,
	definition: McpServerDefinition,
	existingConfig: ExistingConfig,
	mode: McpFormMode
): McpFormModel {
	if (mode === 'add-custom-stdio') {
		return buildCustomStdioFields(serverId, existingConfig);
	}

	if (mode === 'add-custom-http') {
		return buildCustomHttpFields(serverId, existingConfig);
	}

	const credentialType = definition.CredentialType || 'none';

	if (credentialType === 'env-file') {
		return {
			mode,
			serverId,
			editable: false,
			note: '该 MCP 使用 env-file 凭据，由安装链管理，本面板仅展示，不支持编辑保存。',
			fields: [
				readonlyIdField(serverId),
				{id: '__name', type: 'readonly', label: '名称', value: definition.Name ?? serverId},
				{id: '__type', type: 'readonly', label: '类型', value: definition.McpType ?? 'stdio'}
			]
		};
	}

	const fields: FormField[] = [readonlyIdField(serverId)];

	switch (credentialType) {
		case 'single-key': {
			const apiKeyName = String(definition.ApiKeyName ?? '');
			fields.push({
				id: apiKeyName,
				type: 'secret',
				label: definition.ApiKeyName ?? 'API Key',
				value: credentialValueFromConfig(existingConfig, apiKeyName),
				helpText: definition.ApiKeyUrl ? `获取地址: ${definition.ApiKeyUrl}` : undefined
			});
			break;
		}

		case 'url-embedded': {
			for (const cred of definition.Credentials ?? []) {
				const name = String(cred.Name ?? '');
				fields.push({
					id: name,
					type: cred.Secret ? 'secret' : 'text',
					label: cred.Label ?? name,
					value: '',
					helpText: cred.Url ? `获取地址: ${cred.Url}` : undefined
				});
			}

			break;
		}

		case 'multi-field': {
			for (const cred of definition.Credentials ?? []) {
				const name = String(cred.Name ?? '');
				fields.push({
					id: name,
					type: cred.Secret ? 'secret' : 'text',
					label: cred.Label ?? name,
					value: credentialValueFromConfig(existingConfig, name),
					helpText: cred.Url ? `获取地址: ${cred.Url}` : undefined
				});
			}

			break;
		}

		case 'args-multi': {
			for (const cred of definition.ArgsCredentials ?? []) {
				const argName = String(cred.ArgName ?? '');
				fields.push({
					id: argName,
					type: cred.Secret ? 'secret' : 'text',
					label: cred.Label ?? argName,
					value: argValueFromConfig(existingConfig, argName),
					helpText: cred.Url ? `获取地址: ${cred.Url}` : undefined
				});
			}

			break;
		}

		case 'args-token': {
			fields.push({
				id: 'token',
				type: 'secret',
				label: definition.TokenLabel ?? 'Token',
				value: tokenValueFromConfig(existingConfig, String(definition.TokenArg ?? '')),
				helpText: definition.TokenUrl ? `获取地址: ${definition.TokenUrl}` : undefined
			});
			break;
		}

		default:
			// none：无凭据字段，仅展示只读 ID。
			break;
	}

	return {mode, serverId, fields, editable: true};
}

function buildCustomStdioFields(serverId: string, existing: ExistingConfig): McpFormModel {
	const envEntries: KeyValueEntry[] = Object.entries(existing?.env ?? {}).map(([key, value]) => ({key, value}));
	const idEditable = serverId === '';

	return {
		mode: 'add-custom-stdio',
		serverId,
		editable: true,
		fields: [
			idEditable
				? {id: '__serverId', type: 'text', label: 'Server ID', value: serverId, helpText: '保存后不可改名'}
				: readonlyIdField(serverId),
			{id: '__command', type: 'text', label: 'Command', value: existing?.command ?? 'npx'},
			{id: '__args', type: 'text', label: 'Args（空格分隔）', value: (existing?.args ?? []).join(' ')},
			{id: '__env', type: 'key-value', label: '环境变量', entries: envEntries}
		]
	};
}

function buildCustomHttpFields(serverId: string, existing: ExistingConfig): McpFormModel {
	const idEditable = serverId === '';

	return {
		mode: 'add-custom-http',
		serverId,
		editable: true,
		fields: [
			idEditable
				? {id: '__serverId', type: 'text', label: 'Server ID', value: serverId, helpText: '保存后不可改名'}
				: readonlyIdField(serverId),
			{id: '__url', type: 'text', label: 'URL', value: existing?.url ?? '', helpText: '必须以 http:// 或 https:// 开头'}
		]
	};
}
