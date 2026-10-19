import {describe, expect, test} from 'bun:test';
import {groupInstalledSkillItems, type SkillsCliListRecord} from '../../src/core/skills-installed.js';

function record(fields: Partial<SkillsCliListRecord> = {}): SkillsCliListRecord {
	return {
		name: 'bookclub-sharing',
		path: '/home/user/.agents/skills/bookclub-sharing',
		scope: 'global',
		agents: ['Codex', 'Pi'],
		...fields
	};
}

describe('导入 Skills 的来源解析', () => {
	for (const source of [
		'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\ccq-skill-stage-qLDJIi',
		'C:/Users/user/AppData/Local/Temp/ccq-skill-stage-ABC123/',
		'\\\\server\\temp\\ccq-skill-stage-ABC123',
		'/tmp/ccq-skill-stage-ABC123',
		'/private/var/folders/user/T/ccq-skill-stage-ABC123/',
		'file:///tmp/ccq-skill-stage-ABC123'
	]) {
		test(`内部快照不是来源：${source}`, () => {
			for (const fields of [{source}, {sourceUrl: source}, {source, sourceUrl: source}]) {
				const [item] = groupInstalledSkillItems([record(fields)]);
				expect(item!.provenance).toEqual({kind: 'unknown'});
				expect(item!.capabilities).toEqual({update: false, manageAgents: false, migrate: false, delete: true});
				expect(item!.agents).toEqual(['Codex', 'Pi']);
				// 原始 CLI 来源仍保留在 projection，供诊断。
				expect(item!.projections[0]).toMatchObject(fields);
			}
		});
	}

	test('两个字段独立过滤，真实来源仍可用', () => {
		const source = 'owner/repo';
		const sourceUrl = 'https://github.com/owner/repo';
		const staging = '/tmp/ccq-skill-stage-ABC123';
		const [fromUrl] = groupInstalledSkillItems([record({source: staging, sourceUrl})]);
		expect(fromUrl!.provenance).toEqual({kind: 'known', identity: 'github:owner/repo', sourceUrl, installSource: sourceUrl});
		const [fromSource] = groupInstalledSkillItems([record({source, sourceUrl: staging})]);
		expect(fromSource!.provenance).toEqual({kind: 'known', identity: 'github:owner/repo', source, installSource: source});
	});

	test('普通本地来源、远程来源及相似目录名不受影响', () => {
		for (const source of [
			'/tmp/my-skills',
			'C:\\skills\\bookclub-sharing',
			'file:///home/user/skills',
			'owner/repo',
			'https://github.com/owner/ccq-skill-stage-ABC123',
			'/home/user/ccq-skill-stage-ABC123/skills',
			'/home/user/not-ccq-skill-stage-ABC123'
		]) {
			const [item] = groupInstalledSkillItems([record({source})]);
			expect(item!.provenance).toMatchObject({kind: 'known', source, installSource: source});
			expect(item!.capabilities.update).toBe(true);
		}
	});

	test('同名内部快照来源按实际安装路径隔离，不误合并', () => {
		const source = '/tmp/ccq-skill-stage-ABC123';
		const records = [record({source}), record({source, path: '/home/user/.claude/skills/bookclub-sharing'})];
		const items = groupInstalledSkillItems([...records, records[0]!]);
		expect(items).toHaveLength(2);
		expect(new Set(items.map(item => item.id)).size).toBe(2);
		expect(items.every(item => item.provenance.kind === 'unknown' && item.projections.length === 1)).toBe(true);
	});
});
