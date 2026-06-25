import {execCommand, removeAnsiSequences, type ExecResult} from './exec.js';

// 外部命令执行缝：默认走 execCommand，测试可注入桩以避免真实 spawn（design D11/D13）。
export type ExecFn = (command: string, args: readonly string[], options?: {timeout?: number}) => Promise<ExecResult>;

// Skills core：已安装检测 + skills find 搜索 + parser（design D11）。
// 搜索数据源固定为 `npx --yes skills find <query>`，命令不可用/不可解析时报错，不回退 catalogue。

const SKILLS_CLI_AGENT = 'claude-code';
const LIST_TIMEOUT_MS = 120000;
const SEARCH_TIMEOUT_MS = 120000;

export type InstalledSkill = {
	readonly name: string;
	readonly path: string;
	readonly scope: string;
	readonly agents: readonly string[];
	readonly description?: string;
};

export type SearchSkillResult = {
	readonly name: string;
	readonly source: string;
	readonly description: string;
	readonly installCount?: number;
	readonly url?: string;
};

export type SkillsSearchOutcome =
	| {readonly ok: true; readonly results: readonly SearchSkillResult[]}
	| {readonly ok: false; readonly error: string; readonly rawSummary?: string};

/**
 * 获取已安装的 Skills（`npx skills list -g --agent claude-code --json`）。
 * 用 `--agent` 长选项而非 `-a`：`-a` 在 `--json` 模式下会把所有 agent 的 skills 都查出来，
 * `--agent` 才能正确限定到 claude-code（实测结论）。
 * 返回 Promise，支持后台并发执行（design D13）。
 */
export async function getInstalledSkills(exec: ExecFn = execCommand): Promise<InstalledSkill[]> {
	const args = ['--yes', 'skills', 'list', '-g', '--agent', SKILLS_CLI_AGENT, '--json'];

	try {
		const {code, stdout} = await exec('npx', args, {timeout: LIST_TIMEOUT_MS});
		if (code !== 0 || !stdout.trim()) {
			return [];
		}

		const items = JSON.parse(stdout.trim()) as Array<Record<string, unknown>>;
		const records: InstalledSkill[] = [];

		for (const item of items) {
			const skillName = typeof item?.name === 'string' ? item.name : '';
			if (!skillName) {
				continue;
			}

			records.push({
				name: skillName,
				path: typeof item.path === 'string' ? item.path : '',
				scope: typeof item.scope === 'string' ? item.scope : '',
				agents: Array.isArray(item.agents) ? (item.agents as string[]) : []
			});
		}

		return records;
	} catch {
		return [];
	}
}

// ── 搜索（skills find） ─────────────────────────────────────────────────────

const COMMAND_UNAVAILABLE = /command not found|not recognized|no such file|enoent|unknown command|usage:/i;

/**
 * 解析 `skills find` 输出。优先尝试 JSON（数组或 {results:[...]}）；
 * 回退到逐行表格解析（`name  source  description` 形式）。
 * 返回 null 表示无法解析（区别于"成功但无结果"的空数组）。
 */
export function parseSkillsFindOutput(rawStdout: string, rawStderr = ''): SearchSkillResult[] | null {
	const cleaned = removeAnsiSequences(rawStdout).trim();

	if (cleaned) {
		const fromJson = tryParseJsonResults(cleaned);
		if (fromJson) {
			return fromJson;
		}
	}

	const combined = removeAnsiSequences(`${rawStdout}\n${rawStderr}`);
	if (COMMAND_UNAVAILABLE.test(combined) && !cleaned) {
		return null;
	}

	const fromTable = parseTableResults(cleaned);
	if (fromTable) {
		return fromTable;
	}

	// 有输出但无法解析为结果：返回空数组（成功无结果），完全无输出返回 null。
	return cleaned ? [] : null;
}

function tryParseJsonResults(text: string): SearchSkillResult[] | null {
	if (!text.startsWith('[') && !text.startsWith('{')) {
		return null;
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		const items = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as {results?: unknown[]}).results)
				? (parsed as {results: unknown[]}).results
				: null;
		if (!items) {
			return null;
		}

		return items
			.map(normalizeSearchItem)
			.filter((item): item is SearchSkillResult => item !== null);
	} catch {
		return null;
	}
}

function normalizeSearchItem(raw: unknown): SearchSkillResult | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}

	const item = raw as Record<string, unknown>;
	const name = typeof item.name === 'string' ? item.name.trim() : '';
	if (!name) {
		return null;
	}

	const source = typeof item.source === 'string' ? item.source : typeof item.repo === 'string' ? item.repo : '';
	const description =
		typeof item.description === 'string' ? item.description : typeof item.desc === 'string' ? item.desc : '';
	const installCount = typeof item.installCount === 'number' ? item.installCount : undefined;
	const url = typeof item.url === 'string' ? item.url : undefined;

	return {name, source, description, installCount, url};
}

// skills find 实际输出为「块状多行」格式：每个 skill 占两行——
// `<owner/repo@skill> <count> installs` 紧跟 `└ https://skills.sh/...`，块间空行分隔。
// 注意：name 与 count 之间为**单空格**（非 2+ 空格/制表符），不可用 `\s{2,}` 分列，
// 否则整行无法分列、name 含空格不匹配校验被跳过，URL 续行反被误判为 name（只解析出一条）。
// 旧版表格格式 `name  source  description`（单行多列，2+ 空格分列）作为兼容分支保留。
function parseTableResults(text: string): SearchSkillResult[] | null {
	if (!text) {
		return null;
	}

	type Acc = {name: string; source: string; description: string; installCount?: number; url?: string};
	const results: Acc[] = [];

	// 真实块状格式 name 行：<name> <count> installs（name=owner/repo@skill，count 形如 9.6K/8K/1234）。
	// name 与 count 间单空格，count 与 installs 间单空格；用锚定结尾的正则精确提取，避免吞掉多空格旧格式。
	const blockLine = /^([A-Za-z0-9@][A-Za-z0-9@:_./-]{0,99})\s+([\d.]+\s*[kmbKMB]?)\s+installs\s*$/;

	for (const rawLine of text.split(/\r?\n/)) {
		// 去掉边框/续行前缀（│ | └ 及尾部空格）。
		const line = rawLine.replace(/^[│|└]\s*/, '').trim();
		if (!line || /^install with/i.test(line)) {
			continue;
		}

		// URL 续行：始终跳过（results 为空时无处回填，也绝不能当 name）。
		if (/^https?:\/\//i.test(line)) {
			if (results.length > 0) {
				const last = results[results.length - 1]!;
				if (!last.url) {
					last.url = line;
				}
			}

			continue;
		}

		// 真实块状格式：<name> <count> installs
		const blockMatch = line.match(blockLine);
		if (blockMatch) {
			const name = blockMatch[1]!;
			results.push({
				name,
				source: name.includes('@') ? (name.split('@')[0] ?? '') : '',
				description: '',
				installCount: parseInstallCount(blockMatch[2]!)
			});
			continue;
		}

		// 兼容旧表格格式：name  source  description（2+ 空格/制表符分列）。
		const columns = line.split(/\t|\s{2,}/).map(c => c.trim()).filter(Boolean);
		if (columns.length < 2) {
			continue;
		}

		const name = columns[0]!;
		if (!/^[A-Za-z0-9@][A-Za-z0-9@:_./-]{0,99}$/.test(name)) {
			continue;
		}

		const second = columns[1] ?? '';
		if (/installs/i.test(second)) {
			// 旧格式变种：name  <count> installs
			results.push({
				name,
				source: name.includes('@') ? (name.split('@')[0] ?? '') : '',
				description: '',
				installCount: parseInstallCount(second)
			});
		} else {
			// 旧表格格式：name  source  description
			results.push({
				name,
				source: second,
				description: columns.slice(2).join(' ')
			});
		}
	}

	return results.length > 0 ? results : null;
}

/** 解析 "491.5K installs" 形态的安装数；无法解析返回 undefined。 */
function parseInstallCount(text: string): number | undefined {
	const match = text.match(/([\d.]+)\s*([kmb]?)/i);
	if (!match) {
		return undefined;
	}

	const value = Number.parseFloat(match[1]!);
	if (Number.isNaN(value)) {
		return undefined;
	}

	const unit = match[2]!.toLowerCase();
	const multiplier = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1;
	return Math.round(value * multiplier);
}

/**
 * 搜索 Skills（`npx --yes skills find <query>`）。空查询不触发 CLI（design D11）。
 * 命令不可用 / 输出不可解析时返回 ok:false，不回退 catalogue。
 */
export async function searchSkills(query: string, exec: ExecFn = execCommand): Promise<SkillsSearchOutcome> {
	const trimmed = (query || '').trim();
	if (!trimmed) {
		return {ok: false, error: '请输入搜索关键词'};
	}

	try {
		const {code, stdout, stderr} = await exec('npx', ['--yes', 'skills', 'find', trimmed], {
			timeout: SEARCH_TIMEOUT_MS
		});

		const results = parseSkillsFindOutput(stdout, stderr);
		if (results === null) {
			return {
				ok: false,
				error: code === 0 ? 'skills find 输出无法解析' : 'skills find 命令不可用或执行失败',
				rawSummary: removeAnsiSequences(stderr || stdout).slice(0, 500)
			};
		}

		return {ok: true, results};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

