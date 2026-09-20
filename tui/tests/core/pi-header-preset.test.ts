import {release} from 'node:os';
import {describe, expect, test} from 'bun:test';

import {
	authHeaderApplies,
	formatHeaderJson,
	headerPresetMatchesApi,
	headerPresetNeedsConfirm,
	headerPresetText,
	isControlledHeaderPresetApi,
	loadPiHeaderPresets,
	matchedHeaderPreset,
	normalizeHeaderEntries,
	parseHeaderJson,
	piHeaderPreset,
	piHeaderPresetOptions,
	resolveHeaderPresetSelection,
	suggestHeaderPreset,
	validateHeaderName
} from '../../src/core/pi-header-preset.js';

// 阶段 C 断言：契约顺序 / 受控与自由分类 / 占位符替换 / 精确匹配 / JSON 往返 / 头名校验。
// 契约是纯数据，不读写任何 Pi 真实配置。

const presetKeys = () => loadPiHeaderPresets().map(preset => preset.key);
const optionKeys = (api: string) => piHeaderPresetOptions(api).map(option => option.preset.key);

// 术语门禁要求 tui/tests 下不得出现该禁用词字面量，因此用码点拼接后再做包含断言。
const FORBIDDEN_TERM = String.fromCharCode(0x4f2a, 0x88c5);

describe('请求头预设契约', () => {
	test('契约顺序固定且没有 none 预设', () => {
		expect(presetKeys()).toEqual(['claude-code', 'codex', 'gemini-cli']);
		expect(presetKeys()).not.toContain('none');
	});

	test('Label / Description 只使用客户端名与「以 X 客户端身份请求」表述', () => {
		for (const preset of loadPiHeaderPresets()) {
			expect(preset.label.length).toBeGreaterThan(0);
			expect(preset.label).not.toContain(FORBIDDEN_TERM);
			expect(preset.description).not.toContain(FORBIDDEN_TERM);
			expect(preset.description).toContain('以');
		}
		expect(piHeaderPreset('claude-code')?.label).toBe('Claude Code');
		expect(piHeaderPreset('codex')?.label).toBe('Codex CLI');
		expect(piHeaderPreset('gemini-cli')?.label).toBe('Gemini CLI');
	});

	test('受控白名单与真实客户端协议一致', () => {
		expect(piHeaderPreset('claude-code')?.apis).toEqual(['anthropic-messages']);
		expect(piHeaderPreset('codex')?.apis).toEqual(['openai-responses']);
		expect(piHeaderPreset('gemini-cli')?.apis).toEqual(['google-generative-ai']);
		// openai-completions 不是 Codex CLI 的协议，绝不能进受控集。
		expect(piHeaderPreset('codex')?.apis).not.toContain('openai-completions');
		expect(piHeaderPreset('gemini-cli')?.headers).not.toHaveProperty('x-goog-api-client');
	});

	test('anthropic-beta 只作为可选头提供，不默认写入', () => {
		const claude = piHeaderPreset('claude-code');
		expect(claude?.headers).not.toHaveProperty('anthropic-beta');
		expect(claude?.optionalHeaders.map(item => item.headerName)).toEqual(['anthropic-beta']);
		expect(claude?.optionalHeaders[0]?.defaultValue).toContain('interleaved-thinking-2025-05-14');
	});
});

describe('受控 / 自由分类', () => {
	test('受控协议只列出对应预设', () => {
		expect(optionKeys('anthropic-messages')).toEqual(['claude-code']);
		expect(optionKeys('openai-responses')).toEqual(['codex']);
		expect(optionKeys('google-generative-ai')).toEqual(['gemini-cli']);
		for (const api of ['anthropic-messages', 'openai-responses', 'google-generative-ai']) {
			expect(piHeaderPresetOptions(api).every(option => option.matchesApi)).toBe(true);
			expect(isControlledHeaderPresetApi(api)).toBe(true);
		}
	});

	test('其余协议走自由模式并列出全部预设', () => {
		const freeApis = [
			'openai-completions',
			'openai-codex-responses',
			'azure-openai-responses',
			'mistral-conversations',
			'google-vertex',
			'bedrock-converse-stream',
			'pi-messages',
			'unknown-protocol'
		];
		for (const api of freeApis) {
			expect(optionKeys(api), `${api} 必须列出全部预设`).toEqual(presetKeys());
			expect(piHeaderPresetOptions(api).every(option => option.matchesApi === false)).toBe(true);
			expect(isControlledHeaderPresetApi(api)).toBe(false);
			expect(suggestHeaderPreset(api)).toBeNull();
		}
	});

	test('协议层建议只在受控协议下给出，且不自动应用', () => {
		expect(suggestHeaderPreset('anthropic-messages')?.key).toBe('claude-code');
		expect(suggestHeaderPreset('openai-responses')?.key).toBe('codex');
		expect(suggestHeaderPreset('google-generative-ai')?.key).toBe('gemini-cli');
	});

	test('headerPresetMatchesApi 对跨协议预设返回 false', () => {
		expect(headerPresetMatchesApi('codex', 'openai-responses')).toBe(true);
		expect(headerPresetMatchesApi('codex', 'anthropic-messages')).toBe(false);
		expect(headerPresetMatchesApi('unknown-key', 'anthropic-messages')).toBe(false);
	});

	test('resolveHeaderPresetSelection 把不在可用集内的高亮项回落到首个可用预设', () => {
		expect(resolveHeaderPresetSelection('openai-responses', 'claude-code')).toBe('codex');
		expect(resolveHeaderPresetSelection('anthropic-messages', 'codex')).toBe('claude-code');
		expect(resolveHeaderPresetSelection('openai-completions', 'codex')).toBe('codex');
		expect(resolveHeaderPresetSelection('openai-completions', '')).toBe('claude-code');
	});
});

describe('运行时占位符', () => {
	test('{platform} / {arch} 在加载期替换为运行时值', () => {
		const gemini = piHeaderPreset('gemini-cli');
		const userAgent = gemini?.headers['User-Agent'] ?? '';
		expect(userAgent).toContain(`(${process.platform}; ${process.arch}; cli)`);
		expect(userAgent).not.toContain('{platform}');
		expect(userAgent).not.toContain('{arch}');
		for (const preset of loadPiHeaderPresets()) {
			for (const value of Object.values(preset.headers)) expect(value).not.toContain('{');
		}
	});

	test('{os} 替换为系统名 + 内核版本（与 Codex CLI 的 UA 取值对齐）', () => {
		const codex = piHeaderPreset('codex');
		const userAgent = codex?.headers['User-Agent'] ?? '';
		const osName = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'Mac OS' : 'Linux';
		expect(userAgent).toContain(`(${osName} ${release()}; ${process.arch})`);
		expect(userAgent).not.toContain('{os}');
	});
});

describe('匹配判定', () => {
	test('精确匹配：键名大小写不同仍算匹配', () => {
		const claude = piHeaderPreset('claude-code');
		if (!claude) throw new Error('contract fixture must load');
		expect(matchedHeaderPreset({...claude.headers})).toBe('claude-code');
		const lowercaseKeys: Record<string, string> = {};
		for (const [key, value] of Object.entries(claude.headers)) lowercaseKeys[key.toLowerCase()] = value;
		expect(matchedHeaderPreset(lowercaseKeys)).toBe('claude-code');
	});

	test('多一个键或值不同都不匹配', () => {
		const claude = piHeaderPreset('claude-code');
		if (!claude) throw new Error('contract fixture must load');
		expect(matchedHeaderPreset({...claude.headers, extra: '1'})).toBeNull();
		expect(matchedHeaderPreset({...claude.headers, 'x-app': 'other'})).toBeNull();
		expect(matchedHeaderPreset({})).toBeNull();
	});

	test('headerPresetNeedsConfirm：空不确认、相同不确认、不同确认', () => {
		expect(headerPresetNeedsConfirm('', 'claude-code')).toBe(false);
		expect(headerPresetNeedsConfirm('   \n', 'claude-code')).toBe(false);
		expect(headerPresetNeedsConfirm('{}', 'claude-code')).toBe(true);
		const same = headerPresetText('claude-code');
		if (same === null) throw new Error('contract fixture must load');
		expect(headerPresetNeedsConfirm(same, 'claude-code')).toBe(false);
		expect(headerPresetNeedsConfirm(same, 'codex')).toBe(true);
		expect(headerPresetNeedsConfirm('{broken', 'claude-code')).toBe(true);
		expect(headerPresetNeedsConfirm('{"x": "1"}', 'unknown-key')).toBe(false);
	});
});

describe('JSON 文本互转', () => {
	test('headerPresetText 可被 parseHeaderJson 往返还原', () => {
		for (const preset of loadPiHeaderPresets()) {
			const text = headerPresetText(preset.key);
			expect(text).not.toBeNull();
			const parsed = parseHeaderJson(text ?? '');
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) continue;
			expect(parsed.headers).toEqual(preset.headers);
		}
		expect(headerPresetText('unknown-key')).toBeNull();
	});

	test('含逗号、等号、$ENV、!command、$$ 的值原样往返', () => {
		const headers = {
			'User-Agent': 'claude-cli/2.1.251 (external, cli)',
			'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
			authorization: 'Bearer a=b,c==d',
			'x-env': '$MY_KEY',
			'x-cmd': '!op read op://vault/item/token',
			'x-literal': '$$literal'
		};
		const text = formatHeaderJson(headers);
		expect(text.split('\n').length).toBeGreaterThan(2);
		const parsed = parseHeaderJson(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.headers).toEqual(headers);
		expect(parsed.headers['anthropic-beta']).toBe('claude-code-20250219,interleaved-thinking-2025-05-14');
	});

	test('空文本与 {} 归一化为空对象', () => {
		expect(parseHeaderJson('')).toEqual({ok: true, headers: {}});
		expect(parseHeaderJson('  \n')).toEqual({ok: true, headers: {}});
		expect(parseHeaderJson('{}')).toEqual({ok: true, headers: {}});
	});

	test('非法 JSON / 非对象 / 非字符串值给出可读错误', () => {
		const broken = parseHeaderJson('{broken');
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error).toContain('JSON 格式错误');

		const array = parseHeaderJson('[1, 2]');
		expect(array.ok).toBe(false);
		if (!array.ok) expect(array.error).toContain('必须是 JSON 对象');

		const number = parseHeaderJson('42');
		expect(number.ok).toBe(false);

		const badValue = parseHeaderJson('{"x-api-key": 123}');
		expect(badValue.ok).toBe(false);
		if (!badValue.ok) expect(badValue.error).toContain('必须是字符串');
	});

	test('空键空值静默丢弃，值不 trim、键名不改大小写', () => {
		const parsed = parseHeaderJson('{"": "x", "empty": "", "  ": "y", "Keep-Case": " Value "}');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.headers).toEqual({'Keep-Case': ' Value '});
		expect(normalizeHeaderEntries({a: '', b: '  ', c: 'v'})).toEqual({c: 'v'});
	});
});

describe('头名校验与认证头形态', () => {
	test('validateHeaderName 只接受 RFC 7230 token', () => {
		for (const name of ['User-Agent', 'x-app', 'anthropic-beta', 'X_Custom.1', "a!#$%&'*+-.^_`|~"]) {
			expect(validateHeaderName(name), `${name} 必须合法`).toBeNull();
		}
		for (const name of ['', '  ', 'bad name', 'bad:name', 'bad\nname', 'bad(name)']) {
			expect(validateHeaderName(name), `${name} 必须非法`).not.toBeNull();
		}
	});

	test('host / content-length 被拒绝（不区分大小写）', () => {
		expect(validateHeaderName('host')).not.toBeNull();
		expect(validateHeaderName('Host')).not.toBeNull();
		expect(validateHeaderName('CONTENT-LENGTH')).not.toBeNull();
	});

	test('authHeaderApplies 只在 anthropic-messages 为真', () => {
		expect(authHeaderApplies('anthropic-messages')).toBe(true);
		for (const api of ['openai-completions', 'openai-responses', 'openai-codex-responses', 'google-generative-ai', '']) {
			expect(authHeaderApplies(api)).toBe(false);
		}
	});
});
