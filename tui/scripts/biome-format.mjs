import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const write = process.argv.includes('--write');
const base = process.env.CCQ_FORMAT_BASE?.trim();
const formattable = /\.(?:[cm]?[jt]sx?|jsonc?)$/i;

function gitLines(args) {
	const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
	}

	return result.stdout.split(/\r?\n/).filter(Boolean);
}

const candidates = new Set();
const trackedArgs = base
	? ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', 'src', 'tests']
	: ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', 'src', 'tests'];

for (const file of gitLines(trackedArgs)) candidates.add(file);
for (const file of gitLines(['ls-files', '--others', '--exclude-standard', '--', 'src', 'tests'])) candidates.add(file);

const files = [...candidates].filter(file => formattable.test(file)).sort();
if (files.length === 0) {
	console.log('[PASS] Biome format：无待检查的 src/tests 变更');
	process.exit(0);
}

const executable = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.exe' : 'biome');
if (!existsSync(executable)) {
	throw new Error('Biome 未安装，请先运行 bun install --frozen-lockfile');
}

const result = spawnSync(executable, ['format', ...(write ? ['--write'] : []), ...files], {
	cwd: root,
	stdio: 'inherit'
});
process.exit(result.status ?? 1);
