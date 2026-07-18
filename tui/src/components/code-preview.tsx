import React from 'react';
import {TextAttributes} from '@opentui/core';
import {colors, getActiveTheme} from '../theme/index.js';

export type CodePreviewFiletype = 'markdown' | 'json' | 'jsonc' | 'toml' | 'text';

type PreviewToken = {
	readonly text: string;
	readonly fg?: string;
	readonly attributes?: (typeof TextAttributes)[keyof typeof TextAttributes];
};

export type CodePreviewProps = {
	readonly content: string;
	readonly filetype: CodePreviewFiletype;
	readonly showLineNumbers?: boolean;
};

type JsonTokenType = 'key' | 'string' | 'number' | 'boolean' | 'punct' | 'space';
type JsonToken = {readonly type: JsonTokenType; readonly text: string};

export function CodePreview({content, filetype, showLineNumbers = true}: CodePreviewProps) {
	// 先归一化换行：Windows 读盘内容（如 ~/.claude/CLAUDE.md、settings.json）为 CRLF，
	// 若只按 '\n' 拆行会让每行尾残留 '\r'，OpenTUI 把 '\r' 当额外换行渲染 → 行高翻倍。
	// 用 /\r\n?|\n/ 一次吃掉 CRLF / CR / LF 三种风格（对齐推荐模板 readTemplateFile 的归一化）。
	// 末尾单个换行是文件标准结尾（POSIX），不应渲染成可见空行：split 会在尾部产出空串
	// （如 "a\n" → ["a", ""]），去掉这个由 trailing newline 产生的伪空行。
	const rawLines = content.split(/\r\n?|\n/);
	const lines = rawLines.length > 1 && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines;
	const lineNumberWidth = Math.max(3, String(lines.length).length);
	const markdownLines = filetype === 'markdown' ? tokenizeMarkdownLines(lines) : null;

	return (
		<box flexDirection="column">
			{lines.map((line, index) => (
				<box key={index} flexDirection="row">
					{showLineNumbers ? <LineNumber index={index} width={lineNumberWidth} /> : null}
					<box flexDirection="row">
						{tokensForLine(line, filetype, markdownLines?.[index]).map((token, tokenIndex) => (
							<text key={tokenIndex} fg={token.fg} attributes={token.attributes} selectable selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
								{token.text.length > 0 ? token.text : ' '}
							</text>
						))}
					</box>
				</box>
			))}
		</box>
	);
}

function LineNumber({index, width}: {readonly index: number; readonly width: number}) {
	return (
		<text fg={colors.lineNumberForeground} bg={colors.lineNumberBackground} selectable selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${String(index + 1).padStart(width, ' ')} │ `}
		</text>
	);
}

function tokensForLine(line: string, filetype: CodePreviewFiletype, markdownTokens?: readonly PreviewToken[]): readonly PreviewToken[] {
	if (markdownTokens) {
		return markdownTokens;
	}

	if (filetype === 'json' || filetype === 'jsonc') {
		return jsonPreviewTokens(line, filetype === 'jsonc');
	}
	if (filetype === 'toml') {
		return tomlPreviewTokens(line);
	}

	return plainToken(line);
}

function plainToken(line: string): readonly PreviewToken[] {
	return [{text: line.length > 0 ? line : ' ', fg: colors.info}];
}

/** 按行 tokenize JSON：key（后跟冒号的字符串）/ string / number / boolean·null / 标点 / 空白。 */
function tokenizeJsonLine(line: string): readonly JsonToken[] {
	const tokens: JsonToken[] = [];
	let cursor = 0;
	while (cursor < line.length) {
		const next = readJsonToken(line, cursor);
		tokens.push(next.token);
		cursor = next.nextCursor;
	}
	return tokens;
}

function readJsonToken(line: string, cursor: number): {readonly token: JsonToken; readonly nextCursor: number} {
	const char = line[cursor]!;
	if (/\s/.test(char)) {
		return readWhile(line, cursor, charAt => /\s/.test(charAt), 'space');
	}
	if (char === '"') {
		return readJsonString(line, cursor);
	}
	if ('{}[]:,'.includes(char)) {
		return {token: {type: 'punct', text: char}, nextCursor: cursor + 1};
	}
	if (char === '-' || (char >= '0' && char <= '9')) {
		return readWhile(line, cursor, charAt => /[-+.eE0-9]/.test(charAt), 'number');
	}
	if (char >= 'a' && char <= 'z') {
		return readWhile(line, cursor, charAt => /[a-z]/.test(charAt), 'boolean');
	}
	return {token: {type: 'string', text: char}, nextCursor: cursor + 1};
}

function readWhile(line: string, start: number, predicate: (char: string) => boolean, type: JsonTokenType): {readonly token: JsonToken; readonly nextCursor: number} {
	let cursor = start + 1;
	while (cursor < line.length && predicate(line[cursor]!)) cursor++;
	return {token: {type, text: line.slice(start, cursor)}, nextCursor: cursor};
}

function readJsonString(line: string, start: number): {readonly token: JsonToken; readonly nextCursor: number} {
	let cursor = start + 1;
	while (cursor < line.length) {
		if (line[cursor] === '\\') {
			cursor += 2;
			continue;
		}
		if (line[cursor] === '"') {
			cursor++;
			break;
		}
		cursor++;
	}

	let lookahead = cursor;
	while (lookahead < line.length && /\s/.test(line[lookahead]!)) lookahead++;
	return {token: {type: line[lookahead] === ':' ? 'key' : 'string', text: line.slice(start, cursor)}, nextCursor: cursor};
}

function jsonPreviewTokens(line: string, jsonc: boolean): readonly PreviewToken[] {
	if (jsonc && line.trimStart().startsWith('//')) {
		return [{text: line.length > 0 ? line : ' ', fg: colors.muted, attributes: TextAttributes.DIM}];
	}
	if (line.length === 0) {
		return [{text: ' '}];
	}
	return tokenizeJsonLine(line).map(token => ({text: token.text, fg: jsonTokenColor(token.type)}));
}

function jsonTokenColor(type: JsonTokenType): string {
	const {jsonTokens} = getActiveTheme();
	switch (type) {
		case 'key': return jsonTokens.key;
		case 'string': return jsonTokens.string;
		case 'number': return jsonTokens.number;
		case 'boolean': return jsonTokens.boolean;
		case 'punct': return jsonTokens.punct;
		case 'space': return jsonTokens.space;
	}
}

/** TOML 预览仅做行级着色，不参与配置解析或写入。 */
function tomlPreviewTokens(line: string): readonly PreviewToken[] {
	if (line.length === 0) {
		return [{text: ' '}];
	}

	const commentIndex = findTomlUnquotedCharacter(line, '#');
	const content = commentIndex === -1 ? line : line.slice(0, commentIndex);
	const comment = commentIndex === -1 ? '' : line.slice(commentIndex);
	const tokens = isTomlTableHeader(content)
		? tomlTableTokens(content)
		: tomlKeyValueTokens(content);
	if (comment) {
		tokens.push({text: comment, fg: colors.muted, attributes: TextAttributes.DIM});
	}
	return tokens;
}

function isTomlTableHeader(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith('[') && trimmed.endsWith(']');
}

function tomlTableTokens(line: string): PreviewToken[] {
	const leadingLength = line.length - line.trimStart().length;
	const trimmed = line.trim();
	const bracketCount = trimmed.startsWith('[[') ? 2 : 1;
	const name = trimmed.slice(bracketCount, -bracketCount);
	const tokens: PreviewToken[] = [];
	if (leadingLength > 0) {
		tokens.push({text: line.slice(0, leadingLength), fg: jsonTokenColor('space')});
	}
	tokens.push({text: '['.repeat(bracketCount), fg: jsonTokenColor('punct')});
	tokens.push({text: name, fg: getActiveTheme().syntax.type, attributes: TextAttributes.BOLD});
	tokens.push({text: ']'.repeat(bracketCount), fg: jsonTokenColor('punct')});
	return tokens;
}

function tomlKeyValueTokens(line: string): PreviewToken[] {
	const equalsIndex = findTomlUnquotedCharacter(line, '=');
	if (equalsIndex === -1) {
		return [...plainToken(line)];
	}

	const keyPart = line.slice(0, equalsIndex);
	const leadingLength = keyPart.length - keyPart.trimStart().length;
	const trailingLength = keyPart.length - keyPart.trimEnd().length;
	const tokens: PreviewToken[] = [];
	if (leadingLength > 0) {
		tokens.push({text: keyPart.slice(0, leadingLength), fg: jsonTokenColor('space')});
	}
	const key = keyPart.trim();
	if (key) {
		tokens.push({text: key, fg: jsonTokenColor('key')});
	}
	if (trailingLength > 0) {
		tokens.push({text: keyPart.slice(keyPart.length - trailingLength), fg: jsonTokenColor('space')});
	}
	tokens.push({text: '=', fg: jsonTokenColor('punct')});
	tokens.push(...tomlValueTokens(line.slice(equalsIndex + 1)));
	return tokens;
}

function tomlValueTokens(value: string): PreviewToken[] {
	const tokens: PreviewToken[] = [];
	let cursor = 0;
	while (cursor < value.length) {
		const char = value[cursor]!;
		if (/\s/.test(char)) {
			const next = readWhile(value, cursor, charAt => /\s/.test(charAt), 'space');
			tokens.push({text: next.token.text, fg: jsonTokenColor('space')});
			cursor = next.nextCursor;
			continue;
		}
		if (char === '"' || char === "'") {
			const next = readTomlString(value, cursor, char);
			tokens.push({text: next.text, fg: jsonTokenColor('string')});
			cursor = next.nextCursor;
			continue;
		}
		if ('[]{}.,'.includes(char)) {
			tokens.push({text: char, fg: jsonTokenColor('punct')});
			cursor++;
			continue;
		}
		const next = readTomlBareValue(value, cursor);
		const type: JsonTokenType = /^(true|false)$/i.test(next.text)
			? 'boolean'
			: /^[-+]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?$/.test(next.text)
				? 'number'
				: 'string';
		tokens.push({text: next.text, fg: jsonTokenColor(type)});
		cursor = next.nextCursor;
	}
	return tokens;
}

function readTomlString(line: string, start: number, quote: '"' | "'"): {readonly text: string; readonly nextCursor: number} {
	let cursor = start + 1;
	while (cursor < line.length) {
		if (quote === '"' && line[cursor] === '\\') {
			cursor += 2;
			continue;
		}
		if (line[cursor] === quote) {
			cursor++;
			break;
		}
		cursor++;
	}
	return {text: line.slice(start, cursor), nextCursor: cursor};
}

function readTomlBareValue(line: string, start: number): {readonly text: string; readonly nextCursor: number} {
	let cursor = start + 1;
	while (cursor < line.length && !/\s/.test(line[cursor]!) && !'[]{}.,'.includes(line[cursor]!)) cursor++;
	return {text: line.slice(start, cursor), nextCursor: cursor};
}

/** 查找未落在单/双引号内的 TOML 分隔符，双引号字符串支持转义。 */
function findTomlUnquotedCharacter(line: string, target: '#' | '='): number {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < line.length; index++) {
		const char = line[index]!;
		if (quote === '"' && char === '\\') {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === target) return index;
	}
	return -1;
}

function tokenizeMarkdownLines(lines: readonly string[]): readonly (readonly PreviewToken[])[] {
	let inFence = false;
	return lines.map(line => {
		const tokens = markdownTokensForLine(line, inFence);
		if (line.trimStart().startsWith('```')) {
			inFence = !inFence;
		}
		return tokens;
	});
}

function markdownTokensForLine(line: string, inFence: boolean): readonly PreviewToken[] {
	const syntax = getActiveTheme().syntax;
	const trimmed = line.trimStart();
	if (line.length === 0) {
		return [{text: ' '}];
	}
	if (inFence || trimmed.startsWith('```')) {
		return [{text: line, fg: syntax.markupRaw}];
	}
	if (trimmed.startsWith('#')) {
		return [{text: line, fg: syntax.markupHeading, attributes: TextAttributes.BOLD}];
	}
	if (trimmed.startsWith('>')) {
		return [{text: line, fg: syntax.markupQuote, attributes: TextAttributes.DIM}];
	}
	if (/^\s*(-|\*|\+|\d+\.)\s+/.test(line)) {
		return [{text: line, fg: syntax.markupList}];
	}
	// Markdown 预览保持“每行一个 text 节点”：OpenTUI flex row 遇到多个行内 token 时，
	// 长行换行会把 token 当作独立 flex item 重新排布，导致反引号片段错位。
	return [{text: line, fg: syntax.default}];
}
