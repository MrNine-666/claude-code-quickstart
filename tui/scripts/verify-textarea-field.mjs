import {render} from 'ink-testing-library';
import React from 'react';
import assert from 'node:assert/strict';

// Phase 12A 渲染门禁：TextareaField 经 FieldRow 渲染——只读/可编辑 focus 切换 + error 展示 + disabled + placeholder。
// onChange 的 stdin 触发由视图层集成测试覆盖（12B-E 完整受控逻辑），本冒烟聚焦渲染层。

const {FieldRow} = await import('../dist/components/form/field-row.js');

// 可编辑态 TextArea 光标 blink 会用 ANSI 反色码包裹光标字符（如 \x1b[7m{\x1b[27m），
// 剥除 CSI 转义后再断言，避免光标相位拆断文本 + 防 blink flaky。
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function renderField(field, props = {}) {
	return render(React.createElement(FieldRow, {field, ...props}));
}

// 等首屏 + TextArea 光标/视口初始化稳定
const settle = () => new Promise(resolve => setTimeout(resolve, 150));

// 1. 只读渲染：readonly=true → focus=false（true read-only），含 value + label
{
	const {lastFrame, unmount} = renderField(
		{id: 'x', label: '说明', type: 'textarea', value: 'hello world', readonly: true},
		{focused: true, editable: true},
	);
	await settle();
	const text = stripAnsi(lastFrame());
	assert.ok(text.includes('hello world'), `只读渲染应含 value\n---\n${lastFrame()}`);
	assert.ok(text.includes('说明'), `应含 label\n---\n${lastFrame()}`);
	unmount();
	console.log('[PASS] 只读 textarea 渲染含 value + label（focus=false 只读态）');
}

// 2. 可编辑渲染：editable+focused+非 readonly → focus=true，含 value（剥除光标 ANSI 后）
{
	const {lastFrame, unmount} = renderField(
		{id: 'x', label: 'JSON', type: 'textarea', value: '{"a":1}'},
		{focused: true, editable: true, onChange: () => {}},
	);
	await settle();
	const text = stripAnsi(lastFrame());
	assert.ok(text.includes('{"a":1}'), `可编辑渲染应含 value\n---\n${lastFrame()}`);
	assert.ok(text.includes('JSON'), `应含 label\n---\n${lastFrame()}`);
	unmount();
	console.log('[PASS] 可编辑 textarea 渲染含 value（focus=true 编辑态）');
}

// 3. error 展示：error 非空 → 下方红字
{
	const {lastFrame, unmount} = renderField(
		{id: 'x', label: 'JSON', type: 'textarea', value: '{bad', error: 'JSON 格式错误'},
		{focused: true, editable: true},
	);
	await settle();
	const text = stripAnsi(lastFrame());
	assert.ok(text.includes('JSON 格式错误'), `error 非空应展示\n---\n${lastFrame()}`);
	unmount();
	console.log('[PASS] error 非空时展示提示');
}

// 4. disabled：disabled=true → 显示「禁用」，不渲染 TextArea 区
{
	const {lastFrame, unmount} = renderField(
		{id: 'x', label: '说明', type: 'textarea', value: 'hi', disabled: true},
		{focused: true, editable: true},
	);
	await settle();
	const text = stripAnsi(lastFrame());
	assert.ok(text.includes('禁用'), `disabled 应显示禁用\n---\n${lastFrame()}`);
	unmount();
	console.log('[PASS] disabled textarea 显示「禁用」');
}

// 5. placeholder：value 空时显示 placeholder
{
	const {lastFrame, unmount} = renderField(
		{id: 'x', label: '说明', type: 'textarea', value: '', placeholder: '输入内容...'},
		{focused: true, editable: true},
	);
	await settle();
	const text = stripAnsi(lastFrame());
	assert.ok(text.includes('输入内容...'), `空 value 应显示 placeholder\n---\n${lastFrame()}`);
	unmount();
	console.log('[PASS] 空 value 时 placeholder 展示');
}

// 6. 非聚焦可编辑字段：focused=false → editableNow=false（focus=false），渲染不崩溃
{
	const {lastFrame, unmount} = renderField(
		{id: 'x', label: '说明', type: 'textarea', value: 'content'},
		{focused: false, editable: true, onChange: () => {}},
	);
	await settle();
	const text = stripAnsi(lastFrame());
	assert.ok(text.includes('content'), `非聚焦应含 value\n---\n${lastFrame()}`);
	unmount();
	console.log('[PASS] 非聚焦可编辑字段渲染正常（focus=false）');
}

console.log('[PASS] Phase 12A TextareaField 渲染门禁全部通过');
