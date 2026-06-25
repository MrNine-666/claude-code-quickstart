import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hasEmbeddedContracts, getEmbeddedContract} from './embedded-contracts.js';

// TUI 契约内嵌进可执行文件（TDR-4）。
// 源码模式：相对路径上溯到 tui/contracts/（与本文件位置 tui/src/core/ 的关系）。
// Release 模式：Bun build --compile 时通过静态 import 内嵌契约。

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultContractsDir = join(moduleDir, '..', '..', 'contracts');

// 检测是否为 Bun build --compile 产出的可执行文件
// 可执行文件模式下，moduleDir 会指向虚拟文件系统，且有内嵌契约
const isExecutableMode = hasEmbeddedContracts() && !existsSync(defaultContractsDir);

// 解析契约目录：源码模式从相对路径读取，Release 模式从内嵌 asset 读取。
// 移除 CCQ_CONTRACTS_DIR 注入依赖（TDR-4）。
export function resolveContractsDir(): string {
	// Release 模式：返回虚拟路径（实际从 embeddedContracts Map 读取）
	if (isExecutableMode) {
		return '/embedded/contracts';
	}

	// 源码模式：使用相对路径 tui/contracts/
	return defaultContractsDir;
}

export function contractPath(fileName: string): string {
	if (isExecutableMode) {
		return `/embedded/contracts/${fileName}`;
	}
	return join(resolveContractsDir(), fileName);
}

export function loadContract<T = unknown>(fileName: string): T {
	// Release 模式：从内嵌契约读取
	if (isExecutableMode) {
		const content = getEmbeddedContract(fileName);
		if (!content) {
			throw new Error(`内嵌契约不存在: ${fileName}`);
		}

		try {
			return JSON.parse(content) as T;
		} catch (error) {
			throw new Error(`解析内嵌契约失败: ${fileName} - ${error}`);
		}
	}

	// 源码模式：从文件系统读取
	const filePath = contractPath(fileName);
	if (!existsSync(filePath)) {
		throw new Error(`契约文件不存在: ${filePath}`);
	}

	return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

// 加载文本契约（如 .md / .js 文件）
export function loadTextContract(fileName: string): string {
	// Release 模式：从内嵌契约读取
	if (isExecutableMode) {
		const content = getEmbeddedContract(fileName);
		if (!content) {
			throw new Error(`内嵌契约不存在: ${fileName}`);
		}
		return content;
	}

	// 源码模式：从文件系统读取
	const filePath = contractPath(fileName);
	if (!existsSync(filePath)) {
		throw new Error(`契约文件不存在: ${filePath}`);
	}

	return readFileSync(filePath, 'utf8');
}
