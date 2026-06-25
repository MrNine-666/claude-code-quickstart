import {createDetectionRunner, type DetectionRunner, type DetectionStateSink} from './detection-runner.js';
import {createInitialDetectionState} from './async-detection.js';
import {checkComponentUpdates, type UpdateComponent} from '../core/update.js';
import {getInstalledSkills, type InstalledSkill} from '../core/skills.js';
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

export function runSkillsDetection(runner: DetectionRunner<InstalledSkill[]>): Promise<unknown> {
	return runner.run(() => getInstalledSkills());
}

// 工具管理检测 runner（Phase 11D）：检测 6 受管组件（ClaudeCode + 5 工具），不聚合 Skills/MCP。
export function createToolsDetectionRunner(onChange: DetectionStateSink<ManagedComponent[]>): DetectionRunner<ManagedComponent[]> {
	return createDetectionRunner(createInitialDetectionState<ManagedComponent[]>(), onChange);
}

export function runToolsDetection(runner: DetectionRunner<ManagedComponent[]>): Promise<unknown> {
	return runner.run(() => detectComponents());
}
