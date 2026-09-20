import {expect, test} from 'bun:test';

import {
	deletePath,
	formatTomlError,
	getPath,
	parse,
	redactTomlSecrets,
	setPath,
	stringify,
	TomlEditError
} from '../../src/core/toml-edit.js';

// P5b 迁移自 scripts/verify-toml-edit.mjs 的纯段（23 条静态断言）：
//   - parse/stringify + path get/set/delete（14）
//   - 错误脱敏：redactTomlSecrets / formatTomlError / 解析错误不含敏感值（7）
//   - 非 table 节点嵌套写拒绝（2）
// 真实 fs 段（atomicWrite 落盘 + 序列化失败保留旧目标 4）与静态契约段（package.json verify 链
// 自引用 + src 不得直接 import smol-toml 的统一入口不变量 2）仍留在 scripts/verify-toml-edit.mjs。

const sample = `
model = "gpt-5"
model_provider = "openai"

[model_providers.openai]
name = "openai"
base_url = "https://api.openai.com/v1"
experimental_bearer_token = "sk-existing-secret"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[hooks]
enabled = true
`;

test('TOML parse + path get/set/delete 保持结构语义', () => {
	const parsed = parse(sample);
	expect(getPath(parsed, ['model'])).toBe('gpt-5');
	expect(getPath(parsed, ['model_providers', 'openai', 'base_url'])).toBe('https://api.openai.com/v1');
	expect(getPath(parsed, ['missing', 'path'])).toBeUndefined();

	const withProvider = setPath(parsed, ['model_provider'], 'deepseek');
	expect(getPath(withProvider, ['model_provider'])).toBe('deepseek');
	expect(getPath(parsed, ['model_provider']), 'setPath 不应原地修改输入对象').toBe('openai');
	expect(getPath(withProvider, ['mcp_servers', 'context7', 'command']), '无关 MCP table 应保留').toBe('npx');
	expect(getPath(withProvider, ['hooks', 'enabled']), '无关 hooks table 应保留').toBe(true);

	const repeated = setPath(withProvider, ['model_provider'], 'deepseek');
	expect(repeated, '相同 path/value 重复 set 应保持结构幂等').toEqual(withProvider);

	const added = setPath(parsed, ['model_providers', 'deepseek', 'experimental_bearer_token'], 'sk-new-secret');
	expect(getPath(added, ['model_providers', 'deepseek', 'experimental_bearer_token'])).toBe('sk-new-secret');
	expect(getPath(added, ['model_providers', 'openai', 'name']), '新增 provider 不应破坏既有 provider table').toBe('openai');

	const removed = deletePath(added, ['model_providers', 'deepseek', 'experimental_bearer_token']);
	expect(getPath(removed, ['model_providers', 'deepseek', 'experimental_bearer_token'])).toBeUndefined();
	expect(getPath(removed, ['model_providers', 'openai', 'base_url'])).toBe('https://api.openai.com/v1');
	expect(deletePath(removed, ['not', 'there']), '删除不存在 path 应幂等').toEqual(removed);

	const roundTrip = parse(stringify(added));
	expect(getPath(roundTrip, ['model_providers', 'deepseek', 'experimental_bearer_token'])).toBe('sk-new-secret');
	expect(getPath(roundTrip, ['mcp_servers', 'context7', 'args', '0']), '数组不应被误当作 path table').toBeUndefined();
	expect(getPath(roundTrip, ['mcp_servers', 'context7', 'args'])).toEqual(['-y', '@upstash/context7-mcp']);
});

test('无效 TOML 必须拒绝解析且错误文本不应泄漏敏感值', () => {
	let thrown: unknown;
	try {
		parse('model = "ok"\nmodel = "duplicate"\n');
	} catch (error) {
		thrown = error;
	}
	expect(
		thrown instanceof TomlEditError && !String((thrown as Error).message).includes('sk-'),
		'无效 TOML 必须拒绝解析且错误文本不应泄漏敏感值'
	).toBe(true);
});

test('禁止在非 table 节点下写入嵌套 path', () => {
	expect(() => setPath({model: 'gpt-5'}, ['model', 'nested'], true), '禁止在非 table 节点下写入嵌套 path').toThrow(/非 table 节点/);
});

test('错误脱敏：redactTomlSecrets 与 formatTomlError', () => {
	const redactedToml = redactTomlSecrets('experimental_bearer_token = "sk-sensitive-123456"\nbase_url = "https://safe.example"');
	expect(!redactedToml.includes('sk-sensitive-123456')).toBe(true);
	expect(redactedToml.includes('[REDACTED]')).toBe(true);
	expect(redactedToml.includes('https://safe.example')).toBe(true);

	const formattedError = formatTomlError(new Error('failed with experimental_bearer_token = "sk-sensitive-abcdef123456"'));
	expect(!formattedError.includes('sk-sensitive-abcdef123456')).toBe(true);
	expect(formattedError.includes('[REDACTED]')).toBe(true);
});
