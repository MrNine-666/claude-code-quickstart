/**
 * 文本与凭据相关共享工具（对齐旧 provider-manager.js / mcp-manager.js 的纯函数）。
 */

export function isNullOrWhiteSpace(value: unknown): boolean {
	return value == null || String(value).trim() === '';
}

/** 脱敏 API Key（前 4 位 + ... + 后 2 位，对齐 Get-MaskedApiKey） */
export function maskApiKey(key: string | undefined | null): string {
	if (isNullOrWhiteSpace(key)) {
		return '-';
	}

	const s = String(key);
	if (s.length <= 8) {
		return '***';
	}

	return `${s.substring(0, 4)}...${s.substring(s.length - 2)}`;
}

/** 脱敏通用凭据值（前 4 位 + *** + 后 4 位，对齐 mcp-manager.js maskValue） */
export function maskValue(value: string | undefined | null): string {
	if (!value) {
		return '';
	}

	if (value.length <= 8) {
		return '***';
	}

	return `${value.substring(0, 4)}***${value.substring(value.length - 4)}`;
}

/** 规范化 Base URL（去尾斜杠，对齐 Normalize-ProviderBaseUrl） */
export function normalizeBaseUrl(baseUrl: string | undefined | null): string {
	if (isNullOrWhiteSpace(baseUrl)) {
		return '';
	}

	return String(baseUrl).trim().replace(/\/+$/, '');
}

/** 判断 settings BaseUrl 是否匹配 Profile BaseUrl（对齐 Test-ProviderBaseUrlMatch） */
export function testProviderBaseUrlMatch(settingsBaseUrl: string, profileBaseUrl: string): boolean {
	const a = normalizeBaseUrl(settingsBaseUrl);
	const b = normalizeBaseUrl(profileBaseUrl);
	if (!a || !b) {
		return false;
	}

	return a === b || a.toLowerCase().startsWith(`${b.toLowerCase()}/`);
}

/** 判断 settings 与 Profile 是否同一 Token（大小写敏感，对齐 Test-ProviderAuthTokenMatch） */
export function testProviderAuthTokenMatch(settingsToken: string, profileToken: string): boolean {
	return (
		!isNullOrWhiteSpace(settingsToken) &&
		!isNullOrWhiteSpace(profileToken) &&
		String(settingsToken) === String(profileToken)
	);
}

/** 校验 Provider Key 合法性（防路径穿越，对齐 Test-ProviderKey） */
export function testProviderKey(key: string | undefined | null): boolean {
	return !isNullOrWhiteSpace(key) && /^[A-Za-z0-9._-]+$/.test(String(key));
}

export function escapeRegex(str: string): string {
	return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 显示宽度（CJK 全角字符计 2，其余计 1）。 */
export function displayWidth(text: string): number {
	let width = 0;
	for (const ch of String(text)) {
		const code = ch.codePointAt(0) ?? 0;
		// CJK 统一表意 / 全角符号 / 假名 / 韩文 等常见全角区间计 2。
		const isWide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xe000 && code <= 0xf8ff) ||   // BMP 私有用区（Nerd Font 图标等，终端多按双宽渲染）
			(code >= 0xf0001 && code <= 0x1afff) || // 补充私有用区（nf-md-* Material Design 图标）
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe4f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += isWide ? 2 : 1;
	}

	return width;
}

/** 按显示宽度单行截断，超出加省略号（CJK 安全，防止卡片内容溢出）。 */
export function truncateToWidth(text: string, maxWidth: number): string {
	const value = String(text);
	if (displayWidth(value) <= maxWidth) {
		return value;
	}

	if (maxWidth <= 1) {
		return '…';
	}

	let width = 0;
	let result = '';
	for (const ch of value) {
		const chWidth = displayWidth(ch);
		if (width + chWidth > maxWidth - 1) {
			break;
		}

		result += ch;
		width += chWidth;
	}

	return `${result}…`;
}
