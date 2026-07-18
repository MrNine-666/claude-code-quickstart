import {createDetectionRunner, type DetectionRunner, type DetectionRunOptions, type DetectionStateSink} from './detection-runner.js';
import {createInitialDetectionState} from './async-detection.js';
import {checkComponentUpdates, type UpdateComponent} from '../core/update.js';
import {getInstalledSkills, inspectInstalledSkillStorage, type InstalledSkill} from '../core/skills.js';
import type {SkillStorageOptions} from '../core/skills-storage.js';
import {detectComponents, type ManagedComponent} from '../core/tools-manage.js';

// 视图检测服务（design D13）：Skills / Tools 首次进入立即渲染 loading，
// 后台异步执行检测，完成后通过 state sink 通知 Ink 重渲染；进行中不重复触发。
// Update 视图已合并入工具管理（Phase 11D），Update runner 保留供 core 复用，无视图消费者。

export function createUpdateDetectionRunner(onChange: DetectionStateSink<UpdateComponent[]>): DetectionRunner<UpdateComponent[]> {
	return createDetectionRunner(createInitialDetectionState<UpdateComponent[]>(), onChange);
}

export function runUpdateDetection(runner: DetectionRunner<UpdateComponent[]>): Promise<unknown> {
	return runner.run(() => checkComponentUpdates());
}

export function createSkillsDetectionRunner(onChange: DetectionStateSink<InstalledSkill[]>): DetectionRunner<InstalledSkill[]> {
	return createDetectionRunner(createInitialDetectionState<InstalledSkill[]>(), onChange);
}

// 双侧共享检测（shared-resource-injection-ui Section 17.1）：不传 agentContext，
// 跑无 `--agent` 的 getInstalledSkills 一次得双侧态；检测与 agentContext 解耦。
// exec 缝仅供测试注入桩（首参为 exec 时 getInstalledSkills 内部识别为全量扫）。
export function runSkillsDetection(
	runner: DetectionRunner<InstalledSkill[]>,
	exec?: Parameters<typeof getInstalledSkills>[0],
	storageOptions: SkillStorageOptions = {}
): Promise<unknown> {
	return runner.run(async () => {
		const installed = typeof exec === 'function' ? await getInstalledSkills(exec) : await getInstalledSkills();
		return inspectInstalledSkillStorage(installed, storageOptions);
	});
}

// 工具管理检测 runner（Phase 11D）：检测 7 受管组件（ClaudeCode + 6 工具），不聚合 Skills/MCP。
export function createToolsDetectionRunner(onChange: DetectionStateSink<ManagedComponent[]>): DetectionRunner<ManagedComponent[]> {
	return createDetectionRunner(createInitialDetectionState<ManagedComponent[]>(), onChange);
}

export function runToolsDetection(runner: DetectionRunner<ManagedComponent[]>, options: DetectionRunOptions = {}): Promise<unknown> {
	return runner.run(() => detectComponents(undefined, options.forceRefresh === true));
}
