import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseAssets, verifyReleaseAssets} from './release-assets.mjs';
import {parseReleaseTag} from './release-metadata.mjs';

// Publish only after all remote bytes are verified; failed uploads remain a retryable draft.
export async function publishRelease({directory, repository, tag, token, fetch: request = fetch}) {
	verifyReleaseAssets(directory);
	assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
	assert.ok(token, 'GitHub token is required');
	const metadata = parseReleaseTag(tag);
	const expected = releaseAssets().flatMap(item => [item.Raw, item.Gzip]).map(name => {
		const bytes = readFileSync(join(directory, name));
		return {name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`};
	});
	const base = `https://api.github.com/repos/${repository}`;
	async function api(url, method = 'GET', body, allowMissing = false) {
		const binary = Buffer.isBuffer(body);
		const response = await request(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'User-Agent': 'ccq-release',
				'X-GitHub-Api-Version': '2022-11-28',
				'Content-Type': binary ? 'application/octet-stream' : 'application/json'
			},
			body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
			signal: AbortSignal.timeout(300_000)
		});
		if (allowMissing && response.status === 404) return null;
		assert.ok(response.ok, `GitHub Release ${method} failed: HTTP ${response.status}`);
		return response.status === 204 ? null : response.json();
	}
	let release = await api(`${base}/releases/tags/${encodeURIComponent(tag)}`, 'GET', undefined, true);
	if (!release) {
		release = await api(`${base}/releases`, 'POST', {
			tag_name: tag, name: tag, draft: true, prerelease: metadata.prerelease, generate_release_notes: true
		});
	}
	assert.ok(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid Release id');
	const releaseUrl = `${base}/releases/${release.id}`;
	async function listAssets() {
		const assets = [];
		for (let page = 1; ; page++) {
			const batch = await api(`${releaseUrl}/assets?per_page=100&page=${page}`);
			assert.ok(Array.isArray(batch), 'Invalid Release asset list');
			assets.push(...batch);
			if (batch.length < 100) return assets;
		}
	}
	function verifyRemote(assets) {
		assert.deepEqual(assets.map(asset => asset.name).sort(), expected.map(asset => asset.name).sort(), 'Remote Release must contain exact raw/gzip set');
		for (const local of expected) {
			const remote = assets.find(asset => asset.name === local.name);
			assert.equal(remote.state, 'uploaded', `Incomplete remote asset: ${local.name}`);
			assert.equal(remote.size, local.size, `Remote size mismatch: ${local.name}`);
			assert.equal(remote.digest, local.digest, `Remote digest mismatch: ${local.name}`);
		}
	}
	const assets = await listAssets();
	if (!release.draft) {
		// Never rewrite a public Release while old clients may be downloading it.
		verifyRemote(assets);
		assert.equal(release.prerelease, metadata.prerelease, 'Published prerelease metadata mismatch');
		return;
	}
	for (const asset of assets) {
		assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset id');
		await api(`${base}/releases/assets/${asset.id}`, 'DELETE');
	}
	for (const asset of expected) {
		await api(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, 'POST', readFileSync(join(directory, asset.name)));
	}
	verifyRemote(await listAssets());
	const rawBase = `https://raw.githubusercontent.com/${repository}/main/dist`;
	const installerNotes = [
		'## 安装',
		'安装脚本由维护者人工打包并提交 main/dist，使用无版本 Raw 地址。此 Release 仅含 TUI 二进制与 gzip；脚本默认下载最新稳定版二进制。',
		'',
		'Windows 完整安装：',
		'```powershell',
		'Set-ExecutionPolicy Bypass -Scope Process -Force',
		`irm '${rawBase}/install.ps1' | iex`,
		'```',
		'macOS 完整安装：',
		'```sh',
		`curl -fsSL "${rawBase}/install.sh" | bash`,
		'```',
		'只装 ccq：',
		'```powershell',
		`irm '${rawBase}/download-tui.ps1' | iex`,
		'```',
		'```sh',
		`curl -fsSL "${rawBase}/download-tui.zsh" | zsh`,
		'```',
		'旧 releases/latest/download/install.* 与 download-ccq.* 入口请改用以上 Raw 命令。已有 ccq 请运行 `ccq update`。'
	].join('\n');
	const published = await api(releaseUrl, 'PATCH', {
		draft: false, prerelease: metadata.prerelease, make_latest: 'legacy',
		body: [release.body, installerNotes].filter(Boolean).join('\n\n')
	});
	assert.equal(published.draft, false, 'Release was not published');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await publishRelease({directory: 'dist', repository: process.env.GITHUB_REPOSITORY, tag: process.env.GITHUB_REF_NAME, token: process.env.GITHUB_TOKEN});
	console.log('[PASS] Published verified raw/gzip Release');
}
