import {expect, test} from 'bun:test';
import {isValidElement} from 'react';
import {StatusDot, type StatusDotProps, type CardProps} from '../../src/components/index.js';
import {installedPiPackagePlaceholder} from '../../src/core/extensions.js';
import {ExtensionCard} from '../../src/views/extensions/ExtensionsView.js';

test.each([
	[false, '', '2.0.0', 'notInstalled', '未安装'],
	[true, '1.0.0', '2.0.0', 'updatable', '1.0.0 → 2.0.0'],
	[true, '2.0.0', '2.0.0', 'latest', '2.0.0'],
	[true, '1.0.0', '', 'latest', '1.0.0 · 无法检测更新'],
	[true, '', '2.0.0', 'latest', '已安装 · 无法检测更新']
] as const)('card reuses StatusDot: installed=%s current=%s latest=%s', (installed, current, latest, kind, label) => {
	const item = {...installedPiPackagePlaceholder('npm:extension'), installed, installedVersion: current, version: latest};
	const card = ExtensionCard({item, installed, focused: false, width: 48});
	if (!isValidElement<CardProps>(card)) throw new Error('Missing card');
	const badge = card.props.titleRight;
	expect(isValidElement<StatusDotProps>(badge)).toBe(true);
	if (!isValidElement<StatusDotProps>(badge)) throw new Error('Missing status badge');
	expect(badge.type).toBe(StatusDot);
	expect(badge.props).toEqual({kind, label});
});
