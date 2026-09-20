import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const write = process.argv.includes('--write');
const explicitBase = process.env.CCQ_FORMAT_BASE?.trim();
const formattable = /\.(?:[cm]?[jt]sx?|jsonc?)$/i;

// 候选集语义：本地必须是 CI 的**超集**，否则会出现「本地 check 绿、CI 红」的假绿。
//   A = 自上游基线以来的已提交变更（CI 用 github.event.before；本地用 origin/main）
//   B = 工作树与暂存区相对 HEAD 的变更
//   C = 未跟踪文件
// CI checkout 干净 → B、C 恒为空，候选集与历史行为一致。
function gitLines(args) {
	const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
	}

	return result.stdout.split(/\r?\n/).filter(Boolean);
}

/** 探测用：失败返回 null 而不抛错（仅用于**自动**基线解析）。 */
function tryGitLines(args) {
	const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});

	return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : null;
}

/**
 * 自动解析上游基线：origin/main → @{upstream} → null。
 * 显式传入的 CCQ_FORMAT_BASE **不**走这里——它必须保持失败关闭（无效值让 git 非零退出、gate 失败）。
 */
function resolveAutoBase() {
	for (const ref of ['origin/main', '@{upstream}']) {
		const resolved = tryGitLines(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
		if (resolved?.length) {
			return {base: resolved[0].trim(), source: ref};
		}
	}

	return null;
}

const gitPrefix = gitLines(['rev-parse', '--show-prefix']).join('').replaceAll('\\', '/');
function relativeToTuiRoot(file) {
	const normalized = file.replaceAll('\\', '/');
	return gitPrefix && normalized.startsWith(gitPrefix)
		? normalized.slice(gitPrefix.length)
		: normalized;
}

const candidates = new Set();
const addCandidates = paths => {
	for (const file of paths) candidates.add(relativeToTuiRoot(file));
};

// 全新仓库（无提交）时 HEAD 不可解析：只保留未跟踪文件，且不报错。
const hasHead = Boolean(tryGitLines(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']));
const trackedChangeArgs = ['diff', '--name-only', '--diff-filter=ACMR'];

if (explicitBase) {
	// 显式基线：保持失败关闭（无效值让 git 非零退出、gate 失败），不做降级。
	addCandidates(gitLines([...trackedChangeArgs, `${explicitBase}...HEAD`, '--', 'src', 'tests']));
} else if (hasHead) {
	const auto = resolveAutoBase();
	if (auto) {
		console.log(`[INFO] Biome format：上游基线 ${auto.source} = ${auto.base.slice(0, 12)}`);
		addCandidates(gitLines([...trackedChangeArgs, `${auto.base}...HEAD`, '--', 'src', 'tests']));
	} else {
		console.log(
			'[INFO] Biome format：无法解析上游基线（无 origin/main 与 upstream），仅检查工作树变更与未跟踪文件'
		);
	}
} else {
	console.log('[INFO] Biome format：仓库尚无提交（HEAD 不存在），仅检查未跟踪文件');
}

if (hasHead) {
	addCandidates(gitLines([...trackedChangeArgs, 'HEAD', '--', 'src', 'tests']));
}

addCandidates(gitLines(['ls-files', '--others', '--exclude-standard', '--', 'src', 'tests']));

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
