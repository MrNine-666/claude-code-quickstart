import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {mergeProviderEnvOnSave} from '../../src/core/config-recommend.js';
import {parseEditableJson} from '../../src/core/editable-json.js';
import {readJsonFileStrict} from '../../src/core/fs-utils.js';
import {applyPiConfigFillMissing} from '../../src/core/pi-config.js';
import {parseHeaderJson} from '../../src/core/pi-header-preset.js';
import {type ProviderFormValues, valuesFromProviderProfileJson} from '../../src/core/provider-form.js';

const spaces = ['\u00a0', '\u1680', '\u2000', '\u2007', '\u200a', '\u202f', '\u205f', '\u3000', '\ufeff'];

function pasted(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/^ +/gm, indent => '\u00a0'.repeat(indent.length));
}

test('共享解析只规整字符串外的 Unicode 空格并返回合法保存文本', () => {
	const value = {'key\u00a0name': 'Bearer\u00a0TOKEN\u202fquoted " and slash \\', nested: ['\u3000\ufeff', 1, true, null]};
	const raw = JSON.stringify(value);
	for (const space of spaces) {
		const result = parseEditableJson(`${space}${pasted(value)}${space}`);
		expect(result.value).toEqual(value);
		expect(JSON.parse(result.text)).toEqual(value);
		expect(result.text).toContain(raw.slice(raw.indexOf('"Bearer'), raw.indexOf(',"nested')));
	}
	expect(parseEditableJson(raw)).toEqual({value, text: raw});
});

test('共享语法解析保留数组与原始值，由调用方校验 schema', () => {
	for (const text of ['[]', 'null', 'true', '123', '"text"']) {
		expect(parseEditableJson(text).value).toEqual(JSON.parse(text));
	}
});

test('真实语法错误仍失败，异常不回显输入秘密', () => {
	for (const text of ['{"key":"SECRET_TOKEN\n"}', '{"key":"SECRET_TOKEN}', '{"key":"SECRET_TOKEN",}', '{\u200b"key":1}']) {
		expect(() => parseEditableJson(text)).toThrow('JSON 格式错误，请检查配置语法');
		try {
			parseEditableJson(text);
		} catch (error) {
			expect(String(error)).not.toContain('SECRET_TOKEN');
		}
	}
});

test('Claude 供应商 JSON 表单复用共享解析', () => {
	const base: ProviderFormValues = {profileKey: 'test', baseUrl: '', apiKey: '', modelEnv: {}, env: {}, activateAfterSave: false};
	const result = valuesFromProviderProfileJson(
		base,
		pasted({env: {ANTHROPIC_AUTH_TOKEN: 'TEST\u00a0TOKEN', ANTHROPIC_BASE_URL: 'https://example.com'}})
	);
	expect(result.ok).toBe(true);
	if (result.ok) {
		expect(result.values.apiKey).toBe('TEST\u00a0TOKEN');
		expect(result.values.baseUrl).toBe('https://example.com');
	}
});

test('Pi 请求头表单复用共享解析，凭据内部空格不变', () => {
	const headers = {Authorization: 'Bearer TEST\u00a0TOKEN'};
	expect(parseHeaderJson(pasted(headers))).toEqual({ok: true, headers});
	expect(parseHeaderJson('{\u00a0"Authorization": 123}').ok).toBe(false);
});

test('Claude 与 Pi 配置编辑缓冲复用共享解析', () => {
	const value = {customField: 'value\u00a0unchanged'};
	const merged = mergeProviderEnvOnSave(pasted(value), null);
	expect(merged.ok).toBe(true);
	if (merged.ok) expect(JSON.parse(merged.text)).toEqual(value);
	const pi = applyPiConfigFillMissing(pasted(value));
	expect(pi.ok).toBe(true);
	if (pi.ok) expect(JSON.parse(pi.text).customField).toBe(value.customField);
});

test('磁盘配置读取继续严格解析，非法文件字节不变', () => {
	const dir = mkdtempSync(join(tmpdir(), 'ccq-editable-json-'));
	try {
		const path = join(dir, 'config.json');
		const text = '{\u00a0"key": "TEST_TOKEN"}';
		writeFileSync(path, text);
		expect(readJsonFileStrict(path)).toEqual({status: 'invalid', error: 'JSON 无法解析'});
		expect(readFileSync(path, 'utf8')).toBe(text);
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});
