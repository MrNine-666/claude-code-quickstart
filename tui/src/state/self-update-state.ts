import type {DownloadedSelfUpdate, SelfUpdatePlan} from '../core/self-update.js';

export type SelfUpdateScreen =
	| {readonly kind: 'checking'}
	| {readonly kind: 'latest'}
	| {readonly kind: 'available'; readonly plan: SelfUpdatePlan}
	| {readonly kind: 'updating'; readonly stage: 'downloading' | 'cancelling'; readonly plan: SelfUpdatePlan}
	| {readonly kind: 'updating'; readonly stage: 'applying'; readonly transaction: DownloadedSelfUpdate}
	| {readonly kind: 'readyToRestart'; readonly transaction: DownloadedSelfUpdate}
	| {readonly kind: 'updated'; readonly version: string}
	| {readonly kind: 'error'; readonly message: string};

export type SelfUpdateScreenAction =
	| {readonly type: 'checkStarted'}
	| {readonly type: 'latestConfirmed'}
	| {readonly type: 'updateAvailable'; readonly plan: SelfUpdatePlan}
	| {readonly type: 'downloadStarted'; readonly plan: SelfUpdatePlan}
	| {readonly type: 'cancelRequested'}
	| {readonly type: 'downloadReady'; readonly transaction: DownloadedSelfUpdate}
	| {readonly type: 'applyStarted'; readonly transaction: DownloadedSelfUpdate}
	| {readonly type: 'applyCompleted'; readonly version: string}
	| {readonly type: 'failed'; readonly message: string};

export function reduceSelfUpdateScreen(
	state: SelfUpdateScreen,
	action: SelfUpdateScreenAction
): SelfUpdateScreen {
	switch (action.type) {
		case 'checkStarted':
			return {kind: 'checking'};
		case 'latestConfirmed':
			return {kind: 'latest'};
		case 'updateAvailable':
			return {kind: 'available', plan: action.plan};
		case 'downloadStarted':
			return {kind: 'updating', stage: 'downloading', plan: action.plan};
		case 'cancelRequested':
			return isSelfUpdateCancellable(state) ? {...state, stage: 'cancelling'} : state;
		case 'downloadReady':
			return {kind: 'readyToRestart', transaction: action.transaction};
		case 'applyStarted':
			return {kind: 'updating', stage: 'applying', transaction: action.transaction};
		case 'applyCompleted':
			return {kind: 'updated', version: action.version};
		case 'failed':
			return {kind: 'error', message: action.message};
	}
}

export function isSelfUpdateCancellable(screen: SelfUpdateScreen): screen is {
	readonly kind: 'updating';
	readonly stage: 'downloading';
	readonly plan: SelfUpdatePlan;
} {
	return screen.kind === 'updating' && screen.stage === 'downloading';
}

export function selfUpdateScreenVersion(
	screen: Extract<SelfUpdateScreen, {readonly kind: 'updating'}>
): string {
	return screen.stage === 'applying' ? screen.transaction.plan.version : screen.plan.version;
}
