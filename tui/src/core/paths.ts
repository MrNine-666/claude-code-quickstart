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

/** 自更新 transport 分片缓存：`~/.ccq/self-update`，测试通过 CCQ_HOME 隔离。 */
export function selfUpdateCacheDir(): string {
	return join(ccqDir(), 'self-update');
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
 * Codex 主目录：**硬编码 `~/.codex`，不认 CODEX_HOME**。
 * 与 resolveHome 一致支持测试注入（CCQ_HOME 影响 `~/.codex` 的 home 基点）。
 * 覆盖所有 Codex 路径：config.toml / auth.json / AGENTS.md / <key>.config.toml / MCP / ccg-workflow 产物。
 *
 * 为何不认 CODEX_HOME：ccq 管理的是用户系统级 Codex 配置（`~/.codex`），
 * 与上游 ccg-workflow（`codex-mode install` 硬编码 `join(homedir(), '.codex')`）保持一致；
 * orca 等工具虽会注入 CODEX_HOME 到自己的 runtime home，但它以系统 `~/.codex` 为源镜像，
 * ccq 写 `~/.codex` 反而契合其数据流向，也避免运行时临时目录被重建覆盖导致的读写分裂。
 */
export function codexDir(): string {
	return join(resolveHome(), '.codex');
}

/** Codex 基础用户配置 `~/.codex/config.toml`（Codex 卸载绝不删除此文件）。 */
export function codexConfigPath(): string {
	return join(codexDir(), 'config.toml');
}

/** Codex official login 凭据文件 `~/.codex/auth.json`。 */
export function codexAuthJsonPath(): string {
	return join(codexDir(), 'auth.json');
}

/** Codex 官方 profile 文件 `~/.codex/<key>.config.toml`。调用前由 codex core 校验 key。 */
export function codexProfilePath(key: string): string {
	return join(codexDir(), `${key}.config.toml`);
}

/** Codex 全局规则文件 `~/.codex/AGENTS.md`。 */
export function codexAgentsPath(): string {
	return join(codexDir(), 'AGENTS.md');
}
