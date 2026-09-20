import {describe, expect, test} from 'bun:test';
import {
	classifySkillsStorageRoot,
	detectInstalledSkillItems,
	groupInstalledSkillItems,
	installedSkillItemId,
	normalizeSkillSourceIdentity,
	parseSkillsListJson,
	storageRootsOf,
	type SkillsCliListRecord
} from '../../src/core/skills-installed.js';

// 载体迁移（P3a）：原 scripts/verify-skills-installed-domain.mjs（60 条静态断言）整体迁入。
//
// Checkpoint A 门禁（task 07-28-skills-multi-source-topology / design §3-§6）：
// 已安装 Skills 的唯一事实源是一次 `skills list -g --json`。本门禁只覆盖只读投影：
//   1) 严格逐记录解析：坏记录整体失败，不静默跳过，不读 lock、不扫目录；
//   2) source / sourceUrl 独立保留，identity 走 GitHub 等价归一化；
//   3) known 按 (name, sourceIdentity) 合并，unknown 按 (name, path) 隔离；
//   4) 能力矩阵只由 provenance 派生；
//   5) 同名实例相邻排序 + 稳定 id；
//   6) root 分类只由 JSON path 得出。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

const record = (over: Partial<SkillsCliListRecord> = {}): SkillsCliListRecord => ({
	name: 'pdf',
	path: '/home/u/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	...over
});

describe('Skills 已安装逻辑实例投影（core/skills-installed.ts）', () => {
	// ── 1) 严格解析：整体失败语义 ────────────────────────────────────────────────
	test('A-1 严格逐记录解析：坏记录整体失败 + 空白来源归一', () => {
		const ok = parseSkillsListJson([record()]);
		expect(ok.ok, '合法记录必须解析成功').toBe(true);
		if (!ok.ok) throw new Error('合法记录必须解析成功');
		expect(ok.records.length).toBe(1);

		const empty = parseSkillsListJson([]);
		if (!empty.ok) throw new Error('空数组必须解析成功');
		expect(empty.records, '合法空数组表示真正的空安装列表').toEqual([]);

		for (const [label, payload] of [
			['顶层非数组', {}],
			['顶层 null', null],
			['记录非 object', ['pdf']],
			['name 非字符串', [record({name: 42 as unknown as string})]],
			['name 空白', [record({name: '   '})]],
			['path 非字符串', [record({path: null as unknown as string})]],
			['scope 非字符串', [record({scope: 7 as unknown as string})]],
			['agents 非数组', [record({agents: 'Codex' as unknown as readonly string[]})]],
			['agents 元素非字符串', [record({agents: ['Codex', 3] as unknown as readonly string[]})]],
			['source 非字符串', [record({source: 5 as unknown as string})]],
			['sourceUrl 非字符串', [record({sourceUrl: {} as unknown as string})]]
		] as const) {
			const outcome = parseSkillsListJson(payload);
			expect(outcome.ok, `${label} 必须整体失败`).toBe(false);
			expect(outcome.ok ? '' : outcome.error, `${label} 必须带可诊断信息`).toMatch(/\S/);
		}

		const indexed = parseSkillsListJson([record(), record({name: 5 as unknown as string})]);
		expect(indexed.ok, '任一坏记录都让整批失败').toBe(false);
		expect(indexed.ok ? '' : indexed.error, '错误必须定位到记录索引，便于诊断').toMatch(/1/);

		// 空白 source/sourceUrl 归一为缺失（而不是 known 来源）。
		const blank = parseSkillsListJson([record({source: '   ', sourceUrl: ''})]);
		expect(blank.ok).toBe(true);
		if (!blank.ok) throw new Error('空白来源记录必须解析成功');
		const blankRecord = required(blank.records[0], 'blank record');
		expect(blankRecord.source, '空白 source 归一为缺失').toBe(undefined);
		expect(blankRecord.sourceUrl, '空白 sourceUrl 归一为缺失').toBe(undefined);
	});

	// ── 2) 来源归一化：GitHub 等价 + source/sourceUrl 独立 ───────────────────────
	test('A-2 来源归一化 + source/sourceUrl 独立保留', () => {
		const equivalents = [
			'https://github.com/Owner/Repo',
			'https://github.com/owner/repo.git',
			'git@github.com:owner/repo.git',
			'github:Owner/Repo',
			'github.com/owner/repo',
			'owner/repo'
		];
		const identities = equivalents.map(value => normalizeSkillSourceIdentity(value));
		for (const identity of identities) {
			expect(identity, `GitHub 等价来源必须归一为同一 identity: ${identity}`).toBe(identities[0]);
		}

		expect(normalizeSkillSourceIdentity('owner/repo'), '不同 repo 必须是不同 identity').not.toBe(
			normalizeSkillSourceIdentity('other/repo')
		);
		expect(normalizeSkillSourceIdentity('   '), '空白来源无 identity').toBe(undefined);
		expect(normalizeSkillSourceIdentity(undefined), '缺失来源无 identity').toBe(undefined);

		// 非 GitHub 来源保留精确值语义，但不同值不得碰撞。
		expect(normalizeSkillSourceIdentity('https://gitlab.com/a/b')).not.toBe(normalizeSkillSourceIdentity('https://gitlab.com/a/c'));

		// source 与 sourceUrl 是两个展示字段，identity 优先用 sourceUrl。
		const items = groupInstalledSkillItems([record({source: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git'})]);
		expect(items.length).toBe(1);
		const item = required(items[0], 'item');
		expect(item.provenance.kind).toBe('known');
		if (item.provenance.kind !== 'known') throw new Error('provenance 应为 known');
		expect(item.provenance.source, 'source 原值必须保留供展示').toBe('owner/repo');
		expect(item.provenance.sourceUrl, 'sourceUrl 原值必须保留供展示').toBe('https://github.com/owner/repo.git');
		expect(item.provenance.installSource, 'installSource 优先取 sourceUrl').toBe('https://github.com/owner/repo.git');
		expect(item.provenance.identity, 'identity 归一后与 shorthand 等价').toBe(normalizeSkillSourceIdentity('owner/repo') ?? '');

		// 只有 source 时 installSource 回退 source。
		const onlySource = required(groupInstalledSkillItems([record({source: 'owner/repo'})])[0], 'onlySource');
		if (onlySource.provenance.kind !== 'known') throw new Error('provenance 应为 known');
		expect(onlySource.provenance.installSource).toBe('owner/repo');
		expect(onlySource.provenance.sourceUrl).toBe(undefined);
	});

	// ── 3) known 同源合并 / 异源拆分 / unknown 按 path 隔离 ──────────────────────
	test('A-3 同源合并 / 异源拆分 / unknown 路径隔离', () => {
		// 同名同源多记录（.agents 本体 + .claude 投影）合并为一个 Item。
		const merged = groupInstalledSkillItems([
			record({path: '/h/.agents/skills/pdf', agents: ['Codex'], sourceUrl: 'https://github.com/owner/repo'}),
			record({path: '/h/.claude/skills/pdf', agents: ['Claude Code'], source: 'owner/repo'})
		]);
		expect(merged.length, '同名同源必须合并为一个逻辑实例').toBe(1);
		const mergedItem = required(merged[0], 'merged item');
		expect([...mergedItem.agents].sort(), '合并后 agents 是稳定去重并集').toEqual(['Claude Code', 'Codex']);
		expect(mergedItem.projections.length, '两条物理投影都要保留').toBe(2);
		expect(mergedItem.projections.map(p => p.root).sort(), '投影 root 由 JSON path 分类').toEqual(['agents', 'claude']);

		// 精确重复路径去重（同一条物理记录）。
		const duped = groupInstalledSkillItems([
			record({path: '/h/.agents/skills/pdf', source: 'owner/repo'}),
			record({path: '/h/.agents/skills/pdf', source: 'owner/repo'})
		]);
		expect(duped.length).toBe(1);
		expect(required(duped[0], 'duped[0]').projections.length, '精确重复路径必须去重').toBe(1);

		// 同名异源必须拆成多个 Item。
		const split = groupInstalledSkillItems([
			record({path: '/h/.agents/skills/pdf', source: 'owner/repo'}),
			record({path: '/h/.codex/skills/pdf', source: 'other/repo'})
		]);
		expect(split.length, 'CLI 返回不同归一化来源时必须拆成两个 Item').toBe(2);
		expect(required(split[0], 'split[0]').id, '同名异源 Item 必须有独立稳定 id').not.toBe(required(split[1], 'split[1]').id);

		// 内容不同不影响合并：核心层不读内容、不比较、不告警。
		const contentIrrelevant = groupInstalledSkillItems([
			record({path: '/h/.agents/skills/pdf', source: 'owner/repo'}),
			record({path: '/h/.claude/skills/pdf', source: 'owner/repo'})
		]);
		expect(contentIrrelevant.length, '同名同源即使磁盘内容不同也只合并，不比较内容').toBe(1);

		// unknown 按精确路径隔离，绝不因同名合并。
		const unknown = groupInstalledSkillItems([
			record({name: 'ghost', path: '/h/.claude/skills/ghost', agents: ['Claude Code']}),
			record({name: 'ghost', path: '/h/.codex/skills/ghost', agents: ['Codex']})
		]);
		expect(unknown.length, '未知来源不同路径绝不按名称合并').toBe(2);
		for (const item of unknown) {
			expect(item.provenance.kind).toBe('unknown');
		}

		const unknownSamePath = groupInstalledSkillItems([
			record({name: 'ghost', path: '/h/.claude/skills/ghost'}),
			record({name: 'ghost', path: '/h/.claude/skills/ghost'})
		]);
		expect(unknownSamePath.length, '未知来源精确同路径可视为同一条物理记录').toBe(1);

		// known 与 unknown 同名不得互相吞并。
		const mixed = groupInstalledSkillItems([
			record({name: 'dup', path: '/h/.agents/skills/dup', source: 'owner/repo'}),
			record({name: 'dup', path: '/h/.codex/skills/dup'})
		]);
		expect(mixed.length, 'known 与 unknown 同名必须各自成 Item').toBe(2);
	});

	// ── 4) 能力矩阵只由 provenance 派生 ─────────────────────────────────────────
	test('A-4 能力矩阵只由 provenance 派生', () => {
		const known = required(groupInstalledSkillItems([record({source: 'owner/repo'})])[0], 'known');
		expect(known.capabilities, '已知来源具备更新/管理/迁移/删除全部能力').toEqual({
			update: true,
			manageAgents: true,
			migrate: true,
			delete: true
		});

		const knownByUrl = required(groupInstalledSkillItems([record({sourceUrl: 'https://github.com/owner/repo'})])[0], 'knownByUrl');
		expect(knownByUrl.capabilities.update, '仅有 sourceUrl 也是已知来源').toBe(true);

		const unknown = required(groupInstalledSkillItems([record({name: 'ghost'})])[0], 'unknown');
		expect(unknown.capabilities, '未知来源只能删除').toEqual({
			update: false,
			manageAgents: false,
			migrate: false,
			delete: true
		});

		// 存储位置不得影响能力：.codex 的已知来源仍可更新/迁移。
		const codexKnown = required(
			groupInstalledSkillItems([record({path: '/h/.codex/skills/pdf', source: 'owner/repo'})])[0],
			'codexKnown'
		);
		expect(codexKnown.capabilities.migrate, '.codex 已知来源仍可迁移，不按目录预先屏蔽').toBe(true);
		expect(codexKnown.capabilities.update, '.codex 已知来源仍可更新').toBe(true);
	});

	// ── 5) 排序：同名相邻 + id 稳定 ─────────────────────────────────────────────
	test('A-5 同名相邻排序 + 稳定唯一 id', () => {
		const items = groupInstalledSkillItems([
			record({name: 'zeta', path: '/h/.agents/skills/zeta', source: 'o/z'}),
			record({name: 'alpha', path: '/h/.codex/skills/alpha', source: 'o/b'}),
			record({name: 'alpha', path: '/h/.agents/skills/alpha', source: 'o/a'})
		]);
		expect(
			items.map(i => i.name),
			'先按 name 排序，同名必须相邻'
		).toEqual(['alpha', 'alpha', 'zeta']);

		// id 对输入顺序稳定。
		const reordered = groupInstalledSkillItems([
			record({name: 'alpha', path: '/h/.agents/skills/alpha', source: 'o/a'}),
			record({name: 'zeta', path: '/h/.agents/skills/zeta', source: 'o/z'}),
			record({name: 'alpha', path: '/h/.codex/skills/alpha', source: 'o/b'})
		]);
		expect(
			reordered.map(i => i.id),
			'Item id 必须对 CLI 返回顺序稳定'
		).toEqual(items.map(i => i.id));
		expect(new Set(items.map(i => i.id)).size, 'id 必须唯一，可直接作 React key').toBe(items.length);

		// 显式 id 构造函数与分组结果一致。
		const knownItem = required(
			items.find(i => i.provenance.kind === 'known' && i.name === 'alpha'),
			'knownItem'
		);
		expect(knownItem.id, 'installedSkillItemId 必须是 Item id 的单一来源').toBe(installedSkillItemId(knownItem));
	});

	// ── 6) 存储 root 只由 JSON path 分类 ────────────────────────────────────────
	test('A-6 存储 root 只由 JSON path 分类', () => {
		expect(classifySkillsStorageRoot('/home/u/.claude/skills/pdf')).toBe('claude');
		expect(classifySkillsStorageRoot('/home/u/.agents/skills/pdf')).toBe('agents');
		expect(classifySkillsStorageRoot('/home/u/.codex/skills/pdf')).toBe('codex');
		expect(classifySkillsStorageRoot('/opt/elsewhere/pdf'), '未知根归类为 other，不猜测').toBe('other');
		expect(classifySkillsStorageRoot(''), '空 path 不得崩溃').toBe('other');

		// Windows 分隔符同样识别。
		expect(classifySkillsStorageRoot('C:\\Users\\u\\.claude\\skills\\pdf')).toBe('claude');
		expect(classifySkillsStorageRoot('C:\\Users\\u\\.agents\\skills\\pdf')).toBe('agents');

		// Item 级存储根聚合：同一逻辑实例的多个 projection 汇总为去重根集合。
		const sharedItem = required(
			groupInstalledSkillItems([
				record({name: 'a', path: '/h/.claude/skills/a', agents: ['Claude Code'], source: 'o/r'}),
				record({name: 'a', path: '/h/.agents/skills/a', agents: ['Codex'], source: 'o/r'})
			])[0],
			'sharedItem'
		);
		expect([...storageRootsOf(sharedItem)].sort()).toEqual(['agents', 'claude']);
	});

	// ── 7) detectInstalledSkillItems：单次命令 + 不读 lock/不扫目录 ──────────────
	test('A-7 detectInstalledSkillItems 单次命令 + 严格错误态', async () => {
		const calls: {command: string; args: readonly string[]}[] = [];
		const exec = (stdout: string) => async (command: string, args: readonly string[]) => {
			calls.push({command, args});
			return {code: 0, stdout, stderr: ''};
		};

		const payload = JSON.stringify([
			record({path: '/h/.agents/skills/pdf', agents: ['Codex'], source: 'owner/repo'}),
			record({path: '/h/.claude/skills/pdf', agents: ['Claude Code'], sourceUrl: 'https://github.com/owner/repo'})
		]);
		const outcome = await detectInstalledSkillItems(exec(payload));
		expect(calls.length, '一次检测只允许一次 list 命令').toBe(1);
		const firstCall = required(calls[0], 'calls[0]');
		expect(firstCall.args.includes('--agent'), '检测必须是不带 --agent 的全量扫').toBe(false);
		expect(firstCall.args.includes('--json')).toBe(true);
		expect(firstCall.args.includes('-g')).toBe(true);
		expect(outcome.length, '同源两条记录合并为一个 Item').toBe(1);

		// 失败路径：整体进入错误态（由 detection runner 转为 error state），不回退文件系统扫描。
		for (const [label, result] of [
			['非零退出', {code: 7, stdout: '', stderr: 'boom'}],
			['空输出', {code: 0, stdout: '', stderr: ''}],
			['无效 JSON', {code: 0, stdout: 'not-json', stderr: ''}],
			['顶层非数组', {code: 0, stdout: '{}', stderr: ''}],
			['坏记录', {code: 0, stdout: JSON.stringify([{name: 5}]), stderr: ''}]
		] as const) {
			await expect(
				detectInstalledSkillItems(async () => result),
				`${label} 必须进入错误态并带诊断信息`
			).rejects.toThrow(/\S/);
		}

		expect(await detectInstalledSkillItems(exec('[]')), '合法 [] 是真正的空列表').toEqual([]);
	});
});
