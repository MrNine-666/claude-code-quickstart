import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseReleaseTagParts(tag) {
	if (typeof tag !== 'string' || !tag.startsWith('v')) {
		throw new Error(`Invalid CCQ release tag: ${String(tag)}`);
	}

	const version = tag.slice(1);
	const match = SEMVER_PATTERN.exec(version);
	if (!match) {
		throw new Error(`Invalid CCQ release version: ${version}`);
	}
	const prerelease = match[4];
	if (prerelease?.split('.').some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
		throw new Error(`Invalid CCQ release version: ${version}`);
	}

	return {
		tag,
		version,
		major: match[1],
		minor: match[2],
		patch: match[3],
		prerelease: prerelease?.split('.')
	};
}

export function parseReleaseTag(tag) {
	const parsed = parseReleaseTagParts(tag);
	return {
		tag: parsed.tag,
		version: parsed.version,
		prerelease: parsed.prerelease !== undefined
	};
}

function compareNumericIdentifiers(left, right) {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function comparePrereleaseIdentifiers(left, right) {
	if (left === undefined && right === undefined) return 0;
	if (left === undefined) return 1;
	if (right === undefined) return -1;

	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const leftIdentifier = left[index];
		const rightIdentifier = right[index];
		if (leftIdentifier === undefined) return -1;
		if (rightIdentifier === undefined) return 1;

		const leftNumeric = /^\d+$/.test(leftIdentifier);
		const rightNumeric = /^\d+$/.test(rightIdentifier);
		if (leftNumeric && rightNumeric) {
			const result = compareNumericIdentifiers(leftIdentifier, rightIdentifier);
			if (result !== 0) return result;
			continue;
		}
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		if (leftIdentifier !== rightIdentifier) return leftIdentifier < rightIdentifier ? -1 : 1;
	}

	return 0;
}

/** Compare two valid release tags using SemVer precedence; build metadata is ignored. */
export function compareReleaseTags(leftTag, rightTag) {
	const left = parseReleaseTagParts(leftTag);
	const right = parseReleaseTagParts(rightTag);
	for (const key of ['major', 'minor', 'patch']) {
		const result = compareNumericIdentifiers(left[key], right[key]);
		if (result !== 0) return result;
	}
	return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

export function injectPackageVersion(packagePath, version) {
	const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
	pkg.version = version;
	writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function writeGithubOutput(outputPath, metadata) {
	appendFileSync(outputPath, `version=${metadata.version}\nprerelease=${metadata.prerelease}\n`);
}

function optionValue(args, name) {
	const prefix = `--${name}=`;
	const argument = args.find(value => value.startsWith(prefix));
	return argument?.slice(prefix.length);
}

export function main(args, env = process.env) {
	const tag = optionValue(args, 'tag') ?? env.GITHUB_REF_NAME;
	const packagePath = optionValue(args, 'package');
	const githubOutput = optionValue(args, 'github-output');
	const metadata = parseReleaseTag(tag);

	if (packagePath) {
		injectPackageVersion(packagePath, metadata.version);
	}
	if (githubOutput) {
		writeGithubOutput(githubOutput, metadata);
	}

	process.stdout.write(`${metadata.version}\n`);
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
