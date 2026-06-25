import {chmodSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const cliPath = join(process.cwd(), 'dist', 'cli.js');

if (!existsSync(cliPath)) {
	throw new Error(`构建入口不存在: ${cliPath}`);
}

chmodSync(cliPath, 0o755);
console.log(`[PASS] manage TUI 目录型入口已生成: ${cliPath}`);
