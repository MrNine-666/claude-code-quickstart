import {describe, expect, test} from 'bun:test';
import type {execCommand} from '../../src/core/exec.js';
import {packageFromManifest, piPackageDetailsUrl, searchPiPackageCatalogPage} from '../../src/core/extensions.js';
import {createInitialExtensionsViewState} from '../../src/state/extensions-view-state.js';

// P5d 迁移自 scripts/verify-extensions-view.mjs 的「非 render、未被既有载体覆盖」段（10 条静态断言）。
// 判据：初始 View 状态、npm registry 目录页元数据与 packageFromManifest 派生均为进程内投影
// （request / exec 注入缝），无真实 fs / 子进程 / 渲染。
// R9：同脚本的 reducer / input / footer 断言已由 tests/core/extensions-view-state.test.ts 与
// tests/core/extensions-view-input.test.ts 覆盖（逐条比对见对账 §R9），按 R9 不重复迁移，保留在 verify 待 P5e 去重。

type ExecFn = typeof execCommand;

describe('Extensions View 初始状态', () => {
	test('从菜单进入扩展管理时初始焦点应在列表', () => {
		expect(createInitialExtensionsViewState().focus, '从菜单进入扩展管理时初始焦点应在列表').toBe('grid');
	});
});

describe('piPackageDetailsUrl 官网详情链接', () => {
	test('npm:<name> 映射到 pi.dev 包页', () => {
		expect(piPackageDetailsUrl('npm:tool-b')).toBe('https://pi.dev/packages/tool-b');
	});
});

describe('registry 目录页元数据', () => {
	test('分页参数与 downloads / publishedAt / resourceTypes / bugsUrl 派生', async () => {
		const catalogUrls: string[] = [];
		const catalogPage = await searchPiPackageCatalogPage('mcp', 0, {
			request: async url => {
				catalogUrls.push(url);
				return {
					ok: true,
					status: 200,
					async json() {
						return {
							objects: [
								{
									downloads: {monthly: 761442},
									package: {
										name: 'pi-mcp-adapter',
										keywords: ['pi-package'],
										date: '2026-09-01T21:11:07.693Z',
										links: {
											npm: 'https://www.npmjs.com/package/pi-mcp-adapter',
											repository: 'https://github.com/nicobailon/pi-mcp-adapter',
											bugs: 'https://github.com/nicobailon/pi-mcp-adapter/issues'
										}
									}
								}
							],
							total: 1
						};
					}
				};
			},
			exec: (async () => ({
				code: 0,
				stdout: JSON.stringify({
					name: 'pi-mcp-adapter',
					version: '2.32.1',
					description: 'MCP adapter',
					author: {name: 'nicopreme'},
					repository: 'https://github.com/nicobailon/pi-mcp-adapter',
					pi: {extensions: ['index.ts'], skills: ['skill.md']}
				}),
				stderr: ''
			})) as unknown as ExecFn
		});
		expect(catalogUrls[0]).toMatch(/size=20/);
		expect(catalogUrls[0]).toMatch(/from=0/);
		expect(catalogPage.items[0]!.monthlyDownloads).toBe(761442);
		expect(catalogPage.items[0]!.publishedAt).toBe('2026-09-01T21:11:07.693Z');
		expect(catalogPage.items[0]!.resourceTypes).toEqual(['extension', 'skill']);
		expect(catalogPage.items[0]!.bugsUrl).toBe('https://github.com/nicobailon/pi-mcp-adapter/issues');
	});

	test('packageFromManifest 从 bugs.url 与 time 派生 publishedAt / bugsUrl', () => {
		const manifestPackage = packageFromManifest({
			name: 'x',
			version: '1.0.0',
			pi: {extensions: ['index.ts']},
			bugs: {url: 'https://example.test/issues'},
			time: {'1.0.0': '2026-09-01T00:00:00.000Z'}
		});
		expect(manifestPackage?.publishedAt).toBe('2026-09-01T00:00:00.000Z');
		expect(manifestPackage?.bugsUrl).toBe('https://example.test/issues');
	});
});
