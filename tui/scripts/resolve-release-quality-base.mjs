import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareReleaseTags, parseReleaseTag} from './release-metadata.mjs';

function optionValue(args, name) {
	const prefix = `--${name}=`;
	return args.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function git(args) {
	return execFileSync('git', args, {encoding: 'utf8'}).trim();
}

/** Select the highest reachable release whose SemVer is lower than currentTag. */
export function selectPreviousReleaseTag(currentTag, candidates) {
	parseReleaseTag(currentTag);
	return candidates
		.filter(candidate => {
			try {
				return compareReleaseTags(candidate, currentTag) < 0;
			} catch {
				return false;
			}
		})
		.sort((left, right) => compareReleaseTags(right, left))[0];
}

export function resolveReleaseQualityBase(currentTag, runGit = git) {
	parseReleaseTag(currentTag);
	const taggedCommit = runGit(['rev-parse', '--verify', `${currentTag}^{commit}`]);
	let parent;
	try {
		parent = runGit(['rev-parse', '--verify', `${taggedCommit}^`]);
	} catch {
		return taggedCommit;
	}
	const candidates = runGit(['for-each-ref', `--merged=${parent}`, '--format=%(refname:strip=2)', 'refs/tags/v*'])
		.split(/\r?\n/)
		.filter(Boolean);
	return selectPreviousReleaseTag(currentTag, candidates) ?? runGit(['rev-list', '--max-parents=0', parent]);
}

export function main(args, env = process.env) {
	const tag = optionValue(args, 'tag') ?? env.GITHUB_REF_NAME;
	process.stdout.write(`${resolveReleaseQualityBase(tag)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
