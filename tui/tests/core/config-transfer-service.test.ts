import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {readConfigBundle} from '../../src/core/config-transfer.js';
import {createConfigTransferService} from '../../src/services/config-transfer-service.js';
import {createTempHome} from '../helpers/temp-home.js';

const KEY = 'TEST-API-KEY-DO-NOT-USE';
const PI_PROVIDERS = [{tool: 'pi', category: 'providers'}] as const;
function seed(home: string): void {
	const path = join(home, '.pi', 'agent', 'auth.json');
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(
		path,
		JSON.stringify({
			test: {type: 'api_key', key: KEY},
			oauth: {type: 'oauth', access: 'OAUTH-SENTINEL', refresh: 'OAUTH-SENTINEL', expires: 100}
		})
	);
}

describe('config-transfer service 明文风险选择', () => {
	test('inventory 只读返回分类计数；prepareExport 始终收集文件型密钥', async () => {
		const home = createTempHome('ccq-transfer-service-inventory-');
		try {
			seed(home.path);
			const service = createConfigTransferService();
			const inventory = await service.inventory();
			expect(inventory.ok).toBe(true);
			if (!inventory.ok) return;
			expect(inventory.data.some(category => category.tool === 'pi' && category.category === 'providers')).toBe(true);
			expect(JSON.stringify(inventory.data)).not.toContain(KEY);

			const prepared = await service.prepareExport({categories: [{tool: 'pi', category: 'providers'}]});
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			expect(prepared.data.containsCredentials, '默认导出必须真实标记含凭据').toBe(true);
			expect(JSON.stringify(prepared.data)).not.toContain(KEY);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('即使旧请求传入 includeCredentials:false 也默认收集文件型密钥；无密码明文包可解码，OAuth 排除', async () => {
		const home = createTempHome('ccq-transfer-service-plain-');
		try {
			seed(home.path);
			const service = createConfigTransferService();
			const prepared = await service.prepareExport({categories: [{tool: 'pi', category: 'providers'}]});
			expect(prepared.ok).toBe(true);
			if (!prepared.ok) return;
			expect(prepared.data.containsCredentials).toBe(true);
			expect(JSON.stringify(prepared.data)).not.toContain(KEY);
			const path = join(home.path, 'plain.ccq-backup');
			const result = await service.writeExport({targetPath: path, categories: PI_PROVIDERS, password: '', encrypt: false});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.encrypted).toBe(false);
			const parsed = readConfigBundle(path);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(parsed.data.encryption).toBeNull();
			expect(parsed.data.payload && typeof parsed.data.payload !== 'string' && parsed.data.payload.containsCredentials).toBe(true);
			expect(readFileSync(path, 'utf8')).toContain(KEY);
			expect(readFileSync(path, 'utf8')).not.toContain('OAUTH-SENTINEL');
			if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('准备全选后只写入弹窗选中的分类；无选择与越权分类拒绝写盘', async () => {
		const home = createTempHome('ccq-transfer-service-selection-');
		try {
			seed(home.path);
			const service = createConfigTransferService();
			const prepared = await service.prepareExport({
				categories: [...PI_PROVIDERS, {tool: 'ccq', category: 'mcp-library'}]
			});
			expect(prepared.ok).toBe(true);
			const path = join(home.path, 'selected.ccq-backup');
			expect((await service.writeExport({targetPath: path, categories: [], password: '', encrypt: false})).ok).toBe(false);
			expect(
				(await service.writeExport({targetPath: path, categories: [{tool: 'cc', category: 'rules'}], password: '', encrypt: false}))
					.ok
			).toBe(false);
			const written = await service.writeExport({targetPath: path, categories: PI_PROVIDERS, password: '', encrypt: false});
			expect(written.ok).toBe(true);
			const bundle = readConfigBundle(path);
			expect(bundle.ok).toBe(true);
			if (bundle.ok && bundle.data.encryption === null) {
				expect(bundle.data.payload.sections.map(section => `${section.tool}:${section.category}`)).toEqual(['pi:providers']);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('加密勾选却没有密码拒绝写盘；源端变化使准备好的计划失效', async () => {
		const home = createTempHome('ccq-transfer-service-stale-');
		try {
			seed(home.path);
			const service = createConfigTransferService();
			expect((await service.prepareExport({categories: [{tool: 'pi', category: 'providers'}]})).ok).toBe(true);
			const path = join(home.path, 'stale.ccq-backup');
			expect((await service.writeExport({targetPath: path, categories: PI_PROVIDERS, password: '', encrypt: true})).ok).toBe(false);
			seed(join(home.path, 'other'));
			const auth = join(home.path, '.pi', 'agent', 'auth.json');
			writeFileSync(auth, JSON.stringify({test: {type: 'api_key', key: 'CHANGED'}}));
			const result = await service.writeExport({targetPath: path, categories: PI_PROVIDERS, password: '', encrypt: false});
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain('CHANGED');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
