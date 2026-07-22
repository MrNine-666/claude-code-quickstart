import type React from 'react';
import type {BusyOverlayState} from '../../components/index.js';
import type {ProgressCallback} from '../../core/exec.js';
import type {
	AgentInjectSnapshot,
	ComponentId,
	ComponentInstallOutcome,
	ComponentUninstallOutcome,
	ManagedComponent,
	SharedManagedComponent
} from '../../core/tools-manage.js';
import type {ApplyUpdatesResult} from '../../core/update.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {DetectionRunOptions, DetectionRunner, DetectionStateSink} from '../../services/detection-runner.js';
import type {AgentContext} from '../../state/manage-state.js';
import type {ComponentPatch, ToolsViewAction} from '../../state/tools-view-state.js';

export type {
	AgentInjectSnapshot,
	ComponentId,
	ComponentInstallOutcome,
	ComponentUninstallOutcome,
	ManagedComponent,
	SharedManagedComponent
};

export type ToolsViewDispatch = React.Dispatch<ToolsViewAction>;

export type InjectChangesResult = {
	readonly patch: ComponentPatch;
	readonly error?: string;
};

export type UninstallOptions = {
	readonly agentContext?: AgentContext;
	readonly fullUninstall?: boolean;
	readonly signal?: AbortSignal;
};

export type ToolsViewServices = {
	readonly detectComponents: () => Promise<readonly ManagedComponent[]>;
	readonly installComponent: (
		id: ComponentId,
		onProgress?: ProgressCallback,
		agentContext?: AgentContext,
		signal?: AbortSignal
	) => Promise<ComponentInstallOutcome>;
	readonly installMultiple: (
		ids: readonly ComponentId[],
		onProgress?: ProgressCallback,
		agentContext?: AgentContext,
		signal?: AbortSignal
	) => Promise<readonly ComponentInstallOutcome[]>;
	readonly updateComponents: (
		components: readonly ManagedComponent[],
		onProgress?: ProgressCallback,
		agentContext?: AgentContext,
		signal?: AbortSignal
	) => Promise<ApplyUpdatesResult>;
	readonly uninstallComponent: (
		id: ComponentId,
		onProgress?: ProgressCallback,
		options?: UninstallOptions
	) => Promise<ComponentUninstallOutcome>;
	readonly injectComponent: (
		id: ComponentId,
		target: AgentContext,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<ComponentInstallOutcome>;
	readonly ejectComponent: (
		id: ComponentId,
		target: AgentContext,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<ComponentUninstallOutcome>;
	readonly createDetectionRunner: (onChange: DetectionStateSink<ManagedComponent[]>) => DetectionRunner<ManagedComponent[]>;
	readonly runDetection: (runner: DetectionRunner<ManagedComponent[]>) => Promise<unknown>;
	readonly refreshDetection?: (runner: DetectionRunner<ManagedComponent[]>, options?: DetectionRunOptions) => Promise<unknown>;
};

export type ToolsViewProps = {
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly active?: boolean;
	readonly contentWidth?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav?: () => void;
};
