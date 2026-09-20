import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach} from 'bun:test';

// 临时 HOME 夹具（试点批 design §1/§2）。
//
// 路径解析约定：src/core/paths.ts 的 resolveHome() 在**调用时**读取 CCQ_HOME / HOME，
// 不在 import 时捕获。因此同一进程内先设 CCQ_HOME 再调用 paths.ts 的任意函数即可生效，
// 不需要 --isolate，也不需要「一个测试文件只绑一个 HOME」。
//
// 这条惰性解析是整个 env 隔离方案成立的前提：任何模块都不得在顶层执行 paths.ts 的
// 函数并把结果存成模块常量，否则 tests/core/env-isolation-a|b.test.ts 会立刻变红。
//
// 用法：
//   - 文件/describe 作用域需要固定 home → useTempHome('ccq-xxx-')（自动 afterEach 复原+清理）。
//   - 单个 test 内部需要独立 home → createTempHome(...) 并在 finally 里 restore+cleanup。

// 夹具默认只改写 CCQ_HOME；需要连 HOME / USERPROFILE / CODEX_HOME 一起隔离时，
// 通过 createTempHome(prefix, {HOME: home.path, USERPROFILE: home.path}) 显式传入。
export type TempHome = {
	/** 临时目录绝对路径，同时作为 CCQ_HOME 的值。 */
	readonly path: string;
	/** 本次设置的环境变量（含 CCQ_HOME）。 */
	readonly env: Readonly<Record<string, string>>;
	/** 复原设置前的环境变量。 */
	restore(): void;
	/** 删除临时目录。 */
	cleanup(): void;
};

function applyEnv(overrides: Readonly<Record<string, string>>): () => void {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}

	return () => {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

/**
 * 创建临时目录并把 `CCQ_HOME` 指向它。`extraEnv` 可追加其它覆盖（例如 `HOME`）。
 * 返回的 `restore()` / `cleanup()` 必须由调用方保证执行。
 */
export function createTempHome(prefix: string, extraEnv: Readonly<Record<string, string>> = {}): TempHome {
	const base = mkdtempSync(join(tmpdir(), prefix.endsWith('-') ? prefix : `${prefix}-`));
	const env: Record<string, string> = {CCQ_HOME: base, ...extraEnv};
	return {
		path: base,
		env,
		restore: applyEnv(env),
		cleanup: () => {
			rmSync(base, {recursive: true, force: true});
		}
	};
}

/**
 * 在文件/describe 作用域创建临时 home，并注册 `afterEach` 自动 `restore()` + `cleanup()`。
 * 依赖 afterEach 的注册时机，请在测试用例之外调用（模块顶层或 describe 回调内）。
 */
export function useTempHome(prefix: string, extraEnv?: Readonly<Record<string, string>>): TempHome {
	const home = createTempHome(prefix, extraEnv);
	afterEach(() => {
		home.restore();
		home.cleanup();
	});
	return home;
}
