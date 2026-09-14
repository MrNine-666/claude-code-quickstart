import {lstat, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type {ProgressCallback} from '../core/exec.js';
import {
	createSkillsChildEnv,
	runSkillsAdd,
	runSkillsRemove,
	type SkillsCommandDiagnostic,
	type SkillsExecFn
} from '../core/skills-actions.js';
import {resolveHome} from '../core/paths.js';
import {
	buildSkillsOwnershipIndex,
	currentTopologyOfItem,
	itemAvailableOn,
	needsManagedMigration,
	otherAgentsOf,
	storageRootsOf,
	supportedSkillsRoots,
	verifySkillDeletionTarget,
	type InstalledSkillItem
} from '../core/skills-installed.js';
import {
	cleanupSkillSnapshot,
	createSkillSnapshot,
	inspectSkillStorage,
	isSafeSkillName,
	preferredSkillContentPath,
	removeSkillTarget,
	targetTopologyOfDraft,
	topologyOfInspection,
	type SkillSnapshot,
	type SkillStorageInspection,
	type SkillStorageOptions,
	type SkillAgentTargets,
	type SkillTopology
} from '../core/skills-storage.js';

export type SkillsAdoptionOutcome = 'complete' | 'partial' | 'restored' | 'failed';

export type SkillsAdoptionResult = {
	readonly success: boolean;
	readonly outcome: SkillsAdoptionOutcome;
	readonly mutated: boolean;
	readonly inspection: SkillStorageInspection;
	readonly error?: string;
	readonly recoveryPath?: string;
};

export {targetTopologyOfDraft, topologyOfInspection} from '../core/skills-storage.js';
export type {SkillAgentTargets, SkillTopology, SkillTopologyDraft} from '../core/skills-storage.js';

function expectedStorageKind(topology: SkillTopology): SkillStorageInspection['kind'] {
	return topology === 'claude-only' ? 'claude-only' : topology === 'codex-only' ? 'canonical-only' : 'shared-symlink';
}

/** 目标物化只看存储 kind（path/lstat 事实），不比较内容（design §9 / §11）。 */
function topologyMaterialized(inspection: SkillStorageInspection, target: SkillTopology): boolean {
	return inspection.kind === expectedStorageKind(target);
}

function topologyEnv(options: SkillStorageOptions, includeCodex: boolean): NodeJS.ProcessEnv {
	return createSkillsChildEnv(options.homeDir, includeCodex);
}

function commandError(action: SkillsCommandDiagnostic, fallback: string): string {
	// skills CLI 会把正常交互渲染写入 stderr；原始流只保留给结构化诊断。
	return action.error ?? fallback;
}

/** 目标拓扑对应的受管存储根（新安装与迁移目标绝不以 `.codex` 为落点，design §8.4）。 */
function targetManagedRoots(target: SkillTopology): readonly ('claude' | 'agents')[] {
	return target === 'claude-only' ? ['claude'] : target === 'codex-only' ? ['agents'] : ['agents', 'claude'];
}

async function addFromSnapshot(
	name: string,
	snapshot: SkillSnapshot,
	target: SkillTopology,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsCommandDiagnostic> {
	const agents = target === 'claude-only' ? (['cc'] as const) : target === 'codex-only' ? (['cx'] as const) : (['cx', 'cc'] as const);
	return runSkillsAdd(
		{
			source: snapshot.root,
			skillNames: [name],
			agents,
			copy: target !== 'shared',
			env: topologyEnv(options, target !== 'claude-only'),
			displayName: name
		},
		onProgress,
		exec
	);
}

async function removeTargets(
	name: string,
	agents: readonly ('cc' | 'cx')[],
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsCommandDiagnostic> {
	return runSkillsRemove(
		{
			skillNames: [name],
			agents,
			// 即使只撤销 Claude 投影，也必须让官方 skills 检测到 Codex 正在使用 canonical，
			// 否则 remove 会把“无人使用”的 ~/.agents/skills 本体一并删除。
			env: topologyEnv(options, true)
		},
		onProgress,
		exec
	);
}

async function failureResult(
	message: string,
	inspection: SkillStorageInspection,
	snapshot: SkillSnapshot | undefined,
	mutated: boolean
): Promise<SkillsAdoptionResult> {
	return {
		success: false,
		outcome: 'failed',
		mutated,
		inspection,
		error: message,
		...(snapshot ? {recoveryPath: snapshot.skillPath} : {})
	};
}

/**
 * 定位可用于快照的源内容路径。优先 official inspection 已验证的 `.agents`/`.claude` 实体；
 * `.codex` 或 Pi 全局 native 收编时 official inspection 看不到旧根，从 Item projection 直接
 * lstat 定位实体目录。只用于事务快照，不反馈到列表身份（design §8.4 / §9）。
 */
async function resolveSourceContentPath(
	item: InstalledSkillItem,
	preflight: SkillStorageInspection,
	options: SkillStorageOptions
): Promise<string | undefined> {
	const managed = preferredSkillContentPath(preflight);
	if (managed) return managed;

	for (const projection of item.projections) {
		if (projection.root !== 'codex' && projection.root !== 'pi-global') continue;
		try {
			const fact = await lstat(projection.path);
			if (fact.isDirectory() && !fact.isSymbolicLink()) return projection.path;
		} catch {
			// 旧投影不存在或不可 stat：继续尝试其它 projection，最终返回 undefined。
		}
	}

	return undefined;
}

/**
 * 删除 Item 中不属于目标受管根的旧源精确路径（design §8.3 / §8.4）。
 * `.codex` 与 Pi 全局 native 都不是受管 canonical，官方 remove 不识别，必须经
 * `verifySkillDeletionTarget` 验证后定向删除；每条路径只删已验证目标，无法证明安全的残留
 * 收集返回供 partial 诊断。
 */
async function deleteStaleSourcePaths(
	item: InstalledSkillItem,
	target: SkillTopology,
	options: SkillStorageOptions
): Promise<{readonly deleted: readonly string[]; readonly remaining: readonly string[]}> {
	const homeDir = options.homeDir ?? resolveHome();
	const roots = supportedSkillsRoots(homeDir);
	const ownership = buildSkillsOwnershipIndex([item]);
	const targetRoots = targetManagedRoots(target);
	const deleted: string[] = [];
	const remaining: string[] = [];
	for (const projection of item.projections) {
		if (options.preservePiGlobal && projection.root === 'pi-global') continue;
		if (targetRoots.includes(projection.root as 'claude' | 'agents')) continue;
		const verdict = await verifySkillDeletionTarget(projection.path, item.name, roots, ownership);
		if (!verdict.ok) {
			remaining.push(projection.path);
			continue;
		}

		try {
			await removeSkillTarget(verdict.target);
			deleted.push(projection.path);
		} catch {
			remaining.push(projection.path);
		}
	}

	return {deleted, remaining};
}

async function restoreOriginalTopology(
	name: string,
	original: SkillTopology,
	snapshot: SkillSnapshot,
	message: string,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsAdoptionResult> {
	await removeTargets(name, ['cc', 'cx'], onProgress, exec, options);
	const cleared = await inspectSkillStorage(name, options);
	if (cleared.kind !== 'missing') {
		return failureResult(`${message}；自动恢复前无法清空 Claude/Codex 目标`, cleared, snapshot, true);
	}

	const restoredAction = await addFromSnapshot(name, snapshot, original, onProgress, exec, options);
	const restored = await inspectSkillStorage(name, options);
	if (topologyMaterialized(restored, original)) {
		await cleanupSkillSnapshot(snapshot);
		return {
			success: false,
			outcome: 'restored',
			mutated: true,
			inspection: restored,
			error: `${message}；已恢复原拓扑${restoredAction.success ? '' : '（恢复命令退出异常，但文件事实已对账）'}`
		};
	}

	return failureResult(
		`${message}；自动恢复失败：${commandError(restoredAction, restored.error ?? '文件事实不符')}`,
		restored,
		snapshot,
		true
	);
}

async function finishTarget(
	name: string,
	target: SkillTopology,
	snapshot: SkillSnapshot,
	action: SkillsCommandDiagnostic,
	original: SkillTopology,
	item: InstalledSkillItem,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsAdoptionResult> {
	const postflight = await inspectSkillStorage(name, options);
	if (target === 'shared' && postflight.kind === 'shared-copy') {
		return {
			success: false,
			outcome: 'partial',
			mutated: true,
			inspection: postflight,
			error: '双侧内容已保留，但 Claude Code 投影退化为独立副本；请检查链接权限后重试',
			recoveryPath: snapshot.skillPath
		};
	}

	if (!topologyMaterialized(postflight, target)) {
		return restoreOriginalTopology(
			name,
			original,
			snapshot,
			commandError(action, postflight.error ?? 'Skill 命令后文件系统对账失败'),
			onProgress,
			exec,
			options
		);
	}

	// 旧 Codex `.codex` / Pi native 收编：目标已物化后，定向删除非受管根的旧源残留（design §8.4）。
	if (needsManagedMigration(item, target)) {
		const stale = await deleteStaleSourcePaths(item, target, options);
		if (stale.remaining.length > 0) {
			const afterStale = await inspectSkillStorage(name, options);
			return {
				success: false,
				outcome: 'partial',
				mutated: true,
				inspection: afterStale,
				error: `目标已物化，但旧源残留未能完全删除：${stale.remaining.join(', ')}`,
				recoveryPath: snapshot.skillPath
			};
		}
	}

	const final = await inspectSkillStorage(name, options);
	if (topologyMaterialized(final, target)) {
		await cleanupSkillSnapshot(snapshot);
		return {success: true, outcome: 'complete', mutated: true, inspection: final};
	}

	return restoreOriginalTopology(
		name,
		original,
		snapshot,
		commandError(action, final.error ?? '最终文件系统对账失败'),
		onProgress,
		exec,
		options
	);
}

/**
 * C/X/B 单实体拓扑事务（design §8.4）。目标树 mutation 全部经官方 Skills CLI；
 * ccq 只在 OS temp 创建快照，并在 `.codex` 收编时对非受管旧源做经验证安全的定向删除。
 *
 * 拓扑身份由 Item `agents` 派生（不 physical inspection 推导）；事务内 path/lstat 验证与
 * 快照只证明事务安全，不反馈到列表身份或 Agent badge（design §9）。物化判定只看存储 kind，
 * 不比较内容；`readGlobalSkillLockMetadata` 不再参与对账。
 */
export async function transitionSkillTopology(
	item: InstalledSkillItem,
	target: SkillTopology,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn,
	options: SkillStorageOptions = {}
): Promise<SkillsAdoptionResult> {
	const current = currentTopologyOfItem(item);
	if (item.provenance.kind !== 'known') {
		return failureResult(
			'未知来源 Skill 无法迁移：缺少可证明的来源身份',
			await inspectSkillStorage(item.name, options),
			undefined,
			false
		);
	}

	if (current === target && !needsManagedMigration(item, target)) {
		return {success: true, outcome: 'complete', mutated: false, inspection: await inspectSkillStorage(item.name, options)};
	}

	const otherAgents = otherAgentsOf(item).filter(agent => !(options.preservePiGlobal && agent === 'Pi'));
	if (target === 'claude-only' && otherAgents.length > 0) {
		return failureResult(
			`其它 Agent 仍使用 canonical：${otherAgents.join(', ')}`,
			await inspectSkillStorage(item.name, options),
			undefined,
			false
		);
	}

	const preflight = await inspectSkillStorage(item.name, options);
	const sourcePath = await resolveSourceContentPath(item, preflight, options);
	if (!sourcePath) {
		return failureResult('没有可用于迁移的有效 Skill 内容', preflight, undefined, false);
	}

	// current 从 Item 派生；纯旧 Codex/Pi native（无受管根记录）时 inspection 兜底为 codex-only。
	const original: SkillTopology = current ?? topologyOfInspection(preflight) ?? 'codex-only';

	let snapshot: SkillSnapshot | undefined;
	try {
		snapshot = await createSkillSnapshot(sourcePath, item.name, options);

		let action: SkillsCommandDiagnostic;
		if ((current === 'claude-only' && target === 'codex-only') || (current === 'codex-only' && target === 'claude-only')) {
			const removeAgent = current === 'claude-only' ? (['cc'] as const) : (['cx'] as const);
			action = await removeTargets(item.name, removeAgent, onProgress, exec, options);
			const intermediate = await inspectSkillStorage(item.name, options);
			if (intermediate.kind !== 'missing') {
				return restoreOriginalTopology(
					item.name,
					original,
					snapshot,
					commandError(action, '旧实体删除后目标树仍非空'),
					onProgress,
					exec,
					options
				);
			}

			action = await addFromSnapshot(item.name, snapshot, target, onProgress, exec, options);
		} else if (current === 'shared' && target === 'claude-only') {
			action = await removeTargets(item.name, ['cc', 'cx'], onProgress, exec, options);
			const intermediate = await inspectSkillStorage(item.name, options);
			if (intermediate.kind !== 'missing') {
				return restoreOriginalTopology(
					item.name,
					original,
					snapshot,
					commandError(action, '双侧删除后目标树仍非空'),
					onProgress,
					exec,
					options
				);
			}

			action = await addFromSnapshot(item.name, snapshot, target, onProgress, exec, options);
		} else if (current === 'shared' && target === 'codex-only') {
			action = await removeTargets(item.name, ['cc'], onProgress, exec, options);
		} else {
			// -> shared（含 codex-only/claude-only 升级），或旧 Codex/Pi native 收编到任一受管目标：
			// official add 按 codex、claude-code 顺序物化受管根，旧源在 finishTarget 定向删除。
			action = await addFromSnapshot(item.name, snapshot, target, onProgress, exec, options);
		}

		return finishTarget(item.name, target, snapshot, action, original, item, onProgress, exec, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const inspection = await inspectSkillStorage(item.name, options);
		if (!snapshot) {
			return failureResult(message, inspection, undefined, false);
		}

		return restoreOriginalTopology(item.name, original, snapshot, message, onProgress, exec, options);
	}
}

function piGlobalSkillPath(name: string, options: SkillStorageOptions): string | undefined {
	if (!isSafeSkillName(name)) return undefined;
	return join(options.homeDir ?? resolveHome(), '.pi', 'agent', 'skills', name);
}

async function piGlobalTargetMaterialized(name: string, options: SkillStorageOptions): Promise<boolean> {
	const path = piGlobalSkillPath(name, options);
	if (!path) return false;
	try {
		const fact = await lstat(path);
		if (!fact.isSymbolicLink()) return false;

		const canonical = join(options.homeDir ?? resolveHome(), '.agents', 'skills', name);
		const canonicalFact = await lstat(canonical);
		if (!canonicalFact.isDirectory() || canonicalFact.isSymbolicLink()) return false;
		const [target, canonicalTarget] = await Promise.all([realpath(path), realpath(canonical)]);
		return target === canonicalTarget;
	} catch {
		return false;
	}
}

async function piGlobalTargetPresent(name: string, options: SkillStorageOptions): Promise<boolean> {
	const path = piGlobalSkillPath(name, options);
	if (!path) return false;
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function addPiFromSnapshot(
	name: string,
	snapshot: SkillSnapshot,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsCommandDiagnostic> {
	return runSkillsAdd(
		{
			source: snapshot.root,
			skillNames: [name],
			agents: ['cx', 'pi'],
			scope: 'global',
			env: topologyEnv(options, true),
			displayName: name
		},
		onProgress,
		exec
	);
}

async function removePiTarget(
	name: string,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsCommandDiagnostic> {
	return runSkillsRemove(
		{
			skillNames: [name],
			agents: ['pi'],
			scope: 'global',
			env: topologyEnv(options, true)
		},
		onProgress,
		exec
	);
}

function withoutPiGlobalProjection(item: InstalledSkillItem): InstalledSkillItem {
	return {
		...item,
		agents: item.agents.filter(agent => agent !== 'Pi'),
		projections: item.projections.filter(projection => projection.root !== 'pi-global')
	};
}

function hasPiGlobalProjection(item: InstalledSkillItem): boolean {
	return itemAvailableOn(item, 'pi') && storageRootsOf(item).includes('pi-global');
}

/**
 * 独立维护 Claude Code、Codex 与 Pi 三个目标。
 *
 * C/X 仍复用已有的安全拓扑事务；Pi 通过官方 `--agent codex --agent pi -g`
 * 写入 `~/.agents/skills` canonical 与 `~/.pi/agent/skills` 软链接，删除时只撤销 Pi 侧。
 */
export async function transitionSkillAgents(
	item: InstalledSkillItem,
	target: SkillAgentTargets,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn,
	options: SkillStorageOptions = {}
): Promise<SkillsAdoptionResult> {
	if (item.provenance.kind !== 'known') {
		return failureResult(
			'未知来源 Skill 无法迁移：缺少可证明的来源身份',
			await inspectSkillStorage(item.name, options),
			undefined,
			false
		);
	}

	if (!target.cc && !target.cx && !target.pi) {
		return failureResult('至少保留一个安装目标', await inspectSkillStorage(item.name, options), undefined, false);
	}

	// Pi 的官方 symlink 模式必须同时有 Codex canonical：Pi-only 等价于 codex-only，
	// cc+pi 等价于 shared；这是物理拓扑约束，不改变管理页对三个 Agent 的独立展示。
	const targetCx = target.pi ? (target.cc ? 'shared' : 'codex-only') : targetTopologyOfDraft({cc: target.cc, cx: target.cx});
	const currentCx = currentTopologyOfItem(item);
	// Pi global 的删除必须走官方 `--agent pi -g`，不能被旧 C/X 收编事务的
	// legacy direct-delete 分支提前清掉；无论目标是否保留 Pi，都先让 C/X 事务保留它。
	const preservePiDuringCx = storageRootsOf(item).includes('pi-global');
	let mutated = false;

	if (targetCx === 'empty') {
		if (currentCx) {
			const action = await removeTargets(item.name, ['cc', 'cx'], onProgress, exec, options);
			mutated ||= action.spawned;
			const cleared = await inspectSkillStorage(item.name, options);
			if (cleared.kind !== 'missing') {
				return {
					success: false,
					outcome: 'partial',
					mutated: true,
					inspection: cleared,
					error: commandError(action, 'Claude/Codex 目标未能完全删除')
				};
			}
		}
	} else {
		// Pi 作为独立目标保留时，C/X 事务不得把 Pi global 当成旧源删除；
		// 只有纯 Pi → C/X 收编才把原 Item 交给旧事务读取 Pi 内容。
		const cxItem = preservePiDuringCx && currentCx ? withoutPiGlobalProjection(item) : item;
		const cxNeedsTransition = currentCx !== targetCx || needsManagedMigration(cxItem, targetCx);
		if (cxNeedsTransition) {
			const result = await transitionSkillTopology(cxItem, targetCx, onProgress, exec, {
				...options,
				preservePiGlobal: preservePiDuringCx
			});
			mutated ||= result.mutated;
			if (!result.success) return {...result, mutated: mutated || result.mutated};
		}
	}

	const piMaterialized = await piGlobalTargetMaterialized(item.name, options);
	let piSnapshot: SkillSnapshot | undefined;
	if (target.pi && !piMaterialized) {
		const inspection = await inspectSkillStorage(item.name, options);
		const sourcePath = await resolveSourceContentPath(item, inspection, options);
		if (!sourcePath) {
			return failureResult('没有可用于安装 Pi global target 的有效 Skill 内容', inspection, undefined, mutated);
		}

		try {
			piSnapshot = await createSkillSnapshot(sourcePath, item.name, options);
			const action = await addPiFromSnapshot(item.name, piSnapshot, onProgress, exec, options);
			mutated ||= action.spawned;
			if (!action.success || !(await piGlobalTargetMaterialized(item.name, options))) {
				return {
					success: false,
					outcome: 'partial',
					mutated: true,
					inspection: await inspectSkillStorage(item.name, options),
					error: commandError(action, 'Pi global target 物化失败'),
					recoveryPath: piSnapshot.skillPath
				};
			}
		} catch (error) {
			return failureResult(
				error instanceof Error ? error.message : String(error),
				await inspectSkillStorage(item.name, options),
				piSnapshot,
				mutated
			);
		}
	}

	const piAfterCx = await piGlobalTargetPresent(item.name, options);
	if (!target.pi && piAfterCx) {
		const action = await removePiTarget(item.name, onProgress, exec, options);
		mutated ||= action.spawned;
		if (!action.success && (await piGlobalTargetPresent(item.name, options))) {
			return {
				success: false,
				outcome: 'partial',
				mutated: true,
				inspection: await inspectSkillStorage(item.name, options),
				error: commandError(action, 'Pi global target 删除失败')
			};
		}
	}

	const finalInspection = await inspectSkillStorage(item.name, options);
	const finalPi = await piGlobalTargetMaterialized(item.name, options);
	const cxReady = targetCx === 'empty' ? finalInspection.kind === 'missing' : topologyMaterialized(finalInspection, targetCx);
	if (!cxReady || finalPi !== target.pi) {
		return {
			success: false,
			outcome: 'partial',
			mutated,
			inspection: finalInspection,
			error: '最终检测未确认 Claude Code/Codex/Pi 目标集合',
			...(piSnapshot ? {recoveryPath: piSnapshot.skillPath} : {})
		};
	}

	if (piSnapshot) await cleanupSkillSnapshot(piSnapshot);
	return {success: true, outcome: 'complete', mutated, inspection: finalInspection};
}
