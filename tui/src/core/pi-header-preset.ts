import {release} from 'node:os';
import {loadContract} from './contracts.js';

/**
 * Pi 请求头预设：契约驱动的「填充动作」。
 *
 * 预设不承载选中状态、不落盘，编辑区文本才是 `providers.<id>.headers` 的唯一真相源；
 * 本模块只提供契约归一化、动作行选项集、匹配判定与 JSON 文本互转。
 */

export type PiHeaderPresetOptionalHeader = {
	readonly headerName: string;
	readonly defaultValue: string;
	readonly reason: string;
};

export type PiHeaderPreset = {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	/** 受控白名单：命中即该协议只有此预设可选；未命中即走自由模式。 */
	readonly apis: readonly string[];
	readonly headers: Readonly<Record<string, string>>;
	readonly optionalHeaders: readonly PiHeaderPresetOptionalHeader[];
};

export type PiHeaderPresetOption = {
	readonly preset: PiHeaderPreset;
	readonly matchesApi: boolean;
};

type RawPiHeaderPresetContract = {
	Presets?: Record<string, RawPiHeaderPreset>;
};

type RawPiHeaderPreset = {
	Label?: string;
	Description?: string;
	Apis?: string[];
	Headers?: Record<string, string>;
	OptionalHeaders?: {HeaderName?: string; DefaultValue?: string; Reason?: string}[];
};

// RFC 7230 token：请求头名允许的字符集。反引号在字符类内是字面量。
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

// fetch/undici 层会接管或拒绝这两个头，允许用户配置只会得到未定义行为。
const RESERVED_HEADER_NAMES = new Set(['host', 'content-length']);

/**
 * 占位符在加载期替换为运行时值，下游（动作行、匹配、填充、落盘）看到的都是具体值，
 * 落盘绝不写占位符。
 *
 * - `{platform}` / `{arch}`：与 Gemini CLI 构造 UA 的取值语义一致（`win32` / `x64`）。
 * - `{os}`：系统名 + 内核版本（如 `Windows 10.0.19045`），与 Codex CLI 的 UA 取值对齐。
 */
function runtimePlaceholders(): Readonly<Record<string, string>> {
	const osName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac OS' : 'Linux';
	return {
		'{platform}': process.platform,
		'{arch}': process.arch,
		'{os}': `${osName} ${release()}`
	};
}

function substituteRuntimePlaceholders(value: string): string {
	let next = value;
	for (const [placeholder, replacement] of Object.entries(runtimePlaceholders())) {
		next = next.split(placeholder).join(replacement);
	}
	return next;
}

function normalizeContract(raw: RawPiHeaderPresetContract): readonly PiHeaderPreset[] {
	const presets: PiHeaderPreset[] = [];
	for (const [key, value] of Object.entries(raw.Presets ?? {})) {
		if (!value || typeof value !== 'object') continue;
		const headers: Record<string, string> = {};
		for (const [headerName, headerValue] of Object.entries(value.Headers ?? {})) {
			if (typeof headerValue !== 'string') continue;
			headers[String(headerName)] = substituteRuntimePlaceholders(headerValue);
		}
		const optionalHeaders = (value.OptionalHeaders ?? [])
			.map(item => ({
				headerName: String(item?.HeaderName ?? ''),
				defaultValue: substituteRuntimePlaceholders(String(item?.DefaultValue ?? '')),
				reason: String(item?.Reason ?? '')
			}))
			.filter(item => item.headerName.length > 0);
		presets.push({
			key,
			label: String(value.Label ?? key),
			description: String(value.Description ?? ''),
			apis: (value.Apis ?? []).map(String),
			headers,
			optionalHeaders
		});
	}
	return presets;
}

let presetCache: readonly PiHeaderPreset[] | null = null;

/** 加载请求头预设契约（带缓存）；契约键序即动作行顺序。 */
export function loadPiHeaderPresets(): readonly PiHeaderPreset[] {
	if (presetCache) return presetCache;
	const raw = loadContract<RawPiHeaderPresetContract>('pi-header-presets.json');
	presetCache = normalizeContract(raw);
	return presetCache;
}

/** 仅供测试：重置契约缓存，强制下次重新加载。 */
export function resetPiHeaderPresetCache(): void {
	presetCache = null;
}

/** 按 key 取预设；未知 key 返回 null。 */
export function piHeaderPreset(key: string): PiHeaderPreset | null {
	return loadPiHeaderPresets().find(preset => preset.key === key) ?? null;
}

/**
 * 动作行选项集：
 *   受控（api 命中某预设 Apis）→ 只含该协议的预设
 *   自由（未命中）             → 含全部预设
 * 恒不含 none / custom —— 清空即清空编辑区，无需选项。
 */
export function piHeaderPresetOptions(api: string): readonly PiHeaderPresetOption[] {
	const presets = loadPiHeaderPresets();
	const controlled = presets.filter(preset => preset.apis.includes(api));
	if (controlled.length > 0) return controlled.map(preset => ({preset, matchesApi: true}));
	return presets.map(preset => ({preset, matchesApi: false}));
}

/** 该 api 是否为受控模式（存在命中 Apis 的预设）。仅用于说明文案分支。 */
export function isControlledHeaderPresetApi(api: string): boolean {
	return loadPiHeaderPresets().some(preset => preset.apis.includes(api));
}

/**
 * 动作行的有效高亮项：`current` 不在本协议可用集内时回落到首个可用预设。
 * 切换 api 后高亮项可能指向不再列出的预设（例如 free → openai-responses），
 * Enter 只能应用动作行实际列出的预设，因此渲染与按键都必须走这一判据。
 */
export function resolveHeaderPresetSelection(api: string, current: string): string {
	const options = piHeaderPresetOptions(api);
	if (options.some(option => option.preset.key === current)) return current;
	return options[0]?.preset.key ?? '';
}

/** 协议层预选建议；无受控预设返回 null。仅用于说明文案，不自动应用。 */
export function suggestHeaderPreset(api: string): {readonly key: string; readonly reason: string} | null {
	const preset = loadPiHeaderPresets().find(item => item.apis.includes(api));
	return preset ? {key: preset.key, reason: preset.description} : null;
}

function headerLookup(headers: Readonly<Record<string, string>>): Map<string, string> {
	return new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function headersEqual(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
	const leftLookup = headerLookup(left);
	const rightLookup = headerLookup(right);
	if (leftLookup.size !== rightLookup.size) return false;
	for (const [key, value] of leftLookup) {
		if (rightLookup.get(key) !== value) return false;
	}
	return true;
}

/**
 * 跨协议提示用：编辑区内容与**任意**预设完全一致时返回该 key，否则 null。
 * 精确匹配规则：键名不区分大小写；键集合与全部值相等。
 */
export function matchedHeaderPreset(headers: Readonly<Record<string, string>>): string | null {
	const normalized = normalizeHeaderEntries(headers);
	if (Object.keys(normalized).length === 0) return null;
	for (const preset of loadPiHeaderPresets()) {
		if (headersEqual(normalized, preset.headers)) return preset.key;
	}
	return null;
}

/** 该预设在当前 api 下是否受控（用于决定是否给出跨协议提示）。 */
export function headerPresetMatchesApi(presetKey: string, api: string): boolean {
	return piHeaderPreset(presetKey)?.apis.includes(api) ?? false;
}

/** 丢空键与空值；键名与值原样保留（不 trim 值、不改大小写）。 */
export function normalizeHeaderEntries(headers: Readonly<Record<string, string>>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.trim() === '' || value.trim() === '') continue;
		result[key] = value;
	}
	return result;
}

/** 返回错误文案；合法返回 null。 */
export function validateHeaderName(name: string): string | null {
	if (name.trim() === '') return '请求头名不能为空';
	if (!HEADER_NAME_PATTERN.test(name)) return `非法请求头名「${name}」：必须是 RFC 7230 token`;
	if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) return `请求头「${name}」由运行时管理，不能在此配置`;
	return null;
}

/** 认证头形态字段是否应当出现；只对 Anthropic 协议有增量价值。 */
export function authHeaderApplies(api: string): boolean {
	return api.trim() === 'anthropic-messages';
}

/**
 * Record → 多行 JSON 文本（键序稳定：命中预设时优先预设键序，其余按插入序）。
 * 值原样序列化，逗号、`$`、`!` 都不会被转义或截断。
 */
export function formatHeaderJson(headers: Readonly<Record<string, string>>): string {
	const normalized = normalizeHeaderEntries(headers);
	const matched = matchedHeaderPreset(normalized);
	const preset = matched ? piHeaderPreset(matched) : null;
	const ordered: Record<string, string> = {};
	if (preset) {
		const lookup = headerLookup(normalized);
		for (const key of Object.keys(preset.headers)) {
			const actualKey = Object.keys(normalized).find(candidate => candidate.toLowerCase() === key.toLowerCase());
			if (actualKey !== undefined && lookup.get(key.toLowerCase()) !== undefined) ordered[actualKey] = normalized[actualKey]!;
		}
	}
	for (const [key, value] of Object.entries(normalized)) {
		if (!Object.hasOwn(ordered, key)) ordered[key] = value;
	}
	return JSON.stringify(ordered, null, 2);
}

/**
 * 多行 JSON 文本 → Record；非法 JSON / 非对象 / 非字符串值 → 结构化错误。
 * 空文本与 `{}` 都归一化为空对象（留空即不配置请求头）。
 */
export function parseHeaderJson(
	text: string
): {readonly ok: true; readonly headers: Record<string, string>} | {readonly ok: false; readonly error: string} {
	if (text.trim() === '') return {ok: true, headers: {}};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {ok: false, error: `请求头 JSON 格式错误：${error instanceof Error ? error.message : String(error)}`};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {ok: false, error: '请求头必须是 JSON 对象，例如 {"User-Agent": "claude-cli/2.1.251 (external, cli)"}'};
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== 'string') return {ok: false, error: `请求头「${key || '(空名)'}」的值必须是字符串`};
		headers[key] = value;
	}
	return {ok: true, headers: normalizeHeaderEntries(headers)};
}

/** 预设的 JSON 文本形态，供编辑区填充使用；未知 key 返回 null。 */
export function headerPresetText(presetKey: string): string | null {
	const preset = piHeaderPreset(presetKey);
	return preset ? `${formatHeaderJson(preset.headers)}\n` : null;
}

/**
 * 是否需要二次确认：编辑区当前非空，且其内容与目标预设不同。
 * 非法 JSON 视为「不同」，由用户确认后再覆盖。
 */
export function headerPresetNeedsConfirm(current: string, presetKey: string): boolean {
	const preset = piHeaderPreset(presetKey);
	if (!preset) return false;
	if (current.trim() === '') return false;
	const parsed = parseHeaderJson(current);
	if (!parsed.ok) return true;
	return !headersEqual(parsed.headers, preset.headers);
}
