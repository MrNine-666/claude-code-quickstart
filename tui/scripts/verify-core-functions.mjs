import assert from 'node:assert/strict';
import {buildMcpConfig} from '../src/core/mcp-config-builder.ts';
import {hasUpdate, parseSemver, semverCompare} from '../src/core/semver.ts';
import {buildProviderFormModel, toProviderSavePayload, validateProviderForm} from '../src/core/provider-form.ts';
import {maskApiKey, normalizeBaseUrl, testProviderKey} from '../src/core/text-utils.ts';
import {parseSkillsFindOutput} from '../src/core/skills.ts';
import {loadMcpContract} from '../src/core/mcp-contract.ts';

// Phase 2 核心纯函数回归门禁：守住 buildMcpConfig parity、semver、provider 表单、
// skills find parser、env-file 拒绝——这些是后续 Phase 视图与测试的基础不变量。

// ── semver ────────────────────────────────────────────────────────────────
assert.equal(parseSemver('1.2.3')?.major, 1);
assert.equal(parseSemver('v1.2.3')?.minor, 2);
assert.equal(parseSemver('not-a-version'), null);
assert.equal(semverCompare('1.2.3', '1.2.4'), -1);
assert.equal(semverCompare('2.0.0', '1.9.9'), 1);
assert.equal(hasUpdate('1.2.3', '1.2.3'), false);
assert.equal(hasUpdate('1.2.3', '1.3.0'), true);
assert.equal(hasUpdate('1.2.3', '2.0.0-beta'), false, 'prerelease 视为无更新');
console.log('[PASS] semver 工具');

// ── text-utils ────────────────────────────────────────────────────────────
assert.equal(maskApiKey('sk-abcdef123456'), 'sk-a...56');
assert.equal(maskApiKey('short'), '***');
assert.equal(maskApiKey(''), '-');
assert.equal(normalizeBaseUrl('https://api.x.com/'), 'https://api.x.com');
assert.equal(testProviderKey('zhipu'), true);
assert.equal(testProviderKey('../evil'), false);
console.log('[PASS] 文本/凭据工具');

// ── provider 表单 ─────────────────────────────────────────────────────────
const builtinForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'glm'});
assert.equal(builtinForm.values.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
assert.equal(builtinForm.values.modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2');
assert.deepEqual(validateProviderForm('add-builtin', {...builtinForm.values, apiKey: ''}), ['API Key 不能为空']);

const customForm = buildProviderFormModel({mode: 'add-custom'});
assert.deepEqual(validateProviderForm('add-custom', customForm.values).length > 0, true, 'custom 空 baseUrl 应报错');

const editPayload = toProviderSavePayload({mode: 'edit', profileKey: 'glm'}, {...builtinForm.values, apiKey: 'sk-test'});
assert.equal(editPayload.action, 'edit');
assert.equal(editPayload.key, 'glm');
console.log('[PASS] Provider 表单模型');

// ── buildMcpConfig parity（对齐 New-McpSettingsEntry） ─────────────────────
const contract = loadMcpContract();

// none stdio（playwright：契约中仍为 stdio/none 的代表样本）
const noneDef = contract.servers.playwright;
const noneResult = buildMcpConfig('playwright', noneDef, {});
assert.equal(noneResult.ok, true);
assert.equal(noneResult.config.command, 'npx');
assert.deepEqual(noneResult.config.args, ['-y', '@playwright/mcp@latest']);

// http/none（context7：官方 remote HTTP 默认，保留 type:http + url，无 env）
const httpDef = contract.servers.context7;
const httpResult = buildMcpConfig('context7', httpDef, {});
assert.equal(httpResult.ok, true);
assert.equal(httpResult.config.type, 'http');
assert.equal(httpResult.config.url, 'https://mcp.context7.com/mcp');
assert.equal(httpResult.config.env, undefined);

// single-key（内联 def：契约默认已改用官方 remote HTTP，single-key 走通用样本保证类型覆盖）
const singleKeyDef = {McpType: 'stdio', Command: 'npx', Args: ['-y', 'sample'], CredentialType: 'single-key', ApiKeyName: 'SAMPLE_API_KEY'};
const singleKeyResult = buildMcpConfig('sample', singleKeyDef, {SAMPLE_API_KEY: 'sk-sample-123'});
assert.equal(singleKeyResult.ok, true);
assert.deepEqual(singleKeyResult.config.env, {SAMPLE_API_KEY: 'sk-sample-123'});
assert.equal(singleKeyResult.permission, 'mcp__sample');

// url-embedded（tavily）
const tavilyDef = contract.servers.tavily;
const tavilyResult = buildMcpConfig('tavily', tavilyDef, {TAVILY_API_KEY: 'tvly-secret'});
assert.equal(tavilyResult.ok, true);
assert.equal(tavilyResult.config.type, 'http');
assert.match(tavilyResult.config.url, /tavilyApiKey=tvly-secret/);
assert.equal(tavilyResult.config.url.includes('{TAVILY_API_KEY}'), false, '占位符必须全部替换');

// args-multi（ace-tool）
const aceDef = contract.servers['ace-tool'];
const aceResult = buildMcpConfig('ace-tool', aceDef, {'--base-url': 'https://ace.x', '--token': 'tok'});
assert.equal(aceResult.ok, true);
const aceArgs = aceResult.config.args;
assert.equal(aceArgs.includes('--base-url'), true);
assert.equal(aceArgs[aceArgs.indexOf('--base-url') + 1], 'https://ace.x');

// args-token（mastergo）
const mgDef = contract.servers.mastergo;
const mgResult = buildMcpConfig('mastergo', mgDef, {token: 'mg-token'});
assert.equal(mgResult.ok, true);
assert.equal(mgResult.config.args.includes('--token=mg-token'), true);

// 缺凭据应失败
const missing = buildMcpConfig('sample', singleKeyDef, {});
assert.equal(missing.ok, false);
assert.match(missing.error, /缺少凭据/);

// env-file 必须拒绝
const envFileDef = {...noneDef, CredentialType: 'env-file'};
const envFileResult = buildMcpConfig('envfile-test', envFileDef, {});
assert.equal(envFileResult.ok, false);
assert.match(envFileResult.error, /env-file/);
console.log('[PASS] buildMcpConfig parity（none/single-key/url-embedded/args-multi/args-token/env-file）');

// ── skills find parser ─────────────────────────────────────────────────────
const jsonOut = JSON.stringify([
	{name: 'foo-skill', source: 'org/repo', description: 'desc', installCount: 5}
]);
const parsed = parseSkillsFindOutput(jsonOut);
assert.equal(parsed?.[0]?.name, 'foo-skill');
assert.equal(parsed?.[0]?.installCount, 5);

const tableOut = 'foo-skill  org/repo  A foo skill\nbar-skill  org2/repo2  Bar';
const tableParsed = parseSkillsFindOutput(tableOut);
assert.equal(tableParsed?.length, 2);
assert.equal(tableParsed?.[1]?.name, 'bar-skill');

// 真实块状格式（npx skills find <q> 实际输出，去 ANSI 后）：每个 skill 两行一块，
// name 与 install count 间为单空格（非 2+ 空格），URL 续行以 └ 开头。
// 回归点：旧 split(/\s{2,}/) 分列会把整行当一个 name（含空格不匹配校验被跳过），
// URL 续行反被误判为 name，最终只解析出一条——必须解析出全部 3 条且 name 非 URL。
const blockOut = [
	'Install with npx skills add <owner/repo@skill>',
	'',
	'github/awesome-copilot@pdftk-server 9.6K installs',
	'└ https://skills.sh/github/awesome-copilot/pdftk-server',
	'',
	'openai/skills@pdf 8K installs',
	'└ https://skills.sh/openai/skills/pdf',
	'',
	'pilioai/skills@remove-pdf-watermark 7.3K installs',
	'└ https://skills.sh/pilioai/skills/remove-pdf-watermark'
].join('\n');
const blockParsed = parseSkillsFindOutput(blockOut);
assert.equal(blockParsed?.length, 3, '真实块状格式应解析出全部 3 条（回归：旧逻辑只出 1 条）');
assert.equal(blockParsed[0].name, 'github/awesome-copilot@pdftk-server', 'name 应为 skill 标识而非 URL');
assert.equal(blockParsed[0].source, 'github/awesome-copilot', 'source 应为 @ 前的 owner/repo');
assert.equal(blockParsed[0].installCount, 9600, '9.6K installs 应解析为 9600');
assert.equal(blockParsed[0].url, 'https://skills.sh/github/awesome-copilot/pdftk-server', 'URL 应回填到对应记录');
assert.equal(blockParsed[2].name, 'pilioai/skills@remove-pdf-watermark', '最后一条 name 正确');
assert.equal(blockParsed[2].installCount, 7300, '7.3K installs 应解析为 7300');

// 含原始 256 色 ANSI 码的真实输出同样可解析（removeAnsiSequences 清理后等价）。
const ansiOut = '\x1B[38;5;145mopenai/skills@pdf\x1B[0m \x1B[36m8K installs\x1B[0m\n\x1B[38;5;102m└ https://skills.sh/openai/skills/pdf\x1B[0m';
const ansiParsed = parseSkillsFindOutput(ansiOut);
assert.equal(ansiParsed?.length, 1);
assert.equal(ansiParsed[0].name, 'openai/skills@pdf', '含 ANSI 的真实输出也应正确解析');

assert.equal(parseSkillsFindOutput(''), null, '完全无输出返回 null');
console.log('[PASS] skills find parser');

console.log('[PASS] Phase 2 核心纯函数回归门禁通过');
