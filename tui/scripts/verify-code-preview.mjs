import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// CodePreview markdown 回归门禁：
// - markdown 预览可以做行级高亮（标题/列表/代码块），但普通行必须保持整行单 <text> 节点。
// - OpenTUI flex row 遇到多个行内 token 时，长行换行会把 token 当作独立 flex item 排布，
//   导致 `inline code` 这类反引号片段在预览页错位；编辑页 textarea 不受影响。

const source = readFileSync(new URL('../src/components/code-preview.tsx', import.meta.url), 'utf8');

assert.doesNotMatch(source, /function\s+tokenizeMarkdownInline\s*\(/, 'Markdown 预览不得再使用行内 token 拆分函数');
assert.doesNotMatch(source, /line\.indexOf\('`'/, 'Markdown 预览不得按反引号拆分普通行');
assert.match(
	source,
	/Markdown 预览保持“每行一个 text 节点”[\s\S]*return \[\{text: line, fg: syntax\.default\}\];/,
	'Markdown 普通行必须作为整行单 token 渲染，避免长行换行错位'
);

// HC-CODEPREVIEW-TRAILING-NEWLINE：尾部单个换行是文件标准结尾，不得渲染成可见空行。
// split('\n') 会在尾部产出空串（"a\n" → ["a", ""]），必须裁掉这个伪空行，否则预览末尾多一道空行。
assert.match(
	source,
	/rawLines\.length > 1 && rawLines\[rawLines\.length - 1\] === ''\s*\?\s*rawLines\.slice\(0, -1\)\s*:\s*rawLines/,
	'CodePreview 必须裁掉 trailing newline 产生的尾部伪空行（保留中间空行）'
);

// HC-CODEPREVIEW-SELECTABLE：只读预览区 <text> 必须加 selectable，
// 配合 renderer 'selection' 事件实现 copy-on-select（鼠标拖选自动复制）。
// 行号 <text> 同样 selectable，跨行选择时行号文本会被聚合进 selection 文本，
// 取舍为「能选」优于「行号干净」，与 OpenTUI 官方 selectable 行为一致。
assert.match(source, /<text key=\{tokenIndex\}[^>]*selectable[^>]*>/, 'CodePreview 正文 <text> 必须声明 selectable 以支持 copy-on-select');
assert.match(source, /<text fg=\{colors\.lineNumberForeground\}[^>]*selectable/, 'CodePreview 行号 <text> 必须声明 selectable 以支持跨行选择');

// TOML 预览复用 CodePreview 的行号、主题与可选择复制能力，不依赖 Tree-sitter，
// 以保证源码和 bun --compile 单文件产物都有一致样式。
assert.match(source, /CodePreviewFiletype = 'markdown' \| 'json' \| 'jsonc' \| 'toml' \| 'text'/, 'CodePreview 必须声明 toml 文件类型');
assert.match(source, /if \(filetype === 'toml'\) \{\s*return tomlPreviewTokens\(line\);\s*\}/, 'TOML 必须走独立的预览分词分支');
assert.match(source, /function tomlPreviewTokens\(/, 'TOML 预览必须有独立行级分词器');
assert.match(source, /findTomlUnquotedCharacter\(line, '#'/, 'TOML 注释检测必须忽略引号内的 #');
assert.match(source, /function tomlTableTokens\(/, 'TOML 表头必须单独着色');
assert.match(source, /function tomlKeyValueTokens\(/, 'TOML 键值对必须单独着色');
assert.match(source, /colors\.muted, attributes: TextAttributes\.DIM/, 'TOML 注释必须使用弱化样式');

console.log('[PASS] CodePreview 长行不拆 inline token + 尾部换行不渲染 + selectable copy-on-select + TOML 预览');
