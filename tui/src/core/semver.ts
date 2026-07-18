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
	const coreParts = match.slice(1, 4);
	if (coreParts.some(part => part === undefined || (part.length > 1 && part.startsWith('0')))) {
		return null;
	}
	const numericParts = coreParts.map(Number);
	if (numericParts.some(part => !Number.isSafeInteger(part))) {
		return null;
	}
	const prerelease = match[4] || null;
	if (prerelease && !validIdentifiers(prerelease, true)) {
		return null;
	}
	const build = match[5] || null;
	if (build && !validIdentifiers(build, false)) {
		return null;
	}

	return {
		major: numericParts[0]!,
		minor: numericParts[1]!,
		patch: numericParts[2]!,
		prerelease,
		build
	};
}

function validIdentifiers(value: string, enforceNumericLeadingZero: boolean): boolean {
	return value.split('.').every(identifier => {
		if (!identifier || !/^[0-9A-Za-z-]+$/.test(identifier)) return false;
		return !enforceNumericLeadingZero || !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0');
	});
}

function compareNumericIdentifiers(first: string, second: string): number {
	if (first.length !== second.length) return first.length < second.length ? -1 : 1;
	if (first === second) return 0;
	return first < second ? -1 : 1;
}

function comparePrerelease(first: string, second: string): number {
	const firstParts = first.split('.');
	const secondParts = second.split('.');
	const count = Math.max(firstParts.length, secondParts.length);
	for (let index = 0; index < count; index++) {
		const left = firstParts[index];
		const right = secondParts[index];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;
		const leftNumeric = /^\d+$/.test(left);
		const rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) return compareNumericIdentifiers(left, right);
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return left < right ? -1 : 1;
	}
	return 0;
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
		return comparePrerelease(a.prerelease, b.prerelease);
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
