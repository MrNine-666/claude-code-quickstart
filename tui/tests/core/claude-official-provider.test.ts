import {test, expect} from 'bun:test';
import {join} from 'node:path';
import {createTempHome} from '../helpers/temp-home.js';
import {parseClaudeAuthStatus, readClaudeAuthStatus} from '../../src/core/claude-auth.js';
import type {execCommand} from '../../src/core/exec.js';

const directory = join(process.cwd(), 'isolated-claude');
const result = (authMethod: string, code: number, rest = {}) => ({code, stdout: JSON.stringify({authMethod, ...rest}), stderr: ''});

test('native status JSON + exit evidence, never raw account output', () => {
	expect(parseClaudeAuthStatus(result('claude.ai', 0), directory, {}).status).toBe('configured');
	expect(parseClaudeAuthStatus(result('none', 1), directory, {}).status).toBe('missing');
	for (const method of ['api_key', 'api_key_helper', 'third_party', 'oauth_token', 'new_method']) {
		expect(parseClaudeAuthStatus(result(method, 0), directory, {}).status).toBe('unknown');
	}
	for (const evidence of [
		result('claude.ai', 1),
		result('none', 0),
		result('claude.ai', 0, {loggedIn: false}),
		result('none', 1, {loggedIn: true}),
		result('claude.ai', 0, {configDirectory: join(directory, 'other')}),
		{code: 0, stdout: 'invalid SECRET', stderr: 'SECRET'},
		{code: 0, stdout: 'x'.repeat(65537), stderr: ''}
	]) {
		const status = parseClaudeAuthStatus(evidence, directory, {});
		expect(status.status).toBe('unknown');
		expect(JSON.stringify(status)).not.toContain('SECRET');
	}
	expect(parseClaudeAuthStatus(result('claude.ai', 0), directory, {CLAUDE_CONFIG_DIR: join(directory, 'other')}).status).toBe('unknown');
	expect(parseClaudeAuthStatus(result('claude.ai', 0), directory, {ANTHROPIC_API_KEY: 'SECRET'}).status).toBe('unknown');
});

test('fixed native argv, unavailable/timeout/cancel stay unknown', async () => {
	let called = false;
	const exec: typeof execCommand = async (command, args, options) => {
		called = true;
		expect(command).toBe('claude');
		expect(args).toEqual(['auth', 'status']);
		expect(options?.timeout).toBe(5000);
		return result('none', 1);
	};
	await readClaudeAuthStatus(directory, {exec});
	expect(called).toBe(true);
	for (const message of ['ENOENT SECRET', 'timeout SECRET']) {
		const status = await readClaudeAuthStatus(directory, {
			exec: async () => {
				throw new Error(message);
			}
		});
		expect(status.status).toBe('unknown');
		expect(JSON.stringify(status)).not.toContain('SECRET');
	}
	const controller = new AbortController();
	controller.abort();
	called = false;
	expect((await readClaudeAuthStatus(directory, {exec, signal: controller.signal})).status).toBe('unknown');
	expect(called).toBe(false);
});

test('late native success after abort cannot reveal official row', async () => {
	const controller = new AbortController();
	let complete!: (value: ReturnType<typeof result>) => void;
	const query = readClaudeAuthStatus(directory, {
		signal: controller.signal,
		exec: async (_command, _args, options) => {
			expect(options?.signal).toBe(controller.signal);
			return new Promise(resolve => { complete = resolve; });
		}
	});
	controller.abort();
	complete(result('claude.ai', 0));
	expect(await query).toEqual({status: 'unknown', reason: '授权状态查询已取消'});
});

test('isolated filesystem, CLI/UI projection and transfer contract', async () => {
	const home = createTempHome('ccq-claude-official-');
	try {
		for (const [file, marker] of [
			['claude-official-probe.ts', 'Claude official isolated probe passed'],
			['claude-official-ui-probe.tsx', 'Claude official UI isolated probe passed']
		]) {
			const child = Bun.spawn([process.execPath, join(import.meta.dir, '../helpers/', file!)], {
				env: {...process.env},
				stdout: 'pipe',
				stderr: 'pipe'
			});
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited
			]);
			expect(stderr).toBe('');
			expect(stdout).toContain(marker!);
			expect(exit).toBe(0);
		}
	} finally {
		home.restore();
		home.cleanup();
	}
}, 30000);
