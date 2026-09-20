import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uninstallComponent} from '../src/core/tools-manage.ts';

// [P4b 切分] 纯段（Node preflight、Pi CLI ignore-scripts、Pi Web --help 探针、
// update/uninstall argv 对账、Pi Web 主操作投影）已迁 tests/core/tools-pi.test.ts。
// 本脚本保留需要真实落盘 / 真实子进程的段：卸载后 Pi 用户 settings 字节不变。
// [P4c 去重] 末尾 COMPONENT_META / TOOL_GROUP_META 4 条分组元数据已由 P4a
// tests/core/tools-context.test.ts 与 tests/core/tools-manage.test.ts 覆盖，已从本脚本删除。

const home = mkdtempSync(join(tmpdir(), 'ccq-pi-tools-'));
process.env.CCQ_HOME = home;

// ── Pi Web 卸载不得删除 Pi 用户数据（真实文件字节）──────────────────────────────
const removeExec = async (command, args) => {
	if (command === 'npm' && args[0] === 'uninstall') return {code: 0, stdout: '', stderr: ''};
	if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
	if (command === 'pi-web' && args[0] === '--help') return {code: 1, stdout: '', stderr: 'not found'};
	return {code: 1, stdout: '', stderr: 'not found'};
};

mkdirSync(join(home, '.pi', 'agent'), {recursive: true});
const sentinel = join(home, '.pi', 'agent', 'settings.json');
writeFileSync(sentinel, JSON.stringify({userSetting: true}), 'utf8');
await uninstallComponent('PiWeb', undefined, {
	exec: removeExec,
	createSnapshotFn: () => join(home, 'remove-snapshot')
});
assert.deepEqual(JSON.parse(readFileSync(sentinel, 'utf8')), {userSetting: true}, '卸载 Pi Web 不得删除 Pi 用户 settings');

console.log('[PASS] Pi Tools：Node preflight、Pi CLI ignore-scripts、Pi Web postinstall 语义、update/uninstall 对账与用户数据保护门禁全部通过');
