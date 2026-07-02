// CLI 破坏性操作确认：交互式 y/n；非 TTY 必须显式传 --yes 或 -y。

export type ConfirmOptions = {
	readonly prompt: string;
	readonly assumedYes: boolean;
};

export async function confirmDangerousAction({prompt, assumedYes}: ConfirmOptions): Promise<boolean> {
	if (assumedYes) {
		return true;
	}

	if (!process.stdin.isTTY) {
		console.error('当前不是交互式终端，卸载操作必须传 --yes 或 -y。');
		return false;
	}

	console.error(`${prompt} [y/N] `);
	const answer = await readLineFromStdin();
	return answer.trim().toLowerCase() === 'y';
}

function readLineFromStdin(): Promise<string> {
	return new Promise(resolve => {
		let settled = false;
		let buffer = '';
		const stdin = process.stdin;

		const cleanup = (): void => {
			stdin.off('data', onData);
			stdin.off('end', onEnd);
			stdin.pause();
		};

		const finish = (value: string): void => {
			if (settled) {
				return;
			}

			settled = true;
			cleanup();
			resolve(value);
		};

		const onData = (chunk: Buffer | string): void => {
			buffer += String(chunk);
			const newlineIndex = buffer.search(/\r?\n/);
			if (newlineIndex >= 0) {
				finish(buffer.slice(0, newlineIndex));
			}
		};

		const onEnd = (): void => finish(buffer);

		stdin.setEncoding('utf8');
		stdin.on('data', onData);
		stdin.on('end', onEnd);
		stdin.resume();
	});
}
