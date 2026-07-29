import {preferredTransport, type DownloadedSelfUpdate, type DownloadUpdateProgress, type SelfUpdatePlan} from '../core/self-update.js';

/**
 * 失败态携带的重试上下文：失败发生在哪个阶段、以及重跑该阶段所需的完整入参。
 * 没有它，error 屏就只能关闭而无法重试（plan/transaction 在 reduce 时被丢弃）。
 */
export type SelfUpdateRetry =
	| {readonly stage: 'check'}
	| {readonly stage: 'download'; readonly plan: SelfUpdatePlan}
	| {readonly stage: 'apply'; readonly transaction: DownloadedSelfUpdate};

export type SelfUpdateScreen =
	| {readonly kind: 'checking'}
	| {readonly kind: 'latest'}
	| {readonly kind: 'available'; readonly plan: SelfUpdatePlan}
	| {
			readonly kind: 'updating';
			readonly stage: 'downloading' | 'cancelling';
			readonly plan: SelfUpdatePlan;
			readonly progress: DownloadUpdateProgress;
	  }
	| {readonly kind: 'updating'; readonly stage: 'applying'; readonly transaction: DownloadedSelfUpdate}
	| {readonly kind: 'readyToRestart'; readonly transaction: DownloadedSelfUpdate}
	| {readonly kind: 'updated'; readonly version: string}
	| {readonly kind: 'error'; readonly message: string; readonly retry: SelfUpdateRetry};

export type SelfUpdateScreenAction =
	| {readonly type: 'checkStarted'}
	| {readonly type: 'latestConfirmed'}
	| {readonly type: 'updateAvailable'; readonly plan: SelfUpdatePlan}
	| {readonly type: 'downloadStarted'; readonly plan: SelfUpdatePlan}
	| {readonly type: 'downloadProgress'; readonly progress: DownloadUpdateProgress}
	| {readonly type: 'cancelRequested'}
	| {readonly type: 'downloadReady'; readonly transaction: DownloadedSelfUpdate}
	| {readonly type: 'applyStarted'; readonly transaction: DownloadedSelfUpdate}
	| {readonly type: 'applyCompleted'; readonly version: string}
	| {readonly type: 'failed'; readonly message: string; readonly retry: SelfUpdateRetry};

export function reduceSelfUpdateScreen(state: SelfUpdateScreen, action: SelfUpdateScreenAction): SelfUpdateScreen {
	switch (action.type) {
		case 'checkStarted':
			return {kind: 'checking'};
		case 'latestConfirmed':
			return {kind: 'latest'};
		case 'updateAvailable':
			return {kind: 'available', plan: action.plan};
		case 'downloadStarted': {
			// 进度总量以首选 transport（通常是 gzip）为准；回退时由 core 显式重置。
			const transport = preferredTransport(action.plan);
			return {
				kind: 'updating',
				stage: 'downloading',
				plan: action.plan,
				progress: {
					downloadedBytes: 0,
					totalBytes: transport.expectedSize,
					percentage: 0,
					assetName: transport.assetName,
					encoding: transport.encoding
				}
			};
		}
		case 'downloadProgress':
			if (state.kind !== 'updating' || state.stage === 'applying') return state;
			return {...state, progress: action.progress};
		case 'cancelRequested':
			return isSelfUpdateCancellable(state) ? {...state, stage: 'cancelling'} : state;
		case 'downloadReady':
			return {kind: 'readyToRestart', transaction: action.transaction};
		case 'applyStarted':
			return {kind: 'updating', stage: 'applying', transaction: action.transaction};
		case 'applyCompleted':
			return {kind: 'updated', version: action.version};
		case 'failed':
			return {kind: 'error', message: action.message, retry: action.retry};
	}
}

export function isSelfUpdateCancellable(screen: SelfUpdateScreen): screen is {
	readonly kind: 'updating';
	readonly stage: 'downloading';
	readonly plan: SelfUpdatePlan;
	readonly progress: DownloadUpdateProgress;
} {
	return screen.kind === 'updating' && screen.stage === 'downloading';
}

export function selfUpdateScreenVersion(screen: Extract<SelfUpdateScreen, {readonly kind: 'updating'}>): string {
	return screen.stage === 'applying' ? screen.transaction.plan.version : screen.plan.version;
}
