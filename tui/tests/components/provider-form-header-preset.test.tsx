import {act} from 'react';
import {expect, test} from 'bun:test';
import {KeyEvent, type ParsedKey} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';

import type {FormField} from '../../src/components/form/field-types.js';
import {piHeaderPreset, piHeaderPresetOptions} from '../../src/core/pi-header-preset.js';
import {
	buildPiProviderFormFields,
	resolvePiModelCandidate,
	type PiProviderFormModel,
	type PiProviderFormValues
} from '../../src/core/pi-provider.js';
import {piProviderFormAdapter} from '../../src/services/pi-provider-service.js';
import type {ProviderFormAdapter} from '../../src/types/provider-form-adapter.js';
import {shortcutPlatform} from '../../src/utils/keyboard.js';
import {ProviderFormView, type DiscoveryMatchOutcome} from '../../src/views/provider/ProviderFormView.js';

// 阶段 E 组件断言：预设动作行（←/→ 只移高亮）、Enter 应用与确认弹窗、跨协议提示、
// 焦点顺序、api 切换联动、CC/Codex textarea 不回归、文案不含禁用术语。
// 组件层不落盘：save / validate 均为 stub，绝不触碰真实 Pi 配置。

const EMPTY_HEADERS = '';

// 预设内容由契约拥有，测试不得硬编码版本号：否则上游发版会把断言变成假失败。
const CLAUDE_CODE_UA = piHeaderPreset('claude-code')?.headers['User-Agent'] ?? '';

// 术语门禁要求 tui/tests 下不得出现该禁用词字面量，因此用码点拼接后再做包含断言。
const FORBIDDEN_TERM = String.fromCharCode(0x4f2a, 0x88c5);

function piModel(overrides: Partial<PiProviderFormValues> = {}): PiProviderFormModel {
	const api = overrides.api ?? 'openai-completions';
	const headerPreset = overrides.headerPreset ?? piHeaderPresetOptions(api)[0]?.preset.key ?? '';
	const values: PiProviderFormValues = {
		providerType: 'custom-api-key',
		api,
		provider: 'custom-acme',
		model: '',
		models: '',
		modelDefinitions: [],
		baseUrl: 'https://acme.example/v1',
		apiKey: 'acme-secret',
		headers: EMPTY_HEADERS,
		authHeader: 'default',
		headerPreset,
		variant: 'full',
		...overrides
	};
	return {mode: 'add', fields: buildPiProviderFormFields(values, 'add'), values};
}

function matchCandidate(): DiscoveryMatchOutcome {
	return {
		ok: true,
		candidate: resolvePiModelCandidate({
			id: 'probe-model',
			api: 'openai-completions',
			upstreamDefinition: {id: 'probe-model'}
		})
	};
}

async function renderPiForm(overrides: Partial<PiProviderFormValues> = {}) {
	const model = piModel(overrides);
	return testRender(
		<ProviderFormView<{readonly mode: string}, PiProviderFormValues, PiProviderFormModel>
			model={model}
			active
			onCancel={() => undefined}
			onSaved={() => undefined}
			buildForm={() => model}
			save={() => ({ok: true, data: undefined})}
			validate={() => []}
			adapter={piProviderFormAdapter}
			onDiscover={async () => [{id: 'probe-model'}, {id: 'probe-model-2'}]}
			onApplyDiscovered={values => values}
			onMatchCandidate={async () => matchCandidate()}
		/>,
		{width: 150, height: 46}
	);
}

async function press(setup: Awaited<ReturnType<typeof renderPiForm>>, action: () => void | Promise<void>) {
	await act(async () => {
		await action();
		await Promise.resolve();
	});
	await setup.flush();
}

async function frameOf(setup: Awaited<ReturnType<typeof renderPiForm>>): Promise<string> {
	await setup.flush();
	return setup.captureCharFrame();
}

/**
 * 编辑态快捷键在 macOS 是 Cmd/Super、其余平台是 Ctrl（见 utils/keyboard.ts）。
 * mockInput 走终端字节编码，表达不了 super（kittyKeyboard 默认关闭），
 * 因此与 skills-render.test.tsx 一致直接投递 KeyEvent：断言不绑死平台。
 */
async function pressEditingShortcut(setup: Awaited<ReturnType<typeof renderPiForm>>, name: string) {
	const modifier: Partial<ParsedKey> = shortcutPlatform() === 'darwin' ? {super: true} : {ctrl: true};
	await press(setup, () => {
		setup.renderer.keyInput.emit(
			'keypress',
			new KeyEvent({
				name,
				sequence: name,
				ctrl: false,
				shift: false,
				meta: false,
				option: false,
				number: false,
				raw: name,
				eventType: 'press',
				source: 'raw',
				repeated: false,
				...modifier
			})
		);
	});
}

/**
 * 两列布局下左列（请求头预设 / 认证头形态及其说明）变窄，长文案会折行，
 * 直接按子串断言会被行尾切断而假失败。断言前先折叠所有空白。
 */
function collapse(text: string): string {
	return text.replace(/\s+/gu, '');
}

// 每次按键必须单独 flush：handleMoveFocus 读取的是本次渲染的 focusedIndex，
// 同一批内连按多次会全部基于同一个旧索引计算。
async function down(setup: Awaited<ReturnType<typeof renderPiForm>>, times = 1) {
	for (let index = 0; index < times; index += 1) await press(setup, () => setup.mockInput.pressArrow('down'));
}
async function up(setup: Awaited<ReturnType<typeof renderPiForm>>, times = 1) {
	for (let index = 0; index < times; index += 1) await press(setup, () => setup.mockInput.pressArrow('up'));
}
const enter = (setup: Awaited<ReturnType<typeof renderPiForm>>) => press(setup, () => setup.mockInput.pressEnter());
// 裸 ESC 会被终端解析器缓冲并与下一个按键合并为 Alt+xxx，必须等一小段超时让它单独成事件。
const pressEscapeKey = (setup: Awaited<ReturnType<typeof renderPiForm>>) =>
	press(setup, async () => {
		setup.mockInput.pressEscape();
		await new Promise(resolve => setTimeout(resolve, 20));
	});
const right = (setup: Awaited<ReturnType<typeof renderPiForm>>) => press(setup, () => setup.mockInput.pressArrow('right'));
async function left(setup: Awaited<ReturnType<typeof renderPiForm>>, times = 1) {
	for (let index = 0; index < times; index += 1) await press(setup, () => setup.mockInput.pressArrow('left'));
}

/** `› 请求头预设` 包含 `› 请求头` 子串，需排除才能判定编辑区真的被聚焦。 */
function hasTextareaFocus(frame: string): boolean {
	return frame.split('\n').some(line => line.includes('› 请求头') && !line.includes('› 请求头预设'));
}

/** 自由模式下 headerPreset 是最后一个字段：从首个字段 ↓ 4 次到达。 */
async function focusPresetFreeMode(setup: Awaited<ReturnType<typeof renderPiForm>>) {
	await down(setup, 4);
}

test('自由模式下 Enter 直接填充空编辑区，不弹窗', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await focusPresetFreeMode(setup);
		await enter(setup);
		const frame = await frameOf(setup);
		expect(frame).toContain(CLAUDE_CODE_UA);
		expect(frame).toContain('x-app');
		expect(frame).not.toContain('覆盖请求头？');
		expect(frame).not.toContain(FORBIDDEN_TERM);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('←/→ 只移动高亮，绝不改写编辑区文本', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await focusPresetFreeMode(setup);
		await enter(setup);
		expect(await frameOf(setup)).toContain(CLAUDE_CODE_UA);

		await right(setup);
		const afterRight = await frameOf(setup);
		expect(afterRight).toContain(CLAUDE_CODE_UA);
		expect(afterRight).not.toContain('codex_cli_rs');

		await right(setup);
		const afterSecondRight = await frameOf(setup);
		expect(afterSecondRight).toContain(CLAUDE_CODE_UA);
		expect(afterSecondRight).not.toContain('codex_cli_rs');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('编辑区非空且不同时 Enter 弹确认；Esc 零改动，Enter 覆盖', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await focusPresetFreeMode(setup);
		await enter(setup); // 填充 Claude Code
		await right(setup); // 高亮 Codex CLI
		await enter(setup); // 内容不同 → 弹窗
		const modal = await frameOf(setup);
		expect(modal).toContain('覆盖请求头？');
		expect(modal).toContain('Codex CLI');
		expect(modal).not.toContain(FORBIDDEN_TERM);

		await pressEscapeKey(setup);
		const cancelled = await frameOf(setup);
		expect(cancelled).not.toContain('覆盖请求头？');
		expect(cancelled).toContain(CLAUDE_CODE_UA);
		expect(cancelled).not.toContain('codex_cli_rs');

		await enter(setup);
		expect(await frameOf(setup)).toContain('覆盖请求头？');
		await enter(setup);
		const applied = await frameOf(setup);
		expect(applied).not.toContain('覆盖请求头？');
		expect(applied).toContain('codex_cli_rs');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('改坏的编辑区按 Enter 重应用同一预设可还原', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await focusPresetFreeMode(setup);
		await enter(setup);
		// 最后一个字段 ↓ 进编辑区；空文本时 ↑ 可回到字段。
		await down(setup, 1);
		const textareaFrame = await frameOf(setup);
		expect(hasTextareaFocus(textareaFrame)).toBe(true);
		await press(setup, () => setup.mockInput.typeText('X'));
		const corrupted = await frameOf(setup);
		expect(corrupted).not.toBe(textareaFrame);

		// 编辑区 ↑ 回最后一个字段（光标在第 0 行），重应用同一预设。
		await up(setup, 1);
		await enter(setup);
		const confirm = await frameOf(setup);
		expect(confirm).toContain('覆盖请求头？');
		await enter(setup);
		const restored = await frameOf(setup);
		expect(restored).toContain(CLAUDE_CODE_UA);
		expect(restored).not.toContain('覆盖请求头？');
		expect(restored).not.toContain('JSON 格式错误');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('受控模式下只列出对应预设，且 api 切换后选项集与认证头可见性跟随且不丢编辑区内容', async () => {
	const setup = await renderPiForm({api: 'anthropic-messages'});
	try {
		const initial = await frameOf(setup);
		expect(initial).toContain('认证头形态');
		expect(initial).toContain('Claude Code');
		expect(initial).not.toContain('Codex CLI');

		// provider→baseUrl→api→apiKey→headerPreset。
		await down(setup, 4);
		await enter(setup);
		expect(await frameOf(setup)).toContain(CLAUDE_CODE_UA);

		// headerPreset ↑ 两次到 api，再 → 切到 openai-completions（自由模式）。
		await up(setup, 2);
		await right(setup);
		const switched = await frameOf(setup);
		expect(switched).not.toContain('认证头形态');
		expect(switched).toContain('Codex CLI');
		expect(switched).toContain(CLAUDE_CODE_UA);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('切到受控协议后高亮回落可用预设，Enter 不应用未列出的预设', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		// 默认高亮首个预设（Claude Code）；不按 ←/→，直接把 api 切到受控的 openai-responses。
		await down(setup, 2);
		await right(setup);
		expect(await frameOf(setup)).toContain('Codex CLI');

		await down(setup, 2);
		await enter(setup);
		const applied = await frameOf(setup);
		expect(applied, 'Enter 只能应用动作行列出的预设').not.toContain(CLAUDE_CODE_UA);
		expect(applied).toContain('codex_cli_rs');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('跨协议提示：codex 头切到 anthropic 后提示不适用且编辑区不被清除', async () => {
	const setup = await renderPiForm({api: 'openai-responses'});
	try {
		await down(setup, 4);
		await enter(setup);
		expect(await frameOf(setup)).toContain('codex_cli_rs');

		// openai-responses 的 api 选项索引为 2，← 两次到 anthropic-messages。
		await up(setup, 2);
		await left(setup, 2);
		const switched = await frameOf(setup);
		// 文案本身在 core 层断精确字符串（tests/core/pi-provider-headers.test.ts）：两列布局会把长文案折行，
		// 右列编辑区边框字符会插进折行处，此处按子串断言不可靠。组件层只验证「内容未被清除」。
		expect(switched).toContain('codex_cli_rs');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('焦点顺序：字段 ↔ 请求头编辑区 ↔ 手动输入 ↔ 模型列表（与面板视觉顺序一致）', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await press(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.waitForFrame(output => output.includes('probe-model'));

		// 列表首行 ↑ 回手动输入（面板把手动输入渲染在列表上方，故不是编辑区）。
		await up(setup, 1);
		let frame = await frameOf(setup);
		expect(hasTextareaFocus(frame)).toBe(false);
		expect(frame).toContain('添加自定义模型');
		// 手动输入 ↑ 回编辑区。
		await up(setup, 1);
		expect(hasTextareaFocus(await frameOf(setup))).toBe(true);
		// 编辑区 ↑ 回最后一个字段。
		await up(setup, 1);
		expect(hasTextareaFocus(await frameOf(setup))).toBe(false);
		// 最后一个字段 ↓ 回编辑区。
		await down(setup, 1);
		expect(hasTextareaFocus(await frameOf(setup))).toBe(true);
		// 编辑区 ↓ 进手动输入。
		await down(setup, 1);
		frame = await frameOf(setup);
		expect(hasTextareaFocus(frame)).toBe(false);
		expect(frame, '编辑区 ↓ 应进手动输入而非模型列表').toContain('添加自定义模型');
		// 手动输入 ↓ 进模型列表。
		await down(setup, 1);
		frame = await frameOf(setup);
		expect(frame).not.toContain('› 添加自定义模型');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('焦点环绕按视觉顺序：列表末行 ↓ 回第一个字段、首个字段 ↑ 回列表末行', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await press(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.waitForFrame(output => output.includes('probe-model'));

		// 视觉顺序：字段 → 请求头编辑区 → 添加自定义模型 → 模型列表行（面板把手动输入渲染在列表上方）。
		// 列表首行 ↑ → 手动输入（而不是编辑区）。
		await up(setup, 1);
		let frame = await frameOf(setup);
		expect(hasTextareaFocus(frame), '列表首行 ↑ 不应落在编辑区').toBe(false);
		expect(frame, '列表首行 ↑ 应落在手动输入').toContain('添加自定义模型');

		// 手动输入 ↑ → 编辑区。
		await up(setup, 1);
		expect(hasTextareaFocus(await frameOf(setup)), '手动输入 ↑ 应回编辑区').toBe(true);

		// 编辑区 ↓ → 手动输入（面板里它就在列表上方）。
		await down(setup, 1);
		frame = await frameOf(setup);
		expect(hasTextareaFocus(frame)).toBe(false);
		expect(frame, '编辑区 ↓ 应进手动输入').toContain('添加自定义模型');

		// 手动输入 ↓ → 模型列表，再 ↓ 到末行 → 环绕回表单第一个字段。
		// 列表有 2 行：进入时停在首行，故再 ↓ 2 次（首行→末行→环绕）。
		await down(setup, 1);
		await down(setup, 2);
		frame = await frameOf(setup);
		expect(frame, '列表末行 ↓ 应环绕回第一个字段').toContain('› Provider ID');
		expect(hasTextareaFocus(frame), '列表末行 ↓ 不应停在编辑区').toBe(false);

		// 第一个字段 ↑ → 环绕到视觉序列末端（模型列表末行）。
		await up(setup, 1);
		frame = await frameOf(setup);
		expect(frame, '第一个字段 ↑ 应环绕到模型列表').not.toContain('› Provider ID');
		expect(hasTextareaFocus(frame), '第一个字段 ↑ 不应落在编辑区').toBe(false);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('编辑区连续输入不会清除已选模型', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await press(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.waitForFrame(output => output.includes('probe-model'));
		await press(setup, () => setup.mockInput.pressKey(' '));
		await setup.waitForFrame(output => output.includes('[✓]'));

		// 从列表首行 ↑ 经手动输入回编辑区（面板把手动输入渲染在列表上方），连续输入字符。
		await up(setup, 2);
		await press(setup, () => setup.mockInput.typeText('X'));
		await press(setup, () => setup.mockInput.typeText('Y'));
		const frame = await frameOf(setup);
		expect(frame, '请求头编辑区输入不得清除已选模型').toContain('[✓]');
		expect(frame).toContain('probe-model');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('CC/Codex 风格的共享 textarea 渲染不回归', async () => {
	type TestValues = {readonly baseUrl: string; readonly profile: string};
	type TestModel = {readonly mode: string; readonly fields: readonly FormField[]; readonly values: TestValues};
	const fields: readonly FormField[] = [{id: 'baseUrl', type: 'text', label: 'Base URL', value: 'https://example.test'}];
	const values: TestValues = {baseUrl: 'https://example.test', profile: '{"env": {}}'};
	const adapter: ProviderFormAdapter<{readonly mode: string}, TestValues, TestModel> = {
		textLabel: 'Profile JSON',
		showTextEditor: true,
		title: () => '编辑供应商',
		savedMessage: () => '已保存',
		valuesToRecord: current => ({baseUrl: current.baseUrl, profile: current.profile}),
		recordToValues: (record, fallback) => ({...fallback, baseUrl: record.baseUrl ?? '', profile: record.profile ?? ''}),
		buildText: current => current.profile,
		parseText: (base, raw) => ({ok: true, values: {...base, profile: raw}}),
		makeProviderTypeInput: () => ({mode: 'add'}),
		makeSubmitInput: () => ({mode: 'add'}),
		isTextReadOnly: () => false
	};
	const setup = await testRender(
		<ProviderFormView<{readonly mode: string}, TestValues, TestModel>
			model={{mode: 'add', fields, values}}
			active
			onCancel={() => undefined}
			onSaved={() => undefined}
			buildForm={() => ({mode: 'add', fields, values})}
			save={() => ({ok: true, data: undefined})}
			validate={() => []}
			adapter={adapter}
		/>,
		{width: 100, height: 30}
	);
	try {
		await setup.flush();
		const frame = setup.captureCharFrame();
		expect(frame).toContain('Profile JSON');
		expect(frame).toContain('"env"');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

// ── AC 补测：说明文案与「改端点字段会重置发现」的正向断言 ──────────────

test('AC10：自由模式声明预设非本协议客户端，受控模式不出现该文案', async () => {
	const free = await renderPiForm({api: 'openai-completions'});
	try {
		expect(await frameOf(free), '自由模式必须声明没有对应预设').toContain('没有对应预设');
	} finally {
		await act(async () => {
			free.renderer.destroy();
		});
	}

	const controlled = await renderPiForm({api: 'anthropic-messages'});
	try {
		expect(await frameOf(controlled), '受控模式不得出现自由模式文案').not.toContain('没有对应预设');
	} finally {
		await act(async () => {
			controlled.renderer.destroy();
		});
	}
});

// AC21（协议层建议文案）与 AC10（自由模式文案）在 core 层断言：两列布局下文案折行，
// 组件层按子串断言不可靠。见 tests/core/pi-provider-headers.test.ts 的「说明文案按优先级表生成」。

test('保存只触发一次：表单层与页面层不得同时处理保存快捷键', async () => {
	const model = piModel({api: 'anthropic-messages'});
	let saveCount = 0;
	let savedCount = 0;
	const setup = await testRender(
		<ProviderFormView<{readonly mode: string}, PiProviderFormValues, PiProviderFormModel>
			model={model}
			active
			onCancel={() => undefined}
			onSaved={() => {
				savedCount += 1;
			}}
			buildForm={() => model}
			save={() => {
				saveCount += 1;
				return {ok: true, data: undefined};
			}}
			validate={() => []}
			adapter={piProviderFormAdapter}
			onDiscover={async () => [{id: 'probe-model'}]}
			onApplyDiscovered={values => values}
			onMatchCandidate={async () => matchCandidate()}
		/>,
		{width: 150, height: 46}
	);
	try {
		await pressEditingShortcut(setup, 's');
		expect(saveCount, '编辑态保存快捷键应只落盘一次').toBe(1);
		expect(savedCount, '编辑态保存快捷键应只弹一次保存提示').toBe(1);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('AC12：改动 baseUrl 会重置模型发现（与编辑区输入相反）', async () => {
	const setup = await renderPiForm({api: 'openai-completions'});
	try {
		await press(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.waitForFrame(output => output.includes('probe-model'));
		await press(setup, () => setup.mockInput.pressKey(' '));
		await setup.waitForFrame(output => output.includes('[✓]'));

		// 焦点顺序：模型列表首行 ↑ → 手动输入 → 编辑区 → 预设 → apiKey → api → baseUrl。
		// 先断言确实落在 Base URL，避免导航次数偏了以后断言静默通过。
		await up(setup, 6);
		expect(await frameOf(setup), '应聚焦到 Base URL').toContain('› Base URL');

		await press(setup, () => setup.mockInput.typeText('Z'));
		expect(await frameOf(setup), 'baseUrl 变化必须重置发现').not.toContain('[✓]');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
