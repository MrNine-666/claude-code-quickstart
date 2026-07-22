import {groupComponentsByToolGroup} from '../../core/tools-manage.js';
import {isAnyBusy, type ToolsViewState} from '../../state/tools-view-state.js';

export type ToolsGridIntent =
	| {readonly kind: 'none'}
	| {readonly kind: 'exit'}
	| {readonly kind: 'nav'; readonly delta: number}
	| {readonly kind: 'primary'}
	| {readonly kind: 'update-one'}
	| {readonly kind: 'update-all'}
	| {readonly kind: 'request-uninstall'}
	| {readonly kind: 'refresh'}
	| {readonly kind: 'open-docs'};

export type ToolsInjectIntent =
	| {readonly kind: 'none'}
	| {readonly kind: 'nav'; readonly delta: number}
	| {readonly kind: 'toggle'}
	| {readonly kind: 'apply'}
	| {readonly kind: 'cancel'};

export function resolveToolsGridIntent(key: string, view: ToolsViewState, columns: number): ToolsGridIntent {
	const normalized = key.toLowerCase();
	if (normalized === 'escape') return {kind: 'exit'};

	if (normalized === 'up' || normalized === 'arrowup') {
		const next = visualVerticalCursor(view, columns, -1);
		return next === null ? {kind: 'none'} : {kind: 'nav', delta: next - view.cursor};
	}
	if (normalized === 'down' || normalized === 'arrowdown') {
		const next = visualVerticalCursor(view, columns, 1);
		return next === null ? {kind: 'none'} : {kind: 'nav', delta: next - view.cursor};
	}

	const bounds = cursorGroupBounds(view);
	if (normalized === 'left' || normalized === 'arrowleft') {
		return view.cursor === (bounds?.start ?? 0) ? {kind: 'exit'} : {kind: 'nav', delta: -1};
	}
	if (normalized === 'right' || normalized === 'arrowright') {
		return !bounds || view.cursor < bounds.end ? {kind: 'nav', delta: 1} : {kind: 'none'};
	}
	if (normalized === 'enter' || normalized === 'return') return {kind: 'primary'};
	if (normalized === 'u') return {kind: 'update-one'};
	if (normalized === 'a') return {kind: 'update-all'};
	if (normalized === 'd') return {kind: 'request-uninstall'};
	if (normalized === 'r' && !isAnyBusy(view)) return {kind: 'refresh'};
	if (normalized === 'o') return {kind: 'open-docs'};
	return {kind: 'none'};
}

export function resolveToolsInjectIntent(key: string): ToolsInjectIntent {
	const normalized = key.toLowerCase();
	if (normalized === 'up' || normalized === 'arrowup') return {kind: 'nav', delta: -1};
	if (normalized === 'down' || normalized === 'arrowdown') return {kind: 'nav', delta: 1};
	if (normalized === 'space' || key === ' ') return {kind: 'toggle'};
	if (normalized === 'enter' || normalized === 'return') return {kind: 'apply'};
	if (normalized === 'escape') return {kind: 'cancel'};
	return {kind: 'none'};
}

export function cursorGroupBounds(view: ToolsViewState): {readonly start: number; readonly end: number} | null {
	for (const section of groupComponentsByToolGroup(view.components)) {
		const indices = section.components
			.map(component => view.components.findIndex(item => item.id === component.id))
			.filter(index => index >= 0);
		if (indices.length > 0 && indices.includes(view.cursor)) {
			return {start: Math.min(...indices), end: Math.max(...indices)};
		}
	}
	return null;
}

type GridRow = readonly number[];

function groupedGridRows(view: ToolsViewState, columns: number): readonly GridRow[] {
	return groupComponentsByToolGroup(view.components).flatMap(section => {
		const indices = section.components
			.map(component => view.components.findIndex(item => item.id === component.id))
			.filter(index => index >= 0);
		const rows: GridRow[] = [];
		for (let offset = 0; offset < indices.length; offset += columns) {
			rows.push(indices.slice(offset, offset + columns));
		}
		return rows;
	});
}

function visualVerticalCursor(view: ToolsViewState, columns: number, direction: -1 | 1): number | null {
	const rows = groupedGridRows(view, columns);
	const rowIndex = rows.findIndex(row => row.includes(view.cursor));
	const currentRow = rows[rowIndex];
	if (!currentRow) return null;
	const targetRow = rows[rowIndex + direction];
	if (!targetRow) return null;
	return targetRow[Math.min(currentRow.indexOf(view.cursor), targetRow.length - 1)] ?? null;
}
