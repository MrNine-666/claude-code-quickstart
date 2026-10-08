import {expect, test} from 'bun:test';
import {mergeProviderEnvOnSave, stripProviderEnvFromText} from '../../src/core/config-recommend.js';

test('Claude Config 普通编辑保留 provider-owned env', () => {
	const original = JSON.stringify({model: 'keep-model', env: {ANTHROPIC_AUTH_TOKEN: 'sk-secret', KEEP: 'yes'}, language: '简体中文'});
	const visible = stripProviderEnvFromText(original);
	expect(visible.ok).toBe(true);
	if (!visible.ok) return;
	expect(visible.text).not.toContain('ANTHROPIC_AUTH_TOKEN');
	const merged = mergeProviderEnvOnSave(visible.text, original);
	expect(merged.ok).toBe(true);
	if (!merged.ok) return;
	const result = JSON.parse(merged.text);
	expect(result.model).toBe('keep-model');
	expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret');
	expect(result.env.KEEP).toBe('yes');
});

test('Claude Config 普通编辑允许编辑其余字段', () => {
	const result = mergeProviderEnvOnSave('{"language":"en","hooks":{"Stop":[]}}', '{"language":"简体中文"}');
	expect(result.ok).toBe(true);
	if (result.ok) expect(JSON.parse(result.text)).toEqual({language: 'en', hooks: {Stop: []}});
});
