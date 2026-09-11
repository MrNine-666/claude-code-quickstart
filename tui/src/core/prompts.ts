import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {claudeDir} from './paths.js';

/** 用户级 CLAUDE.md 路径（~/.claude/CLAUDE.md）。 */
export function claudeMdPath(): string {
	return join(claudeDir(), 'CLAUDE.md');
}

/** 读取当前用户级 CLAUDE.md（不存在或读取失败返回 null）。 */
export function readInstalledClaudeMd(): string | null {
	const path = claudeMdPath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}
