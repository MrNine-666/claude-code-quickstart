// Codex MCP schema 转换：把 Claude Code 风格 config（含 type:'http'）转换为 Codex config.toml
// `[mcp_servers.<id>]` 支持的字段集。
//
// 关键差异（对齐官方 Codex 文档与 Claude Code .claude.json）：
//   - Claude Code 用 type:'http' 标记 streamable HTTP；Codex 靠 url 字段判定 HTTP，不写 type。
//   - Codex stdio 用 command/args/env，同样不写 type。
//   - Codex 仅识别下列字段，其它字段（如 type、Claude 专有元数据）一律丢弃，避免污染 TOML。

/** Codex `[mcp_servers.<id>]` 支持的字段白名单（stdio + streamable HTTP 通用）。 */
const CODEX_SUPPORTED_FIELDS = [
	// stdio
	'command',
	'args',
	'env',
	// streamable HTTP
	'url',
	'bearer_token_env_var',
	'http_headers',
	'env_http_headers',
	// 通用运行时控制
	'startup_timeout_sec',
	'tool_timeout_sec',
	'enabled',
	'required'
] as const;

const CODEX_SUPPORTED_FIELD_SET = new Set<string>(CODEX_SUPPORTED_FIELDS);

/**
 * 将任意 MCP config 转换为 Codex `[mcp_servers.<id>]` 支持的字段集。
 * - 丢弃 `type`（Codex 靠 url 判定 HTTP，靠 command 判定 stdio）。
 * - 仅保留白名单字段，未知字段一律丢弃。
 * - 不修改入参；返回新对象。
 */
export function toCodexMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (value === undefined) {
			continue;
		}

		if (CODEX_SUPPORTED_FIELD_SET.has(key)) {
			next[key] = value;
		}
	}

	return next;
}
