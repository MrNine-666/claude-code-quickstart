import {homedir} from 'node:os';
import {join} from 'node:path';

/**
 * 解析用户主目录：env 覆盖优先（CCQ_HOME 供测试注入），否则用系统 HOME / USERPROFILE。
 * 与旧 *-manager.js 的 `HOME = process.env.HOME || process.env.USERPROFILE` 行为一致，
 * 但额外支持 CCQ_HOME 覆盖以便单测在临时目录隔离运行。
 */
export function resolveHome(): string {
	const override = process.env.CCQ_HOME;
	if (override && override.trim() !== '') {
		return override;
	}

	return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function claudeDir(): string {
	return join(resolveHome(), '.claude');
}

export function settingsPath(): string {
	return join(claudeDir(), 'settings.json');
}

export function providersDir(): string {
	return join(claudeDir(), 'providers');
}

export function claudeJsonPath(): string {
	return join(resolveHome(), '.claude.json');
}

export function ccqDir(): string {
	return join(resolveHome(), '.ccq');
}

export function vaultPath(): string {
	return join(ccqDir(), 'mcp-meta.json');
}

export function rulesDir(): string {
	return join(claudeDir(), 'rules');
}

export function skillsDir(): string {
	return join(claudeDir(), 'skills');
}

/**
 * Codex 主目录：CODEX_HOME 优先（官方约定），否则 `~/.codex`。
 * 与 resolveHome 一致支持测试注入（CCQ_HOME 影响默认 `~/.codex` 的 home 基点）。
 */
export function codexDir(): string {
	const override = process.env.CODEX_HOME;
	if (override && override.trim() !== '') {
		return override;
	}

	return join(resolveHome(), '.codex');
}

/** Codex 基础用户配置 `$CODEX_HOME/config.toml`（Codex 卸载绝不删除此文件）。 */
export function codexConfigPath(): string {
	return join(codexDir(), 'config.toml');
}

/** Codex 官方 profile 文件 `$CODEX_HOME/<key>.config.toml`。调用前由 codex core 校验 key。 */
export function codexProfilePath(key: string): string {
	return join(codexDir(), `${key}.config.toml`);
}

/** Codex 全局规则文件 `$CODEX_HOME/AGENTS.md`。 */
export function codexAgentsPath(): string {
	return join(codexDir(), 'AGENTS.md');
}
