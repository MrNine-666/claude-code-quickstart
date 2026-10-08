import type {DownloadedSelfUpdate} from './self-update.js';

// 统一 TUI 退出生命周期（纯协调器，无 React/无 I/O）：
// - q、更新弹窗退出等任何正常退出都调用同一个 requestExit；
// - 存在已校验的 staged 更新事务时，先 apply 成功后 onExit；失败不退出并释放闩锁，
//   允许用户重试（弹窗 Enter）或放弃（再次退出，此时不再应用）。
// 只有一次 requestExit 生效（防重复按键/并发 settle），应用结束后事务被领取并清空。

export type StagedUpdateExit = {
	/** 记录/清除唯一已校验但尚未应用的更新事务。 */
	setStaged(transaction: DownloadedSelfUpdate | null): void;
	hasStaged(): boolean;
	isExitRequested(): boolean;
	/** 请求退出：有 staged 先应用再退出；应用失败不退出。 */
	requestExit(): void;
};

export type StagedUpdateExitDeps = {
	/** 应用事务；返回是否成功（对应 applyUpdate 的 applied/scheduled 事实）。 */
	readonly apply: (transaction: DownloadedSelfUpdate) => Promise<boolean>;
	readonly onExit: () => void;
};

export function createStagedUpdateExit(deps: StagedUpdateExitDeps): StagedUpdateExit {
	let staged: DownloadedSelfUpdate | null = null;
	let requested = false;

	const applyAndExit = async (transaction: DownloadedSelfUpdate): Promise<void> => {
		const applied = await deps.apply(transaction);
		if (applied) {
			staged = null;
			deps.onExit();
			return;
		}

		// 应用失败：不退出、不谎报成功；清空 staged 让后续退出成为「放弃更新」。
		staged = null;
		requested = false;
	};

	return {
		setStaged(transaction) {
			staged = transaction;
		},
		hasStaged: () => staged !== null,
		isExitRequested: () => requested,
		requestExit() {
			if (requested) {
				return;
			}

			requested = true;
			const transaction = staged;
			if (!transaction) {
				deps.onExit();
				return;
			}

			void applyAndExit(transaction);
		}
	};
}
