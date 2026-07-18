import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	addProvider,
	editProvider,
	switchProvider
} from '../src/core/provider.ts';
import {
	saveCodexProfile,
	saveCodexProfileToml,
	scanCodexProfiles,
	setDefaultCodexProfile,
	writeCodexAuthJson
} from '../src/core/codex.ts';
import {buildCodexForm, removeCodexProvider, saveCodexProviderForm} from '../src/services/codex-service.ts';
import {saveProviderForm} from '../src/services/provider-service.ts';
import {runLs} from '../src/cli/commands/ls.ts';
import {runUse} from '../src/cli/commands/use.ts';
import {atomicWrite} from '../src/core/fs-utils.ts';

function temporaryHome(prefix) {
	const home = mkdtempSync(join(tmpdir(), prefix));
	process.env.CCQ_HOME = home;
	return home;
}

function cleanupHome(home) {
	rmSync(home, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
}

function claudeValues(overrides = {}) {
	return {
		profileKey: 'provider',
		baseUrl: 'https://provider.test/anthropic',
		apiKey: 'fixture-provider-token',
		modelEnv: {},
		env: {},
		activateAfterSave: false,
		providerType: 'custom',
		...overrides
	};
}

function assertSecretMode(filePath, label) {
	assert.equal(existsSync(filePath), true, `${label} 应存在`);
	if (process.platform !== 'win32') {
		assert.equal(statSync(filePath).mode & 0o777, 0o600, `${label} mode 必须为 0600`);
	}
}

// ── R1/R6：损坏 JSON 保持原样 + 保存/激活部分成功 ───────────────────────────
{
	const home = temporaryHome('ccq-provider-safe-json-');
	try {
		const claudeDir = join(home, '.claude');
		const providers = join(claudeDir, 'providers');
		const settings = join(claudeDir, 'settings.json');
		mkdirSync(providers, {recursive: true});
		addProvider({profileKey: 'switch-target', baseUrl: 'https://switch.test', apiKey: 'fixture-switch-token'});
		const switchProfilePath = join(providers, 'switch-target.json');
		const switchProfileBefore = readFileSync(switchProfilePath, 'utf8');
		writeFileSync(settings, '{ broken settings', 'utf8');
		assert.throws(() => switchProvider('switch-target'), /settings\.json.*损坏|无法解析/, '损坏 settings 必须拒绝切换');
		assert.equal(readFileSync(settings, 'utf8'), '{ broken settings', 'switch 不得覆盖损坏 settings');
		assert.throws(
			() => editProvider('switch-target', {baseUrl: 'https://edited-before-fix.test'}),
			/settings\.json.*损坏|无法解析/,
			'损坏 settings 下 edit-sync 必须在修改 profile 前中止'
		);
		assert.equal(readFileSync(switchProfilePath, 'utf8'), switchProfileBefore, 'edit-sync 失败不得修改 profile');

		const partial = saveProviderForm(
			{mode: 'add-custom'},
			claudeValues({profileKey: 'partial', activateAfterSave: true})
		);
		assert.equal(partial.ok, true, 'profile 已保存时返回部分成功而非完全失败');
		assert.equal(Boolean(partial.ok && partial.warning?.includes('激活失败')), true, '部分成功必须带激活失败 warning');
		assert.equal(existsSync(join(providers, 'partial.json')), true, '部分成功保留已保存 profile');
		assert.equal(readFileSync(settings, 'utf8'), '{ broken settings', 'add-and-activate 不得覆盖损坏 settings');

		const claudeJson = join(home, '.claude.json');
		writeFileSync(claudeJson, '{ broken claude json', 'utf8');
		const onboarding = saveProviderForm(
			{mode: 'add-custom'},
			claudeValues({profileKey: 'onboarding'})
		);
		assert.equal(onboarding.ok, true, 'onboarding 损坏不阻止 profile 保存');
		assert.equal(Boolean(onboarding.ok && onboarding.warning?.includes('onboarding')), true, '跳过 onboarding 写入必须返回 warning');
		assert.equal(readFileSync(claudeJson, 'utf8'), '{ broken claude json', '不得覆盖损坏 .claude.json');
	} finally {
		cleanupHome(home);
	}
}
console.log('[PASS] Provider 损坏 JSON 保护 + 部分成功 warning');

// ── R2：活跃 edit 删除旧 extra/model env ─────────────────────────────────────
{
	const home = temporaryHome('ccq-provider-owned-env-');
	try {
		const claudeDir = join(home, '.claude');
		mkdirSync(join(claudeDir, 'providers'), {recursive: true});
		writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({env: {GLOBAL_KEEP: 'yes'}}), 'utf8');
		addProvider({
			profileKey: 'active',
			baseUrl: 'https://active.test',
			apiKey: 'fixture-active-token',
			modelEnv: {ANTHROPIC_DEFAULT_OPUS_MODEL: 'old-model'},
			env: {REMOVED_LATER: 'stale'},
			activate: true
		});
		editProvider('active', {
			baseUrl: 'https://active.test',
			apiKey: 'fixture-active-token',
			modelEnv: null,
			env: {}
		});
		const env = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).env;
		assert.equal(env.REMOVED_LATER, undefined, 'edit 后不得残留已删除 extra env');
		assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined, 'edit 后不得残留已删除模型键');
		assert.equal(env.GLOBAL_KEEP, 'yes', '非 provider env 必须保留');
	} finally {
		cleanupHome(home);
	}
}
console.log('[PASS] 活跃 Provider edit 清理旧 env 所有权');

// ── R3：TUI add 拒绝同名，edit 正常覆盖当前 profile ─────────────────────────
{
	const home = temporaryHome('ccq-provider-conflict-');
	try {
		mkdirSync(join(home, '.claude', 'providers'), {recursive: true});
		const first = saveProviderForm({mode: 'add-custom'}, claudeValues({profileKey: 'same'}));
		assert.equal(first.ok, true, '首次 custom add 成功');
		const duplicate = saveProviderForm(
			{mode: 'add-custom'},
			claudeValues({profileKey: 'same', baseUrl: 'https://overwrite.test'})
		);
		assert.equal(duplicate.ok, false, '同名 custom add 必须拒绝');
		assert.equal(duplicate.ok ? undefined : duplicate.errorKind, 'conflict', 'Claude 同名 add 必须标记 toast 冲突');
		const samePath = join(home, '.claude', 'providers', 'same.json');
		assert.equal(JSON.parse(readFileSync(samePath, 'utf8')).env.ANTHROPIC_BASE_URL, 'https://provider.test/anthropic', '拒绝后原文件不变');

		const builtinCopy = claudeValues({
			profileKey: 'glm-2',
			providerType: 'glm',
			baseUrl: 'https://open.bigmodel.cn/api/anthropic'
		});
		assert.equal(saveProviderForm({mode: 'add-builtin', builtinKey: 'glm'}, builtinCopy).ok, true, '不同文件名的 builtin 可独立新增');
		const builtin = {...builtinCopy, profileKey: 'glm'};
		assert.equal(saveProviderForm({mode: 'add-builtin', builtinKey: 'glm'}, builtin).ok, true, '首次 builtin add 成功');
		const duplicateBuiltin = saveProviderForm({mode: 'add-builtin', builtinKey: 'glm'}, builtin);
		assert.equal(duplicateBuiltin.ok, false, '同名 builtin add 也必须拒绝');
		assert.equal(duplicateBuiltin.ok ? undefined : duplicateBuiltin.errorKind, 'conflict', 'builtin 冲突必须标记 toast');
		assert.equal(existsSync(join(home, '.claude', 'providers', 'glm-3.json')), false, 'TUI 不得自动递增文件名');

		const edited = saveProviderForm(
			{mode: 'edit', profileKey: 'same'},
			claudeValues({profileKey: 'same', baseUrl: 'https://edited.test'})
		);
		assert.equal(edited.ok, true, 'edit 正常覆盖当前 profile');
		assert.equal(JSON.parse(readFileSync(samePath, 'utf8')).env.ANTHROPIC_BASE_URL, 'https://edited.test');
	} finally {
		cleanupHome(home);
	}
}
console.log('[PASS] TUI add 同名拒绝 + edit 当前 profile 覆盖');

// ── R5/R7：Codex TOML 边界 + 损坏 profile 逐文件容错/CLI warning ─────────────
{
	const home = temporaryHome('ccq-provider-codex-safe-');
	try {
		const codexDir = join(home, '.codex');
		mkdirSync(codexDir, {recursive: true});
		const base = [
			'model = "model-x"',
			'model_provider = "safe"',
			'',
			'[model_providers.safe]',
			'name = "safe"',
			'base_url = "https://safe.test/v1"',
			'experimental_bearer_token = "fixture-codex-token"'
		].join('\n');
		const invalidCases = [
			`profile = "legacy"\n${base}\n`,
			`${base}\nenv_key = "OTHER_TOKEN"\n`,
			`${base}\n[model_providers.other]\nname = "other"\n`,
			base.replace('name = "safe"', 'name = "different"')
		];
		for (const raw of invalidCases) {
			assert.throws(() => saveCodexProfileToml('safe', raw), /legacy|env_key|唯一|名称|model_providers/, '非法 raw TOML 必须拒绝');
		}
		assert.equal(existsSync(join(codexDir, 'safe.config.toml')), false, '非法 TOML 不得写盘');
		const unsafePath = join(codexDir, 'unsafe.config.toml');
		const unsafeRaw = base
			.replaceAll('safe', 'unsafe')
			.concat('\nenv_key = "fixture-unsafe-env"\n');
		writeFileSync(unsafePath, unsafeRaw, 'utf8');
		const unsafeScan = scanCodexProfiles();
		assert.equal(unsafeScan.failures.some(item => item.key === 'unsafe'), true, '手工违规 profile 必须进入失败集合');
		assert.throws(() => setDefaultCodexProfile('unsafe'), /env_key/, '手工违规 profile 不得设为默认');
		rmSync(unsafePath, {force: true});
		const legal = `${base}\nwire_api = "responses"\n`;
		saveCodexProfileToml('safe', legal);
		const safeModel = buildCodexForm({mode: 'add', providerType: 'custom'});
		const safeValues = {
			...safeModel.values,
			profileKey: 'safe',
			providerType: 'custom',
			baseUrl: 'https://safe.test/v1',
			model: 'model-x',
			apiKey: 'fixture-codex-token',
			toml: legal,
			activateAfterSave: false
		};
		const duplicateCodex = saveCodexProviderForm({mode: 'add', providerType: 'custom'}, safeValues);
		assert.equal(duplicateCodex.ok, false, 'Codex TUI 同名 add 必须拒绝');
		assert.equal(duplicateCodex.ok ? undefined : duplicateCodex.errorKind, 'conflict', 'Codex 冲突必须标记 toast');
		const edited = saveCodexProviderForm(
			{mode: 'edit', profileKey: 'safe', providerType: 'custom'},
			{...safeValues, model: 'model-y', toml: legal.replace('model-x', 'model-y')}
		);
		assert.equal(edited.ok, true, 'Codex edit 正常覆盖当前 profile');
		assert.match(readFileSync(join(codexDir, 'safe.config.toml'), 'utf8'), /model\s*=\s*"model-y"/);
		writeFileSync(join(codexDir, 'broken.config.toml'), 'experimental_bearer_token = "fixture-secret-unterminated', 'utf8');

		const scan = scanCodexProfiles();
		assert.deepEqual(scan.profiles.map(item => item.key), ['safe', 'official'], '有效 profile + official 仍可列出');
		assert.equal(scan.failures.length, 1, '损坏 profile 进入失败集合');
		assert.equal(scan.failures[0].key, 'broken');
		assert.equal(scan.failures[0].reason.includes('fixture-secret-unterminated'), false, '失败原因不得泄漏 token');
		const removeBroken = removeCodexProvider('broken');
		assert.equal(removeBroken.ok, false, '损坏 profile 删除失败必须返回结构化错误');
		assert.equal(removeBroken.ok ? false : removeBroken.error.includes('fixture-secret-unterminated'), false, '删除错误不得泄漏 token');

		const logs = [];
		const errors = [];
		const originalLog = console.log;
		const originalError = console.error;
		console.log = value => logs.push(String(value));
		console.error = value => errors.push(String(value));
		try {
			assert.equal(runLs('codex'), 0, '单个损坏 profile 不得让 ls 失败');
			assert.equal(runUse('broken', 'codex'), 1, '损坏 profile 不得设为默认');
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
		assert.equal(logs.some(line => line.includes('safe')), true, 'CLI stdout 保留有效 profile');
		assert.equal(errors.some(line => line.includes('broken')), true, 'CLI stderr 提示损坏文件');
		assert.equal(errors.some(line => line.includes('供应商')), true, 'Codex CLI 用户文案必须直接使用供应商');
		assert.doesNotMatch(errors.join('\n'), /Codex (?:profiles?|providers?|供应商)/, 'Codex CLI 用户文案不得给供应商添加 Codex 前缀或使用 profile/provider');
		assert.equal(errors.join('\n').includes('fixture-secret-unterminated'), false, 'CLI warning/use 错误不泄漏 token');

		const corruptConfig = join(codexDir, 'config.toml');
		writeFileSync(corruptConfig, 'model = "unterminated', 'utf8');
		const model = buildCodexForm({mode: 'add', providerType: 'custom'});
		const partial = saveCodexProviderForm({mode: 'add', providerType: 'custom'}, {
			...model.values,
			profileKey: 'partial-codex',
			providerType: 'custom',
			baseUrl: 'https://partial.test/v1',
			model: 'partial-model',
			apiKey: 'fixture-partial-token',
			activateAfterSave: true
		});
		assert.equal(partial.ok, true, 'Codex profile 已保存时返回部分成功');
		assert.equal(Boolean(partial.ok && partial.warning?.includes('激活失败')), true, 'Codex 部分成功必须带 warning');
		assert.equal(readFileSync(corruptConfig, 'utf8'), 'model = "unterminated', 'Codex 部分成功不覆盖损坏 config');
	} finally {
		cleanupHome(home);
	}
}
console.log('[PASS] Codex TOML 契约 + 损坏 profile 容错 + partial success');

// ── R4：敏感文件安全权限（Windows 只验证写盘） ──────────────────────────────
{
	const home = temporaryHome('ccq-provider-secret-mode-');
	try {
		mkdirSync(join(home, '.claude', 'providers'), {recursive: true});
		writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({env: {}}), 'utf8');
		addProvider({profileKey: 'secure', baseUrl: 'https://secure.test', apiKey: 'fixture-secure-token', activate: true});
		assertSecretMode(join(home, '.claude', 'providers', 'secure.json'), 'Claude provider');
		assertSecretMode(join(home, '.claude', 'settings.json'), 'Claude settings');
		assertSecretMode(join(home, '.claude.json'), 'Claude onboarding');
		const settingsPath = join(home, '.claude', 'settings.json');
		atomicWrite(settingsPath, readFileSync(settingsPath, 'utf8'));
		assertSecretMode(settingsPath, 'Claude settings（后续通用原子写保留 mode）');

		saveCodexProfile({key: 'secure', providerType: 'apiKey', baseUrl: 'https://secure.test/v1', apiKey: 'fixture-codex-secure'});
		setDefaultCodexProfile('secure');
		writeCodexAuthJson('{"access_token":"fixture-auth-token"}');
		assertSecretMode(join(home, '.codex', 'secure.config.toml'), 'Codex profile');
		assertSecretMode(join(home, '.codex', 'config.toml'), 'Codex config');
		assertSecretMode(join(home, '.codex', 'auth.json'), 'Codex auth');
	} finally {
		cleanupHome(home);
	}
}
console.log('[PASS] Provider/Codex 敏感文件安全权限');

const providerViewSource = readFileSync(new URL('../src/views/provider-view.tsx', import.meta.url), 'utf8');
assert.match(providerViewSource, /if \(warning\) \{\s*toast\.warning\(warning\);/, 'ProviderView 必须展示 partial-success warning');
assert.match(providerViewSource, /loadFailures\.length > 0[\s\S]*<ErrorPanel/, 'ProviderView 必须展示 Codex profile 加载失败');
const providerFormSource = readFileSync(new URL('../src/views/provider-form.tsx', import.meta.url), 'utf8');
assert.match(providerFormSource, /errorKind === 'conflict'[\s\S]*toast\.error\(result\.error\)/, 'ProviderForm 必须用 error toast 展示同名冲突');

const codexUserSurfaceSources = [
	'../src/core/codex-provider-form.ts',
	'../src/core/codex.ts',
	'../src/services/codex-service.ts',
	'../src/views/provider-view.tsx',
	'../src/cli/help.ts',
	'../src/cli/index.ts',
	'../src/cli/commands/cc.ts',
	'../src/cli/commands/cx.ts',
	'../src/cli/commands/ls.ts',
	'../src/cli/commands/use.ts'
].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
assert.doesNotMatch(
	codexUserSurfaceSources,
	/['"`][^'"`\r\n]*Codex (?:profiles?|providers?|供应商)[^'"`\r\n]*['"`]/,
	'Codex 用户可见字符串必须直接使用供应商，不得添加 Codex 前缀或使用 profile/provider'
);
assert.match(codexUserSurfaceSources, /['"`][^'"`\r\n]*供应商[^'"`\r\n]*['"`]/, 'Codex 用户界面必须直接展示供应商术语');
assert.match(codexUserSurfaceSources, /codex --profile/, 'Codex 官方 --profile 技术参数必须保留');

console.log('[PASS] TUI 供应商安全与容错回归全部通过');
