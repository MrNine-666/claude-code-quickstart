/**
 * 内嵌契约 - 编译时静态导入
 *
 * Bun build --compile 会将 text loader 的文件内容以内联字符串形式打进可执行文件。
 * 不使用 file loader：file loader 返回的是文件路径，不能作为契约内容解析。
 */

// JSON 契约
import providersJson from "../../contracts/providers.json" with { type: "text" };
import mcpServersJson from "../../contracts/mcp-servers.json" with { type: "text" };
import claudeConfigJson from "../../contracts/claude-config.json" with { type: "text" };
import codexConfigToml from "../../contracts/codex-config.toml" with { type: "text" };

// Markdown 模板
import claudeMdBase from "../../contracts/templates/claude-md.base.md" with { type: "text" };
import claudeMdWindows from "../../contracts/templates/claude-md.platform-windows.md" with { type: "text" };

function fileAsset(value: unknown): string {
	return value as string;
}

/**
 * 内嵌契约映射表
 */
export const EMBEDDED_CONTRACTS = new Map<string, string>([
	["providers.json", fileAsset(providersJson)],
	["mcp-servers.json", fileAsset(mcpServersJson)],
	["claude-config.json", fileAsset(claudeConfigJson)],
	["codex-config.toml", fileAsset(codexConfigToml)],
	["templates/claude-md.base.md", fileAsset(claudeMdBase)],
	["templates/claude-md.platform-windows.md", fileAsset(claudeMdWindows)],
]);

/**
 * 检查是否有可用的内嵌契约
 */
export function hasEmbeddedContracts(): boolean {
	return EMBEDDED_CONTRACTS.size > 0;
}

/**
 * 获取内嵌契约内容
 */
export function getEmbeddedContract(fileName: string): string | undefined {
	return EMBEDDED_CONTRACTS.get(fileName);
}
