import {useEffect, useRef, useState} from 'react';
import type {DetectionState} from '../services/async-detection.js';
import type {DetectionRunner, DetectionStateSink} from '../services/detection-runner.js';

// App 层检测缓存（Phase 2）：把 Update / Skills 的检测状态从视图内部提升到 App。
// 视图切走再切回（unmount/remount）时缓存不丢失，不重跑慢命令；仅在首次或
// 用户主动 refresh 时执行检测。视图改为纯消费 state + 调用 refresh。

export type DetectionCache<Result> = {
	readonly state: DetectionState<Result>;
	// 手动刷新：重置后重新检测（对应视图内的 r 键）。
	readonly refresh: () => void;
};

export type DetectionCacheServices<Result> = {
	readonly createDetectionRunner: (onChange: DetectionStateSink<Result>) => DetectionRunner<Result>;
	readonly runDetection: (runner: DetectionRunner<Result>) => Promise<unknown>;
};

export function useDetectionCache<Result>(services: DetectionCacheServices<Result>): DetectionCache<Result> {
	const [state, setState] = useState<DetectionState<Result>>({status: 'idle'});
	const runnerRef = useRef<DetectionRunner<Result> | null>(null);

	// 首次装配：建一个常驻 runner（引用稳定），自动跑首检。services 由 App useMemo 固定引用。
	useEffect(() => {
		const runner = services.createDetectionRunner(setState);
		runnerRef.current = runner;
		void services.runDetection(runner);
	}, [services]);

	const refresh = (): void => {
		const runner = runnerRef.current;
		if (!runner) {
			return;
		}

		runner.reset();
		void services.runDetection(runner);
	};

	return {state, refresh};
}
