import {
	reduceDetectionState,
	shouldStartDetection,
	type DetectionState
} from './async-detection.js';

export type DetectionStateSink<Result> = (state: DetectionState<Result>) => void;
export type DetectionClock = () => number;

export type DetectionRunner<Result> = {
	readonly getState: () => DetectionState<Result>;
	readonly run: (task: () => Promise<Result>) => Promise<DetectionState<Result>>;
	readonly reset: () => DetectionState<Result>;
};

export function createDetectionRunner<Result>(
	initialState: DetectionState<Result>,
	onChange: DetectionStateSink<Result>,
	now: DetectionClock = Date.now
): DetectionRunner<Result> {
	let state = initialState;

	const commit = (next: DetectionState<Result>) => {
		state = next;
		onChange(next);
		return next;
	};

	return {
		getState: () => state,
		async run(task) {
			if (!shouldStartDetection(state)) {
				return state;
			}

			commit(reduceDetectionState(state, {type: 'start', now: now()}));

			try {
				const result = await task();
				return commit(reduceDetectionState(state, {type: 'success', now: now(), result}));
			} catch (error) {
				return commit(reduceDetectionState(state, {type: 'error', now: now(), error}));
			}
		},
		reset() {
			return commit(reduceDetectionState(state, {type: 'reset'}));
		}
	};
}
