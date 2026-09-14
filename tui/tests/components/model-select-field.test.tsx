import {act} from 'react';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import {ModelSelectField} from '../../src/components/form/ModelSelectField.js';

test('ModelSelectField keeps the input bound to the opened single-select list', async () => {
	let submitted = 0;
	let focused = 0;
	const setup = await testRender(
		<ModelSelectField
			label="默认模型"
			value=""
			focused
			active
			open
			loading={false}
			candidates={['model-alpha', 'model-beta']}
			cursor={1}
			onChange={() => undefined}
			onSubmit={() => {
				submitted += 1;
			}}
			onFocus={() => {
				focused += 1;
			}}
		/>,
		{width: 64, height: 18}
	);

	try {
		const frame = await setup.waitForFrame(output => output.includes('model-beta'));
		expect(frame).toContain('默认模型');
		expect(frame).toContain('model-alpha');
		expect(frame).toContain('model-beta');
		expect(focused).toBe(1);
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(submitted).toBe(1);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('ModelSelectField lets the parent close the popup without changing the draft', async () => {
	let closed = 0;
	const draft = 'custom-draft';
	const setup = await testRender(
		<ModelSelectField
			label="默认模型"
			value={draft}
			focused
			active
			open
			loading={false}
			candidates={['model-alpha']}
			cursor={0}
			onChange={() => undefined}
			onSubmit={() => undefined}
			onKeyDown={keyEvent => {
				if (keyEvent.name.toLowerCase() === 'escape') {
					closed += 1;
					return true;
				}
				return false;
			}}
		/>,
		{width: 64, height: 18}
	);

	try {
		await setup.waitForFrame(output => output.includes(draft));
		setup.mockInput.pressEscape();
		await setup.flush();
		expect(closed).toBe(1);
		expect(setup.captureCharFrame()).toContain(draft);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
