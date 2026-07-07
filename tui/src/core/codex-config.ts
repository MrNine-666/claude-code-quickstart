import {existsSync, readFileSync} from 'node:fs';
import {codexConfigPath} from './paths.js';
import {atomicWrite, getPath, parse, redactTomlSecrets, setPath, stringify, type TomlDocument} from './toml-edit.js';
import {loadTextContract} from './contracts.js';

// Codex 推荐配置 + fill-missing（design D10 / HC-CONFIG-RULES-REUSE）。
// 与 Claude ConfigView UI 复用：预览页 / e 编辑 / Ctrl+T 推荐 / Ctrl+O fill-missing 导入。
// 仅管理 Codex 自身运行配置（model / approval_policy / sandbox_mode 等），不触碰
// provider/MCP/hooks/Skills/AGENTS.md（分别归 Provider/MCP/Skills/Global Rules 管）。

const RECOMMENDED_TOP_LEVEL_KEYS = ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode'] as const;
const CODEX_FOREIGN_SECTIONS = ['model_providers', 'mcp_servers', 'hooks'] as const;
const CODEX_OWNED_TOP_LEVEL_KEYS = new Set<string>(RECOMMENDED_TOP_LEVEL_KEYS);

/** 读取 Codex 推荐配置契约文本（TOML），缺失返回 null。 */
export function loadCodexConfigRecommendationText(): string | null {
	try {
		return loadTextContract('codex-config.toml');
	} catch {
		return null;
	}
}

/** 解析推荐 TOML 为 document；缺失或解析失败返回 null。 */
function loadRecommendedDocument(): TomlDocument | null {
	const text = loadCodexConfigRecommendationText();
	if (!text) {
		return null;
	}

	try {
		return parse(text);
	} catch {
		return null;
	}
}

/** 读取当前 `CODEX_HOME/config.toml` 原始文本（不存在返回 null）。 */
export function readCodexConfigText(): string | null {
	const path = codexConfigPath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/** 读取当前 `CODEX_HOME/config.toml` 为 document；不存在或解析失败返回 null。 */
export function readCodexConfigDocument(): TomlDocument | null {
	const text = readCodexConfigText();
	if (!text) {
		return null;
	}

	try {
		return parse(text);
	} catch {
		return null;
	}
}

/** 对编辑缓冲 TOML 文本执行 fill-missing 合并（仅补 ccq 管辖的顶层缺失键，保留用户其它字段）。 */
export function applyCodexFillMissingToText(tomlText: string):
	| {readonly ok: true; readonly text: string; readonly changed: number}
	| {readonly ok: false; readonly error: string} {
	const recommended = loadRecommendedDocument();
	if (!recommended) {
		return {ok: false, error: 'Codex 推荐配置契约不可用（contracts/codex-config.toml 缺失）'};
	}

	let current: TomlDocument;
	try {
		const parsed = parse(tomlText);
		current = parsed;
	} catch (error) {
		return {ok: false, error: `当前编辑内容不是合法 TOML：${redactTomlSecrets(error instanceof Error ? error.message : String(error))}`};
	}

	let next = current;
	let changed = 0;
	for (const key of RECOMMENDED_TOP_LEVEL_KEYS) {
		const existing = getPath(next, [key]);
		if (existing === undefined || existing === null || (typeof existing === 'string' && existing.trim() === '')) {
			const value = getPath(recommended, [key]);
			if (value !== undefined && value !== null) {
				next = setPath(next, [key], value);
				changed++;
			}
		}
	}

	return {ok: true, text: stringify(next), changed};
}

/** 端到端 fill-missing 导入到 `CODEX_HOME/config.toml`：解析失败时拒绝覆盖。 */
export function importCodexFillMissing(): {ok: boolean; changed?: number; error?: string} {
	const recommended = loadRecommendedDocument();
	if (!recommended) {
		return {ok: false, error: 'Codex 推荐配置契约不可用（contracts/codex-config.toml 缺失）'};
	}

	const path = codexConfigPath();
	let current: TomlDocument = {};
	if (existsSync(path)) {
		try {
			current = parse(readFileSync(path, 'utf8'));
		} catch (error) {
			return {ok: false, error: `无法解析现有 config.toml，已停止以避免覆盖用户配置：${redactTomlSecrets(error instanceof Error ? error.message : String(error))}`};
		}
	}

	let next = current;
	let changed = 0;
	for (const key of RECOMMENDED_TOP_LEVEL_KEYS) {
		const existing = getPath(next, [key]);
		if (existing === undefined || existing === null || (typeof existing === 'string' && existing.trim() === '')) {
			const value = getPath(recommended, [key]);
			if (value !== undefined && value !== null) {
				next = setPath(next, [key], value);
				changed++;
			}
		}
	}

	try {
		atomicWrite(path, next);
		return {ok: true, changed};
	} catch (error) {
		return {ok: false, error: redactTomlSecrets(error instanceof Error ? error.message : String(error))};
	}
}

/** 组装带注释的推荐配置文本（直接复用契约原文，已带注释式 TOML）。 */
export function assembleCodexRecommendationAnnotated(): string | null {
	return loadCodexConfigRecommendationText();
}

/** 保存编辑后的 TOML 文本到 `CODEX_HOME/config.toml`（结构化校验 + 原子写）。 */
export function saveCodexConfigToml(tomlContent: string): {ok: boolean; error?: string; warning?: string} {
	let document: TomlDocument;
	try {
		document = parse(tomlContent);
	} catch (error) {
		return {ok: false, error: `TOML 格式错误: ${redactTomlSecrets(error instanceof Error ? error.message : String(error))}`};
	}

	void CODEX_OWNED_TOP_LEVEL_KEYS;
	const foreignSections = CODEX_FOREIGN_SECTIONS.filter(key => getPath(document, [key]) !== undefined);
	const warning = foreignSections.length > 0
		? `已保存完整 config.toml；${foreignSections.join(', ')} 由 Provider/MCP/Hooks 等页面管理，推荐导入不会修改这些字段。`
		: undefined;

	try {
		atomicWrite(codexConfigPath(), document);
		return warning ? {ok: true, warning} : {ok: true};
	} catch (error) {
		return {ok: false, error: redactTomlSecrets(error instanceof Error ? error.message : String(error))};
	}
}

/** 损坏 config.toml 拒绝覆盖（对齐 Install-ClaudeConfig 安全策略，供 verify 断言）。 */
export function isCodexConfigCorrupted(): boolean {
	const text = readCodexConfigText();
	if (text === null) {
		return false;
	}

	try {
		parse(text);
		return false;
	} catch {
		return true;
	}
}
