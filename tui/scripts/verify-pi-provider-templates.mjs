import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {loadPiProviderDisplay, piChatGptStatus} from '../src/core/pi-provider.ts';
import {piAgentDir, piAuthJsonPath} from '../src/core/paths.ts';

// [P5c 迁走] 进程内纯断言 16 条（registry OAuth 元数据 / 表单字段集与 api 单选 / 模型列表合并去重 /
// validatePiProviderForm / OAuth 凭据不完整卡片文案）→ tests/core/pi-provider-templates.test.ts 与
// tests/core/pi-provider.test.ts。本文件保留真实 ~/.pi/agent/auth.json 字节与 display 投影断言。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

const previousHome = process.env.CCQ_HOME;
const home = mkdtempSync(join(tmpdir(), 'ccq-pi-provider-form-'));
process.env.CCQ_HOME = home;
try {
	mkdirSync(piAgentDir(), {recursive: true});
	// [P5c 迁走] registry OAuth 元数据（2 条）→ tests/core/pi-provider-templates.test.ts。
	assert.equal(loadPiProviderDisplay().profiles.length, 0, '未登录/未配置的 registry provider 不应伪造列表项');

	// [P5c 迁走] 表单模型 / 模型列表合并 / validatePiProviderForm（13 条）
	// → tests/core/pi-provider-templates.test.ts；卡片描述投影（configured / invalid）
	// → tests/core/pi-provider.test.ts。此处保留真实 auth.json 字节与 display 断言。

	writeFileSync(
		piAuthJsonPath(),
		JSON.stringify({
			'openai-codex': {type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', expires: 1},
			xai: {type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: 1}
		}),
		'utf8'
	);
	assert.deepEqual(piChatGptStatus(), {loggedIn: true});
	const oauthDisplay = loadPiProviderDisplay();
	assert.equal(oauthDisplay.profiles.find(profile => profile.key === 'openai-codex')?.canEdit, false);
	assert.equal(oauthDisplay.profiles.find(profile => profile.key === 'xai')?.canDelete, false);
	assert.doesNotMatch(JSON.stringify(oauthDisplay), /secret-access|secret-refresh|xai-access/);
	// [P5e 去重] oauthDisplay 行的 '已授权登录' 文案已由 P5c 载体独占：
	// tests/core/pi-provider.test.ts > Pi 卡片描述投影 > title / summary 由 provider 元数据与凭据类型决定
	// （authKind==='oauth' + authStatus==='configured' → '已授权登录'）。

	writeFileSync(
		piAuthJsonPath(),
		JSON.stringify({
			'openai-codex': {type: 'oauth', access: 'only-access'},
			xai: {type: 'oauth', refresh: 'only-refresh'}
		}),
		'utf8'
	);
	assert.deepEqual(piChatGptStatus(), {loggedIn: false}, '缺少 access/refresh 的 OAuth 凭据不得显示为已登录');
	const incompleteOAuth = loadPiProviderDisplay();
	assert.equal(incompleteOAuth.profiles.find(profile => profile.key === 'openai-codex')?.authStatus, 'invalid');
	// [P5c 迁走] 凭据不完整卡片文案（1 条）→ tests/core/pi-provider.test.ts。
	assert.equal(
		incompleteOAuth.profiles.find(profile => profile.key === 'openai-codex')?.maskedApiKey,
		'OAuth 凭据不完整，请通过 Pi 原生 /login 修复'
	);
	assert.doesNotMatch(JSON.stringify(incompleteOAuth), /only-access|only-refresh/);
	console.log('[PASS] Pi Provider：OAuth 只读与 auth.json 字节投影（表单 / registry 纯断言见 tests/core/pi-provider-templates.test.ts）');
} finally {
	if (previousHome === undefined) delete process.env.CCQ_HOME;
	else process.env.CCQ_HOME = previousHome;
	rmSync(home, {recursive: true, force: true});
}
