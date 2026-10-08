import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, win32} from 'node:path';
import {codexConfigPath} from './paths.js';
import {
	atomicWrite,
	deletePath,
	getPath,
	parse,
	redactTomlSecrets,
	setPath,
	stringify,
	type TomlDocument,
	type TomlPath
} from './toml-edit.js';
import {loadTextContract} from './contracts.js';

// Codex 推荐配置 + fill-missing（design D10 / HC-CONFIG-RULES-REUSE）。
// 与 Claude ConfigView UI 复用：预览页 / e 编辑 / Ctrl+T 推荐 / Ctrl+O fill-missing 导入。
// 仅管理 Codex 自身通用运行项（model_reasoning_effort / approval_policy / sandbox_mode /
// web_search / hide_agent_reasoning / file_opener）。
// model 归供应商（由 Provider profile 设为默认时写入 config.toml），Config 页与
// provider/MCP/Skills/AGENTS.md 一样不展示、不管理，仅在保存时从原文件合并保留
// （分别归 Provider/MCP/Skills/Global Rules 管）。hooks 无专属视图接管，已放开在
// 本页直编（与 Claude settings.json 侧一致），随 edited 落盘。

// fill-missing 托管键（TomlPath 支持嵌套路径，便于后续扩展 table 段子键）。补齐语义：仅当目标路径缺失时写入推荐值。
const RECOMMENDED_KEY_PATHS: readonly TomlPath[] = [
	['model_reasoning_effort'],
	['approval_policy'],
	['sandbox_mode'],
	['web_search'],
	['hide_agent_reasoning'],
	['file_opener']
];
// model/model_provider/model_providers 归供应商（Provider profile 设默认时合并写入），
// mcp_servers 归 MCP 视图管；三者在 Config 页仅展示前剥离、保存时从原文件合并保留。
// hooks 已放开：与 Claude settings.json 侧一致，无专属视图接管，在配置文件页直编。
const CODEX_UNMANAGED_KEYS = ['model', 'model_provider', 'model_providers', 'mcp_servers'] as const;

/** 仅对缺失（undefined/null/空串）的托管路径写入推荐值，返回新 document 与新增计数。 */
function fillMissingRecommended(current: TomlDocument, recommended: TomlDocument): {document: TomlDocument; changed: number} {
	let next = current;
	let changed = 0;
	for (const path of RECOMMENDED_KEY_PATHS) {
		const existing = getPath(next, path);
		if (existing === undefined || existing === null || (typeof existing === 'string' && existing.trim() === '')) {
			const value = getPath(recommended, path);
			if (value !== undefined && value !== null) {
				next = setPath(next, path, value);
				changed++;
			}
		}
	}
	return {document: next, changed};
}

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

function stripCodexUnmanagedKeys(document: TomlDocument): TomlDocument {
	let next = document;
	for (const key of CODEX_UNMANAGED_KEYS) {
		next = deletePath(next, [key]);
	}
	return next;
}

function mergeCodexUnmanagedKeys(edited: TomlDocument, original: TomlDocument | null): TomlDocument {
	let next = stripCodexUnmanagedKeys(edited);
	if (!original) {
		return next;
	}

	for (const key of CODEX_UNMANAGED_KEYS) {
		const value = getPath(original, [key]);
		if (value !== undefined) {
			next = setPath(next, [key], value);
		}
	}
	return next;
}

function readCodexConfigRawText(): string | null {
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

/** 读取当前 `~/.codex/config.toml` 的 Config 页管辖内容（不存在返回 null）。 */
export function readCodexConfigText(): string | null {
	const text = readCodexConfigRawText();
	if (text === null) {
		return null;
	}

	try {
		return stringify(stripCodexUnmanagedKeys(parse(text)));
	} catch {
		return text;
	}
}

/** 读取当前 `~/.codex/config.toml` 为 document；不存在或解析失败返回 null。 */
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
export function applyCodexFillMissingToText(
	tomlText: string
): {readonly ok: true; readonly text: string; readonly changed: number} | {readonly ok: false; readonly error: string} {
	const recommended = loadRecommendedDocument();
	if (!recommended) {
		return {ok: false, error: 'Codex 推荐配置契约不可用（contracts/codex-config.toml 缺失）'};
	}

	let current: TomlDocument;
	try {
		const parsed = parse(tomlText);
		current = parsed;
	} catch (error) {
		return {
			ok: false,
			error: `当前编辑内容不是合法 TOML：${redactTomlSecrets(error instanceof Error ? error.message : String(error))}`
		};
	}

	const {document: next, changed} = fillMissingRecommended(stripCodexUnmanagedKeys(current), recommended);
	return {ok: true, text: stringify(next), changed};
}

/** 端到端 fill-missing 导入到 `~/.codex/config.toml`：解析失败时拒绝覆盖。 */
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
			return {
				ok: false,
				error: `无法解析现有 config.toml，已停止以避免覆盖用户配置：${redactTomlSecrets(error instanceof Error ? error.message : String(error))}`
			};
		}
	}

	const {document: next, changed} = fillMissingRecommended(stripCodexUnmanagedKeys(current), recommended);

	try {
		atomicWrite(path, mergeCodexUnmanagedKeys(next, current));
		return {ok: true, changed};
	} catch (error) {
		return {ok: false, error: redactTomlSecrets(error instanceof Error ? error.message : String(error))};
	}
}

/** 组装带注释的推荐配置文本（直接复用契约原文，已带注释式 TOML）。 */
export function assembleCodexRecommendationAnnotated(): string | null {
	return loadCodexConfigRecommendationText();
}

/** 保存编辑后的 TOML 文本到 `~/.codex/config.toml`（结构化校验 + 原子写，外部 section 原样合并保留）。 */
export function saveCodexConfigToml(tomlContent: string): {ok: boolean; error?: string; warning?: string} {
	let document: TomlDocument;
	try {
		document = parse(tomlContent);
	} catch (error) {
		return {ok: false, error: `TOML 格式错误: ${redactTomlSecrets(error instanceof Error ? error.message : String(error))}`};
	}

	const rawOriginal = readCodexConfigRawText();
	let original: TomlDocument | null = null;
	if (rawOriginal !== null) {
		try {
			original = parse(rawOriginal);
		} catch {
			original = null;
		}
	}

	try {
		atomicWrite(codexConfigPath(), mergeCodexUnmanagedKeys(document, original));
		return {ok: true};
	} catch (error) {
		return {ok: false, error: redactTomlSecrets(error instanceof Error ? error.message : String(error))};
	}
}

// Transfer portability is independent of Config view ownership: provider/model and
// MCP remain available for their owners to project; only machine-bound state is removed.
const CODEX_NON_PORTABLE_PATHS: readonly TomlPath[] = [
	['projects'],
	['notice'],
	['windows_wsl_setup_acknowledged'],
	['sqlite_home'],
	['log_dir'],
	['model_catalog_json'],
	['model_instructions_file'],
	['experimental_compact_prompt_file'],
	['tui', 'model_availability_nux'],
	['tui', 'resume_cwd'],
	['skills', 'config'],
	['desktop', 'custom_file_handlers'],
	['sandbox_workspace_write', 'writable_roots']
];

function isTomlTable(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMachineAbsolutePath(value: unknown): value is string {
	return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value));
}

/** Removing only command/cwd would silently change a dynamic entry's semantics. */
function hasMachineBoundCommand(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasMachineBoundCommand);
	if (!isTomlTable(value)) return false;
	return Object.entries(value).some(
		([key, field]) => (['command', 'cwd'].includes(key) && isMachineAbsolutePath(field)) || hasMachineBoundCommand(field)
	);
}

export function portableCodexConfig(document: TomlDocument): {
	readonly config: TomlDocument;
	readonly excluded: readonly {readonly key: string}[];
} {
	const excluded: {key: string}[] = [];
	let config = structuredClone(document);
	function exclude(path: TomlPath): void {
		if (getPath(config, path) === undefined) return;
		config = deletePath(config, path);
		excluded.push({key: path.join('.')});
	}

	for (const path of CODEX_NON_PORTABLE_PATHS) exclude(path);
	const agents = getPath(config, ['agents']);
	if (isTomlTable(agents)) {
		for (const id of Object.keys(agents)) exclude(['agents', id, 'config_file']);
	}
	const permissions = getPath(config, ['permissions']);
	if (isTomlTable(permissions)) {
		for (const id of Object.keys(permissions)) {
			exclude(['permissions', id, 'workspace_roots']);
			const path = ['permissions', id, 'filesystem'];
			const filesystem = getPath(config, path);
			if (!isTomlTable(filesystem)) continue;
			const portable = Object.fromEntries(Object.entries(filesystem).filter(([key]) => !isMachineAbsolutePath(key)));
			if (Object.keys(portable).length !== Object.keys(filesystem).length) {
				config = setPath(config, path, portable);
				// Do not expose absolute filesystem keys in summaries.
				excluded.push({key: path.join('.')});
			}
		}
	}
	const marketplaces = getPath(config, ['marketplaces']);
	if (isTomlTable(marketplaces)) {
		for (const [id, entry] of Object.entries(marketplaces)) {
			if (isTomlTable(entry) && entry.source_type === 'local') exclude(['marketplaces', id]);
		}
	}
	for (const table of ['mcp_servers', 'model_providers']) {
		const entries = getPath(config, [table]);
		if (!isTomlTable(entries)) continue;
		for (const [id, entry] of Object.entries(entries)) {
			if (hasMachineBoundCommand(entry)) exclude([table, id]);
		}
	}
	return {config, excluded};
}

export function readCodexConfigDocumentStrict():
	| {readonly status: 'missing'}
	| {readonly status: 'invalid'; readonly error: string}
	| {readonly status: 'valid'; readonly value: TomlDocument} {
	const raw = readCodexConfigRawText();
	if (raw === null) return {status: 'missing'};
	try {
		return {status: 'valid', value: parse(raw)};
	} catch (error) {
		return {status: 'invalid', error: error instanceof Error ? error.message : String(error)};
	}
}

export {stripCodexUnmanagedKeys};

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
