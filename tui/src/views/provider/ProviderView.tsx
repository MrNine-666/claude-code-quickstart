import React, {useEffect, useMemo, useState} from 'react';
import {toast} from '../../components/index.js';
import {clampMove} from '../../core/list-utils.js';
import {buildForm, loadProviderProfile, saveProviderForm} from '../../services/provider-service.js';
import {
	buildCodexForm,
	codexProviderFormAdapter,
	loadCodexProviderProfile,
	readCodexProfileToml,
	saveCodexProviderForm,
	type CodexProviderFormInput
} from '../../services/codex-service.js';
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

	useEffect(() => {
		setDisplay(adapter.loadDisplay());
		setSelected(0);
		setScreen({kind: 'list'});
	}, [adapter]);

	useEffect(() => {
		if (!active) return;
		const subMode =
			screen.kind === 'add' || screen.kind === 'edit'
				? 'form'
				: screen.kind === 'list' && profiles.length === 0
					? 'empty'
					: screen.kind;
		onSubModeChange?.(subMode);
	}, [active, onSubModeChange, profiles.length, screen.kind]);

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
		if (adapter.isCodex) {
			const model = buildCodexForm({mode: 'add'});
			return (
				<ProviderFormView<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel>
					model={model}
					active={active}
					buildForm={buildCodexForm}
					save={saveCodexProviderForm}
					validate={values => validateCodexProviderForm(model.mode, values)}
					adapter={codexProviderFormAdapter}
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
				buildForm={buildForm}
				save={saveProviderForm}
				validate={values => validateProviderForm(model.mode, values)}
				adapter={claudeProviderFormAdapter}
				onCancel={() => setScreen({kind: 'list'})}
				onSaved={handleSaved}
			/>
		);
	}

	if (screen.kind === 'edit' && current) {
		if (adapter.isCodex) {
			const profile = loadCodexProviderProfile(currentIsOfficial ? current.key : current.profilePath);
			const rawToml = currentIsOfficial ? '' : readCodexProfileToml(current.profilePath);
			const model = buildCodexForm({mode: 'edit', profileKey: current.key, profile, rawToml});
			return (
				<ProviderFormView<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel>
					model={model}
					active={active}
					buildForm={buildCodexForm}
					save={(input, values) => saveCodexProviderForm({...input, profileKey: current.key, profile, rawToml}, values)}
					validate={values => validateCodexProviderForm('edit', values)}
					adapter={codexProviderFormAdapter}
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
				buildForm={buildForm}
				save={(input, values) => saveProviderForm({...input, profileKey: current.key, profile}, values)}
				validate={values => validateProviderForm('edit', values)}
				adapter={claudeProviderFormAdapter}
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
			migrationFailures={adapter.migrationFailures}
			loadFailures={display.loadFailures ?? []}
			currentKey={current?.key}
			currentIsActive={current?.isActive ?? false}
			currentIsOfficial={currentIsOfficial}
			confirmingDelete={screen.kind === 'confirm-delete'}
			onMove={delta => setSelected(previous => clampMove(previous, delta, profiles.length))}
			onSwitch={() => {
				if (!current) return;
				if (currentIsOfficial && !adapter.isOfficialLoggedIn())
					toast.warning('official login 未登录，请先运行 codex login 完成官方账号登录');
				const result = adapter.switchActive(current.key);
				if (result.ok) {
					refresh();
					toast.success(`已切换为活跃供应商：${result.data.providerName}`);
				} else toast.error(result.error);
			}}
			onAdd={() => setScreen({kind: 'add'})}
			onEdit={() => {
				if (current) setScreen({kind: 'edit', key: current.key});
			}}
			onDelete={() => {
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
				if (!currentIsOfficial && current.isActive) {
					toast.error(`无法删除当前活跃供应商 ${current.key}，请先切换到其他供应商。`);
					setScreen({kind: 'list'});
					return;
				}
				const result = adapter.remove(current.key);
				refresh();
				if (result.ok) toast.success(currentIsOfficial ? '已登出 Codex 官方账号' : `已删除供应商：${current.key}`);
				else toast.error(result.error);
				setScreen({kind: 'list'});
			}}
		/>
	);
}
