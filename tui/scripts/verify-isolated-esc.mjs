import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInitialManageState, reduceManageState} from '../dist/state/manage-state.js';

// 孤立 ESC 门禁（nodejs/node#38663 / #49588）：
// 旧 menu.js 走 readline keypress，Windows 下孤立 ESC 字节被 readline 扣留等待
// 后续字节，导致 keypress 永不 emit（丢键/挂起）。新 TUI 改用 Ink 7 的 raw data
// 输入管线（stdin.read on 'readable' + 孤立 ESC 超时 flush），从架构上规避该 bug。
// 本门禁锁定整条链路：原始字节 → Ink input-parser → parse-keypress → reducer。
//
// Ink 仅公开导出 ./build/index.js，input-parser / parse-keypress 不在 exports 中；
// 这里运行时 realpath 解析 node_modules/ink（不硬编码 pnpm 哈希），再以绝对 file URL
// 直接导入需要 pin 的内部模块。Ink 基线 7.1.0；若未来 Ink 重构 build/ 导致导入失败，
// 门禁会显式报错，提示重新验证孤立 ESC 行为。
const ESC = String.fromCharCode(27);

const inkDir = realpathSync(join(process.cwd(), 'node_modules', 'ink'));
const inkBuildUrl = name => pathToFileURL(join(inkDir, 'build', name)).href;

const {createInputParser} = await import(inkBuildUrl('input-parser.js'));
const {default: parseKeypress} = await import(inkBuildUrl('parse-keypress.js'));

assert.equal(typeof createInputParser, 'function', 'Ink input-parser 缺少 createInputParser 导出');
assert.equal(typeof parseKeypress, 'function', 'Ink parse-keypress 缺少 parseKeypress 默认导出');

// 1. 孤立 ESC：先被扣留为 pending（消歧义），事件不立即 emit。
const parser = createInputParser();
assert.deepEqual(parser.push(ESC), [], '孤立 ESC 不应立即 emit，需等待消歧义');
assert.equal(parser.hasPendingEscape(), true, '孤立 ESC 应被扣留为 pending');

// 2. flush：孤立 ESC 必须被刷出（不丢键），且 flush 路径有界（不挂起）。
assert.equal(parser.flushPendingEscape(), ESC, '孤立 ESC 必须在 flush 时被投递，禁止丢键');
assert.equal(parser.hasPendingEscape(), false, 'flush 后不应残留 pending ESC');

// 3. 真转义序列（方向键）不得被误判为孤立 ESC。
const arrowParser = createInputParser();
assert.deepEqual(arrowParser.push(`${ESC}[A`), [`${ESC}[A`], '完整方向键序列应整体 emit');
assert.equal(arrowParser.hasPendingEscape(), false, '完整转义序列不应触发孤立 ESC flush');

// 4. 刷出的孤立 ESC 字节被 parse-keypress 识别为 escape 键。
const key = parseKeypress(ESC);
assert.equal(key.name, 'escape', '孤立 ESC 字节应解析为 escape 键');
assert.equal(key.ctrl, false, 'escape 键不应带 ctrl 修饰');
assert.equal(key.meta, false, 'escape 键不应带 meta 修饰');

// 5. 闭合链路：escape 键名进入 reducer，从右侧视图焦点返回左侧导航，不挂起。
const viewState = reduceManageState(createInitialManageState(), 'enter');
assert.equal(viewState.focus, 'view', '前置：Enter 应进入 view 焦点');
const afterEsc = reduceManageState(viewState, 'escape');
assert.equal(afterEsc.focus, 'nav', '孤立 ESC 应将焦点从 view 返回 nav');

console.log('[PASS] 孤立 ESC 输入链路门禁通过（nodejs/node#38663/#49588 无回归）');
