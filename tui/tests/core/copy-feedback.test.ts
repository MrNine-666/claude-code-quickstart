import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import type {CliRenderer} from '@opentui/core';
import {handleTextareaEditKeys} from '../../src/components/editor/textarea-edit-keys.js';
import {getToastSnapshot, resetToasts} from '../../src/components/toast-store.js';
import {copyTextWithFeedback} from '../../src/utils/copy-feedback.js';

// 迁自 scripts/verify-copy-feedback.mjs 的源码正则段（P1-G1 后半 A 类）。
// 复制反馈统一入口（copy-feedback.ts 头注释的 HC-COPY-FEEDBACK）:
//   → copy-on-select（index.tsx）与编辑态 Cmd/Ctrl+C（textarea-edit-keys）都必须经
//     copyTextWithFeedback；入口内联 call site 的静态不变量留在 verify-view-architecture.mjs。

type FakeRenderer = {
	calls: string[];
	renderer: CliRenderer;
};

function fakeRenderer(options: {supported?: boolean; ok?: boolean} = {}): FakeRenderer {
	const calls: string[] = [];
	const renderer = {
		isOsc52Supported: () => options.supported ?? true,
		copyToClipboardOSC52: (text: string) => {
			calls.push(text);
			return options.ok ?? true;
		}
	};
	return {calls, renderer: renderer as unknown as CliRenderer};
}

// 编辑态复制使用 isEditingModifier：macOS 看 super，其余平台看 ctrl；两个都置位以覆盖两平台。
const editCopyEvent = {name: 'c', ctrl: true, super: true};

// 不依赖 --parallel 的文件隔离：单进程整包跑测试时其他文件可能已往模块级 toast store 推入条目。
beforeEach(() => {
	resetToasts();
});

afterEach(() => {
	resetToasts();
});

describe('copyTextWithFeedback 统一入口', () => {
	test('终端支持 OSC52 时必须走 OSC52 复制并弹「已复制到剪贴板」toast', () => {
		const {calls, renderer} = fakeRenderer();
		expect(copyTextWithFeedback(renderer, 'hello')).toBe(true);
		expect(calls).toEqual(['hello']);
		expect(getToastSnapshot()).toHaveLength(1);
		expect(getToastSnapshot()[0]?.type).toBe('success');
		expect(getToastSnapshot()[0]?.message).toBe('已复制到剪贴板');
	});

	test('终端不支持 OSC52 时静默跳过：不复制、不弹 toast', () => {
		const {calls, renderer} = fakeRenderer({supported: false});
		expect(copyTextWithFeedback(renderer, 'hello')).toBe(false);
		expect(calls).toEqual([]);
		expect(getToastSnapshot()).toEqual([]);
	});

	test('空文本静默跳过：即使终端支持也不复制、不弹 toast', () => {
		const {calls, renderer} = fakeRenderer();
		expect(copyTextWithFeedback(renderer, '')).toBe(false);
		expect(calls).toEqual([]);
		expect(getToastSnapshot()).toEqual([]);
	});

	test('无 renderer 时静默跳过，不抛错', () => {
		expect(copyTextWithFeedback(null, 'hello')).toBe(false);
		expect(getToastSnapshot()).toEqual([]);
	});

	test('OSC52 写入失败时返回 false 且不弹成功 toast', () => {
		const {calls, renderer} = fakeRenderer({ok: false});
		expect(copyTextWithFeedback(renderer, 'hello')).toBe(false);
		expect(calls).toEqual(['hello']);
		expect(getToastSnapshot()).toEqual([]);
	});
});

describe('textarea-edit-keys 编辑态复制', () => {
	function fakeTextarea(selectedText: string | null) {
		return {
			hasSelection: () => selectedText !== null,
			getSelectedText: () => selectedText ?? ''
		};
	}

	test('编辑态 Cmd/Ctrl+C 选中文本必须经 copyTextWithFeedback 复制并弹 toast（不得裸调 OSC52）', () => {
		const {calls, renderer} = fakeRenderer();
		const handled = handleTextareaEditKeys(editCopyEvent, fakeTextarea('selected') as never, renderer, () => {});
		expect(handled).toBe(true);
		expect(calls).toEqual(['selected']);
		// 裸调 renderer.copyToClipboardOSC52 不会弹 toast；有 toast 才证明经过统一入口。
		expect(getToastSnapshot().map(entry => entry.message)).toEqual(['已复制到剪贴板']);
	});

	test('编辑态 Cmd/Ctrl+C 无选中文本时静默跳过，不发起任何复制', () => {
		const {calls, renderer} = fakeRenderer();
		const handled = handleTextareaEditKeys(editCopyEvent, fakeTextarea(null) as never, renderer, () => {});
		expect(handled).toBe(true);
		expect(calls).toEqual([]);
		expect(getToastSnapshot()).toEqual([]);
	});
});
