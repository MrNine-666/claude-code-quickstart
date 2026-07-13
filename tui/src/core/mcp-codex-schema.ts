// Codex MCP schema 转换：把 Claude Code 风格 config（含 type:'http' / headers）降级为 Codex
// config.toml `[mcp_servers.<id>]` 形态。
//
// 透传式（黑名单）：「JSON 即真源」范式下，用户填的任意 Codex 合法字段（cwd / env_vars /
// startup_timeout_sec / enabled_tools / oauth 等）都应落盘，故不再用白名单裁剪，只做两处必要降级：
//   - 去 `type`：Claude Code 用 type:'http' 标记 streamable HTTP；Codex 靠 url 判定 HTTP、靠 command
//     判定 stdio，不识别 type，保留会污染 TOML。
//   - `headers`（Claude 方言）→ `http_headers`（Codex 原生字段）：统一 c JSON 方言后 http 凭据存于
//     headers，落 Codex 须转名；config 已显式带 http_headers 时以其为准，不被 headers 覆盖。
// 其余字段（含未来 Codex 新增字段）原样透传，未知字段由 Codex 自身忽略。

/** 转换时丢弃的 Claude 专有字段（Codex 不识别）。 */
const CLAUDE_ONLY_FIELDS = new Set<string>(['type']);

/**
 * 将 Claude 方言 MCP config 降级为 Codex `[mcp_servers.<id>]` 形态（透传式）。
 * - 丢弃 `type`（Codex 靠 url/command 判定）。
 * - `headers` → `http_headers`（config 已显式带 http_headers 时不覆盖）。
 * - 其余键原样透传；跳过值为 undefined 的键。
 * - 不修改入参；返回新对象。
 */
export function toCodexMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		if (value === undefined || CLAUDE_ONLY_FIELDS.has(key)) {
			continue;
		}

		if (key === 'headers') {
			if (!('http_headers' in config)) {
				next.http_headers = value;
			}

			continue;
		}

		next[key] = value;
	}

	return next;
}
