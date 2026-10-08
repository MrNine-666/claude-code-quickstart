import {atomicWrite, readJsonFileStrict, SECRET_FILE_MODE} from './fs-utils.js';
import {ccqSystemSettingsPath} from './paths.js';

// CCQ 自身系统设置 owner：`~/.ccq/system-settings.json`。
// 只拥有 CCQ 偏好与本机备份密码，绝不读写 Claude/Codex/Pi 的 settings。
// 备份密码按用户选择明文保存，仅限本机，不能进入配置迁移包或日志。
// 严格读取：缺失字段采用默认值；损坏或类型不正确 fail closed，不静默覆盖原字节。

type JsonObject = Record<string, unknown>;

/** 已解析的 CCQ 系统设置；缺失字段采用安全默认值。 */
export type CcqSystemSettings = {
	readonly autoUpdate: boolean;
	readonly backupEncryption: boolean;
	readonly backupPassword: string;
};

export type CcqSystemSettingsRead =
	| {readonly status: 'missing'; readonly value: CcqSystemSettings; readonly error: null}
	| {readonly status: 'valid'; readonly value: CcqSystemSettings; readonly error: null}
	| {readonly status: 'invalid'; readonly value: CcqSystemSettings; readonly error: string};

export type CcqSystemSettingsWriteResult = {readonly ok: true} | {readonly ok: false; readonly error: string};

const DEFAULT_SETTINGS: CcqSystemSettings = {autoUpdate: false, backupEncryption: false, backupPassword: ''};

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取 CCQ 系统设置；invalid 时返回默认值但保留受限错误，调用方 fail closed。 */
export function readCcqSystemSettings(): CcqSystemSettingsRead {
	const result = readJsonFileStrict<unknown>(ccqSystemSettingsPath());
	if (result.status === 'missing') {
		return {status: 'missing', value: DEFAULT_SETTINGS, error: null};
	}

	if (result.status === 'invalid') {
		return {status: 'invalid', value: DEFAULT_SETTINGS, error: '系统设置文件损坏或无法解析，已忽略自动更新偏好'};
	}

	if (!isObject(result.value)) {
		return {status: 'invalid', value: DEFAULT_SETTINGS, error: '系统设置必须是 JSON 对象，已忽略自动更新偏好'};
	}

	const autoUpdate = result.value.autoUpdate;
	if (autoUpdate !== undefined && typeof autoUpdate !== 'boolean') {
		return {status: 'invalid', value: DEFAULT_SETTINGS, error: '系统设置 autoUpdate 必须是布尔值，已忽略自动更新偏好'};
	}

	const {backupEncryption, backupPassword} = result.value;
	if (backupEncryption !== undefined && typeof backupEncryption !== 'boolean') {
		return {status: 'invalid', value: DEFAULT_SETTINGS, error: '系统设置 backupEncryption 必须是布尔值'};
	}
	if (backupPassword !== undefined && typeof backupPassword !== 'string') {
		return {status: 'invalid', value: DEFAULT_SETTINGS, error: '系统设置 backupPassword 必须是字符串'};
	}

	return {
		status: 'valid',
		value: {
			autoUpdate: autoUpdate === true,
			backupEncryption: backupEncryption === true,
			backupPassword: backupPassword ?? ''
		},
		error: null
	};
}

/**
 * 保存 CCQ 系统设置：strict-read 保留未知字段；损坏文件拒绝写入（不得静默覆盖）。
 * 原子写 + 保守权限。
 */
export function writeCcqSystemSettings(settings: Partial<CcqSystemSettings>): CcqSystemSettingsWriteResult {
	// 语义校验：JSON 合法但 autoUpdate 类型错误同样拒绝写入，避免静默覆盖原值。
	const semantic = readCcqSystemSettings();
	if (semantic.status === 'invalid') {
		return {ok: false, error: `${semantic.error}；已停止写入，请先手动修复该文件`};
	}

	const current = readJsonFileStrict<unknown>(ccqSystemSettingsPath());
	const base: JsonObject = current.status === 'valid' && isObject(current.value) ? {...current.value} : {};
	base.autoUpdate = settings.autoUpdate ?? semantic.value.autoUpdate;
	base.backupEncryption = settings.backupEncryption ?? semantic.value.backupEncryption;
	base.backupPassword = settings.backupPassword ?? semantic.value.backupPassword;

	try {
		atomicWrite(ccqSystemSettingsPath(), JSON.stringify(base, null, 2), {mode: SECRET_FILE_MODE});
		return {ok: true};
	} catch {
		return {ok: false, error: '系统设置写入失败'};
	}
}
