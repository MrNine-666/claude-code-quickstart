import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, test} from 'bun:test';
import {writeJsonAtomic} from '../../src/core/fs-utils.js';

describe('atomic file writes', () => {
	test('replaces an existing JSON file', () => {
		const directory = join(tmpdir(), `ccq-fs-utils-${process.pid}`);
		const filePath = join(directory, 'models.json');
		mkdirSync(directory, {recursive: true});
		try {
			writeFileSync(filePath, JSON.stringify({version: 1}), 'utf8');
			writeJsonAtomic(filePath, {version: 2});
			expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({version: 2});
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	test('retries a transient Windows target lock before replacing the file', async () => {
		if (process.platform !== 'win32') return;

		const directory = join(tmpdir(), `ccq-fs-utils-lock-${process.pid}`);
		const filePath = join(directory, 'models.json');
		mkdirSync(directory, {recursive: true});
		const escapedPath = filePath.replaceAll("'", "''");
		const locker = spawn(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				`$stream = [IO.File]::Open('${escapedPath}', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::Out.WriteLine('LOCKED'); Start-Sleep -Milliseconds 150; $stream.Dispose()`
			],
			{stdio: ['ignore', 'pipe', 'pipe']}
		);

		try {
			writeFileSync(filePath, JSON.stringify({version: 1}), 'utf8');
			const locked = new Promise<void>((resolve, reject) => {
				locker.stdout?.on('data', chunk => {
					if (String(chunk).includes('LOCKED')) resolve();
				});
				locker.once('error', reject);
			});
			await locked;
			writeJsonAtomic(filePath, {version: 2});
			expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({version: 2});
		} finally {
			if (locker.exitCode === null) {
				locker.kill();
				await once(locker, 'close').catch(() => undefined);
			}
			if (existsSync(filePath)) rmSync(filePath, {force: true});
			rmSync(directory, {recursive: true, force: true});
		}
	});
});
