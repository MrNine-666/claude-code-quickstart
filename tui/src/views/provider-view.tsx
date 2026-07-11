import React, { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
	Modal,
	ErrorPanel,
	ScrollList,
	StatusDot,
	ViewHeader,
	ListEmptyState,
	toast,
	type ScrollListItem
} from '../components/index.js';
import { ProviderForm } from './provider-form.js';
import { truncateToWidth } from '../core/text-utils.js';
import { clampMove } from '../core/list-utils.js';
import {
	buildForm,
	getMigrationResult,
	loadProviderDisplay,
	loadProviderProfile,
	modelSummary,
	removeProvider,
	saveProviderForm,
	switchActiveProvider
} from '../services/provider-service.js';
import {
	buildCodexForm,
	codexModelSummary,
	codexProviderFormAdapter,
	isCodexOfficialLoggedIn,
	loadCodexProviderDisplay,
	loadCodexProviderProfile,
	readCodexProfileToml,
	removeCodexProvider,
	saveCodexProviderForm,
	switchActiveCodexProvider,
	type CodexProviderFormInput
} from '../services/codex-service.js';
import { validateProviderForm } from '../core/provider-form.js';
import { validateCodexProviderForm, type CodexProviderFormModel, type CodexProviderFormValues } from '../core/codex-provider-form.js';
import { isOfficialLoginKey } from '../core/codex.js';
import type { ProviderDisplayData, ProviderDisplayProfile } from '../core/provider.js';
import type { AgentContext } from '../state/manage-state.js';
import { colors } from '../theme/index.js';

// Provider TUI 视图（OpenTUI 适配）：
// - 状态卡片列表：profile / 活跃圆点 / Base URL / 脱敏 API key / 模型摘要
// - 新增（A）与编辑（E）统一走一屏表单，直接编辑、保存按编辑语义触发、Esc 返回列表（无独立详情屏）
// - Enter 切换活跃供应商、D 删除确认且禁止删除 active
//
// Phase 4 实现：列表屏 + 删除确认 Modal
// Phase 5 实现：表单屏（含底部 env JSON 区内嵌编辑）

type ProviderScreen =
	| { readonly kind: 'list' }
	| { readonly kind: 'add' }
	| { readonly kind: 'edit'; readonly key: string }
	| { readonly kind: 'confirm-delete'; readonly key: string };

// 卡片正文单行最大显示宽度（截断，防溢出）。
const CARD_BODY_WIDTH = 64;

export type ProviderViewProps = {
	// 当前 Agent 上下文：cc 读写 Claude provider，cx 读写 Codex profile。
	readonly agentContext: AgentContext;
	// 本视图是否获得右侧内容区焦点（focus === 'view'）。
	readonly active: boolean;
	// content 区可视行数（焦点驱动滚动）。
	readonly viewportHeight?: number;
	readonly viewportWidth?: number;
	// 上报当前子模式给 App footer。
	readonly onSubModeChange?: (subMode: string) => void;
	// 在列表屏按 Esc/← 时请求退回左侧导航。
	readonly onExitToNav: () => void;
	// 在列表顶部按 ↑ 时请求进入 Agent Header。
	readonly onExitToHeader?: () => void;
};

export function ProviderView({
	agentContext,
	active,
	viewportHeight = 16,
	viewportWidth = 52,
	onSubModeChange,
	onExitToNav,
	onExitToHeader
}: ProviderViewProps) {
	const isCodex = agentContext === 'cx';
	const [display, setDisplay] = useState<ProviderDisplayData>(() => isCodex ? loadCodexProviderDisplay() : loadProviderDisplay());
	const migrationFailed = useMemo(() => isCodex ? [] : (getMigrationResult()?.failed ?? []), [isCodex]);
	const [selected, setSelected] = useState(0);
	const [screen, setScreen] = useState<ProviderScreen>({ kind: 'list' });

	const profiles = display.profiles;
	const safeSelected = profiles.length === 0 ? 0 : Math.min(selected, profiles.length - 1);
	const current = profiles[safeSelected] ?? null;
	// Codex official login 虚拟条目：无文件、不可编辑，删除语义为「登出」（清 auth.json）。
	const currentIsOfficial = isCodex && current ? isOfficialLoginKey(current.key) : false;

	useEffect(() => {
		const next = isCodex ? loadCodexProviderDisplay() : loadProviderDisplay();
		setDisplay(next);
		setSelected(0);
		setScreen({kind: 'list'});
	}, [isCodex]);

	// 上报子模式给 App footer：表单屏统一上报 'form'，空列表上报 'empty'，否则用 screen.kind。
	useEffect(() => {
		if (!active) {
			return;
		}

		// 表单屏（add/edit）统一上报 'form'，空列表上报 'empty'，否则用 screen.kind。
		const formScreens = new Set(['add', 'edit']);
		const subMode = formScreens.has(screen.kind)
			? 'form'
			: screen.kind === 'list' && profiles.length === 0
				? 'empty'
				: screen.kind;
		onSubModeChange?.(subMode);
	}, [active, screen.kind, profiles.length, onSubModeChange]);

	const refresh = (): ProviderDisplayData => {
		const next = isCodex ? loadCodexProviderDisplay() : loadProviderDisplay();
		setDisplay(next);
		setSelected((prev) => (next.profiles.length === 0 ? 0 : Math.min(prev, next.profiles.length - 1)));
		return next;
	};

	// 表单屏（add/edit 统一走 ProviderForm）：Claude 使用 JSON，Codex 使用真实 TOML adapter。
	if (screen.kind === 'add') {
		if (isCodex) {
				const model = buildCodexForm({mode: 'add'});
			return (
				<ProviderForm<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel>
					model={model}
					active={active}
					contentHeight={viewportHeight - 2}
					buildForm={buildCodexForm}
					save={saveCodexProviderForm}
					validate={(values) => validateCodexProviderForm(model.mode, values)}
					adapter={codexProviderFormAdapter}
					onCancel={() => setScreen({ kind: 'list' })}
					onSaved={(message) => {
						refresh();
						toast.success(message);
						setScreen({ kind: 'list' });
					}}
				/>
			);
		}

		const model = buildForm({ mode: 'add-builtin' });
		return (
			<ProviderForm
				model={model}
				active={active}
				contentHeight={viewportHeight - 2}
				buildForm={buildForm}
				save={saveProviderForm}
				validate={(values) => validateProviderForm(model.mode, values)}
				onCancel={() => setScreen({ kind: 'list' })}
				onSaved={(message) => {
					refresh();
					toast.success(message);
					setScreen({ kind: 'list' });
				}}
			/>
		);
	}

	if (screen.kind === 'edit' && current) {
		if (isCodex) {
			// official 虚拟条目 profilePath 为空串：用 sentinel key 取其静态 profile，rawToml 对 official 无意义（空串）。
			const profile = loadCodexProviderProfile(currentIsOfficial ? current.key : current.profilePath);
			const rawToml = currentIsOfficial ? '' : readCodexProfileToml(current.profilePath);
				const model = buildCodexForm({ mode: 'edit', profileKey: current.key, profile, rawToml });
			return (
				<ProviderForm<CodexProviderFormInput, CodexProviderFormValues, CodexProviderFormModel>
					model={model}
					active={active}
					contentHeight={viewportHeight - 2}
					buildForm={buildCodexForm}
					save={(input, values) => saveCodexProviderForm({ ...input, profileKey: current.key, profile, rawToml }, values)}
					validate={(values) => validateCodexProviderForm('edit', values)}
					adapter={codexProviderFormAdapter}
					onCancel={() => setScreen({ kind: 'list' })}
					onSaved={(message) => {
						refresh();
						toast.success(message);
						setScreen({ kind: 'list' });
					}}
				/>
			);
		}

		const profile = loadProviderProfile(current.profilePath);
		const model = buildForm({ mode: 'edit', profileKey: current.key, profile });
		return (
			<ProviderForm
				model={model}
				active={active}
				contentHeight={viewportHeight - 2}
				buildForm={buildForm}
				save={(input, values) => saveProviderForm({ ...input, profileKey: current.key, profile }, values)}
				validate={(values) => validateProviderForm('edit', values)}
				onCancel={() => setScreen({ kind: 'list' })}
				onSaved={(message) => {
					refresh();
					toast.success(message);
					setScreen({ kind: 'list' });
				}}
			/>
		);
	}

	// 列表屏（Phase 4 实现）
	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader
				title='供应商管理'
				subtitle='管理 API 供应商、密钥与模型环境变量'
			/>

			{migrationFailed.length > 0 ? (
				<box marginBottom={1}>
					<ErrorPanel
						message={`${migrationFailed.length} 个供应商迁移失败，可恢复（旧文件已保留）：${migrationFailed
							.map((f) => f.key)
							.join('、')}`}
					/>
				</box>
			) : null}

			{profiles.length === 0 ? (
				<ListEmptyState
					message={isCodex ? '暂无 Codex profile' : '暂无供应商配置'}
					hint={{label: isCodex ? '添加第一个供应商（可在表单内选择类型，支持 official login / 自定义）' : '添加第一个供应商（可在表单内选择类型，含自定义）', enabled: true}}
				/>
			) : (
				<ProviderTable
					profiles={profiles}
					selectedIndex={safeSelected}
					viewportHeight={viewportHeight}
					reservedRows={migrationFailed.length > 0 ? 6 : 3}
					active={active}
					summaryForProfile={(profile) => isCodex ? codexModelSummary(loadCodexProviderProfile(profile.profilePath)) : modelSummary(loadProviderProfile(profile.profilePath))}
				/>
			)}

			{screen.kind === 'confirm-delete' && current ? (
				<Modal
					active
					title={currentIsOfficial
						? '确认登出官方账号'
						: current.isActive ? '禁止删除活跃供应商' : '确认删除供应商'}
					hint="Enter 确认  Esc 取消"
					tone="danger"
					viewportWidth={viewportWidth}
					viewportHeight={viewportHeight}
				>
					<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						{currentIsOfficial
							? '将清空 ~/.codex/auth.json 登出 Codex 官方账号，此操作不可撤销。'
							: current.isActive
								? `${current.key} 是当前活跃供应商，删除前请先切换到其他供应商。`
								: `即将删除供应商 ${current.key}，此操作不可撤销。`}
					</text>
				</Modal>
			) : null}

			<ListInput
				active={active && screen.kind === 'list'}
				hasCurrent={current !== null}
				atTop={safeSelected === 0}
				onMove={(delta) => setSelected((prev) => clampMove(prev, delta, profiles.length))}
				onSwitch={() => {
					if (!current) {
						return;
					}

					// official login 未登录前置提示：凭据由 codex login 生成，ccq 不写入 auth.json。
					// 切换动作本身仍会执行（清空 config.toml 供应商键），但未登录时 codex 无凭据可用，
					// 故先 toast 警告并引导用户运行 codex login，避免"切了看起来没反应"的困惑。
					if (isCodex && currentIsOfficial && !isCodexOfficialLoggedIn()) {
						toast.warning('official login 未登录，请先运行 codex login 完成官方账号登录');
					}

					const result = isCodex ? switchActiveCodexProvider(current.key) : switchActiveProvider(current.key);
					if (result.ok) {
						refresh();
						toast.success(`已切换为活跃供应商：${result.data.providerName}`);
					} else {
						toast.error(result.error);
					}
				}}
				onAdd={() => {
					setScreen({ kind: 'add' });
				}}
				onEdit={() => {
					if (!current) {
						return;
					}

					// official login 编辑态 = 直接编辑 ~/.codex/auth.json 明文（含登出）；其余 provider 走 TOML 编辑。
					setScreen({ kind: 'edit', key: current.key });
				}}
				onDelete={() => {
					if (current) {
						setScreen({ kind: 'confirm-delete', key: current.key });
					}
				}}
				onExit={onExitToNav}
				onExitToHeader={onExitToHeader}
			/>

			<DeleteInput
				active={active && screen.kind === 'confirm-delete'}
				onCancel={() => setScreen({ kind: 'list' })}
				onConfirm={() => {
					if (!current) {
						setScreen({ kind: 'list' });
						return;
					}

					if (!currentIsOfficial && current.isActive) {
						toast.error(`无法删除当前活跃供应商 ${current.key}，请先切换到其他供应商。`);
						setScreen({ kind: 'list' });
						return;
					}

					const result = isCodex ? removeCodexProvider(current.key) : removeProvider(current.key);
					refresh();
					if (result.ok) {
						toast.success(currentIsOfficial ? '已登出 Codex 官方账号' : `已删除供应商：${current.key}`);
					} else {
						toast.error(result.error);
					}
					setScreen({ kind: 'list' });
				}}
			/>
		</box>
	);
}

// ── 状态卡片列表 ─────────────────────────────────────────────────────────────

function ProviderTable({
	profiles,
	selectedIndex,
	viewportHeight,
	reservedRows,
	active,
	summaryForProfile
}: {
	readonly profiles: readonly ProviderDisplayProfile[];
	readonly selectedIndex: number;
	readonly viewportHeight: number;
	readonly reservedRows: number;
	readonly active: boolean;
	readonly summaryForProfile: (profile: ProviderDisplayProfile) => string;
}) {
	const items: ScrollListItem[] = profiles.map((profile) => ({
		key: profile.key,
		title: profile.key,
		leading: cardStatusDot(profile),
		body: (
			<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{truncateToWidth(
					`${profile.baseUrl || '未配置 Base URL'} · ${profile.maskedApiKey} · ${summaryForProfile(profile)}`,
					CARD_BODY_WIDTH
				)}
			</text>
		)
	}));

	return <ScrollList items={items} cursor={selectedIndex} viewportHeight={viewportHeight} reservedRows={reservedRows} active={active} stretch />;
}

// 左栏状态圆点：active 用更新页同款绿点（latest 表示当前生效），非活跃用弱化灰点；
// 仅圆点不带文字，活跃语义由绿/灰色彩承载，card 内保持紧凑。
function cardStatusDot(profile: ProviderDisplayProfile): React.ReactNode {
	return profile.isActive ? <StatusDot kind="latest" /> : <text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>●</text>;
}

// ── 列表输入订阅（OpenTUI useKeyboard） ────────────────────────────────────

type ListInputProps = {
	readonly active: boolean;
	readonly hasCurrent: boolean;
	readonly atTop: boolean;
	readonly onMove: (delta: number) => void;
	readonly onSwitch: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
	readonly onExitToHeader?: () => void;
};

function ListInput(props: ListInputProps) {
	useKeyboard((keyEvent) => {
		if (!props.active) return;

		switch (keyEvent.name.toLowerCase()) {
			case 'up':
			case 'arrowup':
				if (props.atTop && props.onExitToHeader) {
					props.onExitToHeader();
				} else {
					props.onMove(-1);
				}
				break;
			case 'down':
			case 'arrowdown':
				props.onMove(1);
				break;
			case 'escape':
			case 'left':
			case 'arrowleft':
				props.onExit();
				break;
			case 'enter':
			case 'return':
				props.onSwitch();
				break;
			case 'a':
				props.onAdd();
				break;
			case 'e':
				props.onEdit();
				break;
			case 'd':
				props.onDelete();
				break;
		}
	});

	return null;
}

// ── 删除确认输入订阅 ─────────────────────────────────────────────────────────

function DeleteInput({
	active,
	onCancel,
	onConfirm
}: {
	readonly active: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	useKeyboard((keyEvent) => {
		if (!active) return;

		if (keyEvent.name.toLowerCase() === 'escape') {
			onCancel();
		} else if (keyEvent.name.toLowerCase() === 'enter' || keyEvent.name.toLowerCase() === 'return') {
			onConfirm();
		}
	});

	return null;
}

// ── 工具 ──────────────────────────────────────────────────────────────────────
