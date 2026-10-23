import {resolve} from 'node:path';
import {describe, expect, test} from 'bun:test';
import type {KeyEvent} from '@opentui/core';
import {defaultManualExportPath, type ManualPathKind, resolveManualBundlePath} from '../../src/core/native-file-dialog.js';
import {
	createInitialSystemSettingsState,
	reduceSystemSettingsState,
	systemSettingsSubMode,
	type SystemSettingsAction,
	type SystemSettingsPageState,
	type SystemSettingsState
} from '../../src/state/system-settings-state.js';
import {mapSystemSettingsKey} from '../../src/views/system-settings/system-settings-view-input.js';

const HOME = resolve('/home/demo');
const fakeStat =
	(entries: Record<string, ManualPathKind>) =>
	(path: string): ManualPathKind =>
		entries[path] ?? 'missing';

describe('resolveManualBundlePath', () => {
	const stat = fakeStat({
		[HOME]: 'directory',
		[resolve(HOME, 'backups')]: 'directory',
		[resolve(HOME, 'backups', 'old.ccq-backup')]: 'file',
		[resolve(HOME, 'pkg.ccq-backup')]: 'file'
	});
	const check = (kind: 'import' | 'export', raw: string) => resolveManualBundlePath(kind, raw, {home: HOME, stat});

	test('导出：~ 展开、补后缀、父目录存在且目标不存在时通过', () => {
		expect(check('export', '~/backups/new')).toEqual({ok: true, path: resolve(HOME, 'backups', 'new.ccq-backup')});
		expect(check('export', '  ~\\backups\\new.ccq-backup ')).toEqual({ok: true, path: resolve(HOME, 'backups', 'new.ccq-backup')});
	});

	test('导出：目标已存在拒绝（含补后缀后才存在的情况），父目录缺失拒绝', () => {
		expect(check('export', '~/backups/old.ccq-backup')).toEqual({ok: false, error: '目标文件已存在，请换一个路径'});
		expect(check('export', '~/backups/old')).toEqual({ok: false, error: '目标文件已存在，请换一个路径'});
		expect(check('export', '~/missing/new.ccq-backup')).toEqual({ok: false, error: '目标目录不存在'});
	});

	test('导入：普通文件通过；不存在、目录、空输入拒绝', () => {
		expect(check('import', '~/pkg.ccq-backup')).toEqual({ok: true, path: resolve(HOME, 'pkg.ccq-backup')});
		expect(check('import', '~/nope.ccq-backup')).toEqual({ok: false, error: '文件不存在'});
		expect(check('import', '~/backups')).toEqual({ok: false, error: '路径不是普通文件'});
		expect(check('import', '~')).toEqual({ok: false, error: '路径不是普通文件'});
		expect(check('import', '   ')).toEqual({ok: false, error: '请输入路径'});
	});

	test('默认导出路径沿用 ccq-config-<timestamp>.ccq-backup 命名', () => {
		expect(defaultManualExportPath(new Date(2026, 0, 2, 3, 4, 5))).toBe('~/ccq-config-20260102-030405.ccq-backup');
	});
});

const exportSummary = {categories: [], containsCredentials: false, warnings: []};

function run(state: SystemSettingsState, ...actions: SystemSettingsAction[]): SystemSettingsState {
	return actions.reduce(reduceSystemSettingsState, state);
}

function page(state: SystemSettingsState): SystemSettingsPageState {
	if (state.mode !== 'page') throw new Error(`expected page, got ${state.mode}`);
	return state;
}

function withExportModal(): SystemSettingsPageState {
	return page(run(createInitialSystemSettingsState(), {type: 'request-export'}, {type: 'export-prepared', summary: exportSummary}));
}

const key = (name: string) => ({name}) as KeyEvent;

describe('system-settings path-input reducer', () => {
	test('导出：只能在导出明细弹窗内打开；编辑/错误/Esc 回到弹窗', () => {
		expect(page(run(createInitialSystemSettingsState(), {type: 'open-path-input', kind: 'export', value: 'x'})).pathInput).toBeNull();

		const opened = page(run(withExportModal(), {type: 'open-path-input', kind: 'export', value: '~/a.ccq-backup'}));
		expect(opened.pathInput).toEqual({kind: 'export', value: '~/a.ccq-backup', error: null});
		expect(systemSettingsSubMode(opened)).toBe('path-input');

		const errored = page(run(opened, {type: 'path-input-error', message: '目标目录不存在'}));
		expect(errored.pathInput?.error).toBe('目标目录不存在');
		const edited = page(run(errored, {type: 'path-input-change', value: '~/b'}));
		expect(edited.pathInput).toEqual({kind: 'export', value: '~/b', error: null});

		const cancelled = page(run(edited, {type: 'back'}));
		expect(cancelled.pathInput).toBeNull();
		expect(cancelled.exportModal).not.toBeNull();
		expect(systemSettingsSubMode(cancelled)).toBe('export-modal');
		expect(cancelled.eventLog.join('\n')).not.toContain('~/b');
	});

	test('导出：提交后复用 export-path-picked 进入写入，还原点不再含 path-input', () => {
		const busy = run(
			withExportModal(),
			{type: 'open-path-input', kind: 'export', value: '~/a'},
			{type: 'export-path-picked', path: '/tmp/a.ccq-backup'}
		);
		expect(busy.mode).toBe('busy');
		if (busy.mode !== 'busy') return;
		expect(busy.retry).toMatchObject({stage: 'write-export', targetPath: '/tmp/a.ccq-backup'});
		expect(busy.restore.pathInput).toBeNull();
	});

	test('导入：页面无弹窗时打开；Esc 静默回到页面；提交复用 import-picked（带已保存密码）', () => {
		expect(page(run(withExportModal(), {type: 'open-path-input', kind: 'import', value: ''})).pathInput).toBeNull();

		const opened = page(run(createInitialSystemSettingsState(), {type: 'open-path-input', kind: 'import', value: ''}));
		expect(opened.pathInput?.kind).toBe('import');

		const cancelled = page(run(opened, {type: 'back'}));
		expect(cancelled.pathInput).toBeNull();
		expect(cancelled.importModal).toBeNull();
		expect(cancelled.error).toBeNull();
		expect(cancelled.notice).toBeNull();

		const busy = run(opened, {type: 'import-picked', path: '/tmp/p.ccq-backup', savedPassword: 'pw'});
		expect(busy.mode).toBe('busy');
		if (busy.mode !== 'busy') return;
		expect(busy.retry).toEqual({stage: 'load-import', bundlePath: '/tmp/p.ccq-backup', password: 'pw'});
		expect(busy.restore.pathInput).toBeNull();
	});

	test('path-input 焦点下只有 Esc 映射为取消，Enter 交给输入框 onSubmit', () => {
		const opened = page(run(withExportModal(), {type: 'open-path-input', kind: 'export', value: '~/a'}));
		expect(mapSystemSettingsKey(opened, key('escape'))).toEqual({kind: 'action', action: {type: 'back'}});
		expect(mapSystemSettingsKey(opened, key('return')).kind).toBe('none');
		expect(mapSystemSettingsKey(opened, key('space')).kind).toBe('none');
	});
});
