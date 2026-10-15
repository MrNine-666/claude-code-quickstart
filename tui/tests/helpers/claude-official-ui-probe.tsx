import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {mock} from 'bun:test';
import {act, useState} from 'react';
import {testRender} from '@opentui/react/test-utils';
import * as service from '../../src/services/provider-service.js';
import {getDisplayData} from '../../src/core/provider.js';
import type {ProviderDisplayData} from '../../src/core/provider.js';
import type {AgentContext} from '../../src/state/manage-state.js';
import type {ClaudeAuthOptions} from '../../src/core/claude-auth.js';
import {getToastSnapshot, resetToasts} from '../../src/components/toast-store.js';

const home = join(process.env.CCQ_HOME!, 'ui-home');
mkdirSync(home, {recursive: true});
Object.assign(process.env, {CCQ_HOME: home, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude')});
for (const key of [
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_AUTH_TOKEN',
	'ANTHROPIC_API_KEY',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
	'CLAUDE_CODE_OAUTH_SCOPES',
	'CLAUDE_CODE_USE_BEDROCK',
	'CLAUDE_CODE_USE_VERTEX',
	'CLAUDE_CODE_USE_FOUNDRY'
])
	delete process.env[key];
const pending: {signal?: AbortSignal; resolve: (value: ProviderDisplayData) => void}[] = [];
let deferSwitch = false;
const switches: {signal: AbortSignal; resolve: () => void}[] = [];
mock.module('../../src/services/provider-service.js', () => ({
	...service,
	refreshClaudeProviderDisplay: (options: ClaudeAuthOptions) =>
		new Promise<ProviderDisplayData>(resolve => pending.push({signal: options.signal, resolve})),
	switchActiveProvider: async (key: string, options: ClaudeAuthOptions) => {
		assert(options.signal && !options.signal.aborted);
		if (deferSwitch) await new Promise<void>(resolve => switches.push({signal: options.signal!, resolve}));
		return {ok: true, data: {providerName: key}, warning: '已解除 ccq 配置，但官方身份尚未确认。请运行 claude auth login。'};
	}
}));
const {ProviderView, providerReadOnlyMessage} = await import('../../src/views/provider/ProviderView.js');
for (const action of ['edit', 'delete'] as const) {
	assert.equal(providerReadOnlyMessage('claude', action), providerReadOnlyMessage('codex', action).replaceAll('codex', 'claude auth'));
}
const modes: string[] = [];
let setContext: (context: AgentContext) => void = () => {};
let setActive: (active: boolean) => void = () => {};
function Host() {
	const [context, updateContext] = useState<AgentContext>('cc');
	const [active, updateActive] = useState(true);
	setContext = updateContext;
	setActive = updateActive;
	return <ProviderView agentContext={context} active={active} onSubModeChange={mode => modes.push(mode)} onExitToNav={() => {}} />;
}
const setup = await testRender(<Host />, {width: 90, height: 25});
try {
	await setup.renderOnce();
	assert.equal(pending.length, 1);
	assert(setup.captureCharFrame().includes('暂无供应商配置'));
	assert(!setup.captureCharFrame().includes('已授权登录'));
	assert.equal(modes.at(-1), 'empty');
	await act(async () => {
		pending[0]!.resolve(getDisplayData({status: 'configured'}));
	});
	await setup.renderOnce();
	assert(setup.captureCharFrame().includes('已授权登录'));
	for (const key of ['e', 'd']) {
		await act(async () => {
			setup.mockInput.pressKey(key);
		});
		await setup.renderOnce();
		assert(getToastSnapshot().at(-1)?.message.includes('claude auth login'));
		assert(!setup.captureCharFrame().includes('确认删除供应商'));
	}
	await act(async () => {
		setup.mockInput.pressEnter();
	});
	await setup.renderOnce();
	assert(getToastSnapshot().some(entry => entry.type === 'warning' && entry.message.includes('官方身份尚未确认')));
	const stale = pending.at(-1)!;
	assert(setup.captureCharFrame().includes('暂无供应商配置'), 'postflight snapshot hides unknown row');
	const codexDir = join(home, '.codex');
	mkdirSync(codexDir, {recursive: true});
	writeFileSync(join(codexDir, 'auth.json'), '{}');
	await act(async () => {
		setContext('cx');
	});
	await setup.renderOnce();
	assert(stale.signal?.aborted);
	assert(setup.captureCharFrame().includes('已授权登录'));
	assert(!setup.captureCharFrame().includes('official login'));
	resetToasts();
	for (const key of ['e', 'd']) {
		await act(async () => setup.mockInput.pressKey(key));
		await setup.renderOnce();
		assert.equal(getToastSnapshot().at(-1)?.message, providerReadOnlyMessage('codex', key === 'e' ? 'edit' : 'delete'));
		assert(!setup.captureCharFrame().includes('确认删除供应商'));
	}
	await act(async () => {
		stale.resolve({
			profiles: [{key: 'STALE-CLAUDE', baseUrl: '', authToken: '', profilePath: '', maskedApiKey: '', isActive: false}],
			activeKey: '',
			hasProviders: true
		});
	});
	await setup.renderOnce();
	assert(!setup.captureCharFrame().includes('STALE-CLAUDE'));
	await act(async () => {
		setContext('cc');
	});
	await setup.renderOnce();
	const inflight = pending.at(-1)!;
	const refreshCount = pending.length;
	await act(async () => {
		setActive(false);
	});
	await setup.renderOnce();
	assert(!inflight.signal?.aborted, 'inactive menu preview keeps auth refresh');
	resetToasts();
	await act(async () => {
		setup.mockInput.pressKey('e');
	});
	assert.equal(getToastSnapshot().length, 0, 'inactive input must not respond');
	await act(async () => setContext('cx'));
	await act(async () => setContext('cc'));
	await setup.renderOnce();
	assert.equal(pending.length, refreshCount + 1, 'menu preview loads auth before focus enters the view');
	await act(async () => {
		setActive(true);
	});
	await setup.renderOnce();
	assert.equal(pending.length, refreshCount + 1, 'focus change must not respawn auth refresh');
	await act(async () => pending.at(-1)!.resolve(getDisplayData({status: 'configured'})));
	await setup.renderOnce();
	assert(setup.captureCharFrame().includes('已授权登录'));
	deferSwitch = true;
	await act(async () => {
		setup.mockInput.pressEnter();
		setup.mockInput.pressEnter();
	});
	assert.equal(switches.length, 1, 'pending switch must reject repeated Enter');
	await act(async () => {
		setContext('cx');
	});
	await setup.renderOnce();
	assert(switches[0]!.signal.aborted, 'context change must cancel pending switch');
	await act(async () => {
		switches[0]!.resolve();
	});
	await setup.renderOnce();
	assert.equal(getToastSnapshot().length, 0, 'cancelled switch must not emit stale toast');
	rmSync(join(codexDir, 'auth.json'));
	await act(async () => setContext('cc'));
	await setup.renderOnce();
	await act(async () => pending.at(-1)!.resolve(getDisplayData({status: 'missing'})));
	await setup.renderOnce();
	assert(setup.captureCharFrame().includes('暂无供应商配置'));
	assert.equal(modes.at(-1), 'empty');
	await act(async () => setContext('cx'));
	await setup.renderOnce();
	assert(setup.captureCharFrame().includes('暂无供应商配置'));
	assert(!setup.captureCharFrame().includes('已授权登录'));
	for (const key of ['e', 'd']) await act(async () => setup.mockInput.pressKey(key));
	assert.equal(getToastSnapshot().length, 0, 'empty list must not edit/delete hidden official');
	await act(async () => setup.mockInput.pressKey('a'));
	await setup.renderOnce();
	assert(setup.captureCharFrame().includes('添加供应商'), 'empty list can still add');
	console.log('Claude official UI isolated probe passed');
} finally {
	await act(async () => {
		setup.renderer.destroy();
	});
	resetToasts();
}
