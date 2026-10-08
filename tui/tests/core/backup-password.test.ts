import type {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import {createBackupPasswordStore} from '../../src/core/backup-password.js';
import {createTempHome} from '../helpers/temp-home.js';

type Runner = typeof spawnSync;
function result(status: number, stdout = ''): ReturnType<Runner> {
	return {status, stdout, stderr: '', error: undefined, pid: 1, output: [], signal: null} as ReturnType<Runner>;
}

test('macOS Keychain 通过 stdin hex 保存，不将密码放进 argv 或错误', () => {
	const calls: {args: readonly string[]; input?: string}[] = [];
	let stored = '';
	const run = ((_cmd: string, args: string[], options?: {input?: string}) => {
		calls.push({args, input: options?.input});
		if (args[0] === '-i') {
			stored = Buffer.from(options?.input?.match(/-X ([a-f0-9]+)/u)?.[1] ?? '', 'hex').toString('utf8');
			return result(0);
		}
		if (args[0] === 'delete-generic-password') {
			stored = '';
			return result(0);
		}
		return stored ? result(0, `${stored}\n`) : result(44);
	}) as Runner;
	const store = createBackupPasswordStore({platform: 'darwin', run});
	expect(store.load()).toEqual({ok: true, value: null});
	expect(store.save('fake secret')).toEqual({ok: true, value: undefined});
	expect(store.load()).toEqual({ok: true, value: 'fake secret'});
	expect(calls.every(call => !call.args.join(' ').includes('fake secret'))).toBe(true);
	expect(store.clear()).toEqual({ok: true, value: undefined});
	expect(store.load()).toEqual({ok: true, value: null});
});

test('Windows DPAPI 持久化文件不含明文，损坏拒绝而不覆盖', () => {
	const temp = createTempHome('ccq-password');
	try {
		const file = join(temp.path, 'secret.dpapi');
		const run = ((_cmd: string, args: string[], options?: {input?: string}) => {
			const script = Buffer.from(args[3] ?? '', 'base64').toString('utf16le');
			if (script.includes("'protect' -eq 'protect'"))
				return result(0, Buffer.from(`cipher:${options?.input ?? ''}`).toString('base64'));
			const text = Buffer.from(options?.input ?? '', 'base64').toString('utf8');
			return text.startsWith('cipher:') ? result(0, text.slice(7)) : result(1);
		}) as Runner;
		const store = createBackupPasswordStore({platform: 'win32', run, windowsFile: file});
		expect(store.load()).toEqual({ok: true, value: null});
		expect(store.save('fake secret')).toEqual({ok: true, value: undefined});
		expect(readFileSync(file, 'utf8')).not.toContain('fake secret');
		expect(store.load()).toEqual({ok: true, value: 'fake secret'});
		writeFileSync(file, 'damaged');
		expect(store.load()).toMatchObject({ok: false});
		expect(readFileSync(file, 'utf8')).toBe('damaged');
		expect(store.clear()).toEqual({ok: true, value: undefined});
		expect(existsSync(file)).toBe(false);
	} finally {
		temp.restore();
		temp.cleanup();
	}
});
