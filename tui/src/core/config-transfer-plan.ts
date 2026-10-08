import {createHash} from 'node:crypto';
import {cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {
	codexProvidersContainCredentials,
	type CodexProvidersSection,
	importCodexProvidersSection,
	snapshotCodexProvidersSection
} from './codex.js';
import {
	importExtensionsSection,
	parseExtensionsSection,
	snapshotExtensionsSection,
	type ExtensionsSection
} from './config-transfer-extensions.js';
import {importExtensionsWithPackages, type ExtensionsImportResult, type PiPackageImportOutcome} from './config-transfer-pi-packages.js';
import type {ExtensionCommandDeps} from './extensions.js';
import {piPackageSource} from './pi-package-source.js';
import {importCcqSettingsSection, snapshotCcqSettingsSection} from './config-transfer-ccq-settings.js';
import {
	importClaudeMcpSection,
	importCodexMcpSection,
	importMcpLibrarySection,
	importPiMcpSection,
	type McpClaudeSection,
	type McpCodexSection,
	type McpLibrarySection,
	type McpPiSection,
	snapshotClaudeMcpSection,
	snapshotCodexMcpSection,
	snapshotMcpLibrarySection,
	snapshotPiMcpSection
} from './config-transfer-mcp.js';
import {
	importRulesSection,
	importSettingsSection,
	type RulesSection,
	type SettingsSection,
	snapshotRulesSection,
	snapshotSettingsSection
} from './config-transfer-sections.js';
import {planSkillsImport, type SkillsImportPlan, type SkillsSnapshotOptions, snapshotSkillsSection} from './config-transfer-skills.js';
import {
	type BundlePayload,
	type BundleSection,
	type SectionMergeReport,
	type TransferImportMode,
	TRANSFER_EXECUTION_ORDER,
	type TransferCategoryIdentity,
	transferCategoryDefinition,
	transferFail,
	transferOk,
	type TransferResult,
	type TransferTool
} from './config-transfer.js';
import {
	claudeDir,
	ccqSystemSettingsPath,
	claudeJsonPath,
	codexAgentsPath,
	codexConfigPath,
	codexProfilePath,
	piAgentsPath,
	piAuthJsonPath,
	piExtensionsDir,
	piGlobalSkillsDir,
	piMcpAdapterOverridesPath,
	piMcpConfigPath,
	piModelsJsonPath,
	piSettingsPath,
	providersDir,
	resolveHome,
	rulesDir,
	settingsPath,
	vaultPath
} from './paths.js';
import {importPiProvidersSection, type PiProvidersSection, snapshotPiProvidersSection} from './pi-provider.js';
import {
	type ClaudeProvidersSection,
	importClaudeProvidersSection,
	PROVIDER_CREDENTIAL_ENV_KEYS,
	snapshotClaudeProvidersSection
} from './provider.js';
import {type ImportSkillsOptions, importSkillsSection} from '../services/config-transfer-skills-service.js';

// 配置导入导出编排（Phase 3）：导出快照计划、零写盘导入预览与分类级事务执行。
//
// 本模块不拥有任何领域语义：每个分类都转发给 Phase 2 的 owner seam
// （Provider/Config/MCP/Skills/Extensions），只负责选择展开、dry-run 事实收集、
// 分类 target 快照/恢复与 postflight 复核。
//
// 计划与结果对象只携带 identity、计数与脱敏消息；凭据值、绝对 HOME 路径与原始 JSON/TOML
// 永不进入返回值。apply 需要原始 section 数据，因此由调用方在 apply 时再次传入 payload，
// 计划本身不持有 data（保证 `JSON.stringify(plan)` 无敏感值）。

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── 导出快照计划 ─────────────────────────────────────────────────────────────

export type ConfigTransferSelection = {
	readonly categories: readonly TransferCategoryIdentity[];
	readonly includeCredentials: boolean;
};

export type ConfigTransferExportCategorySummary = {
	readonly tool: TransferTool;
	readonly category: string;
	readonly itemCount: number;
	readonly containsCredentials: boolean;
	/** 被剥离凭据条目的 identity（`id (key, ...)`），只含键名不含值。 */
	readonly excludedCredentials: readonly string[];
	/** 被过滤的本机绑定条目 identity，只含键名不含路径值。 */
	readonly excluded: readonly string[];
	readonly warnings: readonly string[];
};

export type ConfigTransferExportPlan = {
	readonly sections: readonly BundleSection[];
	readonly containsCredentials: boolean;
	readonly summaries: readonly ConfigTransferExportCategorySummary[];
	readonly warnings: readonly string[];
};

export type ConfigTransferExportOptions = {
	/** Skills 快照的 home/staging 注入；targets 由选择推导，不允许覆盖。 */
	readonly skills?: Omit<SkillsSnapshotOptions, 'targets'>;
};

const SKILL_TRANSFER_ORDER = ['cc', 'cx', 'pi'] as const;

function identityKey(tool: string, category: string): string {
	return `${tool}:${category}`;
}

function describeCredentialExclusion(exclusion: {readonly id: string; readonly keys: readonly string[]}): string {
	return `${exclusion.id} (${exclusion.keys.join(', ')})`;
}

/** 校验并去重用户选择；未知 tool/category 一律拒绝。 */
function normalizeSelection(categories: readonly TransferCategoryIdentity[]): TransferResult<readonly TransferCategoryIdentity[]> {
	if (categories.length === 0) {
		return transferFail('validation', '未选择任何导出分类');
	}

	const seen = new Set<string>();
	const result: TransferCategoryIdentity[] = [];
	for (const identity of categories) {
		if (!transferCategoryDefinition(identity.tool, identity.category)) {
			return transferFail('validation', '包含未支持的导出分类');
		}

		const key = identityKey(identity.tool, identity.category);
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		result.push({tool: identity.tool, category: identity.category});
	}

	// 稳定输出顺序：与导入执行顺序一致，便于 diff 与测试。
	return transferOk(TRANSFER_EXECUTION_ORDER.filter(identity => seen.has(identityKey(identity.tool, identity.category))));
}

/** Claude profile env 与 provider-owned settings 投影中是否存在非空凭据键。 */
function claudeCredentialsPresent(section: ClaudeProvidersSection): boolean {
	const contains = (env: Readonly<Record<string, string>> | undefined): boolean =>
		PROVIDER_CREDENTIAL_ENV_KEYS.some(key => typeof env?.[key] === 'string' && env[key] !== '');
	return section.profiles.some(entry => contains(entry.profile.env)) || contains(section.settingsEnv);
}

/** Pi API-key auth 条目与非空 headers 都属于文件型凭据。 */
function piCredentialsPresent(section: PiProvidersSection): boolean {
	if (
		Object.values(section.auth).some(
			entry =>
				(typeof entry.key === 'string' && entry.key.length > 0) ||
				(isRecord(entry.env) && Object.values(entry.env).some(value => typeof value === 'string' && value.length > 0))
		)
	) {
		return true;
	}

	const hasCredential = (value: unknown): boolean =>
		isRecord(value) &&
		((typeof value.apiKey === 'string' && value.apiKey.length > 0) ||
			(isRecord(value.headers) && Object.keys(value.headers).length > 0));
	return Object.values(section.models).some(
		definition =>
			hasCredential(definition) ||
			(Array.isArray(definition.models) && definition.models.some(hasCredential)) ||
			(isRecord(definition.modelOverrides) && Object.values(definition.modelOverrides).some(hasCredential))
	);
}

type CategorySnapshot = {
	readonly section: BundleSection;
	readonly summary: ConfigTransferExportCategorySummary;
};

function snapshotResult(
	tool: TransferTool,
	category: string,
	data: unknown,
	summary: Omit<ConfigTransferExportCategorySummary, 'tool' | 'category' | 'warnings'>,
	warnings: readonly string[]
): TransferResult<CategorySnapshot> {
	return transferOk({section: {tool, category, data}, summary: {tool, category, ...summary, warnings}}, warnings);
}

/** 单分类快照：只调用 Phase 2 owner seam，不复制任何领域解析/合并逻辑。 */
async function snapshotCategory(
	tool: TransferTool,
	category: string,
	includeCredentials: boolean
): Promise<TransferResult<CategorySnapshot>> {
	if (tool === 'ccq' && category === 'mcp-library') {
		const result = snapshotMcpLibrarySection({includeCredentials});
		if (!result.ok) {
			return result;
		}

		const data: McpLibrarySection = result.data;
		return snapshotResult(
			tool,
			category,
			data,
			{
				itemCount: data.servers.length,
				containsCredentials: data.containsCredentials,
				excludedCredentials: data.excludedCredentials.map(describeCredentialExclusion),
				excluded: []
			},
			result.warnings
		);
	}

	if (tool === 'ccq' && category === 'system-settings') {
		const result = snapshotCcqSettingsSection();
		if (!result.ok) return result;
		return snapshotResult(
			tool,
			category,
			result.data,
			{itemCount: 1, containsCredentials: false, excludedCredentials: [], excluded: []},
			result.warnings
		);
	}

	if (category === 'providers') {
		if (tool === 'cc') {
			const result = snapshotClaudeProvidersSection({includeCredentials});
			if (!result.ok) {
				return result;
			}

			const data: ClaudeProvidersSection = result.data;
			return snapshotResult(
				tool,
				category,
				data,
				{
					itemCount: data.profiles.length + (Object.keys(data.settingsEnv).length > 0 ? 1 : 0),
					containsCredentials: includeCredentials && claudeCredentialsPresent(data),
					// snapshot 在未选凭据时已剥离值，这里不再持有原始 env，只报告 generic 事实。
					excludedCredentials: [],
					excluded: []
				},
				result.warnings
			);
		}

		if (tool === 'cx') {
			const result = snapshotCodexProvidersSection({includeCredentials});
			if (!result.ok) {
				return result;
			}

			const data: CodexProvidersSection = result.data;
			return snapshotResult(
				tool,
				category,
				data,
				{
					itemCount: data.profiles.length + (Object.keys(data.configProjection).length > 0 ? 1 : 0),
					containsCredentials: includeCredentials && codexProvidersContainCredentials(data),
					excludedCredentials: [],
					excluded: []
				},
				result.warnings
			);
		}

		const result = snapshotPiProvidersSection({includeCredentials});
		if (!result.ok) {
			return result;
		}

		const data: PiProvidersSection = result.data;
		return snapshotResult(
			tool,
			category,
			data,
			{
				itemCount: Object.keys(data.models).length + Object.keys(data.auth).length,
				containsCredentials: includeCredentials && piCredentialsPresent(data),
				excludedCredentials: [],
				excluded: includeCredentials ? [] : ['oauth']
			},
			result.warnings
		);
	}

	if (category === 'settings') {
		const result = snapshotSettingsSection(tool as 'cc' | 'cx' | 'pi', {includeCredentials});
		if (!result.ok) {
			return result;
		}

		const data: SettingsSection = result.data;
		return snapshotResult(
			tool,
			category,
			data,
			{
				itemCount: data.text.trim() === '' ? 0 : 1,
				containsCredentials: data.containsCredentials,
				excludedCredentials: includeCredentials ? [] : data.credentialKeys,
				excluded: []
			},
			result.warnings
		);
	}

	if (category === 'rules') {
		const result = snapshotRulesSection(tool as 'cc' | 'cx' | 'pi');
		if (!result.ok) {
			return result;
		}

		const data: RulesSection = result.data;
		return snapshotResult(
			tool,
			category,
			data,
			{itemCount: data.entries.length, containsCredentials: false, excludedCredentials: [], excluded: []},
			result.warnings
		);
	}

	if (category === 'mcp') {
		if (tool === 'cc') {
			const result = snapshotClaudeMcpSection({includeCredentials});
			if (!result.ok) {
				return result;
			}

			const data: McpClaudeSection = result.data;
			return snapshotResult(
				tool,
				category,
				data,
				{
					itemCount: data.servers.length,
					containsCredentials: data.containsCredentials,
					excludedCredentials: data.excludedCredentials.map(describeCredentialExclusion),
					excluded: []
				},
				result.warnings
			);
		}

		if (tool === 'cx') {
			const result = snapshotCodexMcpSection({includeCredentials});
			if (!result.ok) {
				return result;
			}

			const data: McpCodexSection = result.data;
			return snapshotResult(
				tool,
				category,
				data,
				{
					itemCount: data.servers.length,
					containsCredentials: data.containsCredentials,
					excludedCredentials: data.excludedCredentials.map(describeCredentialExclusion),
					excluded: data.excluded
				},
				result.warnings
			);
		}

		const result = snapshotPiMcpSection({includeCredentials});
		if (!result.ok) {
			return result;
		}

		const data: McpPiSection = result.data;
		return snapshotResult(
			tool,
			category,
			data,
			{
				itemCount: data.servers.length + data.overrides.length,
				containsCredentials: data.containsCredentials,
				excludedCredentials: data.excludedCredentials.map(describeCredentialExclusion),
				excluded: data.excludedAuth
			},
			result.warnings
		);
	}

	if (category === 'extensions') {
		const result = snapshotExtensionsSection();
		if (!result.ok) {
			return result;
		}

		const data: ExtensionsSection = result.data;
		return snapshotResult(
			tool,
			category,
			data,
			{
				itemCount: data.entries.length + (data.explicitEntries?.length ?? 0) + (data.packages?.length ?? 0),
				containsCredentials: false,
				excludedCredentials: [],
				excluded: []
			},
			[...result.warnings, '明文扩展源码可能包含硬编码密钥；文件内容可从备份包直接还原']
		);
	}

	return transferFail('validation', '不支持导出该配置分类');
}

/**
 * 把 UI 选择展开为有序 snapshot sections。含凭据的事实由各 owner seam 决定；
 * 未选择凭据时 owner 已剥离值，这里只汇总 union fact 与 identity 摘要。
 */
export async function planConfigTransferExport(
	selection: ConfigTransferSelection,
	options: ConfigTransferExportOptions = {}
): Promise<TransferResult<ConfigTransferExportPlan>> {
	const normalized = normalizeSelection(selection.categories);
	if (!normalized.ok) {
		return normalized;
	}

	const identities = normalized.data;
	const sections: BundleSection[] = [];
	const summaries: ConfigTransferExportCategorySummary[] = [];
	const warnings: string[] = [];
	let containsCredentials = false;

	const skillTargets = SKILL_TRANSFER_ORDER.filter(tool =>
		identities.some(identity => identity.category === 'skills' && identity.tool === tool)
	);
	if (skillTargets.length > 0) {
		// 设计 5.5：UI 按工具显示 Skills，但导出只产生一个去重 snapshot，并在 section 中记录全部目标拓扑。
		// ponytail: 合并 section 挂在首个目标工具 key 下；需要按工具分别取舍时再拆分 section schema。
		const snapshot = await snapshotSkillsSection({...options.skills, targets: skillTargets});
		if (!snapshot.ok) {
			return snapshot;
		}

		const primarySkillTool = skillTargets[0];
		if (!primarySkillTool) {
			return transferFail('validation', '未选择任何 Skills 导出目标');
		}

		const section: BundleSection = {tool: primarySkillTool, category: 'skills', data: {skills: snapshot.data.skills}};
		sections.push(section);
		summaries.push({
			tool: section.tool,
			category: 'skills',
			itemCount: snapshot.data.skills.length,
			containsCredentials: false,
			excludedCredentials: [],
			excluded: [],
			warnings: snapshot.warnings
		});
		warnings.push(...snapshot.warnings);
	}

	for (const identity of identities) {
		if (identity.category === 'skills') {
			continue;
		}

		const result = await snapshotCategory(identity.tool, identity.category, selection.includeCredentials);
		if (!result.ok) {
			return result;
		}

		sections.push(result.data.section);
		summaries.push(result.data.summary);
		containsCredentials ||= result.data.summary.containsCredentials;
		warnings.push(...result.data.summary.warnings);
	}

	return transferOk({sections, containsCredentials, summaries, warnings});
}

// ── 导入预览（零写盘） ───────────────────────────────────────────────────────

export type TransferCategoryStatus = 'add' | 'replace' | 'unchanged' | 'blocked';
export type TransferCategoryAction = TransferImportMode | 'skip';

export type ConfigTransferCategoryCounts = {
	readonly removed?: number;
	readonly added: number;
	readonly replaced: number;
	readonly unchanged: number;
	readonly blocked: number;
};

export type ConfigTransferCategoryIdentities = {
	readonly removed?: readonly string[];
	readonly added: readonly string[];
	readonly replaced: readonly string[];
	readonly unchanged: readonly string[];
	readonly skipped: readonly string[];
};

export type ConfigTransferStrategyPreview = {
	readonly status: TransferCategoryStatus;
	readonly counts: ConfigTransferCategoryCounts;
	readonly identities: ConfigTransferCategoryIdentities;
	readonly warnings: readonly string[];
	readonly reason: string | null;
	/** 内容与目标事实绑定；不持有路径或明文配置。 */
	readonly targetFact?: string;
};

export type ConfigTransferImportPlanItem = {
	readonly replace?: ConfigTransferStrategyPreview;
	readonly tool: TransferTool;
	readonly category: string;
	readonly status: TransferCategoryStatus;
	readonly defaultAction: TransferCategoryAction;
	readonly counts: ConfigTransferCategoryCounts;
	readonly identities: ConfigTransferCategoryIdentities;
	readonly warnings: readonly string[];
	readonly reason: string | null;
};

export type ConfigTransferImportPlan = {
	readonly containsCredentials: boolean;
	readonly items: readonly ConfigTransferImportPlanItem[];
	readonly warnings: readonly string[];
};

export type ConfigTransferImportOptions = {
	readonly skills?: ImportSkillsOptions;
	readonly piPackages?: ExtensionCommandDeps;
};

type CategoryPreview = {
	readonly counts: ConfigTransferCategoryCounts;
	readonly report: SectionMergeReport;
	readonly reason: string | null;
};

function countsFromReport(report: SectionMergeReport, blocked: number): ConfigTransferCategoryCounts {
	return {
		...(report.removed ? {removed: report.removed.length} : {}),
		added: report.added.length,
		replaced: report.replaced.length,
		unchanged: report.unchanged.length,
		blocked
	};
}

function statusOf(counts: ConfigTransferCategoryCounts): TransferCategoryStatus {
	if (counts.blocked > 0) {
		return 'blocked';
	}

	if (counts.replaced > 0 || (counts.removed ?? 0) > 0) {
		return 'replace';
	}

	return counts.added > 0 ? 'add' : 'unchanged';
}

async function previewCategory(
	tool: TransferTool,
	category: string,
	data: unknown,
	containsCredentials: boolean,
	options: ConfigTransferImportOptions,
	mode: TransferImportMode = 'merge'
): Promise<TransferResult<CategoryPreview>> {
	if (category === 'skills' && mode === 'merge') {
		// Skills 预览用 planSkillsImport 保留逐 Skill 的 blocked identity/计数。
		const plan = await planSkillsImport(data, options.skills);
		if (!plan.ok) {
			return plan;
		}

		return transferOk(skillsPreview(plan.data));
	}

	const result = await runCategoryImport(tool, category, data, containsCredentials, options, true, mode);
	if (!result.ok) {
		return result;
	}

	return transferOk({counts: countsFromReport(result.data, 0), report: result.data, reason: null});
}

function skillsPreview(plan: SkillsImportPlan): CategoryPreview {
	const added: string[] = [];
	const replaced: string[] = [];
	const unchanged: string[] = [];
	const skipped: string[] = [];
	let reason: string | null = null;
	for (const item of plan.items) {
		if (item.state === 'add') {
			added.push(item.id);
		} else if (item.state === 'replace') {
			replaced.push(item.id);
		} else if (item.state === 'unchanged') {
			unchanged.push(item.id);
		} else {
			skipped.push(item.id);
			reason ??= item.reason ?? '本机同名 Skill 损坏或无法验证';
		}
	}

	const report: SectionMergeReport = {added, replaced, unchanged, skipped, warnings: []};
	return {counts: countsFromReport(report, skipped.length), report, reason};
}

function replacementUnavailable(tool: TransferTool, category: string): string | null {
	if (category === 'rules' || (tool === 'ccq' && category === 'system-settings')) return null;
	if (category === 'skills') return 'Skills 覆盖尚不能证明完整目标范围与共享实体安全；合并仍可用';
	return '该分类尚无可验证的受管删除投影，覆盖未启用；合并仍可用';
}

function categoryTargetFact(tool: TransferTool, category: string, data: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify([data, categoryTargetPaths(tool, category, data).map(digestPath)]))
		.digest('hex');
}

async function previewReplacement(
	tool: TransferTool,
	category: string,
	data: unknown,
	containsCredentials: boolean,
	options: ConfigTransferImportOptions
): Promise<ConfigTransferStrategyPreview> {
	const blocked = (reason: string): ConfigTransferStrategyPreview => ({
		status: 'blocked',
		counts: {added: 0, replaced: 0, removed: 0, unchanged: 0, blocked: 1},
		identities: {added: [], replaced: [], removed: [], unchanged: [], skipped: []},
		warnings: [],
		reason
	});
	const unavailable = replacementUnavailable(tool, category);
	if (unavailable) return blocked(unavailable);
	const targetFact = categoryTargetFact(tool, category, data);
	const preview = await previewCategory(tool, category, data, containsCredentials, options, 'replace');
	if (!preview.ok) return blocked(preview.error);
	if (targetFact !== categoryTargetFact(tool, category, data)) return blocked('目标在预览期间发生变化，请重新预览');
	return {
		status: statusOf(preview.data.counts),
		counts: {...preview.data.counts, removed: preview.data.counts.removed ?? 0},
		identities: {...preview.data.report, removed: preview.data.report.removed ?? []},
		warnings: preview.data.report.warnings,
		reason: preview.data.reason,
		targetFact
	};
}

/** 只读取本机事实的不可变预览：零写盘，只返回 identity/计数与脱敏原因。 */
export async function planConfigTransferImport(
	payload: BundlePayload,
	options: ConfigTransferImportOptions = {}
): Promise<TransferResult<ConfigTransferImportPlan>> {
	const byIdentity = new Map(payload.sections.map(section => [identityKey(section.tool, section.category), section]));
	const items: ConfigTransferImportPlanItem[] = [];
	const warnings: string[] = payload.sections.length === 0 ? ['导出包不含任何配置分类'] : [];

	for (const identity of TRANSFER_EXECUTION_ORDER) {
		const section = byIdentity.get(identityKey(identity.tool, identity.category));
		if (!section) {
			continue;
		}

		const preview = await previewCategory(identity.tool, identity.category, section.data, payload.containsCredentials, options);
		const replace = await previewReplacement(identity.tool, identity.category, section.data, payload.containsCredentials, options);
		if (!preview.ok) {
			items.push({
				replace,
				tool: identity.tool,
				category: identity.category,
				status: 'blocked',
				defaultAction: 'skip',
				counts: {added: 0, replaced: 0, unchanged: 0, blocked: 1},
				identities: {added: [], replaced: [], unchanged: [], skipped: []},
				warnings: [],
				reason: preview.error
			});
			continue;
		}

		const status = statusOf(preview.data.counts);
		items.push({
			replace,
			tool: identity.tool,
			category: identity.category,
			status,
			defaultAction: status === 'blocked' ? 'skip' : 'merge',
			counts: preview.data.counts,
			identities: {
				added: preview.data.report.added,
				replaced: preview.data.report.replaced,
				unchanged: preview.data.report.unchanged,
				skipped: preview.data.report.skipped
			},
			warnings: preview.data.report.warnings,
			reason: preview.data.reason
		});
		warnings.push(...preview.data.report.warnings);
	}

	return transferOk({containsCredentials: payload.containsCredentials, items, warnings});
}

// ── 分类导入执行（Phase 2 owner seam 转发） ──────────────────────────────────

async function runCategoryImport(
	tool: TransferTool,
	category: string,
	data: unknown,
	containsCredentials: boolean,
	options: ConfigTransferImportOptions,
	dryRun: boolean,
	mode: TransferImportMode = 'merge'
): Promise<ExtensionsImportResult> {
	const unavailable = mode === 'replace' ? replacementUnavailable(tool, category) : null;
	if (unavailable) return transferFail('conflict', unavailable);
	switch (identityKey(tool, category)) {
		case 'ccq:mcp-library':
			return importMcpLibrarySection(data, {containsCredentials, dryRun});
		case 'ccq:system-settings':
			return importCcqSettingsSection(data, {dryRun});
		case 'cc:providers':
			return importClaudeProvidersSection(data, {containsCredentials, dryRun});
		case 'cx:providers':
			return importCodexProvidersSection(data, {containsCredentials, dryRun});
		case 'pi:providers':
			return importPiProvidersSection(data, {containsCredentials, dryRun});
		case 'cc:settings':
			return importSettingsSection('cc', data, {dryRun, containsCredentials});
		case 'cx:settings':
			return importSettingsSection('cx', data, {dryRun});
		case 'pi:settings':
			return importSettingsSection('pi', data, {dryRun, containsCredentials});
		case 'cc:rules':
			return importRulesSection('cc', data, {dryRun, mode});
		case 'cx:rules':
			return importRulesSection('cx', data, {dryRun, mode});
		case 'pi:rules':
			return importRulesSection('pi', data, {dryRun, mode});
		case 'cc:mcp':
			return importClaudeMcpSection(data, {containsCredentials, dryRun});
		case 'cx:mcp':
			return importCodexMcpSection(data, {containsCredentials, dryRun});
		case 'pi:mcp':
			return importPiMcpSection(data, {containsCredentials, dryRun});
		case 'pi:extensions':
			return dryRun
				? importExtensionsSection(data, {dryRun, packageInstalled: options.piPackages?.packageInstalled})
				: importExtensionsWithPackages(data, options.piPackages);
		case 'cc:skills':
		case 'cx:skills':
		case 'pi:skills':
			return importSkillsSection(data, {...options.skills, dryRun});
		default:
			return transferFail('validation', '不支持导入该配置分类');
	}
}

// ── 分类事务：目标快照、恢复与 postflight ────────────────────────────────────

/**
 * 分类可能写入的本机目标。刻意比 owner 的实际写入范围略宽：
 * 目录级 target（providers/skills/extensions）保证同一分类内的新增文件也能回滚。
 */
function categoryTargetPaths(tool: TransferTool, category: string, data: unknown): readonly string[] {
	if (tool === 'ccq' && category === 'mcp-library') {
		return [vaultPath()];
	}
	if (tool === 'ccq' && category === 'system-settings') {
		return [ccqSystemSettingsPath()];
	}

	if (category === 'providers') {
		if (tool === 'cc') {
			return [providersDir(), settingsPath()];
		}

		if (tool === 'cx') {
			const keys = isRecord(data) && Array.isArray(data.profiles) ? data.profiles : [];
			const profilePaths = keys.flatMap(entry =>
				isRecord(entry) && typeof entry.key === 'string' ? [codexProfilePath(entry.key)] : []
			);
			return [...profilePaths, codexConfigPath()];
		}

		return [piModelsJsonPath(), piAuthJsonPath()];
	}

	if (category === 'settings') {
		return [tool === 'cc' ? settingsPath() : tool === 'cx' ? codexConfigPath() : piSettingsPath()];
	}

	if (category === 'rules') {
		if (tool === 'cc') {
			return [join(claudeDir(), 'CLAUDE.md'), rulesDir()];
		}

		return [tool === 'cx' ? codexAgentsPath() : piAgentsPath()];
	}

	if (category === 'mcp') {
		if (tool === 'cc') {
			return [claudeJsonPath(), settingsPath()];
		}

		return tool === 'cx' ? [codexConfigPath()] : [piMcpConfigPath(), piMcpAdapterOverridesPath()];
	}

	if (category === 'skills') {
		// ponytail: 整个 skills 根目录进事务快照；技能树过大时改为按 Skill 名定向快照。
		return [join(claudeDir(), 'skills'), join(resolveHome(), '.agents', 'skills'), piGlobalSkillsDir()];
	}

	if (category === 'extensions') {
		return [piExtensionsDir(), piSettingsPath()];
	}

	return [];
}

/** 递归事实摘要：文件内容哈希、符号链接 target、目录子树；缺失返回 `missing`。 */
function digestPath(path: string): string {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return 'missing';
	}

	try {
		if (stat.isSymbolicLink()) {
			return `l:${readlinkSync(path)}`;
		}

		if (stat.isFile()) {
			return `f:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
		}

		if (stat.isDirectory()) {
			const hash = createHash('sha256');
			for (const name of readdirSync(path).sort()) {
				hash.update(`${name}\u0000${digestPath(join(path, name))}\u0001`);
			}

			return `d:${hash.digest('hex')}`;
		}

		return `o:${stat.mode}`;
	} catch {
		return 'unreadable';
	}
}

type CategoryTransactionSnapshotEntry = {
	readonly targetPath: string;
	readonly slot: string;
	readonly existed: boolean;
	readonly fact: string;
};

type CategoryTransactionSnapshot = {
	readonly rootDir: string;
	readonly entries: readonly CategoryTransactionSnapshotEntry[];
};

function cleanupTransactionDir(rootDir: string, warnings?: string[]): void {
	try {
		rmSync(rootDir, {recursive: true, force: true});
	} catch {
		// cleanup 失败只降级为 warning，不影响主结果。
		warnings?.push('导入事务临时目录清理失败');
	}
}

/** 变更前把分类的全部 target 复制到事务临时目录，并记录 missing 事实与原始摘要。 */
function createCategorySnapshot(targets: readonly string[], tempRoot?: string): TransferResult<CategoryTransactionSnapshot> {
	let rootDir: string;
	try {
		const parent = tempRoot ?? tmpdir();
		mkdirSync(parent, {recursive: true});
		rootDir = mkdtempSync(join(parent, 'ccq-transfer-tx-'));
	} catch {
		return transferFail('io', '导入事务临时目录创建失败');
	}

	const entries: CategoryTransactionSnapshotEntry[] = [];
	for (const [index, targetPath] of targets.entries()) {
		const existed = existsSync(targetPath);
		const fact = digestPath(targetPath);
		const slot = `entry-${index}`;
		if (existed) {
			try {
				cpSync(targetPath, join(rootDir, slot), {recursive: true, verbatimSymlinks: true});
			} catch {
				cleanupTransactionDir(rootDir);
				return transferFail('io', '导入事务快照失败');
			}
		}

		entries.push({targetPath, slot, existed, fact});
	}

	return transferOk({rootDir, entries});
}

/** 恢复分类全部 target，并用摘要复核恢复结果。 */
function restoreCategorySnapshot(snapshot: CategoryTransactionSnapshot): {readonly ok: boolean; readonly warnings: readonly string[]} {
	const warnings: string[] = [];
	for (const entry of snapshot.entries) {
		try {
			rmSync(entry.targetPath, {recursive: true, force: true});
			if (entry.existed) {
				mkdirSync(dirname(entry.targetPath), {recursive: true});
				cpSync(join(snapshot.rootDir, entry.slot), entry.targetPath, {recursive: true, verbatimSymlinks: true});
			}
		} catch {
			warnings.push('导入回滚写入失败');
		}
	}

	const restored = snapshot.entries.every(entry => digestPath(entry.targetPath) === entry.fact);
	if (!restored) {
		warnings.push('导入回滚校验失败');
	}

	return {ok: restored, warnings};
}

// ── 导入执行（分类事务 + postflight） ────────────────────────────────────────

export type ConfigTransferCategoryDecision = {
	readonly tool: TransferTool;
	readonly category: string;
	readonly action: TransferCategoryAction;
};

export type ConfigTransferApplyOptions = {
	readonly skills?: ImportSkillsOptions;
	readonly piPackages?: ExtensionCommandDeps;
	/** 事务快照根目录；默认系统 temp。 */
	readonly tempDir?: string;
	/** 取消通道：每个分类 mutation 前重新检查，abort 后不再开始后续分类。 */
	readonly signal?: AbortSignal;
};

export type ConfigTransferApplyFailure = {
	readonly tool: TransferTool;
	readonly category: string;
	readonly error: string;
	readonly restored: boolean;
};

export type ConfigTransferApplyOutcome = {
	readonly status: 'complete' | 'partial' | 'failed';
	readonly completed: readonly TransferCategoryIdentity[];
	readonly skipped: readonly TransferCategoryIdentity[];
	readonly notExecuted: readonly TransferCategoryIdentity[];
	readonly failed: readonly ConfigTransferApplyFailure[];
	readonly warnings: readonly string[];
	readonly packages?: PiPackageImportOutcome;
	readonly cancelled?: boolean;
};

/**
 * 执行导入：按 `TRANSFER_EXECUTION_ORDER` 逐分类事务。
 * 分类失败即恢复该分类全部 target、验证恢复结果并停止后续分类；绝不继续越过错。
 */
export async function applyConfigTransferImport(
	payload: BundlePayload,
	plan: ConfigTransferImportPlan,
	decisions: readonly ConfigTransferCategoryDecision[] = [],
	options: ConfigTransferApplyOptions = {}
): Promise<TransferResult<ConfigTransferApplyOutcome>> {
	const sections = new Map(payload.sections.map(section => [identityKey(section.tool, section.category), section]));
	for (const item of plan.items) {
		if (!sections.has(identityKey(item.tool, item.category))) {
			return transferFail('validation', '导入计划与导出包内容不一致');
		}
	}

	const plans = new Map(plan.items.map(item => [identityKey(item.tool, item.category), item]));
	const decisionsByKey = new Map(decisions.map(decision => [identityKey(decision.tool, decision.category), decision.action]));
	if (
		decisionsByKey.size !== decisions.length ||
		decisions.some(
			decision => !plans.has(identityKey(decision.tool, decision.category)) || !['merge', 'replace', 'skip'].includes(decision.action)
		)
	) {
		return transferFail('validation', '导入分类策略无效');
	}
	// 覆盖必须在任何分类写入前验证确认时的事实，不能删除后来新增的未确认项。
	for (const item of plan.items) {
		if ((decisionsByKey.get(identityKey(item.tool, item.category)) ?? item.defaultAction) !== 'replace') continue;
		const section = sections.get(identityKey(item.tool, item.category))!;
		const fresh = await previewReplacement(item.tool, item.category, section.data, payload.containsCredentials, options);
		if (!item.replace?.targetFact || fresh.status === 'blocked' || fresh.targetFact !== item.replace.targetFact) {
			return transferFail('conflict', fresh.reason ?? '覆盖目标或包内容已变化，请重新预览并确认');
		}
	}
	const completed: TransferCategoryIdentity[] = [];
	const skipped: TransferCategoryIdentity[] = [];
	const notExecuted: TransferCategoryIdentity[] = [];
	const failures: ConfigTransferApplyFailure[] = [];
	const warnings: string[] = [];
	let stopped = false;
	let packages: PiPackageImportOutcome | undefined;
	const importOptions = {...options, piPackages: {...options.piPackages, signal: options.signal}};

	for (const identity of TRANSFER_EXECUTION_ORDER) {
		const key = identityKey(identity.tool, identity.category);
		const item = plans.get(key);
		if (!item) {
			continue;
		}

		// 取消落在分类边界：已完成的分类保留，未开始的分类记入 notExecuted，不再写入任何字节。
		if (options.signal?.aborted) {
			stopped = true;
		}

		if (stopped) {
			notExecuted.push(identity);
			if (identity.tool === 'pi' && identity.category === 'extensions') {
				const remaining = parseExtensionsSection(sections.get(key)?.data);
				if (remaining.ok && remaining.data.packages?.length)
					packages = {
						completed: [],
						unchanged: [],
						failed: [],
						notExecuted: remaining.data.packages.map(piPackageSource),
						externalSideEffects: false
					};
			}
			continue;
		}

		const section = sections.get(key);
		if (!section) {
			return transferFail('validation', '导入计划与导出包内容不一致');
		}

		const action = decisionsByKey.get(key) ?? item.defaultAction;
		if (item.status === 'blocked' || action === 'skip') {
			if (item.status === 'blocked' && action === 'merge') {
				warnings.push(`${key} 本机目标损坏或无法验证，已按跳过处理`);
			}

			skipped.push(identity);
			continue;
		}

		if (action === 'replace' && categoryTargetFact(identity.tool, identity.category, section.data) !== item.replace?.targetFact) {
			failures.push({...identity, error: '覆盖目标已变化，请重新预览并确认', restored: true});
			stopped = true;
			continue;
		}
		// Rules/Extensions write portable trees. Revalidate their realpath/symlink boundary
		// immediately before taking a rollback snapshot: a plan may be stale, and snapshotting
		// an escaped root could otherwise capture files outside the managed tree.
		if (identity.category === 'rules' || identity.category === 'extensions') {
			const preflight = await runCategoryImport(
				identity.tool,
				identity.category,
				section.data,
				payload.containsCredentials,
				options,
				true,
				action
			);
			if (!preflight.ok) {
				failures.push({tool: identity.tool, category: identity.category, error: preflight.error, restored: true});
				stopped = true;
				continue;
			}
		}

		const snapshot = createCategorySnapshot(categoryTargetPaths(identity.tool, identity.category, section.data), options.tempDir);
		if (!snapshot.ok) {
			failures.push({tool: identity.tool, category: identity.category, error: snapshot.error, restored: true});
			stopped = true;
			continue;
		}
		// Close the plan/snapshot race as far as path-based filesystem APIs allow. If the
		// boundary changed while the snapshot was being taken, no mutation has started, so
		// discard the snapshot rather than attempting a rollback through the escaped root.
		if (identity.category === 'rules' || identity.category === 'extensions') {
			const postSnapshotPreflight = await runCategoryImport(
				identity.tool,
				identity.category,
				section.data,
				payload.containsCredentials,
				options,
				true,
				action
			);
			if (!postSnapshotPreflight.ok) {
				cleanupTransactionDir(snapshot.data.rootDir, warnings);
				failures.push({tool: identity.tool, category: identity.category, error: postSnapshotPreflight.error, restored: true});
				stopped = true;
				continue;
			}
		}

		if (
			options.signal?.aborted ||
			(action === 'replace' && categoryTargetFact(identity.tool, identity.category, section.data) !== item.replace?.targetFact)
		) {
			cleanupTransactionDir(snapshot.data.rootDir, warnings);
			if (!options.signal?.aborted) failures.push({...identity, error: '覆盖目标已变化，请重新预览并确认', restored: true});
			notExecuted.push(identity);
			stopped = true;
			continue;
		}
		const applied = await runCategoryImport(
			identity.tool,
			identity.category,
			section.data,
			payload.containsCredentials,
			importOptions,
			false,
			action
		);
		if (applied.packages) {
			packages = applied.packages;
			if (packages.externalSideEffects) warnings.push('Pi package 外部安装/缓存/脚本副作用不属于文件回滚范围；不会删除已有包');
		}
		if (!applied.ok) {
			const restore = restoreCategorySnapshot(snapshot.data);
			cleanupTransactionDir(snapshot.data.rootDir, warnings);
			warnings.push(...restore.warnings);
			failures.push({tool: identity.tool, category: identity.category, error: applied.error, restored: restore.ok});
			stopped = true;
			continue;
		}

		// postflight 必须重新读取 owner fact：函数返回正常或子进程 exit 0 都不算成功。
		const postflight = await previewCategory(
			identity.tool,
			identity.category,
			section.data,
			payload.containsCredentials,
			options,
			action
		);
		if (
			!postflight.ok ||
			postflight.data.counts.blocked > 0 ||
			postflight.data.counts.added > 0 ||
			postflight.data.counts.replaced > 0 ||
			(postflight.data.counts.removed ?? 0) > 0
		) {
			const restore = restoreCategorySnapshot(snapshot.data);
			cleanupTransactionDir(snapshot.data.rootDir, warnings);
			warnings.push(...restore.warnings);
			failures.push({
				tool: identity.tool,
				category: identity.category,
				error: postflight.ok ? '导入结果校验失败：目标状态未确认' : postflight.error,
				restored: restore.ok
			});
			stopped = true;
			continue;
		}

		warnings.push(...applied.warnings, ...postflight.data.report.warnings);
		cleanupTransactionDir(snapshot.data.rootDir, warnings);
		completed.push(identity);
	}

	const cancelled = options.signal?.aborted ?? false;
	const status =
		failures.length === 0 && !cancelled ? 'complete' : completed.length > 0 || packages?.completed.length ? 'partial' : 'failed';
	return transferOk({
		status,
		completed,
		skipped,
		notExecuted,
		failed: failures,
		warnings,
		...(packages ? {packages} : {}),
		...(cancelled ? {cancelled} : {})
	});
}
