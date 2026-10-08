import {existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';

import {materializePortableTreeEntries} from '../../src/core/config-transfer-sections.js';
import {type BundlePayload, type BundleSection, createBundlePayload} from '../../src/core/config-transfer.js';
import {
	applyConfigTransferImport,
	type ConfigTransferImportPlan,
	planConfigTransferExport,
	planConfigTransferImport
} from '../../src/core/config-transfer-plan.js';
import type {ExportedSkill} from '../../src/core/config-transfer-skills.js';
import {createTempHome} from '../helpers/temp-home.js';

// Phase 3：导出计划、零写盘预览与分类事务。全部文件操作在临时 CCQ_HOME 下。

const SENTINEL = 'SENTINEL-SECRET-c0ffee';

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function writeJson(path: string, value: unknown): void {
	writeFile(path, JSON.stringify(value, null, 2));
}

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function treeEntry(root: 'claude' | 'agents' | 'codex' | 'pi-agent' | 'ccq', path: string, content: string): Record<string, unknown> {
	return {
		kind: 'file',
		root,
		path,
		contentBase64: Buffer.from(content, 'utf8').toString('base64'),
		mode: 0o644
	};
}

function payloadOf(sections: readonly BundleSection[], containsCredentials = false): BundlePayload {
	const payload = createBundlePayload({sections, containsCredentials, version: 'test', platform: 'test'});
	if (!payload.ok) {
		throw new Error(`测试 payload 非法：${payload.error}`);
	}

	return payload.data;
}

/** 记录 target 的字节与 mtime，用于证明预览零写盘。 */
function fileFacts(paths: readonly string[]): string {
	return JSON.stringify(
		paths.map(path => {
			try {
				const stat = statSync(path);
				return `${path}:${stat.size}:${stat.mtimeMs}:${readFileSync(path, 'utf8')}`;
			} catch {
				return `${path}:missing`;
			}
		})
	);
}

describe('config-transfer 导出计划', () => {
	test('仅 Pi models.json 的顶层 apiKey / 模型 headers 也标为含凭据，未选时不写入', async () => {
		const home = createTempHome('ccq-transfer-plan-pi-credentials-');
		try {
			writeJson(join(home.path, '.pi', 'agent', 'models.json'), {
				providers: {
					test: {
						apiKey: SENTINEL,
						api: 'openai-completions',
						models: [{id: 'm', headers: {Authorization: SENTINEL}}]
					}
				}
			});
			const categories = [{tool: 'pi' as const, category: 'providers'}];
			const full = await planConfigTransferExport({categories, includeCredentials: true});
			expect(full.ok).toBe(true);
			if (!full.ok) return;
			expect(full.data.containsCredentials).toBe(true);
			expect(full.data.summaries[0]?.containsCredentials).toBe(true);
			const stripped = await planConfigTransferExport({categories, includeCredentials: false});
			expect(stripped.ok).toBe(true);
			if (stripped.ok) expect(JSON.stringify(stripped.data)).not.toContain(SENTINEL);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('选择展开为有序 sections，未选凭据时剥离值并报告 union fact', async () => {
		const home = createTempHome('ccq-transfer-plan-export-');
		const tempDir = join(home.path, 'stage');
		try {
			writeJson(join(home.path, '.ccq', 'mcp-meta.json'), {
				schemaVersion: 1,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				servers: {
					shared: {config: {url: 'https://shared.example'}, credentials: {values: {TOKEN: SENTINEL}}}
				}
			});
			writeJson(join(home.path, '.claude', 'providers', 'glm.json'), {
				env: {ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: 'https://glm.example'}
			});
			writeJson(join(home.path, '.pi', 'agent', 'auth.json'), {openai: {type: 'api_key', key: SENTINEL}});
			writeFile(join(home.path, '.pi', 'agent', 'extensions', 'custom.ts'), 'export {};\n');
			writeFile(join(home.path, '.claude', 'CLAUDE.md'), '# rules\n');
			writeFile(
				join(home.path, '.codex', 'config.toml'),
				[
					'model = "gpt-5"',
					'model_reasoning_effort = "high"',
					'[projects."C:/machine/bound"]',
					'trust_level = "trusted"',
					'[mcp_servers.ctx]',
					'command = "npx"'
				].join('\n')
			);
			writeFile(join(home.path, '.codex', 'glm.config.toml'), `[model_providers.glm]\nexperimental_bearer_token = "${SENTINEL}"\n`);

			const selection = {
				categories: [
					{tool: 'ccq' as const, category: 'mcp-library'},
					{tool: 'cc' as const, category: 'providers'},
					{tool: 'cx' as const, category: 'providers'},
					{tool: 'cx' as const, category: 'settings'},
					{tool: 'cc' as const, category: 'rules'},
					{tool: 'pi' as const, category: 'extensions'}
				],
				includeCredentials: false
			};

			const plain = await planConfigTransferExport(selection, {skills: {homeDir: home.path, tempDir}});
			expect(plain.ok).toBe(true);
			if (!plain.ok) return;

			expect(plain.data.sections.map(section => `${section.tool}:${section.category}`)).toEqual([
				'ccq:mcp-library',
				'cc:providers',
				'cx:providers',
				'cx:settings',
				'cc:rules',
				'pi:extensions'
			]);
			expect(plain.data.containsCredentials).toBe(false);
			expect(JSON.stringify(plain.data)).not.toContain(SENTINEL);
			const ccSummary = plain.data.summaries.find(summary => summary.tool === 'cc' && summary.category === 'providers');
			expect(ccSummary?.containsCredentials).toBe(false);
			expect(ccSummary?.itemCount).toBe(1);

			// Codex config.toml 只导出可迁移投影：projects 等本机绑定被过滤，Config-owned 键保留。
			const cxSettings = plain.data.sections.find(section => section.tool === 'cx' && section.category === 'settings');
			expect(JSON.stringify(cxSettings?.data)).not.toContain('projects');
			expect(JSON.stringify(cxSettings?.data)).toContain('model_reasoning_effort');
			const cxProviders = plain.data.sections.find(section => section.tool === 'cx' && section.category === 'providers');
			expect(JSON.stringify(cxProviders?.data)).toContain('gpt-5');

			const withCredentials = await planConfigTransferExport(
				{...selection, includeCredentials: true},
				{skills: {homeDir: home.path, tempDir}}
			);
			expect(withCredentials.ok).toBe(true);
			if (!withCredentials.ok) return;
			expect(withCredentials.data.containsCredentials).toBe(true);
			expect(JSON.stringify(withCredentials.data.sections)).toContain(SENTINEL);
			expect(withCredentials.data.summaries.find(summary => summary.tool === 'cc')?.containsCredentials).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('config-transfer 导入预览', () => {
	test('Codex 仅 model 投影变化不是 unchanged；合并包外 provider 后事务 postflight 成功', async () => {
		const home = createTempHome('ccq-transfer-model-preview-');
		try {
			const configPath = join(home.path, '.codex', 'config.toml');
			writeFile(
				configPath,
				'model = "local-model"\nmodel_provider = "remote"\n[model_providers.remote]\nname = "remote"\nunknown = true\n[model_providers.local_only]\nname = "local_only"\n'
			);
			const before = readText(configPath);
			const payload = payloadOf([
				{
					tool: 'cx',
					category: 'providers',
					data: {profiles: [], configProjection: {model: 'bundle-model', model_provider: 'remote'}}
				}
			]);
			const plan = await planConfigTransferImport(payload);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.data.items[0]?.status).toBe('replace');
			expect(plan.data.items[0]?.identities.replaced).toEqual(['config']);
			expect(readText(configPath)).toBe(before);
			const outcome = await applyConfigTransferImport(payload, plan.data, [], {tempDir: join(home.path, 'stage')});
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.data.status).toBe('complete');
			expect(readText(configPath)).toContain('model = "bundle-model"');
			expect(readText(configPath)).toContain('unknown = true');
			expect(readText(configPath)).toContain('[model_providers.local_only]');
			const post = await planConfigTransferImport(payload);
			expect(post.ok).toBe(true);
			if (post.ok) expect(post.data.items[0]?.status).toBe('unchanged');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('add/replace/blocked 计数、零写盘与脱敏', async () => {
		const home = createTempHome('ccq-transfer-plan-preview-');
		const tempDir = join(home.path, 'stage');
		try {
			writeJson(join(home.path, '.ccq', 'mcp-meta.json'), {
				schemaVersion: 1,
				createdAt: '',
				updatedAt: '',
				servers: {
					shared: {config: {url: 'https://old.example'}, credentials: {values: {TOKEN: SENTINEL}}},
					'local-only': {config: {url: 'https://local.example'}}
				}
			});
			writeFile(join(home.path, '.claude', 'settings.json'), '{broken');
			writeFile(join(home.path, '.pi', 'agent', 'extensions', 'existing.ts'), 'old');

			const payload = payloadOf([
				{
					tool: 'ccq',
					category: 'mcp-library',
					data: {
						schemaVersion: 1,
						containsCredentials: false,
						servers: [
							{id: 'added', config: {url: 'https://added.example'}},
							{id: 'shared', config: {url: 'https://new.example'}}
						],
						excludedCredentials: []
					}
				},
				{tool: 'cc', category: 'settings', data: {text: '{"theme":"dark"}'}},
				{tool: 'pi', category: 'extensions', data: {entries: [treeEntry('pi-agent', 'new-ext.ts', 'export {};')]}}
			]);

			const targets = [
				join(home.path, '.ccq', 'mcp-meta.json'),
				join(home.path, '.claude', 'settings.json'),
				join(home.path, '.pi', 'agent', 'extensions', 'existing.ts')
			];
			const before = fileFacts(targets);
			const plan = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(fileFacts(targets), '预览必须零写盘').toBe(before);

			const library = plan.data.items.find(item => item.tool === 'ccq');
			expect(library?.status).toBe('replace');
			expect(library?.counts).toEqual({added: 1, replaced: 1, unchanged: 0, blocked: 0});
			expect(library?.identities.added).toEqual(['added']);
			expect(library?.identities.replaced).toEqual(['shared']);

			const settings = plan.data.items.find(item => item.tool === 'cc' && item.category === 'settings');
			expect(settings?.status).toBe('blocked');
			expect(settings?.defaultAction).toBe('skip');
			expect(settings?.counts.blocked).toBe(1);

			const extensions = plan.data.items.find(item => item.category === 'extensions');
			expect(extensions?.status).toBe('add');

			const serialized = JSON.stringify(plan.data);
			expect(serialized).not.toContain(SENTINEL);
			expect(serialized).not.toContain(home.path);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('阻断分类不能强制合并，字节保持不变', async () => {
		const home = createTempHome('ccq-transfer-plan-blocked-');
		const tempDir = join(home.path, 'stage');
		try {
			writeFile(join(home.path, '.claude', 'settings.json'), '{broken');
			const payload = payloadOf([{tool: 'cc', category: 'settings', data: {text: '{"theme":"dark"}'}}]);
			const plan = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;

			const outcome = await applyConfigTransferImport(payload, plan.data, [{tool: 'cc', category: 'settings', action: 'merge'}], {
				tempDir,
				skills: {homeDir: home.path, tempDir}
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.status).toBe('complete');
			expect(outcome.data.skipped).toEqual([{tool: 'cc', category: 'settings'}]);
			expect(readText(join(home.path, '.claude', 'settings.json'))).toBe('{broken');
			expect(JSON.stringify(outcome.data)).not.toContain(home.path);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('config-transfer 分类事务', () => {
	test('merge 保留包外本机条目并写入新增条目', async () => {
		const home = createTempHome('ccq-transfer-plan-merge-');
		const tempDir = join(home.path, 'stage');
		try {
			writeJson(join(home.path, '.ccq', 'mcp-meta.json'), {
				schemaVersion: 1,
				createdAt: '',
				updatedAt: '',
				servers: {'local-only': {config: {url: 'https://local.example'}}}
			});
			writeFile(join(home.path, '.claude', 'CLAUDE.md'), '# local');
			writeFile(join(home.path, '.claude', 'rules', 'keep.md'), 'keep');
			writeFile(join(home.path, '.pi', 'agent', 'extensions', 'local.ts'), 'local');

			const payload = payloadOf([
				{
					tool: 'ccq',
					category: 'mcp-library',
					data: {
						schemaVersion: 1,
						containsCredentials: false,
						servers: [{id: 'incoming', config: {url: 'https://incoming.example'}}],
						excludedCredentials: []
					}
				},
				{
					tool: 'cc',
					category: 'rules',
					data: {entries: [treeEntry('claude', 'CLAUDE.md', '# imported'), treeEntry('claude', 'rules/x.md', 'x')]}
				},
				{tool: 'pi', category: 'extensions', data: {entries: [treeEntry('pi-agent', 'imported.ts', 'export {};')]}}
			]);

			const plan = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.data.items.map(item => item.status)).toEqual(['add', 'replace', 'add']);

			const outcome = await applyConfigTransferImport(payload, plan.data, [], {tempDir, skills: {homeDir: home.path, tempDir}});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.status).toBe('complete');
			expect(outcome.data.completed).toHaveLength(3);

			const vault = JSON.parse(readText(join(home.path, '.ccq', 'mcp-meta.json'))) as {servers: Record<string, unknown>};
			expect(Object.keys(vault.servers).sort()).toEqual(['incoming', 'local-only']);
			expect(readText(join(home.path, '.claude', 'CLAUDE.md'))).toBe('# imported');
			expect(readText(join(home.path, '.claude', 'rules', 'keep.md'))).toBe('keep');
			expect(readText(join(home.path, '.claude', 'rules', 'x.md'))).toBe('x');
			expect(readText(join(home.path, '.pi', 'agent', 'extensions', 'local.ts'))).toBe('local');
			expect(readText(join(home.path, '.pi', 'agent', 'extensions', 'imported.ts'))).toBe('export {};');

			const serialized = JSON.stringify(outcome.data);
			expect(serialized).not.toContain(SENTINEL);
			expect(serialized).not.toContain(home.path);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('分类中途失败恢复该分类全部 target 并报告 failed', async () => {
		const home = createTempHome('ccq-transfer-plan-rollback-');
		const tempDir = join(home.path, 'stage');
		try {
			const extensions = join(home.path, '.pi', 'agent', 'extensions');
			writeFile(join(extensions, 'good.ts'), 'OLD BYTES');
			writeFile(join(extensions, 'conflict.ts', 'inner.txt'), 'inner');

			const payload = payloadOf([
				{
					tool: 'pi',
					category: 'extensions',
					data: {entries: [treeEntry('pi-agent', 'good.ts', 'NEW BYTES'), treeEntry('pi-agent', 'conflict.ts', 'x')]}
				}
			]);
			const plan = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;

			const outcome = await applyConfigTransferImport(payload, plan.data, [], {tempDir, skills: {homeDir: home.path, tempDir}});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.status).toBe('failed');
			expect(outcome.data.failed).toHaveLength(1);
			expect(outcome.data.failed[0]?.restored, '回滚必须通过摘要校验').toBe(true);
			expect(readText(join(extensions, 'good.ts')), '失败分类必须完整恢复').toBe('OLD BYTES');
			expect(readText(join(extensions, 'conflict.ts', 'inner.txt'))).toBe('inner');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('前类成功、后类失败返回 partial 与真实 completed/failed 集合', async () => {
		const home = createTempHome('ccq-transfer-plan-partial-');
		const tempDir = join(home.path, 'stage');
		try {
			writeFile(join(home.path, '.claude', 'settings.json'), JSON.stringify({theme: 'light'}));
			writeFile(join(home.path, '.pi', 'agent', 'extensions', 'conflict.ts', 'inner.txt'), 'inner');

			const payload = payloadOf([
				{tool: 'cc', category: 'settings', data: {text: '{"theme":"dark"}'}},
				{tool: 'pi', category: 'extensions', data: {entries: [treeEntry('pi-agent', 'conflict.ts', 'x')]}}
			]);
			const plan = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;

			const outcome = await applyConfigTransferImport(payload, plan.data, [], {tempDir, skills: {homeDir: home.path, tempDir}});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.status).toBe('partial');
			expect(outcome.data.completed).toEqual([{tool: 'cc', category: 'settings'}]);
			expect(outcome.data.failed.map(failure => `${failure.tool}:${failure.category}`)).toEqual(['pi:extensions']);
			expect(outcome.data.notExecuted).toEqual([]);
			expect(JSON.parse(readText(join(home.path, '.claude', 'settings.json'))).theme).toBe('dark');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('取消信号在分类边界停止后续写入并记入 notExecuted', async () => {
		const home = createTempHome('ccq-transfer-plan-abort-');
		const tempDir = join(home.path, 'stage');
		try {
			writeFile(join(home.path, '.claude', 'settings.json'), JSON.stringify({theme: 'light'}));
			writeFile(join(home.path, '.pi', 'agent', 'extensions', 'keep.ts'), 'OLD');

			const payload = payloadOf([
				{tool: 'cc', category: 'settings', data: {text: '{"theme":"dark"}'}},
				{tool: 'pi', category: 'extensions', data: {entries: [treeEntry('pi-agent', 'keep.ts', 'NEW')]}}
			]);
			const plan = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;

			const controller = new AbortController();
			controller.abort();
			const outcome = await applyConfigTransferImport(payload, plan.data, [], {
				tempDir,
				skills: {homeDir: home.path, tempDir},
				signal: controller.signal
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.completed).toEqual([]);
			expect(outcome.data.notExecuted).toEqual([
				{tool: 'cc', category: 'settings'},
				{tool: 'pi', category: 'extensions'}
			]);
			expect(outcome.data.failed, '取消不是分类失败').toEqual([]);
			expect(readText(join(home.path, '.claude', 'settings.json')), '取消后不得写入任何分类').toBe('{"theme":"light"}');
			expect(readText(join(home.path, '.pi', 'agent', 'extensions', 'keep.ts'))).toBe('OLD');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('已有符号链接越界在预览阻断；过期计划在执行时也不可写到受管目录外', async () => {
		const home = createTempHome('ccq-transfer-plan-escape-');
		try {
			const root = join(home.path, '.pi', 'agent', 'extensions');
			const outside = join(home.path, 'outside');
			writeFile(join(outside, 'file.ts'), 'ORIGINAL');
			mkdirSync(root, {recursive: true});
			const payload = payloadOf([
				{tool: 'pi', category: 'extensions', data: {entries: [treeEntry('pi-agent', 'alias/file.ts', 'CHANGED')]}}
			]);
			const safePlan = await planConfigTransferImport(payload);
			expect(safePlan.ok).toBe(true);
			if (!safePlan.ok) return;
			symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
			const blocked = await planConfigTransferImport(payload);
			expect(blocked.ok && blocked.data.items[0]?.status).toBe('blocked');
			const outcome = await applyConfigTransferImport(payload, safePlan.data, [], {tempDir: join(home.path, 'stage')});
			expect(outcome.ok).toBe(true);
			expect(readText(join(outside, 'file.ts'))).toBe('ORIGINAL');
			if (outcome.ok) {
				expect(outcome.data.completed).toEqual([]);
				expect(outcome.data.failed[0]?.restored, 'stale symlink preflight must stop before taking a rollback snapshot').toBe(true);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Extensions 分类回滚同时恢复 settings.json 显式入口', async () => {
		const home = createTempHome('ccq-transfer-plan-ext-settings-');
		try {
			const root = join(home.path, '.pi', 'agent');
			const settingsPath = join(root, 'settings.json');
			writeFile(settingsPath, JSON.stringify({extensions: ['extensions/local.ts'], keep: 1}));
			writeFile(join(root, 'extensions', 'conflict.ts', 'child.ts'), 'original');
			const payload = payloadOf([
				{
					tool: 'pi',
					category: 'extensions',
					data: {
						entries: [treeEntry('pi-agent', 'new.ts', 'new'), treeEntry('pi-agent', 'conflict.ts', 'bad')],
						explicitEntries: ['extensions/new.ts']
					}
				}
			]);
			const before = readText(settingsPath);
			const plan = await planConfigTransferImport(payload);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			const outcome = await applyConfigTransferImport(payload, plan.data, [], {tempDir: join(home.path, 'stage')});
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.data.failed[0]?.restored).toBe(true);
			expect(readText(settingsPath)).toBe(before);
			expect(existsSync(join(root, 'extensions', 'new.ts'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Skills 分类经注入 lifecycle 物化后 postflight 复核目标事实', async () => {
		const source = createTempHome('ccq-transfer-plan-skills-source-');
		const target = createTempHome('ccq-transfer-plan-skills-target-');
		const tempDir = join(source.path, 'stage');
		const targetTemp = join(target.path, 'stage');
		try {
			writeFile(join(source.path, '.claude', 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: pdf skill\n---\n# pdf\n');
			const exportPlan = await planConfigTransferExport(
				{categories: [{tool: 'cc', category: 'skills'}], includeCredentials: false},
				{skills: {homeDir: source.path, tempDir}}
			);
			expect(exportPlan.ok).toBe(true);
			if (!exportPlan.ok) return;

			const skillsData = exportPlan.data.sections[0]?.data as {skills: readonly ExportedSkill[]} | undefined;
			const skills = skillsData?.skills ?? [];
			expect(skills).toHaveLength(1);
			const payload = payloadOf(exportPlan.data.sections);

			const preview = await planConfigTransferImport(payload, {skills: {homeDir: target.path, tempDir: targetTemp}});
			expect(preview.ok).toBe(true);
			if (!preview.ok) return;
			expect(preview.data.items[0]?.status).toBe('add');

			const materialize = async ({name}: {readonly name: string}) => {
				const result = materializePortableTreeEntries(join(target.path, '.claude', 'skills'), skills[0]?.files ?? [], false);
				return {ok: result.ok, ...(result.ok ? {} : {error: `物化失败：${name}`})};
			};

			const outcome = await applyConfigTransferImport(payload, preview.data, [], {
				tempDir: targetTemp,
				skills: {homeDir: target.path, tempDir: targetTemp, materialize}
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.data.status).toBe('complete');
			expect(readText(join(target.path, '.claude', 'skills', 'pdf', 'SKILL.md'))).toContain('name: pdf');
		} finally {
			source.restore();
			source.cleanup();
			target.restore();
			target.cleanup();
		}
	});
});

describe('config-transfer 事务卫生', () => {
	test('导入计划不持有 section data，便于 apply 前安全序列化', async () => {
		const home = createTempHome('ccq-transfer-plan-hygiene-');
		const tempDir = join(home.path, 'stage');
		try {
			const payload = payloadOf(
				[
					{
						tool: 'pi',
						category: 'providers',
						data: {models: {openai: {baseUrl: 'https://openai.example'}}, auth: {openai: {type: 'api_key', key: SENTINEL}}}
					}
				],
				true
			);
			const plan: ConfigTransferImportPlan = await (async () => {
				const result = await planConfigTransferImport(payload, {skills: {homeDir: home.path, tempDir}});
				if (!result.ok) throw new Error(result.error);
				return result.data;
			})();
			const serialized = JSON.stringify(plan);
			expect(serialized).not.toContain(SENTINEL);
			expect(serialized).not.toContain(home.path);
			expect(existsSync(join(home.path, '.pi', 'agent', 'auth.json'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
