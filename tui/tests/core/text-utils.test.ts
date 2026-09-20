import {describe, expect, test} from 'bun:test';
import {displayWidth, maskApiKey, normalizeBaseUrl, truncateToWidth} from '../../src/core/text-utils.js';

describe('text utilities', () => {
	test('normalizes and masks provider values', () => {
		expect(normalizeBaseUrl(' https://api.example.com/// ')).toBe('https://api.example.com');
		expect(maskApiKey('abcd1234ef')).toBe('abcd...ef');
		expect(maskApiKey('short')).toBe('***');
	});

	test('truncates without splitting full-width terminal cells', () => {
		expect(displayWidth('A中B')).toBe(4);
		expect(truncateToWidth('A中文B', 5)).toBe('A中…');
		expect(displayWidth(truncateToWidth('A中文B', 5))).toBeLessThanOrEqual(5);
	});
});

// P5d 迁移自 scripts/verify-layout-utils.mjs（9 条静态断言，整体迁移，脚本删除）。
// 判据：truncateToWidth / displayWidth 为纯函数（无 fs / 子进程 / 渲染）。
// 原脚本的 CJK 安全 + 宽度有界断言与 PBT 一并落在本模块既有载体 text-utils.test.ts（R9 不另建文件）。
describe('truncateToWidth / displayWidth CJK 安全 + 宽度有界（PBT）', () => {
	test('displayWidth 宽度：ASCII / CJK / 混合', () => {
		expect(displayWidth('abc'), 'ASCII 宽度 1').toBe(3);
		expect(displayWidth('中文'), 'CJK 全角宽度 2').toBe(4);
		expect(displayWidth('a中b'), '混合宽度').toBe(4);
	});

	test('不超宽不截断', () => {
		expect(truncateToWidth('hello', 10), '短文本原样').toBe('hello');
	});

	test('超宽截断加省略号，结果显示宽度不超 max', () => {
		const t1 = truncateToWidth('abcdefghij', 5);
		expect(t1.endsWith('…'), '超宽加省略号').toBe(true);
		expect(displayWidth(t1) <= 5, `截断后宽度 ${displayWidth(t1)} 不超 5`).toBe(true);
	});

	test('CJK 截断不切半个字、宽度有界', () => {
		const t2 = truncateToWidth('一二三四五六', 5);
		expect(t2.endsWith('…'), 'CJK 超宽加省略号').toBe(true);
		expect(displayWidth(t2) <= 5, `CJK 截断宽度 ${displayWidth(t2)} 不超 5`).toBe(true);
	});

	test('PBT：任意文本截断后显示宽度恒 <= max', () => {
		const samples = ['', 'a', '中', 'mix混合text', 'http://example.com/very/long/path', '一二三四五六七八九十'];
		for (let maxWidth = 1; maxWidth <= 20; maxWidth++) {
			for (const sample of samples) {
				const out = truncateToWidth(sample, maxWidth);
				expect(displayWidth(out) <= maxWidth, `截断违例: "${sample}" max=${maxWidth} → "${out}" 宽=${displayWidth(out)}`).toBe(
					true
				);
			}
		}
	});
});
