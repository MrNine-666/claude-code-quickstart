export type TuiRenderer = {
	readonly destroy: () => void;
};

export type TuiExitController = {
	readonly requestExit: (renderer: TuiRenderer, code?: number) => void;
	readonly handleRendererDestroyed: () => void;
};

export function createTuiExitController(exitProcess: (code: number) => void = code => process.exit(code)): TuiExitController {
	let requestedExitCode: number | null = null;
	let exitStarted = false;

	return {
		requestExit(renderer, code = 0) {
			if (requestedExitCode !== null || exitStarted) {
				return;
			}

			requestedExitCode = code;
			renderer.destroy();
		},
		handleRendererDestroyed() {
			if (requestedExitCode === null || exitStarted) {
				return;
			}

			exitStarted = true;
			exitProcess(requestedExitCode);
		}
	};
}
