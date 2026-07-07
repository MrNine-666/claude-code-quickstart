import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
	atomicWrite,
	deletePath,
	formatTomlError,
	getPath,
	parse,
	redactTomlSecrets,
	setPath,
	stringify,
	TomlEditError
} from '../src/core/toml-edit.ts';

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

const parsed = parse(sample);
assert.equal(getPath(parsed, ['model']), 'gpt-5');
assert.equal(getPath(parsed, ['model_providers', 'openai', 'base_url']), 'https://api.openai.com/v1');
assert.equal(getPath(parsed, ['missing', 'path']), undefined);

const withProvider = setPath(parsed, ['model_provider'], 'deepseek');
assert.equal(getPath(withProvider, ['model_provider']), 'deepseek');
assert.equal(getPath(parsed, ['model_provider']), 'openai', 'setPath 不应原地修改输入对象');
assert.equal(getPath(withProvider, ['mcp_servers', 'context7', 'command']), 'npx', '无关 MCP table 应保留');
assert.equal(getPath(withProvider, ['hooks', 'enabled']), true, '无关 hooks table 应保留');

const repeated = setPath(withProvider, ['model_provider'], 'deepseek');
assert.deepEqual(repeated, withProvider, '相同 path/value 重复 set 应保持结构幂等');

const added = setPath(parsed, ['model_providers', 'deepseek', 'experimental_bearer_token'], 'sk-new-secret');
assert.equal(getPath(added, ['model_providers', 'deepseek', 'experimental_bearer_token']), 'sk-new-secret');
assert.equal(getPath(added, ['model_providers', 'openai', 'name']), 'openai', '新增 provider 不应破坏既有 provider table');

const removed = deletePath(added, ['model_providers', 'deepseek', 'experimental_bearer_token']);
assert.equal(getPath(removed, ['model_providers', 'deepseek', 'experimental_bearer_token']), undefined);
assert.equal(getPath(removed, ['model_providers', 'openai', 'base_url']), 'https://api.openai.com/v1');
assert.deepEqual(deletePath(removed, ['not', 'there']), removed, '删除不存在 path 应幂等');

const roundTrip = parse(stringify(added));
assert.equal(getPath(roundTrip, ['model_providers', 'deepseek', 'experimental_bearer_token']), 'sk-new-secret');
assert.equal(getPath(roundTrip, ['mcp_servers', 'context7', 'args', '0']), undefined, '数组不应被误当作 path table');
assert.deepEqual(getPath(roundTrip, ['mcp_servers', 'context7', 'args']), ['-y', '@upstash/context7-mcp']);

assert.throws(
	() => parse('model = "ok"\nmodel = "duplicate"\n'),
	(error) => error instanceof TomlEditError && !String(error.message).includes('sk-'),
	'无效 TOML 必须拒绝解析且错误文本不应泄漏敏感值'
);
assert.throws(
	() => setPath({model: 'gpt-5'}, ['model', 'nested'], true),
	/非 table 节点/,
	'禁止在非 table 节点下写入嵌套 path'
);

const redactedToml = redactTomlSecrets('experimental_bearer_token = "sk-sensitive-123456"\nbase_url = "https://safe.example"');
assert.ok(!redactedToml.includes('sk-sensitive-123456'));
assert.ok(redactedToml.includes('[REDACTED]'));
assert.ok(redactedToml.includes('https://safe.example'));

const formattedError = formatTomlError(new Error('failed with experimental_bearer_token = "sk-sensitive-abcdef123456"'));
assert.ok(!formattedError.includes('sk-sensitive-abcdef123456'));
assert.ok(formattedError.includes('[REDACTED]'));

const tempDir = mkdtempSync(join(tmpdir(), 'ccq-toml-edit-'));
try {
	const target = join(tempDir, 'config.toml');
	atomicWrite(target, added);
	assert.equal(existsSync(target), true);
	const written = parse(readFileSync(target, 'utf8'));
	assert.equal(getPath(written, ['model_providers', 'deepseek', 'experimental_bearer_token']), 'sk-new-secret');

	assert.throws(() => atomicWrite(target, {bad: () => null}), /序列化失败/, '不可序列化值不得写入目标文件');
	const afterFailedWrite = parse(readFileSync(target, 'utf8'));
	assert.equal(getPath(afterFailedWrite, ['model_providers', 'deepseek', 'experimental_bearer_token']), 'sk-new-secret');
} finally {
	rmSync(tempDir, {recursive: true, force: true});
}

const tuiRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJson = readFileSync(join(tuiRoot, 'package.json'), 'utf8');
assert.ok(packageJson.includes('scripts/verify-toml-edit.mjs'), 'verify 聚合必须包含 TOML 工具层门禁');

function listSourceFiles(dir) {
	const results = [];
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			results.push(...listSourceFiles(fullPath));
		} else if (/\.(ts|tsx)$/.test(entry)) {
			results.push(fullPath);
		}
	}

	return results;
}

const directSmolTomlImports = listSourceFiles(join(tuiRoot, 'src'))
	.map((filePath) => ({filePath, relativePath: relative(tuiRoot, filePath).replaceAll('\\', '/')}))
	.filter(({relativePath}) => relativePath !== 'src/core/toml-edit.ts')
	.filter(({filePath}) => readFileSync(filePath, 'utf8').includes('smol-toml'))
	.map(({relativePath}) => relativePath);
assert.deepEqual(directSmolTomlImports, [], '生产代码必须通过 core/toml-edit.ts 统一读写 TOML');

console.log('[PASS] TOML 结构化编辑：parse/stringify + path get/set/delete + 原子写 + 错误脱敏 + 统一入口');
