import * as fs from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, spyOn, test} from 'bun:test';
import {applyConfigTransferImport, planConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {importRulesSection} from '../../src/core/config-transfer-sections.js';
import {createBundlePayload, type BundleSection} from '../../src/core/config-transfer.js';
import {createTempHome} from '../helpers/temp-home.js';

function write(path: string, content: string): void {
	fs.mkdirSync(dirname(path), {recursive: true});
	fs.writeFileSync(path, content);
}
function payload(sections: readonly BundleSection[]) {
	const result = createBundlePayload({sections, containsCredentials: false, version: 'test', platform: 'test'});
	if (!result.ok) throw new Error(result.error);
	return result.data;
}
function rules(entries: readonly string[] = ['CLAUDE.md']) {
	return {
		entries: entries.map(path => ({
			root: 'claude' as const,
			path,
			kind: 'file' as const,
			contentBase64: Buffer.from('new').toString('base64'),
			mode: 0o644
		}))
	};
}
const replace = [{tool: 'cc' as const, category: 'rules', action: 'replace' as const}];

describe('import category strategy — isolated rules transaction', () => {
	for (const action of ['merge', 'replace', 'skip'] as const) {
		test(`${action}: preview matches actual deletion; excluded and unselected files survive`, async () => {
			const home = createTempHome('ccq-strategy-');
			try {
				const old = join(home.path, '.claude/rules/old.md');
				const main = join(home.path, '.claude/CLAUDE.md');
				const auth = join(home.path, '.claude/rules/.env');
				const settings = join(home.path, '.claude/settings.json');
				write(old, 'old');
				write(main, 'local');
				write(auth, 'FAKE-SECRET');
				write(settings, '{"unknown":true}');
				const before = fs.statSync(old).mtimeMs;
				const bundle = payload([{tool: 'cc', category: 'rules', data: rules()}]);
				const plan = await planConfigTransferImport(bundle);
				expect(plan.ok).toBe(true);
				if (!plan.ok) return;
				expect(plan.data.items[0]?.defaultAction).toBe('merge');
				expect(plan.data.items[0]?.replace?.identities.removed).toEqual(['rules/old.md']);
				expect(plan.data.items[0]?.replace?.counts.removed).toBe(1);
				expect(fs.statSync(old).mtimeMs).toBe(before);
				expect(fs.readFileSync(main, 'utf8')).toBe('local');
				expect(JSON.stringify(plan.data)).not.toContain('FAKE-SECRET');
				expect(JSON.stringify(plan.data)).not.toContain(home.path);
				const result = await applyConfigTransferImport(bundle, plan.data, [{...replace[0]!, action}], {
					tempDir: join(home.path, 'tx')
				});
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.data.status).toBe('complete');
				expect(fs.existsSync(old)).toBe(action !== 'replace');
				expect(fs.readFileSync(main, 'utf8')).toBe(action === 'skip' ? 'local' : 'new');
				expect(fs.readFileSync(auth, 'utf8')).toBe('FAKE-SECRET');
				expect(fs.readFileSync(settings, 'utf8')).toBe('{"unknown":true}');
			} finally {
				home.restore();
				home.cleanup();
			}
		});
	}

	test('empty rules is explicit scope; empty skills is not; unsafe replace does not block merge', async () => {
		const home = createTempHome('ccq-strategy-empty-');
		try {
			const main = join(home.path, '.claude/CLAUDE.md');
			write(main, 'old');
			const bundle = payload([
				{tool: 'cc', category: 'rules', data: rules([])},
				{tool: 'cc', category: 'skills', data: {skills: []}}
			]);
			const plan = await planConfigTransferImport(bundle);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			const skills = plan.data.items.find(item => item.category === 'skills');
			expect(skills?.status).not.toBe('blocked');
			expect(skills?.replace?.status).toBe('blocked');
			const result = await applyConfigTransferImport(bundle, plan.data, [
				...replace,
				{tool: 'cc', category: 'skills', action: 'skip'}
			]);
			expect(result.ok && result.data.status).toBe('complete');
			expect(fs.existsSync(main)).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('confirmed plan refuses new or changed targets before any mutation', async () => {
		const home = createTempHome('ccq-strategy-stale-');
		try {
			const old = join(home.path, '.claude/rules/old.md');
			write(old, 'old');
			const bundle = payload([
				{tool: 'ccq', category: 'system-settings', data: {autoUpdate: true}},
				{tool: 'cc', category: 'rules', data: rules()}
			]);
			const plan = await planConfigTransferImport(bundle);
			if (!plan.ok) throw new Error(plan.error);
			const late = join(home.path, '.claude/rules/late.md');
			write(late, 'unconfirmed');
			const result = await applyConfigTransferImport(bundle, plan.data, replace);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.kind).toBe('conflict');
			expect(fs.existsSync(join(home.path, '.ccq/system-settings.json'))).toBe(false);
			expect(fs.readFileSync(old, 'utf8')).toBe('old');
			expect(fs.readFileSync(late, 'utf8')).toBe('unconfirmed');
			expect(fs.existsSync(join(home.path, '.claude/CLAUDE.md'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('delete failure restores deleted files and writes, stops later classifications', async () => {
		const home = createTempHome('ccq-strategy-rollback-');
		let unlink: ReturnType<typeof spyOn> | undefined;
		try {
			const first = join(home.path, '.claude/rules/a.md');
			const second = join(home.path, '.claude/rules/b.md');
			const main = join(home.path, '.claude/CLAUDE.md');
			write(first, 'first');
			write(second, 'second');
			write(main, 'original');
			const bundle = payload([
				{tool: 'cc', category: 'rules', data: rules()},
				{tool: 'pi', category: 'rules', data: {entries: [{...rules(['AGENTS.md']).entries[0]!, root: 'pi-agent'}]}}
			]);
			const plan = await planConfigTransferImport(bundle);
			if (!plan.ok) throw new Error(plan.error);
			const realUnlink = fs.unlinkSync;
			unlink = spyOn(fs, 'unlinkSync').mockImplementation(path => {
				if (String(path) === second) throw new Error('injected delete failure');
				return realUnlink(path);
			});
			const result = await applyConfigTransferImport(bundle, plan.data, replace, {tempDir: join(home.path, 'tx')});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.data.status).toBe('failed');
				expect(result.data.failed[0]?.restored).toBe(true);
				expect(result.data.notExecuted).toContainEqual({tool: 'pi', category: 'rules'});
			}
			expect(fs.readFileSync(first, 'utf8')).toBe('first');
			expect(fs.readFileSync(second, 'utf8')).toBe('second');
			expect(fs.readFileSync(main, 'utf8')).toBe('original');
		} finally {
			unlink?.mockRestore();
			home.restore();
			home.cleanup();
		}
	});

	test('owner replace dry-run lists removals, merge default stays additive', () => {
		const home = createTempHome('ccq-strategy-owner-');
		try {
			const old = join(home.path, '.claude/rules/old.md');
			write(old, 'old');
			const result = importRulesSection('cc', rules([]), {mode: 'replace', dryRun: true});
			expect(result.ok && result.data.removed).toEqual(['rules/old.md']);
			expect(fs.existsSync(old)).toBe(true);
			expect(importRulesSection('cc', rules([])).ok).toBe(true);
			expect(fs.existsSync(old)).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
