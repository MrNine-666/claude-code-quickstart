import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SEMVER_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseReleaseTag(tag) {
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
		prerelease: prerelease !== undefined
	};
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
