import {describe, expect, test} from 'bun:test';
import {
	CONFIG_BUNDLE_VERSION,
	createBundlePayload,
	decryptBundlePayload,
	encryptBundlePayload,
	parseBundleEnvelope,
	parseConfigBundleText,
	serializeConfigBundle
} from '../../src/core/config-transfer.js';

const skillMd = Buffer.from('---\nname: x\ndescription: d\n---\nbody\n').toString('base64');
const files = [{kind: 'file', root: 'agents', path: 'x/SKILL.md', contentBase64: skillMd, mode: 0o644}];
const tracking = {kind: 'global-lock-v3', entry: {source: 'o/r', sourceType: 'github', sourceUrl: 'https://github.com/o/r.git'}};
const v2Skills = {schema: 2, root: 'agents', skills: [{id: 'x#1', name: 'x', files, tracking}]};
const v1Skills = {root: 'agents', skills: [{id: 'x#1', name: 'x', files}]};

function payloadOf(data: unknown) {
	return {
		createdAt: 'now',
		createdBy: {name: 'ccq', version: 'test', platform: 'test'},
		containsCredentials: false,
		sections: [{tool: 'ccq', category: 'skills', data}]
	};
}

function roundtripText(envelope: unknown) {
	const text = JSON.stringify(envelope);
	return parseConfigBundleText(text);
}

describe('envelope v1/v2 兼容', () => {
	test('新包写 v2；明文与加密往返保留版本与 tracking', async () => {
		expect(CONFIG_BUNDLE_VERSION).toBe(2);
		const created = createBundlePayload({
			sections: payloadOf(v2Skills).sections as never,
			containsCredentials: false,
			version: 't',
			platform: 'p'
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const plain = roundtripText({format: 'ccq-config-bundle', version: 2, encryption: null, payload: created.data});
		expect(plain.ok && plain.data.version).toBe(2);
		if (!plain.ok) return;
		const decodedPlain = await decryptBundlePayload(plain.data);
		expect(decodedPlain.ok && decodedPlain.data.sections[0]?.data).toEqual(v2Skills);

		const encrypted = await encryptBundlePayload(created.data, 'pw');
		expect(encrypted.ok && encrypted.data.version).toBe(2);
		if (!encrypted.ok) return;
		const serialized = serializeConfigBundle(encrypted.data);
		expect(serialized.ok && serialized.data).not.toContain('github.com');
		const reread = serialized.ok ? parseConfigBundleText(serialized.data) : serialized;
		expect(reread.ok).toBe(true);
		if (!reread.ok) return;
		const decrypted = await decryptBundlePayload(reread.data, 'pw');
		expect(decrypted.ok && decrypted.data.sections[0]?.data).toEqual(v2Skills);
		expect((await decryptBundlePayload(reread.data, 'wrong')).ok).toBe(false);
	});

	test('旧 v1 明文/加密内容包仍可读取，版本不被改写', async () => {
		const plain = roundtripText({format: 'ccq-config-bundle', version: 1, encryption: null, payload: payloadOf(v1Skills)});
		expect(plain.ok && plain.data.version).toBe(1);

		const encrypted = await encryptBundlePayload(payloadOf(v1Skills) as never, 'pw');
		expect(encrypted.ok).toBe(true);
		if (!encrypted.ok) return;
		const v1 = parseBundleEnvelope({...encrypted.data, version: 1});
		expect(v1.ok && v1.data.version).toBe(1);
		if (!v1.ok) return;
		const decrypted = await decryptBundlePayload(v1.data, 'pw');
		expect(decrypted.ok && decrypted.data.sections[0]?.data).toEqual(v1Skills);
	});

	test('未知未来版本拒绝；Skills schema 与 envelope 版本不一致拒绝', () => {
		const future = roundtripText({format: 'ccq-config-bundle', version: 3, encryption: null, payload: payloadOf(v2Skills)});
		expect(future).toMatchObject({ok: false, error: '不支持的导出包版本：3'});
		expect(roundtripText({format: 'ccq-config-bundle', version: 2, encryption: null, payload: payloadOf(v1Skills)}).ok).toBe(false);
		expect(roundtripText({format: 'ccq-config-bundle', version: 1, encryption: null, payload: payloadOf(v2Skills)}).ok).toBe(false);
	});
});
