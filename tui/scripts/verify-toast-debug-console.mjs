import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';

// 自实现 Toast + 调试控制台门禁：
// 1) Toast 不得再依赖 @opentui-ui/toast（peer 锁 @opentui/core ^0.1.63，与运行时 0.4.5 的
//    remove(child) breaking change 冲突，每次消失都抛 "remove expects a renderable child object"）。
// 2) 顶部居中渲染，zIndex 压过 modal(100) 与 spinner overlay(200)。
// 3) getSnapshot 必须返回稳定引用，否则 useSyncExternalStore 会无限重渲染。
// 4) 生产二进制必须禁用 .env autoload，防止用户 cwd 里的 .env 意外打开调试控制台。

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// ---- 1. 彻底摆脱 @opentui-ui/toast ----
const packageJson = JSON.parse(read('../package.json'));
assert.equal(
	packageJson.dependencies['@opentui-ui/toast'],
	undefined,
	'@opentui-ui/toast 必须从 dependencies 移除（peer 与 @opentui/core 0.4.5 不兼容）'
);

// 全源码扫描 import 语句（注释里保留「为什么自实现」的说明是允许的，只禁真实依赖）。
const sourceFiles = execFileSync('git', ['ls-files', 'src', 'scripts', 'tests'], {cwd: new URL('..', import.meta.url), encoding: 'utf8'})
	.split('\n')
	.filter(path => /\.(ts|tsx|mjs)$/.test(path));

for (const path of sourceFiles) {
	if (path.endsWith('verify-toast-debug-console.mjs')) continue;
	if (!existsSync(new URL(`../${path}`, import.meta.url))) continue;
	const source = read(`../${path}`);
	assert.doesNotMatch(source, /from ['"]@opentui-ui\/toast['"]/, `${path} 不得再从 @opentui-ui/toast import（该包与 @opentui/core 0.4.5 不兼容）`);
}

// ---- 2. 顶部居中 + 层级 + 全主题色 ----
const viewport = read('../src/components/toast-viewport.tsx');
assert.match(viewport, /position="absolute"/, 'ToastViewport 必须绝对定位，不参与主布局流');
assert.match(viewport, /alignItems="center"/, 'ToastViewport 必须水平居中');
assert.match(viewport, /justifyContent="flex-start"/, 'ToastViewport 必须顶部对齐（顶部居中，非底部）');
assert.match(viewport, /zIndex=\{300\}/, 'ToastViewport zIndex 必须为 300，压过 modal(100) 与 spinner overlay(200)');
assert.doesNotMatch(viewport, /bottom-right|bottom=\{0\}/, 'ToastViewport 不得保留右下角定位残留');

// 全部颜色必须取自 theme，不得出现硬编码色值或裸颜色名，否则 light 主题下失配。
assert.doesNotMatch(viewport, /(?:fg|bg|borderColor|backgroundColor)=\{?['"]#[0-9a-fA-F]{3,8}['"]/, 'ToastViewport 不得硬编码 16 进制色值，必须走 theme');
assert.doesNotMatch(
	viewport,
	/(?:fg|bg|borderColor|backgroundColor)=\{?['"](?:red|green|yellow|blue|white|black|gray|grey|magenta|cyan)['"]/,
	'ToastViewport 不得使用裸颜色名，必须走 theme'
);
for (const token of ['colors.success', 'colors.danger', 'colors.warning', 'colors.primary', 'colors.text', 'colors.modalBackground']) {
	assert.match(viewport, new RegExp(token.replace('.', '\\.')), `ToastViewport 必须使用 ${token}（主题适配）`);
}
// colors.info 在两套主题是 white / black（正文前景语义），作边框会刺眼，info 类型应改用 primary。
// 只查 return 语句，注释里说明「为何不用 colors.info」是允许的。
assert.doesNotMatch(viewport, /return colors\.info/, 'info 类型不得 return colors.info 作强调色（两主题为 white/black），应用 colors.primary');

// ---- 3. store 快照引用稳定 ----
const store = read('../src/components/toast-store.ts');
assert.match(store, /export function getToastSnapshot\(\)[\s\S]*?return entries;/, 'getToastSnapshot 必须直接返回模块级 entries（稳定引用），不得每次新建数组');
assert.doesNotMatch(
	store,
	/export function getToastSnapshot\(\)[\s\S]*?return \[/,
	'getToastSnapshot 不得返回新建数组字面量，否则 useSyncExternalStore 无限重渲染'
);
assert.match(viewport, /useSyncExternalStore\(subscribeToasts, getToastSnapshot, getToastSnapshot\)/, 'ToastViewport 必须用 useSyncExternalStore 订阅 store');

// 四个语义方法齐备，调用点（52 处）签名不变：(message, duration?)
for (const method of ['success', 'error', 'warning', 'info']) {
	assert.match(store, new RegExp(`${method}: \\(message: string, duration\\?: number\\)`), `toast.${method} 必须保持 (message, duration?) 签名`);
}

// ---- 4. 生产禁用 .env autoload ----
const buildScript = read('../scripts/build.ts');
assert.match(buildScript, /--no-compile-autoload-dotenv/, 'build.ts 必须传 --no-compile-autoload-dotenv，否则生产版会读用户 cwd 的 .env');

for (const [name, script] of Object.entries(packageJson.scripts)) {
	if (!name.startsWith('build:')) continue;
	assert.match(script, /--no-compile-autoload-dotenv/, `${name} 直接调 bun build，同样必须传 --no-compile-autoload-dotenv`);
}

// 调试控制台开关：env 驱动，dev 默认开、生产默认关
const indexSource = read('../src/index.tsx');
assert.match(indexSource, /process\.env\.CCQ_DEBUG === '1'/, '调试控制台必须由 CCQ_DEBUG 环境变量驱动');
assert.match(indexSource, /renderer\.console\.show\(\)/, 'CCQ_DEBUG=1 时必须展开 TerminalConsole 覆盖层');
assert.match(indexSource, /renderer\.console\.toggle\(\)/, '必须提供快捷键切换控制台显隐');
// macOS 上 F-key 被 Mission Control / 媒体键占用且终端常不转发，必须用 ctrl+<key> 组合键。
assert.doesNotMatch(indexSource, /key\.name === 'f\d+'/, '控制台快捷键不得用 F-key（macOS 上被系统占用且终端常不转发）');
assert.match(indexSource, /isAppModifier\(key\)/, '控制台快捷键必须走 isAppModifier（复用项目 ctrl+<key> 平台约定）');
assert.match(read('../.env.development'), /^CCQ_DEBUG=1$/m, '.env.development 必须提供 CCQ_DEBUG=1，使 bun run dev 默认开启控制台');
assert.match(packageJson.scripts.dev, /NODE_ENV=development/, 'dev 脚本必须显式设 NODE_ENV=development，以确定性加载 .env.development');

console.log('[PASS] 自实现 Toast 顶部居中 + 快照引用稳定 + 生产禁用 .env autoload');
