import assert from 'node:assert/strict';
import {
	parseSkillsListJson,
	normalizeSkillSourceIdentity,
	groupInstalledSkillItems,
	detectInstalledSkillItems,
	classifySkillsStorageRoot,
	storageRootsOf,
	installedSkillItemId
} from '../src/core/skills-installed.ts';

// Checkpoint A 门禁（task 07-28-skills-multi-source-topology / design §3-§6）：
// 已安装 Skills 的唯一事实源是一次 `skills list -g --json`。本门禁只覆盖只读投影：
//   1) 严格逐记录解析：坏记录整体失败，不静默跳过，不读 lock、不扫目录；
//   2) source / sourceUrl 独立保留，identity 走 GitHub 等价归一化；
//   3) known 按 (name, sourceIdentity) 合并，unknown 按 (name, path) 隔离；
//   4) 能力矩阵只由 provenance 派生；
//   5) 同名实例相邻排序 + 稳定 id；
//   6) root 分类只由 JSON path 得出。

const record = (over = {}) => ({
	name: 'pdf',
	path: '/home/u/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	...over
});

// ── 1) 严格解析：整体失败语义 ────────────────────────────────────────────────
{
	const ok = parseSkillsListJson([record()]);
	assert.equal(ok.ok, true, '合法记录必须解析成功');
	assert.equal(ok.records.length, 1);

	assert.deepEqual(parseSkillsListJson([]).records, [], '合法空数组表示真正的空安装列表');

	for (const [label, payload] of [
		['顶层非数组', {}],
		['顶层 null', null],
		['记录非 object', ['pdf']],
		['name 非字符串', [record({name: 42})]],
		['name 空白', [record({name: '   '})]],
		['path 非字符串', [record({path: null})]],
		['scope 非字符串', [record({scope: 7})]],
		['agents 非数组', [record({agents: 'Codex'})]],
		['agents 元素非字符串', [record({agents: ['Codex', 3]})]],
		['source 非字符串', [record({source: 5})]],
		['sourceUrl 非字符串', [record({sourceUrl: {}})]]
	]) {
		const outcome = parseSkillsListJson(payload);
		assert.equal(outcome.ok, false, `${label} 必须整体失败`);
		assert.match(outcome.error, /\S/, `${label} 必须带可诊断信息`);
	}

	const indexed = parseSkillsListJson([record(), record({name: 5})]);
	assert.equal(indexed.ok, false, '任一坏记录都让整批失败');
	assert.match(indexed.error, /1/, '错误必须定位到记录索引，便于诊断');

	// 空白 source/sourceUrl 归一为缺失（而不是 known 来源）。
	const blank = parseSkillsListJson([record({source: '   ', sourceUrl: ''})]);
	assert.equal(blank.ok, true);
	assert.equal(blank.records[0].source, undefined, '空白 source 归一为缺失');
	assert.equal(blank.records[0].sourceUrl, undefined, '空白 sourceUrl 归一为缺失');

	console.log('[PASS] A-1 严格逐记录解析：坏记录整体失败 + 空白来源归一');
}

// ── 2) 来源归一化：GitHub 等价 + source/sourceUrl 独立 ───────────────────────
{
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
		assert.equal(identity, identities[0], `GitHub 等价来源必须归一为同一 identity: ${identity}`);
	}

	assert.notEqual(
		normalizeSkillSourceIdentity('owner/repo'),
		normalizeSkillSourceIdentity('other/repo'),
		'不同 repo 必须是不同 identity'
	);
	assert.equal(normalizeSkillSourceIdentity('   '), undefined, '空白来源无 identity');
	assert.equal(normalizeSkillSourceIdentity(undefined), undefined, '缺失来源无 identity');

	// 非 GitHub 来源保留精确值语义，但不同值不得碰撞。
	assert.notEqual(
		normalizeSkillSourceIdentity('https://gitlab.com/a/b'),
		normalizeSkillSourceIdentity('https://gitlab.com/a/c')
	);

	// source 与 sourceUrl 是两个展示字段，identity 优先用 sourceUrl。
	const items = groupInstalledSkillItems([
		record({source: 'owner/repo', sourceUrl: 'https://github.com/owner/repo.git'})
	]);
	assert.equal(items.length, 1);
	assert.equal(items[0].provenance.kind, 'known');
	assert.equal(items[0].provenance.source, 'owner/repo', 'source 原值必须保留供展示');
	assert.equal(
		items[0].provenance.sourceUrl,
		'https://github.com/owner/repo.git',
		'sourceUrl 原值必须保留供展示'
	);
	assert.equal(
		items[0].provenance.installSource,
		'https://github.com/owner/repo.git',
		'installSource 优先取 sourceUrl'
	);
	assert.equal(
		items[0].provenance.identity,
		normalizeSkillSourceIdentity('owner/repo'),
		'identity 归一后与 shorthand 等价'
	);

	// 只有 source 时 installSource 回退 source。
	const onlySource = groupInstalledSkillItems([record({source: 'owner/repo'})])[0];
	assert.equal(onlySource.provenance.installSource, 'owner/repo');
	assert.equal(onlySource.provenance.sourceUrl, undefined);

	console.log('[PASS] A-2 来源归一化 + source/sourceUrl 独立保留');
}

// ── 3) known 同源合并 / 异源拆分 / unknown 按 path 隔离 ──────────────────────
{
	// 同名同源多记录（.agents 本体 + .claude 投影）合并为一个 Item。
	const merged = groupInstalledSkillItems([
		record({path: '/h/.agents/skills/pdf', agents: ['Codex'], sourceUrl: 'https://github.com/owner/repo'}),
		record({path: '/h/.claude/skills/pdf', agents: ['Claude Code'], source: 'owner/repo'})
	]);
	assert.equal(merged.length, 1, '同名同源必须合并为一个逻辑实例');
	assert.deepEqual(
		[...merged[0].agents].sort(),
		['Claude Code', 'Codex'],
		'合并后 agents 是稳定去重并集'
	);
	assert.equal(merged[0].projections.length, 2, '两条物理投影都要保留');
	assert.deepEqual(
		merged[0].projections.map(p => p.root).sort(),
		['agents', 'claude'],
		'投影 root 由 JSON path 分类'
	);

	// 精确重复路径去重（同一条物理记录）。
	const duped = groupInstalledSkillItems([
		record({path: '/h/.agents/skills/pdf', source: 'owner/repo'}),
		record({path: '/h/.agents/skills/pdf', source: 'owner/repo'})
	]);
	assert.equal(duped.length, 1);
	assert.equal(duped[0].projections.length, 1, '精确重复路径必须去重');

	// 同名异源必须拆成多个 Item。
	const split = groupInstalledSkillItems([
		record({path: '/h/.agents/skills/pdf', source: 'owner/repo'}),
		record({path: '/h/.codex/skills/pdf', source: 'other/repo'})
	]);
	assert.equal(split.length, 2, 'CLI 返回不同归一化来源时必须拆成两个 Item');
	assert.notEqual(split[0].id, split[1].id, '同名异源 Item 必须有独立稳定 id');

	// 内容不同不影响合并：核心层不读内容、不比较、不告警。
	const contentIrrelevant = groupInstalledSkillItems([
		record({path: '/h/.agents/skills/pdf', source: 'owner/repo'}),
		record({path: '/h/.claude/skills/pdf', source: 'owner/repo'})
	]);
	assert.equal(contentIrrelevant.length, 1, '同名同源即使磁盘内容不同也只合并，不比较内容');

	// unknown 按精确路径隔离，绝不因同名合并。
	const unknown = groupInstalledSkillItems([
		record({name: 'ghost', path: '/h/.claude/skills/ghost', agents: ['Claude Code']}),
		record({name: 'ghost', path: '/h/.codex/skills/ghost', agents: ['Codex']})
	]);
	assert.equal(unknown.length, 2, '未知来源不同路径绝不按名称合并');
	for (const item of unknown) {
		assert.equal(item.provenance.kind, 'unknown');
	}

	const unknownSamePath = groupInstalledSkillItems([
		record({name: 'ghost', path: '/h/.claude/skills/ghost'}),
		record({name: 'ghost', path: '/h/.claude/skills/ghost'})
	]);
	assert.equal(unknownSamePath.length, 1, '未知来源精确同路径可视为同一条物理记录');

	// known 与 unknown 同名不得互相吞并。
	const mixed = groupInstalledSkillItems([
		record({name: 'dup', path: '/h/.agents/skills/dup', source: 'owner/repo'}),
		record({name: 'dup', path: '/h/.codex/skills/dup'})
	]);
	assert.equal(mixed.length, 2, 'known 与 unknown 同名必须各自成 Item');

	console.log('[PASS] A-3 同源合并 / 异源拆分 / unknown 路径隔离');
}

// ── 4) 能力矩阵只由 provenance 派生 ─────────────────────────────────────────
{
	const known = groupInstalledSkillItems([record({source: 'owner/repo'})])[0];
	assert.deepEqual(
		known.capabilities,
		{update: true, manageAgents: true, migrate: true, delete: true},
		'已知来源具备更新/管理/迁移/删除全部能力'
	);

	const knownByUrl = groupInstalledSkillItems([
		record({sourceUrl: 'https://github.com/owner/repo'})
	])[0];
	assert.equal(knownByUrl.capabilities.update, true, '仅有 sourceUrl 也是已知来源');

	const unknown = groupInstalledSkillItems([record({name: 'ghost'})])[0];
	assert.deepEqual(
		unknown.capabilities,
		{update: false, manageAgents: false, migrate: false, delete: true},
		'未知来源只能删除'
	);

	// 存储位置不得影响能力：.codex 的已知来源仍可更新/迁移。
	const codexKnown = groupInstalledSkillItems([
		record({path: '/h/.codex/skills/pdf', source: 'owner/repo'})
	])[0];
	assert.equal(codexKnown.capabilities.migrate, true, '.codex 已知来源仍可迁移，不按目录预先屏蔽');
	assert.equal(codexKnown.capabilities.update, true, '.codex 已知来源仍可更新');

	console.log('[PASS] A-4 能力矩阵只由 provenance 派生');
}

// ── 5) 排序：同名相邻 + id 稳定 ─────────────────────────────────────────────
{
	const items = groupInstalledSkillItems([
		record({name: 'zeta', path: '/h/.agents/skills/zeta', source: 'o/z'}),
		record({name: 'alpha', path: '/h/.codex/skills/alpha', source: 'o/b'}),
		record({name: 'alpha', path: '/h/.agents/skills/alpha', source: 'o/a'})
	]);
	assert.deepEqual(items.map(i => i.name), ['alpha', 'alpha', 'zeta'], '先按 name 排序，同名必须相邻');

	// id 对输入顺序稳定。
	const reordered = groupInstalledSkillItems([
		record({name: 'alpha', path: '/h/.agents/skills/alpha', source: 'o/a'}),
		record({name: 'zeta', path: '/h/.agents/skills/zeta', source: 'o/z'}),
		record({name: 'alpha', path: '/h/.codex/skills/alpha', source: 'o/b'})
	]);
	assert.deepEqual(
		reordered.map(i => i.id),
		items.map(i => i.id),
		'Item id 必须对 CLI 返回顺序稳定'
	);
	assert.equal(new Set(items.map(i => i.id)).size, items.length, 'id 必须唯一，可直接作 React key');

	// 显式 id 构造函数与分组结果一致。
	const knownItem = items.find(i => i.provenance.kind === 'known' && i.name === 'alpha');
	assert.equal(
		knownItem.id,
		installedSkillItemId(knownItem),
		'installedSkillItemId 必须是 Item id 的单一来源'
	);

	console.log('[PASS] A-5 同名相邻排序 + 稳定唯一 id');
}

// ── 6) 存储 root 只由 JSON path 分类 ────────────────────────────────────────
{
	assert.equal(classifySkillsStorageRoot('/home/u/.claude/skills/pdf'), 'claude');
	assert.equal(classifySkillsStorageRoot('/home/u/.agents/skills/pdf'), 'agents');
	assert.equal(classifySkillsStorageRoot('/home/u/.codex/skills/pdf'), 'codex');
	assert.equal(classifySkillsStorageRoot('/opt/elsewhere/pdf'), 'other', '未知根归类为 other，不猜测');
	assert.equal(classifySkillsStorageRoot(''), 'other', '空 path 不得崩溃');

	// Windows 分隔符同样识别。
	assert.equal(classifySkillsStorageRoot('C:\\Users\\u\\.claude\\skills\\pdf'), 'claude');
	assert.equal(classifySkillsStorageRoot('C:\\Users\\u\\.agents\\skills\\pdf'), 'agents');

	// Item 级存储根聚合：同一逻辑实例的多个 projection 汇总为去重根集合。
	const sharedItem = groupInstalledSkillItems([
		record({name: 'a', path: '/h/.claude/skills/a', agents: ['Claude Code'], source: 'o/r'}),
		record({name: 'a', path: '/h/.agents/skills/a', agents: ['Codex'], source: 'o/r'})
	])[0];
	assert.deepEqual([...storageRootsOf(sharedItem)].sort(), ['agents', 'claude']);

	console.log('[PASS] A-6 存储 root 只由 JSON path 分类');
}

// ── 7) detectInstalledSkillItems：单次命令 + 不读 lock/不扫目录 ──────────────
{
	const calls = [];
	const exec = stdout => async (command, args) => {
		calls.push({command, args});
		return {code: 0, stdout, stderr: ''};
	};

	const payload = JSON.stringify([
		record({path: '/h/.agents/skills/pdf', agents: ['Codex'], source: 'owner/repo'}),
		record({path: '/h/.claude/skills/pdf', agents: ['Claude Code'], sourceUrl: 'https://github.com/owner/repo'})
	]);
	const outcome = await detectInstalledSkillItems(exec(payload));
	assert.equal(calls.length, 1, '一次检测只允许一次 list 命令');
	assert.equal(calls[0].args.includes('--agent'), false, '检测必须是不带 --agent 的全量扫');
	assert.equal(calls[0].args.includes('--json'), true);
	assert.equal(calls[0].args.includes('-g'), true);
	assert.equal(outcome.length, 1, '同源两条记录合并为一个 Item');

	// 失败路径：整体进入错误态（由 detection runner 转为 error state），不回退文件系统扫描。
	for (const [label, result] of [
		['非零退出', {code: 7, stdout: '', stderr: 'boom'}],
		['空输出', {code: 0, stdout: '', stderr: ''}],
		['无效 JSON', {code: 0, stdout: 'not-json', stderr: ''}],
		['顶层非数组', {code: 0, stdout: '{}', stderr: ''}],
		['坏记录', {code: 0, stdout: JSON.stringify([{name: 5}]), stderr: ''}]
	]) {
		await assert.rejects(
			() => detectInstalledSkillItems(async () => result),
			/\S/,
			`${label} 必须进入错误态并带诊断信息`
		);
	}

	assert.deepEqual(await detectInstalledSkillItems(exec('[]')), [], '合法 [] 是真正的空列表');

	console.log('[PASS] A-7 detectInstalledSkillItems 单次命令 + 严格错误态');
}

console.log('[PASS] Skills 已安装逻辑实例投影门禁全部通过');
