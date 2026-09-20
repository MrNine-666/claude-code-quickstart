import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {atomicWrite, getPath, parse, setPath} from '../src/core/toml-edit.ts';

// [P5b 迁走] parse/stringify + path get/set/delete 与错误脱敏（23 条静态断言）
// → tests/core/toml-edit.test.ts。
// 本文件保留真实 fs 段（atomicWrite 落盘 + 序列化失败保留旧目标）与静态契约段
// （package.json verify 链自引用 + src 不得直接 import smol-toml 的统一入口不变量）。

// 真实原子写断言所需的最小 TOML document（纯语义断言已迁 tests/core/toml-edit.test.ts）。
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
const added = setPath(parsed, ['model_providers', 'deepseek', 'experimental_bearer_token'], 'sk-new-secret');

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

console.log('[PASS] TOML 原子写 + 序列化失败保留旧目标 + 统一入口契约');
