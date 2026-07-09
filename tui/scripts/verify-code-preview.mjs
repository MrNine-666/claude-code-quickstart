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

console.log('[PASS] CodePreview 长行不拆 inline token + 尾部换行不渲染');
