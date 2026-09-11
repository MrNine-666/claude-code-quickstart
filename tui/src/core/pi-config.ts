import {existsSync, readFileSync} from 'node:fs';
import {loadContract} from './contracts.js';
import {atomicWrite, readJsonFileStrict, SECRET_FILE_MODE} from './fs-utils.js';
import {piProjectSettingsPath, piSettingsPath} from './paths.js';

type JsonObject = Record<string, unknown>;

type PiConfigContract = {
	readonly Defaults?: JsonObject;
	readonly ProtectedKeys?: readonly string[];
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contract(): PiConfigContract {
	try {
		return loadContract<PiConfigContract>('pi-config.json');
	} catch {
		return {Defaults: {}, ProtectedKeys: []};
	}
}

function stripProtected(source: JsonObject): JsonObject {
	const next = {...source};
	for (const key of contract().ProtectedKeys ?? []) delete next[key];
	return next;
}

function mergeWithOriginal(edited: JsonObject, original: JsonObject | null): JsonObject {
	// Config owns every field except those explicitly listed by another module.
	// This keeps unknown Pi settings editable and allows new settings to be added.
	const next = stripProtected(edited);
	if (!original) return next;

	// Protected fields are never accepted from the editor; preserve their original
	// values, including the case where the editor typed a new protected field.
	for (const key of contract().ProtectedKeys ?? []) {
		if (key in original) next[key] = original[key];
		else delete next[key];
	}
	return next;
}

export function readPiConfigText(): string {
	if (!existsSync(piSettingsPath())) return '';
	try {
		const raw = readFileSync(piSettingsPath(), 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		return isObject(parsed) ? JSON.stringify(stripProtected(parsed), null, 2) : raw;
	} catch {
		return readFileSync(piSettingsPath(), 'utf8');
	}
}

export function piConfigFileExists(): boolean {
	return existsSync(piSettingsPath());
}

export function piProjectSettingsExists(): boolean {
	return existsSync(piProjectSettingsPath());
}

export function piConfigRecommendation(): string {
	return JSON.stringify(contract().Defaults ?? {}, null, 2);
}

export function applyPiConfigFillMissing(text: string): {ok: true; text: string; changed: number} | {ok: false; error: string} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text || '{}');
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}
	if (!isObject(parsed)) return {ok: false, error: 'Pi settings 必须是 JSON 对象'};
	const next = stripProtected(parsed);
	let changed = 0;
	for (const [key, value] of Object.entries(contract().Defaults ?? {})) {
		if (next[key] === undefined) {
			next[key] = value;
			changed += 1;
		}
	}
	return {ok: true, text: JSON.stringify(next, null, 2), changed};
}

export function savePiConfigText(text: string): {ok: boolean; error?: string} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}
	if (!isObject(parsed)) return {ok: false, error: 'Pi settings 必须是 JSON 对象'};
	const current = readJsonFileStrict<unknown>(piSettingsPath());
	if (current.status === 'invalid' || (current.status === 'valid' && !isObject(current.value))) {
		return {ok: false, error: '~/.pi/agent/settings.json 损坏或无法解析，已停止写入'};
	}
	try {
		const original = current.status === 'valid' && isObject(current.value) ? current.value : null;
		atomicWrite(piSettingsPath(), JSON.stringify(mergeWithOriginal(parsed, original), null, 2), {mode: SECRET_FILE_MODE});
		return {ok: true};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
