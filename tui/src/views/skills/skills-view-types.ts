import type React from 'react';
import type {BusyOverlayState} from '../../components/index.js';
import type {ProgressCallback} from '../../core/exec.js';
import type {InstalledSkill, SearchSkillResult, SkillSharedRow} from '../../core/skills.js';
import type {SkillTopology} from '../../core/skills-storage.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {DetectionRunner, DetectionStateSink} from '../../services/detection-runner.js';
import type {SkillsAdoptionResult} from '../../services/skills-adoption.js';
import type {SkillsBatchExecution, SkillsReplacementExecution} from '../../services/skills-service.js';
import type {AgentContext} from '../../state/manage-state.js';
import type {SkillsViewAction} from '../../state/skills-view-state.js';

export type {
	InstalledSkill,
	SearchSkillResult,
	SkillSharedRow,
	SkillTopology,
	SkillsAdoptionResult,
	SkillsBatchExecution,
	SkillsReplacementExecution
};

export type SkillsViewDispatch = React.Dispatch<SkillsViewAction>;

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ok: true; results: readonly SearchSkillResult[]} | {ok: false; error: string; rawSummary?: string}>;
	readonly installBatchToTargets: (
		results: readonly SearchSkillResult[],
		targets: readonly AgentContext[],
		onProgress?: ProgressCallback,
		installed?: readonly SkillSharedRow[],
		signal?: AbortSignal
	) => Promise<SkillsBatchExecution>;
	readonly finalizeReplacementSnapshots: (
		replacements: readonly SkillsReplacementExecution[],
		confirmedKeys: readonly string[]
	) => Promise<void>;
	readonly transitionTopology: (
		skill: SkillSharedRow,
		target: SkillTopology,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<SkillsAdoptionResult>;
	readonly updateBothSides: (
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	readonly updateOne: (
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	readonly uninstallAllAgents: (
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<{success: boolean; error?: string}>;
	readonly createDetectionRunner: (onChange: DetectionStateSink<InstalledSkill[]>) => DetectionRunner<InstalledSkill[]>;
	readonly runDetection: (runner: DetectionRunner<InstalledSkill[]>) => Promise<unknown>;
};

export type SkillsViewProps = {
	readonly services: SkillsViewServices;
	readonly cache: DetectionCache<InstalledSkill[]>;
	readonly active?: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav?: () => void;
};
