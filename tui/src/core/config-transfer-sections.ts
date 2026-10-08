import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync} from 'node:fs';
import {dirname, isAbsolute, join, posix, relative, resolve, sep} from 'node:path';

import {atomicWrite, readJsonFileStrict, SECRET_FILE_MODE} from './fs-utils.js';
import {claudeDir, codexConfigPath, codexDir, piAgentDir, piSettingsPath, resolveHome} from './paths.js';
import {
	type PortableTreeEntry,
	type PortableTreeRootId,
	parsePortableTreeEntries,
	parsePortableTreeEntry,
	type SectionMergeReport,
	type TransferImportMode,
	type TransferResult,
	transferFail,
	transferOk
} from './config-transfer.js';
import {atomicWrite as atomicWriteToml, parse as parseToml, stringify as stringifyToml, type TomlDocument} from './toml-edit.js';
import {portableCodexConfig, readCodexConfigDocumentStrict, stripCodexUnmanagedKeys} from './codex-config.js';
import {readInstalledSettingsText, settingsFilePath, stripProviderEnvFromDocument} from './config-recommend.js';
import {readPiConfigText, stripPiConfigProtectedFields} from './pi-config.js';

// 通用设置与全局规则的导入导出 seam（Phase 2）。
// 设置语义复用各 owner 的 owned projection：Claude 剥离 provider-owned 键与 env、
// Codex 剥离 provider/MCP 键并过滤本机绑定、Pi 剥离其他模块的受保护字段。
// 规则按相对路径合并覆盖：同路径替换、新路径新增，包中缺失的本机路径永不删除。
// 本模块只产出 identity/计数事实，绝不把凭据值或绝对 HOME 路径放进报告。

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObjectText(text: string): boolean {
	try {
		return isRecord(JSON.parse(text) as unknown);
	} catch {
		return false;
	}
}

export type TransferSectionTool = 'cc' | 'cx' | 'pi';

export type SettingsSection = {
	readonly text: string;
	/** 快照中是否实际包含文件型凭据（Claude `env` 与 Pi 顶层的凭据键）。 */
	readonly containsCredentials: boolean;
	/** 被剥离/包含的凭据字段 identity（如 `env.ANTHROPIC_API_KEY`）；只报键名，绝不报值。 */
	readonly credentialKeys: readonly string[];
};
export type RulesSection = {readonly entries: readonly PortableTreeEntry[]};

/**
 * 键名形似文件型凭据的字段（API Key / token / secret 等）。
 * Claude Code 用户常在 `settings.json` 的 `env` 里放 `ANTHROPIC_API_KEY`，Pi 用户也可能在
 * `settings.json` 顶层写 `apiKey`；两者都不在各自 owner 的受保护字段里，所以导入导出边界
 * 必须自行守卫：未选凭据时移除，选中时计入 `containsCredentials` 并强制加密。
 */
const CREDENTIAL_KEY_PATTERN = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

function credentialKeysOf(record: Readonly<Record<string, unknown>>): readonly string[] {
	return Object.keys(record)
		.filter(key => CREDENTIAL_KEY_PATTERN.test(key))
		.sort();
}

/** 按需移除给定键；返回新 document 与被处理的键名。 */
function stripKeys(document: JsonObject, keys: readonly string[], strip: boolean): JsonObject {
	if (!strip || keys.length === 0) {
		return document;
	}

	const next: JsonObject = {...document};
	for (const key of keys) {
		delete next[key];
	}

	return next;
}

/** Claude `settings.json`：`env` 内的凭据键。 */
function stripClaudeCredentialEnv(document: JsonObject, strip: boolean): {readonly document: JsonObject; readonly keys: readonly string[]} {
	const env = document.env;
	if (!isRecord(env)) {
		return {document, keys: []};
	}

	const keys = credentialKeysOf(env);
	if (!strip || keys.length === 0) {
		return {document, keys: keys.map(key => `env.${key}`)};
	}

	const nextEnv: JsonObject = {...env};
	for (const key of keys) {
		delete nextEnv[key];
	}

	return {document: {...document, env: nextEnv}, keys: keys.map(key => `env.${key}`)};
}

/** 深度合并：包内值逐叶覆盖本机值，包中未出现的本机键/表原样保留。 */
export function mergeTransferDocuments(local: unknown, incoming: unknown): unknown {
	if (!isRecord(local) || !isRecord(incoming)) {
		return incoming;
	}

	const merged: JsonObject = {...local};
	for (const [key, value] of Object.entries(incoming)) {
		merged[key] = isRecord(merged[key]) && isRecord(value) ? mergeTransferDocuments(merged[key], value) : value;
	}

	return merged;
}

// ── 通用设置 ─────────────────────────────────────────────────────────────────

/** 快照通用设置的选项：是否把文件型凭据包含进快照。 */
export type SnapshotSettingsOptions = {readonly includeCredentials?: boolean};

/** 快照通用设置的可迁移投影（复用各 owner 的 owned-field 剥离）。 */
export function snapshotSettingsSection(tool: TransferSectionTool, options: SnapshotSettingsOptions = {}): TransferResult<SettingsSection> {
	if (tool === 'cx') {
		const config = readCodexConfigDocumentStrict();
		if (config.status === 'missing') {
			return transferOk({text: '', containsCredentials: false, credentialKeys: []});
		}

		if (config.status === 'invalid') {
			return transferOk({text: '', containsCredentials: false, credentialKeys: []}, ['Codex config.toml 损坏，未包含通用设置']);
		}

		const portable = portableCodexConfig(stripCodexUnmanagedKeys(config.value));
		const warnings = portable.excluded.map(exclusion => `已排除本机绑定配置：${exclusion.key}`);
		return transferOk({text: stringifyToml(portable.config), containsCredentials: false, credentialKeys: []}, warnings);
	}

	if (tool === 'pi') {
		if (!existsSync(piSettingsPath())) {
			return transferOk({text: '', containsCredentials: false, credentialKeys: []});
		}

		const text = readPiConfigText();
		if (!isJsonObjectText(text)) {
			return transferOk({text: '', containsCredentials: false, credentialKeys: []}, ['Pi settings.json 损坏，未包含通用设置']);
		}

		const includeCredentials = options.includeCredentials === true;
		const document = JSON.parse(text) as JsonObject;
		delete document.deviceId;
		delete document.lastChangelogVersion;
		const keys = credentialKeysOf(document);
		const stripped = stripKeys(document, keys, !includeCredentials);
		const warnings = !includeCredentials && keys.length > 0 ? [`已移除凭据字段：${keys.join('、')}`] : [];
		return transferOk(
			{
				text: JSON.stringify(stripped, null, 2),
				containsCredentials: includeCredentials && keys.length > 0,
				credentialKeys: keys
			},
			warnings
		);
	}

	if (!existsSync(settingsFilePath())) {
		return transferOk({text: '', containsCredentials: false, credentialKeys: []});
	}

	const raw = readInstalledSettingsText();
	if (raw === null) {
		return transferOk({text: '', containsCredentials: false, credentialKeys: []}, [
			'Claude Code settings.json 无法读取，未包含通用设置'
		]);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return transferOk({text: '', containsCredentials: false, credentialKeys: []}, ['Claude Code settings.json 损坏，未包含通用设置']);
	}

	if (!isRecord(parsed)) {
		return transferOk({text: '', containsCredentials: false, credentialKeys: []}, ['Claude Code settings.json 损坏，未包含通用设置']);
	}

	const includeCredentials = options.includeCredentials === true;
	const owned = stripProviderEnvFromDocument(parsed);
	const stripped = stripClaudeCredentialEnv(owned, !includeCredentials);
	const warnings = !includeCredentials && stripped.keys.length > 0 ? [`已移除凭据字段：${stripped.keys.join('、')}`] : [];
	return transferOk(
		{
			text: JSON.stringify(stripped.document, null, 2),
			containsCredentials: includeCredentials && stripped.keys.length > 0,
			credentialKeys: stripped.keys
		},
		warnings
	);
}

/** 校验包中的通用设置分类（导入边界；不信任包内容）。 */
export function parseSettingsSection(tool: TransferSectionTool, value: unknown): TransferResult<SettingsSection> {
	if (!isRecord(value) || typeof value.text !== 'string') {
		return transferFail('validation', '通用设置分类内容无效');
	}

	if (value.text.trim() === '') {
		return transferOk({text: '', containsCredentials: false, credentialKeys: []});
	}

	if (tool === 'cx') {
		try {
			parseToml(value.text);
		} catch {
			return transferFail('validation', '通用设置分类不是有效 TOML');
		}

		return transferOk({text: value.text, containsCredentials: false, credentialKeys: []});
	}

	return isJsonObjectText(value.text)
		? transferOk({text: value.text, containsCredentials: false, credentialKeys: []})
		: transferFail('validation', '通用设置分类不是有效 JSON 对象');
}

export type ImportSettingsOptions = {readonly dryRun?: boolean; readonly containsCredentials?: boolean};

/** 合并导入通用设置：包内 owned 字段覆盖，本机其他领域与未知字段保留。 */
export function importSettingsSection(
	tool: TransferSectionTool,
	data: unknown,
	options: ImportSettingsOptions = {}
): TransferResult<SectionMergeReport> {
	const parsed = parseSettingsSection(tool, data);
	if (!parsed.ok) {
		return parsed;
	}

	if (parsed.data.text.trim() === '') {
		return transferOk({added: [], replaced: [], unchanged: ['settings'], skipped: [], warnings: parsed.warnings});
	}

	if (tool === 'cx') {
		return importCodexSettings(parsed.data.text, options.dryRun ?? false);
	}

	if (tool === 'pi') {
		return importPiSettings(parsed.data.text, options.dryRun ?? false, options.containsCredentials === true);
	}

	return importClaudeSettings(parsed.data.text, options.dryRun ?? false, options.containsCredentials === true);
}

function settingsReport(existed: boolean, changed: boolean, warnings: readonly string[]): TransferResult<SectionMergeReport> {
	return transferOk({
		added: changed && !existed ? ['settings'] : [],
		replaced: changed && existed ? ['settings'] : [],
		unchanged: changed ? [] : ['settings'],
		skipped: [],
		warnings
	});
}

function importClaudeSettings(text: string, dryRun: boolean, containsCredentials: boolean): TransferResult<SectionMergeReport> {
	let incoming: JsonObject;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed)) {
			return transferFail('validation', '通用设置分类不是 JSON 对象');
		}

		// provider-owned 顶层键与 env 归供应商分类，导入设置时绝不覆盖本机值。
		incoming = stripProviderEnvFromDocument(parsed);
	} catch {
		return transferFail('validation', '通用设置分类不是有效 JSON');
	}

	// 防御性：包标记为不含凭据时，即使其中夹带凭据 env 键也不写入（与 MCP 侧同语义）。
	incoming = stripClaudeCredentialEnv(incoming, !containsCredentials).document;

	const local = readJsonFileStrict<unknown>(settingsFilePath());
	if (local.status === 'invalid' || (local.status === 'valid' && !isRecord(local.value))) {
		return transferFail('conflict', '本机 Claude Code settings.json 损坏，已停止导入通用设置');
	}

	const localDocument = local.status === 'valid' ? (local.value as JsonObject) : {};
	const merged = mergeTransferDocuments(localDocument, incoming) as JsonObject;
	const changed = JSON.stringify(localDocument) !== JSON.stringify(merged);
	if (changed && !dryRun) {
		try {
			atomicWrite(settingsFilePath(), JSON.stringify(merged, null, 2), {mode: SECRET_FILE_MODE});
		} catch {
			return transferFail('io', 'Claude Code settings.json 写入失败');
		}
	}

	return settingsReport(local.status === 'valid', changed, []);
}

function importCodexSettings(text: string, dryRun: boolean): TransferResult<SectionMergeReport> {
	let incoming: ReturnType<typeof portableCodexConfig>;
	try {
		incoming = portableCodexConfig(stripCodexUnmanagedKeys(parseToml(text)));
	} catch {
		return transferFail('validation', '通用设置分类不是有效 TOML');
	}

	const local = readCodexConfigDocumentStrict();
	if (local.status === 'invalid') {
		return transferFail('conflict', '本机 Codex config.toml 损坏，已停止导入通用设置');
	}

	const localDocument = local.status === 'valid' ? local.value : {};
	const merged = mergeTransferDocuments(localDocument, incoming.config) as TomlDocument;
	const changed = JSON.stringify(localDocument) !== JSON.stringify(merged);
	if (changed && !dryRun) {
		try {
			atomicWriteToml(codexConfigPath(), merged, {mode: SECRET_FILE_MODE});
		} catch {
			return transferFail('io', 'Codex config.toml 写入失败');
		}
	}

	const warnings = incoming.excluded.map(exclusion => `已排除本机绑定配置：${exclusion.key}`);
	return settingsReport(local.status === 'valid', changed, warnings);
}

function importPiSettings(text: string, dryRun: boolean, containsCredentials: boolean): TransferResult<SectionMergeReport> {
	let incoming: JsonObject;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed)) {
			return transferFail('validation', '通用设置分类不是 JSON 对象');
		}

		// 其他模块拥有的受保护字段（auth/models/mcp/skills 等）不随设置分类写入。
		incoming = stripPiConfigProtectedFields(parsed);
	} catch {
		return transferFail('validation', '通用设置分类不是有效 JSON');
	}

	// Machine identity and local changelog state never migrate, including from old bundles.
	delete incoming.deviceId;
	delete incoming.lastChangelogVersion;
	incoming = stripKeys(incoming, credentialKeysOf(incoming), !containsCredentials);

	const local = readJsonFileStrict<unknown>(piSettingsPath());
	if (local.status === 'invalid' || (local.status === 'valid' && !isRecord(local.value))) {
		return transferFail('conflict', '本机 Pi settings.json 损坏，已停止导入通用设置');
	}

	const localDocument = local.status === 'valid' ? (local.value as JsonObject) : {};
	const merged = mergeTransferDocuments(localDocument, incoming) as JsonObject;
	const changed = JSON.stringify(localDocument) !== JSON.stringify(merged);
	if (changed && !dryRun) {
		try {
			atomicWrite(piSettingsPath(), JSON.stringify(merged, null, 2), {mode: SECRET_FILE_MODE});
		} catch {
			return transferFail('io', 'Pi settings.json 写入失败');
		}
	}

	return settingsReport(local.status === 'valid', changed, []);
}

// ── 全局规则 ─────────────────────────────────────────────────────────────────

type RulesTarget = {
	readonly root: PortableTreeRootId;
	readonly baseDir: string;
	readonly files: readonly string[];
	readonly dirs: readonly string[];
};

function rulesTarget(tool: TransferSectionTool): RulesTarget {
	if (tool === 'cc') {
		return {root: 'claude', baseDir: claudeDir(), files: ['CLAUDE.md'], dirs: ['rules']};
	}

	if (tool === 'cx') {
		return {root: 'codex', baseDir: codexDir(), files: ['AGENTS.md'], dirs: []};
	}

	return {root: 'pi-agent', baseDir: piAgentDir(), files: ['AGENTS.md'], dirs: []};
}

/** 仅排除已知认证/会话文件名（不对用户代码中的硬编码密钥作识别承诺）。 */
export function excludedTransferAuthFile(path: string): boolean {
	const parts = path.toLowerCase().split('/');
	if (parts.some(part => ['node_modules', '.git', '.auth', '.sessions'].includes(part))) return true;
	const name = parts.at(-1) ?? '';
	return (
		/^\.env(?:\..*)?$/.test(name) ||
		['.npmrc', '.pypirc'].includes(name) ||
		/^(?:auth|oauth|tokens?|sessions?|credentials?|device-auth)(?:\.[^.]+)?\.(?:json|ya?ml|toml|env|key)$/i.test(name)
	);
}

export function excludedTransferAuthSymlink(entry: PortableTreeEntry): boolean {
	return entry.kind === 'symlink' && excludedTransferAuthFile(posix.normalize(posix.join(posix.dirname(entry.path), entry.target)));
}

export type CollectPortableTreeOptions = {
	readonly root: PortableTreeRootId;
	readonly baseDir: string;
	/** 精确匹配的相对文件路径（如 `CLAUDE.md`）。 */
	readonly files: readonly string[];
	/** 递归采集的相对目录前缀（如 `rules`）。 */
	readonly dirs: readonly string[];
	/** 采集整个 baseDir 树（Pi Extensions 等整目录内容导出）。 */
	readonly all?: boolean;
	/** 已知不应携带的相对路径；不扫描源码内容。 */
	readonly exclude?: (relativePath: string) => boolean;
	/** 删除预检必须完整枚举，不能把导出时的尽力跳过解释为覆盖授权。 */
	readonly strict?: boolean;
};

/** 受限权限集合内的等价 mode：可执行 → 755，仅 owner 可读 → 600，其余 → 644。 */
function portableMode(mode: number): number {
	if ((mode & 0o111) !== 0) {
		return 0o755;
	}

	return (mode & 0o044) === 0 ? 0o600 : 0o644;
}

/** 从受管目录采集 portable tree 条目；不安全的符号链接逐条跳过并进入 warnings。 */
export function collectPortableTreeEntries(
	options: CollectPortableTreeOptions
): TransferResult<{readonly entries: readonly PortableTreeEntry[]; readonly warnings: readonly string[]}> {
	const entries: PortableTreeEntry[] = [];
	const warnings: string[] = [];
	let incomplete = false;
	const allowed = (relativePath: string): boolean =>
		options.all === true || options.files.includes(relativePath) || options.dirs.some(dir => relativePath.startsWith(`${dir}/`));
	const shouldDescend = (relativePath: string): boolean =>
		options.all === true ||
		options.dirs.some(dir => relativePath === dir || relativePath.startsWith(`${dir}/`) || dir.startsWith(`${relativePath}/`));

	const walk = (dir: string, prefix: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			incomplete = true;
			warnings.push('条目目录无法读取');
			return;
		}

		for (const name of names) {
			const fullPath = join(dir, name);
			const relativePath = prefix ? `${prefix}/${name}` : name;
			if (options.strict && !allowed(relativePath) && !shouldDescend(relativePath)) continue;
			if (options.exclude?.(relativePath)) {
				warnings.push('已排除认证/会话文件');
				continue;
			}
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(fullPath);
			} catch {
				incomplete = true;
				warnings.push(`条目无法读取：${relativePath}`);
				continue;
			}

			// 覆盖不能猜测链接的共享引用或把文件位置上的目录递归清空。
			if (
				options.strict &&
				(stat.isSymbolicLink() ||
					(options.files.includes(relativePath) && !stat.isFile()) ||
					(options.dirs.includes(relativePath) && !stat.isDirectory()))
			) {
				incomplete = true;
				continue;
			}
			if (stat.isDirectory()) {
				if (shouldDescend(relativePath)) {
					walk(fullPath, relativePath);
				}

				continue;
			}

			if (!allowed(relativePath)) {
				continue;
			}

			let entry: PortableTreeEntry | null = null;
			try {
				if (stat.isSymbolicLink()) {
					entry = {kind: 'symlink', root: options.root, path: relativePath, target: readlinkSync(fullPath)};
				} else if (stat.isFile()) {
					entry = {
						kind: 'file',
						root: options.root,
						path: relativePath,
						contentBase64: readFileSync(fullPath).toString('base64'),
						mode: portableMode(stat.mode)
					};
				}
			} catch {
				entry = null;
			}

			if (!entry) {
				incomplete = true;
				warnings.push(`条目无法读取：${relativePath}`);
				continue;
			}

			const validated = parsePortableTreeEntry(entry);
			if (!validated.ok) {
				incomplete = true;
				warnings.push(`已跳过不安全的条目：${relativePath}`);
				continue;
			}
			if (excludedTransferAuthSymlink(validated.data)) {
				warnings.push('已排除指向认证/会话文件的链接');
				continue;
			}

			entries.push(validated.data);
		}
	};

	if (options.strict) {
		try {
			const stat = lstatSync(options.baseDir);
			if (!stat.isDirectory() || stat.isSymbolicLink()) incomplete = true;
			else walk(options.baseDir, '');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true;
		}
	} else if (existsSync(options.baseDir)) {
		walk(options.baseDir, '');
	}

	if (options.strict && incomplete) {
		return transferFail('conflict', '覆盖范围存在链接、异常类型或无法完整读取的条目；请改用合并');
	}
	return transferOk({entries, warnings});
}

/** 快照全局规则（CC: CLAUDE.md + rules/**；CX/Pi: AGENTS.md）。 */
export function snapshotRulesSection(tool: TransferSectionTool): TransferResult<RulesSection> {
	const target = rulesTarget(tool);
	const collected = collectPortableTreeEntries({
		root: target.root,
		baseDir: target.baseDir,
		files: target.files,
		dirs: target.dirs,
		exclude: excludedTransferAuthFile
	});
	if (!collected.ok) {
		return collected;
	}

	return transferOk({entries: collected.data.entries}, collected.data.warnings);
}

function rulesPathAllowed(target: RulesTarget, path: string): boolean {
	return target.files.includes(path) || target.dirs.some(dir => path.startsWith(`${dir}/`));
}

/** 校验包中的规则分类（导入边界；只接受该工具受支持的相对路径）。 */
export function parseRulesSection(tool: TransferSectionTool, value: unknown): TransferResult<RulesSection> {
	if (!isRecord(value) || !Array.isArray(value.entries)) {
		return transferFail('validation', '规则分类内容无效');
	}

	const target = rulesTarget(tool);
	const entries: PortableTreeEntry[] = [];
	for (const raw of value.entries) {
		const parsed = parsePortableTreeEntry(raw);
		if (!parsed.ok) {
			return parsed;
		}

		if (
			parsed.data.root !== target.root ||
			!rulesPathAllowed(target, parsed.data.path) ||
			excludedTransferAuthFile(parsed.data.path) ||
			excludedTransferAuthSymlink(parsed.data)
		) {
			return transferFail('validation', '规则分类包含不受支持的路径');
		}

		entries.push(parsed.data);
	}

	const unique = parsePortableTreeEntries(entries);
	return unique.ok ? transferOk({entries: unique.data}) : unique;
}

function isInsideBaseDir(baseDir: string, fullPath: string): boolean {
	const base = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
	return fullPath.startsWith(base) && fullPath.length > base.length;
}

function inside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** 只读 preflight：root 不可经本机 symlink 重定向，每级现存祖先须解析在受管 root 内。 */
export function portableTargetSafe(baseDir: string, fullPath: string): boolean {
	if (!isInsideBaseDir(baseDir, fullPath)) return false;
	const base = resolve(baseDir);
	const home = resolve(resolveHome());
	// 禁止 ~/.pi/agent、~/.claude 等 root 的父目录指向别处；home 本身是信任锚点。
	if (base === home || inside(home, base)) {
		let current = home;
		for (const segment of relative(home, base).split(sep).filter(Boolean)) {
			current = join(current, segment);
			try {
				if (lstatSync(current).isSymbolicLink()) return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
			}
		}
	}

	try {
		if (lstatSync(base).isSymbolicLink()) return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
	}
	const root = existsSync(base) ? realpathSync(base) : base;
	let ancestor = base;
	for (const segment of relative(base, fullPath).split(sep)) {
		ancestor = join(ancestor, segment);
		try {
			lstatSync(ancestor);
			if (!inside(root, realpathSync(ancestor))) return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
		}
	}
	return true;
}

function readFileIfExists(path: string): Buffer | null {
	try {
		return lstatSync(path).isFile() ? readFileSync(path) : null;
	} catch {
		return null;
	}
}

function readSymlinkTargetIfExists(path: string): string | null {
	try {
		return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null;
	} catch {
		return null;
	}
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * 将 portable tree 条目物化到 baseDir：同路径覆盖、新路径新增，绝不删除本机多余文件。
 * dryRun 为 true 时只计算 merge 报告，零写盘。
 */
export function materializePortableTreeEntries(
	baseDir: string,
	entries: readonly PortableTreeEntry[],
	dryRun: boolean
): TransferResult<SectionMergeReport> {
	const added: string[] = [];
	const replaced: string[] = [];
	const unchanged: string[] = [];
	const warnings: string[] = [];

	// 整类先检查，避免第一项已写盘后才发现后续路径通过本机 symlink 跳出 root。
	if (entries.some(entry => excludedTransferAuthFile(entry.path) || excludedTransferAuthSymlink(entry))) {
		return transferFail('validation', '分类包含认证/会话文件');
	}
	if (
		entries.some(
			entry =>
				!portableTargetSafe(baseDir, join(baseDir, ...entry.path.split('/'))) ||
				(entry.kind === 'symlink' &&
					!portableTargetSafe(baseDir, resolve(dirname(join(baseDir, ...entry.path.split('/'))), entry.target)))
		)
	) {
		return transferFail('conflict', '本机文件树路径越过受管目录，已停止导入');
	}

	for (const entry of entries) {
		const fullPath = join(baseDir, ...entry.path.split('/'));
		if (!portableTargetSafe(baseDir, fullPath)) {
			return transferFail('conflict', '本机文件树路径越过受管目录，已停止导入');
		}

		if (entry.kind === 'file') {
			const content = Buffer.from(entry.contentBase64, 'base64');
			const existing = readFileIfExists(fullPath);
			if (existing?.equals(content)) {
				unchanged.push(entry.path);
				continue;
			}

			(existing === null ? added : replaced).push(entry.path);
			if (!dryRun) {
				try {
					// 原始字节写入：扩展/规则树可能含二进制资源，utf8 往返会损坏内容并使 postflight 失败。
					atomicWrite(fullPath, content, {mode: entry.mode});
				} catch {
					return transferFail('io', `文件写入失败：${entry.path}`);
				}
			}

			continue;
		}

		const currentTarget = readSymlinkTargetIfExists(fullPath);
		if (currentTarget === entry.target) {
			unchanged.push(entry.path);
			continue;
		}

		const exists = pathExists(fullPath);
		(exists ? replaced : added).push(entry.path);
		if (dryRun) {
			continue;
		}

		try {
			mkdirSync(dirname(fullPath), {recursive: true});
			if (exists) {
				unlinkSync(fullPath);
			}

			symlinkSync(entry.target, fullPath);
		} catch {
			return transferFail('io', `符号链接写入失败：${entry.path}`);
		}
	}

	return transferOk({added, replaced, unchanged, skipped: [], warnings});
}

/** 覆盖只删除完整预检过的受管普通文件，不递归删除目录，不跟随链接。调用方拥有分类事务。 */
export function replacePortableTreeEntries(
	options: CollectPortableTreeOptions,
	entries: readonly PortableTreeEntry[],
	dryRun: boolean
): TransferResult<SectionMergeReport> {
	if (!portableTargetSafe(options.baseDir, join(options.baseDir, '__ccq_boundary_probe__'))) {
		return transferFail('conflict', '本机文件树路径越过受管目录，已停止覆盖');
	}
	if (entries.some(entry => entry.kind === 'symlink')) {
		return transferFail('conflict', '覆盖包包含链接，无法证明删除后引用安全；请改用合并');
	}
	const local = collectPortableTreeEntries({...options, strict: true});
	if (!local.ok) return local;
	const incomingPaths = new Set(entries.map(entry => entry.path));
	const removals = local.data.entries.filter(entry => !incomingPaths.has(entry.path));
	const removed = removals.map(entry => entry.path);
	const preflight = materializePortableTreeEntries(options.baseDir, [...entries, ...removals], true);
	if (!preflight.ok) return preflight;
	const written = materializePortableTreeEntries(options.baseDir, entries, dryRun);
	if (!written.ok) return written;
	if (!dryRun) {
		for (const path of removed) {
			const target = join(options.baseDir, ...path.split('/'));
			if (!portableTargetSafe(options.baseDir, target)) return transferFail('conflict', '删除目标越过受管目录，已停止覆盖');
			try {
				if (!lstatSync(target).isFile()) return transferFail('conflict', '删除目标类型变化，已停止覆盖');
				unlinkSync(target);
			} catch {
				return transferFail('io', `文件删除失败：${path}`);
			}
		}
	}
	return transferOk({...written.data, removed});
}

/** 默认合并；覆盖仅替换该工具明确拥有的全局规则范围。 */
export function importRulesSection(
	tool: TransferSectionTool,
	data: unknown,
	options: {readonly dryRun?: boolean; readonly mode?: TransferImportMode} = {}
): TransferResult<SectionMergeReport> {
	const parsed = parseRulesSection(tool, data);
	if (!parsed.ok) {
		return parsed;
	}

	const target = rulesTarget(tool);
	return options.mode === 'replace'
		? replacePortableTreeEntries({...target, exclude: excludedTransferAuthFile}, parsed.data.entries, options.dryRun ?? false)
		: materializePortableTreeEntries(target.baseDir, parsed.data.entries, options.dryRun ?? false);
}
