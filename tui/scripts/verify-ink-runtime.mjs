import {readFileSync} from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nodeMajor = Number(process.versions.node.split('.')[0]);

assert(nodeMajor >= 22, `Node.js ${process.versions.node} 不满足 manage TUI 运行时要求 >=22`);
assert(pkg.type === 'module', 'manage/package.json 必须使用 ESM: type=module');
assert(pkg.packageManager?.startsWith('pnpm@'), 'manage 子项目必须使用 pnpm packageManager');
assert(pkg.engines?.node === '>=22.0.0', 'manage TUI engines.node 必须锁定 >=22.0.0');
assert(pkg.dependencies?.ink === '^7.1.0', 'manage TUI 必须使用 ink@latest 基线 ^7.1.0');
assert(pkg.dependencies?.react === '^19.2.7', 'manage TUI 必须使用 React latest 基线 ^19.2.7');
assert(pkg.dependencies?.['react-devtools-core'] === '^7.0.1', 'Ink 7 peer dependency react-devtools-core 必须安装');

console.log('[PASS] Ink 7 / React 19 / Node 22 / pnpm 运行时元数据通过');

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}
