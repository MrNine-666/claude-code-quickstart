import {describe, expect, test} from 'bun:test';
import {hasUpdate, parseSemver} from '../../src/core/semver.js';
import {parseSkillsFindOutput} from '../../src/core/skills.js';
import {maskApiKey, testProviderKey} from '../../src/core/text-utils.js';

// P5d 迁移自 scripts/verify-core-functions.mjs 的「未被 P0–P4 既有载体覆盖」纯段（14 条静态断言）。
// 判据：semver / 文本凭据 / skills find parser 均为纯函数，无真实 fs / 子进程 / 渲染。
// R9：同脚本其余纯段已由既有载体覆盖，按 R9 不重复迁移并保留在 verify 待 P5e 去重——
//   - semver 主矩阵 → tests/core/tools-lifecycle.test.ts「parseSemver / semverCompare / hasUpdate」
//   - maskApiKey / normalizeBaseUrl → tests/core/text-utils.test.ts
//   - provider 表单 → tests/core/provider-form.test.ts（P0）
//   - buildMcpConfig parity 矩阵 → tests/core/mcp-parity.test.ts（P2a）
//   - skills find parser JSON / 表格 / 空输出 → tests/core/skills-view.test.ts
// 保留在 verify 的 6 条（外部命令超时收敛 / 响应 AbortSignal）断言真实子进程 argv 与退出，按判据留 verify。

describe('semver 边界：v 前缀与 prerelease', () => {
	test('v 前缀可解析，prerelease 视为无更新', () => {
		expect(parseSemver('v1.2.3')?.minor).toBe(2);
		expect(hasUpdate('1.2.3', '2.0.0-beta'), 'prerelease 视为无更新').toBe(false);
	});
});

describe('文本/凭据工具边界', () => {
	test('空 API Key 与文件名安全校验', () => {
		expect(maskApiKey('')).toBe('-');
		expect(testProviderKey('zhipu')).toBe(true);
		expect(testProviderKey('../evil')).toBe(false);
	});
});

describe('skills find parser 真实块状 / ANSI 输出', () => {
	test('真实块状格式解析出全部条目且 name 非 URL', () => {
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
		expect(blockParsed?.length, '真实块状格式应解析出全部 3 条（回归：旧逻辑只出 1 条）').toBe(3);
		expect(blockParsed![0]!.name, 'name 应为 skill 标识而非 URL').toBe('github/awesome-copilot@pdftk-server');
		expect(blockParsed![0]!.source, 'source 应为 @ 前的 owner/repo').toBe('github/awesome-copilot');
		expect(blockParsed![0]!.installCount, '9.6K installs 应解析为 9600').toBe(9600);
		expect(blockParsed![0]!.url, 'URL 应回填到对应记录').toBe('https://skills.sh/github/awesome-copilot/pdftk-server');
		expect(blockParsed![2]!.name, '最后一条 name 正确').toBe('pilioai/skills@remove-pdf-watermark');
		expect(blockParsed![2]!.installCount, '7.3K installs 应解析为 7300').toBe(7300);
	});

	test('含原始 256 色 ANSI 码的真实输出同样可解析', () => {
		const ansiOut =
			'\x1B[38;5;145mopenai/skills@pdf\x1B[0m \x1B[36m8K installs\x1B[0m\n\x1B[38;5;102m└ https://skills.sh/openai/skills/pdf\x1B[0m';
		const ansiParsed = parseSkillsFindOutput(ansiOut);
		expect(ansiParsed?.length).toBe(1);
		expect(ansiParsed![0]!.name, '含 ANSI 的真实输出也应正确解析').toBe('openai/skills@pdf');
	});
});
