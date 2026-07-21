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
