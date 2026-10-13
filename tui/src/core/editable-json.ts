/** 仅用于用户 JSON 编辑输入；磁盘文件、网络响应必须继续严格解析。 */
export function parseEditableJson(json: string): {readonly value: unknown; readonly text: string} {
	let text = '';
	let inString = false;
	let escaped = false;
	for (const char of json) {
		if (inString) {
			text += char;
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
		} else {
			if (char === '"') inString = true;
			// 只规整字符串外的 Unicode 空格，凭据、URL 与转义内容保持原样。
			text += /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/u.test(char) ? ' ' : char;
		}
	}
	try {
		return {value: JSON.parse(text) as unknown, text};
	} catch {
		// 原生 JSON.parse 错误可能回显秘密；编辑入口只接收脱敏诊断。
		throw new SyntaxError('JSON 格式错误，请检查配置语法');
	}
}
