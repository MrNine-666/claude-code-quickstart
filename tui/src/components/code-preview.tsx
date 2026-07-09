import React from 'react';
import {TextAttributes} from '@opentui/core';
import {colors, getActiveTheme} from '../theme/index.js';

export type CodePreviewFiletype = 'markdown' | 'json' | 'jsonc' | 'text';

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
	const lines = content.split('\n');
	const lineNumberWidth = Math.max(3, String(lines.length).length);
	const markdownLines = filetype === 'markdown' ? tokenizeMarkdownLines(lines) : null;

	return (
		<box flexDirection="column">
			{lines.map((line, index) => (
				<box key={index} flexDirection="row">
					{showLineNumbers ? <LineNumber index={index} width={lineNumberWidth} /> : null}
					<box flexDirection="row">
						{tokensForLine(line, filetype, markdownLines?.[index]).map((token, tokenIndex) => (
							<text key={tokenIndex} fg={token.fg} attributes={token.attributes} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
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
		<text fg={colors.lineNumberForeground} bg={colors.lineNumberBackground} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
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
