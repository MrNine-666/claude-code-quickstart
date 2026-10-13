import {readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {applyUpdate, type DownloadedSelfUpdate} from '../src/core/self-update.js';
import {recoverWindowsSelfUpdate} from '../src/core/windows-self-update.js';

declare const PROBE_VERSION: string;
await recoverWindowsSelfUpdate(process.execPath, PROBE_VERSION === 'new' ? '9.0.0' : '8.0.0');
if (process.argv[2] === '--version') {
	console.log(PROBE_VERSION);
} else if (process.argv[2] === 'apply') {
	const requestPath = process.argv[3];
	if (!requestPath) throw new Error('Missing update request path');
	const transaction = JSON.parse(readFileSync(requestPath, 'utf8')) as DownloadedSelfUpdate;
	const result = await applyUpdate(transaction, {restartAfterApply: false});
	const immediate = spawnSync(process.execPath, ['--version'], {encoding: 'utf8', windowsHide: true});
	console.log(JSON.stringify({result, parent: PROBE_VERSION, immediate: immediate.stdout.trim(), immediateCode: immediate.status}));
} else {
	writeFileSync(process.env.CCQ_HOME + '/unexpected-launch', PROBE_VERSION);
}
