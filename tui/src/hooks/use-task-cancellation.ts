import {useCallback, useEffect, useMemo, useRef} from 'react';

export type TaskCancellation = {
	readonly start: () => AbortSignal | null;
	readonly cancel: () => boolean;
	readonly finish: (signal: AbortSignal) => void;
};

export function useTaskCancellation(): TaskCancellation {
	const controllerRef = useRef<AbortController | null>(null);

	const start = useCallback((): AbortSignal | null => {
		if (controllerRef.current && !controllerRef.current.signal.aborted) {
			return null;
		}

		const controller = new AbortController();
		controllerRef.current = controller;
		return controller.signal;
	}, []);

	const cancel = useCallback((): boolean => {
		const controller = controllerRef.current;
		if (!controller) {
			return false;
		}

		controllerRef.current = null;
		controller.abort();
		return true;
	}, []);

	const finish = useCallback((signal: AbortSignal): void => {
		if (controllerRef.current?.signal === signal) {
			controllerRef.current = null;
		}
	}, []);

	useEffect(
		() => () => {
			controllerRef.current?.abort();
			controllerRef.current = null;
		},
		[]
	);

	return useMemo(() => ({start, cancel, finish}), [start, cancel, finish]);
}
