/**
 * 内嵌契约 - 编译时静态导入
 *
 * Bun build --compile 会将这些 import 的文件内容内嵌进可执行文件
 * 使用 `with { type: "file" }` 确保文件以原始形式内嵌
 */

// JSON 契约
import providersJson from "../../contracts/providers.json" with { type: "file" };
import mcpServersJson from "../../contracts/mcp-servers.json" with { type: "file" };
import claudeConfigJson from "../../contracts/claude-config.json" with { type: "file" };
import ccgWorkflowJson from "../../contracts/ccg-workflow.json" with { type: "file" };
import templatesIndexJson from "../../contracts/templates/index.json" with { type: "file" };

// Markdown 模板
import claudeMdBase from "../../contracts/templates/claude-md.base.md" with { type: "file" };
import claudeMdWindows from "../../contracts/templates/claude-md.platform-windows.md" with { type: "file" };
import claudeMdMacos from "../../contracts/templates/claude-md.platform-macos.md" with { type: "file" };

// JavaScript 契约
import claudeConfigDrift from "../../contracts/claude-config-drift.js" with { type: "file" };

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
	["ccg-workflow.json", fileAsset(ccgWorkflowJson)],
	["templates/index.json", fileAsset(templatesIndexJson)],
	["templates/claude-md.base.md", fileAsset(claudeMdBase)],
	["templates/claude-md.platform-windows.md", fileAsset(claudeMdWindows)],
	["templates/claude-md.platform-macos.md", fileAsset(claudeMdMacos)],
	["claude-config-drift.js", fileAsset(claudeConfigDrift)],
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
