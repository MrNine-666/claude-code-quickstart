// 语义化版本工具（对齐旧 update-manager.js parseSemver/semverCompare/hasUpdate）。

export type Semver = {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: string | null;
	readonly build: string | null;
};

export function parseSemver(version: string | undefined | null): Semver | null {
	if (!version) {
		return null;
	}

	const normalized = String(version).trim().replace(/^v/i, '');
	const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
	if (!match) {
		return null;
	}

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] || null,
		build: match[5] || null
	};
}

export function semverCompare(v1: string, v2: string): number {
	const a = parseSemver(v1);
	const b = parseSemver(v2);
	if (!a || !b) {
		return 0;
	}

	if (a.major !== b.major) {
		return a.major - b.major;
	}

	if (a.minor !== b.minor) {
		return a.minor - b.minor;
	}

	if (a.patch !== b.patch) {
		return a.patch - b.patch;
	}

	if (!a.prerelease && b.prerelease) {
		return 1;
	}

	if (a.prerelease && !b.prerelease) {
		return -1;
	}

	if (a.prerelease && b.prerelease) {
		return a.prerelease.localeCompare(b.prerelease);
	}

	return 0;
}

/** 判断 current → latest 是否有更新（latest 为 prerelease 视为无更新；任一缺失返回 null）。 */
export function hasUpdate(current: string | undefined | null, latest: string | undefined | null): boolean | null {
	if (!current || !latest) {
		return null;
	}

	const latestParsed = parseSemver(latest);
	if (latestParsed?.prerelease) {
		return false;
	}

	return semverCompare(latest, current) > 0;
}
