import {importExtensionsSection, parseExtensionsSection} from './config-transfer-extensions.js';
import {transferFail, type SectionMergeReport, type TransferResult} from './config-transfer.js';
import {installPiPackage, type ExtensionCommandDeps} from './extensions.js';
import {inspectPiPackageInstallation, piPackageSource} from './pi-package-source.js';

export type PiPackageImportOutcome = {
	readonly completed: readonly string[];
	readonly unchanged: readonly string[];
	readonly failed: readonly {readonly source: string; readonly kind: 'install' | 'cancelled' | 'postflight'; readonly error: string}[];
	readonly notExecuted: readonly string[];
	/** Install was attempted; registry/storage/scripts MAY remain outside settings/tree rollback. */
	readonly externalSideEffects: boolean;
};
export type ExtensionsImportResult = TransferResult<SectionMergeReport> & {readonly packages?: PiPackageImportOutcome};

/** Sanitized identities only; no child output or absolute paths. */
export function piPackageOutcomeMessage(outcome: PiPackageImportOutcome): string {
	return `Pi packages：已安装 ${outcome.completed.join('、') || '无'}；失败 ${outcome.failed.map(item => item.source).join('、') || '无'}；未执行 ${outcome.notExecuted.join('、') || '无'}${outcome.externalSideEffects ? '；外部安装/缓存/脚本副作用可能保留，不保证撤销' : ''}`;
}

/** Runs only inside Extensions classification transaction, after confirmation. */
export async function importExtensionsWithPackages(data: unknown, deps: ExtensionCommandDeps = {}): Promise<ExtensionsImportResult> {
	const parsed = parseExtensionsSection(data);
	if (!parsed.ok) return parsed;
	const inspect = deps.packageInstalled ?? inspectPiPackageInstallation;
	const completed: string[] = [];
	const unchanged: string[] = [];
	const failed: {source: string; kind: 'install' | 'cancelled' | 'postflight'; error: string}[] = [];
	const notExecuted: string[] = [];
	let externalSideEffects = false;
	const outcome = (): PiPackageImportOutcome => ({completed, unchanged, failed, notExecuted, externalSideEffects});
	const declarations = parsed.data.packages ?? [];
	for (let i = 0; i < declarations.length; i++) {
		const declaration = declarations[i]!;
		const source = piPackageSource(declaration);
		const preview = importExtensionsSection({entries: [], packages: [declaration]}, {dryRun: true, packageInstalled: inspect});
		if (!preview.ok) return {...preview, packages: outcome()};
		if (deps.signal?.aborted) {
			notExecuted.push(...declarations.slice(i).map(piPackageSource));
			return {...transferFail('cancelled', 'Pi package 导入已取消'), packages: outcome()};
		}
		if (preview.data.added.length === 0 && preview.data.replaced.length === 0) {
			unchanged.push(source);
			continue;
		}
		const previouslyInstalled = inspect(source);
		let attempted = false;
		const installed = await installPiPackage(source, deps, () => {
			attempted = true;
			externalSideEffects = true;
		});
		// Cancellation may race with installation: retain verified landing facts even after AbortSignal.
		let landed = false;
		try {
			landed = inspect(source);
		} catch {
			landed = false;
		}
		// Failure can prove new landing, not completion from storage that already matched before install.
		if (landed && attempted && (installed.ok || !previouslyInstalled)) completed.push(source);
		if (!installed.ok || deps.signal?.aborted || !landed) {
			const kind = deps.signal?.aborted ? 'cancelled' : installed.ok || installed.kind === 'postflight' ? 'postflight' : 'install';
			const error = kind === 'cancelled' ? 'Pi package 安装已取消' : 'Pi package 安装/状态复核失败，请检查 CLI、认证或网络后重试';
			failed.push({source, kind, error});
			notExecuted.push(...declarations.slice(i + 1).map(piPackageSource));
			return {...transferFail(kind === 'cancelled' ? 'cancelled' : 'io', error), packages: outcome()};
		}
		const merged = importExtensionsSection({entries: [], packages: [declaration]}, {packageInstalled: inspect});
		if (!merged.ok) {
			failed.push({source, kind: 'postflight', error: merged.error});
			notExecuted.push(...declarations.slice(i + 1).map(piPackageSource));
			return {...merged, packages: outcome()};
		}
	}
	if (deps.signal?.aborted) return {...transferFail('cancelled', 'Pi package 导入已取消'), packages: outcome()};
	return {...importExtensionsSection(parsed.data, {packageInstalled: inspect}), packages: outcome()};
}
