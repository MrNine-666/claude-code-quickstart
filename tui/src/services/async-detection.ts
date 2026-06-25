export type DetectionStatus = 'idle' | 'loading' | 'success' | 'error';

export type DetectionState<Result> = {
	readonly status: DetectionStatus;
	readonly result?: Result;
	readonly error?: string;
	readonly startedAt?: number;
	readonly finishedAt?: number;
};

export type DetectionAction<Result> =
	| {readonly type: 'start'; readonly now: number}
	| {readonly type: 'success'; readonly now: number; readonly result: Result}
	| {readonly type: 'error'; readonly now: number; readonly error: unknown}
	| {readonly type: 'reset'};

export function createInitialDetectionState<Result>(): DetectionState<Result> {
	return {status: 'idle'};
}

export function reduceDetectionState<Result>(
	state: DetectionState<Result>,
	action: DetectionAction<Result>
): DetectionState<Result> {
	if (action.type === 'reset') {
		return createInitialDetectionState<Result>();
	}

	if (action.type === 'start') {
		if (state.status === 'loading') {
			return state;
		}

		return {status: 'loading', startedAt: action.now};
	}

	if (action.type === 'success') {
		return {
			status: 'success',
			result: action.result,
			startedAt: state.startedAt,
			finishedAt: action.now
		};
	}

	return {
		status: 'error',
		error: normalizeError(action.error),
		startedAt: state.startedAt,
		finishedAt: action.now
	};
}

export function shouldStartDetection<Result>(state: DetectionState<Result>): boolean {
	return state.status !== 'loading';
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === 'string') {
		return error;
	}

	return '未知错误';
}
