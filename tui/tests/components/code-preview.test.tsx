import {act} from 'react';
import {expect, test} from 'bun:test';
import {TextAttributes, parseColor} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {CodePreview} from '../../src/components/code-preview.js';
import {colors, getActiveTheme} from '../../src/theme/index.js';

// 迁自原 scripts/verify-code-preview.mjs 的源码正则段（P1-G5 静态断言治理，该脚本已随本批删除）。
// 原脚本 17 条均为 JSX 属性 / 内部函数名正则；有行为等价物的改写为下列 render/选择行为断言，
// 无 spec 背书且纯写法的（内部函数名、TS 类型联合字面量）删除，理由见
// .trellis/tasks/09-18-p1-static-assertion-governance/research-reconciliation-G5.md。
// 每个 testRender 用例固定 terminal 尺寸，并在 finally 的 act() 内销毁 renderer。

const longValue =
	'C:\\Users\\Administrator\\AppData\\Local\\OpenAI\\Codex\\runtimes\\node_modules\\@opentui\\bin\\windows\\codex-computer-use.exe';

test('CodePreview keeps line numbers aligned with wrapped highlighted lines', async () => {
	const content = ['first = "short"', `notif = ["${longValue}", "turn-ended"]`, 'last = true'].join('\n');
	const setup = await testRender(<CodePreview content={content} filetype="toml" />, {width: 48, height: 8});

	try {
		const frame = await setup.waitForFrame(output => output.includes('last = true'));
		const lines = frame.split('\n');
		const lastLineIndex = lines.findIndex(line => line.startsWith('  3 │ last = true'));

		// 行号列不得被内容列挤压：每行行号宽度完整（迁自 verify-code-preview 行号 flexShrink 断言）。
		expect(lines[0]).toMatch(/^  1 │ first = "short"/);
		expect(lines[1]).toMatch(/^  2 │ notif = \["C:\\Users\\Administrator\\/);
		expect(lastLineIndex).toBe(5);
		// 源码行从顶部对齐：续行不重复行号，只留行号槽空白（迁自 flex-start 断言）。
		expect(lines.slice(2, lastLineIndex).every(line => line.startsWith('      '))).toBe(true);
		// 内容列可收缩：长行在分配宽度内换行而非撑出视口（迁自 flexShrink/minWidth 断言）。
		expect(lines[4]).toContain('exe", "turn-ended"]');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('Markdown 普通行必须整行单 token 渲染，不得按行内反引号拆分', async () => {
	const line = '普通行 with `inline` 结尾';
	const setup = await testRender(<CodePreview content={`# 标题\n${line}`} filetype="markdown" />, {width: 40, height: 4});

	try {
		await setup.waitForFrame(output => output.includes(line));
		const bodySpans = setup
			.captureSpans()
			.lines.flatMap(row => row.spans)
			.filter(span => span.text.includes('普通行'));

		// 普通行必须是一个完整 text 节点（多个行内 token 会在长行换行时被当作独立 flex item 重排）。
		expect(bodySpans).toHaveLength(1);
		expect(bodySpans[0]!.text).toBe(line);
		expect(bodySpans[0]!.fg.equals(parseColor(getActiveTheme().syntax.default))).toBe(true);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('CodePreview 必须裁掉 trailing newline 伪空行并保留中间空行', async () => {
	const setup = await testRender(<CodePreview content={'a\n\nb\n'} filetype="text" />, {width: 20, height: 6});

	try {
		const frame = await setup.waitForFrame(output => output.includes('b'));
		expect(frame).toContain('  1 │ a');
		// 中间空行必须保留。
		expect(frame).toContain('  2 │');
		expect(frame).toContain('  3 │ b');
		// 尾部单个换行是文件标准结尾，不得渲染成第 4 个可见空行。
		expect(frame).not.toContain('  4 │');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('CodePreview 只读正文与行号都必须可被鼠标选中（copy-on-select 前提）', async () => {
	const setup = await testRender(<CodePreview content={'alpha body text'} filetype="text" />, {width: 40, height: 3});

	try {
		await setup.waitForFrame(output => output.includes('alpha body'));
		// 正文列（跳过 6 列行号槽）可选中。
		await setup.mockMouse.drag(6, 0, 19, 0);
		await setup.renderOnce();
		expect(setup.renderer.getSelection()?.getSelectedText()).toContain('alpha body');

		setup.renderer.clearSelection();
		// 行号 <text> 同样 selectable：跨行选择时行号文本会聚合进 selection。
		await setup.mockMouse.drag(0, 0, 5, 0);
		await setup.renderOnce();
		expect(setup.renderer.getSelection()?.getSelectedText()).toContain('1 │');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('TOML 预览必须按行级分词，保序、引号内 # 不是注释、表头/键值/注释配色正确', async () => {
	const lines = ['[package]', 'name = "ccq # not comment" # real comment'];
	const setup = await testRender(<CodePreview content={lines.join('\n')} filetype="toml" />, {width: 60, height: 4});

	try {
		await setup.waitForFrame(output => output.includes('# real comment'));
		const theme = getActiveTheme();
		const rows = setup.captureSpans().lines.map(row => row.spans);

		// token 顺序：同一个正文 <text> 内的 span 拼接必须逐字还原源码行（迁自 span 保序断言）。
		for (const [index, line] of lines.entries()) {
			const spans = rows[index]!;
			const body = spans.slice(spans.findIndex(span => span.text.includes('│')) + 1);
			while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();
			expect(body.map(span => span.text).join('')).toBe(line);
		}

		const header = rows[0]!;
		const bracket = header.find(span => span.text === '[')!;
		const tableName = header.find(span => span.text === 'package')!;
		expect(tableName.fg.equals(parseColor(theme.syntax.type))).toBe(true);
		expect((tableName.attributes & TextAttributes.BOLD) !== 0).toBe(true);
		expect(bracket.fg.equals(parseColor(theme.jsonTokens.punct))).toBe(true);

		const keyValue = rows[1]!;
		const key = keyValue.find(span => span.text === 'name')!;
		const equals = keyValue.find(span => span.text === '=')!;
		const value = keyValue.find(span => span.text === '"ccq # not comment"')!;
		expect(key.fg.equals(parseColor(theme.jsonTokens.key))).toBe(true);
		expect(equals.fg.equals(parseColor(theme.jsonTokens.punct))).toBe(true);
		// 引号内的 # 不是注释起点：整段保持字符串色，且不得被 DIM 弱化。
		expect(value.fg.equals(parseColor(theme.jsonTokens.string))).toBe(true);
		expect((value.attributes & TextAttributes.DIM) === 0).toBe(true);
		// 真正的注释必须弱化（muted + DIM）。
		const comment = keyValue.find(span => span.text === '# real comment')!;
		expect(comment.fg.equals(parseColor(colors.muted))).toBe(true);
		expect((comment.attributes & TextAttributes.DIM) !== 0).toBe(true);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
