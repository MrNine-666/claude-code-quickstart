import type {ProgressCallback} from '../core/exec.js';
import {createSkillsChildEnv, runSkillsAdd, runSkillsRemove, type SkillsCommandDiagnostic, type SkillsExecFn} from '../core/skills-actions.js';
import {readGlobalSkillLockMetadata, type SkillSharedRow} from '../core/skills.js';
import {
	cleanupSkillSnapshot,
	createSkillSnapshot,
	inspectSkillStorage,
	preferredSkillContentPath,
	readSkillManifest,
	skillManifestsEqual,
	topologyOfInspection,
	type SkillSnapshot,
	type SkillStorageInspection,
	type SkillStorageOptions,
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

type RecoverableTopology = SkillTopology | 'shared-copy';

export {targetTopologyOfDraft, topologyOfInspection} from '../core/skills-storage.js';
export type {SkillTopology, SkillTopologyDraft} from '../core/skills-storage.js';

function recoverableTopology(inspection: SkillStorageInspection): RecoverableTopology | undefined {
	return inspection.kind === 'shared-copy' ? 'shared-copy' : topologyOfInspection(inspection);
}

function expectedStorageKind(topology: SkillTopology): SkillStorageInspection['kind'] {
	return topology === 'claude-only'
		? 'claude-only'
		: topology === 'codex-only'
			? 'canonical-only'
			: 'shared-symlink';
}

function topologyEnv(options: SkillStorageOptions, includeCodex: boolean): NodeJS.ProcessEnv {
	return createSkillsChildEnv(options.homeDir, includeCodex);
}

function contentPath(inspection: SkillStorageInspection, topology: SkillTopology): string {
	return topology === 'claude-only' ? inspection.claudePath : inspection.canonicalPath;
}

async function matchesTopology(
	inspection: SkillStorageInspection,
	topology: SkillTopology,
	manifest: readonly string[]
): Promise<boolean> {
	if (inspection.kind !== expectedStorageKind(topology)) {
		return false;
	}

	try {
		return skillManifestsEqual(await readSkillManifest(contentPath(inspection, topology), inspection.name), manifest);
	} catch {
		return false;
	}
}

function commandError(action: SkillsCommandDiagnostic, fallback: string): string {
	// skills CLI 会把正常交互渲染写入 stderr；原始流只保留给结构化诊断。
	return action.error ?? fallback;
}

async function addFromSnapshot(
	name: string,
	snapshot: SkillSnapshot,
	target: SkillTopology,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsCommandDiagnostic> {
	const agents = target === 'claude-only' ? ['cc'] as const : target === 'codex-only' ? ['cx'] as const : ['cx', 'cc'] as const;
	return runSkillsAdd({
		source: snapshot.root,
		skillNames: [name],
		agents,
		copy: target !== 'shared',
		env: topologyEnv(options, target !== 'claude-only'),
		displayName: name
	}, onProgress, exec);
}

async function removeTargets(
	name: string,
	agents: readonly ('cc' | 'cx')[],
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsCommandDiagnostic> {
	return runSkillsRemove({
		skillNames: [name],
		agents,
		// 即使只撤销 Claude 投影，也必须让 1.5.19 检测到 Codex 正在使用 canonical，
		// 否则 remove 会把“无人使用”的 ~/.agents/skills 本体一并删除。
		env: topologyEnv(options, true)
	}, onProgress, exec);
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

async function restoreOriginalTopology(
	name: string,
	original: RecoverableTopology,
	snapshot: SkillSnapshot,
	message: string,
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillStorageOptions
): Promise<SkillsAdoptionResult> {
	if (original === 'shared-copy') {
		return failureResult(message, await inspectSkillStorage(name, options), snapshot, true);
	}

	await removeTargets(name, ['cc', 'cx'], onProgress, exec, options);
	const cleared = await inspectSkillStorage(name, options);
	if (cleared.kind !== 'missing') {
		return failureResult(`${message}；自动恢复前无法清空 Claude/Codex 目标`, cleared, snapshot, true);
	}

	const restoredAction = await addFromSnapshot(name, snapshot, original, onProgress, exec, options);
	const restored = await inspectSkillStorage(name, options);
	if (await matchesTopology(restored, original, snapshot.manifest)) {
		await cleanupSkillSnapshot(snapshot);
		return {
			success: false,
			outcome: 'restored',
			mutated: true,
			inspection: restored,
			error: `${message}；已恢复原拓扑${restoredAction.success ? '' : '（恢复命令退出异常，但文件事实已对账）'}`
		};
	}

	return failureResult(`${message}；自动恢复失败：${commandError(restoredAction, restored.error ?? '文件事实不符')}`, restored, snapshot, true);
}

async function finishTarget(
	name: string,
	target: SkillTopology,
	snapshot: SkillSnapshot,
	action: SkillsCommandDiagnostic,
	original: RecoverableTopology,
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

	if (await matchesTopology(postflight, target, snapshot.manifest)) {
		const finalLock = await readGlobalSkillLockMetadata(options.homeDir);
		if (finalLock.has(name)) {
			return restoreOriginalTopology(
				name,
				original,
				snapshot,
				'本地 snapshot 拓扑仍残留远程 lock，拒绝报告完成',
				onProgress,
				exec,
				options
			);
		}

		await cleanupSkillSnapshot(snapshot);
		return {success: true, outcome: 'complete', mutated: true, inspection: postflight};
	}

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

/**
 * C/X/B 单实体拓扑事务。目标树 mutation 全部经官方 Skills CLI；ccq 只在 OS temp 创建快照。
 */
export async function transitionSkillTopology(
	skill: SkillSharedRow,
	target: SkillTopology,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn,
	options: SkillStorageOptions = {}
): Promise<SkillsAdoptionResult> {
	const preflight = await inspectSkillStorage(skill.name, options);
	const original = recoverableTopology(preflight);
	if (!original) {
		return failureResult(preflight.error ?? `${skill.name} 不是可迁移的 C/X/B Skill`, preflight, undefined, false);
	}

	if (original === target) {
		return {success: true, outcome: 'complete', mutated: false, inspection: preflight};
	}

	const otherAgents = skill.otherAgents ?? skill.agents?.filter(agent => agent !== 'Claude Code' && agent !== 'Codex') ?? [];
	if (target === 'claude-only' && otherAgents.length > 0) {
		return failureResult(`其它 Agent 仍使用 canonical：${otherAgents.join(', ')}`, preflight, undefined, false);
	}

	const sourcePath = preferredSkillContentPath(preflight);
	if (!sourcePath) {
		return failureResult('没有可用于迁移的有效 Skill 内容', preflight, undefined, false);
	}

	let snapshot: SkillSnapshot | undefined;
	try {
		snapshot = await createSkillSnapshot(sourcePath, skill.name, options);
		const currentManifest = await readSkillManifest(sourcePath, skill.name);
		if (!skillManifestsEqual(currentManifest, snapshot.manifest)) {
			await cleanupSkillSnapshot(snapshot);
			return failureResult('Skill 内容在迁移前发生变化，请刷新后重试', await inspectSkillStorage(skill.name, options), undefined, false);
		}

		let action: SkillsCommandDiagnostic;
		if ((original === 'claude-only' && target === 'codex-only') || (original === 'codex-only' && target === 'claude-only')) {
			const removeAgent = original === 'claude-only' ? ['cc'] as const : ['cx'] as const;
			action = await removeTargets(skill.name, removeAgent, onProgress, exec, options);
			const intermediate = await inspectSkillStorage(skill.name, options);
			if (intermediate.kind !== 'missing') {
				return restoreOriginalTopology(skill.name, original, snapshot, commandError(action, '旧实体删除后目标树仍非空'), onProgress, exec, options);
			}
			action = await addFromSnapshot(skill.name, snapshot, target, onProgress, exec, options);
		} else if ((original === 'shared' || original === 'shared-copy') && target === 'claude-only') {
			action = await removeTargets(skill.name, ['cc', 'cx'], onProgress, exec, options);
			const intermediate = await inspectSkillStorage(skill.name, options);
			if (intermediate.kind !== 'missing') {
				return restoreOriginalTopology(skill.name, original, snapshot, commandError(action, '双侧删除后目标树仍非空'), onProgress, exec, options);
			}
			action = await addFromSnapshot(skill.name, snapshot, target, onProgress, exec, options);
		} else if ((original === 'shared' || original === 'shared-copy') && target === 'codex-only') {
			action = await removeTargets(skill.name, ['cc'], onProgress, exec, options);
		} else {
			// C/X/shared-copy -> B：官方 1.5.19 按 codex、claude-code 顺序完成 X 物化与 C 投影。
			action = await addFromSnapshot(skill.name, snapshot, target, onProgress, exec, options);
		}

		return finishTarget(skill.name, target, snapshot, action, original, onProgress, exec, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const inspection = await inspectSkillStorage(skill.name, options);
		if (!snapshot) {
			return failureResult(message, inspection, undefined, false);
		}
		return restoreOriginalTopology(skill.name, original, snapshot, message, onProgress, exec, options);
	}
}

/** 兼容旧入口：Claude-only 收编现在只是 C -> B 拓扑事务。 */
export async function adoptClaudeOnlySkill(
	skill: SkillSharedRow,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn,
	options: SkillStorageOptions = {}
): Promise<SkillsAdoptionResult> {
	const preflight = await inspectSkillStorage(skill.name, options);
	if (preflight.kind !== 'claude-only') {
		return failureResult(preflight.error ?? `${skill.name} 不再是可收编的 Claude-only Skill`, preflight, undefined, false);
	}
	return transitionSkillTopology(skill, 'shared', onProgress, exec, options);
}

/** 兼容旧入口：canonical-only/shared-copy 修复现在只是 X/partial -> B 拓扑事务。 */
export async function repairClaudeProjection(
	skill: SkillSharedRow,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn,
	options: SkillStorageOptions = {}
): Promise<SkillsAdoptionResult> {
	const preflight = await inspectSkillStorage(skill.name, options);
	if (preflight.kind === 'shared-symlink') {
		return {success: true, outcome: 'complete', mutated: false, inspection: preflight};
	}
	if (preflight.kind !== 'canonical-only' && preflight.kind !== 'shared-copy') {
		return failureResult(preflight.error ?? `${skill.name} 没有可用于恢复 Claude Code 的 canonical 本体`, preflight, undefined, false);
	}
	return transitionSkillTopology(skill, 'shared', onProgress, exec, options);
}
