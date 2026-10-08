import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readJsonFileStrict} from './fs-utils.js';
import {piAgentDir} from './paths.js';
import {parseSemver} from './semver.js';

/** Native PackageSource subset. Unknown incoming fields fail closed; local extras remain untouched. */
export type PiPackageDeclaration =
	| string
	| {
			readonly source: string;
			readonly autoload?: boolean;
			readonly extensions?: readonly string[];
			readonly skills?: readonly string[];
			readonly prompts?: readonly string[];
			readonly themes?: readonly string[];
	  };
export type PiRemoteSource = {
	readonly source: string;
	readonly identity: string;
	readonly kind: 'npm' | 'git';
	readonly name: string;
	readonly version?: string;
	readonly host?: string;
	readonly ref?: string;
};
type Result<T> = {readonly ok: true; readonly data: T} | {readonly ok: false; readonly error: string};
const invalid = (): Result<never> => ({ok: false, error: 'Pi package 来源或资源筛选无效（仅允许无认证的 npm/Git 远程来源）'});
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const piPackageSource = (v: PiPackageDeclaration): string => (typeof v === 'string' ? v : v.source);
export function isLocalPiPackageSource(v: unknown): boolean {
	return (
		(typeof v === 'string' && /^(?:file:|\.{1,2}[\\/]|[\\/]|~|[A-Za-z]:[\\/])/.test(v)) ||
		(typeof v === 'string' && !/^(?:npm:|git:|[A-Za-z][A-Za-z0-9+.-]*:)/.test(v) && !v.startsWith('-'))
	);
}
export function parsePiPackageSource(source: unknown): Result<PiRemoteSource> {
	// execCommand uses cmd.exe on Windows: reject expansion/control/shell syntax before spawn.
	if (
		typeof source !== 'string' ||
		source.length > 2048 ||
		!source ||
		/[\s\x00-\x1f\x7f%"'`$&|;<>!()\\]/.test(source) ||
		source.startsWith('-')
	)
		return invalid();
	if (source.startsWith('npm:')) {
		const m = source.slice(4).match(/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9*~^.+_-]+))?$/);
		if (!m || m[2]?.startsWith('-')) return invalid();
		return {ok: true, data: {source, identity: `npm:${m[1]}`, kind: 'npm', name: m[1]!, ...(m[2] ? {version: m[2]} : {})}};
	}
	let raw = source.startsWith('git:') ? source.slice(4) : source;
	// Only secure transports and native host/path shorthand. No secrets, query, fragment or port ambiguity.
	if (raw.startsWith('git@')) raw = `ssh://git@${raw.slice(4).replace(':', '/')}`;
	else if (source.startsWith('git:') && !raw.includes('://')) raw = `https://${raw}`;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return invalid();
	}
	if (
		!['https:', 'ssh:'].includes(url.protocol) ||
		url.password ||
		(url.username && !(url.protocol === 'ssh:' && url.username === 'git')) ||
		url.search ||
		url.hash ||
		url.port
	)
		return invalid();
	const originalPath = raw
		.slice(raw.indexOf('://') + 3)
		.split('/')
		.slice(1)
		.join('/');
	const m = originalPath.match(/^([^@]+?)(?:@([a-zA-Z0-9][a-zA-Z0-9._/-]*))?$/);
	if (!m || !/^[a-zA-Z0-9.-]+$/.test(url.hostname) || !url.hostname.includes('.') || url.hostname.startsWith('-')) return invalid();
	const path = m[1]!.replace(/\.git$/, '');
	if (
		path.split('/').length < 2 ||
		path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('-') || !/^[a-zA-Z0-9._-]+$/.test(p)) ||
		m[2]?.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('-'))
	)
		return invalid();
	return {
		ok: true,
		data: {source, identity: `git:${url.hostname}/${path}`, kind: 'git', name: path, host: url.hostname, ...(m[2] ? {ref: m[2]} : {})}
	};
}
function safeFilter(value: unknown): boolean {
	if (typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) return false;
	const path = value.replace(/^[!+-]/, '').replace(/^\.\//, '');
	return !!path && !/^(?:\/|~|[A-Za-z]:)/.test(path) && !path.split('/').some(p => p === '..' || p === '.') && !path.includes('://');
}
export function parsePiPackageDeclarations(value: unknown): Result<readonly PiPackageDeclaration[]> {
	if (!Array.isArray(value) || value.length > 1000) return invalid();
	const out: PiPackageDeclaration[] = [];
	const seen = new Map<string, string>();
	for (const entry of value) {
		const source = typeof entry === 'string' ? entry : object(entry) ? entry.source : undefined;
		const parsed = parsePiPackageSource(source);
		if (!parsed.ok) return parsed;
		if (typeof entry !== 'string') {
			if (
				!object(entry) ||
				Object.keys(entry).some(k => !['source', 'autoload', 'extensions', 'skills', 'prompts', 'themes'].includes(k)) ||
				(entry.autoload !== undefined && typeof entry.autoload !== 'boolean')
			)
				return invalid();
			for (const k of ['extensions', 'skills', 'prompts', 'themes']) {
				const filters = entry[k];
				if (filters !== undefined && (!Array.isArray(filters) || filters.length > 1000 || !filters.every(safeFilter)))
					return invalid();
			}
		}
		const repr = JSON.stringify(entry);
		const previous = seen.get(parsed.data.identity);
		if (previous !== undefined) {
			if (previous !== repr) return invalid();
			continue;
		}
		seen.set(parsed.data.identity, repr);
		out.push(entry as PiPackageDeclaration);
	}
	return {ok: true, data: out};
}
function text(path: string): string {
	try {
		return readFileSync(path, 'utf8').trim();
	} catch {
		return '';
	}
}
function gitRef(dir: string, ref: string, seen = new Set<string>()): string {
	if (seen.has(ref)) return '';
	seen.add(ref);
	const raw = text(join(dir, ref));
	if (raw.startsWith('ref: ')) return gitRef(dir, raw.slice(5), seen);
	if (/^[a-f0-9]{40,64}$/i.test(raw)) return raw;
	const lines = text(join(dir, 'packed-refs')).split(/\r?\n/);
	const i = lines.findIndex(line => line.endsWith(` ${ref}`));
	if (i < 0) return '';
	return lines[i + 1]?.startsWith('^') ? lines[i + 1]!.slice(1) : lines[i]!.split(' ')[0]!;
}
/** Zero commands/network/writes. A declaration alone never proves installation. */
export function inspectPiPackageInstallation(source: string): boolean {
	const parsed = parsePiPackageSource(source);
	if (!parsed.ok) return false;
	const p = parsed.data;
	if (p.kind === 'npm') {
		const result = readJsonFileStrict<unknown>(join(piAgentDir(), 'npm', 'node_modules', p.name, 'package.json'));
		if (result.status !== 'valid' || !object(result.value) || result.value.name !== p.name || typeof result.value.version !== 'string')
			return false;
		const version = result.value.version;
		if (!parseSemver(version)) return false;
		if (!p.version || /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(p.version)) return true;
		try {
			return Bun.semver.satisfies(version, p.version);
		} catch {
			return false;
		}
	}
	const dir = join(piAgentDir(), 'git', p.host!, p.name, '.git');
	if (!existsSync(dir)) return false;
	const head = gitRef(dir, 'HEAD');
	if (!head) return false;
	if (!p.ref) return true;
	if (/^[a-f0-9]{7,64}$/i.test(p.ref) && head.startsWith(p.ref)) return true;
	return (
		['refs/tags/', 'refs/heads/', 'refs/remotes/origin/'].some(prefix => gitRef(dir, `${prefix}${p.ref}`) === head) ||
		text(join(dir, 'FETCH_HEAD'))
			.split(/\r?\n/)
			.some(line => line.startsWith(`${head}\t`) && (line.includes(`tag '${p.ref}' of `) || line.includes(`branch '${p.ref}' of `)))
	);
}
