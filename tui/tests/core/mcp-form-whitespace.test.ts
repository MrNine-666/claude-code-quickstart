import {expect, test} from 'bun:test';
import {parseMcpFormInput, parseMcpJsonFormat} from '../../src/core/mcp-form.js';

const config = {
	type: 'http',
	url: 'https://example.com/mcp',
	headers: {Authorization: 'Bearer TEST_TOKEN'}
};

test('MCP 实时校验与保存接受粘贴缩进中的 Unicode 空格', () => {
	for (const space of ['\u00a0', '\u1680', '\u2000', '\u2007', '\u200a', '\u202f', '\u205f', '\u3000', '\ufeff']) {
		const json = `${space}${JSON.stringify(config, null, 2)
			.replace(/^ +/gm, indent => space.repeat(indent.length))
			.replaceAll(': ', `:${space}`)}${space}`;
		expect(parseMcpJsonFormat(json)).toEqual({ok: true, value: config});
		expect(parseMcpFormInput('processon', json)).toEqual({ok: true, payload: {serverId: 'processon', config}});
		expect(parseMcpFormInput('processon', json, true)).toEqual({ok: true, payload: {serverId: 'processon', config}});
	}
});

test('MCP 保留字符串内的 Unicode 空格、转义引号和反斜杠', () => {
	const raw = {
		...config,
		headers: {Authorization: 'Bearer\u00a0TEST\u202fTOKEN'},
		'key\u00a0name': 'quote "\u00a0 and slash \\ ending \\',
		description: '\u3000\ufeff'
	};
	const pasted = JSON.stringify(raw, null, 2).replace(/^ +/gm, indent => '\u00a0'.repeat(indent.length));
	expect(parseMcpJsonFormat(pasted)).toEqual({ok: true, value: raw});
	expect(parseMcpFormInput('processon', pasted)).toEqual({ok: true, payload: {serverId: 'processon', config: raw}});
});

test('MCP 仍拒绝真实语法错误且诊断不泄露 Token', () => {
	for (const json of [
		'{"url":"https://example.com/mcp",}',
		'{"headers":{"Authorization":"Bearer TEST_TOKEN\n"}}',
		'{"headers":{"Authorization":"Bearer TEST_TOKEN}',
		'{"type":h\u00a0ttp}',
		'{\u200b"type":"http"}'
	]) {
		expect(parseMcpJsonFormat(json)).toEqual({ok: false, error: 'JSON 格式错误，请检查配置语法'});
	}
	for (const json of ['[]', 'null', '"text"']) {
		expect(parseMcpJsonFormat(json)).toEqual({ok: false, error: '配置必须是 JSON 对象'});
	}
});
