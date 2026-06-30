import React, { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
	Modal,
	ErrorPanel,
	ScrollList,
	StatusDot,
	ViewHeader,
	ActionHint,
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
import { validateProviderForm } from '../core/provider-form.js';
import type { ProviderDisplayData, ProviderDisplayProfile } from '../core/provider.js';
import { colors } from '../theme/index.js';

// Provider TUI 视图（OpenTUI 适配）：
// - 状态卡片列表：profile / 活跃圆点 / Base URL / 脱敏 API key / 模型摘要
// - 新增（A）与编辑（E）统一走一屏表单，直接编辑、Ctrl/Cmd+S 保存、Esc 返回列表（无独立详情屏）
// - Enter 切换活跃供应商、D 删除确认且禁止删除 active
//
// Phase 4 实现：列表屏 + 删除确认 Modal
// Phase 5 实现：表单屏（包含 extraEnv 内嵌编辑）

type ProviderScreen =
	| { readonly kind: 'list' }
	| { readonly kind: 'add' }
	| { readonly kind: 'edit'; readonly key: string }
	| { readonly kind: 'confirm-delete'; readonly key: string };

// 卡片正文单行最大显示宽度（截断，防溢出）。
const CARD_BODY_WIDTH = 64;

export type ProviderViewProps = {
	// 本视图是否获得右侧内容区焦点（focus === 'view'）。
	readonly active: boolean;
	// content 区可视行数（焦点驱动滚动）。
	readonly viewportHeight?: number;
	readonly viewportWidth?: number;
	// 上报当前子模式给 App footer。
	readonly onSubModeChange?: (subMode: string) => void;
	// 在列表屏按 Esc/← 时请求退回左侧导航。
	readonly onExitToNav: () => void;
};

export function ProviderView({
	active,
	viewportHeight = 16,
	viewportWidth = 52,
	onSubModeChange,
	onExitToNav
}: ProviderViewProps) {
	const [display, setDisplay] = useState<ProviderDisplayData>(() => loadProviderDisplay());
	const migrationFailed = useMemo(() => getMigrationResult()?.failed ?? [], []);
	const [selected, setSelected] = useState(0);
	const [screen, setScreen] = useState<ProviderScreen>({ kind: 'list' });

	const profiles = display.profiles;
	const safeSelected = profiles.length === 0 ? 0 : Math.min(selected, profiles.length - 1);
	const current = profiles[safeSelected] ?? null;

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
		const next = loadProviderDisplay();
		setDisplay(next);
		setSelected((prev) => (next.profiles.length === 0 ? 0 : Math.min(prev, next.profiles.length - 1)));
		return next;
	};

	// 表单屏（add/edit 统一走 ProviderForm）：表单内编辑字段，Ctrl/Cmd+S 保存、Esc 返回列表。
	if (screen.kind === 'add') {
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
			<ViewHeader title="供应商管理" subtitle="管理 API 供应商、密钥与模型环境变量" />

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
				<box flexDirection="column" flexGrow={1} justifyContent="center">
					<box flexDirection="column" marginBottom={1}>
						<text fg={colors.muted}>暂无供应商配置</text>
						<box marginTop={1}>
							<ActionHint label="添加第一个供应商（可在表单内选择类型，含自定义）" enabled />
						</box>
					</box>
				</box>
			) : (
				<ProviderTable
					profiles={profiles}
					selectedIndex={safeSelected}
					viewportHeight={viewportHeight}
					reservedRows={migrationFailed.length > 0 ? 6 : 3}
				/>
			)}

			{screen.kind === 'confirm-delete' && current ? (
				<Modal
					active
					title={current.isActive ? '禁止删除活跃供应商' : '确认删除供应商'}
					hint="Enter 确认  Esc 取消"
					tone="danger"
					viewportWidth={viewportWidth}
					viewportHeight={viewportHeight}
				>
					<text fg={colors.text}>
						{current.isActive
							? `${current.key} 是当前活跃供应商，删除前请先切换到其他供应商。`
							: `即将删除供应商 ${current.key}，此操作不可撤销。`}
					</text>
				</Modal>
			) : null}

			<ListInput
				active={active && screen.kind === 'list'}
				hasCurrent={current !== null}
				onMove={(delta) => setSelected((prev) => clampMove(prev, delta, profiles.length))}
				onSwitch={() => {
					if (!current) {
						return;
					}

					const result = switchActiveProvider(current.key);
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
					if (current) {
						setScreen({ kind: 'edit', key: current.key });
					}
				}}
				onDelete={() => {
					if (current) {
						setScreen({ kind: 'confirm-delete', key: current.key });
					}
				}}
				onExit={onExitToNav}
			/>

			<DeleteInput
				active={active && screen.kind === 'confirm-delete'}
				onCancel={() => setScreen({ kind: 'list' })}
				onConfirm={() => {
					if (!current) {
						setScreen({ kind: 'list' });
						return;
					}

					if (current.isActive) {
						toast.error(`无法删除当前活跃供应商 ${current.key}，请先切换到其他供应商。`);
						setScreen({ kind: 'list' });
						return;
					}

					const result = removeProvider(current.key);
					refresh();
					if (result.ok) {
						toast.success(`已删除供应商：${current.key}`);
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
	reservedRows
}: {
	readonly profiles: readonly ProviderDisplayProfile[];
	readonly selectedIndex: number;
	readonly viewportHeight: number;
	readonly reservedRows: number;
}) {
	const items: ScrollListItem[] = profiles.map((profile) => ({
		key: profile.key,
		title: profile.key,
		leading: cardStatusDot(profile),
		body: (
			<text fg={colors.muted}>
				{truncateToWidth(
					`${profile.baseUrl} · ${profile.maskedApiKey} · ${modelSummary(loadProviderProfile(profile.profilePath))}`,
					CARD_BODY_WIDTH
				)}
			</text>
		)
	}));

	return <ScrollList items={items} cursor={selectedIndex} viewportHeight={viewportHeight} reservedRows={reservedRows} stretch />;
}

// 左栏状态圆点：active 用更新页同款绿点（latest 表示当前生效），非活跃用弱化灰点；
// 仅圆点不带文字，活跃语义由绿/灰色彩承载，card 内保持紧凑。
function cardStatusDot(profile: ProviderDisplayProfile): React.ReactNode {
	return profile.isActive ? <StatusDot kind="latest" /> : <text fg={colors.muted}>●</text>;
}

// ── 列表输入订阅（OpenTUI useKeyboard） ────────────────────────────────────

type ListInputProps = {
	readonly active: boolean;
	readonly hasCurrent: boolean;
	readonly onMove: (delta: number) => void;
	readonly onSwitch: () => void;
	readonly onAdd: () => void;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
	readonly onExit: () => void;
};

function ListInput(props: ListInputProps) {
	useKeyboard((keyEvent) => {
		if (!props.active) return;

		switch (keyEvent.name.toLowerCase()) {
			case 'up':
			case 'arrowup':
				props.onMove(-1);
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
