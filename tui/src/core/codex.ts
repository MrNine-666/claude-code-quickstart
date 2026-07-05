import {existsSync, readdirSync} from 'node:fs';
import {testProviderKey} from './text-utils.js';
import {codexDir, codexProfilePath} from './paths.js';

// Codex provider/profile core：官方 profile-file 机制 + key 唯一身份（design D6/D7）。
// API key 直写 profile TOML 的写入逻辑在后续切片（5.6/5.8）接入 toml-edit.ts，本文件只负责身份与扫描。

export type CodexProviderType = 'officialLogin' | 'apiKey' | 'custom';

export type CodexProfile = {
	readonly key: string;
	readonly providerType: CodexProviderType;
	readonly baseUrl: string;
	readonly model: string;
	readonly hasApiKey: boolean;
	readonly profilePath: string;
};

export type CodexProfileListItem = {
	readonly key: string;
	readonly providerType: CodexProviderType;
	readonly baseUrl: string;
	readonly hasApiKey: boolean;
	readonly isDefault: boolean;
	readonly profilePath: string;
};

const PROFILE_SUFFIX = '.config.toml';

/** Codex profile key 复用 Claude provider key 安全规则，并额外拒绝 `.`/`..` 与 `-` 开头。 */
export function testCodexProfileKey(key: string | undefined | null): boolean {
	if (!testProviderKey(key)) {
		return false;
	}

	const value = String(key);
	if (value === '.' || value === '..' || value.startsWith('-')) {
		return false;
	}

	return true;
}

/** 校验 key 并返回安全 profile 文件名 stem；非法 key 抛错（写盘前调用）。 */
export function safeCodexProfileKey(key: string): string {
	if (!testCodexProfileKey(key)) {
		throw new Error(`非法 Codex profile key: ${key}`);
	}

	return String(key);
}

/** key 唯一身份派生：文件名 stem / profile name / model_provider id / table id / 默认显示名。 */
export function codexIdentityFromKey(key: string): {
	filenameStem: string;
	profileName: string;
	providerId: string;
	modelProvidersTableId: string;
	defaultDisplayName: string;
} {
	const safe = safeCodexProfileKey(key);
	return {
		filenameStem: safe,
		profileName: safe,
		providerId: safe,
		modelProvidersTableId: safe,
		defaultDisplayName: safe
	};
}

/** 解析 profile 文件路径为 key（仅识别 `$CODEX_HOME/<key>.config.toml`）。 */
export function codexProfileKeyFromPath(profilePath: string): string | null {
	const fileName = profilePath.split(/[/\\]/).pop() ?? '';
	if (!fileName.endsWith(PROFILE_SUFFIX)) {
		return null;
	}

	const stem = fileName.slice(0, -PROFILE_SUFFIX.length);
	return testCodexProfileKey(stem) ? stem : null;
}

/** 扫描 `$CODEX_HOME` 下所有 `<key>.config.toml`，返回合法 key 列表（不解析文件内容）。 */
export function listCodexProfileKeys(): readonly string[] {
	const dir = codexDir();
	if (!existsSync(dir)) {
		return [];
	}

	const keys: string[] = [];
	for (const entry of readdirSync(dir)) {
		const key = codexProfileKeyFromPath(entry);
		if (key) {
			keys.push(key);
		}
	}

	return keys.sort((a, b) => a.localeCompare(b));
}

/** profile 文件是否存在（供 setDefault 删除前校验等场景复用）。 */
export function codexProfileExists(key: string): boolean {
	if (!testCodexProfileKey(key)) {
		return false;
	}

	return existsSync(codexProfilePath(key));
}
