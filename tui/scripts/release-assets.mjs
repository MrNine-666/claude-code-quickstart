import assert from 'node:assert/strict';
import {appendFileSync, lstatSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const contract = JSON.parse(readFileSync(new URL('../../installer/contracts/build.json', import.meta.url), 'utf8'));
export function releaseAssets(owner = 'all') {
	assert.ok(['all', 'stable', 'arm64'].includes(owner), `Unknown asset owner: ${owner}`);
	const mappings = contract.UpdateTransports.GzipAssets;
	assert.deepEqual(contract.BuildEntrypoints.ReleaseArtifacts.slice().sort(), mappings.flatMap(item => [item.Raw, item.Gzip]).sort());
	return mappings.filter(item => owner === 'all' || (item.Raw.includes('windows-arm64') === (owner === 'arm64')));
}

export function verifyReleaseAssets(directory, owner = 'all') {
	const mappings = releaseAssets(owner);
	const expected = mappings.flatMap(item => [item.Raw, item.Gzip]).sort();
	assert.deepEqual(readdirSync(directory).sort(), expected, 'Artifact directory must contain exact owned raw/gzip set');
	for (const {Raw, Gzip} of mappings) {
		assert.ok(lstatSync(join(directory, Raw)).isFile());
		assert.ok(lstatSync(join(directory, Gzip)).isFile());
		const raw = readFileSync(join(directory, Raw));
		assert.ok(raw.length > 0, `Empty artifact: ${Raw}`);
		assert.deepEqual(gunzipSync(readFileSync(join(directory, Gzip))), raw, `gzip/raw mismatch: ${Gzip}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const value = key => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
	const owner = value('owner') ?? 'all';
	const directory = value('verify');
	if (directory) verifyReleaseAssets(directory, owner);
	const paths = releaseAssets(owner).flatMap(item => [item.Raw, item.Gzip]).map(name => `dist/${name}`).join('\n');
	const output = value('github-output');
	if (output) appendFileSync(output, `paths<<CCQ_ASSETS\n${paths}\nCCQ_ASSETS\n`);
	else if (!directory) console.log(paths);
}
