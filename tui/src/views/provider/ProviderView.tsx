import {useEffect, useMemo, useState} from 'react';
import {toast} from '../../components/index.js';
import {clampMove} from '../../core/list-utils.js';
import {buildForm, discoverProviderModels, loadProviderProfile, saveProviderForm} from '../../services/provider-service.js';
import {
	buildCodexForm,
	codexProviderFormAdapter,
	discoverCodexProviderModels,
	loadCodexProviderProfile,
	readCodexProfileToml,
	saveCodexProviderForm,
	type CodexProviderFormInput
} from '../../services/codex-service.js';
import {
	buildPiForm,
	discoverPiProviderModels,
	loadPiProviderProfileByRef,
	matchPiProviderModel,
	replacePiProviderModels,
	piProviderFormAdapter,
	savePiProviderForm
} from '../../services/pi-provider-service.js';
import {validatePiProviderForm} from '../../core/pi-provider.js';
import {validateProviderForm} from '../../core/provider-form.js';
import {validateCodexProviderForm, type CodexProviderFormModel, type CodexProviderFormValues} from '../../core/codex-provider-form.js';
import type {ProviderDisplayData} from '../../core/provider.js';
import type {AgentContext} from '../../state/manage-state.js';
import {ProviderFormView} from './ProviderFormView.js';
import {ProviderHomeView} from './ProviderHomeView.js';
import {claudeProviderFormAdapter} from './provider-form-adapter.js';
import {createProviderViewAdapter} from './provider-view-adapter.js';

type ProviderScreen =
	| {readonly kind: 'list'}
	| {readonly kind: 'add'}
	| {readonly kind: 'edit'; readonly key: string}
	| {readonly kind: 'confirm-delete'; readonly key: string};

/**
 * 只读供应商提示：Codex official 与 Pi auth.json 数据源（/login 创建）均由各自 CLI 原生管理，
 * ccq 只能编辑/删除 models.json 中定义的 Provider。
 */
function providerReadOnlyMessage(isCodex: boolean, action: 'edit' | 'delete'): string {
	if (isCodex) {
		return action === 'edit'
			? 'Codex 官方账号由 Codex 原生管理，不可在表单中编辑；请运行 codex login 或 codex logout。'
			: 'Codex 官方账号由 Codex 原生管理，不可在表单中编辑；请运行 codex logout。';
	}
	return action === 'edit'
		? '该供应商由 Pi 原生 /login 管理，ccq 仅能编辑 models.json 中定义的 Provider；请打开 pi 输入 /login 或 /logout。'
		: '该供应商由 Pi 原生 /login 管理，ccq 仅能删除 models.json 中定义的 Provider；请打开 pi 输入 /logout。';
}

export type ProviderViewProps = {
	readonly agentContext: AgentContext;
	readonly active: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly onExitToHeader?: () => void;
};

export function ProviderView({agentContext, active, onSubModeChange, onExitToNav, onExitToHeader}: ProviderViewProps) {
	const adapter = useMemo(() => createProviderViewAdapter(agentContext), [agentContext]);
	const [display, setDisplay] = useState<ProviderDisplayData>(() => adapter.loadDisplay());
	const [selected, setSelected] = useState(0);
	const [screen, setScreen] = useState<ProviderScreen>({kind: 'list'});
	const profiles = display.profiles;
	const safeSelected = profiles.length === 0 ? 0 : Math.min(selected, profiles.length - 1);
	const current = profiles[safeSelected] ?? null;
	const currentIsOfficial = adapter.isOfficial(current);
	const currentIsReadOnly = currentIsOfficial || current?.canEdit === false;
	// Pi 内置 / `/login` Provider 可编辑传输层覆盖（仅 headers / authHeader），与凭据侧 canEdit 正交。
	const currentEditBlocked =
		currentIsOfficial || (adapter.isPi ? current?.canEditTransport !== true : current?.canEdit === false);

	useEffect(() => {
		setDisplay(adapter.loadDisplay());
		setSelected(0);
		setScreen({kind: 'list'});
	}, [adapter]);

	useEffect(() => {
		if (!active) return;
		if (screen.kind === 'add' || screen.kind === 'edit') return;
		const subMode =
			screen.kind === 'list' && profiles.length === 0 ? 'empty' : screen.kind === 'list' && adapter.isPi ? 'list-pi' : screen.kind;
		onSubModeChange?.(subMode);
	}, [active, adapter.isPi, onSubModeChange, profiles.length, screen.kind]);

	useEffect(() => {
		if (!active || screen.kind !== 'edit' || !currentEditBlocked) return;
		toast.info(providerReadOnlyMessage(adapter.isCodex, 'edit'));
		setScreen({kind: 'list'});
	}, [active, adapter.isCodex, currentEditBlocked, screen.kind]);

	function refresh(): void {
		const next = adapter.loadDisplay();
		setDisplay(next);
		setSelected(previous => (next.profiles.length === 0 ? 0 : Math.min(previous, next.profiles.length - 1)));
	}

	function handleSaved(message: string, warning?: string): void {
		refresh();
		if (warning) {
			toast.warning(warning);
		} else {
			toast.success(message);
		}
		setScreen({kind: 'list'});
	}

	if (screen.kind === 'add') {
		if (adapter.isPi) {
			const model = buildPiForm({mode: 'add'});
			return (
				<ProviderFormView
					model={model}
					active={active}
					onSubModeChange={onSubModeChange}
					buildForm={buildPiForm}
					save={savePiProviderForm}
					validate={values => validatePiProviderForm(model.mode, values)}
					adapter={piProviderFormAdapter}
					onDiscover={discoverPiProviderModels}
					onApplyDiscovered={replacePiProviderModels}
					onMatchCandidate={matchPiProviderModel}
					onCancel={() => setScreen({kind: 'list'})}
					onSaved={handleSaved}
				/>
			);
		}

		if (adapter.isCodex) {
			const model = buildCodexForm({mode: 'add'});
			const modelSelectFieldIds = model.fields.filter(field => field.type === 'model-select').map(field => field.id);
			return (
				<ProviderFormView<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel>
					model={model}
					active={active}
					onSubModeChange={onSubModeChange}
					buildForm={buildCodexForm}
					save={saveCodexProviderForm}
					validate={values => validateCodexProviderForm(model.mode, values)}
					adapter={codexProviderFormAdapter}
					onDiscover={discoverCodexProviderModels}
					modelSelectFieldIds={modelSelectFieldIds}
					onCancel={() => setScreen({kind: 'list'})}
					onSaved={handleSaved}
				/>
			);
		}

		const model = buildForm({mode: 'add-builtin'});
		return (
			<ProviderFormView
				model={model}
				active={active}
				onSubModeChange={onSubModeChange}
				buildForm={buildForm}
				save={saveProviderForm}
				validate={values => validateProviderForm(model.mode, values)}
				adapter={claudeProviderFormAdapter}
				onDiscover={discoverProviderModels}
				modelSelectFieldIds={model.fields.filter(field => field.type === 'model-select').map(field => field.id)}
				onCancel={() => setScreen({kind: 'list'})}
				onSaved={handleSaved}
			/>
		);
	}

	if (screen.kind === 'edit' && currentEditBlocked) {
		return null;
	}

	if (screen.kind === 'edit' && current) {
		if (adapter.isPi) {
			const profile = loadPiProviderProfileByRef(current.profilePath);
			const model = buildPiForm({mode: 'edit', profileKey: current.key, profile});
			// transport-only 变体没有自定义端点，不提供模型发现。
			const transportOnly = model.values.variant === 'transport-only';
			return (
				<ProviderFormView
					model={model}
					active={active}
					onSubModeChange={onSubModeChange}
					buildForm={buildPiForm}
					save={(input, values) => savePiProviderForm({...input, profileKey: current.key, profile}, values)}
					validate={values => validatePiProviderForm('edit', values)}
					adapter={piProviderFormAdapter}
					onDiscover={transportOnly ? undefined : discoverPiProviderModels}
					onApplyDiscovered={transportOnly ? undefined : replacePiProviderModels}
					onMatchCandidate={transportOnly ? undefined : matchPiProviderModel}
					onCancel={() => setScreen({kind: 'list'})}
					onSaved={handleSaved}
				/>
			);
		}

		if (adapter.isCodex) {
			const profile = loadCodexProviderProfile(current.profilePath);
			const rawToml = readCodexProfileToml(current.profilePath);
			const model = buildCodexForm({mode: 'edit', profileKey: current.key, profile, rawToml});
			const modelSelectFieldIds = model.fields.filter(field => field.type === 'model-select').map(field => field.id);
			return (
				<ProviderFormView<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel>
					model={model}
					active={active}
					onSubModeChange={onSubModeChange}
					buildForm={buildCodexForm}
					save={(input, values) => saveCodexProviderForm({...input, profileKey: current.key, profile, rawToml}, values)}
					validate={values => validateCodexProviderForm('edit', values)}
					adapter={codexProviderFormAdapter}
					onDiscover={modelSelectFieldIds.length > 0 ? discoverCodexProviderModels : undefined}
					modelSelectFieldIds={modelSelectFieldIds}
					onCancel={() => setScreen({kind: 'list'})}
					onSaved={handleSaved}
				/>
			);
		}

		const profile = loadProviderProfile(current.profilePath);
		const model = buildForm({mode: 'edit', profileKey: current.key, profile});
		return (
			<ProviderFormView
				model={model}
				active={active}
				onSubModeChange={onSubModeChange}
				buildForm={buildForm}
				save={(input, values) => saveProviderForm({...input, profileKey: current.key, profile}, values)}
				validate={values => validateProviderForm('edit', values)}
				adapter={claudeProviderFormAdapter}
				onDiscover={discoverProviderModels}
				modelSelectFieldIds={model.fields.filter(field => field.type === 'model-select').map(field => field.id)}
				onCancel={() => setScreen({kind: 'list'})}
				onSaved={handleSaved}
			/>
		);
	}

	return (
		<ProviderHomeView
			rows={profiles.map(adapter.toHomeRow)}
			selectedIndex={safeSelected}
			active={active}
			isCodex={adapter.isCodex}
			isPi={adapter.isPi}
			migrationFailures={adapter.migrationFailures}
			loadFailures={display.loadFailures ?? []}
			currentKey={current?.key}
			currentIsActive={current?.isActive ?? false}
			switchEnabled={adapter.switchActive !== undefined}
			confirmingDelete={screen.kind === 'confirm-delete'}
			onMove={delta => setSelected(previous => clampMove(previous, delta, profiles.length))}
			onSwitch={() => {
				const switchActive = adapter.switchActive;
				if (!current || !switchActive) return;
				if (currentIsOfficial && !adapter.isOfficialLoggedIn())
					toast.warning('official login 未登录，请先运行 codex login 完成官方账号登录');
				const result = switchActive(current.key);
				if (result.ok) {
					refresh();
					toast.success(`已切换为活跃供应商：${result.data.providerName}`);
				} else toast.error(result.error);
			}}
			onAdd={() => setScreen({kind: 'add'})}
			onEdit={() => {
				if (currentEditBlocked) {
					toast.info(providerReadOnlyMessage(adapter.isCodex, 'edit'));
					return;
				}
				if (current) setScreen({kind: 'edit', key: current.key});
			}}
			onDelete={() => {
				if (adapter.isPi && current?.isActive) {
					toast.info(`无法删除当前默认 Pi Provider ${current.key}；请先在 Pi 配置页修改 defaultProvider。`);
					return;
				}
				if (currentIsReadOnly || (adapter.isPi && current?.canDelete === false)) {
					toast.info(providerReadOnlyMessage(adapter.isCodex, 'delete'));
					return;
				}
				if (current) setScreen({kind: 'confirm-delete', key: current.key});
			}}
			onExit={onExitToNav}
			onExitToHeader={onExitToHeader}
			onCancelDelete={() => setScreen({kind: 'list'})}
			onConfirmDelete={() => {
				if (!current) {
					setScreen({kind: 'list'});
					return;
				}
				if (currentIsReadOnly) {
					toast.info(providerReadOnlyMessage(adapter.isCodex, 'delete'));
					setScreen({kind: 'list'});
					return;
				}
				if (current.isActive) {
					toast.error(
						adapter.isPi
							? `无法删除当前默认 Pi Provider ${current.key}；请先在 Pi 配置页修改 defaultProvider。`
							: `无法删除当前活跃供应商 ${current.key}，请先切换到其他供应商。`
					);
					setScreen({kind: 'list'});
					return;
				}
				const result = adapter.remove(current.key);
				refresh();
				if (result.ok) toast.success(`已删除供应商：${current.key}`);
				else toast.error(result.error);
				setScreen({kind: 'list'});
			}}
		/>
	);
}
