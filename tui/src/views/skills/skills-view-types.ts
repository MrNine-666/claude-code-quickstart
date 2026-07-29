import type React from 'react';
import type {BusyOverlayState} from '../../components/index.js';
import type {ProgressCallback} from '../../core/exec.js';
import type {SearchSkillResult} from '../../core/skills.js';
import type {InstalledSkillItem} from '../../core/skills-installed.js';
import type {SkillTopology} from '../../core/skills-storage.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {DetectionRunner, DetectionStateSink} from '../../services/detection-runner.js';
import type {SkillsAdoptionResult} from '../../services/skills-adoption.js';
import type {
	SkillsBatchExecution,
	SkillsBatchUninstallOutcome,
	SkillsBatchUpdateOutcome,
	SkillsReplacementExecution
} from '../../services/skills-service.js';
import type {AgentContext} from '../../state/manage-state.js';
import type {SkillsViewAction} from '../../state/skills-view-state.js';

export type {
	InstalledSkillItem,
	SearchSkillResult,
	SkillTopology,
	SkillsAdoptionResult,
	SkillsBatchExecution,
	SkillsBatchUninstallOutcome,
	SkillsBatchUpdateOutcome,
	SkillsReplacementExecution,
};

export type SkillsViewDispatch = React.Dispatch<SkillsViewAction>;

// 检测结果类型（task 07-28 R1）：视图层只消费逻辑实例，不再看 CLI 原始记录或物理 inspection。
export type SkillsDetection = readonly InstalledSkillItem[];

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ok: true; results: readonly SearchSkillResult[]} | {ok: false; error: string; rawSummary?: string}>;
	readonly installBatchToTargets: (
		results: readonly SearchSkillResult[],
		targets: readonly AgentContext[],
		onProgress?: ProgressCallback,
		installed?: readonly InstalledSkillItem[],
		signal?: AbortSignal
	) => Promise<SkillsBatchExecution>;
	readonly finalizeReplacementSnapshots: (
		replacements: readonly SkillsReplacementExecution[],
		confirmedKeys: readonly string[]
	) => Promise<void>;
	// 迁移/Agent 切换接收完整 Item 快照，而不是名称：同名异源必须能被区分（R6）。
	readonly transitionTopology: (
		item: InstalledSkillItem,
		target: SkillTopology,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<SkillsAdoptionResult>;
	readonly updateInstances: (
		items: readonly InstalledSkillItem[],
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<SkillsBatchUpdateOutcome>;
	// 删除接收 Item 快照与当前全量列表，由 service 规划「官方 remove 或经验证的定向删除」（R7）：
	// 全量列表用于证明官方名称级 remove 不会误伤同名异源实例。
	readonly uninstallInstances: (
		items: readonly InstalledSkillItem[],
		allItems: readonly InstalledSkillItem[],
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<SkillsBatchUninstallOutcome>;
	readonly createDetectionRunner: (onChange: DetectionStateSink<SkillsDetection>) => DetectionRunner<SkillsDetection>;
	readonly runDetection: (runner: DetectionRunner<SkillsDetection>) => Promise<unknown>;
};

export type SkillsViewProps = {
	readonly services: SkillsViewServices;
	readonly cache: DetectionCache<SkillsDetection>;
	readonly active?: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav?: () => void;
};
