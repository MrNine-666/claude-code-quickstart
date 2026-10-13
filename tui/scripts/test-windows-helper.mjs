// Native update gate. Every executable, log, home and lock belongs to this temporary root.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'win32') {
	console.log('[SKIP] Windows native synchronous update gate');
	process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), 'ccq-sync-update-'));
const saved = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR', 'CCQ_HOME', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]));
for (const key of Object.keys(saved)) process.env[key] = root;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const encoded = command => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ownedChildren = [];
function start(command) {
	const child = spawn(ps, encoded(command), {windowsHide: true, stdio: 'ignore'});
	const ended = new Promise((resolve, reject) => {
		child.once('exit', resolve);
		child.once('error', reject);
	});
	ownedChildren.push(ended);
	return ended;
}
async function waitFile(path) {
	for (let i = 0; i < 100; i++) {
		if (existsSync(path)) return;
		await sleep(50);
	}
	throw new Error('Lock fixture did not report ready');
}
let counter = 0;
function transaction(old = Buffer.from('old'), next = Buffer.from('new')) {
	const dir = join(root, `case-${counter++} 中 文 ' &()%!`);
	mkdirSync(dir);
	const targetPath = join(dir, 'ccq.exe');
	const tempPath = join(dir, `.ccq.exe.update-${process.pid}-abcdef123456.tmp`);
	writeFileSync(targetPath, old);
	writeFileSync(tempPath, next);
	const target = {
		assetName: 'ccq-windows-x64.exe',
		downloadUrl: 'https://example.invalid',
		expectedSize: next.length,
		expectedSha256: hash(next)
	};
	return {targetPath, tempPath, plan: {version: '9.0.0', target, transports: [{...target, encoding: 'identity'}]}};
}
function recordPath(tx) {
	return join(dirname(tx.targetPath), '.ccq.exe.update.json');
}
function intercept(tx, transform) {
	return (command, args, options) => {
		assert.equal(command, ps);
		assert.equal(options.shell, false);
		assert.equal(options.detached, false);
		assert.equal(options.windowsHide, true);
		const record = JSON.parse(readFileSync(recordPath(tx), 'utf8'));
		writeFileSync(record.helper, transform(readFileSync(record.helper, 'utf8'), record), 'ascii');
		return spawn(command, args, options);
	};
}
try {
	const {applyUpdate} = await import('../src/core/self-update.ts');
	const {recoverWindowsSelfUpdate} = await import('../src/core/windows-self-update.ts');
	for (const hold of [1800, 8000]) {
		const tx = transaction();
		const ready = join(dirname(tx.targetPath), 'lock-ready');
		const release = join(dirname(tx.targetPath), 'lock-release');
		const wait =
			hold === 1800
				? `[Threading.Thread]::Sleep(${hold})`
				: `$watch = [Diagnostics.Stopwatch]::StartNew(); while (-not [IO.File]::Exists(${quote(release)}) -and $watch.ElapsedMilliseconds -lt 45000) { [Threading.Thread]::Sleep(50) }`;
		const ended = start(
			`$s = [IO.File]::Open(${quote(tx.targetPath)}, 'Open', 'Read', 'Read'); try { [IO.File]::WriteAllText(${quote(ready)}, 'ready'); ${wait} } finally { $s.Dispose() }`
		);
		await waitFile(ready);
		const result = await applyUpdate(tx);
		writeFileSync(release, 'release');
		assert.equal(result.ok, hold === 1800, JSON.stringify(result));
		assert.equal(readFileSync(tx.targetPath, 'utf8'), hold === 1800 ? 'new' : 'old');
		assert.equal(existsSync(tx.tempPath), hold !== 1800);
		await ended;
		if (hold !== 1800) assert.equal((await applyUpdate(tx)).ok, true, 'long lock temp must remain retryable');
	}
	console.log('[PASS] Short/long read-no-delete locks, bounded retry and retryable temp');
	{
		const tx = transaction();
		writeFileSync(tx.tempPath, 'bad');
		assert.equal((await applyUpdate(tx)).ok, false);
		assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
	}
	for (const mode of ['spawn', 'zero', 'nonzero', 'timeout', 'timeout-applied', 'timeout-postflight', 'postflight', 'partial']) {
		const tx = transaction();
		const options =
			mode === 'spawn'
				? {spawnProcess: () => spawn(join(root, 'missing.exe'), [], {stdio: 'ignore'})}
				: {
						timeoutMs: mode === 'timeout' ? 1200 : mode.startsWith('timeout-') ? 2500 : 30000,
						spawnProcess: intercept(tx, script => {
							if (mode === 'zero') return 'exit 0';
							if (mode === 'nonzero') return script.replace('  exit 0', '  exit 7');
							if (mode === 'timeout-applied') return script.replace('  exit 0', '  [Threading.Thread]::Sleep(5000); exit 0');
							if (mode === 'timeout')
								return script.replace('$guard = $null', '[Threading.Thread]::Sleep(4000)\n$guard = $null');
							if (mode === 'timeout-postflight')
								return script.replace(
									'  if (-not (Match $TargetPath $ExpectedSize $ExpectedSha256)) { Restore; exit 1 }',
									"  [IO.File]::WriteAllText($TargetPath, 'bad'); [IO.File]::WriteAllText($RecordPath + '.corrupt', '1'); [Threading.Thread]::Sleep(5000)\n  if (-not (Match $TargetPath $ExpectedSize $ExpectedSha256)) { Restore; exit 1 }"
								);
							if (mode === 'postflight')
								return script.replace(
									'  if (-not (Match $TargetPath $ExpectedSize $ExpectedSha256)) { Restore; exit 1 }',
									"  [IO.File]::WriteAllText($TargetPath, 'bad')\n  if (-not (Match $TargetPath $ExpectedSize $ExpectedSha256)) { Restore; exit 1 }"
								);
							return script.replace(
								'[IO.File]::Replace($TempPath, $TargetPath, $BackupPath, $true)',
								'[IO.File]::Move($TargetPath, $BackupPath); exit 1'
							);
						})
					};
		const result = await applyUpdate(tx, options);
		const applied = mode === 'nonzero' || mode === 'timeout-applied';
		assert.equal(result.ok, applied, `${mode}: ${JSON.stringify(result)}`);
		assert.equal(readFileSync(tx.targetPath, 'utf8'), applied ? 'new' : 'old');
		if (applied) assert.equal(existsSync(tx.tempPath), false, 'applied temp is consumed even on child error/timeout');
		if (mode === 'postflight' || mode === 'timeout-postflight')
			assert.equal(result.error.retryStage, 'download', 'consumed bad temp must not be retried');
		if (mode === 'timeout-postflight')
			assert.equal(existsSync(recordPath(tx) + '.corrupt'), true, 'fixture must corrupt installed target before timeout');
		if (mode === 'timeout') {
			await sleep(4300);
			assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old', 'no late mutation');
		}
	}
	console.log('[PASS] Spawn/zero/nonzero/timeout facts, no late mutation, postflight and partial restoration');
	{
		const tx = transaction();
		const started = Date.now();
		const spawnProcess = intercept(tx, script =>
			script.replace('$guard = $null', '[Threading.Thread]::Sleep(1800)\nexit 1\n$guard = $null')
		);
		const result = await applyUpdate(tx, {
			timeoutMs: 200,
			spawnProcess: (command, args, options) => {
				const child = spawnProcess(command, args, options);
				child.kill = () => false; // Simulate denied termination on this owned child; it exits naturally.
				return child;
			}
		});
		assert.equal(result.ok, false);
		assert.ok(Date.now() - started >= 1800, 'denied kill cannot settle before actual exit');
		assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
	}
	console.log('[PASS] Denied kill waits for confirmed natural exit, no fixed-timeout cancellation claim');
	{
		const tx = transaction();
		const results = await Promise.all([applyUpdate(tx), applyUpdate(tx)]);
		assert.equal(results.filter(result => result.ok).length, 1, 'one per-target apply owner');
	}
	{
		const tx = transaction();
		const path = recordPath(tx);
		writeFileSync(path, '{broken');
		assert.equal((await applyUpdate(tx)).ok, false);
		await assert.rejects(recoverWindowsSelfUpdate(tx.targetPath));
		assert.equal(readFileSync(path, 'utf8'), '{broken');
	}
	const dead = spawnSync(ps, encoded('exit 0'), {windowsHide: true, stdio: 'ignore'}).pid;
	for (const mode of ['old', 'missing', 'changed', 'bad-backup', 'active', 'bad-done', 'bad-path', 'stale-image']) {
		const tx = transaction();
		const id = 'a'.repeat(24);
		const prefix = join(dirname(tx.targetPath), '.ccq.exe.update-' + id);
		const record = {
			schema: 1,
			version: '9.0.0',
			id,
			owner: mode === 'active' ? process.pid : dead,
			target: tx.targetPath,
			temp: tx.tempPath,
			backup: prefix + '.backup',
			helper: prefix + '.ps1',
			done: prefix + '.done',
			old: {size: 3, sha256: hash('old')},
			next: {size: 3, sha256: hash('new')}
		};
		if (mode === 'missing') {
			copyFileSync(tx.targetPath, record.backup);
			rmSync(tx.targetPath);
		}
		if (mode === 'changed') writeFileSync(tx.targetPath, 'legitimate later install');
		if (mode === 'stale-image') writeFileSync(tx.targetPath, 'new');
		if (mode === 'bad-backup') writeFileSync(record.backup, 'unowned bytes');
		if (mode === 'bad-done') writeFileSync(record.done, 'wrong transaction');
		if (mode === 'bad-path') record.backup = join(root, 'user-file');
		writeFileSync(recordPath(tx), JSON.stringify(record));
		if (mode === 'old' || mode === 'missing') {
			await recoverWindowsSelfUpdate(tx.targetPath);
			assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
			assert.equal(existsSync(recordPath(tx)), false);
			assert.equal(existsSync(tx.tempPath), true, 'stale recovery preserves retryable temp');
		} else {
			await assert.rejects(recoverWindowsSelfUpdate(tx.targetPath, mode === 'stale-image' ? '8.0.0' : undefined), undefined, mode);
			assert.equal(existsSync(recordPath(tx)), true, 'abnormal record preserved');
		}
	}
	{
		const tx = transaction();
		const id = 'b'.repeat(24);
		const prefix = join(dirname(tx.targetPath), '.ccq.exe.update-' + id);
		const record = {
			schema: 1,
			version: '9.0.0',
			id,
			owner: dead,
			target: tx.targetPath,
			temp: tx.tempPath,
			backup: prefix + '.backup',
			helper: prefix + '.ps1',
			done: prefix + '.done',
			old: {size: 3, sha256: hash('old')},
			next: {size: 3, sha256: hash('new')}
		};
		writeFileSync(recordPath(tx), JSON.stringify(record));
		const {buildWindowsUpdateHelperScript} = await import('../src/core/windows-self-update.ts');
		writeFileSync(
			record.helper,
			buildWindowsUpdateHelperScript().replace(
				'$guard = $null',
				"[IO.File]::WriteAllText($RecordPath + '.loaded', '1'); [Threading.Thread]::Sleep(1800)\n$guard = $null"
			),
			'ascii'
		);
		const ended = start(
			`& ${quote(record.helper)} -TempPath ${quote(tx.tempPath)} -TargetPath ${quote(tx.targetPath)} -BackupPath ${quote(record.backup)} -ExpectedSize 3 -ExpectedSha256 ${quote(hash('new'))} -OldSize 3 -OldSha256 ${quote(hash('old'))} -GuardPath ${quote(recordPath(tx) + '.lock')} -RecordPath ${quote(recordPath(tx))} -RecordContent ${quote(JSON.stringify(record))}`
		);
		await waitFile(recordPath(tx) + '.loaded');
		await recoverWindowsSelfUpdate(tx.targetPath);
		assert.equal(await ended, 1, 'loaded late helper must lose mutation authority after recovery');
		assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
		assert.equal(existsSync(tx.tempPath), true);
	}
	console.log(
		'[PASS] Exclusive ownership, stale/missing recovery, revoked late helper, unknown target/backup/path and corrupt records fail closed'
	);
	for (const mode of ['success', 'failure']) {
		const tx = transaction();
		let successor;
		const result = await applyUpdate(tx, {
			spawnProcess: intercept(tx, (script, record) => {
				successor = JSON.stringify(record).replaceAll(record.id, 'c'.repeat(24));
				const handoff = `[IO.File]::WriteAllText($RecordPath, $RecordContent.Replace('${record.id}', '${'c'.repeat(24)}')); exit 0`;
				return mode === 'success'
					? script.replace('  exit 0', '  ' + handoff)
					: script.replace('  $authorized = $true', '  ' + handoff);
			})
		});
		assert.equal(result.ok, mode === 'success');
		assert.equal(readFileSync(recordPath(tx), 'utf8'), successor, 'ended parent cannot delete successor ownership');
	}
	{
		const tx = transaction();
		const dir = dirname(tx.targetPath);
		const alias = join(root, 'alias-junction');
		symlinkSync(dir, alias, 'junction');
		try {
			const aliased = {...tx, targetPath: join(alias, 'ccq.exe'), tempPath: join(alias, 'alias-invalid.tmp')};
			assert.equal((await applyUpdate(aliased)).ok, false);
			const validAlias = {...tx, targetPath: join(alias, 'ccq.exe'), tempPath: join(alias, tx.tempPath.slice(dir.length + 1))};
			const results = await Promise.all([applyUpdate(tx), applyUpdate(validAlias)]);
			assert.equal(results.filter(result => result.ok).length, 1, 'directory aliases share one ownership record');
		} finally {
			rmdirSync(alias);
		} // Unlink junction only; never recurse into source directory.
	}
	for (const mode of ['record-bytes', 'guard-bytes']) {
		const tx = transaction();
		const result = await applyUpdate(tx, {
			spawnProcess: intercept(tx, script =>
				script.replace(
					'$guard = $null',
					mode === 'record-bytes'
						? "[IO.File]::WriteAllBytes($RecordPath, [byte[]](239,187,191) + [Text.Encoding]::UTF8.GetBytes($RecordContent))\n$guard = $null"
						: "[IO.File]::WriteAllText($GuardPath, 'not empty')\n$guard = $null"
				)
			)
		});
		assert.equal(result.ok, false, `${mode}: mutation must require exact record bytes and zero-byte guard`);
		assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
		assert.equal(existsSync(recordPath(tx)), true, 'changed ownership artifacts remain for diagnosis');
	}
	{
		const tx = transaction();
		const badName = join(dirname(tx.targetPath), '.ccq.exe.update-user.tmp');
		writeFileSync(badName, 'new');
		assert.equal((await applyUpdate({...tx, tempPath: badName})).ok, false);
		assert.equal(existsSync(recordPath(tx)), false, 'reject invalid temp namespace before journal creation');
		const guard = recordPath(tx) + '.lock';
		mkdirSync(guard);
		assert.equal((await applyUpdate(tx)).ok, false);
		assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
		rmdirSync(guard);
		writeFileSync(guard, 'not an owned zero-byte guard');
		assert.equal((await applyUpdate(tx)).ok, false, 'nonempty guard must fail closed before journal creation');
		assert.equal(existsSync(recordPath(tx)), false);
		assert.equal(readFileSync(guard, 'utf8'), 'not an owned zero-byte guard');
	}
	{
		const tx = transaction();
		rmSync(tx.targetPath);
		const result = await applyUpdate(tx, {spawnProcess: () => spawn(join(root, 'missing.exe'), [], {stdio: 'ignore'})});
		assert.equal(result.ok, false);
		assert.equal(existsSync(recordPath(tx)), false, 'absent original target can release failed ownership');
		assert.equal((await applyUpdate(tx)).ok, true, 'retry missing original target');
	}
	{
		const tx = transaction();
		const guard = recordPath(tx) + '.lock';
		const destination = join(root, 'dangling-junction-destination');
		mkdirSync(destination);
		symlinkSync(destination, guard, 'junction');
		rmdirSync(destination);
		try {
			assert.equal((await applyUpdate(tx)).ok, false, 'dangling reparse guard must not be followed');
			assert.equal(existsSync(recordPath(tx)), false);
			assert.equal(readFileSync(tx.targetPath, 'utf8'), 'old');
		} finally {
			rmdirSync(guard);
		}
	}
	console.log(
		'[PASS] Parent cleanup preserves successor records, canonical alias exclusion, invalid temp/guard and dangling reparse rejection'
	);
	const here = dirname(fileURLToPath(import.meta.url));
	const product = join(root, 'ccq-product.exe');
	const productBuild = spawnSync(
		process.execPath,
		['build', '--compile', '--no-compile-autoload-dotenv', '--outfile', product, join(here, '../src/index.tsx')],
		{encoding: 'utf8', windowsHide: true}
	);
	assert.equal(productBuild.status, 0, productBuild.stderr);
	const {CCQ_VERSION} = await import('../src/version.ts');
	for (const args of [['--version'], ['--help'], []]) {
		const smoke = spawnSync(product, args, {encoding: 'utf8', windowsHide: true});
		assert.equal(smoke.status, 0, smoke.stderr);
		if (args[0] === '--version') assert.equal(smoke.stdout.trim(), CCQ_VERSION);
		if (args.length === 0) assert.match(smoke.stdout, /TTY/);
	}
	const brokenProductRecord = join(root, '.ccq-product.exe.update.json');
	writeFileSync(brokenProductRecord, '{broken');
	const blockedVersion = spawnSync(product, ['--version'], {encoding: 'utf8', windowsHide: true});
	assert.equal(blockedVersion.status, 1, 'startup recovery precedes --version');
	assert.equal(blockedVersion.stdout, '');
	assert.equal(readFileSync(brokenProductRecord, 'utf8'), '{broken');
	rmSync(brokenProductRecord);
	console.log('[PASS] Product host compile: --version/--help/non-TTY and corrupt journal startup gate');
	for (const version of ['old', 'new']) {
		const output = join(root, version + '.exe');
		const built = spawnSync(
			process.execPath,
			[
				'build',
				'--compile',
				'--no-compile-autoload-dotenv',
				'--define',
				`PROBE_VERSION=${JSON.stringify(version)}`,
				'--outfile',
				output,
				join(here, 'windows-self-update-probe.ts')
			],
			{encoding: 'utf8', windowsHide: true}
		);
		assert.equal(built.status, 0, built.stderr);
	}
	{
		const tx = transaction(readFileSync(join(root, 'old.exe')), readFileSync(join(root, 'new.exe')));
		const request = join(dirname(tx.targetPath), 'request.json');
		writeFileSync(request, JSON.stringify(tx));
		const applied = spawnSync(tx.targetPath, ['apply', request], {encoding: 'utf8', windowsHide: true, timeout: 60000});
		assert.equal(applied.status, 0, applied.stderr);
		const facts = JSON.parse(applied.stdout);
		assert.equal(facts.result.ok, true, JSON.stringify(facts));
		assert.equal(facts.result.state, 'applied');
		assert.equal(facts.result.restartStarted, false);
		assert.equal(facts.parent, 'old');
		assert.equal(facts.immediate, 'new');
		assert.equal(facts.immediateCode, 0);
		assert.equal(existsSync(recordPath(tx)), true, 'mapped old image keeps backup journal');
		const rerun = spawnSync(tx.targetPath, ['--version'], {encoding: 'utf8', windowsHide: true});
		assert.equal(rerun.status, 0, rerun.stderr);
		assert.equal(rerun.stdout.trim(), 'new');
		assert.equal(existsSync(recordPath(tx)), false, 'startup cleans owned backup after old image exits');
		assert.equal(existsSync(join(root, 'unexpected-launch')), false, 'no implicit target launch');
	}
	console.log(
		'[PASS] Real compiled current-image replacement, immediate new invocation, old mapping, backup EACCES cleanup, Unicode and no restart'
	);
	console.log('[PASS] Windows synchronous update gate');
} finally {
	await Promise.allSettled(ownedChildren);
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, {recursive: true, force: true});
}
