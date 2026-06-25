import assert from 'node:assert/strict';
import {truncateToWidth, displayWidth} from '../src/core/text-utils.ts';

// Phase 9 纯函数门禁：CJK 安全截断。

// ── truncateToWidth / displayWidth ───────────────────────────────────────────
{
	assert.equal(displayWidth('abc'), 3, 'ASCII 宽度 1');
	assert.equal(displayWidth('中文'), 4, 'CJK 全角宽度 2');
	assert.equal(displayWidth('a中b'), 4, '混合宽度');

	// 不超宽不截断
	assert.equal(truncateToWidth('hello', 10), 'hello', '短文本原样');
	// 超宽截断加省略号，结果显示宽度不超 max
	const t1 = truncateToWidth('abcdefghij', 5);
	assert.ok(t1.endsWith('…'), '超宽加省略号');
	assert.ok(displayWidth(t1) <= 5, `截断后宽度 ${displayWidth(t1)} 不超 5`);

	// CJK 截断不切半个字、宽度有界
	const t2 = truncateToWidth('一二三四五六', 5);
	assert.ok(t2.endsWith('…'), 'CJK 超宽加省略号');
	assert.ok(displayWidth(t2) <= 5, `CJK 截断宽度 ${displayWidth(t2)} 不超 5`);

	// PBT：任意文本截断后显示宽度恒 <= max
	const samples = ['', 'a', '中', 'mix混合text', 'http://example.com/very/long/path', '一二三四五六七八九十'];
	for (let maxWidth = 1; maxWidth <= 20; maxWidth++) {
		for (const sample of samples) {
			const out = truncateToWidth(sample, maxWidth);
			assert.ok(displayWidth(out) <= maxWidth, `截断违例: "${sample}" max=${maxWidth} → "${out}" 宽=${displayWidth(out)}`);
		}
	}

	console.log('[PASS] truncateToWidth / displayWidth：CJK 安全 + 宽度有界（PBT）');
}

console.log('[PASS] Phase 9 截断纯函数门禁通过');
