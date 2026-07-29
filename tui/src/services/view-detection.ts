import {createDetectionRunner, type DetectionRunner, type DetectionRunOptions, type DetectionStateSink} from './detection-runner.js';
import {createInitialDetectionState} from './async-detection.js';
import {checkComponentUpdates, type UpdateComponent} from '../core/update.js';
import {detectInstalledSkillItems, type ExecFn, type InstalledSkillItem} from '../core/skills-installed.js';
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

export function createSkillsDetectionRunner(
	onChange: DetectionStateSink<readonly InstalledSkillItem[]>
): DetectionRunner<readonly InstalledSkillItem[]> {
	return createDetectionRunner(createInitialDetectionState<readonly InstalledSkillItem[]>(), onChange);
}

// 已安装检测（task 07-28 R1）：唯一事实源是一次不带 `--agent` 的 `skills list -g --json`。
// 不读 `.skill-lock.json`、不扫 `.claude`/`.agents`/`.codex` 目录补充或修正列表事实。
// exec 缝仅供测试注入桩。
export function runSkillsDetection(
	runner: DetectionRunner<readonly InstalledSkillItem[]>,
	exec?: ExecFn
): Promise<unknown> {
	return runner.run(() => (exec ? detectInstalledSkillItems(exec) : detectInstalledSkillItems()));
}

// 工具管理检测 runner（Phase 11D）：检测 7 受管组件（ClaudeCode + 6 工具），不聚合 Skills/MCP。
export function createToolsDetectionRunner(onChange: DetectionStateSink<ManagedComponent[]>): DetectionRunner<ManagedComponent[]> {
	return createDetectionRunner(createInitialDetectionState<ManagedComponent[]>(), onChange);
}

export function runToolsDetection(runner: DetectionRunner<ManagedComponent[]>, options: DetectionRunOptions = {}): Promise<unknown> {
	return runner.run(() => detectComponents(undefined, options.forceRefresh === true));
}
